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
  llm: 'llama3.2',
  tts: 'piper-lessac-medium',
};

// Load settings from localStorage
try {
  const saved = JSON.parse(localStorage.getItem('voiceSettings') || '{}');
  voiceSettings = { ...voiceSettings, ...saved };
} catch (e) {}

// The server config (Settings → Voice) is the source of truth across
// devices. Merge it over localStorage so engine swaps persist everywhere.
async function syncVoiceSettingsFromServer() {
  try {
    const r = await fetch('/api/voice/config');
    const d = await r.json();
    const cfg = d.config || {};
    if (cfg.stt) voiceSettings.stt = cfg.stt;
    if (cfg.tts) voiceSettings.tts = cfg.tts;
    if (cfg.llm_local_model) voiceSettings.llm = cfg.llm_local_model;
    delete voiceSettings.hermes; // legacy flag — no longer used
    localStorage.setItem('voiceSettings', JSON.stringify(voiceSettings));
  } catch (e) { /* server unreachable — keep localStorage */ }
}

function toggleVoice() {
  if (voiceOpen) {
    closeVoice();
  } else {
    openVoice();
  }
}

// ─── Microphone permission ───

function micPermissionGranted() {
  return sessionStorage.getItem('decloud_mic_granted') === '1';
}

function showPermissionButton() {
  const btn = document.getElementById('voice-perm-btn');
  if (btn) btn.style.display = 'flex';
  document.getElementById('voice-status').textContent = 'Microphone access needed';
  setVoiceState('idle');
}

function hidePermissionButton() {
  const btn = document.getElementById('voice-perm-btn');
  if (btn) btn.style.display = 'none';
}

async function requestMicPermission() {
  unlockAudio();
  const status = document.getElementById('voice-status');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    sessionStorage.setItem('decloud_mic_granted', '1');
    hidePermissionButton();
    startAutoListen();
  } catch (e) {
    status.textContent = 'Microphone blocked — enable it in your browser settings';
  }
}

function openVoice() {
  unlockAudio();
  voiceOpen = true;
  document.getElementById('voice-overlay').classList.add('active');
  document.getElementById('voice-orb').style.display = 'none';
  setVoiceMode('voice');
  loadVoiceSettings().then(() => {
    if (micPermissionGranted()) {
      startAutoListen();
    } else {
      showPermissionButton();
    }
  });
}

function closeVoice() {
  if (autoListenActive) stopAutoListen();
  voiceOpen = false;
  document.getElementById('voice-overlay').classList.remove('active');
  // Restore orb only if we're on the home screen
  const homeActive = document.getElementById('home-screen')?.classList.contains('active');
  document.getElementById('voice-orb').style.display = homeActive ? '' : 'none';
  stopListening();
  setVoiceState('idle');
  hidePermissionButton();
  document.getElementById('voice-transcript').textContent = '';
  document.getElementById('voice-response').textContent = '';
  document.getElementById('voice-response').classList.remove('fade-out');
  document.getElementById('voice-confirm').style.display = 'none';
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
    idle: 'Tap mic to speak',
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
    if (autoListenActive) stopAutoListen();
    setVoiceState('idle');
  }
}

// ─── Mute toggle ───

function toggleMute() {
  micMuted = !micMuted;
  updateMuteButton();

  if (voiceMode !== 'voice') return;

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
  toggle.innerHTML = isOpen ? 'What can I say? &#9662;' : 'What can I say? &#9656;';
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

  try {
    const resp = await fetch('/api/voice/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    const data = await resp.json();

    if (data.error) {
      aiBubble.innerHTML = `<span style="color:#f87171">Error: ${data.error}</span>`;
      return;
    }

    const message = data.reply || '';
    aiBubble.innerHTML = escapeHtml(message).replace(/\n/g, '<br>');
    voiceConversation.push({ role: 'assistant', content: message });
    voiceChatHistory.push({ role: 'assistant', content: message });
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

async function loadVoiceSettings() {
  // Engine config lives in Settings → Voice; just sync it here.
  await syncVoiceSettingsFromServer();
}

// ─── Recording ───

async function startListening() {
  if (voiceState === 'listening') {
    stopListening();
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
    document.getElementById('voice-status').textContent = 'Browser speech not supported — switch STT to Whisper in Settings → Voice.';
    return;
  }

  const recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  window.browserSTT = { recognition };
  let gotFinal = false;

  recognition.onstart = () => {
    setVoiceState('listening');
    document.getElementById('voice-status').textContent = 'Listening…';
  };

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
      gotFinal = true;
      document.getElementById('voice-transcript').textContent = final;
      processVoiceCommand(final);
    }
  };

  recognition.onerror = (e) => {
    if (e.error === 'no-speech') {
      setVoiceState('idle');
      document.getElementById('voice-status').textContent = "Didn't hear anything — try again";
    } else if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      setVoiceState('idle');
      showPermissionButton();
    } else {
      setVoiceState('idle');
      document.getElementById('voice-status').textContent = 'Speech error: ' + e.error;
    }
  };

  recognition.onend = () => {
    // If recognition ended without producing a final result, don't hang.
    if (!gotFinal && voiceState === 'listening') {
      setVoiceState('idle');
      document.getElementById('voice-status').textContent = "Didn't catch that — tap the mic to try again";
    }
  };

  try {
    recognition.start();
  } catch (e) {
    setVoiceState('idle');
    document.getElementById('voice-status').textContent = 'Could not start speech: ' + (e.message || e);
  }
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
      showVoiceError(data.error, data.hint);
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
    const resp = await fetch('/api/voice/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    const data = await resp.json();

    if (data.error) {
      showVoiceError(data.error, data.hint);
      return;
    }

    const reply = data.reply || '';
    await speakAndShowReply(reply);
  } catch (e) {
    showVoiceError(e.message || 'Network error', 'Check the logs or try again');
  }
}

async function speakAndShowReply(reply) {
  const responseEl = document.getElementById('voice-response');
  const text = reply || 'I heard you, but had trouble forming a reply.';
  responseEl.textContent = text;
  responseEl.classList.remove('fade-out');
  clearVoiceError();
  voiceConversation.push({ role: 'assistant', content: text });
  await speak(text);
  setVoiceState('idle');
  if (responseEl.textContent.trim()) {
    setTimeout(() => { responseEl.classList.add('fade-out'); }, 3000);
  }
}

// ─── Action execution ───

async function executeVoiceAction(action) {
  const responseEl = document.getElementById('voice-response');
  const confirmEl = document.getElementById('voice-confirm');
  const confirmTextEl = document.getElementById('voice-confirm-text');
  clearVoiceError();

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

    case 'reset_conversation':
      voiceConversation = [];
      voiceChatHistory = [];
      responseEl.textContent = "Okay, I've forgotten everything. What can I do for you?";
      await speak("Okay, I've forgotten everything. What can I do for you?");
      setVoiceState('idle');
      break;

    case 'respond':
    default:
      const replyText = action.message || '';
      responseEl.textContent = replyText || 'I heard you, but had trouble forming a reply.';
      responseEl.classList.remove('fade-out');
      voiceConversation.push({ role: 'assistant', content: replyText });
      await speak(replyText);
      setVoiceState('idle');
      // Fade out response after 3 seconds
      if (responseEl.textContent.trim()) {
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

// ─── Error surface ───

function showVoiceError(message, hint) {
  const responseEl = document.getElementById('voice-response');
  const statusEl = document.getElementById('voice-status');
  if (statusEl) statusEl.textContent = '⚠ ' + (hint || 'Something went wrong');
  if (responseEl) {
    responseEl.textContent = message || 'Something went wrong';
    responseEl.classList.remove('fade-out');
    responseEl.classList.add('error');
  }
  setVoiceState('idle');
}

function clearVoiceError() {
  const responseEl = document.getElementById('voice-response');
  if (responseEl) responseEl.classList.remove('error');
}

// ─── TTS ───

let _audioUnlocked = false;

function unlockAudio() {
  // Unlock mobile audio on the first user gesture so TTS playback isn't
  // blocked by the browser's autoplay policy.
  if (_audioUnlocked) return;
  _audioUnlocked = true;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.001);
    if (ctx.resume) ctx.resume();
  } catch (e) {}
  try {
    const a = document.getElementById('voice-tts-player');
    if (a) {
      // iOS only unlocks .play() when the element has a real source, so
      // feed it a silent WAV clip during the gesture, then clear it.
      a.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhIQAAAAA=';
      a.volume = 0;
      a.play().catch(() => {});
      setTimeout(() => { a.volume = 1; try { a.removeAttribute('src'); } catch (e) {} }, 120);
    }
  } catch (e) {}
  // Warm up speechSynthesis (needed for the first browser-TTS call on iOS).
  try {
    const u = new SpeechSynthesisUtterance('');
    u.volume = 0;
    speechSynthesis.speak(u);
  } catch (e) {}
}

function browserSpeak(text) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; setVoiceState('idle'); resolve(); };
    try {
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.1;
      utter.pitch = 1.0;
      utter.onend = finish;
      utter.onerror = finish;
      speechSynthesis.speak(utter);
      // Safety net — never hang on "speaking".
      setTimeout(finish, Math.max(3000, text.length * 200));
    } catch (e) { finish(); }
  });
}

async function speak(text) {
  if (!text) return;
  setVoiceState('speaking');

  if (voiceSettings.tts === 'browser') {
    return browserSpeak(text);
  }

  // Piper TTS via a persistent, gesture-unlocked audio element. Falls back
  // to the browser's voice if Piper is unavailable or playback fails.
  try {
    const resp = await fetch('/api/voice/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, engine: voiceSettings.tts }),
    });

    if (resp.ok) {
      const blob = await resp.blob();
      const audioUrl = URL.createObjectURL(blob);
      const audio = document.getElementById('voice-tts-player') || new Audio();
      audio.muted = false;
      audio.volume = 1.0;
      let played = false;
      await new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => { if (settled) return; settled = true; played = ok; URL.revokeObjectURL(audioUrl); resolve(); };
        audio.onended = () => finish(true);
        audio.onerror = () => finish(false);
        audio.src = audioUrl;
        try {
          const p = audio.play();
          if (p && p.then) p.catch(() => finish(false));
        } catch (e) { finish(false); }
        // Safety net — bail if the browser never signals playback end.
        setTimeout(() => finish(false), Math.max(6000, text.length * 250));
      });
      if (played) return;
    } else {
      // Surface the reason, then fall back to the browser voice.
      let detail = '';
      try {
        const j = await resp.json();
        detail = j.error || '';
        const statusEl = document.getElementById('voice-status');
        if (statusEl && j.hint) statusEl.textContent = '⚠ ' + j.hint;
      } catch (e) {}
      console.warn('Piper TTS unavailable:', detail || resp.status);
    }
  } catch (e) {
    console.error('Piper TTS error, falling back to browser:', e);
  }

  return browserSpeak(text);
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

// ─── Push-to-talk: removed — mute toggle controls mic ───

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
      await transcribeAudio(audioBlob);
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

