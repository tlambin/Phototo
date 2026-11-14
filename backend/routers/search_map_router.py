from fastapi import APIRouter

from database import get_active_db_and_dest, get_db
from indexeur_semantique_gps import search_photos_by_natural_text

router = APIRouter()


@router.get("/api/ocr/search")
def api_ocr_search(q: str = ""):
    conn = get_db()
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
    return {"results": search_photos_by_natural_text(db_p, q)}


@router.get("/api/map/points")
def api_map_points():
    conn = get_db()
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
