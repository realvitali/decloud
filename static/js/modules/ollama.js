// ===== Module: ollama =====
let ollamaCurrentModel = 'qwen2.5:14b-instruct';
let ollamaChatHistory = [];
let ollamaStreaming = false;
let ollamaAbort = null;

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
    // Select default model
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
  document.getElementById('ollama-model-info').textContent = opt?.text.split('(')[1]?.replace(')','') || '';
  // Clear chat on model switch
  ollamaChatHistory = [];
  document.getElementById('ollama-messages').innerHTML = '<div class="ollama-welcome">Model switched to ' + model + '~</div>';
}

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
  const apiMessages = [...ollamaChatHistory];

  ollamaStreaming = true;
  document.getElementById('ollama-send-btn').style.display = 'none';
  document.getElementById('ollama-stop-btn').style.display = 'flex';

  let fullResponse = '';

  try {
    ollamaAbort = new AbortController();
    const resp = await fetch('/api/ollama/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ollamaCurrentModel, messages: apiMessages }),
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
      fullResponse += '\n\n*[stopped]*';
    } else {
      aiContent.innerHTML = `<span style="color:var(--red)">Error: ${e.message}</span>`;
    }
  }

  if (fullResponse) {
    ollamaChatHistory.push({ role: 'assistant', content: fullResponse });
  } else if (aiContent.querySelector('.pixel-loader')) {
    // Stream ended with no content and no explicit error — say so
    aiContent.innerHTML = '<span style="color:var(--red)">Error: model returned no response (check if it\'s pulled: ollama pull ' + escapeHtml(ollamaCurrentModel) + ')</span>';
  }

  ollamaStreaming = false;
  ollamaAbort = null;
  document.getElementById('ollama-send-btn').style.display = 'flex';
  document.getElementById('ollama-stop-btn').style.display = 'none';
}

function stopOllama() {
  if (ollamaAbort) ollamaAbort.abort();
  fetch('/api/ollama/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ollamaCurrentModel }),
  }).catch(() => {});
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
