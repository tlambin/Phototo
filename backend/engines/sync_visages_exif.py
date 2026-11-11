import os
import sqlite3
import atexit
from pathlib import Path
from concurrent.futures import ProcessPoolExecutor
from PIL import Image
import exiftool
from media_frames import VIDEO_EXTS

DB_PATH = Path("progression_takeout.db")
DEST_DIR = Path("./Photos_Triees")
CREATE_PERSON_FOLDERS = True
MAX_WORKERS = min(8, os.cpu_count() or 4)
worker_et = None


def init_worker():
    global worker_et
    worker_et = exiftool.ExifToolHelper()
    worker_et.run()
    atexit.register(worker_et.terminate)


def build_mwg_region_struct(img_w: int, img_h: int, faces_info: list[dict]) -> str:
    region_items = []
    for f in faces_info:
        name = f["name"].replace(",", " ").replace("}", "").replace("{", "")
        x1, y1, x2, y2 = [int(v) for v in f["bbox"].split(",")]
        bw, bh = max(1, x2 - x1), max(1, y2 - y1)
        cx, cy = (x1 + bw / 2.0) / img_w, (y1 + bh / 2.0) / img_h
        nw, nh = bw / float(img_w), bh / float(img_h)
        region_items.append(
            f"{{Name={name},Type=Face,Area={{X={cx:.4f},Y={cy:.4f},W={nw:.4f},H={nh:.4f},Unit=normalized}}}}"
        )
    return f"{{AppliedToDimensions={{W={img_w},H={img_h},Unit=pixel}},RegionList=[{','.join(region_items)}]}}"


def sync_single_media(task: tuple) -> tuple[str, list[tuple[str, int]], str | None]:
    global worker_et
    dest_path_str, timestamp, width, height, faces_info, dest_root_str = task
    media_path = Path(dest_path_str)
    if not media_path.exists():
        return (dest_path_str, [], "Fichier introuvable")

    try:
        is_video = media_path.suffix.lower() in VIDEO_EXTS
        if not width or not height:
            if not is_video:
                with Image.open(media_path) as im:
                    width, height = im.size
            else:
                import cv2
                cap = cv2.VideoCapture(str(media_path))
                if cap.isOpened():
                    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
                    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
                    cap.release()

        unique_names = sorted({f["name"] for f in faces_info})
        params = ["-overwrite_original", "-P", "-q", "-api", "QuickTimeUTC=0", "-XMP-iptcExt:PersonInImage="]
        for name in unique_names:
            params.extend([f"-XMP-iptcExt:PersonInImage+={name}", f"-XMP-dc:Subject-={name}", f"-XMP-dc:Subject+={name}"])
            if is_video:
                params.append(f"-QuickTime:Keywords+={name}")
            else:
                params.extend([f"-IPTC:Keywords-={name}", f"-IPTC:Keywords+={name}"])

        if width and height:
            params.append(f"-XMP-mwg-rs:RegionInfo={build_mwg_region_struct(width, height, faces_info)}")

        worker_et.execute(*params, str(media_path))
        if timestamp:
            os.utime(media_path, (timestamp, timestamp))

        if CREATE_PERSON_FOLDERS:
            for name in unique_names:
                person_dir = Path(dest_root_str) / "Personnes" / name
                person_dir.mkdir(parents=True, exist_ok=True)
                link_path = person_dir / media_path.name
                if not link_path.exists():
                    try:
                        os.link(media_path, link_path)
                    except Exception:
                        pass

        return (dest_path_str, [(f["name"], f["face_id"]) for f in faces_info], None)
    except Exception as e:
        return (dest_path_str, [], str(e))


def sync_all_named_faces_to_exif(db_path: Path = DB_PATH, dest_dir: Path = DEST_DIR) -> dict:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("""
        SELECT DISTINCT f.dest_path FROM faces f
        JOIN persons p ON f.person_id = p.person_id
        WHERE p.name != 'Inconnu' AND p.name IS NOT NULL
          AND (f.exif_synced_name IS NULL OR f.exif_synced_name != p.name)
    """)
    dirty_files = [r["dest_path"] for r in cur.fetchall()]
    if not dirty_files:
        conn.close()
        return {"synced_photos": 0, "errors": 0}

    tasks = []
    for dest_p in dirty_files:
        cur.execute("""
            SELECT f.face_id, f.bbox, f.timestamp, p.name, pf.width, pf.height
            FROM faces f JOIN persons p ON f.person_id = p.person_id
            LEFT JOIN processed_files pf ON f.source_path = pf.source_path
            WHERE f.dest_path = ? AND p.name != 'Inconnu'
        """, (dest_p,))
        rows = cur.fetchall()
        if rows:
            tasks.append((
                dest_p, rows[0]["timestamp"], rows[0]["width"] or 0, rows[0]["height"] or 0,
                [{"face_id": r["face_id"], "bbox": r["bbox"], "name": r["name"]} for r in rows],
                str(dest_dir)
            ))

    synced_count, errors, db_updates = 0, 0, []
    with ProcessPoolExecutor(max_workers=MAX_WORKERS, initializer=init_worker) as executor:
        for _, synced_pairs, err in executor.map(sync_single_media, tasks, chunksize=15):
            if err:
                errors += 1
            else:
                synced_count += 1
                db_updates.extend(synced_pairs)

    if db_updates:
        cur.executemany("UPDATE faces SET exif_synced_name = ? WHERE face_id = ?", db_updates)
        conn.commit()
    conn.close()
    return {"synced_photos": synced_count, "errors": errors}