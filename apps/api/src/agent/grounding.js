// Number grounding: every figure and date the agent writes must come from a tool result.
//
// A language model can state a number that is nowhere in the data. This check finds such numbers after the
// run, so the answer can be shown with a warning (or withheld from investors) instead of being trusted.
// It is a guard against invented figures, NOT a proof that the reasoning is right.
//
// Matching rules (deliberately forgiving about format, strict about value):
//   - rounding: 143 matches 143.2 (relative tolerance 0.5 %; or a difference up to 0.5 for values of 10 or more)
//   - percent vs fraction: "87 %" matches 0.87
//   - PKR units: "1.25 crore" matches 12500000, "3.4 lakh" matches 340000
//   - differences are NOT derived: if the agent computes a new number itself, it is reported as ungrounded
//     (the prompts tell it to use the what-if tools for arithmetic)
//   - integers from 0 to 10 are ignored ("3 options", "2 crews" in prose), as are 4-digit years

const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const NUMBER = /-?\d[\d,]*(?:\.\d+)?/g;
const IGNORE_MAX_INT = 10;

// written-out dates ("30 January 2027", "6 Mar 2027", "January 30, 2027") are read as dates, not as numbers
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?';
const DMY = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+` + MON + String.raw`\s+(\d{4})\b`, 'gi');
const MDY = new RegExp(String.raw`\b` + MON + String.raw`\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b`, 'gi');
const iso = (y, m, d) => `${y}-${String(MONTHS.indexOf(m.slice(0, 3).toLowerCase()) + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Replace written-out dates with their ISO form, so they are checked as dates. */
export function normaliseDates(text) {
  return String(text).replace(DMY, (_m, d, mon, y) => iso(y, mon, d)).replace(MDY, (_m, mon, d, y) => iso(y, mon, d));
}

/** Numbers and ISO dates found in free text. */
export function extractClaims(rawText) {
  const text = normaliseDates(rawText);
  const dates = text.match(ISO_DATE) ?? [];
  const numbers = (text.replace(ISO_DATE, ' ').match(NUMBER) ?? [])
    .map((s) => Number(s.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n))
    .filter((n) => !(Number.isInteger(n) && Math.abs(n) <= IGNORE_MAX_INT))
    .filter((n) => !(Number.isInteger(n) && n >= 1900 && n <= 2100));
  return { numbers, dates };
}

/** Every number and ISO date anywhere inside tool results (walks nested JSON; reads numbers inside strings too). */
export function collectFacts(toolResults) {
  const numbers = [];
  const dates = new Set();
  const visit = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) numbers.push(v);
    else if (typeof v === 'string') {
      v = normaliseDates(v);
      for (const d of v.match(ISO_DATE) ?? []) dates.add(d);
      for (const s of v.replace(ISO_DATE, ' ').match(NUMBER) ?? []) {
        const n = Number(s.replace(/,/g, ''));
        if (Number.isFinite(n)) numbers.push(n);
      }
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(toolResults);
  return { numbers, dates };
}

const rel = (a, b) => Math.abs(a - b) <= 0.005 * Math.max(a, b);
// same unit: 0.5 % or, for values of 10 or more, rounding to a whole number (0.6 must not match 0.87)
const close = (a, b) => rel(a, b) || (Math.min(a, b) >= 10 && Math.abs(a - b) <= 0.5);

/** Does claim n match fact f? Same unit with rounding, a percentage of a fraction (or back), or lakh / crore of PKR. */
function matches(n, f) {
  const a = Math.abs(n); const b = Math.abs(f);
  if (close(a, b)) return true;
  if (a <= 100 && rel(a / 100, b)) return true;        // '87 %' for 0.87
  if (a <= 1 && rel(a * 100, b)) return true;          // '0.87' for 87 %
  if (a < 10000 && (rel(a * 1e5, b) || rel(a * 1e7, b))) return true; // '46.39 lakh', '5.81 crore'
  return false;
}

/**
 * @param {string} answer         the agent's final text
 * @param {object[]} toolResults  runAgent().toolResults
 * @returns {{grounded: boolean, checked: number, ungrounded: (number|string)[]}}
 */
export function checkGrounding(answer, toolResults) {
  const claims = extractClaims(answer ?? '');
  const facts = collectFacts(toolResults);
  const ungrounded = [
    ...claims.dates.filter((d) => !facts.dates.has(d)),
    ...claims.numbers.filter((n) => !facts.numbers.some((f) => matches(n, f))),
  ];
  return { grounded: ungrounded.length === 0, checked: claims.dates.length + claims.numbers.length, ungrounded };
}
