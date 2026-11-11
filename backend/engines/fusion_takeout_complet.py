import os
import re
import json
import time
import shutil
import sqlite3
import atexit
from pathlib import Path
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
import exiftool
from settings_manager import get_configured_timezone
from media_frames import ALL_MEDIA_EXTS, VIDEO_EXTS

try:
    from timezonefinder import TimezoneFinder
    tf_instance = TimezoneFinder(in_memory=True)
except ImportError:
    tf_instance = None

DEST_DIR = Path("./Photos_Triees")
DB_PATH = Path("progression_takeout.db")
MAX_WORKERS = min(8, os.cpu_count() or 4)
IGNORED_EXTS = {'.json', '.html', '.htm', '.txt', '.db', '.ini', '.ds_store'}

MOIS_FR = {
    1: "01 - Janvier", 2: "02 - Février", 3: "03 - Mars", 4: "04 - Avril",
    5: "05 - Mai", 6: "06 - Juin", 7: "07 - Juillet", 8: "08 - Août",
    9: "09 - Septembre", 10: "10 - Octobre", 11: "11 - Novembre", 12: "12 - Décembre"
}

GENERIC_FOLDERS = {
    "Google Photos", "Takeout", "Archive", "Corbeille", "Trash", "Bin"
}

worker_et = None
worker_tz = ZoneInfo("Europe/Paris")
worker_dest_dir = DEST_DIR
worker_is_takeout = True
worker_organize = True


def init_db(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=30000;")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS processed_files (
            source_path TEXT PRIMARY KEY,
            dest_path TEXT,
            original_dest_path TEXT,
            status TEXT,
            timestamp INTEGER,
            trashed_at INTEGER,
            is_favorite INTEGER DEFAULT 0,
            is_trashed INTEGER DEFAULT 0,
            is_archived INTEGER DEFAULT 0,
            album_name TEXT,
            latitude REAL,
            longitude REAL,
            file_size INTEGER,
            blake3_hash TEXT,
            phash TEXT,
            width INTEGER,
            height INTEGER,
            is_duplicate INTEGER DEFAULT 0,
            duplicate_of TEXT,
            faces_scanned INTEGER DEFAULT 0,
            ocr_scanned INTEGER DEFAULT 0,
            clip_scanned INTEGER DEFAULT 0,
            clip_embedding BLOB,
            video_hash TEXT,
            duration_sec REAL,
            error_msg TEXT,
            processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    return conn


def get_already_processed(conn: sqlite3.Connection) -> set[str]:
    cur = conn.cursor()
    cur.execute("SELECT source_path FROM processed_files WHERE status != 'error'")
    return {row[0] for row in cur.fetchall()}


def save_batch_to_db(conn: sqlite3.Connection, batch: list[tuple]):
    conn.executemany("""
        INSERT OR REPLACE INTO processed_files
        (source_path, dest_path, original_dest_path, status, timestamp, trashed_at,
         is_favorite, is_trashed, is_archived, album_name, latitude, longitude,
         file_size, duration_sec, error_msg)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, batch)
    conn.commit()


def init_worker(dest_dir_str: str = "", is_takeout: bool = True, organize: bool = True):
    global worker_et, worker_tz, worker_dest_dir, worker_is_takeout, worker_organize
    worker_tz = get_configured_timezone()
    if dest_dir_str:
        worker_dest_dir = Path(dest_dir_str)
    worker_is_takeout = is_takeout
    worker_organize = organize
    worker_et = exiftool.ExifToolHelper(common_args=["-G", "-n", "-charset", "filename=utf8"])
    worker_et.run()
    atexit.register(worker_et.terminate)


def find_matching_json(media_path: Path) -> Path | None:
    parent = media_path.parent
    name = media_path.name
    stem = media_path.stem
    ext = media_path.suffix

    for suffix in (".supplemental-metadata.json", ".json"):
        cand = parent / f"{name}{suffix}"
        if cand.exists():
            return cand

    dup_match = re.search(r'(\(\d+\))$', stem)
    if dup_match:
        num = dup_match.group(1)
        base = stem[:dup_match.start()]
        for suffix in (".supplemental-metadata", ""):
            c1 = parent / f"{base}{ext}{suffix}{num}.json"
            if c1.exists():
                return c1
            c2 = parent / f"{base}{ext}{num}{suffix}.json"
            if c2.exists():
                return c2

    clean_stem = re.sub(r'-(modifié|edited|effects|smile|collage)$', '', stem, flags=re.IGNORECASE)
    if clean_stem != stem:
        for suffix in (".supplemental-metadata.json", ".json"):
            c3 = parent / f"{clean_stem}{ext}{suffix}"
            if c3.exists():
                return c3

    if len(name) >= 44:
        prefix = name[:44]
        try:
            for jfile in parent.glob(f"{prefix}*.json"):
                return jfile
        except Exception:
            pass

    return None


def resolve_datetime_with_dst(utc_timestamp: int, lat: float | None = None, lon: float | None = None) -> dict:
    global worker_tz
    dt_utc = datetime.fromtimestamp(utc_timestamp, tz=timezone.utc)
    target_tz = worker_tz or get_configured_timezone()

    if tf_instance and lat and lon and (lat != 0.0 or lon != 0.0):
        try:
            tz_name = tf_instance.timezone_at(lng=lon, lat=lat)
            if tz_name:
                target_tz = ZoneInfo(tz_name)
        except Exception:
            target_tz = worker_tz

    dt_local = dt_utc.astimezone(target_tz)
    raw_offset = dt_local.strftime("%z")
    exif_offset = f"{raw_offset[:3]}:{raw_offset[3:]}" if len(raw_offset) == 5 else "+01:00"

    return {
        "dt_local": dt_local,
        "dt_utc": dt_utc,
        "exif_local_str": dt_local.strftime("%Y:%m:%d %H:%M:%S"),
        "exif_utc_str": dt_utc.strftime("%Y:%m:%d %H:%M:%S"),
        "iso_local_with_tz": dt_local.strftime("%Y:%m:%d %H:%M:%S") + exif_offset,
        "offset_str": exif_offset
    }


def detect_custom_album(media_path: Path) -> str | None:
    folder_name = media_path.parent.name.replace("\xa0", " ").strip()
    if folder_name in GENERIC_FOLDERS:
        return None
    if re.match(r'^Photos from \d{4}$', folder_name, re.IGNORECASE):
        return None
    if re.match(r'^Photos de \d{4}$', folder_name, re.IGNORECASE):
        return None
    if re.match(r'^\d{4}$', folder_name):
        return None
    clean_name = re.sub(r'[<>:"/\\|?*]', '_', folder_name).strip('. ')
    return clean_name or None


def atomic_transfer(src: Path, target_dir: Path, new_stem: str, ext: str) -> Path:
    target_dir.mkdir(parents=True, exist_ok=True)
    clean_stem = re.sub(r'[<>:"/\\|?*]', '_', new_stem).strip('. ')
    candidate = target_dir / f"{clean_stem}{ext}"
    counter = 1
    while candidate.exists() and candidate.resolve() != src.resolve():
        candidate = target_dir / f"{clean_stem}_{counter}{ext}"
        counter += 1
    if candidate.resolve() != src.resolve():
        shutil.copy2(src, candidate)
    return candidate


def extract_date_from_filename(filename: str) -> int | None:
    clean = re.sub(r'^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_', '', filename)
    m = re.search(r'(20\d{2}|19\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])[-_.\sT]+([01]\d|2[0-3])[-_.]?([0-5]\d)[-_.]?([0-5]\d)', clean)
    if m:
        try:
            y, mo, d, h, mi, s = map(int, m.groups())
            return int(datetime(y, mo, d, h, mi, s).timestamp())
        except Exception:
            pass

    m2 = re.search(r'(?:^|[^\d])(20\d{2}|19\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[^\d]|$)', clean)
    if m2:
        try:
            y, mo, d = map(int, m2.groups())
            return int(datetime(y, mo, d, 12, 0, 0).timestamp())
        except Exception:
            pass

    return None


def process_single_file(media_path: Path) -> tuple:
    global worker_et, worker_dest_dir, worker_is_takeout, worker_organize
    try:
        ext_lower = media_path.suffix.lower()
        if ext_lower not in ALL_MEDIA_EXTS:
            return (str(media_path), None, None, "unsupported", None, None, 0, 0, 0, None, None, None, 0, None, None)

        timestamp = None
        lat, lon, alt = None, None, None
        duration_sec = None
        description = None
        is_favorite = 0
        is_trashed = 0
        is_archived = 0
        status = "no_metadata"
        is_video = ext_lower in VIDEO_EXTS

        if worker_is_takeout:
            json_path = find_matching_json(media_path)
            if json_path:
                try:
                    with open(json_path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    ts_str = data.get("photoTakenTime", {}).get("timestamp") or data.get("creationTime", {}).get("timestamp")
                    if ts_str:
                        timestamp = int(ts_str)
                        status = "json_matched"
                    geo = data.get("geoData", {})
                    if geo.get("latitude", 0.0) != 0.0 or geo.get("longitude", 0.0) != 0.0:
                        lat = float(geo["latitude"])
                        lon = float(geo["longitude"])
                        alt = float(geo.get("altitude", 0.0))
                    description = data.get("description", "").strip() or None
                    is_favorite = 1 if data.get("favorited", False) else 0
                    is_trashed = 1 if data.get("trashed", False) else 0
                    is_archived = 1 if data.get("archived", False) else 0
                except Exception:
                    pass

        if not timestamp or lat is None or is_video:
            try:
                meta = worker_et.get_tags(
                    [str(media_path)],
                    tags=["DateTimeOriginal", "CreateDate", "MediaCreateDate", "TrackCreateDate", "GPSLatitude", "GPSLongitude", "Duration"]
                )[0]
                if not timestamp:
                    d_str = (
                        meta.get("EXIF:DateTimeOriginal")
                        or meta.get("EXIF:CreateDate")
                        or meta.get("QuickTime:CreateDate")
                        or meta.get("QuickTime:MediaCreateDate")
                    )
                    if d_str and not str(d_str).startswith("0000"):
                        dt = datetime.strptime(str(d_str)[:19], "%Y:%m:%d %H:%M:%S")
                        timestamp = int(dt.timestamp())
                        status = "exif_fallback"
                if lat is None and "EXIF:GPSLatitude" in meta and "EXIF:GPSLongitude" in meta:
                    lat = float(meta["EXIF:GPSLatitude"])
                    lon = float(meta["EXIF:GPSLongitude"])
                if is_video:
                    dur_val = meta.get("QuickTime:Duration") or meta.get("Composite:Duration")
                    if dur_val is not None:
                        duration_sec = float(dur_val)
            except Exception:
                pass

        if not timestamp:
            fn_ts = extract_date_from_filename(media_path.name)
            if fn_ts:
                timestamp = fn_ts
                status = "filename_date"

        if not timestamp:
            mtime = int(media_path.stat().st_mtime)
            is_today = (abs(time.time() - mtime) < 86400 * 2)
            if not worker_is_takeout and not is_today:
                timestamp = mtime
                status = "mtime_fallback"
            else:
                status = "no_metadata"
                timestamp = 0

        album_name = detect_custom_album(media_path)
        time_info = resolve_datetime_with_dst(timestamp, lat, lon) if (timestamp and timestamp > 0) else None
        trashed_at = int(time.time()) if is_trashed else None

        if is_trashed:
            target_folder = worker_dest_dir / "Corbeille"
            dest_path = atomic_transfer(media_path, target_folder, media_path.stem, media_path.suffix)
            status = "trashed"
        elif not worker_organize and not worker_is_takeout:
            dest_path = media_path
        elif time_info:
            dt_local = time_info["dt_local"]
            target_folder = worker_dest_dir / str(dt_local.year) / MOIS_FR[dt_local.month]
            file_prefix = dt_local.strftime("%Y-%m-%d_%H-%M-%S")
            dest_path = atomic_transfer(media_path, target_folder, f"{file_prefix}_{media_path.stem}", media_path.suffix)
        else:
            target_folder = worker_dest_dir / "A_Verifier_Sans_Metadata"
            dest_path = atomic_transfer(media_path, target_folder, media_path.stem, media_path.suffix)

        if worker_is_takeout and dest_path.exists() and time_info:
            tags = {}
            if not is_video:
                tags["DateTimeOriginal"] = time_info["exif_local_str"]
                tags["CreateDate"] = time_info["exif_local_str"]
                tags["ModifyDate"] = time_info["exif_local_str"]
                tags["OffsetTime"] = time_info["offset_str"]
                tags["OffsetTimeOriginal"] = time_info["offset_str"]
            else:
                tags["QuickTime:CreateDate"] = time_info["exif_utc_str"]
                tags["QuickTime:ModifyDate"] = time_info["exif_utc_str"]
                tags["QuickTime:TrackCreateDate"] = time_info["exif_utc_str"]
                tags["QuickTime:MediaCreateDate"] = time_info["exif_utc_str"]
                tags["Keys:CreationDate"] = time_info["iso_local_with_tz"]
                tags["XMP:CreateDate"] = time_info["iso_local_with_tz"]
                tags["DateTimeOriginal"] = time_info["iso_local_with_tz"]

            if lat is not None and lon is not None:
                tags["GPSLatitude"] = lat
                tags["GPSLatitudeRef"] = "N" if lat >= 0 else "S"
                tags["GPSLongitude"] = lon
                tags["GPSLongitudeRef"] = "E" if lon >= 0 else "W"

            if description:
                tags["ImageDescription"] = description
            if is_favorite:
                tags["Rating"] = 5
            if album_name:
                tags["Keywords"] = album_name

            if tags:
                try:
                    worker_et.set_tags(
                        [str(dest_path)],
                        tags=tags,
                        params=["-overwrite_original", "-P", "-q", "-api", "QuickTimeUTC=0"]
                    )
                except Exception:
                    pass

            if timestamp and timestamp > 0:
                try:
                    os.utime(dest_path, (timestamp, timestamp))
                except Exception:
                    pass

        if not is_trashed and dest_path.exists():
            if is_favorite:
                fav_dir = worker_dest_dir / "Favoris"
                fav_dir.mkdir(parents=True, exist_ok=True)
                fl = fav_dir / dest_path.name
                if not fl.exists():
                    try:
                        os.link(dest_path, fl)
                    except Exception:
                        pass
            if album_name:
                alb_dir = worker_dest_dir / "Albums" / album_name
                alb_dir.mkdir(parents=True, exist_ok=True)
                al = alb_dir / dest_path.name
                if not al.exists():
                    try:
                        os.link(dest_path, al)
                    except Exception:
                        pass

        f_size = dest_path.stat().st_size if dest_path.exists() else 0
        return (
            str(media_path), str(dest_path), str(dest_path), status, timestamp, trashed_at,
            is_favorite, is_trashed, is_archived, album_name, lat or 0.0, lon or 0.0,
            f_size, duration_sec, None
        )
    except Exception as e:
        return (str(media_path), None, None, "error", None, None, 0, 0, 0, None, 0.0, 0.0, 0, None, str(e))