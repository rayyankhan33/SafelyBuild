// Pieces shared by the investor pages.
import { dateText } from '../../api.js';

export function Header({ data }) {
  const p = data.project;
  return (
    <div style={{ marginBottom: 16 }}>
      {p.is_demo && <div className="note" style={{ marginBottom: 8 }}><b>Demo project.</b> The camera frames behind these figures are synthetic drawings made for demonstration.</div>}
      <h1>{p.name}</h1>
      <div className="muted small">{p.location} · started {dateText(p.start_date)} · updated {dateText(data.as_of)}</div>
    </div>
  );
}

export const NotReady = ({ data }) => <div className="note">{data.setup_hint}</div>;

export function Footnote({ data }) {
  return (
    <p className="tiny">{data.evidence?.note} {data.evidence?.gap ? 'Some cameras have not reported recently, so the most recent figures may lag. ' : ''}
      {data.cost?.scope === 'total'
        ? 'Costs cover materials (measured from site cameras), labour, equipment and overheads (from the daily crew and equipment log at rates fixed at the start of the project). '
        : 'Costs cover materials only (cement, sand, aggregate, steel, bricks); labour and equipment are not included yet. '}
      Quantities are estimated from images and carry measurement error.</p>
  );
}
