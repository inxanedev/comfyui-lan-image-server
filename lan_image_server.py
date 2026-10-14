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
        </style>
    </head>
    <body>
        <div id="tabs">
            <button id="tabGallery" class="tab-btn active" onclick="switchTab('gallery')">Gallery</button>
            <button id="tabLive" class="tab-btn" onclick="switchTab('live')">Live Preview</button>
        </div>

        <div id="viewer">
            <div id="status">Connecting...</div>
            <img id="display" src="" alt="Served Image" style="display:none;">
            <div id="placeholder">No images available</div>
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
            const img = document.getElementById('display');
            const placeholder = document.getElementById('placeholder');
            const status = document.getElementById('status');
            const prevBtn = document.getElementById('prevBtn');
            const nextBtn = document.getElementById('nextBtn');
            const counter = document.getElementById('counter');
            const tabGallery = document.getElementById('tabGallery');
            const tabLive = document.getElementById('tabLive');
            const controls = document.getElementById('controls');

            let currentTab = 'gallery';
            let totalImages = 0;
            let currentIndex = 0;
            let livePreviewUrl = null;

            function switchTab(tab) {
                currentTab = tab;
                if (tab === 'gallery') {
                    tabGallery.classList.add('active');
                    tabLive.classList.remove('active');
                    controls.style.display = 'flex';
                    updateGalleryImage();
                } else {
                    tabLive.classList.add('active');
                    tabGallery.classList.remove('active');
                    controls.style.display = 'none';
                    updateLiveImage();
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
        "total": len(HISTORY_FILES)
    })

    try:
        async for _ in ws:
            pass
    finally:
        CONNECTED_WEBSOCKETS.remove(ws)
    return ws


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
# Custom Node Class
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