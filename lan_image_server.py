import asyncio
import copy
import io
import json
import math
import os
import random
import re
import socket
import subprocess
import time
import uuid
import zipfile
import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo
from aiohttp import web
from server import PromptServer

import folder_paths
import comfy.samplers

# Directory configuration
NODE_DIR = os.path.dirname(os.path.realpath(__file__))
TEMP_DIR = os.path.join(NODE_DIR, "temp")
UI_DIR = os.path.join(NODE_DIR, "ui")

# State variables
CONNECTED_WEBSOCKETS = set()
HISTORY_FILES = []
HISTORY_EPOCH = uuid.uuid4().hex
NEXT_IMAGE_INDEX = 1
SERVER_INITIALIZED = False

LAST_PROMPT_INFO = None
LOOP_ACTIVE = False
IS_RUNNING = False

# rgthree Seed node integration
RGTHREE_SEED_CLASS = "Seed (rgthree)"
RGTHREE_SEED_MAX = 1125899906842624
SEED_OVERRIDES = {}
SKIP_NEXT_CAPTURE = False

# Generation settings (Fetch Generation Settings on LAN)
SAMPLERS = list(comfy.samplers.KSampler.SAMPLERS)
SCHEDULERS = list(comfy.samplers.KSampler.SCHEDULERS)
GENERATION_DEFAULTS = {
    "text": "",
    "negative": "",
    "steps": 20,
    "cfg": 7.0,
    "sampler_name": SAMPLERS[0] if SAMPLERS else "euler",
    "scheduler": SCHEDULERS[0] if SCHEDULERS else "normal",
}
GENERATION_OVERRIDES = {}
SETTINGS_REVISION = 0

# Resolution settings (part of the generation settings)
ASPECT_RATIOS = {
    "1:1": (1, 1),
    "2:3": (2, 3),
    "3:2": (3, 2),
    "3:4": (3, 4),
    "4:3": (4, 3),
    "9:16": (9, 16),
    "16:9": (16, 9),
    "21:9": (21, 9),
}
RES_ASPECT = "1:1"
RES_MEGAPIXELS = 1.5
RES_CUSTOM = False
RES_CUSTOM_WIDTH = 1224
RES_CUSTOM_HEIGHT = 1224

# Presets
PRESETS_DIR = os.path.join(NODE_DIR, "presets")
CURRENT_PRESET = None

def ensure_temp_dir():
    """Ensures the temp directory exists and restores any images from a previous session."""
    global SERVER_INITIALIZED, HISTORY_FILES, NEXT_IMAGE_INDEX
    if SERVER_INITIALIZED:
        return

    os.makedirs(TEMP_DIR, exist_ok=True)

    entries = []
    for name in os.listdir(TEMP_DIR):
        match = re.match(r"img_(\d+)\.png$", name)
        if match:
            entries.append((int(match.group(1)), os.path.join(TEMP_DIR, name)))
    entries.sort(key=lambda item: item[0])

    HISTORY_FILES = [path for _, path in entries]
    NEXT_IMAGE_INDEX = (entries[-1][0] + 1) if entries else 1
    SERVER_INITIALIZED = True


# Restore the previous session's gallery as soon as the node loads.
ensure_temp_dir()

# ------------------------------------------------------------------
# Hook into PromptServer to capture binary previews
# ------------------------------------------------------------------

original_send_bytes = getattr(PromptServer.instance, 'send_bytes', None)

if original_send_bytes:
    async def hooked_send_bytes(self, event, data, sid=None):
        if CONNECTED_WEBSOCKETS and isinstance(event, int) and event in (1, 2, 4):
            if isinstance(data, (bytes, bytearray)):
                for ws in list(CONNECTED_WEBSOCKETS):
                    try:
                        asyncio.create_task(ws.send_bytes(data))
                    except Exception:
                        pass

        return await original_send_bytes(event, data, sid=sid)

    PromptServer.instance.send_bytes = hooked_send_bytes.__get__(
        PromptServer.instance, PromptServer
    )

# ------------------------------------------------------------------
# Hook into PromptServer send_sync to mirror sampling progress
# ------------------------------------------------------------------

original_send_sync = getattr(PromptServer.instance, 'send_sync', None)

if original_send_sync:
    def hooked_send_sync(self, event, data, sid=None):
        try:
            if event == "progress" and isinstance(data, dict):
                broadcast_json({"type": "progress", "value": data.get("value"), "max": data.get("max")})
            elif event == "executing" and isinstance(data, dict) and data.get("node") is None:
                broadcast_json({"type": "progress", "value": None, "max": None, "done": True})
        except Exception:
            pass
        return original_send_sync(event, data, sid=sid)

    PromptServer.instance.send_sync = hooked_send_sync.__get__(
        PromptServer.instance, PromptServer
    )

# ------------------------------------------------------------------
# Hook into PromptServer prompt_queue to capture active workflow
# ------------------------------------------------------------------

if hasattr(PromptServer.instance, 'prompt_queue') and hasattr(PromptServer.instance.prompt_queue, 'put'):
    original_prompt_queue_put = PromptServer.instance.prompt_queue.put

    def hooked_prompt_queue_put(item):
        global LAST_PROMPT_INFO, SKIP_NEXT_CAPTURE
        if SKIP_NEXT_CAPTURE:
            SKIP_NEXT_CAPTURE = False
            return original_prompt_queue_put(item)
        try:
            if isinstance(item, (tuple, list)) and len(item) >= 3:
                prompt = item[2]
                extra_data = item[3] if len(item) > 3 else {}
                outputs = item[4] if len(item) > 4 else None
                sensitive = item[5] if len(item) > 5 else {}
                LAST_PROMPT_INFO = {
                    "prompt": copy.deepcopy(prompt),
                    "extra_data": copy.deepcopy(extra_data) if isinstance(extra_data, dict) else {},
                    "outputs_to_execute": copy.deepcopy(outputs) if outputs else None,
                    "sensitive": copy.deepcopy(sensitive) if isinstance(sensitive, dict) else {}
                }
        except Exception as e:
            print(f"[LAN Server] Error capturing prompt: {e}")
        return original_prompt_queue_put(item)

    PromptServer.instance.prompt_queue.put = hooked_prompt_queue_put


async def _safe_send_json(ws, payload):
    try:
        await ws.send_json(payload)
    except Exception:
        pass


def broadcast_json(payload):
    """Sends a JSON payload to every connected LAN client, thread-safely.

    Node execution runs on a transient per-prompt event loop (see
    ``PromptExecutor.execute`` -> ``asyncio.run``), so WebSocket sends must be
    marshalled back onto the server's main loop.
    """
    sockets = list(CONNECTED_WEBSOCKETS)
    if not sockets:
        return
    loop = getattr(PromptServer.instance, "loop", None)
    if loop is not None and loop.is_running():
        for ws in sockets:
            try:
                asyncio.run_coroutine_threadsafe(_safe_send_json(ws, payload), loop)
            except Exception:
                pass
    else:
        for ws in sockets:
            try:
                asyncio.create_task(_safe_send_json(ws, payload))
            except Exception:
                pass


def get_active_prompt():
    global LAST_PROMPT_INFO
    if LAST_PROMPT_INFO is not None:
        return LAST_PROMPT_INFO

    try:
        history = PromptServer.instance.prompt_queue.get_history(max_items=1)
        if history:
            for pid, data in history.items():
                prompt_item = data.get("prompt")
                if prompt_item and len(prompt_item) >= 3:
                    LAST_PROMPT_INFO = {
                        "prompt": copy.deepcopy(prompt_item[2]),
                        "extra_data": copy.deepcopy(prompt_item[3]) if len(prompt_item) > 3 and isinstance(prompt_item[3], dict) else {},
                        "outputs_to_execute": copy.deepcopy(prompt_item[4]) if len(prompt_item) > 4 else None,
                        "sensitive": copy.deepcopy(prompt_item[5]) if len(prompt_item) > 5 and isinstance(prompt_item[5], dict) else {}
                    }
                    return LAST_PROMPT_INFO
    except Exception:
        pass

    try:
        running, queued = PromptServer.instance.prompt_queue.get_current_queue_volatile()
        for item in (running + queued):
            if len(item) >= 3:
                LAST_PROMPT_INFO = {
                    "prompt": copy.deepcopy(item[2]),
                    "extra_data": copy.deepcopy(item[3]) if len(item) > 3 and isinstance(item[3], dict) else {},
                    "outputs_to_execute": copy.deepcopy(item[4]) if len(item) > 4 else None,
                    "sensitive": copy.deepcopy(item[5]) if len(item) > 5 and isinstance(item[5], dict) else {}
                }
                return LAST_PROMPT_INFO
    except Exception:
        pass

    return None


def get_seed_nodes():
    """Lists every 'Seed (rgthree)' node found in the active workflow prompt."""
    info = get_active_prompt()
    if not info:
        return []

    prompt = info.get("prompt") or {}
    extra_data = info.get("extra_data") or {}

    titles = {}
    try:
        workflow = (extra_data.get("extra_pnginfo") or {}).get("workflow") or {}
        for node in workflow.get("nodes", []):
            nid = str(node.get("id"))
            titles[nid] = node.get("title") or node.get("type") or nid
    except Exception:
        pass

    nodes = []
    for nid, node in prompt.items():
        if not isinstance(node, dict) or node.get("class_type") != RGTHREE_SEED_CLASS:
            continue
        inputs = node.get("inputs") or {}
        if "seed" not in inputs:
            continue

        override = SEED_OVERRIDES.get(str(nid))
        mode = override.get("mode", "default") if override else "default"
        nodes.append({
            "id": str(nid),
            "title": titles.get(str(nid), str(nid)),
            "current": inputs.get("seed"),
            "mode": mode,
            "value": override.get("value") if override else None,
            "min": -RGTHREE_SEED_MAX,
            "max": RGTHREE_SEED_MAX,
        })

    nodes.sort(key=lambda n: n["id"])
    return nodes


def apply_seed_overrides(prompt):
    """Patches the deep-copied prompt's 'Seed (rgthree)' nodes with any active overrides."""
    for nid, node in prompt.items():
        if not isinstance(node, dict) or node.get("class_type") != RGTHREE_SEED_CLASS:
            continue
        override = SEED_OVERRIDES.get(str(nid))
        if not override:
            continue
        mode = override.get("mode")
        if mode == "random":
            node.setdefault("inputs", {})["seed"] = -1
        elif mode == "fixed":
            node.setdefault("inputs", {})["seed"] = int(override.get("value", 0))


def _round_to_8(value):
    return max(8, int(round(value / 8.0)) * 8)


def compute_resolution(aspect, megapixels):
    """Computes width/height for an aspect ratio and megapixel budget (rounded to /8)."""
    a, b = ASPECT_RATIOS.get(aspect, (1, 1))
    total = float(megapixels) * 1_000_000.0
    height = math.sqrt(total * b / a)
    width = math.sqrt(total * a / b)
    return _round_to_8(width), _round_to_8(height)


def get_effective_resolution():
    if RES_CUSTOM:
        return int(RES_CUSTOM_WIDTH), int(RES_CUSTOM_HEIGHT)
    return compute_resolution(RES_ASPECT, RES_MEGAPIXELS)


def resolution_state():
    width, height = get_effective_resolution()
    return {
        "aspect": RES_ASPECT,
        "megapixels": RES_MEGAPIXELS,
        "custom": RES_CUSTOM,
        "width": RES_CUSTOM_WIDTH,
        "height": RES_CUSTOM_HEIGHT,
        "effective_width": width,
        "effective_height": height,
    }


def get_effective_settings():
    width, height = get_effective_resolution()

    def eff(key):
        return GENERATION_OVERRIDES.get(key, GENERATION_DEFAULTS.get(key))

    return {
        "text": str(eff("text") or ""),
        "negative": str(eff("negative") or ""),
        "width": width,
        "height": height,
        "steps": int(eff("steps")),
        "cfg": float(eff("cfg")),
        "sampler_name": eff("sampler_name"),
        "scheduler": eff("scheduler"),
    }


def settings_state():
    return {
        "defaults": GENERATION_DEFAULTS,
        "overrides": GENERATION_OVERRIDES,
        "effective": get_effective_settings(),
        "resolution": resolution_state(),
        "samplers": SAMPLERS,
        "schedulers": SCHEDULERS,
    }


def _reset_settings():
    global RES_ASPECT, RES_MEGAPIXELS, RES_CUSTOM, RES_CUSTOM_WIDTH, RES_CUSTOM_HEIGHT
    global SETTINGS_REVISION, CURRENT_PRESET

    GENERATION_OVERRIDES.clear()
    SEED_OVERRIDES.clear()
    RES_ASPECT = "1:1"
    RES_MEGAPIXELS = 1.5
    RES_CUSTOM = False
    RES_CUSTOM_WIDTH = 1224
    RES_CUSTOM_HEIGHT = 1224
    SETTINGS_REVISION += 1
    CURRENT_PRESET = None


def _sanitize_preset_name(name):
    if not isinstance(name, str):
        return ""
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name).strip().strip(".")
    return cleaned[:64]


def ensure_presets_dir():
    os.makedirs(PRESETS_DIR, exist_ok=True)


def _preset_path(name):
    safe = _sanitize_preset_name(name)
    if not safe:
        return None, None
    return os.path.join(PRESETS_DIR, safe + ".json"), safe


def list_presets():
    try:
        ensure_presets_dir()
        names = [f[:-5] for f in os.listdir(PRESETS_DIR) if f.endswith(".json")]
    except OSError:
        names = []
    names.sort(key=str.lower)
    return names


def _write_preset(name):
    path, safe = _preset_path(name)
    if not path:
        return None

    ensure_presets_dir()
    effective = get_effective_settings()
    resolution = resolution_state()
    payload = {
        "name": safe,
        "generation": {k: effective[k] for k in ("text", "negative", "steps", "cfg", "sampler_name", "scheduler")},
        "resolution": {k: resolution[k] for k in ("aspect", "megapixels", "custom", "width", "height")},
        "seed": copy.deepcopy(SEED_OVERRIDES),
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return safe


def _read_preset(name):
    path, safe = _preset_path(name)
    if not path or not os.path.isfile(path):
        return None, None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f), safe
    except (OSError, ValueError):
        return None, safe


def apply_preset(payload):
    global RES_ASPECT, RES_MEGAPIXELS, RES_CUSTOM, RES_CUSTOM_WIDTH, RES_CUSTOM_HEIGHT
    global SETTINGS_REVISION, CURRENT_PRESET

    generation = payload.get("generation") or {}
    for key in ("text", "negative", "steps", "cfg", "sampler_name", "scheduler"):
        if key not in generation:
            GENERATION_OVERRIDES.pop(key, None)
            continue
        value = generation[key]
        if key == "steps":
            try:
                value = max(1, min(10000, int(value)))
            except (TypeError, ValueError):
                continue
        elif key == "cfg":
            try:
                value = max(0.0, min(100.0, float(value)))
            except (TypeError, ValueError):
                continue
        elif key == "sampler_name":
            if value not in SAMPLERS:
                continue
        elif key == "scheduler":
            if value not in SCHEDULERS:
                continue
        else:
            value = str(value)

        if value == GENERATION_DEFAULTS.get(key):
            GENERATION_OVERRIDES.pop(key, None)
        else:
            GENERATION_OVERRIDES[key] = value

    resolution = payload.get("resolution") or {}
    if resolution.get("aspect") in ASPECT_RATIOS:
        RES_ASPECT = resolution["aspect"]
    if "megapixels" in resolution:
        try:
            RES_MEGAPIXELS = max(0.1, min(8.0, float(resolution["megapixels"])))
        except (TypeError, ValueError):
            pass
    if "custom" in resolution:
        RES_CUSTOM = bool(resolution["custom"])
    if "width" in resolution:
        try:
            RES_CUSTOM_WIDTH = max(16, min(8192, int(resolution["width"])))
        except (TypeError, ValueError):
            pass
    if "height" in resolution:
        try:
            RES_CUSTOM_HEIGHT = max(16, min(8192, int(resolution["height"])))
        except (TypeError, ValueError):
            pass

    SEED_OVERRIDES.clear()
    seed = payload.get("seed")
    if isinstance(seed, dict):
        for node_id, override in seed.items():
            if isinstance(override, dict) and override.get("mode") in ("random", "fixed"):
                SEED_OVERRIDES[str(node_id)] = override

    SETTINGS_REVISION += 1


async def trigger_run():
    global IS_RUNNING, SKIP_NEXT_CAPTURE
    info = get_active_prompt()
    if not info:
        return False, "No active workflow prompt found. Run the workflow once from ComfyUI first."

    prompt = copy.deepcopy(info["prompt"])
    extra_data = copy.deepcopy(info.get("extra_data", {}))
    sensitive = copy.deepcopy(info.get("sensitive", {}))

    prompt_id = str(uuid.uuid4())
    number = PromptServer.instance.number
    PromptServer.instance.number += 1
    extra_data["create_time"] = int(time.time() * 1000)

    IS_RUNNING = True

    try:
        if hasattr(PromptServer.instance, 'node_replace_manager'):
            try:
                PromptServer.instance.node_replace_manager.apply_replacements(prompt)
            except Exception:
                pass

        apply_seed_overrides(prompt)

        import execution
        valid = await execution.validate_prompt(prompt_id, prompt, None)
        if valid[0]:
            outputs_to_execute = valid[2]
            if hasattr(execution, 'SENSITIVE_EXTRA_DATA_KEYS'):
                for k in execution.SENSITIVE_EXTRA_DATA_KEYS:
                    if k in extra_data:
                        sensitive[k] = extra_data.pop(k)

            # ComfyUI main.py prompt_worker strictly requires item[5] to be the sensitive dict
            item = (number, prompt_id, prompt, extra_data, outputs_to_execute, sensitive)
            SKIP_NEXT_CAPTURE = True
            PromptServer.instance.prompt_queue.put(item)
            return True, prompt_id
        else:
            IS_RUNNING = False
            error_details = valid[1]
            if isinstance(error_details, dict):
                error_msg = error_details.get("message", str(error_details))
            else:
                error_msg = str(error_details)
            print(f"[LAN Server] Validation failed: {error_msg}")
            return False, f"Prompt validation failed: {error_msg}"
    except Exception as e:
        print(f"[LAN Server] trigger_run error: {e}")
        try:
            outputs_to_execute = info.get("outputs_to_execute") or []
            item = (number, prompt_id, prompt, extra_data, outputs_to_execute, sensitive)
            SKIP_NEXT_CAPTURE = True
            PromptServer.instance.prompt_queue.put(item)
            return True, prompt_id
        except Exception as inner_e:
            IS_RUNNING = False
            return False, f"Queue error: {inner_e}"

# ------------------------------------------------------------------
# Web Server Routes
# ------------------------------------------------------------------

CONTENT_TYPES = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "text/javascript",
}


def _ui_response(filename):
    if not filename:
        return web.Response(status=404, text="Asset not found.")
    filepath = os.path.join(UI_DIR, os.path.basename(filename))
    if not os.path.isfile(filepath):
        return web.Response(status=404, text="Asset not found.")
    content_type = CONTENT_TYPES.get(os.path.splitext(filepath)[1].lower(), "application/octet-stream")
    with open(filepath, "rb") as f:
        body = f.read()
    return web.Response(body=body, content_type=content_type)


@PromptServer.instance.routes.get("/inx/view")
async def handle_index(request):
    return _ui_response("index.html")


@PromptServer.instance.routes.get("/inx/ui/{filename}")
async def handle_ui_asset(request):
    return _ui_response(request.match_info.get("filename", ""))


@PromptServer.instance.routes.get("/inx/image")
async def handle_image(request):
    index_param = request.query.get("index", None)
    clean = request.query.get("clean", None) in ("1", "true", "yes")

    if not HISTORY_FILES:
        return web.Response(status=404, text="No images available.")

    try:
        idx = int(index_param) if index_param is not None else len(HISTORY_FILES) - 1
        filepath = HISTORY_FILES[idx]

        if clean:
            # Re-encode without any PNG text chunks so workflow/prompt metadata is stripped.
            with Image.open(filepath) as image:
                buffer = io.BytesIO()
                image.save(buffer, format='PNG', compress_level=4)
            return web.Response(
                body=buffer.getvalue(),
                content_type='image/png',
                headers={"Cache-Control": "no-store"}
            )

        with open(filepath, "rb") as f:
            return web.Response(
                body=f.read(),
                content_type='image/png',
                headers={"Cache-Control": "public, max-age=31536000, immutable"}
            )
    except (IndexError, ValueError, OSError):
        return web.Response(status=404, text="Image not found.")


def _extract_image_params(filepath):
    """Best-effort extraction of generation settings from a PNG's embedded prompt."""
    result = {"seed": None, "width": None, "height": None, "positive": None, "negative": None}
    try:
        with Image.open(filepath) as image:
            text = getattr(image, "text", None) or {}
        raw = text.get("prompt")
        prompt = json.loads(raw) if raw else None
    except Exception:
        prompt = None

    if not isinstance(prompt, dict):
        return result

    def inputs_of(node):
        return node.get("inputs", {}) if isinstance(node, dict) else {}

    # Seed (prefer the rgthree Seed node, else any integer seed input)
    for nid, node in prompt.items():
        if isinstance(node, dict) and node.get("class_type") == RGTHREE_SEED_CLASS:
            seed = inputs_of(node).get("seed")
            if isinstance(seed, int):
                result["seed"] = seed
                break
    if result["seed"] is None:
        for node in prompt.values():
            seed = inputs_of(node).get("seed")
            if isinstance(seed, int):
                result["seed"] = seed
                break

    # Size (first node exposing both width and height)
    for node in prompt.values():
        node_inputs = inputs_of(node)
        if isinstance(node_inputs.get("width"), int) and isinstance(node_inputs.get("height"), int):
            result["width"] = node_inputs["width"]
            result["height"] = node_inputs["height"]
            break

    def resolve_text(ref):
        if isinstance(ref, list) and ref:
            node = prompt.get(str(ref[0]))
            text_value = inputs_of(node).get("text")
            if isinstance(text_value, str):
                return text_value
        return None

    for node in prompt.values():
        node_inputs = inputs_of(node)
        if result["positive"] is None and "positive" in node_inputs:
            result["positive"] = resolve_text(node_inputs.get("positive"))
        if result["negative"] is None and "negative" in node_inputs:
            result["negative"] = resolve_text(node_inputs.get("negative"))

    if result["positive"] is None:
        texts = [
            inputs_of(n).get("text") for n in prompt.values()
            if isinstance(n, dict) and n.get("class_type") == "CLIPTextEncode"
            and isinstance(inputs_of(n).get("text"), str)
        ]
        if texts:
            result["positive"] = max(texts, key=len)

    return result


@PromptServer.instance.routes.get("/inx/image/params")
async def handle_image_params(request):
    if not HISTORY_FILES:
        return web.json_response({"error": "no images"}, status=404)
    try:
        idx = int(request.query.get("index", len(HISTORY_FILES) - 1))
        filepath = HISTORY_FILES[idx]
    except (IndexError, ValueError):
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response(_extract_image_params(filepath))


@PromptServer.instance.routes.get("/inx/download_all")
async def handle_download_all(request):
    clean = request.query.get("clean", None) in ("1", "true", "yes")

    if not HISTORY_FILES:
        return web.Response(status=404, text="No images available.")

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_STORED) as archive:
        for i, filepath in enumerate(HISTORY_FILES):
            name = f"inx_{i + 1:05d}.png"
            if clean:
                with Image.open(filepath) as image:
                    stripped = io.BytesIO()
                    image.save(stripped, format='PNG', compress_level=4)
                archive.writestr(name, stripped.getvalue())
            else:
                archive.write(filepath, arcname=name)

    return web.Response(
        body=buffer.getvalue(),
        content_type="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="inx_images.zip"',
            "Cache-Control": "no-store",
        },
    )


@PromptServer.instance.routes.post("/inx/image/delete")
async def handle_delete_image(request):
    global HISTORY_FILES, HISTORY_EPOCH

    try:
        data = await request.json()
        idx = int(data.get("index"))
    except (TypeError, ValueError):
        return web.json_response({"status": "error", "message": "Invalid index."}, status=400)

    if idx < 0 or idx >= len(HISTORY_FILES):
        return web.json_response({"status": "error", "message": "Image not found."}, status=404)

    path = HISTORY_FILES.pop(idx)
    try:
        if os.path.exists(path):
            os.remove(path)
    except OSError:
        pass

    # Indices shift after a removal, so bust the client-side image cache.
    HISTORY_EPOCH = uuid.uuid4().hex
    broadcast_json({"type": "update", "total": len(HISTORY_FILES), "epoch": HISTORY_EPOCH})
    return web.json_response({"status": "deleted", "total": len(HISTORY_FILES), "epoch": HISTORY_EPOCH})


@PromptServer.instance.routes.get("/inx/ws")
async def handle_ws(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    CONNECTED_WEBSOCKETS.add(ws)

    await ws.send_json({
        "type": "init",
        "total": len(HISTORY_FILES),
        "epoch": HISTORY_EPOCH,
        "loop_active": LOOP_ACTIVE,
        "seeds": get_seed_nodes(),
        "settings": settings_state(),
        "presets": list_presets(),
        "current_preset": CURRENT_PRESET
    })

    try:
        async for _ in ws:
            pass
    finally:
        CONNECTED_WEBSOCKETS.remove(ws)
    return ws


@PromptServer.instance.routes.post("/inx/run")
async def handle_run(request):
    global LOOP_ACTIVE
    try:
        data = await request.json()
    except Exception:
        data = {}

    loop = data.get("loop", False)
    LOOP_ACTIVE = bool(loop)

    success, result = await trigger_run()
    if not success:
        LOOP_ACTIVE = False
        return web.json_response({"status": "error", "message": result}, status=400)

    payload = {
        "type": "workflow_status",
        "status": "running",
        "loop_active": LOOP_ACTIVE,
        "prompt_id": result
    }
    for ws in list(CONNECTED_WEBSOCKETS):
        try:
            await ws.send_json(payload)
        except Exception:
            pass

    return web.json_response({"status": "running", "prompt_id": result, "loop_active": LOOP_ACTIVE})


@PromptServer.instance.routes.post("/inx/stop_loop")
async def handle_stop_loop(request):
    global LOOP_ACTIVE
    LOOP_ACTIVE = False
    payload = {
        "type": "workflow_status",
        "status": "loop_stopped",
        "loop_active": False
    }
    for ws in list(CONNECTED_WEBSOCKETS):
        try:
            await ws.send_json(payload)
        except Exception:
            pass
    return web.json_response({"status": "loop_stopped", "loop_active": False})


@PromptServer.instance.routes.post("/inx/cancel")
async def handle_cancel(request):
    global LOOP_ACTIVE, IS_RUNNING
    LOOP_ACTIVE = False
    IS_RUNNING = False

    try:
        PromptServer.instance.prompt_queue.wipe_queue()
    except Exception:
        pass

    try:
        import nodes
        nodes.interrupt_processing()
    except Exception:
        pass

    broadcast_json({"type": "progress", "value": None, "max": None})

    payload = {
        "type": "workflow_status",
        "status": "cancelled",
        "loop_active": False
    }
    for ws in list(CONNECTED_WEBSOCKETS):
        try:
            await ws.send_json(payload)
        except Exception:
            pass

    return web.json_response({"status": "cancelled", "loop_active": False})


@PromptServer.instance.routes.get("/inx/settings")
async def handle_get_settings(request):
    return web.json_response(settings_state())


@PromptServer.instance.routes.post("/inx/settings")
async def handle_post_settings(request):
    global RES_ASPECT, RES_MEGAPIXELS, RES_CUSTOM, RES_CUSTOM_WIDTH, RES_CUSTOM_HEIGHT, SETTINGS_REVISION

    try:
        data = await request.json()
    except Exception:
        data = {}

    for key in ("text", "negative", "steps", "cfg", "sampler_name", "scheduler"):
        if key not in data:
            continue
        value = data[key]
        if value is None:
            GENERATION_OVERRIDES.pop(key, None)
        elif key == "steps":
            try:
                GENERATION_OVERRIDES["steps"] = max(1, min(10000, int(value)))
            except (TypeError, ValueError):
                pass
        elif key == "cfg":
            try:
                GENERATION_OVERRIDES["cfg"] = max(0.0, min(100.0, float(value)))
            except (TypeError, ValueError):
                pass
        elif key == "sampler_name":
            if value in SAMPLERS:
                GENERATION_OVERRIDES["sampler_name"] = value
        elif key == "scheduler":
            if value in SCHEDULERS:
                GENERATION_OVERRIDES["scheduler"] = value
        else:
            GENERATION_OVERRIDES[key] = str(value)

    if "resolution" in data:
        res = data["resolution"]
        if res is None:
            RES_ASPECT = "1:1"
            RES_MEGAPIXELS = 1.5
            RES_CUSTOM = False
            RES_CUSTOM_WIDTH = 1224
            RES_CUSTOM_HEIGHT = 1224
        elif isinstance(res, dict):
            if res.get("aspect") in ASPECT_RATIOS:
                RES_ASPECT = res["aspect"]
            if "megapixels" in res:
                try:
                    RES_MEGAPIXELS = max(0.1, min(8.0, float(res["megapixels"])))
                except (TypeError, ValueError):
                    pass
            if "custom" in res:
                RES_CUSTOM = bool(res["custom"])
            if "width" in res:
                try:
                    RES_CUSTOM_WIDTH = max(16, min(8192, int(res["width"])))
                except (TypeError, ValueError):
                    pass
            if "height" in res:
                try:
                    RES_CUSTOM_HEIGHT = max(16, min(8192, int(res["height"])))
                except (TypeError, ValueError):
                    pass

    SETTINGS_REVISION += 1

    state = settings_state()
    broadcast_json({"type": "settings_update", "settings": state})
    return web.json_response(state)


def _presets_response():
    return {
        "presets": list_presets(),
        "current": CURRENT_PRESET,
        "settings": settings_state(),
        "seeds": get_seed_nodes(),
    }


@PromptServer.instance.routes.get("/inx/presets")
async def handle_get_presets(request):
    return web.json_response({"presets": list_presets(), "current": CURRENT_PRESET})


@PromptServer.instance.routes.post("/inx/presets")
async def handle_post_presets(request):
    global CURRENT_PRESET

    try:
        data = await request.json()
    except Exception:
        data = {}

    action = data.get("action")
    name = data.get("name", "")

    if action == "save":
        safe = _write_preset(name)
        if not safe:
            return web.json_response({"status": "error", "message": "Invalid preset name."}, status=400)
        CURRENT_PRESET = safe
    elif action == "load":
        payload, safe = _read_preset(name)
        if payload is None:
            return web.json_response({"status": "error", "message": "Preset not found."}, status=404)
        apply_preset(payload)
        CURRENT_PRESET = safe
    elif action == "delete":
        path, safe = _preset_path(name)
        if path and os.path.isfile(path):
            try:
                os.remove(path)
            except OSError:
                pass
        if CURRENT_PRESET == safe:
            CURRENT_PRESET = None
    elif action == "unload":
        _reset_settings()
    else:
        return web.json_response({"status": "error", "message": "Unknown preset action."}, status=400)

    response = _presets_response()
    broadcast_json({"type": "presets_update", **response})
    return web.json_response(response)


@PromptServer.instance.routes.get("/inx/seed")
async def handle_get_seed(request):
    return web.json_response({"seeds": get_seed_nodes()})


@PromptServer.instance.routes.post("/inx/seed")
async def handle_post_seed(request):
    global SEED_OVERRIDES

    try:
        data = await request.json()
    except Exception:
        data = {}

    node_id = str(data.get("id", ""))
    mode = data.get("mode", "default")

    valid_ids = {n["id"] for n in get_seed_nodes()}
    if node_id not in valid_ids:
        return web.json_response(
            {"status": "error", "message": "Seed (rgthree) node not found in the active workflow."},
            status=400
        )

    if mode == "default":
        SEED_OVERRIDES.pop(node_id, None)
    elif mode == "random":
        SEED_OVERRIDES[node_id] = {"mode": "random"}
    elif mode == "fixed":
        try:
            value = int(data.get("value"))
        except (TypeError, ValueError):
            return web.json_response({"status": "error", "message": "Invalid seed value."}, status=400)
        value = max(-RGTHREE_SEED_MAX, min(RGTHREE_SEED_MAX, value))
        SEED_OVERRIDES[node_id] = {"mode": "fixed", "value": value}
    elif mode == "new_random":
        value = random.randint(0, RGTHREE_SEED_MAX)
        SEED_OVERRIDES[node_id] = {"mode": "fixed", "value": value}
    else:
        return web.json_response({"status": "error", "message": "Unknown seed mode."}, status=400)

    seeds = get_seed_nodes()
    payload = {"type": "seed_update", "seeds": seeds}
    for ws in list(CONNECTED_WEBSOCKETS):
        try:
            await ws.send_json(payload)
        except Exception:
            pass

    return web.json_response({"status": "ok", "seeds": seeds})


def _do_shutdown():
    try:
        if os.name == "nt":
            # /f force-closes apps that would otherwise block the shutdown.
            subprocess.Popen(["shutdown", "/s", "/f", "/t", "0"])
        else:
            subprocess.Popen(["shutdown", "-h", "now"])
    except Exception as e:
        print(f"[LAN Server] Shutdown failed: {e}")


@PromptServer.instance.routes.post("/inx/shutdown")
async def handle_shutdown(request):
    # Give the HTTP response a moment to reach the browser before powering off.
    try:
        asyncio.get_running_loop().call_later(1.0, _do_shutdown)
    except Exception:
        _do_shutdown()
    return web.json_response({"status": "shutting_down"})


@PromptServer.instance.routes.post("/inx/kill_server")
async def kill_server_endpoint(request):
    global HISTORY_FILES, HISTORY_EPOCH, NEXT_IMAGE_INDEX

    for f in HISTORY_FILES:
        if os.path.exists(f):
            try:
                os.remove(f)
            except OSError:
                pass
    HISTORY_FILES = []
    NEXT_IMAGE_INDEX = 1
    HISTORY_EPOCH = uuid.uuid4().hex

    # Only the gallery is cleared; generation settings and presets are left untouched.
    broadcast_json({"type": "cleared", "epoch": HISTORY_EPOCH})
    return web.json_response({"status": "cleared", "epoch": HISTORY_EPOCH})

# ------------------------------------------------------------------
# Custom Node Classes
# ------------------------------------------------------------------

class ServeImageLAN:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "The images to preview and serve over the LAN."}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "serve"
    OUTPUT_NODE = True
    CATEGORY = "inx"
    DESCRIPTION = "Serves images over the LAN and shows an in-node preview. Passes the image through so it can be chained to other nodes."

    async def serve(self, images, prompt=None, extra_pnginfo=None):
        global HISTORY_FILES, NEXT_IMAGE_INDEX

        ensure_temp_dir()

        metadata = PngInfo()
        if prompt is not None:
            metadata.add_text("prompt", json.dumps(prompt))
        if extra_pnginfo is not None:
            for key in extra_pnginfo:
                metadata.add_text(key, json.dumps(extra_pnginfo[key]))

        temp_dir = folder_paths.get_temp_directory()
        os.makedirs(temp_dir, exist_ok=True)
        full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            "inx_preview", temp_dir, images[0].shape[1], images[0].shape[0]
        )

        preview_images = []
        for image in images:
            i = 255.0 * image.cpu().numpy()
            img = Image.fromarray(np.clip(i, 0, 255).astype('uint8'))

            buffer = io.BytesIO()
            img.save(buffer, format='PNG', pnginfo=metadata, compress_level=1)
            data = buffer.getvalue()

            # In-node preview copy (served by ComfyUI's /view endpoint)
            preview_name = f"{filename}_{counter:05}_.png"
            with open(os.path.join(full_output_folder, preview_name), "wb") as f:
                f.write(data)
            preview_images.append({
                "filename": preview_name,
                "subfolder": subfolder,
                "type": "temp",
            })
            counter += 1

            # LAN history copy (served via /inx/image)
            lan_name = f"img_{NEXT_IMAGE_INDEX:05d}.png"
            NEXT_IMAGE_INDEX += 1
            lan_path = os.path.join(TEMP_DIR, lan_name)
            with open(lan_path, "wb") as f:
                f.write(data)
            HISTORY_FILES.append(lan_path)

        try:
            hostname = socket.gethostname()
            local_ip = socket.gethostbyname(hostname)
        except Exception:
            local_ip = "127.0.0.1"

        port = PromptServer.instance.port

        print(f"\n[Serve Image on LAN] Image added to history ({len(HISTORY_FILES)})")
        print(f" -> Access: http://{local_ip}:{port}/inx/view\n")

        payload = {
            "type": "update",
            "total": len(HISTORY_FILES),
            "epoch": HISTORY_EPOCH
        }

        broadcast_json(payload)

        if LOOP_ACTIVE:
            async def schedule_next():
                await asyncio.sleep(0.5)
                if LOOP_ACTIVE:
                    success, msg = await trigger_run()
                    if not success:
                        print(f"\n[Serve Image on LAN] Loop stopped: {msg}\n")
                        broadcast_json({
                            "type": "workflow_status",
                            "status": "error",
                            "loop_active": False,
                            "message": msg
                        })

            # The next run must be queued on the server's main loop; this code runs
            # on the transient per-prompt loop which is torn down when the prompt ends.
            loop = getattr(PromptServer.instance, "loop", None)
            if loop is not None and loop.is_running():
                try:
                    asyncio.run_coroutine_threadsafe(schedule_next(), loop)
                except Exception:
                    asyncio.create_task(schedule_next())
            else:
                asyncio.create_task(schedule_next())

        return {"ui": {"images": preview_images}, "result": (images,)}


class FetchGenerationSettingsLAN:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "default_text": ("STRING", {"default": "", "multiline": True, "tooltip": "Default positive prompt."}),
                "default_negative": ("STRING", {"default": "", "multiline": True, "tooltip": "Default negative prompt."}),
                "default_steps": ("INT", {"default": 20, "min": 1, "max": 10000, "tooltip": "Default sampling steps."}),
                "default_cfg": ("FLOAT", {"default": 7.0, "min": 0.0, "max": 100.0, "step": 0.1, "tooltip": "Default CFG scale."}),
                "default_sampler_name": (comfy.samplers.KSampler.SAMPLERS,),
                "default_scheduler": (comfy.samplers.KSampler.SCHEDULERS,),
            }
        }

    RETURN_TYPES = ("STRING", "STRING", "INT", "INT", "INT", "FLOAT",
                    comfy.samplers.KSampler.SAMPLERS, comfy.samplers.KSampler.SCHEDULERS)
    RETURN_NAMES = ("text", "negative", "width", "height", "steps", "cfg", "sampler_name", "scheduler")
    FUNCTION = "fetch"
    CATEGORY = "inx"
    DESCRIPTION = "Outputs generation settings (prompt, negative, size, steps, cfg, sampler, scheduler) editable from the LAN web interface."

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        s = get_effective_settings()
        return (SETTINGS_REVISION, s["text"], s["negative"], s["width"], s["height"],
                s["steps"], s["cfg"], s["sampler_name"], s["scheduler"])

    def fetch(self, default_text="", default_negative="", default_steps=20, default_cfg=7.0,
              default_sampler_name=None, default_scheduler=None):
        if isinstance(default_text, list):
            default_text = default_text[0] if default_text else ""
        if isinstance(default_negative, list):
            default_negative = default_negative[0] if default_negative else ""

        GENERATION_DEFAULTS["text"] = str(default_text or "")
        GENERATION_DEFAULTS["negative"] = str(default_negative or "")
        GENERATION_DEFAULTS["steps"] = int(default_steps)
        GENERATION_DEFAULTS["cfg"] = float(default_cfg)
        if default_sampler_name in SAMPLERS:
            GENERATION_DEFAULTS["sampler_name"] = default_sampler_name
        if default_scheduler in SCHEDULERS:
            GENERATION_DEFAULTS["scheduler"] = default_scheduler

        settings = get_effective_settings()
        print(f"\n[Fetch Generation Settings on LAN] size={settings['width']}x{settings['height']} "
              f"steps={settings['steps']} cfg={settings['cfg']} "
              f"sampler={settings['sampler_name']} scheduler={settings['scheduler']}")
        print(f" -> text: \"{settings['text'][:60]}\"\n")

        return (
            settings["text"],
            settings["negative"],
            settings["width"],
            settings["height"],
            settings["steps"],
            settings["cfg"],
            settings["sampler_name"],
            settings["scheduler"],
        )