import os
import re
import sys
import time
import shutil
import sqlite3
import hashlib
import threading
import subprocess
import importlib.metadata
import json
import zipfile
import urllib.request
from pathlib import Path
from datetime import datetime
from urllib.parse import unquote, urljoin

import cv2
from PIL import Image
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from settings_manager import (
    load_settings, save_settings, detect_system_hardware, get_hardware_runtime_config,
    FACES_MODEL_SPECS, CLIP_MODEL_SPECS
)
from library_manager import open_native_dialog, get_library_tech_dir
from pipeline_runner import STATE, start_specific_task, request_stop_pipeline, record_interrupted_active_task, notify_unadded_source_files
from database import (
    EMPTY_SVG,
    MISSING_META_SQL_CONDITION,
    get_active_db_and_dest,
    get_db,
    resolve_actual_path,
    list_activity_entries,
    get_activity_entry,
    delete_activity_entry,
    clear_activity_entries,
    cancel_paused_activity_entry,
    log_library_action,
    build_file_entry,
)
from media_frames import VIDEO_EXTS

router = APIRouter()


class RunTaskPayload(BaseModel):
    task: str


class ResetToolPayload(BaseModel):
    tool: str


class SettingsPayload(BaseModel):
    scanned_folders: list[str]
    takeout_extract_dir: str
    takeout_default_architecture: str = "KEEP_ORIGINAL"
    takeout_default_fix_metadata: bool = True
    takeout_default_delete_zips: bool = False
    takeout_timezone_mode: str | None = None
    takeout_use_gps_timezone: bool = True
    timezone: str
    language: str
    home_country: str = "France"
    gpu_mode: str
    ocr_engine: str = "paddleocr"
    faces_model: str = "buffalo_l"
    clip_model: str = "vit-b-32"
    ui_blur: bool = True


class ReindexModelPayload(BaseModel):
    module_id: str
    include_unknown: bool = True


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
    cache_dir = get_library_tech_dir(dest_dir, "Miniatures_Cache")
    cache_dir.mkdir(parents=True, exist_ok=True)

    stat = actual.stat()
    hash_key = hashlib.md5(f"{actual}_{stat.st_size}_{int(stat.st_mtime)}".encode("utf-8")).hexdigest()
    thumb_path = cache_dir / f"{hash_key}.webp"

    if thumb_path.exists():
        return FileResponse(thumb_path, media_type="image/webp", headers={"Cache-Control": "public, max-age=31536000, immutable"})

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
                return FileResponse(thumb_path, media_type="image/webp", headers={"Cache-Control": "public, max-age=31536000, immutable"})
        else:
            with Image.open(actual) as im:
                try:
                    im.draft("RGB", (720, 720))
                except Exception:
                    pass
                im.thumbnail((360, 360), Image.Resampling.BILINEAR)
                if im.mode not in ("RGB", "RGBA"):
                    im = im.convert("RGB")
                im.save(thumb_path, "WEBP", quality=78, method=1)
                return FileResponse(thumb_path, media_type="image/webp", headers={"Cache-Control": "public, max-age=31536000, immutable"})
    except Exception:
        pass

    return FileResponse(actual)


@router.get("/api/dialog/browse")
def api_browse(mode: str = "folder"):
    return {"paths": open_native_dialog(mode=mode)}


@router.post("/api/notifications/clear")
def api_clear_notifications():
    with STATE._lock:
        for n in STATE.notifications:
            n["read"] = True
    return {"status": "ok"}


@router.delete("/api/notifications/{notif_id}")
def api_delete_notification(notif_id: int):
    with STATE._lock:
        STATE.notifications = [n for n in STATE.notifications if n.get("id") != notif_id]
        remaining = list(STATE.notifications)
    return {"status": "ok", "notifications": remaining}


@router.delete("/api/notifications")
def api_delete_all_notifications():
    with STATE._lock:
        STATE.notifications.clear()
    return {"status": "ok", "notifications": []}


@router.get("/api/activities")
def api_list_activities():
    return {"activities": list_activity_entries(limit=200)}


class ClientActivityLogPayload(BaseModel):
    action_type: str
    title: str
    detail: str = ""
    files: list[str] = []


@router.post("/api/activities/log")
def api_log_client_activity(payload: ClientActivityLogPayload):
    act = (payload.action_type or "").strip().upper()
    if act not in {"MEDIA_DOWNLOAD", "MEDIA_SHARE"}:
        raise HTTPException(400, "Type d'action client non autorisé.")
    file_entries = [build_file_entry(p) for p in (payload.files or []) if str(p).strip()]
    log_library_action(
        act,
        (payload.title or "").strip() or ("Partage" if act == "MEDIA_SHARE" else "Téléchargement"),
        (payload.detail or "").strip(),
        files=file_entries,
    )
    return {"status": "ok"}


@router.get("/api/activities/export")
def api_export_activities():
    acts = list_activity_entries(limit=1000)
    ts_name = datetime.now().strftime("%Y-%m-%d_%H-%M")
    body = json.dumps(
        {"exported_at": datetime.now().isoformat(timespec="seconds"), "count": len(acts), "activities": acts},
        ensure_ascii=False,
        indent=2,
    )
    return Response(
        content=body.encode("utf-8"),
        media_type="application/json; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="phototo_activites_{ts_name}.json"'},
    )


@router.post("/api/activities/{activity_id}/resume")
def api_resume_activity(activity_id: int):
    entry = get_activity_entry(activity_id)
    if not entry:
        raise HTTPException(404, "Activité introuvable.")
    raw_params = str(entry.get("params_json") or "").strip()
    if raw_params:
        try:
            import libraries_router
            p_dict = json.loads(raw_params)
            return libraries_router.api_import_add_sources(libraries_router.AddImportSourcesPayload(**p_dict))
        except Exception as e:
            raise HTTPException(400, f"Impossible de reprendre l'importation : {e}")
    act = str(entry.get("action_type") or "").upper()
    task_map = {
        "INGEST": "INGEST",
        "UNZIP": "INGEST",
        "IMPORT": "INGEST",
        "METADATA": "INGEST",
        "FACES": "FACES",
        "OCR": "OCR",
        "DEDUP": "DEDUP",
        "SIMILAR": "SIMILAR",
        "CLIP": "CLIP",
    }
    task_code = task_map.get(act)
    if not task_code:
        raise HTTPException(400, "Cette action ne peut pas être relancée automatiquement.")
    try:
        return start_specific_task(task_code)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/api/activities/{activity_id}")
def api_delete_activity(activity_id: int):
    return {"status": "ok", "activities": delete_activity_entry(activity_id)}


@router.delete("/api/activities")
def api_clear_activities():
    return {"status": "ok", "activities": clear_activity_entries()}


@router.post("/api/activities/{activity_id}/cancel_pause")
def api_cancel_paused_activity(activity_id: int):
    return {"status": "ok", "activities": cancel_paused_activity_entry(activity_id)}


@router.post("/api/activities/check_sources")
def api_check_activities_sources():
    threading.Thread(target=notify_unadded_source_files, daemon=True).start()
    return {"status": "checking"}


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


@router.get("/api/hardware")
def api_get_hardware(refresh: bool = False):
    return {
        "hardware": detect_system_hardware(refresh=refresh),
        "runtime": get_hardware_runtime_config(),
        "configured_mode": load_settings().get("gpu_mode", "auto"),
    }


@router.post("/api/settings/save")
def api_save_settings_route(payload: SettingsPayload):
    prev = load_settings()
    prev_faces = str(prev.get("faces_model", "buffalo_l")).strip()
    prev_clip = str(prev.get("clip_model", "vit-b-32")).strip().lower()
    arch = str(payload.takeout_default_architecture or "KEEP_ORIGINAL").strip().upper()
    if arch not in {"KEEP_ORIGINAL", "GOOGLE_ALBUM", "NONE"}:
        arch = "KEEP_ORIGINAL"
    tz_mode = str(payload.takeout_timezone_mode or "").strip().upper()
    if tz_mode not in {"GPS_OR_SETTINGS", "SETTINGS_ONLY", "UTC"}:
        tz_mode = "GPS_OR_SETTINGS" if payload.takeout_use_gps_timezone else "SETTINGS_ONLY"
    saved = save_settings({
        "scanned_folders": [p.strip() for p in payload.scanned_folders if p.strip()],
        "takeout_extract_dir": payload.takeout_extract_dir.strip(),
        "takeout_default_architecture": arch,
        "takeout_default_fix_metadata": bool(payload.takeout_default_fix_metadata),
        "takeout_default_delete_zips": bool(payload.takeout_default_delete_zips),
        "takeout_timezone_mode": tz_mode,
        "takeout_use_gps_timezone": (tz_mode == "GPS_OR_SETTINGS"),
        "timezone": payload.timezone.strip(),
        "language": payload.language.strip(),
        "home_country": (payload.home_country or "").strip(),
        "gpu_mode": payload.gpu_mode.strip(),
        "ocr_engine": (payload.ocr_engine or "paddleocr").strip().lower(),
        "faces_model": (payload.faces_model or "buffalo_l").strip(),
        "clip_model": (payload.clip_model or "vit-b-32").strip().lower(),
        "ui_blur": bool(payload.ui_blur),
    })
    if prev_faces != saved["faces_model"] or prev_clip != saved["clip_model"]:
        try:
            db_p, _ = get_active_db_and_dest()
            if db_p.exists():
                conn = get_db()
                cols = {r[1] for r in conn.execute("PRAGMA table_info(processed_files)").fetchall()}
                if prev_faces != saved["faces_model"] and "faces_model" in cols:
                    conn.execute(
                        "UPDATE processed_files SET faces_model = ? WHERE faces_scanned = 1 AND (faces_model IS NULL OR faces_model = '')",
                        (prev_faces,),
                    )
                if prev_clip != saved["clip_model"] and "clip_model" in cols:
                    conn.execute(
                        "UPDATE processed_files SET clip_model = ? WHERE clip_scanned = 1 AND (clip_model IS NULL OR clip_model = '')",
                        (prev_clip,),
                    )
                conn.commit()
                conn.close()
        except Exception:
            pass
    return {"status": "saved", "settings": saved}


@router.post("/api/database/backup")
def api_backup_database():
    db_path, dest_dir = get_active_db_and_dest()
    if not db_path.exists():
        raise HTTPException(404, "Aucune base de données active trouvée.")

    backup_dir = get_library_tech_dir(dest_dir, "Sauvegardes_DB")
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
        log_library_action(
            "DB_BACKUP",
            "Sauvegarde de la base de données",
            f"{backup_file.name} ({size_mb} Mo)",
            files=[build_file_entry(str(backup_file))],
        )
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
        cur.execute("UPDATE processed_files SET faces_scanned = 0, faces_model = NULL")
        thumbs_dir = get_library_tech_dir(dest_dir, "Miniatures_Visages")
        if thumbs_dir.exists():
            shutil.rmtree(thumbs_dir, ignore_errors=True)
    elif tool == "OCR":
        cur.execute("DELETE FROM ocr_results")
        cur.execute("DELETE FROM ocr_fts")
        cur.execute("UPDATE processed_files SET ocr_scanned = 0")
    elif tool == "CLIP":
        cur.execute("UPDATE processed_files SET clip_scanned = 0, clip_embedding = NULL, clip_model = NULL")
    elif tool == "SIMILAR":
        cur.execute("UPDATE processed_files SET phash = NULL, video_hash = NULL")
    elif tool == "DEDUP":
        q_dir = get_library_tech_dir(dest_dir, "Doublons_Quarantaine")
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
    log_library_action("TOOL_RESET", "Réinitialisation d'outil", f"Données réinitialisées pour {tool}")
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
    if missing_sources:
        log_library_action(
            "DB_PRUNE",
            "Nettoyage des fichiers absents",
            f"{len(missing_sources)} fichier(s) absent(s) retiré(s) de la base",
            files=[build_file_entry(s[0]) for s in missing_sources],
        )
    return {"status": "ok", "removed_count": len(missing_sources)}


def _prepare_power_transition(activity_action: str = "pause", wait_timeout_sec: float = 4.0) -> str:
    """Apply user's choice (pause / stop / ignore) for any running pipeline task before power transition."""
    action = str(activity_action or "pause").strip().lower()
    if action not in ("pause", "stop", "ignore"):
        action = "pause"

    if action == "ignore":
        if STATE.is_running:
            record_interrupted_active_task()
    elif STATE.is_running:
        request_stop_pipeline(cancel=(action == "stop"))
        deadline = time.time() + max(0.0, float(wait_timeout_sec))
        while STATE.is_running and time.time() < deadline:
            time.sleep(0.05)
    return action


@router.post("/api/system/restart")
def api_system_restart(activity_action: str = "pause"):
    chosen = _prepare_power_transition(activity_action)

    def _respawn():
        time.sleep(0.3 if chosen == "ignore" else 0.5)
        subprocess.Popen([sys.executable, "main.py"], cwd=os.getcwd())
        os._exit(0)

    threading.Thread(target=_respawn, daemon=True).start()
    return {"status": "restarting", "activity_action": chosen}


@router.post("/api/system/shutdown")
def api_system_shutdown(activity_action: str = "pause"):
    chosen = _prepare_power_transition(activity_action)

    def _quit():
        time.sleep(0.3 if chosen == "ignore" else 0.5)
        os._exit(0)

    threading.Thread(target=_quit, daemon=True).start()
    return {"status": "shutting_down", "activity_action": chosen}


# ==================== GESTION DE L'IA LOCALE ====================

class AiActionPayload(BaseModel):
    module: str  # "faces" | "clip" | "ocr" | "all"
    action: str  # "verify" | "install" | "update" | "uninstall"


_AI_TASK_LOCK = threading.Lock()
_AI_TASK_STATE: dict = {
    "running": False,
    "module": None,
    "action": None,
    "logs": [],
    "success": None,
    "error": None,
}

_AI_MODULES_META = {
    "faces": {
        "id": "faces",
        "name": "Reconnaissance Faciale (InsightFace)",
        "description": "Détection et reconnaissance des visages en local (modèle buffalo_l + ONNX Runtime).",
        "packages": ["insightface", "onnxruntime"],
        "alt_onnx": ["onnxruntime-gpu", "onnxruntime-directml", "onnxruntime"],
    },
    "clip": {
        "id": "clip",
        "name": "Recherche Visuelle IA (CLIP)",
        "description": "Recherche sémantique par description texte et similarité visuelle (PyTorch + Sentence-Transformers).",
        "packages": ["torch", "torchvision", "sentence-transformers"],
    },
    "ocr": {
        "id": "ocr",
        "name": "Reconnaissance de Texte (OCR)",
        "description": "Extraction automatique du texte présent dans les photos et captures d'écran.",
        "packages": ["paddlepaddle", "paddleocr"],
    },
}

_OCR_ENGINES_META = {
    "rapidocr": {
        "id": "rapidocr",
        "label": "RapidOCR (ONNX GPU)",
        "description": "Modèles PaddleOCR via ONNX Runtime : GPU natif et sans conflit.",
        "packages": ["rapidocr-onnxruntime"],
    },
    "easyocr": {
        "id": "easyocr",
        "label": "EasyOCR (PyTorch GPU)",
        "description": "Basé sur PyTorch CUDA, simple et sans conflit DLL.",
        "packages": ["easyocr"],
    },
    "paddleocr": {
        "id": "paddleocr",
        "label": "PaddleOCR",
        "description": "Moteur PaddlePaddle natif (CPU sous Windows : paddlepaddle-gpu provoque des conflits DLL CUDA avec PyTorch/ONNX ; préférez RapidOCR ou EasyOCR pour le GPU).",
        "packages": ["paddlepaddle", "paddleocr"],
    },
}


def _active_ocr_engine() -> str:
    eng = str(load_settings().get("ocr_engine", "paddleocr")).strip().lower()
    return eng if eng in _OCR_ENGINES_META else "paddleocr"


def _active_faces_model() -> str:
    m = str(load_settings().get("faces_model", "buffalo_l")).strip()
    return m if m in FACES_MODEL_SPECS else "buffalo_l"


def _active_clip_model() -> str:
    m = str(load_settings().get("clip_model", "vit-b-32")).strip().lower()
    return m if m in CLIP_MODEL_SPECS else "vit-b-32"


def _pkg_version(pkg_name: str) -> str | None:
    try:
        return importlib.metadata.version(pkg_name)
    except importlib.metadata.PackageNotFoundError:
        return None
    except Exception:
        return None


def _safe_path_exists(path: Path) -> bool:
    try:
        return path.exists()
    except OSError:
        return False


def _dir_size_mb(path: Path) -> float:
    if not _safe_path_exists(path):
        return 0.0
    total = 0
    try:
        for f in path.rglob("*"):
            if f.is_file():
                total += f.stat().st_size
    except OSError:
        pass
    return round(total / (1024 * 1024), 1)


def _get_ai_cache_paths(module_id: str, ocr_engine: str | None = None, faces_model: str | None = None, clip_model: str | None = None) -> list[Path]:
    home = Path.home()
    if module_id == "faces":
        fm = faces_model or _active_faces_model()
        return [home / ".insightface" / "models" / fm]
    if module_id == "ocr":
        eng = ocr_engine or _active_ocr_engine()
        if eng == "easyocr":
            return [home / ".EasyOCR" / "model"]
        if eng == "rapidocr":
            try:
                import rapidocr_onnxruntime
                return [Path(rapidocr_onnxruntime.__file__).resolve().parent / "models"]
            except Exception:
                return []
        return [home / ".paddleocr", home / ".paddlex"]
    if module_id == "clip":
        cm = clip_model or _active_clip_model()
        tokens = CLIP_MODEL_SPECS[cm]["cache_tokens"]
        hf_hub = Path(os.environ.get("HF_HOME", str(home / ".cache" / "huggingface"))) / "hub"
        st_cache = home / ".cache" / "torch" / "sentence_transformers"
        paths: list[Path] = []
        for base in (hf_hub, st_cache):
            try:
                if base.exists():
                    for p in base.iterdir():
                        low = p.name.lower()
                        if any(tok in low for tok in tokens):
                            paths.append(p)
            except OSError:
                pass
        return paths
    return []


def _count_stale_model_media(module_id: str, target_model: str, include_unknown: bool = False) -> int:
    """Compte les médias actifs déjà analysés avec un modèle différent du modèle cible."""
    if module_id not in ("faces", "clip") or not target_model:
        return 0
    try:
        db_p, _ = get_active_db_and_dest()
        if not db_p.exists():
            return 0
        conn = get_db()
        cur = conn.cursor()
        cols = {r[1] for r in cur.execute("PRAGMA table_info(processed_files)").fetchall()}
        scan_col = "faces_scanned" if module_id == "faces" else "clip_scanned"
        model_col = "faces_model" if module_id == "faces" else "clip_model"
        if scan_col not in cols:
            conn.close()
            return 0
        if model_col not in cols:
            sql = f"SELECT COUNT(*) FROM processed_files WHERE is_duplicate = 0 AND is_trashed = 0 AND {scan_col} = 1"
            cnt = int(cur.execute(sql).fetchone()[0] or 0) if include_unknown else 0
            conn.close()
            return cnt
        if include_unknown:
            sql = (
                f"SELECT COUNT(*) FROM processed_files "
                f"WHERE is_duplicate = 0 AND is_trashed = 0 AND {scan_col} = 1 "
                f"AND ({model_col} IS NULL OR {model_col} = '' OR {model_col} != ?)"
            )
        else:
            sql = (
                f"SELECT COUNT(*) FROM processed_files "
                f"WHERE is_duplicate = 0 AND is_trashed = 0 AND {scan_col} = 1 "
                f"AND {model_col} IS NOT NULL AND {model_col} != '' AND {model_col} != ?"
            )
        cnt = int(cur.execute(sql, (target_model,)).fetchone()[0] or 0)
        conn.close()
        return cnt
    except Exception:
        return 0


def _inspect_ai_module(module_id: str) -> dict:
    meta = _AI_MODULES_META[module_id]
    pkg_versions: dict[str, str | None] = {}
    ocr_engine = _active_ocr_engine() if module_id == "ocr" else None
    faces_model = _active_faces_model() if module_id == "faces" else None
    clip_model = _active_clip_model() if module_id == "clip" else None
    if module_id == "faces":
        pkg_versions["insightface"] = _pkg_version("insightface")
        onnx_ver = None
        onnx_name = "onnxruntime"
        for cand in meta["alt_onnx"]:
            v = _pkg_version(cand)
            if v:
                onnx_ver = v
                onnx_name = cand
                break
        pkg_versions[onnx_name] = onnx_ver
    elif module_id == "ocr":
        for p in _OCR_ENGINES_META[ocr_engine]["packages"]:
            pkg_versions[p] = _pkg_version(p)
    else:
        for p in meta["packages"]:
            pkg_versions[p] = _pkg_version(p)

    packages_ok = all(v is not None for v in pkg_versions.values())
    cache_paths = _get_ai_cache_paths(module_id, ocr_engine=ocr_engine, faces_model=faces_model, clip_model=clip_model)
    cache_size_mb = round(sum(_dir_size_mb(p) for p in cache_paths), 1)
    model_cached = False
    for p in cache_paths:
        try:
            if _safe_path_exists(p) and any(p.rglob("*")):
                model_cached = True
                break
        except OSError:
            pass
    if module_id == "ocr" and ocr_engine == "rapidocr" and packages_ok:
        model_cached = True

    if packages_ok and model_cached:
        status = "ready"
    elif packages_ok:
        status = "partial"
    else:
        status = "not_installed"

    desc = meta["description"]
    hw_rt = get_hardware_runtime_config()
    hw_det = detect_system_hardware()
    device_label = "CPU"
    if module_id == "faces":
        desc = FACES_MODEL_SPECS[faces_model]["description"]
        if hw_rt["mode"] == "cuda" and "CUDAExecutionProvider" in hw_det.get("onnx_providers", []):
            device_label = "GPU (CUDA)"
        elif hw_rt["mode"] in ("directml", "amd") and "DmlExecutionProvider" in hw_det.get("onnx_providers", []):
            device_label = "GPU (DirectML)"
    elif module_id == "clip":
        desc = CLIP_MODEL_SPECS[clip_model]["description"]
        if hw_rt["torch_device"] == "cuda" and hw_det.get("torch_cuda_available"):
            device_label = "GPU (CUDA)"
        elif hw_rt["torch_device"] == "xpu":
            device_label = "GPU (XPU)"
    elif module_id == "ocr":
        desc = _OCR_ENGINES_META[ocr_engine]["description"]
        if ocr_engine == "rapidocr" and hw_rt["mode"] == "cuda" and "CUDAExecutionProvider" in hw_det.get("onnx_providers", []):
            device_label = "GPU (ONNX CUDA)"
        elif ocr_engine == "easyocr" and hw_rt["torch_device"] == "cuda" and hw_det.get("torch_cuda_available"):
            device_label = "GPU (PyTorch CUDA)"
        elif ocr_engine == "paddleocr" and hw_rt.get("paddle_use_gpu"):
            device_label = "CPU (Paddle)"

    res = {
        "id": module_id,
        "name": meta["name"],
        "description": desc,
        "device_label": device_label,
        "packages": pkg_versions,
        "packages_ok": packages_ok,
        "model_cached": model_cached,
        "cache_size_mb": cache_size_mb,
        "status": status,
    }
    if module_id == "faces":
        res["selected_model"] = faces_model
        res["stale_media_count"] = _count_stale_model_media("faces", faces_model, include_unknown=False)
        res["model_options"] = [
            {
                "id": fid,
                "label": fspec["label"],
                "description": fspec["description"],
                "cached": any(_safe_path_exists(p) and any(p.rglob("*")) for p in _get_ai_cache_paths("faces", faces_model=fid)),
            }
            for fid, fspec in FACES_MODEL_SPECS.items()
        ]
    elif module_id == "clip":
        res["selected_model"] = clip_model
        res["stale_media_count"] = _count_stale_model_media("clip", clip_model, include_unknown=False)
        res["model_options"] = [
            {
                "id": cid,
                "label": cspec["label"],
                "description": cspec["description"],
                "cached": any(_safe_path_exists(p) and any(p.rglob("*")) for p in _get_ai_cache_paths("clip", clip_model=cid)),
            }
            for cid, cspec in CLIP_MODEL_SPECS.items()
        ]
    elif module_id == "ocr":
        res["selected_model"] = ocr_engine
        res["model_options"] = [
            {
                "id": eid,
                "label": emeta["label"],
                "description": emeta["description"],
                "cached": all(_pkg_version(p) is not None for p in emeta["packages"]),
            }
            for eid, emeta in _OCR_ENGINES_META.items()
        ]
        res["ocr_engine"] = ocr_engine
        res["ocr_engines"] = [
            {
                "id": eid,
                "label": emeta["label"],
                "description": emeta["description"],
                "installed": all(_pkg_version(p) is not None for p in emeta["packages"]),
            }
            for eid, emeta in _OCR_ENGINES_META.items()
        ]
    return res


def _append_ai_log(line: str):
    _AI_TASK_STATE["logs"].append(line)
    if len(_AI_TASK_STATE["logs"]) > 200:
        _AI_TASK_STATE["logs"] = _AI_TASK_STATE["logs"][-200:]


def _run_cmd_logged(cmd: list[str]) -> int:
    _append_ai_log(f"> {' '.join(cmd)}")
    env = {
        **os.environ,
        "KMP_DUPLICATE_LIB_OK": "TRUE",
        "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK": "True",
    }
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
    )
    assert proc.stdout is not None
    for raw in proc.stdout:
        line = raw.rstrip()
        if line:
            _append_ai_log(line)
    return proc.wait()


def _has_any_onnxruntime() -> str | None:
    for cand in ("onnxruntime-gpu", "onnxruntime-directml", "onnxruntime"):
        if _pkg_version(cand) is not None:
            return cand
    return None


_PKG_IMPORT_ALIASES = {
    "opencv-python-headless": ("cv2",),
    "PyYAML": ("yaml",),
    "Pillow": ("PIL",),
    "numpy": ("numpy",),
    "scikit-image": ("skimage",),
    "python-bidi": ("bidi",),
    "Shapely": ("shapely",),
}


def _is_pip_dep_satisfied(pkg_spec: str) -> bool:
    name = pkg_spec.split(">=")[0].split("<")[0].split("==")[0].strip()
    if _pkg_version(name) is not None:
        return True
    if name == "opencv-python-headless":
        for alt in ("opencv-python", "opencv-contrib-python", "opencv-contrib-python-headless"):
            if _pkg_version(alt) is not None:
                return True
    for mod in _PKG_IMPORT_ALIASES.get(name, ()):
        try:
            __import__(mod)
            return True
        except Exception:
            pass
    return False


def _install_missing_pip_deps(deps: list[str]) -> bool:
    missing = [d for d in deps if not _is_pip_dep_satisfied(d)]
    if not missing:
        return True
    rc = _run_cmd_logged([sys.executable, "-m", "pip", "install", *missing])
    return rc == 0


def _ensure_onnxruntime_package(effective_mode: str, upgrade: bool, up_flag: list[str]) -> tuple[bool, str]:
    target_pkg = "onnxruntime-gpu" if effective_mode == "cuda" else ("onnxruntime-directml" if effective_mode == "directml" else "onnxruntime")
    installed_variant = _has_any_onnxruntime()

    if installed_variant == target_pkg and not upgrade:
        _append_ai_log(f"✓ {target_pkg} déjà installé (conservé sans réécriture DLL).")
        return (True, target_pkg)

    # Si onnxruntime-gpu / directml est déjà installé et fonctionnel, le préserver sur un install simple
    if installed_variant in ("onnxruntime-gpu", "onnxruntime-directml") and not upgrade:
        _append_ai_log(f"✓ {installed_variant} déjà présent et conservé.")
        return (True, installed_variant)

    rc = _run_cmd_logged([sys.executable, "-m", "pip", "install", *up_flag, target_pkg])
    if rc != 0 and target_pkg != "onnxruntime" and installed_variant is None:
        rc = _run_cmd_logged([sys.executable, "-m", "pip", "install", *up_flag, "onnxruntime"])
        if rc == 0:
            return (True, "onnxruntime")

    if rc != 0:
        if installed_variant is not None:
            _append_ai_log(f"⚠ {installed_variant} est verrouillé en mémoire par le serveur actif ; version actuelle conservée (redémarrez puis relancez pour mettre à jour).")
            return (True, installed_variant)
        return (False, target_pkg)
    return (True, target_pkg)


def _install_or_update_single_module(mod_id: str, upgrade: bool, gpu_mode: str) -> bool:
    up_flag = ["--upgrade"] if upgrade else []
    hw_info = detect_system_hardware()
    effective_mode = gpu_mode
    if effective_mode == "auto":
        effective_mode = "cuda" if hw_info.get("gpu_vendor") == "nvidia" else hw_info.get("recommended_mode", "cpu")

    if mod_id == "faces":
        onnx_ok, active_onnx = _ensure_onnxruntime_package(effective_mode, upgrade, up_flag)
        if not onnx_ok:
            return False
        if upgrade or _pkg_version("insightface") is None:
            if active_onnx != "onnxruntime":
                # insightface 2.1 déclare 'onnxruntime' (CPU) dans ses métadonnées ; --no-deps préserve onnxruntime-gpu/directml
                _install_missing_pip_deps(["onnx", "easydict", "albumentations", "prettytable", "scikit-image", "matplotlib", "scipy", "scikit-learn"])
                rc2 = _run_cmd_logged([sys.executable, "-m", "pip", "install", *up_flag, "--no-deps", "insightface>=2.1"])
            else:
                rc2 = _run_cmd_logged([sys.executable, "-m", "pip", "install", *up_flag, "insightface>=2.1"])
            if rc2 != 0:
                return False
        faces_model = _active_faces_model()
        _append_ai_log(f"Téléchargement / vérification du modèle {faces_model}...")
        rc3 = _run_cmd_logged([
            sys.executable, "-c",
            f"import sys; sys.path.insert(0, 'backend/core'); sys.path.insert(0, 'backend/engines'); from indexeur_visages import create_face_analysis; create_face_analysis('{faces_model}', providers=['CPUExecutionProvider'], ctx_id=-1); print('InsightFace {faces_model} OK')"
        ])
        detect_system_hardware(refresh=True)
        return rc3 == 0

    if mod_id == "clip":
        torch_ver = _pkg_version("torch") or ""
        torch_cuda_ready = bool(hw_info.get("torch_cuda_available") and "+cpu" not in torch_ver)
        if effective_mode == "cuda":
            if not torch_cuda_ready or upgrade:
                cuda_tag = hw_info.get("cuda_index") or "cu128"
                cuda_flags = ["--force-reinstall"] if (not hw_info.get("torch_cuda_available") or "+cpu" in torch_ver) else up_flag
                _append_ai_log(f"Installation de PyTorch avec support NVIDIA CUDA ({cuda_tag})...")
                rc1 = _run_cmd_logged([sys.executable, "-m", "pip", "install", *cuda_flags, "torch", "torchvision", "--index-url", f"https://download.pytorch.org/whl/{cuda_tag}"])
                if rc1 != 0 and cuda_tag != "cu124":
                    _append_ai_log("Repli sur l'index CUDA compatible cu124...")
                    rc1 = _run_cmd_logged([sys.executable, "-m", "pip", "install", *cuda_flags, "torch", "torchvision", "--index-url", "https://download.pytorch.org/whl/cu124"])
                if rc1 != 0:
                    rc1 = _run_cmd_logged([sys.executable, "-m", "pip", "install", *up_flag, "torch", "torchvision"])
                if rc1 != 0 and not torch_ver:
                    return False
        elif upgrade or not torch_ver:
            rc1 = _run_cmd_logged([sys.executable, "-m", "pip", "install", *up_flag, "torch", "torchvision"])
            if rc1 != 0 and not torch_ver:
                return False

        if upgrade or _pkg_version("sentence-transformers") is None:
            rc2 = _run_cmd_logged([sys.executable, "-m", "pip", "install", *up_flag, "sentence-transformers>=3.0.0"])
            if rc2 != 0:
                return False
        clip_key = _active_clip_model()
        spec = CLIP_MODEL_SPECS[clip_key]
        _append_ai_log(f"Téléchargement / vérification des modèles {spec['label']}...")
        v_name = spec["vision_model"]
        t_name = spec["text_model"]
        dl_cmd = f"from sentence_transformers import SentenceTransformer; SentenceTransformer('{v_name}')"
        if t_name != v_name:
            dl_cmd += f"; SentenceTransformer('{t_name}')"
        dl_cmd += "; print('CLIP OK')"
        rc3 = _run_cmd_logged([sys.executable, "-c", dl_cmd])
        detect_system_hardware(refresh=True)
        return rc3 == 0

    if mod_id == "ocr":
        ocr_eng = _active_ocr_engine()
        if ocr_eng == "rapidocr":
            # rapidocr-onnxruntime déclare 'onnxruntime' (CPU) : on garantit d'abord onnxruntime-gpu/directml/cpu sans réécrire la DLL chargée, puis --no-deps
            onnx_ok, _ = _ensure_onnxruntime_package(effective_mode, upgrade=False, up_flag=[])
            if not onnx_ok:
                return False
            if not _install_missing_pip_deps(["pyclipper", "PyYAML", "Shapely", "six", "tqdm", "Pillow", "opencv-python-headless", "numpy"]):
                return False
            if upgrade or _pkg_version("rapidocr-onnxruntime") is None:
                rc1 = _run_cmd_logged([sys.executable, "-m", "pip", "install", *up_flag, "--no-deps", "rapidocr-onnxruntime"])
                if rc1 != 0:
                    return False
            _append_ai_log("Vérification de RapidOCR (ONNX)...")
            rc2 = _run_cmd_logged([sys.executable, "-c", "from rapidocr_onnxruntime import RapidOCR; RapidOCR(); print('RapidOCR OK')"])
            return rc2 == 0

        if ocr_eng == "easyocr":
            torch_ver = _pkg_version("torch") or ""
            torch_cuda_ready = bool(hw_info.get("torch_cuda_available") and "+cpu" not in torch_ver)
            if upgrade or _pkg_version("easyocr") is None:
                if torch_cuda_ready:
                    # Préserve PyTorch CUDA contre un remplacement CPU ou un verrou DLL Windows
                    if not _install_missing_pip_deps(["python-bidi", "scikit-image", "pyclipper", "Shapely", "PyYAML", "scipy", "ninja", "Pillow", "opencv-python-headless", "numpy"]):
                        return False
                    rc1 = _run_cmd_logged([sys.executable, "-m", "pip", "install", *up_flag, "--no-deps", "easyocr"])
                else:
                    rc1 = _run_cmd_logged([sys.executable, "-m", "pip", "install", *up_flag, "easyocr"])
                if rc1 != 0:
                    return False
            _append_ai_log("Téléchargement / vérification des modèles EasyOCR...")
            use_gpu_py = "True" if (effective_mode == "cuda" and hw_info.get("torch_cuda_available")) else "False"
            rc2 = _run_cmd_logged([
                sys.executable, "-c",
                f"import easyocr; easyocr.Reader(['fr', 'en'], gpu={use_gpu_py}); print('EasyOCR OK')"
            ])
            return rc2 == 0

        if upgrade or _pkg_version("paddlepaddle") is None or _pkg_version("paddleocr") is None:
            rc1 = _run_cmd_logged([sys.executable, "-m", "pip", "install", *up_flag, "paddlepaddle>=3.0.0", "paddleocr>=2.7.3"])
            if rc1 != 0:
                return False
        _append_ai_log("Téléchargement / vérification des modèles PaddleOCR...")
        init_ocr_script = (
            "import sys; sys.path.insert(0, 'backend/engines')\n"
            "from indexeur_ocr import create_paddle_ocr_engine\n"
            "create_paddle_ocr_engine(lang='fr', prefer_gpu=False)\n"
            "print('PaddleOCR OK')"
        )
        rc2 = _run_cmd_logged([sys.executable, "-c", init_ocr_script])
        return rc2 == 0

    return False


def _verify_single_module(mod_id: str) -> bool:
    info = _inspect_ai_module(mod_id)
    _append_ai_log(f"--- Vérification : {info['name']} ---")
    for pkg, ver in info["packages"].items():
        _append_ai_log(f"  Package {pkg} : {ver if ver else 'ABSENT'}")
    _append_ai_log(f"  Cache modèle local : {'Présent' if info['model_cached'] else 'Absent'} ({info['cache_size_mb']} Mo)")

    if not info["packages_ok"]:
        _append_ai_log("  ✗ Packages manquants.")
        return False

    ocr_eng = _active_ocr_engine()
    if ocr_eng == "rapidocr":
        ocr_verify_cmd = "from rapidocr_onnxruntime import RapidOCR; RapidOCR(); print('Imports RapidOCR OK')"
    elif ocr_eng == "easyocr":
        ocr_verify_cmd = "import torch, easyocr; print('Imports EasyOCR OK, CUDA:', torch.cuda.is_available())"
    else:
        ocr_verify_cmd = (
            "try:\n"
            "    import torch\n"
            "except Exception:\n"
            "    pass\n"
            "import paddleocr, paddle\n"
            "print('Imports PaddleOCR OK, version:', getattr(paddleocr, '__version__', '?'))"
        )

    import_cmds = {
        "faces": "import insightface, onnxruntime; print('Imports InsightFace/ONNX OK, providers:', onnxruntime.get_available_providers())",
        "clip": "import torch, sentence_transformers; print('Imports PyTorch/CLIP OK, CUDA:', torch.cuda.is_available())",
        "ocr": ocr_verify_cmd,
    }
    rc = _run_cmd_logged([sys.executable, "-c", import_cmds[mod_id]])
    return rc == 0 and info["model_cached"]


def _uninstall_single_module(mod_id: str) -> bool:
    if mod_id == "faces":
        pkgs = ["insightface", "onnxruntime", "onnxruntime-gpu", "onnxruntime-directml"]
    elif mod_id == "clip":
        pkgs = ["sentence-transformers"]
    elif mod_id == "ocr":
        pkgs = list(_OCR_ENGINES_META[_active_ocr_engine()]["packages"])
    else:
        return False

    rc = _run_cmd_logged([sys.executable, "-m", "pip", "uninstall", "-y", *pkgs])
    for p in _get_ai_cache_paths(mod_id):
        if p.exists():
            _append_ai_log(f"Suppression du cache modèle : {p}")
            shutil.rmtree(p, ignore_errors=True)
    return rc == 0


def _parse_ver_tuple(ver_str: str | None) -> tuple[int, ...]:
    if not ver_str:
        return ()
    base = ver_str.split("+", 1)[0].split("-", 1)[0]
    parts = []
    for seg in base.split("."):
        digits = "".join(ch for ch in seg if ch.isdigit())
        if digits:
            parts.append(int(digits))
        else:
            break
    return tuple(parts)


def _fetch_pypi_latest_version(pkg_name: str, timeout_s: float = 3.0) -> str | None:
    url = f"https://pypi.org/pypi/{pkg_name}/json"
    req = urllib.request.Request(url, headers={"User-Agent": "Phototo-Updater/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
            return str(data.get("info", {}).get("version") or "").strip() or None
    except Exception:
        return None


@router.get("/api/ai/status")
def api_ai_status():
    modules = [_inspect_ai_module(m) for m in ("faces", "clip", "ocr")]
    return {"modules": modules, "task": dict(_AI_TASK_STATE)}


@router.get("/api/ai/check_updates")
def api_ai_check_updates():
    modules = [_inspect_ai_module(m) for m in ("faces", "clip", "ocr")]
    updates: dict[str, dict] = {}
    total_updates = 0
    any_online = False

    for m in modules:
        pkg_updates: dict[str, dict] = {}
        mod_has_update = False
        for pkg, inst_ver in (m.get("packages") or {}).items():
            latest = _fetch_pypi_latest_version(pkg) if inst_ver else None
            if latest:
                any_online = True
            upd_avail = bool(inst_ver and latest and _parse_ver_tuple(latest) > _parse_ver_tuple(inst_ver))
            if upd_avail:
                mod_has_update = True
            pkg_updates[pkg] = {
                "installed": inst_ver,
                "latest": latest,
                "update_available": upd_avail,
            }
        if mod_has_update:
            total_updates += 1
        updates[m["id"]] = {
            "has_update": mod_has_update,
            "packages": pkg_updates,
        }

    return {
        "checked_at": datetime.now().strftime("%H:%M:%S"),
        "updates": updates,
        "total_updates": total_updates,
        "network_ok": any_online,
    }


@router.get("/api/ai/task_status")
def api_ai_task_status():
    return dict(_AI_TASK_STATE)


@router.post("/api/ai/action")
def api_ai_action(payload: AiActionPayload):
    mod = payload.module.strip().lower()
    act = payload.action.strip().lower()
    if mod not in ("faces", "clip", "ocr", "all"):
        raise HTTPException(status_code=400, detail="Module IA inconnu.")
    if act not in ("verify", "install", "update", "uninstall"):
        raise HTTPException(status_code=400, detail="Action IA inconnue.")

    with _AI_TASK_LOCK:
        if _AI_TASK_STATE["running"]:
            raise HTTPException(status_code=409, detail="Une opération IA est déjà en cours.")
        _AI_TASK_STATE.update({
            "running": True,
            "module": mod,
            "action": act,
            "logs": [f"Démarrage de '{act}' sur '{mod}'..."],
            "success": None,
            "error": None,
        })

    targets = ["faces", "clip", "ocr"] if mod == "all" else [mod]
    gpu_mode = (load_settings().get("gpu_mode") or "cpu").lower()

    def _worker():
        all_ok = True
        try:
            for t in targets:
                if act == "verify":
                    ok = _verify_single_module(t)
                elif act == "install":
                    ok = _install_or_update_single_module(t, upgrade=False, gpu_mode=gpu_mode)
                elif act == "update":
                    ok = _install_or_update_single_module(t, upgrade=True, gpu_mode=gpu_mode)
                elif act == "uninstall":
                    ok = _uninstall_single_module(t)
                else:
                    ok = False
                if not ok:
                    all_ok = False
            _AI_TASK_STATE["success"] = all_ok
            _append_ai_log("✓ Opération terminée." if all_ok else "⚠ Opération terminée avec des avertissements/erreurs.")
        except Exception as e:
            _AI_TASK_STATE["success"] = False
            _AI_TASK_STATE["error"] = str(e)
            _append_ai_log(f"✗ Erreur : {e}")
        finally:
            _AI_TASK_STATE["running"] = False

    threading.Thread(target=_worker, daemon=True).start()
    return {"status": "started", "module": mod, "action": act}


@router.get("/api/ai/model_mismatch")
def api_ai_model_mismatch(module_id: str, target_model: str, prev_model: str = ""):
    mod = (module_id or "").strip().lower()
    if mod not in ("faces", "clip"):
        return {"stale_count": 0}
    target = (target_model or "").strip()
    prev = (prev_model or "").strip()
    include_unknown = bool(prev and prev != target)
    return {"module_id": mod, "target_model": target, "stale_count": _count_stale_model_media(mod, target, include_unknown=include_unknown)}


@router.post("/api/ai/reindex_model")
def api_ai_reindex_model(payload: ReindexModelPayload):
    if STATE.is_running:
        raise HTTPException(status_code=409, detail="Mettez d'abord en pause le traitement en cours.")
    mod = (payload.module_id or "").strip().lower()
    if mod not in ("faces", "clip"):
        raise HTTPException(status_code=400, detail="Module non ré-indexable par modèle.")

    conn = get_db()
    cur = conn.cursor()
    _, dest_dir = get_active_db_and_dest()
    try:
        if mod == "faces":
            import indexeur_visages as faces_ai
            faces_ai.snapshot_named_face_hints(conn)
            cur.execute("DELETE FROM faces WHERE embedding IS NOT NULL")
            cur.execute("DELETE FROM persons WHERE person_id NOT IN (SELECT DISTINCT person_id FROM faces WHERE embedding IS NULL AND person_id IS NOT NULL)")
            cur.execute("UPDATE processed_files SET faces_scanned = 0, faces_model = NULL")
            conn.commit()
            return start_specific_task("FACES")

        active_clip = _active_clip_model()
        if payload.include_unknown:
            cur.execute(
                "UPDATE processed_files SET clip_scanned = 0, clip_embedding = NULL, clip_model = NULL WHERE clip_scanned = 1 AND (clip_model IS NULL OR clip_model = '' OR clip_model != ?)",
                (active_clip,),
            )
        else:
            cur.execute(
                "UPDATE processed_files SET clip_scanned = 0, clip_embedding = NULL, clip_model = NULL WHERE clip_scanned = 1 AND clip_model IS NOT NULL AND clip_model != '' AND clip_model != ?",
                (active_clip,),
            )
        conn.commit()
        return start_specific_task("CLIP")
    except ValueError as e:
        raise HTTPException(400, str(e))
    finally:
        conn.close()


_EXIFTOOL_TASK_LOCK = threading.Lock()
_EXIFTOOL_TASK_STATE: dict = {
    "running": False,
    "last_error": None,
    "logs": [],
}
_EXIFTOOL_PROBE_CACHE: dict[tuple[str, int, int], tuple[str | None, str | None]] = {}


def _probe_exiftool_version(exe_path: Path) -> tuple[str | None, str | None]:
    try:
        st = exe_path.stat()
        cache_key = (os.path.normcase(str(exe_path)), st.st_mtime_ns, st.st_size)
        cached = _EXIFTOOL_PROBE_CACHE.get(cache_key)
        if cached is not None:
            return cached
    except Exception:
        cache_key = None

    try:
        kwargs = {
            "stderr": subprocess.STDOUT,
            "stdin": subprocess.DEVNULL,
            "text": True,
            "timeout": 4,
        }
        if hasattr(subprocess, "CREATE_NO_WINDOW"):
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        out = subprocess.check_output([str(exe_path), "-ver"], **kwargs)
        lines = [ln.strip() for ln in (out or "").splitlines() if ln.strip()]
        first_line = lines[0] if lines else ""
        if re.fullmatch(r'\d+\.\d+(?:\.\d+)?', first_line):
            res = (first_line, None)
        else:
            res = (None, first_line or "Sortie -ver invalide")
    except subprocess.CalledProcessError as e:
        msg = (e.output or str(e) or "").strip().splitlines()[0] if (e.output or str(e)) else str(e)
        res = (None, msg)
    except Exception as e:
        res = (None, str(e))

    if cache_key is not None:
        if len(_EXIFTOOL_PROBE_CACHE) > 32:
            _EXIFTOOL_PROBE_CACHE.clear()
        _EXIFTOOL_PROBE_CACHE[cache_key] = res
    return res


def _get_tools_dir(root_dir: Path | None = None) -> Path:
    base = root_dir or Path(__file__).resolve().parents[2]
    return base / "tools"


def _exiftool_candidate_paths() -> list[Path]:
    root_dir = Path(__file__).resolve().parents[2]
    tools_dir = _get_tools_dir(root_dir)
    local_appdata = Path(os.environ.get("LOCALAPPDATA", "")) if os.environ.get("LOCALAPPDATA") else None
    prog_files = Path(os.environ.get("ProgramFiles", "")) if os.environ.get("ProgramFiles") else None
    candidates: list[Path] = [
        tools_dir / "exiftool.exe",
        tools_dir / "exiftool",
        root_dir / "exiftool.exe",
        root_dir / "exiftool",
    ]
    which_path = shutil.which("exiftool")
    if which_path:
        candidates.append(Path(which_path))
    if local_appdata:
        candidates.extend([
            local_appdata / "Programs" / "ExifTool" / "ExifTool.exe",
            local_appdata / "Programs" / "ExifTool" / "exiftool.exe",
            local_appdata / "Microsoft" / "WinGet" / "Links" / "exiftool.exe",
        ])
    if prog_files:
        candidates.extend([
            prog_files / "ExifTool" / "ExifTool.exe",
            prog_files / "ExifTool" / "exiftool.exe",
        ])
    return candidates


def _find_exiftool_executable() -> tuple[Path | None, str | None, str | None]:
    first_existing: Path | None = None
    first_err: str | None = None
    seen: set[str] = set()
    for cand in _exiftool_candidate_paths():
        if not cand:
            continue
        key = os.path.normcase(str(cand))
        if key in seen:
            continue
        seen.add(key)
        if cand.exists() and cand.is_file():
            ver, err = _probe_exiftool_version(cand)
            if first_existing is None:
                first_existing = cand
                first_err = err
            if ver:
                parent_str = str(cand.parent)
                if parent_str not in os.environ.get("PATH", ""):
                    os.environ["PATH"] = parent_str + os.pathsep + os.environ.get("PATH", "")
                return (cand, ver, None)
    return (first_existing, None, first_err)


def _inspect_exiftool() -> dict:
    exe_path, version, broken_reason = _find_exiftool_executable()

    py_ok = False
    try:
        importlib.metadata.version("PyExifTool")
        py_ok = True
    except Exception:
        try:
            import exiftool as _et  # noqa: F401
            py_ok = True
        except Exception:
            py_ok = False

    return {
        "installed": bool(exe_path and version),
        "binary_present": bool(exe_path),
        "broken_reason": broken_reason if (exe_path and not version) else None,
        "pyexiftool_installed": py_ok,
        "version": version,
        "path": str(exe_path) if exe_path else None,
        "installing": bool(_EXIFTOOL_TASK_STATE["running"]),
        "last_error": _EXIFTOOL_TASK_STATE["last_error"],
        "logs": list(_EXIFTOOL_TASK_STATE["logs"][-20:]),
    }


def _copy_exiftool_tree_to_root(exe_cand: Path, target_dir: Path) -> bool:
    try:
        real_exe = exe_cand.resolve()
    except Exception:
        real_exe = exe_cand
    if not real_exe.exists() or not real_exe.is_file():
        return False

    files_dir = real_exe.parent / "exiftool_files"
    # Évite de copier un shim WinGet sans dossier exiftool_files
    if not files_dir.is_dir() and real_exe.stat().st_size < 1_000_000:
        return False

    target_dir.mkdir(parents=True, exist_ok=True)
    target_exe = target_dir / "exiftool.exe"
    target_files = target_dir / "exiftool_files"
    if files_dir.is_dir():
        try:
            if real_exe.parent.resolve() != target_dir.resolve():
                if target_files.exists():
                    shutil.rmtree(target_files, ignore_errors=True)
                shutil.copytree(files_dir, target_files, dirs_exist_ok=True)
        except Exception:
            return False

    try:
        if real_exe.resolve() != target_exe.resolve():
            shutil.copy2(real_exe, target_exe)
    except PermissionError:
        if not target_exe.exists():
            return False
    except Exception:
        return False
    return target_exe.exists()


def _fetch_exiftool_latest_version(timeout_s: float = 4.0) -> str | None:
    req = urllib.request.Request("https://exiftool.org/ver.txt", headers={"User-Agent": "Phototo-Setup/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as r:
            raw = r.read().decode("utf-8", errors="ignore").strip().splitlines()
            ver = raw[0].strip() if raw else ""
            if re.fullmatch(r'\d+\.\d+(?:\.\d+)?', ver):
                return ver
    except Exception:
        pass
    return None


def _scrape_exiftool_page_zips(page_url: str, timeout_s: float = 6.0) -> list[str]:
    found: list[str] = []
    try:
        req = urllib.request.Request(page_url, headers={"User-Agent": "curl/8.5.0"})
        with urllib.request.urlopen(req, timeout=timeout_s) as r:
            html_txt = r.read().decode("utf-8", errors="ignore")
        for m in re.findall(r'href=["\']([^"\']*exiftool[^"\']*\.zip[^"\']*)["\']', html_txt, flags=re.IGNORECASE):
            full = urljoin(page_url, m.strip())
            if full not in found:
                found.append(full)
    except Exception:
        pass
    return found


def _download_exiftool_fallback(root_dir: Path, err_out: list[str] | None = None, target_dir: Path | None = None) -> bool:
    dest_dir = target_dir or _get_tools_dir(root_dir)
    ver_str = _fetch_exiftool_latest_version(timeout_s=10.0)
    zip_urls: list[str] = []
    if ver_str:
        zip_urls.extend([
            f"https://exiftool.org/exiftool-{ver_str}_64.zip",
            f"https://sourceforge.net/projects/exiftool/files/exiftool-{ver_str}_64.zip/download",
            f"https://exiftool.org/exiftool-{ver_str}_32.zip",
            f"https://sourceforge.net/projects/exiftool/files/exiftool-{ver_str}_32.zip/download",
        ])

    for page_u in ("https://exiftool.org/", "https://oliverbetz.de/pages/Artikel/ExifTool-for-Windows"):
        for scraped in _scrape_exiftool_page_zips(page_u):
            if scraped not in zip_urls:
                zip_urls.append(scraped)

    # Privilégier les archives 64-bit
    zip_urls.sort(key=lambda u: (0 if "_64" in u.lower() else 1))
    if not zip_urls:
        if err_out is not None:
            err_out.append("Aucune URL ExifTool joignable")
        return False

    tmp_dir = root_dir / "config" / "_tmp_exiftool"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    try:
        for idx, zip_url in enumerate(zip_urls):
            zip_path = tmp_dir / f"exiftool_{idx}.zip"
            try:
                req_zip = urllib.request.Request(zip_url, headers={"User-Agent": "curl/8.5.0", "Accept": "*/*"})
                with urllib.request.urlopen(req_zip, timeout=45) as resp, open(zip_path, "wb") as out_f:
                    shutil.copyfileobj(resp, out_f)
                if not zipfile.is_zipfile(zip_path):
                    if err_out is not None:
                        err_out.append(f"{zip_url}: réponse non-ZIP")
                    continue
                extract_sub = tmp_dir / f"ext_{idx}"
                with zipfile.ZipFile(zip_path, "r") as zf:
                    zf.extractall(extract_sub)
                cands = list(extract_sub.rglob("exiftool(-k).exe")) + list(extract_sub.rglob("exiftool.exe"))
                cands.sort(key=lambda p: (0 if (p.parent / "exiftool_files").is_dir() else 1, len(str(p))))
                for cand in cands:
                    if _copy_exiftool_tree_to_root(cand, dest_dir):
                        ver_chk, ver_err = _probe_exiftool_version(dest_dir / "exiftool.exe")
                        if ver_chk:
                            return True
                        if err_out is not None and ver_err:
                            err_out.append(f"Exécution post-copie échouée: {ver_err}")
            except Exception as exc:
                if err_out is not None:
                    err_out.append(f"{zip_url}: {exc}")
                continue
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
    return False


@router.get("/api/tools/exiftool/status")
def api_exiftool_status(check_update: bool = False):
    if _EXIFTOOL_TASK_STATE["running"]:
        return {
            "installed": False,
            "binary_present": False,
            "broken_reason": None,
            "pyexiftool_installed": False,
            "version": None,
            "path": None,
            "installing": True,
            "last_error": _EXIFTOOL_TASK_STATE["last_error"],
            "logs": list(_EXIFTOOL_TASK_STATE["logs"][-20:]),
            "latest_version": None,
            "update_available": False,
            "update_checked": False,
            "network_ok": None,
        }
    st = _inspect_exiftool()
    latest = _fetch_exiftool_latest_version() if check_update else None
    upd_avail = bool(
        check_update
        and st["installed"]
        and st["version"]
        and latest
        and _parse_ver_tuple(latest) > _parse_ver_tuple(st["version"])
    )
    st["latest_version"] = latest
    st["update_available"] = upd_avail
    st["update_checked"] = bool(check_update)
    st["network_ok"] = bool(latest) if check_update else None
    return st


@router.post("/api/tools/exiftool/install")
def api_exiftool_install(force: bool = False):
    with _EXIFTOOL_TASK_LOCK:
        if _EXIFTOOL_TASK_STATE["running"]:
            raise HTTPException(status_code=409, detail="Installation d'ExifTool déjà en cours.")
        _EXIFTOOL_TASK_STATE.update({
            "running": True,
            "last_error": None,
            "logs": ["Démarrage de la mise à jour d'ExifTool..." if force else "Démarrage de la vérification / installation d'ExifTool..."],
        })

    root_dir = Path(__file__).resolve().parents[2]
    tools_dir = _get_tools_dir(root_dir)

    def _worker():
        try:
            st = _inspect_exiftool()
            if not st["pyexiftool_installed"] or force:
                _EXIFTOOL_TASK_STATE["logs"].append("Installation / mise à jour de PyExifTool...")
                subprocess.run([sys.executable, "-m", "pip", "install", "--upgrade", "PyExifTool>=0.5.6"], check=True)

            if not st["installed"] or force:
                installed_ok = False
                local_appdata = Path(os.environ.get("LOCALAPPDATA", "")) if os.environ.get("LOCALAPPDATA") else None

                # 1. Vérifier si un binaire complet (avec exiftool_files) existe déjà (sauf si mise à jour forcée depuis exiftool.org)
                def _find_existing_copy_candidates() -> list[Path]:
                    out: list[Path] = []
                    if local_appdata:
                        out.extend([
                            local_appdata / "Programs" / "ExifTool" / "ExifTool.exe",
                            local_appdata / "Programs" / "ExifTool" / "exiftool.exe",
                        ])
                        winget_pkgs = local_appdata / "Microsoft" / "WinGet" / "Packages"
                        if winget_pkgs.exists():
                            out.extend(winget_pkgs.rglob("exiftool.exe"))
                            out.extend(winget_pkgs.rglob("exiftool(-k).exe"))
                    return out

                if not force:
                    for c in _find_existing_copy_candidates():
                        if c.exists():
                            cand_ver, _ = _probe_exiftool_version(c)
                            if cand_ver and _copy_exiftool_tree_to_root(c, tools_dir):
                                ver_copied, _ = _probe_exiftool_version(tools_dir / "exiftool.exe")
                                if ver_copied:
                                    installed_ok = True
                                    break

                # 2. Téléchargement portable officiel depuis exiftool.org / SourceForge / OliverBetz (sans UAC)
                dl_errs: list[str] = []
                if not installed_ok and os.name == "nt":
                    _EXIFTOOL_TASK_STATE["logs"].append("Téléchargement officiel depuis exiftool.org...")
                    installed_ok = _download_exiftool_fallback(root_dir, err_out=dl_errs, target_dir=tools_dir)

                # 3. Repli WinGet silencieux (--force si une version cassée est déjà présente)
                if not installed_ok and os.name == "nt" and shutil.which("winget"):
                    _EXIFTOOL_TASK_STATE["logs"].append("Installation / réparation d'ExifTool via WinGet...")
                    cmd = [
                        "winget", "upgrade" if force else "install", "-e", "--id", "OliverBetz.ExifTool",
                        "--force", "--silent", "--disable-interactivity",
                        "--accept-package-agreements", "--accept-source-agreements",
                    ]
                    wg_res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=120)
                    if wg_res.returncode != 0 and wg_res.stdout:
                        dl_errs.append(f"winget({wg_res.returncode}): {wg_res.stdout.strip().splitlines()[-1]}")
                    for c in _find_existing_copy_candidates():
                        if c.exists():
                            cand_ver, _ = _probe_exiftool_version(c)
                            if cand_ver and _copy_exiftool_tree_to_root(c, tools_dir):
                                ver_copied, _ = _probe_exiftool_version(tools_dir / "exiftool.exe")
                                if ver_copied:
                                    installed_ok = True
                                    break

                if not installed_ok:
                    _, found_ver, found_err = _find_exiftool_executable()
                    if not found_ver:
                        detail = "; ".join(dl_errs[-2:]) if dl_errs else (found_err or "réseau/WinGet indisponible")
                        raise RuntimeError(f"Échec installation ExifTool ({detail[:180]})")

            _EXIFTOOL_PROBE_CACHE.clear()
            after = _inspect_exiftool()
            if not after["installed"]:
                raise RuntimeError("ExifTool reste introuvable ou bloqué après l'installation.")
            _EXIFTOOL_TASK_STATE["logs"].append(f"✓ ExifTool v{after['version']} prêt.")
        except Exception as e:
            _EXIFTOOL_TASK_STATE["last_error"] = str(e)
            _EXIFTOOL_TASK_STATE["logs"].append(f"✗ Erreur : {e}")
        finally:
            _EXIFTOOL_TASK_STATE["running"] = False

    threading.Thread(target=_worker, daemon=True).start()
    return {"status": "started"}


_FFMPEG_TASK_LOCK = threading.Lock()
_FFMPEG_TASK_STATE: dict = {
    "running": False,
    "last_error": None,
    "logs": [],
}
_FFMPEG_PROBE_CACHE: dict[tuple[str, int, int], tuple[str | None, str | None]] = {}


def _probe_ffmpeg_version(exe_path: Path) -> tuple[str | None, str | None]:
    try:
        st = exe_path.stat()
        cache_key = (os.path.normcase(str(exe_path)), st.st_mtime_ns, st.st_size)
        cached = _FFMPEG_PROBE_CACHE.get(cache_key)
        if cached is not None:
            return cached
    except Exception:
        cache_key = None

    try:
        kwargs = {
            "stderr": subprocess.STDOUT,
            "stdin": subprocess.DEVNULL,
            "text": True,
            "timeout": 4,
        }
        if hasattr(subprocess, "CREATE_NO_WINDOW"):
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        out = subprocess.check_output([str(exe_path), "-version"], **kwargs)
        first_line = next((ln.strip() for ln in (out or "").splitlines() if ln.strip()), "")
        m = re.search(r'ffmpeg version\s+([^\s]+)', first_line, re.IGNORECASE)
        if m:
            raw_v = m.group(1)
            m_num = re.search(r'(\d+\.\d+(?:\.\d+)?)', raw_v)
            ver = m_num.group(1) if m_num else raw_v.split("-", 1)[0]
            res = (ver, None)
        else:
            res = (None, first_line or "Sortie -version invalide")
    except subprocess.CalledProcessError as e:
        msg = (e.output or str(e) or "").strip().splitlines()[0] if (e.output or str(e)) else str(e)
        res = (None, msg)
    except Exception as e:
        res = (None, str(e))

    if cache_key is not None:
        if len(_FFMPEG_PROBE_CACHE) > 32:
            _FFMPEG_PROBE_CACHE.clear()
        _FFMPEG_PROBE_CACHE[cache_key] = res
    return res


def _ffmpeg_candidate_paths() -> list[Path]:
    root_dir = Path(__file__).resolve().parents[2]
    tools_dir = _get_tools_dir(root_dir)
    local_appdata = Path(os.environ.get("LOCALAPPDATA", "")) if os.environ.get("LOCALAPPDATA") else None
    prog_files = Path(os.environ.get("ProgramFiles", "")) if os.environ.get("ProgramFiles") else None
    candidates: list[Path] = [
        tools_dir / "ffmpeg.exe",
        tools_dir / "ffmpeg",
        root_dir / "ffmpeg.exe",
        root_dir / "ffmpeg",
    ]
    which_path = shutil.which("ffmpeg")
    if which_path:
        candidates.append(Path(which_path))
    if local_appdata:
        candidates.extend([
            local_appdata / "Microsoft" / "WinGet" / "Links" / "ffmpeg.exe",
            local_appdata / "Programs" / "ffmpeg" / "bin" / "ffmpeg.exe",
        ])
        winget_pkgs = local_appdata / "Microsoft" / "WinGet" / "Packages"
        if winget_pkgs.exists():
            for pkg_d in winget_pkgs.glob("Gyan.FFmpeg*"):
                candidates.extend(pkg_d.rglob("ffmpeg.exe"))
    if prog_files:
        candidates.append(prog_files / "ffmpeg" / "bin" / "ffmpeg.exe")
    if os.name == "nt":
        candidates.append(Path("C:/ffmpeg/bin/ffmpeg.exe"))
    return candidates


def _find_ffmpeg_executable() -> tuple[Path | None, str | None, str | None]:
    first_existing: Path | None = None
    first_err: str | None = None
    seen: set[str] = set()
    for cand in _ffmpeg_candidate_paths():
        if not cand:
            continue
        key = os.path.normcase(str(cand))
        if key in seen:
            continue
        seen.add(key)
        if cand.exists() and cand.is_file():
            ver, err = _probe_ffmpeg_version(cand)
            if first_existing is None:
                first_existing = cand
                first_err = err
            if ver:
                parent_str = str(cand.parent)
                if parent_str not in os.environ.get("PATH", ""):
                    os.environ["PATH"] = parent_str + os.pathsep + os.environ.get("PATH", "")
                return (cand, ver, None)
    return (first_existing, None, first_err)


def _inspect_ffmpeg() -> dict:
    exe_path, version, broken_reason = _find_ffmpeg_executable()
    return {
        "installed": bool(exe_path and version),
        "binary_present": bool(exe_path),
        "broken_reason": broken_reason if (exe_path and not version) else None,
        "version": version,
        "path": str(exe_path) if exe_path else None,
        "installing": bool(_FFMPEG_TASK_STATE["running"]),
        "last_error": _FFMPEG_TASK_STATE["last_error"],
        "logs": list(_FFMPEG_TASK_STATE["logs"][-20:]),
    }


def _fetch_ffmpeg_latest_version(timeout_s: float = 4.0) -> str | None:
    req = urllib.request.Request("https://www.gyan.dev/ffmpeg/builds/release-version", headers={"User-Agent": "curl/8.5.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as r:
            raw = r.read().decode("utf-8", errors="ignore").strip().splitlines()
            ver = raw[0].strip() if raw else ""
            if re.fullmatch(r'\d+\.\d+(?:\.\d+)?', ver):
                return ver
    except Exception:
        pass
    return None


def _copy_ffmpeg_bin_to_root(ffmpeg_cand: Path, target_dir: Path) -> bool:
    try:
        real_exe = ffmpeg_cand.resolve()
    except Exception:
        real_exe = ffmpeg_cand
    if not real_exe.exists() or not real_exe.is_file():
        return False
    target_dir.mkdir(parents=True, exist_ok=True)
    target_exe = target_dir / "ffmpeg.exe"
    try:
        if real_exe.resolve() != target_exe.resolve():
            shutil.copy2(real_exe, target_exe)
        ffprobe_cand = real_exe.parent / "ffprobe.exe"
        if ffprobe_cand.exists() and ffprobe_cand.is_file():
            target_probe = target_dir / "ffprobe.exe"
            if ffprobe_cand.resolve() != target_probe.resolve():
                shutil.copy2(ffprobe_cand, target_probe)
    except PermissionError:
        if not target_exe.exists():
            return False
    except Exception:
        return False
    return target_exe.exists()


def _download_ffmpeg_fallback(root_dir: Path, err_out: list[str] | None = None, target_dir: Path | None = None) -> bool:
    dest_dir = target_dir or _get_tools_dir(root_dir)
    zip_urls = [
        "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    ]
    tmp_dir = root_dir / "config" / "_tmp_ffmpeg"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    try:
        for idx, zip_url in enumerate(zip_urls):
            zip_path = tmp_dir / f"ffmpeg_{idx}.zip"
            try:
                req = urllib.request.Request(zip_url, headers={"User-Agent": "curl/8.5.0", "Accept": "*/*"})
                with urllib.request.urlopen(req, timeout=180) as resp, open(zip_path, "wb") as out_f:
                    shutil.copyfileobj(resp, out_f)
                if not zipfile.is_zipfile(zip_path):
                    if err_out is not None:
                        err_out.append(f"{zip_url}: réponse non-ZIP")
                    continue
                extract_sub = tmp_dir / f"ext_{idx}"
                with zipfile.ZipFile(zip_path, "r") as zf:
                    for member in zf.infolist():
                        if member.filename.lower().endswith(("/bin/ffmpeg.exe", "/bin/ffprobe.exe")):
                            zf.extract(member, extract_sub)
                for cand in extract_sub.rglob("ffmpeg.exe"):
                    if _copy_ffmpeg_bin_to_root(cand, dest_dir):
                        ver_chk, ver_err = _probe_ffmpeg_version(dest_dir / "ffmpeg.exe")
                        if ver_chk:
                            return True
                        if err_out is not None and ver_err:
                            err_out.append(f"Exécution post-copie échouée: {ver_err}")
            except Exception as exc:
                if err_out is not None:
                    err_out.append(f"{zip_url}: {exc}")
                continue
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
    return False


@router.get("/api/tools/ffmpeg/status")
def api_ffmpeg_status(check_update: bool = False):
    if _FFMPEG_TASK_STATE["running"]:
        return {
            "installed": False,
            "binary_present": False,
            "broken_reason": None,
            "version": None,
            "path": None,
            "installing": True,
            "last_error": _FFMPEG_TASK_STATE["last_error"],
            "logs": list(_FFMPEG_TASK_STATE["logs"][-20:]),
            "latest_version": None,
            "update_available": False,
            "update_checked": False,
            "network_ok": None,
        }
    st = _inspect_ffmpeg()
    latest = _fetch_ffmpeg_latest_version() if check_update else None
    upd_avail = bool(
        check_update
        and st["installed"]
        and st["version"]
        and latest
        and _parse_ver_tuple(latest) > _parse_ver_tuple(st["version"])
    )
    st["latest_version"] = latest
    st["update_available"] = upd_avail
    st["update_checked"] = bool(check_update)
    st["network_ok"] = bool(latest) if check_update else None
    return st


@router.post("/api/tools/ffmpeg/install")
def api_ffmpeg_install(force: bool = False):
    with _FFMPEG_TASK_LOCK:
        if _FFMPEG_TASK_STATE["running"]:
            raise HTTPException(status_code=409, detail="Installation de FFmpeg déjà en cours.")
        _FFMPEG_TASK_STATE.update({
            "running": True,
            "last_error": None,
            "logs": ["Démarrage de la mise à jour de FFmpeg..." if force else "Démarrage de l'installation de FFmpeg..."],
        })

    root_dir = Path(__file__).resolve().parents[2]
    tools_dir = _get_tools_dir(root_dir)

    def _worker():
        try:
            st = _inspect_ffmpeg()
            if not st["installed"] or force:
                installed_ok = False
                dl_errs: list[str] = []

                if not force:
                    for cand in _ffmpeg_candidate_paths():
                        if cand.exists() and _probe_ffmpeg_version(cand)[0]:
                            if _copy_ffmpeg_bin_to_root(cand, tools_dir):
                                installed_ok = True
                                break

                if not installed_ok and os.name == "nt":
                    _FFMPEG_TASK_STATE["logs"].append("Téléchargement officiel depuis gyan.dev...")
                    installed_ok = _download_ffmpeg_fallback(root_dir, err_out=dl_errs, target_dir=tools_dir)

                if not installed_ok and os.name == "nt" and shutil.which("winget"):
                    _FFMPEG_TASK_STATE["logs"].append("Installation / réparation de FFmpeg via WinGet...")
                    cmd = [
                        "winget", "upgrade" if force else "install", "-e", "--id", "Gyan.FFmpeg",
                        "--force", "--silent", "--disable-interactivity",
                        "--accept-package-agreements", "--accept-source-agreements",
                    ]
                    wg_res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)
                    if wg_res.returncode != 0 and wg_res.stdout:
                        dl_errs.append(f"winget({wg_res.returncode}): {wg_res.stdout.strip().splitlines()[-1]}")
                    for cand in _ffmpeg_candidate_paths():
                        if cand.exists() and _probe_ffmpeg_version(cand)[0]:
                            if _copy_ffmpeg_bin_to_root(cand, tools_dir):
                                installed_ok = True
                                break

                if not installed_ok:
                    _, found_ver, found_err = _find_ffmpeg_executable()
                    if not found_ver:
                        detail = "; ".join(dl_errs[-2:]) if dl_errs else (found_err or "réseau/WinGet indisponible")
                        raise RuntimeError(f"Échec installation FFmpeg ({detail[:180]})")

            _FFMPEG_PROBE_CACHE.clear()
            after = _inspect_ffmpeg()
            if not after["installed"]:
                raise RuntimeError("FFmpeg reste introuvable après l'installation.")
            _FFMPEG_TASK_STATE["logs"].append(f"✓ FFmpeg v{after['version']} prêt.")
        except Exception as e:
            _FFMPEG_TASK_STATE["last_error"] = str(e)
            _FFMPEG_TASK_STATE["logs"].append(f"✗ Erreur : {e}")
        finally:
            _FFMPEG_TASK_STATE["running"] = False

    threading.Thread(target=_worker, daemon=True).start()
    return {"status": "started"}
