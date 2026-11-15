import os
import sys
import time
import shutil
import sqlite3
import hashlib
import threading
import subprocess
import importlib.metadata
import json
import urllib.request
from pathlib import Path
from datetime import datetime
from urllib.parse import unquote

import cv2
from PIL import Image
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from settings_manager import (
    load_settings, save_settings, detect_system_hardware, get_hardware_runtime_config,
    FACES_MODEL_SPECS, CLIP_MODEL_SPECS
)
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
    ocr_engine: str = "paddleocr"
    faces_model: str = "buffalo_l"
    clip_model: str = "vit-b-32"


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
    cache_dir = dest_dir / "Miniatures_Cache"
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
    saved = save_settings({
        "scanned_folders": [p.strip() for p in payload.scanned_folders if p.strip()],
        "takeout_extract_dir": payload.takeout_extract_dir.strip(),
        "timezone": payload.timezone.strip(),
        "language": payload.language.strip(),
        "gpu_mode": payload.gpu_mode.strip(),
        "ocr_engine": (payload.ocr_engine or "paddleocr").strip().lower(),
        "faces_model": (payload.faces_model or "buffalo_l").strip(),
        "clip_model": (payload.clip_model or "vit-b-32").strip().lower(),
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
        cur.execute("UPDATE processed_files SET faces_scanned = 0, faces_model = NULL")
        thumbs_dir = dest_dir / "Miniatures_Visages"
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


def _install_or_update_single_module(mod_id: str, upgrade: bool, gpu_mode: str) -> bool:
    up_flag = ["--upgrade"] if upgrade else []
    hw_info = detect_system_hardware()
    effective_mode = gpu_mode
    if effective_mode == "auto":
        effective_mode = "cuda" if hw_info.get("gpu_vendor") == "nvidia" else hw_info.get("recommended_mode", "cpu")

    if mod_id == "faces":
        onnx_pkg = "onnxruntime-gpu" if effective_mode == "cuda" else ("onnxruntime-directml" if effective_mode == "directml" else "onnxruntime")
        rc1 = _run_cmd_logged([sys.executable, "-m", "pip", "install", *up_flag, onnx_pkg])
        if rc1 != 0 and onnx_pkg != "onnxruntime":
            rc1 = _run_cmd_logged([sys.executable, "-m", "pip", "install", *up_flag, "onnxruntime"])
        if onnx_pkg != "onnxruntime":
            # insightface 2.1 déclare 'onnxruntime' (CPU) dans ses métadonnées ; --no-deps préserve onnxruntime-gpu/directml
            rc2 = _run_cmd_logged([sys.executable, "-m", "pip", "install", *up_flag, "--no-deps", "insightface>=2.1"])
        else:
            rc2 = _run_cmd_logged([sys.executable, "-m", "pip", "install", *up_flag, "insightface>=2.1"])
        if rc1 != 0 or rc2 != 0:
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
        if effective_mode == "cuda":
            torch_ver = _pkg_version("torch") or ""
            cuda_tag = hw_info.get("cuda_index") or "cu128"
            cuda_flags = ["--force-reinstall"] if (not hw_info.get("torch_cuda_available") or "+cpu" in torch_ver) else up_flag
            _append_ai_log(f"Installation de PyTorch avec support NVIDIA CUDA ({cuda_tag})...")
            rc1 = _run_cmd_logged([sys.executable, "-m", "pip", "install", *cuda_flags, "torch", "torchvision", "--index-url", f"https://download.pytorch.org/whl/{cuda_tag}"])
            if rc1 != 0 and cuda_tag != "cu124":
                _append_ai_log("Repli sur l'index CUDA compatible cu124...")
                rc1 = _run_cmd_logged([sys.executable, "-m", "pip", "install", *cuda_flags, "torch", "torchvision", "--index-url", "https://download.pytorch.org/whl/cu124"])
            if rc1 != 0:
                rc1 = _run_cmd_logged([sys.executable, "-m", "pip", "install", *up_flag, "torch", "torchvision"])
        else:
            rc1 = _run_cmd_logged([sys.executable, "-m", "pip", "install", *up_flag, "torch", "torchvision"])
        rc2 = _run_cmd_logged([sys.executable, "-m", "pip", "install", *up_flag, "sentence-transformers>=3.0.0"])
        if rc1 != 0 or rc2 != 0:
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
            rc1 = _run_cmd_logged([sys.executable, "-m", "pip", "install", *up_flag, "rapidocr-onnxruntime"])
            if rc1 != 0:
                return False
            _append_ai_log("Vérification de RapidOCR (ONNX)...")
            rc2 = _run_cmd_logged([sys.executable, "-c", "from rapidocr_onnxruntime import RapidOCR; RapidOCR(); print('RapidOCR OK')"])
            return rc2 == 0

        if ocr_eng == "easyocr":
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
