// Engineer's technical overview: variances, indices and the method behind them. The plain-language
// story told to investors lives on the investor pages, not here.
import CostBreakdown from '../../components/CostBreakdown.jsx';
import { Badge, DailySpendChart, MoneyChart, ProductivityChart, ProgressChart } from '../../components.jsx';

export default function Overview({ data }) {
  if (!data.setup_complete) {
    return <div className="note">Setup is not finished. Go to <b>Design &amp; estimate</b>: add elements, create the estimate, then generate the schedule on the <b>Schedule</b> tab.</div>;
  }
  const h = data.headline;
  const m = data.metrics;
  const n = (v) => Number(v).toLocaleString('en-PK');
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
          BAC {n(m.bac)} · PV {n(m.pv)} · EV {n(m.ev)} · AC {n(m.ac)} (PKR) · CV {n(m.cost_variance)} · SV {n(m.schedule_variance)} · {m.log_days} daily logs.
          {' '}Method: {h.budget.method ?? 'EAC = BAC / CPI'}; schedule forecast = planned duration / SPI (ANSI/EIA-748 earned value).
        </p>
      </div>
      <div style={{ marginBottom: 16 }}><CostBreakdown cost={data.cost} showSources /></div>
      {data.cost?.warnings?.map((w) => <div key={w} className="alert warning" style={{ marginBottom: 12 }}><b>!</b><div>{w}</div></div>)}
      <div className="grid cols-2">
        <MoneyChart series={data.series} bac={h.budget.bac} />
        <ProgressChart series={data.series} bac={h.budget.bac} />
        <DailySpendChart series={data.series} />
        <ProductivityChart series={data.series} />
      </div>
    </>
  );
}
