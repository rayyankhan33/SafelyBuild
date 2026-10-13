// Alert rules: given the current forecasts and safety status, decide which alerts should be open.
// The persistence layer opens new keys and resolves keys that are no longer wanted, so each
// condition produces exactly one open alert no matter how often the numbers are recomputed.

import { budgetText, scheduleText } from './narrative.js';

export function desiredAlerts({ budget, schedule, safety, sdi, evidence }) {
  const out = [];

  if (budget.status === 'at_risk' || budget.status === 'over_budget') {
    const t = budgetText(budget);
    out.push({
      kind: 'budget', level: budget.status === 'over_budget' ? 'critical' : 'warning',
      dedupe_key: `budget:${budget.status}`, technical_msg: t.technical, plain_msg: t.plain,
    });
  }

  if (schedule.status === 'at_risk' || schedule.status === 'behind') {
    const t = scheduleText(schedule);
    out.push({
      kind: 'schedule', level: schedule.status === 'behind' ? 'critical' : 'warning',
      dedupe_key: `schedule:${schedule.status}`, technical_msg: t.technical, plain_msg: t.plain,
    });
  }

  if (safety.status === 'critical' || safety.status === 'high') {
    out.push({
      kind: 'risk', level: safety.status === 'critical' ? 'critical' : 'warning',
      dedupe_key: `risk:${safety.status}`,
      technical_msg: `Safety status ${safety.status}: SDI ${sdi?.sdi ?? 'n/a'}, worst hazard rating ${safety.worst_rating}/25, ${safety.intolerable ?? 0} intolerable hazard(s).${sdi?.escalate ? ' SDI is above the escalation threshold.' : ''}`,
      plain_msg: safety.status === 'critical'
        ? 'Critical quality or safety issues were detected on site by the cameras.'
        : 'Serious quality or safety issues were detected on site by the cameras.',
    });
  }

  if (evidence?.quiet_cameras?.length) {
    out.push({
      kind: 'system', level: 'warning', dedupe_key: 'evidence:cameras',
      technical_msg: `No recent frames from: ${evidence.quiet_cameras.join(', ')}. Progress, stock and defects for these areas are not being verified.`,
      plain_msg: 'Some site cameras have not reported recently, so current conditions in those areas are not verified.',
    });
  }
  if (evidence?.uncovered_tasks?.length) {
    out.push({
      kind: 'system', level: 'warning', dedupe_key: 'evidence:uncovered',
      technical_msg: `No camera covers: ${evidence.uncovered_tasks.join(', ')}. Their progress cannot be measured.`,
      plain_msg: 'Part of the project has no camera coverage, so its progress cannot be verified.',
    });
  }
  return out;
}

/**
 * Compare desired alerts with currently open ones -> what to insert, which ids to resolve, and which
 * open alerts need fresh wording (same condition, but the numbers or the names in the message changed,
 * e.g. a different set of silent cameras or a new forecast figure).
 */
export function diffAlerts(desired, open) {
  const want = new Set(desired.map((a) => a.dedupe_key));
  const openByKey = new Map(open.map((a) => [a.dedupe_key, a]));
  return {
    toCreate: desired.filter((a) => !openByKey.has(a.dedupe_key)),
    toResolve: open.filter((a) => !want.has(a.dedupe_key)).map((a) => a.id),
    toUpdate: desired
      .filter((a) => openByKey.has(a.dedupe_key))
      .filter((a) => { const o = openByKey.get(a.dedupe_key); return o.technical_msg !== a.technical_msg || o.plain_msg !== a.plain_msg; })
      .map((a) => ({ id: openByKey.get(a.dedupe_key).id, technical_msg: a.technical_msg, plain_msg: a.plain_msg })),
  };
}
