"""Regression tests for the 2026-11-04 security audit."""
import pytest

import shared
import routes.lab as lab
import routes.ai_devices as ai


@pytest.mark.parametrize('brk', ['\n', '\r', '\x0b', '\x0c', '\x1c', '\x1d', '\x1e', '\x85', ' ', ' ', '\0'])
def test_no_line_break_the_env_loader_honours_gets_written(brk, tmp_path, monkeypatch):
    value = f'/home/x{brk}DECLOUD_COMFY_CMD=touch /tmp/pwned'
    assert not shared.env_value_is_single_line(value)
    monkeypatch.setattr(shared, 'BASE_DIR', tmp_path)
    assert shared.set_env_value('DECLOUD_HERMES_HOME', value) is False
    assert not (tmp_path / '.env').exists()


def test_library_paths_refuse_unicode_line_breaks(client, auth_headers, tmp_path, monkeypatch):
    monkeypatch.setattr(shared, 'BASE_DIR', tmp_path)
    r = client.post('/api/settings/paths', json={'books': '/tmp/b DECLOUD_INSECURE_OPEN=1'}, headers=auth_headers)
    assert r.status_code >= 400
    assert 'DECLOUD_INSECURE_OPEN' not in ((tmp_path / '.env').read_text() if (tmp_path / '.env').exists() else '')


def test_paths_with_nul_or_wildcards_are_refused(tmp_path):
    assert shared.safe_join_browse(tmp_path, 'a\0b') == tmp_path.resolve()
    assert not shared.is_safe_book_ref('*')
    assert not shared.is_safe_book_ref('book[1]')
    assert shared.is_safe_book_ref('My Book 1')


def test_non_ascii_credentials_are_a_clean_refusal(client, auth_headers):
    assert client.post('/api/auth/login', json={'pin': 'é'}, headers={'Origin': 'http://localhost'}).status_code == 401
    cookie_client_headers = {'Origin': 'http://localhost', 'X-CSRF-Token': 'é'}
    client.post('/api/auth/login', json={'pin': '24681357'}, headers={'Origin': 'http://localhost'})
    assert client.post('/api/lab/discover', headers=cookie_client_headers).status_code == 403


def test_voice_run_command_is_gone(client, auth_headers):
    assert client.post('/api/voice/run_command', json={'command': 'id'}, headers=auth_headers).status_code in (404, 405)


def test_a_broken_peer_cannot_take_the_lab_page_down(monkeypatch):
    def boom(*a, **k):
        raise RecursionError('maximum recursion depth exceeded')   # what '[[[[…' 100k deep does to json.loads
    monkeypatch.setattr(lab.lab_report, 'fetch_report', boom)
    assert lab._fetch_uncached({'id': 'p', 'url': 'https://127.0.0.1:1', 'token': 't', 'fp': 'f'})['error']


def test_hostile_ollama_rows_are_rebuilt_with_safe_types():
    class Peer:
        id, name, local = 'p', 'peer', False

        def call(self, method, path, timeout=4):
            if path == '/api/tags':
                return 200, {'models': [{'name': 'evil:1b', 'size': 'huge', 'details': ['x']}, {'name': '<img src=x>'}]}
            return 200, {'models': 'nope'}
    probe = ai._probe(Peer())
    assert probe['online'] and [m['name'] for m in probe['models']] == ['evil:1b']
    assert probe['models'][0]['size'] == 0.0 and probe['models'][0]['details'] == {'family': 'unknown'}


def test_hub_names_lose_control_characters():
    import lab_report, re
    src = open(lab_report.__file__).read()
    assert "re.sub(r'[^\\x20-\\x7e]', ''" in src   # ANSI codes can't redraw the pairing prompt


def test_no_inline_script_anywhere_and_csp_forbids_it(client):
    import re
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent
    pages = [root / 'templates/index.html', *sorted((root / 'static/js/modules').glob('*.js'))]
    for f in pages:
        hits = re.findall(r'\son[a-z]+="', f.read_text(encoding='utf-8'))
        assert not hits, f'{f.name}: inline handler — use data-on<event>="key" + static/js/handlers.js'
    assert not re.search(r'<script(?![^>]*\bsrc=)', (root / 'templates/index.html').read_text(encoding='utf-8'))
    csp = client.get('/').headers['Content-Security-Policy']
    script_src = csp.split('script-src', 1)[1].split(';', 1)[0]
    assert "'unsafe-inline'" not in script_src and "'unsafe-eval'" not in script_src


def test_every_handler_key_in_the_markup_exists():
    import re
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent
    defined = set(re.findall(r'^\s{2}([a-z][0-9a-f]{7}): function', (root / 'static/js/handlers.js').read_text(encoding='utf-8'), re.M))
    used = set()
    for f in [root / 'templates/index.html', *sorted((root / 'static/js/modules').glob('*.js'))]:
        used |= set(re.findall(r'data-on[a-z]+="([a-z][0-9a-f]{7})"', f.read_text(encoding='utf-8')))
    assert used and used <= defined, used - defined


def test_settings_devices_are_the_lab_devices_not_every_tailnet_peer(client, auth_headers, monkeypatch):
    import routes.devices as dev
    peers = {f'm{i}': {'HostName': f'us-lax-wg-{i}', 'TailscaleIPs': [f'100.90.0.{i}'], 'Online': True} for i in range(50)}
    peers['spark'] = {'HostName': 'spark', 'TailscaleIPs': ['100.64.0.2'], 'Online': True, 'OS': 'linux'}
    peers['phone'] = {'HostName': 'pho', 'TailscaleIPs': ['100.64.0.9'], 'Online': False, 'OS': 'iOS'}
    monkeypatch.setattr(dev, '_tailscale_status', lambda: {'Self': {'TailscaleIPs': ['100.64.0.1']}, 'Peer': peers})
    monkeypatch.setattr(lab, 'load_settings', lambda: {
        'lab_devices': [{'id': 'd1', 'name': 'Spark', 'url': 'https://100.64.0.2:8898'}],
        'lab_phones': [{'id': 'ph-1', 'name': 'Phone', 'ip': '100.64.0.9', 'os': 'iOS'}]})
    monkeypatch.setattr(shared, 'load_settings', lab.load_settings)
    names = [d['name'] for d in client.get('/api/devices', headers=auth_headers).get_json()]
    assert names[1:] == ['Spark', 'Phone'] and not any('wg-' in n for n in names)
