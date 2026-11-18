"""Tests of the synthetic dataset, the ML refinement, the blend and the fallback rules (HANDOFF.md T2-T6)."""
import pathlib
import sys
from dataclasses import replace
from datetime import date, timedelta

import numpy as np
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from schedule_forecast import forecast as F  # noqa: E402
from schedule_forecast import ml, synthetic  # noqa: E402
from schedule_forecast import models as M  # noqa: E402
from schedule_forecast.models import ForecastInput, ForecastResult, Method, Observation, Status  # noqa: E402


@pytest.fixture(scope="module")
def small():
    """A small dataset and a model trained on it (fast; quality is not tested here)."""
    projects = synthetic.generate_dataset(40, seed=3)
    return projects, ml.train(projects, seed=3, version="test")


def test_dataset_reproducible_and_varied():
    a, b = synthetic.generate_dataset(30, seed=5), synthetic.generate_dataset(30, seed=5)
    assert all(np.array_equal(x.true_pct, y.true_pct) and x.observations == y.observations for x, y in zip(a, b))
    assert synthetic.generate_dataset(30, seed=6)[0].observations != a[0].observations
    assert len({p.floors for p in a}) >= 6 and len({p.start_date.month for p in a}) >= 8
    assert len({p.params.obs_step for p in a}) == 3 and len({round(p.params.mean_photo_gap) for p in a}) >= 5
    # the reference project is unchanged by the dataset options
    assert synthetic.generate_project(7, 3).params == synthetic.SimParams()
    steps = [p for p in a if p.params.obs_step == 5.0 and p.params.obs_noise_sd < 1.0]
    if steps:  # quantised observations sit near multiples of the step
        frac = [o.pct % 5.0 for o in steps[0].observations if 0 < o.pct < 100]
        assert np.median(np.minimum(frac, 5.0 - np.array(frac))) < 1.5


def test_split_is_by_whole_project_and_seeded():
    ids = list(range(100)) * 3
    tr, va, te = ml.split_projects(ids, seed=1)
    assert not (tr & va or tr & te or va & te) and tr | va | te == set(range(100))
    assert (len(tr), len(va), len(te)) == (70, 15, 15)
    assert ml.split_projects(ids, seed=1) == (tr, va, te) and ml.split_projects(ids, seed=2) != (tr, va, te)


def test_training_rows_have_no_look_ahead():
    p = synthetic.generate_project(11, 0)
    X, y, ids = ml.build_training_rows([p])
    assert len(X) <= M.MAX_ROWS_PER_PROJECT and X.shape[1] == len(ml.FEATURE_NAMES) and set(ids) == {0}
    # appending later observations does not change the rows built from the earlier ones
    longer = replace(p, observations=p.observations + [Observation(p.completion_day + 5.0, 100.0)])
    counts = {0: ml.checkpoints_for(len(p.observations))}
    r1, r2 = ml.collect_rows([p], counts), ml.collect_rows([longer], counts)
    assert np.allclose(r1["X"], r2["X"], equal_nan=True) and np.allclose(r1["y_days"], r2["y_days"])
    assert np.all(r1["y_days"] > 0)


def test_bundle_round_trip_and_keys(small, tmp_path):
    projects, bundle = small
    for key in ("version", "feature_names", "models", "feature_min", "feature_max", "nan_seen", "blend_weights",
                "ml_interval_scale", "feature_importance", "trained_on", "split"):
        assert key in bundle
    assert bundle["trained_on"]["synthetic"] is True and bundle["version"] == "sched-gbm-test-seed3"
    assert not set(bundle["split"]["test"]) & set(bundle["split"]["train"])
    path = ml.save_bundle(bundle, tmp_path)
    again = ml.load_bundle(path)
    X, _, _ = ml.build_training_rows(projects[:3])
    for k in ("p10", "p50", "p90"):
        assert np.allclose(bundle["models"][k].predict(X), again["models"][k].predict(X))


def test_ml_prediction_is_ordered_and_scaled_by_pace(small):
    projects, bundle = small
    inp = synthetic.input_at(projects[0], 15)
    base = F.baseline_forecast(inp)
    res = ml.predict(inp, base, bundle)
    assert res.method is Method.ML and res.status is Status.OK
    assert 0 <= res.lower_days <= res.remaining_days <= res.upper_days
    assert res.details["model_version"] == bundle["version"] and len(res.details["top_features"]) == 5
    fast = ml.predict(replace(inp, pace_factor=1.25), F.baseline_forecast(replace(inp, pace_factor=1.25)), bundle)
    assert fast.remaining_days == pytest.approx(res.remaining_days / 1.25)


def _result(days, lo, hi, status=Status.OK):
    return ForecastResult(Method.BASELINE, status, days, lo, hi, details={"fallback_reason": None})


def test_blend_rule():
    base, mlr = _result(100.0, 80.0, 130.0), replace(_result(60.0, 50.0, 90.0), method=Method.ML)
    as_of = date(2026, 1, 1)
    assert F.blend_forecasts(base, mlr, 0.0, "x", as_of).remaining_days == 100.0
    assert F.blend_forecasts(base, None, 0.7, None, as_of).remaining_days == 100.0
    one = F.blend_forecasts(base, mlr, 1.0, None, as_of)
    assert (one.remaining_days, one.lower_days, one.upper_days) == (60.0, 50.0, 90.0)
    half = F.blend_forecasts(base, mlr, 0.5, None, as_of)
    assert (half.remaining_days, half.lower_days, half.upper_days) == (80.0, 65.0, 110.0)
    assert half.method is Method.BLEND and half.completion_date == as_of + timedelta(days=80)
    assert half.details["ml_weight"] == 0.5
    insufficient = F.blend_forecasts(_result(None, None, None, Status.INSUFFICIENT_DATA), mlr, 0.5, None, as_of)
    assert insufficient.status is Status.INSUFFICIENT_DATA and insufficient.remaining_days is None


def test_fallbacks_few_observations_and_out_of_distribution(small):
    projects, bundle = small
    two = synthetic.input_at(projects[0], 2)
    out = F.forecast_all(two, bundle=bundle)
    assert out["ml"] is None and out["blend"].details["ml_weight"] == 0.0
    assert out["blend"].remaining_days == out["baseline"].remaining_days and out["blend"].details["fallback_reason"]

    inp = synthetic.input_at(projects[0], 15)
    weird = replace(inp, floors=150)  # far outside the 1-10 floors of the training data
    out = F.forecast_all(weird, bundle=bundle)
    assert out["blend"].details["ml_weight"] == 0.0 and "floors" in out["blend"].details["fallback_reason"]
    assert out["blend"].remaining_days == pytest.approx(out["baseline"].remaining_days)
    assert out["ml"] is not None and "not_used_because" in out["ml"].details

    normal = F.forecast_all(inp, bundle=bundle)
    assert normal["model_version"] == bundle["version"]
    lo, hi = sorted([normal["baseline"].remaining_days, normal["ml"].remaining_days])
    assert lo - 1e-6 <= normal["blend"].remaining_days <= hi + 1e-6


def test_forecast_all_without_a_model():
    inp = synthetic.input_at(synthetic.generate_project(2, 1), 12)
    out = F.forecast_all(inp, bundle=False)
    assert out["ml"] is None and out["model_version"] is None
    assert out["blend"].remaining_days == out["baseline"].remaining_days
    assert out["blend"].details["fallback_reason"] == "no trained model"


def test_earned_schedule_leg_follows_the_plan():
    # plan: linear 0 -> 100 % over 200 days; the project runs at 80 % of planned pace
    plan = tuple((float(d), d / 2.0) for d in range(0, 201, 10))
    obs = tuple(Observation(float(d), 0.4 * d) for d in range(10, 101, 10))
    inp = ForecastInput(date(2026, 1, 1), date(2026, 1, 1) + timedelta(days=100), obs, 200.0, 50.0, planned_curve=plan)
    res = F.baseline_forecast(inp)
    assert res.details["spi_t"] == pytest.approx(0.8)
    assert res.details["earned_schedule_remaining_days"] == pytest.approx(200 / 0.8 - 100, abs=0.5)
    assert res.details["leg_weights"]["earned_schedule"] >= M.ES_PRIOR_WEIGHT - 1e-9


def test_evaluate_reports_every_method(small):
    projects, bundle = small
    test = [p for p in projects if p.project_id in set(bundle["split"]["test"])]
    rep = ml.evaluate(test, bundle, checkpoints=(40,))
    assert set(rep["40"]) >= {"baseline", "ml", "blend", "evm", "earned_schedule", "n_projects"}
    assert rep["40"]["baseline"]["n"] + rep["40"]["baseline"]["n_no_forecast"] == rep["40"]["n_projects"]


def test_shipped_model_loads_and_is_used():
    bundle = ml.load_bundle()
    if bundle is None:
        pytest.skip("no trained model in models/")
    assert list(bundle["feature_names"]) == list(ml.FEATURE_NAMES), "retrain: features changed"
    out = F.forecast_all(synthetic.input_at(synthetic.generate_project(9, 4), 20))
    assert out["model_version"] == bundle["version"] and out["ml"] is not None
