"""
ml.py - machine-learning refinement of the baseline forecast (decisions D10-D15 in docs/handoff-schedule-assistant.md).

Three HistGradientBoostingRegressor(loss="quantile") models predict log1p(remaining calendar days) at the
10th, 50th and 90th percentile. HistGradientBoosting is used because it accepts missing values (a project
without a plan has no planned duration or SPI) and trains in seconds on CPU.

THE TRAINING DATA IS SYNTHETIC (synthetic.py). A good score here shows that the pipeline works, not that
the model is accurate on real sites. Every stored forecast carries the model version so this stays traceable.

Retrain:  python train_schedule.py --projects 800 --seed 0 --version 0.1.0   (from services/inference)
"""

from __future__ import annotations

import math
import os
from dataclasses import replace
from datetime import timedelta
from pathlib import Path
from typing import Sequence

import numpy as np

from . import models as M
from .forecast import baseline_forecast, enforce_monotonic, windowed_velocity
from .models import ForecastInput, ForecastResult, Method, Status

MODEL_DIR = Path(__file__).resolve().parents[1] / "models"
MODEL_GLOB = "schedule_gbm_*.joblib"
MODEL_ENV = "SCHEDULE_MODEL"  # file name inside MODEL_DIR; unset = newest matching file
BUCKETS = ((0.0, 25.0), (25.0, 50.0), (50.0, 75.0), (75.0, 100.1))
WEIGHT_GRID = (0.0, 0.25, 0.5, 0.75, 1.0)
GBM_PARAMS = dict(max_iter=300, learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=40, l2_regularization=1.0)

# D11. The order is the column order of every feature matrix. Do not reorder without retraining.
FEATURE_NAMES: tuple[str, ...] = (
    "pct",                    # latest percent complete (after monotone cleaning)
    "elapsed_days",           # calendar days from project start to as_of
    "velocity_recent",        # percent/day, least squares over the last VELOCITY_WINDOW_DAYS
    "velocity_overall",       # pct / day of the latest observation
    "acceleration",           # velocity_recent minus the same measure one window earlier (0 if unknown)
    "velocity_std",           # standard deviation of the pace between consecutive observations
    "planned_duration_days",  # NaN when the project has no plan
    "spi",                    # NaN when unknown
    "floors",                 # NaN when unknown
    "monsoon_next90",         # fraction of the next 90 days that fall in July-September
    "baseline_remaining",     # the baseline's own answer in days (NaN when it has none)
    "evm_remaining",          # planned duration / SPI - elapsed (NaN when there is no plan or SPI)
    "es_remaining",           # earned schedule: planned duration / SPI(t) - elapsed (NaN without a plan curve)
)


def _nan(value) -> float:
    return float("nan") if value is None else float(value)


def evm_remaining(inp: ForecastInput, spi: float | None) -> float | None:
    """The platform's existing earned-value rule in calendar days: planned / SPI - elapsed (never negative)."""
    if not inp.planned_duration_days or not spi or spi <= 0:
        return None
    return max(0.0, inp.planned_duration_days / spi - inp.elapsed_days)


def build_features(inp: ForecastInput, baseline: ForecastResult) -> np.ndarray:
    """
    One feature row in FEATURE_NAMES order (float, NaN = unknown).

    Uses only `inp.observations` (already truncated to "what was known then" by the caller), so the same
    function serves training rows and live requests. `baseline` must be computed with pace_factor 1.
    """
    obs, _ = enforce_monotonic(inp.observations)
    pct = obs[-1].pct if obs else 0.0
    last_day = obs[-1].day if obs else 0.0
    recent = windowed_velocity(obs, last_day) if obs else None
    earlier_obs = [o for o in obs if o.day <= last_day - M.VELOCITY_WINDOW_DAYS]
    earlier = windowed_velocity(earlier_obs, earlier_obs[-1].day) if len(earlier_obs) >= 2 else None
    steps = [(b.pct - a.pct) / (b.day - a.day) for a, b in zip(obs, obs[1:]) if b.day > a.day]
    monsoon = sum((inp.as_of + timedelta(days=d)).month in M.MONSOON_MONTHS for d in range(1, 91)) / 90.0
    spi = baseline.details.get("spi")
    return np.array([
        pct,
        inp.elapsed_days,
        recent[0] if recent else 0.0,
        pct / last_day if last_day > 0 else 0.0,
        recent[0] - earlier[0] if recent and earlier else 0.0,
        float(np.std(steps)) if len(steps) >= 2 else 0.0,
        _nan(inp.planned_duration_days),
        _nan(spi),
        _nan(inp.floors),
        monsoon,
        _nan(baseline.remaining_days if baseline.status is Status.OK else None),
        _nan(evm_remaining(inp, spi)),
        _nan(baseline.details.get("earned_schedule_remaining_days") if baseline.status is Status.OK else None),
    ], dtype=float)


# ----------------------------------------------------------------------------------- dataset
def checkpoints_for(n_observations: int) -> list[int]:
    """D12: at most MAX_ROWS_PER_PROJECT observation counts, evenly spread from MIN_OBS_FORECAST (deterministic)."""
    if n_observations < M.MIN_OBS_FORECAST:
        return []
    raw = np.linspace(M.MIN_OBS_FORECAST, n_observations, M.MAX_ROWS_PER_PROJECT)
    return sorted({int(round(x)) for x in raw})


def collect_rows(projects: Sequence, checkpoints: dict | None = None) -> dict:
    """
    Every (project, checkpoint) row with features, ground truth and the baseline/EVM answers, as arrays.

    `checkpoints` maps project_id -> list of observation counts; default checkpoints_for(len(observations)).
    Rows with true remaining <= 0 are dropped. Keys: X, y_days, project_ids, pct, n_obs, baseline_days,
    baseline_lower, baseline_upper (NaN when the baseline has no number), evm_days.
    """
    from .synthetic import input_at, true_remaining_days

    out = {k: [] for k in ("X", "y_days", "project_ids", "pct", "n_obs", "baseline_days",
                           "baseline_lower", "baseline_upper", "evm_days")}
    for p in projects:
        counts = checkpoints[p.project_id] if checkpoints else checkpoints_for(len(p.observations))
        for n in counts:
            truth = true_remaining_days(p, n)
            if truth <= 0:
                continue
            inp = input_at(p, n)
            base = baseline_forecast(inp)
            x = build_features(inp, base)
            ok = base.status is Status.OK
            out["X"].append(x)
            out["y_days"].append(truth)
            out["project_ids"].append(p.project_id)
            out["pct"].append(x[0])
            out["n_obs"].append(n)
            out["baseline_days"].append(base.remaining_days if ok else np.nan)
            out["baseline_lower"].append(base.lower_days if ok else np.nan)
            out["baseline_upper"].append(base.upper_days if ok else np.nan)
            out["evm_days"].append(x[FEATURE_NAMES.index("evm_remaining")])
    width = len(FEATURE_NAMES)
    return {k: (np.array(v, dtype=float).reshape(-1, width) if k == "X" else np.array(v, dtype=float))
            for k, v in out.items()}


def build_training_rows(projects: Sequence) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(X, y = log1p(true remaining days), project_ids) for synthetic projects, without look-ahead."""
    rows = collect_rows(projects)
    return rows["X"], np.log1p(rows["y_days"]), rows["project_ids"].astype(int)


def split_projects(project_ids: Sequence[int], seed: int = 0) -> tuple[set, set, set]:
    """D13: seeded split of UNIQUE project ids into (train, validation, test) by SPLIT_FRACTIONS."""
    ids = np.array(sorted({int(i) for i in project_ids}))
    rng = np.random.default_rng([seed, 13])
    ids = ids[rng.permutation(len(ids))]
    n_train = int(round(M.SPLIT_FRACTIONS[0] * len(ids)))
    n_val = int(round(M.SPLIT_FRACTIONS[1] * len(ids)))
    return set(ids[:n_train].tolist()), set(ids[n_train:n_train + n_val].tolist()), set(ids[n_train + n_val:].tolist())


# ----------------------------------------------------------------------------------- training
def _bucket(pct: float) -> int:
    for i, (lo, hi) in enumerate(BUCKETS):
        if lo <= pct < hi:
            return i
    return len(BUCKETS) - 1


def _predict_days(models: dict, X: np.ndarray) -> np.ndarray:
    """(rows, 3) remaining days for p10, p50, p90, sorted per row."""
    preds = np.column_stack([np.expm1(models[k].predict(X)) for k in ("p10", "p50", "p90")])
    return np.sort(np.clip(preds, 0.0, None), axis=1)


def _interval_scale(center, lower, upper, truth, target: float = 0.80) -> float:
    """Smallest factor (grid 0.5-6) that widens center +/- (distance to each bound) to `target` coverage."""
    for s in np.arange(0.5, 6.01, 0.05):
        lo = center - s * (center - lower)
        hi = center + s * (upper - center)
        if np.mean((truth >= lo) & (truth <= hi)) >= target:
            return round(float(s), 2)
    return 6.0


def train(projects: Sequence, seed: int = 0, version: str = "0.1.0") -> dict:
    """
    Train the three quantile models on the TRAIN projects; tune blend weights and interval calibration on the
    VALIDATION projects; never touch the test projects. Returns the D15 bundle.
    """
    from sklearn.ensemble import HistGradientBoostingRegressor
    from sklearn.inspection import permutation_importance

    rows = collect_rows(projects)
    ids = rows["project_ids"].astype(int)
    train_ids, val_ids, test_ids = split_projects(ids, seed)
    tr = np.isin(ids, list(train_ids))
    va = np.isin(ids, list(val_ids))
    X, y = rows["X"], np.log1p(rows["y_days"])

    models = {}
    for name, q in zip(("p10", "p50", "p90"), M.QUANTILES):
        m = HistGradientBoostingRegressor(loss="quantile", quantile=q, random_state=seed, **GBM_PARAMS)
        models[name] = m.fit(X[tr], y[tr])

    # validation: ML interval calibration, then blend weight per progress bucket
    pv = _predict_days(models, X[va])
    truth = rows["y_days"][va]
    ml_scale = _interval_scale(pv[:, 1], pv[:, 0], pv[:, 2], truth)
    base = rows["baseline_days"][va]
    ok = ~np.isnan(base)
    base_scale = M.BASELINE_INTERVAL_SCALE * _interval_scale(base[ok], rows["baseline_lower"][va][ok],
                                                             rows["baseline_upper"][va][ok], truth[ok])
    weights = {}
    for b in range(len(BUCKETS)):
        sel = ok & (np.array([_bucket(p) for p in rows["pct"][va]]) == b)
        if sel.sum() < 20:
            weights[str(b)] = M.DEFAULT_ML_WEIGHT
            continue
        maes = [np.mean(np.abs(w * pv[sel, 1] + (1 - w) * base[sel] - truth[sel])) for w in WEIGHT_GRID]
        weights[str(b)] = float(WEIGHT_GRID[int(np.argmin(maes))])

    sample = np.flatnonzero(va)[:3000]
    imp = permutation_importance(models["p50"], X[sample], y[sample], n_repeats=5, random_state=seed,
                                 scoring="neg_mean_absolute_error")
    importance = {n: round(float(v), 5) for n, v in zip(FEATURE_NAMES, imp.importances_mean)}

    finite = np.where(np.isnan(X[tr]), np.nan, X[tr])
    return {
        "version": f"sched-gbm-{version}-seed{seed}",
        "feature_names": list(FEATURE_NAMES),
        "models": models,
        "feature_min": np.nanmin(finite, axis=0).tolist(),
        "feature_max": np.nanmax(finite, axis=0).tolist(),
        "nan_seen": np.isnan(X[tr]).any(axis=0).tolist(),
        "blend_weights": weights,
        "ml_interval_scale": ml_scale,
        "baseline_interval_scale_suggested": round(float(base_scale), 2),
        "feature_importance": importance,
        "split": {"train": sorted(train_ids), "validation": sorted(val_ids), "test": sorted(test_ids)},
        "trained_on": {"n_projects": len(set(ids.tolist())), "n_rows": int(tr.sum()), "seed": seed, "synthetic": True},
    }


def save_bundle(bundle: dict, directory: str | os.PathLike = MODEL_DIR) -> Path:
    """Write the bundle with joblib as schedule_gbm_<version>.joblib in `directory`; return the path."""
    import joblib

    path = Path(directory) / f"schedule_gbm_{bundle['version']}.joblib"
    path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, path, compress=3)
    return path


def load_bundle(path: str | os.PathLike | None = None) -> dict | None:
    """
    Load a trained model bundle (D15), or return None when there is none (the baseline-only state).

    Resolution order: explicit `path`, then MODEL_DIR / $SCHEDULE_MODEL, then the newest MODEL_GLOB file.
    Loaded bundles are cached by path and modification time.
    """
    if path is None:
        name = os.environ.get(MODEL_ENV)
        candidates = [MODEL_DIR / name] if name else sorted(MODEL_DIR.glob(MODEL_GLOB), key=lambda p: p.stat().st_mtime)
        candidates = [c for c in candidates if c.is_file()]
        if not candidates:
            return None
        path = candidates[-1]
    path = Path(path)
    key = (str(path), path.stat().st_mtime)
    if _CACHE.get("key") != key:
        import joblib  # lazy: not needed for the baseline

        _CACHE.update(key=key, bundle=joblib.load(path))
    return _CACHE["bundle"]


_CACHE: dict = {}


# ----------------------------------------------------------------------------------- serving
def in_distribution(features: np.ndarray, bundle: dict) -> bool:
    """D14 range check: each feature within the training range widened by OOD_MARGIN; NaN only if seen in training."""
    lo = np.array(bundle["feature_min"], dtype=float)
    hi = np.array(bundle["feature_max"], dtype=float)
    margin = M.OOD_MARGIN * (hi - lo)
    nan = np.isnan(features)
    if np.any(nan & ~np.array(bundle["nan_seen"], dtype=bool)):
        return False
    f, lo, hi, margin = features[~nan], lo[~nan], hi[~nan], margin[~nan]
    return bool(np.all((f >= lo - margin) & (f <= hi + margin)))


def out_of_range_features(features: np.ndarray, bundle: dict) -> list[str]:
    """Names of the features that fail the range check, for the explanation panel ("floors (missing)")."""
    lo = np.array(bundle["feature_min"], dtype=float)
    hi = np.array(bundle["feature_max"], dtype=float)
    margin = M.OOD_MARGIN * (hi - lo)
    seen = np.array(bundle["nan_seen"], dtype=bool)
    out = []
    for i, name in enumerate(FEATURE_NAMES):
        v = features[i]
        if np.isnan(v):
            if not seen[i]:
                out.append(f"{name} (missing)")
        elif v < lo[i] - margin[i] or v > hi[i] + margin[i]:
            out.append(f"{name} ({v:.3g} outside {lo[i]:.3g}..{hi[i]:.3g})")
    return out


def _unscaled(inp: ForecastInput, baseline: ForecastResult) -> tuple[ForecastInput, ForecastResult]:
    """The model was trained at pace 1: features always use the pace-1 baseline; pace is applied afterwards."""
    if inp.pace_factor == 1.0:
        return inp, baseline
    inp1 = replace(inp, pace_factor=1.0)
    return inp1, baseline_forecast(inp1)


def predict(inp: ForecastInput, baseline: ForecastResult, bundle: dict) -> ForecastResult:
    """ML forecast: P10/P50/P90 remaining days (calibrated on validation), divided by the what-if pace factor."""
    if baseline.status is Status.COMPLETE:
        return ForecastResult(Method.ML, Status.COMPLETE, 0.0, 0.0, 0.0,
                              details={"model_version": bundle["version"]}).with_dates(inp.as_of)
    inp1, base1 = _unscaled(inp, baseline)
    x = build_features(inp1, base1)
    p10, p50, p90 = _predict_days(bundle["models"], x.reshape(1, -1))[0]
    s = bundle.get("ml_interval_scale", 1.0)
    lower, upper = max(0.0, p50 - s * (p50 - p10)), p50 + s * (p90 - p50)
    f = inp.pace_factor
    importance = sorted(bundle.get("feature_importance", {}).items(), key=lambda kv: -kv[1])[:5]
    details = {
        "model_version": bundle["version"],
        "features": {n: (None if math.isnan(v) else round(float(v), 4)) for n, v in zip(FEATURE_NAMES, x)},
        "top_features": [[n, v] for n, v in importance],
        "interval_scale": s,
        "trained_on": bundle.get("trained_on"),
    }
    return ForecastResult(Method.ML, Status.OK, p50 / f, lower / f, upper / f, details=details).with_dates(inp.as_of)


def blend_weight(inp: ForecastInput, baseline: ForecastResult, features: np.ndarray, bundle: dict) -> tuple[float, str | None]:
    """D14: (weight of ML in the blend, reason when it is 0)."""
    if len(inp.observations) < M.MIN_OBS_FORECAST:
        return 0.0, f"fewer than {M.MIN_OBS_FORECAST} observations"
    if baseline.status is not Status.OK:
        return 0.0, baseline.details.get("fallback_reason") or f"baseline status {baseline.status.value}"
    inp1, base1 = _unscaled(inp, baseline)
    x = build_features(inp1, base1) if inp1 is not inp else features
    if not in_distribution(x, bundle):
        return 0.0, "outside the range of the training data: " + ", ".join(out_of_range_features(x, bundle))
    weights = bundle.get("blend_weights") or {}
    return float(weights.get(str(_bucket(float(x[0]))), M.DEFAULT_ML_WEIGHT)), None


# ----------------------------------------------------------------------------------- evaluation
def _first_reaching(project, pct: float) -> int | None:
    """Observation count at which cleaned (running-maximum) progress first reaches `pct`."""
    high = 0.0
    for i, o in enumerate(project.observations):
        high = max(high, o.pct)
        if high >= pct:
            return i + 1
    return None


def _metrics(pred: np.ndarray, truth: np.ndarray, lower=None, upper=None) -> dict:
    ok = ~np.isnan(pred)
    out = {"n": int(ok.sum()), "n_no_forecast": int((~ok).sum())}
    if ok.any():
        err = np.abs(pred[ok] - truth[ok])
        out["mae_days"] = round(float(err.mean()), 1)
        out["median_ae_days"] = round(float(np.median(err)), 1)
        out["mape_pct"] = round(float(np.mean(err / np.maximum(truth[ok], 1.0)) * 100), 1)
        out["bias_days"] = round(float(np.mean(pred[ok] - truth[ok])), 1)
        if lower is not None:
            inside = (truth[ok] >= lower[ok]) & (truth[ok] <= upper[ok])
            out["interval_coverage"] = round(float(inside.mean()), 3)
    return out


def evaluate(projects: Sequence, bundle: dict | None, checkpoints: Sequence[float] = (20, 40, 60, 80)) -> dict:
    """
    Honest evaluation on HELD-OUT projects (docs/handoff-schedule-assistant.md section 7). `projects` must be the test split only.

    For each project and checkpoint c the forecast is made at the first observation where cleaned progress
    reaches c, and compared with the true remaining days, for baseline, ML, blend, the plain EVM rule
    (planned / SPI) and the earned-schedule leg on its own (planned / SPI(t)).
    """
    from .forecast import forecast_all
    from .synthetic import input_at, true_remaining_days

    report: dict = {"n_projects": len(projects), "model_version": bundle["version"] if bundle else None}
    for c in checkpoints:
        cols = {k: [] for k in ("truth", "baseline", "b_lo", "b_hi", "ml", "m_lo", "m_hi", "blend", "x_lo", "x_hi", "evm", "es")}
        for p in projects:
            n = _first_reaching(p, c)
            if n is None or true_remaining_days(p, n) <= 0:
                continue
            inp = input_at(p, n)
            res = forecast_all(inp, bundle=bundle) if bundle else {"baseline": baseline_forecast(inp), "ml": None, "blend": None}
            cols["truth"].append(true_remaining_days(p, n))
            for key, short in (("baseline", "b"), ("ml", "m"), ("blend", "x")):
                r = res.get(key)
                good = r is not None and r.status is Status.OK
                cols[key].append(r.remaining_days if good else np.nan)
                cols[f"{short}_lo"].append(r.lower_days if good else np.nan)
                cols[f"{short}_hi"].append(r.upper_days if good else np.nan)
            spi = res["baseline"].details.get("spi")
            cols["evm"].append(_nan(evm_remaining(inp, spi)))
            cols["es"].append(_nan(res["baseline"].details.get("earned_schedule_remaining_days")))
        a = {k: np.array(v, dtype=float) for k, v in cols.items()}
        report[str(int(c))] = {
            "n_projects": len(a["truth"]),
            "baseline": _metrics(a["baseline"], a["truth"], a["b_lo"], a["b_hi"]),
            "ml": _metrics(a["ml"], a["truth"], a["m_lo"], a["m_hi"]),
            "blend": _metrics(a["blend"], a["truth"], a["x_lo"], a["x_hi"]),
            "evm": _metrics(a["evm"], a["truth"]),
            "earned_schedule": _metrics(a["es"], a["truth"]),
        }
    return report
