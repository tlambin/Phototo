// ==================== GESTION DES BIBLIOTHÈQUES (LISTE, CRÉER, MODIFIER, SUPPRIMER, FUSIONNER, DOUBLONS AUTO) ====================

function _renderLibraryAvatarElements(letterId, imgId, libName, iconUrl) {
    const letterEl = document.getElementById(letterId);
    const imgEl = document.getElementById(imgId);
    const cleanName = String(libName || 'Bibliothèque').trim();
    const firstLetter = (cleanName.charAt(0) || 'B').toUpperCase();
    if (letterEl) letterEl.textContent = firstLetter;
    if (imgEl && letterEl) {
        if (iconUrl) {
            imgEl.src = iconUrl;
            imgEl.classList.remove('hidden');
            letterEl.classList.add('hidden');
        } else {
            imgEl.src = '';
            imgEl.classList.add('hidden');
            letterEl.classList.remove('hidden');
        }
    }
}

function syncActiveLibraryAvatars() {
    const active = librariesConfig?.active_library;
    const libs = librariesConfig?.libraries || {};
    const activeLib = (active && libs[active]) ? libs[active] : null;
    const iconUrl = (activeLib && activeLib.icon_url) ? activeLib.icon_url : '';

    const avatarBtn = document.getElementById('lib-avatar-btn');
    if (avatarBtn) {
        avatarBtn.title = active ? `Bibliothèque : ${active}` : 'Gérer les bibliothèques';
    }
    _renderLibraryAvatarElements('lib-avatar-letter', 'lib-avatar-img', active, iconUrl);
    _renderLibraryAvatarElements('lib-pop-avatar-letter', 'lib-pop-avatar-img', active, iconUrl);
    _renderLibraryAvatarElements('lib-edit-avatar-letter', 'lib-edit-avatar-img', active, iconUrl);

    const resetBtn = document.getElementById('lib-edit-icon-reset-btn');
    if (resetBtn) resetBtn.classList.toggle('hidden', !iconUrl);
}

async function loadLibrariesDropdown() {
    const res = await fetch('/api/libraries');
    if (!res.ok) return;
    cachedLibrariesData = await res.json();
    librariesConfig = cachedLibrariesData;

    const active = cachedLibrariesData.active_library;
    const libs = cachedLibrariesData.libraries || {};
    const names = Object.keys(libs);

    syncActiveLibraryAvatars();

    // Mise à jour du <select id="library-selector"> dans topbar.html
    const selEl = document.getElementById('library-selector');
    if (selEl) {
        if (!names.length) {
            selEl.innerHTML = `<option value="">Aucune bibliothèque</option>`;
        } else {
            selEl.innerHTML = names.map(n => `<option value="${n}" ${n === active ? 'selected' : ''}>${n}</option>`).join('');
        }
    }
}

function triggerLibraryIconUpload() {
    const active = librariesConfig?.active_library;
    if (!active) {
        alert("Créez ou sélectionnez d'abord une bibliothèque.");
        return;
    }
    const inp = document.getElementById('lib-icon-file-input');
    if (inp) inp.click();
}

async function uploadActiveLibraryIcon(input) {
    const file = input?.files?.[0];
    if (!file) return;
    const active = librariesConfig?.active_library;
    if (!active) {
        input.value = '';
        return;
    }
    const formData = new FormData();
    formData.append('file', file);
    try {
        const res = await fetch(`/api/libraries/icon/${encodeURIComponent(active)}`, {
            method: 'POST',
            body: formData
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            alert(err.detail || "Impossible d'enregistrer l'image de la bibliothèque.");
            return;
        }
        await loadLibrariesDropdown();
    } finally {
        input.value = '';
    }
}

async function resetActiveLibraryIcon() {
    const active = librariesConfig?.active_library;
    if (!active) return;
    const res = await fetch(`/api/libraries/icon/${encodeURIComponent(active)}`, {
        method: 'DELETE'
    });
    if (res.ok) {
        await loadLibrariesDropdown();
    }
}

const loadLibrariesList = loadLibrariesDropdown;

async function switchLibrary(name) {
    if (!name) return;
    hideAllTopPopovers();
    const res = await fetch('/api/libraries/select', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name})
    });
    if (res.ok) {
        await loadLibrariesDropdown();
        await loadStats();
        await loadGalleryFilters();
        refreshActiveMediaView();
        if (typeof loadActivitiesHistory === 'function' && currentTab === 'activities') {
            loadActivitiesHistory();
        }
    }
}

const selectLibrary = switchLibrary;

// Fonctions appelées par les 3 boutons de topbar.html
function openLibraryModal(mode = 'CREATE') {
    if (String(mode).toUpperCase() === 'EDIT') {
        openEditLibraryModal();
    } else {
        openCreateLibraryModal();
    }
}

function openMergeLibrariesModal() {
    openMergeLibraryModal();
}

function showLibraryModalView(viewId) {
    ['lib-view-create', 'lib-view-edit', 'lib-view-delete', 'lib-view-remove-source'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', id !== viewId);
    });
    document.getElementById('library-modal').classList.remove('hidden');
}

function _normalizeLibFolderKey(pathStr) {
    return String(pathStr || '').trim().replace(/[\\/]+$/, '').toLowerCase();
}

function _appendUniqueLibFolder(folders, chosenPath) {
    const clean = String(chosenPath || '').trim();
    if (!clean) return false;
    const key = _normalizeLibFolderKey(clean);
    if (folders.some(f => _normalizeLibFolderKey(f) === key)) return false;
    folders.push(clean);
    return true;
}

function _renderLibrarySourcesList(mode) {
    const isCreate = mode === 'create';
    const folders = isCreate ? pendingCreateLibFolders : pendingEditLibFolders;
    const listEl = document.getElementById(isCreate ? 'lib-create-sources-list' : 'lib-edit-sources-list');
    const countEl = document.getElementById(isCreate ? 'lib-create-sources-count' : 'lib-edit-sources-count');

    if (countEl) {
        countEl.textContent = String(folders.length);
        if (isCreate) countEl.classList.toggle('hidden', folders.length === 0);
    }
    if (!listEl) return;

    listEl.innerHTML = '';
    if (isCreate) listEl.classList.toggle('hidden', folders.length === 0);
    if (!folders.length) {
        if (!isCreate) {
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'text-[11px] font-semibold opacity-55 px-2 py-1';
            emptyDiv.textContent = 'Aucune source sélectionnée.';
            listEl.appendChild(emptyDiv);
        }
        return;
    }

    folders.forEach((folderPath, idx) => {
        const displayPath = folderPath.replace(/\\/g, '/');
        const row = document.createElement('div');
        row.className = 'ui-pill rounded-xl px-3 py-1.5 flex items-center justify-between gap-2 text-[11px] font-bold';

        const left = document.createElement('div');
        left.className = 'min-w-0 flex items-center gap-1.5 flex-1';

        if (idx === 0 && folders.length > 1) {
            const badge = document.createElement('span');
            badge.className = 'plum-btn px-1.5 py-0.5 rounded-full text-[9px] font-extrabold shrink-0';
            badge.textContent = 'Principale';
            left.appendChild(badge);
        }

        const txt = document.createElement('span');
        txt.className = 'truncate';
        txt.title = displayPath;
        txt.textContent = displayPath;
        left.appendChild(txt);

        const actions = document.createElement('div');
        actions.className = 'flex items-center gap-1 shrink-0';

        if (idx > 0) {
            const starBtn = document.createElement('button');
            starBtn.type = 'button';
            starBtn.title = 'Définir comme source principale';
            starBtn.className = 'w-5 h-5 rounded-full hover:bg-amber-500/20 hover:text-amber-300 opacity-75 hover:opacity-100 flex items-center justify-center transition cursor-pointer';
            starBtn.innerHTML = `<svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
            starBtn.onclick = () => setPrimaryLibrarySource(mode, idx);
            actions.appendChild(starBtn);
        }

        const remBtn = document.createElement('button');
        remBtn.type = 'button';
        remBtn.title = 'Retirer ce dossier';
        remBtn.className = 'w-5 h-5 rounded-full hover:bg-rose-500/20 hover:text-rose-400 flex items-center justify-center text-[10px] shrink-0 transition cursor-pointer';
        remBtn.textContent = '✕';
        remBtn.onclick = () => removeLibrarySourceFolder(mode, idx);
        actions.appendChild(remBtn);

        row.appendChild(left);
        row.appendChild(actions);
        listEl.appendChild(row);
    });
}

function setPrimaryLibrarySource(mode, idx) {
    const folders = mode === 'create' ? pendingCreateLibFolders : pendingEditLibFolders;
    if (idx <= 0 || idx >= folders.length) return;
    const [chosen] = folders.splice(idx, 1);
    folders.unshift(chosen);
    _renderLibrarySourcesList(mode);
}

let _savedEditLibFolders = new Set();
let _pendingRemoveSource = null;

function removeLibrarySourceFolder(mode, idx) {
    const folders = mode === 'create' ? pendingCreateLibFolders : pendingEditLibFolders;
    if (idx < 0 || idx >= folders.length) return;
    if (mode === 'edit' && folders.length <= 1) {
        alert("La bibliothèque doit conserver au moins une source. Ajoutez d'abord un autre dossier.");
        return;
    }

    const path = folders[idx];
    const otherFolders = folders.filter((_, i) => i !== idx);
    const wasSaved = mode === 'edit' && _savedEditLibFolders.has(_normalizeLibFolderKey(path));
    _pendingRemoveSource = { mode, idx, path, wasSaved };

    const pathEl = document.getElementById('lib-remove-src-path');
    if (pathEl) {
        pathEl.textContent = path.replace(/\\/g, '/');
        pathEl.title = path.replace(/\\/g, '/');
    }

    const transferBox = document.getElementById('lib-remove-transfer-box');
    const transferChk = document.getElementById('lib-remove-transfer-chk');
    const dstSel = document.getElementById('lib-remove-transfer-dst');
    const canTransfer = mode === 'edit' && wasSaved && otherFolders.length > 0;
    if (transferBox) transferBox.classList.toggle('hidden', !canTransfer);
    if (transferChk) transferChk.checked = false;
    if (dstSel) {
        dstSel.classList.add('hidden');
        dstSel.innerHTML = '';
        otherFolders.forEach(dstPath => {
            const opt = document.createElement('option');
            opt.value = dstPath;
            opt.textContent = dstPath.replace(/\\/g, '/');
            dstSel.appendChild(opt);
        });
    }

    showLibraryModalView('lib-view-remove-source');
}

function toggleRemoveSourceTransferSelect() {
    const chk = document.getElementById('lib-remove-transfer-chk');
    const dstSel = document.getElementById('lib-remove-transfer-dst');
    if (dstSel && chk) {
        dstSel.classList.toggle('hidden', !chk.checked);
    }
}

function cancelRemoveLibrarySource() {
    const mode = _pendingRemoveSource?.mode || 'edit';
    _pendingRemoveSource = null;
    showLibraryModalView(mode === 'create' ? 'lib-view-create' : 'lib-view-edit');
}

async function confirmRemoveLibrarySource() {
    if (!_pendingRemoveSource) return;
    const { mode, idx, path, wasSaved } = _pendingRemoveSource;
    const folders = mode === 'create' ? pendingCreateLibFolders : pendingEditLibFolders;

    if (mode === 'edit' && wasSaved) {
        const active = librariesConfig?.active_library;
        if (!active) return;
        const transferChk = document.getElementById('lib-remove-transfer-chk');
        const dstSel = document.getElementById('lib-remove-transfer-dst');
        const transferContent = Boolean(transferChk && transferChk.checked);
        const targetSource = transferContent ? (dstSel?.value || '') : '';

        const res = await fetch('/api/libraries/remove_source', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                library_name: active,
                remove_source: path,
                transfer_content: transferContent,
                target_source: targetSource
            })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            alert(err.detail || "Impossible de retirer cette source.");
            return;
        }
        _savedEditLibFolders.delete(_normalizeLibFolderKey(path));
        if (transferContent && targetSource) {
            _savedEditLibFolders.add(_normalizeLibFolderKey(targetSource));
        }
        await loadLibrariesDropdown();
        if (transferContent) {
            await loadGalleryFilters();
            refreshActiveMediaView();
            loadStats();
        }
    }

    if (idx >= 0 && idx < folders.length && folders[idx] === path) {
        folders.splice(idx, 1);
    } else {
        const key = _normalizeLibFolderKey(path);
        const foundIdx = folders.findIndex(f => _normalizeLibFolderKey(f) === key);
        if (foundIdx >= 0) folders.splice(foundIdx, 1);
    }

    _pendingRemoveSource = null;
    _renderLibrarySourcesList(mode);
    showLibraryModalView(mode === 'create' ? 'lib-view-create' : 'lib-view-edit');
}

let pendingCreateLibIconFile = null;
let _pendingCreateIconPreviewUrl = null;

function syncCreateLibraryAvatarPreview() {
    const nameVal = (document.getElementById('lib-create-name')?.value || '').trim();
    _renderLibraryAvatarElements(
        'lib-create-avatar-letter',
        'lib-create-avatar-img',
        nameVal || 'Bibliothèque',
        _pendingCreateIconPreviewUrl || ''
    );
    const resetBtn = document.getElementById('lib-create-icon-reset-btn');
    if (resetBtn) resetBtn.classList.toggle('hidden', !_pendingCreateIconPreviewUrl);
}

function triggerCreateLibraryIconUpload() {
    const inp = document.getElementById('lib-create-icon-file-input');
    if (inp) inp.click();
}

function handleCreateLibraryIconSelect(input) {
    const file = input?.files?.[0];
    if (!file) return;
    if (_pendingCreateIconPreviewUrl) {
        try { URL.revokeObjectURL(_pendingCreateIconPreviewUrl); } catch (_) {}
    }
    pendingCreateLibIconFile = file;
    _pendingCreateIconPreviewUrl = URL.createObjectURL(file);
    syncCreateLibraryAvatarPreview();
}

function resetCreateLibraryIcon() {
    pendingCreateLibIconFile = null;
    if (_pendingCreateIconPreviewUrl) {
        try { URL.revokeObjectURL(_pendingCreateIconPreviewUrl); } catch (_) {}
    }
    _pendingCreateIconPreviewUrl = null;
    const inp = document.getElementById('lib-create-icon-file-input');
    if (inp) inp.value = '';
    syncCreateLibraryAvatarPreview();
}

function openCreateLibraryModal() {
    hideAllTopPopovers();
    pendingCreateLibFolders = [];
    const nameInput = document.getElementById('lib-create-name');
    if (nameInput) nameInput.value = '';
    resetCreateLibraryIcon();
    _renderLibrarySourcesList('create');
    showLibraryModalView('lib-view-create');
}

function toggleEditLibraryNameInput(show, resetInput = false) {
    const disp = document.getElementById('lib-edit-name-display');
    const editor = document.getElementById('lib-edit-name-editor');
    const inp = document.getElementById('lib-edit-new-name');
    const curEl = document.getElementById('lib-edit-current-name');
    const active = librariesConfig?.active_library || '';

    if (resetInput && inp) {
        inp.value = '';
        if (curEl) curEl.textContent = active;
    }
    if (disp) disp.classList.toggle('hidden', !!show);
    if (editor) editor.classList.toggle('hidden', !show);
    if (show && inp) {
        if (!inp.value.trim()) {
            inp.value = curEl?.textContent?.trim() || active;
        }
        setTimeout(() => { inp.focus(); inp.select(); }, 20);
    }
}

function applyInlineLibraryNamePreview() {
    const inp = document.getElementById('lib-edit-new-name');
    const curEl = document.getElementById('lib-edit-current-name');
    const val = (inp?.value || '').trim();
    if (val && curEl) {
        curEl.textContent = val;
    }
    toggleEditLibraryNameInput(false, false);
}

function openEditLibraryModal() {
    hideAllTopPopovers();
    const active = librariesConfig.active_library;
    if (!active || !librariesConfig.libraries || !librariesConfig.libraries[active]) {
        return openCreateLibraryModal();
    }
    const lib = librariesConfig.libraries[active];
    const existingSources = (Array.isArray(lib.source_paths) && lib.source_paths.length)
        ? lib.source_paths.filter(Boolean)
        : (lib.dest_dir ? [lib.dest_dir] : []);
    pendingEditLibFolders = existingSources.slice();
    _savedEditLibFolders = new Set(existingSources.map(_normalizeLibFolderKey));

    document.getElementById('lib-edit-current-name').textContent = lib.name;
    document.getElementById('lib-edit-new-name').value = '';
    toggleEditLibraryNameInput(false, true);
    _renderLibrarySourcesList('edit');
    syncActiveLibraryAvatars();

    showLibraryModalView('lib-view-edit');
}

function closeLibraryModal() {
    document.getElementById('library-modal').classList.add('hidden');
}

async function pickLibraryFolder(mode, createNewSubfolder = false) {
    // Si createNewSubfolder est vrai, on appelle mode=create_folder qui ouvre la boîte de création directe de dossier Windows
    const dialogMode = createNewSubfolder ? 'create_folder' : 'folder';
    const res = await fetch(`/api/dialog/browse?mode=${dialogMode}`);
    if (!res.ok) return;
    const d = await res.json();
    if (!d.paths || !d.paths.length) return;
    const chosenPath = d.paths[0];

    if (mode === 'create') {
        _appendUniqueLibFolder(pendingCreateLibFolders, chosenPath);
        _renderLibrarySourcesList('create');
        // Si le champ nom de la bibliothèque est encore vide, le pré-remplir avec le nom du premier dossier choisi
        const nameInput = document.getElementById('lib-create-name');
        if (nameInput && !nameInput.value.trim() && pendingCreateLibFolders.length) {
            nameInput.value = pendingCreateLibFolders[0].split(/[\\/]/).filter(Boolean).pop() || '';
            syncCreateLibraryAvatarPreview();
        }
    } else {
        _appendUniqueLibFolder(pendingEditLibFolders, chosenPath);
        _renderLibrarySourcesList('edit');
    }
}

async function submitCreateLibraryModal() {
    const name = (document.getElementById('lib-create-name').value || '').trim();
    if (!name) {
        alert("Veuillez choisir un nom pour la bibliothèque.");
        return;
    }
    if (!pendingCreateLibFolders.length) {
        alert("Veuillez ajouter au moins un dossier source.");
        return;
    }

    const res = await fetch('/api/libraries/create', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            name: name,
            source_type: 'STANDARD_FOLDER',
            source_paths_raw: pendingCreateLibFolders.join('\n'),
            dest_dir: pendingCreateLibFolders[0],
            fix_takeout_json_metadata: true,
            delete_zips_progressively: false,
            organize_by_year_month: true
        })
    });
    if (res.ok) {
        if (pendingCreateLibIconFile) {
            const fd = new FormData();
            fd.append('file', pendingCreateLibIconFile);
            try {
                await fetch(`/api/libraries/icon/${encodeURIComponent(name)}`, {
                    method: 'POST',
                    body: fd
                });
            } catch (_) {}
        }
        resetCreateLibraryIcon();
        closeLibraryModal();
        await loadLibrariesDropdown();
        await loadGalleryFilters();
        refreshActiveMediaView();
        loadStats();
    }
}

async function submitEditLibraryModal() {
    const origName = librariesConfig.active_library;
    if (!origName) return;
    if (!pendingEditLibFolders.length) {
        alert("Veuillez conserver ou ajouter au moins un dossier source.");
        return;
    }
    const newName = (document.getElementById('lib-edit-new-name').value || '').trim() || origName;

    const res = await fetch('/api/libraries/update', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            original_name: origName,
            new_name: newName,
            new_sources: pendingEditLibFolders.slice(),
            move_existing_content: false
        })
    });
    if (res.ok) {
        closeLibraryModal();
        await loadLibrariesDropdown();
        await loadGalleryFilters();
        refreshActiveMediaView();
        loadStats();
    }
}

function showDeleteLibraryConfirm() {
    document.getElementById('lib-delete-win-files').checked = false;
    showLibraryModalView('lib-view-delete');
}

function backToEditLibraryModal() {
    showLibraryModalView('lib-view-edit');
}

async function confirmDeleteActiveLibrary() {
    const active = librariesConfig.active_library;
    if (!active) return;
    const delWin = document.getElementById('lib-delete-win-files').checked;

    const res = await fetch('/api/libraries/delete', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            name: active,
            delete_windows_files: delWin
        })
    });
    if (res.ok) {
        closeLibraryModal();
        await loadLibrariesDropdown();
        await loadGalleryFilters();
        refreshActiveMediaView();
        loadStats();
    }
}

// ==================== FUSION DE BIBLIOTHÈQUES & DOUBLONS AUTOMATIQUES ====================

function showMergeStep(stepId) {
    ['merge-step-select', 'merge-step-done', 'merge-step-auto-config'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', id !== stepId);
    });
    document.getElementById('merge-lib-modal').classList.remove('hidden');
}

function openMergeLibraryModal() {
    hideAllTopPopovers();
    const names = Object.keys(librariesConfig.libraries || {});
    if (names.length < 2) {
        alert("Créez au moins 2 bibliothèques pour pouvoir les fusionner.");
        return;
    }
    const active = librariesConfig.active_library || names[0];
    const otherNames = names.filter(n => n !== active);

    document.getElementById('merge-src-lib').innerHTML =
        `<option value="" disabled selected>Selectionnez la biblioteque</option>` +
        otherNames.map(n => `<option value="${n}">${n}</option>`).join('');

    document.getElementById('merge-dst-lib-label').textContent = active;
    document.getElementById('merge-dst-lib').innerHTML = `<option value="${active}" selected>${active}</option>`;

    showMergeStep('merge-step-select');
}

function closeMergeLibraryModal() {
    document.getElementById('merge-lib-modal').classList.add('hidden');
}

async function confirmMergeLibraries(fastMerge = false) {
    const srcEl = document.getElementById('merge-src-lib');
    const src = srcEl ? srcEl.value : '';
    const dst = librariesConfig.active_library || document.getElementById('merge-dst-lib')?.value || '';

    if (!src) {
        alert("Veuillez d'abord dérouler la liste et sélectionner la bibliothèque à fusionner.");
        return;
    }

    const res = await fetch('/api/libraries/merge', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            source_lib_name: src,
            target_lib_name: dst,
            fast_merge: Boolean(fastMerge)
        })
    });

    if (!res.ok) {
        try {
            const err = await res.json();
            alert(err.detail || "Erreur lors de la fusion des bibliothèques.");
        } catch (e) {
            alert("Erreur lors de la fusion des bibliothèques.");
        }
        return;
    }

    const d = await res.json();

    await loadLibrariesDropdown();
    await loadGalleryFilters();
    refreshActiveMediaView();
    loadStats();

    if (fastMerge) {
        closeMergeLibraryModal();
        return;
    }

    const countEl = document.getElementById('merge-dups-found-count');
    if (countEl) countEl.textContent = d.duplicates_detected || 0;
    showMergeStep('merge-step-done');
}

function openAutoDuplicatesConfigStep() {
    hideAllTopPopovers();
    setAutoDupMode('KEEP_ONE');
    selectAutoDupPriority('BEST_QUALITY', 'la meilleure qualité');
    autoDupExtraPriorities = [];
    const exactChk = document.getElementById('autodup-chk-exact-only');
    if (exactChk) exactChk.checked = false;
    _renderAutoDupExtraPriorities();
    showMergeStep('merge-step-auto-config');
}

function _renderAutoDupExtraPriorities() {
    renderExtraPriorityRows(
        'autodup-extra-priorities',
        'autodup-add-priority-btn',
        autoDupExtraPriorities,
        'onAutoDupExtraPriorityChange',
        'removeAutoDupPriority',
        ''
    );
}

function addAutoDupPriority() {
    const next = pickNextUnusedPriority([autoDupPriority, ...autoDupExtraPriorities]);
    if (!next) return;
    autoDupExtraPriorities.push(next);
    _renderAutoDupExtraPriorities();
}

function onAutoDupExtraPriorityChange(selectEl) {
    const idx = Number(selectEl?.dataset?.extraPriorityIdx);
    if (Number.isInteger(idx) && idx >= 0 && idx < autoDupExtraPriorities.length) {
        autoDupExtraPriorities[idx] = selectEl.value;
    }
}

function removeAutoDupPriority(idx) {
    autoDupExtraPriorities.splice(idx, 1);
    _renderAutoDupExtraPriorities();
}

function setAutoDupMode(mode) {
    autoDupMode = mode;
    document.getElementById('autodup-radio-both').textContent = (mode === 'KEEP_BOTH') ? '✓' : '';
    document.getElementById('autodup-radio-one').textContent = (mode === 'KEEP_ONE') ? '✓' : '';
    const prioSec = document.getElementById('autodup-priority-section');
    const prioMenu = document.getElementById('autodup-priority-menu');
    if (prioSec) prioSec.classList.toggle('opacity-40', mode === 'KEEP_BOTH');
    if (prioMenu) prioMenu.classList.toggle('hidden', mode === 'KEEP_BOTH');
}

function toggleAutoDupPriorityMenu() {
    const menu = document.getElementById('autodup-priority-menu');
    if (menu) menu.classList.toggle('hidden');
}

function selectAutoDupPriority(code, label) {
    autoDupPriority = code;
    const lbl = document.getElementById('autodup-priority-label');
    if (lbl) lbl.textContent = label;
}

async function submitAutoDuplicatesResolution() {
    const priorities = [autoDupPriority, ...autoDupExtraPriorities].filter(Boolean);
    const exactOnly = Boolean(document.getElementById('autodup-chk-exact-only')?.checked);
    const res = await fetch('/api/duplicates/auto_resolve', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            mode: autoDupMode,
            priority: priorities[0] || autoDupPriority,
            priorities,
            exact_only: exactOnly,
            update_albums: document.getElementById('autodup-chk-albums').checked,
            move_to_trash: document.getElementById('autodup-chk-trash').checked
        })
    });
    if (res.ok) {
        closeMergeLibraryModal();
        refreshActiveMediaView();
        loadStats();
    }
}
