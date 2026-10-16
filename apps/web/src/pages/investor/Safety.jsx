// Investor safety page: open issues in plain words. Issues are raised and closed automatically from camera
// evidence; there is nothing to edit here.
import { Badge, Kpi } from '../../components.jsx';
import { dateText } from '../../api.js';
import { Footnote, NotReady } from './Shared.jsx';

const LEVEL = { serious: ['critical', '✕', 'Serious'], attention: ['warning', '!', 'Needs attention'], minor: ['neutral', '–', 'Minor'] };

export default function Safety({ data }) {
  if (!data.setup_complete) return <NotReady data={data} />;
  const sf = data.headline.safety; const items = data.safety_items;
  return (
    <>
      <div className="grid cols-3">
        <Kpi label="Overall" value={<Badge status={sf.status} />} sub={sf.text} />
        <Kpi label="Open issues" value={items.open.length} sub={items.open.length ? 'Raised automatically from site cameras.' : 'None found by the cameras.'} />
        <Kpi label="Cleared issues" value={items.closed_count} sub={`An issue clears only after the camera sees the area clean on ${items.clean_days_to_close} inspection days in a row.`} />
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Open issues</h2>
        {items.open.map((h) => {
          const [tone, icon, label] = LEVEL[h.level];
          return (
            <div key={h.id} className="alert" style={{ marginBottom: 8 }}>
              <b aria-hidden>{icon}</b>
              <div>
                <div><span className={`badge s-${tone}`}><i>{icon}</i>{label}</span> <b>{h.title}</b></div>
                <div className="small muted">{h.plain} First seen {dateText(h.raised_on)}.</div>
              </div>
            </div>
          );
        })}
        {!items.open.length && <div className="note">No open issues.</div>}
      </div>
      <p className="tiny">Nobody on site can add, edit or close these issues. A day with no camera pictures never counts as safe.</p>
      <Footnote data={data} />
    </>
  );
}
