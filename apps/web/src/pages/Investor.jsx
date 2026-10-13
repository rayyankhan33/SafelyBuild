// Investor dashboard: plain language, no engineering jargon. Every figure comes from the API
// (/projects/:id/dashboard) which computes it from site records; nothing here is hard-coded.
import { Alerts, Badge, DailySpendChart, Kpi, MoneyChart, PhotoGrid, ProductivityChart, ProgressChart } from '../components.jsx';
import { dateText, pkr } from '../api.js';

export default function Investor({ data, compact = false }) {
  const h = data.headline;
  if (!data.setup_complete) {
    return (
      <>
        {!compact && <Header data={data} />}
        <div className="note">{data.setup_hint}</div>
      </>
    );
  }
  const b = h.budget; const s = h.schedule;
  const range = b.forecast_low && b.forecast_high && Math.abs(b.forecast_high - b.forecast_low) > b.bac * 0.005
    ? ` (between ${pkr(b.forecast_low)} and ${pkr(b.forecast_high)})` : '';
  return (
    <>
      {!compact && <Header data={data} />}
      <div className="grid cols-4">
        <Kpi label="Progress" value={`${Math.round(h.percent_complete)}%`} sub={`Plan says ${Math.round(h.planned_percent)}% should be done by now.`}>
          <div className="bar" style={{ marginTop: 8 }} role="img" aria-label={`${Math.round(h.percent_complete)} percent complete`}><div style={{ width: `${h.percent_complete}%` }} /></div>
        </Kpi>
        <Kpi label="Money spent so far" value={pkr(b.spent)} badge={<Badge status={b.status} />}
          sub={b.forecast_final ? `Budget ${pkr(b.bac)}. Expected final cost ${pkr(b.forecast_final)}${range}.` : `Budget ${pkr(b.bac)}.`} />
        <Kpi label="Expected finish" value={s.forecast_end ? dateText(s.forecast_end) : '—'} badge={<Badge status={s.status} />}
          sub={`Planned finish ${dateText(s.planned_end)}${s.days_late > 0 ? ` · ${s.days_late} days late` : s.days_late < 0 ? ` · ${-s.days_late} days early` : ''}`} />
        <Kpi label="Site safety & quality" value={<Badge status={h.safety.status} />} sub={h.safety.text} />
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>In plain words</h2>
          <p><b>Money.</b> {b.text}</p>
          <p><b>Time.</b> {s.text}</p>
          <p><b>Productivity.</b> {h.productivity.text}</p>
          <p style={{ marginBottom: 0 }}><b>Safety.</b> {h.safety.text}</p>
        </div>
        <div className="card">
          <h2>Needs attention</h2>
          <Alerts alerts={data.alerts} />
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <MoneyChart series={data.series} bac={b.bac} />
        <ProgressChart series={data.series} bac={b.bac} />
        <DailySpendChart series={data.series} />
        <ProductivityChart series={data.series} />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Recent site photos</h2>
        <PhotoGrid media={data.recent_media} />
      </div>
      <p className="tiny">{data.evidence?.note} {data.evidence?.gap ? 'Some cameras have not reported recently, so the most recent figures may lag. ' : ''}Costs cover materials only (cement, sand, aggregate, steel, bricks); labour and equipment are not included. Quantities are estimated from images and carry measurement error.</p>
    </>
  );
}

function Header({ data }) {
  const p = data.project;
  return (
    <div style={{ marginBottom: 16 }}>
      {p.is_demo && <div className="note" style={{ marginBottom: 8 }}><b>Demo project.</b> The camera frames behind these figures are synthetic drawings made for demonstration.</div>}
      <h1>{p.name}</h1>
      <div className="muted small">{p.location} · started {dateText(p.start_date)} · updated {dateText(data.as_of)}</div>
    </div>
  );
}
