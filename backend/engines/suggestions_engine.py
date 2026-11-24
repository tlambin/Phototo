import math
import sqlite3
import time
from bisect import bisect_left
from collections import Counter
from datetime import datetime
from pathlib import Path

import cv2
import imagehash
import numpy as np
from PIL import Image

from media_frames import IMAGE_EXTS, VIDEO_EXTS

RAW_SUGGESTION_EXTS = {".dng", ".cr2", ".cr3", ".nef", ".arw", ".orf", ".rw2"}
SUGGESTION_PHOTO_EXTS = IMAGE_EXTS - RAW_SUGGESTION_EXTS - {".gif", ".apng"}
IGNORED_ALBUM_SUGGESTIONS = {"", "Google Photos", "Google Photos/Corbeille", "Corbeille"}

DEFAULT_BLUR_THRESHOLD = 45.0
DEFAULT_DARK_EXPOSURE = 20.0
DEFAULT_OVEREXPOSED = 242.0

SCREENSHOT_NAME_TOKENS = ("screenshot", "capture", "ecran", "bildschirm", "screen_", "screen-")

_MOIS_FR = [
    "", "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
    "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
]

_FACE_CASCADE = None


def _get_face_cascade():
    global _FACE_CASCADE
    if _FACE_CASCADE is not None:
        return _FACE_CASCADE if _FACE_CASCADE is not False else None
    try:
        xml_path = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
        if xml_path.exists():
            clf = cv2.CascadeClassifier(str(xml_path))
            if not clf.empty():
                _FACE_CASCADE = clf
                return _FACE_CASCADE
    except Exception:
        pass
    _FACE_CASCADE = False
    return None


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def compute_blur_and_exposure(img_path: Path) -> tuple[float | None, float | None]:
    """Calcule la netteté (variance du Laplacien) et l'exposition moyenne (luminance 0..255) en une passe."""
    try:
        buf = np.fromfile(str(img_path), dtype=np.uint8)
        if buf.size == 0:
            return None, None
        gray = cv2.imdecode(buf, cv2.IMREAD_GRAYSCALE)
        if gray is None or gray.size == 0:
            return None, None
        h, w = gray.shape[:2]
        max_dim = max(h, w)
        if max_dim > 480:
            scale = 480.0 / float(max_dim)
            gray = cv2.resize(gray, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)
        blur = round(float(cv2.Laplacian(gray, cv2.CV_64F).var()), 2)
        exposure = round(float(np.mean(gray)), 2)
        return blur, exposure
    except Exception:
        return None, None


def compute_blur_variance(img_path: Path) -> float | None:
    blur, _ = compute_blur_and_exposure(img_path)
    return blur


def detect_rotation_suggestion(img_path: Path) -> tuple[int, str]:
    """Détecte si une photo nécessite une rotation (90, 180 ou 270° horaire) via EXIF et détection faciale."""
    try:
        with Image.open(img_path) as im:
            exif = im.getexif()
            orient = int(exif.get(274, 1) or 1) if exif else 1
            if orient == 6:
                return 90, "Orientation EXIF (90° horaire non appliquée aux pixels)"
            if orient == 3:
                return 180, "Orientation EXIF (180° non appliquée aux pixels)"
            if orient == 8:
                return 270, "Orientation EXIF (90° antihoraire non appliquée aux pixels)"
    except Exception:
        pass

    clf = _get_face_cascade()
    if clf is None:
        return 0, ""

    try:
        buf = np.fromfile(str(img_path), dtype=np.uint8)
        if buf.size == 0:
            return 0, ""
        gray = cv2.imdecode(buf, cv2.IMREAD_GRAYSCALE)
        if gray is None or gray.size == 0:
            return 0, ""
        h, w = gray.shape[:2]
        if min(h, w) < 60:
            return 0, ""
        max_dim = max(h, w)
        if max_dim > 420:
            scale = 420.0 / float(max_dim)
            gray = cv2.resize(gray, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA)
        gray = cv2.equalizeHist(gray)

        upright = clf.detectMultiScale(gray, scaleFactor=1.12, minNeighbors=7, minSize=(32, 32))
        if len(upright) > 0:
            return 0, ""

        rot_ops = [
            (90, cv2.ROTATE_90_CLOCKWISE),
            (270, cv2.ROTATE_90_COUNTERCLOCKWISE),
            (180, cv2.ROTATE_180),
        ]
        best_rot = 0
        best_score = 0.0
        for deg, flag in rot_ops:
            rotated = cv2.rotate(gray, flag)
            faces = clf.detectMultiScale(rotated, scaleFactor=1.12, minNeighbors=8, minSize=(36, 36))
            if len(faces) > 0:
                area_score = sum(float(fw * fh) for (_, _, fw, fh) in faces) + (1000.0 if deg in (90, 270) else 0.0)
                if area_score > best_score:
                    best_score = area_score
                    best_rot = deg
        if best_rot in (90, 180, 270):
            return best_rot, f"Visage détecté incliné (+{best_rot}° conseillé)"
    except Exception:
        pass
    return 0, ""


def _decode_clip_vec(blob: bytes | None) -> np.ndarray | None:
    if not blob:
        return None
    try:
        v = np.frombuffer(blob, dtype=np.float16).astype(np.float32)
        if v.size == 0:
            return None
        n = float(np.linalg.norm(v))
        if n <= 1e-8 or not math.isfinite(n):
            return None
        return v / n
    except Exception:
        return None


def _load_geo_cache(conn: sqlite3.Connection) -> dict[tuple[float, float], tuple[str, str]]:
    geo_map: dict[tuple[float, float], tuple[str, str]] = {}
    try:
        rows = conn.execute("""
            SELECT lat_key, lon_key,
                   COALESCE(NULLIF(TRIM(city), ''), NULLIF(TRIM(display_label), ''), '') AS lbl,
                   COALESCE(TRIM(country), '') AS country
            FROM geocode_cache
        """).fetchall()
        for gr in rows:
            if gr["lbl"] or gr["country"]:
                geo_map[(round(float(gr["lat_key"]), 2), round(float(gr["lon_key"]), 2))] = (gr["lbl"], gr["country"])
    except Exception:
        pass
    return geo_map


def compute_album_suggestions(conn: sqlite3.Connection, limit: int = 120) -> list[dict]:
    """Suggère des albums existants pour les médias non classés en croisant décor (CLIP), personnes, lieu et période."""
    cur = conn.cursor()
    cols = {r[1] for r in cur.execute("PRAGMA table_info(processed_files)").fetchall()}
    clip_sel = ", clip_embedding" if "clip_embedding" in cols else ", NULL AS clip_embedding"
    dur_sel = ", duration_sec" if "duration_sec" in cols else ", NULL AS duration_sec"

    cur.execute(f"""
        SELECT source_path, dest_path, timestamp, file_size, width, height{dur_sel},
               latitude, longitude, album_name{clip_sel}
        FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
    """)
    all_rows = [dict(r) for r in cur.fetchall()]
    if not all_rows:
        return []

    file_people: dict[str, set[int]] = {}
    person_names: dict[int, str] = {}
    global_person_counts: Counter[int] = Counter()
    try:
        cur.execute("""
            SELECT f.source_path, f.person_id, COALESCE(NULLIF(TRIM(p.name), ''), '') AS person_name
            FROM faces f
            LEFT JOIN persons p ON f.person_id = p.person_id
            WHERE f.person_id IS NOT NULL
        """)
        for fr in cur.fetchall():
            src_p = fr["source_path"]
            pid = int(fr["person_id"])
            file_people.setdefault(src_p, set()).add(pid)
            global_person_counts[pid] += 1
            if fr["person_name"]:
                person_names[pid] = fr["person_name"]
    except Exception:
        pass

    geo_cache = _load_geo_cache(conn)
    album_profiles: dict[str, dict] = {}
    candidates: list[dict] = []

    for d in all_rows:
        raw_alb = (d.get("album_name") or "").strip()
        src_p = d["source_path"]
        ts = int(d.get("timestamp") or 0)
        lat = d.get("latitude")
        lon = d.get("longitude")
        has_geo = lat is not None and lon is not None and (abs(float(lat)) > 0.001 or abs(float(lon)) > 0.001)
        vec = _decode_clip_vec(d.pop("clip_embedding", None))
        pids = file_people.get(src_p, set())
        city = geo_cache.get((round(float(lat), 2), round(float(lon), 2)), ("", ""))[0] if has_geo else ""

        d["_vec"] = vec
        d["_pids"] = pids
        d["_has_geo"] = has_geo
        d["_city"] = city

        if not raw_alb:
            if ts > 0 or has_geo or vec is not None or pids:
                candidates.append(d)
            continue

        for tok in raw_alb.split(","):
            alb = tok.strip()
            if alb in IGNORED_ALBUM_SUGGESTIONS or alb.startswith("Google Photos/"):
                continue
            prof = album_profiles.setdefault(alb, {
                "name": alb, "count": 0, "timestamps": [], "geo_points": [],
                "cities": set(), "person_counts": Counter(), "vecs": [],
            })
            prof["count"] += 1
            if ts > 0:
                prof["timestamps"].append(ts)
            if has_geo:
                prof["geo_points"].append((float(lat), float(lon)))
                if city:
                    prof["cities"].add(city)
            for pid in pids:
                prof["person_counts"][pid] += 1
            if vec is not None:
                prof["vecs"].append(vec)

    if not album_profiles or not candidates:
        return []

    prepared_albums: list[dict] = []
    for alb, prof in album_profiles.items():
        if prof["count"] < 1:
            continue
        ts_list = sorted(prof["timestamps"])
        min_ts = ts_list[0] if ts_list else None
        max_ts = ts_list[-1] if ts_list else None
        span = (max_ts - min_ts) if (min_ts is not None and max_ts is not None) else None
        is_focused_time = span is not None and span <= 14 * 86400

        vecs = prof["vecs"]
        centroid = None
        sample_mat = None
        if vecs:
            main_dim = Counter(v.size for v in vecs).most_common(1)[0][0]
            same_dim = [v for v in vecs if v.size == main_dim]
            if same_dim:
                mat = np.vstack(same_dim)
                mean_v = np.mean(mat, axis=0)
                norm = float(np.linalg.norm(mean_v))
                if norm > 1e-8:
                    centroid = mean_v / norm
                sample_mat = np.vstack(same_dim[::max(1, len(same_dim) // 24)][:24]) if len(same_dim) > 24 else mat

        geo_pts = prof["geo_points"]
        if len(geo_pts) > 20:
            geo_pts = geo_pts[::max(1, len(geo_pts) // 20)][:20]

        char_pids = {
            pid for pid, cnt in prof["person_counts"].items()
            if cnt >= 2 or (global_person_counts[pid] > 0 and (cnt / float(global_person_counts[pid])) >= 0.30)
        }
        if not (is_focused_time or geo_pts or centroid is not None or prof["person_counts"]):
            continue

        prepared_albums.append({
            "name": alb,
            "min_ts": min_ts, "max_ts": max_ts,
            "mid_ts": ((min_ts + max_ts) // 2) if (min_ts and max_ts) else None,
            "span": span if span is not None else 0,
            "is_focused_time": is_focused_time,
            "geo_pts": geo_pts,
            "cities": prof["cities"],
            "person_counts": prof["person_counts"],
            "characteristic_pids": char_pids,
            "centroid": centroid,
            "sample_mat": sample_mat,
        })

    if not prepared_albums:
        return []

    matches: list[dict] = []
    for c in candidates:
        ts = int(c.get("timestamp") or 0)
        c_vec = c["_vec"]
        c_pids = c["_pids"]
        c_geo = c["_has_geo"]
        c_lat = float(c["latitude"]) if c_geo else 0.0
        c_lon = float(c["longitude"]) if c_geo else 0.0
        c_city = c["_city"]

        best_alb = None
        best_score = 0.0
        best_reasons: list[str] = []
        best_tags: list[str] = []

        for alb in prepared_albums:
            tags: list[str] = []
            reasons: list[str] = []
            score = 0.0

            scene_sim = 0.0
            if c_vec is not None and alb["centroid"] is not None and c_vec.size == alb["centroid"].size:
                cent_sim = float(np.dot(c_vec, alb["centroid"]))
                max_mem_sim = float(np.max(alb["sample_mat"] @ c_vec)) if alb["sample_mat"] is not None else cent_sim
                scene_sim = 0.45 * cent_sim + 0.55 * max_mem_sim
                if scene_sim >= 0.72:
                    pct = max(0, min(99, int(round(scene_sim * 100))))
                    tags.append("Décor")
                    reasons.append(f"Même décor ({pct} %)")
                    score += 2.6 + max(0.0, (scene_sim - 0.72) * 6.0)

            shared_all = c_pids & set(alb["person_counts"].keys())
            shared_char = c_pids & alb["characteristic_pids"]
            named_shared = [person_names[pid] for pid in sorted(shared_all) if pid in person_names]
            has_people_match = False
            if len(shared_all) >= 2:
                has_people_match = True
                score += 2.8 + 0.4 * min(3, len(shared_all) - 2)
            elif shared_char or named_shared:
                has_people_match = True
                score += 1.9

            geo_match = False
            if c_geo and alb["geo_pts"]:
                for g_lat, g_lon in alb["geo_pts"]:
                    if haversine_km(c_lat, c_lon, g_lat, g_lon) <= 2.5:
                        geo_match = True
                        break
            elif c_city and c_city in alb["cities"]:
                geo_match = True
            if geo_match:
                lbl = c_city or (next(iter(alb["cities"]), "") if alb["cities"] else "")
                tags.append("Lieu")
                reasons.append(f"Même lieu ({lbl})" if lbl else "Même lieu")
                score += 1.9

            time_match = False
            if ts > 0 and alb["min_ts"] and alb["max_ts"] and alb["is_focused_time"]:
                pad = 6 * 3600
                if (alb["min_ts"] - pad) <= ts <= (alb["max_ts"] + pad):
                    time_match = True
                    tags.append("Période")
                    reasons.append("Même période")
                    score += 2.1 + max(0.0, 0.8 * (1.0 - (alb["span"] / (14 * 86400.0))))

            if has_people_match:
                tags.append("Personne")
                if named_shared:
                    names_txt = ", ".join(named_shared[:2]) + ("…" if len(named_shared) > 2 else "")
                    reasons.append(f"Même personne ({names_txt})" if len(named_shared) == 1 else f"Mêmes personnes ({names_txt})")
                else:
                    reasons.append("Même personne reconnue")

            qualifies = (
                (scene_sim >= 0.74)
                or (len(shared_all) >= 2)
                or (has_people_match and (time_match or geo_match or scene_sim >= 0.64))
                or (time_match)
                or (geo_match and (scene_sim >= 0.60 or not ts or not alb["mid_ts"] or abs(ts - alb["mid_ts"]) <= 30 * 86400))
            )
            if not qualifies:
                continue

            if len(tags) >= 2:
                score += 0.9 * (len(tags) - 1)

            if score > best_score:
                best_score = score
                best_alb = alb["name"]
                best_tags = tags
                best_reasons = reasons

        if best_alb:
            clean = {k: v for k, v in c.items() if not k.startswith("_")}
            clean["suggested_album"] = best_alb
            clean["match_tags"] = best_tags
            clean["suggestion_reason"] = f"{' · '.join(best_reasons)} que « {best_alb} »"
            clean["_match_score"] = round(best_score, 3)
            matches.append(clean)

    matches.sort(key=lambda x: (-x["_match_score"], -(x.get("timestamp") or 0)))
    return matches[:limit]


def compute_new_album_events(
    conn: sqlite3.Connection,
    exclude_sources: set[str] | None = None,
    home_country: str = "",
    min_cluster_size: int = 4,
    limit: int = 16,
) -> list[dict]:
    """Détecte des grappes de médias non classés (week-ends, séjours, événements) pour créer de nouveaux albums."""
    cur = conn.cursor()
    cols = {r[1] for r in cur.execute("PRAGMA table_info(processed_files)").fetchall()}
    dur_sel = ", duration_sec" if "duration_sec" in cols else ", NULL AS duration_sec"

    existing_lower = {
        (r[0] or "").strip().lower()
        for r in cur.execute("SELECT full_path FROM albums").fetchall()
        if r[0]
    }
    rows = cur.execute(f"""
        SELECT source_path, dest_path, timestamp, file_size, width, height{dur_sel}, latitude, longitude
        FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
          AND COALESCE(TRIM(album_name), '') = ''
          AND timestamp IS NOT NULL AND timestamp > 0
        ORDER BY timestamp ASC
    """).fetchall()
    excluded = exclude_sources or set()
    unassigned = [dict(r) for r in rows if r["source_path"] not in excluded]
    if len(unassigned) < min_cluster_size:
        return []

    geo_cache = _load_geo_cache(conn)
    clusters: list[list[dict]] = []
    curr: list[dict] = [unassigned[0]]
    for item in unassigned[1:]:
        gap = int(item["timestamp"]) - int(curr[-1]["timestamp"])
        span_if_added = int(item["timestamp"]) - int(curr[0]["timestamp"])
        if gap <= 36 * 3600 and span_if_added <= 14 * 86400:
            curr.append(item)
        else:
            if len(curr) >= min_cluster_size:
                clusters.append(curr)
            curr = [item]
    if len(curr) >= min_cluster_size:
        clusters.append(curr)

    events: list[dict] = []
    home_low = (home_country or "").strip().lower()
    for cl in clusters:
        cities: Counter[str] = Counter()
        countries: Counter[str] = Counter()
        for it in cl:
            lat, lon = it.get("latitude"), it.get("longitude")
            if lat is not None and lon is not None and (abs(float(lat)) > 0.001 or abs(float(lon)) > 0.001):
                c_lbl, c_ctry = geo_cache.get((round(float(lat), 2), round(float(lon), 2)), ("", ""))
                if c_lbl:
                    cities[c_lbl] += 1
                if c_ctry:
                    countries[c_ctry] += 1

        start_ts = int(cl[0]["timestamp"])
        end_ts = int(cl[-1]["timestamp"])
        dt_start = datetime.fromtimestamp(start_ts)
        month_yr = f"{_MOIS_FR[dt_start.month]} {dt_start.year}"
        top_city = cities.most_common(1)[0][0] if cities else ""
        top_country = countries.most_common(1)[0][0] if countries else ""
        is_abroad = bool(home_low and top_country and top_country.lower() != home_low)

        if top_city and is_abroad:
            base_name = f"Voyage à {top_city} · {month_yr}"
            reason = f"Séjour détecté hors {home_country} ({len(cl)} médias)"
        elif top_city:
            base_name = f"{top_city} · {month_yr}"
            reason = f"Série prise à {top_city} ({len(cl)} médias)"
        else:
            span_days = max(1, int(round((end_ts - start_ts) / 86400.0)) + 1)
            base_name = f"Événement · {dt_start.strftime('%d')} {month_yr}"
            reason = f"Grappes temporelles sur {span_days} jour(s) ({len(cl)} médias)"

        cand_name = base_name
        suffix = 2
        while cand_name.lower() in existing_lower:
            cand_name = f"{base_name} ({suffix})"
            suffix += 1
        existing_lower.add(cand_name.lower())

        events.append({
            "suggested_name": cand_name,
            "reason": reason,
            "city": top_city,
            "country": top_country,
            "item_count": len(cl),
            "start_ts": start_ts,
            "end_ts": end_ts,
            "source_paths": [x["source_path"] for x in cl],
            "preview_dest_paths": [x["dest_path"] for x in cl[:4]],
            "items": [
                {
                    "source_path": x["source_path"],
                    "dest_path": x["dest_path"],
                    "timestamp": x.get("timestamp"),
                    "file_size": x.get("file_size"),
                    "width": x.get("width"),
                    "height": x.get("height"),
                    "duration_sec": x.get("duration_sec"),
                }
                for x in cl
            ],
        })

    events.sort(key=lambda e: (-e["item_count"], -e["start_ts"]))
    return events[:limit]


def compute_missing_gps_suggestions(conn: sqlite3.Connection, max_gap_sec: int = 6 * 3600, limit: int = 120) -> list[dict]:
    """Trouve les médias sans GPS pris à quelques heures d'un autre média géolocalisé."""
    cur = conn.cursor()
    geo_rows = cur.execute("""
        SELECT timestamp, latitude, longitude
        FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
          AND timestamp IS NOT NULL AND timestamp > 0
          AND latitude IS NOT NULL AND longitude IS NOT NULL
          AND (ABS(latitude) > 0.001 OR ABS(longitude) > 0.001)
        ORDER BY timestamp ASC
    """).fetchall()
    if not geo_rows:
        return []

    geo_ts = [int(r["timestamp"]) for r in geo_rows]
    geo_cache = _load_geo_cache(conn)

    missing_rows = cur.execute("""
        SELECT source_path, dest_path, timestamp, file_size, width, height, album_name
        FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
          AND timestamp IS NOT NULL AND timestamp > 0
          AND (latitude IS NULL OR longitude IS NULL OR (ABS(latitude) <= 0.001 AND ABS(longitude) <= 0.001))
        ORDER BY timestamp DESC
    """).fetchall()

    results: list[dict] = []
    for r in missing_rows:
        ts = int(r["timestamp"])
        pos = bisect_left(geo_ts, ts)
        best_idx = None
        best_diff = max_gap_sec + 1
        for cand_i in (pos - 1, pos):
            if 0 <= cand_i < len(geo_ts):
                diff = abs(ts - geo_ts[cand_i])
                if diff <= max_gap_sec and diff < best_diff:
                    best_diff = diff
                    best_idx = cand_i
        if best_idx is None:
            continue

        g_row = geo_rows[best_idx]
        lat = float(g_row["latitude"])
        lon = float(g_row["longitude"])
        city, country = geo_cache.get((round(lat, 2), round(lon, 2)), ("", ""))
        place_lbl = city or country or f"{lat:.4f}, {lon:.4f}"
        mins = max(1, int(round(best_diff / 60.0)))
        gap_txt = f"{mins} min" if mins < 60 else f"{max(1, round(mins / 60))} h"

        d = dict(r)
        d["suggested_lat"] = lat
        d["suggested_lon"] = lon
        d["suggested_city"] = place_lbl
        d["time_diff_sec"] = best_diff
        d["suggestion_reason"] = f"Lieu estimé : {place_lbl} (photo à {gap_txt})"
        results.append(d)
        if len(results) >= limit:
            break

    return results


def compute_screenshots_suggestions(conn: sqlite3.Connection, min_age_days: int = 90, limit: int = 120) -> list[dict]:
    """Repère les captures d'écran et documents OCR anciens hors album Documents."""
    cur = conn.cursor()
    cutoff_ts = int(time.time()) - (max(0, int(min_age_days)) * 86400) if min_age_days > 0 else None

    ocr_map: dict[str, tuple[str, int]] = {}
    try:
        for orow in cur.execute("SELECT source_path, full_text, line_count FROM ocr_results WHERE COALESCE(line_count, 0) >= 4 OR LENGTH(COALESCE(full_text, '')) >= 60").fetchall():
            ocr_map[orow["source_path"]] = ((orow["full_text"] or "").strip(), int(orow["line_count"] or 0))
    except Exception:
        pass

    rows = cur.execute("""
        SELECT source_path, dest_path, timestamp, modified_at, file_size, width, height, album_name
        FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND dest_path IS NOT NULL
        ORDER BY COALESCE(timestamp, modified_at, 0) ASC
    """).fetchall()

    now_ts = int(time.time())
    out: list[dict] = []
    for r in rows:
        alb = (r["album_name"] or "").lower()
        if "documents" in [a.strip() for a in alb.split(",")]:
            continue
        ts_eff = int(r["timestamp"] or r["modified_at"] or 0)
        if cutoff_ts is not None and (ts_eff <= 0 or ts_eff > cutoff_ts):
            continue

        fname = Path(r["dest_path"]).name.lower()
        is_screen = any(tok in fname for tok in SCREENSHOT_NAME_TOKENS)
        ocr_info = ocr_map.get(r["source_path"])
        if not is_screen and not ocr_info:
            continue

        d = dict(r)
        if is_screen:
            d["doc_kind"] = "Capture d'écran"
        else:
            d["doc_kind"] = f"Document ({ocr_info[1]} lignes OCR)"
        d["ocr_excerpt"] = (ocr_info[0][:90] + "…") if (ocr_info and len(ocr_info[0]) > 90) else (ocr_info[0] if ocr_info else "")
        d["age_days"] = max(0, int((now_ts - ts_eff) / 86400)) if ts_eff > 0 else None
        out.append(d)
        if len(out) >= limit:
            break

    return out


def compute_people_suggestions(conn: sqlite3.Connection, min_sim: float = 0.38, min_unknown_faces: int = 3, limit: int = 24) -> dict:
    """Retourne les paires de visages similaires à fusionner et les visages Inconnus récurrents à nommer."""
    cur = conn.cursor()
    merge_pairs: list[dict] = []
    unnamed: list[dict] = []
    try:
        rows = [dict(r) for r in cur.execute("""
            SELECT p.person_id, p.name, p.face_count, p.centroid_embedding, f.thumb_path
            FROM persons p LEFT JOIN faces f ON p.cover_face_id = f.face_id
            WHERE p.centroid_embedding IS NOT NULL
        """).fetchall()]
        if len(rows) >= 2:
            vecs = np.vstack([np.frombuffer(r["centroid_embedding"], dtype=np.float32) for r in rows])
            sim_mat = np.dot(vecs, vecs.T)
            for i in range(len(rows)):
                for j in range(i + 1, len(rows)):
                    sc = float(sim_mat[i, j])
                    if sc >= min_sim:
                        n1, n2 = rows[i]["name"], rows[j]["name"]
                        if n1 != "Inconnu" and n2 != "Inconnu" and n1.lower() != n2.lower():
                            continue
                        merge_pairs.append({
                            "p1": {k: rows[i][k] for k in ("person_id", "name", "face_count", "thumb_path")},
                            "p2": {k: rows[j][k] for k in ("person_id", "name", "face_count", "thumb_path")},
                            "similarity": round(sc * 100, 1),
                        })
            merge_pairs.sort(key=lambda x: x["similarity"], reverse=True)
            merge_pairs = merge_pairs[:limit]

        unnamed = [dict(r) for r in cur.execute("""
            SELECT p.person_id, p.name, p.face_count, f.thumb_path
            FROM persons p LEFT JOIN faces f ON p.cover_face_id = f.face_id
            WHERE LOWER(TRIM(p.name)) = 'inconnu' AND p.face_count >= ?
            ORDER BY p.face_count DESC
            LIMIT ?
        """, (int(min_unknown_faces), int(limit))).fetchall()]
    except Exception:
        pass

    return {"merge_pairs": merge_pairs, "unnamed_persons": unnamed}


def find_sharper_similar_sources(conn: sqlite3.Connection, blur_map: dict[str, float]) -> set[str]:
    """Identifie parmi les photos floues celles qui ont un cliché nettement meilleur avec pHash proche."""
    if not blur_map:
        return set()
    try:
        rows = conn.execute("""
            SELECT source_path, phash, blur_score
            FROM processed_files
            WHERE is_duplicate = 0 AND is_trashed = 0
              AND phash IS NOT NULL AND phash != '' AND phash != 'NONE'
              AND blur_score IS NOT NULL AND blur_score >= 0
        """).fetchall()
    except Exception:
        return set()

    parsed = []
    for r in rows:
        try:
            parsed.append((r["source_path"], imagehash.hex_to_hash(r["phash"]), float(r["blur_score"])))
        except Exception:
            continue

    flagged: set[str] = set()
    for i, (src_a, h_a, b_a) in enumerate(parsed):
        if src_a not in blur_map:
            continue
        for j, (src_b, h_b, b_b) in enumerate(parsed):
            if i == j:
                continue
            if b_b > b_a * 1.6 and b_b >= DEFAULT_BLUR_THRESHOLD and (h_a - h_b) <= 10:
                flagged.add(src_a)
                break
    return flagged
