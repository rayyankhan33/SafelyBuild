"""
footage.py - TEST-ONLY analysis of uploaded footage (a video or a single image).

Purpose: let an engineer try a model on real footage and see what it detects. Nothing produced here is
ever evidence: the API keeps these results in separate tables that progress, spend, hazards and
forecasts never read.

How frames are chosen (the numbers are defaults; every one can be changed per upload)
---------------------------------------------------------------------------------
  * By TIME, not by frame count. "Every N frames" means different spacing at 15, 25 and 30 fps.
  * One analysed frame per 3 seconds of footage (about every 90th frame at 30 fps).
    Construction scenes change slowly; consecutive frames are near-identical, so analysing them adds
    cost and no information. 3 s also means a detection must persist for at least 3 s to be
    "confirmed" (seen in two consecutive analysed frames), which filters flicker and passers-by.
  * Quality over immediacy: inside each 3 s window up to 6 candidate frames are scored for sharpness
    (about 1.5 ms each) and only the sharpest one goes to the model, so motion blur and compression
    artefacts are avoided at no extra model cost.
  * Static camera: if the chosen frame is almost identical to the last analysed one, the model is not
    run again (its detections are reused), but a fresh analysis is forced at least every 15 s.
  * Bounded cost: at most 400 analysed frames per upload (longer footage automatically gets a wider
    interval), one job at a time, and the model uses at most half the CPU cores.

Measured cost on the development machine (4 cores, CPU only): about 0.3 s per analysed frame at 640 px,
so a 10-minute clip needs at most ~200 analysed frames, about a minute of compute.
"""

from __future__ import annotations

import shutil
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional

import cv2
import numpy as np

DEFAULT_INTERVAL_S = 3.0
MIN_INTERVAL_S, MAX_INTERVAL_S = 1.0, 10.0
CANDIDATES_PER_WINDOW = 6
DUPLICATE_DIFF = 2.0          # mean absolute grey difference (0-255) on a 64x36 thumbnail below which two frames are "the same"
FORCE_REANALYSE_S = 15.0
DEFAULT_MAX_FRAMES, MAX_MAX_FRAMES = 400, 600
CONFIRM_IOU = 0.3
THUMB_WIDTH = 960
JPEG_QUALITY = 80
JOB_TTL_S = 2 * 3600

DEFAULT_PROMPTS = [
    "excavation pit", "bare soil trench", "steel reinforcement bars", "rebar cage", "rebar mesh",
    "plywood formwork", "timber shuttering", "fresh poured concrete", "concrete slab", "concrete column",
    "brick wall", "cement bag", "pile of sand", "pile of gravel", "pile of crushed stone",
    "stack of bricks", "bundle of steel rebar",
]

Detector = Callable[[np.ndarray, List[str], float], List[dict]]
_detector: Optional[Detector] = None          # tests inject a fake; None means YOLO-World
_slot = threading.Semaphore(1)                # one analysis at a time: bounded CPU


def set_detector(fn: Optional[Detector]) -> None:
    global _detector
    _detector = fn


def detector_available() -> bool:
    if _detector is not None:
        return True
    import yolo_scene
    return yolo_scene.available()


YOLO = "yolo_world"


def defect_models() -> List[str]:
    """Registered backends that serve the defects task and can run now (e.g. the crack models)."""
    import registry
    return [b["name"] for b in registry.describe()["backends"] if "defects" in b["tasks"] and b["available"] and b["name"] != YOLO]


def _detect_defects(img: np.ndarray, model: str, conf: float) -> List[dict]:
    """Run a registered defect backend on a frame; its findings become detections (label = defect type)."""
    import pipeline
    import registry
    fn, _ = registry.resolve("defects", model)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 95])
    if not ok:
        raise RuntimeError("could not encode frame")
    out = fn(buf.tobytes(), "Low", conf)          # "Low": report every finding, not only violations
    return [{"label": f["defect_type"], "conf": round(float(f["score"]), 4), "bbox": [float(v) for v in f["bbox"]]}
            for f in out["findings"]]


def _detect(img: np.ndarray, prompts: List[str], conf: float, model: str = YOLO) -> List[dict]:
    if _detector is not None:
        return _detector(img, prompts, conf)
    if model != YOLO:
        return _detect_defects(img, model, conf)
    import yolo_scene
    return yolo_scene.detect_free(img, prompts, conf)


# ------------------------------------------------------------------ small pure helpers (unit-tested)
def iou(a, b) -> float:
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def mark_confirmed(prev_dets: List[dict], cur_dets: List[dict]) -> None:
    """A detection is confirmed when the previous analysed frame has the same label at an overlapping place."""
    for c in cur_dets:
        for p in prev_dets:
            if p["label"] == c["label"] and iou(p["bbox"], c["bbox"]) >= CONFIRM_IOU:
                c["confirmed"] = True
                p["confirmed"] = True
                break


def sharpness(frame: np.ndarray) -> float:
    """Variance of the Laplacian on a 320 px grey copy: higher is sharper. About 1.5 ms."""
    h, w = frame.shape[:2]
    small = cv2.resize(frame, (320, max(1, int(h * 320 / w))), interpolation=cv2.INTER_AREA)
    return float(cv2.Laplacian(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var())


def plan(fps: float, total_frames: Optional[int], interval_s: float, max_frames: int) -> dict:
    """Window size in frames and how many frames will be analysed; widens the interval if over the cap."""
    interval = min(MAX_INTERVAL_S, max(MIN_INTERVAL_S, float(interval_s)))
    widened = False
    est = None
    if total_frames and fps > 0:
        duration = total_frames / fps
        est = int(np.ceil(duration / interval))
        if est > max_frames:
            interval = duration / max_frames          # may exceed MAX_INTERVAL_S: the cap wins on very long footage
            est = max_frames
            widened = True
    return {"window_frames": max(1, int(round(interval * fps))), "effective_interval_s": round(interval, 2),
            "estimated_frames": est, "widened": widened}


def candidate_offsets(window: int) -> List[int]:
    """Frame offsets inside a window that are scored for sharpness (evenly spread, at most CANDIDATES_PER_WINDOW)."""
    return sorted(set(int(x) for x in np.linspace(0, window - 1, min(window, CANDIDATES_PER_WINDOW))))


SHARPNESS_TIE = 0.95


def choose(cands: list, w_start: int, window: int) -> tuple:
    """
    Pick the frame to analyse from a window's scored candidates (sharpness, index, frame): the sharpest, but
    among frames within 5 % of the sharpest take the one nearest the window centre. In static footage all
    candidates are equally sharp, so this keeps sample times evenly spaced instead of random.
    """
    top = max(c[0] for c in cands)
    near = [c for c in cands if c[0] >= SHARPNESS_TIE * top]
    centre = w_start + (window - 1) / 2
    return min(near, key=lambda c: abs(c[1] - centre))


def annotate(frame: np.ndarray, dets: List[dict]) -> bytes:
    img = frame.copy()
    for d in dets:
        x1, y1, x2, y2 = [int(v) for v in d["bbox"]]
        colour = (60, 200, 60) if d.get("confirmed") else (40, 160, 240)    # BGR: green confirmed, orange single-frame
        cv2.rectangle(img, (x1, y1), (x2, y2), colour, max(2, img.shape[1] // 400))
        label = f'{d["label"]} {d["conf"]:.2f}'
        scale = max(0.45, img.shape[1] / 1600)
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, scale, 1)
        cv2.rectangle(img, (x1, max(0, y1 - th - 6)), (x1 + tw + 6, max(th + 6, y1)), colour, -1)
        cv2.putText(img, label, (x1 + 3, max(th + 2, y1 - 4)), cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), 1, cv2.LINE_AA)
    h, w = img.shape[:2]
    if w > THUMB_WIDTH:
        img = cv2.resize(img, (THUMB_WIDTH, int(h * THUMB_WIDTH / w)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    if not ok:
        raise RuntimeError("could not encode frame")
    return buf.tobytes()


# ------------------------------------------------------------------ jobs
@dataclass
class Job:
    id: str
    dir: Path
    path: Path
    params: dict
    status: str = "queued"            # queued | running | done | failed | cancelled
    error: Optional[str] = None
    video: dict = field(default_factory=dict)
    frames: List[dict] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)
    truncated: bool = False
    created: float = field(default_factory=time.time)
    cancel: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def view(self) -> dict:
        with self.lock:
            analysed = sum(1 for f in self.frames if not f["reused"])
            labels: Dict[str, dict] = {}
            for f in self.frames:
                if f["reused"]:
                    continue
                for d in f["detections"]:
                    e = labels.setdefault(d["label"], {"detections": 0, "confirmed": 0, "best_conf": 0.0})
                    e["detections"] += 1
                    e["confirmed"] += 1 if d.get("confirmed") else 0
                    e["best_conf"] = max(e["best_conf"], d["conf"])
            return {
                "id": self.id, "status": self.status, "error": self.error, "params": self.params, "video": self.video,
                "progress": {"sampled": len(self.frames), "analysed": analysed, "reused": len(self.frames) - analysed,
                             "estimated_total": self.params.get("estimated_frames")},
                "frames": [dict(f) for f in self.frames],
                "summary": {"per_label": labels, "truncated": self.truncated, "notes": list(self.notes)},
            }


_jobs: Dict[str, Job] = {}
_jobs_lock = threading.Lock()


def _sweep() -> None:
    cutoff = time.time() - JOB_TTL_S
    with _jobs_lock:
        for jid in [j for j, job in _jobs.items() if job.created < cutoff and job.status not in ("queued", "running")]:
            shutil.rmtree(_jobs.pop(jid).dir, ignore_errors=True)


def create_job(save_upload: Callable[[Path], None], params: dict) -> Job:
    """`save_upload(path)` writes the uploaded bytes to `path` (the caller enforces the size limit)."""
    _sweep()
    jid = uuid.uuid4().hex
    d = Path(tempfile.mkdtemp(prefix=f"sb-footage-{jid[:8]}-"))
    (d / "frames").mkdir()
    path = d / "upload.bin"
    try:
        save_upload(path)
    except Exception:
        shutil.rmtree(d, ignore_errors=True)
        raise
    job = Job(id=jid, dir=d, path=path, params=params)
    with _jobs_lock:
        _jobs[jid] = job
    threading.Thread(target=_run, args=(job,), daemon=True, name=f"footage-{jid[:8]}").start()
    return job


def get_job(jid: str) -> Optional[Job]:
    with _jobs_lock:
        return _jobs.get(jid)


def delete_job(jid: str) -> bool:
    with _jobs_lock:
        job = _jobs.pop(jid, None)
    if not job:
        return False
    job.cancel.set()
    shutil.rmtree(job.dir, ignore_errors=True)
    return True


def frame_path(job: Job, i: int) -> Path:
    return job.dir / "frames" / f"{int(i)}.jpg"


def _run(job: Job) -> None:
    with _slot:
        if job.cancel.is_set():
            job.status = "cancelled"
            return
        job.status = "running"
        try:
            _analyse(job)
            if job.status == "running":
                job.status = "cancelled" if job.cancel.is_set() else "done"
        except Exception as e:  # noqa: BLE001 - any failure becomes a failed job with a readable reason
            job.error = str(e) or e.__class__.__name__
            job.status = "failed"
        finally:
            try:
                job.path.unlink(missing_ok=True)   # the upload is no longer needed once sampled
            except OSError:
                pass


def _thumb(frame: np.ndarray) -> np.ndarray:
    return cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (64, 36), interpolation=cv2.INTER_AREA).astype(np.int16)


def _analyse(job: Job) -> None:
    p = job.params
    cap = cv2.VideoCapture(str(job.path))
    if cap.isOpened() and int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0) != 1 and cap.get(cv2.CAP_PROP_FPS) not in (None, 0):
        _analyse_video(job, cap)
        return
    cap.release()
    img = cv2.imdecode(np.fromfile(str(job.path), np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        cap = cv2.VideoCapture(str(job.path))           # a one-frame video container
        ok, img = cap.read() if cap.isOpened() else (False, None)
        cap.release()
        if not ok or img is None:
            raise ValueError("file could not be read as a video or an image")
    job.video = {"kind": "image", "width": img.shape[1], "height": img.shape[0], "frames": 1, "fps": None, "duration_s": None}
    _process(job, 0, 0.0, img, sharpness(img), None, 0.0)


def _analyse_video(job: Job, cap: "cv2.VideoCapture") -> None:
    p = job.params
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
    if not (1.0 <= fps <= 240.0):
        job.notes.append(f"frame rate unreadable ({fps}); assumed 25 fps")
        fps = 25.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0) or None
    pl = plan(fps, total, p["interval_s"], p["max_frames"])
    p["effective_interval_s"] = pl["effective_interval_s"]
    p["estimated_frames"] = pl["estimated_frames"]
    if pl["widened"]:
        job.notes.append(f"footage is long: interval widened from {p['interval_s']} s to {pl['effective_interval_s']} s to stay within {p['max_frames']} analysed frames")
    job.video = {"kind": "video", "fps": round(fps, 2), "frames": total, "duration_s": round(total / fps, 1) if total else None,
                 "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0), "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)}

    window = pl["window_frames"]
    offsets = set(candidate_offsets(window))
    state = {"last_thumb": None, "last_dets": None, "last_t": -1e9, "last_frame": None, "records": []}
    cands: list = []       # [(sharpness, frame_index, frame)] scored in the current window
    w_start = idx = 0
    n_sampled = 0
    while not job.cancel.is_set():
        if not cap.grab():
            break
        if (idx - w_start) in offsets:
            ok, f = cap.retrieve()
            if ok:
                cands.append((sharpness(f), idx, f))
        idx += 1
        if idx - w_start >= window:
            if cands:
                if n_sampled >= p["max_frames"]:
                    job.truncated = True
                    job.notes.append(f"stopped after {p['max_frames']} frames")
                    break
                pick = choose(cands, w_start, window)
                _process(job, n_sampled, pick[1] / fps, pick[2], pick[0], state, fps)
                n_sampled += 1
            cands, w_start = [], idx
    if cands and not job.cancel.is_set() and n_sampled < p["max_frames"]:
        pick = choose(cands, w_start, window)
        _process(job, n_sampled, pick[1] / fps, pick[2], pick[0], state, fps)
    cap.release()
    if not job.frames and not job.cancel.is_set():
        raise ValueError("no frames could be read from the file")


def _record(i, t_s, sharp, reused, ms, dets) -> dict:
    return {"i": i, "t_s": round(t_s, 2), "sharpness": round(sharp, 1), "reused": reused, "ms": ms,
            "detections": [{"label": d["label"], "conf": d["conf"], "bbox": d["bbox"], "confirmed": bool(d.get("confirmed"))} for d in dets]}


def _process(job: Job, i: int, t_s: float, frame: np.ndarray, sharp: float, state: Optional[dict], fps: float) -> None:
    """
    Analyse (or reuse) one chosen frame. `state` carries what the next frame needs: the last analysed
    frame, its detections, and every stored record that shows those detections, so that when a later frame
    confirms them the earlier records and the analysed frame's image are updated too.
    """
    p = job.params
    if state is None:
        state = {"last_thumb": None, "last_dets": None, "last_t": -1e9, "last_frame": None, "records": []}
    th = _thumb(frame)
    reused = (state["last_thumb"] is not None
              and float(np.mean(np.abs(th - state["last_thumb"]))) < DUPLICATE_DIFF
              and (t_s - state["last_t"]) < FORCE_REANALYSE_S)
    t0 = time.time()
    if reused:
        dets = [dict(d) for d in state["last_dets"]]
        ms = 0
        rec = _record(i, t_s, sharp, True, ms, dets)
        state["records"].append(rec)
        frame_path(job, i).write_bytes(annotate(frame, dets))
    else:
        dets = _detect(frame, p["prompts"], p["conf"], p.get("model", YOLO))
        for d in dets:
            d["confirmed"] = False
        if state["last_dets"] is not None:
            mark_confirmed(state["last_dets"], dets)
            # earlier detections may have just become confirmed: refresh everything that displays them
            first = state["records"][0]
            for rec in state["records"]:
                for k, d in enumerate(state["last_dets"]):
                    rec["detections"][k]["confirmed"] = bool(d.get("confirmed"))
            frame_path(job, first["i"]).write_bytes(annotate(state["last_frame"], state["last_dets"]))
        ms = int((time.time() - t0) * 1000)
        rec = _record(i, t_s, sharp, False, ms, dets)
        state.update(last_thumb=th, last_dets=dets, last_t=t_s, last_frame=frame, records=[rec])
        frame_path(job, i).write_bytes(annotate(frame, dets))
    with job.lock:
        job.frames.append(rec)
