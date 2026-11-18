"""
train_schedule.py - train and evaluate the schedule-forecast ML model on SYNTHETIC projects.

  python train_schedule.py --projects 800 --seed 0 --version 0.1.0
  python train_schedule.py --tune          # also search baseline constants on train+validation (slow)

Writes:
  models/schedule_gbm_<version>.joblib       the model bundle (three quantile models + calibration)
  models/schedule_gbm_eval.json              held-out evaluation (test projects only), the source of
                                             docs/schedule-forecast-eval.md

Trained and evaluated on synthetic projects. This validates the pipeline, not real-world accuracy.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

from schedule_forecast import ml, synthetic
from schedule_forecast import models as M

HERE = Path(__file__).parent


def tune_baseline(projects, split, seed: int) -> dict:
    """
    Grid-search VELOCITY_WINDOW_DAYS and LOGISTIC_DONE_PCT on TRAIN + VALIDATION projects (never test) by the
    baseline's mean absolute error at the 20/40/60/80 % checkpoints. Prints the table; returns the best values.
    The constants are NOT changed automatically: copy the winners into models.py and record them in the docs.
    """
    pool = [p for p in projects if p.project_id in split["train"] or p.project_id in split["validation"]]
    rng = np.random.default_rng(seed)
    sample = [pool[i] for i in rng.choice(len(pool), size=min(200, len(pool)), replace=False)]
    best, results = None, []
    old = (M.VELOCITY_WINDOW_DAYS, M.LOGISTIC_DONE_PCT)
    try:
        for window in (14.0, 28.0, 42.0, 56.0):
            for done in (95.0, 97.0, 98.0, 99.0):
                M.VELOCITY_WINDOW_DAYS, M.LOGISTIC_DONE_PCT = window, done
                rep = ml.evaluate(sample, None)
                mae = np.mean([rep[c]["baseline"]["mae_days"] for c in ("20", "40", "60", "80")])
                results.append((window, done, round(float(mae), 1)))
                print(f"  window {window:>4.0f}  done {done:>4.0f}  mean MAE {mae:6.1f}")
                if best is None or mae < best[2]:
                    best = results[-1]
    finally:
        M.VELOCITY_WINDOW_DAYS, M.LOGISTIC_DONE_PCT = old
    return {"velocity_window_days": best[0], "logistic_done_pct": best[1], "mean_mae_days": best[2], "grid": results}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--projects", type=int, default=800)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--version", default="0.1.0")
    ap.add_argument("--out", default=str(HERE / "models"))
    ap.add_argument("--tune", action="store_true", help="grid-search baseline constants on train+validation")
    args = ap.parse_args()

    t0 = time.time()
    projects = synthetic.generate_dataset(args.projects, args.seed)
    print(f"generated {len(projects)} synthetic projects in {time.time() - t0:.1f} s")

    t0 = time.time()
    bundle = ml.train(projects, seed=args.seed, version=args.version)
    print(f"trained {bundle['version']} on {bundle['trained_on']['n_rows']} rows in {time.time() - t0:.1f} s")
    print(f"blend weights by progress bucket: {bundle['blend_weights']}, ML interval scale {bundle['ml_interval_scale']}, "
          f"suggested BASELINE_INTERVAL_SCALE {bundle['baseline_interval_scale_suggested']} (now {M.BASELINE_INTERVAL_SCALE})")
    path = ml.save_bundle(bundle, args.out)
    print(f"saved {path} ({path.stat().st_size / 1e6:.2f} MB)")

    split = {k: set(v) for k, v in bundle["split"].items()}
    tuning = tune_baseline(projects, split, args.seed) if args.tune else None

    test = [p for p in projects if p.project_id in split["test"]]
    t0 = time.time()
    report = ml.evaluate(test, bundle)
    # the same test projects without efficiency drift (A11): shows how much a constant-efficiency world favours EVM
    no_drift = [p for p in synthetic.generate_dataset(args.projects, args.seed, drift=False) if p.project_id in split["test"]]
    report_no_drift = ml.evaluate(no_drift, bundle)
    print(f"evaluated on {len(test)} held-out projects in {time.time() - t0:.1f} s")

    out = {
        "note": "Trained and evaluated on synthetic projects. This validates the pipeline, not real-world accuracy.",
        "model_version": bundle["version"],
        "generated": time.strftime("%Y-%m-%d"),
        "settings": {"projects": args.projects, "seed": args.seed, "split": [len(split[k]) for k in ("train", "validation", "test")],
                     "velocity_window_days": M.VELOCITY_WINDOW_DAYS, "logistic_done_pct": M.LOGISTIC_DONE_PCT,
                     "baseline_interval_scale": M.BASELINE_INTERVAL_SCALE},
        "blend_weights": bundle["blend_weights"],
        "ml_interval_scale": bundle["ml_interval_scale"],
        "feature_importance": bundle["feature_importance"],
        "test": report,
        "test_without_drift": report_no_drift,
        "baseline_tuning": tuning,
    }
    eval_path = Path(args.out) / "schedule_gbm_eval.json"
    eval_path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"wrote {eval_path}")
    print(f"\n{'progress':>8} {'n':>4}  {'baseline':>9} {'ML':>9} {'blend':>9} {'EVM':>9}   (MAE days, test projects)")
    for c in ("20", "40", "60", "80"):
        r = report[c]
        print(f"{c + ' %':>8} {r['n_projects']:>4}  " + " ".join(f"{r[k].get('mae_days', float('nan')):>9.1f}" for k in ("baseline", "ml", "blend", "evm")))


if __name__ == "__main__":
    main()
