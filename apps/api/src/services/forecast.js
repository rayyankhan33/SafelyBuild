// Recompute forecasts, risk and alerts for a project and build the two dashboard payloads.
// Inputs are camera-derived observations (progress, stock, defects, hazards) plus the few engineer
// inputs that remain (BOQ budget, crews, equipment).
import { evaluate } from '../domain/evm.js';
import { computeSdi, overallSafety, alarpZone, ZONE_TEXT, matrixCounts, riskRating, CLEAN_DAYS_TO_CLOSE } from '../domain/risk.js';
import { desiredAlerts, diffAlerts } from '../domain/alerts.js';
import { budgetText, scheduleText, productivityText, safetyText } from '../domain/narrative.js';
import { cameraHealth, evidenceSummary, uncoveredTasks } from '../domain/evidence.js';
import { diffDays, today } from '../domain/dates.js';
import { getActiveEstimate } from './projects.js';
import { siteDate } from './ingest.js';

export async function loadState(db, project) {
  const q = (text, params = [project.id]) => db.query(text, params).then((r) => r.rows);
  const [tasks, progress, spend, defects, analysed, hazards, crews, cameras] = await Promise.all([
    q('SELECT * FROM schedule_tasks WHERE project_id = $1 ORDER BY seq'),
    q(`SELECT l.log_date AS date, tp.task_id, tp.percent_complete AS percent
       FROM task_progress tp JOIN daily_logs l ON l.id = tp.daily_log_id WHERE l.project_id = $1`),
    q(`SELECT l.log_date AS date, u.cost_pkr FROM material_usage u JOIN daily_logs l ON l.id = u.daily_log_id WHERE l.project_id = $1`),
    q(`SELECT d.*, r.result->'image_size' AS image_size FROM defects d JOIN inference_runs r ON r.id = d.inference_run_id
       WHERE d.project_id = $1 ORDER BY d.detected_on, d.score DESC`),
    q(`SELECT l.log_date AS date, m.id AS media_id FROM inference_runs r JOIN media m ON m.id = r.media_id
       JOIN daily_logs l ON l.id = m.daily_log_id WHERE m.project_id = $1 AND r.kind = 'defects' AND r.status = 'succeeded'`),
    q(`SELECT h.*, hl.causes, hl.consequences, hl.preventive_controls, hl.mitigating_controls, s.code AS standard, c.name AS camera_name
       FROM hazards h LEFT JOIN hazard_library hl ON hl.id = h.library_id LEFT JOIN standards_refs s ON s.id = hl.standard_id
       LEFT JOIN cameras c ON c.id = h.camera_id
       WHERE h.project_id = $1 ORDER BY h.risk_rating DESC, h.created_at`),
    q(`SELECT log_date AS date, crews FROM daily_logs WHERE project_id = $1 AND crews IS NOT NULL ORDER BY log_date`),
    q(`SELECT id, name, kind, element_id, active, last_frame_at FROM cameras WHERE project_id = $1 ORDER BY kind, name`),
  ]);
  return {
    tasks: tasks.map((t) => ({ ...t, planned_cost_pkr: Number(t.planned_cost_pkr) })),
    progress: progress.map((p) => ({ ...p, percent: Number(p.percent) })),
    spend, defects, analysed, hazards, crews,
    cameras: cameras.map((c) => ({ ...c, last_frame_date: c.last_frame_at ? siteDate(new Date(c.last_frame_at)) : null })),
  };
}

/** Evidence health at `asOf`: which cameras are overdue, which tasks nobody is watching. */
export function evidenceState(state, project, asOf) {
  const pctByTask = {};
  for (const p of state.progress) if (diffDays(p.date, asOf) >= 0) pctByTask[p.task_id] = Math.max(pctByTask[p.task_id] ?? 0, p.percent);
  // a zone camera is expected to report while its task has started (or is due to start tomorrow) and is not finished
  const active = {};
  for (const t of state.tasks) {
    const started = diffDays(t.planned_start, asOf) >= -1;
    active[t.element_id] = started && (pctByTask[t.id] ?? 0) < 100;
  }
  const health = cameraHealth(state.cameras, active, asOf);
  const uncovered = uncoveredTasks(state.tasks, state.cameras);
  return { health, uncovered, summary: evidenceSummary(health, uncovered) };
}

/** Recompute and persist forecast + risk score + alerts. Returns everything the dashboards need. */
export async function recompute(db, project, asOf = today()) {
  const state = await loadState(db, project);
  if (!state.tasks.length || !project.planned_end_date) return { ready: false, reason: 'no schedule yet', state };

  const ev = evaluate({ tasks: state.tasks, progress: state.progress, spend: state.spend, asOf,
    projectStart: project.start_date, plannedEnd: project.planned_end_date, crews: state.crews });
  const sdi = computeSdi(state.defects, state.analysed, asOf);
  const evidence = evidenceState(state, project, asOf);
  const safety = overallSafety(sdi, state.hazards, evidence.summary.gap);

  await db.query(
    `INSERT INTO forecasts (project_id, as_of, budget, schedule) VALUES ($1,$2,$3,$4)
     ON CONFLICT (project_id, as_of) DO UPDATE SET budget = EXCLUDED.budget, schedule = EXCLUDED.schedule`,
    [project.id, asOf, ev.metrics.budget, ev.metrics.schedule]);
  if (sdi) {
    await db.query(
      `INSERT INTO risk_scores (project_id, score_date, sdi, severity_part, density_part, progression_part, weights, status, explanation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (project_id, score_date) DO UPDATE SET sdi = EXCLUDED.sdi, severity_part = EXCLUDED.severity_part,
         density_part = EXCLUDED.density_part, progression_part = EXCLUDED.progression_part, weights = EXCLUDED.weights,
         status = EXCLUDED.status, explanation = EXCLUDED.explanation`,
      [project.id, asOf, sdi.sdi, sdi.severity_part, sdi.density_part, sdi.progression_part, sdi.weights, sdi.status, sdi.explanation]);
  }

  const desired = desiredAlerts({ budget: ev.metrics.budget, schedule: ev.metrics.schedule, safety, sdi, evidence: evidence.summary });
  const open = (await db.query(
    `SELECT id, dedupe_key, technical_msg, plain_msg FROM alerts WHERE project_id = $1 AND resolved_at IS NULL AND (kind <> 'system' OR dedupe_key LIKE 'evidence:%')`, [project.id])).rows;
  const { toCreate, toResolve, toUpdate } = diffAlerts(desired, open);
  for (const u of toUpdate) await db.query('UPDATE alerts SET technical_msg = $2, plain_msg = $3 WHERE id = $1', [u.id, u.technical_msg, u.plain_msg]);
  for (const a of toCreate) {
    await db.query(
      `INSERT INTO alerts (project_id, kind, level, dedupe_key, technical_msg, plain_msg) VALUES ($1,$2,$3,$4,$5,$6)`,
      [project.id, a.kind, a.level, a.dedupe_key, a.technical_msg, a.plain_msg]);
  }
  if (toResolve.length) await db.query('UPDATE alerts SET resolved_at = now() WHERE id = ANY($1::uuid[])', [toResolve]);

  return { ready: true, asOf, state, evidence, ...ev, sdi, safety };
}

// ------------------------------------------------------------------ dashboards
export async function buildDashboard(db, project, role, asOf = today()) {
  const base = {
    project: {
      id: project.id, name: project.name, location: project.location, status: project.status,
      start_date: project.start_date, planned_end_date: project.planned_end_date, budget_pkr: project.budget_pkr, is_demo: project.is_demo,
    },
    as_of: asOf,
  };
  const r = await recompute(db, project, asOf);
  const alertsRows = (await db.query(
    `SELECT id, kind, level, technical_msg, plain_msg, created_at, acknowledged_at FROM alerts
     WHERE project_id = $1 AND resolved_at IS NULL ORDER BY (level = 'critical') DESC, created_at DESC`, [project.id])).rows;
  const recent = (await db.query(
    `SELECT m.id, m.tag, l.log_date AS date, c.name AS camera,
            (SELECT count(*) FROM defects d WHERE d.media_id = m.id AND d.is_violation)::int AS violations
     FROM media m JOIN daily_logs l ON l.id = m.daily_log_id LEFT JOIN cameras c ON c.id = m.camera_id
     WHERE m.project_id = $1 ORDER BY m.captured_at DESC NULLS LAST, m.created_at DESC LIMIT 12`, [project.id])).rows;

  if (!r.ready) {
    return { ...base, setup_complete: false, setup_hint: 'The engineer has not finished setting up the design, estimate and schedule yet.',
      alerts: alertsRows.map((a) => pickAlert(a, role)), recent_media: recent };
  }

  const m = r.metrics;
  const b = budgetText(m.budget);
  const s = scheduleText(m.schedule);
  const sf = safetyText(r.safety, r.sdi);
  const evNote = r.safety.evidence_gap ? ' Some cameras have not reported recently, so this may be out of date.' : '';
  const investor = {
    ...base, setup_complete: true,
    headline: {
      percent_complete: m.percent_complete,
      planned_percent: m.planned_percent,
      budget: { status: m.budget.status, bac: m.bac, spent: m.ac, earned_value: m.ev, forecast_final: m.budget.eac ?? null,
        overrun: m.budget.overrun ?? null, overrun_pct: m.budget.overrun_pct ?? null,
        forecast_low: m.budget.eac_low ?? null, forecast_high: m.budget.eac_high ?? null, text: b.plain },
      schedule: { status: m.schedule.status, planned_end: m.schedule.planned_end, forecast_end: m.schedule.forecast_end ?? null,
        days_late: m.schedule.days_late ?? null, text: s.plain },
      safety: { status: r.safety.status, text: sf.plain + evNote, evidence_gap: r.safety.evidence_gap },
      productivity: { ...m.productivity, text: productivityText(m.productivity) },
    },
    evidence: {
      cameras_ok: r.evidence.health.filter((h) => h.status === 'ok').length,
      cameras_expected: r.evidence.health.filter((h) => ['ok', 'stale', 'never'].includes(h.status)).length,
      gap: r.evidence.summary.gap,
      note: 'All figures on this page are measured automatically from site camera images. No one on site types them in.',
    },
    series: {
      planned: r.series.planned,
      actual: r.series.actual.map(({ date, pv, ev, ac, daily_spend, productivity }) => ({ date, pv, ev, ac, daily_spend, productivity })),
    },
    alerts: alertsRows.map((a) => pickAlert(a, 'investor')),
    recent_media: recent,
  };
  // Investor-only pages: open safety issues in plain words and where the money went. No ratings, codes or controls.
  const PLAIN = { intolerable: 'Serious: work in this area should stop until it is cleared.', alarp: 'Needs attention: the site team should act on it.', acceptable: 'Minor: being monitored.' };
  const hz = r.state.hazards.map((h) => ({ h, zone: alarpZone(h.risk_rating ?? riskRating(h.likelihood, h.severity)) }));
  investor.safety_items = {
    open: hz.filter(({ h }) => h.status !== 'closed').sort((x, y) => (y.h.risk_rating ?? 0) - (x.h.risk_rating ?? 0))
      .map(({ h, zone }) => ({ id: h.id, title: h.title, level: zone === 'intolerable' ? 'serious' : zone === 'alarp' ? 'attention' : 'minor', plain: PLAIN[zone], raised_on: h.identified_on })),
    closed_count: hz.filter(({ h }) => h.status === 'closed').length,
    clean_days_to_close: CLEAN_DAYS_TO_CLOSE,
  };
  investor.spend_by_material = (await db.query(
    `SELECT c.name AS material, round(sum(u.cost_pkr))::float8 AS cost_pkr FROM material_usage u
     JOIN daily_logs l ON l.id = u.daily_log_id JOIN material_catalog c ON c.id = u.material_id
     WHERE l.project_id = $1 GROUP BY c.name ORDER BY sum(u.cost_pkr) DESC`, [project.id])).rows;
  if (role === 'investor') return investor;

  const est = await getActiveEstimate(db, project.id);
  const hazards = r.state.hazards.map((h) => {
    const rating = h.risk_rating ?? riskRating(h.likelihood, h.severity);
    const zone = alarpZone(rating);
    return {
      id: h.id, title: h.title, category: h.category, status: h.status, likelihood: h.likelihood, severity: h.severity,
      rating, zone, zone_text: ZONE_TEXT[zone], notes: h.notes, identified_on: h.identified_on, closed_on: h.closed_on, camera: h.camera_name,
      clean_days: h.clean_days, standard: h.standard,
      bow_tie: h.library_id ? { causes: h.causes, consequences: h.consequences, preventive: h.preventive_controls, mitigating: h.mitigating_controls } : null,
    };
  });
  const standardsUsed = (await db.query('SELECT code, title, body, used_for FROM standards_refs ORDER BY code')).rows;
  const inventory = (await db.query(
    `SELECT i.observed_on AS date, m.code AS material, m.unit, i.stock_qty, i.used_qty, i.delivered_qty
     FROM inventory_daily i JOIN material_catalog m ON m.id = i.material_id WHERE i.project_id = $1 ORDER BY i.observed_on, m.id`, [project.id])).rows;
  const siteStatus = (await db.query(
    `SELECT log_date AS date, crews, equipment FROM daily_logs WHERE project_id = $1 AND crews IS NOT NULL ORDER BY log_date DESC LIMIT 30`, [project.id])).rows;
  const frames = (await db.query(
    `SELECT m.id, l.log_date AS date, m.captured_at, c.name AS camera, c.kind,
            (SELECT jsonb_build_object('stage', so.stage, 'fraction', so.fraction, 'backend', so.backend) FROM stage_observations so
             JOIN inference_runs r ON r.id = so.inference_run_id WHERE r.media_id = m.id LIMIT 1) AS stage,
            (SELECT count(*) FROM defects d WHERE d.media_id = m.id AND d.is_violation)::int AS violations
     FROM media m JOIN daily_logs l ON l.id = m.daily_log_id JOIN cameras c ON c.id = m.camera_id
     WHERE m.project_id = $1 ORDER BY m.captured_at DESC LIMIT 24`, [project.id])).rows;
  const { safety_items: _s, spend_by_material: _m, ...shared } = investor;
  return {
    ...shared,
    view: role === 'admin' ? 'admin' : 'engineer',
    headline: { ...investor.headline,
      budget: { ...investor.headline.budget, technical: b.technical, cpi: m.budget.cpi ?? null, eac_trend: m.budget.eac_trend ?? null, method: m.budget.method ?? null },
      schedule: { ...investor.headline.schedule, technical: s.technical, spi: m.schedule.spi ?? null },
      safety: { ...investor.headline.safety, technical: sf.technical, detail: r.safety },
    },
    metrics: m,
    series: { planned: r.series.planned, actual: r.series.actual },
    risk: {
      sdi: r.sdi, safety: r.safety, clean_days_to_close: CLEAN_DAYS_TO_CLOSE,
      history: (await db.query('SELECT score_date AS date, sdi, status FROM risk_scores WHERE project_id = $1 ORDER BY score_date', [project.id])).rows,
      matrix: matrixCounts(r.state.hazards), hazards,
      defects: r.state.defects.map((d) => ({ id: d.id, media_id: d.media_id, type: d.defect_type, score: d.score, severity: d.severity,
        is_violation: d.is_violation, bbox: d.bbox, detected_on: d.detected_on, image_size: d.image_size })).slice(-60),
    },
    estimate: est && {
      id: est.id, version: est.version, total_pkr: est.total_pkr, contingency_pct: est.contingency_pct, warnings: est.warnings,
      mixes: est.factors_snapshot.mixes, by_material: est.factors_snapshot.by_material, excluded: est.factors_snapshot.excluded,
      compaction_factor_coarse: est.factors_snapshot.compaction_factor_coarse,
    },
    evidence: { ...investor.evidence, cameras: r.evidence.health, uncovered_tasks: r.evidence.uncovered.map((t) => t.name), frames },
    inventory, site_status: siteStatus,
    standards: standardsUsed,
    alerts: alertsRows.map((a) => pickAlert(a, 'engineer')),
  };
}

function pickAlert(a, role) {
  return { id: a.id, kind: a.kind, level: a.level, created_at: a.created_at, acknowledged: !!a.acknowledged_at,
    message: role === 'investor' ? a.plain_msg : a.technical_msg };
}
