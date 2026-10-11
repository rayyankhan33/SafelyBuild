# Tool, dependency and AI disclosure

## 1. Generative AI use

| Tool | Used for | Output reviewed by |
|---|---|---|
| Claude Code (Anthropic, model Claude Sonnet 5.5), run inside the Claude desktop app | Drafted the Sprint 1 code in this repository: API, domain functions, database migrations, React pages, inference service wrapper, tests and the documents in `docs/`, under direction from the team | **Team members must read and be able to explain every file they own before the evaluation.** Ownership: see [ownership](#4-ownership-and-walkthrough-guide). |

What the AI did **not** do: write the research and gap-analysis sections of the report (those must be the team's own work, based on the sources cited in the proposal), decide the product pivot, or choose which standards to follow.

**Process note for the supervisor.** The Sprint 1 code volume arrived in one working session. The rubric's "sudden code volume" red flag therefore applies and the team accepts a line-level walkthrough. [implementation.md](implementation.md) lists the main files, what each function does and what happens if it is removed, to support that walkthrough.

## 2. Runtime AI and models

| Component | Source | Notes |
|---|---|---|
| OpenCV colour/texture heuristics (rust, honeycomb) | Written by the team in the POC (`services/inference/heuristics.py`) | No learned model |
| YOLO-World `yolov8s-worldv2` (optional) | Ultralytics, downloaded at first use (about 338 MB) | Zero-shot, not fine-tuned; only used if `ultralytics` is installed. Not installed or tested in Sprint 1 on the development machine |
| Material counting | None | A simulated provider exists for UI demonstration and is labelled "simulated" everywhere |

No external AI service is called at runtime. Photos never leave the machine running the inference service.

## 3. Software dependencies

| Area | Packages (see `package.json`, `requirements.txt`) |
|---|---|
| API | express, pg, zod, jsonwebtoken, bcryptjs, multer, cors |
| Web | react, react-dom, react-router-dom, recharts, vite |
| Inference | fastapi, uvicorn, python-multipart, opencv-python-headless, numpy, pytest, httpx |
| Dev database | PostgreSQL 18 binaries via the `embedded-postgres` npm package (the official installer download was blocked on the development machine) |
| Reference standards | ACI 211.1, ACI 318, ACI 224R, ACI 201.1R, ACI 309R, ISO 31000, IEC 31010, ISO 45001, HSE R2P2, OSHA 29 CFR 1926, ANSI/EIA-748, PMBOK. Numbers transcribed from memory of these documents must be verified against licensed copies (see risk R3) |
| Datasets | None used yet. Sample photos in `services/inference/samples` are the four images from the POC (source to be recorded by the team) |

## 4. Ownership and walkthrough guide

Proposed ownership follows the proposal's work division. Each member should be able to explain their area without notes.

| Area | Files | Proposed owner |
|---|---|---|
| Detection pipeline, calibration, evaluation | `services/inference/*` | Hadi Saleemi |
| Risk engine, schema, backend, estimation and forecasting logic | `db/`, `apps/api/src` | Rayyan Khan |
| Web application and UX | `apps/web/src` | Muhammad Atyab |

## 5. Data and privacy

- Demo data is fictional. The demo password in `seed.js` is for local use only.
- Real deployments will hold site photos (may show workers), GPS tags and financial figures: they need HTTPS, encrypted storage, a retention policy and worker consent for photography. None of these are implemented in Sprint 1.
- The audit log records user IDs and actions, not photo content.

## 6. Risks of tool use

See [risks.md](risks.md): R1 (AI-generated code not understood), R3 (standards values), R5 (heuristic accuracy).
