import os
import sys
import shutil
import subprocess
from pathlib import Path

# Couleurs ANSI pour le terminal (activées nativement sur Windows 10/11, Linux et macOS)
os.system("")
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"


def ok(msg: str):
    print(f"  {GREEN}✓ [OK]{RESET} {msg}")


def warn(msg: str):
    print(f"  {YELLOW}⚠ [ATTENTION]{RESET} {msg}")


def fail(msg: str):
    print(f"  {RED}✗ [ERREUR]{RESET} {msg}")


def section(title: str):
    print(f"\n{CYAN}{BOLD}=== {title} ==={RESET}")


def check_binary(cmd_name: str, version_arg: str, install_hint: str) -> bool:
    path = shutil.which(cmd_name)
    if not path:
        fail(f"{cmd_name} est introuvable dans le PATH système.")
        print(f"      💡 Solution : {install_hint}")
        return False
    try:
        out = subprocess.check_output([cmd_name, version_arg], stderr=subprocess.STDOUT, text=True)
        first_line = out.strip().splitlines()[0] if out.strip() else "Version détectée"
        ok(f"{cmd_name} détecté ({path}) — {first_line}")
        return True
    except Exception as e:
        fail(f"{cmd_name} trouvé mais impossible à exécuter : {e}")
        return False


def check_python_packages() -> bool:
    section("1. Environnement Python & Paquets Clés")
    print(f"  Version Python : {sys.version.split()[0]} ({sys.executable})")

    required = [
        ("fastapi", "FastAPI (Serveur Web)"),
        ("uvicorn", "Uvicorn (ASGI)"),
        ("exiftool", "PyExifTool (Pont Python <-> ExifTool)"),
        ("blake3", "BLAKE3 (Dédoublonnage ultra-rapide)"),
        ("imagehash", "ImageHash (pHash perceptuel)"),
        ("cv2", "OpenCV (Vidéo & Inpainting Gomme Magique)"),
        ("PIL", "Pillow (Traitement d'images)"),
        ("sklearn", "Scikit-Learn (Clustering HDBSCAN)"),
        ("insightface", "InsightFace (Reconnaissance faciale)"),
        ("paddleocr", "PaddleOCR (Extraction de texte)"),
        ("sentence_transformers", "Sentence-Transformers (Recherche IA CLIP)"),
        ("timezonefinder", "TimezoneFinder (Fuseau horaire GPS)")
    ]

    all_ok = True
    for mod_name, label in required:
        try:
            __import__(mod_name)
            ok(f"{label}")
        except ImportError:
            fail(f"Module manquant : {label} (`{mod_name}`)")
            all_ok = False

    # Test de Tkinter pour les boîtes de dialogue "Parcourir..."
    try:
        import tkinter
        ok("Tkinter (Boîtes de dialogue natives 'Parcourir...')")
    except ImportError:
        warn("Tkinter non disponible : les boutons 'Parcourir...' ne pourront pas ouvrir de fenêtre.")

    return all_ok


def check_external_tools() -> bool:
    section("2. Outils Système Externes (ExifTool & FFmpeg)")
    exif_ok = check_binary(
        "exiftool",
        "-ver",
        "Windows: `winget install OliverBetz.ExifTool` (ou téléchargez exiftool.exe sur exiftool.org et mettez-le dans C:\\Windows) | Linux: `sudo apt install libimage-exiftool-perl` | Mac: `brew install exiftool`"
    )
    ffmpeg_ok = check_binary(
        "ffmpeg",
        "-version",
        "Windows: `winget install Gyan.FFmpeg` | Linux: `sudo apt install ffmpeg` | Mac: `brew install ffmpeg`"
    )
    return exif_ok and ffmpeg_ok


def check_gpu_and_ai():
    section("3. Accélération Matérielle GPU (InsightFace, CLIP, PaddleOCR)")

    # A. ONNX Runtime (InsightFace)
    try:
        import onnxruntime as ort
        providers = ort.get_available_providers()
        print(f"  Providers ONNX Runtime disponibles : {providers}")
        if "CUDAExecutionProvider" in providers:
            ok("InsightFace : Accélération GPU NVIDIA (CUDAExecutionProvider) prête !")
        elif "ROCMExecutionProvider" in providers or "DmlExecutionProvider" in providers:
            ok("InsightFace : Accélération GPU AMD / DirectML prête !")
        elif "OpenVINOExecutionProvider" in providers:
            ok("InsightFace : Accélération Intel OpenVINO prête !")
        else:
            warn("InsightFace : Seul le CPUExecutionProvider est actif (traitement sur processeur).")
    except Exception as e:
        fail(f"Impossible de vérifier ONNX Runtime : {e}")

    # B. PyTorch (CLIP Recherche Sémantique)
    try:
        import torch
        if torch.cuda.is_available():
            dev_name = torch.cuda.get_device_name(0)
            vram_gb = round(torch.cuda.get_device_properties(0).total_memory / (1024**3), 1)
            ok(f"PyTorch (CLIP) : GPU détecté -> {dev_name} ({vram_gb} Go VRAM)")
        elif hasattr(torch, "xpu") and torch.xpu.is_available():
            ok("PyTorch (CLIP) : GPU Intel XPU détecté !")
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            ok("PyTorch (CLIP) : GPU Apple Silicon (MPS) détecté !")
        else:
            warn("PyTorch (CLIP) : Aucun GPU CUDA/XPU détecté par PyTorch (mode CPU actif).")
    except Exception as e:
        fail(f"Impossible de vérifier PyTorch : {e}")

    # C. PaddlePaddle (PaddleOCR)
    try:
        import paddle
        if paddle.device.is_compiled_with_cuda() and paddle.device.cuda.device_count() > 0:
            ok("PaddleOCR : Compilé avec support GPU CUDA actif !")
        else:
            warn("PaddleOCR : Mode CPU / Intel MKL-DNN actif (suffisant et rapide avec enable_mkldnn=True).")
    except Exception as e:
        fail(f"Impossible de vérifier PaddlePaddle : {e}")


def check_filesystem_and_hardlinks():
    section("4. Disque Dur, Espace Libre & Support des Hardlinks (0 Mo)")
    cwd = Path.cwd()
    usage = shutil.disk_usage(cwd)
    free_gb = round(usage.free / (1024**3), 1)
    total_gb = round(usage.total / (1024**3), 1)
    print(f"  Disque actuel ({cwd.anchor}) : {free_gb} Go libres sur {total_gb} Go")

    if free_gb < 50:
        warn("Moins de 50 Go libres sur ce disque. Pensez à activer la suppression progressive des .ZIP ou à pointer vers un disque externe pour vos 1,4 To.")
    else:
        ok(f"Espace disque confortable ({free_gb} Go disponibles).")

    # Test de création d'un hardlink (lien physique indispensable pour les Albums et Favoris à 0 Mo)
    test_src = cwd / ".tmp_test_hl_src"
    test_dst = cwd / ".tmp_test_hl_dst"
    try:
        test_src.write_text("test", encoding="utf-8")
        os.link(test_src, test_dst)
        ok("Support des Hardlinks (liens physiques NTFS/ext4/APFS) validé : vos Albums et Favoris occuperont 0 Mo supplémentaire !")
    except Exception as e:
        warn(f"Ce système de fichiers ne supporte pas les hardlinks (ex: disque exFAT/FAT32) : {e}")
    finally:
        test_src.unlink(missing_ok=True)
        test_dst.unlink(missing_ok=True)


if __name__ == "__main__":
    print(f"{BOLD}================================================================{RESET}")
    print(f"{BOLD}   DIAGNOSTIC SYSTÈME — STUDIO PHOTO & VIDÉO IA (1.4 To){RESET}")
    print(f"{BOLD}================================================================{RESET}")

    pkgs_ok = check_python_packages()
    tools_ok = check_external_tools()
    check_gpu_and_ai()
    check_filesystem_and_hardlinks()

    print(f"\n{BOLD}================================================================{RESET}")
    if pkgs_ok and tools_ok:
        print(f"{GREEN}{BOLD}🎉 TOUT EST PRÊT ! Vous pouvez lancer `start.bat` (ou `python dashboard_complet.py`).{RESET}")
    else:
        print(f"{YELLOW}{BOLD}⚠ Certains outils ou modules manquent ci-dessus. Corrigez-les avant de lancer l'analyse.{RESET}")
    print(f"{BOLD}================================================================{RESET}")