import os
import json
from pathlib import Path
from zoneinfo import ZoneInfo

SETTINGS_FILE = Path("app_settings.json")

DEFAULT_SETTINGS = {
    "scanned_folders": [],
    "takeout_extract_dir": "",
    "timezone": "Europe/Paris",
    "language": "fr",
    "gpu_mode": "cuda"  # "cuda" (NVIDIA), "amd" (AMD Radeon), "intel" (Intel Arc/iGPU), "cpu"
}


def load_settings() -> dict:
    if SETTINGS_FILE.exists():
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                return {**DEFAULT_SETTINGS, **json.load(f)}
        except Exception:
            pass
    return DEFAULT_SETTINGS.copy()


def save_settings(new_settings: dict) -> dict:
    current = load_settings()
    current.update(new_settings)
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
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

    if mode == "amd":
        return {
            "mode": "amd",
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