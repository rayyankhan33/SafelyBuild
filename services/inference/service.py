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
from fastapi.responses import FileResponse, Response

import footage
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


# ------------------------------------------------------------------ test footage (temporary feature)
MAX_FOOTAGE_BYTES = int(os.environ.get("MAX_TEST_UPLOAD_MB", "300")) * 1024 * 1024


def _footage_params(prompts: str, interval_s: float, conf: float, max_frames: int, model: str = footage.YOLO) -> dict:
    try:
        plist = json.loads(prompts) if prompts else footage.DEFAULT_PROMPTS
    except ValueError:
        raise HTTPException(422, "prompts must be a JSON list of strings")
    if not isinstance(plist, list) or not plist or not all(isinstance(x, str) for x in plist):
        raise HTTPException(422, "prompts must be a non-empty list of strings")
    plist = [x.strip() for x in plist if x.strip()]
    if not plist or len(plist) > 30 or any(len(x) > 80 for x in plist):
        raise HTTPException(422, "give 1-30 prompts of at most 80 characters")
    if not (footage.MIN_INTERVAL_S <= interval_s <= footage.MAX_INTERVAL_S):
        raise HTTPException(422, f"interval_s must be between {footage.MIN_INTERVAL_S} and {footage.MAX_INTERVAL_S}")
    if not (0.01 <= conf <= 0.9):
        raise HTTPException(422, "conf must be between 0.01 and 0.9")
    if not (1 <= max_frames <= footage.MAX_MAX_FRAMES):
        raise HTTPException(422, f"max_frames must be between 1 and {footage.MAX_MAX_FRAMES}")
    if model != footage.YOLO and model not in footage.defect_models():
        raise HTTPException(422, f"model must be '{footage.YOLO}' or one of {footage.defect_models()}")
    return {"prompts": plist, "interval_s": interval_s, "conf": conf, "max_frames": max_frames, "model": model}


@app.get("/v1/test/defaults")
def footage_defaults():
    return {"prompts": footage.DEFAULT_PROMPTS, "interval_s": footage.DEFAULT_INTERVAL_S, "conf": 0.10,
            "max_frames": footage.DEFAULT_MAX_FRAMES, "min_interval_s": footage.MIN_INTERVAL_S, "max_interval_s": footage.MAX_INTERVAL_S,
            "max_max_frames": footage.MAX_MAX_FRAMES, "max_upload_mb": MAX_FOOTAGE_BYTES // (1024 * 1024),
            "candidates_per_window": footage.CANDIDATES_PER_WINDOW, "force_reanalyse_s": footage.FORCE_REANALYSE_S,
            "available": footage.detector_available(), "models": [footage.YOLO] + footage.defect_models()}


@app.post("/v1/test/jobs", status_code=202)
async def footage_start(
    file: UploadFile = File(...),
    prompts: str = Form(""),
    interval_s: float = Form(footage.DEFAULT_INTERVAL_S),
    conf: float = Form(0.10),
    max_frames: int = Form(footage.DEFAULT_MAX_FRAMES),
    model: str = Form(footage.YOLO),
):
    if model == footage.YOLO and not footage.detector_available():
        raise HTTPException(501, "YOLO-World is not available (install ultralytics and place the weights in models/)")
    params = _footage_params(prompts, interval_s, conf, max_frames, model)
    import shutil
    import tempfile
    total = 0
    tmp = tempfile.NamedTemporaryFile(prefix="sb-upload-", delete=False)
    try:
        with tmp:
            while True:
                chunk = await file.read(1 << 20)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_FOOTAGE_BYTES:
                    raise HTTPException(413, f"file exceeds {MAX_FOOTAGE_BYTES // (1024 * 1024)} MB")
                tmp.write(chunk)
        if total == 0:
            raise HTTPException(422, "empty file")
    except BaseException:
        os.unlink(tmp.name)
        raise

    def save(path):
        shutil.move(tmp.name, path)

    job = footage.create_job(save, params)
    return {"id": job.id}


@app.get("/v1/test/jobs/{job_id}")
def footage_status(job_id: str):
    job = footage.get_job(job_id)
    if not job:
        raise HTTPException(404, "no such job")
    return job.view()


@app.get("/v1/test/jobs/{job_id}/frames/{i}.jpg")
def footage_frame(job_id: str, i: int):
    job = footage.get_job(job_id)
    if not job:
        raise HTTPException(404, "no such job")
    path = footage.frame_path(job, i)
    if not path.exists():
        raise HTTPException(404, "no such frame")
    return FileResponse(path, media_type="image/jpeg")


@app.delete("/v1/test/jobs/{job_id}")
def footage_delete(job_id: str):
    if not footage.delete_job(job_id):
        raise HTTPException(404, "no such job")
    return {"ok": True}
