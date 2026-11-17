import time
import sqlite3
from urllib.parse import unquote

import cv2
import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from database import get_active_db_and_dest, get_db, resolve_actual_path, log_library_action, build_file_entry
from library_manager import get_library_tech_dir
from indexeur_visages import save_face_thumbnail
from sync_visages_exif import sync_all_named_faces_to_exif

router = APIRouter()


class MergeMultiplePersonsPayload(BaseModel):
    person_ids: list[int]
    target_name: str | None = None


class RenamePersonPayload(BaseModel):
    person_id: int
    new_name: str


class ReassignFacesPayload(BaseModel):
    face_ids: list[int]
    action: str
    target_person_id: int | None = None
    new_group_name: str | None = None


class ManualFacePayload(BaseModel):
    dest_path: str
    norm_x1: float
    norm_y1: float
    norm_x2: float
    norm_y2: float
    target_person_id: int | None = None
    new_person_name: str | None = None


def _recompute_person_stats(cur: sqlite3.Cursor, person_id: int):
    cur.execute("SELECT face_id, det_score, embedding FROM faces WHERE person_id = ?", (person_id,))
    rows = cur.fetchall()
    if not rows:
        cur.execute("DELETE FROM persons WHERE person_id = ?", (person_id,))
        return
    best = max(rows, key=lambda r: r["det_score"] or 0.0)
    embs = [np.frombuffer(r["embedding"], dtype=np.float32) for r in rows if r["embedding"]]
    centroid_blob = None
    if embs:
        c = np.mean(np.vstack(embs), axis=0)
        norm = np.linalg.norm(c)
        if norm > 0:
            centroid_blob = (c / norm).astype(np.float32).tobytes()
    cur.execute("UPDATE persons SET cover_face_id=?, face_count=?, centroid_embedding=? WHERE person_id=?", (best["face_id"], len(rows), centroid_blob, person_id))


@router.get("/api/persons")
def api_get_persons():
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT p.person_id, p.name, p.face_count, f.thumb_path
        FROM persons p LEFT JOIN faces f ON p.cover_face_id = f.face_id
        ORDER BY (p.name != 'Inconnu') DESC, p.face_count DESC
    """)
    persons = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"persons": persons}


@router.post("/api/person/rename")
def api_rename_person(payload: RenamePersonPayload):
    new_n = payload.new_name.strip() or "Inconnu"
    conn = get_db()
    conn.execute("UPDATE persons SET name = ? WHERE person_id = ?", (new_n, payload.person_id))
    conn.commit()
    conn.close()
    log_library_action("PERSON_RENAME", "Personne renommée", f"Personne #{payload.person_id} → « {new_n} »")
    return {"status": "renamed"}


@router.get("/api/person/{person_id}/timeline")
def api_person_timeline(person_id: int):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT person_id, name, face_count FROM persons WHERE person_id = ?", (person_id,))
    person = cur.fetchone()
    if not person:
        conn.close()
        raise HTTPException(404, "Personne introuvable")
    cur.execute("SELECT face_id, source_path, dest_path, timestamp, thumb_path FROM faces WHERE person_id = ? ORDER BY COALESCE(timestamp, 0) ASC", (person_id,))
    faces = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {"person": dict(person), "faces": faces}


@router.post("/api/persons/merge")
def api_merge_persons(payload: MergeMultiplePersonsPayload):
    pids = list(dict.fromkeys(payload.person_ids))
    if len(pids) < 2:
        raise HTTPException(400, "Sélectionnez au moins 2 visages.")
    conn = get_db()
    cur = conn.cursor()
    ph = ",".join("?" for _ in pids)
    cur.execute(f"SELECT person_id, name, face_count FROM persons WHERE person_id IN ({ph})", pids)
    rows = sorted(cur.fetchall(), key=lambda r: (r["name"] != "Inconnu", r["face_count"]), reverse=True)
    target_id = rows[0]["person_id"]
    final_name = (payload.target_name or "").strip() or rows[0]["name"]
    other_ids = [r["person_id"] for r in rows[1:]]
    oph = ",".join("?" for _ in other_ids)
    cur.execute(f"UPDATE faces SET person_id = ? WHERE person_id IN ({oph})", [target_id, *other_ids])
    cur.execute(f"DELETE FROM persons WHERE person_id IN ({oph})", other_ids)
    cur.execute("UPDATE persons SET name = ? WHERE person_id = ?", (final_name, target_id))
    _recompute_person_stats(cur, target_id)
    conn.commit()
    conn.close()
    log_library_action("PERSON_MERGE", "Personnes fusionnées", f"{len(pids)} groupe(s) fusionné(s) en « {final_name} »")
    return {"status": "merged", "target_person_id": target_id}


@router.get("/api/persons/suggestions")
def api_merge_suggestions(min_sim: float = 0.38):
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        SELECT p.person_id, p.name, p.face_count, p.centroid_embedding, f.thumb_path
        FROM persons p LEFT JOIN faces f ON p.cover_face_id = f.face_id
        WHERE p.centroid_embedding IS NOT NULL
    """)
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    if len(rows) < 2:
        return {"suggestions": []}
    vecs = np.vstack([np.frombuffer(r["centroid_embedding"], dtype=np.float32) for r in rows])
    sim_mat = np.dot(vecs, vecs.T)
    pairs = []
    for i in range(len(rows)):
        for j in range(i + 1, len(rows)):
            sc = float(sim_mat[i, j])
            if sc >= min_sim:
                n1, n2 = rows[i]["name"], rows[j]["name"]
                if n1 != "Inconnu" and n2 != "Inconnu" and n1.lower() != n2.lower():
                    continue
                pairs.append({
                    "p1": {k: rows[i][k] for k in ("person_id", "name", "face_count", "thumb_path")},
                    "p2": {k: rows[j][k] for k in ("person_id", "name", "face_count", "thumb_path")},
                    "similarity": round(sc * 100, 1)
                })
    pairs.sort(key=lambda x: x["similarity"], reverse=True)
    return {"suggestions": pairs[:24]}


@router.post("/api/faces/reassign")
def api_reassign_faces(payload: ReassignFacesPayload):
    conn = get_db()
    cur = conn.cursor()
    ph = ",".join("?" for _ in payload.face_ids)
    cur.execute(f"SELECT DISTINCT person_id FROM faces WHERE face_id IN ({ph})", payload.face_ids)
    old_pids = [r["person_id"] for r in cur.fetchall() if r["person_id"]]
    new_pid = None

    if payload.action == "IGNORE":
        cur.execute(f"DELETE FROM faces WHERE face_id IN ({ph})", payload.face_ids)
    elif payload.action == "EXISTING_PERSON" and payload.target_person_id:
        new_pid = payload.target_person_id
        cur.execute(f"UPDATE faces SET person_id = ?, exif_synced_name = NULL WHERE face_id IN ({ph})", [new_pid, *payload.face_ids])
    elif payload.action == "NEW_GROUP":
        cur.execute("INSERT INTO persons (name, face_count) VALUES (?, 0)", ((payload.new_group_name or "Inconnu").strip(),))
        new_pid = cur.lastrowid
        cur.execute(f"UPDATE faces SET person_id = ?, exif_synced_name = NULL WHERE face_id IN ({ph})", [new_pid, *payload.face_ids])

    for pid in set(old_pids):
        _recompute_person_stats(cur, pid)
    if new_pid:
        _recompute_person_stats(cur, new_pid)
    conn.commit()
    conn.close()
    log_library_action(
        "FACE_REASSIGN",
        "Visages mis à jour",
        f"{len(payload.face_ids)} visage(s) {'ignoré(s)' if payload.action == 'IGNORE' else 'réassigné(s)'}",
    )
    return {"status": "reassigned"}


@router.post("/api/faces/sync_exif")
def api_sync_faces_exif():
    db_p, dest_p = get_active_db_and_dest()
    return sync_all_named_faces_to_exif(db_p, dest_p)


@router.post("/api/faces/manual_add")
def api_add_manual_face(payload: ManualFacePayload):
    media_path = resolve_actual_path(unquote(payload.dest_path))
    if not media_path or not media_path.exists():
        raise HTTPException(404, "Média introuvable")
    img = cv2.imread(str(media_path))
    if img is None:
        raise HTTPException(400, "Impossible de décoder l'image")
    h, w = img.shape[:2]
    x1, y1 = int(max(0, min(payload.norm_x1, payload.norm_x2) * w)), int(max(0, min(payload.norm_y1, payload.norm_y2) * h))
    x2, y2 = int(min(w, max(payload.norm_x1, payload.norm_x2) * w)), int(min(h, max(payload.norm_y1, payload.norm_y2) * h))

    _, active_dest = get_active_db_and_dest()
    import indexeur_visages as fv
    fv.THUMBS_DIR = get_library_tech_dir(active_dest, "Miniatures_Visages")
    uid = f"manual_{abs(hash(str(media_path)))}_{int(time.time() * 1000)}"
    thumb_path = save_face_thumbnail(img, [x1, y1, x2, y2], uid)

    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT source_path, timestamp FROM processed_files WHERE dest_path = ?", (str(media_path),))
    pf = cur.fetchone()
    src_path = pf["source_path"] if pf else str(media_path)
    ts = pf["timestamp"] if pf else int(media_path.stat().st_mtime)

    person_id = payload.target_person_id
    if not person_id:
        cur.execute("INSERT INTO persons (name, face_count) VALUES (?, 0)", ((payload.new_person_name or "Inconnu").strip(),))
        person_id = cur.lastrowid

    cur.execute("""
        INSERT INTO faces (source_path, dest_path, timestamp, bbox, det_score, embedding, thumb_path, person_id)
        VALUES (?, ?, ?, ?, 1.0, NULL, ?, ?)
    """, (src_path, str(media_path), ts, f"{x1},{y1},{x2},{y2}", thumb_path, person_id))
    _recompute_person_stats(cur, person_id)
    conn.commit()
    conn.close()
    log_library_action("FACE_MANUAL", "Visage ajouté manuellement", f"Sur {media_path.name}", files=[build_file_entry(str(media_path))])
    return {"status": "added"}
