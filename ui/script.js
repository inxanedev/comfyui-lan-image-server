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
const tabsEl = document.getElementById('tabs');
const tabIndicatorEl = document.getElementById('tabIndicator');
const themeToggleBtn = document.getElementById('themeToggle');
const themeMenu = document.getElementById('themeMenu');
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
const quickMenu = document.getElementById('quickMenu');
const downloadBtn = document.getElementById('downloadBtn');
const downloadAllBtn = document.getElementById('downloadAllBtn');
const deleteImageBtn = document.getElementById('deleteImageBtn');
const upscaleBtn4k = document.getElementById('upscaleBtn4k');
const upscaleBtn20 = document.getElementById('upscaleBtn20');
const reuseBtn = document.getElementById('reuseBtn');
const copyPromptBtn = document.getElementById('copyPromptBtn');
const stripMetadata = document.getElementById('stripMetadata');
const workflowBar = document.getElementById('workflowBar');
const progressPill = document.getElementById('progressPill');
const upscaleBadge = document.getElementById('upscaleBadge');
const compareOverlay = document.getElementById('compareOverlay');
const compareFrame = document.getElementById('compareFrame');
const compareBefore = document.getElementById('compareBefore');
const compareAfter = document.getElementById('compareAfter');
const compareDivider = document.getElementById('compareDivider');
const resBadge = document.getElementById('resBadge');
const previewOverlay = document.getElementById('previewOverlay');
const previewImage = document.getElementById('previewImage');
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
let upscalerAvailable = false;
let upscaler4kAvailable = false;
let upscaling = false;
let upscaledIndices = new Set();
let simpleMode = false;

let compareOpen = false;
let compareLoading = false;
let compareDragging = false;
let compareStart = null;
let compareOriginalUrl = null;

let previewOpen = false;
let lastTapTime = 0;
let lastTapX = 0;
let lastTapY = 0;

const PREVIEW_MIN_ZOOM = 1;
const PREVIEW_MAX_ZOOM = 8;
let previewScale = 1;
let previewTx = 0;
let previewTy = 0;
const previewPointers = new Map();
let previewPan = null;
let previewPinch = null;
let previewLastTap = { t: 0, x: 0, y: 0 };

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
let zoomScale = 1;
let zoomTx = 0;
let zoomTy = 0;
let gesture = null;
let galleryAnim = null;
let swipeDrag = null;
let wheelAccum = 0;
let wheelLockUntil = 0;

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

function getCachedImageUrl(index) {
    const url = imageCache.get(`${imageEpoch}:${index}`);
    return (typeof url === 'string' && url.startsWith('blob:')) ? url : null;
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
            if (swipeDrag) cancelSwipeGraphic();
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
                startTy: zoomTy,
                swipeEligible: (currentTab === 'gallery' && zoomScale <= 1),
                startOnBadges: !!(e.target && e.target.closest && e.target.closest('#badges')),
                startTime: Date.now(),
                swiping: false,
                swipeDecided: false
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
            if (zoomScale > 1) {
                e.preventDefault();
                zoomTx = gesture.startTx + (e.touches[0].clientX - gesture.startX);
                zoomTy = gesture.startTy + (e.touches[0].clientY - gesture.startY);
                applyZoom();
                return;
            }

            // Continuous gallery swipe: let the neighbour image follow the finger.
            if (gesture.swipeEligible && totalImages > 0) {
                const cx = e.touches[0].clientX;
                const cy = e.touches[0].clientY;
                const dx = cx - gesture.startX;
                const dy = cy - gesture.startY;

                if (!gesture.swipeDecided) {
                    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
                        gesture.swipeDecided = true;
                        gesture.swiping = true;
                        beginSwipeDrag();
                    } else if (Math.abs(dy) > 10) {
                        gesture.swipeDecided = true;
                    }
                }

                if (gesture.swiping) {
                    e.preventDefault();
                    applySwipe(dx);
                }
            }
        }
    }, { passive: false });

    viewer.addEventListener('touchend', (e) => {
        const finished = gesture;

        if (e.touches.length === 1) {
            gesture = {
                mode: 'pan',
                startX: e.touches[0].clientX,
                startY: e.touches[0].clientY,
                startTx: zoomTx,
                startTy: zoomTy,
                swipeEligible: false
            };
            return;
        }

        if (e.touches.length === 0) {
            gesture = null;
            const changed = e.changedTouches && e.changedTouches[0];

            // Finish a continuous gallery swipe.
            if (finished && finished.swiping && swipeDrag && changed) {
                const dt = Date.now() - finished.startTime;
                endSwipe(changed.clientX - finished.startX, dt);
                return;
            }

            resetZoom();

            // A quick double tap opens the image preview (Gallery / Live only).
            if (finished && finished.mode === 'pan' && !finished.startOnBadges
                && changed && (currentTab === 'gallery' || currentTab === 'live')) {
                const dx = changed.clientX - finished.startX;
                const dy = changed.clientY - finished.startY;
                if (Math.hypot(dx, dy) <= 12) {
                    registerTap(changed.clientX, changed.clientY);
                } else {
                    lastTapTime = 0;
                }
            }
        }
    }, { passive: false });

    viewer.addEventListener('touchcancel', () => {
        if (gesture && gesture.swiping) cancelSwipeGraphic();
        gesture = null;
        resetZoom();
    });
}

function initWheelNavigation() {
    viewer.addEventListener('wheel', (e) => {
        if (e.ctrlKey) return; // let ctrl+wheel / trackpad-pinch zoom the page
        if (currentTab !== 'gallery' || totalImages === 0) return;

        e.preventDefault();

        const now = performance.now();
        if (now < wheelLockUntil) return;

        // Normalize line/page deltas to pixels so trackpads and mice behave the same.
        const unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? 100 : 1);
        wheelAccum += e.deltaY * unit;

        if (Math.abs(wheelAccum) >= 50) {
            const direction = wheelAccum > 0 ? 1 : -1;
            wheelAccum = 0;
            wheelLockUntil = now + 250;
            navigate(direction);
        }
    }, { passive: false });
}

const DESKTOP_MQ = window.matchMedia('(min-width: 900px)');

function visibleTabs() {
    const tabs = [];
    if (!simpleMode) tabs.push('gallery');
    tabs.push('live');
    if (!DESKTOP_MQ.matches) tabs.push('prompt'); // on desktop the Settings panel is docked
    return tabs;
}

function updateTabIndicator() {
    const tabs = visibleTabs();
    let index = tabs.indexOf(currentTab);
    if (index < 0) index = 0;
    if (tabIndicatorEl) {
        tabIndicatorEl.style.width = `calc((100% - 8px) / ${tabs.length})`;
        tabIndicatorEl.style.transform = `translateX(${index * 100}%)`;
    }
}

/* ---------- Draggable tab navigation ---------- */

let tabsDrag = null;
let tabsSuppressClickUntil = 0;

function tabsGeometry() {
    const tabs = visibleTabs();
    const rect = tabsEl.getBoundingClientRect();
    const innerW = Math.max(1, rect.width - 8);
    return { tabs: tabs, rect: rect, tabW: innerW / tabs.length };
}

// Continuous indicator position (0 = first tab, N-1 = last) for a pointer x.
function tabsPositionAt(clientX) {
    const g = tabsGeometry();
    const pos = (clientX - (g.rect.left + 4)) / g.tabW - 0.5;
    return Math.max(0, Math.min(g.tabs.length - 1, pos));
}

function onTabsPointerDown(e) {
    if (tabsDrag) return;
    if (e.button !== undefined && e.button !== 0) return;
    if (!tabsEl) return;
    const g = tabsGeometry();
    if (g.tabs.length === 0) return;

    let startIndex = g.tabs.indexOf(currentTab);
    if (startIndex < 0) startIndex = 0;
    tabsDrag = { pointerId: e.pointerId, startX: e.clientX, dragging: false, currentIndex: startIndex };
    document.addEventListener('pointermove', onTabsPointerMove, { passive: false });
    document.addEventListener('pointerup', onTabsPointerUp);
    document.addEventListener('pointercancel', onTabsPointerUp);
}

function onTabsPointerMove(e) {
    if (!tabsDrag || e.pointerId !== tabsDrag.pointerId) return;

    const dx = e.clientX - tabsDrag.startX;
    if (!tabsDrag.dragging) {
        if (Math.abs(dx) < 6) return;
        tabsDrag.dragging = true;
        if (tabIndicatorEl) tabIndicatorEl.style.transition = 'none';
    }

    if (e.cancelable) e.preventDefault();
    const g = tabsGeometry();
    const pos = tabsPositionAt(e.clientX);

    // Switch as soon as the highlight is mostly over another tab so the user
    // sees the content they are dragging to.
    const nearest = Math.max(0, Math.min(g.tabs.length - 1, Math.round(pos)));
    if (nearest !== tabsDrag.currentIndex) {
        tabsDrag.currentIndex = nearest;
        switchTab(g.tabs[nearest]);
    }

    if (tabIndicatorEl) tabIndicatorEl.style.transform = `translateX(${pos * 100}%)`;
}

function onTabsPointerUp(e) {
    if (!tabsDrag || e.pointerId !== tabsDrag.pointerId) return;
    const wasDragging = tabsDrag.dragging;
    tabsDrag = null;

    document.removeEventListener('pointermove', onTabsPointerMove);
    document.removeEventListener('pointerup', onTabsPointerUp);
    document.removeEventListener('pointercancel', onTabsPointerUp);

    if (!wasDragging) return;

    // Swallow the click the browser emits after a drag.
    tabsSuppressClickUntil = Date.now() + 400;
    if (tabIndicatorEl) tabIndicatorEl.style.transition = '';

    const g = tabsGeometry();
    const index = Math.round(tabsPositionAt(e.clientX));
    switchTab(g.tabs[index]);
}

function initTabsDrag() {
    if (!tabsEl) return;

    tabsEl.addEventListener('pointerdown', onTabsPointerDown);

    // Capture phase to block the tab button's onclick right after a drag.
    tabsEl.addEventListener('click', (e) => {
        if (Date.now() < tabsSuppressClickUntil) {
            e.stopPropagation();
            e.preventDefault();
        }
    }, true);
}

/* ---------- Draggable accordions ---------- */

let accDrag = null;
let accSuppressClickUntil = 0;

function closeOtherAccordions(item) {
    const openItems = document.querySelectorAll('#promptContainer .acc-item.open');
    openItems.forEach((other) => {
        if (other === item) return;
        other.classList.remove('open');
        const header = other.querySelector('.acc-header');
        if (header) header.setAttribute('aria-expanded', 'false');
    });
}

function onAccPointerDown(e) {
    if (accDrag) return;
    if (e.button !== undefined && e.button !== 0) return;

    const header = e.currentTarget;
    const item = header.closest('.acc-item');
    if (!item) return;
    const body = item.querySelector('.acc-body');
    const inner = item.querySelector('.acc-body-inner');
    if (!body || !inner) return;

    const wasOpen = item.classList.contains('open');
    const contentH = inner.offsetHeight;
    const maxH = DESKTOP_MQ.matches ? contentH : Math.min(contentH, window.innerHeight * 0.8);

    accDrag = {
        pointerId: e.pointerId,
        item: item,
        header: header,
        body: body,
        startY: e.clientY,
        wasOpen: wasOpen,
        startH: wasOpen ? body.getBoundingClientRect().height : 0,
        maxH: maxH,
        lastH: wasOpen ? body.getBoundingClientRect().height : 0,
        dragging: false
    };

    document.addEventListener('pointermove', onAccPointerMove, { passive: false });
    document.addEventListener('pointerup', onAccPointerUp);
    document.addEventListener('pointercancel', onAccPointerUp);
}

function onAccPointerMove(e) {
    if (!accDrag || e.pointerId !== accDrag.pointerId) return;

    const dy = e.clientY - accDrag.startY;
    if (!accDrag.dragging) {
        if (Math.abs(dy) < 6) return;
        accDrag.dragging = true;
        accDrag.body.style.transition = 'none';
    }

    if (e.cancelable) e.preventDefault();
    const h = Math.max(0, Math.min(accDrag.maxH, accDrag.startH + dy));
    accDrag.body.style.maxHeight = h + 'px';
    accDrag.body.style.opacity = accDrag.maxH ? String(h / accDrag.maxH) : '0';
    accDrag.lastH = h;
}

function onAccPointerUp(e) {
    if (!accDrag || e.pointerId !== accDrag.pointerId) return;

    const drag = accDrag;
    accDrag = null;
    document.removeEventListener('pointermove', onAccPointerMove);
    document.removeEventListener('pointerup', onAccPointerUp);
    document.removeEventListener('pointercancel', onAccPointerUp);

    if (!drag.dragging) return; // a tap -> let the header's click toggle it

    // Block the click the browser fires after a drag.
    accSuppressClickUntil = Date.now() + 400;
    const willOpen = drag.lastH > drag.maxH / 2;

    // Commit the open/closed state first, then hand sizing back to CSS and let
    // it transition from the released drag height.
    if (willOpen) {
        closeOtherAccordions(drag.item);
        drag.item.classList.add('open');
        drag.header.setAttribute('aria-expanded', 'true');
    } else {
        drag.item.classList.remove('open');
        drag.header.setAttribute('aria-expanded', 'false');
    }

    drag.body.style.transition = '';
    void drag.body.offsetHeight; // flush the committed state before clearing inline sizes
    drag.body.style.maxHeight = '';
    drag.body.style.opacity = '';
}

function initAccordionDrag() {
    if (!promptContainer) return;

    promptContainer.querySelectorAll('.acc-header').forEach((header) => {
        header.addEventListener('pointerdown', onAccPointerDown);
    });

    promptContainer.addEventListener('click', (e) => {
        if (Date.now() < accSuppressClickUntil) {
            e.stopPropagation();
            e.preventDefault();
        }
    }, true);
}

function applySimpleMode() {
    document.body.classList.toggle('simple-mode', simpleMode);
    const toggle = document.getElementById('simpleModeToggle');
    if (toggle) toggle.checked = simpleMode;
    updateTabIndicator();
}

function initSimpleMode() {
    try {
        simpleMode = localStorage.getItem('inx-simple') === '1';
    } catch (e) {
        simpleMode = false;
    }
    applySimpleMode();
}

function setSimpleMode(on) {
    simpleMode = !!on;
    try {
        localStorage.setItem('inx-simple', simpleMode ? '1' : '0');
    } catch (e) {}
    applySimpleMode();
    if (simpleMode && currentTab === 'gallery') {
        switchTab('live');
    } else {
        switchTab(currentTab);
    }
}

function onLayoutChange() {
    if (DESKTOP_MQ.matches && currentTab === 'prompt') {
        switchTab('gallery');
    } else {
        updateTabIndicator();
    }
}

const THEME_COLORS = {
    dark: '#05060a',
    light: '#e9edf6',
    oled: '#000000',
    simple: '#202024',
    purpur: '#11001c'
};

let themeMenuOpen = false;

function applyTheme(name) {
    if (!THEME_COLORS[name]) name = 'dark';
    document.documentElement.setAttribute('data-theme', name);
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute('content', THEME_COLORS[name]);
    try {
        localStorage.setItem('inx-theme', name);
    } catch (e) {}
    updateThemeMenuActive();
}

function updateThemeMenuActive() {
    if (!themeMenu) return;
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    themeMenu.querySelectorAll('.theme-item').forEach(function (item) {
        const active = item.dataset.themeValue === current;
        item.classList.toggle('active', active);
        item.setAttribute('aria-checked', active ? 'true' : 'false');
    });
}

function toggleThemeMenu(ev) {
    if (ev) ev.stopPropagation();
    if (themeMenuOpen) {
        closeThemeMenu();
    } else {
        openThemeMenu();
    }
}

function openThemeMenu() {
    if (!themeMenu || themeMenuOpen) return;
    themeMenuOpen = true;
    themeMenu.classList.add('open');
    themeMenu.setAttribute('aria-hidden', 'false');
    if (themeToggleBtn) themeToggleBtn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onDocumentClickCloseThemeMenu, true);
}

function closeThemeMenu() {
    if (!themeMenu) return;
    themeMenuOpen = false;
    themeMenu.classList.remove('open');
    themeMenu.setAttribute('aria-hidden', 'true');
    if (themeToggleBtn) themeToggleBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDocumentClickCloseThemeMenu, true);
}

function onDocumentClickCloseThemeMenu(e) {
    if (themeMenu.contains(e.target)) return;
    if (themeToggleBtn && themeToggleBtn.contains(e.target)) return;
    closeThemeMenu();
}

function initThemeMenu() {
    if (!themeMenu) return;
    themeMenu.querySelectorAll('.theme-item').forEach(function (item) {
        item.addEventListener('click', function (e) {
            e.stopPropagation();
            applyTheme(item.dataset.themeValue);
            closeThemeMenu();
        });
    });
    updateThemeMenuActive();
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
    updateUpscaleBadge();
    updateResBadge();
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
        const genOverridden = settingsData && settingsData.overrides && Object.keys(settingsData.overrides).length > 0;
        const resOverridden = !!(settingsData && settingsData.resolution_overridden);
        const overridden = genOverridden || resOverridden;
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

function animateGallerySlide(direction, previousSrc, previousRect) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const width = viewer.clientWidth || 300;
    const duration = 220;
    const easing = 'cubic-bezier(0.22, 1, 0.36, 1)';

    // Slide the outgoing image away with a temporary ghost layer.
    if (previousSrc && previousRect) {
        const viewerRect = viewer.getBoundingClientRect();
        const ghost = document.createElement('img');
        ghost.className = 'swipe-ghost';
        ghost.src = previousSrc;
        ghost.style.left = (previousRect.left - viewerRect.left) + 'px';
        ghost.style.top = (previousRect.top - viewerRect.top) + 'px';
        ghost.style.width = previousRect.width + 'px';
        ghost.style.height = previousRect.height + 'px';
        viewer.appendChild(ghost);

        const ghostAnim = ghost.animate(
            [{ transform: 'translateX(0)' }, { transform: `translateX(${-direction * width}px)` }],
            { duration: duration, easing: easing }
        );
        ghostAnim.onfinish = () => ghost.remove();
        setTimeout(() => ghost.remove(), duration + 200);
    }

    // Slide the incoming image into view.
    if (galleryAnim) galleryAnim.cancel();
    galleryAnim = img.animate(
        [{ transform: `translateX(${direction * width}px)` }, { transform: 'translateX(0)' }],
        { duration: duration, easing: easing }
    );
}

/* ---------- Continuous gallery swipe ---------- */

function beginSwipeDrag() {
    if (swipeDrag) return;
    if (currentTab !== 'gallery' || totalImages === 0) return;
    const vRect = viewer.getBoundingClientRect();
    const iRect = img.getBoundingClientRect();
    if (!iRect.width || !vRect.width) return;

    swipeDrag = {
        rect: { left: iRect.left, top: iRect.top, width: iRect.width, height: iRect.height },
        viewerRect: { left: vRect.left, top: vRect.top, width: vRect.width, height: vRect.height },
        ghost: null,
        dir: 0,
        baseOffset: 0
    };
    img.style.transition = 'none';
}

function removeSwipeGhost() {
    if (swipeDrag && swipeDrag.ghost) {
        swipeDrag.ghost.remove();
        swipeDrag.ghost = null;
        swipeDrag.dir = 0;
    }
}

function ensureSwipeGhost(dir) {
    if (!swipeDrag) return;
    if (swipeDrag.dir === dir && swipeDrag.ghost) return;
    removeSwipeGhost();

    const target = (currentIndex - 1) + dir;
    if (target < 0 || target >= totalImages) return;

    const rect = swipeDrag.rect;
    const vRect = swipeDrag.viewerRect;
    const ghost = document.createElement('img');
    ghost.className = 'swipe-ghost';
    ghost.draggable = false;
    ghost.style.left = (rect.left - vRect.left) + 'px';
    ghost.style.top = (rect.top - vRect.top) + 'px';
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    swipeDrag.baseOffset = dir === 1 ? vRect.width : -vRect.width;
    ghost.style.transform = `translateX(${swipeDrag.baseOffset}px)`;

    const cached = getCachedImageUrl(target);
    if (cached) {
        ghost.src = cached;
    } else {
        loadImageUrl(target).then(function (url) {
            if (swipeDrag && swipeDrag.ghost === ghost) ghost.src = url;
        }).catch(function () {});
    }

    viewer.appendChild(ghost);
    swipeDrag.dir = dir;
    swipeDrag.ghost = ghost;
}

function applySwipe(dx) {
    if (!swipeDrag) return;
    const index = currentIndex - 1;
    const dir = dx < 0 ? 1 : -1; // dragging left reveals the next image
    const hasNeighbor = (index + dir) >= 0 && (index + dir) < totalImages;

    let eff = dx;
    if (hasNeighbor) {
        ensureSwipeGhost(dir);
    } else {
        removeSwipeGhost();
        eff = dx * 0.35; // rubber-band at the ends
    }

    img.style.transform = `translateX(${eff}px)`;
    if (swipeDrag && swipeDrag.ghost) {
        swipeDrag.ghost.style.transform = `translateX(${swipeDrag.baseOffset + eff}px)`;
    }
}

function animateSwipeTo(imgTx, ghostTx, onDone) {
    const duration = 200;
    const easing = 'cubic-bezier(0.22, 1, 0.36, 1)';
    img.style.transition = `transform ${duration}ms ${easing}`;
    img.style.transform = `translateX(${imgTx}px)`;
    if (swipeDrag && swipeDrag.ghost) {
        swipeDrag.ghost.style.transition = `transform ${duration}ms ${easing}`;
        swipeDrag.ghost.style.transform = `translateX(${ghostTx}px)`;
    }
    setTimeout(onDone, duration + 30);
}

function cancelSwipeGraphic() {
    if (!swipeDrag) return;
    removeSwipeGhost();
    swipeDrag = null;
    img.style.transition = 'none';
    img.style.transform = '';
    requestAnimationFrame(function () { img.style.transition = ''; });
}

function commitSwipeGraphic(targetDir) {
    if (!swipeDrag) return;
    const ghost = swipeDrag.ghost;
    const ghostUrl = ghost ? ghost.getAttribute('src') : null;
    if (ghost) ghost.remove();
    swipeDrag = null;

    currentIndex += targetDir;
    if (ghostUrl) img.src = ghostUrl;
    displayedImageKey = null;
    updateGalleryImage();
    img.style.transition = 'none';
    img.style.transform = '';
    requestAnimationFrame(function () { img.style.transition = ''; });
}

function endSwipe(dx, dt) {
    if (!swipeDrag) return;
    const w = swipeDrag.viewerRect.width;
    const index = currentIndex - 1;
    const velocity = dx / Math.max(1, dt);
    const distThreshold = w * 0.3;
    const velThreshold = 0.4; // px per ms

    let targetDir = 0;
    if (dx < 0 && (index + 1) < totalImages && (Math.abs(dx) > distThreshold || velocity < -velThreshold)) {
        targetDir = 1;
    } else if (dx > 0 && (index - 1) >= 0 && (dx > distThreshold || velocity > velThreshold)) {
        targetDir = -1;
    }

    if (targetDir === 0 || !swipeDrag.ghost) {
        // Snap back into place.
        animateSwipeTo(0, swipeDrag.baseOffset, cancelSwipeGraphic);
    } else {
        animateSwipeTo(-targetDir * w, 0, function () { commitSwipeGraphic(targetDir); });
    }
}

async function updateGalleryImage(slideDirection) {
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
        updateUpscaleButton();
        updateUpscaleBadge();
        updateResBadge();
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
    updateUpscaleButton();
    updateUpscaleBadge();

    const index = currentIndex - 1;
    const key = `gallery:${imageEpoch}:${index}`;
    if (key === displayedImageKey) return;

    const token = ++galleryLoadToken;
    try {
        const url = await loadImageUrl(index);
        if (token !== galleryLoadToken) return;
        const previousSrc = (img.style.display !== 'none' && img.src) ? img.src : null;
        const previousRect = previousSrc ? img.getBoundingClientRect() : null;
        placeholder.style.display = 'none';
        img.style.display = 'block';
        img.src = url;
        displayedImageKey = key;
        activeImageKey = `${imageEpoch}:${index}`;
        updateResBadge();
        if (slideDirection) animateGallerySlide(slideDirection, previousSrc, previousRect);
        prefetchImage(index - 1);
        prefetchImage(index + 1);
    } catch (e) {
        if (token !== galleryLoadToken) return;
        img.style.display = 'none';
        placeholder.style.display = 'block';
        placeholder.textContent = 'Image unavailable.';
        updateResBadge();
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
        // Keep the full-width double-tap preview streaming along with the live view.
        if (previewOpen) previewImage.src = livePreviewUrl;
    }
}

function navigate(delta) {
    const newIndex = currentIndex + delta;
    if (newIndex >= 1 && newIndex <= totalImages) {
        currentIndex = newIndex;
        updateGalleryImage(delta);
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

                    if (Array.isArray(data.upscaled)) {
                        upscaledIndices = new Set(data.upscaled);
                    }

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

                    if (data.focus !== undefined && data.focus !== null) {
                        currentIndex = Math.max(1, Math.min(totalImages, Number(data.focus) + 1));
                        if (currentTab !== 'gallery') {
                            switchTab('gallery');
                        } else {
                            updateGalleryImage();
                            updateUpscaleBadge();
                        }
                    }

                    if (data.type === 'init') {
                        applyUpscaleState({ available: data.upscaler_available, available4k: data.upscaler_4k_available, running: data.upscale_running });
                    }
                } else if (data.type === 'upscale_status') {
                    applyUpscaleState({ running: data.running });
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
                    closeComparison();
                    closeImagePreview(true);
                    totalImages = 0;
                    currentIndex = 0;
                    upscaledIndices = new Set();
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

function updateUpscaleButton() {
    const base = (upscaling || totalImages === 0);

    if (upscaleBtn4k) {
        upscaleBtn4k.disabled = base || !upscaler4kAvailable;
        upscaleBtn4k.title = upscaler4kAvailable ? '' : 'Requires the SeedVR2 extension and 4k_upscaler_api.json';
    }
    if (upscaleBtn20) {
        upscaleBtn20.disabled = base || !upscalerAvailable;
        upscaleBtn20.title = upscalerAvailable ? '' : 'Requires the SeedVR2 extension and upscaler_api.json';
    }
}

function applyUpscaleState(data) {
    if (!data) return;
    if (data.available !== undefined) upscalerAvailable = !!data.available;
    if (data.available4k !== undefined) upscaler4kAvailable = !!data.available4k;

    const wasUpscaling = upscaling;
    if (data.running !== undefined) upscaling = !!data.running;

    if (upscaling) {
        status.textContent = 'Upscaling...';
        status.style.color = '#FFA000';
        runBtn.disabled = true;
        loopBtn.disabled = true;
    } else {
        runBtn.disabled = false;
        loopBtn.disabled = false;
        if (wasUpscaling) {
            if (data.error) {
                status.textContent = 'Upscale failed';
                status.style.color = '#F44336';
                showAlert(data.error, 'Upscale');
            } else {
                status.textContent = 'Done.';
                status.style.color = '#30D158';
            }
        }
    }
    updateUpscaleButton();
}

function updateUpscaleBadge() {
    if (!upscaleBadge) return;
    const show = currentTab === 'gallery' && totalImages > 0 && upscaledIndices.has(currentIndex - 1);
    upscaleBadge.classList.toggle('visible', show);
}

function updateResBadge() {
    if (!resBadge) return;
    const show = currentTab === 'gallery' && totalImages > 0
        && img.style.display !== 'none' && img.naturalWidth > 0 && img.naturalHeight > 0;
    if (show) {
        resBadge.textContent = `${img.naturalWidth}x${img.naturalHeight}`;
    }
    resBadge.classList.toggle('visible', show);
}

async function applyResolutionToSettings() {
    if (currentTab !== 'gallery' || totalImages === 0) return;
    if (img.style.display === 'none' || !img.naturalWidth || !img.naturalHeight) return;

    const width = img.naturalWidth;
    const height = img.naturalHeight;

    if (!(await showConfirm(`Use ${width}x${height} for the Custom Size?`, {
        title: 'Set Custom Size',
        confirmText: 'Apply'
    }))) {
        return;
    }

    const customEl = document.getElementById('resCustom');
    const wEl = document.getElementById('resWidth');
    const hEl = document.getElementById('resHeight');
    if (!customEl || !wEl || !hEl) return;

    customEl.checked = true;
    wEl.value = String(width);
    hEl.value = String(height);
    settingsDirty = true;
    updateGenerationUI();
    await flushSettings();

    status.textContent = `Size set to ${width}x${height}`;
    status.style.color = '#4CAF50';
    setTimeout(() => {
        if (status.textContent.startsWith('Size set')) {
            status.textContent = 'Ready';
            status.style.color = '#4CAF50';
        }
    }, 2500);
}

/* ---------- Before / after comparison ---------- */

function setComparePos(percent) {
    const pos = Math.max(0, Math.min(100, percent));
    compareAfter.style.clipPath = `inset(0 0 0 ${pos}%)`;
    compareDivider.style.left = `${pos}%`;
}

function updateCompareFromClientX(clientX) {
    const rect = compareFrame.getBoundingClientRect();
    if (!rect.width) return;
    setComparePos(((clientX - rect.left) / rect.width) * 100);
}

async function openComparison() {
    if (compareOpen || compareLoading) return;
    if (currentTab !== 'gallery' || totalImages === 0) return;

    const index = currentIndex - 1;
    if (!upscaledIndices.has(index)) return;

    compareLoading = true;
    try {
        const afterUrl = await loadImageUrl(index);
        const resp = await fetch(`/inx/image/original?index=${index}`);
        if (!resp.ok) throw new Error('original unavailable');
        const originalUrl = URL.createObjectURL(await resp.blob());

        compareOriginalUrl = originalUrl;
        compareBefore.src = originalUrl;
        compareAfter.src = afterUrl;
        setComparePos(50);
        closeSaveMenu();
        compareOverlay.classList.add('open');
        compareOverlay.setAttribute('aria-hidden', 'false');
        compareOpen = true;
        document.addEventListener('keydown', onCompareKeydown, true);
    } catch (e) {
        if (compareOriginalUrl) {
            URL.revokeObjectURL(compareOriginalUrl);
            compareOriginalUrl = null;
        }
        showAlert('The original image is no longer available.', 'Compare');
    } finally {
        compareLoading = false;
    }
}

function closeComparison() {
    if (!compareOpen) return;
    compareOpen = false;
    compareDragging = false;
    compareStart = null;
    compareOverlay.classList.remove('open');
    compareOverlay.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', onCompareKeydown, true);
    compareBefore.removeAttribute('src');
    compareAfter.removeAttribute('src');
    if (compareOriginalUrl) {
        URL.revokeObjectURL(compareOriginalUrl);
        compareOriginalUrl = null;
    }
}

function onCompareKeydown(e) {
    if (e.key === 'Escape') {
        e.preventDefault();
        closeComparison();
    }
}

function initCompareGestures() {
    if (!compareOverlay) return;

    compareOverlay.addEventListener('pointerdown', (e) => {
        if (!compareOpen) return;
        const inFrame = compareFrame.contains(e.target);
        compareStart = { x: e.clientX, y: e.clientY, moved: false, inFrame: inFrame };

        if (inFrame) {
            compareDragging = true;
            try { compareOverlay.setPointerCapture(e.pointerId); } catch (err) {}
            updateCompareFromClientX(e.clientX);
            e.preventDefault();
        }
    });

    compareOverlay.addEventListener('pointermove', (e) => {
        if (!compareOpen || !compareStart) return;
        if (Math.abs(e.clientX - compareStart.x) > 6 || Math.abs(e.clientY - compareStart.y) > 6) {
            compareStart.moved = true;
        }
        if (compareDragging) {
            e.preventDefault();
            updateCompareFromClientX(e.clientX);
        }
    });

    const endPointer = (e) => {
        if (!compareOpen) return;
        const started = compareStart;
        const wasDragging = compareDragging;
        compareDragging = false;
        compareStart = null;
        try { compareOverlay.releasePointerCapture(e.pointerId); } catch (err) {}

        // A tap (not a drag) outside the image closes the view.
        if (started && !wasDragging && !started.moved && !started.inFrame) {
            closeComparison();
        }
    };

    compareOverlay.addEventListener('pointerup', endPointer);
    compareOverlay.addEventListener('pointercancel', () => {
        compareDragging = false;
        compareStart = null;
    });
}

/* ---------- Full-width image preview ---------- */

function registerTap(x, y) {
    const now = Date.now();
    if (now - lastTapTime < 300 && Math.hypot(x - lastTapX, y - lastTapY) < 40) {
        lastTapTime = 0;
        openImagePreview();
    } else {
        lastTapTime = now;
        lastTapX = x;
        lastTapY = y;
    }
}

function openImagePreview() {
    if (previewOpen) return;
    if (currentTab !== 'gallery' && currentTab !== 'live') return;
    if (!img || img.style.display === 'none' || !img.src) return;

    resetPreviewTransform();
    previewImage.src = img.src;
    previewOverlay.classList.add('open');
    previewOverlay.setAttribute('aria-hidden', 'false');
    previewOpen = true;
    document.addEventListener('keydown', onPreviewKeydown, true);

    // Let the phone's back button (popstate) close the preview.
    try { history.pushState({ inxPreview: true }, ''); } catch (e) {}
}

function closeImagePreview(fromPopState) {
    if (!previewOpen) return;
    previewOpen = false;
    lastTapTime = 0;
    previewLastTap = { t: 0, x: 0, y: 0 };
    previewPointers.clear();
    previewPan = null;
    previewPinch = null;
    resetPreviewTransform();
    previewOverlay.classList.remove('open');
    previewOverlay.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', onPreviewKeydown, true);
    previewImage.removeAttribute('src');

    // Pop the history entry we pushed, unless the back button already did.
    if (!fromPopState) {
        try {
            if (history.state && history.state.inxPreview) history.back();
        } catch (e) {}
    }
}

function onPreviewKeydown(e) {
    if (e.key === 'Escape') {
        e.preventDefault();
        closeImagePreview(false);
    }
}

function resetPreviewTransform() {
    previewScale = 1;
    previewTx = 0;
    previewTy = 0;
    previewImage.style.transform = '';
}

function clampPreviewTransform() {
    const rect = previewOverlay.getBoundingClientRect();
    const scaledW = previewImage.offsetWidth * previewScale;
    const scaledH = previewImage.offsetHeight * previewScale;
    const maxTx = Math.max(0, (scaledW - rect.width) / 2);
    const maxTy = Math.max(0, (scaledH - rect.height) / 2);
    previewTx = Math.min(maxTx, Math.max(-maxTx, previewTx));
    previewTy = Math.min(maxTy, Math.max(-maxTy, previewTy));
}

function applyPreviewTransform() {
    if (previewScale <= 1.001) {
        resetPreviewTransform();
        return;
    }
    clampPreviewTransform();
    previewImage.style.transform = `translate(${previewTx}px, ${previewTy}px) scale(${previewScale})`;
}

function handlePreviewTap(x, y, onImage) {
    if (!onImage) {
        // A tap on the blurred backdrop closes the preview.
        previewLastTap = { t: 0, x: 0, y: 0 };
        closeImagePreview(false);
        return;
    }
    const now = Date.now();
    if (now - previewLastTap.t < 350 && Math.hypot(x - previewLastTap.x, y - previewLastTap.y) < 40) {
        previewLastTap = { t: 0, x: 0, y: 0 };
        closeImagePreview(false);
    } else {
        previewLastTap = { t: now, x: x, y: y };
    }
}

function onPreviewPointerDown(e) {
    if (!previewOpen) return;
    if (e.pointerType === 'touch') return; // touch gestures are handled by touch events
    previewPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { previewOverlay.setPointerCapture(e.pointerId); } catch (err) {}

    if (previewPointers.size === 2) {
        const pts = Array.from(previewPointers.values());
        const dx = pts[0].x - pts[1].x;
        const dy = pts[0].y - pts[1].y;
        previewPinch = {
            startDist: Math.hypot(dx, dy) || 1,
            startScale: previewScale,
            startTx: previewTx,
            startTy: previewTy,
            startMidX: (pts[0].x + pts[1].x) / 2,
            startMidY: (pts[0].y + pts[1].y) / 2
        };
        previewPan = null;
    } else if (previewPointers.size === 1) {
        previewPan = {
            startX: e.clientX,
            startY: e.clientY,
            startTx: previewTx,
            startTy: previewTy,
            moved: false,
            onImage: !!(previewImage && previewImage.contains(e.target))
        };
    }
    e.preventDefault();
}

function onPreviewPointerMove(e) {
    if (e.pointerType === 'touch') return;
    if (!previewPointers.has(e.pointerId)) return;
    previewPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (previewPinch && previewPointers.size >= 2) {
        e.preventDefault();
        const pts = Array.from(previewPointers.values());
        const dx = pts[0].x - pts[1].x;
        const dy = pts[0].y - pts[1].y;
        const dist = Math.hypot(dx, dy) || 1;
        const midX = (pts[0].x + pts[1].x) / 2;
        const midY = (pts[0].y + pts[1].y) / 2;

        const rect = previewOverlay.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;

        const s0 = previewPinch.startScale;
        const f0x = previewPinch.startMidX - cx;
        const f0y = previewPinch.startMidY - cy;

        const newScale = Math.min(PREVIEW_MAX_ZOOM, Math.max(PREVIEW_MIN_ZOOM, s0 * (dist / previewPinch.startDist)));
        previewScale = newScale;

        previewTx = previewPinch.startTx
            + (s0 - newScale) * (f0x - previewPinch.startTx) / s0
            + ((midX - cx) - f0x);
        previewTy = previewPinch.startTy
            + (s0 - newScale) * (f0y - previewPinch.startTy) / s0
            + ((midY - cy) - f0y);

        applyPreviewTransform();
    } else if (previewPan && previewPointers.size === 1) {
        const dx = e.clientX - previewPan.startX;
        const dy = e.clientY - previewPan.startY;
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) previewPan.moved = true;
        if (previewScale > 1) {
            e.preventDefault();
            previewTx = previewPan.startTx + dx;
            previewTy = previewPan.startTy + dy;
            applyPreviewTransform();
        }
    }
}

function onPreviewPointerUp(e) {
    if (e.pointerType === 'touch') return;
    if (!previewPointers.has(e.pointerId)) return;
    const wasPan = previewPan;
    previewPointers.delete(e.pointerId);
    try { previewOverlay.releasePointerCapture(e.pointerId); } catch (err) {}

    if (previewPointers.size === 0) {
        // A tap (no drag, no pinch) closes the view.
        if (wasPan && !wasPan.moved && !previewPinch) {
            handlePreviewTap(wasPan.startX, wasPan.startY, wasPan.onImage);
        }
        previewPan = null;
        previewPinch = null;
    } else if (previewPointers.size === 1) {
        // Dropped from a pinch to a single finger; keep panning from here.
        const pt = Array.from(previewPointers.values())[0];
        previewPan = {
            startX: pt.x,
            startY: pt.y,
            startTx: previewTx,
            startTy: previewTy,
            moved: true,
            onImage: false
        };
        previewPinch = null;
    }
}

function onPreviewTouchStart(e) {
    if (!previewOpen) return;
    e.preventDefault();

    if (e.touches.length >= 2) {
        const a = e.touches[0];
        const b = e.touches[1];
        const dx = a.clientX - b.clientX;
        const dy = a.clientY - b.clientY;
        previewPinch = {
            startDist: Math.hypot(dx, dy) || 1,
            startScale: previewScale,
            startTx: previewTx,
            startTy: previewTy,
            startMidX: (a.clientX + b.clientX) / 2,
            startMidY: (a.clientY + b.clientY) / 2
        };
        previewPan = null;
    } else if (e.touches.length === 1) {
        const t = e.touches[0];
        previewPan = {
            startX: t.clientX,
            startY: t.clientY,
            startTx: previewTx,
            startTy: previewTy,
            moved: false,
            onImage: !!(previewImage && previewImage.contains(e.target))
        };
        previewPinch = null;
    }
}

function onPreviewTouchMove(e) {
    if (!previewOpen) return;

    if (e.touches.length >= 2 && previewPinch) {
        e.preventDefault();
        const a = e.touches[0];
        const b = e.touches[1];
        const dx = a.clientX - b.clientX;
        const dy = a.clientY - b.clientY;
        const dist = Math.hypot(dx, dy) || 1;
        const midX = (a.clientX + b.clientX) / 2;
        const midY = (a.clientY + b.clientY) / 2;

        const rect = previewOverlay.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;

        const s0 = previewPinch.startScale;
        const f0x = previewPinch.startMidX - cx;
        const f0y = previewPinch.startMidY - cy;

        const newScale = Math.min(PREVIEW_MAX_ZOOM, Math.max(PREVIEW_MIN_ZOOM, s0 * (dist / previewPinch.startDist)));
        previewScale = newScale;

        previewTx = previewPinch.startTx
            + (s0 - newScale) * (f0x - previewPinch.startTx) / s0
            + ((midX - cx) - f0x);
        previewTy = previewPinch.startTy
            + (s0 - newScale) * (f0y - previewPinch.startTy) / s0
            + ((midY - cy) - f0y);

        applyPreviewTransform();
    } else if (e.touches.length === 1 && previewPan) {
        const t = e.touches[0];
        const dx = t.clientX - previewPan.startX;
        const dy = t.clientY - previewPan.startY;
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) previewPan.moved = true;
        if (previewScale > 1) {
            e.preventDefault();
            previewTx = previewPan.startTx + dx;
            previewTy = previewPan.startTy + dy;
            applyPreviewTransform();
        }
    }
}

function onPreviewTouchEnd(e) {
    if (!previewOpen) return;
    const finishedPan = previewPan;
    const finishedPinch = previewPinch;

    if (e.touches.length === 0) {
        // A lone tap (no drag, no pinch) closes the view.
        if (finishedPan && !finishedPan.moved && !finishedPinch) {
            handlePreviewTap(finishedPan.startX, finishedPan.startY, finishedPan.onImage);
        }
        previewPan = null;
        previewPinch = null;
    } else if (e.touches.length === 1) {
        // A finger lifted out of a pinch; keep panning with the remaining one.
        const t = e.touches[0];
        previewPan = {
            startX: t.clientX,
            startY: t.clientY,
            startTx: previewTx,
            startTy: previewTy,
            moved: true,
            onImage: !!(previewImage && previewImage.contains(e.target))
        };
        previewPinch = null;
    }
}

function onPreviewTouchCancel() {
    previewPan = null;
    previewPinch = null;
}

function initPreviewGestures() {
    if (!previewOverlay) return;

    previewOverlay.addEventListener('pointerdown', onPreviewPointerDown);
    previewOverlay.addEventListener('pointermove', onPreviewPointerMove);
    previewOverlay.addEventListener('pointerup', onPreviewPointerUp);
    previewOverlay.addEventListener('pointercancel', onPreviewPointerUp);

    previewOverlay.addEventListener('touchstart', onPreviewTouchStart, { passive: false });
    previewOverlay.addEventListener('touchmove', onPreviewTouchMove, { passive: false });
    previewOverlay.addEventListener('touchend', onPreviewTouchEnd, { passive: false });
    previewOverlay.addEventListener('touchcancel', onPreviewTouchCancel, { passive: false });

    previewOverlay.addEventListener('wheel', (e) => {
        if (!previewOpen) return;
        e.preventDefault();
        const rect = previewOverlay.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const oldScale = previewScale;
        const factor = Math.exp(-e.deltaY * 0.0015);
        const newScale = Math.min(PREVIEW_MAX_ZOOM, Math.max(PREVIEW_MIN_ZOOM, oldScale * factor));
        previewTx = previewTx + (oldScale - newScale) * ((e.clientX - cx) - previewTx) / oldScale;
        previewTy = previewTy + (oldScale - newScale) * ((e.clientY - cy) - previewTy) / oldScale;
        previewScale = newScale;
        applyPreviewTransform();
    }, { passive: false });

    if (previewImage) {
        previewImage.addEventListener('load', () => {
            if (previewOpen) applyPreviewTransform();
        });
    }

    viewer.addEventListener('dblclick', (e) => {
        if (e.target && e.target.closest && e.target.closest('#badges')) return;
        openImagePreview();
    });
}

async function upscaleCurrentImage(mode) {
    if (totalImages === 0 || upscaling) return;
    if (mode !== '4k') mode = '2x';

    const available = mode === '4k' ? upscaler4kAvailable : upscalerAvailable;
    if (!available) {
        const file = mode === '4k' ? '4k_upscaler_api.json' : 'upscaler_api.json';
        showAlert(`No upscale workflow found. Export your workflow as API format and save it as "${file}" in the custom node folder.`, 'Upscale');
        return;
    }

    closeSaveMenu();
    const index = currentIndex - 1;
    try {
        const resp = await fetch('/inx/upscale', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ index: index, mode: mode })
        });
        const data = await resp.json();
        if (!resp.ok) {
            showAlert((data && data.message) || 'Could not start the upscale.', 'Upscale');
        }
    } catch (e) {
        showAlert('Could not start the upscale.', 'Upscale');
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

/* ---------- Long-press quick actions ---------- */

const QUICK_ACTIONS = {
    save: function () { downloadCurrentImage(); },
    delete: function () { deleteCurrentImage(); },
    upscale: function () { upscaleCurrentImage('2x'); }
};

const QUICK_LONG_PRESS_MS = 380;
let quickMenuOpen = false;
let quickPress = null;
let quickSuppressClickUntil = 0;

function quickItems() {
    return quickMenu ? Array.from(quickMenu.querySelectorAll('.quick-item')) : [];
}

function clearQuickHighlight() {
    quickItems().forEach(function (item) { item.classList.remove('active'); });
}

function openQuickMenu() {
    if (!quickMenu || quickMenuOpen || totalImages === 0) return;

    quickItems().forEach(function (item) {
        if (item.dataset.quick === 'upscale') {
            item.disabled = (!upscalerAvailable || upscaling);
        }
    });

    closeSaveMenu();
    quickMenuOpen = true;
    quickMenu.classList.add('open');
    quickMenu.setAttribute('aria-hidden', 'false');
    if (saveMenuBtn) saveMenuBtn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onQuickDocPointerDown, true);
}

function closeQuickMenu() {
    if (!quickMenu) return;
    quickMenuOpen = false;
    quickMenu.classList.remove('open');
    quickMenu.setAttribute('aria-hidden', 'true');
    clearQuickHighlight();
    if (saveMenuBtn) saveMenuBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onQuickDocPointerDown, true);
}

function onQuickDocPointerDown(e) {
    if (!quickMenuOpen) return;
    if (quickMenu.contains(e.target)) return;
    if (saveMenuBtn && saveMenuBtn.contains(e.target)) return;
    closeQuickMenu();
}

// Highlights the icon under the pointer and returns it (or null).
function setQuickHighlight(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    const item = el && el.closest ? el.closest('.quick-item') : null;
    const target = (item && !item.disabled) ? item : null;
    quickItems().forEach(function (candidate) {
        candidate.classList.toggle('active', candidate === target);
    });
    return target;
}

function triggerQuickAction(name) {
    const action = QUICK_ACTIONS[name];
    if (action) action();
}

function endQuickPress() {
    if (quickPress && quickPress.timer) clearTimeout(quickPress.timer);
    quickPress = null;
    document.removeEventListener('pointermove', onQuickPointerMove);
    document.removeEventListener('pointerup', onQuickPointerUp);
    document.removeEventListener('pointercancel', onQuickPointerCancel);
}

function onQuickPointerDown(e) {
    if (quickPress) return;
    if (e.button !== undefined && e.button !== 0) return;
    if (totalImages === 0) return;

    quickPress = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        longPressed: false,
        timer: setTimeout(function () {
            if (!quickPress) return;
            quickPress.longPressed = true;
            openQuickMenu();
            setQuickHighlight(quickPress.startX, quickPress.startY);
        }, QUICK_LONG_PRESS_MS)
    };

    document.addEventListener('pointermove', onQuickPointerMove, { passive: false });
    document.addEventListener('pointerup', onQuickPointerUp);
    document.addEventListener('pointercancel', onQuickPointerCancel);
}

function onQuickPointerMove(e) {
    if (!quickPress || e.pointerId !== quickPress.pointerId) return;

    if (!quickPress.longPressed) {
        const dx = e.clientX - quickPress.startX;
        const dy = e.clientY - quickPress.startY;
        if (Math.hypot(dx, dy) > 10) {
            // Moved before the timer fired: treat it as normal interaction.
            endQuickPress();
        }
        return;
    }

    if (e.cancelable) e.preventDefault();
    setQuickHighlight(e.clientX, e.clientY);
}

function onQuickPointerUp(e) {
    if (!quickPress || e.pointerId !== quickPress.pointerId) return;
    const wasLong = quickPress.longPressed;
    endQuickPress();

    if (wasLong) {
        // Keep the menu open; trigger only if released on top of an icon.
        const item = setQuickHighlight(e.clientX, e.clientY);
        quickSuppressClickUntil = Date.now() + 400;
        if (item) {
            closeQuickMenu();
            triggerQuickAction(item.dataset.quick);
        }
    } else if (quickMenuOpen) {
        // A plain tap while the quick menu is open just closes it.
        quickSuppressClickUntil = Date.now() + 400;
        closeQuickMenu();
    }
}

function onQuickPointerCancel(e) {
    if (!quickPress || e.pointerId !== quickPress.pointerId) return;
    endQuickPress();
}

function initQuickMenu() {
    if (!quickMenu || !saveMenuBtn) return;

    quickItems().forEach(function (item) {
        item.addEventListener('click', function (e) {
            e.stopPropagation();
            if (item.disabled) return;
            closeQuickMenu();
            triggerQuickAction(item.dataset.quick);
        });
    });

    saveMenuBtn.addEventListener('pointerdown', onQuickPointerDown);

    // Swallow the click the browser emits right after a long press.
    saveMenuBtn.addEventListener('click', function (e) {
        if (Date.now() < quickSuppressClickUntil) {
            e.stopPropagation();
            e.preventDefault();
        }
    }, true);
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
    if (!(await showConfirm("Delete all gallery images? This removes the files from disk. Your generation settings and presets are kept.", { title: 'Clear Images', confirmText: 'Delete All', danger: true }))) {
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

window.addEventListener('popstate', () => {
    if (previewOpen) closeImagePreview(true);
});

img.addEventListener('load', updateResBadge);
initZoomGestures();
initWheelNavigation();
initCompareGestures();
initPreviewGestures();
initTabsDrag();
initAccordionDrag();
initQuickMenu();
initThemeMenu();
initSimpleMode();
updateTabIndicator();
switchTab(simpleMode ? 'live' : 'gallery');
connectWS();
refreshSeeds();
loadSettings();
loadPresets();
