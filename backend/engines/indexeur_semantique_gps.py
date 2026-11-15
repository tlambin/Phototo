import sqlite3
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
from media_frames import ALL_MEDIA_EXTS, extract_analysis_frames
from settings_manager import get_hardware_runtime_config, load_settings, CLIP_MODEL_SPECS

DB_PATH = Path("progression_takeout.db")
BATCH_SIZE = 32
IMAGE_EXTS = ALL_MEDIA_EXTS

_vision_model = None
_text_model = None
_loaded_clip_key = None
_search_matrix_cache = {"key": None, "rows": [], "matrix": None}


def upgrade_db_for_clip_and_gps(conn: sqlite3.Connection):
    cur = conn.cursor()
    cols = {r[1] for r in cur.execute("PRAGMA table_info(processed_files)")}
    for col, ctype in [("latitude", "REAL"), ("longitude", "REAL"), ("clip_embedding", "BLOB"), ("clip_scanned", "INTEGER DEFAULT 0")]:
        if col not in cols:
            cur.execute(f"ALTER TABLE processed_files ADD COLUMN {col} {ctype}")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_gps ON processed_files(latitude, longitude)")
    conn.commit()


def get_clip_models():
    global _vision_model, _text_model, _loaded_clip_key
    clip_key = str(load_settings().get("clip_model", "vit-b-32")).strip().lower()
    if clip_key not in CLIP_MODEL_SPECS:
        clip_key = "vit-b-32"
    if _vision_model is None or _loaded_clip_key != clip_key:
        from sentence_transformers import SentenceTransformer
        import torch
        hw = get_hardware_runtime_config()
        dev = hw["torch_device"]
        if dev == "cuda" and not torch.cuda.is_available():
            dev = "cpu"
        elif dev == "xpu" and not (hasattr(torch, "xpu") and torch.xpu.is_available()):
            dev = "cpu"
        spec = CLIP_MODEL_SPECS[clip_key]
        _vision_model = SentenceTransformer(spec["vision_model"], device=dev)
        _text_model = _vision_model if spec["text_model"] == spec["vision_model"] else SentenceTransformer(spec["text_model"], device=dev)
        _loaded_clip_key = clip_key
    return _vision_model, _text_model


def search_photos_by_natural_text(db_path: Path, query_fr: str, top_k: int = 60, min_score: float = 0.21) -> list[dict]:
    if not query_fr.strip():
        return []

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("""
        SELECT COUNT(*) FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND clip_embedding IS NOT NULL
    """)
    total_emb = int(cur.fetchone()[0] or 0)
    if total_emb == 0:
        conn.close()
        return []

    _, text_model = get_clip_models()
    text_emb = text_model.encode([query_fr.strip()], normalize_embeddings=True, show_progress_bar=False)[0].astype(np.float32)
    expected_dim = int(text_emb.shape[0])

    cache_key = (str(Path(db_path).resolve()), total_emb, expected_dim)
    if _search_matrix_cache["key"] == cache_key and _search_matrix_cache["matrix"] is not None:
        conn.close()
        valid_rows = _search_matrix_cache["rows"]
        matrix = _search_matrix_cache["matrix"]
    else:
        cur.execute("""
            SELECT source_path, dest_path, timestamp, album_name, is_favorite, clip_embedding
            FROM processed_files
            WHERE is_duplicate = 0 AND is_trashed = 0 AND clip_embedding IS NOT NULL
        """)
        rows = cur.fetchall()
        conn.close()
        valid_rows = []
        vectors = []
        for r in rows:
            vec = np.frombuffer(r["clip_embedding"], dtype=np.float16).astype(np.float32)
            if vec.shape[0] == expected_dim:
                valid_rows.append({
                    "source_path": r["source_path"],
                    "dest_path": r["dest_path"],
                    "timestamp": r["timestamp"],
                    "album_name": r["album_name"],
                    "is_favorite": r["is_favorite"],
                })
                vectors.append(vec)
        if not vectors:
            return []
        matrix = np.vstack(vectors)
        _search_matrix_cache["key"] = cache_key
        _search_matrix_cache["rows"] = valid_rows
        _search_matrix_cache["matrix"] = matrix

    scores = np.dot(matrix, text_emb)
    best_indices = np.argsort(scores)[::-1][:top_k]

    results = []
    for idx in best_indices:
        sc = float(scores[idx])
        if sc < min_score:
            break
        r = valid_rows[int(idx)]
        results.append({
            "source_path": r["source_path"],
            "dest_path": r["dest_path"],
            "timestamp": r["timestamp"],
            "album_name": r["album_name"],
            "is_favorite": r["is_favorite"],
            "similarity": round(sc * 100, 1)
        })
    return results