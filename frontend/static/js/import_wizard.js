// ==================== LOGIQUE DU NOUVEL ASSISTANT D'IMPORTATION ====================

let wizardSourceType = 'TAKEOUT_ZIPS';
let wizardSelectedPaths = [];
let wizardFixMeta = true;
let wizardDeleteZips = false;

function openImportWizard() {
    showImportStep(1);
    document.getElementById('import-wizard-modal').classList.remove('hidden');
}

function closeImportWizard() {
    document.getElementById('import-wizard-modal').classList.add('hidden');
}

function showImportStep(stepNum) {
    [1, 2, 3].forEach(n => {
        document.getElementById(`import-step-${n}`).classList.toggle('hidden', n !== stepNum);
    });
}

function toggleWizardCheck(which) {
    if (which === 'fix') {
        wizardFixMeta = !wizardFixMeta;
        document.getElementById('wiz-chk-fix').textContent = wizardFixMeta ? '✓' : '';
    } else {
        wizardDeleteZips = !wizardDeleteZips;
        document.getElementById('wiz-chk-del').textContent = wizardDeleteZips ? '✓' : '';
    }
}

async function pickStandardFolderForImport() {
    const res = await fetch('/api/dialog/browse?mode=folder');
    const d = await res.json();
    if (!d.paths || !d.paths.length) return;
    wizardSourceType = 'STANDARD_FOLDER';
    wizardSelectedPaths = d.paths;
    wizardFixMeta = false;
    wizardDeleteZips = false;
    document.getElementById('wiz-chk-fix').textContent = '';
    prepareImportStep3('Importer un dossier', 'Dossier sélectionné', false, 1);
}

async function pickTakeoutSource(type) {
    const browseMode = (type === 'TAKEOUT_ZIPS') ? 'zips' : 'folder';
    const res = await fetch(`/api/dialog/browse?mode=${browseMode}`);
    const d = await res.json();
    if (!d.paths || !d.paths.length) return;

    wizardSourceType = type;
    wizardSelectedPaths = d.paths;
    wizardFixMeta = true;
    wizardDeleteZips = false;
    document.getElementById('wiz-chk-fix').textContent = '✓';
    document.getElementById('wiz-chk-del').textContent = '';

    const sub = (type === 'TAKEOUT_ZIPS') ? 'Fichiers ZIP' : 'Dossier décompressé';
    prepareImportStep3('Importer depuis Google', sub, type === 'TAKEOUT_ZIPS', 2);
}

function prepareImportStep3(headerTitle, subTitle, showZipDelete, backStep) {
    document.getElementById('import-step3-header').textContent = headerTitle;
    document.getElementById('import-step3-subtitle').textContent = subTitle;
    document.getElementById('import-step3-back-btn').onclick = () => showImportStep(backStep);
    document.getElementById('import-step3-paths').innerHTML = wizardSelectedPaths
        .map(p => `<div>${p.replace(/\\/g, '/')}</div>`).join('');
    document.getElementById('row-opt-del-zips').classList.toggle('hidden', !showZipDelete);
    showImportStep(3);
}

function rePickStep3Paths() {
    if (wizardSourceType === 'STANDARD_FOLDER') pickStandardFolderForImport();
    else pickTakeoutSource(wizardSourceType);
}

async function confirmWizardImport() {
    closeImportWizard();
    const res = await fetch('/api/import/quick_add', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            source_type: wizardSourceType,
            paths: wizardSelectedPaths,
            fix_metadata: wizardFixMeta,
            delete_zips: wizardDeleteZips
        })
    });
    if (res.ok) {
        await loadLibrariesDropdown();
        document.getElementById('task-popover').classList.remove('hidden');
    }
}

async function handleDroppedFiles(e) {
    e.preventDefault();
    document.getElementById('drop-zone').classList.remove('ring-2', 'ring-[#593E5A]');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        await uploadFilesToGallery(e.dataTransfer.files);
    }
}

async function handleSelectedFilesInput(fileList) {
    if (fileList && fileList.length) {
        await uploadFilesToGallery(fileList);
    }
}

async function uploadFilesToGallery(fileList) {
    closeImportWizard();
    const fd = new FormData();
    for (const f of fileList) fd.append('files', f);
    const res = await fetch('/api/import/upload_files', { method: 'POST', body: fd });
    if (res.ok) {
        await loadLibrariesDropdown();
        document.getElementById('task-popover').classList.remove('hidden');
    }
}

function toggleTaskMissingMetaSubpanel(e) {
    e.stopPropagation();
    document.getElementById('task-missing-meta-popover').classList.toggle('hidden');
}

async function stopPipelineCompletely() {
    await fetch('/api/pipeline/stop?cancel=true', {method: 'POST'});
    clientPausedTask = '';
    document.getElementById('task-missing-meta-popover').classList.add('hidden');
}

async function retryMissingMetadataFromPopover() {
    const btn = document.getElementById('btn-popover-retry-meta');
    btn.disabled = true;
    btn.textContent = "Réessai...";
    try {
        await fetch('/api/metadata/retry_recovery', {method: 'POST'});
        document.getElementById('task-missing-meta-popover').classList.add('hidden');
        await loadStats();
        refreshActiveMediaView();
    } finally {
        btn.disabled = false;
        btn.textContent = "Réessayer";
    }
}

// ==================== GESTION DES BIBLIOTHÈQUES ====================

async function loadLibrariesDropdown() {
    const res = await fetch('/api/libraries');
    cachedLibrariesData = await res.json();
    const sel = document.getElementById('library-selector');
    const names = Object.keys(cachedLibrariesData.libraries || {});
    const activeName = cachedLibrariesData.active_library || 'Nom de la bibliotheque';
    document.getElementById('lib-name-btn').textContent = activeName;

    if (names.length === 0) {
        sel.innerHTML = '<option value="">Aucune bibliothèque</option>';
        return;
    }
    sel.innerHTML = names.map(n => `<option value="${n}" ${n === activeName ? 'selected' : ''}>${n}</option>`).join('');
}

async function switchLibrary(name) {
    await fetch('/api/libraries/select', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name})});
    await loadLibrariesDropdown();
    loadStats(); loadGalleryFilters(); loadGalleryItems();
}

function openLibraryModal(mode = 'CREATE') {
    libraryModalMode = mode;
    document.getElementById('lib-menu-popover').classList.add('hidden');
    if (mode === 'EDIT') {
        const active = cachedLibrariesData.active_library;
        const lib = (cachedLibrariesData.libraries || {})[active];
        if (!lib) { openLibraryModal('CREATE'); return; }
        document.getElementById('lib-modal-title').textContent = `Modifier « ${active} »`;
        document.getElementById('lib-name').value = lib.name;
        document.getElementById('lib-paths').value = (lib.source_paths || []).join('\n');
        document.getElementById('lib-dest').value = lib.dest_dir || '';
        document.getElementById('lib-source-type-row').classList.add('hidden');
    } else {
        document.getElementById('lib-modal-title').textContent = "Créer une Bibliothèque";
        document.getElementById('lib-name').value = '';
        document.getElementById('lib-paths').value = '';
        document.getElementById('lib-dest').value = '';
        document.getElementById('lib-source-type-row').classList.remove('hidden');
    }
    document.getElementById('library-modal').classList.remove('hidden');
}

function closeLibraryModal() { document.getElementById('library-modal').classList.add('hidden'); }

function toggleSourceTypeUI() {
    const v = document.querySelector('input[name="source_type"]:checked').value;
    document.getElementById('takeout-only-panel').classList.toggle('hidden', v === 'STANDARD_FOLDER');
    document.getElementById('takeout-zip-delete-option').classList.toggle('hidden', v !== 'TAKEOUT_ZIPS');
    document.getElementById('btn-browse-zips').classList.toggle('hidden', v !== 'TAKEOUT_ZIPS');
}

async function browseSource(mode) {
    const res = await fetch(`/api/dialog/browse?mode=${mode}`);
    const d = await res.json();
    if (d.paths && d.paths.length) {
        const ta = document.getElementById('lib-paths');
        ta.value = ta.value.trim() ? ta.value.trim() + '\n' + d.paths.join('\n') : d.paths.join('\n');
    }
}

async function browseDest() {
    const res = await fetch('/api/dialog/browse?mode=folder');
    const d = await res.json();
    if (d.paths && d.paths.length) document.getElementById('lib-dest').value = d.paths[0];
}

async function submitLibraryModal() {
    const st = document.querySelector('input[name="source_type"]:checked').value;
    const url = libraryModalMode === 'EDIT' ? '/api/libraries/update' : '/api/libraries/create';
    const body = libraryModalMode === 'EDIT'
        ? {
            original_name: cachedLibrariesData.active_library,
            new_name: document.getElementById('lib-name').value,
            source_paths_raw: document.getElementById('lib-paths').value,
            dest_dir: document.getElementById('lib-dest').value,
            fix_takeout_json_metadata: document.getElementById('opt-fix-json').checked,
            delete_zips_progressively: document.getElementById('opt-delete-zips').checked
        }
        : {
            name: document.getElementById('lib-name').value,
            source_type: st,
            source_paths_raw: document.getElementById('lib-paths').value,
            dest_dir: document.getElementById('lib-dest').value,
            fix_takeout_json_metadata: st !== 'STANDARD_FOLDER' && document.getElementById('opt-fix-json').checked,
            delete_zips_progressively: st === 'TAKEOUT_ZIPS' && document.getElementById('opt-delete-zips').checked
        };
    const res = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    if (res.ok) {
        closeLibraryModal();
        await loadLibrariesDropdown();
        runTask('INGEST');
    }
}

function openMergeLibrariesModal() {
    document.getElementById('lib-menu-popover').classList.add('hidden');
    const names = Object.keys(cachedLibrariesData.libraries || {});
    if (names.length < 2) { alert("Créez au moins 2 bibliothèques pour les fusionner."); return; }
    const opts = names.map(n => `<option value="${n}">${n}</option>`).join('');
    document.getElementById('merge-src-lib').innerHTML = opts;
    document.getElementById('merge-dst-lib').innerHTML = opts;
    document.getElementById('merge-dst-lib').selectedIndex = 1;
    document.getElementById('merge-lib-modal').classList.remove('hidden');
}

async function confirmMergeLibraries() {
    const s = document.getElementById('merge-src-lib').value;
    const d = document.getElementById('merge-dst-lib').value;
    if (s === d) return;
    const res = await fetch('/api/libraries/merge', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({source_lib_name: s, target_lib_name: d})
    });
    if (res.ok) {
        document.getElementById('merge-lib-modal').classList.add('hidden');
        await loadLibrariesDropdown();
        loadStats(); loadGalleryFilters(); loadGalleryItems();
    }
}

async function runTask(taskCode) {
    clientPausedTask = '';
    const res = await fetch('/api/pipeline/run_task', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({task: taskCode})
    });
    if (!res.ok) { openImportWizard(); return; }
    document.getElementById('task-popover').classList.remove('hidden');
}

let latestPipelineState = { is_running: false, stop_requested: false, active_task: "IDLE", last_paused_task: "" };

async function handlePipeActionButton() {
    if (latestPipelineState.is_running) {
        if (latestPipelineState.active_task && latestPipelineState.active_task !== 'IDLE') {
            clientPausedTask = latestPipelineState.active_task;
        }
        await fetch('/api/pipeline/stop', {method: 'POST'});
        return;
    }
    const taskToResume = latestPipelineState.last_paused_task || clientPausedTask || 'INGEST';
    await runTask(taskToResume);
}
