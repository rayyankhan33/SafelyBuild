"""
severity.py — Score-to-Severity Mapping for Construction Quality Control

Converts numeric defect scores (from heuristics.py) into human-readable
severity levels and determines whether a violation should be flagged.

Severity Thresholds
-------------------
These thresholds are a proof-of-concept approximation informed by the general
defect severity language in:
  - ACI 201.1R (Guide to Durable Concrete) — which describes surface defects
    in terms of their impact on concrete durability and structural integrity.
  - IS:456 (Indian Standard for Plain and Reinforced Concrete) — which provides
    guidelines on acceptable surface finish quality and reinforcement protection.

These are NOT derived from a specific clause or table in either standard.
They are manually calibrated to produce reasonable severity labels for the
small set of sample images in this project. Production use would require
calibration against domain-expert judgments and field measurements.

Mapping:
    Score Range     Severity    Rationale
    0.00 – 0.15    Low         Minor surface imperfection; cosmetic concern only
    0.15 – 0.35    Medium      Noticeable defect; may affect durability over time
    0.35 – 0.60    High        Significant defect; likely impacts structural durability
    0.60 – 1.00    Critical    Severe defect; immediate remediation recommended
"""

from typing import Tuple

# ---------------------------------------------------------------------------
# Severity levels and thresholds
# ---------------------------------------------------------------------------

# Ordered from least to most severe
SEVERITY_LEVELS = ("Low", "Medium", "High", "Critical")

# Upper bound (exclusive) for each severity level except the last.
# A score of exactly 0.15 is "Medium", 0.35 is "High", etc.
SEVERITY_THRESHOLDS = {
    "Low": 0.15,       # score < 0.15
    "Medium": 0.35,    # 0.15 <= score < 0.35
    "High": 0.60,      # 0.35 <= score < 0.60
    "Critical": 1.01,  # 0.60 <= score <= 1.0
}


def classify_severity(score: float) -> str:
    """
    Map a numeric defect score to a severity level.

    Parameters
    ----------
    score : float
        Defect score in [0.0, 1.0] from heuristics.py.

    Returns
    -------
    str
        One of: "Low", "Medium", "High", "Critical".
    """
    score = max(0.0, min(1.0, score))  # clamp to valid range

    if score < SEVERITY_THRESHOLDS["Low"]:
        return "Low"
    elif score < SEVERITY_THRESHOLDS["Medium"]:
        return "Medium"
    elif score < SEVERITY_THRESHOLDS["High"]:
        return "High"
    else:
        return "Critical"


def is_violation(
    severity: str,
    min_severity: str = "Medium",
) -> bool:
    """
    Determine whether a defect severity constitutes a violation.

    A violation is flagged when the defect severity is at or above the
    configured minimum severity threshold.

    Parameters
    ----------
    severity : str
        The severity level of the defect (from classify_severity).
    min_severity : str
        The minimum severity level that triggers a violation.
        Default is "Medium" — meaning Medium, High, and Critical
        are all flagged as violations.

    Returns
    -------
    bool
        True if the defect should be flagged as a violation.
    """
    try:
        severity_idx = SEVERITY_LEVELS.index(severity)
        min_idx = SEVERITY_LEVELS.index(min_severity)
    except ValueError:
        # Unknown severity level — treat as a violation out of caution
        return True

    return severity_idx >= min_idx


def get_severity_color(severity: str) -> Tuple[int, int, int]:
    """
    Get a BGR color for a severity level (for bounding-box annotation).

    Returns
    -------
    Tuple[int, int, int]
        BGR color tuple.
    """
    colors = {
        "Low": (0, 200, 0),        # green
        "Medium": (0, 220, 220),    # yellow
        "High": (0, 140, 255),      # orange
        "Critical": (0, 0, 255),    # red
    }
    return colors.get(severity, (128, 128, 128))


# ---------------------------------------------------------------------------
# CLI test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    """Quick test of severity mapping across the score range."""
    test_scores = [0.0, 0.05, 0.10, 0.15, 0.20, 0.35, 0.50, 0.60, 0.75, 0.90, 1.0]
    print("Score -> Severity -> Violation (min=Medium)")
    print("-" * 50)
    for s in test_scores:
        sev = classify_severity(s)
        viol = is_violation(sev)
        print(f"  {s:.2f}  ->  {sev:8s}  ->  {'[!] VIOLATION' if viol else 'OK'}")
