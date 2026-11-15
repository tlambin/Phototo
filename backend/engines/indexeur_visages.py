import shutil
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


def resolve_insightface_model_arg(faces_model: str, root: Path | None = None) -> str:
    """Corrige les archives InsightFace imbriquées (ex. antelopev2/antelopev2/*.onnx) et retourne le nom ou chemin du modèle."""
    base_root = root or (Path.home() / ".insightface")
    model_dir = base_root / "models" / faces_model
    nested_dir = model_dir / faces_model
    try:
        top_onnx = list(model_dir.glob("*.onnx")) if model_dir.is_dir() else []
        nested_onnx = list(nested_dir.glob("*.onnx")) if nested_dir.is_dir() else []
        if not top_onnx and nested_onnx:
            try:
                for f in nested_onnx:
                    shutil.move(str(f), str(model_dir / f.name))
                try:
                    nested_dir.rmdir()
                except OSError:
                    pass
                return faces_model
            except OSError:
                return str(nested_dir)
    except OSError:
        pass
    return faces_model


def create_face_analysis(
    faces_model: str,
    providers: list[str] | None = None,
    ctx_id: int = 0,
    det_size: tuple[int, int] = DET_SIZE,
    det_thresh: float = 0.5,
) -> FaceAnalysis:
    """Initialise FaceAnalysis avec gestion des dossiers imbriqués (antelopev2) et repli CPU si CUDA échoue."""
    resolved_arg = resolve_insightface_model_arg(faces_model)
    prov_list = list(providers or ["CPUExecutionProvider"])

    def _build(arg: str, provs: list[str], cid: int):
        from insightface.app import FaceAnalysis as _FA
        app = _FA(name=arg, allowed_modules=["detection", "recognition"], providers=provs)
        app.prepare(ctx_id=cid, det_thresh=det_thresh, det_size=det_size)
        return app

    try:
        return _build(resolved_arg, prov_list, ctx_id)
    except AssertionError:
        retry_arg = resolve_insightface_model_arg(faces_model)
        model_dir = Path.home() / ".insightface" / "models" / faces_model
        try:
            has_onnx = bool(list(model_dir.glob("*.onnx")))
        except OSError:
            has_onnx = False
        if retry_arg != resolved_arg or has_onnx:
            return _build(retry_arg, prov_list, ctx_id)
        raise
    except Exception:
        if prov_list != ["CPUExecutionProvider"]:
            return _build(resolve_insightface_model_arg(faces_model), ["CPUExecutionProvider"], -1)
        raise


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
    cur.execute("""
        CREATE TABLE IF NOT EXISTS face_name_hints (
            source_path TEXT NOT NULL,
            bbox TEXT,
            person_name TEXT NOT NULL
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
    cur.execute("CREATE INDEX IF NOT EXISTS idx_faces_dest ON faces(dest_path)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_faces_src ON faces(source_path)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_face_hints_src ON face_name_hints(source_path)")
    conn.commit()


def _parse_bbox_coords(bbox_str: str | None) -> tuple[int, int, int, int] | None:
    if not bbox_str:
        return None
    parts = [p.strip() for p in str(bbox_str).split(",")]
    if len(parts) != 4:
        return None
    try:
        x1, y1, x2, y2 = (int(float(v)) for v in parts)
        return (x1, y1, x2, y2) if x2 > x1 and y2 > y1 else None
    except ValueError:
        return None


def _bbox_match_score(b1: tuple[int, int, int, int], b2: tuple[int, int, int, int]) -> float:
    ix1, iy1 = max(b1[0], b2[0]), max(b1[1], b2[1])
    ix2, iy2 = min(b1[2], b2[2]), min(b1[3], b2[3])
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    a1 = (b1[2] - b1[0]) * (b1[3] - b1[1])
    a2 = (b2[2] - b2[0]) * (b2[3] - b2[1])
    union = a1 + a2 - inter
    iou = (inter / union) if union > 0 else 0.0
    cx1, cy1 = (b1[0] + b1[2]) / 2.0, (b1[1] + b1[3]) / 2.0
    if b2[0] <= cx1 <= b2[2] and b2[1] <= cy1 <= b2[3]:
        return max(iou, 0.25)
    return iou


def snapshot_named_face_hints(conn: sqlite3.Connection):
    """Sauvegarde les noms attribués aux visages (source_path + bbox + person_name) avant ré-indexation."""
    init_face_tables(conn)
    cur = conn.cursor()
    rows = cur.execute("""
        SELECT f.source_path, f.bbox, p.name
        FROM faces f
        JOIN persons p ON f.person_id = p.person_id
        WHERE f.embedding IS NOT NULL
          AND f.source_path IS NOT NULL
          AND p.name IS NOT NULL
          AND p.name != 'Inconnu'
    """).fetchall()
    if not rows:
        return 0
    existing = set(cur.execute("SELECT source_path, bbox, person_name FROM face_name_hints").fetchall())
    to_insert = [(r[0], r[1] or "", r[2]) for r in rows if (r[0], r[1] or "", r[2]) not in existing]
    if to_insert:
        cur.executemany("INSERT INTO face_name_hints (source_path, bbox, person_name) VALUES (?, ?, ?)", to_insert)
        conn.commit()
    return len(to_insert)


def apply_face_name_hints(conn: sqlite3.Connection) -> int:
    """Ré-associe les noms sauvegardés aux nouveaux visages détectés par chevauchement sur chaque photo."""
    cur = conn.cursor()
    hints = cur.execute("SELECT source_path, bbox, person_name FROM face_name_hints").fetchall()
    if not hints:
        return 0

    by_src: dict[str, list[tuple[tuple[int, int, int, int] | None, str]]] = {}
    for src, b_str, pname in hints:
        by_src.setdefault(src, []).append((_parse_bbox_coords(b_str), pname))

    faces_rows = cur.execute("""
        SELECT f.face_id, f.source_path, f.bbox, COALESCE(p.name, 'Inconnu')
        FROM faces f
        LEFT JOIN persons p ON f.person_id = p.person_id
        WHERE f.embedding IS NOT NULL AND f.source_path IS NOT NULL
    """).fetchall()

    name_to_pid = dict(cur.execute("SELECT name, person_id FROM persons WHERE name != 'Inconnu'").fetchall())
    restored = 0
    for fid, src, fb_str, cur_name in faces_rows:
        if cur_name != "Inconnu" or src not in by_src:
            continue
        fb = _parse_bbox_coords(fb_str)
        if not fb:
            continue
        best_score = 0.0
        best_name = None
        for hb, pname in by_src[src]:
            if not hb:
                continue
            sc = _bbox_match_score(fb, hb)
            if sc > best_score:
                best_score = sc
                best_name = pname
        if best_name and best_score >= 0.20:
            pid = name_to_pid.get(best_name)
            if pid is None:
                cur.execute("INSERT INTO persons (name, cover_face_id, face_count) VALUES (?, ?, 0)", (best_name, fid))
                pid = cur.lastrowid
                name_to_pid[best_name] = pid
            cur.execute("UPDATE faces SET person_id = ? WHERE face_id = ?", (pid, fid))
            restored += 1
    if restored:
        conn.commit()
    return restored


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
    singleton_named_idxs = []
    for idx, lbl in enumerate(labels):
        if lbl != -1:
            clusters.setdefault(int(lbl), []).append(idx)
        elif face_ids[idx] in manual_face_to_name:
            singleton_named_idxs.append(idx)

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

    for i in singleton_named_idxs:
        rname = manual_face_to_name[face_ids[i]]
        ts_val = int(timestamps[i]) if timestamps[i] > 0 else 0
        existing_p = cur.execute("SELECT person_id FROM persons WHERE name = ? LIMIT 1", (rname,)).fetchone()
        if existing_p:
            pid = existing_p[0]
            cur.execute("UPDATE persons SET face_count = COALESCE(face_count, 0) + 1 WHERE person_id = ?", (pid,))
        else:
            emb_bytes = embeddings[i].astype(np.float32).tobytes()
            cur.execute("""
                INSERT INTO persons (name, cover_face_id, face_count, min_timestamp, max_timestamp, centroid_embedding)
                VALUES (?, ?, 1, ?, ?, ?)
            """, (rname, face_ids[i], ts_val, ts_val, emb_bytes))
            pid = cur.lastrowid
        cur.execute("UPDATE faces SET person_id = ? WHERE face_id = ?", (pid, face_ids[i]))

    conn.commit()