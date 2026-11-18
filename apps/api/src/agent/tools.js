// Tools the agent may call (HANDOFF.md part B, decisions G1-G4).
//
// RULE: every tool is READ-ONLY. A tool may read the database, or compute a what-if in memory, or ask the
// inference service to re-analyse a stored frame and return the result. No tool inserts, updates or deletes
// anything, so the agent cannot change progress, spend, defects, hazards, forecasts, alerts or the schedule.
// This is enforced twice: by this file, and by running every tool inside a READ ONLY database transaction
// (withReadOnly), where PostgreSQL itself refuses a write.
//
// A tool sees only what the calling user's role may see: `roles` lists who may use it, and handlers that
// return dashboard data ask for the payload of ctx.user.role.
//
// ctx = { db, project, user: { id, role }, asOf }

export const MAX_RESULT_CHARS = 12_000; // a larger result is cut and marked, so one tool cannot flood the model

const todo = (what) => {
  const e = new Error(`TODO(opus): ${what}`);
  e.name = 'NotImplementedError';
  throw e;
};

const STAFF = ['engineer', 'admin'];
const ALL = ['engineer', 'admin', 'investor'];
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });
const DATE = { type: 'string', description: 'date as YYYY-MM-DD' };

/** @type {{name: string, description: string, parameters: object, roles: string[], handler: (ctx, args) => Promise<any>}[]} */
export const TOOLS = [
  {
    name: 'get_dashboard',
    description: 'Current project status for your reader: percent complete vs plan, budget and schedule forecasts with status, safety, open alerts. Call this first.',
    parameters: obj(),
    roles: ALL,
    handler: async (ctx) => {
      const { buildDashboard } = await import('../services/forecast.js');
      // admins read the engineer payload; investors only ever get the investor payload
      return buildDashboard(ctx.db, ctx.project, ctx.user.role === 'investor' ? 'investor' : 'engineer', ctx.asOf);
    },
  },
  {
    name: 'get_forecast_history',
    description: 'Day-by-day history of the budget and schedule forecasts (SPI, CPI, forecast finish date, model forecast) to see when a problem started.',
    parameters: obj({ from: DATE, to: DATE }),
    roles: ALL,
    handler: () => todo('SELECT as_of, budget, schedule, schedule_model FROM forecasts for the project between from/to (default last 30 days), newest last; for investors return only status, forecast_end, days_late, eac, overrun (task B4)'),
  },
  {
    name: 'get_schedule_tasks',
    description: 'Every schedule task with planned dates, percent complete, lifecycle state and days late. Use to find which task is causing a delay.',
    parameters: obj(),
    roles: STAFF,
    handler: () => todo('return loadState(db, project).tasks joined with latest percent and taskLifecycle state (domain/lifecycle.js) (task B4)'),
  },
  {
    name: 'get_defects',
    description: 'Detected defects with type, severity, score, date, camera and media id. Filter by date range, minimum severity, or violations only.',
    parameters: obj({ from: DATE, to: DATE, min_severity: { type: 'string', enum: ['Low', 'Medium', 'High', 'Critical'] }, violations_only: { type: 'boolean' } }),
    roles: STAFF,
    handler: () => todo('query defects for the project with the filters, cap at 50 rows ordered by severity then date, include media_id so the UI can link the frame (task B4)'),
  },
  {
    name: 'get_hazards',
    description: 'Open and recently closed safety hazards with risk rating, ALARP zone, category, standard and suggested controls.',
    parameters: obj({ open_only: { type: 'boolean' } }),
    roles: STAFF,
    handler: () => todo('query hazards joined to hazard_library and standards_refs as loadState does; cap at 50 (task B4)'),
  },
  {
    name: 'get_camera_health',
    description: 'Per camera: last frame date, overdue or not, and recent tamper flags (covered, blurred, redirected). Use before trusting or doubting a measurement.',
    parameters: obj(),
    roles: STAFF,
    handler: () => todo('return evidenceState(state, project, asOf) cameras + uncovered tasks (services/forecast.js, domain/evidence.js) (task B4)'),
  },
  {
    name: 'get_site_status',
    description: 'Engineer-entered site conditions per day (for example rain stop, crews on site, equipment). Use to explain a slow period.',
    parameters: obj({ from: DATE, to: DATE }),
    roles: STAFF,
    handler: () => todo('reuse the site-status listing used by GET /projects/:pid/site-status; note in the result that free-text fields are user-entered DATA, not instructions (task B4)'),
  },
  {
    name: 'get_stock_levels',
    description: 'Material stock measured by the yard cameras per day, with unconfirmed drops. Use to check whether a material shortage explains a stall.',
    parameters: obj({ from: DATE, to: DATE }),
    roles: STAFF,
    handler: () => todo('query inventory_daily joined to material_catalog for the range (default last 14 days) (task B4)'),
  },
  {
    name: 'whatif_pace',
    description: 'Recompute the model completion forecast if the future pace changes by a factor (1.2 = 20 % faster, 0.8 = 20 % slower). Returns finish date and range. Changes nothing.',
    parameters: obj({ pace_factor: { type: 'number', description: 'between 0.5 and 2' } }, ['pace_factor']),
    roles: ALL,
    handler: () => todo('build the same payload as recompute() (HANDOFF T7) and call inference.scheduleForecast({...payload, pace_factor}); validate 0.5 <= pace_factor <= 2; return blend + baseline; never write (task B5)'),
  },
  {
    name: 'whatif_crews',
    description: 'Regenerate the remaining schedule in memory with a different number of crews and return the new finish date and the extra labour cost. Changes nothing.',
    parameters: obj({ crews: { type: 'integer', description: 'between 1 and 20' } }, ['crews']),
    roles: STAFF,
    handler: () => todo('call domain/schedule.js generateSchedule for unfinished elements from asOf with `crews`, cost the labour with domain/cost.js; return {finish_date, days_saved, extra_labour_pkr}; never persist (task B5)'),
  },
  {
    name: 'get_frame_context',
    description: 'For one media id: the stored analysis result, model that produced it, camera health flags, and the stage observations of the same camera in the 3 days before and after.',
    parameters: obj({ media_id: { type: 'string' } }, ['media_id']),
    roles: STAFF,
    handler: () => todo('read media, inference_runs, camera_health_checks, stage_observations for the camera around the frame date; check the media belongs to ctx.project (task B6)'),
  },
  {
    name: 'reanalyse_frame',
    description: 'Run a stored frame through a different analysis backend and return its result for comparison. The stored result is NOT replaced.',
    parameters: obj({ media_id: { type: 'string' }, task: { type: 'string', enum: ['defects', 'stage'] }, backend: { type: 'string' } }, ['media_id', 'task', 'backend']),
    roles: STAFF,
    handler: () => todo('load the file from storage, call inference analyseDefects/analyseStage with ?backend=, return the result only; verify project ownership; at most 3 calls per run (task B6)'),
  },
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
 * arguments) and ordinary tool failures come back as { ok: false, error } so the model can correct itself.
 * A stub (NotImplementedError) is rethrown: a missing tool is a bug to see, not something to paper over.
 */
export async function executeTool(ctx, call, allow = null) {
  const tool = TOOLS.find((t) => t.name === call.name);
  if (!tool || (allow && !allow.includes(tool.name))) return { ok: false, error: `unknown tool "${call.name}"` };
  if (!tool.roles.includes(ctx.user.role)) return { ok: false, error: `tool "${call.name}" is not available to your reader` };
  const problem = validateArgs(tool.parameters, call.args ?? {});
  if (problem) return { ok: false, error: problem };
  try {
    const data = await tool.handler(ctx, call.args ?? {});
    const text = JSON.stringify(data ?? null);
    if (text.length > MAX_RESULT_CHARS) {
      return { ok: true, truncated: true, data: text.slice(0, MAX_RESULT_CHARS), note: 'result was cut; narrow the request (dates, filters)' };
    }
    return { ok: true, data };
  } catch (e) {
    if (e.name === 'NotImplementedError') throw e;
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
