import os
import shutil
import sqlite3
from pathlib import Path
import blake3
from PIL import Image
import imagehash
from media_frames import IMAGE_EXTS

DB_PATH = Path("progression_takeout.db")
DEST_DIR = Path("Photos_Propres")
QUARANTINE_DIR = DEST_DIR / "Doublons_Quarantaine"
MAX_WORKERS = min(8, os.cpu_count() or 4)


def upgrade_db(conn: sqlite3.Connection):
    cur = conn.cursor()
    cols = {r[1] for r in cur.execute("PRAGMA table_info(processed_files)")}
    new_cols = {
        "file_size": "INTEGER",
        "blake3_hash": "TEXT",
        "phash": "TEXT",
        "width": "INTEGER",
        "height": "INTEGER",
        "is_duplicate": "INTEGER DEFAULT 0",
        "master_path": "TEXT",
        "dup_type": "TEXT"
    }
    for c, t in new_cols.items():
        if c not in cols:
            cur.execute(f"ALTER TABLE processed_files ADD COLUMN {c} {t}")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_blake3 ON processed_files(blake3_hash)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_phash ON processed_files(phash)")
    conn.commit()


def compute_file_signatures(task: tuple) -> tuple:
    src_path, dest_path_str, compute_phash = task
    p = Path(dest_path_str)
    if not p.exists():
        return (src_path, 0, None, None, 0, 0)
    try:
        fsize = p.stat().st_size
        hasher = blake3.blake3()
        with open(p, "rb") as f:
            while chunk := f.read(1048576):
                hasher.update(chunk)
        b3_hex = hasher.hexdigest()

        ph_str, w, h = None, 0, 0
        if compute_phash and p.suffix.lower() in IMAGE_EXTS:
            try:
                with Image.open(p) as im:
                    w, h = im.size
                    ph_str = str(imagehash.phash(im))
            except Exception:
                pass
        return (src_path, fsize, b3_hex, ph_str, w, h)
    except Exception:
        return (src_path, 0, None, None, 0, 0)


def choose_winner(group: list[dict], dup_type: str) -> tuple[dict, list[dict]]:
    def score_item(item: dict):
        res = (item.get("width") or 0) * (item.get("height") or 0)
        fsize = item.get("file_size") or 0
        has_json = 1 if item.get("status") == "json_matched" else 0
        is_fav = item.get("is_favorite") or 0
        name_len = -len(Path(item.get("dest_path") or "").name)
        return (res, fsize, has_json, is_fav, name_len)

    sorted_g = sorted(group, key=score_item, reverse=True)
    winner = sorted_g[0]
    losers = sorted_g[1:]
    for l in losers:
        l["dup_type"] = dup_type
    return winner, losers


def merge_metadata_and_clean(conn: sqlite3.Connection, winner: dict, losers: list[dict]):
    QUARANTINE_DIR.mkdir(parents=True, exist_ok=True)
    cur = conn.cursor()

    merged_fav = winner.get("is_favorite") or 0
    albums = {a.strip() for a in (winner.get("album_name") or "").split(",") if a.strip()}
    win_path = Path(winner["dest_path"])

    for l in losers:
        if l.get("is_favorite"):
            merged_fav = 1
        for a in (l.get("album_name") or "").split(","):
            if a.strip():
                albums.add(a.strip())

        l_path = Path(l["dest_path"])
        q_target = QUARANTINE_DIR / l_path.name
        c = 1
        while q_target.exists():
            q_target = QUARANTINE_DIR / f"{l_path.stem}_{c}{l_path.suffix}"
            c += 1
        if l_path.exists() and l_path != win_path:
            shutil.move(l_path, q_target)

        cur.execute("""
            UPDATE processed_files
            SET is_duplicate = 1, master_path = ?, dup_type = ?, dest_path = ?
            WHERE source_path = ?
        """, (str(win_path), l.get("dup_type", "BLAKE3"), str(q_target), l["source_path"]))

    final_albums = ", ".join(sorted(albums)) if albums else None
    cur.execute("""
        UPDATE processed_files SET is_favorite = ?, album_name = ? WHERE source_path = ?
    """, (merged_fav, final_albums, winner["source_path"])
    )