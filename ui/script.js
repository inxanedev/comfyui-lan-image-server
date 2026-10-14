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

const runBtn = document.getElementById('runBtn');
const loopBtn = document.getElementById('loopBtn');
const cancelBtn = document.getElementById('cancelBtn');
const galleryBar = document.getElementById('galleryBar');
const workflowBar = document.getElementById('workflowBar');

let currentTab = 'gallery';
let totalImages = 0;
let currentIndex = 0;
let livePreviewUrl = null;

let defaultText = '';
let customText = null;
let isCustom = false;
let loopActive = false;

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
let zoomScale = 1;
let zoomTx = 0;
let zoomTy = 0;
let gesture = null;

function clampZoom() {
    const rect = viewer.getBoundingClientRect();
    const scaledW = img.offsetWidth * zoomScale;
    const scaledH = img.offsetHeight * zoomScale;
    const maxTx = Math.max(0, (scaledW - rect.width) / 2);
    const maxTy = Math.max(0, (scaledH - rect.height) / 2);
    zoomTx = Math.min(maxTx, Math.max(-maxTx, zoomTx));
    zoomTy = Math.min(maxTy, Math.max(-maxTy, zoomTy));
}

function applyZoom() {
    if (zoomScale <= 1.001) {
        zoomScale = 1;
        zoomTx = 0;
        zoomTy = 0;
        img.style.transform = '';
        return;
    }
    clampZoom();
    img.style.transform = `translate(${zoomTx}px, ${zoomTy}px) scale(${zoomScale})`;
}

function resetZoom() {
    zoomScale = 1;
    zoomTx = 0;
    zoomTy = 0;
    img.style.transform = '';
}

function initZoomGestures() {
    viewer.addEventListener('touchstart', (e) => {
        if (img.style.display === 'none') return;

        if (e.touches.length === 2) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            gesture = {
                mode: 'pinch',
                startDist: Math.hypot(dx, dy) || 1,
                startScale: zoomScale,
                startTx: zoomTx,
                startTy: zoomTy,
                startMidX: (e.touches[0].clientX + e.touches[1].clientX) / 2,
                startMidY: (e.touches[0].clientY + e.touches[1].clientY) / 2
            };
        } else if (e.touches.length === 1) {
            gesture = {
                mode: 'pan',
                startX: e.touches[0].clientX,
                startY: e.touches[0].clientY,
                startTx: zoomTx,
                startTy: zoomTy
            };
        }
    }, { passive: false });

    viewer.addEventListener('touchmove', (e) => {
        if (!gesture) return;

        if (e.touches.length === 2 && gesture.mode === 'pinch') {
            e.preventDefault();

            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const dist = Math.hypot(dx, dy) || 1;
            const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
            const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;

            const rect = viewer.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;

            const s0 = gesture.startScale;
            const f0x = gesture.startMidX - cx;
            const f0y = gesture.startMidY - cy;

            let newScale = s0 * (dist / gesture.startDist);
            newScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newScale));
            zoomScale = newScale;

            zoomTx = gesture.startTx
                + (s0 - newScale) * (f0x - gesture.startTx) / s0
                + ((midX - cx) - f0x);
            zoomTy = gesture.startTy
                + (s0 - newScale) * (f0y - gesture.startTy) / s0
                + ((midY - cy) - f0y);

            applyZoom();
        } else if (e.touches.length === 1 && gesture.mode === 'pan') {
            if (zoomScale <= 1) return;
            e.preventDefault();
            zoomTx = gesture.startTx + (e.touches[0].clientX - gesture.startX);
            zoomTy = gesture.startTy + (e.touches[0].clientY - gesture.startY);
            applyZoom();
        }
    }, { passive: false });

    viewer.addEventListener('touchend', (e) => {
        if (e.touches.length === 1) {
            gesture = {
                mode: 'pan',
                startX: e.touches[0].clientX,
                startY: e.touches[0].clientY,
                startTx: zoomTx,
                startTy: zoomTy
            };
            return;
        }

        if (e.touches.length === 0) {
            gesture = null;
            resetZoom();
        }
    }, { passive: false });

    viewer.addEventListener('touchcancel', () => {
        gesture = null;
        resetZoom();
    });
}

function switchTab(tab) {
    currentTab = tab;
    tabGallery.classList.toggle('active', tab === 'gallery');
    tabLive.classList.toggle('active', tab === 'live');
    tabPrompt.classList.toggle('active', tab === 'prompt');

    if (tab === 'gallery') {
        viewer.style.display = 'flex';
        promptContainer.style.display = 'none';
        galleryBar.style.display = 'flex';
        updateGalleryImage();
    } else if (tab === 'live') {
        viewer.style.display = 'flex';
        promptContainer.style.display = 'none';
        galleryBar.style.display = 'none';
        updateLiveImage();
    } else if (tab === 'prompt') {
        viewer.style.display = 'none';
        promptContainer.style.display = 'flex';
        galleryBar.style.display = 'none';
    }
}

function updateWorkflowUI(data) {
    if (data.loop_active !== undefined) {
        loopActive = !!data.loop_active;
        if (loopActive) {
            loopBtn.textContent = 'Stop Loop';
            loopBtn.classList.add('active');
            status.textContent = 'Looping (Instant)...';
            status.style.color = '#FFA000';
        } else {
            loopBtn.textContent = 'Run (Instant)';
            loopBtn.classList.remove('active');
            if (status.textContent.includes('Looping')) {
                status.textContent = 'Ready';
                status.style.color = '#4CAF50';
            }
        }
    }
}

async function runOnce() {
    if (currentTab === 'prompt' && promptInput) {
        await saveText();
    }
    runBtn.disabled = true;
    status.textContent = 'Queuing run...';
    status.style.color = '#2196F3';

    try {
        const resp = await fetch('/inx/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ loop: false })
        });
        const res = await resp.json();
        if (!resp.ok) {
            alert(res.message || 'Error triggering run.');
            status.textContent = 'Error';
            status.style.color = '#F44336';
        } else {
            status.textContent = 'Generating...';
            status.style.color = '#2196F3';
        }
    } catch (e) {
        alert('Network error triggering run.');
        status.textContent = 'Network error';
        status.style.color = '#F44336';
    } finally {
        setTimeout(() => { runBtn.disabled = false; }, 800);
    }
}

async function toggleLoop() {
    if (loopActive) {
        loopBtn.disabled = true;
        try {
            await fetch('/inx/stop_loop', { method: 'POST' });
            updateWorkflowUI({ loop_active: false });
        } catch (e) {
        } finally {
            loopBtn.disabled = false;
        }
    } else {
        if (currentTab === 'prompt' && promptInput) {
            await saveText();
        }
        loopBtn.disabled = true;
        status.textContent = 'Starting loop...';
        status.style.color = '#FFA000';

        try {
            const resp = await fetch('/inx/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ loop: true })
            });
            const res = await resp.json();
            if (!resp.ok) {
                alert(res.message || 'Error starting loop.');
                status.textContent = 'Error';
                status.style.color = '#F44336';
            } else {
                updateWorkflowUI({ loop_active: true });
            }
        } catch (e) {
            alert('Network error starting loop.');
            status.textContent = 'Network error';
            status.style.color = '#F44336';
        } finally {
            loopBtn.disabled = false;
        }
    }
}

async function cancelExecution() {
    cancelBtn.disabled = true;
    status.textContent = 'Cancelling...';
    status.style.color = '#F44336';

    try {
        await fetch('/inx/cancel', { method: 'POST' });
        updateWorkflowUI({ loop_active: false });
        status.textContent = 'Cancelled';
        status.style.color = '#F44336';
        setTimeout(() => {
            if (status.textContent === 'Cancelled') {
                status.textContent = 'Ready';
                status.style.color = '#4CAF50';
            }
        }, 2500);
    } catch (e) {
    } finally {
        setTimeout(() => { cancelBtn.disabled = false; }, 600);
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
                        updateWorkflowUI(data);
                    }
                } else if (data.type === 'text_update') {
                    updatePromptUI(data);
                } else if (data.type === 'workflow_status') {
                    updateWorkflowUI(data);
                } else if (data.type === 'cleared') {
                    totalImages = 0;
                    currentIndex = 0;
                    if (livePreviewUrl && livePreviewUrl.startsWith('blob:')) {
                        URL.revokeObjectURL(livePreviewUrl);
                    }
                    livePreviewUrl = null;
                    resetZoom();
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

initZoomGestures();
connectWS();
fetch('/inx/text')
    .then(r => r.json())
    .then(data => updatePromptUI(data))
    .catch(() => {});
