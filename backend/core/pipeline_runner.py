import os
import re
import sys
import time
import ctypes
import shutil
import zipfile
import sqlite3
import threading
import concurrent.futures
from contextlib import contextmanager
from pathlib import Path
from datetime import datetime
from concurrent.futures import ProcessPoolExecutor

_ROOT_DIR = Path(__file__).resolve().parents[2]
for _sub in ("backend/core", "backend/engines", "backend/routers"):
    _p = str(_ROOT_DIR / _sub)
    if _p not in sys.path:
        sys.path.insert(0, _p)

from library_manager import load_libraries, collect_zip_files, get_takeout_buffer_dir, get_library_tech_dir
from settings_manager import load_settings, get_hardware_runtime_config
from database import record_activity_entry, list_activity_entries, get_active_db_and_dest
from media_frames import ALL_MEDIA_EXTS, VIDEO_EXTS, extract_analysis_frames
import fusion_takeout_complet as fusion
import deduplicateur as dedup
import indexeur_visages as faces_ai
import indexeur_ocr as ocr_ai
import indexeur_similaires as sim_ai
import indexeur_semantique_gps as clip_gps_ai
import suggestions_engine as sug_ai

MAX_PARALLEL_ZIPS = min(4, os.cpu_count() or 4)

ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001


def set_system_sleep_inhibit(enabled: bool) -> bool:
    """Prevent Windows idle sleep while an import or AI task runs (display may still sleep)."""
    if sys.platform != "win32":
        return False
    try:
        flags = (ES_CONTINUOUS | ES_SYSTEM_REQUIRED) if enabled else ES_CONTINUOUS
        return bool(ctypes.windll.kernel32.SetThreadExecutionState(flags))
    except Exception:
        return False


def translate_runtime_error(err: Exception | str) -> str:
    """Translate technical SQLite/OS exceptions into clear user-facing French messages."""
    raw = (str(err) if err is not None else "").strip()
    low = raw.lower()
    if any(tok in low for tok in ("database or disk is full", "no space left on device", "disk full", "not enough space", "winerror 112", "errno 28")):
        return "Disque plein : espace insuffisant sur le lecteur de destination ou le dossier tampon."
    if any(tok in low for tok in ("database is locked", "database table is locked")):
        return "Base de données temporairement verrouillée, réessayez dans un instant."
    if any(tok in low for tok in ("permission denied", "access is denied", "winerror 5", "errno 13", "readonly database")):
        return "Accès refusé : vérifiez les droits d'écriture sur le dossier."
    if any(tok in low for tok in ("no such file or directory", "cannot find the path", "winerror 2", "winerror 3")):
        return "Fichier ou dossier introuvable sur le disque."
    if any(tok in low for tok in ("badzipfile", "file is not a zip file")):
        return "Archive .zip corrompue ou invalide."
    if any(tok in low for tok in ("out of memory", "memoryerror")):
        return "Mémoire vive insuffisante pour traiter ce lot."
    return raw or (type(err).__name__ if isinstance(err, Exception) else "Erreur inconnue")


@contextmanager
def prevent_system_sleep():
    set_system_sleep_inhibit(True)
    try:
        yield
    finally:
        set_system_sleep_inhibit(False)


def _open_worker_db(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=30000;")
    return conn


def format_eta(seconds: float) -> str:
    if seconds <= 0 or seconds > 86400 * 7:
        return "--:--"
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    return f"{h:02d}h{m:02d}m{s:02d}" if h > 0 else f"{m:02d}m{s:02d}s"


def safe_unlink(p: Path, retries: int = 5, delay: float = 0.25):
    for attempt in range(retries):
        try:
            if p.exists():
                p.unlink()
            return
        except PermissionError:
            time.sleep(delay * (attempt + 1))
        except Exception:
            return


def safe_rmtree(folder: Path):
    if not folder.exists():
        return
    for p in folder.rglob("*"):
        if p.is_file():
            safe_unlink(p, retries=3, delay=0.15)
    shutil.rmtree(folder, ignore_errors=True)


class PipelineState:
    def __init__(self):
        self.is_running: bool = False
        self.stop_requested: bool = False
        self.cancel_requested: bool = False
        self.active_task: str = "IDLE"
        self.last_paused_task: str = ""
        self.status_level: str = "idle"  # 'idle' | 'running' | 'paused' | 'error' | 'stopped'
        self.library_name: str = ""
        self.current_step: str = "Aucune tâche en cours"
        self.processed_items: int = 0
        self.total_items: int = 0
        self.percent: float = 0.0
        self.speed_text: str = ""
        self.eta_text: str = ""
        self.logs: list[str] = []
        self.missing_meta_files: list[str] = []
        self.current_failed_files: list[dict] = []
        self.notifications: list[dict] = []
        self._ingestion_recorded: bool = False
        self._step_start_ts: float = time.time()
        self._last_new_files_sig: tuple | None = None
        self._lock = threading.Lock()

    def log(self, message: str):
        ts = datetime.now().strftime("%H:%M:%S")
        with self._lock:
            self.logs.append(f"[{ts}] {message}")
            if len(self.logs) > 120:
                self.logs.pop(0)

    def add_missing_meta_file(self, path_str: str):
        with self._lock:
            clean_p = path_str.replace("\\", "/")
            if clean_p not in self.missing_meta_files and len(self.missing_meta_files) < 200:
                self.missing_meta_files.append(clean_p)

    def add_failed_file(self, path_str: str, reason: str):
        p_clean = str(path_str or "").replace("\\", "/")
        if not p_clean:
            return
        with self._lock:
            if len(self.current_failed_files) < 500:
                self.current_failed_files.append({
                    "path": p_clean,
                    "name": Path(p_clean).name or p_clean,
                    "reason": str(reason or "Erreur inconnue")[:260],
                })

    def add_notification(
        self,
        title: str,
        status: str,
        detail: str = "",
        action_activity_id: int | None = None,
        action_label: str = "",
        action_task: str = "",
    ):
        ts = datetime.now().strftime("%H:%M")
        with self._lock:
            nid = int(time.time() * 1000)
            existing_ids = {int(n.get("id", 0)) for n in self.notifications}
            while nid in existing_ids:
                nid += 1
            entry = {
                "id": nid,
                "time": ts,
                "title": title,
                "status": status,
                "detail": detail,
                "read": False,
            }
            if action_activity_id:
                entry["action_activity_id"] = int(action_activity_id)
                entry["action_label"] = action_label or "Reprendre"
            if action_task:
                entry["action_task"] = str(action_task)
                entry["action_label"] = action_label or "Analyser"
            self.notifications.insert(0, entry)
            if len(self.notifications) > 50:
                self.notifications.pop()

    def update_progress(self, done: int, total: int, unit: str = "fich./s", custom_speed: str = ""):
        with self._lock:
            self.processed_items = done
            self.total_items = total
            self.percent = round((done / total) * 100, 1) if total > 0 else 100.0
            elapsed = max(0.001, time.time() - self._step_start_ts)

            if custom_speed:
                self.speed_text = custom_speed
            elif done > 0:
                rate = done / elapsed
                self.speed_text = f"{rate:.1f} {unit}"
            else:
                self.speed_text = ""

            if done > 0 and total > done:
                rate = done / elapsed
                remaining_sec = (total - done) / rate if rate > 0 else 0
                self.eta_text = format_eta(remaining_sec)
            else:
                self.eta_text = ""

    def set_task(self, task_code: str, title: str):
        with self._lock:
            self.active_task = task_code
            self.status_level = "running"
            self.current_step = title
            self.processed_items = 0
            self.total_items = 0
            self.percent = 0.0
            self.speed_text = ""
            self.eta_text = ""
            self.current_failed_files = []
            self._ingestion_recorded = False
            self._step_start_ts = time.time()
        self.log(f"▶ Démarrage : {title}")

    def to_dict(self) -> dict:
        with self._lock:
            return {
                "is_running": self.is_running,
                "stop_requested": self.stop_requested,
                "active_task": self.active_task,
                "last_paused_task": self.last_paused_task,
                "status_level": self.status_level,
                "library_name": self.library_name,
                "current_step": self.current_step,
                "processed_items": self.processed_items,
                "total_items": self.total_items,
                "percent": self.percent,
                "speed_text": self.speed_text,
                "eta_text": self.eta_text,
                "logs": list(self.logs),
                "missing_meta_files": list(self.missing_meta_files),
                "missing_meta_count": len(self.missing_meta_files),
                "notifications": list(self.notifications)
            }


STATE = PipelineState()


def init_zip_tracker_table(conn: sqlite3.Connection):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS extracted_zips (
            zip_path TEXT PRIMARY KEY,
            status TEXT,
            extracted_bytes INTEGER,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()


def extract_zip_interruptible(zpath: Path, buffer_dir: Path, progress_cb) -> tuple[Path, bool, int, str]:
    extracted_files = 0
    try:
        with zipfile.ZipFile(zpath, 'r') as zf:
            members = [m for m in zf.infolist() if not m.is_dir()]
            for member in members:
                if STATE.stop_requested:
                    return (zpath, False, extracted_files, "PAUSED")

                clean_parts = [
                    re.sub(r'[<>:"|?*\x00-\x1f]', '_', seg).strip('. ')
                    for seg in member.filename.replace("\\", "/").replace("\xa0", " ").split("/")
                    if seg and seg not in (".", "..")
                ]
                if not clean_parts:
                    continue
                target_path = buffer_dir.joinpath(*clean_parts)

                if target_path.exists() and target_path.stat().st_size == member.file_size:
                    extracted_files += 1
                    progress_cb(member.file_size, 1, f"{zpath.name} -> {target_path.name}")
                    continue

                target_path.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(member, 'r') as src_f, open(target_path, 'wb') as dst_f:
                    shutil.copyfileobj(src_f, dst_f, length=1048576)

                extracted_files += 1
                progress_cb(member.file_size, 1, f"{zpath.name} -> {target_path.name}")

        return (zpath, True, extracted_files, "OK")
    except Exception as e:
        return (zpath, False, extracted_files, translate_runtime_error(e))


def _format_duration_fr(seconds: float) -> str:
    secs = max(0.0, float(seconds or 0.0))
    if secs < 60:
        return f"{secs:.1f}".replace(".", ",") + " s"
    total_int = int(round(secs))
    if total_int < 3600:
        m, s = divmod(total_int, 60)
        return f"{m} min {s:02d} s"
    h, rem = divmod(total_int, 3600)
    m = rem // 60
    return f"{h} h {m:02d} min"


def _collect_ingestion_issue(res: tuple) -> dict | None:
    st_code = res[3]
    err_msg = str(res[14] or "").strip() if len(res) > 14 else ""
    target = str(res[1] or res[0] or "")
    if st_code == "error":
        reason = translate_runtime_error(err_msg) if err_msg else "Impossible d'importer ou de traiter le fichier"
    elif st_code == "no_metadata":
        reason = err_msg or "Métadonnées / date EXIF ou JSON introuvables"
    elif err_msg:
        reason = translate_runtime_error(err_msg)
    else:
        return None
    return {
        "path": target.replace("\\", "/"),
        "name": Path(target).name if target else "Fichier inconnu",
        "reason": reason[:260],
    }


def _record_step_activity(
    db_path: Path,
    lib_name: str,
    action_type: str,
    title: str,
    start_ts: float,
    start_iso: str,
    total_items: int,
    success_count: int,
    failed_files: list[dict],
    stopped: bool = False,
    cancelled: bool = False,
    error_reason: str = "",
    params_json: str = "",
):
    duration_sec = max(0.0, time.time() - start_ts)
    dur_lbl = _format_duration_fr(duration_sec)
    finished_iso = datetime.now().isoformat(timespec="seconds")

    if error_reason:
        status = "error"
        reason = error_reason
        detail = f"Échec : {error_reason} · {dur_lbl}"
    elif stopped and cancelled:
        status = "paused"
        reason = "Tâche arrêtée par l'utilisateur"
        detail = f"{reason} · {dur_lbl}"
    elif stopped:
        status = "paused"
        reason = f"Mis en pause ({success_count}/{total_items} traité(s))"
        detail = f"{reason} · {dur_lbl}"
    elif failed_files and success_count == 0 and total_items > 0:
        status = "error"
        reason = str(failed_files[0].get("reason") or "Échec du traitement")
        detail = f"Échec sur {len(failed_files)} fichier(s) ({reason}) · {dur_lbl}"
    elif failed_files:
        status = "partial"
        reason = f"{len(failed_files)} fichier(s) en échec ou incomplets"
        detail = f"{success_count} réussi(s), {len(failed_files)} échec(s) · {dur_lbl}"
    else:
        status = "success"
        reason = ""
        if action_type == "UNZIP":
            detail = f"Décompression terminée avec succès ({total_items} fichier(s) · {dur_lbl})"
        else:
            detail = f"Terminé avec succès ({success_count}/{total_items} élément(s) · {dur_lbl})"

    try:
        record_activity_entry(
            db_path,
            library_name=lib_name,
            action_type=action_type,
            title=title,
            status=status,
            detail=detail,
            reason=reason,
            started_at=start_iso,
            finished_at=finished_iso,
            duration_sec=duration_sec,
            total_items=total_items,
            success_count=success_count,
            failed_files=failed_files,
            params_json=params_json,
        )
    except Exception:
        pass
    STATE.add_notification(title, status, detail)


def run_step_ingestion(lib: dict):
    src_type = lib["source_type"]
    db_path = Path(lib["db_path"])
    dest_dir = Path(lib["dest_dir"])
    lib_name = lib.get("name", "")
    fix_meta = bool(lib["options"].get("fix_takeout_json_metadata", True))
    is_takeout = bool(lib.get("is_takeout", False))
    organize = lib["options"].get("organize_by_year_month", True)
    keep_structure = lib["options"].get("takeout_keep_structure", True)
    wrap_google_album = lib["options"].get("takeout_wrap_google_album", False)

    STATE.missing_meta_files.clear()
    STATE._ingestion_recorded = False
    conn = fusion.init_db(db_path)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=30000;")
    init_zip_tracker_table(conn)
    cur = conn.cursor()

    if src_type == "TAKEOUT_ZIPS":
        all_zip_files = collect_zip_files(lib["source_paths"])
        delete_zips = lib["options"].get("delete_zips_progressively", False)
        buffer_dir = get_takeout_buffer_dir(dest_dir)

        cur.execute("SELECT zip_path, status FROM extracted_zips")
        zip_status_map = dict(cur.fetchall())
        pending_zips = [z for z in all_zip_files if zip_status_map.get(str(z)) not in ("EXTRACTED", "DONE")]

        if pending_zips:
            STATE.current_step = "Decompression en cours..."
            unzip_start_iso = datetime.now().isoformat(timespec="seconds")
            unzip_start_ts = time.time()
            total_zip_members, total_zip_bytes = 0, 0
            for z in pending_zips:
                try:
                    with zipfile.ZipFile(z, 'r') as zf:
                        for m in zf.infolist():
                            if not m.is_dir():
                                total_zip_members += 1
                                total_zip_bytes += m.file_size
                except Exception:
                    pass

            STATE.log(f"📦 {len(pending_zips)}/{len(all_zip_files)} archive(s) .ZIP à décompresser...")
            done_bytes, done_members = 0, 0
            start_zip_t = time.time()
            lock = threading.Lock()
            last_log_t = time.time()
            failed_zips: list[dict] = []

            def _on_member_extracted(b_size: int, f_count: int, file_label: str = ""):
                nonlocal done_bytes, done_members, last_log_t
                with lock:
                    done_bytes += b_size
                    done_members += f_count
                    elapsed = max(0.001, time.time() - start_zip_t)
                    mb_s = (done_bytes / (1024 * 1024)) / elapsed
                    speed_str = f"{mb_s:.0f} Mo/s"
                    STATE.update_progress(done_members, max(1, total_zip_members), custom_speed=speed_str)
                    if file_label:
                        STATE.log(f"📦 {file_label} ({done_members}/{total_zip_members})")
                    elif time.time() - last_log_t >= 4.0:
                        last_log_t = time.time()
                        STATE.log(f"⚡ Décompression : {done_members}/{total_zip_members} fichiers — {speed_str}")

            with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_PARALLEL_ZIPS) as zip_pool:
                futures = {
                    zip_pool.submit(extract_zip_interruptible, zpath, buffer_dir, _on_member_extracted): zpath
                    for zpath in pending_zips
                }
                for fut in concurrent.futures.as_completed(futures):
                    zpath, ok_flag, f_cnt, msg = fut.result()
                    if ok_flag:
                        conn.execute(
                            "INSERT OR REPLACE INTO extracted_zips (zip_path, status, extracted_bytes) VALUES (?, 'EXTRACTED', ?)",
                            (str(zpath), zpath.stat().st_size if zpath.exists() else 0)
                        )
                        conn.commit()
                        STATE.log(f"✅ Archive décompressée : {zpath.name} ({f_cnt} fichiers)")
                    elif msg == "PAUSED":
                        STATE.log(f"⏸️ Pause sur {zpath.name}.")
                    else:
                        failed_zips.append({
                            "path": str(zpath).replace("\\", "/"),
                            "name": zpath.name,
                            "reason": str(msg or "Erreur d'extraction ZIP")[:260],
                        })
                        STATE.log(f"❌ Erreur sur {zpath.name} : {msg}")

            _record_step_activity(
                db_path,
                lib_name,
                "UNZIP",
                "Décompression Google Takeout",
                unzip_start_ts,
                unzip_start_iso,
                max(total_zip_members, len(pending_zips)),
                done_members,
                failed_zips,
                stopped=STATE.stop_requested,
                cancelled=STATE.cancel_requested,
            )
            STATE._ingestion_recorded = True

        if STATE.stop_requested:
            conn.close()
            return

        processed_set = fusion.get_already_processed(conn)
        all_media = [
            p for p in buffer_dir.rglob("*")
            if p.is_file() and p.suffix.lower() not in fusion.IGNORED_EXTS
            and not p.name.endswith(".supplemental-metadata.json")
            and str(p) not in processed_set
        ]

        total_m = len(all_media)
        step_title = "Correction des métadonnées Takeout" if (is_takeout and fix_meta) else "Importation des fichiers"
        action_code = "METADATA" if (is_takeout and fix_meta) else "IMPORT"
        STATE.current_step = "Correction des metadonnées..." if (is_takeout and fix_meta) else "Importation des fichiers..."
        STATE.log(f"🔧 {total_m} média(s) à traiter...")
        imp_start_iso = datetime.now().isoformat(timespec="seconds")
        imp_start_ts = time.time()
        STATE._step_start_ts = imp_start_ts
        STATE.update_progress(0, total_m, unit="fich./s")

        batch, errors, done, ok_count = [], 0, 0, 0
        failed_meta_items: list[dict] = []
        with ProcessPoolExecutor(
            max_workers=fusion.MAX_WORKERS,
            initializer=fusion.init_worker,
            initargs=(str(dest_dir), is_takeout, organize, keep_structure, wrap_google_album, fix_meta)
        ) as executor:
            for res in executor.map(fusion.process_single_file, all_media, chunksize=20):
                if STATE.stop_requested:
                    break
                done += 1
                STATE.log(f"📥 {Path(res[1] or res[0]).name} ({done}/{total_m})")
                if done % 15 == 0 or done == total_m:
                    STATE.update_progress(done, total_m, unit="fich./s")
                issue = _collect_ingestion_issue(res)
                if issue:
                    failed_meta_items.append(issue)
                if res[3] in ("error", "no_metadata"):
                    if res[3] == "error":
                        errors += 1
                    STATE.add_missing_meta_file(res[1] or res[0])
                else:
                    ok_count += 1
                batch.append(res)
                if len(batch) >= 120:
                    fusion.save_batch_to_db(conn, batch)
                    batch.clear()

        if batch:
            fusion.save_batch_to_db(conn, batch)

        _record_step_activity(
            db_path,
            lib_name,
            action_code,
            step_title,
            imp_start_ts,
            imp_start_iso,
            total_m,
            ok_count,
            failed_meta_items,
            stopped=STATE.stop_requested,
            cancelled=STATE.cancel_requested,
        )
        STATE._ingestion_recorded = True

        if STATE.stop_requested:
            conn.close()
            return

        safe_rmtree(buffer_dir)
        for zpath in all_zip_files:
            conn.execute("UPDATE extracted_zips SET status = 'DONE' WHERE zip_path = ?", (str(zpath),))
            if delete_zips and errors == 0 and zpath.exists():
                safe_unlink(zpath)
        conn.commit()
        conn.close()
        return

    processed_set = fusion.get_already_processed(conn)
    settings = load_settings()
    extra_folders = settings.get("scanned_folders", []) if src_type == "STANDARD_FOLDER" else []
    all_roots = list(dict.fromkeys([*lib["source_paths"], *extra_folders]))

    remaining = []
    for r_str in all_roots:
        rp = Path(r_str)
        if not rp.exists():
            continue
        for p in rp.rglob("*"):
            if (
                p.is_file() and p.suffix.lower() not in fusion.IGNORED_EXTS
                and not p.name.endswith(".supplemental-metadata.json")
                and str(p) not in processed_set
            ):
                remaining.append(p)

    total = len(remaining)
    step_title = "Correction des métadonnées Takeout" if (is_takeout and fix_meta) else "Importation des fichiers"
    action_code = "METADATA" if (is_takeout and fix_meta) else "IMPORT"
    STATE.current_step = "Correction des metadonnées..." if (is_takeout and fix_meta) else "Importation des fichiers..."
    STATE.log(f"🔧 {total} média(s) à traiter...")
    imp_start_iso = datetime.now().isoformat(timespec="seconds")
    imp_start_ts = time.time()
    STATE._step_start_ts = imp_start_ts
    STATE.update_progress(0, total, unit="fich./s")
    if total == 0:
        _record_step_activity(
            db_path, lib_name, action_code, step_title,
            imp_start_ts, imp_start_iso, 0, 0, [],
        )
        STATE._ingestion_recorded = True
        conn.close()
        return

    batch, done, ok_count = [], 0, 0
    failed_items: list[dict] = []
    takeout_roots = list(all_roots) if is_takeout else []
    with ProcessPoolExecutor(
        max_workers=fusion.MAX_WORKERS,
        initializer=fusion.init_worker,
        initargs=(str(dest_dir), is_takeout, organize, keep_structure, wrap_google_album, fix_meta, takeout_roots)
    ) as executor:
        for res in executor.map(fusion.process_single_file, remaining, chunksize=20):
            if STATE.stop_requested:
                break
            done += 1
            STATE.log(f"📥 {Path(res[1] or res[0]).name} ({done}/{total})")
            if done % 15 == 0 or done == total:
                STATE.update_progress(done, total, unit="fich./s")
            issue = _collect_ingestion_issue(res)
            if issue:
                failed_items.append(issue)
            if res[3] in ("error", "no_metadata"):
                STATE.add_missing_meta_file(res[1] or res[0])
            else:
                ok_count += 1
            batch.append(res)
            if len(batch) >= 150:
                fusion.save_batch_to_db(conn, batch)
                batch.clear()

    if batch:
        fusion.save_batch_to_db(conn, batch)
    _record_step_activity(
        db_path,
        lib_name,
        action_code,
        step_title,
        imp_start_ts,
        imp_start_iso,
        total,
        ok_count,
        failed_items,
        stopped=STATE.stop_requested,
        cancelled=STATE.cancel_requested,
    )
    STATE._ingestion_recorded = True
    conn.close()


def _group_exact_duplicates_now(conn: sqlite3.Connection):
    cur = conn.cursor()
    cur.execute("SELECT blake3_hash FROM processed_files WHERE is_duplicate = 0 AND blake3_hash IS NOT NULL GROUP BY blake3_hash HAVING COUNT(*) > 1")
    for (b3_hash,) in cur.fetchall():
        cur.execute("SELECT * FROM processed_files WHERE blake3_hash = ? AND is_duplicate = 0", (b3_hash,))
        group = [dict(r) for r in cur.fetchall()]
        if len(group) > 1:
            winner, losers = dedup.choose_winner(group, "BLAKE3")
            dedup.merge_metadata_and_clean(conn, winner, losers)
    conn.commit()


def run_step_deduplication(lib: dict):
    db_path = Path(lib["db_path"])
    dest_dir = Path(lib["dest_dir"])
    dedup.DB_PATH = db_path
    dedup.DEST_DIR = dest_dir
    dedup.QUARANTINE_DIR = get_library_tech_dir(dest_dir, "Doublons_Quarantaine")

    conn = _open_worker_db(db_path)
    dedup.upgrade_db(conn)
    cur = conn.cursor()

    cur.execute("""
        SELECT source_path, dest_path FROM processed_files
        WHERE status NOT IN ('error', 'trashed') AND blake3_hash IS NULL AND dest_path IS NOT NULL
    """)
    to_hash = [(r["source_path"], r["dest_path"], True) for r in cur.fetchall()]
    total = len(to_hash)
    STATE.log(f"🔎 {total} média(s) à analyser (doublons)...")
    STATE._step_start_ts = time.time()
    STATE.update_progress(0, total, unit="fich./s")

    if total > 0:
        batch, done = [], 0
        with ProcessPoolExecutor(max_workers=dedup.MAX_WORKERS) as executor:
            for res in executor.map(dedup.compute_file_signatures, to_hash, chunksize=25):
                if STATE.stop_requested:
                    break
                done += 1
                src, fsize, b3, ph, w, h = res
                STATE.log(f"🧬 {Path(src).name} ({done}/{total})")
                if done % 15 == 0 or done == total:
                    STATE.update_progress(done, total, unit="fich./s")
                if b3:
                    batch.append((fsize, b3, ph, w, h, src))
                else:
                    STATE.add_failed_file(src, "Impossible de calculer la signature / fichier illisible")
                if len(batch) >= 100:
                    conn.executemany("UPDATE processed_files SET file_size=?, blake3_hash=?, phash=?, width=?, height=? WHERE source_path=?", batch)
                    conn.commit()
                    batch.clear()
        if batch:
            conn.executemany("UPDATE processed_files SET file_size=?, blake3_hash=?, phash=?, width=?, height=? WHERE source_path=?", batch)
            conn.commit()

    conn.close()


def run_step_similarity(lib: dict):
    run_step_deduplication(lib)
    if STATE.stop_requested:
        return

    db_path = Path(lib["db_path"])
    conn = _open_worker_db(db_path)
    sim_ai.upgrade_db_for_video_similarity(conn)
    cur = conn.cursor()
    cur.execute("SELECT source_path, dest_path FROM processed_files WHERE is_duplicate = 0 AND is_trashed = 0 AND video_hash IS NULL AND dest_path IS NOT NULL")
    videos = [r for r in cur.fetchall() if Path(r["dest_path"]).suffix.lower() in VIDEO_EXTS]
    total = len(videos)
    STATE.log(f"🎞️ {total} vidéo(s) à analyser...")
    STATE._step_start_ts = time.time()
    STATE.update_progress(0, total, unit="vidéos/s")

    if total > 0:
        batch, done = [], 0
        for r in videos:
            if STATE.stop_requested:
                break
            done += 1
            vpath = Path(r["dest_path"])
            STATE.log(f"🎞️ {vpath.name} ({done}/{total})")
            STATE.update_progress(done, total, unit="vidéos/s")
            if vpath.exists():
                vhash, dur = sim_ai.compute_video_fingerprint(vpath)
                if not vhash:
                    STATE.add_failed_file(str(vpath), "Impossible d'analyser l'empreinte vidéo")
                batch.append((vhash or "NONE", dur, r["source_path"]))
            else:
                STATE.add_failed_file(str(vpath), "Fichier vidéo introuvable sur le disque")
            if len(batch) >= 25:
                cur.executemany("UPDATE processed_files SET video_hash=?, duration_sec=? WHERE source_path=?", batch)
                conn.commit()
                batch.clear()
        if batch:
            cur.executemany("UPDATE processed_files SET video_hash=?, duration_sec=? WHERE source_path=?", batch)
            conn.commit()
    conn.close()


def _assign_unclustered_faces_incremental(conn: sqlite3.Connection, sim_thresh: float = 0.45):
    import numpy as np
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    cur.execute("SELECT person_id, centroid_embedding, face_count FROM persons WHERE centroid_embedding IS NOT NULL")
    persons = []
    for r in cur.fetchall():
        persons.append({
            "person_id": r["person_id"],
            "vec": np.frombuffer(r["centroid_embedding"], dtype=np.float32),
            "count": r["face_count"] or 1
        })

    cur.execute("SELECT face_id, embedding, det_score FROM faces WHERE person_id IS NULL AND embedding IS NOT NULL")
    unassigned = cur.fetchall()
    if not unassigned:
        return

    for f in unassigned:
        emb = np.frombuffer(f["embedding"], dtype=np.float32)
        best_pid = None
        best_sim = -1.0
        best_p_obj = None

        for p in persons:
            sim = float(np.dot(emb, p["vec"]))
            if sim > best_sim:
                best_sim = sim
                best_pid = p["person_id"]
                best_p_obj = p

        if best_sim >= sim_thresh and best_p_obj is not None:
            new_cnt = best_p_obj["count"] + 1
            new_vec = (best_p_obj["vec"] * best_p_obj["count"] + emb) / new_cnt
            norm = np.linalg.norm(new_vec)
            if norm > 0:
                new_vec = (new_vec / norm).astype(np.float32)
            best_p_obj["vec"] = new_vec
            best_p_obj["count"] = new_cnt
            cur.execute("UPDATE faces SET person_id = ? WHERE face_id = ?", (best_pid, f["face_id"]))
            cur.execute("UPDATE persons SET face_count = ?, centroid_embedding = ? WHERE person_id = ?", (new_cnt, new_vec.tobytes(), best_pid))
        else:
            cur.execute(
                "INSERT INTO persons (name, cover_face_id, face_count, centroid_embedding) VALUES ('Inconnu', ?, 1, ?)",
                (f["face_id"], emb.tobytes())
            )
            new_pid = cur.lastrowid
            cur.execute("UPDATE faces SET person_id = ? WHERE face_id = ?", (new_pid, f["face_id"]))
            persons.append({"person_id": new_pid, "vec": emb, "count": 1})

    conn.commit()


def run_step_faces(lib: dict):
    db_path = Path(lib["db_path"])
    dest_dir = Path(lib["dest_dir"])
    faces_ai.DB_PATH = db_path
    faces_ai.DEST_DIR = dest_dir
    faces_ai.THUMBS_DIR = get_library_tech_dir(dest_dir, "Miniatures_Visages")

    conn = _open_worker_db(db_path)
    faces_ai.init_face_tables(conn)
    cur = conn.cursor()
    cur.execute("""
        SELECT source_path, dest_path, timestamp FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND faces_scanned = 0 AND dest_path IS NOT NULL
    """)
    to_scan = [r for r in cur.fetchall() if Path(r[1]).suffix.lower() in ALL_MEDIA_EXTS]
    total = len(to_scan)
    STATE.log(f"👤 {total} média(s) à analyser (visages)...")
    STATE._step_start_ts = time.time()
    STATE.update_progress(0, total, unit="médias/s")

    if total > 0:
        import numpy as np
        hw = get_hardware_runtime_config()
        faces_model = str(load_settings().get("faces_model", "buffalo_l")).strip()
        if faces_model not in ("buffalo_s", "buffalo_l", "antelopev2"):
            faces_model = "buffalo_l"
        app = faces_ai.create_face_analysis(
            faces_model=faces_model,
            providers=hw["onnx_providers"],
            ctx_id=hw["onnx_ctx_id"],
            det_size=faces_ai.DET_SIZE,
        )

        from concurrent.futures import ThreadPoolExecutor
        workers = max(1, int(hw.get("recommended_workers", 4)))
        faces_batch, scanned_batch, done = [], [], 0
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for i in range(0, total, 25):
                if STATE.stop_requested:
                    break
                chunk = to_scan[i:i + 25]
                decoded_list = list(pool.map(lambda r: extract_analysis_frames(r[1]), chunk))
                for (src_path, dest_path, ts), frames in zip(chunk, decoded_list):
                    if STATE.stop_requested:
                        break
                    done += 1
                    STATE.log(f"👤 {Path(dest_path).name} ({done}/{total})")
                    STATE.update_progress(done, total, unit="médias/s")
                    raw_cands = []
                    for f_idx_frame, img in enumerate(frames):
                        for f_idx, face in enumerate(app.get(img)):
                            bbox = face.bbox.astype(int).tolist()
                            if face.det_score < faces_ai.MIN_FACE_SCORE or (bbox[2] - bbox[0]) < faces_ai.MIN_FACE_PIXELS:
                                continue
                            raw_cands.append({
                                "img": img, "bbox": bbox, "det_score": float(face.det_score),
                                "emb": face.normed_embedding.astype(np.float32),
                                "uid": f"{abs(hash(src_path))}_f{f_idx_frame}_{f_idx}"
                            })

                    for mf in faces_ai.deduplicate_video_faces(raw_cands):
                        thumb = faces_ai.save_face_thumbnail(mf["img"], mf["bbox"], mf["uid"])
                        b = mf["bbox"]
                        faces_batch.append((src_path, dest_path, ts or 0, f"{b[0]},{b[1]},{b[2]},{b[3]}", mf["det_score"], mf["emb"].tobytes(), thumb))

                    scanned_batch.append((faces_model, src_path))

                if scanned_batch:
                    if faces_batch:
                        cur.executemany("INSERT INTO faces (source_path, dest_path, timestamp, bbox, det_score, embedding, thumb_path) VALUES (?,?,?,?,?,?,?)", faces_batch)
                        faces_batch.clear()
                    cur.executemany("UPDATE processed_files SET faces_scanned = 1, faces_model = ? WHERE source_path = ?", scanned_batch)
                    conn.commit()
                    scanned_batch.clear()
                    faces_ai.apply_face_name_hints(conn)
                    _assign_unclustered_faces_incremental(conn)

        if faces_batch:
            cur.executemany("INSERT INTO faces (source_path, dest_path, timestamp, bbox, det_score, embedding, thumb_path) VALUES (?,?,?,?,?,?,?)", faces_batch)
        if scanned_batch:
            cur.executemany("UPDATE processed_files SET faces_scanned = 1, faces_model = ? WHERE source_path = ?", scanned_batch)
        conn.commit()

    faces_ai.apply_face_name_hints(conn)
    _assign_unclustered_faces_incremental(conn)
    if not STATE.stop_requested:
        faces_ai.run_face_clustering(conn)
        cur.execute("DELETE FROM face_name_hints WHERE source_path IN (SELECT source_path FROM processed_files WHERE faces_scanned = 1)")
        conn.commit()
    conn.close()


def run_step_ocr(lib: dict):
    db_path = Path(lib["db_path"])
    conn = _open_worker_db(db_path)
    ocr_ai.init_ocr_tables(conn)
    cur = conn.cursor()
    cur.execute("""
        SELECT source_path, dest_path, timestamp FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND ocr_scanned = 0 AND dest_path IS NOT NULL
    """)
    to_scan = [r for r in cur.fetchall() if Path(r[1]).suffix.lower() in ALL_MEDIA_EXTS]
    total = len(to_scan)
    STATE.log(f"📝 {total} média(s) à analyser (OCR)...")
    STATE._step_start_ts = time.time()
    STATE.update_progress(0, total, unit="médias/s")

    if total > 0:
        hw = get_hardware_runtime_config()
        cfg = load_settings()
        lang_cfg = cfg.get("language", "fr")
        ocr_choice = str(cfg.get("ocr_engine", "paddleocr")).strip().lower()

        def _make_ocr_fn():
            if ocr_choice == "rapidocr":
                from rapidocr_onnxruntime import RapidOCR
                use_cuda = "CUDAExecutionProvider" in hw.get("onnx_providers", [])
                try:
                    eng = RapidOCR(det_use_cuda=use_cuda, cls_use_cuda=use_cuda, rec_use_cuda=use_cuda)
                except TypeError:
                    eng = RapidOCR()
                def _run_rapid(img):
                    res, _ = eng(img)
                    return [(item[1], float(item[2])) for item in (res or []) if len(item) >= 3]
                return _run_rapid

            if ocr_choice == "easyocr":
                import easyocr
                langs = [lang_cfg, "en"] if lang_cfg != "en" else ["en"]
                reader = easyocr.Reader(langs, gpu=(hw["torch_device"] == "cuda"))
                def _run_easy(img):
                    res = reader.readtext(img)
                    return [(item[1], float(item[2])) for item in (res or []) if len(item) >= 3]
                return _run_easy

            eng = ocr_ai.create_paddle_ocr_engine(lang=lang_cfg, prefer_gpu=bool(hw.get("paddle_use_gpu")))
            return lambda img: ocr_ai.run_paddle_ocr_image(eng, img)

        from concurrent.futures import ThreadPoolExecutor
        workers = max(1, int(hw.get("recommended_workers", 4)))
        run_ocr_on_img = _make_ocr_fn()
        ocr_batch, fts_batch, scanned_batch, done = [], [], [], 0

        with ThreadPoolExecutor(max_workers=workers) as pool:
            for i in range(0, total, 40):
                if STATE.stop_requested:
                    break
                chunk = to_scan[i:i + 40]
                decoded_list = list(pool.map(lambda r: extract_analysis_frames(r[1], max_dim=ocr_ai.MAX_IMG_DIM), chunk))
                for (src_path, dest_path, ts), frames in zip(chunk, decoded_list):
                    if STATE.stop_requested:
                        break
                    done += 1
                    STATE.log(f"📝 {Path(dest_path).name} ({done}/{total})")
                    STATE.update_progress(done, total, unit="médias/s")
                    unique_lines, seen_lower, scores = [], set(), []
                    for img in frames:
                        try:
                            items = run_ocr_on_img(img)
                        except Exception:
                            items = []
                        for raw_txt, conf in items:
                            txt = str(raw_txt or "").strip()
                            if conf >= ocr_ai.MIN_CONFIDENCE and len(txt) >= 2 and txt.lower() not in seen_lower:
                                seen_lower.add(txt.lower())
                                unique_lines.append(txt)
                                scores.append(conf)
                    if unique_lines:
                        full_txt = " | ".join(unique_lines)
                        avg_c = round(sum(scores) / len(scores), 3)
                        ocr_batch.append((src_path, dest_path, ts or 0, full_txt, avg_c, len(unique_lines)))
                        fts_batch.append((src_path, dest_path, full_txt))

                    scanned_batch.append((src_path,))

                if scanned_batch:
                    if ocr_batch:
                        cur.executemany("INSERT OR REPLACE INTO ocr_results VALUES (?,?,?,?,?,?)", ocr_batch)
                        cur.executemany("INSERT INTO ocr_fts (source_path, dest_path, full_text) VALUES (?,?,?)", fts_batch)
                        ocr_batch.clear()
                        fts_batch.clear()
                    cur.executemany("UPDATE processed_files SET ocr_scanned = 1 WHERE source_path = ?", scanned_batch)
                    conn.commit()
                    scanned_batch.clear()

        if ocr_batch:
            cur.executemany("INSERT OR REPLACE INTO ocr_results VALUES (?,?,?,?,?,?)", ocr_batch)
            cur.executemany("INSERT INTO ocr_fts (source_path, dest_path, full_text) VALUES (?,?,?)", fts_batch)
        if scanned_batch:
            cur.executemany("UPDATE processed_files SET ocr_scanned = 1 WHERE source_path = ?", scanned_batch)
        conn.commit()
    conn.close()


def run_step_clip(lib: dict):
    import cv2
    import numpy as np
    from PIL import Image
    db_path = Path(lib["db_path"])
    conn = _open_worker_db(db_path)
    clip_gps_ai.upgrade_db_for_clip_and_gps(conn)
    cur = conn.cursor()
    cur.execute("""
        SELECT source_path, dest_path FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND clip_scanned = 0 AND dest_path IS NOT NULL
    """)
    to_scan = [r for r in cur.fetchall() if Path(r[1]).suffix.lower() in ALL_MEDIA_EXTS]
    total = len(to_scan)
    STATE.log(f"🧠 {total} média(s) à indexer (CLIP)...")
    STATE._step_start_ts = time.time()
    STATE.update_progress(0, total, unit="médias/s")

    if total > 0:
        from concurrent.futures import ThreadPoolExecutor
        hw = get_hardware_runtime_config()
        workers = max(1, int(hw.get("recommended_workers", 4)))
        chunk_size = 64 if hw.get("torch_device") == "cuda" else 24
        encode_bs = 128 if hw.get("torch_device") == "cuda" else 32
        clip_key = str(load_settings().get("clip_model", "vit-b-32")).strip().lower()
        vision_model, _ = clip_gps_ai.get_clip_models()
        done = 0

        def _decode_clip_item(row):
            src_s, dest_s = row
            frames = extract_analysis_frames(dest_s, max_dim=512)
            pil_frames = [Image.fromarray(cv2.cvtColor(f_bgr, cv2.COLOR_BGR2RGB)) for f_bgr in frames]
            return src_s, pil_frames

        with ThreadPoolExecutor(max_workers=workers) as pool:
            for i in range(0, total, chunk_size):
                if STATE.stop_requested:
                    break
                batch_rows = to_scan[i:i + chunk_size]
                for idx_in_b, (_, d_s) in enumerate(batch_rows, start=1):
                    STATE.log(f"🧠 {Path(d_s).name} ({done + idx_in_b}/{total})")
                decoded_batch = list(pool.map(_decode_clip_item, batch_rows))
                flat_imgs, slices, failed = [], [], []
                for src_s, pil_frames in decoded_batch:
                    if not pil_frames:
                        failed.append((src_s,))
                        STATE.add_failed_file(src_s, "Décodage visuel impossible pour l'indexation CLIP")
                        continue
                    s_idx = len(flat_imgs)
                    flat_imgs.extend(pil_frames)
                    slices.append((src_s, s_idx, len(flat_imgs)))

                updates = []
                if flat_imgs:
                    embs = vision_model.encode(flat_imgs, batch_size=encode_bs, normalize_embeddings=True, show_progress_bar=False)
                    for src_s, s_i, e_i in slices:
                        m_emb = np.mean(embs[s_i:e_i], axis=0)
                        norm = np.linalg.norm(m_emb)
                        if norm > 0:
                            m_emb = m_emb / norm
                        updates.append((m_emb.astype(np.float16).tobytes(), 1, clip_key, src_s))

                if updates:
                    cur.executemany("UPDATE processed_files SET clip_embedding=?, clip_scanned=?, clip_model=? WHERE source_path=?", updates)
                if failed:
                    cur.executemany("UPDATE processed_files SET clip_scanned=1, clip_model=? WHERE source_path=?", [(clip_key, s[0]) for s in failed])
                conn.commit()
                done += len(batch_rows)
                STATE.update_progress(done, total, unit="médias/s")
    conn.close()
    try:
        import gallery_router
        gallery_router.api_categories_analyze()
    except Exception:
        pass


def _ensure_suggestion_columns(conn: sqlite3.Connection) -> None:
    cols = {r[1] for r in conn.execute("PRAGMA table_info(processed_files)").fetchall()}
    if "blur_score" not in cols:
        conn.execute("ALTER TABLE processed_files ADD COLUMN blur_score REAL DEFAULT NULL")
    if "exposure_score" not in cols:
        conn.execute("ALTER TABLE processed_files ADD COLUMN exposure_score REAL DEFAULT NULL")
    if "suggested_rotation" not in cols:
        conn.execute("ALTER TABLE processed_files ADD COLUMN suggested_rotation INTEGER DEFAULT NULL")
    if "rotation_reason" not in cols:
        conn.execute("ALTER TABLE processed_files ADD COLUMN rotation_reason TEXT DEFAULT NULL")
    conn.commit()


def run_step_blur_scan(lib: dict):
    db_path = Path(lib["db_path"])
    conn = _open_worker_db(db_path)
    _ensure_suggestion_columns(conn)
    cur = conn.cursor()
    cur.execute("""
        SELECT source_path, dest_path FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0
          AND (blur_score IS NULL OR exposure_score IS NULL) AND dest_path IS NOT NULL
    """)
    to_scan = [
        (r["source_path"], r["dest_path"])
        for r in cur.fetchall()
        if Path(r["dest_path"]).suffix.lower() in sug_ai.SUGGESTION_PHOTO_EXTS
    ]
    total = len(to_scan)
    STATE.log(f"🔎 {total} photo(s) à analyser (netteté & exposition)...")
    STATE._step_start_ts = time.time()
    STATE.update_progress(0, total, unit="photos/s")

    if total > 0:
        batch, done = [], 0
        for src_p, dst_p in to_scan:
            if STATE.stop_requested:
                break
            done += 1
            p = Path(dst_p)
            STATE.log(f"🔎 {p.name} ({done}/{total})")
            if p.exists():
                sc, exp = sug_ai.compute_blur_and_exposure(p)
                if sc is None:
                    STATE.add_failed_file(dst_p, "Image illisible lors du calcul de qualité")
                    sc, exp = -1.0, -1.0
            else:
                STATE.add_failed_file(dst_p, "Fichier introuvable sur le disque")
                sc, exp = -1.0, -1.0
            batch.append((sc, exp, src_p))
            if done % 15 == 0 or done == total:
                STATE.update_progress(done, total, unit="photos/s")
            if len(batch) >= 50:
                conn.executemany("UPDATE processed_files SET blur_score = ?, exposure_score = ? WHERE source_path = ?", batch)
                conn.commit()
                batch.clear()
        if batch:
            conn.executemany("UPDATE processed_files SET blur_score = ?, exposure_score = ? WHERE source_path = ?", batch)
            conn.commit()
    conn.close()


def run_step_rotation_scan(lib: dict):
    db_path = Path(lib["db_path"])
    conn = _open_worker_db(db_path)
    _ensure_suggestion_columns(conn)
    cur = conn.cursor()
    cur.execute("""
        SELECT source_path, dest_path FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND suggested_rotation IS NULL AND dest_path IS NOT NULL
    """)
    to_scan = [
        (r["source_path"], r["dest_path"])
        for r in cur.fetchall()
        if Path(r["dest_path"]).suffix.lower() in sug_ai.SUGGESTION_PHOTO_EXTS
    ]
    total = len(to_scan)
    STATE.log(f"🔄 {total} photo(s) à analyser (orientation / rotation)...")
    STATE._step_start_ts = time.time()
    STATE.update_progress(0, total, unit="photos/s")

    if total > 0:
        batch, done = [], 0
        for src_p, dst_p in to_scan:
            if STATE.stop_requested:
                break
            done += 1
            p = Path(dst_p)
            STATE.log(f"🔄 {p.name} ({done}/{total})")
            if p.exists():
                rot, reason = sug_ai.detect_rotation_suggestion(p)
            else:
                STATE.add_failed_file(dst_p, "Fichier introuvable sur le disque")
                rot, reason = -1, ""
            batch.append((rot, reason or None, src_p))
            if done % 10 == 0 or done == total:
                STATE.update_progress(done, total, unit="photos/s")
            if len(batch) >= 40:
                conn.executemany(
                    "UPDATE processed_files SET suggested_rotation = ?, rotation_reason = ? WHERE source_path = ?",
                    batch,
                )
                conn.commit()
                batch.clear()
        if batch:
            conn.executemany(
                "UPDATE processed_files SET suggested_rotation = ?, rotation_reason = ? WHERE source_path = ?",
                batch,
            )
            conn.commit()
    conn.close()


def run_step_suggestions_scan(lib: dict):
    db_path = Path(lib["db_path"])
    conn = _open_worker_db(db_path)
    _ensure_suggestion_columns(conn)
    cur = conn.cursor()
    cur.execute("""
        SELECT source_path, dest_path, blur_score, exposure_score, suggested_rotation
        FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
          AND (blur_score IS NULL OR exposure_score IS NULL OR suggested_rotation IS NULL)
    """)
    to_scan = [
        dict(r) for r in cur.fetchall()
        if Path(r["dest_path"]).suffix.lower() in sug_ai.SUGGESTION_PHOTO_EXTS
    ]
    total = len(to_scan)
    STATE.log(f"💡 {total} photo(s) à analyser (qualité & rotation)...")
    STATE._step_start_ts = time.time()
    STATE.update_progress(0, total, unit="photos/s")

    if total > 0:
        batch, done = [], 0
        for row in to_scan:
            if STATE.stop_requested:
                break
            done += 1
            dst_p = row["dest_path"]
            p = Path(dst_p)
            STATE.log(f"💡 {p.name} ({done}/{total})")
            blur_val = row["blur_score"]
            exp_val = row["exposure_score"]
            rot_val = row["suggested_rotation"]
            reason_val = None
            if p.exists():
                if blur_val is None or exp_val is None:
                    sc, exp = sug_ai.compute_blur_and_exposure(p)
                    blur_val = sc if sc is not None else -1.0
                    exp_val = exp if exp is not None else -1.0
                if rot_val is None:
                    rot_val, reason_val = sug_ai.detect_rotation_suggestion(p)
            else:
                STATE.add_failed_file(dst_p, "Fichier introuvable sur le disque")
                if blur_val is None:
                    blur_val = -1.0
                if exp_val is None:
                    exp_val = -1.0
                if rot_val is None:
                    rot_val, reason_val = -1, None
            batch.append((blur_val, exp_val, rot_val, reason_val or None, row["source_path"]))
            if done % 10 == 0 or done == total:
                STATE.update_progress(done, total, unit="photos/s")
            if len(batch) >= 40:
                conn.executemany(
                    "UPDATE processed_files SET blur_score = ?, exposure_score = ?, suggested_rotation = ?, rotation_reason = COALESCE(?, rotation_reason) WHERE source_path = ?",
                    batch,
                )
                conn.commit()
                batch.clear()
        if batch:
            conn.executemany(
                "UPDATE processed_files SET blur_score = ?, exposure_score = ?, suggested_rotation = ?, rotation_reason = COALESCE(?, rotation_reason) WHERE source_path = ?",
                batch,
            )
            conn.commit()
    conn.close()


TASK_REGISTRY = {
    "INGEST": ("Decompression en cours...", run_step_ingestion),
    "FACES": ("Analyse des visages en cours...", run_step_faces),
    "OCR": ("Analyse du texte OCR en cours...", run_step_ocr),
    "DEDUP": ("Analyse des doublons en cours...", run_step_deduplication),
    "SIMILAR": ("Analyse des similarités en cours...", run_step_similarity),
    "CLIP": ("Indexation IA CLIP en cours...", run_step_clip),
    "BLUR": ("Analyse de netteté (fichiers flous) en cours...", run_step_blur_scan),
    "ROTATION": ("Analyse d'orientation (rotations) en cours...", run_step_rotation_scan),
    "SUGGESTIONS": ("Analyse des suggestions en cours...", run_step_suggestions_scan),
}


def _worker_single_task_thread(lib: dict, task_code: str):
    STATE.is_running = True
    STATE.stop_requested = False
    STATE.cancel_requested = False
    STATE.library_name = lib["name"]
    STATE.logs.clear()

    db_path = Path(lib["db_path"])
    title, func = TASK_REGISTRY[task_code]
    clean_title = title.replace(" en cours...", "")
    task_start_iso = datetime.now().isoformat(timespec="seconds")
    task_start_ts = time.time()
    try:
        set_system_sleep_inhibit(True)
        STATE.set_task(task_code, title)
        func(lib)
        failed_list = list(STATE.current_failed_files)
        if not STATE.stop_requested:
            STATE.current_step = "Aucune tâche en cours"
            STATE.status_level = "idle"
            STATE.percent = 100.0
            STATE.speed_text = ""
            STATE.eta_text = ""
            STATE.last_paused_task = ""
            STATE.log(f"🎉 Opération terminée : {title}")
            if not (task_code == "INGEST" and STATE._ingestion_recorded):
                succ = max(0, int(STATE.processed_items) - len(failed_list))
                _record_step_activity(
                    db_path, lib["name"], task_code, clean_title,
                    task_start_ts, task_start_iso,
                    int(STATE.total_items), succ, failed_list,
                )
        elif STATE.cancel_requested:
            STATE.current_step = "Tâche arrêtée"
            STATE.status_level = "stopped"
            STATE.percent = 0.0
            STATE.speed_text = ""
            STATE.eta_text = ""
            STATE.last_paused_task = ""
            STATE.log("⏹ Tâche arrêtée complètement.")
            if not (task_code == "INGEST" and STATE._ingestion_recorded):
                _record_step_activity(
                    db_path, lib["name"], task_code, clean_title,
                    task_start_ts, task_start_iso,
                    int(STATE.total_items), int(STATE.processed_items), failed_list,
                    stopped=True, cancelled=True,
                )
        else:
            STATE.current_step = f"En pause : {STATE.current_step}"
            STATE.status_level = "paused"
            STATE.last_paused_task = task_code
            STATE.log("⏸️ Opération mise en pause. Reprise exacte disponible.")
            if not (task_code == "INGEST" and STATE._ingestion_recorded):
                _record_step_activity(
                    db_path, lib["name"], task_code, clean_title,
                    task_start_ts, task_start_iso,
                    int(STATE.total_items), int(STATE.processed_items), failed_list,
                    stopped=True, cancelled=False,
                )
    except Exception as e:
        err_msg = translate_runtime_error(e)
        STATE.current_step = f"Erreur : {err_msg}"
        STATE.status_level = "error"
        STATE.last_paused_task = task_code
        STATE.log(f"❌ Erreur critique : {err_msg}")
        _record_step_activity(
            db_path, lib["name"], task_code, clean_title,
            task_start_ts, task_start_iso,
            int(STATE.total_items), int(STATE.processed_items), list(STATE.current_failed_files),
            error_reason=err_msg,
        )
    finally:
        set_system_sleep_inhibit(False)
        STATE.is_running = False
        STATE.active_task = "IDLE"


_TASK_NOTHING_TO_DO_MSGS = {
    "DEDUP": "Aucune analyse nécessaire : tous vos médias ont déjà été vérifiés pour les doublons (aucun nouveau fichier).",
    "SIMILAR": "Aucune analyse nécessaire : toutes vos photos et vidéos ont déjà été analysées pour les similarités (aucun nouveau fichier).",
    "FACES": "Aucune analyse nécessaire : tous vos médias ont déjà été scannés pour les visages (aucun nouveau fichier).",
    "OCR": "Aucune analyse nécessaire : le texte de tous vos médias a déjà été analysé (aucun nouveau fichier).",
    "CLIP": "Aucune analyse nécessaire : tous vos médias ont déjà été indexés par l'IA (aucun nouveau fichier).",
    "BLUR": "Aucune analyse nécessaire : la netteté de toutes vos photos a déjà été analysée (aucun nouveau fichier).",
    "ROTATION": "Aucune analyse nécessaire : l'orientation de toutes vos photos a déjà été vérifiée (aucun nouveau fichier).",
    "SUGGESTIONS": "Aucune analyse nécessaire : toutes vos photos ont déjà été analysées pour les suggestions (aucun nouveau fichier).",
}

_TASK_SCAN_COLUMN = {
    "FACES": "faces_scanned",
    "OCR": "ocr_scanned",
    "CLIP": "clip_scanned",
}


def _count_pending_items_for_task(lib: dict, task_code: str) -> tuple[int, str]:
    """Retourne (nb_elements_a_traiter, message_si_aucun) sans modifier la base ni lancer de thread."""
    db_path = Path(lib["db_path"])
    if not db_path.exists():
        return 0, "Aucune analyse nécessaire : aucun média importé dans votre bibliothèque pour le moment."

    conn = _open_worker_db(db_path)
    try:
        cur = conn.cursor()
        has_table = cur.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='processed_files'"
        ).fetchone()
        if not has_table:
            return 0, "Aucune analyse nécessaire : aucun média importé dans votre bibliothèque pour le moment."

        total_rows = int(cur.execute(
            "SELECT COUNT(*) FROM processed_files WHERE status NOT IN ('error', 'trashed') AND dest_path IS NOT NULL"
        ).fetchone()[0] or 0)
        if total_rows == 0:
            return 0, "Aucune analyse nécessaire : aucun média importé dans votre bibliothèque pour le moment."

        cols = {r[1] for r in cur.execute("PRAGMA table_info(processed_files)")}
        empty_msg = _TASK_NOTHING_TO_DO_MSGS.get(
            task_code, "Aucune analyse nécessaire : tous vos médias sont déjà à jour."
        )

        if task_code in ("DEDUP", "SIMILAR"):
            if "blake3_hash" in cols:
                cur.execute(
                    "SELECT COUNT(*) FROM processed_files WHERE status NOT IN ('error', 'trashed') AND blake3_hash IS NULL AND dest_path IS NOT NULL"
                )
                pending = int(cur.fetchone()[0] or 0)
            else:
                pending = total_rows
            if task_code == "SIMILAR":
                vid_where = "is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL"
                if "video_hash" in cols:
                    vid_where += " AND video_hash IS NULL"
                cur.execute(f"SELECT dest_path FROM processed_files WHERE {vid_where}")
                pending += sum(1 for r in cur.fetchall() if Path(r[0]).suffix.lower() in VIDEO_EXTS)
            return pending, empty_msg

        scan_col = _TASK_SCAN_COLUMN.get(task_code)
        if scan_col:
            where_sql = "is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL"
            if scan_col in cols:
                where_sql += f" AND {scan_col} = 0"
            cur.execute(f"SELECT dest_path FROM processed_files WHERE {where_sql}")
            pending = sum(1 for r in cur.fetchall() if Path(r[0]).suffix.lower() in ALL_MEDIA_EXTS)
            return pending, empty_msg

        if task_code == "BLUR":
            where_sql = "is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL"
            if "blur_score" in cols and "exposure_score" in cols:
                where_sql += " AND (blur_score IS NULL OR exposure_score IS NULL)"
            cur.execute(f"SELECT dest_path FROM processed_files WHERE {where_sql}")
            pending = sum(1 for r in cur.fetchall() if Path(r[0]).suffix.lower() in sug_ai.SUGGESTION_PHOTO_EXTS)
            return pending, empty_msg

        if task_code == "ROTATION":
            where_sql = "is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL"
            if "suggested_rotation" in cols:
                where_sql += " AND suggested_rotation IS NULL"
            cur.execute(f"SELECT dest_path FROM processed_files WHERE {where_sql}")
            pending = sum(1 for r in cur.fetchall() if Path(r[0]).suffix.lower() in sug_ai.SUGGESTION_PHOTO_EXTS)
            return pending, empty_msg

        if task_code == "SUGGESTIONS":
            where_sql = "is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL"
            if "blur_score" in cols and "exposure_score" in cols and "suggested_rotation" in cols:
                where_sql += " AND (blur_score IS NULL OR exposure_score IS NULL OR suggested_rotation IS NULL)"
            cur.execute(f"SELECT dest_path FROM processed_files WHERE {where_sql}")
            pending = sum(1 for r in cur.fetchall() if Path(r[0]).suffix.lower() in sug_ai.SUGGESTION_PHOTO_EXTS)
            return pending, empty_msg

        return 1, empty_msg
    finally:
        conn.close()


def start_specific_task(task_code: str = "INGEST") -> dict:
    if STATE.is_running:
        return {"status": "already_running", "active_task": STATE.active_task}
    if task_code not in TASK_REGISTRY:
        raise ValueError(f"Outil inconnu : {task_code}")
    cfg = load_libraries()
    active_name = cfg.get("active_library")
    if not active_name or active_name not in cfg.get("libraries", {}):
        raise ValueError("Ajoutez d'abord un dossier ou un import Google Takeout.")
    lib = cfg["libraries"][active_name]
    if task_code in _TASK_NOTHING_TO_DO_MSGS:
        pending, msg = _count_pending_items_for_task(lib, task_code)
        if pending == 0:
            return {"status": "nothing_to_do", "task": task_code, "message": msg}
    threading.Thread(target=_worker_single_task_thread, args=(lib, task_code), daemon=True).start()
    return {"status": "started", "task": task_code, "library": active_name}


def start_pipeline_for_active_library() -> dict:
    return start_specific_task("INGEST")


def request_stop_pipeline(cancel: bool = False) -> dict:
    if STATE.is_running:
        STATE.stop_requested = True
        STATE.cancel_requested = cancel
        return {"status": "stopping"}
    if cancel:
        STATE.last_paused_task = ""
        STATE.current_step = "Aucune tâche en cours"
        STATE.status_level = "stopped"
        STATE.missing_meta_files.clear()
    return {"status": "not_running"}


_STARTUP_RESUMABLE_TYPES = {"INGEST", "UNZIP", "IMPORT", "METADATA", "FACES", "OCR", "DEDUP", "SIMILAR", "CLIP", "BLUR", "ROTATION", "SUGGESTIONS"}


def record_interrupted_active_task() -> None:
    """Persist an interrupted entry when quitting/restarting abruptly while a task is running."""
    if not STATE.is_running or STATE.active_task in ("", "IDLE"):
        return
    try:
        db_p, _ = get_active_db_and_dest()
        if not db_p.exists():
            return
        cfg = load_libraries()
        lib_name = STATE.library_name or str(cfg.get("active_library") or "")
        act_type = STATE.active_task
        title = STATE.current_step or f"Opération ({act_type})"
        proc = int(getattr(STATE, "processed_items", 0) or 0)
        tot = int(getattr(STATE, "total_items", 0) or 0)
        start_ts = float(getattr(STATE, "_step_start_ts", time.time()) or time.time())
        dur_sec = max(0.0, time.time() - start_ts)
        reason = "Activité interrompue avant l'arrêt du programme"
        record_activity_entry(
            db_p,
            library_name=lib_name,
            action_type=act_type,
            title=title,
            status="paused",
            detail=f"{reason} ({proc}/{tot} élément(s)) · {_format_duration_fr(dur_sec)}",
            reason=reason,
            duration_sec=dur_sec,
            total_items=tot,
            success_count=proc,
            failed_files=list(STATE.current_failed_files),
        )
    except Exception:
        pass


def seed_startup_resume_notifications() -> int:
    """Add startup notifications suggesting resume for tasks paused or interrupted before exit."""
    try:
        entries = list_activity_entries(limit=50)
    except Exception:
        return 0

    seen_sigs: set[tuple[str, str, str]] = set()
    to_notify: list[dict] = []
    for e in entries:
        act_type = str(e.get("action_type") or "").upper()
        if act_type not in _STARTUP_RESUMABLE_TYPES:
            continue
        sig = (act_type, str(e.get("title") or ""), str(e.get("library_name") or ""))
        if sig in seen_sigs:
            continue
        seen_sigs.add(sig)
        reason_lower = str(e.get("reason") or "").lower()
        if e.get("status") == "paused" and "arrêtée" not in reason_lower:
            to_notify.append(e)

    with STATE._lock:
        already_ids = {
            int(n["action_activity_id"])
            for n in STATE.notifications
            if n.get("action_activity_id") is not None
        }

    added = 0
    for item in reversed(to_notify):
        aid = int(item.get("activity_id") or 0)
        if not aid or aid in already_ids:
            continue
        already_ids.add(aid)
        reason_lower = str(item.get("reason") or "").lower()
        is_interrupted = "interrompue" in reason_lower
        proc = int(item.get("success_count") or 0)
        tot = int(item.get("total_items") or 0)
        progress_hint = f" ({proc}/{tot} traité(s))" if tot > 0 else ""
        notif_title = (
            f"Activité interrompue : {item.get('title') or 'Opération'}"
            if is_interrupted
            else f"Activité en pause : {item.get('title') or 'Opération'}"
        )
        notif_detail = (
            f"Interrompue avant l'arrêt précédent{progress_hint}. Cliquez sur Reprendre pour continuer."
            if is_interrupted
            else f"Mise en pause avant l'arrêt précédent{progress_hint}. Cliquez sur Reprendre pour continuer."
        )
        STATE.add_notification(
            notif_title,
            "partial" if is_interrupted else "paused",
            notif_detail,
            action_activity_id=aid,
            action_label="Reprendre",
        )
        added += 1
    return added


_IGNORED_SOURCE_SCAN_DIRS = {
    "Phototo",
    "Corbeille",
    "Miniatures_Cache",
    "_Temp_Takeout_Buffer",
    "Doublons_Quarantaine",
    ".phototo_data",
}


def _norm_path_key(raw_path: str | Path) -> str:
    p = Path(raw_path)
    try:
        return os.path.normcase(str(p.resolve()))
    except OSError:
        return os.path.normcase(str(p))


def detect_unadded_source_files() -> dict:
    """Count media files or Takeout ZIPs present in source folders but missing from the library database."""
    try:
        cfg = load_libraries()
    except Exception:
        return {"new_count": 0, "kind": "media", "library": ""}

    active_name = str(cfg.get("active_library") or "")
    libs = cfg.get("libraries", {})
    if not active_name or active_name not in libs:
        return {"new_count": 0, "kind": "media", "library": ""}

    lib = libs[active_name]
    src_type = str(lib.get("source_type") or "STANDARD_FOLDER")
    src_paths = [str(p).strip() for p in (lib.get("source_paths") or []) if str(p).strip()]
    db_path = Path(str(lib.get("db_path") or ""))
    if not db_path.exists():
        return {"new_count": 0, "kind": "media", "library": active_name}

    if src_type == "TAKEOUT_ZIPS":
        all_zips = collect_zip_files(src_paths)
        if not all_zips:
            return {"new_count": 0, "kind": "zips", "library": active_name}
        known_zips: set[str] = set()
        conn = sqlite3.connect(db_path, timeout=10.0)
        try:
            for row in conn.execute("SELECT zip_path, status FROM extracted_zips"):
                if row[1] in ("EXTRACTED", "DONE") and row[0]:
                    known_zips.add(_norm_path_key(row[0]))
        except Exception:
            pass
        finally:
            conn.close()
        pending_cnt = sum(1 for zp in all_zips if _norm_path_key(zp) not in known_zips)
        return {"new_count": pending_cnt, "kind": "zips", "library": active_name}

    extra_folders = []
    if src_type == "STANDARD_FOLDER":
        try:
            extra_folders = [str(p).strip() for p in (load_settings().get("scanned_folders") or []) if str(p).strip()]
        except Exception:
            extra_folders = []
    all_roots = list(dict.fromkeys([*src_paths, *extra_folders]))
    if not all_roots:
        return {"new_count": 0, "kind": "media", "library": active_name}

    known_media: set[str] = set()
    conn = sqlite3.connect(db_path, timeout=10.0)
    try:
        for row in conn.execute("SELECT source_path, dest_path FROM processed_files"):
            if row[0]:
                known_media.add(_norm_path_key(row[0]))
            if row[1]:
                known_media.add(_norm_path_key(row[1]))
    except Exception:
        pass
    finally:
        conn.close()

    new_count = 0
    visited_files: set[str] = set()
    for root_str in all_roots:
        rp = Path(root_str)
        if not rp.exists() or not rp.is_dir():
            continue
        stack = [rp]
        while stack:
            cur_dir = stack.pop()
            try:
                with os.scandir(cur_dir) as it:
                    for entry in it:
                        try:
                            if entry.is_dir(follow_symlinks=False):
                                if entry.name not in _IGNORED_SOURCE_SCAN_DIRS:
                                    stack.append(Path(entry.path))
                            elif entry.is_file(follow_symlinks=False):
                                ext = os.path.splitext(entry.name)[1].lower()
                                if ext not in ALL_MEDIA_EXTS:
                                    continue
                                f_key = _norm_path_key(entry.path)
                                if f_key in visited_files or f_key in known_media:
                                    continue
                                visited_files.add(f_key)
                                new_count += 1
                        except OSError:
                            continue
            except OSError:
                continue

    return {"new_count": new_count, "kind": "media", "library": active_name}


def notify_unadded_source_files(force: bool = False) -> int:
    """Emit a notification suggesting 'Analyser' when new unimported files are found in source folders."""
    if STATE.is_running:
        return 0
    info = detect_unadded_source_files()
    new_cnt = int(info.get("new_count") or 0)
    kind = str(info.get("kind") or "media")
    lib_name = str(info.get("library") or "")

    if new_cnt <= 0:
        with STATE._lock:
            STATE._last_new_files_sig = None
            STATE.notifications = [n for n in STATE.notifications if n.get("action_task") != "INGEST"]
        return 0

    sig = (lib_name, kind, new_cnt)
    with STATE._lock:
        if not force and STATE._last_new_files_sig == sig:
            return 0
        STATE._last_new_files_sig = sig
        STATE.notifications = [n for n in STATE.notifications if n.get("action_task") != "INGEST"]

    detail = (
        f"{new_cnt} nouvelle(s) archive(s) ZIP non importée(s) détectée(s) dans vos sources."
        if kind == "zips"
        else f"{new_cnt} nouveau(x) média(s) détecté(s) dans vos dossiers sources qui n'ont pas été ajoutés par l'application."
    )
    STATE.add_notification(
        title=f"Nouveaux fichiers détectés ({new_cnt})",
        status="partial",
        detail=detail,
        action_task="INGEST",
        action_label="Analyser",
    )
    return new_cnt


def check_source_files_on_startup_async() -> None:
    """Run a single non-blocking check for unimported source files at application startup."""
    def _once():
        try:
            notify_unadded_source_files()
        except Exception:
            pass

    threading.Thread(target=_once, daemon=True).start()