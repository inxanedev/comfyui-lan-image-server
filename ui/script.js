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

const seedSection = document.getElementById('seedSection');
const seedList = document.getElementById('seedList');
const seedBadge = document.getElementById('seedBadge');

const runBtn = document.getElementById('runBtn');
const loopBtn = document.getElementById('loopBtn');
const cancelBtn = document.getElementById('cancelBtn');
const galleryBar = document.getElementById('galleryBar');
const saveMenu = document.getElementById('saveMenu');
const saveMenuBtn = document.getElementById('saveMenuBtn');
const downloadBtn = document.getElementById('downloadBtn');
const downloadAllBtn = document.getElementById('downloadAllBtn');
const deleteImageBtn = document.getElementById('deleteImageBtn');
const reuseBtn = document.getElementById('reuseBtn');
const copyPromptBtn = document.getElementById('copyPromptBtn');
const stripMetadata = document.getElementById('stripMetadata');
const workflowBar = document.getElementById('workflowBar');
const progressPill = document.getElementById('progressPill');
const presetSelect = document.getElementById('presetSelect');
const presetDeleteBtn = document.getElementById('presetDeleteBtn');
const presetNotice = document.getElementById('presetNotice');
const presetBadge = document.getElementById('presetBadge');

let currentTab = 'gallery';
let totalImages = 0;
let currentIndex = 0;
let livePreviewUrl = null;

let loopActive = false;
let settingsData = { defaults: {}, overrides: {}, effective: {}, resolution: {}, samplers: [], schedulers: [] };
let settingsDirty = false;
let settingsTimer = null;
let presets = [];
let currentPreset = null;

let seedNodes = [];
let progressValue = null;
let progressMax = null;
let runInProgress = false;

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

const DESKTOP_MQ = window.matchMedia('(min-width: 900px)');

function updateTabIndicator() {
    const order = ['gallery', 'live', 'prompt'];
    const count = DESKTOP_MQ.matches ? 2 : 3;
    let index = Math.max(0, order.indexOf(currentTab));
    if (index > count - 1) index = count - 1;
    const indicator = document.getElementById('tabIndicator');
    if (indicator) {
        indicator.style.width = `calc((100% - 8px) / ${count})`;
        indicator.style.transform = `translateX(${index * 100}%)`;
    }
}

function onLayoutChange() {
    if (DESKTOP_MQ.matches && currentTab === 'prompt') {
        switchTab('gallery');
    } else {
        updateTabIndicator();
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

    closeSaveMenu();

    if (tab === 'gallery') {
        viewer.style.display = 'flex';
        promptContainer.style.display = 'none';
        galleryBar.style.display = 'flex';
        workflowBar.style.display = 'none';
        updateGalleryImage();
    } else if (tab === 'live') {
        viewer.style.display = 'flex';
        promptContainer.style.display = 'none';
        galleryBar.style.display = 'none';
        workflowBar.style.display = 'flex';
        updateLiveImage();
    } else if (tab === 'prompt') {
        viewer.style.display = 'none';
        promptContainer.style.display = 'flex';
        galleryBar.style.display = 'none';
        workflowBar.style.display = 'none';
    }

    updateProgressUI();
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
    await flushSettings();
    setProgress(null);
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
            showAlert(res.message || 'Error triggering run.', 'Run failed');
            status.textContent = 'Error';
            status.style.color = '#F44336';
        } else {
            status.textContent = 'Generating...';
            status.style.color = '#2196F3';
            runInProgress = true;
        }
    } catch (e) {
        showAlert('Network error triggering run.', 'Run failed');
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
        await flushSettings();
        setProgress(null);
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
                showAlert(res.message || 'Error starting loop.', 'Loop failed');
                status.textContent = 'Error';
                status.style.color = '#F44336';
            } else {
                updateWorkflowUI({ loop_active: true });
                runInProgress = true;
            }
        } catch (e) {
            showAlert('Network error starting loop.', 'Loop failed');
            status.textContent = 'Network error';
            status.style.color = '#F44336';
        } finally {
            loopBtn.disabled = false;
        }
    }
}

async function cancelExecution() {
    runInProgress = false;
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

/* ---------- Generation settings ---------- */

function setSettingOptions(el, values) {
    if (!el || !Array.isArray(values) || el.options.length === values.length) return;
    el.innerHTML = '';
    for (const value of values) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        el.appendChild(option);
    }
}

function applySettingsState(state) {
    if (!state) return;
    settingsData = state;
    const effective = state.effective || {};
    const resolution = state.resolution || {};

    setSettingOptions(document.getElementById('genSampler'), state.samplers);
    setSettingOptions(document.getElementById('genScheduler'), state.schedulers);

    const genText = document.getElementById('genText');
    const genNegative = document.getElementById('genNegative');
    const genSteps = document.getElementById('genSteps');
    const genCfg = document.getElementById('genCfg');
    const samplerEl = document.getElementById('genSampler');
    const schedulerEl = document.getElementById('genScheduler');
    const aspectEl = document.getElementById('resAspect');
    const mpEl = document.getElementById('resMp');
    const customEl = document.getElementById('resCustom');
    const wEl = document.getElementById('resWidth');
    const hEl = document.getElementById('resHeight');

    if (genText && document.activeElement !== genText) genText.value = effective.text || '';
    if (genNegative && document.activeElement !== genNegative) genNegative.value = effective.negative || '';
    if (genSteps && document.activeElement !== genSteps) genSteps.value = String(effective.steps != null ? effective.steps : 20);
    if (genCfg && document.activeElement !== genCfg) genCfg.value = String(effective.cfg != null ? effective.cfg : 7);
    if (samplerEl) samplerEl.value = effective.sampler_name;
    if (schedulerEl) schedulerEl.value = effective.scheduler;
    if (aspectEl) aspectEl.value = resolution.aspect || '1:1';
    if (mpEl) mpEl.value = String(resolution.megapixels != null ? resolution.megapixels : 1.5);
    if (customEl) customEl.checked = !!resolution.custom;
    if (wEl && document.activeElement !== wEl) wEl.value = String(resolution.width != null ? resolution.width : 1224);
    if (hEl && document.activeElement !== hEl) hEl.value = String(resolution.height != null ? resolution.height : 1224);

    updateGenerationUI();
}

function updateGenerationUI() {
    const customEl = document.getElementById('resCustom');
    const autoFields = document.getElementById('resAutoFields');
    const customFields = document.getElementById('resCustomFields');
    const mpValue = document.getElementById('resMpValue');
    const aspectEl = document.getElementById('resAspect');
    const mpEl = document.getElementById('resMp');
    const preview = document.getElementById('resPreview');
    const badge = document.getElementById('genBadge');

    const custom = customEl ? customEl.checked : false;
    let width;
    let height;
    if (custom) {
        const wEl = document.getElementById('resWidth');
        const hEl = document.getElementById('resHeight');
        width = clampInt(wEl ? wEl.value : 1224, 16, 8192);
        height = clampInt(hEl ? hEl.value : 1224, 16, 8192);
    } else {
        const aspect = aspectEl ? aspectEl.value : '1:1';
        const mp = mpEl ? Number(mpEl.value) : 1.5;
        const computed = computeResolutionLocal(aspect, mp);
        width = computed[0];
        height = computed[1];
        if (mpValue) mpValue.textContent = formatMP(mp) + ' MP';
    }

    if (autoFields) autoFields.style.display = custom ? 'none' : 'flex';
    if (customFields) customFields.style.display = custom ? 'flex' : 'none';
    if (preview) preview.textContent = width + 'x' + height + ' px';

    if (badge) {
        const overridden = settingsData && settingsData.overrides && Object.keys(settingsData.overrides).length > 0;
        badge.textContent = overridden ? 'Overridden' : 'Default';
        badge.classList.toggle('badge-custom', !!overridden);
    }
}

function collectSettings() {
    const defaults = (settingsData && settingsData.defaults) || {};
    const genText = document.getElementById('genText');
    const genNegative = document.getElementById('genNegative');
    const genSteps = document.getElementById('genSteps');
    const genCfg = document.getElementById('genCfg');
    const samplerEl = document.getElementById('genSampler');
    const schedulerEl = document.getElementById('genScheduler');
    const aspectEl = document.getElementById('resAspect');
    const mpEl = document.getElementById('resMp');
    const customEl = document.getElementById('resCustom');
    const wEl = document.getElementById('resWidth');
    const hEl = document.getElementById('resHeight');

    // Only send values that differ from the workflow defaults; matching ones revert to default.
    const payload = {};
    const text = genText ? genText.value : '';
    payload.text = text === (defaults.text || '') ? null : text;
    const negative = genNegative ? genNegative.value : '';
    payload.negative = negative === (defaults.negative || '') ? null : negative;
    const steps = genSteps ? parseInt(genSteps.value, 10) : null;
    payload.steps = (Number.isFinite(steps) && steps !== Number(defaults.steps)) ? steps : null;
    const cfg = genCfg ? parseFloat(genCfg.value) : null;
    payload.cfg = (Number.isFinite(cfg) && cfg !== Number(defaults.cfg)) ? cfg : null;
    payload.sampler_name = (samplerEl && samplerEl.value !== defaults.sampler_name) ? samplerEl.value : null;
    payload.scheduler = (schedulerEl && schedulerEl.value !== defaults.scheduler) ? schedulerEl.value : null;

    const isDefaultRes = !customEl.checked && aspectEl.value === '1:1' && Number(mpEl.value) === 1.5;
    payload.resolution = isDefaultRes ? null : {
        aspect: aspectEl.value,
        megapixels: Number(mpEl.value),
        custom: customEl.checked,
        width: clampInt(wEl.value, 16, 8192),
        height: clampInt(hEl.value, 16, 8192)
    };
    return payload;
}

function onSettingsChange() {
    settingsDirty = true;
    updateGenerationUI();
    if (settingsTimer) clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => {
        settingsTimer = null;
        postSettings();
    }, 350);
}

async function postSettings() {
    try {
        const resp = await fetch('/inx/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(collectSettings())
        });
        const data = await resp.json();
        settingsDirty = false;
        applySettingsState(data);
    } catch (e) {}
}

async function flushSettings() {
    if (!settingsDirty) return;
    if (settingsTimer) {
        clearTimeout(settingsTimer);
        settingsTimer = null;
    }
    await postSettings();
}

async function loadSettings() {
    try {
        const resp = await fetch('/inx/settings');
        if (!resp.ok) return;
        const data = await resp.json();
        applySettingsState(data);
    } catch (e) {}
}

async function revertSettings() {
    try {
        const resp = await fetch('/inx/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: null, negative: null, steps: null, cfg: null,
                sampler_name: null, scheduler: null, resolution: null
            })
        });
        const data = await resp.json();
        settingsDirty = false;
        applySettingsState(data);
        const notice = document.getElementById('genNotice');
        if (notice) {
            notice.textContent = 'Reset to defaults';
            notice.style.color = '#4CAF50';
            setTimeout(() => { if (notice.textContent === 'Reset to defaults') notice.textContent = ''; }, 2500);
        }
    } catch (e) {}
}

/* ---------- Presets ---------- */

function applyPresets(data) {
    if (!data) return;
    if (Array.isArray(data.presets)) presets = data.presets;
    if (data.current !== undefined) currentPreset = data.current || null;

    if (presetSelect) {
        presetSelect.innerHTML = '';
        const none = document.createElement('option');
        none.value = '';
        none.textContent = 'None';
        presetSelect.appendChild(none);
        for (const name of presets) {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            presetSelect.appendChild(option);
        }
        presetSelect.value = currentPreset || '';
    }

    if (presetDeleteBtn) presetDeleteBtn.disabled = !currentPreset;
    if (presetBadge) {
        presetBadge.textContent = currentPreset || 'None';
        presetBadge.classList.toggle('badge-custom', !!currentPreset);
    }
}

function showPresetNotice(text) {
    if (!presetNotice) return;
    presetNotice.textContent = text;
    presetNotice.style.color = '#4CAF50';
    setTimeout(() => {
        if (presetNotice.textContent === text) presetNotice.textContent = '';
    }, 2500);
}

async function loadPresets() {
    try {
        const resp = await fetch('/inx/presets');
        if (!resp.ok) return;
        applyPresets(await resp.json());
    } catch (e) {}
}

async function postPreset(action, name) {
    try {
        const resp = await fetch('/inx/presets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: action, name: name || '' })
        });
        const data = await resp.json();
        if (data && data.message) showAlert(data.message, 'Presets');
        if (data && data.presets) {
            applyPresets(data);
            if (data.settings) applySettingsState(data.settings);
            if (data.seeds) updateSeedUI({ seeds: data.seeds });
        }
        return data;
    } catch (e) {
        showAlert('Preset action failed.', 'Presets');
        return null;
    }
}

async function onPresetSelect() {
    const value = presetSelect ? presetSelect.value : '';
    if (value === (currentPreset || '')) return;
    if (!value) {
        await postPreset('unload');
        showPresetNotice('Unloaded');
    } else {
        await postPreset('load', value);
        showPresetNotice('Loaded "' + value + '"');
    }
}

async function savePresetFlow() {
    let name = currentPreset;

    if (currentPreset) {
        const overwrite = await showConfirm('Preset "' + currentPreset + '" is currently loaded.', {
            title: 'Save Preset',
            confirmText: 'Overwrite',
            cancelText: 'Save as new'
        });
        if (overwrite) {
            const data = await postPreset('save', currentPreset);
            if (data) showPresetNotice('Saved "' + currentPreset + '"');
            return;
        }
        name = await showPrompt('Name for the new preset:', currentPreset, { title: 'Save Preset', confirmText: 'Save' });
    } else {
        name = await showPrompt('Name for the new preset:', '', { title: 'Save Preset', confirmText: 'Save' });
    }

    if (name === null) return;
    name = String(name).trim();
    if (!name) return;
    const data = await postPreset('save', name);
    if (data && data.current) showPresetNotice('Saved "' + data.current + '"');
}

async function deletePreset() {
    if (!currentPreset) return;
    if (!(await showConfirm('Delete preset "' + currentPreset + '"?', { title: 'Delete Preset', confirmText: 'Delete', danger: true }))) {
        return;
    }
    const name = currentPreset;
    await postPreset('delete', name);
    showPresetNotice('Deleted "' + name + '"');
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
    seedNodes = data.seeds;

    if (!data.seeds.length) {
        seedSection.classList.remove('visible');
        seedSection.classList.remove('open');
        const hiddenHeader = seedSection.querySelector('.acc-header');
        if (hiddenHeader) hiddenHeader.setAttribute('aria-expanded', 'false');
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
        row2.className = 'seed-row seed-actions';
        const randomBtn = document.createElement('button');
        randomBtn.className = 'btn seed-btn' + (node.mode === 'random' ? ' active-random' : '');
        randomBtn.textContent = 'Random each run';
        randomBtn.onclick = () => setSeed(node.id, 'random', null);
        const newRandomBtn = document.createElement('button');
        newRandomBtn.className = 'btn seed-btn';
        newRandomBtn.textContent = 'New random';
        newRandomBtn.onclick = () => setSeed(node.id, 'new_random', null);
        const resetBtn = document.createElement('button');
        resetBtn.className = 'btn seed-btn';
        resetBtn.textContent = 'Reset';
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
                showAlert('Please enter a valid integer seed.', 'Seed');
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
            showAlert(data.message, 'Seed');
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
        if (header) {
            header.setAttribute('aria-expanded', 'true');
            requestAnimationFrame(() => {
                header.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            });
        }
    }
}

/* ---------- Resolution settings ---------- */

const RES_ASPECTS = {
    '1:1': [1, 1], '2:3': [2, 3], '3:2': [3, 2], '3:4': [3, 4],
    '4:3': [4, 3], '9:16': [9, 16], '16:9': [16, 9], '21:9': [21, 9]
};

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

async function updateGalleryImage() {
    if (totalImages === 0) {
        img.style.display = 'none';
        placeholder.style.display = 'block';
        placeholder.textContent = 'No gallery images yet.';
        counter.textContent = '0 / 0';
        prevBtn.disabled = true;
        nextBtn.disabled = true;
        downloadBtn.disabled = true;
        downloadAllBtn.disabled = true;
        deleteImageBtn.disabled = true;
        reuseBtn.disabled = true;
        copyPromptBtn.disabled = true;
        displayedImageKey = null;
        return;
    }

    counter.textContent = `${currentIndex} / ${totalImages}`;
    prevBtn.disabled = (currentIndex <= 1);
    nextBtn.disabled = (currentIndex >= totalImages);
    downloadBtn.disabled = false;
    downloadAllBtn.disabled = false;
    deleteImageBtn.disabled = false;
    reuseBtn.disabled = false;
    copyPromptBtn.disabled = false;

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

function updateProgressUI() {
    if (!progressPill) return;
    if (currentTab === 'live' && progressValue != null && progressMax) {
        progressPill.textContent = `${progressValue} / ${progressMax}`;
        progressPill.classList.add('visible');
    } else {
        progressPill.classList.remove('visible');
    }
}

function setProgress(value, max) {
    if (value == null) {
        progressValue = null;
        progressMax = null;
    } else {
        progressValue = value;
        progressMax = max;
    }
    updateProgressUI();
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
                    if (currentIndex > totalImages) {
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
                        updateWorkflowUI(data);
                    }

                    if (data.seeds) {
                        updateSeedUI(data);
                    } else {
                        refreshSeeds();
                    }

                    if (data.settings) {
                        applySettingsState(data.settings);
                    }

                    if (data.type === 'init' && (data.presets !== undefined || data.current_preset !== undefined)) {
                        applyPresets({ presets: data.presets || [], current: data.current_preset });
                    }
                } else if (data.type === 'seed_update') {
                    updateSeedUI(data);
                } else if (data.type === 'settings_update') {
                    applySettingsState(data.settings);
                } else if (data.type === 'presets_update') {
                    applyPresets(data);
                    if (data.settings) applySettingsState(data.settings);
                    if (data.seeds) updateSeedUI({ seeds: data.seeds });
                } else if (data.type === 'progress') {
                    if (data.value == null) {
                        setProgress(null);
                        if (data.done && runInProgress && !loopActive) {
                            runInProgress = false;
                            status.textContent = 'Done.';
                            status.style.color = '#30D158';
                        }
                    } else {
                        setProgress(data.value, data.max);
                    }
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
                    setProgress(null);
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

async function downloadCurrentImage() {
    if (totalImages === 0) return;
    const index = currentIndex - 1;
    const clean = stripMetadata && stripMetadata.checked;
    downloadBtn.disabled = true;
    try {
        const url = `/inx/image?index=${index}&v=${encodeURIComponent(imageEpoch)}${clean ? '&clean=1' : ''}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('download failed');
        const blob = await resp.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = `inx_${String(currentIndex).padStart(5, '0')}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
    } catch (e) {
        showAlert('Could not save the image.', 'Save');
    } finally {
        downloadBtn.disabled = (totalImages === 0);
    }
}

async function downloadAll() {
    if (totalImages === 0) return;
    const clean = stripMetadata && stripMetadata.checked;
    downloadAllBtn.disabled = true;
    try {
        const resp = await fetch(`/inx/download_all?clean=${clean ? 1 : 0}`);
        if (!resp.ok) throw new Error('download failed');
        const blob = await resp.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = 'inx_images.zip';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
    } catch (e) {
        showAlert('Could not save the images.', 'Save All');
    } finally {
        downloadAllBtn.disabled = (totalImages === 0);
    }
}

async function deleteCurrentImage() {
    if (totalImages === 0) return;
    if (!(await showConfirm('Delete this image from the gallery? The file is removed from disk.', { title: 'Delete Image', confirmText: 'Delete', danger: true }))) {
        return;
    }
    closeSaveMenu();
    const index = currentIndex - 1;
    deleteImageBtn.disabled = true;
    try {
        const resp = await fetch('/inx/image/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ index: index })
        });
        const data = await resp.json();
        if (data && data.status === 'deleted') {
            syncEpoch(data.epoch);
            totalImages = data.total;
            if (currentIndex > totalImages) currentIndex = totalImages;
            if (currentIndex < 1) currentIndex = 0;
            if (currentTab === 'gallery') updateGalleryImage();
        } else if (data && data.message) {
            showAlert(data.message, 'Delete Image');
        }
    } catch (e) {
        showAlert('Could not delete the image.', 'Delete Image');
    } finally {
        deleteImageBtn.disabled = (totalImages === 0);
    }
}

async function reuseImageSettings() {
    if (totalImages === 0) return;
    const index = currentIndex - 1;
    reuseBtn.disabled = true;
    try {
        const resp = await fetch(`/inx/image/params?index=${index}`);
        if (!resp.ok) throw new Error('failed');
        const params = await resp.json();
        const applied = [];

        if (params.seed != null && seedNodes.length) {
            await setSeed(seedNodes[0].id, 'fixed', String(params.seed));
            applied.push('seed');
        }
        if (params.width != null && params.height != null) {
            const customEl = document.getElementById('resCustom');
            const wEl = document.getElementById('resWidth');
            const hEl = document.getElementById('resHeight');
            if (customEl && wEl && hEl) {
                customEl.checked = true;
                wEl.value = String(params.width);
                hEl.value = String(params.height);
                applied.push('size');
            }
        }
        if (params.positive) {
            const genText = document.getElementById('genText');
            if (genText) genText.value = params.positive;
            applied.push('prompt');
        }
        if (params.negative) {
            const genNegative = document.getElementById('genNegative');
            if (genNegative) genNegative.value = params.negative;
        }
        if (applied.length) {
            settingsDirty = true;
            updateGenerationUI();
            await flushSettings();
        }

        status.textContent = applied.length ? `Loaded ${applied.join(', ')}` : 'No settings in image';
        status.style.color = applied.length ? '#4CAF50' : '#FFA000';
        setTimeout(() => {
            status.textContent = 'Ready';
            status.style.color = '#4CAF50';
        }, 2500);
    } catch (e) {
        showAlert('Could not read the image settings.', 'Reuse Settings');
    } finally {
        reuseBtn.disabled = (totalImages === 0);
    }
}

async function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch (e) {}
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
}

async function copyPrompt() {
    if (totalImages === 0) return;
    const index = currentIndex - 1;
    copyPromptBtn.disabled = true;
    try {
        const resp = await fetch(`/inx/image/params?index=${index}`);
        if (!resp.ok) throw new Error('failed');
        const params = await resp.json();
        const text = params.positive || params.negative || '';
        if (!text) {
            status.textContent = 'No prompt in image';
            status.style.color = '#FFA000';
        } else {
            await copyToClipboard(text);
            status.textContent = 'Prompt copied';
            status.style.color = '#4CAF50';
        }
        setTimeout(() => {
            status.textContent = 'Ready';
            status.style.color = '#4CAF50';
        }, 2000);
    } catch (e) {
        showAlert('Could not read the prompt.', 'Copy Prompt');
    } finally {
        copyPromptBtn.disabled = (totalImages === 0);
    }
}

/* ---------- Save actions menu ---------- */

function toggleSaveMenu(ev) {
    if (ev) ev.stopPropagation();
    if (saveMenu.classList.contains('open')) {
        closeSaveMenu();
    } else {
        openSaveMenu();
    }
}

function openSaveMenu() {
    saveMenu.classList.add('open');
    if (saveMenuBtn) saveMenuBtn.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onDocumentClickCloseSaveMenu, true);
}

function closeSaveMenu() {
    if (!saveMenu) return;
    saveMenu.classList.remove('open');
    if (saveMenuBtn) saveMenuBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocumentClickCloseSaveMenu, true);
}

function onDocumentClickCloseSaveMenu(e) {
    if (saveMenu.contains(e.target)) return;
    if (saveMenuBtn && saveMenuBtn.contains(e.target)) return;
    closeSaveMenu();
}

/* ---------- Themed modal dialogs ---------- */

let modalResolve = null;

function positionModal() {
    const el = document.getElementById('modal');
    if (!el || !el.classList.contains('open')) return;
    const vv = window.visualViewport;
    if (vv && vv.height) {
        // Keep the dialog inside the visible area so the on-screen keyboard can't cover it.
        el.style.top = vv.offsetTop + 'px';
        el.style.height = vv.height + 'px';
    } else {
        el.style.top = '';
        el.style.height = '';
    }
}

function modal(options) {
    const opts = options || {};
    const el = document.getElementById('modal');
    const titleEl = document.getElementById('modalTitle');
    const messageEl = document.getElementById('modalMessage');
    const inputEl = document.getElementById('modalInput');
    const cancelBtn = document.getElementById('modalCancel');
    const confirmBtn = document.getElementById('modalConfirm');
    if (!el) return Promise.resolve(false);

    if (titleEl) titleEl.textContent = opts.title || '';
    if (messageEl) messageEl.textContent = opts.message || '';

    const isInput = opts.input !== undefined && opts.input !== null;
    if (inputEl) {
        inputEl.style.display = isInput ? 'block' : 'none';
        inputEl.value = isInput ? String(opts.input) : '';
    }

    if (cancelBtn) {
        cancelBtn.textContent = opts.cancelText || 'Cancel';
        cancelBtn.style.display = opts.showCancel === false ? 'none' : '';
    }
    if (confirmBtn) {
        confirmBtn.textContent = opts.confirmText || 'OK';
        confirmBtn.classList.toggle('btn-danger', !!opts.danger);
        confirmBtn.classList.toggle('btn-primary', !opts.danger);
    }

    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
    document.addEventListener('keydown', onModalKeydown, true);
    positionModal();

    if (isInput) {
        setTimeout(() => {
            try { inputEl.focus(); inputEl.select(); } catch (e) {}
        }, 60);
    }

    return new Promise(function (resolve) { modalResolve = resolve; });
}

function resolveModal(value) {
    const el = document.getElementById('modal');
    if (el) {
        el.classList.remove('open');
        el.setAttribute('aria-hidden', 'true');
        el.style.top = '';
        el.style.height = '';
    }
    document.removeEventListener('keydown', onModalKeydown, true);
    const resolve = modalResolve;
    modalResolve = null;
    if (resolve) resolve(value);
}

function onModalConfirm() {
    const inputEl = document.getElementById('modalInput');
    const isInput = inputEl && inputEl.style.display !== 'none';
    resolveModal(isInput ? inputEl.value : true);
}

function onModalCancel() {
    if (!modalResolve) return;
    const inputEl = document.getElementById('modalInput');
    const isInput = inputEl && inputEl.style.display !== 'none';
    resolveModal(isInput ? null : false);
}

function onModalKeydown(e) {
    if (!modalResolve) return;
    if (e.key === 'Enter') {
        e.preventDefault();
        onModalConfirm();
    } else if (e.key === 'Escape') {
        e.preventDefault();
        onModalCancel();
    }
}

function showAlert(message, title) {
    return modal({ title: title, message: message, showCancel: false, confirmText: 'OK' });
}

function showConfirm(message, options) {
    const opts = options || {};
    return modal({
        title: opts.title || '',
        message: message,
        confirmText: opts.confirmText || 'OK',
        cancelText: opts.cancelText || 'Cancel',
        danger: !!opts.danger
    });
}

function showPrompt(message, defaultValue, options) {
    const opts = options || {};
    return modal({
        title: opts.title || '',
        message: message,
        input: defaultValue != null ? defaultValue : '',
        confirmText: opts.confirmText || 'OK',
        cancelText: opts.cancelText || 'Cancel'
    });
}

async function killServer() {
    if (!(await showConfirm("Clear the image history and reset all settings to defaults?", { title: 'Clear Images', confirmText: 'Clear', danger: true }))) {
        return;
    }
    fetch('/inx/kill_server', { method: 'POST' });
}

async function shutdownPC() {
    if (!(await showConfirm("Shut down the computer running ComfyUI?\n\nThis powers off the PC immediately and force-closes any open apps — unsaved work will be lost. It cannot be undone from here.", { title: 'Shutdown PC', confirmText: 'Shut down', danger: true }))) {
        return;
    }
    const btn = document.getElementById('shutdownBtn');
    if (btn) btn.disabled = true;
    status.textContent = 'Shutting down...';
    status.style.color = '#F44336';
    try {
        await fetch('/inx/shutdown', { method: 'POST' });
    } catch (e) {}
}

if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', positionModal);
    window.visualViewport.addEventListener('scroll', positionModal);
}

if (DESKTOP_MQ.addEventListener) {
    DESKTOP_MQ.addEventListener('change', onLayoutChange);
} else if (DESKTOP_MQ.addListener) {
    DESKTOP_MQ.addListener(onLayoutChange);
}

initZoomGestures();
updateTabIndicator();
switchTab('gallery');
connectWS();
refreshSeeds();
loadSettings();
loadPresets();
