// Camera frames in, evidence out. This is the ONLY way photos enter the system: there is no user
// upload endpoint, so nobody on site can choose which pictures are analysed.
//
// Controls against tampering:
//   * each camera has its own secret (stored only as a SHA-256 hash); frames without it are refused
//   * the camera's clock must agree with the server within MAX_CLOCK_SKEW (stale or future frames refused)
//   * the same bytes cannot be submitted twice by one camera (replay protection, enforced by a unique index)
//   * a per-camera daily cap stops flooding
//   * every frame is stored with its SHA-256 and the time the server received it
import crypto from 'node:crypto';
import { config } from '../config.js';
import { HttpError, bad, notFound } from '../http.js';
import * as inference from '../inference.js';
import * as storage from '../storage.js';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ------------------------------------------------------------------ cameras
export async function createCamera(db, project, user, { name, kind, element_id, scale_m_per_px, expected_frames_per_day, detect_defects = true }) {
  if (kind === 'zone') {
    if (!element_id) throw bad('a zone camera must watch one design element');
    const el = (await db.query('SELECT 1 FROM design_elements WHERE id = $1 AND project_id = $2', [element_id, project.id])).rowCount;
    if (!el) throw bad('element does not belong to this project');
  }
  if (kind === 'yard' && !(scale_m_per_px > 0)) throw bad('a yard camera needs a calibrated ground scale (metres per pixel)');
  const secret = crypto.randomBytes(24).toString('hex');
  const { rows } = await db.query(
    `INSERT INTO cameras (project_id, name, kind, element_id, scale_m_per_px, key_hash, expected_frames_per_day, detect_defects, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, project_id, name, kind, element_id, scale_m_per_px, expected_frames_per_day, detect_defects, active, created_at`,
    [project.id, name, kind, kind === 'zone' ? element_id : null, kind === 'yard' ? scale_m_per_px : null, sha256(secret), expected_frames_per_day ?? 1, detect_defects, user.id]);
  // the secret is shown exactly once; only its hash is stored
  return { camera: rows[0], key: `${rows[0].id}.${secret}` };
}

/** Header value is "<cameraId>.<secret>". Returns the camera row or null. Constant-time comparison. */
export async function authenticateCamera(db, header) {
  const m = /^([0-9a-f-]{36})\.([0-9a-f]{48})$/.exec(header ?? '');
  if (!m) return null;
  const cam = (await db.query('SELECT * FROM cameras WHERE id = $1 AND active', [m[1]])).rows[0];
  if (!cam) return null;
  const a = Buffer.from(cam.key_hash, 'hex');
  const b = Buffer.from(sha256(m[2]), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? cam : null;
}

/** The site's local calendar date for an instant (site clock = UTC + offset). */
export function siteDate(instant) {
  return new Date(instant.getTime() + config.siteUtcOffsetHours * 3_600_000).toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ frames
/**
 * @param {object} opts { buffer, capturedAt: Date, backfill?: boolean }
 *   `backfill` skips the clock-skew check. Only the seed script and tests set it; the HTTP route never does.
 */
export async function ingestFrame(db, camera, { buffer, capturedAt, backfill = false }) {
  const type = storage.sniffImageType(buffer);
  if (!type) throw bad('unsupported file: frames must be JPEG, PNG, WebP or BMP');
  if (!(capturedAt instanceof Date) || Number.isNaN(capturedAt.getTime())) throw bad('captured_at must be an ISO timestamp');
  const skew = Math.abs(Date.now() - capturedAt.getTime());
  if (!backfill && skew > config.maxClockSkewMs) {
    throw new HttpError(422, 'clock_skew', `camera clock differs from the server by ${Math.round(skew / 1000)} s (limit ${Math.round(config.maxClockSkewMs / 1000)} s); frame refused`);
  }
  const date = siteDate(capturedAt);

  const today = (await db.query('SELECT count(*)::int AS n FROM media WHERE camera_id = $1 AND received_at > now() - interval \'24 hours\'', [camera.id])).rows[0].n;
  if (!backfill && today >= config.maxFramesPerCameraPerDay) throw new HttpError(429, 'too_many_frames', 'daily frame limit reached for this camera');

  const project = (await db.query('SELECT * FROM projects WHERE id = $1', [camera.project_id])).rows[0];
  const log = (await db.query(
    `INSERT INTO daily_logs (project_id, log_date) VALUES ($1,$2)
     ON CONFLICT (project_id, log_date) DO UPDATE SET log_date = EXCLUDED.log_date RETURNING id`, [project.id, date])).rows[0];

  const stored = await storage.put(project.id, buffer, type);
  let media;
  try {
    media = (await db.query(
      `INSERT INTO media (project_id, daily_log_id, camera_id, tag, storage_key, sha256, content_type, size_bytes, captured_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [project.id, log.id, camera.id, { zone: 'general', yard: 'material', overview: 'overview' }[camera.kind], stored.key, stored.sha256, type, stored.size, capturedAt])).rows[0];
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'duplicate_frame', 'this exact frame was already submitted by this camera');
    throw e;
  }
  await db.query('UPDATE cameras SET last_frame_at = GREATEST(COALESCE(last_frame_at, $2), $2) WHERE id = $1', [camera.id, capturedAt]);

  const analysis = {};
  if (camera.detect_defects) analysis.defects = await runDefects(db, project, media, buffer, date);
  if (camera.kind === 'zone') analysis.stage = await runStage(db, camera, media, buffer, date);
  if (camera.kind === 'yard') analysis.inventory = await runInventory(db, camera, media, buffer, date);
  if (camera.kind === 'overview') analysis.activity = await runActivity(db, camera, media, buffer);

  const failure = Object.values(analysis).find((a) => a.status === 'failed');
  await syncSystemAlert(db, project.id, failure?.error ?? null);
  return { media_id: media.id, date, analysis };
}

async function startRun(db, mediaId, kind) {
  return (await db.query('INSERT INTO inference_runs (media_id, kind) VALUES ($1,$2) RETURNING id', [mediaId, kind])).rows[0].id;
}
async function finishRun(db, runId, { backend = null, result = null, error = null }) {
  const model = result?.model ?? null; // stamped by the inference service: {backend, version, weights_sha256, reliability, ...}
  await db.query(
    `UPDATE inference_runs SET status = $2, backend = $3, result = $4, error = $5, model_version = $6, model_info = $7, finished_at = now() WHERE id = $1`,
    [runId, error ? 'failed' : 'succeeded', model?.backend ?? backend, result, error, model ? `${model.backend}@${model.version}` : null, model]);
}

async function runDefects(db, project, media, buffer, date) {
  const runId = await startRun(db, media.id, 'defects');
  try {
    const result = await inference.analyseDefects(buffer, media.content_type);
    await finishRun(db, runId, { backend: result.backend, result });
    for (const f of result.findings) {
      await db.query(
        `INSERT INTO defects (inference_run_id, media_id, project_id, defect_type, score, severity, is_violation, confidence, bbox, detected_on)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [runId, media.id, project.id, f.defect_type, f.score, f.severity, f.is_violation, f.confidence, f.bbox, date]);
    }
    return { status: 'succeeded', backend: result.backend, findings: result.findings.length, violations: result.findings.filter((f) => f.is_violation).length };
  } catch (e) {
    await finishRun(db, runId, { error: e.message });
    return { status: 'failed', error: e.message };
  }
}

async function runStage(db, camera, media, buffer, date) {
  const el = (await db.query('SELECT element_type FROM design_elements WHERE id = $1', [camera.element_id])).rows[0];
  if (!el) return { status: 'failed', error: 'camera element no longer exists' };
  const runId = await startRun(db, media.id, 'stage');
  try {
    const r = await inference.analyseStage(buffer, media.content_type, el.element_type);
    await finishRun(db, runId, { backend: r.backend, result: r });
    await db.query(
      `INSERT INTO stage_observations (inference_run_id, camera_id, element_id, observed_on, stage, fraction, backend, evidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [runId, camera.id, camera.element_id, date, r.stage, r.fraction, r.backend, r.evidence ?? {}]);
    return { status: 'succeeded', stage: r.stage, fraction: r.fraction, backend: r.backend, reliability: r.reliability };
  } catch (e) {
    await finishRun(db, runId, { error: e.message });
    return { status: 'failed', error: e.message };
  }
}

async function runInventory(db, camera, media, buffer, date) {
  const runId = await startRun(db, media.id, 'inventory');
  try {
    const r = await inference.analyseInventory(buffer, media.content_type, Number(camera.scale_m_per_px));
    await finishRun(db, runId, { backend: r.backend, result: r });
    const cat = Object.fromEntries((await db.query('SELECT id, code FROM material_catalog')).rows.map((m) => [m.code, m.id]));
    for (const it of r.items) {
      if (!cat[it.material_code]) continue;
      await db.query(
        `INSERT INTO inventory_observations (inference_run_id, camera_id, observed_on, material_id, quantity, unit, method, confidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [runId, camera.id, date, cat[it.material_code], it.quantity, it.unit, it.method, it.confidence]);
    }
    return { status: 'succeeded', backend: r.backend, reliability: r.reliability, items: r.items.map((i) => ({ code: i.material_code, quantity: i.quantity, unit: i.unit })) };
  } catch (e) {
    await finishRun(db, runId, { error: e.message });
    return { status: 'failed', error: e.message };
  }
}

async function runActivity(db, camera, media, buffer) {
  const prev = (await db.query(
    `SELECT * FROM media WHERE camera_id = $1 AND id <> $2 AND captured_at < $3 ORDER BY captured_at DESC LIMIT 1`,
    [camera.id, media.id, media.captured_at])).rows[0];
  if (!prev) return { status: 'skipped', reason: 'no earlier frame from this camera' };
  const runId = await startRun(db, media.id, 'activity');
  try {
    const r = await inference.analyseActivity(await storage.read(prev.storage_key), prev.content_type, buffer, media.content_type);
    await finishRun(db, runId, { backend: 'opencv', result: { ...r, previous_media_id: prev.id } });
    return { status: 'succeeded', ...r };
  } catch (e) {
    await finishRun(db, runId, { error: e.message });
    return { status: 'failed', error: e.message };
  }
}

async function syncSystemAlert(db, projectId, error) {
  if (error) {
    await db.query(
      `INSERT INTO alerts (project_id, kind, level, dedupe_key, technical_msg, plain_msg)
       VALUES ($1,'system','warning','system:analysis_failed',$2,$3) ON CONFLICT DO NOTHING`,
      [projectId, `Frame analysis failed: ${error}. The frame was stored; its evidence is missing until analysis is re-run.`,
        'Automatic analysis of some site images was temporarily unavailable. The images are saved.']);
  } else {
    await db.query(`UPDATE alerts SET resolved_at = now() WHERE project_id = $1 AND dedupe_key = 'system:analysis_failed' AND resolved_at IS NULL`, [projectId]);
  }
}

export async function listCameras(db, projectId) {
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.kind, c.element_id, c.scale_m_per_px, c.expected_frames_per_day, c.active, c.created_at, c.last_frame_at,
            e.label AS element_label, (SELECT count(*)::int FROM media m WHERE m.camera_id = c.id) AS frames
     FROM cameras c LEFT JOIN design_elements e ON e.id = c.element_id WHERE c.project_id = $1 ORDER BY c.kind, c.name`, [projectId]);
  return rows;
}

export async function setCameraActive(db, projectId, cameraId, active) {
  const r = await db.query('UPDATE cameras SET active = $3 WHERE id = $1 AND project_id = $2', [cameraId, projectId, active]);
  if (!r.rowCount) throw notFound('camera');
}
