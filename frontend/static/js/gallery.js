// ==================== GALERIE : DÉFILEMENT INFINI, MINIATURES WEBP & SÉLECTION RAPIDE ====================

let galleryPage = 1, galleryTotalPages = 1, galleryTotalItems = 0;
let galleryIsLoading = false;
let selectedGalleryPaths = new Set();
let currentGalleryItems = [];
let lastClickedGalleryIdx = null;
let lastRenderedGroupTitle = {};

let singleAlbumIsLoading = false;
let infiniteScrollObserver = null;

let currentSkipOffset = 0;
let cachedTimelineData = [];

let galleryLayout = localStorage.getItem('phototo_gallery_layout') || 'GRID';    // 'GRID' | 'MASONRY' | 'LIST'
let gallerySize = localStorage.getItem('phototo_gallery_size') || 'MD';        // 'SM' | 'MD' | 'LG'
let galleryGroupBy = 'NONE';   // 'NONE' | 'DAY' | 'WEEK' | 'MONTH' | 'YEAR'

const SHORT_MONTHS_FR = ["", "janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const FULL_MONTHS_FR = ["", "Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];

function getSelectIconHTML(isSelected) {
    if (isSelected) {
        return `<div class="w-5 h-5 rounded-full border-2 border-[#A385A6] bg-white/90 flex items-center justify-center shadow-sm">
                    <div class="w-2.5 h-2.5 rounded-full bg-[#A385A6]"></div>
                </div>`;
    }
    return `<div class="w-4 h-4 rounded-full border-[1.8px] border-[#A385A6]/80 bg-white/40 opacity-0 group-hover:opacity-100 transition"></div>`;
}

function getFavHeartHTML(isFav) {
    const fill = isFav ? '#A385A6' : 'none';
    return `<svg class="w-5 h-5 drop-shadow-sm" fill="${fill}" stroke="#A385A6" stroke-width="2" viewBox="0 0 24 24">
                <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21.3l7.8-7.8 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>
            </svg>`;
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

function setGalleryLayout(layout) {
    galleryLayout = layout;
    localStorage.setItem('phototo_gallery_layout', layout);
    syncGalleryLayoutSizeButtons();
    refreshActiveMediaView();
}

function setGallerySize(size) {
    gallerySize = size;
    localStorage.setItem('phototo_gallery_size', size);
    syncGalleryLayoutSizeButtons();
    refreshActiveMediaView();
}

document.addEventListener('DOMContentLoaded', syncGalleryLayoutSizeButtons);

function onChangeGroupBy(groupMode) {
    galleryGroupBy = groupMode;
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

    const borderClass = isSel
        ? 'ring-[6px] ring-[#A385A6] dark:ring-[#8B6B8E]'
        : 'hover:ring-2 hover:ring-[#A385A6]/50';

    const favVisibility = it.is_favorite ? 'opacity-100' : 'opacity-0 group-hover:opacity-85';

    const selectBtn = `
        <button type="button"
                onclick="event.stopPropagation(); handleGalleryTileSelect(event, ${idx})"
                title="Sélectionner"
                class="tile-select-btn absolute top-2.5 left-2.5 z-10 p-0.5">
            ${getSelectIconHTML(isSel)}
        </button>`;

    const favBtn = `
        <button type="button"
                onclick="event.stopPropagation(); toggleTileFavoriteDirect(${idx})"
                title="Favori"
                class="tile-fav-btn absolute bottom-2.5 left-2.5 z-10 ${favVisibility} hover:scale-110 transition">
            ${getFavHeartHTML(it.is_favorite)}
        </button>`;

    const videoBadge = isVid
        ? `<div class="absolute bottom-2.5 right-2.5 z-10 bg-white/80 dark:bg-black/60 backdrop-blur-sm text-[#A385A6] text-[11px] font-extrabold px-2 py-0.5 rounded-full flex items-center gap-1 pointer-events-none">
             <span>${durText}</span>
             <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.4" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
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

        const listSelectBorder = isSel ? 'ring-2 ring-[#A385A6] dark:ring-[#8B6B8E]' : 'hover:ring-1 hover:ring-[#A385A6]/50';
        const metaParts = [dtStr, dimStr, sizeStr].filter(Boolean).join(' • ');

        return `
        <div id="media-tile-${idx}" data-tile-idx="${idx}" data-ts="${it.timestamp || 0}" data-source="${srcEnc}" onclick="openLightbox(${idx})"
             class="media-tile ui-card group flex items-center ${padCls} cursor-pointer shadow-sm transition-all duration-150 ${listSelectBorder}">
            <button type="button"
                    onclick="event.stopPropagation(); handleGalleryTileSelect(event, ${idx})"
                    title="Sélectionner"
                    class="tile-select-btn shrink-0 p-1">
                ${getSelectIconHTML(isSel)}
            </button>
            <div class="relative shrink-0 ${thumbSizeCls} overflow-hidden bg-black/10">
                <img src="${thumbUrl}" loading="lazy" decoding="async" class="w-full h-full object-cover select-none pointer-events-none"/>
                ${isVid ? `<span class="absolute bottom-1 right-1 bg-black/70 text-white text-[9px] font-bold px-1.5 py-0.2 rounded-full">${durText}</span>` : ''}
            </div>
            <div class="flex-1 min-w-0">
                <div class="font-bold truncate ${titleCls}">${fileName}</div>
                <div class="text-[11px] opacity-65 truncate mt-0.5">${metaParts}${modStr ? ` • Modifié : ${modStr}` : ''}</div>
                ${albStr ? `<div class="mt-1"><span class="ui-pill text-[10px] font-bold px-2 py-0.5 rounded-full">📁 ${albStr}</span></div>` : ''}
            </div>
            <button type="button"
                    onclick="event.stopPropagation(); toggleTileFavoriteDirect(${idx})"
                    title="Favori"
                    class="tile-fav-btn shrink-0 p-1.5 ${favVisibility} hover:scale-110 transition">
                ${getFavHeartHTML(it.is_favorite)}
            </button>
        </div>`;
    }

    if (layoutMode === 'MASONRY' || layoutMode === true) {
        const aspectStyle = (it.width && it.height) ? `aspect-ratio: ${it.width} / ${it.height};` : '';
        return `
        <div id="media-tile-${idx}" data-tile-idx="${idx}" data-ts="${it.timestamp || 0}" data-source="${srcEnc}" onclick="openLightbox(${idx})" style="${aspectStyle}"
             class="media-tile masonry-item ui-card group relative w-full rounded-[24px] overflow-hidden cursor-pointer shadow-sm transition-all duration-150 ${borderClass}">
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

    if (galleryGroupBy === 'NONE') {
        let grid = container.querySelector('.group-grid');
        if (!grid) {
            container.innerHTML = `<div class="${gridClass}"></div>`;
            grid = container.querySelector('.group-grid');
        }
        const html = newItems.map((it, i) => renderSingleMediaTile(it, startIndex + i, galleryLayout)).join('');
        grid.insertAdjacentHTML('beforeend', html);
        return;
    }

    newItems.forEach((it, i) => {
        const globalIdx = startIndex + i;
        const title = formatGroupHeading(it.timestamp, galleryGroupBy);

        if (title !== lastRenderedGroupTitle[containerId]) {
            lastRenderedGroupTitle[containerId] = title;
            const sectionHtml = `
                <div class="space-y-3 group-section">
                    <h3 class="text-sm font-extrabold opacity-80">${title}</h3>
                    <div class="${gridClass}">
                        ${renderSingleMediaTile(it, globalIdx, galleryLayout)}
                    </div>
                </div>`;
            container.insertAdjacentHTML('beforeend', sectionHtml);
        } else {
            const grids = container.querySelectorAll('.group-grid');
            const lastGrid = grids[grids.length - 1];
            if (lastGrid) {
                lastGrid.insertAdjacentHTML('beforeend', renderSingleMediaTile(it, globalIdx, galleryLayout));
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

function updateActiveFilterBadge() {
    const badge = document.getElementById('gallery-active-filter-badge');
    const txt = document.getElementById('gallery-active-filter-text');
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
    if (galleryIsLoading) return;
    if (append && galleryTotalItems > 0 && (currentSkipOffset + currentGalleryItems.length) >= galleryTotalItems) return;

    galleryIsLoading = true;
    const spinner = document.getElementById('gallery-loading-spinner');
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
        const res = await fetch(`/api/gallery/items?${p.toString()}`);
        const d = await res.json();
        const newItems = d.items || [];
        galleryTotalPages = d.total_pages || 1;
        galleryTotalItems = d.total || 0;
        if (append) galleryPage = targetPage;
        const totalLbl = document.getElementById('gal-total-label');
        if (totalLbl) totalLbl.textContent = `${galleryTotalItems} éléments`;

        if (!append) {
            currentGalleryItems = newItems;
            appendMediaBatchToContainer('gallery-content-area', newItems, 0, true);
        } else {
            const startIdx = currentGalleryItems.length;
            currentGalleryItems.push(...newItems);
            appendMediaBatchToContainer('gallery-content-area', newItems, startIdx, false);
        }
        updateGalleryBatchBar();
        updateGalleryPrevBar();
        requestAnimationFrame(updateActiveTimelineFromScroll);
    } finally {
        galleryIsLoading = false;
        if (spinner) spinner.classList.add('hidden');
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
    const spinner = document.getElementById('gallery-loading-spinner');
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
            appendMediaBatchToContainer('gallery-content-area', currentGalleryItems, 0, true);
            if (sc) {
                const deltaH = sc.scrollHeight - prevH;
                sc.scrollTop = prevTop + Math.max(0, deltaH);
            }
        }
        updateGalleryBatchBar();
        updateGalleryPrevBar();
        requestAnimationFrame(updateActiveTimelineFromScroll);
    } finally {
        galleryIsLoading = false;
        if (spinner) spinner.classList.add('hidden');
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
    const containerId = openedAlbumName ? 'album-single-content-area' : 'gallery-content-area';
    const container = document.getElementById(containerId);
    return (container && container.querySelector(`[data-tile-idx="${idx}"]`)) || document.getElementById(`media-tile-${idx}`);
}

function updateSingleTileSelectionDOM(idx, isSelected) {
    const tile = _getActiveMediaTileEl(idx);
    if (!tile) return;
    if (galleryLayout === 'LIST') {
        tile.classList.toggle('ring-2', isSelected);
    } else {
        tile.classList.toggle('ring-[6px]', isSelected);
    }
    tile.classList.toggle('ring-[#A385A6]', isSelected);
    tile.classList.toggle('dark:ring-[#8B6B8E]', isSelected);
    const btn = tile.querySelector('.tile-select-btn');
    if (btn) btn.innerHTML = getSelectIconHTML(isSelected);
}

function updateSingleTileFavoriteDOM(idx, isFav) {
    const tile = _getActiveMediaTileEl(idx);
    if (!tile) return;
    const btn = tile.querySelector('.tile-fav-btn');
    if (!btn) return;
    btn.classList.toggle('opacity-100', !!isFav);
    btn.classList.toggle('opacity-0', !isFav);
    btn.innerHTML = getFavHeartHTML(!!isFav);
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

function updateGalleryBatchBar() {
    document.getElementById('gal-batch-bar').classList.toggle('hidden', selectedGalleryPaths.size === 0);
    document.getElementById('gal-batch-count').textContent = `${selectedGalleryPaths.size} sélectionné(s)`;
    const remBtn = document.getElementById('btn-batch-album-remove');
    if (remBtn) remBtn.classList.toggle('hidden', !openedAlbumName);
}

async function runGalleryBatch(action) {
    let alb = document.getElementById('batch-album-input').value.trim();
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

// ==================== CASE TIMELINE DROITE (FILTRE AU CLIC ANNÉE / MOIS) ====================

async function loadGalleryTimeline() {
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
    renderTimelineScrubberDOM();
}

let activeScrollTimelineYear = '';
let activeScrollTimelineMonth = '';
let _timelineScrollRaf = null;

function updateActiveTimelineFromScroll() {
    const tabGal = document.getElementById('tab-gallery');
    const scroller = document.getElementById('main-scroll-container');
    const area = document.getElementById('gallery-content-area');
    if (!tabGal || tabGal.classList.contains('hidden') || !scroller || !area) return;

    const scrollerRect = scroller.getBoundingClientRect();
    const probeTop = scrollerRect.top + 80;
    const tiles = area.querySelectorAll('.media-tile[data-ts]');
    let foundTs = 0;

    for (let i = 0; i < tiles.length; i++) {
        const ts = parseInt(tiles[i].getAttribute('data-ts') || '0', 10);
        if (!ts) continue;
        const rect = tiles[i].getBoundingClientRect();
        if (rect.bottom >= probeTop && rect.top <= scrollerRect.bottom) {
            foundTs = ts;
            break;
        }
    }

    if (!foundTs) return;
    const dt = new Date(foundTs * 1000);
    const yr = String(dt.getFullYear());
    const mo = String(dt.getMonth() + 1).padStart(2, '0');

    if (yr !== activeScrollTimelineYear || mo !== activeScrollTimelineMonth) {
        activeScrollTimelineYear = yr;
        activeScrollTimelineMonth = mo;
        renderTimelineScrubberDOM();
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
        });
    }, { passive: true });
});

function renderTimelineScrubberDOM() {
    const scrubber = document.getElementById('gallery-timeline-box');
    const container = document.getElementById('timeline-items-container');
    if (!scrubber || !container) return;

    if (!cachedTimelineData.length) {
        container.innerHTML = `<span class="text-[9px] opacity-40">—</span>`;
        return;
    }

    const selectedYear = document.getElementById('gal-year')?.value || '';
    const selectedMonth = document.getElementById('gal-month')?.value || '';
    const expandedYear = selectedYear || activeScrollTimelineYear || cachedTimelineData[0].year;
    const activeMonth = selectedMonth || (String(expandedYear) === String(activeScrollTimelineYear) ? activeScrollTimelineMonth : '');

    container.innerHTML = cachedTimelineData.map(yObj => {
        const isYearActive = String(yObj.year) === String(expandedYear);
        const isYearFiltered = String(yObj.year) === String(selectedYear);

        const yearBtnClass = isYearFiltered
            ? 'plum-btn px-2.5 py-0.5 rounded-full text-[11px] font-extrabold shadow-sm cursor-pointer transition'
            : (isYearActive
                ? 'nav-item-active px-2.5 py-0.5 rounded-full text-[11px] font-extrabold shadow-sm cursor-pointer transition'
                : 'opacity-55 hover:opacity-100 text-[11px] font-extrabold cursor-pointer py-0.5 transition');

        let monthsHtml = '';
        if (isYearActive && yObj.months && yObj.months.length) {
            monthsHtml = `<div class="flex flex-col items-end space-y-0.5 py-1 w-full">` +
                yObj.months.map(mObj => {
                    const mCode = String(mObj.month).padStart(2, '0');
                    const mNum = parseInt(mObj.month, 10);
                    const mName = SHORT_MONTHS_FR[mNum] || mCode;
                    const isMonthFiltered = isYearFiltered && String(selectedMonth) === mCode;
                    const isMonthVisible = String(activeMonth) === mCode;
                    const mClass = isMonthFiltered
                        ? 'plum-btn pl-2.5 pr-2 py-0.5 rounded-l-full rounded-r-none text-[9px] font-extrabold shadow-sm cursor-pointer transition text-right'
                        : (isMonthVisible
                            ? 'nav-item-active pl-2.5 pr-2 py-0.5 rounded-l-full rounded-r-none text-[9px] font-extrabold shadow-sm cursor-pointer transition text-right'
                            : 'text-[8px] font-bold opacity-55 hover:opacity-100 cursor-pointer py-0.5 pl-1 pr-2 transition text-right');
                    return `<div onclick="event.stopPropagation(); selectTimelineMonth('${yObj.year}', '${mCode}')"
                                 title="${FULL_MONTHS_FR[mNum]} ${yObj.year} (${mObj.count})"
                                 class="${mClass}">${mName}</div>`;
                }).join('') +
            `</div>`;
        }

        return `
            <div ${isYearActive ? 'id="tl-active-year"' : ''} class="w-full flex flex-col items-center">
                <div onclick="event.stopPropagation(); selectTimelineYear('${yObj.year}')"
                     title="${yObj.year} (${yObj.count} médias)"
                     class="${yearBtnClass}">
                    ${yObj.year}
                </div>
                ${monthsHtml}
            </div>
        `;
    }).join('');

    const activeYearEl = document.getElementById('tl-active-year');
    if (activeYearEl && scrubber.scrollHeight > scrubber.clientHeight) {
        activeYearEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}

function _jumpToTimelineOffset(yearStr, monthCode = '') {
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

    // La timeline navigue dans la galerie sans appliquer de filtre année/mois
    const ySel = document.getElementById('gal-year');
    const mSel = document.getElementById('gal-month');
    if (ySel && ySel.value) ySel.value = '';
    if (mSel && mSel.value) mSel.value = '';
    updateActiveFilterBadge();

    activeScrollTimelineYear = String(yearStr);
    activeScrollTimelineMonth = targetMonth || (yObj.months && yObj.months[0] ? String(yObj.months[0].month).padStart(2, '0') : '');
    renderTimelineScrubberDOM();

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

function sortAlbumItems(albums) {
    const sortBy = document.getElementById('alb-sort-by')?.value || 'date';
    const sortOrder = document.getElementById('alb-sort-order')?.value || 'desc';
    const dir = sortOrder === 'asc' ? 1 : -1;
    return [...albums].sort((a, b) => {
        if (sortBy === 'name') {
            return dir * (a.name || '').localeCompare(b.name || '', 'fr', { sensitivity: 'base' });
        }
        if (sortBy === 'modified') {
            const diff = (a.modified_ts || 0) - (b.modified_ts || 0);
            if (diff !== 0) return dir * diff;
            return dir * (a.name || '').localeCompare(b.name || '', 'fr', { sensitivity: 'base' });
        }
        const diff = (a.max_ts || 0) - (b.max_ts || 0);
        if (diff !== 0) return dir * diff;
        return dir * (a.name || '').localeCompare(b.name || '', 'fr', { sensitivity: 'base' });
    });
}

function renderAlbumCardHTML(a) {
    const safeFull = a.full_path.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const safeName = a.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const escName = _escTileText(a.name);
    const coverHtml = a.cover_path
        ? `<img src="/thumb?path=${encodeURIComponent(a.cover_path)}" loading="lazy" class="w-full h-full object-cover group-hover:scale-105 transition"/>`
        : `<div class="w-full h-full flex items-center justify-center opacity-30">
               <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
           </div>`;

    if (albumLayout === 'LIST') {
        const thumbCls = albumSize === 'SM' ? 'w-11 h-11 rounded-xl' : (albumSize === 'LG' ? 'w-24 h-24 rounded-2xl' : 'w-16 h-16 rounded-2xl');
        const padCls = albumSize === 'SM' ? 'p-2 gap-3 rounded-2xl' : (albumSize === 'LG' ? 'p-3.5 gap-4 rounded-3xl' : 'p-2.5 gap-3.5 rounded-2xl');
        const titleCls = albumSize === 'SM' ? 'text-xs' : (albumSize === 'LG' ? 'text-base' : 'text-sm');
        const dateStr = a.max_ts ? new Date(a.max_ts * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
        const modStr = a.modified_ts ? new Date(a.modified_ts * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
        const subText = a.subalbums_count > 0 ? ` • ${a.subalbums_count} sous-album${a.subalbums_count > 1 ? 's' : ''}` : '';
        const metaLine = [`${a.count} élément${a.count > 1 ? 's' : ''}${subText}`, dateStr ? `Date : ${dateStr}` : '', modStr ? `Modifié : ${modStr}` : ''].filter(Boolean).join(' • ');

        return `
            <div onclick="openSingleAlbumView('${safeFull}')"
                 class="ui-card ${padCls} flex items-center cursor-pointer group shadow-sm hover:shadow-md transition">
                <div class="shrink-0 ${thumbCls} overflow-hidden bg-black/5">
                    ${coverHtml}
                </div>
                <div class="flex-1 min-w-0">
                    <div class="font-extrabold truncate ${titleCls}">${escName}</div>
                    <div class="text-[11px] opacity-65 truncate mt-0.5">${metaLine}</div>
                </div>
                <div class="flex items-center gap-1.5 shrink-0 opacity-0 group-hover:opacity-100 transition">
                    <button type="button" onclick="event.stopPropagation(); renameAlbumById(${a.album_id}, '${safeName}')" title="Renommer"
                            class="w-7 h-7 rounded-full bg-white/90 text-zinc-800 flex items-center justify-center text-xs font-bold shadow hover:scale-110 transition">✎</button>
                    <button type="button" onclick="event.stopPropagation(); deleteAlbumById(${a.album_id}, '${safeName}')" title="Supprimer l'album"
                            class="w-7 h-7 rounded-full bg-rose-600/90 text-white flex items-center justify-center text-xs font-bold shadow hover:scale-110 transition">✕</button>
                </div>
            </div>
        `;
    }

    const subBadge = a.subalbums_count > 0
        ? `<span class="absolute top-2 left-2 bg-black/60 backdrop-blur-sm text-white text-[10px] font-bold px-2 py-0.5 rounded-full">${a.subalbums_count} sous-album${a.subalbums_count > 1 ? 's' : ''}</span>`
        : '';

    return `
        <div onclick="openSingleAlbumView('${safeFull}')"
             class="ui-card rounded-3xl overflow-hidden cursor-pointer group shadow-sm hover:shadow-md transition flex flex-col relative">
            <div class="aspect-square overflow-hidden bg-black/5 relative">
                ${coverHtml}
                ${subBadge}
                <div class="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition z-10">
                    <button type="button" onclick="event.stopPropagation(); renameAlbumById(${a.album_id}, '${safeName}')" title="Renommer"
                            class="w-7 h-7 rounded-full bg-white/90 text-zinc-800 flex items-center justify-center text-xs font-bold shadow hover:scale-110 transition">✎</button>
                    <button type="button" onclick="event.stopPropagation(); deleteAlbumById(${a.album_id}, '${safeName}')" title="Supprimer l'album"
                            class="w-7 h-7 rounded-full bg-rose-600/90 text-white flex items-center justify-center text-xs font-bold shadow hover:scale-110 transition">✕</button>
                </div>
            </div>
            <div class="p-3 text-center">
                <div class="text-xs font-extrabold truncate">${escName}</div>
                <div class="text-[10px] opacity-60 font-semibold">${a.count} élément${a.count > 1 ? 's' : ''}</div>
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

    if (!rootAlbumsCache || rootAlbumsCache.length === 0) {
        grid.className = getAlbumGridClass();
        grid.innerHTML = `<div class="col-span-full ui-card rounded-3xl p-8 text-center text-sm font-semibold opacity-60">Aucun album pour le moment. Cliquez sur "+ Nouveau" pour en créer un.</div>`;
        return;
    }

    const filtered = _filterAlbumsList(rootAlbumsCache);
    const sorted = sortAlbumItems(filtered);
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
        <section class="space-y-3">
            <div class="flex items-center justify-between">
                <h3 class="text-sm font-extrabold tracking-tight">${g.label}</h3>
                <span class="text-[11px] font-bold opacity-55">${g.items.length} album${g.items.length > 1 ? 's' : ''}</span>
            </div>
            <div class="${innerGridCls}">
                ${g.items.map(renderAlbumCardHTML).join('')}
            </div>
        </section>
    `).join('');
}

async function loadAlbumsView() {
    const res = await fetch('/api/albums/list');
    const d = await res.json();
    rootAlbumsCache = d.albums || [];
    allAlbumsCache = d.all_albums || [];
    populateAlbumYearFilterOptions();
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
        const newItems = d.items || [];
        singleAlbumPage = d.page || targetPage;
        singleAlbumTotalPages = d.total_pages || 1;
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
            if (entry.target.id === 'gallery-scroll-sentinel' && (currentTab === 'gallery' || currentTab === 'favorites')) {
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
    const albSentinel = document.getElementById('album-scroll-sentinel');
    if (galSentinel) infiniteScrollObserver.observe(galSentinel);
    if (albSentinel) infiniteScrollObserver.observe(albSentinel);
}

window.addEventListener('DOMContentLoaded', initInfiniteScrollObserver);

// ==================== CORBEILLE ====================

async function loadTrashTab() {
    const res = await fetch('/api/trash/items');
    const d = await res.json();
    document.getElementById('trash-summary-label').textContent = `${d.items.length} éléments (${d.total_mb} Mo)`;
    document.getElementById('trash-grid').innerHTML = (d.items||[]).map(it => {
        const enc = encodeURIComponent(it.source_path);
        const daysLabel = it.days_left !== null ? `${it.days_left} jours` : 'Manuel';
        return `
        <div class="ui-card rounded-3xl overflow-hidden shadow-sm group relative flex flex-col">
            <div class="aspect-square overflow-hidden relative">
                <img src="/thumb?path=${encodeURIComponent(it.dest_path)}" loading="lazy" class="w-full h-full object-cover"/>
                <div class="opacity-0 group-hover:opacity-100 absolute inset-0 bg-black/50 flex items-center justify-center gap-2 transition">
                    <button onclick="restoreTrash('${enc}')" class="plum-btn text-xs font-bold px-3 py-1.5 rounded-full">Restaurer</button>
                    <button onclick="deletePermTrash('${enc}')" class="bg-rose-600 text-white text-xs font-bold px-3 py-1.5 rounded-full">✕</button>
                </div>
            </div>
            <div class="py-2 text-center text-xs font-extrabold">${daysLabel}</div>
        </div>`;
    }).join('');
}

async function restoreTrash(enc) { await fetch('/api/trash/action', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({source_paths:[decodeURIComponent(enc)], action:'RESTORE'})}); loadTrashTab(); loadStats(); }
async function deletePermTrash(enc) { await fetch('/api/trash/action', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({source_paths:[decodeURIComponent(enc)], action:'DELETE_PERMANENTLY'})}); loadTrashTab(); loadStats(); }
async function emptyAllTrash() { if(confirm("Vider définitivement la corbeille ?")) { await fetch('/api/trash/empty_all', {method:'POST'}); loadTrashTab(); loadStats(); } }

// ==================== CATÉGORIES / TYPES ====================

let _openedCategoryId = null;

function toggleFormatsPanel(forceState) {
    const panel = document.getElementById('types-formats-panel');
    const btn = document.getElementById('type-pill-FORMATS');
    if (!panel) return;
    const willShow = typeof forceState === 'boolean' ? forceState : panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !willShow);
    if (btn) btn.classList.toggle('nav-item-active', willShow);
}

async function loadTypesSummary() {
    closeSingleCategoryView();
    const [resTypes, resCats] = await Promise.all([
        fetch('/api/types/summary'),
        fetch('/api/categories/list')
    ]);
    const d = await resTypes.json();
    const catsData = await resCats.json();
    const c = d.categories || {};

    const pills = [
        {
            id: 'PHOTOS',
            title: 'Photos',
            count: (c.PHOTOS?.count || 0),
            onclick: "filterGalleryByType('PHOTOS')",
            icon: `<svg class="w-4 h-4 shrink-0 opacity-80" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`
        },
        {
            id: 'VIDEOS',
            title: 'Vidéos',
            count: (c.VIDEOS?.count || 0),
            onclick: "filterGalleryByType('VIDEOS')",
            icon: `<svg class="w-4 h-4 shrink-0 opacity-80" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 4v16M17 4v16M2 12h20"/></svg>`
        },
        {
            id: 'ANIMATED',
            title: 'Images animées',
            count: (c.ANIMATED?.count || 0),
            onclick: "filterGalleryByType('ANIMATED')",
            icon: `<svg class="w-4 h-4 shrink-0 opacity-80" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2"/></svg>`
        },
        {
            id: 'FORMATS',
            title: 'Formats',
            count: (d.extensions || []).length,
            onclick: "toggleFormatsPanel()",
            icon: `<svg class="w-4 h-4 shrink-0 opacity-80" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`
        }
    ];

    document.getElementById('types-cards-grid').innerHTML = pills.map(k => `
        <button id="type-pill-${k.id}" type="button" onclick="${k.onclick}"
                class="ui-card rounded-2xl px-5 py-3 cursor-pointer hover:scale-[1.02] transition shadow-sm flex items-center gap-2.5 text-xs font-extrabold">
            ${k.icon}
            <span>${k.title}</span>
            <span class="ui-pill px-2 py-0.5 rounded-full text-[10px] font-bold opacity-75">${k.count}</span>
        </button>
    `).join('');

    document.getElementById('types-ext-grid').innerHTML = (d.extensions || []).map(e => `
        <div onclick="filterGalleryByExt('${e.ext}')" class="ui-pill rounded-2xl p-3 cursor-pointer flex justify-between items-center font-bold text-xs hover:opacity-85 transition">
            <span class="font-mono">${e.ext}</span>
            <span class="opacity-70">${e.count}</span>
        </div>
    `).join('');

    renderSmartCategoriesGrid(catsData.categories || []);
}

function renderSmartCategoriesGrid(categories) {
    const grid = document.getElementById('smart-categories-grid');
    if (!grid) return;
    if (!categories.length) {
        grid.innerHTML = `<div class="col-span-full ui-card rounded-3xl p-8 text-center text-sm font-semibold opacity-60">Aucune catégorie. Cliquez sur "+ Ajouter" pour en créer une.</div>`;
        return;
    }
    grid.innerHTML = categories.map(cat => {
        const coverHtml = cat.cover_path
            ? `<img src="/thumb?path=${encodeURIComponent(cat.cover_path)}" loading="lazy" class="w-full h-full object-cover group-hover:scale-105 transition"/>`
            : `<div class="w-full h-full flex items-center justify-center opacity-20">
                   <svg class="w-10 h-10" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
               </div>`;
        const escName = _escTileText(cat.name);
        return `
            <div onclick="openSingleCategoryView(${cat.category_id})"
                 class="ui-card rounded-3xl overflow-hidden cursor-pointer group shadow-sm hover:shadow-md transition flex flex-col relative">
                <div class="aspect-square overflow-hidden bg-black/5 relative">
                    ${coverHtml}
                    <button type="button" onclick="event.stopPropagation(); deleteSmartCategoryById(${cat.category_id}, '${escName.replace(/'/g, "\\'")}')" title="Supprimer"
                            class="absolute top-2 right-2 w-7 h-7 rounded-full bg-rose-600/90 text-white flex items-center justify-center text-xs font-bold shadow opacity-0 group-hover:opacity-100 hover:scale-110 transition z-10">✕</button>
                </div>
                <div class="p-3 text-center">
                    <div class="text-sm font-extrabold truncate">${escName}</div>
                    <div class="text-[10px] opacity-60 font-semibold">${cat.count} élément${cat.count > 1 ? 's' : ''}</div>
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
            btn.textContent = 'Analyser';
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
        grid.innerHTML = `<div class="col-span-full ui-card rounded-3xl p-8 text-center text-sm font-semibold opacity-60">Aucun média dans cette catégorie pour le moment.</div>`;
        return;
    }
    grid.innerHTML = items.map(it => {
        const sEnc = encodeURIComponent(it.source_path || it.dest_path);
        const dEnc = encodeURIComponent(it.dest_path);
        return `
            <div onclick="openLightboxForCustomItem('${sEnc}', '${dEnc}', ${it.timestamp || 0})"
                 class="ui-card rounded-2xl overflow-hidden cursor-pointer group shadow-sm relative">
                <div class="aspect-square overflow-hidden bg-black/5">
                    ${renderMediaPreview(it.dest_path, 'w-full h-full object-cover group-hover:scale-105 transition')}
                </div>
            </div>
        `;
    }).join('');
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

function openEditorFromTools(kind) {
    if (currentGalleryItems.length > 0) {
        const match = currentGalleryItems.find(it => kind === 'VIDEO' ? isVideoFile(it.dest_path) : !isVideoFile(it.dest_path)) || currentGalleryItems[0];
        openStudioModal(encodeURIComponent(match.source_path), encodeURIComponent(match.dest_path));
    } else {
        switchTab('gallery');
    }
}

// ==================== VISIONNEUSE PLEIN ÉCRAN (LIGHTBOX) ====================

let lbMiniMap = null;
let lbMiniMarker = null;

async function openLightbox(idx) {
    if (idx < 0 || idx >= currentGalleryItems.length) return;
    currentLightboxIndex = idx;
    const item = currentGalleryItems[idx];
    const url = `/media?path=${encodeURIComponent(item.dest_path)}`;
    const isVid = isVideoFile(item.dest_path);

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

    updateLightboxFavButton(item.is_favorite);
    document.getElementById('lightbox-modal').classList.remove('hidden');

    if (idx >= currentGalleryItems.length - 5) {
        if (currentTab === 'albums' && openedAlbumName) loadSingleAlbumItems(true);
        else loadGalleryItems(true);
    }

    if (!document.getElementById('lb-info-drawer').classList.contains('hidden')) {
        await loadLightboxMetadataInfo();
    }
}

function openLightboxForCustomItem(encSrc, encDest, ts = 0, isFav = 0) {
    currentGalleryItems = [{
        source_path: decodeURIComponent(encSrc),
        dest_path: decodeURIComponent(encDest),
        timestamp: ts,
        is_favorite: isFav,
        detected_people: ''
    }];
    openLightbox(0);
}

function closeLightbox() {
    const vidEl = document.getElementById('lb-video');
    if (vidEl) vidEl.pause();
    document.getElementById('lightbox-modal').classList.add('hidden');
}

function navigateLightbox(delta) {
    const nextIdx = currentLightboxIndex + delta;
    if (nextIdx >= 0 && nextIdx < currentGalleryItems.length) openLightbox(nextIdx);
}

window.addEventListener('keydown', e => {
    const lbOpen = !document.getElementById('lightbox-modal').classList.contains('hidden');
    if (!lbOpen) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') navigateLightbox(-1);
    if (e.key === 'ArrowRight') navigateLightbox(1);
});

function updateLightboxFavButton(isFav) {
    const icon = document.getElementById('lb-fav-icon');
    const btn = document.getElementById('lb-btn-fav');
    if (!icon || !btn) return;
    if (isFav) {
        icon.setAttribute('fill', '#A385A6');
        icon.setAttribute('stroke', '#A385A6');
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
    const item = currentGalleryItems[currentLightboxIndex];
    if (!item) return;
    await openAlbumPickerModal([item.source_path], item.album_name || '', async (albumName) => {
        item.album_name = albumName;
        await loadGalleryFilters();
        if (!document.getElementById('lb-info-drawer').classList.contains('hidden')) {
            await loadLightboxMetadataInfo();
        }
    });
}

async function lightboxShareMedia() {
    const item = currentGalleryItems[currentLightboxIndex];
    if (!item) return;
    const fullUrl = `${window.location.origin}/media?path=${encodeURIComponent(item.dest_path)}`;
    const fileName = item.dest_path.split(/[\\/]/).pop();
    if (navigator.share) {
        try {
            await navigator.share({ title: fileName, url: fullUrl });
            return;
        } catch (e) {}
    }
    try {
        await navigator.clipboard.writeText(item.dest_path.replace(/\\/g, '/'));
        alert(`Chemin copié dans le presse-papiers :\n${item.dest_path.replace(/\\/g, '/')}`);
    } catch (e) {}
}

function lightboxDownloadMedia() {
    const item = currentGalleryItems[currentLightboxIndex];
    if (!item) return;
    const a = document.createElement('a');
    a.href = `/media?path=${encodeURIComponent(item.dest_path)}`;
    a.download = item.dest_path.split(/[\\/]/).pop() || 'media';
    document.body.appendChild(a);
    a.click();
    a.remove();
}

async function lightboxDeleteMedia() {
    const item = currentGalleryItems[currentLightboxIndex];
    if (!item) return;
    await fetch('/api/trash/action', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({source_paths: [item.source_path], action: 'MOVE_TO_TRASH'})
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

async function toggleLightboxInfoDrawer() {
    const dr = document.getElementById('lb-info-drawer');
    dr.classList.toggle('hidden');
    if (!dr.classList.contains('hidden')) {
        await loadLightboxMetadataInfo();
    }
}

async function loadLightboxMetadataInfo() {
    const item = currentGalleryItems[currentLightboxIndex];
    if (!item) return;
    const res = await fetch(`/api/metadata/inspect?source_path=${encodeURIComponent(item.source_path)}`);
    if (!res.ok) return;
    const d = await res.json();

    const fname = (d.dest_path || '').split(/[\\/]/).pop() || 'Média';
    document.getElementById('lb-info-filename').textContent = fname;

    // Dimensions & Mégapixels
    if (d.width && d.height) {
        const mpx = Math.max(1, Math.round((d.width * d.height) / 1000000));
        document.getElementById('lb-info-dims').textContent = `${mpx} Mpx ${d.width} x ${d.height}`;
    } else {
        document.getElementById('lb-info-dims').textContent = 'Dimensions standard';
    }

    // Jour, Heure et Date complète
    if (d.timestamp && d.timestamp > 0) {
        const dt = new Date(d.timestamp * 1000);
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

    // Taille en Mo avec virgule française
    const mb = d.file_size ? (d.file_size / (1024 * 1024)).toFixed(2).replace('.', ',') + ' Mo' : '0,00 Mo';
    document.getElementById('lb-info-size').textContent = mb;

    // Carte Album
    if (d.album_name) {
        document.getElementById('lb-info-album-name').textContent = d.album_name;
        document.getElementById('lb-info-album-count').textContent = `${d.album_count || 1} éléments`;
    } else {
        document.getElementById('lb-info-album-name').textContent = 'Aucun album';
        document.getElementById('lb-info-album-count').textContent = 'Cliquer pour ajouter';
    }

    // Carte Personnes (Visages détectés + bouton œil "À identifier")
    const facesHtml = (d.faces || []).map(f => `
        <div onclick="if(${f.person_id || 0}) { closeLightbox(); switchTab('faces'); openTimeline(${f.person_id}); }"
             class="flex flex-col items-center cursor-pointer group">
            <img src="/media?path=${encodeURIComponent(f.thumb_path || '')}"
                 class="w-11 h-11 rounded-full object-cover bg-black/20 shadow-sm group-hover:scale-105 transition"/>
            <span class="text-[9px] font-extrabold mt-1 max-w-[52px] truncate">${f.name}</span>
        </div>
    `).join('');

    const addFaceBtn = `
        <div onclick="lightboxOpenFaceTagger()" class="flex flex-col items-center cursor-pointer group">
            <div class="w-11 h-11 rounded-full border border-black/25 flex items-center justify-center text-black/50 group-hover:text-black group-hover:border-black transition">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                </svg>
            </div>
            <span class="text-[9px] font-extrabold mt-1 opacity-75">A Identifié</span>
        </div>
    `;
    document.getElementById('lb-info-faces-list').innerHTML = facesHtml + addFaceBtn;

    // Carte Lieu & Mini-Carte Leaflet
    const mapBox = document.getElementById('lb-mini-map');
    if (d.latitude && d.longitude && (d.latitude !== 0 || d.longitude !== 0)) {
        document.getElementById('lb-info-place-title').textContent = `${Number(d.latitude).toFixed(3)}, ${Number(d.longitude).toFixed(3)}`;
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
        document.getElementById('lb-info-place-title').textContent = 'Lieu non défini';
        if (lbMiniMap) {
            lbMiniMap.remove();
            lbMiniMap = null;
        }
        mapBox.innerHTML = `<span onclick="lightboxOpenMetadataEditor()" class="cursor-pointer hover:underline">+ Ajouter un lieu</span>`;
    }

    // Carte Note
    document.getElementById('lb-info-note').textContent = d.description || 'Ajouter une note...';

    // Pilule du chemin complet en bas
    const cleanPath = (d.dest_path || '').replace(/\\/g, '/');
    const pathPill = document.getElementById('lb-info-path-pill');
    pathPill.textContent = cleanPath;
    pathPill.title = cleanPath;
}