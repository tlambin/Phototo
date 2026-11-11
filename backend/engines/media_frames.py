from pathlib import Path
import cv2
import numpy as np

IMAGE_EXTS = {
    '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif', '.heic', '.heif', '.avif',
    '.dng', '.cr2', '.cr3', '.nef', '.arw', '.orf', '.rw2'
}
VIDEO_EXTS = {
    '.mp4', '.mov', '.avi', '.mkv', '.3gp', '.m4v', '.mpg', '.mpeg', '.wmv', '.flv', '.mts', '.m2ts', '.webm'
}
ALL_MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS


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
        img = cv2.imread(str(p))
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