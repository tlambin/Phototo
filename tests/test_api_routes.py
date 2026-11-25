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

        # Lieux : carte interactive repliée par défaut en vignette taille lieu + dépliage au clic
        self.assertIn('id="world-map-card" class="hidden ui-card', html)
        self.assertIn('id="map-collapse-btn"', html)
        self.assertIn('onclick="toggleWorldMapExpanded(false)"', html)
        ai_views_js = (ROOT_DIR / "frontend" / "static" / "js" / "ai_views.js").read_text(encoding="utf-8")
        for tok in (
            "let _worldMapExpanded = false;",
            "function toggleWorldMapExpanded(",
            "function renderWorldMapCompactCardHTML(",
            'id="world-map-compact-card"',
            'onclick="toggleWorldMapExpanded(true)"',
            "mapCompactCardHtml",
        ):
            self.assertIn(tok, ai_views_js)

        # Page Outils simplifiée + pages dédiées pour chaque suggestion (style Doublons / Similaires)
        for tok in (
            'id="tools-sticky-header"', 'id="tools-summary-pill"',
            'id="tools-ai-open-btn"', 'id="tools-ai-modal"',
            'id="tab-suggestion-page"', 'id="sug-sticky-header"', 'id="sug-options-drawer"',
            'id="sug-page-settings-btn"', 'id="sug-sort-by"', 'id="sug-filter-by"',
            'id="sug-layout-btn-GRID"', 'id="sug-layout-btn-MASONRY"', 'id="sug-layout-btn-LIST"',
            'id="sug-progress-card"', 'id="sug-summary-bar"', 'id="sug-container"', 'id="sug-batch-bar"',
            'id="ps-sug-settings-section"', 'id="ps-sug-blur-thresh"', 'id="ps-sug-large-min-mb"',
            'id="tools-sug-progress-card"',
            'id="tools-sug-card-albums"', 'id="tools-sug-card-rotation"', 'id="tools-sug-card-blurry"',
            'id="tools-sug-card-gps"', 'id="tools-sug-card-people"', 'id="tools-sug-card-screenshots"',
            'id="tools-sug-card-large"', 'id="tools-sug-card-missing"',
            'id="st-dups"', 'id="st-sims"', 'id="st-missing-meta"',
            'id="tools-cov-bar-dedup"', 'id="tools-cov-bar-similar"',
            'id="tools-cov-bar-ocr"', 'id="tools-cov-bar-clip"', 'id="tools-cov-bar-faces"',
            'id="tools-ocr-count"', 'id="tools-persons-count"',
            'id="btn-retry-meta"', 'id="btn-prune-missing"',
            'id="types-sticky-header"', 'id="types-options-drawer"', 'id="types-total-label"',
            'id="smart-categories-grid"', 'id="category-single-sticky-header"',
            'id="tab-btn-stats"', 'id="tab-stats"', 'id="stats-sticky-header"',
            'id="stats-summary-pill"', 'id="types-cards-grid"', 'id="types-formats-panel"',
            'id="types-ext-grid"', 'id="stats-type-breakdown"', 'id="stats-coverage-list"',
            'id="stats-temporal-section"', 'id="stats-gran-years"', 'id="stats-gran-months"',
            'id="stats-gran-weeks"', 'id="stats-gran-days"', 'id="stats-period-chart"',
            'id="stats-period-list"', 'id="stats-weekday-chart"', 'id="stats-season-chart"',
            'id="stats-hour-chart"', 'id="stats-meta-card"', 'id="stats-tech-card"',
            'id="stats-top-albums-card"',
            'id="studio-tools-drawer"', 'id="studio-center-photo-pill"', 'id="studio-center-video-pill"',
            'id="studio-video-timeline-dock"', 'id="studio-tl-v1-rail"', 'id="studio-tl-t1-clip"',
            'id="studio-tl-a1-clip"', 'id="studio-tl-handle-in"', 'id="studio-tl-handle-out"',
            'id="studio-text-preview"', 'id="studio-btn-undo"', 'id="studio-btn-redo"',
            'id="studio-filter-presets"', 'id="st-warmth"', 'id="st-vignette"', 'id="studio-dims-pill"',
            'id="studio-tl-ruler"', 'id="studio-tl-filmstrip"', 'id="studio-tl-waveform"',
            'id="studio-tl-curtain-left"', 'id="studio-tl-curtain-right"', 'data-crop-handle="se"',
            'id="studio-eraser-canvas"', 'id="studio-eraser-cursor"', 'id="studio-eraser-bar"',
            'id="st-eraser-size"', 'id="studio-btn-auto"',
            'id="studio-left-rail"', 'id="studio-btn-split"', 'id="studio-btn-grid"',
            'id="studio-stab-history"', 'id="studio-crop-preview-btn"',
            'id="studio-split-orig-img"', 'id="studio-split-divider"',
            'id="studio-histogram-canvas"',
            'id="studio-dec-library-bin-grid"', 'id="studio-tl-v2-rail"', 'id="studio-tl-extra-clips"',
            'id="st-straighten"', 'id="st-tint"', 'id="st-highlights"', 'id="st-shadows"',
            'id="st-fade"', 'id="st-grain"', 'id="studio-music-player"', 'id="studio-grain-overlay"',
            'id="st-ratio-orig"',
            'id="studio-layer-templates-card"', 'id="studio-tpl-creator-box"',
            'id="studio-layer-templates-list"', 'id="st-text-opacity"',
            'id="studio-save-copy-btn"', 'id="studio-save-overwrite-btn"',
        ):
            self.assertIn(tok, html)
        self.assertNotIn('id="studio-save-btn"', html)
        # Les 5 sections Transformation, Filtre, Ton, Décoration (Dessin/Calque/Texte) & Outil (Objet, Reflets, Yeux rouges)
        self.assertLess(html.index('id="studio-left-rail"'), html.index('id="studio-tools-drawer"'))
        self.assertLess(html.index('id="studio-tools-drawer"'), html.index('id="studio-viewport"'))
        for stok in (
            'id="studio-stab-transform"', 'id="studio-stab-filter"', 'id="studio-stab-tone"',
            'id="studio-stab-decoration"', 'id="studio-stab-layers"', 'id="studio-stab-tools"',
            'id="studio-panel-transform"', 'id="studio-panel-filter"', 'id="studio-panel-tone"',
            'id="studio-panel-decoration"', 'id="studio-panel-layers"', 'id="studio-panel-tools"',
            'id="studio-dectab-draw"', 'id="studio-dectab-text"',
            'id="studio-decsub-draw"', 'id="studio-decsub-text"',
            'id="st-bmode-brush"', 'id="st-bmode-pen"', 'id="st-bmode-highlighter"',
            'id="st-bmode-blur"', 'id="st-bmode-shape"', 'id="st-bmode-stroke_eraser"',
            'id="rmode-object"' if False else 'id="st-rmode-object"', 'id="st-rmode-glare"', 'id="st-rmode-redeye"', 'id="st-rmode-blemish"',
            'id="studio-ai-inpaint-banner"', 'id="studio-draw-canvas"', 'id="studio-blur-canvas"',
        ):
            self.assertIn(stok, html)
        # Les 4 boutons (Photos, Vidéos, Images animées, Formats) sont bien sur la page Statistiques et plus dans Catégories
        self.assertLess(html.index('id="tab-types"'), html.index('id="tab-stats"'))
        self.assertLess(html.index('id="tab-stats"'), html.index('id="types-cards-grid"'))
        app_js = (ROOT_DIR / "frontend" / "static" / "js" / "app.js").read_text(encoding="utf-8")
        gallery_js = (ROOT_DIR / "frontend" / "static" / "js" / "gallery.js").read_text(encoding="utf-8")
        groups_js = (ROOT_DIR / "frontend" / "static" / "js" / "groups.js").read_text(encoding="utf-8")
        studio_js = (ROOT_DIR / "frontend" / "static" / "js" / "studio_exif.js").read_text(encoding="utf-8")
        for fn in (
            "function selectStudioSidebarTab(", "function setStudioCropAspect(",
            "function applyStudioFilterPreset(", "function setStudioTrimInAtPlayhead(",
            "function setStudioTrimOutAtPlayhead(", "function syncStudioTimelineUI(",
            "function setStudioCompareOriginal(", "function resetStudioEdits(",
            "function studioUndo(", "function studioRedo(",
            "function studioAutoEnhance(", "function refreshStudioPhotoStageSource(",
            "function toggleStudioEraserMasksOverlay(", "function toggleStudioSplitCompare(",
            "function cycleStudioGridOverlay(", "function handleStudioLocalFilesSelected(",
            "function loadStudioLibraryBin(", "function addExtraStudioTextLayer(",
            "function _drawStudioHistogram(", "function resetStudioSection(",
            "function syncStudioTabBadges(", "function onStudioAudioPathChanged(",
            "function loadStudioLayerTemplates(", "function applyStudioLayerTemplate(",
            "function saveStudioWatermarkQuickTemplate(", "function saveCurrentCanvasAsLayerTemplate(",
            "function deleteStudioLayerTemplate(", "function toggleStudioDrawerCollapsed(",
            "function selectStudioBrushMode(", "function refreshStudioAiInpaintStatus(",
            "function installStudioAiInpaintModel(", "function _renderStudioBrushLayers(",
            "function _exportStudioBrushPayloads(", "function undoStudioBrushStep(",
            "function clearStudioBrushLayers(", "function selectStudioDecorationSubtab(",
            "function selectStudioRetouchTool(",
        ):
            self.assertIn(fn, studio_js)
        for fn in (
            "function openSuggestionPage(", "function openSuggestionAndAnalyze(",
            "function openCurrentSugPageSettings(", "function openSuggestedNewAlbumPreview(",
            "function closeSuggestedNewAlbumPreview(", "function createSuggestedNewAlbumFromPreview(",
            "function goBackFromSugPage(", "function toggleTypesOptionsBar(",
            "'BLUR'", "'ROTATION'", "'SUGGESTIONS'", "'stats'",
        ):
            self.assertIn(fn, app_js)
        for fn in (
            "function loadStatsPage(", "function renderSmartCategoriesFromCache(",
            "function renderStatsTypeBreakdown(", "function renderStatsPeriodSection(",
            "function setStatsGranularity(", "function filterGalleryByPeriod(",
        ):
            self.assertIn(fn, gallery_js)
        for pg in ("types:", "'sug-albums'", "'sug-rotation'", "'sug-blurry'", "'sug-missing_gps'", "'sug-people'", "'sug-screenshots'", "'sug-large'", "'sug-missing_meta'"):
            self.assertIn(pg, groups_js)

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

        det = system_router.api_stats_detailed()
        self.assertEqual(len(det["years"]), 1)
        self.assertEqual(len(det["months"]), 1)
        self.assertEqual(len(det["weeks"]), 1)
        self.assertEqual(len(det["days"]), 1)
        self.assertEqual(det["years"][0]["count"], 1)
        self.assertEqual(len(det["weekdays"]), 7)
        self.assertEqual(len(det["hours"]), 24)
        self.assertEqual(len(det["season_months"]), 12)
        self.assertEqual(det["top_albums"][0]["name"], "Vacances")
        self.assertEqual(det["summary"]["albumed_count"], 1)

    def test_studio_photo_edit_apply_and_db_update(self):
        from PIL import Image
        import metadata_studio_router

        src_img = self.dest_dir / "studio_src.jpg"
        Image.new("RGB", (120, 80), color=(40, 80, 120)).save(src_img)

        conn = database.get_db()
        conn.execute(
            """
            INSERT INTO processed_files
            (source_path, dest_path, original_dest_path, status, timestamp, file_size, width, height, is_duplicate, is_trashed)
            VALUES (?, ?, ?, 'ok', 1700000000, ?, 120, 80, 0, 0)
            """,
            ("src_studio_1", str(src_img), str(src_img), src_img.stat().st_size),
        )
        conn.commit()
        conn.close()

        strokes = [{"nr": 0.05, "points": [{"nx": 0.2, "ny": 0.2}, {"nx": 0.4, "ny": 0.4}]}]
        preview_resp = metadata_studio_router.api_preview_studio_eraser(
            metadata_studio_router.MediaStudioEditPayload(
                source_path="src_studio_1",
                rotate=90,
                inpaint_strokes=strokes,
            )
        )
        self.assertEqual(preview_resp.media_type, "image/jpeg")
        self.assertTrue(preview_resp.body.startswith(b"\xff\xd8"))

        with patch.object(metadata_studio_router, "get_active_db_and_dest", return_value=(self.db_path, self.dest_dir)):
            import asyncio
            import io
            from fastapi import UploadFile
            ov_buf = io.BytesIO()
            Image.new("RGBA", (24, 24), (255, 0, 0, 200)).save(ov_buf, format="PNG")
            ov_buf.seek(0)
            up_res = asyncio.run(
                metadata_studio_router.api_upload_studio_asset(UploadFile(filename="logo_test.png", file=ov_buf))
            )
            self.assertEqual(up_res["status"], "ok")
            self.assertEqual(up_res["kind"], "image")
            self.assertTrue(Path(up_res["path"]).exists())

        # Statut Effaceur IA & calque Pinceau RGBA / Floutage
        ai_st = metadata_studio_router.api_studio_ai_inpaint_status()
        self.assertIn("installed", ai_st)
        self.assertIn("device_label", ai_st)

        import base64
        draw_cv = Image.new("RGBA", (40, 40), (0, 0, 0, 0))
        draw_cv.putpixel((20, 20), (244, 63, 94, 220))
        draw_buf = io.BytesIO()
        draw_cv.save(draw_buf, format="PNG")
        draw_b64 = "data:image/png;base64," + base64.b64encode(draw_buf.getvalue()).decode("ascii")

        with patch("media_editor.preserve_metadata_and_time"):
            res = metadata_studio_router.api_apply_studio_edits(
                metadata_studio_router.MediaStudioEditPayload(
                    source_path="src_studio_1",
                    overwrite=False,
                    rotate=90,
                    straighten=0.0,
                    crop={"nx": 0.0, "ny": 0.0, "nw": 0.5, "nh": 0.5},
                    brightness=1.1,
                    saturation=1.2,
                    warmth=0.35,
                    tint=0.15,
                    highlights=-0.2,
                    shadows=0.25,
                    fade=0.1,
                    grain=0.15,
                    vignette=0.4,
                    inpaint_strokes=strokes,
                    draw_layer_png=draw_b64,
                    blur_strokes=[{"nr": 0.08, "points": [{"nx": 0.3, "ny": 0.3}, {"nx": 0.4, "ny": 0.4}]}],
                    image_overlays=[{"path": up_res["path"], "nx": 0.1, "ny": 0.1, "nw": 0.3, "opacity": 0.8}],
                    text_overlay={"text": "Test", "nx": 0.1, "ny": 0.8, "size": 24, "color": "#ffffff", "bg_color": "dark", "opacity": 0.65},
                    text_layers=[{"text": "Watermark", "nx": 0.2, "ny": 0.3, "size": 20, "color": "#fbbf24", "opacity": 0.45}],
                )
            )
        self.assertEqual(res["status"], "ok")
        out_p = Path(res["output_files"][0])
        self.assertTrue(out_p.exists())
        self.assertIn("_edit", out_p.stem)
        # Après rotation +90° (120x80 -> 80x120) puis crop 50%x50% -> 40x60
        with Image.open(out_p) as edited:
            self.assertEqual(edited.size, (40, 60))

        # Modèles de calques (Watermarks réutilisables) : liste / création / suppression
        tpl_file = self.tmp_path / "studio_layer_templates.json"
        with patch.object(metadata_studio_router, "LAYER_TEMPLATES_FILE", tpl_file):
            listed0 = metadata_studio_router.api_list_layer_templates()
            self.assertGreaterEqual(len(listed0["templates"]), 4)
            created = metadata_studio_router.api_save_layer_template(
                metadata_studio_router.StudioLayerTemplatePayload(
                    name="Mon Watermark Test",
                    category="watermark",
                    text_layers=[{"text": "© Moi", "nx": 0.7, "ny": 0.85, "size": 24, "color": "#ffffff", "opacity": 0.5}],
                    image_overlays=[{"path": up_res["path"], "nx": 0.05, "ny": 0.05, "nw": 0.2, "opacity": 0.8}],
                )
            )
            self.assertEqual(created["status"], "ok")
            tid = created["template"]["id"]
            self.assertTrue(any(t["id"] == tid and not t["builtin"] for t in created["templates"]))
            deleted = metadata_studio_router.api_delete_layer_template(tid)
            self.assertFalse(any(t["id"] == tid for t in deleted["templates"]))

        # Vérifie aussi le redressement fin (-45° à +45°) + Effaceur reflets + Yeux rouges via aperçu JPEG
        str_resp = metadata_studio_router.api_preview_studio_eraser(
            metadata_studio_router.MediaStudioEditPayload(
                source_path="src_studio_1",
                straighten=5.0,
                glare_strokes=[{"nr": 0.05, "points": [{"nx": 0.25, "ny": 0.25}]}],
                redeye_strokes=[{"nr": 0.04, "points": [{"nx": 0.65, "ny": 0.55}]}],
                blemish_strokes=[{"nr": 0.03, "points": [{"nx": 0.5, "ny": 0.5}]}],
            )
        )
        self.assertEqual(str_resp.media_type, "image/jpeg")
        self.assertTrue(str_resp.body.startswith(b"\xff\xd8"))
        self.assertIn("x-inpaint-engine", {k.lower() for k in str_resp.headers.keys()})

        # Vérifie directement que l'effaceur d'yeux rouges corrige un pixel rouge vif sans erreur
        import media_editor
        eye_img = Image.new("RGB", (60, 60), (40, 40, 40))
        for yy in range(24, 36):
            for xx in range(24, 36):
                eye_img.putpixel((xx, yy), (220, 20, 20))
        fixed_eye = media_editor._apply_redeye_removal(eye_img, [{"nr": 0.12, "points": [{"nx": 0.5, "ny": 0.5}]}])
        r_after, _, _ = fixed_eye.getpixel((30, 30))
        self.assertLess(r_after, 90)

        conn = database.get_db()
        row = conn.execute("SELECT width, height, status FROM processed_files WHERE source_path = ?", (str(out_p),)).fetchone()
        conn.close()
        self.assertIsNotNone(row)
        self.assertEqual((row["width"], row["height"], row["status"]), (40, 60, "edited_copy"))

    def test_tools_suggestions_endpoints(self):
        import cv2
        import numpy as np
        from PIL import Image
        import pipeline_runner

        blur_img = self.dest_dir / "blurry.png"
        dark_img = self.dest_dir / "dark.png"
        sharp_img = self.dest_dir / "sharp.png"
        rot_img = self.dest_dir / "rotated.jpg"
        screen_img = self.dest_dir / "Screenshot_20220101.png"
        short_vid = self.dest_dir / "pocket.mp4"
        nometa_img = self.dest_dir / "nometa.png"

        # Image grise uniforme (floue), image quasi noire (sous-exposée), et damier haute fréquence (net)
        cv2.imwrite(str(blur_img), np.full((120, 120, 3), 128, dtype=np.uint8))
        cv2.imwrite(str(dark_img), np.full((120, 120, 3), 5, dtype=np.uint8))
        checker = np.zeros((120, 120, 3), dtype=np.uint8)
        checker[::2, ::2] = 255
        checker[1::2, 1::2] = 255
        cv2.imwrite(str(sharp_img), checker)
        cv2.imwrite(str(screen_img), checker)
        short_vid.write_bytes(b"vid")
        # Image JPEG 160x80 avec tag EXIF Orientation = 6 (90° horaire attendu -> deviendra 80x160)
        pil_rot = Image.new("RGB", (160, 80), color=(40, 120, 200))
        exif = pil_rot.getexif()
        exif[274] = 6
        pil_rot.save(rot_img, format="JPEG", exif=exif)
        nometa_img.write_bytes(b"raw")

        emb_a = np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float16).tobytes()
        emb_same_decor = np.array([0.98, 0.20, 0.0, 0.0], dtype=np.float16).tobytes()
        face_vec = np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32).tobytes()

        conn = database.get_db()
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, timestamp, file_size, album_name, clip_embedding, latitude, longitude) VALUES (?, ?, ?, 'ok', 1700000000, 1024, 'Vacances', ?, 48.8566, 2.3522)",
            ("src_alb", str(sharp_img), str(sharp_img), emb_a),
        )
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, timestamp, file_size, album_name, clip_embedding, latitude, longitude) VALUES (?, ?, ?, 'ok', 1705000000, ?, NULL, ?, 48.8570, 2.3525)",
            ("src_blur_cand", str(blur_img), str(blur_img), 12 * 1024 * 1024, emb_same_decor),
        )
        # Photo sombre sans GPS à 30 min d'une photo géolocalisée + début d'une grappe de 4 photos d'événement
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, timestamp, file_size, album_name) VALUES (?, ?, ?, 'ok', 1700001800, 2048, NULL)",
            ("src_dark_gps", str(dark_img), str(dark_img)),
        )
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, timestamp, file_size, width, height, album_name) VALUES (?, ?, ?, 'ok', 1710000000, 2048, 160, 80, NULL)",
            ("src_rot", str(rot_img), str(rot_img)),
        )
        # Grappe de 4 captures/photos anciennes en 2022 -> suggère aussi un nouvel album + captures anciennes
        for idx_s in range(4):
            src_ev = f"src_ev_{idx_s}"
            dst_ev = str(screen_img if idx_s == 0 else sharp_img) if idx_s == 0 else str(self.dest_dir / f"ev_{idx_s}.png")
            if idx_s > 0:
                cv2.imwrite(dst_ev, checker)
            conn.execute(
                "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, timestamp, file_size, album_name) VALUES (?, ?, ?, 'ok', ?, 1024, NULL)",
                (src_ev, dst_ev, dst_ev, 1641000000 + idx_s * 600),
            )
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, timestamp, file_size, duration_sec, album_name) VALUES (?, ?, ?, 'ok', 1715000000, 1024, 1.4, NULL)",
            ("src_short_v", str(short_vid), str(short_vid)),
        )
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, timestamp, file_size, album_name) VALUES (?, ?, ?, 'no_metadata', 0, 512, NULL)",
            ("src_nometa", str(nometa_img), str(nometa_img)),
        )
        conn.execute("INSERT INTO persons (person_id, name, face_count, centroid_embedding) VALUES (1, 'Marie', 4, ?)", (face_vec,))
        conn.execute("INSERT INTO persons (person_id, name, face_count, centroid_embedding) VALUES (2, 'Inconnu', 5, ?)", (face_vec,))
        conn.execute(
            "INSERT INTO faces (source_path, dest_path, timestamp, bbox, det_score, person_id) VALUES (?, ?, 1700000000, '0,0,10,10', 0.99, 1)",
            ("src_alb", str(sharp_img)),
        )
        conn.execute(
            "INSERT INTO faces (source_path, dest_path, timestamp, bbox, det_score, person_id) VALUES (?, ?, 1705000000, '0,0,10,10', 0.99, 1)",
            ("src_blur_cand", str(blur_img)),
        )
        conn.commit()
        conn.close()

        scan_res = gallery_router.api_tools_scan_blur()
        self.assertGreaterEqual(scan_res["scanned_now"], 7)

        rot_scan = gallery_router.api_tools_scan_rotation()
        self.assertGreaterEqual(rot_scan["scanned_now"], 7)
        self.assertEqual(rot_scan["rotation_count"], 1)

        sum_res = gallery_router.api_tools_suggestions_summary(min_mb=10)
        self.assertGreaterEqual(sum_res["albums_count"], 1)
        self.assertGreaterEqual(sum_res["new_events_count"], 1)
        self.assertEqual(sum_res["rotation_count"], 1)
        self.assertGreaterEqual(sum_res["exposure_bad_count"], 1)
        self.assertGreaterEqual(sum_res["missing_gps_count"], 1)
        self.assertEqual(sum_res["people_merge_count"], 1)
        self.assertEqual(sum_res["people_unnamed_count"], 1)
        self.assertGreaterEqual(sum_res["screenshots_count"], 1)
        self.assertEqual(sum_res["large_count"], 1)
        self.assertEqual(sum_res["short_videos_count"], 1)
        self.assertEqual(sum_res["missing_meta_count"], 1)

        det_alb = gallery_router.api_tools_suggestions_details(kind="albums")
        self.assertEqual(det_alb["items"][0]["source_path"], "src_blur_cand")
        self.assertEqual(det_alb["items"][0]["suggested_album"], "Vacances")
        self.assertEqual(set(det_alb["items"][0]["match_tags"]), {"Décor", "Lieu", "Personne"})
        self.assertGreaterEqual(len(det_alb["new_events"]), 1)
        self.assertEqual(len(det_alb["new_events"][0]["items"]), det_alb["new_events"][0]["item_count"])
        self.assertIn("dest_path", det_alb["new_events"][0]["items"][0])

        det_exp = gallery_router.api_tools_suggestions_details(kind="blurry", filter_mode="exposure")
        exp_srcs = {it["source_path"]: it["quality_issue"] for it in det_exp["items"]}
        self.assertIn("src_dark_gps", exp_srcs)
        self.assertIn("Trop sombre", exp_srcs["src_dark_gps"])

        det_gps = gallery_router.api_tools_suggestions_details(kind="missing_gps")
        gps_srcs = [it["source_path"] for it in det_gps["items"]]
        self.assertIn("src_dark_gps", gps_srcs)
        gps_item = next(it for it in det_gps["items"] if it["source_path"] == "src_dark_gps")
        gps_apply = gallery_router.api_tools_apply_gps(
            gallery_router.ApplyGpsPayload(items=[
                gallery_router.GpsApplyItem(source_path="src_dark_gps", latitude=gps_item["suggested_lat"], longitude=gps_item["suggested_lon"])
            ])
        )
        self.assertEqual(gps_apply["updated"], 1)

        det_ppl = gallery_router.api_tools_suggestions_details(kind="people")
        self.assertEqual(len(det_ppl["merge_pairs"]), 1)
        self.assertEqual(det_ppl["unnamed_persons"][0]["person_id"], 2)

        det_scr = gallery_router.api_tools_suggestions_details(kind="screenshots", min_age_days=90)
        self.assertIn("src_ev_0", [it["source_path"] for it in det_scr["items"]])

        det_short = gallery_router.api_tools_suggestions_details(kind="large", mode="short_videos")
        self.assertEqual([it["source_path"] for it in det_short["items"]], ["src_short_v"])

        det_rot = gallery_router.api_tools_suggestions_details(kind="rotation")
        self.assertEqual([it["source_path"] for it in det_rot["items"]], ["src_rot"])
        rot_apply = gallery_router.api_tools_apply_rotation(
            gallery_router.ApplyRotationPayload(items=[gallery_router.RotationApplyItem(source_path="src_rot", rotate=90)])
        )
        self.assertEqual(rot_apply["rotated"], 1)
        with Image.open(rot_img) as rotated_im:
            self.assertEqual(rotated_im.size, (80, 160))

        # Enregistrement des tâches Suggestions dans le pipeline / activités
        for tc in ("BLUR", "ROTATION", "SUGGESTIONS"):
            self.assertIn(tc, pipeline_runner.TASK_REGISTRY)
            pending, _msg = pipeline_runner._count_pending_items_for_task(
                {"db_path": str(database.get_active_db_and_dest()[0])}, tc
            )
            self.assertEqual(pending, 0)

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

        # UI Doublons & Similaires modernisée + Mode Auto + Options de page
        html = main.templates.get_template("index.html").render()
        for tok in (
            'id="dups-sticky-header"', 'id="dups-options-btn"', 'id="dups-options-drawer"',
            'id="dups-page-settings-btn"', 'id="dups-sort-by"', 'id="dups-sort-dir-btn"',
            'id="dups-filter-by"', 'id="dups-layout-btn-GRID"', 'id="dups-layout-btn-MASONRY"',
            'id="dups-size-btn-SM"', 'id="dups-auto-btn"', 'id="dups-auto-panel"',
            'id="dups-auto-priority"', 'id="dups-add-priority-btn"', 'id="dups-extra-priorities"',
            'id="dups-auto-chk-exact-only"', 'id="dups-auto-chk-albums"', 'id="dups-auto-chk-trash"',
            'id="dups-progress-card"',
            'id="similar-sticky-header"', 'id="similar-options-btn"', 'id="similar-options-drawer"',
            'id="similar-page-settings-btn"', 'id="similar-sort-by"', 'id="similar-sort-dir-btn"',
            'id="similar-filter-by"', 'id="similar-layout-btn-GRID"', 'id="similar-layout-btn-MASONRY"',
            'id="similar-size-btn-SM"', 'id="similar-auto-btn"', 'id="similar-auto-panel"',
            'id="similar-auto-priority"', 'id="similar-add-priority-btn"', 'id="similar-extra-priorities"',
            'id="similar-auto-chk-exact-only"', 'id="similar-auto-chk-albums"', 'id="similar-auto-chk-trash"',
            'id="similar-progress-card"', 'id="dups-summary-bar"', 'id="similar-summary-bar"',
            'id="autodup-add-priority-btn"', 'id="autodup-extra-priorities"', 'id="autodup-chk-exact-only"',
            'id="compare-modal"', 'id="compare-modal-grid"', 'id="lb-duplicates-bar"', 'id="lb-btn-compare"',
        ):
            self.assertIn(tok, html)

        ai_js = (ROOT_DIR / "frontend" / "static" / "js" / "ai_views.js").read_text(encoding="utf-8")
        app_js = (ROOT_DIR / "frontend" / "static" / "js" / "app.js").read_text(encoding="utf-8")
        gallery_js = (ROOT_DIR / "frontend" / "static" / "js" / "gallery.js").read_text(encoding="utf-8")
        groups_js = (ROOT_DIR / "frontend" / "static" / "js" / "groups.js").read_text(encoding="utf-8")
        for fn in (
            "function setComparisonLayout(", "function setComparisonSize(",
            "function toggleComparisonSortOrder(", "function togglePageAutoPanel(",
            "function previewPageAutoSelect(", "async function submitPageAutoResolve(",
            "function addPageAutoPriority(", "function _collectWinnersAndLosers(",
            "function openCompareModal(", "function openComparisonItemLightbox(",
            'function renderCompareModal(', 'function _renderComparisonSummaryBar(',
            'function _renderComparisonEmptyState(', 'function _getComparisonBestMetrics(',
            'function _getItemTraitBadges(',
        ):
            self.assertIn(fn, ai_js)
        self.assertIn('Guide de sélection', html)
        self.assertIn("function openLightboxForComparisonGroup(", gallery_js)
        self.assertIn("function _renderLightboxDuplicatesBar(", gallery_js)
        self.assertIn("function toggleDupsOptionsBar(", app_js)
        self.assertIn("function toggleSimilarOptionsBar(", app_js)
        self.assertIn("function formatTime(", app_js)
        self.assertIn("function formatDateTime(", app_js)
        self.assertIn("function _syncAnalysisProgressCard(", app_js)
        self.assertIn("function _revealAnalysisProgressCard(", app_js)
        self.assertIn("dups:", groups_js)
        self.assertIn("similar:", groups_js)

        # Résolution automatique des similaires : conserve la meilleure résolution, fusionne les albums et met le reste à la corbeille
        conn = database.get_db()
        sim_hi = self.dest_dir / "sim_hi.jpg"
        sim_lo = self.dest_dir / "sim_lo.jpg"
        sim_hi.write_bytes(b"hi")
        sim_lo.write_bytes(b"lo")
        phash_hex = "0123456789abcdef"
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, phash, width, height, file_size, album_name) VALUES (?, ?, ?, 'ok', ?, 4000, 3000, 5000, 'Vacances')",
            ("src_sim_hi", str(sim_hi), str(sim_hi), phash_hex),
        )
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, phash, width, height, file_size, album_name) VALUES (?, ?, ?, 'ok', ?, 800, 600, 500, 'Eté')",
            ("src_sim_lo", str(sim_lo), str(sim_lo), phash_hex),
        )
        conn.commit()
        conn.close()

        sim_res = gallery_router.api_auto_resolve_similar(gallery_router.AutoResolveDuplicatesPayload(
            mode="KEEP_ONE", priority="BEST_QUALITY", update_albums=True, move_to_trash=True,
        ))
        self.assertEqual(sim_res["status"], "resolved")
        self.assertEqual(sim_res["resolved_count"], 1)
        conn = database.get_db()
        hi_row = conn.execute("SELECT is_trashed, album_name FROM processed_files WHERE source_path = 'src_sim_hi'").fetchone()
        lo_row = conn.execute("SELECT is_trashed FROM processed_files WHERE source_path = 'src_sim_lo'").fetchone()
        conn.close()
        self.assertEqual(hi_row["is_trashed"], 0)
        self.assertIn("Eté", hi_row["album_name"])
        self.assertIn("Vacances", hi_row["album_name"])
        self.assertEqual(lo_row["is_trashed"], 1)

        # Priorités en chaîne (ex: BEST_QUALITY puis OLDEST) + règle exact_only
        sim_old = self.dest_dir / "sim_old_tie.jpg"
        sim_new = self.dest_dir / "sim_new_tie.jpg"
        sim_old.write_bytes(b"old")
        sim_new.write_bytes(b"new_bigger")
        phash_hex_2 = "fedcba9876543210"
        conn = database.get_db()
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, phash, timestamp, width, height, file_size) VALUES (?, ?, ?, 'ok', ?, 1000, 4000, 3000, 2000)",
            ("src_sim_old_tie", str(sim_old), str(sim_old), phash_hex_2),
        )
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, phash, timestamp, width, height, file_size) VALUES (?, ?, ?, 'ok', ?, 2000, 4000, 3000, 9000)",
            ("src_sim_new_tie", str(sim_new), str(sim_new), phash_hex_2),
        )
        conn.commit()
        conn.close()

        # exact_only=True sur ces 2 similaires aux dates et tailles distinctes : 0 traité
        skip_exact = gallery_router.api_auto_resolve_similar(gallery_router.AutoResolveDuplicatesPayload(
            mode="KEEP_ONE", priorities=["BEST_QUALITY", "OLDEST"], exact_only=True, move_to_trash=True,
        ))
        self.assertEqual(skip_exact["resolved_count"], 0)

        # exact_only=False avec BEST_QUALITY puis OLDEST : le plus ancien (ts=1000) gagne malgré file_size inférieur
        chain_res = gallery_router.api_auto_resolve_similar(gallery_router.AutoResolveDuplicatesPayload(
            mode="KEEP_ONE", priorities=["BEST_QUALITY", "OLDEST"], exact_only=False, move_to_trash=True,
        ))
        self.assertEqual(chain_res["resolved_count"], 1)
        conn = database.get_db()
        old_r = conn.execute("SELECT is_trashed FROM processed_files WHERE source_path = 'src_sim_old_tie'").fetchone()
        new_r = conn.execute("SELECT is_trashed FROM processed_files WHERE source_path = 'src_sim_new_tie'").fetchone()

        # Doublons exacts : même hash mais dates différentes ignorés avec exact_only=True, mêmes (date, qualité, taille) résolus
        dup_a1 = self.dest_dir / "ex_a1.jpg"
        dup_a2 = self.dest_dir / "ex_a2.jpg"
        dup_b1 = self.dest_dir / "ex_b1.jpg"
        dup_b2 = self.dest_dir / "ex_b2.jpg"
        for p in (dup_a1, dup_a2, dup_b1, dup_b2):
            p.write_bytes(b"same")
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, blake3_hash, timestamp, width, height, file_size) VALUES (?, ?, ?, 'ok', 'b3_diff_date', 1000, 1920, 1080, 500)",
            ("src_ex_a1", str(dup_a1), str(dup_a1)),
        )
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, blake3_hash, timestamp, width, height, file_size) VALUES (?, ?, ?, 'ok', 'b3_diff_date', 2000, 1920, 1080, 500)",
            ("src_ex_a2", str(dup_a2), str(dup_a2)),
        )
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, blake3_hash, timestamp, width, height, file_size) VALUES (?, ?, ?, 'ok', 'b3_exact_all', 3000, 1920, 1080, 500)",
            ("src_ex_b1", str(dup_b1), str(dup_b1)),
        )
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, blake3_hash, timestamp, width, height, file_size) VALUES (?, ?, ?, 'ok', 'b3_exact_all', 3000, 1920, 1080, 500)",
            ("src_ex_b2", str(dup_b2), str(dup_b2)),
        )
        conn.commit()
        conn.close()

        dup_exact_res = gallery_router.api_auto_resolve_duplicates(gallery_router.AutoResolveDuplicatesPayload(
            mode="KEEP_ONE", priorities=["BEST_QUALITY", "OLDEST"], exact_only=True, move_to_trash=True,
        ))
        self.assertEqual(dup_exact_res["resolved_count"], 1)
        conn = database.get_db()
        a_trashed = conn.execute("SELECT COUNT(*) FROM processed_files WHERE source_path IN ('src_ex_a1', 'src_ex_a2') AND is_trashed = 1").fetchone()[0]
        b_trashed = conn.execute("SELECT COUNT(*) FROM processed_files WHERE source_path IN ('src_ex_b1', 'src_ex_b2') AND is_trashed = 1").fetchone()[0]

        # /api/media/duplicates ne retourne que les doublons propres au média ciblé (src_ex_a1 + src_ex_a2)
        own_dups = gallery_router.api_get_media_duplicates("src_ex_a1")
        own_srcs = {it["source_path"] for it in own_dups["items"]}
        self.assertEqual(own_srcs, {"src_ex_a1", "src_ex_a2"})
        # Un fichier sans autre doublon non mis à la corbeille retourne []
        self.assertEqual(gallery_router.api_get_media_duplicates("src_ex_b1")["items"], [])

        # Hydratation automatique de la qualité (width/height) pour les vidéos même si stockée à 0 en DB
        import cv2
        import numpy as np
        vid_a = self.dest_dir / "vid_dup_a.avi"
        vid_b = self.dest_dir / "vid_dup_b.avi"
        fourcc = cv2.VideoWriter_fourcc(*"MJPG")
        for vp in (vid_a, vid_b):
            vw = cv2.VideoWriter(str(vp), fourcc, 5.0, (320, 240))
            vw.write(np.zeros((240, 320, 3), dtype=np.uint8))
            vw.release()
        _, _, _, _, sig_w, sig_h = dedup.compute_file_signatures(("src_vid_a", str(vid_a), True))
        self.assertEqual((sig_w, sig_h), (320, 240))

        conn = database.get_db()
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, blake3_hash, is_duplicate, duplicate_of, width, height, file_size) VALUES (?, ?, ?, 'ok', 'b3_vid_dup', 0, NULL, 0, 0, ?)",
            ("src_vid_a", str(vid_a), str(vid_a), vid_a.stat().st_size),
        )
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, blake3_hash, is_duplicate, duplicate_of, width, height, file_size) VALUES (?, ?, ?, 'ok', 'b3_vid_dup', 1, 'src_vid_a', 0, 0, ?)",
            ("src_vid_b", str(vid_b), str(vid_b), vid_b.stat().st_size),
        )
        conn.commit()
        conn.close()

        vid_own = gallery_router.api_get_media_duplicates("src_vid_a")
        self.assertEqual(len(vid_own["items"]), 2)
        for it in vid_own["items"]:
            self.assertEqual((it["width"], it["height"]), (320, 240))
        conn = database.get_db()
        db_dims = conn.execute("SELECT width, height FROM processed_files WHERE source_path = 'src_vid_b'").fetchone()
        self.assertEqual((db_dims["width"], db_dims["height"]), (320, 240))
        conn.close()
        self.assertEqual(old_r["is_trashed"], 0)
        self.assertEqual(new_r["is_trashed"], 1)
        self.assertEqual(a_trashed, 0)
        self.assertEqual(b_trashed, 1)

    def test_duplicates_vs_similar_separation_and_videos(self):
        import pipeline_runner
        import deduplicateur as dedup_mod
        import indexeur_similaires as sim_ai

        conn = database.get_db()
        dedup_mod.upgrade_db(conn)
        sim_ai.upgrade_db_for_video_similarity(conn)

        # 1) Deux copies strictement identiques (même fichier, même contenu) scannées par DEDUP :
        #    - ne doivent PAS être déplacées automatiquement en quarantaine
        #    - doivent apparaître dans Doublons & /api/stats
        #    - ne doivent JAMAIS apparaître dans Similaires (même avec phash identique)
        import random
        f_orig = self.dest_dir / "copy_orig.jpg"
        f_copy = self.dest_dir / "copy_dup.jpg"
        from PIL import Image
        im = Image.new("RGB", (64, 64))
        for y in range(64):
            for x in range(64):
                im.putpixel((x, y), ((x * 7) % 255, (y * 11) % 255, ((x ^ y) * 5) % 255))
        im.save(f_orig, "JPEG")
        f_copy.write_bytes(f_orig.read_bytes())

        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, is_duplicate, is_trashed) VALUES (?, ?, ?, 'ok', 0, 0)",
            ("src_copy_orig", str(f_orig), str(f_orig)),
        )
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, is_duplicate, is_trashed) VALUES (?, ?, ?, 'ok', 0, 0)",
            ("src_copy_dup", str(f_copy), str(f_copy)),
        )

        # 2) Deux photos similaires éloignées (>120 fichiers d'écart) avec blake3_hash distincts mais phash proche
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, blake3_hash, phash, timestamp, width, height, file_size, is_duplicate, is_trashed) "
            "VALUES ('src_far_1', ?, ?, 'ok', 'b3_far_1', '0000000000000000', 2000000, 1200, 900, 1000, 0, 0)",
            (str(f_orig), str(f_orig)),
        )
        rng = random.Random(42)
        for idx in range(130):
            filler_hash = f"{rng.getrandbits(64):016x}"
            conn.execute(
                "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, blake3_hash, phash, timestamp, width, height, file_size, is_duplicate, is_trashed) "
                "VALUES (?, ?, ?, 'ok', ?, ?, ?, 800, 600, 500, 0, 0)",
                (f"src_filler_{idx}", str(f_orig), str(f_orig), f"b3_fill_{idx}", filler_hash, 1999000 - idx),
            )
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, blake3_hash, phash, timestamp, width, height, file_size, is_duplicate, is_trashed) "
            "VALUES ('src_far_2', ?, ?, 'ok', 'b3_far_2', '0000000000000003', 1000, 1200, 900, 950, 0, 0)",
            (str(f_orig), str(f_orig)),
        )

        # 3) Deux vidéos visuellement proches (video_hash proche, blake3_hash différents)
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, blake3_hash, video_hash, duration_sec, width, height, file_size, is_duplicate, is_trashed) "
            "VALUES ('src_v_sim1', 'v1.mp4', 'v1.mp4', 'ok', 'b3_v1', '1111111111111111-2222222222222222-3333333333333333', 10.0, 1920, 1080, 5000, 0, 0)",
        )
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, blake3_hash, video_hash, duration_sec, width, height, file_size, is_duplicate, is_trashed) "
            "VALUES ('src_v_sim2', 'v2.mp4', 'v2.mp4', 'ok', 'b3_v2', '1111111111111110-2222222222222223-3333333333333331', 10.5, 1280, 720, 2500, 0, 0)",
        )
        conn.commit()
        conn.close()

        # Exécuter l'étape de déduplication
        pipeline_runner.run_step_deduplication({"db_path": str(self.db_path), "dest_dir": str(self.dest_dir)})

        # Aucun fichier ne doit avoir été déplacé ni marqué is_duplicate=1 automatiquement
        self.assertTrue(f_orig.exists())
        self.assertTrue(f_copy.exists())
        conn = database.get_db()
        flags = [r["is_duplicate"] for r in conn.execute("SELECT is_duplicate FROM processed_files WHERE source_path IN ('src_copy_orig', 'src_copy_dup')").fetchall()]
        conn.close()
        self.assertEqual(flags, [0, 0])

        # Doublons exacts bien affichés sur /api/duplicates (via blake3_hash)
        dup_groups = gallery_router.api_get_duplicates()["groups"]
        dup_src_sets = [
            {g["master"]["source_path"], *(d["source_path"] for d in g["duplicates"])}
            for g in dup_groups
        ]
        self.assertIn({"src_copy_orig", "src_copy_dup"}, dup_src_sets)

        # Similaires : NE contient PAS la paire de doublons exacts, MAIS contient les photos éloignées et les vidéos proches
        sim_groups = gallery_router.api_get_similar_groups()["groups"]
        sim_src_sets = [{it["source_path"] for it in g} for g in sim_groups]
        self.assertNotIn({"src_copy_orig", "src_copy_dup"}, sim_src_sets)
        self.assertIn({"src_far_1", "src_far_2"}, sim_src_sets)
        self.assertIn({"src_v_sim1", "src_v_sim2"}, sim_src_sets)

        # Compteurs /api/stats cohérents
        stats = system_router.api_stats()
        self.assertGreaterEqual(stats["duplicates"], 1)
        self.assertEqual(stats["similar_count"], len(sim_groups))

        # Relancer DEDUP / SIMILAR alors que rien n'a changé : message explicite "nothing_to_do"
        fake_cfg = {
            "active_library": "test",
            "libraries": {"test": {"name": "test", "db_path": str(self.db_path), "dest_dir": str(self.dest_dir)}},
        }
        with patch.object(pipeline_runner, "load_libraries", return_value=fake_cfg):
            res_ded = pipeline_runner.start_specific_task("DEDUP")
            self.assertEqual(res_ded["status"], "nothing_to_do")
            self.assertIn("Aucune analyse nécessaire", res_ded["message"])
            res_sim = pipeline_runner.start_specific_task("SIMILAR")
            self.assertEqual(res_sim["status"], "nothing_to_do")
            self.assertIn("Aucune analyse nécessaire", res_sim["message"])

        html = main.templates.get_template("index.html").render()
        self.assertIn('id="app-toast"', html)
        app_js = (ROOT_DIR / "frontend" / "static" / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn("function showAppToast(", app_js)

    def test_trash_and_restore(self):
        img = self.dest_dir / "2024" / "photo.jpg"
        img.parent.mkdir(parents=True, exist_ok=True)
        img.write_bytes(b"data")

        conn = database.get_db()
        conn.execute(
            "INSERT INTO processed_files (source_path, dest_path, original_dest_path, status, file_size, width, height, album_name, duration_sec) VALUES (?, ?, ?, 'ok', 4, 1920, 1080, 'Vacances', 42.5)",
            ("src_trash", str(img), str(img)),
        )
        conn.commit()
        conn.close()

        gallery_router.api_trash_action(gallery_router.TrashActionPayload(source_paths=["src_trash"], action="MOVE_TO_TRASH"))
        self.assertFalse(img.exists())
        trash_res = gallery_router.api_get_trash_items()
        self.assertEqual(len(trash_res["items"]), 1)
        self.assertEqual(trash_res["items"][0]["width"], 1920)
        self.assertEqual(trash_res["items"][0]["album_name"], "Vacances")
        self.assertEqual(trash_res["items"][0]["duration_sec"], 42.5)
        self.assertEqual(trash_res["retention_days"], 30)

        # Réglage durée de conservation : 14 jours puis illimitée (0)
        gallery_router.api_set_trash_policy(gallery_router.TrashPolicyPayload(retention_days=14))
        self.assertEqual(gallery_router.api_get_trash_items()["retention_days"], 14)
        gallery_router.api_set_trash_policy(gallery_router.TrashPolicyPayload(retention_days=0))
        tr_manual = gallery_router.api_get_trash_items()
        self.assertEqual(tr_manual["retention_days"], 0)
        self.assertIsNone(tr_manual["items"][0]["days_left"])

        gallery_router.api_trash_action(gallery_router.TrashActionPayload(source_paths=["src_trash"], action="RESTORE"))
        self.assertTrue(img.exists())
        self.assertEqual(len(gallery_router.api_get_trash_items()["items"]), 0)

        # Interface Corbeille modernisée (sélection, tout restaurer, options, réglages durée)
        html = main.templates.get_template("index.html").render()
        for tok in (
            'id="trash-sticky-header"', 'id="trash-options-btn"', 'id="trash-options-drawer"',
            'id="trash-page-settings-btn"', 'id="trash-sort-by"', 'id="trash-sort-dir-btn"',
            'id="trash-group-by"', 'id="trash-layout-btn-GRID"', 'id="trash-layout-btn-MASONRY"',
            'id="trash-layout-btn-LIST"', 'id="trash-size-btn-SM"', 'id="trash-restore-all-btn"',
            'id="trash-batch-bar"', 'id="trash-retention-badge"',
            'id="ps-trash-policy-section"', 'id="ps-trash-retention-days"',
        ):
            self.assertIn(tok, html)

        gallery_js = (ROOT_DIR / "frontend" / "static" / "js" / "gallery.js").read_text(encoding="utf-8")
        app_js = (ROOT_DIR / "frontend" / "static" / "js" / "app.js").read_text(encoding="utf-8")
        groups_js = (ROOT_DIR / "frontend" / "static" / "js" / "groups.js").read_text(encoding="utf-8")
        self.assertIn("function toggleTrashOptionsBar(", app_js)
        for fn in (
            "function setTrashLayout(", "function setTrashSize(", "function toggleTrashSortOrder(",
            "function toggleSelectAllTrash(", "async function restoreAllTrash(",
            "async function restoreSelectedTrash(", "function renderTrashFromCache(",
            "function updateTrashBatchBar(",
        ):
            self.assertIn(fn, gallery_js)
        self.assertIn("_isTrashContext", gallery_js)
        self.assertIn("trash:", groups_js)

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
        for tl_tok in ('id="timeline-hover-indicator"', 'id="timeline-hover-pill"', 'id="timeline-hover-line"', 'id="timeline-scroll-marker"'):
            self.assertIn(tl_tok, html)
        theme_css_tl = (ROOT_DIR / "frontend" / "static" / "css" / "theme.css").read_text(encoding="utf-8")
        self.assertIn("#gallery-timeline-wrapper:hover #gallery-timeline-box", theme_css_tl)
        self.assertIn("body.has-gallery-timeline #main-scroll-container", theme_css_tl)
        self.assertIn("body.has-gallery-timeline #tab-gallery", theme_css_tl)
        self.assertIn("padding-right: 20px;", theme_css_tl)
        self.assertIn("scrollbar-width: none;", theme_css_tl)
        self.assertIn(".tl-gp-year", theme_css_tl)
        self.assertIn(".tl-gp-dot", theme_css_tl)
        self.assertIn("#timeline-hover-line", theme_css_tl)
        self.assertNotIn("timeline-visible", theme_css_tl)
        gallery_js_alb = (ROOT_DIR / "frontend" / "static" / "js" / "gallery.js").read_text(encoding="utf-8")
        self.assertNotIn("pulseGalleryTimelinePeek", gallery_js_alb)
        self.assertIn("function _initGooglePhotosTimelineScrubber(", gallery_js_alb)
        self.assertIn("function _findTimelineSegmentAtClientY(", gallery_js_alb)
        self.assertIn("function _scheduleScrubJump(", gallery_js_alb)
        self.assertIn("_pendingGalleryCustomSkip", gallery_js_alb)
        app_js_tl = (ROOT_DIR / "frontend" / "static" / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn("has-gallery-timeline", app_js_tl)
        self.assertIn("bg-rose-500/25 backdrop-blur-md", gallery_js_alb)
        self.assertNotIn("drop-shadow-[0_1px_2px_rgba(0,0,0,0.45)]", gallery_js_alb)
        self.assertIn("#10b981", theme_css_tl)
        self.assertIn("justify-content: space-between;", theme_css_tl)
        self.assertNotIn("justify-content: flex-start;", theme_css_tl)
        self.assertIn("body.has-stuck-options-open #gal-batch-bar", theme_css_tl)
        self.assertIn("has-stuck-options-open", gallery_js_alb)
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
            'id="places-sticky-header"',
            'id="places-options-btn"',
            'id="places-options-drawer"',
            'id="places-sort-by"',
            'id="places-group-by"',
            'id="places-filter-btn"',
            'id="places-filter-popover"',
            'id="places-content-filter"',
            'id="places-layout-btn-GRID"',
            'id="places-layout-btn-LIST"',
            'id="places-size-btn-SM"',
            'id="places-size-btn-MD"',
            'id="places-size-btn-LG"',
            'id="places-active-filter-badge"',
            'id="world-map-card"',
            'id="map-viewport-filter-btn"',
            'Filtrer selon la carte',
            'id="map-height-btn-SM"',
            'Petite',
            'Moyenne',
            'Grande',
            'id="map-collapse-btn"',
            'id="place-single-sticky-header"',
            'id="place-single-options-btn"',
            'id="map-add-btn"',
            'id="place-single-panel"',
            'id="settings-home-country"',
        ):
            self.assertIn(marker_fp, html)
        ai_views_js = (ROOT_DIR / "frontend" / "static" / "js" / "ai_views.js").read_text(encoding="utf-8")
        app_js_fp = (ROOT_DIR / "frontend" / "static" / "js" / "app.js").read_text(encoding="utf-8")
        groups_js_fp = (ROOT_DIR / "frontend" / "static" / "js" / "groups.js").read_text(encoding="utf-8")
        self.assertIn("function toggleFacesOptionsBar(", app_js_fp)
        self.assertIn("function togglePlacesOptionsBar(", app_js_fp)
        self.assertIn("function toggleFacesSortOrder(", ai_views_js)
        self.assertIn("function togglePlacesSortOrder(", ai_views_js)
        self.assertIn("function _comparePersonItems(", ai_views_js)
        self.assertIn("function _comparePlaceItems(", ai_views_js)
        self.assertIn("function _filterPersonsList(", ai_views_js)
        self.assertIn("function _filterPlacesList(", ai_views_js)
        self.assertIn("function setFacesLayout(", ai_views_js)
        self.assertIn("function setFacesSize(", ai_views_js)
        self.assertIn("function setPlacesLayout(", ai_views_js)
        self.assertIn("function setPlacesSize(", ai_views_js)
        self.assertIn("function setMapHeightMode(", ai_views_js)
        self.assertIn("function toggleMapViewportFilter(", ai_views_js)
        self.assertIn("function fitWorldMapToMarkers(", ai_views_js)
        self.assertIn("person-card", ai_views_js)
        self.assertIn("place-card", ai_views_js)
        self.assertIn("openSinglePlaceView", ai_views_js)
        self.assertIn("function togglePersonFaceEditMode(", ai_views_js)
        self.assertIn("appendMediaBatchToContainer('tl-faces-grid', items, 0, true)", ai_views_js)
        self.assertIn("GROUP_OPTIONS_DRAWER_IDS", groups_js_fp)
        self.assertIn("function _isCustomGroupOptionsOpen(", groups_js_fp)

        # Favoris séparés de Galerie (#tab-favorites dédié)
        for fav_tok in (
            'id="tab-favorites"',
            'id="favorites-sticky-header"',
            'id="fav-total-label"',
            'id="fav-options-btn"',
            'id="favorites-content-area"',
            'id="favorites-scroll-sentinel"',
        ):
            self.assertIn(fav_tok, html)
        gallery_js_fp = (ROOT_DIR / "frontend" / "static" / "js" / "gallery.js").read_text(encoding="utf-8")
        self.assertIn("function _getActiveGalleryViewIds(", gallery_js_fp)
        self.assertIn("function _getActiveMediaPrefKey(", gallery_js_fp)
        self.assertIn("function syncActiveMediaPrefsFromStorage(", gallery_js_fp)
        self.assertIn("border-radius: 28px 0 0 28px;", theme_css_tl)
        self.assertIn("rounded-l-[28px] rounded-r-none", html)
        self.assertIn("appendMediaBatchToContainer('place-single-grid', sortedItems, 0, true)", ai_views_js)
        self.assertIn("place_single:", groups_js_fp)
        self.assertIn(".sticky-options-header.is-stuck #places-filter-popover", theme_css_tl)
        self.assertIn("#world-map .leaflet-tile-pane", theme_css_tl)
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
            "settings-appearance-preview", "theme-oled-toggle", "setAppOled(",
            "style-btn-glass", "style-btn-solid", "shadows-off-toggle", "setAppNoShadows(",
            "setAppStyle('glass')", "setAppStyle('solid')",
            "lbstyle-btn-studio", "lbstyle-btn-classic",
            "setAppLightboxStyle('studio')", "setAppLightboxStyle('classic')",
            "accent-btn-default", "accent-btn-slate", "accent-btn-midnight", "accent-btn-blue",
            "accent-btn-custom", "accent-custom-picker",
            "settings-appearance-advanced",
            "fav-accent-btn-on", "radius-btn-square", "gap-btn-tight", "motion-btn-off",
        ):
            self.assertIn(token, html)
        for removed in ("theme-btn-oled", "accent-btn-sepia", "accent-btn-red", "accent-btn-orange", "style-btn-flat"):
            self.assertNotIn(removed, html)

        tab_settings_html = html[html.index('id="tab-settings"'):html.index('id="tab-activities"')]
        self.assertNotIn("sticky-view-header", tab_settings_html)
        self.assertIn("settings-power-bar", tab_settings_html)
        theme_css = (ROOT_DIR / "frontend" / "static" / "css" / "theme.css").read_text(encoding="utf-8")
        self.assertIn("#settings-power-bar.is-floating", theme_css)
        self.assertIn('html[data-theme="oled"]', theme_css)
        self.assertIn('html[data-shadows="off"]', theme_css)
        self.assertIn('html[data-blur="off"]', theme_css)
        self.assertIn('html[data-blur="off"] #lightbox-modal', theme_css)
        self.assertIn('html[data-lightbox-style="classic"] #lightbox-modal', theme_css)
        self.assertIn(':is(html[data-theme="dark"], html[data-theme="oled"]):not([data-lightbox-style="classic"]):not([data-blur="off"]) #lightbox-modal', theme_css)
        self.assertIn('html[data-fav-accent="on"] .fav-badge-active', theme_css)
        self.assertIn('html[data-radius="square"]', theme_css)
        self.assertIn('html[data-gap="tight"]', theme_css)
        self.assertIn('html[data-motion="off"]', theme_css)
        self.assertIn("--sel-color: #10b981;", theme_css)
        for acc in ("blue", "slate", "midnight", "custom"):
            self.assertIn(f'html[data-accent="{acc}"]', theme_css)
        for removed_acc in ("sepia", "red", "yellow", "green", "pink", "purple", "orange"):
            self.assertNotIn(f'html[data-accent="{removed_acc}"]', theme_css)

        app_js = (ROOT_DIR / "frontend" / "static" / "js" / "app.js").read_text(encoding="utf-8")
        for tok in (
            "window.appSettings", "browseTakeoutExtractDir", "clearTakeoutExtractDir",
            "takeout_default_architecture", "_syncSettingsPowerBar",
            "function setAppStyle(", "function setAppOled(", "function setAppNoShadows(",
            "function setAppLightboxStyle(",
            "function setAppAccent(", "function setAppCustomAccentColor(",
            "function setAppFavMatchAccent(", "function setAppTileRadius(",
            "function setAppGridGap(", "function setAppReduceMotion(",
        ):
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
                ui_blur=False,
                ui_style="solid",
                ui_lightbox_style="classic",
                ui_oled=True,
                ui_no_shadows=True,
                ui_accent="custom",
                ui_accent_custom="#e11d48",
                ui_fav_match_accent=True,
                ui_tile_radius="square",
                ui_grid_gap="tight",
                ui_reduce_motion=True,
            ))
            saved = save_res["settings"]
            self.assertFalse(saved["ui_blur"])
            self.assertEqual(saved["ui_style"], "solid")
            self.assertTrue(saved["ui_oled"])
            self.assertTrue(saved["ui_no_shadows"])
            self.assertEqual(saved["ui_accent"], "custom")
            self.assertEqual(saved["ui_accent_custom"], "#e11d48")
            self.assertTrue(saved["ui_fav_match_accent"])
            self.assertEqual(saved["ui_tile_radius"], "square")
            self.assertEqual(saved["ui_grid_gap"], "tight")
            self.assertTrue(saved["ui_reduce_motion"])
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
            "plum-btn",
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
            'id="lb-filmstrip" class="hidden bg-white/10 backdrop-blur-md border border-white/10 rounded-2xl',
            "studio-stage-grid-bg",
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
            "const col = (typeof currentFavMatchAccent !== 'undefined' && currentFavMatchAccent) ? 'var(--sel-color)' : '#fb7185';",
            "icon.setAttribute('fill', col);",
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

        # Deux villes proches dans le même carré toFixed(1) (Lyon vs Villeurbanne) doivent rester distinctes
        with (
            patch.object(search_map_router, "load_settings", return_value={"home_country": "France"}),
            patch.object(search_map_router, "_fetch_nominatim_city", return_value=("Villeurbanne", "Auvergne-Rhône-Alpes", "France", "Villeurbanne, France")),
        ):
            villeurb = search_map_router.api_reverse_geocode(45.7719, 4.8902)
        self.assertEqual(villeurb["city"], "Villeurbanne")

        conn = database.get_db()
        try:
            conn.execute(
                "INSERT INTO processed_files (source_path, dest_path, timestamp, latitude, longitude) VALUES (?, ?, ?, ?, ?)",
                ("src_villeurb.jpg", "villeurb.jpg", 1700000300, 45.7719, 4.8902),
            )
            conn.commit()
        finally:
            conn.close()

        pts_res = search_map_router.api_map_points()
        city_keys = {p.get("source_path"): p.get("city_key") for p in pts_res["points"]}
        self.assertEqual(city_keys.get("src_geo.jpg"), "lyon|france")
        self.assertEqual(city_keys.get("src_villeurb.jpg"), "villeurbanne|france")
        self.assertNotIn("latitude.toFixed(1)", ai_views_js)
        self.assertIn("latitude.toFixed(2)", ai_views_js)
        self.assertIn("city:${cityNorm}|${countryNorm}", ai_views_js)

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
            "hover:bg-rose-500/20 hover:text-rose-400",
            "hover:bg-purple-500/20 hover:text-purple-400",
            "hover:bg-amber-500/20 hover:text-amber-400",
            "hover:bg-sky-500/20 hover:text-sky-400",
            "hover:bg-emerald-500/20 hover:text-emerald-400",
            "hover:bg-indigo-500/20 hover:text-indigo-400",
            "hover:bg-orange-500/20 hover:text-orange-400",
        ):
            self.assertIn(snippet, batch_html)
        self.assertLess(batch_html.index("downloadGalleryBatch()"), batch_html.index("openBatchAnalyzeModal()"))
        self.assertLess(batch_html.index("openBatchAnalyzeModal()"), batch_html.index("openMetadataModalForSelection()"))
        self.assertNotIn("<span>Analyser les médias</span>", batch_html)

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
        self.assertIn("left: calc(var(--sidebar-w, 13rem) + 1.75rem);", theme_css)
        self.assertIn(".sticky-options-toggle {\n  margin-right: 0.5rem;", theme_css)

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
        self.assertNotIn('id="tab-btn-dups"', sidebar_html)
        self.assertNotIn('id="tab-btn-similar"', sidebar_html)
        self.assertNotIn('sub-tools-nav', sidebar_html)
        self.assertLess(sidebar_html.index('id="tab-btn-types"'), sidebar_html.index('id="tab-btn-tools"'))
        self.assertLess(sidebar_html.index('id="tab-btn-tools"'), sidebar_html.index('id="tab-btn-activities"'))
        self.assertLess(sidebar_html.index('id="tab-btn-activities"'), sidebar_html.index('id="tab-btn-trash"'))
        self.assertLess(sidebar_html.index('id="tab-btn-trash"'), sidebar_html.index('id="tab-btn-settings"'))
        self.assertNotIn('sidebar-glass-panel', sidebar_html)
        self.assertIn('id="sidebar-header"', sidebar_html)
        self.assertNotIn('sidebar-header-glass', sidebar_html)
        self.assertIn('id="topbar-logo-box"', sidebar_html)
        self.assertIn('ui-card', sidebar_html[sidebar_html.index('id="topbar-logo-box"'):sidebar_html.index('id="topbar-logo-text"')])
        theme_css = (ROOT_DIR / "frontend" / "static" / "css" / "theme.css").read_text(encoding="utf-8")
        self.assertNotIn('.sidebar-glass-panel', theme_css)
        self.assertNotIn('.sidebar-header-glass', theme_css)
        self.assertNotIn('#sidebar-header::before', theme_css)
        self.assertIn('#floating-topbar::before', theme_css)
        self.assertIn('mask-image:', theme_css)
        self.assertNotIn('rgba(var(--bg-app-rgb)', theme_css)
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

    def test_custom_software_groups_for_all_scopes(self):
        import groups_router
        import gallery_router
        from fastapi import HTTPException

        html = main.templates.get_template("index.html").render()
        for token in (
            'id="custom-group-modal"',
            'id="page-settings-modal"',
            'id="gal-page-settings-btn"',
            'id="alb-page-settings-btn"',
            'id="faces-page-settings-btn"',
            'id="places-page-settings-btn"',
            'id="cg-pref-hide-all"',
            'id="cg-pref-show-count"',
            'id="ps-def-sort-by"',
            'id="albums-groups-bar"',
            'id="faces-groups-bar"',
            'id="places-groups-bar"',
            'id="favorites-groups-bar"',
            'id="gal-batch-group-btn"',
            '/static/js/groups.js',
        ):
            self.assertIn(token, html)

        groups_js = (ROOT_DIR / "frontend" / "static" / "js" / "groups.js").read_text(encoding="utf-8")
        for fn in (
            "async function loadCustomGroups(",
            "function filterItemsByActiveCustomGroup(",
            "async function openCustomGroupModal(",
            "async function submitCustomGroupModal(",
            "async function deleteCustomGroup(",
            "function openPageSettingsModal(",
            "function savePageDefaultOptions(",
            "function applyPageDefaultOptions(",
            "async function moveCustomGroupOrder(",
            "async function renameCustomGroupInline(",
        ):
            self.assertIn(fn, groups_js)
        self.assertNotIn("openCustomGroupsManageModal", groups_js)
        self.assertIn("min-w-[18px] h-[18px] px-1 rounded-full", groups_js)

        # Créer un groupe logiciel pour 3 albums sur 4 (sans toucher aux dossiers Windows)
        created_alb = groups_router.api_create_group(
            groups_router.CreateGroupPayload(scope="albums", name="Vacances", item_keys=["1", "2", "3"])
        )
        self.assertEqual(created_alb["status"], "created")
        gid_alb = created_alb["group"]["group_id"]
        self.assertEqual(created_alb["group"]["item_keys"], ["1", "2", "3"])

        with self.assertRaises(HTTPException) as ctx:
            groups_router.api_create_group(
                groups_router.CreateGroupPayload(scope="albums", name="vacances", item_keys=[])
            )
        self.assertEqual(ctx.exception.status_code, 409)

        # Portées persons et places
        created_per = groups_router.api_create_group(
            groups_router.CreateGroupPayload(scope="persons", name="Famille", item_keys=["10", "20"])
        )
        created_plc = groups_router.api_create_group(
            groups_router.CreateGroupPayload(scope="places", name="Italie", item_keys=["41.9, 12.5"])
        )
        self.assertEqual(len(groups_router.api_list_groups(scope="albums")["groups"]), 1)
        self.assertEqual(len(groups_router.api_list_groups(scope="persons")["groups"]), 1)
        self.assertEqual(len(groups_router.api_list_groups(scope="places")["groups"]), 1)
        self.assertEqual(len(groups_router.api_list_groups()["groups"]), 3)

        # Renommage et mise à jour des éléments (add / remove / replace)
        groups_router.api_rename_group(
            groups_router.RenameGroupPayload(group_id=gid_alb, new_name="Vacances d'été")
        )
        groups_router.api_set_group_items(
            groups_router.SetGroupItemsPayload(group_id=gid_alb, item_keys=["4"], mode="add")
        )
        groups_router.api_set_group_items(
            groups_router.SetGroupItemsPayload(group_id=gid_alb, item_keys=["2"], mode="remove")
        )
        alb_groups = groups_router.api_list_groups(scope="albums")["groups"]
        self.assertEqual(alb_groups[0]["name"], "Vacances d'été")
        self.assertEqual(alb_groups[0]["item_keys"], ["1", "3", "4"])

        # Réorganisation de l'ordre des groupes
        created_alb2 = groups_router.api_create_group(
            groups_router.CreateGroupPayload(scope="albums", name="Travail", item_keys=["2"])
        )
        gid_alb2 = created_alb2["group"]["group_id"]
        groups_router.api_reorder_groups(
            groups_router.ReorderGroupsPayload(scope="albums", group_ids=[gid_alb2, gid_alb])
        )
        reordered = groups_router.api_list_groups(scope="albums")["groups"]
        self.assertEqual([g["group_id"] for g in reordered], [gid_alb2, gid_alb])
        groups_router.api_delete_group(groups_router.DeleteGroupPayload(group_id=gid_alb2))

        # Filtrage des favoris par group_id dans /api/gallery/items
        conn = database.get_db()
        try:
            conn.execute(
                "INSERT INTO processed_files (source_path, dest_path, timestamp, is_favorite) VALUES (?, ?, ?, 1)",
                ("fav_1.jpg", "fav_1.jpg", 1700000100),
            )
            conn.execute(
                "INSERT INTO processed_files (source_path, dest_path, timestamp, is_favorite) VALUES (?, ?, ?, 1)",
                ("fav_2.jpg", "fav_2.jpg", 1700000200),
            )
            conn.commit()
        finally:
            conn.close()

        created_fav = groups_router.api_create_group(
            groups_router.CreateGroupPayload(scope="favorites", name="Top Favoris", item_keys=["fav_1.jpg"])
        )
        fav_gid = created_fav["group"]["group_id"]
        fav_res = gallery_router.api_gallery_items(favorites_only=True, group_id=fav_gid)
        self.assertEqual([it["source_path"] for it in fav_res["items"]], ["fav_1.jpg"])

        # Suppression du groupe : ne supprime aucun média en base
        groups_router.api_delete_group(groups_router.DeleteGroupPayload(group_id=fav_gid))
        self.assertEqual(groups_router.api_list_groups(scope="favorites")["groups"], [])
        all_favs = gallery_router.api_gallery_items(favorites_only=True)
        self.assertEqual(len(all_favs["items"]), 2)
        groups_router.api_delete_group(groups_router.DeleteGroupPayload(group_id=created_per["group"]["group_id"]))
        groups_router.api_delete_group(groups_router.DeleteGroupPayload(group_id=created_plc["group"]["group_id"]))
        groups_router.api_delete_group(groups_router.DeleteGroupPayload(group_id=gid_alb))

    def test_studio_layers_menu_hex_rgb_and_windows_fonts(self):
        modal_html = (Path(__file__).resolve().parent.parent / "frontend" / "templates" / "components" / "modals" / "studio_modal.html").read_text(encoding="utf-8")
        studio_js = (Path(__file__).resolve().parent.parent / "frontend" / "static" / "js" / "studio_exif.js").read_text(encoding="utf-8")

        for token in (
            'id="studio-stab-layers"',
            'id="studio-panel-layers"',
            'id="studio-layers-stack-list"',
            'id="studio-drawer-close-btn"',
            'id="st-bmode-shape"',
            'id="studio-brush-blur-style-row"',
            'id="studio-brush-shape-row"',
            'id="st-imgsrc-gallery"',
            'id="st-imgsrc-pc"',
            'id="studio-tpl-wm-draft-list"',
            'id="studio-tpl-elements-list"',
            'id="studio-tpl-edit-banner"',
            'id="st-tpl-save-overwrite-btn"',
            'id="st-tpl-save-copy-btn"',
            'id="studio-applied-templates-layer"',
            'id="studio-shapes-layer"',
            '>Angle<',
            '>Rotation<',
            '>Retourner<',
            'id="st-brush-pipette-btn"',
            'id="st-text-pipette-btn"',
            'id="st-text-bold"',
            'id="st-text-italic"',
            'id="st-text-shadow"',
            'id="studio-dectab-border"',
            'id="studio-layertab-templates"',
            'id="studio-layertab-create"',
            'id="studio-tpl-apply-customizer"',
            'id="st-border-pipette-btn"',
            'id="st-text-font"',
        ):
            self.assertIn(token, modal_html)
        self.assertNotIn('id="st-bmode-pixelate"', modal_html)
        self.assertNotIn('id="st-brush-hex"', modal_html)
        self.assertNotIn('id="studio-dectab-layers"', modal_html)
        self.assertNotIn('id="studio-decsub-layers"', modal_html)
        self.assertNotIn('id="studio-overlays-list"', modal_html)
        self.assertNotIn('id="studio-stage" class="relative inline-block overflow-hidden rounded-xl', modal_html)
        self.assertNotIn('>◀</button>', modal_html)

        for js_sym in (
            "pickStudioColorWithPipette",
            "setStudioBorderColor",
            "setStudioBrushShape",
            "setStudioBlurStyle",
            "selectStudioImageSource",
            "editStudioTextLayer",
            "editStudioDraftWatermark",
            "removeStudioDraftWatermark",
            "editStudioLayerTemplate",
            "_renderStudioTemplateElementsList",
            "_renderStudioShapesOverlay",
            "removeStudioShapeStroke",
            "toggleStudioCropPreview",
            "bw_high",
            "sepia",
            "vintage",
            "nordic",
            "studioAppliedTemplates",
            "openStudioCreatorDecorationTool",
            "toggleStudioTextStyle",
            "selectStudioLayerSubtab",
            "confirmApplyStudioLayerTemplate",
            "loadStudioSystemFonts",
            "_renderStudioLayersStackUI",
            "toggleStudioDrawerCollapsed(false)",
        ):
            self.assertIn(js_sym, studio_js)

        from backend.routers import metadata_studio_router
        from backend.engines import media_editor
        from fastapi import HTTPException
        from PIL import Image

        fonts_res = metadata_studio_router.api_studio_system_fonts()
        self.assertIsInstance(fonts_res.get("fonts"), list)

        with self.assertRaises(HTTPException) as ctx:
            metadata_studio_router.api_studio_font_file(path="C:/Windows/System32/cmd.exe")
        self.assertIn(ctx.exception.status_code, (403, 404))

        src_img = self.dest_dir / "font_test.jpg"
        Image.new("RGB", (200, 120), (30, 40, 50)).save(src_img)
        font_entry = fonts_res["fonts"][0] if fonts_res["fonts"] else {"family": "Arial", "path": ""}
        out_img = media_editor.process_image_edits(
            src_img,
            {
                "text_overlay": {
                    "text": "Test Font",
                    "nx": 0.1,
                    "ny": 0.2,
                    "size": 28,
                    "color": "#ffffff",
                    "font_family": font_entry.get("family"),
                    "font_path": font_entry.get("path"),
                }
            },
            overwrite=False,
        )
        self.assertTrue(Path(out_img).exists())

    def test_studio_ajuster_order_bg_remove_auto_retouch_and_history(self):
        modal_html = (Path(__file__).resolve().parent.parent / "frontend" / "templates" / "components" / "modals" / "studio_modal.html").read_text(encoding="utf-8")
        studio_js = (Path(__file__).resolve().parent.parent / "frontend" / "static" / "js" / "studio_exif.js").read_text(encoding="utf-8")

        # 1. Ton renommé en Ajuster et placé en 2e position
        self.assertIn("<span>Ajuster</span>", modal_html)
        self.assertLess(modal_html.index('id="studio-stab-transform"'), modal_html.index('id="studio-stab-tone"'))
        self.assertLess(modal_html.index('id="studio-stab-tone"'), modal_html.index('id="studio-stab-filter"'))

        # 2. Curseur remplacé par Historique
        self.assertNotIn('id="studio-tool-NONE"', modal_html)
        for tok in (
            'id="studio-stab-history"',
            'id="studio-panel-history"',
            'id="studio-history-list"',
            'id="st-rmode-bg_remove"',
            'id="st-bg-remove-toggle"',
            'id="st-bg-remove-mode"',
            'id="st-rmode-auto_retouch"',
            'id="st-auto-retouch-toggle"',
        ):
            self.assertIn(tok, modal_html)

        for js_sym in (
            "toggleStudioBgRemove",
            "toggleStudioAutoRetouch",
            "_renderStudioHistoryListUI",
            "removeStudioHistoryModification",
        ):
            self.assertIn(js_sym, studio_js)

        from backend.routers import metadata_studio_router
        from backend.engines import media_editor
        from PIL import Image

        bg_st = metadata_studio_router.api_studio_ai_bg_remove_status()
        self.assertIn("installed", bg_st)

        src_img = self.dest_dir / "tools_test.jpg"
        Image.new("RGB", (180, 140), (180, 130, 110)).save(src_img)

        out_png = media_editor.process_image_edits(
            src_img,
            {
                "auto_retouch": {"enabled": True, "strength": 0.7, "skin_wrinkles": True, "redeye": True, "blemish_glare": True},
                "bg_remove": {"enabled": True, "mode": "transparent"},
            },
            overwrite=False,
        )
        self.assertEqual(Path(out_png).suffix.lower(), ".png")
        self.assertTrue(Path(out_png).exists())

        out_blur = media_editor.process_image_edits(
            src_img,
            {"bg_remove": {"enabled": True, "mode": "blur"}},
            overwrite=False,
        )
        self.assertTrue(Path(out_blur).exists())

        # 3. Sous-onglet Image dans Décoration & Bordures dans Calques
        self.assertIn('id="studio-dectab-image"', modal_html)
        self.assertIn('id="studio-decsub-image"', modal_html)
        self.assertIn('id="studio-borders-card"', modal_html)
        for wtok in (
            'id="st-tpl-wm-type"',
            'id="st-tpl-wm-size"',
            'id="st-tpl-wm-repeat"',
            'id="st-tpl-wm-spacing"',
            'id="st-tpl-wm-validate-btn"',
            'id="st-tpl-wm-clear-btn"',
            'id="studio-wm-preview-layer"',
            'id="st-tpl-save-btn"',
        ):
            self.assertIn(wtok, modal_html)
        self.assertNotIn('> + Calque</button>', modal_html)
        self.assertNotIn('>+ Calque</button>', modal_html)
        self.assertNotIn('Enregistrer en modèle de calque (Watermark)...', modal_html)
        self.assertIn('setStudioBorderStyle', studio_js)
        self.assertIn('saveStudioLayerTemplateUnified', studio_js)
        self.assertIn('previewStudioWatermarkLive', studio_js)
        self.assertIn('validateStudioWatermarkToScene', studio_js)
        self.assertIn('clearStudioWatermarkDraft', studio_js)

        # Test API PUT /api/studio/layer_templates/{id} (écraser un modèle existant)
        created_tpl = metadata_studio_router.api_save_layer_template(
            metadata_studio_router.StudioLayerTemplatePayload(
                name="Modele Initial",
                category="watermark",
                text_layers=[{"text": "© Init", "nx": 0.5, "ny": 0.5, "size": 24, "color": "#ffffff"}],
                image_overlays=[],
            )
        )
        tid = created_tpl["template"]["id"]
        updated_tpl = metadata_studio_router.api_update_layer_template(
            tid,
            metadata_studio_router.StudioLayerTemplatePayload(
                name="Modele Modifie",
                category="watermark",
                text_layers=[{"text": "© Maj", "nx": 0.2, "ny": 0.8, "size": 30, "color": "#fbbf24"}],
                image_overlays=[],
                border={"style": "solid", "color": "#ffffff", "thickness": 3},
            ),
        )
        self.assertEqual(updated_tpl["template"]["id"], tid)
        self.assertEqual(updated_tpl["template"]["name"], "Modele Modifie")
        metadata_studio_router.api_delete_layer_template(tid)
        out_bdr = media_editor.process_image_edits(
            src_img,
            {
                "border": {"style": "polaroid", "color": "#ffffff", "thickness": 4},
                "pixel_strokes": [{"nr": 0.05, "points": [{"nx": 0.2, "ny": 0.2}, {"nx": 0.5, "ny": 0.5}]}],
                "text_overlay": {
                    "text": "Bold Italic",
                    "nx": 0.1,
                    "ny": 0.2,
                    "size": 32,
                    "color": "#ffffff",
                    "bold": True,
                    "italic": True,
                    "shadow": False,
                },
            },
            overwrite=False,
        )
        with Image.open(out_bdr) as bim:
            self.assertGreater(bim.size[0], 180)
            self.assertGreater(bim.size[1], 140)


if __name__ == "__main__":
    unittest.main()
