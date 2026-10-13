"""
service.py - FastAPI wrapper around the pluggable analysis backends (see registry.py).

Run:  uvicorn service:app --port 8000
Env:  ENABLE_DEMO_FRAMES=1            expose /v1/demo/frame (synthetic frames for demos and tests only)
      BACKEND_DEFECTS / BACKEND_STAGE / BACKEND_INVENTORY   choose the active backend per task
      (or models/active.json); a request can override with ?backend=<name>
"""

import json
import os

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response

import pipeline
import registry
from severity import SEVERITY_LEVELS

MAX_UPLOAD_BYTES = 15 * 1024 * 1024
ELEMENT_TYPES = ("footing", "column", "beam", "slab", "masonry_wall")
BACKEND_PATTERN = r"^[A-Za-z0-9_\-\.]{1,60}$"

app = FastAPI(title="SafelyBuild Inference Service", version="0.3.0")


async def _read(upload: UploadFile) -> bytes:
    data = await upload.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"file exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
    return data


def _image(data: bytes) -> np.ndarray:
    try:
        return pipeline.decode_image(data)
    except pipeline.ImageError as e:
        raise HTTPException(422, str(e))


def _resolve(task: str, backend: str):
    try:
        return registry.resolve(task, backend)
    except registry.BackendUnavailable as e:
        raise HTTPException(501, f"backend unavailable: {e}")


def _stamp(result: dict, model: dict) -> dict:
    """Every result says which model produced it."""
    return {**result, "model": model}


@app.get("/health")
def health():
    return {"status": "ok", "demo_frames": os.environ.get("ENABLE_DEMO_FRAMES") == "1", **registry.describe()}


@app.get("/v1/backends")
def backends():
    return registry.describe()


@app.post("/v1/defects")
async def defects(
    image: UploadFile = File(...),
    backend: str = Query("auto", pattern=BACKEND_PATTERN),
    min_violation: str = Query("Medium"),
    confidence: float = Query(0.15, ge=0.01, le=0.95),
):
    if min_violation not in SEVERITY_LEVELS:
        raise HTTPException(422, f"min_violation must be one of {SEVERITY_LEVELS}")
    fn, model = _resolve("defects", backend)
    try:
        return _stamp(fn(await _read(image), min_violation, confidence), model)
    except pipeline.ImageError as e:
        raise HTTPException(422, str(e))
    except ImportError as e:
        raise HTTPException(501, f"backend unavailable: {e}")


@app.post("/v1/activity")
async def activity(previous: UploadFile = File(...), current: UploadFile = File(...)):
    try:
        return pipeline.activity_change(await _read(previous), await _read(current))
    except pipeline.ImageError as e:
        raise HTTPException(422, str(e))


@app.post("/v1/stage")
async def stage(
    image: UploadFile = File(...),
    element_type: str = Query(...),
    backend: str = Query("auto", pattern=BACKEND_PATTERN),
):
    if element_type not in ELEMENT_TYPES:
        raise HTTPException(422, f"element_type must be one of {ELEMENT_TYPES}")
    img = _image(await _read(image))
    fn, model = _resolve("stage", backend)
    try:
        return _stamp(fn(img, element_type), model)
    except ImportError as e:
        raise HTTPException(501, f"backend unavailable: {e}")


@app.post("/v1/inventory")
async def inventory(
    image: UploadFile = File(...),
    scale_m_per_px: float = Query(..., gt=0, le=10),
    backend: str = Query("auto", pattern=BACKEND_PATTERN),
):
    img = _image(await _read(image))
    fn, model = _resolve("inventory", backend)
    try:
        return _stamp(fn(img, scale_m_per_px), model)
    except ImportError as e:
        raise HTTPException(501, f"backend unavailable: {e}")


@app.post("/v1/demo/frame")
def demo_frame(kind: str = Form(...), params: str = Form("{}"), seed: int = Form(0)):
    """Synthetic camera frame for demos/tests. Disabled unless ENABLE_DEMO_FRAMES=1."""
    if os.environ.get("ENABLE_DEMO_FRAMES") != "1":
        raise HTTPException(404, "demo frames are disabled")
    import demo_frames as df
    try:
        p = json.loads(params)
        if kind == "zone":
            img = df.render_zone(p["element_type"], int(p.get("stage", 0)), p.get("fraction"), seed)
        elif kind == "sample":
            img = df.render_sample(p["file"], seed)
        elif kind == "yard":
            img = df.render_yard({k: float(v) for k, v in p["stock"].items()}, float(p["scale_m_per_px"]), seed)
        else:
            raise HTTPException(422, "kind must be 'zone', 'yard' or 'sample'")
    except (KeyError, ValueError, TypeError) as e:
        raise HTTPException(422, f"bad parameters: {e}")
    return Response(df.encode_png(img), media_type="image/png")
