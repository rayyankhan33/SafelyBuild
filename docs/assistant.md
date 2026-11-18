# AI assistant (agentic)

An assistant built on a language model (Google Gemini) that **investigates** the project's own data before it answers:
it decides which data to look up, calls tools, reads the results, looks further if needed, then writes. It can only
read and advise. Off unless the server sets `AGENT_ENABLED=1`.

## 1. What it does

| Job | Started by | Who sees it | What it does |
|---|---|---|---|
| Daily site brief | **automatically**, when alerts open or close (once per day per audience); engineers can also ask for it | engineer (technical), investor (plain words), admin | Investigates each open alert across forecast history, tasks, defects, hazards, camera health, crews and stock; writes the likely cause, the evidence, what it could not confirm, and at most three actions. Notification bell |
| Ask the project | user, "AI assistant" tab | all three | Answers questions using only the tools the user's role allows |
| Recovery options | engineer, on the Schedule page when the schedule is at risk or behind | engineer, admin | Finds the tasks causing the delay, tests options with the what-if tools (more crews, faster pace), compares them in a table and recommends one |
| Evidence check | **automatically**, after a frame is flagged by tamper screening or shows an earlier stage than before | engineer, admin | Looks at the frame's context and the camera's health, may re-analyse the frame with another model, gives a verdict (plausible / doubtful / needs a human look) on the Evidence page |
| AI activity | - | admin | Every run: job, tools called with arguments, status, tokens, which key of the pool |

## 2. How it works

```
trigger (route, recompute, ingest) -> runJob (apps/api/src/agent/jobs.js)
   system prompt (rules + reader + task) and the tools this role may use
   BEGIN TRANSACTION READ ONLY
     loop (loop.js): model -> tool calls -> results -> model ... -> answer
     at most 8-10 model calls, 16 tool calls, 120 s; at a limit the model must answer with what it has
   ROLLBACK
   number check (grounding.js) -> store in agent_runs (migration 010) -> show / notify
```

12 tools (`tools.js`), all read-only: `get_dashboard`, `get_forecast_history`, `get_schedule_tasks`, `get_defects`,
`get_hazards`, `get_camera_health`, `get_site_status`, `get_stock_levels`, `whatif_pace` (model forecast with a
changed pace), `whatif_crews` (remaining work rescheduled in memory with the platform's schedule generator, with the
extra labour cost), `get_frame_context`, `reanalyse_frame` (another backend's opinion; never stored).

## 3. Guardrails

| Risk | Protection | Tested by |
|---|---|---|
| The AI changes project data | No tool writes anything, **and** all tools run inside a `READ ONLY` PostgreSQL transaction, so the database refuses any write | `api.test.js` TC-API-AGENT: write refused with error 25006; row counts unchanged after every tool runs |
| An investor sees engineering detail | Tools are filtered by role in code (investors get 3 tools and the investor dashboard only) | TC-API-AGENT; adversarial question A2 |
| An invented number reaches a non-expert | Every number and date in an answer must appear in the data the tools returned (rounding, %, lakh/crore and written dates understood). Engineers see a warning listing unmatched figures; for investors the answer is **withheld** and the normal dashboard text is shown | TC-API-AGENT; `agent.core.test.js` |
| Prompt injection through engineer-entered text | Tool text is labelled as data; the prompt forbids following it; and even a fooled model has no write tool | adversarial question A3 |
| Runaway cost or loops | Step, tool-call and time limits; `AGENT_DAILY_RUN_LIMIT` runs per project per day (default 100); triage at most `AGENT_TRIAGE_PER_DAY` | TC-API-AGENT, `agent.core.test.js` |
| API keys leak | Keys only in `.env` (git-ignored); sent in a header, never a URL; scrubbed from error messages; runs store the key's index only | `agent.gemini.test.js` |
| The model service is down or rate-limited | Several keys rotate on HTTP 429 (key rested for the retry delay Google gives); a failure is stored and shown as "could not answer"; dashboards, ingest and forecasts never wait for the model | `agent.gemini.test.js`, TC-API-AGENT |

Everything the assistant writes carries the label "AI-generated. Check it against the figures on the dashboard."

## 4. Setup

In `.env` at the repository root (git-ignored; never commit keys):

```
AGENT_ENABLED=1
GEMINI_API_KEYS=key1,key2          # one or more free-tier keys from Google AI Studio
# GEMINI_MODEL=gemini-3.5-flash-lite  (default; any current Gemini model with function calling)
# GEMINI_THINKING_LEVEL=MINIMAL       optional, Gemini 3+ only
# AGENT_DAILY_BRIEFS=0  AGENT_TRIAGE=0  AGENT_DAILY_RUN_LIMIT=100
```

With `AGENT_ENABLED=1` and no keys, the assistant runs in **offline demo mode**: it reads the dashboard through the
same tools and prints the headline figures, clearly labelled as not an analysis. Useful when there is no internet.

**Data sent to Google** when Gemini is used: the project's numbers, dates, statuses, task, element, camera and
material names, alert texts and the user's question. **Not sent:** images, user names, e-mail addresses, the
organisation's name. Free-tier requests may be used by Google to improve its products; do not enable it for a real
client's project without their consent. Rate limits apply per Google Cloud project, not per key.

## 5. Results with the real model

`node scripts/agent-eval.mjs --repeat 2` asks 10 questions with known answers and 3 adversarial ones through the
running API and writes [agent-eval.md](agent-eval.md). Final run on 2026-11-18 with `gemini-3.5-flash-lite` (free
tier) on the demo project: **19/20** golden answers correct, **6/6** guardrail checks passed, 0 failed runs, project
data unchanged, about 7 s per answer, about 4,300 tokens per answer.

The one miss shows the number check working: asked by the investor when the building will be finished, the model
gave the right finish date but wrote the planned end as "2030-01-30" (it is 2027-01-30). That date is not in the
data it read, so the answer was **withheld** from the investor and the dashboard text was shown instead. The same
question was answered correctly in the other run. An earlier run (20/20) had also withheld a *correct* investor
answer because "30 January 2027" was read as the number 30; written-out dates are now understood, and tested.

A daily brief and a recovery plan from the real model were also checked by hand: the brief named the late tasks,
the hazard ratings, the stale cameras and three actions (25 figures, all found in the data); the recovery plan
tested 6 crews and a 20 % faster pace with the what-if tools and compared them in a table (30 figures, all found).

Small sample on one demo project: these are indications. The model is not deterministic and Google changes models;
rerun the script after changing the model.

## 6. Limits

1. The number check catches invented figures, not wrong reasoning or a misleading choice of facts, and it flags
   arithmetic the model did itself (the prompt tells it to use the what-if tools instead).
2. Answers depend on the measurements: if the cameras are wrong, the assistant is confidently wrong too. It says
   so when cameras are stale.
3. `whatif_crews` ignores how many crews fit on one element and material or space limits (stated in its result).
4. No structural-safety sign-off or legal advice: the prompt points to the responsible engineer.
5. Needs internet and a working Google key at demo time; keep offline mode rehearsed as the fallback.

## 7. Files

| File | Role |
|---|---|
| `apps/api/src/agent/llm.js` | provider interface; Gemini REST client with key rotation; scripted and offline providers |
| `apps/api/src/agent/loop.js` | the tool-calling loop with hard limits |
| `apps/api/src/agent/tools.js` | the 12 read-only tools, role filter, argument check, read-only transaction |
| `apps/api/src/agent/grounding.js` | number and date check |
| `apps/api/src/agent/jobs.js` | the four jobs, prompts, `runJob`, the two automatic triggers |
| `apps/api/src/routes/agent.js` | HTTP routes |
| `apps/web/src/components/Assistant.jsx` | brief, chat, recovery, triage list, admin log |
| `db/migrations/010_agent_runs.sql` | the run log |
| `scripts/agent-eval.mjs` | real-model evaluation |
