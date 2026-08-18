// ===== Module: ollama (v91 — server-side chats + job streaming) =====

// ── Chat state ───────────────────────────────────────────
let ollamaCurrentModel = 'qwen2.5:14b-instruct';
let ollamaChatHistory = [];      // [{role, content, tokens?, gen_time?, tokens_per_sec?}]
let ollamaStreaming = false;
let ollamaAbort = null;
let currentChatId = null;
let currentChatTitle = null;
let chatList = [];
let activeJobId = null;          // server-side job being streamed
let activeStreamEl = null;       // the assistant bubble element currently streaming
let activeStreamContent = null;  // .ollama-msg-content within it
let streamBuffer = '';           // buffered text for active stream
let streamStartTime = 0;         // performance.now() at stream start
let streamTokenCount = 0;        // approx token count during stream
let lastChunkTime = 0;           // for reconnect staleness detection
let esReconnectTimer = null;
let esChunkBuffer = [];          // chunks received since last render

// ── Utilities ─────────────────────────────────────────────
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function simpleMarkdown(text) {
  return escapeHtml(text)
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre class="ollama-code">${escapeHtml(code)}</pre>`)
    .replace(/`([^`]+)`/g, '<code class="ollama-inline-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    .replace(/\n/g, '<br>');
}

function formatTimeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h';
  const days = Math.floor(hrs / 24);
  return days + 'd';
}

// ── Model loading ─────────────────────────────────────────
async function loadOllamaModels() {
  try {
    const r = await fetch('/api/ollama/models');
    const d = await r.json();
    if (d.error) {
      document.getElementById('ollama-model-select').innerHTML = '<option>Ollama offline</option>';
      document.getElementById('ollama-messages').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🤖</div>
          <h3>AI is offline</h3>
          <p>Install Ollama to chat with AI locally:</p>
          <p class="empty-hint">curl -fsSL https://ollama.com/install.sh | sh</p>
          <p class="empty-hint">Then: ollama pull qwen2.5:14b-instruct</p>
        </div>`;
      return;
    }
    const sel = document.getElementById('ollama-model-select');
    sel.innerHTML = d.models.map(m => `<option value="${m.name}">${m.name} (${m.size_human})</option>`).join('');
    const hasDefault = d.models.some(m => m.name === ollamaCurrentModel);
    if (!hasDefault && d.models.length > 0) ollamaCurrentModel = d.models[0].name;
    sel.value = ollamaCurrentModel;
    const model = d.models.find(m => m.name === ollamaCurrentModel);
    if (model) document.getElementById('ollama-model-info').textContent = model.family;
  } catch (e) {
    document.getElementById('ollama-model-select').innerHTML = '<option>Failed to load</option>';
  }
}

function onOllamaModelChange(model) {
  ollamaCurrentModel = model;
  const sel = document.getElementById('ollama-model-select');
  const opt = sel.options[sel.selectedIndex];
  if (document.getElementById('ollama-model-info'))
    document.getElementById('ollama-model-info').textContent = opt?.text.split('(')[1]?.replace(')', '') || '';
}

// ── Chat list (drawer) ───────────────────────────────────
async function loadChatList() {
  try {
    const r = await fetch('/api/ollama/chats');
    if (!r.ok) return;
    chatList = await r.json();
    if (!Array.isArray(chatList)) chatList = chatList.chats || [];
    renderChatList();
  } catch (e) { /* silent */ }
}

function renderChatList() {
  const container = document.getElementById('ollama-chat-list');
  if (!container) return;
  if (!chatList.length) {
    container.innerHTML = '<div style="color:var(--text-dim);padding:16px;text-align:center;font-size:13px">No chats yet</div>';
    return;
  }
  container.innerHTML = chatList.map(chat => {
    const isActive = chat.id === currentChatId;
    const ts = formatTimeAgo(chat.updated_at || chat.timestamp);
    return `<div class="ollama-chat-item${isActive ? ' active' : ''}" onclick="openChat('${chat.id}')">
      <div class="ollama-chat-item-info">
        <div class="ollama-chat-item-title">${escapeHtml(chat.title || 'Untitled')}</div>
        <div class="ollama-chat-item-time">${ts}</div>
      </div>
      <div class="ollama-chat-item-actions">
        <button onclick="event.stopPropagation();renameChat('${chat.id}','${escapeHtml(chat.title || '')}')" title="Rename"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button onclick="event.stopPropagation();nukeChat('${chat.id}')" title="Delete"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
      </div>
    </div>`;
  }).join('');
}

// ── New chat ──────────────────────────────────────────────
function newChat() {
  currentChatId = null;
  currentChatTitle = null;
  ollamaChatHistory = [];
  document.getElementById('ollama-messages').innerHTML = '<div class="ollama-welcome">Start a new conversation~</div>';
  closeOllamaDrawer();
  renderChatList();
}

// ── Open existing chat ────────────────────────────────────
async function openChat(id) {
  try {
    const r = await fetch('/api/ollama/chats/' + id);
    if (!r.ok) return;
    const chat = await r.json();
    currentChatId = chat.id;
    currentChatTitle = chat.title;
    ollamaChatHistory = chat.messages || [];
    renderChatMessages();
    closeOllamaDrawer();
    renderChatList();
  } catch (e) { /* silent */ }
}

function renderChatMessages() {
  const msgs = document.getElementById('ollama-messages');
  msgs.innerHTML = '';
  if (!ollamaChatHistory.length) {
    msgs.innerHTML = '<div class="ollama-welcome">No messages yet</div>';
    return;
  }
  ollamaChatHistory.forEach(msg => {
    appendMessage(msg.role, msg.content, msg);
  });
}

function appendMessage(role, content, meta) {
  const msgs = document.getElementById('ollama-messages');
  const welcome = msgs.querySelector('.ollama-welcome');
  if (welcome) welcome.remove();

  const bubble = document.createElement('div');
  bubble.className = 'ollama-msg ' + role;
  const metaHtml = (role === 'assistant' && meta && (meta.tokens || meta.gen_time)) ? `
    <div class="ollama-msg-meta">
      ${meta.tokens ? `<span>${meta.tokens} tok</span>` : ''}
      ${meta.gen_time ? `<span>${meta.gen_time}s</span>` : ''}
      ${meta.tokens_per_sec ? `<span>${meta.tokens_per_sec} tok/s</span>` : ''}
    </div>` : '';
  const menuBtn = role === 'assistant' ? `<button class="ollama-msg-menu-btn" onclick="showMessageMenu(this, ${JSON.stringify({content: content, tokens: meta?.tokens, gen_time: meta?.gen_time, tokens_per_sec: meta?.tokens_per_sec}).replace(/"/g, '&quot;')})"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg></button>` : '';
  bubble.innerHTML = `<div class="ollama-msg-content">${simpleMarkdown(content)}</div>${metaHtml}${menuBtn}`;
  msgs.appendChild(bubble);
  msgs.scrollTop = msgs.scrollHeight;
  return bubble;
}

// ── Save chat ─────────────────────────────────────────────
async function saveChat() {
  if (!ollamaChatHistory.length) return;
  try {
    const body = {
      id: currentChatId,
      title: currentChatTitle,
      model: ollamaCurrentModel,
      messages: ollamaChatHistory,
    };
    const r = await fetch('/api/ollama/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      const data = await r.json();
      if (data.id && !currentChatId) currentChatId = data.id;
      if (data.title) currentChatTitle = data.title;
      loadChatList();
    }
  } catch (e) { /* silent */ }
}

// ── Rename chat ───────────────────────────────────────────
async function renameChat(id, currentTitle) {
  const title = prompt('Rename chat:', currentTitle || '');
  if (title === null) return;
  try {
    const r = await fetch('/api/ollama/chats/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim() || 'Untitled' }),
    });
    if (r.ok) {
      if (id === currentChatId) currentChatTitle = title;
      loadChatList();
    }
  } catch (e) { /* silent */ }
}

// ── Nuke (delete) chat ────────────────────────────────────
async function nukeChat(id) {
  if (!confirm('Delete this chat permanently?')) return;
  try {
    const r = await fetch('/api/ollama/chats/' + id + '/nuke', { method: 'POST' });
    if (r.ok) {
      if (id === currentChatId) newChat();
      loadChatList();
    }
  } catch (e) { /* silent */ }
}

// ── Auto-title after first user message ────────────────────
async function autoTitle() {
  if (!currentChatId) return;
  if (currentChatTitle && currentChatTitle !== 'New Chat') return;
  const firstUser = ollamaChatHistory.find(m => m.role === 'user');
  if (!firstUser) return;
  const title = firstUser.content.slice(0, 50).trim();
  try {
    const r = await fetch('/api/ollama/chats/' + currentChatId + '/title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title || 'New Chat' }),
    });
    if (r.ok) {
      currentChatTitle = title || 'New Chat';
      loadChatList();
    }
  } catch (e) { /* silent */ }
}

// ── Message menu popup ────────────────────────────────────
function showMessageMenu(button, msgData) {
  const popup = document.getElementById('ollama-msg-menu');
  if (!popup) return;
  const rect = button.getBoundingClientRect();
  popup.style.display = 'block';
  popup.style.left = Math.min(rect.left, window.innerWidth - 200) + 'px';
  popup.style.top = (rect.bottom + 4) + 'px';
  const data = typeof msgData === 'string' ? JSON.parse(msgData.replace(/&quot;/g, '"')) : msgData;
  popup.innerHTML = `
    <div class="ollama-msg-menu-stats">
      ${data.tokens ? `<div><span>Tokens</span><b>${data.tokens}</b></div>` : ''}
      ${data.gen_time ? `<div><span>Gen time</span><b>${data.gen_time}s</b></div>` : ''}
      ${data.tokens_per_sec ? `<div><span>Speed</span><b>${data.tokens_per_sec} tok/s</b></div>` : ''}
      ${!data.tokens && !data.gen_time ? '<div><span>No stats</span></div>' : ''}
    </div>
    <button class="ollama-msg-menu-copy" onclick="copyToClipboard(${JSON.stringify(data.content).replace(/"/g, '&quot;')})">Copy text</button>`;
}

function closeMessageMenu() {
  const popup = document.getElementById('ollama-msg-menu');
  if (popup) popup.style.display = 'none';
}

// ── Clipboard ─────────────────────────────────────────────
async function copyToClipboard(text) {
  const toast = document.getElementById('ollama-copied-toast');
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
  }
  if (toast) {
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 1500);
  }
  closeMessageMenu();
}

// ── Drawer ───────────────────────────────────────────────
function openOllamaDrawer() {
  document.getElementById('ollama-drawer').classList.add('open');
  document.getElementById('ollama-drawer-overlay').classList.add('show');
  loadChatList();
}
function closeOllamaDrawer() {
  document.getElementById('ollama-drawer').classList.remove('open');
  document.getElementById('ollama-drawer-overlay').classList.remove('show');
}

// ── Send message (server-side job streaming) ─────────────
async function sendOllamaMessage() {
  const input = document.getElementById('ollama-input');
  const text = input.value.trim();
  if (!text || ollamaStreaming) return;

  input.value = '';
  input.style.height = 'auto';

  const welcome = document.querySelector('.ollama-welcome');
  if (welcome) welcome.remove();

  // Add user message
  appendMessage('user', text);
  ollamaChatHistory.push({ role: 'user', content: text });

  // Add assistant bubble (streaming target)
  const msgs = document.getElementById('ollama-messages');
  activeStreamEl = document.createElement('div');
  activeStreamEl.className = 'ollama-msg assistant';
  activeStreamEl.innerHTML = '<div class="ollama-msg-content"><div class="pixel-loader"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div></div>';
  msgs.appendChild(activeStreamEl);
  activeStreamContent = activeStreamEl.querySelector('.ollama-msg-content');
  msgs.scrollTop = msgs.scrollHeight;

  ollamaStreaming = true;
  streamBuffer = '';
  streamStartTime = performance.now();
  streamTokenCount = 0;
  esChunkBuffer = [];
  lastChunkTime = Date.now();
  document.getElementById('ollama-send-btn').style.display = 'none';
  document.getElementById('ollama-stop-btn').style.display = 'flex';

  // Save chat (creates chat id if needed) before generating
  await saveChat();
  // Auto-title if first user message
  if (ollamaChatHistory.filter(m => m.role === 'user').length === 1) {
    autoTitle();
  }

  const apiMessages = [...ollamaChatHistory];

  try {
    // POST to start server-side job
    ollamaAbort = new AbortController();
    const resp = await fetch('/api/ollama/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ollamaCurrentModel, messages: apiMessages, chat_id: currentChatId }),
      signal: ollamaAbort.signal,
    });

    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try { const ej = await resp.json(); if (ej.error) detail = ej.error; } catch {}
      activeStreamContent.innerHTML = `<span style="color:var(--red)">Error: ${escapeHtml(detail)}</span>`;
      finishStream(null);
      return;
    }

    // Response may be job_id (JSON) or direct SSE stream
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const jobData = await resp.json();
      if (jobData.error) {
        activeStreamContent.innerHTML = `<span style="color:var(--red)">Error: ${escapeHtml(jobData.error)}</span>`;
        finishStream(null);
        return;
      }
      activeJobId = jobData.job_id;
      if (activeJobId) {
        consumeJobStream(activeJobId);
      } else if (jobData.stream_url) {
        consumeJobStreamViaURL(jobData.stream_url);
      }
    } else {
      // Direct SSE stream from response body
      consumeDirectStream(resp.body);
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      streamBuffer += '\n\n*[stopped]*';
      if (activeStreamContent) activeStreamContent.innerHTML = simpleMarkdown(streamBuffer);
      finishStream(streamBuffer);
    } else {
      if (activeStreamContent) activeStreamContent.innerHTML = `<span style="color:var(--red)">Error: ${escapeHtml(e.message)}</span>`;
      finishStream(null);
    }
  }
}

// ── Direct SSE stream (fallback) ──────────────────────────
async function consumeDirectStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
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
          if (chunk.content) {
            if (activeStreamContent.querySelector('.pixel-loader')) activeStreamContent.innerHTML = '';
            streamBuffer += chunk.content;
            streamTokenCount += chunk.content.split(/\s+/).length;
            activeStreamContent.innerHTML = simpleMarkdown(streamBuffer);
            const msgs = document.getElementById('ollama-messages');
            msgs.scrollTop = msgs.scrollHeight;
            lastChunkTime = Date.now();
          }
          if (chunk.done) { /* stream complete */ }
          if (chunk.error) {
            activeStreamContent.innerHTML = `<span style="color:var(--red)">Error: ${escapeHtml(chunk.error)}</span>`;
            finishStream(null);
            return;
          }
        } catch {}
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      activeStreamContent.innerHTML = `<span style="color:var(--red)">Error: ${escapeHtml(e.message)}</span>`;
      finishStream(null);
      return;
    }
  }
  finishStream(streamBuffer);
}

// ── Job stream via SSE EventSource ────────────────────────
function consumeJobStream(jobId) {
  activeJobId = jobId;
  const url = '/api/ollama/chat/stream/' + jobId;
  let es;

  function connect() {
    es = new EventSource(url);
    es.onopen = () => { lastChunkTime = Date.now(); };

    es.onmessage = (ev) => {
      lastChunkTime = Date.now();
      try {
        const chunk = JSON.parse(ev.data);
        if (chunk.content) {
          if (activeStreamContent && activeStreamContent.querySelector('.pixel-loader')) activeStreamContent.innerHTML = '';
          streamBuffer += chunk.content;
          streamTokenCount += chunk.content.split(/\s+/).length;
          if (activeStreamContent) activeStreamContent.innerHTML = simpleMarkdown(streamBuffer);
          const msgs = document.getElementById('ollama-messages');
          if (msgs) msgs.scrollTop = msgs.scrollHeight;
        }
        if (chunk.error) {
          if (activeStreamContent) activeStreamContent.innerHTML = `<span style="color:var(--red)">Error: ${escapeHtml(chunk.error)}</span>`;
          es.close();
          finishStream(null);
          return;
        }
        if (chunk.done) {
          es.close();
          finishStream(streamBuffer);
        }
      } catch {}
    };

    es.onerror = () => {
      es.close();
      // Auto-reconnect if streaming still active and job likely alive
      if (ollamaStreaming && activeJobId === jobId) {
        // iOS background freeze — attempt reconnect after delay
        if (esReconnectTimer) clearTimeout(esReconnectTimer);
        esReconnectTimer = setTimeout(() => {
          if (ollamaStreaming && activeJobId === jobId) connect();
        }, 2000);
      }
    };
  }

  connect();
}

// ── Job stream via fetch URL (alternative) ───────────────
function consumeJobStreamViaURL(url) {
  // Use EventSource for SSE
  let es = new EventSource(url);
  es.onmessage = (ev) => {
    lastChunkTime = Date.now();
    try {
      const chunk = JSON.parse(ev.data);
      if (chunk.content) {
        if (activeStreamContent && activeStreamContent.querySelector('.pixel-loader')) activeStreamContent.innerHTML = '';
        streamBuffer += chunk.content;
        streamTokenCount += chunk.content.split(/\s+/).length;
        if (activeStreamContent) activeStreamContent.innerHTML = simpleMarkdown(streamBuffer);
        const msgs = document.getElementById('ollama-messages');
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
      }
      if (chunk.error) {
        if (activeStreamContent) activeStreamContent.innerHTML = `<span style="color:var(--red)">Error: ${escapeHtml(chunk.error)}</span>`;
        es.close();
        finishStream(null);
        return;
      }
      if (chunk.done) {
        es.close();
        finishStream(streamBuffer);
      }
    } catch {}
  };
  es.onerror = () => {
    es.close();
    if (ollamaStreaming) {
      if (esReconnectTimer) clearTimeout(esReconnectTimer);
      esReconnectTimer = setTimeout(() => {
        if (ollamaStreaming) consumeJobStreamViaURL(url);
      }, 2000);
    }
  };
}

// ── Resume active job (PWA visible again) ─────────────────
function resumeActiveOllamaJob() {
  if (!activeJobId || !ollamaStreaming) return;
  // Stale check: if last chunk was > 10s ago, the SSE may have frozen
  const stale = (Date.now() - lastChunkTime) > 10000;
  if (stale) {
    // Force reconnect
    if (esReconnectTimer) clearTimeout(esReconnectTimer);
    consumeJobStream(activeJobId);
  }
}

// ── Finish streaming ─────────────────────────────────────
function finishStream(finalText) {
  ollamaStreaming = false;
  ollamaAbort = null;
  activeJobId = null;
  if (esReconnectTimer) { clearTimeout(esReconnectTimer); esReconnectTimer = null; }

  const sendBtn = document.getElementById('ollama-send-btn');
  const stopBtn = document.getElementById('ollama-stop-btn');
  if (sendBtn) sendBtn.style.display = 'flex';
  if (stopBtn) stopBtn.style.display = 'none';

  if (finalText && finalText.trim()) {
    const genTime = ((performance.now() - streamStartTime) / 1000).toFixed(1);
    const tokens = streamTokenCount;
    const tps = tokens > 0 && parseFloat(genTime) > 0 ? (tokens / parseFloat(genTime)).toFixed(1) : '0';
    const msg = {
      role: 'assistant',
      content: finalText,
      tokens: tokens,
      gen_time: genTime,
      tokens_per_sec: tps,
    };
    ollamaChatHistory.push(msg);
    // Re-render the streaming bubble as a final message with meta
    if (activeStreamEl) {
      activeStreamEl.innerHTML = `<div class="ollama-msg-content">${simpleMarkdown(finalText)}</div>
        <div class="ollama-msg-meta">
          <span>${tokens} tok</span><span>${genTime}s</span><span>${tps} tok/s</span>
        </div>
        <button class="ollama-msg-menu-btn" onclick="showMessageMenu(this, ${JSON.stringify({content: finalText, tokens, gen_time: genTime, tokens_per_sec: tps}).replace(/"/g, '&quot;')})"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg></button>`;
    }
    saveChat();
  } else if (activeStreamContent && activeStreamContent.querySelector('.pixel-loader')) {
    activeStreamContent.innerHTML = '<span style="color:var(--red)">Error: model returned no response (check if it\'s pulled: ollama pull ' + escapeHtml(ollamaCurrentModel) + ')</span>';
  }

  activeStreamEl = null;
  activeStreamContent = null;
  streamBuffer = '';
}

// ── Stop ─────────────────────────────────────────────────
function stopOllama() {
  if (ollamaAbort) ollamaAbort.abort();
  // Cancel server-side job
  if (activeJobId) {
    fetch('/api/ollama/chat/cancel/' + activeJobId, { method: 'POST' }).catch(() => {});
  }
  fetch('/api/ollama/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ollamaCurrentModel }),
  }).catch(() => {});
  if (ollamaStreaming) finishStream(streamBuffer);
}

// ── Boot restore (PWA relaunch) ───────────────────────────
async function bootOllamaRestore() {
  try {
    const r = await fetch('/api/ollama/chat/active');
    if (!r.ok) return;
    const data = await r.json();
    if (data.job_id && data.chat_id) {
      // Resume the active job
      currentChatId = data.chat_id;
      await openChat(data.chat_id);
      activeJobId = data.job_id;
      ollamaStreaming = true;
      streamBuffer = '';
      streamStartTime = performance.now();
      streamTokenCount = 0;
      lastChunkTime = Date.now();
      // Create a new assistant bubble for resumed stream
      const msgs = document.getElementById('ollama-messages');
      activeStreamEl = document.createElement('div');
      activeStreamEl.className = 'ollama-msg assistant';
      activeStreamEl.innerHTML = '<div class="ollama-msg-content"><div class="pixel-loader"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div></div>';
      msgs.appendChild(activeStreamEl);
      activeStreamContent = activeStreamEl.querySelector('.ollama-msg-content');
      document.getElementById('ollama-send-btn').style.display = 'none';
      document.getElementById('ollama-stop-btn').style.display = 'flex';
      consumeJobStream(activeJobId);
    }
  } catch (e) { /* silent */ }
}

// ── visibilitychange handler ──────────────────────────────
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // iOS will freeze — note last chunk time for staleness
    lastChunkTime = Date.now();
  } else {
    // PWA became visible — check if we need to resume
    if (ollamaStreaming && activeJobId) {
      const stale = (Date.now() - lastChunkTime) > 5000;
      if (stale) {
        // Force-abort stale connection and resume
        resumeActiveOllamaJob();
      }
    }
  }
});

// ── Auto-resize textarea ──────────────────────────────────
document.addEventListener('input', e => {
  if (e.target.id === 'ollama-input') {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  }
});

// ── Enter to send (shift+enter newline) ───────────────────
document.addEventListener('keydown', e => {
  if (e.target.id === 'ollama-input' && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendOllamaMessage();
  }
});

// ── Click outside to close message menu ────────────────────
document.addEventListener('click', (e) => {
  const menu = document.getElementById('ollama-msg-menu');
  if (menu && menu.style.display === 'block' && !menu.contains(e.target) && !e.target.closest('.ollama-msg-menu-btn')) {
    closeMessageMenu();
  }
  const drawer = document.getElementById('ollama-drawer');
  if (drawer && drawer.classList.contains('open') && !drawer.contains(e.target) && !e.target.closest('#ollama-drawer-btn')) {
    closeOllamaDrawer();
  }
}, true);