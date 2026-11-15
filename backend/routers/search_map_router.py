import json
import re
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path
from fastapi import APIRouter

from database import get_active_db_and_dest, get_db
from indexeur_semantique_gps import search_photos_by_natural_text

router = APIRouter()

_MONTHS_FR = {
    "janvier": "01", "janv": "01", "jan": "01",
    "fevrier": "02", "fev": "02",
    "mars": "03", "mar": "03",
    "avril": "04", "avr": "04",
    "mai": "05",
    "juin": "06",
    "juillet": "07", "juil": "07",
    "aout": "08",
    "septembre": "09", "sept": "09", "sep": "09",
    "octobre": "10", "oct": "10",
    "novembre": "11", "nov": "11",
    "decembre": "12", "dec": "12",
}

_PLACES_BBOX = {
    # Villes & pays courants (lat_min, lat_max, lon_min, lon_max)
    "paris": (48.70, 48.98, 2.15, 2.55),
    "lyon": (45.65, 45.85, 4.72, 4.95),
    "marseille": (43.18, 43.40, 5.25, 5.55),
    "nice": (43.64, 43.76, 7.18, 7.33),
    "toulouse": (43.52, 43.68, 1.34, 1.54),
    "bordeaux": (44.78, 44.92, -0.68, -0.48),
    "lille": (50.57, 50.69, 2.98, 3.15),
    "nantes": (47.15, 47.30, -1.65, -1.45),
    "strasbourg": (48.52, 48.65, 7.66, 7.83),
    "montpellier": (43.56, 43.66, 3.80, 3.95),
    "rennes": (48.06, 48.16, -1.75, -1.58),
    "londres": (51.35, 51.65, -0.35, 0.15),
    "london": (51.35, 51.65, -0.35, 0.15),
    "rome": (41.78, 42.00, 12.35, 12.62),
    "roma": (41.78, 42.00, 12.35, 12.62),
    "barcelone": (41.32, 41.47, 2.05, 2.25),
    "barcelona": (41.32, 41.47, 2.05, 2.25),
    "madrid": (40.32, 40.52, -3.82, -3.55),
    "new york": (40.55, 40.92, -74.10, -73.70),
    "tokyo": (35.52, 35.82, 139.55, 139.92),
    "france": (41.30, 51.15, -5.20, 9.60),
    "espagne": (35.90, 43.85, -9.35, 3.40),
    "italie": (36.60, 47.10, 6.60, 18.60),
    "suisse": (45.80, 47.85, 5.95, 10.50),
    "belgique": (49.45, 51.55, 2.50, 6.45),
    "portugal": (36.90, 42.20, -9.55, -6.15),
    "allemagne": (47.25, 55.10, 5.85, 15.05),
}


def _norm_txt(s: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFD", (s or "").lower())
        if unicodedata.category(c) != "Mn"
    )


def _search_photos_metadata(conn, query: str, limit: int = 60) -> list[dict]:
    q_raw = (query or "").strip()
    if not q_raw:
        return []

    conn.create_function("BASENAME", 1, lambda p: Path(p).name.lower() if p else "")
    cur = conn.cursor()
    tables = {r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    has_faces = "faces" in tables and "persons" in tables
    has_ocr = "ocr_results" in tables

    q_norm = _norm_txt(q_raw)
    tokens = [t for t in re.split(r"[\s,;]+", q_norm) if t]
    if not tokens:
        return []

    where_clauses = ["pf.is_duplicate = 0", "pf.is_trashed = 0", "pf.dest_path IS NOT NULL"]
    params = []

    # Détection de lieu composé (ex: "new york")
    matched_place_bbox = None
    for place_name, bbox in _PLACES_BBOX.items():
        if place_name in q_norm:
            matched_place_bbox = bbox
            break

    for tok in tokens:
        or_parts = [
            "BASENAME(COALESCE(pf.dest_path, '')) LIKE ?",
            "BASENAME(COALESCE(pf.source_path, '')) LIKE ?",
            "LOWER(COALESCE(pf.album_name, '')) LIKE ?",
        ]
        like_val = f"%{tok}%"
        tok_params = [like_val, like_val, like_val]

        if has_faces:
            or_parts.append(
                "EXISTS (SELECT 1 FROM faces f JOIN persons p ON f.person_id = p.person_id "
                "WHERE (f.dest_path = pf.dest_path OR f.source_path = pf.source_path) "
                "AND LOWER(COALESCE(p.name, '')) LIKE ?)"
            )
            tok_params.append(like_val)

        if has_ocr:
            or_parts.append(
                "EXISTS (SELECT 1 FROM ocr_results o "
                "WHERE (o.dest_path = pf.dest_path OR o.source_path = pf.source_path) "
                "AND LOWER(COALESCE(o.full_text, '')) LIKE ?)"
            )
            tok_params.append(like_val)

        # Dates : YYYY-MM-DD, DD/MM/YYYY, MM/YYYY, YYYY-MM, YYYY, mois en français
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", tok):
            or_parts.append("(pf.timestamp > 0 AND strftime('%Y-%m-%d', datetime(pf.timestamp, 'unixepoch', 'localtime')) = ?)")
            tok_params.append(tok)
        elif re.fullmatch(r"\d{2}/\d{2}/\d{4}", tok):
            dd, mm, yyyy = tok.split("/")
            or_parts.append("(pf.timestamp > 0 AND strftime('%Y-%m-%d', datetime(pf.timestamp, 'unixepoch', 'localtime')) = ?)")
            tok_params.append(f"{yyyy}-{mm}-{dd}")
        elif re.fullmatch(r"\d{2}/\d{4}", tok):
            mm, yyyy = tok.split("/")
            or_parts.append("(pf.timestamp > 0 AND strftime('%Y-%m', datetime(pf.timestamp, 'unixepoch', 'localtime')) = ?)")
            tok_params.append(f"{yyyy}-{mm}")
        elif re.fullmatch(r"\d{4}-\d{2}", tok):
            or_parts.append("(pf.timestamp > 0 AND strftime('%Y-%m', datetime(pf.timestamp, 'unixepoch', 'localtime')) = ?)")
            tok_params.append(tok)
        elif re.fullmatch(r"(19|20)\d{2}", tok):
            or_parts.append("(pf.timestamp > 0 AND strftime('%Y', datetime(pf.timestamp, 'unixepoch', 'localtime')) = ?)")
            tok_params.append(tok)
        elif tok in _MONTHS_FR:
            or_parts.append("(pf.timestamp > 0 AND strftime('%m', datetime(pf.timestamp, 'unixepoch', 'localtime')) = ?)")
            tok_params.append(_MONTHS_FR[tok])

        # Lieu GPS
        bbox = _PLACES_BBOX.get(tok) or matched_place_bbox
        if bbox:
            lat_min, lat_max, lon_min, lon_max = bbox
            or_parts.append(
                "(pf.latitude IS NOT NULL AND pf.longitude IS NOT NULL "
                "AND pf.latitude BETWEEN ? AND ? AND pf.longitude BETWEEN ? AND ?)"
            )
            tok_params.extend([lat_min, lat_max, lon_min, lon_max])

        where_clauses.append("(" + " OR ".join(or_parts) + ")")
        params.extend(tok_params)

    sql = f"""
        SELECT pf.source_path, pf.dest_path, pf.timestamp, pf.album_name, pf.is_favorite
        FROM processed_files pf
        WHERE {" AND ".join(where_clauses)}
        ORDER BY COALESCE(pf.timestamp, 0) DESC
        LIMIT ?
    """
    params.append(limit)
    cur.execute(sql, params)
    rows = cur.fetchall()
    return [
        {
            "source_path": r["source_path"],
            "dest_path": r["dest_path"],
            "timestamp": r["timestamp"],
            "album_name": r["album_name"],
            "is_favorite": r["is_favorite"],
            "similarity": 100,
            "match_label": "Métadonnées",
        }
        for r in rows
    ]


@router.get("/api/ocr/search")
def api_ocr_search(q: str = ""):
    conn = get_db()
    conn.create_function("BASENAME", 1, lambda p: Path(p).name.lower() if p else "")
    cur = conn.cursor()
    if not q.strip():
        cur.execute("SELECT * FROM ocr_results ORDER BY COALESCE(timestamp, 0) DESC LIMIT 48")
    else:
        safe_q = q.replace('"', '').strip()
        cur.execute("""
            SELECT r.* FROM ocr_fts f JOIN ocr_results r ON f.source_path = r.source_path
            WHERE ocr_fts MATCH ? ORDER BY rank LIMIT 60
        """, (f'"{safe_q}"*',))
    results = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"results": results}


@router.get("/api/semantic/search")
def api_semantic_search(q: str = ""):
    db_p, _ = get_active_db_and_dest()
    conn = get_db()
    try:
        meta_results = _search_photos_metadata(conn, q, limit=60)
    finally:
        conn.close()

    ai_results = []
    try:
        ai_results = search_photos_by_natural_text(db_p, q)
    except Exception:
        ai_results = []

    seen = set()
    merged = []
    for item in meta_results + ai_results:
        key = item.get("source_path") or item.get("dest_path")
        if not key or key in seen:
            continue
        seen.add(key)
        merged.append(item)
    return {"results": merged[:60]}


@router.get("/api/map/points")
def api_map_points():
    conn = get_db()
    conn.create_function("BASENAME", 1, lambda p: Path(p).name.lower() if p else "")
    cur = conn.cursor()
    cur.execute("""
        SELECT source_path, dest_path, timestamp, latitude, longitude, album_name, is_favorite
        FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0
          AND latitude IS NOT NULL AND longitude IS NOT NULL AND (latitude != 0.0 OR longitude != 0.0)
    """)
    points = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"points": points, "count": len(points)}


def _extract_city_from_nominatim(data: dict) -> tuple[str, str, str]:
    addr = data.get("address") or {}
    city = (
        addr.get("city")
        or addr.get("town")
        or addr.get("village")
        or addr.get("municipality")
        or addr.get("hamlet")
        or addr.get("suburb")
        or addr.get("city_district")
        or addr.get("county")
        or addr.get("state")
        or addr.get("region")
        or ""
    ).strip()
    country = (addr.get("country") or "").strip()
    if not city and country:
        city = country
    display_label = f"{city}, {country}" if (city and country and city != country) else (city or country or "")
    return city, country, display_label


def _reverse_geocode_offline_city(lat: float, lon: float) -> str:
    """Offline fallback matching city bounding boxes (excluding broad country boxes)."""
    candidates = []
    for place_name, (lat_min, lat_max, lon_min, lon_max) in _PLACES_BBOX.items():
        area = (lat_max - lat_min) * (lon_max - lon_min)
        if area < 2.0 and lat_min <= lat <= lat_max and lon_min <= lon <= lon_max:
            candidates.append((area, place_name.title()))
    if not candidates:
        return ""
    candidates.sort(key=lambda x: x[0])
    return candidates[0][1]


def _fetch_nominatim_city(lat: float, lon: float) -> tuple[str, str, str]:
    query = urllib.parse.urlencode({
        "format": "jsonv2",
        "lat": f"{lat:.6f}",
        "lon": f"{lon:.6f}",
        "zoom": "10",
        "addressdetails": "1",
        "accept-language": "fr",
    })
    url = f"https://nominatim.openstreetmap.org/reverse?{query}"
    req = urllib.request.Request(url, headers={"User-Agent": "Phototo/1.0 (local photo library)"})
    with urllib.request.urlopen(req, timeout=3.5) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return _extract_city_from_nominatim(data)


@router.get("/api/map/reverse")
def api_reverse_geocode(lat: float, lon: float):
    lat_key = round(float(lat), 2)
    lon_key = round(float(lon), 2)

    conn = get_db()
    try:
        row = conn.execute(
            "SELECT city, country, display_label FROM geocode_cache WHERE lat_key = ? AND lon_key = ?",
            (lat_key, lon_key),
        ).fetchone()
        if row and (row["city"] or row["display_label"]):
            city = (row["city"] or "").strip()
            country = (row["country"] or "").strip()
            label = (row["display_label"] or city).strip()
            return {"city": city, "country": country, "label": label, "cached": True}

        city, country, display_label = "", "", ""
        try:
            city, country, display_label = _fetch_nominatim_city(float(lat), float(lon))
        except Exception:
            city, country, display_label = "", "", ""

        if city:
            conn.execute(
                """
                INSERT OR REPLACE INTO geocode_cache (lat_key, lon_key, city, country, display_label, updated_at)
                VALUES (?, ?, ?, ?, ?, strftime('%s','now'))
                """,
                (lat_key, lon_key, city, country, display_label),
            )
            conn.commit()
            return {"city": city, "country": country, "label": display_label, "cached": False}

        fallback_city = _reverse_geocode_offline_city(float(lat), float(lon))
        if fallback_city:
            return {"city": fallback_city, "country": "", "label": fallback_city, "cached": False}

        return {"city": "", "country": "", "label": "Lieu inconnu", "cached": False}
    finally:
        conn.close()
