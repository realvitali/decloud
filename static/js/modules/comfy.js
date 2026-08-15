// ===== Module: comfy =====
let comfyPollTimer = null;

async function loadComfyStatus() {
  try {
    const r = await fetch('/api/comfy/status');
    const d = await r.json();
    const bar = document.getElementById('comfy-status-bar');
    if (!d.online) {
      bar.innerHTML = 'ComfyUI offline';
      bar.className = 'comfy-status-bar offline';
      document.getElementById('comfy-generate-btn').disabled = true;
      const hint = document.getElementById('comfy-offline-hint');
      if (hint) hint.style.display = '';
      return;
    }
    const hint = document.getElementById('comfy-offline-hint');
    if (hint) hint.style.display = 'none';
    bar.className = 'comfy-status-bar online';
    const vramUsed = ((d.vram_total - d.vram_free) / 1e9).toFixed(1);
    const vramTotal = (d.vram_total / 1e9).toFixed(1);
    const queueText = d.queue_running > 0 ? ` · ${d.queue_running} running` : '';
    const pendingText = d.queue_pending > 0 ? ` · ${d.queue_pending} queued` : '';
    bar.innerHTML = `${d.gpu} · VRAM ${vramUsed}/${vramTotal}GB${queueText}${pendingText}`;
    document.getElementById('comfy-generate-btn').disabled = false;
  } catch {
    document.getElementById('comfy-status-bar').innerHTML = 'Failed to check status';
  }
}

async function loadComfyModels() {
  try {
    const r = await fetch('/api/comfy/models');
    const d = await r.json();
    if (d.error) return;
    // Could populate checkpoint/lora selectors here in the future
  } catch {}
}

async function loadComfyGallery() {
  try {
    const r = await fetch('/api/comfy/gallery');
    const d = await r.json();
    if (d.error || !d.images || d.images.length === 0) {
      document.getElementById('comfy-gallery').innerHTML = '<span class="text-dim">No generations yet</span>';
      return;
    }
    const gallery = document.getElementById('comfy-gallery');
    gallery.innerHTML = d.images.slice(0, 20).map(img => 
      `<div class="comfy-gallery-item" onclick="openComfyImage('${img.url}')"><img src="${img.url}&preview=1" loading="lazy" alt="" /></div>`
    ).join('');
  } catch {}
}

function openComfyImage(url) {
  // Open in new tab for full quality
  window.open(url, '_blank');
}

async function comfyGenerate() {
  const prompt = document.getElementById('comfy-prompt').value.trim();
  if (!prompt) return;

  const sizeStr = document.getElementById('comfy-size').value;
  const [width, height] = sizeStr.split('x').map(Number);
  const steps = parseInt(document.getElementById('comfy-steps').value);
  const seedStr = document.getElementById('comfy-seed').value.trim();
  const seed = seedStr ? parseInt(seedStr) : 0;

  const btn = document.getElementById('comfy-generate-btn');
  btn.disabled = true;
  btn.textContent = 'Generating...';

  const progress = document.getElementById('comfy-progress');
  const progressText = document.getElementById('comfy-progress-text');
  const progressFill = document.getElementById('comfy-progress-fill');
  const result = document.getElementById('comfy-result');
  progress.style.display = 'block';
  progressText.textContent = 'Queuing generation...';
  progressFill.style.width = '0%';
  result.style.display = 'none';

  try {
    const r = await fetch('/api/comfy/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, width, height, steps, seed }),
    });
    const d = await r.json();
    if (d.error) {
      progressText.innerHTML = `<span style="color:var(--red)">Error: ${d.error}</span>`;
      btn.disabled = false;
      btn.textContent = 'Generate';
      return;
    }

    // Poll for completion
    const promptId = d.prompt_id;
    let elapsed = 0;
    comfyPollTimer = setInterval(async () => {
      elapsed += 1;
      try {
        const pr = await fetch(`/api/comfy/progress/${promptId}`);
        const pd = await pr.json();
        if (pd.done) {
          clearInterval(comfyPollTimer);
          comfyPollTimer = null;
          progressFill.style.width = '100%';
          progressText.textContent = 'Done!';
          if (pd.images && pd.images.length > 0) {
            result.style.display = 'block';
            result.innerHTML = pd.images.map(img => 
              `<img src="${img.url}" alt="" onclick="openComfyImage('${img.url}')" style="width:100%;border-radius:12px;cursor:pointer" />`
            ).join('');
          }
          btn.disabled = false;
          btn.textContent = 'Generate';
          loadComfyGallery();
          loadComfyStatus();
          setTimeout(() => { progress.style.display = 'none'; }, 2000);
        } else {
          progressText.textContent = `Generating... ${elapsed}s${pd.pending > 0 ? ` (${pd.pending} in queue)` : ''}`;
          progressFill.style.width = `${Math.min(90, elapsed * 5)}%`;
        }
      } catch {}
    }, 1000);
  } catch (e) {
    progressText.innerHTML = `<span style="color:var(--red)">Error: ${e.message}</span>`;
    btn.disabled = false;
    btn.textContent = 'Generate';
  }
}

// Refresh ComfyUI status periodically when on that screen
setInterval(() => {
  if (document.getElementById('comfy-screen')?.classList.contains('active')) {
    loadComfyStatus();
  }
}, 5000);

// ─── Long-press to save ─────────────────────────────────
