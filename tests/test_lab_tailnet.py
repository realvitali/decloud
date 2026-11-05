"""Tailnet discovery and six-digit pinned node pairing."""
import threading
import time
from types import SimpleNamespace

import pytest

import lab_report
import routes.lab as lab


def status_fixture():
    return {'BackendState': 'Running', 'MagicDNSSuffix': 'tail1234.ts.net',
            'Self': {'UserID': 1, 'DNSName': 'host.tail1234.ts.net.'},
            'Peer': {
                'spark': {'UserID': 1, 'HostName': 'spark', 'OS': 'linux', 'Online': True,
                          'DNSName': 'spark.tail1234.ts.net.', 'TailscaleIPs': ['100.101.1.2']},
                'tagged': {'UserID': 0, 'HostName': 'node', 'OS': 'linux', 'Online': False,
                           'DNSName': 'node.tail1234.ts.net.', 'TailscaleIPs': ['100.101.1.3']},
                'exit': {'UserID': 2, 'HostName': 'external-exit', 'OS': 'linux', 'Online': True,
                         'DNSName': 'external.other.ts.net.', 'TailscaleIPs': ['100.101.1.4']},
                'bad': {'UserID': 1, 'HostName': 'bad', 'OS': 'linux', 'Online': True,
                        'TailscaleIPs': ['192.168.1.5']},
            }}


def test_discovery_filters_peers_and_marks_paired(client, auth_headers, monkeypatch):
    monkeypatch.setattr(lab, '_tailscale_status', status_fixture)
    monkeypatch.setattr(lab, 'load_settings', lambda: {'lab_devices': [{'url': 'https://100.101.1.2:8898'}]})
    response = client.get('/api/lab/tailnet', headers=auth_headers)
    assert response.status_code == 200
    data = response.get_json()
    assert data['host_url'] == 'https://host.tail1234.ts.net'
    assert [peer['name'] for peer in data['devices']] == ['spark', 'node']
    assert data['devices'][0]['added'] is True
    assert data['devices'][1]['online'] is False


def test_pairing_rejects_addresses_not_in_tailnet(client, auth_headers, monkeypatch):
    monkeypatch.setattr(lab, '_tailscale_status', status_fixture)
    monkeypatch.setattr(lab, 'load_settings', lambda: {})
    started = []
    monkeypatch.setattr(lab, '_connect_worker', lambda *a: started.append(a))
    assert client.post('/api/lab/tailnet/pair', json={'ip': '127.0.0.1'}, headers=auth_headers).status_code == 400
    assert not started
    r = client.post('/api/lab/tailnet/pair', json={'ip': '100.101.1.2'}, headers=auth_headers)
    assert r.status_code == 200 and r.get_json()['name'] == 'spark'
    for _ in range(50):
        if started:
            break
        time.sleep(0.01)
    assert started[0][1:] == ('100.101.1.2', lab_report.AGENT_PORT)


def test_tailnet_endpoints_require_auth(client):
    assert client.get('/api/lab/tailnet').status_code == 401
    assert client.post('/api/lab/tailnet/pair', json={'ip': '100.101.1.2'}).status_code == 401


def test_tailnet_agent_fails_closed(monkeypatch):
    monkeypatch.setattr(lab_report.subprocess, 'run', lambda *a, **k: SimpleNamespace(stdout='100.101.1.2\n'))
    assert lab_report.tailnet_ipv4() == '100.101.1.2'
    monkeypatch.setattr(lab_report.subprocess, 'run', lambda *a, **k: SimpleNamespace(stdout='192.168.1.2\n'))
    with pytest.raises(RuntimeError, match='Connect Tailscale'):
        lab_report.tailnet_ipv4()


def _wait(client, auth_headers, jid, until):
    for _ in range(80):
        current = client.get('/api/lab/pair/' + jid, headers=auth_headers).get_json()
        if current['state'] in until:
            return current
        time.sleep(0.1)
    return current


def test_add_device_waits_for_agent_then_confirms_and_pins(client, auth_headers, tmp_path, monkeypatch):
    """The hub keeps trying until the setup command is run, ignores an agent that
    is running as a service (not pairing), then pairs once someone is there."""
    import socket
    probe = socket.socket()
    probe.bind(('127.0.0.1', 0))
    port = probe.getsockname()[1]
    probe.close()
    settings = {'lab_devices': []}
    monkeypatch.setattr(lab, 'load_settings', lambda: settings)
    monkeypatch.setattr(lab, 'save_settings', lambda value: settings.update(value))
    monkeypatch.setattr(lab, '_tailnet_peers', lambda: ({'UserID': 1}, [{'ip': '127.0.0.1', 'name': 'spark'}]))
    monkeypatch.setattr(lab_report, 'AGENT_PORT', port)
    real_wait = threading.Event.wait
    monkeypatch.setattr(lab.threading.Event, 'wait', lambda self, t=None: real_wait(self, min(t or 0.05, 0.05)))
    state = lab_report.State(tmp_path / 'node')
    job = client.post('/api/lab/tailnet/pair', json={'ip': '127.0.0.1'}, headers=auth_headers).get_json()
    time.sleep(0.2)
    assert client.get('/api/lab/pair/' + job['job'], headers=auth_headers).get_json()['state'] == 'waiting-device'  # nothing listening yet

    service = lab_report.LabServer(state, 'spark', lambda: {'ok': True}, None, host='127.0.0.1', port=port).start()
    time.sleep(0.3)
    assert client.get('/api/lab/pair/' + job['job'], headers=auth_headers).get_json()['state'] == 'waiting-device'
    service.stop()

    shown = []
    server = lab_report.LabServer(state, 'spark', lambda: {'ok': True},
                                  lambda hub, number: shown.append(number) or True,
                                  host='127.0.0.1', port=port).start()
    try:
        current = _wait(client, auth_headers, job['job'], ('done', 'failed'))
        assert current['state'] == 'done', current
        assert len(shown) == 1 and current['number'] == shown[0]
        assert settings['lab_devices'][0]['fp'] == state.fp
        assert lab_report.fetch_report(settings['lab_devices'][0]['url'], state.token, state.fp) == {'ok': True}
    finally:
        server.stop()


def test_cancel_stops_waiting(client, auth_headers, monkeypatch):
    monkeypatch.setattr(lab, '_tailnet_peers', lambda: ({'UserID': 1}, [{'ip': '127.0.0.1', 'name': 'spark'}]))
    monkeypatch.setattr(lab_report, 'AGENT_PORT', 1)
    job = client.post('/api/lab/tailnet/pair', json={'ip': '127.0.0.1'}, headers=auth_headers).get_json()
    assert client.delete('/api/lab/pair/' + job['job'], headers=auth_headers).status_code == 200
    assert client.get('/api/lab/pair/' + job['job'], headers=auth_headers).status_code == 404


def test_node_script_is_public_and_points_at_tailnet_host(client, monkeypatch):
    monkeypatch.setattr(lab, '_tailscale_status', status_fixture)
    r = client.get('/lab-node.sh')
    assert r.status_code == 200
    body = r.get_data(as_text=True)
    assert "HOST='https://host.tail1234.ts.net'" in body
    assert '--install-service --tailnet' in body and '</dev/tty' in body
    monkeypatch.setattr(lab, '_tailscale_status', lambda: {})
    assert 'exit 1' in client.get('/lab-node.sh').get_data(as_text=True)
