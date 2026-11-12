import os
import json
import shutil
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT_DIR = Path(__file__).resolve().parents[2]
CONFIG_DIR = ROOT_DIR / "config"
SETTINGS_FILE = CONFIG_DIR / "app_settings.json"
LEGACY_SETTINGS_FILE = ROOT_DIR / "app_settings.json"

DEFAULT_SETTINGS = {
    "scanned_folders": [],
    "takeout_extract_dir": "",
    "timezone": "Europe/Paris",
    "language": "fr",
    "gpu_mode": "cuda"  # "cuda" (NVIDIA), "directml"/"amd" (AMD Radeon), "intel"/"cpu"
}


def _ensure_settings_file() -> Path:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if LEGACY_SETTINGS_FILE.exists():
        try:
            if not SETTINGS_FILE.exists():
                shutil.copy2(str(LEGACY_SETTINGS_FILE), str(SETTINGS_FILE))
            LEGACY_SETTINGS_FILE.unlink(missing_ok=True)
        except OSError:
            pass
    return SETTINGS_FILE


def load_settings() -> dict:
    cfg_path = _ensure_settings_file()
    if cfg_path.exists():
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                return {**DEFAULT_SETTINGS, **json.load(f)}
        except Exception:
            pass
    return DEFAULT_SETTINGS.copy()


def save_settings(new_settings: dict) -> dict:
    cfg_path = _ensure_settings_file()
    current = load_settings()
    current.update(new_settings)
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump(current, f, indent=4, ensure_ascii=False)
    return current


def get_configured_timezone() -> ZoneInfo:
    tz_name = load_settings().get("timezone", "Europe/Paris")
    try:
        return ZoneInfo(tz_name)
    except Exception:
        return ZoneInfo("Europe/Paris")


def apply_gpu_environment(gpu_mode: str):
    if gpu_mode == "cpu":
        os.environ["CUDA_VISIBLE_DEVICES"] = "-1"
    else:
        os.environ.pop("CUDA_VISIBLE_DEVICES", None)


def get_hardware_runtime_config() -> dict:
    mode = load_settings().get("gpu_mode", "cuda").lower()
    apply_gpu_environment(mode)

    if mode == "cpu":
        return {
            "mode": "cpu",
            "onnx_providers": ["CPUExecutionProvider"],
            "onnx_ctx_id": -1,
            "paddle_use_gpu": False,
            "paddle_enable_mkldnn": True,
            "torch_device": "cpu"
        }

    if mode == "cuda":
        return {
            "mode": "cuda",
            "onnx_providers": ["CUDAExecutionProvider", "CPUExecutionProvider"],
            "onnx_ctx_id": 0,
            "paddle_use_gpu": True,
            "paddle_enable_mkldnn": False,
            "torch_device": "cuda"
        }

    if mode in ("amd", "directml"):
        return {
            "mode": mode,
            "onnx_providers": ["ROCMExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider"],
            "onnx_ctx_id": 0,
            "paddle_use_gpu": False,
            "paddle_enable_mkldnn": True,
            "torch_device": "cuda"
        }

    if mode == "intel":
        return {
            "mode": "intel",
            "onnx_providers": ["OpenVINOExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider"],
            "onnx_ctx_id": 0,
            "paddle_use_gpu": False,
            "paddle_enable_mkldnn": True,
            "torch_device": "xpu"
        }

    return {
        "mode": "cpu",
        "onnx_providers": ["CPUExecutionProvider"],
        "onnx_ctx_id": -1,
        "paddle_use_gpu": False,
        "paddle_enable_mkldnn": True,
        "torch_device": "cpu"
    }