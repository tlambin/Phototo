import os
import sys
import shutil
import subprocess
from pathlib import Path

os.system("")
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"

PROJECT_DIR = Path(__file__).resolve().parent


def step_msg(title: str):
    print(f"\n{CYAN}{BOLD}>>> {title}{RESET}")


def run_pip(args: list[str]) -> bool:
    cmd = [sys.executable, "-m", "pip", "install", "--upgrade", *args]
    print(f"  {YELLOW}Exécution :{RESET} {' '.join(cmd)}")
    res = subprocess.run(cmd)
    return res.returncode == 0


def has_nvidia_gpu() -> bool:
    if not shutil.which("nvidia-smi"):
        return False
    try:
        res = subprocess.run(["nvidia-smi"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return res.returncode == 0
    except Exception:
        return False


def ensure_exiftool():
    step_msg("1/6 — Vérification et installation automatique d'ExifTool")
    os.environ["PATH"] = str(PROJECT_DIR) + os.pathsep + os.environ.get("PATH", "")

    if shutil.which("exiftool"):
        print(f"  {GREEN}✓ ExifTool est déjà installé et accessible.{RESET}")
        return

    print("  ExifTool est manquant. Installation automatique via Winget...")
    if shutil.which("winget"):
        subprocess.run([
            "winget", "install", "-e", "--id", "OliverBetz.ExifTool",
            "--accept-package-agreements", "--accept-source-agreements"
        ])

    local_appdata = Path(os.environ.get("LOCALAPPDATA", ""))
    candidates = [
        local_appdata / "Microsoft" / "WinGet" / "Links" / "exiftool.exe",
    ]
    winget_pkgs = local_appdata / "Microsoft" / "WinGet" / "Packages"
    if winget_pkgs.exists():
        candidates.extend(winget_pkgs.rglob("exiftool.exe"))
        candidates.extend(winget_pkgs.rglob("exiftool(-k).exe"))

    for cand in candidates:
        if cand.exists():
            target_exe = PROJECT_DIR / "exiftool.exe"
            try:
                shutil.copy2(cand, target_exe)
                files_dir = cand.parent / "exiftool_files"
                if files_dir.exists():
                    target_files = PROJECT_DIR / "exiftool_files"
                    if not target_files.exists():
                        shutil.copytree(files_dir, target_files)
                print(f"  {GREEN}✓ ExifTool copié localement dans {target_exe}{RESET}")
                return
            except Exception as e:
                print(f"  {YELLOW}⚠ Copie locale impossible : {e}{RESET}")

    if shutil.which("exiftool"):
        print(f"  {GREEN}✓ ExifTool installé avec succès !{RESET}")
    else:
        print(f"  {RED}✗ Impossible d'installer ExifTool automatiquement. Lancez manuellement : winget install OliverBetz.ExifTool{RESET}")


def ensure_core_python_packages():
    step_msg("2/6 — Mise à jour de pip et installation des bibliothèques de base")
    run_pip(["pip", "setuptools", "wheel"])

    core_packages = [
        "fastapi>=0.110.0",
        "uvicorn>=0.29.0",
        "pydantic>=2.6.0",
        "PyExifTool>=0.5.6",
        "timezonefinder>=6.5.0",
        "tzdata>=2024.1",
        "blake3>=0.4.1",
        "ImageHash>=4.3.1",
        "Pillow>=10.3.0",
        "tqdm>=4.66.0",
        "opencv-python-headless>=4.9.0.80",
        "numpy<2.0.0",
        "scikit-learn>=1.4.2"
    ]
    run_pip(core_packages)


def ensure_pytorch_and_clip(is_nvidia: bool):
    step_msg("3/6 — Installation de PyTorch & Sentence-Transformers (Recherche Visuelle IA CLIP)")
    try:
        import torch
        print(f"  {GREEN}✓ PyTorch est déjà installé ({torch.__version__}).{RESET}")
    except ImportError:
        if is_nvidia:
            print("  Carte NVIDIA détectée : Installation de PyTorch avec accélération CUDA 12.1...")
            ok = run_pip(["torch", "torchvision", "--index-url", "https://download.pytorch.org/whl/cu121"])
            if not ok:
                run_pip(["torch", "torchvision"])
        else:
            print("  Installation de PyTorch (version standard)...")
            run_pip(["torch", "torchvision"])

    run_pip(["sentence-transformers>=2.7.0"])


def ensure_insightface_and_onnx(is_nvidia: bool):
    step_msg("4/6 — Installation d'ONNX Runtime & InsightFace (Reconnaissance Faciale)")

    if is_nvidia:
        run_pip(["onnxruntime-gpu"])
    else:
        if sys.platform == "win32":
            if not run_pip(["onnxruntime-directml"]):
                run_pip(["onnxruntime"])
        else:
            run_pip(["onnxruntime"])

    try:
        import insightface
        print(f"  {GREEN}✓ InsightFace est déjà installé.{RESET}")
        return
    except ImportError:
        pass

    print("  Tentative d'installation d'InsightFace...")
    py_ver = f"cp{sys.version_info.major}{sys.version_info.minor}"
    if sys.platform == "win32" and py_ver == "cp310":
        prebuilt_wheel_url = (
            "https://github.com/Gourieff/Assets/raw/main/Insightface/"
            "insightface-0.7.3-cp310-cp310-win_amd64.whl"
        )
        print("  Téléchargement de la roue pré-compilée Windows pour Python 3.10...")
        if run_pip([prebuilt_wheel_url]):
            print(f"  {GREEN}✓ InsightFace 0.7.3 (pré-compilé) installé avec succès !{RESET}")
            return

    run_pip(["insightface>=0.7.3"])


def ensure_paddleocr():
    step_msg("5/6 — Installation de PaddlePaddle & PaddleOCR (Recherche de Texte)")
    try:
        import paddle
        import paddleocr
        print(f"  {GREEN}✓ PaddleOCR est déjà installé.{RESET}")
        return
    except ImportError:
        pass

    run_pip(["paddlepaddle>=2.6.1", "paddleocr>=2.7.3"])
    run_pip(["numpy<2.0.0"])


def download_ai_models():
    step_msg("6/6 — Téléchargement préalable des modèles IA (Buffalo_L, PaddleOCR, CLIP)")
    
    # 1. InsightFace (buffalo_l)
    print("  -> Téléchargement du modèle de reconnaissance faciale InsightFace (buffalo_l)...")
    try:
        from insightface.app import FaceAnalysis
        app = FaceAnalysis(name="buffalo_l", allowed_modules=['detection', 'recognition'])
        app.prepare(ctx_id=-1, det_size=(640, 640))
        print(f"  {GREEN}✓ Modèle InsightFace 'buffalo_l' prêt en cache.{RESET}")
    except Exception as e:
        print(f"  {YELLOW}⚠ Téléchargement InsightFace différé au premier lancement : {e}{RESET}")

    # 2. PaddleOCR
    print("  -> Téléchargement des modèles PaddleOCR (Français/Multilingue)...")
    try:
        from paddleocr import PaddleOCR
        # Initialise brièvement pour forcer le téléchargement des poids de détection/reconnaissance de texte
        _ = PaddleOCR(use_angle_cls=True, lang="fr", show_log=False)
        print(f"  {GREEN}✓ Modèles PaddleOCR prêts en cache.{RESET}")
    except Exception as e:
        print(f"  {YELLOW}⚠ Téléchargement PaddleOCR différé au premier lancement : {e}{RESET}")

    # 3. CLIP Multilingue & Standard
    print("  -> Téléchargement des modèles CLIP (Sentence-Transformers)...")
    try:
        from sentence_transformers import SentenceTransformer
        _ = SentenceTransformer("clip-ViT-B-32")
        _ = SentenceTransformer("sentence-transformers/clip-ViT-B-32-multilingual-v1")
        print(f"  {GREEN}✓ Modèles CLIP prêts en cache.{RESET}")
    except Exception as e:
        print(f"  {YELLOW}⚠ Téléchargement CLIP différé au premier lancement : {e}{RESET}")


def main():
    print(f"{BOLD}======================================================================{RESET}")
    print(f"{BOLD}   INSTALLEUR AUTOMATIQUE & PRÉ-CHARGEMENT IA (Studio 1.4 To){RESET}")
    print(f"{BOLD}======================================================================{RESET}")
    print(f"  Exécutable Python ciblé : {sys.executable}")

    is_nvidia = has_nvidia_gpu()
    if is_nvidia:
        print(f"  {GREEN}Carte graphique NVIDIA détectée !{RESET}")
    else:
        print(f"  {YELLOW}Mode AMD / Intel / CPU détecté.{RESET}")

    ensure_exiftool()
    ensure_core_python_packages()
    ensure_pytorch_and_clip(is_nvidia)
    ensure_insightface_and_onnx(is_nvidia)
    ensure_paddleocr()
    download_ai_models()

    step_msg("Vérification finale via setup/check_system.py")
    check_script = PROJECT_DIR / "setup/check_system.py"
    if check_script.exists():
        subprocess.run([sys.executable, str(check_script)])
    else:
        print(f"  {GREEN}✓ Installation et configuration terminées avec succès !{RESET}")


if __name__ == "__main__":
    main()