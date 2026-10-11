# FYP-1 Mid evaluation: conformance matrix

Maps every criterion of Form 2 (presentation and demo) and Form 3 (report) to evidence in this repository, and states plainly what is still missing. "Gap" items need the team, not more code.

## Form 2 - Presentation and demo (100 marks)

| # | Criterion (marks) | Evidence in repo | Gap / action |
|---|---|---|---|
| 1 | Previous proposal actions addressed (10) | [panel-action-register.md](panel-action-register.md); pivot documented in design.md section 9 | **Gap:** the panel's actual actions are not in the repo. Copy them in with a live evidence link each. Cap risk: "ignored panel actions" red flag |
| 2 | Iteration plan and work breakdown progress (10) | [iteration-plan.md](iteration-plan.md): tasks, proposed owners, status, evidence, recovery plan for the three not-started items | **Gap:** confirm owners and record real dates; do not mark items done that cannot be shown |
| 3 | Live prototype with core module demo, edge/failure cases shown (25) | Whole system runs live: `npm run db:start`, `inference`, `api`, `web`. Demo script with failure demos in [test-plan.md](test-plan.md) section 4 (inference down, invalid logs). Demo data is computed through the real services, not typed in | **Honest caveat:** defect scoring is heuristic and material counting is simulated (labelled). Say so before an examiner finds it; the rubric penalises "hardcoded scaffolding", and the simulated provider is the only scaffold |
| 4 | Requirements and acceptance criteria (10) | [srs.md](srs.md): 26 FRs, 8 NFRs, success criteria, each with an acceptance check and test group | - |
| 5 | Design artefacts and evolution (15) | [design.md](design.md): architecture, interfaces, sequence/state diagrams, algorithms, decisions, evolution table; [erd.md](erd.md) generated from the live DB and guarded by a test | Be ready to explain each diagram from the code; cap is 50% if diagrams are not understood |
| 6 | Repository, milestone and member evidence (10) | Git repository; milestone log; ownership table in tool-disclosure.md | **Gap:** history currently has one commit by one member. Each member must commit their own area with meaningful messages and the work should be tagged (e.g. `sprint-1-mid`). Cap: 40% if history is single-member |
| 7 | Testing and early validation (10) | 116 automated tests; [test-results.md](test-results.md) (generated); [test-plan.md](test-plan.md) with failure analysis and honest gaps | Run `npm run test:all` live; discuss the six failures found (test-plan section 3) |
| 8 | Presentation, Q&A, team and tool ownership (10) | [tool-disclosure.md](tool-disclosure.md); walkthrough table in [implementation.md](implementation.md) | **Gap:** every member must be able to explain their area. Rehearse: trace one daily log from the form to the database to the dashboard |

### Red flags the rubric names, and our position

| Red flag | Status |
|---|---|
| Sudden code volumes | **Applies.** Disclosed. Mitigation: walkthrough guide, each member traces features, small live change in the demo |
| Stagnant prototype | Does not apply: new core logic since the POC (estimation, forecasting, risk framework, API, database, two UIs) |
| Generic or GenAI R&D text | Not applicable to code, but **the report's R&D sections must be written by the team** |
| Uneven team contribution | Risk R8: assign real owners and commit per member |
| Dishonest milestone logging | Mitigated: every "done" row names a runnable evidence command |
| Ignored panel actions | Open until panel-action-register.md is filled in |

## Form 3 - Report (100 marks)

The report itself is the team's document; this repository supplies material for it.

| # | Criterion (marks) | Material available | What the team must write |
|---|---|---|---|
| 1 | Report format and artefacts (5) | All artefacts exist as files | Follow the department template, signatures, appendices |
| 2 | Problem formulation, R&D and gap analysis (15) | The proposal's literature and the new pivot | **Must be the team's own words.** Add research for the new modules: earned-value forecasting in construction, cost estimation from quantities (ACI 211.1), risk matrices/ALARP/bow-tie, image-based progress monitoring. Isolate the technical gap, e.g. non-engineer-facing, evidence-linked cost and schedule forecasting from site photos. Be ready to explain any paragraph unprompted |
| 3 | Vision, scope and success criteria (10) | srs.md section 1: scope table, measurable success criteria | Copy and adapt |
| 4 | Requirements and acceptance criteria (15) | srs.md | Include the numbered FRs/NFRs and the acceptance table |
| 5 | Architecture and interface design (15) | design.md sections 1-3 and 7-8 | Redraw/export diagrams, explain layers and interfaces |
| 6 | Data, process, behaviour design (10) | erd.md, design.md sections 4-6 (ERD, data storage table, sequence, state, algorithms) | Explain each diagram in text |
| 7 | Implementation documentation (15) | implementation.md: setup, file map, key functions, trade-offs | Verify the setup steps on a clean machine (reproducibility gate) |
| 8 | Test plan and tool/risk disclosure (15) | test-plan.md, test-results.md, tool-disclosure.md, risks.md | State GenAI use exactly as in tool-disclosure.md. Tool-disclosure gate: this item is 0 until disclosure is submitted |

## Before the evaluation: checklist

- [ ] Fill in the panel action register with live evidence links
- [ ] Each member commits their own area (own git identity); tag `sprint-1-mid`; push
- [ ] Confirm owners and dates in iteration-plan.md
- [ ] Rehearse the demo script and the failure demos; run `npm run test:all` once on the evaluation machine
- [ ] Each member reads their files and can answer "what happens if this function is removed?"
- [ ] Write the report's R&D and gap analysis yourselves
- [ ] Replace placeholder rates and productivity values with real local figures, or say they are placeholders
- [ ] Verify the ACI table values against licensed copies (risk R3)
