// Construction progress from camera evidence.
//
// Each zone camera watches one design element. The inference service reports which construction
// stage is visible in a frame (or, for masonry, the fraction of the wall that is built). Progress
// is never typed by anyone: it is the stage that several independent frames agree on.
//
//   - A stage counts only when at least MIN_FRAMES frames in the last WINDOW_DAYS days show it
//     (one noisy frame cannot move progress).
//   - Progress never goes down: a later frame that looks "earlier" is treated as noise.

export const MIN_FRAMES = 2;
export const WINDOW_DAYS = 3;

/**
 * Ordered visible stages per element type. `bounds[i]` is the % complete at which stage i becomes the
 * latest visible stage, so a frame showing stage i means true progress lies in [bounds[i], bounds[i+1]).
 *
 *   - middle stages report the MIDPOINT of their range (a label cannot say where inside the range the
 *     work is; reporting the lower edge would always under-report: a -27 % work-done bias was measured
 *     with that choice);
 *   - stage 0 means nothing built yet (0 %);
 *   - the LAST stage is "concrete visible" and is continuous: the fraction of the element covered by
 *     concrete (pour coverage, 0..1) maps linearly from bounds[last] to 100 %. A model that reports
 *     only the stage is read as fully covered (100 %).
 */
export const STAGE_PLAN = {
  footing: { stages: ['excavation', 'rebar fixed', 'formwork', 'concrete poured'], bounds: [0, 10, 35, 60, 75] },
  column: { stages: ['rebar cage', 'formwork', 'concrete poured'], bounds: [0, 15, 45, 70] },
  beam: { stages: ['formwork', 'rebar fixed', 'concrete poured'], bounds: [0, 15, 45, 70] },
  slab: { stages: ['formwork', 'rebar mesh', 'concrete poured'], bounds: [0, 15, 45, 70] },
  masonry_wall: { continuous: true, stages: [], bounds: [0, 100] },
};

export const isContinuous = (type) => !!STAGE_PLAN[type]?.continuous;

export function stageLabel(type, stage) {
  if (isContinuous(type)) return `${stage}% built`;
  return stage === 0 ? 'not started' : STAGE_PLAN[type].stages[stage - 1];
}

/** Stage the work is in when true progress is `pct` (used by simulations and tests). */
export function stageAtProgress(type, pct) {
  const plan = STAGE_PLAN[type];
  if (!plan || plan.continuous) throw new RangeError(`no stages for '${type}'`);
  let stage = 0;
  const last = plan.bounds.length - 1;
  // tolerance only at completion: a simulated 99.99 % counts as finished, 14.9 % is still before the 15 % bound
  plan.bounds.forEach((b, i) => { if (pct >= (i === last ? b - 0.1 : b)) stage = i; });
  return stage;
}

/**
 * Reported % complete for a visible stage. `coverage` (0..1) only matters for the last stage.
 */
export function percentForStage(type, stage, coverage = 1) {
  const plan = STAGE_PLAN[type];
  if (!plan) throw new RangeError(`unknown element type '${type}'`);
  if (plan.continuous) throw new RangeError('masonry progress is a measured fraction, not a stage');
  const last = plan.bounds.length - 1;
  if (!Number.isInteger(stage) || stage < 0 || stage > last) throw new RangeError(`invalid stage ${stage} for ${type}`);
  if (stage === 0) return 0;
  if (stage === last) {
    const c = Math.min(1, Math.max(0, Number(coverage)));
    return Math.round((plan.bounds[last] + c * (100 - plan.bounds[last])) * 10) / 10;
  }
  return (plan.bounds[stage] + plan.bounds[stage + 1]) / 2;
}

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * The value that at least `minFrames` frames in the window reached (stage number or fraction).
 * @param {{observed_on: string, value: number}[]} obs
 */
export function confirmedValue(obs, asOf, { minFrames = MIN_FRAMES, windowDays = WINDOW_DAYS } = {}) {
  const recent = obs
    .filter((o) => { const d = daysBetween(o.observed_on, asOf); return d >= 0 && d < windowDays; })
    .map((o) => o.value)
    .sort((a, b) => b - a);
  return recent.length >= minFrames ? recent[minFrames - 1] : 0;
}

/**
 * % complete for one element on `asOf`, given every observation so far and yesterday's percent.
 * @param {string} type element type
 * @param {{observed_on: string, stage?: number, fraction?: number}[]} observations
 */
export function percentOnDate(type, observations, asOf, previousPercent = 0) {
  let pct;
  if (isContinuous(type)) {
    const f = confirmedValue(observations.map((o) => ({ observed_on: o.observed_on, value: Number(o.fraction ?? 0) })), asOf);
    pct = Math.round(Math.min(1, Math.max(0, f)) * 1000) / 10;
  } else {
    const last = STAGE_PLAN[type].bounds.length - 1;
    const stage = confirmedValue(observations.map((o) => ({ observed_on: o.observed_on, value: Number(o.stage) })), asOf);
    let coverage = 1;
    if (stage >= last) {
      // pour coverage: the value that at least MIN_FRAMES of the frames showing concrete agree on
      coverage = confirmedValue(
        observations.filter((o) => Number(o.stage) >= last).map((o) => ({ observed_on: o.observed_on, value: Number(o.fraction ?? 1) })), asOf);
    }
    pct = percentForStage(type, Math.min(stage, last), coverage);
  }
  return Math.max(previousPercent, pct); // progress never decreases
}

/**
 * Replay the whole history: returns [{date, percent}] for every date with at least one observation,
 * applying the ratchet. Used by the roll-up so results are identical however often it runs.
 */
export function progressHistory(type, observations) {
  const dates = [...new Set(observations.map((o) => o.observed_on))].sort();
  const out = [];
  let prev = 0;
  for (const d of dates) {
    prev = percentOnDate(type, observations, d, prev);
    out.push({ date: d, percent: prev });
  }
  return out;
}
