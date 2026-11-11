let currentTab = 'gallery';
let currentExtFilter = '';
let galleryViewMode = 'GRID';
let cachedLibrariesData = {active_library: null, libraries: {}};
let libraryModalMode = 'CREATE';
let currentLightboxIndex = -1;
let clientPausedTask = '';
let lastSeenActiveTask = '';
let currentGpuMode = 'cuda';
let checkedDuplicatePaths = new Set();

let openedAlbumName = null;
let singleAlbumPage = 1;
let singleAlbumTotalPages = 1;

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
    sb.classList.toggle('sidebar-mini');
    const lbl = document.getElementById('import-btn-label');
    const btn = document.getElementById('btn-top-import');
    if (sb.classList.contains('sidebar-mini')) {
        lbl.classList.add('hidden');
        btn.classList.replace('px-5', 'px-3');
    } else {
        lbl.classList.remove('hidden');
        btn.classList.replace('px-3', 'px-5');
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
        return `<video src="${url}" preload="metadata" class="${css}"></video>`;
    }
    return `<img src="${url}" loading="lazy" decoding="async" class="${css}"/>`;
}

function updateGalleryMonthDropdown() {
    const sel = document.getElementById('gal-month');
    if (!sel) return;
    const cur = sel.value;
    const mNames = ["01 - Janvier","02 - Février","03 - Mars","04 - Avril","05 - Mai","06 - Juin","07 - Juillet","08 - Août","09 - Septembre","10 - Octobre","11 - Novembre","12 - Décembre"];
    sel.innerHTML = `<option value="">Tous les mois</option>` + mNames.map((n, i) => `<option value="${String(i+1).padStart(2,'0')}">${n}</option>`).join('');
    sel.value = cur;
}

function toggleFilterBar() {
    document.getElementById('filter-drawer').classList.toggle('hidden');
}

function toggleLibMenuPopover(e) {
    e.stopPropagation();
    document.getElementById('task-popover').classList.add('hidden');
    document.getElementById('lib-menu-popover').classList.toggle('hidden');
}

function toggleTaskPopover(e) {
    e.stopPropagation();
    document.getElementById('lib-menu-popover').classList.add('hidden');
    document.getElementById('task-popover').classList.toggle('hidden');
}

window.addEventListener('click', e => {
    const libPop = document.getElementById('lib-menu-popover');
    const taskPop = document.getElementById('task-popover');
    if (libPop && !libPop.contains(e.target)) libPop.classList.add('hidden');
    if (taskPop && !taskPop.contains(e.target)) taskPop.classList.add('hidden');
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
        const tl = document.getElementById('timeline-scrubber');
        if (tl) tl.classList.toggle('hidden', tab !== 'gallery' && tab !== 'favorites');
    });

    if (tab === 'favorites') {
        document.getElementById('tab-gallery').classList.remove('hidden');
        document.getElementById('gallery-main-heading').textContent = 'Favoris';
        document.getElementById('gal-fav').checked = true;
        currentExtFilter = '';
        resetAndLoadGallery();
    } else if (tab === 'gallery') {
        document.getElementById('gallery-main-heading').textContent = 'Galerie';
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

// ==================== STATISTIQUES & COUVERTURE ====================

async function loadStats() {
    const res = await fetch('/api/stats');
    const d = await res.json();
    document.getElementById('st-indexed').textContent = d.indexed || 0;
    const gbEl = document.getElementById('st-gb');
    if (gbEl && d.total_gb !== undefined) gbEl.textContent = String(d.total_gb).replace('.', ',');

    document.getElementById('st-dups').textContent = d.duplicates || 0;
    document.getElementById('dups-count-banner').textContent = d.duplicates || 0;

    const simCount = d.similar_count !== undefined ? d.similar_count : 0;
    document.getElementById('st-sims').textContent = simCount;
    document.getElementById('sims-count-banner').textContent = simCount;

    const mm = document.getElementById('st-missing-meta');
    if (mm && d.missing_meta !== undefined) mm.textContent = d.missing_meta;

    if (d.coverage) {
        const ded = d.coverage.dedup;
        if (ded) {
            document.getElementById('cov-bar-dedup').style.width = `${ded.percent}%`;
            document.getElementById('cov-pct-dedup').textContent = `${ded.percent} %`;
            document.getElementById('cov-label-dedup').innerHTML = `${ded.done} / ${ded.total}<br><span class="font-semibold opacity-75">fichiers analysés</span>`;
        }
        const sim = d.coverage.similar;
        if (sim) {
            document.getElementById('cov-bar-similar').style.width = `${sim.percent}%`;
            document.getElementById('cov-pct-similar').textContent = `${sim.percent} %`;
            document.getElementById('cov-label-similar').innerHTML = `${sim.done} / ${sim.total}<br><span class="font-semibold opacity-75">fichiers analysés</span>`;
        }
    }
}

async function toggleNotificationsPopover(e) {
    e.stopPropagation();
    document.getElementById('lib-menu-popover').classList.add('hidden');
    document.getElementById('task-popover').classList.add('hidden');
    const pop = document.getElementById('notif-popover');
    pop.classList.toggle('hidden');
    if (!pop.classList.contains('hidden')) {
        await fetch('/api/notifications/clear', {method: 'POST'});
        document.getElementById('notif-unread-dot').classList.add('hidden');
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

        document.getElementById('pulse-badge').classList.toggle('hidden', !st.is_running);
        document.getElementById('task-empty-state').classList.toggle('hidden', showActivePanel);
        document.getElementById('task-active-state').classList.toggle('hidden', !showActivePanel);

        if (showActivePanel) {
            document.getElementById('pop-step-title').textContent = st.current_step || 'Analyse en cours...';
            document.getElementById('pipe-bar').style.width = `${st.percent}%`;
            document.getElementById('pop-percent-text').textContent = `${st.percent} %`;

            document.getElementById('pop-files-pill').innerHTML = `${st.processed_items} / ${st.total_items}<br>fichiers`;
            const etaClean = (st.eta_text || '').replace('ETA: ', '') || '--:--';
            document.getElementById('pop-eta-pill').innerHTML = `Temps restant estimé<br>${etaClean}`;
            document.getElementById('pop-speed-pill').textContent = st.speed_text || '-- Mo/s';

            document.getElementById('dups-eta-label').textContent = etaClean;
            document.getElementById('sims-eta-label').textContent = etaClean;

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
            box.innerHTML = st.logs.map(l => `<div>${l}</div>`).join('');
            box.scrollTop = box.scrollHeight;
        }

        if (st.is_running) {
            pipelineRefreshTicks++;
            if (pipelineRefreshTicks % 3 === 0) loadStats();
            if (pipelineRefreshTicks % 8 === 0) {
                const isLightboxOpen = !document.getElementById('lightbox-modal').classList.contains('hidden');
                if (!isLightboxOpen && selectedGalleryPaths.size === 0) {
                    if ((currentTab === 'gallery' || currentTab === 'favorites') && galleryPage === 1) loadGalleryItems(false);
                    else if (currentTab === 'faces' && selectedPersonIds.size === 0) loadPersons();
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
});
