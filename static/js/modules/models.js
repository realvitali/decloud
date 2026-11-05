// ===== Module: models =====
// AI Model Advisor — this machine's specs vs. real model sizes,
// with one-tap downloads into the right app folders.

const MODEL_TIERS = {
  'runs-well': { label: 'Likely fits GPU', cls: 'models-tier-good' },
  'tight':     { label: 'Tight — may offload', cls: 'models-tier-tight' },
  'cpu-only':  { label: 'CPU only (slow)', cls: 'models-tier-cpu' },
  'too-big':   { label: 'Too big for this machine', cls: 'models-tier-bad' },
};

let modelsPollTimer = null;

function loadModels(category) {
  const section = document.querySelector(`.models-picker[data-category="${category}"]`);
  if (!section) return;
  section.querySelector('.models-catalog').textContent = 'Checking available models…';
  fetch('/api/models/catalog')
    .then((r) => { if (!r.ok) throw new Error('catalog unavailable'); return r.json(); })
    .then((d) => { renderModelsData(d, category); modelsPoll(); })
    .catch(() => {
      section.querySelector('.models-catalog').textContent = 'Could not load recommendations. Check your internet connection and try reopening this section.';
    });
}

function renderModelsData(d, category) {
  const section = document.querySelector(`.models-picker[data-category="${category}"]`);
  if (!section) return;
  const specs = d.specs || {};
  const gpus = specs.gpus || [];
  const gpuText = gpus.length
    ? gpus.map((g) => `${g.name} · ${g.vram_total_gb}GB VRAM (${g.vram_free_gb}GB free)`).join(' + ')
    : 'No GPU detected';
  section.querySelector('.models-specs').innerHTML =
    `<strong>${escapeHtml(specs.cpu || '?')} cores</strong> · ${escapeHtml((specs.ram_total_gb || 0).toFixed(0))}GB RAM · ` +
    `${escapeHtml(gpuText)} · ${escapeHtml((specs.disk_free_gb || 0).toFixed(0))}GB disk free` +
    '<br>Fit is an estimate based on model size and total memory, not a speed guarantee. Other running apps also use memory. Models come from Hugging Face.';

  const groups = {};
  (d.catalog || []).forEach((item) => {
    (groups[item.category] = groups[item.category] || []).push(item);
  });
  const rank = { 'runs-well': 0, 'tight': 1, 'cpu-only': 2, 'too-big': 3 };
  const score = item => Math.min(4, ...(item.files || []).map(f => rank[f.tier] ?? 4));
  const items = (groups[category] || []).slice().sort((a, b) => score(a) - score(b));
  section.querySelector('.models-catalog').innerHTML = items.length
    ? `<div class="models-group"><div class="models-group-title">Recommended for this machine</div>${items.map(renderModelCard).join('')}</div>`
    : '<p>No recommendations are available for this app right now.</p>';
}

// Repo → analysis, so Get buttons can resolve split parts safely
const modelsKnown = {};

function renderModelCard(item) {
  modelsKnown[item.repo] = { category: item.category, files: item.files || [] };
  const files = item.files || [];
  const err = item.error ? `<div class="models-error">${escapeHtml(item.error)}</div>` : '';
  const rank = { 'runs-well': 0, 'tight': 1, 'cpu-only': 2, 'too-big': 3 };
  const fileRows = files.slice().sort((a, b) => (rank[a.tier] ?? 4) - (rank[b.tier] ?? 4)).slice(0, 5).map((f) => {
    const t = MODEL_TIERS[f.tier] || MODEL_TIERS['too-big'];
    const canDownload = f.tier !== 'too-big';
    const partsNote = f.parts && f.parts.length > 1
      ? ` (${f.parts.length} parts — merged automatically)` : '';
    return `<div class="models-file">
      <div class="models-file-name" title="${escapeHtml(f.file)}">${escapeHtml(f.file)}${partsNote}</div>
      <div class="models-file-size">${escapeHtml(f.size_gb)} GB</div>
      <span class="models-tier ${t.cls}">${escapeHtml(t.label)}</span>
      ${canDownload ? `<button class="models-get-btn" data-repo="${escapeHtml(item.repo)}" data-file="${escapeHtml(f.file)}" data-onclick="cce8b14e">Download</button>` : ''}
    </div>`;
  }).join('');
  const more = files.length > 5 ? `<div class="models-more">+${files.length - 5} more files</div>` : '';
  return `<div class="models-card">
    <div class="models-card-head">
      <div class="models-card-label">${escapeHtml(item.label)}</div>
      <div class="models-card-total">${escapeHtml(item.total_gb)} GB total</div>
    </div>
    <div class="models-card-note">${escapeHtml(item.note || '')}</div>
    ${err}${fileRows || (!item.error ? '<div class="models-card-note">No downloadable model files found.</div>' : '')}${more}
  </div>`;
}

function renderAnalyzed(container, result) {
  container.innerHTML = result.error
    ? `<div class="models-card"><div class="models-error">${escapeHtml(result.error)}</div></div>`
    : `<div class="models-group">
        <div class="models-group-title">${escapeHtml(result.repo)} — ${escapeHtml(result.total_gb)} GB total</div>
        ${renderModelCard({ ...result, label: result.repo, note: 'Files in this repo and how they fit:' })}
      </div>`;
}

async function modelsAnalyzeCustom() {
  const input = document.getElementById('models-add-input');
  let repo = input.value.trim();
  if (!repo) return;
  // Accept pasted URLs: strip to owner/repo
  repo = repo.replace(/^https?:\/\/huggingface\.co\//, '').replace(/\/.*$/, '');
  const category = document.getElementById('models-add-category').value;
  const el = document.getElementById('models-analyzed');
  el.innerHTML = '<div class="music-empty">Analyzing against your hardware…</div>';
  try {
    const r = await fetch('/api/models/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, category }),
    });
    renderAnalyzed(el, await r.json());
  } catch (e) {
    el.innerHTML = `<div class="models-error">Analysis failed: ${escapeHtml(e.message || 'network')}</div>`;
  }
}

async function modelsDownload(repo, file) {
  const known = modelsKnown[repo] || { category: 'chat', files: [] };
  const entry = (known.files || []).find((f) => f.file === file);
  const category = known.category || 'chat';
  const parts = entry && entry.parts;
  const label = (parts ? parts[0] : file).split('/').pop();
  if (!await appConfirm(`Download ${label}${parts && parts.length > 1 ? ` (${parts.length} parts)` : ''} (${repo})?\n\nDeCloud will put it where your apps can find it` +
    (category === 'chat' ? ' and import it into Ollama automatically.' : ' (your ComfyUI models folder).'), { ok: 'Download' })) return;
  try {
    const body = { repo, category, import_ollama: category === 'chat' };
    if (parts && parts.length > 1) body.files = parts;
    else body.file = file;
    const r = await fetch('/api/models/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) { showToast(d.error || 'Download could not start'); return; }
    modelsPoll();
  } catch (e) {
    showToast('Download could not start: ' + friendlyError(e));
  }
}

async function modelsPoll() {
  clearInterval(modelsPollTimer);
  const tick = async () => {
    try {
      const r = await fetch('/api/models/downloads');
      const d = await r.json();
      const list = d.downloads || [];
      document.querySelectorAll('.models-picker').forEach(section => {
      const el = section.querySelector('.models-downloads');
      el.innerHTML = list.filter(dl => dl.category === section.dataset.category).map((dl) => {
        const total = dl.total_bytes || 0;
        const pct = total > 0 ? Math.min(100, Math.round((dl.done_bytes / total) * 100)) : 0;
        const status = dl.state === 'done'
          ? (dl.ollama ? `Ready in AI Chat (${dl.ollama})` : dl.category === 'chat' ? `Downloaded, but import failed: ${dl.ollama_error || 'check Ollama'}` : 'Downloaded — a compatible workflow and additional files may still be needed')
          : dl.state === 'error' ? `Error: ${dl.error || ''}`
          : dl.state === 'cancelled' ? 'Cancelled'
          : dl.state;
        return `<div class="models-dl">
          <div class="models-dl-name">${escapeHtml(dl.file.split('/').pop())}</div>
          <div class="models-dl-status">${escapeHtml(status)}</div>
          ${(dl.state === 'downloading' || dl.state === 'queued') ? `
            <div class="comfy-progress-bar"><div class="comfy-progress-fill" style="width:${pct}%"></div></div>
            <button class="settings-export-btn" data-id="${escapeHtml(dl.id)}" data-onclick="c060108d">Cancel</button>` : ''}
        </div>`;
      }).join('');
      });
      const active = list.some((x) => ['queued', 'downloading', 'importing'].includes(x.state));
      if (!active) {
        clearInterval(modelsPollTimer);
        if (list.some(x => x.state === 'done' && x.category === 'chat' && x.ollama) && typeof loadOllamaModels === 'function') loadOllamaModels();
      }
    } catch (e) { /* transient */ }
  };
  modelsPollTimer = setInterval(tick, 2000);
  tick();
}

async function modelsCancel(id) {
  try { await fetch(`/api/models/downloads/${encodeURIComponent(id)}/cancel`, { method: 'POST' }); } catch (e) {}
}

// Expose
window.loadModels = loadModels;
window.modelsAnalyzeCustom = modelsAnalyzeCustom;
window.modelsDownload = modelsDownload;
window.modelsCancel = modelsCancel;
