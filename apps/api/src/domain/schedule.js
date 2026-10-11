// Baseline schedule generation: BOQ elements -> ordered tasks with planned dates and budget.
//
// Method (deliberately simple and explainable):
//   * duration  = max(minimum, ceil(volume / (output per crew-day x crews)))  working days
//   * order     = the order the elements are listed in the BOQ (engineer's build sequence)
//   * logic     = each task starts the working day after its predecessor finishes (finish-to-start)
//   * calendar  = Monday-Saturday
// The engineer can edit dates afterwards; the generator only provides a defensible first cut.

import { addDays, addWorkingDays, nextWorkingDay } from './dates.js';
import { elementVolume } from './estimation.js';

/**
 * @param {object[]} elements
 * @param {object[]} productivity rows {element_type, output_per_day, min_duration_days, sequence_no}
 * @param {Record<string,number>} elementCost PKR per element id (from the estimate, contingency included)
 * @param {string} startDate  YYYY-MM-DD
 * @param {number} crews
 */
export function generateSchedule(elements, productivity, elementCost, startDate, crews = 1) {
  if (!elements.length) throw new RangeError('no design elements to schedule');
  if (!(crews >= 1)) throw new RangeError('crews must be at least 1');
  const prod = Object.fromEntries(productivity.map((p) => [p.element_type, p]));

  const ordered = elements; // BOQ order = build order: the engineer lists elements in the order they will be built

  const tasks = [];
  let cursor = nextWorkingDay(startDate);
  ordered.forEach((el, i) => {
    const p = prod[el.element_type];
    if (!p) throw new RangeError(`no productivity rate for element type '${el.element_type}'`);
    const days = Math.max(p.min_duration_days, Math.ceil(elementVolume(el) / (Number(p.output_per_day) * crews)));
    const start = cursor;
    const end = addWorkingDays(start, days - 1);
    tasks.push({
      element_id: el.id, name: `${el.label} (${el.element_type.replace('_', ' ')})`,
      seq: i + 1, planned_start: start, planned_end: end,
      planned_cost_pkr: elementCost[el.id] ?? 0, duration_days: days,
    });
    cursor = nextWorkingDay(addDays(end, 1));
  });
  const dependencies = tasks.slice(1).map((t, i) => ({ seq: t.seq, depends_on_seq: tasks[i].seq }));
  return { tasks, dependencies, planned_end: tasks[tasks.length - 1].planned_end };
}
