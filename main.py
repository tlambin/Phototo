import sys
from pathlib import Path
import uvicorn
from fastapi import Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# Configuration automatique des chemins vers backend/core et backend/engines
BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR / "backend" / "core"))
sys.path.insert(0, str(BASE_DIR / "backend" / "engines"))
sys.path.insert(0, str(BASE_DIR / "backend" / "routers"))

from api_routes import app

# Montage des fichiers statiques (CSS / JS) et des templates HTML modulaires
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "frontend" / "static")), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "frontend" / "templates"))


@app.get("/")
def serve_home(request: Request):
    return templates.TemplateResponse(request=request, name="index.html")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
