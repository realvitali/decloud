#!/usr/bin/env python3
"""DeCloud desktop media controls (MPRIS) for KDE Plasma, GNOME and anything else that speaks MPRIS.

Why this exists: a browser can only give your desktop's media widget play, pause, previous, next and seek.
There is no way for a web page to add shuffle or repeat. This small program registers a real media player
called "DeCloud" on your desktop and controls whichever device is currently playing (your phone, this
computer, anything) through DeCloud's live connection. It plays no sound itself.

    python3 decloud-mpris.py                 # first run asks for your DeCloud address and passcode
    python3 decloud-mpris.py --install-service   # start it automatically when you log in

Needs Python 3.9+. On first run it creates a private virtualenv and installs two small packages
(aiohttp, dbus-next); nothing is installed system-wide.
"""
import argparse
import asyncio
import getpass
import json
import os
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

HOME = Path.home()
CONF_DIR = Path(os.environ.get('XDG_CONFIG_HOME', HOME / '.config')) / 'decloud-mpris'
CONF = CONF_DIR / 'config.json'
DATA_DIR = Path(os.environ.get('XDG_DATA_HOME', HOME / '.local' / 'share')) / 'decloud-mpris'
CACHE_DIR = Path(os.environ.get('XDG_CACHE_HOME', HOME / '.cache')) / 'decloud-mpris'
VENV = DATA_DIR / 'venv'
BUS_NAME = 'org.mpris.MediaPlayer2.decloud'


# ─── first run: private virtualenv with the two dependencies ─────────────────
def bootstrap():
    try:
        import aiohttp, dbus_next  # noqa: F401
        return
    except ImportError:
        pass
    py = VENV / 'bin' / 'python'
    if py.exists() and Path(sys.executable).resolve() == py.resolve():
        sys.exit('aiohttp / dbus-next could not be imported even inside the private virtualenv.')
    print('First run: setting up a private environment (aiohttp, dbus-next)...', flush=True)
    if not py.exists():
        VENV.parent.mkdir(parents=True, exist_ok=True)
        subprocess.check_call([sys.executable, '-m', 'venv', str(VENV)])
    subprocess.check_call([str(py), '-m', 'pip', 'install', '-q', '--disable-pip-version-check', 'aiohttp', 'dbus-next'])
    os.execv(str(py), [str(py)] + sys.argv)


# ─── configuration and sign-in ───────────────────────────────────────────────
def load_conf():
    try:
        return json.loads(CONF.read_text())
    except Exception:
        return {}


def save_conf(conf):
    CONF_DIR.mkdir(parents=True, exist_ok=True)
    CONF.write_text(json.dumps(conf))
    CONF.chmod(0o600)


def login(url, passcode):
    req = urllib.request.Request(url.rstrip('/') + '/api/auth/login', data=json.dumps({'pin': passcode}).encode(),
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit('Sign-in failed (%s). Check the passcode.' % e.code)
    except Exception as e:
        sys.exit('Could not reach %s: %s' % (url, e))
    if not d.get('session'):
        sys.exit('This DeCloud did not return a session (is a passcode set?).')
    return d['session']


# ─── the player ──────────────────────────────────────────────────────────────
def build(url, token, dev, label):
    import time
    import aiohttp
    from dbus_next import Variant, BusType
    from dbus_next.aio import MessageBus
    from dbus_next.service import ServiceInterface, method, dbus_property, signal, PropertyAccess

    NO_TRACK = '/org/mpris/MediaPlayer2/TrackList/NoTrack'
    LOOP_TO_APP = {'None': 'off', 'Playlist': 'all', 'Track': 'one'}
    APP_TO_LOOP = {v: k for k, v in LOOP_TO_APP.items()}

    class Root(ServiceInterface):
        def __init__(self):
            super().__init__('org.mpris.MediaPlayer2')

        @method()
        def Raise(self):
            pass

        @method()
        def Quit(self):
            pass

        @dbus_property(access=PropertyAccess.READ)
        def CanQuit(self) -> 'b':
            return False

        @dbus_property(access=PropertyAccess.READ)
        def CanRaise(self) -> 'b':
            return False

        @dbus_property(access=PropertyAccess.READ)
        def HasTrackList(self) -> 'b':
            return False

        @dbus_property(access=PropertyAccess.READ)
        def Identity(self) -> 's':
            return 'DeCloud'

        @dbus_property(access=PropertyAccess.READ)
        def SupportedUriSchemes(self) -> 'as':
            return []

        @dbus_property(access=PropertyAccess.READ)
        def SupportedMimeTypes(self) -> 'as':
            return []

    class Player(ServiceInterface):
        def __init__(self):
            super().__init__('org.mpris.MediaPlayer2.Player')
            self.loop = None
            self.ws = None
            self.state = None            # session state: q, qi, pos, playing, sh, rp
            self.pos0 = 0.0              # position at the moment we learned it (seconds)
            self.pos0_at = 0.0           # monotonic time of that moment
            self.meta = {}               # track id -> {t, ar, al, d, c}
            self.art = {}                # cover id -> file URL
            self.volume = 1.0
            self.http = None

        # ---- what the desktop reads
        def cur_id(self):
            st = self.state
            if not st or not st.get('q'):
                return None
            qi = st.get('qi', 0)
            return st['q'][qi] if 0 <= qi < len(st['q']) else None

        def position(self):
            st = self.state
            if not st:
                return 0.0
            p = self.pos0 + ((time.monotonic() - self.pos0_at) if st.get('playing') else 0.0)
            m = self.meta.get(self.cur_id())
            return max(0.0, min(p, m['d']) if m and m.get('d') else p)

        def metadata(self):
            i = self.cur_id()
            if not i:
                return {'mpris:trackid': Variant('o', NO_TRACK)}
            m = self.meta.get(i) or {}
            safe = ''.join(ch if ch.isalnum() else '_' for ch in i)[:60]
            d = {'mpris:trackid': Variant('o', '/org/decloud/track/' + safe)}
            if m.get('d'):
                d['mpris:length'] = Variant('x', int(m['d'] * 1_000_000))
            if m.get('t') is not None:
                d['xesam:title'] = Variant('s', m['t'])
                d['xesam:artist'] = Variant('as', [m.get('ar') or ''])
                d['xesam:album'] = Variant('s', m.get('al') or '')
            if m.get('c') and self.art.get(m['c']):
                d['mpris:artUrl'] = Variant('s', self.art[m['c']])
            return d

        @dbus_property(access=PropertyAccess.READ)
        def PlaybackStatus(self) -> 's':
            if not self.state:
                return 'Stopped'
            return 'Playing' if self.state.get('playing') else 'Paused'

        @dbus_property()
        def LoopStatus(self) -> 's':
            return APP_TO_LOOP.get((self.state or {}).get('rp', 'off'), 'None')

        @LoopStatus.setter
        def LoopStatus(self, val: 's'):
            if self.state is not None:
                self.state['rp'] = LOOP_TO_APP.get(val, 'off')
            self.cmd('repeat', LOOP_TO_APP.get(val, 'off'))
            self.changed(LoopStatus=APP_TO_LOOP.get(LOOP_TO_APP.get(val, 'off'), 'None'))

        @dbus_property()
        def Shuffle(self) -> 'b':
            return bool((self.state or {}).get('sh'))

        @Shuffle.setter
        def Shuffle(self, val: 'b'):
            if self.state is not None:
                self.state['sh'] = bool(val)
            self.cmd('shuffle', bool(val))
            self.changed(Shuffle=bool(val))

        @dbus_property()
        def Volume(self) -> 'd':
            return self.volume

        @Volume.setter
        def Volume(self, val: 'd'):
            self.volume = max(0.0, min(1.0, float(val)))
            self.cmd('vol', self.volume)
            self.changed(Volume=self.volume)

        @dbus_property(access=PropertyAccess.READ)
        def Rate(self) -> 'd':
            return 1.0

        @dbus_property(access=PropertyAccess.READ)
        def MinimumRate(self) -> 'd':
            return 1.0

        @dbus_property(access=PropertyAccess.READ)
        def MaximumRate(self) -> 'd':
            return 1.0

        @dbus_property(access=PropertyAccess.READ)
        def Metadata(self) -> 'a{sv}':
            return self.metadata()

        @dbus_property(access=PropertyAccess.READ)
        def Position(self) -> 'x':
            return int(self.position() * 1_000_000)

        @dbus_property(access=PropertyAccess.READ)
        def CanGoNext(self) -> 'b':
            return True

        @dbus_property(access=PropertyAccess.READ)
        def CanGoPrevious(self) -> 'b':
            return True

        @dbus_property(access=PropertyAccess.READ)
        def CanPlay(self) -> 'b':
            return True

        @dbus_property(access=PropertyAccess.READ)
        def CanPause(self) -> 'b':
            return True

        @dbus_property(access=PropertyAccess.READ)
        def CanSeek(self) -> 'b':
            return True

        @dbus_property(access=PropertyAccess.READ)
        def CanControl(self) -> 'b':
            return True

        # ---- what the desktop asks us to do (forwarded to the device that is playing)
        @method()
        def Play(self):
            self.cmd('play')
            self.set_playing(True)

        @method()
        def Pause(self):
            self.cmd('pause')
            self.set_playing(False)

        @method()
        def PlayPause(self):
            playing = bool(self.state and self.state.get('playing'))
            self.cmd('pause' if playing else 'play')
            self.set_playing(not playing)

        @method()
        def Stop(self):
            self.cmd('pause')
            self.cmd('seek', 0)
            self.set_playing(False)

        @method()
        def Next(self):
            self.cmd('next')

        @method()
        def Previous(self):
            self.cmd('prev')

        @method()
        def Seek(self, offset: 'x'):
            self.seek_to(self.position() + offset / 1_000_000)

        @method()
        def SetPosition(self, track_id: 'o', position: 'x'):
            self.seek_to(position / 1_000_000)

        @method()
        def OpenUri(self, uri: 's'):
            pass

        @signal()
        def Seeked(self, position: 'x') -> 'x':
            return position

        # ---- plumbing
        def cmd(self, action, value=None):
            ws = self.ws
            if ws is not None:                                     # D-Bus callbacks run on this same event loop
                asyncio.ensure_future(ws.send_json({'t': 'cmd', 'a': action, 'v': value}))

        def changed(self, **props):
            try:
                self.emit_properties_changed(props, [])
            except Exception:
                pass

        def set_playing(self, playing):
            if self.state is None:
                return
            self.pos0 = self.position()
            self.pos0_at = time.monotonic()
            self.state['playing'] = playing
            self.changed(PlaybackStatus=self.PlaybackStatus)

        def seek_to(self, sec):
            sec = max(0.0, sec)
            self.cmd('seek', sec)
            self.pos0, self.pos0_at = sec, time.monotonic()
            self.Seeked(int(sec * 1_000_000))

    player = Player()
    root = Root()

    async def fetch_meta(i):
        if not i or i in player.meta:
            return
        try:
            async with player.http.get(url + '/api/music/meta', params={'ids': i}) as r:
                if r.status == 200:
                    player.meta[i] = (await r.json()).get(i) or {}
        except Exception:
            return
        c = (player.meta.get(i) or {}).get('c')
        if c and c not in player.art:
            try:
                async with player.http.get(url + '/api/music/artwork/' + c, params={'size': '300'}) as r:
                    if r.status == 200:
                        CACHE_DIR.mkdir(parents=True, exist_ok=True)
                        f = CACHE_DIR / (''.join(ch if ch.isalnum() else '_' for ch in c)[:80] + '.img')
                        f.write_bytes(await r.read())
                        player.art[c] = 'file://' + str(f)
            except Exception:
                pass

    async def apply_state(m):
        s = m.get('s') or {}
        st = s.get('state')
        if not st or not st.get('q'):
            player.state = None
            player.changed(PlaybackStatus='Stopped', Metadata=player.metadata())
            return
        before = player.cur_id(), (player.state or {}).get('playing'), (player.state or {}).get('sh'), (player.state or {}).get('rp')
        pos = float(st.get('pos') or 0)
        if st.get('playing'):                                          # it kept playing since the report
            pos += max(0.0, float(m.get('now', 0)) - float(s.get('updated', 0)))
        player.state = dict(st)
        player.pos0, player.pos0_at = pos, time.monotonic()
        await fetch_meta(player.cur_id())
        after = player.cur_id(), st.get('playing'), st.get('sh'), st.get('rp')
        player.changed(PlaybackStatus=player.PlaybackStatus, Metadata=player.metadata(), Shuffle=player.Shuffle, LoopStatus=player.LoopStatus)
        if before[0] != after[0]:
            player.Seeked(int(pos * 1_000_000))

    async def session_loop(stop):
        ws_url = url.replace('https://', 'wss://').replace('http://', 'ws://') + '/api/music/connect'
        delay = 1
        while not stop.is_set():
            try:
                async with aiohttp.ClientSession(headers={'Cookie': 'decloud_session=' + token}) as http:
                    player.http = http
                    async with http.ws_connect(ws_url, heartbeat=None, max_msg_size=0) as ws:
                        player.ws, player.loop = ws, asyncio.get_running_loop()
                        await ws.send_json({'t': 'hello', 'dev': dev, 'label': label, 'role': 'controller'})
                        delay = 1
                        print('Connected to DeCloud.', flush=True)

                        async def ping():
                            while True:
                                await asyncio.sleep(20)
                                await ws.send_json({'t': 'ping'})
                        pinger = asyncio.create_task(ping())
                        try:
                            async for msg in ws:
                                if msg.type != aiohttp.WSMsgType.TEXT:
                                    continue
                                m = json.loads(msg.data)
                                if m.get('t') == 'state':
                                    await apply_state(m)
                        finally:
                            pinger.cancel()
            except aiohttp.WSServerHandshakeError as e:
                if e.status in (401, 403):
                    print('Your DeCloud sign-in has expired. Run this again to sign in.', flush=True)
                    sys.exit(2)
                print('Connection problem (%s), retrying...' % e.status, flush=True)
            except Exception as e:
                print('Disconnected (%s), retrying in %ss' % (type(e).__name__, delay), flush=True)
            player.ws = None
            if player.state is not None:
                player.state = None
                player.changed(PlaybackStatus='Stopped', Metadata=player.metadata())
            try:
                await asyncio.wait_for(stop.wait(), delay)
            except asyncio.TimeoutError:
                pass
            delay = min(30, delay * 2)

    async def main():
        bus = await MessageBus(bus_type=BusType.SESSION).connect()
        bus.export('/org/mpris/MediaPlayer2', root)
        bus.export('/org/mpris/MediaPlayer2', player)
        await bus.request_name(BUS_NAME)
        print('Registered %s on your session bus. Open the media widget to use it.' % BUS_NAME, flush=True)
        stop = asyncio.Event()
        await session_loop(stop)

    return main, player


def install_service():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    script = DATA_DIR / 'decloud-mpris.py'
    script.write_text(Path(__file__).read_text())
    script.chmod(0o755)
    py = VENV / 'bin' / 'python'
    unit_dir = Path(os.environ.get('XDG_CONFIG_HOME', HOME / '.config')) / 'systemd' / 'user'
    unit_dir.mkdir(parents=True, exist_ok=True)
    (unit_dir / 'decloud-mpris.service').write_text(
        '[Unit]\nDescription=DeCloud desktop media controls (MPRIS)\nAfter=graphical-session.target\n\n'
        '[Service]\nExecStart=%s %s\nRestart=on-failure\nRestartSec=5\nRestartPreventExitStatus=2\n\n'
        '[Install]\nWantedBy=default.target\n' % (py if py.exists() else sys.executable, script))
    subprocess.call(['systemctl', '--user', 'daemon-reload'])
    subprocess.call(['systemctl', '--user', 'enable', '--now', 'decloud-mpris.service'])
    print('Installed. It now starts whenever you log in. Check it with: systemctl --user status decloud-mpris')


def main():
    ap = argparse.ArgumentParser(description='DeCloud desktop media controls (MPRIS)')
    ap.add_argument('--url', help='your DeCloud address, e.g. https://my-server.tailXXXX.ts.net')
    ap.add_argument('--token', help='a session token (skips the passcode prompt)')
    ap.add_argument('--no-save', action='store_true', help='do not write the config file')
    ap.add_argument('--install-service', action='store_true', help='start automatically at login (systemd user service)')
    ap.add_argument('--logout', action='store_true', help='forget the saved sign-in')
    a = ap.parse_args()
    if a.logout:
        CONF.unlink(missing_ok=True)
        print('Signed out.')
        return
    bootstrap()
    conf = load_conf()
    url = (a.url or conf.get('url') or '').rstrip('/')
    token = a.token or conf.get('token')
    if not url:
        url = input('DeCloud address (e.g. https://my-server.tailXXXX.ts.net): ').strip().rstrip('/')
    if not url.startswith('http'):
        url = 'https://' + url
    if not token:
        token = login(url, getpass.getpass('DeCloud passcode: '))
    if not a.no_save:
        save_conf({'url': url, 'token': token})
    if a.install_service:
        install_service()
        return
    host = socket.gethostname()
    run, _ = build(url, token, 'mpris.' + host, 'Desktop media widget (%s)' % host)
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
