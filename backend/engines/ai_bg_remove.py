import threading
from pathlib import Path
import cv2
import numpy as np
from PIL import Image

ROOT_DIR = Path(__file__).resolve().parents[2]
BG_DIR = ROOT_DIR / "tools" / "ai_models" / "u2netp"
BG_MODEL_PATH = BG_DIR / "u2netp.onnx"
BG_HF_REPO = "Carve/u2netp-onnx"
BG_HF_FILE = "u2netp.onnx"
BG_FALLBACK_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx"

_SESSION_LOCK = threading.Lock()
_BG_SESSION = None
_INSTALL_LOCK = threading.Lock()
_INSTALL_STATE = {
    "installing": False,
    "error": None,
}


def _get_ort_providers() -> list[str]:
    try:
        import onnxruntime as ort
        avail = ort.get_available_providers()
        preferred = [p for p in ("CUDAExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider") if p in avail]
        return preferred or avail
    except Exception:
        return ["CPUExecutionProvider"]


def get_ai_bg_remove_status() -> dict:
    installed = BG_MODEL_PATH.exists() and BG_MODEL_PATH.is_file() and BG_MODEL_PATH.stat().st_size > 500_000
    size_mb = round(BG_MODEL_PATH.stat().st_size / (1024 * 1024), 1) if installed else 0.0
    providers = _get_ort_providers()
    has_gpu = any(p in providers for p in ("CUDAExecutionProvider", "DmlExecutionProvider"))
    with _INSTALL_LOCK:
        st = dict(_INSTALL_STATE)
    return {
        "installed": installed,
        "model_name": "U2-Netp IA (ONNX)",
        "model_path": str(BG_MODEL_PATH),
        "size_mb": size_mb,
        "providers": providers,
        "device_label": "GPU (ONNX)" if has_gpu else "CPU (ONNX)",
        "installing": st["installing"],
        "error": st["error"],
    }


def _download_bg_worker():
    try:
        BG_DIR.mkdir(parents=True, exist_ok=True)
        downloaded = False
        try:
            from huggingface_hub import hf_hub_download
            hf_hub_download(
                repo_id=BG_HF_REPO,
                filename=BG_HF_FILE,
                local_dir=str(BG_DIR),
            )
            downloaded = BG_MODEL_PATH.exists() and BG_MODEL_PATH.stat().st_size > 500_000
        except Exception:
            downloaded = False

        if not downloaded:
            import urllib.request
            tmp = BG_MODEL_PATH.with_suffix(".onnx.tmp")
            urllib.request.urlretrieve(BG_FALLBACK_URL, str(tmp))
            tmp.replace(BG_MODEL_PATH)

        with _INSTALL_LOCK:
            _INSTALL_STATE["installing"] = False
            _INSTALL_STATE["error"] = None
    except Exception as e:
        with _INSTALL_LOCK:
            _INSTALL_STATE["installing"] = False
            _INSTALL_STATE["error"] = str(e)[:280]


def start_bg_remove_install() -> dict:
    st = get_ai_bg_remove_status()
    if st["installed"]:
        return {"status": "already_installed", **st}
    with _INSTALL_LOCK:
        if _INSTALL_STATE["installing"]:
            return {"status": "installing", **get_ai_bg_remove_status()}
        _INSTALL_STATE["installing"] = True
        _INSTALL_STATE["error"] = None
    t = threading.Thread(target=_download_bg_worker, daemon=True)
    t.start()
    return {"status": "started", **get_ai_bg_remove_status()}


def _get_bg_session():
    global _BG_SESSION
    if _BG_SESSION is not None:
        return _BG_SESSION
    if not (BG_MODEL_PATH.exists() and BG_MODEL_PATH.stat().st_size > 500_000):
        return None
    with _SESSION_LOCK:
        if _BG_SESSION is not None:
            return _BG_SESSION
        import onnxruntime as ort
        providers = _get_ort_providers()
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        _BG_SESSION = ort.InferenceSession(str(BG_MODEL_PATH), sess_options=opts, providers=providers)
        return _BG_SESSION


def _fallback_grabcut_alpha(rgb: np.ndarray) -> np.ndarray:
    """Segmentation avant-plan/arrière-plan automatique par GrabCut OpenCV."""
    h, w = rgb.shape[:2]
    scale = min(1.0, 480.0 / max(1, w, h))
    sw, sh = max(16, int(w * scale)), max(16, int(h * scale))
    small = cv2.resize(rgb, (sw, sh), interpolation=cv2.INTER_AREA)
    bgr_small = cv2.cvtColor(small, cv2.COLOR_RGB2BGR)

    mask = np.zeros((sh, sw), np.uint8)
    mx = max(2, int(sw * 0.08))
    my = max(2, int(sh * 0.08))
    rect = (mx, my, max(8, sw - 2 * mx), max(8, sh - 2 * my))
    bgd_model = np.zeros((1, 65), np.float64)
    fgd_model = np.zeros((1, 65), np.float64)
    try:
        cv2.grabCut(bgr_small, mask, rect, bgd_model, fgd_model, 3, cv2.GC_INIT_WITH_RECT)
        fg = np.where((mask == 2) | (mask == 0), 0, 255).astype(np.uint8)
    except Exception:
        fg = np.full((sh, sw), 255, dtype=np.uint8)

    fg = cv2.GaussianBlur(fg, (7, 7), 0)
    return cv2.resize(fg, (w, h), interpolation=cv2.INTER_LINEAR)


def compute_foreground_alpha(img: Image.Image) -> tuple[np.ndarray, str]:
    """Retourne un masque alpha uint8 (H, W) du sujet principal et le moteur utilisé."""
    rgb = np.array(img.convert("RGB"))
    h, w = rgb.shape[:2]
    sess = _get_bg_session()
    if sess is not None:
        try:
            inp_size = 320
            resized = cv2.resize(rgb, (inp_size, inp_size), interpolation=cv2.INTER_LINEAR).astype(np.float32) / 255.0
            mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
            std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
            norm = (resized - mean) / std
            chw = np.transpose(norm, (2, 0, 1))[None, ...]
            in_name = sess.get_inputs()[0].name
            out = sess.run(None, {in_name: chw})[0]
            pred = np.squeeze(out).astype(np.float32)
            p_min, p_max = float(pred.min()), float(pred.max())
            if p_max - p_min > 1e-6:
                pred = (pred - p_min) / (p_max - p_min)
            else:
                pred = np.ones_like(pred)
            alpha_u8 = (np.clip(pred, 0.0, 1.0) * 255.0).astype(np.uint8)
            alpha_u8 = cv2.resize(alpha_u8, (w, h), interpolation=cv2.INTER_LINEAR)
            return alpha_u8, "u2netp-onnx"
        except Exception:
            pass

    return _fallback_grabcut_alpha(rgb), "opencv-grabcut"


def apply_background_removal(img: Image.Image, mode: str = "transparent") -> tuple[Image.Image, str]:
    """Supprime ou remplace l'arrière-plan (transparent, blur, white, black)."""
    alpha_u8, engine = compute_foreground_alpha(img)
    rgba = img.convert("RGBA")
    r, g, b, _ = rgba.split()
    alpha_pil = Image.fromarray(alpha_u8, mode="L")
    fg_rgba = Image.merge("RGBA", (r, g, b, alpha_pil))

    m = (mode or "transparent").lower()
    if m == "transparent":
        return fg_rgba, engine
    if m == "blur":
        from PIL import ImageFilter
        rad = max(12, int(max(img.size) / 45))
        bg = img.convert("RGB").filter(ImageFilter.GaussianBlur(radius=rad)).convert("RGBA")
        return Image.alpha_composite(bg, fg_rgba).convert("RGB"), engine
    if m == "black":
        bg = Image.new("RGBA", img.size, (12, 12, 14, 255))
        return Image.alpha_composite(bg, fg_rgba).convert("RGB"), engine
    # default white
    bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
    return Image.alpha_composite(bg, fg_rgba).convert("RGB"), engine
