// Is the evidence stream healthy? If a camera that should be reporting goes quiet, we say so
// instead of silently treating the site as fine: missing evidence must never look like safety.

import { addDays, diffDays, workingDaysInclusive } from './dates.js';

/** A camera is overdue when it was expected to report and has missed this many WORKING days (closed days do not count). */
export const STALE_AFTER_DAYS = 2;

/**
 * Screening flags need to repeat before a camera is suspected: one flagged frame may be a worker in front of the lens or
 * a lighting change. Covered and blurred are clear-cut (2 in a row); a different view could be a genuine scene change (3).
 * Recovery is automatic: clean frames after the fault clear the suspicion (a moved camera is judged against its new view
 * once it has sent a few frames from it). Values are uncalibrated (see services/inference/health.py).
 */
export const TAMPER_CONSECUTIVE = { covered: 2, blurred: 2, redirected: 3 };
export const TAMPER_TEXT = { covered: 'covered or blacked out', blurred: 'out of focus', redirected: 'pointing at a different view' };

/** @param {string[][]} recentFlags flags of the camera's latest checks, newest first. Returns the suspected fault or null. */
export function tamperSuspicion(recentFlags) {
  for (const f of ['covered', 'blurred', 'redirected']) {
    const n = TAMPER_CONSECUTIVE[f];
    if (recentFlags.length >= n && recentFlags.slice(0, n).every((x) => x.includes(f))) return f;
  }
  return null;
}

/**
 * @param {object[]} cameras   {id, name, kind, element_id, active, last_frame_date|null, recent_flags?: string[][]}
 * @param {Record<string, boolean>} taskActiveByElement true while the element's task is in progress or due
 * @param {string} asOf        status date
 * @returns {{id, name, kind, status: 'ok'|'stale'|'never'|'idle'|'disabled', days_since: number|null}[]}
 */
export function cameraHealth(cameras, taskActiveByElement, asOf) {
  return cameras.map((c) => {
    const days = c.last_frame_date ? workingDaysInclusive(addDays(c.last_frame_date, 1), asOf) : null;
    let status;
    if (!c.active) status = 'disabled';
    else if (c.kind === 'zone' && !taskActiveByElement[c.element_id]) status = 'idle'; // task not in progress: no frames expected
    else if (days === null) status = 'never';
    else status = days >= STALE_AFTER_DAYS ? 'stale' : 'ok';
    const tamper = ['ok', 'stale', 'never'].includes(status) ? tamperSuspicion(c.recent_flags ?? []) : null;
    return { id: c.id, name: c.name, kind: c.kind, status: tamper ? 'suspect' : status, days_since: days, tamper };
  });
}

/** Tasks whose element has no active zone camera: their progress can never be measured. */
export function uncoveredTasks(tasks, cameras) {
  const covered = new Set(cameras.filter((c) => c.active && c.kind === 'zone').map((c) => c.element_id));
  return tasks.filter((t) => !covered.has(t.element_id));
}

export function evidenceSummary(health, uncovered) {
  const quiet = health.filter((h) => h.status === 'stale' || h.status === 'never');
  const suspect = health.filter((h) => h.status === 'suspect');
  return {
    gap: quiet.length > 0 || uncovered.length > 0 || suspect.length > 0,
    quiet_cameras: quiet.map((h) => h.name),
    suspect_cameras: suspect.map((h) => ({ name: h.name, tamper: h.tamper })),
    uncovered_tasks: uncovered.map((t) => t.name),
  };
}
