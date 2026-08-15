"""ComfyUI image generation routes."""
from flask import Blueprint, jsonify, request
import json, time
from pathlib import Path
from shared import _requests, COMFY_URL, COMFY_OUTPUT, COMFY_INPUT

bp = Blueprint('comfy', __name__)

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

@bp.route('/api/comfy/status')
def comfy_status():
    """Get ComfyUI queue status and system stats."""
    try:
        r = _requests.get(f'{COMFY_URL}/system_stats', timeout=5)
        sys = r.json()
        r2 = _requests.get(f'{COMFY_URL}/queue', timeout=5)
        queue = r2.json()
        return jsonify({
            'online': True,
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
