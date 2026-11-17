import os
import json
import time
import shutil
import sqlite3
import zipfile
import threading
from pathlib import Path
from datetime import datetime
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel

from library_manager import (
    load_libraries,
    save_libraries,
    register_library,
    get_library_icons_dir,
    resolve_takeout_architecture_flags,
    collect_zip_files,
    get_library_tech_dir,
    load_settings,
)
from pipeline_runner import (
    STATE,
    start_specific_task,
    request_stop_pipeline,
    _record_step_activity,
    set_system_sleep_inhibit,
    translate_runtime_error,
    notify_unadded_source_files,
)
from database import get_active_db_and_dest, _INITIALIZED_DBS, log_library_action
from indexeur_visages import init_face_tables
from indexeur_ocr import init_ocr_tables
from indexeur_semantique_gps import upgrade_db_for_clip_and_gps
from indexeur_similaires import upgrade_db_for_video_similarity
import fusion_takeout_complet as fusion

router = APIRouter()

MEDIA_IMPORT_EXTS = {
    ".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif", ".gif", ".bmp", ".tiff", ".tif",
    ".dng", ".cr2", ".cr3", ".nef", ".arw", ".orf", ".rw2",
    ".mp4", ".mov", ".avi", ".mkv", ".3gp", ".m4v", ".webm"
}
IGNORED_INTERNAL_DIRS = {
    "Phototo", "Corbeille"
}


class CreateLibraryPayload(BaseModel):
    name: str
    source_type: str
    source_paths_raw: str
    dest_dir: str
    fix_takeout_json_metadata: bool = True
    delete_zips_progressively: bool = False
    takeout_architecture: str | None = None
    takeout_keep_structure: bool = True
    takeout_wrap_google_album: bool = False
    organize_by_year_month: bool = True


class QuickImportPayload(BaseModel):
    source_type: str
    paths: list[str]
    fix_metadata: bool = True
    delete_zips: bool = False


class DeleteLibraryPayload(BaseModel):
    name: str
    delete_windows_files: bool = False


class RemoveLibrarySourcePayload(BaseModel):
    library_name: str
    remove_source: str
    transfer_content: bool = False
    target_source: str = ""


class SubfolderRuleItem(BaseModel):
    folder_path: str
    include: bool = True
    create_album: bool = True
    album_name: str = ""


class AddImportSourcesPayload(BaseModel):
    source_type: str = "STANDARD_FOLDER"
    source_paths: list[str] = []
    fix_takeout_json_metadata: bool = True
    delete_zips_progressively: bool = False
    takeout_architecture: str | None = None
    takeout_keep_structure: bool = True
    takeout_wrap_google_album: bool = False
    create_album: bool = False
    album_mode: str = "SINGLE"
    album_name: str = ""
    subfolder_rules: list[SubfolderRuleItem] = []


LIBRARY_ICON_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}


def _enrich_libraries_cfg(cfg: dict) -> dict:
    icons_dir = get_library_icons_dir()
    libs = cfg.get("libraries", {})
    out_libs = {}
    for name, entry in libs.items():
        copied = dict(entry)
        icon_file = str(copied.get("icon_file") or "").strip()
        if icon_file and (icons_dir / Path(icon_file).name).is_file():
            copied["icon_url"] = f"/api/libraries/icon/{quote(name, safe='')}?v={quote(Path(icon_file).name, safe='')}"
        else:
            copied["icon_url"] = ""
        out_libs[name] = copied
    return {
        **cfg,
        "libraries": out_libs,
    }


@router.get("/api/libraries")
def api_get_libraries():
    return _enrich_libraries_cfg(load_libraries())


@router.get("/api/libraries/icon/{lib_name}")
def api_get_library_icon(lib_name: str):
    cfg = load_libraries()
    entry = cfg.get("libraries", {}).get(lib_name)
    if not entry:
        raise HTTPException(404, "Bibliothèque introuvable")
    icon_file = str(entry.get("icon_file") or "").strip()
    if not icon_file:
        raise HTTPException(404, "Aucune icône personnalisée")
    icon_path = get_library_icons_dir() / Path(icon_file).name
    if not icon_path.is_file():
        raise HTTPException(404, "Fichier d'icône introuvable")
    return FileResponse(icon_path)


@router.post("/api/libraries/icon/{lib_name}")
async def api_upload_library_icon(lib_name: str, file: UploadFile = File(...)):
    cfg = load_libraries()
    libs = cfg.get("libraries", {})
    if lib_name not in libs:
        raise HTTPException(404, "Bibliothèque introuvable")

    orig_name = file.filename or "icon.png"
    ext = Path(orig_name).suffix.lower()
    if ext not in LIBRARY_ICON_EXTS:
        raise HTTPException(400, "Format d'image non supporté")

    data = await file.read()
    if not data:
        raise HTTPException(400, "Fichier vide")

    icons_dir = get_library_icons_dir()
    old_icon = str(libs[lib_name].get("icon_file") or "").strip()
    if old_icon:
        try:
            (icons_dir / Path(old_icon).name).unlink(missing_ok=True)
        except OSError:
            pass

    safe_slug = "".join(c if c.isalnum() else "_" for c in lib_name.lower()).strip("_") or "lib"
    new_filename = f"{safe_slug}_{int(time.time() * 1000)}{ext}"
    (icons_dir / new_filename).write_bytes(data)

    libs[lib_name]["icon_file"] = new_filename
    save_libraries(cfg)
    return {
        "status": "ok",
        "icon_url": f"/api/libraries/icon/{quote(lib_name, safe='')}?v={quote(new_filename, safe='')}",
    }


@router.delete("/api/libraries/icon/{lib_name}")
def api_delete_library_icon(lib_name: str):
    cfg = load_libraries()
    libs = cfg.get("libraries", {})
    if lib_name not in libs:
        raise HTTPException(404, "Bibliothèque introuvable")

    old_icon = str(libs[lib_name].pop("icon_file", "") or "").strip()
    if old_icon:
        try:
            (get_library_icons_dir() / Path(old_icon).name).unlink(missing_ok=True)
        except OSError:
            pass
    save_libraries(cfg)
    return {"status": "ok"}


@router.post("/api/libraries/select")
def api_select_library(payload: dict):
    cfg = load_libraries()
    name = payload.get("name")
    if name in cfg.get("libraries", {}):
        cfg["active_library"] = name
        save_libraries(cfg)
        with STATE._lock:
            STATE._last_new_files_sig = None
        threading.Thread(target=notify_unadded_source_files, kwargs={"force": True}, daemon=True).start()
    return {"status": "selected", "active_library": name}


@router.post("/api/libraries/create")
def api_create_library(payload: CreateLibraryPayload):
    paths = list(dict.fromkeys(str(Path(p.strip())) for p in payload.source_paths_raw.splitlines() if p.strip()))
    dest = payload.dest_dir.strip() or (paths[0] if paths else "./Photos_Triees")
    if dest.lower().endswith(".zip"):
        dest = str(Path(dest).parent)
    if not paths:
        paths = [str(Path(dest))]
    Path(dest).mkdir(parents=True, exist_ok=True)
    lib = register_library(
        name=payload.name.strip() or "Ma Bibliothèque",
        source_type=payload.source_type,
        source_paths=paths,
        dest_dir=dest,
        options=payload.model_dump()
    )
    return {"status": "created", "library": lib}


@router.post("/api/import/inspect_subfolders")
def api_inspect_subfolders(payload: dict):
    paths = payload.get("source_paths", [])
    folders_out = []

    for p_str in paths:
        root_p = Path(p_str.strip())
        if not root_p.exists() or not root_p.is_dir():
            continue

        counts_by_dir: dict[Path, int] = {}
        for f in root_p.rglob("*"):
            if not f.is_file() or f.suffix.lower() not in MEDIA_IMPORT_EXTS:
                continue
            if any(part in IGNORED_INTERNAL_DIRS for part in f.parts):
                continue
            counts_by_dir[f.parent] = counts_by_dir.get(f.parent, 0) + 1

        for dir_p, count in sorted(counts_by_dir.items(), key=lambda x: str(x[0])):
            is_root = (dir_p.resolve() == root_p.resolve())
            rel_label = "." if is_root else str(dir_p.relative_to(root_p)).replace("\\", "/")
            folders_out.append({
                "folder_path": str(dir_p.resolve()),
                "display_name": f"{root_p.name} (racine)" if is_root else rel_label,
                "suggested_album": dir_p.name,
                "is_root": is_root,
                "media_count": count
            })

    has_subfolders = any(not item["is_root"] for item in folders_out) or len(folders_out) > 1
    return {
        "has_subfolders": has_subfolders,
        "folders": folders_out
    }


@router.post("/api/import/add_sources")
def api_import_add_sources(payload: AddImportSourcesPayload):
    cfg = load_libraries()
    active_name = cfg.get("active_library")
    libs = cfg.get("libraries", {})

    if not active_name or active_name not in libs:
        raise HTTPException(400, "Aucune bibliothèque active.")

    lib = libs[active_name]
    clean_new_paths = [str(Path(p.strip())) for p in payload.source_paths if p.strip()]

    if payload.source_type in ("TAKEOUT_FOLDER", "TAKEOUT_ZIPS"):
        existing_paths = lib.get("source_paths", [])
        lib["source_paths"] = list(dict.fromkeys([*existing_paths, *clean_new_paths]))
        lib["source_type"] = payload.source_type
        lib["is_takeout"] = True
        opts = lib.setdefault("options", {})
        opts["fix_takeout_json_metadata"] = payload.fix_takeout_json_metadata
        opts["delete_zips_progressively"] = payload.delete_zips_progressively
        keep_struct, wrap_google = resolve_takeout_architecture_flags({
            "takeout_architecture": payload.takeout_architecture,
            "takeout_keep_structure": payload.takeout_keep_structure,
            "takeout_wrap_google_album": payload.takeout_wrap_google_album,
        })
        opts["takeout_keep_structure"] = keep_struct
        opts["takeout_wrap_google_album"] = wrap_google
        save_libraries(cfg)
        return {"status": "takeout_sources_added", "imported_count": 0}

    db_path, dest_dir = get_active_db_and_dest()
    rules_map: dict[str, SubfolderRuleItem] = {
        os.path.normcase(str(Path(r.folder_path).resolve())): r
        for r in payload.subfolder_rules
    }

    def _run_folder_import_job():
        STATE.is_running = True
        STATE.status_level = "running"
        STATE.stop_requested = False
        STATE.cancel_requested = False
        STATE.active_task = "INGEST"
        STATE.current_step = "Analyse du dossier à importer..."
        STATE.processed_items = 0
        STATE.total_items = 0
        STATE.percent = 0
        STATE.speed_text = "-- Mo/s"
        STATE.eta_text = "--:--"

        start_ts = time.time()
        start_iso = datetime.now().isoformat(timespec="seconds")
        imported_count = 0
        updated_count = 0
        bytes_processed = 0
        failed_imports: list[dict] = []
        stopped_early = False
        cancelled_early = False
        resume_params_json = json.dumps(payload.model_dump(), ensure_ascii=False)
        import_title = (
            f"Importation : {Path(clean_new_paths[0]).name}"
            if len(clean_new_paths) == 1
            else f"Importation ({len(clean_new_paths)} dossiers)"
        )

        if hasattr(STATE, "logs") and isinstance(STATE.logs, list):
            STATE.logs.clear()

        try:
            set_system_sleep_inhibit(True)
            candidate_files: list[tuple[Path, str | None]] = []
            for folder_str in clean_new_paths:
                folder_p = Path(folder_str)
                if not folder_p.exists() or not folder_p.is_dir():
                    failed_imports.append({
                        "path": str(folder_p).replace("\\", "/"),
                        "name": folder_p.name or str(folder_p),
                        "reason": "Dossier source introuvable ou inaccessible",
                    })
                    continue

                for file_p in folder_p.rglob("*"):
                    if not file_p.is_file() or file_p.suffix.lower() not in MEDIA_IMPORT_EXTS:
                        continue
                    if any(part in IGNORED_INTERNAL_DIRS for part in file_p.parts):
                        continue

                    parent_key = os.path.normcase(str(file_p.parent.resolve()))
                    effective_album = None

                    if not payload.create_album or payload.album_mode == "NONE":
                        effective_album = None
                    elif payload.album_mode == "SINGLE":
                        effective_album = payload.album_name.strip() or folder_p.name
                    elif payload.album_mode == "ALL_SUBS":
                        effective_album = file_p.parent.name
                    elif payload.album_mode == "CUSTOM_SUBS":
                        rule = rules_map.get(parent_key)
                        if rule is not None:
                            if not rule.include:
                                continue
                            effective_album = (rule.album_name.strip() or file_p.parent.name) if rule.create_album else None
                        else:
                            effective_album = None

                    candidate_files.append((file_p, effective_album))

            total_files = len(candidate_files)
            STATE.total_items = total_files
            STATE.current_step = "Importation des médias en cours..."
            if hasattr(STATE, "log"):
                STATE.log(f"📂 Début de l'importation : {total_files} média(s) détecté(s).")

            conn = sqlite3.connect(db_path, timeout=30.0)
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()

            for idx, (file_p, effective_album) in enumerate(candidate_files, start=1):
                if getattr(STATE, "stop_requested", False) or not STATE.is_running:
                    stopped_early = True
                    cancelled_early = bool(getattr(STATE, "cancel_requested", False))
                    if hasattr(STATE, "log"):
                        STATE.log("⏹ Importation arrêtée." if cancelled_early else "⏸️ Importation mise en pause par l'utilisateur.")
                    break

                if hasattr(STATE, "log"):
                    STATE.log(f"📥 {file_p.name} ({idx}/{total_files})")

                src_str = str(file_p.resolve())
                try:
                    stat = file_p.stat()
                    mtime = int(stat.st_mtime)
                    fsize = stat.st_size
                except OSError as stat_err:
                    failed_imports.append({
                        "path": src_str.replace("\\", "/"),
                        "name": file_p.name,
                        "reason": f"Lecture impossible : {translate_runtime_error(stat_err)}",
                    })
                    continue

                dt = datetime.fromtimestamp(mtime)
                try:
                    file_p.resolve().relative_to(dest_dir.resolve())
                    final_dest = file_p.resolve()
                except ValueError:
                    target_sub = dest_dir / dt.strftime("%Y") / dt.strftime("%m")
                    target_sub.mkdir(parents=True, exist_ok=True)
                    final_dest = target_sub / file_p.name
                    if final_dest.exists() and final_dest.resolve() != file_p.resolve():
                        stem, suf = file_p.stem, file_p.suffix
                        final_dest = target_sub / f"{stem}_{mtime}{suf}"
                    if not final_dest.exists():
                        try:
                            shutil.copy2(str(file_p), str(final_dest))
                        except Exception as copy_err:
                            failed_imports.append({
                                "path": src_str.replace("\\", "/"),
                                "name": file_p.name,
                                "reason": f"Copie impossible : {translate_runtime_error(copy_err)}",
                            })
                            continue

                cur.execute(
                    "SELECT album_name FROM processed_files WHERE source_path = ? OR dest_path = ?",
                    (src_str, str(final_dest))
                )
                existing_row = cur.fetchone()
                if existing_row:
                    cur.execute(
                        "UPDATE processed_files SET album_name = ?, is_trashed = 0 WHERE source_path = ? OR dest_path = ?",
                        (effective_album, src_str, str(final_dest))
                    )
                    updated_count += 1
                else:
                    cur.execute("""
                        INSERT INTO processed_files (
                            source_path, dest_path, status, timestamp,
                            file_size, album_name, is_duplicate, is_trashed, is_favorite
                        ) VALUES (?, ?, 'ok', ?, ?, ?, 0, 0, 0)
                    """, (src_str, str(final_dest), mtime, fsize, effective_album))
                    imported_count += 1

                bytes_processed += fsize
                STATE.processed_items = idx
                STATE.percent = int((idx / max(1, total_files)) * 100)

                elapsed = max(0.1, time.time() - start_ts)
                mb_s = (bytes_processed / (1024 * 1024)) / elapsed
                STATE.speed_text = f"{mb_s:.1f} Mo/s"
                rem_items = total_files - idx
                eta_sec = int((elapsed / idx) * rem_items)
                STATE.eta_text = f"{eta_sec // 60:02d}:{eta_sec % 60:02d}"

                if idx % 50 == 0:
                    conn.commit()

            conn.commit()
            conn.close()

            if stopped_early and not cancelled_early:
                STATE.current_step = "En pause : Importation des médias..."
                STATE.last_paused_task = "INGEST"
                STATE.status_level = "paused"
            elif cancelled_early:
                STATE.current_step = "Tâche arrêtée : Importation"
                STATE.percent = 0
                STATE.last_paused_task = ""
                STATE.status_level = "stopped"
            else:
                STATE.current_step = "Importation terminée"
                STATE.percent = 100
                STATE.last_paused_task = ""
                STATE.status_level = "idle"
            detail_msg = f"{imported_count} nouveau(x) média(s) importé(s), {updated_count} mis à jour."
            if hasattr(STATE, "log"):
                STATE.log(f"✅ {detail_msg}")

            _record_step_activity(
                db_path,
                active_name,
                "IMPORT",
                import_title,
                start_ts,
                start_iso,
                total_files,
                imported_count + updated_count,
                failed_imports,
                stopped=stopped_early,
                cancelled=cancelled_early,
                params_json=resume_params_json,
            )

        except Exception as e:
            translated_err = translate_runtime_error(e)
            err_msg = f"Erreur : {translated_err}"
            STATE.current_step = err_msg
            STATE.last_paused_task = ""
            STATE.status_level = "error"
            if hasattr(STATE, "log"):
                STATE.log(f"❌ {err_msg}")
            _record_step_activity(
                db_path,
                active_name,
                "IMPORT",
                import_title,
                start_ts,
                start_iso,
                int(getattr(STATE, "total_items", 0) or 0),
                imported_count + updated_count,
                failed_imports,
                error_reason=translated_err,
                params_json=resume_params_json,
            )
        finally:
            set_system_sleep_inhibit(False)
            STATE.is_running = False
            STATE.active_task = "IDLE"

    threading.Thread(target=_run_folder_import_job, daemon=True).start()
    return {"status": "import_started"}


@router.post("/api/libraries/update")
def api_update_library(payload: dict):
    cfg = load_libraries()
    libs = cfg.get("libraries", {})
    orig_name = payload.get("original_name", "")
    if orig_name not in libs:
        raise HTTPException(404, "Bibliothèque introuvable")

    entry = libs.pop(orig_name)
    new_name = (payload.get("new_name") or "").strip() or orig_name
    raw_sources = payload.get("new_sources")
    if isinstance(raw_sources, list):
        clean_sources = list(dict.fromkeys(str(Path(str(p).strip())) for p in raw_sources if str(p).strip()))
    else:
        new_source = (payload.get("new_source") or "").strip()
        clean_sources = [str(Path(new_source))] if new_source else []
    move_existing = bool(payload.get("move_existing_content", False))

    old_dest = Path(entry.get("dest_dir", ""))
    entry["name"] = new_name

    if clean_sources:
        first_src = Path(clean_sources[0])
        new_dest = first_src.parent if clean_sources[0].lower().endswith(".zip") else first_src
        new_dest.mkdir(parents=True, exist_ok=True)
        if move_existing and old_dest.exists() and old_dest.resolve() != new_dest.resolve():
            for item in old_dest.iterdir():
                target = new_dest / item.name
                if not target.exists():
                    try:
                        shutil.move(str(item), str(target))
                    except Exception:
                        pass
            old_db_name = Path(entry.get("db_path", "")).name
            if old_db_name and (new_dest / "Phototo" / old_db_name).exists():
                entry["db_path"] = str(new_dest / "Phototo" / old_db_name)

            db_p = Path(entry["db_path"])
            if db_p.exists():
                conn = sqlite3.connect(db_p, timeout=30.0)
                try:
                    old_prefix = str(old_dest)
                    new_prefix = str(new_dest)
                    conn.execute(
                        "UPDATE processed_files SET dest_path = REPLACE(dest_path, ?, ?), source_path = REPLACE(source_path, ?, ?)",
                        (old_prefix, new_prefix, old_prefix, new_prefix)
                    )
                    conn.commit()
                finally:
                    conn.close()

        entry["source_paths"] = clean_sources
        entry["dest_dir"] = str(new_dest)

    if "is_takeout" in payload:
        is_takeout_flag = bool(payload.get("is_takeout"))
        has_zips = any(str(p).lower().endswith(".zip") for p in (entry.get("source_paths") or []))
        effective_takeout = is_takeout_flag or has_zips
        entry["is_takeout"] = effective_takeout
        entry["source_type"] = "TAKEOUT_ZIPS" if has_zips else ("TAKEOUT_FOLDER" if effective_takeout else "STANDARD_FOLDER")
        opts = entry.setdefault("options", {})
        opts["fix_takeout_json_metadata"] = effective_takeout

    libs[new_name] = entry
    if cfg.get("active_library") == orig_name:
        cfg["active_library"] = new_name
    save_libraries(cfg)
    _INITIALIZED_DBS.clear()
    return {"status": "updated", "active_library": cfg.get("active_library")}


def _merge_move_tree(src_dir: Path, dst_dir: Path, skip_names: set[str] | None = None):
    """Déplace récursivement le contenu de src_dir vers dst_dir en fusionnant les sous-dossiers."""
    dst_dir.mkdir(parents=True, exist_ok=True)
    for item in list(src_dir.iterdir()):
        if skip_names and item.name in skip_names:
            continue
        target = dst_dir / item.name
        if item.is_dir():
            if target.exists() and target.is_dir():
                _merge_move_tree(item, target)
                try:
                    if not any(item.iterdir()):
                        item.rmdir()
                except OSError:
                    pass
            elif not target.exists():
                try:
                    shutil.move(str(item), str(target))
                except Exception:
                    pass
        else:
            if not target.exists():
                try:
                    shutil.move(str(item), str(target))
                except Exception:
                    pass


@router.post("/api/libraries/remove_source")
def api_remove_library_source(payload: RemoveLibrarySourcePayload):
    cfg = load_libraries()
    libs = cfg.get("libraries", {})
    entry = libs.get(payload.library_name)
    if not entry:
        raise HTTPException(404, "Bibliothèque introuvable")

    rem_clean = str(Path(payload.remove_source.strip()))
    rem_norm = rem_clean.rstrip("\\/").lower()
    existing = [str(Path(p)) for p in (entry.get("source_paths") or []) if str(p).strip()]
    remaining = [p for p in existing if p.rstrip("\\/").lower() != rem_norm]

    target_clean = str(Path(payload.target_source.strip())) if payload.target_source.strip() else ""
    if payload.transfer_content and target_clean:
        if all(p.rstrip("\\/").lower() != target_clean.rstrip("\\/").lower() for p in remaining):
            remaining.append(target_clean)

    if not remaining:
        raise HTTPException(400, "La bibliothèque doit conserver au moins une source.")

    from_p = Path(rem_clean)
    old_dest = Path(entry.get("dest_dir", ""))

    if payload.transfer_content:
        dst_str = target_clean or remaining[0]
        to_p = Path(dst_str)
        to_p.mkdir(parents=True, exist_ok=True)

        db_p = Path(entry.get("db_path", ""))
        db_rel_to_from = None
        try:
            if db_p.exists() and from_p.exists():
                db_rel_to_from = db_p.resolve().relative_to(from_p.resolve())
        except (OSError, ValueError):
            db_rel_to_from = None

        if from_p.exists() and to_p.resolve() != from_p.resolve():
            _merge_move_tree(from_p, to_p)
            if db_rel_to_from and (to_p / db_rel_to_from).exists():
                entry["db_path"] = str(to_p / db_rel_to_from)
                db_p = Path(entry["db_path"])

        if db_p.exists():
            conn = sqlite3.connect(db_p, timeout=30.0)
            prefixes = [str(from_p)]
            try:
                res_str = str(from_p.resolve())
                if res_str not in prefixes:
                    prefixes.append(res_str)
            except OSError:
                pass
            new_prefix = str(to_p)
            for old_prefix in prefixes:
                conn.execute(
                    "UPDATE processed_files SET dest_path = REPLACE(dest_path, ?, ?), source_path = REPLACE(source_path, ?, ?), original_dest_path = REPLACE(COALESCE(original_dest_path, ''), ?, ?)",
                    (old_prefix, new_prefix, old_prefix, new_prefix, old_prefix, new_prefix),
                )
                conn.execute(
                    "UPDATE faces SET dest_path = REPLACE(dest_path, ?, ?), source_path = REPLACE(source_path, ?, ?), thumb_path = REPLACE(COALESCE(thumb_path, ''), ?, ?)",
                    (old_prefix, new_prefix, old_prefix, new_prefix, old_prefix, new_prefix),
                )
                conn.execute(
                    "UPDATE media_categories SET source_path = REPLACE(source_path, ?, ?)",
                    (old_prefix, new_prefix),
                )
                conn.execute(
                    "UPDATE albums SET cover_path = REPLACE(COALESCE(cover_path, ''), ?, ?)",
                    (old_prefix, new_prefix),
                )
            conn.commit()
            conn.close()

        if old_dest.exists() and from_p.exists():
            try:
                if old_dest.resolve() == from_p.resolve():
                    entry["dest_dir"] = str(to_p)
            except OSError:
                pass
    else:
        if old_dest.name and str(old_dest).rstrip("\\/").lower() == rem_norm:
            entry["dest_dir"] = remaining[0]

    entry["source_paths"] = remaining
    save_libraries(cfg)
    _INITIALIZED_DBS.clear()
    return {"status": "ok", "source_paths": remaining, "dest_dir": entry.get("dest_dir", "")}


@router.post("/api/libraries/delete")
def api_delete_library(payload: DeleteLibraryPayload):
    if STATE.is_running:
        request_stop_pipeline(cancel=True)
        time.sleep(0.3)

    cfg = load_libraries()
    libs = cfg.get("libraries", {})
    if payload.name not in libs:
        raise HTTPException(404, "Bibliothèque introuvable")

    lib = libs.pop(payload.name)
    _INITIALIZED_DBS.clear()

    old_icon = str(lib.get("icon_file") or "").strip()
    if old_icon:
        try:
            (get_library_icons_dir() / Path(old_icon).name).unlink(missing_ok=True)
        except OSError:
            pass

    if payload.delete_windows_files:
        dest_p = Path(lib.get("dest_dir", ""))
        db_p = Path(lib.get("db_path", ""))
        if db_p.exists():
            try:
                db_p.unlink(missing_ok=True)
            except Exception:
                pass
        if dest_p.exists() and dest_p.is_dir():
            shutil.rmtree(dest_p, ignore_errors=True)

    remaining = list(libs.keys())
    cfg["active_library"] = remaining[0] if remaining else None
    save_libraries(cfg)
    return {"status": "deleted", "active_library": cfg["active_library"]}


@router.post("/api/libraries/merge")
def api_merge_libraries(payload: dict):
    cfg = load_libraries()
    libs = cfg.get("libraries", {})
    src_name = payload.get("source_lib_name", "")
    dst_name = payload.get("target_lib_name") or cfg.get("active_library") or ""
    fast_merge = bool(payload.get("fast_merge", False))

    if src_name not in libs or dst_name not in libs or src_name == dst_name:
        raise HTTPException(400, "Sélectionnez deux bibliothèques distinctes valides.")

    src_lib = libs[src_name]
    dst_lib = libs[dst_name]

    merged_paths = list(dict.fromkeys([*dst_lib.get("source_paths", []), *src_lib.get("source_paths", [])]))
    dst_lib["source_paths"] = merged_paths

    src_db = Path(src_lib["db_path"])
    dst_db = Path(dst_lib["db_path"])
    duplicates_detected = 0

    for db_file in (src_db, dst_db):
        db_file.parent.mkdir(parents=True, exist_ok=True)
        c_init = fusion.init_db(db_file)
        init_face_tables(c_init)
        init_ocr_tables(c_init)
        upgrade_db_for_clip_and_gps(c_init)
        upgrade_db_for_video_similarity(c_init)
        c_init.commit()
        c_init.close()

    if src_db.exists() and dst_db.exists() and src_db.resolve() != dst_db.resolve():
        conn = sqlite3.connect(dst_db, timeout=30.0)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()

        cur.execute("ATTACH DATABASE ? AS src_db", (str(src_db.resolve()),))

        if not fast_merge:
            cur.execute("""
                SELECT COUNT(*) FROM src_db.processed_files s
                WHERE EXISTS (
                    SELECT 1 FROM main.processed_files m
                    WHERE m.source_path = s.source_path
                       OR (s.blake3_hash IS NOT NULL AND m.blake3_hash = s.blake3_hash)
                )
            """)
            duplicates_detected = cur.fetchone()[0] or 0

        cur.execute("PRAGMA main.table_info(processed_files)")
        main_cols = [r["name"] for r in cur.fetchall()]
        cur.execute("PRAGMA src_db.table_info(processed_files)")
        src_cols = {r["name"] for r in cur.fetchall()}

        common_cols = [c for c in main_cols if c in src_cols]
        if common_cols:
            cols_sql = ", ".join(common_cols)
            cur.execute(
                f"INSERT OR IGNORE INTO main.processed_files ({cols_sql}) "
                f"SELECT {cols_sql} FROM src_db.processed_files"
            )

        try:
            cur.execute("PRAGMA main.table_info(ocr_results)")
            main_ocr_cols = [r["name"] for r in cur.fetchall()]
            cur.execute("PRAGMA src_db.table_info(ocr_results)")
            src_ocr_cols = {r["name"] for r in cur.fetchall()}
            common_ocr = [c for c in main_ocr_cols if c in src_ocr_cols]
            if common_ocr:
                ocr_sql = ", ".join(common_ocr)
                cur.execute(
                    f"INSERT OR IGNORE INTO main.ocr_results ({ocr_sql}) "
                    f"SELECT {ocr_sql} FROM src_db.ocr_results"
                )
        except Exception:
            pass

        conn.commit()
        cur.execute("DETACH DATABASE src_db")

        if not fast_merge:
            cur.execute("""
                SELECT blake3_hash, COUNT(*) as cnt
                FROM processed_files
                WHERE is_duplicate = 0 AND is_trashed = 0 AND blake3_hash IS NOT NULL
                GROUP BY blake3_hash HAVING cnt > 1
            """)
            for r in cur.fetchall():
                duplicates_detected += (r["cnt"] - 1)
        conn.close()

    del libs[src_name]
    cfg["active_library"] = dst_name
    save_libraries(cfg)
    _INITIALIZED_DBS.clear()
    log_library_action(
        "LIBRARY_MERGE",
        "Bibliothèques fusionnées",
        f"« {src_name} » fusionnée dans « {dst_name} »" + (f" ({duplicates_detected} doublon(s) détecté(s))" if duplicates_detected else ""),
    )
    return {
        "status": "merged",
        "active_library": dst_name,
        "fast_merge": fast_merge,
        "duplicates_detected": duplicates_detected
    }


@router.post("/api/import/quick_add")
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


@router.post("/api/import/upload_files")
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


class PreflightImportPayload(BaseModel):
    source_type: str = "STANDARD_FOLDER"
    paths: list[str] = []
    dest_dir: str = ""
    only_pending_zips: bool = False


def _existing_ancestor(path_obj: Path) -> Path:
    """Return the deepest existing ancestor directory for disk usage lookup."""
    cur = path_obj
    try:
        cur = path_obj.resolve()
    except OSError:
        cur = path_obj
    while not cur.exists():
        parent = cur.parent
        if parent == cur:
            break
        cur = parent
    return cur if cur.exists() else Path(".")


def _volume_identity(path_obj: Path) -> tuple[str, int]:
    """Identify the filesystem volume holding `path_obj` cleanly across platforms."""
    anc = _existing_ancestor(path_obj)
    drive = os.path.splitdrive(str(anc))[0].lower()
    try:
        dev = os.stat(anc).st_dev
    except OSError:
        dev = 0
    return (drive, dev)


def _format_bytes_fr(num_bytes: int) -> str:
    """Format byte counts in French (Mo / Go) for preflight messages."""
    gb = num_bytes / (1024 ** 3)
    if gb >= 1.0:
        return f"{gb:.1f} Go"
    mb = max(0.1, num_bytes / (1024 ** 2)) if num_bytes > 0 else 0.0
    return f"{mb:.0f} Mo" if mb >= 10 else f"{mb:.1f} Mo"


def _walk_folder_sizes(folder_path: Path, dest_resolved: Path) -> tuple[int, int, int]:
    """Return (file_count, total_bytes, bytes_to_copy) via fast scandir traversal."""
    file_count = 0
    total_bytes = 0
    copy_bytes = 0
    stack = [folder_path]
    while stack:
        cur = stack.pop()
        try:
            with os.scandir(cur) as it:
                for entry in it:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            if entry.name not in IGNORED_INTERNAL_DIRS:
                                stack.append(Path(entry.path))
                        elif entry.is_file(follow_symlinks=False):
                            ext = os.path.splitext(entry.name)[1].lower()
                            if ext not in MEDIA_IMPORT_EXTS:
                                continue
                            fsize = entry.stat(follow_symlinks=False).st_size
                            file_count += 1
                            total_bytes += fsize
                            try:
                                Path(entry.path).resolve().relative_to(dest_resolved)
                            except ValueError:
                                copy_bytes += fsize
                    except OSError:
                        continue
        except OSError:
            continue
    return file_count, total_bytes, copy_bytes


def _inspect_disk_preflight(
    source_type: str,
    source_paths: list[str],
    dest_dir: Path,
    buffer_dir: Path | None = None,
    only_pending_zips: bool = False,
    db_path: Path | None = None,
) -> dict:
    """Estimate required vs free disk space on destination and Takeout buffer volumes."""
    clean_sources = [str(p).strip() for p in (source_paths or []) if str(p).strip()]
    dest_resolved = dest_dir.resolve()
    warnings: list[str] = []

    if buffer_dir is None:
        settings = load_settings()
        custom_dir = str(settings.get("takeout_extract_dir", "") or "").strip()
        buffer_dir = (
            (Path(custom_dir) / "_Temp_Takeout_Buffer")
            if custom_dir
            else get_library_tech_dir(dest_dir, "_Temp_Takeout_Buffer")
        )

    dest_anc = _existing_ancestor(dest_dir)
    buf_anc = _existing_ancestor(buffer_dir)
    dest_free = shutil.disk_usage(dest_anc).free
    buffer_free = shutil.disk_usage(buf_anc).free
    same_volume = (_volume_identity(dest_dir) == _volume_identity(buffer_dir))

    file_count = 0
    zip_count = 0
    compressed_bytes = 0
    uncompressed_bytes = 0
    largest_zip_bytes = 0

    if source_type == "TAKEOUT_ZIPS":
        zips = collect_zip_files(clean_sources)
        done_zips: set[str] = set()
        if only_pending_zips and db_path and Path(db_path).exists():
            try:
                conn = sqlite3.connect(db_path, timeout=10.0)
                cur = conn.cursor()
                for row in cur.execute("SELECT zip_path FROM extracted_zips WHERE status IN ('EXTRACTED', 'DONE')"):
                    done_zips.add(os.path.normcase(str(Path(row[0]).resolve())))
                conn.close()
            except Exception:
                pass

        for zp in zips:
            try:
                if os.path.normcase(str(zp.resolve())) in done_zips:
                    continue
            except OSError:
                pass
            zip_count += 1
            try:
                compressed_bytes += zp.stat().st_size
                with zipfile.ZipFile(zp, "r") as zf:
                    z_uncomp = 0
                    for info in zf.infolist():
                        if not info.is_dir():
                            file_count += 1
                            z_uncomp += info.file_size
                    uncompressed_bytes += z_uncomp
                    if z_uncomp > largest_zip_bytes:
                        largest_zip_bytes = z_uncomp
            except Exception as zerr:
                warnings.append(f"Archive ZIP illisible ({zp.name}) : {translate_runtime_error(zerr)}")

        # On a shared drive, extracted files in buffer + copied destination coexist briefly before zip cleanup;
        # ~1.15x uncompressed accounts for media destination + SQLite/thumbnails overhead.
        needed_dest = int(uncompressed_bytes * 1.15)
        needed_buffer = int(largest_zip_bytes * 1.05) if largest_zip_bytes > 0 else 0
        effective_dest_needed = (needed_dest + needed_buffer) if same_volume else needed_dest
    else:
        copy_bytes = 0
        for p_str in clean_sources:
            fp = Path(p_str)
            if not fp.exists() or not fp.is_dir():
                warnings.append(f"Dossier introuvable ou inaccessible : {p_str}")
                continue
            fc, tb, cb = _walk_folder_sizes(fp, dest_resolved)
            file_count += fc
            uncompressed_bytes += tb
            copy_bytes += cb
        needed_dest = int(copy_bytes * 1.10) + (max(10 * 1024 * 1024, int(uncompressed_bytes * 0.03)) if file_count > 0 else 0)
        needed_buffer = 0
        effective_dest_needed = needed_dest

    deficit_dest = max(0, effective_dest_needed - dest_free)
    deficit_buffer = max(0, needed_buffer - buffer_free) if not same_volume else 0
    enough = (deficit_dest == 0) and (deficit_buffer == 0)

    if deficit_dest > 0:
        warnings.append(
            f"Espace insuffisant sur le disque de destination ({dest_anc}) : "
            f"{_format_bytes_fr(effective_dest_needed)} requis, "
            f"{_format_bytes_fr(dest_free)} disponible "
            f"(il manque {_format_bytes_fr(deficit_dest)})."
        )
    if deficit_buffer > 0:
        warnings.append(
            f"Espace insuffisant sur le lecteur tampon Takeout ({buf_anc}) : "
            f"{_format_bytes_fr(needed_buffer)} requis pour décompresser l'archive, "
            f"{_format_bytes_fr(buffer_free)} disponible "
            f"(il manque {_format_bytes_fr(deficit_buffer)})."
        )

    return {
        "source_type": source_type,
        "file_count": file_count,
        "zip_count": zip_count,
        "compressed_bytes": compressed_bytes,
        "uncompressed_bytes": uncompressed_bytes,
        "needed_dest_bytes": effective_dest_needed,
        "needed_buffer_bytes": needed_buffer,
        "dest_dir": str(dest_dir),
        "buffer_dir": str(buffer_dir),
        "dest_free_bytes": dest_free,
        "buffer_free_bytes": buffer_free,
        "deficit_dest_bytes": deficit_dest,
        "deficit_buffer_bytes": deficit_buffer,
        "same_volume": same_volume,
        "enough": enough,
        "warnings": warnings,
    }


@router.post("/api/import/preflight")
def api_import_preflight(payload: PreflightImportPayload):
    clean_paths = [str(p).strip() for p in payload.paths if str(p).strip()]
    if not clean_paths:
        raise HTTPException(400, "Aucune source sélectionnée pour l'analyse.")

    dest_str = (payload.dest_dir or "").strip()
    if dest_str:
        dest_dir = Path(dest_str)
        db_path = None
    else:
        cfg = load_libraries()
        active_name = cfg.get("active_library")
        libs = cfg.get("libraries", {})
        if active_name and active_name in libs:
            db_path, dest_dir = get_active_db_and_dest()
        else:
            first_p = Path(clean_paths[0])
            dest_dir = first_p.parent if first_p.suffix.lower() == ".zip" else first_p
            db_path = None

    return _inspect_disk_preflight(
        source_type=payload.source_type,
        source_paths=clean_paths,
        dest_dir=dest_dir,
        only_pending_zips=payload.only_pending_zips,
        db_path=db_path,
    )


@router.get("/api/import/preflight_active")
def api_import_preflight_active():
    cfg = load_libraries()
    active_name = cfg.get("active_library")
    libs = cfg.get("libraries", {})
    if not active_name or active_name not in libs:
        return {"enough": True, "warnings": [], "file_count": 0, "zip_count": 0}
    lib = libs[active_name]
    db_path, dest_dir = get_active_db_and_dest()
    return _inspect_disk_preflight(
        source_type=lib.get("source_type", "STANDARD_FOLDER"),
        source_paths=lib.get("source_paths", []),
        dest_dir=dest_dir,
        only_pending_zips=True,
        db_path=db_path,
    )
