**SafelyBuild**

**Automated Construction Progress, Cost and Safety Monitoring from Site Camera Images**

*Revised proposal. Supersedes the August 18, 2026 proposal after two changes: (1) the product now serves investors and site engineers instead of a regulating council, and (2) financial tracking and schedule tracking were added. Text from the original is kept where it still applies. Items in [square brackets] are for the team to complete or decide.*

Project Team

| Hadi Saleemi   | 22i-1043 |
| -------------- | -------- |
| Rayyan Khan    | 22i-1002 |
| Muhammad Atyab | 22i-1191 |

Session 2023-2027. Supervised by Mr. Muhammad Aamir Gulzar, Department of Computer Science, National University of Computer and Emerging Sciences, Islamabad, Pakistan.

# Chapter 1 - Introduction

This document presents the scope, motivation, objectives and implementation plan for SafelyBuild: a system that tells an investor, in plain language, how far a construction project has got, where the money has gone, whether it will finish on time and on budget, and whether the site is safe. Every figure about the physical state of the site is **measured automatically from fixed-camera images**. Nobody on site can enter, edit or delete it, so the record cannot be falsified.

## 1.1 Problem Statement

Investors who fund construction rarely have an independent, continuous and trustworthy view of what they are paying for. Progress, spending and quality are reported by the same parties who benefit from a favourable picture, and the reports arrive late, in engineering language, and cannot easily be checked.

The Pakistani evidence in the original proposal still applies and is now used to support this framing. In a review of 32 Pakistani studies, Nisar and Asif (2023) found that financial difficulties, administrative issues and input cost estimates were the most frequently cited controllable causes of cost and schedule failure, while technical matters tied to the physical safety of the structure were ranked lowest, which suggests that reporting is weighted towards financial and administrative symptoms and away from physical evidence. Khadim et al. (2021) found that 91.3% of 93 surveyed contractual parties agreed that corruption is widespread in local construction, that lower-quality construction was the third most damaging consequence, that officials were most often blamed for bribes at design approval and interim payment certification, and that blame is diffused across stakeholders so that no party takes responsibility. Business Recorder (2025) describes funds meant for Karachi's infrastructure being siphoned off, leaving projects incomplete or substandard with no clear accountability.

Existing technology does not close the gap. Commercial project-risk metrics such as BMI's Infrastructure Project Risk Metric score a country, industry and project fundamentals but do not look at the work on site. Post-construction inspection with UAVs and digital twins (Furtner et al., 2018) documents structures that are already built. Neither provides continuous, evidence-based tracking of progress, spending and quality *during* construction in a form a non-engineer can use, and neither is protected against the people being monitored shaping the evidence.

**Research gap to state in the report** [team to write and support with sources]: automatic, tamper-resistant tracking of construction progress, material cost and safety from fixed-camera imagery, presented to non-engineers. Areas to review: earned-value forecasting in construction; image-based progress and material-quantity estimation; self-reporting bias and falsified site records; risk matrices, ALARP and bow-tie analysis.

## 1.2 Motivation

- Poor site-level practice shortens the life of structures and endangers workers and the public (Khadim et al., 2021; Business Recorder, 2025).
- Cost and schedule overruns are among the most common reasons projects fail in Pakistan (Nisar and Asif, 2023); the Orange Line, delayed more than two years and costing close to three times its anticipated budget, is the example they give.
- Practitioners themselves are ambivalent about cutting corners (75.27% saw some positive effect of corruption in Khadim et al., 2021). A tool that only documents condition, or that depends on what site staff choose to report, will not change behaviour. **Evidence the monitored party cannot alter is the design requirement that follows.**

**Table 1.1: SafelyBuild compared with existing approaches** [team to verify each cell against sources]

| Dimension | UAV / digital-twin inspection (Furtner et al.) | Commercial project-risk tools (BMI PRM) | Self-reported progress and payment certificates | SafelyBuild |
|---|---|---|---|---|
| When | After construction, periodic | Before and during, at project level | During, periodic | Continuously during construction |
| Source of evidence | Drone photogrammetry | Country, industry and analyst indices | The contractor or engineer | Fixed cameras, automatic |
| Can the monitored party alter it? | Limited | Not applicable | Yes | No path to enter or edit it; tamper checks on cameras |
| Output | Damage catalogue, 3D model | 0-10 project risk score | Progress percentages, invoices | Progress, spend, forecast final cost, forecast finish date, danger index, hazards |
| Audience | Asset operator | Investors, insurers (market level) | Client's engineers | Investors (plain language) and site engineers (technical) |

## 1.3 Problem Solution

SafelyBuild is built around **cameras as the only source of evidence**.

1. **Initial budget (human input).** An engineer enters the bill of quantities (structural elements with dimensions and concrete strengths). The system estimates quantities and cost in PKR using the ACI 211.1 absolute-volume mix method, ACI 318 strength margins, wastage and compaction (loose vs rodded bulk density) factors, and an administrator-maintained price book. It generates a baseline schedule and splits the budget across tasks.
2. **Daily operation (automatic).** Fixed cameras send frames to the server with their own secret key. The server checks the camera clock, rejects replayed frames and stores each frame with its hash. Image analysis then measures: (a) the construction stage visible at each element, which gives task progress; (b) the material stock in the yard, whose start-to-end-of-day decrease gives consumption and so money spent at price-book prices; (c) rusted rebar and honeycombed concrete, which give defects.
3. **Forecasts.** Earned-value analysis compares work done with work planned and with money spent. It forecasts the final cost, the overrun in PKR and the finish date (days early or late), and measures productivity.
4. **Risk and hazards, fully automatic.** A Structural Danger Index (0-10), a 5x5 risk matrix, ALARP zones and bow-tie analysis. Hazards are raised by the cameras and **closed only by the cameras** after three consecutive clean inspection days. Silence never counts as safe: an overdue camera or an unwatched task raises an alert and the investor's view says "not verified".
5. **Two views.** Investors see progress, spend, expected final cost and finish date, a safety light and photos, in plain words. Engineers see how each number was produced: the indices, the standards followed, hazard categories and suggested controls, and warnings when the budget or the timeline is slipping.
6. **Pluggable models.** The vision methods are replaceable per task through a backend registry, so a trained model can be added, measured against a baseline on labelled images and activated without changing any other code.

**What a person still enters:** the initial BOQ and budget, the crews on site, and the equipment available (engineer); cameras, prices and users (administrator).

**Objectives**

- Measure construction progress per element from camera images and forecast the finish date.
- Estimate the initial budget from the design with ACI methods and track daily material spend from images to forecast the final cost and any overrun.
- Detect rusted rebar and honeycombed concrete, and derive hazards, a danger index, risk matrix, ALARP zone and bow-tie automatically.
- Make the evidence tamper-resistant: authenticated cameras only, no human path to edit measurements, automatic hazard closure, detection of silent cameras.
- Present results in plain language to investors and in technical detail to engineers.
- Allow trained models to be dropped in and evaluated on labelled real images.

## 1.4 Stakeholders

- **Primary users:** investors and project owners (private developers, funders) who need a verified view of progress, spending and safety.
- **Secondary users:** site engineers and contractors, who enter the initial BOQ, crews and equipment and read the technical analysis; this role is the project's **lead engineer**: the same person (or people) who enter the BOQ also set the inception cost inputs (labour, equipment, formwork, overheads) once, and raise change requests.
- **Administrators:** manage accounts (including deleting them), decide who can see each project, install cameras and maintain the price book. They do **not** create projects: engineers do, and every administrator is notified when one is created.
- **On-site workers:** their safety depends on the hazards the system raises; cameras may incidentally capture them, so monitoring needs notice and consent.
- **End beneficiaries:** the public and future users of the structure.
- **Project supervisor and review committee:** evaluate deliverables, scope compliance and validation rigour.

*Removed from the original: the regulating council as primary user, and the engineer-accountability and blacklist module. The PEC number remains an optional profile field.*

# Chapter 2 - Project Description

## 2.1 Scope

**In scope**

| Area | Content |
|---|---|
| Initial budget | BOQ entry for footings, columns, beams, slabs and masonry walls; ACI 211.1 mix design; ACI 318 required-strength margin and minimum-steel check; wastage; compaction factors for sand and aggregate; PKR material price book; **labour, equipment, formwork, overheads and contingency, fixed once at project inception by the engineer** |
| Schedule tracking | Baseline schedule from the BOQ; progress per task measured from camera frames; schedule performance index, forecast finish date, days early or late; productivity per interval with crews on site shown alongside |
| Financial tracking | **Total cost, not materials alone:** material consumption measured from yard cameras at price-book prices, plus labour (crews x days x locked rate), equipment (units x days x locked hire rate) and fixed overhead lines; cost performance index, forecast final cost, overrun in PKR and %, with a range |
| Defect detection | Rusted rebar and honeycombed concrete from site images |
| Risk and hazards | Structural Danger Index, risk matrix (ISO 31000 / IEC 31010), ALARP zones (HSE R2P2), bow-tie, hazard library with categories and controls, standards cited; automatic creation and closure; **completion lifecycle: placed, curing, finished, inspected, with warnings until each is evidenced** |
| Change control | **Any change to the budget, rates or baseline needs approval by both the administrator and the investor and creates a new baseline version; the old one is kept** |
| Evidence integrity | Camera registry, secret keys, clock and replay checks, evidence-health alerts, audit log |
| Dashboards | Investor (plain language) and engineer (technical, with standards, categories, measures, budget and schedule warnings) |
| Platform | REST API, PostgreSQL schema, authentication and per-role access, model registry, evaluation harness |

**Out of scope (stated limits)**

- Parsing drawings, PDF or IFC for the BOQ (manual BOQ entry; assisted extraction is Sprint 3).
- Automated structural-engineering certification or legal proof of corruption; real-time embedded sensors; core sampling and laboratory strength testing (28-day cylinder results would need a trusted external source, not engineer entry); full BIM; nationwide rollout.
- Crack-width measurement against PEC limits (deferred: needs calibrated imagery and a trained model).
- Detection of PPE, falls or excavation hazards (library entries exist; detection is future work).

**Scope decisions (made by the team)**

| ID | Decision | How this document applies it | Points still open |
|---|---|---|---|
| D1 | Cost must cover everything | Total cost = measured materials + labour + equipment + formwork and overheads + contingency. Only materials are measured from images; the rest are computed from inputs fixed at inception and from crews and equipment per day | Crew counts are an engineer input and could be inflated or understated; plan a cross-check against worker counts from the cameras (Sprint 2/3) |
| D2 | A lead engineer sets labour and equipment cost **once, at project inception**; not editable afterwards | No new role: the existing **engineer** role is the lead engineer. Labour and equipment rates are entered once by the engineer and then locked. **Material prices stay in the price book maintained by the administrator** (confirmed) | Locked rates go stale with inflation. Proposed resolution: they can change only through the D3 approval path |
| D3 | Change requests must pass through both the administrator and the investor | A change request is raised by the engineer, then needs approval from the administrator **and** from the investor side before it takes effect. Approval creates a new, versioned baseline; the old one and both approvals stay in the audit log | None. Investors decide among themselves; the application records one approval from an investor member of the project, as the application works today |
| D4 | A task marked done carries warnings until it is cured, finished and inspected; warnings disappear as each is evidenced; inspection is part of the safety assessment | Four states: placed, curing, finished, inspected and accepted (see 2.2.6). Progress credit is given at "placed"; quality warnings are shown beside it | See the assessment of D4 below |

**Assessment of D4.** The decision follows standard practice: construction separates work that has been *placed* from work that has been *accepted*, with inspection hold points between. Refinements: (1) keep earned-value credit at "placed" and show the quality state separately; (2) a camera cannot prove that curing was done, so the "curing" warning clears on **elapsed time since the measured pour date**, using the curing period that applies to the concrete and conditions (ACI curing guidance is commonly cited as at least 7 days for ordinary concrete or until a strength target is reached [verify against ACI 301 and ACI 308R]), and the system states that it cannot verify the curing method; (3) "finished" can be evidenced by images (formwork removed, surface finished); (4) "inspected" is an automated visual inspection by the cameras (clean frames of that element after curing) and does **not** replace structural testing; (5) the steps differ by element type (footing, column, beam, slab, masonry wall) and need an element-specific checklist.

**Success criteria (measurable)**

| ID | Criterion |
|---|---|
| SC-1 | No endpoint lets a user create, edit or close progress, spend, defects or hazards (verified by automated tests) |
| SC-2 | Frames enter only through an authenticated camera, once, with an acceptable clock (verified by tests) |
| SC-3 | Measured figures reproduce from stored observations by replay |
| SC-4 | On controlled scenes, measured progress and spend agree with the known truth within 5 % (achieved on synthetic frames: work done -1.0 %, spend -1.6 %) |
| SC-5 | Forecast statuses are correct on hand-computed scenarios |
| SC-6 | A failed analysis service never loses a frame; a silent camera is never read as safe |
| SC-7 | A trained model can replace a backend without other code changes |
| SC-8 | **On real site footage, progress and stock estimates are within [X %] of manual measurement** [team to set X after the first evaluation; this is the criterion that matters and is not yet measured] |

**Feasibility.** Sprint 1 shows the platform, the data model and the pipeline are feasible. The main risk is vision accuracy on real, cluttered sites, which is addressed by the Sprint 2 plan and by training a model with labelled data.

## 2.2 Modules

### 2.2.1 Budget Estimation Module (engineer input)
Takes the BOQ and produces quantities, a cost in PKR and the baseline schedule.
1. BOQ entry with validation (dimensions, quantity, concrete strength).
2. Concrete mix by ACI 211.1; required average strength by ACI 318; steel-ratio advisory against ACI 318 minimums.
3. Purchase quantities from loose bulk densities (compaction factor) and wastage; prices from the price book; contingency.
4. Versioned estimates that store the factors and prices used.
5. Baseline schedule (BOQ order, volume-based durations, Monday-Saturday calendar) with task budgets summing to the estimate.
6. **Inception cost inputs (engineer, once, then locked):** labour rates (per crew-day, by trade where needed), equipment hire rates and the planned equipment and crews, formwork, overhead and contingency lines. They become part of the baseline budget. Later changes follow the change-control path (2.2.9).

### 2.2.2 Evidence Ingest Module
The only path by which site evidence enters the system.
1. Camera registry (zone, yard and overview cameras) installed by an administrator.
2. Per-camera secret key, stored only as a hash; constant-time check.
3. Clock check, replay protection (unique camera and frame hash), size and content validation, daily cap.
4. Failure tolerance: a frame is stored even if analysis fails; a system alert is raised.
5. Every analysis stamped with the model name and version.

### 2.2.3 Progress and Schedule Tracking Module
1. Zone cameras report the construction stage visible at one element (and, once concrete is visible, how much of the element it covers; for masonry, the built fraction).
2. Progress per task from stages that at least two frames agree on; never decreases.
3. Earned value against the baseline: schedule performance index, forecast duration and finish date, days early or late, status.
4. Productivity: work completed against work planned per interval, with the crews on site shown beside it.

### 2.2.4 Financial Tracking Module
1. Yard cameras estimate the stock of sand, aggregate, cement, bricks and steel (calibrated ground scale per camera).
2. Consumption of a day is the stock in its first frame minus the stock in its last frame; deliveries are detected from increases between days.
3. Spend is consumption multiplied by the price-book price; the price is frozen when the day is first costed.
4. **Labour and equipment cost:** each day, crews on site x locked labour rate and equipment units available x locked hire rate accrue as actual cost, whether or not progress was made (idle crews cost money). Overhead lines accrue as fixed in the baseline.
5. Earned-value cost analysis on **total** cost: cost performance index, estimate at completion, overrun in PKR and percent, a range, status. The investor sees a breakdown (materials, labour, equipment, other) and which parts are measured from images and which are computed from inputs.

### 2.2.5 Defect Detection Module
1. Rusted rebar and honeycombed concrete from site frames (OpenCV colour and texture heuristics from the proof of concept; optional pretrained detectors; trained models via plug-ins).
2. Findings with score, severity, bounding box and violation flag, drawn on the frame for engineers.
3. Defect checks are enabled per camera by the administrator.

### 2.2.6 Risk and Hazard Module (fully automatic)
1. Structural Danger Index (0-10) from severity, density and progression, with weights that shift as inspection history grows.
2. Hazards derived from defects, from a library with category, causes, preventive and mitigating controls and the governing standard (bow-tie).
3. Likelihood x severity rating, ALARP zone, risk matrix.
4. Closure only by evidence: three consecutive clean inspection days from the same camera; days without frames change nothing.
5. Evidence-health rules: overdue cameras, unwatched tasks, "not verified" status for investors.
6. **Completion lifecycle per element** (D4): *placed* (measured from images; earned-value credit is given here) -> *curing* (warning clears after the applicable curing period has elapsed since the measured pour date; method not verifiable) -> *finished* (formwork removed and surface finished, from images) -> *inspected and accepted* (automated visual inspection by the cameras after curing, a part of the safety assessment). A task shown as done carries a warning for each step not yet evidenced; each warning is removed only by evidence, never by a person.

### 2.2.7 Dashboards
- **Investor view:** progress against plan, total money spent with a breakdown (materials, labour, equipment, other), expected final cost and overrun, expected finish date, safety light, productivity, alerts, camera photos, and for finished work whether it is still curing or awaiting inspection, in plain language with no engineering jargon.
- **Engineer view:** technical status and formulas, standards followed, estimate and mixes, danger-index breakdown, risk matrix, hazards with category, zone, standard and suggested controls, stock history, crews and equipment, camera health, latest frames and the model that measured them, and warnings when budget or timeline is not being met.

### 2.2.9 Change Control Module (D3)
1. Any change to the budget, locked rates, BOQ or baseline is raised as a change request by the engineer, with a reason.
2. It takes effect only after approval by **both** the administrator and an investor member of the project (investors agree among themselves; the system records one investor approval).
3. Approval creates a new versioned baseline; earlier versions, the requests and both approvals are kept and visible in the audit log. Measured progress and spend are never rewritten.
4. Forecasts show the baseline version they are measured against.

### 2.2.8 Platform Module
REST API, PostgreSQL schema (30 tables), JWT authentication, role-based access (investor read-only; engineer, who is the project's lead engineer; administrator), audit log, scheduled recomputation on each ingest, model registry and plug-in system, evaluation harness, training-set export.

## 2.3 Tools and Technologies

- **Frontend:** React (Vite), Recharts.
- **Backend:** Node.js with Express.
- **Database:** PostgreSQL (relational data, JSONB for raw model output and snapshots).
- **Computer vision and ML:** Python, FastAPI, OpenCV; PyTorch and a pretrained zero-shot detector as optional backends; trained models supplied as plug-ins.
- **Reference standards:** ACI 211.1, ACI 318, ACI 224R, ACI 201.1R, ACI 309R, ISO 31000, IEC 31010, ISO 45001, HSE R2P2, OSHA 29 CFR 1926, ANSI/EIA-748, PMBOK earned value [numbers to be verified against licensed copies].
- **Deployment:** Docker (written, not yet tested); cloud hosting [planned, e.g. AWS, as in the original proposal].
- **Development tooling:** Visual Studio Code, Git, Claude Code (disclosed in docs/tool-disclosure.md).
- **Datasets:** SDNET2018 and CODEBRIM (from the original proposal) for defect work; **real labelled site frames for stage and stock are to be collected in Sprint 2** [source, permissions and labelling plan to be written].

## 2.4 Work Division [proposed; team to confirm]

| Name | Reg. No. | Responsibility |
|---|---|---|
| Hadi Saleemi | 22i-1043 | Vision backends (defects, stage, stock), model registry and plug-ins, evaluation against labelled data, dataset collection, integration of the trained model [with the teammate who is training it] |
| Rayyan Khan | 22i-1002 | Database schema, backend and APIs, estimation and forecasting logic (including labour, equipment and overhead cost), evidence ingest and roll-up, risk and hazard engine, completion lifecycle, change control, tamper-resistance, tests |
| Muhammad Atyab | 22i-1191 | Web application (investor and engineer views), UX, integration with the APIs, deployment |
| [Teammate] | [reg. no.] | Training the stage / stock / defect model and delivering it as a plug-in per docs/model-integration.md |

## 2.5 Timeline

Iteration windows are kept from the original proposal. Contents are revised.

| Iteration | Window | Tasks and modules | Status |
|---|---|---|---|
| 1 | Sep-Oct 2026 | Re-scope after the pivot; schema and API; budget estimation; baseline schedule; evidence ingest with tamper controls; progress and spend measurement; earned-value forecasts; defect detection; automatic risk and hazards; investor and engineer dashboards; model registry and evaluation harness; tests and documentation | Built and tested on **synthetic** frames; real-footage accuracy not measured |
| 2 | Nov-Dec 2026 | **Real footage:** collect and label real frames; evaluate every backend with the harness; integrate the trained model; calibrate stock constants and the noise threshold; camera-tamper checks (lens covered, redirected); schedule realism (dependencies, parallel tasks, calendar, crews affecting durations); progress-versus-material cross-checks. **Total cost (D1, D2):** inception labour, equipment, formwork and overhead inputs entered by the engineer and locked; daily labour and equipment accrual; total-cost forecasts and investor breakdown. **Completion lifecycle (D4):** placed / curing / finished / inspected states, element-specific checklists, warnings cleared by evidence | Planned |
| 3 | Feb-Mar 2027 | Trained models in use; more defect and hazard classes; drawing-assisted BOQ; **change control with administrator and investor approval and versioned baselines (D3)**; cross-check of crew counts against worker counts from cameras (D1); investor PDF reports; confidence bands on forecasts; Docker deployment | Planned |
| 4 | Apr-May 2027 | Pilot on a real site; threshold calibration; end-to-end validation against manual measurement (SC-8); final report | Planned |

## 2.6 Risks to state in the report

Vision accuracy on real footage; calibration of stock constants; camera obstruction or redirection; privacy and monitoring of workers; trusted administrator; placeholders for prices and productivity; coordination between two people building models; labour cost depending on engineer-entered crew counts; locked rates going stale; curing that cannot be verified from images; automated visual inspection that cannot replace structural testing. Full register: docs/risks.md.

# References

Original references retained:

BMI, a Fitch Solutions Company. (2025). Infrastructure Project Risk Metric [Brochure]. Retrieved from fitchsolutions.com/bmi.

Dorafshan, S., Thomas, R. J., & Maguire, M. (2018). SDNET2018: An annotated image dataset for non-contact concrete crack detection using deep convolutional neural networks. Data in Brief, 21, 1664-1668.

Furtner, P., Forstner, E., & Karlusch, A. (2018). Automated infrastructure inspection based on digital twins and machine learning. Conference paper, VCE Vienna Consulting Engineers ZT GmbH and Palfinger Structural Inspection GmbH.

Khadim, N., Jaffar, S. T. A., Ajwad, A., & Ilyas, U. (2021). Effects of corruption on public infrastructure projects in developing countries: The case of Pakistan. Jordan Journal of Civil Engineering, 15(4), 507-518.

Mundt, M., Majumder, S., Murali, S., Panetsos, P., & Ramesh, V. (2019). Meta-learning convolutional neural architectures for multi-target concrete defect classification with the COncrete DEfect BRidge IMage dataset (CODEBRIM). In Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition (CVPR).

Nisar, S., & Asif, R. (2023). Factors leading to failures of infrastructure development projects in Pakistan: A systematic literature review. Management Science Letters, 13, 11-22.

Shakoor, A. (2025, as quoted). Poor infrastructure haunts Karachiites: PDP chief. Business Recorder.

**To add** [team to find, read and cite; none are listed here because they have not been verified]: earned-value management in construction; image-based progress monitoring; material-quantity estimation from images; falsification of self-reported site records; ACI 211.1, ACI 318, ISO 31000, IEC 31010, HSE R2P2, ANSI/EIA-748 (as standards).
