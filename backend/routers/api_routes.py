import os
import re
import time
import shutil
import sqlite3
import sys
import subprocess
import threading
import hashlib
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import unquote

import cv2
import numpy as np
from PIL import Image
import imagehash
import exiftool
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

_ROOT_DIR = Path(__file__).resolve().parents[2]
for _sub in ("backend/core", "backend/engines", "backend/routers"):
    _p = str(_ROOT_DIR / _sub)
    if _p not in sys.path:
        sys.path.insert(0, _p)

from settings_manager import load_settings, save_settings, get_configured_timezone
from library_manager import load_libraries, save_libraries, register_library, open_native_dialog
from pipeline_runner import STATE, start_specific_task, request_stop_pipeline
from indexeur_visages import init_face_tables, save_face_thumbnail
from sync_visages_exif import sync_all_named_faces_to_exif
from indexeur_ocr import init_ocr_tables
from indexeur_semantique_gps import search_photos_by_natural_text, upgrade_db_for_clip_and_gps
from indexeur_similaires import upgrade_db_for_video_similarity
from media_editor import process_image_edits, process_video_edits
from media_frames import VIDEO_EXTS, IMAGE_EXTS
import fusion_takeout_complet as fusion

app = FastAPI(title="Phototo — Galerie & Studio IA")

DEFAULT_DB = Path("progression_takeout.db")
DEFAULT_DEST = Path("./Photos_Triees")
RAW_EXTS = {'.dng', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2'}

EMPTY_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">'
    '<rect width="200" height="200" fill="#0f172a"/>'
    '<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#475569" font-family="sans-serif" font-size="13">Média absent</text>'
    '</svg>'
)

MISSING_META_SQL_CONDITION = """
    is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
    AND (
        status IN ('no_metadata', 'mtime_fallback')
        OR timestamp IS NULL OR timestamp <= 0
    )
"""


def get_active_db_and_dest() -> tuple[Path, Path]:
    cfg = load_libraries()
    active = cfg.get("active_library")
    if active and active in cfg.get("libraries", {}):
        lib = cfg["libraries"][active]
        return Path(lib["db_path"]), Path(lib["dest_dir"])
    return DEFAULT_DB, DEFAULT_DEST


_INITIALIZED_DBS: set[str] = set()


def get_db() -> sqlite3.Connection:
    db_p, _ = get_active_db_and_dest()
    db_key = str(db_p.resolve())

    if db_key not in _INITIALIZED_DBS:
        init_conn = fusion.init_db(db_p)
        init_face_tables(init_conn)
        init_ocr_tables(init_conn)
        upgrade_db_for_clip_and_gps(init_conn)
        upgrade_db_for_video_similarity(init_conn)
        init_conn.execute("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)")
        init_conn.execute("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('trash_retention_days', '30')")
        init_conn.execute("CREATE INDEX IF NOT EXISTS idx_pf_gallery ON processed_files(is_duplicate, is_trashed, timestamp DESC)")
        init_conn.execute("CREATE INDEX IF NOT EXISTS idx_pf_album ON processed_files(album_name)")
        init_conn.execute("CREATE INDEX IF NOT EXISTS idx_pf_fav ON processed_files(is_favorite)")
        init_conn.commit()
        init_conn.close()
        _INITIALIZED_DBS.add(db_key)

    conn = sqlite3.connect(db_p, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=30000;")
    return conn


def resolve_actual_path(path_str: str) -> Path | None:
    if not path_str or not path_str.strip():
        return None
    p = Path(path_str)
    if p.exists() and p.is_file():
        return p

    _, dest_dir = get_active_db_and_dest()
    for sub in ("Doublons_Quarantaine", "Corbeille"):
        cand = dest_dir / sub / p.name
        if cand.exists() and cand.is_file():
            return cand

    if len(p.parts) >= 3:
        rel_cand = dest_dir / p.parts[-3] / p.parts[-2] / p.name
        if rel_cand.exists() and rel_cand.is_file():
            return rel_cand

    return None


def _probe_video_duration_and_save(video_path: Path, conn: sqlite3.Connection | None = None) -> float | None:
    try:
        cap = cv2.VideoCapture(str(video_path))
        fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0
        cap.release()
        if fps > 0 and frame_count > 0:
            dur = round(float(frame_count / fps), 1)
            if conn is not None:
                conn.execute("UPDATE processed_files SET duration_sec = ? WHERE dest_path = ?", (dur, str(video_path)))
            return dur
    except Exception:
        pass
    return None


# ==================== MODÈLES PYDANTIC ====================

class CreateLibraryPayload(BaseModel):
    name: str
    source_type: str
    source_paths_raw: str
    dest_dir: str
    fix_takeout_json_metadata: bool = True
    delete_zips_progressively: bool = False
    organize_by_year_month: bool = True

class UpdateLibraryPayload(BaseModel):
    original_name: str
    new_name: str
    source_paths_raw: str
    dest_dir: str
    fix_takeout_json_metadata: bool = True
    delete_zips_progressively: bool = False

class MergeLibrariesPayload(BaseModel):
    source_lib_name: str
    target_lib_name: str

class QuickImportPayload(BaseModel):
    source_type: str
    paths: list[str]
    fix_metadata: bool = True
    delete_zips: bool = False

class RunTaskPayload(BaseModel):
    task: str

class ResetToolPayload(BaseModel):
    tool: str

class SettingsPayload(BaseModel):
    scanned_folders: list[str]
    takeout_extract_dir: str
    timezone: str
    language: str
    gpu_mode: str

class ToggleFavoritePayload(BaseModel):
    source_path: str

class TrashActionPayload(BaseModel):
    source_paths: list[str]
    action: str

class TrashPolicyPayload(BaseModel):
    retention_days: int

class GalleryBatchActionPayload(BaseModel):
    source_paths: list[str]
    action: str
    album_name: str | None = None

class MergeMultiplePersonsPayload(BaseModel):
    person_ids: list[int]
    target_name: str | None = None

class RenamePersonPayload(BaseModel):
    person_id: int
    new_name: str

class ReassignFacesPayload(BaseModel):
    face_ids: list[int]
    action: str
    target_person_id: int | None = None
    new_group_name: str | None = None

class ManualFacePayload(BaseModel):
    dest_path: str
    norm_x1: float
    norm_y1: float
    norm_x2: float
    norm_y2: float
    target_person_id: int | None = None
    new_person_name: str | None = None

class BatchMetadataUpdatePayload(BaseModel):
    source_paths: list[str]
    start_datetime_iso: str | None = None
    time_sequence_mode: str = "PRESERVE_GAPS"
    step_seconds: int = 15
    latitude: float | None = None
    longitude: float | None = None
    description: str | None = None

class BatchMetadataStripPayload(BaseModel):
    source_paths: list[str]
    strip_gps: bool = False
    strip_all_exif: bool = False

class MediaStudioEditPayload(BaseModel):
    source_path: str
    overwrite: bool = False
    crop: dict | None = None
    rotate: int = 0
    flip_h: bool = False
    flip_v: bool = False
    brightness: float = 1.0
    contrast: float = 1.0
    saturation: float = 1.0
    sharpness: float = 1.0
    text_overlay: dict | None = None
    inpaint_boxes: list[dict] = []
    video_action: str = "EDIT"
    start_sec: float = 0.0
    end_sec: float = 0.0
    split_time_sec: float = 5.0
    speed: float = 1.0
    mute_audio: bool = False
    custom_audio_path: str | None = None


# ==================== STATISTIQUES & MINIATURES WEBP ====================

def _pct(done: int, total: int) -> float:
    return round((done / total) * 100, 1) if total > 0 else 0.0


@app.get("/api/stats")
def api_stats():
    conn = get_db()
    cur = conn.cursor()

    cur.execute("SELECT COUNT(*) FROM processed_files WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL")
    total_active = cur.fetchone()[0]

    cur.execute("SELECT COALESCE(SUM(file_size), 0) FROM processed_files WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL")
    total_bytes = cur.fetchone()[0] or 0
    total_gb = round(total_bytes / (1024**3), 2)

    cur.execute("SELECT COUNT(*) FROM processed_files WHERE is_duplicate = 0 AND is_trashed = 0 AND faces_scanned = 1")
    faces_done = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM processed_files WHERE is_duplicate = 0 AND is_trashed = 0 AND ocr_scanned = 1")
    ocr_done = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM processed_files WHERE is_duplicate = 0 AND is_trashed = 0 AND clip_scanned = 1")
    clip_done = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM processed_files WHERE is_duplicate = 0 AND is_trashed = 0 AND blake3_hash IS NOT NULL")
    dedup_done = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM processed_files WHERE is_duplicate = 0 AND is_trashed = 0 AND (phash IS NOT NULL OR video_hash IS NOT NULL)")
    sim_done = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM processed_files WHERE is_duplicate = 1")
    dups_found = cur.fetchone()[0]

    cur.execute("""
        SELECT COUNT(*) FROM (
            SELECT phash FROM processed_files
            WHERE is_duplicate = 0 AND is_trashed = 0 AND phash IS NOT NULL
            GROUP BY phash HAVING COUNT(*) > 1
        )
    """)
    sim_count = cur.fetchone()[0] or 0

    cur.execute("SELECT COUNT(*) FROM persons")
    persons_count = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM ocr_results")
    ocr_texts_found = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM processed_files WHERE is_duplicate = 0 AND is_trashed = 0 AND is_favorite = 1")
    fav_count = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM processed_files WHERE is_trashed = 1")
    trash_count = cur.fetchone()[0]

    cur.execute(f"SELECT COUNT(*) FROM processed_files WHERE {MISSING_META_SQL_CONDITION}")
    missing_meta_count = cur.fetchone()[0]

    conn.close()
    return {
        "indexed": total_active,
        "total_gb": total_gb,
        "duplicates": dups_found,
        "similar_count": sim_count,
        "persons": persons_count,
        "ocr_count": ocr_texts_found,
        "favorites": fav_count,
        "trashed": trash_count,
        "missing_meta": missing_meta_count,
        "coverage": {
            "total": total_active,
            "faces": {"done": faces_done, "total": total_active, "percent": _pct(faces_done, total_active)},
            "ocr": {"done": ocr_done, "total": total_active, "percent": _pct(ocr_done, total_active)},
            "clip": {"done": clip_done, "total": total_active, "percent": _pct(clip_done, total_active)},
            "dedup": {"done": dedup_done, "total": total_active, "percent": _pct(dedup_done, total_active)},
            "similar": {"done": sim_done, "total": total_active, "percent": _pct(sim_done, total_active)}
        }
    }


@app.get("/media")
def serve_media(path: str = ""):
    if not path or not path.strip():
        return Response(content=EMPTY_SVG, media_type="image/svg+xml")
    actual = resolve_actual_path(unquote(path))
    if not actual:
        return Response(content=EMPTY_SVG, media_type="image/svg+xml", status_code=200)
    return FileResponse(actual)


@app.get("/thumb")
def serve_thumbnail(path: str = ""):
    if not path or not path.strip():
        return Response(content=EMPTY_SVG, media_type="image/svg+xml")

    actual = resolve_actual_path(unquote(path))
    if not actual:
        return Response(content=EMPTY_SVG, media_type="image/svg+xml", status_code=200)

    _, dest_dir = get_active_db_and_dest()
    cache_dir = dest_dir / "Miniatures_Cache"
    cache_dir.mkdir(parents=True, exist_ok=True)

    stat = actual.stat()
    hash_key = hashlib.md5(f"{actual}_{stat.st_size}_{int(stat.st_mtime)}".encode("utf-8")).hexdigest()
    thumb_path = cache_dir / f"{hash_key}.webp"

    if thumb_path.exists():
        return FileResponse(thumb_path, media_type="image/webp", headers={"Cache-Control": "public, max-age=31536000"})

    ext = actual.suffix.lower()
    try:
        if ext in VIDEO_EXTS:
            cap = cv2.VideoCapture(str(actual))
            total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            if total_frames > 10:
                cap.set(cv2.CAP_PROP_POS_FRAMES, min(30, total_frames // 3))
            ret, frame = cap.read()
            cap.release()
            if ret and frame is not None:
                h, w = frame.shape[:2]
                scale = 360.0 / max(h, w)
                if scale < 1.0:
                    frame = cv2.resize(frame, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
                cv2.imwrite(str(thumb_path), frame, [int(cv2.IMWRITE_WEBP_QUALITY), 78])
                return FileResponse(thumb_path, media_type="image/webp", headers={"Cache-Control": "public, max-age=31536000"})
        else:
            with Image.open(actual) as im:
                im.thumbnail((360, 360))
                if im.mode not in ("RGB", "RGBA"):
                    im = im.convert("RGB")
                im.save(thumb_path, "WEBP", quality=78, method=4)
                return FileResponse(thumb_path, media_type="image/webp", headers={"Cache-Control": "public, max-age=31536000"})
    except Exception:
        pass

    return FileResponse(actual)


@app.get("/api/dialog/browse")
def api_browse(mode: str = "folder"):
    return {"paths": open_native_dialog(mode=mode)}


@app.post("/api/notifications/clear")
def api_clear_notifications():
    for n in STATE.notifications:
        n["read"] = True
    return {"status": "ok"}


# ==================== GESTION DES BIBLIOTHÈQUES & ASSISTANT IMPORT ====================

@app.get("/api/libraries")
def api_get_libraries():
    return load_libraries()


@app.post("/api/libraries/select")
def api_select_library(payload: dict):
    cfg = load_libraries()
    name = payload.get("name")
    if name in cfg.get("libraries", {}):
        cfg["active_library"] = name
        save_libraries(cfg)
    return {"status": "selected", "active_library": name}


@app.post("/api/libraries/create")
def api_create_library(payload: CreateLibraryPayload):
    paths = [p.strip() for p in payload.source_paths_raw.splitlines() if p.strip()]
    if not paths:
        raise HTTPException(400, "Indiquez au moins un chemin de dossier ou fichier .ZIP.")
    lib = register_library(
        name=payload.name.strip() or "Ma Galerie",
        source_type=payload.source_type,
        source_paths=paths,
        dest_dir=payload.dest_dir.strip() or "./Photos_Triees",
        options=payload.model_dump()
    )
    return {"status": "created", "library": lib}


@app.post("/api/libraries/update")
def api_update_library(payload: UpdateLibraryPayload):
    cfg = load_libraries()
    libs = cfg.get("libraries", {})
    if payload.original_name not in libs:
        raise HTTPException(404, "Bibliothèque introuvable")

    entry = libs.pop(payload.original_name)
    new_name = payload.new_name.strip() or payload.original_name
    paths = [p.strip() for p in payload.source_paths_raw.splitlines() if p.strip()]

    entry["name"] = new_name
    if paths:
        entry["source_paths"] = paths
    if payload.dest_dir.strip():
        entry["dest_dir"] = payload.dest_dir.strip()
    entry["options"]["fix_takeout_json_metadata"] = payload.fix_takeout_json_metadata
    entry["options"]["delete_zips_progressively"] = payload.delete_zips_progressively

    libs[new_name] = entry
    if cfg.get("active_library") == payload.original_name:
        cfg["active_library"] = new_name
    save_libraries(cfg)
    return {"status": "updated", "active_library": cfg.get("active_library")}


@app.post("/api/libraries/merge")
def api_merge_libraries(payload: MergeLibrariesPayload):
    cfg = load_libraries()
    libs = cfg.get("libraries", {})
    src_name = payload.source_lib_name
    dst_name = payload.target_lib_name

    if src_name not in libs or dst_name not in libs or src_name == dst_name:
        raise HTTPException(400, "Sélectionnez deux bibliothèques distinctes valides.")

    src_lib = libs[src_name]
    dst_lib = libs[dst_name]

    merged_paths = list(dict.fromkeys([*dst_lib.get("source_paths", []), *src_lib.get("source_paths", [])]))
    dst_lib["source_paths"] = merged_paths

    src_db = Path(src_lib["db_path"])
    dst_db = Path(dst_lib["db_path"])
    if src_db.exists() and dst_db.exists() and src_db.resolve() != dst_db.resolve():
        conn = sqlite3.connect(dst_db, timeout=30.0)
        conn.execute(f"ATTACH DATABASE '{str(src_db)}' AS src_db")
        conn.execute("INSERT OR IGNORE INTO processed_files SELECT * FROM src_db.processed_files")
        try:
            conn.execute("INSERT OR IGNORE INTO ocr_results SELECT * FROM src_db.ocr_results")
        except Exception:
            pass
        conn.commit()
        conn.execute("DETACH DATABASE src_db")
        conn.close()

    del libs[src_name]
    cfg["active_library"] = dst_name
    save_libraries(cfg)
    return {"status": "merged", "active_library": dst_name}


@app.post("/api/import/quick_add")
def api_quick_import(payload: QuickImportPayload):
    clean_paths = [p.strip() for p in payload.paths if p.strip()]
    if not clean_paths:
        raise HTTPException(400, "Aucun fichier ou dossier sélectionné.")

    cfg = load_libraries()
    active_name = cfg.get("active_library")
    libs = cfg.get("libraries", {})

    if active_name and active_name in libs:
        lib = libs[active_name]
        lib["source_type"] = payload.source_type
        lib["is_takeout"] = payload.source_type in ("TAKEOUT_FOLDER", "TAKEOUT_ZIPS")
        lib["source_paths"] = list(dict.fromkeys([*lib.get("source_paths", []), *clean_paths]))
        lib.setdefault("options", {})
        lib["options"]["fix_takeout_json_metadata"] = payload.fix_metadata
        lib["options"]["delete_zips_progressively"] = payload.delete_zips
        save_libraries(cfg)
    else:
        default_dest = str((Path(clean_paths[0]).parent / "Phototo_Bibliotheque").resolve())
        register_library(
            name="Ma Bibliothèque",
            source_type=payload.source_type,
            source_paths=clean_paths,
            dest_dir=default_dest,
            options={
                "fix_takeout_json_metadata": payload.fix_metadata,
                "delete_zips_progressively": payload.delete_zips,
                "organize_by_year_month": True
            }
        )

    return start_specific_task("INGEST")


@app.post("/api/import/upload_files")
async def api_upload_dropped_files(files: list[UploadFile] = File(...)):
    _, dest_dir = get_active_db_and_dest()
    drop_dir = dest_dir / "Import_Direct"
    drop_dir.mkdir(parents=True, exist_ok=True)

    saved_paths = []
    for uf in files:
        if not uf.filename:
            continue
        target = drop_dir / Path(uf.filename).name
        with open(target, "wb") as f:
            shutil.copyfileobj(uf.file, f)
        saved_paths.append(str(target))

    if not saved_paths:
        raise HTTPException(400, "Aucun fichier valide reçu.")

    return api_quick_import(QuickImportPayload(
        source_type="STANDARD_FOLDER",
        paths=[str(drop_dir)],
        fix_metadata=False,
        delete_zips=False
    ))


# ==================== PIPELINE & MAINTENANCE ====================

@app.get("/api/pipeline/status")
def api_pipeline_status():
    return STATE.to_dict()


@app.post("/api/pipeline/run_task")
def api_pipeline_run_task(payload: RunTaskPayload):
    try:
        return start_specific_task(payload.task)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/pipeline/stop")
def api_pipeline_stop(cancel: bool = False):
    return request_stop_pipeline(cancel=cancel)


@app.get("/api/settings")
def api_get_settings():
    return load_settings()


@app.post("/api/settings/save")
def api_save_settings_route(payload: SettingsPayload):
    saved = save_settings({
        "scanned_folders": [p.strip() for p in payload.scanned_folders if p.strip()],
        "takeout_extract_dir": payload.takeout_extract_dir.strip(),
        "timezone": payload.timezone.strip(),
        "language": payload.language.strip(),
        "gpu_mode": payload.gpu_mode.strip()
    })
    return {"status": "saved", "settings": saved}


@app.post("/api/database/backup")
def api_backup_database():
    db_path, dest_dir = get_active_db_and_dest()
    if not db_path.exists():
        raise HTTPException(404, "Aucune base de données active trouvée.")

    backup_dir = dest_dir / "Sauvegardes_DB"
    backup_dir.mkdir(parents=True, exist_ok=True)
    ts_str = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    backup_file = backup_dir / f"{db_path.stem}_backup_{ts_str}.db.bak"

    try:
        src_conn = sqlite3.connect(db_path, timeout=30.0)
        dst_conn = sqlite3.connect(backup_file, timeout=30.0)
        with dst_conn:
            src_conn.backup(dst_conn)
        dst_conn.close()
        src_conn.close()
        size_mb = round(backup_file.stat().st_size / (1024 * 1024), 2)
        return {"status": "ok", "backup_path": str(backup_file), "size_mb": size_mb}
    except Exception as e:
        raise HTTPException(500, f"Erreur lors de la sauvegarde : {e}")


@app.post("/api/tools/reset")
def api_reset_tool(payload: ResetToolPayload):
    if STATE.is_running:
        raise HTTPException(400, "Mettez d'abord en pause le traitement en cours.")

    tool = payload.tool.upper()
    conn = get_db()
    cur = conn.cursor()
    _, dest_dir = get_active_db_and_dest()

    if tool == "FACES":
        cur.execute("DELETE FROM faces")
        cur.execute("DELETE FROM persons")
        cur.execute("UPDATE processed_files SET faces_scanned = 0")
        thumbs_dir = dest_dir / "Miniatures_Visages"
        if thumbs_dir.exists():
            shutil.rmtree(thumbs_dir, ignore_errors=True)
    elif tool == "OCR":
        cur.execute("DELETE FROM ocr_results")
        cur.execute("DELETE FROM ocr_fts")
        cur.execute("UPDATE processed_files SET ocr_scanned = 0")
    elif tool == "CLIP":
        cur.execute("UPDATE processed_files SET clip_scanned = 0, clip_embedding = NULL")
    elif tool == "SIMILAR":
        cur.execute("UPDATE processed_files SET phash = NULL, video_hash = NULL")
    elif tool == "DEDUP":
        q_dir = dest_dir / "Doublons_Quarantaine"
        cur.execute("SELECT source_path, dest_path FROM processed_files WHERE is_duplicate = 1 AND dest_path IS NOT NULL")
        for r in cur.fetchall():
            orig_dest = Path(r["dest_path"])
            q_file = q_dir / orig_dest.name
            if q_file.exists() and not orig_dest.exists():
                orig_dest.parent.mkdir(parents=True, exist_ok=True)
                try:
                    shutil.move(q_file, orig_dest)
                except Exception:
                    pass
        cur.execute("UPDATE processed_files SET blake3_hash = NULL, is_duplicate = 0, duplicate_of = NULL")
    else:
        conn.close()
        raise HTTPException(400, f"Outil inconnu : {tool}")

    conn.commit()
    conn.close()
    return {"status": "reset", "tool": tool}


@app.post("/api/database/prune_missing")
def api_prune_missing_files():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT source_path, dest_path FROM processed_files")
    missing_sources = []
    for r in cur.fetchall():
        dp = r["dest_path"]
        sp = r["source_path"]
        if not resolve_actual_path(dp or "") and not (sp and Path(sp).exists()):
            missing_sources.append((sp,))

    if missing_sources:
        cur.executemany("DELETE FROM faces WHERE source_path = ?", missing_sources)
        cur.executemany("DELETE FROM ocr_results WHERE source_path = ?", missing_sources)
        cur.executemany("DELETE FROM processed_files WHERE source_path = ?", missing_sources)
        conn.commit()
    conn.close()
    return {"status": "ok", "removed_count": len(missing_sources)}


@app.get("/api/metadata/missing_report")
def api_missing_metadata_report(page: int = 1, limit: int = 54):
    conn = get_db()
    cur = conn.cursor()
    offset = (page - 1) * limit
    cur.execute(f"SELECT COUNT(*) FROM processed_files WHERE {MISSING_META_SQL_CONDITION}")
    total = cur.fetchone()[0]

    cur.execute(f"""
        SELECT source_path, dest_path, timestamp, status, album_name, file_size
        FROM processed_files
        WHERE {MISSING_META_SQL_CONDITION}
        ORDER BY dest_path ASC
        LIMIT ? OFFSET ?
    """, (limit, offset))
    items = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"total": total, "items": items, "page": page, "total_pages": max(1, (total + limit - 1) // limit)}


@app.post("/api/metadata/retry_recovery")
def api_retry_metadata_recovery():
    conn = get_db()
    cur = conn.cursor()
    _, active_dest = get_active_db_and_dest()

    cur.execute(f"""
        SELECT source_path, dest_path, timestamp, status, latitude, longitude
        FROM processed_files
        WHERE {MISSING_META_SQL_CONDITION}
    """)
    rows = [dict(r) for r in cur.fetchall()]
    repaired = 0
    still_missing = 0
    STATE.missing_meta_files.clear()

    with exiftool.ExifToolHelper(common_args=["-G", "-n", "-charset", "filename=utf8"]) as et:
        for r in rows:
            curr_p = Path(r["dest_path"])
            if not curr_p.exists():
                continue

            new_ts = None
            new_status = "no_metadata"
            src_p = Path(r["source_path"])
            if src_p.exists():
                jp = fusion.find_matching_json(src_p)
                if jp:
                    try:
                        import json
                        data = json.loads(jp.read_text(encoding="utf-8"))
                        ts_s = data.get("photoTakenTime", {}).get("timestamp") or data.get("creationTime", {}).get("timestamp")
                        if ts_s:
                            new_ts = int(ts_s)
                            new_status = "json_matched"
                    except Exception:
                        pass

            if not new_ts:
                fn_ts = fusion.extract_date_from_filename(curr_p.name)
                if fn_ts:
                    new_ts = fn_ts
                    new_status = "filename_date"

            if new_ts and new_ts > 0:
                t_info = fusion.resolve_datetime_with_dst(new_ts, r["latitude"], r["longitude"])
                dt_loc = t_info["dt_local"]
                clean_orig_stem = re.sub(r'^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_', '', curr_p.stem)
                new_folder = active_dest / str(dt_loc.year) / fusion.MOIS_FR[dt_loc.month]
                new_folder.mkdir(parents=True, exist_ok=True)
                new_prefix = dt_loc.strftime("%Y-%m-%d_%H-%M-%S")
                new_dest = new_folder / f"{new_prefix}_{clean_orig_stem}{curr_p.suffix}"

                counter = 1
                while new_dest.exists() and new_dest.resolve() != curr_p.resolve():
                    new_dest = new_folder / f"{new_prefix}_{clean_orig_stem}_{counter}{curr_p.suffix}"
                    counter += 1

                try:
                    if new_dest.resolve() != curr_p.resolve():
                        shutil.move(curr_p, new_dest)
                    is_vid = new_dest.suffix.lower() in VIDEO_EXTS
                    tags = {"DateTimeOriginal": t_info["exif_local_str"], "CreateDate": t_info["exif_local_str"]} if not is_vid else {"QuickTime:CreateDate": t_info["exif_utc_str"]}
                    et.set_tags([str(new_dest)], tags=tags, params=["-overwrite_original", "-P", "-q"])
                    os.utime(new_dest, (new_ts, new_ts))
                except Exception:
                    pass

                cur.execute(
                    "UPDATE processed_files SET dest_path=?, original_dest_path=?, timestamp=?, status=? WHERE source_path=?",
                    (str(new_dest), str(new_dest), new_ts, new_status, r["source_path"])
                )
                repaired += 1
            else:
                cur.execute("UPDATE processed_files SET status='no_metadata' WHERE source_path=?", (r["source_path"],))
                STATE.add_missing_meta_file(str(curr_p))
                still_missing += 1

    conn.commit()
    conn.close()
    return {"status": "ok", "repaired": repaired, "still_missing": still_missing}


@app.post("/api/system/restart")
def api_system_restart():
    if STATE.is_running:
        STATE.stop_requested = True
        time.sleep(0.4)
    def _respawn():
        time.sleep(0.6)
        subprocess.Popen([sys.executable, "main.py"], cwd=os.getcwd())
        os._exit(0)
    threading.Thread(target=_respawn, daemon=True).start()
    return {"status": "restarting"}


@app.post("/api/system/shutdown")
def api_system_shutdown():
    if STATE.is_running:
        STATE.stop_requested = True
        time.sleep(0.4)
    def _quit():
        time.sleep(0.6)
        os._exit(0)
    threading.Thread(target=_quit, daemon=True).start()
    return {"status": "shutting_down"}


# ==================== GALERIE, CHRONOLOGIE, ALBUMS, FAVORIS & TYPES ====================

@app.get("/api/gallery/filters")
def api_gallery_filters():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT strftime('%Y', datetime(timestamp, 'unixepoch', 'localtime')) as year, COUNT(*) as count
        FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND timestamp > 0
        GROUP BY year ORDER BY year DESC
    """)
    years = [{"year": r["year"], "count": r["count"]} for r in cur.fetchall() if r["year"]]
    cur.execute("SELECT DISTINCT album_name FROM processed_files WHERE is_duplicate = 0 AND is_trashed = 0 AND album_name IS NOT NULL AND album_name != '' ORDER BY album_name")
    albums = [r["album_name"] for r in cur.fetchall()]

    cur.execute("SELECT dest_path FROM processed_files WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL")
    exts_set = {Path(r["dest_path"]).suffix.lower() for r in cur.fetchall() if Path(r["dest_path"]).suffix}
    conn.close()
    return {"years": years, "albums": albums, "extensions": sorted(exts_set)}


@app.get("/api/gallery/timeline")
def api_gallery_timeline(
    album: str = "", favorites_only: bool = False,
    no_faces_only: bool = False, media_type: str = "",
    ext_filter: str = "", sort_order: str = "desc"
):
    conn = get_db()
    cur = conn.cursor()
    where_clauses = [
        "pf.is_duplicate = 0",
        "pf.is_trashed = 0",
        "pf.dest_path IS NOT NULL",
        "pf.timestamp > 0"
    ]
    params = []

    if album:
        where_clauses.append("pf.album_name LIKE ?")
        params.append(f"%{album}%")
    if favorites_only:
        where_clauses.append("pf.is_favorite = 1")
    if no_faces_only:
        where_clauses.append("NOT EXISTS (SELECT 1 FROM faces f WHERE f.dest_path = pf.dest_path)")
    if ext_filter:
        where_clauses.append("LOWER(pf.dest_path) LIKE ?")
        params.append(f"%{ext_filter.lower()}")
    elif media_type == "VIDEOS":
        vid_ors = " OR ".join([f"LOWER(pf.dest_path) LIKE '%{e}'" for e in VIDEO_EXTS])
        where_clauses.append(f"({vid_ors})")
    elif media_type == "RAW":
        raw_ors = " OR ".join([f"LOWER(pf.dest_path) LIKE '%{e}'" for e in RAW_EXTS])
        where_clauses.append(f"({raw_ors})")
    elif media_type == "SCREENSHOTS":
        where_clauses.append("(LOWER(pf.dest_path) LIKE '%screenshot%' OR LOWER(pf.dest_path) LIKE '%capture%' OR LOWER(pf.dest_path) LIKE '%ecran%')")
    elif media_type == "PHOTOS":
        std_imgs = IMAGE_EXTS - RAW_EXTS
        img_ors = " OR ".join([f"LOWER(pf.dest_path) LIKE '%{e}'" for e in std_imgs])
        where_clauses.append(f"({img_ors})")

    direction = "ASC" if sort_order.lower() == "asc" else "DESC"
    where_sql = " AND ".join(where_clauses)

    cur.execute(f"""
        SELECT strftime('%Y', datetime(pf.timestamp, 'unixepoch', 'localtime')) as y,
               strftime('%m', datetime(pf.timestamp, 'unixepoch', 'localtime')) as m,
               COUNT(*) as cnt
        FROM processed_files pf
        WHERE {where_sql}
        GROUP BY y, m
        ORDER BY y {direction}, m {direction}
    """, params)

    rows = cur.fetchall()
    conn.close()

    timeline = []
    running_offset = 0
    years_map = {}

    for r in rows:
        y, m, cnt = r["y"], r["m"], r["cnt"]
        if not y or not m:
            continue
        if y not in years_map:
            y_obj = {"year": y, "count": 0, "offset": running_offset, "months": []}
            years_map[y] = y_obj
            timeline.append(y_obj)
        years_map[y]["count"] += cnt
        years_map[y]["months"].append({
            "month": m,
            "count": cnt,
            "offset": running_offset
        })
        running_offset += cnt

    return {"timeline": timeline, "total_dated": running_offset}


@app.get("/api/albums/list")
def api_albums_list():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT album_name, COUNT(*) as count, MAX(dest_path) as cover_path, MAX(timestamp) as max_ts
        FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND album_name IS NOT NULL AND album_name != ''
        GROUP BY album_name
        ORDER BY max_ts DESC
    """)
    albums = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"albums": albums}


@app.get("/api/types/summary")
def api_types_summary():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT dest_path, file_size FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
    """)
    cats = {
        "PHOTOS": {"count": 0, "bytes": 0},
        "VIDEOS": {"count": 0, "bytes": 0},
        "RAW": {"count": 0, "bytes": 0},
        "SCREENSHOTS": {"count": 0, "bytes": 0},
    }
    exts = {}

    for r in cur.fetchall():
        p = Path(r["dest_path"])
        ext = p.suffix.lower()
        sz = r["file_size"] or 0
        name_low = p.stem.lower()

        exts.setdefault(ext, {"ext": ext, "count": 0, "mb": 0.0})
        exts[ext]["count"] += 1
        exts[ext]["mb"] = round(exts[ext]["mb"] + sz / (1024 * 1024), 1)

        if "screenshot" in name_low or "capture" in name_low or "ecran" in name_low:
            cats["SCREENSHOTS"]["count"] += 1
            cats["SCREENSHOTS"]["bytes"] += sz
        elif ext in RAW_EXTS:
            cats["RAW"]["count"] += 1
            cats["RAW"]["bytes"] += sz
        elif ext in VIDEO_EXTS:
            cats["VIDEOS"]["count"] += 1
            cats["VIDEOS"]["bytes"] += sz
        elif ext in IMAGE_EXTS:
            cats["PHOTOS"]["count"] += 1
            cats["PHOTOS"]["bytes"] += sz

    conn.close()
    summary = {k: {"count": v["count"], "gb": round(v["bytes"] / (1024**3), 2)} for k, v in cats.items()}
    ext_list = sorted(exts.values(), key=lambda x: x["count"], reverse=True)
    return {"categories": summary, "extensions": ext_list}


@app.get("/api/gallery/items")
def api_gallery_items(
    year: str = "", month: str = "", album: str = "",
    favorites_only: bool = False, no_faces_only: bool = False,
    media_type: str = "", ext_filter: str = "",
    sort_by: str = "date", sort_order: str = "desc",
    page: int = 1, limit: int = 60, skip_to: int = -1
):
    conn = get_db()
    cur = conn.cursor()
    offset = skip_to if skip_to >= 0 else (page - 1) * limit
    where_clauses = ["pf.is_duplicate = 0", "pf.is_trashed = 0", "pf.dest_path IS NOT NULL"]
    params = []

    if year:
        where_clauses.append("strftime('%Y', datetime(pf.timestamp, 'unixepoch', 'localtime')) = ?")
        params.append(year)
    if month:
        where_clauses.append("strftime('%m', datetime(pf.timestamp, 'unixepoch', 'localtime')) = ?")
        params.append(f"{int(month):02d}")
    if album:
        where_clauses.append("pf.album_name LIKE ?")
        params.append(f"%{album}%")
    if favorites_only:
        where_clauses.append("pf.is_favorite = 1")
    if no_faces_only:
        where_clauses.append("NOT EXISTS (SELECT 1 FROM faces f WHERE f.dest_path = pf.dest_path)")
    if ext_filter:
        where_clauses.append("LOWER(pf.dest_path) LIKE ?")
        params.append(f"%{ext_filter.lower()}")
    elif media_type == "VIDEOS":
        vid_ors = " OR ".join([f"LOWER(pf.dest_path) LIKE '%{e}'" for e in VIDEO_EXTS])
        where_clauses.append(f"({vid_ors})")
    elif media_type == "RAW":
        raw_ors = " OR ".join([f"LOWER(pf.dest_path) LIKE '%{e}'" for e in RAW_EXTS])
        where_clauses.append(f"({raw_ors})")
    elif media_type == "SCREENSHOTS":
        where_clauses.append("(LOWER(pf.dest_path) LIKE '%screenshot%' OR LOWER(pf.dest_path) LIKE '%capture%' OR LOWER(pf.dest_path) LIKE '%ecran%')")
    elif media_type == "PHOTOS":
        std_imgs = IMAGE_EXTS - RAW_EXTS
        img_ors = " OR ".join([f"LOWER(pf.dest_path) LIKE '%{e}'" for e in std_imgs])
        where_clauses.append(f"({img_ors})")

    direction = "ASC" if sort_order.lower() == "asc" else "DESC"
    if sort_by == "name":
        order_sql = f"LOWER(pf.dest_path) {direction}"
    elif sort_by == "added":
        order_sql = f"COALESCE(pf.processed_at, '') {direction}, pf.rowid {direction}"
    else:
        order_sql = f"COALESCE(pf.timestamp, 0) {direction}"

    where_sql = " AND ".join(where_clauses)
    cur.execute(f"SELECT COUNT(*) FROM processed_files pf WHERE {where_sql}", params)
    total = cur.fetchone()[0]

    cur.execute(f"""
        SELECT pf.source_path, pf.dest_path, pf.timestamp, pf.processed_at,
               pf.is_favorite, pf.album_name, pf.file_size, pf.width, pf.height, pf.duration_sec,
               (SELECT GROUP_CONCAT(COALESCE(p.name, 'Inconnu'), ', ') FROM faces f LEFT JOIN persons p ON f.person_id = p.person_id WHERE f.dest_path = pf.dest_path) as detected_people,
               (SELECT COUNT(*) FROM faces f WHERE f.dest_path = pf.dest_path) as face_count
        FROM processed_files pf
        WHERE {where_sql}
        ORDER BY {order_sql}
        LIMIT ? OFFSET ?
    """, [*params, limit, offset])

    items = [dict(r) for r in cur.fetchall()]
    updated_dur = False
    for it in items:
        dp = it.get("dest_path") or ""
        if Path(dp).suffix.lower() in VIDEO_EXTS and not it.get("duration_sec"):
            actual_v = resolve_actual_path(dp)
            if actual_v:
                dur = _probe_video_duration_and_save(actual_v, conn)
                if dur:
                    it["duration_sec"] = dur
                    updated_dur = True
    if updated_dur:
        conn.commit()
    conn.close()
    return {"items": items, "total": total, "page": page, "total_pages": max(1, (total + limit - 1) // limit)}


@app.post("/api/media/toggle_favorite")
def api_toggle_favorite(payload: ToggleFavoritePayload):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT dest_path, is_favorite FROM processed_files WHERE source_path = ?", (payload.source_path,))
    row = cur.fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Média introuvable")
    new_fav = 0 if row["is_favorite"] else 1
    dest_path = Path(row["dest_path"])
    _, active_dest = get_active_db_and_dest()
    fav_dir = active_dest / "Favoris"
    fav_dir.mkdir(parents=True, exist_ok=True)
    link = fav_dir / dest_path.name

    if new_fav == 1 and dest_path.exists() and not link.exists():
        try:
            os.link(dest_path, link)
        except Exception:
            pass
    elif new_fav == 0 and link.exists() and link != dest_path:
        link.unlink(missing_ok=True)

    cur.execute("UPDATE processed_files SET is_favorite = ? WHERE source_path = ?", (new_fav, payload.source_path))
    conn.commit()
    conn.close()
    return {"status": "updated", "is_favorite": new_fav}


@app.post("/api/gallery/batch_action")
def api_gallery_batch_action(payload: GalleryBatchActionPayload):
    if payload.action == "TRASH":
        return api_trash_action(TrashActionPayload(source_paths=payload.source_paths, action="MOVE_TO_TRASH"))
    conn = get_db()
    cur = conn.cursor()
    _, active_dest = get_active_db_and_dest()
    placeholders = ",".join("?" for _ in payload.source_paths)
    cur.execute(f"SELECT source_path, dest_path, is_favorite, album_name FROM processed_files WHERE source_path IN ({placeholders})", payload.source_paths)
    rows = cur.fetchall()
    target_album = (payload.album_name or "").strip()

    for r in rows:
        src = r["source_path"]
        dest_p = Path(r["dest_path"])
        fav = r["is_favorite"] or 0
        albums = [a.strip() for a in (r["album_name"] or "").split(",") if a.strip()]
        if payload.action == "FAVORITE_ADD":
            fav = 1
        elif payload.action == "FAVORITE_REMOVE":
            fav = 0
        elif payload.action == "ALBUM_ADD" and target_album:
            if target_album not in albums:
                albums.append(target_album)
            alb_dir = active_dest / "Albums" / target_album
            alb_dir.mkdir(parents=True, exist_ok=True)
            if dest_p.exists() and not (alb_dir / dest_p.name).exists():
                try:
                    os.link(dest_p, alb_dir / dest_p.name)
                except Exception:
                    pass
        elif payload.action == "ALBUM_REMOVE":
            albums = []
        cur.execute("UPDATE processed_files SET is_favorite = ?, album_name = ? WHERE source_path = ?", (fav, ", ".join(albums) if albums else None, src))

    conn.commit()
    conn.close()
    return {"status": "ok"}


@app.get("/api/duplicates")
def api_get_duplicates():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT DISTINCT duplicate_of FROM processed_files WHERE is_duplicate = 1 AND duplicate_of IS NOT NULL")
    masters = [r[0] for r in cur.fetchall()]
    groups = []
    for m_src in masters[:60]:
        cur.execute("SELECT * FROM processed_files WHERE source_path = ?", (m_src,))
        m_row = cur.fetchone()
        cur.execute("SELECT * FROM processed_files WHERE duplicate_of = ?", (m_src,))
        d_rows = cur.fetchall()
        if m_row and d_rows:
            groups.append({"master": dict(m_row), "duplicates": [dict(r) for r in d_rows]})
    conn.close()
    return {"groups": groups}


@app.get("/api/similar/groups")
def api_get_similar_groups(max_dist: int = 8):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT source_path, dest_path, timestamp, phash, width, height, file_size
        FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND phash IS NOT NULL
        ORDER BY COALESCE(timestamp, 0) DESC LIMIT 2500
    """)
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()

    parsed = []
    for r in rows:
        try:
            parsed.append((imagehash.hex_to_hash(r["phash"]), r))
        except Exception:
            pass

    visited = set()
    groups = []
    for i in range(len(parsed)):
        if i in visited:
            continue
        h1, r1 = parsed[i]
        cluster = [r1]
        for j in range(i + 1, min(len(parsed), i + 120)):
            if j in visited:
                continue
            h2, r2 = parsed[j]
            if (h1 - h2) <= max_dist:
                visited.add(j)
                cluster.append(r2)
        if len(cluster) > 1:
            visited.add(i)
            groups.append(cluster)
        if len(groups) >= 40:
            break

    return {"groups": groups}


def _purge_expired_trash(conn: sqlite3.Connection):
    cur = conn.cursor()
    cur.execute("SELECT value FROM app_settings WHERE key = 'trash_retention_days'")
    row = cur.fetchone()
    days = int(row["value"]) if row else 30
    if days <= 0:
        return
    cutoff = int(time.time()) - (days * 86400)
    cur.execute("SELECT source_path, dest_path FROM processed_files WHERE is_trashed = 1 AND trashed_at IS NOT NULL AND trashed_at < ?", (cutoff,))
    for r in cur.fetchall():
        Path(r["dest_path"]).unlink(missing_ok=True)
        cur.execute("DELETE FROM processed_files WHERE source_path = ?", (r["source_path"],))
    conn.commit()


@app.get("/api/trash/items")
def api_get_trash_items():
    conn = get_db()
    _purge_expired_trash(conn)
    cur = conn.cursor()
    cur.execute("SELECT value FROM app_settings WHERE key = 'trash_retention_days'")
    r_days = int(cur.fetchone()["value"])
    cur.execute("SELECT source_path, dest_path, timestamp, file_size, trashed_at FROM processed_files WHERE is_trashed = 1 ORDER BY COALESCE(trashed_at, 0) DESC")
    now_ts = int(time.time())
    items, total_bytes = [], 0
    for r in cur.fetchall():
        d = dict(r)
        total_bytes += (d["file_size"] or 0)
        d["days_left"] = max(0, int(round(r_days - ((now_ts - (d["trashed_at"] or now_ts)) / 86400.0)))) if r_days > 0 else None
        items.append(d)
    conn.close()
    return {"items": items, "retention_days": r_days, "total_mb": round(total_bytes / (1024 * 1024), 2)}


@app.post("/api/trash/policy")
def api_set_trash_policy(payload: TrashPolicyPayload):
    conn = get_db()
    conn.execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('trash_retention_days', ?)", (str(payload.retention_days),))
    conn.commit()
    _purge_expired_trash(conn)
    conn.close()
    return {"status": "ok"}


@app.post("/api/trash/action")
def api_trash_action(payload: TrashActionPayload):
    conn = get_db()
    cur = conn.cursor()
    _, active_dest = get_active_db_and_dest()
    trash_dir = active_dest / "Corbeille"
    trash_dir.mkdir(parents=True, exist_ok=True)
    now_ts = int(time.time())

    for src in payload.source_paths:
        cur.execute("SELECT * FROM processed_files WHERE source_path = ?", (src,))
        row = cur.fetchone()
        if not row:
            continue
        curr_p = Path(row["dest_path"])
        if payload.action == "MOVE_TO_TRASH":
            orig_p = row["original_dest_path"] or str(curr_p)
            target_t = trash_dir / curr_p.name
            if curr_p.exists() and curr_p != target_t:
                shutil.move(curr_p, target_t)
            cur.execute("UPDATE processed_files SET is_trashed=1, status='trashed', trashed_at=?, dest_path=?, original_dest_path=? WHERE source_path=?", (now_ts, str(target_t), orig_p, src))
        elif payload.action == "RESTORE":
            rest_p = Path(row["original_dest_path"] or (active_dest / "Restaures" / curr_p.name))
            rest_p.parent.mkdir(parents=True, exist_ok=True)
            if curr_p.exists() and curr_p != rest_p:
                shutil.move(curr_p, rest_p)
            cur.execute("UPDATE processed_files SET is_trashed=0, status='restored', trashed_at=NULL, dest_path=? WHERE source_path=?", (str(rest_p), src))
        elif payload.action == "DELETE_PERMANENTLY":
            curr_p.unlink(missing_ok=True)
            cur.execute("DELETE FROM faces WHERE source_path = ?", (src,))
            cur.execute("DELETE FROM processed_files WHERE source_path = ?", (src,))

    conn.commit()
    conn.close()
    return {"status": "ok"}


@app.post("/api/trash/empty_all")
def api_empty_all_trash():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT source_path, dest_path FROM processed_files WHERE is_trashed = 1")
    for r in cur.fetchall():
        Path(r["dest_path"]).unlink(missing_ok=True)
    cur.execute("DELETE FROM processed_files WHERE is_trashed = 1")
    conn.commit()
    conn.close()
    return {"status": "emptied"}


def _recompute_person_stats(cur: sqlite3.Cursor, person_id: int):
    cur.execute("SELECT face_id, det_score, embedding FROM faces WHERE person_id = ?", (person_id,))
    rows = cur.fetchall()
    if not rows:
        cur.execute("DELETE FROM persons WHERE person_id = ?", (person_id,))
        return
    best = max(rows, key=lambda r: r["det_score"] or 0.0)
    embs = [np.frombuffer(r["embedding"], dtype=np.float32) for r in rows if r["embedding"]]
    centroid_blob = None
    if embs:
        c = np.mean(np.vstack(embs), axis=0)
        norm = np.linalg.norm(c)
        if norm > 0:
            centroid_blob = (c / norm).astype(np.float32).tobytes()
    cur.execute("UPDATE persons SET cover_face_id=?, face_count=?, centroid_embedding=? WHERE person_id=?", (best["face_id"], len(rows), centroid_blob, person_id))


@app.get("/api/persons")
def api_get_persons():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT p.person_id, p.name, p.face_count, f.thumb_path
        FROM persons p LEFT JOIN faces f ON p.cover_face_id = f.face_id
        ORDER BY (p.name != 'Inconnu') DESC, p.face_count DESC
    """)
    persons = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"persons": persons}


@app.post("/api/person/rename")
def api_rename_person(payload: RenamePersonPayload):
    conn = get_db()
    conn.execute("UPDATE persons SET name = ? WHERE person_id = ?", (payload.new_name.strip() or "Inconnu", payload.person_id))
    conn.commit()
    conn.close()
    return {"status": "renamed"}


@app.get("/api/person/{person_id}/timeline")
def api_person_timeline(person_id: int):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT person_id, name, face_count FROM persons WHERE person_id = ?", (person_id,))
    person = cur.fetchone()
    if not person:
        conn.close()
        raise HTTPException(404, "Personne introuvable")
    cur.execute("SELECT face_id, source_path, dest_path, timestamp, thumb_path FROM faces WHERE person_id = ? ORDER BY COALESCE(timestamp, 0) ASC", (person_id,))
    faces = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"person": dict(person), "faces": faces}


@app.post("/api/persons/merge")
def api_merge_persons(payload: MergeMultiplePersonsPayload):
    pids = list(dict.fromkeys(payload.person_ids))
    if len(pids) < 2:
        raise HTTPException(400, "Sélectionnez au moins 2 visages.")
    conn = get_db()
    cur = conn.cursor()
    ph = ",".join("?" for _ in pids)
    cur.execute(f"SELECT person_id, name, face_count FROM persons WHERE person_id IN ({ph})", pids)
    rows = sorted(cur.fetchall(), key=lambda r: (r["name"] != "Inconnu", r["face_count"]), reverse=True)
    target_id = rows[0]["person_id"]
    final_name = (payload.target_name or "").strip() or rows[0]["name"]
    other_ids = [r["person_id"] for r in rows[1:]]
    oph = ",".join("?" for _ in other_ids)
    cur.execute(f"UPDATE faces SET person_id = ? WHERE person_id IN ({oph})", [target_id, *other_ids])
    cur.execute(f"DELETE FROM persons WHERE person_id IN ({oph})", other_ids)
    cur.execute("UPDATE persons SET name = ? WHERE person_id = ?", (final_name, target_id))
    _recompute_person_stats(cur, target_id)
    conn.commit()
    conn.close()
    return {"status": "merged", "target_person_id": target_id}


@app.get("/api/persons/suggestions")
def api_merge_suggestions(min_sim: float = 0.38):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT p.person_id, p.name, p.face_count, p.centroid_embedding, f.thumb_path
        FROM persons p LEFT JOIN faces f ON p.cover_face_id = f.face_id
        WHERE p.centroid_embedding IS NOT NULL
    """)
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    if len(rows) < 2:
        return {"suggestions": []}
    vecs = np.vstack([np.frombuffer(r["centroid_embedding"], dtype=np.float32) for r in rows])
    sim_mat = np.dot(vecs, vecs.T)
    pairs = []
    for i in range(len(rows)):
        for j in range(i + 1, len(rows)):
            sc = float(sim_mat[i, j])
            if sc >= min_sim:
                n1, n2 = rows[i]["name"], rows[j]["name"]
                if n1 != "Inconnu" and n2 != "Inconnu" and n1.lower() != n2.lower():
                    continue
                pairs.append({
                    "p1": {k: rows[i][k] for k in ("person_id", "name", "face_count", "thumb_path")},
                    "p2": {k: rows[j][k] for k in ("person_id", "name", "face_count", "thumb_path")},
                    "similarity": round(sc * 100, 1)
                })
    pairs.sort(key=lambda x: x["similarity"], reverse=True)
    return {"suggestions": pairs[:24]}


@app.post("/api/faces/reassign")
def api_reassign_faces(payload: ReassignFacesPayload):
    conn = get_db()
    cur = conn.cursor()
    ph = ",".join("?" for _ in payload.face_ids)
    cur.execute(f"SELECT DISTINCT person_id FROM faces WHERE face_id IN ({ph})", payload.face_ids)
    old_pids = [r["person_id"] for r in cur.fetchall() if r["person_id"]]
    new_pid = None

    if payload.action == "IGNORE":
        cur.execute(f"DELETE FROM faces WHERE face_id IN ({ph})", payload.face_ids)
    elif payload.action == "EXISTING_PERSON" and payload.target_person_id:
        new_pid = payload.target_person_id
        cur.execute(f"UPDATE faces SET person_id = ?, exif_synced_name = NULL WHERE face_id IN ({ph})", [new_pid, *payload.face_ids])
    elif payload.action == "NEW_GROUP":
        cur.execute("INSERT INTO persons (name, face_count) VALUES (?, 0)", ((payload.new_group_name or "Inconnu").strip(),))
        new_pid = cur.lastrowid
        cur.execute(f"UPDATE faces SET person_id = ?, exif_synced_name = NULL WHERE face_id IN ({ph})", [new_pid, *payload.face_ids])

    for pid in set(old_pids):
        _recompute_person_stats(cur, pid)
    if new_pid:
        _recompute_person_stats(cur, new_pid)
    conn.commit()
    conn.close()
    return {"status": "reassigned"}


@app.post("/api/faces/sync_exif")
def api_sync_faces_exif():
    db_p, dest_p = get_active_db_and_dest()
    return sync_all_named_faces_to_exif(db_p, dest_p)


@app.post("/api/faces/manual_add")
def api_add_manual_face(payload: ManualFacePayload):
    media_path = resolve_actual_path(unquote(payload.dest_path))
    if not media_path or not media_path.exists():
        raise HTTPException(404, "Média introuvable")
    img = cv2.imread(str(media_path))
    if img is None:
        raise HTTPException(400, "Impossible de décoder l'image")
    h, w = img.shape[:2]
    x1, y1 = int(max(0, min(payload.norm_x1, payload.norm_x2) * w)), int(max(0, min(payload.norm_y1, payload.norm_y2) * h))
    x2, y2 = int(min(w, max(payload.norm_x1, payload.norm_x2) * w)), int(min(h, max(payload.norm_y1, payload.norm_y2) * h))

    _, active_dest = get_active_db_and_dest()
    import indexeur_visages as fv
    fv.THUMBS_DIR = active_dest / "Miniatures_Visages"
    uid = f"manual_{abs(hash(str(media_path)))}_{int(time.time() * 1000)}"
    thumb_path = save_face_thumbnail(img, [x1, y1, x2, y2], uid)

    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT source_path, timestamp FROM processed_files WHERE dest_path = ?", (str(media_path),))
    pf = cur.fetchone()
    src_path = pf["source_path"] if pf else str(media_path)
    ts = pf["timestamp"] if pf else int(media_path.stat().st_mtime)

    person_id = payload.target_person_id
    if not person_id:
        cur.execute("INSERT INTO persons (name, face_count) VALUES (?, 0)", ((payload.new_person_name or "Inconnu").strip(),))
        person_id = cur.lastrowid

    cur.execute("""
        INSERT INTO faces (source_path, dest_path, timestamp, bbox, det_score, embedding, thumb_path, person_id)
        VALUES (?, ?, ?, ?, 1.0, NULL, ?, ?)
    """, (src_path, str(media_path), ts, f"{x1},{y1},{x2},{y2}", thumb_path, person_id))
    _recompute_person_stats(cur, person_id)
    conn.commit()
    conn.close()
    return {"status": "added"}


@app.get("/api/ocr/search")
def api_ocr_search(q: str = ""):
    conn = get_db()
    cur = conn.cursor()
    if not q.strip():
        cur.execute("SELECT * FROM ocr_results ORDER BY COALESCE(timestamp, 0) DESC LIMIT 48")
    else:
        safe_q = q.replace('"', '').strip()
        cur.execute("""
            SELECT r.* FROM ocr_fts f JOIN ocr_results r ON f.source_path = r.source_path
            WHERE ocr_fts MATCH ? ORDER BY rank LIMIT 60
        """, (f'"{safe_q}"*',))
    results = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"results": results}


@app.get("/api/semantic/search")
def api_semantic_search(q: str = ""):
    db_p, _ = get_active_db_and_dest()
    return {"results": search_photos_by_natural_text(db_p, q)}


@app.get("/api/map/points")
def api_map_points():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT source_path, dest_path, timestamp, latitude, longitude, album_name, is_favorite
        FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0
          AND latitude IS NOT NULL AND longitude IS NOT NULL AND (latitude != 0.0 OR longitude != 0.0)
    """)
    points = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"points": points, "count": len(points)}


@app.get("/api/metadata/inspect")
def api_inspect_metadata(source_path: str):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM processed_files WHERE source_path = ?", (unquote(source_path),))
    row = cur.fetchone()
    conn.close()
    if not row:
        raise HTTPException(404, "Média introuvable")
    d = dict(row)
    tz = get_configured_timezone()
    d["datetime_local_iso"] = datetime.fromtimestamp(d["timestamp"], tz=timezone.utc).astimezone(tz).strftime("%Y-%m-%dT%H:%M:%S") if d["timestamp"] else ""
    d["description"] = ""
    return d


@app.post("/api/metadata/batch_update")
def api_batch_update_metadata(payload: BatchMetadataUpdatePayload):
    conn = get_db()
    cur = conn.cursor()
    tz = get_configured_timezone()
    ph = ",".join("?" for _ in payload.source_paths)
    cur.execute(f"SELECT source_path, dest_path, timestamp, latitude, longitude FROM processed_files WHERE source_path IN ({ph})", payload.source_paths)
    rows_map = {r["source_path"]: dict(r) for r in cur.fetchall()}
    ordered = [rows_map[s] for s in payload.source_paths if s in rows_map]

    base_new_ts = int(datetime.fromisoformat(payload.start_datetime_iso).replace(tzinfo=tz).timestamp()) if payload.start_datetime_iso else None
    first_orig_ts = ordered[0]["timestamp"] if ordered else 0

    with exiftool.ExifToolHelper() as et:
        for idx, item in enumerate(ordered):
            curr_p = Path(item["dest_path"])
            if not curr_p.exists():
                continue
            new_ts = item["timestamp"]
            if base_new_ts is not None:
                if payload.time_sequence_mode == "SAME" or idx == 0:
                    new_ts = base_new_ts
                elif payload.time_sequence_mode == "FIXED_STEP":
                    new_ts = base_new_ts + (idx * max(1, payload.step_seconds))
                else:
                    orig_t = item["timestamp"]
                    new_ts = (base_new_ts + (orig_t - first_orig_ts)) if (orig_t and first_orig_ts and orig_t > first_orig_ts) else (base_new_ts + idx * max(1, payload.step_seconds))

            tags = {}
            is_vid = curr_p.suffix.lower() in VIDEO_EXTS
            if new_ts:
                t_info = fusion.resolve_datetime_with_dst(new_ts, payload.latitude, payload.longitude)
                if not is_vid:
                    tags["DateTimeOriginal"] = t_info["exif_local_str"]
                    tags["CreateDate"] = t_info["exif_local_str"]
                    tags["OffsetTimeOriginal"] = t_info["offset_str"]
                else:
                    tags["QuickTime:CreateDate"] = t_info["exif_utc_str"]
                    tags["Keys:CreationDate"] = t_info["iso_local_with_tz"]

            new_lat = payload.latitude if payload.latitude is not None else item["latitude"]
            new_lon = payload.longitude if payload.longitude is not None else item["longitude"]
            if payload.latitude is not None and payload.longitude is not None:
                tags["GPSLatitude"] = payload.latitude
                tags["GPSLongitude"] = payload.longitude
            if payload.description:
                tags["ImageDescription"] = payload.description

            if tags:
                try:
                    et.set_tags([str(curr_p)], tags=tags, params=["-overwrite_original", "-P", "-q", "-api", "QuickTimeUTC=0"])
                except Exception:
                    pass
            if new_ts:
                os.utime(curr_p, (new_ts, new_ts))
            cur.execute("UPDATE processed_files SET timestamp=?, latitude=?, longitude=? WHERE source_path=?", (new_ts, new_lat, new_lon, item["source_path"]))

    conn.commit()
    conn.close()
    return {"status": "updated"}


@app.post("/api/metadata/batch_strip")
def api_batch_strip_metadata(payload: BatchMetadataStripPayload):
    conn = get_db()
    cur = conn.cursor()
    ph = ",".join("?" for _ in payload.source_paths)
    cur.execute(f"SELECT source_path, dest_path, timestamp FROM processed_files WHERE source_path IN ({ph})", payload.source_paths)
    with exiftool.ExifToolHelper() as et:
        for r in cur.fetchall():
            p = Path(r["dest_path"])
            if not p.exists():
                continue
            params = ["-overwrite_original", "-P", "-q"]
            if payload.strip_all_exif:
                params.extend(["-all=", "-tagsFromFile", "@", "-Orientation", "-ICC_Profile"])
            elif payload.strip_gps:
                params.extend(["-gps:all=", "-XMP:GPSLatitude=", "-XMP:GPSLongitude="])
            try:
                et.execute(*params, str(p))
                if r["timestamp"]:
                    os.utime(p, (r["timestamp"], r["timestamp"]))
            except Exception:
                pass
            if payload.strip_all_exif or payload.strip_gps:
                cur.execute("UPDATE processed_files SET latitude=0.0, longitude=0.0 WHERE source_path=?", (r["source_path"],))
    conn.commit()
    conn.close()
    return {"status": "stripped"}


@app.post("/api/studio/apply")
def api_apply_studio_edits(payload: MediaStudioEditPayload):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM processed_files WHERE source_path = ?", (unquote(payload.source_path),))
    row = cur.fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Média introuvable")
    media_p = Path(row["dest_path"])
    is_vid = media_p.suffix.lower() in VIDEO_EXTS
    ops = payload.model_dump()

    try:
        out_files = [process_image_edits(media_p, ops, overwrite=payload.overwrite, timestamp=row["timestamp"])] if not is_vid else process_video_edits(media_p, ops, overwrite=payload.overwrite, timestamp=row["timestamp"])
    except Exception as e:
        conn.close()
        raise HTTPException(500, f"Erreur d'édition : {e}")

    for out_p in out_files:
        if out_p != media_p:
            cur.execute("""
                INSERT OR REPLACE INTO processed_files
                (source_path, dest_path, original_dest_path, status, timestamp, is_favorite, is_trashed, album_name, latitude, longitude, file_size)
                VALUES (?, ?, ?, 'edited_copy', ?, ?, 0, ?, ?, ?, ?)
            """, (str(out_p), str(out_p), str(out_p), row["timestamp"], row["is_favorite"], row["album_name"], row["latitude"], row["longitude"], out_p.stat().st_size))
        else:
            cur.execute("UPDATE processed_files SET file_size=?, blake3_hash=NULL WHERE source_path=?", (out_p.stat().st_size, row["source_path"]))

    conn.commit()
    conn.close()
    return {"status": "ok", "output_files": [str(p) for p in out_files]}