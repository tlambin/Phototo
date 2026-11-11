import sqlite3
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
from media_frames import ALL_MEDIA_EXTS, extract_analysis_frames
from settings_manager import get_hardware_runtime_config

DB_PATH = Path("progression_takeout.db")
BATCH_SIZE = 32
IMAGE_EXTS = ALL_MEDIA_EXTS

_vision_model = None
_text_model = None


def upgrade_db_for_clip_and_gps(conn: sqlite3.Connection):
    cur = conn.cursor()
    cols = {r[1] for r in cur.execute("PRAGMA table_info(processed_files)")}
    for col, ctype in [("latitude", "REAL"), ("longitude", "REAL"), ("clip_embedding", "BLOB"), ("clip_scanned", "INTEGER DEFAULT 0")]:
        if col not in cols:
            cur.execute(f"ALTER TABLE processed_files ADD COLUMN {col} {ctype}")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_gps ON processed_files(latitude, longitude)")
    conn.commit()


def get_clip_models():
    global _vision_model, _text_model
    if _vision_model is None:
        from sentence_transformers import SentenceTransformer
        import torch
        hw = get_hardware_runtime_config()
        dev = hw["torch_device"]
        if dev == "cuda" and not torch.cuda.is_available():
            dev = "cpu"
        elif dev == "xpu" and not (hasattr(torch, "xpu") and torch.xpu.is_available()):
            dev = "cpu"
        _vision_model = SentenceTransformer("clip-ViT-B-32", device=dev)
        _text_model = SentenceTransformer("sentence-transformers/clip-ViT-B-32-multilingual-v1", device=dev)
    return _vision_model, _text_model


def search_photos_by_natural_text(db_path: Path, query_fr: str, top_k: int = 60, min_score: float = 0.21) -> list[dict]:
    if not query_fr.strip():
        return []
    _, text_model = get_clip_models()
    text_emb = text_model.encode([query_fr.strip()], normalize_embeddings=True, show_progress_bar=False)[0].astype(np.float32)

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("""
        SELECT source_path, dest_path, timestamp, album_name, is_favorite, clip_embedding
        FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND clip_embedding IS NOT NULL
    """)
    rows = cur.fetchall()
    conn.close()
    if not rows:
        return []

    matrix = np.vstack([np.frombuffer(r["clip_embedding"], dtype=np.float16).astype(np.float32) for r in rows])
    scores = np.dot(matrix, text_emb)
    best_indices = np.argsort(scores)[::-1][:top_k]

    results = []
    for idx in best_indices:
        sc = float(scores[idx])
        if sc < min_score:
            break
        r = rows[int(idx)]
        results.append({
            "source_path": r["source_path"],
            "dest_path": r["dest_path"],
            "timestamp": r["timestamp"],
            "album_name": r["album_name"],
            "is_favorite": r["is_favorite"],
            "similarity": round(sc * 100, 1)
        })
    return results