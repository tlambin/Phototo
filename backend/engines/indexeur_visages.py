import sqlite3
from pathlib import Path
import cv2
import numpy as np
from tqdm import tqdm
from insightface.app import FaceAnalysis
from sklearn.cluster import HDBSCAN
from media_frames import ALL_MEDIA_EXTS, extract_analysis_frames
from settings_manager import get_hardware_runtime_config

DB_PATH = Path("progression_takeout.db")
DEST_DIR = Path("Photos_Propres")
THUMBS_DIR = DEST_DIR / "Miniatures_Visages"
DET_SIZE = (640, 640)
MIN_FACE_SCORE = 0.65
MIN_FACE_PIXELS = 45


def init_face_tables(conn: sqlite3.Connection):
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS persons (
            person_id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT DEFAULT 'Inconnu',
            cover_face_id INTEGER,
            face_count INTEGER DEFAULT 0,
            min_timestamp INTEGER,
            max_timestamp INTEGER,
            centroid_embedding BLOB
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS faces (
            face_id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_path TEXT,
            dest_path TEXT,
            timestamp INTEGER,
            bbox TEXT,
            det_score REAL,
            embedding BLOB,
            thumb_path TEXT,
            person_id INTEGER,
            exif_synced_name TEXT,
            FOREIGN KEY(person_id) REFERENCES persons(person_id)
        )
    """)
    p_cols = {r[1] for r in cur.execute("PRAGMA table_info(persons)")}
    if "centroid_embedding" not in p_cols:
        cur.execute("ALTER TABLE persons ADD COLUMN centroid_embedding BLOB")

    cols = {r[1] for r in cur.execute("PRAGMA table_info(processed_files)")}
    if "faces_scanned" not in cols:
        cur.execute("ALTER TABLE processed_files ADD COLUMN faces_scanned INTEGER DEFAULT 0")

    cur.execute("CREATE INDEX IF NOT EXISTS idx_faces_person ON faces(person_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_faces_ts ON faces(timestamp)")
    conn.commit()


def save_face_thumbnail(img: np.ndarray, bbox: list[int], face_uid: str) -> str:
    THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    h, w = img.shape[:2]
    x1, y1, x2, y2 = bbox
    bw, bh = x2 - x1, y2 - y1
    pad_x, pad_y = int(bw * 0.3), int(bh * 0.3)
    cx1, cy1 = max(0, x1 - pad_x), max(0, y1 - pad_y)
    cx2, cy2 = min(w, x2 + pad_x), min(h, y2 + pad_y)
    crop = img[cy1:cy2, cx1:cx2]
    if crop.size == 0:
        return ""
    crop_resized = cv2.resize(crop, (160, 160), interpolation=cv2.INTER_AREA)
    thumb_file = THUMBS_DIR / f"{face_uid}.jpg"
    cv2.imwrite(str(thumb_file), crop_resized, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    return str(thumb_file)


def deduplicate_video_faces(candidates: list[dict], sim_threshold: float = 0.65) -> list[dict]:
    if len(candidates) <= 1:
        return candidates
    sorted_cands = sorted(candidates, key=lambda c: c["det_score"], reverse=True)
    kept = []
    for cand in sorted_cands:
        if not any(float(np.dot(cand["emb"], k["emb"])) >= sim_threshold for k in kept):
            kept.append(cand)
    return kept


def run_face_clustering(conn: sqlite3.Connection):
    cur = conn.cursor()
    cur.execute("SELECT face_id, timestamp, det_score, embedding, person_id FROM faces WHERE embedding IS NOT NULL")
    rows = cur.fetchall()
    if len(rows) < 2:
        return

    face_ids = [r[0] for r in rows]
    timestamps = np.array([r[1] or 0 for r in rows], dtype=np.int64)
    det_scores = np.array([r[2] for r in rows], dtype=np.float32)
    embeddings = np.vstack([np.frombuffer(r[3], dtype=np.float32) for r in rows])

    cur.execute("SELECT person_id, name FROM persons WHERE name != 'Inconnu'")
    named_persons = dict(cur.fetchall())
    manual_face_to_name = {r[0]: named_persons[r[4]] for r in rows if r[4] in named_persons}

    clusterer = HDBSCAN(min_cluster_size=2, min_samples=2, metric='euclidean', cluster_selection_epsilon=0.82)
    labels = clusterer.fit_predict(embeddings)

    clusters = {}
    for idx, lbl in enumerate(labels):
        if lbl != -1:
            clusters.setdefault(int(lbl), []).append(idx)

    cur.execute("DELETE FROM persons WHERE person_id NOT IN (SELECT DISTINCT person_id FROM faces WHERE embedding IS NULL AND person_id IS NOT NULL)")
    cur.execute("UPDATE faces SET person_id = NULL WHERE embedding IS NOT NULL")

    for _, idxs in clusters.items():
        best_i = max(idxs, key=lambda i: det_scores[i])
        cover_fid = face_ids[best_i]
        restored_name = "Inconnu"
        for i in idxs:
            if face_ids[i] in manual_face_to_name:
                restored_name = manual_face_to_name[face_ids[i]]
                break

        valid_ts = [int(timestamps[i]) for i in idxs if timestamps[i] > 0]
        min_t = min(valid_ts) if valid_ts else 0
        max_t = max(valid_ts) if valid_ts else 0

        centroid = np.mean(embeddings[idxs], axis=0)
        norm = np.linalg.norm(centroid)
        if norm > 0:
            centroid = (centroid / norm).astype(np.float32)

        cur.execute("""
            INSERT INTO persons (name, cover_face_id, face_count, min_timestamp, max_timestamp, centroid_embedding)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (restored_name, cover_fid, len(idxs), min_t, max_t, centroid.tobytes()))
        pid = cur.lastrowid
        cur.executemany("UPDATE faces SET person_id = ? WHERE face_id = ?", [(pid, face_ids[i]) for i in idxs])

    conn.commit()