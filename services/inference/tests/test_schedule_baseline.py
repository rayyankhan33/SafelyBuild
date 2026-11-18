"""Tests of the schedule-forecast baseline, the synthetic reference generator and the HTTP endpoint."""
import pathlib
import sys
from datetime import date, timedelta

import numpy as np
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from schedule_forecast import forecast as F  # noqa: E402
from schedule_forecast import ml, synthetic  # noqa: E402
from schedule_forecast import models as M  # noqa: E402
from schedule_forecast.models import ForecastInput, Observation, Status  # noqa: E402

START = date(2026, 1, 5)


def make_input(points, as_of_day=None, **kw):
    obs = tuple(Observation(d, p) for d, p in points)
    day = as_of_day if as_of_day is not None else max(d for d, _ in points)
    return ForecastInput(START, START + timedelta(days=int(day)), obs, **kw)


def test_linear_progress_is_extrapolated_exactly():
    # 0.5 % per day, measured to day 80 (40 %): 120 days remain
    res = F.baseline_forecast(make_input([(d, 0.5 * d) for d in range(10, 81, 10)]))
    assert res.status is Status.OK
    assert res.details["velocity_pct_per_day"] == pytest.approx(0.5, abs=1e-6)
    assert res.details["linear_remaining_days"] == pytest.approx(120, abs=0.5)
    assert res.lower_days <= res.remaining_days <= res.upper_days
    assert res.completion_date == START + timedelta(days=80 + round(res.remaining_days))


def test_known_logistic_curve_is_recovered():
    k, t0 = 0.03, 150.0
    points = [(d, float(F.logistic(d, k, t0))) for d in range(20, 181, 8)]
    fit = F.fit_logistic([Observation(d, p) for d, p in points])
    assert fit.k == pytest.approx(k, rel=0.02) and fit.t0 == pytest.approx(t0, rel=0.02)
    res = F.baseline_forecast(make_input(points))
    true_remaining = F._logistic_finish(k, t0) - 180
    assert res.details["scurve_remaining_days"] == pytest.approx(true_remaining, abs=3)
    assert res.details["scurve_weight"] > 0.5  # the curve predicts the held-out tail better than a straight line
    assert res.remaining_days == pytest.approx(true_remaining, rel=0.25)


def test_progress_drop_is_flagged_and_not_accepted():
    cleaned, flags = F.enforce_monotonic([Observation(1, 10), Observation(5, 20), Observation(9, 12), Observation(12, 21)])
    assert [o.pct for o in cleaned] == [10, 20, 20, 21]
    assert len(flags) == 1 and "day 9" in flags[0]
    # a dip inside the tolerance is smoothed without a flag
    assert F.enforce_monotonic([Observation(1, 10), Observation(2, 9)])[1] == []


def test_few_observations_fall_back_to_plan_or_give_no_number():
    two = [(10, 4.0), (20, 8.0)]
    with_plan = F.baseline_forecast(make_input(two, planned_duration_days=200, planned_pct_now=10.0))
    assert with_plan.status is Status.OK and with_plan.details["fit_used"] == "plan_spi"
    assert with_plan.remaining_days == pytest.approx(200 / 0.8 - 20)
    without_plan = F.baseline_forecast(make_input(two))
    assert without_plan.status is Status.INSUFFICIENT_DATA and without_plan.remaining_days is None
    assert F.baseline_forecast(make_input([], as_of_day=5)).status is Status.INSUFFICIENT_DATA


def test_stalled_and_complete_projects():
    flat = F.baseline_forecast(make_input([(d, 30.0) for d in range(10, 60, 10)]))
    assert flat.status is Status.STALLED and flat.completion_date is None
    done = F.baseline_forecast(make_input([(10, 50.0), (20, 90.0), (30, 100.0)]))
    assert done.status is Status.COMPLETE and done.remaining_days == 0


def test_pace_factor_scales_remaining_days():
    points = [(d, 0.5 * d) for d in range(10, 81, 10)]
    base = F.baseline_forecast(make_input(points))
    faster = F.baseline_forecast(make_input(points, pace_factor=1.25))
    assert faster.remaining_days == pytest.approx(base.remaining_days / 1.25)


def test_synthetic_project_is_reproducible_and_sane():
    a, b = synthetic.generate_project(7, 3), synthetic.generate_project(7, 3)
    assert np.array_equal(a.true_pct, b.true_pct) and a.observations == b.observations
    assert synthetic.generate_project(8, 3).observations != a.observations
    assert a.true_pct[-1] == 100.0 and np.all(np.diff(a.true_pct) >= 0)
    plan = synthetic.generate_project(7, 3, efficiency=1.0)
    assert len(plan.planned_pct) - 1 == pytest.approx(plan.planned_duration_days, abs=3)
    days = [o.day for o in a.observations]
    assert days == sorted(days) and len(set(np.diff(days))) > 1  # irregular photo intervals


def test_baseline_runs_at_every_checkpoint_of_a_synthetic_project():
    project = synthetic.generate_project(1, 0, efficiency=0.8)
    for n in range(0, len(project.observations) + 1, 5):
        inp = synthetic.input_at(project, n)
        res = F.baseline_forecast(inp)
        assert ml.build_features(inp, res).shape == (len(ml.FEATURE_NAMES),)
        if res.status is Status.OK:
            assert 0 <= res.lower_days <= res.remaining_days <= res.upper_days
    assert synthetic.true_remaining_days(project, len(project.observations)) >= 0


def test_rework_heuristic():
    assert M.rework_delay_days({"High": 2, "Critical": 1, "Low": 9}) == 7.0


def test_endpoint_and_migration():
    from fastapi.testclient import TestClient
    from service import app

    client = TestClient(app)
    body = {"start_date": "2026-01-05", "as_of": "2026-03-26", "planned_duration_days": 200, "planned_pct_now": 45,
            "observations": [{"day": d, "pct": 0.5 * d} for d in range(10, 81, 10)]}
    res = client.post("/v1/schedule/forecast", json=body)
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["baseline"]["status"] == "ok" and data["baseline"]["completion_date"]
    assert data["baseline"]["details"]["spi"] == pytest.approx(40 / 45, abs=1e-3)
    assert client.post("/v1/schedule/forecast", json={**body, "as_of": "2025-01-01"}).status_code == 422
    assert client.post("/v1/schedule/forecast", json={**body, "observations": [{"day": 1, "pct": 140}]}).status_code == 422

    # the migration only adds a nullable column, so it is safe on a database that already has forecasts
    root = pathlib.Path(__file__).resolve().parents[3]
    sql = (root / "db" / "migrations" / "009_schedule_model.sql").read_text(encoding="utf-8")
    statements = [s for s in sql.splitlines() if s.strip() and not s.startswith("--")]
    assert statements == ["ALTER TABLE forecasts ADD COLUMN schedule_model jsonb;"]
    assert "jsonb schedule_model" in (root / "docs" / "erd.md").read_text(encoding="utf-8")
