import sys
import json
import shutil
import subprocess
from pathlib import Path
from datetime import datetime
from settings_manager import load_settings

ROOT_DIR = Path(__file__).resolve().parents[2]
CONFIG_DIR = ROOT_DIR / "config"
CONFIG_FILE = CONFIG_DIR / "libraries_config.json"
LEGACY_CONFIG_FILE = ROOT_DIR / "libraries_config.json"


def _ensure_config_file() -> Path:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    if LEGACY_CONFIG_FILE.exists():
        try:
            legacy_data = json.loads(LEGACY_CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            legacy_data = {}

        try:
            if not CONFIG_FILE.exists():
                shutil.copy2(str(LEGACY_CONFIG_FILE), str(CONFIG_FILE))
            else:
                try:
                    current_data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
                except Exception:
                    current_data = {}
                if legacy_data.get("libraries") and not current_data.get("libraries"):
                    shutil.copy2(str(LEGACY_CONFIG_FILE), str(CONFIG_FILE))
            LEGACY_CONFIG_FILE.unlink(missing_ok=True)
        except OSError:
            pass
    return CONFIG_FILE


def open_native_dialog(mode: str = "folder") -> list[str]:
    script = f"""
import tkinter as tk
from tkinter import filedialog
from pathlib import Path
import json
root = tk.Tk()
root.withdraw()
root.attributes('-topmost', True)
if "{mode}" == "zips":
    res = filedialog.askopenfilenames(
        title="Sélectionnez vos archives Google Takeout (.zip)",
        filetypes=[("Archives ZIP", "*.zip"), ("Tous les fichiers", "*.*")]
    )
    print(json.dumps(list(res)))
elif "{mode}" == "audio":
    res = filedialog.askopenfilename(
        title="Choisir un fichier audio",
        filetypes=[("Fichiers Audio", "*.mp3 *.wav *.m4a *.aac *.flac *.ogg"), ("Tous", "*.*")]
    )
    print(json.dumps([res] if res else []))
elif "{mode}" == "create_folder":
    res = filedialog.asksaveasfilename(
        title="Choisissez l'emplacement et tapez le nom du nouveau dossier",
        initialfile="Nouvelle_Bibliotheque"
    )
    if res:
        p = Path(res)
        p.mkdir(parents=True, exist_ok=True)
        print(json.dumps([str(p)]))
    else:
        print(json.dumps([]))
else:
    res = filedialog.askdirectory(title="Sélectionnez le dossier", mustexist=False)
    if res:
        p = Path(res)
        p.mkdir(parents=True, exist_ok=True)
        print(json.dumps([str(p)]))
    else:
        print(json.dumps([]))
root.destroy()
"""
    try:
        out = subprocess.check_output([sys.executable, "-c", script], text=True)
        return json.loads(out.strip())
    except Exception:
        return []


def load_libraries() -> dict:
    cfg_path = _ensure_config_file()
    if cfg_path.exists():
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"active_library": None, "libraries": {}}


def save_libraries(data: dict):
    cfg_path = _ensure_config_file()
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)


def register_library(name: str, source_type: str, source_paths: list[str], dest_dir: str, options: dict) -> dict:
    cfg = load_libraries()
    dest_path = Path(dest_dir)
    dest_path.mkdir(parents=True, exist_ok=True)

    safe_slug = "".join(c if c.isalnum() else "_" for c in name.lower()).strip("_") or "default"
    db_path = str(dest_path / f"library_{safe_slug}.db")
    is_takeout = source_type in ("TAKEOUT_FOLDER", "TAKEOUT_ZIPS")

    lib_entry = {
        "name": name,
        "source_type": source_type,
        "is_takeout": is_takeout,
        "source_paths": source_paths,
        "dest_dir": str(dest_path),
        "db_path": db_path,
        "created_at": datetime.now().isoformat(),
        "options": {
            "fix_takeout_json_metadata": options.get("fix_takeout_json_metadata", True) if is_takeout else False,
            "delete_zips_progressively": options.get("delete_zips_progressively", False) if source_type == "TAKEOUT_ZIPS" else False,
            "organize_by_year_month": options.get("organize_by_year_month", True),
            "run_deduplication": options.get("run_deduplication", True),
            "run_faces_ai": options.get("run_faces_ai", True),
            "run_ocr": options.get("run_ocr", True),
            "run_similarity": options.get("run_similarity", True),
            "run_semantic_clip": options.get("run_semantic_clip", True)
        }
    }

    cfg["libraries"][name] = lib_entry
    cfg["active_library"] = name
    save_libraries(cfg)
    return lib_entry


def collect_zip_files(source_paths: list[str]) -> list[Path]:
    zips = []
    for p_str in source_paths:
        p = Path(p_str)
        if p.is_file() and p.suffix.lower() == ".zip":
            zips.append(p)
        elif p.is_dir():
            zips.extend(sorted(p.glob("*.zip")))
    return sorted(set(zips))


def get_takeout_buffer_dir(default_dest_dir: Path) -> Path:
    settings = load_settings()
    custom_dir = settings.get("takeout_extract_dir", "").strip()
    buffer_path = (Path(custom_dir) / "_Temp_Takeout_Buffer") if custom_dir else (default_dest_dir / "_Temp_Takeout_Buffer")
    buffer_path.mkdir(parents=True, exist_ok=True)
    return buffer_path