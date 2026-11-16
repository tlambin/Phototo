import os
import time
import shutil
import sqlite3
import threading
from pathlib import Path
from datetime import datetime
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel

from library_manager import load_libraries, save_libraries, register_library, get_library_icons_dir
from pipeline_runner import STATE, start_specific_task, request_stop_pipeline
from database import get_active_db_and_dest, _INITIALIZED_DBS
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
    "Miniatures_Cache", "Miniatures_Visages", "Corbeille",
    "Doublons_Quarantaine", "Sauvegardes_DB", "_Temp_Takeout_Buffer"
}


class CreateLibraryPayload(BaseModel):
    name: str
    source_type: str
    source_paths_raw: str
    dest_dir: str
    fix_takeout_json_metadata: bool = True
    delete_zips_progressively: bool = False
    organize_by_year_month: bool = True


class QuickImportPayload(BaseModel):
    source_type: str
    paths: list[str]
    fix_metadata: bool = True
    delete_zips: bool = False


class DeleteLibraryPayload(BaseModel):
    name: str
    delete_windows_files: bool = False


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
    return {"status": "selected", "active_library": name}


@router.post("/api/libraries/create")
def api_create_library(payload: CreateLibraryPayload):
    paths = [p.strip() for p in payload.source_paths_raw.splitlines() if p.strip()]
    dest = payload.dest_dir.strip() or (paths[0] if paths else "./Photos_Triees")
    if not paths:
        paths = [dest]
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
        save_libraries(cfg)
        return {"status": "takeout_sources_added", "imported_count": 0}

    db_path, dest_dir = get_active_db_and_dest()
    rules_map: dict[str, SubfolderRuleItem] = {
        os.path.normcase(str(Path(r.folder_path).resolve())): r
        for r in payload.subfolder_rules
    }

    def _run_folder_import_job():
        STATE.is_running = True
        STATE.active_task = "INGEST"
        STATE.current_step = "Analyse du dossier à importer..."
        STATE.processed_items = 0
        STATE.total_items = 0
        STATE.percent = 0
        STATE.speed_text = "-- Mo/s"
        STATE.eta_text = "--:--"

        start_ts = time.time()
        imported_count = 0
        updated_count = 0
        bytes_processed = 0

        try:
            candidate_files: list[tuple[Path, str | None]] = []
            for folder_str in clean_new_paths:
                folder_p = Path(folder_str)
                if not folder_p.exists() or not folder_p.is_dir():
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
                if not STATE.is_running:
                    if hasattr(STATE, "log"):
                        STATE.log("⏸️ Importation interrompue par l'utilisateur.")
                    break

                src_str = str(file_p.resolve())
                try:
                    stat = file_p.stat()
                    mtime = int(stat.st_mtime)
                    fsize = stat.st_size
                except OSError:
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
                        except Exception:
                            final_dest = file_p.resolve()

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

            STATE.current_step = "Importation terminée"
            STATE.percent = 100
            detail_msg = f"{imported_count} nouveau(x) média(s) importé(s), {updated_count} mis à jour."
            if hasattr(STATE, "log"):
                STATE.log(f"✅ {detail_msg}")

            if hasattr(STATE, "add_notification"):
                STATE.add_notification("Importation de dossier terminée", "success", detail_msg)
            elif hasattr(STATE, "notifications") and isinstance(STATE.notifications, list):
                STATE.notifications.insert(0, {
                    "title": "Importation de dossier terminée",
                    "detail": detail_msg,
                    "status": "success",
                    "time": datetime.now().strftime("%H:%M"),
                    "read": False
                })

        except Exception as e:
            err_msg = f"Erreur lors de l'importation : {e}"
            if hasattr(STATE, "log"):
                STATE.log(f"❌ {err_msg}")
            if hasattr(STATE, "add_notification"):
                STATE.add_notification("Échec de l'importation", "error", str(e))
            elif hasattr(STATE, "notifications") and isinstance(STATE.notifications, list):
                STATE.notifications.insert(0, {
                    "title": "Échec de l'importation",
                    "detail": str(e),
                    "status": "error",
                    "time": datetime.now().strftime("%H:%M"),
                    "read": False
                })
        finally:
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
    new_source = (payload.get("new_source") or "").strip()
    move_existing = bool(payload.get("move_existing_content", False))

    old_dest = Path(entry.get("dest_dir", ""))
    entry["name"] = new_name

    if new_source:
        new_dest = Path(new_source)
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
            if old_db_name and (new_dest / old_db_name).exists():
                entry["db_path"] = str(new_dest / old_db_name)

            db_p = Path(entry["db_path"])
            if db_p.exists():
                conn = sqlite3.connect(db_p, timeout=30.0)
                old_prefix = str(old_dest)
                new_prefix = str(new_dest)
                conn.execute(
                    "UPDATE processed_files SET dest_path = REPLACE(dest_path, ?, ?), source_path = REPLACE(source_path, ?, ?)",
                    (old_prefix, new_prefix, old_prefix, new_prefix)
                )
                conn.commit()
                conn.close()

        entry["source_paths"] = [str(new_dest)]
        entry["dest_dir"] = str(new_dest)

    libs[new_name] = entry
    if cfg.get("active_library") == orig_name:
        cfg["active_library"] = new_name
    save_libraries(cfg)
    _INITIALIZED_DBS.clear()
    return {"status": "updated", "active_library": cfg.get("active_library")}


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
