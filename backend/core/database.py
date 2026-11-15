import sqlite3
from pathlib import Path
from library_manager import load_libraries
from indexeur_visages import init_face_tables
from indexeur_ocr import init_ocr_tables
from indexeur_semantique_gps import upgrade_db_for_clip_and_gps
from indexeur_similaires import upgrade_db_for_video_similarity
import fusion_takeout_complet as fusion

DEFAULT_DB = Path("progression_takeout.db")
DEFAULT_DEST = Path("./Photos_Triees")
RAW_EXTS = {'.dng', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2'}

MISSING_META_SQL_CONDITION = """
    is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
    AND (
        status IN ('no_metadata', 'mtime_fallback')
        OR timestamp IS NULL OR timestamp <= 0
    )
"""

EMPTY_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">'
    '<rect width="200" height="200" fill="#0f172a"/>'
    '<text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#475569" font-family="sans-serif" font-size="13">Média absent</text>'
    '</svg>'
)

_INITIALIZED_DBS: set[str] = set()


def get_active_db_and_dest() -> tuple[Path, Path]:
    cfg = load_libraries()
    active = cfg.get("active_library")
    if active and active in cfg.get("libraries", {}):
        lib = cfg["libraries"][active]
        return Path(lib["db_path"]), Path(lib["dest_dir"])
    return DEFAULT_DB, DEFAULT_DEST


def get_db() -> sqlite3.Connection:
    db_p, _ = get_active_db_and_dest()
    db_key = str(db_p.resolve())

    if db_key not in _INITIALIZED_DBS:
        init_conn = fusion.init_db(db_p)
        init_face_tables(init_conn)
        init_ocr_tables(init_conn)
        upgrade_db_for_clip_and_gps(init_conn)
        upgrade_db_for_video_similarity(init_conn)
        init_conn.execute("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)")
        init_conn.execute("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('trash_retention_days', '30')")
        init_conn.execute("""
            CREATE TABLE IF NOT EXISTS albums (
                album_id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                full_path TEXT NOT NULL UNIQUE,
                parent_id INTEGER,
                cover_path TEXT,
                source_dir TEXT DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(parent_id) REFERENCES albums(album_id) ON DELETE CASCADE
            )
        """)
        init_conn.execute("""
            CREATE TABLE IF NOT EXISTS smart_categories (
                category_id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                prompt TEXT NOT NULL,
                prompt_en TEXT,
                source TEXT DEFAULT 'MANUAL',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        init_conn.execute("""
            CREATE TABLE IF NOT EXISTS media_categories (
                source_path TEXT NOT NULL,
                category_id INTEGER NOT NULL,
                assigned_by TEXT DEFAULT 'MANUAL',
                score REAL DEFAULT 1.0,
                PRIMARY KEY (source_path, category_id),
                FOREIGN KEY (category_id) REFERENCES smart_categories(category_id) ON DELETE CASCADE
            )
        """)
        init_conn.execute("""
            CREATE TABLE IF NOT EXISTS geocode_cache (
                lat_key REAL NOT NULL,
                lon_key REAL NOT NULL,
                city TEXT,
                country TEXT,
                display_label TEXT,
                updated_at INTEGER DEFAULT (strftime('%s','now')),
                PRIMARY KEY (lat_key, lon_key)
            )
        """)
        init_conn.execute("CREATE INDEX IF NOT EXISTS idx_pf_gallery ON processed_files(is_duplicate, is_trashed, timestamp DESC)")
        init_conn.execute("CREATE INDEX IF NOT EXISTS idx_pf_album ON processed_files(album_name)")
        init_conn.execute("CREATE INDEX IF NOT EXISTS idx_pf_fav ON processed_files(is_favorite)")
        cols = {r[1] for r in init_conn.execute("PRAGMA table_info(processed_files)").fetchall()}
        if "modified_at" not in cols:
            init_conn.execute("ALTER TABLE processed_files ADD COLUMN modified_at INTEGER")
        if "is_animated" not in cols:
            init_conn.execute("ALTER TABLE processed_files ADD COLUMN is_animated INTEGER DEFAULT NULL")
        if "faces_model" not in cols:
            init_conn.execute("ALTER TABLE processed_files ADD COLUMN faces_model TEXT DEFAULT NULL")
        if "clip_model" not in cols:
            init_conn.execute("ALTER TABLE processed_files ADD COLUMN clip_model TEXT DEFAULT NULL")
        if "visual_suggestions_json" not in cols:
            init_conn.execute("ALTER TABLE processed_files ADD COLUMN visual_suggestions_json TEXT DEFAULT NULL")
        sc_cols = {r[1] for r in init_conn.execute("PRAGMA table_info(smart_categories)").fetchall()}
        if "prompt_en" not in sc_cols:
            init_conn.execute("ALTER TABLE smart_categories ADD COLUMN prompt_en TEXT")
        alb_cols = {r[1] for r in init_conn.execute("PRAGMA table_info(albums)").fetchall()}
        if "source_dir" not in alb_cols:
            init_conn.execute("ALTER TABLE albums ADD COLUMN source_dir TEXT DEFAULT NULL")
        init_conn.execute("CREATE INDEX IF NOT EXISTS idx_pf_modified ON processed_files(is_duplicate, is_trashed, modified_at DESC)")
        init_conn.execute("CREATE INDEX IF NOT EXISTS idx_pf_animated ON processed_files(is_duplicate, is_trashed, is_animated)")
        init_conn.commit()
        init_conn.close()
        _INITIALIZED_DBS.add(db_key)

    conn = sqlite3.connect(db_p, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA cache_size=-65536;")
    conn.execute("PRAGMA temp_store=MEMORY;")
    conn.execute("PRAGMA busy_timeout=30000;")
    return conn


def resolve_actual_path(path_str: str) -> Path | None:
    if not path_str or not path_str.strip():
        return None
    p = Path(path_str)
    if p.exists() and p.is_file():
        return p

    _, dest_dir = get_active_db_and_dest()
    for sub in ("Doublons_Quarantaine", "Corbeille"):
        cand = dest_dir / sub / p.name
        if cand.exists() and cand.is_file():
            return cand

    if len(p.parts) >= 3:
        rel_cand = dest_dir / p.parts[-3] / p.parts[-2] / p.name
        if rel_cand.exists() and rel_cand.is_file():
            return rel_cand

    return None
