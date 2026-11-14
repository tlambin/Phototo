import os
import sys
import time
import shutil
import sqlite3
import hashlib
import threading
import subprocess
from pathlib import Path
from datetime import datetime
from urllib.parse import unquote

import cv2
from PIL import Image
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from settings_manager import load_settings, save_settings
from library_manager import open_native_dialog
from pipeline_runner import STATE, start_specific_task, request_stop_pipeline
from database import EMPTY_SVG, MISSING_META_SQL_CONDITION, get_active_db_and_dest, get_db, resolve_actual_path
from media_frames import VIDEO_EXTS

router = APIRouter()


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


def _pct(done: int, total: int) -> float:
    return round((done / total) * 100, 1) if total > 0 else 0.0


@router.get("/api/stats")
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


@router.get("/media")
def serve_media(path: str = ""):
    if not path or not path.strip():
        return Response(content=EMPTY_SVG, media_type="image/svg+xml")
    actual = resolve_actual_path(unquote(path))
    if not actual:
        return Response(content=EMPTY_SVG, media_type="image/svg+xml", status_code=200)
    return FileResponse(actual)


@router.get("/thumb")
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


@router.get("/api/dialog/browse")
def api_browse(mode: str = "folder"):
    return {"paths": open_native_dialog(mode=mode)}


@router.post("/api/notifications/clear")
def api_clear_notifications():
    for n in STATE.notifications:
        n["read"] = True
    return {"status": "ok"}


@router.get("/api/pipeline/status")
def api_pipeline_status():
    return STATE.to_dict()


@router.post("/api/pipeline/run_task")
def api_pipeline_run_task(payload: RunTaskPayload):
    try:
        return start_specific_task(payload.task)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/api/pipeline/stop")
def api_pipeline_stop(cancel: bool = False):
    return request_stop_pipeline(cancel=cancel)


@router.get("/api/settings")
def api_get_settings():
    return load_settings()


@router.post("/api/settings/save")
def api_save_settings_route(payload: SettingsPayload):
    saved = save_settings({
        "scanned_folders": [p.strip() for p in payload.scanned_folders if p.strip()],
        "takeout_extract_dir": payload.takeout_extract_dir.strip(),
        "timezone": payload.timezone.strip(),
        "language": payload.language.strip(),
        "gpu_mode": payload.gpu_mode.strip()
    })
    return {"status": "saved", "settings": saved}


@router.post("/api/database/backup")
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


@router.post("/api/tools/reset")
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
        cur.execute("SELECT source_path, dest_path, original_dest_path FROM processed_files WHERE is_duplicate = 1 AND dest_path IS NOT NULL")
        for r in cur.fetchall():
            curr_dest = Path(r["dest_path"])
            orig_dest = Path(r["original_dest_path"]) if r["original_dest_path"] else curr_dest
            q_file = curr_dest if curr_dest.exists() else (q_dir / orig_dest.name)
            if q_file.exists() and orig_dest != q_file and not orig_dest.exists():
                orig_dest.parent.mkdir(parents=True, exist_ok=True)
                try:
                    shutil.move(q_file, orig_dest)
                    cur.execute("UPDATE processed_files SET dest_path = ? WHERE source_path = ?", (str(orig_dest), r["source_path"]))
                except Exception:
                    pass
        cols = {r[1] for r in cur.execute("PRAGMA table_info(processed_files)")}
        if "master_path" in cols:
            cur.execute("UPDATE processed_files SET blake3_hash = NULL, is_duplicate = 0, duplicate_of = NULL, master_path = NULL, dup_type = NULL")
        else:
            cur.execute("UPDATE processed_files SET blake3_hash = NULL, is_duplicate = 0, duplicate_of = NULL")
    else:
        conn.close()
        raise HTTPException(400, f"Outil inconnu : {tool}")

    conn.commit()
    conn.close()
    return {"status": "reset", "tool": tool}


@router.post("/api/database/prune_missing")
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


@router.post("/api/system/restart")
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


@router.post("/api/system/shutdown")
def api_system_shutdown():
    if STATE.is_running:
        STATE.stop_requested = True
        time.sleep(0.4)

    def _quit():
        time.sleep(0.6)
        os._exit(0)

    threading.Thread(target=_quit, daemon=True).start()
    return {"status": "shutting_down"}
