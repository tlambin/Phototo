// ==================== PERSONNES ====================

let selectedPersonIds = new Set();
let currentTimelinePersonId = null;
let selectedFaceIds = new Set();
let allPersonsCache = [];
let facesLayout = localStorage.getItem('phototo_faces_layout') || 'GRID';
let facesSize = localStorage.getItem('phototo_faces_size') || 'MD';
let selectedFacesYears = [];
let selectedFacesMonths = [];
let selectedFacesContents = [];
let selectedFacesPeriods = [];

function syncFacesLayoutSizeButtons() {
    ['GRID', 'LIST'].forEach(l => {
        const b = document.getElementById(`faces-layout-btn-${l}`);
        if (b) {
            b.classList.toggle('nav-item-active', l === facesLayout);
            b.classList.toggle('ui-pill', l !== facesLayout);
        }
    });
    ['SM', 'MD', 'LG'].forEach(s => {
        const b = document.getElementById(`faces-size-btn-${s}`);
        if (b) {
            b.classList.toggle('nav-item-active', s === facesSize);
            b.classList.toggle('ui-pill', s !== facesSize);
        }
    });
}

function setFacesLayout(layout) {
    facesLayout = layout;
    localStorage.setItem('phototo_faces_layout', layout);
    syncFacesLayoutSizeButtons();
    renderPersonsOverviewFromCache();
}

function setFacesSize(size) {
    facesSize = size;
    localStorage.setItem('phototo_faces_size', size);
    syncFacesLayoutSizeButtons();
    renderPersonsOverviewFromCache();
}

function toggleFacesSortOrder() {
    _toggleSortOrderInput('faces-sort-order', 'faces-sort-dir-btn', 'faces-sort-arrow', onFacesControlsChanged);
}

function onFacesControlsChanged() {
    renderPersonsOverviewFromCache();
}

document.addEventListener('DOMContentLoaded', syncFacesLayoutSizeButtons);

function toggleFacesFilterMenu(forceState) {
    const pop = document.getElementById('faces-filter-popover');
    if (!pop) return;
    const willOpen = typeof forceState === 'boolean' ? forceState : pop.classList.contains('hidden');
    pop.classList.toggle('hidden', !willOpen);
}

function _getActiveFacesPeriodsList() {
    const list = selectedFacesPeriods.slice();
    const df = document.getElementById('faces-date-from')?.value || '';
    const dt = document.getElementById('faces-date-to')?.value || '';
    if (df || dt) {
        if (!list.some(p => p.from === df && p.to === dt)) list.push({ from: df, to: dt });
    }
    return list;
}

function populateFacesYearFilterOptions() {
    const ySel = document.getElementById('faces-year');
    if (!ySel) return;
    const yearsSet = new Set();
    (allPersonsCache || []).forEach(p => {
        [p.recent_ts, p.added_ts].forEach(ts => {
            if (ts > 0) yearsSet.add(String(new Date(ts * 1000).getFullYear()));
        });
    });
    const years = Array.from(yearsSet).sort((a, b) => b.localeCompare(a));
    ySel.innerHTML = `<option value="">Années</option>` + years.map(y => `<option value="${y}">${y}</option>`).join('');
}

function toggleFacesMultiFilterValue(kind, selectEl) {
    if (!selectEl || !selectEl.value) return;
    const val = selectEl.value;
    selectEl.value = '';
    const map = { year: selectedFacesYears, month: selectedFacesMonths, content: selectedFacesContents };
    const arr = map[kind];
    if (!arr) return;
    const idx = arr.indexOf(val);
    if (idx >= 0) arr.splice(idx, 1);
    else arr.push(val);
    renderPersonsOverviewFromCache();
}

function addFacesPeriodFromInputs() {
    const dfEl = document.getElementById('faces-date-from');
    const dtEl = document.getElementById('faces-date-to');
    const df = dfEl?.value || '';
    const dt = dtEl?.value || '';
    if (!df && !dt) return;
    if (!selectedFacesPeriods.some(p => p.from === df && p.to === dt)) {
        selectedFacesPeriods.push({ from: df, to: dt });
    }
    if (dfEl) dfEl.value = '';
    if (dtEl) dtEl.value = '';
    renderPersonsOverviewFromCache();
}

function removeFacesFilterChip(kind, idx) {
    if (kind === 'year') selectedFacesYears.splice(idx, 1);
    else if (kind === 'month') selectedFacesMonths.splice(idx, 1);
    else if (kind === 'content') selectedFacesContents.splice(idx, 1);
    else if (kind === 'period') selectedFacesPeriods.splice(idx, 1);
    renderPersonsOverviewFromCache();
}

function resetAllFacesFilters() {
    selectedFacesYears = [];
    selectedFacesMonths = [];
    selectedFacesContents = [];
    selectedFacesPeriods = [];
    const dfEl = document.getElementById('faces-date-from');
    const dtEl = document.getElementById('faces-date-to');
    if (dfEl) dfEl.value = '';
    if (dtEl) dtEl.value = '';
    renderPersonsOverviewFromCache();
}

function _renderFacesFilterChipsAndBadge() {
    const contentLabels = {
        IDENTIFIED: 'Identifiées',
        UNKNOWN: 'Non identifiées',
        MULTI_MEDIA: 'Plusieurs médias (2+)',
        SINGLE_MEDIA: '1 seul média'
    };
    const chips = [];
    selectedFacesYears.forEach((y, i) => chips.push({ kind: 'year', idx: i, label: y }));
    selectedFacesMonths.forEach((m, i) => chips.push({ kind: 'month', idx: i, label: (typeof SHORT_MONTHS_FR !== 'undefined' ? SHORT_MONTHS_FR[parseInt(m, 10)] : m) || m }));
    selectedFacesPeriods.forEach((p, i) => chips.push({ kind: 'period', idx: i, label: `${p.from || '…'} → ${p.to || '…'}` }));
    selectedFacesContents.forEach((c, i) => chips.push({ kind: 'content', idx: i, label: contentLabels[c] || c }));

    const container = document.getElementById('faces-active-filter-chips');
    if (container) {
        if (!chips.length) {
            container.innerHTML = '';
            container.classList.add('hidden');
        } else {
            container.classList.remove('hidden');
            container.innerHTML = chips.map(c =>
                `<span class="plum-btn px-2 py-0.5 rounded-full text-[10px] font-extrabold inline-flex items-center gap-1">
                    <span>${c.label}</span>
                    <button type="button" onclick="event.stopPropagation(); removeFacesFilterChip('${c.kind}', ${c.idx})" class="hover:text-rose-200 font-bold">✕</button>
                </span>`
            ).join('');
        }
    }

    const totalCount = chips.length + ((document.getElementById('faces-date-from')?.value || document.getElementById('faces-date-to')?.value) ? 1 : 0);
    const countBadge = document.getElementById('faces-filter-count');
    if (countBadge) {
        countBadge.textContent = String(totalCount);
        countBadge.classList.toggle('hidden', totalCount <= 0);
    }
    const filterBadge = document.getElementById('faces-active-filter-badge');
    const filterText = document.getElementById('faces-active-filter-text');
    if (filterBadge && filterText) {
        if (totalCount > 0) {
            filterText.textContent = `${totalCount} filtre${totalCount > 1 ? 's' : ''}`;
            filterBadge.classList.remove('hidden');
            filterBadge.classList.add('inline-flex');
        } else {
            filterBadge.classList.add('hidden');
            filterBadge.classList.remove('inline-flex');
        }
    }
    return totalCount;
}

function _personSortTs(p, sortBy) {
    if (sortBy === 'added') return p.added_ts || p.recent_ts || 0;
    return p.recent_ts || p.added_ts || 0;
}

function _isPersonIdentified(p) {
    return Boolean(p.name && p.name.trim().toLowerCase() !== 'inconnu');
}

function _filterPersonsList(persons) {
    const periods = _getActiveFacesPeriodsList();
    const sortBy = document.getElementById('faces-sort-by')?.value || 'content';
    const statusFilters = selectedFacesContents.filter(c => c === 'IDENTIFIED' || c === 'UNKNOWN');
    const countFilters = selectedFacesContents.filter(c => c === 'MULTI_MEDIA' || c === 'SINGLE_MEDIA');

    return (persons || []).filter(p => {
        const ts = _personSortTs(p, sortBy);
        const dt = ts > 0 ? new Date(ts * 1000) : null;
        const yr = dt ? String(dt.getFullYear()) : '';
        const mo = dt ? String(dt.getMonth() + 1).padStart(2, '0') : '';

        const hasYM = selectedFacesYears.length > 0 || selectedFacesMonths.length > 0;
        const hasPer = periods.length > 0;
        if (hasYM || hasPer) {
            let matchYM = false;
            if (hasYM && dt) {
                const okY = !selectedFacesYears.length || selectedFacesYears.includes(yr);
                const okM = !selectedFacesMonths.length || selectedFacesMonths.includes(mo);
                matchYM = okY && okM;
            }
            let matchPer = false;
            if (hasPer && ts > 0) {
                matchPer = periods.some(per => {
                    let ok = true;
                    if (per.from) ok = ok && ts >= Math.floor(new Date(per.from + 'T00:00:00').getTime() / 1000);
                    if (per.to) ok = ok && ts <= Math.floor(new Date(per.to + 'T23:59:59').getTime() / 1000);
                    return ok;
                });
            }
            if (!(matchYM || matchPer)) return false;
        }

        if (statusFilters.length > 0) {
            const isId = _isPersonIdentified(p);
            const okStatus = statusFilters.some(c => (c === 'IDENTIFIED' && isId) || (c === 'UNKNOWN' && !isId));
            if (!okStatus) return false;
        }
        if (countFilters.length > 0) {
            const cnt = Number(p.media_count ?? p.face_count) || 0;
            const okCnt = countFilters.some(c => (c === 'MULTI_MEDIA' && cnt >= 2) || (c === 'SINGLE_MEDIA' && cnt === 1));
            if (!okCnt) return false;
        }
        return true;
    });
}

function _comparePersonItems(a, b, sortBy = 'content', sortOrder = 'desc') {
    const dir = sortOrder === 'asc' ? 1 : -1;
    if (sortBy === 'name') {
        const diff = (a.name || '').localeCompare(b.name || '', 'fr', { sensitivity: 'base' });
        if (diff !== 0) return dir * diff;
        return dir * ((Number(a.media_count ?? a.face_count) || 0) - (Number(b.media_count ?? b.face_count) || 0));
    }
    if (sortBy === 'recent') {
        const diff = (a.recent_ts || 0) - (b.recent_ts || 0);
        if (diff !== 0) return dir * diff;
    } else if (sortBy === 'added') {
        const diff = (a.added_ts || 0) - (b.added_ts || 0);
        if (diff !== 0) return dir * diff;
        const fidDiff = (a.max_face_id || 0) - (b.max_face_id || 0);
        if (fidDiff !== 0) return dir * fidDiff;
    } else {
        const diff = (Number(a.media_count ?? a.face_count) || 0) - (Number(b.media_count ?? b.face_count) || 0);
        if (diff !== 0) return dir * diff;
        const rDiff = (a.recent_ts || 0) - (b.recent_ts || 0);
        if (rDiff !== 0) return dir * rDiff;
    }
    return (a.name || '').localeCompare(b.name || '', 'fr', { sensitivity: 'base' });
}

function getFacesGridClass() {
    if (facesLayout === 'LIST') {
        if (facesSize === 'SM') return 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2';
        if (facesSize === 'LG') return 'grid grid-cols-1 lg:grid-cols-2 gap-4';
        return 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3';
    }
    if (facesSize === 'SM') return 'grid grid-cols-5 sm:grid-cols-7 md:grid-cols-10 lg:grid-cols-12 gap-2.5';
    if (facesSize === 'LG') return 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-5';
    return 'grid grid-cols-3 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-8 gap-4';
}

function _personGroupKeyAndLabel(person, groupBy, sortBy) {
    if (groupBy === 'LETTER') {
        if (!_isPersonIdentified(person)) return { key: 'zzz', label: 'Non Identifié' };
        const raw = (person.name || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const ch = raw.charAt(0).toUpperCase();
        if (!ch || !/[A-Z]/.test(ch)) return { key: '#', label: '#' };
        return { key: ch, label: ch };
    }
    const ts = _personSortTs(person, sortBy);
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

function renderPersonCardHTML(p) {
    const isChk = selectedPersonIds.has(p.person_id);
    const fCount = Number(p.media_count ?? p.face_count) || 0;
    const safeName = escapeHtml(p.name || 'Inconnu');
    const ringCls = isChk ? 'ring-2 ring-emerald-400' : '';

    if (facesLayout === 'LIST') {
        const thumbCls = facesSize === 'SM' ? 'w-10 h-10 rounded-xl' : (facesSize === 'LG' ? 'w-24 h-24 rounded-2xl' : 'w-16 h-16 rounded-2xl');
        const padCls = facesSize === 'SM' ? 'p-2 gap-2.5 rounded-2xl' : (facesSize === 'LG' ? 'p-3.5 gap-4 rounded-3xl' : 'p-2.5 gap-3.5 rounded-2xl');
        const titleCls = facesSize === 'SM' ? 'text-xs' : (facesSize === 'LG' ? 'text-base' : 'text-sm');
        const dateStr = p.recent_ts ? new Date(p.recent_ts * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
        const metaLine = [`${fCount} média${fCount > 1 ? 's' : ''}`, dateStr].filter(Boolean).join(' · ');
        const listChkCls = isChk
            ? 'bg-emerald-500 text-white border-emerald-400'
            : 'bg-black/20 text-white/75 border-white/20 hover:bg-black/35';

        return `
        <div class="person-card ui-card ${padCls} flex items-center cursor-pointer group shadow-sm hover:shadow-lg transition-all duration-150 ${ringCls}"
             onclick="openTimeline(${p.person_id})">
            <label class="${listChkCls} shrink-0 w-5 h-5 rounded-full border flex items-center justify-center cursor-pointer transition-all"
                   title="Sélectionner pour fusionner" onclick="event.stopPropagation()">
                <input type="checkbox" ${isChk ? 'checked' : ''} onchange="togglePersonCardSelection(${p.person_id}, this)" class="sr-only"/>
                <svg class="w-3 h-3 ${isChk ? 'opacity-100' : 'opacity-50'}" fill="none" stroke="currentColor" stroke-width="2.6" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
            </label>
            <div class="shrink-0 ${thumbCls} overflow-hidden ui-pill">
                <img src="/media?path=${encodeURIComponent(p.thumb_path||'')}" loading="lazy" class="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-300"/>
            </div>
            <div class="flex-1 min-w-0" onclick="event.stopPropagation()">
                <input type="text" value="${safeName}" onchange="renamePerson(${p.person_id}, this.value)" title="Cliquer pour renommer"
                       class="w-full bg-transparent hover:bg-[var(--bg-hover)] focus:bg-[var(--bg-pill)] rounded-lg px-1.5 py-0.5 font-extrabold ${titleCls} outline-none transition truncate"/>
                <div class="text-[11px] opacity-60 font-semibold px-1.5 truncate mt-0.5">${metaLine}</div>
            </div>
        </div>`;
    }

    const checkBtnCls = isChk
        ? 'opacity-100 bg-emerald-500 text-white border-emerald-400'
        : 'opacity-0 group-hover:opacity-100 bg-black/45 backdrop-blur-md text-white/85 border-white/25 hover:bg-black/65';
    const radiusCls = facesSize === 'LG' ? 'rounded-[22px]' : (facesSize === 'SM' ? 'rounded-[14px]' : 'rounded-[18px]');
    const nameTxtCls = facesSize === 'LG' ? 'text-sm' : (facesSize === 'SM' ? 'text-[11px]' : 'text-xs');

    return `
    <div class="person-card flex flex-col group">
        <div class="ui-card aspect-square ${radiusCls} overflow-hidden relative shadow-sm group-hover:shadow-lg transition-all duration-200 ${ringCls}">
            <label class="${checkBtnCls} absolute top-1.5 left-1.5 w-5 h-5 rounded-full border flex items-center justify-center cursor-pointer z-10 transition-all shadow-md"
                   title="Sélectionner pour fusionner" onclick="event.stopPropagation()">
                <input type="checkbox" ${isChk ? 'checked' : ''} onchange="togglePersonCardSelection(${p.person_id}, this)"
                       class="sr-only"/>
                <svg class="w-3 h-3 ${isChk ? 'opacity-100' : 'opacity-60'}" fill="none" stroke="currentColor" stroke-width="2.6" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
            </label>
            <div onclick="openTimeline(${p.person_id})" class="w-full h-full cursor-pointer">
                <img src="/media?path=${encodeURIComponent(p.thumb_path||'')}" loading="lazy" class="w-full h-full object-cover object-top group-hover:scale-105 transition-transform duration-300"/>
            </div>
            <div class="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-black/55 via-black/15 to-transparent opacity-70 group-hover:opacity-90 transition-opacity"></div>
            <span title="${fCount} média${fCount > 1 ? 's' : ''}"
                  class="pointer-events-none absolute bottom-1.5 left-1.5 bg-black/45 backdrop-blur-md border border-white/15 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full inline-flex items-center gap-1">
                <svg class="w-2.5 h-2.5 shrink-0 opacity-85" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                <span>${fCount}</span>
            </span>
        </div>
        <div class="pt-1.5 px-0.5">
            <input type="text" value="${safeName}" onchange="renamePerson(${p.person_id}, this.value)" title="Cliquer pour renommer"
                   class="w-full bg-transparent hover:bg-[var(--bg-hover)] focus:bg-[var(--bg-pill)] rounded-lg px-1.5 py-0.5 ${nameTxtCls} font-extrabold text-center outline-none transition truncate"/>
        </div>
    </div>`;
}

function renderPersonsOverviewFromCache() {
    const idGrid = document.getElementById('persons-identified-grid');
    const unkGrid = document.getElementById('persons-unknown-grid');
    const unkSec = document.getElementById('persons-unknown-section');
    if (!idGrid || !unkGrid) return;

    const activeFilterCount = _renderFacesFilterChipsAndBadge();
    const sortBy = document.getElementById('faces-sort-by')?.value || 'content';
    const sortOrder = document.getElementById('faces-sort-order')?.value || 'desc';
    const groupBy = document.getElementById('faces-group-by')?.value || 'NONE';

    const groupFiltered = typeof filterItemsByActiveCustomGroup === 'function'
        ? filterItemsByActiveCustomGroup('persons', allPersonsCache, p => p.person_id)
        : allPersonsCache;
    const filtered = _filterPersonsList(groupFiltered);
    const sorted = [...filtered].sort((a, b) => _comparePersonItems(a, b, sortBy, sortOrder));
    const identified = sorted.filter(_isPersonIdentified);
    const unknown = sorted.filter(p => !_isPersonIdentified(p));

    const totalLbl = document.getElementById('faces-total-label');
    if (totalLbl) {
        totalLbl.textContent = `${identified.length} identifiée${identified.length > 1 ? 's' : ''}`;
    }
    const unknownCntEl = document.getElementById('faces-unknown-count');
    if (unknownCntEl) {
        unknownCntEl.textContent = unknown.length ? String(unknown.length) : '';
    }

    const gridCls = getFacesGridClass();
    if (groupBy !== 'NONE') {
        if (unkSec) unkSec.classList.add('hidden');
        if (sorted.length === 0) {
            idGrid.className = gridCls;
            idGrid.innerHTML = `<div class="col-span-full ui-card rounded-3xl p-8 text-center text-sm font-semibold opacity-60">Aucune personne ne correspond aux filtres sélectionnés.</div>`;
            return;
        }
        const groups = [];
        const groupMap = new Map();
        sorted.forEach(p => {
            const { key, label } = _personGroupKeyAndLabel(p, groupBy, sortBy);
            if (!groupMap.has(key)) {
                const g = { key, label, items: [] };
                groupMap.set(key, g);
                groups.push(g);
            }
            groupMap.get(key).items.push(p);
        });
        idGrid.className = 'space-y-6 pb-10';
        idGrid.innerHTML = groups.map(g => `
            <section class="space-y-3 group-section">
                <div class="flex items-center justify-between">
                    <h3 class="group-section-title text-sm font-extrabold tracking-tight">${g.label}</h3>
                    <span class="text-[11px] font-bold opacity-55">${g.items.length} personne${g.items.length > 1 ? 's' : ''}</span>
                </div>
                <div class="${gridCls}">
                    ${g.items.map(renderPersonCardHTML).join('')}
                </div>
            </section>
        `).join('');
        if (typeof updateFloatingGroupPill === 'function') updateFloatingGroupPill();
        return;
    }

    const hideUnknown = selectedFacesContents.includes('IDENTIFIED') && !selectedFacesContents.includes('UNKNOWN');
    const hideIdentified = selectedFacesContents.includes('UNKNOWN') && !selectedFacesContents.includes('IDENTIFIED');

    idGrid.className = hideIdentified ? 'hidden' : gridCls;
    if (!hideIdentified) {
        if (identified.length) {
            idGrid.innerHTML = identified.map(renderPersonCardHTML).join('');
        } else if (activeFilterCount > 0) {
            idGrid.innerHTML = `<div class="col-span-full ui-card rounded-3xl p-8 text-center text-sm font-semibold opacity-60">Aucune personne identifiée ne correspond aux filtres sélectionnés.</div>`;
        } else {
            idGrid.innerHTML = `<div class="col-span-full ui-card rounded-3xl p-8 text-center text-sm font-semibold opacity-60">Renommez un visage ci-dessous pour l'ajouter aux personnes identifiées.</div>`;
        }
    }

    if (unkSec) unkSec.classList.toggle('hidden', hideUnknown);
    unkGrid.className = `${gridCls} pb-10`;
    if (!hideUnknown) {
        if (unknown.length) {
            unkGrid.innerHTML = unknown.map(renderPersonCardHTML).join('');
        } else if (activeFilterCount > 0) {
            unkGrid.innerHTML = `<div class="col-span-full ui-card rounded-3xl p-8 text-center text-sm font-semibold opacity-60">Aucun visage non identifié ne correspond aux filtres sélectionnés.</div>`;
        } else {
            unkGrid.innerHTML = `<div class="col-span-full ui-card rounded-3xl p-8 text-center text-sm font-semibold opacity-60">Aucun visage non identifié pour le moment.</div>`;
        }
    }
    if (typeof updateFloatingGroupPill === 'function') updateFloatingGroupPill();
}

async function loadPersons() {
    const res = await fetch('/api/persons');
    const d = await res.json();
    allPersonsCache = d.persons || [];
    populateFacesYearFilterOptions();
    syncFacesLayoutSizeButtons();
    if (typeof loadCustomGroups === 'function') await loadCustomGroups('persons');
    renderPersonsOverviewFromCache();
}

function togglePersonCardSelection(pid, inputEl) {
    togglePersonSelection(pid);
    const isChk = selectedPersonIds.has(pid);
    const lbl = inputEl?.closest('label');
    const cardBox = inputEl?.closest('.ui-card');
    if (lbl) {
        lbl.className = `${isChk
            ? 'opacity-100 bg-emerald-500 text-white border-emerald-400'
            : 'opacity-0 group-hover:opacity-100 bg-black/45 backdrop-blur-md text-white/85 border-white/25 hover:bg-black/65'} absolute top-1.5 left-1.5 w-5 h-5 rounded-full border flex items-center justify-center cursor-pointer z-10 transition-all shadow-md`;
    }
    if (cardBox) cardBox.classList.toggle('ring-2', isChk), cardBox.classList.toggle('ring-emerald-400', isChk);
}

function togglePersonSelection(pid) {
    if (selectedPersonIds.has(pid)) selectedPersonIds.delete(pid); else selectedPersonIds.add(pid);
    const btn = document.getElementById('btn-merge-selected');
    btn.classList.toggle('hidden', selectedPersonIds.size < 2);
    btn.textContent = `Fusionner (${selectedPersonIds.size})`;
}

async function renamePerson(pid, newName) {
    await fetch('/api/person/rename', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({person_id:pid, new_name:newName})});
    loadPersons();
}

async function mergeSelectedPersons() {
    const name = prompt("Nom de la personne :", "");
    if (name === null) return;
    await fetch('/api/persons/merge', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({person_ids:Array.from(selectedPersonIds), target_name:name})});
    selectedPersonIds.clear();
    document.getElementById('btn-merge-selected').classList.add('hidden');
    loadPersons(); loadStats();
}

function toggleSuggestionsPanel() {
    const p = document.getElementById('suggestions-panel');
    p.classList.toggle('hidden');
    if (!p.classList.contains('hidden')) loadMergeSuggestions();
}

async function loadMergeSuggestions() {
    const res = await fetch('/api/persons/suggestions');
    const d = await res.json();
    document.getElementById('suggestions-grid').innerHTML = (d.suggestions||[]).map(s => `
        <div class="ui-pill rounded-2xl p-2.5 flex items-center justify-between">
            <div class="flex items-center gap-2">
                <img src="/media?path=${encodeURIComponent(s.p1.thumb_path)}" class="w-11 h-11 rounded-full object-cover"/>
                <span class="text-xs font-extrabold">${s.similarity}%</span>
                <img src="/media?path=${encodeURIComponent(s.p2.thumb_path)}" class="w-11 h-11 rounded-full object-cover"/>
            </div>
            <button onclick="quickMergePair(${s.p1.person_id}, ${s.p2.person_id})" class="plum-btn text-xs font-bold px-3 py-1.5 rounded-full">Fusionner</button>
        </div>`).join('');
}

async function quickMergePair(a, b) {
    await fetch('/api/persons/merge', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({person_ids:[a,b]})});
    loadMergeSuggestions(); loadPersons();
}

let _personTimelineData = null;
let _personFaceEditMode = false;

function _renderPersonTimelineGrid() {
    const gridEl = document.getElementById('tl-faces-grid');
    const editBar = document.getElementById('tl-face-edit-bar');
    const editBtn = document.getElementById('btn-toggle-person-face-edit');
    if (!gridEl || !_personTimelineData) return;

    if (editBar) editBar.classList.toggle('hidden', !_personFaceEditMode);
    if (editBtn) {
        editBtn.classList.toggle('nav-item-active', _personFaceEditMode);
        editBtn.classList.toggle('ui-card', !_personFaceEditMode);
    }

    if (_personFaceEditMode) {
        gridEl.className = 'grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3.5';
        const faces = _personTimelineData.faces || [];
        gridEl.innerHTML = faces.length ? faces.map(f => {
            const sEnc = encodeURIComponent(f.source_path || f.dest_path);
            const dEnc = encodeURIComponent(f.dest_path);
            const isChk = selectedFaceIds.has(f.face_id);
            return `
            <div class="group flex flex-col">
                <div class="ui-card rounded-[20px] overflow-hidden relative aspect-square shadow-sm group-hover:shadow-lg transition-all duration-150">
                    <label class="opacity-0 group-hover:opacity-100 has-[:checked]:opacity-100 has-[:checked]:bg-emerald-500 has-[:checked]:text-white has-[:checked]:border-emerald-400 bg-black/45 backdrop-blur-md text-white/85 border border-white/25 absolute top-2 left-2 w-6 h-6 rounded-full flex items-center justify-center cursor-pointer z-10 transition-all shadow-md"
                           onclick="event.stopPropagation()">
                        <input type="checkbox" ${isChk ? 'checked' : ''} onchange="if(this.checked) selectedFaceIds.add(${f.face_id}); else selectedFaceIds.delete(${f.face_id}); document.getElementById('tl-sel-count').textContent=selectedFaceIds.size+' sélectionné(s)';"
                               class="sr-only"/>
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.6" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
                    </label>
                    <div onclick="openLightboxForCustomItem('${sEnc}', '${dEnc}', ${f.timestamp || 0})" class="w-full h-full cursor-pointer">
                        <img src="/media?path=${encodeURIComponent(f.thumb_path)}" loading="lazy" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"/>
                    </div>
                </div>
                <div class="text-[11px] opacity-60 font-semibold text-center pt-1.5 truncate">${formatDate(f.timestamp)}</div>
            </div>`;
        }).join('') : `<div class="col-span-full ui-card rounded-3xl p-8 text-center text-sm font-semibold opacity-60">Aucun visage détecté.</div>`;
        return;
    }

    const items = _personTimelineData.items || _personTimelineData.faces || [];
    currentGalleryItems = items;
    lightboxIsCustomItem = false;
    gridEl.className = 'space-y-6';
    appendMediaBatchToContainer('tl-faces-grid', items, 0, true);
    if (typeof updateFloatingGroupPill === 'function') updateFloatingGroupPill();
}

function togglePersonFaceEditMode() {
    _personFaceEditMode = !_personFaceEditMode;
    selectedGalleryPaths.clear();
    updateGalleryBatchBar();
    _renderPersonTimelineGrid();
}

async function openTimeline(pid) {
    currentTimelinePersonId = pid;
    _personFaceEditMode = false;
    selectedFaceIds.clear();
    selectedGalleryPaths.clear();
    updateGalleryBatchBar();
    toggleFacesFilterMenu(false);
    if (typeof _setOptionsDrawerState === 'function') _setOptionsDrawerState('faces-options-drawer', 'faces-options-btn', false);
    if (typeof _syncTopbarOptionsButton === 'function') _syncTopbarOptionsButton();

    const pRes = await fetch('/api/persons');
    const pData = await pRes.json();
    document.getElementById('tl-target-person-select').innerHTML = '<option value="">-- Choisir une personne --</option>' +
        (pData.persons||[]).filter(x => x.person_id !== pid).map(x => `<option value="${x.person_id}">${escapeHtml(x.name)}</option>`).join('');

    const sortBy = document.getElementById('gal-sort-by')?.value || 'date';
    const sortOrd = document.getElementById('gal-sort-order')?.value || 'desc';
    const res = await fetch(`/api/person/${pid}/timeline?sort_by=${encodeURIComponent(sortBy)}&sort_order=${encodeURIComponent(sortOrd)}`);
    const d = await res.json();
    if (currentTab !== 'faces' || currentTimelinePersonId !== pid) return;
    _personTimelineData = d;
    const photos = d.items || d.faces || [];

    document.getElementById('persons-overview-panel').classList.add('hidden');
    document.getElementById('person-timeline-modal').classList.remove('hidden');
    document.getElementById('tl-person-name').textContent = d.person.name || 'Inconnu';
    const tlCntEl = document.getElementById('tl-person-count');
    if (tlCntEl) {
        const cnt = photos.length;
        tlCntEl.textContent = `${cnt} élément${cnt > 1 ? 's' : ''}`;
    }
    const selCntEl = document.getElementById('tl-sel-count');
    if (selCntEl) selCntEl.textContent = '0 sélectionné(s)';
    _renderPersonTimelineGrid();
}

function closeTimeline() {
    currentTimelinePersonId = null;
    _personTimelineData = null;
    _personFaceEditMode = false;
    selectedFaceIds.clear();
    selectedGalleryPaths.clear();
    updateGalleryBatchBar();
    if (typeof _mountFilterDrawerForActiveView === 'function') _mountFilterDrawerForActiveView(false);
    document.getElementById('person-timeline-modal').classList.add('hidden');
    document.getElementById('persons-overview-panel').classList.remove('hidden');
    if (typeof _syncTopbarOptionsButton === 'function') _syncTopbarOptionsButton();
    if (typeof updateFloatingGroupPill === 'function') updateFloatingGroupPill();
    loadPersons();
}

async function reassignSelectedFaces(action) {
    if (!selectedFaceIds.size) return;
    const tPid = document.getElementById('tl-target-person-select').value;
    await fetch('/api/faces/reassign', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({face_ids:Array.from(selectedFaceIds), action, target_person_id: tPid ? parseInt(tPid,10) : null})
    });
    openTimeline(currentTimelinePersonId);
}

async function syncExifNow() {
    const res = await fetch('/api/faces/sync_exif', {method:'POST'});
    const d = await res.json();
    alert(`${d.synced_photos} fichiers synchronisés dans l'EXIF/XMP.`);
}

// ==================== LIEUX ====================

let leafletMap = null, markerCluster = null;
let _placesBucketsList = [];
let _openedPlaceBucketIdx = -1;

function closeSinglePlaceView() {
    _openedPlaceBucketIdx = -1;
    const single = document.getElementById('place-single-panel');
    const overview = document.getElementById('map-overview-panel');
    if (single) single.classList.add('hidden');
    if (overview) overview.classList.remove('hidden');
    if (leafletMap) setTimeout(() => leafletMap.invalidateSize(), 120);
}

function focusOpenedPlaceOnMap() {
    const pl = _placesBucketsList[_openedPlaceBucketIdx];
    if (!pl) return;
    closeSinglePlaceView();
    if (leafletMap) {
        setTimeout(() => leafletMap.setView([pl.lat, pl.lon], 12), 150);
    }
}

function openSinglePlaceView(idx) {
    const pl = _placesBucketsList[idx];
    if (!pl) return;
    _openedPlaceBucketIdx = idx;

    const overview = document.getElementById('map-overview-panel');
    const single = document.getElementById('place-single-panel');
    if (overview) overview.classList.add('hidden');
    if (single) single.classList.remove('hidden');

    const titleEl = document.getElementById('single-place-title');
    const subEl = document.getElementById('single-place-subtitle');
    const cntEl = document.getElementById('single-place-count');
    const gridEl = document.getElementById('place-single-grid');

    if (titleEl) titleEl.textContent = pl.city || pl.label || 'Lieu localisé';
    if (subEl) {
        const foreignTxt = pl.is_foreign && pl.place_subtitle ? pl.place_subtitle : '';
        subEl.textContent = foreignTxt;
        subEl.classList.toggle('hidden', !foreignTxt);
    }
    if (cntEl) cntEl.textContent = `${pl.items.length} élément${pl.items.length > 1 ? 's' : ''}`;

    if (gridEl) {
        gridEl.innerHTML = pl.items.map(pt => {
            const sEnc = encodeURIComponent(pt.source_path || pt.dest_path);
            const dEnc = encodeURIComponent(pt.dest_path);
            return `
            <div onclick="openLightboxForCustomItem('${sEnc}', '${dEnc}', ${pt.timestamp || 0})"
                 class="ui-card aspect-square rounded-[20px] overflow-hidden cursor-pointer group shadow-sm hover:shadow-xl transition-all duration-150 relative">
                ${renderMediaPreview(pt.dest_path, "w-full h-full object-cover group-hover:scale-105 transition-transform duration-300")}
            </div>`;
        }).join('');
    }
}

let _allPlacesBucketsList = [];

function renderPlacesOverviewFromCache() {
    const grid = document.getElementById('places-cards-grid');
    if (!grid) return;
    const filtered = typeof filterItemsByActiveCustomGroup === 'function'
        ? filterItemsByActiveCustomGroup('places', _allPlacesBucketsList, pl => pl.bucket_key)
        : _allPlacesBucketsList;
    const pinSvg = `<svg class="w-3 h-3 shrink-0" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;
    if (!filtered.length) {
        const hasGrp = typeof activeCustomGroupId !== 'undefined' && activeCustomGroupId.places !== null;
        grid.innerHTML = `<div class="col-span-full ui-card rounded-3xl p-8 text-center text-sm font-semibold opacity-60">${hasGrp ? 'Aucun lieu dans ce groupe.' : 'Aucun média géolocalisé pour le moment. Cliquez sur « Ajouter » pour localiser vos photos.'}</div>`;
        return;
    }
    grid.innerHTML = filtered.map(pl => {
        const idx = _placesBucketsList.indexOf(pl);
        return `
            <div onclick="openSinglePlaceView(${idx})" class="place-card cursor-pointer group flex flex-col">
                <div class="ui-card aspect-square rounded-[24px] overflow-hidden relative shadow-sm group-hover:shadow-xl transition-all duration-200">
                    ${renderMediaPreview(pl.cover, "w-full h-full object-cover group-hover:scale-105 transition-transform duration-300")}
                    <div class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/55 via-black/15 to-transparent opacity-75 group-hover:opacity-95 transition-opacity"></div>
                    <span class="absolute bottom-2.5 left-2.5 bg-black/50 backdrop-blur-md border border-white/15 text-white text-[10px] font-bold px-2.5 py-0.5 rounded-full inline-flex items-center gap-1 z-10">
                        ${pinSvg}<span>GPS</span>
                    </span>
                </div>
                <div class="pt-2.5 px-1">
                    <div id="place-card-label-${idx}" class="text-sm font-extrabold truncate leading-tight">${escapeHtml(pl.label)}</div>
                    <div class="text-[11px] opacity-60 font-semibold mt-0.5 truncate">${pl.count} élément${pl.count > 1 ? 's' : ''}</div>
                </div>
            </div>
        `;
    }).join('');
}

async function loadWorldMap(force) {
    closeSinglePlaceView();
    if (!leafletMap) {
        leafletMap = L.map('world-map').setView([46.6, 1.88], 5);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(leafletMap);
        markerCluster = L.markerClusterGroup({chunkedLoading: true});
        leafletMap.addLayer(markerCluster);
    }
    setTimeout(() => leafletMap.invalidateSize(), 150);
    markerCluster.clearLayers();
    const res = await fetch('/api/map/points');
    const d = await res.json();
    const pts = d.points || [];
    document.getElementById('map-stats-label').textContent = `${pts.length} éléments`;

    const markers = pts.map(pt => {
        const sEnc = encodeURIComponent(pt.source_path || pt.dest_path);
        const dEnc = encodeURIComponent(pt.dest_path);
        const popupHtml = `<div onclick="openLightboxForCustomItem('${sEnc}', '${dEnc}', ${pt.timestamp || 0})" class="cursor-pointer">${renderMediaPreview(pt.dest_path, "w-44 h-32 object-cover rounded-xl")}</div>`;
        return L.marker([pt.latitude, pt.longitude]).bindPopup(popupHtml);
    });
    markerCluster.addLayers(markers);

    const buckets = {};
    pts.forEach(pt => {
        const key = `${pt.latitude.toFixed(1)}, ${pt.longitude.toFixed(1)}`;
        if (!buckets[key]) {
            buckets[key] = {
                bucket_key: key,
                label: pt.album_name || 'Lieu localisé',
                city: pt.album_name || '',
                place_subtitle: '',
                is_foreign: false,
                count: 0,
                cover: pt.dest_path,
                lat: pt.latitude,
                lon: pt.longitude,
                items: [],
            };
        }
        buckets[key].count++;
        buckets[key].items.push(pt);
    });
    const topPlaces = Object.values(buckets).sort((a,b) => b.count - a.count).slice(0, 20);
    _placesBucketsList = topPlaces;
    _allPlacesBucketsList = topPlaces;
    if (typeof loadCustomGroups === 'function') await loadCustomGroups('places');
    renderPlacesOverviewFromCache();

    topPlaces.forEach(async (pl, idx) => {
        try {
            const gRes = await fetch(`/api/map/reverse?lat=${encodeURIComponent(pl.lat)}&lon=${encodeURIComponent(pl.lon)}`);
            if (!gRes.ok) return;
            const geo = await gRes.json();
            const city = (geo.city || '').trim();
            const sub = (geo.is_foreign && geo.place_subtitle) ? geo.place_subtitle.trim() : '';
            pl.city = city || pl.label;
            pl.place_subtitle = sub;
            pl.is_foreign = Boolean(geo.is_foreign);
            const displayLabel = (city && sub) ? `${city} · ${sub}` : (city || geo.label || pl.label);
            pl.label = displayLabel;

            const el = document.getElementById(`place-card-label-${idx}`);
            if (el && displayLabel) {
                el.textContent = displayLabel;
                el.title = geo.label || displayLabel;
            }
            if (_openedPlaceBucketIdx === idx) {
                const tEl = document.getElementById('single-place-title');
                const sEl = document.getElementById('single-place-subtitle');
                if (tEl) tEl.textContent = pl.city;
                if (sEl) {
                    sEl.textContent = sub;
                    sEl.classList.toggle('hidden', !sub);
                }
            }
        } catch (e) {}
    });
}

// ==================== DOUBLONS & SIMILAIRES ====================

function renderComparisonCard(item) {
    const sEnc = encodeURIComponent(item.source_path);
    const dEnc = encodeURIComponent(item.dest_path);
    const fname = (item.dest_path || '').split(/[\\/]/).pop();
    const folder = (item.dest_path || '').split(/[\\/]/).slice(0, -1).join('/');
    const mb = item.file_size ? (item.file_size / (1024*1024)).toFixed(1).replace('.', ',') + ' Mo' : '';
    const isChk = checkedDuplicatePaths.has(item.source_path);

    return `
    <div class="flex items-start gap-4">
        <div class="ui-card relative w-36 h-36 rounded-2xl overflow-hidden shrink-0 shadow-sm">
            <input type="checkbox" ${isChk ? 'checked' : ''}
                   onchange="toggleDuplicateCheck('${sEnc}', this.checked)"
                   class="absolute top-2.5 left-2.5 w-4 h-4 cursor-pointer z-10"/>
            <div onclick="openLightboxForCustomItem('${sEnc}', '${dEnc}', ${item.timestamp || 0})" class="w-full h-full cursor-pointer">
                ${renderMediaPreview(item.dest_path, "w-full h-full object-cover")}
            </div>
        </div>
        <div class="text-xs space-y-1 pt-1 min-w-0">
            <div class="font-extrabold text-sm truncate">${fname}</div>
            <div class="font-bold opacity-80">${formatDate(item.timestamp)}</div>
            <div class="font-bold opacity-80 pt-1">${mb}</div>
            <div class="text-[11px] opacity-60 truncate">${folder}</div>
        </div>
    </div>`;
}

function toggleDuplicateCheck(encSrc, checked) {
    const src = decodeURIComponent(encSrc);
    if (checked) checkedDuplicatePaths.add(src);
    else checkedDuplicatePaths.delete(src);
    document.getElementById('btn-delete-checked-dups').classList.toggle('hidden', checkedDuplicatePaths.size === 0);
    document.getElementById('btn-delete-checked-sims').classList.toggle('hidden', checkedDuplicatePaths.size === 0);
}

async function deleteCheckedDuplicates() {
    if (!checkedDuplicatePaths.size) return;
    await fetch('/api/trash/action', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({source_paths: Array.from(checkedDuplicatePaths), action: 'MOVE_TO_TRASH'})
    });
    checkedDuplicatePaths.clear();
    document.getElementById('btn-delete-checked-dups').classList.add('hidden');
    document.getElementById('btn-delete-checked-sims').classList.add('hidden');
    loadDuplicates(); loadSimilarGroups(); loadStats();
}

async function loadDuplicates() {
    const res = await fetch('/api/duplicates');
    const d = await res.json();
    const groups = d.groups || [];
    document.getElementById('dups-container').innerHTML = groups.map((g, i) => `
        <div class="space-y-3">
            <h3 class="text-xl font-extrabold">Doublon ${i + 1}</h3>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                ${renderComparisonCard(g.master)}
                ${g.duplicates.map(dup => renderComparisonCard(dup)).join('')}
            </div>
        </div>
    `).join('');
}

async function loadSimilarGroups() {
    const res = await fetch('/api/similar/groups');
    const d = await res.json();
    const groups = d.groups || [];
    document.getElementById('similar-container').innerHTML = groups.map((grp, i) => `
        <div class="space-y-3">
            <h3 class="text-xl font-extrabold">Similarité ${i + 1}</h3>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                ${grp.map(item => renderComparisonCard(item)).join('')}
            </div>
        </div>
    `).join('');
}
