"""ComfyUI image generation routes."""
from flask import Blueprint, jsonify, request
import json, os, shlex, shutil, signal, subprocess, time
from pathlib import Path
from shared import _requests, COMFY_URL, COMFY_OUTPUT, COMFY_INPUT, BASE_DIR

bp = Blueprint('comfy', __name__)

# ─── ComfyUI lifecycle (start/stop from the UI — no SSH needed) ───
COMFY_PID_FILE = BASE_DIR / 'comfy.pid'
COMFY_LOG_FILE = BASE_DIR / 'comfy.log'


def _comfy_strategy() -> tuple:
    """How ComfyUI should be started on this machine.

    Returns (strategy, argv) where strategy is one of:
      'systemd'  — a comfyui user unit exists; argv = systemctl args
      'cmd'      — DECLOUD_COMFY_CMD from .env; argv = shell-split cmd
      'main.py'  — found a ComfyUI checkout; argv = python main.py
      None       — nothing found; the UI shows setup guidance
    """
    # 1. systemd user unit
    try:
        r = subprocess.run(['systemctl', '--user', 'cat', 'comfyui.service'],
                           capture_output=True, text=True, timeout=10)
        if r.returncode == 0:
            return 'systemd', ['systemctl', '--user', 'start', 'comfyui']
    except (OSError, subprocess.TimeoutExpired):
        pass

    # 2. Explicit command from .env
    cmd = os.environ.get('DECLOUD_COMFY_CMD', '').strip()
    if cmd:
        try:
            argv = shlex.split(cmd)
            if argv:
                return 'cmd', argv
        except ValueError:
            pass

    # 3. A standard ComfyUI checkout
    for root in (Path.home() / 'ComfyUI', BASE_DIR.parent / 'ComfyUI'):
        main_py = root / 'main.py'
        if main_py.exists():
            venv_py = root / 'venv' / 'bin' / 'python'
            python = str(venv_py) if venv_py.exists() else (shutil.which('python3') or 'python3')
            return 'main.py', [python, str(main_py)]

    return None, []


def _comfy_online() -> bool:
    try:
        r = _requests.get(f'{COMFY_URL}/system_stats', timeout=3)
        return r.status_code == 200
    except Exception:
        return False


@bp.route('/api/comfy/models')
def comfy_models():
    """List available ComfyUI checkpoints and loras."""
    try:
        r = _requests.get(f'{COMFY_URL}/object_info/CheckpointLoaderSimple', timeout=10)
        data = r.json()
        ckpts = data['CheckpointLoaderSimple']['input']['required']['ckpt_name'][0]

        r2 = _requests.get(f'{COMFY_URL}/object_info/LoraLoader', timeout=10)
        data2 = r2.json()
        loras = data2['LoraLoader']['input']['required']['lora_name'][0]

        return jsonify({'checkpoints': ckpts, 'loras': loras})
    except Exception as e:
        return jsonify({'error': str(e)}), 503

@bp.route('/api/comfy/start', methods=['POST'])
def comfy_start():
    """Start ComfyUI with whatever launcher this machine has."""
    if _comfy_online():
        return jsonify({'ok': True, 'message': 'ComfyUI is already running'})

    strategy, argv = _comfy_strategy()
    if not argv:
        return jsonify({
            'error': 'ComfyUI is not installed where DeCloud can find it. '
                     'Install ComfyUI, or set DECLOUD_COMFY_CMD in .env to '
                     'the command that starts it.',
            'code': 'NOT_INSTALLED',
        }), 409

    try:
        if strategy == 'systemd':
            subprocess.run(argv, capture_output=True, text=True, timeout=30)
        else:
            # Detached launch, output to comfy.log so the UI can show it
            log_f = open(COMFY_LOG_FILE, 'ab')
            cwd = None
            if strategy == 'main.py':
                cwd = str(Path(argv[1]).parent)
            proc = subprocess.Popen(
                argv, cwd=cwd, start_new_session=True,
                stdout=log_f, stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
            )
            COMFY_PID_FILE.write_text(str(proc.pid))
    except OSError as e:
        return jsonify({'error': f'could not start ComfyUI: {e}'}), 500

    return jsonify({'ok': True, 'message': f'Starting ComfyUI ({strategy}) — '
                                          'it usually takes 20-60s to come up',
                    'strategy': strategy})


@bp.route('/api/comfy/stop', methods=['POST'])
def comfy_stop():
    """Stop ComfyUI if DeCloud started it (or a systemd unit exists)."""
    strategy, _ = _comfy_strategy()
    if strategy == 'systemd':
        subprocess.run(['systemctl', '--user', 'stop', 'comfyui'],
                       capture_output=True, text=True, timeout=30)
        return jsonify({'ok': True, 'message': 'ComfyUI service stopped'})

    if COMFY_PID_FILE.exists():
        try:
            pid = int(COMFY_PID_FILE.read_text().strip())
            os.kill(pid, signal.SIGTERM)
            time.sleep(2)
            try:
                os.kill(pid, 0)
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            COMFY_PID_FILE.unlink(missing_ok=True)
            return jsonify({'ok': True, 'message': 'ComfyUI stopped'})
        except (OSError, ValueError) as e:
            return jsonify({'error': f'could not stop ComfyUI: {e}'}), 500

    return jsonify({'error': 'ComfyUI was started outside DeCloud — stop it '
                             'with systemctl or the terminal'}), 409


@bp.route('/api/comfy/log')
def comfy_log():
    """Tail the ComfyUI launch log so startup failures are visible."""
    lines = []
    if COMFY_LOG_FILE.exists():
        try:
            lines = COMFY_LOG_FILE.read_text(errors='replace').splitlines()[-80:]
        except OSError:
            pass
    strategy, _ = _comfy_strategy()
    return jsonify({'log': lines, 'strategy': strategy or None,
                    'online': _comfy_online()})


@bp.route('/api/comfy/status')
def comfy_status():
    """Get ComfyUI queue status and system stats."""
    strategy, _ = _comfy_strategy()
    try:
        r = _requests.get(f'{COMFY_URL}/system_stats', timeout=5)
        sys = r.json()
        r2 = _requests.get(f'{COMFY_URL}/queue', timeout=5)
        queue = r2.json()
        return jsonify({
            'online': True,
            'strategy': strategy,
            'vram_total': sys['devices'][0]['vram_total'],
            'vram_free': sys['devices'][0]['vram_free'],
            'gpu': sys['devices'][0]['name'],
            'queue_running': len(queue.get('queue_running', [])),
            'queue_pending': len(queue.get('queue_pending', [])),
        })
    except Exception as e:
        return jsonify({'online': False, 'error': str(e)}), 200

@bp.route('/api/comfy/generate', methods=['POST'])
def comfy_generate():
    """Queue a text-to-image generation with Flux Schnell."""
    data = request.get_json(silent=True) or {}
    prompt_text = data.get('prompt', '')
    if not prompt_text:
        return jsonify({'error': 'prompt required'}), 400

    width = data.get('width', 1024)
    height = data.get('height', 1024)
    steps = data.get('steps', 4)  # Flux Schnell: 4 steps default
    seed = data.get('seed', 0)  # 0 = random
    checkpoint = data.get('checkpoint', 'flux1_schnell_fp8.safetensors')
    lora_name = data.get('lora_name', '')
    lora_strength = data.get('lora_strength', 1.0)

    if seed == 0:
        seed = int(time.time()) % (2**32)

    # Build workflow for Flux Schnell
    workflow = {
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": seed,
                "steps": steps,
                "cfg": 0.0,  # Flux Schnell uses cfg=0
                "sampler_name": "euler",
                "scheduler": "simple",
                "denoise": 1.0,
                "model": ["4", 0],
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["5", 0]
            }
        },
        "4": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": checkpoint}
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": width, "height": height, "batch_size": 1}
        },
        "6": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": prompt_text, "clip": ["4", 1]}
        },
        "7": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": "", "clip": ["4", 1]}
        },
        "8": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["3", 0], "vae": ["4", 2]}
        },
        "9": {
            "class_type": "SaveImage",
            "inputs": {"filename_prefix": "decloud", "images": ["8", 0]}
        }
    }

    # Add Lora if specified
    if lora_name:
        workflow["10"] = {
            "class_type": "LoraLoader",
            "inputs": {
                "lora_name": lora_name,
                "strength_model": lora_strength,
                "strength_clip": lora_strength,
                "model": ["4", 0],
                "clip": ["4", 1]
            }
        }
        workflow["3"]["inputs"]["model"] = ["10", 0]
        workflow["6"]["inputs"]["clip"] = ["10", 1]
        workflow["7"]["inputs"]["clip"] = ["10", 1]

    try:
        r = _requests.post(f'{COMFY_URL}/prompt', json={"prompt": workflow}, timeout=10)
        result = r.json()
        if 'error' in result:
            return jsonify({'error': json.dumps(result['error'])}), 400
        prompt_id = result.get('prompt_id', '')
        return jsonify({'ok': True, 'prompt_id': prompt_id})
    except Exception as e:
        return jsonify({'error': str(e)}), 503

@bp.route('/api/comfy/progress/<prompt_id>')
def comfy_progress(prompt_id):
    """Check progress of a generation."""
    try:
        r = _requests.get(f'{COMFY_URL}/history/{prompt_id}', timeout=5)
        history = r.json()
        if prompt_id in history:
            outputs = history[prompt_id].get('outputs', {})
            status_val = history[prompt_id].get('status', {})
            status_str = status_val.get('status_str', 'success')
            images = []
            if status_str == 'error':
                msgs = status_val.get('messages', [])
                error_msg = 'Generation failed'
                for msg in msgs:
                    if msg and len(msg) >= 2 and msg[0] == 'execution_error':
                        error_msg = msg[1].get('exception_message', 'Unknown error')
                return jsonify({
                    'done': True,
                    'error': error_msg,
                    'images': [],
                    'status': status_val
                })
            for node_id, node_output in outputs.items():
                if 'images' in node_output:
                    for img in node_output['images']:
                        images.append({
                            'filename': img['filename'],
                            'subfolder': img.get('subfolder', ''),
                            'url': f'{COMFY_URL}/view?filename={img["filename"]}&subfolder={img.get("subfolder","")}&type=output'
                        })
            status_val = history[prompt_id].get('status', {})
            return jsonify({
                'done': True,
                'images': images,
                'status': status_val
            })
        # Check queue
        r2 = _requests.get(f'{COMFY_URL}/queue', timeout=5)
        queue = r2.json()
        running = queue.get('queue_running', [])
        pending = queue.get('queue_pending', [])
        return jsonify({
            'done': False,
            'running': len(running),
            'pending': len(pending),
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 503

@bp.route('/api/comfy/gallery')
def comfy_gallery():
    """List recent generated images from output directory."""
    try:
        images = []
        if COMFY_OUTPUT.exists():
            for f in sorted(COMFY_OUTPUT.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
                if f.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp'):
                    images.append({
                        'filename': f.name,
                        'url': f'{COMFY_URL}/view?filename={f.name}&type=output',
                        'size': f.stat().st_size,
                        'modified': f.stat().st_mtime,
                    })
                    if len(images) >= 50:
                        break
        return jsonify({'images': images})
    except Exception as e:
        return jsonify({'error': str(e)}), 503
