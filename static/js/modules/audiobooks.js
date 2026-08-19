// ===== Module: audiobooks =====
// ─── Books: Library ────────────────────────────────────────
async function loadBooks() {
  try {
    document.getElementById('book-list').innerHTML = Array(5).fill(
      '<div class="skeleton-book"><div style="flex:1"><div class="shimmer-block skeleton-title"></div><div class="shimmer-block skeleton-meta"></div></div></div>'
    ).join('');
    const r = await fetch('/api/books');
    const books = await r.json();
    if (!books || books.length === 0) {
      document.getElementById('book-list').innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📚</div>
          <h3>No books yet</h3>
          <p>Add PDF or EPUB files to your books folder to get started.</p>
          <p class="empty-hint">Settings → Books folder to change the path</p>
        </div>`;
      return;
    }
    document.getElementById('book-list').innerHTML = books.map(b => {
      const statusClass = b.status === 'ready' ? 'ready' : b.status === 'generating' ? 'generating' : 'new';
      const done = b.chapters_done || 0;
      const total = b.total_chapters;
      const statusText = b.status === 'ready' ? (total ? `${total} chapters` : `${done} chapters`) :
                         b.status === 'generating' ? (total ? `${done}/${total} chapters` : `${done} chapters done`) :
                         total ? `${done}/${total} chapters` : 'Not generated';
      return `
        <div class="book-item" onclick="openBook('${b.id}', '${b.title.replace(/'/g,"\\'")}')">
          <div class="book-item-info">
            <div class="book-item-name">${b.title}</div>
            <div class="book-item-meta">${b.size_mb} MB &nbsp;•&nbsp; ${b.voice || 'no voice'}</div>
          </div>
          <div class="book-item-right">
            <div class="book-status ${statusClass}">${statusText}</div>
            <button class="settings-btn" onclick="event.stopPropagation(); openSettingsForBook('${b.id}')" title="Settings">&#9881;</button>
          </div>
        </div>
      `;
    }).join('');
  } catch {
    document.getElementById('book-list').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📚</div>
        <h3>No books yet</h3>
        <p>Add PDF or EPUB files to your books folder to get started.</p>
        <p class="empty-hint">Settings → Books folder to change the path</p>
      </div>`;
  }
}

// ─── Book State ────────────────────────────────────────────
let currentBook = null;

// Reader state (from PDF text API — may have different/more chapters)
let readerChapters = [];     // [{start, end, title}] from PDF TOC
let readerChapterIdx = 0;
let readerText = '';
let bookmarks = [];
let fontSizeLevel = 1;
let bookmarkPanelOpen = false;

// Audio state (from audio JSON — generated TTS chapters)
let audioData = null;
let player = null;
let audioChapterIdx = 0;
let transcriptWords = [];
let pollInterval = null;

// ─── Open Book ────────────────────────────────────────────
async function openBook(bookId, title) {
  currentBook = bookId;
  loadBookmarks();
  document.getElementById('reader-title').textContent = title;

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
        document.getElementById('audio-mode-btn').disabled = true;
      }
    }
  } catch {
    audioData = null;
    document.getElementById('audio-mode-btn').disabled = true;
  }

  // ── Auto-resume: restore last position by default ──
  var savedAudio = null;
  try { savedAudio = JSON.parse(localStorage.getItem('playback_' + bookId) || 'null'); } catch {}

  var savedReaderBookmark = bookmarks.find(function(b) { return b.isResume; });
  var lastMode = localStorage.getItem('mode_' + bookId) || 'reader';

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
  document.getElementById('chapter-label').textContent = ch.title || `Ch ${idx + 1}`;
  document.getElementById('reader-text').innerHTML = '<div class="pixel-loader-wrap"><div class="pixel-loader"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div></div>';
  document.getElementById('prev-ch-btn').disabled = idx <= 0;
  document.getElementById('next-ch-btn').disabled = idx >= readerChapters.length - 1;

  try {
    const res = await fetch(`/api/books/text?book=${encodeURIComponent(currentBook)}&chapter=${idx}`);
    const data = await res.json();
    if (data.error) {
      document.getElementById('reader-text').innerHTML = `<span style="color:var(--text-dim)">${data.error}</span>`;
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
    return `<span class="reader-word" data-idx="${i}" onclick="handleWordTap(this, ${i})">${w}</span>`;
  }).join('');

  el.style.fontSize = fs + 'px';

  // Restore scroll position
  const saved = bookmarks.find(b => b.chapter === readerChapterIdx && b.isResume);
  if (saved) {
    setTimeout(() => {
      const span = el.querySelector(`[data-idx="${saved.wordIndex}"]`);
      if (span) { span.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }, 100);
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
    if (sr.top >= rect.top + 20 && sr.top <= rect.top + 100) {
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

function changeFontSize(delta) {
  fontSizeLevel = Math.max(-2, Math.min(2, fontSizeLevel + delta));
  document.getElementById('font-size-label').textContent = ['S', 'M', 'L', 'X', 'XX'][fontSizeLevel + 2];
  renderReaderText();
}

function setReaderMode(mode) {
  const isReader = mode === 'reader';
  document.getElementById('reader-pane').style.display = isReader ? 'block' : 'none';
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
    if (readerChapters.length > 0) {
      document.getElementById('chapter-label').textContent = readerChapters[readerChapterIdx]?.title || `Ch ${readerChapterIdx + 1}`;
    }
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
  if (el) el.textContent = count;
}

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
      <span class="bookmark-word">"${b.word}"</span>
      <span class="bookmark-ch">Ch ${b.chapter + 1}</span>
      <button class="bookmark-goto" onclick="gotoBookmark(${i})">Go</button>
      <button class="bookmark-del" onclick="deleteBookmark(${i})">✕</button>
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
    return `<option value="${i}" class="${cls}" ${isCurrent ? 'selected' : ''}>${prefix}${num}. ${title}</option>`;
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
    return `<span class="tw" id="tw-${i}">${t}</span>`;
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
      time: t
    }));
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
function showGenBanner(progress) {
  const banner = document.getElementById('gen-banner');
  banner.style.display = 'block';
  document.getElementById('gen-progress-fill').style.width = progress + '%';
  document.getElementById('gen-banner-sub').textContent = progress + '%';
}
function hideGenBanner() {
  document.getElementById('gen-banner').style.display = 'none';
}
function updateGenBanner(progress) {
  document.getElementById('gen-progress-fill').style.width = progress + '%';
  document.getElementById('gen-banner-sub').textContent = progress + '%';
}

async function startPolling(bookId) {
  if (pollInterval) clearInterval(pollInterval);
  isGenerating = true;

  pollInterval = setInterval(async () => {
    const r = await fetch(`/api/tts/status/${bookId}`);
    const d = await r.json();

    if (d.status === 'ready') {
      clearInterval(pollInterval);
      isGenerating = false;
      pollInterval = null;
      hideGenBanner();
      const audioRes = await fetch(`/api/audio/${bookId}`);
      audioData = await audioRes.json();
      loadBooks();
      if (audioData?.has_audio) {
        setupPlayer();
        buildChapterDropdown(audioChapterIdx);
      }
    } else if (d.status === 'converting') {
      const pct = d.progress || '0';
      updateGenBanner(pct);
      // Update banner sub-text with ETA + chapter count
      const sub = document.getElementById('gen-banner-sub');
      if (sub) {
        let txt = `${pct}%`;
        if (d.done_chapters && d.total_chapters) {
          txt += ` · ${d.done_chapters}/${d.total_chapters} chapters`;
        }
        if (d.eta) {
          txt += ` · ~${d.eta} left`;
        }
        sub.textContent = txt;
      }
      // Also update settings modal if open
      const genStatus = document.getElementById('gen-status');
      if (genStatus && genStatus.style.display !== 'none') {
        let txt = `Generating... ${pct}%`;
        if (d.done_chapters && d.total_chapters) {
          txt += ` (${d.done_chapters}/${d.total_chapters})`;
        }
        if (d.eta) {
          txt += ` ~${d.eta} left`;
        }
        genStatus.textContent = txt;
      }
    } else {
      clearInterval(pollInterval);
      isGenerating = false;
      pollInterval = null;
      hideGenBanner();
    }
  }, 4000);
}

// ─── Settings Modal ─────────────────────────────────────
let settingsBookId = null;

async function openSettingsForBook(bookId) {
  settingsBookId = bookId;
  const modal = document.getElementById('settings-modal');
  modal.style.display = 'flex';

  // Load voices
  const [voicesRes, settingsRes, chaptersRes, statusRes] = await Promise.all([
    fetch('/api/voices'),
    fetch(`/api/book/${bookId}/settings`),
    fetch(`/api/book/${bookId}/chapters`),
    fetch(`/api/tts/status/${bookId}`)
  ]);

  const [voices, settings, chapters, status] = await Promise.all([
    voicesRes.json(), settingsRes.json(), chaptersRes.json(), statusRes.json()
  ]);

  const doneCount = chapters.filter(c => c.status === 'done').length;
  const bookTitle = bookId.replace(/_/g, ' ');
  document.getElementById('settings-book-title').textContent = bookTitle;

  // ── Voice Grid ──
  const voiceGrid = document.getElementById('voice-grid');
  voiceGrid.innerHTML = voices.map(v => {
    const isActive = settings.voice === v.id;
    return `
      <div class="voice-card ${isActive ? 'selected' : ''}" onclick="selectVoice('${v.id}')" id="voice-${v.id}">
        <div class="voice-icon">${v.gender === 'male' ? '♂' : '♀'}</div>
        <div class="voice-name">${v.name}</div>
        ${isActive ? '<div class="voice-active-badge">Active</div>' : ''}
      </div>
    `;
  }).join('');

  // ── Chapter Status ──
  const chapterList = document.getElementById('chapter-status-list');
  if (doneCount === 0) {
    chapterList.innerHTML = '<div class="chapter-none">No chapters generated yet</div>';
  } else {
    chapterList.innerHTML = chapters.map(c => {
      if (c.status === 'pending') return '';
      return `
        <div class="chapter-row done">
          <span class="chapter-row-num">${c.index + 1}</span>
          <span class="chapter-row-name">${getChapterName(c.index) || ''}</span>
          <span class="chapter-row-size">${c.size_kb ? Math.round(c.size_kb/1024)+'MB' : ''}</span>
        </div>
      `;
    }).join('');
  }

  // ── Generate Controls ──
  const genControls = document.getElementById('gen-controls');
  const genStatus = document.getElementById('gen-status');

  if (status.status === 'converting') {
    genControls.innerHTML = `<button class="gen-btn stop" onclick="stopGeneration()">Stop Generation</button>`;
    genStatus.style.display = 'block';
    genStatus.innerHTML = `Generating... ${status.progress || '0'}%`;
  } else if (status.status === 'ready' || doneCount > 0) {
    genStatus.style.display = 'block';
    genStatus.innerHTML = `${doneCount}/${chapters.length} chapters ready`;
    genControls.innerHTML = `
      <button class="gen-btn" onclick="startGeneration()">Regenerate All</button>
    `;
  } else {
    genStatus.style.display = 'none';
    genControls.innerHTML = `<button class="gen-btn" onclick="startGeneration()">Generate Audio</button>`;
  }

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
  const r = await fetch(`/api/tts/start/${settingsBookId}`, { method: 'POST' });
  const d = await r.json();
  if (d.status === 'started') {
    document.getElementById('gen-controls').innerHTML =
      `<button class="gen-btn stop" onclick="stopGeneration()">Stop Generation</button>`;
    document.getElementById('gen-status').style.display = 'block';
    document.getElementById('gen-status').textContent = 'Starting...';

    if (currentBook === settingsBookId) {
      showGenBanner('0');
      startPolling(settingsBookId);
    }
    loadBooks();
    closeSettings();
  }
}

async function stopGeneration() {
  if (!settingsBookId) return;
  await fetch(`/api/tts/stop/${settingsBookId}`, { method: 'POST' });
  if (pollInterval) { clearInterval(pollInterval); isGenerating = false; pollInterval = null; }
  if (currentBook === settingsBookId) hideGenBanner();
  loadBooks();
  closeSettings();
}

async function previewVoice() {
  if (!settingsBookId) return;
  const chaptersRes = await fetch(`/api/book/${settingsBookId}/chapters`);
  const chapters = await chaptersRes.json();
  const chapter0Done = chapters.find(c => c.index === 0 && c.status === 'done');
  if (chapter0Done) {
    const player = document.getElementById('preview-player');
    player.src = `/api/audio/${settingsBookId}/stream/0`;
    player.play();
  } else {
    document.getElementById('settings-preview-voice').textContent =
      'Generate chapter 1 first to preview';
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
      document.getElementById('summary-loading').innerHTML = `<p>${summaryData.error}</p>`;
      return;
    }
    document.getElementById('summary-loading').style.display = 'none';
    document.getElementById('summary-body').style.display = 'block';
    document.getElementById('summary-text-chapter').textContent = summaryData.chapter_summary || 'Nothing to summarize yet.';
    document.getElementById('summary-text-sofar').textContent = 'Tap the "So Far" tab to load the full book context.';
    switchSummaryTab('chapter');
  } catch (e) {
    clearTimeout(timeoutId);
    const msg = e.name === 'AbortError' ? 'Timed out.' : e.message;
    document.getElementById('summary-loading').innerHTML = `<p>Failed: ${msg}</p>`;
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
  chat.innerHTML += `<div class="summary-msg user">${question}</div>`;
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
      last.textContent = data.answer || 'No answer.';
    }
    chat.scrollTop = chat.scrollHeight;
  } catch (e) {
    const msgs = chat.querySelectorAll('.summary-msg.ai');
    const last = msgs[msgs.length - 1];
    if (last) {
      last.classList.remove('loading');
      last.textContent = e.message;
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
