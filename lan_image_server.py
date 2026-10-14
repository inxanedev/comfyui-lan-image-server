import os
import shutil
import socket
from PIL import Image
from aiohttp import web
from server import PromptServer

# Directory configuration
NODE_DIR = os.path.dirname(os.path.realpath(__file__))
TEMP_DIR = os.path.join(NODE_DIR, "temp")

# State variables
CONNECTED_WEBSOCKETS = set()
HISTORY_FILES = []
SERVER_INITIALIZED = False
DEFAULT_TEXT = ""
CUSTOM_TEXT = None
TEXT_REVISION = 0

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
                        import asyncio
                        asyncio.create_task(ws.send_bytes(data))
                    except Exception:
                        pass

        return await original_send_bytes(event, data, sid=sid)

    PromptServer.instance.send_bytes = hooked_send_bytes.__get__(
        PromptServer.instance, PromptServer
    )

# ------------------------------------------------------------------
# Web Server Routes
# ------------------------------------------------------------------

@PromptServer.instance.routes.get("/inx/view")
async def handle_index(request):
    html_content = """
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>ComfyUI Live LAN View</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                background-color: #0e0e10;
                color: #fff;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                display: flex;
                flex-direction: column;
                height: 100vh;
                height: 100dvh;
                overflow: hidden;
            }
            #tabs {
                display: flex;
                background: #18181c;
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            }
            .tab-btn {
                flex: 1;
                padding: 12px;
                background: transparent;
                color: #888;
                border: none;
                font-size: 14px;
                font-weight: 600;
                cursor: pointer;
                border-bottom: 2px solid transparent;
                transition: all 0.2s ease;
            }
            .tab-btn.active {
                color: #fff;
                border-bottom-color: #4CAF50;
                background: rgba(255, 255, 255, 0.03);
            }
            #viewer {
                flex: 1;
                display: flex;
                justify-content: center;
                align-items: center;
                overflow: hidden;
                position: relative;
            }
            img {
                max-width: 100%;
                max-height: 100%;
                object-fit: contain;
                display: block;
            }
            #controls {
                background: rgba(18, 18, 20, 0.95);
                backdrop-filter: blur(10px);
                border-top: 1px solid rgba(255, 255, 255, 0.1);
                padding: 12px 16px;
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                z-index: 10;
            }
            .btn {
                background: #2a2a30;
                color: #fff;
                border: 1px solid rgba(255, 255, 255, 0.15);
                padding: 10px 16px;
                border-radius: 8px;
                font-size: 14px;
                font-weight: 600;
                cursor: pointer;
                user-select: none;
                touch-action: manipulation;
                transition: background 0.15s ease;
            }
            .btn:active { background: #3a3a42; }
            .btn:disabled { opacity: 0.3; cursor: not-allowed; }
            .btn-danger { background: #8b0000; border-color: #a00000; }
            .btn-danger:active { background: #b22222; }
            #counter {
                font-size: 14px;
                font-weight: 600;
                min-width: 60px;
                text-align: center;
                letter-spacing: 0.5px;
            }
            #status {
                position: absolute;
                top: 10px;
                right: 10px;
                background: rgba(0,0,0,0.75);
                padding: 4px 8px;
                border-radius: 6px;
                font-size: 11px;
                pointer-events: none;
                z-index: 5;
            }
            .group { display: flex; align-items: center; gap: 8px; }
            #placeholder {
                color: #555;
                font-size: 14px;
                text-align: center;
            }
            #promptContainer {
                flex: 1;
                display: none;
                flex-direction: column;
                padding: 16px;
                gap: 12px;
                overflow: hidden;
                box-sizing: border-box;
            }
            .prompt-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 8px;
            }
            .badge {
                font-size: 11px;
                padding: 3px 8px;
                border-radius: 12px;
                font-weight: 600;
                letter-spacing: 0.3px;
                background: rgba(255, 255, 255, 0.08);
                color: #aaa;
                transition: all 0.2s ease;
            }
            .badge-custom {
                background: rgba(76, 175, 80, 0.2);
                color: #4CAF50;
                border: 1px solid rgba(76, 175, 80, 0.4);
            }
            #defaultPromptBox {
                display: none;
                background: #141418;
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 8px;
                padding: 10px 12px;
                font-size: 12px;
                color: #999;
                box-sizing: border-box;
            }
            #defaultPromptTitle {
                font-weight: 600;
                margin-bottom: 4px;
                color: #aaa;
                font-size: 11px;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            #defaultPromptText {
                white-space: pre-wrap;
                word-break: break-word;
                max-height: 60px;
                overflow-y: auto;
                color: #bbb;
            }
            #promptInput {
                flex: 1;
                width: 100%;
                background: #141418;
                color: #fff;
                border: 1px solid rgba(255, 255, 255, 0.15);
                border-radius: 8px;
                padding: 12px;
                font-family: inherit;
                font-size: 15px;
                line-height: 1.5;
                resize: none;
                outline: none;
                box-sizing: border-box;
                transition: border-color 0.2s ease;
            }
            #promptInput:focus {
                border-color: #4CAF50;
            }
            .prompt-actions {
                display: flex;
                gap: 10px;
                align-items: center;
            }
            .btn-save {
                background: #2e7d32;
                border-color: #388e3c;
            }
            .btn-save:active {
                background: #388e3c;
            }
            #promptNotice {
                font-size: 12px;
                text-align: center;
                min-height: 16px;
                color: #888;
            }
        </style>
    </head>
    <body>
        <div id="tabs">
            <button id="tabGallery" class="tab-btn active" onclick="switchTab('gallery')">Gallery</button>
            <button id="tabLive" class="tab-btn" onclick="switchTab('live')">Live Preview</button>
            <button id="tabPrompt" class="tab-btn" onclick="switchTab('prompt')">Prompt</button>
        </div>

        <div id="viewer">
            <div id="status">Connecting...</div>
            <img id="display" src="" alt="Served Image" style="display:none;">
            <div id="placeholder">No images available</div>
        </div>

        <div id="promptContainer">
            <div class="prompt-header">
                <span style="font-weight: 600; font-size: 14px; color: #aaa;">Workflow Text / Prompt</span>
                <span id="promptBadge" class="badge">Default</span>
            </div>

            <div id="defaultPromptBox">
                <div id="defaultPromptTitle">Workflow Default</div>
                <div id="defaultPromptText"></div>
            </div>

            <textarea id="promptInput" placeholder="Enter custom prompt text here..."></textarea>

            <div class="prompt-actions">
                <button id="revertBtn" class="btn" onclick="revertText()" style="flex: 1;" disabled>Revert to default</button>
                <button id="saveBtn" class="btn btn-save" onclick="saveText()" style="flex: 1;">Save</button>
            </div>
            <div id="promptNotice"></div>
        </div>

        <div id="controls">
            <div class="group">
                <button id="prevBtn" class="btn" onclick="navigate(-1)" disabled>Prev</button>
                <span id="counter">0 / 0</span>
                <button id="nextBtn" class="btn" onclick="navigate(1)" disabled>Next</button>
            </div>
            <button id="killBtn" class="btn btn-danger" onclick="killServer()">Clear / Kill</button>
        </div>

        <script>
            const viewer = document.getElementById('viewer');
            const img = document.getElementById('display');
            const placeholder = document.getElementById('placeholder');
            const status = document.getElementById('status');
            const prevBtn = document.getElementById('prevBtn');
            const nextBtn = document.getElementById('nextBtn');
            const counter = document.getElementById('counter');
            const tabGallery = document.getElementById('tabGallery');
            const tabLive = document.getElementById('tabLive');
            const tabPrompt = document.getElementById('tabPrompt');
            const controls = document.getElementById('controls');

            const promptContainer = document.getElementById('promptContainer');
            const promptInput = document.getElementById('promptInput');
            const defaultPromptBox = document.getElementById('defaultPromptBox');
            const defaultPromptText = document.getElementById('defaultPromptText');
            const promptBadge = document.getElementById('promptBadge');
            const revertBtn = document.getElementById('revertBtn');
            const saveBtn = document.getElementById('saveBtn');
            const promptNotice = document.getElementById('promptNotice');

            let currentTab = 'gallery';
            let totalImages = 0;
            let currentIndex = 0;
            let livePreviewUrl = null;

            let defaultText = '';
            let customText = null;
            let isCustom = false;

            function switchTab(tab) {
                currentTab = tab;
                tabGallery.classList.toggle('active', tab === 'gallery');
                tabLive.classList.toggle('active', tab === 'live');
                tabPrompt.classList.toggle('active', tab === 'prompt');

                if (tab === 'gallery') {
                    viewer.style.display = 'flex';
                    promptContainer.style.display = 'none';
                    controls.style.display = 'flex';
                    updateGalleryImage();
                } else if (tab === 'live') {
                    viewer.style.display = 'flex';
                    promptContainer.style.display = 'none';
                    controls.style.display = 'none';
                    updateLiveImage();
                } else if (tab === 'prompt') {
                    viewer.style.display = 'none';
                    controls.style.display = 'none';
                    promptContainer.style.display = 'flex';
                }
            }

            function updatePromptUI(data) {
                if (data.default_text !== undefined) defaultText = data.default_text || '';
                if (data.custom_text !== undefined) customText = data.custom_text;
                isCustom = (customText !== null && customText !== undefined);

                defaultPromptText.textContent = defaultText;

                if (isCustom) {
                    promptBadge.textContent = 'Customized';
                    promptBadge.classList.add('badge-custom');
                    defaultPromptBox.style.display = defaultText ? 'block' : 'none';
                    revertBtn.disabled = false;
                } else {
                    promptBadge.textContent = 'Default';
                    promptBadge.classList.remove('badge-custom');
                    defaultPromptBox.style.display = 'none';
                    revertBtn.disabled = true;
                }

                if (document.activeElement !== promptInput) {
                    promptInput.value = isCustom ? customText : defaultText;
                }
            }

            async function saveText() {
                const text = promptInput.value;
                saveBtn.disabled = true;
                promptNotice.textContent = 'Saving...';
                promptNotice.style.color = '#aaa';

                try {
                    const resp = await fetch('/inx/text', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text: text })
                    });
                    if (!resp.ok) throw new Error('Save failed');
                    customText = text;
                    isCustom = true;
                    updatePromptUI({ default_text: defaultText, custom_text: customText });
                    promptNotice.textContent = 'Saved! ComfyUI will use this text.';
                    promptNotice.style.color = '#4CAF50';
                    setTimeout(() => {
                        if (promptNotice.textContent.startsWith('Saved')) promptNotice.textContent = '';
                    }, 3000);
                } catch (e) {
                    promptNotice.textContent = 'Error saving text.';
                    promptNotice.style.color = '#F44336';
                } finally {
                    saveBtn.disabled = false;
                }
            }

            async function revertText() {
                revertBtn.disabled = true;
                promptNotice.textContent = 'Reverting...';
                promptNotice.style.color = '#aaa';

                try {
                    const resp = await fetch('/inx/revert_text', { method: 'POST' });
                    if (!resp.ok) throw new Error('Revert failed');
                    customText = null;
                    isCustom = false;
                    promptInput.value = defaultText;
                    updatePromptUI({ default_text: defaultText, custom_text: null });
                    promptNotice.textContent = 'Reverted to workflow default.';
                    promptNotice.style.color = '#4CAF50';
                    setTimeout(() => {
                        if (promptNotice.textContent.startsWith('Reverted')) promptNotice.textContent = '';
                    }, 3000);
                } catch (e) {
                    promptNotice.textContent = 'Error reverting text.';
                    promptNotice.style.color = '#F44336';
                    revertBtn.disabled = false;
                }
            }

            function updateGalleryImage() {
                if (totalImages === 0) {
                    img.style.display = 'none';
                    placeholder.style.display = 'block';
                    placeholder.textContent = 'No gallery images yet.';
                    counter.textContent = '0 / 0';
                    prevBtn.disabled = true;
                    nextBtn.disabled = true;
                    return;
                }

                placeholder.style.display = 'none';
                img.style.display = 'block';
                img.src = `/inx/image?index=${currentIndex - 1}&t=${new Date().getTime()}`;
                counter.textContent = `${currentIndex} / ${totalImages}`;
                
                prevBtn.disabled = (currentIndex <= 1);
                nextBtn.disabled = (currentIndex >= totalImages);
            }

            function updateLiveImage() {
                if (!livePreviewUrl) {
                    img.style.display = 'none';
                    placeholder.style.display = 'block';
                    placeholder.textContent = 'Waiting for KSampler live preview...';
                } else {
                    placeholder.style.display = 'none';
                    img.style.display = 'block';
                    img.src = livePreviewUrl;
                }
            }

            function navigate(delta) {
                const newIndex = currentIndex + delta;
                if (newIndex >= 1 && newIndex <= totalImages) {
                    currentIndex = newIndex;
                    updateGalleryImage();
                }
            }

            function connectWS() {
                const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const ws = new WebSocket(`${wsProtocol}//${window.location.host}/inx/ws`);

                ws.binaryType = 'arraybuffer';

                ws.onopen = () => {
                    status.textContent = 'Live Connected';
                    status.style.color = '#4CAF50';
                };

                ws.onmessage = (event) => {
                    if (event.data instanceof ArrayBuffer) {
                        const bytes = new Uint8Array(event.data);
                        
                        let startOffset = -1;
                        let mimeType = 'image/jpeg';

                        // Scan for JPEG Magic Bytes (0xFF, 0xD8)
                        for (let i = 0; i < bytes.length - 1; i++) {
                            if (bytes[i] === 0xFF && bytes[i + 1] === 0xD8) {
                                startOffset = i;
                                mimeType = 'image/jpeg';
                                break;
                            }
                        }

                        // Scan for PNG Magic Bytes (0x89, 'P', 'N', 'G')
                        if (startOffset === -1) {
                            for (let i = 0; i < bytes.length - 3; i++) {
                                if (bytes[i] === 0x89 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x4E && bytes[i + 3] === 0x47) {
                                    startOffset = i;
                                    mimeType = 'image/png';
                                    break;
                                }
                            }
                        }

                        if (startOffset !== -1) {
                            const imageBuffer = event.data.slice(startOffset);
                            const blob = new Blob([imageBuffer], { type: mimeType });
                            
                            const newUrl = URL.createObjectURL(blob);
                            if (livePreviewUrl && livePreviewUrl.startsWith('blob:')) {
                                URL.revokeObjectURL(livePreviewUrl);
                            }
                            livePreviewUrl = newUrl;

                            if (currentTab === 'live') {
                                updateLiveImage();
                            }
                        }
                    } else if (typeof event.data === 'string') {
                        try {
                            const data = JSON.parse(event.data);
                            
                            if (data.type === 'init' || data.type === 'update') {
                                const previousTotal = totalImages;
                                const wasAtLatest = (currentIndex === previousTotal) || (previousTotal === 0);
                                
                                totalImages = data.total;

                                if (wasAtLatest) {
                                    currentIndex = totalImages;
                                }

                                // When the final image is saved by the node, auto-update the Live Preview tab
                                if (totalImages > 0) {
                                    if (livePreviewUrl && livePreviewUrl.startsWith('blob:')) {
                                        URL.revokeObjectURL(livePreviewUrl);
                                    }
                                    livePreviewUrl = `/inx/image?index=${totalImages - 1}&t=${new Date().getTime()}`;
                                    if (currentTab === 'live') {
                                        updateLiveImage();
                                    }
                                }

                                if (currentTab === 'gallery') {
                                    updateGalleryImage();
                                }

                                if (data.type === 'init') {
                                    updatePromptUI(data);
                                }
                            } else if (data.type === 'text_update') {
                                updatePromptUI(data);
                            } else if (data.type === 'cleared') {
                                totalImages = 0;
                                currentIndex = 0;
                                if (livePreviewUrl && livePreviewUrl.startsWith('blob:')) {
                                    URL.revokeObjectURL(livePreviewUrl);
                                }
                                livePreviewUrl = null;
                                if (currentTab === 'gallery') updateGalleryImage();
                                else updateLiveImage();
                            }
                        } catch (e) {}
                    }
                };

                ws.onclose = () => {
                    status.textContent = 'Disconnected';
                    status.style.color = '#F44336';
                    setTimeout(connectWS, 2000);
                };

                ws.onerror = () => ws.close();
            }

            function killServer() {
                if (confirm("Clear image history and close active session?")) {
                    fetch('/inx/kill_server', { method: 'POST' });
                }
            }

            connectWS();
            fetch('/inx/text')
                .then(r => r.json())
                .then(data => updatePromptUI(data))
                .catch(() => {});
        </script>
    </body>
    </html>
    """
    return web.Response(text=html_content, content_type='text/html')


@PromptServer.instance.routes.get("/inx/image")
async def handle_image(request):
    index_param = request.query.get("index", None)
    
    if not HISTORY_FILES:
        return web.Response(status=404, text="No images available.")

    try:
        idx = int(index_param) if index_param is not None else len(HISTORY_FILES) - 1
        filepath = HISTORY_FILES[idx]
        with open(filepath, "rb") as f:
            return web.Response(body=f.read(), content_type='image/png')
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
        "default_text": DEFAULT_TEXT,
        "custom_text": CUSTOM_TEXT,
        "is_custom": CUSTOM_TEXT is not None
    })

    try:
        async for _ in ws:
            pass
    finally:
        CONNECTED_WEBSOCKETS.remove(ws)
    return ws


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


@PromptServer.instance.routes.post("/inx/kill_server")
async def kill_server_endpoint(request):
    global HISTORY_FILES
    
    for f in HISTORY_FILES:
        if os.path.exists(f):
            try:
                os.remove(f)
            except OSError:
                pass
    HISTORY_FILES = []

    for ws in list(CONNECTED_WEBSOCKETS):
        try:
            await ws.send_json({"type": "cleared"})
        except Exception:
            pass

    return web.json_response({"status": "cleared"})

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
                "images": ("IMAGE",),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "serve"
    OUTPUT_NODE = True
    CATEGORY = "inx"

    async def serve(self, images):
        global HISTORY_FILES

        ensure_clean_temp_dir()

        i = 255.0 * images[0].cpu().numpy()
        img = Image.fromarray(i.astype('uint8'))
        
        filename = f"img_{len(HISTORY_FILES) + 1:05d}.png"
        filepath = os.path.join(TEMP_DIR, filename)
        img.save(filepath, format='PNG')
        HISTORY_FILES.append(filepath)

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
            "total": len(HISTORY_FILES)
        }
        
        for ws in list(CONNECTED_WEBSOCKETS):
            try:
                await ws.send_json(payload)
            except Exception:
                pass

        return ()


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

        for ws in list(CONNECTED_WEBSOCKETS):
            try:
                await ws.send_json(payload)
            except Exception:
                pass

        return (effective_text,)