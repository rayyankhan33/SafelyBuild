# Risk register (project risks, not construction risks)

| ID | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | Team cannot explain AI-drafted code at the evaluation | Medium | High (marks, Form 11) | Walkthrough guide in implementation.md; each member runs the tests and traces one feature end to end; change something small live | All |
| R2 | Heuristic defect scores give false alarms (soil, bricks, formwork look like rust/honeycomb) and trigger "critical" alerts that erode investor trust | High | High | Say so in the UI and docs; keep image-level density in the SDI; Sprint 2: labelled test set, measure precision/recall, fine-tune a model; add engineer confirm/dismiss of defects | Hadi |
| R3 | ACI table values or clause numbers transcribed incorrectly | Medium | High (wrong budgets) | Verify each table against a licensed copy; cite the table in the code; estimation tests use hand calculations; advisory note in UI | Rayyan |
| R4 | Default rates and productivity are placeholders; investors may read the budget as real | High | Medium | Labelled demo values in UI and docs; rates editable per project; estimate stores the rates used | Rayyan |
| R5 | Forecasts are noisy early in a project | Medium | Medium | No forecast under 3 log days; range shown; documented thresholds | Rayyan |
| R6 | Engineers enter progress optimistically; spend is manually entered, so figures are only as honest as the logs | Medium | High | Photos stored with hash and timestamp; audit log; Sprint 2: cross-check progress with photo evidence | Team |
| R7 | No model for material counting means "daily spend through images" is not yet automatic | High (certain) | High vs the vision | Disclosed in scope; pipeline, provenance fields and confirm workflow are ready; Sprint 2: collect labelled material photos | Hadi |
| R8 | Single point of knowledge: one member did most commits | Medium | Medium | Each member commits their own area; track in milestone log | All |
| R9 | Photos may show workers; privacy | Low now, High at launch | High | Consent and retention policy before any pilot | Team |
| R10 | Docker deployment untested | Medium | Low | Test compose on a machine with Docker before the final demo | Atyab |
