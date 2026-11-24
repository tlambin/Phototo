import base64
import io
import math
import os
import shutil
import subprocess
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageColor, ImageEnhance, ImageDraw, ImageFilter, ImageFont, ImageOps
import exiftool
from media_frames import VIDEO_EXTS, probe_media_dimensions
from ai_inpaint import inpaint_image_with_ai
from ai_bg_remove import apply_background_removal

FONT_EXTS = {".ttf", ".otf", ".ttc"}


def get_system_font_dirs() -> list[Path]:
    dirs: list[Path] = []
    windir = os.environ.get("WINDIR", "C:\\Windows")
    win_fonts = Path(windir) / "Fonts"
    if win_fonts.exists():
        dirs.append(win_fonts)
    local_app = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    user_fonts = Path(local_app) / "Microsoft" / "Windows" / "Fonts"
    if user_fonts.exists():
        dirs.append(user_fonts)
    for unix_dir in ("/usr/share/fonts", "/usr/local/share/fonts"):
        p = Path(unix_dir)
        if p.exists():
            dirs.append(p)
    return dirs


def list_system_fonts() -> list[dict]:
    """Découvre dynamiquement les polices installées dans Windows (système + utilisateur)."""
    font_dirs = get_system_font_dirs()
    fonts_by_name: dict[str, str] = {}

    # 1. Lecture rapide du registre Windows (inclut les polices installées par l'utilisateur)
    try:
        import winreg
        reg_paths = [
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"),
            (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"),
        ]
        for hive, subkey in reg_paths:
            try:
                with winreg.OpenKey(hive, subkey) as key:
                    idx = 0
                    while True:
                        try:
                            name, val, _ = winreg.EnumValue(key, idx)
                            idx += 1
                            if not isinstance(val, str):
                                continue
                            fp = Path(val)
                            if not fp.is_absolute():
                                for d in font_dirs:
                                    cand = d / val
                                    if cand.exists():
                                        fp = cand
                                        break
                            if fp.exists() and fp.suffix.lower() in FONT_EXTS:
                                clean = name.split(" (")[0].strip()
                                if clean and clean.lower() not in {k.lower() for k in fonts_by_name}:
                                    fonts_by_name[clean] = str(fp)
                        except OSError:
                            break
            except OSError:
                continue
    except Exception:
        pass

    # 2. Scan direct des dossiers Fonts pour toute police non enregistrée ou hors Windows
    known_paths = {str(Path(v).resolve()).lower() for v in fonts_by_name.values()}
    for d in font_dirs:
        try:
            for fp in d.rglob("*"):
                if not fp.is_file() or fp.suffix.lower() not in FONT_EXTS:
                    continue
                res_p = str(fp.resolve()).lower()
                if res_p in known_paths:
                    continue
                known_paths.add(res_p)
                try:
                    fobj = ImageFont.truetype(str(fp), 16)
                    fam, sty = fobj.getname()
                    label = f"{fam} {sty}".strip() if (sty and sty.lower() not in {"regular", "normal"}) else fam
                except Exception:
                    label = fp.stem
                if label and label.lower() not in {k.lower() for k in fonts_by_name}:
                    fonts_by_name[label] = str(fp)
        except Exception:
            continue

    items = [{"family": k, "path": v.replace("\\", "/")} for k, v in fonts_by_name.items()]
    items.sort(key=lambda x: x["family"].lower())
    return items


def resolve_system_font_path(font_path: str | None = None, font_family: str | None = None) -> str | None:
    if font_path:
        p = Path(font_path)
        if p.exists() and p.is_file() and p.suffix.lower() in FONT_EXTS:
            return str(p)
    if font_family:
        target = font_family.strip().lower()
        for f in list_system_fonts():
            if f["family"].lower() == target:
                return f["path"]
    return None


def preserve_metadata_and_time(src_path: Path, target_path: Path, timestamp: int | None = None, reset_orientation: bool = False):
    try:
        with exiftool.ExifToolHelper() as et:
            args = [
                "-overwrite_original", "-P", "-q",
                "-tagsFromFile", str(src_path), "-all:all",
            ]
            if reset_orientation:
                args.append("-Orientation#=1")
            args.append(str(target_path))
            et.execute(*args)
    except Exception:
        pass
    ts = timestamp or int(src_path.stat().st_mtime)
    if target_path.exists():
        os.utime(target_path, (ts, ts))


def get_output_path(src_path: Path, overwrite: bool = False, suffix_tag: str = "_edit", ext_override: str | None = None) -> Path:
    """Par défaut (overwrite=False), génère toujours un nouveau fichier suffixé (_edit) sans écraser l'original."""
    ext = ext_override if ext_override else src_path.suffix
    if overwrite and not ext_override:
        return src_path
    counter = 1
    candidate = src_path.parent / f"{src_path.stem}{suffix_tag}{ext}"
    while candidate.exists():
        candidate = src_path.parent / f"{src_path.stem}{suffix_tag}_{counter}{ext}"
        counter += 1
    return candidate


def _straighten_image(img: Image.Image, angle_deg: float) -> Image.Image:
    """Fait pivoter finement l'image (-45° à +45°) et recadre intérieurement sans coins noirs."""
    if abs(angle_deg) < 0.05:
        return img
    w, h = img.size
    rad = math.radians(abs(angle_deg))
    sin_a, cos_a = math.sin(rad), math.cos(rad)
    # Plus grand rectangle inscrit conservant le ratio d'aspect dans la zone pivotée
    if w <= 0 or h <= 0 or (cos_a <= sin_a):
        return img.rotate(-angle_deg, resample=Image.Resampling.BICUBIC, expand=False)
    wr, hr = (w * cos_a - h * sin_a) / (cos_a * cos_a - sin_a * sin_a), (h * cos_a - w * sin_a) / (cos_a * cos_a - sin_a * sin_a)
    scale = max(w / max(1.0, wr), h / max(1.0, hr))
    rotated = img.rotate(-angle_deg, resample=Image.Resampling.BICUBIC, expand=True)
    rw, rh = rotated.size
    crop_w = max(8, int(round(w / max(1.0, scale))))
    crop_h = max(8, int(round(h / max(1.0, scale))))
    left = max(0, (rw - crop_w) // 2)
    top = max(0, (rh - crop_h) // 2)
    return rotated.crop((left, top, min(rw, left + crop_w), min(rh, top + crop_h)))


def _apply_orientation(img: Image.Image, ops: dict) -> Image.Image:
    if ops.get("auto_orient"):
        img = ImageOps.exif_transpose(img)
    img = img.convert("RGB")
    rot = int(ops.get("rotate", 0)) % 360
    if rot == 90:
        img = img.transpose(Image.Transpose.ROTATE_270)
    elif rot == 180:
        img = img.transpose(Image.Transpose.ROTATE_180)
    elif rot == 270:
        img = img.transpose(Image.Transpose.ROTATE_90)
    if ops.get("flip_h"):
        img = img.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    if ops.get("flip_v"):
        img = img.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    straighten = max(-45.0, min(45.0, float(ops.get("straighten", 0.0) or 0.0)))
    if abs(straighten) >= 0.1:
        img = _straighten_image(img, straighten)
    return img


def _build_inpaint_mask(w: int, h: int, inpaint_boxes: list | None, inpaint_strokes: list | None) -> np.ndarray | None:
    boxes = inpaint_boxes or []
    strokes = inpaint_strokes or []
    if not boxes and not strokes:
        return None
    mask = np.zeros((h, w), dtype=np.uint8)
    for b in boxes:
        x1, y1 = int(max(0, b["nx"] * w)), int(max(0, b["ny"] * h))
        x2, y2 = int(min(w, (b["nx"] + b["nw"]) * w)), int(min(h, (b["ny"] + b["nh"]) * h))
        cv2.rectangle(mask, (x1, y1), (x2, y2), 255, -1)
    for st in strokes:
        pts = st.get("points") or []
        if not pts:
            continue
        r_px = max(4, int(float(st.get("nr", 0.025)) * max(w, h)))
        px_pts = [(int(max(0, min(w - 1, p["nx"] * w))), int(max(0, min(h - 1, p["ny"] * h)))) for p in pts]
        if len(px_pts) == 1:
            cv2.circle(mask, px_pts[0], r_px, 255, -1)
        else:
            for i in range(len(px_pts) - 1):
                cv2.line(mask, px_pts[i], px_pts[i + 1], 255, thickness=r_px * 2)
    return cv2.dilate(mask, np.ones((5, 5), np.uint8), iterations=2)


def _apply_glare_removal(img: Image.Image, glare_strokes: list | None) -> Image.Image:
    """Atténue les reflets spéculaires et zones surexposées locales dans les tracés donnés."""
    if not glare_strokes:
        return img
    w, h = img.size
    mask = _build_inpaint_mask(w, h, None, glare_strokes)
    if mask is None or int(mask.max()) == 0:
        return img

    bgr = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    val = hsv[..., 2].astype(np.float32)
    sat = hsv[..., 1].astype(np.float32)

    paint_idx = mask > 0
    local_thresh = float(np.percentile(val[paint_idx], 45)) if np.any(paint_idx) else 190.0
    spec_mask = ((mask > 0) & ((val >= max(165.0, local_thresh)) & (sat <= 145.0))).astype(np.uint8) * 255
    if int(spec_mask.sum()) == 0:
        spec_mask = ((mask > 0) & (val >= max(120.0, local_thresh))).astype(np.uint8) * 255
    if int(spec_mask.sum()) == 0:
        spec_mask = mask.copy()

    spec_dil = cv2.dilate(spec_mask, np.ones((5, 5), np.uint8), iterations=1)
    repaired = cv2.inpaint(bgr, spec_dil, 6, cv2.INPAINT_TELEA).astype(np.float32)

    # Récupère les hautes lumières sans délaver la zone
    orig_f = bgr.astype(np.float32)
    darkened = np.clip(orig_f * 0.72, 0, 255)
    target = 0.68 * repaired + 0.32 * darkened

    alpha = cv2.GaussianBlur(spec_dil.astype(np.float32) / 255.0, (0, 0), sigmaX=4.0, sigmaY=4.0)[..., None]
    out_bgr = np.clip(orig_f * (1.0 - alpha) + target * alpha, 0, 255).astype(np.uint8)
    return Image.fromarray(cv2.cvtColor(out_bgr, cv2.COLOR_BGR2RGB))


def _apply_redeye_removal(img: Image.Image, redeye_strokes: list | None) -> Image.Image:
    """Corrige les yeux rouges dans les tracés ciblés en préservant l'éclat de la pupille."""
    if not redeye_strokes:
        return img
    w, h = img.size
    mask = _build_inpaint_mask(w, h, None, redeye_strokes)
    if mask is None or int(mask.max()) == 0:
        return img

    arr = np.array(img, dtype=np.float32)
    r = arr[..., 0]
    g = arr[..., 1]
    b = arr[..., 2]
    mean_gb = (g + b) * 0.5
    catchlight = (r > 215.0) & (g > 205.0) & (b > 205.0)
    red_px = (mask > 0) & (~catchlight) & (r > 55.0) & (r > mean_gb * 1.35) & ((r - np.maximum(g, b)) > 16.0)
    if not np.any(red_px):
        return img

    eye_m = cv2.dilate(red_px.astype(np.uint8) * 255, np.ones((3, 3), np.uint8), iterations=1)
    alpha = cv2.GaussianBlur(eye_m.astype(np.float32) / 255.0, (0, 0), sigmaX=1.4, sigmaY=1.4)

    dark_pupil = np.clip(mean_gb * 0.58, 0.0, 255.0)
    corrected = arr.copy()
    corrected[..., 0] = dark_pupil
    corrected[..., 1] = np.clip(g * 0.84, 0.0, 255.0)
    corrected[..., 2] = np.clip(b * 0.84, 0.0, 255.0)

    a3 = alpha[..., None]
    out = np.clip(arr * (1.0 - a3) + corrected * a3, 0, 255).astype(np.uint8)
    return Image.fromarray(out)


def _apply_blemish_fix(img: Image.Image, blemish_strokes: list | None) -> Image.Image:
    """Estompe les petites imperfections ou poussières par reconstruction douce."""
    if not blemish_strokes:
        return img
    w, h = img.size
    mask = _build_inpaint_mask(w, h, None, blemish_strokes)
    if mask is None or int(mask.max()) == 0:
        return img
    bgr = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
    inpainted = cv2.inpaint(bgr, mask, 5, cv2.INPAINT_TELEA).astype(np.float32)
    alpha = cv2.GaussianBlur(mask.astype(np.float32) / 255.0, (0, 0), sigmaX=2.5, sigmaY=2.5)[..., None]
    out_bgr = np.clip(bgr.astype(np.float32) * (1.0 - alpha) + inpainted * alpha, 0, 255).astype(np.uint8)
    return Image.fromarray(cv2.cvtColor(out_bgr, cv2.COLOR_BGR2RGB))


def _apply_auto_retouch(img: Image.Image, cfg: dict | None) -> Image.Image:
    """Retouche automatique : peau & rides, yeux rouges auto, imperfections & brillance."""
    if not cfg or not cfg.get("enabled"):
        return img
    strength = max(0.05, min(1.0, float(cfg.get("strength", 0.65) or 0.65)))
    bgr = cv2.cvtColor(np.array(img.convert("RGB")), cv2.COLOR_RGB2BGR)
    h, w = bgr.shape[:2]

    # 1. Yeux rouges automatiques sur visages / yeux détectés
    if cfg.get("redeye", True):
        try:
            gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
            face_cc = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
            eye_cc = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_eye.xml")
            faces = face_cc.detectMultiScale(gray, 1.15, 4, minSize=(40, 40)) if not face_cc.empty() else []
            regions = []
            for (fx, fy, fw, fh) in faces:
                roi_g = gray[fy : fy + int(fh * 0.65), fx : fx + fw]
                eyes = eye_cc.detectMultiScale(roi_g, 1.1, 3, minSize=(12, 12)) if not eye_cc.empty() else []
                for (ex, ey, ew, eh) in eyes:
                    regions.append((fx + ex, fy + ey, ew, eh))
            for (rx, ry, rw, rh) in regions:
                patch = bgr[ry : ry + rh, rx : rx + rw]
                if patch.size == 0:
                    continue
                b_c, g_c, r_c = cv2.split(patch.astype(np.float32))
                red_mask = (r_c > 75) & (r_c > (g_c + b_c) * 0.85)
                if np.any(red_mask):
                    mean_gb = (g_c + b_c) * 0.5
                    r_c[red_mask] = mean_gb[red_mask] * 0.92
                    bgr[ry : ry + rh, rx : rx + rw] = np.clip(cv2.merge([b_c, g_c, r_c]), 0, 255).astype(np.uint8)
        except Exception:
            pass

    # 2. Détection zones peau (YCrCb) pour lissage rides / imperfections / brillance
    ycrcb = cv2.cvtColor(bgr, cv2.COLOR_BGR2YCrCb)
    cr = ycrcb[..., 1]
    cb = ycrcb[..., 2]
    skin_mask = ((cr >= 133) & (cr <= 175) & (cb >= 77) & (cb <= 129)).astype(np.float32)
    skin_mask = cv2.GaussianBlur(skin_mask, (15, 15), 0)

    # Fallback doux si aucune peau détectée : correction globale très légère
    if float(skin_mask.mean()) < 0.02:
        skin_mask = np.full((h, w), 0.35, dtype=np.float32)

    out_f = bgr.astype(np.float32)

    # 2a. Imperfections, boutons & reflets brillants sur la peau
    if cfg.get("blemish_glare", True):
        med = cv2.medianBlur(bgr, 5).astype(np.float32)
        diff = np.abs(out_f - med).mean(axis=2)
        spot_mask = np.clip((diff - 12.0) / 28.0, 0.0, 1.0) * skin_mask
        # Atténuation des reflets très lumineux sur peau
        luma = ycrcb[..., 0].astype(np.float32)
        glare_mask = np.clip((luma - 222.0) / 33.0, 0.0, 1.0) * skin_mask
        fix_w = np.clip((spot_mask * 0.75 + glare_mask * 0.55) * strength, 0.0, 0.85)[..., None]
        out_f = out_f * (1.0 - fix_w) + med * fix_w

    # 2b. Peau & rides (filtre bilatéral préservant les contours yeux/bouche/cheveux)
    if cfg.get("skin_wrinkles", True):
        d = max(5, int(min(w, h) / 90) | 1)
        smooth = cv2.bilateralFilter(np.clip(out_f, 0, 255).astype(np.uint8), d, 32 + 38 * strength, 24 + 28 * strength).astype(np.float32)
        blend_w = (skin_mask * (0.55 * strength))[..., None]
        out_f = out_f * (1.0 - blend_w) + smooth * blend_w

    return Image.fromarray(cv2.cvtColor(np.clip(out_f, 0, 255).astype(np.uint8), cv2.COLOR_BGR2RGB))


def _apply_retouch_tools(img: Image.Image, ops: dict) -> tuple[Image.Image, str]:
    """Enchaîne Retouche auto, Effaceur d'objet IA, Reflets, Yeux rouges, Défauts et Suppression arrière-plan IA."""
    bw, bh = img.size
    engine = "none"
    if isinstance(ops.get("auto_retouch"), dict) and ops["auto_retouch"].get("enabled"):
        img = _apply_auto_retouch(img, ops["auto_retouch"])
        engine = "AutoRetouch"
    mask = _build_inpaint_mask(bw, bh, ops.get("inpaint_boxes"), ops.get("inpaint_strokes"))
    if mask is not None:
        img, engine = inpaint_image_with_ai(img, mask)
    if ops.get("glare_strokes"):
        img = _apply_glare_removal(img, ops.get("glare_strokes"))
        if engine == "none":
            engine = "Glare"
    if ops.get("redeye_strokes"):
        img = _apply_redeye_removal(img, ops.get("redeye_strokes"))
        if engine == "none":
            engine = "RedEye"
    if ops.get("blemish_strokes"):
        img = _apply_blemish_fix(img, ops.get("blemish_strokes"))
        if engine == "none":
            engine = "Blemish"
    bg_cfg = ops.get("bg_remove")
    if isinstance(bg_cfg, dict) and bg_cfg.get("enabled"):
        img, bg_engine = apply_background_removal(img, mode=bg_cfg.get("mode", "transparent"))
        engine = bg_engine if engine == "none" else f"{engine}+{bg_engine}"
    return img, engine


def _decode_dataurl_png(data_url: str | None) -> Image.Image | None:
    if not data_url or not isinstance(data_url, str) or "," not in data_url:
        return None
    try:
        _, b64 = data_url.split(",", 1)
        raw = base64.b64decode(b64)
        return Image.open(io.BytesIO(raw)).convert("RGBA")
    except Exception:
        return None


def render_inpaint_preview_with_meta(src_path: Path, ops: dict, max_dim: int = 1280) -> tuple[bytes, str]:
    """Génère un aperçu JPEG/PNG des outils intelligents (Objet IA, Suppr. arrière-plan, Retouche auto)."""
    img = _apply_orientation(Image.open(src_path), ops)
    w, h = img.size
    if max(w, h) > max_dim:
        img.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)
    img, engine = _apply_retouch_tools(img, ops)
    if img.mode == "RGBA":
        bgra = cv2.cvtColor(np.array(img), cv2.COLOR_RGBA2BGRA)
        ok, buf = cv2.imencode(".png", bgra)
        return (bytes(buf) if ok else b""), engine
    bgr = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
    ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return (bytes(buf) if ok else b""), engine


def render_inpaint_preview_bytes(src_path: Path, ops: dict, max_dim: int = 1280) -> bytes:
    """Rétrocompatibilité : retourne uniquement les octets JPEG de l'aperçu d'effacement."""
    jpg_bytes, _ = render_inpaint_preview_with_meta(src_path, ops, max_dim=max_dim)
    return jpg_bytes


def process_image_edits(src_path: Path, ops: dict, overwrite: bool = False, timestamp: int | None = None) -> Path:
    img = _apply_orientation(Image.open(src_path), ops)
    rot = int(ops.get("rotate", 0)) % 360

    # 2. Outils intelligents (Retouche auto, Effaceur objet IA, Reflets, Yeux rouges, Défauts, Suppr. arrière-plan IA)
    img, _ = _apply_retouch_tools(img, ops)
    preserved_alpha = img.split()[-1] if img.mode == "RGBA" else None
    if preserved_alpha is not None:
        img = img.convert("RGB")

    # 2b. Floutage ciblé (pinceau floutage)
    blur_img = _decode_dataurl_png(ops.get("blur_mask_png"))
    blur_mask_pil = None
    if blur_img is not None:
        alpha = blur_img.split()[-1]
        if alpha.getbbox():
            blur_mask_pil = alpha.resize(img.size, Image.Resampling.BILINEAR)
    elif ops.get("blur_strokes"):
        bm = _build_inpaint_mask(img.size[0], img.size[1], None, ops.get("blur_strokes"))
        if bm is not None:
            blur_mask_pil = Image.fromarray(bm, mode="L")
    if blur_mask_pil is not None:
        rad = max(10, int(max(img.size) / 65))
        blurred = img.filter(ImageFilter.GaussianBlur(radius=rad))
        img = Image.composite(blurred, img, blur_mask_pil)

    # 2b-bis. Pixellisation ciblée (pinceau pixeliseur)
    pixel_img = _decode_dataurl_png(ops.get("pixel_mask_png"))
    pixel_mask_pil = None
    if pixel_img is not None:
        alpha_p = pixel_img.split()[-1]
        if alpha_p.getbbox():
            pixel_mask_pil = alpha_p.resize(img.size, Image.Resampling.BILINEAR)
    elif ops.get("pixel_strokes"):
        pm = _build_inpaint_mask(img.size[0], img.size[1], None, ops.get("pixel_strokes"))
        if pm is not None:
            pixel_mask_pil = Image.fromarray(pm, mode="L")
    if pixel_mask_pil is not None:
        block = max(10, int(max(img.size) / 55))
        pw = max(1, img.size[0] // block)
        ph = max(1, img.size[1] // block)
        pixelated = img.resize((pw, ph), Image.Resampling.BILINEAR).resize(img.size, Image.Resampling.NEAREST)
        img = Image.composite(pixelated, img, pixel_mask_pil)

    # 2c. Calque de dessin libre (Pinceau, Stylo, Surligneur, Gomme de dessin déjà appliquée)
    draw_ov = _decode_dataurl_png(ops.get("draw_layer_png"))
    if draw_ov is not None and draw_ov.getbbox():
        draw_resized = draw_ov.resize(img.size, Image.Resampling.LANCZOS)
        img = Image.alpha_composite(img.convert("RGBA"), draw_resized).convert("RGB")

    # 3. Rognage / Recadrage
    crop = ops.get("crop")
    if crop and crop.get("nw", 0) > 0.02 and crop.get("nh", 0) > 0.02:
        w, h = img.size
        left, top = int(max(0, crop["nx"] * w)), int(max(0, crop["ny"] * h))
        right, bottom = int(min(w, (crop["nx"] + crop["nw"]) * w)), int(min(h, (crop["ny"] + crop["nh"]) * h))
        if right - left > 10 and bottom - top > 10:
            img = img.crop((left, top, right, bottom))
            if preserved_alpha is not None:
                preserved_alpha = preserved_alpha.crop((left, top, right, bottom))

    # 4. Couleurs, Luminosité, Contraste, Netteté, Température, Teinte, Ombres/Lumières, Grain, Vignette
    if ops.get("brightness", 1.0) != 1.0:
        img = ImageEnhance.Brightness(img).enhance(float(ops["brightness"]))
    if ops.get("contrast", 1.0) != 1.0:
        img = ImageEnhance.Contrast(img).enhance(float(ops["contrast"]))
    if ops.get("saturation", 1.0) != 1.0:
        img = ImageEnhance.Color(img).enhance(float(ops["saturation"]))
    if ops.get("sharpness", 1.0) != 1.0:
        img = ImageEnhance.Sharpness(img).enhance(float(ops["sharpness"]))

    warmth = max(-1.0, min(1.0, float(ops.get("warmth", 0.0) or 0.0)))
    tint = max(-1.0, min(1.0, float(ops.get("tint", 0.0) or 0.0)))
    highlights = max(-1.0, min(1.0, float(ops.get("highlights", 0.0) or 0.0)))
    shadows = max(-1.0, min(1.0, float(ops.get("shadows", 0.0) or 0.0)))
    fade = max(0.0, min(1.0, float(ops.get("fade", 0.0) or 0.0)))
    grain = max(0.0, min(1.0, float(ops.get("grain", 0.0) or 0.0)))
    vignette = max(0.0, min(1.0, float(ops.get("vignette", 0.0) or 0.0)))
    if any(abs(v) > 0.01 for v in (warmth, tint, highlights, shadows, fade, grain, vignette)):
        arr = np.array(img, dtype=np.float32)
        if abs(highlights) > 0.01 or abs(shadows) > 0.01:
            luma = (0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]) / 255.0
            if abs(highlights) > 0.01:
                hi_mask = np.clip((luma - 0.5) * 2.0, 0.0, 1.0)[..., None]
                arr += hi_mask * (highlights * 58.0)
            if abs(shadows) > 0.01:
                sh_mask = np.clip((0.55 - luma) / 0.55, 0.0, 1.0)[..., None]
                arr += sh_mask * (shadows * 58.0)
        if abs(warmth) > 0.01:
            arr[..., 0] *= (1.0 + 0.16 * warmth)
            arr[..., 2] *= (1.0 - 0.16 * warmth)
        if abs(tint) > 0.01:
            arr[..., 1] *= (1.0 - 0.14 * tint)
            arr[..., 0] *= (1.0 + 0.07 * tint)
            arr[..., 2] *= (1.0 + 0.07 * tint)
        if fade > 0.01:
            lift = fade * 34.0
            arr = arr * (1.0 - fade * 0.12) + lift
        if grain > 0.01:
            rng = np.random.default_rng(42)
            noise = rng.normal(0.0, grain * 18.0, size=(arr.shape[0], arr.shape[1], 1)).astype(np.float32)
            arr += noise
        if vignette > 0.01:
            hh, ww = arr.shape[:2]
            yy, xx = np.ogrid[:hh, :ww]
            cy, cx = (hh - 1) * 0.5, (ww - 1) * 0.5
            r2 = ((xx - cx) / max(1.0, cx)) ** 2 + ((yy - cy) / max(1.0, cy)) ** 2
            mask_v = np.clip(1.0 - (vignette * 0.48) * np.clip(r2, 0.0, 2.0), 0.15, 1.0)[..., None]
            arr *= mask_v
        img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))

    # 4b. Calques / Incrustations d'images ou logos
    for ov in (ops.get("image_overlays") or []):
        ov_path_raw = (ov.get("path") or "").strip()
        if not ov_path_raw:
            continue
        ov_p = Path(ov_path_raw)
        if not ov_p.exists():
            continue
        try:
            with Image.open(ov_p) as raw_ov:
                ov_img = ImageOps.exif_transpose(raw_ov).convert("RGBA")
                w, h = img.size
                target_w = max(12, int(float(ov.get("nw", 0.25) or 0.25) * w))
                aspect = ov_img.height / max(1, ov_img.width)
                target_h = max(12, int(target_w * aspect))
                ov_resized = ov_img.resize((target_w, target_h), Image.Resampling.LANCZOS)
                opac = max(0.05, min(1.0, float(ov.get("opacity", 1.0) or 1.0)))
                if opac < 0.999:
                    r, g, b, a = ov_resized.split()
                    a = a.point(lambda px: int(px * opac))
                    ov_resized = Image.merge("RGBA", (r, g, b, a))
                px = int(float(ov.get("nx", 0.08) or 0.08) * w)
                py = int(float(ov.get("ny", 0.08) or 0.08) * h)
                base_rgba = img.convert("RGBA")
                layer = Image.new("RGBA", base_rgba.size, (0, 0, 0, 0))
                layer.paste(ov_resized, (px, py), ov_resized)
                img = Image.alpha_composite(base_rgba, layer).convert("RGB")
        except Exception:
            continue

    # 5. Textes incrustés (multi-calques + rétrocompatibilité text_overlay)
    text_items = list(ops.get("text_layers") or [])
    legacy_txt = ops.get("text_overlay")
    if legacy_txt and legacy_txt.get("text", "").strip():
        text_items.insert(0, legacy_txt)
    if text_items:
        base_rgba = img.convert("RGBA")
        txt_layer = Image.new("RGBA", base_rgba.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(txt_layer)
        w, h = base_rgba.size
        for txt_cfg in text_items:
            t_str = (txt_cfg.get("text") or "").strip()
            if not t_str:
                continue
            font_size = max(14, int((float(txt_cfg.get("size", 36) or 36) / 1000.0) * max(w, h)))
            fpath = resolve_system_font_path(txt_cfg.get("font_path"), txt_cfg.get("font_family"))
            try:
                font = ImageFont.truetype(fpath or "arial.ttf", font_size)
            except Exception:
                font = ImageFont.load_default()
            tx, ty = int(float(txt_cfg.get("nx", 0.05)) * w), int(float(txt_cfg.get("ny", 0.88)) * h)
            opac = max(0.05, min(1.0, float(txt_cfg.get("opacity", 1.0) if txt_cfg.get("opacity") is not None else 1.0)))
            alpha_byte = int(round(opac * 255))
            try:
                rgb_col = ImageColor.getrgb(txt_cfg.get("color", "#ffffff") or "#ffffff")[:3]
            except Exception:
                rgb_col = (255, 255, 255)
            bg_col = (txt_cfg.get("bg_color") or "").strip()
            is_bold = bool(txt_cfg.get("bold", False))
            is_italic = bool(txt_cfg.get("italic", False))
            has_shadow = bool(txt_cfg.get("shadow", True))
            stroke_w = max(1, font_size // 26) if is_bold else 0
            if bg_col and bg_col != "transparent":
                try:
                    bbox = draw.textbbox((tx, ty), t_str, font=font, stroke_width=stroke_w)
                    pad_x, pad_y = max(8, font_size // 3), max(4, font_size // 5)
                    fill_rgba = (0, 0, 0, int(175 * opac)) if bg_col == "dark" else ((255, 255, 255, int(215 * opac)) if bg_col == "light" else bg_col)
                    draw.rounded_rectangle([bbox[0] - pad_x, bbox[1] - pad_y, bbox[2] + pad_x, bbox[3] + pad_y], radius=max(6, font_size // 3), fill=fill_rgba)
                except Exception:
                    pass
            text_fill = (rgb_col[0], rgb_col[1], rgb_col[2], alpha_byte)
            if is_italic:
                try:
                    bbox = draw.textbbox((0, 0), t_str, font=font, stroke_width=stroke_w)
                    tw = max(16, (bbox[2] - bbox[0]) + font_size)
                    th = max(16, (bbox[3] - bbox[1]) + font_size // 2)
                    patch = Image.new("RGBA", (tw + font_size // 2, th), (0, 0, 0, 0))
                    pd = ImageDraw.Draw(patch)
                    ox = max(2, font_size // 4) - bbox[0]
                    oy = max(2, font_size // 6) - bbox[1]
                    if has_shadow:
                        pd.text((ox + 2, oy + 2), t_str, font=font, fill=(0, 0, 0, int(185 * opac)), stroke_width=stroke_w)
                    pd.text((ox, oy), t_str, font=font, fill=text_fill, stroke_width=stroke_w, stroke_fill=text_fill)
                    patch = patch.transform(patch.size, Image.Transform.AFFINE, (1, 0.22, -0.22 * th * 0.5, 0, 1, 0), resample=Image.Resampling.BICUBIC)
                    txt_layer.paste(patch, (max(0, tx - font_size // 4), max(0, ty - font_size // 6)), patch)
                except Exception:
                    if has_shadow:
                        draw.text((tx + 2, ty + 2), t_str, font=font, fill=(0, 0, 0, int(185 * opac)), stroke_width=stroke_w)
                    draw.text((tx, ty), t_str, font=font, fill=text_fill, stroke_width=stroke_w, stroke_fill=text_fill)
            else:
                if has_shadow:
                    draw.text((tx + 2, ty + 2), t_str, font=font, fill=(0, 0, 0, int(185 * opac)), stroke_width=stroke_w)
                draw.text((tx, ty), t_str, font=font, fill=text_fill, stroke_width=stroke_w, stroke_fill=text_fill)
        img = Image.alpha_composite(base_rgba, txt_layer).convert("RGB")

    # 7. Bordure / Cadre autour de l'image
    bdr = ops.get("border")
    if isinstance(bdr, dict) and (bdr.get("style") or "none") != "none":
        b_style = (bdr.get("style") or "solid").lower()
        b_col = (bdr.get("color") or "#ffffff").strip()
        b_pct = max(0.5, min(15.0, float(bdr.get("thickness", 3.0) or 3.0)))
        pad = max(4, int(min(img.size) * (b_pct / 100.0)))
        try:
            from PIL import ImageOps
            if b_style == "polaroid":
                img = ImageOps.expand(img, border=(pad, pad, pad, pad * 3), fill=b_col)
                if preserved_alpha is not None:
                    preserved_alpha = ImageOps.expand(preserved_alpha, border=(pad, pad, pad, pad * 3), fill=255)
            else:
                img = ImageOps.expand(img, border=pad, fill=b_col)
                if preserved_alpha is not None:
                    preserved_alpha = ImageOps.expand(preserved_alpha, border=pad, fill=255)
        except Exception:
            pass

    if preserved_alpha is not None:
        if preserved_alpha.size != img.size:
            preserved_alpha = preserved_alpha.resize(img.size, Image.Resampling.LANCZOS)
        rgba_out = img.convert("RGBA")
        rgba_out.putalpha(preserved_alpha)
        out_path = get_output_path(src_path, overwrite=overwrite, suffix_tag="_edit", ext_override=".png")
        tmp_path = out_path.with_name(f".tmp_{out_path.name}")
        rgba_out.save(tmp_path)
    else:
        out_path = get_output_path(src_path, overwrite=overwrite, suffix_tag="_edit")
        tmp_path = out_path.with_name(f".tmp_{out_path.name}")
        img.save(tmp_path, quality=95)
    reset_ori = bool(rot or ops.get("flip_h") or ops.get("flip_v") or abs(float(ops.get("straighten", 0.0) or 0.0)) >= 0.1)
    preserve_metadata_and_time(src_path, tmp_path, timestamp, reset_orientation=reset_ori)
    shutil.move(tmp_path, out_path)
    return out_path


def process_video_edits(src_path: Path, ops: dict, overwrite: bool = False, timestamp: int | None = None) -> list[Path]:
    mode = ops.get("video_action", "EDIT")
    cap = cv2.VideoCapture(str(src_path))
    vid_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 1920)
    vid_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 1080)
    cap.release()

    if mode == "SPLIT":
        split_sec = float(ops.get("split_time_sec", 5.0))
        part1 = get_output_path(src_path, overwrite=False, suffix_tag="_part1")
        part2 = get_output_path(src_path, overwrite=False, suffix_tag="_part2")
        subprocess.run(["ffmpeg", "-y", "-i", str(src_path), "-t", str(split_sec), "-c", "copy", str(part1)], check=True)
        subprocess.run(["ffmpeg", "-y", "-ss", str(split_sec), "-i", str(src_path), "-c", "copy", str(part2)], check=True)
        preserve_metadata_and_time(src_path, part1, timestamp)
        preserve_metadata_and_time(src_path, part2, (timestamp + int(split_sec)) if timestamp else None)
        return [part1, part2]

    if mode == "GIF":
        start_s = float(ops.get("start_sec", 0.0))
        end_s = float(ops.get("end_sec", 0.0))
        gif_out = get_output_path(src_path, overwrite=False, suffix_tag="_anim", ext_override=".gif")
        cmd = ["ffmpeg", "-y"]
        if start_s > 0:
            cmd.extend(["-ss", f"{start_s:.3f}"])
        if end_s > start_s:
            cmd.extend(["-t", f"{max(0.1, end_s - start_s):.3f}"])
        cmd.extend([
            "-i", str(src_path),
            "-vf", "fps=12,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
            str(gif_out)
        ])
        subprocess.run(cmd, check=True)
        if timestamp:
            os.utime(gif_out, (timestamp, timestamp))
        return [gif_out]

    vf_filters, af_filters = [], []

    rot = int(ops.get("rotate", 0)) % 360
    if rot == 90:
        vf_filters.append("transpose=1")
        vid_w, vid_h = vid_h, vid_w
    elif rot == 180:
        vf_filters.append("transpose=1,transpose=1")
    elif rot == 270:
        vf_filters.append("transpose=2")
        vid_w, vid_h = vid_h, vid_w

    if ops.get("flip_h"):
        vf_filters.append("hflip")
    if ops.get("flip_v"):
        vf_filters.append("vflip")

    for b in (ops.get("inpaint_boxes") or []):
        bx, by = max(2, int(b["nx"] * vid_w)), max(2, int(b["ny"] * vid_h))
        bw, bh = min(vid_w - bx - 2, max(10, int(b["nw"] * vid_w))), min(vid_h - by - 2, max(10, int(b["nh"] * vid_h)))
        vf_filters.append(f"delogo=x={bx}:y={by}:w={bw}:h={bh}:show=0")
    for st in (ops.get("inpaint_strokes") or []) + (ops.get("blur_strokes") or []):
        pts = st.get("points") or []
        if not pts:
            continue
        r = float(st.get("nr", 0.025))
        xs = [float(p["nx"]) for p in pts]
        ys = [float(p["ny"]) for p in pts]
        bx = max(2, int((min(xs) - r) * vid_w))
        by = max(2, int((min(ys) - r) * vid_h))
        bx2 = min(vid_w - 2, int((max(xs) + r) * vid_w))
        by2 = min(vid_h - 2, int((max(ys) + r) * vid_h))
        bw, bh = max(10, bx2 - bx), max(10, by2 - by)
        vf_filters.append(f"delogo=x={bx}:y={by}:w={bw}:h={bh}:show=0")

    crop = ops.get("crop")
    if crop and crop.get("nw", 0) > 0.02 and crop.get("nh", 0) > 0.02:
        cw, ch = int(crop["nw"] * vid_w) & ~1, int(crop["nh"] * vid_h) & ~1
        cx, cy = int(crop["nx"] * vid_w) & ~1, int(crop["ny"] * vid_h) & ~1
        if cw >= 32 and ch >= 32:
            vf_filters.append(f"crop={cw}:{ch}:{cx}:{cy}")
            vid_w, vid_h = cw, ch

    straighten = max(-45.0, min(45.0, float(ops.get("straighten", 0.0) or 0.0)))
    if abs(straighten) >= 0.1:
        vf_filters.append(f"rotate={math.radians(straighten):.4f}:fillcolor=black")

    b_val = float(ops.get("brightness", 1.0)) - 1.0
    c_val = float(ops.get("contrast", 1.0))
    s_val = float(ops.get("saturation", 1.0))
    if abs(b_val) > 0.01 or abs(c_val - 1.0) > 0.01 or abs(s_val - 1.0) > 0.01:
        vf_filters.append(f"eq=brightness={b_val:.2f}:contrast={c_val:.2f}:saturation={s_val:.2f}")

    warmth = max(-1.0, min(1.0, float(ops.get("warmth", 0.0) or 0.0)))
    tint = max(-1.0, min(1.0, float(ops.get("tint", 0.0) or 0.0)))
    if abs(warmth) > 0.01 or abs(tint) > 0.01:
        vf_filters.append(
            f"colorbalance=rs={warmth * 0.16 + tint * 0.06:.2f}:gs={-tint * 0.14:.2f}:bs={-warmth * 0.16 + tint * 0.06:.2f}"
        )

    vignette = max(0.0, min(1.0, float(ops.get("vignette", 0.0) or 0.0)))
    if vignette > 0.01:
        denom = max(2.2, 5.2 - vignette * 2.6)
        vf_filters.append(f"vignette=angle=PI/{denom:.2f}")

    text_items = list(ops.get("text_layers") or [])
    txt_cfg = ops.get("text_overlay")
    if txt_cfg and txt_cfg.get("text", "").strip():
        text_items.insert(0, txt_cfg)
    for tc in text_items:
        raw_t = (tc.get("text") or "").strip()
        if not raw_t:
            continue
        safe_text = raw_t.replace(":", "\\:").replace("'", "")
        fsize = max(18, int((float(tc.get("size", 36) or 36) / 1000.0) * max(vid_w, vid_h)))
        color = tc.get("color", "#ffffff")
        opac = max(0.05, min(1.0, float(tc.get("opacity", 1.0) if tc.get("opacity") is not None else 1.0)))
        fcolor = f"{color}@{opac:.2f}" if opac < 0.99 else color
        shcolor = f"black@{(0.72 * opac):.2f}"
        nx, ny = float(tc.get("nx", 0.05)), float(tc.get("ny", 0.88))
        fpath = resolve_system_font_path(tc.get("font_path"), tc.get("font_family"))
        ff_opt = f":fontfile='{str(fpath).replace(chr(92), '/').replace(':', chr(92) + ':')}'" if fpath else ""
        dt = f"drawtext=text='{safe_text}'{ff_opt}:x=w*{nx:.3f}:y=h*{ny:.3f}:fontsize={fsize}:fontcolor={fcolor}:shadowcolor={shcolor}:shadowx=2:shadowy=2"
        bg_col = (tc.get("bg_color") or "").strip()
        if bg_col and bg_col != "transparent":
            box_col = f"black@{(0.65 * opac):.2f}" if bg_col == "dark" else (f"white@{(0.85 * opac):.2f}" if bg_col == "light" else bg_col)
            dt += f":box=1:boxcolor={box_col}:boxborderw=8"
        st_s = float(tc.get("start_sec", 0.0) or 0.0)
        en_s = float(tc.get("end_sec", 0.0) or 0.0)
        if en_s > st_s:
            dt += f":enable='between(t,{st_s:.2f},{en_s:.2f})'"
        vf_filters.append(dt)

    speed = float(ops.get("speed", 1.0))
    if abs(speed - 1.0) > 0.01 and 0.25 <= speed <= 4.0:
        vf_filters.append(f"setpts={1.0 / speed:.4f}*PTS")
        if speed < 0.5:
            af_filters.append(f"atempo=0.5,atempo={speed / 0.5:.2f}")
        elif speed > 2.0:
            af_filters.append(f"atempo=2.0,atempo={speed / 2.0:.2f}")
        else:
            af_filters.append(f"atempo={speed:.2f}")

    extra_clips = [c for c in (ops.get("extra_clips") or []) if (c.get("path") or "").strip() and Path(c["path"]).exists()]
    img_overlays = [ov for ov in (ops.get("image_overlays") or []) if (ov.get("path") or "").strip() and Path(ov["path"]).exists()]
    draw_tmp_path = None
    draw_ov_vid = _decode_dataurl_png(ops.get("draw_layer_png"))
    if draw_ov_vid is not None and draw_ov_vid.getbbox():
        draw_tmp_path = src_path.parent / f".tmp_draw_{os.getpid()}.png"
        draw_ov_vid.save(draw_tmp_path, format="PNG")
        img_overlays.insert(0, {"path": str(draw_tmp_path), "nx": 0.0, "ny": 0.0, "nw": 1.0, "opacity": 1.0})
    custom_audio = (ops.get("custom_audio_path") or "").strip()
    has_custom_audio = bool(custom_audio and Path(custom_audio).exists())
    mute_audio = bool(ops.get("mute_audio", False))
    audio_mix_mode = (ops.get("audio_mix_mode") or "replace").lower()
    orig_vol = max(0.0, min(2.0, float(ops.get("original_audio_volume", 1.0) if ops.get("original_audio_volume") is not None else 1.0)))
    music_vol = max(0.0, min(2.0, float(ops.get("audio_volume", 1.0) if ops.get("audio_volume") is not None else 1.0)))

    out_path = get_output_path(src_path, overwrite=overwrite, suffix_tag="_edit")
    tmp_path = out_path.with_name(f".tmp_{out_path.name}")

    cmd = ["ffmpeg", "-y"]
    start_s = float(ops.get("start_sec", 0.0))
    end_s = float(ops.get("end_sec", 0.0))

    # Mode simple (1 clip source sans B-roll ni incrustation image complexe ni mix audio)
    if not extra_clips and not img_overlays and not (has_custom_audio and audio_mix_mode == "mix"):
        if start_s > 0:
            cmd.extend(["-ss", f"{start_s:.3f}"])
        if end_s > start_s:
            cmd.extend(["-t", f"{max(0.1, end_s - start_s):.3f}"])
        cmd.extend(["-i", str(src_path)])

        if has_custom_audio:
            cmd.extend(["-i", custom_audio, "-map", "0:v:0", "-map", "1:a:0", "-shortest"])
            if abs(music_vol - 1.0) > 0.02:
                af_filters = [f"volume={music_vol:.2f}"]
        elif abs(orig_vol - 1.0) > 0.02 and not mute_audio:
            af_filters.append(f"volume={orig_vol:.2f}")

        if vf_filters:
            cmd.extend(["-vf", ",".join(vf_filters)])
        if mute_audio:
            cmd.append("-an")
        elif af_filters:
            cmd.extend(["-af", ",".join(af_filters)])

        if not vf_filters and not af_filters and not has_custom_audio:
            cmd.extend(["-c:v", "copy"])
            if not mute_audio:
                cmd.extend(["-c:a", "copy"])
        else:
            cmd.extend(["-c:v", "libx264", "-preset", "fast", "-crf", "20", "-c:a", "aac"])

        cmd.append(str(tmp_path))
        subprocess.run(cmd, check=True)
        preserve_metadata_and_time(src_path, tmp_path, timestamp)
        shutil.move(tmp_path, out_path)
        return [out_path]

    # Mode avancé multipiste : concaténation extra_clips / incrustations V2 / mixage audio
    fc_parts = []
    if start_s > 0:
        cmd.extend(["-ss", f"{start_s:.3f}"])
    if end_s > start_s:
        cmd.extend(["-t", f"{max(0.1, end_s - start_s):.3f}"])
    cmd.extend(["-i", str(src_path)])
    next_idx = 1

    clip_labels = []
    base_vf = ",".join(vf_filters) if vf_filters else "null"
    even_w, even_h = max(32, vid_w & ~1), max(32, vid_h & ~1)
    fc_parts.append(f"[0:v]{base_vf},scale={even_w}:{even_h}:force_original_aspect_ratio=decrease,pad={even_w}:{even_h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v_base_0]")
    clip_labels.append("[v_base_0]")

    for ci, ec in enumerate(extra_clips):
        ep = Path(ec["path"])
        e_start = float(ec.get("start_sec", 0.0) or 0.0)
        e_end = float(ec.get("end_sec", 0.0) or 0.0)
        is_still = ep.suffix.lower() not in VIDEO_EXTS
        if is_still:
            dur_img = max(1.0, (e_end - e_start) if e_end > e_start else float(ec.get("duration_sec", 3.0) or 3.0))
            cmd.extend(["-loop", "1", "-t", f"{dur_img:.2f}", "-i", str(ep)])
        else:
            if e_start > 0:
                cmd.extend(["-ss", f"{e_start:.3f}"])
            if e_end > e_start:
                cmd.extend(["-t", f"{max(0.2, e_end - e_start):.3f}"])
            cmd.extend(["-i", str(ep)])
        lbl = f"[v_ext_{ci}]"
        fc_parts.append(f"[{next_idx}:v]scale={even_w}:{even_h}:force_original_aspect_ratio=decrease,pad={even_w}:{even_h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p{lbl}")
        clip_labels.append(lbl)
        next_idx += 1

    if len(clip_labels) > 1:
        fc_parts.append(f"{''.join(clip_labels)}concat=n={len(clip_labels)}:v=1:a=0[v_seq]")
        cur_v = "[v_seq]"
    else:
        cur_v = "[v_base_0]"

    for oi, ov in enumerate(img_overlays):
        ov_p = Path(ov["path"])
        cmd.extend(["-i", str(ov_p)])
        ov_idx = next_idx
        next_idx += 1
        ow = max(16, int(float(ov.get("nw", 0.22) or 0.22) * even_w) & ~1)
        ox = int(float(ov.get("nx", 0.06) or 0.06) * even_w)
        oy = int(float(ov.get("ny", 0.06) or 0.06) * even_h)
        opac = max(0.05, min(1.0, float(ov.get("opacity", 1.0) or 1.0)))
        ov_prep = f"[ovp_{oi}]"
        fc_parts.append(f"[{ov_idx}:v]format=rgba,scale={ow}:-1,colorchannelmixer=aa={opac:.2f}{ov_prep}")
        st_s = float(ov.get("start_sec", 0.0) or 0.0)
        en_s = float(ov.get("end_sec", 0.0) or 0.0)
        en_expr = f":enable='between(t,{st_s:.2f},{en_s:.2f})'" if en_s > st_s else ""
        next_v = f"[v_ov_{oi}]"
        fc_parts.append(f"{cur_v}{ov_prep}overlay={ox}:{oy}{en_expr}{next_v}")
        cur_v = next_v

    audio_map = None
    if not mute_audio:
        if has_custom_audio:
            cmd.extend(["-i", custom_audio])
            ca_idx = next_idx
            next_idx += 1
            if audio_mix_mode == "mix":
                orig_flt = ",".join(af_filters + [f"volume={orig_vol:.2f}"]) if af_filters else f"volume={orig_vol:.2f}"
                fc_parts.append(f"[0:a]{orig_flt}[a_orig];[{ca_idx}:a]volume={music_vol:.2f}[a_mus];[a_orig][a_mus]amix=inputs=2:duration=first:dropout_transition=2[a_out]")
                audio_map = "[a_out]"
            else:
                fc_parts.append(f"[{ca_idx}:a]volume={music_vol:.2f}[a_out]")
                audio_map = "[a_out]"
        elif af_filters or abs(orig_vol - 1.0) > 0.02:
            a_chain = ",".join(af_filters + ([f"volume={orig_vol:.2f}"] if abs(orig_vol - 1.0) > 0.02 else []))
            fc_parts.append(f"[0:a]{a_chain}[a_out]")
            audio_map = "[a_out]"
        else:
            audio_map = "0:a?"

    cmd.extend(["-filter_complex", ";".join(fc_parts), "-map", cur_v])
    if audio_map:
        cmd.extend(["-map", audio_map, "-shortest"])
    else:
        cmd.append("-an")
    cmd.extend(["-c:v", "libx264", "-preset", "fast", "-crf", "20", "-c:a", "aac", str(tmp_path)])
    try:
        subprocess.run(cmd, check=True)
    finally:
        if draw_tmp_path and draw_tmp_path.exists():
            draw_tmp_path.unlink(missing_ok=True)
    preserve_metadata_and_time(src_path, tmp_path, timestamp)
    shutil.move(tmp_path, out_path)
    return [out_path]