import sqlite3
from pathlib import Path
import cv2
from PIL import Image
import imagehash
from media_frames import VIDEO_EXTS


def upgrade_db_for_video_similarity(conn: sqlite3.Connection):
    cur = conn.cursor()
    cols = {r[1] for r in cur.execute("PRAGMA table_info(processed_files)")}
    if "video_hash" not in cols:
        cur.execute("ALTER TABLE processed_files ADD COLUMN video_hash TEXT")
    if "duration_sec" not in cols:
        cur.execute("ALTER TABLE processed_files ADD COLUMN duration_sec REAL")
    conn.commit()


def compute_video_fingerprint(video_path: Path) -> tuple[str | None, float]:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        return None, 0.0
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = round(total_frames / fps, 2) if fps > 0 else 0.0

    hashes = []
    positions = [int(total_frames * r) for r in (0.1, 0.3, 0.5, 0.7, 0.9)] if total_frames >= 5 else [0]
    for pos in positions:
        cap.set(cv2.CAP_PROP_POS_FRAMES, pos)
        ret, frame = cap.read()
        if ret and frame is not None:
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            hashes.append(str(imagehash.phash(Image.fromarray(rgb))))
    cap.release()
    return ("-".join(hashes) if hashes else None), duration