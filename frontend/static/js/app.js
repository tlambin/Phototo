let currentTab = 'gallery';
let currentExtFilter = '';
let galleryViewMode = 'GRID';
let cachedLibrariesData = {active_library: null, libraries: {}};
let librariesConfig = cachedLibrariesData;
let libraryModalMode = 'CREATE';
let currentLightboxIndex = -1;
let clientPausedTask = '';
let lastSeenActiveTask = '';
let latestPipelineState = {};
let currentGpuMode = 'auto';
let currentOcrEngine = 'paddleocr';
let currentFacesModel = 'buffalo_l';
let currentClipModel = 'vit-b-32';
let checkedDuplicatePaths = new Set();

let openedAlbumName = null;
let singleAlbumPage = 1;
let singleAlbumTotalPages = 1;

let pendingCreateLibFolders = [];
let pendingEditLibFolders = [];
let autoDupMode = 'KEEP_ONE';
let autoDupPriority = 'BEST_QUALITY';

// ==================== THÈME (CLAIR / SOMBRE / SYSTÈME) & BARRE MINIMISÉE ====================

let currentUiBlur = true;

function setAppBlur(enabled, persist = true) {
    currentUiBlur = Boolean(enabled);
    localStorage.setItem('phototo_ui_blur', currentUiBlur ? 'on' : 'off');
    document.documentElement.setAttribute('data-blur', currentUiBlur ? 'on' : 'off');
    const onBtn = document.getElementById('blur-btn-on');
    const offBtn = document.getElementById('blur-btn-off');
    if (onBtn) onBtn.classList.toggle('nav-item-active', currentUiBlur);
    if (offBtn) offBtn.classList.toggle('nav-item-active', !currentUiBlur);
    if (persist && typeof saveAppSettingsQuiet === 'function') {
        saveAppSettingsQuiet();
    }
}

function setAppTheme(mode) {
    localStorage.setItem('phototo_theme', mode);
    let effective = mode;
    if (mode === 'system') {
        effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', effective);
    ['light', 'dark', 'system'].forEach(m => {
        const b = document.getElementById(`theme-btn-${m}`);
        if (b) b.classList.toggle('nav-item-active', m === mode);
    });
}

function toggleSidebarMini() {
    const sb = document.getElementById('main-sidebar');
    if (!sb) return;
    sb.classList.toggle('sidebar-mini');
    const isMini = sb.classList.contains('sidebar-mini');
    document.body.classList.toggle('sidebar-mini', isMini);

    const lbl = document.getElementById('import-btn-label');
    const btn = document.getElementById('btn-top-import');
    if (lbl) lbl.classList.toggle('hidden', isMini);
    if (btn) btn.classList.replace(isMini ? 'px-5' : 'px-3', isMini ? 'px-3' : 'px-5');
}

function selectGpuPill(mode) {
    currentGpuMode = mode;
    ['auto', 'cuda', 'directml', 'cpu'].forEach(g => {
        const b = document.getElementById(`gpu-btn-${g}`);
        if (b) b.classList.toggle('nav-item-active', g === mode);
    });
    saveAppSettingsQuiet().then(() => loadHardwareInfo(false));
}

// ==================== FORMATAGE DATES & DURÉES VIDÉO ====================

function formatDate(ts) {
    if (!ts || ts === 0) return 'Date inconnue';
    return new Date(ts * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatDuration(sec) {
    if (!sec || sec <= 0) return 'Vidéo';
    const s = Math.max(1, Math.round(sec));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${String(rem).padStart(2, '0')}`;
}

function formatMonthGroupTitle(ts) {
    if (!ts || ts === 0) return 'Date inconnue';
    const s = new Date(ts * 1000).toLocaleString('fr-FR', { month: 'long', year: 'numeric' });
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatDayGroupTitle(ts) {
    if (!ts || ts === 0) return 'Date inconnue';
    const s = new Date(ts * 1000).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function isVideoFile(path) {
    return /\.(mp4|mov|avi|mkv|3gp|m4v|webm)$/i.test(path || '');
}

function renderMediaPreview(destPath, css = "w-full h-40 object-cover rounded-2xl") {
    const url = `/thumb?path=${encodeURIComponent(destPath)}`;
    if (isVideoFile(destPath)) {
        return `
        <div class="relative w-full h-full">
            <img src="${url}" loading="lazy" decoding="async" class="${css}"/>
            <span class="absolute bottom-1.5 left-1.5 bg-black/30 backdrop-blur-sm text-white/95 px-1.5 py-1 rounded-full flex items-center pointer-events-none">
                <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>
            </span>
        </div>`;
    }
    return `<img src="${url}" loading="lazy" decoding="async" class="${css}"/>`;
}

function updateGalleryMonthDropdown() {
    const sel = document.getElementById('gal-month');
    if (!sel) return;
    const cur = sel.value;
    const mNames = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];
    sel.innerHTML = `<option value="">Mois</option>` + mNames.map((n, i) => `<option value="${String(i+1).padStart(2,'0')}">${n}</option>`).join('');
    sel.value = cur;
}

let _galOptionsManuallyClosed = false;
let _albOptionsManuallyClosed = false;
let _facesOptionsManuallyClosed = false;
let _ignoreScrollUntil = 0;
let _stickyScrollLastTop = 0;
let _stickyScrollDownDist = 0;

function syncTimelineWrapperBounds() {
    const wrapper = document.getElementById('gallery-timeline-wrapper');
    const topbarEl = document.getElementById('floating-topbar');
    const mediaCol = document.getElementById('gallery-media-col');
    if (!wrapper) return;

    const minTop = topbarEl ? Math.ceil(topbarEl.getBoundingClientRect().height + 8) : 88;
    const mediaTop = mediaCol ? Math.ceil(mediaCol.getBoundingClientRect().top) : minTop;
    const topPx = Math.max(minTop, Math.min(mediaTop, Math.max(minTop, window.innerHeight - 140)));
    wrapper.style.top = `${topPx}px`;
    wrapper.style.bottom = '8px';
    wrapper.style.height = 'auto';
    if (typeof syncBatchBarBounds === 'function') syncBatchBarBounds();
}

function _syncScrollAfterLayoutToggle() {
    _ignoreScrollUntil = Date.now() + 350;
    _stickyScrollDownDist = 0;
    const scroller = document.getElementById('main-scroll-container');
    if (scroller) _stickyScrollLastTop = scroller.scrollTop || 0;
    syncTimelineWrapperBounds();
    requestAnimationFrame(() => {
        if (scroller) _stickyScrollLastTop = scroller.scrollTop || 0;
        _stickyScrollDownDist = 0;
        syncTimelineWrapperBounds();
    });
}

function _getActiveOptionsContext() {
    const albumsOverview = document.getElementById('albums-overview-panel');
    if (currentTab === 'albums' && albumsOverview && !albumsOverview.classList.contains('hidden')) {
        return { headerId: 'albums-sticky-header', drawerId: 'albums-options-drawer', btnId: 'alb-options-btn' };
    }
    if (currentTab === 'albums' && typeof openedAlbumName !== 'undefined' && openedAlbumName) {
        return { headerId: 'album-single-sticky-header', drawerId: 'filter-drawer', btnId: 'album-single-options-btn' };
    }
    if (currentTab === 'faces' && typeof currentTimelinePersonId !== 'undefined' && currentTimelinePersonId !== null) {
        return { headerId: 'person-single-sticky-header', drawerId: 'filter-drawer', btnId: 'person-single-options-btn' };
    }
    const personsOverview = document.getElementById('persons-overview-panel');
    if (currentTab === 'faces' && personsOverview && !personsOverview.classList.contains('hidden')) {
        return { headerId: 'faces-sticky-header', drawerId: 'faces-options-drawer', btnId: 'faces-options-btn' };
    }
    if (currentTab === 'gallery' || currentTab === 'favorites' || currentTab === 'recent') {
        return { headerId: 'gallery-sticky-header', drawerId: 'filter-drawer', btnId: 'gal-options-btn' };
    }
    return null;
}

function _syncTopbarOptionsButton() {
    const topBtn = document.getElementById('topbar-options-btn');
    if (!topBtn) return;
    const ctx = _getActiveOptionsContext();
    const header = ctx ? document.getElementById(ctx.headerId) : null;
    const show = !!(ctx && header && header.classList.contains('is-stuck'));
    topBtn.classList.toggle('hidden', !show);
    topBtn.classList.toggle('flex', show);
    if (show) {
        const drawer = document.getElementById(ctx.drawerId);
        const open = !!(drawer && !drawer.classList.contains('hidden'));
        topBtn.classList.toggle('nav-item-active', open);
        topBtn.classList.toggle('ui-card', !open);
    }
}

function toggleActiveOptionsBar() {
    const ctx = _getActiveOptionsContext();
    if (!ctx) return;
    if (ctx.drawerId === 'albums-options-drawer') toggleAlbumsOptionsBar();
    else if (ctx.drawerId === 'faces-options-drawer') toggleFacesOptionsBar();
    else toggleFilterBar();
}

function _setOptionsDrawerState(drawerId, btnId, visible) {
    const drawer = document.getElementById(drawerId);
    if (drawer) drawer.classList.toggle('hidden', !visible);
    const btn = document.getElementById(btnId);
    if (btn) {
        btn.classList.toggle('nav-item-active', visible);
        btn.classList.toggle('ui-card', !visible);
    }
    _syncTopbarOptionsButton();
    syncTimelineWrapperBounds();
    if (typeof updateFloatingGroupPill === 'function') updateFloatingGroupPill();
}

function _setHeaderStuckState(h, stuck, hidden) {
    if (!h) return;
    const isOpt = h.classList.contains('sticky-options-header');
    h.classList.toggle('is-stuck', !!stuck);
    h.classList.toggle('is-scroll-hidden', !isOpt && !!hidden);
    if (isOpt && h.parentElement) {
        h.parentElement.classList.toggle('has-stuck-header', !!stuck);
    }
}

function _openDrawerSafelyIfNearTop(headerId) {
    const scroller = document.getElementById('main-scroll-container');
    const header = document.getElementById(headerId);
    if (scroller && scroller.scrollTop > 0 && scroller.scrollTop <= 220) {
        scroller.scrollTop = 0;
        _setHeaderStuckState(header, false, false);
    }
}

function _mountFilterDrawerForActiveView(willShow) {
    const drawer = document.getElementById('filter-drawer');
    if (!drawer) return;
    let targetHeader = document.getElementById('gallery-sticky-header');
    if (willShow) {
        if (currentTab === 'albums' && typeof openedAlbumName !== 'undefined' && openedAlbumName) {
            targetHeader = document.getElementById('album-single-sticky-header') || targetHeader;
        } else if (currentTab === 'faces' && typeof currentTimelinePersonId !== 'undefined' && currentTimelinePersonId !== null) {
            targetHeader = document.getElementById('person-single-sticky-header') || targetHeader;
        }
    }
    if (targetHeader && drawer.parentElement !== targetHeader) {
        targetHeader.appendChild(drawer);
    }
}

function toggleFilterBar() {
    const drawer = document.getElementById('filter-drawer');
    if (!drawer) return;
    const willShow = drawer.classList.contains('hidden');
    _galOptionsManuallyClosed = !willShow;
    _mountFilterDrawerForActiveView(willShow);
    const activeCtx = _getActiveOptionsContext();
    _setOptionsDrawerState('filter-drawer', (activeCtx && activeCtx.btnId) || 'gal-options-btn', willShow);
    if (willShow) _openDrawerSafelyIfNearTop((activeCtx && activeCtx.headerId) || 'gallery-sticky-header');
    _syncScrollAfterLayoutToggle();
}

function toggleAlbumsOptionsBar() {
    const drawer = document.getElementById('albums-options-drawer');
    if (!drawer) return;
    const willShow = drawer.classList.contains('hidden');
    _albOptionsManuallyClosed = !willShow;
    _setOptionsDrawerState('albums-options-drawer', 'alb-options-btn', willShow);
    if (willShow) _openDrawerSafelyIfNearTop('albums-sticky-header');
    _syncScrollAfterLayoutToggle();
}

function toggleFacesOptionsBar() {
    const drawer = document.getElementById('faces-options-drawer');
    if (!drawer) return;
    const willShow = drawer.classList.contains('hidden');
    _facesOptionsManuallyClosed = !willShow;
    _setOptionsDrawerState('faces-options-drawer', 'faces-options-btn', willShow);
    if (willShow) _openDrawerSafelyIfNearTop('faces-sticky-header');
    _syncScrollAfterLayoutToggle();
}

function _syncSettingsPowerBar(scrollTop) {
    const bar = document.getElementById('settings-power-bar');
    const tabSettings = document.getElementById('tab-settings');
    if (!bar) return;
    const active = Boolean(tabSettings && !tabSettings.classList.contains('hidden') && scrollTop > 40);
    bar.classList.toggle('is-floating', active);
}

document.addEventListener('DOMContentLoaded', () => {
    const scroller = document.getElementById('main-scroll-container');
    if (!scroller) return;
    _stickyScrollLastTop = scroller.scrollTop || 0;
    _stickyScrollDownDist = 0;

    scroller.addEventListener('scroll', () => {
        const curTop = scroller.scrollTop || 0;
        const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const headers = document.querySelectorAll('.sticky-view-header');
        _syncSettingsPowerBar(curTop);

        if (maxScroll < 180 || curTop <= 64) {
            _stickyScrollDownDist = 0;
            headers.forEach(h => _setHeaderStuckState(h, false, false));
            _syncTopbarOptionsButton();
            _stickyScrollLastTop = curTop;
            syncTimelineWrapperBounds();
            return;
        }

        if (Date.now() < _ignoreScrollUntil) {
            _stickyScrollLastTop = curTop;
            _stickyScrollDownDist = 0;
            syncTimelineWrapperBounds();
            return;
        }
        const delta = curTop - _stickyScrollLastTop;

        if (delta < 0) {
            _stickyScrollDownDist = 0;
            headers.forEach(h => _setHeaderStuckState(h, true, false));
        } else if (delta > 0) {
            _stickyScrollDownDist += delta;
            const shouldHide = _stickyScrollDownDist > 12;
            headers.forEach(h => _setHeaderStuckState(h, true, shouldHide));
            if (curTop > 140 && _stickyScrollDownDist > 24) {
                _setOptionsDrawerState('filter-drawer', 'gal-options-btn', false);
                _setOptionsDrawerState('albums-options-drawer', 'alb-options-btn', false);
                _setOptionsDrawerState('faces-options-drawer', 'faces-options-btn', false);
            }
        }
        _syncTopbarOptionsButton();
        _stickyScrollLastTop = curTop;
        syncTimelineWrapperBounds();
    }, { passive: true });
    window.addEventListener('resize', () => {
        syncTimelineWrapperBounds();
        if (typeof updateFloatingGroupPill === 'function') updateFloatingGroupPill();
    }, { passive: true });
    syncTimelineWrapperBounds();
});

function hideAllTopPopovers() {
    ['lib-menu-popover', 'library-dropdown-menu', 'task-popover', 'notif-popover'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
}

function toggleLibMenuPopover(e) {
    if (e) e.stopPropagation();
    const taskPop = document.getElementById('task-popover');
    const notifPop = document.getElementById('notif-popover');
    if (taskPop) taskPop.classList.add('hidden');
    if (notifPop) notifPop.classList.add('hidden');
    const libPop = document.getElementById('lib-menu-popover') || document.getElementById('library-dropdown-menu');
    if (libPop) libPop.classList.toggle('hidden');
}

function toggleTaskPopover(e) {
    if (e) e.stopPropagation();
    const libPop = document.getElementById('lib-menu-popover') || document.getElementById('library-dropdown-menu');
    const notifPop = document.getElementById('notif-popover');
    if (libPop) libPop.classList.add('hidden');
    if (notifPop) notifPop.classList.add('hidden');
    const taskPop = document.getElementById('task-popover');
    if (taskPop) taskPop.classList.toggle('hidden');
}

window.addEventListener('click', e => {
    const libPop = document.getElementById('lib-menu-popover');
    const taskPop = document.getElementById('task-popover');
    const notifPop = document.getElementById('notif-popover');
    if (libPop && !libPop.contains(e.target)) libPop.classList.add('hidden');
    if (taskPop && !taskPop.contains(e.target)) taskPop.classList.add('hidden');
    if (notifPop && !notifPop.contains(e.target)) notifPop.classList.add('hidden');
});

// ==================== NAVIGATION PRINCIPALE ====================

const ALL_TABS = ['gallery', 'recent', 'albums', 'favorites', 'faces', 'map', 'types', 'tools', 'dups', 'similar', 'trash', 'activities', 'settings', 'search'];
let _wasRecentTab = false;

function switchTab(tab) {
    currentTab = tab;
    ALL_TABS.forEach(t => {
        const btn = document.getElementById(`tab-btn-${t}`);
        if (btn) btn.classList.toggle('nav-item-active', t === tab || (tab === 'recent' && t === 'activities'));
        const panel = document.getElementById(`tab-${t}`);
        if (panel) panel.classList.toggle('hidden', t !== tab);
    });

    const tlWrap = document.getElementById('gallery-timeline-wrapper');
    const tlBox = document.getElementById('gallery-timeline-box') || document.getElementById('timeline-scrubber');
    const hideTl = (tab !== 'gallery' && tab !== 'favorites' && tab !== 'recent');
    if (tlWrap) tlWrap.classList.toggle('!hidden', hideTl);
    if (tlBox) tlBox.classList.toggle('hidden', hideTl);
    const favGroupsBar = document.getElementById('favorites-groups-bar');
    if (favGroupsBar) favGroupsBar.classList.toggle('hidden', tab !== 'favorites');

    const titleEl = document.getElementById('gallery-main-title') || document.getElementById('gallery-main-heading');
    const sortByEl = document.getElementById('gal-sort-by');
    const sortOrdEl = document.getElementById('gal-sort-order');

    if (tab === 'favorites') {
        _wasRecentTab = false;
        document.getElementById('tab-gallery').classList.remove('hidden');
        if (titleEl) titleEl.textContent = 'Favoris';
        document.getElementById('gal-fav').checked = true;
        currentExtFilter = '';
        if (typeof applyPageDefaultOptions === 'function') applyPageDefaultOptions('favorites', false);
        if (typeof loadCustomGroups === 'function') loadCustomGroups('favorites');
        resetAndLoadGallery();
    } else if (tab === 'recent') {
        _wasRecentTab = true;
        document.getElementById('tab-gallery').classList.remove('hidden');
        if (titleEl) titleEl.textContent = 'Ajoutés récemment';
        document.getElementById('gal-fav').checked = false;
        if (sortByEl) sortByEl.value = 'added';
        if (sortOrdEl) sortOrdEl.value = 'desc';
        const arrow = document.getElementById('gal-sort-arrow');
        if (arrow) arrow.style.transform = 'rotate(0deg)';
        currentExtFilter = '';
        if (typeof applyPageDefaultOptions === 'function') applyPageDefaultOptions('recent', false);
        resetAndLoadGallery();
    } else if (tab === 'gallery') {
        if (titleEl) titleEl.textContent = 'Galerie';
        document.getElementById('gal-fav').checked = false;
        if (_wasRecentTab && sortByEl && sortByEl.value === 'added') {
            sortByEl.value = 'date';
        }
        _wasRecentTab = false;
        currentExtFilter = '';
        if (typeof applyPageDefaultOptions === 'function') applyPageDefaultOptions('gallery', false);
        resetAndLoadGallery();
    } else if (tab === 'albums') {
        _mountFilterDrawerForActiveView(false);
        if (typeof applyPageDefaultOptions === 'function') applyPageDefaultOptions('albums', false);
        closeSingleAlbumView();
    } else if (tab === 'faces') {
        _mountFilterDrawerForActiveView(false);
        if (typeof applyPageDefaultOptions === 'function') applyPageDefaultOptions('persons', false);
        if (typeof closeTimeline === 'function' && typeof currentTimelinePersonId !== 'undefined' && currentTimelinePersonId !== null) {
            closeTimeline();
        } else {
            loadPersons();
        }
    } else if (tab === 'map') {
        loadWorldMap(false);
    } else if (tab === 'types') {
        loadTypesSummary();
    } else if (tab === 'dups') {
        loadDuplicates();
    } else if (tab === 'similar') {
        loadSimilarGroups();
    } else if (tab === 'trash') {
        loadTrashTab();
    } else if (tab === 'activities') {
        loadActivitiesHistory();
        fetch('/api/activities/check_sources', {method: 'POST'}).catch(() => {});
    } else if (tab === 'settings') {
        loadAppSettings();
    }
    _syncTopbarOptionsButton();
    syncTimelineWrapperBounds();
    if (typeof updateFloatingGroupPill === 'function') updateFloatingGroupPill();
    if (typeof updateGalleryBatchBar === 'function') updateGalleryBatchBar();
}

function setGalleryViewMode(mode) {
    galleryViewMode = mode;
    ['GRID', 'MONTH', 'DAY', 'MASONRY'].forEach(m => {
        const b = document.getElementById(`view-btn-${m}`);
        if (b) {
            b.className = (m === mode)
                ? "px-2.5 py-1 rounded-lg plum-btn"
                : "px-2.5 py-1 rounded-lg";
        }
    });
    refreshActiveMediaView();
}

function refreshActiveMediaView() {
    if (currentTab === 'albums' && openedAlbumName) {
        singleAlbumPage = 1;
        loadSingleAlbumItems();
    } else if (currentTab === 'faces' && typeof currentTimelinePersonId !== 'undefined' && currentTimelinePersonId !== null) {
        openTimeline(currentTimelinePersonId);
    } else {
        resetAndLoadGallery();
    }
}

async function runGlobalSearch() {
    const q = document.getElementById('global-search-input').value.trim();
    if (!q) return;
    switchTab('search');
    const qLbl = document.getElementById('search-query-label');
    if (qLbl) qLbl.textContent = `« ${q} »`;
    const cntLbl = document.getElementById('search-results-count');
    if (cntLbl) cntLbl.textContent = 'Recherche en cours...';
    const res = await fetch(`/api/semantic/search?q=${encodeURIComponent(q)}`);
    const d = await res.json();
    const results = d.results || [];
    if (cntLbl) cntLbl.textContent = `${results.length} résultat${results.length > 1 ? 's' : ''}`;
    document.getElementById('semantic-results-grid').innerHTML = results.length
        ? results.map(r => {
            const sEnc = encodeURIComponent(r.source_path || r.dest_path);
            const dEnc = encodeURIComponent(r.dest_path);
            const badgeText = r.match_label ? r.match_label : `${r.similarity}%`;
            return `
            <div onclick="openLightboxForCustomItem('${sEnc}', '${dEnc}', ${r.timestamp || 0})" class="ui-card rounded-2xl p-2 cursor-pointer">
                ${renderMediaPreview(r.dest_path, "w-full aspect-square object-cover rounded-xl mb-1")}
                <div class="flex justify-between text-[11px] font-bold px-1"><span>${formatDate(r.timestamp)}</span><span>${badgeText}</span></div>
            </div>`;
        }).join('')
        : `<div class="col-span-full text-center text-xs font-semibold opacity-60 py-6">Aucun média trouvé pour « ${q} ».</div>`;
}

// ==================== CONTRÔLES DU PIPELINE IA (LANCER, PAUSE, REPRISE, STOP, LOGS) ====================

let _pendingPreflightTask = '';

function cancelPendingPreflightTask() {
    _pendingPreflightTask = '';
    const box = document.getElementById('task-preflight-warning');
    if (box) box.classList.add('hidden');
}

async function confirmPendingPreflightTask() {
    const task = _pendingPreflightTask || 'INGEST';
    cancelPendingPreflightTask();
    await runTask(task, true);
}

async function runTask(taskCode, skipPreflight = false) {
    if (taskCode === 'INGEST' && !skipPreflight) {
        try {
            const pfRes = await fetch('/api/import/preflight_active');
            if (pfRes.ok) {
                const pf = await pfRes.json();
                if (pf && pf.enough === false && Array.isArray(pf.warnings) && pf.warnings.length) {
                    _pendingPreflightTask = taskCode;
                    const warnBox = document.getElementById('task-preflight-warning');
                    const warnTxt = document.getElementById('task-preflight-warning-text');
                    if (warnTxt) warnTxt.textContent = pf.warnings.join(' ');
                    if (warnBox) warnBox.classList.remove('hidden');
                    const pop = document.getElementById('task-popover');
                    if (pop) pop.classList.remove('hidden');
                    return;
                }
            }
        } catch (e) {}
    }

    cancelPendingPreflightTask();
    clientPausedTask = '';
    const res = await fetch('/api/pipeline/run_task', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({task: taskCode})
    });
    if (!res.ok) {
        try {
            const err = await res.json();
            alert(err.detail || "Impossible de démarrer la tâche.");
        } catch (e) {}
    }
}

async function discardPausedActivity(activityId, e) {
    if (e) e.stopPropagation();
    clientPausedTask = '';
    try {
        const res = await fetch(`/api/activities/${encodeURIComponent(activityId)}/cancel_pause`, {method: 'POST'});
        if (res.ok) {
            const d = await res.json();
            renderActivitiesHistory(d.activities || []);
        }
    } catch (_) {}
}

async function handlePipeActionButton() {
    if (latestPipelineState && latestPipelineState.is_running) {
        clientPausedTask = latestPipelineState.active_task || lastSeenActiveTask || 'INGEST';
        await fetch('/api/pipeline/stop?cancel=false', {method: 'POST'});
    } else {
        const pausedFromDb = _findActivePausedActivityFromHistory(_latestActivitiesCache);
        if (_resolvePipelineVisualState(latestPipelineState) === 'idle' && pausedFromDb) {
            await resumeOrRetryActivity(pausedFromDb.activity_id);
            return;
        }
        const resumeCode = (latestPipelineState && latestPipelineState.last_paused_task) || clientPausedTask || lastSeenActiveTask || 'INGEST';
        await runTask(resumeCode);
    }
}

const togglePauseResumeTask = handlePipeActionButton;

async function stopPipelineCompletely() {
    clientPausedTask = '';
    const pausedFromDb = _findActivePausedActivityFromHistory(_latestActivitiesCache);
    await fetch('/api/pipeline/stop?cancel=true', {method: 'POST'});
    if (pausedFromDb) {
        await discardPausedActivity(pausedFromDb.activity_id);
    }
}

const stopTaskCompletely = stopPipelineCompletely;

function toggleTaskMissingMetaSubpanel(e) {
    if (e) e.stopPropagation();
    const sub = document.getElementById('task-missing-meta-popover');
    if (sub) sub.classList.toggle('hidden');
}

async function retryMissingMetadataFromPopover() {
    const btn = document.getElementById('btn-popover-retry-meta');
    if (btn) {
        btn.disabled = true;
        btn.textContent = "Récupération...";
    }
    try {
        await fetch('/api/metadata/retry_recovery', {method: 'POST'});
        await loadStats();
        await loadGalleryFilters();
        refreshActiveMediaView();
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = "Réessayer";
        }
    }
}

// ==================== STATISTIQUES & COUVERTURE ====================

async function loadStats() {
    const res = await fetch('/api/stats');
    if (!res.ok) return;
    const d = await res.json();
    const stInd = document.getElementById('st-indexed');
    if (stInd) stInd.textContent = d.indexed || 0;
    const gbEl = document.getElementById('st-gb');
    if (gbEl && d.total_gb !== undefined) gbEl.textContent = String(d.total_gb).replace('.', ',');

    const stDups = document.getElementById('st-dups');
    if (stDups) stDups.textContent = d.duplicates || 0;
    const dupsBan = document.getElementById('dups-count-banner');
    if (dupsBan) dupsBan.textContent = d.duplicates || 0;

    const simCount = d.similar_count !== undefined ? d.similar_count : 0;
    const stSims = document.getElementById('st-sims');
    if (stSims) stSims.textContent = simCount;
    const simsBan = document.getElementById('sims-count-banner');
    if (simsBan) simsBan.textContent = simCount;

    const mm = document.getElementById('st-missing-meta');
    if (mm && d.missing_meta !== undefined) mm.textContent = d.missing_meta;

    if (d.coverage) {
        const ded = d.coverage.dedup;
        if (ded && document.getElementById('cov-bar-dedup')) {
            document.getElementById('cov-bar-dedup').style.width = `${ded.percent}%`;
            document.getElementById('cov-pct-dedup').textContent = `${ded.percent} %`;
            document.getElementById('cov-label-dedup').innerHTML = `${ded.done} / ${ded.total}<br><span class="font-semibold opacity-75">fichiers analysés</span>`;
        }
        const sim = d.coverage.similar;
        if (sim && document.getElementById('cov-bar-similar')) {
            document.getElementById('cov-bar-similar').style.width = `${sim.percent}%`;
            document.getElementById('cov-pct-similar').textContent = `${sim.percent} %`;
            document.getElementById('cov-label-similar').innerHTML = `${sim.done} / ${sim.total}<br><span class="font-semibold opacity-75">fichiers analysés</span>`;
        }
    }
}

async function toggleNotificationsPopover(e) {
    if (e) e.stopPropagation();
    const libPop = document.getElementById('lib-menu-popover');
    const taskPop = document.getElementById('task-popover');
    if (libPop) libPop.classList.add('hidden');
    if (taskPop) taskPop.classList.add('hidden');
    const pop = document.getElementById('notif-popover');
    if (!pop) return;
    pop.classList.toggle('hidden');
    if (!pop.classList.contains('hidden')) {
        await fetch('/api/notifications/clear', {method: 'POST'});
        const dot = document.getElementById('notif-unread-dot');
        if (dot) dot.classList.add('hidden');
    }
}

let _lastNotifTopId = null;

function _statusBadgeSvg(status) {
    if (status === 'success') {
        return '<span class="w-5 h-5 rounded-full bg-emerald-500/15 text-emerald-500 flex items-center justify-center shrink-0 mt-0.5"><svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.6" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></span>';
    }
    if (status === 'error') {
        return '<span class="w-5 h-5 rounded-full bg-rose-500/15 text-rose-500 flex items-center justify-center shrink-0 mt-0.5"><svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.6" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>';
    }
    if (status === 'partial') {
        return '<span class="w-5 h-5 rounded-full bg-amber-500/15 text-amber-500 flex items-center justify-center shrink-0 mt-0.5"><svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.4" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></span>';
    }
    return '<span class="w-5 h-5 rounded-full bg-amber-500/15 text-amber-500 flex items-center justify-center shrink-0 mt-0.5"><svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.6" viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg></span>';
}

function _formatActivityDateTime(isoStr) {
    if (!isoStr) return '--';
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return String(isoStr);
    return d.toLocaleDateString('fr-FR') + ' à ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function _formatActivityDuration(sec) {
    const val = Math.max(0, Number(sec) || 0);
    if (val < 60) return `${val.toFixed(1).replace('.', ',')} s`;
    const total = Math.round(val);
    if (total < 3600) {
        const m = Math.floor(total / 60);
        const s = String(total % 60).padStart(2, '0');
        return `${m} min ${s} s`;
    }
    const h = Math.floor(total / 3600);
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    return `${h} h ${m} min`;
}

async function deleteNotification(notifId, e) {
    if (e) e.stopPropagation();
    try {
        const res = await fetch(`/api/notifications/${encodeURIComponent(notifId)}`, {method: 'DELETE'});
        if (res.ok) {
            const d = await res.json();
            renderNotificationsLists(d.notifications || []);
        }
    } catch (_) {}
}

async function clearAllNotifications(e) {
    if (e) e.stopPropagation();
    try {
        const res = await fetch('/api/notifications', {method: 'DELETE'});
        if (res.ok) {
            renderNotificationsLists([]);
        }
    } catch (_) {}
}

async function resumeActivityFromNotif(activityId, notifId, e) {
    if (e) e.stopPropagation();
    const pop = document.getElementById('notif-popover');
    if (pop) pop.classList.add('hidden');
    if (notifId) {
        await deleteNotification(notifId);
    }
    await resumeOrRetryActivity(activityId, e);
}

async function runTaskFromNotif(taskCode, notifId, e) {
    if (e) e.stopPropagation();
    const pop = document.getElementById('notif-popover');
    if (pop) pop.classList.add('hidden');
    if (notifId) {
        await deleteNotification(notifId);
    }
    await runTask(taskCode);
}

function renderNotificationsLists(notifs) {
    const list = Array.isArray(notifs) ? notifs : [];
    const unread = list.some(n => !n.read);
    const dot = document.getElementById('notif-unread-dot');
    if (dot) dot.classList.toggle('hidden', !unread);

    const btnClearAll = document.getElementById('btn-clear-all-notifs');
    if (btnClearAll) btnClearAll.classList.toggle('hidden', list.length === 0);

    const topId = list.length ? list[0].id : null;
    if (topId !== null && topId !== _lastNotifTopId) {
        _lastNotifTopId = topId;
        if (currentTab === 'activities') loadActivitiesHistory();
    }

    const popList = document.getElementById('notif-popover-list');
    if (!popList) return;
    if (!list.length) {
        popList.innerHTML = '<div class="py-4 text-center opacity-60 font-semibold">Aucune activité récente</div>';
        return;
    }

    popList.innerHTML = list.map(n => {
        const badgeSvg = _statusBadgeSvg(n.status);
        const nid = Number(n.id) || 0;
        const aid = Number(n.action_activity_id) || 0;
        const taskCode = n.action_task ? String(n.action_task) : '';
        let actionBtn = '';
        if (aid > 0) {
            actionBtn = `<div class="mt-1.5">
                   <button type="button" onclick="resumeActivityFromNotif(${aid}, ${nid}, event)"
                           class="ui-card hover:bg-[var(--bg-hover)] hover:text-emerald-500 px-3 py-1 rounded-full text-[11px] font-bold inline-flex items-center gap-1.5 transition cursor-pointer">
                       <svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                       <span>${escapeHtml(n.action_label || 'Reprendre')}</span>
                   </button>
               </div>`;
        } else if (taskCode) {
            actionBtn = `<div class="mt-1.5">
                   <button type="button" onclick="runTaskFromNotif('${escapeHtml(taskCode)}', ${nid}, event)"
                           class="ui-card hover:bg-[var(--bg-hover)] hover:text-sky-500 px-3 py-1 rounded-full text-[11px] font-bold inline-flex items-center gap-1.5 transition cursor-pointer">
                       <svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                       <span>${escapeHtml(n.action_label || 'Analyser')}</span>
                   </button>
               </div>`;
        }
        return `
        <div class="ui-pill rounded-2xl p-2.5 flex items-start justify-between gap-2">
            <div class="flex items-start gap-2.5 min-w-0 flex-1">
                ${badgeSvg}
                <div class="min-w-0">
                    <div class="font-extrabold text-xs truncate">${escapeHtml(n.title)}</div>
                    <div class="text-[11px] opacity-70 mt-0.5 break-words">${escapeHtml(n.detail)}</div>
                    ${actionBtn}
                </div>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
                <span class="text-[10px] font-mono opacity-60">${escapeHtml(n.time)}</span>
                <button type="button" onclick="deleteNotification(${nid}, event)" title="Effacer la notification"
                        class="w-5 h-5 rounded-full hover:bg-[var(--bg-hover)] hover:text-rose-500 flex items-center justify-center text-[11px] font-extrabold opacity-55 hover:opacity-100 transition cursor-pointer">✕</button>
            </div>
        </div>`;
    }).join('');
}

async function loadActivitiesHistory() {
    try {
        const res = await fetch('/api/activities');
        if (!res.ok) return;
        const d = await res.json();
        renderActivitiesHistory(d.activities || []);
    } catch (_) {}
}

function _toggleActivityListBox(prefix, activityId, closedPrefix) {
    const box = document.getElementById(`act-${prefix}-list-${activityId}`);
    const lbl = document.getElementById(`act-${prefix}-lbl-${activityId}`);
    if (!box) return;
    const willOpen = box.classList.contains('hidden');
    box.classList.toggle('hidden', !willOpen);
    if (lbl && lbl.dataset.count) {
        lbl.textContent = willOpen
            ? `Masquer la liste (${lbl.dataset.count})`
            : `${closedPrefix} (${lbl.dataset.count})`;
    }
}

function toggleActivityFailedFiles(activityId) {
    _toggleActivityListBox('failed', activityId, 'Voir les fichiers non traités');
}

function toggleActivityFiles(activityId) {
    _toggleActivityListBox('files', activityId, 'Voir les fichiers');
}

async function deleteActivityEntry(activityId, e) {
    if (e) e.stopPropagation();
    try {
        const res = await fetch(`/api/activities/${encodeURIComponent(activityId)}`, {method: 'DELETE'});
        if (res.ok) {
            const d = await res.json();
            renderActivitiesHistory(d.activities || []);
        }
    } catch (_) {}
}

function openClearActivitiesConfirm() {
    const m = document.getElementById('activities-confirm-clear-modal');
    if (m) m.classList.remove('hidden');
}

function closeClearActivitiesConfirm() {
    const m = document.getElementById('activities-confirm-clear-modal');
    if (m) m.classList.add('hidden');
}

async function confirmClearAllActivities() {
    closeClearActivitiesConfirm();
    try {
        const res = await fetch('/api/activities', {method: 'DELETE'});
        if (res.ok) renderActivitiesHistory([]);
    } catch (_) {}
}

async function exportActivitiesHistory() {
    try {
        const res = await fetch('/api/activities/export');
        if (!res.ok) return;
        const blob = await res.blob();
        const disp = res.headers.get('Content-Disposition') || '';
        const m = disp.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
        const fileName = m ? decodeURIComponent(m[1]) : 'phototo_activites.json';
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (_) {}
}

async function resumeOrRetryActivity(activityId, e) {
    if (e) e.stopPropagation();
    clientPausedTask = '';
    try {
        const res = await fetch(`/api/activities/${encodeURIComponent(activityId)}/resume`, {method: 'POST'});
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            alert(err.detail || "Impossible de relancer cette opération.");
            return;
        }
        const taskPop = document.getElementById('task-popover');
        if (taskPop) taskPop.classList.remove('hidden');
    } catch (_) {}
}

const ACTIVITY_GROUP_OPS = new Set(['INGEST', 'UNZIP', 'IMPORT', 'METADATA']);
const ACTIVITY_GROUP_AI = new Set(['FACES', 'OCR', 'DEDUP', 'SIMILAR', 'CLIP', 'AI_REINDEX']);
const RESUMABLE_ACTIVITY_TYPES = new Set(['INGEST', 'UNZIP', 'IMPORT', 'METADATA', 'FACES', 'OCR', 'DEDUP', 'SIMILAR', 'CLIP']);

const _expandedActivityGroups = new Set();

function toggleActivityGroup(leadId, e) {
    if (e) e.stopPropagation();
    const key = Number(leadId) || 0;
    if (_expandedActivityGroups.has(key)) {
        _expandedActivityGroups.delete(key);
    } else {
        _expandedActivityGroups.add(key);
    }
    renderActivitiesHistory(_latestActivitiesCache);
}

function _groupConsecutiveActivities(items) {
    const groups = [];
    for (const a of items) {
        const actType = String(a.action_type || '').toUpperCase();
        const key = `${actType}||${String(a.title || '')}||${String(a.library_name || '')}`;
        const last = groups.length ? groups[groups.length - 1] : null;
        const isResumable = RESUMABLE_ACTIVITY_TYPES.has(actType);
        const olderEndedRun = isResumable && (
            a.status === 'success' || String(a.reason || '').toLowerCase().includes('arrêtée')
        );
        if (last && last.key === key && !olderEndedRun) {
            last.items.push(a);
        } else {
            groups.push({ key, items: [a] });
        }
    }
    return groups;
}

function _buildSingleActivityCardHtml(a, opts = {}) {
    const statusMeta = {
        success: { label: 'Succès', cls: 'text-emerald-500' },
        partial: { label: 'Partiel', cls: 'text-amber-500' },
        error: { label: 'Échec', cls: 'text-rose-500' },
        paused: { label: 'Interrompu', cls: 'text-amber-500' },
    };
    const olderItems = Array.isArray(opts.olderItems) ? opts.olderItems : [];
    const isNested = Boolean(opts.isNested);
    const aid = Number(a.activity_id) || 0;
    const stInfo = statusMeta[a.status] || statusMeta.paused;
    const badgeSvg = _statusBadgeSvg(a.status);
    const dtTxt = _formatActivityDateTime(a.finished_at || a.started_at);
    const durVal = Number(a.duration_sec) || 0;
    const durTxt = _formatActivityDuration(durVal);
    const cumDurVal = olderItems.length
        ? durVal + olderItems.reduce((acc, x) => acc + (Number(x.duration_sec) || 0), 0)
        : durVal;
    const cumDurHtml = olderItems.length && cumDurVal > durVal
        ? `<span class="mx-1.5">•</span><span>Cumulée (${olderItems.length + 1}×) : ${escapeHtml(_formatActivityDuration(cumDurVal))}</span>`
        : '';

    const failedFiles = Array.isArray(a.failed_files) ? a.failed_files : [];
    const failedTotal = Math.max(Number(a.failed_count) || 0, failedFiles.length);
    const okFiles = Array.isArray(a.files) ? a.files : [];
    const actType = String(a.action_type || '').toUpperCase();
    const canResume = RESUMABLE_ACTIVITY_TYPES.has(actType) && (a.status === 'paused' || a.status === 'error' || a.status === 'partial');
    const resumeLbl = a.status === 'paused' ? 'Reprendre' : 'Réessayer';
    const resumeHoverCls = a.status === 'paused' ? 'hover:text-emerald-500' : 'hover:text-amber-500';
    const resumeBtnHtml = canResume
        ? `<button type="button" onclick="resumeOrRetryActivity(${aid}, event)"
                   class="mt-2 ui-card hover:bg-[var(--bg-hover)] ${resumeHoverCls} px-3 py-1 rounded-full text-[11px] font-bold inline-flex items-center gap-1.5 transition cursor-pointer">
               <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
               <span>${resumeLbl}</span>
           </button>`
        : '';

    const isGrpExpanded = olderItems.length > 0 && _expandedActivityGroups.has(aid);
    const grpBtnHtml = olderItems.length > 0
        ? `<button type="button" id="act-grp-btn-${aid}" onclick="toggleActivityGroup(${aid}, event)"
                   class="mt-2 ui-card hover:bg-[var(--bg-hover)] px-3 py-1 rounded-full text-[11px] font-bold inline-flex items-center gap-1.5 transition cursor-pointer">
               <span>${olderItems.length} autre${olderItems.length > 1 ? 's' : ''} identique${olderItems.length > 1 ? 's' : ''}</span>
               <svg class="w-3.5 h-3.5 shrink-0 transition-transform duration-150" style="transform:${isGrpExpanded ? 'rotate(180deg)' : 'rotate(0deg)'}" fill="none" stroke="currentColor" stroke-width="2.4" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
           </button>`
        : '';

    const reasonHtml = a.reason
        ? `<div class="text-[11px] font-semibold text-rose-500/90 mt-1">Raison : ${escapeHtml(a.reason)}</div>`
        : '';
    const okFilesBtnHtml = okFiles.length > 0
        ? `<button type="button" onclick="toggleActivityFiles(${aid})"
                   class="mt-2 ui-card hover:bg-[var(--bg-hover)] hover:text-sky-500 px-3 py-1 rounded-full text-[11px] font-bold inline-flex items-center gap-1.5 transition cursor-pointer">
               <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
               <span id="act-files-lbl-${aid}" data-count="${okFiles.length}">Voir les fichiers (${okFiles.length})</span>
           </button>`
        : '';
    const failedBtnHtml = failedFiles.length > 0
        ? `<button type="button" onclick="toggleActivityFailedFiles(${aid})"
                   class="mt-2 ui-card hover:bg-[var(--bg-hover)] hover:text-amber-500 px-3 py-1 rounded-full text-[11px] font-bold inline-flex items-center gap-1.5 transition cursor-pointer">
               <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
               <span id="act-failed-lbl-${aid}" data-count="${failedTotal}">Voir les fichiers non traités (${failedTotal})</span>
           </button>`
        : '';
    const actionButtonsRow = (resumeBtnHtml || grpBtnHtml || okFilesBtnHtml || failedBtnHtml)
        ? `<div class="flex flex-wrap items-center gap-2">${resumeBtnHtml}${grpBtnHtml}${okFilesBtnHtml}${failedBtnHtml}</div>`
        : '';
    const okFilesBoxHtml = okFiles.length > 0
        ? `<div id="act-files-list-${aid}" class="hidden mt-2.5 ui-card rounded-2xl p-3 space-y-1.5 max-h-56 overflow-y-auto">
               ${okFiles.map(f => `
                   <div class="text-[11px] border-b border-[var(--border-subtle)] last:border-b-0 pb-1.5 last:pb-0">
                       <div class="font-bold truncate" title="${escapeHtml(f.path || f.name || '')}">${escapeHtml(f.name || f.path || 'Fichier')}</div>
                       ${f.path ? `<div class="text-[10px] font-mono opacity-55 truncate" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</div>` : ''}
                       ${f.info ? `<div class="text-[10px] opacity-75 font-semibold">${escapeHtml(f.info)}</div>` : ''}
                   </div>
               `).join('')}
           </div>`
        : '';
    const failedBoxHtml = failedFiles.length > 0
        ? `<div id="act-failed-list-${aid}" class="hidden mt-2.5 ui-card rounded-2xl p-3 space-y-1.5 max-h-56 overflow-y-auto">
               ${failedFiles.map(f => `
                   <div class="text-[11px] border-b border-[var(--border-subtle)] last:border-b-0 pb-1.5 last:pb-0">
                       <div class="font-bold truncate" title="${escapeHtml(f.path || f.name || '')}">${escapeHtml(f.name || f.path || 'Fichier')}</div>
                       <div class="text-[10px] font-mono opacity-55 truncate" title="${escapeHtml(f.path || '')}">${escapeHtml(f.path || '')}</div>
                       <div class="text-[10px] text-rose-500 font-semibold">${escapeHtml(f.reason || 'Erreur inconnue')}</div>
                   </div>
               `).join('')}
           </div>`
        : '';
    const nestedChildrenHtml = (olderItems.length > 0 && isGrpExpanded)
        ? `<div id="act-grp-body-${aid}" class="mt-2.5 pl-3 ml-2 border-l-2 border-[var(--border-subtle)] space-y-2">
               ${olderItems.map(child => _buildSingleActivityCardHtml(child, { isNested: true })).join('')}
           </div>`
        : '';

    const cardCls = isNested ? 'ui-card rounded-2xl p-3 space-y-1' : 'ui-pill rounded-2xl p-3.5 space-y-1';
    return `
    <div class="${cardCls}">
        <div class="flex items-start justify-between gap-3">
            <div class="flex items-start gap-2.5 min-w-0 flex-1">
                ${badgeSvg}
                <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-2">
                        <span class="font-extrabold text-xs">${escapeHtml(a.title)}</span>
                        <span class="ui-card px-2 py-0.5 rounded-full text-[10px] font-extrabold ${stInfo.cls}">${stInfo.label}</span>
                        ${olderItems.length > 0 ? `<span class="ui-card px-2 py-0.5 rounded-full text-[10px] font-extrabold opacity-75">${olderItems.length + 1}×</span>` : ''}
                        ${a.library_name ? `<span class="text-[10px] font-bold opacity-55">· ${escapeHtml(a.library_name)}</span>` : ''}
                    </div>
                    <div class="text-[11px] opacity-75 mt-0.5">${escapeHtml(a.detail)}</div>
                    <div class="text-[10px] opacity-60 font-semibold mt-1">
                        <span>${escapeHtml(dtTxt)}</span>
                        <span class="mx-1.5">•</span>
                        <span>Durée : ${escapeHtml(durTxt)}</span>
                        ${cumDurHtml}
                    </div>
                    ${reasonHtml}
                    ${actionButtonsRow}
                </div>
            </div>
            <button type="button" onclick="deleteActivityEntry(${aid}, event)" title="Supprimer cette activité"
                    class="w-6 h-6 rounded-full hover:bg-[var(--bg-hover)] hover:text-rose-500 flex items-center justify-center text-xs font-extrabold opacity-55 hover:opacity-100 transition cursor-pointer shrink-0">✕</button>
        </div>
        ${okFilesBoxHtml}
        ${failedBoxHtml}
        ${nestedChildrenHtml}
    </div>`;
}

function _renderActivityGroupsHtml(groups) {
    return groups.map(grp => _buildSingleActivityCardHtml(grp.items[0], { olderItems: grp.items.slice(1) })).join('');
}

let _latestActivitiesCache = [];
const _expandedActivitySections = new Set();

function _resolvePipelineVisualState(st) {
    if (!st) return 'idle';
    const effectivePausedTask = st.last_paused_task || clientPausedTask;
    if (st.is_running) return 'running';
    if (st.status_level === 'error' || (st.current_step && st.current_step.startsWith('Erreur'))) return 'error';
    if (st.status_level === 'stopped' || (st.current_step && st.current_step.startsWith('Tâche arrêtée'))) return 'stopped';
    if (st.status_level === 'paused' || Boolean(effectivePausedTask) || (st.current_step && st.current_step.includes('En pause'))) return 'paused';
    return 'idle';
}

function _statusDotClassesForState(visualState) {
    if (visualState === 'running') return 'bg-emerald-400 animate-pulse';
    if (visualState === 'paused') return 'bg-amber-400';
    if (visualState === 'error' || visualState === 'stopped') return 'bg-rose-500';
    return 'bg-emerald-400';
}

function _findActivePausedActivityFromHistory(activities) {
    const list = Array.isArray(activities) ? activities : [];
    const seenEnded = new Set();
    for (const a of list) {
        const actType = String(a.action_type || '').toUpperCase();
        if (!RESUMABLE_ACTIVITY_TYPES.has(actType)) continue;
        const sig = `${actType}||${String(a.title || '')}||${String(a.library_name || '')}`;
        if (seenEnded.has(sig)) continue;
        const reasonLower = String(a.reason || '').toLowerCase();
        const isPausedOnly = (a.status === 'paused') && !reasonLower.includes('arrêtée');
        if (isPausedOnly) {
            return a;
        }
        seenEnded.add(sig);
    }
    return null;
}

function renderCurrentOrPendingActivity(st, activities) {
    const sec = document.getElementById('activities-current-section');
    const cardEl = document.getElementById('activities-current-card');
    if (!sec || !cardEl) return;

    sec.classList.remove('hidden');
    const visualState = _resolvePipelineVisualState(st);
    if (visualState !== 'idle' && st) {
        const dotCls = _statusDotClassesForState(visualState);
        const stateMeta = {
            running: { badge: 'En cours', badgeCls: 'text-emerald-500', barCls: 'bg-emerald-500' },
            paused: { badge: 'En pause', badgeCls: 'text-amber-500', barCls: 'bg-amber-400' },
            error: { badge: 'Erreur', badgeCls: 'text-rose-500', barCls: 'bg-rose-500' },
            stopped: { badge: 'Arrêtée', badgeCls: 'text-rose-500', barCls: 'bg-rose-500' },
        }[visualState] || { badge: 'En cours', badgeCls: 'text-emerald-500', barCls: 'bg-emerald-500' };

        const pct = Math.max(0, Math.min(100, Number(st.percent) || 0));
        const etaClean = (st.eta_text || '').replace('ETA: ', '') || '--:--';
        const spdClean = st.speed_text || '-- Mo/s';
        const proc = Number(st.processed_items) || 0;
        const tot = Number(st.total_items) || 0;

        let actionBtnHtml = '';
        if (st.is_running) {
            actionBtnHtml = `
                <button type="button" onclick="handlePipeActionButton()" class="ui-pill hover:bg-[var(--bg-hover)] hover:text-amber-500 px-3.5 py-1.5 rounded-full text-xs font-bold inline-flex items-center gap-1.5 transition cursor-pointer"><span>Pause</span></button>
                <button type="button" onclick="stopPipelineCompletely()" class="ui-pill hover:bg-[var(--bg-hover)] hover:text-rose-500 px-3.5 py-1.5 rounded-full text-xs font-bold inline-flex items-center gap-1.5 transition cursor-pointer"><span>Arrêter</span></button>`;
        } else if (visualState === 'paused') {
            actionBtnHtml = `
                <button type="button" onclick="handlePipeActionButton()" class="ui-pill hover:bg-[var(--bg-hover)] hover:text-emerald-500 px-3.5 py-1.5 rounded-full text-xs font-bold inline-flex items-center gap-1.5 transition cursor-pointer">
                    <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                    <span>Reprendre</span>
                </button>
                <button type="button" onclick="stopPipelineCompletely()" class="ui-pill hover:bg-[var(--bg-hover)] hover:text-rose-500 px-3.5 py-1.5 rounded-full text-xs font-bold inline-flex items-center gap-1.5 transition cursor-pointer"><span>Arrêter</span></button>`;
        } else {
            actionBtnHtml = `
                <button type="button" onclick="handlePipeActionButton()" class="ui-pill hover:bg-[var(--bg-hover)] hover:text-emerald-500 px-3.5 py-1.5 rounded-full text-xs font-bold inline-flex items-center gap-1.5 transition cursor-pointer">
                    <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                    <span>Reprendre</span>
                </button>`;
        }

        cardEl.innerHTML = `
            <div class="space-y-3">
                <div class="flex flex-wrap items-center justify-between gap-3">
                    <div class="flex items-center gap-2.5 min-w-0 flex-1">
                        <span class="w-2.5 h-2.5 rounded-full shrink-0 ${dotCls}"></span>
                        <div class="text-sm font-extrabold truncate" title="${escapeHtml(st.current_step || '')}">${escapeHtml(st.current_step || 'Activité en cours...')}</div>
                        <span class="ui-pill px-2.5 py-0.5 rounded-full text-[10px] font-extrabold shrink-0 ${stateMeta.badgeCls}">${stateMeta.badge}</span>
                    </div>
                    <div class="text-xs font-extrabold tabular-nums opacity-85 shrink-0">${pct} %</div>
                </div>
                <div class="w-full ui-pill rounded-full h-2 overflow-hidden">
                    <div class="h-full ${stateMeta.barCls} rounded-full transition-all duration-300" style="width:${pct}%;"></div>
                </div>
                <div class="flex flex-wrap items-center justify-between gap-3">
                    <div class="flex flex-wrap items-center gap-2 text-[11px] font-bold">
                        <span class="ui-pill rounded-full px-3 py-1 tabular-nums">Fichiers : ${proc} / ${tot}</span>
                        <span class="ui-pill rounded-full px-3 py-1 tabular-nums">Restant : ${escapeHtml(etaClean)}</span>
                        <span class="ui-pill rounded-full px-3 py-1 tabular-nums">${escapeHtml(spdClean)}</span>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">${actionBtnHtml}</div>
                </div>
            </div>`;
        return;
    }

    const list = Array.isArray(activities) ? activities : [];
    const latest = list.length ? list[0] : null;
    if (!latest) {
        cardEl.innerHTML = `<div class="text-xs font-semibold opacity-60 text-center py-1">Aucune activité enregistrée pour le moment.</div>`;
        return;
    }

    const aid = Number(latest.activity_id) || 0;
    const actType = String(latest.action_type || '').toUpperCase();
    const reasonLower = String(latest.reason || '').toLowerCase();
    const isStopped = (latest.status === 'paused' && reasonLower.includes('arrêtée'));
    const isPausedOnly = (latest.status === 'paused' && !isStopped);
    const proc = Number(latest.success_count) || 0;
    const tot = Number(latest.total_items) || 0;
    const pct = latest.status === 'success' ? 100 : (tot > 0 ? Math.min(100, Math.round((proc / tot) * 100)) : 0);
    const dtTxt = _formatActivityDateTime(latest.finished_at || latest.started_at);
    const durTxt = _formatActivityDuration(Number(latest.duration_sec) || 0);
    const canResume = RESUMABLE_ACTIVITY_TYPES.has(actType) && (latest.status === 'paused' || latest.status === 'error' || latest.status === 'partial');

    let dotCls = 'bg-emerald-400';
    let badgeTxt = 'Terminée';
    let badgeCls = 'text-emerald-500';
    let barCls = 'bg-emerald-500';
    if (isPausedOnly) {
        dotCls = 'bg-amber-400';
        badgeTxt = 'En pause';
        badgeCls = 'text-amber-500';
        barCls = 'bg-amber-400';
    } else if (isStopped) {
        dotCls = 'bg-rose-500';
        badgeTxt = 'Arrêtée';
        badgeCls = 'text-rose-500';
        barCls = 'bg-rose-500';
    } else if (latest.status === 'error') {
        dotCls = 'bg-rose-500';
        badgeTxt = 'Échouée';
        badgeCls = 'text-rose-500';
        barCls = 'bg-rose-500';
    } else if (latest.status === 'partial') {
        dotCls = 'bg-amber-400';
        badgeTxt = 'Partielle';
        badgeCls = 'text-amber-500';
        barCls = 'bg-amber-400';
    }

    let btnsHtml = '';
    if (isPausedOnly) {
        btnsHtml = `
            <button type="button" onclick="resumeOrRetryActivity(${aid}, event)" class="ui-pill hover:bg-[var(--bg-hover)] hover:text-emerald-500 px-3.5 py-1.5 rounded-full text-xs font-bold inline-flex items-center gap-1.5 transition cursor-pointer">
                <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                <span>Reprendre</span>
            </button>
            <button type="button" onclick="discardPausedActivity(${aid}, event)" class="ui-pill hover:bg-[var(--bg-hover)] hover:text-rose-500 px-3.5 py-1.5 rounded-full text-xs font-bold inline-flex items-center gap-1.5 transition cursor-pointer">
                <span>Arrêter</span>
            </button>`;
    } else if (canResume) {
        const retryHover = (latest.status === 'error' || isStopped) ? 'hover:text-amber-500' : 'hover:text-emerald-500';
        btnsHtml = `
            <button type="button" onclick="resumeOrRetryActivity(${aid}, event)" class="ui-pill hover:bg-[var(--bg-hover)] ${retryHover} px-3.5 py-1.5 rounded-full text-xs font-bold inline-flex items-center gap-1.5 transition cursor-pointer">
                <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                <span>Réessayer</span>
            </button>`;
    }

    cardEl.innerHTML = `
        <div class="space-y-3">
            <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="flex items-center gap-2.5 min-w-0 flex-1">
                    <span class="w-2.5 h-2.5 rounded-full shrink-0 ${dotCls}"></span>
                    <div class="text-sm font-extrabold truncate">${escapeHtml(latest.title || 'Activité')}</div>
                    <span class="ui-pill px-2.5 py-0.5 rounded-full text-[10px] font-extrabold shrink-0 ${badgeCls}">${badgeTxt}</span>
                    ${latest.library_name ? `<span class="text-[11px] font-bold opacity-55 shrink-0">· ${escapeHtml(latest.library_name)}</span>` : ''}
                </div>
                ${tot > 0 ? `<div class="text-xs font-extrabold tabular-nums opacity-85 shrink-0">${pct} %</div>` : ''}
            </div>
            ${tot > 0 ? `<div class="w-full ui-pill rounded-full h-2 overflow-hidden"><div class="h-full ${barCls} rounded-full transition-all duration-300" style="width:${pct}%;"></div></div>` : ''}
            <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="min-w-0 space-y-0.5">
                    <div class="text-xs opacity-75 truncate">${escapeHtml(latest.detail || '')}</div>
                    ${latest.reason ? `<div class="text-[11px] font-semibold text-rose-500/90 truncate">Raison : ${escapeHtml(latest.reason)}</div>` : ''}
                    <div class="text-[10px] opacity-60 font-semibold">${escapeHtml(dtTxt)} · Durée : ${escapeHtml(durTxt)}</div>
                </div>
                ${btnsHtml ? `<div class="flex items-center gap-2 shrink-0">${btnsHtml}</div>` : ''}
            </div>
        </div>`;
}

function toggleActivitySection(sectionKey) {
    if (_expandedActivitySections.has(sectionKey)) {
        _expandedActivitySections.delete(sectionKey);
    } else {
        _expandedActivitySections.add(sectionKey);
    }
    renderActivitiesHistory(_latestActivitiesCache);
}

function renderActivitiesHistory(activities) {
    const list = Array.isArray(activities) ? activities : [];
    _latestActivitiesCache = list;
    renderCurrentOrPendingActivity(latestPipelineState, list);
    const btnClear = document.getElementById('btn-clear-all-activities');
    if (btnClear) btnClear.classList.toggle('hidden', list.length === 0);

    const ops = [];
    const analyses = [];
    const actions = [];
    list.forEach(a => {
        const t = String(a.action_type || '').toUpperCase();
        if (ACTIVITY_GROUP_OPS.has(t)) ops.push(a);
        else if (ACTIVITY_GROUP_AI.has(t)) analyses.push(a);
        else actions.push(a);
    });

    const buckets = [
        { key: 'operations', items: ops, empty: "Aucune opération d'import ou de métadonnées enregistrée." },
        { key: 'analyses', items: analyses, empty: "Aucune analyse IA enregistrée pour le moment." },
        { key: 'actions', items: actions, empty: "Aucune action utilisateur enregistrée pour le moment." },
    ];
    buckets.forEach(b => {
        const cntEl = document.getElementById(`act-count-${b.key}`);
        if (cntEl) cntEl.textContent = String(b.items.length);

        const groups = _groupConsecutiveActivities(b.items);
        const isExpanded = _expandedActivitySections.has(b.key);
        const toggleBtn = document.getElementById(`act-toggle-${b.key}`);
        const toggleLbl = document.getElementById(`act-toggle-lbl-${b.key}`);
        const toggleChev = document.getElementById(`act-toggle-chevron-${b.key}`);
        if (toggleBtn) toggleBtn.classList.toggle('hidden', groups.length <= 1);
        if (toggleLbl) toggleLbl.textContent = isExpanded ? 'Réduire' : 'Tout voir';
        if (toggleChev) toggleChev.style.transform = isExpanded ? 'rotate(180deg)' : 'rotate(0deg)';

        const boxEl = document.getElementById(`activities-list-${b.key}`);
        if (!boxEl) return;
        const visibleGroups = isExpanded ? groups : groups.slice(0, 1);
        boxEl.innerHTML = visibleGroups.length
            ? _renderActivityGroupsHtml(visibleGroups)
            : `<div class="ui-pill rounded-2xl p-5 text-center text-xs font-semibold opacity-60">${b.empty}</div>`;
    });
}

// ==================== PARAMÈTRES & MAINTENANCE ====================

async function loadAppSettings() {
    const res = await fetch('/api/settings');
    if (!res.ok) return;
    const d = await res.json();
    window.appSettings = d;
    document.getElementById('settings-scanned-folders').value = (d.scanned_folders||[]).join('\n');
    document.getElementById('settings-takeout-dir').value = d.takeout_extract_dir || '';
    const tArch = document.getElementById('settings-takeout-arch');
    if (tArch) tArch.value = d.takeout_default_architecture || 'KEEP_ORIGINAL';
    const tGps = document.getElementById('settings-takeout-gps-tz');
    if (tGps) {
        const tzMode = d.takeout_timezone_mode || (d.takeout_use_gps_timezone === false ? 'SETTINGS_ONLY' : 'GPS_OR_SETTINGS');
        tGps.value = ['GPS_OR_SETTINGS', 'SETTINGS_ONLY', 'UTC'].includes(tzMode) ? tzMode : 'GPS_OR_SETTINGS';
    }
    const tFix = document.getElementById('settings-takeout-fix-meta');
    if (tFix) tFix.checked = (d.takeout_default_fix_metadata !== false);
    const tDel = document.getElementById('settings-takeout-del-zips');
    if (tDel) tDel.checked = Boolean(d.takeout_default_delete_zips);
    document.getElementById('settings-timezone').value = d.timezone || 'Europe/Paris';
    document.getElementById('settings-lang').value = d.language || 'fr';
    const homeCountryEl = document.getElementById('settings-home-country');
    if (homeCountryEl) homeCountryEl.value = (d.home_country !== undefined && d.home_country !== null) ? d.home_country : 'France';
    currentGpuMode = d.gpu_mode || 'auto';
    currentOcrEngine = d.ocr_engine || 'paddleocr';
    currentFacesModel = d.faces_model || 'buffalo_l';
    currentClipModel = d.clip_model || 'vit-b-32';
    if (d.ui_blur !== undefined) {
        setAppBlur(d.ui_blur !== false, false);
    }
    ['auto', 'cuda', 'directml', 'cpu'].forEach(g => {
        const b = document.getElementById(`gpu-btn-${g}`);
        if (b) b.classList.toggle('nav-item-active', g === currentGpuMode);
    });
    loadHardwareInfo(false);
    loadAiModulesStatus();
    loadExifToolStatus(false);
    loadFFmpegStatus(false);
}

function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

async function loadHardwareInfo(refresh = false) {
    const box = document.getElementById('hardware-specs-box');
    if (!box) return;
    try {
        const res = await fetch(`/api/hardware?refresh=${refresh ? 'true' : 'false'}`);
        if (!res.ok) {
            box.textContent = `Détection indisponible (HTTP ${res.status}).`;
            return;
        }
        const d = await res.json();
        const hw = d.hardware || {};
        const rt = d.runtime || {};
        const vramTxt = hw.vram_gb ? ` · ${hw.vram_gb} Go VRAM` : '';
        const tierBadge = hw.power_tier === 'Élevée'
            ? 'bg-emerald-500/20 text-emerald-300'
            : (hw.power_tier === 'Moyenne' ? 'bg-amber-500/20 text-amber-300' : 'bg-white/10 opacity-85');
        box.innerHTML = `
            <div class="grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
                <div>
                    <div class="opacity-60 text-[11px] font-bold">Processeur</div>
                    <div class="font-extrabold mt-0.5">${hw.cpu_cores || '?'} cœurs · ${escapeHtml(hw.os || '')}</div>
                </div>
                <div>
                    <div class="opacity-60 text-[11px] font-bold">Mémoire RAM</div>
                    <div class="font-extrabold mt-0.5">${hw.ram_total_gb ? hw.ram_total_gb + ' Go' : 'Inconnue'}</div>
                </div>
                <div>
                    <div class="opacity-60 text-[11px] font-bold">Carte Graphique</div>
                    <div class="font-extrabold mt-0.5 leading-snug" title="${escapeHtml(hw.gpu_name || '')}">${escapeHtml(hw.gpu_name || 'Inconnue')}${vramTxt}</div>
                </div>
                <div>
                    <div class="opacity-60 text-[11px] font-bold">Profil détecté</div>
                    <div class="flex flex-wrap items-center gap-1.5 mt-0.5">
                        <span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold ${tierBadge}">Puissance ${escapeHtml(hw.power_tier || 'Standard')}</span>
                        <span class="font-extrabold">${escapeHtml(hw.accel_label || 'CPU')} · ${hw.recommended_workers || 1} workers</span>
                    </div>
                </div>
            </div>
            <div class="mt-2 pt-2 border-t border-white/10 text-[11px] opacity-70">
                Moteur actif : <b>${escapeHtml((rt.mode || 'cpu').toUpperCase())}</b>${rt.requested_mode === 'auto' ? ' (sélectionné automatiquement)' : ' (forcé manuellement)'}
            </div>
        `;
    } catch (e) {
        box.textContent = 'Impossible de détecter le matériel.';
    }
}

let _aiTaskPollTimer = null;
let _aiModulesCache = [];
let _aiUpdatesCache = null;
let _aiUpdatesSummary = null;

async function loadAiModulesStatus() {
    const listEl = document.getElementById('ai-modules-list');
    if (!listEl) return;
    try {
        const res = await fetch('/api/ai/status');
        if (!res.ok) return;
        const d = await res.json();
        _aiModulesCache = d.modules || [];
        renderAiModulesList(_aiModulesCache, d.task || {});
        if (d.task && d.task.running) {
            updateAiLogBox(d.task);
            startAiTaskPolling();
        }
    } catch (e) {
        listEl.innerHTML = `<div class="ui-pill rounded-2xl p-4 text-xs text-rose-400">Impossible de vérifier l'état de l'IA locale.</div>`;
    }
}

async function checkAiUpdates() {
    const btn = document.getElementById('ai-check-updates-btn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Recherche...';
    }
    try {
        const res = await fetch('/api/ai/check_updates');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const d = await res.json();
        _aiUpdatesCache = d.updates || {};
        _aiUpdatesSummary = {
            network_ok: !!d.network_ok,
            total_updates: d.total_updates || 0,
            checked_at: d.checked_at || '',
        };
        renderAiModulesList(_aiModulesCache, {});
    } catch (e) {
        _aiUpdatesSummary = { network_ok: false, total_updates: 0, checked_at: '', error: true };
        renderAiModulesList(_aiModulesCache, {});
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Vérifier MÀJ';
        }
    }
}

function renderAiSummaryBar(modules) {
    const bar = document.getElementById('ai-summary-bar');
    if (!bar) return;
    if (!modules || !modules.length) {
        bar.classList.add('hidden');
        return;
    }
    bar.classList.remove('hidden');
    const readyCount = modules.filter(m => m.status === 'ready').length;
    const totalMb = modules.reduce((acc, m) => acc + (Number(m.cache_size_mb) || 0), 0);
    const cacheTxt = totalMb >= 1024 ? `${(totalMb / 1024).toFixed(2)} Go` : `${totalMb.toFixed(1)} Mo`;

    let updHtml = `<span class="opacity-65">Mises à jour non vérifiées</span>`;
    if (_aiUpdatesSummary) {
        if (_aiUpdatesSummary.error || !_aiUpdatesSummary.network_ok) {
            updHtml = `<span class="text-rose-400 font-bold">PyPI inaccessible (hors-ligne)</span>`;
        } else if (_aiUpdatesSummary.total_updates === 0) {
            updHtml = `<span class="text-emerald-400 font-bold">✓ Tout est à jour (${escapeHtml(_aiUpdatesSummary.checked_at)})</span>`;
        } else {
            updHtml = `<span class="text-sky-400 font-bold">⬆ ${_aiUpdatesSummary.total_updates} module(s) à mettre à jour (${escapeHtml(_aiUpdatesSummary.checked_at)})</span>`;
        }
    }

    bar.innerHTML = `
        <div class="flex flex-wrap items-center gap-4">
            <span class="font-extrabold">${readyCount}/${modules.length} modules prêts</span>
            <span class="opacity-40">|</span>
            <span>Stockage modèles : <b>${cacheTxt}</b></span>
            <span class="opacity-40">|</span>
            ${updHtml}
        </div>
        ${(_aiUpdatesSummary && _aiUpdatesSummary.total_updates > 0)
            ? `<button type="button" onclick="runAiModuleAction('all', 'update')" class="plum-btn px-3.5 py-1.5 rounded-full text-[11px] font-bold shadow-sm transition">Tout mettre à jour</button>`
            : ''}
    `;
}

function renderAiModulesList(modules, task) {
    const listEl = document.getElementById('ai-modules-list');
    if (!listEl) return;
    const isBusy = !!(task && task.running);
    renderAiSummaryBar(modules);

    const icons = { faces: '👤', clip: '✨', ocr: '📝' };

    listEl.innerHTML = modules.map(m => {
        let badgeCls = 'bg-zinc-500/20 text-zinc-400';
        let badgeTxt = 'Non installé';
        if (m.status === 'ready') {
            badgeCls = 'bg-emerald-500/20 text-emerald-400';
            badgeTxt = 'Installé & prêt';
        } else if (m.status === 'partial') {
            badgeCls = 'bg-amber-500/20 text-amber-400';
            badgeTxt = 'Modèle à télécharger';
        }

        const modUpd = (_aiUpdatesCache && _aiUpdatesCache[m.id]) || null;
        const updBadge = (modUpd && modUpd.has_update)
            ? `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-extrabold bg-sky-500/20 text-sky-400">⬆ MÀJ dispo</span>`
            : '';

        const devLabel = m.device_label || 'CPU';
        const isGpu = devLabel.toUpperCase().includes('GPU');
        const devBadge = `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-bold ${isGpu ? 'bg-violet-500/20 text-violet-300' : 'bg-white/10 opacity-75'}">${isGpu ? '⚡' : '🖥'} ${escapeHtml(devLabel)}</span>`;
        const cacheBadge = `<span class="px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-white/10 opacity-80">💾 ${m.model_cached ? m.cache_size_mb + ' Mo' : '0 Mo'}</span>`;

        const pkgPills = Object.entries(m.packages || {}).map(([pkg, ver]) => {
            const ok = !!ver;
            const pUpd = modUpd && modUpd.packages && modUpd.packages[pkg];
            const latestTxt = (pUpd && pUpd.update_available && pUpd.latest) ? ` → v${pUpd.latest}` : '';
            return `<span class="px-2.5 py-1 rounded-xl text-[10px] font-mono ${ok ? 'bg-black/15 dark:bg-white/5 border border-white/10' : 'bg-rose-500/15 text-rose-400'}">${pkg}${ver ? ' v' + ver : ' (absent)'}${latestTxt ? `<b class="text-sky-400">${latestTxt}</b>` : ''}</span>`;
        }).join('');

        const disAttr = isBusy ? 'disabled opacity-50 pointer-events-none' : '';
        const modelOptions = Array.isArray(m.model_options) ? m.model_options : [];
        const modelSelector = modelOptions.length > 0
            ? `<div class="flex flex-wrap items-center gap-2 pt-1">
                <span class="text-[11px] font-bold opacity-60">${m.id === 'ocr' ? 'Moteur :' : 'Modèle :'}</span>
                ${modelOptions.map(opt => {
                    const active = opt.id === m.selected_model;
                    const cachedDot = opt.cached ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1.5" title="Présent en local"></span>' : '';
                    return `<button type="button" onclick="selectAiModuleModel('${m.id}', '${opt.id}')" title="${escapeHtml(opt.description || '')}"
                        class="px-3 py-1.5 rounded-xl text-[11px] font-bold transition flex items-center ${active ? 'nav-item-active shadow-sm' : 'ui-card opacity-80 hover:opacity-100'} ${disAttr}">${cachedDot}${escapeHtml(opt.label)}</button>`;
                }).join('')}
               </div>`
            : '';

        const staleBanner = (m.stale_media_count && m.stale_media_count > 0)
            ? `<div class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-xl bg-amber-500/15 border border-amber-400/30 text-[11px] text-amber-200">
                   <span>⚠ ${m.stale_media_count} média(s) avaient été analysé(s) avec un autre modèle.</span>
                   <button type="button" onclick="reindexStaleAiModel('${m.id}', false)"
                           class="px-2.5 py-1 rounded-full bg-amber-400 text-[#1E1E1E] font-bold hover:bg-amber-300 transition">
                       Ré-analyser maintenant
                   </button>
               </div>`
            : '';

        return `
        <div class="ui-pill rounded-2xl p-5 space-y-3">
            <div class="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
                <div class="space-y-1 min-w-0">
                    <div class="flex flex-wrap items-center gap-2">
                        <span class="text-base">${icons[m.id] || '🤖'}</span>
                        <span class="text-sm font-extrabold">${escapeHtml(m.name)}</span>
                        <span class="px-2.5 py-0.5 rounded-full text-[10px] font-extrabold ${badgeCls}">${badgeTxt}</span>
                        ${devBadge}
                        ${cacheBadge}
                        ${updBadge}
                    </div>
                    <p class="text-xs opacity-70 pl-6">${escapeHtml(m.description)}</p>
                </div>
                <div class="flex flex-wrap items-center gap-2 shrink-0 pl-6 lg:pl-0">
                    <button type="button" onclick="runAiModuleAction('${m.id}', 'verify')"
                            class="ui-card px-3.5 py-1.5 rounded-full text-xs font-bold hover:opacity-85 transition ${disAttr}">Vérifier</button>
                    ${m.status === 'not_installed'
                        ? `<button type="button" onclick="runAiModuleAction('${m.id}', 'install')" title="Installe les packages et télécharge le modèle sélectionné"
                                   class="plum-btn px-4 py-1.5 rounded-full text-xs font-bold shadow-sm transition ${disAttr}">Installer</button>`
                        : m.status === 'partial'
                        ? `<button type="button" onclick="runAiModuleAction('${m.id}', 'install')" title="Télécharge le modèle sélectionné en local"
                                   class="plum-btn px-4 py-1.5 rounded-full text-xs font-bold shadow-sm transition ${disAttr}">Télécharger le modèle</button>
                           <button type="button" onclick="confirmUninstallAiModule(this, '${m.id}')"
                                   class="bg-rose-600/85 hover:bg-rose-600 text-white px-3.5 py-1.5 rounded-full text-xs font-bold transition ${disAttr}">Désinstaller</button>`
                        : `${(modUpd && modUpd.has_update)
                            ? `<button type="button" onclick="runAiModuleAction('${m.id}', 'update')" title="Met à jour les packages Python du module vers la dernière version"
                                       class="plum-btn px-4 py-1.5 rounded-full text-xs font-bold shadow-sm transition ${disAttr}">⬆ Mettre à jour</button>`
                            : ''}
                           <button type="button" onclick="confirmUninstallAiModule(this, '${m.id}')"
                                   class="bg-rose-600/85 hover:bg-rose-600 text-white px-3.5 py-1.5 rounded-full text-xs font-bold transition ${disAttr}">Désinstaller</button>`
                    }
                </div>
            </div>
            <div class="pl-6 space-y-2.5 pt-1 border-t border-white/10">
                ${modelSelector}
                ${staleBanner}
                <div class="flex flex-wrap items-center gap-1.5">
                    <span class="text-[10px] font-bold uppercase tracking-wider opacity-45 mr-1">Packages</span>
                    ${pkgPills}
                </div>
            </div>
        </div>`;
    }).join('');
}

function confirmUninstallAiModule(btn, moduleId) {
    if (btn.dataset.armed === '1') {
        btn.dataset.armed = '';
        runAiModuleAction(moduleId, 'uninstall');
        return;
    }
    btn.dataset.armed = '1';
    const orig = btn.textContent;
    btn.textContent = 'Confirmer ?';
    setTimeout(() => {
        if (btn && btn.dataset.armed === '1') {
            btn.dataset.armed = '';
            btn.textContent = orig;
        }
    }, 4000);
}

function updateAiLogBox(task) {
    const box = document.getElementById('ai-task-log-box');
    const lbl = document.getElementById('ai-task-status-label');
    const pre = document.getElementById('ai-task-log-content');
    if (!box || !lbl || !pre) return;
    box.classList.remove('hidden');
    if (task.running) {
        lbl.textContent = `⏳ Opération '${task.action}' sur '${task.module}' en cours...`;
    } else if (task.success === true) {
        lbl.textContent = `✓ Opération '${task.action}' sur '${task.module}' réussie`;
    } else if (task.success === false) {
        lbl.textContent = `⚠ Opération '${task.action}' sur '${task.module}' terminée avec avertissements`;
    }
    pre.textContent = (task.logs || []).join('\n');
    pre.scrollTop = pre.scrollHeight;
}

function startAiTaskPolling() {
    if (_aiTaskPollTimer) return;
    _aiTaskPollTimer = setInterval(async () => {
        try {
            const res = await fetch('/api/ai/task_status');
            if (!res.ok) return;
            const t = await res.json();
            updateAiLogBox(t);
            if (!t.running) {
                clearInterval(_aiTaskPollTimer);
                _aiTaskPollTimer = null;
                await loadAiModulesStatus();
            }
        } catch (e) {}
    }, 1000);
}

async function runAiModuleAction(moduleId, action) {
    const res = await fetch('/api/ai/action', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({module: moduleId, action: action})
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        updateAiLogBox({ running: false, action, module: moduleId, success: false, logs: [err.detail || "Erreur lors du lancement de l'opération."] });
        return;
    }
    updateAiLogBox({ running: true, action, module: moduleId, logs: [`Démarrage de '${action}' sur '${moduleId}'...`] });
    startAiTaskPolling();
}

async function reindexStaleAiModel(moduleId, includeUnknown = true) {
    const res = await fetch('/api/ai/reindex_model', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ module_id: moduleId, include_unknown: includeUnknown })
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.detail || "Impossible de relancer l'analyse.");
        return;
    }
    await loadAiModulesStatus();
}

async function selectAiModuleModel(moduleId, modelId) {
    const prevModel = moduleId === 'ocr' ? currentOcrEngine : (moduleId === 'faces' ? currentFacesModel : currentClipModel);
    if (moduleId === 'ocr') currentOcrEngine = modelId;
    else if (moduleId === 'faces') currentFacesModel = modelId;
    else if (moduleId === 'clip') currentClipModel = modelId;
    await saveAppSettingsQuiet();
    await loadAiModulesStatus();

    if ((moduleId === 'faces' || moduleId === 'clip') && prevModel && prevModel !== modelId) {
        try {
            const res = await fetch(`/api/ai/model_mismatch?module_id=${encodeURIComponent(moduleId)}&target_model=${encodeURIComponent(modelId)}&prev_model=${encodeURIComponent(prevModel)}`);
            if (res.ok) {
                const info = await res.json();
                if (info.stale_count > 0) {
                    const label = moduleId === 'faces' ? 'Visages' : 'CLIP';
                    const preserveNote = moduleId === 'faces'
                        ? '\nVos noms de personnes déjà attribués seront conservés et ré-associés automatiquement.'
                        : '';
                    const ok = confirm(
                        `Modèle ${label} changé vers « ${modelId} ».\n` +
                        `${info.stale_count} média(s) déjà analysé(s) utilisaient un autre modèle.${preserveNote}\n\n` +
                        `Voulez-vous relancer automatiquement leur ré-analyse avec « ${modelId} » maintenant ?`
                    );
                    if (ok) {
                        await reindexStaleAiModel(moduleId, true);
                    }
                }
            }
        } catch (e) {}
    }
}

const _toolPollTimers = {};

function _renderExternalToolStatus(cfg, d) {
    const badge = document.getElementById(cfg.badgeId);
    const detail = document.getElementById(cfg.detailId);
    const btn = document.getElementById(cfg.btnId);
    if (!badge) return;

    badge.className = 'px-2 py-0.5 rounded-full text-[10px] font-extrabold shrink-0';
    if (d.installing) {
        badge.classList.add('bg-sky-500/20', 'text-sky-400');
        badge.textContent = 'Installation…';
        if (detail) {
            const logs = d.logs || [];
            detail.textContent = logs.length ? logs[logs.length - 1] : 'Téléchargement en cours…';
        }
        if (btn) btn.classList.add('hidden');
        return;
    }

    const pyReady = (cfg.requirePyExifTool ? Boolean(d.pyexiftool_installed) : true);
    const fullyReady = Boolean(d.installed && pyReady);
    if (fullyReady) {
        if (d.update_available && d.latest_version) {
            badge.classList.add('bg-sky-500/20', 'text-sky-400');
            badge.textContent = `v${d.version} → MÀJ v${d.latest_version}`;
            if (detail) detail.textContent = d.path || '';
            if (btn) {
                btn.classList.remove('hidden');
                btn.textContent = `Mettre à jour (v${d.latest_version})`;
                btn.setAttribute('onclick', `${cfg.installFn}(true)`);
            }
        } else {
            badge.classList.add('bg-emerald-500/20', 'text-emerald-400');
            const upToDateTag = (d.update_checked && d.latest_version) ? ' · À jour' : '';
            badge.textContent = `✓ Installé${d.version ? ' (v' + d.version + ')' : ''}${upToDateTag}`;
            if (detail) {
                detail.textContent = (d.update_checked && d.network_ok === false)
                    ? `${d.path || ''} · Hors-ligne`
                    : (d.path || '');
            }
            if (btn) btn.classList.add('hidden');
        }
        return;
    }

    badge.classList.add('bg-rose-500/20', 'text-rose-400');
    if (d.installed && cfg.requirePyExifTool && !d.pyexiftool_installed) {
        badge.textContent = 'PyExifTool manquant';
    } else if (d.binary_present && d.broken_reason) {
        badge.textContent = 'Installation corrompue';
    } else {
        badge.textContent = 'Non installé';
    }
    if (detail) {
        detail.textContent = d.last_error
            ? `Erreur : ${d.last_error}`
            : (d.broken_reason || cfg.missingHint);
    }
    if (btn) {
        btn.classList.remove('hidden');
        btn.textContent = !d.installed
            ? (d.binary_present ? 'Réparer / Installer' : `Installer ${cfg.label}`)
            : 'Installer PyExifTool';
        btn.setAttribute('onclick', `${cfg.installFn}(false)`);
    }
}

async function _loadExternalToolStatus(cfg, checkUpdate = false) {
    try {
        const res = await fetch(`${cfg.statusUrl}?check_update=${checkUpdate ? 'true' : 'false'}`);
        if (!res.ok) return;
        const d = await res.json();
        _renderExternalToolStatus(cfg, d);
        if (d.installing) {
            if (!_toolPollTimers[cfg.key]) {
                _toolPollTimers[cfg.key] = setInterval(() => _loadExternalToolStatus(cfg, false), 1500);
            }
        } else if (_toolPollTimers[cfg.key]) {
            clearInterval(_toolPollTimers[cfg.key]);
            delete _toolPollTimers[cfg.key];
        }
    } catch (e) {}
}

async function _installExternalToolNow(cfg, forceUpdate = false) {
    const btn = document.getElementById(cfg.btnId);
    if (btn) btn.classList.add('hidden');
    try {
        const res = await fetch(`${cfg.installUrl}?force=${forceUpdate ? 'true' : 'false'}`, { method: 'POST' });
        if (!res.ok && res.status !== 409) {
            const err = await res.json().catch(() => ({}));
            alert(err.detail || `Impossible de lancer l'installation de ${cfg.label}.`);
            await _loadExternalToolStatus(cfg, false);
            return;
        }
        await _loadExternalToolStatus(cfg, false);
    } catch (e) {
        await _loadExternalToolStatus(cfg, false);
    }
}

const _EXIFTOOL_CFG = {
    key: 'exiftool',
    label: 'ExifTool',
    badgeId: 'settings-exiftool-badge',
    detailId: 'settings-exiftool-detail',
    btnId: 'settings-exiftool-install-btn',
    statusUrl: '/api/tools/exiftool/status',
    installUrl: '/api/tools/exiftool/install',
    installFn: 'installExifToolNow',
    requirePyExifTool: true,
    missingHint: 'Requis pour corriger les dates EXIF/GPS Google Takeout.'
};

const _FFMPEG_CFG = {
    key: 'ffmpeg',
    label: 'FFmpeg',
    badgeId: 'settings-ffmpeg-badge',
    detailId: 'settings-ffmpeg-detail',
    btnId: 'settings-ffmpeg-install-btn',
    statusUrl: '/api/tools/ffmpeg/status',
    installUrl: '/api/tools/ffmpeg/install',
    installFn: 'installFFmpegNow',
    requirePyExifTool: false,
    missingHint: 'Requis pour découper et exporter les vidéos dans le Studio.'
};

function renderExifToolStatus(d) { _renderExternalToolStatus(_EXIFTOOL_CFG, d); }
async function loadExifToolStatus(checkUpdate = false) { return _loadExternalToolStatus(_EXIFTOOL_CFG, checkUpdate); }
async function installExifToolNow(forceUpdate = false) { return _installExternalToolNow(_EXIFTOOL_CFG, forceUpdate); }

function renderFFmpegStatus(d) { _renderExternalToolStatus(_FFMPEG_CFG, d); }
async function loadFFmpegStatus(checkUpdate = false) { return _loadExternalToolStatus(_FFMPEG_CFG, checkUpdate); }
async function installFFmpegNow(forceUpdate = false) { return _installExternalToolNow(_FFMPEG_CFG, forceUpdate); }

async function browseTakeoutExtractDir() {
    const res = await fetch('/api/dialog/browse?mode=folder');
    if (!res.ok) return;
    const d = await res.json();
    if (!d.paths || !d.paths.length) return;
    const inp = document.getElementById('settings-takeout-dir');
    if (inp) {
        inp.value = d.paths[0];
        await saveAppSettingsQuiet();
    }
}

async function clearTakeoutExtractDir() {
    const inp = document.getElementById('settings-takeout-dir');
    if (inp) {
        inp.value = '';
        await saveAppSettingsQuiet();
    }
}

async function saveAppSettingsQuiet() {
    const payload = {
        scanned_folders: document.getElementById('settings-scanned-folders').value.split('\n'),
        takeout_extract_dir: document.getElementById('settings-takeout-dir').value,
        takeout_default_architecture: document.getElementById('settings-takeout-arch')?.value || 'KEEP_ORIGINAL',
        takeout_default_fix_metadata: document.getElementById('settings-takeout-fix-meta')?.checked !== false,
        takeout_default_delete_zips: Boolean(document.getElementById('settings-takeout-del-zips')?.checked),
        takeout_timezone_mode: document.getElementById('settings-takeout-gps-tz')?.value || 'GPS_OR_SETTINGS',
        takeout_use_gps_timezone: (document.getElementById('settings-takeout-gps-tz')?.value || 'GPS_OR_SETTINGS') === 'GPS_OR_SETTINGS',
        timezone: document.getElementById('settings-timezone').value,
        language: document.getElementById('settings-lang').value || 'fr',
        home_country: document.getElementById('settings-home-country')?.value ?? 'France',
        gpu_mode: currentGpuMode,
        ocr_engine: currentOcrEngine,
        faces_model: currentFacesModel,
        clip_model: currentClipModel,
        ui_blur: currentUiBlur
    };
    window.appSettings = { ...(window.appSettings || {}), ...payload };
    await fetch('/api/settings/save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify(payload)
    });
}

async function onHomeCountryChanged() {
    await saveAppSettingsQuiet();
    if (currentTab === 'map' && typeof loadWorldMap === 'function') {
        loadWorldMap(false);
    }
}

async function backupDatabaseNow() {
    const res = await fetch('/api/database/backup', {method: 'POST'});
    const msgBox = document.getElementById('backup-result-msg');
    if (res.ok) {
        const d = await res.json();
        msgBox.textContent = `✓ Sauvegarde créée (${d.size_mb} Mo) : ${d.backup_path}`;
        msgBox.classList.remove('hidden');
    }
}

async function pruneMissingFiles() {
    const res = await fetch('/api/database/prune_missing', {method: 'POST'});
    if (res.ok) {
        const d = await res.json();
        await loadStats(); await loadGalleryFilters(); refreshActiveMediaView();
        alert(`Nettoyage terminé : ${d.removed_count} entrée(s) obsolète(s) supprimée(s).`);
    }
}

async function retryMissingMetadataNow() {
    const btn = document.getElementById('btn-retry-meta');
    btn.disabled = true;
    btn.textContent = "Récupération en cours...";
    try {
        const res = await fetch('/api/metadata/retry_recovery', {method: 'POST'});
        const d = await res.json();
        await loadStats(); await loadGalleryFilters(); refreshActiveMediaView();
        alert(`Récupération terminée : ${d.repaired} fichier(s) reclassé(s), ${d.still_missing} restant(s).`);
    } finally {
        btn.disabled = false;
        btn.textContent = "Réparer les dates";
    }
}

let _pendingPowerMode = ''; // 'restart' | 'shutdown'

function closePowerActivityModal() {
    _pendingPowerMode = '';
    const m = document.getElementById('power-activity-modal');
    if (m) m.classList.add('hidden');
}

function _openPowerActivityModal(mode) {
    _pendingPowerMode = mode;
    const isRestart = (mode === 'restart');
    const isRunning = Boolean(latestPipelineState && latestPipelineState.is_running);

    const modal = document.getElementById('power-activity-modal');
    const titleEl = document.getElementById('power-modal-title');
    const badgeEl = document.getElementById('power-modal-running-badge');
    const stepEl = document.getElementById('power-modal-running-step');
    const msgEl = document.getElementById('power-modal-msg');
    const activeChoices = document.getElementById('power-modal-active-choices');
    const idleChoices = document.getElementById('power-modal-idle-choices');
    const idleBtn = document.getElementById('power-modal-idle-confirm-btn');

    if (!modal) return;
    if (titleEl) titleEl.textContent = isRestart ? 'Redémarrer Phototo' : 'Arrêter Phototo';

    if (isRunning) {
        if (badgeEl) badgeEl.classList.remove('hidden');
        if (stepEl) stepEl.textContent = latestPipelineState.current_step || 'Activité en cours...';
        if (msgEl) {
            msgEl.textContent = isRestart
                ? "Une activité est en cours. Choisissez si vous souhaitez la mettre en pause, l'arrêter ou l'ignorer avant de redémarrer le programme :"
                : "Une activité est en cours. Choisissez si vous souhaitez la mettre en pause, l'arrêter ou l'ignorer avant d'arrêter le programme :";
        }
        if (activeChoices) activeChoices.classList.remove('hidden');
        if (idleChoices) idleChoices.classList.add('hidden');
    } else {
        if (badgeEl) badgeEl.classList.add('hidden');
        if (msgEl) {
            msgEl.textContent = isRestart
                ? 'Voulez-vous redémarrer Phototo maintenant ?'
                : 'Voulez-vous arrêter complètement Phototo ?';
        }
        if (activeChoices) activeChoices.classList.add('hidden');
        if (idleChoices) idleChoices.classList.remove('hidden');
        if (idleBtn) idleBtn.textContent = isRestart ? 'Redémarrer' : 'Arrêter';
    }

    modal.classList.remove('hidden');
}

async function executePowerAction(activityAction = 'pause') {
    const mode = _pendingPowerMode;
    closePowerActivityModal();
    if (!mode) return;

    const act = encodeURIComponent(activityAction || 'pause');
    if (mode === 'restart') {
        await fetch(`/api/system/restart?activity_action=${act}`, {method: 'POST'});
        setTimeout(() => window.location.reload(), 2000);
    } else if (mode === 'shutdown') {
        await fetch(`/api/system/shutdown?activity_action=${act}`, {method: 'POST'});
        document.body.innerHTML = `<div class="h-screen flex items-center justify-center text-xl font-extrabold">🛑 Phototo est arrêté.</div>`;
    }
}

function restartApplication() {
    _openPowerActivityModal('restart');
}

function shutdownApplication() {
    _openPowerActivityModal('shutdown');
}

window.addEventListener('beforeunload', (e) => {
    if (latestPipelineState && latestPipelineState.is_running) {
        e.preventDefault();
        e.returnValue = '';
    }
});

// ==================== BOUCLE DE STATUT EN DIRECT ====================

let wasPipelineRunning = false;
let pipelineRefreshTicks = 0;

setInterval(async () => {
    try {
        const res = await fetch('/api/pipeline/status');
        if (!res.ok) return;
        const st = await res.json();
        if (st.notifications) renderNotificationsLists(st.notifications);
        latestPipelineState = st;

        if (st.is_running && st.active_task && st.active_task !== 'IDLE') {
            lastSeenActiveTask = st.active_task;
        }
        if (!st.is_running && st.current_step && st.current_step.includes('En pause') && !clientPausedTask) {
            clientPausedTask = lastSeenActiveTask || 'INGEST';
        }
        const hasMissing = (st.missing_meta_files && st.missing_meta_files.length > 0);
        const liveVisualState = _resolvePipelineVisualState(st);
        const pausedFromDb = (liveVisualState === 'idle') ? _findActivePausedActivityFromHistory(_latestActivitiesCache) : null;
        const visualState = pausedFromDb ? 'paused' : liveVisualState;
        const uiState = pausedFromDb ? {
            ...st,
            current_step: `En pause : ${pausedFromDb.title || 'Opération'}`,
            processed_items: Number(pausedFromDb.success_count) || 0,
            total_items: Number(pausedFromDb.total_items) || 0,
            percent: (Number(pausedFromDb.total_items) > 0)
                ? Math.min(100, Math.round((Number(pausedFromDb.success_count || 0) / Number(pausedFromDb.total_items)) * 100))
                : 0,
            eta_text: '--:--',
            speed_text: '-- Mo/s',
        } : st;

        const applyDotStyle = (dotEl) => {
            if (!dotEl) return;
            dotEl.classList.remove('bg-emerald-400', 'bg-amber-400', 'bg-rose-500', 'animate-pulse');
            _statusDotClassesForState(visualState).split(' ').forEach(cls => {
                if (cls) dotEl.classList.add(cls);
            });
        };

        renderCurrentOrPendingActivity(st, _latestActivitiesCache);

        const hasActivityBanner = (visualState !== 'idle');
        const showActivePanel = hasActivityBanner || hasMissing;

        const pulseBadge = document.getElementById('pulse-badge');
        if (pulseBadge) {
            pulseBadge.classList.toggle('hidden', !hasActivityBanner);
            applyDotStyle(pulseBadge);
        }
        applyDotStyle(document.getElementById('pop-status-dot'));
        const actBtn = document.getElementById('activity-status-btn');
        const actPill = document.getElementById('activity-notif-pill');
        const actTextEl = document.getElementById('activity-status-text');
        if (actBtn) {
            actBtn.classList.toggle('hidden', !hasActivityBanner);
            actBtn.classList.toggle('flex', hasActivityBanner);
        }
        if (actPill) {
            actPill.classList.toggle('pl-2.5', hasActivityBanner);
            actPill.classList.toggle('pr-0.5', hasActivityBanner);
            actPill.classList.toggle('py-0.5', hasActivityBanner);
            actPill.classList.toggle('gap-1.5', hasActivityBanner);
            actPill.classList.toggle('p-0.5', !hasActivityBanner);
        }
        if (actTextEl) {
            actTextEl.textContent = hasActivityBanner
                ? (uiState.is_running ? (uiState.current_step || 'Activité en cours...') : (uiState.current_step || 'Activité en pause'))
                : '';
        }
        const emptySt = document.getElementById('task-empty-state');
        if (emptySt) emptySt.classList.toggle('hidden', showActivePanel);
        const activeSt = document.getElementById('task-active-state');
        if (activeSt) activeSt.classList.toggle('hidden', !showActivePanel);

        if (showActivePanel) {
            document.getElementById('pop-step-title').textContent = uiState.current_step || 'Analyse en cours...';
            document.getElementById('pipe-bar').style.width = `${uiState.percent}%`;
            document.getElementById('pop-percent-text').textContent = `${uiState.percent} %`;

            document.getElementById('pop-files-pill').innerHTML = `<span class="opacity-70 truncate">Fichiers traités</span><span class="font-extrabold tabular-nums shrink-0">${uiState.processed_items} / ${uiState.total_items}</span>`;
            const etaClean = (uiState.eta_text || '').replace('ETA: ', '') || '--:--';
            document.getElementById('pop-eta-pill').innerHTML = `Temps restant<br>${etaClean}`;
            document.getElementById('pop-speed-pill').innerHTML = `Vitesse<br>${escapeHtml(uiState.speed_text || '-- Mo/s')}`;

            const dupsEta = document.getElementById('dups-eta-label');
            if (dupsEta) dupsEta.textContent = etaClean;
            const simsEta = document.getElementById('sims-eta-label');
            if (simsEta) simsEta.textContent = etaClean;

            document.getElementById('icon-pause-bars').classList.toggle('hidden', !st.is_running);
            document.getElementById('icon-play-triangle').classList.toggle('hidden', st.is_running);
            const pauseLbl = document.getElementById('label-pause-pipe');
            if (pauseLbl) pauseLbl.textContent = st.is_running ? 'Pause' : 'Reprendre';
            const pauseBtn = document.getElementById('btn-pause-pipe');
            if (pauseBtn) {
                pauseBtn.classList.toggle('hover:text-amber-500', st.is_running);
                pauseBtn.classList.toggle('hover:text-emerald-500', !st.is_running);
            }

            const warnBtn = document.getElementById('btn-task-warning');
            if (warnBtn) warnBtn.classList.toggle('hidden', !hasMissing);
            if (hasMissing) {
                document.getElementById('task-missing-meta-list').innerHTML = st.missing_meta_files
                    .slice(0, 30)
                    .map(p => `<div class="truncate">${p}</div>`)
                    .join('');
            }
        }

        const box = document.getElementById('pipe-logs-box');
        if (box) {
            if (st.logs && st.logs.length) {
                const wasAtBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 36;
                box.innerHTML = st.logs.map(l => `<div class="truncate" title="${escapeHtml(l)}">${escapeHtml(l)}</div>`).join('');
                if (wasAtBottom) box.scrollTop = box.scrollHeight;
            } else {
                box.innerHTML = '';
            }
        }

        if (st.is_running) {
            pipelineRefreshTicks++;
            if (pipelineRefreshTicks % 3 === 0) loadStats();
            if (pipelineRefreshTicks % 8 === 0) {
                const isLightboxOpen = !document.getElementById('lightbox-modal').classList.contains('hidden');
                if (!isLightboxOpen && selectedGalleryPaths.size === 0) {
                    if ((currentTab === 'gallery' || currentTab === 'favorites' || currentTab === 'recent') && galleryPage === 1 && currentSkipOffset === 0) loadGalleryItems(false);
                    else if (currentTab === 'faces' && currentTimelinePersonId === null && typeof selectedPersonIds !== 'undefined' && selectedPersonIds.size === 0) loadPersons();
                    else if (currentTab === 'dups') loadDuplicates();
                    else if (currentTab === 'similar') loadSimilarGroups();
                }
            }
        } else {
            pipelineRefreshTicks = 0;
        }

        if (wasPipelineRunning && !st.is_running) {
            await loadStats();
            await loadGalleryFilters();
            refreshActiveMediaView();
            loadActivitiesHistory();
        }
        wasPipelineRunning = st.is_running;
    } catch (e) {}
}, 1000);

window.addEventListener('DOMContentLoaded', async () => {
    const savedTheme = localStorage.getItem('phototo_theme') || 'light';
    setAppTheme(savedTheme);
    const savedBlur = localStorage.getItem('phototo_ui_blur');
    setAppBlur(savedBlur !== 'off', false);
    await loadAppSettings();
    await loadLibrariesDropdown();
    await loadActivitiesHistory();
    await loadStats();
    await loadGalleryFilters();
    await loadGalleryItems();
    await loadGalleryTimeline();
});

