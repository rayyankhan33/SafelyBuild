import Investor from '../Investor.jsx';
import { Badge } from '../../components.jsx';

export default function Overview({ data }) {
  if (!data.setup_complete) {
    return <div className="note">Setup is not finished. Go to <b>Design &amp; estimate</b>: add elements, create the estimate, then generate the schedule on the <b>Schedule</b> tab.</div>;
  }
  const h = data.headline;
  const m = data.metrics;
  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Technical status</h2>
        <div className="table-wrap">
          <table>
            <tbody>
              <tr><th>Budget</th><td><Badge status={h.budget.status} /></td><td>{h.budget.technical}</td></tr>
              <tr><th>Schedule</th><td><Badge status={h.schedule.status} /></td><td>{h.schedule.technical}</td></tr>
              <tr><th>Safety</th><td><Badge status={h.safety.status} /></td><td>{h.safety.technical}</td></tr>
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          BAC {m.bac.toLocaleString('en-PK')} · PV {m.pv.toLocaleString('en-PK')} · EV {m.ev.toLocaleString('en-PK')} · AC {m.ac.toLocaleString('en-PK')} (PKR) ·
          {' '}CV {m.cost_variance.toLocaleString('en-PK')} · SV {m.schedule_variance.toLocaleString('en-PK')} · {m.log_days} daily logs.
          {' '}Method: {h.budget.method ?? 'EAC = BAC / CPI'}; schedule forecast = planned duration / SPI (ANSI/EIA-748 earned value).
        </p>
      </div>
      <Investor data={data} compact />
    </>
  );
}
