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
    closeMetadataModal();
    refreshActiveMediaView();
    if (typeof loadLightboxMetadataInfo === 'function' && !document.getElementById('lb-info-drawer')?.classList.contains('hidden')) {
        await loadLightboxMetadataInfo();
    }
}
async function stripMetadata(gpsOnly, allExif) {
    await fetch('/api/metadata/batch_strip', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({source_paths: metaTargetSourcePaths, strip_gps: gpsOnly, strip_all_exif: allExif})
    });
    closeMetadataModal();
    refreshActiveMediaView();
    if (typeof loadLightboxMetadataInfo === 'function' && !document.getElementById('lb-info-drawer')?.classList.contains('hidden')) {
        await loadLightboxMetadataInfo();
    }
}

// ==================== ÉDITEUR STUDIO PHOTO & VIDÉO PRO ====================

let studioSourcePath = "", studioDestPath = "", studioIsVideo = false, studioMouseTool = "CROP";
let studioRotation = 0, studioStraighten = 0, studioFlipH = false, studioFlipV = false;
let studioCropRect = null, studioEraserBoxes = [], studioEraserStrokes = [], studioDrawStrokes = [];
let studioGlareStrokes = [], studioRedeyeStrokes = [], studioBlemishStrokes = [];
let _studioRetouchUndoOrder = [];
let studioImageOverlays = [], studioExtraTextLayers = [], studioExtraClips = [];
let studioDrawing = false, stStartX = 0, stStartY = 0;
let _studioCurrentTab = 'transform';
let _studioDecorationSubtab = 'draw';
let _studioRetouchMode = 'object';
let _studioOrigImgEl = null;
let _studioBrushMode = 'brush';
let _studioBrushColor = '#f43f5e';
let _studioActiveDrawStroke = null;
let _studioAiInstallTimer = null;
let _studioOrigMediaUrl = '';
let _studioEraserPreviewUrl = '';
let _studioShowEraserMasks = false;
let _studioActiveBrushStroke = null;
let _studioEraserReqSeq = 0;
let _studioZoomScale = 1;
let _studioPanX = 0;
let _studioPanY = 0;
let _studioPanDrag = null;
let _studioCropAspect = 'free';
let _studioActivePreset = 'original';
let _studioCompareOrig = false;
let _studioSplitCompare = false;
let _studioSplitPct = 50;
let _studioSplitDrag = false;
let _studioGridMode = 0; // 0=off, 1=thirds
let _studioVideoLoop = true;
let _studioVideoDur = 0;
let _studioVideoListenersBound = false;
let _studioTlDragMode = null;
let _studioCropDrag = null;
let _studioTextDrag = null;
let _studioShapeDrag = null;
let _studioOverlayDrag = null;
let _studioExtraTextDrag = null;
let _studioHistRaf = null;
let _studioLibBinFilter = '';
let _studioHistory = [];
let _studioHistoryIdx = -1;

const STUDIO_FILTER_PRESETS = [
    { key: 'original', label: 'Original',   b: 1.0,  c: 1.0,  s: 1.0,  w: 0.0,   t: 0.0,   f: 0.0,  v: 0.0 },
    { key: 'vivid',    label: 'Vif',        b: 1.05, c: 1.15, s: 1.4,  w: 0.1,   t: 0.0,   f: 0.0,  v: 0.0 },
    { key: 'soft',     label: 'Doux',       b: 1.05, c: 0.9,  s: 0.85, w: 0.05,  t: 0.0,   f: 0.25, v: 0.15 },
    { key: 'warm',     label: 'Doré',       b: 1.05, c: 1.05, s: 1.12, w: 0.45,  t: 0.05,  f: 0.05, v: 0.05 },
    { key: 'cool',     label: 'Azur',       b: 1.0,  c: 1.08, s: 1.05, w: -0.35, t: -0.05, f: 0.0,  v: 0.1 },
    { key: 'cinema',   label: 'Cinéma',     b: 0.95, c: 1.25, s: 0.85, w: -0.2,  t: 0.08,  f: 0.15, v: 0.4 },
    { key: 'bw',       label: 'N&B',        b: 1.0,  c: 1.28, s: 0.0,  w: 0.0,   t: 0.0,   f: 0.0,  v: 0.2 },
    { key: 'bw_high',  label: 'N&B Fort',   b: 1.02, c: 1.48, s: 0.0,  w: 0.0,   t: 0.0,   f: 0.0,  v: 0.32 },
    { key: 'sepia',    label: 'Sépia',      b: 1.02, c: 1.1,  s: 0.25, w: 0.55,  t: 0.08,  f: 0.15, v: 0.2 },
    { key: 'vintage',  label: 'Vintage',    b: 1.04, c: 0.94, s: 0.72, w: 0.28,  t: -0.08, f: 0.35, v: 0.3 },
    { key: 'nordic',   label: 'Nordique',   b: 1.02, c: 1.12, s: 0.82, w: -0.45, t: -0.05, f: 0.12, v: 0.15 },
    { key: 'sunset',   label: 'Coucher',    b: 1.04, c: 1.14, s: 1.25, w: 0.52,  t: 0.22,  f: 0.05, v: 0.18 },
    { key: 'dramatic', label: 'Dramat.',    b: 0.92, c: 1.42, s: 0.75, w: -0.1,  t: 0.05,  f: 0.08, v: 0.45 },
    { key: 'matte',    label: 'Argent.',    b: 1.02, c: 0.92, s: 0.78, w: 0.15,  t: -0.05, f: 0.45, v: 0.25 },
    { key: 'neon',     label: 'Contraste',  b: 1.0,  c: 1.38, s: 1.35, w: -0.1,  t: 0.2,   f: 0.0,  v: 0.3 },
];

function _fmtStudioSec(sec) {
    const s = Math.max(0, Number(sec || 0));
    const m = Math.floor(s / 60);
    const rem = (s % 60).toFixed(1).padStart(4, '0');
    return `${String(m).padStart(2, '0')}:${rem}`;
}

let studioBgRemove = { enabled: false, mode: 'transparent' };
let studioAutoRetouch = { enabled: false, strength: 0.65, skin_wrinkles: true, redeye: true, blemish_glare: true };
let studioBorder = { style: 'none', color: '#ffffff', thickness: 3.0 };
let studioAppliedTemplates = [];
let _studioEditingTemplateId = null;
let _studioEditingAppliedIdx = null;

function _captureStudioSnapshot() {
    return JSON.stringify({
        rotate: studioRotation,
        straighten: studioStraighten,
        flipH: studioFlipH,
        flipV: studioFlipV,
        aspect: _studioCropAspect,
        preset: _studioActivePreset,
        presetInt: document.getElementById('st-preset-intensity')?.value || '100',
        crop: studioCropRect,
        erasers: studioEraserBoxes,
        strokes: studioEraserStrokes,
        glareStrokes: studioGlareStrokes,
        redeyeStrokes: studioRedeyeStrokes,
        blemishStrokes: studioBlemishStrokes,
        retouchOrder: _studioRetouchUndoOrder,
        bgRemove: { ...studioBgRemove },
        autoRetouch: { ...studioAutoRetouch },
        border: { ...studioBorder },
        drawStrokes: studioDrawStrokes,
        overlays: studioImageOverlays,
        extraTexts: studioExtraTextLayers,
        extraClips: studioExtraClips,
        appliedTemplates: studioAppliedTemplates,
        bright: document.getElementById('st-bright')?.value || '1.0',
        contrast: document.getElementById('st-contrast')?.value || '1.0',
        highlights: document.getElementById('st-highlights')?.value || '0.0',
        shadows: document.getElementById('st-shadows')?.value || '0.0',
        fade: document.getElementById('st-fade')?.value || '0.0',
        sat: document.getElementById('st-sat')?.value || '1.0',
        warmth: document.getElementById('st-warmth')?.value || '0.0',
        tint: document.getElementById('st-tint')?.value || '0.0',
        sharp: document.getElementById('st-sharp')?.value || '1.0',
        grain: document.getElementById('st-grain')?.value || '0.0',
        vignette: document.getElementById('st-vignette')?.value || '0.0',
        textVal: document.getElementById('st-text-val')?.value || '',
        textCol: document.getElementById('st-text-color')?.value || '#ffffff',
        textBg: document.getElementById('st-text-bg')?.value || 'transparent',
        textSize: document.getElementById('st-text-size')?.value || '40',
        textOp: document.getElementById('st-text-opacity')?.value || '1.0',
        textX: document.getElementById('st-text-x')?.value || '5',
        textY: document.getElementById('st-text-y')?.value || '86',
        textStart: document.getElementById('st-text-start')?.value || '0',
        textEnd: document.getElementById('st-text-end')?.value || '0',
        vidStart: document.getElementById('st-vid-start')?.value || '0',
        vidEnd: document.getElementById('st-vid-end')?.value || '0',
        vidSpeed: document.getElementById('st-vid-speed')?.value || '1.0',
        vidMute: Boolean(document.getElementById('st-vid-mute')?.checked),
        vidAudio: document.getElementById('st-vid-audio')?.value || '',
        mixMode: document.getElementById('st-audio-mix-mode')?.value || 'replace',
        origVol: document.getElementById('st-orig-vol')?.value || '1.0',
        musicVol: document.getElementById('st-music-vol')?.value || '1.0',
    });
}

function _restoreStudioSnapshot(jsonStr) {
    if (!jsonStr) return;
    try {
        const st = JSON.parse(jsonStr);
        studioRotation = Number(st.rotate || 0);
        studioStraighten = Number(st.straighten || 0);
        studioFlipH = Boolean(st.flipH);
        studioFlipV = Boolean(st.flipV);
        _studioCropAspect = st.aspect || 'free';
        _studioActivePreset = st.preset || 'original';
        studioCropRect = st.crop ? { ...st.crop } : null;
        studioEraserBoxes = Array.isArray(st.erasers) ? st.erasers.map(b => ({ ...b })) : [];
        studioEraserStrokes = Array.isArray(st.strokes) ? st.strokes.map(s => ({ nr: s.nr, points: (s.points || []).map(p => ({ ...p })) })) : [];
        studioGlareStrokes = Array.isArray(st.glareStrokes) ? st.glareStrokes.map(s => ({ nr: s.nr, points: (s.points || []).map(p => ({ ...p })) })) : [];
        studioRedeyeStrokes = Array.isArray(st.redeyeStrokes) ? st.redeyeStrokes.map(s => ({ nr: s.nr, points: (s.points || []).map(p => ({ ...p })) })) : [];
        studioBlemishStrokes = Array.isArray(st.blemishStrokes) ? st.blemishStrokes.map(s => ({ nr: s.nr, points: (s.points || []).map(p => ({ ...p })) })) : [];
        _studioRetouchUndoOrder = Array.isArray(st.retouchOrder) ? [...st.retouchOrder] : [];
        studioBgRemove = st.bgRemove ? { ...st.bgRemove } : { enabled: false, mode: 'transparent' };
        studioAutoRetouch = st.autoRetouch ? { ...st.autoRetouch } : { enabled: false, strength: 0.65, skin_wrinkles: true, redeye: true, blemish_glare: true };
        studioBorder = st.border ? { ...st.border } : { style: 'none', color: '#ffffff', thickness: 3.0 };
        studioDrawStrokes = Array.isArray(st.drawStrokes) ? st.drawStrokes.map(s => ({ ...s, points: (s.points || []).map(p => ({ ...p })) })) : [];
        studioImageOverlays = Array.isArray(st.overlays) ? st.overlays.map(o => ({ ...o })) : [];
        studioExtraTextLayers = Array.isArray(st.extraTexts) ? st.extraTexts.map(t => ({ ...t })) : [];
        studioExtraClips = Array.isArray(st.extraClips) ? st.extraClips.map(c => ({ ...c })) : [];
        studioAppliedTemplates = Array.isArray(st.appliedTemplates) ? st.appliedTemplates.map(a => ({ ...a })) : [];

        const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
        setVal('st-straighten', String(studioStraighten));
        setVal('st-preset-intensity', st.presetInt ?? '100');
        setVal('st-bright', st.bright ?? '1.0');
        setVal('st-contrast', st.contrast ?? '1.0');
        setVal('st-highlights', st.highlights ?? '0.0');
        setVal('st-shadows', st.shadows ?? '0.0');
        setVal('st-fade', st.fade ?? '0.0');
        setVal('st-sat', st.sat ?? '1.0');
        setVal('st-warmth', st.warmth ?? '0.0');
        setVal('st-tint', st.tint ?? '0.0');
        setVal('st-sharp', st.sharp ?? '1.0');
        setVal('st-grain', st.grain ?? '0.0');
        setVal('st-vignette', st.vignette ?? '0.0');
        setVal('st-text-val', st.textVal ?? '');
        setVal('st-text-color', st.textCol ?? '#ffffff');
        setVal('st-text-bg', st.textBg ?? 'transparent');
        setVal('st-text-size', st.textSize ?? '40');
        setVal('st-text-opacity', st.textOp ?? '1.0');
        setVal('st-text-x', st.textX ?? '5');
        setVal('st-text-y', st.textY ?? '86');
        setVal('st-text-start', st.textStart ?? '0');
        setVal('st-text-end', st.textEnd ?? '0');
        setVal('st-vid-start', st.vidStart ?? '0');
        setVal('st-vid-end', st.vidEnd ?? '0');
        setVal('st-vid-speed', st.vidSpeed ?? '1.0');
        const mu = document.getElementById('st-vid-mute'); if (mu) mu.checked = Boolean(st.vidMute);
        setVal('st-vid-audio', st.vidAudio ?? '');
        setVal('st-audio-mix-mode', st.mixMode ?? 'replace');
        setVal('st-orig-vol', st.origVol ?? '1.0');
        setVal('st-music-vol', st.musicVol ?? '1.0');

        _syncStudioAspectButtonsUI();
        _renderStudioFilterPresetThumbs();
        _applyStudioCropBoxUI();
        _renderStudioEraserBoxes();
        _renderStudioBrushLayers();
        _renderStudioImageOverlaysUI();
        _renderStudioExtraTextListUI();
        _renderStudioExtraClipsUI();
        refreshStudioPhotoStageSource();
        updateStudioLivePreview();
        syncStudioAudioVolumes();
        syncStudioTimelineUI();
        _syncStudioToolsSubUI();
        _syncStudioBorderUI();
        _syncStudioUndoRedoButtons();
        _renderStudioHistoryListUI();
    } catch (_) {}
}

function _syncStudioUndoRedoButtons() {
    const uBtn = document.getElementById('studio-btn-undo');
    const rBtn = document.getElementById('studio-btn-redo');
    if (uBtn) uBtn.classList.toggle('opacity-35', _studioHistoryIdx <= 0);
    if (rBtn) rBtn.classList.toggle('opacity-35', _studioHistoryIdx >= _studioHistory.length - 1);
}

function pushStudioHistorySnapshot() {
    const snap = _captureStudioSnapshot();
    if (_studioHistoryIdx >= 0 && _studioHistory[_studioHistoryIdx] === snap) return;
    _studioHistory = _studioHistory.slice(0, _studioHistoryIdx + 1);
    _studioHistory.push(snap);
    if (_studioHistory.length > 40) _studioHistory.shift();
    _studioHistoryIdx = _studioHistory.length - 1;
    _syncStudioUndoRedoButtons();
}

function studioUndo() {
    if (_studioHistoryIdx <= 0) return;
    _studioHistoryIdx -= 1;
    _restoreStudioSnapshot(_studioHistory[_studioHistoryIdx]);
}

function studioRedo() {
    if (_studioHistoryIdx >= _studioHistory.length - 1) return;
    _studioHistoryIdx += 1;
    _restoreStudioSnapshot(_studioHistory[_studioHistoryIdx]);
}

function toggleStudioDrawerCollapsed(forceOpen = null) {
    const drawer = document.getElementById('studio-tools-drawer');
    if (!drawer) return;
    const hide = forceOpen === null ? !drawer.classList.contains('hidden') : !forceOpen;
    drawer.classList.toggle('hidden', hide);
    if (hide) {
        ['transform', 'tone', 'filter', 'decoration', 'layers', 'tools', 'history'].forEach(t => {
            const btn = document.getElementById(`studio-stab-${t}`);
            if (!btn) return;
            btn.className = t === 'tools'
                ? 'relative w-full py-2 rounded-xl hover:bg-rose-500/20 text-rose-200 opacity-85 flex flex-col items-center justify-center gap-1 text-[10px] font-bold transition cursor-pointer'
                : 'relative w-full py-2 rounded-xl hover:bg-white/15 opacity-75 flex flex-col items-center justify-center gap-1 text-[10px] font-bold transition cursor-pointer';
        });
        setStudioMouseTool('NONE');
    }
}

function selectStudioSidebarTab(tabName, subTab = null) {
    const validTabs = ['transform', 'tone', 'filter', 'decoration', 'layers', 'tools', 'history'];
    const targetTab = validTabs.includes(tabName) ? tabName : 'transform';
    const drawer = document.getElementById('studio-tools-drawer');
    const drawerOpen = drawer && !drawer.classList.contains('hidden');
    if (drawerOpen && targetTab === _studioCurrentTab && !subTab) {
        toggleStudioDrawerCollapsed(false);
        return;
    }

    _studioCurrentTab = targetTab;
    toggleStudioDrawerCollapsed(true);
    const titles = {
        transform: 'Transformation',
        tone: 'Ajuster',
        filter: 'Filtres & Looks',
        decoration: 'Décoration',
        layers: 'Calques',
        tools: 'Outils',
        history: 'Historique',
    };
    const tEl = document.getElementById('studio-drawer-title');
    if (tEl) tEl.textContent = titles[_studioCurrentTab] || 'Outils';

    validTabs.forEach(t => {
        const btn = document.getElementById(`studio-stab-${t}`);
        const pan = document.getElementById(`studio-panel-${t}`);
        const act = t === _studioCurrentTab;
        if (btn) {
            if (t === 'tools') {
                btn.className = act
                    ? 'relative w-full py-2 rounded-xl bg-rose-500/35 text-rose-100 ring-1 ring-rose-300/60 flex flex-col items-center justify-center gap-1 text-[10px] font-bold transition cursor-pointer'
                    : 'relative w-full py-2 rounded-xl hover:bg-rose-500/20 text-rose-200 opacity-85 flex flex-col items-center justify-center gap-1 text-[10px] font-bold transition cursor-pointer';
            } else {
                btn.className = act
                    ? 'relative w-full py-2 rounded-xl bg-white/25 text-white flex flex-col items-center justify-center gap-1 text-[10px] font-bold transition cursor-pointer'
                    : 'relative w-full py-2 rounded-xl hover:bg-white/15 opacity-75 flex flex-col items-center justify-center gap-1 text-[10px] font-bold transition cursor-pointer';
            }
        }
        if (pan) pan.classList.toggle('hidden', !act);
    });

    if (_studioCurrentTab === 'transform') {
        if (!studioCropRect) {
            studioCropRect = { nx: 0.04, ny: 0.04, nw: 0.92, nh: 0.92 };
        }
        _studioCropPreviewOn = false;
        _syncStudioCropPreviewBtn();
        setStudioMouseTool('CROP');
    } else if (_studioCurrentTab === 'decoration') {
        selectStudioDecorationSubtab(subTab || (['draw', 'image', 'text', 'border'].includes(_studioDecorationSubtab) ? _studioDecorationSubtab : 'draw'));
    } else if (_studioCurrentTab === 'layers') {
        setStudioMouseTool('NONE');
        selectStudioLayerSubtab(subTab || _studioLayerSubtab || 'templates');
        loadStudioLibraryBin(_studioLibBinFilter);
        loadStudioLayerTemplates();
        _renderStudioLayersStackUI();
        _renderStudioDraftWatermarksList();
    } else if (_studioCurrentTab === 'tools') {
        selectStudioRetouchTool(_studioRetouchMode);
    } else if (_studioCurrentTab === 'history') {
        setStudioMouseTool('NONE');
        _renderStudioHistoryListUI();
    } else {
        setStudioMouseTool('NONE');
    }
    _applyStudioCropBoxUI();
}

let _studioLayerSubtab = 'templates';

function selectStudioLayerSubtab(sub) {
    _studioLayerSubtab = ['templates', 'create'].includes(sub) ? sub : 'templates';
    ['templates', 'create'].forEach(s => {
        const btn = document.getElementById(`studio-layertab-${s}`);
        const box = document.getElementById(`studio-layersub-${s}`);
        const act = s === _studioLayerSubtab;
        if (btn) {
            btn.className = act
                ? 'py-1.5 rounded-xl bg-white/25 text-white transition cursor-pointer'
                : 'py-1.5 rounded-xl hover:bg-white/15 opacity-75 transition cursor-pointer';
        }
        if (box) box.classList.toggle('hidden', !act);
    });
}

function selectStudioDecorationSubtab(sub) {
    _studioDecorationSubtab = ['draw', 'image', 'text', 'border'].includes(sub) ? sub : 'draw';
    ['draw', 'image', 'text', 'border'].forEach(s => {
        const btn = document.getElementById(`studio-dectab-${s}`);
        const box = document.getElementById(`studio-decsub-${s}`);
        const act = s === _studioDecorationSubtab;
        if (btn) {
            btn.className = act
                ? 'py-1.5 rounded-xl bg-white/25 text-white transition cursor-pointer'
                : 'py-1.5 rounded-xl hover:bg-white/15 opacity-75 transition cursor-pointer';
        }
        if (box) box.classList.toggle('hidden', !act);
    });
    if (_studioDecorationSubtab === 'draw') {
        setStudioMouseTool('BRUSH');
        syncStudioBrushStyleUI();
    } else if (_studioDecorationSubtab === 'image') {
        setStudioMouseTool('NONE');
        loadStudioLibraryBin('IMAGE');
        _renderStudioImageOverlaysUI();
    } else if (_studioDecorationSubtab === 'border') {
        setStudioMouseTool('NONE');
        _syncStudioBorderUI();
    } else {
        setStudioMouseTool('NONE');
        loadStudioSystemFonts();
    }
}

function selectStudioRetouchTool(tool) {
    _studioRetouchMode = ['object', 'bg_remove', 'auto_retouch', 'glare', 'redeye', 'blemish'].includes(tool) ? tool : 'object';
    const isBrushSub = ['glare', 'redeye', 'blemish'].includes(_studioRetouchMode);
    const activeMain = isBrushSub ? 'auto_retouch' : _studioRetouchMode;

    ['object', 'bg_remove', 'auto_retouch'].forEach(m => {
        const b = document.getElementById(`st-rmode-${m}`);
        if (!b) return;
        const act = m === activeMain;
        b.className = act
            ? 'py-2 px-1.5 rounded-xl bg-rose-500/35 text-rose-100 ring-1 ring-rose-300/60 flex flex-col items-center justify-center gap-1 transition cursor-pointer'
            : 'py-2 px-1.5 rounded-xl bg-white/10 hover:bg-white/20 flex flex-col items-center justify-center gap-1 transition cursor-pointer';
    });
    ['glare', 'redeye', 'blemish'].forEach(m => {
        const b = document.getElementById(`st-rmode-${m}`);
        if (!b) return;
        const act = m === _studioRetouchMode;
        b.className = act
            ? 'py-1.5 px-1 rounded-xl bg-emerald-500/35 text-emerald-100 ring-1 ring-emerald-300/60 transition cursor-pointer'
            : 'py-1.5 px-1 rounded-xl bg-white/10 hover:bg-white/20 transition cursor-pointer';
    });

    document.getElementById('studio-tool-object-box')?.classList.toggle('hidden', activeMain !== 'object');
    document.getElementById('studio-tool-bg-box')?.classList.toggle('hidden', activeMain !== 'bg_remove');
    document.getElementById('studio-tool-auto-retouch-box')?.classList.toggle('hidden', activeMain !== 'auto_retouch');
    document.getElementById('studio-eraser-bar')?.classList.toggle('hidden', activeMain === 'bg_remove');

    if (activeMain === 'object') refreshStudioAiInpaintStatus();
    if (activeMain === 'bg_remove') refreshStudioAiBgRemoveStatus();
    _syncStudioToolsSubUI();

    const meta = {
        object: ["Pinceau Effaceur d'objet", "Coloriez l'objet à supprimer : l'IA reconstruit l'arrière-plan automatiquement."],
        bg_remove: ["Suppression d'arrière-plan IA", "Isole le sujet principal automatiquement."],
        auto_retouch: ["Retouche automatique & Pinceaux", "Activez la retouche en 1 clic ci-dessus ou choisissez un pinceau ciblé (Boutons, Yeux rouges, Reflets)."],
        glare: ["Pinceau Effaceur de reflets", "Peignez sur les reflets lumineux ou de vitre : la brillance est atténuée en douceur."],
        redeye: ["Pinceau Yeux rouges", "Passez sur la pupille rouge : correction naturelle tout en gardant l'éclat de l'œil."],
        blemish: ["Pinceau Boutons & défauts", "Tapotez ou peignez une imperfection pour la fondre avec les alentours."],
    };
    const [lbl, help] = meta[_studioRetouchMode] || meta.object;
    const lblEl = document.getElementById('studio-retouch-active-label');
    const helpEl = document.getElementById('studio-retouch-help-text');
    if (lblEl) lblEl.textContent = lbl;
    if (helpEl) helpEl.textContent = help;
    setStudioMouseTool(activeMain === 'bg_remove' ? 'NONE' : 'ERASER');
}

function _syncStudioToolsSubUI() {
    const bgBtn = document.getElementById('st-bg-remove-toggle');
    if (bgBtn) {
        bgBtn.textContent = studioBgRemove.enabled ? 'Arrière-plan supprimé (Désactiver)' : "Supprimer l'arrière-plan par IA";
        bgBtn.className = studioBgRemove.enabled
            ? 'w-full py-2 rounded-xl bg-sky-500 text-black hover:bg-sky-400 text-[11px] font-extrabold transition cursor-pointer'
            : 'w-full py-2 rounded-xl bg-sky-500/25 hover:bg-sky-500/35 text-sky-100 border border-sky-300/35 text-[11px] font-extrabold transition cursor-pointer';
    }
    const bgModeEl = document.getElementById('st-bg-remove-mode');
    if (bgModeEl) bgModeEl.value = studioBgRemove.mode || 'transparent';

    const arBtn = document.getElementById('st-auto-retouch-toggle');
    const arBadge = document.getElementById('st-auto-retouch-state-badge');
    if (arBtn) {
        arBtn.textContent = studioAutoRetouch.enabled ? 'Retouche automatique active (Désactiver)' : 'Lancer la retouche automatique';
        arBtn.className = studioAutoRetouch.enabled
            ? 'w-full py-2 rounded-xl bg-emerald-400 text-black hover:bg-emerald-300 text-[11px] font-extrabold transition cursor-pointer'
            : 'w-full py-2 rounded-xl bg-emerald-500/25 hover:bg-emerald-500/35 text-emerald-100 border border-emerald-300/35 text-[11px] font-extrabold transition cursor-pointer';
    }
    if (arBadge) {
        arBadge.textContent = studioAutoRetouch.enabled ? 'Active' : 'Désactivée';
        arBadge.className = studioAutoRetouch.enabled
            ? 'px-2 py-0.5 rounded-full bg-emerald-400/30 text-emerald-100 text-[9px] font-extrabold'
            : 'px-2 py-0.5 rounded-full bg-white/15 text-[9px] font-extrabold';
    }
    const sEl = document.getElementById('st-auto-retouch-strength');
    const sVal = document.getElementById('st-auto-retouch-strength-val');
    if (sEl) sEl.value = String(studioAutoRetouch.strength ?? 0.65);
    if (sVal) sVal.textContent = `${Math.round((studioAutoRetouch.strength ?? 0.65) * 100)}%`;
    const cSkin = document.getElementById('st-auto-retouch-skin');
    const cRed = document.getElementById('st-auto-retouch-redeye');
    const cBlem = document.getElementById('st-auto-retouch-blemish');
    if (cSkin) cSkin.checked = studioAutoRetouch.skin_wrinkles !== false;
    if (cRed) cRed.checked = studioAutoRetouch.redeye !== false;
    if (cBlem) cBlem.checked = studioAutoRetouch.blemish_glare !== false;
}

async function refreshStudioAiBgRemoveStatus() {
    try {
        const res = await fetch('/api/studio/ai_bg_remove/status');
        if (!res.ok) return;
        const st = await res.json();
        const badge = document.getElementById('studio-ai-bg-badge');
        const desc = document.getElementById('studio-ai-bg-desc');
        const instBtn = document.getElementById('studio-ai-bg-install-btn');
        if (badge) {
            badge.textContent = st.installed ? `Prêt (${st.device_label || 'ONNX'})` : (st.installing ? 'Téléchargement...' : 'Repli OpenCV');
        }
        if (desc && st.error) desc.textContent = `Erreur : ${st.error}`;
        if (instBtn) instBtn.classList.toggle('hidden', Boolean(st.installed || st.installing));
    } catch (_) {}
}

async function installStudioBgRemoveModel() {
    try {
        const btn = document.getElementById('studio-ai-bg-install-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Téléchargement en cours...'; }
        await fetch('/api/studio/ai_bg_remove/install', { method: 'POST' });
        setTimeout(refreshStudioAiBgRemoveStatus, 1800);
    } catch (_) {}
}

function toggleStudioBgRemove() {
    studioBgRemove.enabled = !studioBgRemove.enabled;
    studioBgRemove.mode = document.getElementById('st-bg-remove-mode')?.value || 'transparent';
    _syncStudioToolsSubUI();
    refreshStudioPhotoStageSource();
    updateStudioLivePreview(true);
}

function onStudioBgRemoveModeChange() {
    studioBgRemove.mode = document.getElementById('st-bg-remove-mode')?.value || 'transparent';
    if (studioBgRemove.enabled) {
        refreshStudioPhotoStageSource();
        updateStudioLivePreview(true);
    }
}

function toggleStudioAutoRetouch() {
    studioAutoRetouch.enabled = !studioAutoRetouch.enabled;
    _syncStudioToolsSubUI();
    refreshStudioPhotoStageSource();
    updateStudioLivePreview(true);
}

function onStudioAutoRetouchChange(recordHistory = false) {
    studioAutoRetouch.strength = parseFloat(document.getElementById('st-auto-retouch-strength')?.value || '0.65') || 0.65;
    studioAutoRetouch.skin_wrinkles = Boolean(document.getElementById('st-auto-retouch-skin')?.checked);
    studioAutoRetouch.redeye = Boolean(document.getElementById('st-auto-retouch-redeye')?.checked);
    studioAutoRetouch.blemish_glare = Boolean(document.getElementById('st-auto-retouch-blemish')?.checked);
    _syncStudioToolsSubUI();
    if (studioAutoRetouch.enabled) {
        refreshStudioPhotoStageSource();
        updateStudioLivePreview(recordHistory);
    }
}

function setStudioMouseTool(t) {
    studioMouseTool = ['NONE', 'CROP', 'BRUSH', 'ERASER'].includes(t) ? t : 'NONE';
    const bNone = document.getElementById('studio-tool-NONE');
    if (bNone) {
        bNone.className = studioMouseTool === 'NONE'
            ? 'w-full py-1.5 rounded-xl bg-white/25 text-white flex flex-col items-center justify-center gap-0.5 text-[9px] font-bold transition cursor-pointer'
            : 'w-full py-1.5 rounded-xl hover:bg-white/15 opacity-70 flex flex-col items-center justify-center gap-0.5 text-[9px] font-bold transition cursor-pointer';
    }
    const bCrop = document.getElementById('studio-tool-CROP');
    if (bCrop) {
        bCrop.className = studioMouseTool === 'CROP'
            ? 'py-1.5 rounded-xl bg-white/25 text-white transition cursor-pointer'
            : 'py-1.5 rounded-xl bg-white/10 hover:bg-white/20 opacity-80 transition cursor-pointer';
    }
    const st = document.getElementById('studio-stage');
    const usesBrushCursor = studioMouseTool === 'ERASER' || studioMouseTool === 'BRUSH';
    if (st) {
        st.style.cursor = usesBrushCursor
            ? 'none'
            : (studioMouseTool === 'CROP' ? 'crosshair' : 'default');
    }
    const curEl = document.getElementById('studio-eraser-cursor');
    if (curEl && !usesBrushCursor) curEl.classList.add('hidden');
    if (studioMouseTool === 'CROP' && !studioCropRect) {
        studioCropRect = { nx: 0.04, ny: 0.04, nw: 0.92, nh: 0.92 };
    }
    if (usesBrushCursor) syncStudioEraserCursorSize();
    _applyStudioCropBoxUI();
}

function syncStudioEraserCursorSize() {
    const isBrush = studioMouseTool === 'BRUSH';
    const px = Number(document.getElementById(isBrush ? 'st-brush-size' : 'st-eraser-size')?.value || (isBrush ? 16 : 24));
    const ePx = Number(document.getElementById('st-eraser-size')?.value || 24);
    const lbl = document.getElementById('st-eraser-size-val');
    if (lbl) lbl.textContent = `${ePx}px`;
    const curEl = document.getElementById('studio-eraser-cursor');
    if (curEl) {
        const displayPx = Math.max(6, Math.round(px * (isBrush && _studioBrushMode === 'pen' ? 0.55 : (isBrush && _studioBrushMode === 'highlighter' ? 1.35 : 1))));
        curEl.style.width = `${displayPx}px`;
        curEl.style.height = `${displayPx}px`;
        if (isBrush) {
            if (_studioBrushMode === 'stroke_eraser') {
                curEl.style.borderColor = '#fb7185';
                curEl.style.background = 'rgba(251, 113, 133, 0.25)';
                curEl.style.borderStyle = 'dashed';
            } else if (_studioBrushMode === 'blur') {
                curEl.style.borderColor = '#38bdf8';
                curEl.style.background = 'rgba(56, 189, 248, 0.22)';
                curEl.style.borderStyle = 'dashed';
            } else {
                curEl.style.borderColor = _studioBrushColor || '#f43f5e';
                curEl.style.background = 'rgba(255, 255, 255, 0.14)';
                curEl.style.borderStyle = 'solid';
            }
        } else if (_studioRetouchMode === 'glare') {
            curEl.style.borderColor = '#38bdf8';
            curEl.style.background = 'rgba(56, 189, 248, 0.22)';
            curEl.style.borderStyle = 'solid';
        } else if (_studioRetouchMode === 'redeye') {
            curEl.style.borderColor = '#fbbf24';
            curEl.style.background = 'rgba(251, 191, 36, 0.24)';
            curEl.style.borderStyle = 'solid';
        } else if (_studioRetouchMode === 'blemish') {
            curEl.style.borderColor = '#34d399';
            curEl.style.background = 'rgba(52, 211, 153, 0.22)';
            curEl.style.borderStyle = 'solid';
        } else {
            curEl.style.borderColor = 'rgba(253, 164, 175, 0.95)';
            curEl.style.background = 'rgba(244, 63, 94, 0.25)';
            curEl.style.borderStyle = 'solid';
        }
    }
}

// ==================== PINCEAU, STYLO, SURLIGNEUR, FLOUTAGE & EFFACEUR IA ====================

let _studioBrushBlurStyle = 'blur';
let _studioBrushShape = 'circle';

function setStudioBlurStyle(style) {
    _studioBrushBlurStyle = style === 'pixelate' ? 'pixelate' : 'blur';
    ['blur', 'pixelate'].forEach(s => {
        const b = document.getElementById(`st-blurstyle-${s}`);
        if (!b) return;
        b.className = s === _studioBrushBlurStyle
            ? 'py-1.5 rounded-xl bg-white/25 text-white transition cursor-pointer'
            : 'py-1.5 rounded-xl bg-white/10 hover:bg-white/20 transition cursor-pointer';
    });
    syncStudioEraserCursorSize();
}

function setStudioBrushShape(shape) {
    _studioBrushShape = ['circle', 'rect', 'triangle', 'arrow', 'line', 'star'].includes(shape) ? shape : 'circle';
    ['circle', 'rect', 'triangle', 'arrow', 'line', 'star'].forEach(s => {
        const b = document.getElementById(`st-shape-${s}`);
        if (!b) return;
        b.className = s === _studioBrushShape
            ? 'py-1.5 rounded-lg bg-white/25 text-white cursor-pointer'
            : 'py-1.5 rounded-lg bg-white/10 hover:bg-white/20 cursor-pointer';
    });
}

function selectStudioImageSource(src) {
    const mode = src === 'pc' ? 'pc' : 'gallery';
    const bGal = document.getElementById('st-imgsrc-gallery');
    const bPc = document.getElementById('st-imgsrc-pc');
    if (bGal) bGal.className = mode === 'gallery' ? 'py-1.5 rounded-lg bg-white/25 text-white transition cursor-pointer' : 'py-1.5 rounded-lg hover:bg-white/15 opacity-75 transition cursor-pointer';
    if (bPc) bPc.className = mode === 'pc' ? 'py-1.5 rounded-lg bg-white/25 text-white transition cursor-pointer' : 'py-1.5 rounded-lg hover:bg-white/15 opacity-75 transition cursor-pointer';
    document.getElementById('studio-dec-gallery-wrap')?.classList.toggle('hidden', mode !== 'gallery');
    document.getElementById('studio-dec-pc-wrap')?.classList.toggle('hidden', mode !== 'pc');
    if (mode === 'gallery') loadStudioLibraryBin('IMAGE');
}

function selectStudioBrushMode(mode) {
    _studioBrushMode = ['brush', 'pen', 'highlighter', 'blur', 'shape', 'stroke_eraser'].includes(mode) ? mode : 'brush';
    ['brush', 'pen', 'highlighter', 'blur', 'shape', 'stroke_eraser'].forEach(m => {
        const b = document.getElementById(`st-bmode-${m}`);
        if (!b) return;
        const act = m === _studioBrushMode;
        if (m === 'stroke_eraser') {
            b.className = act
                ? 'py-2 px-1 rounded-xl bg-rose-500/45 text-white ring-1 ring-rose-300/70 flex flex-col items-center justify-center gap-1 transition cursor-pointer'
                : 'py-2 px-1 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 flex flex-col items-center justify-center gap-1 transition cursor-pointer';
        } else {
            b.className = act
                ? 'py-2 px-1 rounded-xl bg-white/25 text-white font-bold ring-1 ring-white/40 flex flex-col items-center justify-center gap-1 transition cursor-pointer'
                : 'py-2 px-1 rounded-xl bg-white/10 hover:bg-white/20 flex flex-col items-center justify-center gap-1 transition cursor-pointer';
        }
    });
    document.getElementById('studio-brush-blur-style-row')?.classList.toggle('hidden', _studioBrushMode !== 'blur');
    document.getElementById('studio-brush-shape-row')?.classList.toggle('hidden', _studioBrushMode !== 'shape');
    const colorRow = document.getElementById('studio-brush-color-row');
    const opRow = document.getElementById('studio-brush-opacity-row');
    const needsColor = ['brush', 'pen', 'highlighter', 'shape'].includes(_studioBrushMode);
    if (colorRow) colorRow.classList.toggle('hidden', !needsColor);
    if (opRow) opRow.classList.toggle('hidden', !needsColor);
    if (studioMouseTool !== 'BRUSH') setStudioMouseTool('BRUSH');
    syncStudioBrushStyleUI();
}

function setStudioBrushColor(hex) {
    _studioBrushColor = hex || '#f43f5e';
    const inp = document.getElementById('st-brush-color');
    if (inp) inp.value = _studioBrushColor;
    syncStudioBrushStyleUI();
}

function setStudioTextColor(hex) {
    const inp = document.getElementById('st-text-color');
    if (inp) inp.value = hex || '#ffffff';
    updateStudioLivePreview(true);
}

function setStudioBorderColor(hex) {
    studioBorder.color = hex || '#ffffff';
    const inp = document.getElementById('st-border-color');
    if (inp) inp.value = studioBorder.color;
    _syncStudioBorderUI();
    updateStudioLivePreview(true);
}

async function pickStudioColorWithPipette(target = 'brush') {
    if (typeof window.EyeDropper === 'function') {
        try {
            const ed = new window.EyeDropper();
            const res = await ed.open();
            if (res && res.sRGBHex) {
                if (target === 'text') setStudioTextColor(res.sRGBHex);
                else if (target === 'border') setStudioBorderColor(res.sRGBHex);
                else setStudioBrushColor(res.sRGBHex);
                return;
            }
        } catch (_) {
            return;
        }
    }
    if (typeof showAppToast === 'function') {
        showAppToast('Pipette non supportée par ce navigateur ; utilisez le sélecteur rond.', 'info');
    }
}

function stepStudioSlider(sliderId, delta, cb) {
    const sl = document.getElementById(sliderId);
    if (!sl) return;
    const min = parseFloat(sl.min || '0');
    const max = parseFloat(sl.max || '100');
    const cur = parseFloat(sl.value || String(min)) || 0;
    const next = Math.max(min, Math.min(max, Number((cur + delta).toFixed(2))));
    sl.value = String(next);
    if (typeof cb === 'function') cb();
}

function syncStudioNumberToSlider(numId, sliderId, cb) {
    const numEl = document.getElementById(numId);
    const sl = document.getElementById(sliderId);
    if (!numEl || !sl) return;
    const min = parseFloat(sl.min || '0');
    const max = parseFloat(sl.max || '100');
    const val = Math.max(min, Math.min(max, parseFloat(numEl.value || String(min)) || min));
    sl.value = String(val);
    if (typeof cb === 'function') cb();
}

function syncStudioOpacityNumToSlider(numId, sliderId, cb) {
    const numEl = document.getElementById(numId);
    const sl = document.getElementById(sliderId);
    if (!numEl || !sl) return;
    const pct = Math.max(10, Math.min(100, parseFloat(numEl.value || '100') || 100));
    sl.value = String(Number((pct / 100).toFixed(2)));
    if (typeof cb === 'function') cb();
}

function syncStudioBrushStyleUI() {
    const colEl = document.getElementById('st-brush-color');
    if (colEl && colEl.value) _studioBrushColor = colEl.value;
    const szEl = document.getElementById('st-brush-size');
    const szNum = document.getElementById('st-brush-size-num');
    if (szNum && szEl) szNum.value = szEl.value;
    const opEl = document.getElementById('st-brush-opacity');
    const opNum = document.getElementById('st-brush-opacity-num');
    if (opNum && opEl) opNum.value = String(Math.round(parseFloat(opEl.value || '1') * 100));
    syncStudioEraserCursorSize();
}

function _hexToRgba(hex, alpha) {
    const clean = (hex || '#f43f5e').replace('#', '');
    const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean.padEnd(6, '0').slice(0, 6);
    const n = parseInt(full, 16) || 0;
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return `rgba(${r}, ${g}, ${b}, ${Math.max(0.02, Math.min(1, Number(alpha ?? 1))).toFixed(2)})`;
}

function _paintBrushStrokeListToContexts(drawCtx, maskCtx, w, h, strokes, pixelMaskCtx = null) {
    let hasDraw = false;
    let hasBlur = false;
    let hasPixel = false;
    const refDim = Math.max(1, w, h);
    strokes.forEach(st => {
        const pts = st.points || [];
        if (!pts.length) return;
        const baseLw = Math.max(2, Number(st.nr || 0.015) * refDim * 2);
        const drawSinglePath = (ctx) => {
            ctx.beginPath();
            pts.forEach((p, idx) => {
                const px = p.nx * w, py = p.ny * h;
                if (idx === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            });
            if (pts.length === 1) {
                ctx.lineTo(pts[0].nx * w + 0.1, pts[0].ny * h + 0.1);
            }
            ctx.stroke();
        };

        if (st.mode === 'stroke_eraser') {
            [drawCtx, maskCtx, pixelMaskCtx].forEach(ctx => {
                if (!ctx) return;
                ctx.save();
                ctx.globalCompositeOperation = 'destination-out';
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.lineWidth = Math.max(4, baseLw);
                ctx.strokeStyle = 'rgba(0, 0, 0, 1)';
                drawSinglePath(ctx);
                ctx.restore();
            });
        } else if (st.mode === 'blur') {
            hasBlur = true;
            if (maskCtx) {
                maskCtx.save();
                maskCtx.globalCompositeOperation = 'source-over';
                maskCtx.lineCap = 'round';
                maskCtx.lineJoin = 'round';
                maskCtx.lineWidth = Math.max(6, baseLw);
                maskCtx.strokeStyle = '#ffffff';
                drawSinglePath(maskCtx);
                maskCtx.restore();
            }
        } else if (st.mode === 'pixelate') {
            hasPixel = true;
            if (pixelMaskCtx) {
                pixelMaskCtx.save();
                pixelMaskCtx.globalCompositeOperation = 'source-over';
                pixelMaskCtx.lineCap = 'round';
                pixelMaskCtx.lineJoin = 'round';
                pixelMaskCtx.lineWidth = Math.max(6, baseLw);
                pixelMaskCtx.strokeStyle = '#ffffff';
                drawSinglePath(pixelMaskCtx);
                pixelMaskCtx.restore();
            }
        } else if (st.mode === 'shape' && drawCtx) {
            hasDraw = true;
            const p0 = pts[0], p1 = pts[pts.length - 1];
            const x0 = p0.nx * w, y0 = p0.ny * h, x1 = p1.nx * w, y1 = p1.ny * h;
            const minX = Math.min(x0, x1), minY = Math.min(y0, y1), bw = Math.abs(x1 - x0), bh = Math.abs(y1 - y0);
            const colRgba = _hexToRgba(st.color || '#f43f5e', Number(st.opacity ?? 1));
            drawCtx.save();
            drawCtx.globalCompositeOperation = 'source-over';
            drawCtx.lineCap = 'round';
            drawCtx.lineJoin = 'round';
            drawCtx.lineWidth = Math.max(2, baseLw);
            drawCtx.strokeStyle = colRgba;
            drawCtx.fillStyle = colRgba;
            drawCtx.beginPath();
            if (st.shape === 'rect') {
                drawCtx.rect(minX, minY, bw, bh);
            } else if (st.shape === 'triangle') {
                drawCtx.moveTo((minX + minX + bw) * 0.5, minY);
                drawCtx.lineTo(minX + bw, minY + bh);
                drawCtx.lineTo(minX, minY + bh);
                drawCtx.closePath();
            } else if (st.shape === 'line') {
                drawCtx.moveTo(x0, y0);
                drawCtx.lineTo(x1, y1);
            } else if (st.shape === 'arrow') {
                drawCtx.moveTo(x0, y0);
                drawCtx.lineTo(x1, y1);
                const ang = Math.atan2(y1 - y0, x1 - x0);
                const head = Math.max(10, baseLw * 2.4);
                drawCtx.lineTo(x1 - head * Math.cos(ang - Math.PI / 6), y1 - head * Math.sin(ang - Math.PI / 6));
                drawCtx.moveTo(x1, y1);
                drawCtx.lineTo(x1 - head * Math.cos(ang + Math.PI / 6), y1 - head * Math.sin(ang + Math.PI / 6));
            } else if (st.shape === 'star') {
                const cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5;
                const rx = Math.max(4, bw * 0.5), ry = Math.max(4, bh * 0.5);
                for (let i = 0; i < 10; i++) {
                    const a = -Math.PI / 2 + (i * Math.PI) / 5;
                    const k = i % 2 === 0 ? 1 : 0.44;
                    const px = cx + Math.cos(a) * rx * k, py = cy + Math.sin(a) * ry * k;
                    if (i === 0) drawCtx.moveTo(px, py); else drawCtx.lineTo(px, py);
                }
                drawCtx.closePath();
            } else {
                drawCtx.ellipse((x0 + x1) * 0.5, (y0 + y1) * 0.5, Math.max(2, bw * 0.5), Math.max(2, bh * 0.5), 0, 0, Math.PI * 2);
            }
            if (st.fill && st.shape !== 'line' && st.shape !== 'arrow') drawCtx.fill();
            else drawCtx.stroke();
            drawCtx.restore();
        } else if (drawCtx) {
            hasDraw = true;
            const lw = st.mode === 'pen'
                ? Math.max(1.5, baseLw * 0.55)
                : (st.mode === 'highlighter' ? Math.max(6, baseLw * 1.35) : baseLw);
            const alpha = st.mode === 'highlighter'
                ? Math.min(0.48, Number(st.opacity ?? 1) * 0.42)
                : Number(st.opacity ?? 1);
            drawCtx.save();
            drawCtx.globalCompositeOperation = 'source-over';
            drawCtx.lineCap = 'round';
            drawCtx.lineJoin = 'round';
            drawCtx.lineWidth = lw;
            drawCtx.strokeStyle = _hexToRgba(st.color || '#f43f5e', alpha);
            drawSinglePath(drawCtx);
            drawCtx.restore();
        }
    });
    return { hasDraw, hasBlur, hasPixel };
}

let studioDrawLayerHidden = false;

function _renderStudioBrushLayers() {
    const drawCv = document.getElementById('studio-draw-canvas');
    const blurCv = document.getElementById('studio-blur-canvas');
    const pixelCv = document.getElementById('studio-pixel-canvas');
    if (!drawCv || !stStage) return;

    const strokes = _studioActiveDrawStroke ? [...studioDrawStrokes, _studioActiveDrawStroke] : studioDrawStrokes;
    if (_studioCompareOrig || studioDrawLayerHidden || !strokes.length) {
        drawCv.classList.add('hidden');
        if (blurCv) blurCv.classList.add('hidden');
        if (pixelCv) pixelCv.classList.add('hidden');
        syncStudioTabBadges();
        return;
    }

    const w = Math.max(1, stStage.clientWidth || Math.round(stStage.getBoundingClientRect().width));
    const h = Math.max(1, stStage.clientHeight || Math.round(stStage.getBoundingClientRect().height));
    if (drawCv.width !== w || drawCv.height !== h) {
        drawCv.width = w;
        drawCv.height = h;
    }
    const drawCtx = drawCv.getContext('2d');
    if (drawCtx) drawCtx.clearRect(0, 0, w, h);

    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = w;
    maskCanvas.height = h;
    const maskCtx = maskCanvas.getContext('2d');

    const pixelMaskCanvas = document.createElement('canvas');
    pixelMaskCanvas.width = w;
    pixelMaskCanvas.height = h;
    const pixelMaskCtx = pixelMaskCanvas.getContext('2d');

    const { hasDraw, hasBlur, hasPixel } = _paintBrushStrokeListToContexts(drawCtx, maskCtx, w, h, strokes, pixelMaskCtx);
    drawCv.classList.toggle('hidden', !hasDraw);

    const srcEl = studioIsVideo ? document.getElementById('studio-video') : document.getElementById('studio-img');
    const ready = studioIsVideo
        ? (srcEl && srcEl.videoWidth > 0)
        : (srcEl && srcEl.complete && srcEl.naturalWidth > 0);

    if (blurCv) {
        if (!hasBlur || !ready) {
            blurCv.classList.add('hidden');
        } else {
            if (blurCv.width !== w || blurCv.height !== h) {
                blurCv.width = w;
                blurCv.height = h;
            }
            const bCtx = blurCv.getContext('2d');
            if (bCtx) {
                bCtx.clearRect(0, 0, w, h);
                bCtx.save();
                const baseFilter = (srcEl.style.filter && srcEl.style.filter !== 'none') ? `${srcEl.style.filter} ` : '';
                bCtx.filter = `${baseFilter}blur(16px)`;
                bCtx.drawImage(srcEl, 0, 0, w, h);
                bCtx.restore();
                bCtx.save();
                bCtx.globalCompositeOperation = 'destination-in';
                bCtx.drawImage(maskCanvas, 0, 0, w, h);
                bCtx.restore();
                blurCv.classList.remove('hidden');
            } else {
                blurCv.classList.add('hidden');
            }
        }
    }

    if (pixelCv) {
        if (!hasPixel || !ready) {
            pixelCv.classList.add('hidden');
        } else {
            if (pixelCv.width !== w || pixelCv.height !== h) {
                pixelCv.width = w;
                pixelCv.height = h;
            }
            const pCtx = pixelCv.getContext('2d');
            if (pCtx) {
                const block = Math.max(8, Math.round(Math.max(w, h) / 48));
                const tw = Math.max(1, Math.floor(w / block));
                const th = Math.max(1, Math.floor(h / block));
                const tiny = document.createElement('canvas');
                tiny.width = tw;
                tiny.height = th;
                const tCtx = tiny.getContext('2d');
                if (tCtx) tCtx.drawImage(srcEl, 0, 0, tw, th);
                pCtx.clearRect(0, 0, w, h);
                pCtx.save();
                pCtx.imageSmoothingEnabled = false;
                pCtx.drawImage(tiny, 0, 0, tw, th, 0, 0, w, h);
                pCtx.restore();
                pCtx.save();
                pCtx.globalCompositeOperation = 'destination-in';
                pCtx.drawImage(pixelMaskCanvas, 0, 0, w, h);
                pCtx.restore();
                pixelCv.classList.remove('hidden');
            } else {
                pixelCv.classList.add('hidden');
            }
        }
    }
    _renderStudioShapesOverlay();
    syncStudioTabBadges();
}

function removeStudioShapeStroke(idx) {
    studioDrawStrokes.splice(idx, 1);
    _renderStudioBrushLayers();
    pushStudioHistorySnapshot();
}

function _renderStudioShapesOverlay() {
    const layer = document.getElementById('studio-shapes-layer');
    if (!layer) return;
    if (_studioCompareOrig || studioDrawLayerHidden || !studioDrawStrokes.length) {
        layer.innerHTML = '';
        return;
    }
    const items = [];
    studioDrawStrokes.forEach((st, idx) => {
        if (st.mode !== 'shape' || !st.points || st.points.length < 2) return;
        const p0 = st.points[0], p1 = st.points[st.points.length - 1];
        const minX = Math.min(p0.nx, p1.nx), minY = Math.min(p0.ny, p1.ny);
        const w = Math.max(0.02, Math.abs(p1.nx - p0.nx));
        const h = Math.max(0.02, Math.abs(p1.ny - p0.ny));
        items.push(`
            <div data-shape-idx="${idx}" title="Glisser pour déplacer la forme"
                 style="left:${(minX * 100).toFixed(2)}%;top:${(minY * 100).toFixed(2)}%;width:${(w * 100).toFixed(2)}%;height:${(h * 100).toFixed(2)}%;"
                 class="pointer-events-auto absolute group border border-dashed border-transparent hover:border-sky-300/80 cursor-move rounded-sm">
                <button type="button" onclick="event.stopPropagation(); removeStudioShapeStroke(${idx})" title="Supprimer cette forme"
                        class="opacity-0 group-hover:opacity-100 absolute -top-2.5 -right-2.5 w-4 h-4 rounded-full bg-rose-500 text-white text-[10px] leading-none flex items-center justify-center shadow cursor-pointer">×</button>
                <div data-shape-resize="${idx}" title="Redimensionner la forme"
                     class="opacity-0 group-hover:opacity-100 absolute -bottom-1.5 -right-1.5 w-3.5 h-3.5 rounded-full bg-sky-400 border border-black cursor-nwse-resize"></div>
            </div>
        `);
    });
    layer.innerHTML = items.join('');
}

function undoStudioBrushStep() {
    if (!studioDrawStrokes.length) return;
    studioDrawStrokes.pop();
    _renderStudioBrushLayers();
    pushStudioHistorySnapshot();
}

function clearStudioBrushLayers() {
    studioDrawStrokes = [];
    _studioActiveDrawStroke = null;
    _renderStudioBrushLayers();
    pushStudioHistorySnapshot();
}

function _exportStudioBrushPayloads() {
    if (studioDrawLayerHidden || !studioDrawStrokes.length) {
        return { draw_layer_png: null, blur_mask_png: null, blur_strokes: [], pixel_mask_png: null, pixel_strokes: [] };
    }
    const [rawW, rawH] = _getNaturalStageDimensions();
    const natW = Math.max(1, rawW || stStage?.clientWidth || 1200);
    const natH = Math.max(1, rawH || stStage?.clientHeight || 900);
    const scale = Math.min(1, 1920 / Math.max(natW, natH));
    const w = Math.max(1, Math.round(natW * scale));
    const h = Math.max(1, Math.round(natH * scale));

    const drawCv = document.createElement('canvas');
    drawCv.width = w;
    drawCv.height = h;
    const drawCtx = drawCv.getContext('2d');

    const maskCv = document.createElement('canvas');
    maskCv.width = w;
    maskCv.height = h;
    const maskCtx = maskCv.getContext('2d');

    const pixelMaskCv = document.createElement('canvas');
    pixelMaskCv.width = w;
    pixelMaskCv.height = h;
    const pixelMaskCtx = pixelMaskCv.getContext('2d');

    const { hasDraw, hasBlur, hasPixel } = _paintBrushStrokeListToContexts(drawCtx, maskCtx, w, h, studioDrawStrokes, pixelMaskCtx);

    const hasPixels = (ctx) => {
        if (!ctx) return false;
        const data = ctx.getImageData(0, 0, w, h).data;
        for (let i = 3; i < data.length; i += 4) {
            if (data[i] > 4) return true;
        }
        return false;
    };

    const drawPng = (hasDraw && hasPixels(drawCtx)) ? drawCv.toDataURL('image/png') : null;
    const blurMaskPng = (!studioIsVideo && hasBlur && hasPixels(maskCtx)) ? maskCv.toDataURL('image/png') : null;
    const pixelMaskPng = (!studioIsVideo && hasPixel && hasPixels(pixelMaskCtx)) ? pixelMaskCv.toDataURL('image/png') : null;
    const blurStrokes = studioDrawStrokes
        .filter(s => s.mode === 'blur')
        .map(s => ({ nr: s.nr, points: s.points }));
    const pixelStrokes = studioDrawStrokes
        .filter(s => s.mode === 'pixelate')
        .map(s => ({ nr: s.nr, points: s.points }));

    return {
        draw_layer_png: drawPng,
        blur_mask_png: blurMaskPng,
        blur_strokes: blurStrokes,
        pixel_mask_png: pixelMaskPng,
        pixel_strokes: pixelStrokes,
    };
}

async function refreshStudioAiInpaintStatus() {
    const badge = document.getElementById('studio-ai-inpaint-badge');
    const desc = document.getElementById('studio-ai-inpaint-desc');
    const btn = document.getElementById('studio-ai-inpaint-install-btn');
    if (!badge && !desc && !btn) return;
    try {
        const res = await fetch('/api/studio/ai_inpaint/status');
        if (!res.ok) return;
        const d = await res.json();
        if (d.installed) {
            if (badge) {
                badge.textContent = `LaMa IA actif (${d.device_label || 'ONNX'})`;
                badge.className = 'px-2 py-0.5 rounded-full bg-emerald-500/30 text-emerald-100 text-[9px] font-extrabold';
            }
            if (desc) desc.textContent = `Réseau neuronal ${d.model_name || 'LaMa ONNX'} prêt (${d.size_mb || 200} Mo). Effacement haute précision actif.`;
            if (btn) btn.classList.add('hidden');
            if (_studioAiInstallTimer) { clearInterval(_studioAiInstallTimer); _studioAiInstallTimer = null; }
        } else if (d.installing) {
            if (badge) {
                badge.textContent = 'Téléchargement...';
                badge.className = 'px-2 py-0.5 rounded-full bg-amber-500/30 text-amber-100 text-[9px] font-extrabold';
            }
            if (desc) desc.textContent = 'Téléchargement du modèle LaMa ONNX (~200 Mo) depuis HuggingFace en cours…';
            if (btn) {
                btn.disabled = true;
                btn.textContent = 'Téléchargement en cours...';
                btn.classList.remove('hidden');
            }
            if (!_studioAiInstallTimer) {
                _studioAiInstallTimer = setInterval(refreshStudioAiInpaintStatus, 1500);
            }
        } else {
            if (_studioAiInstallTimer) { clearInterval(_studioAiInstallTimer); _studioAiInstallTimer = null; }
            if (badge) {
                badge.textContent = d.error ? 'Erreur téléchargement' : 'Mode secours (OpenCV)';
                badge.className = d.error
                    ? 'px-2 py-0.5 rounded-full bg-rose-500/30 text-rose-100 text-[9px] font-extrabold'
                    : 'px-2 py-0.5 rounded-full bg-white/15 text-white/80 text-[9px] font-extrabold';
            }
            if (desc) {
                desc.textContent = d.error
                    ? `Échec installation IA : ${d.error}`
                    : "Téléchargez le modèle LaMa ONNX (~200 Mo) pour une reconstruction neuronale réaliste (100% hors-ligne après installation).";
            }
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Installer le modèle IA LaMa (~200 Mo)';
                btn.classList.remove('hidden');
            }
        }
    } catch (_) {}
}

async function installStudioAiInpaintModel() {
    const btn = document.getElementById('studio-ai-inpaint-install-btn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Lancement...';
    }
    try {
        await fetch('/api/studio/ai_inpaint/install', { method: 'POST' });
    } catch (_) {}
    refreshStudioAiInpaintStatus();
}

function toggleStudioEraserMasksOverlay() {
    _studioShowEraserMasks = !_studioShowEraserMasks;
    const btn = document.getElementById('studio-eraser-masks-btn');
    if (btn) btn.classList.toggle('bg-rose-500/35', _studioShowEraserMasks);
    _renderStudioEraserBoxes();
}

function cycleStudioGridOverlay() {
    _studioGridMode = _studioGridMode ? 0 : 1;
    const grid = document.getElementById('studio-stage-grid');
    const btn = document.getElementById('studio-btn-grid');
    if (grid) grid.classList.toggle('hidden', !_studioGridMode);
    if (btn) btn.classList.toggle('bg-white/25', Boolean(_studioGridMode));
}

function toggleStudioSplitCompare() {
    if (studioIsVideo) {
        setStudioCompareOriginal(!_studioCompareOrig);
        return;
    }
    _studioSplitCompare = !_studioSplitCompare;
    const btn = document.getElementById('studio-btn-split');
    if (btn) btn.classList.toggle('bg-white/25', _studioSplitCompare);
    _syncStudioSplitCompareUI();
}

function _syncStudioSplitCompareUI() {
    const origImg = document.getElementById('studio-split-orig-img');
    const divEl = document.getElementById('studio-split-divider');
    const active = _studioSplitCompare && !studioIsVideo && Boolean(_studioOrigMediaUrl);
    if (!origImg || !divEl) return;
    if (!active) {
        origImg.classList.add('hidden');
        divEl.classList.add('hidden');
        return;
    }
    if (origImg.src !== _studioOrigMediaUrl) origImg.src = _studioOrigMediaUrl;
    origImg.style.transform = studioRotation || studioFlipH || studioFlipV || Math.abs(studioStraighten) >= 0.1
        ? `rotate(${studioRotation + studioStraighten}deg) scale(${studioFlipH ? -1 : 1}, ${studioFlipV ? -1 : 1})`
        : 'none';
    const pct = Math.max(4, Math.min(96, _studioSplitPct));
    origImg.style.clipPath = `inset(0 ${(100 - pct).toFixed(1)}% 0 0)`;
    divEl.style.left = `${pct}%`;
    origImg.classList.remove('hidden');
    divEl.classList.remove('hidden');
}

function adjustStudioZoom(delta) {
    _studioZoomScale = Math.max(0.5, Math.min(3.5, Number((_studioZoomScale + delta).toFixed(2))));
    if (_studioZoomScale <= 1.01) {
        _studioPanX = 0;
        _studioPanY = 0;
    }
    const wrap = document.getElementById('studio-zoom-wrap');
    const lbl = document.getElementById('studio-zoom-label');
    if (wrap) wrap.style.transform = `translate(${_studioPanX}px, ${_studioPanY}px) scale(${_studioZoomScale})`;
    if (lbl) lbl.textContent = `${Math.round(_studioZoomScale * 100)}%`;
}

function resetStudioZoom() {
    _studioZoomScale = 1;
    _studioPanX = 0;
    _studioPanY = 0;
    adjustStudioZoom(0);
}

function resetStudioSection(sectionName) {
    const setV = (id, v) => { const el = document.getElementById(id); if (el) el.value = String(v); };
    if (sectionName === 'light') {
        setV('st-bright', '1.0');
        setV('st-contrast', '1.0');
        setV('st-highlights', '0.0');
        setV('st-shadows', '0.0');
        setV('st-fade', '0.0');
    } else if (sectionName === 'color') {
        setV('st-sat', '1.0');
        setV('st-warmth', '0.0');
        setV('st-tint', '0.0');
    } else if (sectionName === 'optics') {
        setV('st-sharp', '1.0');
        setV('st-grain', '0.0');
        setV('st-vignette', '0.0');
    }
    _studioActivePreset = 'original';
    _renderStudioFilterPresetThumbs();
    updateStudioLivePreview(true);
}

function clearPrimaryStudioText() {
    const inp = document.getElementById('st-text-val');
    if (inp) inp.value = '';
    updateStudioLivePreview(true);
}

function setStudioInputToPlayhead(inputId) {
    const vidEl = document.getElementById('studio-video');
    const inp = document.getElementById(inputId);
    if (!vidEl || !inp) return;
    inp.value = String(Number((vidEl.currentTime || 0).toFixed(1)));
    pushStudioHistorySnapshot();
}

function syncStudioSaveButtonLabel() {
    const copyBtn = document.getElementById('studio-save-copy-btn');
    const owBtn = document.getElementById('studio-save-overwrite-btn');
    if (copyBtn) {
        copyBtn.textContent = (studioIsVideo && studioExtraClips.length > 0)
            ? `Créer copie (${1 + studioExtraClips.length} clips)`
            : 'Créer une copie';
    }
    if (owBtn) owBtn.textContent = 'Remplacer';
}

function syncStudioTabBadges() {
    const hasFilter = _studioActivePreset !== 'original';
    document.getElementById('studio-tab-badge-filter')?.classList.toggle('hidden', !hasFilter);

    const hasTone = Math.abs((parseFloat(document.getElementById('st-bright')?.value || '1') || 1) - 1) > 0.02
        || Math.abs((parseFloat(document.getElementById('st-contrast')?.value || '1') || 1) - 1) > 0.02
        || Math.abs((parseFloat(document.getElementById('st-sat')?.value || '1') || 1) - 1) > 0.02
        || Math.abs(parseFloat(document.getElementById('st-warmth')?.value || '0') || 0) > 0.02
        || Math.abs(parseFloat(document.getElementById('st-tint')?.value || '0') || 0) > 0.02
        || Math.abs(parseFloat(document.getElementById('st-highlights')?.value || '0') || 0) > 0.02
        || Math.abs(parseFloat(document.getElementById('st-shadows')?.value || '0') || 0) > 0.02
        || (parseFloat(document.getElementById('st-fade')?.value || '0') || 0) > 0.02
        || (parseFloat(document.getElementById('st-grain')?.value || '0') || 0) > 0.02
        || (parseFloat(document.getElementById('st-vignette')?.value || '0') || 0) > 0.02;
    document.getElementById('studio-tab-badge-tone')?.classList.toggle('hidden', !hasTone);

    const hasTransf = Boolean(studioCropRect || studioRotation || studioFlipH || studioFlipV || Math.abs(studioStraighten) >= 0.1);
    document.getElementById('studio-tab-badge-transform')?.classList.toggle('hidden', !hasTransf);

    const decCnt = (!studioDrawLayerHidden && studioDrawStrokes.length ? 1 : 0)
        + ((document.getElementById('st-text-val')?.value || '').trim() ? 1 : 0)
        + studioExtraTextLayers.filter(tl => !tl.hidden).length;
    const decBadge = document.getElementById('studio-tab-badge-decoration');
    if (decBadge) {
        decBadge.textContent = String(decCnt);
        decBadge.classList.toggle('hidden', decCnt === 0);
    }

    const layerCnt = studioAppliedTemplates.length
        + (studioDrawStrokes.length ? 1 : 0)
        + ((document.getElementById('st-text-val')?.value || '').trim() ? 1 : 0)
        + studioExtraTextLayers.length
        + studioImageOverlays.length
        + studioExtraClips.length
        + ((document.getElementById('st-vid-audio')?.value || '').trim() ? 1 : 0);
    const layBadge = document.getElementById('studio-tab-badge-layers');
    if (layBadge) {
        layBadge.textContent = String(layerCnt);
        layBadge.classList.toggle('hidden', layerCnt === 0);
    }

    const toolCnt = studioEraserBoxes.length + studioEraserStrokes.length + studioGlareStrokes.length + studioRedeyeStrokes.length + studioBlemishStrokes.length
        + (studioBgRemove.enabled ? 1 : 0) + (studioAutoRetouch.enabled ? 1 : 0);
    const tlBadge = document.getElementById('studio-tab-badge-tools');
    if (tlBadge) {
        tlBadge.textContent = String(toolCnt);
        tlBadge.classList.toggle('hidden', toolCnt === 0);
    }
    const mods = _getStudioActiveModifications();
    const histBadge = document.getElementById('studio-tab-badge-history');
    if (histBadge) {
        histBadge.textContent = String(mods.length);
        histBadge.classList.toggle('hidden', mods.length === 0);
    }
    _renderStudioLayersStackUI();
    _renderStudioTemplateElementsList();
    _renderStudioAppliedTemplatesStage();
    _renderStudioHistoryListUI(mods);
    syncStudioSaveButtonLabel();
}

function _getStudioActiveModifications() {
    const mods = [];
    if (studioCropRect) mods.push({ key: 'crop', cat: 'Transf.', label: 'Recadrage' });
    if (studioRotation) mods.push({ key: 'rotate', cat: 'Transf.', label: `Rotation ${studioRotation}°` });
    if (studioFlipH) mods.push({ key: 'flip_h', cat: 'Transf.', label: 'Miroir horizontal' });
    if (studioFlipV) mods.push({ key: 'flip_v', cat: 'Transf.', label: 'Miroir vertical' });
    if (Math.abs(studioStraighten) >= 0.1) mods.push({ key: 'straighten', cat: 'Transf.', label: `Angle ${studioStraighten.toFixed(1)}°` });

    const adjSpecs = [
        ['st-bright', 1.0, 'Luminosité'],
        ['st-contrast', 1.0, 'Contraste'],
        ['st-highlights', 0.0, 'Hautes lumières'],
        ['st-shadows', 0.0, 'Ombres'],
        ['st-fade', 0.0, 'Fondu'],
        ['st-sat', 1.0, 'Saturation'],
        ['st-warmth', 0.0, 'Température'],
        ['st-tint', 0.0, 'Teinte'],
        ['st-sharp', 1.0, 'Netteté'],
        ['st-grain', 0.0, 'Grain'],
        ['st-vignette', 0.0, 'Vignette'],
    ];
    adjSpecs.forEach(([id, defVal, title]) => {
        const v = parseFloat(document.getElementById(id)?.value ?? String(defVal));
        if (Math.abs(v - defVal) > 0.02) {
            mods.push({ key: `adj:${id}`, cat: 'Ajuster', label: `${title} (${v.toFixed(2)})` });
        }
    });

    if (_studioActivePreset && _studioActivePreset !== 'original') {
        mods.push({ key: 'preset', cat: 'Filtre', label: `Filtre : ${_studioActivePreset}` });
    }
    if (studioDrawStrokes.length) {
        mods.push({ key: 'draw', cat: 'Décor.', label: `Dessin (${studioDrawStrokes.length} tracé${studioDrawStrokes.length > 1 ? 's' : ''})` });
    }
    const pTxt = (document.getElementById('st-text-val')?.value || '').trim();
    if (pTxt) mods.push({ key: 'text_main', cat: 'Décor.', label: `Texte : "${pTxt.slice(0, 22)}"` });
    studioExtraTextLayers.forEach((tl, i) => {
        mods.push({ key: `text_extra:${i}`, cat: 'Décor.', label: `Calque texte : "${(tl.text || '').slice(0, 20)}"` });
    });
    studioImageOverlays.forEach((ov, i) => {
        mods.push({ key: `overlay:${i}`, cat: 'Calques', label: `Image : ${(ov.name || 'Logo').slice(0, 20)}` });
    });
    studioAppliedTemplates.forEach((tpl, i) => {
        mods.push({ key: `tpl:${i}`, cat: 'Calques', label: `Modèle : ${(tpl.name || 'Modèle').slice(0, 22)}` });
    });
    if (studioBgRemove.enabled) {
        mods.push({ key: 'bg_remove', cat: 'Outils', label: `Suppr. arrière-plan IA (${studioBgRemove.mode || 'transparent'})` });
    }
    if (studioBorder && studioBorder.style && studioBorder.style !== 'none') {
        mods.push({ key: 'border', cat: 'Calques', label: `Bordure ${studioBorder.style} (${studioBorder.thickness || 3}%)` });
    }
    if (studioAutoRetouch.enabled) {
        mods.push({ key: 'auto_retouch', cat: 'Outils', label: `Retouche auto (${Math.round((studioAutoRetouch.strength ?? 0.65) * 100)}%)` });
    }
    const objCnt = studioEraserBoxes.length + studioEraserStrokes.length;
    if (objCnt) mods.push({ key: 'eraser_object', cat: 'Outils', label: `Effaceur d'objet (${objCnt})` });
    if (studioGlareStrokes.length) mods.push({ key: 'eraser_glare', cat: 'Outils', label: `Reflets (${studioGlareStrokes.length})` });
    if (studioRedeyeStrokes.length) mods.push({ key: 'eraser_redeye', cat: 'Outils', label: `Yeux rouges (${studioRedeyeStrokes.length})` });
    if (studioBlemishStrokes.length) mods.push({ key: 'eraser_blemish', cat: 'Outils', label: `Défauts (${studioBlemishStrokes.length})` });
    return mods;
}

function _renderStudioHistoryListUI(precomputedMods = null) {
    const listEl = document.getElementById('studio-history-list');
    const cntEl = document.getElementById('studio-history-count');
    if (!listEl) return;
    const mods = precomputedMods || _getStudioActiveModifications();
    if (cntEl) cntEl.textContent = String(mods.length);
    if (!mods.length) {
        listEl.innerHTML = '<p class="text-[10px] opacity-55">Aucune modification active pour le moment.</p>';
        return;
    }
    listEl.innerHTML = mods.map(m => `
        <div class="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-xl bg-white/10 border border-white/10">
            <div class="min-w-0 flex-1">
                <span class="px-1.5 py-0.5 rounded bg-white/15 text-[9px] font-extrabold mr-1.5">${m.cat}</span>
                <span class="text-[11px] font-bold truncate">${m.label.replace(/</g, '&lt;')}</span>
            </div>
            <button type="button" onclick="removeStudioHistoryModification('${m.key.replace(/'/g, "\\'")}')" title="Supprimer cette modification"
                    class="px-2 py-0.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/35 text-rose-200 text-[10px] font-bold shrink-0 cursor-pointer">
                Suppr.
            </button>
        </div>
    `).join('');
}

function removeStudioHistoryModification(key) {
    if (key === 'crop') {
        studioCropRect = null;
        _applyStudioCropBoxUI();
        updateStudioLivePreview(true);
        return;
    }
    if (key === 'rotate') { studioRotation = 0; refreshStudioPhotoStageSource(); updateStudioLivePreview(true); return; }
    if (key === 'flip_h') { studioFlipH = false; refreshStudioPhotoStageSource(); updateStudioLivePreview(true); return; }
    if (key === 'flip_v') { studioFlipV = false; refreshStudioPhotoStageSource(); updateStudioLivePreview(true); return; }
    if (key === 'straighten') { resetStudioStraighten(); return; }
    if (key.startsWith('adj:')) {
        const id = key.slice(4);
        const defMap = { 'st-bright': '1.0', 'st-contrast': '1.0', 'st-sat': '1.0', 'st-sharp': '1.0' };
        const el = document.getElementById(id);
        if (el) el.value = defMap[id] || '0.0';
        updateStudioLivePreview(true);
        return;
    }
    if (key === 'preset') { applyStudioFilterPreset('original'); return; }
    if (key === 'draw') { clearStudioBrushLayers(); return; }
    if (key === 'text_main') { clearPrimaryStudioText(); return; }
    if (key.startsWith('text_extra:')) { removeExtraStudioTextLayer(parseInt(key.split(':')[1], 10)); return; }
    if (key.startsWith('overlay:')) { removeStudioImageOverlay(parseInt(key.split(':')[1], 10)); return; }
    if (key.startsWith('tpl:')) { removeStudioAppliedTemplate(parseInt(key.split(':')[1], 10)); return; }
    if (key === 'bg_remove') { studioBgRemove.enabled = false; _syncStudioToolsSubUI(); refreshStudioPhotoStageSource(); updateStudioLivePreview(true); return; }
    if (key === 'border') { setStudioBorderStyle('none'); return; }
    if (key === 'auto_retouch') { studioAutoRetouch.enabled = false; _syncStudioToolsSubUI(); refreshStudioPhotoStageSource(); updateStudioLivePreview(true); return; }
    if (key === 'eraser_object') { studioEraserBoxes = []; studioEraserStrokes = []; _renderStudioEraserBoxes(); refreshStudioPhotoStageSource(); updateStudioLivePreview(true); return; }
    if (key === 'eraser_glare') { studioGlareStrokes = []; _renderStudioEraserBoxes(); refreshStudioPhotoStageSource(); updateStudioLivePreview(true); return; }
    if (key === 'eraser_redeye') { studioRedeyeStrokes = []; _renderStudioEraserBoxes(); refreshStudioPhotoStageSource(); updateStudioLivePreview(true); return; }
    if (key === 'eraser_blemish') { studioBlemishStrokes = []; _renderStudioEraserBoxes(); refreshStudioPhotoStageSource(); updateStudioLivePreview(true); return; }
}

function onStudioStraightenInput() {
    studioStraighten = parseFloat(document.getElementById('st-straighten')?.value || '0') || 0;
    const lbl = document.getElementById('st-straighten-val');
    if (lbl) lbl.textContent = `${studioStraighten.toFixed(1)}°`;
    if (!studioIsVideo) refreshStudioPhotoStageSource();
    updateStudioLivePreview();
}

function resetStudioStraighten() {
    studioStraighten = 0;
    const el = document.getElementById('st-straighten');
    if (el) el.value = '0';
    onStudioStraightenInput();
    pushStudioHistorySnapshot();
}

function studioAutoEnhance() {
    _studioActivePreset = 'vivid';
    const setV = (id, v) => { const el = document.getElementById(id); if (el) el.value = String(v); };
    setV('st-preset-intensity', 85);
    setV('st-bright', 1.04);
    setV('st-contrast', 1.14);
    setV('st-highlights', -0.1);
    setV('st-shadows', 0.15);
    setV('st-sat', 1.16);
    setV('st-warmth', 0.08);
    setV('st-vignette', 0.12);
    _renderStudioFilterPresetThumbs();
    updateStudioLivePreview(true);
}

function _parseCropAspectValue(ratioKey = _studioCropAspect) {
    if (ratioKey === 'orig') {
        const [nw, nh] = _getNaturalStageDimensions();
        return (nw > 0 && nh > 0) ? (nw / nh) : null;
    }
    if (ratioKey === '1:1') return 1;
    if (ratioKey === '4:3') return 4 / 3;
    if (ratioKey === '16:9') return 16 / 9;
    if (ratioKey === '4:5') return 4 / 5;
    if (ratioKey === '9:16') return 9 / 16;
    if (ratioKey === '3:2') return 3 / 2;
    return null;
}

function _syncStudioAspectButtonsUI() {
    ['free', 'orig', '1:1', '4:3', '16:9', '4:5', '9:16', '3:2'].forEach(k => {
        const b = document.getElementById(`st-ratio-${k}`);
        if (b) {
            b.className = _studioCropAspect === k
                ? 'h-11 rounded-xl bg-white/25 text-white ring-1 ring-white/50 flex items-center justify-center transition cursor-pointer'
                : 'h-11 rounded-xl bg-white/10 hover:bg-white/20 text-white/85 flex items-center justify-center transition cursor-pointer';
        }
    });
}

function setStudioCropAspect(ratioKey) {
    _studioCropAspect = ratioKey || 'free';
    _syncStudioAspectButtonsUI();
    setStudioMouseTool('CROP');
    const st = document.getElementById('studio-stage');
    const r = st ? st.getBoundingClientRect() : null;
    const ratio = _parseCropAspectValue(_studioCropAspect);
    if (r && r.width > 20 && r.height > 20) {
        if (ratio) {
            const stageRatio = r.width / r.height;
            let nw = 0.82, nh = 0.82;
            if (stageRatio > ratio) {
                nh = 0.84;
                nw = (nh * r.height * ratio) / r.width;
            } else {
                nw = 0.84;
                nh = (nw * r.width / ratio) / r.height;
            }
            nw = Math.min(0.96, Math.max(0.1, nw));
            nh = Math.min(0.96, Math.max(0.1, nh));
            studioCropRect = { nx: (1 - nw) / 2, ny: (1 - nh) / 2, nw, nh };
        } else if (!studioCropRect) {
            studioCropRect = { nx: 0.08, ny: 0.08, nw: 0.84, nh: 0.84 };
        }
        _applyStudioCropBoxUI();
        updateStudioLivePreview();
        pushStudioHistorySnapshot();
    }
}

function _getNaturalStageDimensions() {
    if (studioIsVideo) {
        const v = document.getElementById('studio-video');
        let w = Number(v?.videoWidth || 0), h = Number(v?.videoHeight || 0);
        if (studioRotation % 180 !== 0) [w, h] = [h, w];
        return [w, h];
    }
    const base = _studioOrigImgEl;
    if (base && base.naturalWidth) {
        let w = Number(base.naturalWidth || 0), h = Number(base.naturalHeight || 0);
        if (studioRotation % 180 !== 0) [w, h] = [h, w];
        return [w, h];
    }
    const im = document.getElementById('studio-img');
    return [Number(im?.naturalWidth || 0), Number(im?.naturalHeight || 0)];
}

function _syncStudioDimensionsBadge() {
    const [natW, natH] = _getNaturalStageDimensions();
    const pill = document.getElementById('studio-dims-pill');
    const cropBadge = document.getElementById('studio-crop-size-badge');
    if (!natW || !natH) {
        if (pill) pill.textContent = '—';
        if (cropBadge) cropBadge.textContent = '';
        return;
    }
    if (studioCropRect && studioCropRect.nw > 0.02 && studioCropRect.nh > 0.02) {
        const cw = Math.max(1, Math.round(studioCropRect.nw * natW));
        const ch = Math.max(1, Math.round(studioCropRect.nh * natH));
        if (pill) pill.textContent = `${cw} × ${ch}`;
        if (cropBadge) cropBadge.textContent = `${cw} × ${ch}`;
    } else {
        if (pill) pill.textContent = `${natW} × ${natH}`;
        if (cropBadge) cropBadge.textContent = '';
    }
}

let _studioCropPreviewOn = false;

function _syncStudioCropPreviewBtn() {
    const btn = document.getElementById('studio-crop-preview-btn');
    if (!btn) return;
    btn.className = _studioCropPreviewOn
        ? 'w-full py-1.5 rounded-xl bg-white/25 text-white ring-1 ring-white/50 text-[11px] font-extrabold transition cursor-pointer'
        : 'w-full py-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-[11px] font-extrabold transition cursor-pointer';
}

function toggleStudioCropPreview() {
    _studioCropPreviewOn = !_studioCropPreviewOn;
    _syncStudioCropPreviewBtn();
    setStudioMouseTool(_studioCropPreviewOn ? 'NONE' : 'CROP');
}

function _applyStudioCropBoxUI() {
    const box = document.getElementById('studio-crop-box');
    const stStageEl = document.getElementById('studio-stage');
    const hasCrop = Boolean(studioCropRect && studioCropRect.nw > 0.02 && studioCropRect.nh > 0.02);
    const editingCrop = hasCrop && studioMouseTool === 'CROP';

    if (stStageEl) {
        if (hasCrop && !editingCrop && !_studioCompareOrig) {
            const t = Math.max(0, studioCropRect.ny * 100).toFixed(2);
            const r = Math.max(0, (1 - studioCropRect.nx - studioCropRect.nw) * 100).toFixed(2);
            const b = Math.max(0, (1 - studioCropRect.ny - studioCropRect.nh) * 100).toFixed(2);
            const l = Math.max(0, studioCropRect.nx * 100).toFixed(2);
            stStageEl.style.clipPath = `inset(${t}% ${r}% ${b}% ${l}%)`;
        } else {
            stStageEl.style.clipPath = 'none';
        }
    }

    if (!box) return;
    if (!editingCrop) {
        box.classList.add('hidden');
        _syncStudioDimensionsBadge();
        return;
    }
    box.style.left = `${studioCropRect.nx * 100}%`;
    box.style.top = `${studioCropRect.ny * 100}%`;
    box.style.width = `${studioCropRect.nw * 100}%`;
    box.style.height = `${studioCropRect.nh * 100}%`;
    box.classList.remove('hidden');
    _syncStudioDimensionsBadge();
}

function removeStudioRetouchStroke(kind, idx) {
    const map = {
        box: studioEraserBoxes,
        object: studioEraserStrokes,
        glare: studioGlareStrokes,
        redeye: studioRedeyeStrokes,
        blemish: studioBlemishStrokes,
    };
    const arr = map[kind];
    if (arr && idx >= 0 && idx < arr.length) arr.splice(idx, 1);
    _renderStudioEraserBoxes();
    refreshStudioPhotoStageSource();
    pushStudioHistorySnapshot();
}

function removeStudioEraserAt(idx) {
    if (idx >= 0 && idx < studioEraserBoxes.length) {
        removeStudioRetouchStroke('box', idx);
    } else if (idx >= studioEraserBoxes.length) {
        removeStudioRetouchStroke('object', idx - studioEraserBoxes.length);
    }
}

function _renderStudioEraserBoxes() {
    const el = document.getElementById('studio-eraser-boxes');
    const cntEl = document.getElementById('studio-eraser-count');
    const listEl = document.getElementById('studio-eraser-strokes-list');
    const totalMarks = studioEraserBoxes.length + studioEraserStrokes.length + studioGlareStrokes.length + studioRedeyeStrokes.length + studioBlemishStrokes.length;
    if (cntEl) cntEl.textContent = String(totalMarks);

    if (listEl) {
        if (!totalMarks) {
            listEl.innerHTML = '<p class="text-[10px] opacity-55">Sélectionnez un outil ci-dessus et peignez sur la photo.</p>';
        } else {
            const items = [];
            studioEraserBoxes.forEach((_, idx) => {
                items.push(`<div class="flex items-center justify-between px-2 py-1 rounded-lg bg-white/10 text-[10px] font-bold"><span>Objet rectangle #${idx + 1}</span><button type="button" onclick="removeStudioRetouchStroke('box', ${idx})" class="text-rose-300 hover:text-rose-100 cursor-pointer">×</button></div>`);
            });
            [
                ['object', 'Objet IA', 'text-rose-200', studioEraserStrokes],
                ['glare', 'Reflet', 'text-sky-200', studioGlareStrokes],
                ['redeye', 'Yeux rouges', 'text-amber-200', studioRedeyeStrokes],
                ['blemish', 'Défaut', 'text-emerald-200', studioBlemishStrokes],
            ].forEach(([kind, label, colCls, arr]) => {
                arr.forEach((st, si) => {
                    items.push(`<div class="flex items-center justify-between px-2 py-1 rounded-lg bg-white/10 text-[10px] font-bold"><span class="${colCls}">${label} #${si + 1} (${(st.points || []).length} pts)</span><button type="button" onclick="removeStudioRetouchStroke('${kind}', ${si})" class="text-rose-300 hover:text-rose-100 cursor-pointer">×</button></div>`);
                });
            });
            listEl.innerHTML = items.join('');
        }
    }

    if (!el) return;
    const showBoxes = studioIsVideo || _studioShowEraserMasks;
    if (!showBoxes) {
        el.innerHTML = '';
        return;
    }
    const boxesHtml = studioEraserBoxes.map((nb, idx) =>
        `<div onclick="event.stopPropagation(); removeStudioRetouchStroke('box', ${idx})" title="Cliquer pour supprimer cette zone"
              style="left:${nb.nx*100}%;top:${nb.ny*100}%;width:${nb.nw*100}%;height:${nb.nh*100}%;"
              class="pointer-events-auto cursor-pointer absolute border-2 border-rose-400 bg-rose-500/30 hover:bg-rose-500/45 rounded-sm transition"></div>`
    ).join('');
    const renderStrokeGroup = (arr, kind, borderCls) => arr.map((st, sIdx) => {
        const pts = st.points || [];
        if (!pts.length) return '';
        let minX = 1, minY = 1, maxX = 0, maxY = 0;
        pts.forEach(p => {
            if (p.nx < minX) minX = p.nx; if (p.nx > maxX) maxX = p.nx;
            if (p.ny < minY) minY = p.ny; if (p.ny > maxY) maxY = p.ny;
        });
        const pad = Math.max(0.015, Number(st.nr || 0.025));
        const lx = Math.max(0, minX - pad), ty = Math.max(0, minY - pad);
        const rw = Math.min(1 - lx, (maxX - minX) + pad * 2);
        const rh = Math.min(1 - ty, (maxY - minY) + pad * 2);
        return `<div onclick="event.stopPropagation(); removeStudioRetouchStroke('${kind}', ${sIdx})" title="Cliquer pour supprimer ce tracé"
                     style="left:${lx*100}%;top:${ty*100}%;width:${rw*100}%;height:${rh*100}%;"
                     class="pointer-events-auto cursor-pointer absolute border border-dashed ${borderCls} rounded-xl transition"></div>`;
    }).join('');
    el.innerHTML = boxesHtml
        + renderStrokeGroup(studioEraserStrokes, 'object', 'border-rose-300 bg-rose-500/20 hover:bg-rose-500/35')
        + renderStrokeGroup(studioGlareStrokes, 'glare', 'border-sky-300 bg-sky-500/20 hover:bg-sky-500/35')
        + renderStrokeGroup(studioRedeyeStrokes, 'redeye', 'border-amber-300 bg-amber-500/20 hover:bg-amber-500/35')
        + renderStrokeGroup(studioBlemishStrokes, 'blemish', 'border-emerald-300 bg-emerald-500/20 hover:bg-emerald-500/35');
    syncStudioTabBadges();
}

function clearStudioCrop() {
    studioCropRect = null;
    _studioCropAspect = 'free';
    _syncStudioAspectButtonsUI();
    _applyStudioCropBoxUI();
    pushStudioHistorySnapshot();
}

function undoLastStudioEraser() {
    const lastKind = _studioRetouchUndoOrder.pop();
    const map = {
        object: studioEraserStrokes,
        glare: studioGlareStrokes,
        redeye: studioRedeyeStrokes,
        blemish: studioBlemishStrokes,
        box: studioEraserBoxes,
    };
    if (lastKind && map[lastKind]?.length) {
        map[lastKind].pop();
    } else if (studioEraserStrokes.length) {
        studioEraserStrokes.pop();
    } else if (studioGlareStrokes.length) {
        studioGlareStrokes.pop();
    } else if (studioRedeyeStrokes.length) {
        studioRedeyeStrokes.pop();
    } else if (studioBlemishStrokes.length) {
        studioBlemishStrokes.pop();
    } else if (studioEraserBoxes.length) {
        studioEraserBoxes.pop();
    } else {
        return;
    }
    _renderStudioEraserBoxes();
    refreshStudioPhotoStageSource();
    pushStudioHistorySnapshot();
}

function clearStudioDrawings() {
    studioCropRect = null;
    studioEraserBoxes = [];
    studioEraserStrokes = [];
    studioGlareStrokes = [];
    studioRedeyeStrokes = [];
    studioBlemishStrokes = [];
    _studioRetouchUndoOrder = [];
    studioDrawStrokes = [];
    _studioActiveDrawStroke = null;
    _studioCropAspect = 'free';
    _syncStudioAspectButtonsUI();
    _applyStudioCropBoxUI();
    _renderStudioEraserBoxes();
    _renderStudioBrushLayers();
    if (!studioIsVideo) refreshStudioPhotoStageSource();
}

function _renderStudioFilterPresetThumbs() {
    const cont = document.getElementById('studio-filter-presets');
    if (!cont) return;
    const thumbSrc = studioDestPath ? `/thumb?path=${encodeURIComponent(studioDestPath)}` : '';
    cont.innerHTML = STUDIO_FILTER_PRESETS.map(p => {
        const act = _studioActivePreset === p.key;
        const filt = `brightness(${p.b}) contrast(${p.c}) saturate(${p.s})`;
        const warmTint = p.w > 0 ? `rgba(255,155,60,${(p.w * 0.35).toFixed(2)})` : (p.w < 0 ? `rgba(80,165,255,${(Math.abs(p.w) * 0.35).toFixed(2)})` : 'transparent');
        return `
            <button type="button" onclick="applyStudioFilterPreset('${p.key}')"
                    class="flex flex-col items-center gap-1 p-1 rounded-xl border transition cursor-pointer ${act ? 'bg-white/25 border-white/65' : 'bg-white/5 border-white/10 hover:bg-white/15'}">
                <div class="w-full aspect-video rounded-lg overflow-hidden bg-black/45 relative">
                    ${thumbSrc ? `<img src="${thumbSrc}" loading="lazy" style="filter:${filt};" class="w-full h-full object-cover pointer-events-none"/>` : ''}
                    ${warmTint !== 'transparent' ? `<div style="background:${warmTint};" class="absolute inset-0 mix-blend-soft-light pointer-events-none"></div>` : ''}
                </div>
                <span class="truncate w-full text-center text-[10px]">${p.label}</span>
            </button>`;
    }).join('');
}

function _applyPresetWithIntensity(p, intensityPct) {
    const k = Math.max(0, Math.min(1, Number(intensityPct ?? 100) / 100));
    const lerp = (base, target) => Number((base + (target - base) * k).toFixed(2));
    const setV = (id, v) => { const el = document.getElementById(id); if (el) el.value = String(v); };
    setV('st-bright', lerp(1.0, p.b));
    setV('st-contrast', lerp(1.0, p.c));
    setV('st-sat', lerp(1.0, p.s));
    setV('st-warmth', lerp(0.0, p.w));
    setV('st-tint', lerp(0.0, p.t || 0.0));
    setV('st-fade', lerp(0.0, p.f || 0.0));
    setV('st-vignette', lerp(0.0, p.v));
}

function applyStudioFilterPreset(presetKey) {
    const p = STUDIO_FILTER_PRESETS.find(x => x.key === presetKey) || STUDIO_FILTER_PRESETS[0];
    _studioActivePreset = p.key;
    const intPct = Number(document.getElementById('st-preset-intensity')?.value || 100);
    _applyPresetWithIntensity(p, intPct);
    _renderStudioFilterPresetThumbs();
    updateStudioLivePreview(true);
}

function onStudioPresetIntensityInput() {
    const val = Number(document.getElementById('st-preset-intensity')?.value || 100);
    const lbl = document.getElementById('st-preset-intensity-val');
    if (lbl) lbl.textContent = `${val}%`;
    const p = STUDIO_FILTER_PRESETS.find(x => x.key === _studioActivePreset) || STUDIO_FILTER_PRESETS[0];
    if (p.key !== 'original') {
        _applyPresetWithIntensity(p, val);
    }
    updateStudioLivePreview();
}

function _scheduleStudioHistogramUpdate() {
    if (_studioHistRaf) return;
    _studioHistRaf = requestAnimationFrame(() => {
        _studioHistRaf = null;
        _drawStudioHistogram();
    });
}

function _drawStudioHistogram() {
    const cv = document.getElementById('studio-histogram-canvas');
    if (!cv) return;
    const srcEl = studioIsVideo ? document.getElementById('studio-video') : (_studioOrigImgEl || document.getElementById('studio-img'));
    const ready = studioIsVideo ? (srcEl && srcEl.videoWidth > 0) : (srcEl && srcEl.complete && srcEl.naturalWidth > 0);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!ready) return;

    try {
        const tmp = document.createElement('canvas');
        tmp.width = 96;
        tmp.height = 64;
        const tctx = tmp.getContext('2d');
        tctx.drawImage(srcEl, 0, 0, 96, 64);
        const data = tctx.getImageData(0, 0, 96, 64).data;

        const bright = parseFloat(document.getElementById('st-bright')?.value || '1.0') || 1.0;
        const contrast = parseFloat(document.getElementById('st-contrast')?.value || '1.0') || 1.0;
        const sat = parseFloat(document.getElementById('st-sat')?.value || '1.0') || 1.0;
        const warmth = parseFloat(document.getElementById('st-warmth')?.value || '0.0') || 0.0;
        const tint = parseFloat(document.getElementById('st-tint')?.value || '0.0') || 0.0;
        const fade = parseFloat(document.getElementById('st-fade')?.value || '0.0') || 0.0;

        const binsR = new Uint32Array(64), binsG = new Uint32Array(64), binsB = new Uint32Array(64), binsL = new Uint32Array(64);
        let sumL = 0, pxCnt = 0;
        for (let i = 0; i < data.length; i += 4) {
            let r = data[i] * bright * (1 + 0.16 * warmth + 0.07 * tint);
            let g = data[i + 1] * bright * (1 - 0.14 * tint);
            let b = data[i + 2] * bright * (1 - 0.16 * warmth + 0.07 * tint);
            r = (r - 128) * contrast + 128;
            g = (g - 128) * contrast + 128;
            b = (b - 128) * contrast + 128;
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            r = lum + (r - lum) * sat + fade * 28;
            g = lum + (g - lum) * sat + fade * 28;
            b = lum + (b - lum) * sat + fade * 28;

            const ri = Math.max(0, Math.min(63, (r >> 2) | 0));
            const gi = Math.max(0, Math.min(63, (g >> 2) | 0));
            const bi = Math.max(0, Math.min(63, (b >> 2) | 0));
            const li = Math.max(0, Math.min(63, ((0.299 * r + 0.587 * g + 0.114 * b) >> 2) | 0));
            binsR[ri]++; binsG[gi]++; binsB[bi]++; binsL[li]++;
            sumL += Math.max(0, Math.min(255, 0.299 * r + 0.587 * g + 0.114 * b));
            pxCnt++;
        }

        let maxBin = 1;
        for (let i = 1; i < 63; i++) {
            maxBin = Math.max(maxBin, binsR[i], binsG[i], binsB[i], binsL[i]);
        }

        const drawChannel = (bins, fill) => {
            ctx.beginPath();
            ctx.moveTo(0, cv.height);
            for (let i = 0; i < 64; i++) {
                const x = (i / 63) * cv.width;
                const y = cv.height - Math.min(1, bins[i] / maxBin) * (cv.height - 4);
                ctx.lineTo(x, y);
            }
            ctx.lineTo(cv.width, cv.height);
            ctx.closePath();
            ctx.fillStyle = fill;
            ctx.fill();
        };

        ctx.globalCompositeOperation = 'screen';
        drawChannel(binsR, 'rgba(244,63,94,0.45)');
        drawChannel(binsG, 'rgba(16,185,129,0.45)');
        drawChannel(binsB, 'rgba(56,189,248,0.45)');
        ctx.globalCompositeOperation = 'source-over';
        drawChannel(binsL, 'rgba(255,255,255,0.22)');

        const lLbl = document.getElementById('studio-hist-luma');
        if (lLbl && pxCnt > 0) lLbl.textContent = `Lum ${Math.round((sumL / pxCnt / 255) * 100)}%`;
    } catch (_) {}
}

function setStudioTextPresetPos(nxPct, nyPct) {
    const xEl = document.getElementById('st-text-x');
    const yEl = document.getElementById('st-text-y');
    if (xEl) xEl.value = String(nxPct);
    if (yEl) yEl.value = String(nyPct);
    updateStudioLivePreview(true);
}

let _studioSystemFonts = [];
const _studioLoadedFontFaces = new Set();

function _getSelectedStudioTextFont() {
    const sel = document.getElementById('st-text-font');
    if (!sel || !sel.value) return { font_family: null, font_path: null };
    const opt = sel.options[sel.selectedIndex];
    return {
        font_family: sel.value || null,
        font_path: opt?.dataset?.path || null,
    };
}

async function _ensureStudioFontFace(family, fontPath) {
    if (!family || !fontPath || _studioLoadedFontFaces.has(family) || typeof FontFace === 'undefined') return;
    _studioLoadedFontFaces.add(family);
    try {
        const ff = new FontFace(family, `url('/api/studio/font_file?path=${encodeURIComponent(fontPath)}')`);
        await ff.load();
        document.fonts.add(ff);
    } catch (_) {}
}

async function loadStudioSystemFonts(force = false) {
    const sel = document.getElementById('st-text-font');
    if (!sel) return;
    if (_studioSystemFonts.length && !force) return;
    try {
        const res = await fetch('/api/studio/system_fonts');
        if (!res.ok) return;
        const d = await res.json();
        _studioSystemFonts = d.fonts || [];
        const prev = sel.value;
        sel.innerHTML = '<option value="" data-path="">Défaut système (Segoe UI)</option>'
            + _studioSystemFonts.map(f => {
                const fam = String(f.family || '').replace(/"/g, '&quot;');
                const p = String(f.path || '').replace(/"/g, '&quot;');
                return `<option value="${fam}" data-path="${p}" style="font-family:'${fam}',sans-serif;">${fam.replace(/</g, '&lt;')}</option>`;
            }).join('');
        if (prev) sel.value = prev;
    } catch (_) {}
}

async function onStudioTextFontChanged() {
    const { font_family, font_path } = _getSelectedStudioTextFont();
    if (font_family && font_path) await _ensureStudioFontFace(font_family, font_path);
    updateStudioLivePreview(true);
}

let studioTextStyles = { bold: true, italic: false, shadow: true };

function toggleStudioTextStyle(prop) {
    if (!['bold', 'italic', 'shadow'].includes(prop)) return;
    studioTextStyles[prop] = !studioTextStyles[prop];
    _syncStudioTextStyleButtonsUI();
    updateStudioLivePreview(true);
}

function _syncStudioTextStyleButtonsUI() {
    const bBtn = document.getElementById('st-text-bold');
    const iBtn = document.getElementById('st-text-italic');
    const sBtn = document.getElementById('st-text-shadow');
    if (bBtn) bBtn.className = studioTextStyles.bold
        ? 'py-1.5 rounded-xl bg-white/25 text-white font-black transition cursor-pointer'
        : 'py-1.5 rounded-xl bg-white/10 hover:bg-white/20 font-black opacity-70 transition cursor-pointer';
    if (iBtn) iBtn.className = studioTextStyles.italic
        ? 'py-1.5 rounded-xl bg-white/25 text-white italic transition cursor-pointer'
        : 'py-1.5 rounded-xl bg-white/10 hover:bg-white/20 italic opacity-70 transition cursor-pointer';
    if (sBtn) sBtn.className = studioTextStyles.shadow
        ? 'py-1.5 rounded-xl bg-white/25 text-white transition cursor-pointer'
        : 'py-1.5 rounded-xl bg-white/10 hover:bg-white/20 opacity-70 transition cursor-pointer';
}

let _studioEditingTextIdx = null;

function editStudioTextLayer(idx) {
    const tl = studioExtraTextLayers[idx];
    if (!tl) return;
    _studioEditingTextIdx = idx;
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    setVal('st-text-val', tl.text || '');
    setVal('st-text-color', tl.color || '#ffffff');
    setVal('st-text-bg', tl.bg_color || 'transparent');
    setVal('st-text-size', String(tl.size || 40));
    setVal('st-text-opacity', String(tl.opacity ?? 1.0));
    setVal('st-text-x', String(Math.round((tl.nx ?? 0.1) * 100)));
    setVal('st-text-y', String(Math.round((tl.ny ?? 0.25) * 100)));
    if (tl.font_family) setVal('st-text-font', tl.font_family);
    studioTextStyles.bold = tl.bold !== false;
    studioTextStyles.italic = Boolean(tl.italic);
    studioTextStyles.shadow = tl.shadow !== false;
    _syncStudioTextStyleButtonsUI();
    const banner = document.getElementById('studio-text-editing-banner');
    const lbl = document.getElementById('studio-text-editing-label');
    if (lbl) lbl.textContent = `Modification du texte #${idx + 2}`;
    if (banner) banner.classList.remove('hidden');
    selectStudioSidebarTab('decoration', 'text');
    updateStudioLivePreview(false);
    document.getElementById('st-text-val')?.focus();
}

function finishEditingStudioTextLayer() {
    _studioEditingTextIdx = null;
    document.getElementById('studio-text-editing-banner')?.classList.add('hidden');
    const vEl = document.getElementById('st-text-val');
    if (vEl) vEl.value = '';
    updateStudioLivePreview(true);
}

function addExtraStudioTextLayer() {
    _studioEditingTextIdx = null;
    document.getElementById('studio-text-editing-banner')?.classList.add('hidden');
    const txt = (document.getElementById('st-text-val')?.value || '').trim() || `Texte #${studioExtraTextLayers.length + 2}`;
    const { font_family, font_path } = _getSelectedStudioTextFont();
    studioExtraTextLayers.push({
        text: txt,
        nx: 0.12 + (studioExtraTextLayers.length % 4) * 0.08,
        ny: 0.25 + (studioExtraTextLayers.length % 4) * 0.12,
        size: parseInt(document.getElementById('st-text-size')?.value || '38', 10),
        color: document.getElementById('st-text-color')?.value || '#ffffff',
        bg_color: document.getElementById('st-text-bg')?.value || 'transparent',
        opacity: parseFloat(document.getElementById('st-text-opacity')?.value || '1.0') || 1.0,
        bold: Boolean(studioTextStyles.bold),
        italic: Boolean(studioTextStyles.italic),
        shadow: Boolean(studioTextStyles.shadow),
        font_family,
        font_path,
        start_sec: parseFloat(document.getElementById('st-text-start')?.value || '0') || 0,
        end_sec: parseFloat(document.getElementById('st-text-end')?.value || '0') || 0,
    });
    _renderStudioExtraTextListUI();
    updateStudioLivePreview(true);
}

function removeExtraStudioTextLayer(idx) {
    studioExtraTextLayers.splice(idx, 1);
    _renderStudioExtraTextListUI();
    updateStudioLivePreview(true);
}

function _renderStudioExtraTextListUI() {
    const list = document.getElementById('studio-extra-text-list');
    if (list) {
        list.innerHTML = studioExtraTextLayers.map((tl, idx) => `
            <div class="flex items-center gap-1.5 bg-white/10 border ${_studioEditingTextIdx === idx ? 'border-amber-300/70' : 'border-white/10'} rounded-xl px-2 py-1 ${tl.hidden ? 'opacity-50' : ''}">
                <input type="text" value="${(tl.text || '').replace(/"/g, '&quot;')}"
                       oninput="studioExtraTextLayers[${idx}].text=this.value; updateStudioLivePreview()"
                       onchange="pushStudioHistorySnapshot()"
                       class="flex-1 min-w-0 bg-transparent text-[11px] font-bold outline-none"/>
                <span class="text-[9px] opacity-65 tabular-nums">${Math.round((tl.opacity ?? 1) * 100)}%</span>
                <button type="button" onclick="editStudioTextLayer(${idx})" title="Modifier ce texte" class="text-amber-300 hover:text-amber-100 p-0.5 cursor-pointer">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                </button>
                <button type="button" onclick="removeExtraStudioTextLayer(${idx})" class="text-rose-300 hover:text-rose-100 font-bold cursor-pointer">×</button>
            </div>
        `).join('');
    }

    const layer = document.getElementById('studio-extra-texts-layer');
    if (!layer) return;
    if (_studioCompareOrig || !studioExtraTextLayers.length) {
        layer.innerHTML = '';
        return;
    }
    const vidEl = document.getElementById('studio-video');
    const curT = vidEl ? Number(vidEl.currentTime || 0) : 0;
    layer.innerHTML = studioExtraTextLayers.map((tl, idx) => {
        if (tl.hidden) return '';
        const enS = Number(tl.end_sec || 0), stS = Number(tl.start_sec || 0);
        const hiddenByTime = studioIsVideo && enS > stS && (curT < stS || curT > enS);
        if (hiddenByTime) return '';
        if (tl.font_family && tl.font_path) _ensureStudioFontFace(tl.font_family, tl.font_path);
        const bgStyle = tl.bg_color === 'dark' ? 'background:rgba(0,0,0,0.68);' : (tl.bg_color === 'light' ? 'background:rgba(255,255,255,0.86);' : '');
        const ffStyle = tl.font_family ? `font-family:'${tl.font_family.replace(/'/g, "\\'")}',sans-serif;` : '';
        const fwStyle = tl.bold === false ? 'font-weight:500;' : 'font-weight:800;';
        const fsStyle = tl.italic ? 'font-style:italic;' : '';
        const shStyle = tl.shadow === false ? '' : 'text-shadow:0 2px 6px rgba(0,0,0,0.92);';
        const op = tl.opacity ?? 1.0;
        return `<div data-extra-text-idx="${idx}" title="Glisser pour déplacer"
                     style="left:${(tl.nx * 100).toFixed(1)}%;top:${(tl.ny * 100).toFixed(1)}%;color:${tl.color || '#ffffff'};opacity:${op};font-size:${Math.max(12, Math.round((tl.size || 36) * 0.55))}px;${ffStyle}${fwStyle}${fsStyle}${shStyle}${bgStyle}"
                     class="pointer-events-auto group absolute whitespace-nowrap px-2.5 py-0.5 rounded-lg border border-dashed border-white/40 cursor-move hover:border-white">
                    <span>${(tl.text || '').replace(/</g, '&lt;')}</span>
                    <button type="button" onclick="event.stopPropagation(); removeExtraStudioTextLayer(${idx})" title="Supprimer ce texte"
                            class="opacity-0 group-hover:opacity-100 absolute -top-2 -right-2 w-4 h-4 rounded-full bg-rose-500 text-white text-[10px] leading-none flex items-center justify-center shadow cursor-pointer">×</button>
                    <div data-extra-text-resize="${idx}" title="Agrandir / Réduire le texte"
                         class="opacity-0 group-hover:opacity-100 absolute -bottom-1.5 -right-1.5 w-3.5 h-3.5 rounded-full bg-amber-400 border border-black cursor-nwse-resize"></div>
                </div>`;
    }).join('');
}

// ==================== MODÈLES DE CALQUES & WATERMARKS ====================

let _studioLayerTemplates = [];

async function loadStudioLayerTemplates() {
    try {
        const res = await fetch('/api/studio/layer_templates');
        if (!res.ok) return;
        const d = await res.json();
        _studioLayerTemplates = d.templates || [];
        _renderStudioLayerTemplatesList();
    } catch (_) {}
}

function _renderStudioLayerTemplatesList() {
    const cont = document.getElementById('studio-layer-templates-list');
    if (!cont) return;
    if (!_studioLayerTemplates.length) {
        cont.innerHTML = '<p class="text-[10px] opacity-55">Aucun modèle de calque enregistré.</p>';
        return;
    }
    cont.innerHTML = _studioLayerTemplates.map(tpl => {
        const txtCnt = (tpl.text_layers || []).length;
        const imgCnt = (tpl.image_overlays || []).length;
        const badge = tpl.builtin
            ? '<span class="px-1.5 py-0.5 rounded bg-white/10 text-[9px] opacity-75">Intégré</span>'
            : '<span class="px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-200 text-[9px] font-extrabold">Perso</span>';
        const encId = encodeURIComponent(tpl.id);
        return `
            <div class="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-xl bg-white/10 hover:bg-white/15 border border-white/10 transition">
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-1.5">
                        <span class="truncate text-[11px] font-bold">${(tpl.name || 'Modèle').replace(/</g, '&lt;')}</span>
                        ${badge}
                    </div>
                    <div class="text-[9px] opacity-60">${txtCnt} texte(s) · ${imgCnt} image(s)</div>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                    <button type="button" onclick="applyStudioLayerTemplate(decodeURIComponent('${encId}'))"
                            class="px-2 py-1 rounded-lg bg-white text-black hover:bg-white/90 text-[10px] font-extrabold cursor-pointer">Appliquer</button>
                    ${!tpl.builtin ? `<button type="button" onclick="editStudioLayerTemplate(decodeURIComponent('${encId}'))" title="Modifier ce modèle" class="px-1.5 py-1 text-amber-300 hover:text-amber-100 cursor-pointer"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>` : ''}
                    ${!tpl.builtin ? `<button type="button" onclick="deleteStudioLayerTemplate(decodeURIComponent('${encId}'))" title="Supprimer ce modèle" class="px-1.5 py-1 text-rose-300 hover:text-rose-100 font-bold cursor-pointer">×</button>` : ''}
                </div>
            </div>`;
    }).join('');
}

function toggleStudioTemplateCreator(forceState = null) {
    selectStudioSidebarTab('layers', forceState === false ? 'templates' : 'create');
}

function focusStudioTemplateCreator() {
    selectStudioSidebarTab('layers', 'create');
    const curTxt = (document.getElementById('st-text-val')?.value || '').trim();
    const wmTxt = document.getElementById('st-tpl-wm-text');
    if (curTxt && wmTxt && !wmTxt.value) wmTxt.value = curTxt;
    document.getElementById('st-tpl-name')?.focus();
}

let _studioPendingTplApply = null;

function applyStudioLayerTemplate(templateId) {
    const tpl = _studioLayerTemplates.find(t => t.id === templateId);
    if (!tpl) return;
    if (tpl.builtin) {
        _studioPendingTplApply = tpl;
        const box = document.getElementById('studio-tpl-apply-customizer');
        const titleEl = document.getElementById('studio-tpl-apply-title');
        const txtWrap = document.getElementById('studio-tpl-apply-text-wrap');
        const txtIn = document.getElementById('studio-tpl-apply-text');
        const imgIn = document.getElementById('studio-tpl-apply-img-path');
        if (titleEl) titleEl.textContent = tpl.name || 'Personnaliser le modèle';
        const firstTxt = (tpl.text_layers && tpl.text_layers[0]?.text) || '';
        if (txtWrap) txtWrap.classList.toggle('hidden', !(tpl.text_layers && tpl.text_layers.length));
        if (txtIn) txtIn.value = firstTxt;
        if (imgIn) imgIn.value = (tpl.image_overlays && tpl.image_overlays[0]?.path) || '';
        if (box) box.classList.remove('hidden');
        return;
    }
    _commitStudioLayerTemplate(tpl);
}

function cancelApplyStudioLayerTemplate() {
    _studioPendingTplApply = null;
    document.getElementById('studio-tpl-apply-customizer')?.classList.add('hidden');
}

async function pickImageForStudioTemplateApply() {
    try {
        const res = await fetch('/api/dialog/browse?mode=images');
        const d = await res.json();
        const chosen = (d.paths || [])[0];
        if (chosen) {
            const imgIn = document.getElementById('studio-tpl-apply-img-path');
            if (imgIn) imgIn.value = chosen;
        }
    } catch (_) {}
}

function confirmApplyStudioLayerTemplate() {
    if (!_studioPendingTplApply) return;
    const tpl = _studioPendingTplApply;
    const customTxt = (document.getElementById('studio-tpl-apply-text')?.value || '').trim();
    const customImg = (document.getElementById('studio-tpl-apply-img-path')?.value || '').trim();
    const cloned = {
        ...tpl,
        text_layers: (tpl.text_layers || []).map(tl => ({ ...tl, text: customTxt || tl.text })),
        image_overlays: (tpl.image_overlays || []).map(ov => ({ ...ov })),
    };
    if (customImg) {
        if (cloned.image_overlays.length) {
            cloned.image_overlays[0].path = customImg;
            cloned.image_overlays[0].name = customImg.split(/[\\/]/).pop() || 'Logo';
        } else {
            cloned.image_overlays.push({
                path: customImg,
                name: customImg.split(/[\\/]/).pop() || 'Logo',
                nx: 0.06,
                ny: 0.06,
                nw: 0.22,
                opacity: 0.85,
            });
        }
    }
    cancelApplyStudioLayerTemplate();
    _commitStudioLayerTemplate(cloned);
}

function openStudioCreatorDecorationTool(sub) {
    selectStudioSidebarTab('decoration', sub || 'text');
}

function _commitStudioLayerTemplate(tpl) {
    studioAppliedTemplates.push({
        id: tpl.id || `tpl_${Date.now()}`,
        name: tpl.name || 'Modèle',
        category: tpl.category || 'watermark',
        builtin: Boolean(tpl.builtin),
        text_layers: (tpl.text_layers || []).map(tl => ({ ...tl })),
        image_overlays: (tpl.image_overlays || []).map(ov => ({ ...ov })),
        border: tpl.border ? { ...tpl.border } : null,
        hidden: false,
    });
    if (tpl.border && tpl.border.style && tpl.border.style !== 'none') {
        studioBorder = { ...tpl.border };
        _syncStudioBorderUI();
    }
    _renderStudioAppliedTemplatesStage();
    updateStudioLivePreview(true);
    syncStudioTimelineUI();
    if (typeof showAppToast === 'function') showAppToast(`Modèle « ${tpl.name} » appliqué`, 'success');
}

function toggleStudioAppliedTemplateHidden(idx) {
    if (!studioAppliedTemplates[idx]) return;
    studioAppliedTemplates[idx].hidden = !studioAppliedTemplates[idx].hidden;
    _renderStudioAppliedTemplatesStage();
    updateStudioLivePreview(true);
}

function removeStudioAppliedTemplate(idx) {
    studioAppliedTemplates.splice(idx, 1);
    _renderStudioAppliedTemplatesStage();
    updateStudioLivePreview(true);
}

function _renderStudioAppliedTemplatesStage() {
    const layer = document.getElementById('studio-applied-templates-layer');
    if (!layer) return;
    if (_studioCompareOrig || !studioAppliedTemplates.length) {
        layer.innerHTML = '';
        return;
    }
    const htmlParts = [];
    studioAppliedTemplates.forEach(tpl => {
        if (tpl.hidden) return;
        (tpl.text_layers || []).forEach(tl => {
            if (tl.font_family && tl.font_path) _ensureStudioFontFace(tl.font_family, tl.font_path);
            const bgStyle = tl.bg_color === 'dark' ? 'background:rgba(0,0,0,0.68);' : (tl.bg_color === 'light' ? 'background:rgba(255,255,255,0.86);' : '');
            const ffStyle = tl.font_family ? `font-family:'${tl.font_family.replace(/'/g, "\\'")}',sans-serif;` : '';
            const fwStyle = tl.bold === false ? 'font-weight:500;' : 'font-weight:800;';
            const fsStyle = tl.italic ? 'font-style:italic;' : '';
            const shStyle = tl.shadow === false ? '' : 'text-shadow:0 2px 6px rgba(0,0,0,0.92);';
            htmlParts.push(`
                <div style="left:${((tl.nx ?? 0.1) * 100).toFixed(1)}%;top:${((tl.ny ?? 0.8) * 100).toFixed(1)}%;color:${tl.color || '#ffffff'};opacity:${tl.opacity ?? 1.0};font-size:${Math.max(12, Math.round((tl.size || 32) * 0.55))}px;${ffStyle}${fwStyle}${fsStyle}${shStyle}${bgStyle}"
                     class="absolute whitespace-nowrap px-2 py-0.5 rounded-lg pointer-events-none select-none">${(tl.text || '').replace(/</g, '&lt;')}</div>
            `);
        });
        (tpl.image_overlays || []).forEach(ov => {
            if (!ov.path) return;
            htmlParts.push(`
                <div style="left:${((ov.nx ?? 0.08) * 100).toFixed(1)}%;top:${((ov.ny ?? 0.08) * 100).toFixed(1)}%;width:${((ov.nw ?? 0.25) * 100).toFixed(1)}%;opacity:${ov.opacity ?? 1.0};"
                     class="absolute pointer-events-none select-none">
                    <img src="/media?path=${encodeURIComponent(ov.path)}" class="w-full h-auto block"/>
                </div>
            `);
        });
    });
    layer.innerHTML = htmlParts.join('');
}

function editStudioLayerTemplate(templateId, appliedIdx = null) {
    let tpl = (appliedIdx !== null && studioAppliedTemplates[appliedIdx])
        ? studioAppliedTemplates[appliedIdx]
        : _studioLayerTemplates.find(t => t.id === templateId);
    if (!tpl) return;

    _studioEditingTemplateId = tpl.builtin ? null : tpl.id;
    _studioEditingAppliedIdx = appliedIdx;

    const nmEl = document.getElementById('st-tpl-name');
    if (nmEl) nmEl.value = tpl.name || '';
    const ban = document.getElementById('studio-tpl-edit-banner');
    const lbl = document.getElementById('studio-tpl-edit-label');
    if (lbl) lbl.textContent = `Modification : ${tpl.name || 'Modèle'}`;
    if (ban) ban.classList.remove('hidden');

    document.getElementById('st-tpl-save-btn')?.classList.add('hidden');
    document.getElementById('studio-tpl-edit-save-bar')?.classList.remove('hidden');

    // Charger les éléments du modèle dans le brouillon Filigrane / scène pour modification
    _studioDraftWatermarks = [];
    if ((tpl.text_layers && tpl.text_layers.length) || (tpl.image_overlays && tpl.image_overlays.length)) {
        _studioDraftWatermarks.push({
            wmType: (tpl.image_overlays && tpl.image_overlays.length && !(tpl.text_layers && tpl.text_layers.length)) ? 'image' : 'text',
            wmText: (tpl.text_layers && tpl.text_layers[0]?.text) || 'Modèle',
            wmImg: (tpl.image_overlays && tpl.image_overlays[0]?.path) || '',
            opacity: (tpl.text_layers?.[0]?.opacity ?? tpl.image_overlays?.[0]?.opacity ?? 0.7),
            size: (tpl.text_layers?.[0]?.size ?? 28),
            layout: 'br',
            repeat: (tpl.text_layers?.length || 0) > 1 ? 'grid' : 'once',
            spacing: 30,
            textLayers: (tpl.text_layers || []).map(tl => ({ ...tl })),
            imageOverlays: (tpl.image_overlays || []).map(ov => ({ ...ov })),
        });
    }
    if (tpl.border && tpl.border.style && tpl.border.style !== 'none') {
        studioBorder = { ...tpl.border };
        _syncStudioBorderUI();
    }
    selectStudioSidebarTab('layers', 'create');
    _renderStudioDraftWatermarksList();
    _renderStudioTemplateElementsList();
    previewStudioWatermarkLive();
}

function cancelEditStudioLayerTemplate() {
    _studioEditingTemplateId = null;
    _studioEditingAppliedIdx = null;
    document.getElementById('studio-tpl-edit-banner')?.classList.add('hidden');
    document.getElementById('st-tpl-save-btn')?.classList.remove('hidden');
    document.getElementById('studio-tpl-edit-save-bar')?.classList.add('hidden');
    const nmEl = document.getElementById('st-tpl-name');
    if (nmEl) nmEl.value = '';
    _studioDraftWatermarks = [];
    clearStudioWatermarkDraft();
}

function _renderStudioTemplateElementsList() {
    const cont = document.getElementById('studio-tpl-elements-list');
    if (!cont) return;
    const rows = [];
    const pTxt = (document.getElementById('st-text-val')?.value || '').trim();
    if (pTxt) {
        rows.push(`<div class="flex items-center justify-between gap-1.5 px-2 py-1 rounded-lg bg-black/40 border border-white/15 text-[10px]"><span class="truncate font-bold">Texte : "${pTxt.replace(/</g, '&lt;')}"</span><div class="flex items-center gap-1 shrink-0"><button type="button" onclick="openStudioCreatorDecorationTool('text')" class="text-amber-300 cursor-pointer">Édit.</button><button type="button" onclick="clearPrimaryStudioText()" class="text-rose-300 font-bold cursor-pointer">×</button></div></div>`);
    }
    studioExtraTextLayers.forEach((tl, idx) => {
        rows.push(`<div class="flex items-center justify-between gap-1.5 px-2 py-1 rounded-lg bg-black/40 border border-white/15 text-[10px]"><span class="truncate font-bold">Texte #${idx + 2} : "${(tl.text || '').replace(/</g, '&lt;')}"</span><div class="flex items-center gap-1 shrink-0"><button type="button" onclick="editStudioTextLayer(${idx})" class="text-amber-300 cursor-pointer">Édit.</button><button type="button" onclick="removeExtraStudioTextLayer(${idx})" class="text-rose-300 font-bold cursor-pointer">×</button></div></div>`);
    });
    studioImageOverlays.forEach((ov, idx) => {
        rows.push(`<div class="flex items-center justify-between gap-1.5 px-2 py-1 rounded-lg bg-black/40 border border-white/15 text-[10px]"><span class="truncate font-bold">Image : ${(ov.name || 'Logo').replace(/</g, '&lt;')}</span><div class="flex items-center gap-1 shrink-0"><button type="button" onclick="openStudioCreatorDecorationTool('image')" class="text-amber-300 cursor-pointer">Édit.</button><button type="button" onclick="removeStudioImageOverlay(${idx})" class="text-rose-300 font-bold cursor-pointer">×</button></div></div>`);
    });
    if (studioDrawStrokes.length) {
        rows.push(`<div class="flex items-center justify-between gap-1.5 px-2 py-1 rounded-lg bg-black/40 border border-white/15 text-[10px]"><span class="truncate font-bold">Dessin (${studioDrawStrokes.length} tracé(s))</span><div class="flex items-center gap-1 shrink-0"><button type="button" onclick="openStudioCreatorDecorationTool('draw')" class="text-amber-300 cursor-pointer">Édit.</button><button type="button" onclick="clearStudioBrushLayers()" class="text-rose-300 font-bold cursor-pointer">×</button></div></div>`);
    }
    if (studioBorder && studioBorder.style && studioBorder.style !== 'none') {
        rows.push(`<div class="flex items-center justify-between gap-1.5 px-2 py-1 rounded-lg bg-black/40 border border-white/15 text-[10px]"><span class="truncate font-bold">Bordure : ${studioBorder.style} (${studioBorder.thickness || 3}%)</span><div class="flex items-center gap-1 shrink-0"><button type="button" onclick="openStudioCreatorDecorationTool('border')" class="text-amber-300 cursor-pointer">Édit.</button><button type="button" onclick="setStudioBorderStyle('none')" class="text-rose-300 font-bold cursor-pointer">×</button></div></div>`);
    }
    cont.innerHTML = rows.length
        ? rows.join('')
        : '<p class="text-[10px] opacity-55">Aucun élément composé pour le moment.</p>';
}

async function _persistStudioLayerTemplate(name, textLayers, imageOverlays, category = 'watermark', templateId = null, border = null) {
    const isOverwrite = Boolean(templateId && !String(templateId).startsWith('builtin_'));
    const url = isOverwrite ? `/api/studio/layer_templates/${encodeURIComponent(templateId)}` : '/api/studio/layer_templates';
    const res = await fetch(url, {
        method: isOverwrite ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            template_id: isOverwrite ? templateId : null,
            name,
            category,
            text_layers: textLayers,
            image_overlays: imageOverlays,
            border: (border && border.style && border.style !== 'none') ? border : null,
        }),
    });
    if (res.ok) {
        const d = await res.json();
        _studioLayerTemplates = d.templates || _studioLayerTemplates;
        _renderStudioLayerTemplatesList();
        const nmEl = document.getElementById('st-tpl-name'); if (nmEl) nmEl.value = '';
        if (typeof showAppToast === 'function') showAppToast(`Modèle « ${name} » enregistré !`, 'success');
        return d.template;
    }
    return null;
}

function setStudioWatermarkType(type) {
    const t = type === 'image' ? 'image' : 'text';
    const hiddenEl = document.getElementById('st-tpl-wm-type');
    if (hiddenEl) hiddenEl.value = t;
    const bTxt = document.getElementById('st-tpl-wm-type-text');
    const bImg = document.getElementById('st-tpl-wm-type-image');
    if (bTxt) bTxt.className = t === 'text' ? 'py-1 rounded-lg bg-white/25 text-white transition cursor-pointer' : 'py-1 rounded-lg hover:bg-white/15 opacity-75 transition cursor-pointer';
    if (bImg) bImg.className = t === 'image' ? 'py-1 rounded-lg bg-white/25 text-white transition cursor-pointer' : 'py-1 rounded-lg hover:bg-white/15 opacity-75 transition cursor-pointer';
    document.getElementById('st-tpl-wm-text-wrap')?.classList.toggle('hidden', t !== 'text');
    document.getElementById('st-tpl-wm-img-wrap')?.classList.toggle('hidden', t !== 'image');
    previewStudioWatermarkLive();
}

function onStudioWatermarkRepeatChange() {
    const rep = document.getElementById('st-tpl-wm-repeat')?.value || 'once';
    document.getElementById('st-tpl-wm-spacing-row')?.classList.toggle('hidden', rep === 'once');
    previewStudioWatermarkLive();
}

async function pickImageForStudioWatermark() {
    try {
        const res = await fetch('/api/dialog/browse?mode=images');
        const d = await res.json();
        const chosen = (d.paths || [])[0];
        if (chosen) {
            const pEl = document.getElementById('st-tpl-wm-img-path');
            if (pEl) pEl.value = chosen;
            previewStudioWatermarkLive();
        }
    } catch (_) {}
}

let _studioDraftWatermarks = [];
let _studioEditingDraftWmIdx = null;

function previewStudioWatermarkLive() {
    const layer = document.getElementById('studio-wm-preview-layer');
    if (!layer) return;
    if (_studioCompareOrig) {
        layer.innerHTML = '';
        return;
    }
    const allTexts = [];
    const allImgs = [];
    _studioDraftWatermarks.forEach((dw, idx) => {
        if (_studioEditingDraftWmIdx === idx) return;
        (dw.textLayers || []).forEach(tl => allTexts.push(tl));
        (dw.imageOverlays || []).forEach(ov => allImgs.push(ov));
    });
    const activeDraft = _buildStudioWatermarkEntries();
    activeDraft.textLayers.forEach(tl => allTexts.push(tl));
    activeDraft.imageOverlays.forEach(ov => allImgs.push(ov));

    if (!allTexts.length && !allImgs.length) {
        layer.innerHTML = '';
        return;
    }
    const txtHtml = allTexts.map(tl => `
        <div style="left:${(tl.nx * 100).toFixed(1)}%;top:${(tl.ny * 100).toFixed(1)}%;color:${tl.color || '#ffffff'};opacity:${tl.opacity ?? 0.55};font-size:${Math.max(12, Math.round((tl.size || 28) * 0.55))}px;text-shadow:0 2px 6px rgba(0,0,0,0.85);"
             class="absolute font-extrabold whitespace-nowrap pointer-events-none select-none">${(tl.text || '').replace(/</g, '&lt;')}</div>
    `).join('');
    const imgHtml = allImgs.map(ov => `
        <div style="left:${(ov.nx * 100).toFixed(1)}%;top:${(ov.ny * 100).toFixed(1)}%;width:${(ov.nw * 100).toFixed(1)}%;opacity:${ov.opacity ?? 0.55};"
             class="absolute pointer-events-none select-none">
            <img src="/media?path=${encodeURIComponent(ov.path)}" class="w-full h-auto block"/>
        </div>
    `).join('');
    layer.innerHTML = txtHtml + imgHtml;
}

function _renderStudioDraftWatermarksList() {
    const listEl = document.getElementById('studio-tpl-wm-draft-list');
    if (!listEl) return;
    if (!_studioDraftWatermarks.length) {
        listEl.innerHTML = '';
        return;
    }
    listEl.innerHTML = _studioDraftWatermarks.map((dw, idx) => {
        const label = dw.wmType === 'image'
            ? (dw.wmImg?.split(/[\\/]/).pop() || 'Image')
            : (dw.wmText || 'Filigrane');
        const repLabel = dw.repeat === 'grid' ? 'Aligné' : (dw.repeat === 'staggered' ? 'Décalé' : '1x');
        return `
            <div class="flex items-center justify-between gap-1.5 px-2 py-1 rounded-lg bg-black/40 border ${_studioEditingDraftWmIdx === idx ? 'border-amber-300/70' : 'border-white/15'} text-[10px]">
                <span class="truncate font-bold flex-1">#${idx + 1} · ${label.replace(/</g, '&lt;')} (${repLabel})</span>
                <div class="flex items-center gap-1 shrink-0">
                    <button type="button" onclick="editStudioDraftWatermark(${idx})" title="Modifier ce filigrane" class="text-amber-300 hover:text-amber-100 cursor-pointer p-0.5">
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                    </button>
                    <button type="button" onclick="removeStudioDraftWatermark(${idx})" title="Supprimer ce filigrane" class="text-rose-300 hover:text-rose-100 font-bold cursor-pointer px-1">×</button>
                </div>
            </div>`;
    }).join('');
}

function validateStudioWatermarkToScene() {
    const wm = _buildStudioWatermarkEntries();
    if (!wm.textLayers.length && !wm.imageOverlays.length) {
        if (typeof showAppToast === 'function') showAppToast('Saisissez un texte ou choisissez une image de filigrane.', 'info');
        return;
    }
    const item = {
        wmType: document.getElementById('st-tpl-wm-type')?.value || 'text',
        wmText: (document.getElementById('st-tpl-wm-text')?.value || '').trim(),
        wmImg: (document.getElementById('st-tpl-wm-img-path')?.value || '').trim(),
        opacity: parseFloat(document.getElementById('st-tpl-wm-opacity')?.value || '0.55') || 0.55,
        size: parseInt(document.getElementById('st-tpl-wm-size')?.value || '28', 10) || 28,
        layout: document.getElementById('st-tpl-wm-layout')?.value || 'br',
        repeat: document.getElementById('st-tpl-wm-repeat')?.value || 'once',
        spacing: parseInt(document.getElementById('st-tpl-wm-spacing')?.value || '30', 10) || 30,
        textLayers: wm.textLayers,
        imageOverlays: wm.imageOverlays,
    };
    if (_studioEditingDraftWmIdx !== null && _studioDraftWatermarks[_studioEditingDraftWmIdx]) {
        _studioDraftWatermarks[_studioEditingDraftWmIdx] = item;
        _studioEditingDraftWmIdx = null;
    } else {
        _studioDraftWatermarks.push(item);
    }
    const tEl = document.getElementById('st-tpl-wm-text'); if (tEl) tEl.value = '';
    const iEl = document.getElementById('st-tpl-wm-img-path'); if (iEl) iEl.value = '';
    _renderStudioDraftWatermarksList();
    previewStudioWatermarkLive();
    if (typeof showAppToast === 'function') showAppToast('Filigrane ajouté au modèle en cours !', 'success');
}

function editStudioDraftWatermark(idx) {
    const dw = _studioDraftWatermarks[idx];
    if (!dw) return;
    _studioEditingDraftWmIdx = idx;
    setStudioWatermarkType(dw.wmType || 'text');
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    setVal('st-tpl-wm-text', dw.wmText || '');
    setVal('st-tpl-wm-img-path', dw.wmImg || '');
    setVal('st-tpl-wm-opacity', String(dw.opacity ?? 0.55));
    const opLbl = document.getElementById('st-tpl-wm-op-val');
    if (opLbl) opLbl.textContent = `${Math.round((dw.opacity ?? 0.55) * 100)}%`;
    setVal('st-tpl-wm-size', String(dw.size ?? 28));
    const szLbl = document.getElementById('st-tpl-wm-size-val');
    if (szLbl) szLbl.textContent = String(dw.size ?? 28);
    setVal('st-tpl-wm-layout', dw.layout || 'br');
    setVal('st-tpl-wm-repeat', dw.repeat || 'once');
    setVal('st-tpl-wm-spacing', String(dw.spacing ?? 30));
    const spLbl = document.getElementById('st-tpl-wm-spacing-val');
    if (spLbl) spLbl.textContent = `${dw.spacing ?? 30}%`;
    onStudioWatermarkRepeatChange();
    _renderStudioDraftWatermarksList();
    previewStudioWatermarkLive();
}

function removeStudioDraftWatermark(idx) {
    _studioDraftWatermarks.splice(idx, 1);
    if (_studioEditingDraftWmIdx === idx) _studioEditingDraftWmIdx = null;
    else if (_studioEditingDraftWmIdx !== null && _studioEditingDraftWmIdx > idx) _studioEditingDraftWmIdx -= 1;
    _renderStudioDraftWatermarksList();
    previewStudioWatermarkLive();
}

function clearStudioWatermarkDraft() {
    _studioEditingDraftWmIdx = null;
    const tEl = document.getElementById('st-tpl-wm-text');
    if (tEl) tEl.value = '';
    const iEl = document.getElementById('st-tpl-wm-img-path');
    if (iEl) iEl.value = '';
    _renderStudioDraftWatermarksList();
    previewStudioWatermarkLive();
}

function _buildStudioWatermarkEntries() {
    const wmType = document.getElementById('st-tpl-wm-type')?.value || 'text';
    const wmText = (document.getElementById('st-tpl-wm-text')?.value || '').trim();
    const wmImg = (document.getElementById('st-tpl-wm-img-path')?.value || '').trim();
    const op = parseFloat(document.getElementById('st-tpl-wm-opacity')?.value || '0.55') || 0.55;
    const size = parseInt(document.getElementById('st-tpl-wm-size')?.value || '28', 10) || 28;
    const layout = document.getElementById('st-tpl-wm-layout')?.value || 'br';
    const repeat = document.getElementById('st-tpl-wm-repeat')?.value || 'once';
    const spacingPct = Math.max(18, Math.min(50, parseInt(document.getElementById('st-tpl-wm-spacing')?.value || '30', 10) || 30));

    if (wmType === 'text' && !wmText) return { textLayers: [], imageOverlays: [] };
    if (wmType === 'image' && !wmImg) return { textLayers: [], imageOverlays: [] };

    const positions = [];
    if (repeat === 'once') {
        const posMap = {
            br: { nx: 0.64, ny: 0.86 },
            bl: { nx: 0.04, ny: 0.86 },
            tr: { nx: 0.64, ny: 0.06 },
            tl: { nx: 0.04, ny: 0.06 },
            center: { nx: 0.36, ny: 0.46 },
        };
        positions.push(posMap[layout] || posMap.br);
    } else {
        const step = spacingPct / 100.0;
        let rowIdx = 0;
        for (let y = 0.08; y <= 0.88; y += step) {
            const xOffset = (repeat === 'staggered' && rowIdx % 2 === 1) ? step * 0.5 : 0;
            for (let x = 0.06 + xOffset; x <= 0.88; x += step) {
                positions.push({ nx: Number(x.toFixed(2)), ny: Number(y.toFixed(2)) });
            }
            rowIdx += 1;
        }
    }

    if (wmType === 'text') {
        return {
            textLayers: positions.map(p => ({
                text: wmText,
                nx: p.nx,
                ny: p.ny,
                size,
                color: '#ffffff',
                bg_color: 'transparent',
                opacity: op,
            })),
            imageOverlays: [],
        };
    }

    const imgName = wmImg.split(/[\\/]/).pop() || 'Watermark';
    const nw = Math.max(0.08, Math.min(0.65, size / 120.0));
    return {
        textLayers: [],
        imageOverlays: positions.map(p => ({
            path: wmImg,
            name: imgName,
            nx: p.nx,
            ny: p.ny,
            nw: Number(nw.toFixed(2)),
            opacity: op,
        })),
    };
}

async function saveStudioLayerTemplateUnified(mode = 'new') {
    const rawName = (document.getElementById('st-tpl-name')?.value || '').trim();
    const wm = _buildStudioWatermarkEntries();
    const txtVal = (document.getElementById('st-text-val')?.value || '').trim();
    const textLayers = [];
    if (txtVal) {
        textLayers.push({
            text: txtVal,
            nx: parseFloat(document.getElementById('st-text-x')?.value || '5') / 100.0,
            ny: parseFloat(document.getElementById('st-text-y')?.value || '86') / 100.0,
            size: parseInt(document.getElementById('st-text-size')?.value || '40', 10),
            color: document.getElementById('st-text-color')?.value || '#ffffff',
            bg_color: document.getElementById('st-text-bg')?.value || 'transparent',
            opacity: parseFloat(document.getElementById('st-text-opacity')?.value || '1.0') || 1.0,
        });
    }
    studioExtraTextLayers.forEach(tl => textLayers.push({ ...tl }));
    _studioDraftWatermarks.forEach(dw => {
        (dw.textLayers || []).forEach(tl => textLayers.push({ ...tl }));
    });
    wm.textLayers.forEach(tl => textLayers.push(tl));

    const imageOverlays = [...studioImageOverlays.map(ov => ({ ...ov }))];
    _studioDraftWatermarks.forEach(dw => {
        (dw.imageOverlays || []).forEach(ov => imageOverlays.push({ ...ov }));
    });
    wm.imageOverlays.forEach(ov => imageOverlays.push(ov));
    const hasBdr = Boolean(studioBorder && studioBorder.style && studioBorder.style !== 'none');
    if (!textLayers.length && !imageOverlays.length && !hasBdr) {
        if (typeof showAppToast === 'function') showAppToast('Ajoutez un élément (texte/image/bordure) ou configurez le filigrane.', 'info');
        return;
    }
    const baseName = rawName || `Mon modèle ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
    const name = (mode === 'copy' && _studioEditingTemplateId && rawName) ? `${baseName} (copie)` : baseName;
    const targetId = (mode === 'overwrite' && _studioEditingTemplateId) ? _studioEditingTemplateId : null;
    const created = await _persistStudioLayerTemplate(
        name,
        textLayers,
        imageOverlays,
        (_studioDraftWatermarks.length || wm.textLayers.length || wm.imageOverlays.length) ? 'watermark' : 'custom',
        targetId,
        hasBdr ? { ...studioBorder } : null
    );
    if (created) {
        if (mode === 'overwrite' && _studioEditingAppliedIdx !== null && studioAppliedTemplates[_studioEditingAppliedIdx]) {
            studioAppliedTemplates[_studioEditingAppliedIdx] = {
                ...created,
                hidden: Boolean(studioAppliedTemplates[_studioEditingAppliedIdx].hidden),
            };
        } else if (mode !== 'overwrite') {
            _commitStudioLayerTemplate(created);
        }
        cancelEditStudioLayerTemplate();
        selectStudioLayerSubtab('templates');
        _renderStudioAppliedTemplatesStage();
        updateStudioLivePreview(true);
    }
}

async function saveCurrentCanvasAsLayerTemplate() {
    return saveStudioLayerTemplateUnified();
}

async function saveStudioWatermarkQuickTemplate() {
    return saveStudioLayerTemplateUnified();
}

async function deleteStudioLayerTemplate(templateId) {
    try {
        const res = await fetch(`/api/studio/layer_templates/${encodeURIComponent(templateId)}`, { method: 'DELETE' });
        if (res.ok) {
            const d = await res.json();
            _studioLayerTemplates = d.templates || [];
            _renderStudioLayerTemplatesList();
        }
    } catch (_) {}
}

// ==================== AJOUTER DES FICHIERS (UPLOAD, BIBLIOTHÈQUE, INCRUSTATIONS V2, CLIPS V1) ====================

function addStudioAssetByPath(filePath, name, kind, durSec = 3.0) {
    if (!filePath) return;
    const ext = (filePath.split('.').pop() || '').toLowerCase();
    const detectedKind = kind || (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'].includes(ext)
        ? 'audio'
        : (['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'].includes(ext) ? 'video' : 'image'));

    if (detectedKind === 'audio') {
        const inp = document.getElementById('st-vid-audio');
        if (inp) inp.value = filePath;
        onStudioAudioPathChanged();
        pushStudioHistorySnapshot();
        if (typeof showAppToast === 'function') showAppToast(`Piste audio ajoutée : ${name || filePath.split(/[\\/]/).pop()}`, 'success');
        return;
    }

    if (detectedKind === 'video' && studioIsVideo) {
        studioExtraClips.push({
            path: filePath,
            name: name || filePath.split(/[\\/]/).pop(),
            duration_sec: Math.max(1, Number(durSec || 4)),
            start_sec: 0,
            end_sec: 0,
        });
        _renderStudioExtraClipsUI();
        syncStudioTimelineUI();
        pushStudioHistorySnapshot();
        if (typeof showAppToast === 'function') showAppToast(`Clip vidéo ajouté à la piste V1`, 'success');
        return;
    }

    // Image / Logo -> Incrustation calque (V2 sur vidéo ou calque image sur photo)
    studioImageOverlays.push({
        path: filePath,
        name: name || filePath.split(/[\\/]/).pop(),
        nx: 0.32,
        ny: 0.25,
        nw: 0.28,
        opacity: 1.0,
        start_sec: 0,
        end_sec: 0,
    });
    _renderStudioImageOverlaysUI();
    syncStudioTimelineUI();
    pushStudioHistorySnapshot();
    if (typeof showAppToast === 'function') showAppToast(`Incrustation ajoutée : ${name || 'Image'}`, 'success');
}

function appendLibraryAssetAsVideoClip(filePath, name, durSec) {
    if (!studioIsVideo) {
        addStudioAssetByPath(filePath, name, 'image', durSec);
        return;
    }
    studioExtraClips.push({
        path: filePath,
        name: name || filePath.split(/[\\/]/).pop(),
        duration_sec: Math.max(1, Number(durSec || 3)),
        start_sec: 0,
        end_sec: 0,
    });
    _renderStudioExtraClipsUI();
    syncStudioTimelineUI();
    pushStudioHistorySnapshot();
}

async function handleStudioLocalFilesSelected(fileList) {
    if (!fileList || !fileList.length) return;
    for (const f of Array.from(fileList)) {
        const fd = new FormData();
        fd.append('file', f);
        try {
            const res = await fetch('/api/studio/upload_asset', { method: 'POST', body: fd });
            if (res.ok) {
                const d = await res.json();
                addStudioAssetByPath(d.path, d.name, d.kind, d.duration_sec);
            }
        } catch (_) {}
    }
}

function handleStudioStageDrop(ev) {
    ev.preventDefault();
    ev.currentTarget?.classList.remove('ring-2', 'ring-white/40');
    const files = ev.dataTransfer?.files;
    if (files && files.length) {
        handleStudioLocalFilesSelected(files);
        selectStudioSidebarTab('layers');
    }
}

async function openStudioNativeMediaDialog() {
    const mode = studioIsVideo ? 'media' : 'images';
    try {
        const res = await fetch(`/api/dialog/browse?mode=${mode}`);
        const d = await res.json();
        (d.paths || []).forEach(p => addStudioAssetByPath(p));
    } catch (_) {}
}

async function loadStudioLibraryBin(mediaTypeFilter = '') {
    _studioLibBinFilter = mediaTypeFilter || '';
    const mapBtns = { '': 'studio-lib-filt-all', 'IMAGE': 'studio-lib-filt-img', 'VIDEO': 'studio-lib-filt-vid' };
    Object.entries(mapBtns).forEach(([k, id]) => {
        const b = document.getElementById(id);
        if (b) b.className = _studioLibBinFilter === k ? 'px-2 py-0.5 rounded-full bg-white/25 cursor-pointer' : 'px-2 py-0.5 rounded-full bg-white/10 hover:bg-white/20 cursor-pointer';
    });
    const grid = document.getElementById('studio-library-bin-grid');
    const decGrid = document.getElementById('studio-dec-library-bin-grid');
    if (!grid && !decGrid) return;
    if (grid) grid.innerHTML = '<div class="col-span-3 text-center opacity-55 py-3 text-[10px]">Chargement...</div>';
    if (decGrid) decGrid.innerHTML = '<div class="col-span-3 text-center opacity-55 py-3 text-[10px]">Chargement...</div>';
    try {
        const res = await fetch(`/api/gallery/items?media_type=${encodeURIComponent(_studioLibBinFilter)}&limit=36`);
        const d = await res.json();
        const items = d.items || [];
        if (!items.length) {
            if (grid) grid.innerHTML = '<div class="col-span-3 text-center opacity-55 py-3 text-[10px]">Aucun média trouvé</div>';
            if (decGrid) decGrid.innerHTML = '<div class="col-span-3 text-center opacity-55 py-3 text-[10px]">Aucune photo trouvée</div>';
            return;
        }
        const html = items.map(it => {
            const p = it.dest_path || it.source_path || '';
            const fname = p.split(/[\\/]/).pop() || 'Média';
            const isVid = Boolean(it.duration_sec > 0 || isVideoFile(p));
            const encP = encodeURIComponent(p);
            const encN = encodeURIComponent(fname);
            return `
                <div class="group relative aspect-square rounded-xl overflow-hidden bg-black/45 border border-white/10">
                    <img src="/thumb?path=${encP}" loading="lazy" class="w-full h-full object-cover"/>
                    ${isVid ? `<span class="absolute top-1 left-1 px-1 py-0.5 rounded bg-black/75 text-[8px] font-extrabold">${Math.round(it.duration_sec || 0)}s</span>` : ''}
                    <div class="opacity-0 group-hover:opacity-100 absolute inset-0 bg-black/65 flex flex-col items-center justify-center gap-1 p-1 transition">
                        ${(!isVid) ? `<button type="button" onclick="addStudioAssetByPath(decodeURIComponent('${encP}'), decodeURIComponent('${encN}'), 'image')" class="w-full py-0.5 rounded bg-white text-black text-[9px] font-extrabold cursor-pointer">+ Image</button>` : ''}
                        ${studioIsVideo ? `<button type="button" onclick="appendLibraryAssetAsVideoClip(decodeURIComponent('${encP}'), decodeURIComponent('${encN}'), ${Number(it.duration_sec || 3)})" class="w-full py-0.5 rounded bg-amber-400 text-black text-[9px] font-extrabold cursor-pointer">+ Clip V1</button>` : ''}
                    </div>
                </div>`;
        }).join('');
        if (grid) grid.innerHTML = html;
        if (decGrid) decGrid.innerHTML = html;
    } catch (_) {
        if (grid) grid.innerHTML = '<div class="col-span-3 text-center opacity-55 py-3 text-[10px]">Erreur de chargement</div>';
        if (decGrid) decGrid.innerHTML = '<div class="col-span-3 text-center opacity-55 py-3 text-[10px]">Erreur de chargement</div>';
    }
}

function removeStudioImageOverlay(idx) {
    studioImageOverlays.splice(idx, 1);
    _renderStudioImageOverlaysUI();
    syncStudioTimelineUI();
    pushStudioHistorySnapshot();
}

function _renderStudioImageOverlaysUI() {
    const cnt = document.getElementById('studio-overlays-count');
    if (cnt) cnt.textContent = String(studioImageOverlays.length);
    const decCnt = document.getElementById('studio-dec-images-count');
    if (decCnt) decCnt.textContent = String(studioImageOverlays.length);

    const listEl = document.getElementById('studio-overlays-list');
    const decListEl = document.getElementById('studio-dec-images-list');
    const emptyHtml = '<p class="text-[10px] opacity-55">Ajoutez un logo, watermark ou image par-dessus votre média.</p>';
    const cardsHtml = !studioImageOverlays.length ? emptyHtml : studioImageOverlays.map((ov, idx) => `
                <div class="p-2 rounded-xl bg-white/10 border border-white/10 space-y-1.5">
                    <div class="flex items-center justify-between gap-2">
                        <span class="truncate font-bold text-[10px]">${(ov.name || 'Image').replace(/</g, '&lt;')}</span>
                        <button type="button" onclick="removeStudioImageOverlay(${idx})" class="text-rose-300 hover:text-rose-100 font-bold cursor-pointer">×</button>
                    </div>
                    <div class="grid grid-cols-2 gap-2 text-[10px]">
                        <label class="space-y-0.5">
                            <span class="opacity-70 flex justify-between"><span>Taille</span><span>${Math.round((ov.nw || 0.28) * 100)}%</span></span>
                            <input type="range" min="0.08" max="0.9" step="0.02" value="${ov.nw || 0.28}"
                                   oninput="studioImageOverlays[${idx}].nw=parseFloat(this.value); _renderStudioImageOverlaysUI()"
                                   onchange="pushStudioHistorySnapshot()" class="studio-range"/>
                        </label>
                        <label class="space-y-0.5">
                            <span class="opacity-70 flex justify-between"><span>Opacité</span><span>${Math.round((ov.opacity ?? 1) * 100)}%</span></span>
                            <input type="range" min="0.1" max="1.0" step="0.05" value="${ov.opacity ?? 1.0}"
                                   oninput="studioImageOverlays[${idx}].opacity=parseFloat(this.value); _renderStudioImageOverlaysUI()"
                                   onchange="pushStudioHistorySnapshot()" class="studio-range"/>
                        </label>
                    </div>
                    ${studioIsVideo ? `
                    <div class="grid grid-cols-2 gap-1.5 text-[10px]">
                        <input type="number" min="0" step="0.5" placeholder="Début (s)" value="${ov.start_sec || 0}"
                               onchange="studioImageOverlays[${idx}].start_sec=parseFloat(this.value)||0; _renderStudioImageOverlaysUI(); pushStudioHistorySnapshot()"
                               class="bg-black/40 border border-white/15 rounded-lg px-2 py-0.5 tabular-nums"/>
                        <input type="number" min="0" step="0.5" placeholder="Fin (0=touj.)" value="${ov.end_sec || 0}"
                               onchange="studioImageOverlays[${idx}].end_sec=parseFloat(this.value)||0; _renderStudioImageOverlaysUI(); pushStudioHistorySnapshot()"
                               class="bg-black/40 border border-white/15 rounded-lg px-2 py-0.5 tabular-nums"/>
                    </div>` : ''}
                </div>
            `).join('');
    if (listEl) listEl.innerHTML = cardsHtml;
    if (decListEl) decListEl.innerHTML = cardsHtml;

    const stageLayer = document.getElementById('studio-img-overlays-layer');
    if (stageLayer) {
        if (_studioCompareOrig || !studioImageOverlays.length) {
            stageLayer.innerHTML = '';
        } else {
            const vidEl = document.getElementById('studio-video');
            const curT = vidEl ? Number(vidEl.currentTime || 0) : 0;
            stageLayer.innerHTML = studioImageOverlays.map((ov, idx) => {
                if (ov.hidden) return '';
                const stS = Number(ov.start_sec || 0), enS = Number(ov.end_sec || 0);
                if (studioIsVideo && enS > stS && (curT < stS || curT > enS)) return '';
                return `
                    <div data-ov-idx="${idx}" title="Glisser pour déplacer l'incrustation"
                         style="left:${(ov.nx * 100).toFixed(2)}%;top:${(ov.ny * 100).toFixed(2)}%;width:${(ov.nw * 100).toFixed(2)}%;opacity:${ov.opacity ?? 1.0};"
                         class="pointer-events-auto absolute group border border-dashed border-sky-300/60 hover:border-sky-300 rounded-md cursor-move">
                        <img src="/media?path=${encodeURIComponent(ov.path)}" draggable="false" class="w-full h-auto block pointer-events-none select-none rounded-md"/>
                        <button type="button" onclick="event.stopPropagation(); removeStudioImageOverlay(${idx})" title="Supprimer cette incrustation"
                                class="opacity-0 group-hover:opacity-100 absolute -top-2 -right-2 w-4 h-4 rounded-full bg-rose-500 text-white text-[10px] leading-none flex items-center justify-center shadow cursor-pointer">×</button>
                        <div data-ov-resize="${idx}" title="Redimensionner" class="opacity-0 group-hover:opacity-100 absolute -bottom-1.5 -right-1.5 w-3.5 h-3.5 rounded-full bg-sky-400 border border-black cursor-nwse-resize"></div>
                    </div>`;
            }).join('');
        }
    }

    const v2Rail = document.getElementById('studio-tl-v2-rail');
    if (v2Rail) {
        if (!studioImageOverlays.length) {
            v2Rail.innerHTML = '<span class="text-[10px] opacity-55">Aucune incrustation (+ Ajouter)</span>';
        } else {
            v2Rail.innerHTML = studioImageOverlays.map(ov =>
                `<span class="h-4 px-2 rounded-md bg-sky-500/30 border border-sky-300/40 text-[10px] font-bold truncate max-w-[140px]">${(ov.name || 'Image').replace(/</g, '&lt;')}</span>`
            ).join('');
        }
    }
    syncStudioTabBadges();
}

function toggleStudioDrawLayerHidden() {
    studioDrawLayerHidden = !studioDrawLayerHidden;
    _renderStudioBrushLayers();
    pushStudioHistorySnapshot();
}

function setStudioBorderStyle(style) {
    studioBorder.style = ['none', 'solid', 'polaroid'].includes(style) ? style : 'none';
    _syncStudioBorderUI();
    updateStudioLivePreview(true);
}

function onStudioBorderChange(recordHistory = false) {
    studioBorder.color = document.getElementById('st-border-color')?.value || '#ffffff';
    studioBorder.thickness = parseFloat(document.getElementById('st-border-size')?.value || '3') || 3;
    _syncStudioBorderUI();
    updateStudioLivePreview(recordHistory);
}

function _syncStudioBorderUI() {
    ['none', 'solid', 'polaroid'].forEach(st => {
        const b = document.getElementById(`st-bdr-${st}`);
        if (!b) return;
        const act = st === (studioBorder.style || 'none');
        b.className = act
            ? 'py-1.5 rounded-xl bg-white/25 text-white font-bold transition cursor-pointer'
            : 'py-1.5 rounded-xl bg-white/10 hover:bg-white/20 transition cursor-pointer';
    });
    const colEl = document.getElementById('st-border-color');
    if (colEl) colEl.value = studioBorder.color || '#ffffff';
    const szEl = document.getElementById('st-border-size');
    const szLbl = document.getElementById('st-border-size-val');
    if (szEl) szEl.value = String(studioBorder.thickness ?? 3);
    if (szLbl) szLbl.textContent = `${Number(studioBorder.thickness ?? 3).toFixed(1).replace(/\.0$/, '')}%`;

    const stage = document.getElementById('studio-stage');
    if (stage) {
        if (!studioBorder.style || studioBorder.style === 'none' || _studioCompareOrig) {
            stage.style.padding = '';
            stage.style.backgroundColor = '';
        } else {
            const px = Math.max(4, Math.round((studioBorder.thickness || 3) * 3.5));
            stage.style.backgroundColor = studioBorder.color || '#ffffff';
            stage.style.padding = studioBorder.style === 'polaroid'
                ? `${px}px ${px}px ${px * 3}px ${px}px`
                : `${px}px`;
        }
    }
}

function toggleStudioLayerHidden(kind, idx) {
    if (kind === 'image' && studioImageOverlays[idx]) {
        studioImageOverlays[idx].hidden = !studioImageOverlays[idx].hidden;
        _renderStudioImageOverlaysUI();
    } else if (kind === 'text' && studioExtraTextLayers[idx]) {
        studioExtraTextLayers[idx].hidden = !studioExtraTextLayers[idx].hidden;
        _renderStudioExtraTextListUI();
    }
    updateStudioLivePreview(true);
}

function moveStudioLayer(kind, idx, delta) {
    const arr = kind === 'image' ? studioImageOverlays : (kind === 'text' ? studioExtraTextLayers : null);
    if (!arr) return;
    const ni = idx + delta;
    if (ni < 0 || ni >= arr.length) return;
    [arr[idx], arr[ni]] = [arr[ni], arr[idx]];
    if (kind === 'image') _renderStudioImageOverlaysUI();
    else _renderStudioExtraTextListUI();
    updateStudioLivePreview(true);
}

function duplicateStudioLayer(kind, idx) {
    if (kind === 'image' && studioImageOverlays[idx]) {
        const copy = { ...studioImageOverlays[idx] };
        copy.nx = Math.min(0.85, (copy.nx || 0.1) + 0.04);
        copy.ny = Math.min(0.85, (copy.ny || 0.1) + 0.04);
        copy.name = `${copy.name || 'Image'} (copie)`;
        studioImageOverlays.splice(idx + 1, 0, copy);
        _renderStudioImageOverlaysUI();
    } else if (kind === 'text' && studioExtraTextLayers[idx]) {
        const copy = { ...studioExtraTextLayers[idx] };
        copy.nx = Math.min(0.85, (copy.nx || 0.12) + 0.04);
        copy.ny = Math.min(0.85, (copy.ny || 0.25) + 0.04);
        studioExtraTextLayers.splice(idx + 1, 0, copy);
        _renderStudioExtraTextListUI();
    }
    updateStudioLivePreview(true);
}

function _renderStudioLayersStackUI() {
    const listEl = document.getElementById('studio-layers-stack-list');
    const cntEl = document.getElementById('studio-layers-stack-count');
    if (!listEl) return;

    const rows = [];
    studioAppliedTemplates.forEach((tpl, idx) => {
        const isHidden = Boolean(tpl.hidden);
        const encId = encodeURIComponent(tpl.id || '');
        rows.push(`
            <div class="flex items-center justify-between gap-1.5 px-2 py-1.5 rounded-xl bg-amber-400/15 border border-amber-300/30 ${isHidden ? 'opacity-50' : ''}">
                <div class="flex items-center gap-1.5 min-w-0 flex-1">
                    <span class="px-1.5 py-0.5 rounded bg-amber-400/30 text-amber-100 text-[9px] font-extrabold shrink-0">MODÈLE</span>
                    <span class="truncate font-bold">${(tpl.name || 'Modèle').replace(/</g, '&lt;')}</span>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                    <button type="button" onclick="toggleStudioAppliedTemplateHidden(${idx})" class="px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-[10px] cursor-pointer">${isHidden ? 'Masqué' : 'Visible'}</button>
                    <button type="button" onclick="editStudioLayerTemplate(decodeURIComponent('${encId}'), ${idx})" title="Modifier ce modèle" class="text-amber-300 hover:text-amber-100 p-0.5 cursor-pointer"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
                    <button type="button" onclick="removeStudioAppliedTemplate(${idx})" title="Retirer ce modèle" class="px-1 text-rose-300 hover:text-rose-100 font-bold cursor-pointer">×</button>
                </div>
            </div>
        `);
    });

    const primaryTxt = (document.getElementById('st-text-val')?.value || '').trim();
    if (primaryTxt) {
        rows.push(`
            <div class="flex items-center justify-between gap-1.5 px-2 py-1.5 rounded-xl bg-white/10 border border-white/10">
                <div class="flex items-center gap-1.5 min-w-0 flex-1">
                    <span class="px-1.5 py-0.5 rounded bg-violet-500/30 text-violet-200 text-[9px] font-extrabold shrink-0">TXT</span>
                    <span class="truncate font-bold">${primaryTxt.replace(/</g, '&lt;')}</span>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                    <button type="button" onclick="selectStudioSidebarTab('decoration','text')" title="Modifier le texte" class="px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-[10px] cursor-pointer">Édit.</button>
                    <button type="button" onclick="clearPrimaryStudioText()" title="Supprimer" class="px-1 text-rose-300 hover:text-rose-100 font-bold cursor-pointer">×</button>
                </div>
            </div>
        `);
    }

    studioExtraTextLayers.forEach((tl, idx) => {
        const isHidden = Boolean(tl.hidden);
        rows.push(`
            <div class="flex items-center justify-between gap-1.5 px-2 py-1.5 rounded-xl bg-white/10 border border-white/10 ${isHidden ? 'opacity-50' : ''}">
                <div class="flex items-center gap-1.5 min-w-0 flex-1">
                    <span class="px-1.5 py-0.5 rounded bg-violet-500/30 text-violet-200 text-[9px] font-extrabold shrink-0">TXT</span>
                    <span class="truncate font-bold">${(tl.text || 'Texte').replace(/</g, '&lt;')}</span>
                </div>
                <div class="flex items-center gap-0.5 shrink-0">
                    <button type="button" onclick="toggleStudioLayerHidden('text', ${idx})" title="${isHidden ? 'Afficher' : 'Masquer'}" class="px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-[10px] cursor-pointer">${isHidden ? 'Masqué' : 'Visible'}</button>
                    <button type="button" onclick="moveStudioLayer('text', ${idx}, -1)" title="Monter" class="px-1 py-0.5 rounded hover:bg-white/15 cursor-pointer">↑</button>
                    <button type="button" onclick="moveStudioLayer('text', ${idx}, 1)" title="Descendre" class="px-1 py-0.5 rounded hover:bg-white/15 cursor-pointer">↓</button>
                    <button type="button" onclick="duplicateStudioLayer('text', ${idx})" title="Dupliquer" class="px-1 py-0.5 rounded hover:bg-white/15 text-[10px] cursor-pointer">+</button>
                    <button type="button" onclick="removeExtraStudioTextLayer(${idx})" title="Supprimer" class="px-1 text-rose-300 hover:text-rose-100 font-bold cursor-pointer">×</button>
                </div>
            </div>
        `);
    });

    studioImageOverlays.forEach((ov, idx) => {
        const isHidden = Boolean(ov.hidden);
        rows.push(`
            <div class="flex items-center justify-between gap-1.5 px-2 py-1.5 rounded-xl bg-white/10 border border-white/10 ${isHidden ? 'opacity-50' : ''}">
                <div class="flex items-center gap-1.5 min-w-0 flex-1">
                    <span class="px-1.5 py-0.5 rounded bg-sky-500/30 text-sky-200 text-[9px] font-extrabold shrink-0">IMG</span>
                    <span class="truncate font-bold">${(ov.name || 'Image').replace(/</g, '&lt;')}</span>
                </div>
                <div class="flex items-center gap-0.5 shrink-0">
                    <button type="button" onclick="toggleStudioLayerHidden('image', ${idx})" title="${isHidden ? 'Afficher' : 'Masquer'}" class="px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-[10px] cursor-pointer">${isHidden ? 'Masqué' : 'Visible'}</button>
                    <button type="button" onclick="moveStudioLayer('image', ${idx}, -1)" title="Monter" class="px-1 py-0.5 rounded hover:bg-white/15 cursor-pointer">↑</button>
                    <button type="button" onclick="moveStudioLayer('image', ${idx}, 1)" title="Descendre" class="px-1 py-0.5 rounded hover:bg-white/15 cursor-pointer">↓</button>
                    <button type="button" onclick="duplicateStudioLayer('image', ${idx})" title="Dupliquer" class="px-1 py-0.5 rounded hover:bg-white/15 text-[10px] cursor-pointer">+</button>
                    <button type="button" onclick="removeStudioImageOverlay(${idx})" title="Supprimer" class="px-1 text-rose-300 hover:text-rose-100 font-bold cursor-pointer">×</button>
                </div>
            </div>
        `);
    });

    if (studioDrawStrokes.length) {
        rows.push(`
            <div class="flex items-center justify-between gap-1.5 px-2 py-1.5 rounded-xl bg-white/10 border border-white/10 ${studioDrawLayerHidden ? 'opacity-50' : ''}">
                <div class="flex items-center gap-1.5 min-w-0 flex-1">
                    <span class="px-1.5 py-0.5 rounded bg-pink-500/30 text-pink-200 text-[9px] font-extrabold shrink-0">DESSIN</span>
                    <span class="truncate font-bold">${studioDrawStrokes.length} tracé(s)</span>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                    <button type="button" onclick="toggleStudioDrawLayerHidden()" class="px-1.5 py-0.5 rounded bg-white/10 hover:bg-white/20 text-[10px] cursor-pointer">${studioDrawLayerHidden ? 'Masqué' : 'Visible'}</button>
                    <button type="button" onclick="clearStudioBrushLayers()" title="Effacer le dessin" class="px-1 text-rose-300 hover:text-rose-100 font-bold cursor-pointer">×</button>
                </div>
            </div>
        `);
    }

    if (cntEl) cntEl.textContent = String(rows.length);
    listEl.innerHTML = rows.length
        ? rows.join('')
        : '<p class="text-[10px] opacity-55">Aucun calque actif. Ajoutez un texte, dessin ou image ci-dessous.</p>';
}

function moveStudioExtraClip(idx, delta) {
    const ni = idx + delta;
    if (ni < 0 || ni >= studioExtraClips.length) return;
    [studioExtraClips[idx], studioExtraClips[ni]] = [studioExtraClips[ni], studioExtraClips[idx]];
    _renderStudioExtraClipsUI();
    pushStudioHistorySnapshot();
}

function removeStudioExtraClip(idx) {
    studioExtraClips.splice(idx, 1);
    _renderStudioExtraClipsUI();
    syncStudioTimelineUI();
    pushStudioHistorySnapshot();
}

function _renderStudioExtraClipsUI() {
    const cntEl = document.getElementById('studio-clips-count');
    if (cntEl) cntEl.textContent = String(1 + studioExtraClips.length);

    const listEl = document.getElementById('studio-extra-clips-list');
    if (listEl) {
        const mainName = studioDestPath.split(/[\\/]/).pop() || 'Clip principal';
        const mainRow = `<div class="px-2 py-1.5 rounded-xl bg-amber-500/15 border border-amber-400/35 flex items-center justify-between"><span class="truncate font-extrabold text-[10px]">1. ${mainName.replace(/</g, '&lt;')}</span><span class="text-[9px] opacity-75">Principal</span></div>`;
        const extraRows = studioExtraClips.map((c, idx) => `
            <div class="px-2 py-1.5 rounded-xl bg-white/10 border border-white/10 flex items-center justify-between gap-1.5">
                <span class="truncate font-bold text-[10px] flex-1">${idx + 2}. ${(c.name || 'Clip').replace(/</g, '&lt;')}</span>
                <div class="flex items-center gap-1 shrink-0">
                    <button type="button" onclick="moveStudioExtraClip(${idx}, -1)" class="px-1 hover:bg-white/15 rounded cursor-pointer">↑</button>
                    <button type="button" onclick="moveStudioExtraClip(${idx}, 1)" class="px-1 hover:bg-white/15 rounded cursor-pointer">↓</button>
                    <button type="button" onclick="removeStudioExtraClip(${idx})" class="text-rose-300 hover:text-rose-100 px-1 font-bold cursor-pointer">×</button>
                </div>
            </div>
        `).join('');
        listEl.innerHTML = mainRow + extraRows;
    }

    const tlExtra = document.getElementById('studio-tl-extra-clips');
    if (tlExtra) {
        if (!studioExtraClips.length) {
            tlExtra.classList.add('hidden');
            tlExtra.innerHTML = '';
        } else {
            tlExtra.classList.remove('hidden');
            tlExtra.innerHTML = studioExtraClips.map((c, idx) => `
                <div class="h-10 min-w-[78px] max-w-[120px] px-2 rounded-xl bg-amber-500/20 border border-amber-300/45 flex items-center justify-between gap-1 shrink-0">
                    <span class="text-[10px] font-bold truncate">${(c.name || 'Clip').replace(/</g, '&lt;')}</span>
                    <button type="button" onclick="removeStudioExtraClip(${idx})" class="text-[11px] opacity-75 hover:opacity-100 cursor-pointer">×</button>
                </div>
            `).join('');
        }
    }
}

function _syncStudioMusicAudioSource() {
    const au = document.getElementById('studio-music-player');
    const path = (document.getElementById('st-vid-audio')?.value || '').trim();
    if (!au) return;
    if (!path) {
        au.pause();
        au.removeAttribute('src');
        au.load();
        return;
    }
    const targetSrc = `/media?path=${encodeURIComponent(path)}`;
    if (!au.getAttribute('data-path') || au.getAttribute('data-path') !== path) {
        au.setAttribute('data-path', path);
        au.src = targetSrc;
        au.load();
    }
}

function onStudioAudioPathChanged() {
    _syncStudioMusicAudioSource();
    syncStudioTimelineUI();
    syncStudioTabBadges();
}

function clearStudioAudioTrack() {
    const inp = document.getElementById('st-vid-audio');
    if (inp) inp.value = '';
    _syncStudioMusicAudioSource();
    syncStudioTimelineUI();
    pushStudioHistorySnapshot();
}

function syncStudioAudioVolumes() {
    const ov = parseFloat(document.getElementById('st-orig-vol')?.value ?? '1.0');
    const mv = parseFloat(document.getElementById('st-music-vol')?.value ?? '1.0');
    const ovLbl = document.getElementById('st-orig-vol-val');
    const mvLbl = document.getElementById('st-music-vol-val');
    if (ovLbl) ovLbl.textContent = `${Math.round(ov * 100)}%`;
    if (mvLbl) mvLbl.textContent = `${Math.round(mv * 100)}%`;
    const vidEl = document.getElementById('studio-video');
    if (vidEl && studioIsVideo) vidEl.volume = Math.max(0, Math.min(1, ov));
    const au = document.getElementById('studio-music-player');
    if (au) au.volume = Math.max(0, Math.min(1, mv));
}

function setStudioCompareOriginal(active) {
    _studioCompareOrig = Boolean(active);
    const btn = document.getElementById('studio-btn-compare');
    if (btn) btn.classList.toggle('bg-white/25', _studioCompareOrig);
    if (!studioIsVideo) refreshStudioPhotoStageSource();
    _applyStudioCropBoxUI();
    _renderStudioBrushLayers();
    updateStudioLivePreview();
}

function resetStudioEdits() {
    studioRotation = 0;
    studioStraighten = 0;
    studioFlipH = false;
    studioFlipV = false;
    _studioCompareOrig = false;
    _studioSplitCompare = false;
    _studioSplitPct = 50;
    _studioActivePreset = 'original';
    _studioCropAspect = 'free';
    studioImageOverlays = [];
    studioExtraTextLayers = [];
    studioExtraClips = [];
    studioAppliedTemplates = [];
    _studioDraftWatermarks = [];
    cancelEditStudioLayerTemplate();
    _renderStudioAppliedTemplatesStage();
    studioBgRemove = { enabled: false, mode: 'transparent' };
    studioAutoRetouch = { enabled: false, strength: 0.65, skin_wrinkles: true, redeye: true, blemish_glare: true };
    studioBorder = { style: 'none', color: '#ffffff', thickness: 3.0 };
    studioTextStyles = { bold: true, italic: false, shadow: true };
    _syncStudioTextStyleButtonsUI();
    _syncStudioToolsSubUI();
    _syncStudioBorderUI();
    _syncStudioAspectButtonsUI();
    clearStudioDrawings();
    resetStudioZoom();
    ['st-bright', 'st-contrast', 'st-sat', 'st-sharp', 'st-orig-vol', 'st-music-vol'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '1.0';
    });
    ['st-warmth', 'st-tint', 'st-highlights', 'st-shadows', 'st-fade', 'st-grain', 'st-vignette', 'st-straighten'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '0.0';
    });
    const pi = document.getElementById('st-preset-intensity'); if (pi) pi.value = '100';
    const svLbl = document.getElementById('st-straighten-val'); if (svLbl) svLbl.textContent = '0.0°';
    const txtEl = document.getElementById('st-text-val');
    if (txtEl) txtEl.value = '';
    const bgEl = document.getElementById('st-text-bg'); if (bgEl) bgEl.value = 'transparent';
    setStudioTextPresetPos(5, 86);
    const szEl = document.getElementById('st-text-size'); if (szEl) szEl.value = '40';
    const opEl = document.getElementById('st-text-opacity'); if (opEl) opEl.value = '1.0';
    const colEl = document.getElementById('st-text-color'); if (colEl) colEl.value = '#ffffff';
    const tStart = document.getElementById('st-text-start'); if (tStart) tStart.value = '0';
    const tEnd = document.getElementById('st-text-end'); if (tEnd) tEnd.value = '0';
    resetStudioTrim(false);
    const spEl = document.getElementById('st-vid-speed'); if (spEl) spEl.value = '1.0';
    const muEl = document.getElementById('st-vid-mute'); if (muEl) muEl.checked = false;
    const auEl = document.getElementById('st-vid-audio'); if (auEl) auEl.value = '';
    const mmEl = document.getElementById('st-audio-mix-mode'); if (mmEl) mmEl.value = 'replace';
    const vidEl = document.getElementById('studio-video');
    if (vidEl && studioIsVideo) {
        vidEl.playbackRate = 1.0;
        vidEl.muted = false;
        vidEl.volume = 1.0;
    }
    const splitBtn = document.getElementById('studio-btn-split');
    if (splitBtn) splitBtn.classList.remove('bg-white/25');
    _syncStudioSplitCompareUI();
    _renderStudioFilterPresetThumbs();
    _renderStudioImageOverlaysUI();
    _renderStudioExtraTextListUI();
    _renderStudioExtraClipsUI();
    syncStudioAudioVolumes();
    updateStudioLivePreview();
    syncStudioTimelineUI();
    _studioHistory = [_captureStudioSnapshot()];
    _studioHistoryIdx = 0;
    _syncStudioUndoRedoButtons();
}

function _renderStudioTimelineRuler(dur) {
    const ruler = document.getElementById('studio-tl-ruler');
    if (!ruler) return;
    if (!dur || dur <= 0) {
        ruler.innerHTML = '<span>0.0s</span><span>—</span>';
        return;
    }
    const ticks = 6;
    const out = [];
    for (let i = 0; i <= ticks; i++) {
        const t = (dur * i) / ticks;
        out.push(`<span>${t >= 60 ? _fmtStudioSec(t) : `${t.toFixed(1)}s`}</span>`);
    }
    ruler.innerHTML = out.join('');
}

function _renderStudioAudioWaveform(isMuted) {
    const wf = document.getElementById('studio-tl-waveform');
    if (!wf) return;
    const pattern = [4, 9, 13, 7, 14, 10, 6, 12, 15, 8, 5, 11, 14, 9, 6, 13, 10, 5, 8, 12, 7, 14, 9, 6, 11, 7, 14, 9];
    wf.innerHTML = pattern.map(h =>
        `<span class="w-[2px] rounded-full ${isMuted ? 'bg-white/30' : 'bg-emerald-300'}" style="height:${isMuted ? 3 : h}px;"></span>`
    ).join('');
}

async function _extractStudioVideoFilmstrip(srcUrl) {
    const strip = document.getElementById('studio-tl-filmstrip');
    if (!strip) return;
    strip.innerHTML = '';
    try {
        const probe = document.createElement('video');
        probe.muted = true;
        probe.playsInline = true;
        probe.crossOrigin = 'anonymous';
        probe.src = srcUrl;
        await new Promise((resolve, reject) => {
            probe.onloadedmetadata = resolve;
            probe.onerror = reject;
        });
        const dur = Number(probe.duration || 0);
        if (!dur || dur <= 0) return;
        const count = 8;
        const canvas = document.createElement('canvas');
        canvas.width = 96;
        canvas.height = 54;
        const ctx = canvas.getContext('2d');
        for (let i = 0; i < count; i++) {
            if (!studioIsVideo || document.getElementById('studio-modal')?.classList.contains('hidden')) break;
            const t = Math.min(Math.max(0.05, (dur * (i + 0.5)) / count), Math.max(0.05, dur - 0.05));
            probe.currentTime = t;
            await new Promise(res => { probe.onseeked = res; setTimeout(res, 350); });
            if (ctx) {
                ctx.drawImage(probe, 0, 0, canvas.width, canvas.height);
                const img = document.createElement('img');
                img.src = canvas.toDataURL('image/jpeg', 0.65);
                img.className = 'flex-1 h-full object-cover min-w-0';
                strip.appendChild(img);
            }
        }
        probe.removeAttribute('src');
    } catch (_) {}
}

function _bindStudioVideoListeners() {
    if (_studioVideoListenersBound) return;
    const vidEl = document.getElementById('studio-video');
    if (!vidEl) return;
    _studioVideoListenersBound = true;

    vidEl.addEventListener('loadedmetadata', () => {
        _studioVideoDur = Number(vidEl.duration || 0);
        _renderStudioTimelineRuler(_studioVideoDur);
        _syncStudioDimensionsBadge();
        syncStudioTimelineUI();
        _scheduleStudioHistogramUpdate();
    });
    vidEl.addEventListener('timeupdate', () => {
        const dur = _studioVideoDur || Number(vidEl.duration || 0);
        const startS = Math.max(0, parseFloat(document.getElementById('st-vid-start')?.value || '0') || 0);
        const rawEnd = parseFloat(document.getElementById('st-vid-end')?.value || '0') || 0;
        const endS = rawEnd > startS ? rawEnd : dur;
        if (_studioVideoLoop && endS > startS && vidEl.currentTime >= endS - 0.04) {
            vidEl.currentTime = startS;
        }
        syncStudioTimelineUI();
        if (studioImageOverlays.length) _renderStudioImageOverlaysUI();
        if (studioExtraTextLayers.length) _renderStudioExtraTextListUI();
    });
    const playSvg = `<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4"/></svg>`;
    const pauseSvg = `<svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
    vidEl.addEventListener('play', () => {
        const b = document.getElementById('studio-vid-play-btn');
        if (b) b.innerHTML = pauseSvg;
        const au = document.getElementById('studio-music-player');
        const customAu = (document.getElementById('st-vid-audio')?.value || '').trim();
        const isMuted = Boolean(document.getElementById('st-vid-mute')?.checked);
        if (au && customAu && !isMuted) {
            _syncStudioMusicAudioSource();
            try { au.currentTime = vidEl.currentTime || 0; } catch (_) {}
            au.playbackRate = vidEl.playbackRate || 1.0;
            au.play().catch(() => {});
        }
    });
    vidEl.addEventListener('pause', () => {
        const b = document.getElementById('studio-vid-play-btn');
        if (b) b.innerHTML = playSvg;
        const au = document.getElementById('studio-music-player');
        if (au) au.pause();
    });
    vidEl.addEventListener('seeked', () => {
        const au = document.getElementById('studio-music-player');
        const customAu = (document.getElementById('st-vid-audio')?.value || '').trim();
        if (au && customAu) {
            try { au.currentTime = vidEl.currentTime || 0; } catch (_) {}
        }
    });
}

function toggleStudioVideoPlay() {
    const vidEl = document.getElementById('studio-video');
    if (!vidEl || !studioIsVideo) return;
    if (vidEl.paused) {
        const startS = Math.max(0, parseFloat(document.getElementById('st-vid-start')?.value || '0') || 0);
        const rawEnd = parseFloat(document.getElementById('st-vid-end')?.value || '0') || 0;
        const endS = rawEnd > startS ? rawEnd : (_studioVideoDur || vidEl.duration || 0);
        if (vidEl.currentTime < startS || (endS > startS && vidEl.currentTime >= endS - 0.05)) {
            vidEl.currentTime = startS;
        }
        vidEl.play().catch(() => {});
    } else {
        vidEl.pause();
    }
}

function seekStudioToTrimIn() {
    const vidEl = document.getElementById('studio-video');
    if (!vidEl || !studioIsVideo) return;
    const startS = Math.max(0, parseFloat(document.getElementById('st-vid-start')?.value || '0') || 0);
    vidEl.currentTime = startS;
    syncStudioTimelineUI();
}

function stepStudioVideo(deltaSec) {
    const vidEl = document.getElementById('studio-video');
    if (!vidEl || !studioIsVideo) return;
    const dur = _studioVideoDur || Number(vidEl.duration || 0);
    vidEl.currentTime = Math.max(0, Math.min(dur || 99999, (vidEl.currentTime || 0) + deltaSec));
    syncStudioTimelineUI();
}

function toggleStudioVideoLoop() {
    _studioVideoLoop = !_studioVideoLoop;
    const btn = document.getElementById('studio-vid-loop-btn');
    if (btn) btn.className = _studioVideoLoop
        ? 'px-2.5 h-7 rounded-full bg-white/25 hover:bg-white/30 flex items-center gap-1 transition cursor-pointer'
        : 'px-2.5 h-7 rounded-full opacity-55 hover:bg-white/20 flex items-center gap-1 transition cursor-pointer';
}

function setStudioTrimInAtPlayhead() {
    const vidEl = document.getElementById('studio-video');
    const stIn = document.getElementById('st-vid-start');
    const stOut = document.getElementById('st-vid-end');
    if (!vidEl || !stIn) return;
    const cur = Number((vidEl.currentTime || 0).toFixed(1));
    const curOut = parseFloat(stOut?.value || '0') || 0;
    stIn.value = String(cur);
    if (curOut > 0 && curOut <= cur) stOut.value = '0';
    syncStudioTimelineUI();
    pushStudioHistorySnapshot();
}

function setStudioTrimOutAtPlayhead() {
    const vidEl = document.getElementById('studio-video');
    const stIn = document.getElementById('st-vid-start');
    const stOut = document.getElementById('st-vid-end');
    if (!vidEl || !stOut) return;
    const cur = Number((vidEl.currentTime || 0).toFixed(1));
    const curIn = parseFloat(stIn?.value || '0') || 0;
    stOut.value = cur > curIn ? String(cur) : String(Number((curIn + 0.5).toFixed(1)));
    syncStudioTimelineUI();
    pushStudioHistorySnapshot();
}

function resetStudioTrim(recordHistory = true) {
    const stIn = document.getElementById('st-vid-start');
    const stOut = document.getElementById('st-vid-end');
    if (stIn) stIn.value = '0';
    if (stOut) stOut.value = '0';
    syncStudioTimelineUI();
    if (recordHistory) pushStudioHistorySnapshot();
}

function onStudioTrimInputsChanged() {
    syncStudioTimelineUI();
    pushStudioHistorySnapshot();
}

function onStudioSpeedChanged() {
    const vidEl = document.getElementById('studio-video');
    const spd = parseFloat(document.getElementById('st-vid-speed')?.value || '1.0') || 1.0;
    if (vidEl && studioIsVideo) vidEl.playbackRate = spd;
    pushStudioHistorySnapshot();
}

function toggleStudioMuteQuick() {
    const cb = document.getElementById('st-vid-mute');
    if (!cb) return;
    cb.checked = !cb.checked;
    const vidEl = document.getElementById('studio-video');
    if (vidEl && studioIsVideo) vidEl.muted = cb.checked;
    syncStudioTimelineUI();
    pushStudioHistorySnapshot();
}

function syncStudioTimelineUI() {
    const vidEl = document.getElementById('studio-video');
    const dur = _studioVideoDur || (vidEl ? Number(vidEl.duration || 0) : 0);
    const cur = vidEl ? Number(vidEl.currentTime || 0) : 0;

    const tcEl = document.getElementById('studio-vid-timecode');
    if (tcEl) tcEl.textContent = `${_fmtStudioSec(cur)} / ${_fmtStudioSec(dur)}`;

    let startS = Math.max(0, parseFloat(document.getElementById('st-vid-start')?.value || '0') || 0);
    let rawEnd = Math.max(0, parseFloat(document.getElementById('st-vid-end')?.value || '0') || 0);
    if (dur > 0) {
        startS = Math.min(startS, Math.max(0, dur - 0.1));
        if (rawEnd > dur) rawEnd = 0;
    }
    const endS = rawEnd > startS ? rawEnd : dur;

    const rangeLbl = document.getElementById('studio-trim-range-label');
    if (rangeLbl) rangeLbl.textContent = `${startS.toFixed(1)}s → ${rawEnd > startS ? `${endS.toFixed(1)}s` : 'Fin'}`;
    const durLbl = document.getElementById('studio-trim-dur-label');
    if (durLbl) durLbl.textContent = dur > 0 ? `${Math.max(0, endS - startS).toFixed(1)}s` : '—';

    const playhead = document.getElementById('studio-tl-playhead');
    if (playhead && dur > 0) {
        playhead.style.left = `${Math.max(0, Math.min(100, (cur / dur) * 100))}%`;
    }
    const activeBar = document.getElementById('studio-tl-v1-active');
    const curtL = document.getElementById('studio-tl-curtain-left');
    const curtR = document.getElementById('studio-tl-curtain-right');
    if (activeBar && dur > 0) {
        const leftPct = Math.max(0, Math.min(98, (startS / dur) * 100));
        const rightPct = rawEnd > startS ? Math.max(0, Math.min(98, ((dur - rawEnd) / dur) * 100)) : 0;
        activeBar.style.left = `${leftPct}%`;
        activeBar.style.right = `${rightPct}%`;
        if (curtL) {
            curtL.style.width = `${leftPct}%`;
            curtL.classList.toggle('hidden', leftPct < 0.5);
        }
        if (curtR) {
            curtR.style.width = `${rightPct}%`;
            curtR.classList.toggle('hidden', rightPct < 0.5);
        }
    }

    const txtVal = (document.getElementById('st-text-val')?.value || '').trim();
    const t1Lbl = document.getElementById('studio-tl-t1-label');
    if (t1Lbl) {
        if (txtVal) {
            t1Lbl.textContent = studioExtraTextLayers.length
                ? `« ${txtVal} » (+${studioExtraTextLayers.length})`
                : `« ${txtVal} »`;
        } else if (studioExtraTextLayers.length) {
            t1Lbl.textContent = `${studioExtraTextLayers.length} calque(s) texte`;
        } else {
            t1Lbl.textContent = 'Cliquer pour ajouter un texte';
        }
    }

    const isMuted = Boolean(document.getElementById('st-vid-mute')?.checked);
    const customAu = (document.getElementById('st-vid-audio')?.value || '').trim();
    const mixMode = document.getElementById('st-audio-mix-mode')?.value || 'replace';
    const a1Lbl = document.getElementById('studio-tl-a1-label');
    const a1MuteBtn = document.getElementById('studio-tl-mute-btn');
    if (vidEl && studioIsVideo) vidEl.muted = isMuted || (Boolean(customAu) && mixMode === 'replace');
    const auPlayer = document.getElementById('studio-music-player');
    if (auPlayer) auPlayer.muted = isMuted;

    const totalPill = document.getElementById('studio-montage-total-pill');
    if (totalPill) {
        if (studioExtraClips.length > 0 && dur > 0) {
            const extraDur = studioExtraClips.reduce((acc, c) => acc + Math.max(1, Number(c.duration_sec || 3)), 0);
            totalPill.textContent = `Montage : ${1 + studioExtraClips.length} clips (~${(Math.max(0, endS - startS) + extraDur).toFixed(1)}s)`;
            totalPill.classList.remove('hidden');
        } else {
            totalPill.classList.add('hidden');
        }
    }
    _renderStudioAudioWaveform(isMuted);
    if (a1MuteBtn) {
        a1MuteBtn.classList.toggle('bg-rose-500/30', isMuted);
        a1MuteBtn.querySelector('span').textContent = isMuted ? 'Muet' : 'Son';
    }
    if (a1Lbl) {
        if (isMuted) a1Lbl.textContent = 'Piste audio coupée';
        else if (customAu) a1Lbl.textContent = `${mixMode === 'mix' ? 'Mix : ' : ''}${customAu.split(/[\\/]/).pop()}`;
        else a1Lbl.textContent = 'Audio original';
    }
}

async function refreshStudioPhotoStageSource() {
    if (studioIsVideo) return;
    const imgEl = document.getElementById('studio-img');
    if (!imgEl || !_studioOrigMediaUrl) return;

    if (_studioCompareOrig) {
        imgEl.src = _studioOrigMediaUrl;
        imgEl.style.transform = 'none';
        return;
    }

    const hasEraser = studioEraserBoxes.length > 0
        || studioEraserStrokes.length > 0
        || studioGlareStrokes.length > 0
        || studioRedeyeStrokes.length > 0
        || studioBlemishStrokes.length > 0
        || studioBgRemove.enabled
        || studioAutoRetouch.enabled;
    if (hasEraser) {
        const seq = ++_studioEraserReqSeq;
        const busyEl = document.getElementById('studio-eraser-busy');
        if (busyEl) busyEl.classList.remove('hidden');
        try {
            const res = await fetch('/api/studio/preview_eraser', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    source_path: studioSourcePath,
                    auto_orient: true,
                    rotate: studioRotation,
                    straighten: studioStraighten,
                    flip_h: studioFlipH,
                    flip_v: studioFlipV,
                    inpaint_boxes: studioEraserBoxes,
                    inpaint_strokes: studioEraserStrokes,
                    glare_strokes: studioGlareStrokes,
                    redeye_strokes: studioRedeyeStrokes,
                    blemish_strokes: studioBlemishStrokes,
                    bg_remove: studioBgRemove,
                    auto_retouch: studioAutoRetouch,
                }),
            });
            if (seq !== _studioEraserReqSeq) return;
            if (res.ok) {
                const blob = await res.blob();
                const nextUrl = URL.createObjectURL(blob);
                if (_studioEraserPreviewUrl) URL.revokeObjectURL(_studioEraserPreviewUrl);
                _studioEraserPreviewUrl = nextUrl;
                imgEl.src = nextUrl;
                imgEl.style.transform = 'none';
                return;
            }
        } catch (_) {
        } finally {
            if (seq === _studioEraserReqSeq && busyEl) busyEl.classList.add('hidden');
        }
    }

    if (studioRotation === 0 && Math.abs(studioStraighten) < 0.1 && !studioFlipH && !studioFlipV) {
        imgEl.src = _studioOrigMediaUrl;
        imgEl.style.transform = 'none';
        return;
    }

    const base = _studioOrigImgEl;
    if (base && base.complete && base.naturalWidth > 0) {
        const rot = ((studioRotation % 360) + 360) % 360;
        const swap = rot === 90 || rot === 270;
        const dw = swap ? base.naturalHeight : base.naturalWidth;
        const dh = swap ? base.naturalWidth : base.naturalHeight;
        const scale = Math.min(1, 1600 / Math.max(1, dw, dh));
        const cw = Math.max(1, Math.round(dw * scale));
        const ch = Math.max(1, Math.round(dh * scale));
        const cv = document.createElement('canvas');
        cv.width = cw;
        cv.height = ch;
        const ctx = cv.getContext('2d');
        if (ctx) {
            ctx.translate(cw / 2, ch / 2);
            const fineRad = (studioStraighten * Math.PI) / 180;
            const totalRad = ((rot * Math.PI) / 180) + fineRad;
            if (Math.abs(totalRad) > 0.001) ctx.rotate(totalRad);
            // Auto-zoom pour éviter les coins noirs lors du redressement
            if (Math.abs(studioStraighten) >= 0.1) {
                const ar = Math.abs(fineRad);
                const zoomFit = Math.cos(ar) + Math.sin(ar) * Math.max(cw / Math.max(1, ch), ch / Math.max(1, cw));
                ctx.scale(zoomFit, zoomFit);
            }
            ctx.scale(studioFlipH ? -1 : 1, studioFlipV ? -1 : 1);
            const drawW = swap ? ch : cw;
            const drawH = swap ? cw : ch;
            ctx.drawImage(base, -drawW / 2, -drawH / 2, drawW, drawH);
            imgEl.src = cv.toDataURL('image/jpeg', 0.92);
            imgEl.style.transform = 'none';
        }
    }
}

function openStudioModal(encSrc, encDest) {
    studioSourcePath = decodeURIComponent(encSrc);
    studioDestPath = decodeURIComponent(encDest);
    studioIsVideo = isVideoFile(studioDestPath);
    _studioVideoDur = 0;
    _studioShowEraserMasks = false;
    document.getElementById('studio-eraser-masks-btn')?.classList.remove('bg-rose-500/35');

    const fname = studioDestPath.split(/[\\/]/).pop() || 'Média';
    const fnEl = document.getElementById('studio-info-filename');
    if (fnEl) fnEl.textContent = fname;
    const v1NameEl = document.getElementById('studio-tl-v1-name');
    if (v1NameEl) v1NameEl.textContent = fname;

    document.getElementById('studio-center-photo-pill')?.classList.toggle('hidden', studioIsVideo);
    document.getElementById('studio-center-video-pill')?.classList.toggle('hidden', !studioIsVideo);
    document.getElementById('studio-video-timeline-dock')?.classList.toggle('hidden', !studioIsVideo);
    document.getElementById('studio-video-panel')?.classList.toggle('hidden', !studioIsVideo);
    document.getElementById('studio-media-video-section')?.classList.toggle('hidden', !studioIsVideo);
    document.getElementById('studio-text-timing-row')?.classList.toggle('hidden', !studioIsVideo);
    document.getElementById('studio-sharp-row')?.classList.toggle('hidden', studioIsVideo);
    document.getElementById('studio-grain-row')?.classList.toggle('hidden', studioIsVideo);
    document.getElementById('studio-tone-photo-group')?.classList.toggle('hidden', studioIsVideo);
    document.getElementById('studio-btn-split')?.classList.toggle('hidden', studioIsVideo);

    const imgEl = document.getElementById('studio-img');
    const vidEl = document.getElementById('studio-video');
    const url = `/media?path=${encodeURIComponent(studioDestPath)}&t=${Date.now()}`;
    _studioOrigMediaUrl = url;
    if (_studioEraserPreviewUrl) {
        URL.revokeObjectURL(_studioEraserPreviewUrl);
        _studioEraserPreviewUrl = '';
    }

    if (studioIsVideo) {
        _bindStudioVideoListeners();
        _studioOrigImgEl = null;
        imgEl.classList.add('hidden');
        vidEl.classList.remove('hidden');
        vidEl.src = url;
        vidEl.load();
        _extractStudioVideoFilmstrip(url);
    } else {
        vidEl.classList.add('hidden');
        vidEl.pause();
        vidEl.removeAttribute('src');
        imgEl.classList.remove('hidden');
        const pre = new Image();
        pre.onload = () => {
            _studioOrigImgEl = pre;
            _syncStudioDimensionsBadge();
            _scheduleStudioHistogramUpdate();
        };
        pre.src = url;
        imgEl.onload = () => {
            _syncStudioDimensionsBadge();
            _scheduleStudioHistogramUpdate();
            _renderStudioBrushLayers();
        };
        imgEl.src = url;
    }

    resetStudioEdits();
    loadStudioLayerTemplates();
    refreshStudioAiInpaintStatus();
    selectStudioSidebarTab('transform');
    setStudioMouseTool('NONE');
    document.getElementById('studio-modal').classList.remove('hidden');
}

function closeStudioModal() {
    if (_studioAiInstallTimer) {
        clearInterval(_studioAiInstallTimer);
        _studioAiInstallTimer = null;
    }
    const vidEl = document.getElementById('studio-video');
    if (vidEl) vidEl.pause();
    const au = document.getElementById('studio-music-player');
    if (au) au.pause();
    const curEl = document.getElementById('studio-eraser-cursor');
    if (curEl) curEl.classList.add('hidden');
    if (_studioEraserPreviewUrl) {
        URL.revokeObjectURL(_studioEraserPreviewUrl);
        _studioEraserPreviewUrl = '';
    }
    document.getElementById('studio-modal').classList.add('hidden');
}

function studioRotate(d) {
    studioRotation = (studioRotation + d + 360) % 360;
    if (!studioIsVideo) refreshStudioPhotoStageSource();
    updateStudioLivePreview(true);
}

function studioFlip(ax) {
    if (ax === 'H') studioFlipH = !studioFlipH;
    else studioFlipV = !studioFlipV;
    if (!studioIsVideo) refreshStudioPhotoStageSource();
    updateStudioLivePreview(true);
}

function updateStudioLivePreview(recordHistory = false) {
    const _num = (id, def) => {
        const v = parseFloat(document.getElementById(id)?.value);
        return Number.isFinite(v) ? v : def;
    };
    const b = _num('st-bright', 1.0);
    const c = _num('st-contrast', 1.0);
    const hi = _num('st-highlights', 0.0);
    const shd = _num('st-shadows', 0.0);
    const fade = _num('st-fade', 0.0);
    const s = _num('st-sat', 1.0);
    const w = _num('st-warmth', 0.0);
    const tint = _num('st-tint', 0.0);
    const sh = document.getElementById('st-sharp')?.value || '1.0';
    const gr = _num('st-grain', 0.0);
    const v = _num('st-vignette', 0.0);

    const setTxt = (id, t) => { const e = document.getElementById(id); if (e) e.textContent = t; };
    setTxt('st-bright-val', b.toFixed(2));
    setTxt('st-contrast-val', c.toFixed(2));
    setTxt('st-highlights-val', hi > 0 ? `+${Math.round(hi * 100)}` : String(Math.round(hi * 100)));
    setTxt('st-shadows-val', shd > 0 ? `+${Math.round(shd * 100)}` : String(Math.round(shd * 100)));
    setTxt('st-fade-val', `${Math.round(fade * 100)}%`);
    setTxt('st-sat-val', s.toFixed(2));
    setTxt('st-warmth-val', w > 0 ? `+${Math.round(w * 100)}` : String(Math.round(w * 100)));
    setTxt('st-tint-val', tint > 0 ? `+${Math.round(tint * 100)}` : String(Math.round(tint * 100)));
    setTxt('st-sharp-val', Number(sh).toFixed(1));
    setTxt('st-grain-val', `${Math.round(gr * 100)}%`);
    setTxt('st-vignette-val', `${Math.round(v * 100)}%`);

    const el = studioIsVideo ? document.getElementById('studio-video') : document.getElementById('studio-img');
    if (el) {
        if (_studioCompareOrig) {
            el.style.filter = 'none';
            el.style.transform = 'none';
        } else {
            const effB = Math.max(0.25, b + hi * 0.14 + shd * 0.16);
            const effC = Math.max(0.25, c - Math.abs(shd) * 0.08 - fade * 0.12);
            el.style.filter = `brightness(${effB.toFixed(2)}) contrast(${effC.toFixed(2)}) saturate(${s.toFixed(2)})`;
            el.style.transform = studioIsVideo
                ? `rotate(${studioRotation + studioStraighten}deg) scale(${studioFlipH ? -1 : 1}, ${studioFlipV ? -1 : 1})`
                : 'none';
        }
    }

    const warmOverlay = document.getElementById('studio-warmth-tint');
    if (warmOverlay) {
        if (_studioCompareOrig || (Math.abs(w) <= 0.01 && Math.abs(tint) <= 0.01)) {
            warmOverlay.classList.add('hidden');
        } else {
            const rC = Math.max(0, Math.min(255, Math.round(180 + w * 75 + tint * 55)));
            const gC = Math.max(0, Math.min(255, Math.round(170 - tint * 80)));
            const bC = Math.max(0, Math.min(255, Math.round(180 - w * 75 + tint * 55)));
            const alpha = Math.min(0.45, Math.max(Math.abs(w), Math.abs(tint)) * 0.38);
            warmOverlay.style.background = `rgba(${rC}, ${gC}, ${bC}, ${alpha.toFixed(2)})`;
            warmOverlay.classList.remove('hidden');
        }
    }

    const fadeOverlay = document.getElementById('studio-fade-overlay');
    if (fadeOverlay) {
        if (_studioCompareOrig || fade <= 0.01) {
            fadeOverlay.classList.add('hidden');
        } else {
            fadeOverlay.style.opacity = Math.min(0.85, fade * 0.75).toFixed(2);
            fadeOverlay.classList.remove('hidden');
        }
    }

    const grainOverlay = document.getElementById('studio-grain-overlay');
    if (grainOverlay) {
        if (_studioCompareOrig || studioIsVideo || gr <= 0.01) {
            grainOverlay.classList.add('hidden');
        } else {
            grainOverlay.style.opacity = Math.min(0.65, gr * 0.55).toFixed(2);
            grainOverlay.classList.remove('hidden');
        }
    }

    const vigOverlay = document.getElementById('studio-vignette-overlay');
    if (vigOverlay) {
        if (_studioCompareOrig || v <= 0.01) {
            vigOverlay.classList.add('hidden');
        } else {
            vigOverlay.style.background = `radial-gradient(ellipse at center, transparent 42%, rgba(0, 0, 0, ${(v * 0.78).toFixed(2)}) 100%)`;
            vigOverlay.classList.remove('hidden');
        }
    }

    const txtPrev = document.getElementById('studio-text-preview');
    const txtSpan = document.getElementById('studio-text-preview-span');
    const txtVal = (document.getElementById('st-text-val')?.value || '').trim();
    const tsNum = document.getElementById('st-text-size-num');
    if (tsNum) tsNum.value = document.getElementById('st-text-size')?.value || '40';
    const textOp = Math.max(0.1, Math.min(1.0, parseFloat(document.getElementById('st-text-opacity')?.value || '1.0') || 1.0));
    const toNum = document.getElementById('st-text-opacity-num');
    if (toNum) toNum.value = String(Math.round(textOp * 100));
    if (txtPrev) {
        if (_studioEditingTextIdx !== null && studioExtraTextLayers[_studioEditingTextIdx]) {
            const target = studioExtraTextLayers[_studioEditingTextIdx];
            const { font_family, font_path } = _getSelectedStudioTextFont();
            target.text = txtVal;
            target.nx = Math.max(0, Math.min(0.95, (parseFloat(document.getElementById('st-text-x')?.value || '5') || 0) / 100));
            target.ny = Math.max(0, Math.min(0.95, (parseFloat(document.getElementById('st-text-y')?.value || '86') || 0) / 100));
            target.size = Math.max(12, Math.min(140, parseInt(document.getElementById('st-text-size')?.value || '40', 10) || 40));
            target.color = document.getElementById('st-text-color')?.value || '#ffffff';
            target.bg_color = document.getElementById('st-text-bg')?.value || 'transparent';
            target.opacity = textOp;
            target.bold = Boolean(studioTextStyles.bold);
            target.italic = Boolean(studioTextStyles.italic);
            target.shadow = Boolean(studioTextStyles.shadow);
            target.font_family = font_family;
            target.font_path = font_path;
            txtPrev.classList.add('hidden');
        } else if (!txtVal || _studioCompareOrig) {
            txtPrev.classList.add('hidden');
        } else {
            const nx = Math.max(0, Math.min(95, parseFloat(document.getElementById('st-text-x')?.value || '5') || 0));
            const ny = Math.max(0, Math.min(95, parseFloat(document.getElementById('st-text-y')?.value || '86') || 0));
            const sz = Math.max(12, Math.min(140, parseInt(document.getElementById('st-text-size')?.value || '40', 10) || 40));
            const col = document.getElementById('st-text-color')?.value || '#ffffff';
            const bgMode = document.getElementById('st-text-bg')?.value || 'transparent';
            const { font_family, font_path } = _getSelectedStudioTextFont();
            if (font_family && font_path) _ensureStudioFontFace(font_family, font_path);
            if (txtSpan) txtSpan.textContent = txtVal;
            else txtPrev.textContent = txtVal;
            txtPrev.style.left = `${nx}%`;
            txtPrev.style.top = `${ny}%`;
            txtPrev.style.color = col;
            txtPrev.style.opacity = String(textOp);
            txtPrev.style.background = bgMode === 'dark' ? 'rgba(0,0,0,0.68)' : (bgMode === 'light' ? 'rgba(255,255,255,0.88)' : 'transparent');
            txtPrev.style.fontSize = `${Math.max(12, Math.round(sz * 0.55))}px`;
            txtPrev.style.fontFamily = font_family ? `'${font_family}', sans-serif` : '';
            txtPrev.style.fontWeight = studioTextStyles.bold ? '800' : '500';
            txtPrev.style.fontStyle = studioTextStyles.italic ? 'italic' : 'normal';
            txtPrev.style.textShadow = studioTextStyles.shadow ? '0 2px 6px rgba(0,0,0,0.92)' : 'none';
            txtPrev.classList.remove('hidden');
        }
    }
    _renderStudioExtraTextListUI();
    _renderStudioBrushLayers();
    _syncStudioSplitCompareUI();
    _syncStudioDimensionsBadge();
    _scheduleStudioHistogramUpdate();
    syncStudioTabBadges();
    if (studioIsVideo) syncStudioTimelineUI();
    if (recordHistory) pushStudioHistorySnapshot();
}

function _drawLiveEraserStrokePreview() {
    const cv = document.getElementById('studio-eraser-canvas');
    if (!cv || !stStage) return;
    if (!_studioActiveBrushStroke || !_studioActiveBrushStroke.points.length) {
        cv.classList.add('hidden');
        return;
    }
    const w = Math.max(1, stStage.clientWidth || Math.round(stStage.getBoundingClientRect().width));
    const h = Math.max(1, stStage.clientHeight || Math.round(stStage.getBoundingClientRect().height));
    if (cv.width !== w || cv.height !== h) {
        cv.width = w;
        cv.height = h;
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    const pts = _studioActiveBrushStroke.points;
    const brushPx = Number(document.getElementById('st-eraser-size')?.value || 24);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const strokeColors = {
        object: 'rgba(251, 113, 133, 0.58)',
        glare: 'rgba(56, 189, 248, 0.58)',
        redeye: 'rgba(251, 191, 36, 0.62)',
        blemish: 'rgba(52, 211, 153, 0.58)',
    };
    ctx.strokeStyle = strokeColors[_studioRetouchMode] || strokeColors.object;
    ctx.lineWidth = Math.max(2, brushPx / Math.max(0.25, _studioZoomScale));
    ctx.beginPath();
    pts.forEach((p, idx) => {
        const px = p.nx * w, py = p.ny * h;
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
    });
    if (pts.length === 1) {
        ctx.lineTo(pts[0].nx * w + 0.1, pts[0].ny * h + 0.1);
    }
    ctx.stroke();
    cv.classList.remove('hidden');
}

const stViewport = document.getElementById('studio-viewport');
if (stViewport) {
    stViewport.addEventListener('wheel', e => {
        if (document.getElementById('studio-modal')?.classList.contains('hidden')) return;
        e.preventDefault();
        adjustStudioZoom(e.deltaY < 0 ? 0.15 : -0.15);
    }, { passive: false });
    stViewport.addEventListener('mousedown', e => {
        const canPan = (e.button === 1) || e.altKey || (_studioZoomScale > 1.01 && studioMouseTool === 'NONE' && e.target === stViewport);
        if (canPan) {
            e.preventDefault();
            _studioPanDrag = { startX: e.clientX, startY: e.clientY, origX: _studioPanX, origY: _studioPanY };
        }
    });
}

const stStage = document.getElementById('studio-stage');
if (stStage) {
    stStage.addEventListener('mouseleave', () => {
        const curEl = document.getElementById('studio-eraser-cursor');
        if (curEl) curEl.classList.add('hidden');
    });
    stStage.addEventListener('mousedown', e => {
        // 0. Split Avant/Après divider drag
        if (e.target.closest('#studio-split-divider')) {
            e.stopPropagation();
            _studioSplitDrag = true;
            return;
        }

        // 0a. Shape resize / drag
        const shResIdx = e.target.getAttribute('data-shape-resize');
        if (shResIdx !== null) {
            e.stopPropagation();
            const idx = parseInt(shResIdx, 10);
            const st = studioDrawStrokes[idx];
            if (!st || !st.points || st.points.length < 2) return;
            const r = stStage.getBoundingClientRect();
            _studioShapeDrag = { mode: 'resize', idx, startX: e.clientX, startY: e.clientY, origP1: { ...st.points[st.points.length - 1] }, w: Math.max(1, r.width), h: Math.max(1, r.height) };
            return;
        }
        const shBox = e.target.closest('[data-shape-idx]');
        if (shBox) {
            e.stopPropagation();
            const idx = parseInt(shBox.getAttribute('data-shape-idx'), 10);
            const st = studioDrawStrokes[idx];
            if (!st || !st.points || st.points.length < 2) return;
            const r = stStage.getBoundingClientRect();
            _studioShapeDrag = { mode: 'move', idx, startX: e.clientX, startY: e.clientY, origP0: { ...st.points[0] }, origP1: { ...st.points[st.points.length - 1] }, w: Math.max(1, r.width), h: Math.max(1, r.height) };
            return;
        }

        // 0b. Image overlay resize / drag
        const ovResIdx = e.target.getAttribute('data-ov-resize');
        if (ovResIdx !== null) {
            e.stopPropagation();
            const idx = parseInt(ovResIdx, 10);
            const r = stStage.getBoundingClientRect();
            _studioOverlayDrag = { mode: 'resize', idx, startX: e.clientX, origNw: studioImageOverlays[idx].nw, w: Math.max(1, r.width) };
            return;
        }
        const ovBox = e.target.closest('[data-ov-idx]');
        if (ovBox) {
            e.stopPropagation();
            const idx = parseInt(ovBox.getAttribute('data-ov-idx'), 10);
            const r = stStage.getBoundingClientRect();
            _studioOverlayDrag = { mode: 'move', idx, startX: e.clientX, startY: e.clientY, origNx: studioImageOverlays[idx].nx, origNy: studioImageOverlays[idx].ny, w: Math.max(1, r.width), h: Math.max(1, r.height) };
            return;
        }

        // 0c. Extra text layer resize / drag
        const etResIdx = e.target.getAttribute('data-extra-text-resize');
        if (etResIdx !== null) {
            e.stopPropagation();
            const idx = parseInt(etResIdx, 10);
            _studioExtraTextDrag = { mode: 'resize', idx, startX: e.clientX, origSize: Number(studioExtraTextLayers[idx]?.size || 38) };
            return;
        }
        const etBox = e.target.closest('[data-extra-text-idx]');
        if (etBox) {
            e.stopPropagation();
            const idx = parseInt(etBox.getAttribute('data-extra-text-idx'), 10);
            const r = stStage.getBoundingClientRect();
            _studioExtraTextDrag = { mode: 'move', idx, startX: e.clientX, startY: e.clientY, origNx: studioExtraTextLayers[idx].nx, origNy: studioExtraTextLayers[idx].ny, w: Math.max(1, r.width), h: Math.max(1, r.height) };
            return;
        }

        // 1. Direct text resize / drag on stage
        if (e.target.getAttribute('data-text-resize') === 'main') {
            e.stopPropagation();
            _studioTextDrag = {
                mode: 'resize',
                startX: e.clientX,
                origSize: parseInt(document.getElementById('st-text-size')?.value || '40', 10) || 40,
            };
            return;
        }
        if (e.target.closest('#studio-text-preview')) {
            e.stopPropagation();
            const r = stStage.getBoundingClientRect();
            _studioTextDrag = {
                mode: 'move',
                startX: e.clientX,
                startY: e.clientY,
                origNx: parseFloat(document.getElementById('st-text-x')?.value || '5') / 100,
                origNy: parseFloat(document.getElementById('st-text-y')?.value || '86') / 100,
                w: Math.max(1, r.width),
                h: Math.max(1, r.height),
            };
            return;
        }

        // 2. Existing crop handle drag (8 corners/edges + move)
        const handle = e.target.getAttribute('data-crop-handle');
        if (handle && studioCropRect) {
            e.stopPropagation();
            _studioCropDrag = {
                handle,
                startX: e.clientX,
                startY: e.clientY,
                rect: { ...studioCropRect },
                stageRect: stStage.getBoundingClientRect(),
            };
            return;
        }

        if (studioMouseTool === 'NONE') {
            if (_studioZoomScale > 1.01) {
                _studioPanDrag = { startX: e.clientX, startY: e.clientY, origX: _studioPanX, origY: _studioPanY };
            }
            return;
        }
        e.preventDefault();
        const r = stStage.getBoundingClientRect();
        studioDrawing = true;
        stStartX = Math.max(0, Math.min(e.clientX - r.left, r.width));
        stStartY = Math.max(0, Math.min(e.clientY - r.top, r.height));
        if (studioMouseTool === 'CROP') {
            if (studioCropRect) {
                studioDrawing = false;
                return;
            }
            window._studioPendingCropBackup = null;
        } else if (studioMouseTool === 'BRUSH') {
            const brushPx = Number(document.getElementById('st-brush-size')?.value || 16);
            const opacity = parseFloat(document.getElementById('st-brush-opacity')?.value || '1.0') || 1.0;
            const nr = (brushPx * 0.5) / Math.max(1, r.width, r.height);
            const effMode = _studioBrushMode === 'blur' ? _studioBrushBlurStyle : _studioBrushMode;
            const pt0 = { nx: stStartX / Math.max(1, r.width), ny: stStartY / Math.max(1, r.height) };
            _studioActiveDrawStroke = {
                mode: effMode,
                shape: effMode === 'shape' ? _studioBrushShape : undefined,
                fill: effMode === 'shape' ? Boolean(document.getElementById('st-shape-fill')?.checked) : undefined,
                color: _studioBrushColor || '#f43f5e',
                opacity,
                nr,
                points: effMode === 'shape' ? [pt0, { ...pt0 }] : [pt0],
            };
            _renderStudioBrushLayers();
        } else if (studioMouseTool === 'ERASER' && !studioIsVideo) {
            const brushPx = Number(document.getElementById('st-eraser-size')?.value || 24);
            const nr = (brushPx * 0.5) / Math.max(1, r.width, r.height);
            _studioActiveBrushStroke = {
                nr,
                points: [{ nx: stStartX / Math.max(1, r.width), ny: stStartY / Math.max(1, r.height) }],
            };
            _drawLiveEraserStrokePreview();
        }
    });
}

window.addEventListener('mousemove', e => {
    if (_studioPanDrag) {
        _studioPanX = _studioPanDrag.origX + (e.clientX - _studioPanDrag.startX);
        _studioPanY = _studioPanDrag.origY + (e.clientY - _studioPanDrag.startY);
        const wrap = document.getElementById('studio-zoom-wrap');
        if (wrap) wrap.style.transform = `translate(${_studioPanX}px, ${_studioPanY}px) scale(${_studioZoomScale})`;
        return;
    }
    if (_studioSplitDrag && stStage) {
        const sr = stStage.getBoundingClientRect();
        _studioSplitPct = Math.max(4, Math.min(96, ((e.clientX - sr.left) / Math.max(1, sr.width)) * 100));
        _syncStudioSplitCompareUI();
        return;
    }

    if (_studioShapeDrag) {
        const st = studioDrawStrokes[_studioShapeDrag.idx];
        if (!st || !st.points || st.points.length < 2) return;
        const dx = (e.clientX - _studioShapeDrag.startX) / _studioShapeDrag.w;
        const dy = (e.clientY - _studioShapeDrag.startY) / _studioShapeDrag.h;
        if (_studioShapeDrag.mode === 'resize') {
            st.points[st.points.length - 1] = {
                nx: Math.max(0, Math.min(1, _studioShapeDrag.origP1.nx + dx)),
                ny: Math.max(0, Math.min(1, _studioShapeDrag.origP1.ny + dy)),
            };
        } else {
            st.points[0] = {
                nx: Math.max(0, Math.min(1, _studioShapeDrag.origP0.nx + dx)),
                ny: Math.max(0, Math.min(1, _studioShapeDrag.origP0.ny + dy)),
            };
            st.points[st.points.length - 1] = {
                nx: Math.max(0, Math.min(1, _studioShapeDrag.origP1.nx + dx)),
                ny: Math.max(0, Math.min(1, _studioShapeDrag.origP1.ny + dy)),
            };
        }
        _renderStudioBrushLayers();
        return;
    }

    if (_studioOverlayDrag) {
        const ov = studioImageOverlays[_studioOverlayDrag.idx];
        if (!ov) return;
        if (_studioOverlayDrag.mode === 'resize') {
            const dx = (e.clientX - _studioOverlayDrag.startX) / _studioOverlayDrag.w;
            ov.nw = Math.max(0.08, Math.min(0.92, _studioOverlayDrag.origNw + dx));
        } else {
            const dx = (e.clientX - _studioOverlayDrag.startX) / _studioOverlayDrag.w;
            const dy = (e.clientY - _studioOverlayDrag.startY) / _studioOverlayDrag.h;
            ov.nx = Math.max(0, Math.min(0.92, _studioOverlayDrag.origNx + dx));
            ov.ny = Math.max(0, Math.min(0.92, _studioOverlayDrag.origNy + dy));
        }
        _renderStudioImageOverlaysUI();
        return;
    }

    if (_studioExtraTextDrag) {
        const tl = studioExtraTextLayers[_studioExtraTextDrag.idx];
        if (!tl) return;
        if (_studioExtraTextDrag.mode === 'resize') {
            const delta = Math.round((e.clientX - _studioExtraTextDrag.startX) * 0.4);
            tl.size = Math.max(12, Math.min(140, _studioExtraTextDrag.origSize + delta));
        } else {
            const dx = (e.clientX - _studioExtraTextDrag.startX) / _studioExtraTextDrag.w;
            const dy = (e.clientY - _studioExtraTextDrag.startY) / _studioExtraTextDrag.h;
            tl.nx = Math.max(0, Math.min(0.92, _studioExtraTextDrag.origNx + dx));
            tl.ny = Math.max(0, Math.min(0.92, _studioExtraTextDrag.origNy + dy));
        }
        _renderStudioExtraTextListUI();
        return;
    }

    // 0. Floating brush cursor in ERASER or BRUSH mode
    if ((studioMouseTool === 'ERASER' || studioMouseTool === 'BRUSH') && stStage && !document.getElementById('studio-modal')?.classList.contains('hidden')) {
        const sr = stStage.getBoundingClientRect();
        const curEl = document.getElementById('studio-eraser-cursor');
        if (curEl) {
            const inside = e.clientX >= sr.left && e.clientX <= sr.right && e.clientY >= sr.top && e.clientY <= sr.bottom;
            curEl.classList.toggle('hidden', !inside);
            if (inside) {
                curEl.style.left = `${e.clientX}px`;
                curEl.style.top = `${e.clientY}px`;
            }
        }
    }

    // 1. Timeline In/Out & playhead drag
    if (_studioTlDragMode) {
        const rail = document.getElementById('studio-tl-v1-rail');
        const vidEl = document.getElementById('studio-video');
        const dur = _studioVideoDur || (vidEl ? Number(vidEl.duration || 0) : 0);
        if (!rail || dur <= 0) return;
        const rr = rail.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (e.clientX - rr.left) / Math.max(1, rr.width)));
        const sec = Number((ratio * dur).toFixed(1));
        const stIn = document.getElementById('st-vid-start');
        const stOut = document.getElementById('st-vid-end');
        if (_studioTlDragMode === 'in' && stIn) {
            const curOut = parseFloat(stOut?.value || '0') || dur;
            const maxIn = Math.max(0, (curOut > 0 ? curOut : dur) - 0.3);
            const nextIn = Math.min(sec, Number(maxIn.toFixed(1)));
            stIn.value = String(nextIn);
            if (vidEl) vidEl.currentTime = nextIn;
        } else if (_studioTlDragMode === 'out' && stOut) {
            const curIn = parseFloat(stIn?.value || '0') || 0;
            const nextOut = Math.max(curIn + 0.3, Math.min(dur, sec));
            stOut.value = nextOut >= dur - 0.15 ? '0' : String(Number(nextOut.toFixed(1)));
            if (vidEl) vidEl.currentTime = Math.min(dur, nextOut);
        } else if (_studioTlDragMode === 'scrub' && vidEl) {
            vidEl.currentTime = Math.max(0, Math.min(dur, sec));
        }
        syncStudioTimelineUI();
        return;
    }

    // 2. Direct text positioning & resize drag
    if (_studioTextDrag) {
        if (_studioTextDrag.mode === 'resize') {
            const delta = Math.round((e.clientX - _studioTextDrag.startX) * 0.4);
            const nextSz = Math.max(12, Math.min(140, _studioTextDrag.origSize + delta));
            const szEl = document.getElementById('st-text-size');
            if (szEl) szEl.value = String(nextSz);
            updateStudioLivePreview();
            return;
        }
        const dx = (e.clientX - _studioTextDrag.startX) / _studioTextDrag.w;
        const dy = (e.clientY - _studioTextDrag.startY) / _studioTextDrag.h;
        const nx = Math.max(0, Math.min(92, Math.round((_studioTextDrag.origNx + dx) * 100)));
        const ny = Math.max(0, Math.min(92, Math.round((_studioTextDrag.origNy + dy) * 100)));
        const xEl = document.getElementById('st-text-x'); if (xEl) xEl.value = String(nx);
        const yEl = document.getElementById('st-text-y'); if (yEl) yEl.value = String(ny);
        updateStudioLivePreview();
        return;
    }

    // 3. Interactive crop handle resize / move
    if (_studioCropDrag) {
        const { handle, startX: sx, startY: sy, rect, stageRect } = _studioCropDrag;
        const W = Math.max(1, stageRect.width);
        const H = Math.max(1, stageRect.height);
        const dxPx = e.clientX - sx;
        const dyPx = e.clientY - sy;
        let left = rect.nx * W;
        let top = rect.ny * H;
        let right = (rect.nx + rect.nw) * W;
        let bottom = (rect.ny + rect.nh) * H;
        const minPx = 24;
        const targetRatio = _parseCropAspectValue();

        if (handle === 'move') {
            const wPx = right - left;
            const hPx = bottom - top;
            left = Math.max(0, Math.min(W - wPx, left + dxPx));
            top = Math.max(0, Math.min(H - hPx, top + dyPx));
            right = left + wPx;
            bottom = top + hPx;
        } else if (!targetRatio) {
            if (handle.includes('w')) left = Math.max(0, Math.min(right - minPx, left + dxPx));
            if (handle.includes('e')) right = Math.min(W, Math.max(left + minPx, right + dxPx));
            if (handle.includes('n')) top = Math.max(0, Math.min(bottom - minPx, top + dyPx));
            if (handle.includes('s')) bottom = Math.min(H, Math.max(top + minPx, bottom + dyPx));
        } else if (handle === 'n' || handle === 's') {
            const cx = (left + right) * 0.5;
            if (handle === 'n') top = Math.max(0, Math.min(bottom - minPx, top + dyPx));
            else bottom = Math.min(H, Math.max(top + minPx, bottom + dyPx));
            let hPx = bottom - top;
            let wPx = hPx * targetRatio;
            if (wPx > W) {
                wPx = W;
                hPx = wPx / targetRatio;
                if (handle === 'n') top = bottom - hPx;
                else bottom = top + hPx;
            }
            left = Math.max(0, Math.min(W - wPx, cx - wPx * 0.5));
            right = left + wPx;
        } else {
            if (handle.includes('w')) left = Math.max(0, Math.min(right - minPx, left + dxPx));
            else if (handle.includes('e')) right = Math.min(W, Math.max(left + minPx, right + dxPx));
            let wPx = right - left;
            let hPx = wPx / targetRatio;
            if (handle.includes('n')) {
                const maxH = bottom;
                if (hPx > maxH) {
                    hPx = maxH;
                    wPx = hPx * targetRatio;
                    if (handle.includes('w')) left = right - wPx;
                    else right = left + wPx;
                }
                top = bottom - hPx;
            } else if (handle.includes('s')) {
                const maxH = H - top;
                if (hPx > maxH) {
                    hPx = maxH;
                    wPx = hPx * targetRatio;
                    if (handle.includes('w')) left = right - wPx;
                    else right = left + wPx;
                }
                bottom = top + hPx;
            } else {
                const cy = (top + bottom) * 0.5;
                if (hPx > H) {
                    hPx = H;
                    wPx = hPx * targetRatio;
                    if (handle.includes('w')) left = right - wPx;
                    else right = left + wPx;
                }
                top = Math.max(0, Math.min(H - hPx, cy - hPx * 0.5));
                bottom = top + hPx;
            }
        }
        studioCropRect = {
            nx: Math.max(0, left / W),
            ny: Math.max(0, top / H),
            nw: Math.max(0, (right - left) / W),
            nh: Math.max(0, (bottom - top) / H),
        };
        _applyStudioCropBoxUI();
        return;
    }

    // 4. Fresh crop rectangle draw OR live brush stroke
    if (!studioDrawing || !stStage) return;
    const r = stStage.getBoundingClientRect();
    const cx = Math.max(0, Math.min(e.clientX - r.left, r.width));
    const cy = Math.max(0, Math.min(e.clientY - r.top, r.height));
    let x = Math.min(stStartX, cx), y = Math.min(stStartY, cy);
    let w = Math.abs(cx - stStartX), h = Math.abs(cy - stStartY);

    if (studioMouseTool === 'CROP') {
        if (Math.hypot(cx - stStartX, cy - stStartY) < 8) return;
        const targetRatio = _parseCropAspectValue();
        if (targetRatio && w > 4) {
            const maxW = cx >= stStartX ? (r.width - stStartX) : stStartX;
            const maxH = cy >= stStartY ? (r.height - stStartY) : stStartY;
            w = Math.min(w, maxW);
            h = w / targetRatio;
            if (h > maxH) {
                h = maxH;
                w = h * targetRatio;
            }
            x = cx >= stStartX ? stStartX : Math.max(0, stStartX - w);
            y = cy >= stStartY ? stStartY : Math.max(0, stStartY - h);
        }
        studioCropRect = {
            nx: Math.max(0, x / Math.max(1, r.width)),
            ny: Math.max(0, y / Math.max(1, r.height)),
            nw: Math.min(1, w / Math.max(1, r.width)),
            nh: Math.min(1, h / Math.max(1, r.height))
        };
        _applyStudioCropBoxUI();
    } else if (studioMouseTool === 'BRUSH' && _studioActiveDrawStroke) {
        const nx = cx / Math.max(1, r.width);
        const ny = cy / Math.max(1, r.height);
        const pts = _studioActiveDrawStroke.points;
        if (_studioActiveDrawStroke.mode === 'shape') {
            pts[1] = { nx, ny };
            _renderStudioBrushLayers();
        } else {
            const last = pts[pts.length - 1];
            if (!last || Math.hypot(nx - last.nx, ny - last.ny) > 0.003) {
                pts.push({ nx, ny });
                _renderStudioBrushLayers();
            }
        }
    } else if (studioMouseTool === 'ERASER' && !studioIsVideo && _studioActiveBrushStroke) {
        const nx = cx / Math.max(1, r.width);
        const ny = cy / Math.max(1, r.height);
        const pts = _studioActiveBrushStroke.points;
        const last = pts[pts.length - 1];
        if (!last || Math.hypot(nx - last.nx, ny - last.ny) > 0.004) {
            pts.push({ nx, ny });
            _drawLiveEraserStrokePreview();
        }
    }
});

window.addEventListener('mouseup', e => {
    if (_studioPanDrag) {
        _studioPanDrag = null;
        return;
    }
    if (_studioSplitDrag) {
        _studioSplitDrag = false;
        return;
    }
    if (_studioShapeDrag) {
        _studioShapeDrag = null;
        pushStudioHistorySnapshot();
        return;
    }
    if (_studioOverlayDrag) {
        _studioOverlayDrag = null;
        pushStudioHistorySnapshot();
        return;
    }
    if (_studioExtraTextDrag) {
        _studioExtraTextDrag = null;
        pushStudioHistorySnapshot();
        return;
    }
    if (_studioTlDragMode) {
        const wasTrim = _studioTlDragMode === 'in' || _studioTlDragMode === 'out';
        _studioTlDragMode = null;
        if (wasTrim) pushStudioHistorySnapshot();
        return;
    }
    if (_studioTextDrag) {
        _studioTextDrag = null;
        pushStudioHistorySnapshot();
        return;
    }
    if (_studioCropDrag) {
        _studioCropDrag = null;
        pushStudioHistorySnapshot();
        return;
    }
    if (!studioDrawing || !stStage) return;
    studioDrawing = false;
    if (studioMouseTool === 'CROP') {
        const backup = window._studioPendingCropBackup || null;
        window._studioPendingCropBackup = null;
        const r = stStage.getBoundingClientRect();
        const cx = Math.max(0, Math.min(e.clientX - r.left, r.width));
        const cy = Math.max(0, Math.min(e.clientY - r.top, r.height));
        const dragged = Math.hypot(cx - stStartX, cy - stStartY) >= 8;
        if (!dragged || !studioCropRect || studioCropRect.nw < 0.02 || studioCropRect.nh < 0.02) {
            if (backup) {
                studioCropRect = backup;
                _applyStudioCropBoxUI();
            }
        } else {
            pushStudioHistorySnapshot();
        }
        return;
    }
    if (studioMouseTool === 'BRUSH') {
        if (_studioActiveDrawStroke) {
            studioDrawStrokes.push(_studioActiveDrawStroke);
            _studioActiveDrawStroke = null;
            _renderStudioBrushLayers();
            pushStudioHistorySnapshot();
        }
        return;
    }
    if (studioMouseTool === 'ERASER') {
        if (!studioIsVideo && _studioActiveBrushStroke) {
            if (_studioRetouchMode === 'glare') studioGlareStrokes.push(_studioActiveBrushStroke);
            else if (_studioRetouchMode === 'redeye') studioRedeyeStrokes.push(_studioActiveBrushStroke);
            else if (_studioRetouchMode === 'blemish') studioBlemishStrokes.push(_studioActiveBrushStroke);
            else studioEraserStrokes.push(_studioActiveBrushStroke);
            _studioRetouchUndoOrder.push(_studioRetouchMode);
            _studioActiveBrushStroke = null;
            _drawLiveEraserStrokePreview();
            _renderStudioEraserBoxes();
            refreshStudioPhotoStageSource();
            pushStudioHistorySnapshot();
            return;
        }
        const r = stStage.getBoundingClientRect();
        const cx = Math.max(0, Math.min(e.clientX - r.left, r.width));
        const cy = Math.max(0, Math.min(e.clientY - r.top, r.height));
        const x = Math.min(stStartX, cx), y = Math.min(stStartY, cy);
        const w = Math.abs(cx - stStartX), h = Math.abs(cy - stStartY);
        if (w > 8 && h > 8) {
            studioEraserBoxes.push({
                nx: x / Math.max(1, r.width),
                ny: y / Math.max(1, r.height),
                nw: w / Math.max(1, r.width),
                nh: h / Math.max(1, r.height)
            });
            _studioRetouchUndoOrder.push('box');
            _renderStudioEraserBoxes();
            pushStudioHistorySnapshot();
        }
    }
});

const _tlTracksWrap = document.getElementById('studio-tl-tracks-wrap');
if (_tlTracksWrap) {
    _tlTracksWrap.addEventListener('mousedown', e => {
        const handle = e.target.closest('[data-handle]')?.getAttribute('data-handle');
        if (handle === 'in' || handle === 'out') {
            e.stopPropagation();
            _studioTlDragMode = handle;
            return;
        }
        _studioTlDragMode = 'scrub';
        const rail = document.getElementById('studio-tl-v1-rail');
        const vidEl = document.getElementById('studio-video');
        const dur = _studioVideoDur || (vidEl ? Number(vidEl.duration || 0) : 0);
        if (rail && vidEl && dur > 0) {
            const rr = rail.getBoundingClientRect();
            const ratio = Math.max(0, Math.min(1, (e.clientX - rr.left) / Math.max(1, rr.width)));
            vidEl.currentTime = Number((ratio * dur).toFixed(2));
            syncStudioTimelineUI();
        }
    });
}

async function browseStudioAudio() {
    const res = await fetch('/api/dialog/browse?mode=audio');
    const d = await res.json();
    if (d.paths && d.paths.length) {
        const inp = document.getElementById('st-vid-audio');
        if (inp) inp.value = d.paths[0];
        onStudioAudioPathChanged();
        pushStudioHistorySnapshot();
    }
}

async function applyStudioChanges(videoAction = 'EDIT', overwriteMode = false) {
    const isOverwrite = Boolean(overwriteMode);
    const txtVal = (document.getElementById('st-text-val')?.value || '').trim();
    const vidEl = document.getElementById('studio-video');
    const copyBtn = document.getElementById('studio-save-copy-btn');
    const owBtn = document.getElementById('studio-save-overwrite-btn');
    const activeBtn = isOverwrite ? owBtn : copyBtn;
    if (copyBtn) copyBtn.disabled = true;
    if (owBtn) owBtn.disabled = true;
    if (activeBtn) activeBtn.textContent = 'Enregistrement...';
    try {
        const brushData = _exportStudioBrushPayloads();
        const res = await fetch('/api/studio/apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source_path: studioSourcePath,
                overwrite: isOverwrite,
                auto_orient: true,
                crop: studioCropRect,
                rotate: studioRotation,
                straighten: studioStraighten,
                flip_h: studioFlipH,
                flip_v: studioFlipV,
                brightness: parseFloat(document.getElementById('st-bright')?.value || '1.0'),
                contrast: parseFloat(document.getElementById('st-contrast')?.value || '1.0'),
                saturation: parseFloat(document.getElementById('st-sat')?.value || '1.0'),
                sharpness: parseFloat(document.getElementById('st-sharp')?.value || '1.0'),
                warmth: parseFloat(document.getElementById('st-warmth')?.value || '0.0'),
                tint: parseFloat(document.getElementById('st-tint')?.value || '0.0'),
                highlights: parseFloat(document.getElementById('st-highlights')?.value || '0.0'),
                shadows: parseFloat(document.getElementById('st-shadows')?.value || '0.0'),
                fade: parseFloat(document.getElementById('st-fade')?.value || '0.0'),
                grain: parseFloat(document.getElementById('st-grain')?.value || '0.0'),
                vignette: parseFloat(document.getElementById('st-vignette')?.value || '0.0'),
                text_overlay: txtVal ? (() => {
                    const f = _getSelectedStudioTextFont();
                    return {
                        text: txtVal,
                        nx: parseFloat(document.getElementById('st-text-x')?.value || '5') / 100.0,
                        ny: parseFloat(document.getElementById('st-text-y')?.value || '86') / 100.0,
                        size: parseInt(document.getElementById('st-text-size')?.value || '40', 10),
                        color: document.getElementById('st-text-color')?.value || '#ffffff',
                        bg_color: document.getElementById('st-text-bg')?.value || 'transparent',
                        opacity: parseFloat(document.getElementById('st-text-opacity')?.value || '1.0') || 1.0,
                        bold: Boolean(studioTextStyles.bold),
                        italic: Boolean(studioTextStyles.italic),
                        shadow: Boolean(studioTextStyles.shadow),
                        font_family: f.font_family,
                        font_path: f.font_path,
                        start_sec: parseFloat(document.getElementById('st-text-start')?.value || '0') || 0,
                        end_sec: parseFloat(document.getElementById('st-text-end')?.value || '0') || 0,
                    };
                })() : null,
                text_layers: [
                    ...studioExtraTextLayers.filter(tl => !tl.hidden),
                    ...studioAppliedTemplates.filter(t => !t.hidden).flatMap(t => t.text_layers || []),
                ],
                image_overlays: [
                    ...studioImageOverlays.filter(ov => !ov.hidden),
                    ...studioAppliedTemplates.filter(t => !t.hidden).flatMap(t => t.image_overlays || []),
                ],
                extra_clips: studioExtraClips,
                inpaint_boxes: studioEraserBoxes,
                inpaint_strokes: studioEraserStrokes,
                glare_strokes: studioGlareStrokes,
                redeye_strokes: studioRedeyeStrokes,
                blemish_strokes: studioBlemishStrokes,
                bg_remove: studioBgRemove,
                auto_retouch: studioAutoRetouch,
                border: studioBorder,
                draw_layer_png: brushData.draw_layer_png,
                blur_mask_png: brushData.blur_mask_png,
                blur_strokes: brushData.blur_strokes,
                pixel_mask_png: brushData.pixel_mask_png,
                pixel_strokes: brushData.pixel_strokes,
                video_action: videoAction,
                start_sec: parseFloat(document.getElementById('st-vid-start')?.value || '0') || 0,
                end_sec: parseFloat(document.getElementById('st-vid-end')?.value || '0') || 0,
                split_time_sec: (studioIsVideo && vidEl && vidEl.currentTime > 0) ? vidEl.currentTime : 5.0,
                speed: parseFloat(document.getElementById('st-vid-speed')?.value || '1.0') || 1.0,
                mute_audio: Boolean(document.getElementById('st-vid-mute')?.checked),
                custom_audio_path: (document.getElementById('st-vid-audio')?.value || '').trim() || null,
                audio_mix_mode: document.getElementById('st-audio-mix-mode')?.value || 'replace',
                audio_volume: parseFloat(document.getElementById('st-music-vol')?.value || '1.0'),
                original_audio_volume: parseFloat(document.getElementById('st-orig-vol')?.value || '1.0'),
            })
        });
        if (res.ok) {
            if (typeof showAppToast === 'function') {
                const msg = videoAction === 'SPLIT'
                    ? 'Vidéo scindée en 2 extraits.'
                    : (videoAction === 'GIF' ? 'GIF animé exporté.' : (isOverwrite ? 'Original remplacé.' : 'Copie créée.'));
                showAppToast(msg, 'success');
            }
            closeStudioModal();
            if (typeof closeLightbox === 'function' && !document.getElementById('lightbox-modal')?.classList.contains('hidden')) {
                closeLightbox();
            }
            refreshActiveMediaView();
            loadStats();
        } else if (typeof showAppToast === 'function') {
            showAppToast("Échec lors de l'exportation.", 'error');
        }
    } catch (e) {
        if (typeof showAppToast === 'function') showAppToast(`Erreur : ${e.message || e}`, 'error');
    } finally {
        if (copyBtn) copyBtn.disabled = false;
        if (owBtn) owBtn.disabled = false;
        syncStudioSaveButtonLabel();
    }
}
