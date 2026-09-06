#!/usr/bin/env python3
"""DeCloud TUI — a brutalist terminal dashboard. Run with `decloud tui`.

Reads every value from the same JSON APIs the web app uses (no duplicated
logic), and the update panel reuses routes.update directly. The app may be
down — the dashboard shows OFFLINE and the updater still works.
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

try:
    from textual.app import App, ComposeResult
    from textual.containers import Container, Horizontal, Vertical
    from textual.widgets import Static, Input, Button
    from textual.screen import ModalScreen
    from textual import work
except ImportError:
    print("The TUI needs the 'textual' package. Install it with:")
    print("  uv pip install textual")
    sys.exit(1)

# ─── API client (same endpoints as the web app) ───────────────────

BASE = f"http://127.0.0.1:{os.environ.get('DECLOUD_PORT', '8899')}"
SESSION_FILE = Path.home() / '.config' / 'decloud' / 'tui_session.json'
ACCENT = '#ff9e3d'   # amber
MUTED = '#7a7a7a'
FG = '#e8e6e3'
BG = '#0a0a0a'


def _load_session():
    try:
        return json.loads(SESSION_FILE.read_text()).get('session', '')
    except Exception:
        return ''


def _save_session(token):
    try:
        SESSION_FILE.parent.mkdir(parents=True, exist_ok=True)
        SESSION_FILE.write_text(json.dumps({'session': token}))
        SESSION_FILE.chmod(0o600)
    except Exception:
        pass


def api(path, method='GET', data=None):
    """Call the local DeCloud API. Returns (dict, ok)."""
    req = urllib.request.Request(BASE + path, method=method)
    sess = _load_session()
    if sess:
        req.add_header('Authorization', 'Bearer ' + sess)
    if data is not None:
        req.add_header('Content-Type', 'application/json')
        req.data = json.dumps(data).encode()
    try:
        with urllib.request.urlopen(req, timeout=4) as r:
            return json.loads(r.read() or b'{}'), True
    except urllib.error.HTTPError as e:
        if e.code == 401:
            return {'_unauthorized': True}, False
        try:
            return json.loads(e.read() or b'{}'), False
        except Exception:
            return {'_error': str(e)}, False
    except Exception as e:
        return {'_error': str(e)}, False


def login(pin):
    d, ok = api('/api/auth/login', 'POST', {'pin': pin})
    if ok and d.get('ok'):
        _save_session(d.get('session', ''))
        return True
    return False


# ─── Brutalist chrome ─────────────────────────────────────────────

FONT = {
    'D': ['█████', '█   █', '█   █', '█   █', '█████'],
    'E': ['█████', '█    ', '████ ', '█    ', '█████'],
    'C': ['█████', '█    ', '█    ', '█    ', '█████'],
    'L': ['█    ', '█    ', '█    ', '█    ', '█████'],
    'O': ['█████', '█   █', '█   █', '█   █', '█████'],
    'U': ['█   █', '█   █', '█   █', '█   █', '█████'],
}


def big_word(word):
    rows = [''] * 5
    for ch in word:
        glyph = FONT.get(ch.upper(), ['     '] * 5)
        for i in range(5):
            rows[i] += glyph[i] + ' '
    return '\n'.join(rows)


def bar(pct, width=18):
    pct = max(0.0, min(100.0, float(pct)))
    filled = round(pct / 100 * width)
    color = ACCENT if pct < 80 else '#ff4d4d'
    return (f"[bold {color}]{'█' * filled}[/][#2a2a2a]{'░' * (width - filled)}[/]"
            f" {pct:>5.1f}%")


def kb(value):
    return f"[{ACCENT}]{value}[/]"


def panel_title(text):
    return f"[bold {MUTED}]{text}[/]"


class Panel(Static):
    """A bordered panel with an uppercase title."""

    def __init__(self, title, **kwargs):
        super().__init__('', **kwargs)
        self.border_title = title


# ─── Screens ──────────────────────────────────────────────────────

class LoginScreen(ModalScreen):
    """Prompt for the access PIN (or Enter for open mode)."""

    def compose(self) -> ComposeResult:
        yield Container(
            Static("[bold]DECLOUD[/] — enter your passcode", id="login-title"),
            Input(password=True, placeholder="passcode…", id="pin"),
            Static("", id="login-error"),
            Horizontal(
                Button("Unlock", variant="primary", id="go"),
                Button("Cancel", id="cancel"),
                id="login-buttons",
            ),
            id="login-box",
        )

    def on_button_pressed(self, event):
        if event.button.id == "go":
            self._try_login()
        else:
            self.dismiss(False)

    def on_input_submitted(self, event):
        self._try_login()

    def _try_login(self):
        pin = self.query_one('#pin', Input).value
        if login(pin):
            self.dismiss(True)
        else:
            self.query_one('#login-error', Static).update(
                '[#ff4d4d]wrong passcode — try again[/]')


class ConfirmScreen(ModalScreen):
    """Big red yes/no for destructive choices (updates)."""

    def __init__(self, message):
        super().__init__()
        self.message = message

    def compose(self) -> ComposeResult:
        yield Container(
            Static(self.message, id="confirm-msg"),
            Horizontal(
                Button("Yes", variant="error", id="yes"),
                Button("No", id="no"),
                id="confirm-buttons",
            ),
            id="confirm-box",
        )

    def on_button_pressed(self, event):
        self.dismiss(event.button.id == "yes")


# ─── App ──────────────────────────────────────────────────────────

class DeCloudTUI(App):
    CSS = f"""
    Screen {{
        background: {BG};
        color: {FG};
    }}

    #header {{
        border: heavy {FG};
        padding: 0 1;
        background: {BG};
        height: auto;
    }}
    #header-word {{ color: {ACCENT}; }}
    #header-meta {{ color: {MUTED}; }}
    #offline {{
        background: #2a0d0d;
        color: #ff4d4d;
        text-style: bold;
        padding: 0 1;
    }}

    Panel {{
        border: heavy #2f2f2f;
        background: #101010;
        padding: 0 1;
        height: auto;
    }}
    Panel:focus {{
        border: heavy {ACCENT};
    }}

    #left, #right {{ width: 1fr; }}
    #right {{ margin-left: 1; }}

    #logs {{
        height: 1fr;
        overflow-y: auto;
        padding: 0;
        background: #060606;
    }}

    #login-box, #confirm-box {{
        background: {BG};
        border: heavy {ACCENT};
        padding: 2 3;
        width: 60;
        height: auto;
        align: center middle;
    }}
    #login-title, #confirm-msg {{ margin-bottom: 1; }}
    #pin {{ margin-bottom: 1; }}
    #login-buttons, #confirm-buttons {{ height: auto; }}
    #login-error {{ height: 1; color: #ff4d4d; }}

    #footer {{
        border: heavy {FG};
        color: {MUTED};
        background: {BG};
        height: 1;
        padding: 0 1;
    }}
    """

    BINDINGS = [
        ("q", "quit", "Quit"),
        ("r", "refresh", "Refresh"),
        ("u", "check_update", "Update"),
        ("U", "do_update", "Update now"),
    ]

    def __init__(self):
        super().__init__()
        self.online = False
        self.last_update_status = None

    def compose(self) -> ComposeResult:
        yield Static('', id='header')
        yield Static('OFFLINE — the DeCloud app is not answering on '
                     f'{BASE}', id='offline')
        yield Horizontal(
            Vertical(
                Panel('SYSTEM', id='system'),
                Panel('VOICE', id='voice'),
                Panel('MUSIC', id='music'),
                Panel('UPDATE', id='update'),
                id='left',
            ),
            Vertical(
                Panel('DEVICES', id='devices'),
                Panel('LOGS', id='logs'),
                id='right',
            ),
        )
        yield Static('', id='footer')

    # ── lifecycle ──

    def on_mount(self):
        self._render_header()
        self._render_footer()
        self.set_interval(2, self.refresh_system)
        self.set_interval(4, self.refresh_logs)
        self.set_interval(6, self.refresh_voice)
        self.set_interval(12, self.refresh_music)
        self.set_interval(15, self.refresh_devices)
        self.set_interval(60, self.refresh_update)
        self.set_interval(2, self._tick_header)
        self._check_auth()
        self.refresh_update()

    def _check_auth(self):
        """Decide between: online+authed, online+needs passcode, or offline.
        Offline keeps the dashboard visible (the updater still works)."""
        d, _ = api('/api/auth/check')
        if d.get('_error'):
            self._set_online(False)
            return
        self._set_online(True)
        if d.get('authenticated') or d.get('open_mode'):
            return
        if not isinstance(self.screen, LoginScreen):
            self.push_screen(LoginScreen(), self._after_login)

    def _after_login(self, ok):
        if ok:
            self._set_online(True)
            self.refresh_system()
            self.refresh_logs()

    def _set_online(self, online):
        self.online = online
        self.query_one('#offline', Static).display = online
        self.refresh_system()
        self.refresh_logs()

    def _tick_header(self):
        self._render_header()

    # ── header / footer ──

    def _render_header(self):
        try:
            import platform
            host = platform.node()
        except Exception:
            host = '?'
        try:
            from routes.version import VERSION
        except Exception:
            VERSION = '?'
        word = big_word('DECLOUD')
        self.query_one('#header', Static).update(
            f"[bold {ACCENT}]{word}[/]\n"
            f"v{VERSION}  ·  {host}  ·  {time.strftime('%H:%M:%S')}  ·  "
            f"{'[#4dff6a]ONLINE[/]' if self.online else '[#ff4d4d]OFFLINE[/]'}")

    def _render_footer(self):
        self.query_one('#footer', Static).update(
            f" {kb('q')} quit   {kb('r')} refresh   {kb('u')} check update   "
            f"{kb('U')} update now")

    # ── panels ──

    def refresh_system(self):
        d, ok = api('/api/system')
        if not ok:
            return
        lines = [
            f"[bold]CPU[/]   {bar(d.get('cpu_percent', 0))}"
            f"  {d.get('cpu_cores', '?')} cores",
            f"[bold]RAM[/]   {bar(d.get('ram_percent', 0))}",
            f"[bold]DISK[/]  {bar(d.get('disk_percent', 0))}",
            f"[bold]UP[/]    {d.get('uptime', '?')}",
        ]
        temps = d.get('temps') or {}
        for name, sensors in temps.items():
            for s in sensors[:3]:
                if s.get('current'):
                    lines.append(f"[bold]TEMP[/]  {s.get('label') or name}: "
                                 f"{s['current']}°C")
        self.query_one('#system', Static).update('\n'.join(lines))

    def refresh_voice(self):
        d, ok = api('/api/voice/status')
        if not ok:
            return
        cfg = d.get('config', {})
        hermes = d.get('hermes', {})
        brain = 'hermes' if hermes.get('available') else 'llm'
        lines = [
            f"[bold]BRAIN[/]  {brain}  ·  {cfg.get('agent_name', '?')}",
            f"[bold]STT[/]    {cfg.get('stt', '?')}",
            f"[bold]TTS[/]    {cfg.get('tts', '?')}",
            f"[bold]ACCESS[/] {cfg.get('voice_access', '?')}",
            f"[bold]OLLAMA[/] {'up' if d.get('ollama', {}).get('running') else 'down'}",
        ]
        self.query_one('#voice', Static).update('\n'.join(lines))

    def refresh_music(self):
        d, ok = api('/api/music/list')
        if not ok:
            return
        total = sum(s.get('size_mb', 0) for s in d)
        lines = [f"[bold]{len(d)} tracks[/]  ·  {total:,.0f} MB"]
        for s in d[:7]:
            name = s.get('name', '?')
            lines.append(f"  · {name[:34]}")
        self.query_one('#music', Static).update('\n'.join(lines))

    def refresh_devices(self):
        d, ok = api('/api/devices')
        if not ok:
            return
        lines = []
        for dev in d[:10]:
            mark = '[#4dff6a]●[/]' if dev.get('online') else '[#3a3a3a]○[/]'
            name = dev.get('name') or dev.get('ip') or '?'
            osname = dev.get('os') or ''
            tag = 'THIS' if dev.get('is_local') else osname
            lines.append(f"{mark} {name}  [{MUTED}]{tag}[/]")
        self.query_one('#devices', Static).update('\n'.join(lines) or 'none')

    def refresh_logs(self):
        d, ok = api('/api/logs?limit=40')
        if not ok:
            return
        out = []
        for l in d[-30:]:
            level = (l.get('level') or 'INFO').upper()
            color = {'ERROR': '#ff4d4d', 'WARNING': ACCENT,
                     'CRITICAL': '#ff4d4d'}.get(level, MUTED)
            msg = (l.get('message') or '')[:90]
            out.append(f"[{color}]{level:<7}[/] {msg}")
        self.query_one('#logs', Static).update('\n'.join(out))

    def refresh_update(self):
        try:
            import routes.update as upd
            self.last_update_status = upd.check_status()
            d = self.last_update_status
        except Exception as e:
            d = {'current_version': '?', 'update_available': False,
                 'latest': {}, 'error': str(e)}
        if d.get('error'):
            self.query_one('#update', Static).update(
                f"[#ff4d4d]{d['error']}[/]")
            return
        latest = d.get('latest') or {}
        cur = d['current_version']
        if not d.get('is_git'):
            status = f"[{MUTED}]updates need a git install[/]"
        elif d.get('update_available'):
            status = (f"[bold {ACCENT}]UPDATE AVAILABLE → {latest.get('tag')}[/]\n"
                      f"{'— press U to install —'}")
        else:
            status = f"[#4dff6a]up to date[/]"
        lines = [
            f"[bold]CURRENT[/] {cur}",
            f"[bold]LATEST[/]  {latest.get('tag') or '—'}",
            status,
        ]
        if not d.get('tree_clean'):
            lines.append(f"[#ff4d4d]local changes — updates paused[/]")
        if d.get('can_rollback'):
            lines.append(f"[{MUTED}]rollback available[/]")
        self.query_one('#update', Static).update('\n'.join(lines))

    # ── actions ──

    def action_refresh(self):
        self.refresh_system()
        self.refresh_logs()
        self.refresh_voice()
        self.refresh_music()
        self.refresh_devices()
        self.refresh_update()
        # Re-attempt auth if we were offline (e.g. the app just came back).
        if not self.online:
            self._check_auth()
        self.notify('refreshed', timeout=1.5)

    def action_check_update(self):
        self.refresh_update()
        self.notify('checked for updates', timeout=2)

    def action_do_update(self):
        d = self.last_update_status
        if not d or not d.get('update_available'):
            self.notify('already up to date', severity='warning')
            return
        ref = (d.get('latest') or {}).get('tag')
        self.push_screen(
            ConfirmScreen(f"Update DeCloud to [bold]{ref}[/]?\n\n"
                          "The new version is downloaded, verified, and "
                          "test-booted before anything restarts.\n\n"
                          "This is safe — a broken update rolls back "
                          "automatically."),
            lambda ok: self._confirm_update(ok, ref),
        )

    def _confirm_update(self, ok, ref):
        if ok:
            self.run_worker(self._do_update(ref), exclusive=True)
            self.notify(f'updating to {ref} …', timeout=3)

    @work(exclusive=True, thread=True)
    def _do_update(self, ref):
        try:
            import routes.update as upd
            code, payload = upd.perform_update(ref)
            if code == 200:
                self.call_from_thread(self._update_done, 'update verified — '
                                      'the app restarts in a moment')
            else:
                self.call_from_thread(self._update_done,
                                      'ERROR: ' + payload.get('error', 'failed'))
        except Exception as e:
            self.call_from_thread(self._update_done, 'ERROR: ' + str(e))

    def _update_done(self, message):
        self.notify(message, timeout=6)
        self.refresh_update()


def main():
    DeCloudTUI().run()


if __name__ == '__main__':
    main()
