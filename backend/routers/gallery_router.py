import os
import time
import shutil
import sqlite3
from pathlib import Path

import cv2
import imagehash
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import RAW_EXTS, get_active_db_and_dest, get_db, resolve_actual_path
from media_frames import VIDEO_EXTS, IMAGE_EXTS

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


class AutoResolveDuplicatesPayload(BaseModel):
    mode: str = "KEEP_ONE"          # "KEEP_BOTH" | "KEEP_ONE"
    priority: str = "BEST_QUALITY"  # "BEST_QUALITY" | "NEWEST" | "OLDEST" | "LARGEST"
    update_albums: bool = True
    move_to_trash: bool = True


class CreateAlbumPayload(BaseModel):
    name: str
    parent_id: int | None = None


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
        SELECT DISTINCT album_name FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND album_name IS NOT NULL AND album_name != ''
    """)
    inserted = False
    for r in cur.fetchall():
        for tok in r["album_name"].split(","):
            tok = tok.strip()
            if tok:
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


def _build_gallery_where(
    year: str = "", month: str = "", album: str = "",
    favorites_only: bool = False, no_faces_only: bool = False,
    media_type: str = "", ext_filter: str = "", require_timestamp: bool = False
) -> tuple[str, list]:
    where_clauses = ["pf.is_duplicate = 0", "pf.is_trashed = 0", "pf.dest_path IS NOT NULL"]
    params = []

    if require_timestamp:
        where_clauses.append("pf.timestamp > 0")
    if year:
        where_clauses.append("strftime('%Y', datetime(pf.timestamp, 'unixepoch', 'localtime')) = ?")
        params.append(year)
    if month:
        where_clauses.append("strftime('%m', datetime(pf.timestamp, 'unixepoch', 'localtime')) = ?")
        params.append(f"{int(month):02d}")
    if album:
        where_clauses.append("(',' || REPLACE(COALESCE(pf.album_name, ''), ', ', ',') || ',') LIKE ?")
        params.append(f"%,{album.strip()},%")
    if favorites_only:
        where_clauses.append("pf.is_favorite = 1")
    if no_faces_only:
        where_clauses.append("NOT EXISTS (SELECT 1 FROM faces f WHERE f.dest_path = pf.dest_path)")
    if ext_filter:
        where_clauses.append("LOWER(pf.dest_path) LIKE ?")
        params.append(f"%{ext_filter.lower()}")
    elif media_type == "VIDEOS":
        vid_ors = " OR ".join([f"LOWER(pf.dest_path) LIKE '%{e}'" for e in VIDEO_EXTS])
        where_clauses.append(f"({vid_ors})")
    elif media_type == "RAW":
        raw_ors = " OR ".join([f"LOWER(pf.dest_path) LIKE '%{e}'" for e in RAW_EXTS])
        where_clauses.append(f"({raw_ors})")
    elif media_type == "SCREENSHOTS":
        where_clauses.append("(LOWER(pf.dest_path) LIKE '%screenshot%' OR LOWER(pf.dest_path) LIKE '%capture%' OR LOWER(pf.dest_path) LIKE '%ecran%')")
    elif media_type == "PHOTOS":
        std_imgs = IMAGE_EXTS - RAW_EXTS
        img_ors = " OR ".join([f"LOWER(pf.dest_path) LIKE '%{e}'" for e in std_imgs])
        where_clauses.append(f"({img_ors})")

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

    cur.execute("SELECT album_id, name, full_path, parent_id, cover_path, created_at, CAST(strftime('%s', created_at) AS INTEGER) as created_ts FROM albums ORDER BY full_path ASC")
    all_rows = [dict(r) for r in cur.fetchall()]

    cur.execute("""
        SELECT album_name, dest_path, timestamp,
               COALESCE(modified_at, CAST(strftime('%s', processed_at) AS INTEGER), timestamp, 0) as mod_ts
        FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND album_name IS NOT NULL AND album_name != ''
    """)
    stats_by_album: dict[str, dict] = {}
    for r in cur.fetchall():
        for tok in r["album_name"].split(","):
            tok = tok.strip()
            if not tok:
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

    enriched = []
    for a in all_rows:
        fp = a["full_path"]
        direct_st = stats_by_album.get(fp, {"count": 0, "cover_path": None, "max_ts": 0, "max_mod_ts": 0})
        recursive_count = direct_st["count"]
        fallback_cover = direct_st["cover_path"]
        max_ts = direct_st["max_ts"]
        max_mod_ts = direct_st["max_mod_ts"]
        prefix = fp + "/"
        for other_fp, ost in stats_by_album.items():
            if other_fp.startswith(prefix):
                recursive_count += ost["count"]
                if not fallback_cover:
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
            "cover_path": a["cover_path"] or fallback_cover or "",
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

    cur.execute(
        "INSERT INTO albums (name, full_path, parent_id) VALUES (?, ?, ?)",
        (seg, full_path, payload.parent_id)
    )
    new_id = cur.lastrowid
    (dest_dir / "Albums" / full_path).mkdir(parents=True, exist_ok=True)
    conn.commit()
    conn.close()
    return {
        "status": "created",
        "album": {"album_id": new_id, "name": seg, "full_path": full_path, "parent_id": payload.parent_id}
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
    cur = conn.cursor()
    cur.execute("""
        SELECT dest_path, file_size FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
    """)
    cats = {
        "PHOTOS": {"count": 0, "bytes": 0},
        "VIDEOS": {"count": 0, "bytes": 0},
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

        if "screenshot" in name_low or "capture" in name_low or "ecran" in name_low:
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


@router.get("/api/gallery/items")
def api_gallery_items(
    year: str = "", month: str = "", album: str = "",
    favorites_only: bool = False, no_faces_only: bool = False,
    media_type: str = "", ext_filter: str = "",
    sort_by: str = "date", sort_order: str = "desc",
    page: int = 1, limit: int = 60, skip_to: int = -1
):
    conn = get_db()
    conn.create_function("BASENAME", 1, lambda p: Path(p).name.lower() if p else "")
    cur = conn.cursor()
    offset = skip_to if skip_to >= 0 else (page - 1) * limit
    where_sql, params = _build_gallery_where(
        year=year, month=month, album=album,
        favorites_only=favorites_only, no_faces_only=no_faces_only,
        media_type=media_type, ext_filter=ext_filter, require_timestamp=False
    )

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
               pf.is_favorite, pf.album_name, pf.file_size, pf.width, pf.height, pf.duration_sec
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
            else:
                albums = []
        cur.execute("UPDATE processed_files SET is_favorite = ?, album_name = ? WHERE source_path = ?", (fav, ", ".join(albums) if albums else None, src))

    conn.commit()
    conn.close()
    return {"status": "ok"}


@router.get("/api/duplicates")
def api_get_duplicates():
    conn = get_db()
    cur = conn.cursor()
    cols = {r[1] for r in cur.execute("PRAGMA table_info(processed_files)")}
    has_master_col = "master_path" in cols

    if has_master_col:
        cur.execute("""
            SELECT DISTINCT COALESCE(duplicate_of, master_path) AS master_ref,
                   CASE WHEN duplicate_of IS NOT NULL THEN 'source' ELSE 'dest' END AS ref_kind
            FROM processed_files
            WHERE is_duplicate = 1 AND (duplicate_of IS NOT NULL OR master_path IS NOT NULL)
        """)
    else:
        cur.execute("""
            SELECT DISTINCT duplicate_of AS master_ref, 'source' AS ref_kind
            FROM processed_files
            WHERE is_duplicate = 1 AND duplicate_of IS NOT NULL
        """)

    masters = cur.fetchall()
    groups = []
    for m in masters[:60]:
        ref = m["master_ref"]
        if m["ref_kind"] == "source":
            cur.execute("SELECT * FROM processed_files WHERE source_path = ?", (ref,))
            m_row = cur.fetchone()
            cur.execute("SELECT * FROM processed_files WHERE is_duplicate = 1 AND duplicate_of = ?", (ref,))
        else:
            cur.execute("SELECT * FROM processed_files WHERE dest_path = ?", (ref,))
            m_row = cur.fetchone()
            cur.execute("SELECT * FROM processed_files WHERE is_duplicate = 1 AND master_path = ?", (ref,))
        d_rows = cur.fetchall()
        if m_row and d_rows:
            groups.append({"master": dict(m_row), "duplicates": [dict(r) for r in d_rows]})
    conn.close()
    return {"groups": groups}


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
    trash_dir = active_dest / "Corbeille"
    trash_dir.mkdir(parents=True, exist_ok=True)
    now_ts = int(time.time())
    resolved_count = 0

    for b3 in hashes:
        cur.execute("SELECT * FROM processed_files WHERE blake3_hash = ? AND is_trashed = 0", (b3,))
        group = [dict(r) for r in cur.fetchall()]
        if len(group) < 2:
            continue

        if payload.priority == "NEWEST":
            group.sort(key=lambda x: (x.get("timestamp") or 0), reverse=True)
        elif payload.priority == "OLDEST":
            group.sort(key=lambda x: (x.get("timestamp") or 9999999999))
        elif payload.priority == "LARGEST":
            group.sort(key=lambda x: (x.get("file_size") or 0), reverse=True)
        else:
            group.sort(key=lambda x: ((x.get("width") or 0) * (x.get("height") or 0), (x.get("file_size") or 0)), reverse=True)

        winner = group[0]
        losers = group[1:]

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
                    (now_ts, str(target_t), l["source_path"])
                )
            else:
                cur.execute(
                    "UPDATE processed_files SET is_duplicate=1, duplicate_of=? WHERE source_path=?",
                    (winner["source_path"], l["source_path"])
                )

    conn.commit()
    conn.close()
    return {"status": "resolved", "resolved_count": resolved_count}


@router.get("/api/similar/groups")
def api_get_similar_groups(max_dist: int = 8):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT source_path, dest_path, timestamp, phash, width, height, file_size
        FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND phash IS NOT NULL
        ORDER BY COALESCE(timestamp, 0) DESC LIMIT 2500
    """)
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()

    parsed = []
    for r in rows:
        try:
            parsed.append((imagehash.hex_to_hash(r["phash"]), r))
        except Exception:
            pass

    visited = set()
    groups = []
    for i in range(len(parsed)):
        if i in visited:
            continue
        h1, r1 = parsed[i]
        cluster = [r1]
        for j in range(i + 1, min(len(parsed), i + 120)):
            if j in visited:
                continue
            h2, r2 = parsed[j]
            if (h1 - h2) <= max_dist:
                visited.add(j)
                cluster.append(r2)
        if len(cluster) > 1:
            visited.add(i)
            groups.append(cluster)
        if len(groups) >= 40:
            break

    return {"groups": groups}


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
    r_days = int(cur.fetchone()["value"])
    cur.execute("SELECT source_path, dest_path, timestamp, file_size, trashed_at FROM processed_files WHERE is_trashed = 1 ORDER BY COALESCE(trashed_at, 0) DESC")
    now_ts = int(time.time())
    items, total_bytes = [], 0
    for r in cur.fetchall():
        d = dict(r)
        total_bytes += (d["file_size"] or 0)
        d["days_left"] = max(0, int(round(r_days - ((now_ts - (d["trashed_at"] or now_ts)) / 86400.0)))) if r_days > 0 else None
        items.append(d)
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
        elif payload.action == "RESTORE":
            rest_p = Path(row["original_dest_path"] or (active_dest / "Restaures" / curr_p.name))
            rest_p.parent.mkdir(parents=True, exist_ok=True)
            if curr_p.exists() and curr_p != rest_p:
                shutil.move(curr_p, rest_p)
            cur.execute("UPDATE processed_files SET is_trashed=0, status='restored', trashed_at=NULL, dest_path=? WHERE source_path=?", (str(rest_p), src))
        elif payload.action == "DELETE_PERMANENTLY":
            curr_p.unlink(missing_ok=True)
            cur.execute("DELETE FROM faces WHERE source_path = ?", (src,))
            cur.execute("DELETE FROM processed_files WHERE source_path = ?", (src,))

    conn.commit()
    conn.close()
    return {"status": "ok"}


@router.post("/api/trash/empty_all")
def api_empty_all_trash():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT source_path, dest_path FROM processed_files WHERE is_trashed = 1")
    for r in cur.fetchall():
        Path(r["dest_path"]).unlink(missing_ok=True)
    cur.execute("DELETE FROM processed_files WHERE is_trashed = 1")
    conn.commit()
    conn.close()
    return {"status": "emptied"}
