# SafelyBuild — Construction Quality Control POC

A proof-of-concept system that inspects construction site images for **rusted rebar** and **honeycombed concrete** defects, then simulates violation notifications to a concerned authority.

Built as a Final Year Project (FYP) demonstration.

---

## Quick Start

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Run the application
streamlit run app.py
```

The app will open in your browser at `http://localhost:8501`.

> **First run:** The YOLO-World model (~338 MB) will be downloaded automatically on the first detection run. This is a one-time download.

---

## How It Works

### Detection Pipeline

```
Image Upload -> Zero-Shot Detection -> Heuristic Scoring -> Severity Mapping -> Violation Check -> Notification
```

1. **Zero-Shot Detection** (`detector.py`):
   Uses [YOLO-World](https://docs.ultralytics.com/models/yolo-world/) (yolov8s-worldv2) — an open-vocabulary object detector that can find objects based on text descriptions without any training data. We prompt it with descriptions like "steel rebar", "exposed reinforcement", and "concrete surface" to localize regions of interest.

2. **Rust Heuristic** (`heuristics.py`):
   For regions classified as rebar, we convert the cropped ROI to HSV color space and apply masks for rust-characteristic colors (orange-brown hues H:5-25, red-brown H:0-10 and H:160-179). The rust score is the fraction of the ROI area matching these color ranges.

3. **Honeycomb Heuristic** (`heuristics.py`):
   For regions classified as concrete surfaces, we detect voids using a combination of:
   - Adaptive thresholding + Canny edge detection + contour analysis to find void-like regions
   - Laplacian variance as a texture-roughness indicator
   - Combined score: 60% void ratio + 40% normalized roughness

4. **Severity Mapping** (`severity.py`):
   Scores are mapped to severity levels:
   | Score Range | Severity | Description |
   |---|---|---|
   | 0.00 - 0.15 | Low | Minor cosmetic concern |
   | 0.15 - 0.35 | Medium | Noticeable; may affect durability |
   | 0.35 - 0.60 | High | Significant; likely impacts durability |
   | 0.60 - 1.00 | Critical | Severe; immediate remediation recommended |

   Thresholds are informed by general defect severity language in ACI 201.1R and IS:456.

5. **Violation Logic**: Defects at or above a configurable severity threshold (default: Medium) are flagged as violations.

6. **Notification Simulation** (`notifier.py`): On violation, a simulated notification is displayed. The code uses a pluggable `Notifier` base class so real SMTP/Twilio notifiers can be swapped in.

7. **SQLite Logging** (`db.py`): All analysis results are persisted to `quality_control.db` and displayed in the History tab.

---

## Project Structure

```
SafelyBuild/
├── app.py              # Streamlit entrypoint (dashboard)
├── detector.py         # YOLO-World zero-shot detection wrapper
├── heuristics.py       # Rust + honeycomb scoring functions
├── severity.py         # Score -> severity -> violation mapping
├── db.py               # SQLite schema + logging functions
├── notifier.py         # Notification simulation (pluggable)
├── requirements.txt    # Python dependencies
├── README.md           # This file
└── quality_control.db  # SQLite database (auto-created)
```

---

## POC Limitations

This is a **proof-of-concept** with several known limitations:

1. **No trained model**: Detection relies on YOLO-World's zero-shot capability. It has not been fine-tuned on construction defect images. False positives and missed detections are expected.

2. **Manually tuned thresholds**: All color ranges (rust HSV bounds), edge detection parameters (Canny thresholds), and severity score boundaries were manually calibrated on a small set of 4 sample images. These would need extensive calibration for real-world use.

3. **Small sample validation**: The system has only been tested on 4 images. Performance on diverse construction environments, lighting conditions, and camera angles is unvalidated.

4. **Heuristic scoring, not ML classification**: The rust and honeycomb scores are computed from simple image-processing rules (color thresholding, edge density), not from learned features. They can be fooled by similar-looking but non-defective surfaces (bare soil, patterned formwork, etc.).

5. **No depth or 3D analysis**: Scores represent 2D image features only. Actual corrosion depth, concrete cover loss, or void volume cannot be assessed from images alone.

6. **Simulated notifications**: The notification system logs to console only. No real email/SMS is sent. The architecture supports plugging in real notifiers.

---

## Requirements

- Python 3.10+
- ~500 MB disk space (for the YOLO-World model + dependencies)
- No GPU required (CPU inference is sufficient for POC)

---

## License

This project is an academic proof-of-concept. Not intended for production or safety-critical use.
