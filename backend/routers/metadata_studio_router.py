import os
import re
import json
import shutil
import uuid
from pathlib import Path
from datetime import datetime, timezone, timedelta
from urllib.parse import unquote

import exiftool
from fastapi import APIRouter, HTTPException, File, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from settings_manager import get_configured_timezone
from library_manager import load_libraries, get_library_tech_dir
from pipeline_runner import STATE
from database import MISSING_META_SQL_CONDITION, get_active_db_and_dest, get_db, resolve_actual_path, log_library_action, build_file_entry
from media_editor import (
    FONT_EXTS,
    get_system_font_dirs,
    list_system_fonts,
    process_image_edits,
    process_video_edits,
    render_inpaint_preview_bytes,
    render_inpaint_preview_with_meta,
)
from ai_inpaint import get_ai_inpaint_status, start_lama_install
from ai_bg_remove import get_ai_bg_remove_status, start_bg_remove_install
from media_frames import IMAGE_EXTS, VIDEO_EXTS, probe_media_dimensions
import fusion_takeout_complet as fusion

router = APIRouter()


class BatchMetadataUpdatePayload(BaseModel):
    source_paths: list[str]
    start_datetime_iso: str | None = None
    utc_offset: str | None = None
    time_sequence_mode: str = "PRESERVE_GAPS"
    step_seconds: int = 15
    latitude: float | None = None
    longitude: float | None = None
    description: str | None = None


def _parse_utc_offset_str(raw: str | None) -> timezone | None:
    if not raw:
        return None
    txt = str(raw).strip().upper()
    if txt in ("Z", "UTC", "GMT", "UTC+0", "UTC-0"):
        return timezone.utc
    txt = txt.replace("UTC", "").replace("GMT", "").strip()
    m = re.match(r'^([+-])(\d{1,2})(?::?(\d{2}))?$', txt)
    if not m:
        return None
    sign = 1 if m.group(1) == "+" else -1
    hh = int(m.group(2))
    mm = int(m.group(3) or 0)
    if hh > 14 or mm >= 60:
        return None
    return timezone(timedelta(hours=hh, minutes=mm) * sign)


class BatchMetadataStripPayload(BaseModel):
    source_paths: list[str]
    strip_gps: bool = False
    strip_all_exif: bool = False


class MediaStudioEditPayload(BaseModel):
    source_path: str
    overwrite: bool = False
    auto_orient: bool = True
    crop: dict | None = None
    rotate: int = 0
    straighten: float = 0.0
    flip_h: bool = False
    flip_v: bool = False
    brightness: float = 1.0
    contrast: float = 1.0
    saturation: float = 1.0
    sharpness: float = 1.0
    warmth: float = 0.0
    tint: float = 0.0
    highlights: float = 0.0
    shadows: float = 0.0
    fade: float = 0.0
    grain: float = 0.0
    vignette: float = 0.0
    text_overlay: dict | None = None
    text_layers: list[dict] = []
    image_overlays: list[dict] = []
    border: dict | None = None
    extra_clips: list[dict] = []
    inpaint_boxes: list[dict] = []
    inpaint_strokes: list[dict] = []
    glare_strokes: list[dict] = []
    redeye_strokes: list[dict] = []
    blemish_strokes: list[dict] = []
    bg_remove: dict | None = None
    auto_retouch: dict | None = None
    border: dict | None = None
    draw_layer_png: str | None = None
    blur_mask_png: str | None = None
    blur_strokes: list[dict] = []
    pixel_mask_png: str | None = None
    pixel_strokes: list[dict] = []
    video_action: str = "EDIT"
    start_sec: float = 0.0
    end_sec: float = 0.0
    split_time_sec: float = 5.0
    speed: float = 1.0
    mute_audio: bool = False
    custom_audio_path: str | None = None
    audio_mix_mode: str = "replace"
    audio_volume: float = 1.0
    original_audio_volume: float = 1.0


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
    lib_cfg = load_libraries()
    active_lib = lib_cfg.get("libraries", {}).get(lib_cfg.get("active_library"), {})
    source_roots = active_lib.get("source_paths") or []
    fusion._DIR_JSON_CACHE.clear()
    fusion._MIRROR_DIRS_CACHE.clear()
    fusion._GLOBAL_JSON_INDEX_CACHE.clear()

    cur.execute(f"""
        SELECT source_path, dest_path, timestamp, status, latitude, longitude, is_favorite, album_name
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
            new_lat = r["latitude"] if (r["latitude"] and abs(r["latitude"]) > 1e-7) else None
            new_lon = r["longitude"] if (r["longitude"] and abs(r["longitude"]) > 1e-7) else None
            new_alt = None
            new_desc = None
            new_fav = bool(r.get("is_favorite"))
            new_status = "no_metadata"
            src_p = Path(r["source_path"])
            if src_p.exists():
                jp = fusion.find_matching_json(src_p, extra_roots=source_roots)
                if jp:
                    jmeta = fusion.extract_takeout_json_metadata(jp)
                    if jmeta["timestamp"]:
                        new_ts = jmeta["timestamp"]
                        new_status = "json_matched"
                    if new_lat is None and jmeta["lat"] is not None and jmeta["lon"] is not None:
                        new_lat, new_lon, new_alt = jmeta["lat"], jmeta["lon"], jmeta["alt"]
                    new_desc = jmeta["description"]
                    if jmeta["is_favorite"]:
                        new_fav = True

            if not new_ts:
                fn_ts = fusion.extract_date_from_filename(curr_p.name) or (fusion.extract_date_from_filename(src_p.name) if src_p.exists() else None)
                if fn_ts:
                    new_ts = fn_ts
                    new_status = "filename_date"

            if new_ts and new_ts > 0:
                t_info = fusion.resolve_datetime_with_dst(new_ts, new_lat, new_lon)
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
                    tags = fusion.build_exiftool_tags(
                        time_info=t_info,
                        is_video=is_vid,
                        ext_lower=new_dest.suffix.lower(),
                        lat=new_lat,
                        lon=new_lon,
                        alt=new_alt,
                        description=new_desc,
                        is_favorite=new_fav,
                        album_name=r.get("album_name"),
                    )
                    fusion.write_tags_resilient(et, new_dest, tags, is_video=is_vid)
                    os.utime(new_dest, (new_ts, new_ts))
                except Exception:
                    pass

                cur.execute(
                    """UPDATE processed_files
                       SET dest_path=?, original_dest_path=?, timestamp=?, status=?,
                           latitude=?, longitude=?, is_favorite=?
                       WHERE source_path=?""",
                    (
                        str(new_dest), str(new_dest), new_ts, new_status,
                        new_lat or 0.0, new_lon or 0.0, 1 if new_fav else 0,
                        r["source_path"]
                    )
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
    row = cur.execute("SELECT * FROM processed_files WHERE source_path = ?", (source_path,)).fetchone()
    if not row:
        row = cur.execute("SELECT * FROM processed_files WHERE source_path = ?", (src_clean,)).fetchone()
    if not row:
        row = cur.execute("SELECT * FROM processed_files WHERE dest_path = ? OR dest_path = ?", (source_path, src_clean)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Média introuvable")

    d = {k: v for k, v in dict(row).items() if not isinstance(v, (bytes, bytearray, memoryview))}
    raw_vis_json = d.pop("visual_suggestions_json", None)
    try:
        d["visual_suggestions"] = json.loads(raw_vis_json) if raw_vis_json else []
    except Exception:
        d["visual_suggestions"] = []
    src_clean = d["source_path"]
    tz = get_configured_timezone()
    try:
        dt_local = (
            datetime.fromtimestamp(float(d["timestamp"]), tz=timezone.utc).astimezone(tz)
            if d.get("timestamp") else datetime.now(tz)
        )
    except (OSError, ValueError, OverflowError, TypeError):
        dt_local = datetime.now(tz)
    d["datetime_local_iso"] = dt_local.strftime("%Y-%m-%dT%H:%M:%S") if d.get("timestamp") else ""
    off = dt_local.utcoffset()
    total_mins = int(off.total_seconds() // 60) if off else 0
    sign = "+" if total_mins >= 0 else "-"
    hh, mm = divmod(abs(total_mins), 60)
    d["utc_offset_label"] = f"UTC{sign}{hh}" if mm == 0 else f"UTC{sign}{hh}:{mm:02d}"
    d["timezone"] = getattr(tz, "key", str(tz))

    alb_tokens = [a.strip() for a in (d.get("album_name") or "").split(",") if a.strip()]
    albums_info = []
    if alb_tokens:
        albums_table: dict[str, dict] = {}
        try:
            for r in cur.execute("SELECT album_id, name, full_path, cover_path FROM albums").fetchall():
                albums_table[r["full_path"]] = dict(r)
        except Exception:
            albums_table = {}

        alb_stats = {a: {"count": 0, "cover_path": None, "max_ts": -1} for a in alb_tokens}
        cur.execute("""
            SELECT album_name, dest_path, timestamp
            FROM processed_files
            WHERE is_duplicate = 0 AND is_trashed = 0 AND album_name IS NOT NULL AND album_name != ''
        """)
        for r in cur.fetchall():
            row_tokens = [t.strip() for t in (r["album_name"] or "").split(",") if t.strip()]
            ts = r["timestamp"] or 0
            for alb_fp in alb_tokens:
                prefix = alb_fp + "/"
                if any(t == alb_fp or t.startswith(prefix) for t in row_tokens):
                    st = alb_stats[alb_fp]
                    st["count"] += 1
                    if ts >= st["max_ts"] or not st["cover_path"]:
                        st["max_ts"] = ts
                        st["cover_path"] = r["dest_path"]

        for alb_fp in alb_tokens:
            ar = albums_table.get(alb_fp)
            st = alb_stats.get(alb_fp, {"count": 0, "cover_path": None})
            cov = (ar.get("cover_path") if ar else None) or st["cover_path"] or d.get("dest_path") or ""
            albums_info.append({
                "name": alb_fp,
                "display_name": (ar["name"] if ar and ar.get("name") else alb_fp.split("/")[-1]),
                "album_id": ar["album_id"] if ar else None,
                "cover_path": cov,
                "count": st["count"] or 1,
            })

    d["albums"] = albums_info
    d["album_count"] = albums_info[0]["count"] if albums_info else 0

    cur.execute("""
        SELECT f.face_id, f.thumb_path, f.person_id, COALESCE(p.name, 'Inconnu') as name,
               COALESCE(pc.thumb_path, f.thumb_path) as person_thumb_path
        FROM faces f
        LEFT JOIN persons p ON f.person_id = p.person_id
        LEFT JOIN faces pc ON p.cover_face_id = pc.face_id
        WHERE f.source_path = ? OR f.dest_path = ?
    """, (src_clean, d.get("dest_path") or ""))
    d["faces"] = [dict(r) for r in cur.fetchall()]
    try:
        d["smart_categories"] = [
            dict(r) for r in cur.execute("""
                SELECT sc.category_id, sc.name, mc.assigned_by, mc.score
                FROM media_categories mc
                JOIN smart_categories sc ON sc.category_id = mc.category_id
                WHERE mc.source_path = ?
                ORDER BY mc.score DESC, sc.name ASC
            """, (src_clean,)).fetchall()
        ]
    except Exception:
        d["smart_categories"] = []

    d["location_city"] = ""
    d["location_label"] = ""
    if d.get("latitude") and d.get("longitude") and (d["latitude"] != 0 or d["longitude"] != 0):
        try:
            geo_row = cur.execute(
                "SELECT city, display_label FROM geocode_cache WHERE lat_key = ? AND lon_key = ?",
                (round(float(d["latitude"]), 2), round(float(d["longitude"]), 2)),
            ).fetchone()
            if geo_row:
                d["location_city"] = (geo_row["city"] or "").strip()
                d["location_label"] = (geo_row["display_label"] or d["location_city"]).strip()
        except Exception:
            pass
    conn.close()

    camera_model = ""
    lens_specs = ""
    description = ""
    file_tz = None
    actual_p = resolve_actual_path(d.get("dest_path") or "")
    if actual_p and actual_p.exists():
        try:
            with exiftool.ExifToolHelper(common_args=["-G", "-n", "-charset", "filename=utf8"]) as et:
                meta_list = et.get_metadata([str(actual_p)])
                if meta_list:
                    m = meta_list[0]
                    raw_off = (
                        m.get("EXIF:OffsetTimeOriginal")
                        or m.get("EXIF:OffsetTime")
                        or m.get("EXIF:OffsetTimeDigitized")
                    )
                    if not raw_off:
                        for dt_key in ("Keys:CreationDate", "QuickTime:CreationDate", "EXIF:DateTimeOriginal"):
                            val = str(m.get(dt_key) or "").strip()
                            off_m = re.search(r'(Z|[+-]\d{2}:?\d{2})$', val)
                            if off_m:
                                raw_off = off_m.group(1)
                                break
                    file_tz = _parse_utc_offset_str(raw_off)
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

                    if not d.get("width") or not d.get("height"):
                        w_val = m.get("File:ImageWidth") or m.get("EXIF:ExifImageWidth") or m.get("EXIF:ImageWidth") or m.get("QuickTime:ImageWidth") or m.get("PNG:ImageWidth") or 0
                        h_val = m.get("File:ImageHeight") or m.get("EXIF:ExifImageHeight") or m.get("EXIF:ImageHeight") or m.get("QuickTime:ImageHeight") or m.get("PNG:ImageHeight") or 0
                        if w_val and h_val:
                            d["width"] = int(w_val)
                            d["height"] = int(h_val)
        except Exception:
            pass

        if (not d.get("width") or not d.get("height")):
            try:
                from PIL import Image
                with Image.open(actual_p) as im:
                    d["width"], d["height"] = im.size
            except Exception:
                pass
        if not d.get("file_size"):
            try:
                d["file_size"] = actual_p.stat().st_size
            except Exception:
                pass

    eff_tz = file_tz or tz
    try:
        dt_eff = (
            datetime.fromtimestamp(float(d["timestamp"]), tz=timezone.utc).astimezone(eff_tz)
            if d.get("timestamp") else datetime.now(eff_tz)
        )
    except (OSError, ValueError, OverflowError, TypeError):
        dt_eff = datetime.now(eff_tz)
    d["datetime_local_iso"] = dt_eff.strftime("%Y-%m-%dT%H:%M:%S") if d.get("timestamp") else ""
    off = dt_eff.utcoffset()
    total_mins = int(off.total_seconds() // 60) if off else 0
    sign = "+" if total_mins >= 0 else "-"
    hh, mm = divmod(abs(total_mins), 60)
    d["utc_offset_label"] = f"UTC{sign}{hh}" if mm == 0 else f"UTC{sign}{hh}:{mm:02d}"
    d["file_utc_offset"] = f"{sign}{hh:02d}:{mm:02d}"
    default_tz_time_label = ""
    if d.get("timestamp"):
        try:
            dt_def = datetime.fromtimestamp(float(d["timestamp"]), tz=timezone.utc).astimezone(tz)
            def_off = dt_def.utcoffset()
            if def_off != off:
                d_mins = int(def_off.total_seconds() // 60) if def_off else 0
                d_sgn = "+" if d_mins >= 0 else "-"
                dh, dm = divmod(abs(d_mins), 60)
                def_utc = f"UTC{d_sgn}{dh}" if dm == 0 else f"UTC{d_sgn}{dh}:{dm:02d}"
                time_part = dt_def.strftime("%Hh%M") if dt_def.date() == dt_eff.date() else dt_def.strftime("%d/%m %Hh%M")
                default_tz_time_label = f"({time_part} {def_utc})"
        except (OSError, ValueError, OverflowError, TypeError):
            pass
    d["default_tz_time_label"] = default_tz_time_label
    d["camera_model"] = camera_model or "Appareil standard"
    d["lens_specs"] = lens_specs
    d["description"] = description
    return d


@router.post("/api/metadata/batch_update")
def api_batch_update_metadata(payload: BatchMetadataUpdatePayload):
    conn = get_db()
    cur = conn.cursor()
    tz = get_configured_timezone()
    custom_tz = _parse_utc_offset_str(payload.utc_offset)
    target_tz = custom_tz or tz
    ph = ",".join("?" for _ in payload.source_paths)
    cur.execute(f"SELECT source_path, dest_path, timestamp, latitude, longitude FROM processed_files WHERE source_path IN ({ph})", payload.source_paths)
    rows_map = {r["source_path"]: dict(r) for r in cur.fetchall()}
    ordered = [rows_map[s] for s in payload.source_paths if s in rows_map]

    base_new_ts = int(datetime.fromisoformat(payload.start_datetime_iso).replace(tzinfo=target_tz).timestamp()) if payload.start_datetime_iso else None
    first_orig_ts = ordered[0]["timestamp"] if ordered else 0
    updated_meta_files: list[dict] = []
    failed_meta_files: list[dict] = []

    with exiftool.ExifToolHelper() as et:
        for idx, item in enumerate(ordered):
            curr_p = Path(item["dest_path"])
            if not curr_p.exists():
                failed_meta_files.append({"path": str(curr_p).replace("\\", "/"), "name": curr_p.name, "reason": "Fichier introuvable sur le disque"})
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
                if custom_tz is not None:
                    dt_c = datetime.fromtimestamp(new_ts, tz=timezone.utc).astimezone(custom_tz)
                    off = dt_c.utcoffset()
                    t_mins = int(off.total_seconds() // 60) if off else 0
                    sgn = "+" if t_mins >= 0 else "-"
                    oh, om = divmod(abs(t_mins), 60)
                    off_str = f"{sgn}{oh:02d}:{om:02d}"
                    t_info = {
                        "exif_local_str": dt_c.strftime("%Y:%m:%d %H:%M:%S"),
                        "offset_str": off_str,
                        "exif_utc_str": datetime.fromtimestamp(new_ts, tz=timezone.utc).strftime("%Y:%m:%d %H:%M:%S"),
                        "iso_local_with_tz": dt_c.strftime("%Y-%m-%dT%H:%M:%S") + off_str,
                    }
                else:
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

            exif_err = None
            if tags:
                try:
                    et.set_tags([str(curr_p)], tags=tags, params=["-overwrite_original", "-P", "-q", "-api", "QuickTimeUTC=0"])
                except Exception as e:
                    exif_err = str(e)
            if new_ts:
                os.utime(curr_p, (new_ts, new_ts))
            cur.execute("UPDATE processed_files SET timestamp=?, latitude=?, longitude=? WHERE source_path=?", (new_ts, new_lat, new_lon, item["source_path"]))
            if exif_err:
                failed_meta_files.append({"path": str(curr_p).replace("\\", "/"), "name": curr_p.name, "reason": exif_err[:240]})
            else:
                updated_meta_files.append(build_file_entry(str(curr_p)))

    conn.commit()
    conn.close()
    if updated_meta_files or failed_meta_files:
        log_library_action(
            "METADATA_EDIT",
            "Métadonnées modifiées",
            f"{len(updated_meta_files)} fichier(s) mis à jour" + (f", {len(failed_meta_files)} échec(s)" if failed_meta_files else ""),
            status="error" if (failed_meta_files and not updated_meta_files) else ("partial" if failed_meta_files else "success"),
            reason=f"{len(failed_meta_files)} erreur(s) ExifTool" if failed_meta_files else "",
            total_items=len(ordered),
            success_count=len(updated_meta_files),
            files=updated_meta_files,
            failed_files=failed_meta_files,
        )
    return {"status": "updated"}


@router.post("/api/metadata/batch_strip")
def api_batch_strip_metadata(payload: BatchMetadataStripPayload):
    conn = get_db()
    cur = conn.cursor()
    ph = ",".join("?" for _ in payload.source_paths)
    cur.execute(f"SELECT source_path, dest_path, timestamp FROM processed_files WHERE source_path IN ({ph})", payload.source_paths)
    stripped_files: list[dict] = []
    failed_strip: list[dict] = []
    with exiftool.ExifToolHelper() as et:
        for r in cur.fetchall():
            p = Path(r["dest_path"])
            if not p.exists():
                failed_strip.append({"path": str(p).replace("\\", "/"), "name": p.name, "reason": "Fichier introuvable"})
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
                stripped_files.append(build_file_entry(str(p)))
            except Exception as e:
                failed_strip.append({"path": str(p).replace("\\", "/"), "name": p.name, "reason": str(e)[:240]})
            if payload.strip_all_exif or payload.strip_gps:
                cur.execute("UPDATE processed_files SET latitude=0.0, longitude=0.0 WHERE source_path=?", (r["source_path"],))
    conn.commit()
    conn.close()
    if stripped_files or failed_strip:
        log_library_action(
            "METADATA_STRIP",
            "Métadonnées supprimées",
            f"{len(stripped_files)} fichier(s) nettoyé(s)",
            status="partial" if failed_strip else "success",
            files=stripped_files,
            failed_files=failed_strip,
        )
    return {"status": "stripped"}


class StudioLayerTemplatePayload(BaseModel):
    template_id: str | None = None
    name: str
    category: str = "watermark"
    text_layers: list[dict] = []
    image_overlays: list[dict] = []
    border: dict | None = None


LAYER_TEMPLATES_FILE = Path(__file__).resolve().parents[2] / "config" / "studio_layer_templates.json"

DEFAULT_LAYER_TEMPLATES = [
    {
        "id": "builtin_wm_signature",
        "name": "Watermark © Signature",
        "category": "watermark",
        "builtin": True,
        "text_layers": [
            {"text": "© Phototo Studio", "nx": 0.62, "ny": 0.88, "size": 28, "color": "#ffffff", "bg_color": "transparent", "opacity": 0.55}
        ],
        "image_overlays": [],
    },
    {
        "id": "builtin_wm_pill",
        "name": "Badge Discret Bas-Gauche",
        "category": "watermark",
        "builtin": True,
        "text_layers": [
            {"text": "© Mon Studio", "nx": 0.04, "ny": 0.88, "size": 24, "color": "#ffffff", "bg_color": "dark", "opacity": 0.82}
        ],
        "image_overlays": [],
    },
    {
        "id": "builtin_wm_mosaic",
        "name": "Filigrane Mosaïque (3x)",
        "category": "watermark",
        "builtin": True,
        "text_layers": [
            {"text": "© PROTÉGÉ", "nx": 0.08, "ny": 0.14, "size": 30, "color": "#ffffff", "bg_color": "transparent", "opacity": 0.30},
            {"text": "© PROTÉGÉ", "nx": 0.36, "ny": 0.46, "size": 34, "color": "#ffffff", "bg_color": "transparent", "opacity": 0.34},
            {"text": "© PROTÉGÉ", "nx": 0.64, "ny": 0.80, "size": 30, "color": "#ffffff", "bg_color": "transparent", "opacity": 0.30},
        ],
        "image_overlays": [],
    },
    {
        "id": "builtin_title_banner",
        "name": "Titre Légende Cinéma",
        "category": "titre",
        "builtin": True,
        "text_layers": [
            {"text": "Souvenir", "nx": 0.38, "ny": 0.86, "size": 34, "color": "#fbbf24", "bg_color": "dark", "opacity": 0.92}
        ],
        "image_overlays": [],
    },
]


def _load_custom_layer_templates() -> list[dict]:
    if not LAYER_TEMPLATES_FILE.exists():
        return []
    try:
        data = json.loads(LAYER_TEMPLATES_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _save_custom_layer_templates(items: list[dict]):
    LAYER_TEMPLATES_FILE.parent.mkdir(parents=True, exist_ok=True)
    LAYER_TEMPLATES_FILE.write_text(json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")


@router.get("/api/studio/layer_templates")
def api_list_layer_templates():
    custom = _load_custom_layer_templates()
    return {"templates": custom + DEFAULT_LAYER_TEMPLATES}


@router.post("/api/studio/layer_templates")
def api_save_layer_template(payload: StudioLayerTemplatePayload):
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(400, "Le nom du modèle est requis")
    has_border = bool(payload.border and (payload.border.get("style") or "none") != "none")
    if not payload.text_layers and not payload.image_overlays and not has_border:
        raise HTTPException(400, "Ajoutez au moins un texte, une image/logo ou une bordure au modèle")
    items = _load_custom_layer_templates()
    tid = (payload.template_id or "").strip()
    if tid and tid.startswith("builtin_"):
        tid = ""
    tpl = {
        "id": tid or f"tpl_{uuid.uuid4().hex[:10]}",
        "name": name,
        "category": payload.category or "watermark",
        "builtin": False,
        "text_layers": list(payload.text_layers or []),
        "image_overlays": list(payload.image_overlays or []),
        "border": dict(payload.border) if has_border else None,
    }
    replaced = False
    for idx, existing in enumerate(items):
        if existing.get("id") == tpl["id"]:
            items[idx] = tpl
            replaced = True
            break
    if not replaced:
        items.insert(0, tpl)
    _save_custom_layer_templates(items)
    return {"status": "ok", "template": tpl, "templates": items + DEFAULT_LAYER_TEMPLATES}


@router.put("/api/studio/layer_templates/{template_id}")
def api_update_layer_template(template_id: str, payload: StudioLayerTemplatePayload):
    payload_copy = payload.model_copy(update={"template_id": template_id})
    return api_save_layer_template(payload_copy)


@router.delete("/api/studio/layer_templates/{template_id}")
def api_delete_layer_template(template_id: str):
    items = [it for it in _load_custom_layer_templates() if it.get("id") != template_id]
    _save_custom_layer_templates(items)
    return {"status": "ok", "templates": items + DEFAULT_LAYER_TEMPLATES}


@router.post("/api/studio/upload_asset")
async def api_upload_studio_asset(file: UploadFile = File(...)):
    _, dest_dir = get_active_db_and_dest()
    assets_dir = get_library_tech_dir(dest_dir, "_Studio_Assets")
    assets_dir.mkdir(parents=True, exist_ok=True)
    raw_name = Path(file.filename or "asset.bin").name
    safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", raw_name) or "asset.bin"
    target_path = assets_dir / f"{uuid.uuid4().hex[:8]}_{safe_name}"
    with open(target_path, "wb") as f:
        while chunk := await file.read(1024 * 512):
            f.write(chunk)
    ext = target_path.suffix.lower()
    audio_exts = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"}
    kind = "audio" if ext in audio_exts else ("video" if ext in VIDEO_EXTS else "image")
    w, h = (0, 0)
    dur = 0.0
    if kind in ("image", "video"):
        w, h = probe_media_dimensions(target_path)
    if kind == "video":
        try:
            import cv2
            cap = cv2.VideoCapture(str(target_path))
            fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
            frames = float(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0)
            cap.release()
            if fps > 0 and frames > 0:
                dur = round(frames / fps, 2)
        except Exception:
            dur = 0.0
    elif kind == "image":
        dur = 3.0
    return {
        "status": "ok",
        "path": str(target_path),
        "name": raw_name,
        "kind": kind,
        "width": w,
        "height": h,
        "duration_sec": dur,
    }


@router.get("/api/studio/system_fonts")
def api_studio_system_fonts():
    return {"fonts": list_system_fonts()}


@router.get("/api/studio/font_file")
def api_studio_font_file(path: str):
    fp = Path(unquote(path)).resolve()
    if not fp.exists() or not fp.is_file() or fp.suffix.lower() not in FONT_EXTS:
        raise HTTPException(404, "Police introuvable")
    allowed_roots = [d.resolve() for d in get_system_font_dirs()]
    if not any(fp == root or root in fp.parents for root in allowed_roots):
        raise HTTPException(403, "Accès refusé hors dossier polices")
    media_type = "font/otf" if fp.suffix.lower() == ".otf" else "font/ttf"
    return FileResponse(str(fp), media_type=media_type, headers={"Cache-Control": "public, max-age=86400"})


@router.get("/api/studio/ai_inpaint/status")
def api_studio_ai_inpaint_status():
    return get_ai_inpaint_status()


@router.post("/api/studio/ai_inpaint/install")
def api_studio_ai_inpaint_install():
    return start_lama_install()


@router.get("/api/studio/ai_bg_remove/status")
def api_studio_ai_bg_remove_status():
    return get_ai_bg_remove_status()


@router.post("/api/studio/ai_bg_remove/install")
def api_studio_ai_bg_remove_install():
    return start_bg_remove_install()


@router.post("/api/studio/preview_eraser")
def api_preview_studio_eraser(payload: MediaStudioEditPayload):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT dest_path FROM processed_files WHERE source_path = ?", (unquote(payload.source_path),))
    row = cur.fetchone()
    conn.close()
    if not row:
        raise HTTPException(404, "Média introuvable")
    media_p = resolve_actual_path(row["dest_path"]) or Path(row["dest_path"])
    if not media_p.exists() or media_p.suffix.lower() in VIDEO_EXTS:
        raise HTTPException(400, "Aperçu effaceur réservé aux photos existantes")
    out_bytes, engine = render_inpaint_preview_with_meta(media_p, payload.model_dump())
    mime = "image/png" if out_bytes[:8] == b"\x89PNG\r\n\x1a\n" else "image/jpeg"
    return Response(content=out_bytes, media_type=mime, headers={"Cache-Control": "no-store", "X-Inpaint-Engine": engine})


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
        log_library_action("MEDIA_EDIT", "Échec d'édition (Studio)", f"{media_p.name}", status="error", reason=str(e), failed_files=[{"path": str(media_p).replace("\\", "/"), "name": media_p.name, "reason": str(e)}])
        raise HTTPException(500, f"Erreur d'édition : {e}")

    for out_p in out_files:
        w, h = probe_media_dimensions(out_p)
        dur = 0.0
        if out_p.suffix.lower() in VIDEO_EXTS:
            try:
                import cv2
                cap = cv2.VideoCapture(str(out_p))
                fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
                frames = float(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0)
                cap.release()
                if fps > 0 and frames > 0:
                    dur = round(frames / fps, 2)
            except Exception:
                dur = 0.0
        if out_p != media_p:
            cur.execute("""
                INSERT OR REPLACE INTO processed_files
                (source_path, dest_path, original_dest_path, status, timestamp, is_favorite, is_trashed, album_name, latitude, longitude, file_size, width, height, duration_sec)
                VALUES (?, ?, ?, 'edited_copy', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
            """, (str(out_p), str(out_p), str(out_p), row["timestamp"], row["is_favorite"], row["album_name"], row["latitude"], row["longitude"], out_p.stat().st_size, w, h, dur))
        else:
            cur.execute(
                "UPDATE processed_files SET file_size=?, width=?, height=?, duration_sec=?, blake3_hash=NULL WHERE source_path=?",
                (out_p.stat().st_size, w, h, dur, row["source_path"]),
            )

    conn.commit()
    conn.close()
    log_library_action(
        "MEDIA_EDIT",
        "Média modifié (Studio)",
        f"{media_p.name} enregistré",
        files=[build_file_entry(str(p)) for p in out_files],
    )
    return {"status": "ok", "output_files": [str(p) for p in out_files]}


class RenameMediaPayload(BaseModel):
    source_path: str
    new_name: str


@router.post("/api/media/rename")
def api_rename_media(payload: RenameMediaPayload):
    import re
    clean_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", (payload.new_name or "").strip())
    if not clean_name:
        raise HTTPException(400, "Nom de fichier invalide")

    conn = get_db()
    cur = conn.cursor()
    src_clean = unquote(payload.source_path)
    cur.execute("SELECT source_path, dest_path FROM processed_files WHERE source_path = ?", (src_clean,))
    row = cur.fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Média introuvable")

    old_dest = row["dest_path"] or ""
    actual_p = resolve_actual_path(old_dest)
    if not actual_p or not actual_p.exists():
        conn.close()
        raise HTTPException(404, "Fichier introuvable sur le disque")

    orig_ext = actual_p.suffix
    if orig_ext and not clean_name.lower().endswith(orig_ext.lower()):
        clean_name = f"{clean_name}{orig_ext}"

    new_p = actual_p.parent / clean_name
    if new_p == actual_p:
        conn.close()
        return {"status": "ok", "dest_path": str(actual_p), "filename": actual_p.name}
    if new_p.exists():
        conn.close()
        raise HTTPException(409, "Un fichier portant ce nom existe déjà")

    actual_p.rename(new_p)
    new_dest_str = str(new_p)
    cur.execute("UPDATE processed_files SET dest_path = ? WHERE source_path = ?", (new_dest_str, src_clean))
    cur.execute("UPDATE faces SET dest_path = ? WHERE dest_path = ?", (new_dest_str, old_dest))
    conn.commit()
    conn.close()
    log_library_action(
        "MEDIA_RENAME",
        "Fichier renommé",
        f"{actual_p.name} → {new_p.name}",
        files=[build_file_entry(new_dest_str, f"Ancien nom : {actual_p.name}")],
    )
    return {"status": "ok", "dest_path": new_dest_str, "filename": new_p.name}


class RevealMediaPayload(BaseModel):
    source_path: str


@router.post("/api/media/reveal")
def api_reveal_media(payload: RevealMediaPayload):
    import subprocess
    import sys

    conn = get_db()
    cur = conn.cursor()
    src_clean = unquote(payload.source_path)
    cur.execute("SELECT dest_path FROM processed_files WHERE source_path = ?", (src_clean,))
    row = cur.fetchone()
    conn.close()

    target = resolve_actual_path(row["dest_path"] if row else src_clean)
    if not target or not target.exists():
        raise HTTPException(404, "Fichier introuvable sur le disque")

    if sys.platform == "win32":
        subprocess.Popen(["explorer", f"/select,{target}"])
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(target)])
    else:
        subprocess.Popen(["xdg-open", str(target.parent)])

    return {"status": "ok"}


class AnalyzeSingleMediaPayload(BaseModel):
    source_path: str
    run_faces: bool = True
    run_visual: bool = True
    force_faces: bool = False


class ApplyMediaCategoriesPayload(BaseModel):
    source_path: str
    categories: list[dict] = []


@router.post("/api/media/analyze_single")
def api_analyze_single_media(payload: AnalyzeSingleMediaPayload):
    import numpy as np
    from settings_manager import load_settings, get_hardware_runtime_config
    from media_frames import extract_analysis_frames

    conn = get_db()
    cur = conn.cursor()
    row = cur.execute(
        "SELECT source_path, dest_path, timestamp, faces_scanned, faces_model, clip_scanned, clip_model, clip_embedding FROM processed_files WHERE source_path = ?",
        (payload.source_path,),
    ).fetchone()
    if not row:
        src_clean = unquote(payload.source_path)
        row = cur.execute(
            "SELECT source_path, dest_path, timestamp, faces_scanned, faces_model, clip_scanned, clip_model, clip_embedding FROM processed_files WHERE source_path = ?",
            (src_clean,),
        ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Média introuvable")
    src_clean = row["source_path"]

    dest_path = row["dest_path"] or ""
    actual_p = resolve_actual_path(dest_path)
    if not actual_p or not actual_p.exists():
        conn.close()
        raise HTTPException(404, "Fichier introuvable sur le disque")

    result = {"status": "ok", "faces": [], "visual_candidates": [], "faces_error": None, "visual_error": None}
    db_p, dest_dir = get_active_db_and_dest()

    if payload.run_faces:
        try:
            import indexeur_visages as faces_ai
            from pipeline_runner import _assign_unclustered_faces_incremental

            faces_ai.DB_PATH = db_p
            faces_ai.DEST_DIR = dest_dir
            faces_ai.THUMBS_DIR = get_library_tech_dir(dest_dir, "Miniatures_Visages")
            faces_ai.init_face_tables(conn)

            if payload.force_faces:
                faces_ai.snapshot_named_face_hints(conn)
                cur.execute(
                    "DELETE FROM faces WHERE (source_path = ? OR dest_path = ?) AND embedding IS NOT NULL",
                    (src_clean, dest_path),
                )
                conn.commit()

            existing = cur.execute("""
                SELECT f.face_id, f.thumb_path, f.person_id, f.bbox, COALESCE(p.name, 'Inconnu') as name
                FROM faces f LEFT JOIN persons p ON f.person_id = p.person_id
                WHERE f.source_path = ? OR f.dest_path = ?
            """, (src_clean, dest_path)).fetchall()

            if not existing or payload.force_faces:
                manual_boxes = [
                    faces_ai._parse_bbox_coords(r["bbox"])
                    for r in existing if r["bbox"]
                ]
                hw = get_hardware_runtime_config()
                faces_model = str(load_settings().get("faces_model", "buffalo_l")).strip()
                if faces_model not in ("buffalo_s", "buffalo_l", "antelopev2"):
                    faces_model = "buffalo_l"
                frames = extract_analysis_frames(str(actual_p))
                if not frames:
                    raise ValueError(f"Impossible de décoder les images du fichier ({actual_p.name})")

                app = faces_ai.create_face_analysis(
                    faces_model=faces_model,
                    providers=hw["onnx_providers"],
                    ctx_id=hw["onnx_ctx_id"],
                    det_size=faces_ai.DET_SIZE,
                    det_thresh=0.45,
                )

                def _collect_face_candidates(min_score: float, min_pixels: int) -> list[dict]:
                    cands = []
                    for f_idx_frame, img in enumerate(frames):
                        for f_idx, face in enumerate(app.get(img)):
                            bbox = face.bbox.astype(int).tolist()
                            if float(face.det_score) < min_score or (bbox[2] - bbox[0]) < min_pixels or (bbox[3] - bbox[1]) < min_pixels:
                                continue
                            b_tup = (bbox[0], bbox[1], bbox[2], bbox[3])
                            if any(mb and faces_ai._bbox_match_score(b_tup, mb) >= 0.40 for mb in manual_boxes):
                                continue
                            cands.append({
                                "img": img, "bbox": bbox, "det_score": float(face.det_score),
                                "emb": face.normed_embedding.astype(np.float32),
                                "uid": f"{abs(hash(src_clean))}_f{f_idx_frame}_{f_idx}",
                            })
                    return cands

                raw_cands = _collect_face_candidates(min_score=0.45, min_pixels=24)
                if not raw_cands:
                    try:
                        app.prepare(ctx_id=hw["onnx_ctx_id"], det_thresh=0.30, det_size=(1024, 1024))
                    except Exception:
                        app.prepare(ctx_id=-1, det_thresh=0.30, det_size=(1024, 1024))
                    raw_cands = _collect_face_candidates(min_score=0.35, min_pixels=20)

                for mf in faces_ai.deduplicate_video_faces(raw_cands):
                    thumb = faces_ai.save_face_thumbnail(mf["img"], mf["bbox"], mf["uid"])
                    b = mf["bbox"]
                    cur.execute(
                        "INSERT INTO faces (source_path, dest_path, timestamp, bbox, det_score, embedding, thumb_path) VALUES (?,?,?,?,?,?,?)",
                        (src_clean, dest_path, row["timestamp"] or 0, f"{b[0]},{b[1]},{b[2]},{b[3]}", mf["det_score"], mf["emb"].tobytes(), thumb),
                    )
                cur.execute("UPDATE processed_files SET faces_scanned = 1, faces_model = ? WHERE source_path = ?", (faces_model, src_clean))
                conn.commit()
                faces_ai.apply_face_name_hints(conn)
                _assign_unclustered_faces_incremental(conn)

            result["faces"] = [
                dict(r) for r in cur.execute("""
                    SELECT f.face_id, f.thumb_path, f.person_id, COALESCE(p.name, 'Inconnu') as name
                    FROM faces f LEFT JOIN persons p ON f.person_id = p.person_id
                    WHERE f.source_path = ? OR f.dest_path = ?
                """, (src_clean, dest_path)).fetchall()
            ]
        except Exception as e:
            result["faces_error"] = str(e).strip() or type(e).__name__

    if payload.run_visual:
        try:
            import cv2
            from PIL import Image
            import indexeur_semantique_gps as clip_gps_ai
            from gallery_router import (
                _AI_CATEGORY_CATALOG,
                resolve_clip_category_prompt,
            )

            clip_gps_ai.upgrade_db_for_clip_and_gps(conn)
            vision_model, text_model = clip_gps_ai.get_clip_models()
            clip_key = str(load_settings().get("clip_model", "vit-b-32")).strip().lower()

            assigned_names = {
                r[0].lower() for r in cur.execute(
                    "SELECT sc.name FROM media_categories mc JOIN smart_categories sc ON sc.category_id = mc.category_id WHERE mc.source_path = ?",
                    (src_clean,),
                ).fetchall()
            }
            existing_cats = [dict(r) for r in cur.execute("SELECT category_id, name, prompt, prompt_en FROM smart_categories").fetchall()]
            candidates = []
            prompts = []
            seen = set()
            updated_en = False
            for c in existing_cats:
                seen.add(c["name"].lower())
                fr_p = c["prompt"] or c["name"]
                en_p = resolve_clip_category_prompt(c["name"], fr_p, clip_key, prompt_en=c.get("prompt_en"))
                if clip_key != "vit-b-32" and not c.get("prompt_en"):
                    cur.execute("UPDATE smart_categories SET prompt_en = ? WHERE category_id = ?", (en_p, c["category_id"]))
                    updated_en = True
                candidates.append((c["name"], fr_p))
                prompts.append(en_p)
            if updated_en:
                conn.commit()
            for c_name, c_prompt in _AI_CATEGORY_CATALOG:
                if c_name.lower() not in seen:
                    seen.add(c_name.lower())
                    candidates.append((c_name, c_prompt))
                    prompts.append(resolve_clip_category_prompt(c_name, c_prompt, clip_key))

            text_embs = np.asarray(text_model.encode(prompts, normalize_embeddings=True, show_progress_bar=False), dtype=np.float32)
            expected_dim = int(text_embs.shape[1]) if text_embs.ndim == 2 else 0

            m_emb = None
            row_clip_model = (row["clip_model"] or "").strip().lower()
            if row["clip_embedding"] and (not row_clip_model or row_clip_model == clip_key):
                cached_emb = np.frombuffer(row["clip_embedding"], dtype=np.float16).astype(np.float32)
                if expected_dim == 0 or cached_emb.shape[0] == expected_dim:
                    m_emb = cached_emb

            if m_emb is None:
                frames = extract_analysis_frames(str(actual_p), max_dim=512)
                pil_frames = [Image.fromarray(cv2.cvtColor(f_bgr, cv2.COLOR_BGR2RGB)) for f_bgr in frames]
                if pil_frames:
                    embs = vision_model.encode(pil_frames, batch_size=8, normalize_embeddings=True, show_progress_bar=False)
                    m_emb = np.mean(embs, axis=0).astype(np.float32)
                    norm = np.linalg.norm(m_emb)
                    if norm > 0:
                        m_emb = m_emb / norm
                    cur.execute(
                        "UPDATE processed_files SET clip_embedding = ?, clip_scanned = 1, clip_model = ? WHERE source_path = ?",
                        (m_emb.astype(np.float16).tobytes(), clip_key, src_clean),
                    )
                    conn.commit()

            if m_emb is not None:
                norm = np.linalg.norm(m_emb)
                if norm > 0:
                    m_emb = m_emb / norm

                min_thresh = 0.18 if clip_key == "vit-b-32" else 0.16
                sims = np.dot(text_embs, m_emb)
                all_ranked = []
                scored = []
                for (c_name, c_prompt), sc in zip(candidates, sims):
                    score_val = float(sc)
                    is_assigned = c_name.lower() in assigned_names
                    item_dict = {
                        "name": c_name,
                        "prompt": c_prompt,
                        "score": round(score_val, 3),
                        "percent": max(1, min(99, int(round(score_val * 100)))),
                        "already_assigned": is_assigned,
                        "confident": score_val >= min_thresh or is_assigned,
                    }
                    all_ranked.append(item_dict)
                    if item_dict["confident"]:
                        scored.append(item_dict)

                if not scored:
                    all_ranked.sort(key=lambda x: x["score"], reverse=True)
                    scored = all_ranked[:5]
                else:
                    scored.sort(key=lambda x: (x["already_assigned"], x["score"]), reverse=True)
                result["visual_candidates"] = scored[:12]
                cur.execute(
                    "UPDATE processed_files SET visual_suggestions_json = ? WHERE source_path = ?",
                    (json.dumps(result["visual_candidates"], ensure_ascii=False), src_clean),
                )
                conn.commit()
        except Exception as e:
            result["visual_error"] = str(e)

    conn.close()
    return result


@router.post("/api/media/apply_categories")
def api_apply_media_categories(payload: ApplyMediaCategoriesPayload):
    from gallery_router import _AI_CATEGORY_EN_PROMPTS
    from prompt_translator import translate_fr_to_en

    conn = get_db()
    cur = conn.cursor()
    row = cur.execute("SELECT source_path FROM processed_files WHERE source_path = ?", (payload.source_path,)).fetchone()
    src_clean = row["source_path"] if row else unquote(payload.source_path)
    cur.execute("DELETE FROM media_categories WHERE source_path = ?", (src_clean,))
    for cat in payload.categories:
        c_name = str(cat.get("name") or "").strip()
        if not c_name:
            continue
        c_prompt = str(cat.get("prompt") or c_name).strip()
        c_prompt_en = _AI_CATEGORY_EN_PROMPTS.get(c_name) or translate_fr_to_en(c_prompt)
        c_score = float(cat.get("score") or 1.0)
        cur.execute(
            "INSERT OR IGNORE INTO smart_categories (name, prompt, prompt_en, source) VALUES (?, ?, ?, 'AI')",
            (c_name, c_prompt, c_prompt_en),
        )
        row = cur.execute("SELECT category_id FROM smart_categories WHERE name = ?", (c_name,)).fetchone()
        if row:
            cur.execute(
                "INSERT OR REPLACE INTO media_categories (source_path, category_id, assigned_by, score) VALUES (?, ?, 'USER', ?)",
                (src_clean, row["category_id"], c_score),
            )
    conn.commit()
    conn.close()
    log_library_action(
        "CATEGORY_EDIT",
        "Catégories modifiées",
        f"{Path(src_clean).name} ({len(payload.categories)} catégorie(s))",
        files=[build_file_entry(src_clean)],
    )
    return {"status": "ok"}
