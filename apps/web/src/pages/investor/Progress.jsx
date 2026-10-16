// Investor progress page: how much is built, whether it is on time, and which parts of the work are done.
import { useEffect, useState } from 'react';
import { Badge, Kpi, ProductivityChart, ProgressChart } from '../../components.jsx';
import { api, dateText } from '../../api.js';
import { Footnote, NotReady } from './Shared.jsx';

export default function Progress({ data, pid }) {
  const [tasks, setTasks] = useState([]);
  useEffect(() => { if (data.setup_complete) api('GET', `/projects/${pid}/schedule`).then((r) => setTasks(r.tasks)).catch(() => {}); }, [pid, data.setup_complete]);
  if (!data.setup_complete) return <NotReady data={data} />;
  const h = data.headline; const s = h.schedule;
  const late = s.days_late > 0 ? `${s.days_late} days late` : s.days_late < 0 ? `${-s.days_late} days early` : 'on time';
  return (
    <>
      <div className="grid cols-3">
        <Kpi label="Complete" value={`${Math.round(h.percent_complete)}%`} sub={`Plan says ${Math.round(h.planned_percent)}% by now.`}>
          <div className="bar" style={{ marginTop: 8 }}><div style={{ width: `${h.percent_complete}%` }} /></div>
        </Kpi>
        <Kpi label="Expected finish" value={s.forecast_end ? dateText(s.forecast_end) : '—'} badge={<Badge status={s.status} />} sub={`Planned ${dateText(s.planned_end)} · ${late}`} />
        <Kpi label="Crew output" value={h.productivity.text.split('.')[0]} />
      </div>
      <div className="card" style={{ marginTop: 16 }}><h2>In plain words</h2><p>{s.text}</p><p style={{ marginBottom: 0 }}>{h.productivity.text}</p></div>
      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <ProgressChart series={data.series} bac={h.budget.bac} />
        <ProductivityChart series={data.series} />
      </div>
      <div className="card table-wrap" style={{ marginTop: 16 }}>
        <h2>Work packages</h2>
        <table>
          <thead><tr><th>Work</th><th>Planned finish</th><th style={{ minWidth: 160 }}>Done</th></tr></thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}><td>{t.name}</td><td>{dateText(t.planned_end)}</td>
                <td><div className="bar"><div style={{ width: `${t.percent_complete}%` }} /></div><span className="tiny">{Math.round(t.percent_complete)}%</span></td></tr>
            ))}
            {!tasks.length && <tr><td colSpan={3} className="muted">No schedule yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <Footnote data={data} />
    </>
  );
}
