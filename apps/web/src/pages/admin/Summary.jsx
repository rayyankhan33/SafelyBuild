// Administrator's summary: is this project set up and is the evidence flowing? Administrators do not enter
// project content and do not run the project; they keep the system and its access in order.
import { Alerts, Kpi } from '../../components.jsx';
import { dateText, pkr } from '../../api.js';

export default function Summary({ data, go }) {
  const cams = data.evidence?.cameras ?? [];
  const count = (st) => cams.filter((c) => c.status === st).length;
  const p = data.project;
  return (
    <>
      <div className="grid cols-4">
        <Kpi label="Project setup" value={data.setup_complete ? 'Complete' : 'Not finished'} sub={data.setup_complete ? 'BOQ, budget and schedule entered by the engineer.' : 'Waiting for the engineer to enter the BOQ, budget and schedule.'} />
        <Kpi label="Cameras reporting" value={`${count('ok')} of ${cams.filter((c) => ['ok', 'stale', 'never'].includes(c.status)).length}`} sub={`${count('stale') + count('never')} overdue or never reported`} />
        <Kpi label="Budget on record" value={p.budget_pkr ? pkr(p.budget_pkr) : '—'} sub="Set by the engineer; changing it will need your approval and an investor's." />
        <Kpi label="Planned finish" value={dateText(p.planned_end_date)} sub={`Started ${dateText(p.start_date)}`} />
      </div>
      {data.evidence?.uncovered_tasks?.length > 0 && <p className="err small">No camera covers: {data.evidence.uncovered_tasks.join(', ')}. Their progress cannot be measured; install cameras for them.</p>}
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Open system and project warnings</h2>
        <Alerts alerts={data.alerts} />
        <p className="tiny">Read-only here. The engineer acknowledges warnings.</p>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="link" onClick={() => go('cameras')}>Cameras →</button>
        <button className="link" onClick={() => go('prices')}>Price book →</button>
        <button className="link" onClick={() => go('access')}>Who can see this project →</button>
        <button className="link" onClick={() => go('audit')}>Audit log →</button>
      </div>
    </>
  );
}
