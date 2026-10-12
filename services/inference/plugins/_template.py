"""
TEMPLATE for a trained-model backend. Copy to plugins/<your_model>.py (names starting with "_" are
ignored) and fill in. Full contract and the evaluation workflow: docs/model-integration.md.

The platform calls ONLY the functions you register here. Nothing else in the system needs to change.
It will not use your backend until it is made active:

    services/inference/models/active.json   {"stage": "my_model", "inventory": "my_model"}
    or environment variables BACKEND_STAGE / BACKEND_INVENTORY / BACKEND_DEFECTS

Try it without activating it by passing ?backend=my_model to /v1/stage, /v1/inventory, /v1/defects,
or run the evaluation harness:  python evaluate.py --task stage --backend my_model --data <folder>
"""

from pathlib import Path

import numpy as np

import registry

WEIGHTS = Path(__file__).resolve().parents[1] / "models" / "my_model.pt"
_model = None


def _load():
    global _model
    if _model is None:
        # import torch / load weights lazily so the service still starts without them
        raise NotImplementedError("load your model here")
    return _model


# ---- stage: which construction stage is visible?
# img: BGR uint8 array (OpenCV). element_type: footing | column | beam | slab | masonry_wall
# Return stage as an int (0 = nothing built yet) using the SAME stage numbering as apps/api/src/domain/stages.js
# (see STAGE_EVIDENCE in scene.py). For masonry_wall return fraction in [0, 1] and stage = round(fraction * 100).
def stage(img: np.ndarray, element_type: str) -> dict:
    return {"stage": 0, "fraction": None, "evidence": {}, "backend": "my_model", "reliability": "unvalidated"}


# ---- inventory: how much material is visible?
# scale_m_per_px: calibrated ground scale of this camera. Return one item per material you can measure.
# material_code in {SAND, AGGREGATE, CEMENT, BRICK, REBAR}; units: SAND/AGGREGATE m3, CEMENT bag, BRICK nos, REBAR kg.
def inventory(img: np.ndarray, scale_m_per_px: float) -> dict:
    return {"backend": "my_model", "reliability": "unvalidated", "scale_m_per_px": scale_m_per_px,
            "items": [{"material_code": "CEMENT", "quantity": 0.0, "unit": "bag", "area_px": 0, "method": "my_model", "confidence": 0.0}]}


# ---- defects: rusted rebar / honeycombed concrete
# data: raw image bytes (decode with pipeline.decode_image). Return findings with defect_type in
# {"rusted_rebar", "honeycombed_concrete"}, score 0..1, severity Low|Medium|High|Critical, is_violation, bbox [x1,y1,x2,y2].
def defects(data: bytes, min_violation: str, conf: float) -> dict:
    return {"backend": "my_model", "image_size": [0, 0], "findings": [], "coverage": 0.0}


BACKEND = registry.Backend(
    name="my_model",
    version="0.0.0",                                   # bump on every retrain; stored with every result
    tasks={"stage": stage, "inventory": inventory, "defects": defects},   # list only the tasks you actually serve
    available=lambda: WEIGHTS.exists(),
    info=lambda: {"weights_sha256": registry.file_sha256(WEIGHTS), "trained_on": "describe the dataset", "metrics": {}},
    reliability="unvalidated",                         # becomes "validated" only after a measured evaluation
)
