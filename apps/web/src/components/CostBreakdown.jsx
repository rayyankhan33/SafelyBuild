// Planned vs spent so far, by cost category. Shared by the engineer and the investor (same figures, different pages).
import { pkr } from '../api.js';

const ROWS = [['materials', 'Materials', 'Measured from the yard cameras'], ['labour', 'Labour', 'Crews logged on site × the crew rate'],
  ['equipment', 'Equipment', 'Units logged on site × the hire rate'], ['overheads', 'Overheads', 'A fixed percentage of the direct cost']];

export default function CostBreakdown({ cost, showSources = false }) {
  if (!cost) return null;
  const total = cost.scope === 'total';
  const rows = total ? ROWS : ROWS.slice(0, 1);
  return (
    <div className="card table-wrap">
      <h2>Where the money goes</h2>
      <table>
        <thead><tr><th>Cost</th><th className="num">Budget</th><th className="num">Spent so far</th><th className="num">Spent of budget</th>{showSources && <th>How it is known</th>}</tr></thead>
        <tbody>
          {rows.map(([k, label, how]) => (
            <tr key={k}>
              <td>{label}</td><td className="num">{pkr(cost.planned[k])}</td><td className="num">{pkr(cost.actual[k])}</td>
              <td className="num">{cost.planned[k] > 0 ? `${Math.round((cost.actual[k] / cost.planned[k]) * 100)}%` : '—'}</td>
              {showSources && <td className="tiny">{how}</td>}
            </tr>
          ))}
          <tr><th>Total</th><th className="num">{pkr(cost.planned.total)}</th><th className="num">{pkr(cost.actual.total)}</th>
            <th className="num">{cost.planned.total > 0 ? `${Math.round((cost.actual.total / cost.planned.total) * 100)}%` : '—'}</th>{showSources && <th />}</tr>
        </tbody>
      </table>
      {!total && <p className="tiny" style={{ marginBottom: 0 }}>Labour, equipment and overheads are not included yet: the engineer has not entered their rates.</p>}
      {total && <p className="tiny" style={{ marginBottom: 0 }}>Spent so far can run ahead of budget on a line that is not finished yet; the overall picture is on the Budget forecast.</p>}
    </div>
  );
}
