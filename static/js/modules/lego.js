// ===== Module: lego — the Files app (a plain file browser) =====
// Browse, sort, filter, open, download, upload, new folder, rename, delete (to the
// computer's trash). Buttons carry data-act="…"; one listener below handles them.
let legoCurrentPath = '';
let legoViewMode = 'grid';  // 'grid' or 'list'
let legoPage = 1;
let legoHasMore = false;
let legoLoading = false;
let legoAbortController = null;
let legoSort = { by: 'name', desc: false };
let legoFilter = '';
let legoItems = [];          // everything loaded for the current folder

const LEGO_IMAGE = /\.(jpg|jpeg|png|gif|webp|heic|heif|bmp|avif)$/i;
const legoApi = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async r => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
  .catch(() => ({ ok: false, data: { error: 'Network error' } }));

async function loadLego(path = '', page = 1) {
  if (legoAbortController) legoAbortController.abort();   // user clicked another folder
  legoAbortController = new AbortController();
  if (page === 1) {
    legoCurrentPath = path;
    legoPage = 1;
    legoItems = [];
    location.hash = `#lego/${path}`;
  }
  legoLoading = true;
  const list = document.getElementById('lego-list');
  if (page === 1) {
    list.className = 'lego-list';
    list.innerHTML = `<div class="skeleton-file-grid">${Array(12).fill('<div class="shimmer-block skeleton-file"></div>').join('')}</div>`;
  }
  try {
    const q = new URLSearchParams({ path, page, per_page: 200, sort: legoSort.by, order: legoSort.desc ? 'desc' : 'asc' });
    const r = await fetch(`/api/lego/browse?${q}`, { signal: legoAbortController.signal });
    const data = await r.json();
    if (data.error) {
      list.innerHTML = `<span style="color:var(--red);padding:20px;display:block">${escapeHtml(data.error)}</span>`;
      return;
    }
    if (page === 1) legoRenderBar(data.breadcrumbs);
    legoHasMore = data.has_more;
    legoPage = page;
    legoItems = page === 1 ? data.items : legoItems.concat(data.items);
    legoRenderItems(data.item_count);
  } catch (e) {
    if (e.name === 'AbortError') return;
    list.innerHTML = `<span style="color:var(--red);padding:20px;display:block">${escapeHtml(friendlyError(e))}</span>`;
  } finally {
    legoLoading = false;
    legoAbortController = null;
  }
}

function legoRenderBar(breadcrumbs) {
  const bc = document.getElementById('lego-breadcrumbs');
  bc.innerHTML = breadcrumbs.map((b, i) => {
    const last = i === breadcrumbs.length - 1;
    return `<span class="lego-crumb ${last ? 'active' : ''}" data-act="open-folder" data-path="${escapeHtml(b.path)}">${escapeHtml(b.name)}</span>${last ? '' : '<span class="lego-crumb-sep">/</span>'}`;
  }).join('');
  const sortLabel = { name: 'Name', date: 'Date', size: 'Size' };
  document.getElementById('lego-toolbar').innerHTML = `
    <button class="lego-tool" data-act="upload" title="Upload files">${LEGO_SVG.upload}<span>Upload</span></button>
    <button class="lego-tool" data-act="new-folder" title="New folder">${LEGO_SVG.folderPlus}<span>New folder</span></button>
    <input class="lego-filter" id="lego-filter" type="search" placeholder="Filter this folder" value="${escapeHtml(legoFilter)}" aria-label="Filter this folder" autocomplete="off">
    <select class="lego-sort" id="lego-sort" aria-label="Sort by">${Object.entries(sortLabel).map(([k, v]) => `<option value="${k}"${legoSort.by === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
    <button class="lego-tool icon" data-act="sort-order" title="${legoSort.desc ? 'Descending' : 'Ascending'}" aria-label="Sort order">${legoSort.desc ? LEGO_SVG.down : LEGO_SVG.up}</button>
    <button class="lego-tool icon" data-act="view" title="${legoViewMode === 'grid' ? 'Show as list' : 'Show as grid'}" aria-label="Change view">${legoViewMode === 'grid' ? LEGO_SVG.list : LEGO_SVG.grid}</button>`;
}

function legoRenderItems(total) {
  const list = document.getElementById('lego-list');
  const f = legoFilter.trim().toLowerCase();
  const items = f ? legoItems.filter(i => i.name.toLowerCase().includes(f)) : legoItems;
  if (!items.length) {
    list.className = 'lego-list';
    list.innerHTML = `<span class="text-dim" style="padding:20px;display:block">${f ? 'Nothing here matches that filter.' : 'Empty folder. Drop files here or use Upload.'}</span>`;
    return;
  }
  list.className = legoViewMode === 'grid' ? 'lego-list lego-grid' : 'lego-list';
  list.innerHTML = items.map(item => {
    const isImage = !item.is_dir && LEGO_IMAGE.test(item.name);
    const meta = item.is_dir
      ? `<span id="meta-${encodeURIComponent(item.path)}">${item.child_count === -1 ? '…' : item.child_count > 0 ? `${item.child_count} items` : 'Empty'}</span>`
      : `${escapeHtml(item.size_human || '')}${item.modified && legoViewMode !== 'grid' ? ' · ' + escapeHtml(item.modified) : ''}`;   // grid: size only
    const thumb = item.is_dir
      ? `<svg class="lego-folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`
      : isImage ? `<img class="lego-thumb" data-src="/api/lego/thumbnail?path=${encodeURIComponent(item.path)}" alt="" loading="lazy">`
      : `<div class="lego-thumb-placeholder">${getLegoIcon(item.ext)}</div>`;
    return `<div class="lego-card${item.is_dir ? ' lego-folder' : ''}" data-act="${item.is_dir ? 'open-folder' : isImage ? 'open-image' : 'download'}" data-path="${escapeHtml(item.path)}" data-name="${escapeHtml(item.name)}" data-dir="${item.is_dir ? 1 : 0}" tabindex="0">
      <div class="lego-thumb-wrap">${thumb}</div>
      <div class="lego-card-info"><div class="lego-card-name">${escapeHtml(item.name)}</div><div class="lego-card-meta">${meta}</div></div>
      <button class="lego-more" data-act="menu" aria-label="More for ${escapeHtml(item.name)}" title="More">${LEGO_SVG.more}</button>
    </div>`;
  }).join('');
  if (legoHasMore && !f) {
    list.insertAdjacentHTML('beforeend', `<div id="lego-load-more" class="lego-load-more" data-act="load-more"><div class="lego-load-more-text">Load more — ${legoItems.length} / ${total}</div></div>`);
    legoScrollObserver.observe(document.getElementById('lego-load-more'));
  }
  legoLazyLoad();
  setupLegoLazyLoad();
  items.filter(i => i.is_dir && i.child_count === -1).forEach(dir => {   // folder counts, without blocking the list
    fetch(`/api/lego/folder_info?path=${encodeURIComponent(dir.path)}`).then(r => r.json()).then(info => {
      dir.child_count = info.child_count;
      const el = document.getElementById(`meta-${encodeURIComponent(dir.path)}`);
      if (el) el.textContent = info.child_count > 0 ? `${info.child_count} items` : 'Empty';
    }).catch(() => {});
  });
}

const legoScrollObserver = new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && !legoLoading && legoHasMore) loadLego(legoCurrentPath, legoPage + 1);
}, { rootMargin: '300px' });

// ── Thumbnails load as they scroll into view ──
let legoObserver = null;
function setupLegoLazyLoad() {
  if (legoObserver) legoObserver.disconnect();
  legoObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const img = entry.target;
      if (img.dataset.src) { img.src = img.dataset.src; img.removeAttribute('data-src'); }
      legoObserver.unobserve(img);
    });
  }, { rootMargin: '200px' });
  document.querySelectorAll('.lego-thumb[data-src]').forEach(img => legoObserver.observe(img));
}
function legoLazyLoad() {
  if ('IntersectionObserver' in window) return;
  document.querySelectorAll('.lego-thumb[data-src]').forEach(img => { img.src = img.dataset.src; img.removeAttribute('data-src'); });
}

function getLegoIcon(ext) {
  const has = (list) => list.split(' ').includes(ext);
  if (has('jpg jpeg png gif webp bmp heic heif')) return ICONS.image;
  if (has('mp4 mov avi mkv webm')) return ICONS.terminal;
  if (has('mp3 wav flac ogg m4a aac')) return ICONS.music;
  if (has('zip 7z tar gz rar bz2')) return ICONS.layers;
  if (has('iso appimage deb exe msi dmg')) return ICONS.settings;
  if (has('py js ts html css json xml yaml yml sh')) return ICONS.gitCommit;
  return ICONS.book;
}

function downloadLegoFile(path) {
  const link = document.createElement('a');
  link.href = `/api/lego/download?path=${encodeURIComponent(path)}`;
  link.download = '';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

// ── Image viewer: previous / next, download, delete ──
let legoCurrentImage = '';
function openLegoImage(path) {
  legoCurrentImage = path;
  document.getElementById('lego-image-full').src = `/api/lego/download?path=${encodeURIComponent(path)}`;
  document.getElementById('lego-image-viewer').style.display = 'flex';
}
function closeLegoImage() {
  document.getElementById('lego-image-viewer').style.display = 'none';
  document.getElementById('lego-image-full').src = '';
  legoCurrentImage = '';
}
function advanceLegoImage(step) {
  const images = [...document.querySelectorAll('.lego-card[data-act="open-image"]')].map(c => c.dataset.path);
  const i = images.indexOf(legoCurrentImage) + step;
  if (i < 0 || i >= images.length) return;
  openLegoImage(images[i]);
}

// ── Actions ──
async function legoNewFolder() {
  const name = (await appPrompt('New folder name'))?.trim();
  if (!name) return;
  const { ok, data } = await legoApi('/api/files/mkdir', { path: legoCurrentPath, name });
  if (!ok) return showToast(data.error || 'Could not create the folder.');
  loadLego(legoCurrentPath);
}

async function legoRename(path, oldName) {
  const name = (await appPrompt('Rename to', oldName))?.trim();
  if (!name || name === oldName) return;
  const { ok, data } = await legoApi('/api/files/rename', { path, name });
  if (!ok) return showToast(data.error || 'Could not rename it.');
  loadLego(legoCurrentPath);
}

async function legoDelete(path, name) {
  if (!await appConfirm(`Move "${name}" to the Trash?`, { ok: 'Move to Trash' })) return false;
  let { ok, data } = await legoApi('/api/files/delete', { paths: [path] });
  if (!ok && data.code === 'NO_TRASH') {
    if (!await appConfirm(`This computer has no Trash. Delete "${name}" forever?`, { ok: 'Delete forever' })) return false;
    ({ ok, data } = await legoApi('/api/files/delete', { paths: [path], permanent: true }));
  }
  if (!ok) { showToast(data.error || 'Could not delete it.'); return false; }
  showToast(data.trash ? `Moved "${name}" to the Trash` : `Deleted "${name}"`);
  legoItems = legoItems.filter(i => i.path !== path);
  legoRenderItems(legoItems.length);
  return true;
}

function legoUpload(files) {
  if (!files || !files.length) return;
  const form = new FormData();
  form.append('path', legoCurrentPath);
  [...files].forEach(f => form.append('files', f, f.name));
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/files/upload');
  const csrf = sessionStorage.getItem('decloud_csrf');
  if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf);
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) showToast(`Uploading… ${Math.round(e.loaded / e.total * 100)}%`); };
  xhr.onload = () => {
    let d = {};
    try { d = JSON.parse(xhr.responseText); } catch { /* not JSON (e.g. too large) */ }
    if (xhr.status === 413) showToast('That upload is too large (100 MB max per upload).');
    else showToast(xhr.status === 200 ? `Uploaded ${d.saved.length} file${d.saved.length === 1 ? '' : 's'}` : d.error || 'Upload failed.');
    loadLego(legoCurrentPath);
  };
  xhr.onerror = () => showToast('Upload failed.');
  xhr.send(form);
}

function legoMenu(card, btn) {
  document.getElementById('lego-menu')?.remove();
  const dir = card.dataset.dir === '1';
  const m = document.createElement('div');
  m.id = 'lego-menu';
  m.className = 'lego-menu';
  m.setAttribute('role', 'menu');
  m.innerHTML = `${dir ? '' : `<button role="menuitem" data-act="menu-download">Download</button>`}
    <button role="menuitem" data-act="menu-rename">Rename</button>
    <button role="menuitem" data-act="menu-delete" class="danger">Move to Trash</button>`;
  m.dataset.path = card.dataset.path;
  m.dataset.name = card.dataset.name;
  document.body.appendChild(m);
  const r = btn.getBoundingClientRect();
  m.style.top = `${Math.min(window.innerHeight - m.offsetHeight - 8, r.bottom + 4)}px`;
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth))}px`;
  m.querySelector('button').focus();
}

// One listener for everything in Files (no inline handlers)
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !(el.closest('#lego-screen') || el.closest('#lego-menu'))) {
    if (!e.target.closest('#lego-menu')) document.getElementById('lego-menu')?.remove();
    return;
  }
  const act = el.dataset.act, card = el.closest('.lego-card'), menu = el.closest('#lego-menu');
  if (act !== 'menu') document.getElementById('lego-menu')?.remove();
  if (legoLoading && act.startsWith('open')) return;
  switch (act) {
    case 'open-folder': loadLego(el.dataset.path); break;
    case 'open-image': openLegoImage(el.dataset.path); break;
    case 'download': downloadLegoFile(el.dataset.path); break;
    case 'menu': e.stopPropagation(); legoMenu(card, el); break;
    case 'menu-download': downloadLegoFile(menu.dataset.path); break;
    case 'menu-rename': legoRename(menu.dataset.path, menu.dataset.name); break;
    case 'menu-delete': legoDelete(menu.dataset.path, menu.dataset.name); break;
    case 'upload': document.getElementById('lego-upload-input').click(); break;
    case 'new-folder': legoNewFolder(); break;
    case 'sort-order': legoSort.desc = !legoSort.desc; loadLego(legoCurrentPath); break;
    case 'view': legoViewMode = legoViewMode === 'grid' ? 'list' : 'grid'; legoRenderBar(legoBarCrumbs()); legoRenderItems(legoItems.length); break;
    case 'load-more': if (!legoLoading && legoHasMore) loadLego(legoCurrentPath, legoPage + 1); break;
    case 'viewer-close': closeLegoImage(); break;
    case 'viewer-prev': advanceLegoImage(-1); break;
    case 'viewer-next': advanceLegoImage(1); break;
    case 'viewer-download': if (legoCurrentImage) downloadLegoFile(legoCurrentImage); break;
    case 'viewer-delete': {
      const path = legoCurrentImage, name = path.split('/').pop();
      const next = [...document.querySelectorAll('.lego-card[data-act="open-image"]')].map(c => c.dataset.path);
      const after = next[next.indexOf(path) + 1] || next[next.indexOf(path) - 1];
      legoDelete(path, name).then(done => { if (done) { if (after) openLegoImage(after); else closeLegoImage(); } });
      break;
    }
  }
});
const legoBarCrumbs = () => [...document.querySelectorAll('#lego-breadcrumbs .lego-crumb')].map(c => ({ name: c.textContent, path: c.dataset.path }));

document.addEventListener('input', (e) => {
  if (e.target.id === 'lego-filter') { legoFilter = e.target.value; legoRenderItems(legoItems.length); }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'lego-sort') { legoSort.by = e.target.value; loadLego(legoCurrentPath); }
  if (e.target.id === 'lego-upload-input') { legoUpload(e.target.files); e.target.value = ''; }
});
// Capture phase: Escape closes the viewer or menu first, before desktop mode's "Escape = Home"
document.addEventListener('keydown', (e) => {
  const viewerOpen = document.getElementById('lego-image-viewer')?.style.display === 'flex';
  const menu = document.getElementById('lego-menu');
  if (viewerOpen) {
    if (e.key === 'Escape') closeLegoImage();
    else if (e.key === 'ArrowRight') advanceLegoImage(1);
    else if (e.key === 'ArrowLeft') advanceLegoImage(-1);
    else return;
    e.stopImmediatePropagation(); e.preventDefault();
    return;
  }
  if (e.key === 'Escape' && menu) { menu.remove(); e.stopImmediatePropagation(); return; }
  if (e.key === 'Enter' && e.target.classList?.contains('lego-card')) e.target.click();
}, true);
// Drag files onto the list to upload them into the open folder
document.addEventListener('dragover', (e) => { if (e.target.closest?.('#lego-list') && e.dataTransfer?.types.includes('Files')) { e.preventDefault(); document.getElementById('lego-list').classList.add('drop'); } });
document.addEventListener('dragleave', (e) => { if (e.target.id === 'lego-list') e.target.classList.remove('drop'); });
document.addEventListener('drop', (e) => {
  if (!e.target.closest?.('#lego-list')) return;
  e.preventDefault();
  document.getElementById('lego-list').classList.remove('drop');
  legoUpload(e.dataTransfer.files);
});

const LEGO_SVG = (() => {
  const s = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  return {
    upload: s('<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 20h16"/>'),
    folderPlus: s('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6M9 14h6"/>'),
    up: s('<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>'),
    down: s('<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>'),
    list: s('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
    grid: s('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>'),
    more: s('<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>'),
  };
})();
