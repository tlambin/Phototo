// ==================== GROUPES LOGICIELS (ALBUMS, PERSONNES, LIEUX, FAVORIS) ====================

const GROUP_BAR_IDS = {
    albums: 'albums-groups-bar',
    persons: 'faces-groups-bar',
    places: 'places-groups-bar',
    favorites: 'favorites-groups-bar'
};

const GROUP_SCOPE_LABELS = {
    albums: 'albums',
    persons: 'personnes',
    places: 'lieux',
    favorites: 'favoris'
};

let customGroupsCache = { albums: [], persons: [], places: [], favorites: [] };
let activeCustomGroupId = { albums: null, persons: null, places: null, favorites: null };

let _customGroupModalState = {
    scope: 'albums',
    editGroupId: null,
    candidates: [],
    selectedKeys: new Set()
};

function _escGroupHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function loadCustomGroups(scope) {
    if (!GROUP_BAR_IDS[scope]) return [];
    try {
        const res = await fetch(`/api/groups?scope=${encodeURIComponent(scope)}`);
        if (!res.ok) return [];
        const data = await res.json();
        const list = data.groups || [];
        customGroupsCache[scope] = list;
        if (activeCustomGroupId[scope] !== null && !list.some(g => g.group_id === activeCustomGroupId[scope])) {
            activeCustomGroupId[scope] = null;
        }
        renderCustomGroupsBar(scope);
        return list;
    } catch (e) {
        return [];
    }
}

function getCustomGroupPrefs(scope) {
    try {
        const raw = localStorage.getItem(`phototo_groups_prefs_${scope}`);
        const parsed = raw ? JSON.parse(raw) : {};
        return {
            hideAll: Boolean(parsed.hideAll),
            showCount: parsed.showCount !== false
        };
    } catch (e) {
        return { hideAll: false, showCount: true };
    }
}

function setCustomGroupPrefs(scope, prefs) {
    try {
        localStorage.setItem(`phototo_groups_prefs_${scope}`, JSON.stringify(prefs));
    } catch (e) {}
}

function renderCustomGroupsBar(scope) {
    const bar = document.getElementById(GROUP_BAR_IDS[scope]);
    if (!bar) return;
    const groups = customGroupsCache[scope] || [];
    const activeId = activeCustomGroupId[scope];
    const prefs = getCustomGroupPrefs(scope);

    if (!groups.length) {
        bar.innerHTML = `
            <button type="button" onclick="openCustomGroupModal('${scope}')"
                    title="Créer un groupe de ${GROUP_SCOPE_LABELS[scope] || scope} (logiciel uniquement)"
                    class="ui-card hover:bg-[var(--bg-hover)] px-3.5 py-1.5 rounded-full text-xs font-extrabold shadow-sm inline-flex items-center gap-1.5 transition cursor-pointer">
                <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2.4" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
                <span>Nouveau groupe</span>
            </button>`;
        return;
    }

    const allCls = activeId === null
        ? 'nav-item-active shadow-sm'
        : 'ui-pill hover:bg-[var(--bg-hover)] opacity-85 hover:opacity-100';
    const allBtn = prefs.hideAll ? '' : `
        <button type="button" onclick="selectCustomGroup('${scope}', null)"
                class="${allCls} px-3.5 py-1.5 rounded-full text-xs font-extrabold transition cursor-pointer">
            Tous
        </button>`;

    const groupChips = groups.map(g => {
        const isActive = Number(activeId) === Number(g.group_id);
        const chipCls = isActive
            ? 'nav-item-active shadow-sm'
            : 'ui-card hover:bg-[var(--bg-hover)]';
        const cnt = (g.item_keys || []).length;
        const safeName = _escGroupHtml(g.name);
        const countBadgeCls = isActive ? 'bg-white/25 text-white' : 'bg-black/15';
        const countHtml = prefs.showCount
            ? `<span class="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-extrabold leading-none ${countBadgeCls}">${cnt}</span>`
            : '';
        return `
        <button type="button" onclick="selectCustomGroup('${scope}', ${g.group_id})"
                class="${chipCls} inline-flex items-center gap-1.5 rounded-full pl-3.5 ${prefs.showCount ? 'pr-2' : 'pr-3.5'} py-1.5 text-xs font-extrabold shadow-sm transition cursor-pointer">
            <span>${safeName}</span>
            ${countHtml}
        </button>`;
    }).join('');

    const plusBtn = `
        <button type="button" onclick="openCustomGroupModal('${scope}')"
                title="Nouveau groupe de ${GROUP_SCOPE_LABELS[scope] || scope}"
                class="ui-card hover:bg-[var(--bg-hover)] w-8 h-8 rounded-full flex items-center justify-center shadow-sm transition cursor-pointer shrink-0">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        </button>`;

    bar.innerHTML = `${allBtn}${groupChips}${plusBtn}`;
}

function selectCustomGroup(scope, groupId) {
    const next = (groupId !== null && Number(activeCustomGroupId[scope]) === Number(groupId)) ? null : groupId;
    activeCustomGroupId[scope] = next;
    renderCustomGroupsBar(scope);
    _refreshScopeForCustomGroup(scope);
}

function _refreshScopeForCustomGroup(scope) {
    if (scope === 'albums' && typeof renderAlbumsOverviewFromCache === 'function') {
        renderAlbumsOverviewFromCache();
    } else if (scope === 'persons' && typeof renderPersonsOverviewFromCache === 'function') {
        renderPersonsOverviewFromCache();
    } else if (scope === 'places' && typeof renderPlacesOverviewFromCache === 'function') {
        renderPlacesOverviewFromCache();
    } else if (scope === 'favorites' && typeof resetAndLoadGallery === 'function') {
        resetAndLoadGallery();
    }
}

function filterItemsByActiveCustomGroup(scope, items, getKeyFn) {
    const activeId = activeCustomGroupId[scope];
    if (activeId === null || activeId === undefined) return items;
    const grp = (customGroupsCache[scope] || []).find(g => Number(g.group_id) === Number(activeId));
    if (!grp) return items;
    const keySet = new Set((grp.item_keys || []).map(k => String(k)));
    return (items || []).filter(it => keySet.has(String(getKeyFn(it))));
}

async function _loadCustomGroupCandidates(scope) {
    if (scope === 'albums') {
        const list = (typeof allAlbumsCache !== 'undefined' && allAlbumsCache.length)
            ? allAlbumsCache
            : (typeof rootAlbumsCache !== 'undefined' ? rootAlbumsCache : []);
        return list.map(a => ({
            key: String(a.album_id),
            label: a.full_path || a.name || '',
            meta: `${a.count || 0} élément${(a.count || 0) > 1 ? 's' : ''}`,
            thumb: a.cover_path ? `/thumb?path=${encodeURIComponent(a.cover_path)}` : ''
        }));
    }
    if (scope === 'persons') {
        const list = (typeof allPersonsCache !== 'undefined') ? allPersonsCache : [];
        return list.map(p => {
            const cnt = Number(p.media_count ?? p.face_count) || 0;
            return {
                key: String(p.person_id),
                label: p.name || 'Inconnu',
                meta: `${cnt} média${cnt > 1 ? 's' : ''}`,
                thumb: p.thumb_path ? `/media?path=${encodeURIComponent(p.thumb_path)}` : ''
            };
        });
    }
    if (scope === 'places') {
        const list = (typeof _allPlacesBucketsList !== 'undefined' && _allPlacesBucketsList.length)
            ? _allPlacesBucketsList
            : (typeof _placesBucketsList !== 'undefined' ? _placesBucketsList : []);
        return list.map(pl => ({
            key: String(pl.bucket_key),
            label: pl.city || pl.label || 'Lieu localisé',
            meta: `${pl.count || 0} élément${(pl.count || 0) > 1 ? 's' : ''}`,
            thumb: pl.cover ? `/thumb?path=${encodeURIComponent(pl.cover)}` : ''
        }));
    }
    if (scope === 'favorites') {
        let favItems = [];
        try {
            const res = await fetch('/api/gallery/items?favorites_only=true&limit=300&sort_by=date&sort_order=desc');
            if (res.ok) favItems = (await res.json()).items || [];
        } catch (e) {}
        if (!favItems.length && typeof currentGalleryItems !== 'undefined') {
            favItems = currentGalleryItems;
        }
        return favItems.map(it => {
            const fname = (it.dest_path || it.source_path || '').split(/[\\/]/).pop() || it.source_path;
            const dt = it.timestamp ? new Date(it.timestamp * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
            return {
                key: String(it.source_path),
                label: fname,
                meta: dt,
                thumb: it.dest_path ? `/thumb?path=${encodeURIComponent(it.dest_path)}` : ''
            };
        });
    }
    return [];
}

async function openCustomGroupModal(scope, editGroupId = null, preselectedKeys = null) {
    const modal = document.getElementById('custom-group-modal');
    if (!modal) return;
    const titleEl = document.getElementById('custom-group-modal-title');
    const nameEl = document.getElementById('custom-group-name-input');
    const searchEl = document.getElementById('custom-group-items-search');
    const errEl = document.getElementById('custom-group-error');
    const submitBtn = document.getElementById('custom-group-submit-btn');
    const listEl = document.getElementById('custom-group-items-list');

    const editGroup = editGroupId !== null
        ? (customGroupsCache[scope] || []).find(g => Number(g.group_id) === Number(editGroupId))
        : null;

    _customGroupModalState = {
        scope,
        editGroupId: editGroup ? editGroup.group_id : null,
        candidates: [],
        selectedKeys: new Set(
            editGroup
                ? (editGroup.item_keys || []).map(String)
                : (Array.isArray(preselectedKeys) ? preselectedKeys.map(String) : [])
        )
    };

    if (titleEl) {
        titleEl.textContent = editGroup
            ? `Modifier le groupe (${GROUP_SCOPE_LABELS[scope] || scope})`
            : `Nouveau groupe (${GROUP_SCOPE_LABELS[scope] || scope})`;
    }
    if (nameEl) nameEl.value = editGroup ? editGroup.name : '';
    if (searchEl) searchEl.value = '';
    if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }
    if (submitBtn) submitBtn.textContent = editGroup ? 'Enregistrer' : 'Créer le groupe';
    if (listEl) listEl.innerHTML = `<div class="text-xs opacity-60 py-6 text-center">Chargement...</div>`;

    modal.classList.remove('hidden');
    _customGroupModalState.candidates = await _loadCustomGroupCandidates(scope);
    renderCustomGroupModalChecklist();
    setTimeout(() => nameEl?.focus(), 50);
}

function closeCustomGroupModal() {
    document.getElementById('custom-group-modal')?.classList.add('hidden');
}

function _updateCustomGroupSelectedCount() {
    const cntEl = document.getElementById('custom-group-selected-count');
    if (!cntEl) return;
    const n = _customGroupModalState.selectedKeys.size;
    cntEl.textContent = `${n} sélectionné${n > 1 ? 's' : ''}`;
}

function toggleCustomGroupModalItem(key, checked) {
    const k = String(key);
    if (checked) _customGroupModalState.selectedKeys.add(k);
    else _customGroupModalState.selectedKeys.delete(k);
    _updateCustomGroupSelectedCount();
}

function setAllCustomGroupModalItems(checked) {
    const q = (document.getElementById('custom-group-items-search')?.value || '').trim().toLowerCase();
    _customGroupModalState.candidates.forEach(c => {
        if (q && !c.label.toLowerCase().includes(q)) return;
        if (checked) _customGroupModalState.selectedKeys.add(c.key);
        else _customGroupModalState.selectedKeys.delete(c.key);
    });
    renderCustomGroupModalChecklist();
}

function renderCustomGroupModalChecklist() {
    const listEl = document.getElementById('custom-group-items-list');
    if (!listEl) return;
    _updateCustomGroupSelectedCount();

    const q = (document.getElementById('custom-group-items-search')?.value || '').trim().toLowerCase();
    const visible = _customGroupModalState.candidates.filter(c => !q || c.label.toLowerCase().includes(q));
    if (!visible.length) {
        listEl.innerHTML = `<div class="text-xs opacity-55 py-6 text-center">Aucun élément disponible.</div>`;
        return;
    }

    listEl.innerHTML = visible.map(c => {
        const isChk = _customGroupModalState.selectedKeys.has(c.key);
        const safeKey = _escGroupHtml(c.key);
        const safeLabel = _escGroupHtml(c.label);
        const safeMeta = _escGroupHtml(c.meta);
        const thumbHtml = c.thumb
            ? `<img src="${c.thumb}" loading="lazy" class="w-9 h-9 rounded-xl object-cover shrink-0 bg-black/15"/>`
            : `<div class="w-9 h-9 rounded-xl ui-pill shrink-0 flex items-center justify-center text-xs opacity-60">📁</div>`;
        return `
        <label class="flex items-center gap-3 px-3 py-2 rounded-2xl ui-pill hover:bg-[var(--bg-hover)] cursor-pointer transition">
            <input type="checkbox" ${isChk ? 'checked' : ''}
                   data-group-item-key="${safeKey}"
                   onchange="toggleCustomGroupModalItem(this.dataset.groupItemKey, this.checked)"
                   class="w-4 h-4 rounded cursor-pointer shrink-0"/>
            ${thumbHtml}
            <div class="flex-1 min-w-0">
                <div class="text-xs font-extrabold truncate">${safeLabel}</div>
                ${safeMeta ? `<div class="text-[10px] opacity-60 font-semibold truncate">${safeMeta}</div>` : ''}
            </div>
        </label>`;
    }).join('');
}

async function submitCustomGroupModal(e) {
    if (e) e.preventDefault();
    const nameEl = document.getElementById('custom-group-name-input');
    const errEl = document.getElementById('custom-group-error');
    const name = (nameEl?.value || '').trim();
    if (!name) {
        if (errEl) { errEl.textContent = 'Veuillez saisir un nom de groupe.'; errEl.classList.remove('hidden'); }
        return;
    }

    const { scope, editGroupId, selectedKeys } = _customGroupModalState;
    const itemKeys = Array.from(selectedKeys);

    if (editGroupId === null) {
        const res = await fetch('/api/groups/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scope, name, item_keys: itemKeys })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            if (errEl) { errEl.textContent = err.detail || 'Impossible de créer le groupe.'; errEl.classList.remove('hidden'); }
            return;
        }
        const d = await res.json();
        activeCustomGroupId[scope] = d.group?.group_id ?? null;
    } else {
        const rRes = await fetch('/api/groups/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ group_id: editGroupId, new_name: name })
        });
        if (!rRes.ok) {
            const err = await rRes.json().catch(() => ({}));
            if (errEl) { errEl.textContent = err.detail || 'Impossible de renommer le groupe.'; errEl.classList.remove('hidden'); }
            return;
        }
        const sRes = await fetch('/api/groups/set_items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ group_id: editGroupId, item_keys: itemKeys, mode: 'replace' })
        });
        if (!sRes.ok) {
            const err = await sRes.json().catch(() => ({}));
            if (errEl) { errEl.textContent = err.detail || 'Impossible de mettre à jour les éléments.'; errEl.classList.remove('hidden'); }
            return;
        }
    }

    closeCustomGroupModal();
    await loadCustomGroups(scope);
    _refreshScopeForCustomGroup(scope);
}

async function deleteCustomGroup(scope, groupId, name) {
    if (!confirm(`Supprimer le groupe « ${name} » ?\n\nAucun fichier ni dossier Windows ne sera supprimé.`)) return;
    const res = await fetch('/api/groups/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_id: groupId })
    });
    if (!res.ok) return;
    if (Number(activeCustomGroupId[scope]) === Number(groupId)) {
        activeCustomGroupId[scope] = null;
    }
    await loadCustomGroups(scope);
    _refreshScopeForCustomGroup(scope);
    const manageModal = document.getElementById('page-settings-modal');
    if (manageModal && !manageModal.classList.contains('hidden')) {
        renderCustomGroupsManageList();
    }
}

const _MEDIA_SORT_OPTS = [
    { value: 'date', label: 'Date' },
    { value: 'name', label: 'Nom' },
    { value: 'modified', label: 'Modification' },
    { value: 'added', label: "Date d'ajout" }
];
const _TIME_GROUP_OPTS = [
    { value: 'NONE', label: 'Aucun' },
    { value: 'DAY', label: 'Jour' },
    { value: 'WEEK', label: 'Semaine' },
    { value: 'MONTH', label: 'Mois' },
    { value: 'YEAR', label: 'Année' }
];
const _MEDIA_LAYOUT_OPTS = [
    { value: 'GRID', label: 'Grille' },
    { value: 'MASONRY', label: 'Mosaïque' },
    { value: 'LIST', label: 'Liste' }
];

const PAGE_SETTINGS_CONFIG = {
    gallery: {
        title: 'Réglages — Galerie',
        groupScope: null,
        hasDefaults: true,
        sortOptions: _MEDIA_SORT_OPTS,
        groupOptions: _TIME_GROUP_OPTS,
        layoutOptions: _MEDIA_LAYOUT_OPTS,
        defaults: { sortBy: 'date', sortOrder: 'desc', groupBy: 'NONE', layout: 'GRID', size: 'MD' }
    },
    favorites: {
        title: 'Réglages — Favoris',
        groupScope: 'favorites',
        hasDefaults: true,
        sortOptions: _MEDIA_SORT_OPTS,
        groupOptions: _TIME_GROUP_OPTS,
        layoutOptions: _MEDIA_LAYOUT_OPTS,
        defaults: { sortBy: 'date', sortOrder: 'desc', groupBy: 'NONE', layout: 'GRID', size: 'MD' }
    },
    recent: {
        title: 'Réglages — Ajoutés récemment',
        groupScope: null,
        hasDefaults: true,
        sortOptions: _MEDIA_SORT_OPTS,
        groupOptions: _TIME_GROUP_OPTS,
        layoutOptions: _MEDIA_LAYOUT_OPTS,
        defaults: { sortBy: 'added', sortOrder: 'desc', groupBy: 'NONE', layout: 'GRID', size: 'MD' }
    },
    album_single: {
        title: 'Réglages — Vue Album',
        groupScope: null,
        hasDefaults: true,
        sortOptions: _MEDIA_SORT_OPTS,
        groupOptions: _TIME_GROUP_OPTS,
        layoutOptions: _MEDIA_LAYOUT_OPTS,
        defaults: { sortBy: 'date', sortOrder: 'desc', groupBy: 'NONE', layout: 'GRID', size: 'MD' }
    },
    person_single: {
        title: 'Réglages — Vue Personne',
        groupScope: null,
        hasDefaults: true,
        sortOptions: _MEDIA_SORT_OPTS,
        groupOptions: _TIME_GROUP_OPTS,
        layoutOptions: _MEDIA_LAYOUT_OPTS,
        defaults: { sortBy: 'date', sortOrder: 'desc', groupBy: 'NONE', layout: 'GRID', size: 'MD' }
    },
    albums: {
        title: 'Réglages — Albums',
        groupScope: 'albums',
        hasDefaults: true,
        sortOptions: [
            { value: 'date', label: 'Date' },
            { value: 'name', label: 'Nom' },
            { value: 'modified', label: 'Modification' }
        ],
        groupOptions: _TIME_GROUP_OPTS,
        layoutOptions: [
            { value: 'GRID', label: 'Grille' },
            { value: 'LIST', label: 'Liste' }
        ],
        defaults: { sortBy: 'date', sortOrder: 'desc', groupBy: 'NONE', layout: 'GRID', size: 'MD' }
    },
    persons: {
        title: 'Réglages — Personnes',
        groupScope: 'persons',
        hasDefaults: true,
        sortOptions: [
            { value: 'content', label: 'Plus de contenu' },
            { value: 'recent', label: 'Récent' },
            { value: 'added', label: "Date d'ajout" },
            { value: 'name', label: 'Nom' }
        ],
        groupOptions: [
            { value: 'NONE', label: 'Aucun' },
            { value: 'LETTER', label: 'Initiale' },
            { value: 'DAY', label: 'Jour' },
            { value: 'WEEK', label: 'Semaine' },
            { value: 'MONTH', label: 'Mois' },
            { value: 'YEAR', label: 'Année' }
        ],
        layoutOptions: [
            { value: 'GRID', label: 'Grille' },
            { value: 'LIST', label: 'Liste' }
        ],
        defaults: { sortBy: 'content', sortOrder: 'desc', groupBy: 'NONE', layout: 'GRID', size: 'MD' }
    },
    places: {
        title: 'Réglages — Lieux',
        groupScope: 'places',
        hasDefaults: true,
        sortOptions: [
            { value: 'content', label: 'Plus de contenu' },
            { value: 'recent', label: 'Récent' },
            { value: 'name', label: 'Nom' }
        ],
        groupOptions: [
            { value: 'NONE', label: 'Aucun' },
            { value: 'COUNTRY', label: 'Pays / Région' },
            { value: 'LETTER', label: 'Initiale' },
            { value: 'DAY', label: 'Jour' },
            { value: 'WEEK', label: 'Semaine' },
            { value: 'MONTH', label: 'Mois' },
            { value: 'YEAR', label: 'Année' }
        ],
        layoutOptions: [
            { value: 'GRID', label: 'Grille' },
            { value: 'LIST', label: 'Liste' }
        ],
        defaults: { sortBy: 'content', sortOrder: 'desc', groupBy: 'NONE', layout: 'GRID', size: 'MD' }
    },
    place_single: {
        title: 'Réglages — Vue Lieu',
        groupScope: null,
        hasDefaults: true,
        sortOptions: _MEDIA_SORT_OPTS,
        groupOptions: _TIME_GROUP_OPTS,
        layoutOptions: _MEDIA_LAYOUT_OPTS,
        defaults: { sortBy: 'date', sortOrder: 'desc', groupBy: 'NONE', layout: 'GRID', size: 'MD' }
    },
    types: {
        title: 'Réglages — Catégories',
        groupScope: null,
        hasDefaults: true,
        groupLabel: 'Filtre',
        sortOptions: [
            { value: 'content', label: 'Plus de contenu' },
            { value: 'name', label: 'Nom' },
            { value: 'added', label: "Date d'ajout" }
        ],
        groupOptions: [
            { value: 'ALL', label: 'Toutes' },
            { value: 'AI', label: 'IA uniquement' },
            { value: 'MANUAL', label: 'Manuelles uniquement' },
            { value: 'NON_EMPTY', label: 'Avec médias' },
            { value: 'EMPTY', label: 'Vides' }
        ],
        layoutOptions: [
            { value: 'GRID', label: 'Grille' },
            { value: 'LIST', label: 'Liste' }
        ],
        defaults: { sortBy: 'content', sortOrder: 'desc', groupBy: 'ALL', layout: 'GRID', size: 'MD' }
    },
    dups: {
        title: 'Réglages — Doublons',
        groupScope: null,
        hasDefaults: true,
        groupLabel: 'Filtre',
        sortOptions: [
            { value: 'date', label: 'Date' },
            { value: 'size', label: 'Taille récupérable' },
            { value: 'count', label: 'Nombre de fichiers' },
            { value: 'name', label: 'Nom' }
        ],
        groupOptions: [
            { value: 'ALL', label: 'Tous' },
            { value: 'EXACT_ONLY', label: 'Doublons exacts' },
            { value: 'DIFF_QUALITY', label: 'Qualités différentes' },
            { value: 'PHOTOS', label: 'Photos uniquement' },
            { value: 'VIDEOS', label: 'Vidéos uniquement' },
            { value: 'MULTI', label: 'Plus de 2 fichiers' },
            { value: 'CHECKED', label: 'Avec sélection' }
        ],
        layoutOptions: [
            { value: 'GRID', label: 'Grille' },
            { value: 'MASONRY', label: 'Mosaïque' }
        ],
        defaults: { sortBy: 'date', sortOrder: 'desc', groupBy: 'ALL', layout: 'GRID', size: 'MD' }
    },
    similar: {
        title: 'Réglages — Similaires',
        groupScope: null,
        hasDefaults: true,
        groupLabel: 'Filtre',
        sortOptions: [
            { value: 'date', label: 'Date' },
            { value: 'size', label: 'Taille récupérable' },
            { value: 'count', label: 'Nombre de fichiers' },
            { value: 'name', label: 'Nom' }
        ],
        groupOptions: [
            { value: 'ALL', label: 'Tous' },
            { value: 'EXACT_ONLY', label: 'Doublons exacts' },
            { value: 'DIFF_QUALITY', label: 'Qualités différentes' },
            { value: 'PHOTOS', label: 'Photos uniquement' },
            { value: 'VIDEOS', label: 'Vidéos uniquement' },
            { value: 'MULTI', label: 'Plus de 2 fichiers' },
            { value: 'CHECKED', label: 'Avec sélection' }
        ],
        layoutOptions: [
            { value: 'GRID', label: 'Grille' },
            { value: 'MASONRY', label: 'Mosaïque' }
        ],
        defaults: { sortBy: 'date', sortOrder: 'desc', groupBy: 'ALL', layout: 'GRID', size: 'MD' }
    },
    trash: {
        title: 'Réglages — Corbeille',
        groupScope: null,
        hasDefaults: true,
        isTrash: true,
        sortOptions: [
            { value: 'trashed_at', label: 'Date de suppression' },
            { value: 'date', label: 'Date du média' },
            { value: 'days_left', label: 'Jours restants' },
            { value: 'size', label: 'Taille' },
            { value: 'name', label: 'Nom' }
        ],
        groupOptions: _TIME_GROUP_OPTS,
        layoutOptions: _MEDIA_LAYOUT_OPTS,
        defaults: { sortBy: 'trashed_at', sortOrder: 'desc', groupBy: 'NONE', layout: 'GRID', size: 'MD' }
    },
    'sug-albums': {
        title: 'Réglages — Albums & Événements',
        groupScope: null,
        hasDefaults: true,
        groupLabel: 'Filtre',
        sugKind: 'albums',
        sortOptions: [
            { value: 'score', label: 'Pertinence' },
            { value: 'date', label: 'Date du média' },
            { value: 'size', label: 'Taille' },
            { value: 'name', label: 'Nom' }
        ],
        groupOptions: [
            { value: 'ALL', label: 'Tout (nouveaux + ajouts)' },
            { value: 'NEW_ONLY', label: 'Nouveaux albums uniquement' },
            { value: 'EXISTING_ONLY', label: 'Ajouts aux albums existants' }
        ],
        layoutOptions: _MEDIA_LAYOUT_OPTS,
        defaults: { sortBy: 'score', sortOrder: 'desc', groupBy: 'ALL', layout: 'GRID', size: 'MD' }
    },
    'sug-rotation': {
        title: 'Réglages — Rotation suggérée',
        groupScope: null,
        hasDefaults: true,
        groupLabel: 'Filtre',
        sugKind: 'rotation',
        sortOptions: [
            { value: 'date', label: 'Date du média' },
            { value: 'angle', label: 'Angle suggéré' },
            { value: 'size', label: 'Taille' },
            { value: 'name', label: 'Nom' }
        ],
        groupOptions: [
            { value: 'ALL', label: 'Toutes les rotations' },
            { value: '90', label: '+90° horaire' },
            { value: '270', label: '+270° (90° antihoraire)' },
            { value: '180', label: '180° retourné' }
        ],
        layoutOptions: _MEDIA_LAYOUT_OPTS,
        defaults: { sortBy: 'date', sortOrder: 'desc', groupBy: 'ALL', layout: 'GRID', size: 'MD' }
    },
    'sug-blurry': {
        title: 'Réglages — Qualité : Flou & Exposition',
        groupScope: null,
        hasDefaults: true,
        groupLabel: 'Filtre',
        sugKind: 'blurry',
        sugSettingField: 'blur',
        sortOptions: [
            { value: 'blur_score', label: 'Netteté' },
            { value: 'date', label: 'Date du média' },
            { value: 'size', label: 'Taille' },
            { value: 'name', label: 'Nom' }
        ],
        groupOptions: [
            { value: 'all', label: 'Tout (flou + exposition)' },
            { value: 'blur', label: 'Photos floues uniquement' },
            { value: 'exposure', label: 'Sombres / surexposées' },
            { value: 'sharper', label: 'Meilleur cliché dispo' }
        ],
        layoutOptions: _MEDIA_LAYOUT_OPTS,
        defaults: { sortBy: 'blur_score', sortOrder: 'asc', groupBy: 'all', layout: 'GRID', size: 'MD' }
    },
    'sug-missing_gps': {
        title: 'Réglages — Lieux manquants (GPS)',
        groupScope: null,
        hasDefaults: true,
        groupLabel: 'Filtre',
        sugKind: 'missing_gps',
        sugSettingField: 'gps',
        sortOptions: [
            { value: 'time_diff', label: 'Écart temporel' },
            { value: 'date', label: 'Date du média' },
            { value: 'name', label: 'Nom' }
        ],
        groupOptions: [
            { value: 'ALL', label: 'Tous les médias estimés' },
            { value: 'NEAR_30M', label: 'Écart ≤ 30 min' },
            { value: 'NEAR_2H', label: 'Écart ≤ 2 heures' }
        ],
        layoutOptions: _MEDIA_LAYOUT_OPTS,
        defaults: { sortBy: 'time_diff', sortOrder: 'asc', groupBy: 'ALL', layout: 'GRID', size: 'MD' }
    },
    'sug-people': {
        title: 'Réglages — Personnes à trier',
        groupScope: null,
        hasDefaults: true,
        groupLabel: 'Filtre',
        sugKind: 'people',
        sortOptions: [
            { value: 'count', label: 'Nombre d\'apparitions' },
            { value: 'similarity', label: 'Ressemblance' }
        ],
        groupOptions: [
            { value: 'ALL', label: 'Fusions + Inconnus' },
            { value: 'MERGES', label: 'Paires à fusionner' },
            { value: 'UNNAMED', label: 'Visages inconnus' }
        ],
        layoutOptions: [
            { value: 'GRID', label: 'Grille' },
            { value: 'LIST', label: 'Liste' }
        ],
        defaults: { sortBy: 'count', sortOrder: 'desc', groupBy: 'ALL', layout: 'GRID', size: 'MD' }
    },
    'sug-screenshots': {
        title: 'Réglages — Captures & Documents',
        groupScope: null,
        hasDefaults: true,
        groupLabel: 'Filtre',
        sugKind: 'screenshots',
        sugSettingField: 'age',
        sortOptions: [
            { value: 'age', label: 'Ancienneté' },
            { value: 'size', label: 'Taille' },
            { value: 'name', label: 'Nom' }
        ],
        groupOptions: [
            { value: 'ALL', label: 'Captures + Documents OCR' },
            { value: 'SCREEN', label: 'Captures d\'écran uniquement' },
            { value: 'OCR', label: 'Documents OCR uniquement' }
        ],
        layoutOptions: _MEDIA_LAYOUT_OPTS,
        defaults: { sortBy: 'age', sortOrder: 'desc', groupBy: 'ALL', layout: 'GRID', size: 'MD' }
    },
    'sug-large': {
        title: 'Réglages — Stockage & Courtes vidéos',
        groupScope: null,
        hasDefaults: true,
        groupLabel: 'Filtre',
        sugKind: 'large',
        sugSettingField: 'large',
        sortOptions: [
            { value: 'size', label: 'Taille' },
            { value: 'duration', label: 'Durée' },
            { value: 'date', label: 'Date du média' },
            { value: 'name', label: 'Nom' }
        ],
        groupOptions: [
            { value: 'large', label: 'Fichiers volumineux' },
            { value: 'short_videos', label: 'Micro-vidéos (≤ 2 s)' },
            { value: 'videos_only', label: 'Vidéos lourdes uniquement' },
            { value: 'photos_only', label: 'Photos lourdes uniquement' }
        ],
        layoutOptions: _MEDIA_LAYOUT_OPTS,
        defaults: { sortBy: 'size', sortOrder: 'desc', groupBy: 'large', layout: 'GRID', size: 'MD' }
    },
    'sug-missing_meta': {
        title: 'Réglages — Sans métadonnées',
        groupScope: null,
        hasDefaults: true,
        groupLabel: 'Filtre',
        sugKind: 'missing_meta',
        sortOptions: [
            { value: 'name', label: 'Nom' },
            { value: 'size', label: 'Taille' },
            { value: 'modified', label: 'Date fichier' }
        ],
        groupOptions: [
            { value: 'ALL', label: 'Tous' },
            { value: 'NO_META', label: 'Aucune métadonnée' },
            { value: 'MTIME', label: 'Date système de repli' }
        ],
        layoutOptions: _MEDIA_LAYOUT_OPTS,
        defaults: { sortBy: 'name', sortOrder: 'asc', groupBy: 'ALL', layout: 'GRID', size: 'MD' }
    }
};

let _pageSettingsCtx = { pageKey: 'albums', groupScope: 'albums' };

function getPageDefaultOptions(pageKey) {
    const cfg = PAGE_SETTINGS_CONFIG[pageKey];
    if (!cfg || !cfg.hasDefaults) return null;
    try {
        const raw = localStorage.getItem(`phototo_page_defaults_${pageKey}`);
        if (!raw) return null;
        return { ...cfg.defaults, ...JSON.parse(raw) };
    } catch (e) {
        return null;
    }
}

function applyPageDefaultOptions(pageKey, shouldReload = false) {
    const saved = getPageDefaultOptions(pageKey);
    if (!saved) return false;
    if (pageKey === 'albums') {
        const sb = document.getElementById('alb-sort-by');
        const so = document.getElementById('alb-sort-order');
        const gb = document.getElementById('alb-group-by');
        if (sb) sb.value = saved.sortBy;
        if (so) so.value = saved.sortOrder;
        if (gb) gb.value = saved.groupBy;
        if (typeof _syncSortDirButtonUI === 'function') _syncSortDirButtonUI(saved.sortOrder === 'asc', 'alb-sort-dir-btn', 'alb-sort-arrow');
        if (typeof albumLayout !== 'undefined') { albumLayout = saved.layout; localStorage.setItem('phototo_album_layout', saved.layout); }
        if (typeof albumSize !== 'undefined') { albumSize = saved.size; localStorage.setItem('phototo_album_size', saved.size); }
        if (typeof syncAlbumLayoutSizeButtons === 'function') syncAlbumLayoutSizeButtons();
        if (shouldReload && typeof renderAlbumsOverviewFromCache === 'function') renderAlbumsOverviewFromCache();
        return true;
    }
    if (pageKey === 'persons') {
        const sb = document.getElementById('faces-sort-by');
        const so = document.getElementById('faces-sort-order');
        const gb = document.getElementById('faces-group-by');
        if (sb) sb.value = saved.sortBy;
        if (so) so.value = saved.sortOrder;
        if (gb) gb.value = saved.groupBy;
        if (typeof _syncSortDirButtonUI === 'function') _syncSortDirButtonUI(saved.sortOrder === 'asc', 'faces-sort-dir-btn', 'faces-sort-arrow');
        if (typeof facesLayout !== 'undefined') { facesLayout = saved.layout; localStorage.setItem('phototo_faces_layout', saved.layout); }
        if (typeof facesSize !== 'undefined') { facesSize = saved.size; localStorage.setItem('phototo_faces_size', saved.size); }
        if (typeof syncFacesLayoutSizeButtons === 'function') syncFacesLayoutSizeButtons();
        if (shouldReload && typeof renderPersonsOverviewFromCache === 'function') renderPersonsOverviewFromCache();
        return true;
    }
    if (pageKey === 'places') {
        const sb = document.getElementById('places-sort-by');
        const so = document.getElementById('places-sort-order');
        const gb = document.getElementById('places-group-by');
        if (sb) sb.value = saved.sortBy;
        if (so) so.value = saved.sortOrder;
        if (gb) gb.value = saved.groupBy;
        if (typeof _syncSortDirButtonUI === 'function') _syncSortDirButtonUI(saved.sortOrder === 'asc', 'places-sort-dir-btn', 'places-sort-arrow');
        if (typeof placesLayout !== 'undefined') { placesLayout = saved.layout; localStorage.setItem('phototo_places_layout', saved.layout); }
        if (typeof placesSize !== 'undefined') { placesSize = saved.size; localStorage.setItem('phototo_places_size', saved.size); }
        if (typeof syncPlacesLayoutSizeButtons === 'function') syncPlacesLayoutSizeButtons();
        if (shouldReload && typeof renderPlacesOverviewFromCache === 'function') renderPlacesOverviewFromCache();
        return true;
    }
    if (pageKey === 'types') {
        const sb = document.getElementById('types-sort-by');
        const so = document.getElementById('types-sort-order');
        const fb = document.getElementById('types-filter-by');
        if (sb) sb.value = saved.sortBy;
        if (so) so.value = saved.sortOrder;
        if (fb) fb.value = saved.groupBy;
        if (typeof _syncSortDirButtonUI === 'function') _syncSortDirButtonUI(saved.sortOrder === 'asc', 'types-sort-dir-btn', 'types-sort-arrow');
        if (typeof typesLayout !== 'undefined') { typesLayout = saved.layout; localStorage.setItem('phototo_types_layout', saved.layout); }
        if (typeof typesSize !== 'undefined') { typesSize = saved.size; localStorage.setItem('phototo_types_size', saved.size); }
        if (typeof syncTypesLayoutSizeButtons === 'function') syncTypesLayoutSizeButtons();
        if (shouldReload && typeof renderSmartCategoriesFromCache === 'function') renderSmartCategoriesFromCache();
        return true;
    }
    if (pageKey === 'dups' || pageKey === 'similar') {
        const sb = document.getElementById(`${pageKey}-sort-by`);
        const so = document.getElementById(`${pageKey}-sort-order`);
        const fb = document.getElementById(`${pageKey}-filter-by`);
        const safeFilter = (saved.groupBy && saved.groupBy !== 'NONE' && saved.groupBy !== 'DAY' && saved.groupBy !== 'WEEK' && saved.groupBy !== 'MONTH' && saved.groupBy !== 'YEAR' && saved.groupBy !== 'SIZE') ? saved.groupBy : 'ALL';
        const safeLayout = saved.layout === 'MASONRY' ? 'MASONRY' : 'GRID';
        if (sb) sb.value = saved.sortBy;
        if (so) so.value = saved.sortOrder;
        if (fb) fb.value = safeFilter;
        if (typeof _syncSortDirButtonUI === 'function') _syncSortDirButtonUI(saved.sortOrder === 'asc', `${pageKey}-sort-dir-btn`, `${pageKey}-sort-arrow`);
        if (typeof _cmpViewState !== 'undefined' && _cmpViewState[pageKey]) {
            _cmpViewState[pageKey].layout = safeLayout;
            _cmpViewState[pageKey].size = saved.size;
            localStorage.setItem(`phototo_${pageKey}_layout`, safeLayout);
            localStorage.setItem(`phototo_${pageKey}_size`, saved.size);
        }
        if (typeof syncComparisonLayoutSizeButtons === 'function') syncComparisonLayoutSizeButtons(pageKey);
        if (shouldReload && typeof renderComparisonGroupsFromCache === 'function') renderComparisonGroupsFromCache(pageKey);
        return true;
    }
    if (pageKey === 'trash') {
        const sb = document.getElementById('trash-sort-by');
        const so = document.getElementById('trash-sort-order');
        const gb = document.getElementById('trash-group-by');
        if (sb) sb.value = saved.sortBy;
        if (so) so.value = saved.sortOrder;
        if (gb) gb.value = saved.groupBy;
        if (typeof _syncSortDirButtonUI === 'function') _syncSortDirButtonUI(saved.sortOrder === 'asc', 'trash-sort-dir-btn', 'trash-sort-arrow');
        if (typeof _trashViewState !== 'undefined') {
            _trashViewState.layout = saved.layout;
            _trashViewState.size = saved.size;
            localStorage.setItem('phototo_trash_layout', saved.layout);
            localStorage.setItem('phototo_trash_size', saved.size);
        }
        if (typeof syncTrashLayoutSizeButtons === 'function') syncTrashLayoutSizeButtons();
        if (shouldReload && typeof renderTrashFromCache === 'function') renderTrashFromCache();
        return true;
    }
    if (pageKey.startsWith('sug-')) {
        const sb = document.getElementById('sug-sort-by');
        const so = document.getElementById('sug-sort-order');
        const fb = document.getElementById('sug-filter-by');
        if (sb && [...sb.options].some(o => o.value === saved.sortBy)) sb.value = saved.sortBy;
        if (so) so.value = saved.sortOrder;
        if (fb && [...fb.options].some(o => o.value === saved.groupBy)) fb.value = saved.groupBy;
        if (typeof _syncSortDirButtonUI === 'function') _syncSortDirButtonUI(saved.sortOrder === 'asc', 'sug-sort-dir-btn', 'sug-sort-arrow');
        if (typeof _sugPageState !== 'undefined') {
            _sugPageState.layout = saved.layout || 'GRID';
            _sugPageState.size = saved.size || 'MD';
            localStorage.setItem(`phototo_${pageKey}_layout`, _sugPageState.layout);
            localStorage.setItem(`phototo_${pageKey}_size`, _sugPageState.size);
        }
        if (typeof syncSugPageLayoutSizeButtons === 'function') syncSugPageLayoutSizeButtons();
        if (shouldReload && typeof openSuggestionPage === 'function') openSuggestionPage(pageKey.slice(4), true);
        return true;
    }
    const sb = document.getElementById('gal-sort-by');
    const so = document.getElementById('gal-sort-order');
    const gb = document.getElementById('gal-group-by');
    if (sb) sb.value = saved.sortBy;
    if (so) so.value = saved.sortOrder;
    if (gb) gb.value = saved.groupBy;
    if (typeof galleryGroupBy !== 'undefined') galleryGroupBy = saved.groupBy;
    if (typeof _syncSortDirButtonUI === 'function') _syncSortDirButtonUI(saved.sortOrder === 'asc', 'gal-sort-dir-btn', 'gal-sort-arrow');
    if (typeof galleryLayout !== 'undefined') { galleryLayout = saved.layout; localStorage.setItem('phototo_gallery_layout', saved.layout); }
    if (typeof gallerySize !== 'undefined') { gallerySize = saved.size; localStorage.setItem('phototo_gallery_size', saved.size); }
    if (typeof syncLayoutAndSizeButtons === 'function') syncLayoutAndSizeButtons();
    if (shouldReload && typeof refreshActiveMediaView === 'function') refreshActiveMediaView();
    return true;
}

function openCurrentMediaPageSettings() {
    let pageKey = typeof currentTab !== 'undefined' ? currentTab : 'gallery';
    if (pageKey === 'albums' && typeof openedAlbumName !== 'undefined' && openedAlbumName) pageKey = 'album_single';
    else if (pageKey === 'faces' && typeof currentTimelinePersonId !== 'undefined' && currentTimelinePersonId !== null) pageKey = 'person_single';
    else if (pageKey === 'map' && typeof _openedPlaceBucketIdx !== 'undefined' && _openedPlaceBucketIdx >= 0) pageKey = 'place_single';
    else if (pageKey === 'map') pageKey = 'places';
    else if (!PAGE_SETTINGS_CONFIG[pageKey]) pageKey = 'gallery';
    openPageSettingsModal(pageKey);
}

function _syncPageDefaultSortOrderUI(order) {
    const isAsc = order === 'asc';
    const inp = document.getElementById('ps-def-sort-order');
    const lbl = document.getElementById('ps-def-sort-dir-label');
    if (inp) inp.value = isAsc ? 'asc' : 'desc';
    if (lbl) lbl.textContent = isAsc ? 'Croissant' : 'Décroissant';
    if (typeof _syncSortDirButtonUI === 'function') _syncSortDirButtonUI(isAsc, 'ps-def-sort-dir-btn', 'ps-def-sort-arrow');
}

function togglePageDefaultSortOrder() {
    const cur = document.getElementById('ps-def-sort-order')?.value || 'desc';
    _syncPageDefaultSortOrderUI(cur === 'asc' ? 'desc' : 'asc');
}

function openPageSettingsModal(pageKey) {
    const cfg = PAGE_SETTINGS_CONFIG[pageKey] || PAGE_SETTINGS_CONFIG.gallery;
    _pageSettingsCtx = { pageKey, groupScope: cfg.groupScope || null };
    const modal = document.getElementById('page-settings-modal');
    if (!modal) return;

    const titleEl = document.getElementById('ps-modal-title');
    if (titleEl) titleEl.textContent = cfg.title;

    const grpSec = document.getElementById('ps-groups-section');
    if (grpSec) grpSec.classList.toggle('hidden', !cfg.groupScope);
    if (cfg.groupScope) {
        const prefs = getCustomGroupPrefs(cfg.groupScope);
        const hideAllEl = document.getElementById('cg-pref-hide-all');
        const showCntEl = document.getElementById('cg-pref-show-count');
        if (hideAllEl) hideAllEl.checked = prefs.hideAll;
        if (showCntEl) showCntEl.checked = prefs.showCount;
        renderCustomGroupsManageList();
    }

    const trashPolicySec = document.getElementById('ps-trash-policy-section');
    if (trashPolicySec) {
        trashPolicySec.classList.toggle('hidden', !cfg.isTrash);
        if (cfg.isTrash) {
            const retSel = document.getElementById('ps-trash-retention-days');
            const curDays = (typeof _trashViewState !== 'undefined' && _trashViewState.retentionDays !== undefined)
                ? String(_trashViewState.retentionDays)
                : '30';
            if (retSel) {
                if (![...retSel.options].some(o => o.value === curDays)) {
                    const opt = document.createElement('option');
                    opt.value = curDays;
                    opt.textContent = curDays === '0' ? 'Illimitée' : `${curDays} jours`;
                    retSel.appendChild(opt);
                }
                retSel.value = curDays;
            }
        }
    }

    const sugSec = document.getElementById('ps-sug-settings-section');
    if (sugSec) {
        const f = cfg.sugSettingField || '';
        sugSec.classList.toggle('hidden', !f);
        document.getElementById('ps-sug-field-blur')?.classList.toggle('hidden', f !== 'blur');
        document.getElementById('ps-sug-field-large')?.classList.toggle('hidden', f !== 'large');
        document.getElementById('ps-sug-field-age')?.classList.toggle('hidden', f !== 'age');
        document.getElementById('ps-sug-field-gps')?.classList.toggle('hidden', f !== 'gps');
        if (f && typeof getSugToolSettings === 'function') {
            const curS = getSugToolSettings();
            if (f === 'blur' && document.getElementById('ps-sug-blur-thresh')) document.getElementById('ps-sug-blur-thresh').value = String(curS.blurThreshold || 45);
            if (f === 'large' && document.getElementById('ps-sug-large-min-mb')) document.getElementById('ps-sug-large-min-mb').value = String(curS.largeMinMb || 10);
            if (f === 'age' && document.getElementById('ps-sug-age-days')) document.getElementById('ps-sug-age-days').value = String(curS.ageDays ?? 90);
            if (f === 'gps' && document.getElementById('ps-sug-gps-gap')) document.getElementById('ps-sug-gps-gap').value = String(curS.gpsGapHours || 6);
        }
    }

    const defSec = document.getElementById('ps-defaults-section');
    const saveBtn = document.getElementById('ps-save-btn');
    if (defSec) defSec.classList.toggle('hidden', !cfg.hasDefaults);
    if (saveBtn) saveBtn.classList.toggle('hidden', !cfg.hasDefaults);

    if (cfg.hasDefaults) {
        const cur = getPageDefaultOptions(pageKey) || cfg.defaults;
        const grpLblEl = document.getElementById('ps-def-group-label');
        if (grpLblEl) grpLblEl.textContent = cfg.groupLabel || 'Regroupement';
        const fillSelect = (id, opts, val) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.innerHTML = opts.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
            el.value = opts.some(o => o.value === val) ? val : opts[0].value;
        };
        fillSelect('ps-def-sort-by', cfg.sortOptions, cur.sortBy);
        fillSelect('ps-def-group-by', cfg.groupOptions, cur.groupBy);
        fillSelect('ps-def-layout', cfg.layoutOptions, cur.layout);
        _syncPageDefaultSortOrderUI(cur.sortOrder);
        const sizeEl = document.getElementById('ps-def-size');
        if (sizeEl) sizeEl.value = cur.size;
    }

    modal.classList.remove('hidden');
}

function closePageSettingsModal() {
    document.getElementById('page-settings-modal')?.classList.add('hidden');
}

async function savePageDefaultOptions() {
    const { pageKey } = _pageSettingsCtx;
    const cfg = PAGE_SETTINGS_CONFIG[pageKey];
    if (!cfg || !cfg.hasDefaults) { closePageSettingsModal(); return; }
    const payload = {
        sortBy: document.getElementById('ps-def-sort-by')?.value || cfg.defaults.sortBy,
        sortOrder: document.getElementById('ps-def-sort-order')?.value || cfg.defaults.sortOrder,
        groupBy: document.getElementById('ps-def-group-by')?.value || cfg.defaults.groupBy,
        layout: document.getElementById('ps-def-layout')?.value || cfg.defaults.layout,
        size: document.getElementById('ps-def-size')?.value || cfg.defaults.size
    };
    try {
        localStorage.setItem(`phototo_page_defaults_${pageKey}`, JSON.stringify(payload));
    } catch (e) {}
    if (cfg.isTrash) {
        const retVal = Number(document.getElementById('ps-trash-retention-days')?.value ?? 30);
        try {
            const res = await fetch('/api/trash/policy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ retention_days: retVal })
            });
            if (res.ok && typeof loadTrashTab === 'function') {
                await loadTrashTab();
                if (typeof loadStats === 'function') loadStats();
            }
            if (typeof showAppToast === 'function') {
                showAppToast(
                    retVal > 0
                        ? `Durée de conservation réglée sur ${retVal} jours.`
                        : 'Conservation illimitée activée pour la corbeille.',
                    'success'
                );
            }
        } catch (e) {}
    }
    if (cfg.sugSettingField && typeof saveSugToolSettings === 'function') {
        const patch = {};
        if (cfg.sugSettingField === 'blur') patch.blurThreshold = Number(document.getElementById('ps-sug-blur-thresh')?.value || 45);
        if (cfg.sugSettingField === 'large') patch.largeMinMb = Number(document.getElementById('ps-sug-large-min-mb')?.value || 10);
        if (cfg.sugSettingField === 'age') patch.ageDays = Number(document.getElementById('ps-sug-age-days')?.value ?? 90);
        if (cfg.sugSettingField === 'gps') patch.gpsGapHours = Number(document.getElementById('ps-sug-gps-gap')?.value || 6);
        saveSugToolSettings(patch);
        if (typeof loadToolsSuggestionsSummary === 'function') loadToolsSuggestionsSummary();
    }
    applyPageDefaultOptions(pageKey, true);
    closePageSettingsModal();
}

function resetPageDefaultOptions() {
    const { pageKey } = _pageSettingsCtx;
    const cfg = PAGE_SETTINGS_CONFIG[pageKey];
    if (!cfg || !cfg.hasDefaults) return;
    try { localStorage.removeItem(`phototo_page_defaults_${pageKey}`); } catch (e) {}
    const d = cfg.defaults;
    if (document.getElementById('ps-def-sort-by')) document.getElementById('ps-def-sort-by').value = d.sortBy;
    _syncPageDefaultSortOrderUI(d.sortOrder);
    if (document.getElementById('ps-def-group-by')) document.getElementById('ps-def-group-by').value = d.groupBy;
    if (document.getElementById('ps-def-layout')) document.getElementById('ps-def-layout').value = d.layout;
    if (document.getElementById('ps-def-size')) document.getElementById('ps-def-size').value = d.size;
    localStorage.setItem(`phototo_page_defaults_${pageKey}`, JSON.stringify(d));
    if (cfg.sugSettingField && typeof saveSugToolSettings === 'function') {
        const patch = {};
        if (cfg.sugSettingField === 'blur') patch.blurThreshold = Number(document.getElementById('ps-sug-blur-thresh')?.value || 45);
        if (cfg.sugSettingField === 'large') patch.largeMinMb = Number(document.getElementById('ps-sug-large-min-mb')?.value || 10);
        if (cfg.sugSettingField === 'age') patch.ageDays = Number(document.getElementById('ps-sug-age-days')?.value ?? 90);
        if (cfg.sugSettingField === 'gps') patch.gpsGapHours = Number(document.getElementById('ps-sug-gps-gap')?.value || 6);
        saveSugToolSettings(patch);
        if (typeof loadToolsSuggestionsSummary === 'function') loadToolsSuggestionsSummary();
    }
    applyPageDefaultOptions(pageKey, true);
    localStorage.removeItem(`phototo_page_defaults_${pageKey}`);
}

function onChangeCustomGroupsPref() {
    const scope = _pageSettingsCtx.groupScope;
    if (!scope) return;
    const hideAll = Boolean(document.getElementById('cg-pref-hide-all')?.checked);
    const showCount = Boolean(document.getElementById('cg-pref-show-count')?.checked);
    setCustomGroupPrefs(scope, { hideAll, showCount });
    renderCustomGroupsBar(scope);
}

function renderCustomGroupsManageList() {
    const listEl = document.getElementById('cg-manage-list');
    if (!listEl) return;
    const scope = _pageSettingsCtx.groupScope;
    if (!scope) { listEl.innerHTML = ''; return; }
    const groups = customGroupsCache[scope] || [];
    if (!groups.length) {
        listEl.innerHTML = `<div class="text-xs opacity-60 py-4 text-center">Aucun groupe créé pour cette vue.</div>`;
        return;
    }
    listEl.innerHTML = groups.map((g, idx) => {
        const cnt = (g.item_keys || []).length;
        const safeName = _escGroupHtml(g.name);
        const jsName = String(g.name || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const upDisabled = idx === 0 ? 'opacity-25 pointer-events-none' : 'hover:bg-[var(--bg-hover)]';
        const downDisabled = idx === groups.length - 1 ? 'opacity-25 pointer-events-none' : 'hover:bg-[var(--bg-hover)]';
        return `
        <div class="flex items-center gap-2 ui-pill rounded-2xl px-3 py-2">
            <div class="flex flex-col gap-0.5 shrink-0">
                <button type="button" onclick="moveCustomGroupOrder('${scope}', ${idx}, -1)" title="Monter"
                        class="w-5 h-4 rounded flex items-center justify-center text-[10px] leading-none transition cursor-pointer ${upDisabled}">▲</button>
                <button type="button" onclick="moveCustomGroupOrder('${scope}', ${idx}, 1)" title="Descendre"
                        class="w-5 h-4 rounded flex items-center justify-center text-[10px] leading-none transition cursor-pointer ${downDisabled}">▼</button>
            </div>
            <input type="text" value="${safeName}"
                   onchange="renameCustomGroupInline('${scope}', ${g.group_id}, this.value)"
                   title="Modifier le nom"
                   class="flex-1 min-w-0 bg-transparent hover:bg-[var(--bg-hover)] focus:bg-[var(--bg-card)] rounded-lg px-2 py-1 text-xs font-extrabold outline-none transition"/>
            <span class="inline-flex items-center justify-center min-w-[20px] h-[20px] px-1.5 rounded-full bg-black/15 text-[10px] font-extrabold shrink-0">${cnt}</span>
            <button type="button" onclick="closePageSettingsModal(); openCustomGroupModal('${scope}', ${g.group_id})"
                    title="Modifier les éléments du groupe"
                    class="w-7 h-7 rounded-full hover:bg-[var(--bg-hover)] flex items-center justify-center opacity-75 hover:opacity-100 transition cursor-pointer shrink-0">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.1" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            </button>
            <button type="button" onclick="deleteCustomGroup('${scope}', ${g.group_id}, '${jsName}')"
                    title="Supprimer ce groupe"
                    class="w-7 h-7 rounded-full hover:bg-rose-500/20 hover:text-rose-400 flex items-center justify-center opacity-75 hover:opacity-100 transition cursor-pointer shrink-0 text-xs">
                ✕
            </button>
        </div>`;
    }).join('');
}

document.addEventListener('DOMContentLoaded', () => {
    ['albums', 'persons'].forEach(k => applyPageDefaultOptions(k, false));
});

async function moveCustomGroupOrder(scope, idx, delta) {
    const groups = customGroupsCache[scope] || [];
    const targetIdx = idx + delta;
    if (targetIdx < 0 || targetIdx >= groups.length) return;
    const reordered = [...groups];
    const [moved] = reordered.splice(idx, 1);
    reordered.splice(targetIdx, 0, moved);
    customGroupsCache[scope] = reordered;
    renderCustomGroupsBar(scope);
    renderCustomGroupsManageList();
    await fetch('/api/groups/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, group_ids: reordered.map(g => g.group_id) })
    });
}

async function renameCustomGroupInline(scope, groupId, newName) {
    const trimmed = (newName || '').trim();
    if (!trimmed) {
        renderCustomGroupsManageList();
        return;
    }
    const res = await fetch('/api/groups/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_id: groupId, new_name: trimmed })
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.detail || 'Impossible de renommer ce groupe.');
        renderCustomGroupsManageList();
        return;
    }
    await loadCustomGroups(scope);
    renderCustomGroupsManageList();
}
