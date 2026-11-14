import sys
import tempfile
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
for sub in ("backend/core", "backend/engines", "backend/routers"):
    p = str(ROOT_DIR / sub)
    if p not in sys.path:
        sys.path.insert(0, p)

import fusion_takeout_complet as fusion
import deduplicateur as dedup


class TestDeduplicator(unittest.TestCase):
    def test_choose_winner_prefers_resolution_then_size_then_metadata(self):
        group = [
            {"source_path": "a", "dest_path": "/d/a_long_name.jpg", "width": 1920, "height": 1080, "file_size": 1000, "status": "ok", "is_favorite": 0},
            {"source_path": "b", "dest_path": "/d/b.jpg", "width": 3840, "height": 2160, "file_size": 500, "status": "ok", "is_favorite": 0},
            {"source_path": "c", "dest_path": "/d/c.jpg", "width": 1920, "height": 1080, "file_size": 2000, "status": "json_matched", "is_favorite": 1},
        ]
        winner, losers = dedup.choose_winner(group, "BLAKE3")
        self.assertEqual(winner["source_path"], "b")
        self.assertEqual(len(losers), 2)
        self.assertTrue(all(l["dup_type"] == "BLAKE3" for l in losers))

    def test_merge_metadata_and_clean_sets_duplicate_of_and_quarantines(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_p = Path(tmp)
            db_path = tmp_p / "test.db"
            dest_dir = tmp_p / "dest"
            dest_dir.mkdir()
            dedup.QUARANTINE_DIR = dest_dir / "Doublons_Quarantaine"

            win_file = dest_dir / "win.jpg"
            lose_file = dest_dir / "lose.jpg"
            win_file.write_bytes(b"same-bytes")
            lose_file.write_bytes(b"same-bytes")

            conn = fusion.init_db(db_path)
            conn.row_factory = None
            dedup.upgrade_db(conn)
            conn.execute(
                "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, is_favorite, album_name, blake3_hash) VALUES (?, ?, ?, 'ok', 0, 'AlbumA', 'hash1')",
                ("src_win", str(win_file), str(win_file))
            )
            conn.execute(
                "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, is_favorite, album_name, blake3_hash) VALUES (?, ?, ?, 'ok', 1, 'AlbumB', 'hash1')",
                ("src_lose", str(lose_file), str(lose_file))
            )
            conn.commit()

            winner = {"source_path": "src_win", "dest_path": str(win_file), "is_favorite": 0, "album_name": "AlbumA"}
            losers = [{"source_path": "src_lose", "dest_path": str(lose_file), "is_favorite": 1, "album_name": "AlbumB", "dup_type": "BLAKE3"}]

            dedup.merge_metadata_and_clean(conn, winner, losers)
            conn.commit()

            cur = conn.cursor()
            w_row = cur.execute("SELECT is_favorite, album_name, is_duplicate FROM processed_files WHERE source_path='src_win'").fetchone()
            self.assertEqual(w_row[0], 1)
            self.assertEqual(w_row[1], "AlbumA, AlbumB")
            self.assertEqual(w_row[2], 0)

            l_row = cur.execute("SELECT is_duplicate, duplicate_of, master_path, dest_path FROM processed_files WHERE source_path='src_lose'").fetchone()
            self.assertEqual(l_row[0], 1)
            self.assertEqual(l_row[1], "src_win")
            self.assertEqual(l_row[2], str(win_file))
            self.assertFalse(lose_file.exists())
            self.assertTrue(Path(l_row[3]).exists())
            conn.close()


if __name__ == "__main__":
    unittest.main()
