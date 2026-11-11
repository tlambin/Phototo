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