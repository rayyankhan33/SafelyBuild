// Tools the agent may call (docs/handoff-schedule-assistant.md part B, decisions G1-G4).
//
// RULE: every tool is READ-ONLY. A tool may read the database, compute a what-if in memory, or ask the
// inference service to re-analyse a stored frame and return the result. No tool inserts, updates or deletes
// anything, so the agent cannot change progress, spend, defects, hazards, forecasts, alerts or the schedule.
// This is enforced twice: by this file, and by running every tool inside a READ ONLY database transaction
// (withReadOnly), where PostgreSQL itself refuses a write.
//
// A tool sees only what the calling user's role may see: `roles` lists who may use it, and handlers that
// return dashboard data ask for the payload of ctx.user.role.
//
// ctx = { db, project, user: { id, role }, asOf, counters: {} }

import { addDays, diffDays, nextWorkingDay } from '../domain/dates.js';
import { plannedFraction } from '../domain/evm.js';
import { plannedDailyCosts } from '../domain/cost.js';
import { generateSchedule } from '../domain/schedule.js';
import { analyseDefects, analyseStage, scheduleForecast } from '../inference.js';
import * as storage from '../storage.js';

export const MAX_RESULT_CHARS = 12_000; // a larger result is cut and marked, so one tool cannot flood the model
export const MAX_REANALYSES_PER_RUN = 3;
const MAX_ROWS = 50;

const STAFF = ['engineer', 'admin'];
const ALL = ['engineer', 'admin', 'investor'];
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });
const DATE = { type: 'string', description: 'date as YYYY-MM-DD' };
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const r1 = (x) => (x === null || x === undefined ? null : Math.round(Number(x) * 10) / 10);

class ToolInputError extends Error {}
function range(ctx, args, defaultDays) {
  for (const k of ['from', 'to']) if (args[k] !== undefined && !ISO.test(args[k])) throw new ToolInputError(`"${k}" must be a date YYYY-MM-DD`);
  const to = args.to ?? ctx.asOf;
  const from = args.from ?? addDays(to, -defaultDays);
  if (diffDays(from, to) < 0) throw new ToolInputError('"from" is after "to"');
  return { from, to };
}

// ---------------------------------------------------------------------------------- handlers
async function getDashboard(ctx) {
  const { buildDashboard } = await import('../services/forecast.js');
  // admins read the engineer payload; investors only ever get the investor payload. persist:false = no writes
  const d = await buildDashboard(ctx.db, ctx.project, ctx.user.role === 'investor' ? 'investor' : 'engineer', ctx.asOf, { persist: false });
  if (!d.setup_complete) return { setup_complete: false, hint: d.setup_hint, alerts: d.alerts };
  const out = {
    project: d.project, as_of: d.as_of, headline: d.headline, alerts: d.alerts,
    evidence: { cameras_ok: d.evidence.cameras_ok, cameras_expected: d.evidence.cameras_expected, gap: d.evidence.gap },
  };
  if (ctx.user.role === 'investor') {
    out.safety_items = d.safety_items;
    out.spend_by_material = d.spend_by_material;
    return out;
  }
  const sm = d.schedule_model;
  out.model_forecast = sm ? Object.fromEntries(['baseline', 'ml', 'blend'].map((k) => [k, sm[k] && {
    status: sm[k].status, completion_date: sm[k].completion_date, remaining_days: sm[k].remaining_days,
    lower_date: sm[k].lower_date, upper_date: sm[k].upper_date,
  }])) : null;
  out.cost_warnings = d.cost.warnings;
  out.uncovered_tasks = d.evidence.uncovered_tasks;
  out.risk = { sdi: d.risk.sdi?.sdi ?? null, sdi_status: d.risk.sdi?.status ?? null, open_hazards: d.risk.hazards.filter((h) => h.status !== 'closed').length };
  return out;
}

async function getForecastHistory(ctx, args) {
  const { from, to } = range(ctx, args, 30);
  const { rows } = await ctx.db.query(
    'SELECT as_of, budget, schedule, schedule_model FROM forecasts WHERE project_id = $1 AND as_of BETWEEN $2 AND $3 ORDER BY as_of',
    [ctx.project.id, from, to]);
  const investor = ctx.user.role === 'investor';
  const pick = rows.length > 60 ? rows.filter((_, i) => i % Math.ceil(rows.length / 60) === 0 || i === rows.length - 1) : rows;
  return {
    from, to, days: rows.length,
    history: pick.map((r) => (investor ? {
      date: r.as_of, schedule_status: r.schedule.status, forecast_finish: r.schedule.forecast_end ?? null, days_late: r.schedule.days_late ?? null,
      budget_status: r.budget.status, forecast_final_cost_pkr: r.budget.eac ?? null, overrun_pkr: r.budget.overrun ?? null,
    } : {
      date: r.as_of, schedule_status: r.schedule.status, spi: r.schedule.spi ?? null, forecast_end: r.schedule.forecast_end ?? null,
      days_late: r.schedule.days_late ?? null, budget_status: r.budget.status, cpi: r.budget.cpi ?? null, eac_pkr: r.budget.eac ?? null,
      overrun_pct: r.budget.overrun_pct ?? null, model_finish: r.schedule_model?.blend?.completion_date ?? null,
    })),
  };
}

async function getScheduleTasks(ctx) {
  const { recompute } = await import('../services/forecast.js');
  const r = await recompute(ctx.db, ctx.project, ctx.asOf, { persist: false });
  if (!r.ready) return { ready: false, reason: r.reason };
  const latest = {};
  for (const p of r.state.progress) if (diffDays(p.date, ctx.asOf) >= 0) latest[p.task_id] = Math.max(latest[p.task_id] ?? 0, p.percent);
  const life = Object.fromEntries(r.lifecycle.map((l) => [l.task_id, l]));
  return {
    as_of: ctx.asOf,
    tasks: r.state.tasks.map((t) => {
      const pct = latest[t.id] ?? 0;
      const planned = Math.round(plannedFraction(t, ctx.asOf) * 1000) / 10;
      return {
        seq: t.seq, name: t.name, planned_start: t.planned_start, planned_end: t.planned_end, budget_pkr: t.planned_cost_pkr,
        percent_complete: pct, planned_percent_now: planned, gap_points: r1(pct - planned),
        days_past_planned_end: pct < 100 && diffDays(t.planned_end, ctx.asOf) > 0 ? diffDays(t.planned_end, ctx.asOf) : 0,
        lifecycle: life[t.id]?.state ?? null,
      };
    }),
  };
}

const SEVERITY_ORDER = ['Low', 'Medium', 'High', 'Critical'];
async function getDefects(ctx, args) {
  const { from, to } = range(ctx, args, 30);
  const min = SEVERITY_ORDER.indexOf(args.min_severity ?? 'Low');
  const { rows } = await ctx.db.query(
    `SELECT d.id, d.media_id, d.defect_type, d.score::float8 AS score, d.severity::text AS severity, d.is_violation, d.detected_on, c.name AS camera
     FROM defects d JOIN media m ON m.id = d.media_id LEFT JOIN cameras c ON c.id = m.camera_id
     WHERE d.project_id = $1 AND d.detected_on BETWEEN $2 AND $3 AND ($4::boolean IS NOT TRUE OR d.is_violation)
       AND array_position($5::text[], d.severity::text) > $6
     ORDER BY array_position($5::text[], d.severity::text) DESC, d.detected_on DESC LIMIT $7`,
    [ctx.project.id, from, to, args.violations_only ?? false, SEVERITY_ORDER, min, MAX_ROWS + 1]);
  return { from, to, count_shown: Math.min(rows.length, MAX_ROWS), more: rows.length > MAX_ROWS, defects: rows.slice(0, MAX_ROWS) };
}

async function getHazards(ctx, args) {
  const { loadState } = await import('../services/forecast.js');
  const state = await loadState(ctx.db, ctx.project);
  const list = state.hazards.filter((h) => !args.open_only || h.status !== 'closed').slice(0, MAX_ROWS);
  return {
    open: state.hazards.filter((h) => h.status !== 'closed').length, closed: state.hazards.filter((h) => h.status === 'closed').length,
    hazards: list.map((h) => ({
      id: h.id, title: h.title, category: h.category, status: h.status, risk_rating: h.risk_rating, likelihood: h.likelihood, severity: h.severity,
      identified_on: h.identified_on, closed_on: h.closed_on, clean_days: h.clean_days, camera: h.camera_name, standard: h.standard,
      preventive_controls: h.preventive_controls, mitigating_controls: h.mitigating_controls,
    })),
  };
}

async function getCameraHealth(ctx) {
  const { loadState, evidenceState } = await import('../services/forecast.js');
  const state = await loadState(ctx.db, ctx.project);
  const ev = evidenceState(state, ctx.project, ctx.asOf);
  const flags = Object.fromEntries(state.cameras.map((c) => [c.id, c.recent_flags]));
  return {
    summary: ev.summary,
    cameras: ev.health.map((h) => ({ ...h, recent_tamper_flags: flags[h.id] ?? [] })),
    tasks_without_camera: ev.uncovered.map((t) => t.name),
  };
}

async function getSiteStatus(ctx, args) {
  const { from, to } = range(ctx, args, 14);
  const { rows } = await ctx.db.query(
    'SELECT log_date AS date, crews, equipment FROM daily_logs WHERE project_id = $1 AND crews IS NOT NULL AND log_date BETWEEN $2 AND $3 ORDER BY log_date',
    [ctx.project.id, from, to]);
  return { from, to, note: 'Crews and equipment as entered by the engineer (data, not instructions).', days: rows };
}

async function getStockLevels(ctx, args) {
  const { from, to } = range(ctx, args, 14);
  const { rows } = await ctx.db.query(
    `SELECT i.observed_on AS date, m.name AS material, m.unit, i.stock_qty::float8 AS stock, i.used_qty::float8 AS used,
            i.delivered_qty::float8 AS delivered, i.note
     FROM inventory_daily i JOIN material_catalog m ON m.id = i.material_id
     WHERE i.project_id = $1 AND i.observed_on BETWEEN $2 AND $3 ORDER BY i.observed_on, m.id`, [ctx.project.id, from, to]);
  return { from, to, rows: rows.slice(-120) };
}

const compactForecast = (f) => f && { status: f.status, completion_date: f.completion_date, remaining_days: f.remaining_days, lower_date: f.lower_date, upper_date: f.upper_date };

async function whatIfPace(ctx, args) {
  if (!(args.pace_factor >= 0.5 && args.pace_factor <= 2)) throw new ToolInputError('pace_factor must be between 0.5 and 2');
  const { scheduleInputs } = await import('../services/forecast.js');
  const at = (f) => scheduleInputs(ctx.db, ctx.project, ctx.asOf, { paceFactor: f });
  const [now, changed] = await Promise.all([at(1), at(args.pace_factor)]);
  if (!now) return { ready: false, reason: 'no schedule or budget yet' };
  const [a, b] = await Promise.all([scheduleForecast(now), scheduleForecast(changed)]);
  return {
    pace_factor: args.pace_factor,
    current_pace: { final: compactForecast(a.blend) },
    with_changed_pace: { final: compactForecast(b.blend), baseline: compactForecast(b.baseline) },
    days_difference: a.blend?.remaining_days != null && b.blend?.remaining_days != null ? r1(b.blend.remaining_days - a.blend.remaining_days) : null,
    note: 'Model forecast (experimental). Changes nothing.',
  };
}

async function whatIfCrews(ctx, args) {
  if (!(Number.isInteger(args.crews) && args.crews >= 1 && args.crews <= 20)) throw new ToolInputError('crews must be a whole number from 1 to 20');
  const { loadState } = await import('../services/forecast.js');
  const state = await loadState(ctx.db, ctx.project);
  if (!state.tasks.length) return { ready: false, reason: 'no schedule yet' };
  const latest = {};
  for (const p of state.progress) if (diffDays(p.date, ctx.asOf) >= 0) latest[p.task_id] = Math.max(latest[p.task_id] ?? 0, p.percent);
  const { rows: elements } = await ctx.db.query('SELECT * FROM design_elements WHERE project_id = $1', [ctx.project.id]);
  const { rows: prod } = await ctx.db.query('SELECT * FROM productivity_rates');
  const productivity = prod.map((p) => ({ ...p, output_per_day: Number(p.output_per_day) }));
  const byId = Object.fromEntries(elements.map((e) => [e.id, e]));
  // remaining work only: each unfinished element in schedule order, its length cut to the share still to build
  const remaining = state.tasks.filter((t) => (latest[t.id] ?? 0) < 100 && byId[t.element_id]).sort((x, y) => x.seq - y.seq).map((t) => {
    const e = byId[t.element_id];
    const left = Math.max(0.02, 1 - (latest[t.id] ?? 0) / 100);
    const num = (x) => (x === null ? null : Number(x));
    return { ...e, quantity: Number(e.quantity), length_m: Number(e.length_m) * left, width_m: num(e.width_m), height_m: num(e.height_m), thickness_m: num(e.thickness_m) };
  });
  if (!remaining.length) return { ready: true, note: 'every task is complete' };
  const currentCrews = state.crews.at(-1)?.crews ?? ctx.project.planned_crews ?? 1;
  const start = nextWorkingDay(ctx.asOf);
  const plan = (crews) => {
    const s = generateSchedule(remaining, productivity, Object.fromEntries(remaining.map((e) => [e.id, 0])), start, crews);
    return { finish: s.tasks.at(-1).planned_end, working_days: s.tasks.reduce((n, t) => n + t.duration_days, 0) };
  };
  const base = plan(currentCrews);
  const alt = plan(args.crews);
  const rates = state.costRates;
  const labour = (crews, days) => (rates ? plannedDailyCosts(rates, crews).labour * days : null);
  const extra = rates ? Math.round(labour(args.crews, alt.working_days) - labour(currentCrews, base.working_days)) : null;
  return {
    method: 'Remaining work rescheduled with the platform schedule generator (finish-to-start, Mon-Sat), from the next working day. Changes nothing.',
    current_crews: currentCrews, crews: args.crews,
    finish_with_current_crews: base.finish, finish_with_crews: alt.finish,
    days_saved: diffDays(alt.finish, base.finish),
    extra_labour_cost_pkr: extra,
    labour_note: rates ? `crew rate PKR ${rates.crew_rate_pkr} per crew-day` : 'no cost rates set: labour cost unknown',
    caveat: 'Ignores how many crews can work on one element at once and any material or space limits.',
  };
}

async function frameFor(ctx, mediaId) {
  if (!UUID.test(String(mediaId))) throw new ToolInputError('media_id must be a uuid');
  const m = (await ctx.db.query(
    `SELECT m.id, m.storage_key, m.content_type, m.captured_at, l.log_date AS date, m.camera_id, c.name AS camera, c.kind, c.element_id,
            e.element_type::text AS element_type, e.label AS element
     FROM media m LEFT JOIN daily_logs l ON l.id = m.daily_log_id LEFT JOIN cameras c ON c.id = m.camera_id
     LEFT JOIN design_elements e ON e.id = c.element_id WHERE m.id = $1 AND m.project_id = $2`, [mediaId, ctx.project.id])).rows[0];
  if (!m) throw new ToolInputError('no such frame in this project');
  return m;
}

async function getFrameContext(ctx, args) {
  const m = await frameFor(ctx, args.media_id);
  const runs = (await ctx.db.query(
    `SELECT kind::text AS kind, backend, status::text AS status, error, result->'model' AS model,
            result->'stage' AS stage, result->'fraction' AS fraction, jsonb_array_length(COALESCE(result->'findings', '[]'::jsonb)) AS findings
     FROM inference_runs WHERE media_id = $1 ORDER BY started_at`, [m.id])).rows;
  const health = (await ctx.db.query('SELECT flags, metrics FROM camera_health_checks WHERE media_id = $1', [m.id])).rows[0] ?? null;
  const around = m.camera_id ? (await ctx.db.query(
    `SELECT observed_on AS date, stage, fraction::float8 AS fraction, backend FROM stage_observations
     WHERE camera_id = $1 AND observed_on BETWEEN $2::date - 3 AND $2::date + 3 ORDER BY observed_on`, [m.camera_id, m.date])).rows : [];
  const defects = (await ctx.db.query('SELECT defect_type, severity::text AS severity, score::float8 AS score, is_violation FROM defects WHERE media_id = $1', [m.id])).rows;
  return {
    frame: { id: m.id, date: m.date, captured_at: m.captured_at, camera: m.camera, camera_kind: m.kind, element: m.element, element_type: m.element_type },
    analyses: runs, defects, camera_health: health, same_camera_stage_observations_pm3_days: around,
  };
}

async function reanalyseFrame(ctx, args) {
  ctx.counters ??= {};
  ctx.counters.reanalyse = (ctx.counters.reanalyse ?? 0) + 1;
  if (ctx.counters.reanalyse > MAX_REANALYSES_PER_RUN) throw new ToolInputError(`at most ${MAX_REANALYSES_PER_RUN} re-analyses per run`);
  if (!/^[A-Za-z0-9_\-.]{1,60}$/.test(args.backend)) throw new ToolInputError('backend must be a backend name, e.g. opencv_tiles, crack_cnn, classical_color');
  const m = await frameFor(ctx, args.media_id);
  const bytes = await storage.read(m.storage_key);
  if (args.task === 'stage') {
    if (!m.element_type) throw new ToolInputError('this frame is not from a zone camera, so it has no construction stage');
    const r = await analyseStage(bytes, m.content_type, m.element_type, { backend: args.backend });
    return { task: 'stage', backend: args.backend, stage: r.stage, fraction: r.fraction ?? null, model: r.model ?? null, stored: false };
  }
  const r = await analyseDefects(bytes, m.content_type, { backend: args.backend });
  return {
    task: 'defects', backend: args.backend, model: r.model ?? null, stored: false,
    findings: (r.findings ?? []).slice(0, 20).map((f) => ({ defect_type: f.defect_type, severity: f.severity, score: f.score, is_violation: f.is_violation })),
  };
}

/** @type {{name: string, description: string, parameters: object, roles: string[], handler: (ctx, args) => Promise<any>}[]} */
export const TOOLS = [
  { name: 'get_dashboard', roles: ALL, parameters: obj(), handler: getDashboard,
    description: 'Current project status for your reader: percent complete vs plan, budget and schedule forecasts with status, safety, open alerts. Call this first.' },
  { name: 'get_forecast_history', roles: ALL, parameters: obj({ from: DATE, to: DATE }), handler: getForecastHistory,
    description: 'Day-by-day history of the budget and schedule forecasts (SPI, CPI, forecast finish date, model forecast) to see when a problem started. Default: last 30 days.' },
  { name: 'get_schedule_tasks', roles: STAFF, parameters: obj(), handler: getScheduleTasks,
    description: 'Every schedule task with planned dates, percent complete vs planned percent today, days past its planned end and lifecycle state. Use to find which task is causing a delay.' },
  { name: 'get_defects', roles: STAFF, handler: getDefects,
    parameters: obj({ from: DATE, to: DATE, min_severity: { type: 'string', enum: ['Low', 'Medium', 'High', 'Critical'] }, violations_only: { type: 'boolean' } }),
    description: 'Detected defects with type, severity, score, date, camera and media id (most severe first, at most 50). Filter by date range (default last 30 days), minimum severity, or violations only.' },
  { name: 'get_hazards', roles: STAFF, parameters: obj({ open_only: { type: 'boolean' } }), handler: getHazards,
    description: 'Safety hazards raised from camera evidence, with risk rating, category, standard and suggested controls.' },
  { name: 'get_camera_health', roles: STAFF, parameters: obj(), handler: getCameraHealth,
    description: 'Per camera: last frame date, overdue or not, and recent tamper flags (covered, blurred, redirected); tasks no camera watches. Use before trusting or doubting a measurement.' },
  { name: 'get_site_status', roles: STAFF, parameters: obj({ from: DATE, to: DATE }), handler: getSiteStatus,
    description: 'Crews and equipment on site per day as entered by the engineer (default last 14 days). Use to explain a slow or fast period.' },
  { name: 'get_stock_levels', roles: STAFF, parameters: obj({ from: DATE, to: DATE }), handler: getStockLevels,
    description: 'Material stock measured by the yard cameras per day (stock, used, delivered, unconfirmed drops). Use to check whether a material shortage explains a stall.' },
  { name: 'whatif_pace', roles: ALL, handler: whatIfPace,
    parameters: obj({ pace_factor: { type: 'number', description: 'between 0.5 and 2; 1.2 = 20 % faster' } }, ['pace_factor']),
    description: 'Recompute the model completion forecast if the future pace changes by a factor (1.2 = 20 % faster, 0.8 = 20 % slower). Returns finish date and range. Changes nothing.' },
  { name: 'whatif_crews', roles: STAFF, handler: whatIfCrews,
    parameters: obj({ crews: { type: 'integer', description: 'between 1 and 20' } }, ['crews']),
    description: 'Reschedule the remaining work in memory with a different number of crews and return the new finish date, days saved and extra labour cost. Changes nothing.' },
  { name: 'get_frame_context', roles: STAFF, handler: getFrameContext,
    parameters: obj({ media_id: { type: 'string' } }, ['media_id']),
    description: 'For one media id: the stored analyses and which model produced them, defects found, camera health flags, and the stage observations of the same camera in the 3 days before and after.' },
  { name: 'reanalyse_frame', roles: STAFF, handler: reanalyseFrame,
    parameters: obj({ media_id: { type: 'string' }, task: { type: 'string', enum: ['defects', 'stage'] }, backend: { type: 'string', description: 'defects: opencv_tiles, crack_cnn or tiles_and_cracks; stage: classical_color' } }, ['media_id', 'task', 'backend']),
    description: 'Run a stored frame through a different analysis backend and return its result for comparison. The stored result is NOT replaced. At most 3 per run.' },
];

/** Tool definitions (without handlers) that `role` may use, optionally limited to the names in `allow`. */
export function toolsForRole(role, allow = null) {
  return TOOLS.filter((t) => t.roles.includes(role) && (!allow || allow.includes(t.name)))
    .map(({ name, description, parameters }) => ({ name, description, parameters }));
}

/** Minimal JSON-Schema check (object, required, primitive types, enum): enough to reject malformed model input. */
export function validateArgs(schema, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return 'arguments must be an object';
  for (const key of schema.required ?? []) if (args[key] === undefined) return `missing argument "${key}"`;
  for (const [key, value] of Object.entries(args)) {
    const spec = schema.properties?.[key];
    if (!spec) return `unknown argument "${key}"`;
    const ok = spec.type === 'integer' ? Number.isInteger(value)
      : spec.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : typeof value === spec.type;
    if (!ok) return `argument "${key}" must be ${spec.type}`;
    if (spec.enum && !spec.enum.includes(value)) return `argument "${key}" must be one of ${spec.enum.join(', ')}`;
  }
  return null;
}

/**
 * Run one tool call for the agent loop. Bad model input (unknown tool, tool not allowed for the role, wrong
 * arguments) and tool failures come back as { ok: false, error } so the model can correct itself.
 * Gemini sends whole numbers as floats sometimes ("crews": 2.0); integers are normalised first.
 */
export async function executeTool(ctx, call, allow = null) {
  const tool = TOOLS.find((t) => t.name === call.name);
  if (!tool || (allow && !allow.includes(tool.name))) return { ok: false, error: `unknown tool "${call.name}"` };
  if (!tool.roles.includes(ctx.user.role)) return { ok: false, error: `tool "${call.name}" is not available to your reader` };
  const args = { ...(call.args ?? {}) };
  for (const [k, spec] of Object.entries(tool.parameters.properties ?? {})) {
    if (spec.type === 'integer' && typeof args[k] === 'number' && Number.isInteger(Math.round(args[k])) && Math.abs(args[k] - Math.round(args[k])) < 1e-9) args[k] = Math.round(args[k]);
  }
  const problem = validateArgs(tool.parameters, args);
  if (problem) return { ok: false, error: problem };
  // inside withReadOnly each tool runs under a savepoint: a failed statement must not abort the later tools
  const sp = ctx.savepoints ? ctx.db : null;
  try {
    if (sp) await sp.query('SAVEPOINT agent_tool');
    const data = await tool.handler(ctx, args);
    if (sp) await sp.query('RELEASE SAVEPOINT agent_tool');
    const text = JSON.stringify(data ?? null);
    if (text.length > MAX_RESULT_CHARS) {
      return { ok: true, truncated: true, data: text.slice(0, MAX_RESULT_CHARS), note: 'result was cut; narrow the request (dates, filters)' };
    }
    return { ok: true, data };
  } catch (e) {
    if (sp) await sp.query('ROLLBACK TO SAVEPOINT agent_tool').catch(() => {});
    if (e instanceof ToolInputError) return { ok: false, error: e.message };
    return { ok: false, error: `tool failed: ${e.message}` };
  }
}

/**
 * Run `fn(client)` inside a READ ONLY transaction, so the database itself rejects any write a tool attempts.
 * Always rolls back. `pool` is the pg Pool.
 */
export async function withReadOnly(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    return await fn(client);
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}
