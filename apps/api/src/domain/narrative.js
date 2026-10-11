// Turns computed metrics into wording. Two audiences, same numbers:
//   plain     - investors, no jargon (no "CPI", "SDI", "ALARP")
//   technical - engineers, with the index values
// Keeping this separate from the maths means the wording can be reviewed (and tested) alone.

export function pkr(n) {
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e7) return `${sign}PKR ${(a / 1e7).toFixed(2)} crore`;
  if (a >= 1e5) return `${sign}PKR ${(a / 1e5).toFixed(2)} lakh`;
  return `${sign}PKR ${Math.round(a).toLocaleString('en-PK')}`;
}

const dateText = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function budgetText(b) {
  switch (b.status) {
    case 'no_budget':
      return { plain: 'No budget has been set for this project yet.', technical: 'No active cost estimate: generate and activate an estimate.' };
    case 'insufficient_data':
      return {
        plain: `We need a few more days of site records before we can forecast the final cost (${b.needed_days} more).`,
        technical: `Insufficient data for EAC: need ${b.needed_days} more daily log(s) with measured progress and spend.`,
      };
    case 'on_track':
    case 'under_budget': {
      const word = b.status === 'under_budget' ? 'slightly under' : 'in line with';
      return {
        plain: `Spending is ${word} budget. Projected final cost is ${pkr(b.eac)} against a budget of ${pkr(b.bac)}.`,
        technical: `CPI ${b.cpi}; EAC ${pkr(b.eac)} (range ${pkr(b.eac_low)} - ${pkr(b.eac_high)}) vs BAC ${pkr(b.bac)}.`,
      };
    }
    case 'at_risk':
    case 'over_budget': {
      const level = b.status === 'over_budget' ? 'is on course to exceed' : 'may go over';
      return {
        plain: `The project ${level} its budget by about ${pkr(b.overrun)} (${b.overrun_pct}%). Projected final cost: ${pkr(b.eac)}.`,
        technical: `CPI ${b.cpi}: overrun ${pkr(b.overrun)} (${b.overrun_pct}%), EAC ${pkr(b.eac)}, range ${pkr(b.eac_low)} - ${pkr(b.eac_high)} vs BAC ${pkr(b.bac)}.`,
      };
    }
    default:
      return { plain: '', technical: '' };
  }
}

export function scheduleText(s) {
  switch (s.status) {
    case 'not_started':
      return { plain: `Work is planned to start on ${dateText(s.planned_start)}.`, technical: 'Status date is before planned start.' };
    case 'insufficient_data':
      return {
        plain: `We need a few more days of site records before we can forecast the finish date (${s.needed_days} more).`,
        technical: `Insufficient data for schedule forecast: need ${s.needed_days} more daily log(s).`,
      };
    case 'completed':
    case 'completed_late':
      return {
        plain: s.days_late > 0 ? `Work finished ${s.days_late} day(s) after the planned date.` : 'Work is complete and finished on time or early.',
        technical: `All tasks at 100%; finished ${dateText(s.forecast_end)} (${s.days_late} calendar day(s) vs plan).`,
      };
    default: {
      if (!s.forecast_end) return { plain: 'No measurable progress has been recorded yet, so a finish date cannot be forecast.', technical: s.reason ?? '' };
      const d = s.days_late;
      const timing = d > 0 ? `${d} day(s) late` : d < 0 ? `${-d} day(s) early` : 'on time';
      const lead = { ahead: 'The project is ahead of schedule', on_track: 'The project is on schedule', at_risk: 'The project is slipping', behind: 'The project is significantly behind schedule' }[s.status];
      return {
        plain: `${lead}. Expected finish: ${dateText(s.forecast_end)} (${timing}).`,
        technical: `SPI ${s.spi}; forecast ${s.forecast_working_days} working days vs ${s.planned_working_days} planned; finish ${dateText(s.forecast_end)} (${timing}).${s.capped ? ' Forecast capped at 10x plan.' : ''}`,
      };
    }
  }
}

export function productivityText(p) {
  if (p.label === 'unknown') return 'Productivity cannot be measured yet.';
  const pct = Math.round(p.recent_avg * 100);
  return `Crews are completing about ${pct}% of the planned work each day (${p.label}).`;
}

export function safetyText(s, sdi) {
  const lines = {
    no_data: 'No site inspections have been analysed yet.',
    low: 'No significant safety or quality concerns are open.',
    moderate: 'Some quality or safety issues have been found; the site team is managing them.',
    high: 'Serious quality or safety issues have been found and need prompt action by the engineer.',
    critical: 'Critical quality or safety issues are open. Work on the affected area should stop until an engineer clears it.',
  };
  return {
    plain: lines[s.status],
    technical: s.status === 'no_data' ? lines.no_data
      : `Overall ${s.status}. SDI ${sdi?.sdi ?? 'n/a'} (${s.sdi_level ?? 'n/a'}); worst open hazard rating ${s.worst_rating}/25 (${s.hazard_level ?? 'none'}); ${s.open_hazards} open hazard(s), ${s.intolerable ?? 0} intolerable.`,
  };
}
