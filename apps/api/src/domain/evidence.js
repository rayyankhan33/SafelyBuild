// Is the evidence stream healthy? If a camera that should be reporting goes quiet, we say so
// instead of silently treating the site as fine: missing evidence must never look like safety.

import { addDays, diffDays, workingDaysInclusive } from './dates.js';

/** A camera is overdue when it was expected to report and has missed this many WORKING days (closed days do not count). */
export const STALE_AFTER_DAYS = 2;

/**
 * @param {object[]} cameras   {id, name, kind, element_id, active, last_frame_date|null}
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
    return { id: c.id, name: c.name, kind: c.kind, status, days_since: days };
  });
}

/** Tasks whose element has no active zone camera: their progress can never be measured. */
export function uncoveredTasks(tasks, cameras) {
  const covered = new Set(cameras.filter((c) => c.active && c.kind === 'zone').map((c) => c.element_id));
  return tasks.filter((t) => !covered.has(t.element_id));
}

export function evidenceSummary(health, uncovered) {
  const quiet = health.filter((h) => h.status === 'stale' || h.status === 'never');
  return {
    gap: quiet.length > 0 || uncovered.length > 0,
    quiet_cameras: quiet.map((h) => h.name),
    uncovered_tasks: uncovered.map((t) => t.name),
  };
}
