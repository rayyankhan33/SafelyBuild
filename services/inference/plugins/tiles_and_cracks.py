"""
tiles_and_cracks - rust/honeycomb heuristics (opencv_tiles) PLUS the trained crack model, in one `defects` backend.

The registry activates exactly one backend per task, so this combination lets a site keep the existing
rust/honeycomb findings and add cracks. Not active by default (the crack model has a measured false-alarm
problem outside SDNET-like imagery: docs/crack-model.md). To use it:

    BACKEND_DEFECTS=tiles_and_cracks      or     models/active.json  {"defects": "tiles_and_cracks"}
"""

import numpy as np

import pipeline
import registry
from plugins import crack_cnn


def defects(data: bytes, min_violation: str, conf: float) -> dict:
    img = pipeline.decode_image(data)
    tiles = pipeline._tile_findings(img, min_violation)
    cracks = crack_cnn.findings_for(img, min_violation)
    findings = sorted(tiles + cracks, key=lambda f: f.score, reverse=True)
    h, w = img.shape[:2]
    return {"backend": "tiles_and_cracks", "image_size": [w, h], "findings": [f.to_dict() for f in findings],
            "coverage": pipeline._coverage(findings, w, h)}


BACKEND = registry.Backend(
    name="tiles_and_cracks",
    version="1.0.0",
    tasks={"defects": defects},
    available=crack_cnn.BACKEND.available,
    info=crack_cnn.BACKEND.info,
    reliability="unvalidated",
)
