// ===== Module: lego =====
let legoCurrentPath = '';
let legoViewMode = 'grid';  // 'grid' or 'list'
let legoPage = 1;
let legoHasMore = false;
let legoLoading = false;
let legoAbortController = null;

async function loadLego(path = '', page = 1) {
  // Cancel any in-flight request (user clicked a different folder)
  if (legoAbortController) {
    legoAbortController.abort();
  }
  legoAbortController = new AbortController();

  if (page === 1) {
    legoCurrentPath = path;
    legoPage = 1;
    location.hash = `#lego/${path}`;
  }
  legoLoading = true;
  const list = document.getElementById('lego-list');
  if (page === 1) {
    list.className = 'lego-list';
    list.innerHTML = `<div class="skeleton-file-grid">${Array(12).fill('<div class="shimmer-block skeleton-file"></div>').join('')}</div>`;
  }

  try {
    const r = await fetch(`/api/lego/browse?path=${encodeURIComponent(path)}&page=${page}&per_page=200`, {
      signal: legoAbortController.signal,
    });
    const data = await r.json();
    if (data.error) {
      list.innerHTML = `<span style="color:var(--red);padding:20px;display:block">${data.error}</span>`;
      return;
    }

    // Breadcrumbs (only on first page)
    if (page === 1) {
      const bc = document.getElementById('lego-breadcrumbs');
      bc.innerHTML = data.breadcrumbs.map((b, i) => {
        const isLast = i === data.breadcrumbs.length - 1;
        return `<span class="lego-crumb ${isLast ? 'active' : ''}" onclick="loadLego('${b.path}')">${b.name}</span>${!isLast ? '<span class="lego-crumb-sep">/</span>' : ''}`;
      }).join('') + `<button class="lego-view-toggle" onclick="toggleLegoView()">${legoViewMode === 'grid' ? ICONS.layers : ICONS.terminal}</button>`;
    }

    legoHasMore = data.has_more;
    legoPage = page;

    // Items
    if (data.items.length === 0 && page === 1) {
      list.innerHTML = '<span class="text-dim" style="padding:20px;display:block">Empty folder</span>';
      return;
    }

    list.className = legoViewMode === 'grid' ? 'lego-list lego-grid' : 'lego-list';

    const IMAGE_EXTS = ['jpg','jpeg','png','gif','webp','bmp','heic','heif'];
    const newHTML = data.items.map(item => {
      const isImage = IMAGE_EXTS.includes(item.ext);

      if (item.is_dir) {
        const countLabel = item.child_count === -1 ? '...' : (item.child_count > 0 ? `${item.child_count} items` : 'Empty');
        const thumb = item.has_images
          ? `<img class="lego-thumb" data-src="/api/lego/thumbnail?path=${encodeURIComponent(item.path)}" alt="" loading="lazy" />`
          : `<div class="lego-thumb-placeholder"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></div>`;
        return `<div class="lego-card" data-path="${item.path.replace(/"/g, '&quot;')}" onclick="if(!legoLoading)loadLego('${item.path.replace(/'/g, "\\'")}')">
          <div class="lego-thumb-wrap">${thumb}${item.has_images ? '<div class="lego-thumb-badge"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></div>' : ''}</div>
          <div class="lego-card-info">
            <div class="lego-card-name">${item.name}</div>
            <div class="lego-card-meta" id="meta-${CSS.escape(item.path)}">${countLabel}</div>
          </div>
        </div>`;
      } else {
        const clickAction = isImage
          ? `openLegoImage('${item.path}')`
          : `downloadLegoFile('${item.path}')`;
        const thumb = isImage
          ? `<img class="lego-thumb" data-src="/api/lego/thumbnail?path=${encodeURIComponent(item.path)}" alt="" loading="lazy" />`
          : `<div class="lego-thumb-placeholder">${getLegoIcon(item.ext)}</div>`;
        return `<div class="lego-card" data-path="${item.path.replace(/"/g, '&quot;')}" onclick="${clickAction}">
          <div class="lego-thumb-wrap">${thumb}</div>
          <div class="lego-card-info">
            <div class="lego-card-name">${item.name}</div>
            <div class="lego-card-meta">${item.size_human || ''}</div>
          </div>
        </div>`;
      }
    }).join('');

    if (page === 1) {
      list.innerHTML = newHTML;
    } else {
      list.insertAdjacentHTML('beforeend', newHTML);
    }

    // Add "Load more" indicator if there are more items
    const existingLoader = document.getElementById('lego-load-more');
    if (existingLoader) existingLoader.remove();
    if (data.has_more) {
      const total = data.item_count;
      const loaded = page * 200;
      const loader = document.createElement('div');
      loader.id = 'lego-load-more';
      loader.className = 'lego-load-more';
      loader.style.cursor = 'pointer';
      loader.innerHTML = `<div class="lego-load-more-text">Tap to load more — ${loaded} / ${total}</div><div class="lego-load-more-bar"><div class="lego-load-more-fill" style="width:${Math.min(100, (loaded/total)*100)}%"></div></div>`;
      loader.onclick = () => { if (!legoLoading && legoHasMore) loadLego(legoCurrentPath, legoPage + 1); };
      list.appendChild(loader);
    }

    // Lazy load visible thumbnails
    legoLazyLoad();
    setupLegoLazyLoad();

    // Lazy load folder info for directories (non-blocking)
    data.items.filter(i => i.is_dir && i.child_count === -1).forEach(dir => {
      fetch(`/api/lego/folder_info?path=${encodeURIComponent(dir.path)}`)
        .then(r => r.json())
        .then(info => {
          const metaEl = document.getElementById(`meta-${CSS.escape(dir.path)}`);
          if (metaEl) {
            metaEl.textContent = info.child_count > 0 ? `${info.child_count} items` : 'Empty';
          }
          if (info.has_images) {
            const card = metaEl?.closest('.lego-card');
            const thumbWrap = card?.querySelector('.lego-thumb-wrap');
            const placeholder = thumbWrap?.querySelector('.lego-thumb-placeholder');
            if (placeholder) {
              const img = document.createElement('img');
              img.className = 'lego-thumb';
              img.src = `/api/lego/thumbnail?path=${encodeURIComponent(dir.path)}`;
              img.alt = '';
              img.loading = 'lazy';
              placeholder.replaceWith(img);
              const badge = document.createElement('div');
              badge.className = 'lego-thumb-badge';
              badge.innerHTML = '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
              thumbWrap.appendChild(badge);
            }
          }
        })
        .catch(() => {});
    });
  } catch (e) {
    if (e.name === 'AbortError') return;  // user navigated away, ignore
    list.innerHTML = `<span style="color:var(--red);padding:20px;display:block">Error: ${e.message}</span>`;
  } finally {
    legoLoading = false;
    legoAbortController = null;
  }
}

// Infinite scroll — load more when user reaches the bottom
function legoScrollCheck() {
  if (legoLoading || !legoHasMore) return;
  const loader = document.getElementById('lego-load-more');
  if (!loader) return;
  const rect = loader.getBoundingClientRect();
  if (rect.top < window.innerHeight + 300) {
    loadLego(legoCurrentPath, legoPage + 1);
  }
}
document.addEventListener('scroll', legoScrollCheck, { passive: true });
const legoListEl = document.getElementById('lego-list');
if (legoListEl) {
  legoListEl.addEventListener('scroll', legoScrollCheck, { passive: true });
}
const legoScrollObserver = new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && !legoLoading && legoHasMore) {
    loadLego(legoCurrentPath, legoPage + 1);
  }
}, { rootMargin: '300px' });
const legoLoaderObserver = new MutationObserver(() => {
  const loader = document.getElementById('lego-load-more');
  if (loader) legoScrollObserver.observe(loader);
});
if (legoListEl) legoLoaderObserver.observe(legoListEl, { childList: true });

function toggleLegoView() {
  legoViewMode = legoViewMode === 'grid' ? 'list' : 'grid';
  loadLego(legoCurrentPath);
}

// Lazy loading using IntersectionObserver
let legoObserver = null;
function setupLegoLazyLoad() {
  if (legoObserver) legoObserver.disconnect();
  legoObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        if (img.dataset.src) {
          img.src = img.dataset.src;
          img.removeAttribute('data-src');
        }
        legoObserver.unobserve(img);
      }
    });
  }, { rootMargin: '200px' });
  document.querySelectorAll('.lego-thumb[data-src]').forEach(img => legoObserver.observe(img));
}

function legoLazyLoad() {
  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll('.lego-thumb[data-src]').forEach(img => {
      img.src = img.dataset.src;
      img.removeAttribute('data-src');
    });
  }
}

function getLegoIcon(ext) {
  var i = ICONS.image;
  var img = 'jpg jpeg png gif webp bmp heic heif'.split(' ');
  var vid = 'mp4 mov avi mkv webm'.split(' ');
  var aud = 'mp3 wav flac ogg m4a aac'.split(' ');
  var doc = 'pdf txt md doc docx'.split(' ');
  var arc = 'zip 7z tar gz rar bz2'.split(' ');
  var bin = 'iso appimage deb exe msi dmg'.split(' ');
  var code = 'py js ts html css json xml yaml yml sh'.split(' ');
  if (img.includes(ext)) i = ICONS.image;
  else if (vid.includes(ext)) i = ICONS.terminal;
  else if (aud.includes(ext)) i = ICONS.music;
  else if (doc.includes(ext)) i = ICONS.book;
  else if (arc.includes(ext)) i = ICONS.layers;
  else if (bin.includes(ext)) i = ICONS.settings;
  else if (code.includes(ext)) i = ICONS.gitCommit;
  else i = ICONS.book;
  return i;
}

function downloadLegoFile(path) {
  const link = document.createElement('a');
  link.href = `/api/lego/download?path=${encodeURIComponent(path)}`;
  link.download = '';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

let legoCurrentImage = '';

function openLegoImage(path) {
  legoCurrentImage = path;
  const viewer = document.getElementById('lego-image-viewer');
  const img = document.getElementById('lego-image-full');
  img.src = `/api/lego/download?path=${encodeURIComponent(path)}`;
  viewer.style.display = 'flex';
}

function closeLegoImage() {
  document.getElementById('lego-image-viewer').style.display = 'none';
  document.getElementById('lego-image-full').src = '';
  legoCurrentImage = '';
}

function advanceLegoImage(direction) {
  const cards = document.querySelectorAll('.lego-card[data-path]');
  const imagePaths = [];
  for (const card of cards) {
    const p = card.getAttribute('data-path') || '';
    if (/\.(jpg|jpeg|png|gif|webp|heic|heif|bmp|tiff?|avif|svg)$/i.test(p)) {
      imagePaths.push(p);
    }
  }
  if (imagePaths.length === 0) { closeLegoImage(); return; }
  const currentIdx = imagePaths.indexOf(legoCurrentImage);
  let nextIdx;
  if (direction === 'next') {
    nextIdx = currentIdx + 1 >= imagePaths.length ? -1 : currentIdx + 1;
  } else {
    nextIdx = currentIdx - 1 < 0 ? -1 : currentIdx - 1;
  }
  if (nextIdx === -1) { closeLegoImage(); return; }
  legoCurrentImage = imagePaths[nextIdx];
  document.getElementById('lego-image-full').src = `/api/lego/download?path=${encodeURIComponent(legoCurrentImage)}`;
}