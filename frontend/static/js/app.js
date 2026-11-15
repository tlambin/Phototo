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

let pendingCreateLibFolder = '';
let pendingEditLibFolder = '';
let editMoveExistingContent = false;
let autoDupMode = 'KEEP_ONE';
let autoDupPriority = 'BEST_QUALITY';

// ==================== THÈME (CLAIR / SOMBRE / SYSTÈME) & BARRE MINIMISÉE ====================

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

    const lbl = document.getElementById('import-btn-label');
    const btn = document.getElementById('btn-top-import');
    const logoBox = document.getElementById('topbar-logo-box');
    const logoTxt = document.getElementById('topbar-logo-text');

    if (isMini) {
        if (lbl) lbl.classList.add('hidden');
        if (btn) btn.classList.replace('px-5', 'px-3');
        if (logoTxt) logoTxt.classList.add('hidden');
        if (logoBox) {
            logoBox.classList.replace('w-48', 'w-14');
            logoBox.classList.add('justify-center');
        }
    } else {
        if (lbl) lbl.classList.remove('hidden');
        if (btn) btn.classList.replace('px-3', 'px-5');
        if (logoTxt) logoTxt.classList.remove('hidden');
        if (logoBox) {
            logoBox.classList.replace('w-14', 'w-48');
            logoBox.classList.remove('justify-center');
        }
    }
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
            <span class="absolute bottom-2 right-2 bg-black/60 backdrop-blur-sm text-white text-[10px] font-extrabold px-2 py-0.5 rounded-full flex items-center gap-1 pointer-events-none">
                <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
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
let _ignoreScrollUntil = 0;
let _stickyScrollLastTop = 0;
let _stickyScrollDownDist = 0;

function syncTimelineWrapperBounds() {
    const wrapper = document.getElementById('gallery-timeline-wrapper');
    const header = document.getElementById('gallery-sticky-header');
    if (!wrapper) return;

    if (!header || !header.classList.contains('is-stuck') || header.classList.contains('is-scroll-hidden')) {
        wrapper.style.top = '0.5rem';
        wrapper.style.height = 'calc(100vh - 135px)';
        return;
    }

    const headerH = Math.ceil(header.getBoundingClientRect().height || 0);
    const topPx = headerH + 10;
    wrapper.style.top = `${topPx}px`;
    wrapper.style.height = `calc(100vh - ${topPx + 105}px)`;
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

function _setOptionsDrawerState(drawerId, btnId, visible) {
    const drawer = document.getElementById(drawerId);
    if (drawer) drawer.classList.toggle('hidden', !visible);
    const btn = document.getElementById(btnId);
    if (btn) {
        btn.classList.toggle('nav-item-active', visible);
        btn.classList.toggle('ui-card', !visible);
    }
}

function _openDrawerSafelyIfNearTop(headerId) {
    const scroller = document.getElementById('main-scroll-container');
    const header = document.getElementById(headerId);
    if (scroller && scroller.scrollTop > 0 && scroller.scrollTop <= 220) {
        scroller.scrollTop = 0;
        if (header) header.classList.remove('is-stuck', 'is-scroll-hidden');
    }
}

function toggleFilterBar() {
    const drawer = document.getElementById('filter-drawer');
    if (!drawer) return;
    const willShow = drawer.classList.contains('hidden');
    _galOptionsManuallyClosed = !willShow;
    _setOptionsDrawerState('filter-drawer', 'gal-options-btn', willShow);
    if (willShow) _openDrawerSafelyIfNearTop('gallery-sticky-header');
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

document.addEventListener('DOMContentLoaded', () => {
    const scroller = document.getElementById('main-scroll-container');
    if (!scroller) return;
    _stickyScrollLastTop = scroller.scrollTop || 0;
    _stickyScrollDownDist = 0;

    scroller.addEventListener('scroll', () => {
        const curTop = scroller.scrollTop || 0;
        const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const headers = document.querySelectorAll('.sticky-view-header');

        if (maxScroll < 180 || curTop <= 16) {
            _stickyScrollDownDist = 0;
            headers.forEach(h => h.classList.remove('is-stuck', 'is-scroll-hidden'));
            _stickyScrollLastTop = curTop;
            syncTimelineWrapperBounds();
            return;
        }

        if (Date.now() < _ignoreScrollUntil) {
            _stickyScrollLastTop = curTop;
            _stickyScrollDownDist = 0;
            return;
        }
        const delta = curTop - _stickyScrollLastTop;

        if (delta < 0) {
            _stickyScrollDownDist = 0;
            headers.forEach(h => {
                h.classList.add('is-stuck');
                h.classList.remove('is-scroll-hidden');
            });
        } else if (delta > 0) {
            _stickyScrollDownDist += delta;
            headers.forEach(h => {
                h.classList.add('is-stuck');
                if (curTop > 60 && _stickyScrollDownDist > 12) {
                    h.classList.add('is-scroll-hidden');
                }
            });
        }
        _stickyScrollLastTop = curTop;
        syncTimelineWrapperBounds();
    }, { passive: true });
    window.addEventListener('resize', syncTimelineWrapperBounds, { passive: true });
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

const ALL_TABS = ['gallery', 'albums', 'favorites', 'faces', 'map', 'types', 'tools', 'dups', 'similar', 'trash', 'activities', 'settings', 'search'];

function switchTab(tab) {
    currentTab = tab;
    ALL_TABS.forEach(t => {
        const btn = document.getElementById(`tab-btn-${t}`);
        if (btn) btn.classList.toggle('nav-item-active', t === tab);
        const panel = document.getElementById(`tab-${t}`);
        if (panel) panel.classList.toggle('hidden', t !== tab);
    });

    const tlBox = document.getElementById('gallery-timeline-box') || document.getElementById('timeline-scrubber');
    if (tlBox) tlBox.classList.toggle('hidden', tab !== 'gallery' && tab !== 'favorites');

    const titleEl = document.getElementById('gallery-main-title') || document.getElementById('gallery-main-heading');

    if (tab === 'favorites') {
        document.getElementById('tab-gallery').classList.remove('hidden');
        if (titleEl) titleEl.textContent = 'Favoris';
        document.getElementById('gal-fav').checked = true;
        currentExtFilter = '';
        resetAndLoadGallery();
    } else if (tab === 'gallery') {
        if (titleEl) titleEl.textContent = 'Galerie';
        document.getElementById('gal-fav').checked = false;
        currentExtFilter = '';
        resetAndLoadGallery();
    } else if (tab === 'albums') {
        closeSingleAlbumView();
    } else if (tab === 'faces') {
        loadPersons();
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
    } else if (tab === 'settings') {
        loadAppSettings();
    }
}

function setGalleryViewMode(mode) {
    galleryViewMode = mode;
    ['GRID', 'MONTH', 'DAY', 'MASONRY'].forEach(m => {
        const b = document.getElementById(`view-btn-${m}`);
        if (b) {
            b.className = (m === mode)
                ? "px-2.5 py-1 rounded-lg bg-[#593E5A] text-white"
                : "px-2.5 py-1 rounded-lg";
        }
    });
    refreshActiveMediaView();
}

function refreshActiveMediaView() {
    if (currentTab === 'albums' && openedAlbumName) {
        singleAlbumPage = 1;
        loadSingleAlbumItems();
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

async function runTask(taskCode) {
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

async function handlePipeActionButton() {
    if (latestPipelineState && latestPipelineState.is_running) {
        clientPausedTask = latestPipelineState.active_task || lastSeenActiveTask || 'INGEST';
        await fetch('/api/pipeline/stop?cancel=false', {method: 'POST'});
    } else {
        const resumeCode = (latestPipelineState && latestPipelineState.last_paused_task) || clientPausedTask || lastSeenActiveTask || 'INGEST';
        await runTask(resumeCode);
    }
}

const togglePauseResumeTask = handlePipeActionButton;

async function stopPipelineCompletely() {
    clientPausedTask = '';
    await fetch('/api/pipeline/stop?cancel=true', {method: 'POST'});
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

function renderNotificationsLists(notifs) {
    if (!notifs || !notifs.length) return;
    const unread = notifs.some(n => !n.read);
    const dot = document.getElementById('notif-unread-dot');
    if (dot) dot.classList.toggle('hidden', !unread);

    const html = notifs.map(n => {
        const badge = n.status === 'success' ? '✅' : (n.status === 'error' ? '❌' : '⏸️');
        return `
        <div class="ui-pill rounded-2xl p-3 flex items-start justify-between gap-2">
            <div>
                <div class="font-extrabold text-xs">${badge} ${n.title}</div>
                <div class="text-[11px] opacity-70 mt-0.5">${n.detail}</div>
            </div>
            <span class="text-[10px] font-mono opacity-60 shrink-0">${n.time}</span>
        </div>`;
    }).join('');

    const popList = document.getElementById('notif-popover-list');
    if (popList) popList.innerHTML = html;
    const fullList = document.getElementById('activities-full-list');
    if (fullList) fullList.innerHTML = html;
}

// ==================== PARAMÈTRES & MAINTENANCE ====================

async function loadAppSettings() {
    const res = await fetch('/api/settings');
    if (!res.ok) return;
    const d = await res.json();
    document.getElementById('settings-scanned-folders').value = (d.scanned_folders||[]).join('\n');
    document.getElementById('settings-takeout-dir').value = d.takeout_extract_dir || '';
    document.getElementById('settings-timezone').value = d.timezone || 'Europe/Paris';
    document.getElementById('settings-lang').value = d.language || 'fr';
    currentGpuMode = d.gpu_mode || 'auto';
    currentOcrEngine = d.ocr_engine || 'paddleocr';
    currentFacesModel = d.faces_model || 'buffalo_l';
    currentClipModel = d.clip_model || 'vit-b-32';
    ['auto', 'cuda', 'directml', 'cpu'].forEach(g => {
        const b = document.getElementById(`gpu-btn-${g}`);
        if (b) b.classList.toggle('nav-item-active', g === currentGpuMode);
    });
    loadHardwareInfo(false);
    loadAiModulesStatus();
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
            btn.textContent = '🔍 Rechercher des MÀJ';
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

async function saveAppSettingsQuiet() {
    await fetch('/api/settings/save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
            scanned_folders: document.getElementById('settings-scanned-folders').value.split('\n'),
            takeout_extract_dir: document.getElementById('settings-takeout-dir').value,
            timezone: document.getElementById('settings-timezone').value,
            language: document.getElementById('settings-lang').value || 'fr',
            gpu_mode: currentGpuMode,
            ocr_engine: currentOcrEngine,
            faces_model: currentFacesModel,
            clip_model: currentClipModel
        })
    });
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

async function restartApplication() {
    if (!confirm("Redémarrer Phototo maintenant ?")) return;
    await fetch('/api/system/restart', {method: 'POST'});
    setTimeout(() => window.location.reload(), 2000);
}

async function shutdownApplication() {
    if (!confirm("Arrêter complètement Phototo ?")) return;
    await fetch('/api/system/shutdown', {method: 'POST'});
    document.body.innerHTML = `<div class="h-screen flex items-center justify-center text-xl font-extrabold">🛑 Phototo est arrêté.</div>`;
}

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
        const effectivePausedTask = st.last_paused_task || clientPausedTask;
        const hasMissing = (st.missing_meta_files && st.missing_meta_files.length > 0);
        const showActivePanel = st.is_running || Boolean(effectivePausedTask) || hasMissing;

        const pulseBadge = document.getElementById('pulse-badge');
        if (pulseBadge) pulseBadge.classList.toggle('hidden', !st.is_running);
        const emptySt = document.getElementById('task-empty-state');
        if (emptySt) emptySt.classList.toggle('hidden', showActivePanel);
        const activeSt = document.getElementById('task-active-state');
        if (activeSt) activeSt.classList.toggle('hidden', !showActivePanel);

        if (showActivePanel) {
            document.getElementById('pop-step-title').textContent = st.current_step || 'Analyse en cours...';
            document.getElementById('pipe-bar').style.width = `${st.percent}%`;
            document.getElementById('pop-percent-text').textContent = `${st.percent} %`;

            document.getElementById('pop-files-pill').innerHTML = `${st.processed_items} / ${st.total_items}<br>fichiers`;
            const etaClean = (st.eta_text || '').replace('ETA: ', '') || '--:--';
            document.getElementById('pop-eta-pill').innerHTML = `Temps restant estimé<br>${etaClean}`;
            document.getElementById('pop-speed-pill').textContent = st.speed_text || '-- Mo/s';

            const dupsEta = document.getElementById('dups-eta-label');
            if (dupsEta) dupsEta.textContent = etaClean;
            const simsEta = document.getElementById('sims-eta-label');
            if (simsEta) simsEta.textContent = etaClean;

            document.getElementById('icon-pause-bars').classList.toggle('hidden', !st.is_running);
            document.getElementById('icon-play-triangle').classList.toggle('hidden', st.is_running);

            const warnBtn = document.getElementById('btn-task-warning');
            if (warnBtn) warnBtn.classList.toggle('hidden', !hasMissing);
            if (hasMissing) {
                document.getElementById('task-missing-meta-list').innerHTML = st.missing_meta_files
                    .slice(0, 30)
                    .map(p => `<div class="truncate">${p}</div>`)
                    .join('');
            }
        }

        if (st.logs && st.logs.length) {
            const box = document.getElementById('pipe-logs-box');
            if (box) {
                box.innerHTML = st.logs.map(l => `<div>${l}</div>`).join('');
                box.scrollTop = box.scrollHeight;
            }
        }

        if (st.is_running) {
            pipelineRefreshTicks++;
            if (pipelineRefreshTicks % 3 === 0) loadStats();
            if (pipelineRefreshTicks % 8 === 0) {
                const isLightboxOpen = !document.getElementById('lightbox-modal').classList.contains('hidden');
                if (!isLightboxOpen && selectedGalleryPaths.size === 0) {
                    if ((currentTab === 'gallery' || currentTab === 'favorites') && galleryPage === 1 && currentSkipOffset === 0) loadGalleryItems(false);
                    else if (currentTab === 'faces' && typeof selectedPersonIds !== 'undefined' && selectedPersonIds.size === 0) loadPersons();
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
        }
        wasPipelineRunning = st.is_running;
    } catch (e) {}
}, 1000);

window.addEventListener('DOMContentLoaded', async () => {
    const savedTheme = localStorage.getItem('phototo_theme') || 'light';
    setAppTheme(savedTheme);
    await loadAppSettings();
    await loadLibrariesDropdown();
    await loadStats();
    await loadGalleryFilters();
    await loadGalleryItems();
    await loadGalleryTimeline();
});

