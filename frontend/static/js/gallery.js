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

let galleryLayout = 'GRID';    // 'GRID' | 'MASONRY'
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

function setGalleryLayout(layout) {
    galleryLayout = layout;
    ['GRID', 'MASONRY'].forEach(l => {
        const b = document.getElementById(`layout-btn-${l}`);
        if (b) {
            b.classList.toggle('nav-item-active', l === layout);
            b.classList.toggle('ui-pill', l !== layout);
        }
    });
    refreshActiveMediaView();
}

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

function renderSingleMediaTile(it, idx, isMasonry = false) {
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
                onclick="event.stopPropagation(); handleGalleryTileSelect(event, ${idx}, '${srcEnc}')"
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

    if (isMasonry) {
        const aspectStyle = (it.width && it.height) ? `aspect-ratio: ${it.width} / ${it.height};` : '';
        return `
        <div id="media-tile-${idx}" data-source="${srcEnc}" onclick="openLightbox(${idx})" style="${aspectStyle}"
             class="media-tile masonry-item ui-card group relative w-full rounded-[24px] overflow-hidden cursor-pointer shadow-sm transition-all duration-150 ${borderClass}">
            <img src="${thumbUrl}" loading="lazy" decoding="async" class="w-full h-auto block group-hover:scale-[1.02] transition duration-300 select-none pointer-events-none"/>
            ${selectBtn}
            ${favBtn}
            ${videoBadge}
        </div>`;
    }

    return `
    <div id="media-tile-${idx}" data-source="${srcEnc}" onclick="openLightbox(${idx})"
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

    const isMasonry = (galleryLayout === 'MASONRY');
    const gridClass = isMasonry
        ? 'group-grid masonry-grid'
        : 'group-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4';

    if (galleryGroupBy === 'NONE') {
        let grid = container.querySelector('.group-grid');
        if (!grid) {
            container.innerHTML = `<div class="${gridClass}"></div>`;
            grid = container.querySelector('.group-grid');
        }
        const html = newItems.map((it, i) => renderSingleMediaTile(it, startIndex + i, isMasonry)).join('');
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
                        ${renderSingleMediaTile(it, globalIdx, isMasonry)}
                    </div>
                </div>`;
            container.insertAdjacentHTML('beforeend', sectionHtml);
        } else {
            const grids = container.querySelectorAll('.group-grid');
            const lastGrid = grids[grids.length - 1];
            if (lastGrid) {
                lastGrid.insertAdjacentHTML('beforeend', renderSingleMediaTile(it, globalIdx, isMasonry));
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
    const extSel = document.getElementById('gal-ext-select');
    if (extSel) {
        const curExt = extSel.value;
        extSel.innerHTML = `<option value="">Type</option>` + (d.extensions||[]).map(e => `<option value="${e}">${e}</option>`).join('');
        extSel.value = curExt;
    }
    if (typeof updateGalleryMonthDropdown === 'function') updateGalleryMonthDropdown();
}

function updateActiveFilterBadge() {
    const y = document.getElementById('gal-year')?.value || '';
    const m = document.getElementById('gal-month')?.value || '';
    const t = document.getElementById('gal-type-filter')?.value || '';
    const badge = document.getElementById('gallery-active-filter-badge');
    const txt = document.getElementById('gallery-active-filter-text');
    if (!badge || !txt) return;

    const parts = [];
    if (m) parts.push(SHORT_MONTHS_FR[parseInt(m, 10)] || m);
    if (y) parts.push(y);
    if (t) parts.push(t);
    if (currentExtFilter) parts.push(currentExtFilter);

    if (parts.length > 0) {
        txt.textContent = parts.join(' ');
        badge.classList.remove('hidden');
        badge.classList.add('inline-flex');
    } else {
        badge.classList.add('hidden');
        badge.classList.remove('inline-flex');
    }
}

function onGalleryYearOrMonthSelectChange() {
    updateActiveFilterBadge();
    renderTimelineScrubberDOM();
    loadGalleryItems(false);
}

function resetAllGalleryFilters() {
    const yEl = document.getElementById('gal-year');
    const mEl = document.getElementById('gal-month');
    const tEl = document.getElementById('gal-type-filter');
    const eEl = document.getElementById('gal-ext-select');
    const aEl = document.getElementById('gal-album');
    if (yEl) yEl.value = '';
    if (mEl) mEl.value = '';
    if (tEl) tEl.value = '';
    if (eEl) eEl.value = '';
    if (aEl) aEl.value = '';
    currentExtFilter = '';
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

    try {
        const p = new URLSearchParams({
            year: document.getElementById('gal-year')?.value || '',
            month: document.getElementById('gal-month')?.value || '',
            album: document.getElementById('gal-album')?.value || '',
            media_type: document.getElementById('gal-type-filter')?.value || '',
            ext_filter: currentExtFilter || '',
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
    } finally {
        galleryIsLoading = false;
        if (spinner) spinner.classList.add('hidden');
    }
}

function updateSingleTileSelectionDOM(idx, isSelected) {
    const tile = document.getElementById(`media-tile-${idx}`);
    if (!tile) return;
    tile.classList.toggle('ring-[6px]', isSelected);
    tile.classList.toggle('ring-[#A385A6]', isSelected);
    tile.classList.toggle('dark:ring-[#8B6B8E]', isSelected);
    const btn = tile.querySelector('.tile-select-btn');
    if (btn) btn.innerHTML = getSelectIconHTML(isSelected);
}

function updateSingleTileFavoriteDOM(idx, isFav) {
    const tile = document.getElementById(`media-tile-${idx}`);
    if (!tile) return;
    const btn = tile.querySelector('.tile-fav-btn');
    if (!btn) return;
    btn.classList.toggle('opacity-100', !!isFav);
    btn.classList.toggle('opacity-0', !isFav);
    btn.innerHTML = getFavHeartHTML(!!isFav);
}

function handleGalleryTileSelect(e, idx, encSrc) {
    const src = decodeURIComponent(encSrc);
    const willSelect = !selectedGalleryPaths.has(src);
    if (e.shiftKey && lastClickedGalleryIdx !== null) {
        const s = Math.min(lastClickedGalleryIdx, idx), end = Math.max(lastClickedGalleryIdx, idx);
        for (let i = s; i <= end; i++) {
            const p = currentGalleryItems[i].source_path;
            if (willSelect) selectedGalleryPaths.add(p);
            else selectedGalleryPaths.delete(p);
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
}

async function runGalleryBatch(action) {
    const alb = document.getElementById('batch-album-input').value.trim();
    await fetch('/api/gallery/batch_action', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({source_paths: Array.from(selectedGalleryPaths), action, album_name: alb})
    });
    selectedGalleryPaths.clear();
    loadGalleryFilters(); refreshActiveMediaView(); loadStats();
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
        media_type: document.getElementById('gal-type-filter')?.value || '',
        ext_filter: currentExtFilter || '',
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
    const expandedYear = selectedYear || cachedTimelineData[0].year;

    container.innerHTML = cachedTimelineData.map(yObj => {
        const isYearActive = String(yObj.year) === String(expandedYear);
        const isYearFiltered = String(yObj.year) === String(selectedYear);

        const yearBtnClass = (isYearActive || isYearFiltered)
            ? 'ui-pill px-2.5 py-0.5 rounded-full text-[11px] font-extrabold shadow-sm cursor-pointer transition'
            : 'opacity-65 hover:opacity-100 text-[11px] font-extrabold cursor-pointer py-0.5 transition';

        let monthsHtml = '';
        if (isYearActive && yObj.months && yObj.months.length) {
            monthsHtml = `<div class="flex flex-col items-center space-y-0.5 py-1 w-full">` +
                yObj.months.map(mObj => {
                    const mCode = String(mObj.month).padStart(2, '0');
                    const mNum = parseInt(mObj.month, 10);
                    const mName = SHORT_MONTHS_FR[mNum] || mCode;
                    const isMonthFiltered = isYearFiltered && String(selectedMonth) === mCode;
                    const mClass = isMonthFiltered
                        ? 'ui-pill px-2 py-0.5 rounded-full text-[9px] font-extrabold cursor-pointer transition'
                        : 'text-[8px] font-bold opacity-55 hover:opacity-100 cursor-pointer transition';
                    return `<div onclick="event.stopPropagation(); selectTimelineMonth('${yObj.year}', '${mCode}')"
                                 title="${FULL_MONTHS_FR[mNum]} ${yObj.year} (${mObj.count})"
                                 class="${mClass}">${mName}</div>`;
                }).join('') +
            `</div>`;
        }

        return `
            <div class="w-full flex flex-col items-center">
                <div onclick="event.stopPropagation(); selectTimelineYear('${yObj.year}')"
                     title="${yObj.year} (${yObj.count} médias)"
                     class="${yearBtnClass}">
                    ${yObj.year}
                </div>
                ${monthsHtml}
            </div>
        `;
    }).join('');
}

function selectTimelineYear(yearStr) {
    const ySel = document.getElementById('gal-year');
    const mSel = document.getElementById('gal-month');
    if (!ySel) return;

    if (ySel.value === String(yearStr) && (!mSel || !mSel.value)) {
        // Re-cliquer sur l'année active retire le filtre d'année
        ySel.value = '';
    } else {
        ySel.value = String(yearStr);
        if (mSel) mSel.value = '';
    }
    updateActiveFilterBadge();
    renderTimelineScrubberDOM();
    loadGalleryItems(false);
}

function selectTimelineMonth(yearStr, monthCode) {
    const ySel = document.getElementById('gal-year');
    const mSel = document.getElementById('gal-month');
    if (!ySel || !mSel) return;

    if (ySel.value === String(yearStr) && mSel.value === String(monthCode)) {
        // Re-cliquer sur le mois actif revient à l'année entière
        mSel.value = '';
    } else {
        ySel.value = String(yearStr);
        mSel.value = String(monthCode);
    }
    updateActiveFilterBadge();
    renderTimelineScrubberDOM();
    loadGalleryItems(false);
}

// ==================== VUE ALBUMS AVEC DÉFILEMENT INFINI ====================

async function loadAlbumsView() {
    const res = await fetch('/api/albums/list');
    const d = await res.json();
    const grid = document.getElementById('albums-grid');
    if (!d.albums || d.albums.length === 0) {
        grid.innerHTML = `<div class="col-span-full ui-card rounded-3xl p-8 text-center text-sm font-semibold opacity-60">Aucun album pour le moment.</div>`;
        return;
    }
    grid.innerHTML = d.albums.map(a => `
        <div onclick="openSingleAlbumView('${a.album_name.replace(/'/g, "\\'")}')"
             class="ui-card rounded-3xl overflow-hidden cursor-pointer group shadow-sm hover:shadow-md transition flex flex-col">
            <div class="aspect-square overflow-hidden bg-black/5">
                <img src="/thumb?path=${encodeURIComponent(a.cover_path)}" loading="lazy" class="w-full h-full object-cover group-hover:scale-105 transition"/>
            </div>
            <div class="p-3 text-center">
                <div class="text-xs font-extrabold truncate">${a.album_name}</div>
                <div class="text-[10px] opacity-60 font-semibold">${a.count} éléments</div>
            </div>
        </div>
    `).join('');
}

function promptCreateNewAlbum() {
    const name = prompt("Nom du nouvel album (cochez ensuite des photos dans la Galerie pour les y ajouter) :");
    if (!name) return;
    document.getElementById('batch-album-input').value = name;
    switchTab('gallery');
}

function openSingleAlbumView(albumName) {
    openedAlbumName = albumName;
    singleAlbumPage = 1;
    singleAlbumTotalPages = 1;
    currentGalleryItems = [];
    selectedGalleryPaths.clear();
    updateGalleryBatchBar();
    document.getElementById('albums-overview-panel').classList.add('hidden');
    document.getElementById('album-single-panel').classList.remove('hidden');
    document.getElementById('single-album-title').textContent = albumName;
    loadSingleAlbumItems(false);
}

function closeSingleAlbumView() {
    openedAlbumName = null;
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

async function loadTypesSummary() {
    const res = await fetch('/api/types/summary');
    const d = await res.json();
    const c = d.categories;
    const cards = [
        {id: 'PHOTOS', icon: '📷', title: 'Photos Standard', count: c.PHOTOS.count, gb: c.PHOTOS.gb},
        {id: 'VIDEOS', icon: '🎬', title: 'Vidéos', count: c.VIDEOS.count, gb: c.VIDEOS.gb},
        {id: 'RAW', icon: '🎞️', title: 'Fichiers RAW', count: c.RAW.count, gb: c.RAW.gb},
        {id: 'SCREENSHOTS', icon: '📱', title: "Captures d'écran", count: c.SCREENSHOTS.count, gb: c.SCREENSHOTS.gb}
    ];
    document.getElementById('types-cards-grid').innerHTML = cards.map(k => `
        <div onclick="filterGalleryByType('${k.id}')" class="ui-card rounded-3xl p-5 cursor-pointer hover:scale-[1.02] transition shadow-sm">
            <div class="text-2xl mb-1">${k.icon}</div>
            <div class="text-sm font-extrabold">${k.title}</div>
            <div class="text-xl font-black mt-1">${k.count} fichiers</div>
            <div class="text-xs opacity-60 font-bold">${k.gb} Go</div>
        </div>
    `).join('');

    document.getElementById('types-ext-grid').innerHTML = (d.extensions || []).map(e => `
        <div onclick="filterGalleryByExt('${e.ext}')" class="ui-pill rounded-2xl p-3 cursor-pointer flex justify-between items-center font-bold text-xs">
            <span class="font-mono">${e.ext}</span>
            <span class="opacity-70">${e.count}</span>
        </div>
    `).join('');
}

function filterGalleryByType(typeCode) {
    document.getElementById('gal-type-filter').value = typeCode;
    currentExtFilter = '';
    switchTab('gallery');
}

function filterGalleryByExt(ext) {
    document.getElementById('gal-type-filter').value = '';
    currentExtFilter = ext;
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

async function lightboxAddToAlbum() {
    const item = currentGalleryItems[currentLightboxIndex];
    if (!item) return;
    const currentAlb = item.album_name || '';
    const alb = prompt("Nom de l'album auquel ajouter ce média :", currentAlb);
    if (alb === null || !alb.trim()) return;
    await fetch('/api/gallery/batch_action', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            source_paths: [item.source_path],
            action: 'ALBUM_ADD',
            album_name: alb.trim()
        })
    });
    item.album_name = alb.trim();
    await loadGalleryFilters();
    if (!document.getElementById('lb-info-drawer').classList.contains('hidden')) {
        await loadLightboxMetadataInfo();
    }
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