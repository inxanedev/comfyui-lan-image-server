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

const seedSection = document.getElementById('seedSection');
const seedList = document.getElementById('seedList');
const seedBadge = document.getElementById('seedBadge');

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

const IMAGE_CACHE_LIMIT = 24;
const imageCache = new Map();
let imageEpoch = '';
let galleryLoadToken = 0;
let displayedImageKey = null;
let activeImageKey = null;
let livePreviewOwned = false;
let pendingPreview = null;
let previewRafScheduled = false;

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

function syncEpoch(epoch) {
    if (epoch && epoch !== imageEpoch) {
        imageEpoch = epoch;
        invalidateImageCache();
        return true;
    }
    return false;
}

function invalidateImageCache() {
    for (const url of imageCache.values()) {
        if (typeof url === 'string' && url.startsWith('blob:')) {
            URL.revokeObjectURL(url);
        }
    }
    imageCache.clear();
    displayedImageKey = null;
    activeImageKey = null;
}

async function loadImageUrl(index) {
    const key = `${imageEpoch}:${index}`;
    const cached = imageCache.get(key);
    if (cached) return cached;

    const resp = await fetch(`/inx/image?index=${index}&v=${encodeURIComponent(imageEpoch)}`);
    if (!resp.ok) throw new Error(`image ${index} unavailable`);

    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    imageCache.set(key, url);

    while (imageCache.size > IMAGE_CACHE_LIMIT) {
        let evictedKey = null;
        for (const k of imageCache.keys()) {
            if (k !== activeImageKey) {
                evictedKey = k;
                break;
            }
        }
        if (evictedKey === null) break;
        const evictedUrl = imageCache.get(evictedKey);
        if (evictedUrl && evictedUrl.startsWith('blob:')) {
            URL.revokeObjectURL(evictedUrl);
        }
        imageCache.delete(evictedKey);
    }
    return url;
}

function prefetchImage(index) {
    if (index < 0 || index >= totalImages) return;
    if (imageCache.has(`${imageEpoch}:${index}`)) return;
    loadImageUrl(index).catch(() => {});
}

function queuePreviewFrame(buffer, mimeType) {
    pendingPreview = { buffer: buffer, mime: mimeType };
    if (!previewRafScheduled) {
        previewRafScheduled = true;
        requestAnimationFrame(flushPreviewFrame);
    }
}

function flushPreviewFrame() {
    previewRafScheduled = false;
    const pending = pendingPreview;
    pendingPreview = null;
    if (!pending) return;

    const blob = new Blob([pending.buffer], { type: pending.mime });
    const newUrl = URL.createObjectURL(blob);
    if (livePreviewOwned && livePreviewUrl && livePreviewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(livePreviewUrl);
    }
    livePreviewUrl = newUrl;
    livePreviewOwned = true;
    if (currentTab === 'live') updateLiveImage();
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

function updateTabIndicator() {
    const order = ['gallery', 'live', 'prompt'];
    const index = Math.max(0, order.indexOf(currentTab));
    const indicator = document.getElementById('tabIndicator');
    if (indicator) {
        indicator.style.transform = `translateX(${index * 100}%)`;
    }
}

function toggleTheme() {
    const root = document.documentElement;
    const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) {
        themeMeta.setAttribute('content', next === 'light' ? '#e9edf6' : '#05060a');
    }
    try {
        localStorage.setItem('inx-theme', next);
    } catch (e) {}
}

function switchTab(tab) {
    currentTab = tab;
    tabGallery.classList.toggle('active', tab === 'gallery');
    tabLive.classList.toggle('active', tab === 'live');
    tabPrompt.classList.toggle('active', tab === 'prompt');
    updateTabIndicator();

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
    await flushResolution();
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
        await flushResolution();
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

async function refreshSeeds() {
    try {
        const resp = await fetch('/inx/seed');
        if (!resp.ok) return;
        const data = await resp.json();
        updateSeedUI(data);
    } catch (e) {}
}

function seedModeLabel(mode) {
    if (mode === 'random') return 'Random each run';
    if (mode === 'fixed') return 'Fixed';
    return 'Default';
}

function updateSeedUI(data) {
    if (!data || !Array.isArray(data.seeds)) return;

    if (!data.seeds.length) {
        seedSection.classList.remove('visible');
        seedSection.classList.remove('open');
        seedList.innerHTML = '';
        return;
    }

    seedSection.classList.add('visible');
    const overridden = data.seeds.filter(s => s.mode && s.mode !== 'default').length;
    seedBadge.textContent = overridden ? 'Overridden' : 'Default';
    seedBadge.classList.toggle('badge-custom', overridden > 0);

    seedList.innerHTML = '';
    for (const node of data.seeds) {
        const card = document.createElement('div');
        card.className = 'seed-node';

        const top = document.createElement('div');
        top.className = 'seed-node-top';
        const name = document.createElement('span');
        name.className = 'seed-node-name';
        name.textContent = node.title || node.id;
        const badge = document.createElement('span');
        badge.className = 'badge' + (node.mode && node.mode !== 'default' ? ' badge-custom' : '');
        badge.textContent = seedModeLabel(node.mode);
        top.appendChild(name);
        top.appendChild(badge);

        const row1 = document.createElement('div');
        row1.className = 'seed-row';
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'seed-input';
        input.step = '1';
        input.min = String(node.min != null ? node.min : -1125899906842624);
        input.max = String(node.max != null ? node.max : 1125899906842624);
        const displayValue = node.mode === 'fixed' && node.value != null ? node.value : node.current;
        input.value = displayValue != null ? String(displayValue) : '';
        const setBtn = document.createElement('button');
        setBtn.className = 'btn seed-btn';
        setBtn.textContent = 'Set';
        setBtn.onclick = () => setSeed(node.id, 'fixed', input.value);
        row1.appendChild(input);
        row1.appendChild(setBtn);

        const row2 = document.createElement('div');
        row2.className = 'seed-row';
        const randomBtn = document.createElement('button');
        randomBtn.className = 'btn seed-btn' + (node.mode === 'random' ? ' active-random' : '');
        randomBtn.textContent = 'Random each run';
        randomBtn.style.flex = '1';
        randomBtn.onclick = () => setSeed(node.id, 'random', null);
        const newRandomBtn = document.createElement('button');
        newRandomBtn.className = 'btn seed-btn';
        newRandomBtn.textContent = 'New random';
        newRandomBtn.style.flex = '1';
        newRandomBtn.onclick = () => setSeed(node.id, 'new_random', null);
        const resetBtn = document.createElement('button');
        resetBtn.className = 'btn seed-btn';
        resetBtn.textContent = 'Reset';
        resetBtn.style.flex = '0.8';
        resetBtn.onclick = () => setSeed(node.id, 'default', null);
        row2.appendChild(randomBtn);
        row2.appendChild(newRandomBtn);
        row2.appendChild(resetBtn);

        card.appendChild(top);
        card.appendChild(row1);
        card.appendChild(row2);
        seedList.appendChild(card);
    }
}

async function setSeed(id, mode, value) {
    try {
        const body = { id: String(id), mode: mode };
        if (mode === 'fixed') {
            body.value = parseInt(value, 10);
            if (!Number.isFinite(body.value)) {
                alert('Please enter a valid integer seed.');
                return;
            }
        }
        const resp = await fetch('/inx/seed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await resp.json();
        if (data && data.seeds) {
            updateSeedUI(data);
        } else if (data && data.message) {
            alert(data.message);
        }
    } catch (e) {}
}

/* ---------- Settings accordion ---------- */

function toggleAccordion(name) {
    const items = document.querySelectorAll('#promptContainer .acc-item');
    const target = document.querySelector(`#promptContainer .acc-item[data-acc="${name}"]`);
    if (!target) return;
    const willOpen = !target.classList.contains('open');
    items.forEach(item => {
        item.classList.remove('open');
        const header = item.querySelector('.acc-header');
        if (header) header.setAttribute('aria-expanded', 'false');
    });
    if (willOpen) {
        target.classList.add('open');
        const header = target.querySelector('.acc-header');
        if (header) header.setAttribute('aria-expanded', 'true');
    }
}

/* ---------- Resolution settings ---------- */

const RES_ASPECTS = {
    '1:1': [1, 1], '2:3': [2, 3], '3:2': [3, 2], '3:4': [3, 4],
    '4:3': [4, 3], '9:16': [9, 16], '16:9': [16, 9], '21:9': [21, 9]
};

let resState = {
    aspect: '1:1', megapixels: 1.5, custom: false,
    width: 1224, height: 1224, effective_width: 1224, effective_height: 1224
};
let resDirty = false;
let resPostTimer = null;

function resRound8(x) {
    return Math.max(8, Math.round(x / 8) * 8);
}

function computeResolutionLocal(aspect, megapixels) {
    const ratio = RES_ASPECTS[aspect] || [1, 1];
    const a = ratio[0];
    const b = ratio[1];
    const total = Number(megapixels) * 1e6;
    const height = Math.sqrt(total * b / a);
    const width = Math.sqrt(total * a / b);
    return [resRound8(width), resRound8(height)];
}

function clampInt(value, min, max) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
}

function formatMP(mp) {
    return String(Math.round(Number(mp) * 10) / 10);
}

function applyResolutionState(data) {
    if (!data) return;
    if (data.aspect !== undefined) resState.aspect = data.aspect;
    if (data.megapixels !== undefined) resState.megapixels = Number(data.megapixels);
    if (data.custom !== undefined) resState.custom = !!data.custom;
    if (data.width !== undefined) resState.width = Number(data.width);
    if (data.height !== undefined) resState.height = Number(data.height);
    if (data.effective_width !== undefined) resState.effective_width = data.effective_width;
    if (data.effective_height !== undefined) resState.effective_height = data.effective_height;

    const aspectEl = document.getElementById('resAspect');
    const mpEl = document.getElementById('resMp');
    const customEl = document.getElementById('resCustom');
    const wEl = document.getElementById('resWidth');
    const hEl = document.getElementById('resHeight');

    if (aspectEl) aspectEl.value = resState.aspect;
    if (mpEl) mpEl.value = String(resState.megapixels);
    if (customEl) customEl.checked = resState.custom;
    if (wEl && document.activeElement !== wEl) wEl.value = String(resState.width);
    if (hEl && document.activeElement !== hEl) hEl.value = String(resState.height);

    updateResolutionUI();
}

function updateResolutionUI() {
    const customEl = document.getElementById('resCustom');
    const autoFields = document.getElementById('resAutoFields');
    const customFields = document.getElementById('resCustomFields');
    const mpValue = document.getElementById('resMpValue');
    const aspectEl = document.getElementById('resAspect');
    const mpEl = document.getElementById('resMp');
    const badge = document.getElementById('resBadge');
    const preview = document.getElementById('resPreview');

    const custom = customEl ? customEl.checked : resState.custom;
    let width;
    let height;

    if (custom) {
        const wEl = document.getElementById('resWidth');
        const hEl = document.getElementById('resHeight');
        width = clampInt(wEl ? wEl.value : resState.width, 16, 8192);
        height = clampInt(hEl ? hEl.value : resState.height, 16, 8192);
    } else {
        const aspect = aspectEl ? aspectEl.value : resState.aspect;
        const mp = mpEl ? Number(mpEl.value) : resState.megapixels;
        const computed = computeResolutionLocal(aspect, mp);
        width = computed[0];
        height = computed[1];
        if (mpValue) mpValue.textContent = formatMP(mp) + ' MP';
    }

    if (autoFields) autoFields.style.display = custom ? 'none' : 'flex';
    if (customFields) customFields.style.display = custom ? 'flex' : 'none';
    if (preview) preview.textContent = width + 'x' + height + ' px';
    if (badge) {
        badge.textContent = custom
            ? 'Custom'
            : (aspectEl ? aspectEl.value : resState.aspect) + ' \u00b7 ' + formatMP(mpEl ? mpEl.value : resState.megapixels) + ' MP';
    }
}

function onResolutionChange() {
    resDirty = true;
    updateResolutionUI();
    if (resPostTimer) clearTimeout(resPostTimer);
    resPostTimer = setTimeout(() => {
        resPostTimer = null;
        postResolution();
    }, 220);
}

async function postResolution() {
    const customEl = document.getElementById('resCustom');
    const aspectEl = document.getElementById('resAspect');
    const mpEl = document.getElementById('resMp');
    const wEl = document.getElementById('resWidth');
    const hEl = document.getElementById('resHeight');

    const body = {
        custom: customEl ? customEl.checked : false,
        aspect: aspectEl ? aspectEl.value : '1:1',
        megapixels: mpEl ? Number(mpEl.value) : 1.5,
        width: wEl ? clampInt(wEl.value, 16, 8192) : 1224,
        height: hEl ? clampInt(hEl.value, 16, 8192) : 1224
    };

    try {
        const resp = await fetch('/inx/resolution', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await resp.json();
        resDirty = false;
        applyResolutionState(data);
    } catch (e) {}
}

async function flushResolution() {
    if (!resDirty) return;
    if (resPostTimer) {
        clearTimeout(resPostTimer);
        resPostTimer = null;
    }
    await postResolution();
}

async function loadResolution() {
    try {
        const resp = await fetch('/inx/resolution');
        if (!resp.ok) return;
        const data = await resp.json();
        applyResolutionState(data);
    } catch (e) {}
}

async function updateGalleryImage() {
    if (totalImages === 0) {
        img.style.display = 'none';
        placeholder.style.display = 'block';
        placeholder.textContent = 'No gallery images yet.';
        counter.textContent = '0 / 0';
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        displayedImageKey = null;
        return;
    }

    counter.textContent = `${currentIndex} / ${totalImages}`;
    prevBtn.disabled = (currentIndex <= 1);
    nextBtn.disabled = (currentIndex >= totalImages);

    const index = currentIndex - 1;
    const key = `gallery:${imageEpoch}:${index}`;
    if (key === displayedImageKey) return;

    const token = ++galleryLoadToken;
    try {
        const url = await loadImageUrl(index);
        if (token !== galleryLoadToken) return;
        placeholder.style.display = 'none';
        img.style.display = 'block';
        img.src = url;
        displayedImageKey = key;
        activeImageKey = `${imageEpoch}:${index}`;
        prefetchImage(index - 1);
        prefetchImage(index + 1);
    } catch (e) {
        if (token !== galleryLoadToken) return;
        img.style.display = 'none';
        placeholder.style.display = 'block';
        placeholder.textContent = 'Image unavailable.';
    }
}

function updateLiveImage() {
    displayedImageKey = null;
    activeImageKey = null;
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

            // The image payload is preceded by a small JSON metadata header, so only
            // the first chunk needs to be scanned for magic bytes.
            const limit = Math.min(bytes.length, 2048);
            let startOffset = -1;
            let mimeType = 'image/jpeg';

            for (let i = 0; i < limit - 1; i++) {
                if (bytes[i] === 0xFF && bytes[i + 1] === 0xD8) {
                    startOffset = i;
                    mimeType = 'image/jpeg';
                    break;
                }
                if (i < limit - 3 && bytes[i] === 0x89 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x4E && bytes[i + 3] === 0x47) {
                    startOffset = i;
                    mimeType = 'image/png';
                    break;
                }
            }

            if (startOffset !== -1) {
                queuePreviewFrame(event.data.slice(startOffset), mimeType);
            }
        } else if (typeof event.data === 'string') {
            try {
                const data = JSON.parse(event.data);

                if (data.type === 'init' || data.type === 'update') {
                    syncEpoch(data.epoch);

                    const previousTotal = totalImages;
                    const wasAtLatest = (currentIndex === previousTotal) || (previousTotal === 0);

                    totalImages = data.total;

                    if (wasAtLatest) {
                        currentIndex = totalImages;
                    }

                    // When the final image is saved by the node, auto-update the Live Preview tab
                    if (totalImages > 0) {
                        const finalIndex = totalImages - 1;
                        loadImageUrl(finalIndex).then(url => {
                            if (totalImages - 1 !== finalIndex) return;
                            if (livePreviewOwned && livePreviewUrl && livePreviewUrl.startsWith('blob:')) {
                                URL.revokeObjectURL(livePreviewUrl);
                            }
                            livePreviewUrl = url;
                            livePreviewOwned = false;
                            activeImageKey = `${imageEpoch}:${finalIndex}`;
                            if (currentTab === 'live') {
                                updateLiveImage();
                            }
                        }).catch(() => {});
                    }

                    if (currentTab === 'gallery') {
                        updateGalleryImage();
                    }

                    if (data.type === 'init') {
                        updatePromptUI(data);
                        updateWorkflowUI(data);
                    }

                    if (data.seeds) {
                        updateSeedUI(data);
                    } else {
                        refreshSeeds();
                    }

                    if (data.resolution) {
                        applyResolutionState(data.resolution);
                    }
                } else if (data.type === 'text_update') {
                    updatePromptUI(data);
                } else if (data.type === 'seed_update') {
                    updateSeedUI(data);
                } else if (data.type === 'resolution_update') {
                    applyResolutionState(data);
                } else if (data.type === 'workflow_status') {
                    updateWorkflowUI(data);
                } else if (data.type === 'cleared') {
                    syncEpoch(data.epoch);
                    totalImages = 0;
                    currentIndex = 0;
                    if (livePreviewOwned && livePreviewUrl && livePreviewUrl.startsWith('blob:')) {
                        URL.revokeObjectURL(livePreviewUrl);
                    }
                    livePreviewUrl = null;
                    livePreviewOwned = false;
                    pendingPreview = null;
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
updateTabIndicator();
connectWS();
fetch('/inx/text')
    .then(r => r.json())
    .then(data => updatePromptUI(data))
    .catch(() => {});
refreshSeeds();
loadResolution();
