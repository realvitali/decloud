// ===== Module: lego =====
let legoCurrentPath = '';
let legoViewMode = 'grid';  // 'grid' or 'list'
let legoPage = 1;
let legoHasMore = false;
let legoLoading = false;
let legoAbortController = null;
let legoSortMode = 'default';  // 'default', 'visited-today', 'unvisited-today'

// Track folder visits in localStorage
function getLegoVisits() {
  try { return JSON.parse(localStorage.getItem('lego-visits') || '{}'); } catch { return {}; }
}
function markLegoVisited(path) {
  const visits = getLegoVisits();
  visits[path] = Date.now();
  localStorage.setItem('lego-visits', JSON.stringify(visits));
}
function isVisitedToday(path) {
  const visits = getLegoVisits();
  if (!visits[path]) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return visits[path] >= today.getTime();
}

function formatVisitTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${m}${ampm}`;
}

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
    if (path) markLegoVisited(path);
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
      }).join('') + `<button class="lego-view-toggle" onclick="toggleLegoView()">${legoViewMode === 'grid' ? ICONS.layers : ICONS.terminal}</button><button class="lego-view-toggle" onclick="toggleLegoSort()" style="margin-left:6px" title="Sort: ${legoSortMode}">${legoSortIcon()}</button><button class="lego-view-toggle" onclick="openSwipeMode('${path}')" style="margin-left:6px" title="Swipe mode">${ICONS.image}</button>`;
    }

    legoHasMore = data.has_more;
    legoPage = page;

    // Sort folders by visit status if sort mode is active
    if (legoSortMode !== 'default') {
      data.items.sort((a, b) => {
        // Always keep dirs before files
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        // Only sort directories by visit status
        if (!a.is_dir) return 0;
        const aVisited = isVisitedToday(a.path);
        const bVisited = isVisitedToday(b.path);
        if (legoSortMode === 'unvisited-today') {
          // Unvisited first
          if (aVisited && !bVisited) return 1;
          if (!aVisited && bVisited) return -1;
        } else {
          // Visited first
          if (aVisited && !bVisited) return -1;
          if (!aVisited && bVisited) return 1;
        }
        return 0;
      });
    }

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
        const visited = isVisitedToday(item.path);
        const visitTime = visited ? formatVisitTime(getLegoVisits()[item.path]) : '';
        const visitedDot = visited ? '<div class="lego-visited-dot"></div>' : '';
        const dimClass = (legoSortMode !== 'default' && !visited && legoSortMode === 'visited-today') ? ' lego-card-dim' : '';
        const thumb = item.has_images
          ? `<img class="lego-thumb" data-src="/api/lego/thumbnail?path=${encodeURIComponent(item.path)}" alt="" loading="lazy" />`
          : `<div class="lego-thumb-placeholder"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></div>`;
        return `<div class="lego-card${dimClass}" data-path="${item.path.replace(/"/g, '&quot;')}" onclick="if(!legoLoading)loadLego('${item.path.replace(/'/g, "\\'")}')">
          <div class="lego-thumb-wrap">${thumb}${item.has_images ? '<div class="lego-thumb-badge"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></div>' : ''}${visitedDot}</div>
          <div class="lego-card-info">
            <div class="lego-card-name">${item.name}</div>
            <div class="lego-card-meta" id="meta-${CSS.escape(item.path)}">${visited ? `Done ${visitTime} · ` : ''}${countLabel}</div>
          </div>
        </div>`;
      } else {
        const clickAction = isImage
          ? `openLegoImage('${item.path}')`
          : `downloadLegoFile('${item.path}')`;
        const thumb = isImage
          ? `<img class="lego-thumb" data-src="/api/lego/thumbnail?path=${encodeURIComponent(item.path)}" alt="" loading="lazy" data-save-path="${item.path}" />`
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

    // Add "Mark as Done" button (only on first page, only inside a folder)
    const existingDoneBtn = document.getElementById('lego-mark-done');
    if (existingDoneBtn) existingDoneBtn.remove();
    if (page === 1 && legoCurrentPath && !legoCurrentPath.startsWith('manually done')) {
      const doneBtn = document.createElement('div');
      doneBtn.id = 'lego-mark-done';
      doneBtn.className = 'lego-mark-done';
      doneBtn.innerHTML = 'Mark folder as done';
      doneBtn.onclick = markFolderDone;
      list.appendChild(doneBtn);
      console.log('[Lego] Mark-done button added for:', legoCurrentPath);
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
// Attach to both document and the lego-list container since mobile scrolls inside it
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
// Also check when the lego list itself scrolls
const legoListEl = document.getElementById('lego-list');
if (legoListEl) {
  legoListEl.addEventListener('scroll', legoScrollCheck, { passive: true });
}
// And use IntersectionObserver as a more reliable trigger
const legoScrollObserver = new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && !legoLoading && legoHasMore) {
    loadLego(legoCurrentPath, legoPage + 1);
  }
}, { rootMargin: '300px' });
// Re-observe whenever loader is created
const legoLoaderObserver = new MutationObserver(() => {
  const loader = document.getElementById('lego-load-more');
  if (loader) legoScrollObserver.observe(loader);
});
if (legoListEl) legoLoaderObserver.observe(legoListEl, { childList: true });

function toggleLegoView() {
  legoViewMode = legoViewMode === 'grid' ? 'list' : 'grid';
  loadLego(legoCurrentPath);
}

function legoSortIcon() {
  if (legoSortMode === 'visited-today') return ICONS.check;
  if (legoSortMode === 'unvisited-today') return ICONS.layers;
  return ICONS.clock;
}

function toggleLegoSort() {
  // Cycle: default -> visited-today -> unvisited-today -> default
  if (legoSortMode === 'default') legoSortMode = 'unvisited-today';
  else if (legoSortMode === 'unvisited-today') legoSortMode = 'visited-today';
  else legoSortMode = 'default';
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
  // Fallback for browsers without IntersectionObserver
  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll('.lego-thumb[data-src]').forEach(img => {
      img.src = img.dataset.src;
      img.removeAttribute('data-src');
    });
  }
}

function getLegoIcon(ext) {
  var i = ICONS.image; // default: image/doc icon
  var img = 'jpg jpeg png gif webp bmp heic heif'.split(' ');
  var vid = 'mp4 mov avi mkv webm'.split(' ');
  var aud = 'mp3 wav flac ogg m4a aac'.split(' ');
  var doc = 'pdf txt md doc docx'.split(' ');
  var arc = 'zip 7z tar gz rar bz2'.split(' ');
  var bin = 'iso appimage deb exe msi dmg'.split(' ');
  var code = 'py js ts html css json xml yaml yml sh'.split(' ');
  if (img.includes(ext)) i = ICONS.image;
  else if (vid.includes(ext)) i = ICONS.terminal; // closest: screen-like
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
  // Find all image cards currently in the DOM, advance to next/prev
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
  // Open next image without closing viewer (keeps scroll position, no reload)
  legoCurrentImage = imagePaths[nextIdx];
  document.getElementById('lego-image-full').src = `/api/lego/download?path=${encodeURIComponent(legoCurrentImage)}`;
}

async function shredLegoImage() {
  if (!legoCurrentImage) return;
  if (!confirm('Permanently shred this file?\nThis cannot be undone.')) return;
  try {
    const r = await fetch('/api/lego/shred', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: legoCurrentImage }),
    });
    const d = await r.json();
    if (d.error) { alert(d.error); return; }
    removeLegoCard(legoCurrentImage);
    advanceLegoImage('next');
  } catch (e) {
    alert('Shred failed: ' + e.message);
  }
}

async function poofLegoImage() {
  if (!legoCurrentImage) return;
  try {
    const r = await fetch('/api/lego/poof', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: legoCurrentImage }),
    });
    const d = await r.json();
    if (d.error) { alert(d.error); return; }
    removeLegoCard(legoCurrentImage);
    advanceLegoImage('next');
  } catch (e) {
    alert('Poof failed: ' + e.message);
  }
}

function removeLegoCard(path) {
  // Find the card with matching data-path and remove it
  const cards = document.querySelectorAll('.lego-card');
  for (const card of cards) {
    const cardPath = card.getAttribute('data-path') || '';
    if (cardPath === path || card.getAttribute('onclick')?.includes(path)) {
      card.style.transition = 'opacity 0.2s, transform 0.2s';
      card.style.opacity = '0';
      card.style.transform = 'scale(0.8)';
      setTimeout(() => card.remove(), 200);
      return;
    }
  }
}

async function markFolderDone() {
  if (!legoCurrentPath) return;
  const folderName = legoCurrentPath.split('/').pop();
  if (!confirm(`Mark "${folderName}" as done?\n\nIt will be renamed to "${folderName} (MANUALLY DONE)" and moved into /manually done/`)) return;

  try {
    const r = await fetch('/api/lego/mark_done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: legoCurrentPath }),
    });
    const d = await r.json();
    if (d.error) { alert(d.error); return; }
    // Navigate to parent folder so user sees it's gone
    const parent = legoCurrentPath.split('/').slice(0, -1).join('/');
    loadLego(parent);
  } catch (e) {
    alert('Mark done failed: ' + e.message);
  }
}

// ─── Swipe Mode (Tinder for files) ──────────────────────────
let swipeFolderPath = '';
let swipeCurrentPath = '';
let swipeTotal = 0;
let swipeStartX = 0;
let swipeStartY = 0;
let swipeCurrentX = 0;
let swipeCurrentY = 0;
let swipeDragging = false;
let swipeNextImg = new Image();  // preloaded next image

async function openSwipeMode(path) {
  swipeFolderPath = path || '';
  document.getElementById('lego-swipe').style.display = 'flex';
  document.getElementById('lego-swipe-empty').style.display = 'none';
  document.getElementById('lego-swipe-card').style.display = '';
  await loadNextSwipeImage();
}

function closeSwipeMode() {
  document.getElementById('lego-swipe').style.display = 'none';
  loadLego(legoCurrentPath);
}

async function loadNextSwipeImage() {
  const card = document.getElementById('lego-swipe-card');
  const info = document.getElementById('lego-swipe-info');
  card.className = 'lego-swipe-card';
  card.style.transform = '';
  card.style.opacity = '';

  // Use preloaded image if available (instant swap)
  if (swipeNextImg._path) {
    swipeCurrentPath = swipeNextImg._path;
    swipeTotal = swipeNextImg._total;
    document.getElementById('lego-swipe-img').src = swipeNextImg.src;
    document.getElementById('lego-swipe-card-name').textContent = swipeNextImg._name;
    info.textContent = `${swipeTotal} images left`;
    card.style.display = '';
    document.getElementById('lego-swipe-empty').style.display = 'none';
    const nextPath = swipeNextImg._path;
    swipeNextImg = new Image();  // clear it
    // Start preloading the next one in background
    preloadNextSwipeImage();
    return;
  }

  // No preload ready — fetch one
  info.textContent = 'Loading...';
  try {
    const r = await fetch(`/api/lego/random_image?path=${encodeURIComponent(swipeFolderPath)}`);
    const d = await r.json();
    if (d.error) {
      card.style.display = 'none';
      document.getElementById('lego-swipe-empty').style.display = '';
      info.textContent = 'No images';
      return;
    }
    swipeCurrentPath = d.path;
    swipeTotal = d.total_images;
    document.getElementById('lego-swipe-img').src = `/api/lego/thumbnail?path=${encodeURIComponent(d.path)}`;
    document.getElementById('lego-swipe-card-name').textContent = d.name;
    info.textContent = `${swipeTotal} images left`;
    card.style.display = '';
    document.getElementById('lego-swipe-empty').style.display = 'none';
    preloadNextSwipeImage();
  } catch (e) {
    info.textContent = 'Error: ' + e.message;
  }
}

async function preloadNextSwipeImage() {
  try {
    const r = await fetch(`/api/lego/random_image?path=${encodeURIComponent(swipeFolderPath)}`);
    const d = await r.json();
    if (!d.error) {
      swipeNextImg = new Image();
      swipeNextImg.src = `/api/lego/thumbnail?path=${encodeURIComponent(d.path)}`;
      swipeNextImg._path = d.path;
      swipeNextImg._name = d.name;
      swipeNextImg._total = d.total_images;
    }
  } catch (e) {}
}

async function swipeLeft() {
  if (!swipeCurrentPath) return;
  const card = document.getElementById('lego-swipe-card');
  card.className = 'lego-swipe-card fly-left';
  try {
    await fetch('/api/lego/trash', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: swipeCurrentPath }),
    });
  } catch (e) {}
  swipeCurrentPath = '';
  setTimeout(loadNextSwipeImage, 350);
}

async function swipeRight() {
  if (!swipeCurrentPath) return;
  const card = document.getElementById('lego-swipe-card');
  card.className = 'lego-swipe-card fly-right';
  try {
    await fetch('/api/lego/poof', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: swipeCurrentPath }),
    });
  } catch (e) {}
  swipeCurrentPath = '';
  setTimeout(loadNextSwipeImage, 350);
}

async function swipeShred() {
  if (!swipeCurrentPath) return;
  if (!confirm('Permanently shred this file?\nThis cannot be undone.')) return;
  const card = document.getElementById('lego-swipe-card');
  card.className = 'lego-swipe-card fly-up';
  try {
    await fetch('/api/lego/shred', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: swipeCurrentPath }),
    });
  } catch (e) {}
  swipeCurrentPath = '';
  setTimeout(loadNextSwipeImage, 350);
}

// Touch/drag gestures on the card
(function() {
  const card = document.getElementById('lego-swipe-card');
  if (!card) return;

  function onStart(e) {
    if (!swipeCurrentPath) return;
    swipeDragging = true;
    card.classList.add('swiping');
    const t = e.touches ? e.touches[0] : e;
    swipeStartX = t.clientX;
    swipeStartY = t.clientY;
    swipeCurrentX = 0;
    swipeCurrentY = 0;
  }

  function onMove(e) {
    if (!swipeDragging) return;
    e.preventDefault();
    const t = e.touches ? e.touches[0] : e;
    swipeCurrentX = t.clientX - swipeStartX;
    swipeCurrentY = t.clientY - swipeStartY;
    const rot = swipeCurrentX / 20;
    card.style.transform = `translate(${swipeCurrentX}px, ${swipeCurrentY * 0.3}px) rotate(${rot}deg)`;

    // Show hints based on drag direction
    const hintLeft = document.getElementById('lego-swipe-hint-left');
    const hintRight = document.getElementById('lego-swipe-hint-right');
    if (swipeCurrentX < -40) {
      hintLeft.style.opacity = Math.min(1, Math.abs(swipeCurrentX) / 100);
    } else {
      hintLeft.style.opacity = 0;
    }
    if (swipeCurrentX > 40) {
      hintRight.style.opacity = Math.min(1, swipeCurrentX / 100);
    } else {
      hintRight.style.opacity = 0;
    }
  }

  function onEnd(e) {
    if (!swipeDragging) return;
    swipeDragging = false;
    card.classList.remove('swiping');
    document.getElementById('lego-swipe-hint-left').style.opacity = 0;
    document.getElementById('lego-swipe-hint-right').style.opacity = 0;

    if (swipeCurrentX < -120) {
      swipeLeft();
    } else if (swipeCurrentX > 120) {
      swipeRight();
    } else {
      // Snap back
      card.style.transform = '';
    }
  }

  card.addEventListener('touchstart', onStart, { passive: true });
  card.addEventListener('touchmove', onMove, { passive: false });
  card.addEventListener('touchend', onEnd);
  card.addEventListener('mousedown', onStart);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onEnd);
})();

// ─── Terminal ───────────────────────────────────────────
