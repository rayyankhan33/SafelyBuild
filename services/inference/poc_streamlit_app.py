"""
app.py — Streamlit Dashboard for SafelyBuild Construction Quality Control

This is the main entrypoint for the POC application.
Run with:  streamlit run app.py

Pipeline per uploaded image:
    1. Zero-shot detection (YOLO-World) -> bounding boxes / ROIs
    2. Heuristic scoring (HSV rust / Canny honeycomb) -> defect scores
    3. Severity mapping -> Low / Medium / High / Critical
    4. Violation check -> flag if severity >= configurable threshold
    5. SQLite logging -> persist results
    6. Notification simulation -> alert on violations
    7. Dashboard display -> annotated image + results table + history
"""

import os
import cv2
import numpy as np
import streamlit as st
from PIL import Image
from datetime import datetime

from detector import detect_regions, annotate_image, DetectionResult
from heuristics import compute_rust_score, compute_honeycomb_score
from severity import (
    classify_severity,
    is_violation,
    get_severity_color,
    SEVERITY_LEVELS,
)
from db import init_db, log_analysis, log_notification, get_history
from notifier import SimulatedNotifier

# ---------------------------------------------------------------------------
# Page configuration
# ---------------------------------------------------------------------------
st.set_page_config(
    page_title="SafelyBuild",
    page_icon="SB",
    layout="wide",
    initial_sidebar_state="expanded",
)

# ---------------------------------------------------------------------------
# Initialize
# ---------------------------------------------------------------------------
init_db()
notifier = SimulatedNotifier()

# ---------------------------------------------------------------------------
# Sidebar — Configuration
# ---------------------------------------------------------------------------
st.sidebar.title("Configuration")

confidence_threshold = st.sidebar.slider(
    "Detection Confidence Threshold",
    min_value=0.05,
    max_value=0.50,
    value=0.15,
    step=0.05,
    help=(
        "Minimum confidence for YOLO-World detections. "
        "Lower = more detections (higher recall), Higher = fewer but more confident."
    ),
)

min_violation_severity = st.sidebar.selectbox(
    "Minimum Violation Severity",
    options=list(SEVERITY_LEVELS),
    index=1,  # Default: "Medium"
    help="Defects at or above this severity level will be flagged as violations.",
)

st.sidebar.markdown("---")
st.sidebar.markdown(
    """
    **About SafelyBuild**

    Zero-shot detection using YOLO-World with
    heuristic image analysis for defect scoring.
    No training data or fine-tuning required.

    *Thresholds are manually tuned and approximate.*
    """
)

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------
st.title("SafelyBuild — Construction Quality Control")
st.markdown(
    "Upload a construction site image to inspect for **rusted rebar** "
    "and **honeycombed concrete** defects."
)

# ---------------------------------------------------------------------------
# Tabs
# ---------------------------------------------------------------------------
tab_analyze, tab_history = st.tabs(["Analyze Image", "Analysis History"])

# ===== ANALYZE TAB =====
with tab_analyze:
    uploaded_file = st.file_uploader(
        "Upload a construction site image",
        type=["jpg", "jpeg", "png", "webp", "jfif"],
        help="Supported formats: JPG, PNG, WebP, JFIF",
    )

    if uploaded_file is not None:
        # Save uploaded file temporarily
        temp_dir = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "temp_uploads"
        )
        os.makedirs(temp_dir, exist_ok=True)
        temp_path = os.path.join(temp_dir, uploaded_file.name)

        with open(temp_path, "wb") as f:
            f.write(uploaded_file.getbuffer())

        # Load image for display and annotation
        pil_image = Image.open(temp_path).convert("RGB")
        image_bgr = cv2.cvtColor(np.array(pil_image), cv2.COLOR_RGB2BGR)

        # Show original image
        st.subheader("Uploaded Image")
        st.image(pil_image, caption=uploaded_file.name, use_container_width=True)

        # ----- Run Pipeline -----
        with st.spinner("Running zero-shot detection..."):
            detections = detect_regions(
                temp_path, confidence_threshold=confidence_threshold
            )

        if not detections:
            st.warning(
                "No regions of interest detected. Try lowering the confidence "
                "threshold in the sidebar, or upload a different image."
            )
        else:
            st.success(f"Found **{len(detections)}** region(s) of interest.")

            # ----- Score, Classify, and Log Each Detection -----
            results = []  # Collect results for display
            violations = []
            annotated = image_bgr.copy()

            for det in detections:
                if det.roi_image is None:
                    continue

                # Run BOTH heuristics on every ROI. Report each defect
                # type that scores above a minimum threshold, since a
                # single ROI can exhibit both rusted rebar and
                # honeycombed concrete (e.g. a damaged column).
                rust_score = compute_rust_score(det.roi_image)
                honeycomb_score = compute_honeycomb_score(det.roi_image)

                # Collect (defect_type, display_name, score) pairs to report
                defect_entries = []
                REPORT_THRESHOLD = 0.10  # minimum score to report a defect

                if rust_score >= REPORT_THRESHOLD:
                    defect_entries.append(("rusted_rebar", "Rusted Rebar", rust_score))
                if honeycomb_score >= REPORT_THRESHOLD:
                    defect_entries.append(("honeycombed_concrete", "Honeycombed Concrete", honeycomb_score))

                # If neither is above threshold, report the higher one anyway
                if not defect_entries:
                    if rust_score >= honeycomb_score:
                        defect_entries.append(("rusted_rebar", "Rusted Rebar", rust_score))
                    else:
                        defect_entries.append(("honeycombed_concrete", "Honeycombed Concrete", honeycomb_score))

                for defect_type, defect_display, score in defect_entries:
                    severity = classify_severity(score)
                    violation = is_violation(severity, min_violation_severity)

                    # Log to database
                    row_id = log_analysis(
                        image_filename=uploaded_file.name,
                        defect_type=defect_type,
                        score=score,
                        severity=severity,
                        is_violation=violation,
                        bbox=det.bbox,
                    )

                    result = {
                        "id": row_id,
                        "defect_type": defect_display,
                        "class_name": det.class_name,
                        "confidence": det.confidence,
                        "score": score,
                        "severity": severity,
                        "violation": violation,
                        "bbox": det.bbox,
                    }
                    results.append(result)

                    if violation:
                        violations.append(result)

                    # ----- Annotate image with severity-colored boxes -----
                    x1, y1, x2, y2 = det.bbox
                    color = get_severity_color(severity)
                    thickness = 3 if violation else 2

                    cv2.rectangle(annotated, (x1, y1), (x2, y2), color, thickness)

                    # Label text — offset vertically for multiple defects on same box
                    label_offset = defect_entries.index((defect_type, defect_display, score)) * 20
                    label = f"{defect_display} | {severity} ({score:.0%})"
                    font_scale = 0.5
                    font_thickness = 1
                    (tw, th_text), baseline = cv2.getTextSize(
                        label, cv2.FONT_HERSHEY_SIMPLEX, font_scale, font_thickness
                    )
                    # Background for label
                    label_y = y1 - label_offset
                    cv2.rectangle(
                        annotated,
                        (x1, label_y - th_text - 8),
                        (x1 + tw + 6, label_y),
                        color,
                        -1,
                    )
                    cv2.putText(
                        annotated,
                        label,
                        (x1 + 3, label_y - 5),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        font_scale,
                        (255, 255, 255),
                        font_thickness,
                    )

            # ----- Display Annotated Image -----
            st.subheader("Analysis Results")
            annotated_rgb = cv2.cvtColor(annotated, cv2.COLOR_BGR2RGB)
            st.image(
                annotated_rgb,
                caption="Annotated detections with defect type and severity",
                use_container_width=True,
            )

            # ----- Summary Cards -----
            col1, col2, col3 = st.columns(3)
            with col1:
                st.metric("Total Defects", len(results))
            with col2:
                st.metric("Violations", len(violations))
            with col3:
                if violations:
                    worst = max(violations, key=lambda r: r["score"])
                    st.metric("Worst Severity", worst["severity"])
                else:
                    st.metric("Worst Severity", "None")

            # ----- Detailed Results Table -----
            st.subheader("Detection Details")
            for i, r in enumerate(results):
                severity_label = {
                    "Low": "[Low]",
                    "Medium": "[Medium]",
                    "High": "[High]",
                    "Critical": "[Critical]",
                }.get(r["severity"], "[--]")

                with st.expander(
                    f"{severity_label} {r['defect_type']} -- {r['severity']} "
                    f"(Score: {r['score']:.1%})",
                    expanded=r["violation"],
                ):
                    col_a, col_b = st.columns(2)
                    with col_a:
                        st.write(f"**Detection class:** {r['class_name']}")
                        st.write(f"**Detection confidence:** {r['confidence']:.1%}")
                        st.write(f"**Defect score:** {r['score']:.3f}")
                        st.write(f"**Severity:** {r['severity']}")
                        st.write(
                            f"**Bounding box:** ({r['bbox'][0]}, {r['bbox'][1]}) "
                            f"to ({r['bbox'][2]}, {r['bbox'][3]})"
                        )
                    with col_b:
                        if r["violation"]:
                            st.error("VIOLATION -- Exceeds severity threshold")
                        else:
                            st.info("Within acceptable limits")

            # ----- Violation Notifications -----
            if violations:
                st.subheader("Violation Notifications")
                for v in violations:
                    # Send simulated notification
                    msg = notifier.send(
                        defect_type=v["defect_type"].lower().replace(" ", "_"),
                        severity=v["severity"],
                        image_name=uploaded_file.name,
                        details=f"Score: {v['score']:.3f}, BBox: {v['bbox']}",
                    )
                    # Log notification in database
                    log_notification(v["id"])

                    st.warning(
                        f"**Notification sent to site supervisor**\n\n"
                        f"**Defect:** {v['defect_type']}  \n"
                        f"**Severity:** {v['severity']} ({v['score']:.1%})  \n"
                        f"**Image:** {uploaded_file.name}"
                    )
            else:
                st.info(
                    "No violations detected -- all defects are below the "
                    f"**{min_violation_severity}** severity threshold."
                )

        # Clean up temp file
        # (keep it during the session for potential re-analysis)

# ===== HISTORY TAB =====
with tab_history:
    st.subheader("Analysis History")
    st.markdown("Recent analysis results from the database.")

    history = get_history(limit=100)

    if not history:
        st.info("No analysis records yet. Upload an image to get started.")
    else:
        # Convert to a display-friendly format
        import pandas as pd

        df = pd.DataFrame(history)

        # Format columns for display
        display_cols = [
            "id",
            "timestamp",
            "image_filename",
            "defect_type",
            "score",
            "severity",
            "is_violation",
            "notification_sent",
        ]
        # Only show columns that exist
        display_cols = [c for c in display_cols if c in df.columns]
        df_display = df[display_cols].copy()

        # Format boolean-like columns
        if "is_violation" in df_display.columns:
            df_display["is_violation"] = df_display["is_violation"].map(
                {1: "Yes", 0: "No"}
            )
        if "notification_sent" in df_display.columns:
            df_display["notification_sent"] = df_display["notification_sent"].map(
                {1: "Yes", 0: "No"}
            )
        if "score" in df_display.columns:
            df_display["score"] = df_display["score"].apply(lambda x: f"{x:.3f}")

        # Rename columns for display
        df_display.columns = [
            "ID",
            "Timestamp",
            "Image",
            "Defect Type",
            "Score",
            "Severity",
            "Violation?",
            "Notified?",
        ]

        st.dataframe(df_display, use_container_width=True, hide_index=True)

        # Summary statistics
        st.markdown("---")
        col1, col2, col3, col4 = st.columns(4)
        with col1:
            st.metric("Total Analyses", len(history))
        with col2:
            violation_count = sum(1 for r in history if r["is_violation"])
            st.metric("Total Violations", violation_count)
        with col3:
            notification_count = sum(1 for r in history if r["notification_sent"])
            st.metric("Notifications Sent", notification_count)
        with col4:
            if history:
                avg_score = sum(r["score"] for r in history) / len(history)
                st.metric("Avg Defect Score", f"{avg_score:.3f}")

        # Clear history button
        st.markdown("---")
        if st.button("Clear History", type="secondary"):
            from db import clear_history

            clear_history()
            st.rerun()
