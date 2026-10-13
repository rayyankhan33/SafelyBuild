// Read-only. Risk and hazards are produced automatically from camera evidence. There are no controls
// to add, edit or close a hazard: a hazard closes only after the cameras show the area clean on
// several consecutive inspection days.
import { Fragment, useState } from 'react';
import { dateText } from '../../api.js';
import { AuthImage, Badge } from '../../components.jsx';

const L = ['Rare', 'Unlikely', 'Possible', 'Likely', 'Almost certain'];
const S = ['Negligible', 'Minor', 'Moderate', 'Major', 'Catastrophic'];
const ZONE = { intolerable: ['critical', 'Intolerable'], alarp: ['warning', 'Reduce to ALARP'], acceptable: ['good', 'Acceptable'] };
const cellColor = (r) => (r >= 15 ? 'var(--critical)' : r >= 10 ? 'var(--serious)' : r >= 5 ? 'var(--warning)' : 'var(--good)');

export default function Risk({ data }) {
  const [open, setOpen] = useState(null);
  const [shot, setShot] = useState(null);
  if (!data.setup_complete) return <div className="note">Risk scoring starts once the schedule exists and cameras are reporting.</div>;
  const { sdi, safety, matrix, hazards, defects, history, clean_days_to_close: closeDays } = data.risk;
  const defectsByMedia = defects.reduce((m, d) => ((m[d.media_id] ??= []).push(d), m), {});
  const openOnes = hazards.filter((h) => h.status !== 'closed');
  const closed = hazards.filter((h) => h.status === 'closed');

  return (
    <>
      <div className="note" style={{ marginBottom: 16 }}>
        Fully automatic. Hazards are raised by the cameras and <b>cannot be added, edited or closed by anyone</b>. A hazard closes by itself only after the same camera shows the area free of the defect on {closeDays} consecutive
        inspection days. Days with no frames change nothing: no evidence is never treated as safe.
        {safety.evidence_gap && <b className="err"> Some cameras have not reported recently, so this status may be out of date.</b>}
      </div>
      <div className="grid cols-2">
        <div className="card">
          <h2>Structural Danger Index</h2>
          {sdi ? (
            <>
              <div className="row"><span style={{ fontSize: 34, fontWeight: 650 }}>{sdi.sdi}<span className="muted" style={{ fontSize: 16 }}> / 10</span></span><Badge status={sdi.status} />{sdi.escalate && <span className="err"><b>Escalation threshold exceeded</b></span>}</div>
              {[['Severity', sdi.severity_part, sdi.weights.severity], ['Density', sdi.density_part, sdi.weights.density], ['Progression', sdi.progression_part, sdi.weights.progression]].map(([n, v, w]) => (
                <div key={n} style={{ margin: '8px 0' }}><div className="row small" style={{ justifyContent: 'space-between' }}><span>{n} <span className="muted">(weight {w})</span></span><span>{Math.round(v * 100)}%</span></div><div className="bar"><div style={{ width: `${v * 100}%` }} /></div></div>
              ))}
              <p className="small muted">{sdi.explanation}</p>
              <p className="tiny">Severity = worst defect score ÷ 0.6 (the “critical” level); density = share of frames with a violation-level defect; progression = worsening versus the previous 7 days plus persistence. Weights shift as inspection history grows. Bands: ≥2.5 moderate, ≥5 high, ≥7.5 critical.</p>
            </>
          ) : <div className="note">No analysed inspection frames in the last 7 days, so no index is computed.</div>}
          {history.length > 1 && <p className="small">History: {history.slice(-8).map((h) => `${dateText(h.date)} ${h.sdi}`).join(' · ')}</p>}
        </div>
        <div className="card">
          <h2>Risk matrix</h2>
          <p className="small muted">Open hazards by likelihood × severity (ISO 31000 / IEC 31010). Overall safety: <Badge status={safety.status} /> · {safety.open_hazards} open · worst rating {safety.worst_rating}/25</p>
          <div className="matrix" role="table" aria-label="Risk matrix">
            <div />{L.map((l, i) => <div key={l} className="tiny" style={{ textAlign: 'center' }}>{i + 1}</div>)}
            {[4, 3, 2, 1, 0].map((si) => <MatrixRow key={si} si={si} counts={matrix[si]} />)}
          </div>
          <p className="tiny">Rows: severity (5 {S[4]} … 1 {S[0]}). Columns: likelihood (1 {L[0]} … 5 {L[4]}). Colour bands follow the ALARP zones: ≥15 intolerable, 5–14 tolerable only if ALARP, ≤4 acceptable (HSE R2P2).</p>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Hazards detected</h2>
        <HazardTable rows={openOnes} open={open} setOpen={setOpen} empty="No open hazards." />
        {closed.length > 0 && (
          <>
            <h3 style={{ marginTop: 20 }}>Closed automatically</h3>
            <HazardTable rows={closed} open={open} setOpen={setOpen} empty="" />
          </>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Detected defects</h2>
        <p className="small muted">Source: OpenCV colour/texture heuristics (ACI 201.1R terminology) unless a trained model is activated; see the Evidence tab for the model used. Severity bands: score &lt;0.15 low, &lt;0.35 medium, &lt;0.60 high, else critical. Not a certified structural judgement.</p>
        <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>Type</th><th className="num">Score</th><th>Severity</th><th>Violation</th><th /></tr></thead>
          <tbody>{defects.slice().reverse().slice(0, 25).map((d) => (
            <tr key={d.id}><td>{dateText(d.detected_on)}</td><td>{d.type.replace('_', ' ')}</td><td className="num">{Number(d.score).toFixed(2)}</td><td>{d.severity}</td><td>{d.is_violation ? 'Yes' : 'No'}</td>
              <td><button className="link" onClick={() => setShot(d.media_id)}>View frame</button></td></tr>
          ))}{!defects.length && <tr><td colSpan={6} className="muted">No defects detected.</td></tr>}</tbody>
        </table></div>
        {shot && <Overlay mediaId={shot} defects={defectsByMedia[shot] ?? []} onClose={() => setShot(null)} />}
      </div>
    </>
  );
}

function HazardTable({ rows, open, setOpen, empty }) {
  if (!rows.length) return empty ? <p className="muted">{empty}</p> : null;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Hazard</th><th>Category</th><th className="num">L</th><th className="num">S</th><th className="num">Rating</th><th>ALARP zone</th><th>Status</th><th>Standard</th><th /></tr></thead>
        <tbody>
          {rows.map((h) => (
            <Fragment key={h.id}>
              <tr>
                <td><b>{h.title}</b><div className="tiny">seen by {h.camera ?? 'camera'} · since {dateText(h.identified_on)}</div></td>
                <td>{h.category}</td><td className="num">{h.likelihood}</td><td className="num">{h.severity}</td><td className="num"><b>{h.rating}</b></td>
                <td><span className={`badge s-${ZONE[h.zone][0]}`}><i>{h.zone === 'intolerable' ? '✕' : h.zone === 'alarp' ? '!' : '✓'}</i>{ZONE[h.zone][1]}</span></td>
                <td>{h.status === 'closed' ? `closed ${dateText(h.closed_on)}` : `open (${h.clean_days} clean day${h.clean_days === 1 ? '' : 's'})`}</td>
                <td>{h.standard ?? '—'}</td>
                <td>{h.bow_tie && <button className="link" onClick={() => setOpen(open === h.id ? null : h.id)}>{open === h.id ? 'Hide' : 'Bow-tie'}</button>}</td>
              </tr>
              {open === h.id && h.bow_tie && (
                <tr><td colSpan={9}>
                  <p className="small">{h.zone_text} {h.notes}</p>
                  <div className="bowtie">
                    <Col title="Causes" items={h.bow_tie.causes} />
                    <Col title="Preventive barriers" items={h.bow_tie.preventive} />
                    <div className="card" style={{ textAlign: 'center' }}><b>Top event</b><div>{h.title}</div></div>
                    <Col title="Mitigating barriers" items={h.bow_tie.mitigating} />
                    <Col title="Consequences" items={h.bow_tie.consequences} />
                  </div>
                </td></tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MatrixRow({ si, counts }) {
  return (
    <>
      <div className="tiny" style={{ textAlign: 'right', paddingRight: 4 }}>{si + 1}</div>
      {counts.map((n, li) => {
        const rating = (si + 1) * (li + 1);
        return <div key={li} className="cell" style={{ background: cellColor(rating), opacity: n ? 1 : 0.35 }} title={`likelihood ${li + 1} × severity ${si + 1} = ${rating}`}>{n || ''}</div>;
      })}
    </>
  );
}
const Col = ({ title, items }) => (<div className="card"><b>{title}</b><ul>{items.map((x) => <li key={x}>{x}</li>)}</ul></div>);

function Overlay({ mediaId, defects, onClose }) {
  const size = defects[0]?.image_size ?? [640, 480];
  return (
    <div style={{ marginTop: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}><b>Annotated frame</b><button className="link" onClick={onClose}>Close</button></div>
      <div className="overlay">
        <AuthImage mediaId={mediaId} alt="Annotated camera frame">
          <svg viewBox={`0 0 ${size[0]} ${size[1]}`} preserveAspectRatio="none" aria-hidden>
            {defects.map((d) => { const [x1, y1, x2, y2] = d.bbox; const c = d.is_violation ? 'var(--critical)' : 'var(--warning)'; return (
              <g key={d.id}><rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill="none" stroke={c} strokeWidth={3} /><text x={x1 + 4} y={y1 + 16} fill="#fff" stroke="#000" strokeWidth={0.5} fontSize={14}>{d.type.replace('_', ' ')} {d.severity}</text></g>); })}
          </svg>
        </AuthImage>
      </div>
    </div>
  );
}
