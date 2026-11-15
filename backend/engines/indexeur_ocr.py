import sqlite3
from pathlib import Path
from media_frames import ALL_MEDIA_EXTS

DB_PATH = Path("progression_takeout.db")
MIN_CONFIDENCE = 0.65
MAX_IMG_DIM = 1600
IMAGE_EXTS = ALL_MEDIA_EXTS


def init_ocr_tables(conn: sqlite3.Connection):
    cur = conn.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS ocr_results (
            source_path TEXT PRIMARY KEY,
            dest_path TEXT,
            timestamp INTEGER,
            full_text TEXT,
            avg_confidence REAL,
            line_count INTEGER
        )
    """)
    cur.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS ocr_fts USING fts5(
            source_path UNINDEXED,
            dest_path UNINDEXED,
            full_text,
            tokenize='unicode61 remove_diacritics 2'
        )
    """)
    conn.commit()


def create_paddle_ocr_engine(lang: str = "fr", prefer_gpu: bool = False):
    """Initialise PaddleOCR compatible 3.x (oneDNN désactivé pour éviter NotImplementedError) et 2.x."""
    try:
        import torch  # noqa: F401 - charger torch avant paddle sous Windows (évite conflit shm.dll)
    except Exception:
        pass
    from paddleocr import PaddleOCR

    device = "cpu"
    if prefer_gpu:
        try:
            import paddle
            if paddle.device.is_compiled_with_cuda() and paddle.device.cuda.device_count() > 0:
                device = "gpu:0"
        except Exception:
            device = "cpu"

    try:
        return PaddleOCR(
            lang=lang,
            device=device,
            enable_mkldnn=False,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=True,
        )
    except (TypeError, ValueError):
        try:
            return PaddleOCR(lang=lang, enable_mkldnn=False)
        except (TypeError, ValueError):
            return PaddleOCR(use_angle_cls=True, lang=lang, use_gpu=(device != "cpu"), enable_mkldnn=False, show_log=False)


def run_paddle_ocr_image(engine, img) -> list[tuple[str, float]]:
    """Exécute l'OCR et unifie le format de sortie PaddleOCR 3.x (dict/OCRResult) et 2.x (liste)."""
    res = engine.predict(img) if hasattr(engine, "predict") else engine.ocr(img)
    if not res:
        return []
    r0 = res[0]
    if hasattr(r0, "get") or isinstance(r0, dict):
        texts = r0.get("rec_texts") or []
        scores = r0.get("rec_scores") or []
        return [(str(t), float(s)) for t, s in zip(texts, scores)]
    if isinstance(r0, list):
        return [(str(line[1][0]), float(line[1][1])) for line in r0 if line and len(line) >= 2 and len(line[1]) >= 2]
    return []