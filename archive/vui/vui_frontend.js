"""Archived Vui frontend client code (was in static/js/modules/voice.js).

Original file sections:
  - "─── Vui full-duplex mode (WebRTC streaming) ───"
  - voiceSettings.vui references throughout (toggles, mute, auto-listen,
    startListening/startVuiRecording, loadVoiceSettings Vui bits,
    updateVuiVoicePicker/switchVuiVoice).
"""

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

    // Connect WebSocket to Vui through Flask proxy.
    // Pass the session token as a query parameter — browsers cannot set
    // auth headers on WebSocket connections and SameSite cookies are not
    // sent cross-origin (tunnel URLs).
    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sess = sessionStorage.getItem('decloud_session') || '';
    vuiWS = new WebSocket(`${wsProto}://${location.host}/api/voice/vui/ws?cid=${encodeURIComponent(vuiClientId)}` +
      (sess ? `&token=${encodeURIComponent(sess)}` : ''));

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
