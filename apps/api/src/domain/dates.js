// Calendar helpers. All dates are 'YYYY-MM-DD' strings handled in UTC so the server time zone
// can never shift a day. The working week is Monday-Saturday (Sunday off), as is usual on
// Pakistani sites; change WORKING_DAYS to alter it everywhere.

const DAY_MS = 86_400_000;
export const WORKING_DAYS = new Set([1, 2, 3, 4, 5, 6]); // getUTCDay(): 0 = Sunday

export function parse(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new RangeError(`bad date '${iso}', expected YYYY-MM-DD`);
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) throw new RangeError(`invalid date '${iso}'`);
  return d;
}
export const fmt = (d) => d.toISOString().slice(0, 10);
export const addDays = (iso, n) => fmt(new Date(parse(iso).getTime() + n * DAY_MS));
export const diffDays = (a, b) => Math.round((parse(b).getTime() - parse(a).getTime()) / DAY_MS); // b - a
export const isWorkingDay = (iso) => WORKING_DAYS.has(parse(iso).getUTCDay());

/** First working day on or after `iso`. */
export function nextWorkingDay(iso) {
  let d = iso;
  while (!isWorkingDay(d)) d = addDays(d, 1);
  return d;
}

/** Date reached after `n` additional working days (n >= 0) starting from a working day. */
export function addWorkingDays(iso, n) {
  let d = nextWorkingDay(iso);
  for (let i = 0; i < n; i++) d = nextWorkingDay(addDays(d, 1));
  return d;
}

/** Number of working days in [from, to] inclusive; 0 when to < from. */
export function workingDaysInclusive(from, to) {
  if (diffDays(from, to) < 0) return 0;
  let n = 0;
  for (let d = from; diffDays(d, to) >= 0; d = addDays(d, 1)) if (isWorkingDay(d)) n++;
  return n;
}

export function eachDay(from, to) {
  const out = [];
  for (let d = from; diffDays(d, to) >= 0; d = addDays(d, 1)) out.push(d);
  return out;
}

// The site's local calendar date (UTC + offset, default +5 for Pakistan), matching how camera frames are dated.
const SITE_OFFSET_HOURS = Number(process.env.SITE_UTC_OFFSET_HOURS ?? 5);
export const today = () => fmt(new Date(Date.now() + SITE_OFFSET_HOURS * 3_600_000));
