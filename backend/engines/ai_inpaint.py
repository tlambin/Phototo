import threading
from pathlib import Path
import cv2
import numpy as np
from PIL import Image

ROOT_DIR = Path(__file__).resolve().parents[2]
LAMA_DIR = ROOT_DIR / "tools" / "ai_models" / "lama"
LAMA_MODEL_PATH = LAMA_DIR / "lama_fp32.onnx"
LAMA_HF_REPO = "Carve/LaMa-ONNX"
LAMA_HF_FILE = "lama_fp32.onnx"

_SESSION_LOCK = threading.Lock()
_LAMA_SESSION = None
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


def get_ai_inpaint_status() -> dict:
    installed = LAMA_MODEL_PATH.exists() and LAMA_MODEL_PATH.is_file() and LAMA_MODEL_PATH.stat().st_size > 1_000_000
    size_mb = round(LAMA_MODEL_PATH.stat().st_size / (1024 * 1024), 1) if installed else 0.0
    providers = _get_ort_providers()
    has_gpu = any(p in providers for p in ("CUDAExecutionProvider", "DmlExecutionProvider"))
    with _INSTALL_LOCK:
        st = dict(_INSTALL_STATE)
    return {
        "installed": installed,
        "model_name": "LaMa AI (Carve/LaMa-ONNX)",
        "model_path": str(LAMA_MODEL_PATH),
        "size_mb": size_mb,
        "providers": providers,
        "device_label": "GPU (ONNX)" if has_gpu else "CPU (ONNX)",
        "installing": st["installing"],
        "error": st["error"],
    }


def _download_lama_worker():
    try:
        LAMA_DIR.mkdir(parents=True, exist_ok=True)
        from huggingface_hub import hf_hub_download
        hf_hub_download(
            repo_id=LAMA_HF_REPO,
            filename=LAMA_HF_FILE,
            local_dir=str(LAMA_DIR),
        )
        with _INSTALL_LOCK:
            _INSTALL_STATE["installing"] = False
            _INSTALL_STATE["error"] = None
    except Exception as e:
        with _INSTALL_LOCK:
            _INSTALL_STATE["installing"] = False
            _INSTALL_STATE["error"] = str(e)[:280]


def start_lama_install() -> dict:
    st = get_ai_inpaint_status()
    if st["installed"]:
        return {"status": "already_installed", **st}
    with _INSTALL_LOCK:
        if _INSTALL_STATE["installing"]:
            return {"status": "installing", **get_ai_inpaint_status()}
        _INSTALL_STATE["installing"] = True
        _INSTALL_STATE["error"] = None
    t = threading.Thread(target=_download_lama_worker, daemon=True)
    t.start()
    return {"status": "started", **get_ai_inpaint_status()}


def _get_lama_session():
    global _LAMA_SESSION
    if _LAMA_SESSION is not None:
        return _LAMA_SESSION
    if not (LAMA_MODEL_PATH.exists() and LAMA_MODEL_PATH.stat().st_size > 1_000_000):
        return None
    with _SESSION_LOCK:
        if _LAMA_SESSION is not None:
            return _LAMA_SESSION
        import onnxruntime as ort
        providers = _get_ort_providers()
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        _LAMA_SESSION = ort.InferenceSession(str(LAMA_MODEL_PATH), sess_options=opts, providers=providers)
        return _LAMA_SESSION


def _fallback_structural_inpaint(bgr: np.ndarray, mask_u8: np.ndarray) -> np.ndarray:
    """Repli multi-passes Navier-Stokes + Telea avec fusion douce quand LaMa ONNX n'est pas installé."""
    in_ns = cv2.inpaint(bgr, mask_u8, inpaintRadius=9, flags=cv2.INPAINT_NS)
    in_tl = cv2.inpaint(bgr, mask_u8, inpaintRadius=7, flags=cv2.INPAINT_TELEA)
    blended = cv2.addWeighted(in_ns, 0.55, in_tl, 0.45, 0.0)
    feather = cv2.GaussianBlur((mask_u8 > 0).astype(np.float32), (11, 11), 0)[..., None]
    out = bgr.astype(np.float32) * (1.0 - feather) + blended.astype(np.float32) * feather
    return np.clip(out, 0, 255).astype(np.uint8)


def _run_lama_crop(sess, rgb: np.ndarray, mask_u8: np.ndarray) -> np.ndarray:
    H, W = rgb.shape[:2]
    ys, xs = np.where(mask_u8 > 0)
    if len(xs) == 0 or len(ys) == 0:
        return rgb

    inps = sess.get_inputs()
    img_inp_name = inps[0].name
    mask_inp_name = inps[1].name
    shape0 = inps[0].shape
    model_h = int(shape0[2]) if len(shape0) >= 4 and isinstance(shape0[2], int) and shape0[2] > 0 else 512
    model_w = int(shape0[3]) if len(shape0) >= 4 and isinstance(shape0[3], int) and shape0[3] > 0 else 512

    x1, x2 = int(xs.min()), int(xs.max())
    y1, y2 = int(ys.min()), int(ys.max())
    bw, bh = max(1, x2 - x1 + 1), max(1, y2 - y1 + 1)
    cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
    # Contexte large (au moins 2.4x l'objet ou model_w/2) pour la reconstruction sémantique
    side = max(bw * 2.4, bh * 2.4, min(max(W, H), model_w))
    half = int(min(max(side / 2, 128), max(W, H)))

    rx1 = max(0, cx - half)
    ry1 = max(0, cy - half)
    rx2 = min(W, rx1 + half * 2)
    ry2 = min(H, ry1 + half * 2)
    if rx2 - rx1 < min(W, half * 2):
        rx1 = max(0, rx2 - half * 2)
    if ry2 - ry1 < min(H, half * 2):
        ry1 = max(0, ry2 - half * 2)

    crop_rgb = rgb[ry1:ry2, rx1:rx2]
    crop_m = (mask_u8[ry1:ry2, rx1:rx2] > 0).astype(np.uint8) * 255
    ch, cw = crop_rgb.shape[:2]

    in_rgb = cv2.resize(crop_rgb, (model_w, model_h), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    in_m = (cv2.resize(crop_m, (model_w, model_h), interpolation=cv2.INTER_NEAREST) > 127).astype(np.float32)

    img_t = np.transpose(in_rgb, (2, 0, 1))[None, ...]
    mask_t = in_m[None, None, ...]

    out_arr = sess.run(None, {img_inp_name: img_t, mask_inp_name: mask_t})[0]
    pred = np.transpose(np.squeeze(out_arr, axis=0), (1, 2, 0))
    if pred.max() <= 1.5:
        pred = pred * 255.0
    pred_u8 = np.clip(pred, 0, 255).astype(np.uint8)
    pred_resized = cv2.resize(pred_u8, (cw, ch), interpolation=cv2.INTER_LANCZOS4)

    soft_m = cv2.GaussianBlur((crop_m > 0).astype(np.float32), (15, 15), 0)[..., None]
    soft_m = np.clip(soft_m, 0.0, 1.0)
    blended = crop_rgb.astype(np.float32) * (1.0 - soft_m) + pred_resized.astype(np.float32) * soft_m

    res = rgb.copy()
    res[ry1:ry2, rx1:rx2] = np.clip(blended, 0, 255).astype(np.uint8)
    return res


def inpaint_image_with_ai(rgb_img: Image.Image, mask_u8: np.ndarray) -> tuple[Image.Image, str]:
    """Supprime un objet sur l'image via LaMa ONNX si installé, sinon repli multi-passes."""
    if mask_u8 is None or not np.any(mask_u8):
        return rgb_img, "none"
    rgb_arr = np.array(rgb_img.convert("RGB"), dtype=np.uint8)
    sess = None
    try:
        sess = _get_lama_session()
    except Exception:
        sess = None
    if sess is not None:
        try:
            out_rgb = _run_lama_crop(sess, rgb_arr, mask_u8)
            return Image.fromarray(out_rgb), "lama_onnx"
        except Exception:
            pass
    bgr = cv2.cvtColor(rgb_arr, cv2.COLOR_RGB2BGR)
    out_bgr = _fallback_structural_inpaint(bgr, mask_u8)
    return Image.fromarray(cv2.cvtColor(out_bgr, cv2.COLOR_BGR2RGB)), "opencv_fallback"
