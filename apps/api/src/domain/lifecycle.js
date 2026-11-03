// Completion lifecycle of a task (decision D4): placed -> curing -> finished -> inspected.
//
// Progress credit is given when the work is PLACED (the camera shows the element complete). Everything after
// that is a warning that clears only on evidence, never because a person says so:
//
//   placed     the task reached 100 % from camera observations                          (credit is given here)
//   cured      the minimum curing time has elapsed since the measured placement date    (timed only: a camera cannot
//              see strength; ACI 308R-01 / IS 456:2000 cl. 13.5 give 7 days minimum for ordinary Portland cement,
//              verify against the project specification)
//   finished   after curing, at least FINISHED_FRAMES frames show the element at its final stage with no formwork
//              visible (masonry: the wall fully built)
//   inspected  an automated visual inspection by the element's own camera after it was finished found no violation-
//              level defect. This is a visual screen for the safety module, NOT a structural test or a substitute
//              for engineer inspection and cube tests.
//
// If the evidence needed for a step does not exist (for example the camera does not run defect checks, or the model
// does not report formwork), the step stays unevidenced and the warning stays: absence of evidence never clears it.
// All functions are pure.

import { STAGE_PLAN, isContinuous } from './stages.js';
import { addDays, diffDays } from './dates.js';

export const CURE_DAYS = { footing: 7, column: 7, beam: 7, slab: 7, masonry_wall: 7 };
export const FINISHED_FRAMES = 2;
export const FORMWORK_GONE_BELOW = 0.03;   // fraction of the frame; the same minimum scene.py needs to call formwork "visible"

const PLACED_AT = 99.9;

/**
 * @param {object} a
 * @param {{name:string}} a.task
 * @param {string} a.elementType
 * @param {{date:string, percent:number}[]} a.progress     this task's progress history
 * @param {{observed_on:string, stage:number, fraction:number|null, evidence:object|null}[]} a.observations  stage observations of its element
 * @param {{date:string, violations:number}[]} a.inspections   defect analyses by the element's own camera
 * @param {boolean} a.inspectable    the element's camera runs defect checks
 * @param {string} a.asOf
 */
export function taskLifecycle({ task, elementType, progress, observations, inspections, inspectable, asOf }) {
  const upTo = (d) => diffDays(d, asOf) >= 0;
  const reached = progress.filter((p) => upTo(p.date) && p.percent >= PLACED_AT).map((p) => p.date).sort();
  if (!reached.length) return { state: 'not_placed', warnings: [] };

  const placedOn = reached[0];
  const need = CURE_DAYS[elementType] ?? 7;
  const cureCompleteOn = addDays(placedOn, need);
  const daysCured = Math.max(0, Math.min(need, diffDays(placedOn, asOf)));
  const cured = diffDays(cureCompleteOn, asOf) >= 0;

  // finished: enough frames AFTER curing showing the final stage with no formwork
  let finishedOn = null;
  if (cured) {
    const lastStage = isContinuous(elementType) ? null : STAGE_PLAN[elementType].bounds.length - 1;
    const qualifying = observations
      .filter((o) => upTo(o.observed_on) && diffDays(cureCompleteOn, o.observed_on) >= 0)
      .filter((o) => {
        if (isContinuous(elementType)) return Number(o.fraction ?? 0) >= 0.99;
        const fw = o.evidence?.formwork;
        return Number(o.stage) >= lastStage && typeof fw === 'number' && fw < FORMWORK_GONE_BELOW;
      })
      .map((o) => o.observed_on).sort();
    if (qualifying.length >= FINISHED_FRAMES) finishedOn = qualifying[FINISHED_FRAMES - 1];
  }

  // inspected: the latest inspection on or after the finish date is clean
  let inspectedOn = null; let lastInspection = null;
  if (finishedOn) {
    const after = inspections.filter((i) => upTo(i.date) && diffDays(finishedOn, i.date) >= 0).sort((x, y) => x.date.localeCompare(y.date));
    lastInspection = after[after.length - 1] ?? null;
    if (lastInspection && lastInspection.violations === 0) inspectedOn = lastInspection.date;
  }

  const warnings = [];
  if (!cured) {
    warnings.push({ step: 'curing',
      technical: `Curing: day ${daysCured} of ${need} since placement on ${placedOn} (minimum ${need} days, ACI 308R / IS 456). Strength is not yet assured.`,
      plain: `Placed on ${placedOn} and still curing (day ${daysCured} of ${need}).` });
  }
  if (!finishedOn) {
    warnings.push({ step: 'finished',
      technical: cured
        ? `Not yet evidenced as finished: fewer than ${FINISHED_FRAMES} frames after curing show the final stage with formwork removed.`
        : 'Finishing cannot be evidenced before curing is complete.',
      plain: 'Waiting for site cameras to show the work finished.' });
  }
  if (!inspectedOn) {
    let technical; let plain = 'Not inspected yet.';
    if (!inspectable) { technical = 'No automated inspection: the camera watching this element does not run defect checks.'; plain = 'Not inspected: no inspection camera covers this work.'; }
    else if (lastInspection && lastInspection.violations > 0) { technical = `Latest inspection on ${lastInspection.date} found ${lastInspection.violations} violation-level defect(s); not cleared.`; plain = 'The last inspection found issues that have not been cleared.'; }
    else technical = finishedOn ? 'No clean automated inspection since the element was finished.' : 'Inspection follows finishing.';
    warnings.push({ step: 'inspected', technical, plain });
  }

  const state = inspectedOn ? 'inspected' : finishedOn ? 'finished' : cured ? 'cured' : 'curing';
  return { state, placed_on: placedOn, cure_days_required: need, cure_complete_on: cureCompleteOn, finished_on: finishedOn, inspected_on: inspectedOn, warnings };
}

export const STATE_TEXT = {
  not_placed: 'In progress', curing: 'Placed, curing', cured: 'Cured, finishing not yet evidenced',
  finished: 'Finished, not yet inspected', inspected: 'Finished and inspected',
};
