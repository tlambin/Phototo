// ==================== PERSONNES ====================

let selectedPersonIds = new Set();
let currentTimelinePersonId = null;
let selectedFaceIds = new Set();

async function loadPersons() {
    const res = await fetch('/api/persons');
    const d = await res.json();
    const all = d.persons || [];
    const identified = all.filter(p => p.name && p.name.toLowerCase() !== 'inconnu');
    const unknown = all.filter(p => !p.name || p.name.toLowerCase() === 'inconnu');

    const renderCircle = p => {
        const isChk = selectedPersonIds.has(p.person_id);
        return `
        <div class="flex flex-col items-center group relative">
            <input type="checkbox" ${isChk ? 'checked' : ''} onchange="togglePersonSelection(${p.person_id})"
                   class="${isChk ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} absolute top-1 left-4 w-4 h-4 cursor-pointer z-10"/>
            <div onclick="openTimeline(${p.person_id})" class="w-32 h-32 rounded-full ui-card overflow-hidden cursor-pointer shadow-sm group-hover:scale-105 transition">
                <img src="/media?path=${encodeURIComponent(p.thumb_path||'')}" class="w-full h-full object-cover"/>
            </div>
            <input type="text" value="${p.name}" onchange="renamePerson(${p.person_id}, this.value)"
                   class="bg-transparent text-xs font-extrabold text-center mt-2 w-32 outline-none focus:underline"/>
        </div>`;
    };

    document.getElementById('persons-identified-grid').innerHTML = identified.length
        ? identified.map(renderCircle).join('')
        : `<div class="col-span-full text-xs opacity-60">Renommez un visage ci-dessous pour l'ajouter aux personnes identifiées.</div>`;

    document.getElementById('persons-unknown-grid').innerHTML = unknown.map(renderCircle).join('');
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

async function openTimeline(pid) {
    currentTimelinePersonId = pid;
    selectedFaceIds.clear();
    const pRes = await fetch('/api/persons');
    const pData = await pRes.json();
    document.getElementById('tl-target-person-select').innerHTML = '<option value="">-- Choisir une personne --</option>' +
        (pData.persons||[]).filter(x => x.person_id !== pid).map(x => `<option value="${x.person_id}">${x.name}</option>`).join('');

    const res = await fetch(`/api/person/${pid}/timeline`);
    const d = await res.json();
    document.getElementById('persons-overview-panel').classList.add('hidden');
    document.getElementById('person-timeline-modal').classList.remove('hidden');
    document.getElementById('tl-person-name').textContent = `${d.person.name} (${d.faces.length})`;
    document.getElementById('tl-faces-grid').innerHTML = d.faces.map(f => {
        const sEnc = encodeURIComponent(f.source_path || f.dest_path);
        const dEnc = encodeURIComponent(f.dest_path);
        return `
        <div class="ui-pill rounded-2xl p-1.5 relative">
            <input type="checkbox" onchange="if(this.checked) selectedFaceIds.add(${f.face_id}); else selectedFaceIds.delete(${f.face_id}); document.getElementById('tl-sel-count').textContent=selectedFaceIds.size+' sélectionné(s)';" class="absolute top-2 left-2 w-4 h-4 z-10"/>
            <div onclick="openLightboxForCustomItem('${sEnc}', '${dEnc}', ${f.timestamp || 0})" class="cursor-pointer">
                <img src="/media?path=${encodeURIComponent(f.thumb_path)}" class="w-full h-24 object-cover rounded-xl mb-1"/>
            </div>
            <div class="text-[10px] opacity-70 text-center">${formatDate(f.timestamp)}</div>
        </div>`;
    }).join('');
}

function closeTimeline() {
    document.getElementById('person-timeline-modal').classList.add('hidden');
    document.getElementById('persons-overview-panel').classList.remove('hidden');
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
async function loadWorldMap(force) {
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
        if (!buckets[key]) buckets[key] = { label: pt.album_name || `Zone (${key})`, count: 0, cover: pt.dest_path, lat: pt.latitude, lon: pt.longitude };
        buckets[key].count++;
    });
    const topPlaces = Object.values(buckets).sort((a,b) => b.count - a.count).slice(0, 5);
    document.getElementById('places-cards-grid').innerHTML = topPlaces.map(pl => `
        <div onclick="leafletMap.setView([${pl.lat}, ${pl.lon}], 12)" class="ui-card rounded-3xl overflow-hidden cursor-pointer shadow-sm group">
            <div class="aspect-square overflow-hidden">
                ${renderMediaPreview(pl.cover, "w-full h-full object-cover group-hover:scale-105 transition")}
            </div>
            <div class="p-2.5 text-center">
                <div class="text-xs font-extrabold truncate">${pl.label}</div>
                <div class="text-[10px] opacity-60 font-semibold">${pl.count} éléments</div>
            </div>
        </div>
    `).join('');
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
