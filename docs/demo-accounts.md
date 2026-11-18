# Demo accounts (local demo only)

Created by `npm run db:seed` (also run automatically by `npm run dev`). Sign in at http://localhost:5173.
Never use these on a shared or public deployment: the password is in the source code. Set the `DEMO_PASSWORD` environment variable before seeding to choose your own.

| Role | Email | Password | Name in the app |
|---|---|---|---|
| Investor (read-only, plain language) | `investor@demo.safelybuild.test` | `SafelyBuild-Demo-1` | Bilal Chaudhry |
| Site engineer (BOQ/budget, crews, equipment; technical view) | `engineer@demo.safelybuild.test` | `SafelyBuild-Demo-1` | Ayesha Malik |
| Administrator (manages accounts and project access, installs cameras, edits the price book; **cannot create projects**) | `admin@demo.safelybuild.test` | `SafelyBuild-Demo-1` | Demo Admin |

**What each account sees.** Investor: Summary, Budget, Progress & schedule, Safety, Site photos. Engineer: Overview, Design & estimate, Schedule, Crews & equipment, Evidence, Risk & safety, Test footage. Administrator: Summary, Cameras, Price book, Access, Audit log. The roles do not overlap: each is refused the others' actions.

The demo project "Margalla Heights - Residential Block A" is flagged **demo**: its camera frames are synthetic drawings (a "Demo project" banner appears in both views). Both the investor and the engineer are members of it.

## What to check in each UI

**Investor** (signed in as Bilal):
- Project list shows the project with a Demo badge and status badges.
- Dashboard: Progress, Money spent so far, Expected finish, Site safety cards; "In plain words" and "Needs attention"; four charts (each with "Show table"); recent camera photos; a note that all figures are measured from cameras.
- No tabs, no forms, no technical terms.

**Engineer** (signed in as Ayesha):
- Six tabs: Overview, Design & estimate, Schedule, Crews & equipment, Evidence, Risk & safety.
- Design & estimate: the BOQ and the budget estimate (the engineer's only large input). Prices are read-only.
- Crews & equipment: the only daily entry. There is **no** screen to enter progress, materials, defects or hazards.
- Evidence: cameras and their health, latest frames and what was measured.
- Risk & safety: read-only danger index breakdown, risk matrix, hazards (categories, ALARP zone, bow-tie, automatic closing).

**Completion forecast** (engineer, Schedule tab): the "Model forecast (experimental)" panel shows the earned-value date beside the baseline, ML and blended forecasts, a chart with the likely finish range, "Explain this forecast", and a pace slider ("what if the pace is 20 % faster?").

**AI assistant** (only when the server has `AGENT_ENABLED=1`; see [assistant.md](assistant.md)): an "AI assistant" tab for the engineer and the investor (daily brief and questions), "Suggest recovery options" on the engineer's Schedule tab while the schedule is behind, "AI checks of doubtful frames" on the Evidence tab, the brief on the investor Summary, and an "AI activity" tab for the admin. Try asking: "Why are we behind schedule?", "What if we add a crew?", or (as the investor) "When will the building be finished?".

**Administrator** (signed in as Demo Admin): sees every project but has no "start a new project" form. Extras: the **Accounts** page (create and delete accounts; no delete button on your own row), an **Access** tab on each project (add or remove who can see it), "Install a camera" in the Evidence tab (the key is shown once), an editable price book, and the **bell** in the top bar.

**Try the notification:** sign in as the engineer and create a project; then sign in as the admin: the bell shows an unread count and a "New project created" message naming the engineer and the project (clicking it opens the project). The demo already contains one, for the seeded project.

## Trying the camera path yourself

1. As the admin, Evidence tab, install an "Inspection / overview" camera and copy its key.
2. `node scripts/camera-sim.mjs --key <key> --file "services/inference/samples/Rusted Rebar 2.jpg"`
3. Reload: the frame appears under "Latest frames", defects appear in Risk & safety, and a hazard is raised.

To rebuild the demo data from scratch: `npm run db:reseed`.
