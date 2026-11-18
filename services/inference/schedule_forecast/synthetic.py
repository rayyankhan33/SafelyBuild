"""
synthetic.py - seeded synthetic construction projects for training and evaluating the schedule forecast.

There is no real project history, so this file INVENTS it. Every number below is an assumption chosen to
be plausible for a low-rise reinforced-concrete building in Pakistan. None is fitted to data.

Assumptions
    A1  Size: 1-10 floors. Planned duration = 120 + 45 x floors calendar days, +/- 15 %.
    A2  Shape: work passes through the phases of models.PHASES (substructure, frame, envelope, finishing),
        each with its own relative pace. The result is S-shaped but is NOT a logistic curve, so the
        logistic baseline is not being tested on its own functional form.
    A3  The plan: same phases, Sundays off, no disruptions; reaches 100 % on the planned duration.
    A4  Efficiency: each project starts at a multiple of planned pace, lognormal(mean -0.10, sd 0.20), so most
        projects finish late, as real ones do.
    A5  Day-to-day variation: multiplicative lognormal noise, sd 0.15.
    A6  Monsoon (July-September): pace x 0.75 and a 25 % chance per day of a full rain stop.
    A7  Eid al-Fitr and Eid al-Adha: no work from 1 day before to 3 days after the (approximate) date.
        Sundays: no work.
    A8  Stalls (material or labour shortage): each working day has a small chance (default 0.4 %) of starting
        a stall of 5-20 days at 10 % pace.
    A9  Observations: first photo 3-14 days after the start, then irregular gaps (1 + geometric, default mean
        6 days). Measured percent = true percent + normal noise (default sd 2 points), clipped to 0-100. They
        are NOT forced to be monotone: the forecaster's cleaning step has to handle that.
    A10 Step quantisation (optional): the real platform's progress moves in steps when a stage is confirmed
        (apps/api/src/domain/stages.js). With `obs_step` > 0 the measured value is the true value rounded down
        to a multiple of `obs_step` before noise is added.
    A11 Efficiency drift (optional): with `drift_sd` > 0 the log-efficiency takes a weekly random step
        normal(0, drift_sd), pulled 10 % back towards its starting value each week (crews change, management
        improves or slips). Without drift, every project keeps one efficiency for its whole life, which is
        exactly the assumption of the earned-value rule (planned duration / SPI) and so favours it.
    A12 Dataset variation (generate_dataset): per project, stall chance 0-1 %, mean photo gap 1-14 days
        (the platform's cameras report almost daily),
        observation noise sd 0.5-4 points, step 0 / 2.5 / 5 points (each a third), drift sd 0-0.08.
    A13 Unknown floor count: for every third project (project_id % 3 == 0) the forecast input has no floor count,
        because the platform's BOQ does not record one. The model must work without it.

generate_project with default parameters reproduces the original single-project reference generator.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import date, timedelta

import numpy as np

from . import models as M
from .models import ForecastInput, Observation

MONSOON_PACE = 0.75
RAIN_STOP_PROB = 0.25
STALL_START_PROB = 0.004
STALL_DAYS = (5, 20)
STALL_PACE = 0.10
DAILY_NOISE_SD = 0.15
OBS_NOISE_SD = 2.0
MEAN_PHOTO_GAP_DAYS = 6.0
EFFICIENCY_LOG_MEAN, EFFICIENCY_LOG_SD = -0.10, 0.20
DRIFT_PULL = 0.10           # A11: weekly pull of log-efficiency back to its start value
MAX_DURATION_FACTOR = 10    # simulation stops at 10x the plan

# A12 ranges sampled by generate_dataset
DATASET_STALL_PROB = (0.0, 0.01)
DATASET_PHOTO_GAP = (1.0, 14.0)
DATASET_OBS_NOISE = (0.5, 4.0)
DATASET_OBS_STEPS = (0.0, 2.5, 5.0)
DATASET_DRIFT_SD = (0.0, 0.08)

# Approximate dates (the real ones depend on moon sighting). Extend when simulating outside 2023-2029.
EID_DATES = tuple(date.fromisoformat(d) for d in (
    "2023-04-22", "2023-06-29", "2024-04-10", "2024-06-17", "2025-03-31", "2025-06-07",
    "2026-03-20", "2026-05-27", "2027-03-10", "2027-05-17", "2028-02-27", "2028-05-05",
    "2029-02-15", "2029-04-24"))
_EID_OFF = frozenset(d + timedelta(days=k) for d in EID_DATES for k in range(-1, 4))


@dataclass(frozen=True)
class SimParams:
    """Per-project disturbance and measurement settings (A8, A9, A10, A11). Defaults = reference generator."""

    stall_prob: float = STALL_START_PROB
    mean_photo_gap: float = MEAN_PHOTO_GAP_DAYS
    obs_noise_sd: float = OBS_NOISE_SD
    obs_step: float = 0.0
    drift_sd: float = 0.0
    hide_floors: bool = False   # A13


@dataclass
class SyntheticProject:
    """One simulated project. `true_pct[d]` and `planned_pct[d]` are percent complete at the end of day d."""

    project_id: int
    start_date: date
    planned_duration_days: int
    floors: int
    efficiency: float
    true_pct: np.ndarray
    planned_pct: np.ndarray
    completion_day: int               # first day true_pct reaches 100
    observations: list[Observation]   # noisy, irregular, what the cameras would report
    events: list[dict]                # stalls, for inspection: {"type", "start_day", "days"}
    params: SimParams = field(default_factory=SimParams)


def _phase_pace(pct: float) -> float:
    done = 0.0
    for _, share, pace in M.PHASES:
        done += share
        if pct < done:
            return pace
    return M.PHASES[-1][2]


def _simulate(start: date, planned_days: int, efficiency: float, rng: np.random.Generator | None,
              params: SimParams = SimParams()) -> tuple[np.ndarray, list[dict]]:
    """Daily simulation. rng=None gives the undisturbed plan (A3). Returns (cumulative percent per day, events)."""
    # base rate so that the undisturbed plan takes `planned_days` with Sundays off
    base = sum(share / pace for _, share, pace in M.PHASES) / (planned_days * 6.0 / 7.0)
    curve, events = [0.0], []
    pct, stall_left = 0.0, 0
    log_eff0 = float(np.log(efficiency))
    log_eff = log_eff0
    for d in range(1, planned_days * MAX_DURATION_FACTOR + 1):
        day = start + timedelta(days=d)
        if rng is not None and params.drift_sd > 0 and d % 7 == 0:
            log_eff += float(rng.normal(0.0, params.drift_sd)) - DRIFT_PULL * (log_eff - log_eff0)
        rate = base * _phase_pace(pct) * float(np.exp(log_eff))
        if day.weekday() == 6:
            rate = 0.0
        elif rng is not None:
            if day in _EID_OFF:
                rate = 0.0
            else:
                if stall_left == 0 and rng.random() < params.stall_prob:
                    stall_left = int(rng.integers(STALL_DAYS[0], STALL_DAYS[1] + 1))
                    events.append({"type": "stall", "start_day": d, "days": stall_left})
                if stall_left > 0:
                    rate *= STALL_PACE
                    stall_left -= 1
                if day.month in M.MONSOON_MONTHS:
                    rate *= 0.0 if rng.random() < RAIN_STOP_PROB else MONSOON_PACE
                rate *= float(rng.lognormal(0.0, DAILY_NOISE_SD))
        pct = min(100.0, pct + rate)
        curve.append(pct)
        if pct >= 100.0:
            break
    return np.array(curve), events


def generate_project(seed: int, project_id: int = 0, *, start_date: date | None = None,
                     floors: int | None = None, efficiency: float | None = None,
                     params: SimParams | None = None) -> SyntheticProject:
    """
    Simulate one project. The same arguments always give the same project (numpy Generator seeded with
    [seed, project_id]). Keyword arguments pin a property instead of sampling it (used for showcase projects:
    efficiency 1.0 on track, 0.7 delayed, 1.2 ahead).
    """
    params = params or SimParams()
    rng = np.random.default_rng([seed, project_id])
    # sample in a fixed order even when a value is pinned, so pinning one property does not shift the others
    sampled_floors = int(rng.integers(1, 11))
    sampled_start = date(2023, 1, 1) + timedelta(days=int(rng.integers(0, 3 * 365)))
    sampled_eff = float(rng.lognormal(EFFICIENCY_LOG_MEAN, EFFICIENCY_LOG_SD))
    duration_noise = float(rng.uniform(0.85, 1.15))
    floors = sampled_floors if floors is None else floors
    start_date = sampled_start if start_date is None else start_date
    efficiency = sampled_eff if efficiency is None else efficiency
    planned_days = int(round((120 + 45 * floors) * duration_noise))

    planned, _ = _simulate(start_date, planned_days, 1.0, None)
    true, events = _simulate(start_date, planned_days, efficiency, rng, params)
    completion_day = len(true) - 1

    observations, d = [], int(rng.integers(3, 15))
    while d <= completion_day:
        value = float(true[d])
        if params.obs_step > 0:
            value = np.floor(value / params.obs_step) * params.obs_step
        measured = float(np.clip(value + rng.normal(0.0, params.obs_noise_sd), 0.0, 100.0))
        observations.append(Observation(float(d), round(measured, 2)))
        d += 1 + int(rng.geometric(1.0 / params.mean_photo_gap))
    return SyntheticProject(project_id, start_date, planned_days, floors, efficiency, true, planned,
                            completion_day, observations, events, params)


def input_at(project: SyntheticProject, n_obs: int) -> ForecastInput:
    """The forecast input as it stood when only the first `n_obs` observations existed (no look-ahead)."""
    known = tuple(project.observations[:n_obs])
    day = int(known[-1].day) if known else 0
    planned_now = float(project.planned_pct[min(day, len(project.planned_pct) - 1)])
    floors = None if project.params.hide_floors else project.floors
    return ForecastInput(project.start_date, project.start_date + timedelta(days=day), known,
                         float(project.planned_duration_days), planned_now, floors,
                         planned_curve=plan_points(project))


def plan_points(project: SyntheticProject, step: int = 7) -> tuple[tuple[float, float], ...]:
    """The plan curve sampled weekly plus its last day: what the platform sends as `planned_curve`."""
    days = list(range(0, len(project.planned_pct), step)) + [len(project.planned_pct) - 1]
    return tuple((float(d), round(float(project.planned_pct[d]), 3)) for d in sorted(set(days)))


def true_remaining_days(project: SyntheticProject, n_obs: int) -> float:
    """Ground truth for input_at(project, n_obs): calendar days from that observation to real completion."""
    day = project.observations[n_obs - 1].day if n_obs else 0.0
    return float(project.completion_day - day)


def sample_params(seed: int, project_id: int) -> SimParams:
    """A12: the per-project variation used by generate_dataset (own random stream, so it never shifts A1-A9)."""
    rng = np.random.default_rng([seed, project_id, 1])
    return SimParams(
        stall_prob=float(rng.uniform(*DATASET_STALL_PROB)),
        mean_photo_gap=float(rng.uniform(*DATASET_PHOTO_GAP)),
        obs_noise_sd=float(rng.uniform(*DATASET_OBS_NOISE)),
        obs_step=float(DATASET_OBS_STEPS[int(rng.integers(0, len(DATASET_OBS_STEPS)))]),
        drift_sd=float(rng.uniform(*DATASET_DRIFT_SD)),
        hide_floors=project_id % 3 == 0,
    )


def generate_dataset(n_projects: int = 800, seed: int = 0, *, drift: bool = True) -> list[SyntheticProject]:
    """
    `n_projects` varied, reproducible projects (A12). `drift=False` turns efficiency drift (A11) off for every
    project, which gives the "constant efficiency" world used to show how much the generator favours EVM.
    """
    projects = []
    for i in range(n_projects):
        params = sample_params(seed, i)
        if not drift:
            params = replace(params, drift_sd=0.0)
        projects.append(generate_project(seed, i, params=params))
    return projects
