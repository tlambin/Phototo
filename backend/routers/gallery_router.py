import os
import time
import shutil
import sqlite3
import tempfile
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

import cv2
import imagehash
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from database import MISSING_META_SQL_CONDITION, RAW_EXTS, get_active_db_and_dest, get_db, resolve_actual_path, log_library_action, build_file_entry
import deduplicateur as dedup
import indexeur_similaires as sim_ai
from library_manager import load_libraries
from media_editor import process_image_edits
from media_frames import VIDEO_EXTS, IMAGE_EXTS, detect_is_animated, probe_media_dimensions
from settings_manager import load_settings
import suggestions_engine as sug_ai

router = APIRouter()


class ToggleFavoritePayload(BaseModel):
    source_path: str


class TrashActionPayload(BaseModel):
    source_paths: list[str]
    action: str


class TrashPolicyPayload(BaseModel):
    retention_days: int


class GalleryBatchActionPayload(BaseModel):
    source_paths: list[str]
    action: str
    album_name: str | None = None


class GalleryBatchDownloadPayload(BaseModel):
    source_paths: list[str]


class AutoResolveDuplicatesPayload(BaseModel):
    mode: str = "KEEP_ONE"          # "KEEP_BOTH" | "KEEP_ONE"
    priority: str = "BEST_QUALITY"  # "BEST_QUALITY" | "NEWEST" | "OLDEST" | "LARGEST"
    priorities: list[str] | None = None
    exact_only: bool = False
    update_albums: bool = True
    move_to_trash: bool = True


class CreateAlbumPayload(BaseModel):
    name: str
    parent_id: int | None = None
    source_dir: str | None = None


class RenameAlbumPayload(BaseModel):
    album_id: int
    new_name: str


class DeleteAlbumPayload(BaseModel):
    album_id: int
    delete_subalbums: bool = True


class SetAlbumCoverPayload(BaseModel):
    album_id: int
    cover_path: str


def _sanitize_album_segment(name: str) -> str:
    clean = name.replace("/", "-").replace("\\", "-").replace(",", " ").strip()
    return clean


def _ensure_album_path(cur: sqlite3.Cursor, full_path: str, dest_dir: Path | None = None) -> int | None:
    segments = [_sanitize_album_segment(s) for s in full_path.split("/") if _sanitize_album_segment(s)]
    if not segments:
        return None
    parent_id = None
    acc_parts = []
    last_id = None
    for seg in segments:
        acc_parts.append(seg)
        curr_full = "/".join(acc_parts)
        cur.execute("SELECT album_id FROM albums WHERE full_path = ?", (curr_full,))
        row = cur.fetchone()
        if row:
            last_id = row["album_id"]
        else:
            cur.execute(
                "INSERT INTO albums (name, full_path, parent_id) VALUES (?, ?, ?)",
                (seg, curr_full, parent_id)
            )
            last_id = cur.lastrowid
        parent_id = last_id
    if dest_dir is not None:
        (dest_dir / "Albums" / "/".join(acc_parts)).mkdir(parents=True, exist_ok=True)
    return last_id


def _sync_albums_from_files(conn: sqlite3.Connection):
    cur = conn.cursor()
    cur.execute("""
        SELECT DISTINCT album_name, is_trashed FROM processed_files
        WHERE is_duplicate = 0 AND album_name IS NOT NULL AND album_name != ''
          AND (is_trashed = 0 OR (',' || REPLACE(album_name, ', ', ',') || ',') LIKE '%,Google Photos/Corbeille,%')
    """)
    inserted = False
    for r in cur.fetchall():
        is_tr = bool(r["is_trashed"])
        for tok in r["album_name"].split(","):
            tok = tok.strip()
            if not tok:
                continue
            if is_tr and tok != "Google Photos/Corbeille":
                continue
            cur.execute("SELECT 1 FROM albums WHERE full_path = ?", (tok,))
            if not cur.fetchone():
                _ensure_album_path(cur, tok)
                inserted = True
    if inserted:
        conn.commit()


def _probe_video_duration_and_save(video_path: Path, conn: sqlite3.Connection | None = None) -> float | None:
    try:
        cap = cv2.VideoCapture(str(video_path))
        fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0
        cap.release()
        if fps > 0 and frame_count > 0:
            dur = round(float(frame_count / fps), 1)
            if conn is not None:
                conn.execute("UPDATE processed_files SET duration_sec = ? WHERE dest_path = ?", (dur, str(video_path)))
            return dur
    except Exception:
        pass
    return None


def _media_type_sql(media_type: str) -> str:
    if media_type == "VIDEOS":
        return "(" + " OR ".join([f"LOWER(pf.dest_path) LIKE '%{e}'" for e in VIDEO_EXTS]) + ")"
    if media_type == "ANIMATED":
        return "(COALESCE(pf.is_animated, 0) = 1 OR LOWER(pf.dest_path) LIKE '%.gif' OR LOWER(pf.dest_path) LIKE '%.apng')"
    if media_type == "RAW":
        return "(" + " OR ".join([f"LOWER(pf.dest_path) LIKE '%{e}'" for e in RAW_EXTS]) + ")"
    if media_type == "SCREENSHOTS":
        return "(LOWER(pf.dest_path) LIKE '%screenshot%' OR LOWER(pf.dest_path) LIKE '%capture%' OR LOWER(pf.dest_path) LIKE '%ecran%')"
    if media_type == "PHOTOS":
        std_imgs = IMAGE_EXTS - RAW_EXTS - {".gif", ".apng"}
        return "(" + " OR ".join([f"LOWER(pf.dest_path) LIKE '%{e}'" for e in std_imgs]) + ")"
    return ""


def _ensure_animated_flags(conn) -> None:
    cur = conn.cursor()
    cols = {r[1] for r in cur.execute("PRAGMA table_info(processed_files)").fetchall()}
    if "is_animated" not in cols:
        cur.execute("ALTER TABLE processed_files ADD COLUMN is_animated INTEGER DEFAULT NULL")
        conn.commit()
    pending = cur.execute("""
        SELECT source_path, dest_path FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL AND is_animated IS NULL
    """).fetchall()
    if not pending:
        return
    mov_rows = cur.execute("""
        SELECT dest_path FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND LOWER(dest_path) LIKE '%.mov'
    """).fetchall()
    sibling_mov_stems = {(str(Path(r["dest_path"]).parent).lower(), Path(r["dest_path"]).stem.lower()) for r in mov_rows}
    updates = []
    for r in pending:
        flag = detect_is_animated(r["dest_path"], sibling_mov_stems=sibling_mov_stems)
        updates.append((flag, r["source_path"]))
    if updates:
        cur.executemany("UPDATE processed_files SET is_animated = ? WHERE source_path = ?", updates)
        conn.commit()


def _build_gallery_where(
    year: str = "", month: str = "", album: str = "",
    favorites_only: bool = False, no_faces_only: bool = False,
    media_type: str = "", ext_filter: str = "", require_timestamp: bool = False,
    date_from: str = "", date_to: str = "", periods: str = ""
) -> tuple[str, list]:
    include_google_trash_album = (album.strip() == "Google Photos/Corbeille")
    where_clauses = ["pf.is_duplicate = 0", "pf.dest_path IS NOT NULL"]
    if not include_google_trash_album:
        where_clauses.append("pf.is_trashed = 0")
    params = []

    if require_timestamp:
        where_clauses.append("pf.timestamp > 0")

    ym_clauses = []
    ym_params = []
    years_list = [y.strip() for y in str(year or "").split(",") if y.strip()]
    if years_list:
        ph = ",".join(["?"] * len(years_list))
        ym_clauses.append(f"strftime('%Y', datetime(pf.timestamp, 'unixepoch', 'localtime')) IN ({ph})")
        ym_params.extend(years_list)

    months_list = []
    for m in str(month or "").split(","):
        m = m.strip()
        if m.isdigit():
            months_list.append(f"{int(m):02d}")
    if months_list:
        ph = ",".join(["?"] * len(months_list))
        ym_clauses.append(f"strftime('%m', datetime(pf.timestamp, 'unixepoch', 'localtime')) IN ({ph})")
        ym_params.extend(months_list)

    period_pairs = []
    for raw_p in str(periods or "").split(","):
        raw_p = raw_p.strip()
        if not raw_p or ":" not in raw_p:
            continue
        df, dt = raw_p.split(":", 1)
        if df.strip() or dt.strip():
            period_pairs.append((df.strip(), dt.strip()))
    if date_from.strip() or date_to.strip():
        period_pairs.append((date_from.strip(), date_to.strip()))

    period_clauses = []
    period_params = []
    for df, dt in period_pairs:
        sub_c = ["pf.timestamp > 0"]
        sub_p = []
        if df:
            try:
                sub_c.append("pf.timestamp >= ?")
                sub_p.append(int(datetime.strptime(df, "%Y-%m-%d").timestamp()))
            except ValueError:
                pass
        if dt:
            try:
                end_ts = int((datetime.strptime(dt, "%Y-%m-%d") + timedelta(days=1)).timestamp()) - 1
                sub_c.append("pf.timestamp <= ?")
                sub_p.append(end_ts)
            except ValueError:
                pass
        if len(sub_c) > 1:
            period_clauses.append("(" + " AND ".join(sub_c) + ")")
            period_params.extend(sub_p)

    if ym_clauses and period_clauses:
        where_clauses.append("((" + " AND ".join(ym_clauses) + ") OR (" + " OR ".join(period_clauses) + "))")
        params.extend(ym_params)
        params.extend(period_params)
    elif ym_clauses:
        where_clauses.extend(ym_clauses)
        params.extend(ym_params)
    elif period_clauses:
        where_clauses.append("(" + " OR ".join(period_clauses) + ")")
        params.extend(period_params)

    if album:
        where_clauses.append("(',' || REPLACE(COALESCE(pf.album_name, ''), ', ', ',') || ',') LIKE ?")
        params.append(f"%,{album.strip()},%")
    if favorites_only:
        where_clauses.append("pf.is_favorite = 1")
    if no_faces_only:
        where_clauses.append("NOT EXISTS (SELECT 1 FROM faces f WHERE f.dest_path = pf.dest_path)")

    type_clauses = []
    for t in str(media_type or "").split(","):
        sql = _media_type_sql(t.strip().upper())
        if sql:
            type_clauses.append(sql)

    exts_list = [e.strip().lower() for e in str(ext_filter or "").split(",") if e.strip()]
    ext_clauses = []
    ext_params = []
    for ext in exts_list:
        ext_clauses.append("LOWER(pf.dest_path) LIKE ?")
        ext_params.append(f"%{ext}")

    if type_clauses and ext_clauses:
        where_clauses.append("((" + " OR ".join(type_clauses) + ") OR (" + " OR ".join(ext_clauses) + "))")
        params.extend(ext_params)
    elif type_clauses:
        where_clauses.append("(" + " OR ".join(type_clauses) + ")")
    elif ext_clauses:
        where_clauses.append("(" + " OR ".join(ext_clauses) + ")")
        params.extend(ext_params)

    return " AND ".join(where_clauses), params


@router.get("/api/gallery/filters")
def api_gallery_filters():
    conn = get_db()
    _sync_albums_from_files(conn)
    cur = conn.cursor()
    cur.execute("""
        SELECT strftime('%Y', datetime(timestamp, 'unixepoch', 'localtime')) as year, COUNT(*) as count
        FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND timestamp > 0
        GROUP BY year ORDER BY year DESC
    """)
    years = [{"year": r["year"], "count": r["count"]} for r in cur.fetchall() if r["year"]]
    cur.execute("SELECT full_path FROM albums ORDER BY full_path ASC")
    albums = [r["full_path"] for r in cur.fetchall()]

    cur.execute("SELECT dest_path FROM processed_files WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL")
    exts_set = {Path(r["dest_path"]).suffix.lower() for r in cur.fetchall() if Path(r["dest_path"]).suffix}
    conn.close()
    return {"years": years, "albums": albums, "extensions": sorted(exts_set)}


@router.get("/api/gallery/timeline")
def api_gallery_timeline(
    album: str = "", favorites_only: bool = False,
    no_faces_only: bool = False, media_type: str = "",
    ext_filter: str = "", sort_order: str = "desc"
):
    conn = get_db()
    cur = conn.cursor()
    where_sql, params = _build_gallery_where(
        album=album, favorites_only=favorites_only, no_faces_only=no_faces_only,
        media_type=media_type, ext_filter=ext_filter, require_timestamp=True
    )
    direction = "ASC" if sort_order.lower() == "asc" else "DESC"

    cur.execute(f"""
        SELECT strftime('%Y', datetime(pf.timestamp, 'unixepoch', 'localtime')) as y,
               strftime('%m', datetime(pf.timestamp, 'unixepoch', 'localtime')) as m,
               COUNT(*) as cnt
        FROM processed_files pf
        WHERE {where_sql}
        GROUP BY y, m
        ORDER BY y {direction}, m {direction}
    """, params)

    rows = cur.fetchall()
    conn.close()

    timeline = []
    running_offset = 0
    years_map = {}

    for r in rows:
        y, m, cnt = r["y"], r["m"], r["cnt"]
        if not y or not m:
            continue
        if y not in years_map:
            y_obj = {"year": y, "count": 0, "offset": running_offset, "months": []}
            years_map[y] = y_obj
            timeline.append(y_obj)
        years_map[y]["count"] += cnt
        years_map[y]["months"].append({
            "month": m,
            "count": cnt,
            "offset": running_offset
        })
        running_offset += cnt

    return {"timeline": timeline, "total_dated": running_offset}


@router.get("/api/albums/list")
def api_albums_list(parent_id: int | None = None, flat: bool = False):
    conn = get_db()
    _sync_albums_from_files(conn)
    cur = conn.cursor()

    cur.execute("SELECT album_id, name, full_path, parent_id, cover_path, source_dir, created_at, CAST(strftime('%s', created_at) AS INTEGER) as created_ts FROM albums ORDER BY full_path ASC")
    all_rows = [dict(r) for r in cur.fetchall()]

    cur.execute("""
        SELECT album_name, dest_path, timestamp, is_trashed,
               COALESCE(modified_at, CAST(strftime('%s', processed_at) AS INTEGER), timestamp, 0) as mod_ts
        FROM processed_files
        WHERE is_duplicate = 0 AND album_name IS NOT NULL AND album_name != ''
          AND (is_trashed = 0 OR (',' || REPLACE(album_name, ', ', ',') || ',') LIKE '%,Google Photos/Corbeille,%')
    """)
    stats_by_album: dict[str, dict] = {}
    for r in cur.fetchall():
        is_tr = bool(r["is_trashed"])
        for tok in r["album_name"].split(","):
            tok = tok.strip()
            if not tok:
                continue
            if is_tr and tok != "Google Photos/Corbeille":
                continue
            st = stats_by_album.setdefault(tok, {"count": 0, "cover_path": None, "max_ts": 0, "max_mod_ts": 0})
            st["count"] += 1
            ts = r["timestamp"] or 0
            mod_ts = r["mod_ts"] or 0
            if ts >= st["max_ts"] or not st["cover_path"]:
                st["max_ts"] = ts
                st["cover_path"] = r["dest_path"]
            if mod_ts > st["max_mod_ts"]:
                st["max_mod_ts"] = mod_ts

    children_count: dict[int, int] = {}
    for a in all_rows:
        pid = a["parent_id"]
        if pid is not None:
            children_count[pid] = children_count.get(pid, 0) + 1

    explicit_covers = {a["full_path"]: a["cover_path"] for a in all_rows if a.get("cover_path")}

    enriched = []
    for a in all_rows:
        fp = a["full_path"]
        direct_st = stats_by_album.get(fp, {"count": 0, "cover_path": None, "max_ts": 0, "max_mod_ts": 0})
        recursive_count = direct_st["count"]
        fallback_cover = direct_st["cover_path"]
        max_ts = direct_st["max_ts"]
        max_mod_ts = direct_st["max_mod_ts"]
        prefix = fp + "/"
        sub_explicit_cover = None
        if not a.get("cover_path") and not fallback_cover:
            for sub_fp, sub_cov in explicit_covers.items():
                if sub_fp.startswith(prefix):
                    sub_explicit_cover = sub_cov
                    break
        for other_fp, ost in stats_by_album.items():
            if other_fp.startswith(prefix):
                recursive_count += ost["count"]
                if ost["max_ts"] >= max_ts or not fallback_cover:
                    fallback_cover = ost["cover_path"]
                if ost["max_ts"] > max_ts:
                    max_ts = ost["max_ts"]
                if ost["max_mod_ts"] > max_mod_ts:
                    max_mod_ts = ost["max_mod_ts"]

        enriched.append({
            "album_id": a["album_id"],
            "name": a["name"],
            "album_name": fp,
            "full_path": fp,
            "parent_id": a["parent_id"],
            "count": recursive_count,
            "direct_count": direct_st["count"],
            "subalbums_count": children_count.get(a["album_id"], 0),
            "cover_path": a["cover_path"] or sub_explicit_cover or fallback_cover or "",
            "source_dir": a.get("source_dir") or "",
            "max_ts": max_ts,
            "modified_ts": max_mod_ts or (a.get("created_ts") or 0),
            "created_at": a.get("created_at") or "",
        })

    conn.close()
    if flat:
        return {"albums": enriched, "all_albums": enriched}

    filtered = [a for a in enriched if a["parent_id"] == parent_id]
    filtered.sort(key=lambda x: (x["max_ts"], x["name"].lower()), reverse=True)
    return {"albums": filtered, "all_albums": enriched}


@router.post("/api/albums/create")
def api_create_album(payload: CreateAlbumPayload):
    seg = _sanitize_album_segment(payload.name)
    if not seg:
        raise HTTPException(400, "Le nom de l'album ne peut pas être vide.")

    conn = get_db()
    cur = conn.cursor()
    _, dest_dir = get_active_db_and_dest()

    if payload.parent_id is not None:
        cur.execute("SELECT full_path FROM albums WHERE album_id = ?", (payload.parent_id,))
        parent = cur.fetchone()
        if not parent:
            conn.close()
            raise HTTPException(404, "Album parent introuvable.")
        full_path = f"{parent['full_path']}/{seg}"
    else:
        full_path = seg

    cur.execute("SELECT album_id FROM albums WHERE full_path = ?", (full_path,))
    if cur.fetchone():
        conn.close()
        raise HTTPException(400, "Un album portant ce nom existe déjà à cet emplacement.")

    src_dir_clean = (payload.source_dir or "").strip() or None
    if src_dir_clean:
        cfg = load_libraries()
        active_lib = cfg.get("libraries", {}).get(cfg.get("active_library") or "", {})
        allowed_roots = {str(Path(p).resolve()) for p in (active_lib.get("source_paths") or []) if p}
        allowed_roots.add(str(dest_dir.resolve()))
        resolved_src = str(Path(src_dir_clean).resolve())
        if resolved_src not in allowed_roots:
            conn.close()
            raise HTTPException(400, "Dossier source invalide pour cette bibliothèque.")
        src_dir_clean = resolved_src

    cur.execute(
        "INSERT INTO albums (name, full_path, parent_id, source_dir) VALUES (?, ?, ?, ?)",
        (seg, full_path, payload.parent_id, src_dir_clean)
    )
    new_id = cur.lastrowid
    (dest_dir / "Albums" / full_path).mkdir(parents=True, exist_ok=True)
    if src_dir_clean:
        (Path(src_dir_clean) / "Albums" / full_path).mkdir(parents=True, exist_ok=True)
    conn.commit()
    conn.close()
    log_library_action(
        "ALBUM_CREATE",
        "Album créé",
        f"Album « {full_path} » créé",
    )
    return {
        "status": "created",
        "album": {"album_id": new_id, "name": seg, "full_path": full_path, "parent_id": payload.parent_id, "source_dir": src_dir_clean}
    }


@router.post("/api/albums/rename")
def api_rename_album(payload: RenameAlbumPayload):
    new_seg = _sanitize_album_segment(payload.new_name)
    if not new_seg:
        raise HTTPException(400, "Le nouveau nom ne peut pas être vide.")

    conn = get_db()
    cur = conn.cursor()
    _, dest_dir = get_active_db_and_dest()

    cur.execute("SELECT album_id, name, full_path, parent_id FROM albums WHERE album_id = ?", (payload.album_id,))
    alb = cur.fetchone()
    if not alb:
        conn.close()
        raise HTTPException(404, "Album introuvable.")

    old_full = alb["full_path"]
    if "/" in old_full:
        parent_prefix = old_full.rsplit("/", 1)[0]
        new_full = f"{parent_prefix}/{new_seg}"
    else:
        new_full = new_seg

    if new_full == old_full:
        conn.close()
        return {"status": "unchanged", "full_path": new_full}

    cur.execute("SELECT album_id FROM albums WHERE full_path = ?", (new_full,))
    if cur.fetchone():
        conn.close()
        raise HTTPException(400, "Un album avec ce nom existe déjà.")

    # Met à jour l'album et tous ses sous-albums
    cur.execute("UPDATE albums SET name = ?, full_path = ? WHERE album_id = ?", (new_seg, new_full, payload.album_id))
    cur.execute("SELECT album_id, full_path FROM albums WHERE full_path LIKE ?", (f"{old_full}/%",))
    for sub in cur.fetchall():
        sub_new = new_full + sub["full_path"][len(old_full):]
        cur.execute("UPDATE albums SET full_path = ? WHERE album_id = ?", (sub_new, sub["album_id"]))

    # Met à jour les tokens dans processed_files.album_name
    cur.execute("SELECT source_path, album_name FROM processed_files WHERE album_name IS NOT NULL AND album_name != ''")
    for r in cur.fetchall():
        tokens = [t.strip() for t in r["album_name"].split(",") if t.strip()]
        changed = False
        new_tokens = []
        for t in tokens:
            if t == old_full:
                new_tokens.append(new_full)
                changed = True
            elif t.startswith(old_full + "/"):
                new_tokens.append(new_full + t[len(old_full):])
                changed = True
            else:
                new_tokens.append(t)
        if changed:
            cur.execute(
                "UPDATE processed_files SET album_name = ? WHERE source_path = ?",
                (", ".join(dict.fromkeys(new_tokens)), r["source_path"])
            )

    old_dir = dest_dir / "Albums" / old_full
    new_dir = dest_dir / "Albums" / new_full
    if old_dir.exists() and not new_dir.exists():
        new_dir.parent.mkdir(parents=True, exist_ok=True)
        try:
            shutil.move(str(old_dir), str(new_dir))
        except Exception:
            pass

    conn.commit()
    conn.close()
    log_library_action(
        "ALBUM_RENAME",
        "Album renommé",
        f"« {old_full} » renommé en « {new_full} »",
    )
    return {"status": "renamed", "album_id": payload.album_id, "name": new_seg, "full_path": new_full}


@router.post("/api/albums/delete")
def api_delete_album(payload: DeleteAlbumPayload):
    conn = get_db()
    cur = conn.cursor()
    _, dest_dir = get_active_db_and_dest()

    cur.execute("SELECT album_id, full_path FROM albums WHERE album_id = ?", (payload.album_id,))
    alb = cur.fetchone()
    if not alb:
        conn.close()
        raise HTTPException(404, "Album introuvable.")

    target_full = alb["full_path"]
    removed_paths = {target_full}

    if payload.delete_subalbums:
        cur.execute("SELECT album_id, full_path FROM albums WHERE full_path LIKE ?", (f"{target_full}/%",))
        sub_rows = cur.fetchall()
        for sr in sub_rows:
            removed_paths.add(sr["full_path"])
        cur.execute("DELETE FROM albums WHERE full_path LIKE ?", (f"{target_full}/%",))

    cur.execute("DELETE FROM albums WHERE album_id = ?", (payload.album_id,))

    cur.execute("SELECT source_path, album_name FROM processed_files WHERE album_name IS NOT NULL AND album_name != ''")
    for r in cur.fetchall():
        tokens = [t.strip() for t in r["album_name"].split(",") if t.strip()]
        kept = [t for t in tokens if t not in removed_paths]
        if len(kept) != len(tokens):
            cur.execute(
                "UPDATE processed_files SET album_name = ? WHERE source_path = ?",
                (", ".join(kept) if kept else None, r["source_path"])
            )

    alb_dir = dest_dir / "Albums" / target_full
    if alb_dir.exists() and alb_dir.is_dir():
        shutil.rmtree(alb_dir, ignore_errors=True)

    conn.commit()
    conn.close()
    log_library_action(
        "ALBUM_DELETE",
        "Album supprimé",
        f"Album « {target_full} » supprimé",
    )
    return {"status": "deleted", "removed": sorted(removed_paths)}


@router.post("/api/albums/set_cover")
def api_set_album_cover(payload: SetAlbumCoverPayload):
    conn = get_db()
    conn.execute("UPDATE albums SET cover_path = ? WHERE album_id = ?", (payload.cover_path, payload.album_id))
    conn.commit()
    conn.close()
    return {"status": "updated"}


@router.get("/api/types/summary")
def api_types_summary():
    conn = get_db()
    _ensure_animated_flags(conn)
    cur = conn.cursor()
    cur.execute("""
        SELECT dest_path, file_size, COALESCE(is_animated, 0) as is_animated FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
    """)
    cats = {
        "PHOTOS": {"count": 0, "bytes": 0},
        "VIDEOS": {"count": 0, "bytes": 0},
        "ANIMATED": {"count": 0, "bytes": 0},
        "RAW": {"count": 0, "bytes": 0},
        "SCREENSHOTS": {"count": 0, "bytes": 0},
    }
    exts = {}

    for r in cur.fetchall():
        p = Path(r["dest_path"])
        ext = p.suffix.lower()
        sz = r["file_size"] or 0
        name_low = p.stem.lower()

        exts.setdefault(ext, {"ext": ext, "count": 0, "mb": 0.0})
        exts[ext]["count"] += 1
        exts[ext]["mb"] = round(exts[ext]["mb"] + sz / (1024 * 1024), 1)

        if r["is_animated"] == 1:
            cats["ANIMATED"]["count"] += 1
            cats["ANIMATED"]["bytes"] += sz
        elif "screenshot" in name_low or "capture" in name_low or "ecran" in name_low:
            cats["SCREENSHOTS"]["count"] += 1
            cats["SCREENSHOTS"]["bytes"] += sz
        elif ext in RAW_EXTS:
            cats["RAW"]["count"] += 1
            cats["RAW"]["bytes"] += sz
        elif ext in VIDEO_EXTS:
            cats["VIDEOS"]["count"] += 1
            cats["VIDEOS"]["bytes"] += sz
        elif ext in IMAGE_EXTS:
            cats["PHOTOS"]["count"] += 1
            cats["PHOTOS"]["bytes"] += sz

    conn.close()
    summary = {k: {"count": v["count"], "gb": round(v["bytes"] / (1024**3), 2)} for k, v in cats.items()}
    ext_list = sorted(exts.values(), key=lambda x: x["count"], reverse=True)
    return {"categories": summary, "extensions": ext_list}


class SmartCategoryCreatePayload(BaseModel):
    name: str
    prompt: str = ""


class SmartCategoryDeletePayload(BaseModel):
    category_id: int


class SmartCategoryAssignPayload(BaseModel):
    category_id: int
    source_paths: list[str]
    action: str = "ADD"


def _heuristic_where_for_category(name: str, tables: set[str]) -> str:
    low = (name or "").lower()
    if "capture" in low or "screenshot" in low or "écran" in low or "ecran" in low:
        return "(LOWER(pf.dest_path) LIKE '%screenshot%' OR LOWER(pf.dest_path) LIKE '%capture%' OR LOWER(pf.dest_path) LIKE '%ecran%')"
    if "document" in low or "facture" in low:
        ocr_cond = " OR EXISTS (SELECT 1 FROM ocr_results o WHERE o.source_path = pf.source_path AND COALESCE(o.line_count, 0) >= 5)" if "ocr_results" in tables else ""
        return f"(LOWER(pf.dest_path) LIKE '%doc%' OR LOWER(pf.dest_path) LIKE '%scan%' OR LOWER(pf.dest_path) LIKE '%facture%' OR LOWER(pf.dest_path) LIKE '%receipt%'{ocr_cond})"
    return ""


@router.get("/api/categories/list")
def api_categories_list():
    conn = get_db()
    cur = conn.cursor()
    tables = {r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    cols = {r[1] for r in cur.execute("PRAGMA table_info(processed_files)").fetchall()}
    ai_indexed = 0
    if "clip_embedding" in cols:
        ai_indexed = int(cur.execute("SELECT COUNT(*) FROM processed_files WHERE is_duplicate = 0 AND is_trashed = 0 AND clip_embedding IS NOT NULL").fetchone()[0] or 0)

    cur.execute("SELECT category_id, name, prompt, source FROM smart_categories ORDER BY category_id ASC")
    cats = [dict(r) for r in cur.fetchall()]

    out = []
    for c in cats:
        cid = c["category_id"]
        heur = _heuristic_where_for_category(c["name"], tables)
        heur_sql = f" OR {heur}" if heur else ""
        row = cur.execute(f"""
            SELECT COUNT(DISTINCT pf.source_path) as cnt,
                   (SELECT pf2.dest_path FROM processed_files pf2
                    WHERE pf2.is_duplicate = 0 AND pf2.is_trashed = 0 AND pf2.dest_path IS NOT NULL
                      AND (EXISTS (SELECT 1 FROM media_categories mc2 WHERE mc2.source_path = pf2.source_path AND mc2.category_id = ?)
                           {heur_sql.replace('pf.', 'pf2.')})
                    ORDER BY COALESCE(pf2.timestamp, 0) DESC LIMIT 1) as cover_path
            FROM processed_files pf
            WHERE pf.is_duplicate = 0 AND pf.is_trashed = 0 AND pf.dest_path IS NOT NULL
              AND (EXISTS (SELECT 1 FROM media_categories mc WHERE mc.source_path = pf.source_path AND mc.category_id = ?)
                   {heur_sql})
        """, (cid, cid)).fetchone()
        cnt = int(row["cnt"] or 0) if row else 0
        if c["source"] == "AI" and cnt == 0:
            continue
        out.append({
            "category_id": cid,
            "name": c["name"],
            "prompt": c["prompt"],
            "source": c["source"],
            "count": cnt,
            "cover_path": row["cover_path"] if row else None,
        })
    conn.close()
    return {"categories": out, "ai_indexed": ai_indexed}


@router.post("/api/categories/create")
def api_categories_create(payload: SmartCategoryCreatePayload):
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Nom de catégorie requis.")
    prompt = (payload.prompt or "").strip() or name
    from prompt_translator import translate_fr_to_en
    prompt_en = _AI_CATEGORY_EN_PROMPTS.get(name) or translate_fr_to_en(prompt)

    conn = get_db()
    try:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO smart_categories (name, prompt, prompt_en, source) VALUES (?, ?, ?, 'MANUAL')",
            (name, prompt, prompt_en),
        )
        cid = cur.lastrowid
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(status_code=400, detail="Cette catégorie existe déjà.")

    # Si des empreintes CLIP existent déjà en base, associer instantanément sans ré-analyser les images
    assigned = 0
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(processed_files)").fetchall()}
        if "clip_embedding" in cols:
            has_emb = conn.execute("SELECT 1 FROM processed_files WHERE is_duplicate = 0 AND is_trashed = 0 AND clip_embedding IS NOT NULL LIMIT 1").fetchone()
            if has_emb:
                db_p, _ = get_active_db_and_dest()
                from indexeur_semantique_gps import search_photos_by_natural_text
                from settings_manager import load_settings
                clip_key = str(load_settings().get("clip_model", "vit-b-32")).strip().lower()
                q_prompt = resolve_clip_category_prompt(name, prompt, clip_key, prompt_en=prompt_en)
                min_sc = 0.22 if clip_key == "vit-b-32" else 0.19
                matches = search_photos_by_natural_text(db_p, q_prompt, top_k=200, min_score=min_sc, already_english=(clip_key != "vit-b-32"))
                for m in matches:
                    conn.execute(
                        "INSERT OR IGNORE INTO media_categories (source_path, category_id, assigned_by, score) VALUES (?, ?, 'AI', ?)",
                        (m["source_path"], cid, float(m.get("similarity", 0)) / 100.0),
                    )
                    assigned += 1
                conn.commit()
    except Exception:
        pass
    conn.close()
    return {"status": "ok", "category_id": cid, "name": name, "prompt": prompt, "assigned": assigned}


@router.post("/api/categories/delete")
def api_categories_delete(payload: SmartCategoryDeletePayload):
    conn = get_db()
    conn.execute("DELETE FROM media_categories WHERE category_id = ?", (payload.category_id,))
    conn.execute("DELETE FROM smart_categories WHERE category_id = ?", (payload.category_id,))
    conn.commit()
    conn.close()
    return {"status": "ok"}


@router.post("/api/categories/assign")
def api_categories_assign(payload: SmartCategoryAssignPayload):
    if not payload.source_paths:
        return {"status": "ok", "updated": 0}
    conn = get_db()
    cur = conn.cursor()
    updated = 0
    if payload.action.upper() == "REMOVE":
        for sp in payload.source_paths:
            cur.execute("DELETE FROM media_categories WHERE source_path = ? AND category_id = ?", (sp, payload.category_id))
            updated += cur.rowcount
    else:
        for sp in payload.source_paths:
            cur.execute(
                "INSERT OR REPLACE INTO media_categories (source_path, category_id, assigned_by, score) VALUES (?, ?, 'MANUAL', 1.0)",
                (sp, payload.category_id),
            )
            updated += 1
    conn.commit()
    conn.close()
    if updated > 0:
        is_rem = payload.action.upper() == "REMOVE"
        log_library_action(
            "CATEGORY_ASSIGN",
            "Catégorie retirée" if is_rem else "Catégorie assignée",
            f"{updated} fichier(s) {'retiré(s) de' if is_rem else 'assigné(s) à'} la catégorie #{payload.category_id}",
            files=[build_file_entry(sp) for sp in payload.source_paths],
        )
    return {"status": "ok", "updated": updated}


@router.get("/api/categories/items")
def api_categories_items(category_id: int):
    conn = get_db()
    cur = conn.cursor()
    cat = cur.execute("SELECT category_id, name, prompt, source FROM smart_categories WHERE category_id = ?", (category_id,)).fetchone()
    if not cat:
        conn.close()
        raise HTTPException(status_code=404, detail="Catégorie introuvable.")
    tables = {r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    heur = _heuristic_where_for_category(cat["name"], tables)
    heur_sql = f" OR {heur}" if heur else ""
    cur.execute(f"""
        SELECT pf.source_path, pf.dest_path, pf.timestamp, pf.is_favorite, pf.album_name,
               COALESCE(mc.assigned_by, 'AUTO') as assigned_by
        FROM processed_files pf
        LEFT JOIN media_categories mc ON mc.source_path = pf.source_path AND mc.category_id = ?
        WHERE pf.is_duplicate = 0 AND pf.is_trashed = 0 AND pf.dest_path IS NOT NULL
          AND (mc.source_path IS NOT NULL{heur_sql})
        ORDER BY COALESCE(pf.timestamp, 0) DESC
        LIMIT 300
    """, (category_id,))
    items = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"category": dict(cat), "items": items, "total": len(items)}


_AI_CATEGORY_CATALOG = [
    ("Portraits", "portrait visage personne selfie regard"),
    ("Personnes & Groupes", "groupe personnes amis famille ensemble"),
    ("Enfants", "enfant bébé jeune garçon fille"),
    ("Captures d'écran", "capture d'écran interface téléphone ordinateur"),
    ("Documents", "document papier facture texte reçu lettre"),
    ("Livres", "livre page bibliothèque lecture"),
    ("Paysages", "paysage panorama vue nature campagne horizon"),
    ("Arbres & Forêts", "arbre forêt bois nature feuilles"),
    ("Fleurs & Plantes", "fleur plante jardin bouquet"),
    ("Montagnes", "montagne sommet randonnée paysage"),
    ("Plage & Mer", "plage mer océan sable vagues"),
    ("Eau & Lacs", "lac rivière cascade étang eau reflet"),
    ("Ciel & Nuages", "ciel bleu nuages soleil horizon"),
    ("Couchers de soleil", "coucher de soleil lever de soleil ciel coloré"),
    ("Neige & Hiver", "neige hiver ski montagne enneigée"),
    ("Chiens", "chien chiot animal"),
    ("Chats", "chat chaton animal"),
    ("Animaux", "animal oiseau faune sauvage"),
    ("Nourriture", "plat nourriture repas restaurant gâteau"),
    ("Boissons & Cafés", "café verre boisson cocktail vin"),
    ("Voitures", "voiture automobile route véhicule"),
    ("Vélos & Motos", "vélo bicyclette moto"),
    ("Avions & Voyages", "avion aéroport vol voyage"),
    ("Trains & Gares", "train gare rail métro"),
    ("Bateaux", "bateau navire port voilier"),
    ("Ponts", "pont rivière viaduc architecture"),
    ("Rue & Ville", "rue ville bâtiment urbain trottoir place"),
    ("Architecture", "bâtiment monument église château immeuble"),
    ("Intérieurs", "salon chambre cuisine maison intérieur"),
    ("Fêtes & Soirées", "fête anniversaire soirée groupe amis"),
    ("Concerts & Musique", "concert scène musique instrument"),
    ("Sport", "sport football course vélo natation"),
    ("Nuit", "nuit étoiles éclairage nocturne ville nuit"),
    ("Art & Musées", "tableau peinture sculpture musée art"),
]

_AI_CATEGORY_EN_PROMPTS = {
    "Portraits": "a photo of a person portrait face closeup",
    "Personnes & Groupes": "a photo of people group of friends or family together",
    "Enfants": "a photo of a baby toddler or child",
    "Captures d'écran": "a screenshot of a phone or computer user interface",
    "Documents": "a photo or scan of a paper document text receipt letter",
    "Livres": "a photo of a book page library reading",
    "Paysages": "a landscape scenery wide view of nature countryside",
    "Arbres & Forêts": "a photo of trees forest woods leaves nature",
    "Fleurs & Plantes": "a photo of flowers plants garden bouquet",
    "Montagnes": "a photo of mountains peaks hiking landscape",
    "Plage & Mer": "a photo of a beach sea ocean sand waves",
    "Eau & Lacs": "a photo of a lake river waterfall pond water reflection",
    "Ciel & Nuages": "a photo of the sky clouds sunlight",
    "Couchers de soleil": "a photo of a sunset or sunrise colorful sky",
    "Neige & Hiver": "a photo of snow winter skiing snowy landscape",
    "Chiens": "a photo of a dog or puppy",
    "Chats": "a photo of a cat or kitten",
    "Animaux": "a photo of an animal bird wildlife",
    "Nourriture": "a photo of food meal dish restaurant cake",
    "Boissons & Cafés": "a photo of coffee drink glass cocktail wine",
    "Voitures": "a photo of a car automobile road vehicle",
    "Vélos & Motos": "a photo of a bicycle or motorcycle",
    "Avions & Voyages": "a photo of an airplane airport flight travel",
    "Trains & Gares": "a photo of a train railway station metro",
    "Bateaux": "a photo of a boat ship harbor sailboat",
    "Ponts": "a photo of a bridge river viaduct",
    "Rue & Ville": "a photo of a city street urban buildings sidewalk",
    "Architecture": "a photo of architecture building monument church castle",
    "Intérieurs": "a photo of an indoor room living room bedroom kitchen home",
    "Fêtes & Soirées": "a photo of a party birthday celebration evening with friends",
    "Concerts & Musique": "a photo of a concert stage live music instrument",
    "Sport": "a photo of sports running cycling swimming football",
    "Nuit": "a night photo stars night lights city at night",
    "Art & Musées": "a photo of a painting sculpture artwork museum",
}


def resolve_clip_category_prompt(name: str, fr_prompt: str, clip_key: str | None = None, prompt_en: str | None = None) -> str:
    """Retourne le prompt adapté au modèle CLIP actif (FR pour vit-b-32 multilingue, EN sinon)."""
    key = (clip_key or "vit-b-32").strip().lower()
    if key == "vit-b-32":
        return fr_prompt or name
    if prompt_en and prompt_en.strip():
        return prompt_en.strip()
    if name in _AI_CATEGORY_EN_PROMPTS:
        return _AI_CATEGORY_EN_PROMPTS[name]
    from prompt_translator import translate_fr_to_en
    return translate_fr_to_en(fr_prompt or name)


@router.post("/api/categories/analyze")
def api_categories_analyze():
    db_p, _ = get_active_db_and_dest()
    conn = get_db()
    cur = conn.cursor()
    cols = {r[1] for r in cur.execute("PRAGMA table_info(processed_files)").fetchall()}
    if "clip_embedding" not in cols:
        conn.close()
        return {"status": "no_embeddings", "assigned": 0}
    total_emb = int(cur.execute("SELECT COUNT(*) FROM processed_files WHERE is_duplicate = 0 AND is_trashed = 0 AND clip_embedding IS NOT NULL").fetchone()[0] or 0)
    if total_emb == 0:
        conn.close()
        return {"status": "no_embeddings", "assigned": 0}

    existing_cats = [dict(r) for r in cur.execute("SELECT category_id, name, prompt, prompt_en, source FROM smart_categories").fetchall()]
    conn.close()

    from indexeur_semantique_gps import search_photos_by_natural_text
    from settings_manager import load_settings
    clip_key = str(load_settings().get("clip_model", "vit-b-32")).strip().lower()
    min_existing_score = 0.22 if clip_key == "vit-b-32" else 0.19
    min_catalog_score = 0.23 if clip_key == "vit-b-32" else 0.20

    assigned = 0
    conn = get_db()
    cur = conn.cursor()
    cur.execute("DELETE FROM media_categories WHERE assigned_by = 'AI'")

    # 1. Analyser les catégories existantes (manuelles + IA déjà créées)
    seen_names = set()
    for c in existing_cats:
        seen_names.add(c["name"].lower())
        q_prompt = resolve_clip_category_prompt(c["name"], c["prompt"] or c["name"], clip_key, prompt_en=c.get("prompt_en"))
        if clip_key != "vit-b-32" and not c.get("prompt_en"):
            cur.execute("UPDATE smart_categories SET prompt_en = ? WHERE category_id = ?", (q_prompt, c["category_id"]))
        matches = search_photos_by_natural_text(db_p, q_prompt, top_k=200, min_score=min_existing_score, already_english=(clip_key != "vit-b-32"))
        for m in matches:
            cur.execute(
                "INSERT OR IGNORE INTO media_categories (source_path, category_id, assigned_by, score) VALUES (?, ?, 'AI', ?)",
                (m["source_path"], c["category_id"], float(m.get("similarity", 0)) / 100.0),
            )
            assigned += cur.rowcount

    # 2. Découvrir automatiquement les catégories du catalogue qui ont de vrais résultats
    for c_name, c_prompt in _AI_CATEGORY_CATALOG:
        if c_name.lower() in seen_names:
            continue
        q_prompt = resolve_clip_category_prompt(c_name, c_prompt, clip_key)
        matches = search_photos_by_natural_text(db_p, q_prompt, top_k=200, min_score=min_catalog_score, already_english=(clip_key != "vit-b-32"))
        if not matches:
            continue
        en_val = _AI_CATEGORY_EN_PROMPTS.get(c_name)
        cur.execute(
            "INSERT OR IGNORE INTO smart_categories (name, prompt, prompt_en, source) VALUES (?, ?, ?, 'AI')",
            (c_name, c_prompt, en_val),
        )
        row = cur.execute("SELECT category_id FROM smart_categories WHERE name = ?", (c_name,)).fetchone()
        if not row:
            continue
        cid = row["category_id"]
        for m in matches:
            cur.execute(
                "INSERT OR IGNORE INTO media_categories (source_path, category_id, assigned_by, score) VALUES (?, ?, 'AI', ?)",
                (m["source_path"], cid, float(m.get("similarity", 0)) / 100.0),
            )
            assigned += cur.rowcount

    # Supprimer les catégories IA vides
    cur.execute("""
        DELETE FROM smart_categories
        WHERE source = 'AI'
          AND NOT EXISTS (SELECT 1 FROM media_categories mc WHERE mc.category_id = smart_categories.category_id)
    """)
    conn.commit()
    conn.close()
    return {"status": "ok", "assigned": assigned}


@router.get("/api/gallery/items")
def api_gallery_items(
    year: str = "", month: str = "", album: str = "",
    favorites_only: bool = False, no_faces_only: bool = False,
    media_type: str = "", ext_filter: str = "",
    date_from: str = "", date_to: str = "", periods: str = "",
    group_id: int | None = None,
    sort_by: str = "date", sort_order: str = "desc",
    page: int = 1, limit: int = 60, skip_to: int = -1
):
    conn = get_db()
    if "ANIMATED" in str(media_type or "").upper():
        _ensure_animated_flags(conn)
    conn.create_function("BASENAME", 1, lambda p: Path(p).name.lower() if p else "")
    cur = conn.cursor()
    offset = skip_to if skip_to >= 0 else (page - 1) * limit
    where_sql, params = _build_gallery_where(
        year=year, month=month, album=album,
        favorites_only=favorites_only, no_faces_only=no_faces_only,
        media_type=media_type, ext_filter=ext_filter, require_timestamp=False,
        date_from=date_from, date_to=date_to, periods=periods
    )
    if group_id is not None:
        where_sql = f"{where_sql} AND pf.source_path IN (SELECT item_key FROM custom_group_items WHERE group_id = ?)"
        params.append(group_id)

    direction = "ASC" if sort_order.lower() == "asc" else "DESC"
    if sort_by == "name":
        order_sql = f"BASENAME(pf.dest_path) {direction}, LOWER(pf.dest_path) {direction}"
    elif sort_by == "modified":
        order_sql = f"COALESCE(pf.modified_at, CAST(strftime('%s', pf.processed_at) AS INTEGER), pf.timestamp, 0) {direction}, pf.rowid {direction}"
    elif sort_by == "added":
        order_sql = f"COALESCE(pf.processed_at, '') {direction}, pf.rowid {direction}"
    else:
        order_sql = f"pf.timestamp {direction}"

    cur.execute(f"SELECT COUNT(*) FROM processed_files pf WHERE {where_sql}", params)
    total = cur.fetchone()[0]

    cur.execute(f"""
        SELECT pf.source_path, pf.dest_path, pf.timestamp, pf.processed_at,
               COALESCE(pf.modified_at, CAST(strftime('%s', pf.processed_at) AS INTEGER), pf.timestamp, 0) as modified_ts,
               pf.is_favorite, pf.album_name, pf.file_size, pf.width, pf.height, pf.duration_sec,
               COALESCE(pf.is_animated, 0) as is_animated
        FROM processed_files pf
        WHERE {where_sql}
        ORDER BY {order_sql}
        LIMIT ? OFFSET ?
    """, [*params, limit, offset])

    items = [dict(r) for r in cur.fetchall()]
    if items:
        dest_list = list({it["dest_path"] for it in items if it.get("dest_path")})
        faces_map: dict[str, tuple[str | None, int]] = {}
        if dest_list:
            placeholders = ",".join("?" for _ in dest_list)
            cur.execute(f"""
                SELECT f.dest_path,
                       GROUP_CONCAT(COALESCE(p.name, 'Inconnu'), ', ') AS detected_people,
                       COUNT(*) AS face_count
                FROM faces f
                LEFT JOIN persons p ON f.person_id = p.person_id
                WHERE f.dest_path IN ({placeholders})
                GROUP BY f.dest_path
            """, dest_list)
            for fr in cur.fetchall():
                faces_map[fr["dest_path"]] = (fr["detected_people"], int(fr["face_count"] or 0))
        for it in items:
            dp = it.get("dest_path") or ""
            people_str, f_cnt = faces_map.get(dp, (None, 0))
            it["detected_people"] = people_str
            it["face_count"] = f_cnt
    updated_dur = False
    for it in items:
        dp = it.get("dest_path") or ""
        if Path(dp).suffix.lower() in VIDEO_EXTS and not it.get("duration_sec"):
            actual_v = resolve_actual_path(dp)
            if actual_v:
                dur = _probe_video_duration_and_save(actual_v, conn)
                if dur:
                    it["duration_sec"] = dur
                    updated_dur = True
    if updated_dur:
        conn.commit()
    conn.close()
    return {"items": items, "total": total, "page": page, "total_pages": max(1, (total + limit - 1) // limit)}


@router.post("/api/media/toggle_favorite")
def api_toggle_favorite(payload: ToggleFavoritePayload):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT dest_path, is_favorite FROM processed_files WHERE source_path = ?", (payload.source_path,))
    row = cur.fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Média introuvable")
    new_fav = 0 if row["is_favorite"] else 1
    dest_path = Path(row["dest_path"])
    _, active_dest = get_active_db_and_dest()
    fav_dir = active_dest / "Favoris"
    fav_dir.mkdir(parents=True, exist_ok=True)
    link = fav_dir / dest_path.name

    if new_fav == 1 and dest_path.exists() and not link.exists():
        try:
            os.link(dest_path, link)
        except Exception:
            pass
    elif new_fav == 0 and link.exists() and link != dest_path:
        link.unlink(missing_ok=True)

    cur.execute("UPDATE processed_files SET is_favorite = ? WHERE source_path = ?", (new_fav, payload.source_path))
    conn.commit()
    conn.close()
    log_library_action(
        "FAVORITE",
        "Favori ajouté" if new_fav == 1 else "Retiré des favoris",
        f"{dest_path.name} {'ajouté aux favoris' if new_fav == 1 else 'retiré des favoris'}",
        files=[build_file_entry(str(dest_path))],
    )
    return {"status": "updated", "is_favorite": new_fav}


@router.post("/api/gallery/batch_action")
def api_gallery_batch_action(payload: GalleryBatchActionPayload):
    if payload.action == "TRASH":
        return api_trash_action(TrashActionPayload(source_paths=payload.source_paths, action="MOVE_TO_TRASH"))
    conn = get_db()
    cur = conn.cursor()
    _, active_dest = get_active_db_and_dest()
    placeholders = ",".join("?" for _ in payload.source_paths)
    cur.execute(f"SELECT source_path, dest_path, is_favorite, album_name FROM processed_files WHERE source_path IN ({placeholders})", payload.source_paths)
    rows = cur.fetchall()
    target_album = (payload.album_name or "").strip()
    if payload.action == "ALBUM_ADD" and target_album:
        _ensure_album_path(cur, target_album, active_dest)

    for r in rows:
        src = r["source_path"]
        dest_p = Path(r["dest_path"])
        fav = r["is_favorite"] or 0
        albums = [a.strip() for a in (r["album_name"] or "").split(",") if a.strip()]
        if payload.action == "FAVORITE_ADD":
            fav = 1
        elif payload.action == "FAVORITE_REMOVE":
            fav = 0
        elif payload.action == "ALBUM_ADD" and target_album:
            if target_album not in albums:
                albums.append(target_album)
            alb_dir = active_dest / "Albums" / target_album
            alb_dir.mkdir(parents=True, exist_ok=True)
            if dest_p.exists() and not (alb_dir / dest_p.name).exists():
                try:
                    os.link(dest_p, alb_dir / dest_p.name)
                except Exception:
                    pass
        elif payload.action == "ALBUM_REMOVE":
            if target_album:
                albums = [a for a in albums if a != target_album]
                link_p = active_dest / "Albums" / target_album / dest_p.name
                if link_p.exists() and link_p != dest_p:
                    link_p.unlink(missing_ok=True)
                cur.execute(
                    "UPDATE albums SET cover_path = NULL WHERE full_path = ? AND cover_path = ?",
                    (target_album, r["dest_path"]),
                )
            else:
                albums = []
        elif payload.action == "ALBUM_SET_PRIMARY" and target_album:
            if target_album in albums:
                albums = [target_album] + [a for a in albums if a != target_album]
        cur.execute("UPDATE processed_files SET is_favorite = ?, album_name = ? WHERE source_path = ?", (fav, ", ".join(albums) if albums else None, src))

    conn.commit()
    conn.close()
    if rows:
        affected = [build_file_entry(r["dest_path"], target_album) for r in rows]
        n = len(affected)
        act_u = payload.action.upper()
        if act_u == "FAVORITE_ADD":
            log_library_action("FAVORITE", "Mise en favoris", f"{n} fichier(s) ajouté(s) aux favoris", files=affected)
        elif act_u == "FAVORITE_REMOVE":
            log_library_action("FAVORITE", "Retrait des favoris", f"{n} fichier(s) retiré(s) des favoris", files=affected)
        elif act_u == "ALBUM_ADD" and target_album:
            log_library_action("ALBUM_ADD", "Mise en album", f"{n} fichier(s) ajouté(s) à « {target_album} »", files=affected)
        elif act_u == "ALBUM_REMOVE":
            lbl = f"« {target_album} »" if target_album else "tous les albums"
            log_library_action("ALBUM_REMOVE", "Retrait d'album", f"{n} fichier(s) retiré(s) de {lbl}", files=affected)
        elif act_u == "ALBUM_SET_PRIMARY" and target_album:
            log_library_action("ALBUM_UPDATE", "Album principal défini", f"{n} fichier(s) → « {target_album} »", files=affected)
    return {"status": "ok"}


@router.post("/api/gallery/batch_download")
def api_gallery_batch_download(payload: GalleryBatchDownloadPayload):
    """Télécharge un média unique directement ou une archive ZIP pour plusieurs médias sélectionnés."""
    if not payload.source_paths:
        raise HTTPException(status_code=400, detail="Aucun média sélectionné.")

    conn = get_db()
    placeholders = ",".join("?" for _ in payload.source_paths)
    rows = conn.execute(
        f"SELECT source_path, dest_path FROM processed_files WHERE source_path IN ({placeholders})",
        payload.source_paths,
    ).fetchall()
    conn.close()

    by_src = {r["source_path"]: r["dest_path"] for r in rows}
    files: list[Path] = []
    seen_real: set[Path] = set()
    for src in payload.source_paths:
        raw_dest = by_src.get(src) or src
        actual = resolve_actual_path(raw_dest)
        if actual and actual.is_file() and actual not in seen_real:
            seen_real.add(actual)
            files.append(actual)

    if not files:
        raise HTTPException(status_code=404, detail="Fichier(s) introuvable(s).")

    log_library_action(
        "MEDIA_DOWNLOAD",
        "Fichiers téléchargés" if len(files) > 1 else "Fichier téléchargé",
        f"{len(files)} fichier(s) téléchargé(s)" + (" (archive ZIP)" if len(files) > 1 else f" ({files[0].name})"),
        files=[build_file_entry(str(f)) for f in files],
    )

    if len(files) == 1:
        return FileResponse(files[0], filename=files[0].name)

    tmp = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    tmp_path = Path(tmp.name)
    tmp.close()

    used_names: dict[str, int] = {}
    with zipfile.ZipFile(tmp_path, "w", compression=zipfile.ZIP_STORED) as zf:
        for file_path in files:
            arcname = file_path.name
            if arcname in used_names:
                used_names[arcname] += 1
                arcname = f"{file_path.stem} ({used_names[arcname]}){file_path.suffix}"
            else:
                used_names[arcname] = 0
            zf.write(file_path, arcname=arcname)

    return FileResponse(
        tmp_path,
        media_type="application/zip",
        filename="phototo_selection.zip",
        background=BackgroundTask(os.unlink, str(tmp_path)),
    )


def _strip_blob_fields(row) -> dict:
    return {k: v for k, v in dict(row).items() if not isinstance(v, (bytes, bytearray, memoryview))}


def _hydrate_missing_dimensions(conn: sqlite3.Connection, items: list[dict]) -> None:
    """Complète width/height/file_size manquants (ex. vidéos) depuis le fichier et persiste en DB."""
    updates: list[tuple[int, int, int, str]] = []
    for item in items:
        if not item:
            continue
        w = int(item.get("width") or 0)
        h = int(item.get("height") or 0)
        sz = int(item.get("file_size") or 0)
        if w > 0 and h > 0 and sz > 0:
            continue
        dest_p = item.get("dest_path")
        if not dest_p:
            continue
        actual_p = resolve_actual_path(dest_p)
        if not actual_p or not actual_p.exists():
            continue
        if sz <= 0:
            try:
                sz = int(actual_p.stat().st_size)
                item["file_size"] = sz
            except Exception:
                pass
        if w <= 0 or h <= 0:
            pw, ph = probe_media_dimensions(actual_p)
            if pw > 0 and ph > 0:
                w, h = pw, ph
                item["width"] = w
                item["height"] = h
        if item.get("source_path") and ((w > 0 and h > 0) or sz > 0):
            updates.append((w, h, sz, item["source_path"]))
    if updates:
        try:
            conn.executemany(
                "UPDATE processed_files SET "
                "width = CASE WHEN ? > 0 THEN ? ELSE width END, "
                "height = CASE WHEN ? > 0 THEN ? ELSE height END, "
                "file_size = CASE WHEN ? > 0 THEN ? ELSE file_size END "
                "WHERE source_path = ?",
                [(w, w, h, h, sz, sz, sp) for (w, h, sz, sp) in updates],
            )
            conn.commit()
        except Exception:
            pass


@router.get("/api/media/duplicates")
def api_get_media_duplicates(source_path: str):
    """Retourne uniquement les doublons propres au média demandé (ou [] s'il n'en a pas)."""
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM processed_files WHERE source_path = ? AND is_trashed = 0", (source_path,))
    row = cur.fetchone()
    if not row:
        conn.close()
        return {"items": []}

    cols = {r[1] for r in cur.execute("PRAGMA table_info(processed_files)")}
    row_dict = dict(row)
    items: list[dict] = []
    b3 = row_dict.get("blake3_hash")
    if b3:
        cur.execute("SELECT * FROM processed_files WHERE blake3_hash = ? AND is_trashed = 0", (b3,))
        items = [_strip_blob_fields(r) for r in cur.fetchall()]
    else:
        root_src = row_dict.get("duplicate_of") or source_path
        cur.execute(
            "SELECT * FROM processed_files WHERE is_trashed = 0 AND (source_path = ? OR duplicate_of = ?)",
            (root_src, root_src),
        )
        items = [_strip_blob_fields(r) for r in cur.fetchall()]
        if len(items) < 2 and "master_path" in cols:
            root_dest = row_dict.get("master_path") or row_dict.get("dest_path")
            if root_dest:
                cur.execute(
                    "SELECT * FROM processed_files WHERE is_trashed = 0 AND (dest_path = ? OR master_path = ?)",
                    (root_dest, root_dest),
                )
                items = [_strip_blob_fields(r) for r in cur.fetchall()]
    if len(items) >= 2:
        _hydrate_missing_dimensions(conn, items)
    conn.close()
    return {"items": items if len(items) >= 2 else []}


@router.get("/api/duplicates")
def api_get_duplicates():
    conn = get_db()
    groups = dedup.find_exact_duplicate_groups(conn, limit_groups=200)
    if groups:
        all_items = [it for g in groups for it in (g["master"], *g["duplicates"])]
        _hydrate_missing_dimensions(conn, all_items)
    conn.close()
    return {"groups": groups}


def _single_priority_sort_key(item: dict, prio: str) -> int:
    if prio == "NEWEST":
        return -(int(item.get("timestamp") or 0))
    if prio == "OLDEST":
        ts = item.get("timestamp")
        return int(ts) if ts else 9999999999
    if prio == "LARGEST":
        return -(int(item.get("file_size") or 0))
    return -(int(item.get("width") or 0) * int(item.get("height") or 0))


def _sort_group_by_priority(group: list[dict], priority: str | list[str] = "BEST_QUALITY") -> list[dict]:
    """Trie un groupe selon une chaîne de priorités (puis taille décroissante en dernier recours)."""
    prio_list = [p for p in (priority if isinstance(priority, list) else [priority]) if p] or ["BEST_QUALITY"]
    return sorted(
        group,
        key=lambda x: (*(_single_priority_sort_key(x, p) for p in prio_list), -(int(x.get("file_size") or 0))),
    )


def _exact_match_key(item: dict) -> tuple[int, int, int, int]:
    return (
        int(item.get("timestamp") or item.get("modified_at") or 0),
        int(item.get("width") or 0),
        int(item.get("height") or 0),
        int(item.get("file_size") or 0),
    )


def _expand_groups_for_resolution(groups: list[list[dict]], exact_only: bool = False) -> list[list[dict]]:
    if not exact_only:
        return [g for g in groups if len(g) >= 2]
    exact_groups: list[list[dict]] = []
    for grp in groups:
        if len(grp) < 2:
            continue
        buckets: dict[tuple[int, int, int, int], list[dict]] = {}
        for item in grp:
            buckets.setdefault(_exact_match_key(item), []).append(item)
        for sub in buckets.values():
            if len(sub) >= 2:
                exact_groups.append(sub)
    return exact_groups


def _resolve_grouped_media(conn, groups: list[list[dict]], payload: AutoResolveDuplicatesPayload, active_dest: Path, action_code: str, log_title: str) -> int:
    cur = conn.cursor()
    trash_dir = active_dest / "Corbeille"
    trash_dir.mkdir(parents=True, exist_ok=True)
    now_ts = int(time.time())
    resolved_count = 0
    prio_chain = [p for p in (payload.priorities or []) if p] or [payload.priority]
    target_groups = _expand_groups_for_resolution(groups, exact_only=bool(payload.exact_only))

    for raw_group in target_groups:
        if len(raw_group) < 2:
            continue
        ordered = _sort_group_by_priority(raw_group, prio_chain)
        winner = ordered[0]
        losers = ordered[1:]

        if payload.update_albums:
            albums = set(a.strip() for a in (winner.get("album_name") or "").split(",") if a.strip())
            for l in losers:
                for a in (l.get("album_name") or "").split(","):
                    if a.strip():
                        albums.add(a.strip())
            if albums:
                cur.execute("UPDATE processed_files SET album_name = ? WHERE source_path = ?", (", ".join(sorted(albums)), winner["source_path"]))

        for l in losers:
            resolved_count += 1
            lp = Path(l.get("dest_path") or "")
            if payload.move_to_trash:
                target_t = trash_dir / lp.name
                if lp.exists() and lp != target_t:
                    try:
                        shutil.move(str(lp), str(target_t))
                    except Exception:
                        pass
                cur.execute(
                    "UPDATE processed_files SET is_trashed=1, is_duplicate=0, status='trashed', trashed_at=?, dest_path=? WHERE source_path=?",
                    (now_ts, str(target_t), l["source_path"]),
                )
            else:
                cur.execute(
                    "UPDATE processed_files SET is_duplicate=1, duplicate_of=? WHERE source_path=?",
                    (winner["source_path"], l["source_path"]),
                )

    conn.commit()
    if resolved_count > 0:
        log_library_action(
            action_code,
            log_title,
            f"{resolved_count} élément(s) {'déplacé(s) vers la corbeille' if payload.move_to_trash else 'marqué(s) comme doublon(s)'}",
            total_items=resolved_count,
            success_count=resolved_count,
        )
    return resolved_count


@router.post("/api/duplicates/auto_resolve")
def api_auto_resolve_duplicates(payload: AutoResolveDuplicatesPayload):
    conn = get_db()
    cur = conn.cursor()
    _, active_dest = get_active_db_and_dest()

    if payload.mode == "KEEP_BOTH":
        cur.execute("UPDATE processed_files SET is_duplicate = 0, duplicate_of = NULL WHERE is_duplicate = 1")
        conn.commit()
        conn.close()
        return {"status": "kept_both", "resolved_count": 0}

    cur.execute("""
        SELECT blake3_hash FROM processed_files
        WHERE is_trashed = 0 AND blake3_hash IS NOT NULL
        GROUP BY blake3_hash HAVING COUNT(*) > 1
    """)
    hashes = [r[0] for r in cur.fetchall()]
    groups = []
    for b3 in hashes:
        cur.execute("SELECT * FROM processed_files WHERE blake3_hash = ? AND is_trashed = 0", (b3,))
        grp = [dict(r) for r in cur.fetchall()]
        if len(grp) >= 2:
            groups.append(grp)

    if groups:
        _hydrate_missing_dimensions(conn, [it for grp in groups for it in grp])
    resolved_count = _resolve_grouped_media(conn, groups, payload, active_dest, "DEDUP_RESOLVE", "Doublons résolus")
    conn.close()
    return {"status": "resolved", "resolved_count": resolved_count}


def _compute_similar_groups(conn, max_dist: int = 8, limit_groups: int = 120) -> list[list[dict]]:
    groups = sim_ai.find_similar_groups(conn, max_dist=max_dist, limit_groups=limit_groups)
    if groups:
        _hydrate_missing_dimensions(conn, [it for grp in groups for it in grp])
    return groups


@router.get("/api/similar/groups")
def api_get_similar_groups(max_dist: int = 8):
    conn = get_db()
    groups = _compute_similar_groups(conn, max_dist=max_dist, limit_groups=60)
    conn.close()
    return {"groups": groups}


@router.post("/api/similar/auto_resolve")
def api_auto_resolve_similar(payload: AutoResolveDuplicatesPayload, max_dist: int = 8):
    if payload.mode == "KEEP_BOTH":
        return {"status": "kept_both", "resolved_count": 0}
    conn = get_db()
    _, active_dest = get_active_db_and_dest()
    groups = _compute_similar_groups(conn, max_dist=max_dist, limit_groups=150)
    resolved_count = _resolve_grouped_media(conn, groups, payload, active_dest, "SIMILAR_RESOLVE", "Similaires résolus")
    conn.close()
    return {"status": "resolved", "resolved_count": resolved_count}


def _purge_expired_trash(conn: sqlite3.Connection):
    cur = conn.cursor()
    cur.execute("SELECT value FROM app_settings WHERE key = 'trash_retention_days'")
    row = cur.fetchone()
    days = int(row["value"]) if row else 30
    if days <= 0:
        return
    cutoff = int(time.time()) - (days * 86400)
    cur.execute("SELECT source_path, dest_path FROM processed_files WHERE is_trashed = 1 AND trashed_at IS NOT NULL AND trashed_at < ?", (cutoff,))
    for r in cur.fetchall():
        Path(r["dest_path"]).unlink(missing_ok=True)
        cur.execute("DELETE FROM processed_files WHERE source_path = ?", (r["source_path"],))
    conn.commit()


@router.get("/api/trash/items")
def api_get_trash_items():
    conn = get_db()
    _purge_expired_trash(conn)
    cur = conn.cursor()
    cur.execute("SELECT value FROM app_settings WHERE key = 'trash_retention_days'")
    row_days = cur.fetchone()
    r_days = int(row_days["value"]) if row_days else 30
    cur.execute("""
        SELECT source_path, dest_path, original_dest_path, timestamp, modified_at,
               file_size, width, height, album_name, trashed_at, duration_sec,
               is_favorite, COALESCE(is_animated, 0) as is_animated
        FROM processed_files
        WHERE is_trashed = 1
        ORDER BY COALESCE(trashed_at, 0) DESC
    """)
    now_ts = int(time.time())
    items, total_bytes = [], 0
    updated_dur = False
    for r in cur.fetchall():
        d = dict(r)
        total_bytes += (d["file_size"] or 0)
        dp = d.get("dest_path") or ""
        if Path(dp).suffix.lower() in VIDEO_EXTS and not d.get("duration_sec"):
            actual_v = resolve_actual_path(dp)
            if actual_v:
                dur = _probe_video_duration_and_save(actual_v, conn)
                if dur:
                    d["duration_sec"] = dur
                    if str(actual_v) != dp and d.get("source_path"):
                        conn.execute("UPDATE processed_files SET duration_sec = ? WHERE source_path = ?", (dur, d["source_path"]))
                    updated_dur = True
        d["days_left"] = max(0, int(round(r_days - ((now_ts - (d["trashed_at"] or now_ts)) / 86400.0)))) if r_days > 0 else None
        items.append(d)
    if updated_dur:
        conn.commit()
    conn.close()
    return {"items": items, "retention_days": r_days, "total_mb": round(total_bytes / (1024 * 1024), 2)}


@router.post("/api/trash/policy")
def api_set_trash_policy(payload: TrashPolicyPayload):
    conn = get_db()
    conn.execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('trash_retention_days', ?)", (str(payload.retention_days),))
    conn.commit()
    _purge_expired_trash(conn)
    conn.close()
    return {"status": "ok"}


@router.post("/api/trash/action")
def api_trash_action(payload: TrashActionPayload):
    conn = get_db()
    cur = conn.cursor()
    _, active_dest = get_active_db_and_dest()
    trash_dir = active_dest / "Corbeille"
    trash_dir.mkdir(parents=True, exist_ok=True)
    now_ts = int(time.time())

    trash_files: list[dict] = []
    for src in payload.source_paths:
        cur.execute("SELECT * FROM processed_files WHERE source_path = ?", (src,))
        row = cur.fetchone()
        if not row:
            continue
        curr_p = Path(row["dest_path"])
        if payload.action == "MOVE_TO_TRASH":
            orig_p = row["original_dest_path"] or str(curr_p)
            target_t = trash_dir / curr_p.name
            if curr_p.exists() and curr_p != target_t:
                shutil.move(curr_p, target_t)
            cur.execute("UPDATE processed_files SET is_trashed=1, status='trashed', trashed_at=?, dest_path=?, original_dest_path=? WHERE source_path=?", (now_ts, str(target_t), orig_p, src))
            trash_files.append(build_file_entry(str(target_t)))
        elif payload.action == "RESTORE":
            rest_p = Path(row["original_dest_path"] or (active_dest / "Restaures" / curr_p.name))
            rest_p.parent.mkdir(parents=True, exist_ok=True)
            if curr_p.exists() and curr_p != rest_p:
                shutil.move(curr_p, rest_p)
            cur.execute("UPDATE processed_files SET is_trashed=0, status='restored', trashed_at=NULL, dest_path=? WHERE source_path=?", (str(rest_p), src))
            trash_files.append(build_file_entry(str(rest_p)))
        elif payload.action == "DELETE_PERMANENTLY":
            curr_p.unlink(missing_ok=True)
            cur.execute("DELETE FROM faces WHERE source_path = ?", (src,))
            cur.execute("DELETE FROM processed_files WHERE source_path = ?", (src,))
            trash_files.append(build_file_entry(str(curr_p)))

    conn.commit()
    conn.close()
    if trash_files:
        n_tr = len(trash_files)
        if payload.action == "MOVE_TO_TRASH":
            log_library_action("TRASH_MOVE", "Fichiers mis à la corbeille", f"{n_tr} fichier(s) déplacé(s) vers la corbeille", files=trash_files)
        elif payload.action == "RESTORE":
            log_library_action("TRASH_RESTORE", "Fichiers restaurés", f"{n_tr} fichier(s) restauré(s) depuis la corbeille", files=trash_files)
        elif payload.action == "DELETE_PERMANENTLY":
            log_library_action("FILE_DELETE", "Fichiers supprimés définitivement", f"{n_tr} fichier(s) supprimé(s) définitivement", files=trash_files)
    return {"status": "ok"}


@router.post("/api/trash/empty_all")
def api_empty_all_trash():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT source_path, dest_path FROM processed_files WHERE is_trashed = 1")
    deleted_files = []
    for r in cur.fetchall():
        Path(r["dest_path"]).unlink(missing_ok=True)
        deleted_files.append(build_file_entry(r["dest_path"]))
    cur.execute("DELETE FROM processed_files WHERE is_trashed = 1")
    conn.commit()
    conn.close()
    if deleted_files:
        log_library_action(
            "TRASH_EMPTY",
            "Corbeille vidée",
            f"{len(deleted_files)} fichier(s) supprimé(s) définitivement",
            files=deleted_files,
        )
    return {"status": "emptied"}


# ==================== OUTILS & SUGGESTIONS INTELLIGENTES ====================

class RotationApplyItem(BaseModel):
    source_path: str
    rotate: int = 90


class ApplyRotationPayload(BaseModel):
    items: list[RotationApplyItem]


class GpsApplyItem(BaseModel):
    source_path: str
    latitude: float
    longitude: float


class ApplyGpsPayload(BaseModel):
    items: list[GpsApplyItem]


@router.get("/api/tools/suggestions/summary")
def api_tools_suggestions_summary(
    min_mb: int = 10,
    blur_threshold: float = sug_ai.DEFAULT_BLUR_THRESHOLD,
    min_age_days: int = 90,
    max_gap_hours: int = 6,
):
    conn = get_db()
    cur = conn.cursor()

    min_bytes = max(1, int(min_mb)) * 1024 * 1024
    cur.execute("""
        SELECT COUNT(*), COALESCE(SUM(file_size), 0)
        FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
          AND COALESCE(file_size, 0) >= ?
    """, (min_bytes,))
    row_large = cur.fetchone()
    large_count = int(row_large[0] or 0)
    large_bytes = int(row_large[1] or 0)

    vid_sql = " OR ".join([f"LOWER(dest_path) LIKE '%{e}'" for e in sorted(VIDEO_EXTS)])
    cur.execute(f"""
        SELECT COUNT(*) FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
          AND ({vid_sql}) AND duration_sec IS NOT NULL AND duration_sec > 0 AND duration_sec <= 2.0
    """)
    short_videos_count = int(cur.fetchone()[0] or 0)

    ext_sql = " OR ".join([f"LOWER(dest_path) LIKE '%{e}'" for e in sorted(sug_ai.SUGGESTION_PHOTO_EXTS)])
    cur.execute(f"""
        SELECT
            COUNT(*) AS total_photos,
            SUM(CASE WHEN blur_score IS NOT NULL THEN 1 ELSE 0 END) AS scanned_blur,
            SUM(CASE WHEN blur_score IS NOT NULL AND blur_score >= 0 AND blur_score < ? THEN 1 ELSE 0 END) AS blur_only,
            SUM(CASE WHEN exposure_score IS NOT NULL AND exposure_score >= 0 AND (exposure_score <= ? OR exposure_score >= ?) THEN 1 ELSE 0 END) AS exposure_bad,
            SUM(CASE WHEN (blur_score IS NOT NULL AND blur_score >= 0 AND blur_score < ?)
                       OR (exposure_score IS NOT NULL AND exposure_score >= 0 AND (exposure_score <= ? OR exposure_score >= ?))
                THEN 1 ELSE 0 END) AS quality_bad,
            SUM(CASE WHEN suggested_rotation IS NOT NULL THEN 1 ELSE 0 END) AS scanned_rot,
            SUM(CASE WHEN suggested_rotation IN (90, 180, 270) THEN 1 ELSE 0 END) AS rotation_count
        FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
          AND ({ext_sql})
    """, (
        float(blur_threshold),
        sug_ai.DEFAULT_DARK_EXPOSURE, sug_ai.DEFAULT_OVEREXPOSED,
        float(blur_threshold),
        sug_ai.DEFAULT_DARK_EXPOSURE, sug_ai.DEFAULT_OVEREXPOSED,
    ))
    row_p = cur.fetchone()
    total_photos = int(row_p["total_photos"] or 0) if row_p else 0
    blurry_scanned = int(row_p["scanned_blur"] or 0) if row_p else 0
    blur_only_count = int(row_p["blur_only"] or 0) if row_p else 0
    exposure_bad_count = int(row_p["exposure_bad"] or 0) if row_p else 0
    blurry_count = int(row_p["quality_bad"] or 0) if row_p else 0
    rotation_scanned = int(row_p["scanned_rot"] or 0) if row_p else 0
    rotation_count = int(row_p["rotation_count"] or 0) if row_p else 0

    cur.execute(f"SELECT COUNT(*) FROM processed_files WHERE {MISSING_META_SQL_CONDITION}")
    missing_meta_count = int(cur.fetchone()[0] or 0)

    home_country = str(load_settings().get("home_country", "") or "")
    album_suggestions = sug_ai.compute_album_suggestions(conn, limit=300)
    matched_srcs = {it["source_path"] for it in album_suggestions}
    new_events = sug_ai.compute_new_album_events(conn, exclude_sources=matched_srcs, home_country=home_country, limit=24)
    missing_gps_count = len(sug_ai.compute_missing_gps_suggestions(conn, max_gap_sec=max(1, int(max_gap_hours)) * 3600, limit=300))
    screenshots_count = len(sug_ai.compute_screenshots_suggestions(conn, min_age_days=min_age_days, limit=300))
    people_sug = sug_ai.compute_people_suggestions(conn, limit=50)
    people_merge_count = len(people_sug["merge_pairs"])
    people_unnamed_count = len(people_sug["unnamed_persons"])
    conn.close()
    return {
        "albums_count": len(album_suggestions),
        "new_events_count": len(new_events),
        "blurry_count": blurry_count,
        "blur_only_count": blur_only_count,
        "exposure_bad_count": exposure_bad_count,
        "blurry_scanned": blurry_scanned,
        "blurry_total": total_photos,
        "blur_threshold": float(blur_threshold),
        "rotation_count": rotation_count,
        "rotation_scanned": rotation_scanned,
        "rotation_total": total_photos,
        "missing_gps_count": missing_gps_count,
        "people_count": people_merge_count + people_unnamed_count,
        "people_merge_count": people_merge_count,
        "people_unnamed_count": people_unnamed_count,
        "screenshots_count": screenshots_count,
        "large_count": large_count,
        "large_mb": round(large_bytes / (1024 * 1024), 1),
        "short_videos_count": short_videos_count,
        "min_mb": int(min_mb),
        "missing_meta_count": missing_meta_count,
    }


@router.get("/api/tools/suggestions/details")
def api_tools_suggestions_details(
    kind: str,
    min_mb: int = 10,
    blur_threshold: float = sug_ai.DEFAULT_BLUR_THRESHOLD,
    filter_mode: str = "all",
    min_age_days: int = 90,
    max_gap_hours: int = 6,
    mode: str = "large",
    limit: int = 120,
):
    clean_kind = (kind or "").strip().lower()
    safe_limit = max(1, min(300, int(limit)))
    conn = get_db()
    cur = conn.cursor()

    if clean_kind == "albums":
        home_country = str(load_settings().get("home_country", "") or "")
        items = sug_ai.compute_album_suggestions(conn, limit=safe_limit)
        matched_srcs = {it["source_path"] for it in items}
        new_events = sug_ai.compute_new_album_events(conn, exclude_sources=matched_srcs, home_country=home_country, limit=16)
        conn.close()
        return {"kind": "albums", "total": len(items), "items": items, "new_events": new_events}

    if clean_kind == "blurry":
        ext_sql = " OR ".join([f"LOWER(dest_path) LIKE '%{e}'" for e in sorted(sug_ai.SUGGESTION_PHOTO_EXTS)])
        cur.execute(f"""
            SELECT COUNT(*) AS total_photos,
                   SUM(CASE WHEN blur_score IS NOT NULL THEN 1 ELSE 0 END) AS scanned_photos
            FROM processed_files
            WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
              AND ({ext_sql})
        """)
        meta_row = cur.fetchone()
        fm = (filter_mode or "all").strip().lower()
        if fm == "blur":
            cond = "blur_score IS NOT NULL AND blur_score >= 0 AND blur_score < ?"
            params = (float(blur_threshold), safe_limit)
        elif fm == "exposure":
            cond = "exposure_score IS NOT NULL AND exposure_score >= 0 AND (exposure_score <= ? OR exposure_score >= ?)"
            params = (sug_ai.DEFAULT_DARK_EXPOSURE, sug_ai.DEFAULT_OVEREXPOSED, safe_limit)
        else:
            cond = """(
                (blur_score IS NOT NULL AND blur_score >= 0 AND blur_score < ?)
                OR (exposure_score IS NOT NULL AND exposure_score >= 0 AND (exposure_score <= ? OR exposure_score >= ?))
            )"""
            params = (float(blur_threshold), sug_ai.DEFAULT_DARK_EXPOSURE, sug_ai.DEFAULT_OVEREXPOSED, safe_limit)
        cur.execute(f"""
            SELECT source_path, dest_path, timestamp, file_size, width, height, blur_score, exposure_score
            FROM processed_files
            WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
              AND ({ext_sql}) AND {cond}
            ORDER BY COALESCE(blur_score, 9999) ASC, COALESCE(exposure_score, 128) ASC
            LIMIT ?
        """, params)
        items = [dict(r) for r in cur.fetchall()]
        blur_map = {it["source_path"]: float(it["blur_score"]) for it in items if it.get("blur_score") is not None and float(it["blur_score"]) >= 0}
        sharper_sim = sug_ai.find_sharper_similar_sources(conn, blur_map)
        for it in items:
            issues = []
            if it.get("blur_score") is not None and 0 <= float(it["blur_score"]) < float(blur_threshold):
                issues.append("Floue")
            if it.get("exposure_score") is not None and float(it["exposure_score"]) >= 0:
                exp = float(it["exposure_score"])
                if exp <= sug_ai.DEFAULT_DARK_EXPOSURE:
                    issues.append("Trop sombre")
                elif exp >= sug_ai.DEFAULT_OVEREXPOSED:
                    issues.append("Surexposée")
            it["quality_issue"] = " · ".join(issues) if issues else "Qualité faible"
            it["has_sharper_similar"] = it["source_path"] in sharper_sim
        conn.close()
        return {
            "kind": "blurry",
            "total": len(items),
            "scanned": int(meta_row["scanned_photos"] or 0) if meta_row else 0,
            "total_photos": int(meta_row["total_photos"] or 0) if meta_row else 0,
            "blur_threshold": float(blur_threshold),
            "filter_mode": fm,
            "items": items,
        }

    if clean_kind == "rotation":
        ext_sql = " OR ".join([f"LOWER(dest_path) LIKE '%{e}'" for e in sorted(sug_ai.SUGGESTION_PHOTO_EXTS)])
        cur.execute(f"""
            SELECT COUNT(*) AS total_photos,
                   SUM(CASE WHEN suggested_rotation IS NOT NULL THEN 1 ELSE 0 END) AS scanned_photos
            FROM processed_files
            WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
              AND ({ext_sql})
        """)
        meta_row = cur.fetchone()
        cur.execute(f"""
            SELECT source_path, dest_path, timestamp, file_size, width, height, suggested_rotation, rotation_reason
            FROM processed_files
            WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
              AND ({ext_sql})
              AND suggested_rotation IN (90, 180, 270)
            ORDER BY COALESCE(timestamp, 0) DESC
            LIMIT ?
        """, (safe_limit,))
        items = [dict(r) for r in cur.fetchall()]
        conn.close()
        return {
            "kind": "rotation",
            "total": len(items),
            "scanned": int(meta_row["scanned_photos"] or 0) if meta_row else 0,
            "total_photos": int(meta_row["total_photos"] or 0) if meta_row else 0,
            "items": items,
        }

    if clean_kind == "missing_gps":
        items = sug_ai.compute_missing_gps_suggestions(conn, max_gap_sec=max(1, int(max_gap_hours)) * 3600, limit=safe_limit)
        conn.close()
        return {"kind": "missing_gps", "total": len(items), "max_gap_hours": int(max_gap_hours), "items": items}

    if clean_kind == "people":
        data = sug_ai.compute_people_suggestions(conn, limit=safe_limit)
        conn.close()
        total = len(data["merge_pairs"]) + len(data["unnamed_persons"])
        return {"kind": "people", "total": total, "items": [], **data}

    if clean_kind == "screenshots":
        items = sug_ai.compute_screenshots_suggestions(conn, min_age_days=min_age_days, limit=safe_limit)
        conn.close()
        return {"kind": "screenshots", "total": len(items), "min_age_days": int(min_age_days), "items": items}

    if clean_kind == "large":
        m = (mode or "large").strip().lower()
        if m == "short_videos":
            vid_sql = " OR ".join([f"LOWER(dest_path) LIKE '%{e}'" for e in sorted(VIDEO_EXTS)])
            cur.execute(f"""
                SELECT source_path, dest_path, timestamp, file_size, width, height, duration_sec, album_name
                FROM processed_files
                WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
                  AND ({vid_sql}) AND duration_sec IS NOT NULL AND duration_sec > 0 AND duration_sec <= 2.0
                ORDER BY duration_sec ASC, COALESCE(file_size, 0) DESC
                LIMIT ?
            """, (safe_limit,))
            items = [dict(r) for r in cur.fetchall()]
            conn.close()
            return {"kind": "large", "mode": "short_videos", "total": len(items), "items": items}

        min_bytes = max(1, int(min_mb)) * 1024 * 1024
        cur.execute("""
            SELECT source_path, dest_path, timestamp, file_size, width, height, duration_sec, album_name
            FROM processed_files
            WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
              AND COALESCE(file_size, 0) >= ?
            ORDER BY COALESCE(file_size, 0) DESC
            LIMIT ?
        """, (min_bytes, safe_limit))
        items = [dict(r) for r in cur.fetchall()]
        conn.close()
        return {"kind": "large", "mode": "large", "total": len(items), "min_mb": int(min_mb), "items": items}

    if clean_kind == "missing_meta":
        cur.execute(f"""
            SELECT source_path, dest_path, timestamp, modified_at, status, file_size, width, height, album_name
            FROM processed_files
            WHERE {MISSING_META_SQL_CONDITION}
            ORDER BY dest_path ASC
            LIMIT ?
        """, (safe_limit,))
        items = [dict(r) for r in cur.fetchall()]
        conn.close()
        return {"kind": "missing_meta", "total": len(items), "items": items}

    conn.close()
    raise HTTPException(status_code=400, detail=f"Type de suggestion inconnu: {kind}")


@router.post("/api/tools/suggestions/scan_blur")
def api_tools_scan_blur(force: bool = False, limit: int = 400, blur_threshold: float = sug_ai.DEFAULT_BLUR_THRESHOLD):
    conn = get_db()
    cur = conn.cursor()
    ext_sql = " OR ".join([f"LOWER(dest_path) LIKE '%{e}'" for e in sorted(sug_ai.SUGGESTION_PHOTO_EXTS)])
    blur_filter = "" if force else "AND (blur_score IS NULL OR exposure_score IS NULL)"
    cur.execute(f"""
        SELECT source_path, dest_path
        FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
          AND ({ext_sql}) {blur_filter}
        ORDER BY COALESCE(timestamp, 0) DESC
        LIMIT ?
    """, (max(1, min(1000, int(limit))),))
    rows = cur.fetchall()

    scanned_now = 0
    for r in rows:
        actual = resolve_actual_path(r["dest_path"])
        score, exp = sug_ai.compute_blur_and_exposure(actual) if actual else (-1.0, -1.0)
        if score is None:
            score, exp = -1.0, -1.0
        cur.execute("UPDATE processed_files SET blur_score = ?, exposure_score = ? WHERE source_path = ?", (score, exp, r["source_path"]))
        scanned_now += 1
    conn.commit()

    cur.execute(f"""
        SELECT
            SUM(CASE WHEN blur_score IS NULL OR exposure_score IS NULL THEN 1 ELSE 0 END) AS remaining,
            SUM(CASE WHEN (blur_score IS NOT NULL AND blur_score >= 0 AND blur_score < ?)
                       OR (exposure_score IS NOT NULL AND exposure_score >= 0 AND (exposure_score <= ? OR exposure_score >= ?))
                THEN 1 ELSE 0 END) AS blurry_count
        FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
          AND ({ext_sql})
    """, (float(blur_threshold), sug_ai.DEFAULT_DARK_EXPOSURE, sug_ai.DEFAULT_OVEREXPOSED))
    st = cur.fetchone()
    remaining = int(st["remaining"] or 0) if st else 0
    blurry_count = int(st["blurry_count"] or 0) if st else 0
    conn.close()
    return {"scanned_now": scanned_now, "remaining": remaining, "blurry_count": blurry_count}


@router.post("/api/tools/suggestions/apply_gps")
def api_tools_apply_gps(payload: ApplyGpsPayload):
    conn = get_db()
    cur = conn.cursor()
    updated_files: list[dict] = []
    for entry in payload.items:
        cur.execute("SELECT dest_path FROM processed_files WHERE source_path = ?", (entry.source_path,))
        row = cur.fetchone()
        if not row:
            continue
        cur.execute(
            "UPDATE processed_files SET latitude = ?, longitude = ? WHERE source_path = ?",
            (float(entry.latitude), float(entry.longitude), entry.source_path),
        )
        updated_files.append(build_file_entry(row["dest_path"]))
    conn.commit()
    conn.close()
    if updated_files:
        log_library_action("MEDIA_GPS", "Localisation appliquée", f"{len(updated_files)} média(s) géolocalisé(s)", files=updated_files)
    return {"status": "ok", "updated": len(updated_files)}


@router.post("/api/tools/suggestions/scan_rotation")
def api_tools_scan_rotation(force: bool = False, limit: int = 400):
    conn = get_db()
    cur = conn.cursor()
    ext_sql = " OR ".join([f"LOWER(dest_path) LIKE '%{e}'" for e in sorted(sug_ai.SUGGESTION_PHOTO_EXTS)])
    rot_filter = "" if force else "AND suggested_rotation IS NULL"
    cur.execute(f"""
        SELECT source_path, dest_path
        FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
          AND ({ext_sql}) {rot_filter}
        ORDER BY COALESCE(timestamp, 0) DESC
        LIMIT ?
    """, (max(1, min(1000, int(limit))),))
    rows = cur.fetchall()

    scanned_now = 0
    for r in rows:
        actual = resolve_actual_path(r["dest_path"])
        rot, reason = sug_ai.detect_rotation_suggestion(actual) if actual else (-1, "")
        cur.execute(
            "UPDATE processed_files SET suggested_rotation = ?, rotation_reason = ? WHERE source_path = ?",
            (rot, reason or None, r["source_path"]),
        )
        scanned_now += 1
    conn.commit()

    cur.execute(f"""
        SELECT
            SUM(CASE WHEN suggested_rotation IS NULL THEN 1 ELSE 0 END) AS remaining,
            SUM(CASE WHEN suggested_rotation IN (90, 180, 270) THEN 1 ELSE 0 END) AS rotation_count
        FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
          AND ({ext_sql})
    """)
    st = cur.fetchone()
    remaining = int(st["remaining"] or 0) if st else 0
    rotation_count = int(st["rotation_count"] or 0) if st else 0
    conn.close()
    return {"scanned_now": scanned_now, "remaining": remaining, "rotation_count": rotation_count}


@router.post("/api/tools/suggestions/apply_rotation")
def api_tools_apply_rotation(payload: ApplyRotationPayload):
    conn = get_db()
    cur = conn.cursor()
    rotated_files: list[dict] = []
    failed_files: list[dict] = []

    for entry in payload.items:
        rot = int(entry.rotate) % 360
        cur.execute("SELECT source_path, dest_path, timestamp FROM processed_files WHERE source_path = ?", (entry.source_path,))
        row = cur.fetchone()
        if not row:
            continue
        actual = resolve_actual_path(row["dest_path"])
        if not actual:
            failed_files.append({"path": str(row["dest_path"]).replace("\\", "/"), "name": Path(row["dest_path"]).name, "reason": "Fichier introuvable"})
            continue

        if rot not in (90, 180, 270):
            cur.execute("UPDATE processed_files SET suggested_rotation = 0, rotation_reason = NULL WHERE source_path = ?", (entry.source_path,))
            continue

        try:
            out_p = process_image_edits(actual, {"rotate": rot}, overwrite=True, timestamp=row["timestamp"])
            w_new, h_new = probe_media_dimensions(out_p)
            fsize = out_p.stat().st_size if out_p.exists() else 0
            cur.execute("""
                UPDATE processed_files
                SET file_size = ?, width = COALESCE(?, width), height = COALESCE(?, height),
                    suggested_rotation = 0, rotation_reason = NULL, blake3_hash = NULL
                WHERE source_path = ?
            """, (fsize, w_new, h_new, entry.source_path))
            rotated_files.append(build_file_entry(str(out_p)))
        except Exception as e:
            failed_files.append({"path": str(actual).replace("\\", "/"), "name": actual.name, "reason": str(e)[:240]})

    conn.commit()
    conn.close()
    if rotated_files or failed_files:
        log_library_action(
            "MEDIA_ROTATE",
            "Rotation appliquée",
            f"{len(rotated_files)} photo(s) pivotée(s)" + (f", {len(failed_files)} échec(s)" if failed_files else ""),
            status="error" if (failed_files and not rotated_files) else ("partial" if failed_files else "success"),
            files=rotated_files,
            failed_files=failed_files,
        )
    return {"status": "ok", "rotated": len(rotated_files), "failed": len(failed_files)}
