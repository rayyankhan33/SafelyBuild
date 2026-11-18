// Engineer view: model-based completion forecast beside the earned-value one (docs/handoff-schedule-assistant.md part A, T8).
// Shows EVM / baseline / ML / blend side by side, a progress chart with the forecast fan, an explanation of
// how the numbers were reached, and a what-if pace slider. Investors never see this panel.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, dateText, shortDate } from '../api.js';

const DAY_MS = 86_400_000;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + Math.round(n) * DAY_MS).toISOString().slice(0, 10);
const months = (d) => (d / 30.44).toFixed(1);
const AXIS = { stroke: 'var(--muted)', fontSize: 12, tickLine: false, axisLine: { stroke: 'var(--axis)' } };
const COLOR = { actual: 'var(--series-3)', plan: 'var(--series-1)', blend: 'var(--series-2)', curve: 'var(--muted)' };
const LEG_NAME = { linear: 'recent pace (straight line)', scurve: 'S-curve fit', earned_schedule: 'earned schedule (plan at measured SPI(t))', plan_spi: 'planned duration ÷ SPI', blend: 'mix of methods' };
const FEATURE_TEXT = {
  es_remaining: 'earned-schedule estimate', evm_remaining: 'EVM estimate (plan ÷ SPI)', baseline_remaining: 'baseline estimate',
  planned_duration_days: 'planned duration', pct: 'percent complete', monsoon_next90: 'monsoon in the next 90 days', spi: 'SPI',
  velocity_recent: 'recent pace', elapsed_days: 'days elapsed', acceleration: 'change in pace', velocity_std: 'pace variability',
  velocity_overall: 'average pace', floors: 'number of floors',
};

function Method({ title, f, note, evm }) {
  if (evm) {
    return (
      <div className="card kpi">
        <div className="label">{title}</div>
        <div className="value" style={{ fontSize: 20 }}>{evm.forecast_end ? dateText(evm.forecast_end) : '-'}</div>
        <div className="sub">{note}</div>
      </div>
    );
  }
  const ok = f && (f.status === 'ok' || f.status === 'complete');
  return (
    <div className="card kpi">
      <div className="label">{title}</div>
      <div className="value" style={{ fontSize: 20 }}>{ok ? dateText(f.completion_date) : '-'}</div>
      <div className="sub">
        {ok ? <>{Math.round(f.remaining_days)} days left · range {dateText(f.lower_date)} – {dateText(f.upper_date)}</>
          : f ? `No date: ${f.details?.fallback_reason ?? f.status.replace('_', ' ')}` : 'Not available'}
      </div>
      {note && <div className="tiny muted" style={{ marginTop: 4 }}>{note}</div>}
    </div>
  );
}

function ForecastChart({ chart, model }) {
  const { start_date: start, actual, planned, curve, extension } = chart;
  const ext = extension.blend ?? extension.baseline;
  const xMax = Math.max(planned.at(-1)?.[0] ?? 0, ext?.upper_day ?? 0, actual.at(-1)?.day ?? 0) + 7;
  const curvePts = useMemo(() => {
    if (!curve) return [];
    const pts = [];
    for (let d = 0; d <= xMax; d += Math.max(1, Math.round(xMax / 120))) pts.push({ day: d, curve: Math.round(1000 / (1 + Math.exp(-curve.k * (d - curve.t0)))) / 10 });
    return pts;
  }, [curve, xMax]);
  const fan = ext ? {
    mid: [{ day: ext.from.day, fc: ext.from.pct }, { day: ext.to_day, fc: 100 }],
    lo: [{ day: ext.from.day, lo: ext.from.pct }, { day: ext.lower_day, lo: 100 }],
    hi: [{ day: ext.from.day, hi: ext.from.pct }, { day: ext.upper_day, hi: 100 }],
  } : null;
  const tick = (d) => shortDate(addDays(start, d));
  return (
    <>
    <div className="legend">
      {[['Planned', COLOR.plan], ['Measured', COLOR.actual], ...(curve ? [['S-curve fit', COLOR.curve]] : []), ['Forecast (shaded: likely finish range)', COLOR.blend]]
        .map(([name, c]) => <span key={name} style={{ '--c': c }}>{name}</span>)}
    </div>
    <div style={{ height: 300 }} aria-label="Progress over time with the forecast to completion">
      <ResponsiveContainer>
        <ComposedChart margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis type="number" dataKey="day" domain={[0, xMax]} tickFormatter={tick} {...AXIS} minTickGap={40} allowDuplicatedCategory={false} />
          <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} {...AXIS} width={44} />
          <Tooltip labelFormatter={(d) => dateText(addDays(start, d))} formatter={(v, name) => [`${Number(v).toFixed(1)}%`, name]}
            contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }} />
          {ext && <ReferenceArea x1={ext.lower_day} x2={ext.upper_day} y1={0} y2={100} fill={COLOR.blend} fillOpacity={0.08} ifOverflow="extendDomain" />}
          {planned.length > 0 && <Line data={planned.map(([day, pct]) => ({ day, plan: pct }))} dataKey="plan" name="Planned" stroke={COLOR.plan} strokeWidth={2} dot={false} isAnimationActive={false} />}
          {curvePts.length > 0 && <Line data={curvePts} dataKey="curve" name="S-curve fit" stroke={COLOR.curve} strokeDasharray="2 4" strokeWidth={1.5} dot={false} isAnimationActive={false} />}
          <Line data={actual.map((o) => ({ day: o.day, actual: o.pct }))} dataKey="actual" name="Measured" stroke={COLOR.actual} strokeWidth={2} dot={false} isAnimationActive={false} />
          {fan && <Line data={fan.mid} dataKey="fc" name="Forecast" stroke={COLOR.blend} strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} />}
          {fan && <Line data={fan.lo} dataKey="lo" name="Forecast (early)" stroke={COLOR.blend} strokeOpacity={0.5} strokeWidth={1} dot={false} isAnimationActive={false} />}
          {fan && <Line data={fan.hi} dataKey="hi" name="Forecast (late)" stroke={COLOR.blend} strokeOpacity={0.5} strokeWidth={1} dot={false} isAnimationActive={false} />}
          {model.planned_end_day != null && <ReferenceLine x={model.planned_end_day} stroke="var(--axis)" strokeDasharray="4 4" label={{ value: 'Planned finish', fill: 'var(--muted)', fontSize: 12, position: 'insideTopRight' }} />}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
    </>
  );
}

function Explain({ model }) {
  const b = model.baseline?.details ?? {};
  const x = model.blend?.details ?? {};
  const top = model.ml?.details?.top_features ?? [];
  const legs = Object.entries(b.leg_weights ?? {}).sort((a, c) => c[1] - a[1]);
  const row = (k, v) => v !== null && v !== undefined && <tr key={k}><td className="muted">{k}</td><td>{v}</td></tr>;
  return (
    <details className="card" style={{ marginTop: 12 }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Explain this forecast</summary>
      <table style={{ marginTop: 8 }}>
        <tbody>
          {row('Measured progress', b.last_pct != null ? `${b.last_pct}% (${b.n_observations} measurements)` : null)}
          {row('Recent pace', b.velocity_pct_per_day != null ? `${b.velocity_pct_per_day}% per day (±${b.velocity_se})` : null)}
          {row('SPI (cost-based)', b.spi)}
          {row('SPI(t) (time-based, earned schedule)', b.spi_t != null ? `${b.spi_t} · the work done was planned for day ${b.earned_schedule_day}` : null)}
          {row('Baseline method', b.fit_used ? LEG_NAME[b.fit_used] ?? b.fit_used : null)}
          {legs.length > 0 && row('Baseline mix', legs.map(([k, w]) => `${LEG_NAME[k] ?? k} ${Math.round(w * 100)}%`).join(' · '))}
          {row('Each baseline method on its own', [
            b.earned_schedule_remaining_days != null && `earned schedule ${Math.round(b.earned_schedule_remaining_days)} d`,
            b.scurve_remaining_days != null && `S-curve ${Math.round(b.scurve_remaining_days)} d`,
            b.linear_remaining_days != null && `straight line ${Math.round(b.linear_remaining_days)} d`,
          ].filter(Boolean).join(' · ') || null)}
          {row('ML share of the final forecast', `${Math.round((x.ml_weight ?? 0) * 100)}%${x.fallback_reason ? ` (not used: ${x.fallback_reason})` : ''}`)}
          {top.length > 0 && row('What the ML model relies on most', top.map(([k]) => FEATURE_TEXT[k] ?? k).join(', '))}
          {row('Model version', model.model_version ?? 'none (baseline only)')}
          {(b.flags ?? []).length > 0 && row('Measurements overruled', b.flags.join('; '))}
        </tbody>
      </table>
      <p className="tiny muted">Baseline: a mix of methods weighted by how well each predicted the most recent measurements, with earned schedule given at least 85 %. ML: gradient boosting (P10/P50/P90) using the baseline and EVM numbers as inputs. Final forecast = ML share × ML + rest × baseline. Ranges are approximate 80 % intervals.</p>
    </details>
  );
}

export default function ScheduleModel({ pid, model, plannedEnd }) {
  const [pace, setPace] = useState(1);
  const [whatIf, setWhatIf] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);
  if (!model) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Model forecast (experimental)</h2>
        <div className="note">The model-based forecast is not available right now (the forecasting service did not answer). The earned-value forecast above is unaffected.</div>
      </div>
    );
  }

  function changePace(v) {
    setPace(v);
    clearTimeout(timer.current);
    if (v === 1) { setWhatIf(null); setErr(''); return; }
    timer.current = setTimeout(async () => {
      setBusy(true);
      try { setWhatIf(await api('POST', `/projects/${pid}/schedule-model/whatif`, { pace_factor: v })); setErr(''); } catch (e) { setErr(e.message); } finally { setBusy(false); }
    }, 350);
  }

  const shown = whatIf ? { ...model, ...whatIf, evm: model.evm } : model;
  const f = shown.blend;
  const startDate = shown.chart?.start_date;
  const plannedEndDay = plannedEnd && startDate ? Math.round((Date.parse(plannedEnd) - Date.parse(startDate)) / DAY_MS) : null;
  const vsPlan = plannedEnd && f?.completion_date ? Math.round((Date.parse(f.completion_date) - Date.parse(plannedEnd)) / DAY_MS) : null;
  return (
    <div className="card" style={{ marginTop: 16 }} aria-busy={busy}>
      <h2>Model forecast (experimental)</h2>
      <p className="small muted">{model.disclaimer}</p>
      {f && f.status === 'ok' ? (
        <p style={{ fontSize: 17, margin: '8px 0 12px' }}>
          <b>Estimated completion: {dateText(f.completion_date)}</b> (about {Math.round(f.remaining_days)} days / {months(f.remaining_days)} months remaining),
          range {dateText(f.lower_date)} – {dateText(f.upper_date)}.
          {vsPlan != null && (vsPlan === 0 ? <> That is on the planned finish date.</> : <> That is <b>{Math.abs(vsPlan)} days {vsPlan > 0 ? 'later' : 'earlier'}</b> than planned ({dateText(plannedEnd)}).</>)}
          {whatIf && <> <span className="badge s-warning"><i aria-hidden>!</i>what-if: pace × {pace.toFixed(2)}</span></>}
        </p>
      ) : (
        <p className="note">No completion date yet: {f?.details?.fallback_reason ?? 'not enough measurements'}.</p>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
        <Method title="Earned value (headline)" evm={model.evm} note={`planned duration ÷ SPI${model.evm?.spi != null ? ` (SPI ${model.evm.spi})` : ''}`} />
        <Method title="Baseline" f={shown.baseline} note="explainable: earned schedule, S-curve, recent pace" />
        <Method title="ML" f={shown.ml} note={shown.ml?.details?.not_used_because ? `shown, not used: ${shown.ml.details.not_used_because}` : 'gradient boosting, P10–P90'} />
        <Method title="Final (blend)" f={shown.blend} note={`${Math.round((shown.blend?.details?.ml_weight ?? 0) * 100)}% ML`} />
      </div>
      {shown.chart && <div style={{ marginTop: 12 }}><ForecastChart chart={shown.chart} model={{ planned_end_day: plannedEndDay }} /></div>}
      <div className="row" style={{ marginTop: 12, alignItems: 'center', gap: 12 }}>
        <label className="field" style={{ minWidth: 260 }}>
          What if the pace from today is {pace === 1 ? 'unchanged' : `${Math.round(Math.abs(pace - 1) * 100)}% ${pace > 1 ? 'faster' : 'slower'}`}?
          <input type="range" min={0.5} max={1.5} step={0.05} value={pace} onChange={(e) => changePace(Number(e.target.value))} aria-label="Future pace factor" />
        </label>
        {pace !== 1 && <button className="link" onClick={() => changePace(1)}>Reset</button>}
        {busy && <span className="small muted">Recalculating…</span>}
        {err && <span className="err small">{err}</span>}
      </div>
      <Explain model={shown} />
    </div>
  );
}
