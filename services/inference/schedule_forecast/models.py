"""
models.py - data classes and constants shared by the schedule forecast modules.

Every number that shapes a forecast is a named constant here, so it can be tuned in one place and
quoted in the report. Decision ids (D3, D7, ...) refer to HANDOFF.md section 2.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import date, timedelta
from enum import Enum
from typing import Mapping

# --- baseline thresholds -------------------------------------------------------------------------
MIN_OBS_FORECAST = 3            # D8: fewer observations => plan-based fallback or no forecast
MIN_SPAN_DAYS = 3.0             # D8: observations must span at least this many days
VELOCITY_WINDOW_DAYS = 42.0     # D4: "recent" window for the linear leg
MIN_VELOCITY_PCT_PER_DAY = 0.01  # slower than this is reported as stalled, not as a date centuries away
MIN_OBS_SCURVE = 5              # D6
MIN_PCT_RANGE_SCURVE = 15.0     # D6: progress must have moved this many points before a curve is fitted
ES_PRIOR_WEIGHT = 0.85          # D7b: fixed minimum share of the earned-schedule leg when a plan curve exists (tuned on validation)
LEG_WEIGHT_POWER = 1.0          # D7: sharpness of the inverse-error weighting of the baseline legs (tuned on validation)
LOGISTIC_DONE_PCT = 98.0        # D5: a logistic never reaches 100; this level counts as finished
COMPLETE_PCT = 99.5             # at or above this the project is treated as complete
MONOTONE_TOLERANCE_PCT = 2.0    # D3: a drop larger than this is flagged
INTERVAL_Z = 1.2816             # D9: z for a two-sided 80 % interval
INTERVAL_DRAWS = 200            # D9: parameter draws for the S-curve interval
INTERVAL_SEED = 0               # D9: fixed so the same inputs always give the same interval
MIN_INTERVAL_FRACTION = 0.10    # D9: the interval is never narrower than +/- 10 % of remaining days
BASELINE_INTERVAL_SCALE = 2.7    # D9: widens the fit-based interval to ~80 % coverage; calibrated on VALIDATION projects by train_schedule.py
MAX_REMAINING_DAYS = 3650.0     # anything beyond ten years is reported as stalled

# --- ML / blend ----------------------------------------------------------------------------------
QUANTILES = (0.1, 0.5, 0.9)     # D10
DEFAULT_ML_WEIGHT = 0.5         # D14: until validation-tuned weights exist in the model bundle
OOD_MARGIN = 0.10               # D14: training range is widened by this fraction before the range check
MAX_ROWS_PER_PROJECT = 12       # D12
SPLIT_FRACTIONS = (0.70, 0.15, 0.15)  # D13: train / validation / test, by whole project
MONSOON_MONTHS = (7, 8, 9)

# --- work phases (D2): used by the synthetic generator only ---------------------------------------
# (name, share of total work in percent points, relative pace: > 1 is faster than the project average)
PHASES: tuple[tuple[str, float, float], ...] = (
    ("substructure", 15.0, 0.70),   # excavation, footings: slow start
    ("frame", 35.0, 1.25),          # columns, beams, slabs: fastest, repetitive floor cycle
    ("envelope", 20.0, 1.10),       # masonry, roofing
    ("finishing", 30.0, 0.75),      # plaster, services, fit-out: slow finish
)

# --- optional rework heuristic (D19), off by default ----------------------------------------------
REWORK_DAYS_PER_VIOLATION: Mapping[str, float] = {"High": 1.5, "Critical": 4.0}


class Method(str, Enum):
    BASELINE = "baseline"
    ML = "ml"
    BLEND = "blend"


class Status(str, Enum):
    OK = "ok"
    INSUFFICIENT_DATA = "insufficient_data"
    STALLED = "stalled"
    COMPLETE = "complete"


@dataclass(frozen=True)
class Observation:
    """One measured point: `pct` percent complete (0-100) on calendar day `day` after the project start."""

    day: float
    pct: float


@dataclass(frozen=True)
class ForecastInput:
    """Everything a forecast may use. Only `start_date`, `as_of` and `observations` are required."""

    start_date: date
    as_of: date
    observations: tuple[Observation, ...]
    planned_duration_days: float | None = None  # calendar days from start to planned finish
    planned_pct_now: float | None = None        # percent the plan expected by `as_of` (PV / BAC x 100)
    floors: int | None = None
    pace_factor: float = 1.0                    # D18 what-if: 1.2 = future pace 20 % faster
    planned_curve: tuple[tuple[float, float], ...] | None = None  # (day, planned percent) points of the baseline plan, sorted

    @property
    def elapsed_days(self) -> float:
        return float((self.as_of - self.start_date).days)


@dataclass
class ForecastResult:
    """One method's answer. Day counts are from `as_of`; they are None unless status is ok or complete."""

    method: Method
    status: Status
    remaining_days: float | None = None
    lower_days: float | None = None
    upper_days: float | None = None
    completion_date: date | None = None
    lower_date: date | None = None
    upper_date: date | None = None
    details: dict = field(default_factory=dict)

    def with_dates(self, as_of: date) -> "ForecastResult":
        """Fill the three dates from the three day counts."""
        def to_date(days: float | None) -> date | None:
            return None if days is None else as_of + timedelta(days=round(days))
        self.completion_date = to_date(self.remaining_days)
        self.lower_date = to_date(self.lower_days)
        self.upper_date = to_date(self.upper_days)
        return self

    def to_dict(self) -> dict:
        out = asdict(self)
        out["method"] = self.method.value
        out["status"] = self.status.value
        for key in ("remaining_days", "lower_days", "upper_days"):
            if out[key] is not None:
                out[key] = round(float(out[key]), 1)
        for key in ("completion_date", "lower_date", "upper_date"):
            if out[key] is not None:
                out[key] = out[key].isoformat()
        return out


def rework_delay_days(open_violations: Mapping[str, int]) -> float:
    """
    Heuristic extra days of rework for unresolved violations (D19). NOT a measurement: the per-violation
    days are assumptions. Shown as a separate risk line; never added into a forecast silently.

    `open_violations` maps a severity name ("High", "Critical") to a count; other severities count as 0.
    """
    return float(sum(REWORK_DAYS_PER_VIOLATION.get(sev, 0.0) * max(0, n) for sev, n in open_violations.items()))
