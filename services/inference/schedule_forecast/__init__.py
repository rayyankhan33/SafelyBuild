"""
schedule_forecast - completion-date forecasting from a project's percent-complete history.

    models.py     data classes and every tunable constant
    forecast.py   explainable baseline (earned schedule + logistic S-curve + recent pace), blend, orchestrator
    ml.py         gradient-boosting refinement with P10/P50/P90 (trained on SYNTHETIC projects)
    synthetic.py  seeded synthetic project generator

Time is calendar days since the project start; progress is percent 0-100.
Design record: docs/handoff-schedule-assistant.md; method and results: docs/schedule-forecast.md.
"""
