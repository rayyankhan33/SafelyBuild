"""
crack_cnn - trained concrete-crack detector as a `defects` backend (cracks only).

Weights: models/crack_cnn.onnx (MobileNetV3-Large fine-tuned on SDNET2018; see docs/crack-model.md for how
it was trained and measured, including its false-alarm problem on photographs unlike SDNET).

Try it without activating it:   POST /v1/defects?backend=crack_cnn
Activate it (cracks only):      BACKEND_DEFECTS=crack_cnn   or   models/active.json {"defects": "crack_cnn"}
To keep rust/honeycomb detection AND add cracks, activate "tiles_and_cracks" instead.
"""

import json
from pathlib import Path
from typing import List

import numpy as np

import crack_model
import pipeline
import registry
from severity import is_violation

META = Path(crack_model.model_path()).with_suffix(".json")


def findings_for(img: np.ndarray, min_violation: str) -> List[pipeline.DefectFinding]:
    """Crack regions of one decoded frame as standard DefectFindings (score = model probability)."""
    result = crack_model.get_model().scan(img)
    return [
        pipeline.DefectFinding(crack_model.DEFECT_TYPE, r.score, r.severity, is_violation(r.severity, min_violation),
                               r.bbox, r.mean_prob, "crack_cnn")
        for r in result.regions
    ]


def defects(data: bytes, min_violation: str, conf: float) -> dict:
    img = pipeline.decode_image(data)
    findings = sorted(findings_for(img, min_violation), key=lambda f: f.score, reverse=True)
    h, w = img.shape[:2]
    return {"backend": "crack_cnn", "image_size": [w, h], "findings": [f.to_dict() for f in findings],
            "coverage": pipeline._coverage(findings, w, h)}


def _info() -> dict:
    meta = json.loads(META.read_text()) if META.is_file() else {}
    runtime = meta.get("metrics_runtime", {})
    return {
        "weights_sha256": registry.file_sha256(crack_model.model_path()),
        "trained_on": "SDNET2018 (decks, walls, pavements), split per photograph",
        "decision_threshold": meta.get("threshold"),
        "metrics": {"held_out_test_auc": runtime.get("test_auc"),
                    "held_out_test_at_threshold": runtime.get("test_at_validation_threshold")},
        "known_issue": "many false alarms on stained/spalled/textured concrete (docs/crack-model.md 4.2)",
    }


BACKEND = registry.Backend(
    name="crack_cnn",
    version="1.0.0",
    tasks={"defects": defects},
    available=crack_model.is_available,
    info=_info,
    reliability="unvalidated",  # measured on SDNET only; not on real site/CCTV imagery
)
