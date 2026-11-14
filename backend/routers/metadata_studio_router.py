import os
import re
import json
import shutil
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import unquote

import exiftool
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from settings_manager import get_configured_timezone
from pipeline_runner import STATE
from database import MISSING_META_SQL_CONDITION, get_active_db_and_dest, get_db, resolve_actual_path
from media_editor import process_image_edits, process_video_edits
from media_frames import VIDEO_EXTS
import fusion_takeout_complet as fusion

router = APIRouter()


class BatchMetadataUpdatePayload(BaseModel):
    source_paths: list[str]
    start_datetime_iso: str | None = None
    time_sequence_mode: str = "PRESERVE_GAPS"
    step_seconds: int = 15
    latitude: float | None = None
    longitude: float | None = None
    description: str | None = None


class BatchMetadataStripPayload(BaseModel):
    source_paths: list[str]
    strip_gps: bool = False
    strip_all_exif: bool = False


class MediaStudioEditPayload(BaseModel):
    source_path: str
    overwrite: bool = False
    crop: dict | None = None
    rotate: int = 0
    flip_h: bool = False
    flip_v: bool = False
    brightness: float = 1.0
    contrast: float = 1.0
    saturation: float = 1.0
    sharpness: float = 1.0
    text_overlay: dict | None = None
    inpaint_boxes: list[dict] = []
    video_action: str = "EDIT"
    start_sec: float = 0.0
    end_sec: float = 0.0
    split_time_sec: float = 5.0
    speed: float = 1.0
    mute_audio: bool = False
    custom_audio_path: str | None = None


@router.get("/api/metadata/missing_report")
def api_missing_metadata_report(page: int = 1, limit: int = 54):
    conn = get_db()
    cur = conn.cursor()
    offset = (page - 1) * limit
    cur.execute(f"SELECT COUNT(*) FROM processed_files WHERE {MISSING_META_SQL_CONDITION}")
    total = cur.fetchone()[0]

    cur.execute(f"""
        SELECT source_path, dest_path, timestamp, status, album_name, file_size
        FROM processed_files
        WHERE {MISSING_META_SQL_CONDITION}
        ORDER BY dest_path ASC
        LIMIT ? OFFSET ?
    """, (limit, offset))
    items = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"total": total, "items": items, "page": page, "total_pages": max(1, (total + limit - 1) // limit)}


@router.post("/api/metadata/retry_recovery")
def api_retry_metadata_recovery():
    conn = get_db()
    cur = conn.cursor()
    _, active_dest = get_active_db_and_dest()

    cur.execute(f"""
        SELECT source_path, dest_path, timestamp, status, latitude, longitude
        FROM processed_files
        WHERE {MISSING_META_SQL_CONDITION}
    """)
    rows = [dict(r) for r in cur.fetchall()]
    repaired = 0
    still_missing = 0
    STATE.missing_meta_files.clear()

    with exiftool.ExifToolHelper(common_args=["-G", "-n", "-charset", "filename=utf8"]) as et:
        for r in rows:
            curr_p = Path(r["dest_path"])
            if not curr_p.exists():
                continue

            new_ts = None
            new_status = "no_metadata"
            src_p = Path(r["source_path"])
            if src_p.exists():
                jp = fusion.find_matching_json(src_p)
                if jp:
                    try:
                        data = json.loads(jp.read_text(encoding="utf-8"))
                        ts_s = data.get("photoTakenTime", {}).get("timestamp") or data.get("creationTime", {}).get("timestamp")
                        if ts_s:
                            new_ts = int(ts_s)
                            new_status = "json_matched"
                    except Exception:
                        pass

            if not new_ts:
                fn_ts = fusion.extract_date_from_filename(curr_p.name)
                if fn_ts:
                    new_ts = fn_ts
                    new_status = "filename_date"

            if new_ts and new_ts > 0:
                t_info = fusion.resolve_datetime_with_dst(new_ts, r["latitude"], r["longitude"])
                dt_loc = t_info["dt_local"]
                clean_orig_stem = re.sub(r'^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_', '', curr_p.stem)
                new_folder = active_dest / str(dt_loc.year) / fusion.MOIS_FR[dt_loc.month]
                new_folder.mkdir(parents=True, exist_ok=True)
                new_prefix = dt_loc.strftime("%Y-%m-%d_%H-%M-%S")
                new_dest = new_folder / f"{new_prefix}_{clean_orig_stem}{curr_p.suffix}"

                counter = 1
                while new_dest.exists() and new_dest.resolve() != curr_p.resolve():
                    new_dest = new_folder / f"{new_prefix}_{clean_orig_stem}_{counter}{curr_p.suffix}"
                    counter += 1

                try:
                    if new_dest.resolve() != curr_p.resolve():
                        shutil.move(curr_p, new_dest)
                    is_vid = new_dest.suffix.lower() in VIDEO_EXTS
                    tags = {"DateTimeOriginal": t_info["exif_local_str"], "CreateDate": t_info["exif_local_str"]} if not is_vid else {"QuickTime:CreateDate": t_info["exif_utc_str"]}
                    et.set_tags([str(new_dest)], tags=tags, params=["-overwrite_original", "-P", "-q"])
                    os.utime(new_dest, (new_ts, new_ts))
                except Exception:
                    pass

                cur.execute(
                    "UPDATE processed_files SET dest_path=?, original_dest_path=?, timestamp=?, status=? WHERE source_path=?",
                    (str(new_dest), str(new_dest), new_ts, new_status, r["source_path"])
                )
                repaired += 1
            else:
                cur.execute("UPDATE processed_files SET status='no_metadata' WHERE source_path=?", (r["source_path"],))
                STATE.add_missing_meta_file(str(curr_p))
                still_missing += 1

    conn.commit()
    conn.close()
    return {"status": "ok", "repaired": repaired, "still_missing": still_missing}


@router.get("/api/metadata/inspect")
def api_inspect_metadata(source_path: str):
    conn = get_db()
    cur = conn.cursor()
    src_clean = unquote(source_path)
    cur.execute("SELECT * FROM processed_files WHERE source_path = ?", (src_clean,))
    row = cur.fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Média introuvable")

    d = dict(row)
    tz = get_configured_timezone()
    d["datetime_local_iso"] = (
        datetime.fromtimestamp(d["timestamp"], tz=timezone.utc).astimezone(tz).strftime("%Y-%m-%dT%H:%M:%S")
        if d.get("timestamp") else ""
    )

    album_count = 0
    if d.get("album_name"):
        first_alb = d["album_name"].split(",")[0].strip()
        cur.execute(
            "SELECT COUNT(*) FROM processed_files WHERE is_duplicate = 0 AND is_trashed = 0 AND album_name LIKE ?",
            (f"%{first_alb}%",)
        )
        album_count = cur.fetchone()[0] or 0
    d["album_count"] = album_count

    cur.execute("""
        SELECT f.face_id, f.thumb_path, f.person_id, COALESCE(p.name, 'Inconnu') as name
        FROM faces f
        LEFT JOIN persons p ON f.person_id = p.person_id
        WHERE f.source_path = ? OR f.dest_path = ?
    """, (src_clean, d.get("dest_path") or ""))
    d["faces"] = [dict(r) for r in cur.fetchall()]
    conn.close()

    camera_model = ""
    lens_specs = ""
    description = ""
    actual_p = resolve_actual_path(d.get("dest_path") or "")
    if actual_p and actual_p.exists():
        try:
            with exiftool.ExifToolHelper(common_args=["-G", "-n", "-charset", "filename=utf8"]) as et:
                meta_list = et.get_metadata([str(actual_p)])
                if meta_list:
                    m = meta_list[0]
                    make = str(m.get("EXIF:Make") or m.get("QuickTime:Make") or "").strip()
                    model = str(m.get("EXIF:Model") or m.get("QuickTime:Model") or "").strip()
                    if model and make and not model.lower().startswith(make.lower()):
                        camera_model = f"{make} {model}"
                    else:
                        camera_model = model or make

                    fnum = m.get("EXIF:FNumber")
                    exp = m.get("EXIF:ExposureTime")
                    fl = m.get("EXIF:FocalLength")
                    iso = m.get("EXIF:ISO")
                    parts = []
                    if fnum:
                        parts.append(f"f/{round(float(fnum), 1)}".replace(".", ","))
                    if exp:
                        exp_f = float(exp)
                        parts.append(f"1/{int(round(1.0 / exp_f))}" if 0 < exp_f < 1 else f"{exp_f}s")
                    if fl:
                        parts.append(f"{round(float(fl), 1)} mm".replace(".", ","))
                    if iso:
                        parts.append(f"{iso} ISO")
                    lens_specs = " ".join(parts)
                    description = str(m.get("EXIF:ImageDescription") or m.get("XMP:Description") or "").strip()
        except Exception:
            pass

    d["camera_model"] = camera_model or "Appareil standard"
    d["lens_specs"] = lens_specs
    d["description"] = description
    return d


@router.post("/api/metadata/batch_update")
def api_batch_update_metadata(payload: BatchMetadataUpdatePayload):
    conn = get_db()
    cur = conn.cursor()
    tz = get_configured_timezone()
    ph = ",".join("?" for _ in payload.source_paths)
    cur.execute(f"SELECT source_path, dest_path, timestamp, latitude, longitude FROM processed_files WHERE source_path IN ({ph})", payload.source_paths)
    rows_map = {r["source_path"]: dict(r) for r in cur.fetchall()}
    ordered = [rows_map[s] for s in payload.source_paths if s in rows_map]

    base_new_ts = int(datetime.fromisoformat(payload.start_datetime_iso).replace(tzinfo=tz).timestamp()) if payload.start_datetime_iso else None
    first_orig_ts = ordered[0]["timestamp"] if ordered else 0

    with exiftool.ExifToolHelper() as et:
        for idx, item in enumerate(ordered):
            curr_p = Path(item["dest_path"])
            if not curr_p.exists():
                continue
            new_ts = item["timestamp"]
            if base_new_ts is not None:
                if payload.time_sequence_mode == "SAME" or idx == 0:
                    new_ts = base_new_ts
                elif payload.time_sequence_mode == "FIXED_STEP":
                    new_ts = base_new_ts + (idx * max(1, payload.step_seconds))
                else:
                    orig_t = item["timestamp"]
                    new_ts = (base_new_ts + (orig_t - first_orig_ts)) if (orig_t and first_orig_ts and orig_t > first_orig_ts) else (base_new_ts + idx * max(1, payload.step_seconds))

            tags = {}
            is_vid = curr_p.suffix.lower() in VIDEO_EXTS
            if new_ts:
                t_info = fusion.resolve_datetime_with_dst(new_ts, payload.latitude, payload.longitude)
                if not is_vid:
                    tags["DateTimeOriginal"] = t_info["exif_local_str"]
                    tags["CreateDate"] = t_info["exif_local_str"]
                    tags["OffsetTimeOriginal"] = t_info["offset_str"]
                else:
                    tags["QuickTime:CreateDate"] = t_info["exif_utc_str"]
                    tags["Keys:CreationDate"] = t_info["iso_local_with_tz"]

            new_lat = payload.latitude if payload.latitude is not None else item["latitude"]
            new_lon = payload.longitude if payload.longitude is not None else item["longitude"]
            if payload.latitude is not None and payload.longitude is not None:
                tags["GPSLatitude"] = payload.latitude
                tags["GPSLongitude"] = payload.longitude
            if payload.description:
                tags["ImageDescription"] = payload.description

            if tags:
                try:
                    et.set_tags([str(curr_p)], tags=tags, params=["-overwrite_original", "-P", "-q", "-api", "QuickTimeUTC=0"])
                except Exception:
                    pass
            if new_ts:
                os.utime(curr_p, (new_ts, new_ts))
            cur.execute("UPDATE processed_files SET timestamp=?, latitude=?, longitude=? WHERE source_path=?", (new_ts, new_lat, new_lon, item["source_path"]))

    conn.commit()
    conn.close()
    return {"status": "updated"}


@router.post("/api/metadata/batch_strip")
def api_batch_strip_metadata(payload: BatchMetadataStripPayload):
    conn = get_db()
    cur = conn.cursor()
    ph = ",".join("?" for _ in payload.source_paths)
    cur.execute(f"SELECT source_path, dest_path, timestamp FROM processed_files WHERE source_path IN ({ph})", payload.source_paths)
    with exiftool.ExifToolHelper() as et:
        for r in cur.fetchall():
            p = Path(r["dest_path"])
            if not p.exists():
                continue
            params = ["-overwrite_original", "-P", "-q"]
            if payload.strip_all_exif:
                params.extend(["-all=", "-tagsFromFile", "@", "-Orientation", "-ICC_Profile"])
            elif payload.strip_gps:
                params.extend(["-gps:all=", "-XMP:GPSLatitude=", "-XMP:GPSLongitude="])
            try:
                et.execute(*params, str(p))
                if r["timestamp"]:
                    os.utime(p, (r["timestamp"], r["timestamp"]))
            except Exception:
                pass
            if payload.strip_all_exif or payload.strip_gps:
                cur.execute("UPDATE processed_files SET latitude=0.0, longitude=0.0 WHERE source_path=?", (r["source_path"],))
    conn.commit()
    conn.close()
    return {"status": "stripped"}


@router.post("/api/studio/apply")
def api_apply_studio_edits(payload: MediaStudioEditPayload):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM processed_files WHERE source_path = ?", (unquote(payload.source_path),))
    row = cur.fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Média introuvable")
    media_p = Path(row["dest_path"])
    is_vid = media_p.suffix.lower() in VIDEO_EXTS
    ops = payload.model_dump()

    try:
        out_files = [process_image_edits(media_p, ops, overwrite=payload.overwrite, timestamp=row["timestamp"])] if not is_vid else process_video_edits(media_p, ops, overwrite=payload.overwrite, timestamp=row["timestamp"])
    except Exception as e:
        conn.close()
        raise HTTPException(500, f"Erreur d'édition : {e}")

    for out_p in out_files:
        if out_p != media_p:
            cur.execute("""
                INSERT OR REPLACE INTO processed_files
                (source_path, dest_path, original_dest_path, status, timestamp, is_favorite, is_trashed, album_name, latitude, longitude, file_size)
                VALUES (?, ?, ?, 'edited_copy', ?, ?, 0, ?, ?, ?, ?)
            """, (str(out_p), str(out_p), str(out_p), row["timestamp"], row["is_favorite"], row["album_name"], row["latitude"], row["longitude"], out_p.stat().st_size))
        else:
            cur.execute("UPDATE processed_files SET file_size=?, blake3_hash=NULL WHERE source_path=?", (out_p.stat().st_size, row["source_path"]))

    conn.commit()
    conn.close()
    return {"status": "ok", "output_files": [str(p) for p in out_files]}
