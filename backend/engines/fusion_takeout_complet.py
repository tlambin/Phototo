import os
import re
import json
import time
import math
import hashlib
import shutil
import sqlite3
import atexit
import unicodedata
from pathlib import Path
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
import exiftool
from settings_manager import get_configured_timezone, load_settings
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
worker_tz: ZoneInfo | None = None
worker_dest_dir = DEST_DIR
worker_is_takeout = True
worker_organize = True
worker_keep_structure = True
worker_wrap_google_album = False
worker_fix_metadata = True
worker_tz_mode: str | None = None
worker_takeout_roots: list[Path] = []


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


EDITED_SUFFIX_RE = re.compile(
    r'-(modifi[ée]|edited|effects|smile|collage|animations?|cinematic|enhanced|hdr|portrait|'
    r'bearbeitet|modificato|editado|bewerkt|edytowane|redigerad|muokattu|d[üu]zenlendi|измененный)$',
    re.IGNORECASE,
)

QUICKTIME_VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".3gp"}


def _create_exiftool_helper() -> exiftool.ExifToolHelper:
    et = exiftool.ExifToolHelper(common_args=["-G", "-n", "-charset", "utf8", "-charset", "filename=utf8", "-charset", "iptc=utf8"])
    et.run()
    atexit.register(et.terminate)
    return et


def _ensure_worker_et() -> exiftool.ExifToolHelper:
    global worker_et
    if worker_et is None or not getattr(worker_et, "running", False):
        worker_et = _create_exiftool_helper()
    return worker_et


def _resolve_configured_tz_mode() -> str:
    if worker_tz_mode in ("GPS_OR_SETTINGS", "SETTINGS_ONLY", "UTC"):
        return worker_tz_mode
    cfg = load_settings()
    mode = str(cfg.get("takeout_timezone_mode") or "").strip().upper()
    if mode in ("GPS_OR_SETTINGS", "SETTINGS_ONLY", "UTC"):
        return mode
    return "GPS_OR_SETTINGS" if cfg.get("takeout_use_gps_timezone", True) else "SETTINGS_ONLY"


def init_worker(
    dest_dir_str: str = "",
    is_takeout: bool = True,
    organize: bool = True,
    keep_structure: bool = True,
    wrap_google_album: bool = False,
    fix_metadata: bool = True,
    takeout_roots: list[str] | None = None,
):
    global worker_et, worker_tz, worker_dest_dir, worker_is_takeout, worker_organize, worker_keep_structure, worker_wrap_google_album, worker_fix_metadata, worker_tz_mode, worker_takeout_roots
    worker_tz = get_configured_timezone()
    if dest_dir_str:
        worker_dest_dir = Path(dest_dir_str)
    worker_is_takeout = is_takeout
    worker_organize = organize
    worker_keep_structure = bool(keep_structure)
    worker_wrap_google_album = bool(wrap_google_album)
    worker_fix_metadata = bool(fix_metadata)
    worker_tz_mode = None
    worker_tz_mode = _resolve_configured_tz_mode()
    worker_takeout_roots = [Path(r) for r in (takeout_roots or []) if r and Path(r).exists()]
    _DIR_JSON_CACHE.clear()
    _MIRROR_DIRS_CACHE.clear()
    _GLOBAL_JSON_INDEX_CACHE.clear()
    worker_et = _create_exiftool_helper()


_DIR_JSON_CACHE: dict[str, tuple[int, list[Path]]] = {}
_DIR_JSON_CACHE_MAX = 64
_MIRROR_DIRS_CACHE: dict[tuple[str, ...], dict[str, list[Path]]] = {}
_GLOBAL_JSON_INDEX_CACHE: dict[tuple[str, ...], tuple[dict[str, list[Path]], list[Path]]] = {}


def _get_sibling_json_files(parent: Path) -> list[Path]:
    try:
        dir_mtime = parent.stat().st_mtime_ns
    except Exception:
        return []
    key = str(parent)
    cached = _DIR_JSON_CACHE.get(key)
    if cached is not None and cached[0] == dir_mtime:
        return cached[1]
    if not parent.is_dir():
        return []
    try:
        jsons = sorted(
            (Path(entry.path) for entry in os.scandir(parent) if entry.is_file() and entry.name.lower().endswith(".json")),
            key=lambda p: p.name,
        )
    except Exception:
        jsons = []
    if len(_DIR_JSON_CACHE) >= _DIR_JSON_CACHE_MAX:
        _DIR_JSON_CACHE.clear()
    _DIR_JSON_CACHE[key] = (dir_mtime, jsons)
    return jsons


def _get_mirror_dirs_map(roots: list[Path]) -> dict[str, list[Path]]:
    cache_key = tuple(str(r) for r in roots)
    cached = _MIRROR_DIRS_CACHE.get(cache_key)
    if cached is not None:
        return cached
    by_name: dict[str, list[Path]] = {}
    for root in roots:
        if not root.is_dir():
            continue
        for dirpath, _, _ in os.walk(root):
            dp = Path(dirpath)
            norm_name = dp.name.replace("\xa0", " ").strip().lower()
            if norm_name:
                by_name.setdefault(norm_name, []).append(dp)
    if len(_MIRROR_DIRS_CACHE) >= 8:
        _MIRROR_DIRS_CACHE.clear()
    _MIRROR_DIRS_CACHE[cache_key] = by_name
    return by_name


def _get_global_json_index(roots: list[Path]) -> tuple[dict[str, list[Path]], list[Path]]:
    cache_key = tuple(str(r) for r in roots)
    cached = _GLOBAL_JSON_INDEX_CACHE.get(cache_key)
    if cached is not None:
        return cached
    by_name: dict[str, list[Path]] = {}
    all_jsons: list[Path] = []
    seen: set[str] = set()
    for root in roots:
        if not root.is_dir():
            continue
        for dirpath, _, filenames in os.walk(root):
            for fn in filenames:
                if fn.lower().endswith(".json"):
                    jp = Path(dirpath) / fn
                    sjp = str(jp)
                    if sjp not in seen:
                        seen.add(sjp)
                        all_jsons.append(jp)
                        by_name.setdefault(fn.lower(), []).append(jp)
    if len(_GLOBAL_JSON_INDEX_CACHE) >= 8:
        _GLOBAL_JSON_INDEX_CACHE.clear()
    _GLOBAL_JSON_INDEX_CACHE[cache_key] = (by_name, all_jsons)
    return (by_name, all_jsons)


def _json_has_takeout_fields(json_path: Path) -> dict | None:
    try:
        data = json.loads(json_path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and ("photoTakenTime" in data or "creationTime" in data or "geoData" in data or "title" in data):
            return data
    except Exception:
        pass
    return None


def _build_json_candidate_filenames(media_path: Path) -> tuple[list[str], str, str, str, str, str]:
    name = media_path.name
    stem = media_path.stem
    ext = media_path.suffix

    dup_match = re.search(r'(\(\d+\))$', stem)
    num = dup_match.group(1) if dup_match else ""
    base_stem = stem[:dup_match.start()] if dup_match else stem
    clean_base = EDITED_SUFFIX_RE.sub('', base_stem)
    clean_stem = EDITED_SUFFIX_RE.sub('', stem)

    cand_filenames: list[str] = []
    for cand_name in dict.fromkeys([name, f"{clean_stem}{ext}"]):
        cand_filenames.append(f"{cand_name}.supplemental-metadata.json")
        cand_filenames.append(f"{cand_name}.json")
    cand_filenames.append(f"{stem}.supplemental-metadata.json")
    cand_filenames.append(f"{stem}.json")
    if clean_stem != stem:
        cand_filenames.append(f"{clean_stem}.supplemental-metadata.json")
        cand_filenames.append(f"{clean_stem}.json")

    if num:
        for b in dict.fromkeys([base_stem, clean_base]):
            for suffix in (".supplemental-metadata", ""):
                cand_filenames.append(f"{b}{ext}{suffix}{num}.json")
                cand_filenames.append(f"{b}{ext}{num}{suffix}.json")
                cand_filenames.append(f"{b}{num}{ext}{suffix}.json")
            cand_filenames.append(f"{b}{num}.json")

    return (list(dict.fromkeys(cand_filenames)), num, stem, clean_stem, base_stem, clean_base)


def _norm_nfc_lower(s: str) -> str:
    return unicodedata.normalize("NFC", s or "").lower()


def _norm_title_for_fs(s: str) -> str:
    clean = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', unicodedata.normalize("NFC", str(s or "").strip()))
    return clean.lower()


def _match_json_in_list(
    json_files: list[Path],
    ext: str,
    num: str,
    stem: str,
    clean_stem: str,
    base_stem: str,
    clean_base: str,
    check_title: bool = True,
) -> Path | None:
    if not json_files:
        return None

    cand_names = list(dict.fromkeys(
        f"{b}{ext}" for b in (stem, clean_stem, base_stem, clean_base) if b
    ))
    cand_names_lower = [_norm_nfc_lower(c) for c in cand_names]

    # 1. Troncature de ".supplemental-metadata" (fréquente dès ~25-46 caractères)
    for jf in json_files:
        jstem = jf.stem
        jstem_no_num = re.sub(r'\(\d+\)$', '', jstem)
        if num and not jstem.endswith(num):
            continue
        if not num and re.search(r'\(\d+\)$', jstem):
            continue
        jlower = _norm_nfc_lower(jstem_no_num)
        for cl in cand_names_lower:
            if jlower.startswith(cl + ".") and ".supplemental-metadata".startswith("." + jlower[len(cl) + 1:].split(".")[0]):
                return jf
            if jlower.startswith(cl + ".s"):
                return jf

    # 2. Troncature du nom de fichier long (>= 40 caractères)
    for jf in json_files:
        jstem = jf.stem
        jstem_no_num = re.sub(r'\(\d+\)$', '', jstem)
        if num and not jstem.endswith(num):
            continue
        jlower = _norm_nfc_lower(jstem_no_num)
        for cl in cand_names_lower:
            if len(cl) >= 40 and len(jlower) >= 38 and (cl.startswith(jlower) or jlower.startswith(cl[:40])):
                return jf

    # 3. Correspondance par champ "title" dans les JSON du dossier (avec normalisation NFC + caractères Windows)
    if check_title:
        cand_set_lower = {_norm_title_for_fs(c) for c in cand_names} | set(cand_names_lower)
        for jf in json_files:
            data = _json_has_takeout_fields(jf)
            if not data:
                continue
            raw_title = str(data.get("title") or "").strip()
            if not raw_title:
                continue
            if _norm_nfc_lower(raw_title) in cand_set_lower or _norm_title_for_fs(raw_title) in cand_set_lower:
                return jf

    # 4. Paire Live Photo / changement d'extension (ex: IMG_001.MP4 -> IMG_001.HEIC.json)
    stem_prefixes = [f"{_norm_nfc_lower(b)}." for b in dict.fromkeys([clean_base, clean_stem, base_stem, stem]) if b]
    for jf in json_files:
        jstem = jf.stem
        if num and not jstem.endswith(num):
            continue
        if not num and re.search(r'\(\d+\)$', jstem):
            continue
        jlower = _norm_nfc_lower(jstem)
        if any(jlower.startswith(pref) for pref in stem_prefixes):
            if _json_has_takeout_fields(jf):
                return jf

    return None


def _find_matching_json_in_dir(media_path: Path, search_dir: Path) -> Path | None:
    cand_filenames, num, stem, clean_stem, base_stem, clean_base = _build_json_candidate_filenames(media_path)
    for fn in cand_filenames:
        cand = search_dir / fn
        if cand.exists() and cand.is_file():
            return cand

    json_files = _get_sibling_json_files(search_dir)
    return _match_json_in_list(
        json_files, media_path.suffix, num, stem, clean_stem, base_stem, clean_base, check_title=True
    )


def find_matching_json(
    media_path: Path,
    extra_roots: list[Path | str] | None = None,
) -> Path | None:
    # 1. Dossier immédiat du média
    direct = _find_matching_json_in_dir(media_path, media_path.parent)
    if direct:
        return direct

    roots = [Path(r) for r in extra_roots if r] if extra_roots is not None else list(worker_takeout_roots)
    roots = [r for r in roots if r.is_dir()]
    if not roots:
        return None

    # 2. Dossiers miroirs dans les autres archives Takeout décompressées (ex: autre "Photos from 2022" ou même album)
    folder_norm = media_path.parent.name.replace("\xa0", " ").strip().lower()
    if folder_norm:
        mirror_map = _get_mirror_dirs_map(roots)
        parent_str = os.path.normcase(str(media_path.parent))
        for mirror_dir in mirror_map.get(folder_norm, []):
            if os.path.normcase(str(mirror_dir)) == parent_str:
                continue
            hit = _find_matching_json_in_dir(media_path, mirror_dir)
            if hit:
                return hit

    # 3. Repli global sur l'ensemble des racines Takeout sélectionnées (sans relire tous les JSON par "title")
    cand_filenames, num, stem, clean_stem, base_stem, clean_base = _build_json_candidate_filenames(media_path)
    by_name, all_jsons = _get_global_json_index(roots)
    for fn in cand_filenames:
        hits = by_name.get(fn.lower())
        if hits:
            return hits[0]

    return _match_json_in_list(
        all_jsons, media_path.suffix, num, stem, clean_stem, base_stem, clean_base, check_title=False
    )


def extract_takeout_json_metadata(json_path: Path) -> dict:
    out = {
        "timestamp": None,
        "lat": None,
        "lon": None,
        "alt": None,
        "description": None,
        "is_favorite": False,
        "is_trashed": False,
        "is_archived": False,
    }
    try:
        data = json.loads(json_path.read_text(encoding="utf-8"))
    except Exception:
        return out
    if not isinstance(data, dict):
        return out

    for key in ("photoTakenTime", "creationTime"):
        block = data.get(key)
        if isinstance(block, dict) and block.get("timestamp") not in (None, ""):
            try:
                ts_val = int(float(str(block["timestamp"]).strip()))
                if ts_val > 0:
                    out["timestamp"] = ts_val
                    break
            except (ValueError, TypeError):
                pass

    for geo_key in ("geoData", "geoDataExif"):
        geo = data.get(geo_key)
        if not isinstance(geo, dict):
            continue
        try:
            lat = float(geo.get("latitude", 0.0) or 0.0)
            lon = float(geo.get("longitude", 0.0) or 0.0)
            alt_raw = geo.get("altitude", None)
            alt = float(alt_raw) if alt_raw is not None else None
        except (ValueError, TypeError):
            continue
        if (
            math.isfinite(lat) and math.isfinite(lon)
            and -90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0
            and (abs(lat) > 1e-7 or abs(lon) > 1e-7)
        ):
            out["lat"] = lat
            out["lon"] = lon
            if alt is not None and math.isfinite(alt) and abs(alt) > 1e-4:
                out["alt"] = alt
            break

    desc = str(data.get("description") or "").strip()
    out["description"] = desc or None
    out["is_favorite"] = bool(data.get("favorited", False))
    out["is_trashed"] = bool(data.get("trashed", False))
    out["is_archived"] = bool(data.get("archived", False))
    return out


def resolve_datetime_with_dst(utc_timestamp: int, lat: float | None = None, lon: float | None = None) -> dict:
    global worker_tz
    dt_utc = datetime.fromtimestamp(utc_timestamp, tz=timezone.utc)
    tz_mode = _resolve_configured_tz_mode()

    if tz_mode == "UTC":
        target_tz = timezone.utc
    else:
        target_tz = worker_tz or get_configured_timezone()
        if tz_mode == "GPS_OR_SETTINGS" and tf_instance and lat and lon and (lat != 0.0 or lon != 0.0):
            try:
                tz_name = tf_instance.timezone_at(lng=lon, lat=lat)
                if tz_name:
                    target_tz = ZoneInfo(tz_name)
            except Exception:
                target_tz = worker_tz or get_configured_timezone()

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


_WIN_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def sanitize_fs_component(raw_name: str, allow_comma: bool = True, max_chars: int = 120, fallback: str = "media") -> str:
    pattern = r'[<>:"/\\|?*\x00-\x1f]' if allow_comma else r'[<>:"/\\|?*,\x00-\x1f]'
    clean = re.sub(pattern, '_', unicodedata.normalize("NFC", str(raw_name or ""))).strip('. ')
    if not clean:
        clean = fallback
    if clean.upper() in _WIN_RESERVED_NAMES:
        clean = f"_{clean}"
    if max_chars > 12 and len(clean) > max_chars:
        h = hashlib.blake2b(clean.encode("utf-8"), digest_size=4).hexdigest()
        clean = f"{clean[:max_chars - 9].rstrip('. ')}_{h}"
    return clean


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
    clean_name = re.sub(r'[<>:"/\\|?*,\x00-\x1f]', '_', unicodedata.normalize("NFC", folder_name)).strip('. ')
    return clean_name or None


def detect_takeout_year_label(media_path: Path, time_info: dict | None = None) -> str | None:
    folder_name = media_path.parent.name.replace("\xa0", " ").strip()
    for pat in (
        r'^Photos from (\d{4})$',
        r'^Photos de (\d{4})$',
        r'^(\d{4})$',
    ):
        m = re.match(pat, folder_name, re.IGNORECASE)
        if m:
            return m.group(1)
    if time_info and time_info.get("dt_local"):
        return str(time_info["dt_local"].year)
    return None


def resolve_takeout_album_name(
    media_path: Path,
    time_info: dict | None = None,
    keep_structure: bool = True,
    wrap_google_album: bool = False,
    is_favorite: bool = False,
    is_trashed: bool = False,
) -> str | None:
    if not wrap_google_album:
        return detect_custom_album(media_path) if keep_structure else None

    if is_trashed:
        return "Google Photos/Corbeille"

    tokens: list[str] = []
    year_lbl = detect_takeout_year_label(media_path, time_info)
    if year_lbl:
        tokens.append(f"Google Photos/{year_lbl}")
    custom = detect_custom_album(media_path)
    if custom:
        tokens.append(f"Google Photos/Albums/{custom}")
    if is_favorite:
        tokens.append("Google Photos/Favoris")
    if not tokens:
        tokens.append("Google Photos")
    return ", ".join(dict.fromkeys(tokens))


def atomic_transfer(src: Path, target_dir: Path, new_stem: str, ext: str) -> Path:
    target_dir.mkdir(parents=True, exist_ok=True)
    # Garde une marge sûre sous la limite Windows MAX_PATH (260) y compris avec suffixe _123 et liens Albums/Favoris
    avail_for_stem = max(24, min(140, 232 - len(str(target_dir)) - len(ext) - 8))
    clean_stem = sanitize_fs_component(new_stem, allow_comma=True, max_chars=avail_for_stem, fallback="media")
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
    tz = timezone.utc if _resolve_configured_tz_mode() == "UTC" else (worker_tz or get_configured_timezone())

    m = re.search(r'(20\d{2}|19\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])[-_.\sT]+([01]\d|2[0-3])[-_.]?([0-5]\d)[-_.]?([0-5]\d)', clean)
    if m:
        try:
            y, mo, d, h, mi, s = map(int, m.groups())
            return int(datetime(y, mo, d, h, mi, s, tzinfo=tz).timestamp())
        except Exception:
            pass

    m_hm = re.search(r'(20\d{2}|19\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])[-_.\sT]+([01]\d|2[0-3])[-_.]?([0-5]\d)(?:[^\d]|$)', clean)
    if m_hm:
        try:
            y, mo, d, h, mi = map(int, m_hm.groups())
            return int(datetime(y, mo, d, h, mi, 0, tzinfo=tz).timestamp())
        except Exception:
            pass

    m2 = re.search(r'(?:^|[^\d])(20\d{2}|19\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[^\d]|$)', clean)
    if m2:
        try:
            y, mo, d = map(int, m2.groups())
            return int(datetime(y, mo, d, 12, 0, 0, tzinfo=tz).timestamp())
        except Exception:
            pass

    m_ms = re.search(r'(?:^|[^\d])(1[0-9]{12})(?:[^\d]|$)', clean)
    if m_ms:
        try:
            ts_sec = int(m_ms.group(1)) // 1000
            if 946684800 <= ts_sec <= 2082758400:
                return ts_sec
        except Exception:
            pass

    return None


def _parse_exif_datetime_str(raw_val: str, is_utc_tag: bool = False, offset_str: str | None = None) -> int | None:
    s = str(raw_val or "").strip()
    if not s or s.startswith("0000"):
        return None
    m_tz = re.match(r'^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})([+-]\d{2}:?\d{2}|Z)?', s)
    if not m_tz:
        return None
    try:
        y, mo, d, h, mi, sec = map(int, m_tz.groups()[:6])
        tz_tok = m_tz.group(7) or offset_str
        tz_obj = None
        if tz_tok:
            if tz_tok == "Z":
                tz_obj = timezone.utc
            else:
                off = tz_tok.replace(":", "")
                if len(off) == 5 and off[0] in ("+", "-"):
                    sign = 1 if off[0] == "+" else -1
                    oh, om = int(off[1:3]), int(off[3:5])
                    tz_obj = timezone(sign * timedelta(hours=oh, minutes=om))
        if tz_obj is None:
            if is_utc_tag or _resolve_configured_tz_mode() == "UTC":
                tz_obj = timezone.utc
            else:
                tz_obj = worker_tz or get_configured_timezone()
        ts = int(datetime(y, mo, d, h, mi, sec, tzinfo=tz_obj).timestamp())
        return ts if ts > 0 else None
    except Exception:
        return None


def detect_real_media_extension(file_path: Path) -> str | None:
    try:
        with open(file_path, "rb") as f:
            hdr = f.read(16)
    except Exception:
        return None
    if len(hdr) < 4:
        return None
    if hdr.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if hdr.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if hdr.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    if hdr[:4] == b"RIFF" and hdr[8:12] == b"WEBP":
        return ".webp"
    if hdr[4:8] == b"ftyp":
        brand = hdr[8:12]
        if brand in (b"heic", b"heix", b"mif1", b"msf1"):
            return ".heic"
        if brand in (b"qt  ",):
            return ".mov"
        return ".mp4"
    return None


def _sanitize_exiftool_tag_value(val: str) -> str:
    # Les retours à la ligne cassent le format stdin -@ argfile d'ExifTool ; on les normalise en espace.
    return re.sub(r'[\r\n\x00-\x1f]+', ' ', unicodedata.normalize("NFC", str(val))).strip()


def build_exiftool_tags(
    time_info: dict | None,
    is_video: bool,
    ext_lower: str = "",
    lat: float | None = None,
    lon: float | None = None,
    alt: float | None = None,
    description: str | None = None,
    is_favorite: bool = False,
    album_name: str | None = None,
) -> dict:
    tags: dict = {}
    if time_info:
        if not is_video:
            tags["DateTimeOriginal"] = time_info["exif_local_str"]
            tags["CreateDate"] = time_info["exif_local_str"]
            tags["ModifyDate"] = time_info["exif_local_str"]
            tags["OffsetTime"] = time_info["offset_str"]
            tags["OffsetTimeOriginal"] = time_info["offset_str"]
            tags["OffsetTimeDigitized"] = time_info["offset_str"]
            tags["XMP:DateTimeOriginal"] = time_info["iso_local_with_tz"]
            tags["XMP:CreateDate"] = time_info["iso_local_with_tz"]
        else:
            if not ext_lower or ext_lower in QUICKTIME_VIDEO_EXTS:
                tags["QuickTime:CreateDate"] = time_info["exif_utc_str"]
                tags["QuickTime:ModifyDate"] = time_info["exif_utc_str"]
                tags["QuickTime:TrackCreateDate"] = time_info["exif_utc_str"]
                tags["QuickTime:MediaCreateDate"] = time_info["exif_utc_str"]
                tags["Keys:CreationDate"] = time_info["iso_local_with_tz"]
            tags["XMP:CreateDate"] = time_info["iso_local_with_tz"]
            tags["XMP:DateTimeOriginal"] = time_info["iso_local_with_tz"]
            tags["DateTimeOriginal"] = time_info["iso_local_with_tz"]

    if lat is not None and lon is not None and (abs(lat) > 1e-7 or abs(lon) > 1e-7):
        tags["GPSLatitude"] = abs(lat)
        tags["GPSLatitudeRef"] = "N" if lat >= 0 else "S"
        tags["GPSLongitude"] = abs(lon)
        tags["GPSLongitudeRef"] = "E" if lon >= 0 else "W"
        if alt is not None and math.isfinite(alt):
            tags["GPSAltitude"] = abs(alt)
            tags["GPSAltitudeRef"] = 0 if alt >= 0 else 1

    if description:
        safe_desc = _sanitize_exiftool_tag_value(description)
        if safe_desc:
            tags["ImageDescription"] = safe_desc
            tags["XMP:Description"] = safe_desc
    if is_favorite:
        tags["Rating"] = 5
        tags["XMP:Rating"] = 5
    if album_name:
        safe_alb = _sanitize_exiftool_tag_value(album_name)
        if safe_alb:
            tags["Keywords"] = safe_alb
            tags["XMP:Subject"] = safe_alb
    return tags


def write_tags_resilient(
    et: exiftool.ExifToolHelper,
    file_path: Path,
    tags: dict,
    is_video: bool = False,
) -> tuple[bool, str | None]:
    if not tags or not file_path.exists():
        return (True, None)

    base_params = ["-overwrite_original", "-P", "-m", "-q", "-api", "QuickTimeUTC=0"]
    try:
        et.set_tags([str(file_path)], tags=tags, params=base_params)
        return (True, None)
    except Exception as first_err:
        err_msg = str(first_err)

    # Tentative 2 : extension trompeuse fréquente sur Google Takeout (ex: PNG ou WebP nommé .jpg)
    real_ext = detect_real_media_extension(file_path)
    if real_ext and real_ext != file_path.suffix.lower():
        alias_path = file_path.with_name(f"{file_path.stem}_exifalias_{int(time.time() * 1000)}{real_ext}")
        try:
            shutil.copy2(file_path, alias_path)
            alias_tags = build_exiftool_tags_for_xmp_or_ext(tags, real_ext)
            et.set_tags([str(alias_path)], tags=alias_tags, params=base_params)
            os.replace(alias_path, file_path)
            return (True, None)
        except Exception as alias_err:
            err_msg = str(alias_err)
            if alias_path.exists():
                try:
                    alias_path.unlink()
                except Exception:
                    pass

    # Tentative 3 : repli tags XMP + GPS essentiels avec -F (ignore IFD corrompus)
    xmp_tags = {
        k: v for k, v in tags.items()
        if k.startswith(("XMP:", "GPS"))
    }
    if not xmp_tags and is_video and "DateTimeOriginal" in tags:
        xmp_tags["XMP:DateTimeOriginal"] = tags["DateTimeOriginal"]
    if xmp_tags:
        try:
            et.set_tags([str(file_path)], tags=xmp_tags, params=["-overwrite_original", "-P", "-m", "-F", "-q"])
            return (True, None)
        except Exception as xmp_err:
            err_msg = str(xmp_err)

    return (False, err_msg)


def build_exiftool_tags_for_xmp_or_ext(tags: dict, real_ext: str) -> dict:
    if real_ext in QUICKTIME_VIDEO_EXTS or real_ext not in VIDEO_EXTS:
        return dict(tags)
    return {k: v for k, v in tags.items() if not k.startswith(("QuickTime:", "Keys:"))}


def process_single_file(media_path: Path) -> tuple:
    global worker_et, worker_dest_dir, worker_is_takeout, worker_organize, worker_keep_structure, worker_wrap_google_album, worker_fix_metadata
    try:
        ext_lower = media_path.suffix.lower()
        if ext_lower not in ALL_MEDIA_EXTS:
            return (str(media_path), None, None, "unsupported", None, None, 0, 0, 0, None, None, None, 0, None, None)

        et = _ensure_worker_et()
        timestamp = None
        lat, lon, alt = None, None, None
        duration_sec = None
        description = None
        is_favorite = 0
        is_trashed = 0
        is_archived = 0
        status = "no_metadata"
        is_video = ext_lower in VIDEO_EXTS
        meta_warn: str | None = None

        if worker_is_takeout:
            json_path = find_matching_json(media_path)
            if json_path:
                jmeta = extract_takeout_json_metadata(json_path)
                if worker_fix_metadata:
                    if jmeta["timestamp"]:
                        timestamp = jmeta["timestamp"]
                        status = "json_matched"
                    if jmeta["lat"] is not None and jmeta["lon"] is not None:
                        lat, lon, alt = jmeta["lat"], jmeta["lon"], jmeta["alt"]
                    description = jmeta["description"]
                is_favorite = 1 if jmeta["is_favorite"] else 0
                is_trashed = 1 if jmeta["is_trashed"] else 0
                is_archived = 1 if jmeta["is_archived"] else 0

        if not timestamp or lat is None or is_video:
            try:
                meta = et.get_tags(
                    [str(media_path)],
                    tags=[
                        "DateTimeOriginal", "CreateDate", "MediaCreateDate", "TrackCreateDate",
                        "Keys:CreationDate", "OffsetTimeOriginal", "OffsetTime",
                        "XMP:DateTimeOriginal", "XMP:CreateDate",
                        "GPSLatitude", "GPSLongitude", "GPSAltitude", "Duration"
                    ]
                )[0]
                if not timestamp:
                    off_str = meta.get("EXIF:OffsetTimeOriginal") or meta.get("EXIF:OffsetTime")
                    for tag_name, is_utc in (
                        ("EXIF:DateTimeOriginal", False),
                        ("EXIF:CreateDate", False),
                        ("Keys:CreationDate", False),
                        ("XMP:DateTimeOriginal", False),
                        ("XMP:CreateDate", False),
                        ("QuickTime:CreateDate", True),
                        ("QuickTime:MediaCreateDate", True),
                        ("QuickTime:TrackCreateDate", True),
                    ):
                        if meta.get(tag_name):
                            parsed_ts = _parse_exif_datetime_str(meta[tag_name], is_utc_tag=is_utc, offset_str=off_str)
                            if parsed_ts:
                                timestamp = parsed_ts
                                status = "exif_fallback"
                                break
                if lat is None and "EXIF:GPSLatitude" in meta and "EXIF:GPSLongitude" in meta:
                    try:
                        elat = float(meta["EXIF:GPSLatitude"])
                        elon = float(meta["EXIF:GPSLongitude"])
                        if math.isfinite(elat) and math.isfinite(elon) and (abs(elat) > 1e-7 or abs(elon) > 1e-7):
                            lat, lon = elat, elon
                            if alt is None and meta.get("EXIF:GPSAltitude") is not None:
                                ealt = float(meta["EXIF:GPSAltitude"])
                                if math.isfinite(ealt):
                                    alt = ealt
                    except (ValueError, TypeError):
                        pass
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
            if not (worker_is_takeout and worker_fix_metadata) and not is_today:
                timestamp = mtime
                status = "mtime_fallback"
            else:
                status = "no_metadata"
                timestamp = 0

        if worker_is_takeout and not worker_keep_structure and not worker_wrap_google_album:
            is_favorite = 0
            is_trashed = 0
        time_info = resolve_datetime_with_dst(timestamp, lat, lon) if (timestamp and timestamp > 0) else None
        album_name = (
            resolve_takeout_album_name(
                media_path,
                time_info,
                worker_keep_structure,
                worker_wrap_google_album,
                is_favorite=bool(is_favorite),
                is_trashed=bool(is_trashed),
            )
            if worker_is_takeout
            else detect_custom_album(media_path)
        )
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

        if worker_is_takeout and worker_fix_metadata and dest_path.exists():
            tags = build_exiftool_tags(
                time_info=time_info,
                is_video=is_video,
                ext_lower=ext_lower,
                lat=lat,
                lon=lon,
                alt=alt,
                description=description,
                is_favorite=bool(is_favorite),
                album_name=album_name,
            )
            if tags:
                ok_write, write_err = write_tags_resilient(et, dest_path, tags, is_video=is_video)
                if not ok_write and write_err:
                    meta_warn = write_err[:240]

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
                for alb_tok in [t.strip() for t in album_name.split(",") if t.strip()]:
                    alb_dir = worker_dest_dir / "Albums" / alb_tok
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
            f_size, duration_sec, meta_warn
        )
    except Exception as e:
        return (str(media_path), None, None, "error", None, None, 0, 0, 0, None, 0.0, 0.0, 0, None, str(e))