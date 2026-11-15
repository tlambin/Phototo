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
import search_map_router
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
            patch.object(search_map_router, "get_active_db_and_dest", side_effect=_fake_active),
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

    def test_gallery_period_filter(self):
        from datetime import datetime
        p_before = self.dest_dir / "before.jpg"
        p_in = self.dest_dir / "in_period.jpg"
        v_in = self.dest_dir / "in_period.mp4"
        p_after = self.dest_dir / "after.jpg"
        for f in (p_before, p_in, v_in, p_after):
            f.write_bytes(b"data")

        ts_before = int(datetime(2025, 8, 31, 23, 59, 0).timestamp())
        ts_in_1 = int(datetime(2025, 9, 1, 0, 0, 0).timestamp())
        ts_in_2 = int(datetime(2025, 9, 15, 23, 59, 59).timestamp())
        ts_after = int(datetime(2025, 9, 16, 0, 0, 0).timestamp())

        conn = database.get_db()
        for src, dst, ts in [
            ("src_before", p_before, ts_before),
            ("src_in_photo", p_in, ts_in_1),
            ("src_in_video", v_in, ts_in_2),
            ("src_after", p_after, ts_after),
        ]:
            conn.execute(
                "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, timestamp, is_duplicate, is_trashed) VALUES (?, ?, ?, 'ok', ?, 0, 0)",
                (src, str(dst), str(dst), ts),
            )
        conn.commit()
        conn.close()

        gal = gallery_router.api_gallery_items(date_from="2025-09-01", date_to="2025-09-15")
        self.assertEqual(gal["total"], 2)
        returned = {it["source_path"] for it in gal["items"]}
        self.assertEqual(returned, {"src_in_photo", "src_in_video"})

        gal_multi_periods = gallery_router.api_gallery_items(periods="2025-08-31:2025-08-31,2025-09-16:2025-09-16")
        self.assertEqual({it["source_path"] for it in gal_multi_periods["items"]}, {"src_before", "src_after"})

        gal_multi_ext = gallery_router.api_gallery_items(ext_filter=".mp4", periods="2025-09-01:2025-09-15")
        self.assertEqual({it["source_path"] for it in gal_multi_ext["items"]}, {"src_in_video"})

    def test_search_without_ai_embeddings(self):
        from datetime import datetime
        import search_map_router

        p1 = self.dest_dir / "IMG_vacances_plage.jpg"
        p2 = self.dest_dir / "portrait.jpg"
        p3 = self.dest_dir / "tour_eiffel.jpg"
        for f in (p1, p2, p3):
            f.write_bytes(b"data")

        ts_sep = int(datetime(2025, 9, 10, 12, 0, 0).timestamp())
        ts_jan = int(datetime(2024, 1, 5, 12, 0, 0).timestamp())

        conn = database.get_db()
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, timestamp, is_duplicate, is_trashed) VALUES (?, ?, ?, 'ok', ?, 0, 0)",
            ("s1", str(p1), str(p1), ts_sep),
        )
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, timestamp, is_duplicate, is_trashed) VALUES (?, ?, ?, 'ok', ?, 0, 0)",
            ("s2", str(p2), str(p2), ts_jan),
        )
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, timestamp, latitude, longitude, is_duplicate, is_trashed) VALUES (?, ?, ?, 'ok', ?, 48.8584, 2.2945, 0, 0)",
            ("s3", str(p3), str(p3), ts_jan),
        )
        conn.execute("INSERT INTO persons (person_id, name) VALUES (1, 'Thomas')")
        conn.execute("INSERT INTO faces (source_path, dest_path, person_id) VALUES ('s2', ?, 1)", (str(p2),))
        conn.commit()
        conn.close()

        self.assertEqual({r["source_path"] for r in search_map_router.api_semantic_search("vacances")["results"]}, {"s1"})
        self.assertEqual({r["source_path"] for r in search_map_router.api_semantic_search("septembre 2025")["results"]}, {"s1"})
        self.assertEqual({r["source_path"] for r in search_map_router.api_semantic_search("Thomas")["results"]}, {"s2"})
        self.assertEqual({r["source_path"] for r in search_map_router.api_semantic_search("paris")["results"]}, {"s3"})

    def test_smart_categories_and_animated_summary(self):
        img = self.dest_dir / "photo.jpg"
        gif = self.dest_dir / "anim.gif"
        apng = self.dest_dir / "anim.apng"
        webp_anim = self.dest_dir / "anim.webp"
        motion_jpg = self.dest_dir / "motion.jpg"
        live_jpg = self.dest_dir / "IMG_100.jpg"
        live_mov = self.dest_dir / "IMG_100.mov"
        vid = self.dest_dir / "clip.mp4"

        img.write_bytes(b"plain-jpeg")
        gif.write_bytes(b"GIF89a")
        apng.write_bytes(b"apng-data")
        webp_anim.write_bytes(b"RIFF\x00\x00\x00\x00WEBPVP8XANIM")
        motion_jpg.write_bytes(b"\xff\xd8\xff\xe1GCamera:MotionPhoto=\"1\"")
        live_jpg.write_bytes(b"live-still")
        live_mov.write_bytes(b"live-mov")
        vid.write_bytes(b"mp4-data")

        conn = database.get_db()
        for src, dst in [
            ("sp1", img), ("sp2", gif), ("sp3", apng), ("sp4", webp_anim),
            ("sp5", motion_jpg), ("sp6", live_jpg), ("sp7", live_mov), ("sp8", vid),
        ]:
            conn.execute(
                "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, timestamp, file_size, is_duplicate, is_trashed) VALUES (?, ?, ?, 'ok', 1700000000, 100, 0, 0)",
                (src, str(dst), str(dst)),
            )
        conn.commit()
        conn.close()

        summary = gallery_router.api_types_summary()
        self.assertEqual(summary["categories"]["PHOTOS"]["count"], 1)
        self.assertEqual(summary["categories"]["ANIMATED"]["count"], 5)
        self.assertEqual(summary["categories"]["VIDEOS"]["count"], 2)

        anim_items = gallery_router.api_gallery_items(media_type="ANIMATED")
        self.assertEqual({it["source_path"] for it in anim_items["items"]}, {"sp2", "sp3", "sp4", "sp5", "sp6"})

        cats = gallery_router.api_categories_list()["categories"]
        self.assertEqual(cats, [])

        created = gallery_router.api_categories_create(gallery_router.SmartCategoryCreatePayload(name="Chats", prompt="chat"))
        cid = created["category_id"]
        gallery_router.api_categories_assign(gallery_router.SmartCategoryAssignPayload(category_id=cid, source_paths=["sp1"], action="ADD"))
        items = gallery_router.api_categories_items(cid)
        self.assertEqual(items["total"], 1)
        self.assertEqual(items["items"][0]["source_path"], "sp1")

        gallery_router.api_categories_delete(gallery_router.SmartCategoryDeletePayload(category_id=cid))
        cats_after = gallery_router.api_categories_list()["categories"]
        self.assertFalse(any(c["category_id"] == cid for c in cats_after))

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

    def test_settings_sections_and_ai_status_endpoint(self):
        html = main.templates.get_template("index.html").render()
        for token in ("settings-ai-section", "ai-modules-list", "ai-task-log-box", "hardware-specs-box", "gpu-btn-auto", "ai-check-updates-btn"):
            self.assertIn(token, html)

        hw = system_router.api_get_hardware()
        self.assertIn("hardware", hw)
        self.assertIn("runtime", hw)
        self.assertGreaterEqual(hw["hardware"]["cpu_cores"], 1)
        self.assertIn(hw["hardware"]["recommended_mode"], ("cuda", "directml", "intel", "cpu"))
        self.assertIn("recommended_workers", hw["hardware"])

        st = system_router.api_ai_status()
        self.assertIn("modules", st)
        self.assertEqual([m["id"] for m in st["modules"]], ["faces", "clip", "ocr"])
        for m in st["modules"]:
            self.assertIn(m["status"], ("ready", "partial", "not_installed"))
            self.assertIn("packages", m)
            self.assertIn("cache_size_mb", m)
        ocr_mod = [m for m in st["modules"] if m["id"] == "ocr"][0]
        self.assertEqual([e["id"] for e in ocr_mod["ocr_engines"]], ["rapidocr", "easyocr", "paddleocr"])
        faces_mod = [m for m in st["modules"] if m["id"] == "faces"][0]
        self.assertEqual([e["id"] for e in faces_mod["model_options"]], ["buffalo_s", "buffalo_l", "antelopev2"])
        clip_mod = [m for m in st["modules"] if m["id"] == "clip"][0]
        self.assertEqual([e["id"] for e in clip_mod["model_options"]], ["vit-b-32", "vit-b-16", "vit-l-14"])

        with unittest.mock.patch.object(system_router, "_fetch_pypi_latest_version", return_value="99.0.0"):
            upd = system_router.api_ai_check_updates()
            self.assertTrue(upd["network_ok"])
            self.assertIn("updates", upd)
            self.assertGreaterEqual(upd["total_updates"], 1)

        with self.assertRaises(system_router.HTTPException):
            system_router.api_ai_action(system_router.AiActionPayload(module="invalid", action="verify"))
        with self.assertRaises(system_router.HTTPException):
            system_router.api_ai_action(system_router.AiActionPayload(module="faces", action="invalid"))

    def test_inspect_metadata_with_binary_clip_embedding(self):
        from fastapi.encoders import jsonable_encoder
        import metadata_studio_router

        img = self.dest_dir / "analyzed.jpg"
        img.write_bytes(b"fake-jpg")
        conn = database.get_db()
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, timestamp, file_size, clip_embedding, clip_scanned, is_duplicate, is_trashed) VALUES (?, ?, ?, 'ok', 1700000000, 8, ?, 1, 0, 0)",
            ("src_analyzed", str(img), str(img), b"\xff\xfe\x80\x00\x9a\xbc"),
        )
        conn.commit()
        conn.close()

        res = metadata_studio_router.api_inspect_metadata("src_analyzed")
        encoded = jsonable_encoder(res)
        self.assertEqual(encoded["source_path"], "src_analyzed")
        self.assertNotIn("clip_embedding", encoded)


    def test_analyze_single_media_faces_detects_and_rescans(self):
        import numpy as np
        from PIL import Image
        import metadata_studio_router
        import settings_manager

        img_path = self.dest_dir / "face_test.jpg"
        Image.new("RGB", (320, 320), color=(200, 180, 160)).save(img_path, format="JPEG")

        conn = database.get_db()
        conn.execute(
            """
            INSERT INTO processed_files (source_path, dest_path, timestamp, faces_scanned)
            VALUES (?, ?, ?, ?)
            """,
            (str(img_path), str(img_path), 1700000000, 1),
        )
        conn.commit()
        conn.close()

        class _FakeFace:
            def __init__(self):
                self.bbox = np.array([40, 40, 180, 180], dtype=np.float32)
                self.det_score = 0.96
                vec = np.ones(512, dtype=np.float32)
                self.normed_embedding = vec / np.linalg.norm(vec)

        class _FakeFaceAnalysis:
            def __init__(self, **kwargs):
                pass

            def prepare(self, **kwargs):
                pass

            def get(self, img):
                return [_FakeFace()]

        with patch.object(metadata_studio_router, "get_active_db_and_dest", return_value=(self.db_path, self.dest_dir)), \
             patch.object(settings_manager, "get_hardware_runtime_config", return_value={"onnx_providers": ["CPUExecutionProvider"], "onnx_ctx_id": -1}), \
             patch("insightface.app.FaceAnalysis", _FakeFaceAnalysis):
            res = metadata_studio_router.api_analyze_single_media(
                metadata_studio_router.AnalyzeSingleMediaPayload(
                    source_path=str(img_path),
                    run_faces=True,
                    run_visual=False,
                )
            )

        self.assertEqual(res["status"], "ok")
        self.assertIsNone(res["faces_error"])
        self.assertEqual(len(res["faces"]), 1)
        self.assertIsNotNone(res["faces"][0]["person_id"])
        self.assertTrue(Path(res["faces"][0]["thumb_path"]).exists())

    def test_analyze_single_media_visual_uses_en_prompts_and_handles_dim_mismatch(self):
        import numpy as np
        from PIL import Image
        import metadata_studio_router
        import settings_manager
        import indexeur_semantique_gps as clip_gps_ai

        img_path = self.dest_dir / "visual_test.jpg"
        Image.new("RGB", (240, 240), color=(90, 140, 200)).save(img_path, format="JPEG")

        # Stocke un ancien embedding 512d incompatible avec vit-l-14 (768d)
        stale_512 = np.ones(512, dtype=np.float16).tobytes()
        conn = database.get_db()
        clip_gps_ai.upgrade_db_for_clip_and_gps(conn)
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, timestamp, clip_embedding, clip_scanned) VALUES (?, ?, ?, ?, 1)",
            (str(img_path), str(img_path), 1700000000, stale_512),
        )
        conn.commit()
        conn.close()

        captured_prompts = []

        class _FakeVision:
            def encode(self, items, **kwargs):
                vec = np.zeros(768, dtype=np.float32)
                vec[0] = 1.0
                return np.tile(vec, (len(items), 1))

        class _FakeText:
            def encode(self, prompts, **kwargs):
                captured_prompts.extend(prompts)
                out = np.zeros((len(prompts), 768), dtype=np.float32)
                for idx, p in enumerate(prompts):
                    if "portrait face" in p:
                        out[idx, 0] = 0.21
                    else:
                        out[idx, 0] = 0.05
                    out[idx, 1] = 0.9
                return out

        with patch.object(metadata_studio_router, "get_active_db_and_dest", return_value=(self.db_path, self.dest_dir)), \
             patch.object(settings_manager, "load_settings", return_value={"clip_model": "vit-l-14"}), \
             patch.object(clip_gps_ai, "get_clip_models", return_value=(_FakeVision(), _FakeText())):
            res = metadata_studio_router.api_analyze_single_media(
                metadata_studio_router.AnalyzeSingleMediaPayload(
                    source_path=str(img_path),
                    run_faces=False,
                    run_visual=True,
                )
            )

        self.assertIsNone(res["visual_error"])
        self.assertTrue(any("portrait face" in p for p in captured_prompts))
        self.assertGreaterEqual(len(res["visual_candidates"]), 1)
        self.assertEqual(res["visual_candidates"][0]["name"], "Portraits")
        self.assertTrue(res["visual_candidates"][0]["confident"])

        apply_res = metadata_studio_router.api_apply_media_categories(
            metadata_studio_router.ApplyMediaCategoriesPayload(
                source_path=str(img_path),
                categories=[res["visual_candidates"][0]],
            )
        )
        self.assertEqual(apply_res["status"], "ok")

    def test_custom_french_category_auto_translates_to_english_for_clip(self):
        import numpy as np
        from PIL import Image
        import metadata_studio_router
        import settings_manager
        import indexeur_semantique_gps as clip_gps_ai
        import prompt_translator

        prompt_translator._FR_EN_CACHE.clear()
        created = gallery_router.api_categories_create(
            gallery_router.SmartCategoryCreatePayload(name="Gâteau d'anniversaire", prompt="Gâteau d'anniversaire")
        )
        self.assertEqual(created["status"], "ok")

        conn = database.get_db()
        sc_row = conn.execute("SELECT name, prompt, prompt_en FROM smart_categories WHERE category_id = ?", (created["category_id"],)).fetchone()
        conn.close()
        self.assertIsNotNone(sc_row)
        self.assertEqual(sc_row["name"], "Gâteau d'anniversaire")
        self.assertIn("cake", sc_row["prompt_en"].lower())
        self.assertIn("birthday", sc_row["prompt_en"].lower())

        img_path = self.dest_dir / "cake_test.jpg"
        Image.new("RGB", (200, 200), color=(255, 220, 180)).save(img_path, format="JPEG")
        conn = database.get_db()
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, timestamp) VALUES (?, ?, ?)",
            (str(img_path), str(img_path), 1700000000),
        )
        conn.commit()
        conn.close()

        seen_prompts = []

        class _FakeVision:
            def encode(self, items, **kwargs):
                v = np.zeros(768, dtype=np.float32)
                v[0] = 1.0
                return np.tile(v, (len(items), 1))

        class _FakeText:
            def encode(self, prompts, **kwargs):
                seen_prompts.extend(prompts)
                out = np.zeros((len(prompts), 768), dtype=np.float32)
                for idx, p in enumerate(prompts):
                    if "cake" in p.lower() and "birthday" in p.lower():
                        out[idx, 0] = 0.25
                    else:
                        out[idx, 0] = 0.02
                return out

        with patch.object(metadata_studio_router, "get_active_db_and_dest", return_value=(self.db_path, self.dest_dir)), \
             patch.object(settings_manager, "load_settings", return_value={"clip_model": "vit-l-14"}), \
             patch.object(clip_gps_ai, "get_clip_models", return_value=(_FakeVision(), _FakeText())):
            res = metadata_studio_router.api_analyze_single_media(
                metadata_studio_router.AnalyzeSingleMediaPayload(
                    source_path=str(img_path),
                    run_faces=False,
                    run_visual=True,
                )
            )

        self.assertIsNone(res["visual_error"])
        self.assertEqual(res["visual_candidates"][0]["name"], "Gâteau d'anniversaire")
        self.assertTrue(any("cake" in p.lower() and "birthday" in p.lower() for p in seen_prompts))

    def test_extract_frames_exif_unicode_and_sensitive_second_pass(self):
        import numpy as np
        from PIL import Image
        import metadata_studio_router
        import settings_manager
        from media_frames import extract_analysis_frames

        unicode_img = self.dest_dir / "été_noël_giroudora.jpg"
        im = Image.new("RGB", (400, 200), color=(120, 130, 140))
        exif = im.getexif()
        exif[274] = 6  # Orientation = 6 (rotation 90° CW -> devient 200x400 une fois redressée)
        im.save(unicode_img, format="JPEG", exif=exif)

        frames = extract_analysis_frames(str(unicode_img))
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0].shape[:2], (400, 200))

        conn = database.get_db()
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, timestamp, faces_scanned) VALUES (?, ?, ?, 0)",
            (str(unicode_img), str(unicode_img), 1700000000),
        )
        conn.commit()
        conn.close()

        prepare_calls = []

        class _LowScoreFace:
            def __init__(self):
                self.bbox = np.array([20, 20, 90, 90], dtype=np.float32)
                self.det_score = 0.40
                v = np.ones(512, dtype=np.float32)
                self.normed_embedding = v / np.linalg.norm(v)

        class _TwoPassFaceAnalysis:
            def __init__(self, **kwargs):
                self.det_size = (640, 640)

            def prepare(self, **kwargs):
                self.det_size = kwargs.get("det_size", (640, 640))
                prepare_calls.append((self.det_size, kwargs.get("det_thresh")))

            def get(self, img):
                if self.det_size == (1024, 1024):
                    return [_LowScoreFace()]
                return []

        with patch.object(metadata_studio_router, "get_active_db_and_dest", return_value=(self.db_path, self.dest_dir)), \
             patch.object(settings_manager, "get_hardware_runtime_config", return_value={"onnx_providers": ["CPUExecutionProvider"], "onnx_ctx_id": -1}), \
             patch("insightface.app.FaceAnalysis", _TwoPassFaceAnalysis):
            res = metadata_studio_router.api_analyze_single_media(
                metadata_studio_router.AnalyzeSingleMediaPayload(
                    source_path=str(unicode_img),
                    run_faces=True,
                    run_visual=False,
                )
            )

        self.assertIsNone(res["faces_error"])
        self.assertEqual(len(res["faces"]), 1)
        self.assertEqual(len(prepare_calls), 2)
        self.assertEqual(prepare_calls[1][0], (1024, 1024))

    def test_resolve_nested_antelopev2_layout_and_nonempty_bare_assertion_error(self):
        import indexeur_visages as faces_ai
        import metadata_studio_router
        import settings_manager
        from PIL import Image

        fake_root = self.tmp_path / ".insightface"
        nested = fake_root / "models" / "antelopev2" / "antelopev2"
        nested.mkdir(parents=True, exist_ok=True)
        (nested / "scrfd_10g_bnkps.onnx").write_bytes(b"det")
        (nested / "glintr100.onnx").write_bytes(b"rec")

        resolved = faces_ai.resolve_insightface_model_arg("antelopev2", root=fake_root)
        self.assertEqual(resolved, "antelopev2")
        self.assertTrue((fake_root / "models" / "antelopev2" / "scrfd_10g_bnkps.onnx").exists())
        self.assertFalse(nested.exists())

        img_path = self.dest_dir / "err_check.jpg"
        Image.new("RGB", (120, 120), color=(10, 20, 30)).save(img_path, format="JPEG")
        conn = database.get_db()
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, timestamp) VALUES (?, ?, ?)",
            (str(img_path), str(img_path), 1700000000),
        )
        conn.commit()
        conn.close()

        class _BrokenFA:
            def __init__(self, **kwargs):
                raise AssertionError()

        with patch.object(metadata_studio_router, "get_active_db_and_dest", return_value=(self.db_path, self.dest_dir)), \
             patch.object(settings_manager, "get_hardware_runtime_config", return_value={"onnx_providers": ["CPUExecutionProvider"], "onnx_ctx_id": -1}), \
             patch("insightface.app.FaceAnalysis", _BrokenFA):
            res = metadata_studio_router.api_analyze_single_media(
                metadata_studio_router.AnalyzeSingleMediaPayload(source_path=str(img_path), run_faces=True, run_visual=False)
            )
        self.assertEqual(res["faces_error"], "AssertionError")

    def test_paddle_ocr_v3_and_v2_output_parsing(self):
        import indexeur_ocr as ocr_ai

        class _V3Engine:
            def predict(self, img):
                return [{"rec_texts": ["FACTURE", "2026"], "rec_scores": [0.98, 0.95]}]

        class _V2Engine:
            def ocr(self, img):
                return [[[[[0, 0], [10, 0], [10, 10], [0, 10]], ("BONJOUR", 0.91)]]]

        self.assertEqual(
            ocr_ai.run_paddle_ocr_image(_V3Engine(), None),
            [("FACTURE", 0.98), ("2026", 0.95)],
        )
        self.assertEqual(
            ocr_ai.run_paddle_ocr_image(_V2Engine(), None),
            [("BONJOUR", 0.91)],
        )

    def test_model_mismatch_detection_and_selective_reindex(self):
        import numpy as np
        import indexeur_semantique_gps as clip_gps_ai

        conn = database.get_db()
        clip_gps_ai.upgrade_db_for_clip_and_gps(conn)
        emb512 = np.ones(512, dtype=np.float16).tobytes()
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, timestamp, clip_scanned, clip_embedding, clip_model, faces_scanned, faces_model) VALUES (?, ?, ?, 1, ?, 'vit-b-32', 1, 'buffalo_l')",
            ("s1.jpg", "d1.jpg", 1700000000, emb512),
        )
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, timestamp, clip_scanned, clip_embedding, clip_model, faces_scanned, faces_model) VALUES (?, ?, ?, 1, ?, 'vit-l-14', 1, 'antelopev2')",
            ("s2.jpg", "d2.jpg", 1700000001, np.ones(768, dtype=np.float16).tobytes()),
        )
        conn.commit()
        conn.close()

        mm_clip = system_router.api_ai_model_mismatch("clip", "vit-l-14", prev_model="vit-b-32")
        self.assertEqual(mm_clip["stale_count"], 1)

        mm_faces = system_router.api_ai_model_mismatch("faces", "antelopev2", prev_model="buffalo_l")
        self.assertEqual(mm_faces["stale_count"], 1)

        with patch.object(system_router, "_active_clip_model", return_value="vit-l-14"), \
             patch.object(system_router, "start_specific_task", return_value={"status": "started", "task": "CLIP"}) as mock_start:
            res = system_router.api_ai_reindex_model(system_router.ReindexModelPayload(module_id="clip", include_unknown=False))
            self.assertEqual(res["task"], "CLIP")
            mock_start.assert_called_once_with("CLIP")

        conn = database.get_db()
        rows = {r["source_path"]: dict(r) for r in conn.execute("SELECT source_path, clip_scanned, clip_model FROM processed_files").fetchall()}
        conn.close()
        self.assertEqual(rows["s1.jpg"]["clip_scanned"], 0)
        self.assertIsNone(rows["s1.jpg"]["clip_model"])
        self.assertEqual(rows["s2.jpg"]["clip_scanned"], 1)
        self.assertEqual(rows["s2.jpg"]["clip_model"], "vit-l-14")

    def test_faces_reindex_preserves_named_persons_and_manual_faces(self):
        import numpy as np
        import indexeur_visages as faces_ai

        conn = database.get_db()
        faces_ai.init_face_tables(conn)
        emb_old = np.ones(512, dtype=np.float32).tobytes()
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, timestamp, faces_scanned, faces_model) VALUES ('p1.jpg', 'd1.jpg', 1700000000, 1, 'buffalo_l')"
        )
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, timestamp, faces_scanned, faces_model) VALUES ('p2.jpg', 'd2.jpg', 1700000001, 1, 'buffalo_l')"
        )
        cur = conn.cursor()
        cur.execute("INSERT INTO persons (name, face_count) VALUES ('Thomas', 1)")
        pid_thomas = cur.lastrowid
        cur.execute("INSERT INTO persons (name, face_count) VALUES ('Marie', 1)")
        pid_marie = cur.lastrowid
        cur.execute(
            "INSERT INTO faces (source_path, dest_path, timestamp, bbox, det_score, embedding, person_id) VALUES ('p1.jpg', 'd1.jpg', 1700000000, '50,50,180,180', 0.95, ?, ?)",
            (emb_old, pid_thomas),
        )
        cur.execute(
            "INSERT INTO faces (source_path, dest_path, timestamp, bbox, det_score, embedding, person_id) VALUES ('p2.jpg', 'd2.jpg', 1700000001, '10,10,90,90', 1.0, NULL, ?)",
            (pid_marie,),
        )
        conn.commit()
        conn.close()

        with patch.object(system_router, "start_specific_task", return_value={"status": "started", "task": "FACES"}):
            res = system_router.api_ai_reindex_model(system_router.ReindexModelPayload(module_id="faces"))
        self.assertEqual(res["task"], "FACES")

        conn = database.get_db()
        # Le visage manuel de Marie (embedding NULL) est préservé, Thomas est dans face_name_hints
        manual_left = conn.execute("SELECT COUNT(*) FROM faces WHERE embedding IS NULL").fetchone()[0]
        self.assertEqual(manual_left, 1)
        hints = conn.execute("SELECT source_path, person_name FROM face_name_hints").fetchall()
        self.assertEqual([(h[0], h[1]) for h in hints], [("p1.jpg", "Thomas")])

        # Simulation de re-détection avec un nouveau modèle sur p1.jpg et p2.jpg (légèrement décalé)
        v1 = np.zeros(512, dtype=np.float32); v1[0] = 1.0
        v2 = np.zeros(512, dtype=np.float32); v2[1] = 1.0
        conn.execute(
            "INSERT INTO faces (source_path, dest_path, timestamp, bbox, det_score, embedding) VALUES ('p1.jpg', 'd1.jpg', 1700000000, '54,52,184,182', 0.92, ?)",
            (v1.tobytes(),),
        )
        conn.execute(
            "INSERT INTO faces (source_path, dest_path, timestamp, bbox, det_score, embedding) VALUES ('p2.jpg', 'd2.jpg', 1700000001, '200,200,280,280', 0.90, ?)",
            (v2.tobytes(),),
        )
        conn.commit()

        restored = faces_ai.apply_face_name_hints(conn)
        self.assertEqual(restored, 1)
        faces_ai.run_face_clustering(conn)

        names_by_src = {
            r[0]: r[1]
            for r in conn.execute(
                "SELECT f.source_path, p.name FROM faces f JOIN persons p ON f.person_id = p.person_id WHERE f.embedding IS NOT NULL"
            ).fetchall()
        }
        marie_cnt = conn.execute("SELECT COUNT(*) FROM persons WHERE name = 'Marie'").fetchone()[0]
        conn.close()
        self.assertEqual(names_by_src.get("p1.jpg"), "Thomas")
        self.assertEqual(marie_cnt, 1)

    def test_lightbox_faces_and_categories_editor_routes_and_ui(self):
        import types
        import cv2
        import numpy as np
        import indexeur_visages as faces_ai
        import indexeur_semantique_gps as clip_gps_ai
        import metadata_studio_router

        html = main.templates.get_template("index.html").render()
        for snippet in (
            "lb-faces-edit-modal",
            "openLightboxFacesEditor()",
            "openLightboxCategoriesEditor()",
            "Refaire l'analyse",
        ):
            self.assertIn(snippet, html)

        gallery_js = (ROOT_DIR / "frontend" / "static" / "js" / "gallery.js").read_text(encoding="utf-8")
        for js_fn in (
            "function openLightboxSmartCategory(",
            "function openLightboxCategoriesEditor(",
            "async function openLightboxFacesEditor(",
            "async function rerunLightboxFacesAnalysis(",
        ):
            self.assertIn(js_fn, gallery_js)

        img_path = self.dest_dir / "photo.jpg"
        cv2.imwrite(str(img_path), np.full((240, 240, 3), 128, dtype=np.uint8))

        conn = database.get_db()
        try:
            faces_ai.init_face_tables(conn)
            clip_gps_ai.upgrade_db_for_clip_and_gps(conn)
            emb_old = np.ones(512, dtype=np.float32)
            emb_old = emb_old / np.linalg.norm(emb_old)

            conn.execute(
                "INSERT INTO processed_files (source_path, dest_path, timestamp, faces_scanned, faces_model) VALUES (?, ?, ?, 1, 'buffalo_l')",
                ("p_lb.jpg", "photo.jpg", 1700000100),
            )
            cur = conn.cursor()
            cur.execute("INSERT INTO persons (name, face_count) VALUES ('Thomas', 1)")
            pid_thomas = cur.lastrowid
            cur.execute("INSERT INTO persons (name, face_count) VALUES ('Marie', 1)")
            pid_marie = cur.lastrowid
            cur.execute(
                "INSERT INTO faces (source_path, dest_path, timestamp, bbox, det_score, embedding, person_id) VALUES (?, ?, 1700000100, '10,10,80,80', 1.0, NULL, ?)",
                ("p_lb.jpg", "photo.jpg", pid_marie),
            )
            cur.execute(
                "INSERT INTO faces (source_path, dest_path, timestamp, bbox, det_score, embedding, person_id) VALUES (?, ?, 1700000100, '120,40,200,120', 0.95, ?, ?)",
                ("p_lb.jpg", "photo.jpg", emb_old.astype(np.float32).tobytes(), pid_thomas),
            )
            conn.commit()
        finally:
            conn.close()

        emb_new = np.zeros(512, dtype=np.float32)
        emb_new[0] = 1.0
        fake_faces = [
            types.SimpleNamespace(bbox=np.array([12, 12, 82, 82]), det_score=0.98, normed_embedding=emb_new),
            types.SimpleNamespace(bbox=np.array([122, 42, 202, 122]), det_score=0.94, normed_embedding=emb_new),
        ]
        fake_app = types.SimpleNamespace(get=lambda _img: fake_faces, prepare=lambda **_kw: None)

        class _FakeTextModel:
            def encode(self, prompts, **_kw):
                out = np.zeros((len(prompts), 512), dtype=np.float32)
                out[:, 0] = 1.0
                return out

        class _FakeVisionModel:
            def encode(self, frames, **_kw):
                out = np.zeros((len(frames), 512), dtype=np.float32)
                out[:, 0] = 1.0
                return out

        with patch.object(metadata_studio_router, "get_active_db_and_dest", return_value=(self.db_path, self.dest_dir)), \
             patch.object(metadata_studio_router, "resolve_actual_path", return_value=img_path), \
             patch.object(faces_ai, "create_face_analysis", return_value=fake_app), \
             patch.object(faces_ai, "save_face_thumbnail", return_value="thumb_test.jpg"), \
             patch.object(clip_gps_ai, "get_clip_models", return_value=(_FakeVisionModel(), _FakeTextModel())):
            res = metadata_studio_router.api_analyze_single_media(
                metadata_studio_router.AnalyzeSingleMediaPayload(
                    source_path="p_lb.jpg",
                    run_faces=True,
                    run_visual=True,
                    force_faces=True,
                )
            )

        self.assertIsNone(res["faces_error"])
        self.assertIsNone(res["visual_error"])
        self.assertGreater(len(res["visual_candidates"]), 0)

        face_names = sorted(f["name"] for f in res["faces"])
        self.assertEqual(face_names, ["Marie", "Thomas"])

        with patch.object(metadata_studio_router, "resolve_actual_path", return_value=img_path):
            inspected = metadata_studio_router.api_inspect_metadata(source_path="p_lb.jpg")
        self.assertGreater(len(inspected["visual_suggestions"]), 0)
        self.assertEqual(inspected["visual_suggestions"][0]["name"], res["visual_candidates"][0]["name"])

    def test_lightbox_albums_card_and_editor(self):
        import metadata_studio_router

        html = main.templates.get_template("index.html").render()
        for snippet in (
            "lb-info-albums-card",
            "lb-info-albums-list",
            "lb-albums-edit-modal",
            "lb-albums-edit-sort-by",
            "lb-albums-edit-sort-dir-btn",
            "lb-albums-edit-create-toggle",
            "lb-albums-edit-create-box",
            "lb-albums-edit-new-source-wrap",
            "lb-albums-edit-new-source",
            "onInputLightboxAlbumSearch",
            "openLightboxAlbumsEditor()",
        ):
            self.assertIn(snippet, html)
        self.assertNotIn("lb-albums-edit-new-parent", html)
        self.assertNotIn("addLightboxMediaToAlbumFromInput", html)

        gallery_js = (ROOT_DIR / "frontend" / "static" / "js" / "gallery.js").read_text(encoding="utf-8")
        for js_fn in (
            "function _compareAlbumItems(",
            "function onInputLightboxAlbumSearch(",
            "function onChangeLightboxAlbumEditorSortBy(",
            "function toggleLightboxAlbumEditorSortDir(",
            "function toggleLightboxAlbumCreateBox(",
            "function _populateLightboxAlbumCreateSourceSelect(",
            "async function submitLightboxCreateAlbum(",
            "function _renderLightboxAlbumRowHtml(",
            "function toggleLightboxExtraAlbums(",
            "lb-info-albums-extra",
            "function _renderAlbumEditorTreeNodes(",
            "function _renderLightboxSubalbumCreateBoxHtml(",
            "function openLightboxSubalbumCreate(",
            "async function submitLightboxSubalbumCreate(",
            "+ Créer un sous-album",
            "function toggleLightboxEditorSubalbums(",
            "async function setLightboxPrimaryAlbum(",
            "function openLightboxAlbum(",
            "async function openLightboxAlbumsEditor(",
            "async function addLightboxMediaToAlbum(",
            "async function removeLightboxMediaFromAlbum(",
            "async function setLightboxMediaAsAlbumCover(",
        ):
            self.assertIn(js_fn, gallery_js)

        img1 = self.dest_dir / "a1.jpg"
        img2 = self.dest_dir / "a2.jpg"
        img1.write_bytes(b"img1")
        img2.write_bytes(b"img2")

        conn = database.get_db()
        try:
            conn.execute(
                "INSERT INTO processed_files (source_path, dest_path, timestamp) VALUES (?, ?, ?)",
                ("src_a1.jpg", "a1.jpg", 1700000100),
            )
            conn.execute(
                "INSERT INTO processed_files (source_path, dest_path, timestamp) VALUES (?, ?, ?)",
                ("src_a2.jpg", "a2.jpg", 1700000200),
            )
            conn.commit()
        finally:
            conn.close()

        # Ajouter src_a1.jpg à deux albums et définir a2.jpg comme couverture de Voyage
        gallery_router.api_gallery_batch_action(
            gallery_router.GalleryBatchActionPayload(source_paths=["src_a1.jpg"], action="ALBUM_ADD", album_name="Voyage")
        )
        gallery_router.api_gallery_batch_action(
            gallery_router.GalleryBatchActionPayload(source_paths=["src_a1.jpg", "src_a2.jpg"], action="ALBUM_ADD", album_name="Famille")
        )
        albums_res = gallery_router.api_albums_list(flat=True)["all_albums"]
        by_path = {a["full_path"]: a for a in albums_res}
        gallery_router.api_set_album_cover(
            gallery_router.SetAlbumCoverPayload(album_id=by_path["Famille"]["album_id"], cover_path="a2.jpg")
        )

        with patch.object(metadata_studio_router, "resolve_actual_path", return_value=img1):
            inspected = metadata_studio_router.api_inspect_metadata(source_path="src_a1.jpg")
        self.assertEqual([a["name"] for a in inspected["albums"]], ["Voyage", "Famille"])
        albs = {a["name"]: a for a in inspected["albums"]}
        self.assertEqual(albs["Voyage"]["cover_path"], "a1.jpg")
        self.assertEqual(albs["Voyage"]["count"], 1)
        self.assertEqual(albs["Famille"]["cover_path"], "a2.jpg")
        self.assertEqual(albs["Famille"]["count"], 2)

        # Ajout d'un sous-album : conserve l'ordre d'insertion après Famille
        gallery_router.api_gallery_batch_action(
            gallery_router.GalleryBatchActionPayload(source_paths=["src_a1.jpg"], action="ALBUM_ADD", album_name="Voyage/Japon")
        )
        with patch.object(metadata_studio_router, "resolve_actual_path", return_value=img1):
            inspected_sub = metadata_studio_router.api_inspect_metadata(source_path="src_a1.jpg")
        self.assertEqual([a["name"] for a in inspected_sub["albums"]], ["Voyage", "Famille", "Voyage/Japon"])

        # Définir Voyage/Japon comme album prioritaire affiché sur le média
        gallery_router.api_gallery_batch_action(
            gallery_router.GalleryBatchActionPayload(source_paths=["src_a1.jpg"], action="ALBUM_SET_PRIMARY", album_name="Voyage/Japon")
        )
        with patch.object(metadata_studio_router, "resolve_actual_path", return_value=img1):
            inspected_prio = metadata_studio_router.api_inspect_metadata(source_path="src_a1.jpg")
        self.assertEqual([a["name"] for a in inspected_prio["albums"]], ["Voyage/Japon", "Voyage", "Famille"])

        # Retirer src_a1.jpg de Voyage : Voyage n'a plus de média direct, son sous-album Voyage/Japon garde sa couverture explicite a2.jpg
        gallery_router.api_gallery_batch_action(
            gallery_router.GalleryBatchActionPayload(source_paths=["src_a1.jpg"], action="ALBUM_REMOVE", album_name="Voyage")
        )
        gallery_router.api_gallery_batch_action(
            gallery_router.GalleryBatchActionPayload(source_paths=["src_a2.jpg"], action="ALBUM_ADD", album_name="Voyage/Japon")
        )
        sub_row = next(a for a in gallery_router.api_albums_list(flat=True)["all_albums"] if a["full_path"] == "Voyage/Japon")
        gallery_router.api_set_album_cover(
            gallery_router.SetAlbumCoverPayload(album_id=sub_row["album_id"], cover_path="a2.jpg")
        )
        with patch.object(metadata_studio_router, "resolve_actual_path", return_value=img1):
            inspected_sub2 = metadata_studio_router.api_inspect_metadata(source_path="src_a1.jpg")
        sub_entry = next(a for a in inspected_sub2["albums"] if a["name"] == "Voyage/Japon")
        self.assertEqual(sub_entry["cover_path"], "a2.jpg")
        parent_row = next(a for a in gallery_router.api_albums_list(flat=True)["all_albums"] if a["full_path"] == "Voyage")
        self.assertEqual(parent_row["cover_path"], "a2.jpg")

        gallery_router.api_gallery_batch_action(
            gallery_router.GalleryBatchActionPayload(source_paths=["src_a1.jpg"], action="ALBUM_REMOVE", album_name="Voyage/Japon")
        )
        with patch.object(metadata_studio_router, "resolve_actual_path", return_value=img1):
            inspected2 = metadata_studio_router.api_inspect_metadata(source_path="src_a1.jpg")
        self.assertEqual([a["name"] for a in inspected2["albums"]], ["Famille"])

        # Création d'un album racine avec choix du dossier source (multi-sources)
        src1 = self.tmp_path / "src_a"
        src2 = self.tmp_path / "src_b"
        src1.mkdir(parents=True, exist_ok=True)
        src2.mkdir(parents=True, exist_ok=True)
        fake_cfg = {
            "active_library": "TestLib",
            "libraries": {"TestLib": {"source_paths": [str(src1), str(src2)], "dest_dir": str(self.dest_dir)}},
        }
        with patch.object(gallery_router, "load_libraries", return_value=fake_cfg):
            created = gallery_router.api_create_album(
                gallery_router.CreateAlbumPayload(name="MultiSourceRoot", parent_id=None, source_dir=str(src2))
            )
            self.assertEqual(created["album"]["parent_id"], None)
            self.assertEqual(created["album"]["source_dir"], str(src2.resolve()))
            self.assertTrue((src2 / "Albums" / "MultiSourceRoot").is_dir())
            with self.assertRaises(gallery_router.HTTPException):
                gallery_router.api_create_album(
                    gallery_router.CreateAlbumPayload(name="BadSource", parent_id=None, source_dir=str(self.tmp_path / "other"))
                )


if __name__ == "__main__":
    unittest.main()
