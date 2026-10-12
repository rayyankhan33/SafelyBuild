// Material consumption from yard-camera stock estimates.
//
// A yard camera reports how much of each material it can see. Two frames a day are enough to tell
// consumption from delivery:
//
//   consumed(day)  = stock in the first frame of the day - stock in the last frame of the day
//   delivered(day) = stock in the first frame of the day - stock in the last frame of the previous day
//
// Deliveries normally arrive before work starts, so a delivery day still shows the day's consumption
// inside the day. Image-based quantities are noisy (and, in the synthetic demo, biased a few percent
// low), so changes smaller than DEADBAND of the stock are treated as measurement noise.
// Limitation (documented): a delivery that arrives mid-day hides that day's consumption, and a day
// with a single frame cannot show consumption at all.

export const DEADBAND = 0.02;
export const DELIVERY_FRACTION = 0.15;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * One day's start and end stock per material. Per camera the earliest and latest frame of the day
 * are used; cameras covering different yards are added together.
 * @param {{camera_id: string, material_code: string, quantity: number, captured_at: Date|string}[]} frames
 * @returns {{start: Record<string, number>, end: Record<string, number>}}
 */
export function dailyStock(frames) {
  const byKey = new Map();
  for (const f of frames) {
    const key = `${f.material_code}|${f.camera_id}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ t: new Date(f.captured_at).getTime(), q: Number(f.quantity) });
  }
  const start = {};
  const end = {};
  for (const [key, list] of byKey) {
    const code = key.split('|')[0];
    list.sort((a, b) => a.t - b.t);
    const firstT = list[0].t;
    const lastT = list[list.length - 1].t;
    start[code] = (start[code] ?? 0) + median(list.filter((x) => x.t === firstT).map((x) => x.q));
    end[code] = (end[code] ?? 0) + median(list.filter((x) => x.t === lastT).map((x) => x.q));
  }
  return { start, end };
}

/**
 * Replay all days. `days` sorted by date: [{date, start: {code: qty}, end: {code: qty}}].
 * @returns {{date, material_code, start, end, used, delivered}[]}
 */
export function inventoryHistory(days, minDeliveryByCode = {}) {
  const prevEnd = {};
  const out = [];
  for (const { date, start, end } of days) {
    for (const code of Object.keys(end)) {
      const s = start[code] ?? end[code];
      const e = end[code];
      const used = s - e > s * DEADBAND ? s - e : 0;
      let delivered = 0;
      if (prevEnd[code] !== undefined) {
        const rise = s - prevEnd[code];
        if (rise > Math.max(prevEnd[code] * DELIVERY_FRACTION, minDeliveryByCode[code] ?? 0)) delivered = rise;
      }
      out.push({ date, material_code: code, start: s, end: e, used, delivered });
      prevEnd[code] = e;
    }
  }
  return out;
}
