"""Tests for the test-footage analysis: frame choice, cost control, confirmation, HTTP endpoints.
A fake detector replaces YOLO-World so these run fast; the real model is exercised separately."""
import json
import pathlib
import sys
import time

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import footage  # noqa: E402
from service import app  # noqa: E402

client = TestClient(app)


# ---------------------------------------------------------------- helpers
def write_video(path, seconds, fps=10, size=(160, 120), painter=None):
    w = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), fps, size)
    assert w.isOpened()
    for n in range(int(seconds * fps)):
        frame = np.full((size[1], size[0], 3), 120, np.uint8)
        if painter:
            painter(frame, n, fps)
        w.write(frame)
    w.release()
    return path


class Counting:
    """Fake detector that records its calls and returns one box on frames whose red channel is high."""

    def __init__(self):
        self.calls = 0

    def __call__(self, img, prompts, conf):
        self.calls += 1
        if img[..., 2].mean() > 150:
            return [{"label": prompts[0], "conf": 0.8, "bbox": [10.0, 10.0, 60.0, 60.0]}]
        return []


@pytest.fixture
def det():
    d = Counting()
    footage.set_detector(d)
    yield d
    footage.set_detector(None)


def run(path, **over):
    params = {"prompts": ["thing"], "interval_s": 1.0, "conf": 0.1, "max_frames": 400, **over}
    job = footage.create_job(lambda p: p.write_bytes(pathlib.Path(path).read_bytes()), params)
    for _ in range(300):
        if job.status in ("done", "failed", "cancelled"):
            break
        time.sleep(0.05)
    return job


# ---------------------------------------------------------------- pure helpers
def test_iou_basics():
    assert footage.iou([0, 0, 10, 10], [0, 0, 10, 10]) == 1.0
    assert footage.iou([0, 0, 10, 10], [20, 20, 30, 30]) == 0.0
    assert footage.iou([0, 0, 10, 10], [5, 0, 15, 10]) == pytest.approx(1 / 3)


def test_confirmation_needs_same_label_and_overlap():
    prev = [{"label": "a", "bbox": [0, 0, 10, 10]}, {"label": "b", "bbox": [50, 50, 60, 60]}]
    cur = [{"label": "a", "bbox": [1, 1, 11, 11]}, {"label": "a", "bbox": [90, 90, 100, 100]}, {"label": "b", "bbox": [0, 0, 10, 10]}]
    footage.mark_confirmed(prev, cur)
    assert [c.get("confirmed", False) for c in cur] == [True, False, False]
    assert prev[0].get("confirmed") is True and prev[1].get("confirmed") is None


def test_plan_converts_seconds_to_frames_for_any_frame_rate():
    for fps, frames in ((15, 45), (25, 75), (30, 90)):
        assert footage.plan(fps, fps * 60, 3.0, 400)["window_frames"] == frames   # same 3 s spacing at every rate


def test_plan_widens_interval_when_footage_is_long():
    p = footage.plan(30, 30 * 3600, 3.0, 400)           # one hour would need 1200 frames
    assert p["widened"] and p["estimated_frames"] == 400 and p["effective_interval_s"] == pytest.approx(9.0)
    q = footage.plan(30, 30 * 60, 3.0, 400)
    assert not q["widened"] and q["estimated_frames"] == 20


def test_plan_clamps_interval_and_handles_unknown_length():
    assert footage.plan(30, None, 0.1, 400)["effective_interval_s"] == 1.0
    assert footage.plan(30, None, 99, 400)["effective_interval_s"] == 10.0
    assert footage.plan(30, None, 3, 400)["estimated_frames"] is None


def test_candidates_are_spread_and_bounded():
    assert footage.candidate_offsets(1) == [0]
    c = footage.candidate_offsets(90)
    assert len(c) == footage.CANDIDATES_PER_WINDOW and c[0] == 0 and c[-1] == 89
    assert footage.candidate_offsets(3) == [0, 1, 2]


def test_choose_prefers_the_sharpest_but_centres_ties():
    f = np.zeros((2, 2, 3), np.uint8)
    # clear winner far from the centre still wins
    assert footage.choose([(10.0, 0, f), (500.0, 9, f), (12.0, 5, f)], 0, 10)[1] == 9
    # equally sharp frames: the one nearest the window centre wins (even spacing in static footage)
    assert footage.choose([(100.0, 0, f), (99.0, 4, f), (101.0, 9, f)], 0, 10)[1] == 4


def test_static_footage_gives_evenly_spaced_samples(tmp_path, det):
    rng = np.random.default_rng(3)
    base = (rng.random((120, 160, 3)) * 255).astype(np.uint8)

    def noisy(frame, n, fps):
        frame[:] = np.clip(base.astype(np.int16) + rng.normal(0, 2, base.shape), 0, 255).astype(np.uint8)
    v = write_video(tmp_path / "even.avi", 30, fps=10, painter=noisy)
    job = run(v, interval_s=3.0)
    gaps = np.diff([f["t_s"] for f in job.frames])
    assert gaps.max() - gaps.min() <= 1.0, gaps                    # was up to ~5 s apart with random tie-breaking


def test_sharpness_ranks_blur_below_detail():
    rng = np.random.default_rng(0)
    sharp = (rng.random((120, 160, 3)) * 255).astype(np.uint8)
    blurred = cv2.GaussianBlur(sharp, (0, 0), 6)
    assert footage.sharpness(sharp) > 20 * footage.sharpness(blurred)


# ---------------------------------------------------------------- video analysis
def test_one_frame_analysed_per_interval(tmp_path, det):
    def moving(frame, n, fps):                       # something changes every frame so nothing is a duplicate
        frame[:, :, 0] = (n * 7) % 255
    v = write_video(tmp_path / "a.avi", 12, fps=10, painter=moving)
    job = run(v, interval_s=3.0)
    assert job.status == "done", job.error
    assert len(job.frames) == 4                      # 12 s / 3 s
    assert [round(f["t_s"]) for f in job.frames] == sorted(round(f["t_s"]) for f in job.frames)
    assert det.calls == 4
    assert job.video["fps"] == 10.0 and job.video["kind"] == "video"


def test_sharpest_candidate_in_the_window_is_chosen(tmp_path, det):
    rng = np.random.default_rng(1)
    detail = (rng.random((120, 160, 3)) * 255).astype(np.uint8)

    def painter(frame, n, fps):                      # blurry everywhere except one crisp frame near the end of each second
        frame[:] = cv2.GaussianBlur(detail, (0, 0), 8)
        if n % int(fps) == 9:
            frame[:] = detail
    v = write_video(tmp_path / "s.avi", 4, fps=10, painter=painter)
    job = run(v, interval_s=1.0)
    assert job.status == "done"
    # every chosen frame is a crisp one (sharpness far above the blurred level)
    blurred = footage.sharpness(cv2.GaussianBlur(detail, (0, 0), 8))
    assert all(f["sharpness"] > 10 * blurred for f in job.frames), [f["sharpness"] for f in job.frames]


def test_static_scene_reuses_detections_but_refreshes_periodically(tmp_path, det):
    v = write_video(tmp_path / "static.avi", 40, fps=5)              # nothing ever changes
    job = run(v, interval_s=3.0)
    assert job.status == "done"
    analysed = [f for f in job.frames if not f["reused"]]
    assert len(job.frames) == 14
    assert 2 <= len(analysed) <= 4                                  # first frame plus a refresh about every 15 s
    assert det.calls == len(analysed)
    assert all(f["ms"] >= 0 for f in job.frames)


def test_detections_must_persist_to_be_confirmed(tmp_path, det):
    def painter(frame, n, fps):                      # red (detected) for seconds 0-8, then grey, with change each frame
        frame[:, :, 0] = (n * 11) % 255
        if n < 8 * fps:
            frame[:, :, 2] = 200
    v = write_video(tmp_path / "p.avi", 12, fps=5, painter=painter)
    job = run(v, interval_s=3.0)
    flags = [[d["confirmed"] for d in f["detections"]] for f in job.frames]
    assert flags[0] == [True] and flags[1] == [True]                # seen in consecutive analysed frames
    assert job.frames[-1]["detections"] == []                       # gone again
    summary = job.view()["summary"]["per_label"]["thing"]
    assert summary["detections"] >= 2 and summary["confirmed"] >= 2


def test_long_footage_is_capped_and_noted(tmp_path, det):
    def moving(frame, n, fps):
        frame[:, :, 0] = (n * 5) % 255
    v = write_video(tmp_path / "long.avi", 60, fps=5, painter=moving)
    job = run(v, interval_s=1.0, max_frames=10)
    assert job.status == "done"
    assert len(job.frames) <= 10
    assert any("interval widened" in n for n in job.notes)
    assert job.params["effective_interval_s"] == pytest.approx(6.0)


def test_single_image_is_one_frame(tmp_path, det):
    p = tmp_path / "x.png"
    cv2.imwrite(str(p), np.full((90, 120, 3), 200, np.uint8))
    job = run(p)
    assert job.status == "done" and len(job.frames) == 1 and job.video["kind"] == "image"


def test_garbage_file_fails_with_a_readable_reason(tmp_path, det):
    p = tmp_path / "bad.bin"
    p.write_bytes(b"this is not footage" * 50)
    job = run(p)
    assert job.status == "failed" and "could not be read" in job.error


def test_detector_error_fails_the_job_not_the_service(tmp_path):
    def boom(img, prompts, conf):
        raise RuntimeError("model exploded")
    footage.set_detector(boom)
    try:
        job = run(write_video(tmp_path / "b.avi", 4, fps=5))
        assert job.status == "failed" and "model exploded" in job.error
    finally:
        footage.set_detector(None)


def test_upload_is_deleted_after_sampling_and_job_can_be_removed(tmp_path, det):
    job = run(write_video(tmp_path / "c.avi", 4, fps=5))
    assert not job.path.exists()                                    # the video itself is not kept
    assert footage.frame_path(job, 0).exists()                      # annotated frames are
    d = job.dir
    assert footage.delete_job(job.id) and not d.exists()
    assert footage.get_job(job.id) is None and not footage.delete_job(job.id)


# ---------------------------------------------------------------- HTTP
def _post(path, **form):
    with open(path, "rb") as fh:
        return client.post("/v1/test/jobs", files={"file": ("clip.avi", fh, "video/x-msvideo")}, data=form)


def _wait(jid):
    for _ in range(300):
        r = client.get(f"/v1/test/jobs/{jid}").json()
        if r["status"] in ("done", "failed"):
            return r
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_http_lifecycle(tmp_path, det):
    v = write_video(tmp_path / "h.avi", 8, fps=5, painter=lambda f, n, fps: f.__setitem__((slice(None), slice(None), 2), 200))
    r = _post(v, prompts=json.dumps(["x", "y"]), interval_s="2", conf="0.2")
    assert r.status_code == 202
    jid = r.json()["id"]
    res = _wait(jid)
    assert res["status"] == "done" and res["params"]["prompts"] == ["x", "y"] and res["params"]["conf"] == 0.2
    assert res["progress"]["sampled"] == 4
    img = client.get(f"/v1/test/jobs/{jid}/frames/0.jpg")
    assert img.status_code == 200 and img.headers["content-type"] == "image/jpeg" and img.content[:2] == b"\xff\xd8"
    assert client.get(f"/v1/test/jobs/{jid}/frames/99.jpg").status_code == 404
    assert client.delete(f"/v1/test/jobs/{jid}").status_code == 200
    assert client.get(f"/v1/test/jobs/{jid}").status_code == 404


@pytest.mark.parametrize("form", [
    {"interval_s": "0.2"}, {"interval_s": "30"}, {"conf": "0"}, {"conf": "0.95"}, {"max_frames": "0"}, {"max_frames": "9999"},
    {"prompts": "not json"}, {"prompts": "[]"}, {"prompts": "[1,2]"}, {"prompts": json.dumps(["x" * 200])}, {"prompts": json.dumps(["p"] * 31)},
])
def test_http_rejects_bad_parameters(tmp_path, det, form):
    v = write_video(tmp_path / "v.avi", 2, fps=5)
    assert _post(v, **form).status_code == 422


def test_http_rejects_empty_upload_and_unknown_job(det):
    assert client.post("/v1/test/jobs", files={"file": ("e.avi", b"", "video/x-msvideo")}).status_code == 422
    assert client.get("/v1/test/jobs/nope").status_code == 404
    assert client.delete("/v1/test/jobs/nope").status_code == 404


def test_http_oversize_upload_is_refused(tmp_path, det, monkeypatch):
    import service
    monkeypatch.setattr(service, "MAX_FOOTAGE_BYTES", 1000)
    v = tmp_path / "big.bin"
    v.write_bytes(b"x" * 5000)
    assert _post(v).status_code == 413


def test_http_unavailable_model_is_501(tmp_path, monkeypatch):
    import yolo_scene
    footage.set_detector(None)
    monkeypatch.setattr(yolo_scene, "available", lambda: False)
    v = write_video(tmp_path / "u.avi", 2, fps=5)
    r = _post(v)
    assert r.status_code == 501 and "YOLO-World" in r.json()["detail"]


def test_http_defaults_expose_the_sampling_policy(det):
    d = client.get("/v1/test/defaults").json()
    assert d["interval_s"] == 3.0 and d["candidates_per_window"] == 6 and d["max_frames"] == 400 and d["available"] is True
    assert "cement bag" in d["prompts"] and d["min_interval_s"] == 1.0 and d["max_interval_s"] == 10.0


def test_defect_backend_findings_become_detections(monkeypatch):
    """Choosing a registered defect model (e.g. a crack model) routes frames to it, not to YOLO-World."""
    import numpy as np
    import registry
    seen = {}

    def fake_backend(data, min_violation, conf):
        seen["min_violation"] = min_violation
        return {"findings": [{"defect_type": "concrete_crack", "score": 0.9, "bbox": [1, 2, 30, 40]}]}

    monkeypatch.setattr(registry, "resolve", lambda task, name: (fake_backend, {}))
    footage.set_detector(None)
    dets = footage._detect(np.zeros((60, 80, 3), np.uint8), [], 0.1, "crack_cnn")
    assert dets == [{"label": "concrete_crack", "conf": 0.9, "bbox": [1.0, 2.0, 30.0, 40.0]}]
    assert seen["min_violation"] == "Low"          # every finding, not only violations


def test_unknown_model_is_refused():
    r = client.post("/v1/test/jobs", files={"file": ("a.jpg", b"x")}, data={"model": "nonsense"})
    assert r.status_code == 422
