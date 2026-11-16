// ==================== ASSISTANT D'IMPORTATION EN 3 ÉTAPES (DOSSIERS, SOUS-DOSSIERS & TAKEOUT) ====================

let wizardImportSourceType = 'STANDARD_FOLDER';
let wizardSelectedPaths = [];
let wizardOptFixMeta = true;
let wizardOptDelZips = false;
let wizardOptCreateAlbum = true;
let wizardTakeoutArchitecture = 'KEEP_ORIGINAL'; // 'KEEP_ORIGINAL' | 'GOOGLE_ALBUM' | 'NONE'
let wizardSubfolderMode = 'SINGLE'; // 'SINGLE' | 'ALL_SUBS' | 'CUSTOM_SUBS'
let wizardDetectedSubfolders = [];

const TAKEOUT_ARCH_DESCRIPTIONS = {
    KEEP_ORIGINAL: 'Par défaut : garde les albums, favoris et la corbeille directement dans la bibliothèque.',
    GOOGLE_ALBUM: 'Crée l\'album « Google Photos » avec : sous-albums par année, Favoris, Corbeille et un sous-album « Albums » contenant vos albums.',
    NONE: 'Importe tous les médias directement dans la galerie sans créer d\'album, favori ni corbeille.'
};

function openImportWizard() {
    if (typeof hideAllTopPopovers === 'function') hideAllTopPopovers();
    const cfg = window.appSettings || {};
    wizardSelectedPaths = [];
    wizardDetectedSubfolders = [];
    wizardOptFixMeta = (cfg.takeout_default_fix_metadata !== false);
    wizardOptDelZips = Boolean(cfg.takeout_default_delete_zips);
    wizardOptCreateAlbum = true;
    const defArch = String(cfg.takeout_default_architecture || 'KEEP_ORIGINAL').toUpperCase();
    wizardTakeoutArchitecture = ['KEEP_ORIGINAL', 'GOOGLE_ALBUM', 'NONE'].includes(defArch) ? defArch : 'KEEP_ORIGINAL';
    wizardSubfolderMode = 'SINGLE';
    updateWizardCheckDOM();
    showImportStep(1);
    const modal = document.getElementById('import-wizard-modal');
    if (modal) modal.classList.remove('hidden');
}

const openImportModal = openImportWizard;
const startImportFlow = openImportWizard;

function closeImportWizard() {
    const modal = document.getElementById('import-wizard-modal');
    if (modal) modal.classList.add('hidden');
}

const closeImportModal = closeImportWizard;

function showImportStep(stepNum) {
    [1, 2, 3].forEach(n => {
        const el = document.getElementById(`import-step-${n}`);
        if (el) el.classList.toggle('hidden', n !== stepNum);
    });
}

function _syncWizardCheckPill(el, checked) {
    if (!el) return;
    el.textContent = checked ? '✓' : '';
    el.classList.toggle('plum-btn', !!checked);
    el.classList.toggle('border-[1.6px]', !checked);
    el.classList.toggle('border-current/50', !checked);
}

function setTakeoutArchitecture(arch) {
    const valid = ['KEEP_ORIGINAL', 'GOOGLE_ALBUM', 'NONE'];
    wizardTakeoutArchitecture = valid.includes(arch) ? arch : 'KEEP_ORIGINAL';
    updateWizardCheckDOM();
}

function updateWizardCheckDOM() {
    const chkFix = document.getElementById('wiz-chk-fix');
    const chkDel = document.getElementById('wiz-chk-del');
    const chkAlb = document.getElementById('wiz-chk-album');
    const archSelect = document.getElementById('wiz-takeout-arch-select');
    const archDesc = document.getElementById('wiz-takeout-arch-desc');
    const cfgPanel = document.getElementById('wiz-album-config-panel');

    _syncWizardCheckPill(chkFix, wizardOptFixMeta);
    _syncWizardCheckPill(chkDel, wizardOptDelZips);
    _syncWizardCheckPill(chkAlb, wizardOptCreateAlbum);
    if (archSelect) archSelect.value = wizardTakeoutArchitecture;
    if (archDesc) {
        archDesc.textContent = TAKEOUT_ARCH_DESCRIPTIONS[wizardTakeoutArchitecture] || TAKEOUT_ARCH_DESCRIPTIONS.KEEP_ORIGINAL;
    }
    if (cfgPanel) cfgPanel.classList.toggle('hidden', !wizardOptCreateAlbum);

    const rSingle = document.getElementById('wiz-rad-single');
    const rAll = document.getElementById('wiz-rad-allsubs');
    const rCustom = document.getElementById('wiz-rad-custom');
    if (rSingle) rSingle.textContent = (wizardSubfolderMode === 'SINGLE') ? '✓' : '';
    if (rAll) rAll.textContent = (wizardSubfolderMode === 'ALL_SUBS') ? '✓' : '';
    if (rCustom) rCustom.textContent = (wizardSubfolderMode === 'CUSTOM_SUBS') ? '✓' : '';

    const singleBox = document.getElementById('wiz-single-album-box');
    const customBox = document.getElementById('wiz-custom-subfolders-box');
    if (singleBox) singleBox.classList.toggle('hidden', wizardSubfolderMode !== 'SINGLE');
    if (customBox) customBox.classList.toggle('hidden', wizardSubfolderMode !== 'CUSTOM_SUBS');
}

function toggleWizardCheck(which) {
    if (which === 'fix') wizardOptFixMeta = !wizardOptFixMeta;
    if (which === 'del') wizardOptDelZips = !wizardOptDelZips;
    if (which === 'album') wizardOptCreateAlbum = !wizardOptCreateAlbum;
    updateWizardCheckDOM();
}

function setWizardSubfolderMode(mode) {
    wizardSubfolderMode = mode;
    updateWizardCheckDOM();
}

function renderCustomSubfoldersList() {
    const listEl = document.getElementById('wiz-subfolders-list');
    if (!listEl) return;

    listEl.innerHTML = wizardDetectedSubfolders.map((sf, idx) => `
        <div class="ui-pill rounded-2xl px-3 py-1.5 flex items-center justify-between gap-2 text-[11px]">
            <label class="flex items-center gap-2 min-w-0 flex-1 cursor-pointer font-bold">
                <input type="checkbox" ${sf.include ? 'checked' : ''}
                       onchange="wizardDetectedSubfolders[${idx}].include = this.checked"
                       class="w-3.5 h-3.5 accent-[var(--accent)] shrink-0"/>
                <span class="truncate" title="${sf.display_name}">${sf.display_name}</span>
                <span class="opacity-50 text-[10px] shrink-0">(${sf.media_count})</span>
            </label>
            <div class="flex items-center gap-1.5 shrink-0">
                <label class="flex items-center gap-1 text-[10px] opacity-80 cursor-pointer" title="Créer un album pour ce sous-dossier">
                    <input type="checkbox" ${sf.create_album ? 'checked' : ''}
                           onchange="wizardDetectedSubfolders[${idx}].create_album = this.checked; document.getElementById('wiz-sf-alb-${idx}').disabled = !this.checked;"
                           class="w-3 h-3 accent-[var(--accent)]"/>
                    <span>Album:</span>
                </label>
                <input id="wiz-sf-alb-${idx}" type="text" value="${(sf.album_name || '').replace(/"/g, '&quot;')}"
                       oninput="wizardDetectedSubfolders[${idx}].album_name = this.value"
                       class="ui-card rounded-full px-2.5 py-0.5 text-[10px] font-bold w-28 outline-none"/>
            </div>
        </div>
    `).join('');
}

function toggleAllCustomSubfolders() {
    const allChecked = wizardDetectedSubfolders.every(s => s.include);
    wizardDetectedSubfolders.forEach(s => { s.include = !allChecked; });
    renderCustomSubfoldersList();
}

async function _refreshStandardSubfolders(paths) {
    if (!paths || !paths.length) {
        wizardDetectedSubfolders = [];
        document.getElementById('wiz-subfolder-modes')?.classList.add('hidden');
        wizardSubfolderMode = 'SINGLE';
        updateWizardCheckDOM();
        return;
    }

    let subData = {has_subfolders: false, folders: []};
    try {
        const subRes = await fetch('/api/import/inspect_subfolders', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({source_paths: paths})
        });
        if (subRes.ok) subData = await subRes.json();
    } catch (e) {}

    wizardDetectedSubfolders = (subData.folders || []).map(f => ({
        folder_path: f.folder_path,
        display_name: f.display_name,
        media_count: f.media_count,
        include: true,
        create_album: true,
        album_name: f.suggested_album
    }));

    const modesBox = document.getElementById('wiz-subfolder-modes');
    if (subData.has_subfolders && wizardDetectedSubfolders.length > 1) {
        if (modesBox) modesBox.classList.remove('hidden');
        wizardSubfolderMode = 'ALL_SUBS';
        renderCustomSubfoldersList();
    } else {
        if (modesBox) modesBox.classList.add('hidden');
        wizardSubfolderMode = 'SINGLE';
    }
    updateWizardCheckDOM();
}

async function pickStandardFolderForImport() {
    const res = await fetch('/api/dialog/browse?mode=folder');
    if (!res.ok) return;
    const d = await res.json();
    if (!d.paths || !d.paths.length) return;

    wizardImportSourceType = 'STANDARD_FOLDER';
    wizardSelectedPaths = d.paths.slice();
    wizardOptCreateAlbum = true;

    const folderName = d.paths[0].split(/[\\/]/).filter(Boolean).pop() || 'Nouvel Album';
    const albInput = document.getElementById('wiz-album-name-input');
    if (albInput) albInput.value = folderName;

    await _refreshStandardSubfolders(wizardSelectedPaths);
    prepareImportStep3('Importer un dossier', 'Dossiers sélectionnés', false);
}

function pickTakeoutSource(sourceType) {
    wizardImportSourceType = sourceType;
    wizardSelectedPaths = [];
    wizardOptCreateAlbum = false;
    wizardSubfolderMode = 'SINGLE';

    const modesBox = document.getElementById('wiz-subfolder-modes');
    if (modesBox) modesBox.classList.add('hidden');

    const albInput = document.getElementById('wiz-album-name-input');
    if (albInput) albInput.value = '';

    const subTitle = (sourceType === 'TAKEOUT_ZIPS') ? 'Archives ZIP sélectionnées' : 'Dossiers décompressés';
    prepareImportStep3('Google Takeout', subTitle, true);
}

function renderStep3PathsList() {
    const listEl = document.getElementById('import-step3-paths');
    const countEl = document.getElementById('import-step3-count');
    if (countEl) countEl.textContent = String(wizardSelectedPaths.length);
    if (!listEl) return;

    listEl.innerHTML = '';
    if (!wizardSelectedPaths.length) {
        const empty = document.createElement('div');
        empty.className = 'ui-pill rounded-xl px-3 py-2 text-[11px] font-semibold opacity-60 text-center';
        empty.textContent = wizardImportSourceType === 'TAKEOUT_ZIPS'
            ? 'Aucune archive ZIP sélectionnée.'
            : 'Aucun dossier sélectionné.';
        listEl.appendChild(empty);
        return;
    }

    wizardSelectedPaths.forEach((rawPath, idx) => {
        const displayPath = rawPath.replace(/\\/g, '/');
        const row = document.createElement('div');
        row.className = 'ui-pill rounded-xl px-3 py-1.5 flex items-center justify-between gap-2 text-[11px] font-bold';

        const txt = document.createElement('span');
        txt.className = 'truncate min-w-0 flex-1';
        txt.title = displayPath;
        txt.textContent = displayPath;

        const remBtn = document.createElement('button');
        remBtn.type = 'button';
        remBtn.title = 'Retirer';
        remBtn.className = 'w-5 h-5 rounded-full hover:bg-rose-500/20 hover:text-rose-400 flex items-center justify-center text-[10px] shrink-0 transition cursor-pointer';
        remBtn.textContent = '✕';
        remBtn.onclick = () => removeStep3Path(idx);

        row.appendChild(txt);
        row.appendChild(remBtn);
        listEl.appendChild(row);
    });
}

async function addMoreStep3Paths() {
    const browseMode = (wizardImportSourceType === 'TAKEOUT_ZIPS') ? 'zips' : 'folder';
    const res = await fetch(`/api/dialog/browse?mode=${browseMode}`);
    if (!res.ok) return;
    const d = await res.json();
    if (!d.paths || !d.paths.length) return;

    const existingKeys = new Set(wizardSelectedPaths.map(p => p.trim().replace(/[\\/]+$/, '').toLowerCase()));
    d.paths.forEach(p => {
        const clean = String(p || '').trim();
        const key = clean.replace(/[\\/]+$/, '').toLowerCase();
        if (clean && !existingKeys.has(key)) {
            existingKeys.add(key);
            wizardSelectedPaths.push(clean);
        }
    });

    if (wizardImportSourceType === 'STANDARD_FOLDER') {
        await _refreshStandardSubfolders(wizardSelectedPaths);
    }
    renderStep3PathsList();
}

async function removeStep3Path(idx) {
    if (idx < 0 || idx >= wizardSelectedPaths.length) return;
    wizardSelectedPaths.splice(idx, 1);
    if (wizardImportSourceType === 'STANDARD_FOLDER') {
        await _refreshStandardSubfolders(wizardSelectedPaths);
    }
    renderStep3PathsList();
}

function prepareImportStep3(headerText, subtitleText, isGoogle) {
    const hEl = document.getElementById('import-step3-header');
    const sEl = document.getElementById('import-step3-subtitle');
    const addLbl = document.getElementById('import-step3-add-label');
    const backBtn = document.getElementById('import-step3-back-btn');
    const rowAlb = document.getElementById('row-opt-create-album');
    const rowTakeoutArch = document.getElementById('row-opt-takeout-architecture');
    const rowFix = document.getElementById('row-opt-fix-meta');
    const rowDel = document.getElementById('row-opt-del-zips');

    if (hEl) hEl.textContent = headerText;
    if (sEl) sEl.textContent = subtitleText;
    if (addLbl) {
        addLbl.textContent = (wizardImportSourceType === 'TAKEOUT_ZIPS') ? 'Ajouter des ZIP' : 'Ajouter un dossier';
    }
    renderStep3PathsList();
    if (backBtn) {
        backBtn.setAttribute('onclick', `showImportStep(${isGoogle ? 2 : 1})`);
    }
    const isStandard = (wizardImportSourceType === 'STANDARD_FOLDER');
    if (rowAlb) {
        rowAlb.classList.toggle('hidden', !isStandard);
    }
    if (rowTakeoutArch) {
        rowTakeoutArch.classList.toggle('hidden', isStandard);
    }
    if (rowFix) {
        rowFix.classList.toggle('hidden', isStandard);
    }
    if (rowDel) {
        rowDel.classList.toggle('hidden', wizardImportSourceType !== 'TAKEOUT_ZIPS');
    }

    updateWizardCheckDOM();
    showImportStep(3);
}

function rePickStep3Paths() {
    addMoreStep3Paths();
}

async function handleDroppedFiles(event) {
    event.preventDefault();
    const dz = document.getElementById('drop-zone');
    if (dz) dz.classList.remove('ring-2', 'ring-current');
    if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length) {
        await handleSelectedFilesInput(event.dataTransfer.files);
    }
}

async function handleSelectedFilesInput(fileList) {
    if (!fileList || !fileList.length) return;
    const formData = new FormData();
    for (let i = 0; i < fileList.length; i++) {
        formData.append('files', fileList[i]);
    }
    closeImportWizard();
    const res = await fetch('/api/import/upload_files', {
        method: 'POST',
        body: formData
    });
    if (res.ok) {
        await loadStats();
        await loadGalleryFilters();
        refreshActiveMediaView();
    }
}

async function confirmWizardImport() {
    if (!wizardSelectedPaths.length) {
        alert("Veuillez conserver ou ajouter au moins une source à importer.");
        return;
    }
    const customAlbumName = (document.getElementById('wiz-album-name-input')?.value || '').trim();
    closeImportWizard();

    const takeoutKeepStruct = (wizardTakeoutArchitecture !== 'NONE');
    const takeoutWrapGoogle = (wizardTakeoutArchitecture === 'GOOGLE_ALBUM');
    const fixTakeoutMeta = (wizardImportSourceType !== 'STANDARD_FOLDER') && Boolean(wizardOptFixMeta);

    // 1. Si aucune bibliothèque n'existe, en créer une automatiquement
    const active = librariesConfig?.active_library;
    if (!active || !librariesConfig.libraries || !librariesConfig.libraries[active]) {
        const firstPath = wizardSelectedPaths[0];
        const folderName = firstPath.split(/[\\/]/).filter(Boolean).pop()?.replace(/\.zip$/i, '') || 'Ma Bibliothèque';
        const autoDest = /\.zip$/i.test(firstPath) ? (firstPath.replace(/[\\/][^\\/]+$/, '') || firstPath) : firstPath;
        await fetch('/api/libraries/create', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                name: folderName,
                source_type: wizardImportSourceType,
                source_paths_raw: wizardImportSourceType === 'STANDARD_FOLDER' ? '' : wizardSelectedPaths.join('\n'),
                dest_dir: autoDest,
                fix_takeout_json_metadata: fixTakeoutMeta,
                delete_zips_progressively: wizardOptDelZips,
                takeout_architecture: wizardTakeoutArchitecture,
                takeout_keep_structure: takeoutKeepStruct,
                takeout_wrap_google_album: takeoutWrapGoogle,
                organize_by_year_month: true
            })
        });
        await loadLibrariesDropdown();
    }

    // 2. Appeler /api/import/add_sources pour importer les fichiers avec les règles d'albums choisies
    const res = await fetch('/api/import/add_sources', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            source_type: wizardImportSourceType,
            source_paths: wizardSelectedPaths,
            fix_takeout_json_metadata: fixTakeoutMeta,
            delete_zips_progressively: Boolean(wizardOptDelZips),
            takeout_architecture: wizardTakeoutArchitecture,
            takeout_keep_structure: takeoutKeepStruct,
            takeout_wrap_google_album: takeoutWrapGoogle,
            create_album: Boolean(wizardOptCreateAlbum),
            album_mode: wizardOptCreateAlbum ? wizardSubfolderMode : 'NONE',
            album_name: customAlbumName,
            subfolder_rules: wizardDetectedSubfolders.map(sf => ({
                folder_path: sf.folder_path,
                include: Boolean(sf.include),
                create_album: Boolean(wizardOptCreateAlbum && sf.create_album),
                album_name: sf.album_name || ''
            }))
        })
    });

    if (!res.ok) {
        try {
            const err = await res.json();
            alert("Erreur lors de l'importation : " + (err.detail || res.statusText));
        } catch (e) {
            alert("Erreur serveur (500) lors de l'importation. Vérifiez la console Python.");
        }
        return;
    }

    await loadStats();
    await loadGalleryFilters();
    refreshActiveMediaView();
    if (currentTab === 'albums' && typeof loadAlbumsView === 'function') loadAlbumsView();

    // 3. Ne lancer le pipeline Takeout en arrière-plan QUE pour les imports Google Takeout
    if (wizardImportSourceType !== 'STANDARD_FOLDER') {
        await runTask('INGEST');
    }
}