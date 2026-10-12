"""
service.py - FastAPI wrapper around pipeline.py.

Run:  uvicorn service:app --port 8000
Env:  MATERIAL_PROVIDER=none|simulated   (default none)
"""

import os

from fastapi import FastAPI, File, HTTPException, Query, UploadFile

import crack_model
import pipeline
from severity import SEVERITY_LEVELS

MAX_UPLOAD_BYTES = 15 * 1024 * 1024

app = FastAPI(title="SafelyBuild Inference Service", version="0.1.0")
materials = pipeline.MaterialProvider(os.environ.get("MATERIAL_PROVIDER", "none"))


async def _read(upload: UploadFile) -> bytes:
    data = await upload.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"file exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
    return data


@app.get("/health")
def health():
    return {
        "status": "ok",
        "yolo_world_available": pipeline.yolo_available(),
        "crack_model_available": crack_model.is_available(),
        "material_provider": materials.mode,
    }


@app.post("/v1/defects")
async def defects(
    image: UploadFile = File(...),
    backend: str = Query("auto", pattern="^(auto|opencv_tiles|yolo_world|crack_cnn)$"),
    min_violation: str = Query("Medium"),
    confidence: float = Query(0.15, ge=0.01, le=0.95),
):
    if min_violation not in SEVERITY_LEVELS:
        raise HTTPException(422, f"min_violation must be one of {SEVERITY_LEVELS}")
    try:
        return pipeline.analyze_defects(await _read(image), backend, min_violation, confidence)
    except pipeline.ImageError as e:
        raise HTTPException(422, str(e))
    except ImportError as e:  # backend explicitly requested but not installed
        raise HTTPException(501, f"backend unavailable: {e}")


@app.post("/v1/activity")
async def activity(previous: UploadFile = File(...), current: UploadFile = File(...)):
    try:
        return pipeline.activity_change(await _read(previous), await _read(current))
    except pipeline.ImageError as e:
        raise HTTPException(422, str(e))


@app.post("/v1/materials")
async def propose_materials(image: UploadFile = File(...)):
    try:
        return materials.propose(await _read(image))
    except pipeline.ImageError as e:
        raise HTTPException(422, str(e))
