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
let isScrubbingTimeline = false;

let galleryLayout = 'GRID';    // 'GRID' | 'MASONRY'
let galleryGroupBy = 'NONE';   // 'NONE' | 'DAY' | 'WEEK' | 'MONTH' | 'YEAR'

const SHORT_MONTHS_FR = ["", "Jan", "Fév", "Mar", "Avr", "Mai", "Juin", "Juil", "Août", "Sep", "Oct", "Nov", "Déc"];
const FULL_MONTHS_FR = ["", "Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];

const FAV_HEART_SVG = `<svg class="w-5 h-5" fill="currentColor" stroke="#b91c1c" stroke-width="1.5" viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21.3l7.8-7.8 1-1.1a5.5 5.5 0 0 0 0-7.8z"/></svg>`;

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

    const favBadge = `<span class="tile-fav-badge ${it.is_favorite ? '' : 'hidden'} absolute top-2.5 right-2.5 text-rose-600 drop-shadow pointer-events-none">${FAV_HEART_SVG}</span>`;

    const videoBadge = isVid
        ? `<div class="absolute bottom-2.5 right-2.5 bg-black/55 backdrop-blur-sm text-white text-[11px] font-extrabold px-2 py-0.5 rounded-full flex items-center gap-1 pointer-events-none">
             <span>${durText}</span>
             <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.4" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
           </div>`
        : '';

    if (isMasonry) {
        const aspectStyle = (it.width && it.height) ? `aspect-ratio: ${it.width} / ${it.height};` : '';
        return `
        <div id="media-tile-${idx}" data-source="${srcEnc}" onclick="openLightbox(${idx})" style="${aspectStyle}"
             class="media-tile masonry-item ui-card group relative w-full rounded-2xl overflow-hidden cursor-pointer shadow-sm ${isSel ? 'ring-4 ring-[#593E5A]' : ''}">
            <img src="${thumbUrl}" loading="lazy" decoding="async" class="w-full h-auto block group-hover:scale-[1.03] transition duration-300"/>
            <input type="checkbox" ${isSel ? 'checked' : ''}
                   onclick="event.stopPropagation(); handleGalleryCheckboxClick(event, ${idx}, '${srcEnc}')"
                   class="tile-checkbox ${isSel ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} absolute top-2.5 left-2.5 w-4 h-4 cursor-pointer z-10 transition"/>
            ${favBadge}
            ${videoBadge}
        </div>`;
    }

    return `
    <div id="media-tile-${idx}" data-source="${srcEnc}" onclick="openLightbox(${idx})"
         class="media-tile ui-card group relative aspect-square rounded-2xl overflow-hidden cursor-pointer shadow-sm ${isSel ? 'ring-4 ring-[#593E5A]' : ''}">
        <img src="${thumbUrl}" loading="lazy" decoding="async" class="w-full h-full object-cover group-hover:scale-105 transition duration-300"/>
        <input type="checkbox" ${isSel ? 'checked' : ''}
               onclick="event.stopPropagation(); handleGalleryCheckboxClick(event, ${idx}, '${srcEnc}')"
               class="tile-checkbox ${isSel ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} absolute top-2.5 left-2.5 w-4 h-4 cursor-pointer z-10 transition"/>
        ${favBadge}
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
    document.getElementById('gal-year').innerHTML = `<option value="">Années</option>` + (d.years||[]).map(y => `<option value="${y.year}">${y.year} (${y.count})</option>`).join('');
    document.getElementById('gal-album').innerHTML = `<option value="">Tous les albums</option>` + (d.albums||[]).map(a => `<option value="${a}">${a}</option>`).join('');
    const extSel = document.getElementById('gal-ext-select');
    if (extSel) {
        extSel.innerHTML = `<option value="">Type</option>` + (d.extensions||[]).map(e => `<option value="${e}">${e}</option>`).join('');
    }
    updateGalleryMonthDropdown();
}

function resetAndLoadGallery() {
    galleryPage = 1;
    galleryTotalPages = 1;
    galleryTotalItems = 0;
    currentSkipOffset = 0;
    currentGalleryItems = [];
    const sc = document.getElementById('main-scroll-container');
    if (sc) sc.scrollTop = 0;
    loadGalleryItems(false);
    loadGalleryTimeline();
}

async function jumpToTimelineOffset(offset, yearStr, monthStr = "") {
    currentSkipOffset = offset;
    galleryPage = Math.floor(offset / 60) + 1;
    currentGalleryItems = [];
    const sc = document.getElementById('main-scroll-container');
    if (sc) sc.scrollTop = 0;

    document.querySelectorAll('.tl-year-btn').forEach(el => {
        el.classList.toggle('tl-active', el.dataset.year === yearStr);
    });
    document.querySelectorAll('.tl-year-block').forEach(el => {
        el.classList.toggle('tl-expanded', el.dataset.year === yearStr);
    });
    document.querySelectorAll('.tl-month-btn').forEach(el => {
        el.classList.toggle('tl-month-active', el.dataset.year === yearStr && el.dataset.month === monthStr);
    });

    await loadGalleryItems(false, offset);
}

async function loadGalleryItems(append = false, customSkip = -1) {
    if (galleryIsLoading) return;
    if (append && galleryTotalItems > 0 && (currentSkipOffset + currentGalleryItems.length) >= galleryTotalItems) return;

    galleryIsLoading = true;
    const spinner = document.getElementById('gallery-loading-spinner');
    if (spinner) spinner.classList.remove('hidden');

    const targetPage = append ? galleryPage + 1 : galleryPage;
    const effectiveSkip = (!append && customSkip >= 0)
        ? customSkip
        : (append ? currentSkipOffset + currentGalleryItems.length : currentSkipOffset);

    try {
        const p = new URLSearchParams({
            year: document.getElementById('gal-year').value,
            month: document.getElementById('gal-month').value,
            album: document.getElementById('gal-album').value,
            media_type: document.getElementById('gal-type-filter').value,
            ext_filter: currentExtFilter,
            favorites_only: document.getElementById('gal-fav').checked,
            no_faces_only: document.getElementById('gal-nofaces').checked,
            sort_by: document.getElementById('gal-sort-by').value,
            sort_order: document.getElementById('gal-sort-order').value,
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
        document.getElementById('gal-total-label').textContent = `${galleryTotalItems} éléments`;

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
    tile.classList.toggle('ring-4', isSelected);
    tile.classList.toggle('ring-[#593E5A]', isSelected);
    const cb = tile.querySelector('.tile-checkbox');
    if (cb) {
        cb.checked = isSelected;
        cb.classList.toggle('opacity-100', isSelected);
        cb.classList.toggle('opacity-0', !isSelected);
    }
}

function updateSingleTileFavoriteDOM(idx, isFav) {
    const tile = document.getElementById(`media-tile-${idx}`);
    if (!tile) return;
    const badge = tile.querySelector('.tile-fav-badge');
    if (badge) badge.classList.toggle('hidden', !isFav);
}

function handleGalleryCheckboxClick(e, idx, encSrc) {
    const src = decodeURIComponent(encSrc);
    const chk = e.target.checked;
    if (e.shiftKey && lastClickedGalleryIdx !== null) {
        const s = Math.min(lastClickedGalleryIdx, idx), end = Math.max(lastClickedGalleryIdx, idx);
        for (let i = s; i <= end; i++) {
            const p = currentGalleryItems[i].source_path;
            if (chk) selectedGalleryPaths.add(p);
            else selectedGalleryPaths.delete(p);
            updateSingleTileSelectionDOM(i, chk);
        }
    } else {
        if (chk) selectedGalleryPaths.add(src);
        else selectedGalleryPaths.delete(src);
        updateSingleTileSelectionDOM(idx, chk);
    }
    lastClickedGalleryIdx = idx;
    updateGalleryBatchBar();
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

// ==================== BARRE CHRONOLOGIQUE (TIMELINE SCRUBBER ANNÉES & MOIS) ====================

async function loadGalleryTimeline() {
    const scrubber = document.getElementById('timeline-scrubber');
    const container = document.getElementById('timeline-items-container');
    if (!scrubber || !container) return;

    const sortBy = document.getElementById('gal-sort-by').value;
    if (sortBy !== 'date') {
        scrubber.classList.add('hidden');
        return;
    }

    const p = new URLSearchParams({
        album: document.getElementById('gal-album').value,
        media_type: document.getElementById('gal-type-filter').value,
        ext_filter: currentExtFilter,
        favorites_only: document.getElementById('gal-fav').checked,
        no_faces_only: document.getElementById('gal-nofaces').checked,
        sort_order: document.getElementById('gal-sort-order').value
    });

    const res = await fetch(`/api/gallery/timeline?${p.toString()}`);
    const d = await res.json();
    cachedTimelineData = d.timeline || [];

    if (cachedTimelineData.length === 0) {
        scrubber.classList.add('hidden');
        return;
    }

    scrubber.classList.remove('hidden');
    container.innerHTML = cachedTimelineData.map((yObj, idx) => `
        <div class="tl-year-block ${idx === 0 ? 'tl-expanded' : ''}" data-year="${yObj.year}">
            <div onclick="event.stopPropagation(); jumpToTimelineOffset(${yObj.offset}, '${yObj.year}')"
                 onmouseenter="showTimelineTooltip(event, '${yObj.year}', '', ${yObj.count})"
                 onmouseleave="hideTimelineTooltip()"
                 data-year="${yObj.year}"
                 data-offset="${yObj.offset}"
                 class="tl-year-btn ${idx === 0 ? 'tl-active' : ''}">
                ${yObj.year}
            </div>
            <div class="tl-months-list">
                ${yObj.months.map(mObj => {
                    const mNum = parseInt(mObj.month, 10);
                    return `
                    <div onclick="event.stopPropagation(); jumpToTimelineOffset(${mObj.offset}, '${yObj.year}', '${mObj.month}')"
                         onmouseenter="showTimelineTooltip(event, '${yObj.year}', '${FULL_MONTHS_FR[mNum]}', ${mObj.count})"
                         onmouseleave="hideTimelineTooltip()"
                         data-year="${yObj.year}"
                         data-month="${mObj.month}"
                         data-offset="${mObj.offset}"
                         class="tl-month-btn">
                        ${SHORT_MONTHS_FR[mNum]}
                    </div>`;
                }).join('')}
            </div>
        </div>
    `).join('');
}

function showTimelineTooltip(e, yearStr, monthFull, count) {
    const tt = document.getElementById('timeline-tooltip');
    if (!tt) return;
    tt.textContent = `${monthFull ? monthFull + ' ' : ''}${yearStr}  •  ${count} médias`;
    const rect = e.target.getBoundingClientRect();
    tt.style.top = `${Math.max(75, Math.min(window.innerHeight - 50, rect.top - 4))}px`;
    tt.classList.remove('hidden');
}

function hideTimelineTooltip() {
    if (isScrubbingTimeline) return;
    const tt = document.getElementById('timeline-tooltip');
    if (tt) tt.classList.add('hidden');
}

function startTimelineScrub(e) {
    if (e.target.classList.contains('tl-year-btn') || e.target.classList.contains('tl-month-btn')) return;
    isScrubbingTimeline = true;
    moveTimelineScrub(e);
}

function moveTimelineScrub(e) {
    if (!isScrubbingTimeline || !cachedTimelineData.length) return;
    const scrubber = document.getElementById('timeline-scrubber');
    const rect = scrubber.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

    const allMonths = [];
    cachedTimelineData.forEach(y => {
        y.months.forEach(m => allMonths.push({ year: y.year, month: m.month, offset: m.offset, count: m.count }));
    });
    if (!allMonths.length) return;

    const target = allMonths[Math.min(allMonths.length - 1, Math.floor(ratio * allMonths.length))];
    const mNum = parseInt(target.month, 10);
    const tt = document.getElementById('timeline-tooltip');
    if (tt) {
        tt.textContent = `${FULL_MONTHS_FR[mNum]} ${target.year}  •  ${target.count} médias`;
        tt.style.top = `${Math.max(75, Math.min(window.innerHeight - 50, e.clientY - 12))}px`;
        tt.classList.remove('hidden');
    }
    scrubber.dataset.pendingOffset = target.offset;
    scrubber.dataset.pendingYear = target.year;
    scrubber.dataset.pendingMonth = target.month;
}

function endTimelineScrub() {
    if (!isScrubbingTimeline) return;
    isScrubbingTimeline = false;
    hideTimelineTooltip();
    const scrubber = document.getElementById('timeline-scrubber');
    if (scrubber && scrubber.dataset.pendingOffset !== undefined) {
        jumpToTimelineOffset(
            parseInt(scrubber.dataset.pendingOffset, 10),
            scrubber.dataset.pendingYear,
            scrubber.dataset.pendingMonth
        );
        delete scrubber.dataset.pendingOffset;
    }
}

window.addEventListener('mouseup', endTimelineScrub);

window.addEventListener('DOMContentLoaded', () => {
    const sc = document.getElementById('main-scroll-container');
    if (!sc) return;
    let scrollTick = false;
    sc.addEventListener('scroll', () => {
        if (scrollTick) return;
        scrollTick = true;
        requestAnimationFrame(() => {
            const tiles = document.querySelectorAll('.media-tile');
            for (const t of tiles) {
                const r = t.getBoundingClientRect();
                if (r.top >= 80 && r.top <= 400) {
                    const idx = parseInt(t.id.replace('media-tile-', ''), 10);
                    const item = currentGalleryItems[idx];
                    if (item && item.timestamp > 0) {
                        const dt = new Date(item.timestamp * 1000);
                        const yStr = String(dt.getFullYear());
                        document.querySelectorAll('.tl-year-btn').forEach(b => {
                            b.classList.toggle('tl-active', b.dataset.year === yStr);
                        });
                    }
                    break;
                }
            }
            scrollTick = false;
        });
    }, { passive: true });
});

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
        icon.setAttribute('fill', '#e11d48');
        icon.setAttribute('stroke', '#e11d48');
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