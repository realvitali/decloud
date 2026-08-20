// ===== Module: bots — Bot Mode for DeCloud =====
// Bots are Hermes profiles. Chat via /api/bots/<name>/chat (blocking).

let botsState = { list: [], active: null, loading: false };

// ─── History/back-button support ────────────────────────────────
// Bot chats push #bot/<name>; popstate returns to the roster.
window.addEventListener('popstate', () => {
  const m = location.hash.match(/^#bot\/([a-z0-9_-]+)$/);
  if (m) {
    botsOpen(m[1], true);
  } else if (botsState.active) {
    // left the bot hash (back to #agents or home) — restore roster
    botsRestoreRoster();
  }
});

function botsRestoreRoster() {
  const screen = document.getElementById('agents-content-inner') || document.querySelector('.agents-content');
  if (screen && botsState.rosterHTML && botsState.active) {
    screen.innerHTML = botsState.rosterHTML;
  }
  botsState.active = null;
}

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
        <div class="bot-preview">${esc(b.last_preview || b.description || b.name)}</div>
      </div>
      ${b.last_ts ? `<span class="bot-ts">${esc(b.last_ts.slice(11,16))}</span>` : ''}
      ${b.protected ? '<span class="bot-tag-protected" title="Core profile">core</span>' : ''}
      <button class="bot-delete" title="Delete bot"
        onclick="event.stopPropagation(); botsDelete('${b.name}')">✕</button>
    </div>`).join('');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function botsOpen(name, fromPop) {
  const bot = botsState.list.find(b => b.name === name);
  if (!bot) return;
  botsState.active = name;
  if (!fromPop) {
    // real history entry so mobile back returns to the roster
    if (location.hash !== `#bot/${name}`) history.pushState({}, '', `#bot/${name}`);
  }
  // stash roster scroll, swap screen content to chat view
  const screen = document.getElementById('agents-content-inner') || document.querySelector('.agents-content');
  if (!botsState.rosterHTML) botsState.rosterHTML = screen.innerHTML;
  const others = botsState.list.filter(b => b.name !== name);
  screen.innerHTML = `
    <div class="bot-chat-wrap">
      <div class="bot-chat-header" style="border-color:${bot.color}">
        <button class="back-btn" onclick="botsClose()">‹ Bots</button>
        <div class="bot-avatar sm" style="background:${bot.color}">${bot.emoji}</div>
        <div class="bot-info"><div class="bot-name">${esc(bot.title)}</div>
        <div class="bot-model">${esc(bot.model || '')}</div></div>
        <button class="bot-chat-clear" onclick="botsClear('${name}')">Clear</button>
        <button class="bot-persona-btn" onclick="botsTogglePersona('${name}')">Persona</button>
        <select id="bot-model-picker" class="bot-model-picker" onchange="botsSwitchModel('${name}', this.value)">
          <option value="">${esc(bot.model || 'default')}</option>
        </select>
      </div>
      <div class="bot-chat-messages" id="bot-msgs"><div class="text-dim">Loading…</div></div>
      <div class="bot-routines" id="bot-routines"></div>
      <div class="bot-mention-bar" id="bot-mention-bar" style="display:none">
        <span id="bot-mention-label"></span>
        <button class="bot-mention-cancel" onclick="botsMentionClear()">✕</button>
      </div>
      <div class="bot-chat-inputrow">
        <textarea id="bot-input" class="bot-chat-input" rows="1"
          placeholder="Message ${esc(bot.title)}… (@${esc(name)} them)"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();botsSend();}"></textarea>
        <button class="bot-send-btn" id="bot-send" onclick="botsSend()">➤</button>
      </div>
    </div>`;
  botsCurrentModel[name] = bot.model || '';
  // @mention autocomplete on typing "@"
  const inp = document.getElementById('bot-input');
  inp.addEventListener('input', () => botsMentionSuggest(inp, others));
  await botsHistory(name);
  await botsLoadRoutines(name);
  botsLoadModels(name);
  inp.focus();
}

function botsClose() {
  // Go back to bot roster, not DeCloud home.
  // Clear hash and restore roster directly.
  if (location.hash.startsWith('#bot/')) {
    history.pushState({}, '', '#agents');
  }
  botsRestoreRoster();
  // Reload roster to update previews
  botsLoad();
}

// ─── @mention: pick another bot to relay the question to ────────
let botsMention = null; // { to: 'botname' }

function botsMentionSuggest(inp, others) {
  const bar = document.getElementById('bot-mention-bar');
  if (!bar) return;
  const m = inp.value.match(/@([a-z0-9_-]*)$/);
  if (m && others.length) {
    const q = m[1].toLowerCase();
    const hits = others.filter(b => b.name.startsWith(q)).slice(0, 3);
    if (hits.length) {
      bar.style.display = 'flex';
      bar.innerHTML = hits.map(b =>
        `<button class="bot-mention-pick" onclick="botsMentionSet('${b.name}')">` +
        `<span class="bot-avatar xs" style="background:${b.color}">${b.emoji}</span> @${b.name}</button>`
      ).join('');
      return;
    }
  }
  if (!botsMention) bar.style.display = 'none';
}

function botsMentionSet(name) {
  botsMention = { to: name };
  const bar = document.getElementById('bot-mention-bar');
  bar.style.display = 'flex';
  bar.innerHTML = `<span class="bot-mention-label">↗ relaying to @${esc(name)}</span>
    <button class="bot-mention-cancel" onclick="botsMentionClear()">✕</button>`;
  const inp = document.getElementById('bot-input');
  inp.value = inp.value.replace(/@([a-z0-9_-]*)$/, '').trimEnd();
  inp.focus();
}

function botsMentionClear() {
  botsMention = null;
  const bar = document.getElementById('bot-mention-bar');
  if (bar) { bar.style.display = 'none'; bar.innerHTML = ''; }
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
  const mention = botsMention;
  botsMentionClear();
  try {
    const url = mention ? `/api/bots/${name}/relay` : `/api/bots/${name}/chat`;
    const body = mention ? { to: mention.to, message: msg } : { message: msg };
    // Include selected model override if set
    const selModel = botsCurrentModel[name];
    if (selModel) body.model = selModel;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    const typing = document.getElementById('bot-typing');
    if (typing) typing.remove();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    if (mention) {
      el.insertAdjacentHTML('beforeend',
        `<div class="bot-msg relay"><div class="bot-bubble relay-bubble">
         <span class="relay-tag">@${esc(data.from)}</span>${linkify(esc(data.reply))}</div></div>`);
      if (data.followup) {
        el.insertAdjacentHTML('beforeend', botsMsgHTML({ role: 'assistant', text: data.followup }));
      }
    } else {
      el.insertAdjacentHTML('beforeend', botsMsgHTML({ role: 'assistant', text: data.reply }));
    }
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

// ─── Routines (per-bot scheduled jobs) ──────────────────────────
async function botsLoadRoutines(name) {
  const host = document.getElementById('bot-routines');
  if (!host) return;
  try {
    const r = await fetch(`/api/bots/${name}/routines`);
    const data = await r.json();
    const items = (data.routines || []).map(rt => `
      <div class="routine-row">
        <div class="routine-info">
          <div class="routine-name">${esc(rt.name)}</div>
          <div class="routine-sched">${esc(typeof rt.schedule === 'object' ? (rt.schedule.display || JSON.stringify(rt.schedule)) : rt.schedule)}</div>
          ${rt.next_run ? `<div class="routine-next">next: ${esc(String(rt.next_run).slice(0, 16).replace('T', ' '))}</div>` : ''}
        </div>
        <button class="routine-del" onclick="botsDelRoutine('${name}','${rt.id}')">✕</button>
      </div>`).join('');
    host.innerHTML = `
      <div class="routine-head" onclick="document.getElementById('routine-form').classList.toggle('open')">
        ⏰ Routines <span class="routine-count">${(data.routines || []).length}</span> <span class="routine-chev">▾</span>
      </div>
      <div class="routine-list">${items || '<div class="routine-none">No routines — this bot only talks when you message it.</div>'}</div>
      <div class="routine-form" id="routine-form">
        <input id="rt-name" placeholder="Routine name (e.g. morning brief)" autocomplete="off">
        <input id="rt-sched" placeholder='Schedule: 30m, every 2h, or 0 9 * * *' autocomplete="off">
        <textarea id="rt-prompt" rows="2" placeholder="What should it do on schedule?"></textarea>
        <button class="routine-add" onclick="botsAddRoutine('${name}')">Add routine</button>
      </div>`;
  } catch (e) {
    host.innerHTML = '';
  }
}

async function botsAddRoutine(name) {
  const rname = document.getElementById('rt-name').value.trim();
  const sched = document.getElementById('rt-sched').value.trim();
  const prompt = document.getElementById('rt-prompt').value.trim();
  const btn = document.querySelector('.routine-add');
  if (!sched || !prompt) { alert('Schedule and prompt required'); return; }
  btn.disabled = true; btn.textContent = 'Adding…';
  try {
    const r = await fetch(`/api/bots/${name}/routines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: rname, schedule: sched, prompt }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    await botsLoadRoutines(name);
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Add routine';
  }
}

async function botsDelRoutine(name, id) {
  if (!confirm('Delete this routine?')) return;
  await fetch(`/api/bots/${name}/routines/${id}`, { method: 'DELETE' });
  botsLoadRoutines(name);
}

// ─── Persona Editor ────────────────────────────────────────
async function botsTogglePersona(name) {
  var panel = document.getElementById('bot-persona-panel');
  if (panel && panel.classList.contains('open')) {
    panel.classList.remove('open');
    return;
  }
  // Create panel if it doesn't exist
  if (!panel) {
    var wrap = document.querySelector('.bot-chat-wrap');
    if (!wrap) return;
    panel = document.createElement('div');
    panel.id = 'bot-persona-panel';
    panel.className = 'bot-persona-panel';
    wrap.insertBefore(panel, document.getElementById('bot-msgs'));
  }
  panel.classList.add('open');
  panel.innerHTML = '<div class="text-dim">Loading persona…</div>';

  try {
    var r = await fetch('/api/bots/' + name + '/persona');
    var d = await r.json();
    if (d.error) { panel.innerHTML = '<div class="text-dim">Error: ' + esc(d.error) + '</div>'; return; }
    var content = d.persona || '';
    panel.innerHTML =
      '<div class="bot-persona-header">Persona (SOUL.md) — this defines the bot\'s personality and identity</div>' +
      '<textarea id="bot-persona-text" class="bot-persona-textarea" placeholder="Write the bot\'s personality here…">' + esc(content) + '</textarea>' +
      '<div class="bot-persona-actions">' +
        '<button class="bot-persona-save" onclick="botsSavePersona(\'' + name + '\')">Save</button>' +
        '<button class="bot-persona-cancel" onclick="document.getElementById(\'bot-persona-panel\').classList.remove(\'open\')">Cancel</button>' +
        '<span class="bot-persona-hint">Changes apply to new messages. Clear chat to reset session.</span>' +
      '</div>';
  } catch (e) {
    panel.innerHTML = '<div class="text-dim">Failed to load: ' + esc(e.message) + '</div>';
  }
}

async function botsSavePersona(name) {
  var ta = document.getElementById('bot-persona-text');
  if (!ta) return;
  var btn = document.querySelector('.bot-persona-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    var r = await fetch('/api/bots/' + name + '/persona', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona: ta.value })
    });
    var d = await r.json();
    if (d.ok) {
      document.getElementById('bot-persona-panel').classList.remove('open');
    } else {
      alert(d.error || 'Save failed');
    }
  } catch (e) {
    alert(e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  }
}

// ─── Model Picker ──────────────────────────────────────────
var botsCurrentModel = {};

async function botsLoadModels(name) {
  var sel = document.getElementById('bot-model-picker');
  if (!sel) return;
  var current = botsCurrentModel[name] || '';
  try {
    var r = await fetch('/api/bots/models');
    var d = await r.json();
    if (d.error) return;
    var opts = '<option value="">' + (current ? esc(current) : 'default') + '</option>';
    // Group: local first, then cloud
    var local = d.models.filter(function(m) { return !m.cloud; });
    var cloud = d.models.filter(function(m) { return m.cloud; });
    if (local.length) {
      opts += '<optgroup label="Local">';
      local.forEach(function(m) {
        var sel = (m.name === current) ? ' selected' : '';
        var sz = m.size_gb ? ' (' + m.size_gb + 'GB)' : '';
        opts += '<option value="' + esc(m.name) + '"' + sel + '>' + esc(m.name) + sz + '</option>';
      });
      opts += '</optgroup>';
    }
    if (cloud.length) {
      opts += '<optgroup label="Cloud">';
      cloud.forEach(function(m) {
        var s = (m.name === current) ? ' selected' : '';
        opts += '<option value="' + esc(m.name) + '"' + s + '>' + esc(m.name) + '</option>';
      });
      opts += '</optgroup>';
    }
    sel.innerHTML = opts;
  } catch (e) { /* silent */ }
}

function botsSwitchModel(name, model) {
  botsCurrentModel[name] = model;
  // The model is passed per-message via the chat API body
}
