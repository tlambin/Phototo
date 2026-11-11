import sys
import json
import subprocess
from pathlib import Path
from datetime import datetime
from settings_manager import load_settings

CONFIG_FILE = Path("libraries_config.json")


def open_native_dialog(mode: str = "folder") -> list[str]:
    script = f"""
import tkinter as tk
from tkinter import filedialog
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
else:
    res = filedialog.askdirectory(title="Sélectionnez le dossier")
    print(json.dumps([res] if res else []))
root.destroy()
"""
    try:
        out = subprocess.check_output([sys.executable, "-c", script], text=True)
        return json.loads(out.strip())
    except Exception:
        return []


def load_libraries() -> dict:
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"active_library": None, "libraries": {}}


def save_libraries(data: dict):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
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