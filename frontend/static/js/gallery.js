// ==================== GALERIE : DÉFILEMENT INFINI, MINIATURES WEBP & SÉLECTION RAPIDE ====================

let galleryPage = 1, galleryTotalPages = 1, galleryTotalItems = 0;
let galleryIsLoading = false;
let _pendingGalleryCustomSkip = null;
let selectedGalleryPaths = new Set();
let currentGalleryItems = [];
let lastClickedGalleryIdx = null;
let lastRenderedGroupTitle = {};

let singleAlbumIsLoading = false;
let singleAlbumTotalItems = 0;
let lightboxIsCustomItem = false;
let currentLightboxDupGroup = null;
let _lbDupLookupSeq = 0;
let infiniteScrollObserver = null;

let currentSkipOffset = 0;
let cachedTimelineData = [];
let cachedTimelineTotalDated = 0;
let _timelineMonthSegments = [];

let galleryLayout = localStorage.getItem('phototo_gallery_layout') || 'GRID';    // 'GRID' | 'MASONRY' | 'LIST'
let gallerySize = localStorage.getItem('phototo_gallery_size') || 'MD';        // 'SM' | 'MD' | 'LG'
let galleryGroupBy = 'NONE';   // 'NONE' | 'DAY' | 'WEEK' | 'MONTH' | 'YEAR'

const SHORT_MONTHS_FR = ["", "janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const TIMELINE_MONTHS_FR = ["", "Jan", "Fév", "Mar", "Avr", "Mai", "Jun", "Jul", "Aoû", "Sep", "Oct", "Nov", "Déc"];
const FULL_MONTHS_FR = ["", "Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];

function getSelectIconHTML(isSelected, isList = false) {
    if (isSelected) {
        return `<div class="select-badge-checked w-7 h-7 rounded-full flex items-center justify-center scale-100 transition-all duration-150">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
                </div>`;
    }
    if (isList) {
        return `<div class="select-badge-idle w-7 h-7 rounded-full ui-pill flex items-center justify-center opacity-55 group-hover:opacity-100 hover:bg-[var(--bg-hover)] transition-all duration-150">
                    <svg class="w-3.5 h-3.5 opacity-70" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
                </div>`;
    }
    return `<div class="select-badge-idle w-7 h-7 rounded-full border border-white/25 bg-black/40 backdrop-blur-md flex items-center justify-center text-white/85 opacity-0 group-hover:opacity-100 hover:bg-black/60 hover:scale-105 transition-all duration-150 shadow-md">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
            </div>`;
}

function getFavHeartHTML(isFav, isList = false) {
    if (isFav) {
        const cls = isList
            ? 'fav-badge-active w-7 h-7 rounded-full bg-rose-500/20 border border-rose-400/50 text-rose-500 flex items-center justify-center shadow-sm transition-all duration-150'
            : 'fav-badge-active w-7 h-7 rounded-full bg-rose-500/25 backdrop-blur-md border border-rose-400/60 text-rose-400 hover:bg-rose-500/35 flex items-center justify-center shadow-md transition-all duration-150';
        return `<div class="${cls}">
                    <svg class="w-3.5 h-3.5" fill="currentColor" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24">
                        <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21.3l7.8-7.8 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>
                    </svg>
                </div>`;
    }
    const idleCls = isList
        ? 'w-7 h-7 rounded-full ui-pill opacity-60 group-hover:opacity-100 hover:text-rose-400 flex items-center justify-center transition-all duration-150'
        : 'w-7 h-7 rounded-full bg-black/40 backdrop-blur-md border border-white/25 text-white/90 hover:bg-black/60 hover:text-rose-400 flex items-center justify-center shadow-md transition-all duration-150';
    return `<div class="${idleCls}">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
                    <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21.3l7.8-7.8 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>
                </svg>
            </div>`;
}

function syncGalleryLayoutSizeButtons() {
    ['GRID', 'MASONRY', 'LIST'].forEach(l => {
        const b = document.getElementById(`layout-btn-${l}`);
        if (b) {
            b.classList.toggle('nav-item-active', l === galleryLayout);
            b.classList.toggle('ui-pill', l !== galleryLayout);
        }
    });
    ['SM', 'MD', 'LG'].forEach(s => {
        const b = document.getElementById(`size-btn-${s}`);
        if (b) {
            b.classList.toggle('nav-item-active', s === gallerySize);
            b.classList.toggle('ui-pill', s !== gallerySize);
        }
    });
}

function _getActiveMediaPrefKey(kind) {
    const scope = (typeof currentTab !== 'undefined' && (currentTab === 'favorites' || currentTab === 'recent'))
        ? currentTab
        : 'gallery';
    return `phototo_${scope}_${kind}`;
}

function syncActiveMediaPrefsFromStorage(tabOverride = null) {
    const scope = tabOverride || ((typeof currentTab !== 'undefined' && (currentTab === 'favorites' || currentTab === 'recent')) ? currentTab : 'gallery');
    galleryLayout = localStorage.getItem(`phototo_${scope}_layout`) || 'GRID';
    gallerySize = localStorage.getItem(`phototo_${scope}_size`) || 'MD';
    syncGalleryLayoutSizeButtons();
}

function setGalleryLayout(layout) {
    galleryLayout = layout;
    localStorage.setItem(_getActiveMediaPrefKey('layout'), layout);
    syncGalleryLayoutSizeButtons();
    refreshActiveMediaView();
}

function setGallerySize(size) {
    gallerySize = size;
    localStorage.setItem(_getActiveMediaPrefKey('size'), size);
    syncGalleryLayoutSizeButtons();
    refreshActiveMediaView();
}

document.addEventListener('DOMContentLoaded', syncGalleryLayoutSizeButtons);

function onChangeGroupBy(groupMode) {
    galleryGroupBy = groupMode;
    updateFloatingGroupPill();
    refreshActiveMediaView();
}

function formatGroupHeading(ts, mode) {
    if (!ts || ts === 0) return 'Date inconnue';
    const dt = new Date(ts * 1000);
    if (mode === 'YEAR') {
        return String(dt.getFullYear());
    }
    if (mode === 'WEEK') {
        const day = dt.getDay();
        const diff = dt.getDate() - day + (day === 0 ? -6 : 1);
        const monday = new Date(dt);
        monday.setDate(diff);
        const s = monday.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
        return `Semaine du ${s}`;
    }
    if (mode === 'DAY') {
        return formatDayGroupTitle(ts);
    }
    return formatMonthGroupTitle(ts);
}

function _escTileText(str) {
    return String(str || '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function _formatBytesShort(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

function getGalleryGridClass() {
    if (galleryLayout === 'LIST') {
        if (gallerySize === 'SM') return 'group-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2';
        if (gallerySize === 'LG') return 'group-grid grid grid-cols-1 lg:grid-cols-2 gap-3.5';
        return 'group-grid grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5';
    }
    if (galleryLayout === 'MASONRY') {
        const sizeCls = gallerySize === 'SM' ? 'masonry-sm' : (gallerySize === 'LG' ? 'masonry-lg' : '');
        return `group-grid masonry-grid ${sizeCls}`.trim();
    }
    if (gallerySize === 'SM') return 'group-grid grid grid-cols-3 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-2.5';
    if (gallerySize === 'LG') return 'group-grid grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-3 gap-5';
    return 'group-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4';
}

function renderSingleMediaTile(it, idx, layoutMode = galleryLayout) {
    const srcEnc = encodeURIComponent(it.source_path);
    const isSel = selectedGalleryPaths.has(it.source_path);
    const thumbUrl = `/thumb?path=${encodeURIComponent(it.dest_path)}`;
    const isVid = isVideoFile(it.dest_path);
    const durText = formatDuration(it.duration_sec);

    const borderClass = isSel ? 'tile-selected' : '';

    const favVisibility = it.is_favorite ? 'opacity-100' : 'opacity-0 group-hover:opacity-100';

    const selectBtn = `
        <button type="button"
                onclick="event.stopPropagation(); handleGalleryTileSelect(event, ${idx})"
                title="Sélectionner"
                class="tile-select-btn absolute top-2.5 left-2.5 z-10 cursor-pointer">
            ${getSelectIconHTML(isSel, false)}
        </button>`;

    const favBtn = `
        <button type="button"
                onclick="event.stopPropagation(); toggleTileFavoriteDirect(${idx})"
                title="Favori"
                class="tile-fav-btn absolute top-2.5 right-2.5 z-10 ${favVisibility} hover:scale-105 transition cursor-pointer">
            ${getFavHeartHTML(it.is_favorite, false)}
        </button>`;

    const videoBadge = isVid
        ? `<div class="absolute bottom-2.5 left-2.5 z-10 bg-black/30 backdrop-blur-sm text-white/95 text-[10px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full flex items-center gap-1 pointer-events-none">
             <svg class="w-2.5 h-2.5 opacity-90" fill="currentColor" viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>
             <span>${durText}</span>
           </div>`
        : '';

    if (layoutMode === 'LIST') {
        const fileName = _escTileText((it.dest_path || it.source_path || '').split(/[\\/]/).pop());
        const dtStr = it.timestamp ? new Date(it.timestamp * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Date inconnue';
        const modTs = it.modified_ts || it.timestamp || 0;
        const modStr = modTs ? new Date(modTs * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
        const dimStr = (it.width && it.height) ? `${it.width}×${it.height}` : '';
        const sizeStr = _formatBytesShort(it.file_size);
        const albStr = it.album_name ? _escTileText(it.album_name) : '';

        const thumbSizeCls = gallerySize === 'SM' ? 'w-11 h-11 rounded-xl' : (gallerySize === 'LG' ? 'w-24 h-24 rounded-2xl' : 'w-16 h-16 rounded-2xl');
        const padCls = gallerySize === 'SM' ? 'p-2 gap-2.5 rounded-2xl' : (gallerySize === 'LG' ? 'p-3.5 gap-4 rounded-3xl' : 'p-2.5 gap-3.5 rounded-2xl');
        const titleCls = gallerySize === 'SM' ? 'text-xs' : (gallerySize === 'LG' ? 'text-base' : 'text-sm');

        const listSelectBorder = isSel ? 'tile-selected-list' : '';
        const metaParts = [dtStr, dimStr, sizeStr].filter(Boolean).join(' • ');

        return `
        <div id="media-tile-${idx}" data-tile-idx="${idx}" data-ts="${it.timestamp || 0}" data-source="${srcEnc}" onclick="openLightbox(${idx})"
             class="media-tile ui-card group flex items-center ${padCls} cursor-pointer shadow-sm transition-all duration-150 ${listSelectBorder}">
            <button type="button"
                    onclick="event.stopPropagation(); handleGalleryTileSelect(event, ${idx})"
                    title="Sélectionner"
                    class="tile-select-btn shrink-0 cursor-pointer">
                ${getSelectIconHTML(isSel, true)}
            </button>
            <div class="relative shrink-0 ${thumbSizeCls} overflow-hidden bg-black/10">
                <img src="${thumbUrl}" loading="lazy" decoding="async" class="w-full h-full object-cover select-none pointer-events-none"/>
                ${isVid ? `<span class="absolute bottom-1 left-1 bg-black/35 backdrop-blur-sm text-white/95 text-[9px] font-semibold tabular-nums px-1.5 py-[1px] rounded-full pointer-events-none">${durText}</span>` : ''}
            </div>
            <div class="flex-1 min-w-0">
                <div class="font-bold truncate ${titleCls}">${fileName}</div>
                <div class="text-[11px] opacity-65 truncate mt-0.5">${metaParts}${modStr ? ` • Modifié : ${modStr}` : ''}</div>
                ${albStr ? `<div class="mt-1"><span class="ui-pill text-[10px] font-bold px-2 py-0.5 rounded-full">📁 ${albStr}</span></div>` : ''}
            </div>
            <button type="button"
                    onclick="event.stopPropagation(); toggleTileFavoriteDirect(${idx})"
                    title="Favori"
                    class="tile-fav-btn shrink-0 ${favVisibility} hover:scale-105 transition cursor-pointer">
                ${getFavHeartHTML(it.is_favorite, true)}
            </button>
        </div>`;
    }

    if (layoutMode === 'MASONRY' || layoutMode === true) {
        const aspectStyle = (it.width && it.height) ? `aspect-ratio: ${it.width} / ${it.height};` : '';
        return `
        <div id="media-tile-${idx}" data-tile-idx="${idx}" data-ts="${it.timestamp || 0}" data-source="${srcEnc}" onclick="openLightbox(${idx})" style="${aspectStyle}"
             class="media-tile masonry-item ui-card group relative w-full rounded-lg overflow-hidden cursor-pointer shadow-sm transition-all duration-150 ${borderClass}">
            <img src="${thumbUrl}" loading="lazy" decoding="async" class="w-full h-auto block group-hover:scale-[1.02] transition duration-300 select-none pointer-events-none"/>
            ${selectBtn}
            ${favBtn}
            ${videoBadge}
        </div>`;
    }

    return `
    <div id="media-tile-${idx}" data-tile-idx="${idx}" data-ts="${it.timestamp || 0}" data-source="${srcEnc}" onclick="openLightbox(${idx})"
         class="media-tile ui-card group relative aspect-square rounded-[24px] overflow-hidden cursor-pointer shadow-sm transition-all duration-150 ${borderClass}">
        <img src="${thumbUrl}" loading="lazy" decoding="async" class="w-full h-full object-cover group-hover:scale-[1.03] transition duration-300 select-none pointer-events-none"/>
        ${selectBtn}
        ${favBtn}
        ${videoBadge}
    </div>`;
}

function getMasonryColumnCount() {
    const w = window.innerWidth || 1280;
    if (gallerySize === 'SM') return w >= 1280 ? 8 : (w >= 768 ? 6 : 3);
    if (gallerySize === 'LG') return w >= 1280 ? 3 : (w >= 768 ? 2 : 1);
    return w >= 1280 ? 5 : (w >= 768 ? 4 : 2);
}

function _ensureMasonryColumns(gridEl) {
    const colCount = getMasonryColumnCount();
    if (!gridEl._masonryCols || gridEl._masonryCols.length !== colCount) {
        gridEl.innerHTML = '';
        gridEl._masonryCols = [];
        gridEl._colHeights = new Array(colCount).fill(0);
        for (let c = 0; c < colCount; c++) {
            const colDiv = document.createElement('div');
            colDiv.className = 'masonry-col';
            gridEl.appendChild(colDiv);
            gridEl._masonryCols.push(colDiv);
        }
    }
    return gridEl._masonryCols;
}

function _appendMasonryTilesBatch(gridEl, itemsWithIdx) {
    const cols = _ensureMasonryColumns(gridEl);
    const heights = gridEl._colHeights;
    const buffers = cols.map(() => []);
    for (let i = 0; i < itemsWithIdx.length; i++) {
        const { item, idx } = itemsWithIdx[i];
        let bestCol = 0;
        for (let c = 1; c < heights.length; c++) {
            if (heights[c] < heights[bestCol] - 1e-6) bestCol = c;
        }
        const ratio = (item.width && item.height && item.width > 0) ? (item.height / item.width) : 1.0;
        heights[bestCol] += ratio;
        buffers[bestCol].push(renderSingleMediaTile(item, idx, 'MASONRY'));
    }
    for (let c = 0; c < cols.length; c++) {
        if (buffers[c].length) cols[c].insertAdjacentHTML('beforeend', buffers[c].join(''));
    }
}

function appendMediaBatchToContainer(containerId, newItems, startIndex, reset = false) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (reset) {
        container.innerHTML = '';
        lastRenderedGroupTitle[containerId] = null;
    }

    if ((!newItems || newItems.length === 0) && startIndex === 0) {
        container.innerHTML = `<div class="ui-card rounded-3xl p-8 text-center text-sm font-semibold opacity-60">Aucun média à afficher.</div>`;
        return;
    }

    const gridClass = getGalleryGridClass();
    const isMasonry = galleryLayout === 'MASONRY';

    if (galleryGroupBy === 'NONE') {
        let grid = container.querySelector('.group-grid');
        if (!grid) {
            container.innerHTML = `<div class="${gridClass}"></div>`;
            grid = container.querySelector('.group-grid');
        }
        if (isMasonry) {
            _appendMasonryTilesBatch(grid, newItems.map((it, i) => ({ item: it, idx: startIndex + i })));
        } else {
            const html = newItems.map((it, i) => renderSingleMediaTile(it, startIndex + i, galleryLayout)).join('');
            grid.insertAdjacentHTML('beforeend', html);
        }
        return;
    }

    newItems.forEach((it, i) => {
        const globalIdx = startIndex + i;
        const title = formatGroupHeading(it.timestamp, galleryGroupBy);

        if (title !== lastRenderedGroupTitle[containerId]) {
            lastRenderedGroupTitle[containerId] = title;
            const sectionHtml = `
                <div class="space-y-3 group-section">
                    <div class="flex items-center gap-2.5">
                        <button type="button" onclick="toggleGroupSectionSelection(this)" title="Tout sélectionner / désélectionner dans ce groupe"
                                class="group-select-btn shrink-0 flex items-center justify-center cursor-pointer">
                            ${getGroupSelectIconHTML('none')}
                        </button>
                        <h3 class="group-section-title text-sm font-extrabold opacity-80">${title}</h3>
                    </div>
                    <div class="${gridClass}"></div>
                </div>`;
            container.insertAdjacentHTML('beforeend', sectionHtml);
            const grids = container.querySelectorAll('.group-grid');
            const lastGrid = grids[grids.length - 1];
            if (lastGrid) {
                if (isMasonry) _appendMasonryTilesBatch(lastGrid, [{ item: it, idx: globalIdx }]);
                else lastGrid.insertAdjacentHTML('beforeend', renderSingleMediaTile(it, globalIdx, galleryLayout));
            }
        } else {
            const grids = container.querySelectorAll('.group-grid');
            const lastGrid = grids[grids.length - 1];
            if (lastGrid) {
                if (isMasonry) _appendMasonryTilesBatch(lastGrid, [{ item: it, idx: globalIdx }]);
                else lastGrid.insertAdjacentHTML('beforeend', renderSingleMediaTile(it, globalIdx, galleryLayout));
            }
        }
    });
}

async function loadGalleryFilters() {
    const res = await fetch('/api/gallery/filters');
    const d = await res.json();
    const ySel = document.getElementById('gal-year');
    const curY = ySel ? ySel.value : '';
    if (ySel) {
        ySel.innerHTML = `<option value="">Années</option>` + (d.years||[]).map(y => `<option value="${y.year}">${y.year} (${y.count})</option>`).join('');
        ySel.value = curY;
    }
    const albSel = document.getElementById('gal-album');
    if (albSel) {
        albSel.innerHTML = `<option value="">Tous les albums</option>` + (d.albums||[]).map(a => `<option value="${a}">${a}</option>`).join('');
    }
    const albDl = document.getElementById('albums-datalist');
    if (albDl) {
        albDl.innerHTML = (d.albums||[]).map(a => `<option value="${a}">`).join('');
    }
    const extSel = document.getElementById('gal-ext-select');
    if (extSel) {
        const curExt = extSel.value;
        extSel.innerHTML = `<option value="">Type</option>` + (d.extensions||[]).map(e => `<option value="${e}">${e}</option>`).join('');
        extSel.value = curExt;
    }
    if (typeof updateGalleryMonthDropdown === 'function') updateGalleryMonthDropdown();
}

let selectedFilterYears = [];
let selectedFilterMonths = [];
let selectedFilterTypes = [];
let selectedFilterExts = [];
let selectedFilterPeriods = [];

function _getActivePeriodsList() {
    const list = selectedFilterPeriods.slice();
    const df = document.getElementById('gal-date-from')?.value || '';
    const dt = document.getElementById('gal-date-to')?.value || '';
    if (df || dt) {
        const exists = list.some(p => p.from === df && p.to === dt);
        if (!exists) list.push({ from: df, to: dt });
    }
    return list;
}

function _getActivePeriodsParam() {
    return _getActivePeriodsList().map(p => `${p.from || ''}:${p.to || ''}`).join(',');
}

function toggleMultiFilterValue(kind, selectEl) {
    if (!selectEl || !selectEl.value) return;
    const val = selectEl.value;
    selectEl.value = '';
    const map = {
        year: selectedFilterYears,
        month: selectedFilterMonths,
        type: selectedFilterTypes,
        ext: selectedFilterExts
    };
    const arr = map[kind];
    if (!arr) return;
    const idx = arr.indexOf(val);
    if (idx >= 0) arr.splice(idx, 1);
    else arr.push(val);
    renderFilterChips();
    updateActiveFilterBadge();
    renderTimelineScrubberDOM();
    resetAndLoadGallery();
}

function addGalleryPeriodFromInputs() {
    const dfEl = document.getElementById('gal-date-from');
    const dtEl = document.getElementById('gal-date-to');
    const df = dfEl?.value || '';
    const dt = dtEl?.value || '';
    if (!df && !dt) return;
    const exists = selectedFilterPeriods.some(p => p.from === df && p.to === dt);
    if (!exists) selectedFilterPeriods.push({ from: df, to: dt });
    if (dfEl) dfEl.value = '';
    if (dtEl) dtEl.value = '';
    renderFilterChips();
    updateActiveFilterBadge();
    resetAndLoadGallery();
}

function removeMultiFilterChip(kind, idx) {
    if (kind === 'year') selectedFilterYears.splice(idx, 1);
    else if (kind === 'month') selectedFilterMonths.splice(idx, 1);
    else if (kind === 'type') selectedFilterTypes.splice(idx, 1);
    else if (kind === 'ext') selectedFilterExts.splice(idx, 1);
    else if (kind === 'period') selectedFilterPeriods.splice(idx, 1);
    renderFilterChips();
    updateActiveFilterBadge();
    renderTimelineScrubberDOM();
    resetAndLoadGallery();
}

function renderFilterChips() {
    const container = document.getElementById('gal-active-filter-chips');
    if (!container) return;
    const chips = [];
    selectedFilterYears.forEach((y, i) => chips.push({ kind: 'year', idx: i, label: y }));
    selectedFilterMonths.forEach((m, i) => chips.push({ kind: 'month', idx: i, label: SHORT_MONTHS_FR[parseInt(m, 10)] || m }));
    selectedFilterPeriods.forEach((p, i) => chips.push({ kind: 'period', idx: i, label: `${p.from || '…'} → ${p.to || '…'}` }));
    selectedFilterTypes.forEach((t, i) => chips.push({ kind: 'type', idx: i, label: t }));
    selectedFilterExts.forEach((e, i) => chips.push({ kind: 'ext', idx: i, label: e }));

    if (!chips.length) {
        container.innerHTML = '';
        container.classList.add('hidden');
        return;
    }
    container.classList.remove('hidden');
    container.innerHTML = chips.map(c =>
        `<span class="plum-btn px-2 py-0.5 rounded-full text-[10px] font-extrabold inline-flex items-center gap-1">
            <span>${c.label}</span>
            <button type="button" onclick="event.stopPropagation(); removeMultiFilterChip('${c.kind}', ${c.idx})" class="hover:text-rose-200 font-bold">✕</button>
        </span>`
    ).join('');
}

function _getActiveGalleryViewIds() {
    if (typeof currentTab !== 'undefined' && currentTab === 'favorites') {
        return {
            tabId: 'tab-favorites',
            areaId: 'favorites-content-area',
            totalId: 'fav-total-label',
            prevBarId: 'favorites-prev-bar',
            spinnerId: 'favorites-loading-spinner',
            sentinelId: 'favorites-scroll-sentinel',
            badgeId: 'favorites-active-filter-badge',
            badgeTextId: 'favorites-active-filter-text',
            headerId: 'favorites-sticky-header',
        };
    }
    return {
        tabId: 'tab-gallery',
        areaId: 'gallery-content-area',
        totalId: 'gal-total-label',
        prevBarId: 'gallery-prev-bar',
        spinnerId: 'gallery-loading-spinner',
        sentinelId: 'gallery-scroll-sentinel',
        badgeId: 'gallery-active-filter-badge',
        badgeTextId: 'gallery-active-filter-text',
        headerId: 'gallery-sticky-header',
    };
}

function updateActiveFilterBadge() {
    const viewIds = _getActiveGalleryViewIds();
    const badge = document.getElementById(viewIds.badgeId);
    const txt = document.getElementById(viewIds.badgeTextId);
    if (!badge || !txt) return;

    const parts = [];
    selectedFilterMonths.forEach(m => parts.push(SHORT_MONTHS_FR[parseInt(m, 10)] || m));
    selectedFilterYears.forEach(y => parts.push(y));
    _getActivePeriodsList().forEach(p => parts.push(`${p.from || '…'} → ${p.to || '…'}`));
    selectedFilterTypes.forEach(t => parts.push(t));
    selectedFilterExts.forEach(e => parts.push(e));
    if (currentExtFilter && !selectedFilterExts.includes(currentExtFilter)) parts.push(currentExtFilter);

    const countBadge = document.getElementById('gal-filter-count');
    if (countBadge) {
        if (parts.length > 0) {
            countBadge.textContent = String(parts.length);
            countBadge.classList.remove('hidden');
        } else {
            countBadge.classList.add('hidden');
        }
    }

    if (parts.length > 0) {
        txt.textContent = parts.join(' · ');
        badge.classList.remove('hidden');
        badge.classList.add('inline-flex');
    } else {
        badge.classList.add('hidden');
        badge.classList.remove('inline-flex');
    }
}

function toggleGalleryFilterMenu(forceState) {
    const pop = document.getElementById('gal-filter-popover');
    if (!pop) return;
    const willOpen = typeof forceState === 'boolean' ? forceState : pop.classList.contains('hidden');
    pop.classList.toggle('hidden', !willOpen);
}

document.addEventListener('click', (e) => {
    const wrapper = document.getElementById('gal-filter-wrapper');
    const pop = document.getElementById('gal-filter-popover');
    if (wrapper && pop && !pop.classList.contains('hidden') && !wrapper.contains(e.target)) {
        pop.classList.add('hidden');
    }
    const albWrapper = document.getElementById('alb-filter-wrapper');
    const albPop = document.getElementById('alb-filter-popover');
    if (albWrapper && albPop && !albPop.classList.contains('hidden') && !albWrapper.contains(e.target)) {
        albPop.classList.add('hidden');
    }
    const facesWrapper = document.getElementById('faces-filter-wrapper');
    const facesPop = document.getElementById('faces-filter-popover');
    if (facesWrapper && facesPop && !facesPop.classList.contains('hidden') && !facesWrapper.contains(e.target)) {
        facesPop.classList.add('hidden');
    }
    const placesWrapper = document.getElementById('places-filter-wrapper');
    const placesPop = document.getElementById('places-filter-popover');
    if (placesWrapper && placesPop && !placesPop.classList.contains('hidden') && !placesWrapper.contains(e.target)) {
        placesPop.classList.add('hidden');
    }
});

function onGalleryYearOrMonthSelectChange() {
    const y = document.getElementById('gal-year')?.value || '';
    const m = document.getElementById('gal-month')?.value || '';
    if (y || m) {
        const dfEl = document.getElementById('gal-date-from');
        const dtEl = document.getElementById('gal-date-to');
        if (dfEl) dfEl.value = '';
        if (dtEl) dtEl.value = '';
    }
    updateActiveFilterBadge();
    renderTimelineScrubberDOM();
    loadGalleryItems(false);
}

function onGalleryPeriodChange() {
    const sc = document.getElementById('main-scroll-container');
    if (sc) sc.scrollTop = 0;
    updateActiveFilterBadge();
    renderTimelineScrubberDOM();
    loadGalleryItems(false);
}

function resetAllGalleryFilters() {
    selectedFilterYears = [];
    selectedFilterMonths = [];
    selectedFilterTypes = [];
    selectedFilterExts = [];
    selectedFilterPeriods = [];
    const yEl = document.getElementById('gal-year');
    const mEl = document.getElementById('gal-month');
    const tEl = document.getElementById('gal-type-filter');
    const eEl = document.getElementById('gal-ext-select');
    const aEl = document.getElementById('gal-album');
    const dfEl = document.getElementById('gal-date-from');
    const dtEl = document.getElementById('gal-date-to');
    if (yEl) yEl.value = '';
    if (mEl) mEl.value = '';
    if (tEl) tEl.value = '';
    if (eEl) eEl.value = '';
    if (aEl) aEl.value = '';
    if (dfEl) dfEl.value = '';
    if (dtEl) dtEl.value = '';
    currentExtFilter = '';
    renderFilterChips();
    updateActiveFilterBadge();
    resetAndLoadGallery();
}

function resetAndLoadGallery() {
    galleryPage = 1;
    galleryTotalPages = 1;
    galleryTotalItems = 0;
    currentSkipOffset = 0;
    currentGalleryItems = [];
    const sc = document.getElementById('main-scroll-container');
    if (sc) sc.scrollTop = 0;
    updateActiveFilterBadge();
    loadGalleryItems(false);
    loadGalleryTimeline();
}

async function loadGalleryItems(append = false, customSkip = -1) {
    if (galleryIsLoading) {
        if (!append && customSkip >= 0) _pendingGalleryCustomSkip = customSkip;
        return;
    }
    if (append && galleryTotalItems > 0 && (currentSkipOffset + currentGalleryItems.length) >= galleryTotalItems) return;

    galleryIsLoading = true;
    const viewIds = _getActiveGalleryViewIds();
    const spinner = document.getElementById(viewIds.spinnerId);
    if (spinner) spinner.classList.remove('hidden');

    const targetPage = append ? galleryPage + 1 : 1;
    if (!append) galleryPage = 1;
    const effectiveSkip = (!append && customSkip >= 0)
        ? customSkip
        : (append ? currentSkipOffset + currentGalleryItems.length : 0);
    if (!append) currentSkipOffset = effectiveSkip;

    try {
        const p = new URLSearchParams({
            year: selectedFilterYears.join(','),
            month: selectedFilterMonths.join(','),
            periods: _getActivePeriodsParam(),
            album: document.getElementById('gal-album')?.value || '',
            media_type: selectedFilterTypes.join(','),
            ext_filter: selectedFilterExts.length ? selectedFilterExts.join(',') : (currentExtFilter || ''),
            favorites_only: document.getElementById('gal-fav')?.checked || false,
            no_faces_only: document.getElementById('gal-nofaces')?.checked || false,
            sort_by: document.getElementById('gal-sort-by')?.value || 'date',
            sort_order: document.getElementById('gal-sort-order')?.value || 'desc',
            page: targetPage,
            limit: 60,
            skip_to: effectiveSkip
        });
        if (currentTab === 'favorites' && typeof activeCustomGroupId !== 'undefined' && activeCustomGroupId.favorites !== null) {
            p.set('group_id', String(activeCustomGroupId.favorites));
        }
        const res = await fetch(`/api/gallery/items?${p.toString()}`);
        const d = await res.json();
        if (currentTab !== 'gallery' && currentTab !== 'favorites' && currentTab !== 'recent') return;
        const newItems = d.items || [];
        galleryTotalPages = d.total_pages || 1;
        galleryTotalItems = d.total || 0;
        lightboxIsCustomItem = false;
        if (append) galleryPage = targetPage;
        const totalLbl = document.getElementById(viewIds.totalId);
        if (totalLbl) totalLbl.textContent = `${galleryTotalItems} éléments`;

        if (!append) {
            currentGalleryItems = newItems;
            appendMediaBatchToContainer(viewIds.areaId, newItems, 0, true);
        } else {
            const startIdx = currentGalleryItems.length;
            currentGalleryItems.push(...newItems);
            appendMediaBatchToContainer(viewIds.areaId, newItems, startIdx, false);
            if (!document.getElementById('lightbox-modal')?.classList.contains('hidden')) {
                renderLightboxFilmstrip(currentLightboxIndex);
                const nextBtn = document.getElementById('lb-next-btn');
                if (nextBtn) nextBtn.classList.toggle('opacity-30', currentLightboxIndex >= currentGalleryItems.length - 1);
            }
        }
        updateGalleryBatchBar();
        updateGalleryPrevBar();
        requestAnimationFrame(() => {
            updateActiveTimelineFromScroll();
            updateFloatingGroupPill();
        });
    } finally {
        galleryIsLoading = false;
        if (spinner) spinner.classList.add('hidden');
        if (_pendingGalleryCustomSkip !== null) {
            const nextSkip = _pendingGalleryCustomSkip;
            _pendingGalleryCustomSkip = null;
            loadGalleryItems(false, nextSkip);
        }
    }
}

function updateGalleryPrevBar() {
    const bar = document.getElementById('gallery-prev-bar');
    if (bar) bar.classList.toggle('hidden', currentSkipOffset <= 0);
}

function jumpToGalleryTop() {
    const sc = document.getElementById('main-scroll-container');
    if (sc) sc.scrollTop = 0;
    loadGalleryItems(false, 0);
}

async function loadPreviousGalleryItems() {
    if (galleryIsLoading || currentSkipOffset <= 0) return;
    galleryIsLoading = true;
    const viewIds = _getActiveGalleryViewIds();
    const spinner = document.getElementById(viewIds.spinnerId);
    if (spinner) spinner.classList.remove('hidden');

    const prevLimit = Math.min(60, currentSkipOffset);
    const newSkip = currentSkipOffset - prevLimit;
    const sc = document.getElementById('main-scroll-container');
    const prevH = sc ? sc.scrollHeight : 0;
    const prevTop = sc ? sc.scrollTop : 0;

    try {
        const p = new URLSearchParams({
            year: selectedFilterYears.join(','),
            month: selectedFilterMonths.join(','),
            periods: _getActivePeriodsParam(),
            album: document.getElementById('gal-album')?.value || '',
            media_type: selectedFilterTypes.join(','),
            ext_filter: selectedFilterExts.length ? selectedFilterExts.join(',') : (currentExtFilter || ''),
            favorites_only: document.getElementById('gal-fav')?.checked || false,
            no_faces_only: document.getElementById('gal-nofaces')?.checked || false,
            sort_by: document.getElementById('gal-sort-by')?.value || 'date',
            sort_order: document.getElementById('gal-sort-order')?.value || 'desc',
            page: 1,
            limit: prevLimit,
            skip_to: newSkip
        });
        const res = await fetch(`/api/gallery/items?${p.toString()}`);
        const d = await res.json();
        const prevItems = d.items || [];
        if (prevItems.length > 0) {
            currentSkipOffset = newSkip;
            currentGalleryItems = [...prevItems, ...currentGalleryItems];
            appendMediaBatchToContainer(viewIds.areaId, currentGalleryItems, 0, true);
            if (sc) {
                const deltaH = sc.scrollHeight - prevH;
                sc.scrollTop = prevTop + Math.max(0, deltaH);
            }
        }
        updateGalleryBatchBar();
        updateGalleryPrevBar();
        requestAnimationFrame(() => {
            updateActiveTimelineFromScroll();
            updateFloatingGroupPill();
        });
    } finally {
        galleryIsLoading = false;
        if (spinner) spinner.classList.add('hidden');
        if (_pendingGalleryCustomSkip !== null) {
            const nextSkip = _pendingGalleryCustomSkip;
            _pendingGalleryCustomSkip = null;
            loadGalleryItems(false, nextSkip);
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const sc = document.getElementById('main-scroll-container');
    if (!sc) return;
    sc.addEventListener('wheel', (e) => {
        const galTab = document.getElementById('tab-gallery');
        if (!galTab || galTab.classList.contains('hidden')) return;
        if (e.deltaY < 0 && sc.scrollTop <= 5 && currentSkipOffset > 0 && !galleryIsLoading) {
            loadPreviousGalleryItems();
        }
    }, { passive: true });
});

function _getActiveMediaTileEl(idx) {
    let containerId = _getActiveGalleryViewIds().areaId;
    if (currentTab === 'albums' && openedAlbumName) containerId = 'album-single-content-area';
    else if (currentTab === 'faces' && typeof currentTimelinePersonId !== 'undefined' && currentTimelinePersonId !== null) containerId = 'tl-faces-grid';
    const container = document.getElementById(containerId);
    return (container && container.querySelector(`[data-tile-idx="${idx}"]`)) || document.getElementById(`media-tile-${idx}`);
}

function updateSingleTileSelectionDOM(idx, isSelected) {
    const tile = _getActiveMediaTileEl(idx);
    if (!tile) return;
    if (galleryLayout === 'LIST') {
        tile.classList.toggle('tile-selected-list', isSelected);
    } else {
        tile.classList.toggle('tile-selected', isSelected);
    }
    const btn = tile.querySelector('.tile-select-btn');
    if (btn) btn.innerHTML = getSelectIconHTML(isSelected, galleryLayout === 'LIST');
}

function updateSingleTileFavoriteDOM(idx, isFav) {
    const tile = _getActiveMediaTileEl(idx);
    if (!tile) return;
    const btn = tile.querySelector('.tile-fav-btn');
    if (!btn) return;
    btn.classList.toggle('opacity-100', !!isFav);
    btn.classList.toggle('opacity-0', !isFav);
    btn.innerHTML = getFavHeartHTML(!!isFav, galleryLayout === 'LIST');
}

function handleGalleryTileSelect(e, idx) {
    const item = currentGalleryItems[idx];
    if (!item || !item.source_path) return;
    const src = item.source_path;
    const willSelect = !selectedGalleryPaths.has(src);
    if (e && e.shiftKey && lastClickedGalleryIdx !== null) {
        const s = Math.min(lastClickedGalleryIdx, idx), end = Math.max(lastClickedGalleryIdx, idx);
        for (let i = s; i <= end; i++) {
            const it = currentGalleryItems[i];
            if (!it) continue;
            if (willSelect) selectedGalleryPaths.add(it.source_path);
            else selectedGalleryPaths.delete(it.source_path);
            updateSingleTileSelectionDOM(i, willSelect);
        }
    } else {
        if (willSelect) selectedGalleryPaths.add(src);
        else selectedGalleryPaths.delete(src);
        updateSingleTileSelectionDOM(idx, willSelect);
    }
    lastClickedGalleryIdx = idx;
    updateGalleryBatchBar();
}

async function toggleTileFavoriteDirect(idx) {
    const item = currentGalleryItems[idx];
    if (!item) return;
    const res = await fetch('/api/media/toggle_favorite', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({source_path: item.source_path})
    });
    if (res.ok) {
        const d = await res.json();
        item.is_favorite = d.is_favorite;
        updateSingleTileFavoriteDOM(idx, d.is_favorite);
        loadStats();
    }
}

function selectAllGalleryPage(chk) {
    if (!chk) {
        selectedGalleryPaths.clear();
        currentGalleryItems.forEach((_, idx) => updateSingleTileSelectionDOM(idx, false));
    } else {
        currentGalleryItems.forEach((it, idx) => {
            selectedGalleryPaths.add(it.source_path);
            updateSingleTileSelectionDOM(idx, true);
        });
    }
    updateGalleryBatchBar();
}

function getGroupSelectIconHTML(state) {
    if (state === 'all') {
        return `<div class="select-badge-checked w-5 h-5 rounded-full flex items-center justify-center transition-transform duration-150">
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
                </div>`;
    }
    if (state === 'partial') {
        return `<div class="select-badge-checked w-5 h-5 rounded-full flex items-center justify-center opacity-85 transition-transform duration-150">
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" viewBox="0 0 24 24"><line x1="6" y1="12" x2="18" y2="12"/></svg>
                </div>`;
    }
    return `<div class="w-5 h-5 rounded-full border border-current/15 bg-transparent opacity-35 hover:opacity-90 hover:bg-[var(--bg-pill)] hover:border-current/35 flex items-center justify-center transition-all duration-150">
                <svg class="w-2.5 h-2.5 opacity-80" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
            </div>`;
}

function _getGroupSectionSelectionState(sectionEl) {
    if (!sectionEl) return { state: 'none', indices: [] };
    const tiles = sectionEl.querySelectorAll('.media-tile[data-tile-idx]');
    const indices = [];
    let selected = 0;
    tiles.forEach(tile => {
        const idx = parseInt(tile.getAttribute('data-tile-idx'), 10);
        const it = currentGalleryItems[idx];
        if (!it || !it.source_path) return;
        indices.push(idx);
        if (selectedGalleryPaths.has(it.source_path)) selected++;
    });
    const state = (indices.length > 0 && selected === indices.length) ? 'all' : (selected > 0 ? 'partial' : 'none');
    return { state, indices };
}

function syncGroupSectionSelectionButtons() {
    document.querySelectorAll('.group-section .group-select-btn').forEach(btn => {
        const sec = btn.closest('.group-section');
        const { state } = _getGroupSectionSelectionState(sec);
        btn.innerHTML = getGroupSelectIconHTML(state);
    });
    const floatBtn = document.getElementById('floating-group-select-btn');
    if (floatBtn) {
        if (_activeFloatingGroupSection && !_activeFloatingGroupSection.closest('#albums-grid')) {
            const { state } = _getGroupSectionSelectionState(_activeFloatingGroupSection);
            floatBtn.innerHTML = getGroupSelectIconHTML(state);
            floatBtn.classList.remove('hidden');
        } else {
            floatBtn.classList.add('hidden');
        }
    }
}

function toggleGroupSectionElement(sectionEl) {
    if (!sectionEl) return;
    const { state, indices } = _getGroupSectionSelectionState(sectionEl);
    if (!indices.length) return;
    const willSelect = state !== 'all';
    indices.forEach(idx => {
        const it = currentGalleryItems[idx];
        if (!it || !it.source_path) return;
        if (willSelect) selectedGalleryPaths.add(it.source_path);
        else selectedGalleryPaths.delete(it.source_path);
        updateSingleTileSelectionDOM(idx, willSelect);
    });
    lastClickedGalleryIdx = null;
    updateGalleryBatchBar();
}

function toggleGroupSectionSelection(btn) {
    toggleGroupSectionElement(btn ? btn.closest('.group-section') : null);
}

function toggleActiveFloatingGroupSelection() {
    toggleGroupSectionElement(_activeFloatingGroupSection);
}

function syncBatchBarBounds() {
    const ctx = typeof _getActiveOptionsContext === 'function' ? _getActiveOptionsContext() : null;
    const header = ctx && ctx.headerId ? document.getElementById(ctx.headerId) : null;
    const drawer = ctx && ctx.drawerId ? document.getElementById(ctx.drawerId) : null;
    const stuckOptionsOpen = Boolean(
        header && header.classList.contains('is-stuck') &&
        drawer && !drawer.classList.contains('hidden')
    );
    let anyVisible = false;
    [document.getElementById('gal-batch-bar'), document.getElementById('trash-batch-bar'), document.getElementById('sug-batch-bar')].forEach(bar => {
        if (!bar) return;
        bar.style.top = '';
        bar.style.bottom = '';
        if (!bar.classList.contains('hidden')) {
            anyVisible = true;
            if (stuckOptionsOpen) {
                const drawerRect = drawer.getBoundingClientRect();
                const drawerHeight = Math.ceil(drawerRect.height || 44);
                bar.style.bottom = `${20 + drawerHeight + 10}px`;
            }
        }
    });
    document.body.classList.toggle('has-stuck-options-open', anyVisible && stuckOptionsOpen);
}

function updateGalleryBatchBar() {
    const mediaVisible = currentTab === 'gallery' || currentTab === 'favorites' || currentTab === 'recent'
        || (currentTab === 'albums' && !!openedAlbumName)
        || (currentTab === 'faces' && typeof currentTimelinePersonId !== 'undefined' && currentTimelinePersonId !== null)
        || (currentTab === 'map' && typeof _openedPlaceBucketIdx !== 'undefined' && _openedPlaceBucketIdx >= 0);
    const hasSelection = mediaVisible && selectedGalleryPaths.size > 0;
    const trashSelActive = currentTab === 'trash' && typeof selectedTrashPaths !== 'undefined' && selectedTrashPaths.size > 0;
    const sugSelActive = String(currentTab || '').startsWith('sug-') && typeof _sugPageState !== 'undefined' && _sugPageState.selected && _sugPageState.selected.size > 0;
    document.body.classList.toggle('has-batch-bar', hasSelection || trashSelActive || sugSelActive);
    document.getElementById('gal-batch-bar').classList.toggle('hidden', !hasSelection);
    document.getElementById('gal-batch-count').textContent = `${selectedGalleryPaths.size} sélectionné(s)`;
    const remBtn = document.getElementById('btn-batch-album-remove');
    if (remBtn) remBtn.classList.toggle('hidden', !openedAlbumName);
    const grpBtn = document.getElementById('gal-batch-group-btn');
    if (grpBtn) grpBtn.classList.toggle('hidden', currentTab !== 'favorites');
    ['gallery-content-area', 'favorites-content-area', 'album-single-content-area', 'tl-faces-grid', 'place-single-grid'].forEach(id => {
        const area = document.getElementById(id);
        if (area) area.classList.toggle('selection-active', hasSelection);
    });
    if (typeof updateTrashBatchBar === 'function') updateTrashBatchBar();
    syncGroupSectionSelectionButtons();
    syncBatchBarBounds();
    updateFloatingGroupPill();
}

async function runGalleryBatch(action, skipConfirm = false) {
    if (action === 'TRASH' && !skipConfirm) {
        openBatchTrashConfirm();
        return;
    }
    if (selectedGalleryPaths.size === 0) return;
    let alb = (document.getElementById('batch-album-input')?.value || '').trim();
    if (action === 'ALBUM_REMOVE' && !alb && openedAlbumName) {
        alb = openedAlbumName;
    }
    await fetch('/api/gallery/batch_action', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({source_paths: Array.from(selectedGalleryPaths), action, album_name: alb})
    });
    selectedGalleryPaths.clear();
    updateGalleryBatchBar();
    await loadGalleryFilters();
    refreshActiveMediaView();
    loadStats();
}

function getSelectedGalleryItems() {
    const bySrc = new Map();
    (currentGalleryItems || []).forEach(it => {
        if (it && it.source_path && selectedGalleryPaths.has(it.source_path)) {
            bySrc.set(it.source_path, it);
        }
    });
    return Array.from(selectedGalleryPaths).map(src => bySrc.get(src) || { source_path: src, dest_path: src });
}

async function downloadGalleryBatch() {
    const items = getSelectedGalleryItems();
    if (!items.length) return;
    if (items.length === 1 && items[0].dest_path) {
        const destPath = items[0].dest_path;
        const fName = destPath.split(/[\\/]/).pop() || 'media';
        _triggerDownloadHref(`/media?path=${encodeURIComponent(destPath)}`, fName);
        _recordClientMediaActivity('MEDIA_DOWNLOAD', 'Fichier téléchargé', `${fName} téléchargé`, [destPath]);
        return;
    }
    const res = await fetch('/api/gallery/batch_download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_paths: items.map(it => it.source_path) })
    });
    if (!res.ok) {
        alert('Impossible de télécharger la sélection.');
        return;
    }
    const blob = await res.blob();
    const disp = res.headers.get('Content-Disposition') || '';
    const match = disp.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
    const fileName = match ? decodeURIComponent(match[1]) : 'phototo_selection.zip';
    const url = URL.createObjectURL(blob);
    _triggerDownloadHref(url, fileName);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function shareGalleryBatch() {
    const items = getSelectedGalleryItems();
    if (!items.length) return;
    await _shareMediaItems(items);
}

// ==================== CASE TIMELINE DROITE (FILTRE AU CLIC ANNÉE / MOIS) ====================

async function loadGalleryTimeline() {
    if (typeof currentTab !== 'undefined' && currentTab === 'favorites') return;
    const scrubber = document.getElementById('gallery-timeline-box');
    const container = document.getElementById('timeline-items-container');
    if (!scrubber || !container) return;

    // Masquer aussi l'ancien timeline-scrubber flottant s'il existe encore dans index.html
    const oldFloating = document.getElementById('timeline-scrubber');
    if (oldFloating) oldFloating.classList.add('hidden');

    const p = new URLSearchParams({
        album: document.getElementById('gal-album')?.value || '',
        media_type: selectedFilterTypes.join(','),
        ext_filter: selectedFilterExts.length ? selectedFilterExts.join(',') : (currentExtFilter || ''),
        favorites_only: document.getElementById('gal-fav')?.checked || false,
        no_faces_only: document.getElementById('gal-nofaces')?.checked || false,
        sort_order: document.getElementById('gal-sort-order')?.value || 'desc'
    });

    const res = await fetch(`/api/gallery/timeline?${p.toString()}`);
    if (!res.ok) return;
    const d = await res.json();
    cachedTimelineData = d.timeline || [];
    cachedTimelineTotalDated = Number(d.total_dated || 0);
    if (typeof syncTimelineWrapperBounds === 'function') syncTimelineWrapperBounds();
    renderTimelineScrubberDOM();
}

let activeScrollTimelineYear = '';
let activeScrollTimelineMonth = '';
let activeScrollTileIdx = 0;
let _timelineScrollRaf = null;
let _isTimelineScrubbing = false;
let _timelineScrubTimer = null;
let _pendingScrubTarget = null;
let _lastScrubJumpOffset = -1;
let _timelineEventsBound = false;

function updateActiveTimelineFromScroll() {
    if (typeof currentTab !== 'undefined' && currentTab === 'favorites') return;
    const viewIds = _getActiveGalleryViewIds();
    const tabEl = document.getElementById(viewIds.tabId);
    const scroller = document.getElementById('main-scroll-container');
    const area = document.getElementById(viewIds.areaId);
    if (!tabEl || tabEl.classList.contains('hidden') || !scroller || !area) return;

    const scrollerRect = scroller.getBoundingClientRect();
    const probeTop = scrollerRect.top + 110;
    const tiles = area.querySelectorAll('.media-tile[data-ts]');
    let foundTs = 0;
    let foundTileIdx = activeScrollTileIdx;

    for (let i = 0; i < tiles.length; i++) {
        const ts = parseInt(tiles[i].getAttribute('data-ts') || '0', 10);
        if (!ts) continue;
        const rect = tiles[i].getBoundingClientRect();
        if (rect.bottom >= probeTop && rect.top <= scrollerRect.bottom) {
            foundTs = ts;
            foundTileIdx = parseInt(tiles[i].getAttribute('data-tile-idx') || String(i), 10) || 0;
            break;
        }
    }

    if (!foundTs) return;
    const dt = new Date(foundTs * 1000);
    const yr = String(dt.getFullYear());
    const mo = String(dt.getMonth() + 1).padStart(2, '0');

    if (yr !== activeScrollTimelineYear || mo !== activeScrollTimelineMonth || foundTileIdx !== activeScrollTileIdx) {
        activeScrollTimelineYear = yr;
        activeScrollTimelineMonth = mo;
        activeScrollTileIdx = foundTileIdx;
        _updateTimelineScrollPositionUI();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const scroller = document.getElementById('main-scroll-container');
    if (!scroller) return;
    scroller.addEventListener('scroll', () => {
        if (_timelineScrollRaf) return;
        _timelineScrollRaf = requestAnimationFrame(() => {
            _timelineScrollRaf = null;
            updateActiveTimelineFromScroll();
            updateFloatingGroupPill();
        });
    }, { passive: true });
});

let _activeFloatingGroupSection = null;

function _getActiveGroupedContainerAndMode() {
    if (currentTab === 'albums') {
        if (openedAlbumName) {
            return { container: document.getElementById('album-single-content-area'), mode: galleryGroupBy, headerId: 'album-single-sticky-header', drawerId: 'filter-drawer' };
        }
        const albMode = document.getElementById('alb-group-by')?.value || 'NONE';
        return { container: document.getElementById('albums-grid'), mode: albMode, headerId: 'albums-sticky-header', drawerId: 'albums-options-drawer' };
    }
    if (currentTab === 'faces') {
        if (typeof currentTimelinePersonId !== 'undefined' && currentTimelinePersonId !== null) {
            return { container: document.getElementById('tl-faces-grid'), mode: galleryGroupBy, headerId: 'person-single-sticky-header', drawerId: 'filter-drawer' };
        }
        const facesMode = document.getElementById('faces-group-by')?.value || 'NONE';
        return { container: document.getElementById('persons-identified-grid'), mode: facesMode, headerId: 'faces-sticky-header', drawerId: 'faces-options-drawer' };
    }
    if (currentTab === 'map') {
        if (typeof _openedPlaceBucketIdx !== 'undefined' && _openedPlaceBucketIdx >= 0) {
            return { container: document.getElementById('place-single-grid'), mode: galleryGroupBy, headerId: 'place-single-sticky-header', drawerId: 'filter-drawer' };
        }
        const placesMode = document.getElementById('places-group-by')?.value || 'NONE';
        return { container: document.getElementById('places-cards-grid'), mode: placesMode, headerId: 'places-sticky-header', drawerId: 'places-options-drawer' };
    }
    if (currentTab === 'dups') {
        const dupsMode = document.getElementById('dups-group-by')?.value || 'NONE';
        return { container: document.getElementById('dups-container'), mode: dupsMode, headerId: 'dups-sticky-header', drawerId: 'dups-options-drawer' };
    }
    if (currentTab === 'similar') {
        const simMode = document.getElementById('similar-group-by')?.value || 'NONE';
        return { container: document.getElementById('similar-container'), mode: simMode, headerId: 'similar-sticky-header', drawerId: 'similar-options-drawer' };
    }
    if (currentTab === 'gallery' || currentTab === 'favorites') {
        const viewIds = _getActiveGalleryViewIds();
        return { container: document.getElementById(viewIds.areaId), mode: galleryGroupBy, headerId: viewIds.headerId, drawerId: 'filter-drawer' };
    }
    return { container: null, mode: 'NONE', headerId: '', drawerId: '' };
}

function updateFloatingGroupPill() {
    const pill = document.getElementById('floating-group-pill');
    const scroller = document.getElementById('main-scroll-container');
    if (!pill || !scroller) return;

    const { container, mode, headerId, drawerId } = _getActiveGroupedContainerAndMode();
    if (!container || mode === 'NONE' || (scroller.scrollTop || 0) <= 64) {
        _activeFloatingGroupSection = null;
        pill.classList.add('hidden');
        pill.classList.remove('flex');
        return;
    }

    const topbarEl = document.getElementById('floating-topbar');
    let topAnchor = topbarEl ? Math.ceil(topbarEl.getBoundingClientRect().bottom + 10) : 90;
    const batchBar = document.getElementById('gal-batch-bar');
    if (batchBar && !batchBar.classList.contains('hidden')) {
        const bRect = batchBar.getBoundingClientRect();
        if (bRect.top < 220) topAnchor = Math.max(topAnchor, Math.ceil(bRect.bottom + 8));
    }
    const header = headerId ? document.getElementById(headerId) : null;
    const drawer = drawerId ? document.getElementById(drawerId) : null;
    if (header && header.classList.contains('is-stuck') && drawer && !drawer.classList.contains('hidden')) {
        const dRect = drawer.getBoundingClientRect();
        if (dRect.top < 220) topAnchor = Math.max(topAnchor, Math.ceil(dRect.bottom + 8));
    }

    const sections = container.querySelectorAll('.group-section');
    let matchedSection = null;
    let matchedLabel = '';
    for (let i = 0; i < sections.length; i++) {
        const sec = sections[i];
        const titleEl = sec.querySelector('.group-section-title');
        if (!titleEl || sec.offsetHeight < 260) continue;
        const tRect = titleEl.getBoundingClientRect();
        const sRect = sec.getBoundingClientRect();
        if (tRect.top < topAnchor - 4 && sRect.bottom > topAnchor + 56) {
            matchedSection = sec;
            matchedLabel = titleEl.textContent.trim();
        }
    }

    if (!matchedSection || !matchedLabel) {
        _activeFloatingGroupSection = null;
        pill.classList.add('hidden');
        pill.classList.remove('flex');
        return;
    }

    const cRect = container.getBoundingClientRect();
    const searchEl = document.getElementById('global-search-input');
    const alignedLeft = searchEl ? searchEl.getBoundingClientRect().left : cRect.left;
    _activeFloatingGroupSection = matchedSection;
    const lblBtn = document.getElementById('floating-group-label-btn');
    if (lblBtn) lblBtn.textContent = matchedLabel;
    pill.style.top = `${topAnchor}px`;
    pill.style.left = `${Math.round(alignedLeft)}px`;
    pill.classList.remove('hidden');
    pill.classList.add('flex');
    syncGroupSectionSelectionButtons();
}

function scrollToActiveGroupTop() {
    const scroller = document.getElementById('main-scroll-container');
    if (!scroller || !_activeFloatingGroupSection) return;
    const titleEl = _activeFloatingGroupSection.querySelector('.group-section-title');
    if (!titleEl) return;
    const topbarEl = document.getElementById('floating-topbar');
    const offset = topbarEl ? Math.ceil(topbarEl.getBoundingClientRect().height + 16) : 96;
    const target = Math.max(0, scroller.scrollTop + titleEl.getBoundingClientRect().top - offset);
    scroller.scrollTo({ top: target, behavior: 'smooth' });
}

function _getTimelineMetrics(scrubber) {
    const h = (scrubber ? scrubber.clientHeight : 0) || window.innerHeight - 110;
    const padTop = 16;
    const padBottom = 16;
    const usableH = Math.max(60, h - padTop - padBottom);
    return { h, padTop, padBottom, usableH };
}

function _buildTimelineSegments() {
    const total = cachedTimelineTotalDated || cachedTimelineData.reduce((s, y) => s + Number(y.count || 0), 0);
    const segs = [];
    if (!total || !cachedTimelineData.length) return { total: 0, segs };
    cachedTimelineData.forEach(yObj => {
        const months = Array.isArray(yObj.months) && yObj.months.length
            ? yObj.months
            : [{ month: '01', count: yObj.count || 1, offset: yObj.offset || 0 }];
        months.forEach(mObj => {
            const cnt = Number(mObj.count || 0);
            const off = Number(mObj.offset || 0);
            const mPad = String(mObj.month).padStart(2, '0');
            const mNum = parseInt(mObj.month, 10);
            const mName = (typeof SHORT_MONTHS_FR !== 'undefined' && SHORT_MONTHS_FR[mNum]) ? SHORT_MONTHS_FR[mNum] : mPad;
            segs.push({
                year: String(yObj.year),
                month: mPad,
                label: `${mName} ${yObj.year}`,
                offset: off,
                count: cnt,
                startRatio: off / total,
                endRatio: (off + cnt) / total,
            });
        });
    });
    return { total, segs };
}

function _findTimelineSegmentAtClientY(clientY) {
    const scrubber = document.getElementById('gallery-timeline-box');
    const wrapper = document.getElementById('gallery-timeline-wrapper');
    if (!scrubber || !wrapper || !_timelineMonthSegments.length) return null;
    const rect = scrubber.getBoundingClientRect();
    const wrapRect = wrapper.getBoundingClientRect();
    const { padTop, usableH } = _getTimelineMetrics(scrubber);
    const relY = Math.max(padTop, Math.min(rect.height - padTop, clientY - rect.top));
    const ratio = Math.max(0, Math.min(1, (relY - padTop) / usableH));
    let matched = _timelineMonthSegments[_timelineMonthSegments.length - 1];
    for (let i = 0; i < _timelineMonthSegments.length; i++) {
        if (ratio <= _timelineMonthSegments[i].endRatio + 1e-6) {
            matched = _timelineMonthSegments[i];
            break;
        }
    }
    const indicatorY = Math.max(14, Math.min(wrapRect.height - 14, clientY - wrapRect.top));
    return { seg: matched, indicatorY, ratio };
}

function _updateTimelineHoverIndicator(info) {
    const indicator = document.getElementById('timeline-hover-indicator');
    const pill = document.getElementById('timeline-hover-pill');
    if (!indicator || !pill || !info || !info.seg) return;
    pill.textContent = info.seg.label;
    indicator.style.top = `${Math.round(info.indicatorY)}px`;
    indicator.classList.remove('hidden');
}

function _hideTimelineHoverIndicator() {
    const indicator = document.getElementById('timeline-hover-indicator');
    if (indicator) indicator.classList.add('hidden');
}

function _updateTimelineScrollPositionUI() {
    const scrubber = document.getElementById('gallery-timeline-box');
    const container = document.getElementById('timeline-items-container');
    const marker = document.getElementById('timeline-scroll-marker');
    if (!scrubber || !container) return;

    const selectedYear = document.getElementById('gal-year')?.value || '';
    const activeYear = selectedYear || activeScrollTimelineYear || (cachedTimelineData[0] ? String(cachedTimelineData[0].year) : '');

    container.querySelectorAll('.tl-gp-year').forEach(el => {
        const yVal = el.getAttribute('data-year') || '';
        const isFiltered = Boolean(selectedYear && yVal === String(selectedYear));
        const isActive = Boolean(!selectedYear && yVal === String(activeYear));
        el.classList.toggle('tl-gp-year-filtered', isFiltered);
        el.classList.toggle('tl-gp-year-active', isActive);
    });

    if (marker && _timelineMonthSegments.length) {
        const total = cachedTimelineTotalDated || cachedTimelineData.reduce((s, y) => s + Number(y.count || 0), 0);
        const matchSeg = _timelineMonthSegments.find(s => s.year === String(activeYear) && (!activeScrollTimelineMonth || s.month === String(activeScrollTimelineMonth)))
            || _timelineMonthSegments.find(s => s.year === String(activeYear));
        if (matchSeg || total > 0) {
            const { padTop, usableH } = _getTimelineMetrics(scrubber);
            let posRatio = matchSeg ? (matchSeg.startRatio + matchSeg.endRatio) * 0.5 : 0;
            if (total > 1 && !selectedYear && (document.getElementById('gal-sort-by')?.value || 'date') === 'date') {
                const liveRatio = Math.max(0, Math.min(1, (currentSkipOffset + activeScrollTileIdx) / (total - 1)));
                posRatio = liveRatio;
            }
            marker.style.top = `${Math.round(padTop + posRatio * usableH)}px`;
            marker.classList.remove('hidden');
        } else {
            marker.classList.add('hidden');
        }
    } else if (marker) {
        marker.classList.add('hidden');
    }
}

function _scheduleScrubJump(info, immediate = false) {
    if (!info || !info.seg) return;
    const total = cachedTimelineTotalDated || cachedTimelineData.reduce((s, y) => s + Number(y.count || 0), 0);
    const exactOffset = total > 1 ? Math.max(0, Math.min(total - 1, Math.round(info.ratio * (total - 1)))) : 0;
    if (exactOffset === _lastScrubJumpOffset && !immediate) return;
    _pendingScrubTarget = { year: info.seg.year, month: info.seg.month, offset: exactOffset };
    const run = () => {
        if (!_pendingScrubTarget) return;
        const tgt = _pendingScrubTarget;
        _pendingScrubTarget = null;
        _lastScrubJumpOffset = tgt.offset;
        _jumpToTimelineOffset(tgt.year, tgt.month, tgt.offset);
    };
    if (immediate) {
        clearTimeout(_timelineScrubTimer);
        _timelineScrubTimer = null;
        run();
        return;
    }
    if (!_timelineScrubTimer) {
        _timelineScrubTimer = setTimeout(() => {
            _timelineScrubTimer = null;
            run();
        }, 90);
    }
}

function _initGooglePhotosTimelineScrubber() {
    if (_timelineEventsBound) return;
    const scrubber = document.getElementById('gallery-timeline-box');
    const wrapper = document.getElementById('gallery-timeline-wrapper');
    if (!scrubber || !wrapper) return;
    _timelineEventsBound = true;

    scrubber.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
        const info = _findTimelineSegmentAtClientY(e.clientY);
        if (!info) return;
        e.preventDefault();
        if (scrubber.setPointerCapture) {
            try { scrubber.setPointerCapture(e.pointerId); } catch (err) {}
        }
        _isTimelineScrubbing = true;
        wrapper.classList.add('is-scrubbing');
        _updateTimelineHoverIndicator(info);
        _scheduleScrubJump(info, true);
    });

    scrubber.addEventListener('pointermove', (e) => {
        const info = _findTimelineSegmentAtClientY(e.clientY);
        if (!info) return;
        _updateTimelineHoverIndicator(info);
        if (_isTimelineScrubbing) {
            _scheduleScrubJump(info, false);
        }
    });

    const endScrub = (e) => {
        if (!_isTimelineScrubbing) return;
        _isTimelineScrubbing = false;
        wrapper.classList.remove('is-scrubbing');
        if (scrubber.releasePointerCapture && e && e.pointerId !== undefined) {
            try { scrubber.releasePointerCapture(e.pointerId); } catch (err) {}
        }
        if (_pendingScrubTarget) {
            const tgt = _pendingScrubTarget;
            _pendingScrubTarget = null;
            clearTimeout(_timelineScrubTimer);
            _timelineScrubTimer = null;
            _lastScrubJumpOffset = tgt.offset;
            _jumpToTimelineOffset(tgt.year, tgt.month, tgt.offset);
        }
    };
    scrubber.addEventListener('pointerup', endScrub);
    scrubber.addEventListener('pointercancel', endScrub);
    scrubber.addEventListener('pointerleave', () => {
        if (!_isTimelineScrubbing) _hideTimelineHoverIndicator();
    });

    if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => {
            if (cachedTimelineData.length) renderTimelineScrubberDOM();
        });
        ro.observe(scrubber);
    }
}

function renderTimelineScrubberDOM() {
    _initGooglePhotosTimelineScrubber();
    const scrubber = document.getElementById('gallery-timeline-box');
    const container = document.getElementById('timeline-items-container');
    if (!scrubber || !container) return;

    const { total, segs } = _buildTimelineSegments();
    _timelineMonthSegments = segs;

    if (!cachedTimelineData.length || !total) {
        container.innerHTML = `<div class="w-full h-full flex items-center justify-center"><span class="text-[9px] opacity-40">—</span></div>`;
        _updateTimelineScrollPositionUI();
        return;
    }

    const { padTop, usableH } = _getTimelineMetrics(scrubber);
    const minGapPx = 24;
    const rawItems = cachedTimelineData.map(yObj => {
        const ratio = Math.max(0, Math.min(1, Number(yObj.offset || 0) / total));
        return { year: String(yObj.year), count: Number(yObj.count || 0), yPx: padTop + ratio * usableH };
    });

    // Répartition anti-chevauchement façon Google Photos : garde la première et la dernière année
    const placed = [];
    const totalYears = rawItems.length;
    const maxY = padTop + usableH;
    rawItems.forEach((item, i) => {
        const clampedY = Math.min(maxY, Math.max(padTop, item.yPx));
        if (i === 0) {
            placed.push({ ...item, yPx: padTop });
            return;
        }
        const isLast = i === totalYears - 1;
        if (isLast) {
            while (placed.length > 1 && (maxY - placed[placed.length - 1].yPx) < minGapPx) {
                placed.pop();
            }
            const safeLastY = Math.max(placed[placed.length - 1].yPx + 18, maxY);
            placed.push({ ...item, yPx: Math.min(maxY + 2, safeLastY) });
            return;
        }
        const prevY = placed[placed.length - 1].yPx;
        if (clampedY - prevY >= minGapPx && (maxY - clampedY) >= minGapPx) {
            placed.push({ ...item, yPx: clampedY });
        }
    });

    let html = '';
    for (let i = 0; i < placed.length; i++) {
        const cur = placed[i];
        html += `<span class="tl-gp-year" data-year="${cur.year}" style="top:${Math.round(cur.yPx)}px;" title="${cur.year} (${cur.count} médias)">${cur.year}</span>`;
        if (i < placed.length - 1) {
            const next = placed[i + 1];
            const gap = next.yPx - cur.yPx;
            if (gap >= 30) {
                const dots = Math.min(4, Math.floor((gap - 18) / 11));
                for (let d = 1; d <= dots; d++) {
                    const dy = cur.yPx + (gap * d) / (dots + 1);
                    html += `<span class="tl-gp-dot" style="top:${Math.round(dy)}px;"></span>`;
                }
            }
        }
    }

    container.innerHTML = html;
    _updateTimelineScrollPositionUI();
}

function _jumpToTimelineOffset(yearStr, monthCode = '', overrideOffset = null) {
    const yObj = cachedTimelineData.find(y => String(y.year) === String(yearStr));
    if (!yObj) return;
    let targetOffset = Number(yObj.offset || 0);
    let targetMonth = '';
    if (monthCode && Array.isArray(yObj.months)) {
        const mPad = String(monthCode).padStart(2, '0');
        const mObj = yObj.months.find(m => String(m.month).padStart(2, '0') === mPad);
        if (mObj) {
            targetOffset = Number(mObj.offset || 0);
            targetMonth = mPad;
        }
    }
    if (overrideOffset !== null && overrideOffset >= 0) {
        targetOffset = overrideOffset;
    }

    // La timeline navigue dans la galerie sans appliquer de filtre année/mois
    const ySel = document.getElementById('gal-year');
    const mSel = document.getElementById('gal-month');
    if (ySel && ySel.value) ySel.value = '';
    if (mSel && mSel.value) mSel.value = '';
    updateActiveFilterBadge();

    activeScrollTimelineYear = String(yearStr);
    activeScrollTimelineMonth = targetMonth || (yObj.months && yObj.months[0] ? String(yObj.months[0].month).padStart(2, '0') : '');
    _updateTimelineScrollPositionUI();

    const sc = document.getElementById('main-scroll-container');
    if (sc) sc.scrollTop = 0;
    loadGalleryItems(false, targetOffset);
}

function selectTimelineYear(yearStr) {
    _jumpToTimelineOffset(yearStr, '');
}

function selectTimelineMonth(yearStr, monthCode) {
    _jumpToTimelineOffset(yearStr, monthCode);
}

// ==================== VUE ALBUMS & SOUS-ALBUMS AVEC DÉFILEMENT INFINI ====================

let allAlbumsCache = [];
let rootAlbumsCache = [];
let openedAlbumObj = null;
let albumLayout = localStorage.getItem('phototo_album_layout') || 'GRID';  // 'GRID' | 'LIST'
let albumSize = localStorage.getItem('phototo_album_size') || 'MD';      // 'SM' | 'MD' | 'LG'

function syncAlbumLayoutSizeButtons() {
    ['GRID', 'LIST'].forEach(l => {
        const b = document.getElementById(`alb-layout-btn-${l}`);
        if (b) {
            b.classList.toggle('nav-item-active', l === albumLayout);
            b.classList.toggle('ui-pill', l !== albumLayout);
        }
    });
    ['SM', 'MD', 'LG'].forEach(s => {
        const b = document.getElementById(`alb-size-btn-${s}`);
        if (b) {
            b.classList.toggle('nav-item-active', s === albumSize);
            b.classList.toggle('ui-pill', s !== albumSize);
        }
    });
}

function setAlbumLayout(layout) {
    albumLayout = layout;
    localStorage.setItem('phototo_album_layout', layout);
    syncAlbumLayoutSizeButtons();
    renderAlbumsOverviewFromCache();
}

function setAlbumSize(size) {
    albumSize = size;
    localStorage.setItem('phototo_album_size', size);
    syncAlbumLayoutSizeButtons();
    renderAlbumsOverviewFromCache();
}

function _syncSortDirButtonUI(isAsc, btnId, arrowId) {
    const arrow = document.getElementById(arrowId);
    const btn = document.getElementById(btnId);
    if (arrow) arrow.classList.toggle('rotate-180', isAsc);
    if (btn) btn.title = isAsc ? 'Ordre croissant (cliquer pour inverser)' : 'Ordre décroissant (cliquer pour inverser)';
}

function _toggleSortOrderInput(inputId, btnId, arrowId, onChange) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const isAsc = input.value !== 'asc';
    input.value = isAsc ? 'asc' : 'desc';
    _syncSortDirButtonUI(isAsc, btnId, arrowId);
    if (typeof onChange === 'function') onChange();
}

function toggleGallerySortOrder() {
    _toggleSortOrderInput('gal-sort-order', 'gal-sort-dir-btn', 'gal-sort-arrow', refreshActiveMediaView);
}

function toggleAlbumSortOrder() {
    _toggleSortOrderInput('alb-sort-order', 'alb-sort-dir-btn', 'alb-sort-arrow', onAlbumControlsChanged);
}

function onAlbumControlsChanged() {
    renderAlbumsOverviewFromCache();
}

document.addEventListener('DOMContentLoaded', syncAlbumLayoutSizeButtons);

function getAlbumGridClass() {
    if (albumLayout === 'LIST') {
        if (albumSize === 'SM') return 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2';
        if (albumSize === 'LG') return 'grid grid-cols-1 lg:grid-cols-2 gap-3.5';
        return 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5';
    }
    if (albumSize === 'SM') return 'grid grid-cols-3 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-3';
    if (albumSize === 'LG') return 'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-3 gap-6';
    return 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-5';
}

function _compareAlbumItems(a, b, sortBy = 'date', sortOrder = 'desc') {
    const dir = sortOrder === 'asc' ? 1 : -1;
    if (sortBy === 'name') {
        return dir * (a.name || '').localeCompare(b.name || '', 'fr', { sensitivity: 'base' });
    }
    const field = sortBy === 'modified' ? 'modified_ts' : 'max_ts';
    const diff = (a[field] || 0) - (b[field] || 0);
    if (diff !== 0) return dir * diff;
    return dir * (a.name || '').localeCompare(b.name || '', 'fr', { sensitivity: 'base' });
}

function sortAlbumItems(albums) {
    const sortBy = document.getElementById('alb-sort-by')?.value || 'date';
    const sortOrder = document.getElementById('alb-sort-order')?.value || 'desc';
    return [...albums].sort((a, b) => _compareAlbumItems(a, b, sortBy, sortOrder));
}

function renderAlbumCardHTML(a) {
    const safeFull = a.full_path.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const safeName = a.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const escName = _escTileText(a.name);
    const hasCover = Boolean(a.cover_path);
    const coverHtml = hasCover
        ? `<img src="/thumb?path=${encodeURIComponent(a.cover_path)}" loading="lazy" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"/>`
        : `<div class="w-full h-full flex flex-col items-center justify-center gap-1.5 opacity-35">
               <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="1.7" viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
               <span class="text-[10px] font-bold tracking-wide">Vide</span>
           </div>`;

    const renameSvg = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.1" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
    const deleteSvg = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.1" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>`;
    const subSvg = `<svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" stroke-width="2.1" viewBox="0 0 24 24"><rect x="3" y="6" width="14" height="14" rx="2.5"/><path d="M7 3h11a2.5 2.5 0 0 1 2.5 2.5V16"/></svg>`;

    if (albumLayout === 'LIST') {
        const thumbCls = albumSize === 'SM' ? 'w-11 h-11 rounded-xl' : (albumSize === 'LG' ? 'w-24 h-24 rounded-2xl' : 'w-16 h-16 rounded-2xl');
        const padCls = albumSize === 'SM' ? 'p-2 gap-3 rounded-2xl' : (albumSize === 'LG' ? 'p-3.5 gap-4 rounded-3xl' : 'p-2.5 gap-3.5 rounded-2xl');
        const titleCls = albumSize === 'SM' ? 'text-xs' : (albumSize === 'LG' ? 'text-base' : 'text-sm');
        const dateStr = a.max_ts ? new Date(a.max_ts * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
        const modStr = a.modified_ts ? new Date(a.modified_ts * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
        const subText = a.subalbums_count > 0 ? ` · ${a.subalbums_count} sous-album${a.subalbums_count > 1 ? 's' : ''}` : '';
        const metaLine = [`${a.count} élément${a.count > 1 ? 's' : ''}${subText}`, dateStr ? `${dateStr}` : '', modStr && modStr !== dateStr ? `Modifié : ${modStr}` : ''].filter(Boolean).join(' · ');

        return `
            <div onclick="openSingleAlbumView('${safeFull}')"
                 class="ui-card ${padCls} flex items-center cursor-pointer group shadow-sm hover:shadow-lg transition-all duration-150">
                <div class="shrink-0 ${thumbCls} overflow-hidden ui-pill">
                    ${coverHtml}
                </div>
                <div class="flex-1 min-w-0">
                    <div class="font-extrabold truncate ${titleCls}">${escName}</div>
                    <div class="text-[11px] opacity-60 font-semibold truncate mt-0.5">${metaLine}</div>
                </div>
                <div class="ui-pill rounded-full p-1 flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition">
                    <button type="button" onclick="event.stopPropagation(); renameAlbumById(${a.album_id}, '${safeName}')" title="Renommer"
                            class="w-7 h-7 rounded-full hover:bg-[var(--bg-hover)] flex items-center justify-center transition cursor-pointer">${renameSvg}</button>
                    <button type="button" onclick="event.stopPropagation(); deleteAlbumById(${a.album_id}, '${safeName}')" title="Supprimer l'album"
                            class="w-7 h-7 rounded-full hover:bg-rose-500/20 hover:text-rose-400 flex items-center justify-center transition cursor-pointer">${deleteSvg}</button>
                </div>
            </div>
        `;
    }

    const subBadge = a.subalbums_count > 0
        ? `<span class="absolute bottom-2.5 left-2.5 bg-black/50 backdrop-blur-md border border-white/15 text-white text-[10px] font-bold px-2.5 py-0.5 rounded-full inline-flex items-center gap-1 z-10">${subSvg}<span>${a.subalbums_count} sous-album${a.subalbums_count > 1 ? 's' : ''}</span></span>`
        : '';
    const dateYear = a.max_ts ? new Date(a.max_ts * 1000).getFullYear() : '';
    const subtitleParts = [`${a.count} élément${a.count > 1 ? 's' : ''}`];
    if (dateYear) subtitleParts.push(String(dateYear));

    return `
        <div onclick="openSingleAlbumView('${safeFull}')"
             class="album-card cursor-pointer group flex flex-col">
            <div class="ui-card aspect-square rounded-[24px] overflow-hidden relative shadow-sm group-hover:shadow-xl transition-all duration-200">
                ${coverHtml}
                ${hasCover ? '<div class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/55 via-black/15 to-transparent opacity-75 group-hover:opacity-95 transition-opacity"></div>' : ''}
                ${subBadge}
                <div class="absolute top-2.5 right-2.5 bg-black/45 backdrop-blur-md border border-white/15 rounded-full p-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity z-10 shadow-lg">
                    <button type="button" onclick="event.stopPropagation(); renameAlbumById(${a.album_id}, '${safeName}')" title="Renommer"
                            class="w-7 h-7 rounded-full text-white hover:bg-white/20 flex items-center justify-center transition cursor-pointer">${renameSvg}</button>
                    <button type="button" onclick="event.stopPropagation(); deleteAlbumById(${a.album_id}, '${safeName}')" title="Supprimer l'album"
                            class="w-7 h-7 rounded-full text-white hover:bg-rose-500/85 flex items-center justify-center transition cursor-pointer">${deleteSvg}</button>
                </div>
            </div>
            <div class="pt-2.5 px-1">
                <div class="text-sm font-extrabold truncate leading-tight">${escName}</div>
                <div class="text-[11px] opacity-60 font-semibold mt-0.5 truncate">${subtitleParts.join(' · ')}</div>
            </div>
        </div>
    `;
}

let selectedAlbumYears = [];
let selectedAlbumMonths = [];
let selectedAlbumContents = [];
let selectedAlbumPeriods = [];

function toggleAlbumFilterMenu(forceState) {
    const pop = document.getElementById('alb-filter-popover');
    if (!pop) return;
    const willOpen = typeof forceState === 'boolean' ? forceState : pop.classList.contains('hidden');
    pop.classList.toggle('hidden', !willOpen);
}

function _getActiveAlbumPeriodsList() {
    const list = selectedAlbumPeriods.slice();
    const df = document.getElementById('alb-date-from')?.value || '';
    const dt = document.getElementById('alb-date-to')?.value || '';
    if (df || dt) {
        if (!list.some(p => p.from === df && p.to === dt)) list.push({ from: df, to: dt });
    }
    return list;
}

function populateAlbumYearFilterOptions() {
    const ySel = document.getElementById('alb-year');
    if (!ySel) return;
    const yearsSet = new Set();
    (rootAlbumsCache || []).forEach(a => {
        const ts = a.max_ts || a.modified_ts || 0;
        if (ts > 0) yearsSet.add(String(new Date(ts * 1000).getFullYear()));
    });
    const years = Array.from(yearsSet).sort((a, b) => b.localeCompare(a));
    ySel.innerHTML = `<option value="">Années</option>` + years.map(y => `<option value="${y}">${y}</option>`).join('');
}

function toggleAlbumMultiFilterValue(kind, selectEl) {
    if (!selectEl || !selectEl.value) return;
    const val = selectEl.value;
    selectEl.value = '';
    const map = { year: selectedAlbumYears, month: selectedAlbumMonths, content: selectedAlbumContents };
    const arr = map[kind];
    if (!arr) return;
    const idx = arr.indexOf(val);
    if (idx >= 0) arr.splice(idx, 1);
    else arr.push(val);
    renderAlbumsOverviewFromCache();
}

function addAlbumPeriodFromInputs() {
    const dfEl = document.getElementById('alb-date-from');
    const dtEl = document.getElementById('alb-date-to');
    const df = dfEl?.value || '';
    const dt = dtEl?.value || '';
    if (!df && !dt) return;
    if (!selectedAlbumPeriods.some(p => p.from === df && p.to === dt)) {
        selectedAlbumPeriods.push({ from: df, to: dt });
    }
    if (dfEl) dfEl.value = '';
    if (dtEl) dtEl.value = '';
    renderAlbumsOverviewFromCache();
}

function removeAlbumFilterChip(kind, idx) {
    if (kind === 'year') selectedAlbumYears.splice(idx, 1);
    else if (kind === 'month') selectedAlbumMonths.splice(idx, 1);
    else if (kind === 'content') selectedAlbumContents.splice(idx, 1);
    else if (kind === 'period') selectedAlbumPeriods.splice(idx, 1);
    renderAlbumsOverviewFromCache();
}

function resetAllAlbumFilters() {
    selectedAlbumYears = [];
    selectedAlbumMonths = [];
    selectedAlbumContents = [];
    selectedAlbumPeriods = [];
    const dfEl = document.getElementById('alb-date-from');
    const dtEl = document.getElementById('alb-date-to');
    if (dfEl) dfEl.value = '';
    if (dtEl) dtEl.value = '';
    renderAlbumsOverviewFromCache();
}

function _renderAlbumFilterChipsAndBadge() {
    const contentLabels = { WITH_SUBS: 'Avec sous-albums', NON_EMPTY: 'Non vides', EMPTY: 'Vides' };
    const chips = [];
    selectedAlbumYears.forEach((y, i) => chips.push({ kind: 'year', idx: i, label: y }));
    selectedAlbumMonths.forEach((m, i) => chips.push({ kind: 'month', idx: i, label: SHORT_MONTHS_FR[parseInt(m, 10)] || m }));
    selectedAlbumPeriods.forEach((p, i) => chips.push({ kind: 'period', idx: i, label: `${p.from || '…'} → ${p.to || '…'}` }));
    selectedAlbumContents.forEach((c, i) => chips.push({ kind: 'content', idx: i, label: contentLabels[c] || c }));

    const container = document.getElementById('alb-active-filter-chips');
    if (container) {
        if (!chips.length) {
            container.innerHTML = '';
            container.classList.add('hidden');
        } else {
            container.classList.remove('hidden');
            container.innerHTML = chips.map(c =>
                `<span class="plum-btn px-2 py-0.5 rounded-full text-[10px] font-extrabold inline-flex items-center gap-1">
                    <span>${c.label}</span>
                    <button type="button" onclick="event.stopPropagation(); removeAlbumFilterChip('${c.kind}', ${c.idx})" class="hover:text-rose-200 font-bold">✕</button>
                </span>`
            ).join('');
        }
    }

    const totalCount = chips.length + ((document.getElementById('alb-date-from')?.value || document.getElementById('alb-date-to')?.value) ? 1 : 0);
    const countBadge = document.getElementById('alb-filter-count');
    if (countBadge) {
        if (totalCount > 0) {
            countBadge.textContent = String(totalCount);
            countBadge.classList.remove('hidden');
        } else {
            countBadge.classList.add('hidden');
        }
    }
}

function _filterAlbumsList(albums) {
    const periods = _getActiveAlbumPeriodsList();
    return (albums || []).filter(a => {
        const ts = a.max_ts || a.modified_ts || 0;
        const dt = ts > 0 ? new Date(ts * 1000) : null;
        const yr = dt ? String(dt.getFullYear()) : '';
        const mo = dt ? String(dt.getMonth() + 1).padStart(2, '0') : '';

        const hasYM = selectedAlbumYears.length > 0 || selectedAlbumMonths.length > 0;
        const hasPer = periods.length > 0;
        if (hasYM || hasPer) {
            let matchYM = false;
            if (hasYM && dt) {
                const okY = !selectedAlbumYears.length || selectedAlbumYears.includes(yr);
                const okM = !selectedAlbumMonths.length || selectedAlbumMonths.includes(mo);
                matchYM = okY && okM;
            }
            let matchPer = false;
            if (hasPer && ts > 0) {
                matchPer = periods.some(p => {
                    let ok = true;
                    if (p.from) ok = ok && ts >= Math.floor(new Date(p.from + 'T00:00:00').getTime() / 1000);
                    if (p.to) ok = ok && ts <= Math.floor(new Date(p.to + 'T23:59:59').getTime() / 1000);
                    return ok;
                });
            }
            if (!(matchYM || matchPer)) return false;
        }

        if (selectedAlbumContents.length > 0) {
            const matchesContent = selectedAlbumContents.some(c => {
                if (c === 'WITH_SUBS') return (a.subalbums_count || 0) > 0;
                if (c === 'NON_EMPTY') return (a.count || 0) > 0;
                if (c === 'EMPTY') return (a.count || 0) === 0;
                return true;
            });
            if (!matchesContent) return false;
        }
        return true;
    });
}

function _albumGroupKeyAndLabel(album, groupBy, sortBy) {
    const ts = sortBy === 'modified' ? (album.modified_ts || album.max_ts || 0) : (album.max_ts || album.modified_ts || 0);
    if (!ts) return { key: '0000', label: 'Sans date' };
    const d = new Date(ts * 1000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    if (groupBy === 'YEAR') return { key: `${y}`, label: `${y}` };
    if (groupBy === 'MONTH') return { key: `${y}-${m}`, label: `${FULL_MONTHS_FR[d.getMonth() + 1]} ${y}` };
    if (groupBy === 'WEEK') {
        const tmp = new Date(d.getTime());
        tmp.setHours(0, 0, 0, 0);
        tmp.setDate(tmp.getDate() + 3 - ((tmp.getDay() + 6) % 7));
        const w1 = new Date(tmp.getFullYear(), 0, 4);
        const wk = 1 + Math.round(((tmp.getTime() - w1.getTime()) / 86400000 - 3 + ((w1.getDay() + 6) % 7)) / 7);
        return { key: `${tmp.getFullYear()}-W${String(wk).padStart(2, '0')}`, label: `Semaine ${wk} • ${tmp.getFullYear()}` };
    }
    return { key: `${y}-${m}-${day}`, label: d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) };
}

function renderAlbumsOverviewFromCache() {
    const grid = document.getElementById('albums-grid');
    if (!grid) return;
    _renderAlbumFilterChipsAndBadge();

    const totalLbl = document.getElementById('alb-total-label');
    const filterBadge = document.getElementById('alb-active-filter-badge');
    const filterText = document.getElementById('alb-active-filter-text');

    if (!rootAlbumsCache || rootAlbumsCache.length === 0) {
        if (totalLbl) totalLbl.textContent = '0 album';
        if (filterBadge) filterBadge.classList.add('hidden');
        grid.className = getAlbumGridClass();
        grid.innerHTML = `<div class="col-span-full ui-card rounded-3xl p-8 text-center text-sm font-semibold opacity-60">Aucun album pour le moment. Cliquez sur « Nouveau » pour en créer un.</div>`;
        return;
    }

    const groupFiltered = typeof filterItemsByActiveCustomGroup === 'function'
        ? filterItemsByActiveCustomGroup('albums', rootAlbumsCache, a => a.album_id)
        : rootAlbumsCache;
    const filtered = _filterAlbumsList(groupFiltered);
    const sorted = sortAlbumItems(filtered);
    if (totalLbl) {
        totalLbl.textContent = `${sorted.length} album${sorted.length > 1 ? 's' : ''}`;
    }
    const activeChipCount = document.getElementById('alb-filter-count')?.textContent || '0';
    if (filterBadge && filterText) {
        if (Number(activeChipCount) > 0) {
            filterText.textContent = `${activeChipCount} filtre${Number(activeChipCount) > 1 ? 's' : ''}`;
            filterBadge.classList.remove('hidden');
            filterBadge.classList.add('inline-flex');
        } else {
            filterBadge.classList.add('hidden');
            filterBadge.classList.remove('inline-flex');
        }
    }
    if (sorted.length === 0) {
        grid.className = getAlbumGridClass();
        grid.innerHTML = `<div class="col-span-full ui-card rounded-3xl p-8 text-center text-sm font-semibold opacity-60">Aucun album ne correspond aux filtres sélectionnés.</div>`;
        return;
    }

    const groupBy = document.getElementById('alb-group-by')?.value || 'NONE';
    const sortBy = document.getElementById('alb-sort-by')?.value || 'date';
    if (groupBy === 'NONE') {
        grid.className = getAlbumGridClass();
        grid.innerHTML = sorted.map(renderAlbumCardHTML).join('');
        return;
    }

    const groups = [];
    const groupMap = new Map();
    sorted.forEach(a => {
        const { key, label } = _albumGroupKeyAndLabel(a, groupBy, sortBy);
        if (!groupMap.has(key)) {
            const g = { key, label, items: [] };
            groupMap.set(key, g);
            groups.push(g);
        }
        groupMap.get(key).items.push(a);
    });

    const innerGridCls = getAlbumGridClass();
    grid.className = 'space-y-6';
    grid.innerHTML = groups.map(g => `
        <section class="space-y-3 group-section">
            <div class="flex items-center justify-between">
                <h3 class="group-section-title text-sm font-extrabold tracking-tight">${g.label}</h3>
                <span class="text-[11px] font-bold opacity-55">${g.items.length} album${g.items.length > 1 ? 's' : ''}</span>
            </div>
            <div class="${innerGridCls}">
                ${g.items.map(renderAlbumCardHTML).join('')}
            </div>
        </section>
    `).join('');
    updateFloatingGroupPill();
}

async function loadAlbumsView() {
    const res = await fetch('/api/albums/list');
    const d = await res.json();
    rootAlbumsCache = d.albums || [];
    allAlbumsCache = d.all_albums || [];
    populateAlbumYearFilterOptions();
    if (typeof loadCustomGroups === 'function') await loadCustomGroups('albums');
    renderAlbumsOverviewFromCache();
}

let _albumFormState = { mode: 'create', parentId: null, albumId: null };
let _albumDeleteState = { albumId: null, albumName: '' };
let _albumPickerState = { sourcePaths: [], onSuccess: null };

function promptCreateNewAlbum(parentId = null) {
    _albumFormState = { mode: 'create', parentId: parentId, albumId: null };
    const titleEl = document.getElementById('album-form-title');
    const subEl = document.getElementById('album-form-subtitle');
    const inputEl = document.getElementById('album-form-name-input');
    const errEl = document.getElementById('album-form-error');
    const submitBtn = document.getElementById('album-form-submit-btn');

    titleEl.textContent = parentId ? 'Nouveau sous-album' : 'Nouvel album';
    if (parentId && openedAlbumObj && openedAlbumObj.album_id === parentId) {
        subEl.textContent = `Dans : ${openedAlbumObj.full_path}`;
        subEl.classList.remove('hidden');
    } else {
        subEl.textContent = '';
        subEl.classList.add('hidden');
    }
    inputEl.value = '';
    errEl.textContent = '';
    errEl.classList.add('hidden');
    submitBtn.textContent = 'Créer';

    document.getElementById('album-form-modal').classList.remove('hidden');
    setTimeout(() => inputEl.focus(), 50);
}

function renameAlbumById(albumId, currentName) {
    _albumFormState = { mode: 'rename', parentId: null, albumId: albumId, currentName: currentName };
    const titleEl = document.getElementById('album-form-title');
    const subEl = document.getElementById('album-form-subtitle');
    const inputEl = document.getElementById('album-form-name-input');
    const errEl = document.getElementById('album-form-error');
    const submitBtn = document.getElementById('album-form-submit-btn');

    titleEl.textContent = "Renommer l'album";
    subEl.textContent = `Nom actuel : ${currentName}`;
    subEl.classList.remove('hidden');
    inputEl.value = currentName;
    errEl.textContent = '';
    errEl.classList.add('hidden');
    submitBtn.textContent = 'Renommer';

    document.getElementById('album-form-modal').classList.remove('hidden');
    setTimeout(() => { inputEl.focus(); inputEl.select(); }, 50);
}

function closeAlbumFormModal() {
    document.getElementById('album-form-modal').classList.add('hidden');
}

async function submitAlbumFormModal(e) {
    if (e) e.preventDefault();
    const inputEl = document.getElementById('album-form-name-input');
    const errEl = document.getElementById('album-form-error');
    const name = inputEl.value.trim();

    if (!name) {
        errEl.textContent = "Veuillez saisir un nom d'album.";
        errEl.classList.remove('hidden');
        return;
    }

    if (_albumFormState.mode === 'create') {
        const res = await fetch('/api/albums/create', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name: name, parent_id: _albumFormState.parentId})
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            errEl.textContent = err.detail || "Impossible de créer l'album.";
            errEl.classList.remove('hidden');
            return;
        }
        closeAlbumFormModal();
        await loadGalleryFilters();
        if (openedAlbumName) {
            await openSingleAlbumView(openedAlbumName);
        } else {
            await loadAlbumsView();
        }
    } else if (_albumFormState.mode === 'rename') {
        if (name === _albumFormState.currentName) {
            closeAlbumFormModal();
            return;
        }
        const res = await fetch('/api/albums/rename', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({album_id: _albumFormState.albumId, new_name: name})
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            errEl.textContent = err.detail || "Erreur lors du renommage.";
            errEl.classList.remove('hidden');
            return;
        }
        const d = await res.json();
        closeAlbumFormModal();
        await loadGalleryFilters();
        if (openedAlbumObj && openedAlbumObj.album_id === _albumFormState.albumId) {
            await openSingleAlbumView(d.full_path);
        } else if (openedAlbumName) {
            await openSingleAlbumView(openedAlbumName);
        } else {
            await loadAlbumsView();
        }
    }
}

function deleteAlbumById(albumId, albumName) {
    _albumDeleteState = { albumId: albumId, albumName: albumName };
    document.getElementById('album-delete-name').textContent = `"${albumName}"`;
    const errEl = document.getElementById('album-delete-error');
    errEl.textContent = '';
    errEl.classList.add('hidden');
    document.getElementById('album-delete-modal').classList.remove('hidden');
}

function closeAlbumDeleteModal() {
    document.getElementById('album-delete-modal').classList.add('hidden');
}

async function confirmDeleteAlbumModal() {
    const { albumId } = _albumDeleteState;
    if (!albumId) return;
    const errEl = document.getElementById('album-delete-error');
    const res = await fetch('/api/albums/delete', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({album_id: albumId, delete_subalbums: true})
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        errEl.textContent = err.detail || "Erreur lors de la suppression.";
        errEl.classList.remove('hidden');
        return;
    }
    closeAlbumDeleteModal();
    await loadGalleryFilters();
    if (openedAlbumObj && openedAlbumObj.album_id === albumId) {
        closeSingleAlbumView();
    } else if (openedAlbumName) {
        await openSingleAlbumView(openedAlbumName);
    } else {
        await loadAlbumsView();
    }
}

function renderAlbumBreadcrumbs(fullPath) {
    const bcEl = document.getElementById('album-breadcrumbs');
    if (!bcEl) return;
    const parts = fullPath.split('/');
    let acc = '';
    bcEl.innerHTML = parts.map((part, idx) => {
        acc = idx === 0 ? part : `${acc}/${part}`;
        const safeAcc = acc.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const sep = idx > 0 ? `<span class="opacity-40">/</span>` : '';
        if (idx === parts.length - 1) {
            return `${sep}<span class="font-extrabold opacity-100">${part}</span>`;
        }
        return `${sep}<button type="button" onclick="openSingleAlbumView('${safeAcc}')" class="hover:underline">${part}</button>`;
    }).join('');
}

async function openSingleAlbumView(albumName) {
    openedAlbumName = albumName;
    singleAlbumPage = 1;
    singleAlbumTotalPages = 1;
    singleAlbumTotalItems = 0;
    currentGalleryItems = [];
    selectedGalleryPaths.clear();

    const listRes = await fetch('/api/albums/list?flat=true');
    if (listRes.ok) {
        const listData = await listRes.json();
        allAlbumsCache = listData.all_albums || [];
    }
    openedAlbumObj = allAlbumsCache.find(a => a.full_path === albumName) || null;

    updateGalleryBatchBar();
    document.getElementById('albums-overview-panel').classList.add('hidden');
    document.getElementById('album-single-panel').classList.remove('hidden');
    if (typeof _syncTopbarOptionsButton === 'function') _syncTopbarOptionsButton();
    document.getElementById('single-album-title').textContent = openedAlbumObj ? openedAlbumObj.name : albumName;
    renderAlbumBreadcrumbs(albumName);

    const subSec = document.getElementById('subalbums-section');
    const subGrid = document.getElementById('subalbums-grid');
    if (subSec && subGrid && openedAlbumObj) {
        const children = allAlbumsCache.filter(a => a.parent_id === openedAlbumObj.album_id);
        subSec.classList.toggle('hidden', children.length === 0);
        subGrid.className = getAlbumGridClass();
        subGrid.innerHTML = sortAlbumItems(children).map(renderAlbumCardHTML).join('');
    } else if (subSec) {
        subSec.classList.add('hidden');
    }

    loadSingleAlbumItems(false);
}

function promptCreateSubalbumForCurrent() {
    if (!openedAlbumObj) return;
    promptCreateNewAlbum(openedAlbumObj.album_id);
}

function promptRenameCurrentAlbum() {
    if (!openedAlbumObj) return;
    renameAlbumById(openedAlbumObj.album_id, openedAlbumObj.name);
}

function confirmDeleteCurrentAlbum() {
    if (!openedAlbumObj) return;
    deleteAlbumById(openedAlbumObj.album_id, openedAlbumObj.name);
}

function addMediaToCurrentAlbumFromGallery() {
    if (!openedAlbumName) return;
    const inp = document.getElementById('batch-album-input');
    if (inp) inp.value = openedAlbumName;
    switchTab('gallery');
}

function closeSingleAlbumView() {
    openedAlbumName = null;
    openedAlbumObj = null;
    selectedGalleryPaths.clear();
    updateGalleryBatchBar();
    document.getElementById('album-single-panel').classList.add('hidden');
    document.getElementById('albums-overview-panel').classList.remove('hidden');
    if (typeof _syncTopbarOptionsButton === 'function') _syncTopbarOptionsButton();
    loadAlbumsView();
}

async function loadSingleAlbumItems(append = false) {
    if (!openedAlbumName || singleAlbumIsLoading) return;
    if (append && singleAlbumPage >= singleAlbumTotalPages) return;

    singleAlbumIsLoading = true;
    const spinner = document.getElementById('album-loading-spinner');
    if (spinner) spinner.classList.remove('hidden');

    const targetPage = append ? singleAlbumPage + 1 : 1;
    try {
        const p = new URLSearchParams({
            album: openedAlbumName,
            sort_by: document.getElementById('gal-sort-by').value,
            sort_order: document.getElementById('gal-sort-order').value,
            page: targetPage,
            limit: 60
        });
        const res = await fetch(`/api/gallery/items?${p.toString()}`);
        const d = await res.json();
        if (currentTab !== 'albums' || !openedAlbumName) return;
        const newItems = d.items || [];
        singleAlbumPage = d.page || targetPage;
        singleAlbumTotalPages = d.total_pages || 1;
        singleAlbumTotalItems = d.total || 0;
        lightboxIsCustomItem = false;
        document.getElementById('single-album-count').textContent = `${d.total} éléments`;

        if (!append) {
            currentGalleryItems = newItems;
            appendMediaBatchToContainer('album-single-content-area', newItems, 0, true);
        } else {
            const startIdx = currentGalleryItems.length;
            currentGalleryItems.push(...newItems);
            appendMediaBatchToContainer('album-single-content-area', newItems, startIdx, false);
        }
    } finally {
        singleAlbumIsLoading = false;
        if (spinner) spinner.classList.add('hidden');
    }
}

// ==================== OBSERVATEUR DE DÉFILEMENT INFINI ====================

function initInfiniteScrollObserver() {
    const scrollRoot = document.getElementById('main-scroll-container');
    if (!scrollRoot || infiniteScrollObserver) return;

    infiniteScrollObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            if (entry.target.id === 'gallery-scroll-sentinel' && (currentTab === 'gallery' || currentTab === 'recent')) {
                loadGalleryItems(true);
            } else if (entry.target.id === 'favorites-scroll-sentinel' && currentTab === 'favorites') {
                loadGalleryItems(true);
            } else if (entry.target.id === 'album-scroll-sentinel' && currentTab === 'albums' && openedAlbumName) {
                loadSingleAlbumItems(true);
            }
        });
    }, {
        root: scrollRoot,
        rootMargin: '0px 0px 700px 0px'
    });

    const galSentinel = document.getElementById('gallery-scroll-sentinel');
    const favSentinel = document.getElementById('favorites-scroll-sentinel');
    const albSentinel = document.getElementById('album-scroll-sentinel');
    if (galSentinel) infiniteScrollObserver.observe(galSentinel);
    if (favSentinel) infiniteScrollObserver.observe(favSentinel);
    if (albSentinel) infiniteScrollObserver.observe(albSentinel);
}

window.addEventListener('DOMContentLoaded', initInfiniteScrollObserver);

// ==================== CORBEILLE ====================

const _trashViewState = {
    layout: localStorage.getItem('phototo_trash_layout') || 'GRID',
    size: localStorage.getItem('phototo_trash_size') || 'MD',
    cache: [],
    retentionDays: 30,
};
let selectedTrashPaths = new Set();
let lastClickedTrashIdx = null;
let _trashLastSorted = [];

function syncTrashLayoutSizeButtons() {
    ['GRID', 'MASONRY', 'LIST'].forEach(l => {
        const b = document.getElementById(`trash-layout-btn-${l}`);
        if (b) {
            b.classList.toggle('nav-item-active', l === _trashViewState.layout);
            b.classList.toggle('ui-pill', l !== _trashViewState.layout);
        }
    });
    ['SM', 'MD', 'LG'].forEach(s => {
        const b = document.getElementById(`trash-size-btn-${s}`);
        if (b) {
            b.classList.toggle('nav-item-active', s === _trashViewState.size);
            b.classList.toggle('ui-pill', s !== _trashViewState.size);
        }
    });
}

function setTrashLayout(layout) {
    _trashViewState.layout = ['GRID', 'MASONRY', 'LIST'].includes(layout) ? layout : 'GRID';
    localStorage.setItem('phototo_trash_layout', _trashViewState.layout);
    syncTrashLayoutSizeButtons();
    renderTrashFromCache();
}

function setTrashSize(size) {
    _trashViewState.size = ['SM', 'MD', 'LG'].includes(size) ? size : 'MD';
    localStorage.setItem('phototo_trash_size', _trashViewState.size);
    syncTrashLayoutSizeButtons();
    renderTrashFromCache();
}

function toggleTrashSortOrder() {
    _toggleSortOrderInput('trash-sort-order', 'trash-sort-dir-btn', 'trash-sort-arrow', onTrashControlsChanged);
}

function onTrashControlsChanged() {
    renderTrashFromCache();
}

document.addEventListener('DOMContentLoaded', syncTrashLayoutSizeButtons);

function _getTrashGridColsClass() {
    const { layout, size } = _trashViewState;
    if (layout === 'LIST') {
        if (size === 'SM') return 'group-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2';
        if (size === 'LG') return 'group-grid grid grid-cols-1 lg:grid-cols-2 gap-3.5';
        return 'group-grid grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5';
    }
    if (layout === 'MASONRY') {
        const sizeCls = size === 'SM' ? 'masonry-sm' : (size === 'LG' ? 'masonry-lg' : '');
        return `group-grid masonry-grid ${sizeCls}`.trim();
    }
    if (size === 'SM') return 'group-grid grid grid-cols-3 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-2.5';
    if (size === 'LG') return 'group-grid grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-3 gap-5';
    return 'group-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4';
}

function _getTrashMasonryColumnCount() {
    const w = window.innerWidth || 1280;
    if (_trashViewState.size === 'SM') return w >= 1280 ? 8 : (w >= 768 ? 6 : 3);
    if (_trashViewState.size === 'LG') return w >= 1280 ? 3 : (w >= 768 ? 2 : 1);
    return w >= 1280 ? 5 : (w >= 768 ? 4 : 2);
}

function updateTrashBatchBar() {
    const bar = document.getElementById('trash-batch-bar');
    const grid = document.getElementById('trash-grid');
    const visible = currentTab === 'trash' && selectedTrashPaths.size > 0;
    if (bar) {
        bar.classList.toggle('hidden', !visible);
        const cntEl = document.getElementById('trash-batch-count');
        if (cntEl) cntEl.textContent = `${selectedTrashPaths.size} sélectionné(s)`;
    }
    if (grid) grid.classList.toggle('selection-active', visible);
    const galHasSel = selectedGalleryPaths.size > 0 && currentTab !== 'trash';
    document.body.classList.toggle('has-batch-bar', visible || galHasSel);
    syncBatchBarBounds();
}

function toggleTrashItemSelect(sortedIdx, event) {
    if (event) event.stopPropagation();
    const list = _trashLastSorted || [];
    const target = list[sortedIdx];
    if (!target || !target.source_path) return;

    const shouldSelect = !selectedTrashPaths.has(target.source_path);
    if (event && event.shiftKey && lastClickedTrashIdx !== null && lastClickedTrashIdx < list.length) {
        const start = Math.min(lastClickedTrashIdx, sortedIdx);
        const end = Math.max(lastClickedTrashIdx, sortedIdx);
        for (let i = start; i <= end; i++) {
            const p = list[i]?.source_path;
            if (!p) continue;
            if (shouldSelect) selectedTrashPaths.add(p);
            else selectedTrashPaths.delete(p);
        }
    } else {
        if (shouldSelect) selectedTrashPaths.add(target.source_path);
        else selectedTrashPaths.delete(target.source_path);
    }
    lastClickedTrashIdx = sortedIdx;
    renderTrashFromCache();
}

function toggleSelectAllTrash(forceState) {
    const items = _trashViewState.cache || [];
    if (!items.length) return;
    const willSelect = typeof forceState === 'boolean' ? forceState : (selectedTrashPaths.size < items.length);
    if (!willSelect) {
        selectedTrashPaths.clear();
    } else {
        items.forEach(it => { if (it.source_path) selectedTrashPaths.add(it.source_path); });
    }
    lastClickedTrashIdx = null;
    renderTrashFromCache();
}

function toggleTrashGroupSelection(indices) {
    const list = _trashLastSorted || [];
    const paths = (indices || []).map(i => list[i]?.source_path).filter(Boolean);
    if (!paths.length) return;
    const allSel = paths.every(p => selectedTrashPaths.has(p));
    paths.forEach(p => {
        if (allSel) selectedTrashPaths.delete(p);
        else selectedTrashPaths.add(p);
    });
    renderTrashFromCache();
}

function openLightboxForTrashItem(sortedIdx) {
    const list = _trashLastSorted || [];
    if (!list.length) return;
    lightboxIsCustomItem = true;
    currentLightboxDupGroup = null;
    currentGalleryItems = list.filter(Boolean).map(it => ({ ...it, _isTrashContext: true }));
    const safeIdx = Math.max(0, Math.min(sortedIdx, currentGalleryItems.length - 1));
    openLightbox(safeIdx);
}

function _renderTrashCard(it, sortedIdx) {
    const enc = encodeURIComponent(it.source_path);
    const fname = _escTileText((it.dest_path || it.source_path || '').split(/[\\/]/).pop() || 'Média');
    const thumbUrl = `/thumb?path=${encodeURIComponent(it.dest_path)}`;
    const isSel = Boolean(it.source_path && selectedTrashPaths.has(it.source_path));
    const layout = _trashViewState.layout;
    const size = _trashViewState.size;
    const isVid = isVideoFile(it.dest_path);
    const durText = formatDuration(it.duration_sec);
    const dim = (it.width && it.height) ? `${it.width}×${it.height}` : '';
    const mb = _formatBytesShort(it.file_size);
    const tsDate = it.trashed_at || it.timestamp || it.modified_at || 0;
    const dateTxt = tsDate ? new Date(tsDate * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
    const daysLeft = it.days_left;
    const daysLabel = daysLeft === null || daysLeft === undefined
        ? 'Manuel'
        : (daysLeft === 0 ? "0 j" : `${daysLeft} j`);
    const isUrgent = daysLeft !== null && daysLeft !== undefined && daysLeft <= 3;

    const selectBtn = `
        <button type="button"
                onclick="event.stopPropagation(); toggleTrashItemSelect(${sortedIdx}, event)"
                title="Sélectionner"
                class="tile-select-btn absolute top-2.5 left-2.5 z-10 cursor-pointer">
            ${getSelectIconHTML(isSel, false)}
        </button>`;
    const daysBadge = `
        <span title="${daysLeft === null ? 'Conservation manuelle' : (daysLeft === 0 ? "Expire aujourd'hui" : `${daysLeft} jour(s) avant suppression définitive`)}"
              class="absolute top-2.5 right-2.5 z-10 ${isUrgent ? 'bg-rose-600/85 text-white' : 'bg-black/35 text-white/95'} backdrop-blur-sm text-[10px] font-bold px-2 py-0.5 rounded-full pointer-events-none">
            ${daysLabel}
        </span>`;
    const videoBadge = isVid
        ? `<div class="absolute bottom-2.5 left-2.5 z-10 bg-black/30 backdrop-blur-sm text-white/95 text-[10px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full flex items-center gap-1 pointer-events-none">
             <svg class="w-2.5 h-2.5 opacity-90" fill="currentColor" viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>
             <span>${durText}</span>
           </div>`
        : '';
    const hoverActions = `
        <div class="opacity-0 group-hover:opacity-100 absolute bottom-2 right-2 z-10 flex items-center gap-1 transition">
            <button type="button" onclick="event.stopPropagation(); restoreTrash('${enc}')" title="Restaurer"
                    class="w-7 h-7 rounded-full bg-black/50 hover:bg-emerald-500/85 backdrop-blur-md text-white flex items-center justify-center transition cursor-pointer shadow">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
            </button>
            <button type="button" onclick="event.stopPropagation(); deletePermTrash('${enc}')" title="Supprimer définitivement"
                    class="w-7 h-7 rounded-full bg-black/50 hover:bg-rose-600 backdrop-blur-md text-white flex items-center justify-center text-[11px] font-extrabold transition cursor-pointer shadow">
                ✕
            </button>
        </div>`;

    if (layout === 'LIST') {
        const thumbSizeCls = size === 'SM' ? 'w-11 h-11 rounded-xl' : (size === 'LG' ? 'w-24 h-24 rounded-2xl' : 'w-16 h-16 rounded-2xl');
        const padCls = size === 'SM' ? 'p-2 gap-2.5 rounded-2xl' : (size === 'LG' ? 'p-3.5 gap-4 rounded-3xl' : 'p-2.5 gap-3.5 rounded-2xl');
        const titleCls = size === 'SM' ? 'text-xs' : (size === 'LG' ? 'text-base' : 'text-sm');
        const listSelBorder = isSel ? 'tile-selected-list' : '';
        const metaParts = [dateTxt, dim, mb].filter(Boolean).join(' • ');

        return `
        <div onclick="openLightboxForTrashItem(${sortedIdx})"
             class="media-tile ui-card group flex items-center ${padCls} cursor-pointer shadow-sm transition-all duration-150 ${listSelBorder}">
            <button type="button" onclick="event.stopPropagation(); toggleTrashItemSelect(${sortedIdx}, event)" title="Sélectionner"
                    class="tile-select-btn shrink-0 cursor-pointer">
                ${getSelectIconHTML(isSel, true)}
            </button>
            <div class="relative shrink-0 ${thumbSizeCls} overflow-hidden bg-black/10">
                <img src="${thumbUrl}" loading="lazy" decoding="async" class="w-full h-full object-cover select-none pointer-events-none"/>
                ${isVid ? `<span class="absolute bottom-1 left-1 bg-black/35 backdrop-blur-sm text-white/95 text-[9px] font-semibold tabular-nums px-1.5 py-[1px] rounded-full pointer-events-none">${durText}</span>` : ''}
            </div>
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 min-w-0">
                    <span class="font-bold truncate ${titleCls}">${fname}</span>
                    <span class="${isUrgent ? 'bg-rose-500/20 text-rose-400' : 'ui-pill opacity-75'} text-[10px] font-extrabold px-2 py-0.5 rounded-full shrink-0">${daysLabel}</span>
                </div>
                <div class="text-[11px] opacity-65 truncate mt-0.5">${metaParts || 'Supprimé'}</div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
                <button type="button" onclick="event.stopPropagation(); restoreTrash('${enc}')" title="Restaurer"
                        class="w-8 h-8 rounded-full ui-pill hover:bg-emerald-500/20 hover:text-emerald-400 flex items-center justify-center transition cursor-pointer">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                </button>
                <button type="button" onclick="event.stopPropagation(); deletePermTrash('${enc}')" title="Supprimer définitivement"
                        class="w-8 h-8 rounded-full ui-pill hover:bg-rose-500/20 hover:text-rose-400 flex items-center justify-center text-xs font-extrabold transition cursor-pointer">
                    ✕
                </button>
            </div>
        </div>`;
    }

    if (layout === 'MASONRY') {
        const aspectStyle = (it.width && it.height) ? `aspect-ratio: ${it.width} / ${it.height};` : '';
        return `
        <div onclick="openLightboxForTrashItem(${sortedIdx})" style="${aspectStyle}"
             class="media-tile masonry-item ui-card group relative w-full rounded-lg overflow-hidden cursor-pointer shadow-sm transition-all duration-150 ${isSel ? 'tile-selected' : ''}">
            <img src="${thumbUrl}" loading="lazy" decoding="async" class="w-full h-auto block group-hover:scale-[1.02] transition duration-300 select-none pointer-events-none"/>
            ${selectBtn}
            ${daysBadge}
            ${videoBadge}
            ${hoverActions}
        </div>`;
    }

    return `
    <div onclick="openLightboxForTrashItem(${sortedIdx})"
         class="media-tile ui-card group relative aspect-square rounded-[24px] overflow-hidden cursor-pointer shadow-sm transition-all duration-150 ${isSel ? 'tile-selected' : ''}">
        <img src="${thumbUrl}" loading="lazy" decoding="async" class="w-full h-full object-cover group-hover:scale-[1.03] transition duration-300 select-none pointer-events-none"/>
        ${selectBtn}
        ${daysBadge}
        ${videoBadge}
        ${hoverActions}
    </div>`;
}

function _buildTrashMasonryHtml(entries) {
    const colCount = _getTrashMasonryColumnCount();
    const colsHtml = Array.from({ length: colCount }, () => []);
    const heights = new Array(colCount).fill(0);
    entries.forEach(({ it, idx }) => {
        let bestCol = 0;
        for (let c = 1; c < colCount; c++) {
            if (heights[c] < heights[bestCol] - 1e-6) bestCol = c;
        }
        const ratio = (it.width && it.height && it.width > 0) ? (it.height / it.width) : 1.0;
        heights[bestCol] += ratio;
        colsHtml[bestCol].push(_renderTrashCard(it, idx));
    });
    return colsHtml.map(buf => `<div class="masonry-col">${buf.join('')}</div>`).join('');
}

function renderTrashFromCache() {
    const grid = document.getElementById('trash-grid');
    if (!grid) return;
    const items = _trashViewState.cache || [];
    updateTrashBatchBar();

    if (!items.length) {
        _trashLastSorted = [];
        const rDays = Number(_trashViewState.retentionDays ?? 30);
        const retInfo = rDays > 0
            ? `Les médias mis à la corbeille sont conservés ${rDays} jours avant suppression définitive.`
            : 'La suppression automatique est désactivée (conservation manuelle uniquement).';
        grid.className = 'pb-10';
        grid.innerHTML = `
        <div class="ui-card rounded-3xl p-10 text-center space-y-3.5 shadow-sm">
            <div class="w-14 h-14 rounded-2xl ui-pill mx-auto flex items-center justify-center opacity-75">
                <svg class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                </svg>
            </div>
            <div class="text-base font-extrabold">La corbeille est vide</div>
            <p class="text-xs opacity-65 max-w-md mx-auto leading-relaxed">${retInfo}</p>
            <button type="button" onclick="openPageSettingsModal('trash')" class="ui-pill hover:bg-[var(--bg-hover)] px-4 py-2 rounded-full text-xs font-extrabold transition cursor-pointer">
                Configurer la durée de conservation
            </button>
        </div>`;
        if (typeof updateFloatingGroupPill === 'function') updateFloatingGroupPill();
        return;
    }

    const sortBy = document.getElementById('trash-sort-by')?.value || 'trashed_at';
    const sortOrder = document.getElementById('trash-sort-order')?.value || 'desc';
    const groupBy = document.getElementById('trash-group-by')?.value || 'NONE';
    const dir = sortOrder === 'asc' ? 1 : -1;

    const sorted = [...items].sort((a, b) => {
        if (sortBy === 'name') {
            const na = (a.dest_path || a.source_path || '').split(/[\\/]/).pop() || '';
            const nb = (b.dest_path || b.source_path || '').split(/[\\/]/).pop() || '';
            return dir * na.localeCompare(nb, 'fr', { sensitivity: 'base' });
        }
        if (sortBy === 'size') {
            return dir * (Number(a.file_size || 0) - Number(b.file_size || 0));
        }
        if (sortBy === 'days_left') {
            const da = a.days_left ?? 999999;
            const db = b.days_left ?? 999999;
            return dir * (da - db);
        }
        if (sortBy === 'date') {
            return dir * (Number(a.timestamp || a.modified_at || 0) - Number(b.timestamp || b.modified_at || 0));
        }
        return dir * (Number(a.trashed_at || 0) - Number(b.trashed_at || 0));
    });
    _trashLastSorted = sorted;

    const colsCls = _getTrashGridColsClass();
    const isMasonry = _trashViewState.layout === 'MASONRY';
    const hasSel = selectedTrashPaths.size > 0 && currentTab === 'trash';
    grid.className = `space-y-6 pb-10 ${hasSel ? 'selection-active' : ''}`.trim();

    if (groupBy !== 'NONE') {
        const sections = [];
        const secMap = new Map();
        sorted.forEach((it, idx) => {
            const ts = sortBy === 'date' ? (it.timestamp || it.modified_at || 0) : (it.trashed_at || it.timestamp || 0);
            const label = formatGroupHeading(ts, groupBy);
            if (!secMap.has(label)) {
                const sec = { label, entries: [] };
                secMap.set(label, sec);
                sections.push(sec);
            }
            secMap.get(label).entries.push({ it, idx });
        });
        grid.innerHTML = sections.map(sec => {
            const idxList = sec.entries.map(e => e.idx);
            const allGrpSel = sec.entries.length > 0 && sec.entries.every(e => e.it.source_path && selectedTrashPaths.has(e.it.source_path));
            const innerHtml = isMasonry
                ? _buildTrashMasonryHtml(sec.entries)
                : sec.entries.map(({ it, idx }) => _renderTrashCard(it, idx)).join('');
            return `
            <section class="group-section space-y-3">
                <div class="group-header flex items-center justify-between gap-2 pb-1">
                    <div class="flex items-center gap-2.5 min-w-0">
                        <button type="button" onclick="toggleTrashGroupSelection(${JSON.stringify(idxList)})"
                                title="Tout sélectionner / désélectionner dans ce groupe"
                                class="group-section-select-btn shrink-0 cursor-pointer">
                            ${getSelectIconHTML(allGrpSel, true)}
                        </button>
                        <h2 class="group-section-title text-lg font-extrabold tracking-tight truncate">${_escTileText(sec.label)}</h2>
                    </div>
                    <span class="text-xs font-bold opacity-55 shrink-0">${sec.entries.length}</span>
                </div>
                <div class="${colsCls}">${innerHtml}</div>
            </section>`;
        }).join('');
    } else {
        const entries = sorted.map((it, idx) => ({ it, idx }));
        const innerHtml = isMasonry
            ? _buildTrashMasonryHtml(entries)
            : entries.map(({ it, idx }) => _renderTrashCard(it, idx)).join('');
        grid.innerHTML = `<div class="${colsCls}">${innerHtml}</div>`;
    }
    if (typeof updateFloatingGroupPill === 'function') updateFloatingGroupPill();
}

async function loadTrashTab() {
    const res = await fetch('/api/trash/items');
    if (!res.ok) return;
    const d = await res.json();
    _trashViewState.cache = d.items || [];
    _trashViewState.retentionDays = d.retention_days ?? 30;
    const validPaths = new Set(_trashViewState.cache.map(it => it.source_path));
    for (const p of [...selectedTrashPaths]) {
        if (!validPaths.has(p)) selectedTrashPaths.delete(p);
    }

    const sumEl = document.getElementById('trash-summary-label');
    if (sumEl) {
        const cnt = _trashViewState.cache.length;
        sumEl.textContent = `${cnt} élément${cnt > 1 ? 's' : ''} (${d.total_mb} Mo)`;
    }
    const retBadge = document.getElementById('trash-retention-badge');
    if (retBadge) {
        const rd = Number(_trashViewState.retentionDays);
        retBadge.textContent = rd > 0 ? `Conservation : ${rd} j` : 'Conservation : illimitée';
    }
    const hasItems = _trashViewState.cache.length > 0;
    document.getElementById('trash-restore-all-btn')?.classList.toggle('hidden', !hasItems);
    document.getElementById('trash-empty-btn')?.classList.toggle('hidden', !hasItems);

    syncTrashLayoutSizeButtons();
    renderTrashFromCache();
}

async function _runTrashBatchAction(paths, action, successMsg) {
    if (!paths || !paths.length) return;
    const res = await fetch('/api/trash/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_paths: paths, action })
    });
    if (!res.ok) return;
    paths.forEach(p => selectedTrashPaths.delete(p));
    lastClickedTrashIdx = null;
    if (successMsg && typeof showAppToast === 'function') showAppToast(successMsg, 'success');
    await loadTrashTab();
    loadStats();
}

async function restoreTrash(enc) {
    await _runTrashBatchAction([decodeURIComponent(enc)], 'RESTORE', 'Élément restauré.');
}

async function restoreSelectedTrash() {
    const paths = Array.from(selectedTrashPaths);
    if (!paths.length) return;
    await _runTrashBatchAction(paths, 'RESTORE', `${paths.length} élément${paths.length > 1 ? 's' : ''} restauré${paths.length > 1 ? 's' : ''}.`);
}

async function restoreAllTrash() {
    const paths = (_trashViewState.cache || []).map(it => it.source_path).filter(Boolean);
    if (!paths.length) return;
    await _runTrashBatchAction(paths, 'RESTORE', `${paths.length} élément${paths.length > 1 ? 's' : ''} restauré${paths.length > 1 ? 's' : ''}.`);
}

async function deletePermTrash(enc) {
    if (!confirm("Supprimer définitivement cet élément ? Cette action est irréversible.")) return;
    await _runTrashBatchAction([decodeURIComponent(enc)], 'DELETE_PERMANENTLY', 'Élément supprimé définitivement.');
}

async function deleteSelectedTrashPermanently() {
    const paths = Array.from(selectedTrashPaths);
    if (!paths.length) return;
    if (!confirm(`Supprimer définitivement ${paths.length} élément${paths.length > 1 ? 's' : ''} ? Cette action est irréversible.`)) return;
    await _runTrashBatchAction(paths, 'DELETE_PERMANENTLY', `${paths.length} élément${paths.length > 1 ? 's' : ''} supprimé${paths.length > 1 ? 's' : ''} définitivement.`);
}

async function emptyAllTrash() {
    if (!confirm("Vider définitivement la corbeille ?")) return;
    const res = await fetch('/api/trash/empty_all', { method: 'POST' });
    if (res.ok) {
        selectedTrashPaths.clear();
        lastClickedTrashIdx = null;
        if (typeof showAppToast === 'function') showAppToast('Corbeille vidée.', 'info');
    }
    loadTrashTab();
    loadStats();
}

// ==================== CATÉGORIES & STATISTIQUES ====================

let _openedCategoryId = null;
let typesLayout = localStorage.getItem('phototo_types_layout') || 'GRID';
let typesSize = localStorage.getItem('phototo_types_size') || 'MD';
let _smartCategoriesCache = { categories: [], ai_indexed: 0 };

function syncTypesLayoutSizeButtons() {
    ['GRID', 'LIST'].forEach(m => {
        const b = document.getElementById(`types-layout-btn-${m}`);
        if (b) {
            b.className = typesLayout === m
                ? 'w-8 h-8 rounded-xl nav-item-active flex items-center justify-center transition'
                : 'w-8 h-8 rounded-xl ui-pill flex items-center justify-center transition';
        }
    });
    ['SM', 'MD', 'LG'].forEach(s => {
        const b = document.getElementById(`types-size-btn-${s}`);
        if (b) {
            b.className = typesSize === s
                ? 'nav-item-active px-2.5 py-1 rounded-full transition cursor-pointer'
                : 'ui-pill px-2.5 py-1 rounded-full transition cursor-pointer';
        }
    });
}

function setTypesLayout(layout) {
    typesLayout = layout === 'LIST' ? 'LIST' : 'GRID';
    localStorage.setItem('phototo_types_layout', typesLayout);
    syncTypesLayoutSizeButtons();
    renderSmartCategoriesFromCache();
}

function setTypesSize(size) {
    typesSize = ['SM', 'MD', 'LG'].includes(size) ? size : 'MD';
    localStorage.setItem('phototo_types_size', typesSize);
    syncTypesLayoutSizeButtons();
    renderSmartCategoriesFromCache();
}

function toggleTypesSortOrder() {
    if (typeof _toggleSortOrderInput === 'function') {
        _toggleSortOrderInput('types-sort-order', 'types-sort-dir-btn', 'types-sort-arrow', () => onTypesControlsChanged());
    }
}

function onTypesControlsChanged() {
    renderSmartCategoriesFromCache();
}

function toggleFormatsPanel(forceState) {
    const panel = document.getElementById('types-formats-panel');
    const btn = document.getElementById('type-pill-FORMATS');
    if (!panel) return;
    const willShow = typeof forceState === 'boolean' ? forceState : panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !willShow);
    if (btn) btn.classList.toggle('nav-item-active', willShow);
}

function _renderTypesPills(c = {}, extCount = 0) {
    const fmtGb = (v) => `${String(Number(v || 0).toFixed(2)).replace('.', ',')} Go`;
    const pills = [
        {
            id: 'PHOTOS',
            title: 'Photos',
            sub: c.PHOTOS ? fmtGb(c.PHOTOS.gb) : 'Images fixes',
            count: (c.PHOTOS?.count ?? '...'),
            onclick: "filterGalleryByType('PHOTOS')",
            icon: `<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`
        },
        {
            id: 'VIDEOS',
            title: 'Vidéos',
            sub: c.VIDEOS ? fmtGb(c.VIDEOS.gb) : 'Séquences vidéo',
            count: (c.VIDEOS?.count ?? '...'),
            onclick: "filterGalleryByType('VIDEOS')",
            icon: `<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 4v16M17 4v16M2 12h20"/></svg>`
        },
        {
            id: 'ANIMATED',
            title: 'Images animées',
            sub: c.ANIMATED ? fmtGb(c.ANIMATED.gb) : 'GIF, WebP, Live',
            count: (c.ANIMATED?.count ?? '...'),
            onclick: "filterGalleryByType('ANIMATED')",
            icon: `<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2"/></svg>`
        },
        {
            id: 'FORMATS',
            title: 'Formats',
            sub: 'Extensions détectées',
            count: extCount,
            onclick: "toggleFormatsPanel()",
            icon: `<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`
        }
    ];
    const grid = document.getElementById('types-cards-grid');
    if (grid) {
        grid.innerHTML = pills.map(k => `
            <button id="type-pill-${k.id}" type="button" onclick="${k.onclick}"
                    class="ui-card hover:bg-[var(--bg-hover)] rounded-3xl p-4 flex items-center justify-between gap-3 text-left shadow-sm transition group cursor-pointer">
                <div class="flex items-center gap-3 min-w-0">
                    <div class="w-10 h-10 rounded-2xl ui-pill flex items-center justify-center shrink-0 group-hover:scale-105 transition">
                        ${k.icon}
                    </div>
                    <div class="min-w-0">
                        <div class="text-xs font-extrabold truncate">${k.title}</div>
                        <div class="text-[11px] opacity-60 font-semibold truncate">${k.sub}</div>
                    </div>
                </div>
                <span class="ui-pill px-2.5 py-1 rounded-full text-xs font-extrabold tabular-nums shrink-0">${k.count}</span>
            </button>
        `).join('');
    }
}

function renderStatsTypeBreakdown(c = {}) {
    const barEl = document.getElementById('stats-type-bar');
    const listEl = document.getElementById('stats-type-breakdown');
    const totEl = document.getElementById('stats-type-total');
    if (!barEl || !listEl) return;

    const rows = [
        { key: 'PHOTOS', label: 'Photos', color: 'bg-sky-500' },
        { key: 'VIDEOS', label: 'Vidéos', color: 'bg-violet-500' },
        { key: 'ANIMATED', label: 'Images animées', color: 'bg-emerald-500' },
        { key: 'RAW', label: 'RAW', color: 'bg-amber-500' },
        { key: 'SCREENSHOTS', label: "Captures d'écran", color: 'bg-rose-500' }
    ].map(r => ({
        ...r,
        count: Number(c[r.key]?.count || 0),
        gb: Number(c[r.key]?.gb || 0)
    }));

    const totalCount = rows.reduce((acc, r) => acc + r.count, 0);
    const totalGb = rows.reduce((acc, r) => acc + r.gb, 0);
    if (totEl) totEl.textContent = `${String(totalGb.toFixed(2)).replace('.', ',')} Go`;

    if (totalCount === 0) {
        barEl.innerHTML = '';
        listEl.innerHTML = `<div class="text-xs opacity-60 font-semibold py-2">Aucun média indexé pour le moment.</div>`;
        return;
    }

    barEl.innerHTML = rows.filter(r => r.count > 0).map(r => {
        const pct = Math.max(2, (r.count / totalCount) * 100);
        return `<div class="${r.color} h-full transition-all" style="width:${pct.toFixed(1)}%" title="${r.label}: ${r.count}"></div>`;
    }).join('');

    listEl.innerHTML = rows.map(r => {
        const pct = totalCount > 0 ? ((r.count / totalCount) * 100).toFixed(1).replace('.', ',') : '0,0';
        const gbTxt = String(r.gb.toFixed(2)).replace('.', ',');
        return `
            <div class="flex items-center justify-between gap-2 text-xs">
                <div class="flex items-center gap-2 min-w-0">
                    <span class="w-2.5 h-2.5 rounded-full ${r.color} shrink-0"></span>
                    <span class="font-bold truncate">${r.label}</span>
                </div>
                <div class="flex items-center gap-2 shrink-0 tabular-nums">
                    <span class="font-extrabold">${r.count}</span>
                    <span class="opacity-50">·</span>
                    <span class="opacity-70 font-semibold">${gbTxt} Go</span>
                    <span class="ui-pill px-2 py-0.5 rounded-full text-[10px] font-bold opacity-80">${pct} %</span>
                </div>
            </div>`;
    }).join('');
}

function renderStatsCoverage(d = {}) {
    const el = document.getElementById('stats-coverage-list');
    if (!el) return;
    const cov = d.coverage || {};
    const items = [
        { label: 'Doublons exacts (BLAKE3)', data: cov.dedup },
        { label: 'Médias similaires (pHash / Vidéo)', data: cov.similar },
        { label: 'Texte OCR', data: cov.ocr },
        { label: 'Indexation IA visuelle (CLIP)', data: cov.clip },
        { label: 'Détection des visages', data: cov.faces }
    ];
    const barsHtml = items.map(it => {
        const c = it.data || { done: 0, total: 0, percent: 0 };
        const pct = Math.max(0, Math.min(100, Number(c.percent || 0)));
        return `
            <div class="space-y-1">
                <div class="flex items-center justify-between text-[11px] font-bold">
                    <span class="opacity-85">${it.label}</span>
                    <span class="tabular-nums opacity-70">${c.done || 0} / ${c.total || 0} (${pct} %)</span>
                </div>
                <div class="h-2 rounded-full ui-pill overflow-hidden">
                    <div class="h-full rounded-full transition-all duration-300" style="width:${pct}%; background-color: var(--accent);"></div>
                </div>
            </div>`;
    }).join('');

    const extrasHtml = `
        <div class="pt-2 border-t border-[var(--border-subtle)] grid grid-cols-3 gap-2">
            <button type="button" onclick="switchTab('dups')" class="ui-pill hover:bg-[var(--bg-hover)] rounded-2xl p-2.5 text-center transition cursor-pointer">
                <div class="text-xs font-extrabold tabular-nums">${Number(d.duplicates || 0)}</div>
                <div class="text-[10px] opacity-65 font-semibold truncate">Doublons</div>
            </button>
            <button type="button" onclick="switchTab('similar')" class="ui-pill hover:bg-[var(--bg-hover)] rounded-2xl p-2.5 text-center transition cursor-pointer">
                <div class="text-xs font-extrabold tabular-nums">${Number(d.similar_count || 0)}</div>
                <div class="text-[10px] opacity-65 font-semibold truncate">Similaires</div>
            </button>
            <button type="button" onclick="switchTab('sug-missing_meta')" class="ui-pill hover:bg-[var(--bg-hover)] rounded-2xl p-2.5 text-center transition cursor-pointer">
                <div class="text-xs font-extrabold tabular-nums">${Number(d.missing_meta || 0)}</div>
                <div class="text-[10px] opacity-65 font-semibold truncate">Sans date</div>
            </button>
        </div>`;

    el.innerHTML = `${barsHtml}${extrasHtml}`;
}

let _statsDetailedCache = null;
let _statsGranularity = 'years';
let _statsOrderMode = 'recent';
let _statsMetricMode = 'count';

function _formatStatsBytes(bytes) {
    const b = Number(bytes || 0);
    if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(2).replace('.', ',')} Go`;
    if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1).replace('.', ',')} Mo`;
    if (b >= 1024) return `${Math.round(b / 1024)} Ko`;
    return `${b} o`;
}

function _formatStatsVideoDuration(sec) {
    const total = Math.max(0, Math.round(Number(sec || 0)));
    if (total === 0) return '0 s';
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (hrs > 0) return `${hrs} h ${String(mins).padStart(2, '0')} min`;
    if (mins > 0) return `${mins} min ${String(s).padStart(2, '0')} s`;
    return `${s} s`;
}

function _syncStatsSegButtons(prefix, activeVal, values) {
    values.forEach(v => {
        const b = document.getElementById(`${prefix}-${v}`);
        if (!b) return;
        b.className = v === activeVal
            ? 'nav-item-active px-2.5 py-1 rounded-full transition cursor-pointer'
            : 'px-2.5 py-1 rounded-full opacity-75 hover:opacity-100 transition cursor-pointer';
    });
}

function setStatsGranularity(gran) {
    if (!['years', 'months', 'weeks', 'days'].includes(gran)) return;
    _statsGranularity = gran;
    ['years', 'months', 'weeks', 'days'].forEach(v => {
        const b = document.getElementById(`stats-gran-${v}`);
        if (!b) return;
        b.className = v === gran
            ? 'nav-item-active px-3 py-1 rounded-full transition cursor-pointer'
            : 'px-3 py-1 rounded-full opacity-75 hover:opacity-100 transition cursor-pointer';
    });
    renderStatsPeriodSection();
}

function setStatsOrderMode(mode) {
    _statsOrderMode = mode === 'top' ? 'top' : 'recent';
    _syncStatsSegButtons('stats-order', _statsOrderMode, ['recent', 'top']);
    renderStatsPeriodSection();
}

function setStatsMetricMode(mode) {
    _statsMetricMode = mode === 'bytes' ? 'bytes' : 'count';
    _syncStatsSegButtons('stats-metric', _statsMetricMode, ['count', 'bytes']);
    renderStatsPeriodSection();
}

function renderStatsPeriodSection() {
    const chartEl = document.getElementById('stats-period-chart');
    const listEl = document.getElementById('stats-period-list');
    if (!chartEl || !listEl) return;

    const raw = (_statsDetailedCache && Array.isArray(_statsDetailedCache[_statsGranularity]))
        ? [..._statsDetailedCache[_statsGranularity]]
        : [];
    const metric = _statsMetricMode;
    const isTop = _statsOrderMode === 'top';

    if (isTop) {
        raw.sort((a, b) => (Number(b[metric] || 0) - Number(a[metric] || 0)) || String(b.key).localeCompare(String(a.key)));
    } else {
        raw.sort((a, b) => String(b.key).localeCompare(String(a.key)));
    }

    if (!raw.length) {
        chartEl.innerHTML = `<div class="w-full text-center text-xs opacity-60 font-semibold self-center">Aucune donnée datée pour afficher cette chronologie.</div>`;
        listEl.innerHTML = '';
        return;
    }

    const chartSlice = raw.slice(0, 18);
    if (!isTop) chartSlice.reverse();
    const maxVal = Math.max(1, ...chartSlice.map(x => Number(x[metric] || 0)));

    chartEl.innerHTML = chartSlice.map(it => {
        const val = Number(it[metric] || 0);
        const hPct = Math.max(8, Math.round((val / maxVal) * 100));
        const pRatio = it.count > 0 ? Math.round(((it.photos + it.animated) / it.count) * 100) : 100;
        const vRatio = Math.max(0, 100 - pRatio);
        const valLbl = metric === 'bytes' ? _formatStatsBytes(it.bytes) : String(it.count);
        const shortLbl = _statsGranularity === 'years'
            ? it.key
            : (_statsGranularity === 'months' ? `${it.sub || ''} ${it.key.slice(2, 4)}`.trim()
            : (_statsGranularity === 'weeks' ? `S${it.key.slice(-2)}` : it.key.slice(5)));
        const tip = `${it.label} : ${it.count} média(s) (${_formatStatsBytes(it.bytes)})`;
        return `
            <button type="button" onclick="filterGalleryByPeriod('${it.date_from}', '${it.date_to}')" title="${_escTileText(tip)}"
                    class="flex-1 min-w-[34px] max-w-[68px] h-full flex flex-col items-center justify-end gap-1 group cursor-pointer">
                <span class="text-[9px] font-extrabold opacity-65 group-hover:opacity-100 tabular-nums truncate w-full text-center">${valLbl}</span>
                <div class="w-full max-w-[26px] rounded-t-xl overflow-hidden flex flex-col justify-end transition-transform group-hover:scale-105" style="height:${Math.round(hPct * 0.72)}%;">
                    ${vRatio > 0 ? `<div class="w-full bg-violet-500/85" style="height:${vRatio}%"></div>` : ''}
                    ${pRatio > 0 ? `<div class="w-full" style="height:${pRatio}%; background-color: var(--accent);"></div>` : ''}
                </div>
                <span class="text-[9px] font-bold opacity-60 group-hover:opacity-100 truncate w-full text-center">${_escTileText(shortLbl)}</span>
            </button>`;
    }).join('');

    const listMax = Math.max(1, ...raw.map(x => Number(x[metric] || 0)));
    listEl.innerHTML = raw.slice(0, 60).map(it => {
        const val = Number(it[metric] || 0);
        const pct = Math.max(4, Math.round((val / listMax) * 100));
        const parts = [];
        if (it.photos > 0) parts.push(`${it.photos} photo${it.photos > 1 ? 's' : ''}`);
        if (it.videos > 0) parts.push(`${it.videos} vidéo${it.videos > 1 ? 's' : ''}`);
        if (it.animated > 0) parts.push(`${it.animated} anim.`);
        return `
            <button type="button" onclick="filterGalleryByPeriod('${it.date_from}', '${it.date_to}')"
                    class="ui-pill hover:bg-[var(--bg-hover)] rounded-2xl p-3 text-left space-y-1.5 transition cursor-pointer group">
                <div class="flex items-center justify-between gap-2">
                    <div class="min-w-0">
                        <div class="text-xs font-extrabold truncate group-hover:underline">${_escTileText(it.label)}</div>
                        <div class="text-[10px] opacity-60 font-semibold truncate">${_escTileText(it.sub ? `${it.sub} · ` : '')}${parts.join(' · ') || '0 média'}</div>
                    </div>
                    <div class="text-right shrink-0 tabular-nums">
                        <div class="text-xs font-extrabold">${it.count}</div>
                        <div class="text-[10px] opacity-65 font-semibold">${_formatStatsBytes(it.bytes)}</div>
                    </div>
                </div>
                <div class="h-1.5 w-full rounded-full bg-black/15 overflow-hidden">
                    <div class="h-full rounded-full" style="width:${pct}%; background-color: var(--accent);"></div>
                </div>
            </button>`;
    }).join('');
}

function _renderStatsMiniColumns(containerEl, items, labelFn, titleFn) {
    if (!containerEl) return;
    if (!items || !items.length) {
        containerEl.innerHTML = `<div class="w-full text-center text-xs opacity-60 self-center">Aucune donnée.</div>`;
        return;
    }
    const maxC = Math.max(1, ...items.map(x => Number(x.count || 0)));
    containerEl.innerHTML = items.map(it => {
        const c = Number(it.count || 0);
        const hPct = c > 0 ? Math.max(10, Math.round((c / maxC) * 100)) : 4;
        const lbl = labelFn(it);
        return `
            <div title="${_escTileText(titleFn(it))}" class="flex-1 min-w-0 h-full flex flex-col items-center justify-end gap-1 group">
                <div class="w-full rounded-t-md transition-opacity ${c > 0 ? 'opacity-85 group-hover:opacity-100' : 'opacity-20'}"
                     style="height:${Math.round(hPct * 0.78)}%; background-color: var(--accent);"></div>
                <span class="text-[9px] font-bold opacity-60 truncate w-full text-center">${_escTileText(lbl)}</span>
            </div>`;
    }).join('');
}

function renderStatsDetailedSections(det) {
    _statsDetailedCache = det || null;
    if (!det) return;

    const sum = det.summary || {};
    const gbSpanEl = document.getElementById('stats-kpi-gb');
    if (gbSpanEl) {
        let spanStr = `${String(sum.total_gb ?? '0,00').replace('.', ',')} Go`;
        if (sum.first_ts && sum.last_ts) {
            const y1 = new Date(sum.first_ts * 1000).getFullYear();
            const y2 = new Date(sum.last_ts * 1000).getFullYear();
            spanStr += y1 === y2 ? ` · ${y1}` : ` · ${y1}–${y2}`;
        }
        gbSpanEl.textContent = spanStr;
    }

    renderStatsPeriodSection();

    // Jours de la semaine
    const wds = det.weekdays || [];
    const maxWd = Math.max(1, ...wds.map(x => Number(x.count || 0)));
    const bestWd = wds.reduce((best, cur) => (!best || cur.count > best.count ? cur : best), null);
    const wdPeakEl = document.getElementById('stats-weekday-peak');
    if (wdPeakEl) wdPeakEl.textContent = bestWd && bestWd.count > 0 ? `Pic : ${bestWd.label}` : '—';
    const wdEl = document.getElementById('stats-weekday-chart');
    if (wdEl) {
        wdEl.innerHTML = wds.map(w => {
            const pct = w.count > 0 ? Math.max(4, Math.round((w.count / maxWd) * 100)) : 0;
            return `
                <div class="flex items-center gap-2 text-[11px]">
                    <span class="w-8 font-bold opacity-75 shrink-0">${w.short}</span>
                    <div class="flex-1 h-2 rounded-full ui-pill overflow-hidden">
                        <div class="h-full rounded-full" style="width:${pct}%; background-color: var(--accent);"></div>
                    </div>
                    <span class="w-10 text-right font-extrabold tabular-nums">${w.count}</span>
                </div>`;
        }).join('');
    }

    // Saisonnalité (12 mois)
    const seasons = det.season_months || [];
    const bestSeason = seasons.reduce((best, cur) => (!best || cur.count > best.count ? cur : best), null);
    const sPeakEl = document.getElementById('stats-season-peak');
    if (sPeakEl) sPeakEl.textContent = bestSeason && bestSeason.count > 0 ? `Pic : ${bestSeason.full}` : '—';
    _renderStatsMiniColumns(
        document.getElementById('stats-season-chart'),
        seasons,
        it => it.label,
        it => `${it.full} : ${it.count} média(s) (${_formatStatsBytes(it.bytes)})`
    );

    // Heures de la journée (24h)
    const hrs = det.hours || [];
    const bestHr = hrs.reduce((best, cur) => (!best || cur.count > best.count ? cur : best), null);
    const hPeakEl = document.getElementById('stats-hour-peak');
    if (hPeakEl) hPeakEl.textContent = bestHr && bestHr.count > 0 ? `Pic : ${bestHr.label}` : '—';
    _renderStatsMiniColumns(
        document.getElementById('stats-hour-chart'),
        hrs,
        it => (it.hour % 6 === 0 ? `${String(it.hour).padStart(2, '0')}h` : ''),
        it => `${it.label} : ${it.count} média(s)`
    );

    // Carte Métadonnées & Classement
    const metaEl = document.getElementById('stats-meta-card');
    if (metaEl) {
        const tot = Math.max(1, Number(sum.total_files || 0));
        const pctOf = (n) => `${Math.round((Number(n || 0) / tot) * 100)} %`;
        metaEl.innerHTML = `
            <div class="flex items-center justify-between gap-2">
                <span class="opacity-75 font-semibold">Avec date exacte</span>
                <span class="font-extrabold tabular-nums">${sum.dated_count || 0} <span class="opacity-60 font-semibold">(${pctOf(sum.dated_count)})</span></span>
            </div>
            <button type="button" onclick="switchTab('sug-missing_meta')" class="w-full flex items-center justify-between gap-2 hover:opacity-80 transition cursor-pointer text-left">
                <span class="opacity-75 font-semibold">Sans date / à réparer</span>
                <span class="font-extrabold tabular-nums ${sum.undated_count > 0 ? 'text-amber-400' : ''}">${sum.undated_count || 0}</span>
            </button>
            <div class="flex items-center justify-between gap-2">
                <span class="opacity-75 font-semibold">Géolocalisés (GPS)</span>
                <span class="font-extrabold tabular-nums">${sum.geotagged_count || 0} <span class="opacity-60 font-semibold">(${pctOf(sum.geotagged_count)})</span></span>
            </div>
            <button type="button" onclick="switchTab('sug-missing_gps')" class="w-full flex items-center justify-between gap-2 hover:opacity-80 transition cursor-pointer text-left">
                <span class="opacity-75 font-semibold">Sans coordonnées GPS</span>
                <span class="font-extrabold tabular-nums">${sum.no_gps_count || 0}</span>
            </button>
            <div class="pt-2 border-t border-[var(--border-subtle)] flex items-center justify-between gap-2">
                <span class="opacity-75 font-semibold">Classés dans un album</span>
                <span class="font-extrabold tabular-nums">${sum.albumed_count || 0} <span class="opacity-60 font-semibold">(${pctOf(sum.albumed_count)})</span></span>
            </div>
            <div class="flex items-center justify-between gap-2">
                <span class="opacity-75 font-semibold">Hors album</span>
                <span class="font-extrabold tabular-nums">${sum.unorganized_count || 0}</span>
            </div>`;
    }

    // Carte Résolutions & Vidéos
    const techEl = document.getElementById('stats-tech-card');
    if (techEl) {
        const resMap = det.resolutions || {};
        const big = sum.largest_file;
        const avgStr = `${String(Number(sum.avg_mb || 0).toFixed(2)).replace('.', ',')} Mo`;
        techEl.innerHTML = `
            <div class="flex items-center justify-between gap-2">
                <span class="opacity-75 font-semibold">Durée vidéo cumulée</span>
                <span class="font-extrabold tabular-nums">${_formatStatsVideoDuration(sum.total_video_duration_sec)}</span>
            </div>
            <div class="flex items-center justify-between gap-2">
                <span class="opacity-75 font-semibold">Poids moyen / fichier</span>
                <span class="font-extrabold tabular-nums">${avgStr}</span>
            </div>
            ${big ? `
            <div class="flex items-center justify-between gap-2">
                <span class="opacity-75 font-semibold shrink-0">Plus gros fichier</span>
                <span class="font-extrabold truncate max-w-[60%] text-right" title="${_escTileText(big.name)}">${_escTileText(big.name)} (${String(big.mb).replace('.', ',')} Mo)</span>
            </div>` : ''}
            <div class="pt-2 border-t border-[var(--border-subtle)] grid grid-cols-2 gap-1.5 text-[11px]">
                <div class="ui-pill rounded-xl px-2.5 py-1.5 flex items-center justify-between"><span class="opacity-70 font-bold">4K+</span><span class="font-extrabold tabular-nums">${resMap['4k'] || 0}</span></div>
                <div class="ui-pill rounded-xl px-2.5 py-1.5 flex items-center justify-between"><span class="opacity-70 font-bold">Full HD</span><span class="font-extrabold tabular-nums">${resMap.full_hd || 0}</span></div>
                <div class="ui-pill rounded-xl px-2.5 py-1.5 flex items-center justify-between"><span class="opacity-70 font-bold">HD</span><span class="font-extrabold tabular-nums">${resMap.hd || 0}</span></div>
                <div class="ui-pill rounded-xl px-2.5 py-1.5 flex items-center justify-between"><span class="opacity-70 font-bold">&lt; HD</span><span class="font-extrabold tabular-nums">${resMap.sd || 0}</span></div>
            </div>`;
    }

    // Carte Principaux albums
    const albEl = document.getElementById('stats-top-albums-card');
    if (albEl) {
        const albs = det.top_albums || [];
        if (!albs.length) {
            albEl.innerHTML = `<div class="opacity-60 font-semibold py-2">Aucun album renseigné pour le moment.</div>`;
        } else {
            const maxAlb = Math.max(1, ...albs.map(a => Number(a.count || 0)));
            albEl.innerHTML = albs.map(a => {
                const pct = Math.max(5, Math.round((a.count / maxAlb) * 100));
                const enc = encodeURIComponent(a.name);
                return `
                    <button type="button" onclick="switchTab('albums'); setTimeout(() => openSingleAlbumView(decodeURIComponent('${enc}')), 40)"
                            class="w-full text-left space-y-1 hover:opacity-85 transition cursor-pointer">
                        <div class="flex items-center justify-between gap-2 text-[11px]">
                            <span class="font-extrabold truncate">${_escTileText(a.name)}</span>
                            <span class="opacity-75 font-bold tabular-nums shrink-0">${a.count} · ${_formatStatsBytes(a.bytes)}</span>
                        </div>
                        <div class="h-1.5 rounded-full ui-pill overflow-hidden">
                            <div class="h-full rounded-full" style="width:${pct}%; background-color: var(--accent);"></div>
                        </div>
                    </button>`;
            }).join('');
        }
    }
}

async function loadStatsPage() {
    _renderTypesPills({}, '...');
    try {
        const [, resTypes, resDet] = await Promise.all([
            typeof loadStats === 'function' ? loadStats() : Promise.resolve(),
            fetch('/api/types/summary'),
            fetch('/api/stats/detailed')
        ]);
        let d = { categories: {}, extensions: [] };
        if (resTypes && resTypes.ok) d = await resTypes.json();
        _renderTypesPills(d.categories || {}, (d.extensions || []).length);

        const extGrid = document.getElementById('types-ext-grid');
        if (extGrid) {
            extGrid.innerHTML = (d.extensions || []).length
                ? (d.extensions || []).map(e => `
                    <button type="button" onclick="filterGalleryByExt('${e.ext}')"
                            class="ui-pill hover:bg-[var(--bg-hover)] rounded-2xl p-3 cursor-pointer flex justify-between items-center gap-2 font-bold text-xs transition text-left">
                        <div class="min-w-0">
                            <div class="font-mono font-extrabold truncate">${e.ext || '(aucune)'}</div>
                            <div class="text-[10px] opacity-60 font-semibold">${String(e.mb ?? 0).replace('.', ',')} Mo</div>
                        </div>
                        <span class="ui-card px-2 py-0.5 rounded-full text-[11px] font-extrabold tabular-nums shrink-0">${e.count}</span>
                    </button>
                `).join('')
                : `<div class="col-span-full text-xs opacity-60 font-semibold py-2">Aucune extension détectée.</div>`;
        }
        renderStatsTypeBreakdown(d.categories || {});

        if (resDet && resDet.ok) {
            const det = await resDet.json();
            renderStatsDetailedSections(det);
        }
    } catch (e) {
        console.error('loadStatsPage error:', e);
    }
}

async function loadTypesSummary() {
    closeSingleCategoryView();
    syncTypesLayoutSizeButtons();
    let catsData = { categories: [], ai_indexed: 0 };
    try {
        const resCats = await fetch('/api/categories/list');
        if (resCats.ok) catsData = await resCats.json();
    } catch (e) {
        console.error('loadTypesSummary error:', e);
    }
    _smartCategoriesCache = {
        categories: Array.isArray(catsData.categories) ? catsData.categories : [],
        ai_indexed: Number(catsData.ai_indexed || 0)
    };
    renderSmartCategoriesFromCache();
}

function renderSmartCategoriesFromCache() {
    renderSmartCategoriesGrid(_smartCategoriesCache.categories || [], _smartCategoriesCache.ai_indexed || 0);
}

function renderSmartCategoriesGrid(categories, aiIndexed = 0) {
    const grid = document.getElementById('smart-categories-grid');
    if (!grid) return;

    const sortBy = document.getElementById('types-sort-by')?.value || 'content';
    const sortOrder = document.getElementById('types-sort-order')?.value || 'desc';
    const filterBy = document.getElementById('types-filter-by')?.value || 'ALL';
    const dir = sortOrder === 'asc' ? 1 : -1;

    let list = [...(categories || [])];
    if (filterBy === 'AI') list = list.filter(c => String(c.source || '').toUpperCase() === 'AI');
    else if (filterBy === 'MANUAL') list = list.filter(c => String(c.source || '').toUpperCase() !== 'AI');
    else if (filterBy === 'NON_EMPTY') list = list.filter(c => Number(c.count || 0) > 0);
    else if (filterBy === 'EMPTY') list = list.filter(c => Number(c.count || 0) === 0);

    list.sort((a, b) => {
        if (sortBy === 'name') {
            return dir * String(a.name || '').localeCompare(String(b.name || ''), 'fr', { sensitivity: 'base' });
        }
        if (sortBy === 'added') {
            return dir * (Number(a.category_id || 0) - Number(b.category_id || 0));
        }
        const diff = Number(a.count || 0) - Number(b.count || 0);
        if (diff !== 0) return dir * diff;
        return String(a.name || '').localeCompare(String(b.name || ''), 'fr', { sensitivity: 'base' });
    });

    const totalLbl = document.getElementById('types-total-label');
    if (totalLbl) totalLbl.textContent = `${list.length} catégorie${list.length > 1 ? 's' : ''}`;

    if (typesLayout === 'LIST') {
        grid.className = 'flex flex-col gap-2 pb-10';
    } else if (typesSize === 'SM') {
        grid.className = 'grid grid-cols-3 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-7 gap-3.5 pb-10';
    } else if (typesSize === 'LG') {
        grid.className = 'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6 pb-10';
    } else {
        grid.className = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-5 pb-10';
    }

    if (!list.length) {
        const hasAny = (categories || []).length > 0;
        const hint = hasAny
            ? 'Aucune catégorie ne correspond à ce filtre.'
            : (aiIndexed > 0
                ? 'Aucune catégorie générée pour l\'instant. Cliquez sur « Analyser » pour classer automatiquement vos photos.'
                : 'Aucune catégorie pour le moment. Cliquez sur « Analyser » pour lancer l\'IA CLIP ou sur « + Ajouter » pour créer une catégorie manuelle.');
        grid.innerHTML = `<div class="col-span-full ui-card rounded-3xl p-10 text-center text-sm font-semibold opacity-65 shadow-sm">${hint}</div>`;
        return;
    }

    const deleteSvg = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.1" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>`;
    const emptySvg = `<svg class="w-9 h-9" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`;

    grid.innerHTML = list.map(cat => {
        const hasCover = Boolean(cat.cover_path);
        const isAi = String(cat.source || '').toUpperCase() === 'AI';
        const escName = _escTileText(cat.name);
        const safeJsName = String(cat.name || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const countTxt = `${cat.count} élément${cat.count > 1 ? 's' : ''}`;
        const srcBadgeTxt = isAi ? 'IA' : 'Manuelle';

        if (typesLayout === 'LIST') {
            const thumbSz = typesSize === 'SM' ? 'w-11 h-11 rounded-xl' : (typesSize === 'LG' ? 'w-20 h-20 rounded-2xl' : 'w-14 h-14 rounded-2xl');
            const coverThumb = hasCover
                ? `<img src="/thumb?path=${encodeURIComponent(cat.cover_path)}" loading="lazy" class="w-full h-full object-cover"/>`
                : `<div class="w-full h-full flex items-center justify-center opacity-25">${emptySvg}</div>`;
            return `
                <div onclick="openSingleCategoryView(${cat.category_id})"
                     class="album-card ui-card hover:bg-[var(--bg-hover)] rounded-2xl p-2.5 flex items-center justify-between gap-3.5 cursor-pointer group shadow-sm transition">
                    <div class="flex items-center gap-3.5 min-w-0">
                        <div class="${thumbSz} overflow-hidden bg-black/10 shrink-0">${coverThumb}</div>
                        <div class="min-w-0">
                            <div class="flex items-center gap-2 min-w-0">
                                <span class="text-sm font-extrabold truncate">${escName}</span>
                                <span class="ui-pill px-2 py-0.5 rounded-full text-[10px] font-bold opacity-75 shrink-0">${srcBadgeTxt}</span>
                            </div>
                            <div class="text-[11px] opacity-60 font-semibold mt-0.5">${countTxt}</div>
                        </div>
                    </div>
                    <button type="button" onclick="event.stopPropagation(); deleteSmartCategoryById(${cat.category_id}, '${safeJsName}')" title="Supprimer"
                            class="w-8 h-8 rounded-full ui-pill hover:bg-rose-500/20 hover:text-rose-400 flex items-center justify-center opacity-0 group-hover:opacity-100 transition cursor-pointer shrink-0">
                        ${deleteSvg}
                    </button>
                </div>`;
        }

        const coverHtml = hasCover
            ? `<img src="/thumb?path=${encodeURIComponent(cat.cover_path)}" loading="lazy" class="w-full h-full object-cover group-hover:scale-105 transition duration-300"/>`
            : `<div class="w-full h-full flex items-center justify-center opacity-20">${emptySvg}</div>`;
        const srcBadge = `<span class="absolute bottom-2.5 left-2.5 bg-black/45 backdrop-blur-md border border-white/15 text-white text-[10px] font-bold px-2.5 py-0.5 rounded-full z-10 pointer-events-none">${srcBadgeTxt}</span>`;

        return `
            <div onclick="openSingleCategoryView(${cat.category_id})"
                 class="album-card cursor-pointer group flex flex-col">
                <div class="ui-card aspect-square rounded-[24px] overflow-hidden relative shadow-sm group-hover:shadow-xl transition-all duration-200">
                    ${coverHtml}
                    ${hasCover ? '<div class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/55 via-black/15 to-transparent opacity-75 group-hover:opacity-95 transition-opacity"></div>' : ''}
                    ${srcBadge}
                    <button type="button" onclick="event.stopPropagation(); deleteSmartCategoryById(${cat.category_id}, '${safeJsName}')" title="Supprimer"
                            class="absolute top-2.5 right-2.5 w-8 h-8 rounded-full bg-black/45 backdrop-blur-md border border-white/15 text-white hover:bg-rose-500/85 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10 shadow-lg cursor-pointer">
                        ${deleteSvg}
                    </button>
                </div>
                <div class="pt-2.5 px-1">
                    <div class="text-sm font-extrabold truncate leading-tight">${escName}</div>
                    <div class="text-[11px] opacity-60 font-semibold mt-0.5 truncate">${countTxt}</div>
                </div>
            </div>
        `;
    }).join('');
}

async function promptCreateSmartCategory() {
    const name = prompt("Nom de la nouvelle catégorie (ex: Chats, Voitures, Montagnes) :");
    if (!name || !name.trim()) return;
    const promptTxt = prompt("Mots-clés pour l'IA (laisser vide pour utiliser le nom) :", name.trim());
    const res = await fetch('/api/categories/create', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: name.trim(), prompt: (promptTxt || '').trim()})
    });
    if (!res.ok) {
        try {
            const err = await res.json();
            alert(err.detail || "Impossible de créer la catégorie.");
        } catch (e) {}
        return;
    }
    loadTypesSummary();
}

async function deleteSmartCategoryById(catId, name) {
    if (!confirm(`Supprimer la catégorie « ${name} » ?`)) return;
    await fetch('/api/categories/delete', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({category_id: catId})
    });
    loadTypesSummary();
}

function _setCategoriesStatusBanner(msg, isError = false) {
    const el = document.getElementById('categories-status-banner');
    if (!el) return;
    if (!msg) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
    }
    el.textContent = msg;
    el.classList.remove('hidden', 'text-rose-600');
    if (isError) el.classList.add('text-rose-600');
}

async function analyzeSmartCategories() {
    const btn = document.getElementById('btn-analyze-categories');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Analyse...';
    }
    _setCategoriesStatusBanner('Analyse des catégories en cours...');
    try {
        const res = await fetch('/api/categories/analyze', {method: 'POST'});
        if (!res.ok) {
            const errTxt = await res.text().catch(() => '');
            _setCategoriesStatusBanner(`Erreur lors de l'analyse (${res.status}). ${errTxt}`, true);
            return;
        }
        const d = await res.json();
        if (d.status === 'no_embeddings') {
            _setCategoriesStatusBanner("Aucune empreinte CLIP en base : lancement de l'indexation IA CLIP en arrière-plan...");
            if (typeof runTask === 'function') {
                await runTask('CLIP');
            }
            _setCategoriesStatusBanner("Indexation IA CLIP lancée en arrière-plan (voir Activités). Les catégories seront remplies automatiquement à la fin.");
        } else {
            await loadTypesSummary();
            _setCategoriesStatusBanner(`Analyse terminée : ${d.assigned || 0} correspondance(s) enregistrée(s).`);
        }
    } catch (e) {
        _setCategoriesStatusBanner(`Erreur réseau : ${e.message || e}`, true);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><span>Analyser</span>`;
        }
    }
}

async function openSingleCategoryView(categoryId) {
    _openedCategoryId = categoryId;
    const ov = document.getElementById('types-overview-panel');
    const sp = document.getElementById('category-single-panel');
    if (ov) ov.classList.add('hidden');
    if (sp) sp.classList.remove('hidden');

    const res = await fetch(`/api/categories/items?category_id=${categoryId}`);
    const d = await res.json();
    const titleEl = document.getElementById('single-category-title');
    const countEl = document.getElementById('single-category-count');
    if (titleEl) titleEl.textContent = d.category?.name || 'Catégorie';
    if (countEl) countEl.textContent = `${d.total || 0} élément${(d.total || 0) > 1 ? 's' : ''}`;

    const grid = document.getElementById('category-single-grid');
    if (!grid) return;
    const items = d.items || [];
    if (!items.length) {
        grid.innerHTML = `<div class="col-span-full ui-card rounded-3xl p-10 text-center text-sm font-semibold opacity-65 shadow-sm">Aucun média dans cette catégorie pour le moment.</div>`;
        return;
    }
    currentCategoryItems = items;
    grid.innerHTML = items.map((it, idx) => {
        const isVid = typeof isVideoFile === 'function' && isVideoFile(it.dest_path);
        const durTxt = typeof formatDuration === 'function' ? formatDuration(it.duration_sec) : '';
        const vidBadge = isVid
            ? `<div class="absolute bottom-2.5 left-2.5 z-10 bg-black/35 backdrop-blur-sm text-white/95 text-[10px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full flex items-center gap-1 pointer-events-none">
                   <svg class="w-2.5 h-2.5 opacity-90" fill="currentColor" viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>
                   <span>${durTxt}</span>
               </div>`
            : '';
        return `
            <div onclick="openCategoryLightbox(${idx})"
                 class="media-tile ui-card rounded-[24px] overflow-hidden cursor-pointer group shadow-sm hover:shadow-xl relative transition-all duration-150">
                <div class="aspect-square overflow-hidden bg-black/10 relative">
                    ${renderMediaPreview(it.dest_path, 'w-full h-full object-cover group-hover:scale-[1.03] transition duration-300')}
                    ${vidBadge}
                </div>
            </div>
        `;
    }).join('');
}

let currentCategoryItems = [];
function openCategoryLightbox(idx) {
    if (!currentCategoryItems.length) return;
    lightboxIsCustomItem = false;
    currentGalleryItems = currentCategoryItems;
    openLightbox(idx);
}

function closeSingleCategoryView() {
    _openedCategoryId = null;
    const ov = document.getElementById('types-overview-panel');
    const sp = document.getElementById('category-single-panel');
    if (sp) sp.classList.add('hidden');
    if (ov) ov.classList.remove('hidden');
}

async function deleteCurrentSmartCategory() {
    if (!_openedCategoryId) return;
    if (!confirm("Supprimer cette catégorie ?")) return;
    await fetch('/api/categories/delete', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({category_id: _openedCategoryId})
    });
    closeSingleCategoryView();
    loadTypesSummary();
}

function filterGalleryByType(typeCode) {
    selectedFilterTypes = typeCode ? [typeCode] : [];
    currentExtFilter = '';
    renderFilterChips();
    updateActiveFilterBadge();
    switchTab('gallery');
}

function filterGalleryByExt(ext) {
    selectedFilterTypes = [];
    selectedFilterExts = ext ? [ext] : [];
    currentExtFilter = ext;
    renderFilterChips();
    updateActiveFilterBadge();
    switchTab('gallery');
}

function filterGalleryByPeriod(dateFrom, dateTo) {
    if (!dateFrom && !dateTo) return;
    selectedFilterTypes = [];
    selectedFilterYears = [];
    selectedFilterMonths = [];
    selectedFilterExts = [];
    selectedFilterAlbums = [];
    selectedFilterFolders = [];
    selectedFilterPersons = [];
    currentExtFilter = '';
    selectedFilterPeriods = [{ from: dateFrom || '', to: dateTo || '' }];
    const dfEl = document.getElementById('gal-date-from');
    const dtEl = document.getElementById('gal-date-to');
    if (dfEl) dfEl.value = '';
    if (dtEl) dtEl.value = '';
    renderFilterChips();
    updateActiveFilterBadge();
    switchTab('gallery');
}

async function openEditorFromTools(kind) {
    const wantVideo = kind === 'VIDEO';
    let match = (currentGalleryItems || []).find(it => wantVideo ? isVideoFile(it.dest_path) : !isVideoFile(it.dest_path));
    if (!match) {
        try {
            const mt = wantVideo ? 'VIDEOS' : 'PHOTOS';
            const res = await fetch(`/api/gallery/items?page=1&limit=1&media_type=${mt}`);
            if (res.ok) {
                const d = await res.json();
                if (Array.isArray(d.items) && d.items.length > 0) match = d.items[0];
            }
        } catch (_) {}
    }
    if (match && match.source_path && match.dest_path) {
        openStudioModal(encodeURIComponent(match.source_path), encodeURIComponent(match.dest_path));
        return;
    }
    if (typeof showAppToast === 'function') {
        showAppToast(wantVideo ? 'Aucune vidéo disponible dans cette bibliothèque.' : 'Aucune photo disponible dans cette bibliothèque.', 'info');
    }
}

// ==================== VISIONNEUSE PLEIN ÉCRAN (LIGHTBOX) ====================

let lbMiniMap = null;
let lbMiniMarker = null;
let lbZoomScale = 1;
let lbPanX = 0;
let lbPanY = 0;
let lbIsDragging = false;
let lbDragStartX = 0;
let lbDragStartY = 0;
let lbSlideshowTimer = null;

function _applyLightboxZoomTransform() {
    const imgEl = document.getElementById('lb-img');
    const lbl = document.getElementById('lb-zoom-label');
    if (imgEl) {
        imgEl.style.transform = `translate(${lbPanX}px, ${lbPanY}px) scale(${lbZoomScale})`;
        imgEl.style.cursor = lbZoomScale > 1 ? (lbIsDragging ? 'grabbing' : 'grab') : 'zoom-in';
    }
    if (lbl) lbl.textContent = `${Math.round(lbZoomScale * 100)}%`;
}

function resetLightboxZoom() {
    lbZoomScale = 1;
    lbPanX = 0;
    lbPanY = 0;
    _applyLightboxZoomTransform();
}

function adjustLightboxZoom(delta) {
    const imgEl = document.getElementById('lb-img');
    if (!imgEl || imgEl.classList.contains('hidden')) return;
    lbZoomScale = Math.min(4, Math.max(1, Number((lbZoomScale + delta).toFixed(2))));
    if (lbZoomScale <= 1) {
        lbPanX = 0;
        lbPanY = 0;
    }
    _applyLightboxZoomTransform();
}

function toggleLightboxDoubleClickZoom(e) {
    if (e) e.stopPropagation();
    if (lbZoomScale > 1.05) {
        resetLightboxZoom();
    } else {
        lbZoomScale = 2.25;
        lbPanX = 0;
        lbPanY = 0;
        _applyLightboxZoomTransform();
    }
}

const _LB_PLAY_SVG = '<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
const _LB_PAUSE_SVG = '<svg class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
const _LB_EDIT_PHOTO_SVG = '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M12 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M3 16.5l4-3.5 4 3.5"/><path d="M19 3a1.8 1.8 0 0 1 2.5 2.5L15.5 11.5 13 9 19 3Z"/><path d="M13 9c-1.5.4-2.4 1.8-2.7 3.5 1.7-.3 3.1-1.2 3.7-2.5"/></svg>';
const _LB_EDIT_VIDEO_SVG = '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M10.5 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/><polygon points="6.5 13.5 11 16.2 6.5 18.9" fill="currentColor" stroke="none"/><circle cx="16" cy="3.8" r="1.5"/><circle cx="20.2" cy="8" r="1.5"/><line x1="15.6" y1="5.2" x2="12.2" y2="12"/><line x1="18.8" y1="8.2" x2="11" y2="9.2"/></svg>';

function updateLightboxEditButton(isVid) {
    const btn = document.getElementById('lb-btn-edit');
    if (!btn) return;
    btn.innerHTML = isVid ? _LB_EDIT_VIDEO_SVG : _LB_EDIT_PHOTO_SVG;
    btn.title = isVid ? 'Modifier la vidéo' : 'Modifier la photo';
}

function toggleLightboxSlideshow(forceStop = false) {
    const iconEl = document.getElementById('lb-slideshow-icon');
    const btnEl = document.getElementById('lb-btn-slideshow');
    if (lbSlideshowTimer || forceStop) {
        clearInterval(lbSlideshowTimer);
        lbSlideshowTimer = null;
        if (iconEl) iconEl.innerHTML = _LB_PLAY_SVG;
        if (btnEl) btnEl.classList.remove('bg-white/25');
        return;
    }
    if (iconEl) iconEl.innerHTML = _LB_PAUSE_SVG;
    if (btnEl) btnEl.classList.add('bg-white/25');
    lbSlideshowTimer = setInterval(() => {
        if (currentLightboxIndex < currentGalleryItems.length - 1) {
            navigateLightbox(1);
        } else {
            openLightbox(0);
        }
    }, 3000);
}

function toggleLightboxFullscreen() {
    const modal = document.getElementById('lightbox-modal');
    if (!modal) return;
    if (!document.fullscreenElement) {
        modal.requestFullscreen?.().catch(() => {});
    } else {
        document.exitFullscreen?.().catch(() => {});
    }
}

function _preloadLightboxNeighbors(idx) {
    [idx + 1, idx - 1].forEach(nIdx => {
        if (nIdx < 0 || nIdx >= currentGalleryItems.length) return;
        const neighbor = currentGalleryItems[nIdx];
        if (!neighbor || isVideoFile(neighbor.dest_path)) return;
        const pre = new Image();
        pre.src = `/media?path=${encodeURIComponent(neighbor.dest_path)}`;
    });
}

function handleLightboxFilmstripWheel(e) {
    const strip = document.getElementById('lb-filmstrip');
    if (!strip) return;
    const rawDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!rawDelta) return;
    e.preventDefault();
    e.stopPropagation();
    const unit = e.deltaMode === 1 ? 36 : (e.deltaMode === 2 ? strip.clientWidth : 1);
    const delta = rawDelta * unit;
    if (strip.scrollWidth > strip.clientWidth + 1) {
        strip.scrollLeft += delta;
    } else {
        navigateLightbox(delta > 0 ? 1 : -1);
    }
}

let _lbWheelNavLockUntil = 0;
let _lbWheelNavAccum = 0;
let _lbWheelNavDir = 0;

function handleLightboxWheel(e) {
    const lbModal = document.getElementById('lightbox-modal');
    if (!lbModal || lbModal.classList.contains('hidden')) return;
    if (e.target && e.target.closest('#lb-info-drawer, #lb-filmstrip, #lb-analyze-modal, #lb-faces-edit-modal, #lb-albums-edit-modal, #lb-location-edit-modal, #lb-delete-confirm')) {
        return;
    }

    const imgEl = document.getElementById('lb-img');
    const vidEl = document.getElementById('lb-video');
    if (vidEl && !vidEl.classList.contains('hidden') && (e.target === vidEl || vidEl.contains(e.target))) {
        return;
    }

    const rawDelta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (!rawDelta) return;

    if (imgEl && !imgEl.classList.contains('hidden')) {
        const rect = imgEl.getBoundingClientRect();
        const onImg = e.target === imgEl || (
            rect.width > 0 && rect.height > 0 &&
            e.clientX >= rect.left && e.clientX <= rect.right &&
            e.clientY >= rect.top && e.clientY <= rect.bottom
        );
        if (onImg) {
            e.preventDefault();
            adjustLightboxZoom(rawDelta < 0 ? 0.25 : -0.25);
            return;
        }
    }

    e.preventDefault();
    const unit = e.deltaMode === 1 ? 36 : (e.deltaMode === 2 ? window.innerHeight : 1);
    const delta = rawDelta * unit;
    const now = performance.now();
    if (now < _lbWheelNavLockUntil) return;

    const dir = delta > 0 ? 1 : -1;
    if (dir !== _lbWheelNavDir) {
        _lbWheelNavAccum = 0;
        _lbWheelNavDir = dir;
    }
    _lbWheelNavAccum += Math.abs(delta);
    if (_lbWheelNavAccum < 40) return;

    _lbWheelNavAccum = 0;
    _lbWheelNavLockUntil = now + 160;
    navigateLightbox(dir);
}

document.addEventListener('DOMContentLoaded', () => {
    const lbModal = document.getElementById('lightbox-modal');
    const imgEl = document.getElementById('lb-img');
    if (lbModal) {
        lbModal.addEventListener('wheel', handleLightboxWheel, { passive: false });
    }
    const filmstrip = document.getElementById('lb-filmstrip');
    if (filmstrip) {
        filmstrip.addEventListener('wheel', handleLightboxFilmstripWheel, { passive: false });
    }
    if (imgEl) {
        imgEl.addEventListener('mousedown', (e) => {
            if (lbZoomScale <= 1) return;
            e.preventDefault();
            lbIsDragging = true;
            lbDragStartX = e.clientX - lbPanX;
            lbDragStartY = e.clientY - lbPanY;
            _applyLightboxZoomTransform();
        });
        window.addEventListener('mousemove', (e) => {
            if (!lbIsDragging) return;
            lbPanX = e.clientX - lbDragStartX;
            lbPanY = e.clientY - lbDragStartY;
            _applyLightboxZoomTransform();
        });
        window.addEventListener('mouseup', () => {
            if (!lbIsDragging) return;
            lbIsDragging = false;
            _applyLightboxZoomTransform();
        });
    }
});

async function openLightbox(idx) {
    if (idx < 0 || idx >= currentGalleryItems.length) return;
    currentLightboxIndex = idx;
    const item = currentGalleryItems[idx];
    const url = `/media?path=${encodeURIComponent(item.dest_path)}`;
    const isVid = isVideoFile(item.dest_path);

    resetLightboxZoom();

    const imgEl = document.getElementById('lb-img');
    const vidEl = document.getElementById('lb-video');
    if (isVid) {
        imgEl.classList.add('hidden');
        vidEl.classList.remove('hidden');
        vidEl.src = url;
    } else {
        vidEl.pause();
        vidEl.classList.add('hidden');
        imgEl.classList.remove('hidden');
        imgEl.src = url;
    }

    const animBadge = document.getElementById('lb-animated-badge');
    if (animBadge) {
        const isAnim = item.is_animated === 1 || /\.(gif|apng)$/i.test(item.dest_path || '');
        animBadge.classList.toggle('hidden', !isAnim);
    }

    const counterEl = document.getElementById('lb-counter');
    if (counterEl) {
        let displayPos = idx + 1;
        let displayTotal = currentGalleryItems.length;
        if (!lightboxIsCustomItem) {
            if (currentTab === 'albums' && openedAlbumName) {
                displayTotal = Math.max(singleAlbumTotalItems, currentGalleryItems.length);
            } else if (currentTab === 'gallery' || currentTab === 'favorites' || currentTab === 'recent') {
                displayPos = currentSkipOffset + idx + 1;
                displayTotal = Math.max(galleryTotalItems, currentSkipOffset + currentGalleryItems.length);
            }
        }
        counterEl.textContent = `${displayPos} / ${displayTotal}`;
    }

    updateLightboxFavButton(item.is_favorite);
    updateLightboxEditButton(isVid);
    const prevBtn = document.getElementById('lb-prev-btn');
    const nextBtn = document.getElementById('lb-next-btn');
    if (prevBtn) prevBtn.classList.toggle('opacity-30', idx <= 0);
    if (nextBtn) nextBtn.classList.toggle('opacity-30', idx >= currentGalleryItems.length - 1);
    if (!lightboxIsCustomItem) currentLightboxDupGroup = null;
    renderLightboxFilmstrip(idx);
    document.getElementById('lightbox-modal').classList.remove('hidden');
    _preloadLightboxNeighbors(idx);
    _syncLightboxDuplicatesUI(item, idx);

    if (!lightboxIsCustomItem && idx >= currentGalleryItems.length - 5) {
        if (currentTab === 'albums' && openedAlbumName) loadSingleAlbumItems(true);
        else if (currentTab === 'gallery' || currentTab === 'favorites' || currentTab === 'recent') loadGalleryItems(true);
    }

    if (localStorage.getItem('phototo_lb_info_open') === '1') {
        document.getElementById('lb-info-drawer')?.classList.remove('hidden');
    }
    syncLightboxInfoButtonState();
    if (!document.getElementById('lb-info-drawer').classList.contains('hidden')) {
        await loadLightboxMetadataInfo();
    }
}

function openLightboxForCustomItem(encSrc, encDest, ts = 0, isFav = 0) {
    lightboxIsCustomItem = true;
    currentLightboxDupGroup = null;
    currentGalleryItems = [{
        source_path: decodeURIComponent(encSrc),
        dest_path: decodeURIComponent(encDest),
        timestamp: ts,
        is_favorite: isFav,
        detected_people: ''
    }];
    openLightbox(0);
}

function openLightboxForComparisonGroup(items, targetIdx = 0, meta = {}) {
    const cleanItems = (items || []).filter(Boolean).map(it => ({ ...it }));
    if (!cleanItems.length) return;
    lightboxIsCustomItem = true;
    currentLightboxDupGroup = { items: cleanItems, ...meta };
    currentGalleryItems = cleanItems;
    const safeIdx = Math.max(0, Math.min(targetIdx, cleanItems.length - 1));
    openLightbox(safeIdx);
}

function _renderLightboxDuplicatesBar(items, activeSourcePath, isGroupScoped) {
    const bar = document.getElementById('lb-duplicates-bar');
    const cmpBtn = document.getElementById('lb-btn-compare');
    const strip = document.getElementById('lb-filmstrip');
    const valid = Array.isArray(items) && items.length >= 2;
    if (cmpBtn) cmpBtn.classList.toggle('hidden', !valid);
    if (!bar) return;
    if (!valid) {
        bar.classList.add('hidden');
        bar.innerHTML = '';
        return;
    }
    const labelTxt = currentLightboxDupGroup?.kind === 'similar'
        ? `Similaires (${items.length})`
        : `Doublons (${items.length})`;
    const cardsHtml = items.map((it, i) => {
        const isActive = it.source_path === activeSourcePath;
        const ringCls = isActive ? 'ring-2 ring-white bg-white/20 opacity-100' : 'bg-white/5 hover:bg-white/15 opacity-75 hover:opacity-100';
        const fname = escapeHtml((it.dest_path || it.source_path || '').split(/[\\/]/).pop() || `Copie ${i + 1}`);
        const dim = (it.width && it.height) ? `${it.width}×${it.height}` : '';
        const mb = it.file_size ? `${(it.file_size / (1024 * 1024)).toFixed(1).replace('.', ',')} Mo` : '';
        const tsVal = it.timestamp || it.modified_at || 0;
        const timePart = typeof formatTime === 'function' ? formatTime(tsVal) : '';
        const fullDateTitle = typeof formatDateTime === 'function' ? formatDateTime(tsVal) : '';
        const metaTxt = [dim, mb, timePart].filter(Boolean).join(' · ') || fname;
        const clickExpr = isGroupScoped ? `openLightbox(${i})` : `switchLightboxToDetectedDuplicate(${i})`;
        return `
            <button type="button" onclick="event.stopPropagation(); ${clickExpr}"
                    title="${fname}${fullDateTitle ? ' — ' + fullDateTitle : ''}${metaTxt ? ' (' + metaTxt + ')' : ''}"
                    class="shrink-0 flex items-center gap-1.5 rounded-xl px-2 py-1 transition cursor-pointer ${ringCls}">
                <img src="/thumb?path=${encodeURIComponent(it.dest_path)}" loading="lazy" class="w-7 h-7 rounded-lg object-cover shrink-0"/>
                <div class="text-left leading-tight max-w-[155px]">
                    <div class="text-[10px] font-extrabold truncate">${fname}</div>
                    <div class="text-[9px] text-white/70 font-semibold truncate tabular-nums">${metaTxt}</div>
                </div>
            </button>`;
    }).join('');
    bar.innerHTML = `
        <span class="text-[10px] font-extrabold uppercase tracking-wider text-white/70 shrink-0 pl-0.5">${labelTxt}</span>
        ${cardsHtml}
        <button type="button" onclick="event.stopPropagation(); openCompareModalFromLightbox()"
                class="shrink-0 px-2.5 py-1 rounded-full bg-white/15 hover:bg-white/25 text-[10px] font-extrabold flex items-center gap-1 transition cursor-pointer">
            <svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
            </svg>
            Comparer
        </button>`;
    bar.classList.remove('hidden');
    if (isGroupScoped && strip) {
        strip.classList.add('hidden');
    }
    const lbImg = document.getElementById('lb-img');
    const lbVid = document.getElementById('lb-video');
    requestAnimationFrame(() => {
        const multiRow = !bar.classList.contains('hidden') && bar.offsetHeight > 60;
        [lbImg, lbVid].forEach(el => {
            if (!el) return;
            el.classList.toggle('max-h-[calc(100vh-145px)]', !multiRow);
            el.classList.toggle('max-h-[calc(100vh-210px)]', multiRow);
        });
    });
}

function switchLightboxToDetectedDuplicate(idx) {
    const items = window._lbDetectedDupItems;
    if (!Array.isArray(items) || items.length < 2) return;
    openLightboxForComparisonGroup(items, idx, { kind: 'dups', title: 'Doublons du média' });
}

async function _syncLightboxDuplicatesUI(item, idx) {
    if (currentLightboxDupGroup && Array.isArray(currentLightboxDupGroup.items) && currentLightboxDupGroup.items.length >= 2) {
        window._lbDetectedDupItems = currentLightboxDupGroup.items;
        _renderLightboxDuplicatesBar(currentLightboxDupGroup.items, item.source_path, true);
        return;
    }
    window._lbDetectedDupItems = null;
    _renderLightboxDuplicatesBar([], item.source_path, false);
    if (!item || !item.source_path || item._isTrashContext) return;
    const seq = ++_lbDupLookupSeq;
    try {
        const res = await fetch(`/api/media/duplicates?source_path=${encodeURIComponent(item.source_path)}`);
        if (!res.ok || seq !== _lbDupLookupSeq) return;
        const d = await res.json();
        const lbModal = document.getElementById('lightbox-modal');
        if (!lbModal || lbModal.classList.contains('hidden')) return;
        const active = currentGalleryItems[currentLightboxIndex];
        if (!active || active.source_path !== item.source_path) return;
        const items = Array.isArray(d.items) ? d.items : [];
        if (items.length >= 2) {
            window._lbDetectedDupItems = items;
            _renderLightboxDuplicatesBar(items, item.source_path, false);
        }
    } catch (_) {}
}

function closeLightbox() {
    cancelLightboxDelete();
    closeLightboxAnalyzeModal();
    closeLightboxLocationEditor();
    toggleLightboxSlideshow(true);
    resetLightboxZoom();
    currentLightboxDupGroup = null;
    window._lbDetectedDupItems = null;
    _renderLightboxDuplicatesBar([], '', false);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    const vidEl = document.getElementById('lb-video');
    if (vidEl) vidEl.pause();
    document.getElementById('lightbox-modal').classList.add('hidden');
}

function renderLightboxFilmstrip(activeIdx) {
    const strip = document.getElementById('lb-filmstrip');
    if (!strip) return;
    if (!currentGalleryItems || currentGalleryItems.length <= 1) {
        strip.classList.add('hidden');
        strip.innerHTML = '';
        return;
    }
    strip.classList.remove('hidden');
    const start = Math.max(0, activeIdx - 60);
    const end = Math.min(currentGalleryItems.length - 1, activeIdx + 60);
    let html = '';
    for (let i = start; i <= end; i++) {
        const it = currentGalleryItems[i];
        const isActive = i === activeIdx;
        const ringCls = isActive ? 'ring-2 ring-white scale-105 opacity-100' : 'opacity-55 hover:opacity-100';
        const ringStyle = isActive ? 'box-shadow:0 0 0 2px var(--sel-color);' : '';
        html += `
            <button type="button" ${isActive ? 'data-lb-active="1"' : ''} onclick="event.stopPropagation(); openLightbox(${i})"
                    style="${ringStyle}"
                    class="shrink-0 w-8 h-8 rounded-md overflow-hidden transition cursor-pointer ${ringCls}">
                <img src="/thumb?path=${encodeURIComponent(it.dest_path)}" loading="lazy" class="w-full h-full object-cover"/>
            </button>`;
    }
    strip.innerHTML = html;
    const activeBtn = strip.querySelector('[data-lb-active="1"]');
    if (activeBtn) {
        strip.scrollLeft = Math.max(0, activeBtn.offsetLeft - (strip.clientWidth - activeBtn.offsetWidth) / 2);
    }
}

function navigateLightbox(delta) {
    const nextIdx = currentLightboxIndex + delta;
    if (nextIdx >= 0 && nextIdx < currentGalleryItems.length) openLightbox(nextIdx);
}

window.addEventListener('keydown', e => {
    const studioModal = document.getElementById('studio-modal');
    if (studioModal && !studioModal.classList.contains('hidden')) {
        const isTyping = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target?.tagName);
        if (e.key === 'Escape' && typeof closeStudioModal === 'function') {
            closeStudioModal();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && !isTyping && e.key.toLowerCase() === 'z') {
            e.preventDefault();
            if (e.shiftKey && typeof studioRedo === 'function') studioRedo();
            else if (!e.shiftKey && typeof studioUndo === 'function') studioUndo();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && !isTyping && e.key.toLowerCase() === 'y') {
            e.preventDefault();
            if (typeof studioRedo === 'function') studioRedo();
            return;
        }
        if (e.key === ' ' && typeof studioIsVideo !== 'undefined' && studioIsVideo && !isTyping) {
            e.preventDefault();
            if (typeof toggleStudioVideoPlay === 'function') toggleStudioVideoPlay();
            return;
        }
        if (!isTyping) {
            const kLow = e.key.toLowerCase();
            if (kLow === 'g' && typeof cycleStudioGridOverlay === 'function') {
                e.preventDefault();
                cycleStudioGridOverlay();
            } else if (kLow === 'm' && typeof toggleStudioSplitCompare === 'function') {
                e.preventDefault();
                toggleStudioSplitCompare();
            } else if (kLow === 'i' && typeof studioIsVideo !== 'undefined' && studioIsVideo && typeof setStudioTrimInAtPlayhead === 'function') {
                e.preventDefault();
                setStudioTrimInAtPlayhead();
            } else if (kLow === 'o' && typeof studioIsVideo !== 'undefined' && studioIsVideo && typeof setStudioTrimOutAtPlayhead === 'function') {
                e.preventDefault();
                setStudioTrimOutAtPlayhead();
            } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && typeof studioIsVideo !== 'undefined' && studioIsVideo && typeof stepStudioVideo === 'function') {
                e.preventDefault();
                const dt = e.shiftKey ? 0.1 : 1.0;
                stepStudioVideo(e.key === 'ArrowLeft' ? -dt : dt);
            } else if ((e.key === '[' || e.key === ']') && typeof studioMouseTool !== 'undefined' && studioMouseTool === 'ERASER') {
                const sl = document.getElementById('st-eraser-size');
                if (sl) {
                    sl.value = String(Math.max(8, Math.min(72, Number(sl.value || 24) + (e.key === ']' ? 4 : -4))));
                    if (typeof syncStudioEraserCursorSize === 'function') syncStudioEraserCursorSize();
                }
            }
        }
        return;
    }
    const cmpModal = document.getElementById('compare-modal');
    if (cmpModal && !cmpModal.classList.contains('hidden')) {
        if (e.key === 'Escape' && typeof closeCompareModal === 'function') {
            closeCompareModal();
        }
        return;
    }
    const delConfirm = document.getElementById('lb-delete-confirm');
    if (delConfirm && !delConfirm.classList.contains('hidden')) {
        if (e.key === 'Escape') {
            cancelLightboxDelete();
        }
        return;
    }
    const lbOpen = !document.getElementById('lightbox-modal').classList.contains('hidden');
    if (!lbOpen) {
        if (e.key === 'Escape') {
            const analyzeModal = document.getElementById('lb-analyze-modal');
            if (analyzeModal && !analyzeModal.classList.contains('hidden')) {
                closeLightboxAnalyzeModal();
                return;
            }
            const albumsEditModal = document.getElementById('lb-albums-edit-modal');
            if (albumsEditModal && !albumsEditModal.classList.contains('hidden')) {
                closeLightboxAlbumsEditor();
                return;
            }
            const toolsAiModal = document.getElementById('tools-ai-modal');
            if (toolsAiModal && !toolsAiModal.classList.contains('hidden') && typeof closeToolsAiModal === 'function') {
                closeToolsAiModal();
                return;
            }
        }
        return;
    }
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.key === 'Escape') {
        const locEditModal = document.getElementById('lb-location-edit-modal');
        if (locEditModal && !locEditModal.classList.contains('hidden')) {
            closeLightboxLocationEditor();
            return;
        }
        const albumsEditModal = document.getElementById('lb-albums-edit-modal');
        if (albumsEditModal && !albumsEditModal.classList.contains('hidden')) {
            closeLightboxAlbumsEditor();
            return;
        }
        const facesEditModal = document.getElementById('lb-faces-edit-modal');
        if (facesEditModal && !facesEditModal.classList.contains('hidden')) {
            closeLightboxFacesEditor();
            return;
        }
        const analyzeModal = document.getElementById('lb-analyze-modal');
        if (analyzeModal && !analyzeModal.classList.contains('hidden')) {
            closeLightboxAnalyzeModal();
            return;
        }
        const delConfirm = document.getElementById('lb-delete-confirm');
        if (delConfirm && !delConfirm.classList.contains('hidden')) {
            cancelLightboxDelete();
            return;
        }
        closeLightbox();
    }
    else if (e.key === 'ArrowLeft') navigateLightbox(-1);
    else if (e.key === 'ArrowRight') navigateLightbox(1);
    else if (e.key === 'f' || e.key === 'F') lightboxToggleFavorite();
    else if (e.key === 'i' || e.key === 'I') toggleLightboxInfoDrawer();
    else if (e.key === 'Delete') lightboxDeleteMedia();
    else if (e.key === ' ') { e.preventDefault(); toggleLightboxSlideshow(); }
    else if (e.key === '+' || e.key === '=') adjustLightboxZoom(0.25);
    else if (e.key === '-') adjustLightboxZoom(-0.25);
    else if (e.key === '0') resetLightboxZoom();
});

function updateLightboxFavButton(isFav) {
    const icon = document.getElementById('lb-fav-icon');
    const btn = document.getElementById('lb-btn-fav');
    if (!icon || !btn) return;
    if (isFav) {
        const col = (typeof currentFavMatchAccent !== 'undefined' && currentFavMatchAccent) ? 'var(--sel-color)' : '#fb7185';
        icon.setAttribute('fill', col);
        icon.setAttribute('stroke', col);
    } else {
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
    }
}

async function lightboxToggleFavorite() {
    const item = currentGalleryItems[currentLightboxIndex];
    if (!item) return;
    const res = await fetch('/api/media/toggle_favorite', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({source_path: item.source_path})
    });
    if (res.ok) {
        const d = await res.json();
        item.is_favorite = d.is_favorite;
        updateLightboxFavButton(d.is_favorite);
        updateSingleTileFavoriteDOM(currentLightboxIndex, d.is_favorite);
        loadStats();
    }
}

async function openAlbumPickerModal(sourcePaths, defaultAlbum = '', onSuccess = null) {
    _albumPickerState = { sourcePaths, onSuccess };
    const inputEl = document.getElementById('album-picker-input');
    const errEl = document.getElementById('album-picker-error');
    const listEl = document.getElementById('album-picker-list');

    inputEl.value = defaultAlbum || '';
    errEl.textContent = '';
    errEl.classList.add('hidden');
    listEl.innerHTML = '<div class="text-xs opacity-60 py-2">Chargement des albums...</div>';

    document.getElementById('album-picker-modal').classList.remove('hidden');

    try {
        const res = await fetch('/api/albums/list?flat=true');
        const data = await res.json();
        const albums = data.all_albums || data.albums || [];
        listEl.innerHTML = '';
        if (albums.length === 0) {
            listEl.innerHTML = '<div class="text-xs opacity-50 py-2">Aucun album existant. Saisissez un nom ci-dessus pour le créer.</div>';
        } else {
            albums.forEach(alb => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'w-full flex items-center justify-between px-3 py-2 rounded-xl bg-black/15 hover:bg-white/10 transition text-left text-xs';
                const left = document.createElement('span');
                left.className = 'font-medium truncate';
                left.textContent = `📁 ${alb.full_path}`;
                const right = document.createElement('span');
                right.className = 'opacity-60 shrink-0 ml-2';
                right.textContent = `${alb.count || 0}`;
                btn.appendChild(left);
                btn.appendChild(right);
                btn.onclick = () => selectAlbumFromPicker(alb.full_path);
                listEl.appendChild(btn);
            });
        }
    } catch (e) {
        listEl.innerHTML = '<div class="text-xs text-rose-400 py-2">Impossible de charger la liste des albums.</div>';
    }
    setTimeout(() => inputEl.focus(), 50);
}

function closeAlbumPickerModal() {
    document.getElementById('album-picker-modal').classList.add('hidden');
}

function selectAlbumFromPicker(albumPath) {
    document.getElementById('album-picker-input').value = albumPath;
    submitAlbumPickerModal();
}

async function submitAlbumPickerModal(e) {
    if (e) e.preventDefault();
    const inputEl = document.getElementById('album-picker-input');
    const errEl = document.getElementById('album-picker-error');
    const albumName = inputEl.value.trim();

    if (!albumName) {
        errEl.textContent = "Veuillez saisir ou sélectionner un album.";
        errEl.classList.remove('hidden');
        return;
    }

    const res = await fetch('/api/gallery/batch_action', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            source_paths: _albumPickerState.sourcePaths,
            action: 'ALBUM_ADD',
            album_name: albumName
        })
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        errEl.textContent = err.detail || "Erreur lors de l'ajout à l'album.";
        errEl.classList.remove('hidden');
        return;
    }

    closeAlbumPickerModal();
    if (typeof _albumPickerState.onSuccess === 'function') {
        await _albumPickerState.onSuccess(albumName);
    }
}

async function lightboxAddToAlbum() {
    await openLightboxAlbumsEditor();
}

function _recordClientMediaActivity(actionType, title, detail, paths) {
    try {
        fetch('/api/activities/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            keepalive: true,
            body: JSON.stringify({
                action_type: actionType,
                title: title,
                detail: detail,
                files: Array.isArray(paths) ? paths.filter(Boolean) : []
            })
        }).catch(() => {});
    } catch (_) {}
}

function _triggerDownloadHref(href, fileName) {
    const a = document.createElement('a');
    a.href = href;
    a.download = fileName || 'media';
    document.body.appendChild(a);
    a.click();
    a.remove();
}

async function _shareMediaItems(items) {
    if (!items || !items.length) return;
    if (items.length === 1) {
        const item = items[0];
        const rawPath = item.dest_path || item.source_path || '';
        const fullUrl = `${window.location.origin}/media?path=${encodeURIComponent(rawPath)}`;
        const fileName = rawPath.split(/[\\/]/).pop() || 'media';
        if (navigator.share) {
            try {
                await navigator.share({ title: fileName, url: fullUrl });
                _recordClientMediaActivity('MEDIA_SHARE', 'Fichier partagé', `${fileName} partagé`, [rawPath]);
                return;
            } catch (e) {}
        }
        try {
            const norm = rawPath.replace(/\\/g, '/');
            await navigator.clipboard.writeText(norm);
            _recordClientMediaActivity('MEDIA_SHARE', 'Fichier partagé', `${fileName} (chemin copié)`, [rawPath]);
            alert(`Chemin copié dans le presse-papiers :\n${norm}`);
        } catch (e) {}
        return;
    }

    const displayPaths = items.map(it => (it.dest_path || it.source_path || '').replace(/\\/g, '/')).filter(Boolean);
    if (!displayPaths.length) return;
    if (navigator.share) {
        try {
            await navigator.share({
                title: `${displayPaths.length} médias Phototo`,
                text: displayPaths.join('\n')
            });
            _recordClientMediaActivity('MEDIA_SHARE', 'Fichiers partagés', `${displayPaths.length} fichier(s) partagé(s)`, displayPaths);
            return;
        } catch (e) {}
    }
    try {
        await navigator.clipboard.writeText(displayPaths.join('\n'));
        _recordClientMediaActivity('MEDIA_SHARE', 'Fichiers partagés', `${displayPaths.length} chemin(s) copié(s)`, displayPaths);
        alert(`${displayPaths.length} chemins copiés dans le presse-papiers.`);
    } catch (e) {}
}

async function lightboxShareMedia() {
    const item = currentGalleryItems[currentLightboxIndex];
    if (!item) return;
    await _shareMediaItems([item]);
}

function lightboxDownloadMedia() {
    const item = currentGalleryItems[currentLightboxIndex];
    if (!item) return;
    const fName = item.dest_path.split(/[\\/]/).pop() || 'media';
    _triggerDownloadHref(`/media?path=${encodeURIComponent(item.dest_path)}`, fName);
    _recordClientMediaActivity('MEDIA_DOWNLOAD', 'Fichier téléchargé', `${fName} téléchargé`, [item.dest_path]);
}

let _deleteConfirmMode = null;

function _syncLightboxDeleteModalLabels(isPermanent = false) {
    const titleEl = document.getElementById('lb-delete-title');
    const btnEl = document.getElementById('lb-delete-confirm-btn');
    if (titleEl) titleEl.textContent = isPermanent ? 'Supprimer définitivement ?' : 'Mettre à la corbeille ?';
    if (btnEl) btnEl.textContent = isPermanent ? 'Supprimer définitivement' : 'Mettre à la corbeille';
}

function openBatchTrashConfirm() {
    const count = selectedGalleryPaths.size;
    if (!count) return;
    _deleteConfirmMode = 'batch';
    _syncLightboxDeleteModalLabels(false);
    const modal = document.getElementById('lb-delete-confirm');
    const nameEl = document.getElementById('lb-delete-filename');
    if (nameEl) {
        nameEl.textContent = `${count} média${count > 1 ? 's' : ''} sélectionné${count > 1 ? 's' : ''}`;
    }
    if (modal) modal.classList.remove('hidden');
}

function lightboxDeleteMedia() {
    const item = currentGalleryItems[currentLightboxIndex];
    if (!item) return;
    const isTrashPerm = Boolean(item._isTrashContext || currentTab === 'trash');
    _deleteConfirmMode = isTrashPerm ? 'lightbox_trash_perm' : 'lightbox';
    _syncLightboxDeleteModalLabels(isTrashPerm);
    const modal = document.getElementById('lb-delete-confirm');
    const nameEl = document.getElementById('lb-delete-filename');
    if (nameEl) {
        const rawPath = item.dest_path || item.source_path || '';
        nameEl.textContent = rawPath.split(/[\\/]/).pop() || '';
    }
    if (modal) modal.classList.remove('hidden');
}

function cancelLightboxDelete() {
    _deleteConfirmMode = null;
    const modal = document.getElementById('lb-delete-confirm');
    if (modal) modal.classList.add('hidden');
}

async function confirmLightboxDelete() {
    const mode = _deleteConfirmMode;
    const item = currentGalleryItems[currentLightboxIndex];
    cancelLightboxDelete();
    if (mode === 'batch') {
        await runGalleryBatch('TRASH', true);
        return;
    }
    if (!item) return;
    const action = mode === 'lightbox_trash_perm' ? 'DELETE_PERMANENTLY' : 'MOVE_TO_TRASH';
    await fetch('/api/trash/action', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({source_paths: [item.source_path], action})
    });
    closeLightbox(); refreshActiveMediaView(); loadStats();
}

function lightboxOpenStudio() {
    const item = currentGalleryItems[currentLightboxIndex];
    if (item) openStudioModal(encodeURIComponent(item.source_path), encodeURIComponent(item.dest_path));
}

function lightboxOpenFaceTagger() {
    const item = currentGalleryItems[currentLightboxIndex];
    if (item) openManualFaceModal(encodeURIComponent(item.dest_path));
}

function lightboxOpenMetadataEditor() {
    const item = currentGalleryItems[currentLightboxIndex];
    if (item) openMetadataModalSingle(encodeURIComponent(item.source_path));
}

function syncLightboxInfoButtonState() {
    const dr = document.getElementById('lb-info-drawer');
    const btn = document.getElementById('lb-btn-info');
    if (!dr || !btn) return;
    const isOpen = !dr.classList.contains('hidden');
    btn.setAttribute('aria-pressed', isOpen ? 'true' : 'false');
    btn.title = isOpen ? 'Masquer les informations (I)' : 'Afficher les informations (I)';
    btn.classList.toggle('bg-white', isOpen);
    btn.classList.toggle('text-black', isOpen);
    btn.classList.toggle('shadow-sm', isOpen);
    btn.classList.toggle('hover:bg-white/20', !isOpen);
    btn.classList.toggle('hover:text-amber-300', !isOpen);
}

async function toggleLightboxInfoDrawer() {
    const dr = document.getElementById('lb-info-drawer');
    dr.classList.toggle('hidden');
    const isOpen = !dr.classList.contains('hidden');
    localStorage.setItem('phototo_lb_info_open', isOpen ? '1' : '0');
    syncLightboxInfoButtonState();
    if (isOpen) {
        await loadLightboxMetadataInfo();
    }
}

function toggleLightboxExifDetails() {
    const extra = document.getElementById('lb-info-exif-extra');
    const btn = document.getElementById('lb-info-more-btn');
    if (!extra || !btn) return;
    extra.classList.toggle('hidden');
    btn.textContent = extra.classList.contains('hidden') ? '+ plus de détails' : '− moins de détails';
}

function copyLightboxFilePath() {
    const pathPill = document.getElementById('lb-info-path-pill');
    const fullPath = pathPill?.title || '';
    if (!fullPath) return;
    navigator.clipboard?.writeText(fullPath).then(() => {
        pathPill.textContent = '✓ Chemin copié';
        setTimeout(() => { pathPill.textContent = fullPath; }, 1400);
    }).catch(() => {});
}

async function revealLightboxMediaInFolder() {
    const item = currentGalleryItems[currentLightboxIndex];
    if (!item) return;
    const res = await fetch('/api/media/reveal', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ source_path: item.source_path })
    });
    if (!res.ok) {
        alert('Impossible d’ouvrir le dossier du média.');
    }
}

function toggleLightboxTitleEdit() {
    const editor = document.getElementById('lb-info-title-editor');
    const inp = document.getElementById('lb-info-title-input');
    const lbl = document.getElementById('lb-info-filename');
    if (!editor || !inp || !lbl) return;
    if (!editor.classList.contains('hidden')) {
        cancelLightboxTitleEdit();
        return;
    }
    inp.value = lbl.textContent || '';
    editor.classList.remove('hidden');
    inp.focus();
    const dotIdx = inp.value.lastIndexOf('.');
    inp.setSelectionRange(0, dotIdx > 0 ? dotIdx : inp.value.length);
}

function cancelLightboxTitleEdit() {
    document.getElementById('lb-info-title-editor')?.classList.add('hidden');
}

async function saveLightboxTitleEdit() {
    const item = currentGalleryItems[currentLightboxIndex];
    const inp = document.getElementById('lb-info-title-input');
    const newName = (inp?.value || '').trim();
    if (!item || !newName) { cancelLightboxTitleEdit(); return; }
    const res = await fetch('/api/media/rename', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ source_path: item.source_path, new_name: newName })
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.detail || 'Impossible de renommer ce fichier.');
        return;
    }
    const data = await res.json();
    item.dest_path = data.dest_path;
    cancelLightboxTitleEdit();
    await loadLightboxMetadataInfo();
    refreshActiveMediaView();
}

let lbCalViewYear = 2026;
let lbCalViewMonth = 0;
let lbCalSelectedDate = '';

function renderLightboxCalendar() {
    const labelEl = document.getElementById('lb-cal-month-label');
    const gridEl = document.getElementById('lb-cal-days-grid');
    if (!labelEl || !gridEl) return;
    const monthDate = new Date(lbCalViewYear, lbCalViewMonth, 1);
    labelEl.textContent = monthDate.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

    const startOffset = (monthDate.getDay() + 6) % 7; // Lundi = 0
    const daysInMonth = new Date(lbCalViewYear, lbCalViewMonth + 1, 0).getDate();
    let html = '';
    for (let i = 0; i < startOffset; i++) {
        html += '<span></span>';
    }
    for (let day = 1; day <= daysInMonth; day++) {
        const iso = `${lbCalViewYear}-${String(lbCalViewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const isSel = iso === lbCalSelectedDate;
        const cls = isSel
            ? 'bg-white text-[#1E1E1E] font-bold'
            : 'text-white/80 hover:bg-white/20';
        html += `<button type="button" onclick="selectLightboxCalDay('${iso}')" class="w-6 h-6 mx-auto rounded-full flex items-center justify-center transition ${cls}">${day}</button>`;
    }
    gridEl.innerHTML = html;
}

function changeLightboxCalMonth(delta) {
    lbCalViewMonth += delta;
    if (lbCalViewMonth < 0) { lbCalViewMonth = 11; lbCalViewYear -= 1; }
    else if (lbCalViewMonth > 11) { lbCalViewMonth = 0; lbCalViewYear += 1; }
    renderLightboxCalendar();
}

function selectLightboxCalDay(isoDate) {
    lbCalSelectedDate = isoDate;
    const inp = document.getElementById('lb-info-date-input');
    if (inp) {
        const timePart = (inp.value && inp.value.includes('T')) ? inp.value.split('T')[1] : '12:00:00';
        inp.value = `${isoDate}T${timePart}`;
    }
    renderLightboxCalendar();
}

function toggleLightboxCalendarPopup() {
    const pop = document.getElementById('lb-cal-popover');
    const inp = document.getElementById('lb-info-date-input');
    if (!pop) return;
    if (!pop.classList.contains('hidden')) {
        pop.classList.add('hidden');
        return;
    }
    const raw = (inp?.value || window._lbCurrentInspectData?.datetime_local_iso || '').trim();
    const baseDate = raw ? new Date(raw) : new Date();
    const validDate = isNaN(baseDate.getTime()) ? new Date() : baseDate;
    lbCalViewYear = validDate.getFullYear();
    lbCalViewMonth = validDate.getMonth();
    lbCalSelectedDate = `${lbCalViewYear}-${String(lbCalViewMonth + 1).padStart(2, '0')}-${String(validDate.getDate()).padStart(2, '0')}`;
    renderLightboxCalendar();
    pop.classList.remove('hidden');
}

function _setLightboxUtcSelectValue(offsetStr, labelStr) {
    const tzSel = document.getElementById('lb-info-tz-select');
    if (!tzSel || !offsetStr) return;
    if (!Array.from(tzSel.options).some(o => o.value === offsetStr)) {
        const opt = document.createElement('option');
        opt.value = offsetStr;
        opt.textContent = labelStr || `UTC${offsetStr}`;
        tzSel.appendChild(opt);
    }
    tzSel.value = offsetStr;
}

function toggleLightboxDateEdit() {
    const editor = document.getElementById('lb-info-date-editor');
    const dateInp = document.getElementById('lb-info-date-only-input');
    const timeInp = document.getElementById('lb-info-time-only-input');
    if (!editor || !dateInp || !timeInp) return;
    if (!editor.classList.contains('hidden')) {
        cancelLightboxDateEdit();
        return;
    }
    const iso = (window._lbCurrentInspectData?.datetime_local_iso || '').trim();
    const [dPart, tPart] = iso.includes('T') ? iso.split('T') : ['', ''];
    dateInp.value = dPart || '';
    timeInp.value = tPart ? tPart.slice(0, 8) : '12:00:00';
    _setLightboxUtcSelectValue(
        window._lbCurrentInspectData?.file_utc_offset || '+01:00',
        window._lbCurrentInspectData?.utc_offset_label
    );
    editor.classList.remove('hidden');
    dateInp.focus();
}

function cancelLightboxDateEdit() {
    document.getElementById('lb-info-date-editor')?.classList.add('hidden');
}

async function saveLightboxDateEdit() {
    const item = currentGalleryItems[currentLightboxIndex];
    const dateInp = document.getElementById('lb-info-date-only-input');
    const timeInp = document.getElementById('lb-info-time-only-input');
    const tzSel = document.getElementById('lb-info-tz-select');
    const dVal = (dateInp?.value || '').trim();
    const tRaw = (timeInp?.value || '12:00:00').trim();
    const tVal = tRaw.length === 5 ? `${tRaw}:00` : tRaw;
    const dtVal = dVal ? `${dVal}T${tVal}` : '';
    if (!item || !dtVal) { cancelLightboxDateEdit(); return; }
    const res = await fetch('/api/metadata/batch_update', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            source_paths: [item.source_path],
            start_datetime_iso: dtVal,
            utc_offset: tzSel?.value || null
        })
    });
    if (!res.ok) {
        alert('Impossible de mettre à jour la date.');
        return;
    }
    cancelLightboxDateEdit();
    await loadLightboxMetadataInfo();
    refreshActiveMediaView();
}

function toggleLightboxNoteEdit() {
    const editor = document.getElementById('lb-info-note-editor');
    const inp = document.getElementById('lb-info-note-input');
    if (!editor || !inp) return;
    if (!editor.classList.contains('hidden')) {
        cancelLightboxNoteEdit();
        return;
    }
    inp.value = window._lbCurrentInspectData?.description || '';
    editor.classList.remove('hidden');
    inp.focus();
}

function cancelLightboxNoteEdit() {
    document.getElementById('lb-info-note-editor')?.classList.add('hidden');
}

async function saveLightboxNoteEdit() {
    const item = currentGalleryItems[currentLightboxIndex];
    const inp = document.getElementById('lb-info-note-input');
    if (!item || !inp) { cancelLightboxNoteEdit(); return; }
    const res = await fetch('/api/metadata/batch_update', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ source_paths: [item.source_path], description: inp.value.trim() })
    });
    if (!res.ok) {
        alert("Impossible d'enregistrer la note.");
        return;
    }
    cancelLightboxNoteEdit();
    await loadLightboxMetadataInfo();
}

let _lbInfoReqSeq = 0;
let _lbInfoAbortCtrl = null;
const _lbCityCache = new Map();

async function resolveLightboxPlaceCity(lat, lon, reqSeq, prefilledCity = '', prefilledLabel = '') {
    const placeEl = document.getElementById('lb-info-place-title');
    if (!placeEl) return;
    const key = `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;
    if (prefilledCity) {
        _lbCityCache.set(key, { city: prefilledCity, label: prefilledLabel || prefilledCity });
        return;
    }
    const cached = _lbCityCache.get(key);
    if (cached) {
        placeEl.textContent = cached.city || cached.label || 'Lieu inconnu';
        placeEl.title = cached.label || cached.city || '';
        return;
    }
    try {
        const res = await fetch(`/api/map/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`, {
            signal: _lbInfoAbortCtrl ? _lbInfoAbortCtrl.signal : undefined
        });
        if (reqSeq !== _lbInfoReqSeq) return;
        if (!res.ok) {
            placeEl.textContent = 'Lieu inconnu';
            return;
        }
        const geo = await res.json();
        if (reqSeq !== _lbInfoReqSeq) return;
        const city = (geo.city || '').trim();
        const label = (geo.label || city || 'Lieu inconnu').trim();
        const text = city || label || 'Lieu inconnu';
        placeEl.textContent = text;
        placeEl.title = label;
        if (city) {
            _lbCityCache.set(key, { city, label });
        }
    } catch (e) {
        if (e && e.name === 'AbortError') return;
        if (reqSeq === _lbInfoReqSeq) placeEl.textContent = 'Lieu inconnu';
    }
}

async function loadLightboxMetadataInfo() {
    const item = currentGalleryItems[currentLightboxIndex];
    if (!item) return;
    const reqSeq = ++_lbInfoReqSeq;
    if (_lbInfoAbortCtrl) _lbInfoAbortCtrl.abort();
    _lbInfoAbortCtrl = new AbortController();

    cancelLightboxTitleEdit();
    cancelLightboxDateEdit();
    cancelLightboxNoteEdit();

    const rawDest = (item.dest_path || item.source_path || '').replace(/\\/g, '/');
    document.getElementById('lb-info-filename').textContent = rawDest.split('/').pop() || 'Média';
    document.getElementById('lb-info-dims').textContent = 'Chargement...';
    document.getElementById('lb-info-size').textContent = '';
    document.getElementById('lb-info-date').textContent = '...';
    document.getElementById('lb-info-weekday').textContent = '';
    document.getElementById('lb-info-time').textContent = '';
    document.getElementById('lb-info-camera').textContent = '';
    document.getElementById('lb-info-lens').textContent = '';
    document.getElementById('lb-info-faces-card')?.classList.add('hidden');
    document.getElementById('lb-info-cats-card')?.classList.add('hidden');
    document.getElementById('lb-info-map-card')?.classList.add('hidden');
    const pathPillPre = document.getElementById('lb-info-path-pill');
    if (pathPillPre) {
        pathPillPre.textContent = rawDest;
        pathPillPre.title = rawDest;
    }

    let res;
    try {
        res = await fetch(`/api/metadata/inspect?source_path=${encodeURIComponent(item.source_path)}`, {
            signal: _lbInfoAbortCtrl.signal
        });
    } catch (e) {
        if (e && e.name === 'AbortError') return;
        return;
    }
    if (reqSeq !== _lbInfoReqSeq) return;
    if (!res.ok) {
        document.getElementById('lb-info-dims').textContent = 'Métadonnées indisponibles';
        document.getElementById('lb-info-date').textContent = 'Date inconnue';
        return;
    }
    const d = await res.json();
    if (reqSeq !== _lbInfoReqSeq || currentGalleryItems[currentLightboxIndex]?.source_path !== item.source_path) return;
    window._lbCurrentInspectData = d;

    const fname = (d.dest_path || '').split(/[\\/]/).pop() || 'Média';
    document.getElementById('lb-info-filename').textContent = fname;

    // Dimensions & Mégapixels (avec repli sur l'élément média chargé)
    let w = Number(d.width || 0);
    let h = Number(d.height || 0);
    if (!w || !h) {
        const imgEl = document.getElementById('lb-img');
        const vidEl = document.getElementById('lb-video');
        if (imgEl && !imgEl.classList.contains('hidden') && imgEl.naturalWidth && imgEl.naturalHeight) {
            w = imgEl.naturalWidth;
            h = imgEl.naturalHeight;
        } else if (vidEl && !vidEl.classList.contains('hidden') && vidEl.videoWidth && vidEl.videoHeight) {
            w = vidEl.videoWidth;
            h = vidEl.videoHeight;
        }
    }
    if (w > 0 && h > 0) {
        const rawMpx = (w * h) / 1000000;
        const mpxLabel = rawMpx >= 1 ? `${Math.round(rawMpx)} Mpx` : `${rawMpx.toFixed(1).replace('.', ',')} Mpx`;
        document.getElementById('lb-info-dims').textContent = `${mpxLabel} • ${w} × ${h}`;
    } else {
        document.getElementById('lb-info-dims').textContent = 'Dimensions inconnues';
    }

    // Jour, Heure, UTC et Date complète (UTC original du fichier, ou fuseau configuré si absent)
    const utcEl = document.getElementById('lb-info-utc');
    if (utcEl) utcEl.textContent = d.utc_offset_label || 'UTC';
    const defTimeEl = document.getElementById('lb-info-default-time');
    if (defTimeEl) {
        defTimeEl.textContent = d.default_tz_time_label || '';
        defTimeEl.classList.toggle('hidden', !d.default_tz_time_label);
    }
    if (d.file_utc_offset) _setLightboxUtcSelectValue(d.file_utc_offset, d.utc_offset_label);
    if (d.timestamp && d.timestamp > 0) {
        const dt = d.datetime_local_iso ? new Date(d.datetime_local_iso) : new Date(d.timestamp * 1000);
        const wd = dt.toLocaleDateString('fr-FR', { weekday: 'long' });
        document.getElementById('lb-info-weekday').textContent = wd.charAt(0).toUpperCase() + wd.slice(1);
        document.getElementById('lb-info-time').textContent = dt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }).replace(':', 'h');
        document.getElementById('lb-info-date').textContent = dt.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    } else {
        document.getElementById('lb-info-weekday').textContent = '';
        document.getElementById('lb-info-time').textContent = '';
        document.getElementById('lb-info-date').textContent = 'Date inconnue';
    }

    // Appareil & Paramètres optiques EXIF
    document.getElementById('lb-info-camera').textContent = d.camera_model || 'Appareil standard';
    document.getElementById('lb-info-lens').textContent = d.lens_specs || '';

    // Taille en Mo avec virgule française + détails EXIF supplémentaires
    const mb = d.file_size ? (d.file_size / (1024 * 1024)).toFixed(2).replace('.', ',') + ' Mo' : '0,00 Mo';
    document.getElementById('lb-info-size').textContent = mb;
    const extMatch = (d.dest_path || '').match(/\.([a-zA-Z0-9]+)$/);
    const fmtEl = document.getElementById('lb-info-format');
    if (fmtEl) fmtEl.textContent = extMatch ? `Format : ${extMatch[1].toUpperCase()}` : '';
    const isoEl = document.getElementById('lb-info-iso-date');
    if (isoEl) isoEl.textContent = d.datetime_local_iso ? `Horodatage : ${d.datetime_local_iso.replace('T', ' ')}` : '';

    // Carte Album : 1er album affiché + flèche si multi-albums + album principal / sous-album cliquables
    if (currentGalleryItems[currentLightboxIndex]) {
        currentGalleryItems[currentLightboxIndex].album_name = d.album_name || '';
    }
    const albumsListEl = document.getElementById('lb-info-albums-list');
    if (albumsListEl) {
        const albumsList = (Array.isArray(d.albums) && d.albums.length > 0)
            ? d.albums
            : (d.album_name
                ? d.album_name.split(',').map(s => s.trim()).filter(Boolean).map(name => ({
                    name,
                    display_name: name.split('/').pop() || name,
                    cover_path: d.dest_path || '',
                    count: d.album_count || 1
                }))
                : []);
        if (albumsList.length > 0) {
            const extraAlbums = albumsList.slice(1);
            const expandBtnHtml = extraAlbums.length > 0
                ? `<button type="button" id="lb-albums-expand-btn" onclick="toggleLightboxExtraAlbums()"
                           aria-expanded="false"
                           title="Afficher ${extraAlbums.length} autre${extraAlbums.length > 1 ? 's' : ''} album${extraAlbums.length > 1 ? 's' : ''}"
                           class="shrink-0 w-6 h-6 rounded-full bg-white/10 hover:bg-white/20 text-white/75 hover:text-white flex items-center justify-center transition cursor-pointer">
                       <svg id="lb-albums-expand-chevron" class="w-3.5 h-3.5 transition-transform duration-200" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                           <polyline points="6 9 12 15 18 9"/>
                       </svg>
                   </button>`
                : '';
            const firstHtml = _renderLightboxAlbumRowHtml(albumsList[0], expandBtnHtml);
            const extraHtml = extraAlbums.length > 0
                ? `<div id="lb-info-albums-extra" class="hidden space-y-1.5 pt-1 border-t border-white/10">
                       ${extraAlbums.map(a => _renderLightboxAlbumRowHtml(a)).join('')}
                   </div>`
                : '';
            albumsListEl.innerHTML = firstHtml + extraHtml;
        } else {
            albumsListEl.innerHTML = `
                <button type="button" onclick="openLightboxAlbumsEditor()"
                        class="w-full text-left text-[11px] font-medium text-white/60 hover:text-white transition cursor-pointer">
                    Ajouter à un album
                </button>
            `;
        }
    }

    // Carte Personnes + Carte Catégories + Bouton flottant "Analyser le média"
    const facesCard = document.getElementById('lb-info-faces-card');
    const catsCard = document.getElementById('lb-info-cats-card');
    const analyzeBtn = document.getElementById('lb-info-analyze-btn');
    const facesList = d.faces || [];
    const catsList = d.smart_categories || [];

    if (facesList.length > 0) {
        if (facesCard) facesCard.classList.remove('hidden');
        const seenPersons = new Set();
        const seenNamed = new Set();
        const uniquePeople = [];
        facesList.forEach(f => {
            const pKey = f.person_id ? `p:${f.person_id}` : `f:${f.face_id}`;
            if (seenPersons.has(pKey)) return;
            const nm = String(f.name || '').trim();
            const nmLow = nm.toLowerCase();
            if (nm && nmLow !== 'inconnu') {
                if (seenNamed.has(nmLow)) return;
                seenNamed.add(nmLow);
            }
            seenPersons.add(pKey);
            uniquePeople.push(f);
        });
        const facesHtml = uniquePeople.map(f => {
            const thumb = f.person_thumb_path || f.thumb_path || '';
            const dispName = String(f.name || 'Inconnu')
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return `
            <div onclick="if(${f.person_id || 0}) { closeLightbox(); switchTab('faces'); openTimeline(${f.person_id}); }"
                 class="flex flex-col items-center cursor-pointer group">
                <img src="/media?path=${encodeURIComponent(thumb)}"
                     class="w-11 h-11 rounded-full object-cover bg-black/20 shadow-sm group-hover:scale-105 transition"/>
                <span class="text-[9px] font-extrabold mt-1 max-w-[52px] truncate">${dispName}</span>
            </div>
        `;
        }).join('');
        document.getElementById('lb-info-faces-list').innerHTML = facesHtml;
    } else {
        if (facesCard) facesCard.classList.add('hidden');
        document.getElementById('lb-info-faces-list').innerHTML = '';
    }

    if (catsList.length > 0) {
        if (catsCard) catsCard.classList.remove('hidden');
        const catsHtml = catsList.map(c => `
            <button type="button" onclick="openLightboxSmartCategory(${c.category_id})"
                    class="px-2.5 py-0.5 rounded-full bg-white/15 hover:bg-white/25 text-[10px] font-semibold text-white/90 hover:text-white transition cursor-pointer"
                    title="Ouvrir la catégorie ${String(c.name || '').replace(/"/g, '&quot;')}">${c.name}</button>
        `).join('');
        const catsEl = document.getElementById('lb-info-cats-list');
        if (catsEl) catsEl.innerHTML = catsHtml;
    } else {
        if (catsCard) catsCard.classList.add('hidden');
        const catsEl = document.getElementById('lb-info-cats-list');
        if (catsEl) catsEl.innerHTML = '';
    }

    if (analyzeBtn) {
        analyzeBtn.classList.remove('hidden');
    }

    // Carte Lieu & Mini-Carte Leaflet (masquée si aucune coordonnée -> bouton "Ajouter un lieu")
    const mapCard = document.getElementById('lb-info-map-card');
    const mapEmpty = document.getElementById('lb-info-map-empty');
    const mapBox = document.getElementById('lb-mini-map');
    const mapsBtn = document.getElementById('lb-open-maps-btn');
    if (d.latitude && d.longitude && (d.latitude !== 0 || d.longitude !== 0)) {
        if (mapCard) mapCard.classList.remove('hidden');
        if (mapEmpty) mapEmpty.classList.add('hidden');
        const lat = Number(d.latitude);
        const lon = Number(d.longitude);
        const placeEl = document.getElementById('lb-info-place-title');
        const initialCity = (d.location_city || '').trim();
        if (placeEl) {
            placeEl.textContent = initialCity || 'Localisation...';
            placeEl.title = (d.location_label || initialCity || '');
        }
        resolveLightboxPlaceCity(lat, lon, reqSeq, initialCity, d.location_label || '');
        if (mapsBtn) {
            mapsBtn.href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`;
            mapsBtn.classList.remove('hidden');
        }
        mapBox.innerHTML = `<div id="lb-leaflet-inner" class="w-full h-full"></div>`;
        setTimeout(() => {
            const inner = document.getElementById('lb-leaflet-inner');
            if (!inner) return;
            if (lbMiniMap) {
                lbMiniMap.remove();
                lbMiniMap = null;
            }
            lbMiniMap = L.map('lb-leaflet-inner', { zoomControl: false, attributionControl: false }).setView([d.latitude, d.longitude], 12);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(lbMiniMap);
            L.marker([d.latitude, d.longitude]).addTo(lbMiniMap);
        }, 80);
    } else {
        if (mapCard) mapCard.classList.add('hidden');
        if (mapEmpty) mapEmpty.classList.remove('hidden');
        if (mapsBtn) mapsBtn.classList.add('hidden');
        if (lbMiniMap) {
            lbMiniMap.remove();
            lbMiniMap = null;
        }
        mapBox.innerHTML = '';
    }

    // Carte Note
    cancelLightboxNoteEdit();
    const hasNote = !!(d.description && d.description.trim());
    document.getElementById('lb-info-note').textContent = hasNote ? d.description : 'Ajouter une note...';
    document.getElementById('lb-info-note-edit-btn')?.classList.toggle('hidden', !hasNote);

    // Pilule du chemin complet en bas
    const cleanPath = (d.dest_path || '').replace(/\\/g, '/');
    const pathPill = document.getElementById('lb-info-path-pill');
    pathPill.textContent = cleanPath;
    pathPill.title = cleanPath;
}

let lbAnalyzeVisualCandidates = [];
let lbAnalyzeSelectedSet = new Set();
let lbAnalyzeBatchItems = null;

function _syncAnalyzeModalControlsVisibility(isMultiBatch) {
    const validateBtn = document.getElementById('lb-analyze-validate-btn');
    const redoBtn = document.getElementById('lb-analyze-redo-visual-btn');
    const customRow = document.getElementById('lb-analyze-custom-cat-row');
    if (validateBtn) validateBtn.classList.toggle('hidden', !!isMultiBatch);
    if (redoBtn) redoBtn.classList.toggle('hidden', !!isMultiBatch);
    if (customRow) customRow.classList.toggle('hidden', !!isMultiBatch);
}

function openBatchAnalyzeModal() {
    const items = getSelectedGalleryItems();
    if (!items.length) return;
    lbAnalyzeBatchItems = items;
    const isMulti = items.length > 1;
    const titleEl = document.getElementById('lb-analyze-title');
    const subEl = document.getElementById('lb-analyze-subtitle');
    if (titleEl) titleEl.textContent = isMulti ? `Analyser la sélection (${items.length})` : 'Analyser le média';
    if (subEl) {
        subEl.textContent = isMulti
            ? `Choisissez le type d'analyse à exécuter sur les ${items.length} médias sélectionnés :`
            : "Choisissez le type d'analyse à exécuter uniquement sur ce média :";
    }
    _syncAnalyzeModalControlsVisibility(isMulti);
    document.getElementById('lb-analyze-choice')?.classList.remove('hidden');
    document.getElementById('lb-analyze-loading')?.classList.add('hidden');
    document.getElementById('lb-analyze-results')?.classList.add('hidden');
    document.getElementById('lb-analyze-modal')?.classList.remove('hidden');
}

function openLightboxAnalyzeModal() {
    const modal = document.getElementById('lb-analyze-modal');
    if (!modal) return;
    lbAnalyzeBatchItems = null;
    const titleEl = document.getElementById('lb-analyze-title');
    const subEl = document.getElementById('lb-analyze-subtitle');
    if (titleEl) titleEl.textContent = 'Analyser le média';
    if (subEl) subEl.textContent = "Choisissez le type d'analyse à exécuter uniquement sur ce média :";
    _syncAnalyzeModalControlsVisibility(false);
    document.getElementById('lb-analyze-choice')?.classList.remove('hidden');
    document.getElementById('lb-analyze-loading')?.classList.add('hidden');
    document.getElementById('lb-analyze-results')?.classList.add('hidden');
    modal.classList.remove('hidden');
}

function closeLightboxAnalyzeModal() {
    lbAnalyzeBatchItems = null;
    document.getElementById('lb-analyze-modal')?.classList.add('hidden');
}

function _renderAnalyzeVisualChips() {
    const body = document.getElementById('lb-analyze-visual-body');
    if (!body) return;
    if (!lbAnalyzeVisualCandidates.length) {
        body.innerHTML = `<div class="text-[11px] text-white/55">Aucun élément visuel détecté automatiquement.</div>`;
        return;
    }
    body.innerHTML = lbAnalyzeVisualCandidates.map((c, idx) => {
        const active = lbAnalyzeSelectedSet.has(idx);
        const cls = active
            ? 'bg-white text-[#1E1E1E] border-white font-bold'
            : 'bg-white/10 text-white/80 border-white/15 hover:bg-white/20';
        const pct = c.percent ? ` <span class="opacity-60">${c.percent}%</span>` : '';
        return `<button type="button" onclick="toggleAnalyzeCatChip(${idx})"
                        class="px-2.5 py-1 rounded-full border text-[11px] transition ${cls}">${c.name}${pct}</button>`;
    }).join('');
}

function toggleAnalyzeCatChip(idx) {
    if (lbAnalyzeSelectedSet.has(idx)) lbAnalyzeSelectedSet.delete(idx);
    else lbAnalyzeSelectedSet.add(idx);
    _renderAnalyzeVisualChips();
}

function addCustomAnalyzeCategory() {
    const inp = document.getElementById('lb-analyze-custom-cat');
    const val = (inp?.value || '').trim();
    if (!val) return;
    const existingIdx = lbAnalyzeVisualCandidates.findIndex(c => c.name.toLowerCase() === val.toLowerCase());
    if (existingIdx >= 0) {
        lbAnalyzeSelectedSet.add(existingIdx);
    } else {
        lbAnalyzeVisualCandidates.unshift({ name: val, prompt: val, score: 1.0, percent: 100, already_assigned: true });
        const nextSet = new Set([0]);
        lbAnalyzeSelectedSet.forEach(i => nextSet.add(i + 1));
        lbAnalyzeSelectedSet = nextSet;
    }
    if (inp) inp.value = '';
    _renderAnalyzeVisualChips();
}

function _getAnalyzeTargetItem() {
    if (Array.isArray(lbAnalyzeBatchItems) && lbAnalyzeBatchItems.length === 1) {
        return lbAnalyzeBatchItems[0];
    }
    return currentGalleryItems[currentLightboxIndex] || null;
}

async function _runBatchMediaAnalysis(items, runFaces, runVisual, forceFaces = false) {
    document.getElementById('lb-analyze-modal')?.classList.remove('hidden');
    document.getElementById('lb-analyze-choice')?.classList.add('hidden');
    document.getElementById('lb-analyze-results')?.classList.add('hidden');
    document.getElementById('lb-analyze-loading')?.classList.remove('hidden');
    _syncAnalyzeModalControlsVisibility(true);

    const loadTxt = document.getElementById('lb-analyze-loading-text');
    let okCount = 0;
    let totalFaces = 0;
    let totalCatsApplied = 0;
    let errCount = 0;

    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (loadTxt) loadTxt.textContent = `Analyse en cours : ${i + 1} / ${items.length}...`;
        try {
            const res = await fetch('/api/media/analyze_single', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    source_path: it.source_path,
                    run_faces: runFaces,
                    run_visual: runVisual,
                    force_faces: !!forceFaces
                })
            });
            if (!res.ok) {
                errCount++;
                continue;
            }
            const d = await res.json();
            okCount++;
            if (runFaces) {
                totalFaces += (d.faces || []).length;
            }
            if (runVisual && !d.visual_error) {
                const cands = d.visual_candidates || [];
                const chosen = cands.filter((c, idx) => c.already_assigned || (c.confident !== false && idx < 3));
                if (chosen.length > 0) {
                    await fetch('/api/media/apply_categories', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ source_path: it.source_path, categories: chosen })
                    });
                    totalCatsApplied++;
                }
            }
        } catch (e) {
            errCount++;
        }
    }

    if (loadTxt) loadTxt.textContent = 'Analyse du média en cours...';
    document.getElementById('lb-analyze-loading')?.classList.add('hidden');
    document.getElementById('lb-analyze-results')?.classList.remove('hidden');

    const facesSec = document.getElementById('lb-analyze-faces-section');
    const facesBody = document.getElementById('lb-analyze-faces-body');
    if (runFaces && facesSec && facesBody) {
        facesSec.classList.remove('hidden');
        facesBody.innerHTML = `<div class="text-xs text-white/80 bg-white/5 border border-white/10 rounded-xl px-3 py-2 w-full">✓ ${okCount}/${items.length} média(s) analysé(s) — <span class="font-bold text-white">${totalFaces}</span> visage(s) détecté(s).</div>`;
    } else if (facesSec) {
        facesSec.classList.add('hidden');
    }

    const visSec = document.getElementById('lb-analyze-visual-section');
    const visBody = document.getElementById('lb-analyze-visual-body');
    if (runVisual && visSec && visBody) {
        visSec.classList.remove('hidden');
        visBody.innerHTML = `<div class="text-xs text-white/80 bg-white/5 border border-white/10 rounded-xl px-3 py-2 w-full">✓ Catégories visuelles appliquées sur <span class="font-bold text-white">${totalCatsApplied}</span> / ${items.length} média(s).${errCount ? ` <span class="text-rose-300">(${errCount} erreur(s))</span>` : ''}</div>`;
    } else if (visSec) {
        visSec.classList.add('hidden');
    }

    await loadGalleryFilters();
    refreshActiveMediaView();
    loadStats();
}

async function runSingleMediaAnalysis(runFaces, runVisual, forceFaces = false) {
    if (Array.isArray(lbAnalyzeBatchItems) && lbAnalyzeBatchItems.length > 1) {
        await _runBatchMediaAnalysis(lbAnalyzeBatchItems, runFaces, runVisual, forceFaces);
        return;
    }
    const item = _getAnalyzeTargetItem();
    if (!item) return;

    _syncAnalyzeModalControlsVisibility(false);
    const loadTxt = document.getElementById('lb-analyze-loading-text');
    if (loadTxt) loadTxt.textContent = 'Analyse du média en cours...';

    document.getElementById('lb-analyze-modal')?.classList.remove('hidden');
    document.getElementById('lb-analyze-choice')?.classList.add('hidden');
    document.getElementById('lb-analyze-results')?.classList.add('hidden');
    document.getElementById('lb-analyze-loading')?.classList.remove('hidden');

    const res = await fetch('/api/media/analyze_single', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            source_path: item.source_path,
            run_faces: runFaces,
            run_visual: runVisual,
            force_faces: !!forceFaces
        })
    });

    document.getElementById('lb-analyze-loading')?.classList.add('hidden');
    document.getElementById('lb-analyze-results')?.classList.remove('hidden');

    if (!res.ok) {
        alert("Erreur lors de l'analyse du média.");
        closeLightboxAnalyzeModal();
        return;
    }
    const d = await res.json();

    const encDest = encodeURIComponent(item.dest_path || item.source_path || '');
    const facesSec = document.getElementById('lb-analyze-faces-section');
    const facesBody = document.getElementById('lb-analyze-faces-body');
    if (runFaces && facesSec && facesBody) {
        facesSec.classList.remove('hidden');
        const fList = d.faces || [];
        if (d.faces_error) {
            facesBody.innerHTML = `<div class="text-[11px] text-red-300">Erreur détection : ${d.faces_error}</div>`;
        } else if (fList.length > 0) {
            facesBody.innerHTML = fList.map(f => `
                <div onclick="closeLightboxAnalyzeModal(); openManualFaceModal('${encDest}');" class="flex flex-col items-center cursor-pointer group">
                    <img src="/media?path=${encodeURIComponent(f.thumb_path || '')}" class="w-11 h-11 rounded-full object-cover bg-black/30 group-hover:scale-105 transition"/>
                    <span class="text-[10px] font-semibold mt-1 max-w-[60px] truncate">${f.name}</span>
                </div>
            `).join('');
        } else {
            facesBody.innerHTML = `
                <div class="w-full flex items-center justify-between gap-2 bg-white/5 border border-white/10 rounded-xl px-3 py-2">
                    <span class="text-[11px] text-white/65">Aucun visage détecté</span>
                    <button type="button" onclick="closeLightboxAnalyzeModal(); openManualFaceModal('${encDest}');"
                            class="px-2.5 py-1 rounded-full bg-white/15 hover:bg-white/25 text-[10px] font-bold transition">
                        Sélectionner manuellement
                    </button>
                </div>`;
        }
    } else if (facesSec) {
        facesSec.classList.add('hidden');
    }

    const visSec = document.getElementById('lb-analyze-visual-section');
    if (runVisual && visSec) {
        visSec.classList.remove('hidden');
        lbAnalyzeVisualCandidates = d.visual_candidates || [];
        lbAnalyzeSelectedSet = new Set();
        lbAnalyzeVisualCandidates.forEach((c, idx) => {
            if (c.already_assigned || (c.confident !== false && idx < 3)) lbAnalyzeSelectedSet.add(idx);
        });
        if (d.visual_error) {
            document.getElementById('lb-analyze-visual-body').innerHTML = `<div class="text-[11px] text-red-300">Erreur analyse visuelle : ${d.visual_error}</div>`;
        } else {
            _renderAnalyzeVisualChips();
        }
    } else if (visSec) {
        visSec.classList.add('hidden');
        lbAnalyzeVisualCandidates = [];
        lbAnalyzeSelectedSet = new Set();
    }

    const lbOpen = !document.getElementById('lightbox-modal')?.classList.contains('hidden');
    if (lbOpen) {
        await loadLightboxMetadataInfo();
    } else {
        await loadGalleryFilters();
        loadStats();
    }
}

async function confirmLightboxAnalyzeResults() {
    const item = _getAnalyzeTargetItem();
    if (!item) { closeLightboxAnalyzeModal(); return; }
    const visSec = document.getElementById('lb-analyze-visual-section');
    if (visSec && !visSec.classList.contains('hidden')) {
        const chosen = Array.from(lbAnalyzeSelectedSet)
            .map(idx => lbAnalyzeVisualCandidates[idx])
            .filter(Boolean);
        await fetch('/api/media/apply_categories', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ source_path: item.source_path, categories: chosen })
        });
    }
    closeLightboxAnalyzeModal();
    const lbOpen = !document.getElementById('lightbox-modal')?.classList.contains('hidden');
    if (lbOpen) {
        await loadLightboxMetadataInfo();
    } else {
        await loadGalleryFilters();
        refreshActiveMediaView();
        loadStats();
    }
}

function openLightboxSmartCategory(categoryId) {
    if (!categoryId) return;
    closeLightbox();
    switchTab('types');
    openSingleCategoryView(categoryId);
}

function openLightboxCategoriesEditor() {
    const modal = document.getElementById('lb-analyze-modal');
    if (!modal) return;
    lbAnalyzeBatchItems = null;
    _syncAnalyzeModalControlsVisibility(false);
    const titleEl = document.getElementById('lb-analyze-title');
    if (titleEl) titleEl.textContent = 'Analyser le média';
    const d = window._lbCurrentInspectData || {};
    const suggestions = Array.isArray(d.visual_suggestions) ? d.visual_suggestions : [];
    const assigned = Array.isArray(d.smart_categories) ? d.smart_categories : [];
    const assignedMap = new Map();
    assigned.forEach(c => {
        const key = String(c.name || '').trim().toLowerCase();
        if (key && !assignedMap.has(key)) assignedMap.set(key, c);
    });

    const candidates = [];
    const seen = new Set();
    suggestions.forEach(s => {
        const key = String(s.name || '').trim().toLowerCase();
        if (!key || seen.has(key)) return;
        seen.add(key);
        candidates.push({
            ...s,
            already_assigned: assignedMap.has(key)
        });
    });

    const extraAssigned = [];
    assigned.forEach(c => {
        const key = String(c.name || '').trim().toLowerCase();
        if (!key || seen.has(key)) return;
        seen.add(key);
        const rawScore = Number(c.score);
        const score = Number.isFinite(rawScore) ? rawScore : 1.0;
        extraAssigned.push({
            name: c.name,
            prompt: c.name,
            score,
            percent: Math.round(score * 100),
            already_assigned: true,
            confident: true
        });
    });

    lbAnalyzeVisualCandidates = [...extraAssigned, ...candidates];
    lbAnalyzeSelectedSet = new Set();
    const hasAssigned = assignedMap.size > 0;
    lbAnalyzeVisualCandidates.forEach((c, idx) => {
        if (hasAssigned) {
            if (c.already_assigned) lbAnalyzeSelectedSet.add(idx);
        } else if (c.already_assigned || (c.confident !== false && idx < 3)) {
            lbAnalyzeSelectedSet.add(idx);
        }
    });

    document.getElementById('lb-analyze-choice')?.classList.add('hidden');
    document.getElementById('lb-analyze-loading')?.classList.add('hidden');
    document.getElementById('lb-analyze-faces-section')?.classList.add('hidden');
    document.getElementById('lb-analyze-visual-section')?.classList.remove('hidden');
    document.getElementById('lb-analyze-results')?.classList.remove('hidden');
    const customInp = document.getElementById('lb-analyze-custom-cat');
    if (customInp) customInp.value = '';
    _renderAnalyzeVisualChips();
    modal.classList.remove('hidden');
}

let lbFacesEditorPersons = [];

async function openLightboxFacesEditor() {
    const modal = document.getElementById('lb-faces-edit-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    const listEl = document.getElementById('lb-faces-edit-list');
    if (listEl) {
        listEl.innerHTML = `<div class="text-xs text-white/60 py-4 text-center">Chargement des personnes...</div>`;
    }
    try {
        const res = await fetch('/api/persons');
        if (res.ok) {
            const pData = await res.json();
            lbFacesEditorPersons = pData.persons || [];
        }
    } catch (e) {
        lbFacesEditorPersons = [];
    }
    renderLightboxFacesEditor();
}

function closeLightboxFacesEditor() {
    document.getElementById('lb-faces-edit-modal')?.classList.add('hidden');
}

function renderLightboxFacesEditor() {
    const listEl = document.getElementById('lb-faces-edit-list');
    if (!listEl) return;
    const d = window._lbCurrentInspectData || {};
    const faces = Array.isArray(d.faces) ? d.faces : [];
    if (!faces.length) {
        listEl.innerHTML = `<div class="text-xs text-white/60 py-4 text-center">Aucun visage enregistré sur ce média.</div>`;
        return;
    }

    const escHtml = s => String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const namedPersons = [];
    const seenNames = new Set();
    lbFacesEditorPersons.forEach(p => {
        const pname = String(p.name || '').trim();
        if (!pname || pname.toLowerCase() === 'inconnu') return;
        const low = pname.toLowerCase();
        if (seenNames.has(low)) return;
        seenNames.add(low);
        namedPersons.push(p);
    });
    const datalistHtml = `
        <datalist id="lb-faces-persons-datalist">
            ${namedPersons.map(p => `<option value="${escHtml(p.name)}"></option>`).join('')}
        </datalist>`;

    listEl.innerHTML = datalistHtml + faces.map(f => {
        const rawName = String(f.name || '').trim();
        const isUnknown = !rawName || rawName.toLowerCase() === 'inconnu';
        const knownOptions = lbFacesEditorPersons
            .filter(p => Number(p.person_id) !== Number(f.person_id))
            .map(p => {
                const label = p.name && p.name !== 'Inconnu' ? p.name : `Inconnu (#${p.person_id})`;
                return `<option value="${p.person_id}">${escHtml(label)}</option>`;
            }).join('');

        const displayHtml = isUnknown
            ? `<button type="button" onclick="startLightboxFaceNameEdit(${f.face_id})"
                       title="Cliquer pour nommer ce visage"
                       class="max-w-full text-left text-xs font-semibold italic text-white/65 hover:text-white underline decoration-dotted underline-offset-4 truncate transition cursor-pointer">
                   Inconnu
               </button>`
            : `<div class="flex items-center gap-1.5 min-w-0">
                   <span class="text-xs font-bold text-white truncate">${escHtml(rawName)}</span>
                   <button type="button" onclick="startLightboxFaceNameEdit(${f.face_id})"
                           title="Modifier le nom"
                           class="shrink-0 w-5 h-5 rounded-full hover:bg-white/20 text-white/55 hover:text-white flex items-center justify-center transition cursor-pointer">
                       <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                           <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
                       </svg>
                   </button>
               </div>`;

        return `
            <div class="flex items-center gap-2.5 bg-white/5 border border-white/10 rounded-xl px-2.5 py-2">
                <img src="/media?path=${encodeURIComponent(f.thumb_path || '')}"
                     class="w-10 h-10 rounded-full object-cover bg-black/30 shrink-0"/>
                <div class="flex-1 min-w-0">
                    <div id="lb-face-view-${f.face_id}" class="min-w-0">
                        ${displayHtml}
                    </div>
                    <div id="lb-face-editor-${f.face_id}" class="hidden space-y-1.5">
                        <div class="flex items-center gap-1">
                            <input id="lb-face-name-input-${f.face_id}" type="text" list="lb-faces-persons-datalist"
                                   value="${isUnknown ? '' : escHtml(rawName)}"
                                   placeholder="Nom de la personne..."
                                   onkeydown="if(event.key==='Enter'){event.preventDefault();submitLightboxFaceNameEdit(${f.face_id});}else if(event.key==='Escape'){event.stopPropagation();cancelLightboxFaceNameEdit(${f.face_id});}"
                                   class="flex-1 min-w-0 bg-black/45 border border-white/20 rounded-lg px-2 py-1 text-xs text-white placeholder-white/40 focus:outline-none focus:border-white/45"/>
                            <button type="button" onclick="submitLightboxFaceNameEdit(${f.face_id})" title="Valider"
                                    class="shrink-0 w-6 h-6 rounded-lg bg-white text-[#1E1E1E] hover:bg-white/90 text-[11px] font-bold flex items-center justify-center transition cursor-pointer">✓</button>
                            <button type="button" onclick="cancelLightboxFaceNameEdit(${f.face_id})" title="Annuler"
                                    class="shrink-0 w-6 h-6 rounded-lg bg-white/10 hover:bg-white/20 text-[11px] flex items-center justify-center transition cursor-pointer">✕</button>
                        </div>
                        ${knownOptions ? `
                        <select onchange="changeLightboxFacePerson(${f.face_id}, this)"
                                class="w-full bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[11px] text-white/85 focus:outline-none focus:border-white/40 cursor-pointer">
                            <option value="">Ou choisir une personne existante...</option>
                            ${knownOptions}
                        </select>` : ''}
                    </div>
                </div>
                <button type="button" onclick="removeLightboxFace(${f.face_id})" title="Retirer ce visage"
                        class="w-7 h-7 rounded-full bg-red-500/15 hover:bg-red-500/35 text-red-300 flex items-center justify-center shrink-0 transition cursor-pointer">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                        <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                </button>
            </div>
        `;
    }).join('');
}

function startLightboxFaceNameEdit(faceId) {
    const viewEl = document.getElementById(`lb-face-view-${faceId}`);
    const edEl = document.getElementById(`lb-face-editor-${faceId}`);
    const inpEl = document.getElementById(`lb-face-name-input-${faceId}`);
    if (viewEl) viewEl.classList.add('hidden');
    if (edEl) edEl.classList.remove('hidden');
    if (inpEl) {
        inpEl.focus();
        inpEl.select();
    }
}

function cancelLightboxFaceNameEdit(faceId) {
    const viewEl = document.getElementById(`lb-face-view-${faceId}`);
    const edEl = document.getElementById(`lb-face-editor-${faceId}`);
    if (edEl) edEl.classList.add('hidden');
    if (viewEl) viewEl.classList.remove('hidden');
}

async function _applyLightboxFaceReassign(payload) {
    const res = await fetch('/api/faces/reassign', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
    });
    if (!res.ok) {
        alert('Impossible de modifier cette personne.');
        renderLightboxFacesEditor();
        return false;
    }
    try {
        const pRes = await fetch('/api/persons');
        if (pRes.ok) lbFacesEditorPersons = (await pRes.json()).persons || [];
    } catch (e) {}
    await loadLightboxMetadataInfo();
    renderLightboxFacesEditor();
    return true;
}

async function submitLightboxFaceNameEdit(faceId) {
    const inpEl = document.getElementById(`lb-face-name-input-${faceId}`);
    const newName = (inpEl?.value || '').trim();
    if (!newName) {
        cancelLightboxFaceNameEdit(faceId);
        return;
    }
    const faces = (window._lbCurrentInspectData && window._lbCurrentInspectData.faces) || [];
    const curFace = faces.find(f => Number(f.face_id) === Number(faceId));
    const curName = String(curFace?.name || '').trim();
    if (curName && curName.toLowerCase() !== 'inconnu' && curName === newName) {
        cancelLightboxFaceNameEdit(faceId);
        return;
    }

    const existing = lbFacesEditorPersons.find(
        p => p.name && p.name.trim().toLowerCase() === newName.toLowerCase() && p.name.trim().toLowerCase() !== 'inconnu'
    );
    const payload = existing
        ? { face_ids: [faceId], action: 'EXISTING_PERSON', target_person_id: Number(existing.person_id) }
        : { face_ids: [faceId], action: 'NEW_GROUP', new_group_name: newName };
    await _applyLightboxFaceReassign(payload);
}

async function changeLightboxFacePerson(faceId, selectEl) {
    const val = selectEl?.value;
    if (!val) return;
    await _applyLightboxFaceReassign({ face_ids: [faceId], action: 'EXISTING_PERSON', target_person_id: Number(val) });
}

async function removeLightboxFace(faceId) {
    const res = await fetch('/api/faces/reassign', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ face_ids: [faceId], action: 'IGNORE' })
    });
    if (!res.ok) {
        alert('Impossible de supprimer ce visage.');
        return;
    }
    await loadLightboxMetadataInfo();
    const faces = (window._lbCurrentInspectData && window._lbCurrentInspectData.faces) || [];
    if (!faces.length) {
        closeLightboxFacesEditor();
    } else {
        renderLightboxFacesEditor();
    }
}

async function rerunLightboxFacesAnalysis() {
    closeLightboxFacesEditor();
    await runSingleMediaAnalysis(true, false, true);
}

function _renderLightboxAlbumRowHtml(a, rightControlHtml = '') {
    const escHtml = s => String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const fullName = String(a.name || '');
    const parts = fullName.split('/').map(s => s.trim()).filter(Boolean);
    const isSubalbum = parts.length > 1;
    const primaryTitle = isSubalbum ? parts[parts.length - 1] : fullName;
    const parentPath = isSubalbum ? parts.slice(0, -1).join('/') : fullName;
    const parentLabel = isSubalbum ? parts.slice(0, -1).join(' / ') : '';
    const cnt = Number(a.count || 1);
    const coverThumb = a.cover_path
        ? `<img src="/thumb?path=${encodeURIComponent(a.cover_path)}" class="w-10 h-10 rounded-xl object-cover bg-black/30 shrink-0 group-hover:scale-105 transition"/>`
        : `<div class="w-10 h-10 rounded-xl bg-black/30 flex items-center justify-center shrink-0 text-white/50">
               <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
           </div>`;

    const countLabel = `${cnt} élément${cnt > 1 ? 's' : ''}`;
    const parentBadgeHtml = isSubalbum
        ? `<button type="button" data-album="${escHtml(parentPath)}" onclick="openLightboxAlbum(this.dataset.album)"
                   title="Ouvrir l'album principal ${escHtml(parentPath)}"
                   class="shrink min-w-0 max-w-[45%] px-1.5 py-0.5 rounded-full bg-white/15 hover:bg-white/25 text-[9px] font-semibold text-white/80 hover:text-white truncate transition cursor-pointer">
               ${escHtml(parentLabel)}
           </button>`
        : '';

    return `
        <div class="flex items-center gap-2.5 p-1.5 -mx-1.5 rounded-xl hover:bg-white/10 transition group">
            <button type="button" data-album="${escHtml(fullName)}" onclick="openLightboxAlbum(this.dataset.album)"
                    title="Ouvrir l'album ${escHtml(fullName)}"
                    class="shrink-0 cursor-pointer">
                ${coverThumb}
            </button>
            <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5 min-w-0">
                    <button type="button" data-album="${escHtml(fullName)}" onclick="openLightboxAlbum(this.dataset.album)"
                            title="Ouvrir l'album ${escHtml(fullName)}"
                            class="min-w-0 truncate text-left text-xs font-bold group-hover:text-white hover:underline cursor-pointer">
                        ${escHtml(primaryTitle)}
                    </button>
                    ${parentBadgeHtml}
                </div>
                <button type="button" data-album="${escHtml(fullName)}" onclick="openLightboxAlbum(this.dataset.album)"
                        class="block w-full text-left text-[10px] font-medium text-white/60 truncate cursor-pointer">
                    ${countLabel}
                </button>
            </div>
            ${rightControlHtml}
        </div>
    `;
}

function toggleLightboxExtraAlbums() {
    const extraEl = document.getElementById('lb-info-albums-extra');
    const chevronEl = document.getElementById('lb-albums-expand-chevron');
    const btnEl = document.getElementById('lb-albums-expand-btn');
    if (!extraEl) return;
    const nowHidden = extraEl.classList.toggle('hidden');
    if (chevronEl) chevronEl.classList.toggle('rotate-180', !nowHidden);
    if (btnEl) btnEl.setAttribute('aria-expanded', nowHidden ? 'false' : 'true');
}

function openLightboxAlbum(albumName) {
    if (!albumName) return;
    closeLightbox();
    switchTab('albums');
    openSingleAlbumView(albumName);
}

let lbAlbumsEditorAll = [];
let lbAlbumsEditorExpanded = new Set();
let lbAlbumsEditorSortBy = 'date';
let lbAlbumsEditorSortDir = 'desc';

function _syncLightboxAlbumEditorSortUI() {
    const sel = document.getElementById('lb-albums-edit-sort-by');
    if (sel) sel.value = lbAlbumsEditorSortBy;
    _syncSortDirButtonUI(lbAlbumsEditorSortDir === 'asc', 'lb-albums-edit-sort-dir-btn', 'lb-albums-edit-sort-arrow');
}

function onChangeLightboxAlbumEditorSortBy() {
    const sel = document.getElementById('lb-albums-edit-sort-by');
    lbAlbumsEditorSortBy = sel ? sel.value : 'date';
    lbAlbumsEditorSortDir = lbAlbumsEditorSortBy === 'name' ? 'asc' : 'desc';
    _syncLightboxAlbumEditorSortUI();
    renderLightboxAlbumsEditor();
}

function toggleLightboxAlbumEditorSortDir() {
    lbAlbumsEditorSortDir = lbAlbumsEditorSortDir === 'asc' ? 'desc' : 'asc';
    _syncLightboxAlbumEditorSortUI();
    renderLightboxAlbumsEditor();
}

let lbAlbumsEditorSources = [];

function toggleLightboxAlbumCreateBox(forceShow = null) {
    const box = document.getElementById('lb-albums-edit-create-box');
    const errEl = document.getElementById('lb-albums-edit-create-error');
    if (!box) return;
    const shouldShow = forceShow === null ? box.classList.contains('hidden') : !!forceShow;
    box.classList.toggle('hidden', !shouldShow);
    if (errEl) {
        errEl.textContent = '';
        errEl.classList.add('hidden');
    }
    if (shouldShow) {
        _populateLightboxAlbumCreateSourceSelect();
        const nameInp = document.getElementById('lb-albums-edit-new-name');
        if (nameInp) {
            nameInp.value = '';
            setTimeout(() => nameInp.focus(), 30);
        }
    }
}

function _populateLightboxAlbumCreateSourceSelect() {
    const wrap = document.getElementById('lb-albums-edit-new-source-wrap');
    const sel = document.getElementById('lb-albums-edit-new-source');
    if (!wrap || !sel) return;
    if (lbAlbumsEditorSources.length <= 1) {
        wrap.classList.add('hidden');
        sel.innerHTML = '';
        return;
    }
    const prev = sel.value;
    const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    sel.innerHTML = lbAlbumsEditorSources.map(src => `<option value="${esc(src)}">${esc(src)}</option>`).join('');
    if (prev && lbAlbumsEditorSources.includes(prev)) sel.value = prev;
    wrap.classList.remove('hidden');
}

async function submitLightboxCreateAlbum() {
    const nameInp = document.getElementById('lb-albums-edit-new-name');
    const sourceSel = document.getElementById('lb-albums-edit-new-source');
    const errEl = document.getElementById('lb-albums-edit-create-error');
    const name = (nameInp?.value || '').trim();
    const sourceDir = (lbAlbumsEditorSources.length > 1 && sourceSel?.value) ? sourceSel.value : null;
    if (!name) {
        if (errEl) {
            errEl.textContent = "Veuillez saisir un nom d'album.";
            errEl.classList.remove('hidden');
        }
        return;
    }

    const res = await fetch('/api/albums/create', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ name, parent_id: null, source_dir: sourceDir })
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (errEl) {
            errEl.textContent = err.detail || "Impossible de créer l'album.";
            errEl.classList.remove('hidden');
        }
        return;
    }
    const created = await res.json();
    toggleLightboxAlbumCreateBox(false);
    const createdPath = created?.album?.full_path || name;
    await addLightboxMediaToAlbum(createdPath);
}

let lbAlbumsEditorCreatingParentId = null;
let lbAlbumsEditorQuery = '';

function onInputLightboxAlbumSearch(val) {
    lbAlbumsEditorQuery = String(val || '');
    renderLightboxAlbumsEditor();
}

let _albumsEditorBatchPaths = null;

function openBatchAlbumsEditor() {
    const paths = Array.from(selectedGalleryPaths);
    if (!paths.length) return;
    openLightboxAlbumsEditor(paths);
}

async function openLightboxAlbumsEditor(batchPaths = null) {
    const modal = document.getElementById('lb-albums-edit-modal');
    if (!modal) return;
    _albumsEditorBatchPaths = (Array.isArray(batchPaths) && batchPaths.length > 0) ? batchPaths.slice() : null;
    lbAlbumsEditorExpanded = new Set();
    lbAlbumsEditorCreatingParentId = null;
    lbAlbumsEditorQuery = '';
    _syncLightboxAlbumEditorSortUI();
    toggleLightboxAlbumCreateBox(false);
    const inp = document.getElementById('lb-albums-edit-input');
    if (inp) inp.value = '';
    modal.classList.remove('hidden');

    const curLbl = document.getElementById('lb-albums-edit-current-label');
    if (curLbl) curLbl.textContent = _albumsEditorBatchPaths ? 'Sélection' : 'Albums actuels';

    const curEl = document.getElementById('lb-albums-edit-current');
    if (curEl) curEl.innerHTML = `<div class="text-xs text-white/60 py-2 text-center">Chargement...</div>`;
    const curItem = _albumsEditorBatchPaths ? null : currentGalleryItems[currentLightboxIndex];
    const needsInspect = !!(curItem && (!window._lbCurrentInspectData || window._lbCurrentInspectData.source_path !== curItem.source_path));
    try {
        const [albRes, libRes, inspRes] = await Promise.all([
            fetch('/api/albums/list?flat=true'),
            fetch('/api/libraries').catch(() => null),
            needsInspect ? fetch(`/api/metadata/inspect?source_path=${encodeURIComponent(curItem.source_path)}`).catch(() => null) : Promise.resolve(null)
        ]);
        if (albRes.ok) {
            const data = await albRes.json();
            lbAlbumsEditorAll = data.all_albums || data.albums || [];
        }
        if (inspRes && inspRes.ok) {
            window._lbCurrentInspectData = await inspRes.json();
        }
        if (libRes && libRes.ok) {
            const libData = await libRes.json();
            const activeLib = (libData.libraries || {})[libData.active_library || ''] || {};
            const rawSources = Array.isArray(activeLib.source_paths) ? activeLib.source_paths : [];
            lbAlbumsEditorSources = [...new Set(rawSources.map(s => String(s || '').trim()).filter(Boolean))];
        } else {
            lbAlbumsEditorSources = [];
        }
    } catch (e) {
        lbAlbumsEditorAll = [];
        lbAlbumsEditorSources = [];
    }
    renderLightboxAlbumsEditor();
    setTimeout(() => inp && inp.focus(), 50);
}

function closeLightboxAlbumsEditor() {
    _albumsEditorBatchPaths = null;
    document.getElementById('lb-albums-edit-modal')?.classList.add('hidden');
}

function renderLightboxAlbumsEditor() {
    const curEl = document.getElementById('lb-albums-edit-current');
    const availEl = document.getElementById('lb-albums-edit-available');
    if (!curEl || !availEl) return;

    const isBatch = !!(_albumsEditorBatchPaths && _albumsEditorBatchPaths.length > 0);
    const d = window._lbCurrentInspectData || {};
    const assigned = isBatch ? [] : ((Array.isArray(d.albums) && d.albums.length > 0)
        ? d.albums
        : (d.album_name
            ? d.album_name.split(',').map(s => s.trim()).filter(Boolean).map(name => ({
                name,
                cover_path: d.dest_path || '',
                count: d.album_count || 1
            }))
            : []));
    const assignedNames = new Set(assigned.map(a => a.name));

    const escHtml = s => String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    if (isBatch) {
        const n = _albumsEditorBatchPaths.length;
        curEl.innerHTML = `<div class="text-[11px] text-white/75 py-1">${n} média${n > 1 ? 's' : ''} sélectionné${n > 1 ? 's' : ''} — choisissez un album ci-dessous.</div>`;
    } else if (assigned.length === 0) {
        curEl.innerHTML = `<div class="text-[11px] text-white/55 py-1">Ce média n'est dans aucun album.</div>`;
    } else {
        curEl.innerHTML = assigned.map((a, idx) => {
            const match = lbAlbumsEditorAll.find(x => x.full_path === a.name);
            const covPath = (match && match.cover_path) || a.cover_path || '';
            const isPrimary = idx === 0;
            const coverThumb = covPath
                ? `<img src="/thumb?path=${encodeURIComponent(covPath)}" class="w-9 h-9 rounded-lg object-cover bg-black/30 shrink-0"/>`
                : `<div class="w-9 h-9 rounded-lg bg-black/30 flex items-center justify-center shrink-0 text-white/45 text-xs">📁</div>`;
            const starBtn = `<button type="button" data-album="${escHtml(a.name)}"
                       onclick="${isPrimary ? '' : 'setLightboxPrimaryAlbum(this.dataset.album)'}"
                       title="${isPrimary ? 'Album affiché en priorité sur ce média' : 'Afficher cet album en priorité sur ce média'}"
                       class="w-7 h-7 rounded-full ${isPrimary ? 'bg-amber-400/25 text-amber-300 cursor-default' : 'bg-white/10 hover:bg-white/20 text-white/60 hover:text-amber-300 cursor-pointer'} flex items-center justify-center text-xs shrink-0 transition">★</button>`;
            return `
                <div class="flex items-center gap-2.5 bg-white/5 border border-white/10 rounded-xl px-2.5 py-1.5">
                    ${coverThumb}
                    <div class="flex-1 min-w-0">
                        <div class="text-xs font-bold truncate">${escHtml(a.name)}</div>
                        <div class="text-[10px] text-white/55">${Number(a.count || 1)} élément${Number(a.count || 1) > 1 ? 's' : ''}</div>
                    </div>
                    ${starBtn}
                    <button type="button" data-album="${escHtml(a.name)}" onclick="removeLightboxMediaFromAlbum(this.dataset.album)"
                            title="Retirer de cet album"
                            class="w-7 h-7 rounded-full bg-red-500/15 hover:bg-red-500/35 text-red-300 flex items-center justify-center shrink-0 transition">
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                    </button>
                </div>
            `;
        }).join('');
    }

    if (lbAlbumsEditorAll.length === 0) {
        availEl.innerHTML = `<div class="text-[11px] text-white/45 py-1">Aucun album existant.</div>`;
    } else {
        const allIds = new Set(lbAlbumsEditorAll.map(a => a.album_id));
        const byId = new Map(lbAlbumsEditorAll.map(a => [a.album_id, a]));
        const q = lbAlbumsEditorQuery.trim().toLowerCase();
        let sourceList = lbAlbumsEditorAll;
        const forceExpandIds = new Set();

        if (q) {
            const rawChildrenByParent = new Map();
            lbAlbumsEditorAll.forEach(a => {
                const pid = (a.parent_id != null && allIds.has(a.parent_id)) ? a.parent_id : null;
                if (!rawChildrenByParent.has(pid)) rawChildrenByParent.set(pid, []);
                rawChildrenByParent.get(pid).push(a);
            });
            const visibleIds = new Set();
            const addDescendants = (aid) => {
                (rawChildrenByParent.get(aid) || []).forEach(ch => {
                    visibleIds.add(ch.album_id);
                    addDescendants(ch.album_id);
                });
            };
            lbAlbumsEditorAll.forEach(a => {
                const hay = `${a.name || ''} ${a.full_path || ''}`.toLowerCase();
                if (hay.includes(q)) {
                    visibleIds.add(a.album_id);
                    addDescendants(a.album_id);
                    let pid = a.parent_id;
                    while (pid != null && byId.has(pid)) {
                        visibleIds.add(pid);
                        forceExpandIds.add(pid);
                        pid = byId.get(pid).parent_id;
                    }
                }
            });
            sourceList = lbAlbumsEditorAll.filter(a => visibleIds.has(a.album_id));
        }

        if (sourceList.length === 0) {
            availEl.innerHTML = `<div class="text-[11px] text-white/45 py-1">Aucun album ne correspond à « ${escHtml(lbAlbumsEditorQuery.trim())} ».</div>`;
        } else {
            const visibleSet = new Set(sourceList.map(a => a.album_id));
            const childrenByParent = new Map();
            sourceList.forEach(a => {
                const pid = (a.parent_id != null && visibleSet.has(a.parent_id)) ? a.parent_id : null;
                if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
                childrenByParent.get(pid).push(a);
            });
            childrenByParent.forEach((arr, pid) => {
                childrenByParent.set(pid, arr.sort((a, b) => _compareAlbumItems(a, b, lbAlbumsEditorSortBy, lbAlbumsEditorSortDir)));
            });
            const expandedSet = new Set([...lbAlbumsEditorExpanded, ...forceExpandIds]);
            availEl.innerHTML = _renderAlbumEditorTreeNodes(null, assignedNames, childrenByParent, escHtml, expandedSet);
        }
    }
    _populateLightboxAlbumCreateSourceSelect();
}

function _renderLightboxSubalbumCreateBoxHtml(parentId) {
    return `
        <div class="p-2 rounded-xl bg-black/35 border border-white/15 space-y-1.5">
            <div class="flex items-center gap-1.5">
                <input id="lb-albums-sub-create-input-${parentId}" type="text" placeholder="Nom du sous-album..."
                       onkeydown="if(event.key==='Enter'){event.preventDefault();submitLightboxSubalbumCreate(${parentId});}else if(event.key==='Escape'){event.stopPropagation();cancelLightboxSubalbumCreate();}"
                       class="flex-1 min-w-0 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[11px] text-white placeholder-white/40 focus:outline-none focus:border-white/40"/>
                <button type="button" onclick="submitLightboxSubalbumCreate(${parentId})" title="Créer le sous-album"
                        class="w-6 h-6 rounded-lg bg-white text-[#1E1E1E] hover:bg-white/90 text-[11px] font-bold flex items-center justify-center shrink-0 transition cursor-pointer">✓</button>
                <button type="button" onclick="cancelLightboxSubalbumCreate()" title="Annuler"
                        class="w-6 h-6 rounded-lg bg-white/10 hover:bg-white/20 text-white/75 text-[10px] font-bold flex items-center justify-center shrink-0 transition cursor-pointer">✕</button>
            </div>
            <p id="lb-albums-sub-create-err-${parentId}" class="hidden text-[10px] text-red-300"></p>
        </div>
    `;
}

function _renderAlbumEditorTreeNodes(parentId, assignedNames, childrenByParent, escHtml, expandedSet = lbAlbumsEditorExpanded) {
    const list = childrenByParent.get(parentId) || [];
    if (list.length === 0) return '';
    return list.map(a => {
        const children = childrenByParent.get(a.album_id) || [];
        const hasChildren = children.length > 0;
        const isExpanded = expandedSet.has(a.album_id);
        const isCreatingHere = lbAlbumsEditorCreatingParentId === a.album_id;
        const isAssigned = assignedNames.has(a.full_path);
        const coverThumb = a.cover_path
            ? `<img src="/thumb?path=${encodeURIComponent(a.cover_path)}" class="w-7 h-7 rounded-lg object-cover bg-black/30 shrink-0"/>`
            : `<div class="w-7 h-7 rounded-lg bg-black/30 flex items-center justify-center shrink-0 text-white/45 text-[10px]">📁</div>`;
        const sideActionBtn = hasChildren
            ? `<button type="button" onclick="toggleLightboxEditorSubalbums(${a.album_id})"
                       title="${isExpanded ? 'Masquer les sous-albums' : 'Afficher les sous-albums'}"
                       class="w-7 h-7 rounded-lg bg-white/5 hover:bg-white/15 border border-white/10 text-white/75 hover:text-white flex items-center justify-center shrink-0 transition cursor-pointer">
                   <svg class="w-3.5 h-3.5 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                       <polyline points="9 18 15 12 9 6"/>
                   </svg>
               </button>`
            : `<button type="button" onclick="openLightboxSubalbumCreate(${a.album_id})"
                       title="Créer un sous-album"
                       class="w-7 h-7 rounded-lg bg-white/5 hover:bg-white/15 border border-white/10 text-white/75 hover:text-white flex items-center justify-center shrink-0 text-sm font-bold transition cursor-pointer">+</button>`;
        const rightMeta = isAssigned
            ? `<span class="text-[10px] font-bold text-emerald-300 shrink-0">✓</span>`
            : `<span class="text-[10px] text-white/55 shrink-0">${Number(a.count || 0)}</span>`;
        const actionBtn = isAssigned
            ? `<div class="flex-1 min-w-0 flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-xl bg-white/5 border border-white/10 text-left opacity-65">
                   <div class="flex items-center gap-2 min-w-0">
                       ${coverThumb}
                       <span class="text-xs font-medium truncate">${escHtml(a.name || a.full_path)}</span>
                   </div>
                   ${rightMeta}
               </div>`
            : `<button type="button" data-album="${escHtml(a.full_path)}" onclick="addLightboxMediaToAlbum(this.dataset.album)"
                       class="flex-1 min-w-0 flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-xl bg-white/5 hover:bg-white/15 border border-white/10 text-left transition cursor-pointer">
                   <div class="flex items-center gap-2 min-w-0">
                       ${coverThumb}
                       <span class="text-xs font-medium truncate">${escHtml(a.name || a.full_path)}</span>
                   </div>
                   ${rightMeta}
               </button>`;

        let subBlockHtml = '';
        if (hasChildren && isExpanded) {
            const subCreateFooter = isCreatingHere
                ? _renderLightboxSubalbumCreateBoxHtml(a.album_id)
                : `<button type="button" onclick="openLightboxSubalbumCreate(${a.album_id})"
                           class="w-full py-1 px-2.5 rounded-xl bg-white/5 hover:bg-white/15 border border-dashed border-white/15 text-[10px] font-semibold text-white/75 hover:text-white text-left transition cursor-pointer">
                       + Créer un sous-album
                   </button>`;
            subBlockHtml = `<div class="ml-3.5 pl-2 border-l border-white/10 space-y-1 mt-1">
                ${_renderAlbumEditorTreeNodes(a.album_id, assignedNames, childrenByParent, escHtml, expandedSet)}
                ${subCreateFooter}
            </div>`;
        } else if (!hasChildren && isCreatingHere) {
            subBlockHtml = `<div class="ml-3.5 pl-2 border-l border-white/10 space-y-1 mt-1">
                ${_renderLightboxSubalbumCreateBoxHtml(a.album_id)}
            </div>`;
        }

        return `
            <div>
                <div class="flex items-center gap-1.5">
                    ${actionBtn}
                    ${sideActionBtn}
                </div>
                ${subBlockHtml}
            </div>
        `;
    }).join('');
}

function openLightboxSubalbumCreate(parentId) {
    lbAlbumsEditorCreatingParentId = parentId;
    lbAlbumsEditorExpanded.add(parentId);
    renderLightboxAlbumsEditor();
    setTimeout(() => document.getElementById(`lb-albums-sub-create-input-${parentId}`)?.focus(), 30);
}

function cancelLightboxSubalbumCreate() {
    lbAlbumsEditorCreatingParentId = null;
    renderLightboxAlbumsEditor();
}

async function submitLightboxSubalbumCreate(parentId) {
    const inp = document.getElementById(`lb-albums-sub-create-input-${parentId}`);
    const errEl = document.getElementById(`lb-albums-sub-create-err-${parentId}`);
    const name = (inp?.value || '').trim();
    if (!name) {
        if (errEl) {
            errEl.textContent = 'Veuillez saisir un nom de sous-album.';
            errEl.classList.remove('hidden');
        }
        return;
    }

    const parentObj = lbAlbumsEditorAll.find(a => Number(a.album_id) === Number(parentId));
    const sourceDir = (parentObj && parentObj.source_dir) ? parentObj.source_dir : null;
    const res = await fetch('/api/albums/create', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ name, parent_id: parentId, source_dir: sourceDir })
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (errEl) {
            errEl.textContent = err.detail || 'Impossible de créer le sous-album.';
            errEl.classList.remove('hidden');
        }
        return;
    }
    const created = await res.json();
    lbAlbumsEditorCreatingParentId = null;
    lbAlbumsEditorExpanded.add(parentId);
    const createdPath = created?.album?.full_path;
    if (createdPath) {
        await addLightboxMediaToAlbum(createdPath);
    } else {
        await _refreshAfterLightboxAlbumChange();
    }
}

function toggleLightboxEditorSubalbums(albumId) {
    if (lbAlbumsEditorExpanded.has(albumId)) {
        lbAlbumsEditorExpanded.delete(albumId);
        if (lbAlbumsEditorCreatingParentId === albumId) lbAlbumsEditorCreatingParentId = null;
    } else {
        lbAlbumsEditorExpanded.add(albumId);
    }
    renderLightboxAlbumsEditor();
}

async function _refreshAfterLightboxAlbumChange() {
    try {
        const res = await fetch('/api/albums/list?flat=true');
        if (res.ok) {
            const data = await res.json();
            lbAlbumsEditorAll = data.all_albums || data.albums || [];
        }
    } catch (e) {}
    await loadLightboxMetadataInfo();
    const curItem = currentGalleryItems[currentLightboxIndex];
    if (curItem && window._lbCurrentInspectData && window._lbCurrentInspectData.source_path === curItem.source_path) {
        curItem.album_name = window._lbCurrentInspectData.album_name || '';
    }
    await loadGalleryFilters();
    if (currentTab === 'albums') {
        if (openedAlbumName) loadSingleAlbumItems(true);
        else loadAlbumsView();
    }
    renderLightboxAlbumsEditor();
}

async function addLightboxMediaToAlbum(albumName) {
    if (!albumName) return;
    if (_albumsEditorBatchPaths && _albumsEditorBatchPaths.length > 0) {
        const res = await fetch('/api/gallery/batch_action', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                source_paths: _albumsEditorBatchPaths,
                action: 'ALBUM_ADD',
                album_name: albumName
            })
        });
        if (!res.ok) {
            alert("Impossible d'ajouter la sélection à cet album.");
            return;
        }
        closeLightboxAlbumsEditor();
        selectedGalleryPaths.clear();
        updateGalleryBatchBar();
        await loadGalleryFilters();
        refreshActiveMediaView();
        loadStats();
        return;
    }

    const item = currentGalleryItems[currentLightboxIndex];
    if (!item) return;
    const res = await fetch('/api/gallery/batch_action', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
            source_paths: [item.source_path],
            action: 'ALBUM_ADD',
            album_name: albumName
        })
    });
    if (!res.ok) {
        alert("Impossible d'ajouter à cet album.");
        return;
    }
    await _refreshAfterLightboxAlbumChange();
}

async function removeLightboxMediaFromAlbum(albumName) {
    const item = currentGalleryItems[currentLightboxIndex];
    if (!item || !albumName) return;
    const res = await fetch('/api/gallery/batch_action', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            source_paths: [item.source_path],
            action: 'ALBUM_REMOVE',
            album_name: albumName
        })
    });
    if (!res.ok) {
        alert("Impossible de retirer de cet album.");
        return;
    }
    await _refreshAfterLightboxAlbumChange();
}

async function setLightboxPrimaryAlbum(albumName) {
    const item = currentGalleryItems[currentLightboxIndex];
    if (!item || !albumName) return;
    const res = await fetch('/api/gallery/batch_action', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            source_paths: [item.source_path],
            action: 'ALBUM_SET_PRIMARY',
            album_name: albumName
        })
    });
    if (!res.ok) {
        alert("Impossible de définir cet album comme principal.");
        return;
    }
    await _refreshAfterLightboxAlbumChange();
}

async function setLightboxMediaAsAlbumCover(albumId) {
    const d = window._lbCurrentInspectData || {};
    if (!albumId || !d.dest_path) return;
    const res = await fetch('/api/albums/set_cover', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ album_id: albumId, cover_path: d.dest_path })
    });
    if (!res.ok) {
        alert("Impossible de modifier la couverture.");
        return;
    }
    await _refreshAfterLightboxAlbumChange();
}

// =========================================================================
// ÉDITION DÉDIÉE DE LA LOCALISATION (LIGHTBOX)
// =========================================================================
let lbLocationPickerMap = null;
let lbLocationPickerMarker = null;
let _lbLocationReqSeq = 0;

function _setLightboxLocationStatus(msg = '') {
    const el = document.getElementById('lb-location-status');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('hidden', !msg);
}

function _isValidLatLon(lat, lon) {
    return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

async function _resolveLightboxPickerLabel(lat, lon) {
    const labelEl = document.getElementById('lb-location-resolved-label');
    if (!labelEl) return;
    const reqSeq = ++_lbLocationReqSeq;
    try {
        const res = await fetch(`/api/map/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);
        if (reqSeq !== _lbLocationReqSeq) return;
        if (!res.ok) {
            labelEl.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
            return;
        }
        const geo = await res.json();
        if (reqSeq !== _lbLocationReqSeq) return;
        const city = (geo.city || '').trim();
        const label = (geo.label || city || '').trim();
        labelEl.textContent = label || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        labelEl.title = label;
        if (city) {
            const key = `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;
            _lbCityCache.set(key, { city, label: label || city });
        }
    } catch (e) {
        if (reqSeq === _lbLocationReqSeq) {
            labelEl.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        }
    }
}

function _setLightboxLocationPin(lat, lon, resolveCity = true, customLabel = '') {
    if (!_isValidLatLon(lat, lon)) return;
    const latEl = document.getElementById('lb-location-lat');
    const lonEl = document.getElementById('lb-location-lon');
    const saveBtn = document.getElementById('lb-location-save-btn');
    const labelEl = document.getElementById('lb-location-resolved-label');
    if (latEl) latEl.value = lat.toFixed(6);
    if (lonEl) lonEl.value = lon.toFixed(6);
    if (saveBtn) saveBtn.disabled = false;
    _setLightboxLocationStatus('');

    if (lbLocationPickerMap) {
        if (lbLocationPickerMarker) {
            lbLocationPickerMarker.setLatLng([lat, lon]);
        } else {
            lbLocationPickerMarker = L.marker([lat, lon]).addTo(lbLocationPickerMap);
        }
        lbLocationPickerMap.setView([lat, lon], Math.max(lbLocationPickerMap.getZoom(), 13));
    }

    if (customLabel && labelEl) {
        labelEl.textContent = customLabel;
        labelEl.title = customLabel;
    } else if (labelEl && !resolveCity) {
        labelEl.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    }
    if (resolveCity) {
        if (labelEl && !customLabel) labelEl.textContent = 'Localisation...';
        _resolveLightboxPickerLabel(lat, lon);
    }
}

function onInputLightboxLocationCoords() {
    const lat = parseFloat(document.getElementById('lb-location-lat')?.value || '');
    const lon = parseFloat(document.getElementById('lb-location-lon')?.value || '');
    if (!_isValidLatLon(lat, lon)) {
        const saveBtn = document.getElementById('lb-location-save-btn');
        if (saveBtn) saveBtn.disabled = true;
        return;
    }
    _setLightboxLocationPin(lat, lon, true);
}

async function openLightboxLocationEditor() {
    const modal = document.getElementById('lb-location-edit-modal');
    const curItem = currentGalleryItems[currentLightboxIndex];
    if (!modal || !curItem) return;

    const needsInspect = !window._lbCurrentInspectData || window._lbCurrentInspectData.source_path !== curItem.source_path;
    if (needsInspect) {
        try {
            const res = await fetch(`/api/metadata/inspect?source_path=${encodeURIComponent(curItem.source_path)}`);
            if (res.ok) window._lbCurrentInspectData = await res.json();
        } catch (e) {}
    }

    const d = window._lbCurrentInspectData || {};
    const lat = Number(d.latitude);
    const lon = Number(d.longitude);
    const hasCoords = _isValidLatLon(lat, lon) && (lat !== 0 || lon !== 0);

    const titleEl = document.getElementById('lb-location-modal-title');
    const searchEl = document.getElementById('lb-location-search-input');
    const latEl = document.getElementById('lb-location-lat');
    const lonEl = document.getElementById('lb-location-lon');
    const labelEl = document.getElementById('lb-location-resolved-label');
    const stripBtn = document.getElementById('lb-location-strip-btn');
    const saveBtn = document.getElementById('lb-location-save-btn');

    if (titleEl) titleEl.textContent = hasCoords ? 'Modifier le lieu' : 'Ajouter un lieu';
    if (searchEl) searchEl.value = '';
    _setLightboxLocationStatus('');
    if (stripBtn) stripBtn.classList.toggle('hidden', !hasCoords);
    if (saveBtn) {
        saveBtn.disabled = !hasCoords;
        saveBtn.textContent = 'Enregistrer';
    }
    if (latEl) latEl.value = hasCoords ? lat.toFixed(6) : '';
    if (lonEl) lonEl.value = hasCoords ? lon.toFixed(6) : '';

    if (labelEl) {
        if (hasCoords) {
            const initialPlace = (d.location_label || d.location_city || '').trim();
            labelEl.textContent = initialPlace || 'Localisation...';
            labelEl.title = initialPlace;
            if (!initialPlace) _resolveLightboxPickerLabel(lat, lon);
        } else {
            labelEl.textContent = 'Cliquez sur la carte ou recherchez un lieu';
            labelEl.title = '';
        }
    }

    modal.classList.remove('hidden');

    if (lbLocationPickerMap) {
        lbLocationPickerMap.remove();
        lbLocationPickerMap = null;
        lbLocationPickerMarker = null;
    }
    setTimeout(() => {
        const container = document.getElementById('lb-location-picker-map');
        if (!container || modal.classList.contains('hidden')) return;
        const center = hasCoords ? [lat, lon] : [46.6, 2.2];
        const zoom = hasCoords ? 13 : 5;
        lbLocationPickerMap = L.map('lb-location-picker-map').setView(center, zoom);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(lbLocationPickerMap);
        if (hasCoords) {
            lbLocationPickerMarker = L.marker([lat, lon]).addTo(lbLocationPickerMap);
        }
        lbLocationPickerMap.on('click', (e) => {
            _setLightboxLocationPin(e.latlng.lat, e.latlng.lng, true);
        });
        lbLocationPickerMap.invalidateSize();
        searchEl?.focus();
    }, 60);
}

function closeLightboxLocationEditor() {
    _lbLocationReqSeq++;
    document.getElementById('lb-location-edit-modal')?.classList.add('hidden');
    if (lbLocationPickerMap) {
        lbLocationPickerMap.remove();
        lbLocationPickerMap = null;
        lbLocationPickerMarker = null;
    }
}

async function searchLightboxLocationPlace() {
    const inp = document.getElementById('lb-location-search-input');
    const btn = document.getElementById('lb-location-search-btn');
    const q = (inp?.value || '').trim();
    if (!q) {
        inp?.focus();
        return;
    }
    if (btn) btn.disabled = true;
    _setLightboxLocationStatus('Recherche...');
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
        if (!res.ok) {
            _setLightboxLocationStatus('Erreur de recherche');
            return;
        }
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) {
            _setLightboxLocationStatus('Lieu introuvable');
            return;
        }
        const lat = parseFloat(data[0].lat);
        const lon = parseFloat(data[0].lon);
        _setLightboxLocationPin(lat, lon, true, data[0].display_name || '');
    } catch (e) {
        _setLightboxLocationStatus('Erreur réseau');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function _refreshAfterLightboxLocationChange() {
    await loadLightboxMetadataInfo();
    refreshActiveMediaView();
}

async function saveLightboxLocationEdit() {
    const item = currentGalleryItems[currentLightboxIndex];
    const lat = parseFloat(document.getElementById('lb-location-lat')?.value || '');
    const lon = parseFloat(document.getElementById('lb-location-lon')?.value || '');
    const saveBtn = document.getElementById('lb-location-save-btn');
    if (!item || !_isValidLatLon(lat, lon)) {
        _setLightboxLocationStatus('Coordonnées invalides');
        return;
    }
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Enregistrement...';
    }
    _setLightboxLocationStatus('');
    try {
        const res = await fetch('/api/metadata/batch_update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source_paths: [item.source_path],
                latitude: lat,
                longitude: lon
            })
        });
        if (!res.ok) {
            _setLightboxLocationStatus("Erreur lors de l'enregistrement");
            return;
        }
        closeLightboxLocationEditor();
        await _refreshAfterLightboxLocationChange();
    } catch (e) {
        _setLightboxLocationStatus('Erreur réseau');
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Enregistrer';
        }
    }
}

async function clearLightboxLocationEdit() {
    const item = currentGalleryItems[currentLightboxIndex];
    const stripBtn = document.getElementById('lb-location-strip-btn');
    if (!item) return;
    if (stripBtn) stripBtn.disabled = true;
    _setLightboxLocationStatus('');
    try {
        const res = await fetch('/api/metadata/batch_strip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source_paths: [item.source_path],
                strip_gps: true,
                strip_all_exif: false
            })
        });
        if (!res.ok) {
            _setLightboxLocationStatus('Erreur lors de la suppression');
            return;
        }
        closeLightboxLocationEditor();
        await _refreshAfterLightboxLocationChange();
    } catch (e) {
        _setLightboxLocationStatus('Erreur réseau');
    } finally {
        if (stripBtn) stripBtn.disabled = false;
    }
}