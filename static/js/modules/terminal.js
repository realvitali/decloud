// ===== Module: terminal =====
let cmdHistory = [];
let cmdHistoryIdx = -1;

// ─── xterm.js Interactive Terminal ──────────────────────
let xterm = null;
let xtermFit = null;
let xtermWs = null;
let xtermReady = false;

function initXterm() {
  if (xterm) return;
  if (typeof Terminal === 'undefined') {
    console.warn('xterm.js not loaded yet');
    return;
  }

  const container = document.getElementById('xterm-container');
  if (!container) return;

  xterm = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: {
      background: '#0d0d12',
      foreground: '#a7f3d0',
      cursor: '#a7f3d0',
      cursorAccent: '#0d0d12',
      selectionBackground: '#6366f140',
      black: '#000000',
      red: '#ef4444',
      green: '#22c55e',
      yellow: '#fbbf24',
      blue: '#3b82f6',
      magenta: '#a855f7',
      cyan: '#06b6d4',
      white: '#e5e7eb',
      brightBlack: '#6b7280',
      brightRed: '#f87171',
      brightGreen: '#4ade80',
      brightYellow: '#facc15',
      brightBlue: '#60a5fa',
      brightMagenta: '#c084fc',
      brightCyan: '#22d3ee',
      brightWhite: '#f9fafb',
    },
    allowProposedApi: true,
  });

  if (typeof FitAddon !== 'undefined') {
    xtermFit = new FitAddon.FitAddon();
    xterm.loadAddon(xtermFit);
  }

  xterm.open(container);
  if (xtermFit) xtermFit.fit();

  // Connect WebSocket to PTY backend
  // Use wss:// when page is served over https (e.g. through a tunnel)
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProto}//${location.host}/api/terminal/ws`;
  xtermWs = new WebSocket(wsUrl);

  xtermWs.binaryType = 'arraybuffer';

  xtermWs.onopen = () => {
    xtermReady = true;
    xterm.writeln('\x1b[32mConnected to DeCloud terminal\x1b[0m');
    sendResize();
  };

  xtermWs.onmessage = (e) => {
    let data;
    if (e.data instanceof ArrayBuffer) {
      data = new TextDecoder().decode(e.data);
    } else {
      data = e.data;
    }
    // Check for exit message
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === 'exit') {
        xterm.writeln('\r\n\x1b[31m[Process exited]\x1b[0m');
        xtermReady = false;
        return;
      }
    } catch (_) {}
    xterm.write(data);
  };

  xtermWs.onerror = () => {
    xterm.writeln('\x1b[31m[Connection error]\x1b[0m');
  };

  xtermWs.onclose = () => {
    xtermReady = false;
    xterm.writeln('\r\n\x1b[31m[Disconnected]\x1b[0m');
  };

// Send keyboard input to PTY
  xterm.onData((data) => {
    if (xtermWs && xtermWs.readyState === WebSocket.OPEN) {
      xtermWs.send(JSON.stringify({ type: 'input', data: data }));
    }
  });

  // Mobile key bar — proper key mappings
  const TERM_KEYS = {
    esc: '\x1b', tab: '\t', enter: '\r', del: '\x7f',
    up: '\x1b[A', down: '\x1b[B', left: '\x1b[D', right: '\x1b[C',
    ctrlc: '\x03', ctrld: '\x04', ctrlz: '\x1a', ctrll: '\x0c',
  };
  document.querySelectorAll('.term-key').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const key = btn.dataset.key;
      const code = TERM_KEYS[key];
      if (code && xtermWs && xtermWs.readyState === WebSocket.OPEN) {
        xtermWs.send(JSON.stringify({ type: 'input', data: code }));
      }
      if (xterm) xterm.focus();
    });
  });

  // Handle resize
  if (xtermFit) {
    window.addEventListener('resize', () => {
      if (xtermFit) {
        xtermFit.fit();
        sendResize();
      }
    });
  }
}

function sendResize() {
  if (xtermWs && xtermWs.readyState === WebSocket.OPEN && xterm) {
    xtermWs.send(JSON.stringify({
      type: 'resize',
      cols: xterm.cols,
      rows: xterm.rows,
    }));
  }
}

function switchTerminalMode(mode) {
  const xtermContainer = document.getElementById('xterm-container');
  const quickTerm = document.getElementById('quick-terminal');
  const tabInt = document.getElementById('tab-interactive');
  const tabQuick = document.getElementById('tab-quick');

  if (mode === 'interactive') {
    xtermContainer.style.display = 'block';
    quickTerm.style.display = 'none';
    tabInt.classList.add('active');
    tabQuick.classList.remove('active');
    if (!xterm) initXterm();
    if (xtermFit) {
      setTimeout(() => { xtermFit.fit(); sendResize(); }, 50);
    }
    if (xterm) xterm.focus();
  } else {
    xtermContainer.style.display = 'none';
    quickTerm.style.display = 'block';
    tabInt.classList.remove('active');
    tabQuick.classList.add('active');
  }
}

// Quick command mode (old whitelist terminal)
function runTermCmd() {
  const input = document.getElementById('terminal-input');
  const cmd = input.value.trim();
  if (!cmd) return;
  cmdHistory.unshift(cmd);
  cmdHistoryIdx = -1;
  input.value = '';
  runCmd(cmd);
}

document.getElementById('terminal-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') runTermCmd();
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (cmdHistoryIdx < cmdHistory.length - 1) {
      cmdHistoryIdx++;
      document.getElementById('terminal-input').value = cmdHistory[cmdHistoryIdx];
    }
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (cmdHistoryIdx > 0) {
      cmdHistoryIdx--;
      document.getElementById('terminal-input').value = cmdHistory[cmdHistoryIdx];
    } else {
      cmdHistoryIdx = -1;
      document.getElementById('terminal-input').value = '';
    }
  }
});

async function runCmd(cmd) {
  const out = document.getElementById('terminal-output');
  out.innerHTML += `<span style="color:var(--accent)">$ ${cmd}</span>\n`;
  try {
    const r = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cmd })
    });
    const d = await r.json();
    if (d.output) out.innerHTML += d.output;
    if (d.error) out.innerHTML += `<span style="color:var(--red)">${d.error}</span>\n`;
  } catch (e) { out.innerHTML += `<span style="color:var(--red)">Error: ${e.message}</span>\n`; }
  out.scrollTop = out.scrollHeight;
}

// ─── OSINT Privacy Watcher ──────────────────────────────

