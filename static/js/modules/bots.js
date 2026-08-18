// ===== Module: bots — Bot Mode for DeCloud =====
// Bots are Hermes profiles. Chat via /api/bots/<name>/chat (blocking).

let botsState = { list: [], active: null, loading: false };

async function botsLoad() {
  const el = document.getElementById('bots-roster');
  if (!el) return;
  try {
    const r = await fetch('/api/bots');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    botsState.list = data.bots || [];
    botsRenderRoster(el);
  } catch (e) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">🤖</div>
      <h3>Bots unavailable</h3>
      <p>Set DECLOUD_HERMES_HOME in .env and restart DeCloud.</p></div>`;
  }
}

function botsRenderRoster(el) {
  if (!botsState.list.length) {
    el.innerHTML = `<div class="bots-empty">
      <div class="bots-empty-emoji">🤖</div>
      <p>No bots yet. Each bot is a Hermes profile with its own model,
      skills and memory.</p></div>`;
    return;
  }
  el.innerHTML = botsState.list.map(b => `
    <div class="bot-card" data-bot="${b.name}" onclick="botsOpen('${b.name}')">
      <div class="bot-avatar" style="background:${b.color}">${b.emoji}</div>
      <div class="bot-info">
        <div class="bot-name">${esc(b.title)}
          <span class="bot-model">${esc(b.model || 'no model')}</span></div>
        <div class="bot-desc">${esc(b.description || b.name)}</div>
      </div>
      ${b.protected ? '<span class="bot-tag-protected" title="Core profile">core</span>' : ''}
      <button class="bot-delete" title="Delete bot"
        onclick="event.stopPropagation(); botsDelete('${b.name}')">✕</button>
    </div>`).join('');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function botsOpen(name) {
  const bot = botsState.list.find(b => b.name === name);
  if (!bot) return;
  botsState.active = name;
  // stash roster scroll, swap screen content to chat view
  const screen = document.getElementById('agents-content-inner') || document.querySelector('.agents-content');
  botsState.rosterHTML = screen.innerHTML;
  screen.innerHTML = `
    <div class="bot-chat-wrap">
      <div class="bot-chat-header" style="border-color:${bot.color}">
        <button class="back-btn" onclick="botsClose()">‹ Bots</button>
        <div class="bot-avatar sm" style="background:${bot.color}">${bot.emoji}</div>
        <div class="bot-info"><div class="bot-name">${esc(bot.title)}</div>
        <div class="bot-model">${esc(bot.model || '')}</div></div>
        <button class="bot-chat-clear" onclick="botsClear('${name}')">Clear</button>
      </div>
      <div class="bot-chat-messages" id="bot-msgs"><div class="text-dim">Loading…</div></div>
      <div class="bot-chat-inputrow">
        <textarea id="bot-input" class="bot-chat-input" rows="1"
          placeholder="Message ${esc(bot.title)}…"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();botsSend();}"></textarea>
        <button class="bot-send-btn" id="bot-send" onclick="botsSend()">➤</button>
      </div>
    </div>`;
  await botsHistory(name);
  const inp = document.getElementById('bot-input');
  if (inp) inp.focus();
}

function botsClose() {
  const screen = document.getElementById('agents-content-inner') || document.querySelector('.agents-content');
  if (botsState.rosterHTML) screen.innerHTML = botsState.rosterHTML;
  botsState.active = null;
}

async function botsHistory(name) {
  const el = document.getElementById('bot-msgs');
  if (!el) return;
  try {
    const r = await fetch(`/api/bots/${name}/history`);
    const data = await r.json();
    const msgs = data.messages || [];
    el.innerHTML = msgs.length ? msgs.map(m => botsMsgHTML(m)).join('')
      : `<div class="bot-chat-hint">Say hi — this bot has its own Hermes
         profile, model and memory.</div>`;
    el.scrollTop = el.scrollHeight;
  } catch (e) {
    el.innerHTML = '<div class="text-dim">Could not load history.</div>';
  }
}

function botsMsgHTML(m) {
  const mine = m.role === 'user';
  return `<div class="bot-msg ${mine ? 'mine' : ''}">
    <div class="bot-bubble">${linkify(esc(m.text))}</div>
  </div>`;
}

function linkify(s) {
  return s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

async function botsSend() {
  const name = botsState.active;
  if (!name || botsState.loading) return;
  const inp = document.getElementById('bot-input');
  const el = document.getElementById('bot-msgs');
  const btn = document.getElementById('bot-send');
  const msg = (inp.value || '').trim();
  if (!msg || !el) return;
  inp.value = '';
  el.insertAdjacentHTML('beforeend', botsMsgHTML({ role: 'user', text: msg }));
  el.scrollTop = el.scrollHeight;
  botsState.loading = true;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  el.insertAdjacentHTML('beforeend',
    `<div class="bot-msg" id="bot-typing"><div class="bot-bubble typing">
      <span></span><span></span><span></span></div></div>`);
  el.scrollTop = el.scrollHeight;
  try {
    const r = await fetch(`/api/bots/${name}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });
    const data = await r.json();
    const typing = document.getElementById('bot-typing');
    if (typing) typing.remove();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    el.insertAdjacentHTML('beforeend', botsMsgHTML({ role: 'assistant', text: data.reply }));
  } catch (e) {
    const typing = document.getElementById('bot-typing');
    if (typing) typing.remove();
    el.insertAdjacentHTML('beforeend',
      `<div class="bot-msg"><div class="bot-bubble err">${esc(e.message)}</div></div>`);
  } finally {
    botsState.loading = false;
    if (btn) { btn.disabled = false; btn.textContent = '➤'; }
    el.scrollTop = el.scrollHeight;
  }
}

async function botsClear(name) {
  if (!confirm('Clear chat and reset this bot\'s memory?')) return;
  await fetch(`/api/bots/${name}/clear`, { method: 'POST' });
  botsHistory(name);
}

async function botsDelete(name) {
  if (!confirm(`Delete bot "${name}"? This removes its Hermes profile and chat log.`)) return;
  const r = await fetch(`/api/bots/${name}`, { method: 'DELETE' });
  if (r.ok) botsLoad();
  else { const d = await r.json(); alert(d.error || 'Delete failed'); }
}

function botsShowCreate() {
  const screen = document.getElementById('agents-content-inner') || document.querySelector('.agents-content');
  botsState.rosterHTML = screen.innerHTML;
  const palette = ['#7c6ff0','#34d399','#f59e0b','#ef4444','#06b6d4','#ec4899','#84cc16','#a78bfa'];
  const emojis = ['🤖','🦊','🐸','🐙','🦉','🐝','🦜','🐺','🐼','🔮','⚡','🧪','📚','🛠️','🎯','🧭'];
  screen.innerHTML = `
    <div class="bot-create">
      <div class="bot-create-head"><button class="back-btn" onclick="botsClose()">‹ Bots</button>
        <h3>New Bot</h3></div>
      <label class="bot-field">Name (lowercase, used as Hermes profile)
        <input id="nb-name" placeholder="scout" autocomplete="off" spellcheck="false">
      </label>
      <label class="bot-field">Title
        <input id="nb-title" placeholder="Morning Scout">
      </label>
      <label class="bot-field">What does it do?
        <textarea id="nb-desc" rows="2" placeholder="Watches GitHub trending and briefs me every morning"></textarea>
      </label>
      <label class="bot-field">Model override (optional — blank uses the profile default)
        <input id="nb-model" placeholder="minimax-m2.7:cloud">
      </label>
      <div class="bot-field">Avatar
        <div class="bot-emoji-row" id="nb-emojis">
          ${emojis.map(e => `<button type="button" class="bot-emoji-btn${e==='🤖'?' sel':''}" data-e="${e}">${e}</button>`).join('')}
        </div>
      </div>
      <div class="bot-field">Color
        <div class="bot-color-row" id="nb-colors">
          ${palette.map(c => `<button type="button" class="bot-color-btn${c==='#7c6ff0'?' sel':''}" data-c="${c}" style="background:${c}"></button>`).join('')}
        </div>
      </div>
      <button class="bot-create-btn" id="nb-submit" onclick="botsCreate()">Create Bot</button>
      <div class="bot-create-note">Creates a real Hermes profile (cloned from agent2).
        Configure its model/skills with <code>hermes -p &lt;name&gt;</code> later.</div>
    </div>`;
  document.getElementById('nb-emojis').addEventListener('click', e => {
    const b = e.target.closest('.bot-emoji-btn'); if (!b) return;
    document.querySelectorAll('#nb-emojis .bot-emoji-btn').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel');
  });
  document.getElementById('nb-colors').addEventListener('click', e => {
    const b = e.target.closest('.bot-color-btn'); if (!b) return;
    document.querySelectorAll('#nb-colors .bot-color-btn').forEach(x => x.classList.remove('sel'));
    b.classList.add('sel');
  });
  document.getElementById('nb-name').focus();
}

async function botsCreate() {
  const name = (document.getElementById('nb-name').value || '').trim().toLowerCase();
  const title = (document.getElementById('nb-title').value || '').trim() || name;
  const description = (document.getElementById('nb-desc').value || '').trim();
  const model = (document.getElementById('nb-model').value || '').trim();
  const emoji = document.querySelector('#nb-emojis .sel')?.dataset.e || '🤖';
  const color = document.querySelector('#nb-colors .sel')?.dataset.c || '#7c6ff0';
  const btn = document.getElementById('nb-submit');
  if (!name) { alert('Name required'); return; }
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const r = await fetch('/api/bots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, title, description, model, emoji, color }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    // Restore roster markup before reloading, else botsLoad early-returns
    if (botsState.rosterHTML) {
      const screen = document.getElementById('agents-content-inner') || document.querySelector('.agents-content');
      screen.innerHTML = botsState.rosterHTML;
    }
    await botsLoad();
    botsOpen(name);
  } catch (e) {
    alert(e.message);
    btn.disabled = false; btn.textContent = 'Create Bot';
  }
}

// Hook into screen switching: refresh roster when Agents screen opens
const _origShowAgents = typeof showScreen === 'function' ? showScreen : null;
