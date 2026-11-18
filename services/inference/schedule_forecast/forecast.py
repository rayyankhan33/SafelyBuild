"""
forecast.py - completion forecast from a percent-complete history.

Baseline (explainable, implemented here):
    1. clean the history so progress never goes down                      enforce_monotonic
    2. linear leg: recent pace, extrapolated to 100 %                     windowed_velocity
    3. S-curve leg: logistic fitted to the whole history                  fit_logistic
    4. mix the two legs by how well each predicted the held-out tail      _scurve_weight
    4b. earned-schedule leg when the plan curve is known: PD / SPI(t)     _earned_schedule_leg
    5. approximate 80 % interval from the fit uncertainty                 _linear_leg / _scurve_leg
    6. too little data: plan / SPI if a plan exists, else no number       _fallback

ML refinement is in ml.py; the blend and the orchestrator (forecast_all) are at the end of this file.

Limits, stated plainly: the forecast assumes the future looks like the measured past; the interval
reflects fit uncertainty only (not model-form error); progress that cameras cannot see is invisible here.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Sequence

import numpy as np

from . import models as M
from .models import ForecastInput, ForecastResult, Method, Observation, Status


# ------------------------------------------------------------------------------ cleaning
def enforce_monotonic(observations: Sequence[Observation]) -> tuple[list[Observation], list[str]]:
    """
    Sort by day and replace each value with the running maximum (progress cannot go down).

    Returns (cleaned, flags). A drop larger than MONOTONE_TOLERANCE_PCT adds a human-readable flag, so the
    caller can show that a measurement was overruled instead of hiding it. Values are clipped to 0-100.
    """
    cleaned: list[Observation] = []
    flags: list[str] = []
    high = 0.0
    for o in sorted(observations, key=lambda x: x.day):
        pct = min(100.0, max(0.0, float(o.pct)))
        if high - pct > M.MONOTONE_TOLERANCE_PCT:
            flags.append(f"day {o.day:g}: measured {pct:.1f} % is below the earlier {high:.1f} %; kept {high:.1f} %")
        high = max(high, pct)
        cleaned.append(Observation(float(o.day), high))
    return cleaned, flags


# ------------------------------------------------------------------------------ linear leg
def windowed_velocity(observations: Sequence[Observation], as_of_day: float,
                      window_days: float | None = None) -> tuple[float, float] | None:
    """
    Least-squares pace (percent per day) over the observations in the last `window_days` before `as_of_day`.

    Falls back to the whole history when the window holds fewer than 2 points or spans under MIN_SPAN_DAYS.
    Returns (slope, standard_error), or None when no pace can be measured (fewer than 2 points, zero span).
    With exactly 2 points there are no residuals, so the standard error is taken as half the slope.
    """
    def usable(pts: Sequence[Observation]) -> bool:
        return len(pts) >= 2 and pts[-1].day - pts[0].day >= M.MIN_SPAN_DAYS

    window_days = M.VELOCITY_WINDOW_DAYS if window_days is None else window_days  # read at call time (tunable)
    pts = [o for o in observations if o.day >= as_of_day - window_days]
    if not usable(pts):
        pts = list(observations)
    if len(pts) < 2 or pts[-1].day <= pts[0].day:
        return None
    x = np.array([o.day for o in pts])
    y = np.array([o.pct for o in pts])
    slope, intercept = np.polyfit(x, y, 1)
    if len(pts) == 2:
        return float(slope), abs(float(slope)) * 0.5
    resid = y - (slope * x + intercept)
    sxx = float(np.sum((x - x.mean()) ** 2))
    se = math.sqrt(float(np.sum(resid ** 2)) / (len(pts) - 2) / sxx)
    return float(slope), se


def _linear_leg(obs: Sequence[Observation]) -> dict | None:
    """Finish day (absolute, days since start) by extrapolating the recent pace from the last observation."""
    last = obs[-1]
    vel = windowed_velocity(obs, last.day)
    if vel is None or vel[0] < M.MIN_VELOCITY_PCT_PER_DAY:
        return None
    v, se = vel
    todo = 100.0 - last.pct
    slow = max(v - M.INTERVAL_Z * se, M.MIN_VELOCITY_PCT_PER_DAY)
    return {"finish": last.day + todo / v, "lower": last.day + todo / (v + M.INTERVAL_Z * se),
            "upper": last.day + todo / slow, "velocity": v, "velocity_se": se}


# ------------------------------------------------------------------------------ S-curve leg
@dataclass(frozen=True)
class LogisticFit:
    """p(t) = 100 / (1 + exp(-k (t - t0))). `cov` is the 2x2 parameter covariance, or None if unusable."""

    k: float
    t0: float
    cov: np.ndarray | None

    def predict(self, day):
        return logistic(np.asarray(day, dtype=float), self.k, self.t0)

    @property
    def finish_day(self) -> float:
        return _logistic_finish(self.k, self.t0)


def logistic(t, k: float, t0: float):
    return 100.0 / (1.0 + np.exp(-np.clip(k * (t - t0), -60.0, 60.0)))


def _logistic_finish(k, t0):
    d = M.LOGISTIC_DONE_PCT
    return t0 + math.log(d / (100.0 - d)) / k


def fit_logistic(observations: Sequence[Observation], planned_duration_days: float | None = None) -> LogisticFit | None:
    """
    Fit the two-parameter logistic (asymptote fixed at 100, D5) to the whole history.

    Returns None, never raises, when the data cannot support a curve: fewer than MIN_OBS_SCURVE points,
    progress range under MIN_PCT_RANGE_SCURVE, or the optimiser fails.
    """
    if len(observations) < M.MIN_OBS_SCURVE:
        return None
    x = np.array([o.day for o in observations], dtype=float)
    y = np.array([o.pct for o in observations], dtype=float)
    if y.max() - y.min() < M.MIN_PCT_RANGE_SCURVE:
        return None
    from scipy.optimize import curve_fit  # lazy: the service must start without scipy

    horizon = max(x[-1], planned_duration_days or 0.0, 1.0)
    reached_half = x[y >= 50.0]
    t0_guess = float(reached_half[0]) if len(reached_half) else float(x[-1] * 50.0 / max(y[-1], 1.0))
    t0_guess = min(max(t0_guess, 1.0), 20.0 * horizon)
    try:
        popt, pcov = curve_fit(logistic, x, y, p0=[3.9 / t0_guess, t0_guess],
                               bounds=([1e-4, 0.0], [2.0, 20.0 * horizon]), maxfev=5000)
    except (RuntimeError, ValueError):
        return None
    cov = pcov if np.all(np.isfinite(pcov)) else None
    return LogisticFit(float(popt[0]), float(popt[1]), cov)


def _scurve_leg(obs: Sequence[Observation], planned: float | None) -> dict | None:
    fit = fit_logistic(obs, planned)
    if fit is None:
        return None
    finish = fit.finish_day
    lower, upper = finish * 0.75, finish * 1.25  # used only when the covariance is unusable
    if fit.cov is not None:
        rng = np.random.default_rng(M.INTERVAL_SEED)
        try:
            draws = rng.multivariate_normal([fit.k, fit.t0], fit.cov, size=M.INTERVAL_DRAWS)
        except (ValueError, np.linalg.LinAlgError):
            draws = np.empty((0, 2))
        draws = draws[draws[:, 0] > 1e-5]
        if len(draws) >= 20:
            fin = draws[:, 1] + math.log(M.LOGISTIC_DONE_PCT / (100.0 - M.LOGISTIC_DONE_PCT)) / draws[:, 0]
            lower, upper = (float(q) for q in np.quantile(fin, [0.1, 0.9]))
    return {"finish": finish, "lower": min(lower, finish), "upper": max(upper, finish), "fit": fit}


# ------------------------------------------------------------------------------ earned-schedule leg
class PlanCurve:
    """The baseline plan as a monotone curve: planned percent at a day, and the day a percent was planned for."""

    def __init__(self, points: Sequence[tuple[float, float]]):
        pts = sorted((float(d), float(p)) for d, p in points)
        self.days = np.array([d for d, _ in pts])
        self.pct = np.maximum.accumulate(np.clip([p for _, p in pts], 0.0, 100.0))
        reach = np.flatnonzero(self.pct >= 100.0 - 1e-6)
        self.duration = float(self.days[reach[0]]) if len(reach) else float(self.days[-1])

    @classmethod
    def from_input(cls, inp: ForecastInput) -> "PlanCurve | None":
        if not inp.planned_curve or len(inp.planned_curve) < 2:
            return None
        plan = cls(inp.planned_curve)
        return plan if plan.pct[-1] > 0 and plan.duration > 0 else None

    def pct_at(self, day):
        return np.interp(day, self.days, self.pct)

    def day_for(self, pct: float) -> float:
        """Earned schedule ES: the day by which the plan expected `pct` (first day it is reached)."""
        idx = int(np.searchsorted(self.pct, pct, side="left"))
        if idx <= 0:
            return float(self.days[0])
        if idx >= len(self.pct):
            return self.duration
        p0, p1, d0, d1 = self.pct[idx - 1], self.pct[idx], self.days[idx - 1], self.days[idx]
        return float(d0 if p1 <= p0 else d0 + (pct - p0) / (p1 - p0) * (d1 - d0))


def _spi_t(plan: PlanCurve, o: Observation) -> float | None:
    """Time-based schedule performance index SPI(t) = earned schedule / actual time (Lipke 2003)."""
    if o.day <= 0 or o.pct <= 0:
        return None
    return plan.day_for(o.pct) / o.day


def _earned_schedule_leg(obs: Sequence[Observation], plan: PlanCurve | None) -> dict | None:
    """
    Earned-schedule forecast (Lipke 2003): the rest of the plan is followed at the measured SPI(t), so
    finish = PD / SPI(t). Unlike cost-based SPI, SPI(t) does not drift to 1 near the end, which is why earned
    schedule is preferred for completion dates.

    Range: the earned schedule ES is regressed on time over the recent window; its slope (planned days earned
    per calendar day) +/- z x standard error gives the fastest and slowest plausible finish for the remaining
    planned days. A regression is used because camera progress moves in steps, so SPI(t) of single days jumps.
    """
    if plan is None:
        return None
    last = obs[-1]
    spi = _spi_t(plan, last)
    if not spi or spi <= 0.02:
        return None
    es_now = plan.day_for(last.pct)
    finish = plan.duration / spi
    lower = upper = finish
    window = [o for o in obs if o.day >= last.day - M.VELOCITY_WINDOW_DAYS and o.pct > 0]
    if len(window) >= 3 and window[-1].day > window[0].day:
        es_series = [Observation(o.day, plan.day_for(o.pct)) for o in window]
        rate = windowed_velocity(es_series, last.day, window_days=float("inf"))
        if rate is not None and rate[0] > 0:
            r, se = rate
            todo = max(0.0, plan.duration - es_now)
            fast = r + M.INTERVAL_Z * se
            slow = max(r - M.INTERVAL_Z * se, 0.02)
            lower = min(finish, last.day + todo / fast)
            upper = max(finish, last.day + todo / slow)
    return {"finish": finish, "lower": lower, "upper": upper, "spi_t": spi, "earned_schedule_day": es_now}


# ------------------------------------------------------------------------------ mixing the legs
def _leg_weights(obs: Sequence[Observation], inp: ForecastInput, available: set[str]) -> tuple[dict, dict]:
    """
    D7 (extended): weight of each available leg from its out-of-sample error on the last quarter of the history.

    Every leg is refitted on the earlier observations and asked to predict the held-out progress values:
      linear  last value + recent pace x time;  scurve  the logistic;  earned_schedule  plan at SPI(t) x day.
    Weight is proportional to (mean abs error + 0.5) ** -LEG_WEIGHT_POWER; the S-curve weight is further multiplied by a ramp that
    grows with the number of observations (a curve fitted to few points is not trusted). A leg that cannot be
    tested on the earlier part gets no weight unless no leg can be tested. Returns (weights summing to 1, errors).
    """
    n = len(obs)
    hold = max(1, n // 4)
    train, test = obs[:-hold], obs[-hold:]
    errors: dict = {name: None for name in ("linear", "scurve", "earned_schedule")}
    days = np.array([o.day for o in test])
    truth = np.array([o.pct for o in test])
    if len(train) >= 2:
        vel = windowed_velocity(train, train[-1].day)
        if vel is not None and "linear" in available:
            pred = np.clip(train[-1].pct + vel[0] * (days - train[-1].day), 0.0, 100.0)
            errors["linear"] = float(np.mean(np.abs(pred - truth)))
        if "scurve" in available:
            fit = fit_logistic(train, inp.planned_duration_days)
            if fit is not None:
                errors["scurve"] = float(np.mean(np.abs(fit.predict(days) - truth)))
    if train and "earned_schedule" in available:
        plan = PlanCurve.from_input(inp)
        spi = _spi_t(plan, train[-1]) if plan else None
        if spi:
            errors["earned_schedule"] = float(np.mean(np.abs(plan.pct_at(spi * days) - truth)))
    raw = {name: (errors[name] + 0.5) ** -M.LEG_WEIGHT_POWER for name in available if errors[name] is not None}
    if "scurve" in raw:
        raw["scurve"] *= min(1.0, max(0.0, (n - (M.MIN_OBS_SCURVE - 1)) / 5.0))
    total = sum(raw.values())
    if total <= 0:
        only = sorted(available)
        return {name: 1.0 / len(only) for name in only}, errors
    return {name: v / total for name, v in raw.items() if v > 0}, errors


# ------------------------------------------------------------------------------ SPI and fallback
def schedule_performance_index(pct: float, planned_pct_now: float | None) -> float | None:
    """Earned-value style SPI = measured percent / planned percent. None when the plan expected nothing yet."""
    if planned_pct_now is None or planned_pct_now <= 0:
        return None
    return pct / planned_pct_now


def _fallback(inp: ForecastInput, details: dict, reason: str) -> ForecastResult:
    """D8: too little data for a fit. Use planned duration / SPI when both exist; otherwise give no number."""
    spi = details.get("spi")
    details = {**details, "fit_used": "plan_spi", "fallback_reason": reason}
    if not inp.planned_duration_days or not spi or spi <= 0:
        details["fit_used"] = None
        return ForecastResult(Method.BASELINE, Status.INSUFFICIENT_DATA, details=details)
    remaining = max(0.0, inp.planned_duration_days / spi - inp.elapsed_days) / inp.pace_factor
    return ForecastResult(Method.BASELINE, Status.OK, remaining, remaining * 0.75, remaining * 1.25,
                          details=details).with_dates(inp.as_of)


# ------------------------------------------------------------------------------ baseline
def baseline_forecast(inp: ForecastInput) -> ForecastResult:
    """
    Explainable baseline forecast (decisions D3-D9 in docs/handoff-schedule-assistant.md).

    Never raises on thin or odd data: it returns status insufficient_data or stalled with the reason in
    details["fallback_reason"]. `details` carries every intermediate number the UI needs to explain the result:
    fit_used ("linear" | "scurve" | "earned_schedule" | "blend" | "plan_spi" | None), leg_weights, scurve_weight,
    velocity_pct_per_day, spi, spi_t, earned_schedule_day, curve {k, t0}, linear/scurve/earned_schedule
    _remaining_days, holdout_error, flags, days_vs_plan.
    """
    if inp.pace_factor <= 0:
        raise ValueError("pace_factor must be positive")
    obs, flags = enforce_monotonic(inp.observations)
    details: dict = {"n_observations": len(obs), "flags": flags, "pace_factor": inp.pace_factor,
                     "fallback_reason": None, "spi": None, "curve": None}
    if not obs:
        return _fallback(inp, details, "no observations")
    last = obs[-1]
    spi = schedule_performance_index(last.pct, inp.planned_pct_now)
    details.update(last_pct=round(last.pct, 2), last_day=last.day, spi=None if spi is None else round(spi, 3))

    if last.pct >= M.COMPLETE_PCT:
        return ForecastResult(Method.BASELINE, Status.COMPLETE, 0.0, 0.0, 0.0, details=details).with_dates(inp.as_of)
    if len(obs) < M.MIN_OBS_FORECAST or last.day - obs[0].day < M.MIN_SPAN_DAYS:
        return _fallback(inp, details, f"fewer than {M.MIN_OBS_FORECAST} observations spanning {M.MIN_SPAN_DAYS:g} days")

    plan = PlanCurve.from_input(inp)
    legs = {"linear": _linear_leg(obs), "scurve": _scurve_leg(obs, inp.planned_duration_days),
            "earned_schedule": _earned_schedule_leg(obs, plan)}
    legs = {name: leg for name, leg in legs.items() if leg is not None}
    if not legs:
        details["fallback_reason"] = "no measurable pace in the recent window"
        return ForecastResult(Method.BASELINE, Status.STALLED, details=details)

    w, errors = _leg_weights(obs, inp, set(legs))
    if "earned_schedule" in legs and len(legs) > 1 and M.ES_PRIOR_WEIGHT > 0:
        # D7b: the plan-based leg gets a fixed share (tuned on validation projects); the rest is split by hold-out error
        others = {k: v for k, v in w.items() if k != "earned_schedule"}
        total = sum(others.values())
        w = {"earned_schedule": M.ES_PRIOR_WEIGHT + (1 - M.ES_PRIOR_WEIGHT) * w.get("earned_schedule", 0.0) if total else 1.0,
             **{k: (1 - M.ES_PRIOR_WEIGHT) * v for k, v in others.items()}}
        norm = sum(w.values())
        w = {k: v / norm for k, v in w.items() if v > 0}
    now = inp.elapsed_days

    def mix(key: str) -> float:
        total = sum(w[name] * legs[name][key] for name in w)
        return max(0.0, total - now) / inp.pace_factor

    remaining, lower, upper = mix("finish"), mix("lower"), mix("upper")
    if remaining > M.MAX_REMAINING_DAYS:
        details["fallback_reason"] = "pace too slow to give a meaningful date"
        return ForecastResult(Method.BASELINE, Status.STALLED, details=details)
    k = M.BASELINE_INTERVAL_SCALE
    lower, upper = remaining - k * (remaining - lower), remaining + k * (upper - remaining)
    floor = M.MIN_INTERVAL_FRACTION * remaining
    lower, upper = min(lower, remaining - floor), max(upper, remaining + floor)

    def leg_remaining(name: str) -> float | None:
        leg = legs.get(name)
        return None if leg is None else round(max(0.0, leg["finish"] - now) / inp.pace_factor, 1)

    main = max(w, key=w.get)
    linear, scurve, es = legs.get("linear"), legs.get("scurve"), legs.get("earned_schedule")
    details.update(
        fit_used=main if w[main] >= 0.999 else "blend",
        leg_weights={name: round(v, 3) for name, v in w.items()},
        scurve_weight=round(w.get("scurve", 0.0), 3),
        velocity_pct_per_day=None if linear is None else round(linear["velocity"], 4),
        velocity_se=None if linear is None else round(linear["velocity_se"], 4),
        curve=None if scurve is None else {"k": round(scurve["fit"].k, 5), "t0": round(scurve["fit"].t0, 2)},
        spi_t=None if es is None else round(es["spi_t"], 3),
        earned_schedule_day=None if es is None else round(es["earned_schedule_day"], 1),
        linear_remaining_days=leg_remaining("linear"), scurve_remaining_days=leg_remaining("scurve"),
        earned_schedule_remaining_days=leg_remaining("earned_schedule"),
        holdout_error={k2: (None if v is None else round(v, 2)) for k2, v in errors.items()},
        days_vs_plan=None if not inp.planned_duration_days else round(now + remaining - inp.planned_duration_days, 1),
    )
    return ForecastResult(Method.BASELINE, Status.OK, remaining, max(0.0, lower), upper, details=details).with_dates(inp.as_of)


# ------------------------------------------------------------------------------ blend and orchestration
def blend_forecasts(baseline: ForecastResult, ml: ForecastResult | None, weight: float,
                    fallback_reason: str | None = None, as_of=None) -> ForecastResult:
    """
    D14: final forecast = weight x ML + (1 - weight) x baseline, applied to remaining, lower and upper days.

    ml None or weight 0 -> the baseline's numbers. Baseline without a number -> the blend copies its status and
    gives no number (an ML-only date is never shown as the blend). `as_of` fills the dates.
    """
    weight = 0.0 if ml is None or ml.status is not Status.OK else min(1.0, max(0.0, float(weight)))
    details = {**baseline.details, "ml_weight": weight, "fallback_reason": fallback_reason if weight == 0 else None,
               "baseline_days": baseline.remaining_days, "ml_days": None if ml is None else ml.remaining_days}
    if weight == 0 and not details["fallback_reason"]:
        details["fallback_reason"] = baseline.details.get("fallback_reason")
    if baseline.status is not Status.OK or weight == 0:
        out = replace(baseline, method=Method.BLEND, details=details)
        return out.with_dates(as_of) if as_of is not None and out.remaining_days is not None else out

    def mix(a: float, b: float) -> float:
        return weight * b + (1.0 - weight) * a

    remaining = mix(baseline.remaining_days, ml.remaining_days)
    lower = min(mix(baseline.lower_days, ml.lower_days), remaining)
    upper = max(mix(baseline.upper_days, ml.upper_days), remaining)
    out = ForecastResult(Method.BLEND, Status.OK, remaining, max(0.0, lower), upper, details=details)
    return out.with_dates(as_of) if as_of is not None else out


def forecast_all(inp: ForecastInput, bundle: dict | None = None) -> dict:
    """
    Run every method. Returns {"baseline": ForecastResult, "ml": ForecastResult | None,
    "blend": ForecastResult, "model_version": str | None}.

    `bundle=None` loads the active model (ml.load_bundle); pass `bundle=False` to force baseline only.
    ML is shown whenever a model exists and there are at least MIN_OBS_FORECAST observations, even when its
    blend weight is 0 (the reason is in blend.details["fallback_reason"]).
    """
    from . import ml as mlmod

    baseline = baseline_forecast(inp)
    if bundle is None:
        bundle = mlmod.load_bundle()
    if not bundle:
        blend = replace(baseline, method=Method.BLEND,
                        details={**baseline.details, "ml_weight": 0.0,
                                 "fallback_reason": baseline.details.get("fallback_reason") or "no trained model"})
        return {"baseline": baseline, "ml": None, "blend": blend, "model_version": None}
    features = mlmod.build_features(inp, baseline)
    weight, reason = mlmod.blend_weight(inp, baseline, features, bundle)
    ml_result = mlmod.predict(inp, baseline, bundle) if len(inp.observations) >= M.MIN_OBS_FORECAST else None
    if ml_result is not None and reason:
        ml_result.details["not_used_because"] = reason
    return {"baseline": baseline, "ml": ml_result,
            "blend": blend_forecasts(baseline, ml_result, weight, reason, inp.as_of),
            "model_version": bundle.get("version")}
