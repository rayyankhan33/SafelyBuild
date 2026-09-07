"""
heuristics.py — Defect Scoring Heuristics for Construction Quality Control

Provides two heuristic scoring functions:
  1. compute_rust_score  — detects rust on rebar via HSV color thresholding
  2. compute_honeycomb_score — detects honeycombing via edge/contour analysis

Both return a float score in [0.0, 1.0] where higher = more severe defect.

These are rule-based image-analysis heuristics, NOT machine-learning classifiers.
They are designed for a proof-of-concept and have been manually tuned on a small
set of sample images. Production use would require extensive calibration or a
trained model.
"""

import cv2
import numpy as np


# ============================================================================
# RUST SCORING (for rebar ROIs)
# ============================================================================

# HSV range definitions for rust-characteristic colors.
#
# Rust on steel presents as orange, red-brown, and dark brown tones.
# In OpenCV's HSV space (H: 0-179, S: 0-255, V: 0-255):
#
#   Range 1 — Orange-brown rust:
#     Hue 5-25 captures orange to brown tones
#     Saturation 50+ filters out gray/desaturated areas
#     Value 40-220 captures mid-to-bright intensities (excludes near-black shadows)
#
#   Range 2 — Red-brown rust (wrapping hue):
#     Hue 0-10 captures the red end
#     Hue 160-179 captures the other red wrap-around
#     Higher saturation minimum (70) to avoid matching skin tones or brickwork
#     Slightly lower value floor (30) to capture dark oxidation
#
# These ranges were tuned on the sample images in this project.
# False positives: bare soil, bricks, wooden formwork can trigger matches.

RUST_RANGES = [
    # (lower_HSV, upper_HSV) tuples
    # Range 1: Orange-brown
    (np.array([5, 50, 40]), np.array([25, 255, 220])),
    # Range 2a: Red-brown (low hue end)
    (np.array([0, 70, 30]), np.array([10, 255, 200])),
    # Range 2b: Red-brown (high hue wrap-around)
    (np.array([160, 70, 30]), np.array([179, 255, 200])),
]


def compute_rust_score(roi: np.ndarray) -> float:
    """
    Compute a rust severity score for a rebar ROI.

    Algorithm:
        1. Convert the ROI from BGR to HSV color space.
        2. For each defined rust-color range, create a binary mask
           of pixels that fall within that HSV range.
        3. Union all masks.
        4. Compute the fraction of ROI pixels that are rust-colored.

    Parameters
    ----------
    roi : np.ndarray
        Cropped region of interest in BGR format (from OpenCV).
        Expected to contain a rebar detection.

    Returns
    -------
    float
        Rust score in [0.0, 1.0]. Higher means more rust coverage.
        0.0 = no rust-colored pixels found.
        1.0 = entire ROI matches rust color ranges.

    Notes
    -----
    - Small ROIs (< 100 pixels) return 0.0 to avoid noise-driven scores.
    - The score represents area coverage, not depth of corrosion.
    """
    if roi is None or roi.size == 0:
        return 0.0

    # Guard against very small ROIs where noise dominates
    h, w = roi.shape[:2]
    if h * w < 100:
        return 0.0

    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)

    # Build a combined mask from all rust-color ranges
    combined_mask = np.zeros(hsv.shape[:2], dtype=np.uint8)
    for lower, upper in RUST_RANGES:
        mask = cv2.inRange(hsv, lower, upper)
        combined_mask = cv2.bitwise_or(combined_mask, mask)

    # Optional: apply morphological opening to reduce noise
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    combined_mask = cv2.morphologyEx(combined_mask, cv2.MORPH_OPEN, kernel)

    # Compute rust coverage ratio
    rust_pixels = cv2.countNonZero(combined_mask)
    total_pixels = h * w
    rust_score = rust_pixels / total_pixels

    return float(np.clip(rust_score, 0.0, 1.0))


# ============================================================================
# HONEYCOMB SCORING (for concrete surface ROIs)
# ============================================================================

# Honeycombing in concrete appears as voids, cavities, and a rough/pitted
# surface texture. We detect it via two complementary approaches:
#
#   1. Void detection (weight: 0.6):
#      - Canny edge detection to find boundaries of voids
#      - Contour analysis to identify enclosed void-like regions
#      - Voids are dark, roughly circular/irregular enclosed areas
#      - We measure the total void area as a fraction of the ROI
#
#   2. Texture roughness (weight: 0.4):
#      - Laplacian variance as a proxy for surface roughness
#      - Honeycombed concrete has very high edge density (rough texture)
#        compared to smooth/well-finished concrete
#      - We normalize against empirically observed ranges
#
# Combined score = 0.6 × void_ratio + 0.4 × normalized_roughness

# Minimum contour area (in pixels) to consider as a void.
# Smaller contours are likely noise from texture or camera artifacts.
MIN_VOID_AREA = 50

# Laplacian variance normalization range.
# Smooth concrete ≈ 100-500 variance; honeycombed ≈ 800-3000+.
# We normalize: roughness = clip((variance - 200) / 2000, 0, 1)
ROUGHNESS_FLOOR = 200.0
ROUGHNESS_RANGE = 2000.0


def compute_honeycomb_score(roi: np.ndarray) -> float:
    """
    Compute a honeycomb severity score for a concrete surface ROI.

    Algorithm:
        1. Convert to grayscale and blur to reduce noise.
        2. Apply Canny edge detection.
        3. Find contours and filter by area.
        4. Sum qualifying contour areas → void_ratio.
        5. Compute Laplacian variance → texture roughness.
        6. Combine: score = 0.6 × void_ratio + 0.4 × roughness.

    Parameters
    ----------
    roi : np.ndarray
        Cropped region of interest in BGR format (from OpenCV).
        Expected to contain a concrete surface detection.

    Returns
    -------
    float
        Honeycomb score in [0.0, 1.0]. Higher means more honeycombing.
        0.0 = smooth concrete surface, no voids detected.
        1.0 = severely honeycombed with extensive voids and rough texture.

    Notes
    -----
    - Small ROIs (< 100 pixels) return 0.0 to avoid noise-driven scores.
    - The void detection approach may also trigger on intentional features
      like conduit holes or form-tie holes. This is a known POC limitation.
    """
    if roi is None or roi.size == 0:
        return 0.0

    h, w = roi.shape[:2]
    if h * w < 100:
        return 0.0

    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

    # --- Void detection via Canny + contour analysis ---

    # Gaussian blur to reduce high-frequency noise
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)

    # Adaptive thresholding to find dark voids against lighter concrete
    # Dark regions (voids) will become white in the binary image
    thresh = cv2.adaptiveThreshold(
        blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 11, 4
    )

    # Canny edge detection for boundary refinement
    edges = cv2.Canny(blurred, 30, 100)

    # Combine threshold and edge results
    combined = cv2.bitwise_or(thresh, edges)

    # Morphological closing to connect nearby edges into enclosed voids
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    closed = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, kernel)

    # Find contours
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    # Sum areas of qualifying contours (potential voids)
    total_area = h * w
    void_area = 0
    for contour in contours:
        area = cv2.contourArea(contour)
        if area >= MIN_VOID_AREA:
            void_area += area

    # Cap void_ratio at 1.0 (in case contours overlap or fill the ROI)
    void_ratio = min(void_area / total_area, 1.0)

    # --- Texture roughness via Laplacian variance ---

    laplacian = cv2.Laplacian(gray, cv2.CV_64F)
    laplacian_var = float(laplacian.var())

    # Normalize roughness to [0, 1]
    normalized_roughness = np.clip(
        (laplacian_var - ROUGHNESS_FLOOR) / ROUGHNESS_RANGE, 0.0, 1.0
    )

    # --- Combine scores ---
    honeycomb_score = 0.6 * void_ratio + 0.4 * float(normalized_roughness)

    return float(np.clip(honeycomb_score, 0.0, 1.0))


# ============================================================================
# CLI test entrypoint
# ============================================================================
if __name__ == "__main__":
    """
    Quick test: apply heuristics to ROIs from the detector.
    Usage:  python heuristics.py
    """
    import os
    import glob

    # Try to import detector for integration test
    try:
        from detector import detect_regions
    except ImportError:
        print("[heuristics] Could not import detector. Run standalone tests instead.")
        exit(1)

    script_dir = os.path.dirname(os.path.abspath(__file__))
    image_extensions = ("*.jpg", "*.jpeg", "*.png", "*.webp", "*.jfif")
    image_files = []
    for ext in image_extensions:
        image_files.extend(glob.glob(os.path.join(script_dir, ext)))

    # Exclude annotated images from previous test runs
    image_files = [f for f in image_files if not os.path.basename(f).startswith("annotated_")]

    if not image_files:
        print("[heuristics] No images found.")
    else:
        print(f"[heuristics] Found {len(image_files)} images. Running detection + heuristics...\n")

    for img_path in image_files:
        filename = os.path.basename(img_path)
        print(f"--- {filename} ---")
        detections = detect_regions(img_path)
        print(f"  Detections: {len(detections)}")

        for i, det in enumerate(detections):
            if det.category == "rebar" and det.roi_image is not None:
                score = compute_rust_score(det.roi_image)
                print(
                    f"    [{i}] {det.class_name} (conf={det.confidence:.3f}) "
                    f"→ rust_score = {score:.3f}"
                )
            elif det.category == "concrete" and det.roi_image is not None:
                score = compute_honeycomb_score(det.roi_image)
                print(
                    f"    [{i}] {det.class_name} (conf={det.confidence:.3f}) "
                    f"→ honeycomb_score = {score:.3f}"
                )
            else:
                print(
                    f"    [{i}] {det.class_name} (conf={det.confidence:.3f}) "
                    f"→ category={det.category}, no ROI"
                )
        print()
