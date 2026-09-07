"""
detector.py — Zero-Shot Object Detection for Construction Quality Control

Uses YOLO-World (open-vocabulary YOLO) to detect regions of interest
in construction site images without any fine-tuning or labeled dataset.
The model is prompted with text descriptions of the objects we want to
find (rebar, concrete surfaces) and returns bounding boxes.

When YOLO-World detection yields few or no results (common with zero-shot
on niche domains), a full-image fallback analysis is applied: both the
rust and honeycomb heuristics are run on the entire image, and the image
is added as a synthetic detection for whichever defect type scores
highest. This ensures the POC always produces meaningful results.

This is the first stage of the defect-detection pipeline:
    Image -> detector.py (ROIs) -> heuristics.py (scores) -> severity.py -> db.py
"""

import os
from dataclasses import dataclass, field
from typing import List, Optional

import cv2
import numpy as np
from ultralytics import YOLO


# ---------------------------------------------------------------------------
# Open-vocabulary class prompts
# ---------------------------------------------------------------------------
# These are the text prompts YOLO-World uses for zero-shot detection.
# Grouped into two categories that map to our defect analysis types.
#
# More varied prompts increase the chance of at least one matching,
# since zero-shot detection is sensitive to wording.
REBAR_PROMPTS = [
    "steel rebar",
    "exposed reinforcement",
    "rusty metal bar",
    "iron rod",
    "metal reinforcement",
    "corroded steel",
]
CONCRETE_PROMPTS = [
    "concrete surface",
    "concrete wall",
    "concrete column",
    "concrete structure",
    "cement wall",
    "concrete beam",
]
ALL_PROMPTS = REBAR_PROMPTS + CONCRETE_PROMPTS

# Mapping from prompt text -> defect category
CATEGORY_MAP = {}
for p in REBAR_PROMPTS:
    CATEGORY_MAP[p] = "rebar"
for p in CONCRETE_PROMPTS:
    CATEGORY_MAP[p] = "concrete"


@dataclass
class DetectionResult:
    """A single detected region of interest."""

    bbox: tuple  # (x1, y1, x2, y2) in pixel coordinates
    class_name: str  # original YOLO-World class prompt that matched
    category: str  # "rebar" or "concrete"
    confidence: float  # detection confidence score
    roi_image: Optional[np.ndarray] = field(
        default=None, repr=False
    )  # cropped ROI array (BGR)


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------
_model: Optional[YOLO] = None
_MODEL_NAME = "yolov8s-worldv2"


def _load_model() -> YOLO:
    """
    Load and cache the YOLO-World model.

    Uses yolov8s-worldv2 (small variant, ~338 MB download on first run).
    The model is cached in the ultralytics default cache directory.
    """
    global _model
    if _model is None:
        print(f"[detector] Loading {_MODEL_NAME}...")
        _model = YOLO(f"{_MODEL_NAME}.pt")
        # Set the open-vocabulary classes
        _model.set_classes(ALL_PROMPTS)
        print(f"[detector] Model loaded. Classes set: {ALL_PROMPTS}")
    return _model


def _load_image(image_path: str) -> np.ndarray:
    """
    Load an image from disk, falling back to Pillow for formats
    OpenCV may not support natively (e.g. some jfif/webp variants).
    """
    image = cv2.imread(image_path)
    if image is None:
        from PIL import Image as PILImage

        pil_img = PILImage.open(image_path).convert("RGB")
        image = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
    if image is None:
        raise ValueError(f"Could not read image: {image_path}")
    return image


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------
def detect_regions(
    image_path: str,
    confidence_threshold: float = 0.10,
) -> List[DetectionResult]:
    """
    Run zero-shot detection on a single image.

    If YOLO-World returns no detections (common for zero-shot on
    construction images), the full image is analyzed as a fallback.

    Parameters
    ----------
    image_path : str
        Path to the image file (jpg, png, webp, jfif all supported).
    confidence_threshold : float
        Minimum confidence to keep a detection. Default 0.10 is
        intentionally low — for a POC we prefer recall over precision
        so the heuristic stage can refine.

    Returns
    -------
    List[DetectionResult]
        Detected regions with bounding boxes, categories, and cropped ROIs.
    """
    model = _load_model()

    image = _load_image(image_path)
    h, w = image.shape[:2]

    # Run inference
    results = model.predict(
        source=image,
        conf=confidence_threshold,
        verbose=False,
    )

    detections: List[DetectionResult] = []

    for result in results:
        boxes = result.boxes
        if boxes is None or len(boxes) == 0:
            continue

        for i in range(len(boxes)):
            # Bounding box coordinates
            x1, y1, x2, y2 = boxes.xyxy[i].cpu().numpy().astype(int)
            # Clamp to image bounds
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(w, x2), min(h, y2)

            conf = float(boxes.conf[i].cpu().numpy())
            cls_idx = int(boxes.cls[i].cpu().numpy())
            class_name = ALL_PROMPTS[cls_idx] if cls_idx < len(ALL_PROMPTS) else "unknown"
            category = CATEGORY_MAP.get(class_name, "unknown")

            # Crop the ROI
            roi = image[y1:y2, x1:x2].copy() if (x2 > x1 and y2 > y1) else None

            detections.append(
                DetectionResult(
                    bbox=(int(x1), int(y1), int(x2), int(y2)),
                    class_name=class_name,
                    category=category,
                    confidence=conf,
                    roi_image=roi,
                )
            )

    # -----------------------------------------------------------------
    # Fallback: if YOLO-World found nothing, run full-image analysis.
    #
    # Zero-shot detection on niche construction domains often yields
    # zero or very sparse results. Rather than showing a blank result,
    # we analyze the entire image with both heuristics and create a
    # synthetic detection for the category that scores highest.
    #
    # This is a pragmatic POC choice — in production, a fine-tuned
    # model would eliminate the need for this fallback.
    # -----------------------------------------------------------------
    if len(detections) == 0:
        detections = _fallback_full_image(image, w, h)

    return detections


def _fallback_full_image(
    image: np.ndarray, w: int, h: int
) -> List[DetectionResult]:
    """
    Fallback: when YOLO-World finds nothing, analyze the full image
    with both heuristics and create synthetic detections.

    We import heuristics here (lazy) to avoid a circular import
    at module level.
    """
    from heuristics import compute_rust_score, compute_honeycomb_score

    rust_score = compute_rust_score(image)
    honeycomb_score = compute_honeycomb_score(image)

    results = []

    # Add detections for any non-trivial score (> 0.05)
    # This means the image has at least some signal for the defect type.
    if rust_score > 0.05:
        results.append(
            DetectionResult(
                bbox=(0, 0, w, h),
                class_name="full-image rust analysis",
                category="rebar",
                confidence=min(rust_score, 0.99),
                roi_image=image.copy(),
            )
        )

    if honeycomb_score > 0.05:
        results.append(
            DetectionResult(
                bbox=(0, 0, w, h),
                class_name="full-image honeycomb analysis",
                category="concrete",
                confidence=min(honeycomb_score, 0.99),
                roi_image=image.copy(),
            )
        )

    # If neither heuristic produced a signal, add the stronger one
    # anyway so the user always sees a result.
    if not results:
        if rust_score >= honeycomb_score:
            results.append(
                DetectionResult(
                    bbox=(0, 0, w, h),
                    class_name="full-image rust analysis",
                    category="rebar",
                    confidence=max(rust_score, 0.01),
                    roi_image=image.copy(),
                )
            )
        else:
            results.append(
                DetectionResult(
                    bbox=(0, 0, w, h),
                    class_name="full-image honeycomb analysis",
                    category="concrete",
                    confidence=max(honeycomb_score, 0.01),
                    roi_image=image.copy(),
                )
            )

    return results


# ---------------------------------------------------------------------------
# Annotation helper
# ---------------------------------------------------------------------------
def annotate_image(
    image: np.ndarray,
    detections: List[DetectionResult],
    color_map: Optional[dict] = None,
) -> np.ndarray:
    """
    Draw bounding boxes and labels on the image.

    Parameters
    ----------
    image : np.ndarray
        Original image (BGR).
    detections : List[DetectionResult]
        Detections to annotate.
    color_map : dict, optional
        Mapping of category -> BGR color. Defaults provided.

    Returns
    -------
    np.ndarray
        Annotated image copy.
    """
    if color_map is None:
        color_map = {
            "rebar": (0, 140, 255),  # orange
            "concrete": (255, 180, 0),  # light blue
            "unknown": (128, 128, 128),  # gray
        }

    annotated = image.copy()
    for det in detections:
        x1, y1, x2, y2 = det.bbox
        color = color_map.get(det.category, (128, 128, 128))

        cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2)

        label = f"{det.category} ({det.confidence:.2f})"
        font_scale = 0.5
        thickness = 1
        (tw, th), baseline = cv2.getTextSize(
            label, cv2.FONT_HERSHEY_SIMPLEX, font_scale, thickness
        )
        # Background rectangle for text
        cv2.rectangle(
            annotated, (x1, y1 - th - 6), (x1 + tw + 4, y1), color, -1
        )
        cv2.putText(
            annotated,
            label,
            (x1 + 2, y1 - 4),
            cv2.FONT_HERSHEY_SIMPLEX,
            font_scale,
            (255, 255, 255),
            thickness,
        )

    return annotated


# ---------------------------------------------------------------------------
# CLI test entrypoint
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    """
    Quick test: run detection on all images in the current directory.
    Usage:  python detector.py
    """
    import glob

    image_extensions = ("*.jpg", "*.jpeg", "*.png", "*.webp", "*.jfif")
    image_files = []
    script_dir = os.path.dirname(os.path.abspath(__file__))
    for ext in image_extensions:
        image_files.extend(glob.glob(os.path.join(script_dir, ext)))

    # Exclude annotated images from previous runs
    image_files = [f for f in image_files if not os.path.basename(f).startswith("annotated_")]

    if not image_files:
        print("[detector] No images found in the current directory.")
    else:
        print(f"[detector] Found {len(image_files)} images. Running detection...\n")

    for img_path in image_files:
        filename = os.path.basename(img_path)
        print(f"--- {filename} ---")
        dets = detect_regions(img_path)
        print(f"  Detections: {len(dets)}")
        for d in dets:
            print(
                f"    [{d.category}] {d.class_name} "
                f"conf={d.confidence:.3f} bbox={d.bbox}"
            )

        # Save annotated image for visual inspection
        original = _load_image(img_path)
        annotated = annotate_image(original, dets)
        out_path = os.path.join(script_dir, f"annotated_{filename.rsplit('.', 1)[0]}.jpg")
        cv2.imwrite(out_path, annotated)
        print(f"  Saved annotated image -> {out_path}")
        print()
