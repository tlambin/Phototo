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
let autoDupExtraPriorities = [];

const AUTO_PRIORITY_CHOICES = [
    { value: 'BEST_QUALITY', label: 'La meilleure qualité' },
    { value: 'OLDEST', label: 'Le plus ancien' },
    { value: 'NEWEST', label: 'Le plus récent' },
    { value: 'LARGEST', label: 'Le plus gros' },
];

function pickNextUnusedPriority(usedPriorities) {
    const used = new Set(usedPriorities || []);
    const next = AUTO_PRIORITY_CHOICES.find(c => !used.has(c.value));
    return next ? next.value : null;
}

function renderExtraPriorityRows(containerId, addBtnId, priorities, onChangeCallbackName, onRemoveCallbackName, argLiteral) {
    const box = document.getElementById(containerId);
    const btn = document.getElementById(addBtnId);
    if (!box) return;
    box.innerHTML = (priorities || []).map((val, idx) => `
        <div class="flex items-center gap-1.5">
            <span class="text-[10px] font-bold opacity-60 shrink-0 w-11">Puis #${idx + 2}</span>
            <select data-extra-priority-idx="${idx}" onchange="${onChangeCallbackName}(${argLiteral}${argLiteral ? ', ' : ''}this)"
                    class="ui-card flex-1 min-w-0 rounded-full px-3 py-1 text-xs font-bold outline-none cursor-pointer">
                ${AUTO_PRIORITY_CHOICES.map(c => `<option value="${c.value}"${c.value === val ? ' selected' : ''}>${c.label}</option>`).join('')}
            </select>
            <button type="button" onclick="${onRemoveCallbackName}(${argLiteral}${argLiteral ? ', ' : ''}${idx})" title="Retirer cette priorité"
                    class="w-6 h-6 rounded-full ui-card hover:bg-rose-500/20 hover:text-rose-400 flex items-center justify-center text-[10px] font-extrabold shrink-0 cursor-pointer">✕</button>
        </div>
    `).join('');
    if (btn) btn.classList.toggle('hidden', (priorities || []).length >= (AUTO_PRIORITY_CHOICES.length - 1));
}

// ==================== THÈME (CLAIR / SOMBRE / SYSTÈME) & BARRE MINIMISÉE ====================

let currentUiBlur = true;
let currentUiStyle = 'glass';
let currentLightboxStyle = 'studio';
let currentUiThemeMode = 'light';
let currentUiOled = false;
let currentUiNoShadows = false;
let currentUiAccent = 'default';
let currentUiAccentCustom = '#6366f1';
let currentFavMatchAccent = false;
let currentTileRadius = 'rounded';
let currentGridGap = 'normal';
let currentReduceMotion = false;
const _UI_ACCENT_KEYS = ['default', 'slate', 'midnight', 'blue', 'custom'];

function _applyCustomAccentCssVars(hex) {
    const clean = /^#[0-9a-fA-F]{6}$/.test(String(hex || '').trim()) ? String(hex).trim() : '#6366f1';
    const r = parseInt(clean.slice(1, 3), 16);
    const g = parseInt(clean.slice(3, 5), 16);
    const b = parseInt(clean.slice(5, 7), 16);
    const lum = (0.299 * r) + (0.587 * g) + (0.114 * b);
    const root = document.documentElement.style;
    root.setProperty('--custom-accent', clean);
    root.setProperty('--custom-accent-rgb', `${r}, ${g}, ${b}`);
    root.setProperty('--custom-accent-text', lum > 165 ? '#18181B' : '#FFFFFF');
    const picker = document.getElementById('accent-custom-picker');
    if (picker && picker.value.toLowerCase() !== clean.toLowerCase()) picker.value = clean;
}

function setAppCustomAccentColor(hex, persist = true) {
    const clean = /^#[0-9a-fA-F]{6}$/.test(String(hex || '').trim()) ? String(hex).trim() : '#6366f1';
    currentUiAccentCustom = clean;
    localStorage.setItem('phototo_accent_custom', clean);
    _applyCustomAccentCssVars(clean);
    setAppAccent('custom', persist);
}

function setAppAccent(accent, persist = true) {
    const key = _UI_ACCENT_KEYS.includes(String(accent || '').toLowerCase()) ? String(accent).toLowerCase() : 'default';
    currentUiAccent = key;
    localStorage.setItem('phototo_accent', key);
    if (key === 'custom') _applyCustomAccentCssVars(currentUiAccentCustom);
    document.documentElement.setAttribute('data-accent', key);
    _UI_ACCENT_KEYS.forEach(k => {
        const b = document.getElementById(`accent-btn-${k}`);
        if (b) b.classList.toggle('nav-item-active', k === key);
    });
    if (persist && typeof saveAppSettingsQuiet === 'function') {
        saveAppSettingsQuiet();
    }
}

function setAppStyle(style, persist = true) {
    const raw = String(style || '').toLowerCase();
    if (raw === 'flat') {
        setAppNoShadows(true, false);
    }
    const s = (raw === 'solid') ? 'solid' : 'glass';
    currentUiStyle = s;
    currentUiBlur = (s === 'glass');
    localStorage.setItem('phototo_ui_style', s);
    localStorage.setItem('phototo_ui_blur', currentUiBlur ? 'on' : 'off');
    document.documentElement.setAttribute('data-style', s);
    document.documentElement.setAttribute('data-blur', currentUiBlur ? 'on' : 'off');
    const bGlass = document.getElementById('style-btn-glass');
    const bSolid = document.getElementById('style-btn-solid');
    if (bGlass) bGlass.classList.toggle('nav-item-active', s === 'glass');
    if (bSolid) bSolid.classList.toggle('nav-item-active', s === 'solid');
    if (persist && typeof saveAppSettingsQuiet === 'function') {
        saveAppSettingsQuiet();
    }
}

function setAppBlur(enabled, persist = true) {
    setAppStyle(enabled ? 'glass' : 'solid', persist);
}

function setAppLightboxStyle(mode, persist = true) {
    const s = (String(mode || '').toLowerCase() === 'classic') ? 'classic' : 'studio';
    currentLightboxStyle = s;
    localStorage.setItem('phototo_lightbox_style', s);
    document.documentElement.setAttribute('data-lightbox-style', s);
    ['studio', 'classic'].forEach(k => {
        const b = document.getElementById(`lbstyle-btn-${k}`);
        if (b) b.classList.toggle('nav-item-active', k === s);
    });
    if (typeof syncLightboxInfoButtonState === 'function') {
        syncLightboxInfoButtonState();
    }
    if (persist && typeof saveAppSettingsQuiet === 'function') {
        saveAppSettingsQuiet();
    }
}

function setAppNoShadows(disabled, persist = true) {
    currentUiNoShadows = Boolean(disabled);
    localStorage.setItem('phototo_no_shadows', currentUiNoShadows ? 'off' : 'on');
    document.documentElement.setAttribute('data-shadows', currentUiNoShadows ? 'off' : 'on');
    const cb = document.getElementById('shadows-off-toggle');
    if (cb) cb.checked = currentUiNoShadows;
    if (persist && typeof saveAppSettingsQuiet === 'function') {
        saveAppSettingsQuiet();
    }
}

function setAppFavMatchAccent(enabled, persist = true) {
    currentFavMatchAccent = Boolean(enabled);
    localStorage.setItem('phototo_fav_match_accent', currentFavMatchAccent ? 'on' : 'off');
    document.documentElement.setAttribute('data-fav-accent', currentFavMatchAccent ? 'on' : 'off');
    const onBtn = document.getElementById('fav-accent-btn-on');
    const offBtn = document.getElementById('fav-accent-btn-off');
    if (onBtn) onBtn.classList.toggle('nav-item-active', currentFavMatchAccent);
    if (offBtn) offBtn.classList.toggle('nav-item-active', !currentFavMatchAccent);
    if (persist && typeof saveAppSettingsQuiet === 'function') {
        saveAppSettingsQuiet();
    }
}

function setAppTileRadius(mode, persist = true) {
    const r = ['rounded', 'soft', 'square'].includes(mode) ? mode : 'rounded';
    currentTileRadius = r;
    localStorage.setItem('phototo_tile_radius', r);
    document.documentElement.setAttribute('data-radius', r);
    ['rounded', 'soft', 'square'].forEach(k => {
        const b = document.getElementById(`radius-btn-${k}`);
        if (b) b.classList.toggle('nav-item-active', k === r);
    });
    if (persist && typeof saveAppSettingsQuiet === 'function') {
        saveAppSettingsQuiet();
    }
}

function setAppGridGap(mode, persist = true) {
    const g = ['tight', 'normal', 'airy'].includes(mode) ? mode : 'normal';
    currentGridGap = g;
    localStorage.setItem('phototo_grid_gap', g);
    document.documentElement.setAttribute('data-gap', g);
    ['tight', 'normal', 'airy'].forEach(k => {
        const b = document.getElementById(`gap-btn-${k}`);
        if (b) b.classList.toggle('nav-item-active', k === g);
    });
    if (persist && typeof saveAppSettingsQuiet === 'function') {
        saveAppSettingsQuiet();
    }
}

function setAppReduceMotion(enabled, persist = true) {
    currentReduceMotion = Boolean(enabled);
    localStorage.setItem('phototo_reduce_motion', currentReduceMotion ? 'off' : 'on');
    document.documentElement.setAttribute('data-motion', currentReduceMotion ? 'off' : 'on');
    const onBtn = document.getElementById('motion-btn-on');
    const offBtn = document.getElementById('motion-btn-off');
    if (onBtn) onBtn.classList.toggle('nav-item-active', !currentReduceMotion);
    if (offBtn) offBtn.classList.toggle('nav-item-active', currentReduceMotion);
    if (persist && typeof saveAppSettingsQuiet === 'function') {
        saveAppSettingsQuiet();
    }
}

function setAppTheme(mode) {
    let normalized = String(mode || 'light').toLowerCase();
    if (normalized === 'oled') {
        normalized = 'dark';
        currentUiOled = true;
        localStorage.setItem('phototo_oled', 'on');
    }
    if (!['light', 'dark', 'system'].includes(normalized)) {
        normalized = 'light';
    }
    currentUiThemeMode = normalized;
    localStorage.setItem('phototo_theme', normalized);
    let effective = normalized;
    if (normalized === 'system') {
        effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    if (effective === 'dark' && currentUiOled) {
        effective = 'oled';
    }
    document.documentElement.setAttribute('data-theme', effective);
    ['light', 'dark', 'system'].forEach(m => {
        const b = document.getElementById(`theme-btn-${m}`);
        if (b) b.classList.toggle('nav-item-active', m === normalized);
    });
    const oledCb = document.getElementById('theme-oled-toggle');
    if (oledCb) oledCb.checked = currentUiOled;
}

function setAppOled(enabled, persist = true) {
    currentUiOled = Boolean(enabled);
    localStorage.setItem('phototo_oled', currentUiOled ? 'on' : 'off');
    setAppTheme(currentUiThemeMode);
    if (persist && typeof saveAppSettingsQuiet === 'function') {
        saveAppSettingsQuiet();
    }
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

function formatTime(ts) {
    if (!ts || ts === 0) return '';
    return new Date(ts * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDateTime(ts) {
    if (!ts || ts === 0) return 'Date inconnue';
    return `${formatDate(ts)} · ${formatTime(ts)}`;
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
let _placesOptionsManuallyClosed = false;
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
    if (currentTab === 'map' && typeof _openedPlaceBucketIdx !== 'undefined' && _openedPlaceBucketIdx >= 0) {
        return { headerId: 'place-single-sticky-header', drawerId: 'filter-drawer', btnId: 'place-single-options-btn' };
    }
    const mapOverview = document.getElementById('map-overview-panel');
    if (currentTab === 'map' && mapOverview && !mapOverview.classList.contains('hidden')) {
        return { headerId: 'places-sticky-header', drawerId: 'places-options-drawer', btnId: 'places-options-btn' };
    }
    const typesOverview = document.getElementById('types-overview-panel');
    if (currentTab === 'types' && typesOverview && !typesOverview.classList.contains('hidden')) {
        return { headerId: 'types-sticky-header', drawerId: 'types-options-drawer', btnId: 'types-options-btn' };
    }
    if (currentTab === 'dups') {
        return { headerId: 'dups-sticky-header', drawerId: 'dups-options-drawer', btnId: 'dups-options-btn' };
    }
    if (currentTab === 'similar') {
        return { headerId: 'similar-sticky-header', drawerId: 'similar-options-drawer', btnId: 'similar-options-btn' };
    }
    if (currentTab === 'trash') {
        return { headerId: 'trash-sticky-header', drawerId: 'trash-options-drawer', btnId: 'trash-options-btn' };
    }
    if (String(currentTab || '').startsWith('sug-')) {
        return { headerId: 'sug-sticky-header', drawerId: 'sug-options-drawer', btnId: 'sug-options-btn' };
    }
    if (currentTab === 'favorites') {
        return { headerId: 'favorites-sticky-header', drawerId: 'filter-drawer', btnId: 'fav-options-btn' };
    }
    if (currentTab === 'gallery' || currentTab === 'recent') {
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
    else if (ctx.drawerId === 'places-options-drawer') togglePlacesOptionsBar();
    else if (ctx.drawerId === 'types-options-drawer') toggleTypesOptionsBar();
    else if (ctx.drawerId === 'dups-options-drawer') toggleDupsOptionsBar();
    else if (ctx.drawerId === 'similar-options-drawer') toggleSimilarOptionsBar();
    else if (ctx.drawerId === 'trash-options-drawer') toggleTrashOptionsBar();
    else if (ctx.drawerId === 'sug-options-drawer') toggleSugOptionsBar();
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
    if (typeof renderCustomGroupsBar === 'function') {
        if (drawerId === 'albums-options-drawer') renderCustomGroupsBar('albums');
        else if (drawerId === 'faces-options-drawer') renderCustomGroupsBar('persons');
        else if (drawerId === 'places-options-drawer') renderCustomGroupsBar('places');
        else if (drawerId === 'filter-drawer' && currentTab === 'favorites') renderCustomGroupsBar('favorites');
    }
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
    if (currentTab === 'favorites') {
        targetHeader = document.getElementById('favorites-sticky-header') || targetHeader;
    } else if (willShow) {
        if (currentTab === 'albums' && typeof openedAlbumName !== 'undefined' && openedAlbumName) {
            targetHeader = document.getElementById('album-single-sticky-header') || targetHeader;
        } else if (currentTab === 'faces' && typeof currentTimelinePersonId !== 'undefined' && currentTimelinePersonId !== null) {
            targetHeader = document.getElementById('person-single-sticky-header') || targetHeader;
        } else if (currentTab === 'map' && typeof _openedPlaceBucketIdx !== 'undefined' && _openedPlaceBucketIdx >= 0) {
            targetHeader = document.getElementById('place-single-sticky-header') || targetHeader;
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

function togglePlacesOptionsBar() {
    const drawer = document.getElementById('places-options-drawer');
    if (!drawer) return;
    const willShow = drawer.classList.contains('hidden');
    _placesOptionsManuallyClosed = !willShow;
    _setOptionsDrawerState('places-options-drawer', 'places-options-btn', willShow);
    if (willShow) _openDrawerSafelyIfNearTop('places-sticky-header');
    _syncScrollAfterLayoutToggle();
}

function _toggleSimpleOptionsBar(drawerId, btnId, headerId) {
    const drawer = document.getElementById(drawerId);
    if (!drawer) return;
    const willShow = drawer.classList.contains('hidden');
    _setOptionsDrawerState(drawerId, btnId, willShow);
    if (willShow) _openDrawerSafelyIfNearTop(headerId);
    _syncScrollAfterLayoutToggle();
}

function toggleDupsOptionsBar() {
    _toggleSimpleOptionsBar('dups-options-drawer', 'dups-options-btn', 'dups-sticky-header');
}

function toggleSimilarOptionsBar() {
    _toggleSimpleOptionsBar('similar-options-drawer', 'similar-options-btn', 'similar-sticky-header');
}

function toggleTrashOptionsBar() {
    _toggleSimpleOptionsBar('trash-options-drawer', 'trash-options-btn', 'trash-sticky-header');
}

function toggleSugOptionsBar() {
    _toggleSimpleOptionsBar('sug-options-drawer', 'sug-options-btn', 'sug-sticky-header');
}

function toggleTypesOptionsBar() {
    _toggleSimpleOptionsBar('types-options-drawer', 'types-options-btn', 'types-sticky-header');
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
                _setOptionsDrawerState('places-options-drawer', 'places-options-btn', false);
                _setOptionsDrawerState('dups-options-drawer', 'dups-options-btn', false);
                _setOptionsDrawerState('similar-options-drawer', 'similar-options-btn', false);
                _setOptionsDrawerState('sug-options-drawer', 'sug-options-btn', false);
                _setOptionsDrawerState('types-options-drawer', 'types-options-btn', false);
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

const ALL_TABS = ['gallery', 'recent', 'albums', 'favorites', 'faces', 'map', 'types', 'stats', 'tools', 'suggestion-page', 'dups', 'similar', 'trash', 'activities', 'settings', 'search'];
let _wasRecentTab = false;

function switchTab(tab) {
    if ((currentTab === 'gallery' || currentTab === 'favorites' || currentTab === 'recent') && typeof saveMediaTabState === 'function') {
        saveMediaTabState(currentTab);
    }
    currentTab = tab;
    const isSugPage = String(tab || '').startsWith('sug-');
    const isToolsChild = isSugPage || tab === 'dups' || tab === 'similar';
    ALL_TABS.forEach(t => {
        const btn = document.getElementById(`tab-btn-${t}`);
        if (btn) btn.classList.toggle('nav-item-active', t === tab || (tab === 'recent' && t === 'activities') || (isToolsChild && t === 'tools'));
        const panel = document.getElementById(`tab-${t}`);
        if (panel) panel.classList.toggle('hidden', t !== (isSugPage ? 'suggestion-page' : tab));
    });
    if (!isSugPage) {
        document.getElementById('sug-batch-bar')?.classList.add('hidden');
    }

    const tlWrap = document.getElementById('gallery-timeline-wrapper');
    const tlBox = document.getElementById('gallery-timeline-box') || document.getElementById('timeline-scrubber');
    const hideTl = (tab !== 'gallery' && tab !== 'recent');
    document.body.classList.toggle('has-gallery-timeline', !hideTl);
    if (tlWrap) tlWrap.classList.toggle('!hidden', hideTl);
    if (tlBox) tlBox.classList.toggle('hidden', hideTl);

    const titleEl = document.getElementById('gallery-main-title') || document.getElementById('gallery-main-heading');
    const sortByEl = document.getElementById('gal-sort-by');
    const sortOrdEl = document.getElementById('gal-sort-order');

    if (tab === 'favorites') {
        _wasRecentTab = false;
        document.getElementById('tab-favorites')?.classList.remove('hidden');
        _mountFilterDrawerForActiveView(false);
        document.getElementById('gal-fav').checked = true;
        currentExtFilter = '';
        if (typeof syncActiveMediaPrefsFromStorage === 'function') syncActiveMediaPrefsFromStorage('favorites');
        if (typeof applyPageDefaultOptions === 'function') applyPageDefaultOptions('favorites', false);
        if (typeof loadCustomGroups === 'function') loadCustomGroups('favorites');
        resetAndLoadGallery();
    } else if (tab === 'recent') {
        _wasRecentTab = true;
        document.getElementById('tab-gallery').classList.remove('hidden');
        _mountFilterDrawerForActiveView(false);
        if (titleEl) titleEl.textContent = 'Ajoutés récemment';
        document.getElementById('gal-fav').checked = false;
        if (sortByEl) sortByEl.value = 'added';
        if (sortOrdEl) sortOrdEl.value = 'desc';
        const arrow = document.getElementById('gal-sort-arrow');
        if (arrow) arrow.style.transform = 'rotate(0deg)';
        currentExtFilter = '';
        if (typeof syncActiveMediaPrefsFromStorage === 'function') syncActiveMediaPrefsFromStorage('recent');
        if (typeof applyPageDefaultOptions === 'function') applyPageDefaultOptions('recent', false);
        resetAndLoadGallery();
    } else if (tab === 'gallery') {
        if (titleEl) titleEl.textContent = 'Galerie';
        _mountFilterDrawerForActiveView(false);
        document.getElementById('gal-fav').checked = false;
        if (_wasRecentTab && sortByEl && sortByEl.value === 'added') {
            sortByEl.value = 'date';
        }
        _wasRecentTab = false;
        currentExtFilter = '';
        if (typeof syncActiveMediaPrefsFromStorage === 'function') syncActiveMediaPrefsFromStorage('gallery');
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
        _mountFilterDrawerForActiveView(false);
        if (typeof applyPageDefaultOptions === 'function') applyPageDefaultOptions('places', false);
        loadWorldMap(false);
    } else if (tab === 'types') {
        if (typeof applyPageDefaultOptions === 'function') applyPageDefaultOptions('types', false);
        loadTypesSummary();
    } else if (tab === 'stats') {
        if (typeof loadStatsPage === 'function') loadStatsPage();
    } else if (tab === 'tools') {
        loadStats();
        loadToolsSuggestionsSummary();
    } else if (isSugPage) {
        if (typeof openSuggestionPage === 'function') openSuggestionPage(String(tab).slice(4), true);
    } else if (tab === 'dups') {
        if (typeof applyPageDefaultOptions === 'function') applyPageDefaultOptions('dups', false);
        loadDuplicates();
    } else if (tab === 'similar') {
        if (typeof applyPageDefaultOptions === 'function') applyPageDefaultOptions('similar', false);
        loadSimilarGroups();
    } else if (tab === 'trash') {
        if (typeof applyPageDefaultOptions === 'function') applyPageDefaultOptions('trash', false);
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
    } else if (currentTab === 'map' && typeof _openedPlaceBucketIdx !== 'undefined' && _openedPlaceBucketIdx >= 0) {
        openSinglePlaceView(_openedPlaceBucketIdx);
    } else if (currentTab === 'trash' && typeof loadTrashTab === 'function') {
        loadTrashTab();
    } else if (currentTab === 'types') {
        if (typeof _openedCategoryId !== 'undefined' && _openedCategoryId !== null && typeof openSingleCategoryView === 'function') {
            openSingleCategoryView(_openedCategoryId);
        } else {
            loadTypesSummary();
        }
    } else if (currentTab === 'stats' && typeof loadStatsPage === 'function') {
        loadStatsPage();
    } else if (String(currentTab || '').startsWith('sug-') && typeof openSuggestionPage === 'function') {
        openSuggestionPage(String(currentTab).slice(4), true);
    } else {
        if (typeof saveMediaTabState === 'function') saveMediaTabState();
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

let _appToastTimer = null;

function showAppToast(message, tone = 'info', durationMs = 5500) {
    const host = document.getElementById('app-toast');
    if (!host || !message) return;
    if (_appToastTimer) {
        clearTimeout(_appToastTimer);
        _appToastTimer = null;
    }
    const accentCls = tone === 'error'
        ? 'border-rose-500/40 text-rose-400'
        : (tone === 'success' ? 'border-emerald-500/40 text-emerald-400' : 'border-sky-500/35 text-sky-400');
    const iconSvg = tone === 'error'
        ? '<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
        : '<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';

    host.innerHTML = `
        <div class="ui-card border ${accentCls} rounded-full px-4 py-2.5 shadow-2xl flex items-center gap-2.5 text-xs font-extrabold">
            ${iconSvg}
            <span class="text-[var(--text-main)]">${escapeHtml(message)}</span>
            <button type="button" onclick="hideAppToast()" title="Fermer"
                    class="w-5 h-5 rounded-full hover:bg-[var(--bg-hover)] text-[var(--text-main)] opacity-70 hover:opacity-100 flex items-center justify-center text-[10px] shrink-0 cursor-pointer">✕</button>
        </div>`;
    host.classList.remove('hidden');
    if (durationMs > 0) {
        _appToastTimer = setTimeout(hideAppToast, durationMs);
    }
}

function hideAppToast() {
    const host = document.getElementById('app-toast');
    if (host) host.classList.add('hidden');
    if (_appToastTimer) {
        clearTimeout(_appToastTimer);
        _appToastTimer = null;
    }
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
            showAppToast(err.detail || "Impossible de démarrer la tâche.", 'error');
        } catch (e) {}
        return;
    }
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (data.status === 'nothing_to_do') {
        showAppToast(data.message || "Aucune analyse nécessaire : tous vos médias ont déjà été analysés.", 'info');
        loadStats();
        return;
    }
    if (data.status === 'already_running') {
        showAppToast(`Une analyse est déjà en cours (${data.active_task || 'tâche active'}).`, 'info');
        return;
    }
    _revealAnalysisProgressCard(taskCode);
    if (ANALYSIS_PROGRESS_CARDS[taskCode]) {
        setTimeout(() => {
            if (!latestPipelineState || !latestPipelineState.is_running) loadStats();
        }, 1200);
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

const ANALYSIS_PROGRESS_CARDS = {
    DEDUP: {cardId: 'dups-progress-card', titleId: 'dups-status-title', barId: 'cov-bar-dedup', pctId: 'cov-pct-dedup', labelId: 'cov-label-dedup', covKey: 'dedup'},
    SIMILAR: {cardId: 'similar-progress-card', titleId: 'similar-status-title', barId: 'cov-bar-similar', pctId: 'cov-pct-similar', labelId: 'cov-label-similar', covKey: 'similar'},
};

function _revealAnalysisProgressCard(taskCode) {
    const cfg = ANALYSIS_PROGRESS_CARDS[taskCode];
    if (!cfg) return;
    const card = document.getElementById(cfg.cardId);
    if (card) card.classList.remove('hidden');
    const titleEl = document.getElementById(cfg.titleId);
    if (titleEl) titleEl.textContent = 'Analyse en cours...';
}

function _syncAnalysisProgressCard(taskCode, cov) {
    const cfg = ANALYSIS_PROGRESS_CARDS[taskCode];
    if (!cfg || !cov) return;
    const barEl = document.getElementById(cfg.barId);
    if (!barEl) return;

    const total = Number(cov.total || 0);
    const done = Number(cov.done || 0);
    const pct = Number(cov.percent || 0);
    const isRunning = Boolean(latestPipelineState && latestPipelineState.is_running && latestPipelineState.active_task === taskCode);
    const isFinished = !isRunning && (pct >= 100 || (total > 0 && done >= total));

    barEl.style.width = `${pct}%`;
    const pctEl = document.getElementById(cfg.pctId);
    if (pctEl) pctEl.textContent = `${pct} %`;
    const labelEl = document.getElementById(cfg.labelId);
    if (labelEl) labelEl.innerHTML = `${done} / ${total}<br><span class="font-semibold opacity-75">fichiers analysés</span>`;
    const titleEl = document.getElementById(cfg.titleId);
    if (titleEl) titleEl.textContent = isFinished ? 'Analyse terminée' : ((isRunning || (total > 0 && done > 0)) ? 'Analyse en cours...' : 'Prêt pour analyse');

    const card = document.getElementById(cfg.cardId);
    if (card) card.classList.toggle('hidden', !isRunning && (isFinished || total === 0));
}

async function loadStats() {
    const res = await fetch('/api/stats');
    if (!res.ok) return;
    const d = await res.json();
    const stInd = document.getElementById('st-indexed');
    if (stInd) stInd.textContent = d.indexed || 0;
    const gbEl = document.getElementById('st-gb');
    if (gbEl && d.total_gb !== undefined) gbEl.textContent = String(d.total_gb).replace('.', ',');

    const toolsPill = document.getElementById('tools-summary-pill');
    const nb = Number(d.indexed || 0);
    const gbStr = String(d.total_gb ?? '0,00').replace('.', ',');
    if (toolsPill) toolsPill.textContent = `${nb} média${nb > 1 ? 's' : ''} · ${gbStr} Go`;

    const statsPill = document.getElementById('stats-summary-pill');
    if (statsPill) statsPill.textContent = `${nb} média${nb > 1 ? 's' : ''} · ${gbStr} Go`;
    const kpiInd = document.getElementById('stats-kpi-indexed');
    if (kpiInd) kpiInd.textContent = nb;
    const kpiGb = document.getElementById('stats-kpi-gb');
    if (kpiGb) kpiGb.textContent = `${gbStr} Go`;
    const kpiFav = document.getElementById('stats-kpi-favorites');
    if (kpiFav) kpiFav.textContent = Number(d.favorites || 0);
    const kpiPer = document.getElementById('stats-kpi-persons');
    if (kpiPer) kpiPer.textContent = Number(d.persons || 0);
    const kpiTr = document.getElementById('stats-kpi-trash');
    if (kpiTr) kpiTr.textContent = Number(d.trashed || 0);
    if (typeof renderStatsCoverage === 'function') renderStatsCoverage(d);

    const stDups = document.getElementById('st-dups');
    if (stDups) stDups.textContent = d.duplicates || 0;
    const dupsBan = document.getElementById('dups-count-banner');
    if (dupsBan) dupsBan.textContent = d.duplicates || 0;

    const simCount = d.similar_count !== undefined ? d.similar_count : 0;
    const stSims = document.getElementById('st-sims');
    if (stSims) stSims.textContent = simCount;
    const simsBan = document.getElementById('sims-count-banner');
    if (simsBan) simsBan.textContent = simCount;

    const toolsOcr = document.getElementById('tools-ocr-count');
    if (toolsOcr) toolsOcr.textContent = d.ocr_count || 0;
    const toolsPersons = document.getElementById('tools-persons-count');
    if (toolsPersons) toolsPersons.textContent = d.persons || 0;

    const mm = document.getElementById('st-missing-meta');
    if (mm && d.missing_meta !== undefined) mm.textContent = d.missing_meta;
    const mmPill = document.getElementById('tools-missing-meta-pill');
    if (mmPill) mmPill.classList.toggle('text-amber-400', Number(d.missing_meta || 0) > 0);

    if (d.coverage) {
        Object.entries(ANALYSIS_PROGRESS_CARDS).forEach(([taskCode, cfg]) => {
            _syncAnalysisProgressCard(taskCode, d.coverage[cfg.covKey]);
        });
        ['dedup', 'similar', 'ocr', 'clip', 'faces'].forEach(covKey => {
            const cov = d.coverage[covKey];
            if (!cov) return;
            const done = Number(cov.done || 0);
            const total = Number(cov.total || 0);
            const pct = Number(cov.percent || 0);
            const barEl = document.getElementById(`tools-cov-bar-${covKey}`);
            if (barEl) barEl.style.width = `${pct}%`;
            const txtEl = document.getElementById(`tools-cov-text-${covKey}`);
            if (txtEl) txtEl.textContent = `${done} / ${total} (${pct} %)`;
            const pctEl = document.getElementById(`tools-cov-pct-${covKey}`);
            if (pctEl) pctEl.textContent = `${pct} %`;
        });
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

const ACTIVITY_GROUP_OPS = new Set(['INGEST', 'UNZIP', 'IMPORT', 'METADATA', 'MEDIA_ROTATE', 'MEDIA_GPS']);
const ACTIVITY_GROUP_AI = new Set(['FACES', 'OCR', 'DEDUP', 'SIMILAR', 'CLIP', 'AI_REINDEX', 'BLUR', 'ROTATION', 'SUGGESTIONS']);
const RESUMABLE_ACTIVITY_TYPES = new Set(['INGEST', 'UNZIP', 'IMPORT', 'METADATA', 'FACES', 'OCR', 'DEDUP', 'SIMILAR', 'CLIP', 'BLUR', 'ROTATION', 'SUGGESTIONS']);

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
    if (d.ui_oled !== undefined) {
        setAppOled(Boolean(d.ui_oled), false);
    }
    if (d.ui_no_shadows !== undefined) {
        setAppNoShadows(Boolean(d.ui_no_shadows), false);
    }
    if (d.ui_style !== undefined) {
        setAppStyle(d.ui_style || 'glass', false);
    } else if (d.ui_blur !== undefined) {
        setAppBlur(d.ui_blur !== false, false);
    }
    if (d.ui_lightbox_style !== undefined) {
        setAppLightboxStyle(d.ui_lightbox_style || 'studio', false);
    }
    if (d.ui_accent_custom !== undefined) {
        currentUiAccentCustom = d.ui_accent_custom || '#6366f1';
        _applyCustomAccentCssVars(currentUiAccentCustom);
    }
    if (d.ui_accent !== undefined) {
        setAppAccent(d.ui_accent || 'default', false);
    }
    if (d.ui_fav_match_accent !== undefined) {
        setAppFavMatchAccent(Boolean(d.ui_fav_match_accent), false);
    }
    if (d.ui_tile_radius !== undefined) {
        setAppTileRadius(d.ui_tile_radius || 'rounded', false);
    }
    if (d.ui_grid_gap !== undefined) {
        setAppGridGap(d.ui_grid_gap || 'normal', false);
    }
    if (d.ui_reduce_motion !== undefined) {
        setAppReduceMotion(Boolean(d.ui_reduce_motion), false);
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
        ui_blur: currentUiBlur,
        ui_style: currentUiStyle,
        ui_lightbox_style: currentLightboxStyle,
        ui_oled: currentUiOled,
        ui_no_shadows: currentUiNoShadows,
        ui_accent: currentUiAccent,
        ui_accent_custom: currentUiAccentCustom,
        ui_fav_match_accent: currentFavMatchAccent,
        ui_tile_radius: currentTileRadius,
        ui_grid_gap: currentGridGap,
        ui_reduce_motion: currentReduceMotion
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
    const btn = document.getElementById('btn-prune-missing');
    if (btn) {
        btn.disabled = true;
        btn.textContent = "Nettoyage...";
    }
    try {
        const res = await fetch('/api/database/prune_missing', {method: 'POST'});
        if (res.ok) {
            const d = await res.json();
            await loadStats(); await loadGalleryFilters(); refreshActiveMediaView();
            const msg = `Nettoyage terminé : ${d.removed_count} entrée(s) obsolète(s) supprimée(s).`;
            if (typeof showAppToast === 'function') showAppToast(msg, 'success');
            else alert(msg);
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = "Nettoyer les fichiers introuvables";
        }
    }
}

async function retryMissingMetadataNow() {
    const btn = document.getElementById('btn-retry-meta');
    const origBtnLbl = btn ? btn.textContent : 'Analyser';
    if (btn) {
        btn.disabled = true;
        btn.textContent = "Récupération en cours...";
    }
    try {
        const res = await fetch('/api/metadata/retry_recovery', {method: 'POST'});
        if (res.ok) {
            const d = await res.json();
            await loadStats(); await loadGalleryFilters(); refreshActiveMediaView();
            if (typeof loadToolsSuggestionsSummary === 'function') loadToolsSuggestionsSummary();
            const msg = `Récupération terminée : ${d.repaired} fichier(s) reclassé(s), ${d.still_missing} restant(s).`;
            if (typeof showAppToast === 'function') showAppToast(msg, 'success');
            else alert(msg);
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = origBtnLbl;
        }
    }
}

// ==================== OUTILS IA & SUGGESTIONS INTELLIGENTES ====================

let _toolsThumbVersion = 0;

function getSugToolSettings() {
    const defaults = { blurThreshold: 45, largeMinMb: 10, ageDays: 90, gpsGapHours: 6 };
    try {
        const raw = localStorage.getItem('phototo_sug_settings');
        if (!raw) return defaults;
        return { ...defaults, ...JSON.parse(raw) };
    } catch (_) {
        return defaults;
    }
}

function saveSugToolSettings(patch) {
    const next = { ...getSugToolSettings(), ...(patch || {}) };
    try {
        localStorage.setItem('phototo_sug_settings', JSON.stringify(next));
    } catch (_) {}
    return next;
}

const SUG_TOOL_META = {
    albums: {
        title: 'Albums & Événements',
        unit: 'suggestion',
        analyzeLabel: 'Actualiser',
        analyzeTask: null,
        batchPrimaryLabel: 'Ajouter aux albums suggérés',
        supportsTrash: false,
    },
    rotation: {
        title: 'Rotation suggérée',
        unit: 'photo',
        analyzeLabel: 'Analyser',
        analyzeTask: 'ROTATION',
        batchPrimaryLabel: 'Appliquer les rotations',
        supportsTrash: false,
    },
    blurry: {
        title: 'Qualité : Flou & Exposition',
        unit: 'photo',
        analyzeLabel: 'Analyser',
        analyzeTask: 'BLUR',
        batchPrimaryLabel: null,
        supportsTrash: true,
    },
    missing_gps: {
        title: 'Lieux manquants (GPS)',
        unit: 'média',
        analyzeLabel: 'Actualiser',
        analyzeTask: null,
        batchPrimaryLabel: 'Appliquer les lieux suggérés',
        supportsTrash: false,
    },
    people: {
        title: 'Personnes à trier',
        unit: 'suggestion',
        analyzeLabel: 'Analyser',
        analyzeTask: 'FACES',
        batchPrimaryLabel: null,
        supportsTrash: false,
    },
    screenshots: {
        title: 'Captures & Documents',
        unit: 'fichier',
        analyzeLabel: 'Analyser OCR',
        analyzeTask: 'OCR',
        batchPrimaryLabel: 'Classer dans « Documents »',
        supportsTrash: true,
    },
    large: {
        title: 'Stockage & Courtes',
        unit: 'fichier',
        analyzeLabel: 'Actualiser',
        analyzeTask: null,
        batchPrimaryLabel: null,
        supportsTrash: true,
    },
    missing_meta: {
        title: 'Sans métadonnées',
        unit: 'fichier',
        analyzeLabel: 'Réparer les dates',
        analyzeTask: 'REPAIR_META',
        batchPrimaryLabel: null,
        supportsTrash: true,
    },
};

let _sugPageState = {
    kind: 'albums',
    items: [],
    sortedItems: [],
    newEvents: [],
    previewEventIdx: null,
    peopleData: null,
    serverMeta: {},
    selected: new Set(),
    lastIdx: null,
    layout: 'GRID',
    size: 'MD',
};

function _syncToolsSuggestionsProgressCard(st) {
    const active = st && st.active_task;
    const isToolsSug = Boolean(st && st.is_running && (active === 'BLUR' || active === 'ROTATION' || active === 'SUGGESTIONS'));
    const hubCard = document.getElementById('tools-sug-progress-card');
    if (hubCard) {
        hubCard.classList.toggle('hidden', !isToolsSug);
        if (isToolsSug) {
            const titleEl = document.getElementById('tools-sug-status-title');
            const metaEl = document.getElementById('tools-sug-progress-meta');
            const barEl = document.getElementById('tools-sug-progress-bar');
            if (titleEl) titleEl.textContent = st.current_step || 'Analyse en cours...';
            const pct = Math.max(0, Math.min(100, Number(st.percent || 0)));
            if (barEl) barEl.style.width = `${pct}%`;
            const eta = (st.eta_text || '').replace('ETA: ', '') || '--:--';
            if (metaEl) metaEl.textContent = `${st.processed_items || 0} / ${st.total_items || 0} • ${pct} % • ${eta}`;
        }
    }

    const sugCard = document.getElementById('sug-progress-card');
    if (sugCard) {
        const meta = SUG_TOOL_META[_sugPageState.kind];
        const onSugPage = String(currentTab || '').startsWith('sug-');
        const matchesPage = Boolean(
            st && st.is_running && onSugPage && meta && (
                active === meta.analyzeTask || active === 'SUGGESTIONS'
            )
        );
        sugCard.classList.toggle('hidden', !matchesPage);
        if (matchesPage) {
            const pct = Math.max(0, Math.min(100, Number(st.percent || 0)));
            const eta = (st.eta_text || '').replace('ETA: ', '') || '--:--';
            const titleEl = document.getElementById('sug-status-title');
            const barEl = document.getElementById('cov-bar-sug');
            const pctEl = document.getElementById('cov-pct-sug');
            const lblEl = document.getElementById('cov-label-sug');
            const etaEl = document.getElementById('sug-eta-label');
            if (titleEl) titleEl.textContent = st.current_step || 'Analyse en cours...';
            if (barEl) barEl.style.width = `${pct}%`;
            if (pctEl) pctEl.textContent = `${pct} %`;
            if (lblEl) lblEl.innerHTML = `${st.processed_items || 0} / ${st.total_items || 0}<br><span class="font-semibold opacity-75">fichiers analysés</span>`;
            if (etaEl) etaEl.textContent = eta;
        }
    }
}

function openToolsAiModal() {
    loadStats();
    const m = document.getElementById('tools-ai-modal');
    if (m) m.classList.remove('hidden');
}

function closeToolsAiModal() {
    const m = document.getElementById('tools-ai-modal');
    if (m) m.classList.add('hidden');
}

async function loadToolsSuggestionsSummary(showToast = false) {
    try {
        const cfg = getSugToolSettings();
        const url = `/api/tools/suggestions/summary?min_mb=${encodeURIComponent(cfg.largeMinMb)}`
            + `&blur_threshold=${encodeURIComponent(cfg.blurThreshold)}`
            + `&min_age_days=${encodeURIComponent(cfg.ageDays)}`
            + `&max_gap_hours=${encodeURIComponent(cfg.gpsGapHours)}`;
        const res = await fetch(url);
        if (!res.ok) return;
        const d = await res.json();

        const albEl = document.getElementById('tools-sug-albums-count');
        if (albEl) albEl.textContent = Number(d.albums_count || 0) + Number(d.new_events_count || 0);
        const albMeta = document.getElementById('tools-sug-albums-meta');
        if (albMeta) {
            const evCnt = Number(d.new_events_count || 0);
            albMeta.textContent = `${evCnt} nouvel album${evCnt > 1 ? 's' : ''}`;
        }

        const rotEl = document.getElementById('tools-sug-rotation-count');
        if (rotEl) rotEl.textContent = d.rotation_count ?? 0;
        const rotMeta = document.getElementById('tools-sug-rotation-meta');
        if (rotMeta) {
            const sc = Number(d.rotation_scanned || 0);
            const tot = Number(d.rotation_total || 0);
            rotMeta.textContent = tot === 0 ? 'Aucune photo' : (sc === 0 ? 'Non analysé' : `${sc} / ${tot} vérifiée(s)`);
        }

        const blurEl = document.getElementById('tools-sug-blurry-count');
        if (blurEl) blurEl.textContent = d.blurry_count ?? 0;
        const blurMeta = document.getElementById('tools-sug-blurry-meta');
        if (blurMeta) {
            const scanned = Number(d.blurry_scanned || 0);
            const total = Number(d.blurry_total || 0);
            blurMeta.textContent = total === 0
                ? 'Aucune photo'
                : (scanned === 0 ? 'Non analysé' : `${scanned} / ${total} analysée(s)`);
        }

        const gpsEl = document.getElementById('tools-sug-gps-count');
        if (gpsEl) gpsEl.textContent = d.missing_gps_count ?? 0;

        const pplEl = document.getElementById('tools-sug-people-count');
        if (pplEl) pplEl.textContent = d.people_count ?? 0;
        const pplMeta = document.getElementById('tools-sug-people-meta');
        if (pplMeta) {
            const mc = Number(d.people_merge_count || 0);
            const uc = Number(d.people_unnamed_count || 0);
            pplMeta.textContent = `${mc} fusion${mc > 1 ? 's' : ''} · ${uc} inconnu${uc > 1 ? 's' : ''}`;
        }

        const scrEl = document.getElementById('tools-sug-screenshots-count');
        if (scrEl) scrEl.textContent = d.screenshots_count ?? 0;

        const largeEl = document.getElementById('tools-sug-large-count');
        if (largeEl) largeEl.textContent = Number(d.large_count || 0) + Number(d.short_videos_count || 0);
        const largeMeta = document.getElementById('tools-sug-large-meta');
        if (largeMeta) {
            const mbStr = String(d.large_mb ?? 0).replace('.', ',');
            const sv = Number(d.short_videos_count || 0);
            largeMeta.textContent = `${mbStr} Mo · ${sv} micro-vidéo${sv > 1 ? 's' : ''}`;
        }

        const mmEl = document.getElementById('st-missing-meta');
        if (mmEl && d.missing_meta_count !== undefined) mmEl.textContent = d.missing_meta_count;
        const mmPill = document.getElementById('tools-missing-meta-pill');
        if (mmPill && d.missing_meta_count !== undefined) {
            mmPill.classList.toggle('text-amber-400', Number(d.missing_meta_count || 0) > 0);
        }

        if (showToast && typeof showAppToast === 'function') {
            showAppToast('Suggestions actualisées.', 'info', 2500);
        }
    } catch (_) {}
}

function scanBlurryFiles() {
    runTask('BLUR');
}

function openSuggestionAndAnalyze(kind) {
    switchTab(`sug-${kind}`);
    runCurrentSugToolAnalyze(kind);
}

function openCurrentSugPageSettings() {
    const kind = _sugPageState.kind || 'albums';
    if (typeof openPageSettingsModal === 'function') openPageSettingsModal(`sug-${kind}`);
}

function syncSugPageLayoutSizeButtons() {
    const isPeople = _sugPageState.kind === 'people';
    ['GRID', 'MASONRY', 'LIST'].forEach(l => {
        const b = document.getElementById(`sug-layout-btn-${l}`);
        if (b) {
            b.className = _sugPageState.layout === l
                ? 'w-8 h-8 rounded-xl nav-item-active flex items-center justify-center transition'
                : 'w-8 h-8 rounded-xl ui-pill flex items-center justify-center transition';
            if (l === 'MASONRY') b.parentElement?.classList.toggle('hidden', isPeople);
        }
    });
    ['SM', 'MD', 'LG'].forEach(s => {
        const b = document.getElementById(`sug-size-btn-${s}`);
        if (b) {
            b.className = _sugPageState.size === s
                ? 'nav-item-active px-2.5 py-1 rounded-full transition cursor-pointer'
                : 'ui-pill px-2.5 py-1 rounded-full transition cursor-pointer';
        }
    });
}

function setSugPageLayout(layout) {
    _sugPageState.layout = layout;
    localStorage.setItem(`phototo_sug-${_sugPageState.kind}_layout`, layout);
    syncSugPageLayoutSizeButtons();
    renderSugPageFromCache();
}

function setSugPageSize(size) {
    _sugPageState.size = size;
    localStorage.setItem(`phototo_sug-${_sugPageState.kind}_size`, size);
    syncSugPageLayoutSizeButtons();
    renderSugPageFromCache();
}

function toggleSugPageSortOrder() {
    if (typeof _toggleSortOrderInput === 'function') {
        _toggleSortOrderInput('sug-sort-order', 'sug-sort-dir-btn', 'sug-sort-arrow', () => onSugPageControlsChanged());
    }
}

function onSugPageControlsChanged() {
    renderSugPageFromCache();
}

function onSugPageFilterChanged() {
    const kind = _sugPageState.kind;
    if (kind === 'blurry' || kind === 'large') {
        openSuggestionPage(kind, true);
    } else {
        renderSugPageFromCache();
    }
}

async function runCurrentSugToolAnalyze(kindOverride = null) {
    const kind = kindOverride || _sugPageState.kind;
    const meta = SUG_TOOL_META[kind];
    if (!meta) return;
    if (meta.analyzeTask === 'REPAIR_META') {
        await retryMissingMetadataNow();
        if (currentTab === `sug-${kind}`) openSuggestionPage(kind, true);
        return;
    }
    if (meta.analyzeTask) {
        await runTask(meta.analyzeTask);
        return;
    }
    await openSuggestionPage(kind, true);
    await loadToolsSuggestionsSummary();
    if (typeof showAppToast === 'function') showAppToast(`${meta.title} actualisé.`, 'info', 2200);
}

function updateSugBatchBar() {
    const bar = document.getElementById('sug-batch-bar');
    const grid = document.getElementById('sug-container');
    const onSugPage = String(currentTab || '').startsWith('sug-');
    const visible = onSugPage && _sugPageState.kind !== 'people' && _sugPageState.selected.size > 0;
    if (bar) {
        bar.classList.toggle('hidden', !visible);
        const cntEl = document.getElementById('sug-batch-count');
        if (cntEl) cntEl.textContent = `${_sugPageState.selected.size} sélectionné(s)`;
    }
    if (grid) grid.classList.toggle('selection-active', visible);
    if (typeof syncBatchBarBounds === 'function') syncBatchBarBounds();
    const trashSel = currentTab === 'trash' && typeof selectedTrashPaths !== 'undefined' && selectedTrashPaths.size > 0;
    const galSel = typeof selectedGalleryPaths !== 'undefined' && selectedGalleryPaths.size > 0 && !onSugPage && currentTab !== 'trash';
    document.body.classList.toggle('has-batch-bar', visible || trashSel || galSel);
}

function toggleSugItemSelect(sortedIdx, event) {
    if (event) event.stopPropagation();
    const list = _sugPageState.sortedItems || [];
    const target = list[sortedIdx];
    if (!target || !target.source_path) return;
    const willSel = !_sugPageState.selected.has(target.source_path);
    if (event && event.shiftKey && _sugPageState.lastIdx !== null && _sugPageState.lastIdx < list.length) {
        const start = Math.min(_sugPageState.lastIdx, sortedIdx);
        const end = Math.max(_sugPageState.lastIdx, sortedIdx);
        for (let i = start; i <= end; i++) {
            const p = list[i]?.source_path;
            if (!p) continue;
            if (willSel) _sugPageState.selected.add(p);
            else _sugPageState.selected.delete(p);
        }
    } else {
        if (willSel) _sugPageState.selected.add(target.source_path);
        else _sugPageState.selected.delete(target.source_path);
    }
    _sugPageState.lastIdx = sortedIdx;
    renderSugPageFromCache();
}

function toggleSelectAllSugItems(forceState) {
    const list = _sugPageState.sortedItems || [];
    if (!list.length) return;
    const willSelect = typeof forceState === 'boolean' ? forceState : (_sugPageState.selected.size < list.length);
    if (!willSelect) {
        _sugPageState.selected.clear();
    } else {
        list.forEach(it => { if (it.source_path) _sugPageState.selected.add(it.source_path); });
    }
    _sugPageState.lastIdx = null;
    renderSugPageFromCache();
}

function openLightboxForSugPageItem(sortedIdx) {
    const list = _sugPageState.sortedItems || [];
    if (!list.length || typeof openLightbox !== 'function') return;
    lightboxIsCustomItem = true;
    currentLightboxDupGroup = null;
    currentGalleryItems = list.filter(Boolean).map(it => ({ ...it }));
    openLightbox(Math.max(0, Math.min(sortedIdx, currentGalleryItems.length - 1)));
}

async function openSuggestionPage(kind, forceFetch = true) {
    const meta = SUG_TOOL_META[kind];
    if (!meta) return;

    const kindChanged = _sugPageState.kind !== kind;
    _sugPageState.kind = kind;
    if (kindChanged || forceFetch) {
        _sugPageState.previewEventIdx = null;
    }
    if (kindChanged) {
        _sugPageState.selected.clear();
        _sugPageState.lastIdx = null;
        _sugPageState.layout = localStorage.getItem(`phototo_sug-${kind}_layout`) || 'GRID';
        _sugPageState.size = localStorage.getItem(`phototo_sug-${kind}_size`) || 'MD';
    }

    const titleEl = document.getElementById('sug-page-title');
    if (titleEl) titleEl.textContent = meta.title;
    const anLbl = document.getElementById('sug-analyze-btn-label');
    if (anLbl) anLbl.textContent = meta.analyzeLabel || 'Analyser';

    const pageCfg = (typeof PAGE_SETTINGS_CONFIG !== 'undefined') ? PAGE_SETTINGS_CONFIG[`sug-${kind}`] : null;
    const sortSel = document.getElementById('sug-sort-by');
    const filtSel = document.getElementById('sug-filter-by');
    if (pageCfg && sortSel && (kindChanged || !sortSel.options.length)) {
        sortSel.innerHTML = pageCfg.sortOptions.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
        sortSel.value = pageCfg.defaults.sortBy;
    }
    if (pageCfg && filtSel && (kindChanged || !filtSel.options.length)) {
        filtSel.innerHTML = pageCfg.groupOptions.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
        filtSel.value = pageCfg.defaults.groupBy;
    }

    if (kindChanged && typeof applyPageDefaultOptions === 'function') {
        const applied = applyPageDefaultOptions(`sug-${kind}`, false);
        if (!applied && pageCfg) {
            const ordInp = document.getElementById('sug-sort-order');
            if (ordInp) ordInp.value = pageCfg.defaults.sortOrder || 'desc';
            if (typeof _syncSortDirButtonUI === 'function') {
                _syncSortDirButtonUI(pageCfg.defaults.sortOrder === 'asc', 'sug-sort-dir-btn', 'sug-sort-arrow');
            }
        }
    }
    syncSugPageLayoutSizeButtons();

    const pBtn = document.getElementById('sug-batch-primary-btn');
    const pLbl = document.getElementById('sug-batch-primary-label');
    if (pBtn) pBtn.classList.toggle('hidden', !meta.batchPrimaryLabel);
    if (pLbl && meta.batchPrimaryLabel) pLbl.textContent = meta.batchPrimaryLabel;
    document.getElementById('sug-batch-trash-btn')?.classList.toggle('hidden', !meta.supportsTrash);

    const cont = document.getElementById('sug-container');
    if (forceFetch || kindChanged) {
        if (cont) cont.innerHTML = '<div class="ui-card rounded-3xl p-10 text-center text-xs font-bold opacity-65">Chargement...</div>';
        const cfg = getSugToolSettings();
        const filterVal = filtSel ? filtSel.value : 'all';
        const apiFilterMode = (kind === 'blurry' && (filterVal === 'blur' || filterVal === 'exposure')) ? filterVal : 'all';
        const apiLargeMode = (kind === 'large' && filterVal === 'short_videos') ? 'short_videos' : 'large';

        const url = `/api/tools/suggestions/details?kind=${encodeURIComponent(kind)}`
            + `&min_mb=${encodeURIComponent(cfg.largeMinMb)}`
            + `&blur_threshold=${encodeURIComponent(cfg.blurThreshold)}`
            + `&filter_mode=${encodeURIComponent(apiFilterMode)}`
            + `&min_age_days=${encodeURIComponent(cfg.ageDays)}`
            + `&max_gap_hours=${encodeURIComponent(cfg.gpsGapHours)}`
            + `&mode=${encodeURIComponent(apiLargeMode)}`;
        const res = await fetch(url);
        if (!res.ok) {
            if (cont) cont.innerHTML = '<div class="ui-card rounded-3xl p-10 text-center text-xs font-bold text-rose-400">Impossible de charger les données.</div>';
            return;
        }
        const d = await res.json();
        _sugPageState.items = Array.isArray(d.items) ? d.items : [];
        _sugPageState.newEvents = Array.isArray(d.new_events) ? d.new_events : [];
        _sugPageState.peopleData = kind === 'people'
            ? { merge_pairs: d.merge_pairs || [], unnamed_persons: d.unnamed_persons || [] }
            : null;
        _sugPageState.serverMeta = d;
        const foundBan = document.getElementById('sug-found-banner');
        if (foundBan) foundBan.textContent = Number(d.total || _sugPageState.items.length || 0);
    }

    renderSugPageFromCache();
}

function _getSugGridColsClass() {
    const layout = _sugPageState.layout;
    const size = _sugPageState.size;
    if (layout === 'LIST') return 'flex flex-col gap-2';
    if (layout === 'MASONRY') {
        const gapCls = size === 'SM' ? 'gap-2.5' : (size === 'LG' ? 'gap-5' : 'gap-4');
        return `masonry-grid flex items-start ${gapCls}`;
    }
    if (size === 'SM') return 'grid grid-cols-3 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-2.5';
    if (size === 'LG') return 'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-3 gap-5';
    return 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4';
}

function _getSugMasonryColCount() {
    const w = window.innerWidth || 1280;
    if (_sugPageState.size === 'SM') return w >= 1280 ? 8 : (w >= 768 ? 6 : 3);
    if (_sugPageState.size === 'LG') return w >= 1280 ? 3 : (w >= 768 ? 2 : 1);
    return w >= 1280 ? 5 : (w >= 768 ? 4 : 2);
}

function _renderSugPeoplePage(filterVal, sortBy, dir) {
    const data = _sugPageState.peopleData || { merge_pairs: [], unnamed_persons: [] };
    let pairs = [...(data.merge_pairs || [])];
    let unnamed = [...(data.unnamed_persons || [])];

    if (filterVal === 'MERGES') unnamed = [];
    if (filterVal === 'UNNAMED') pairs = [];

    if (sortBy === 'similarity') {
        pairs.sort((a, b) => dir * ((Number(a.similarity) || 0) - (Number(b.similarity) || 0)));
    } else {
        pairs.sort((a, b) => dir * (((a.p1?.face_count || 0) + (a.p2?.face_count || 0)) - ((b.p1?.face_count || 0) + (b.p2?.face_count || 0))));
        unnamed.sort((a, b) => dir * ((Number(a.face_count) || 0) - (Number(b.face_count) || 0)));
    }

    const totalLbl = document.getElementById('sug-total-label');
    const tot = pairs.length + unnamed.length;
    if (totalLbl) totalLbl.textContent = `${tot} suggestion${tot > 1 ? 's' : ''}`;

    const isList = _sugPageState.layout === 'LIST';
    const gridCls = isList ? 'flex flex-col gap-2.5' : 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3';

    if (!tot) {
        return `<div class="ui-card rounded-3xl p-10 text-center text-xs font-bold opacity-65">Aucune fusion ni visage inconnu fréquent détecté pour le moment.</div>`;
    }

    const pairsHtml = pairs.length ? `
        <section class="space-y-3">
            <h3 class="text-xs font-extrabold uppercase tracking-wider opacity-70 px-1">Paires similaires à fusionner (${pairs.length})</h3>
            <div class="${isList ? 'flex flex-col gap-2.5' : 'grid grid-cols-1 md:grid-cols-2 gap-3'}">
                ${pairs.map(pr => {
                    const p1 = pr.p1 || {};
                    const p2 = pr.p2 || {};
                    const t1 = p1.thumb_path ? `/face_thumb?path=${encodeURIComponent(p1.thumb_path)}` : '';
                    const t2 = p2.thumb_path ? `/face_thumb?path=${encodeURIComponent(p2.thumb_path)}` : '';
                    const bestName = p1.name !== 'Inconnu' ? p1.name : (p2.name !== 'Inconnu' ? p2.name : 'Inconnu');
                    return `
                    <div class="ui-card rounded-2xl p-4 flex items-center justify-between gap-3 shadow-sm">
                        <div class="flex items-center gap-3 min-w-0">
                            <div class="flex -space-x-2 shrink-0">
                                <img src="${t1}" class="w-12 h-12 rounded-full object-cover ring-2 ring-black/20 bg-black/20"/>
                                <img src="${t2}" class="w-12 h-12 rounded-full object-cover ring-2 ring-black/20 bg-black/20"/>
                            </div>
                            <div class="min-w-0">
                                <div class="text-xs font-extrabold truncate">${escapeHtml(p1.name || 'Inconnu')} + ${escapeHtml(p2.name || 'Inconnu')}</div>
                                <div class="text-[11px] opacity-65">${pr.similarity} % de ressemblance · ${(Number(p1.face_count || 0) + Number(p2.face_count || 0))} apparitions</div>
                            </div>
                        </div>
                        <button type="button" onclick="mergeSuggestedPersonsPair(${Number(p1.person_id)}, ${Number(p2.person_id)}, '${encodeURIComponent(bestName)}')"
                                class="plum-btn px-4 py-1.5 rounded-full text-xs font-extrabold shrink-0 cursor-pointer">
                            Fusionner
                        </button>
                    </div>`;
                }).join('')}
            </div>
        </section>` : '';

    const unnamedHtml = unnamed.length ? `
        <section class="space-y-3">
            <h3 class="text-xs font-extrabold uppercase tracking-wider opacity-70 px-1">Visages « Inconnus » fréquents à nommer (${unnamed.length})</h3>
            <div class="${gridCls}">
                ${unnamed.map(u => {
                    const pid = Number(u.person_id);
                    const thumb = u.thumb_path ? `/face_thumb?path=${encodeURIComponent(u.thumb_path)}` : '';
                    return `
                    <div class="ui-card rounded-2xl p-4 flex ${isList ? 'flex-wrap items-center justify-between' : 'flex-col'} gap-3 shadow-sm">
                        <div class="flex items-center gap-3">
                            <img src="${thumb}" class="w-12 h-12 rounded-full object-cover shrink-0 bg-black/20"/>
                            <div class="min-w-0">
                                <div class="text-xs font-extrabold">Personne #${pid}</div>
                                <div class="text-[11px] opacity-65">${Number(u.face_count || 0)} photo(s) détectée(s)</div>
                            </div>
                        </div>
                        <div class="flex items-center gap-2 ${isList ? 'w-full sm:w-72' : ''}">
                            <input id="sug-person-name-${pid}" type="text" placeholder="Prénom / Nom..."
                                   onkeydown="if(event.key==='Enter') renameSuggestedUnknownPerson(${pid})"
                                   class="ui-pill flex-1 min-w-0 rounded-full px-3.5 py-1.5 text-xs font-bold outline-none"/>
                            <button type="button" onclick="renameSuggestedUnknownPerson(${pid})"
                                    class="plum-btn px-4 py-1.5 rounded-full text-xs font-extrabold shrink-0 cursor-pointer">
                                Nommer
                            </button>
                        </div>
                    </div>`;
                }).join('')}
            </div>
        </section>` : '';

    return `<div class="space-y-6">${pairsHtml}${unnamedHtml}</div>`;
}

function _renderSugMediaTile(it, sortedIdx) {
    const kind = _sugPageState.kind;
    const layout = _sugPageState.layout;
    const size = _sugPageState.size;
    const isSel = Boolean(it.source_path && _sugPageState.selected.has(it.source_path));
    const fname = escapeHtml((it.dest_path || it.source_path || '').split(/[\\/]/).pop() || 'Média');
    const thumbUrl = `/thumb?path=${encodeURIComponent(it.dest_path)}${_toolsThumbVersion ? `&v=${_toolsThumbVersion}` : ''}`;
    const isVid = typeof isVideoFile === 'function' && isVideoFile(it.dest_path);
    const durText = typeof formatDuration === 'function' ? formatDuration(it.duration_sec) : '';
    const mb = typeof _formatBytesShort === 'function' ? _formatBytesShort(it.file_size) : '';
    const dim = (it.width && it.height) ? `${it.width}×${it.height}` : '';
    const dateTxt = it.timestamp ? formatDate(it.timestamp) : '';

    let badgeLbl = mb;
    let detailLine = [dateTxt, dim, mb].filter(Boolean).join(' · ');
    let extraAction = '';

    if (kind === 'albums') {
        if (_sugPageState.previewEventIdx !== null) {
            badgeLbl = isVid && durText ? durText : (dim || mb);
            detailLine = [dateTxt, dim, mb].filter(Boolean).join(' · ');
        } else {
            badgeLbl = `📁 ${it.suggested_album || ''}`;
            detailLine = it.suggestion_reason || detailLine;
        }
    } else if (kind === 'rotation') {
        const rot = Number(it.suggested_rotation || 90);
        badgeLbl = `+${rot}°`;
        detailLine = it.rotation_reason || detailLine;
        extraAction = `
            <div class="opacity-0 group-hover:opacity-100 absolute bottom-2 right-2 z-10 flex items-center gap-1 transition">
                <button type="button" onclick="event.stopPropagation(); applySingleRotationSuggestion(${sortedIdx}, ${rot})" title="Pivoter +${rot}°"
                        class="px-2.5 h-7 rounded-full bg-black/60 hover:bg-emerald-500/90 backdrop-blur-md text-white text-[10px] font-extrabold transition cursor-pointer shadow">
                    +${rot}°
                </button>
                <button type="button" onclick="event.stopPropagation(); dismissRotationSuggestion(${sortedIdx})" title="Ignorer"
                        class="w-7 h-7 rounded-full bg-black/60 hover:bg-rose-600 backdrop-blur-md text-white text-[10px] font-extrabold transition cursor-pointer shadow">
                    ✕
                </button>
            </div>`;
    } else if (kind === 'blurry') {
        badgeLbl = it.quality_issue || 'Qualité';
        if (it.has_sharper_similar) detailLine = `Meilleur cliché dispo · ${detailLine}`;
    } else if (kind === 'missing_gps') {
        badgeLbl = `📍 ${it.suggested_city || 'Lieu'}`;
        detailLine = it.suggestion_reason || detailLine;
    } else if (kind === 'screenshots') {
        badgeLbl = it.doc_kind || 'Capture';
        detailLine = it.ocr_excerpt || detailLine;
    } else if (kind === 'large') {
        badgeLbl = isVid && it.duration_sec && it.duration_sec <= 2.0 ? `${Number(it.duration_sec).toFixed(1)} s` : (mb || dim);
    } else if (kind === 'missing_meta') {
        badgeLbl = 'Date absente';
        const sEnc = encodeURIComponent(it.source_path || '');
        extraAction = `
            <div class="opacity-0 group-hover:opacity-100 absolute bottom-2 right-2 z-10 transition">
                <button type="button" onclick="event.stopPropagation(); openMetadataModalSingle('${sEnc}')" title="Éditer EXIF"
                        class="px-2.5 h-7 rounded-full bg-black/60 hover:bg-amber-500/90 backdrop-blur-md text-white text-[10px] font-extrabold transition cursor-pointer shadow">
                    EXIF
                </button>
            </div>`;
    }

    const selectIcon = typeof getSelectIconHTML === 'function' ? getSelectIconHTML(isSel, layout === 'LIST') : (isSel ? '✓' : '');
    const videoBadge = isVid
        ? `<div class="absolute bottom-2.5 left-2.5 z-10 bg-black/35 backdrop-blur-sm text-white/95 text-[10px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full flex items-center gap-1 pointer-events-none">
             <svg class="w-2.5 h-2.5 opacity-90" fill="currentColor" viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>
             <span>${durText}</span>
           </div>`
        : '';

    if (layout === 'LIST') {
        const thumbSizeCls = size === 'SM' ? 'w-11 h-11 rounded-xl' : (size === 'LG' ? 'w-24 h-24 rounded-2xl' : 'w-16 h-16 rounded-2xl');
        const padCls = size === 'SM' ? 'p-2 gap-2.5 rounded-2xl' : (size === 'LG' ? 'p-3.5 gap-4 rounded-3xl' : 'p-2.5 gap-3.5 rounded-2xl');
        const titleCls = size === 'SM' ? 'text-xs' : (size === 'LG' ? 'text-base' : 'text-sm');
        return `
        <div onclick="openLightboxForSugPageItem(${sortedIdx})"
             class="media-tile ui-card group flex items-center ${padCls} cursor-pointer shadow-sm transition-all duration-150 ${isSel ? 'tile-selected-list' : ''}">
            <button type="button" onclick="event.stopPropagation(); toggleSugItemSelect(${sortedIdx}, event)" title="Sélectionner" class="tile-select-btn shrink-0 cursor-pointer">
                ${selectIcon}
            </button>
            <div class="relative shrink-0 ${thumbSizeCls} overflow-hidden bg-black/10">
                <img src="${thumbUrl}" loading="lazy" decoding="async" class="w-full h-full object-cover select-none pointer-events-none"/>
                ${isVid ? `<span class="absolute bottom-1 left-1 bg-black/40 text-white text-[9px] font-semibold px-1.5 rounded-full pointer-events-none">${durText}</span>` : ''}
            </div>
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 min-w-0">
                    <span class="font-bold truncate ${titleCls}">${fname}</span>
                    ${badgeLbl ? `<span class="ui-pill text-[10px] font-extrabold px-2.5 py-0.5 rounded-full shrink-0 max-w-[45%] truncate">${escapeHtml(badgeLbl)}</span>` : ''}
                </div>
                <div class="text-[11px] opacity-65 truncate mt-0.5">${escapeHtml(detailLine || 'Média')}</div>
            </div>
        </div>`;
    }

    const selectBtn = `
        <button type="button" onclick="event.stopPropagation(); toggleSugItemSelect(${sortedIdx}, event)" title="Sélectionner"
                class="tile-select-btn absolute top-2.5 left-2.5 z-10 cursor-pointer">
            ${selectIcon}
        </button>`;
    const topRightBadge = badgeLbl
        ? `<span title="${escapeHtml(detailLine || badgeLbl)}" class="absolute top-2.5 right-2.5 z-10 bg-black/45 backdrop-blur-sm text-white/95 text-[10px] font-bold px-2 py-0.5 rounded-full max-w-[68%] truncate pointer-events-none">${escapeHtml(badgeLbl)}</span>`
        : '';

    if (layout === 'MASONRY') {
        const aspectStyle = (it.width && it.height) ? `aspect-ratio: ${it.width} / ${it.height};` : '';
        return `
        <div onclick="openLightboxForSugPageItem(${sortedIdx})" style="${aspectStyle}"
             class="media-tile masonry-item ui-card group relative w-full rounded-lg overflow-hidden cursor-pointer shadow-sm transition-all duration-150 ${isSel ? 'tile-selected' : ''}">
            <img src="${thumbUrl}" loading="lazy" decoding="async" class="w-full h-auto block group-hover:scale-[1.02] transition duration-300 select-none pointer-events-none"/>
            ${selectBtn}
            ${topRightBadge}
            ${videoBadge}
            ${extraAction}
        </div>`;
    }

    return `
    <div onclick="openLightboxForSugPageItem(${sortedIdx})"
         class="media-tile ui-card group relative aspect-square rounded-[24px] overflow-hidden cursor-pointer shadow-sm transition-all duration-150 ${isSel ? 'tile-selected' : ''}">
        <img src="${thumbUrl}" loading="lazy" decoding="async" class="w-full h-full object-cover group-hover:scale-[1.03] transition duration-300 select-none pointer-events-none"/>
        ${selectBtn}
        ${topRightBadge}
        ${videoBadge}
        ${extraAction}
    </div>`;
}

function goBackFromSugPage() {
    if (_sugPageState.kind === 'albums' && _sugPageState.previewEventIdx !== null) {
        closeSuggestedNewAlbumPreview();
        return;
    }
    switchTab('tools');
}

function openSuggestedNewAlbumPreview(eventIdx) {
    const ev = (_sugPageState.newEvents || [])[eventIdx];
    if (!ev) return;
    _sugPageState.previewEventIdx = eventIdx;
    _sugPageState.selected.clear();
    _sugPageState.lastIdx = null;
    renderSugPageFromCache();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function closeSuggestedNewAlbumPreview() {
    _sugPageState.previewEventIdx = null;
    _sugPageState.selected.clear();
    _sugPageState.lastIdx = null;
    renderSugPageFromCache();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function createSuggestedNewAlbumFromPreview() {
    const idx = _sugPageState.previewEventIdx;
    if (idx === null || idx === undefined) return;
    const ev = (_sugPageState.newEvents || [])[idx];
    if (!ev) return;
    const inp = document.getElementById('sug-event-preview-name');
    const customName = inp ? inp.value.trim() : '';
    const selectedPaths = (_sugPageState.selected && _sugPageState.selected.size > 0)
        ? Array.from(_sugPageState.selected)
        : null;
    return createSuggestedNewAlbum(idx, customName || ev.suggested_name, selectedPaths);
}

function renderSugPageFromCache() {
    const kind = _sugPageState.kind;
    const meta = SUG_TOOL_META[kind] || { unit: 'élément' };
    const cont = document.getElementById('sug-container');
    const totalLbl = document.getElementById('sug-total-label');
    const sumBar = document.getElementById('sug-summary-bar');
    if (!cont) return;

    let previewEv = (kind === 'albums' && _sugPageState.previewEventIdx !== null)
        ? ((_sugPageState.newEvents || [])[_sugPageState.previewEventIdx] || null)
        : null;
    if (kind !== 'albums' || !previewEv) {
        _sugPageState.previewEventIdx = null;
        previewEv = null;
    }

    const titleEl = document.getElementById('sug-page-title');
    const analyzeBtn = document.getElementById('sug-analyze-btn');
    const headerActBtn = document.getElementById('sug-header-action-btn');
    const batchPrimaryBtn = document.getElementById('sug-batch-primary-btn');
    const batchPrimaryLbl = document.getElementById('sug-batch-primary-label');

    if (previewEv) {
        if (titleEl) titleEl.textContent = `✨ ${previewEv.suggested_name}`;
        if (analyzeBtn) analyzeBtn.classList.add('hidden');
        if (headerActBtn) {
            const createCnt = _sugPageState.selected.size > 0
                ? _sugPageState.selected.size
                : Number(previewEv.item_count || (previewEv.items || []).length || 0);
            headerActBtn.textContent = _sugPageState.selected.size > 0
                ? `Créer avec sélection (${createCnt})`
                : `Créer l'album (${createCnt})`;
            headerActBtn.className = 'sticky-hide-on-stuck plum-btn px-5 py-2.5 rounded-full text-xs font-extrabold shadow-md transition cursor-pointer';
            headerActBtn.classList.remove('hidden');
        }
        if (batchPrimaryBtn) batchPrimaryBtn.classList.remove('hidden');
        if (batchPrimaryLbl) batchPrimaryLbl.textContent = `Créer l'album (${_sugPageState.selected.size})`;
    } else {
        if (titleEl) titleEl.textContent = meta.title || 'Suggestions';
        if (analyzeBtn) analyzeBtn.classList.remove('hidden');
        if (headerActBtn) {
            headerActBtn.classList.add('hidden');
            headerActBtn.className = 'hidden sticky-hide-on-stuck ui-card hover:bg-[var(--bg-hover)] px-5 py-2.5 rounded-full text-xs font-extrabold shadow-sm transition cursor-pointer';
        }
        if (batchPrimaryBtn) batchPrimaryBtn.classList.toggle('hidden', !meta.batchPrimaryLabel);
        if (batchPrimaryLbl && meta.batchPrimaryLabel) batchPrimaryLbl.textContent = meta.batchPrimaryLabel;
    }

    const sortBy = document.getElementById('sug-sort-by')?.value || 'date';
    const sortOrder = document.getElementById('sug-sort-order')?.value || 'desc';
    const filterBy = document.getElementById('sug-filter-by')?.value || 'ALL';
    const dir = sortOrder === 'asc' ? 1 : -1;

    if (kind === 'people') {
        if (sumBar) sumBar.classList.add('hidden');
        cont.className = 'space-y-6 pb-10';
        cont.innerHTML = _renderSugPeoplePage(filterBy, sortBy, dir);
        updateSugBatchBar();
        return;
    }

    let items = previewEv ? [...(previewEv.items || [])] : [...(_sugPageState.items || [])];
    let newEvents = (kind === 'albums' && !previewEv) ? [...(_sugPageState.newEvents || [])] : [];

    if (kind === 'albums' && !previewEv) {
        if (filterBy === 'NEW_ONLY') items = [];
        if (filterBy === 'EXISTING_ONLY') newEvents = [];
    } else if (kind === 'rotation' && ['90', '180', '270'].includes(filterBy)) {
        items = items.filter(it => String(it.suggested_rotation) === filterBy);
    } else if (kind === 'blurry' && filterBy === 'sharper') {
        items = items.filter(it => Boolean(it.has_sharper_similar));
    } else if (kind === 'missing_gps') {
        if (filterBy === 'NEAR_30M') items = items.filter(it => Number(it.time_diff_sec || 999999) <= 1800);
        if (filterBy === 'NEAR_2H') items = items.filter(it => Number(it.time_diff_sec || 999999) <= 7200);
    } else if (kind === 'screenshots') {
        if (filterBy === 'SCREEN') items = items.filter(it => String(it.doc_kind || '').includes('Capture'));
        if (filterBy === 'OCR') items = items.filter(it => String(it.doc_kind || '').includes('Document'));
    } else if (kind === 'large') {
        if (filterBy === 'videos_only') items = items.filter(it => typeof isVideoFile === 'function' && isVideoFile(it.dest_path));
        if (filterBy === 'photos_only') items = items.filter(it => !(typeof isVideoFile === 'function' && isVideoFile(it.dest_path)));
    } else if (kind === 'missing_meta') {
        if (filterBy === 'NO_META') items = items.filter(it => it.status === 'no_metadata' || !it.timestamp);
        if (filterBy === 'MTIME') items = items.filter(it => it.status === 'mtime_fallback');
    }

    items.sort((a, b) => {
        if (sortBy === 'name') {
            const na = (a.dest_path || a.source_path || '').split(/[\\/]/).pop() || '';
            const nb = (b.dest_path || b.source_path || '').split(/[\\/]/).pop() || '';
            return dir * na.localeCompare(nb, 'fr', { sensitivity: 'base' });
        }
        if (sortBy === 'size') return dir * (Number(a.file_size || 0) - Number(b.file_size || 0));
        if (sortBy === 'score') return dir * (Number(a._match_score || 0) - Number(b._match_score || 0));
        if (sortBy === 'blur_score') return dir * (Number(a.blur_score ?? 9999) - Number(b.blur_score ?? 9999));
        if (sortBy === 'angle') return dir * (Number(a.suggested_rotation || 0) - Number(b.suggested_rotation || 0));
        if (sortBy === 'time_diff') return dir * (Number(a.time_diff_sec || 999999) - Number(b.time_diff_sec || 999999));
        if (sortBy === 'age') return dir * (Number(a.age_days || 0) - Number(b.age_days || 0));
        if (sortBy === 'duration') return dir * (Number(a.duration_sec || 0) - Number(b.duration_sec || 0));
        if (sortBy === 'modified') return dir * (Number(a.modified_at || 0) - Number(b.modified_at || 0));
        return dir * (Number(a.timestamp || 0) - Number(b.timestamp || 0));
    });
    _sugPageState.sortedItems = items;

    const totalCount = items.length + newEvents.length;
    if (totalLbl) {
        if (previewEv) {
            totalLbl.textContent = `${items.length} média${items.length > 1 ? 's' : ''}`;
        } else {
            totalLbl.textContent = `${totalCount} ${meta.unit}${totalCount > 1 ? 's' : ''}`;
        }
    }

    if (sumBar) {
        if (items.length > 0) {
            const totalBytes = items.reduce((acc, it) => acc + Number(it.file_size || 0), 0);
            const mbTxt = (totalBytes / (1024 * 1024)).toFixed(1).replace('.', ',');
            sumBar.classList.remove('hidden');
            sumBar.innerHTML = `
                <div class="flex flex-wrap items-center gap-2">
                    <span>${items.length} média${items.length > 1 ? 's' : ''}</span>
                    <span class="opacity-45">•</span>
                    <span class="opacity-75">${mbTxt} Mo</span>
                </div>
                <button type="button" onclick="toggleSelectAllSugItems()" class="ui-pill hover:bg-[var(--bg-hover)] px-3.5 py-1.5 rounded-full text-xs font-extrabold transition cursor-pointer">
                    ${_sugPageState.selected.size === items.length ? 'Tout désélectionner' : 'Tout sélectionner'}
                </button>`;
        } else {
            sumBar.classList.add('hidden');
        }
    }

    const sMeta = _sugPageState.serverMeta || {};
    if (!items.length && !newEvents.length) {
        let ctaHtml = '';
        if ((kind === 'blurry' || kind === 'rotation') && Number(sMeta.scanned || 0) === 0 && Number(sMeta.total_photos || 0) > 0) {
            ctaHtml = `
                <button type="button" onclick="runCurrentSugToolAnalyze()" class="plum-btn px-5 py-2 rounded-full text-xs font-extrabold shadow-sm cursor-pointer">
                    Lancer l'analyse (${sMeta.total_photos} photos)
                </button>`;
        }
        cont.className = 'pb-10';
        cont.innerHTML = `
            <div class="ui-card rounded-3xl p-10 text-center space-y-3 shadow-sm">
                <div class="text-base font-extrabold">Aucune suggestion pour le moment</div>
                <p class="text-xs opacity-65 max-w-md mx-auto">Tout est en ordre ou aucune correspondance ne correspond aux filtres et réglages actuels.</p>
                ${ctaHtml}
            </div>`;
        updateSugBatchBar();
        return;
    }

    let previewBannerHtml = '';
    if (previewEv) {
        const startTxt = previewEv.start_ts && typeof formatDate === 'function' ? formatDate(previewEv.start_ts) : '';
        const endTxt = previewEv.end_ts && typeof formatDate === 'function' ? formatDate(previewEv.end_ts) : '';
        const spanTxt = (startTxt && endTxt && startTxt !== endTxt) ? `${startTxt} → ${endTxt}` : (startTxt || '');
        const selCount = _sugPageState.selected.size;
        const targetCount = selCount > 0 ? selCount : items.length;
        previewBannerHtml = `
            <div id="sug-event-preview-banner" class="ui-card rounded-3xl p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4 shadow-sm">
                <div class="flex flex-col gap-1.5 min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-2">
                        <button type="button" onclick="closeSuggestedNewAlbumPreview()"
                                class="ui-pill hover:bg-[var(--bg-hover)] px-3 py-1 rounded-full text-xs font-extrabold transition cursor-pointer shrink-0">
                            ← Tous les albums suggérés
                        </button>
                        ${spanTxt ? `<span class="text-[11px] font-bold opacity-65">${escapeHtml(spanTxt)}</span>` : ''}
                    </div>
                    <div class="flex flex-wrap items-center gap-2 mt-1">
                        <span class="text-xs font-extrabold opacity-70 shrink-0">Nom de l'album :</span>
                        <input id="sug-event-preview-name" type="text" value="${escapeHtml(previewEv.suggested_name)}"
                               onkeydown="if(event.key==='Enter') createSuggestedNewAlbumFromPreview()"
                               class="ui-pill rounded-full px-3.5 py-1.5 text-xs font-extrabold outline-none min-w-[210px] max-w-full flex-1 sm:flex-initial sm:w-80"/>
                    </div>
                    <p class="text-[11px] opacity-65">${escapeHtml(previewEv.reason || '')}${selCount > 0 ? ` · ${selCount} média(s) sélectionné(s)` : ' · Cliquez sur un média pour l\'inspecter ou sélectionnez-en une partie.'}</p>
                </div>
                <button type="button" onclick="createSuggestedNewAlbumFromPreview()"
                        class="plum-btn px-5 py-2 rounded-full text-xs font-extrabold shadow-md shrink-0 cursor-pointer">
                    ${selCount > 0 ? `Créer avec sélection (${targetCount})` : `Créer cet album (${targetCount})`}
                </button>
            </div>`;
    }

    let eventsHtml = '';
    if (kind === 'albums' && newEvents.length) {
        eventsHtml = `
            <section class="space-y-3">
                <h3 class="text-xs font-extrabold uppercase tracking-wider opacity-70 px-1">Nouveaux albums suggérés (${newEvents.length})</h3>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                    ${newEvents.map((ev, eIdx) => {
                        const thumbs = (ev.preview_dest_paths || []).slice(0, 4).map(dp =>
                            `<img src="/thumb?path=${encodeURIComponent(dp)}" loading="lazy" class="w-11 h-11 rounded-xl object-cover bg-black/20 shrink-0"/>`
                        ).join('');
                        return `
                        <div class="ui-card rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3 shadow-sm">
                            <div onclick="openSuggestedNewAlbumPreview(${eIdx})" class="flex items-center gap-3 min-w-0 flex-1 cursor-pointer group">
                                <div class="flex items-center -space-x-2 shrink-0">${thumbs}</div>
                                <div class="min-w-0">
                                    <div class="text-xs font-extrabold truncate group-hover:underline">✨ ${escapeHtml(ev.suggested_name)}</div>
                                    <div class="text-[11px] opacity-65 truncate">${escapeHtml(ev.reason || '')}</div>
                                </div>
                            </div>
                            <div class="flex items-center gap-1.5 shrink-0">
                                <button type="button" onclick="openSuggestedNewAlbumPreview(${eIdx})"
                                        class="ui-pill hover:bg-[var(--bg-hover)] px-3.5 py-1.5 rounded-full text-xs font-extrabold transition cursor-pointer">
                                    Ouvrir
                                </button>
                                <button type="button" onclick="createSuggestedNewAlbum(${eIdx})"
                                        class="plum-btn px-4 py-1.5 rounded-full text-xs font-extrabold cursor-pointer">
                                    Créer (${ev.item_count})
                                </button>
                            </div>
                        </div>`;
                    }).join('')}
                </div>
            </section>`;
    }

    let mediaHtml = '';
    if (items.length) {
        const colsCls = _getSugGridColsClass();
        let innerMedia = '';
        if (_sugPageState.layout === 'MASONRY') {
            const colCount = _getSugMasonryColCount();
            const cols = Array.from({ length: colCount }, () => []);
            const heights = new Array(colCount).fill(0);
            items.forEach((it, idx) => {
                let bestC = 0;
                for (let c = 1; c < colCount; c++) {
                    if (heights[c] < heights[bestC] - 1e-6) bestC = c;
                }
                heights[bestC] += (it.width && it.height && it.width > 0) ? (it.height / it.width) : 1.0;
                cols[bestC].push(_renderSugMediaTile(it, idx));
            });
            innerMedia = cols.map(buf => `<div class="masonry-col">${buf.join('')}</div>`).join('');
        } else {
            innerMedia = items.map((it, idx) => _renderSugMediaTile(it, idx)).join('');
        }
        const heading = (kind === 'albums' && newEvents.length)
            ? `<h3 class="text-xs font-extrabold uppercase tracking-wider opacity-70 px-1">Ajouts à vos albums existants (${items.length})</h3>`
            : '';
        mediaHtml = `<section class="space-y-3">${heading}<div class="${colsCls}">${innerMedia}</div></section>`;
    }

    const hasSel = _sugPageState.selected.size > 0;
    cont.className = `space-y-6 pb-10 ${hasSel ? 'selection-active' : ''}`.trim();
    cont.innerHTML = `${previewBannerHtml}${eventsHtml}${mediaHtml}`;
    updateSugBatchBar();
}

async function createSuggestedNewAlbum(eventIdx, customName = null, overrideSourcePaths = null) {
    const ev = (_sugPageState.newEvents || [])[eventIdx];
    const targetName = (customName || ev?.suggested_name || '').trim();
    const targetPaths = (Array.isArray(overrideSourcePaths) && overrideSourcePaths.length)
        ? overrideSourcePaths
        : (Array.isArray(ev?.source_paths) ? ev.source_paths : []);
    if (!ev || !targetName || !targetPaths.length) return;
    await fetch('/api/albums/create', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: targetName}),
    }).catch(() => {});
    const res = await fetch('/api/gallery/batch_action', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({source_paths: targetPaths, action: 'ADD_TO_ALBUM', album_name: targetName}),
    });
    if (res.ok) {
        _sugPageState.previewEventIdx = null;
        _sugPageState.selected.clear();
        if (typeof showAppToast === 'function') showAppToast(`Album « ${targetName} » créé (${targetPaths.length} médias).`, 'success');
        await loadStats();
        await loadGalleryFilters();
        await loadToolsSuggestionsSummary();
        await openSuggestionPage('albums', true);
    }
}

async function runSugBatchPrimaryAction() {
    const kind = _sugPageState.kind;
    if (kind === 'albums') {
        if (_sugPageState.previewEventIdx !== null) return createSuggestedNewAlbumFromPreview();
        return applySelectedAlbumSuggestions();
    }
    if (kind === 'rotation') return applySelectedRotationSuggestions();
    if (kind === 'missing_gps') return applySelectedGpsSuggestions();
    if (kind === 'screenshots') return archiveSelectedScreenshotsToDocs();
}

function runSugPagePrimaryAction() {
    return runSugBatchPrimaryAction();
}

async function applySelectedAlbumSuggestions() {
    const selected = (_sugPageState.items || []).filter(it => it.source_path && _sugPageState.selected.has(it.source_path) && it.suggested_album);
    if (!selected.length) return;
    const grouped = new Map();
    selected.forEach(it => {
        if (!grouped.has(it.suggested_album)) grouped.set(it.suggested_album, []);
        grouped.get(it.suggested_album).push(it.source_path);
    });
    for (const [albumName, paths] of grouped.entries()) {
        await fetch('/api/gallery/batch_action', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({source_paths: paths, action: 'ADD_TO_ALBUM', album_name: albumName}),
        });
    }
    _sugPageState.selected.clear();
    if (typeof showAppToast === 'function') showAppToast(`${selected.length} fichier(s) ajouté(s) aux albums suggérés.`, 'success');
    await loadStats();
    await loadToolsSuggestionsSummary();
    await openSuggestionPage('albums', true);
}

async function _postRotationApply(payloadItems, successLabel) {
    const res = await fetch('/api/tools/suggestions/apply_rotation', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({items: payloadItems}),
    });
    if (res.ok) {
        _toolsThumbVersion = Date.now();
        _sugPageState.selected.clear();
        if (typeof showAppToast === 'function') showAppToast(successLabel, 'success');
        await loadStats();
        await loadToolsSuggestionsSummary();
        await openSuggestionPage('rotation', true);
    }
}

async function applySingleRotationSuggestion(sortedIdx, angleDeg) {
    const it = (_sugPageState.sortedItems || [])[sortedIdx];
    if (!it || !it.source_path) return;
    await _postRotationApply([{source_path: it.source_path, rotate: angleDeg}], `Photo pivotée de +${angleDeg}°.`);
}

async function dismissRotationSuggestion(sortedIdx) {
    const it = (_sugPageState.sortedItems || [])[sortedIdx];
    if (!it || !it.source_path) return;
    await _postRotationApply([{source_path: it.source_path, rotate: 0}], 'Suggestion ignorée.');
}

async function applySelectedRotationSuggestions() {
    const selected = (_sugPageState.items || []).filter(it => it.source_path && _sugPageState.selected.has(it.source_path));
    if (!selected.length) return;
    const payload = selected.map(it => ({source_path: it.source_path, rotate: Number(it.suggested_rotation || 90)}));
    await _postRotationApply(payload, `${selected.length} photo(s) pivotée(s).`);
}

async function applySelectedGpsSuggestions() {
    const selected = (_sugPageState.items || []).filter(
        it => it.source_path && _sugPageState.selected.has(it.source_path) && it.suggested_lat !== undefined && it.suggested_lon !== undefined
    );
    if (!selected.length) return;
    const res = await fetch('/api/tools/suggestions/apply_gps', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            items: selected.map(it => ({
                source_path: it.source_path,
                latitude: Number(it.suggested_lat),
                longitude: Number(it.suggested_lon),
            })),
        }),
    });
    if (res.ok) {
        _sugPageState.selected.clear();
        if (typeof showAppToast === 'function') showAppToast(`Localisation appliquée à ${selected.length} média(s).`, 'success');
        await loadStats();
        await loadToolsSuggestionsSummary();
        await openSuggestionPage('missing_gps', true);
    }
}

async function archiveSelectedScreenshotsToDocs() {
    const paths = Array.from(_sugPageState.selected || []);
    if (!paths.length) return;
    await fetch('/api/albums/create', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: 'Documents'}),
    }).catch(() => {});
    const res = await fetch('/api/gallery/batch_action', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({source_paths: paths, action: 'ADD_TO_ALBUM', album_name: 'Documents'}),
    });
    if (res.ok) {
        _sugPageState.selected.clear();
        if (typeof showAppToast === 'function') showAppToast(`${paths.length} fichier(s) classé(s) dans « Documents ».`, 'success');
        await loadStats();
        await loadGalleryFilters();
        await loadToolsSuggestionsSummary();
        await openSuggestionPage('screenshots', true);
    }
}

async function mergeSuggestedPersonsPair(pid1, pid2, encodedBestName) {
    const targetName = decodeURIComponent(encodedBestName || '');
    const res = await fetch('/api/persons/merge', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({person_ids: [pid1, pid2], target_name: targetName !== 'Inconnu' ? targetName : ''}),
    });
    if (res.ok) {
        if (typeof showAppToast === 'function') showAppToast('Personnes fusionnées.', 'success');
        await loadStats();
        await loadToolsSuggestionsSummary();
        await openSuggestionPage('people', true);
    }
}

async function renameSuggestedUnknownPerson(personId) {
    const inp = document.getElementById(`sug-person-name-${personId}`);
    const newName = (inp?.value || '').trim();
    if (!newName) {
        if (typeof showAppToast === 'function') showAppToast('Saisissez un prénom ou nom.', 'info');
        return;
    }
    const res = await fetch('/api/person/rename', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({person_id: Number(personId), new_name: newName}),
    });
    if (res.ok) {
        if (typeof showAppToast === 'function') showAppToast(`Personne nommée « ${newName} ».`, 'success');
        await loadStats();
        await loadToolsSuggestionsSummary();
        await openSuggestionPage('people', true);
    }
}

async function trashSelectedSugItems() {
    const paths = Array.from(_sugPageState.selected || []);
    if (!paths.length) return;
    if (!confirm(`Déplacer ${paths.length} média(s) sélectionné(s) vers la corbeille ?`)) return;
    const res = await fetch('/api/trash/action', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({source_paths: paths, action: 'MOVE_TO_TRASH'}),
    });
    if (res.ok) {
        _sugPageState.selected.clear();
        if (typeof showAppToast === 'function') showAppToast(`${paths.length} fichier(s) déplacé(s) vers la corbeille.`, 'info');
        await loadStats();
        await loadToolsSuggestionsSummary();
        await openSuggestionPage(_sugPageState.kind, true);
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
            _revealAnalysisProgressCard(st.active_task);
            _syncToolsSuggestionsProgressCard(st);
            pipelineRefreshTicks++;
            if (pipelineRefreshTicks % 3 === 0) {
                loadStats();
                if (currentTab === 'tools') loadToolsSuggestionsSummary();
            }
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
            _syncToolsSuggestionsProgressCard(st);
            pipelineRefreshTicks = 0;
        }

        if (wasPipelineRunning && !st.is_running) {
            await loadStats();
            await loadToolsSuggestionsSummary();
            await loadGalleryFilters();
            refreshActiveMediaView();
            loadActivitiesHistory();
        }
        wasPipelineRunning = st.is_running;
    } catch (e) {}
}, 1000);

window.addEventListener('DOMContentLoaded', async () => {
    currentUiOled = localStorage.getItem('phototo_oled') === 'on';
    const savedTheme = localStorage.getItem('phototo_theme') || 'light';
    setAppTheme(savedTheme);
    if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if (currentUiThemeMode === 'system') setAppTheme('system');
        });
    }
    setAppNoShadows(localStorage.getItem('phototo_no_shadows') === 'off', false);
    const savedStyle = localStorage.getItem('phototo_ui_style') || (localStorage.getItem('phototo_ui_blur') === 'off' ? 'solid' : 'glass');
    setAppStyle(savedStyle, false);
    setAppLightboxStyle(localStorage.getItem('phototo_lightbox_style') || 'studio', false);
    currentUiAccentCustom = localStorage.getItem('phototo_accent_custom') || '#6366f1';
    _applyCustomAccentCssVars(currentUiAccentCustom);
    const savedAccent = localStorage.getItem('phototo_accent') || 'default';
    setAppAccent(savedAccent, false);
    setAppFavMatchAccent(localStorage.getItem('phototo_fav_match_accent') === 'on', false);
    setAppTileRadius(localStorage.getItem('phototo_tile_radius') || 'rounded', false);
    setAppGridGap(localStorage.getItem('phototo_grid_gap') || 'normal', false);
    setAppReduceMotion(localStorage.getItem('phototo_reduce_motion') === 'off', false);
    await loadAppSettings();
    await loadLibrariesDropdown();
    await loadActivitiesHistory();
    await loadStats();
    await loadGalleryFilters();
    await loadGalleryItems();
    document.body.classList.toggle('has-gallery-timeline', currentTab === 'gallery' || currentTab === 'recent');
    await loadGalleryTimeline();
});

