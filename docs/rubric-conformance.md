# FYP-1 Mid evaluation: conformance matrix

Maps every criterion of Form 2 (presentation and demo) and Form 3 (report) to evidence in this repository, and states plainly what is still missing. "Gap" items need the team, not more code.

## Form 2 - Presentation and demo (100 marks)

| # | Criterion (marks) | Evidence in repo | Gap / action |
|---|---|---|---|
| 1 | Previous proposal actions addressed (10) | [panel-action-register.md](panel-action-register.md); pivot and later redesign documented in design.md sections 9-10 | **Gap:** the panel's actual actions are not in the repo. Copy them in with a live evidence link each |
| 2 | Iteration plan and work breakdown progress (10) | [iteration-plan.md](iteration-plan.md): tasks, proposed owners, status, evidence, recovery plan for the not-started items | **Gap:** confirm owners and record real dates; do not mark items done that cannot be shown |
| 3 | Live prototype with core module demo, edge/failure cases shown (25) | Whole system runs live with `npm run dev`. The image pipeline runs end to end: camera frame, ingest checks, analysis, roll-up, forecast, dashboards. Demo script with tamper, failure and silence cases in [test-plan.md](test-plan.md) section 4. Seed prints measured vs true values | **Honest caveat to say first:** the demo frames are synthetic drawings; classical methods are validated only on them; real-footage accuracy is unmeasured; the teammate's trained model is not yet in. The rubric penalises "hardcoded scaffolding": nothing on the dashboards is typed in, and the synthetic frames are labelled |
| 4 | Requirements and acceptance criteria (10) | [srs.md](srs.md): 33 FRs, 10 NFRs, success criteria, limitations, each with an acceptance check and test group | - |
| 5 | Design artefacts and evolution (15) | [design.md](design.md): architecture, interfaces, sequence and state diagrams, algorithms with measured design effects, decisions, evolution table, evidence/tamper model; [erd.md](erd.md) generated from the live DB and guarded by a test; [model-integration.md](model-integration.md) | Be ready to explain each diagram from the code; cap is 50 % if diagrams are not understood |
| 6 | Repository, milestone and member evidence (10) | Git repository; milestone log; ownership table in tool-disclosure.md | **Gap:** history is dominated by one member's identity. Each member must commit their own area with meaningful messages and tag the work (e.g. `sprint-1-mid`). Cap: 40 % if single-member |
| 7 | Testing and early validation (10) | 230 automated tests; [test-results.md](test-results.md) (generated); [test-plan.md](test-plan.md) with 14 failures found and what they taught, plus honest gaps | Run `npm run test:all` live; discuss failure 7 (a measured -27 % bias fixed by design) |
| 8 | Presentation, Q&A, team and tool ownership (10) | [tool-disclosure.md](tool-disclosure.md); walkthrough table in [implementation.md](implementation.md) | **Gap:** every member must explain their area. Rehearse: trace one camera frame to the dashboard figure and say what each model/version stamp means |

### Red flags the rubric names, and our position

| Red flag | Status |
|---|---|
| Sudden code volumes | **Applies.** Disclosed. Mitigation: walkthrough guide, each member traces features, small live change in the demo |
| Stagnant prototype | Does not apply: new core logic since the POC (estimation, forecasting, camera ingest, stage/stock measurement, derived hazards, registry, two UIs) |
| Generic or GenAI R&D text | Not applicable to code, but **the report's R&D sections must be written by the team** |
| Uneven team contribution | Risk R8: assign real owners and commit per member |
| Dishonest milestone logging | Mitigated: every "done" row names a runnable evidence command |
| Ignored panel actions | Open until panel-action-register.md is filled in |

## Form 3 - Report (100 marks)

The report itself is the team's document; this repository supplies material for it.

| # | Criterion (marks) | Material available | What the team must write |
|---|---|---|---|
| 1 | Report format and artefacts (5) | All artefacts exist as files | Follow the department template, signatures, appendices |
| 2 | Problem formulation, R&D and gap analysis (15) | The proposal's literature and the pivot | **Team's own words.** Add research for the new modules: image-based construction progress monitoring, material quantity estimation from images, earned-value forecasting, tamper-resistant evidence (why self-reported site data is unreliable), risk matrices/ALARP/bow-tie. State the technical gap (e.g. automatic, non-falsifiable cost and schedule forecasting for non-engineers from fixed-camera images). Be ready to explain any paragraph unprompted |
| 3 | Vision, scope and success criteria (10) | srs.md section 1: scope table, measurable criteria SC-1 to SC-8 and the limit on SC-4 | Copy and adapt |
| 4 | Requirements and acceptance criteria (15) | srs.md | Include the numbered FRs/NFRs and the acceptance table |
| 5 | Architecture and interface design (15) | design.md sections 1-3, 7, 8, 10 | Redraw/export diagrams, explain layers, the camera interface and the model registry |
| 6 | Data, process, behaviour design (10) | erd.md, design.md sections 4-6 (data, frame sequence, hazard state diagram, algorithms) | Explain each diagram in text |
| 7 | Implementation documentation (15) | implementation.md: setup, file map, key functions, trade-offs | Verify the setup steps on a clean machine (reproducibility gate) |
| 8 | Testing plan and tool/risk disclosure (15) | test-plan.md, test-results.md, tool-disclosure.md, risks.md | State GenAI use exactly as in tool-disclosure.md. This item is 0 until disclosure is submitted |

## Before the evaluation: checklist

- [ ] Fill in the panel action register with live evidence links
- [ ] Each member commits their own area (own git identity); tag `sprint-1-mid`; push
- [ ] Confirm owners and dates in iteration-plan.md
- [ ] Agree with the model-training teammate the stage vocabulary and plug-in delivery (model-integration.md section 6)
- [ ] Rehearse the demo, the tamper demo, the failure demo and the silence demo; run `npm run test:all` once on the evaluation machine
- [ ] Each member reads their files and can answer "what happens if this function is removed?"
- [ ] Write the report's R&D and gap analysis yourselves
- [ ] Say clearly that demo frames are synthetic and real-footage accuracy is unmeasured
- [ ] Replace placeholder prices and productivity with real local figures, or say they are placeholders
- [ ] Verify the ACI table values against licensed copies (risk R3)
