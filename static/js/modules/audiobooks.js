// ===== Module: audiobooks =====
// ─── Books: Library ────────────────────────────────────────
let libraryBooks = [];
let bookSort = localStorage.getItem('decloud_book_sort') || 'title';

function sortBooks(mode) {
  bookSort = mode;
  localStorage.setItem('decloud_book_sort', mode);
  renderBooks();
}

async function loadBooks() {
  try {
    document.getElementById('book-list').innerHTML = Array(6).fill(
      '<div class="skeleton-book skeleton-book-tile"><div class="shimmer-block skeleton-cover"></div><div class="shimmer-block skeleton-titlename"></div></div>'
    ).join('');
    const r = await fetch('/api/books');
    const books = await r.json();
    if (!r.ok || !Array.isArray(books)) throw new Error((books && books.error) || 'Something went wrong — try again');
    if (!books || books.length === 0) {
      document.getElementById('book-list').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">${ICONS.book}</div>
          <h3>No books yet</h3>
          <p>Put PDF or plain-text (.txt) files in your books folder to get started.</p>
          <p class="empty-hint">To choose a different folder, go to Settings → Paths.</p>
        </div>`;
      return;
    }
    libraryBooks = books;
    const sort = document.getElementById('books-sort');
    if (sort) sort.value = bookSort;
    renderBooks();
  } catch (e) {
    document.getElementById('book-list').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">${ICONS.book}</div>
        <h3>Couldn't load your books</h3>
        <p>${escapeHtml(friendlyError(e))}</p>
        <button class="settings-btn" data-onclick="cb8eb6c3">Retry</button>
      </div>`;
  }
}

function renderBooks() {
    const books = libraryBooks.slice().sort((a, b) => {
      const title = () => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true });
      if (bookSort === 'author') return (a.author ? 0 : 1) - (b.author ? 0 : 1) || (a.author || '').localeCompare(b.author || '', undefined, { sensitivity: 'base' }) || title();
      if (bookSort === 'length') return (a.length_pages == null ? 1 : 0) - (b.length_pages == null ? 1 : 0) || (a.length_pages || 0) - (b.length_pages || 0) || title();
      if (bookSort === 'recent') return (b.last_opened || 0) - (a.last_opened || 0) || title();
      return title();
    });
    document.getElementById('book-list').innerHTML = books.map(b => {
      return `
        <div class="book-tile" role="button" tabindex="0" aria-label="Open ${escapeHtml(b.title)}" title="${escapeHtml(b.title)}" data-id="${escapeHtml(b.id)}" data-title="${escapeHtml(b.title)}" data-author="${escapeHtml(b.author || '')}" data-onclick="c8d6b216" data-onkeydown="k56b336e">
          <div class="book-tile-cover">
            <img src="/api/audio/${encodeURIComponent(b.id)}/cover" alt="" loading="lazy" data-onload="l31e1587" data-onerror="e53397a9">
            <button class="settings-btn book-tile-gear" data-id="${escapeHtml(b.id)}" data-onclick="cf95be22" title="Settings">&#9881;</button>
          </div>
          <div class="book-tile-name">${escapeHtml(b.title)}</div>
        </div>
      `;
    }).join('');
}

// ─── Book State ────────────────────────────────────────────
let currentBook = null;

// Reader state (from PDF text API — may have different/more chapters)
let readerChapters = [];     // [{start, end, title}] from PDF TOC
let readerChapterIdx = 0;
let readerText = '';
let bookmarks = [];
let fontSizeLevel = 1;
let readerPage = 0;
let readerPageCount = 1;
let readerOpenAtEnd = false;
let readerPageCounts = [];
let readerLayoutKey = '';
let readerPaginationToken = 0;
const READER_PAGE_GAP = 40;
let bookmarkPanelOpen = false;

// ─── Server position sync (cross-device resume) ───────────────
let _posPushAt = 0;  // epoch ms of last server push (10s throttle)

function pushServerPosition(section) {
  if (!currentBook) return;
  const now = Date.now();
  if (now - _posPushAt < 10000) return;
  _posPushAt = now;
  fetch(`/api/book/${currentBook}/position`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(section)
  }).catch(() => {});
}

// Audio state (from audio JSON — generated TTS chapters)
let audioData = null;
let player = null;
let audioChapterIdx = 0;
let transcriptWords = [];
let pollInterval = null;
let pollBookId = null;
let isGenerating = false;

// ─── Open Book ────────────────────────────────────────────
async function openBook(bookId, title, author = '') {
  if (player) player.pause();
  currentBook = bookId;
  readerText = '';
  readerLayoutKey = '';
  readerPageCounts = [];
  readerPaginationToken++;
  loadBookmarks();
  document.getElementById('reader-title').textContent = title;
  document.getElementById('reader-author').textContent = author;
  fetch(`/api/book/${encodeURIComponent(bookId)}/position`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opened: true }) }).catch(() => {});
  try {
    const settings = await (await fetch(`/api/book/${encodeURIComponent(bookId)}/settings`)).json();
    fontSizeLevel = Number.isInteger(settings.font_size) ? settings.font_size : 1;
  } catch { fontSizeLevel = 1; }

  // Fetch reader chapters from PDF text API
  try {
    const res = await fetch(`/api/books/text?book=${encodeURIComponent(bookId)}`);
    const data = await res.json();
    readerChapters = data.chapters || [];
  } catch { readerChapters = []; }

  // Fetch audio data
  var hasAudio = false;
  try {
    const audioRes = await fetch(`/api/audio/${bookId}`);
    audioData = await audioRes.json();
    if (audioData.has_audio) {
      player = document.getElementById('audio-player');
      player.removeEventListener('timeupdate', onTimeUpdate);
      player.addEventListener('timeupdate', onTimeUpdate);
      document.getElementById('audio-mode-btn').disabled = false;
      hasAudio = true;
    } else {
      // Check if any chapter MP3s exist even without metadata JSON
      const chaptersRes = await fetch(`/api/book/${bookId}/chapters`);
      const chaptersData = await chaptersRes.json();
      const doneChapters = chaptersData.filter(c => c.status === 'done');
      if (doneChapters.length > 0) {
        audioData = {
          has_audio: true,
          chapters: doneChapters.map(c => ({
            index: c.index,
            title: `Chapter ${c.index + 1}`,
            duration: 0,
            file: c.file,
            text: ''
          })),
          total_chapters: doneChapters.length
        };
        player = document.getElementById('audio-player');
        player.removeEventListener('timeupdate', onTimeUpdate);
        player.addEventListener('timeupdate', onTimeUpdate);
        document.getElementById('audio-mode-btn').disabled = false;
        hasAudio = true;
      } else {
        document.getElementById('audio-mode-btn').disabled = false;
      }
    }
  } catch {
    audioData = null;
    document.getElementById('audio-mode-btn').disabled = false;
  }

  // ── Auto-resume: restore last position by default ──
  var savedAudio = null;
  try { savedAudio = JSON.parse(localStorage.getItem('playback_' + bookId) || 'null'); } catch {}

  var savedReaderBookmark = bookmarks.find(function(b) { return b.isResume; });
  var lastMode = localStorage.getItem('mode_' + bookId) || 'reader';

  // ── Cross-device resume: server position wins if newer than local ──
  // (so a phone and laptop continue from the same spot)
  var localTs = 0;
  if (savedAudio && savedAudio.ts) localTs = savedAudio.ts;
  if (savedReaderBookmark && savedReaderBookmark.ts > localTs) localTs = savedReaderBookmark.ts;
  var serverPos = null;
  try {
    const posRes = await fetch(`/api/book/${bookId}/position`);
    if (posRes.ok) serverPos = await posRes.json();
  } catch {}
  if (serverPos && serverPos.updated && (serverPos.updated * 1000) > localTs) {
    if (serverPos.audio && serverPos.audio.chapter !== undefined && serverPos.audio.time > 5) {
      savedAudio = { chapter: serverPos.audio.chapter, time: serverPos.audio.time, ts: serverPos.updated * 1000 };
      lastMode = serverPos.mode || lastMode;
    }
    if (serverPos.reader && serverPos.reader.chapter !== undefined) {
      savedReaderBookmark = {
        chapter: serverPos.reader.chapter,
        wordIndex: serverPos.reader.word_index || 0,
        isResume: true,
        ts: serverPos.updated * 1000,
      };
    }
  }

  if (hasAudio && savedAudio && savedAudio.chapter !== undefined && savedAudio.time > 5) {
    // Resume audio
    audioChapterIdx = savedAudio.chapter;
    buildChapterDropdown(savedAudio.chapter);
    if (lastMode === 'audio') {
      setReaderMode('audio');
      selectAudioChapter(savedAudio.chapter, savedAudio.time);
      showScreen('reader-screen');
      return;
    }
    // Reader mode but sync chapter to audio position
    readerChapterIdx = Math.min(savedAudio.chapter, readerChapters.length - 1);
  } else if (savedReaderBookmark) {
    // Resume reader from bookmark
    readerChapterIdx = Math.min(savedReaderBookmark.chapter, readerChapters.length - 1);
    audioChapterIdx = readerChapterIdx;
  } else {
    readerChapterIdx = 0;
    audioChapterIdx = 0;
    if (hasAudio) buildChapterDropdown(0);
  }

  setReaderMode('reader');
  loadChapterText(readerChapterIdx);
  showScreen('reader-screen');

  // If book is generating, poll for audio updates so Listen button enables when ready
  try {
    const statusRes = await fetch(`/api/tts/status/${bookId}`);
    const statusData = await statusRes.json();
    if (statusData.status === 'converting') {
      startPolling(bookId);
    }
  } catch {}
}

// ─── E-Reader Mode ───────────────────────────────────────
async function loadChapterText(idx) {
  if (idx < 0 || idx >= readerChapters.length) return;

  const ch = readerChapters[idx];
  document.getElementById('chapter-label').textContent = '…';
  document.getElementById('reader-text').innerHTML = '<div class="pixel-loader-wrap"><div class="pixel-loader"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div></div>';
  document.getElementById('prev-ch-btn').disabled = idx <= 0;
  document.getElementById('next-ch-btn').disabled = idx >= readerChapters.length - 1;

  try {
    const res = await fetch(`/api/books/text?book=${encodeURIComponent(currentBook)}&chapter=${idx}`);
    const data = await res.json();
    if (data.error) {
      document.getElementById('reader-text').innerHTML = `<span style="color:var(--text-dim)">${escapeHtml(data.error)}</span>`;
      return;
    }
    readerText = data.text || '';
    renderReaderText();
  } catch(e) {
    document.getElementById('reader-text').innerHTML = '<span style="color:var(--text-dim)">Failed to load</span>';
  }
}

function renderReaderText() {
  const el = document.getElementById('reader-text');
  if (!readerText) { el.innerHTML = ''; return; }

  const sizes = [14, 16, 18, 20, 24];
  const fs = sizes[fontSizeLevel + 2] || 18;

  const words = readerText.split(/(\s+)/);
  el.innerHTML = words.map((w, i) => {
    if (/^\s+$/.test(w)) return w;
    return `<span class="reader-word" data-idx="${i}" data-onclick="c996e1c8">${escapeHtml(w)}</span>`;
  }).join('');

  el.style.fontSize = fs + 'px';
  el.style.columnWidth = el.clientWidth + 'px';
  requestAnimationFrame(() => {
    // Column edges may round by fractions of a pixel; rounding avoids a
    // phantom extra page when scrollWidth is a few pixels above the total.
    readerPageCount = Math.max(1, Math.round((el.scrollWidth + READER_PAGE_GAP) / (el.clientWidth + READER_PAGE_GAP)));
    const layoutKey = `${currentBook}:${el.clientWidth}:${el.clientHeight}:${fs}`;
    const newLayout = layoutKey !== readerLayoutKey;
    if (newLayout) {
      readerLayoutKey = layoutKey;
      readerPageCounts = Array(readerChapters.length).fill(null);
      readerPaginationToken++;
    }
    readerPageCounts[readerChapterIdx] = readerPageCount;
    const openingAtEnd = readerOpenAtEnd;
    readerPage = readerOpenAtEnd ? readerPageCount - 1 : 0;
    readerOpenAtEnd = false;
    const saved = bookmarks.find(b => b.chapter === readerChapterIdx && b.isResume);
    if (saved && !openingAtEnd) {
      const span = el.querySelector(`[data-idx="${saved.wordIndex}"]`);
      if (span) readerPage = Math.max(0, Math.min(readerPageCount - 1, Math.floor((span.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft) / (el.clientWidth + READER_PAGE_GAP))));
    }
    updateReaderPage();
    if (newLayout && readerChapters.length > 1) countBookPages(el, readerPaginationToken, currentBook);
  });

}

function updateReaderPage() {
  const el = document.getElementById('reader-text');
  el.scrollLeft = readerPage * (el.clientWidth + READER_PAGE_GAP);
  const complete = readerPageCounts.length === readerChapters.length && readerPageCounts.every(n => Number.isInteger(n));
  const page = complete ? readerPageCounts.slice(0, readerChapterIdx).reduce((a, b) => a + b, 0) + readerPage + 1 : readerPage + 1;
  const total = complete ? readerPageCounts.reduce((a, b) => a + b, 0) : readerPageCount;
  const label = document.getElementById('chapter-label');
  label.textContent = complete || readerChapters.length <= 1 ? `${page} / ${total}` : `Chapter ${readerChapterIdx + 1} · ${page} / ${total}`;
  label.title = complete ? 'Page in this book' : 'Page in this chapter; calculating book total';
  document.getElementById('prev-ch-btn').disabled = readerPage === 0 && readerChapterIdx === 0;
  document.getElementById('next-ch-btn').disabled = readerPage >= readerPageCount - 1 && readerChapterIdx >= readerChapters.length - 1;
}

async function countBookPages(reference, token, bookId) {
  const style = getComputedStyle(reference);
  const measure = document.createElement('div');
  Object.assign(measure.style, {
    position: 'fixed', left: '-10000px', top: '0', visibility: 'hidden', overflow: 'hidden',
    width: reference.clientWidth + 'px', height: reference.clientHeight + 'px',
    columnWidth: reference.clientWidth + 'px', columnGap: READER_PAGE_GAP + 'px', columnFill: 'auto',
    fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight,
    lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, whiteSpace: 'pre-wrap', wordBreak: 'break-word'
  });
  document.body.appendChild(measure);
  try {
    for (let i = 0; i < readerChapters.length; i++) {
      if (token !== readerPaginationToken || bookId !== currentBook) return;
      if (readerPageCounts[i] !== null) continue;
      const response = await fetch(`/api/books/text?book=${encodeURIComponent(bookId)}&chapter=${i}`);
      if (!response.ok) return;
      const data = await response.json();
      if (token !== readerPaginationToken || bookId !== currentBook) return;
      // Match the reader's inline word elements so line breaks and column
      // counts are the same as the visible page, including long words.
      measure.innerHTML = (data.text || '').split(/(\s+)/).map(w =>
        /^\s+$/.test(w) ? w : `<span class="reader-word">${escapeHtml(w)}</span>`).join('');
      readerPageCounts[i] = Math.max(1, Math.round((measure.scrollWidth + READER_PAGE_GAP) / (measure.clientWidth + READER_PAGE_GAP)));
      updateReaderPage();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } catch { /* Keep the clearly labeled chapter page count if counting fails. */ }
  finally { measure.remove(); }
}

function turnReaderPage(direction) {
  if (direction < 0 && readerPage === 0 && readerChapterIdx > 0) {
    readerOpenAtEnd = true;
    readerChapterIdx--;
    loadChapterText(readerChapterIdx);
  } else if (direction > 0 && readerPage >= readerPageCount - 1 && readerChapterIdx < readerChapters.length - 1) {
    readerChapterIdx++;
    loadChapterText(readerChapterIdx);
  } else {
    readerPage = Math.max(0, Math.min(readerPageCount - 1, readerPage + direction));
    updateReaderPage();
    saveReaderPosition();
  }
}

// Save reader position as resume bookmark on scroll (debounced)
var _readerScrollTimer = null;
document.addEventListener('scroll', function() {
  var readerEl = document.getElementById('reader-pane');
  if (!readerEl || readerEl.style.display === 'none' || !currentBook) return;
  if (_readerScrollTimer) clearTimeout(_readerScrollTimer);
  _readerScrollTimer = setTimeout(saveReaderPosition, 1000);
}, true);

function saveReaderPosition() {
  if (!currentBook || !readerChapters.length) return;
  var readerEl = document.getElementById('reader-text');
  if (!readerEl) return;
  var spans = readerEl.querySelectorAll('.reader-word');
  var rect = readerEl.getBoundingClientRect();
  var wordIndex = 0;
  for (var i = 0; i < spans.length; i++) {
    var sr = spans[i].getBoundingClientRect();
    if (sr.top >= rect.top && sr.top <= rect.top + 100 && sr.left >= rect.left && sr.left < rect.right) {
      wordIndex = parseInt(spans[i].dataset.idx || 0);
      break;
    }
  }
  // Update or create resume bookmark
  var existing = bookmarks.findIndex(function(b) { return b.isResume; });
  var entry = { chapter: readerChapterIdx, wordIndex: wordIndex, isResume: true, ts: Date.now() };
  if (existing >= 0) bookmarks[existing] = entry;
  else bookmarks.push(entry);
  saveBookmarks();
  // Cross-device resume (throttled to one push per 10s)
  pushServerPosition({ mode: 'reader', reader: { chapter: readerChapterIdx, word_index: wordIndex } });
}

function handleWordTap(span, wordIndex) {
  const word = span.textContent.replace(/[.,!?;:'"()[\]—–-]/g, '').trim();
  if (!word) return;

  const exists = bookmarks.findIndex(b =>
    b.chapter === readerChapterIdx && b.wordIndex === wordIndex && !b.isResume
  );

  if (exists >= 0) {
    bookmarks.splice(exists, 1);
    span.classList.remove('bookmarked');
  } else {
    bookmarks.push({
      word: word.length > 30 ? word.slice(0, 30) + '…' : word,
      chapter: readerChapterIdx,
      wordIndex: wordIndex,
      charOffset: parseInt(span.dataset.idx || 0),
      ts: Date.now(),
      isResume: false
    });
    span.classList.add('bookmarked');
  }

  saveBookmarks();
  updateBookmarkCount();
}

async function setBookFontSize(value) {
  const size = Number(value);
  if (!settingsBookId || !Number.isInteger(size) || size < -2 || size > 2) return;
  const bookId = settingsBookId;
  try {
    const r = await fetch(`/api/book/${encodeURIComponent(bookId)}/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ font_size: size }) });
    if (!r.ok) throw new Error('save failed');
    if (bookId === currentBook) {
      fontSizeLevel = size;
      if (document.getElementById('reader-screen').classList.contains('active')) renderReaderText();
    }
  } catch { showToast('Could not save text size'); }
}

function toggleBookAudio() {
  if (document.getElementById('audio-pane').style.display !== 'none') {
    setReaderMode('reader');
    if (!readerText) loadChapterText(readerChapterIdx);
    return;
  }
  if (!audioData?.has_audio) return openSettingsForBook(currentBook);
  setReaderMode('audio');
}

function setReaderMode(mode) {
  const isReader = mode === 'reader';
  document.getElementById('reader-pane').style.display = isReader ? 'flex' : 'none';
  document.getElementById('audio-pane').style.display = isReader ? 'none' : 'block';
  document.getElementById('reader-mode-btn').classList.toggle('active', isReader);
  document.getElementById('audio-mode-btn').classList.toggle('active', !isReader);

  // Persist last used mode for auto-resume
  if (currentBook) localStorage.setItem('mode_' + currentBook, mode);

  // Show/hide chapter nav (reader uses prev/next, audio uses dropdown)
  document.getElementById('chapter-nav').style.display = isReader ? 'flex' : 'none';

  if (!isReader && audioData?.has_audio) {
    // Switching to audio mode — load current audio chapter
    selectAudioChapter(audioChapterIdx);
  } else if (isReader) {
    // Switching to reader mode — update chapter label
    if (readerChapters.length > 0) requestAnimationFrame(updateReaderPage);
  }
}

function openPrevChapter() {
  if (readerChapterIdx > 0) {
    readerChapterIdx--;
    loadChapterText(readerChapterIdx);
  }
}

function openNextChapter() {
  if (readerChapterIdx < readerChapters.length - 1) {
    readerChapterIdx++;
    loadChapterText(readerChapterIdx);
  }
}

// ─── Bookmarks ────────────────────────────────────────────
function loadBookmarks() {
  try {
    bookmarks = JSON.parse(localStorage.getItem(`bookmarks_${currentBook}`) || '[]');
  } catch { bookmarks = []; }
  updateBookmarkCount();
}

function saveBookmarks() {
  if (!currentBook) return;
  localStorage.setItem(`bookmarks_${currentBook}`, JSON.stringify(bookmarks));
}

function updateBookmarkCount() {
  const count = bookmarks.filter(b => !b.isResume).length;
  const el = document.getElementById('bookmark-count');
  if (el) el.textContent = count || '';
}

let readerResizeTimer;
window.addEventListener('resize', () => {
  if (!currentBook || !readerText || !document.getElementById('reader-screen')?.classList.contains('active') || document.getElementById('reader-pane').style.display === 'none') return;
  clearTimeout(readerResizeTimer);
  readerResizeTimer = setTimeout(() => { saveReaderPosition(); renderReaderText(); }, 200);
});

function toggleBookmarkList() {
  bookmarkPanelOpen = !bookmarkPanelOpen;
  const panel = document.getElementById('bookmark-panel');
  panel.style.display = bookmarkPanelOpen ? 'block' : 'none';
  if (bookmarkPanelOpen) renderBookmarkList();
}

function renderBookmarkList() {
  const container = document.getElementById('bookmark-items');
  const nonResume = bookmarks.filter(b => !b.isResume);

  if (nonResume.length === 0) {
    container.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:12px 0">No bookmarks yet. Tap any word while reading to bookmark it.</div>';
    return;
  }

  container.innerHTML = nonResume.map((b, i) => `
    <div class="bookmark-row">
      <span class="bookmark-word">"${escapeHtml(b.word)}"</span>
      <span class="bookmark-ch">Ch ${b.chapter + 1}</span>
      <button class="bookmark-goto" data-i="${i}" data-onclick="c8363924">Go</button>
      <button class="bookmark-del" data-i="${i}" data-onclick="ca57cb34">✕</button>
    </div>
  `).join('');
}

function gotoBookmark(idx) {
  const b = bookmarks.filter(b => !b.isResume)[idx];
  if (!b) return;
  readerChapterIdx = b.chapter;
  loadChapterText(b.chapter);
  toggleBookmarkList();
  setReaderMode('reader');
}

function deleteBookmark(idx) {
  const nonResume = bookmarks.filter(b => !b.isResume);
  const b = nonResume[idx];
  if (!b) return;
  const realIdx = bookmarks.indexOf(b);
  if (realIdx >= 0) {
    bookmarks.splice(realIdx, 1);
    saveBookmarks();
    renderBookmarkList();
    updateBookmarkCount();
    const el = document.getElementById('reader-text');
    const span = el.querySelector(`[data-idx="${b.wordIndex}"]`);
    if (span) span.classList.remove('bookmarked');
  }
}

// ─── Audio Player ────────────────────────────────────────
function selectAudioChapter(idx, startTime = 0) {
  const chapters = audioData?.chapters || [];
  if (idx < 0 || idx >= chapters.length) return;
  if (!chapters[idx].file) return;

  audioChapterIdx = idx;
  player.src = `/api/audio/${currentBook}/stream/${idx}`;
  player.load();

  if (startTime > 0) {
    player.addEventListener('loadedmetadata', function once() {
      player.removeEventListener('loadedmetadata', once);
      player.currentTime = startTime;
    });
  }
  player.play();
  setBookPlayIcon(true);

  const name = chapters[idx].title || `Chapter ${idx + 1}`;
  document.getElementById('reader-title').textContent = name;
  buildChapterDropdown(idx);
  buildTranscript(chapters[idx]);

  document.getElementById('total-time').textContent = formatTime(chapters[idx]?.duration || 0);
  document.getElementById('current-time').textContent = formatTime(startTime);

  // Update Media Session for lock screen / Dynamic Island
  const coverUrl = `/api/audio/${currentBook}/cover`;
  if (typeof updateMediaSessionBook === 'function') {
    updateMediaSessionBook(currentBook.replace(/_/g, ' '), name, coverUrl);
    setMediaSessionPlaying(true);
  }

  player.onended = () => {
    markChapterDone(idx);
    buildChapterDropdown(idx);
    if (idx < chapters.length - 1) selectAudioChapter(idx + 1);
  };
}

function buildChapterDropdown(activeIdx) {
  const sel = document.getElementById('chapter-dropdown');
  if (!sel || !audioData) return;
  const chapters = audioData.chapters || [];
  const completed = JSON.parse(localStorage.getItem(`completed_${currentBook}`) || '[]');
  const saved = JSON.parse(localStorage.getItem(`playback_${currentBook}`) || 'null');

  sel.innerHTML = chapters.map((c, i) => {
    const hasFile = c.file || c.duration > 0;
    const isDone = completed.includes(i) && hasFile;
    const isCurrent = i === activeIdx;
    const pending = !hasFile;
    const num = String(i + 1).padStart(2, '0');
    const title = c.title || `Chapter ${i + 1}`;
    const prefix = isDone ? '\u2713 ' : pending ? '... ' : '';
    const cls = isCurrent ? 'current' : isDone ? 'completed' : '';
    return `<option value="${i}" class="${cls}" ${isCurrent ? 'selected' : ''}>${prefix}${num}. ${escapeHtml(title)}</option>`;
  }).join('');

  // Resume hint
  const hint = document.getElementById('resume-hint');
  if (saved && saved.chapter !== undefined && saved.time > 5) {
    const chTitle = chapters[saved.chapter]?.title || `Ch ${saved.chapter + 1}`;
    const t = formatTime(saved.time);
    hint.textContent = `Resume: ${chTitle} at ${t}`;
    hint.style.display = 'block';
    hint.style.cursor = 'pointer';
    hint.onclick = () => selectAudioChapter(saved.chapter, saved.time);
  } else {
    hint.style.display = 'none';
  }
}

function onChapterDropdownChange(val) {
  const idx = parseInt(val);
  if (!isNaN(idx)) selectAudioChapter(idx);
}

// ─── Transcript with real-time word highlighting ────────
function buildTranscript(chapter) {
  const box = document.getElementById('transcript-text');
  const text = chapter?.text || '';
  if (!text) {
    box.textContent = 'No transcript available for this chapter.';
    transcriptWords = [];
    return;
  }

  const duration = chapter?.duration || 1;
  const tokens = text.split(/(\s+)/);
  const words = [];

  // Build a weight for each word: char count + pause for trailing punctuation
  // TTS pauses ~0.3s after commas, ~0.6s after periods/colons, ~0.8s after newlines
  const weights = [];
  let totalWeight = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (/^\s+$/.test(tokens[i])) continue;
    const w = tokens[i];
    let weight = w.length + 1; // base: chars + small overhead
    // Look at the word + next token for punctuation
    const nextTok = tokens[i + 1] || '';
    const wordAndNext = w + nextTok;
    if (/[.!?;:]/.test(wordAndNext)) weight += 8;   // sentence end pause
    else if (/[,—–]/.test(wordAndNext)) weight += 4; // comma pause
    if (/\n/.test(nextTok)) weight += 6;             // paragraph break
    weights.push(weight);
    totalWeight += weight;
  }

  // Assign timestamps using weighted distribution
  let wordIdx = 0;
  let elapsed = 0;
  box.innerHTML = tokens.map((t, i) => {
    if (/^\s+$/.test(t)) return t;
    const w = weights[wordIdx];
    const start = (elapsed / totalWeight) * duration;
    elapsed += w;
    const end = (elapsed / totalWeight) * duration;
    words.push({ idx: i, start, end });
    wordIdx++;
    return `<span class="tw" id="tw-${i}">${escapeHtml(t)}</span>`;
  }).join('');

  transcriptWords = words;
}

function onTimeUpdate() {
  if (!player || !player.duration) return;
  const t = player.currentTime;

  // Progress bar
  const pct = (t / player.duration) * 100;
  const fill = document.getElementById('progress-fill');
  if (fill) fill.style.width = pct + '%';
  document.getElementById('current-time').textContent = formatTime(t);
  document.getElementById('total-time').textContent = formatTime(player.duration);

  // Save position every 5 seconds
  if (Math.floor(t) % 5 === 0 && Math.floor(t) > 0) {
    localStorage.setItem(`playback_${currentBook}`, JSON.stringify({
      chapter: audioChapterIdx,
      time: t,
      ts: Date.now()
    }));
    // Cross-device resume (throttled to one push per 10s)
    pushServerPosition({ mode: 'audio', audio: { chapter: audioChapterIdx, time: Math.round(t) } });
    // Update lock screen progress bar
    if (typeof updateMediaSessionPosition === 'function') updateMediaSessionPosition();
  }

  // Highlight current word (lag slightly behind to match TTS)
  if (transcriptWords.length === 0) return;

  // Offset by -0.15s so highlight trails the audio slightly
  const searchTime = t - 0.15;

  let lo = 0, hi = transcriptWords.length - 1, active = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (searchTime >= transcriptWords[mid].start) {
      active = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (active < 0) return;

  const activeTokenIdx = transcriptWords[active].idx;
  const el = document.getElementById(`tw-${activeTokenIdx}`);
  if (!el) return;

  const box = document.getElementById('transcript-box');
  const prevActive = box.querySelector('.tw.active');
  if (prevActive && prevActive.id === `tw-${activeTokenIdx}`) return;

  if (prevActive) {
    prevActive.classList.remove('active');
    prevActive.classList.add('spoken');
  }
  el.classList.add('active');

  // Auto-scroll only when word is out of view
  const boxRect = box.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const margin = 60;
  if (elRect.top < boxRect.top + margin || elRect.bottom > boxRect.bottom - margin) {
    const scrollTarget = el.offsetTop - box.offsetTop - box.clientHeight / 3;
    box.scrollTo({ top: Math.max(0, scrollTarget), behavior: 'smooth' });
  }
}

const PLAY_SVG = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';

function setBookPlayIcon(playing) {
  var btn = document.getElementById('play-btn');
  if (btn) btn.innerHTML = playing ? PAUSE_SVG : PLAY_SVG;
}

function togglePlay() {
  if (!player) return;
  if (player.paused) { player.play(); setBookPlayIcon(true); if (typeof setMediaSessionPlaying === 'function') setMediaSessionPlaying(true); }
  else { player.pause(); setBookPlayIcon(false); if (typeof setMediaSessionPlaying === 'function') setMediaSessionPlaying(false); }
}

function prevChapter() {
  if (audioChapterIdx > 0) selectAudioChapter(audioChapterIdx - 1);
}
function nextChapter() {
  if (audioData && audioChapterIdx < audioData.chapters.length - 1) {
    selectAudioChapter(audioChapterIdx + 1);
  }
}

function markChapterDone(idx) {
  const key = `completed_${currentBook}`;
  const completed = JSON.parse(localStorage.getItem(key) || '[]');
  if (!completed.includes(idx)) { completed.push(idx); localStorage.setItem(key, JSON.stringify(completed)); }
}

function seekTo(event) {
  if (!player || !player.duration) return;
  const bar = document.getElementById('progress-bar');
  const rect = bar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  player.currentTime = pct * player.duration;
  onTimeUpdate();
}

function formatTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Generation Banner ───────────────────────────────────
function setupPlayer() {
  player = document.getElementById('audio-player');
  player.removeEventListener('timeupdate', onTimeUpdate);
  player.addEventListener('timeupdate', onTimeUpdate);
  document.getElementById('audio-mode-btn').disabled = false;
}

function renderAudioGeneration(status, bookId) {
  if (settingsBookId !== bookId || document.getElementById('settings-modal').style.display === 'none') return;
  const pct = Math.max(0, Math.min(100, Number(status.progress) || 0));
  const progress = document.getElementById('book-gen-progress');
  progress.setAttribute('aria-valuenow', pct);
  document.getElementById('book-gen-progress-fill').style.width = pct + '%';
  const message = document.getElementById('gen-status');
  const controls = document.getElementById('gen-controls');
  if (status.status === 'converting') {
    const seconds = status.eta_seconds;
    let eta = 'estimating time remaining';
    if (Number.isFinite(seconds) && seconds >= 0) {
      const minutes = Math.ceil(seconds / 60);
      eta = minutes < 1 ? 'less than a minute left' : minutes < 60 ? `about ${minutes} min left` : `about ${Math.floor(minutes / 60)} hr ${minutes % 60} min left`;
    }
    message.textContent = `${pct}% audio generated · ${eta}`;
    controls.innerHTML = '<button class="gen-btn stop" data-onclick="c630dcea">Stop</button>';
  } else if (status.status === 'ready') {
    message.textContent = '100% audio generated';
    controls.innerHTML = '<button class="gen-btn" data-onclick="cdd807b4">Regenerate audio</button>';
  } else {
    message.textContent = status.status === 'error' ? 'Audio generation stopped or failed' : '0% audio generated';
    controls.innerHTML = '<button class="gen-btn" data-onclick="cdd807b4">Generate audio</button>';
  }
}

async function startPolling(bookId) {
  if (pollInterval) clearInterval(pollInterval);
  pollBookId = bookId;
  isGenerating = true;

  const tick = async () => {
    let d;
    try {
      const r = await fetch(`/api/tts/status/${encodeURIComponent(bookId)}`);
      d = await r.json();
    } catch (e) { return; }  // transient — try again next tick

    if (pollBookId !== bookId) return;
    renderAudioGeneration(d, bookId);
    if (d.status === 'ready') {
      clearInterval(pollInterval);
      isGenerating = false;
      pollInterval = null;
      pollBookId = null;
      loadBooks();
      if (currentBook === bookId) {
        const audioRes = await fetch(`/api/audio/${encodeURIComponent(bookId)}`);
        audioData = await audioRes.json();
        if (audioData?.has_audio) {
          setupPlayer();
          buildChapterDropdown(audioChapterIdx);
        }
      }
    } else if (d.status !== 'converting') {
      clearInterval(pollInterval);
      isGenerating = false;
      pollInterval = null;
      pollBookId = null;
      if (d.status === 'error') {
        showToast("Audio generation stopped: " + (d.error || 'something went wrong — try again'));
        loadBooks();
      }
    }
  };
  pollInterval = setInterval(tick, 4000);
  tick();
}

// ─── Settings Modal ─────────────────────────────────────
let settingsBookId = null;

async function openSettingsForBook(bookId) {
  settingsBookId = bookId;
  const modal = document.getElementById('settings-modal');
  modal.style.display = 'flex';

  // Load voices
  const [voicesRes, settingsRes, statusRes] = await Promise.all([
    fetch('/api/voices'),
    fetch(`/api/book/${bookId}/settings`),
    fetch(`/api/tts/status/${bookId}`)
  ]);

  const [voices, settings, status] = await Promise.all([
    voicesRes.json(), settingsRes.json(), statusRes.json()
  ]);

  if (settingsBookId !== bookId) return;
  const bookTitle = bookId.replace(/_/g, ' ');
  document.getElementById('settings-book-title').textContent = bookTitle;
  document.getElementById('book-font-size').value = Number.isInteger(settings.font_size) ? settings.font_size : 1;

  // ── Voice Grid ──
  const voiceGrid = document.getElementById('voice-grid');
  voiceGrid.innerHTML = voices.map(v => {
    const isActive = settings.voice === v.id;
    return `
      <div class="voice-card ${isActive ? 'selected' : ''}" data-id="${escapeHtml(v.id)}" data-onclick="cfddb0ac" id="voice-${escapeHtml(v.id)}">
        <div class="voice-icon">${v.gender === 'male' ? '♂' : '♀'}</div>
        <div class="voice-name">${escapeHtml(v.name)}</div>
        ${isActive ? '<div class="voice-active-badge">Active</div>' : ''}
      </div>
    `;
  }).join('');

  renderAudioGeneration(status, bookId);
  if (status.status === 'converting' && pollBookId !== bookId) startPolling(bookId);

  // ── Preview ──
  document.getElementById('settings-preview-voice').textContent =
    `Current: ${settings.voice || 'default'}`;
}

function getChapterName(idx) {
  if (!audioData?.chapters?.[idx]?.title) return '';
  return audioData.chapters[idx].title;
}

async function selectVoice(voiceId) {
  await fetch(`/api/book/${settingsBookId}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice: voiceId })
  });
  document.querySelectorAll('.voice-card').forEach(c => {
    c.classList.remove('selected');
    const badge = c.querySelector('.voice-active-badge');
    if (badge) badge.remove();
  });
  const card = document.getElementById(`voice-${voiceId}`);
  card?.classList.add('selected');
  card?.insertAdjacentHTML('beforeend', '<div class="voice-active-badge">Active</div>');
  document.getElementById('settings-preview-voice').textContent = `Current: ${voiceId}`;
}

function closeSettings() {
  document.getElementById('settings-modal').style.display = 'none';
  settingsBookId = null;
}

async function startGeneration() {
  if (!settingsBookId) return;
  const bookId = settingsBookId;
  const button = document.querySelector('#gen-controls button');
  if (button) button.disabled = true;
  let r, d;
  try {
    r = await fetch(`/api/tts/start/${encodeURIComponent(bookId)}`, { method: 'POST' });
    d = await r.json();
  } catch (e) { if (button) button.disabled = false; showToast(friendlyError(e)); return; }
  if (!r.ok || d.error) { if (button) button.disabled = false; showToast(d.error || 'Could not start audio generation'); return; }
  if (d.status === 'started') {
    renderAudioGeneration({ status: 'converting', progress: 0, eta_seconds: null }, bookId);
    startPolling(bookId);
    loadBooks();
  }
}

async function stopGeneration() {
  if (!settingsBookId) return;
  const bookId = settingsBookId;
  try {
    const response = await fetch(`/api/tts/stop/${encodeURIComponent(bookId)}`, { method: 'POST' });
    if (!response.ok) throw new Error('Could not stop audio generation');
    if (pollBookId === bookId && pollInterval) { clearInterval(pollInterval); isGenerating = false; pollInterval = null; pollBookId = null; }
    renderAudioGeneration({ status: 'error', progress: 0 }, bookId);
    loadBooks();
  } catch (e) { showToast(friendlyError(e)); }
}

async function previewVoice() {
  if (!settingsBookId) return;
  const chaptersRes = await fetch(`/api/book/${settingsBookId}/chapters`);
  const chapters = await chaptersRes.json();
  const firstAudio = chapters.find(c => c.status === 'done');
  if (firstAudio) {
    const player = document.getElementById('preview-player');
    player.src = `/api/audio/${encodeURIComponent(settingsBookId)}/stream/${firstAudio.index}`;
    player.play();
  } else {
    document.getElementById('settings-preview-voice').textContent =
      'Generate audio first to preview';
  }
}

function openSettings() {
  if (currentBook) openSettingsForBook(currentBook);
}

// Close modal on outside click
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal')) closeSettings();
});

// ─── Summary & Q&A ────────────────────────────────────────
let summaryData = null;  // {chapter_summary, sofar_summary, chapter_title, chapter_idx}
let summaryActiveTab = 'chapter';

function getCurrentReadingPosition() {
  // Returns {chapter_idx, word_index} for current reading position
  if (audioData?.has_audio && player && !player.paused) {
    // Audio mode: estimate word index from playback time
    const chapter = audioData.chapters?.[audioChapterIdx];
    if (chapter && chapter.duration > 0 && player.currentTime > 0) {
      const tokens = (chapter.text || '').split(/\s+/);
      const frac = Math.min(1, player.currentTime / chapter.duration);
      return { chapter_idx: audioChapterIdx, word_index: Math.floor(frac * tokens.length) };
    }
  }
  // Reader mode: find the first visible word in the reader
  const readerEl = document.getElementById('reader-text');
  if (readerEl) {
    const spans = readerEl.querySelectorAll('.reader-word');
    const rect = readerEl.getBoundingClientRect();
    for (const span of spans) {
      const sr = span.getBoundingClientRect();
      if (sr.top >= rect.top + 20 && sr.top <= rect.top + 100) {
        return { chapter_idx: readerChapterIdx, word_index: parseInt(span.dataset.idx || 0) };
      }
    }
  }
  return { chapter_idx: readerChapterIdx, word_index: 0 };
}

async function openSummary() {
  if (!currentBook) return;
  const modal = document.getElementById('summary-modal');
  modal.style.display = 'flex';
  document.getElementById('summary-loading').style.display = 'flex';
  document.getElementById('summary-loading').innerHTML = '<div class="pixel-loader-wrap"><div class="pixel-loader"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div></div>';
  document.getElementById('summary-body').style.display = 'none';
  document.getElementById('summary-chat').innerHTML = '';
  summaryActiveTab = 'chapter';
  summaryData = null;  // reset

  const pos = getCurrentReadingPosition();

  // Only fetch chapter summary on open — fast, single LLM call
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const r = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        book_id: currentBook,
        chapter_idx: pos.chapter_idx,
        word_index: pos.word_index,
        mode: 'chapter'
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    summaryData = await r.json();
    if (summaryData.error) {
      document.getElementById('summary-loading').innerHTML = `<p>${escapeHtml(summaryData.error)}</p>`;
      return;
    }
    document.getElementById('summary-loading').style.display = 'none';
    document.getElementById('summary-body').style.display = 'block';
    document.getElementById('summary-text-chapter').textContent = summaryData.chapter_summary || 'Nothing to summarize yet.';
    document.getElementById('summary-text-sofar').textContent = 'Tap the "So Far" tab to load the full book context.';
    switchSummaryTab('chapter');
  } catch (e) {
    clearTimeout(timeoutId);
    const msg = e.name === 'AbortError' ? 'Timed out.' : friendlyError(e);
    document.getElementById('summary-loading').innerHTML = `<p>Failed: ${escapeHtml(msg)}</p>`;
  }
}

function closeSummary() {
  document.getElementById('summary-modal').style.display = 'none';
}

async function switchSummaryTab(tab) {
  summaryActiveTab = tab;
  document.getElementById('tab-chapter').classList.toggle('active', tab === 'chapter');
  document.getElementById('tab-sofar').classList.toggle('active', tab === 'sofar');
  document.getElementById('summary-text-chapter').style.display = tab === 'chapter' ? 'block' : 'none';
  document.getElementById('summary-text-sofar').style.display = tab === 'sofar' ? 'block' : 'none';

  // Lazy-load sofar summary on first switch
  if (tab === 'sofar' && summaryData && !summaryData.sofar_summary) {
    const pos = getCurrentReadingPosition();
    document.getElementById('summary-text-sofar').textContent = 'Loading full book context...';
    try {
      const r = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: currentBook,
          chapter_idx: pos.chapter_idx,
          word_index: pos.word_index,
          mode: 'sofar'
        })
      });
      const data = await r.json();
      summaryData.sofar_summary = data.sofar_summary || 'Nothing to summarize yet.';
      document.getElementById('summary-text-sofar').textContent = summaryData.sofar_summary;
    } catch (e) {
      document.getElementById('summary-text-sofar').textContent = 'Failed to load.';
    }
  }
}

async function askSummaryQuestion() {
  const input = document.getElementById('summary-ask-input');
  const question = input.value.trim();
  if (!question || !summaryData) return;
  input.value = '';

  const chat = document.getElementById('summary-chat');
  chat.innerHTML += `<div class="summary-msg user">${escapeHtml(question)}</div>`;
  chat.innerHTML += `<div class="summary-msg ai loading"><div class="pixel-loader"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div></div>`;
  chat.scrollTop = chat.scrollHeight;

  const pos = getCurrentReadingPosition();

  try {
    const r = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        book_id: currentBook,
        chapter_idx: pos.chapter_idx,
        word_index: pos.word_index,
        question: question,
        context_summaries: {
          chapter_summary: summaryData.chapter_summary,
          sofar_summary: summaryData.sofar_summary
        }
      })
    });
    const data = await r.json();
    const msgs = chat.querySelectorAll('.summary-msg.ai');
    const last = msgs[msgs.length - 1];
    if (last) {
      last.classList.remove('loading');
      last.textContent = data.answer || data.error || 'No answer.';
    }
    chat.scrollTop = chat.scrollHeight;
  } catch (e) {
    const msgs = chat.querySelectorAll('.summary-msg.ai');
    const last = msgs[msgs.length - 1];
    if (last) {
      last.classList.remove('loading');
      last.textContent = friendlyError(e);
    }
  }
}

// Enter key on ask input
document.getElementById('summary-ask-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') askSummaryQuestion();
});

// Close summary modal on outside click
document.addEventListener('click', e => {
  if (e.target.id === 'summary-modal') closeSummary();
});

// ─── Lego File Browser ──────────────────────────────────
