import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT_DIR = Path(__file__).resolve().parents[1]
for sub in ("backend/core", "backend/engines", "backend/routers"):
    p = str(ROOT_DIR / sub)
    if p not in sys.path:
        sys.path.insert(0, p)

import main
import database
import system_router
import gallery_router
import deduplicateur as dedup


class TestApiRoutes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        self.db_path = self.tmp_path / "test_lib.db"
        self.dest_dir = self.tmp_path / "dest"
        self.dest_dir.mkdir(parents=True, exist_ok=True)
        database._INITIALIZED_DBS.clear()

        def _fake_active():
            return self.db_path, self.dest_dir

        self.patchers = [
            patch.object(database, "get_active_db_and_dest", side_effect=_fake_active),
            patch.object(system_router, "get_active_db_and_dest", side_effect=_fake_active),
            patch.object(gallery_router, "get_active_db_and_dest", side_effect=_fake_active),
        ]
        for pt in self.patchers:
            pt.start()

    def tearDown(self):
        for pt in self.patchers:
            pt.stop()
        database._INITIALIZED_DBS.clear()
        self.tmp.cleanup()

    def test_index_template_renders_all_modals_and_scripts(self):
        html = main.templates.get_template("index.html").render()
        for mid in (
            "lightbox-modal",
            "import-wizard-modal",
            "library-modal",
            "merge-lib-modal",
            "manual-face-modal",
            "metadata-modal",
            "studio-modal",
            "album-form-modal",
            "album-delete-modal",
            "album-picker-modal",
        ):
            self.assertIn(mid, html)
        for js in (
            "/static/js/app.js",
            "/static/js/libraries.js",
            "/static/js/import_wizard.js",
            "/static/js/gallery.js",
            "/static/js/ai_views.js",
            "/static/js/studio_exif.js",
        ):
            self.assertIn(js, html)

    def test_stats_and_gallery_items_and_favorites(self):
        img = self.dest_dir / "photo1.jpg"
        img.write_bytes(b"fake-jpg")

        conn = database.get_db()
        conn.execute(
            """
            INSERT INTO processed_files
            (source_path, dest_path, original_dest_path, status, timestamp, file_size, is_duplicate, is_trashed, is_favorite, album_name)
            VALUES (?, ?, ?, 'ok', 1700000000, 8, 0, 0, 0, 'Vacances')
            """,
            ("src_1", str(img), str(img)),
        )
        conn.commit()
        conn.close()

        stats = system_router.api_stats()
        self.assertEqual(stats["indexed"], 1)
        self.assertEqual(stats["favorites"], 0)

        gal = gallery_router.api_gallery_items()
        self.assertEqual(gal["total"], 1)
        self.assertEqual(gal["items"][0]["source_path"], "src_1")

        fav_res = gallery_router.api_toggle_favorite(gallery_router.ToggleFavoritePayload(source_path="src_1"))
        self.assertEqual(fav_res["is_favorite"], 1)
        self.assertEqual(system_router.api_stats()["favorites"], 1)

    def test_duplicates_display_and_dedup_reset(self):
        win_f = self.dest_dir / "win.jpg"
        dup_f = self.dest_dir / "dup.jpg"
        win_f.write_bytes(b"identical")
        dup_f.write_bytes(b"identical")

        conn = database.get_db()
        dedup.upgrade_db(conn)
        dedup.QUARANTINE_DIR = self.dest_dir / "Doublons_Quarantaine"

        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, blake3_hash) VALUES (?, ?, ?, 'ok', 'b3')",
            ("src_win", str(win_f), str(win_f)),
        )
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, blake3_hash) VALUES (?, ?, ?, 'ok', 'b3')",
            ("src_dup", str(dup_f), str(dup_f)),
        )
        conn.commit()

        dedup.merge_metadata_and_clean(
            conn,
            {"source_path": "src_win", "dest_path": str(win_f), "is_favorite": 0, "album_name": None},
            [{"source_path": "src_dup", "dest_path": str(dup_f), "is_favorite": 0, "album_name": None, "dup_type": "BLAKE3"}],
        )
        conn.commit()
        conn.close()

        dups = gallery_router.api_get_duplicates()
        self.assertEqual(len(dups["groups"]), 1)
        self.assertEqual(dups["groups"][0]["master"]["source_path"], "src_win")
        self.assertEqual(dups["groups"][0]["duplicates"][0]["source_path"], "src_dup")

        # Reset DEDUP tool should restore file to original_dest_path and clear duplicate flags
        res = system_router.api_reset_tool(system_router.ResetToolPayload(tool="DEDUP"))
        self.assertEqual(res["status"], "reset")
        self.assertTrue(dup_f.exists())
        self.assertEqual(gallery_router.api_get_duplicates()["groups"], [])

    def test_trash_and_restore(self):
        img = self.dest_dir / "2024" / "photo.jpg"
        img.parent.mkdir(parents=True, exist_ok=True)
        img.write_bytes(b"data")

        conn = database.get_db()
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, file_size) VALUES (?, ?, ?, 'ok', 4)",
            ("src_trash", str(img), str(img)),
        )
        conn.commit()
        conn.close()

        gallery_router.api_trash_action(gallery_router.TrashActionPayload(source_paths=["src_trash"], action="MOVE_TO_TRASH"))
        self.assertFalse(img.exists())
        self.assertEqual(len(gallery_router.api_get_trash_items()["items"]), 1)

        gallery_router.api_trash_action(gallery_router.TrashActionPayload(source_paths=["src_trash"], action="RESTORE"))
        self.assertTrue(img.exists())
        self.assertEqual(len(gallery_router.api_get_trash_items()["items"]), 0)

    def test_albums_subalbums_create_rename_batch_and_delete(self):
        img1 = self.dest_dir / "tokyo.jpg"
        img2 = self.dest_dir / "paris.jpg"
        img1.write_bytes(b"img1")
        img2.write_bytes(b"img2")

        conn = database.get_db()
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, timestamp) VALUES (?, ?, ?, 'ok', 1700000000)",
            ("src_tokyo", str(img1), str(img1)),
        )
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, timestamp) VALUES (?, ?, ?, 'ok', 1700000001)",
            ("src_paris", str(img2), str(img2)),
        )
        conn.commit()
        conn.close()

        # 1. Create parent & sub-album (including empty album support)
        parent = gallery_router.api_create_album(gallery_router.CreateAlbumPayload(name="Voyages"))["album"]
        sub = gallery_router.api_create_album(gallery_router.CreateAlbumPayload(name="Japon", parent_id=parent["album_id"]))["album"]
        self.assertEqual(sub["full_path"], "Voyages/Japon")

        # 2. Add media to sub-album and another album
        gallery_router.api_gallery_batch_action(
            gallery_router.GalleryBatchActionPayload(source_paths=["src_tokyo"], action="ALBUM_ADD", album_name="Voyages/Japon")
        )
        gallery_router.api_gallery_batch_action(
            gallery_router.GalleryBatchActionPayload(source_paths=["src_tokyo"], action="ALBUM_ADD", album_name="Favoris 2024")
        )

        # Exact token match: searching "Voyages" must NOT match "Voyages/Japon" directly
        self.assertEqual(gallery_router.api_gallery_items(album="Voyages")["total"], 0)
        self.assertEqual(gallery_router.api_gallery_items(album="Voyages/Japon")["total"], 1)

        # Overview lists root album with recursive count & subalbums_count
        overview = gallery_router.api_albums_list()
        voyages_item = [a for a in overview["albums"] if a["full_path"] == "Voyages"][0]
        self.assertEqual(voyages_item["subalbums_count"], 1)
        self.assertEqual(voyages_item["count"], 1)

        # 3. Rename parent album -> cascades to sub-album and processed_files
        gallery_router.api_rename_album(gallery_router.RenameAlbumPayload(album_id=parent["album_id"], new_name="Trips"))
        self.assertEqual(gallery_router.api_gallery_items(album="Trips/Japon")["total"], 1)

        # 4. Remove from specific album preserves other albums
        gallery_router.api_gallery_batch_action(
            gallery_router.GalleryBatchActionPayload(source_paths=["src_tokyo"], action="ALBUM_REMOVE", album_name="Trips/Japon")
        )
        self.assertEqual(gallery_router.api_gallery_items(album="Trips/Japon")["total"], 0)
        self.assertEqual(gallery_router.api_gallery_items(album="Favoris 2024")["total"], 1)

        # 5. Delete parent album removes sub-album too without deleting the photo
        gallery_router.api_delete_album(gallery_router.DeleteAlbumPayload(album_id=parent["album_id"], delete_subalbums=True))
        flat = gallery_router.api_albums_list(flat=True)["all_albums"]
        self.assertFalse(any(a["full_path"].startswith("Trips") for a in flat))
        self.assertTrue(img1.exists())

    def test_gallery_sort_options_and_layout_controls(self):
        html = main.templates.get_template("index.html").render()
        for token in (
            'value="modified"', "layout-btn-LIST", "size-btn-SM", "size-btn-MD", "size-btn-LG",
            "gal-options-btn", "alb-options-btn", "albums-options-drawer",
            "alb-sort-by", "alb-sort-order", "alb-layout-btn-GRID", "alb-layout-btn-LIST",
            "alb-size-btn-SM", "alb-size-btn-MD", "alb-size-btn-LG",
        ):
            self.assertIn(token, html)

        conn = database.get_db()
        rows = [
            ("src_b", str(self.dest_dir / "z_folder" / "b_photo.jpg"), 200, 1000),
            ("src_a", str(self.dest_dir / "a_folder" / "a_photo.jpg"), 100, 3000),
            ("src_c", str(self.dest_dir / "m_folder" / "c_photo.jpg"), 300, 2000),
        ]
        for sp, dp, ts, mod_at in rows:
            conn.execute(
                """
                INSERT INTO processed_files
                (source_path, dest_path, original_dest_path, status, timestamp, modified_at, file_size, is_duplicate, is_trashed)
                VALUES (?, ?, ?, 'ok', ?, ?, 10, 0, 0)
                """,
                (sp, dp, dp, ts, mod_at),
            )
        conn.commit()
        conn.close()

        by_name_asc = [i["source_path"] for i in gallery_router.api_gallery_items(sort_by="name", sort_order="asc")["items"]]
        self.assertEqual(by_name_asc, ["src_a", "src_b", "src_c"])

        by_name_desc = [i["source_path"] for i in gallery_router.api_gallery_items(sort_by="name", sort_order="desc")["items"]]
        self.assertEqual(by_name_desc, ["src_c", "src_b", "src_a"])

        by_date_asc = [i["source_path"] for i in gallery_router.api_gallery_items(sort_by="date", sort_order="asc")["items"]]
        self.assertEqual(by_date_asc, ["src_a", "src_b", "src_c"])

        by_mod_desc = [i["source_path"] for i in gallery_router.api_gallery_items(sort_by="modified", sort_order="desc")["items"]]
        self.assertEqual(by_mod_desc, ["src_a", "src_c", "src_b"])

        by_mod_asc = [i["source_path"] for i in gallery_router.api_gallery_items(sort_by="modified", sort_order="asc")["items"]]
        self.assertEqual(by_mod_asc, ["src_b", "src_c", "src_a"])


if __name__ == "__main__":
    unittest.main()
