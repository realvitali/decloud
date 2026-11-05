// ===== Module: ollama =====
let ollamaCurrentModel = 'qwen2.5:14b-instruct';
let ollamaChatHistory = [];
let ollamaStreaming = false;
let ollamaAbort = null;
let ollamaChatId = null;
let ollamaChatTitle = '';
let ollamaModels = [];
let ollamaGenerationId = null;

let ollamaDevice = 'auto';      // device chosen in "Run on" ('auto' = DeCloud picks)
let ollamaLastDevice = '';     // where the last reply actually ran
let ollamaDevices = [];        // connected devices from /api/ollama/models

async function loadOllamaModels() {
  const sel = document.getElementById('ollama-model-select');
  try {
    const r = await fetch('/api/ollama/models');
    const d = await r.json();
    ollamaModels = Array.isArray(d.models) ? d.models : [];
    ollamaDevices = Array.isArray(d.devices) ? d.devices : [];
    const multi = ollamaDevices.length > 1;
    const where = (m) => multi ? ' · ' + m.devices.map(x => x.name).join(', ') : '';
    const group = (cloud) => ollamaModels.filter(m => !!m.is_cloud === cloud).sort((a, b) => a.name.localeCompare(b.name)).map(m =>
      `<option value="${escapeHtml(m.name)}">${escapeHtml(m.name)}${cloud ? ' — ' + escapeHtml(m.remote_host || 'remote host') : ' — ' + escapeHtml(m.size_human) + escapeHtml(where(m))}</option>`).join('');
    sel.innerHTML = (d.error ? '<option value="" disabled>Ollama offline</option>' : '') +
      (ollamaModels.some(m => !m.is_cloud) ? `<optgroup label="${multi ? 'Local — your devices' : 'Local — this computer'}">${group(false)}</optgroup>` : '') +
      (ollamaModels.some(m => m.is_cloud) ? `<optgroup label="Cloud — hosted remotely">${group(true)}</optgroup>` : '') +
      '<optgroup label="More"><option value="__download_models__">Find and download chat models…</option></optgroup>';
    const hasDefault = ollamaModels.some(m => m.name === ollamaCurrentModel);
    if (!hasDefault && ollamaModels.length > 0) ollamaCurrentModel = (ollamaModels.find(m => !m.is_cloud) || ollamaModels[0]).name;
    sel.value = ollamaCurrentModel;
    if (!ollamaModels.some(m => !m.is_cloud)) openChatLibrary();  // no local models yet: show where to get some
  } catch (e) {
    sel.innerHTML = "<option>Couldn't load models</option>";
  }
  renderOllamaDevices();
}

// "Run on": only shown when the chosen model is on more than one device.
function renderOllamaDevices() {
  const sel = document.getElementById('ollama-device-select');
  const model = ollamaModels.find(m => m.name === ollamaCurrentModel);
  const on = model && !model.is_cloud ? model.devices : [];
  if (ollamaDevice !== 'auto' && !on.some(d => d.id === ollamaDevice)) ollamaDevice = 'auto';
  sel.hidden = on.length < 2;
  sel.innerHTML = '<option value="auto">Best device</option>' + on.map(d =>
    `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}${d.loaded ? ' (loaded)' : ''}</option>`).join('');
  sel.value = ollamaDevice;
  renderOllamaInfo();
}

function renderOllamaInfo() {
  const info = document.getElementById('ollama-model-info');
  const model = ollamaModels.find(m => m.name === ollamaCurrentModel);
  if (!model) { info.textContent = ollamaModels.length ? '' : 'No models'; return; }
  if (model.is_cloud) { info.textContent = 'Cloud'; return; }
  const only = model.devices.length === 1 ? model.devices[0].name : '';
  info.textContent = ollamaLastDevice ? 'On ' + ollamaLastDevice : (only && ollamaDevices.length > 1 ? 'On ' + only : 'Local');
}

function onOllamaModelChange(model) {
  if (model === '__download_models__') {
    document.getElementById('ollama-model-select').value = ollamaCurrentModel;
    openChatLibrary();
    return;
  }
  ollamaCurrentModel = model;
  ollamaLastDevice = '';
  renderOllamaDevices();
}

// ── Find and download chat models, on any connected device ──
const CHAT_FIT = { fast: 'Runs well', ok: 'Runs, a bit slower', slow: 'Slow without a GPU', 'too-big': 'Too big for this device', unknown: '' };

function openChatLibrary(deviceId) {
  const picker = document.getElementById('chat-model-downloads');
  if (deviceId) openChatLibrary.want = deviceId;
  picker.hidden = false;
  if (picker.open) loadChatLibrary(); else picker.open = true;  // ontoggle loads it
  picker.scrollIntoView({ block: 'nearest' });
}

async function loadChatLibrary() {
  const devSel = document.getElementById('chat-lib-device');
  const list = document.getElementById('chat-lib-list');
  const specs = document.getElementById('chat-lib-specs');
  if (!ollamaDevices.length) {
    try { ollamaDevices = (await (await fetch('/api/ai/devices')).json()).devices || []; } catch {}
  }
  const online = ollamaDevices.filter(d => d.online);
  const want = openChatLibrary.want || devSel.value || 'self';
  openChatLibrary.want = null;
  devSel.innerHTML = online.map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}${d.local ? ' (this computer)' : ''}</option>`).join('')
    || '<option value="self">This computer</option>';
  devSel.value = online.some(d => d.id === want) ? want : devSel.options[0].value;
  devSel.closest('.chat-lib-bar').hidden = online.length < 2;
  list.innerHTML = '<p class="lab-dim">Checking which models fit…</p>';
  specs.textContent = '';
  let d;
  try {
    const r = await fetch('/api/ai/library?device=' + encodeURIComponent(devSel.value));
    d = await r.json();
    if (!r.ok) throw new Error(d.error);
  } catch (e) { list.innerHTML = `<p class="lab-dim">${escapeHtml(e.message || 'Could not load the model list.')}</p>`; return; }
  const dev = d.device;
  const mem = dev.unified ? `${Math.round(dev.ram / 1e9)} GB shared GPU memory` : dev.vram ? `${Math.round(dev.vram / 1e9)} GB GPU memory + ${Math.round(dev.ram / 1e9)} GB RAM` : `${Math.round(dev.ram / 1e9)} GB RAM, no GPU found`;
  specs.textContent = `${dev.name}: ${mem}${dev.gpus.length ? ' · ' + dev.gpus.join(', ') : ''}. Best matches first. Sizes are the real download sizes from ollama.com.`;
  list.innerHTML = d.models.map(m => `
    <div class="chat-lib-item${m.fit === 'too-big' ? ' muted' : ''}">
      <div><b>${escapeHtml(m.label)}</b><span>${escapeHtml(m.model)} · ${(m.size / 1e9).toFixed(1)} GB${CHAT_FIT[m.fit] ? ` · <em class="fit-${escapeHtml(m.fit)}">${CHAT_FIT[m.fit]}</em>` : ''}</span><span>${escapeHtml(m.note)}</span></div>
      ${m.installed ? `<button class="lab-btn" data-m="${escapeHtml(m.model)}" data-onclick="c1692308">Remove</button>`
        : m.fit === 'too-big' ? '' : `<button class="lab-btn primary" data-m="${escapeHtml(m.model)}" data-onclick="c7ad40b9">Download</button>`}
    </div>`).join('');
  chatPollPulls();
}

async function chatPull(model) {
  if (!model) return;
  const device = document.getElementById('chat-lib-device').value || 'self';
  const r = await fetch('/api/ai/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device, model }) }).catch(() => null);
  const d = await r?.json().catch(() => ({})) || {};
  if (!r || !r.ok) { showToast(d.error || 'Could not start the download.'); return; }
  document.getElementById('chat-lib-custom').value = '';
  chatPollPulls();
}

async function chatPollPulls() {
  clearTimeout(chatPollPulls.t);
  const box = document.getElementById('chat-lib-pulls');
  let pulls = [];
  try { pulls = (await (await fetch('/api/ai/pulls')).json()).pulls || []; } catch { return; }
  const running = pulls.filter(p => p.state === 'running');
  const seen = chatPollPulls.running || new Set();
  const finished = pulls.filter(p => seen.has(p.id) && p.state !== 'running');
  chatPollPulls.running = new Set(running.map(p => p.id));
  box.innerHTML = running.map(p => {
    const pct = p.total ? Math.round(p.done / p.total * 100) : 0;
    return `<div class="chat-lib-pull"><div><b>${escapeHtml(p.model)}</b> to ${escapeHtml(p.device_name)} · ${p.total ? pct + '%' : escapeHtml(p.status || 'starting')}</div>
      <i class="lab-meter-bar"><s style="width:${pct}%"></s></i>
      <button class="lab-btn" data-id="${escapeHtml(p.id)}" data-onclick="c31e07b4">Cancel</button></div>`;
  }).join('');
  for (const p of finished) {
    showToast(p.state === 'done' ? `${p.model} is ready on ${p.device_name}` : p.state === 'failed' ? `${p.model}: ${p.error || 'download failed'}` : `${p.model} download cancelled`);
  }
  if (finished.length) { await loadOllamaModels(); loadChatLibrary(); return; }
  if (running.length && document.getElementById('ollama-screen')?.classList.contains('active')) chatPollPulls.t = setTimeout(chatPollPulls, 1500);
}

async function chatCancelPull(id) {
  await fetch(`/api/ai/pulls/${encodeURIComponent(id)}/cancel`, { method: 'POST' }).catch(() => {});
  chatPollPulls();
}

async function chatRemoveModel(model) {
  const device = document.getElementById('chat-lib-device').value || 'self';
  const name = document.getElementById('chat-lib-device').selectedOptions[0]?.textContent || 'this device';
  if (!await appConfirm(`Remove ${model} from ${name}? You can download it again later.`, { danger: true, ok: 'Remove' })) return;
  const r = await fetch('/api/ai/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device, model }) }).catch(() => null);
  const d = await r?.json().catch(() => ({})) || {};
  if (!r || !r.ok) { showToast(d.error || 'Could not remove it.'); return; }
  await loadOllamaModels();
  loadChatLibrary();
}

function simpleMarkdown(text) {
  return escapeHtml(text)
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre class="ollama-code">${code}</pre>`)   // already escaped above
    .replace(/`([^`]+)`/g, '<code class="ollama-inline-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    .replace(/\n/g, '<br>');
}

async function sendOllamaMessage() {
  const input = document.getElementById('ollama-input');
  const text = input.value.trim();
  if (!text || ollamaStreaming) return;

  input.value = '';
  input.style.height = 'auto';

  // Remove welcome message
  const welcome = document.querySelector('.ollama-welcome');
  if (welcome) welcome.remove();

  // Add user message
  const msgs = document.getElementById('ollama-messages');
  const userBubble = document.createElement('div');
  userBubble.className = 'ollama-msg user';
  userBubble.innerHTML = `<div class="ollama-msg-content">${escapeHtml(text)}</div>`;
  msgs.appendChild(userBubble);

  // Add assistant bubble (will stream into this)
  const aiBubble = document.createElement('div');
  aiBubble.className = 'ollama-msg assistant';
  aiBubble.innerHTML = '<div class="ollama-msg-content"><div class="pixel-loader"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div></div>';
  msgs.appendChild(aiBubble);
  const aiContent = aiBubble.querySelector('.ollama-msg-content');

  msgs.scrollTop = msgs.scrollHeight;

  // Build messages for API
  ollamaChatHistory.push({ role: 'user', content: text });
  const apiMessages = ollamaChatHistory.slice(-40);

  ollamaStreaming = true;
  ollamaAbort = new AbortController();
  ollamaGenerationId = (globalThis.crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2)));
  document.getElementById('ollama-send-btn').style.display = 'none';
  document.getElementById('ollama-stop-btn').style.display = 'flex';
  await saveOllamaChat();

  let fullResponse = '';

  try {
    const resp = await fetch('/api/ollama/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ollamaCurrentModel, device: ollamaDevice, messages: apiMessages, generation_id: ollamaGenerationId }),
      signal: ollamaAbort.signal,
    });

    if (!resp.ok || !resp.body) {
      let detail = `HTTP ${resp.status}`;
      try { const ej = await resp.json(); if (ej.error) detail = ej.error; } catch {}
      aiContent.innerHTML = `<span style="color:var(--red)">Error: ${escapeHtml(detail)}</span>`;
      ollamaStreaming = false;
      ollamaAbort = null;
      document.getElementById('ollama-send-btn').style.display = 'flex';
      document.getElementById('ollama-stop-btn').style.display = 'none';
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const chunk = JSON.parse(line.slice(6));
          if (chunk.device) { ollamaLastDevice = chunk.device; renderOllamaInfo(); }
          if (chunk.content) {
            if (aiContent.querySelector('.ollama-typing')) aiContent.innerHTML = '';
            fullResponse += chunk.content;
            aiContent.innerHTML = simpleMarkdown(fullResponse);
            msgs.scrollTop = msgs.scrollHeight;
          }
          if (chunk.done) break;
          if (chunk.error) {
            aiContent.innerHTML = `<span style="color:var(--red)">Error: ${escapeHtml(chunk.error)}</span>`;
            break;
          }
        } catch {}
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      aiContent.innerHTML = fullResponse ? simpleMarkdown(fullResponse) + '<p class="ollama-stopped">Stopped</p>' : '<span class="ollama-stopped">Stopped</span>';
    } else {
      aiContent.innerHTML = `<span style="color:var(--red)">${escapeHtml(friendlyError(e))}</span>`;
    }
  }

  if (fullResponse) {
    ollamaChatHistory.push({ role: 'assistant', content: fullResponse });
  } else if (aiContent.querySelector('.pixel-loader')) {
    // Stream ended with no content and no explicit error — say so
    aiContent.innerHTML = '<span style="color:var(--red)">Error: model returned no response (check if it\'s pulled: ollama pull ' + escapeHtml(ollamaCurrentModel) + ')</span>';
  }
  await saveOllamaChat();

  ollamaStreaming = false;
  ollamaAbort = null;
  ollamaGenerationId = null;
  document.getElementById('ollama-send-btn').style.display = 'flex';
  document.getElementById('ollama-stop-btn').style.display = 'none';
}

function stopOllama() {
  if (ollamaAbort) ollamaAbort.abort();
  const loader = document.querySelector('#ollama-messages .pixel-loader');
  if (loader) loader.parentElement.textContent = 'Stopping…';
  fetch('/api/ollama/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ollamaCurrentModel, generation_id: ollamaGenerationId }),
  }).catch(() => {});
}

async function saveOllamaChat() {
  if (!ollamaChatHistory.length) return;
  if (!ollamaChatTitle) ollamaChatTitle = (ollamaChatHistory.find(m => m.role === 'user')?.content || 'Untitled').slice(0, 80);
  try {
    const r = await fetch('/api/ollama/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: ollamaChatId, title: ollamaChatTitle, model: ollamaCurrentModel, messages: ollamaChatHistory }) });
    if (!r.ok) throw new Error('save failed');
    ollamaChatId = (await r.json()).id;
  } catch { showToast('Could not save this chat'); }
}

async function toggleChatHistory() {
  const el = document.getElementById('ollama-chat-list');
  el.hidden = !el.hidden;
  if (el.hidden) return;
  el.textContent = 'Loading chats…';
  try {
    const r = await fetch('/api/ollama/chats');
    if (!r.ok) throw new Error('Could not load chats');
    const chats = (await r.json()).chats || [];
    el.innerHTML = chats.length ? chats.map(c => `<button class="ollama-history-item" data-id="${escapeHtml(c.id)}" data-onclick="c97ff5e9">${escapeHtml(c.title)}</button>`).join('') : 'No saved chats yet.';
  } catch { el.textContent = 'Could not load saved chats.'; }
}

async function openOllamaChat(id) {
  if (ollamaStreaming) { showToast('Stop the current response first'); return; }
  try {
    const r = await fetch('/api/ollama/chats/' + encodeURIComponent(id));
    if (!r.ok) throw new Error('Could not open chat');
    const chat = await r.json();
    ollamaChatId = id;
    ollamaChatTitle = chat.title || '';
    ollamaChatHistory = Array.isArray(chat.messages) ? chat.messages : [];
    if (chat.model && ollamaModels.some(m => m.name === chat.model)) {
      ollamaCurrentModel = chat.model;
      document.getElementById('ollama-model-select').value = chat.model;
      onOllamaModelChange(chat.model);
    }
    const msgs = document.getElementById('ollama-messages');
    msgs.innerHTML = ollamaChatHistory.filter(m => m.role === 'user' || m.role === 'assistant').map(m =>
      `<div class="ollama-msg ${m.role}"><div class="ollama-msg-content">${m.role === 'assistant' ? simpleMarkdown(m.content) : escapeHtml(m.content)}</div></div>`).join('');
    document.getElementById('ollama-chat-list').hidden = true;
    msgs.scrollTop = msgs.scrollHeight;
  } catch { showToast('Could not open that chat'); }
}

function newOllamaChat() {
  if (ollamaStreaming) { showToast('Stop the current response first'); return; }
  ollamaChatId = null;
  ollamaChatTitle = '';
  ollamaChatHistory = [];
  document.getElementById('ollama-chat-list').hidden = true;
  document.getElementById('ollama-messages').innerHTML = '<div class="ollama-welcome">Start a new conversation</div>';
}

// Auto-resize textarea
document.addEventListener('input', e => {
  if (e.target.id === 'ollama-input') {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  }
});

// Enter to send (shift+enter for newline)
document.addEventListener('keydown', e => {
  if (e.target.id === 'ollama-input' && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendOllamaMessage();
  }
});

// Clear chat button (double-tap model select)
function clearOllamaChat() {
  ollamaChatHistory = [];
  document.getElementById('ollama-messages').innerHTML = '<div class="ollama-welcome">Chat cleared</div>';
}

// ─── ComfyUI ─────────────────────────────────────────────
