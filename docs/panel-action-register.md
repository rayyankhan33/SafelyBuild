# Panel Action Register (Form 10)

**To be completed by the team from the proposal-defense panel notes.** The actions the panel actually gave are not in this repository, so none are listed as received. Each action needs a status and a live evidence link (a file, a commit, or a command that can be run in the meeting).

| # | Panel action (copy exactly from the panel) | Status | Live evidence |
|---|---|---|---|
| 1 | _(fill in)_ | | |
| 2 | _(fill in)_ | | |
| 3 | _(fill in)_ | | |

## Changes the team made on its own after the proposal (not panel actions)

| Change | Evidence |
|---|---|
| Pivot from regulator/blacklist product to investor + engineer product | docs/srs.md section 1, docs/design.md section 9 |
| Added financial tracking and schedule tracking modules | docs/srs.md FR-04 to FR-18; domain tests |
| Kept risk scoring, risk matrix, ALARP, bow-tie | FR-19 to FR-21; `domain/risk.js` |
| Replaced SQLite/Streamlit POC with PostgreSQL schema and web app; POC code reused as the inference engine | `services/inference`, `db/migrations` |
