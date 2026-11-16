import os
import json
import shutil
import ctypes
import platform
import subprocess
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT_DIR = Path(__file__).resolve().parents[2]
CONFIG_DIR = ROOT_DIR / "config"
SETTINGS_FILE = CONFIG_DIR / "app_settings.json"
LEGACY_SETTINGS_FILE = ROOT_DIR / "app_settings.json"

DEFAULT_SETTINGS = {
    "scanned_folders": [],
    "takeout_extract_dir": "",
    "takeout_default_architecture": "KEEP_ORIGINAL",
    "takeout_default_fix_metadata": True,
    "takeout_default_delete_zips": False,
    "takeout_timezone_mode": "GPS_OR_SETTINGS",  # "GPS_OR_SETTINGS" | "SETTINGS_ONLY" | "UTC"
    "takeout_use_gps_timezone": True,
    "timezone": "Europe/Paris",
    "language": "fr",
    "gpu_mode": "auto",  # "auto", "cuda" (NVIDIA), "directml"/"amd" (AMD Radeon), "intel"/"cpu"
    "ocr_engine": "paddleocr",  # "rapidocr", "easyocr", "paddleocr"
    "faces_model": "buffalo_l",  # "buffalo_s", "buffalo_l", "antelopev2"
    "clip_model": "vit-b-32"     # "vit-b-32", "vit-b-16", "vit-l-14"
}

FACES_MODEL_SPECS = {
    "buffalo_s": {
        "id": "buffalo_s",
        "label": "buffalo_s (Léger)",
        "description": "Détection et reconnaissance rapides, adapté aux PC modestes ou CPU.",
    },
    "buffalo_l": {
        "id": "buffalo_l",
        "label": "buffalo_l (Équilibré)",
        "description": "Excellent compromis vitesse/précision avec ONNX Runtime.",
    },
    "antelopev2": {
        "id": "antelopev2",
        "label": "antelopev2 (Précision)",
        "description": "Modèle haute précision pour visages difficiles, idéal sur GPU.",
    },
}

CLIP_MODEL_SPECS = {
    "vit-b-32": {
        "id": "vit-b-32",
        "label": "ViT-B-32 (Rapide & FR)",
        "description": "512 dims, rapide et optimisé multilingue (français inclus).",
        "vision_model": "clip-ViT-B-32",
        "text_model": "sentence-transformers/clip-ViT-B-32-multilingual-v1",
        "cache_tokens": ["clip-vit-b-32"],
    },
    "vit-b-16": {
        "id": "vit-b-16",
        "label": "ViT-B-16 (Équilibré)",
        "description": "Patchs plus fins (16px) pour mieux reconnaître les petits objets.",
        "vision_model": "clip-ViT-B-16",
        "text_model": "clip-ViT-B-16",
        "cache_tokens": ["clip-vit-b-16"],
    },
    "vit-l-14": {
        "id": "vit-l-14",
        "label": "ViT-L-14 (Haute Précision)",
        "description": "768 dims, précision maximale sur scènes complexes (recommandé GPU 8+ Go).",
        "vision_model": "clip-ViT-L-14",
        "text_model": "clip-ViT-L-14",
        "cache_tokens": ["clip-vit-l-14"],
    },
}

_HARDWARE_CACHE: dict | None = None


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


def _detect_ram_gb() -> float:
    try:
        import psutil
        return round(psutil.virtual_memory().total / (1024 ** 3), 1)
    except Exception:
        pass
    if os.name == "nt":
        try:
            class _MEMSTAT(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]
            stat = _MEMSTAT()
            stat.dwLength = ctypes.sizeof(_MEMSTAT)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
                return round(stat.ullTotalPhys / (1024 ** 3), 1)
        except Exception:
            pass
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    kb = int(line.split()[1])
                    return round(kb / (1024 ** 2), 1)
    except Exception:
        pass
    return 0.0


def _detect_windows_gpus() -> list[dict]:
    if os.name != "nt":
        return []
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress"],
            capture_output=True, text=True, timeout=3
        )
        if proc.returncode == 0 and proc.stdout.strip():
            data = json.loads(proc.stdout.strip())
            if isinstance(data, dict):
                data = [data]
            gpus = []
            for item in data:
                name = str(item.get("Name") or "").strip()
                if not name:
                    continue
                ram_bytes = item.get("AdapterRAM") or 0
                vram_gb = round(float(ram_bytes) / (1024 ** 3), 1) if ram_bytes else 0.0
                gpus.append({"name": name, "vram_gb": vram_gb})
            return gpus
    except Exception:
        pass
    return []


def detect_system_hardware(refresh: bool = False) -> dict:
    global _HARDWARE_CACHE
    if _HARDWARE_CACHE is not None and not refresh:
        return dict(_HARDWARE_CACHE)

    cpu_cores = os.cpu_count() or 1
    cpu_name = (platform.processor() or platform.machine() or "CPU").strip()
    ram_gb = _detect_ram_gb()

    torch_cuda = False
    torch_device_name = ""
    torch_vram_gb = 0.0
    try:
        import torch
        torch_cuda = bool(torch.cuda.is_available())
        if torch_cuda:
            torch_device_name = str(torch.cuda.get_device_name(0) or "")
            props = torch.cuda.get_device_properties(0)
            torch_vram_gb = round(props.total_memory / (1024 ** 3), 1)
    except Exception:
        pass

    onnx_providers: list[str] = []
    try:
        import onnxruntime as ort
        onnx_providers = list(ort.get_available_providers())
    except Exception:
        pass

    smi_gpus: list[dict] = []
    driver_version = ""
    try:
        smi = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=2
        )
        if smi.returncode == 0 and smi.stdout.strip():
            for line in smi.stdout.strip().splitlines():
                parts = [p.strip() for p in line.split(",")]
                if parts and parts[0]:
                    vram = round(float(parts[1]) / 1024.0, 1) if len(parts) > 1 and parts[1].replace(".", "", 1).isdigit() else 0.0
                    if len(parts) > 2 and parts[2] and not driver_version:
                        driver_version = parts[2]
                    smi_gpus.append({"name": parts[0], "vram_gb": vram})
    except Exception:
        pass

    win_gpus = smi_gpus or _detect_windows_gpus()
    gpu_name = torch_device_name or (win_gpus[0]["name"] if win_gpus else "Aucun GPU dédié détecté")
    # Prefer discrete GPU if multiple adapters exist on Windows
    for g in win_gpus:
        low = g["name"].lower()
        if any(k in low for k in ("nvidia", "geforce", "rtx", "gtx", "quadro", "radeon", "rx ", "arc ")):
            gpu_name = g["name"]
            if not torch_vram_gb and g.get("vram_gb"):
                torch_vram_gb = g["vram_gb"]
            break

    low_gpu = gpu_name.lower()
    if any(k in low_gpu for k in ("nvidia", "geforce", "rtx", "gtx", "quadro", "tesla")):
        gpu_vendor = "nvidia"
    elif any(k in low_gpu for k in ("amd", "radeon")):
        gpu_vendor = "amd"
    elif "intel" in low_gpu:
        gpu_vendor = "intel"
    else:
        gpu_vendor = "none"

    has_onnx_cuda = "CUDAExecutionProvider" in onnx_providers
    has_onnx_dml = "DmlExecutionProvider" in onnx_providers
    has_onnx_rocm = "ROCMExecutionProvider" in onnx_providers
    has_onnx_openvino = "OpenVINOExecutionProvider" in onnx_providers

    if torch_cuda or has_onnx_cuda:
        recommended_mode = "cuda"
        accel_label = "NVIDIA CUDA"
    elif (gpu_vendor == "amd" and (has_onnx_dml or has_onnx_rocm)) or has_onnx_dml:
        recommended_mode = "directml"
        accel_label = "DirectML / AMD"
    elif gpu_vendor == "intel" and has_onnx_openvino:
        recommended_mode = "intel"
        accel_label = "Intel OpenVINO"
    else:
        recommended_mode = "cpu"
        accel_label = "CPU"

    ram_cap = int(ram_gb // 2) if ram_gb >= 2 else 1
    recommended_workers = max(1, min(max(1, cpu_cores - 1), ram_cap, 8))

    if recommended_mode in ("cuda", "directml") and cpu_cores >= 8 and ram_gb >= 16:
        power_tier = "Élevée"
    elif cpu_cores >= 4 and ram_gb >= 8:
        power_tier = "Moyenne"
    else:
        power_tier = "Standard"

    cuda_index = "cu128"
    if driver_version:
        try:
            drv_major = float(driver_version.split(".")[0])
            if drv_major >= 570:
                cuda_index = "cu128"
            elif drv_major >= 550:
                cuda_index = "cu124"
            elif drv_major >= 530:
                cuda_index = "cu121"
            else:
                cuda_index = "cu118"
        except Exception:
            cuda_index = "cu128"

    info = {
        "os": f"{platform.system()} {platform.release()}",
        "cpu_name": cpu_name,
        "cpu_cores": cpu_cores,
        "ram_total_gb": ram_gb,
        "gpu_name": gpu_name,
        "gpu_vendor": gpu_vendor,
        "vram_gb": torch_vram_gb,
        "driver_version": driver_version,
        "cuda_index": cuda_index if gpu_vendor == "nvidia" else "",
        "torch_cuda_available": torch_cuda,
        "onnx_providers": onnx_providers,
        "recommended_mode": recommended_mode,
        "accel_label": accel_label,
        "recommended_workers": recommended_workers,
        "power_tier": power_tier,
    }
    _HARDWARE_CACHE = dict(info)
    return info


def get_hardware_runtime_config() -> dict:
    requested_mode = load_settings().get("gpu_mode", "auto").lower()
    hw_info = detect_system_hardware()
    mode = hw_info["recommended_mode"] if requested_mode == "auto" else requested_mode
    apply_gpu_environment(mode)

    if mode == "cpu":
        return {
            "mode": "cpu",
            "requested_mode": requested_mode,
            "recommended_workers": hw_info["recommended_workers"],
            "onnx_providers": ["CPUExecutionProvider"],
            "onnx_ctx_id": -1,
            "paddle_use_gpu": False,
            "paddle_enable_mkldnn": True,
            "torch_device": "cpu"
        }

    if mode == "cuda":
        return {
            "mode": "cuda",
            "requested_mode": requested_mode,
            "recommended_workers": hw_info["recommended_workers"],
            "onnx_providers": ["CUDAExecutionProvider", "CPUExecutionProvider"],
            "onnx_ctx_id": 0,
            "paddle_use_gpu": bool(hw_info["torch_cuda_available"]),
            "paddle_enable_mkldnn": not bool(hw_info["torch_cuda_available"]),
            "torch_device": "cuda" if hw_info["torch_cuda_available"] else "cpu"
        }

    if mode in ("amd", "directml"):
        return {
            "mode": mode,
            "requested_mode": requested_mode,
            "recommended_workers": hw_info["recommended_workers"],
            "onnx_providers": ["ROCMExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider"],
            "onnx_ctx_id": 0,
            "paddle_use_gpu": False,
            "paddle_enable_mkldnn": True,
            "torch_device": "cuda"
        }

    if mode == "intel":
        return {
            "mode": "intel",
            "requested_mode": requested_mode,
            "recommended_workers": hw_info["recommended_workers"],
            "onnx_providers": ["OpenVINOExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider"],
            "onnx_ctx_id": 0,
            "paddle_use_gpu": False,
            "paddle_enable_mkldnn": True,
            "torch_device": "xpu"
        }

    return {
        "mode": "cpu",
        "requested_mode": requested_mode,
        "recommended_workers": hw_info["recommended_workers"],
        "onnx_providers": ["CPUExecutionProvider"],
        "onnx_ctx_id": -1,
        "paddle_use_gpu": False,
        "paddle_enable_mkldnn": True,
        "torch_device": "cpu"
    }