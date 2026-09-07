"""
db.py — SQLite Database for Construction Quality Control Logging

Provides a simple SQLite-backed logging system to record:
  - Each defect analysis result (type, score, severity, bbox)
  - Whether it triggered a violation
  - Whether a notification was sent

The database file is created in the project root as 'quality_control.db'.
"""

import os
import sqlite3
from datetime import datetime, timezone
from typing import Dict, List, Optional

# Database file path — same directory as this script
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "quality_control.db")

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------
CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS analyses (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp         TEXT NOT NULL,
    image_filename    TEXT NOT NULL,
    defect_type       TEXT NOT NULL,       -- 'rusted_rebar' or 'honeycombed_concrete'
    score             REAL NOT NULL,       -- heuristic score 0.0 – 1.0
    severity          TEXT NOT NULL,       -- 'Low', 'Medium', 'High', 'Critical'
    is_violation      INTEGER NOT NULL DEFAULT 0,   -- 0 or 1
    notification_sent INTEGER NOT NULL DEFAULT 0,   -- 0 or 1
    bbox_x1           INTEGER,
    bbox_y1           INTEGER,
    bbox_x2           INTEGER,
    bbox_y2           INTEGER
);
"""


def _get_connection() -> sqlite3.Connection:
    """Get a connection to the SQLite database."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row  # return rows as dict-like objects
    return conn


def init_db() -> None:
    """
    Initialize the database — create the analyses table if it doesn't exist.
    Safe to call multiple times (idempotent).
    """
    conn = _get_connection()
    try:
        conn.execute(CREATE_TABLE_SQL)
        conn.commit()
    finally:
        conn.close()


def log_analysis(
    image_filename: str,
    defect_type: str,
    score: float,
    severity: str,
    is_violation: bool,
    bbox: Optional[tuple] = None,
) -> int:
    """
    Log a single defect analysis result.

    Parameters
    ----------
    image_filename : str
        Name of the analyzed image file.
    defect_type : str
        Type of defect: 'rusted_rebar' or 'honeycombed_concrete'.
    score : float
        Heuristic score in [0.0, 1.0].
    severity : str
        Severity level: 'Low', 'Medium', 'High', or 'Critical'.
    is_violation : bool
        Whether this defect triggered a violation.
    bbox : tuple, optional
        Bounding box as (x1, y1, x2, y2). None if not available.

    Returns
    -------
    int
        The row ID of the inserted record.
    """
    conn = _get_connection()
    try:
        timestamp = datetime.now(timezone.utc).isoformat()
        bbox_x1, bbox_y1, bbox_x2, bbox_y2 = bbox if bbox else (None, None, None, None)

        cursor = conn.execute(
            """
            INSERT INTO analyses
                (timestamp, image_filename, defect_type, score, severity,
                 is_violation, notification_sent, bbox_x1, bbox_y1, bbox_x2, bbox_y2)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
            """,
            (
                timestamp,
                image_filename,
                defect_type,
                score,
                severity,
                int(is_violation),
                bbox_x1,
                bbox_y1,
                bbox_x2,
                bbox_y2,
            ),
        )
        conn.commit()
        return cursor.lastrowid
    finally:
        conn.close()


def log_notification(analysis_id: int) -> None:
    """
    Mark that a notification was sent for a given analysis record.

    Parameters
    ----------
    analysis_id : int
        The row ID of the analysis record (returned by log_analysis).
    """
    conn = _get_connection()
    try:
        conn.execute(
            "UPDATE analyses SET notification_sent = 1 WHERE id = ?",
            (analysis_id,),
        )
        conn.commit()
    finally:
        conn.close()


def get_history(limit: int = 50) -> List[Dict]:
    """
    Fetch the most recent analysis records.

    Parameters
    ----------
    limit : int
        Maximum number of records to return. Default 50.

    Returns
    -------
    List[Dict]
        List of analysis records as dictionaries, newest first.
    """
    conn = _get_connection()
    try:
        cursor = conn.execute(
            "SELECT * FROM analyses ORDER BY id DESC LIMIT ?",
            (limit,),
        )
        rows = cursor.fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


def clear_history() -> None:
    """Delete all analysis records. Useful for testing."""
    conn = _get_connection()
    try:
        conn.execute("DELETE FROM analyses")
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Auto-initialize on import
# ---------------------------------------------------------------------------
init_db()


# ---------------------------------------------------------------------------
# CLI test
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    print(f"[db] Database path: {DB_PATH}")
    init_db()

    # Insert a test record
    row_id = log_analysis(
        image_filename="test_image.jpg",
        defect_type="rusted_rebar",
        score=0.45,
        severity="High",
        is_violation=True,
        bbox=(100, 200, 300, 400),
    )
    print(f"[db] Inserted test record with id={row_id}")

    # Mark notification
    log_notification(row_id)
    print(f"[db] Marked notification sent for id={row_id}")

    # Fetch history
    history = get_history(limit=5)
    print(f"[db] History ({len(history)} records):")
    for record in history:
        print(f"  {record}")
