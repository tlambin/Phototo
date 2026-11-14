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

            # 5. No match
            img5 = d / "no_meta.png"
            img5.write_bytes(b"a")
            self.assertIsNone(fusion.find_matching_json(img5))

    def test_extract_date_from_filename(self):
        ts1 = fusion.extract_date_from_filename("IMG_20230714_153045.jpg")
        self.assertIsNotNone(ts1)
        dt1 = datetime.fromtimestamp(ts1)
        self.assertEqual((dt1.year, dt1.month, dt1.day, dt1.hour, dt1.minute, dt1.second), (2023, 7, 14, 15, 30, 45))

        ts2 = fusion.extract_date_from_filename("photo_2020-03-15.jpg")
        self.assertIsNotNone(ts2)
        dt2 = datetime.fromtimestamp(ts2)
        self.assertEqual((dt2.year, dt2.month, dt2.day, dt2.hour), (2020, 3, 15, 12))

        self.assertIsNone(fusion.extract_date_from_filename("random_wallpaper.png"))

    def test_detect_custom_album(self):
        self.assertIsNone(fusion.detect_custom_album(Path("/takeout/Google Photos/IMG.jpg")))
        self.assertIsNone(fusion.detect_custom_album(Path("/takeout/Photos from 2022/IMG.jpg")))
        self.assertIsNone(fusion.detect_custom_album(Path("/takeout/Photos de 2021/IMG.jpg")))
        self.assertIsNone(fusion.detect_custom_album(Path("/takeout/2023/IMG.jpg")))
        self.assertEqual(fusion.detect_custom_album(Path("/takeout/Vacances Corse/IMG.jpg")), "Vacances Corse")

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
