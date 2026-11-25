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
    const ringCls = isChk ? 'person-card-selected' : '';

    if (facesLayout === 'LIST') {
        const thumbCls = facesSize === 'SM' ? 'w-10 h-10 rounded-xl' : (facesSize === 'LG' ? 'w-24 h-24 rounded-2xl' : 'w-16 h-16 rounded-2xl');
        const padCls = facesSize === 'SM' ? 'p-2 gap-2.5 rounded-2xl' : (facesSize === 'LG' ? 'p-3.5 gap-4 rounded-3xl' : 'p-2.5 gap-3.5 rounded-2xl');
        const titleCls = facesSize === 'SM' ? 'text-xs' : (facesSize === 'LG' ? 'text-base' : 'text-sm');
        const dateStr = p.recent_ts ? new Date(p.recent_ts * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
        const metaLine = [`${fCount} média${fCount > 1 ? 's' : ''}`, dateStr].filter(Boolean).join(' · ');
        const listChkCls = isChk
            ? 'person-check-checked'
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
        ? 'opacity-100 person-check-checked'
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
            ? 'opacity-100 person-check-checked'
            : 'opacity-0 group-hover:opacity-100 bg-black/45 backdrop-blur-md text-white/85 border-white/25 hover:bg-black/65'} absolute top-1.5 left-1.5 w-5 h-5 rounded-full border flex items-center justify-center cursor-pointer z-10 transition-all shadow-md`;
    }
    if (cardBox) cardBox.classList.toggle('person-card-selected', isChk);
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
                    <label class="face-edit-check opacity-0 group-hover:opacity-100 has-[:checked]:opacity-100 bg-black/45 backdrop-blur-md text-white/85 border border-white/25 absolute top-2 left-2 w-6 h-6 rounded-full flex items-center justify-center cursor-pointer z-10 transition-all shadow-md"
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
let _allPlacesBucketsList = [];
let _openedPlaceBucketIdx = -1;
let _openedPlaceBucketKey = '';
let placesLayout = localStorage.getItem('phototo_places_layout') || 'GRID';
let placesSize = localStorage.getItem('phototo_places_size') || 'MD';
let mapHeightMode = ['SM', 'MD', 'LG'].includes(localStorage.getItem('phototo_map_height'))
    ? localStorage.getItem('phototo_map_height')
    : 'MD';
let mapFilterByViewport = false;
let selectedPlacesYears = [];
let selectedPlacesMonths = [];
let selectedPlacesContents = [];
let selectedPlacesPeriods = [];
let _lastMapPointsForFit = [];

function syncPlacesLayoutSizeButtons() {
    ['GRID', 'LIST'].forEach(l => {
        const b = document.getElementById(`places-layout-btn-${l}`);
        if (b) {
            b.classList.toggle('nav-item-active', l === placesLayout);
            b.classList.toggle('ui-pill', l !== placesLayout);
        }
    });
    ['SM', 'MD', 'LG'].forEach(s => {
        const b = document.getElementById(`places-size-btn-${s}`);
        if (b) {
            b.classList.toggle('nav-item-active', s === placesSize);
            b.classList.toggle('ui-pill', s !== placesSize);
        }
    });
}

let _worldMapExpanded = false;

function toggleWorldMapExpanded(forceState = null) {
    const next = forceState === null ? !_worldMapExpanded : !!forceState;
    _worldMapExpanded = next;
    const card = document.getElementById('world-map-card');
    if (_worldMapExpanded && mapHeightMode === 'HIDE') {
        mapHeightMode = 'MD';
        localStorage.setItem('phototo_map_height', mapHeightMode);
        syncMapHeightButtons();
    }
    if (card) {
        card.classList.toggle('hidden', !_worldMapExpanded);
    }
    if (typeof renderPlacesOverviewFromCache === 'function') {
        renderPlacesOverviewFromCache(false);
    }
    if (_worldMapExpanded) {
        if (leafletMap && mapHeightMode !== 'HIDE') {
            setTimeout(() => leafletMap.invalidateSize(), 140);
        } else if (typeof loadWorldMap === 'function') {
            loadWorldMap(false);
        }
    }
}

function syncMapHeightButtons() {
    const heights = { SM: '220px', MD: '380px', LG: '540px' };
    const cardEl = document.getElementById('world-map-card');
    if (cardEl) {
        cardEl.classList.toggle('hidden', !_worldMapExpanded);
    }
    const mapEl = document.getElementById('world-map');
    if (mapEl) {
        mapEl.classList.remove('hidden');
        mapEl.style.height = heights[mapHeightMode] || '380px';
    }
    ['SM', 'MD', 'LG'].forEach(k => {
        const b = document.getElementById(`map-height-btn-${k}`);
        if (b) {
            b.classList.toggle('nav-item-active', k === mapHeightMode);
            b.classList.toggle('ui-pill', k !== mapHeightMode);
        }
    });
    const vpBtn = document.getElementById('map-viewport-filter-btn');
    if (vpBtn) {
        vpBtn.classList.toggle('nav-item-active', mapFilterByViewport);
        vpBtn.classList.toggle('ui-pill', !mapFilterByViewport);
    }
}

function setMapHeightMode(mode) {
    mapHeightMode = ['SM', 'MD', 'LG'].includes(mode) ? mode : 'MD';
    localStorage.setItem('phototo_map_height', mapHeightMode);
    _worldMapExpanded = true;
    syncMapHeightButtons();
    if (typeof renderPlacesOverviewFromCache === 'function') {
        renderPlacesOverviewFromCache(false);
    }
    if (leafletMap) {
        setTimeout(() => leafletMap.invalidateSize(), 140);
    }
}

function toggleMapViewportFilter() {
    mapFilterByViewport = !mapFilterByViewport;
    syncMapHeightButtons();
    renderPlacesOverviewFromCache(false);
}

function fitWorldMapToMarkers() {
    if (!leafletMap) return;
    if (mapHeightMode === 'HIDE') {
        setMapHeightMode('MD');
    }
    const pts = _lastMapPointsForFit.length ? _lastMapPointsForFit : [];
    setTimeout(() => {
        leafletMap.invalidateSize();
        if (pts.length === 1) {
            leafletMap.setView([pts[0].latitude, pts[0].longitude], 11);
        } else if (pts.length > 1) {
            const bounds = L.latLngBounds(pts.map(p => [p.latitude, p.longitude]));
            if (bounds.isValid()) leafletMap.fitBounds(bounds, { padding: [32, 32], maxZoom: 13 });
        } else {
            leafletMap.setView([46.6, 1.88], 5);
        }
    }, 100);
}

function setPlacesLayout(layout) {
    placesLayout = layout;
    localStorage.setItem('phototo_places_layout', layout);
    syncPlacesLayoutSizeButtons();
    renderPlacesOverviewFromCache(false);
}

function setPlacesSize(size) {
    placesSize = size;
    localStorage.setItem('phototo_places_size', size);
    syncPlacesLayoutSizeButtons();
    renderPlacesOverviewFromCache(false);
}

function togglePlacesSortOrder() {
    _toggleSortOrderInput('places-sort-order', 'places-sort-dir-btn', 'places-sort-arrow', onPlacesControlsChanged);
}

function onPlacesControlsChanged() {
    renderPlacesOverviewFromCache(true);
}

document.addEventListener('DOMContentLoaded', () => {
    syncPlacesLayoutSizeButtons();
    syncMapHeightButtons();
});

function togglePlacesFilterMenu(forceState) {
    const pop = document.getElementById('places-filter-popover');
    if (!pop) return;
    const willOpen = typeof forceState === 'boolean' ? forceState : pop.classList.contains('hidden');
    pop.classList.toggle('hidden', !willOpen);
}

function _getActivePlacesPeriodsList() {
    const list = selectedPlacesPeriods.slice();
    const df = document.getElementById('places-date-from')?.value || '';
    const dt = document.getElementById('places-date-to')?.value || '';
    if (df || dt) {
        if (!list.some(p => p.from === df && p.to === dt)) list.push({ from: df, to: dt });
    }
    return list;
}

function populatePlacesYearFilterOptions() {
    const ySel = document.getElementById('places-year');
    if (!ySel) return;
    const yearsSet = new Set();
    (_allPlacesBucketsList || []).forEach(pl => {
        if (pl.recent_ts > 0) yearsSet.add(String(new Date(pl.recent_ts * 1000).getFullYear()));
    });
    const years = Array.from(yearsSet).sort((a, b) => b.localeCompare(a));
    ySel.innerHTML = `<option value="">Années</option>` + years.map(y => `<option value="${y}">${y}</option>`).join('');
}

function togglePlacesMultiFilterValue(kind, selectEl) {
    if (!selectEl || !selectEl.value) return;
    const val = selectEl.value;
    selectEl.value = '';
    const map = { year: selectedPlacesYears, month: selectedPlacesMonths, content: selectedPlacesContents };
    const arr = map[kind];
    if (!arr) return;
    const idx = arr.indexOf(val);
    if (idx >= 0) arr.splice(idx, 1);
    else arr.push(val);
    renderPlacesOverviewFromCache(true);
}

function addPlacesPeriodFromInputs() {
    const dfEl = document.getElementById('places-date-from');
    const dtEl = document.getElementById('places-date-to');
    const df = dfEl?.value || '';
    const dt = dtEl?.value || '';
    if (!df && !dt) return;
    if (!selectedPlacesPeriods.some(p => p.from === df && p.to === dt)) {
        selectedPlacesPeriods.push({ from: df, to: dt });
    }
    if (dfEl) dfEl.value = '';
    if (dtEl) dtEl.value = '';
    renderPlacesOverviewFromCache(true);
}

function removePlacesFilterChip(kind, idx) {
    if (kind === 'year') selectedPlacesYears.splice(idx, 1);
    else if (kind === 'month') selectedPlacesMonths.splice(idx, 1);
    else if (kind === 'content') selectedPlacesContents.splice(idx, 1);
    else if (kind === 'period') selectedPlacesPeriods.splice(idx, 1);
    renderPlacesOverviewFromCache(true);
}

function resetAllPlacesFilters() {
    selectedPlacesYears = [];
    selectedPlacesMonths = [];
    selectedPlacesContents = [];
    selectedPlacesPeriods = [];
    const dfEl = document.getElementById('places-date-from');
    const dtEl = document.getElementById('places-date-to');
    if (dfEl) dfEl.value = '';
    if (dtEl) dtEl.value = '';
    renderPlacesOverviewFromCache(true);
}

function _renderPlacesFilterChipsAndBadge() {
    const contentLabels = {
        DOMESTIC: "Pays d'origine",
        FOREIGN: 'Étranger',
        HAS_FAVORITES: 'Avec favoris',
        MULTI_MEDIA: 'Plusieurs médias (2+)',
        SINGLE_MEDIA: '1 seul média'
    };
    const chips = [];
    selectedPlacesYears.forEach((y, i) => chips.push({ kind: 'year', idx: i, label: y }));
    selectedPlacesMonths.forEach((m, i) => chips.push({ kind: 'month', idx: i, label: (typeof SHORT_MONTHS_FR !== 'undefined' ? SHORT_MONTHS_FR[parseInt(m, 10)] : m) || m }));
    selectedPlacesPeriods.forEach((p, i) => chips.push({ kind: 'period', idx: i, label: `${p.from || '…'} → ${p.to || '…'}` }));
    selectedPlacesContents.forEach((c, i) => chips.push({ kind: 'content', idx: i, label: contentLabels[c] || c }));

    const container = document.getElementById('places-active-filter-chips');
    if (container) {
        if (!chips.length) {
            container.innerHTML = '';
            container.classList.add('hidden');
        } else {
            container.classList.remove('hidden');
            container.innerHTML = chips.map(c =>
                `<span class="plum-btn px-2 py-0.5 rounded-full text-[10px] font-extrabold inline-flex items-center gap-1">
                    <span>${c.label}</span>
                    <button type="button" onclick="event.stopPropagation(); removePlacesFilterChip('${c.kind}', ${c.idx})" class="hover:text-rose-200 font-bold">✕</button>
                </span>`
            ).join('');
        }
    }

    const totalCount = chips.length + ((document.getElementById('places-date-from')?.value || document.getElementById('places-date-to')?.value) ? 1 : 0);
    const countBadge = document.getElementById('places-filter-count');
    if (countBadge) {
        countBadge.textContent = String(totalCount);
        countBadge.classList.toggle('hidden', totalCount <= 0);
    }
    const filterBadge = document.getElementById('places-active-filter-badge');
    const filterText = document.getElementById('places-active-filter-text');
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

function _filterPlacesList(places) {
    const periods = _getActivePlacesPeriodsList();
    const locFilters = selectedPlacesContents.filter(c => c === 'DOMESTIC' || c === 'FOREIGN');
    const countFilters = selectedPlacesContents.filter(c => c === 'MULTI_MEDIA' || c === 'SINGLE_MEDIA');
    const needFavorites = selectedPlacesContents.includes('HAS_FAVORITES');

    return (places || []).filter(pl => {
        const ts = pl.recent_ts || 0;
        const dt = ts > 0 ? new Date(ts * 1000) : null;
        const yr = dt ? String(dt.getFullYear()) : '';
        const mo = dt ? String(dt.getMonth() + 1).padStart(2, '0') : '';

        const hasYM = selectedPlacesYears.length > 0 || selectedPlacesMonths.length > 0;
        const hasPer = periods.length > 0;
        if (hasYM || hasPer) {
            let matchYM = false;
            if (hasYM && dt) {
                const okY = !selectedPlacesYears.length || selectedPlacesYears.includes(yr);
                const okM = !selectedPlacesMonths.length || selectedPlacesMonths.includes(mo);
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

        if (locFilters.length > 0) {
            const okLoc = locFilters.some(c => (c === 'FOREIGN' && pl.is_foreign) || (c === 'DOMESTIC' && !pl.is_foreign));
            if (!okLoc) return false;
        }
        if (needFavorites && !pl.has_favorite) return false;
        if (countFilters.length > 0) {
            const cnt = Number(pl.count) || 0;
            const okCnt = countFilters.some(c => (c === 'MULTI_MEDIA' && cnt >= 2) || (c === 'SINGLE_MEDIA' && cnt === 1));
            if (!okCnt) return false;
        }
        return true;
    });
}

function _comparePlaceItems(a, b, sortBy = 'content', sortOrder = 'desc') {
    const dir = sortOrder === 'asc' ? 1 : -1;
    const nameA = (a.city || a.label || '').trim();
    const nameB = (b.city || b.label || '').trim();
    if (sortBy === 'name') {
        const diff = nameA.localeCompare(nameB, 'fr', { sensitivity: 'base' });
        if (diff !== 0) return dir * diff;
        return dir * ((Number(a.count) || 0) - (Number(b.count) || 0));
    }
    if (sortBy === 'recent') {
        const diff = (a.recent_ts || 0) - (b.recent_ts || 0);
        if (diff !== 0) return dir * diff;
    } else {
        const diff = (Number(a.count) || 0) - (Number(b.count) || 0);
        if (diff !== 0) return dir * diff;
        const rDiff = (a.recent_ts || 0) - (b.recent_ts || 0);
        if (rDiff !== 0) return dir * rDiff;
    }
    return nameA.localeCompare(nameB, 'fr', { sensitivity: 'base' });
}

function getPlacesGridClass() {
    if (placesLayout === 'LIST') {
        if (placesSize === 'SM') return 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2';
        if (placesSize === 'LG') return 'grid grid-cols-1 lg:grid-cols-2 gap-4';
        return 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3';
    }
    if (placesSize === 'SM') return 'grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-2.5';
    if (placesSize === 'LG') return 'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5';
    return 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4';
}

function _placeGroupKeyAndLabel(pl, groupBy) {
    if (groupBy === 'COUNTRY') {
        const grp = (pl.country || '').trim() || (pl.place_subtitle || '').trim() || 'Localisé';
        return { key: grp.toLowerCase(), label: grp };
    }
    if (groupBy === 'LETTER') {
        const raw = (pl.city || pl.label || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const ch = raw.charAt(0).toUpperCase();
        if (!ch || !/[A-Z]/.test(ch)) return { key: '#', label: '#' };
        return { key: ch, label: ch };
    }
    const ts = pl.recent_ts || 0;
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

function renderPlaceCardHTML(pl) {
    const idx = pl._idx;
    const titleTxt = escapeHtml(pl.city || pl.label || 'Lieu localisé');
    const subTxt = escapeHtml(pl.is_foreign && pl.place_subtitle ? pl.place_subtitle : (pl.country || ''));
    const cnt = Number(pl.count) || 0;
    const pinSvg = `<svg class="w-2.5 h-2.5 shrink-0 opacity-90" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`;

    if (placesLayout === 'LIST') {
        const thumbCls = placesSize === 'SM' ? 'w-10 h-10 rounded-xl' : (placesSize === 'LG' ? 'w-24 h-24 rounded-2xl' : 'w-16 h-16 rounded-2xl');
        const padCls = placesSize === 'SM' ? 'p-2 gap-2.5 rounded-2xl' : (placesSize === 'LG' ? 'p-3.5 gap-4 rounded-3xl' : 'p-2.5 gap-3.5 rounded-2xl');
        const titleCls = placesSize === 'SM' ? 'text-xs' : (placesSize === 'LG' ? 'text-base' : 'text-sm');
        const dateStr = pl.recent_ts ? new Date(pl.recent_ts * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
        const metaParts = [`${cnt} élément${cnt > 1 ? 's' : ''}`, subTxt, dateStr].filter(Boolean).join(' · ');

        return `
        <div onclick="openSinglePlaceView(${idx})" class="place-card ui-card ${padCls} flex items-center cursor-pointer group shadow-sm hover:shadow-lg transition-all duration-150">
            <div class="shrink-0 ${thumbCls} overflow-hidden ui-pill">
                ${renderMediaPreview(pl.cover, "w-full h-full object-cover group-hover:scale-105 transition-transform duration-300")}
            </div>
            <div class="flex-1 min-w-0">
                <div id="place-card-label-${idx}" class="font-extrabold ${titleCls} truncate leading-tight">${titleTxt}</div>
                <div id="place-card-meta-${idx}" class="text-[11px] opacity-60 font-semibold truncate mt-0.5">${metaParts}</div>
            </div>
        </div>`;
    }

    const radiusCls = placesSize === 'LG' ? 'rounded-[24px]' : (placesSize === 'SM' ? 'rounded-[16px]' : 'rounded-[20px]');
    const nameTxtCls = placesSize === 'LG' ? 'text-sm' : (placesSize === 'SM' ? 'text-[11px]' : 'text-xs');

    return `
    <div onclick="openSinglePlaceView(${idx})" class="place-card cursor-pointer group flex flex-col">
        <div class="ui-card aspect-square ${radiusCls} overflow-hidden relative shadow-sm group-hover:shadow-lg transition-all duration-200">
            ${renderMediaPreview(pl.cover, "w-full h-full object-cover group-hover:scale-105 transition-transform duration-300")}
            <div class="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/55 via-black/15 to-transparent opacity-70 group-hover:opacity-90 transition-opacity"></div>
            <span class="pointer-events-none absolute bottom-2 left-2 bg-black/45 backdrop-blur-md border border-white/15 text-white text-[10px] font-bold px-2 py-0.5 rounded-full inline-flex items-center gap-1 z-10">
                ${pinSvg}<span>${cnt}</span>
            </span>
        </div>
        <div class="pt-1.5 px-1">
            <div id="place-card-label-${idx}" class="${nameTxtCls} font-extrabold truncate leading-tight" title="${escapeHtml(pl.label)}">${titleTxt}</div>
            <div id="place-card-meta-${idx}" class="text-[10px] opacity-60 font-semibold mt-0.5 truncate">${subTxt || `${cnt} élément${cnt > 1 ? 's' : ''}`}</div>
        </div>
    </div>`;
}

function _syncMapMarkersToPlaces(filteredPlaces) {
    if (!leafletMap || !markerCluster) return;
    const pts = [];
    (filteredPlaces || []).forEach(pl => {
        (pl.items || []).forEach(pt => pts.push({ pt, pl }));
    });
    _lastMapPointsForFit = pts.map(x => x.pt);
    markerCluster.clearLayers();
    const markers = pts.map(({ pt, pl }) => {
        const sEnc = encodeURIComponent(pt.source_path || pt.dest_path);
        const dEnc = encodeURIComponent(pt.dest_path);
        const placeName = escapeHtml(pl.city || pl.label || 'Lieu localisé');
        const popupHtml = `
            <div class="space-y-1.5 w-44">
                <div onclick="openLightboxForCustomItem('${sEnc}', '${dEnc}', ${pt.timestamp || 0})" class="cursor-pointer rounded-xl overflow-hidden">
                    ${renderMediaPreview(pt.dest_path, "w-44 h-28 object-cover rounded-xl")}
                </div>
                <div class="flex items-center justify-between gap-2 text-[11px] font-bold">
                    <span class="truncate">${placeName}</span>
                    <button type="button" onclick="openSinglePlaceView(${pl._idx})" class="text-[10px] underline shrink-0 cursor-pointer">Ouvrir</button>
                </div>
            </div>`;
        return L.marker([pt.latitude, pt.longitude]).bindPopup(popupHtml);
    });
    markerCluster.addLayers(markers);
    const sumEl = document.getElementById('map-toolbar-summary');
    if (sumEl) {
        sumEl.textContent = `Carte interactive · ${pts.length} point${pts.length > 1 ? 's' : ''} sur ${(filteredPlaces || []).length} lieu${(filteredPlaces || []).length > 1 ? 'x' : ''}`;
    }
}

function renderWorldMapCompactCardHTML(placesCount, mediaCount) {
    const subText = `${placesCount} lieu${placesCount > 1 ? 'x' : ''} · ${mediaCount} média${mediaCount > 1 ? 's' : ''}`;
    if (placesLayout === 'LIST') {
        const thumbCls = placesSize === 'SM' ? 'w-10 h-10 rounded-xl' : (placesSize === 'LG' ? 'w-24 h-24 rounded-2xl' : 'w-16 h-16 rounded-2xl');
        const padCls = placesSize === 'SM' ? 'p-2 gap-2.5 rounded-2xl' : (placesSize === 'LG' ? 'p-3.5 gap-4 rounded-3xl' : 'p-2.5 gap-3.5 rounded-2xl');
        const titleCls = placesSize === 'SM' ? 'text-xs' : (placesSize === 'LG' ? 'text-base' : 'text-sm');
        return `
        <div id="world-map-compact-card" onclick="toggleWorldMapExpanded(true)"
             class="ui-card flex items-center ${padCls} cursor-pointer transition-all hover:bg-[var(--bg-hover)] group">
            <div class="relative ${thumbCls} shrink-0 overflow-hidden bg-gradient-to-br from-sky-500/20 via-emerald-500/15 to-indigo-500/20 border border-[var(--border-subtle)] flex items-center justify-center">
                <svg class="w-1/2 h-1/2 text-sky-400 group-hover:scale-110 transition-transform" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                    <circle cx="12" cy="10" r="3"/>
                </svg>
            </div>
            <div class="min-w-0 flex-1">
                <p class="font-extrabold ${titleCls} truncate">Carte interactive</p>
                <p class="text-[11px] opacity-60 font-medium truncate">${subText}</p>
            </div>
        </div>`;
    }

    const radiusCls = placesSize === 'LG' ? 'rounded-[24px]' : (placesSize === 'SM' ? 'rounded-[16px]' : 'rounded-[20px]');
    const nameTxtCls = placesSize === 'LG' ? 'text-sm' : (placesSize === 'SM' ? 'text-[11px]' : 'text-xs');
    const placesCountLabel = `${placesCount} lieu${placesCount > 1 ? 'x' : ''}`;
    return `
    <div id="world-map-compact-card" onclick="toggleWorldMapExpanded(true)"
         class="place-card cursor-pointer group flex flex-col">
        <div class="ui-card aspect-square ${radiusCls} overflow-hidden relative shadow-sm group-hover:shadow-lg transition-all duration-200 bg-gradient-to-br from-sky-500/20 via-emerald-500/15 to-indigo-500/20 flex items-center justify-center">
            <svg class="absolute inset-0 w-full h-full p-5 opacity-15 pointer-events-none" fill="none" stroke="currentColor" stroke-width="1" viewBox="0 0 24 24">
                <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/>
                <line x1="8" y1="2" x2="8" y2="18"/>
                <line x1="16" y1="6" x2="16" y2="22"/>
            </svg>
            <div class="relative z-10 w-12 h-12 rounded-2xl bg-[var(--bg-card)]/90 border border-[var(--border-subtle)] shadow-md flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
                <svg class="w-6 h-6 text-sky-400" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24">
                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                    <circle cx="12" cy="10" r="3"/>
                </svg>
            </div>
        </div>
        <div class="pt-1.5 px-1">
            <div class="${nameTxtCls} font-extrabold truncate leading-tight">Carte interactive</div>
            <div class="text-[10px] opacity-60 font-semibold mt-0.5 truncate">${placesCountLabel}</div>
        </div>
    </div>`;
}

function renderPlacesOverviewFromCache(syncMarkers = true) {
    const grid = document.getElementById('places-cards-grid');
    if (!grid) return;

    const activeFilterCount = _renderPlacesFilterChipsAndBadge();
    const sortBy = document.getElementById('places-sort-by')?.value || 'content';
    const sortOrder = document.getElementById('places-sort-order')?.value || 'desc';
    const groupBy = document.getElementById('places-group-by')?.value || 'NONE';

    const groupFiltered = typeof filterItemsByActiveCustomGroup === 'function'
        ? filterItemsByActiveCustomGroup('places', _allPlacesBucketsList, pl => pl.bucket_key)
        : _allPlacesBucketsList;
    const filteredBase = _filterPlacesList(groupFiltered);

    if (syncMarkers) {
        _syncMapMarkersToPlaces(filteredBase);
    }

    let viewportFiltered = filteredBase;
    if (mapFilterByViewport && leafletMap && mapHeightMode !== 'HIDE') {
        const bounds = leafletMap.getBounds();
        if (bounds && bounds.isValid()) {
            viewportFiltered = filteredBase.filter(pl => bounds.contains([pl.lat, pl.lon]));
        }
    }

    const totalMediaCount = viewportFiltered.reduce((acc, pl) => acc + (Number(pl.count) || 0), 0);
    const statsEl = document.getElementById('map-stats-label');
    if (statsEl) {
        statsEl.textContent = `${viewportFiltered.length} lieu${viewportFiltered.length > 1 ? 'x' : ''} · ${totalMediaCount} média${totalMediaCount > 1 ? 's' : ''}`;
    }

    const sorted = [...viewportFiltered].sort((a, b) => _comparePlaceItems(a, b, sortBy, sortOrder));
    const gridCls = getPlacesGridClass();
    const mapCompactCardHtml = !_worldMapExpanded
        ? renderWorldMapCompactCardHTML(viewportFiltered.length, totalMediaCount)
        : '';

    if (!sorted.length) {
        const hasGrp = typeof activeCustomGroupId !== 'undefined' && activeCustomGroupId.places !== null;
        let emptyMsg = 'Aucun média géolocalisé pour le moment. Cliquez sur « Ajouter » pour localiser vos photos.';
        if (mapFilterByViewport && filteredBase.length > 0) emptyMsg = 'Aucun lieu dans la zone actuellement visible sur la carte.';
        else if (activeFilterCount > 0) emptyMsg = 'Aucun lieu ne correspond aux filtres sélectionnés.';
        else if (hasGrp) emptyMsg = 'Aucun lieu dans ce groupe.';
        grid.className = `${gridCls} pb-10`;
        grid.innerHTML = `${mapCompactCardHtml}<div class="col-span-full ui-card rounded-3xl p-8 text-center text-sm font-semibold opacity-60">${emptyMsg}</div>`;
        if (typeof updateFloatingGroupPill === 'function') updateFloatingGroupPill();
        return;
    }

    if (groupBy !== 'NONE') {
        const groups = [];
        const groupMap = new Map();
        sorted.forEach(pl => {
            const { key, label } = _placeGroupKeyAndLabel(pl, groupBy);
            if (!groupMap.has(key)) {
                const g = { key, label, items: [] };
                groupMap.set(key, g);
                groups.push(g);
            }
            groupMap.get(key).items.push(pl);
        });
        grid.className = 'space-y-6 pb-10';
        const compactWrapperHtml = mapCompactCardHtml
            ? `<div class="${gridCls}">${mapCompactCardHtml}</div>`
            : '';
        grid.innerHTML = compactWrapperHtml + groups.map(g => `
            <section class="space-y-3 group-section">
                <div class="flex items-center justify-between">
                    <h3 class="group-section-title text-sm font-extrabold tracking-tight">${escapeHtml(g.label)}</h3>
                    <span class="text-[11px] font-bold opacity-55">${g.items.length} lieu${g.items.length > 1 ? 'x' : ''}</span>
                </div>
                <div class="${gridCls}">
                    ${g.items.map(renderPlaceCardHTML).join('')}
                </div>
            </section>
        `).join('');
        if (typeof updateFloatingGroupPill === 'function') updateFloatingGroupPill();
        return;
    }

    grid.className = `${gridCls} pb-10`;
    grid.innerHTML = mapCompactCardHtml + sorted.map(renderPlaceCardHTML).join('');
    if (typeof updateFloatingGroupPill === 'function') updateFloatingGroupPill();
}

function closeSinglePlaceView() {
    _openedPlaceBucketIdx = -1;
    _openedPlaceBucketKey = '';
    selectedGalleryPaths.clear();
    if (typeof updateGalleryBatchBar === 'function') updateGalleryBatchBar();
    if (typeof _mountFilterDrawerForActiveView === 'function') _mountFilterDrawerForActiveView(false);
    const single = document.getElementById('place-single-panel');
    const overview = document.getElementById('map-overview-panel');
    if (single) single.classList.add('hidden');
    if (overview) overview.classList.remove('hidden');
    if (typeof _syncTopbarOptionsButton === 'function') _syncTopbarOptionsButton();
    if (typeof updateFloatingGroupPill === 'function') updateFloatingGroupPill();
    if (leafletMap && mapHeightMode !== 'HIDE') setTimeout(() => leafletMap.invalidateSize(), 120);
}

function focusOpenedPlaceOnMap() {
    const pl = _placesBucketsList[_openedPlaceBucketIdx];
    if (!pl) return;
    closeSinglePlaceView();
    toggleWorldMapExpanded(true);
    const scroller = document.getElementById('main-scroll-container');
    if (scroller) scroller.scrollTop = 0;
    if (leafletMap) {
        setTimeout(() => {
            leafletMap.invalidateSize();
            leafletMap.setView([pl.lat, pl.lon], 12);
        }, 160);
    }
}

function _sortSinglePlaceItems(rawItems) {
    const sortBy = document.getElementById('gal-sort-by')?.value || 'date';
    const sortOrd = (document.getElementById('gal-sort-order')?.value || 'desc').toLowerCase();
    const dir = sortOrd === 'asc' ? 1 : -1;
    return [...(rawItems || [])].sort((a, b) => {
        if (sortBy === 'name') {
            return dir * (a.dest_path || a.source_path || '').localeCompare(b.dest_path || b.source_path || '', 'fr', { sensitivity: 'base' });
        }
        if (sortBy === 'modified') {
            return dir * ((a.modified_at || a.timestamp || 0) - (b.modified_at || b.timestamp || 0));
        }
        if (sortBy === 'added') {
            return dir * ((a.added_id || 0) - (b.added_id || 0));
        }
        return dir * ((a.timestamp || 0) - (b.timestamp || 0));
    });
}

function openSinglePlaceView(idx) {
    const pl = _placesBucketsList[idx];
    if (!pl) return;
    const isSamePlace = (_openedPlaceBucketIdx === idx && _openedPlaceBucketKey === pl.bucket_key);
    _openedPlaceBucketIdx = idx;
    _openedPlaceBucketKey = pl.bucket_key || '';
    if (!isSamePlace) {
        selectedGalleryPaths.clear();
        if (typeof updateGalleryBatchBar === 'function') updateGalleryBatchBar();
        togglePlacesFilterMenu(false);
        if (typeof _setOptionsDrawerState === 'function') _setOptionsDrawerState('places-options-drawer', 'places-options-btn', false);
        if (typeof applyPageDefaultOptions === 'function') applyPageDefaultOptions('place_single', false);
    }

    const overview = document.getElementById('map-overview-panel');
    const single = document.getElementById('place-single-panel');
    if (overview) overview.classList.add('hidden');
    if (single) single.classList.remove('hidden');
    if (typeof _syncTopbarOptionsButton === 'function') _syncTopbarOptionsButton();

    const titleEl = document.getElementById('single-place-title');
    const subEl = document.getElementById('single-place-subtitle');
    const cntEl = document.getElementById('single-place-count');

    if (titleEl) titleEl.textContent = pl.city || pl.label || 'Lieu localisé';
    if (subEl) {
        const foreignTxt = pl.is_foreign && pl.place_subtitle ? pl.place_subtitle : (pl.country && pl.country !== pl.city ? pl.country : '');
        subEl.textContent = foreignTxt;
        subEl.classList.toggle('hidden', !foreignTxt);
    }

    const sortedItems = _sortSinglePlaceItems(pl.items);
    if (cntEl) cntEl.textContent = `${sortedItems.length} élément${sortedItems.length > 1 ? 's' : ''}`;

    currentGalleryItems = sortedItems;
    lightboxIsCustomItem = false;
    const gridEl = document.getElementById('place-single-grid');
    if (gridEl) {
        gridEl.className = 'space-y-6';
        appendMediaBatchToContainer('place-single-grid', sortedItems, 0, true);
    }
    if (typeof updateFloatingGroupPill === 'function') updateFloatingGroupPill();
}

function _normalizePlaceKeyPart(val) {
    return String(val || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function _reindexPlacesBuckets(list) {
    list.sort((a, b) => b.count - a.count);
    list.forEach((pl, i) => { pl._idx = i; });
    _placesBucketsList = list;
    _allPlacesBucketsList = list;
    if (_openedPlaceBucketKey) {
        const match = list.find(p => p.bucket_key === _openedPlaceBucketKey);
        _openedPlaceBucketIdx = match ? match._idx : -1;
    }
}

async function loadWorldMap(force) {
    closeSinglePlaceView();
    syncPlacesLayoutSizeButtons();
    syncMapHeightButtons();
    if (!leafletMap) {
        leafletMap = L.map('world-map').setView([46.6, 1.88], 5);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(leafletMap);
        markerCluster = L.markerClusterGroup({chunkedLoading: true});
        leafletMap.addLayer(markerCluster);
        leafletMap.on('moveend', () => {
            if (mapFilterByViewport) renderPlacesOverviewFromCache(false);
        });
    }
    if (mapHeightMode !== 'HIDE') {
        setTimeout(() => leafletMap.invalidateSize(), 150);
    }
    const res = await fetch('/api/map/points');
    const d = await res.json();
    const pts = d.points || [];

    const bucketsMap = new Map();
    pts.forEach(pt => {
        const hasCachedCity = Boolean(pt.city && String(pt.city).trim());
        const cityNorm = _normalizePlaceKeyPart(pt.city);
        const countryNorm = _normalizePlaceKeyPart(pt.country);
        const key = hasCachedCity && cityNorm
            ? `city:${cityNorm}|${countryNorm}`
            : `coord:${pt.latitude.toFixed(2)}, ${pt.longitude.toFixed(2)}`;
        if (!bucketsMap.has(key)) {
            const sub = (pt.is_foreign && pt.place_subtitle) ? String(pt.place_subtitle).trim() : '';
            const cName = hasCachedCity ? String(pt.city).trim() : (pt.album_name || 'Lieu localisé');
            const dispLbl = hasCachedCity
                ? ((cName && sub) ? `${cName} · ${sub}` : (cName || pt.place_label || 'Lieu localisé'))
                : (pt.album_name || 'Lieu localisé');
            bucketsMap.set(key, {
                bucket_key: key,
                label: dispLbl,
                city: cName,
                country: hasCachedCity ? String(pt.country || '').trim() : '',
                place_subtitle: sub,
                is_foreign: Boolean(hasCachedCity && pt.is_foreign),
                _geocoded: hasCachedCity,
                count: 0,
                recent_ts: 0,
                has_favorite: false,
                cover: pt.dest_path,
                lat: pt.latitude,
                lon: pt.longitude,
                items: [],
            });
        }
        const b = bucketsMap.get(key);
        b.count++;
        if ((pt.timestamp || 0) > b.recent_ts) {
            b.recent_ts = pt.timestamp || 0;
        }
        if (pt.is_favorite) b.has_favorite = true;
        b.items.push(pt);
    });
    const allPlaces = Array.from(bucketsMap.values());
    _reindexPlacesBuckets(allPlaces);
    populatePlacesYearFilterOptions();
    if (typeof loadCustomGroups === 'function') await loadCustomGroups('places');
    renderPlacesOverviewFromCache(true);

    let reRenderTimer = null;
    const schedulePlacesMergeRender = () => {
        clearTimeout(reRenderTimer);
        reRenderTimer = setTimeout(() => {
            _reindexPlacesBuckets(allPlaces);
            populatePlacesYearFilterOptions();
            renderPlacesOverviewFromCache(true);
            if (_openedPlaceBucketIdx >= 0) {
                openSinglePlaceView(_openedPlaceBucketIdx);
            }
        }, 140);
    };

    const queue = allPlaces.filter(pl => !pl._geocoded);
    const worker = async () => {
        while (queue.length) {
            const pl = queue.shift();
            if (!pl) break;
            try {
                const gRes = await fetch(`/api/map/reverse?lat=${encodeURIComponent(pl.lat)}&lon=${encodeURIComponent(pl.lon)}`);
                if (!gRes.ok) continue;
                const geo = await gRes.json();
                const city = (geo.city || '').trim();
                const country = (geo.country || '').trim();
                const sub = (geo.is_foreign && geo.place_subtitle) ? geo.place_subtitle.trim() : '';
                const displayLabel = (city && sub) ? `${city} · ${sub}` : (city || geo.label || pl.label);

                const cityNorm = _normalizePlaceKeyPart(city);
                const countryNorm = _normalizePlaceKeyPart(country);
                const targetKey = cityNorm ? `city:${cityNorm}|${countryNorm}` : pl.bucket_key;

                const existing = (targetKey !== pl.bucket_key) ? bucketsMap.get(targetKey) : null;
                if (existing && existing !== pl) {
                    existing.items.push(...pl.items);
                    existing.count += pl.count;
                    if (pl.recent_ts > existing.recent_ts) existing.recent_ts = pl.recent_ts;
                    if (pl.has_favorite) existing.has_favorite = true;
                    const rmIdx = allPlaces.indexOf(pl);
                    if (rmIdx >= 0) allPlaces.splice(rmIdx, 1);
                    if (_openedPlaceBucketKey === pl.bucket_key) {
                        _openedPlaceBucketKey = targetKey;
                    }
                    schedulePlacesMergeRender();
                    continue;
                }

                if (targetKey !== pl.bucket_key) {
                    bucketsMap.delete(pl.bucket_key);
                    if (_openedPlaceBucketKey === pl.bucket_key) {
                        _openedPlaceBucketKey = targetKey;
                    }
                    pl.bucket_key = targetKey;
                    bucketsMap.set(targetKey, pl);
                }

                pl.city = city || pl.label;
                pl.country = country;
                pl.place_subtitle = sub;
                pl.is_foreign = Boolean(geo.is_foreign);
                pl.label = displayLabel;
                pl._geocoded = true;
                schedulePlacesMergeRender();
            } catch (e) {}
        }
    };
    if (queue.length) {
        Promise.all([0, 1, 2, 3].map(() => worker()));
    }
}

// ==================== DOUBLONS & SIMILAIRES ====================

const _cmpViewState = {
    dups: {
        layout: localStorage.getItem('phototo_dups_layout') === 'MASONRY' ? 'MASONRY' : 'GRID',
        size: localStorage.getItem('phototo_dups_size') || 'MD',
        autoMode: 'KEEP_ONE',
        extraPriorities: [],
        cache: [],
    },
    similar: {
        layout: localStorage.getItem('phototo_similar_layout') === 'MASONRY' ? 'MASONRY' : 'GRID',
        size: localStorage.getItem('phototo_similar_size') || 'MD',
        autoMode: 'KEEP_ONE',
        extraPriorities: [],
        cache: [],
    },
};

function syncComparisonLayoutSizeButtons(kind) {
    const st = _cmpViewState[kind];
    if (!st) return;
    ['GRID', 'MASONRY'].forEach(l => {
        const b = document.getElementById(`${kind}-layout-btn-${l}`);
        if (b) {
            b.classList.toggle('nav-item-active', l === st.layout);
            b.classList.toggle('ui-pill', l !== st.layout);
        }
    });
    ['SM', 'MD', 'LG'].forEach(s => {
        const b = document.getElementById(`${kind}-size-btn-${s}`);
        if (b) {
            b.classList.toggle('nav-item-active', s === st.size);
            b.classList.toggle('ui-pill', s !== st.size);
        }
    });
}

function setComparisonLayout(kind, layout) {
    if (!_cmpViewState[kind]) return;
    _cmpViewState[kind].layout = layout;
    localStorage.setItem(`phototo_${kind}_layout`, layout);
    syncComparisonLayoutSizeButtons(kind);
    renderComparisonGroupsFromCache(kind);
}

function setComparisonSize(kind, size) {
    if (!_cmpViewState[kind]) return;
    _cmpViewState[kind].size = size;
    localStorage.setItem(`phototo_${kind}_size`, size);
    syncComparisonLayoutSizeButtons(kind);
    renderComparisonGroupsFromCache(kind);
}

function toggleComparisonSortOrder(kind) {
    _toggleSortOrderInput(`${kind}-sort-order`, `${kind}-sort-dir-btn`, `${kind}-sort-arrow`, () => onComparisonControlsChanged(kind));
}

function onComparisonControlsChanged(kind) {
    renderComparisonGroupsFromCache(kind);
}

document.addEventListener('DOMContentLoaded', () => {
    syncComparisonLayoutSizeButtons('dups');
    syncComparisonLayoutSizeButtons('similar');
});

function togglePageAutoPanel(kind, forceState) {
    const panel = document.getElementById(`${kind}-auto-panel`);
    const btn = document.getElementById(`${kind}-auto-btn`);
    if (!panel) return;
    const willShow = typeof forceState === 'boolean' ? forceState : panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !willShow);
    if (btn) {
        btn.classList.toggle('nav-item-active', willShow);
        btn.classList.toggle('ui-pill', !willShow);
    }
}

function setPageAutoMode(kind, mode) {
    const st = _cmpViewState[kind];
    if (!st) return;
    st.autoMode = mode === 'KEEP_BOTH' ? 'KEEP_BOTH' : 'KEEP_ONE';
    const isKeepBoth = st.autoMode === 'KEEP_BOTH';
    const prioBox = document.getElementById(`${kind}-auto-priority-box`);
    const chkBox = document.getElementById(`${kind}-auto-checks-box`);
    if (prioBox) prioBox.classList.toggle('opacity-45', isKeepBoth);
    if (chkBox) chkBox.classList.toggle('opacity-45', isKeepBoth);
}

function _getPageAutoPriorities(kind) {
    const primary = document.getElementById(`${kind}-auto-priority`)?.value || 'BEST_QUALITY';
    const extras = _cmpViewState[kind]?.extraPriorities || [];
    return [primary, ...extras].filter(Boolean);
}

function _renderPageExtraPriorities(kind) {
    const st = _cmpViewState[kind];
    if (!st) return;
    renderExtraPriorityRows(
        `${kind}-extra-priorities`,
        `${kind}-add-priority-btn`,
        st.extraPriorities || [],
        'onPageExtraPriorityChange',
        'removePageAutoPriority',
        `'${kind}'`
    );
}

function addPageAutoPriority(kind) {
    const st = _cmpViewState[kind];
    if (!st) return;
    const next = pickNextUnusedPriority(_getPageAutoPriorities(kind));
    if (!next) return;
    st.extraPriorities = [...(st.extraPriorities || []), next];
    _renderPageExtraPriorities(kind);
    onComparisonControlsChanged(kind);
}

function onPageExtraPriorityChange(kind, selectEl) {
    const st = _cmpViewState[kind];
    if (!st) return;
    const idx = Number(selectEl?.dataset?.extraPriorityIdx);
    if (Number.isInteger(idx) && idx >= 0 && idx < (st.extraPriorities || []).length) {
        st.extraPriorities[idx] = selectEl.value;
        onComparisonControlsChanged(kind);
    }
}

function removePageAutoPriority(kind, idx) {
    const st = _cmpViewState[kind];
    if (!st) return;
    st.extraPriorities = (st.extraPriorities || []).filter((_, i) => i !== idx);
    _renderPageExtraPriorities(kind);
    onComparisonControlsChanged(kind);
}

function _compareSinglePriority(a, b, prio) {
    if (prio === 'NEWEST') return (b.timestamp || 0) - (a.timestamp || 0);
    if (prio === 'OLDEST') {
        const tsA = a.timestamp || 9999999999;
        const tsB = b.timestamp || 9999999999;
        return tsA - tsB;
    }
    if (prio === 'LARGEST') return (b.file_size || 0) - (a.file_size || 0);
    const pxA = (a.width || 0) * (a.height || 0);
    const pxB = (b.width || 0) * (b.height || 0);
    return pxB - pxA;
}

function _orderComparisonItemsByPriority(items, priority = 'BEST_QUALITY') {
    const prioList = Array.isArray(priority)
        ? (priority.length ? priority : ['BEST_QUALITY'])
        : [priority || 'BEST_QUALITY'];
    return [...(items || [])].sort((a, b) => {
        for (const prio of prioList) {
            const cmp = _compareSinglePriority(a, b, prio);
            if (cmp !== 0) return cmp;
        }
        return (b.file_size || 0) - (a.file_size || 0);
    });
}

function _exactMatchItemKey(it) {
    return `${Number(it.timestamp || it.modified_at || 0)}|${Number(it.width || 0)}x${Number(it.height || 0)}|${Number(it.file_size || 0)}`;
}

function _partitionComparisonBuckets(items, exactOnly = false) {
    if (!exactOnly) return items && items.length >= 2 ? [items] : [];
    const map = new Map();
    (items || []).forEach(it => {
        const k = _exactMatchItemKey(it);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(it);
    });
    return [...map.values()].filter(b => b.length >= 2);
}

function _collectWinnersAndLosers(items, priorities, exactOnly = false) {
    const buckets = _partitionComparisonBuckets(items, exactOnly);
    const winners = [];
    const losers = [];
    buckets.forEach(bucket => {
        const ordered = _orderComparisonItemsByPriority(bucket, priorities);
        if (ordered[0]) winners.push(ordered[0]);
        losers.push(...ordered.slice(1));
    });
    return { winners, losers };
}

function _updateCheckedDeleteButtons() {
    const has = checkedDuplicatePaths.size > 0;
    const dBtn = document.getElementById('btn-delete-checked-dups');
    const sBtn = document.getElementById('btn-delete-checked-sims');
    if (dBtn) {
        dBtn.classList.toggle('hidden', !has);
        if (has) dBtn.textContent = `Supprimer la sélection (${checkedDuplicatePaths.size})`;
    }
    if (sBtn) {
        sBtn.classList.toggle('hidden', !has);
        if (has) sBtn.textContent = `Supprimer la sélection (${checkedDuplicatePaths.size})`;
    }
}

function previewPageAutoSelect(kind) {
    const st = _cmpViewState[kind];
    if (!st) return;
    const prios = _getPageAutoPriorities(kind);
    const exactOnly = Boolean(document.getElementById(`${kind}-auto-chk-exact-only`)?.checked);
    const fb = document.getElementById(`${kind}-auto-feedback`);
    if (st.autoMode === 'KEEP_BOTH') {
        st.cache.forEach(g => g.items.forEach(it => checkedDuplicatePaths.delete(it.source_path)));
        _updateCheckedDeleteButtons();
        renderComparisonGroupsFromCache(kind);
        if (fb) fb.textContent = 'Aucun fichier pré-coché (mode Garder tous les fichiers).';
        return;
    }
    let count = 0;
    st.cache.forEach(g => {
        g.items.forEach(it => checkedDuplicatePaths.delete(it.source_path));
        const { winners, losers } = _collectWinnersAndLosers(g.items, prios, exactOnly);
        winners.forEach(it => checkedDuplicatePaths.delete(it.source_path));
        losers.forEach(it => {
            if (it.source_path) {
                checkedDuplicatePaths.add(it.source_path);
                count++;
            }
        });
    });
    _updateCheckedDeleteButtons();
    renderComparisonGroupsFromCache(kind);
    if (fb) {
        fb.textContent = count > 0
            ? `${count} fichier${count > 1 ? 's' : ''} pré-coché${count > 1 ? 's' : ''} selon la priorité.`
            : (exactOnly ? 'Aucun doublon exact correspondant à pré-cocher.' : 'Aucun fichier à pré-cocher.');
    }
}

async function submitPageAutoResolve(kind) {
    const st = _cmpViewState[kind];
    if (!st) return;
    const prios = _getPageAutoPriorities(kind);
    const exactOnly = Boolean(document.getElementById(`${kind}-auto-chk-exact-only`)?.checked);
    const updateAlbums = Boolean(document.getElementById(`${kind}-auto-chk-albums`)?.checked);
    const moveToTrash = Boolean(document.getElementById(`${kind}-auto-chk-trash`)?.checked);
    const fb = document.getElementById(`${kind}-auto-feedback`);
    const url = kind === 'dups' ? '/api/duplicates/auto_resolve' : '/api/similar/auto_resolve';
    if (fb) fb.textContent = 'Traitement automatique en cours...';
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mode: st.autoMode,
                priority: prios[0] || 'BEST_QUALITY',
                priorities: prios,
                exact_only: exactOnly,
                update_albums: updateAlbums,
                move_to_trash: moveToTrash,
            }),
        });
        if (!res.ok) {
            if (fb) fb.textContent = `Erreur (HTTP ${res.status}).`;
            return;
        }
        const d = await res.json();
        checkedDuplicatePaths.clear();
        _updateCheckedDeleteButtons();
        if (fb) {
            fb.textContent = d.status === 'kept_both'
                ? '✓ Tous les fichiers ont été conservés.'
                : `✓ ${d.resolved_count || 0} fichier${(d.resolved_count || 0) > 1 ? 's' : ''} traité${(d.resolved_count || 0) > 1 ? 's' : ''}.`;
        }
        await Promise.all([loadDuplicates(), loadSimilarGroups(), loadStats()]);
    } catch (e) {
        if (fb) fb.textContent = 'Erreur réseau lors du traitement.';
    }
}

function selectGroupLosers(kind, groupCacheIdx) {
    const st = _cmpViewState[kind];
    if (!st || !st.cache[groupCacheIdx]) return;
    const prios = _getPageAutoPriorities(kind);
    const exactOnly = Boolean(document.getElementById(`${kind}-auto-chk-exact-only`)?.checked);
    const { winners, losers } = _collectWinnersAndLosers(st.cache[groupCacheIdx].items, prios, exactOnly);
    const allAlreadyChecked = losers.length > 0 && losers.every(it => checkedDuplicatePaths.has(it.source_path));
    winners.forEach(it => checkedDuplicatePaths.delete(it.source_path));
    losers.forEach(it => {
        if (allAlreadyChecked) checkedDuplicatePaths.delete(it.source_path);
        else checkedDuplicatePaths.add(it.source_path);
    });
    _updateCheckedDeleteButtons();
    renderComparisonGroupsFromCache(kind);
}

function _getComparisonBestMetrics(items) {
    const pxList = (items || []).map(it => (it.width || 0) * (it.height || 0));
    const maxPx = Math.max(0, ...pxList);
    const hasPxDiff = new Set(pxList.filter(Boolean)).size > 1;
    const szList = (items || []).map(it => it.file_size || 0);
    const maxBytes = Math.max(0, ...szList);
    const hasSzDiff = new Set(szList.filter(Boolean)).size > 1;
    const tsList = (items || []).map(it => it.timestamp || it.modified_at || 0).filter(Boolean);
    const minTs = tsList.length ? Math.min(...tsList) : 0;
    const maxTs = tsList.length ? Math.max(...tsList) : 0;
    const hasTsDiff = new Set(tsList).size > 1;
    return { maxPx, hasPxDiff, maxBytes, hasSzDiff, minTs, maxTs, hasTsDiff };
}

function _getItemTraitBadges(item, best, darkSurface = false) {
    const badges = [];
    const px = (item.width || 0) * (item.height || 0);
    const sz = item.file_size || 0;
    const tsVal = item.timestamp || item.modified_at || 0;
    if (best?.hasPxDiff && px > 0 && px === best.maxPx) {
        badges.push({ label: 'Meilleure qualité', cls: darkSurface ? 'bg-emerald-500/20 text-emerald-300 border-emerald-400/35' : 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' });
    }
    if (best?.hasSzDiff && sz > 0 && sz === best.maxBytes) {
        badges.push({ label: 'Plus gros', cls: darkSurface ? 'bg-sky-500/20 text-sky-300 border-sky-400/35' : 'bg-sky-500/15 text-sky-400 border-sky-500/30' });
    }
    if (best?.hasTsDiff && tsVal > 0) {
        if (tsVal === best.minTs) {
            badges.push({ label: 'Plus ancien', cls: darkSurface ? 'bg-amber-500/20 text-amber-300 border-amber-400/35' : 'bg-amber-500/15 text-amber-400 border-amber-500/30' });
        } else if (tsVal === best.maxTs) {
            badges.push({ label: 'Plus récent', cls: darkSurface ? 'bg-violet-500/20 text-violet-300 border-violet-400/35' : 'bg-violet-500/15 text-violet-400 border-violet-500/30' });
        }
    }
    return badges.map(b => `<span class="border px-2 py-0.5 rounded-full text-[9px] font-extrabold ${b.cls}">${b.label}</span>`).join('');
}

function renderComparisonCard(item, opts = {}) {
    const sEnc = encodeURIComponent(item.source_path || '');
    const dEnc = encodeURIComponent(item.dest_path || '');
    const fname = escapeHtml((item.dest_path || '').split(/[\\/]/).pop() || 'Fichier');
    const folder = escapeHtml((item.dest_path || '').split(/[\\/]/).slice(0, -1).join('/'));
    const mb = item.file_size ? _formatBytesReadable(item.file_size) : '—';
    const dim = (item.width && item.height) ? `${item.width}×${item.height}` : '—';
    const isChk = checkedDuplicatePaths.has(item.source_path);
    const isWinner = Boolean(opts.isWinner);
    const layout = opts.layout || 'GRID';
    const size = opts.size || 'MD';
    const best = opts.best || {};
    const px = (item.width || 0) * (item.height || 0);
    const isBestPx = Boolean(best.hasPxDiff && px > 0 && px === best.maxPx);
    const isBestSz = Boolean(best.hasSzDiff && (item.file_size || 0) > 0 && item.file_size === best.maxBytes);
    const albumsTxt = (item.album_name || '').trim();

    const chkVisual = isChk
        ? 'select-badge-checked opacity-100'
        : 'bg-black/45 backdrop-blur-md text-white/90 border border-white/25 opacity-85 hover:opacity-100 hover:bg-black/65';
    const roleBadge = isChk
        ? `<span class="bg-rose-500/20 text-rose-400 border border-rose-500/35 px-2 py-0.5 rounded-full text-[10px] font-extrabold shrink-0">À supprimer</span>`
        : (isWinner
            ? `<span class="bg-emerald-500/20 text-emerald-400 border border-emerald-500/35 px-2 py-0.5 rounded-full text-[10px] font-extrabold shrink-0">★ Conservé</span>`
            : `<span class="ui-card px-2 py-0.5 rounded-full text-[10px] font-bold opacity-65 shrink-0">Copie</span>`);
    const cardStateCls = isChk
        ? 'border border-rose-500/55 bg-rose-500/[0.06]'
        : (isWinner
            ? 'border border-emerald-500/45 bg-emerald-500/[0.05]'
            : 'border border-white/10 hover:border-white/25');
    const clickHandler = (opts.kind && opts.groupCacheIdx !== undefined)
        ? `openComparisonItemLightbox('${opts.kind}', ${opts.groupCacheIdx}, '${sEnc}')`
        : `openLightboxForCustomItem('${sEnc}', '${dEnc}', ${item.timestamp || 0})`;
    const tsVal = item.timestamp || item.modified_at || 0;
    const dateStr = formatDate(tsVal);
    const timeStr = formatTime(tsVal);
    const dateTimeStr = formatDateTime(tsVal);
    const traitBadgesHtml = _getItemTraitBadges(item, best, false);

    if (layout === 'MASONRY') {
        const mediaMaxH = size === 'SM' ? 'max-h-40' : (size === 'LG' ? 'max-h-80' : 'max-h-56');
        const padCls = size === 'SM' ? 'p-2.5 rounded-2xl' : (size === 'LG' ? 'p-4 rounded-3xl' : 'p-3 rounded-2xl');

        return `
        <div class="ui-pill ${padCls} ${cardStateCls} flex flex-col gap-2.5 transition-all">
            <div class="ui-card relative w-full rounded-2xl bg-black/30 overflow-hidden shadow-sm group">
                <label class="${chkVisual} absolute top-2 left-2 w-6 h-6 rounded-full flex items-center justify-center cursor-pointer z-10 transition shadow-md" title="Sélectionner pour supprimer">
                    <input type="checkbox" ${isChk ? 'checked' : ''} onchange="toggleDuplicateCheck('${sEnc}', this.checked)" class="sr-only"/>
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.6" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
                </label>
                <div class="absolute top-2 right-2 z-10 pointer-events-none">${roleBadge}</div>
                <div onclick="${clickHandler}" class="w-full flex items-center justify-center cursor-pointer">
                    ${renderMediaPreview(item.dest_path, `w-full ${mediaMaxH} object-contain group-hover:scale-[1.02] transition-transform duration-300`)}
                </div>
            </div>
            <div class="space-y-1.5 min-w-0">
                <div class="flex items-center justify-between gap-2 min-w-0">
                    <span class="font-extrabold text-xs truncate" title="${fname}">${fname}</span>
                    ${albumsTxt ? `<span class="ui-card px-2 py-0.5 rounded-full text-[9px] font-bold opacity-80 truncate max-w-[110px]" title="${escapeHtml(albumsTxt)}">${escapeHtml(albumsTxt)}</span>` : ''}
                </div>
                ${traitBadgesHtml ? `<div class="flex flex-wrap items-center gap-1">${traitBadgesHtml}</div>` : ''}
                <div class="grid grid-cols-2 gap-1.5 text-[10px]">
                    <div class="ui-card rounded-xl px-2 py-1">
                        <span class="opacity-55 block text-[9px] uppercase font-bold">Qualité</span>
                        <span class="font-extrabold ${isBestPx ? 'text-emerald-400' : ''}">${dim}</span>
                    </div>
                    <div class="ui-card rounded-xl px-2 py-1">
                        <span class="opacity-55 block text-[9px] uppercase font-bold">Poids</span>
                        <span class="font-extrabold ${isBestSz ? 'text-emerald-400' : ''}">${mb}</span>
                    </div>
                </div>
                <div class="text-[11px] font-bold opacity-80 flex items-center justify-between gap-2">
                    <span class="truncate">${dateStr}</span>
                    ${timeStr ? `<span class="opacity-75 tabular-nums shrink-0">${timeStr}</span>` : ''}
                </div>
                <div class="text-[10px] opacity-55 truncate" title="${folder}">${folder}</div>
            </div>
        </div>`;
    }

    const thumbSize = size === 'SM' ? 'w-20 h-20 rounded-xl' : (size === 'LG' ? 'w-36 h-36 rounded-2xl' : 'w-28 h-28 rounded-2xl');
    return `
    <div class="ui-pill rounded-2xl p-3 ${cardStateCls} flex items-start gap-3 transition-all">
        <div class="ui-card relative ${thumbSize} overflow-hidden shrink-0 shadow-sm group">
            <label class="${chkVisual} absolute top-1.5 left-1.5 w-6 h-6 rounded-full flex items-center justify-center cursor-pointer z-10 transition shadow-md" title="Sélectionner pour supprimer">
                <input type="checkbox" ${isChk ? 'checked' : ''} onchange="toggleDuplicateCheck('${sEnc}', this.checked)" class="sr-only"/>
                <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.6" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
            </label>
            <div onclick="${clickHandler}" class="w-full h-full cursor-pointer">
                ${renderMediaPreview(item.dest_path, "w-full h-full object-cover group-hover:scale-105 transition-transform duration-300")}
            </div>
        </div>
        <div class="text-xs space-y-1.5 min-w-0 flex-1">
            <div class="flex items-center justify-between gap-1.5 min-w-0">
                <span class="font-extrabold text-xs truncate" title="${fname}">${fname}</span>
                ${roleBadge}
            </div>
            ${traitBadgesHtml ? `<div class="flex flex-wrap items-center gap-1">${traitBadgesHtml}</div>` : ''}
            <div class="flex flex-wrap items-center gap-1.5 text-[10px] font-extrabold">
                <span class="ui-card px-2 py-0.5 rounded-full ${isBestPx ? 'text-emerald-400' : ''}">${dim}</span>
                <span class="ui-card px-2 py-0.5 rounded-full ${isBestSz ? 'text-emerald-400' : ''}">${mb}</span>
                ${albumsTxt ? `<span class="ui-card px-2 py-0.5 rounded-full opacity-80 truncate max-w-[110px]" title="${escapeHtml(albumsTxt)}">${escapeHtml(albumsTxt)}</span>` : ''}
            </div>
            <div class="text-[11px] font-bold opacity-80 truncate">${dateTimeStr}</div>
            <div class="text-[10px] opacity-55 truncate" title="${folder}">${folder}</div>
        </div>
    </div>`;
}

function toggleDuplicateCheck(encSrc, checked) {
    const src = decodeURIComponent(encSrc);
    if (checked) checkedDuplicatePaths.add(src);
    else checkedDuplicatePaths.delete(src);
    _updateCheckedDeleteButtons();
    if (currentTab === 'dups') renderComparisonGroupsFromCache('dups');
    else if (currentTab === 'similar') renderComparisonGroupsFromCache('similar');
}

async function deleteCheckedDuplicates() {
    if (!checkedDuplicatePaths.size) return;
    await fetch('/api/trash/action', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({source_paths: Array.from(checkedDuplicatePaths), action: 'MOVE_TO_TRASH'})
    });
    checkedDuplicatePaths.clear();
    _updateCheckedDeleteButtons();
    loadDuplicates(); loadSimilarGroups(); loadStats();
}

function _formatBytesReadable(bytes) {
    if (!bytes || bytes <= 0) return '0 Mo';
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2).replace('.', ',')} Go`;
    return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} Mo`;
}

function _filterComparisonGroups(groups, filterBy) {
    if (!filterBy || filterBy === 'ALL') return groups;
    return groups.filter(g => {
        const items = g.items || [];
        if (filterBy === 'EXACT_ONLY') {
            return _collectWinnersAndLosers(items, [], true).winners.length > 0;
        }
        if (filterBy === 'DIFF_QUALITY') {
            const dims = new Set(items.map(it => `${it.width || 0}x${it.height || 0}`).filter(d => d !== '0x0'));
            return dims.size > 1;
        }
        if (filterBy === 'PHOTOS') {
            return items.every(it => !(typeof isVideoFile === 'function' && isVideoFile(it.dest_path)));
        }
        if (filterBy === 'VIDEOS') {
            return items.some(it => typeof isVideoFile === 'function' && isVideoFile(it.dest_path));
        }
        if (filterBy === 'MULTI') {
            return items.length > 2;
        }
        if (filterBy === 'CHECKED') {
            return items.some(it => it.source_path && checkedDuplicatePaths.has(it.source_path));
        }
        return true;
    });
}

function clearCheckedComparisonSelection(kind) {
    checkedDuplicatePaths.clear();
    _updateCheckedDeleteButtons();
    renderComparisonGroupsFromCache(kind);
}

function resetComparisonFilter(kind) {
    const sel = document.getElementById(`${kind}-filter-by`);
    if (sel) sel.value = 'ALL';
    renderComparisonGroupsFromCache(kind);
}

function _renderComparisonSummaryBar(kind, groups, filtered) {
    const bar = document.getElementById(`${kind}-summary-bar`);
    if (!bar) return;
    if (!groups || !groups.length) {
        bar.classList.add('hidden');
        bar.innerHTML = '';
        return;
    }
    const visibleExtra = filtered.reduce((s, g) => s + Math.max(0, g.items.length - 1), 0);
    const visibleRecover = filtered.reduce((s, g) => s + (g.recoverableBytes || 0), 0);
    let checkedBytes = 0;
    const seenPaths = new Set();
    groups.forEach(g => (g.items || []).forEach(it => {
        if (it.source_path && checkedDuplicatePaths.has(it.source_path) && !seenPaths.has(it.source_path)) {
            seenPaths.add(it.source_path);
            checkedBytes += Number(it.file_size || 0);
        }
    }));
    const checkedCount = seenPaths.size;
    const groupLabel = filtered.length !== groups.length
        ? `${filtered.length} / ${groups.length}`
        : `${groups.length}`;

    bar.innerHTML = `
    <div class="ui-card rounded-3xl p-3.5 sm:px-5 shadow-sm flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap items-center gap-2.5 sm:gap-4">
            <div class="ui-pill rounded-2xl px-3.5 py-2 flex items-center gap-2.5">
                <div class="w-8 h-8 rounded-xl ui-card flex items-center justify-center opacity-80">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                        <rect x="3" y="3" width="13" height="13" rx="2"/><path d="M8 21h11a2 2 0 0 0 2-2V8"/>
                    </svg>
                </div>
                <div class="leading-tight">
                    <div class="text-[10px] font-bold uppercase tracking-wider opacity-60">Groupes détectés</div>
                    <div class="text-xs sm:text-sm font-extrabold">${groupLabel} <span class="font-semibold opacity-65 text-[11px]">· ${visibleExtra} en trop</span></div>
                </div>
            </div>
            <div class="ui-pill rounded-2xl px-3.5 py-2 flex items-center gap-2.5">
                <div class="w-8 h-8 rounded-xl bg-emerald-500/15 text-emerald-400 flex items-center justify-center">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                </div>
                <div class="leading-tight">
                    <div class="text-[10px] font-bold uppercase tracking-wider opacity-60">Espace récupérable</div>
                    <div class="text-xs sm:text-sm font-extrabold text-emerald-400">${_formatBytesReadable(visibleRecover)}</div>
                </div>
            </div>
            <div class="ui-pill rounded-2xl px-3.5 py-2 flex items-center gap-2.5">
                <div class="w-8 h-8 rounded-xl ${checkedCount > 0 ? 'bg-rose-500/20 text-rose-400' : 'ui-card opacity-70'} flex items-center justify-center">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24">
                        <polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
                    </svg>
                </div>
                <div class="leading-tight">
                    <div class="text-[10px] font-bold uppercase tracking-wider opacity-60">Sélection</div>
                    <div class="text-xs sm:text-sm font-extrabold ${checkedCount > 0 ? 'text-rose-400' : ''}">${checkedCount} coché${checkedCount > 1 ? 's' : ''}${checkedCount > 0 ? ` <span class="font-semibold opacity-75 text-[11px]">(${_formatBytesReadable(checkedBytes)})</span>` : ''}</div>
                </div>
            </div>
        </div>
        <div class="flex flex-wrap items-center gap-2 ml-auto">
            <button id="${kind}-auto-btn" type="button" onclick="togglePageAutoPanel('${kind}')"
                    title="Ouvrir le guide de sélection automatique"
                    class="${!document.getElementById(`${kind}-auto-panel`)?.classList.contains('hidden') ? 'nav-item-active' : 'ui-pill hover:bg-[var(--bg-hover)]'} px-3.5 py-2 rounded-full text-xs font-extrabold transition cursor-pointer flex items-center gap-1.5">
                <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                <span>Guide de sélection</span>
            </button>
            <button type="button" onclick="previewPageAutoSelect('${kind}')"
                    class="ui-pill hover:bg-[var(--bg-hover)] px-3.5 py-2 rounded-full text-xs font-extrabold transition cursor-pointer">
                Pré-cocher tout
            </button>
            ${checkedCount > 0 ? `
            <button type="button" onclick="clearCheckedComparisonSelection('${kind}')"
                    class="ui-pill hover:bg-[var(--bg-hover)] px-3.5 py-2 rounded-full text-xs font-bold opacity-80 hover:opacity-100 transition cursor-pointer">
                Tout décocher
            </button>
            <button type="button" onclick="deleteCheckedDuplicates()"
                    class="bg-rose-600 hover:bg-rose-500 text-white px-4 py-2 rounded-full text-xs font-extrabold shadow-md transition cursor-pointer">
                Corbeille (${checkedCount})
            </button>` : ''}
        </div>
    </div>`;
    bar.classList.remove('hidden');
}

function _renderComparisonEmptyState(kind, isFiltered) {
    if (isFiltered) {
        return `
        <div class="ui-card rounded-3xl p-10 text-center space-y-3 shadow-sm">
            <div class="w-12 h-12 rounded-2xl ui-pill mx-auto flex items-center justify-center opacity-75">
                <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
                </svg>
            </div>
            <div class="text-base font-extrabold">Aucun groupe pour ce filtre</div>
            <p class="text-xs opacity-65 max-w-md mx-auto">Modifiez le critère de filtre ou réaffichez tous les groupes détectés.</p>
            <button type="button" onclick="resetComparisonFilter('${kind}')" class="plum-btn px-5 py-2 rounded-full text-xs font-extrabold shadow-md cursor-pointer">
                Afficher tous les groupes
            </button>
        </div>`;
    }
    const isDups = kind === 'dups';
    const title = isDups ? 'Aucun doublon dans votre bibliothèque' : 'Aucune série similaire détectée';
    const desc = isDups
        ? 'Tous vos fichiers sont uniques bit à bit, ou l’analyse n’a pas encore été lancée sur vos derniers médias.'
        : 'Aucune photo ou vidéo visuellement proche n’a été trouvée pour le moment.';
    const taskCode = isDups ? 'DEDUP' : 'SIMILAR';
    return `
    <div class="ui-card rounded-3xl p-10 text-center space-y-3.5 shadow-sm">
        <div class="w-14 h-14 rounded-2xl ui-pill mx-auto flex items-center justify-center text-emerald-400">
            <svg class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
        </div>
        <div class="text-base font-extrabold">${title}</div>
        <p class="text-xs opacity-65 max-w-md mx-auto leading-relaxed">${desc}</p>
        <div class="pt-1">
            <button type="button" onclick="runTask('${taskCode}')" class="plum-btn px-6 py-2.5 rounded-full text-xs font-extrabold shadow-md inline-flex items-center gap-2 cursor-pointer">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <span>Lancer l'analyse</span>
            </button>
        </div>
    </div>`;
}

function renderComparisonGroupsFromCache(kind) {
    const st = _cmpViewState[kind];
    const container = document.getElementById(kind === 'dups' ? 'dups-container' : 'similar-container');
    const totalLbl = document.getElementById(`${kind}-total-label`);
    if (!st || !container) return;

    const groups = st.cache || [];
    const filterBy = document.getElementById(`${kind}-filter-by`)?.value || 'ALL';
    const filtered = _filterComparisonGroups(groups, filterBy);
    const totalExtra = filtered.reduce((s, g) => s + Math.max(0, g.items.length - 1), 0);
    const totalRecover = filtered.reduce((s, g) => s + (g.recoverableBytes || 0), 0);
    if (totalLbl) {
        if (!groups.length) {
            totalLbl.textContent = '0 groupe';
        } else if (filterBy !== 'ALL') {
            totalLbl.textContent = `${filtered.length} / ${groups.length} groupe${groups.length > 1 ? 's' : ''} · ${_formatBytesReadable(totalRecover)} récupérable${totalExtra > 1 ? 's' : ''}`;
        } else {
            totalLbl.textContent = `${groups.length} groupe${groups.length > 1 ? 's' : ''} · ${_formatBytesReadable(totalRecover)} récupérable${totalExtra > 1 ? 's' : ''}`;
        }
    }

    _renderComparisonSummaryBar(kind, groups, filtered);

    if (!groups.length) {
        container.innerHTML = _renderComparisonEmptyState(kind, false);
        if (typeof updateFloatingGroupPill === 'function') updateFloatingGroupPill();
        return;
    }

    if (!filtered.length) {
        container.innerHTML = _renderComparisonEmptyState(kind, true);
        if (typeof updateFloatingGroupPill === 'function') updateFloatingGroupPill();
        return;
    }

    const sortBy = document.getElementById(`${kind}-sort-by`)?.value || 'date';
    const sortOrder = document.getElementById(`${kind}-sort-order`)?.value || 'desc';
    const autoPrios = _getPageAutoPriorities(kind);
    const exactOnly = Boolean(document.getElementById(`${kind}-auto-chk-exact-only`)?.checked);
    const dir = sortOrder === 'asc' ? 1 : -1;

    const sorted = [...filtered].sort((a, b) => {
        if (sortBy === 'size') {
            const diff = (a.recoverableBytes || 0) - (b.recoverableBytes || 0);
            if (diff !== 0) return dir * diff;
        } else if (sortBy === 'count') {
            const diff = a.items.length - b.items.length;
            if (diff !== 0) return dir * diff;
        } else if (sortBy === 'name') {
            const diff = (a.title || '').localeCompare(b.title || '', 'fr', { sensitivity: 'base' });
            if (diff !== 0) return dir * diff;
        } else {
            const diff = (a.recentTs || 0) - (b.recentTs || 0);
            if (diff !== 0) return dir * diff;
        }
        return (a.title || '').localeCompare(b.title || '', 'fr', { sensitivity: 'base' });
    });

    const cardsGridCls = st.size === 'SM'
        ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5'
        : (st.size === 'LG' ? 'grid grid-cols-1 md:grid-cols-2 gap-4' : 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3');

    const renderGroupCard = (g, idxInList) => {
        const ordered = _orderComparisonItemsByPriority(g.items, autoPrios);
        const { winners, losers } = _collectWinnersAndLosers(g.items, autoPrios, exactOnly);
        const winnerPaths = new Set(winners.map(w => w.source_path).filter(Boolean));
        const best = _getComparisonBestMetrics(ordered);
        const allLosersChecked = losers.length > 0 && losers.every(l => l.source_path && checkedDuplicatePaths.has(l.source_path));
        const hasVideo = ordered.some(it => typeof isVideoFile === 'function' && isVideoFile(it.dest_path));
        const typeIcon = hasVideo
            ? '<svg class="w-3.5 h-3.5 shrink-0 opacity-75" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="2" y="5" width="15" height="14" rx="2"/><polygon points="23 7 17 12 23 17 23 7"/></svg>'
            : '<svg class="w-3.5 h-3.5 shrink-0 opacity-75" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
        const kindBadge = kind === 'dups' ? 'Copies exactes' : 'Série proche';
        return `
        <div class="ui-card rounded-3xl p-4 sm:p-5 space-y-3.5 shadow-sm border border-white/10">
            <div class="flex flex-wrap items-center justify-between gap-2.5 pb-1 border-b border-white/10">
                <div class="flex flex-wrap items-center gap-2 min-w-0">
                    <span class="ui-pill w-7 h-7 rounded-xl flex items-center justify-center shrink-0">${typeIcon}</span>
                    <span class="text-sm font-extrabold truncate">${escapeHtml(g.title || `${kind === 'dups' ? 'Doublon' : 'Série'} ${idxInList + 1}`)}</span>
                    <span class="ui-pill px-2.5 py-0.5 rounded-full text-[10px] font-extrabold">${kindBadge} · ${g.items.length} fichiers</span>
                    ${exactOnly && winnerPaths.size === 0 ? '<span class="ui-pill px-2.5 py-0.5 rounded-full text-[10px] font-bold opacity-65">Non exact (ignoré)</span>' : ''}
                    ${g.recoverableBytes > 0 ? `<span class="bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 px-2.5 py-0.5 rounded-full text-[10px] font-extrabold">+${_formatBytesReadable(g.recoverableBytes)} libérables</span>` : ''}
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                    <button type="button" onclick="openCompareModal('${kind}', ${g._cacheIdx})"
                            class="ui-pill hover:bg-[var(--bg-hover)] px-3 py-1.5 rounded-full text-[11px] font-extrabold transition cursor-pointer flex items-center gap-1.5">
                        <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                        </svg>
                        Comparer
                    </button>
                    <button type="button" onclick="selectGroupLosers('${kind}', ${g._cacheIdx})"
                            class="${allLosersChecked ? 'bg-rose-500/20 text-rose-400 border border-rose-500/35' : 'ui-pill hover:bg-[var(--bg-hover)]'} px-3 py-1.5 rounded-full text-[11px] font-extrabold transition cursor-pointer">
                        ${allLosersChecked ? '✓ Doublons cochés' : 'Cocher les doublons'}
                    </button>
                </div>
            </div>
            <div class="${cardsGridCls}">
                ${ordered.map((item) => renderComparisonCard(item, { isWinner: Boolean(item.source_path && winnerPaths.has(item.source_path)), layout: st.layout, size: st.size, kind, groupCacheIdx: g._cacheIdx, best })).join('')}
            </div>
        </div>`;
    };

    container.innerHTML = sorted.map((g, i) => renderGroupCard(g, i)).join('');
    if (typeof updateFloatingGroupPill === 'function') updateFloatingGroupPill();
}

function _buildNormalizedComparisonGroups(rawGroups, isDups) {
    return (rawGroups || []).map((raw, i) => {
        const items = isDups ? [raw.master, ...(raw.duplicates || [])].filter(Boolean) : (raw || []).filter(Boolean);
        const recentTs = items.reduce((mx, it) => Math.max(mx, Number(it.timestamp || 0)), 0);
        const sizes = items.map(it => Number(it.file_size || 0)).sort((a, b) => b - a);
        const recoverableBytes = sizes.slice(1).reduce((s, v) => s + v, 0);
        const leadName = (items[0]?.dest_path || items[0]?.source_path || '').split(/[\\/]/).pop() || `${isDups ? 'Doublon' : 'Similarité'} ${i + 1}`;
        return {
            _cacheIdx: i,
            title: leadName,
            items,
            recentTs,
            recoverableBytes,
        };
    }).filter(g => g.items.length > 1);
}

async function loadDuplicates() {
    const res = await fetch('/api/duplicates');
    if (!res.ok) return;
    const d = await res.json();
    _cmpViewState.dups.cache = _buildNormalizedComparisonGroups(d.groups || [], true);
    syncComparisonLayoutSizeButtons('dups');
    renderComparisonGroupsFromCache('dups');
}

async function loadSimilarGroups() {
    const res = await fetch('/api/similar/groups');
    if (!res.ok) return;
    const d = await res.json();
    _cmpViewState.similar.cache = _buildNormalizedComparisonGroups(d.groups || [], false);
    syncComparisonLayoutSizeButtons('similar');
    renderComparisonGroupsFromCache('similar');
}

// ==================== COMPARAISON CÔTÉ À CÔTE & VISIONNEUSE DOUBLONS ====================

let _compareModalState = {
    items: [],
    kind: null,
    title: '',
    leftIdx: 0,
    rightIdx: 1,
    showAll: false,
    zoomed: false,
};

function openComparisonItemLightbox(kind, groupCacheIdx, encSrc) {
    const grp = _cmpViewState[kind]?.cache?.[groupCacheIdx];
    if (!grp || !grp.items || !grp.items.length) return;
    const ordered = _orderComparisonItemsByPriority(grp.items, _getPageAutoPriorities(kind));
    const src = decodeURIComponent(encSrc || '');
    const idx = Math.max(0, ordered.findIndex(it => it.source_path === src));
    openLightboxForComparisonGroup(ordered, idx, { kind, groupCacheIdx, title: grp.title || '' });
}

function openCompareModal(kind, groupCacheIdx) {
    const grp = _cmpViewState[kind]?.cache?.[groupCacheIdx];
    if (!grp || !grp.items || grp.items.length < 2) return;
    const ordered = _orderComparisonItemsByPriority(grp.items, _getPageAutoPriorities(kind));
    openCompareModalWithItems(ordered, { kind, title: grp.title || '' });
}

function openCompareModalFromLightbox() {
    const items = (typeof currentLightboxDupGroup !== 'undefined' && currentLightboxDupGroup?.items?.length >= 2)
        ? currentLightboxDupGroup.items
        : (Array.isArray(window._lbDetectedDupItems) ? window._lbDetectedDupItems : []);
    if (!items || items.length < 2) return;
    const kind = currentLightboxDupGroup?.kind || 'dups';
    const ordered = _orderComparisonItemsByPriority(items, _getPageAutoPriorities(kind));
    openCompareModalWithItems(ordered, { kind, title: currentLightboxDupGroup?.title || '' });
}

function openCompareModalWithItems(items, opts = {}) {
    const clean = (items || []).filter(Boolean).map(it => ({ ...it }));
    if (clean.length < 2) return;
    _compareModalState = {
        items: clean,
        kind: opts.kind || 'dups',
        title: opts.title || '',
        leftIdx: 0,
        rightIdx: Math.min(1, clean.length - 1),
        showAll: false,
        zoomed: false,
    };
    const modal = document.getElementById('compare-modal');
    if (modal) modal.classList.remove('hidden');
    renderCompareModal();
}

function closeCompareModal() {
    const modal = document.getElementById('compare-modal');
    if (modal) modal.classList.add('hidden');
}

function toggleCompareZoom() {
    _compareModalState.zoomed = !_compareModalState.zoomed;
    renderCompareModal();
}

function toggleCompareShowAll() {
    _compareModalState.showAll = !_compareModalState.showAll;
    renderCompareModal();
}

function setComparePaneSlot(side, idx) {
    const total = _compareModalState.items.length;
    if (idx < 0 || idx >= total) return;
    if (side === 'left') _compareModalState.leftIdx = idx;
    else _compareModalState.rightIdx = idx;
    renderCompareModal();
}

function toggleCompareItemCheck(idx) {
    const item = _compareModalState.items[idx];
    if (!item || !item.source_path) return;
    if (checkedDuplicatePaths.has(item.source_path)) checkedDuplicatePaths.delete(item.source_path);
    else checkedDuplicatePaths.add(item.source_path);
    _updateCheckedDeleteButtons();
    if (currentTab === 'dups' || currentTab === 'similar') renderComparisonGroupsFromCache(currentTab);
    renderCompareModal();
}

function keepOnlyCompareItem(idx) {
    const items = _compareModalState.items;
    if (!items[idx]) return;
    items.forEach((it, i) => {
        if (!it.source_path) return;
        if (i === idx) checkedDuplicatePaths.delete(it.source_path);
        else checkedDuplicatePaths.add(it.source_path);
    });
    _updateCheckedDeleteButtons();
    if (currentTab === 'dups' || currentTab === 'similar') renderComparisonGroupsFromCache(currentTab);
    renderCompareModal();
}

function openCompareItemInLightbox(idx) {
    const items = _compareModalState.items;
    if (!items[idx]) return;
    closeCompareModal();
    openLightboxForComparisonGroup(items, idx, { kind: _compareModalState.kind || 'dups', title: _compareModalState.title });
}

async function deleteCheckedInCompareModal() {
    const targets = _compareModalState.items.filter(it => it.source_path && checkedDuplicatePaths.has(it.source_path));
    if (!targets.length) return;
    const paths = targets.map(it => it.source_path);
    const res = await fetch('/api/trash/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_paths: paths, action: 'MOVE_TO_TRASH' }),
    });
    if (!res.ok) return;
    const removed = new Set(paths);
    paths.forEach(p => checkedDuplicatePaths.delete(p));
    _updateCheckedDeleteButtons();
    _compareModalState.items = _compareModalState.items.filter(it => !removed.has(it.source_path));
    loadDuplicates();
    loadSimilarGroups();
    loadStats();
    if (_compareModalState.items.length < 2) {
        closeCompareModal();
        if (typeof currentLightboxDupGroup !== 'undefined' && currentLightboxDupGroup) closeLightbox();
        return;
    }
    if (typeof currentLightboxDupGroup !== 'undefined' && currentLightboxDupGroup && Array.isArray(currentLightboxDupGroup.items)) {
        currentLightboxDupGroup.items = _compareModalState.items.map(it => ({ ...it }));
        currentGalleryItems = currentLightboxDupGroup.items.map(it => ({ ...it }));
        if (typeof _renderLightboxDuplicatesBar === 'function') {
            _renderLightboxDuplicatesBar(currentLightboxDupGroup.items, currentGalleryItems[0]?.source_path || '', true);
        }
    }
    _compareModalState.leftIdx = Math.min(_compareModalState.leftIdx, _compareModalState.items.length - 1);
    _compareModalState.rightIdx = Math.min(_compareModalState.rightIdx, _compareModalState.items.length - 1);
    if (_compareModalState.leftIdx === _compareModalState.rightIdx) {
        _compareModalState.rightIdx = (_compareModalState.leftIdx + 1) % _compareModalState.items.length;
    }
    renderCompareModal();
}

function onCompareMediaDimensionsLoaded(idx, w, h) {
    const item = _compareModalState.items?.[idx];
    if (!item || !w || !h) return;
    if (Number(item.width || 0) > 0 && Number(item.height || 0) > 0) return;
    item.width = Number(w);
    item.height = Number(h);
    const dimEl = document.getElementById(`compare-pane-dim-${idx}`);
    if (dimEl) dimEl.textContent = `${item.width} × ${item.height}`;
}

function renderCompareModal() {
    const grid = document.getElementById('compare-modal-grid');
    if (!grid) return;
    const { items, kind, title, leftIdx, rightIdx, showAll, zoomed } = _compareModalState;
    const kindLabel = kind === 'similar' ? 'Similaires' : 'Doublons';

    const titleEl = document.getElementById('compare-modal-title');
    if (titleEl) titleEl.textContent = title ? `Comparaison · ${title}` : 'Comparaison côte à côte';
    const badgeEl = document.getElementById('compare-modal-badge');
    if (badgeEl) badgeEl.textContent = `${kindLabel} · ${items.length} fichiers`;
    const zoomBtn = document.getElementById('compare-zoom-btn');
    if (zoomBtn) {
        zoomBtn.textContent = zoomed ? 'Zoom 2× (actif)' : 'Zoom 100%';
        zoomBtn.classList.toggle('bg-white/25', zoomed);
    }
    const showAllBtn = document.getElementById('compare-showall-btn');
    if (showAllBtn) {
        showAllBtn.classList.toggle('hidden', items.length <= 2);
        showAllBtn.textContent = showAll ? 'Côte à côte (2)' : `Tout afficher (${items.length})`;
    }

    const bestMetrics = _getComparisonBestMetrics(items);
    const { maxPx, hasPxDiff, maxBytes, hasSzDiff, minTs, hasTsDiff } = bestMetrics;

    const prios = _getPageAutoPriorities(kind || 'dups');
    const { winners } = _collectWinnersAndLosers(items, prios, false);
    const winnerPaths = new Set(winners.map(w => w.source_path).filter(Boolean));

    const paneIndices = showAll ? items.map((_, i) => i) : (items.length >= 2 ? [leftIdx, rightIdx] : [0]);
    grid.className = showAll
        ? `flex-1 min-h-0 grid grid-cols-1 md:grid-cols-2 ${items.length >= 3 ? 'xl:grid-cols-3' : ''} gap-3 overflow-y-auto no-scrollbar`
        : 'flex-1 min-h-0 grid grid-cols-1 md:grid-cols-2 gap-3 overflow-y-auto no-scrollbar';

    grid.innerHTML = paneIndices.map((idx, panePos) => {
        const item = items[idx];
        const fname = escapeHtml((item.dest_path || item.source_path || '').split(/[\\/]/).pop() || `Fichier ${idx + 1}`);
        const folder = escapeHtml((item.dest_path || item.source_path || '').split(/[\\/]/).slice(0, -1).join('/'));
        const px = (item.width || 0) * (item.height || 0);
        const dimTxt = (item.width && item.height) ? `${item.width} × ${item.height}` : 'Inconnue';
        const mbTxt = item.file_size ? _formatBytesReadable(item.file_size) : 'Inconnue';
        const tsVal = item.timestamp || item.modified_at || 0;
        const isBestPx = hasPxDiff && px > 0 && px === maxPx;
        const isBestSz = hasSzDiff && (item.file_size || 0) > 0 && item.file_size === maxBytes;
        const isOldestTs = hasTsDiff && tsVal > 0 && tsVal === minTs;
        const isWinner = Boolean(item.source_path && winnerPaths.has(item.source_path));
        const isChk = Boolean(item.source_path && checkedDuplicatePaths.has(item.source_path));
        const isVid = typeof isVideoFile === 'function' && isVideoFile(item.dest_path);
        const mediaUrl = `/media?path=${encodeURIComponent(item.dest_path)}`;
        const side = panePos === 0 ? 'left' : 'right';
        const albumsTxt = (item.album_name || '').trim();
        const modalTraitBadges = _getItemTraitBadges(item, bestMetrics, true);

        const switcherHtml = (!showAll && items.length > 2)
            ? `<div class="flex flex-wrap items-center gap-1 pb-1">
                ${items.map((optIt, optIdx) => {
                    const active = optIdx === idx;
                    const optName = escapeHtml((optIt.dest_path || '').split(/[\\/]/).pop() || `#${optIdx + 1}`);
                    return `<button type="button" onclick="setComparePaneSlot('${side}', ${optIdx})" title="${optName}"
                                    class="px-2.5 py-0.5 rounded-full text-[10px] font-extrabold transition cursor-pointer ${active ? 'bg-white text-[#1E1E1E]' : 'bg-white/10 hover:bg-white/20 text-white/80'}">#${optIdx + 1}</button>`;
                }).join('')}
               </div>`
            : '';

        return `
        <div class="bg-white/10 backdrop-blur-md border ${isChk ? 'border-rose-400/75 ring-1 ring-rose-400/40' : (isWinner ? 'border-emerald-400/55 ring-1 ring-emerald-400/25' : 'border-white/15')} rounded-3xl p-3 sm:p-4 flex flex-col gap-2.5 min-h-[340px]">
            ${switcherHtml}
            <div class="flex items-center justify-between gap-2 min-w-0">
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 min-w-0">
                        <span class="text-xs sm:text-sm font-extrabold truncate">${fname}</span>
                        ${isWinner ? '<span class="bg-emerald-500/25 text-emerald-300 border border-emerald-400/40 px-2 py-0.5 rounded-full text-[10px] font-extrabold shrink-0">★ Conservé</span>' : ''}
                        ${isChk ? '<span class="bg-rose-500/25 text-rose-200 border border-rose-400/40 px-2 py-0.5 rounded-full text-[10px] font-extrabold shrink-0">À supprimer</span>' : ''}
                    </div>
                    <div class="flex items-center gap-2 text-[10px] text-white/60 truncate">
                        <span class="truncate" title="${folder}">${folder}</span>
                        ${albumsTxt ? `<span class="bg-white/15 text-white px-2 py-0.5 rounded-full font-bold shrink-0">${escapeHtml(albumsTxt)}</span>` : ''}
                    </div>
                    ${modalTraitBadges ? `<div class="flex flex-wrap items-center gap-1 pt-1">${modalTraitBadges}</div>` : ''}
                </div>
                <button type="button" onclick="openCompareItemInLightbox(${idx})"
                        class="bg-white/10 hover:bg-white/20 px-2.5 py-1 rounded-full text-[10px] font-extrabold transition cursor-pointer shrink-0">
                    Plein écran
                </button>
            </div>

            <div class="flex-1 min-h-[180px] rounded-2xl bg-black/45 overflow-hidden flex items-center justify-center relative">
                ${isVid
                    ? `<video src="${mediaUrl}" onloadedmetadata="onCompareMediaDimensionsLoaded(${idx}, this.videoWidth, this.videoHeight)" controls class="max-h-full max-w-full w-auto h-auto object-contain"></video>`
                    : `<img src="${mediaUrl}" onload="onCompareMediaDimensionsLoaded(${idx}, this.naturalWidth, this.naturalHeight)" onclick="toggleCompareZoom()" alt="${fname}"
                           class="max-h-full max-w-full w-auto h-auto object-contain transition-transform duration-200 ${zoomed ? 'scale-150 cursor-zoom-out' : 'cursor-zoom-in'}"/>`}
            </div>

            <div class="grid grid-cols-3 gap-2 text-[11px]">
                <div class="bg-black/30 rounded-xl px-2.5 py-1.5">
                    <div class="flex items-center justify-between gap-1">
                        <span class="text-[9px] uppercase tracking-wider text-white/50 font-bold">Qualité</span>
                        ${isBestPx ? '<span class="text-[9px] font-extrabold text-emerald-300">Max</span>' : ''}
                    </div>
                    <div id="compare-pane-dim-${idx}" class="font-extrabold truncate ${isBestPx ? 'text-emerald-300' : 'text-white'}">${dimTxt}</div>
                </div>
                <div class="bg-black/30 rounded-xl px-2.5 py-1.5">
                    <div class="flex items-center justify-between gap-1">
                        <span class="text-[9px] uppercase tracking-wider text-white/50 font-bold">Taille</span>
                        ${isBestSz ? '<span class="text-[9px] font-extrabold text-emerald-300">Max</span>' : ''}
                    </div>
                    <div class="font-extrabold truncate ${isBestSz ? 'text-emerald-300' : 'text-white'}">${mbTxt}</div>
                </div>
                <div class="bg-black/30 rounded-xl px-2.5 py-1.5" title="${formatDateTime(tsVal)}">
                    <div class="flex items-center justify-between gap-1">
                        <span class="text-[9px] uppercase tracking-wider text-white/50 font-bold">Date et heure</span>
                        ${isOldestTs ? '<span class="text-[9px] font-extrabold text-emerald-300">Original</span>' : ''}
                    </div>
                    <div class="font-extrabold truncate ${isOldestTs ? 'text-emerald-300' : 'text-white'}">${formatDate(tsVal)}</div>
                    ${formatTime(tsVal) ? `<div class="text-[10px] font-bold text-white/80 tabular-nums">${formatTime(tsVal)}</div>` : ''}
                </div>
            </div>

            <div class="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                <button type="button" onclick="toggleCompareItemCheck(${idx})"
                        class="px-3 py-1.5 rounded-full text-[11px] font-extrabold transition cursor-pointer ${isChk ? 'bg-rose-500 text-white' : 'bg-white/10 hover:bg-white/20 text-white'}">
                    ${isChk ? '✓ Coché pour suppression' : 'Cocher pour supprimer'}
                </button>
                <button type="button" onclick="keepOnlyCompareItem(${idx})"
                        class="bg-emerald-500/20 hover:bg-emerald-500/35 text-emerald-200 border border-emerald-400/35 px-3 py-1.5 rounded-full text-[11px] font-extrabold transition cursor-pointer">
                    Conserver celui-ci
                </button>
            </div>
        </div>`;
    }).join('');

    const checkedInGroup = items.filter(it => it.source_path && checkedDuplicatePaths.has(it.source_path)).length;
    const statusEl = document.getElementById('compare-modal-status');
    if (statusEl) {
        statusEl.textContent = checkedInGroup > 0
            ? `${checkedInGroup} fichier${checkedInGroup > 1 ? 's' : ''} sélectionné${checkedInGroup > 1 ? 's' : ''} pour la corbeille.`
            : 'Comparez la qualité, la taille et la date pour choisir lequel conserver.';
    }
    const delBtn = document.getElementById('compare-modal-delete-btn');
    if (delBtn) {
        delBtn.classList.toggle('hidden', checkedInGroup === 0);
        if (checkedInGroup > 0) delBtn.textContent = `Supprimer la sélection (${checkedInGroup})`;
    }
}
