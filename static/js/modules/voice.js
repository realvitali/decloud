// ===== Module: voice =====
let voiceState = 'idle'; // idle, listening, thinking, speaking
let voiceOpen = false;
let voiceRecorder = null;
let voiceAudioChunks = [];
let voiceStream = null;
let voiceConversation = [];
let pendingCommand = null;
let voiceSettings = {
  stt: 'whisper-base',
  llm: 'qwen2.5:14b-instruct-q4_K_M',
  tts: 'piper-lessac-high',
  vui: false,
  hermes: false,
  vuiVoice: 'abraham',
};

// Load settings from localStorage
try {
  const saved = JSON.parse(localStorage.getItem('voiceSettings') || '{}');
  voiceSettings = { ...voiceSettings, ...saved };
} catch (e) {}

function saveVoiceSettings() {
  voiceSettings.stt = document.getElementById('voice-stt-select').value;
  voiceSettings.llm = document.getElementById('voice-llm-select').value;
  voiceSettings.tts = document.getElementById('voice-tts-select').value;
  voiceSettings.vui = document.getElementById('voice-vui-toggle').checked;
  voiceSettings.hermes = document.getElementById('voice-hermes-toggle').checked;
  // Hermes and Vui are mutually exclusive
  if (voiceSettings.hermes && voiceSettings.vui) {
    voiceSettings.vui = false;
    document.getElementById('voice-vui-toggle').checked = false;
  }
  localStorage.setItem('voiceSettings', JSON.stringify(voiceSettings));
  updateVuiVoicePicker();
}

function toggleVoice() {
  if (voiceOpen) {
    closeVoice();
  } else {
    openVoice();
  }
}

function openVoice() {
  voiceOpen = true;
  document.getElementById('voice-overlay').classList.add('active');
  document.getElementById('voice-orb').style.display = 'none';
  setVoiceMode('voice');
  loadVoiceSettings().then(() => {
    // Auto-start based on mode
    if (voiceSettings.hermes) {
      // Hermes mode auto-starts listening
      setTimeout(() => startHermesRecording(), 500);
    } else if (voiceSettings.vui && !vuiConnected) {
      startVuiStreaming();
    }
  });
}

function closeVoice() {
  if (autoListenActive) stopAutoListen();
  if (vuiConnected) stopVuiStreaming();
  voiceOpen = false;
  document.getElementById('voice-overlay').classList.remove('active');
  // Restore orb only if we're on the home screen
  const homeActive = document.getElementById('home-screen')?.classList.contains('active');
  document.getElementById('voice-orb').style.display = homeActive ? '' : 'none';
  stopListening();
  setVoiceState('idle');
  document.getElementById('voice-transcript').textContent = '';
  document.getElementById('voice-response').textContent = '';
  document.getElementById('voice-response').classList.remove('fade-out');
  document.getElementById('voice-confirm').style.display = 'none';
  document.getElementById('voice-settings').style.display = 'none';
  // Reset mute state
  micMuted = false;
  updateMuteButton();
}

function setVoiceState(state) {
  voiceState = state;
  const anim = document.getElementById('voice-anim');
  anim.className = 'voice-anim voice-anim-' + state;

  const statusEl = document.getElementById('voice-status');
  const statusMap = {
    idle: voiceSettings.hermes ? 'Tap to talk' : (voiceSettings.vui ? 'Tap to start' : 'Tap mic to speak'),
    listening: 'Listening...',
    thinking: 'Processing...',
    speaking: 'Speaking...',
  };
  statusEl.textContent = statusMap[state] || state;
}

// ─── Voice/Text mode toggle ───

let voiceMode = 'voice'; // 'voice' or 'text'
let micMuted = false;

function setVoiceMode(mode) {
  voiceMode = mode;
  const voiceBtn = document.getElementById('voice-mode-voice');
  const textBtn = document.getElementById('voice-mode-text');
  const voiceView = document.getElementById('voice-view');
  const textView = document.getElementById('text-view');

  if (mode === 'voice') {
    voiceBtn.classList.add('active');
    textBtn.classList.remove('active');
    voiceView.style.display = '';
    textView.style.display = 'none';
  } else {
    voiceBtn.classList.remove('active');
    textBtn.classList.add('active');
    voiceView.style.display = 'none';
    textView.style.display = '';
    // Stop voice listening when switching to text
    if (vuiConnected) stopVuiStreaming();
    if (autoListenActive) stopAutoListen();
    setVoiceState('idle');
  }
}

// ─── Mute toggle ───

function toggleMute() {
  micMuted = !micMuted;
  updateMuteButton();

  if (voiceMode !== 'voice') return;

  if (voiceSettings.hermes) {
    // Hermes mode: mute stops recording, unmute starts listening
    if (micMuted) {
      stopListening();
      setVoiceState('idle');
      document.getElementById('voice-status').textContent = 'Muted';
    } else {
      startHermesRecording();
    }
  } else if (voiceSettings.vui) {
    // In Vui mode, mute = stop sending audio (disconnect stream), unmute = restart
    if (micMuted) {
      if (vuiConnected) stopVuiStreaming();
      setVoiceState('idle');
      document.getElementById('voice-status').textContent = 'Muted';
    } else {
      if (!vuiConnected) startVuiStreaming();
    }
  } else {
    // Non-Vui mode: mute stops any active recording
    if (micMuted) {
      if (autoListenActive) stopAutoListen();
      stopListening();
      setVoiceState('idle');
      document.getElementById('voice-status').textContent = 'Muted';
    } else {
      // Start auto-listen for hands-free mode
      startAutoListen();
    }
  }
}

function updateMuteButton() {
  const btn = document.getElementById('voice-mute-btn');
  if (!btn) return;
  const icon = document.getElementById('voice-mute-icon');
  const label = document.getElementById('voice-mute-label');
  if (micMuted) {
    // Muted — mic with slash
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/></svg>';
    label.textContent = 'Unmute';
    btn.classList.add('muted');
  } else {
    // Unmuted — mic icon
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
    label.textContent = 'Mute';
    btn.classList.remove('muted');
  }
}

// ─── Capabilities toggle ───

function toggleCapabilities() {
  const list = document.getElementById('voice-caps-list');
  const toggle = document.querySelector('.voice-caps-toggle');
  if (!list || !toggle) return;
  const isOpen = list.classList.toggle('open');
  toggle.classList.toggle('open', isOpen);
  toggle.innerHTML = isOpen ? 'What can Vui do? &#9662;' : 'What can Vui do? &#9656;';
}

// ─── Text chat (in voice overlay) ───

let voiceChatHistory = [];

async function sendVoiceTextMessage() {
  const input = document.getElementById('voice-chat-input');
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  const msgs = document.getElementById('voice-chat-messages');

  // Add user bubble
  const userBubble = document.createElement('div');
  userBubble.className = 'voice-chat-msg user';
  userBubble.textContent = text;
  msgs.appendChild(userBubble);

  // Add assistant bubble (will stream into this)
  const aiBubble = document.createElement('div');
  aiBubble.className = 'voice-chat-msg assistant';
  aiBubble.innerHTML = '<span class="voice-chat-typing">Thinking...</span>';
  msgs.appendChild(aiBubble);
  msgs.scrollTop = msgs.scrollHeight;

  // Save to voice conversation
  voiceChatHistory.push({ role: 'user', content: text });
  voiceConversation.push({ role: 'user', content: text });

  const apiMessages = [...voiceConversation];

  let fullResponse = '';

  try {
    const resp = await fetch('/api/voice/intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model: voiceSettings.llm,
        conversation: apiMessages,
      }),
    });

    const data = await resp.json();

    if (data.error) {
      aiBubble.innerHTML = `<span style="color:#f87171">Error: ${data.error}</span>`;
      return;
    }

    const action = data.action;
    if (action.action === 'respond' || action.action === 'chat') {
      const message = action.message || '';
      fullResponse = message;
      aiBubble.innerHTML = escapeHtml(message).replace(/\n/g, '<br>');
      voiceConversation.push({ role: 'assistant', content: message });
      voiceChatHistory.push({ role: 'assistant', content: message });
    } else {
      // Handle other actions (navigate, play, etc.)
      aiBubble.innerHTML = `Action: ${escapeHtml(action.action)}`;
      await executeVoiceAction(action);
    }
  } catch (e) {
    aiBubble.innerHTML = `<span style="color:#f87171">Error: ${e.message}</span>`;
  }

  msgs.scrollTop = msgs.scrollHeight;
}

// ─── Chat history modal ───

function showChatHistory() {
  const modal = document.getElementById('chat-history-modal');
  const list = document.getElementById('chat-history-list');

  if (!voiceConversation.length) {
    list.innerHTML = '<div class="chat-history-empty">No conversation yet</div>';
  } else {
    list.innerHTML = voiceConversation.map(msg => {
      const cls = msg.role === 'user' ? 'user' : 'assistant';
      const label = msg.role === 'user' ? 'You' : 'AI';
      return `<div class="chat-history-item ${cls}"><div class="chat-history-role">${label}</div><div class="chat-history-text">${escapeHtml(msg.content).replace(/\n/g, '<br>')}</div></div>`;
    }).join('');
  }

  modal.style.display = 'flex';
  // Scroll to bottom
  setTimeout(() => { list.scrollTop = list.scrollHeight; }, 50);
}

function hideChatHistory(event) {
  if (event && event.target !== document.getElementById('chat-history-modal')) return;
  document.getElementById('chat-history-modal').style.display = 'none';
}

function toggleVoiceSettings() {
  const s = document.getElementById('voice-settings');
  s.style.display = s.style.display === 'none' ? 'flex' : 'none';
}

async function loadVoiceSettings() {
  // Populate dropdowns
  try {
    const [enginesResp, modelsResp] = await Promise.all([
      fetch('/api/voice/engines'),
      fetch('/api/ollama/models'),
    ]);
    const engines = await enginesResp.json();
    const models = await modelsResp.json();

    // STT select
    const sttSel = document.getElementById('voice-stt-select');
    sttSel.innerHTML = engines.stt.map(e =>
      `<option value="${e.id}" ${e.id === voiceSettings.stt ? 'selected' : ''}>${e.name}</option>`
    ).join('');

    // LLM select
    const llmSel = document.getElementById('voice-llm-select');
    llmSel.innerHTML = models.models.map(m =>
      `<option value="${m.name}" ${m.name === voiceSettings.llm ? 'selected' : ''}>${m.name} (${m.size_human})</option>`
    ).join('');

    // TTS select
    const ttsSel = document.getElementById('voice-tts-select');
    ttsSel.innerHTML = engines.tts.map(e =>
      `<option value="${e.id}" ${e.id === voiceSettings.tts ? 'selected' : ''}>${e.name}</option>`
    ).join('');

    // Vui toggle
    document.getElementById('voice-vui-toggle').checked = voiceSettings.vui || false;
    // Hermes toggle
    const hermesToggle = document.getElementById('voice-hermes-toggle');
    if (hermesToggle) hermesToggle.checked = voiceSettings.hermes || false;
    updateVuiVoicePicker();

    // Load Vui voices dynamically
    try {
      const voicesResp = await fetch('/api/voice/vui/voices');
      const voicesData = await voicesResp.json();
      if (voicesData.prompts) {
        const voiceSel = document.getElementById('voice-vui-voice');
        voiceSel.innerHTML = voicesData.prompts.map(v =>
          `<option value="${v.name}" ${v.name === voiceSettings.vuiVoice ? 'selected' : ''}>${v.name.charAt(0).toUpperCase() + v.name.slice(1)}</option>`
        ).join('');
      }
    } catch (e) {
      console.log('[Vui] Could not fetch voices:', e);
    }
  } catch (e) {
    console.error('Voice settings load error:', e);
  }
}

function updateVuiVoicePicker() {
  const enabled = document.getElementById('voice-vui-toggle').checked;
  const picker = document.getElementById('vui-voice-picker');
  if (picker) picker.style.display = enabled ? '' : 'none';
}

async function switchVuiVoice() {
  const voiceName = document.getElementById('voice-vui-voice').value;
  voiceSettings.vuiVoice = voiceName;
  localStorage.setItem('voiceSettings', JSON.stringify(voiceSettings));
  console.log('[Vui] Switching voice to:', voiceName);
  try {
    const resp = await fetch('/api/voice/vui/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice: voiceName }),
    });
    const data = await resp.json();
    console.log('[Vui] Voice switch result:', data);
  } catch (e) {
    console.error('[Vui] Voice switch failed:', e);
  }
}

// ─── Recording ───

async function startListening() {
  if (voiceState === 'listening') {
    stopListening();
    return;
  }

  // Check if using browser STT (skip if Vui mode)
  if (voiceSettings.vui) {
    startVuiRecording();
    return;
  }

  // Hermes mode: record audio, send to /api/voice/hermes (STT+LLM+TTS in one call)
  if (voiceSettings.hermes) {
    startHermesRecording();
    return;
  }

  if (voiceSettings.stt === 'browser') {
    startBrowserSTT();
    return;
  }

  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceAudioChunks = [];

    // Use MediaRecorder for local whisper
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    voiceRecorder = new MediaRecorder(voiceStream, { mimeType: mime });

    voiceRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) voiceAudioChunks.push(e.data);
    };

    voiceRecorder.onstop = async () => {
      const audioBlob = new Blob(voiceAudioChunks, { type: mime });
      await transcribeAudio(audioBlob);
    };

    voiceRecorder.start();
    setVoiceState('listening');
    document.getElementById('voice-transcript').textContent = '';
    document.getElementById('voice-response').textContent = '';
    document.getElementById('voice-response').classList.remove('fade-out');
    document.getElementById('voice-confirm').style.display = 'none';
  } catch (e) {
    document.getElementById('voice-status').textContent = 'Mic access denied';
    console.error('Mic error:', e);
  }
}

function stopListening() {
  if (voiceRecorder && voiceRecorder.state === 'recording') {
    voiceRecorder.stop();
  }
  if (voiceStream) {
    voiceStream.getTracks().forEach(t => t.stop());
    voiceStream = null;
  }

  if (window.browserSTT && window.browserSTT.recognition) {
    window.browserSTT.recognition.stop();
  }
}

// ─── Browser Web Speech API (fallback, no install) ───

function startBrowserSTT() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    document.getElementById('voice-status').textContent = 'Browser STT not supported. Use Whisper.';
    return;
  }

  const recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  window.browserSTT = { recognition };

  recognition.onresult = (event) => {
    let interim = '';
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        final += transcript;
      } else {
        interim += transcript;
      }
    }
    if (interim) document.getElementById('voice-transcript').textContent = interim;
    if (final) {
      document.getElementById('voice-transcript').textContent = final;
      processVoiceCommand(final);
    }
  };

  recognition.onerror = (e) => {
    setVoiceState('idle');
    document.getElementById('voice-status').textContent = 'Error: ' + e.error;
  };

  recognition.onend = () => {
    if (voiceState === 'listening') setVoiceState('thinking');
  };

  recognition.start();
  setVoiceState('listening');
}

// ─── Hermes voice mode (STT + LLM + TTS round-trip) ───

async function startHermesRecording() {
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceAudioChunks = [];

    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    voiceRecorder = new MediaRecorder(voiceStream, { mimeType: mime });

    voiceRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) voiceAudioChunks.push(e.data);
    };

    voiceRecorder.onstop = async () => {
      const audioBlob = new Blob(voiceAudioChunks, { type: mime });
      await sendToHermesVoice(audioBlob);
    };

    voiceRecorder.start();
    setVoiceState('listening');
    document.getElementById('voice-transcript').textContent = '';
    document.getElementById('voice-response').textContent = '';
    document.getElementById('voice-response').classList.remove('fade-out');
    document.getElementById('voice-confirm').style.display = 'none';
  } catch (e) {
    document.getElementById('voice-status').textContent = 'Mic access denied';
    console.error('Hermes mic error:', e);
  }
}

async function sendToHermesVoice(audioBlob) {
  setVoiceState('thinking');
  document.getElementById('voice-status').textContent = 'Processing...';

  const formData = new FormData();
  formData.append('audio', audioBlob, 'recording.webm');
  formData.append('stt_model', voiceSettings.stt);
  formData.append('model', voiceSettings.llm);
  formData.append('tts_engine', voiceSettings.tts);
  formData.append('conversation', JSON.stringify(voiceConversation));

  try {
    const resp = await fetch('/api/voice/hermes', { method: 'POST', body: formData });
    const data = await resp.json();

    if (data.error) {
      setVoiceState('idle');
      document.getElementById('voice-status').textContent = 'Error: ' + data.error;
      return;
    }

    const transcript = data.transcript || '';
    const reply = data.reply || '';
    const audioUrl = data.audio || '';

    // Show transcript
    document.getElementById('voice-transcript').textContent = transcript;

    // Show reply text
    document.getElementById('voice-response').textContent = reply;
    document.getElementById('voice-response').classList.add('fade-in');

    // Save to conversation history
    voiceConversation.push({ role: 'user', content: transcript });
    voiceConversation.push({ role: 'assistant', content: reply });

    // Play TTS audio
    if (audioUrl) {
      setVoiceState('speaking');
      const audio = new Audio(audioUrl);
      audio.onended = () => {
        setVoiceState('idle');
        // Auto-listen for hands-free back-and-forth
        if (!micMuted && voiceOpen && voiceSettings.hermes) {
          setTimeout(() => startHermesRecording(), 500);
        }
      };
      audio.onerror = () => setVoiceState('idle');
      audio.play();
    } else {
      setVoiceState('idle');
    }
  } catch (e) {
    setVoiceState('idle');
    document.getElementById('voice-status').textContent = 'Error: ' + e.message;
  }
}

// ─── Vui full-duplex mode (WebRTC streaming) ───

let vuiPC = null;
let vuiWS = null;
let vuiMicStream = null;
let vuiRemoteAudio = null;
let vuiConnected = false;
let vuiClientId = null;

async function startVuiStreaming() {
  if (vuiConnected) return;

  try {
    // Unlock audio context for mobile
    try {
      const unlockCtx = new (window.AudioContext || window.webkitAudioContext)();
      const unlockOsc = unlockCtx.createOscillator();
      const unlockGain = unlockCtx.createGain();
      unlockGain.gain.value = 0.0001;
      unlockOsc.connect(unlockGain);
      unlockGain.connect(unlockCtx.destination);
      unlockOsc.start();
      unlockOsc.stop(unlockCtx.currentTime + 0.001);
      unlockCtx.resume();
    } catch (e) {}

    // Get mic
    vuiMicStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000 }
    });

    // Create client ID
    vuiClientId = sessionStorage.getItem('vui_cid');
    if (!vuiClientId) {
      vuiClientId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
      sessionStorage.setItem('vui_cid', vuiClientId);
    }

    // Connect WebSocket to Vui through Flask proxy
    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    vuiWS = new WebSocket(`${wsProto}://${location.host}/api/voice/vui/ws?cid=${encodeURIComponent(vuiClientId)}`);

    vuiWS.onopen = async () => {
      console.log('[Vui] WS connected, setting up WebRTC...');
      setVoiceState('listening');
      document.getElementById('voice-status').textContent = micMuted ? 'Muted' : 'Listening... just talk';
      document.getElementById('voice-transcript').textContent = '';
      document.getElementById('voice-response').textContent = '';
      document.getElementById('voice-response').classList.remove('fade-out');

      // Setup WebRTC
      await connectVuiWebRTC();
      // Send VAD mode on
      vuiWS.send(JSON.stringify({ type: 'vad_mode', enabled: true }));
    };

    vuiWS.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        console.log('[Vui WS]', data.type, data.text?.slice(0, 60) || '');

        if (data.type === 'partial' || data.type === 'partial_asr') {
          // Show live transcript as you speak
          document.getElementById('voice-transcript').textContent = data.text;
        } else if (data.type === 'transcription') {
          document.getElementById('voice-transcript').textContent = data.text;
          // Clear any previous response, remove fade
          const respEl = document.getElementById('voice-response');
          respEl.textContent = '';
          respEl.classList.remove('fade-out');
          setVoiceState('thinking');
          document.getElementById('voice-status').textContent = 'Thinking...';
        } else if (data.type === 'reply') {
          const respEl = document.getElementById('voice-response');
          respEl.classList.remove('fade-out');
          // Show only current response — replace, not stack
          const current = respEl.textContent;
          const sep = data.text && '.,!?;:)]}'.indexOf(data.text[0]) === -1 ? ' ' : '';
          respEl.textContent = current + sep + data.text;
          setVoiceState('speaking');
          document.getElementById('voice-status').textContent = 'Speaking...';
        } else if (data.type === 'vad_start') {
          setVoiceState('listening');
          document.getElementById('voice-status').textContent = 'Listening...';
          // Clear transcript on new voice activity
          document.getElementById('voice-transcript').textContent = '';
        } else if (data.type === 'vad_stop') {
          setVoiceState('thinking');
          document.getElementById('voice-status').textContent = 'Processing...';
        } else if (data.type === 'turn_done') {
          // Save conversation to history
          const userText = document.getElementById('voice-transcript').textContent;
          const aiText = document.getElementById('voice-response').textContent;
          if (userText) voiceConversation.push({ role: 'user', content: userText });
          if (aiText) voiceConversation.push({ role: 'assistant', content: aiText });
          // Clear transcript for next turn
          document.getElementById('voice-transcript').textContent = '';
          // Fade out response after 3 seconds
          const respEl = document.getElementById('voice-response');
          if (respEl.textContent.trim()) {
            setTimeout(() => {
              respEl.classList.add('fade-out');
            }, 3000);
          }
          setVoiceState('listening');
          document.getElementById('voice-status').textContent = micMuted ? 'Muted' : 'Listening... just talk';
        } else if (data.type === 'status') {
          document.getElementById('voice-status').textContent = data.text;
        } else if (data.type === 'workers_ready') {
          console.log('[Vui] workers ready');
          setVoiceState('listening');
          document.getElementById('voice-status').textContent = 'Listening... just talk';
        } else if (data.type === 'busy') {
          setVoiceState('idle');
          document.getElementById('voice-status').textContent = 'Vui busy: ' + (data.reason || 'session taken');
        } else if (data.type === 'error') {
          setVoiceState('idle');
          document.getElementById('voice-status').textContent = 'Vui: ' + data.text;
        }
      } catch (err) {
        console.error('[Vui WS] parse error', err);
      }
    };

    vuiWS.onerror = () => {
      console.error('[Vui] WS error');
      document.getElementById('voice-status').textContent = 'Vui connection error';
    };

    vuiWS.onclose = () => {
      console.log('[Vui] WS closed');
      vuiConnected = false;
      if (voiceState === 'listening' || voiceState === 'thinking') setVoiceState('idle');
    };

  } catch (e) {
    document.getElementById('voice-status').textContent = 'Mic access denied';
    console.error('[Vui] mic error:', e);
  }
}

async function connectVuiWebRTC() {
  if (vuiPC) { vuiPC.close(); vuiPC = null; }

  vuiPC = new RTCPeerConnection({ iceServers: [] });
  vuiMicStream.getAudioTracks().forEach(t => vuiPC.addTrack(t, vuiMicStream));

  if (!vuiRemoteAudio) {
    vuiRemoteAudio = document.createElement('audio');
    vuiRemoteAudio.autoplay = true;
    vuiRemoteAudio.volume = 1.0;
    document.body.appendChild(vuiRemoteAudio);
  }

  vuiPC.ontrack = (e) => {
    console.log('[Vui] got remote audio track');
    vuiRemoteAudio.srcObject = e.streams[0];
    setTimeout(() => {
      vuiRemoteAudio.play().catch(err => console.warn('[Vui] autoplay blocked:', err));
    }, 200);
    console.log('[Vui] remote audio attached, pre-buffering 200ms');
  };

  const offer = await vuiPC.createOffer();

  // Munge SDP to force high-quality Opus: max bitrate, no DTX, stereo
  // Use \r?\n to match both \r\n and \n line endings
  offer.sdp = offer.sdp.replace(
    /a=fmtp:(\d+) opus\/48000\/2\r?\n/,
    (match, pt) => match.replace(/\r?\n$/, ';maxaveragebitrate=510000;usedtx=0;stereo=1;cbr=1\r\n')
  );
  console.log('[Vui] SDP munged for high-quality Opus');

  await vuiPC.setLocalDescription(offer);

  const resp = await fetch('/api/voice/vui/offer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sdp: vuiPC.localDescription.sdp, type: vuiPC.localDescription.type }),
  });
  const answer = await resp.json();
  if (answer.error) {
    console.error('[Vui] offer error:', answer.error);
    document.getElementById('voice-status').textContent = 'Vui: ' + answer.error;
    return;
  }

  // Also munge the answer SDP to force high-quality Opus on the return path
  if (answer.sdp) {
    answer.sdp = answer.sdp.replace(
      /a=fmtp:(\d+) opus\/48000\/2\r?\n/,
      (match, pt) => match.replace(/\r?\n$/, ';maxaveragebitrate=510000;usedtx=0;stereo=1;cbr=1\r\n')
    );
  }

  await vuiPC.setRemoteDescription(new RTCSessionDescription(answer));
  vuiConnected = true;
  console.log('[Vui] WebRTC connected (high-quality Opus)');
}

function stopVuiStreaming() {
  if (vuiWS) { try { vuiWS.close(); } catch(e){} vuiWS = null; }
  if (vuiPC) { try { vuiPC.close(); } catch(e){} vuiPC = null; }
  if (vuiMicStream) { vuiMicStream.getTracks().forEach(t => t.stop()); vuiMicStream = null; }
  if (vuiRemoteAudio) { try { vuiRemoteAudio.pause(); vuiRemoteAudio.srcObject = null; } catch(e){} }
  vuiConnected = false;
  setVoiceState('idle');
}

async function startVuiRecording() {
  // For WebRTC streaming mode, just start the stream (no recording needed)
  await startVuiStreaming();
}

// ─── Transcription (local Whisper) ───

async function transcribeAudio(audioBlob) {
  setVoiceState('thinking');
  document.getElementById('voice-status').textContent = 'Transcribing...';

  const formData = new FormData();
  formData.append('audio', audioBlob, 'recording.webm');
  formData.append('model', voiceSettings.stt);

  try {
    const resp = await fetch('/api/voice/stt', { method: 'POST', body: formData });
    const data = await resp.json();

    if (data.error) {
      setVoiceState('idle');
      document.getElementById('voice-status').textContent = 'Error: ' + data.error;
      return;
    }

    const text = data.text || '';
    document.getElementById('voice-transcript').textContent = text;

    if (text.trim()) {
      await processVoiceCommand(text);
    } else {
      setVoiceState('idle');
      document.getElementById('voice-status').textContent = 'Didn\'t catch that, try again';
    }
  } catch (e) {
    setVoiceState('idle');
    document.getElementById('voice-status').textContent = 'Error: ' + e.message;
  }
}

// ─── Intent parsing (LLM) ───

async function processVoiceCommand(text) {
  setVoiceState('thinking');

  voiceConversation.push({ role: 'user', content: text });

  try {
    const resp = await fetch('/api/voice/intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model: voiceSettings.llm,
        conversation: voiceConversation,
      }),
    });

    const data = await resp.json();

    if (data.error) {
      setVoiceState('idle');
      document.getElementById('voice-status').textContent = 'Error: ' + data.error;
      return;
    }

    const action = data.action;
    await executeVoiceAction(action);
  } catch (e) {
    setVoiceState('idle');
    document.getElementById('voice-status').textContent = 'Error: ' + e.message;
  }
}

// ─── Action execution ───

async function executeVoiceAction(action) {
  const responseEl = document.getElementById('voice-response');
  const confirmEl = document.getElementById('voice-confirm');
  const confirmTextEl = document.getElementById('voice-confirm-text');

  switch (action.action) {
    case 'navigate':
      responseEl.textContent = `Opening ${action.screen}...`;
      await speak(`Opening ${action.screen}`);
      navigateToScreen(action.screen);
      setTimeout(closeVoice, 1000);
      break;

    case 'play_book':
      responseEl.textContent = `Playing "${action.title}"...`;
      await speak(`Playing ${action.title}`);
      navigateToScreen('audiobooks');
      // Try to find and play the book
      setTimeout(() => playBookByName(action.title, action.chapter), 500);
      setTimeout(closeVoice, 2000);
      break;

    case 'stop_playback':
      responseEl.textContent = 'Stopping playback';
      stopAudioPlayback();
      await speak('Playback stopped');
      setTimeout(closeVoice, 1000);
      break;

    case 'pause_playback':
      responseEl.textContent = 'Pausing';
      pauseAudioPlayback();
      await speak('Paused');
      setTimeout(closeVoice, 1000);
      break;

    case 'resume_playback':
      responseEl.textContent = 'Resuming';
      resumeAudioPlayback();
      await speak('Resuming');
      setTimeout(closeVoice, 1000);
      break;

    case 'run_command':
      pendingCommand = action;
      confirmEl.style.display = 'flex';
      confirmTextEl.innerHTML = `Run: <strong>${action.command}</strong><br>${action.description || ''}`;
      setVoiceState('idle');
      await speak(`I want to run: ${action.command}. ${action.description || ''}. Shall I proceed?`);
      break;

    case 'search_files':
      responseEl.textContent = `Searching for "${action.query}"...`;
      await speak(`Searching for ${action.query}`);
      navigateToScreen('lego');
      setTimeout(() => searchLegoFiles(action.query), 500);
      setTimeout(closeVoice, 2000);
      break;

    case 'generate_image':
      responseEl.textContent = `Generating image: ${action.prompt}`;
      await speak(`Generating image: ${action.prompt}`);
      navigateToScreen('generate');
      setTimeout(() => generateImageFromVoice(action.prompt), 500);
      setTimeout(closeVoice, 2000);
      break;

    case 'chat':
      responseEl.textContent = `Asking AI: ${action.message}`;
      navigateToScreen('chat');
      setTimeout(() => sendChatFromVoice(action.message), 500);
      // Don't close - let user see the response
      break;

    case 'respond':
    default:
      responseEl.textContent = action.message || '';
      responseEl.classList.remove('fade-out');
      voiceConversation.push({ role: 'assistant', content: action.message || '' });
      await speak(action.message || '');
      setVoiceState('idle');
      // Fade out response after 3 seconds (non-Vui mode)
      if (!voiceSettings.vui && responseEl.textContent.trim()) {
        setTimeout(() => {
          responseEl.classList.add('fade-out');
        }, 3000);
      }
      break;
  }
}

// ─── Command confirmation ───

async function confirmVoiceCommand(approved) {
  if (!pendingCommand) return;

  document.getElementById('voice-confirm').style.display = 'none';

  if (!approved) {
    document.getElementById('voice-response').textContent = 'Command cancelled';
    await speak('Cancelled');
    pendingCommand = null;
    setVoiceState('idle');
    return;
  }

  setVoiceState('thinking');
  document.getElementById('voice-status').textContent = 'Running command...';
  document.getElementById('voice-response').textContent = 'Running: ' + pendingCommand.command;

  try {
    const resp = await fetch('/api/voice/run_command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: pendingCommand.command }),
    });
    const data = await resp.json();

    if (data.error) {
      document.getElementById('voice-response').textContent = 'Error: ' + data.error;
      await speak('Command failed: ' + data.error);
    } else {
      const output = data.output || '(no output)';
      document.getElementById('voice-response').textContent = output;
      await speak('Done. ' + output.substring(0, 200));
    }
  } catch (e) {
    document.getElementById('voice-response').textContent = 'Error: ' + e.message;
    await speak('Command failed');
  }

  pendingCommand = null;
  setVoiceState('idle');
}

// ─── TTS ───

async function speak(text) {
  if (!text) return;
  setVoiceState('speaking');

  // Browser TTS
  if (voiceSettings.tts === 'browser') {
    return new Promise((resolve) => {
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.1;
      utter.pitch = 1.0;
      utter.onend = () => { setVoiceState('idle'); resolve(); };
      utter.onerror = () => { setVoiceState('idle'); resolve(); };
      speechSynthesis.speak(utter);
    });
  }

  // Piper TTS
  try {
    const resp = await fetch('/api/voice/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, engine: voiceSettings.tts }),
    });

    if (resp.ok) {
      const blob = await resp.blob();
      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);
      // Return a promise that resolves when audio ENDS, not when it starts
      await new Promise((resolve, reject) => {
        audio.onended = () => {
          setVoiceState('idle');
          URL.revokeObjectURL(audioUrl);
          resolve();
        };
        audio.onerror = () => {
          setVoiceState('idle');
          URL.revokeObjectURL(audioUrl);
          resolve();
        };
        audio.play().catch(e => {
          console.error('Audio play failed:', e);
          setVoiceState('idle');
          URL.revokeObjectURL(audioUrl);
          resolve();
        });
      });
    } else {
      setVoiceState('idle');
    }
  } catch (e) {
    console.error('TTS error:', e);
    setVoiceState('idle');
  }
}

// ─── Helper functions for actions ───

function navigateToScreen(screen) {
  const screenMap = {
    home: 'home-screen',
    audiobooks: 'book-screen',
    lego: 'lego-screen',
    chat: 'ollama-screen',
    generate: 'comfy-screen',
    system: 'system-screen',
    agents: 'agents-screen',
  };
  const target = screenMap[screen] || 'home-screen';

  if (screen === 'home') {
    goHome();
  } else {
    showScreen(target);
    if (screen === 'audiobooks') loadBooks();
  }
}

function playBookByName(title, chapter) {
  // Find matching book in the book list
  const books = document.querySelectorAll('.book-item');
  const titleLower = (title || '').toLowerCase();

  for (const book of books) {
    const bookTitle = book.querySelector('.book-title')?.textContent?.toLowerCase() || '';
    if (bookTitle.includes(titleLower) || titleLower.includes(bookTitle)) {
      book.click();
      if (chapter !== null && chapter !== undefined) {
        setTimeout(() => {
          // Select chapter
          const chapters = document.querySelectorAll('.chapter-item');
          if (chapters[chapter]) chapters[chapter].click();
        }, 500);
      }
      return;
    }
  }

  // If no match, just show the book list
  loadBooks();
}

function stopAudioPlayback() {
  const audio = document.getElementById('audio-player');
  if (audio) { audio.pause(); audio.currentTime = 0; }
}

function pauseAudioPlayback() {
  const audio = document.getElementById('audio-player');
  if (audio) audio.pause();
}

function resumeAudioPlayback() {
  const audio = document.getElementById('audio-player');
  if (audio) audio.play();
}

function searchLegoFiles(query) {
  // Navigate to lego and trigger search if available
  showScreen('lego-screen');
  if (typeof loadLego === 'function') loadLego('');
}

function generateImageFromVoice(prompt) {
  showScreen('comfy-screen');
  const promptEl = document.getElementById('comfy-prompt');
  if (promptEl) {
    promptEl.value = prompt;
    if (typeof generateImage === 'function') generateImage();
  }
}

function sendChatFromVoice(message) {
  showScreen('ollama-screen');
  const chatInput = document.getElementById('ollama-input');
  if (chatInput) {
    chatInput.value = message;
    if (typeof sendOllamaMessage === 'function') sendOllamaMessage();
  }
}

// ─── Push-to-talk: removed — voice is always-on in Vui mode, mute toggle controls mic ───

// ─── Auto-Listen Mode (continuous conversation with silence detection) ───

let autoListenActive = false;
let autoListenStream = null;
let autoAudioContext = null;
let autoAnalyser = null;
let autoMediaRecorder = null;
let autoAudioChunks = [];
let autoSilenceTimer = null;
let autoSilenceStart = null;
let autoIsRecording = false;
let autoLevelCheckInterval = null;
let autoRecordingStartTime = null;

// Tunable params
const AUTO_SILENCE_THRESHOLD = 0.015;  // Below this = silence
const AUTO_SILENCE_DURATION = 1500;    // 1.5s of silence = done talking
const AUTO_MIN_RECORDING_TIME = 500;   // Min 500ms before we consider stopping
const AUTO_POLL_INTERVAL = 100;        // Check audio level every 100ms
const AUTO_RESTART_DELAY = 800;        // Wait before restarting listen after response

async function toggleAutoListen() {
  if (autoListenActive) {
    stopAutoListen();
  } else {
    await startAutoListen();
  }
}

async function startAutoListen() {
  // In Vui mode, auto-listen is just starting the stream (Vui handles VAD)
  if (voiceSettings.vui) {
    await startVuiStreaming();
    autoListenActive = true;
    return;
  }

  if (voiceSettings.stt === 'browser') {
    // For browser STT, use continuous recognition
    startAutoBrowserSTT();
    return;
  }

  try {
    autoListenStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    autoAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = autoAudioContext.createMediaStreamSource(autoListenStream);
    autoAnalyser = autoAudioContext.createAnalyser();
    autoAnalyser.fftSize = 512;
    autoAnalyser.smoothingTimeConstant = 0.8;
    source.connect(autoAnalyser);

    autoListenActive = true;

    setVoiceState('listening');
    document.getElementById('voice-status').textContent = 'Listening... just talk';

    // Start monitoring audio levels
    const dataArray = new Uint8Array(autoAnalyser.frequencyBinCount);

    autoLevelCheckInterval = setInterval(() => {
      // Don't monitor while thinking or speaking - prevents picking up TTS audio
      if (voiceState === 'thinking' || voiceState === 'speaking') {
        if (autoIsRecording) stopAutoRecording();
        return;
      }

      autoAnalyser.getByteTimeDomainData(dataArray);

      // Calculate RMS volume
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const v = (dataArray[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / dataArray.length);

      // If volume above threshold, we're talking
      if (rms > AUTO_SILENCE_THRESHOLD) {
        if (!autoIsRecording) {
          startAutoRecording();
        }
        autoSilenceStart = null; // Reset silence timer
      } else if (autoIsRecording && autoSilenceStart === null) {
        // Started being silent
        autoSilenceStart = Date.now();
      } else if (autoIsRecording && autoSilenceStart !== null) {
        // Check if silence has been long enough
        const silenceDuration = Date.now() - autoSilenceStart;
        const totalRecording = Date.now() - autoRecordingStartTime;

        if (silenceDuration > AUTO_SILENCE_DURATION && totalRecording > AUTO_MIN_RECORDING_TIME) {
          // User stopped talking
          stopAutoRecording();
        }
      }
    }, AUTO_POLL_INTERVAL);
  } catch (e) {
    document.getElementById('voice-status').textContent = 'Mic access denied';
    console.error('Auto-listen error:', e);
  }
}

function startAutoRecording() {
  if (autoIsRecording) return;
  autoIsRecording = true;
  autoAudioChunks = [];
  autoSilenceStart = null;
  autoRecordingStartTime = Date.now();

  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  autoMediaRecorder = new MediaRecorder(autoListenStream, { mimeType: mime });

  autoMediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) autoAudioChunks.push(e.data);
  };

  autoMediaRecorder.onstop = async () => {
    const audioBlob = new Blob(autoAudioChunks, { type: mime });
    if (audioBlob.size > 1000) { // Only process if we got actual audio
      if (voiceSettings.vui) {
        await processVuiVoiceNote(audioBlob);
      } else {
        await transcribeAudio(audioBlob);
      }
    }
  };

  autoMediaRecorder.start();
  setVoiceState('listening');
  document.getElementById('voice-status').textContent = 'Listening...';
}

function stopAutoRecording() {
  if (!autoIsRecording) return;
  autoIsRecording = false;
  autoSilenceStart = null;

  if (autoMediaRecorder && autoMediaRecorder.state === 'recording') {
    autoMediaRecorder.stop();
  }
}

function stopAutoListen() {
  autoListenActive = false;

  if (voiceSettings.vui) {
    stopVuiStreaming();
    return;
  }

  if (autoLevelCheckInterval) {
    clearInterval(autoLevelCheckInterval);
    autoLevelCheckInterval = null;
  }

  stopAutoRecording();

  if (autoListenStream) {
    autoListenStream.getTracks().forEach(t => t.stop());
    autoListenStream = null;
  }
  if (autoAudioContext) {
    autoAudioContext.close();
    autoAudioContext = null;
  }
  autoAnalyser = null;

  setVoiceState('idle');
}

// Auto-restart after TTS finishes in auto mode
const originalSpeak = speak;
speak = async function(text) {
  // Pause mic monitoring while speaking to prevent hearing TTS
  if (autoListenActive && autoLevelCheckInterval) {
    clearInterval(autoLevelCheckInterval);
    autoLevelCheckInterval = null;
    if (autoIsRecording) stopAutoRecording();
  }

  await originalSpeak(text);

  // Resume listening after TTS finishes
  if (autoListenActive) {
    setTimeout(() => {
      if (autoListenActive && voiceState === 'idle') {
        setVoiceState('listening');
        document.getElementById('voice-status').textContent = 'Listening...';
        // Restart level monitoring
        if (autoAnalyser && !autoLevelCheckInterval) {
          const dataArray = new Uint8Array(autoAnalyser.frequencyBinCount);
          autoLevelCheckInterval = setInterval(() => {
            if (voiceState === 'thinking' || voiceState === 'speaking') {
              if (autoIsRecording) stopAutoRecording();
              return;
            }
            autoAnalyser.getByteTimeDomainData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
              const v = (dataArray[i] - 128) / 128;
              sum += v * v;
            }
            const rms = Math.sqrt(sum / dataArray.length);
            if (rms > AUTO_SILENCE_THRESHOLD) {
              if (!autoIsRecording) startAutoRecording();
              autoSilenceStart = null;
            } else if (autoIsRecording && autoSilenceStart === null) {
              autoSilenceStart = Date.now();
            } else if (autoIsRecording && autoSilenceStart !== null) {
              const silenceDuration = Date.now() - autoSilenceStart;
              const totalRecording = Date.now() - autoRecordingStartTime;
              if (silenceDuration > AUTO_SILENCE_DURATION && totalRecording > AUTO_MIN_RECORDING_TIME) {
                stopAutoRecording();
              }
            }
          }, AUTO_POLL_INTERVAL);
        }
      }
    }, AUTO_RESTART_DELAY);
  }
};

// Auto mode for browser STT (continuous recognition)
function startAutoBrowserSTT() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    document.getElementById('voice-status').textContent = 'Browser STT not supported';
    return;
  }

  const recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  autoListenActive = true;
  setVoiceState('listening');

  let finalText = '';

  recognition.onresult = (event) => {
    let interim = '';
    finalText = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalText += transcript;
      } else {
        interim += transcript;
      }
    }
    if (interim) document.getElementById('voice-transcript').textContent = interim;
    if (finalText.trim()) {
      document.getElementById('voice-transcript').textContent = finalText;
      recognition.stop(); // Stop while processing
      processVoiceCommand(finalText);
    }
  };

  recognition.onerror = (e) => {
    console.error('Browser STT error:', e.error);
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    document.getElementById('voice-status').textContent = 'Error: ' + e.error;
  };

  recognition.onend = () => {
    // Auto-restart if still in auto mode and not processing
    if (autoListenActive && voiceState !== 'thinking' && voiceState !== 'speaking') {
      try { recognition.start(); } catch (e) {}
    }
  };

  recognition.start();
  window._autoBrowserRecognition = recognition;
}

// Override stopAutoListen to also handle browser STT
const originalStopAutoListen = stopAutoListen;
stopAutoListen = function() {
  if (window._autoBrowserRecognition) {
    window._autoBrowserRecognition.stop();
    window._autoBrowserRecognition = null;
  }
  originalStopAutoListen();
};

// ─── Journal Tab Switching ──────────────────────────────

