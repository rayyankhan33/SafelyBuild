"""
crack_video.py - crack monitoring on CCTV footage (video file, webcam index or RTSP/HTTP stream).

    python crack_video.py --source site_cam.mp4 --every 2 --out annotated.mp4 --events events.json
    python crack_video.py --source rtsp://user:pass@192.168.1.20/stream1 --every 5 --snapshots found/

A CCTV camera is usually fixed, and a crack does not move. Every `--every` seconds one frame is
scanned with the crack model (crack_model.py). A region is only *confirmed* when it is found in
`--confirm` consecutive scanned frames, which removes one-off false alarms (passing people, shadows,
compression noise). Each newly confirmed region is reported once as an event.

Limits: see crack_model.py. At typical CCTV distances only wide cracks are visible; point (or zoom)
the camera at the structure being inspected.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
import time
from dataclasses import asdict, dataclass
from typing import Iterator, List, Optional, Tuple

import cv2
import numpy as np

import crack_model
from severity import get_severity_color

MAX_SIDE_PX = 1280  # same working resolution as the photo pipeline


@dataclass
class CrackEvent:
    time_s: float
    frame_index: int
    bbox: Tuple[int, int, int, int]
    score: float
    severity: str


class CrackTracker:
    """Per-pixel persistence of crack evidence over successive scans of a fixed camera view."""

    def __init__(self, shape: Tuple[int, int], threshold: float, confirm: int = 3, min_area_fraction: float = 0.0):
        self.threshold, self.confirm, self.min_area_fraction = threshold, confirm, min_area_fraction
        self.streak = np.zeros(shape, dtype=np.int16)
        self.reported: List[Tuple[int, int, int, int]] = []

    @staticmethod
    def _overlap(a, b) -> float:
        """Intersection area / area of the smaller box."""
        ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
        iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
        small = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
        return (ix * iy) / small if small else 0.0

    def update(self, heat: np.ndarray, time_s: float = 0.0, frame_index: int = 0):
        """Feed one scan. Returns (confirmed_regions, new_events); regions are CrackRegion objects."""
        hit = heat >= self.threshold
        self.streak = np.where(hit, np.minimum(self.streak + 1, 32000), 0).astype(np.int16)
        confirmed_heat = np.where(self.streak >= self.confirm, heat, 0.0).astype(np.float32)
        regions = [r for r in crack_model.CrackModel._regions(confirmed_heat, self.threshold, heat.size)
                   if r.area_fraction >= self.min_area_fraction]
        events: List[CrackEvent] = []
        for r in regions:
            if not any(self._overlap(r.bbox, old) > 0.3 for old in self.reported):
                self.reported.append(r.bbox)
                events.append(CrackEvent(round(time_s, 2), frame_index, r.bbox, r.score, r.severity))
        return regions, events


def frames(source: str, every_s: float) -> Iterator[Tuple[int, float, np.ndarray]]:
    """Yield (frame_index, time_s, frame) roughly every `every_s` seconds of footage."""
    cap = cv2.VideoCapture(int(source) if source.isdigit() else source)
    if not cap.isOpened():
        raise SystemExit(f"cannot open video source {source!r}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    step = max(1, int(round(every_s * fps)))
    live = source.isdigit() or "://" in source
    index, last = 0, -1e9
    try:
        while True:
            ok = cap.grab()
            if not ok:
                break
            t = index / fps
            take = (time.time() - last >= every_s) if live else (index % step == 0)
            if take:
                ok, frame = cap.retrieve()
                if ok:
                    last = time.time()
                    yield index, t, frame
            index += 1
    finally:
        cap.release()


def annotate(frame: np.ndarray, confirmed, tentative) -> np.ndarray:
    out = frame.copy()
    for r in tentative:
        x1, y1, x2, y2 = r.bbox
        cv2.rectangle(out, (x1, y1), (x2, y2), (0, 220, 220), 1)
    for r in confirmed:
        x1, y1, x2, y2 = r.bbox
        color = get_severity_color(r.severity)
        cv2.rectangle(out, (x1, y1), (x2, y2), color, 3)
        cv2.putText(out, f"crack {r.score:.2f} {r.severity}", (x1 + 4, max(18, y1 + 18)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2, cv2.LINE_AA)
    return out


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", required=True, help="video file, camera index (0) or stream URL")
    ap.add_argument("--every", type=float, default=2.0, help="seconds between scanned frames")
    ap.add_argument("--confirm", type=int, default=3, help="consecutive scans a region must persist to be reported")
    ap.add_argument("--threshold", type=float, default=None, help="override the model's decision threshold")
    ap.add_argument("--scales", default="256,384,512", help="window sizes in pixels, comma separated")
    ap.add_argument("--max-seconds", type=float, default=0, help="stop after this much footage (0 = all)")
    ap.add_argument("--out", help="write an annotated video here (one frame per scan)")
    ap.add_argument("--events", help="write detected events as JSON here")
    ap.add_argument("--snapshots", help="folder for an annotated image of each new event")
    args = ap.parse_args(argv)

    model = crack_model.get_model()
    thr = model.threshold if args.threshold is None else args.threshold
    scales = tuple(int(s) for s in args.scales.split(","))
    tracker: Optional[CrackTracker] = None
    writer = None
    all_events: List[CrackEvent] = []
    scanned = 0
    t_start = time.time()
    if args.snapshots:
        pathlib.Path(args.snapshots).mkdir(parents=True, exist_ok=True)

    for idx, t, frame in frames(args.source, args.every):
        if args.max_seconds and t > args.max_seconds:
            break
        h, w = frame.shape[:2]
        if max(h, w) > MAX_SIDE_PX:
            s = MAX_SIDE_PX / max(h, w)
            frame = cv2.resize(frame, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
            h, w = frame.shape[:2]
        if tracker is None:
            tracker = CrackTracker((h, w), thr, args.confirm)
        res = model.scan(frame, scales=scales, threshold=thr)
        confirmed, events = tracker.update(res.heat, t, idx)
        scanned += 1
        all_events.extend(events)
        for e in events:
            print(f"[{e.time_s:7.1f}s] NEW CRACK severity={e.severity} score={e.score:.2f} bbox={e.bbox}", flush=True)
        vis = annotate(frame, confirmed, [r for r in res.regions if r not in confirmed])
        if args.snapshots and events:
            cv2.imwrite(str(pathlib.Path(args.snapshots) / f"crack_{idx:08d}.jpg"), vis)
        if args.out:
            if writer is None:
                writer = cv2.VideoWriter(args.out, cv2.VideoWriter_fourcc(*"mp4v"), 4.0, (w, h))
            writer.write(vis)

    if writer is not None:
        writer.release()
    summary = {"source": args.source, "frames_scanned": scanned, "events": [asdict(e) for e in all_events],
               "threshold": thr, "confirm": args.confirm, "seconds_taken": round(time.time() - t_start, 1)}
    if args.events:
        pathlib.Path(args.events).write_text(json.dumps(summary, indent=2))
    print(f"scanned {scanned} frames, {len(all_events)} confirmed crack region(s) in {summary['seconds_taken']}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
