"""Chat persistence and model source metadata."""
import routes.ollama as ollama
import threading


def test_chat_roundtrip_and_id_validation(client, auth_headers, tmp_path, monkeypatch):
    monkeypatch.setattr(ollama, 'CHATS_DIR', tmp_path)
    data = {'title': 'Hello', 'model': 'example', 'messages': [{'role': 'user', 'content': 'Hi'}]}
    saved = client.post('/api/ollama/chats', json=data, headers=auth_headers)
    assert saved.status_code == 200
    chat_id = saved.get_json()['id']
    assert client.get('/api/ollama/chats', headers=auth_headers).get_json()['chats'][0]['id'] == chat_id
    assert client.get('/api/ollama/chats/' + chat_id, headers=auth_headers).get_json()['messages'] == data['messages']
    data['id'] = '../outside'
    assert client.post('/api/ollama/chats', json=data, headers=auth_headers).status_code == 400
    assert not (tmp_path.parent / 'outside.json').exists()


def test_models_identify_remote_host(client, auth_headers, monkeypatch):
    class Response:
        status_code = 200

        def json(self):
            return {'models': [
                {'name': 'local:latest', 'size': 100, 'details': {}},
                {'name': 'remote:cloud', 'remote_host': 'https://ollama.com', 'size': 100, 'details': {}},
            ]}
    monkeypatch.setattr(ollama._requests, 'get', lambda *a, **k: Response())
    models = client.get('/api/ollama/models', headers=auth_headers).get_json()['models']
    assert not models[0]['is_cloud']
    assert models[1]['is_cloud'] and models[1]['remote_host'] == 'https://ollama.com'
    assert models[0]['devices'][0]['id'] == 'self'


def test_stop_cancels_only_requested_generation(client, auth_headers, monkeypatch):
    closed = threading.Event()
    response = type('Response', (), {'close': lambda self: closed.set()})()
    first = {'cancelled': threading.Event(), 'response': response}
    second = {'cancelled': threading.Event(), 'response': None}
    monkeypatch.setattr(ollama, '_generations', {'first': first, 'second': second})
    monkeypatch.setattr(ollama._requests, 'post', lambda *a, **k: None)
    r = client.post('/api/ollama/stop', json={'generation_id': 'first', 'model': 'm'}, headers=auth_headers)
    assert r.status_code == 200
    assert first['cancelled'].is_set() and closed.wait(1)
    assert not second['cancelled'].is_set()
