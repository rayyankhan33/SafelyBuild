// Photo upload -> storage -> inference -> defects -> hazards.
// The upload is always kept, even if analysis fails: a failed run is recorded and an alert is raised,
// so evidence is never lost because the Python service happened to be down.
import * as inference from '../inference.js';
import * as storage from '../storage.js';
import { bad } from '../http.js';
import { diffDays, today } from '../domain/dates.js';
import { hazardFromDefect, libraryCodeForDefect } from '../domain/risk.js';

export async function ingestPhoto(db, project, user, date, { buffer, tag = 'general', latitude = null, longitude = null }) {
  if (diffDays(date, today()) < 0) throw bad('photo date cannot be in the future');
  if (diffDays(project.start_date, date) < 0) throw bad(`photo date is before the project start (${project.start_date})`);
  const type = storage.sniffImageType(buffer);
  if (!type) throw bad('unsupported file: upload a JPEG, PNG, WebP or BMP image');
  if (!['general', 'overview', 'material'].includes(tag)) throw bad("tag must be 'general', 'overview' or 'material'");

  const log = (await db.query(
    `INSERT INTO daily_logs (project_id, log_date, author_id) VALUES ($1,$2,$3)
     ON CONFLICT (project_id, log_date) DO UPDATE SET log_date = EXCLUDED.log_date RETURNING id`,
    [project.id, date, user.id])).rows[0];

  const stored = await storage.put(project.id, buffer, type);
  const media = (await db.query(
    `INSERT INTO media (project_id, daily_log_id, tag, storage_key, sha256, content_type, size_bytes, latitude, longitude, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [project.id, log.id, tag, stored.key, stored.sha256, type, stored.size, latitude, longitude, user.id])).rows[0];

  const analysis = {};
  analysis.defects = await runDefects(db, project, user, media, buffer, date);
  if (tag === 'overview') analysis.activity = await runActivity(db, project, media, buffer);
  if (tag === 'material') analysis.materials = await runMaterials(db, media, buffer);

  const failed = Object.values(analysis).some((a) => a.status === 'failed');
  await syncSystemAlert(db, project.id, failed ? Object.values(analysis).find((a) => a.status === 'failed').error : null);
  return { media, analysis };
}

async function startRun(db, mediaId, kind) {
  return (await db.query('INSERT INTO inference_runs (media_id, kind) VALUES ($1,$2) RETURNING id', [mediaId, kind])).rows[0].id;
}
async function finishRun(db, runId, { backend = null, result = null, error = null }) {
  await db.query(
    `UPDATE inference_runs SET status = $2, backend = $3, result = $4, error = $5, finished_at = now() WHERE id = $1`,
    [runId, error ? 'failed' : 'succeeded', backend, result, error]);
}

async function runDefects(db, project, user, media, buffer, date) {
  const runId = await startRun(db, media.id, 'defects');
  try {
    const result = await inference.analyseDefects(buffer, media.content_type);
    await finishRun(db, runId, { backend: result.backend, result });
    const defects = [];
    for (const f of result.findings) {
      const d = (await db.query(
        `INSERT INTO defects (inference_run_id, media_id, project_id, defect_type, score, severity, is_violation, confidence, bbox, detected_on)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [runId, media.id, project.id, f.defect_type, f.score, f.severity, f.is_violation, f.confidence, f.bbox, date])).rows[0];
      defects.push(d);
    }
    const hazards = await syncHazards(db, project.id, defects.filter((d) => d.is_violation), date, user.id);
    return { status: 'succeeded', backend: result.backend, findings: defects, coverage: result.coverage, hazards_updated: hazards };
  } catch (e) {
    await finishRun(db, runId, { error: e.message });
    return { status: 'failed', error: e.message };
  }
}

async function runActivity(db, project, media, buffer) {
  const prev = (await db.query(
    `SELECT * FROM media WHERE project_id = $1 AND tag = 'overview' AND id <> $2 AND created_at < $3 ORDER BY created_at DESC LIMIT 1`,
    [project.id, media.id, media.created_at])).rows[0];
  if (!prev) return { status: 'skipped', reason: 'no earlier overview photo to compare with' };
  const runId = await startRun(db, media.id, 'activity');
  try {
    const result = await inference.analyseActivity(await storage.read(prev.storage_key), prev.content_type, buffer, media.content_type);
    await finishRun(db, runId, { backend: 'opencv', result: { ...result, previous_media_id: prev.id } });
    return { status: 'succeeded', ...result, previous_media_id: prev.id };
  } catch (e) {
    await finishRun(db, runId, { error: e.message });
    return { status: 'failed', error: e.message };
  }
}

async function runMaterials(db, media, buffer) {
  const runId = await startRun(db, media.id, 'materials');
  try {
    const result = await inference.proposeMaterials(buffer, media.content_type);
    await finishRun(db, runId, { backend: result.mode, result });
    return { status: 'succeeded', ...result };
  } catch (e) {
    await finishRun(db, runId, { error: e.message });
    return { status: 'failed', error: e.message };
  }
}

/** One open auto-hazard per (project, library entry): re-detections raise it, never duplicate it. */
async function syncHazards(db, projectId, violations, date, userId) {
  const touched = [];
  const byType = new Map();
  for (const d of violations) {
    const cur = byType.get(d.defect_type);
    if (!cur || d.score > cur.score) byType.set(d.defect_type, d);
  }
  for (const [type, defect] of byType) {
    const code = libraryCodeForDefect(type);
    if (!code) continue;
    const lib = (await db.query('SELECT * FROM hazard_library WHERE code = $1', [code])).rows[0];
    if (!lib) continue;
    const h = hazardFromDefect(lib, defect);
    const open = (await db.query(
      `SELECT id, likelihood FROM hazards WHERE project_id = $1 AND library_id = $2 AND source = 'auto_defect' AND status <> 'closed'`,
      [projectId, lib.id])).rows[0];
    if (open) {
      await db.query('UPDATE hazards SET likelihood = GREATEST(likelihood, $2), defect_id = $3, notes = $4 WHERE id = $1',
        [open.id, h.likelihood, defect.id, h.notes]);
      touched.push(open.id);
    } else {
      const r = await db.query(
        `INSERT INTO hazards (project_id, library_id, defect_id, source, category, title, notes, likelihood, severity, identified_on, created_by)
         VALUES ($1,$2,$3,'auto_defect',$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [projectId, lib.id, defect.id, h.category, h.title, h.notes, h.likelihood, h.severity, date, userId]);
      touched.push(r.rows[0].id);
    }
  }
  return touched;
}

async function syncSystemAlert(db, projectId, error) {
  if (error) {
    await db.query(
      `INSERT INTO alerts (project_id, kind, level, dedupe_key, technical_msg, plain_msg)
       VALUES ($1,'system','warning','system:analysis_failed',$2,$3) ON CONFLICT DO NOTHING`,
      [projectId, `Photo analysis failed: ${error}. The photo was saved; re-run analysis when the service is back.`,
        'Automatic photo analysis was temporarily unavailable. The photos are saved and will be reviewed.']);
  } else {
    await db.query(`UPDATE alerts SET resolved_at = now() WHERE project_id = $1 AND dedupe_key = 'system:analysis_failed' AND resolved_at IS NULL`, [projectId]);
  }
}
