// ===== Module: journal =====
function switchJournalTab(tabId) {
  document.querySelectorAll('.journal-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(tabId)?.classList.add('active');
  document.getElementById('journal-panel-voice').style.display = tabId === 'journal-tab-voice' ? '' : 'none';
  document.getElementById('journal-panel-universe').style.display = tabId === 'journal-tab-universe' ? '' : 'none';
  if (tabId === 'journal-tab-universe') loadUniverse();
}

// ─── 3D Legos with Physics ───────────────────────────────

let legos3D = null;

// ─── Brick options for fan-out ─────────────────────────
const LEGOS_BRICK_OPTIONS = [
  { label: '1x1', rows: 1, cols: 1, color: 0xa855f7 },
  { label: '1x2', rows: 1, cols: 2, color: 0xef4444 },
  { label: '1x4', rows: 1, cols: 4, color: 0x22c55e },
  { label: '2x2', rows: 2, cols: 2, color: 0xf59e0b },
  { label: '2x4', rows: 2, cols: 4, color: 0x3b82f6 },
  { label: '2x6', rows: 2, cols: 6, color: 0xec4899 },
];

let legosAddSpreadOpen = false;

