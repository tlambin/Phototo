import json
import sqlite3
from datetime import datetime
from pathlib import Path
from library_manager import load_libraries, get_library_tech_dir
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
                region TEXT DEFAULT '',
                country TEXT,
                display_label TEXT,
                updated_at INTEGER DEFAULT (strftime('%s','now')),
                PRIMARY KEY (lat_key, lon_key)
            )
        """)
        init_conn.execute("""
            CREATE TABLE IF NOT EXISTS custom_groups (
                group_id INTEGER PRIMARY KEY AUTOINCREMENT,
                scope TEXT NOT NULL,
                name TEXT NOT NULL,
                color TEXT DEFAULT '',
                sort_order INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(scope, name)
            )
        """)
        cg_cols = {r[1] for r in init_conn.execute("PRAGMA table_info(custom_groups)").fetchall()}
        if "sort_order" not in cg_cols:
            init_conn.execute("ALTER TABLE custom_groups ADD COLUMN sort_order INTEGER DEFAULT 0")
        init_conn.execute("""
            CREATE TABLE IF NOT EXISTS custom_group_items (
                group_id INTEGER NOT NULL,
                item_key TEXT NOT NULL,
                added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (group_id, item_key),
                FOREIGN KEY (group_id) REFERENCES custom_groups(group_id) ON DELETE CASCADE
            )
        """)
        init_conn.execute("CREATE INDEX IF NOT EXISTS idx_cg_scope ON custom_groups(scope)")
        _ensure_activity_history_table(init_conn)
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
        geo_cols = {r[1] for r in init_conn.execute("PRAGMA table_info(geocode_cache)").fetchall()}
        if "region" not in geo_cols:
            init_conn.execute("ALTER TABLE geocode_cache ADD COLUMN region TEXT DEFAULT ''")
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
    for cand in (
        get_library_tech_dir(dest_dir, "Doublons_Quarantaine") / p.name,
        dest_dir / "Corbeille" / p.name,
    ):
        if cand.exists() and cand.is_file():
            return cand

    if len(p.parts) >= 3:
        rel_cand = dest_dir / p.parts[-3] / p.parts[-2] / p.name
        if rel_cand.exists() and rel_cand.is_file():
            return rel_cand

    return None


def _ensure_activity_history_table(conn: sqlite3.Connection):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS activity_history (
            activity_id INTEGER PRIMARY KEY AUTOINCREMENT,
            library_name TEXT DEFAULT '',
            action_type TEXT NOT NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL,
            detail TEXT DEFAULT '',
            reason TEXT DEFAULT '',
            started_at TEXT NOT NULL,
            finished_at TEXT NOT NULL,
            duration_sec REAL DEFAULT 0,
            total_items INTEGER DEFAULT 0,
            success_count INTEGER DEFAULT 0,
            failed_count INTEGER DEFAULT 0,
            failed_files_json TEXT DEFAULT '[]',
            files_json TEXT DEFAULT '[]',
            params_json TEXT DEFAULT ''
        )
    """)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(activity_history)").fetchall()}
    if "files_json" not in cols:
        conn.execute("ALTER TABLE activity_history ADD COLUMN files_json TEXT DEFAULT '[]'")
    if "params_json" not in cols:
        conn.execute("ALTER TABLE activity_history ADD COLUMN params_json TEXT DEFAULT ''")


def build_file_entry(path_str: str, info: str = "") -> dict:
    clean_p = str(path_str or "").replace("\\", "/")
    return {
        "path": clean_p,
        "name": Path(clean_p).name if clean_p else "Fichier",
        "info": str(info or "")[:200],
    }


def record_activity_entry(
    db_path: Path,
    *,
    library_name: str,
    action_type: str,
    title: str,
    status: str,
    detail: str = "",
    reason: str = "",
    started_at: str | None = None,
    finished_at: str | None = None,
    duration_sec: float = 0.0,
    total_items: int = 0,
    success_count: int = 0,
    failed_files: list[dict] | None = None,
    files: list[dict] | None = None,
    params_json: str = "",
) -> int:
    """Persist a completed or failed action entry in the library SQLite database."""
    now_iso = datetime.now().isoformat(timespec="seconds")
    failed_list = list(failed_files or [])
    files_list = list(files or [])
    capped_failed = failed_list[:500]
    capped_files = files_list[:500]
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=30.0)
    try:
        conn.execute("PRAGMA busy_timeout=30000;")
        _ensure_activity_history_table(conn)
        cur = conn.execute(
            """
            INSERT INTO activity_history (
                library_name, action_type, title, status, detail, reason,
                started_at, finished_at, duration_sec, total_items,
                success_count, failed_count, failed_files_json, files_json, params_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(library_name or ""),
                str(action_type or "TASK"),
                str(title or "Activité"),
                str(status or "success"),
                str(detail or ""),
                str(reason or ""),
                started_at or now_iso,
                finished_at or now_iso,
                round(max(0.0, float(duration_sec or 0.0)), 2),
                int(total_items or 0),
                int(success_count or 0),
                len(failed_list),
                json.dumps(capped_failed, ensure_ascii=False),
                json.dumps(capped_files, ensure_ascii=False),
                str(params_json or ""),
            ),
        )
        conn.commit()
        return int(cur.lastrowid or 0)
    finally:
        conn.close()


def log_library_action(
    action_type: str,
    title: str,
    detail: str = "",
    *,
    status: str = "success",
    reason: str = "",
    duration_sec: float = 0.0,
    total_items: int = 0,
    success_count: int = 0,
    files: list[dict] | None = None,
    failed_files: list[dict] | None = None,
) -> None:
    """Safely record a user or maintenance action on the active library without breaking callers."""
    try:
        db_p, _ = get_active_db_and_dest()
        if not db_p.exists():
            return
        cfg = load_libraries()
        lib_name = str(cfg.get("active_library") or "")
        record_activity_entry(
            db_p,
            library_name=lib_name,
            action_type=action_type,
            title=title,
            status=status,
            detail=detail,
            reason=reason,
            duration_sec=duration_sec,
            total_items=total_items or len(files or []),
            success_count=success_count or len(files or []),
            failed_files=failed_files,
            files=files,
        )
    except Exception:
        pass


def list_activity_entries(limit: int = 100) -> list[dict]:
    """Return recorded activities for the active library, newest first."""
    db_p, _ = get_active_db_and_dest()
    if not db_p.exists():
        return []
    conn = get_db()
    try:
        _ensure_activity_history_table(conn)
        rows = conn.execute(
            """
            SELECT activity_id, library_name, action_type, title, status, detail, reason,
                   started_at, finished_at, duration_sec, total_items,
                   success_count, failed_count, failed_files_json, files_json
            FROM activity_history
            ORDER BY activity_id DESC
            LIMIT ?
            """,
            (int(limit),),
        ).fetchall()
        out = []
        for r in rows:
            try:
                f_list = json.loads(r["failed_files_json"] or "[]")
            except Exception:
                f_list = []
            try:
                ok_list = json.loads(r["files_json"] or "[]")
            except Exception:
                ok_list = []
            out.append({
                "activity_id": r["activity_id"],
                "library_name": r["library_name"] or "",
                "action_type": r["action_type"],
                "title": r["title"],
                "status": r["status"],
                "detail": r["detail"] or "",
                "reason": r["reason"] or "",
                "started_at": r["started_at"],
                "finished_at": r["finished_at"],
                "duration_sec": float(r["duration_sec"] or 0.0),
                "total_items": int(r["total_items"] or 0),
                "success_count": int(r["success_count"] or 0),
                "failed_count": int(r["failed_count"] or 0),
                "failed_files": f_list if isinstance(f_list, list) else [],
                "files": ok_list if isinstance(ok_list, list) else [],
            })
        return out
    finally:
        conn.close()


def delete_activity_entry(activity_id: int) -> list[dict]:
    db_p, _ = get_active_db_and_dest()
    if db_p.exists():
        conn = get_db()
        try:
            _ensure_activity_history_table(conn)
            conn.execute("DELETE FROM activity_history WHERE activity_id = ?", (int(activity_id),))
            conn.commit()
        finally:
            conn.close()
    return list_activity_entries()


def get_activity_entry(activity_id: int) -> dict | None:
    db_p, _ = get_active_db_and_dest()
    if not db_p.exists():
        return None
    conn = get_db()
    try:
        _ensure_activity_history_table(conn)
        r = conn.execute(
            """
            SELECT activity_id, library_name, action_type, title, status, detail, reason,
                   started_at, finished_at, duration_sec, total_items,
                   success_count, failed_count, failed_files_json, files_json, params_json
            FROM activity_history WHERE activity_id = ?
            """,
            (int(activity_id),),
        ).fetchone()
        if not r:
            return None
        return {
            "activity_id": r["activity_id"],
            "library_name": r["library_name"] or "",
            "action_type": r["action_type"],
            "title": r["title"],
            "status": r["status"],
            "detail": r["detail"] or "",
            "reason": r["reason"] or "",
            "started_at": r["started_at"],
            "finished_at": r["finished_at"],
            "duration_sec": float(r["duration_sec"] or 0.0),
            "total_items": int(r["total_items"] or 0),
            "success_count": int(r["success_count"] or 0),
            "failed_count": int(r["failed_count"] or 0),
            "params_json": r["params_json"] or "",
        }
    finally:
        conn.close()


def clear_activity_entries() -> list[dict]:
    db_p, _ = get_active_db_and_dest()
    if db_p.exists():
        conn = get_db()
        try:
            _ensure_activity_history_table(conn)
            conn.execute("DELETE FROM activity_history")
            conn.commit()
        finally:
            conn.close()
    return []


def cancel_paused_activity_entry(activity_id: int) -> list[dict]:
    """Mark a persisted paused activity as explicitly stopped so it is no longer offered as active-paused on restart."""
    db_p, _ = get_active_db_and_dest()
    if db_p.exists():
        conn = get_db()
        try:
            _ensure_activity_history_table(conn)
            conn.execute(
                """
                UPDATE activity_history
                SET reason = 'Tâche arrêtée par l''utilisateur',
                    detail = CASE
                        WHEN instr(detail, '·') > 0 THEN 'Tâche arrêtée par l''utilisateur ' || substr(detail, instr(detail, '·'))
                        ELSE 'Tâche arrêtée par l''utilisateur'
                    END
                WHERE activity_id = ? AND status = 'paused'
                """,
                (int(activity_id),),
            )
            conn.commit()
        finally:
            conn.close()
    return list_activity_entries()
