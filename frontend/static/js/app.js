let currentTab = 'gallery';
let currentExtFilter = '';
let galleryViewMode = 'GRID';
let cachedLibrariesData = {active_library: null, libraries: {}};
let librariesConfig = cachedLibrariesData;
let libraryModalMode = 'CREATE';
let currentLightboxIndex = -1;
let clientPausedTask = '';
let lastSeenActiveTask = '';
let latestPipelineState = {};
let currentGpuMode = 'cuda';
let checkedDuplicatePaths = new Set();

let openedAlbumName = null;
let singleAlbumPage = 1;
let singleAlbumTotalPages = 1;

let pendingCreateLibFolder = '';
let pendingEditLibFolder = '';
let editMoveExistingContent = false;
let autoDupMode = 'KEEP_ONE';
let autoDupPriority = 'BEST_QUALITY';

// ==================== THÈME (CLAIR / SOMBRE / SYSTÈME) & BARRE MINIMISÉE ====================

function setAppTheme(mode) {
    localStorage.setItem('phototo_theme', mode);
    let effective = mode;
    if (mode === 'system') {
        effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', effective);
    ['light', 'dark', 'system'].forEach(m => {
        const b = document.getElementById(`theme-btn-${m}`);
        if (b) b.classList.toggle('nav-item-active', m === mode);
    });
}

function toggleSidebarMini() {
    const sb = document.getElementById('main-sidebar');
    if (!sb) return;
    sb.classList.toggle('sidebar-mini');
    const isMini = sb.classList.contains('sidebar-mini');

    const lbl = document.getElementById('import-btn-label');
    const btn = document.getElementById('btn-top-import');
    const logoBox = document.getElementById('topbar-logo-box');
    const logoTxt = document.getElementById('topbar-logo-text');

    if (isMini) {
        if (lbl) lbl.classList.add('hidden');
        if (btn) btn.classList.replace('px-5', 'px-3');
        if (logoTxt) logoTxt.classList.add('hidden');
        if (logoBox) {
            logoBox.classList.replace('w-48', 'w-14');
            logoBox.classList.add('justify-center');
        }
    } else {
        if (lbl) lbl.classList.remove('hidden');
        if (btn) btn.classList.replace('px-3', 'px-5');
        if (logoTxt) logoTxt.classList.remove('hidden');
        if (logoBox) {
            logoBox.classList.replace('w-14', 'w-48');
            logoBox.classList.remove('justify-center');
        }
    }
}

function selectGpuPill(mode) {
    currentGpuMode = mode;
    ['cuda', 'directml', 'cpu'].forEach(g => {
        const b = document.getElementById(`gpu-btn-${g}`);
        if (b) b.classList.toggle('nav-item-active', g === mode);
    });
    saveAppSettingsQuiet();
}

// ==================== FORMATAGE DATES & DURÉES VIDÉO ====================

function formatDate(ts) {
    if (!ts || ts === 0) return 'Date inconnue';
    return new Date(ts * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatDuration(sec) {
    if (!sec || sec <= 0) return 'Vidéo';
    const s = Math.max(1, Math.round(sec));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${String(rem).padStart(2, '0')}`;
}

function formatMonthGroupTitle(ts) {
    if (!ts || ts === 0) return 'Date inconnue';
    const s = new Date(ts * 1000).toLocaleString('fr-FR', { month: 'long', year: 'numeric' });
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatDayGroupTitle(ts) {
    if (!ts || ts === 0) return 'Date inconnue';
    const s = new Date(ts * 1000).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function isVideoFile(path) {
    return /\.(mp4|mov|avi|mkv|3gp|m4v|webm)$/i.test(path || '');
}

function renderMediaPreview(destPath, css = "w-full h-40 object-cover rounded-2xl") {
    const url = `/thumb?path=${encodeURIComponent(destPath)}`;
    if (isVideoFile(destPath)) {
        return `
        <div class="relative w-full h-full">
            <img src="${url}" loading="lazy" decoding="async" class="${css}"/>
            <span class="absolute bottom-2 right-2 bg-black/60 backdrop-blur-sm text-white text-[10px] font-extrabold px-2 py-0.5 rounded-full flex items-center gap-1 pointer-events-none">
                <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </span>
        </div>`;
    }
    return `<img src="${url}" loading="lazy" decoding="async" class="${css}"/>`;
}

function updateGalleryMonthDropdown() {
    const sel = document.getElementById('gal-month');
    if (!sel) return;
    const cur = sel.value;
    const mNames = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];
    sel.innerHTML = `<option value="">Mois</option>` + mNames.map((n, i) => `<option value="${String(i+1).padStart(2,'0')}">${n}</option>`).join('');
    sel.value = cur;
}

function toggleFilterBar() {
    const drawer = document.getElementById('filter-drawer');
    if (!drawer) return;
    drawer.classList.toggle('hidden');
    const chev = document.getElementById('filter-chevron-icon');
    if (chev) chev.classList.toggle('rotate-180', !drawer.classList.contains('hidden'));
}

function hideAllTopPopovers() {
    ['lib-menu-popover', 'library-dropdown-menu', 'task-popover', 'notif-popover'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
}

function toggleLibMenuPopover(e) {
    if (e) e.stopPropagation();
    const taskPop = document.getElementById('task-popover');
    const notifPop = document.getElementById('notif-popover');
    if (taskPop) taskPop.classList.add('hidden');
    if (notifPop) notifPop.classList.add('hidden');
    const libPop = document.getElementById('lib-menu-popover') || document.getElementById('library-dropdown-menu');
    if (libPop) libPop.classList.toggle('hidden');
}

function toggleTaskPopover(e) {
    if (e) e.stopPropagation();
    const libPop = document.getElementById('lib-menu-popover') || document.getElementById('library-dropdown-menu');
    const notifPop = document.getElementById('notif-popover');
    if (libPop) libPop.classList.add('hidden');
    if (notifPop) notifPop.classList.add('hidden');
    const taskPop = document.getElementById('task-popover');
    if (taskPop) taskPop.classList.toggle('hidden');
}

window.addEventListener('click', e => {
    const libPop = document.getElementById('lib-menu-popover');
    const taskPop = document.getElementById('task-popover');
    const notifPop = document.getElementById('notif-popover');
    if (libPop && !libPop.contains(e.target)) libPop.classList.add('hidden');
    if (taskPop && !taskPop.contains(e.target)) taskPop.classList.add('hidden');
    if (notifPop && !notifPop.contains(e.target)) notifPop.classList.add('hidden');
});

// ==================== NAVIGATION PRINCIPALE ====================

const ALL_TABS = ['gallery', 'albums', 'favorites', 'faces', 'map', 'types', 'tools', 'dups', 'similar', 'trash', 'activities', 'settings'];

function switchTab(tab) {
    currentTab = tab;
    ALL_TABS.forEach(t => {
        const btn = document.getElementById(`tab-btn-${t}`);
        if (btn) btn.classList.toggle('nav-item-active', t === tab);
        const panel = document.getElementById(`tab-${t}`);
        if (panel) panel.classList.toggle('hidden', t !== tab);
    });

    const tlBox = document.getElementById('gallery-timeline-box') || document.getElementById('timeline-scrubber');
    if (tlBox) tlBox.classList.toggle('hidden', tab !== 'gallery' && tab !== 'favorites');

    const titleEl = document.getElementById('gallery-main-title') || document.getElementById('gallery-main-heading');

    if (tab === 'favorites') {
        document.getElementById('tab-gallery').classList.remove('hidden');
        if (titleEl) titleEl.textContent = 'Favoris';
        document.getElementById('gal-fav').checked = true;
        currentExtFilter = '';
        resetAndLoadGallery();
    } else if (tab === 'gallery') {
        if (titleEl) titleEl.textContent = 'Galerie';
        document.getElementById('gal-fav').checked = false;
        currentExtFilter = '';
        resetAndLoadGallery();
    } else if (tab === 'albums') {
        closeSingleAlbumView();
    } else if (tab === 'faces') {
        loadPersons();
    } else if (tab === 'map') {
        loadWorldMap(false);
    } else if (tab === 'types') {
        loadTypesSummary();
    } else if (tab === 'dups') {
        loadDuplicates();
    } else if (tab === 'similar') {
        loadSimilarGroups();
    } else if (tab === 'trash') {
        loadTrashTab();
    } else if (tab === 'settings') {
        loadAppSettings();
    }
}

function setGalleryViewMode(mode) {
    galleryViewMode = mode;
    ['GRID', 'MONTH', 'DAY', 'MASONRY'].forEach(m => {
        const b = document.getElementById(`view-btn-${m}`);
        if (b) {
            b.className = (m === mode)
                ? "px-2.5 py-1 rounded-lg bg-[#593E5A] text-white"
                : "px-2.5 py-1 rounded-lg";
        }
    });
    refreshActiveMediaView();
}

function refreshActiveMediaView() {
    if (currentTab === 'albums' && openedAlbumName) {
        singleAlbumPage = 1;
        loadSingleAlbumItems();
    } else {
        resetAndLoadGallery();
    }
}

async function runGlobalSearch() {
    const q = document.getElementById('global-search-input').value.trim();
    if (!q) return;
    switchTab('tools');
    document.getElementById('global-search-results-panel').classList.remove('hidden');
    const res = await fetch(`/api/semantic/search?q=${encodeURIComponent(q)}`);
    const d = await res.json();
    document.getElementById('semantic-results-grid').innerHTML = (d.results||[]).map(r => {
        const sEnc = encodeURIComponent(r.source_path || r.dest_path);
        const dEnc = encodeURIComponent(r.dest_path);
        return `
        <div onclick="openLightboxForCustomItem('${sEnc}', '${dEnc}', ${r.timestamp || 0})" class="ui-card rounded-2xl p-2 cursor-pointer">
            ${renderMediaPreview(r.dest_path, "w-full aspect-square object-cover rounded-xl mb-1")}
            <div class="flex justify-between text-[11px] font-bold px-1"><span>${formatDate(r.timestamp)}</span><span>${r.similarity}%</span></div>
        </div>`;
    }).join('');
}

// ==================== CONTRÔLES DU PIPELINE IA (LANCER, PAUSE, REPRISE, STOP, LOGS) ====================

async function runTask(taskCode) {
    clientPausedTask = '';
    const res = await fetch('/api/pipeline/run_task', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({task: taskCode})
    });
    if (!res.ok) {
        try {
            const err = await res.json();
            alert(err.detail || "Impossible de démarrer la tâche.");
        } catch (e) {}
    }
}

async function handlePipeActionButton() {
    if (latestPipelineState && latestPipelineState.is_running) {
        clientPausedTask = latestPipelineState.active_task || lastSeenActiveTask || 'INGEST';
        await fetch('/api/pipeline/stop?cancel=false', {method: 'POST'});
    } else {
        const resumeCode = (latestPipelineState && latestPipelineState.last_paused_task) || clientPausedTask || lastSeenActiveTask || 'INGEST';
        await runTask(resumeCode);
    }
}

const togglePauseResumeTask = handlePipeActionButton;

async function stopPipelineCompletely() {
    clientPausedTask = '';
    await fetch('/api/pipeline/stop?cancel=true', {method: 'POST'});
}

const stopTaskCompletely = stopPipelineCompletely;

function toggleTaskMissingMetaSubpanel(e) {
    if (e) e.stopPropagation();
    const sub = document.getElementById('task-missing-meta-popover');
    if (sub) sub.classList.toggle('hidden');
}

async function retryMissingMetadataFromPopover() {
    const btn = document.getElementById('btn-popover-retry-meta');
    if (btn) {
        btn.disabled = true;
        btn.textContent = "Récupération...";
    }
    try {
        await fetch('/api/metadata/retry_recovery', {method: 'POST'});
        await loadStats();
        await loadGalleryFilters();
        refreshActiveMediaView();
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = "Réessayer";
        }
    }
}

// ==================== STATISTIQUES & COUVERTURE ====================

async function loadStats() {
    const res = await fetch('/api/stats');
    if (!res.ok) return;
    const d = await res.json();
    const stInd = document.getElementById('st-indexed');
    if (stInd) stInd.textContent = d.indexed || 0;
    const gbEl = document.getElementById('st-gb');
    if (gbEl && d.total_gb !== undefined) gbEl.textContent = String(d.total_gb).replace('.', ',');

    const stDups = document.getElementById('st-dups');
    if (stDups) stDups.textContent = d.duplicates || 0;
    const dupsBan = document.getElementById('dups-count-banner');
    if (dupsBan) dupsBan.textContent = d.duplicates || 0;

    const simCount = d.similar_count !== undefined ? d.similar_count : 0;
    const stSims = document.getElementById('st-sims');
    if (stSims) stSims.textContent = simCount;
    const simsBan = document.getElementById('sims-count-banner');
    if (simsBan) simsBan.textContent = simCount;

    const mm = document.getElementById('st-missing-meta');
    if (mm && d.missing_meta !== undefined) mm.textContent = d.missing_meta;

    if (d.coverage) {
        const ded = d.coverage.dedup;
        if (ded && document.getElementById('cov-bar-dedup')) {
            document.getElementById('cov-bar-dedup').style.width = `${ded.percent}%`;
            document.getElementById('cov-pct-dedup').textContent = `${ded.percent} %`;
            document.getElementById('cov-label-dedup').innerHTML = `${ded.done} / ${ded.total}<br><span class="font-semibold opacity-75">fichiers analysés</span>`;
        }
        const sim = d.coverage.similar;
        if (sim && document.getElementById('cov-bar-similar')) {
            document.getElementById('cov-bar-similar').style.width = `${sim.percent}%`;
            document.getElementById('cov-pct-similar').textContent = `${sim.percent} %`;
            document.getElementById('cov-label-similar').innerHTML = `${sim.done} / ${sim.total}<br><span class="font-semibold opacity-75">fichiers analysés</span>`;
        }
    }
}

async function toggleNotificationsPopover(e) {
    if (e) e.stopPropagation();
    const libPop = document.getElementById('lib-menu-popover');
    const taskPop = document.getElementById('task-popover');
    if (libPop) libPop.classList.add('hidden');
    if (taskPop) taskPop.classList.add('hidden');
    const pop = document.getElementById('notif-popover');
    if (!pop) return;
    pop.classList.toggle('hidden');
    if (!pop.classList.contains('hidden')) {
        await fetch('/api/notifications/clear', {method: 'POST'});
        const dot = document.getElementById('notif-unread-dot');
        if (dot) dot.classList.add('hidden');
    }
}

function renderNotificationsLists(notifs) {
    if (!notifs || !notifs.length) return;
    const unread = notifs.some(n => !n.read);
    const dot = document.getElementById('notif-unread-dot');
    if (dot) dot.classList.toggle('hidden', !unread);

    const html = notifs.map(n => {
        const badge = n.status === 'success' ? '✅' : (n.status === 'error' ? '❌' : '⏸️');
        return `
        <div class="ui-pill rounded-2xl p-3 flex items-start justify-between gap-2">
            <div>
                <div class="font-extrabold text-xs">${badge} ${n.title}</div>
                <div class="text-[11px] opacity-70 mt-0.5">${n.detail}</div>
            </div>
            <span class="text-[10px] font-mono opacity-60 shrink-0">${n.time}</span>
        </div>`;
    }).join('');

    const popList = document.getElementById('notif-popover-list');
    if (popList) popList.innerHTML = html;
    const fullList = document.getElementById('activities-full-list');
    if (fullList) fullList.innerHTML = html;
}

// ==================== PARAMÈTRES & MAINTENANCE ====================

async function loadAppSettings() {
    const res = await fetch('/api/settings');
    if (!res.ok) return;
    const d = await res.json();
    document.getElementById('settings-scanned-folders').value = (d.scanned_folders||[]).join('\n');
    document.getElementById('settings-takeout-dir').value = d.takeout_extract_dir || '';
    document.getElementById('settings-timezone').value = d.timezone || 'Europe/Paris';
    document.getElementById('settings-lang').value = d.language || 'fr';
    currentGpuMode = d.gpu_mode || 'cuda';
    ['cuda', 'directml', 'cpu'].forEach(g => {
        const b = document.getElementById(`gpu-btn-${g}`);
        if (b) b.classList.toggle('nav-item-active', g === currentGpuMode);
    });
}

async function saveAppSettingsQuiet() {
    await fetch('/api/settings/save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
            scanned_folders: document.getElementById('settings-scanned-folders').value.split('\n'),
            takeout_extract_dir: document.getElementById('settings-takeout-dir').value,
            timezone: document.getElementById('settings-timezone').value,
            language: document.getElementById('settings-lang').value || 'fr',
            gpu_mode: currentGpuMode
        })
    });
}

async function backupDatabaseNow() {
    const res = await fetch('/api/database/backup', {method: 'POST'});
    const msgBox = document.getElementById('backup-result-msg');
    if (res.ok) {
        const d = await res.json();
        msgBox.textContent = `✓ Sauvegarde créée (${d.size_mb} Mo) : ${d.backup_path}`;
        msgBox.classList.remove('hidden');
    }
}

async function pruneMissingFiles() {
    const res = await fetch('/api/database/prune_missing', {method: 'POST'});
    if (res.ok) {
        const d = await res.json();
        await loadStats(); await loadGalleryFilters(); refreshActiveMediaView();
        alert(`Nettoyage terminé : ${d.removed_count} entrée(s) obsolète(s) supprimée(s).`);
    }
}

async function retryMissingMetadataNow() {
    const btn = document.getElementById('btn-retry-meta');
    btn.disabled = true;
    btn.textContent = "Récupération en cours...";
    try {
        const res = await fetch('/api/metadata/retry_recovery', {method: 'POST'});
        const d = await res.json();
        await loadStats(); await loadGalleryFilters(); refreshActiveMediaView();
        alert(`Récupération terminée : ${d.repaired} fichier(s) reclassé(s), ${d.still_missing} restant(s).`);
    } finally {
        btn.disabled = false;
        btn.textContent = "Réparer les dates";
    }
}

async function restartApplication() {
    if (!confirm("Redémarrer Phototo maintenant ?")) return;
    await fetch('/api/system/restart', {method: 'POST'});
    setTimeout(() => window.location.reload(), 2000);
}

async function shutdownApplication() {
    if (!confirm("Arrêter complètement Phototo ?")) return;
    await fetch('/api/system/shutdown', {method: 'POST'});
    document.body.innerHTML = `<div class="h-screen flex items-center justify-center text-xl font-extrabold">🛑 Phototo est arrêté.</div>`;
}

// ==================== BOUCLE DE STATUT EN DIRECT ====================

let wasPipelineRunning = false;
let pipelineRefreshTicks = 0;

setInterval(async () => {
    try {
        const res = await fetch('/api/pipeline/status');
        if (!res.ok) return;
        const st = await res.json();
        if (st.notifications) renderNotificationsLists(st.notifications);
        latestPipelineState = st;

        if (st.is_running && st.active_task && st.active_task !== 'IDLE') {
            lastSeenActiveTask = st.active_task;
        }
        if (!st.is_running && st.current_step && st.current_step.includes('En pause') && !clientPausedTask) {
            clientPausedTask = lastSeenActiveTask || 'INGEST';
        }
        const effectivePausedTask = st.last_paused_task || clientPausedTask;
        const hasMissing = (st.missing_meta_files && st.missing_meta_files.length > 0);
        const showActivePanel = st.is_running || Boolean(effectivePausedTask) || hasMissing;

        const pulseBadge = document.getElementById('pulse-badge');
        if (pulseBadge) pulseBadge.classList.toggle('hidden', !st.is_running);
        const emptySt = document.getElementById('task-empty-state');
        if (emptySt) emptySt.classList.toggle('hidden', showActivePanel);
        const activeSt = document.getElementById('task-active-state');
        if (activeSt) activeSt.classList.toggle('hidden', !showActivePanel);

        if (showActivePanel) {
            document.getElementById('pop-step-title').textContent = st.current_step || 'Analyse en cours...';
            document.getElementById('pipe-bar').style.width = `${st.percent}%`;
            document.getElementById('pop-percent-text').textContent = `${st.percent} %`;

            document.getElementById('pop-files-pill').innerHTML = `${st.processed_items} / ${st.total_items}<br>fichiers`;
            const etaClean = (st.eta_text || '').replace('ETA: ', '') || '--:--';
            document.getElementById('pop-eta-pill').innerHTML = `Temps restant estimé<br>${etaClean}`;
            document.getElementById('pop-speed-pill').textContent = st.speed_text || '-- Mo/s';

            const dupsEta = document.getElementById('dups-eta-label');
            if (dupsEta) dupsEta.textContent = etaClean;
            const simsEta = document.getElementById('sims-eta-label');
            if (simsEta) simsEta.textContent = etaClean;

            document.getElementById('icon-pause-bars').classList.toggle('hidden', !st.is_running);
            document.getElementById('icon-play-triangle').classList.toggle('hidden', st.is_running);

            const warnBtn = document.getElementById('btn-task-warning');
            if (warnBtn) warnBtn.classList.toggle('hidden', !hasMissing);
            if (hasMissing) {
                document.getElementById('task-missing-meta-list').innerHTML = st.missing_meta_files
                    .slice(0, 30)
                    .map(p => `<div class="truncate">${p}</div>`)
                    .join('');
            }
        }

        if (st.logs && st.logs.length) {
            const box = document.getElementById('pipe-logs-box');
            if (box) {
                box.innerHTML = st.logs.map(l => `<div>${l}</div>`).join('');
                box.scrollTop = box.scrollHeight;
            }
        }

        if (st.is_running) {
            pipelineRefreshTicks++;
            if (pipelineRefreshTicks % 3 === 0) loadStats();
            if (pipelineRefreshTicks % 8 === 0) {
                const isLightboxOpen = !document.getElementById('lightbox-modal').classList.contains('hidden');
                if (!isLightboxOpen && selectedGalleryPaths.size === 0) {
                    if ((currentTab === 'gallery' || currentTab === 'favorites') && galleryPage === 1 && currentSkipOffset === 0) loadGalleryItems(false);
                    else if (currentTab === 'faces' && typeof selectedPersonIds !== 'undefined' && selectedPersonIds.size === 0) loadPersons();
                    else if (currentTab === 'dups') loadDuplicates();
                    else if (currentTab === 'similar') loadSimilarGroups();
                }
            }
        } else {
            pipelineRefreshTicks = 0;
        }

        if (wasPipelineRunning && !st.is_running) {
            await loadStats();
            await loadGalleryFilters();
            refreshActiveMediaView();
        }
        wasPipelineRunning = st.is_running;
    } catch (e) {}
}, 1000);

window.addEventListener('DOMContentLoaded', async () => {
    const savedTheme = localStorage.getItem('phototo_theme') || 'light';
    setAppTheme(savedTheme);
    await loadAppSettings();
    await loadLibrariesDropdown();
    await loadStats();
    await loadGalleryFilters();
    await loadGalleryItems();
    await loadGalleryTimeline();
});

// ==================== GESTION DES BIBLIOTHÈQUES (LISTE, CRÉER, MODIFIER, SUPPRIMER, FUSIONNER, DOUBLONS AUTO) ====================

async function loadLibrariesDropdown() {
    const res = await fetch('/api/libraries');
    if (!res.ok) return;
    cachedLibrariesData = await res.json();
    librariesConfig = cachedLibrariesData;

    const active = cachedLibrariesData.active_library;
    const libs = cachedLibrariesData.libraries || {};
    const names = Object.keys(libs);

    // Mise à jour du bouton #lib-name-btn dans topbar.html
    const nameBtn = document.getElementById('lib-name-btn');
    if (nameBtn) {
        nameBtn.textContent = active || 'Nom de la bibliotheque';
    }

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


// ==================== ASSISTANT D'IMPORTATION EN 3 ÉTAPES (DOSSIERS, SOUS-DOSSIERS & TAKEOUT) ====================

var wizardImportSourceType = 'STANDARD_FOLDER';
var wizardSelectedPaths = [];
var wizardOptFixMeta = true;
var wizardOptDelZips = false;
var wizardOptCreateAlbum = true;
var wizardSubfolderMode = 'SINGLE'; // 'SINGLE' | 'ALL_SUBS' | 'CUSTOM_SUBS'
var wizardDetectedSubfolders = [];

function openImportWizard() {
    if (typeof hideAllTopPopovers === 'function') hideAllTopPopovers();
    wizardSelectedPaths = [];
    wizardDetectedSubfolders = [];
    wizardOptFixMeta = true;
    wizardOptDelZips = false;
    wizardOptCreateAlbum = true;
    wizardSubfolderMode = 'SINGLE';
    updateWizardCheckDOM();
    showImportStep(1);
    const modal = document.getElementById('import-wizard-modal');
    if (modal) modal.classList.remove('hidden');
}

var openImportModal = openImportWizard;
var startImportFlow = openImportWizard;

function closeImportWizard() {
    const modal = document.getElementById('import-wizard-modal');
    if (modal) modal.classList.add('hidden');
}

var closeImportModal = closeImportWizard;

function showImportStep(stepNum) {
    [1, 2, 3].forEach(n => {
        const el = document.getElementById(`import-step-${n}`);
        if (el) el.classList.toggle('hidden', n !== stepNum);
    });
}

function updateWizardCheckDOM() {
    const chkFix = document.getElementById('wiz-chk-fix');
    const chkDel = document.getElementById('wiz-chk-del');
    const chkAlb = document.getElementById('wiz-chk-album');
    const cfgPanel = document.getElementById('wiz-album-config-panel');

    if (chkFix) chkFix.textContent = wizardOptFixMeta ? '✓' : '';
    if (chkDel) chkDel.textContent = wizardOptDelZips ? '✓' : '';
    if (chkAlb) chkAlb.textContent = wizardOptCreateAlbum ? '✓' : '';
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
                       class="w-3.5 h-3.5 accent-[#593E5A] shrink-0"/>
                <span class="truncate" title="${sf.display_name}">${sf.display_name}</span>
                <span class="opacity-50 text-[10px] shrink-0">(${sf.media_count})</span>
            </label>
            <div class="flex items-center gap-1.5 shrink-0">
                <label class="flex items-center gap-1 text-[10px] opacity-80 cursor-pointer" title="Créer un album pour ce sous-dossier">
                    <input type="checkbox" ${sf.create_album ? 'checked' : ''}
                           onchange="wizardDetectedSubfolders[${idx}].create_album = this.checked; document.getElementById('wiz-sf-alb-${idx}').disabled = !this.checked;"
                           class="w-3 h-3 accent-[#593E5A]"/>
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

async function pickStandardFolderForImport() {
    const res = await fetch('/api/dialog/browse?mode=folder');
    if (!res.ok) return;
    const d = await res.json();
    if (!d.paths || !d.paths.length) return;

    wizardImportSourceType = 'STANDARD_FOLDER';
    wizardSelectedPaths = d.paths;
    wizardOptCreateAlbum = true;

    const folderName = d.paths[0].split(/[\\/]/).filter(Boolean).pop() || 'Nouvel Album';
    const albInput = document.getElementById('wiz-album-name-input');
    if (albInput) albInput.value = folderName;

    let subData = {has_subfolders: false, folders: []};
    try {
        const subRes = await fetch('/api/import/inspect_subfolders', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({source_paths: d.paths})
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

    prepareImportStep3('Importer un dossier', 'Dossier sélectionné', false);
}

async function pickTakeoutSource(sourceType) {
    const browseMode = (sourceType === 'TAKEOUT_ZIPS') ? 'zips' : 'folder';
    const res = await fetch(`/api/dialog/browse?mode=${browseMode}`);
    if (!res.ok) return;
    const d = await res.json();
    if (!d.paths || !d.paths.length) return;

    wizardImportSourceType = sourceType;
    wizardSelectedPaths = d.paths;
    wizardOptCreateAlbum = false;
    wizardSubfolderMode = 'SINGLE';

    const modesBox = document.getElementById('wiz-subfolder-modes');
    if (modesBox) modesBox.classList.add('hidden');

    const folderName = d.paths[0].split(/[\\/]/).filter(Boolean).pop()?.replace(/\.zip$/i, '') || 'Import Takeout';
    const albInput = document.getElementById('wiz-album-name-input');
    if (albInput) albInput.value = folderName;

    const subTitle = (sourceType === 'TAKEOUT_ZIPS') ? 'Fichiers ZIP' : 'Dossier décompressé';
    prepareImportStep3('Importer depuis Google', subTitle, true);
}

function prepareImportStep3(headerText, subtitleText, isGoogle) {
    const hEl = document.getElementById('import-step3-header');
    const sEl = document.getElementById('import-step3-subtitle');
    const pEl = document.getElementById('import-step3-paths');
    const backBtn = document.getElementById('import-step3-back-btn');
    const rowDel = document.getElementById('row-opt-del-zips');

    if (hEl) hEl.textContent = headerText;
    if (sEl) sEl.textContent = subtitleText;
    if (pEl) {
        pEl.innerHTML = wizardSelectedPaths
            .map(p => `<div class="truncate">${p.replace(/\\/g, '/')}</div>`)
            .join('');
    }
    if (backBtn) {
        backBtn.setAttribute('onclick', `showImportStep(${isGoogle ? 2 : 1})`);
    }
    if (rowDel) {
        rowDel.classList.toggle('hidden', wizardImportSourceType !== 'TAKEOUT_ZIPS');
    }

    updateWizardCheckDOM();
    showImportStep(3);
}

function rePickStep3Paths() {
    if (wizardImportSourceType === 'STANDARD_FOLDER') {
        pickStandardFolderForImport();
    } else {
        pickTakeoutSource(wizardImportSourceType);
    }
}

async function handleDroppedFiles(event) {
    event.preventDefault();
    const dz = document.getElementById('drop-zone');
    if (dz) dz.classList.remove('ring-2', 'ring-[#593E5A]');
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
        alert("Aucun dossier sélectionné.");
        return;
    }
    const customAlbumName = (document.getElementById('wiz-album-name-input')?.value || '').trim();
    closeImportWizard();

    const active = librariesConfig?.active_library;
    if (!active || !librariesConfig.libraries || !librariesConfig.libraries[active]) {
        const folderName = wizardSelectedPaths[0].split(/[\\/]/).filter(Boolean).pop() || 'Ma Bibliothèque';
        await fetch('/api/libraries/create', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                name: folderName,
                source_type: wizardImportSourceType,
                source_paths_raw: wizardImportSourceType === 'STANDARD_FOLDER' ? '' : wizardSelectedPaths.join('\n'),
                dest_dir: wizardSelectedPaths[0],
                fix_takeout_json_metadata: wizardOptFixMeta,
                delete_zips_progressively: wizardOptDelZips,
                organize_by_year_month: true
            })
        });
        await loadLibrariesDropdown();
    }

    const res = await fetch('/api/import/add_sources', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            source_type: wizardImportSourceType,
            source_paths: wizardSelectedPaths,
            fix_takeout_json_metadata: Boolean(wizardOptFixMeta),
            delete_zips_progressively: Boolean(wizardOptDelZips),
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
            alert("Erreur serveur lors de l'importation.");
        }
        return;
    }

    await loadStats();
    await loadGalleryFilters();
    refreshActiveMediaView();
    if (currentTab === 'albums' && typeof loadAlbumsView === 'function') loadAlbumsView();

    if (wizardImportSourceType !== 'STANDARD_FOLDER') {
        await runTask('INGEST');
    }
}