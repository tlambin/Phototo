import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI

_ROOT_DIR = Path(__file__).resolve().parents[2]
for _sub in ("backend/core", "backend/engines", "backend/routers"):
    _p = str(_ROOT_DIR / _sub)
    if _p not in sys.path:
        sys.path.insert(0, _p)

from pipeline_runner import seed_startup_resume_notifications, check_source_files_on_startup_async
from system_router import router as system_router
from libraries_router import router as libraries_router
from gallery_router import router as gallery_router
from faces_router import router as faces_router
from search_map_router import router as search_map_router
from metadata_studio_router import router as metadata_studio_router
from groups_router import router as groups_router


@asynccontextmanager
async def _app_lifespan(_app: FastAPI):
    seed_startup_resume_notifications()
    check_source_files_on_startup_async()
    yield


app = FastAPI(title="Phototo — Galerie & Studio IA", lifespan=_app_lifespan)

app.include_router(system_router)
app.include_router(libraries_router)
app.include_router(gallery_router)
app.include_router(faces_router)
app.include_router(search_map_router)
app.include_router(metadata_studio_router)
app.include_router(groups_router)
