import sys
import tempfile
import unittest
from pathlib import Path
from datetime import datetime

ROOT_DIR = Path(__file__).resolve().parents[1]
for sub in ("backend/core", "backend/engines", "backend/routers"):
    p = str(ROOT_DIR / sub)
    if p not in sys.path:
        sys.path.insert(0, p)

import fusion_takeout_complet as fusion


class TestFusionTakeout(unittest.TestCase):
    def test_find_matching_json_variants(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)

            # 1. Standard .supplemental-metadata.json
            img1 = d / "IMG_001.jpg"
            img1.write_bytes(b"a")
            j1 = d / "IMG_001.jpg.supplemental-metadata.json"
            j1.write_text("{}", encoding="utf-8")
            self.assertEqual(fusion.find_matching_json(img1), j1)

            # 2. Duplicate (1) suffix
            img2 = d / "IMG_002(1).jpg"
            img2.write_bytes(b"a")
            j2 = d / "IMG_002.jpg(1).json"
            j2.write_text("{}", encoding="utf-8")
            self.assertEqual(fusion.find_matching_json(img2), j2)

            # 3. Edited suffix (-modifié)
            img3 = d / "IMG_003-modifié.jpg"
            img3.write_bytes(b"a")
            j3 = d / "IMG_003.jpg.json"
            j3.write_text("{}", encoding="utf-8")
            self.assertEqual(fusion.find_matching_json(img3), j3)

            # 4. Long truncated filename (>= 44 chars)
            long_stem = "A" * 46
            img4 = d / f"{long_stem}_extra.jpg"
            img4.write_bytes(b"a")
            j4 = d / f"{long_stem[:44]}.json"
            j4.write_text("{}", encoding="utf-8")
            self.assertEqual(fusion.find_matching_json(img4), j4)

            # 5. Truncated .supplemental-metadata on medium filename (< 44 chars)
            img_trunc = d / "vacances_corse_photo_01.jpg"
            img_trunc.write_bytes(b"a")
            j_trunc = d / "vacances_corse_photo_01.jpg.supplem.json"
            j_trunc.write_text("{}", encoding="utf-8")
            self.assertEqual(fusion.find_matching_json(img_trunc), j_trunc)

            # 6. Edited + duplicate (1) + brackets in filename
            img_edit_dup = d / "photo_[hdr]-edited(2).jpg"
            img_edit_dup.write_bytes(b"a")
            j_edit_dup = d / "photo_[hdr].jpg.supplemental-metadata(2).json"
            j_edit_dup.write_text('{"photoTakenTime":{"timestamp":"1700000000"}}', encoding="utf-8")
            self.assertEqual(fusion.find_matching_json(img_edit_dup), j_edit_dup)

            # 7. Live Photo video paired with HEIC JSON
            vid_live = d / "IMG_LIVE_99.MP4"
            vid_live.write_bytes(b"a")
            j_live = d / "IMG_LIVE_99.HEIC.supplemental-metadata.json"
            j_live.write_text('{"photoTakenTime":{"timestamp":"1700000123"}}', encoding="utf-8")
            self.assertEqual(fusion.find_matching_json(vid_live), j_live)

            # 8. Cross-root split Takeout archives (mirror folder + global fallback)
            t1_year = d / "takeout-001" / "Google Photos" / "Photos from 2022"
            t2_year = d / "takeout-002" / "Takeout" / "Google Photos" / "Photos from 2022"
            t3_other = d / "takeout-003" / "Google Photos" / "Vacances"
            t1_year.mkdir(parents=True)
            t2_year.mkdir(parents=True)
            t3_other.mkdir(parents=True)

            split_img = t1_year / "SPLIT_001.jpg"
            split_img.write_bytes(b"a")
            split_json = t2_year / "SPLIT_001.jpg.supplemental-metadata.json"
            split_json.write_text('{"photoTakenTime":{"timestamp":"1700001000"}}', encoding="utf-8")
            self.assertEqual(
                fusion.find_matching_json(split_img, extra_roots=[d / "takeout-001", d / "takeout-002", d / "takeout-003"]),
                split_json,
            )

            other_img = t1_year / "CROSS_ALBUM_002.jpg"
            other_img.write_bytes(b"a")
            other_json = t3_other / "CROSS_ALBUM_002.jpg.json"
            other_json.write_text('{"photoTakenTime":{"timestamp":"1700002000"}}', encoding="utf-8")
            self.assertEqual(
                fusion.find_matching_json(other_img, extra_roots=[d / "takeout-001", d / "takeout-002", d / "takeout-003"]),
                other_json,
            )

            # 9. Emojis, accents NFD vs NFC, et caractères spéciaux dans "title"
            emoji_nfd = "E\u0301te\u0301_🌴_photo_12_30_.jpg"
            img_emoji = d / emoji_nfd
            img_emoji.write_bytes(b"a")
            j_emoji = d / "Été_🌴_photo_12_30_weird.json"
            j_emoji.write_text('{"title":"Été_🌴_photo_12:30?.jpg","photoTakenTime":{"timestamp":"1700003000"}}', encoding="utf-8")
            self.assertEqual(fusion.find_matching_json(img_emoji), j_emoji)

            # 10. No match
            img5 = d / "no_meta.png"
            img5.write_bytes(b"a")
            self.assertIsNone(fusion.find_matching_json(img5))

    def test_long_filename_and_emoji_tag_sanitization(self):
        with tempfile.TemporaryDirectory() as tmp:
            src_dir = Path(tmp) / "src"
            dst_dir = Path(tmp) / "2024" / "01 - Janvier"
            src_dir.mkdir(parents=True)
            src = src_dir / "original.jpg"
            src.write_bytes(b"abc")

            long_stem = "2024-01-15_12-00-00_" + ("Vacances_🌴_Soleil_" * 15)
            out = fusion.atomic_transfer(src, dst_dir, long_stem, ".jpg")
            self.assertTrue(out.exists())
            self.assertLessEqual(len(str(out)), 245)

            ti = fusion.resolve_datetime_with_dst(1705320000, 48.8566, 2.3522)
            tags = fusion.build_exiftool_tags(
                ti, is_video=False,
                description="Ligne 1 🌴\nLigne 2\r\nFin",
                album_name="Été ☀️\nFamille",
            )
            self.assertEqual(tags["ImageDescription"], "Ligne 1 🌴 Ligne 2 Fin")
            self.assertEqual(tags["Keywords"], "Été ☀️ Famille")

    def test_extract_takeout_json_metadata_and_gps_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            j = Path(tmp) / "meta.json"
            j.write_text(
                '{"photoTakenTime":{"timestamp":"0"},"creationTime":{"timestamp":"1705320000"},'
                '"geoData":{"latitude":0.0,"longitude":0.0,"altitude":0.0},'
                '"geoDataExif":{"latitude":48.8566,"longitude":2.3522,"altitude":35.5},'
                '"description":"Tour Eiffel","favorited":true,"trashed":false}',
                encoding="utf-8",
            )
            parsed = fusion.extract_takeout_json_metadata(j)
            self.assertEqual(parsed["timestamp"], 1705320000)
            self.assertAlmostEqual(parsed["lat"], 48.8566, places=4)
            self.assertAlmostEqual(parsed["lon"], 2.3522, places=4)
            self.assertAlmostEqual(parsed["alt"], 35.5, places=1)
            self.assertEqual(parsed["description"], "Tour Eiffel")
            self.assertTrue(parsed["is_favorite"])
            self.assertFalse(parsed["is_trashed"])

    def test_extract_date_from_filename(self):
        ts1 = fusion.extract_date_from_filename("IMG_20230714_153045.jpg")
        self.assertIsNotNone(ts1)
        dt1 = datetime.fromtimestamp(ts1)
        self.assertEqual((dt1.year, dt1.month, dt1.day, dt1.hour, dt1.minute, dt1.second), (2023, 7, 14, 15, 30, 45))

        ts2 = fusion.extract_date_from_filename("photo_2020-03-15.jpg")
        self.assertIsNotNone(ts2)
        dt2 = datetime.fromtimestamp(ts2)
        self.assertEqual((dt2.year, dt2.month, dt2.day, dt2.hour), (2020, 3, 15, 12))

        ts_ms = fusion.extract_date_from_filename("signal-1705320000123.jpg")
        self.assertEqual(ts_ms, 1705320000)

        self.assertIsNone(fusion.extract_date_from_filename("random_wallpaper.png"))

    def test_exif_utc_and_resilient_write(self):
        # QuickTime UTC tag parsed as UTC (12:00:00 UTC)
        qt_ts = fusion._parse_exif_datetime_str("2024:01:15 12:00:00", is_utc_tag=True)
        self.assertEqual(qt_ts, 1705320000)

        with tempfile.TemporaryDirectory() as tmp:
            # PNG bytes saved under .jpg extension -> alias retry succeeds
            disguised = Path(tmp) / "shot.jpg"
            disguised.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16)
            self.assertEqual(fusion.detect_real_media_extension(disguised), ".png")

            calls = []

            class FakeET:
                def set_tags(self, paths, tags=None, params=None):
                    p = Path(paths[0])
                    calls.append(p.suffix.lower())
                    if p.suffix.lower() == ".jpg":
                        raise RuntimeError("Not a valid JPG (looks more like a PNG)")

            ti = fusion.resolve_datetime_with_dst(1705320000, 48.8566, 2.3522)
            tags = fusion.build_exiftool_tags(ti, is_video=False, lat=48.8566, lon=2.3522, alt=-3.0, description="Note", is_favorite=True, album_name="Paris")
            self.assertEqual(tags["GPSAltitudeRef"], 1)
            self.assertEqual(tags["XMP:Description"], "Note")
            self.assertEqual(tags["XMP:Rating"], 5)

            ok, err = fusion.write_tags_resilient(FakeET(), disguised, tags, is_video=False)
            self.assertTrue(ok)
            self.assertIsNone(err)
            self.assertEqual(calls, [".jpg", ".png"])
            self.assertTrue(disguised.exists())

    def test_detect_custom_album(self):
        self.assertIsNone(fusion.detect_custom_album(Path("/takeout/Google Photos/IMG.jpg")))
        self.assertIsNone(fusion.detect_custom_album(Path("/takeout/Photos from 2022/IMG.jpg")))
        self.assertIsNone(fusion.detect_custom_album(Path("/takeout/Photos de 2021/IMG.jpg")))
        self.assertIsNone(fusion.detect_custom_album(Path("/takeout/2023/IMG.jpg")))
        self.assertEqual(fusion.detect_custom_album(Path("/takeout/Vacances Corse/IMG.jpg")), "Vacances Corse")

    def test_resolve_takeout_album_name(self):
        year_p = Path("/takeout/Photos from 2022/IMG.jpg")
        custom_p = Path("/takeout/Vacances Corse/IMG.jpg")
        ti = {"dt_local": datetime(2021, 6, 1)}

        # Option 1 (KEEP_ORIGINAL): keep_structure=True, wrap_google_album=False
        self.assertIsNone(fusion.resolve_takeout_album_name(year_p, ti, keep_structure=True, wrap_google_album=False))
        self.assertEqual(fusion.resolve_takeout_album_name(custom_p, ti, keep_structure=True, wrap_google_album=False), "Vacances Corse")

        # Option 3 (NONE): keep_structure=False, wrap_google_album=False
        self.assertIsNone(fusion.resolve_takeout_album_name(custom_p, ti, keep_structure=False, wrap_google_album=False))

        # Option 2 (GOOGLE_ALBUM): Google Photos/<year>, Google Photos/Albums/<custom>, Google Photos/Favoris, Google Photos/Corbeille
        self.assertEqual(fusion.resolve_takeout_album_name(year_p, ti, keep_structure=True, wrap_google_album=True), "Google Photos/2022")
        self.assertEqual(
            fusion.resolve_takeout_album_name(year_p, ti, keep_structure=True, wrap_google_album=True, is_favorite=True),
            "Google Photos/2022, Google Photos/Favoris",
        )
        self.assertEqual(
            fusion.resolve_takeout_album_name(custom_p, ti, keep_structure=True, wrap_google_album=True),
            "Google Photos/2021, Google Photos/Albums/Vacances Corse",
        )
        self.assertEqual(
            fusion.resolve_takeout_album_name(custom_p, ti, keep_structure=True, wrap_google_album=True, is_trashed=True),
            "Google Photos/Corbeille",
        )

    def test_resolve_datetime_with_dst(self):
        # Winter (Jan 15 2024 12:00 UTC) -> +01:00 in Europe/Paris
        ts_winter = 1705320000
        res_w = fusion.resolve_datetime_with_dst(ts_winter)
        self.assertEqual(res_w["offset_str"], "+01:00")

        # Summer (Jul 15 2024 12:00 UTC) -> +02:00 in Europe/Paris
        ts_summer = 1721044800
        res_s = fusion.resolve_datetime_with_dst(ts_summer)
        self.assertEqual(res_s["offset_str"], "+02:00")


if __name__ == "__main__":
    unittest.main()
