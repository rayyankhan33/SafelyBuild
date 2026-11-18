-- Migration 010: the AI assistant's run log (docs/handoff-schedule-assistant.md part B, decisions G1-G14).
--
-- The assistant can only READ project data (its tools run in a read-only transaction). Its own output is the
-- only thing it produces, and it is stored here: what was asked, which tools it called with which arguments,
-- the answer, the number-grounding check, the model and token counts. Tool RESULTS are not stored (they are
-- large and can be reproduced from the database). API keys are never stored: only which key of the pool.

CREATE TABLE agent_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job             text NOT NULL CHECK (job IN ('daily_analyst', 'chat', 'recovery_planner', 'evidence_triage')),
  audience        text NOT NULL CHECK (audience IN ('engineer', 'admin', 'investor')),
  started_by      uuid REFERENCES users(id) ON DELETE SET NULL,     -- NULL = started by the system
  conversation_id uuid,                                             -- chat: groups the turns of one conversation
  as_of           date NOT NULL,
  media_id        uuid REFERENCES media(id) ON DELETE CASCADE,      -- evidence_triage only
  status          text NOT NULL CHECK (status IN ('running', 'answered', 'step_limit', 'deadline', 'withheld', 'failed')),
  question        text,                                             -- user message or trigger reason
  answer          text,
  verdict         text CHECK (verdict IN ('plausible', 'doubtful', 'needs_review')),   -- evidence_triage only
  steps           jsonb NOT NULL DEFAULT '[]',                      -- model calls: text + tool names and arguments
  grounding       jsonb,                                            -- {grounded, checked, ungrounded}
  provider        text NOT NULL,
  model           text NOT NULL,
  key_index       integer,                                          -- which key of the pool (never the key itself)
  input_tokens    integer NOT NULL DEFAULT 0,
  output_tokens   integer NOT NULL DEFAULT 0,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX idx_agent_runs_project ON agent_runs (project_id, created_at DESC);
CREATE INDEX idx_agent_runs_conversation ON agent_runs (conversation_id, created_at) WHERE conversation_id IS NOT NULL;
-- one daily brief per project, day and audience (a failed attempt may be retried)
CREATE UNIQUE INDEX uq_agent_daily ON agent_runs (project_id, as_of, audience) WHERE job = 'daily_analyst' AND status <> 'failed';
-- one triage per frame (a failed attempt may be retried)
CREATE UNIQUE INDEX uq_agent_triage ON agent_runs (media_id) WHERE job = 'evidence_triage' AND status <> 'failed';
