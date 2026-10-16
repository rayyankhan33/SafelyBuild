// Investor summary: the four numbers that matter and anything that needs attention. Detail is on the other pages.
import { Alerts, Badge, Kpi } from '../../components.jsx';
import { dateText, pkr } from '../../api.js';
import { Footnote, NotReady } from './Shared.jsx';

export default function Summary({ data, go }) {
  if (!data.setup_complete) return <NotReady data={data} />;
  const h = data.headline; const b = h.budget; const s = h.schedule;
  return (
    <>
      <div className="grid cols-4">
        <Kpi label="Progress" value={`${Math.round(h.percent_complete)}%`} sub={`Plan says ${Math.round(h.planned_percent)}% should be done by now.`}>
          <div className="bar" style={{ marginTop: 8 }} role="img" aria-label={`${Math.round(h.percent_complete)} percent complete`}><div style={{ width: `${h.percent_complete}%` }} /></div>
        </Kpi>
        <Kpi label="Money spent so far" value={pkr(b.spent)} badge={<Badge status={b.status} />} sub={`Budget ${pkr(b.bac)}.`} />
        <Kpi label="Expected finish" value={s.forecast_end ? dateText(s.forecast_end) : '—'} badge={<Badge status={s.status} />} sub={`Planned finish ${dateText(s.planned_end)}.`} />
        <Kpi label="Site safety & quality" value={<Badge status={h.safety.status} />} sub={h.safety.text} />
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Needs attention</h2>
        <Alerts alerts={data.alerts} />
        <div className="row" style={{ marginTop: 12 }}>
          <button className="link" onClick={() => go('budget')}>Budget details →</button>
          <button className="link" onClick={() => go('progress')}>Progress and schedule →</button>
          <button className="link" onClick={() => go('safety')}>Safety issues →</button>
        </div>
      </div>
      <Footnote data={data} />
    </>
  );
}
