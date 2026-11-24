import sqlite3
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
import imagehash
from media_frames import VIDEO_EXTS


def upgrade_db_for_video_similarity(conn: sqlite3.Connection):
    cur = conn.cursor()
    cols = {r[1] for r in cur.execute("PRAGMA table_info(processed_files)")}
    if "video_hash" not in cols:
        cur.execute("ALTER TABLE processed_files ADD COLUMN video_hash TEXT")
    if "duration_sec" not in cols:
        cur.execute("ALTER TABLE processed_files ADD COLUMN duration_sec REAL")
    conn.commit()


def compute_video_fingerprint(video_path: Path) -> tuple[str | None, float]:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        return None, 0.0
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = round(total_frames / fps, 2) if fps > 0 else 0.0

    hashes = []
    positions = [int(total_frames * r) for r in (0.1, 0.3, 0.5, 0.7, 0.9)] if total_frames >= 5 else [0]
    for pos in positions:
        cap.set(cv2.CAP_PROP_POS_FRAMES, pos)
        ret, frame = cap.read()
        if ret and frame is not None:
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            hashes.append(str(imagehash.phash(Image.fromarray(rgb))))
    cap.release()
    return ("-".join(hashes) if hashes else None), duration


def _hamming_u64_batch(target: int, candidates: np.ndarray) -> np.ndarray:
    """Calcule en vectorisé la distance de Hamming entre 1 hash 64-bit et un tableau numpy uint64."""
    x = candidates ^ np.uint64(target)
    x = x - ((x >> np.uint64(1)) & np.uint64(0x5555555555555555))
    x = (x & np.uint64(0x3333333333333333)) + ((x >> np.uint64(2)) & np.uint64(0x3333333333333333))
    x = (x + (x >> np.uint64(4))) & np.uint64(0x0F0F0F0F0F0F0F0F)
    return ((x * np.uint64(0x0101010101010101)) >> np.uint64(56)).astype(np.uint8)


def _hamming_u64_scalar(a: int, b: int) -> int:
    return (a ^ b).bit_count()


def _dedupe_by_blake3(rows: list[dict]) -> list[dict]:
    """Ne conserve qu'un seul représentant par blake3_hash non nul (les copies conformes restent dans Doublons)."""
    seen_b3: set[str] = set()
    kept: list[dict] = []
    for r in rows:
        b3 = r.get("blake3_hash")
        if b3:
            if b3 in seen_b3:
                continue
            seen_b3.add(b3)
        kept.append(r)
    return kept


def _parse_video_hashes(vhash: str | None) -> list[int]:
    if not vhash or vhash == "NONE":
        return []
    out: list[int] = []
    for part in str(vhash).split("-"):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(int(part, 16))
        except ValueError:
            return []
    return out


def _videos_are_similar(h1: list[int], dur1: float, h2: list[int], dur2: float, max_dist: int) -> bool:
    if not h1 or not h2:
        return False
    if dur1 > 0 and dur2 > 0:
        if abs(dur1 - dur2) > max(3.0, 0.35 * max(dur1, dur2)):
            return False
    if len(h1) == len(h2):
        dists = [_hamming_u64_scalar(a, b) for a, b in zip(h1, h2)]
        return (sum(dists) / len(dists)) <= max_dist and max(dists) <= (max_dist + 4)
    shorter, longer = (h1, h2) if len(h1) <= len(h2) else (h2, h1)
    best_dists = [min(_hamming_u64_scalar(a, b) for b in longer) for a in shorter]
    return (sum(best_dists) / len(best_dists)) <= max_dist


def find_similar_groups(conn: sqlite3.Connection, max_dist: int = 8, limit_groups: int = 120) -> list[list[dict]]:
    """
    Regroupe les photos ET vidéos visuellement proches sur toute la bibliothèque,
    en excluant strictement les copies conformes bit à bit (même blake3_hash).
    """
    cur = conn.cursor()
    cols = {r[1] for r in cur.execute("PRAGMA table_info(processed_files)")}
    has_b3 = "blake3_hash" in cols
    has_vid = "video_hash" in cols and "duration_sec" in cols

    groups: list[list[dict]] = []

    b3_col = "blake3_hash" if has_b3 else "NULL AS blake3_hash"
    cur.execute(f"""
        SELECT source_path, dest_path, timestamp, modified_at, phash, {b3_col}, width, height, file_size, album_name
        FROM processed_files
        WHERE is_duplicate = 0 AND is_trashed = 0 AND phash IS NOT NULL
        ORDER BY COALESCE(timestamp, 0) DESC
    """)
    img_rows = _dedupe_by_blake3([dict(r) for r in cur.fetchall()])

    valid_imgs: list[dict] = []
    img_u64: list[int] = []
    for r in img_rows:
        try:
            int(r["phash"], 16)
            valid_imgs.append(r)
            img_u64.append(int(str(r["phash"]), 16))
        except Exception:
            pass

    if len(valid_imgs) >= 2:
        arr = np.array(img_u64, dtype=np.uint64)
        visited = np.zeros(len(valid_imgs), dtype=bool)
        for i in range(len(valid_imgs)):
            if visited[i]:
                continue
            if i + 1 >= len(valid_imgs):
                break
            dists = _hamming_u64_batch(img_u64[i], arr[i + 1:])
            matches = np.where((dists <= max_dist) & (~visited[i + 1:]))[0]
            if matches.size > 0:
                visited[i] = True
                cluster = [valid_imgs[i]]
                for off in matches:
                    j = i + 1 + int(off)
                    visited[j] = True
                    cluster.append(valid_imgs[j])
                groups.append(cluster)
                if len(groups) >= limit_groups:
                    return groups

    if has_vid and len(groups) < limit_groups:
        cur.execute(f"""
            SELECT source_path, dest_path, timestamp, modified_at, video_hash, duration_sec, {b3_col}, width, height, file_size, album_name
            FROM processed_files
            WHERE is_duplicate = 0 AND is_trashed = 0 AND video_hash IS NOT NULL AND video_hash != '' AND video_hash != 'NONE'
            ORDER BY COALESCE(timestamp, 0) DESC
        """)
        vid_rows = _dedupe_by_blake3([dict(r) for r in cur.fetchall()])
        parsed_vids = []
        for r in vid_rows:
            vh = _parse_video_hashes(r.get("video_hash"))
            if vh:
                parsed_vids.append((vh, float(r.get("duration_sec") or 0.0), r))
        v_visited = [False] * len(parsed_vids)
        for i in range(len(parsed_vids)):
            if v_visited[i]:
                continue
            h1, d1, r1 = parsed_vids[i]
            cluster = [r1]
            for j in range(i + 1, len(parsed_vids)):
                if v_visited[j]:
                    continue
                h2, d2, r2 = parsed_vids[j]
                if _videos_are_similar(h1, d1, h2, d2, max_dist):
                    v_visited[j] = True
                    cluster.append(r2)
            if len(cluster) > 1:
                v_visited[i] = True
                groups.append(cluster)
                if len(groups) >= limit_groups:
                    break

    return groups