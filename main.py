import os
import sys
from pathlib import Path

# 1. Configuration globale des chemins (Processus principal + Workers Windows)
BASE_DIR = Path(__file__).resolve().parent
MODULE_DIRS = [
    str(BASE_DIR),
    str(BASE_DIR / "backend"),
    str(BASE_DIR / "backend" / "core"),
    str(BASE_DIR / "backend" / "engines"),
    str(BASE_DIR / "backend" / "routers"),
]

for d in reversed(MODULE_DIRS):
    if d not in sys.path:
        sys.path.insert(0, d)

existing_py_path = os.environ.get("PYTHONPATH", "")
os.environ["PYTHONPATH"] = os.pathsep.join(
    MODULE_DIRS + ([existing_py_path] if existing_py_path else [])
)

import uvicorn
from fastapi import Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from api_routes import app

# 2. Montage des fichiers statiques (CSS / JS) et des templates HTML
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "frontend" / "static")), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "frontend" / "templates"))


@app.get("/")
def serve_home(request: Request):
    return templates.TemplateResponse(request=request, name="index.html")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)