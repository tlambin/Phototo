import re
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageOps

try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
except Exception:
    pass

IMAGE_EXTS = {
    '.jpg', '.jpeg', '.png', '.webp', '.gif', '.apng', '.bmp', '.tiff', '.tif', '.heic', '.heif', '.avif',
    '.dng', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2'
}
VIDEO_EXTS = {
    '.mp4', '.mov', '.avi', '.mkv', '.3gp', '.m4v', '.mpg', '.mpeg', '.wmv', '.flv', '.mts', '.m2ts', '.webm'
}
ALL_MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS

_MOTION_PHOTO_RE = re.compile(
    rb'(?:GCamera:MotionPhoto|MotionPhoto)\s*=\s*["\']1["\']|<GCamera:MotionPhoto>\s*1\s*</GCamera:MotionPhoto>',
    re.IGNORECASE,
)


def detect_is_animated(file_path: str | Path, sibling_mov_stems: set[tuple[str, str]] | None = None) -> int:
    """
    Retourne 1 si le média est une image animée / Live Photo / Motion Photo, sinon 0 :
    - .gif ou .apng
    - .webp / .avif / .png multi-images (frame count > 1)
    - Live Photo iOS (.heic/.jpg appairé à un .mov)
    - Motion Photo Android (.jpg/.heic avec balise XMP GCamera:MotionPhoto = 1)
    """
    p = Path(file_path)
    ext = p.suffix.lower()

    if ext in (".gif", ".apng"):
        return 1

    if not p.exists():
        return 0

    if ext in (".webp", ".avif", ".png"):
        try:
            with open(p, "rb") as f:
                head = f.read(16384)
            if ext == ".png":
                actl = head.find(b"acTL")
                if actl != -1:
                    idat = head.find(b"IDAT")
                    return 1 if (idat == -1 or actl < idat) else 0
                return 0
            if ext == ".webp":
                return 1 if b"ANIM" in head else 0
            if ext == ".avif" and (b"avis" in head[:128] or b"msf1" in head[:128]):
                return 1
        except Exception:
            pass
        if ext == ".avif":
            try:
                with Image.open(p) as im:
                    if getattr(im, "is_animated", False) or getattr(im, "n_frames", 1) > 1:
                        return 1
            except Exception:
                pass
        return 0

    if ext in (".jpg", ".jpeg", ".heic", ".heif"):
        # Live Photo iOS (paire .heic/.jpg + .mov)
        if sibling_mov_stems is not None:
            if (str(p.parent).lower(), p.stem.lower()) in sibling_mov_stems:
                return 1
        else:
            if p.with_suffix(".mov").exists() or p.with_suffix(".MOV").exists():
                return 1

        # Motion Photo Android (XMP GCamera:MotionPhoto = 1)
        try:
            with open(p, "rb") as f:
                head = f.read(131072)
            if _MOTION_PHOTO_RE.search(head):
                return 1
        except Exception:
            pass

    return 0


def extract_analysis_frames(file_path: str | Path, max_dim: int | None = None) -> list[np.ndarray]:
    """
    Retourne [img_bgr] pour une photo, ou 3 images clés [15%, 50%, 85%] pour une vidéo.
    """
    p = Path(file_path)
    if not p.exists():
        return []

    ext = p.suffix.lower()
    frames = []

    if ext in IMAGE_EXTS:
        img = None
        try:
            with Image.open(p) as pil_im:
                pil_im = ImageOps.exif_transpose(pil_im)
                if pil_im.mode != "RGB":
                    pil_im = pil_im.convert("RGB")
                img = cv2.cvtColor(np.array(pil_im), cv2.COLOR_RGB2BGR)
        except Exception:
            try:
                raw = np.fromfile(str(p), dtype=np.uint8)
                if raw.size > 0:
                    img = cv2.imdecode(raw, cv2.IMREAD_COLOR)
            except Exception:
                img = None
        if img is not None:
            frames.append(img)
    elif ext in VIDEO_EXTS:
        cap = cv2.VideoCapture(str(p))
        if cap.isOpened():
            total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            positions = [int(total_frames * r) for r in (0.15, 0.50, 0.85)] if total_frames >= 3 else [0]
            for pos in positions:
                cap.set(cv2.CAP_PROP_POS_FRAMES, pos)
                ret, frame = cap.read()
                if ret and frame is not None:
                    frames.append(frame)
            cap.release()

    if max_dim and frames:
        resized = []
        for f in frames:
            h, w = f.shape[:2]
            if max(h, w) > max_dim:
                scale = max_dim / float(max(h, w))
                f = cv2.resize(f, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
            resized.append(f)
        return resized

    return frames


def probe_media_dimensions(file_path: str | Path) -> tuple[int, int]:
    """Retourne (largeur, hauteur) d'une image ou vidéo via PIL/OpenCV puis ExifTool en repli."""
    p = Path(file_path)
    if not p.exists() or not p.is_file():
        return (0, 0)
    ext = p.suffix.lower()

    if ext in VIDEO_EXTS:
        cap = None
        try:
            cap = cv2.VideoCapture(str(p))
            if cap.isOpened():
                w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
                h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
                if w <= 0 or h <= 0:
                    ret, frame = cap.read()
                    if ret and frame is not None:
                        h, w = int(frame.shape[0]), int(frame.shape[1])
                if w > 0 and h > 0:
                    return (w, h)
        except Exception:
            pass
        finally:
            if cap is not None:
                try:
                    cap.release()
                except Exception:
                    pass
    else:
        try:
            with Image.open(p) as im:
                w, h = im.size
                try:
                    if im.getexif().get(274) in (5, 6, 7, 8):
                        w, h = h, w
                except Exception:
                    pass
                if w > 0 and h > 0:
                    return (int(w), int(h))
        except Exception:
            pass

    try:
        import exiftool
        with exiftool.ExifToolHelper(common_args=["-G", "-n", "-charset", "filename=utf8"]) as et:
            meta_list = et.get_metadata(str(p))
        if meta_list:
            m = meta_list[0]
            w_val = (
                m.get("QuickTime:ImageWidth")
                or m.get("Matroska:ImageWidth")
                or m.get("RIFF:ImageWidth")
                or m.get("ASF:ImageWidth")
                or m.get("File:ImageWidth")
                or m.get("EXIF:ExifImageWidth")
                or m.get("EXIF:ImageWidth")
                or m.get("PNG:ImageWidth")
                or 0
            )
            h_val = (
                m.get("QuickTime:ImageHeight")
                or m.get("Matroska:ImageHeight")
                or m.get("RIFF:ImageHeight")
                or m.get("ASF:ImageHeight")
                or m.get("File:ImageHeight")
                or m.get("EXIF:ExifImageHeight")
                or m.get("EXIF:ImageHeight")
                or m.get("PNG:ImageHeight")
                or 0
            )
            if (not w_val or not h_val) and m.get("Composite:ImageSize"):
                parts = re.findall(r"\d+", str(m.get("Composite:ImageSize")))
                if len(parts) >= 2:
                    w_val, h_val = int(parts[0]), int(parts[1])
            if w_val and h_val:
                return (int(w_val), int(h_val))
    except Exception:
        pass
    return (0, 0)