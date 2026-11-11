// ==================== MODALES : VISAGE, EXIF, STUDIO, PARAMÈTRES ====================

let taggerCurrentPath = "", isDrawingBox = false, startX = 0, startY = 0, currentNormBox = null;
async function openManualFaceModal(encDest) {
    taggerCurrentPath = decodeURIComponent(encDest);
    currentNormBox = null;
    document.getElementById('btn-save-manual-face').disabled = true;
    document.getElementById('tagger-draw-box').classList.add('hidden');
    const pRes = await fetch('/api/persons');
    const pData = await pRes.json();
    document.getElementById('manual-person-select').innerHTML = '<option value="">-- Nouvelle personne --</option>' +
        (pData.persons||[]).map(p => `<option value="${p.person_id}">${p.name}</option>`).join('');
    document.getElementById('tagger-img').src = `/media?path=${encodeURIComponent(taggerCurrentPath)}`;
    document.getElementById('manual-face-modal').classList.remove('hidden');
}
function closeManualFaceModal() { document.getElementById('manual-face-modal').classList.add('hidden'); }

const tagStage = document.getElementById('tagger-stage');
tagStage.addEventListener('mousedown', e => {
    const r = tagStage.getBoundingClientRect();
    isDrawingBox = true; startX = e.clientX - r.left; startY = e.clientY - r.top;
    const b = document.getElementById('tagger-draw-box');
    b.style.left = startX+'px'; b.style.top = startY+'px'; b.style.width = '0px'; b.style.height = '0px';
    b.classList.remove('hidden');
});
window.addEventListener('mousemove', e => {
    if (!isDrawingBox) return;
    const r = tagStage.getBoundingClientRect();
    const cx = Math.max(0, Math.min(e.clientX - r.left, r.width)), cy = Math.max(0, Math.min(e.clientY - r.top, r.height));
    const x = Math.min(startX, cx), y = Math.min(startY, cy), w = Math.abs(cx - startX), h = Math.abs(cy - startY);
    const b = document.getElementById('tagger-draw-box');
    b.style.left = x+'px'; b.style.top = y+'px'; b.style.width = w+'px'; b.style.height = h+'px';
    if (w > 10 && h > 10) {
        currentNormBox = {nx1: x/r.width, ny1: y/r.height, nx2: (x+w)/r.width, ny2: (y+h)/r.height};
        document.getElementById('btn-save-manual-face').disabled = false;
    }
});
window.addEventListener('mouseup', () => { isDrawingBox = false; });

async function saveManualFaceBox() {
    if (!currentNormBox) return;
    const pid = document.getElementById('manual-person-select').value;
    await fetch('/api/faces/manual_add', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
            dest_path: taggerCurrentPath,
            norm_x1: currentNormBox.nx1, norm_y1: currentNormBox.ny1, norm_x2: currentNormBox.nx2, norm_y2: currentNormBox.ny2,
            target_person_id: pid ? parseInt(pid,10) : null,
            new_person_name: document.getElementById('manual-new-name').value
        })
    });
    closeManualFaceModal(); refreshActiveMediaView(); loadStats();
}

let metaTargetSourcePaths = [], metaTargetOriginalTimestamps = [], metaPickerMap = null, metaPickerMarker = null;
function initOrUpdateMetaPickerMap(lat = null, lon = null) {
    if (!metaPickerMap) {
        metaPickerMap = L.map('meta-picker-map').setView([46.6, 1.88], 5);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(metaPickerMap);
        metaPickerMap.on('click', e => setMetaPickerPin(e.latlng.lat, e.latlng.lng));
    }
    setTimeout(() => { metaPickerMap.invalidateSize(); if (lat && lon) setMetaPickerPin(lat, lon); }, 150);
}
function setMetaPickerPin(lat, lon) {
    document.getElementById('meta-lat').value = Number(lat).toFixed(6);
    document.getElementById('meta-lon').value = Number(lon).toFixed(6);
    if (!metaPickerMarker) metaPickerMarker = L.marker([lat, lon]).addTo(metaPickerMap);
    else metaPickerMarker.setLatLng([lat, lon]);
    metaPickerMap.setView([lat, lon], 12);
}
async function searchPlaceForMetaMap() {
    const q = document.getElementById('meta-place-search').value.trim();
    if (!q) return;
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
    const d = await res.json();
    if (d && d.length) setMetaPickerPin(parseFloat(d[0].lat), parseFloat(d[0].lon));
}
async function openMetadataModalSingle(encSrc) {
    const src = decodeURIComponent(encSrc);
    metaTargetSourcePaths = [src];
    const res = await fetch(`/api/metadata/inspect?source_path=${encodeURIComponent(src)}`);
    const d = await res.json();
    metaTargetOriginalTimestamps = [d.timestamp || 0];
    document.getElementById('meta-datetime').value = d.datetime_local_iso || '';
    document.getElementById('meta-lat').value = d.latitude || '';
    document.getElementById('meta-lon').value = d.longitude || '';
    document.getElementById('meta-sequence-panel').classList.add('hidden');
    document.getElementById('metadata-modal').classList.remove('hidden');
    initOrUpdateMetaPickerMap(d.latitude, d.longitude);
}
async function openMetadataModalForSelection() {
    const arr = Array.from(selectedGalleryPaths);
    if (!arr.length) { alert("Cochez d'abord une ou plusieurs photos dans la Galerie."); return; }
    metaTargetSourcePaths = arr;
    const tsMap = {}; currentGalleryItems.forEach(i => tsMap[i.source_path] = i.timestamp || 0);
    metaTargetOriginalTimestamps = arr.map(s => tsMap[s] || 0);
    const res = await fetch(`/api/metadata/inspect?source_path=${encodeURIComponent(arr[0])}`);
    const d = await res.json();
    document.getElementById('meta-datetime').value = d.datetime_local_iso || '';
    document.getElementById('meta-sequence-panel').classList.toggle('hidden', arr.length < 2);
    document.getElementById('metadata-modal').classList.remove('hidden');
    updateSequentialPreview();
    initOrUpdateMetaPickerMap(d.latitude, d.longitude);
}
function closeMetadataModal() { document.getElementById('metadata-modal').classList.add('hidden'); }
function updateSequentialPreview() {
    if (metaTargetSourcePaths.length < 2) return;
    const dtVal = document.getElementById('meta-datetime').value;
    if (!dtVal) return;
    const mode = document.querySelector('input[name="time_seq_mode"]:checked').value;
    const step = parseInt(document.getElementById('meta-step-sec').value || '17', 10);
    const baseMs = new Date(dtVal).getTime();
    const firstOrig = metaTargetOriginalTimestamps[0] || 0;
    const lines = [];
    for (let i = 0; i < Math.min(metaTargetSourcePaths.length, 5); i++) {
        let ms = baseMs;
        if (mode === 'FIXED_STEP') ms = baseMs + i * step * 1000;
        else if (mode === 'PRESERVE_GAPS' && i > 0) {
            const orig = metaTargetOriginalTimestamps[i] || 0;
            ms = (orig > firstOrig && firstOrig > 0) ? (baseMs + (orig - firstOrig) * 1000) : (baseMs + i * step * 1000);
        }
        lines.push(`<div>Fichier #${i+1} ➔ <b>${new Date(ms).toLocaleTimeString('fr-FR')}</b></div>`);
    }
    document.getElementById('meta-seq-preview').innerHTML = lines.join('');
}
async function saveMetadataChanges() {
    const dtVal = document.getElementById('meta-datetime').value;
    const lat = document.getElementById('meta-lat').value;
    const lon = document.getElementById('meta-lon').value;
    await fetch('/api/metadata/batch_update', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
            source_paths: metaTargetSourcePaths,
            start_datetime_iso: dtVal ? (dtVal.length === 16 ? dtVal+':00' : dtVal) : null,
            time_sequence_mode: document.querySelector('input[name="time_seq_mode"]:checked')?.value || 'PRESERVE_GAPS',
            step_seconds: parseInt(document.getElementById('meta-step-sec').value || '17', 10),
            latitude: lat !== '' ? parseFloat(lat) : null,
            longitude: lon !== '' ? parseFloat(lon) : null,
            description: document.getElementById('meta-desc').value || null
        })
    });
    closeMetadataModal(); refreshActiveMediaView();
}
async function stripMetadata(gpsOnly, allExif) {
    await fetch('/api/metadata/batch_strip', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({source_paths: metaTargetSourcePaths, strip_gps: gpsOnly, strip_all_exif: allExif})
    });
    closeMetadataModal(); refreshActiveMediaView();
}

let studioSourcePath = "", studioDestPath = "", studioIsVideo = false, studioMouseTool = "CROP";
let studioRotation = 0, studioFlipH = false, studioFlipV = false, studioCropRect = null, studioEraserBoxes = [];
let studioDrawing = false, stStartX = 0, stStartY = 0;

function openStudioModal(encSrc, encDest) {
    studioSourcePath = decodeURIComponent(encSrc);
    studioDestPath = decodeURIComponent(encDest);
    studioIsVideo = isVideoFile(studioDestPath);
    document.getElementById('studio-video-panel').classList.toggle('hidden', !studioIsVideo);
    document.querySelector('input[name="studio_save_mode"][value="copy"]').checked = true;
    studioRotation = 0; studioFlipH = false; studioFlipV = false;
    clearStudioDrawings();

    const imgEl = document.getElementById('studio-img');
    const vidEl = document.getElementById('studio-video');
    const url = `/media?path=${encodeURIComponent(studioDestPath)}&t=${Date.now()}`;
    if (studioIsVideo) { imgEl.classList.add('hidden'); vidEl.classList.remove('hidden'); vidEl.src = url; }
    else { vidEl.classList.add('hidden'); vidEl.pause(); imgEl.classList.remove('hidden'); imgEl.src = url; }
    updateStudioLivePreview();
    document.getElementById('studio-modal').classList.remove('hidden');
}
function closeStudioModal() { document.getElementById('studio-video').pause(); document.getElementById('studio-modal').classList.add('hidden'); }
function setStudioMouseTool(t) { studioMouseTool = t; }
function clearStudioDrawings() { studioCropRect = null; studioEraserBoxes = []; document.getElementById('studio-crop-box').classList.add('hidden'); document.getElementById('studio-eraser-boxes').innerHTML = ''; }
function studioRotate(d) { studioRotation = (studioRotation + d + 360) % 360; updateStudioLivePreview(); }
function studioFlip(ax) { if(ax==='H') studioFlipH=!studioFlipH; else studioFlipV=!studioFlipV; updateStudioLivePreview(); }
function updateStudioLivePreview() {
    const b = document.getElementById('st-bright').value, c = document.getElementById('st-contrast').value, s = document.getElementById('st-sat').value;
    const el = studioIsVideo ? document.getElementById('studio-video') : document.getElementById('studio-img');
    el.style.filter = `brightness(${b}) contrast(${c}) saturate(${s})`;
    el.style.transform = `rotate(${studioRotation}deg) scale(${studioFlipH?-1:1}, ${studioFlipV?-1:1})`;
}
const stStage = document.getElementById('studio-stage');
stStage.addEventListener('mousedown', e => {
    const r = stStage.getBoundingClientRect();
    studioDrawing = true; stStartX = e.clientX - r.left; stStartY = e.clientY - r.top;
    if (studioMouseTool === 'CROP') {
        const box = document.getElementById('studio-crop-box');
        box.style.left = stStartX+'px'; box.style.top = stStartY+'px'; box.style.width = '0px'; box.style.height = '0px';
        box.classList.remove('hidden');
    }
});
window.addEventListener('mousemove', e => {
    if (!studioDrawing) return;
    const r = stStage.getBoundingClientRect();
    const cx = Math.max(0, Math.min(e.clientX - r.left, r.width)), cy = Math.max(0, Math.min(e.clientY - r.top, r.height));
    const x = Math.min(stStartX, cx), y = Math.min(stStartY, cy), w = Math.abs(cx - stStartX), h = Math.abs(cy - stStartY);
    if (studioMouseTool === 'CROP') {
        const box = document.getElementById('studio-crop-box');
        box.style.left = x+'px'; box.style.top = y+'px'; box.style.width = w+'px'; box.style.height = h+'px';
        studioCropRect = {nx: x/r.width, ny: y/r.height, nw: w/r.width, nh: h/r.height};
    }
});
window.addEventListener('mouseup', e => {
    if (!studioDrawing) return;
    studioDrawing = false;
    if (studioMouseTool === 'ERASER') {
        const r = stStage.getBoundingClientRect();
        const cx = Math.max(0, Math.min(e.clientX - r.left, r.width)), cy = Math.max(0, Math.min(e.clientY - r.top, r.height));
        const x = Math.min(stStartX, cx), y = Math.min(stStartY, cy), w = Math.abs(cx - stStartX), h = Math.abs(cy - stStartY);
        if (w > 8 && h > 8) {
            const nb = {nx: x/r.width, ny: y/r.height, nw: w/r.width, nh: h/r.height};
            studioEraserBoxes.push(nb);
            document.getElementById('studio-eraser-boxes').innerHTML += `<div style="left:${nb.nx*100}%;top:${nb.ny*100}%;width:${nb.nw*100}%;height:${nb.nh*100}%;" class="absolute border-2 border-rose-500 bg-rose-500/30"></div>`;
        }
    }
});
async function browseStudioAudio() {
    const res = await fetch('/api/dialog/browse?mode=audio');
    const d = await res.json();
    if (d.paths && d.paths.length) document.getElementById('st-vid-audio').value = d.paths[0];
}
async function applyStudioChanges(videoAction = 'EDIT') {
    const saveMode = document.querySelector('input[name="studio_save_mode"]:checked').value;
    const txtVal = document.getElementById('st-text-val').value.trim();
    const vidEl = document.getElementById('studio-video');
    const res = await fetch('/api/studio/apply', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
            source_path: studioSourcePath,
            overwrite: (saveMode === 'overwrite'),
            crop: studioCropRect, rotate: studioRotation, flip_h: studioFlipH, flip_v: studioFlipV,
            brightness: parseFloat(document.getElementById('st-bright').value),
            contrast: parseFloat(document.getElementById('st-contrast').value),
            saturation: parseFloat(document.getElementById('st-sat').value),
            sharpness: parseFloat(document.getElementById('st-sharp').value),
            text_overlay: txtVal ? {
                text: txtVal, nx: parseFloat(document.getElementById('st-text-x').value)/100.0,
                ny: parseFloat(document.getElementById('st-text-y').value)/100.0,
                size: parseInt(document.getElementById('st-text-size').value, 10),
                color: document.getElementById('st-text-color').value
            } : null,
            inpaint_boxes: studioEraserBoxes, video_action: videoAction,
            start_sec: parseFloat(document.getElementById('st-vid-start').value || '0'),
            end_sec: parseFloat(document.getElementById('st-vid-end').value || '0'),
            split_time_sec: (studioIsVideo && vidEl && vidEl.currentTime > 0) ? vidEl.currentTime : 5.0,
            speed: parseFloat(document.getElementById('st-vid-speed').value || '1.0'),
            mute_audio: document.getElementById('st-vid-mute').checked,
            custom_audio_path: document.getElementById('st-vid-audio').value.trim() || null
        })
    });
    if (res.ok) { closeStudioModal(); refreshActiveMediaView(); loadStats(); }
}
