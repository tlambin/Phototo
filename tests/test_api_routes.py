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
        for legacy_col in ("#593E5A", "#8B6B8E", "#A385A6"):
            self.assertNotIn(legacy_col, html)

        theme_css = (ROOT_DIR / "frontend" / "static" / "css" / "theme.css").read_text(encoding="utf-8")
        for tok in ("backdrop-filter: blur(", "--btn-bg: #18181B;", "--btn-bg: #FFFFFF;", "--bg-active: #18181B;", "--bg-active: #FFFFFF;", "background: transparent;", ".count-pill:empty", ".sticky-view-header.is-stuck .sticky-hide-on-stuck", ".sticky-options-header.is-stuck"):
            self.assertIn(tok, theme_css)
        self.assertIn('class="sticky-hide-on-stuck flex flex-wrap items-center gap-3"', html)
        self.assertIn('id="gal-total-label" class="count-pill ui-card', html)
        self.assertIn('id="floating-topbar"', html)
        self.assertIn('#floating-topbar::before', theme_css)
        sidebar_start = html.index('id="main-sidebar"')
        sidebar_end = html.index('</aside>', sidebar_start)
        self.assertIn('id="topbar-logo-box"', html[sidebar_start:sidebar_end])

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
            "gal-options-btn", "gal-sort-dir-btn", "gal-sort-arrow", "toggleGallerySortOrder()",
            "alb-options-btn", "albums-options-drawer",
            "alb-sort-by", "alb-sort-order", "alb-sort-dir-btn", "alb-sort-arrow", "toggleAlbumSortOrder()",
            "alb-layout-btn-GRID", "alb-layout-btn-LIST",
            "alb-size-btn-SM", "alb-size-btn-MD", "alb-size-btn-LG",
            "alb-total-label", "alb-active-filter-badge", "alb-new-btn",
            'id="tab-albums" class="hidden pr-3.5"',
            'id="tab-gallery" class="space-y-5 pr-3.5"',
        ):
            self.assertIn(token, html)
        self.assertNotIn('id="gallery-timeline-reserve"', html)
        theme_css_tl = (ROOT_DIR / "frontend" / "static" / "css" / "theme.css").read_text(encoding="utf-8")
        self.assertIn("#gallery-timeline-wrapper:hover #gallery-timeline-box", theme_css_tl)
        self.assertNotIn("timeline-visible", theme_css_tl)
        gallery_js_alb = (ROOT_DIR / "frontend" / "static" / "js" / "gallery.js").read_text(encoding="utf-8")
        self.assertNotIn("pulseGalleryTimelinePeek", gallery_js_alb)
        self.assertIn("bg-rose-500/25 backdrop-blur-md", gallery_js_alb)
        self.assertNotIn("drop-shadow-[0_1px_2px_rgba(0,0,0,0.45)]", gallery_js_alb)
        self.assertIn("#10b981", theme_css_tl)
        self.assertIn("justify-content: space-between;", theme_css_tl)
        self.assertNotIn("justify-content: flex-start;", theme_css_tl)
        self.assertIn("body.has-batch-bar .sticky-options-header.is-stuck", theme_css_tl)
        self.assertIn(".sticky-options-header.is-stuck #gal-filter-popover", theme_css_tl)
        self.assertIn(".sticky-options-header.is-stuck #faces-filter-popover", theme_css_tl)
        for marker_fp in (
            'id="tab-faces" class="hidden pr-3.5"',
            'id="faces-total-label"',
            'id="faces-unknown-count"',
            'id="faces-options-btn"',
            'id="faces-options-drawer"',
            'id="faces-sort-by"',
            'id="faces-sort-order"',
            'id="faces-sort-dir-btn"',
            'id="faces-sort-arrow"',
            "toggleFacesSortOrder()",
            'id="faces-group-by"',
            'id="faces-filter-btn"',
            'id="faces-filter-popover"',
            'id="faces-content-filter"',
            'id="faces-layout-btn-GRID"',
            'id="faces-layout-btn-LIST"',
            'id="faces-size-btn-SM"',
            'id="faces-size-btn-MD"',
            'id="faces-size-btn-LG"',
            'id="faces-active-filter-badge"',
            'value="content"',
            'value="recent"',
            'id="tl-person-count"',
            'id="tab-map" class="hidden pr-3.5"',
            'id="map-add-btn"',
            'id="place-single-panel"',
            'id="settings-home-country"',
        ):
            self.assertIn(marker_fp, html)
        ai_views_js = (ROOT_DIR / "frontend" / "static" / "js" / "ai_views.js").read_text(encoding="utf-8")
        app_js_fp = (ROOT_DIR / "frontend" / "static" / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn("function toggleFacesOptionsBar(", app_js_fp)
        self.assertIn("function toggleFacesSortOrder(", ai_views_js)
        self.assertIn("function _comparePersonItems(", ai_views_js)
        self.assertIn("function _filterPersonsList(", ai_views_js)
        self.assertIn("function setFacesLayout(", ai_views_js)
        self.assertIn("function setFacesSize(", ai_views_js)
        self.assertIn("person-card", ai_views_js)
        self.assertIn("place-card", ai_views_js)
        self.assertIn("openSinglePlaceView", ai_views_js)
        self.assertIn("function togglePersonFaceEditMode(", ai_views_js)
        self.assertIn("appendMediaBatchToContainer('tl-faces-grid', items, 0, true)", ai_views_js)
        self.assertIn("rounded-[18px]", ai_views_js)
        self.assertIn("rounded-[24px]", ai_views_js)
        self.assertIn("lg:grid-cols-10", html)
        self.assertIn('id="btn-toggle-person-face-edit"', html)
        self.assertNotIn("w-32 h-32 rounded-full", ai_views_js)
        self.assertIn("rounded-[24px]", gallery_js_alb)
        self.assertIn("album-card", gallery_js_alb)
        self.assertIn("else if (currentTab === 'gallery' || currentTab === 'favorites' || currentTab === 'recent') loadGalleryItems(true);", gallery_js_alb)
        self.assertNotIn(">✎</button>", gallery_js_alb)
        self.assertNotIn("<option value=\"desc\">Décroissant</option>", html)
        self.assertNotIn("<option value=\"asc\">Croissant</option>", html)

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
        import settings_manager
        import fusion_takeout_complet as fusion

        html = main.templates.get_template("index.html").render()
        for token in (
            "settings-ai-section", "ai-modules-list", "ai-task-log-box",
            "hardware-specs-box", "gpu-btn-auto", "ai-check-updates-btn",
            "settings-takeout-section", "settings-takeout-arch",
            "settings-takeout-gps-tz", "settings-takeout-fix-meta",
            "settings-takeout-del-zips", "settings-takeout-dir",
            "settings-exiftool-row", "settings-exiftool-badge", "settings-exiftool-install-btn",
            "loadExifToolStatus(true)", "installExifToolNow(false)",
            "settings-ffmpeg-row", "settings-ffmpeg-badge", "settings-ffmpeg-install-btn",
            "loadFFmpegStatus(true)", "installFFmpegNow(false)",
            "browseTakeoutExtractDir()", "clearTakeoutExtractDir()",
            "settings-power-bar", "restartApplication()", "shutdownApplication()",
        ):
            self.assertIn(token, html)

        tab_settings_html = html[html.index('id="tab-settings"'):html.index('id="tab-activities"')]
        self.assertNotIn("sticky-view-header", tab_settings_html)
        self.assertIn("settings-power-bar", tab_settings_html)
        theme_css = (ROOT_DIR / "frontend" / "static" / "css" / "theme.css").read_text(encoding="utf-8")
        self.assertIn("#settings-power-bar.is-floating", theme_css)

        app_js = (ROOT_DIR / "frontend" / "static" / "js" / "app.js").read_text(encoding="utf-8")
        for tok in ("window.appSettings", "browseTakeoutExtractDir", "clearTakeoutExtractDir", "takeout_default_architecture", "_syncSettingsPowerBar"):
            self.assertIn(tok, app_js)

        tmp_settings = self.tmp_path / "app_settings.json"
        with patch.object(settings_manager, "SETTINGS_FILE", tmp_settings), \
             patch.object(settings_manager, "LEGACY_SETTINGS_FILE", self.tmp_path / "legacy_settings.json"):
            save_res = system_router.api_save_settings_route(system_router.SettingsPayload(
                scanned_folders=[],
                takeout_extract_dir="D:/FastBuffer",
                takeout_default_architecture="GOOGLE_ALBUM",
                takeout_default_fix_metadata=False,
                takeout_default_delete_zips=True,
                takeout_timezone_mode="SETTINGS_ONLY",
                takeout_use_gps_timezone=False,
                timezone="Europe/Paris",
                language="fr",
                gpu_mode="auto",
            ))
            saved = save_res["settings"]
            self.assertEqual(saved["takeout_default_architecture"], "GOOGLE_ALBUM")
            self.assertFalse(saved["takeout_default_fix_metadata"])
            self.assertTrue(saved["takeout_default_delete_zips"])
            self.assertEqual(saved["takeout_timezone_mode"], "SETTINGS_ONLY")
            self.assertFalse(saved["takeout_use_gps_timezone"])
            self.assertEqual(saved["takeout_extract_dir"], "D:/FastBuffer")

            # Mode SETTINGS_ONLY avec GPS à Tokyo (35.6762, 139.6503) -> force Europe/Paris (+01:00)
            res_forced = fusion.resolve_datetime_with_dst(1705320000, 35.6762, 139.6503)
            self.assertEqual(res_forced["offset_str"], "+01:00")

            # Mode UTC -> garde l'heure UTC (+00:00) même avec GPS à Tokyo
            system_router.api_save_settings_route(system_router.SettingsPayload(
                scanned_folders=[],
                takeout_extract_dir="",
                takeout_timezone_mode="UTC",
                timezone="Europe/Paris",
                language="fr",
                gpu_mode="auto",
            ))
            res_utc = fusion.resolve_datetime_with_dst(1705320000, 35.6762, 139.6503)
            self.assertEqual(res_utc["offset_str"], "+00:00")
            self.assertEqual(res_utc["exif_local_str"], "2024:01:15 12:00:00")

            # Mode GPS_OR_SETTINGS -> utilise le GPS si présent, sinon le fuseau des paramètres
            system_router.api_save_settings_route(system_router.SettingsPayload(
                scanned_folders=[],
                takeout_extract_dir="",
                takeout_timezone_mode="GPS_OR_SETTINGS",
                timezone="Europe/Paris",
                language="fr",
                gpu_mode="auto",
            ))
            res_gps = fusion.resolve_datetime_with_dst(1705320000, 35.6762, 139.6503)
            self.assertEqual(res_gps["offset_str"], "+09:00")
            res_no_gps = fusion.resolve_datetime_with_dst(1705320000, None, None)
            self.assertEqual(res_no_gps["offset_str"], "+01:00")

        exif_st = system_router.api_exiftool_status()
        self.assertIn("installed", exif_st)
        self.assertIn("pyexiftool_installed", exif_st)
        self.assertIn("version", exif_st)
        self.assertIn("path", exif_st)
        if exif_st["installed"]:
            self.assertTrue(exif_st["version"])

        # _copy_exiftool_tree_to_root refuse un shim WinGet sans dossier exiftool_files
        shim_dir = self.tmp_path / "shim"
        shim_dir.mkdir(parents=True, exist_ok=True)
        shim_exe = shim_dir / "exiftool.exe"
        shim_exe.write_bytes(b"stub" * 100)
        root_out = self.tmp_path / "root_et"
        root_out.mkdir(parents=True, exist_ok=True)
        self.assertFalse(system_router._copy_exiftool_tree_to_root(shim_exe, root_out))

        # Mais accepte un vrai arbre ExifTool avec dossier exiftool_files
        (shim_dir / "exiftool_files").mkdir()
        (shim_dir / "exiftool_files" / "perl.exe").write_bytes(b"perl")
        self.assertTrue(system_router._copy_exiftool_tree_to_root(shim_exe, root_out))
        self.assertTrue((root_out / "exiftool.exe").exists())
        self.assertTrue((root_out / "exiftool_files" / "perl.exe").exists())

        # _find_exiftool_executable privilégie le binaire qui répond à -ver (et rejette une erreur texte)
        bad_exe = self.tmp_path / "bad_et.exe"
        good_exe = self.tmp_path / "good_et.exe"
        bad_exe.write_bytes(b"x")
        good_exe.write_bytes(b"x")
        with patch.object(system_router, "_exiftool_candidate_paths", return_value=[bad_exe, good_exe]), \
             patch.object(system_router, "_probe_exiftool_version", side_effect=[(None, "Application version 13.61 does not match Image::ExifTool library version 13.59"), ("13.64", None)]):
            found_p, found_v, found_err = system_router._find_exiftool_executable()
            self.assertEqual(found_p, good_exe)
            self.assertEqual(found_v, "13.64")
            self.assertIsNone(found_err)

        # Un message texte sur -ver ne doit pas être pris pour un numéro de version valide
        with patch.object(system_router.subprocess, "check_output", return_value="Application version 13.61 does not match Image::ExifTool library version 13.59"):
            ver_bad, err_bad = system_router._probe_exiftool_version(bad_exe)
            self.assertIsNone(ver_bad)
            self.assertIn("does not match", err_bad)

        # Vérification des mises à jour ExifTool (13.61 -> 13.64)
        with patch.object(system_router, "_find_exiftool_executable", return_value=(good_exe, "13.61", None)), \
             patch.object(system_router, "_fetch_exiftool_latest_version", return_value="13.64"):
            upd_st = system_router.api_exiftool_status(check_update=True)
            self.assertTrue(upd_st["installed"])
            self.assertEqual(upd_st["latest_version"], "13.64")
            self.assertTrue(upd_st["update_available"])

        with patch.object(system_router, "_find_exiftool_executable", return_value=(good_exe, "13.64", None)), \
             patch.object(system_router, "_fetch_exiftool_latest_version", return_value="13.64"):
            ok_st = system_router.api_exiftool_status(check_update=True)
            self.assertFalse(ok_st["update_available"])

        # _scrape_exiftool_page_zips résout les liens relatifs vers les archives 64-bit
        class _FakeResp:
            def __init__(self, body: bytes):
                self._b = body
            def read(self):
                return self._b
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False

        with patch.object(system_router.urllib.request, "urlopen", return_value=_FakeResp(b'<a href="exiftool-13.64_64.zip">DL</a>')):
            scraped = system_router._scrape_exiftool_page_zips("https://exiftool.org/")
            self.assertEqual(scraped, ["https://exiftool.org/exiftool-13.64_64.zip"])

        # RapidOCR et Faces préservent onnxruntime-gpu (utilisation de --no-deps sans écraser la DLL chargée)
        cmds_seen = []

        def _fake_cmd(cmd):
            cmds_seen.append(cmd)
            return 0

        def _fake_pkg_ver(name):
            return {"onnxruntime-gpu": "1.20.0", "rapidocr-onnxruntime": None}.get(name)

        with patch.object(system_router, "_active_ocr_engine", return_value="rapidocr"), \
             patch.object(system_router, "_pkg_version", side_effect=_fake_pkg_ver), \
             patch.object(system_router, "_install_missing_pip_deps", return_value=True), \
             patch.object(system_router, "detect_system_hardware", return_value={"gpu_vendor": "nvidia", "recommended_mode": "cuda"}), \
             patch.object(system_router, "_run_cmd_logged", side_effect=_fake_cmd):
            ok_rapid = system_router._install_or_update_single_module("ocr", upgrade=False, gpu_mode="auto")
            self.assertTrue(ok_rapid)
            pip_cmds = [c for c in cmds_seen if len(c) >= 4 and c[1:4] == ["-m", "pip", "install"]]
            self.assertEqual(len(pip_cmds), 1)
            self.assertIn("--no-deps", pip_cmds[0])
            self.assertIn("rapidocr-onnxruntime", pip_cmds[0])

        # FFmpeg status / probe / update check
        ff_st = system_router.api_ffmpeg_status()
        self.assertIn("installed", ff_st)
        self.assertIn("version", ff_st)
        self.assertIn("path", ff_st)

        fake_ff = self.tmp_path / "ffmpeg.exe"
        fake_ff.write_bytes(b"ff")
        with patch.object(system_router.subprocess, "check_output", return_value="ffmpeg version 7.1-essentials_build-www.gyan.dev Copyright (c) 2000-2024"):
            ff_ver, ff_err = system_router._probe_ffmpeg_version(fake_ff)
            self.assertEqual(ff_ver, "7.1")
            self.assertIsNone(ff_err)

        with patch.object(system_router, "_find_ffmpeg_executable", return_value=(fake_ff, "7.1", None)), \
             patch.object(system_router, "_fetch_ffmpeg_latest_version", return_value="8.0"):
            ff_upd = system_router.api_ffmpeg_status(check_update=True)
            self.assertTrue(ff_upd["update_available"])
            self.assertEqual(ff_upd["latest_version"], "8.0")

        # Priorité au sous-dossier tools/ dans les candidats
        et_cands = system_router._exiftool_candidate_paths()
        ff_cands = system_router._ffmpeg_candidate_paths()
        self.assertEqual(et_cands[0], system_router._get_tools_dir() / "exiftool.exe")
        self.assertEqual(ff_cands[0], system_router._get_tools_dir() / "ffmpeg.exe")

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
        marie_row = conn.execute("SELECT person_id FROM persons WHERE name = 'Marie'").fetchone()
        marie_cnt = conn.execute("SELECT COUNT(*) FROM persons WHERE name = 'Marie'").fetchone()[0]
        conn.close()
        self.assertEqual(names_by_src.get("p1.jpg"), "Thomas")
        self.assertEqual(marie_cnt, 1)

        import faces_router
        tl = faces_router.api_person_timeline(marie_row[0])
        self.assertIn("items", tl)
        self.assertEqual(len(tl["items"]), 1)
        self.assertEqual(tl["items"][0]["source_path"], "p2.jpg")

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
            "lb-btn-close",
            "lb-btn-edit",
            "lb-btn-delete",
            "hover:bg-rose-500/20 hover:text-rose-400",
            "hover:text-orange-300",
            "hover:text-emerald-300",
            "hover:text-rose-400",
            "hover:text-purple-300",
            "hover:text-sky-300",
            "hover:text-amber-300",
            "lb-center-pill",
            "lb-btn-add-album",
            '<polyline points="14.5 18 8.5 12 14.5 6"/>',
            '<polyline points="9.5 18 15.5 12 9.5 6"/>',
            '<rect x="3" y="6" width="14" height="14" rx="2.5"/>',
            '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
            'ondblclick="if(event.target===this) closeLightbox()"',
            "openLightboxFacesEditor()",
            "openLightboxCategoriesEditor()",
            "openLightboxLocationEditor()",
            "lightboxOpenMetadataEditor()",
            "lb-info-map-card",
            "lb-location-edit-modal",
            'id="lb-filmstrip" class="hidden bg-white/10 backdrop-blur-md rounded-xl',
            "Refaire l'analyse",
        ):
            self.assertIn(snippet, html)
        self.assertNotIn("sticky bottom-1 z-20", html)
        self.assertNotIn('onclick="if(event.target===this) closeLightbox()"', html)
        self.assertGreater(html.index('id="lb-info-analyze-btn"'), html.index('id="lb-info-note"'))
        self.assertLess(html.index("lightboxOpenStudio()"), html.index("lightboxDeleteMedia()"))
        self.assertLess(html.index("lightboxDeleteMedia()"), html.index("lightboxDownloadMedia()"))
        self.assertLess(html.index("lightboxToggleFavorite()"), html.index("lightboxAddToAlbum()"))
        self.assertLess(html.index("lightboxAddToAlbum()"), html.index("lightboxShareMedia()"))
        self.assertLess(html.index("lightboxShareMedia()"), html.index("toggleLightboxInfoDrawer()"))

        gallery_js = (ROOT_DIR / "frontend" / "static" / "js" / "gallery.js").read_text(encoding="utf-8")
        for js_fn in (
            "function openLightboxSmartCategory(",
            "function openLightboxCategoriesEditor(",
            "async function openLightboxFacesEditor(",
            "function startLightboxFaceNameEdit(",
            "function cancelLightboxFaceNameEdit(",
            "async function submitLightboxFaceNameEdit(",
            "Cliquer pour nommer ce visage",
            "Modifier le nom",
            "lb-faces-persons-datalist",
            "async function rerunLightboxFacesAnalysis(",
            "function syncLightboxInfoButtonState(",
            "icon.setAttribute('fill', '#fb7185')",
            "function openBatchTrashConfirm(",
            "async function downloadGalleryBatch(",
            "async function shareGalleryBatch(",
            "function handleLightboxFilmstripWheel(",
            "function handleLightboxWheel(",
            "function updateLightboxEditButton(",
            "async function openLightboxLocationEditor(",
            "function closeLightboxLocationEditor(",
            "async function searchLightboxLocationPlace(",
            "async function saveLightboxLocationEdit(",
            "async function clearLightboxLocationEdit(",
            "_LB_EDIT_PHOTO_SVG",
            "_LB_EDIT_VIDEO_SVG",
            "strip.scrollLeft += delta",
        ):
            self.assertIn(js_fn, gallery_js)
        self.assertNotIn("analyzeBtn.classList.toggle('hidden'", gallery_js)

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
        self.assertIn("person_thumb_path", inspected["faces"][0])
        self.assertIn("person_thumb_path", gallery_js)
        self.assertIn("const uniquePeople = [];", gallery_js)

        import faces_router
        conn = database.get_db()
        try:
            marie_row = conn.execute("SELECT person_id FROM persons WHERE name = 'Marie'").fetchone()
            thomas_row = conn.execute("SELECT person_id FROM persons WHERE name = 'Thomas'").fetchone()
            self.assertIsNotNone(marie_row)
            self.assertIsNotNone(thomas_row)
            rename_res = faces_router.api_rename_person(
                faces_router.RenamePersonPayload(person_id=marie_row["person_id"], new_name="thomas")
            )
            self.assertEqual(rename_res["status"], "merged")
            self.assertEqual(rename_res["person_id"], thomas_row["person_id"])
            persons_left = conn.execute("SELECT COUNT(*) FROM persons WHERE LOWER(name) = 'thomas'").fetchone()[0]
            self.assertEqual(persons_left, 1)
        finally:
            conn.close()

        persons_list = faces_router.api_get_persons()["persons"]
        thomas_entry = next(p for p in persons_list if p["name"] == "Thomas")
        self.assertEqual(thomas_entry["face_count"], 2)
        self.assertEqual(thomas_entry["media_count"], 1)
        self.assertIn("recent_ts", thomas_entry)
        self.assertIn("added_ts", thomas_entry)
        self.assertIn("max_face_id", thomas_entry)
        ai_views_js_lb = (ROOT_DIR / "frontend" / "static" / "js" / "ai_views.js").read_text(encoding="utf-8")
        self.assertIn("p.media_count", ai_views_js_lb)

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
            '<div class="text-sm font-bold">Ajouter à un album</div>',
            '<div class="text-[11px] font-bold text-white/70">Mes albums</div>',
        ):
            self.assertIn(snippet, html)
        self.assertNotIn('<div class="text-sm font-bold">Modifier les albums</div>', html)
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
            "async function lightboxAddToAlbum() {\n    await openLightboxAlbumsEditor();",
            "async function addLightboxMediaToAlbum(",
            "async function removeLightboxMediaFromAlbum(",
            "async function setLightboxMediaAsAlbumCover(",
            "Ajouter à un album",
        ):
            self.assertIn(js_fn, gallery_js)
        self.assertNotIn("Aucun album • Ajouter...", gallery_js)
        self.assertIn("needsInspect", gallery_js)

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

    def test_reverse_geocode_city_display_and_cache(self):
        import search_map_router
        import metadata_studio_router

        with patch.object(search_map_router, "_fetch_nominatim_city", return_value=("Lyon", "France", "Lyon, France")) as mock_nom:
            first = search_map_router.api_reverse_geocode(45.7640, 4.8357)
            self.assertEqual(first["city"], "Lyon")
            self.assertEqual(first["label"], "Lyon, France")
            self.assertFalse(first["cached"])
            self.assertEqual(mock_nom.call_count, 1)

            second = search_map_router.api_reverse_geocode(45.7641, 4.8358)
            self.assertEqual(second["city"], "Lyon")
            self.assertTrue(second["cached"])
            self.assertEqual(mock_nom.call_count, 1)

        with patch.object(search_map_router, "_fetch_nominatim_city", side_effect=RuntimeError("offline")):
            offline_paris = search_map_router.api_reverse_geocode(48.8566, 2.3522)
            self.assertEqual(offline_paris["city"], "Paris")
            offline_unknown = search_map_router.api_reverse_geocode(0.5, 0.5)
            self.assertEqual(offline_unknown["city"], "")
            self.assertEqual(offline_unknown["label"], "Lieu inconnu")

        conn = database.get_db()
        try:
            conn.execute(
                "INSERT INTO processed_files (source_path, dest_path, timestamp, latitude, longitude) VALUES (?, ?, ?, ?, ?)",
                ("src_geo.jpg", "geo.jpg", 1700000200, 45.7640, 4.8357),
            )
            conn.commit()
        finally:
            conn.close()

        with patch.object(metadata_studio_router, "resolve_actual_path", return_value=None):
            inspected = metadata_studio_router.api_inspect_metadata(source_path="src_geo.jpg")
        self.assertEqual(inspected["location_city"], "Lyon")
        self.assertEqual(inspected["location_label"], "Lyon, France")

        gallery_js = (ROOT_DIR / "frontend" / "static" / "js" / "gallery.js").read_text(encoding="utf-8")
        self.assertIn("resolveLightboxPlaceCity", gallery_js)
        self.assertNotIn("`${lat.toFixed(3)}, ${lon.toFixed(3)}`", gallery_js)
        ai_views_js = (ROOT_DIR / "frontend" / "static" / "js" / "ai_views.js").read_text(encoding="utf-8")
        self.assertNotIn("Zone (${key})", ai_views_js)

        # Vérification pays d'origine vs étranger (région + pays à côté de la ville)
        with (
            patch.object(search_map_router, "load_settings", return_value={"home_country": "France"}),
            patch.object(search_map_router, "_fetch_nominatim_city", return_value=("Rome", "Latium", "Italie", "Rome, Italie")),
        ):
            foreign = search_map_router.api_reverse_geocode(41.9028, 12.4964)
        self.assertTrue(foreign["is_foreign"])
        self.assertEqual(foreign["city"], "Rome")
        self.assertEqual(foreign["region"], "Latium")
        self.assertEqual(foreign["country"], "Italie")
        self.assertEqual(foreign["place_subtitle"], "Latium, Italie")
        self.assertEqual(foreign["place_title"], "Rome · Latium, Italie")

        with patch.object(search_map_router, "load_settings", return_value={"home_country": "France"}):
            domestic = search_map_router.api_reverse_geocode(45.7640, 4.8357)
        self.assertFalse(domestic["is_foreign"])
        self.assertEqual(domestic["place_subtitle"], "")

    def test_lightbox_location_editor_ui_and_gps_update(self):
        import metadata_studio_router
        from unittest.mock import MagicMock

        html = (ROOT_DIR / "frontend" / "templates" / "components" / "modals" / "lightbox_modal.html").read_text(encoding="utf-8")
        self.assertIn('id="lb-location-edit-modal"', html)
        self.assertIn('id="lb-location-picker-map"', html)
        self.assertIn('onclick="openLightboxLocationEditor()"', html)
        self.assertIn('onclick="saveLightboxLocationEdit()"', html)
        self.assertIn('onclick="clearLightboxLocationEdit()"', html)

        img_file = self.dest_dir / "loc_photo.jpg"
        img_file.write_bytes(b"fakejpg")
        conn = database.get_db()
        try:
            conn.execute(
                "INSERT INTO processed_files (source_path, dest_path, timestamp, latitude, longitude) VALUES (?, ?, ?, ?, ?)",
                ("src_loc.jpg", str(img_file), 1700000300, 0.0, 0.0),
            )
            conn.commit()
        finally:
            conn.close()

        fake_et = MagicMock()
        fake_et_cm = MagicMock()
        fake_et_cm.__enter__.return_value = fake_et
        fake_et_cm.__exit__.return_value = False

        with patch.object(metadata_studio_router.exiftool, "ExifToolHelper", return_value=fake_et_cm):
            upd = metadata_studio_router.api_batch_update_metadata(
                metadata_studio_router.BatchMetadataUpdatePayload(
                    source_paths=["src_loc.jpg"],
                    latitude=45.764,
                    longitude=4.8357,
                )
            )
            self.assertEqual(upd["status"], "updated")

            conn = database.get_db()
            try:
                row = conn.execute(
                    "SELECT latitude, longitude, timestamp FROM processed_files WHERE source_path=?",
                    ("src_loc.jpg",),
                ).fetchone()
                self.assertAlmostEqual(row["latitude"], 45.764, places=4)
                self.assertAlmostEqual(row["longitude"], 4.8357, places=4)
                self.assertEqual(row["timestamp"], 1700000300)
            finally:
                conn.close()

            stripped = metadata_studio_router.api_batch_strip_metadata(
                metadata_studio_router.BatchMetadataStripPayload(
                    source_paths=["src_loc.jpg"],
                    strip_gps=True,
                    strip_all_exif=False,
                )
            )
            self.assertEqual(stripped["status"], "stripped")

            conn = database.get_db()
            try:
                row = conn.execute(
                    "SELECT latitude, longitude FROM processed_files WHERE source_path=?",
                    ("src_loc.jpg",),
                ).fetchone()
                self.assertEqual(row["latitude"], 0.0)
                self.assertEqual(row["longitude"], 0.0)
            finally:
                conn.close()

    def test_gallery_batch_bar_actions_and_batch_download(self):
        import zipfile

        html = main.templates.get_template("index.html").render()
        batch_start = html.index('id="gal-batch-bar"')
        batch_end = html.index('id="tab-gallery"', batch_start)
        batch_html = html[batch_start:batch_end]
        for snippet in (
            "runGalleryBatch('FAVORITE_ADD')",
            "openBatchAlbumsEditor()",
            "shareGalleryBatch()",
            "downloadGalleryBatch()",
            "openBatchAnalyzeModal()",
            "gal-batch-analyze-btn",
            "openMetadataModalForSelection()",
            "runGalleryBatch('TRASH')",
            "hover:text-rose-400",
            "hover:text-purple-300",
            "hover:text-sky-300",
            "hover:text-emerald-300",
            "Analyser les médias",
            "hover:text-orange-300",
            "hover:bg-rose-500/20 hover:text-rose-400",
        ):
            self.assertIn(snippet, batch_html)

        self.assertIn('id="lb-analyze-modal" class="hidden fixed inset-0 z-[60]', html)
        gallery_js = (ROOT_DIR / "frontend" / "static" / "js" / "gallery.js").read_text(encoding="utf-8")
        app_js = (ROOT_DIR / "frontend" / "static" / "js" / "app.js").read_text(encoding="utf-8")
        theme_css = (ROOT_DIR / "frontend" / "static" / "css" / "theme.css").read_text(encoding="utf-8")
        self.assertIn("function openBatchAnalyzeModal(", gallery_js)
        self.assertIn("async function _runBatchMediaAnalysis(", gallery_js)
        self.assertIn("function syncBatchBarBounds(", gallery_js)
        self.assertIn("syncBatchBarBounds();", app_js)
        self.assertIn(".sticky-options-header {\n  z-index: 28;", theme_css)
        self.assertIn("bottom-5", batch_html)
        self.assertIn("bottom: 1.25rem;", theme_css)

        dir_a = self.dest_dir / "a"
        dir_b = self.dest_dir / "b"
        dir_a.mkdir(parents=True, exist_ok=True)
        dir_b.mkdir(parents=True, exist_ok=True)
        f1 = dir_a / "dupname.jpg"
        f2 = dir_b / "dupname.jpg"
        f1.write_bytes(b"img-one")
        f2.write_bytes(b"img-two")

        conn = database.get_db()
        try:
            conn.execute(
                "INSERT INTO processed_files (source_path, dest_path, status, is_duplicate, is_trashed) VALUES (?, ?, 'ok', 0, 0)",
                ("src_dl_1", str(f1)),
            )
            conn.execute(
                "INSERT INTO processed_files (source_path, dest_path, status, is_duplicate, is_trashed) VALUES (?, ?, 'ok', 0, 0)",
                ("src_dl_2", str(f2)),
            )
            conn.commit()
        finally:
            conn.close()

        single_resp = gallery_router.api_gallery_batch_download(
            gallery_router.GalleryBatchDownloadPayload(source_paths=["src_dl_1"])
        )
        self.assertEqual(Path(single_resp.path), f1)
        self.assertEqual(single_resp.filename, "dupname.jpg")

        zip_resp = gallery_router.api_gallery_batch_download(
            gallery_router.GalleryBatchDownloadPayload(source_paths=["src_dl_1", "src_dl_2"])
        )
        self.assertEqual(zip_resp.media_type, "application/zip")
        self.assertEqual(zip_resp.filename, "phototo_selection.zip")
        zip_path = Path(zip_resp.path)
        try:
            with zipfile.ZipFile(zip_path, "r") as zf:
                names = zf.namelist()
                self.assertEqual(sorted(names), ["dupname (1).jpg", "dupname.jpg"])
                self.assertEqual(zf.read("dupname.jpg"), b"img-one")
                self.assertEqual(zf.read("dupname (1).jpg"), b"img-two")
        finally:
            zip_path.unlink(missing_ok=True)

    def test_navbar_activity_notifications_and_library_avatar(self):
        import library_manager
        import libraries_router

        html = main.templates.get_template("index.html").render()
        top_start = html.index('id="floating-topbar"')
        top_end = html.index('</header>', top_start)
        top_html = html[top_start:top_end]
        for snippet in (
            'id="activity-notif-pill"',
            'id="activity-status-btn"',
            'id="activity-status-text"',
            'id="notif-bell-btn"',
            'id="lib-avatar-btn"',
            'id="lib-avatar-letter"',
            'id="lib-avatar-img"',
            'id="lib-menu-popover"',
            'id="lib-pop-avatar-letter"',
            'id="lib-icon-file-input"',
            "toggleTaskPopover(event)",
            "toggleNotificationsPopover(event)",
            "toggleLibMenuPopover(event)",
        ):
            self.assertIn(snippet, top_html)
        self.assertIn('id="activity-status-btn" type="button" onclick="toggleTaskPopover(event)"', top_html)
        self.assertLess(top_html.index('id="activity-status-btn"'), top_html.index('id="notif-bell-btn"'))
        self.assertLess(top_html.index('id="notif-bell-btn"'), top_html.index('id="lib-avatar-btn"'))
        self.assertNotIn('id="lib-name-btn"', top_html)
        self.assertNotIn('id="task-pulse-btn"', top_html)
        self.assertNotIn("Pas d'activité en cours", top_html)
        self.assertNotIn("plum-btn w-12 h-12 rounded-2xl", top_html)
        self.assertNotIn("plum-btn w-10 h-10 rounded-2xl", top_html)
        for modern_tok in (
            "Créer une bibliothèque",
            "Modifier la bibliothèque",
            "Fusionner des bibliothèques",
            'id="label-pause-pipe"',
            'id="btn-console-pipe"',
            'id="btn-clear-all-notifs"',
            'id="btn-clear-all-activities"',
            'hover:text-amber-500',
            'hover:text-sky-500',
            'hover:text-rose-500',
            'id="pipe-bar" class="h-full bg-emerald-500',
            "Fichiers traités",
            "Imports &amp; Médias",
            "Analyses IA &amp; Détections",
            "Journal des actions",
            'id="btn-export-activities"',
            'id="activities-confirm-clear-modal"',
            'id="btn-recent-activities"',
            "Ajoutés récemment",
            'id="btn-scan-activities"',
            "<span>Analyser</span>",
        ):
            self.assertIn(modern_tok, html)
        sidebar_html = (ROOT_DIR / "frontend" / "templates" / "components" / "sidebar.html").read_text(encoding="utf-8")
        self.assertNotIn('id="tab-btn-recent"', sidebar_html)
        self.assertNotIn('sidebar-glass-panel', sidebar_html)
        self.assertIn('id="sidebar-header"', sidebar_html)
        self.assertNotIn('sidebar-header-glass', sidebar_html)
        self.assertIn('id="topbar-logo-box"', sidebar_html)
        self.assertIn('ui-card', sidebar_html[sidebar_html.index('id="topbar-logo-box"'):sidebar_html.index('id="topbar-logo-text"')])
        theme_css = (ROOT_DIR / "frontend" / "static" / "css" / "theme.css").read_text(encoding="utf-8")
        self.assertNotIn('.sidebar-glass-panel', theme_css)
        self.assertNotIn('.sidebar-header-glass', theme_css)
        self.assertIn('#sidebar-header::before', theme_css)
        self.assertIn('position: fixed;\n  left: 0;\n  right: 6px;\n  bottom: 0;', theme_css)
        self.assertNotIn('border-bottom: 1px solid var(--border-subtle)', theme_css)
        self.assertLess(html.index('Activités</h1>'), html.index('id="btn-recent-activities"'))
        self.assertLess(html.index('id="btn-recent-activities"'), html.index('id="activities-current-section"'))
        self.assertNotIn('id="activities-current-heading"', html)
        self.assertLess(html.index('id="activities-current-section"'), html.index('>Historique</h2>'))
        self.assertLess(html.index('>Historique</h2>'), html.index('id="activities-full-list"'))
        self.assertIn('id="lib-create-avatar-letter"', html)
        self.assertIn('id="lib-create-avatar-img"', html)
        self.assertIn('id="lib-create-icon-file-input"', html)
        self.assertIn('id="lib-edit-avatar-letter"', html)
        self.assertIn('id="lib-edit-avatar-img"', html)
        self.assertIn('id="lib-edit-name-display"', html)
        self.assertIn('id="lib-edit-name-btn"', html)
        self.assertIn('id="lib-edit-name-editor"', html)

        libraries_js = (ROOT_DIR / "frontend" / "static" / "js" / "libraries.js").read_text(encoding="utf-8")
        app_js = (ROOT_DIR / "frontend" / "static" / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn("function syncActiveLibraryAvatars(", libraries_js)
        self.assertIn("function toggleEditLibraryNameInput(", libraries_js)
        self.assertIn("async function uploadActiveLibraryIcon(", libraries_js)
        self.assertIn("hasActivityBanner", app_js)
        self.assertIn("function renderCurrentOrPendingActivity(", app_js)
        self.assertIn("function _findActivePausedActivityFromHistory(", app_js)
        self.assertIn("async function discardPausedActivity(", app_js)
        self.assertNotIn("_findPendingResumableActivity", app_js)
        self.assertIn("async function deleteNotification(", app_js)
        self.assertIn("async function clearAllNotifications(", app_js)

        # Suppression unitaire et globale des notifications côté backend
        import pipeline_runner
        with pipeline_runner.STATE._lock:
            saved_notifs = list(pipeline_runner.STATE.notifications)
            pipeline_runner.STATE.notifications.clear()
        try:
            pipeline_runner.STATE.add_notification("Tâche 1", "success", "OK 1")
            pipeline_runner.STATE.add_notification("Tâche 2", "error", "Err 2")
            all_notifs = pipeline_runner.STATE.notifications
            self.assertEqual(len(all_notifs), 2)
            self.assertNotEqual(all_notifs[0]["id"], all_notifs[1]["id"])
            id_to_remove = all_notifs[1]["id"]
            del_one = system_router.api_delete_notification(id_to_remove)
            self.assertEqual(len(del_one["notifications"]), 1)
            self.assertEqual(del_one["notifications"][0]["title"], "Tâche 2")
            del_all = system_router.api_delete_all_notifications()
            self.assertEqual(del_all["notifications"], [])
            self.assertEqual(len(pipeline_runner.STATE.notifications), 0)
        finally:
            with pipeline_runner.STATE._lock:
                pipeline_runner.STATE.notifications = saved_notifs

        # La décompression et le suivi console reçoivent le nom du fichier courant
        import zipfile
        test_zip = self.tmp_path / "sample.zip"
        with zipfile.ZipFile(test_zip, "w") as zf:
            zf.writestr("Takeout/2025/vacances.jpg", b"img-bytes")
        seen_labels = []
        _, ok_z, cnt_z, _ = pipeline_runner.extract_zip_interruptible(
            test_zip,
            self.tmp_path / "buf",
            lambda sz, c, lbl="": seen_labels.append(lbl),
        )
        self.assertTrue(ok_z)
        self.assertEqual(cnt_z, 1)
        self.assertEqual(seen_labels, ["sample.zip -> vacances.jpg"])

        # Historique persistant des activités (UNZIP + METADATA avec fichiers en échec + raisons + suppression)
        for fn_act in (
            "async function loadActivitiesHistory(",
            "function renderActivitiesHistory(",
            "function toggleActivityFailedFiles(",
            "async function deleteActivityEntry(",
            "async function confirmClearAllActivities(",
            "Voir les fichiers non traités",
        ):
            self.assertIn(fn_act, app_js)

        issue_err = pipeline_runner._collect_ingestion_issue(
            ("/src/bad.jpg", None, None, "error", None, None, 0, 0, 0, None, 0.0, 0.0, 0, None, "Disque plein")
        )
        self.assertEqual(issue_err["name"], "bad.jpg")
        self.assertEqual(issue_err["reason"], "Disque plein")
        issue_nometa = pipeline_runner._collect_ingestion_issue(
            ("/src/nodate.jpg", "/dst/nodate.jpg", "/dst/nodate.jpg", "no_metadata", None, None, 0, 0, 0, None, 0.0, 0.0, 0, None, None)
        )
        self.assertIn("Métadonnées", issue_nometa["reason"])

        with pipeline_runner.STATE._lock:
            saved_n2 = list(pipeline_runner.STATE.notifications)
            pipeline_runner.STATE.notifications.clear()
        try:
            database.get_db().close()
            import time as _time
            from datetime import datetime as _dt
            t0 = _time.time() - 3.5
            iso0 = _dt.now().isoformat(timespec="seconds")
            pipeline_runner._record_step_activity(
                self.db_path, "MaLib", "UNZIP", "Décompression Google Takeout",
                t0, iso0, 42, 42, [],
            )
            pipeline_runner._record_step_activity(
                self.db_path, "MaLib", "METADATA", "Correction des métadonnées Takeout",
                t0, iso0, 10, 8, [issue_err, issue_nometa],
            )
            acts = system_router.api_list_activities()["activities"]
            self.assertEqual(len(acts), 2)
            self.assertEqual(acts[0]["action_type"], "METADATA")
            self.assertEqual(acts[0]["status"], "partial")
            self.assertEqual(acts[0]["failed_count"], 2)
            self.assertEqual(len(acts[0]["failed_files"]), 2)
            self.assertEqual(acts[0]["failed_files"][0]["reason"], "Disque plein")
            self.assertGreater(acts[0]["duration_sec"], 0.0)
            self.assertEqual(acts[1]["action_type"], "UNZIP")
            self.assertEqual(acts[1]["status"], "success")
            self.assertIn("Décompression terminée avec succès", acts[1]["detail"])
            # Les notifications associées ont aussi été émises en direct
            self.assertEqual(len(pipeline_runner.STATE.notifications), 2)

            # Suppression unitaire puis suppression totale
            rem_acts = system_router.api_delete_activity(acts[0]["activity_id"])["activities"]
            self.assertEqual(len(rem_acts), 1)
            self.assertEqual(rem_acts[0]["action_type"], "UNZIP")
            cleared_acts = system_router.api_clear_activities()["activities"]
            self.assertEqual(cleared_acts, [])

            # Traçabilité des actions utilisateur (favoris, albums, renommage, corbeille)
            import metadata_studio_router
            self.assertIn("function toggleActivityFiles(", app_js)
            self.assertIn("Voir les fichiers (", app_js)

            p_user = self.dest_dir / "act_photo.jpg"
            p_user.write_bytes(b"img")
            conn_u = database.get_db()
            try:
                conn_u.execute(
                    "INSERT INTO processed_files (source_path, dest_path, status, is_duplicate, is_trashed, is_favorite) VALUES (?, ?, 'ok', 0, 0, 0)",
                    (str(p_user), str(p_user)),
                )
                conn_u.commit()
            finally:
                conn_u.close()

            gallery_router.api_toggle_favorite(gallery_router.ToggleFavoritePayload(source_path=str(p_user)))
            gallery_router.api_gallery_batch_action(
                gallery_router.GalleryBatchActionPayload(source_paths=[str(p_user)], action="ALBUM_ADD", album_name="Vacances")
            )
            with patch.object(metadata_studio_router, "resolve_actual_path", return_value=p_user):
                metadata_studio_router.api_rename_media(
                    metadata_studio_router.RenameMediaPayload(source_path=str(p_user), new_name="act_renamed.jpg")
                )
            gallery_router.api_trash_action(
                gallery_router.TrashActionPayload(source_paths=[str(p_user)], action="MOVE_TO_TRASH")
            )
            user_acts = system_router.api_list_activities()["activities"]
            act_types = [a["action_type"] for a in user_acts]
            for expected_type in ("TRASH_MOVE", "MEDIA_RENAME", "ALBUM_ADD", "FAVORITE"):
                self.assertIn(expected_type, act_types)
            self.assertGreaterEqual(len(user_acts[0]["files"]), 1)

            # Partage client, export JSON et reprise/réessai d'une activité
            system_router.api_log_client_activity(
                system_router.ClientActivityLogPayload(
                    action_type="MEDIA_SHARE",
                    title="Fichier partagé",
                    detail="act_photo.jpg partagé",
                    files=[str(p_user)],
                )
            )
            import json as _json
            exp_resp = system_router.api_export_activities()
            exp_data = _json.loads(exp_resp.body.decode("utf-8"))
            self.assertGreaterEqual(exp_data["count"], 5)
            self.assertIn("MEDIA_SHARE", [x["action_type"] for x in exp_data["activities"]])

            # Ajout d'une activité IA interrompue puis reprise via /api/activities/{id}/resume
            aid_faces = database.record_activity_entry(
                self.db_path,
                library_name="MaLib",
                action_type="FACES",
                title="Analyse des visages",
                status="paused",
                detail="Mis en pause",
            )
            with patch.object(system_router, "start_specific_task", return_value={"status": "started", "task": "FACES"}) as mock_start:
                res_resume = system_router.api_resume_activity(aid_faces)
                self.assertEqual(res_resume["task"], "FACES")
                mock_start.assert_called_once_with("FACES")

            # Reprise après redémarrage d'un import de dossier mis en pause via params_json
            aid_folder = database.record_activity_entry(
                self.db_path,
                library_name="MaLib",
                action_type="IMPORT",
                title="Importation : Vacances",
                status="paused",
                detail="Mis en pause",
                params_json=_json.dumps({"source_type": "STANDARD_FOLDER", "source_paths": ["C:/Tmp/Vacances"]}),
            )
            import libraries_router
            with patch.object(libraries_router, "api_import_add_sources", return_value={"status": "import_started"}) as mock_imp:
                res_folder_resume = system_router.api_resume_activity(aid_folder)
                self.assertEqual(res_folder_resume["status"], "import_started")
                mock_imp.assert_called_once()
                self.assertEqual(mock_imp.call_args[0][0].source_paths, ["C:/Tmp/Vacances"])

            # Prévention de la mise en veille Windows pendant les traitements
            with patch.object(pipeline_runner.ctypes.windll.kernel32, "SetThreadExecutionState", return_value=1) as mock_exec:
                with pipeline_runner.prevent_system_sleep():
                    pass
                self.assertEqual(
                    [c[0][0] for c in mock_exec.call_args_list],
                    [
                        pipeline_runner.ES_CONTINUOUS | pipeline_runner.ES_SYSTEM_REQUIRED,
                        pipeline_runner.ES_CONTINUOUS,
                    ],
                )

            for fn_ui in (
                "function openClearActivitiesConfirm(",
                "async function confirmClearAllActivities(",
                "async function exportActivitiesHistory(",
                "async function resumeOrRetryActivity(",
                "function toggleActivitySection(",
                "function toggleActivityGroup(",
                "function _groupConsecutiveActivities(",
                "olderEndedRun",
                "groups.slice(0, 1)",
            ):
                self.assertIn(fn_ui, app_js)
            for tog_id in ("act-toggle-operations", "act-toggle-analyses", "act-toggle-actions"):
                self.assertIn(tog_id, html)

            system_router.api_clear_activities()
        finally:
            with pipeline_runner.STATE._lock:
                pipeline_runner.STATE.notifications = saved_n2

        class _FakeUpload:
            filename = "avatar.png"

            async def read(self):
                return b"\x89PNG\r\n\x1a\nfake"

        cfg_dir = self.tmp_path / "cfg"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        cfg_file = cfg_dir / "libraries_config.json"
        legacy_cfg = self.tmp_path / "legacy_libraries_config.json"

        with (
            patch.object(library_manager, "CONFIG_DIR", cfg_dir),
            patch.object(library_manager, "CONFIG_FILE", cfg_file),
            patch.object(library_manager, "LEGACY_CONFIG_FILE", legacy_cfg),
        ):
            library_manager.save_libraries({
                "active_library": "Test",
                "libraries": {
                    "Test": {
                        "name": "Test",
                        "dest_dir": str(self.dest_dir),
                        "source_paths": [str(self.dest_dir)],
                    }
                },
            })
            coro = libraries_router.api_upload_library_icon("Test", _FakeUpload())
            try:
                coro.send(None)
            except StopIteration as exc:
                up_res = exc.value
            finally:
                coro.close()
            self.assertEqual(up_res["status"], "ok")
            self.assertIn("/api/libraries/icon/Test", up_res["icon_url"])

            listed = libraries_router.api_get_libraries()
            self.assertEqual(listed["libraries"]["Test"]["icon_url"], up_res["icon_url"])

            icon_resp = libraries_router.api_get_library_icon("Test")
            self.assertTrue(Path(icon_resp.path).is_file())

            del_res = libraries_router.api_delete_library_icon("Test")
            self.assertEqual(del_res["status"], "ok")
            listed_after = libraries_router.api_get_libraries()
            self.assertEqual(listed_after["libraries"]["Test"]["icon_url"], "")

    def test_library_multisource_create_and_update(self):
        import library_manager
        import libraries_router

        html = main.templates.get_template("index.html").render()
        for snippet in (
            'id="lib-create-sources-list"',
            'id="lib-create-sources-count"',
            'id="lib-edit-sources-list"',
            'id="lib-edit-sources-count"',
            'id="lib-view-remove-source"',
            'id="lib-remove-transfer-chk"',
            'id="lib-remove-transfer-dst"',
            "Ajouter un dossier",
            "Créer un dossier",
            "hover:bg-rose-500/20 hover:text-rose-400 hover:border-rose-400",
            "Valider",
            "bg-rose-600 hover:bg-rose-500",
            "border border-current/20 rounded-full",
            "M21.35 11.1H12v3.2",
        ):
            self.assertIn(snippet, html)
        self.assertNotIn('id="lib-edit-move-radio"', html)
        self.assertNotIn('id="lib-create-takeout-btn"', html)
        self.assertNotIn('id="lib-edit-takeout-btn"', html)
        import_start = html.index('id="import-wizard-modal"')
        import_end = html.index('id="library-modal"', import_start)
        import_html = html[import_start:import_end]
        step1_html = import_html[import_html.index('id="import-step-1"'):import_html.index('id="import-step-2"')]
        step2_html = import_html[import_html.index('id="import-step-2"'):import_html.index('id="import-step-3"')]
        for snippet in (
            "Sélectionner un dossier",
            "Sélectionner des fichiers",
            "Google Takeout",
            "M21.35 11.1H12v3.2",
        ):
            self.assertIn(snippet, step1_html)
        self.assertLess(step1_html.index("Sélectionner un dossier"), step1_html.index("Google Takeout"))
        self.assertLess(step1_html.index("Sélectionner des fichiers"), step1_html.index("Google Takeout"))
        for snippet in (
            "Dossier décompressé",
            "Fichiers ZIP",
            "grid grid-cols-2 gap-2",
            '<path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/>',
        ):
            self.assertIn(snippet, step2_html)
        self.assertIn('<div class="ui-card rounded-3xl max-w-md w-full p-6 shadow-2xl">', import_html)
        step3_html = import_html[import_html.index('id="import-step-3"'):]
        for snippet in (
            'id="import-step3-count"',
            'id="import-step3-add-btn"',
            'id="import-step3-add-label"',
            'id="row-opt-takeout-architecture"',
            'id="wiz-takeout-arch-select"',
            'id="wiz-takeout-arch-desc"',
            'value="KEEP_ORIGINAL"',
            'value="GOOGLE_ALBUM"',
            'value="NONE"',
            "addMoreStep3Paths()",
            "ui-pill rounded-xl",
            "flex justify-center pt-1",
        ):
            self.assertIn(snippet, step3_html)
        import_js = (ROOT_DIR / "frontend" / "static" / "js" / "import_wizard.js").read_text(encoding="utf-8")
        for fn in (
            "function pickTakeoutSource(",
            "function renderStep3PathsList(",
            "async function addMoreStep3Paths(",
            "async function removeStep3Path(",
            "function _syncWizardCheckPill(",
            "function setTakeoutArchitecture(",
            "wizardTakeoutArchitecture",
            "TAKEOUT_ARCH_DESCRIPTIONS",
            "rowAlb.classList.toggle('hidden', !isStandard)",
            "rowFix.classList.toggle('hidden', isStandard)",
        ):
            self.assertIn(fn, import_js)
        lib_modal_start = html.index('id="library-modal"')
        lib_modal_end = html.index('id="manual-face-modal"', lib_modal_start)
        self.assertNotIn("ui-divider", html[lib_modal_start:lib_modal_end])

        libraries_js = (ROOT_DIR / "frontend" / "static" / "js" / "libraries.js").read_text(encoding="utf-8")
        for fn in (
            "function _renderLibrarySourcesList(",
            "function setPrimaryLibrarySource(",
            "function removeLibrarySourceFolder(",
            "async function confirmRemoveLibrarySource(",
            "function cancelRemoveLibrarySource(",
            "new_sources: pendingEditLibFolders.slice()",
        ):
            self.assertIn(fn, libraries_js)

        cfg_dir = self.tmp_path / "cfg_multi"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        cfg_file = cfg_dir / "libraries_config.json"
        legacy_cfg = self.tmp_path / "legacy_multi_libraries_config.json"
        src1 = self.tmp_path / "src1"
        src2 = self.tmp_path / "src2"
        src3 = self.tmp_path / "src3"
        src1.mkdir()
        src2.mkdir()
        src3.mkdir()

        with (
            patch.object(library_manager, "CONFIG_DIR", cfg_dir),
            patch.object(library_manager, "CONFIG_FILE", cfg_file),
            patch.object(library_manager, "LEGACY_CONFIG_FILE", legacy_cfg),
        ):
            created = libraries_router.api_create_library(
                libraries_router.CreateLibraryPayload(
                    name="MultiLib",
                    source_type="STANDARD_FOLDER",
                    source_paths_raw=f"{src1}\n{src2}\n{src1}",
                    dest_dir=str(src1),
                )
            )
            self.assertEqual(created["status"], "created")
            self.assertEqual(created["library"]["source_paths"], [str(src1), str(src2)])
            self.assertEqual(created["library"]["dest_dir"], str(src1))

            updated = libraries_router.api_update_library({
                "original_name": "MultiLib",
                "new_name": "MultiLib2",
                "new_sources": [str(src2), str(src3)],
                "move_existing_content": False,
            })
            self.assertEqual(updated["status"], "updated")
            self.assertEqual(updated["active_library"], "MultiLib2")
            cfg = library_manager.load_libraries()
            lib2 = cfg["libraries"]["MultiLib2"]
            self.assertEqual(lib2["source_paths"], [str(src2), str(src3)])
            self.assertEqual(lib2["dest_dir"], str(src2))

            (src3 / "stay.jpg").write_bytes(b"keep-on-disk")
            (src2 / "2024").mkdir(exist_ok=True)
            moved_photo = src2 / "2024" / "moved.jpg"
            moved_photo.write_bytes(b"moved-bytes")
            (src1 / "2024").mkdir(exist_ok=True)
            (src1 / "2024" / "existing.jpg").write_bytes(b"existing-bytes")

            conn = database.get_db()
            try:
                conn.execute(
                    "INSERT INTO processed_files (source_path, dest_path, status, is_duplicate, is_trashed) VALUES (?, ?, 'ok', 0, 0)",
                    (str(moved_photo), str(moved_photo)),
                )
                conn.commit()
            finally:
                conn.close()
            lib2["db_path"] = str(self.db_path)
            cfg["libraries"]["MultiLib2"] = lib2
            library_manager.save_libraries(cfg)

            rem_no_transfer = libraries_router.api_remove_library_source(
                libraries_router.RemoveLibrarySourcePayload(
                    library_name="MultiLib2",
                    remove_source=str(src3),
                    transfer_content=False,
                )
            )
            self.assertEqual(rem_no_transfer["source_paths"], [str(src2)])
            self.assertTrue((src3 / "stay.jpg").is_file())

            rem_transfer = libraries_router.api_remove_library_source(
                libraries_router.RemoveLibrarySourcePayload(
                    library_name="MultiLib2",
                    remove_source=str(src2),
                    transfer_content=True,
                    target_source=str(src1),
                )
            )
            self.assertEqual(rem_transfer["source_paths"], [str(src1)])
            self.assertEqual(rem_transfer["dest_dir"], str(src1))
            self.assertTrue((src1 / "2024" / "existing.jpg").is_file())
            self.assertTrue((src1 / "2024" / "moved.jpg").is_file())
            self.assertFalse(moved_photo.exists())
            conn = database.get_db()
            try:
                row = conn.execute("SELECT dest_path FROM processed_files").fetchone()
                self.assertEqual(row["dest_path"], str(src1 / "2024" / "moved.jpg"))
            finally:
                conn.close()

    def test_library_technical_dirs_isolated_under_phototo(self):
        import libraries_router
        import library_manager

        cfg_dir = self.tmp_path / "cfg_tech"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        cfg_file = cfg_dir / "libraries_config.json"
        legacy_cfg = self.tmp_path / "legacy_tech_libraries_config.json"
        dest_dir = self.tmp_path / "MyPhotos"
        dest_dir.mkdir(parents=True, exist_ok=True)

        self.assertIn("Phototo", libraries_router.IGNORED_INTERNAL_DIRS)

        with (
            patch.object(library_manager, "CONFIG_DIR", cfg_dir),
            patch.object(library_manager, "CONFIG_FILE", cfg_file),
            patch.object(library_manager, "LEGACY_CONFIG_FILE", legacy_cfg),
            patch.object(library_manager, "load_settings", return_value={}),
        ):
            entry = library_manager.register_library(
                name="Vacances 2026",
                source_type="STANDARD_FOLDER",
                source_paths=[str(dest_dir)],
                dest_dir=str(dest_dir),
                options={},
            )
            expected_tech = dest_dir / "Phototo"
            expected_db = expected_tech / "library_vacances_2026.db"
            self.assertEqual(Path(entry["db_path"]), expected_db)
            self.assertTrue(expected_tech.is_dir())
            self.assertEqual(
                library_manager.get_library_tech_dir(dest_dir, "Miniatures_Cache"),
                expected_tech / "Miniatures_Cache",
            )
            self.assertEqual(
                library_manager.get_takeout_buffer_dir(dest_dir),
                expected_tech / "_Temp_Takeout_Buffer",
            )

            # Même si un dossier racine existe déjà, tout reste strictement sous <dest_dir>/Phototo
            other_dest = self.tmp_path / "StrictPhotos"
            (other_dest / "Miniatures_Cache").mkdir(parents=True, exist_ok=True)
            self.assertEqual(
                library_manager.get_library_tech_dir(other_dest, "Miniatures_Cache"),
                other_dest / "Phototo" / "Miniatures_Cache",
            )

            # Sauvegarde DB placée sous <dest_dir>/Phototo/Sauvegardes_DB
            with (
                patch.object(database, "get_active_db_and_dest", return_value=(expected_db, dest_dir)),
                patch.object(system_router, "get_active_db_and_dest", return_value=(expected_db, dest_dir)),
            ):
                database.get_db().close()
                bkp = system_router.api_backup_database()
            bkp_path = Path(bkp["backup_path"])
            self.assertEqual(bkp_path.parent, expected_tech / "Sauvegardes_DB")
            self.assertTrue(bkp_path.exists())

            # Déplacement de la destination de la bibliothèque : db_path reste pointé vers <new_dest>/Phototo/...
            moved_dest = self.tmp_path / "MovedPhotos"
            moved_dest.mkdir(parents=True, exist_ok=True)
            upd = libraries_router.api_update_library({
                "original_name": "Vacances 2026",
                "new_name": "Vacances 2026",
                "new_sources": [str(moved_dest)],
                "move_existing_content": True,
            })
            self.assertEqual(upd["status"], "updated")
            cfg_after = library_manager.load_libraries()
            self.assertEqual(
                Path(cfg_after["libraries"]["Vacances 2026"]["db_path"]),
                moved_dest / "Phototo" / "library_vacances_2026.db",
            )
            self.assertTrue((moved_dest / "Phototo" / "library_vacances_2026.db").exists())

    def test_error_translation_status_dots_warning_position_and_preflight(self):
        import sqlite3
        import zipfile
        from collections import namedtuple
        import pipeline_runner
        import libraries_router

        # 1. Traduction française des erreurs SQLite / OS
        tr_full = pipeline_runner.translate_runtime_error(sqlite3.OperationalError("database or disk is full"))
        self.assertIn("Disque plein", tr_full)
        self.assertIn("espace insuffisant", tr_full)
        tr_locked = pipeline_runner.translate_runtime_error("database is locked")
        self.assertIn("verrouillée", tr_locked)
        self.assertEqual(pipeline_runner.translate_runtime_error("Echec réseau inconnu"), "Echec réseau inconnu")

        # 2. status_level dans PipelineState (running / paused / error / stopped)
        st = pipeline_runner.PipelineState()
        st.set_task("INGEST", "Importation en cours...")
        self.assertEqual(st.to_dict()["status_level"], "running")
        with st._lock:
            st.is_running = False
            st.status_level = "error"
            st.current_step = f"Erreur : {tr_full}"
        snap = st.to_dict()
        self.assertEqual(snap["status_level"], "error")
        self.assertIn("Disque plein", snap["current_step"])

        # 3. Analyse préalable d'espace disque (TAKEOUT_ZIPS + STANDARD_FOLDER)
        src_folder = self.tmp_path / "SrcFolder"
        src_folder.mkdir(parents=True, exist_ok=True)
        (src_folder / "vacances.jpg").write_bytes(b"a" * (512 * 1024))
        dest_folder = self.tmp_path / "DestLib"
        dest_folder.mkdir(parents=True, exist_ok=True)

        pf_ok = libraries_router.api_import_preflight(libraries_router.PreflightImportPayload(
            source_type="STANDARD_FOLDER",
            paths=[str(src_folder)],
            dest_dir=str(dest_folder),
        ))
        self.assertEqual(pf_ok["file_count"], 1)
        self.assertGreater(pf_ok["needed_dest_bytes"], 512 * 1024)
        self.assertTrue(pf_ok["enough"])
        self.assertEqual(pf_ok["deficit_dest_bytes"], 0)

        zip_path = self.tmp_path / "takeout-001.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("Takeout/Google Photos/photo.jpg", b"b" * (4 * 1024 * 1024))

        DiskUsage = namedtuple("DiskUsage", ["total", "used", "free"])
        with patch.object(libraries_router.shutil, "disk_usage", return_value=DiskUsage(100_000_000, 99_900_000, 100_000)):
            pf_low = libraries_router.api_import_preflight(libraries_router.PreflightImportPayload(
                source_type="TAKEOUT_ZIPS",
                paths=[str(zip_path)],
                dest_dir=str(dest_folder),
            ))
        self.assertFalse(pf_low["enough"])
        self.assertEqual(pf_low["zip_count"], 1)
        self.assertEqual(pf_low["file_count"], 1)
        self.assertGreater(pf_low["deficit_dest_bytes"], 0)
        self.assertTrue(any("Espace insuffisant" in w for w in pf_low["warnings"]))

        # 4. Vérifications UI : point de statut, bouton d'avertissement déplacé à côté de Fichiers traités, preflight wizard
        topbar_html = (ROOT_DIR / "frontend" / "templates" / "components" / "topbar.html").read_text(encoding="utf-8")
        app_js = (ROOT_DIR / "frontend" / "static" / "js" / "app.js").read_text(encoding="utf-8")
        wiz_html = (ROOT_DIR / "frontend" / "templates" / "components" / "modals" / "import_wizard_modal.html").read_text(encoding="utf-8")
        wiz_js = (ROOT_DIR / "frontend" / "static" / "js" / "import_wizard.js").read_text(encoding="utf-8")

        self.assertIn('id="pop-status-dot"', topbar_html)
        self.assertIn('id="pop-files-row"', topbar_html)
        self.assertIn('id="task-preflight-warning"', topbar_html)
        files_row_idx = topbar_html.index('id="pop-files-row"')
        files_pill_idx = topbar_html.index('id="pop-files-pill"')
        warn_btn_idx = topbar_html.index('id="btn-task-warning"')
        self.assertLess(files_row_idx, files_pill_idx)
        self.assertLess(files_pill_idx, warn_btn_idx)

        for token in ("bg-emerald-400", "bg-amber-400", "bg-rose-500", "/api/import/preflight_active"):
            self.assertIn(token, app_js)
        self.assertIn('id="wiz-preflight-box"', wiz_html)
        self.assertIn('id="wiz-space-confirm-bar"', wiz_html)
        self.assertIn("runWizardPreflightCheck", wiz_js)
        self.assertIn("/api/import/preflight", wiz_js)

        # 5. Annulation explicite d'une pause persistée (après redémarrage) via /api/activities/{id}/cancel_pause
        import system_router
        aid_paused = database.record_activity_entry(
            self.db_path,
            library_name="MaLib",
            action_type="IMPORT",
            title="Importation : Vacances",
            status="paused",
            detail="Mis en pause (10/100 traité(s)) · 12s",
            reason="Mis en pause (10/100 traité(s))",
            total_items=100,
            success_count=10,
        )
        res_cancel = system_router.api_cancel_paused_activity(aid_paused)
        self.assertEqual(res_cancel["status"], "ok")
        updated_entry = database.get_activity_entry(aid_paused)
        self.assertIn("arrêtée par l'utilisateur", updated_entry["reason"])
        self.assertIn("· 12s", updated_entry["detail"])

        # 6. Arrêt / Redémarrage avec activité en cours : choix pause / stop / ignore + modale UI
        views_html = (ROOT_DIR / "frontend" / "templates" / "components" / "views.html").read_text(encoding="utf-8")
        self.assertIn('id="power-activity-modal"', views_html)
        for tok in ("Mettre en pause", "Arrêter l'activité", "Ignorer l'activité"):
            self.assertIn(tok, views_html)
        for js_tok in ("function _openPowerActivityModal(", "async function executePowerAction(", "beforeunload"):
            self.assertIn(js_tok, app_js)

        calls = []
        with (
            patch.object(system_router.STATE, "is_running", True),
            patch.object(system_router, "request_stop_pipeline", side_effect=lambda cancel=False: calls.append(("stop", cancel)) or {"status": "stopping"}),
        ):
            self.assertEqual(system_router._prepare_power_transition("pause", wait_timeout_sec=0.05), "pause")
            self.assertEqual(system_router._prepare_power_transition("stop", wait_timeout_sec=0.05), "stop")
            self.assertEqual(system_router._prepare_power_transition("ignore", wait_timeout_sec=0.05), "ignore")
        self.assertEqual(calls, [("stop", False), ("stop", True)])

        with patch.object(system_router.threading, "Thread") as mock_thread:
            r_res = system_router.api_system_restart("pause")
            s_res = system_router.api_system_shutdown("ignore")
        self.assertEqual(r_res, {"status": "restarting", "activity_action": "pause"})
        self.assertEqual(s_res, {"status": "shutting_down", "activity_action": "ignore"})
        self.assertEqual(mock_thread.call_count, 2)

        # 7. Notification automatique au lancement si activité mise en pause ou interrompue avant l'arrêt
        database.clear_activity_entries()
        aid_pause_restart = database.record_activity_entry(
            self.db_path,
            library_name="MaLib",
            action_type="IMPORT",
            title="Importation : Été",
            status="paused",
            detail="Mis en pause (25/100 traité(s)) · 10s",
            reason="Mis en pause (25/100 traité(s))",
            total_items=100,
            success_count=25,
        )
        aid_stopped_manual = database.record_activity_entry(
            self.db_path,
            library_name="MaLib",
            action_type="FACES",
            title="Analyse des visages",
            status="paused",
            detail="Tâche arrêtée par l'utilisateur · 5s",
            reason="Tâche arrêtée par l'utilisateur",
            total_items=50,
            success_count=5,
        )
        with pipeline_runner.STATE._lock:
            saved_startup_notifs = list(pipeline_runner.STATE.notifications)
            pipeline_runner.STATE.notifications.clear()
        try:
            added_cnt = pipeline_runner.seed_startup_resume_notifications()
            self.assertEqual(added_cnt, 1)
            self.assertEqual(pipeline_runner.seed_startup_resume_notifications(), 0)
            self.assertEqual(len(pipeline_runner.STATE.notifications), 1)
            notif = pipeline_runner.STATE.notifications[0]
            self.assertEqual(notif["action_activity_id"], aid_pause_restart)
            self.assertEqual(notif["action_label"], "Reprendre")
            self.assertFalse(notif["read"])
            self.assertIn("Importation : Été", notif["title"])
            self.assertNotEqual(notif["action_activity_id"], aid_stopped_manual)
        finally:
            with pipeline_runner.STATE._lock:
                pipeline_runner.STATE.notifications = saved_startup_notifs
        self.assertIn("async function resumeActivityFromNotif(", app_js)
        self.assertIn("action_activity_id", app_js)
        self.assertIn("async function runTaskFromNotif(", app_js)
        self.assertIn("action_task", app_js)

        # 8. Détection et notification de nouveaux fichiers dans les dossiers sources non ajoutés par l'application
        watch_src = self.tmp_path / "WatchedPhotos"
        watch_src.mkdir(parents=True, exist_ok=True)
        known_img = watch_src / "deja_importe.jpg"
        known_img.write_bytes(b"ok")
        new_img = watch_src / "nouveau_externe.jpg"
        new_img.write_bytes(b"new")
        ignored_sub = watch_src / "Phototo"
        ignored_sub.mkdir(parents=True, exist_ok=True)
        (ignored_sub / "thumb.jpg").write_bytes(b"ignored")

        conn_w = database.get_db()
        try:
            conn_w.execute(
                "INSERT OR REPLACE INTO processed_files (source_path, dest_path) VALUES (?, ?)",
                (str(known_img.resolve()), str(known_img.resolve())),
            )
            conn_w.commit()
        finally:
            conn_w.close()

        fake_libs = {
            "active_library": "MaLib",
            "libraries": {
                "MaLib": {
                    "name": "MaLib",
                    "source_type": "STANDARD_FOLDER",
                    "source_paths": [str(watch_src)],
                    "dest_dir": str(watch_src),
                    "db_path": str(self.db_path),
                }
            },
        }
        with pipeline_runner.STATE._lock:
            saved_watch_notifs = list(pipeline_runner.STATE.notifications)
            pipeline_runner.STATE.notifications.clear()
            pipeline_runner.STATE._last_new_files_sig = None
        try:
            with (
                patch.object(pipeline_runner, "load_libraries", return_value=fake_libs),
                patch.object(pipeline_runner, "load_settings", return_value={"scanned_folders": []}),
            ):
                res_info = pipeline_runner.detect_unadded_source_files()
                self.assertEqual(res_info["new_count"], 1)
                self.assertEqual(res_info["kind"], "media")

                cnt = pipeline_runner.notify_unadded_source_files()
                self.assertEqual(cnt, 1)
                self.assertEqual(len(pipeline_runner.STATE.notifications), 1)
                nf = pipeline_runner.STATE.notifications[0]
                self.assertEqual(nf["action_task"], "INGEST")
                self.assertEqual(nf["action_label"], "Analyser")
                self.assertIn("1 nouveau(x) média(s)", nf["detail"])
                # Pas de doublon sur les vérifications périodiques suivantes si le compte n'a pas changé
                self.assertEqual(pipeline_runner.notify_unadded_source_files(), 0)
                with patch.object(system_router.threading, "Thread") as mock_chk_thread:
                    chk_res = system_router.api_check_activities_sources()
                self.assertEqual(chk_res, {"status": "checking"})
                self.assertEqual(mock_chk_thread.call_count, 1)
                self.assertIn("/api/activities/check_sources", app_js)
                self.assertFalse(hasattr(pipeline_runner, "start_source_files_watcher_thread"))
                self.assertTrue(callable(pipeline_runner.check_source_files_on_startup_async))
        finally:
            with pipeline_runner.STATE._lock:
                pipeline_runner.STATE.notifications = saved_watch_notifs
                pipeline_runner.STATE._last_new_files_sig = None


if __name__ == "__main__":
    unittest.main()
