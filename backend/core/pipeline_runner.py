import os
import time
import shutil
import zipfile
import sqlite3
import threading
import concurrent.futures
from pathlib import Path
from datetime import datetime
from concurrent.futures import ProcessPoolExecutor

from library_manager import load_libraries, collect_zip_files, get_takeout_buffer_dir
from settings_manager import load_settings, get_hardware_runtime_config
from media_frames import ALL_MEDIA_EXTS, VIDEO_EXTS, extract_analysis_frames
import fusion_takeout_complet as fusion
import deduplicateur as dedup
import indexeur_visages as faces_ai
import indexeur_ocr as ocr_ai
import indexeur_similaires as sim_ai
import indexeur_semantique_gps as clip_gps_ai

MAX_PARALLEL_ZIPS = min(4, os.cpu_count() or 4)


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
        self.library_name: str = ""
        self.current_step: str = "Aucune tâche en cours"
        self.processed_items: int = 0
        self.total_items: int = 0
        self.percent: float = 0.0
        self.speed_text: str = ""
        self.eta_text: str = ""
        self.logs: list[str] = []
        self.missing_meta_files: list[str] = []
        self.notifications: list[dict] = []
        self._step_start_ts: float = time.time()
        self._lock = threading.Lock()

    def log(self, message: str):
        ts = datetime.now().strftime("%H:%M:%S")
        with self._lock:
            self.logs.append(f"[{ts}] {message}")
            if len(self.logs) > 100:
                self.logs.pop(0)

    def add_missing_meta_file(self, path_str: str):
        with self._lock:
            clean_p = path_str.replace("\\", "/")
            if clean_p not in self.missing_meta_files and len(self.missing_meta_files) < 200:
                self.missing_meta_files.append(clean_p)

    def add_notification(self, title: str, status: str, detail: str = ""):
        ts = datetime.now().strftime("%H:%M")
        with self._lock:
            self.notifications.insert(0, {
                "id": int(time.time() * 1000),
                "time": ts,
                "title": title,
                "status": status,  # 'success' | 'error' | 'paused'
                "detail": detail,
                "read": False
            })
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
            self.current_step = title
            self.processed_items = 0
            self.total_items = 0
            self.percent = 0.0
            self.speed_text = ""
            self.eta_text = ""
            self._step_start_ts = time.time()
        self.log(f"▶ Démarrage : {title}")

    def to_dict(self) -> dict:
        with self._lock:
            return {
                "is_running": self.is_running,
                "stop_requested": self.stop_requested,
                "active_task": self.active_task,
                "last_paused_task": self.last_paused_task,
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

                clean_rel = member.filename.replace("\xa0", " ")
                target_path = buffer_dir / clean_rel

                if target_path.exists() and target_path.stat().st_size == member.file_size:
                    extracted_files += 1
                    progress_cb(member.file_size, 1)
                    continue

                target_path.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(member, 'r') as src_f, open(target_path, 'wb') as dst_f:
                    shutil.copyfileobj(src_f, dst_f, length=1048576)

                extracted_files += 1
                progress_cb(member.file_size, 1)

        return (zpath, True, extracted_files, "OK")
    except Exception as e:
        return (zpath, False, extracted_files, str(e))


def run_step_ingestion(lib: dict):
    src_type = lib["source_type"]
    db_path = Path(lib["db_path"])
    dest_dir = Path(lib["dest_dir"])
    fix_meta = lib["options"].get("fix_takeout_json_metadata", True)
    is_takeout = lib.get("is_takeout", False) and fix_meta
    organize = lib["options"].get("organize_by_year_month", True)

    STATE.missing_meta_files.clear()
    conn = fusion.init_db(db_path)
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

            def _on_member_extracted(b_size: int, f_count: int):
                nonlocal done_bytes, done_members, last_log_t
                with lock:
                    done_bytes += b_size
                    done_members += f_count
                    elapsed = max(0.001, time.time() - start_zip_t)
                    mb_s = (done_bytes / (1024 * 1024)) / elapsed
                    speed_str = f"{mb_s:.0f} Mo/s"
                    STATE.update_progress(done_members, max(1, total_zip_members), custom_speed=speed_str)
                    if time.time() - last_log_t >= 4.0:
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
                    elif msg == "PAUSED":
                        STATE.log(f"⏸️ Pause sur {zpath.name}.")

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
        STATE.current_step = "Correction des metadonnées..." if is_takeout else "Importation des fichiers..."
        STATE.log(f"🔧 {total_m} média(s) à traiter...")
        STATE._step_start_ts = time.time()
        STATE.update_progress(0, total_m, unit="fich./s")

        batch, errors, done = [], 0, 0
        with ProcessPoolExecutor(
            max_workers=fusion.MAX_WORKERS,
            initializer=fusion.init_worker,
            initargs=(str(dest_dir), is_takeout, organize)
        ) as executor:
            for res in executor.map(fusion.process_single_file, all_media, chunksize=20):
                if STATE.stop_requested:
                    break
                done += 1
                if done % 15 == 0 or done == total_m:
                    STATE.update_progress(done, total_m, unit="fich./s")
                if res[3] in ("error", "no_metadata"):
                    if res[3] == "error":
                        errors += 1
                    STATE.add_missing_meta_file(res[1] or res[0])
                batch.append(res)
                if len(batch) >= 120:
                    fusion.save_batch_to_db(conn, batch)
                    batch.clear()

        if batch:
            fusion.save_batch_to_db(conn, batch)

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
    STATE.current_step = "Correction des metadonnées..." if is_takeout else "Importation des fichiers..."
    STATE._step_start_ts = time.time()
    STATE.update_progress(0, total, unit="fich./s")
    if total == 0:
        conn.close()
        return

    batch, done = [], 0
    with ProcessPoolExecutor(
        max_workers=fusion.MAX_WORKERS,
        initializer=fusion.init_worker,
        initargs=(str(dest_dir), is_takeout, organize)
    ) as executor:
        for res in executor.map(fusion.process_single_file, remaining, chunksize=20):
            if STATE.stop_requested:
                break
            done += 1
            if done % 15 == 0 or done == total:
                STATE.update_progress(done, total, unit="fich./s")
            if res[3] in ("error", "no_metadata"):
                STATE.add_missing_meta_file(res[1] or res[0])
            batch.append(res)
            if len(batch) >= 150:
                fusion.save_batch_to_db(conn, batch)
                batch.clear()

    if batch:
        fusion.save_batch_to_db(conn, batch)
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
    dedup.QUARANTINE_DIR = dest_dir / "Doublons_Quarantaine"

    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    dedup.upgrade_db(conn)
    cur = conn.cursor()

    cur.execute("""
        SELECT source_path, dest_path FROM processed_files
        WHERE status NOT IN ('error', 'trashed') AND blake3_hash IS NULL AND dest_path IS NOT NULL
    """)
    to_hash = [(r["source_path"], r["dest_path"], True) for r in cur.fetchall()]
    total = len(to_hash)
    STATE._step_start_ts = time.time()
    STATE.update_progress(0, total, unit="fich./s")

    if total > 0:
        batch, done = [], 0
        with ProcessPoolExecutor(max_workers=dedup.MAX_WORKERS) as executor:
            for res in executor.map(dedup.compute_file_signatures, to_hash, chunksize=25):
                if STATE.stop_requested:
                    break
                done += 1
                if done % 15 == 0 or done == total:
                    STATE.update_progress(done, total, unit="fich./s")
                src, fsize, b3, ph, w, h = res
                if b3:
                    batch.append((fsize, b3, ph, w, h, src))
                if len(batch) >= 100:
                    conn.executemany("UPDATE processed_files SET file_size=?, blake3_hash=?, phash=?, width=?, height=? WHERE source_path=?", batch)
                    conn.commit()
                    batch.clear()
                    _group_exact_duplicates_now(conn)
        if batch:
            conn.executemany("UPDATE processed_files SET file_size=?, blake3_hash=?, phash=?, width=?, height=? WHERE source_path=?", batch)
            conn.commit()

    _group_exact_duplicates_now(conn)
    conn.close()


def run_step_similarity(lib: dict):
    run_step_deduplication(lib)
    if STATE.stop_requested:
        return

    db_path = Path(lib["db_path"])
    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    sim_ai.upgrade_db_for_video_similarity(conn)
    cur = conn.cursor()
    cur.execute("SELECT source_path, dest_path FROM processed_files WHERE is_duplicate = 0 AND is_trashed = 0 AND video_hash IS NULL AND dest_path IS NOT NULL")
    videos = [r for r in cur.fetchall() if Path(r["dest_path"]).suffix.lower() in VIDEO_EXTS]
    total = len(videos)
    STATE._step_start_ts = time.time()
    STATE.update_progress(0, total, unit="vidéos/s")

    if total > 0:
        batch, done = [], 0
        for r in videos:
            if STATE.stop_requested:
                break
            done += 1
            STATE.update_progress(done, total, unit="vidéos/s")
            vpath = Path(r["dest_path"])
            if vpath.exists():
                vhash, dur = sim_ai.compute_video_fingerprint(vpath)
                batch.append((vhash or "NONE", dur, r["source_path"]))
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
    faces_ai.THUMBS_DIR = dest_dir / "Miniatures_Visages"

    conn = sqlite3.connect(db_path, timeout=30.0)
    faces_ai.init_face_tables(conn)
    cur = conn.cursor()
    cur.execute("""
        SELECT source_path, dest_path, timestamp FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND faces_scanned = 0 AND dest_path IS NOT NULL
    """)
    to_scan = [r for r in cur.fetchall() if Path(r[1]).suffix.lower() in ALL_MEDIA_EXTS]
    total = len(to_scan)
    STATE._step_start_ts = time.time()
    STATE.update_progress(0, total, unit="médias/s")

    if total > 0:
        from insightface.app import FaceAnalysis
        import numpy as np
        hw = get_hardware_runtime_config()
        app = FaceAnalysis(name="buffalo_l", allowed_modules=['detection', 'recognition'], providers=hw["onnx_providers"])
        app.prepare(ctx_id=hw["onnx_ctx_id"], det_size=faces_ai.DET_SIZE)

        faces_batch, scanned_batch, done = [], [], 0
        for src_path, dest_path, ts in to_scan:
            if STATE.stop_requested:
                break
            done += 1
            STATE.update_progress(done, total, unit="médias/s")
            frames = extract_analysis_frames(dest_path)
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

            scanned_batch.append((src_path,))
            if len(scanned_batch) >= 25:
                if faces_batch:
                    cur.executemany("INSERT INTO faces (source_path, dest_path, timestamp, bbox, det_score, embedding, thumb_path) VALUES (?,?,?,?,?,?,?)", faces_batch)
                    faces_batch.clear()
                cur.executemany("UPDATE processed_files SET faces_scanned = 1 WHERE source_path = ?", scanned_batch)
                conn.commit()
                scanned_batch.clear()
                _assign_unclustered_faces_incremental(conn)

        if faces_batch:
            cur.executemany("INSERT INTO faces (source_path, dest_path, timestamp, bbox, det_score, embedding, thumb_path) VALUES (?,?,?,?,?,?,?)", faces_batch)
        if scanned_batch:
            cur.executemany("UPDATE processed_files SET faces_scanned = 1 WHERE source_path = ?", scanned_batch)
        conn.commit()

    _assign_unclustered_faces_incremental(conn)
    if not STATE.stop_requested:
        faces_ai.run_face_clustering(conn)
    conn.close()


def run_step_ocr(lib: dict):
    db_path = Path(lib["db_path"])
    conn = sqlite3.connect(db_path, timeout=30.0)
    ocr_ai.init_ocr_tables(conn)
    cur = conn.cursor()
    cur.execute("""
        SELECT source_path, dest_path, timestamp FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND ocr_scanned = 0 AND dest_path IS NOT NULL
    """)
    to_scan = [r for r in cur.fetchall() if Path(r[1]).suffix.lower() in ALL_MEDIA_EXTS]
    total = len(to_scan)
    STATE._step_start_ts = time.time()
    STATE.update_progress(0, total, unit="médias/s")

    if total > 0:
        from paddleocr import PaddleOCR
        hw = get_hardware_runtime_config()
        lang_cfg = load_settings().get("language", "fr")
        ocr_engine = PaddleOCR(
            use_angle_cls=True, lang=lang_cfg,
            use_gpu=hw["paddle_use_gpu"], enable_mkldnn=hw["paddle_enable_mkldnn"], show_log=False
        )
        ocr_batch, fts_batch, scanned_batch, done = [], [], [], 0

        for src_path, dest_path, ts in to_scan:
            if STATE.stop_requested:
                break
            done += 1
            STATE.update_progress(done, total, unit="médias/s")
            frames = extract_analysis_frames(dest_path, max_dim=ocr_ai.MAX_IMG_DIM)
            unique_lines, seen_lower, scores = [], set(), []
            for img in frames:
                try:
                    res = ocr_engine.ocr(img, cls=True)
                except Exception:
                    res = None
                if res and res[0]:
                    for line in res[0]:
                        txt, conf = line[1][0].strip(), float(line[1][1])
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
            if len(scanned_batch) >= 40:
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
    conn = sqlite3.connect(db_path, timeout=30.0)
    clip_gps_ai.upgrade_db_for_clip_and_gps(conn)
    cur = conn.cursor()
    cur.execute("""
        SELECT source_path, dest_path FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND clip_scanned = 0 AND dest_path IS NOT NULL
    """)
    to_scan = [r for r in cur.fetchall() if Path(r[1]).suffix.lower() in ALL_MEDIA_EXTS]
    total = len(to_scan)
    STATE._step_start_ts = time.time()
    STATE.update_progress(0, total, unit="médias/s")

    if total > 0:
        vision_model, _ = clip_gps_ai.get_clip_models()
        done = 0
        for i in range(0, total, 24):
            if STATE.stop_requested:
                break
            batch_rows = to_scan[i:i + 24]
            flat_imgs, slices, failed = [], [], []
            for src_s, dest_s in batch_rows:
                frames = extract_analysis_frames(dest_s, max_dim=512)
                if not frames:
                    failed.append((src_s,))
                    continue
                s_idx = len(flat_imgs)
                for f_bgr in frames:
                    flat_imgs.append(Image.fromarray(cv2.cvtColor(f_bgr, cv2.COLOR_BGR2RGB)))
                slices.append((src_s, s_idx, len(flat_imgs)))

            updates = []
            if flat_imgs:
                embs = vision_model.encode(flat_imgs, batch_size=32, normalize_embeddings=True, show_progress_bar=False)
                for src_s, s_i, e_i in slices:
                    m_emb = np.mean(embs[s_i:e_i], axis=0)
                    norm = np.linalg.norm(m_emb)
                    if norm > 0:
                        m_emb = m_emb / norm
                    updates.append((m_emb.astype(np.float16).tobytes(), 1, src_s))

            if updates:
                cur.executemany("UPDATE processed_files SET clip_embedding=?, clip_scanned=? WHERE source_path=?", updates)
            if failed:
                cur.executemany("UPDATE processed_files SET clip_scanned=1 WHERE source_path=?", failed)
            conn.commit()
            done += len(batch_rows)
            STATE.update_progress(done, total, unit="médias/s")
    conn.close()


TASK_REGISTRY = {
    "INGEST": ("Decompression en cours...", run_step_ingestion),
    "FACES": ("Analyse des visages en cours...", run_step_faces),
    "OCR": ("Analyse du texte OCR en cours...", run_step_ocr),
    "DEDUP": ("Analyse des doublons en cours...", run_step_deduplication),
    "SIMILAR": ("Analyse des similarités en cours...", run_step_similarity),
    "CLIP": ("Indexation IA CLIP en cours...", run_step_clip),
}


def _worker_single_task_thread(lib: dict, task_code: str):
    STATE.is_running = True
    STATE.stop_requested = False
    STATE.cancel_requested = False
    STATE.library_name = lib["name"]
    STATE.logs.clear()

    title, func = TASK_REGISTRY[task_code]
    clean_title = title.replace(" en cours...", "")
    try:
        STATE.set_task(task_code, title)
        func(lib)
        if not STATE.stop_requested:
            STATE.current_step = "Aucune tâche en cours"
            STATE.percent = 100.0
            STATE.speed_text = ""
            STATE.eta_text = ""
            STATE.last_paused_task = ""
            STATE.log(f"🎉 Opération terminée : {title}")
            STATE.add_notification(clean_title, "success", f"Terminé avec succès ({STATE.processed_items} éléments)")
        elif STATE.cancel_requested:
            STATE.current_step = "Aucune tâche en cours"
            STATE.percent = 0.0
            STATE.speed_text = ""
            STATE.eta_text = ""
            STATE.last_paused_task = ""
            STATE.log("⏹ Tâche arrêtée complètement.")
            STATE.add_notification(clean_title, "paused", "Tâche arrêtée par l'utilisateur")
        else:
            STATE.current_step = f"En pause : {STATE.current_step}"
            STATE.last_paused_task = task_code
            STATE.log("⏸️ Opération mise en pause. Reprise exacte disponible.")
            STATE.add_notification(clean_title, "paused", f"Mis en pause à {STATE.percent}%")
    except Exception as e:
        STATE.current_step = f"Erreur : {e}"
        STATE.last_paused_task = task_code
        STATE.log(f"❌ Erreur critique : {e}")
        STATE.add_notification(clean_title, "error", f"Échec : {e}")
    finally:
        STATE.is_running = False
        STATE.active_task = "IDLE"


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
        STATE.missing_meta_files.clear()
    return {"status": "not_running"}