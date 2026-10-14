import asyncio
import copy
import io
import json
import math
import os
import random
import shutil
import socket
import subprocess
import time
import uuid
import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo
from aiohttp import web
from server import PromptServer

import folder_paths

# Directory configuration
NODE_DIR = os.path.dirname(os.path.realpath(__file__))
TEMP_DIR = os.path.join(NODE_DIR, "temp")
UI_DIR = os.path.join(NODE_DIR, "ui")

# State variables
CONNECTED_WEBSOCKETS = set()
HISTORY_FILES = []
HISTORY_EPOCH = uuid.uuid4().hex
SERVER_INITIALIZED = False
DEFAULT_TEXT = ""
CUSTOM_TEXT = None
TEXT_REVISION = 0

LAST_PROMPT_INFO = None
LOOP_ACTIVE = False
IS_RUNNING = False

# rgthree Seed node integration
RGTHREE_SEED_CLASS = "Seed (rgthree)"
RGTHREE_SEED_MAX = 1125899906842624
SEED_OVERRIDES = {}
SKIP_NEXT_CAPTURE = False

# Resolution settings (Serve Resolution on LAN)
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
RESOLUTION_REVISION = 0

def ensure_clean_temp_dir():
    """Clears the temp directory when the server starts for the first time."""
    global SERVER_INITIALIZED, HISTORY_FILES
    if not SERVER_INITIALIZED:
        if os.path.exists(TEMP_DIR):
            shutil.rmtree(TEMP_DIR)
        os.makedirs(TEMP_DIR, exist_ok=True)
        HISTORY_FILES = []
        SERVER_INITIALIZED = True

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
    
    if not HISTORY_FILES:
        return web.Response(status=404, text="No images available.")

    try:
        idx = int(index_param) if index_param is not None else len(HISTORY_FILES) - 1
        filepath = HISTORY_FILES[idx]
        with open(filepath, "rb") as f:
            return web.Response(
                body=f.read(),
                content_type='image/png',
                headers={"Cache-Control": "public, max-age=31536000, immutable"}
            )
    except (IndexError, ValueError, OSError):
        return web.Response(status=404, text="Image not found.")


@PromptServer.instance.routes.get("/inx/ws")
async def handle_ws(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    CONNECTED_WEBSOCKETS.add(ws)

    await ws.send_json({
        "type": "init",
        "total": len(HISTORY_FILES),
        "epoch": HISTORY_EPOCH,
        "default_text": DEFAULT_TEXT,
        "custom_text": CUSTOM_TEXT,
        "is_custom": CUSTOM_TEXT is not None,
        "loop_active": LOOP_ACTIVE,
        "seeds": get_seed_nodes(),
        "resolution": resolution_state()
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


@PromptServer.instance.routes.get("/inx/text")
async def handle_get_text(request):
    return web.json_response({
        "default_text": DEFAULT_TEXT,
        "custom_text": CUSTOM_TEXT,
        "effective_text": CUSTOM_TEXT if CUSTOM_TEXT is not None else DEFAULT_TEXT,
        "is_custom": CUSTOM_TEXT is not None
    })


@PromptServer.instance.routes.post("/inx/text")
async def handle_post_text(request):
    global CUSTOM_TEXT, TEXT_REVISION
    try:
        data = await request.json()
        text = data.get("text", "")
        CUSTOM_TEXT = str(text)
        TEXT_REVISION += 1

        payload = {
            "type": "text_update",
            "default_text": DEFAULT_TEXT,
            "custom_text": CUSTOM_TEXT,
            "effective_text": CUSTOM_TEXT,
            "is_custom": True
        }

        for ws in list(CONNECTED_WEBSOCKETS):
            try:
                await ws.send_json(payload)
            except Exception:
                pass

        return web.json_response({"status": "saved", "is_custom": True})
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=400)


@PromptServer.instance.routes.post("/inx/revert_text")
async def handle_revert_text(request):
    global CUSTOM_TEXT, TEXT_REVISION
    CUSTOM_TEXT = None
    TEXT_REVISION += 1

    payload = {
        "type": "text_update",
        "default_text": DEFAULT_TEXT,
        "custom_text": None,
        "effective_text": DEFAULT_TEXT,
        "is_custom": False
    }

    for ws in list(CONNECTED_WEBSOCKETS):
        try:
            await ws.send_json(payload)
        except Exception:
            pass

    return web.json_response({"status": "reverted", "is_custom": False})


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


@PromptServer.instance.routes.get("/inx/resolution")
async def handle_get_resolution(request):
    return web.json_response(resolution_state())


@PromptServer.instance.routes.post("/inx/resolution")
async def handle_post_resolution(request):
    global RES_ASPECT, RES_MEGAPIXELS, RES_CUSTOM, RES_CUSTOM_WIDTH, RES_CUSTOM_HEIGHT, RESOLUTION_REVISION

    try:
        data = await request.json()
    except Exception:
        data = {}

    if data.get("aspect") in ASPECT_RATIOS:
        RES_ASPECT = data["aspect"]

    if "megapixels" in data:
        try:
            RES_MEGAPIXELS = max(0.1, min(8.0, float(data["megapixels"])))
        except (TypeError, ValueError):
            pass

    if "custom" in data:
        RES_CUSTOM = bool(data["custom"])

    if "width" in data:
        try:
            RES_CUSTOM_WIDTH = max(16, min(8192, int(data["width"])))
        except (TypeError, ValueError):
            pass

    if "height" in data:
        try:
            RES_CUSTOM_HEIGHT = max(16, min(8192, int(data["height"])))
        except (TypeError, ValueError):
            pass

    RESOLUTION_REVISION += 1

    state = resolution_state()
    payload = {"type": "resolution_update", **state}
    for ws in list(CONNECTED_WEBSOCKETS):
        try:
            await ws.send_json(payload)
        except Exception:
            pass

    return web.json_response(state)


def _do_shutdown():
    try:
        if os.name == "nt":
            subprocess.Popen(["shutdown", "/s", "/t", "0"])
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
    global HISTORY_FILES, HISTORY_EPOCH, CUSTOM_TEXT, TEXT_REVISION
    global RES_ASPECT, RES_MEGAPIXELS, RES_CUSTOM, RES_CUSTOM_WIDTH, RES_CUSTOM_HEIGHT, RESOLUTION_REVISION

    for f in HISTORY_FILES:
        if os.path.exists(f):
            try:
                os.remove(f)
            except OSError:
                pass
    HISTORY_FILES = []
    HISTORY_EPOCH = uuid.uuid4().hex

    # Reset remote overrides so a fresh session never leaks settings into another workflow.
    CUSTOM_TEXT = None
    TEXT_REVISION += 1
    SEED_OVERRIDES.clear()
    RES_ASPECT = "1:1"
    RES_MEGAPIXELS = 1.5
    RES_CUSTOM = False
    RES_CUSTOM_WIDTH = 1224
    RES_CUSTOM_HEIGHT = 1224
    RESOLUTION_REVISION += 1

    payloads = [
        {"type": "cleared", "epoch": HISTORY_EPOCH},
        {
            "type": "text_update",
            "default_text": DEFAULT_TEXT,
            "custom_text": None,
            "effective_text": DEFAULT_TEXT,
            "is_custom": False
        },
        {"type": "seed_update", "seeds": get_seed_nodes()},
        {"type": "resolution_update", **resolution_state()},
    ]

    for ws in list(CONNECTED_WEBSOCKETS):
        for payload in payloads:
            try:
                await ws.send_json(payload)
            except Exception:
                pass

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
        global HISTORY_FILES

        ensure_clean_temp_dir()

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
            lan_name = f"img_{len(HISTORY_FILES) + 1:05d}.png"
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


class ServeResolutionLAN:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("width", "height")
    FUNCTION = "serve_resolution"
    CATEGORY = "inx"
    DESCRIPTION = "Outputs a width and height configured from the LAN web interface (aspect ratio + megapixels, or custom values)."

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        width, height = get_effective_resolution()
        return (RESOLUTION_REVISION, width, height)

    def serve_resolution(self):
        width, height = get_effective_resolution()
        print(f"\n[Serve Resolution on LAN] Outputting {width} x {height}\n")
        return (width, height)


class ServeTextLAN:
    def __init__(self):
        pass

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "default_text": ("STRING", {"default": "", "multiline": True}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "serve_text"
    CATEGORY = "inx"
    DESCRIPTION = "Outputs text that can be edited from the LAN web interface. Connect it to a CLIPTextEncode (or any text input) to change prompts remotely."

    @classmethod
    def IS_CHANGED(cls, default_text="", **kwargs):
        global TEXT_REVISION
        return (str(default_text), str(CUSTOM_TEXT), TEXT_REVISION)

    async def serve_text(self, default_text=""):
        global DEFAULT_TEXT, CUSTOM_TEXT, TEXT_REVISION

        if isinstance(default_text, list):
            default_text = default_text[0] if default_text else ""
        elif default_text is None:
            default_text = ""

        if DEFAULT_TEXT != default_text:
            DEFAULT_TEXT = default_text
            TEXT_REVISION += 1

        is_custom = (CUSTOM_TEXT is not None)
        effective_text = CUSTOM_TEXT if is_custom else DEFAULT_TEXT

        preview_snippet = effective_text[:60] + ('...' if len(effective_text) > 60 else '')
        print(f"\n[Serve Text on LAN] Outputting {'customized' if is_custom else 'default'} text:")
        print(f" -> Text: \"{preview_snippet}\"\n")

        payload = {
            "type": "text_update",
            "default_text": DEFAULT_TEXT,
            "custom_text": CUSTOM_TEXT,
            "effective_text": effective_text,
            "is_custom": is_custom
        }

        broadcast_json(payload)

        return (effective_text,)