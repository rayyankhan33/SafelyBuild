// TEMPORARY FEATURE - test footage (see docs/temporary-features.md for how to remove it).
//
// An engineer uploads a video or image; the inference service samples frames and runs the vision model;
// this module keeps a database copy of the results so the UI can show them. It is a sandbox: it never
// writes to media, defects or any observation table, and rollup/forecast code never reads these tables.
import fs from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import { config } from '../config.js';
import { HttpError, bad, notFound } from '../http.js';
import * as storage from '../storage.js';

const POLL_MS = Number(process.env.TEST_POLL_MS || 1500);
const MAX_POLL_FAILURES = Number(process.env.TEST_POLL_MAX_FAILURES || 8);
const ACTIVE = ['queued', 'running'];
const watchers = new Map(); // runId -> true while a poller is running in this process

// ------------------------------------------------------------------ upload validation
/** Real container/format from magic bytes (never from the file name or the client's Content-Type). */
export function sniffFootageType(head) {
  if (head.length >= 12 && head.subarray(4, 8).toString() === 'ftyp') return 'video/mp4';                 // mp4, mov, m4v
  if (head.length >= 12 && head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'AVI ') return 'video/x-msvideo';
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'video/webm'; // webm, mkv
  return storage.sniffImageType(head);                                                                      // a single image is a one-frame test
}

export async function readHead(filePath, n = 16) {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}

// ------------------------------------------------------------------ calls to the inference service
async function inferenceCall(method, path, body, timeoutMs = 30_000) {
  let res;
  try {
    res = await fetch(`${config.inferenceUrl}${path}`, { method, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new HttpError(503, 'analysis_unavailable', `image analysis service unreachable (${e.cause?.code ?? e.name})`);
  }
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail); } catch { /* keep status text */ }
    const status = [404, 413, 422, 501].includes(res.status) ? res.status : 502;
    throw new HttpError(status, status === 501 ? 'model_unavailable' : 'analysis_refused', msg);
  }
  return res;
}

export async function getDefaults() {
  return (await inferenceCall('GET', '/v1/test/defaults')).json();
}

// ------------------------------------------------------------------ runs
/** Start a run from an uploaded temp file. The temp file is always removed. */
export async function startRun(db, project, user, { tmpPath, filename, size, params }) {
  try {
    const active = (await db.query('SELECT 1 FROM test_runs WHERE project_id = $1 AND status = ANY($2)', [project.id, ACTIVE])).rowCount;
    if (active) throw new HttpError(409, 'run_in_progress', 'a test run is already being analysed for this project; wait for it to finish or delete it');

    const run = (await db.query(
      `INSERT INTO test_runs (project_id, user_id, filename, size_bytes, status, params) VALUES ($1,$2,$3,$4,'queued',$5) RETURNING *`,
      [project.id, user.id, filename.slice(0, 200), size, params])).rows[0];
    try {
      const form = new FormData();
      form.append('file', await openAsBlob(tmpPath), 'upload');
      if (params.prompts) form.append('prompts', JSON.stringify(params.prompts)); // absent: the service's default list
      form.append('interval_s', String(params.interval_s));
      form.append('conf', String(params.conf));
      form.append('model', params.model);
      form.append('max_frames', String(params.max_frames));
      const { id } = await (await inferenceCall('POST', '/v1/test/jobs', form, config.testUploadTimeoutMs)).json();
      await db.query(`UPDATE test_runs SET job_id = $2, status = 'running' WHERE id = $1`, [run.id, id]);
      watch(db, run.id);
      return { ...run, job_id: id, status: 'running' };
    } catch (e) {
      await db.query('DELETE FROM test_runs WHERE id = $1', [run.id]); // nothing to show for a run that never started
      throw e;
    }
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
}

export function validateParams(body) {
  const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
  let prompts = body.prompts;
  if (typeof prompts === 'string') {
    prompts = prompts.trim().startsWith('[') ? JSON.parse(prompts) : prompts.split(/\r?\n/);
  }
  prompts = (prompts ?? []).map((p) => String(p).trim()).filter(Boolean);
  const out = { prompts: prompts.length ? prompts : null, interval_s: num(body.interval_s, 3), conf: num(body.conf, 0.1), max_frames: num(body.max_frames, 400), model: String(body.model || 'yolo_world') };
  if (out.prompts && (out.prompts.length > 30 || out.prompts.some((p) => p.length > 80))) throw bad('give 1-30 prompts of at most 80 characters');
  if (!/^[a-z0-9_]{1,40}$/.test(out.model)) throw bad('model name is not valid');
  if (!(out.interval_s >= 1 && out.interval_s <= 10)) throw bad('interval_s must be between 1 and 10 seconds');
  if (!(out.conf >= 0.01 && out.conf <= 0.9)) throw bad('conf must be between 0.01 and 0.9');
  if (!Number.isInteger(out.max_frames) || out.max_frames < 1 || out.max_frames > 600) throw bad('max_frames must be a whole number from 1 to 600');
  return out;
}

/** Poll the inference job and copy its results into the database until it finishes. */
function watch(db, runId) {
  if (watchers.has(runId)) return;
  watchers.set(runId, true);
  (async () => {
    let failures = 0;
    try {
      for (;;) {
        const run = (await db.query('SELECT * FROM test_runs WHERE id = $1', [runId])).rows[0];
        if (!run || !ACTIVE.includes(run.status)) return; // deleted or finished elsewhere
        let view;
        try {
          view = await (await inferenceCall('GET', `/v1/test/jobs/${run.job_id}`)).json();
          failures = 0;
        } catch (e) {
          if (++failures >= MAX_POLL_FAILURES || e.status === 404) {
            await finish(db, run, 'failed', e.status === 404 ? 'the analysis service lost this job (it may have restarted)' : `lost contact with the analysis service: ${e.message}`);
            return;
          }
          await sleep(POLL_MS);
          continue;
        }
        await syncFrames(db, run, view);
        const done = ['done', 'failed', 'cancelled'].includes(view.status);
        await db.query(
          `UPDATE test_runs SET params = $2, video = $3, progress = $4, summary = $5 WHERE id = $1`,
          [runId, { ...run.params, effective_interval_s: view.params.effective_interval_s, estimated_frames: view.params.estimated_frames }, view.video, view.progress, view.summary]);
        if (done) {
          await finish(db, run, view.status, view.error ?? null);
          inferenceCall('DELETE', `/v1/test/jobs/${run.job_id}`).catch(() => {}); // free the service's temp files
          return;
        }
        await sleep(POLL_MS);
      }
    } catch (e) {
      console.error('test-footage watcher crashed', e);
      await db.query(`UPDATE test_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND status = ANY($3)`, [runId, `internal error: ${e.message}`, ACTIVE]).catch(() => {});
    } finally {
      watchers.delete(runId);
    }
  })();
}

async function syncFrames(db, run, view) {
  const stored = new Map((await db.query('SELECT i, detections FROM test_frames WHERE run_id = $1', [run.id])).rows.map((r) => [r.i, JSON.stringify(r.detections)]));
  for (const f of view.frames) {
    const dets = JSON.stringify(f.detections);
    if (stored.get(f.i) === dets) continue;           // unchanged: no need to fetch the image again
    // new frame, or an earlier frame whose detections just became "confirmed" (its image is re-drawn)
    const img = Buffer.from(await (await inferenceCall('GET', `/v1/test/jobs/${run.job_id}/frames/${f.i}.jpg`)).arrayBuffer());
    const key = await storage.putTestFrame(run.project_id, run.id, f.i, img);
    if (stored.has(f.i)) {
      await db.query('UPDATE test_frames SET detections = $3, reused = $4 WHERE run_id = $1 AND i = $2', [run.id, f.i, dets, f.reused]);
    } else {
      await db.query(
        `INSERT INTO test_frames (run_id, i, t_s, sharpness, reused, ms, detections, storage_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [run.id, f.i, f.t_s, f.sharpness, f.reused, f.ms, dets, key]);
    }
  }
}

async function finish(db, run, status, error) {
  await db.query(`UPDATE test_runs SET status = $2, error = $3, finished_at = now() WHERE id = $1`, [run.id, status, error]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** On start-up: runs that were in progress when the server stopped cannot be resumed. */
export async function failStaleRuns(db) {
  const r = await db.query(
    `UPDATE test_runs SET status = 'failed', error = 'the server restarted while this run was being analysed', finished_at = now() WHERE status = ANY($1)`, [ACTIVE]);
  return r.rowCount;
}

export async function listRuns(db, projectId) {
  const { rows } = await db.query(
    `SELECT r.id, r.filename, r.size_bytes, r.status, r.error, r.params, r.video, r.progress, r.summary, r.created_at, r.finished_at,
            u.full_name AS uploaded_by, (SELECT count(*)::int FROM test_frames f WHERE f.run_id = r.id) AS frames
     FROM test_runs r LEFT JOIN users u ON u.id = r.user_id WHERE r.project_id = $1 ORDER BY r.created_at DESC LIMIT 20`, [projectId]);
  return rows;
}

export async function getRun(db, projectId, runId) {
  const run = (await db.query(
    `SELECT r.*, u.full_name AS uploaded_by FROM test_runs r LEFT JOIN users u ON u.id = r.user_id WHERE r.id = $1 AND r.project_id = $2`, [runId, projectId])).rows[0];
  if (!run) throw notFound('test run');
  const frames = (await db.query('SELECT id, i, t_s, sharpness, reused, ms, detections FROM test_frames WHERE run_id = $1 ORDER BY i', [runId])).rows;
  return { ...run, frames };
}

export async function deleteRun(db, projectId, runId) {
  const run = (await db.query('SELECT * FROM test_runs WHERE id = $1 AND project_id = $2', [runId, projectId])).rows[0];
  if (!run) throw notFound('test run');
  if (run.job_id) await inferenceCall('DELETE', `/v1/test/jobs/${run.job_id}`).catch(() => {}); // stops it if still running
  await db.query('DELETE FROM test_runs WHERE id = $1', [runId]); // frames cascade; the watcher notices and stops
  await storage.removeTestRun(run.project_id, run.id);
  return run;
}

export async function frameImage(db, user, frameId) {
  const f = (await db.query(
    `SELECT f.storage_key, r.project_id FROM test_frames f JOIN test_runs r ON r.id = f.run_id JOIN projects p ON p.id = r.project_id
     WHERE f.id = $1 AND p.org_id = $2`, [frameId, user.org_id])).rows[0];
  if (!f) throw notFound('frame');
  if (user.role !== 'admin') {
    const ok = await db.query('SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2', [f.project_id, user.id]);
    if (!ok.rowCount) throw notFound('frame');
  }
  return storage.read(f.storage_key);
}
