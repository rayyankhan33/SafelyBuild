# Model-based completion forecast

The platform's headline finish date is the earned-value rule in `apps/api/src/domain/evm.js` (planned duration ÷ SPI).
Beside it, the engineer's **Schedule** page now shows an experimental **model forecast**: an explainable baseline,
a machine-learning refinement, and a blend of the two, each with a date range, an explanation panel and a what-if
pace slider. Investors do not see it.

**Read this first.** There is no real project history, so the ML model is trained and evaluated on **synthetic**
projects. The numbers below show that the method works and how the parts compare; they are **not** a measure of
accuracy on real sites.

## 1. How it fits

```
cameras -> stage observations -> task progress -> evaluate() (EV, PV per day)          (unchanged)
recompute() -> schedulePayload(): progress = EV/BAC per log date, plan = PV/BAC weekly
            -> POST /v1/schedule/forecast (inference service, Python)
                 baseline: earned schedule + S-curve + recent pace, weighted
                 ML: 3 quantile gradient-boosting models (P10/P50/P90)
                 blend: ML share x ML + rest x baseline
            -> stored in forecasts.schedule_model (migration 009), re-used while the inputs are unchanged
engineer dashboard -> schedule_model (+ EVM date, chart data, disclaimer)
POST /projects/:pid/schedule-model/whatif {pace_factor}  -> same forecast with the future pace scaled; stores nothing
```

If the inference service is down, `schedule_model` is `null`, the panel says so, and the EVM forecast is unaffected.

| File | Role |
|---|---|
| `services/inference/schedule_forecast/models.py` | data classes and every tunable constant |
| `.../forecast.py` | monotone cleaning, the three baseline methods, mixing, intervals, blend, `forecast_all` |
| `.../ml.py` | features, training rows, whole-project split, training, calibration, prediction, evaluation |
| `.../synthetic.py` | seeded project simulator; all assumptions in its header (A1-A13) |
| `services/inference/train_schedule.py` | trains, calibrates and evaluates; writes `models/schedule_gbm_*.joblib` and `models/schedule_gbm_eval.json` |
| `apps/api/src/domain/schedulemodel.js` | builds the service input and the chart data |
| `apps/web/src/components/ScheduleModel.jsx` | the engineer panel |

## 2. Baseline (explainable)

Progress is cleaned first: it can only go up (running maximum); a drop of more than 2 points is listed as
"measurement overruled" instead of being accepted silently.

| Method | Finish date | Range |
|---|---|---|
| **Earned schedule** (Lipke 2003) | ES = the day the plan expected today's progress; SPI(t) = ES ÷ elapsed days; finish = planned duration ÷ SPI(t) | regression of ES against time over the last 42 days, slope ± 1.28 s.e. |
| **S-curve** | logistic `p(t) = 100 / (1 + e^(-k(t - t0)))` fitted to the whole history (at least 5 points spanning 15 % progress); finish when it reaches 98 % | 200 draws from the fit covariance |
| **Recent pace** | straight line through the last 42 days, extrapolated to 100 % | slope ± 1.28 s.e. |

Mixing: each method is refitted on the first three quarters of the history and scored on how well it predicts the
last quarter; weights are proportional to 1 / (error + 0.5). The earned-schedule method gets at least **85 %** when a
plan exists, because on the validation projects short-term fit did not predict finish-date accuracy, and earned
schedule alone was the most accurate. With fewer than 3 observations the baseline falls back to planned duration ÷ SPI,
or gives no date. The range is widened by a factor of 2.7, calibrated on validation projects to cover about 80 %.

Earned schedule was added during implementation: the first baseline (pace + S-curve only) lost to the plain EVM rule
before 80 % progress. Cost-based SPI drifts towards 1 near the end of any project, which is why EVM finish dates
are known to become optimistic late on; time-based SPI(t) does not have that problem.

## 3. ML refinement

- Three `HistGradientBoostingRegressor(loss="quantile")` models (scikit-learn, CPU, 1.4 MB file) predict
  log(1 + remaining days) at the 10th, 50th and 90th percentile.
- 13 features: percent complete, elapsed days, recent and average pace, change in pace, pace variability, planned
  duration, SPI, floors (missing for a third of training projects, because the platform does not record it),
  share of the next 90 days in the monsoon (July-September), and the baseline, EVM and earned-schedule estimates.
- Training rows use only what was known at each checkpoint (at most 12 per project); a test checks that adding later
  data does not change earlier rows.
- Projects are split **as whole projects**: 560 train, 120 validation, 120 test (seed 0).
- Blend weights per progress band (0-25, 25-50, 50-75, 75-100 %) and the ML interval scale are chosen on the
  validation projects only. Result: ML share 100 %, 75 %, 75 %, 100 %.
- The ML part is skipped (blend = baseline, reason shown) with fewer than 3 observations, when the baseline has no
  date, or when any feature lies outside the training range by more than 10 %.

Most important features (permutation importance on validation): earned-schedule estimate (0.37), EVM estimate
(0.17), baseline estimate (0.15), planned duration (0.07), percent complete (0.07), monsoon ahead (0.03).

## 4. Results on held-out synthetic projects

120 test projects never used for training or tuning. Each forecast is made at the first photo where measured
progress reaches the checkpoint, and compared with the true remaining days. Source: `models/schedule_gbm_eval.json`.

Mean absolute error (days):

| Progress | Baseline | ML | **Blend** | EVM rule (plan ÷ SPI) | Earned schedule alone |
|---|---|---|---|---|---|
| 20 % | 63.3 | 53.5 | **52.6** | 103.0 | 63.0 |
| 40 % | 48.0 | 40.0 | **39.9** | 51.4 | 45.4 |
| 60 % | 32.2 | 29.1 | **28.4** | 45.5 | 31.5 |
| 80 % | 23.9 | 19.7 | 20.0 | 62.8 | 24.9 |

Mean absolute percentage error: blend 15 %, 14 %, 14 %, 18 %; EVM rule 29 %, 20 %, 21 %, 50 %.

Share of true finish dates inside the "80 %" range: baseline 68 %, 61 %, 75 %, 68 % (too narrow); ML 78 %, 73 %,
78 %, 78 %; blend 80 %, 75 %, 80 %, 78 %.

What this shows, honestly:
- The blend is best or level-best at every checkpoint, but the ML adds only 3-9 days over the baseline: most of the
  gain comes from earned schedule, which the ML also uses as its strongest input.
- The plain EVM rule is the weakest, pessimistic early (+41 days at 20 %) and optimistic late (-58 days at 80 %).
  Part of that is real (SPI drifts to 1), part may come from the generator: the late, slow finishing phase is
  an assumption (A2).
- Without efficiency drift in the generator (every project keeps one efficiency, which favours EVM) the picture is
  the same: blend 50 / 36 / 27 / 19 days, EVM 111 / 46 / 42 / 63.
- The baseline range is too narrow on test projects (61-75 % instead of 80 %) even after calibration on validation.

## 5. Limits

1. **Synthetic training data.** The generator and the forecaster were written by the same hand; the model learns the
   generator's assumptions (monsoon slowdown, stalls, Eid pauses, phase shape). Real projects replace the generator
   without code changes (`ml.train` takes any list of projects with the same fields).
2. Real progress moves in steps when a stage is confirmed; the generator covers this only roughly (A10).
3. The forecast assumes the future looks like the measured past. A new delay (strike, design change) is invisible
   until it shows in the measurements.
4. The demo project is about six weeks old, so its forecast rests on early data.
5. Calendar days are used throughout (the EVM rule in `evm.js` uses Monday-Saturday working days).

## 6. Retrain and test

```bash
cd services/inference
python train_schedule.py --projects 800 --seed 0 --version 0.1.0     # about 3 minutes on CPU
python train_schedule.py --tune                                       # also grid-searches baseline constants (slow)
python -m pytest tests/test_schedule_baseline.py tests/test_schedule_ml.py -q
```

The newest `models/schedule_gbm_*.joblib` is used, or the file named in `SCHEDULE_MODEL`. Constants tuned on
validation projects are in `schedule_forecast/models.py` (`ES_PRIOR_WEIGHT`, `VELOCITY_WINDOW_DAYS`,
`BASELINE_INTERVAL_SCALE`); after changing one, retrain so the stored evaluation matches.
