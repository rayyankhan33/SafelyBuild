// Investor budget page: where the money stands, where it went, and what the final cost is expected to be.
import { Badge, DailySpendChart, Kpi, MoneyChart } from '../../components.jsx';
import { pkr } from '../../api.js';
import CostBreakdown from '../../components/CostBreakdown.jsx';
import { Footnote, NotReady } from './Shared.jsx';

export default function Budget({ data }) {
  if (!data.setup_complete) return <NotReady data={data} />;
  const b = data.headline.budget;
  const range = b.forecast_low && b.forecast_high && Math.abs(b.forecast_high - b.forecast_low) > b.bac * 0.005
    ? ` (between ${pkr(b.forecast_low)} and ${pkr(b.forecast_high)})` : '';
  const total = data.spend_by_material.reduce((t, m) => t + m.cost_pkr, 0);
  return (
    <>
      <div className="grid cols-4">
        <Kpi label="Approved budget" value={pkr(b.bac)} />
        <Kpi label="Spent so far" value={pkr(b.spent)} badge={<Badge status={b.status} />} sub={`${Math.round((b.spent / b.bac) * 100)}% of the budget`} />
        <Kpi label="Value of work completed" value={pkr(b.earned_value)} sub="What the finished work was budgeted to cost." />
        <Kpi label="Expected final cost" value={b.forecast_final ? pkr(b.forecast_final) : '—'} sub={b.forecast_final ? `Currently projected${range}.` : 'Not enough work done to project yet.'} />
      </div>
      <div className="card" style={{ marginTop: 16 }}><h2>In plain words</h2><p style={{ marginBottom: 0 }}>{b.text}</p></div>
      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <MoneyChart series={data.series} bac={b.bac} />
        <DailySpendChart series={data.series} />
      </div>
      <div style={{ marginTop: 16 }}><CostBreakdown cost={data.cost} /></div>
      {(
        <div className="card table-wrap" style={{ marginTop: 16 }}>
          <h2>Materials spent, by material</h2>
          <table>
            <thead><tr><th>Material</th><th className="num">Spent</th><th className="num">Share of materials</th></tr></thead>
            <tbody>
              {data.spend_by_material.map((m) => <tr key={m.material}><td>{m.material}</td><td className="num">{pkr(m.cost_pkr)}</td><td className="num">{total ? Math.round((m.cost_pkr / total) * 100) : 0}%</td></tr>)}
              {!data.spend_by_material.length && <tr><td colSpan={3} className="muted">No material use measured yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      <Footnote data={data} />
    </>
  );
}
