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
    ['lib-view-create', 'lib-view-edit', 'lib-view-delete'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', id !== viewId);
    });
    document.getElementById('library-modal').classList.remove('hidden');
}

function openCreateLibraryModal() {
    hideAllTopPopovers();
    pendingCreateLibFolder = '';
    const nameInput = document.getElementById('lib-create-name');
    if (nameInput) nameInput.value = '';
    const pathLbl = document.getElementById('lib-create-selected-path');
    if (pathLbl) {
        pathLbl.textContent = '';
        pathLbl.classList.add('hidden');
    }
    showLibraryModalView('lib-view-create');
}

function openEditLibraryModal() {
    hideAllTopPopovers();
    const active = librariesConfig.active_library;
    if (!active || !librariesConfig.libraries || !librariesConfig.libraries[active]) {
        return openCreateLibraryModal();
    }
    const lib = librariesConfig.libraries[active];
    pendingEditLibFolder = '';
    editMoveExistingContent = false;

    document.getElementById('lib-edit-current-name').textContent = lib.name;
    document.getElementById('lib-edit-new-name').value = '';
    const curSrc = (lib.source_paths && lib.source_paths[0]) ? lib.source_paths[0] : (lib.dest_dir || '');
    document.getElementById('lib-edit-current-source').textContent = curSrc.replace(/\\/g, '/');
    document.getElementById('lib-edit-move-dot').classList.add('hidden');
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
        pendingCreateLibFolder = chosenPath;
        const pathLbl = document.getElementById('lib-create-selected-path');
        if (pathLbl) {
            pathLbl.textContent = chosenPath.replace(/\\/g, '/');
            pathLbl.classList.remove('hidden');
        }
        // Si le champ nom de la bibliothèque est encore vide, le pré-remplir avec le nom du dossier créé
        const nameInput = document.getElementById('lib-create-name');
        if (nameInput && !nameInput.value.trim()) {
            nameInput.value = chosenPath.split(/[\\/]/).filter(Boolean).pop() || '';
        }
    } else {
        pendingEditLibFolder = chosenPath;
        document.getElementById('lib-edit-current-source').textContent = chosenPath.replace(/\\/g, '/');
    }
}

async function submitCreateLibraryModal() {
    const name = (document.getElementById('lib-create-name').value || '').trim();
    if (!name) {
        alert("Veuillez choisir un nom pour la bibliothèque.");
        return;
    }
    if (!pendingCreateLibFolder) {
        alert("Veuillez sélectionner un dossier existant ou créer un nouveau dossier.");
        return;
    }

    const res = await fetch('/api/libraries/create', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            name: name,
            source_type: 'STANDARD_FOLDER',
            source_paths_raw: pendingCreateLibFolder,
            dest_dir: pendingCreateLibFolder,
            fix_takeout_json_metadata: true,
            delete_zips_progressively: false,
            organize_by_year_month: true
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

function toggleMoveExistingContentOption() {
    editMoveExistingContent = !editMoveExistingContent;
    document.getElementById('lib-edit-move-dot').classList.toggle('hidden', !editMoveExistingContent);
}

async function submitEditLibraryModal() {
    const origName = librariesConfig.active_library;
    if (!origName) return;
    const newName = (document.getElementById('lib-edit-new-name').value || '').trim() || origName;

    const res = await fetch('/api/libraries/update', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            original_name: origName,
            new_name: newName,
            new_source: pendingEditLibFolder,
            move_existing_content: editMoveExistingContent
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
    showMergeStep('merge-step-auto-config');
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
    const res = await fetch('/api/duplicates/auto_resolve', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            mode: autoDupMode,
            priority: autoDupPriority,
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
