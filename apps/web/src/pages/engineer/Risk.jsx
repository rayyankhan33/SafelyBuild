import { Fragment, useEffect, useState } from 'react';
import { api, dateText } from '../../api.js';
import { AuthImage, Badge } from '../../components.jsx';

const L = ['Rare', 'Unlikely', 'Possible', 'Likely', 'Almost certain'];
const S = ['Negligible', 'Minor', 'Moderate', 'Major', 'Catastrophic'];
const ZONE = { intolerable: ['critical', 'Intolerable'], alarp: ['warning', 'Reduce to ALARP'], acceptable: ['good', 'Acceptable'] };
const cellColor = (r) => (r >= 15 ? 'var(--critical)' : r >= 10 ? 'var(--serious)' : r >= 5 ? 'var(--warning)' : 'var(--good)');

export default function Risk({ pid, data, reload }) {
  const [lib, setLib] = useState([]);
  const [open, setOpen] = useState(null);
  const [form, setForm] = useState({ library_id: '', likelihood: 3, severity: 3, notes: '' });
  const [msg, setMsg] = useState('');
  const [shot, setShot] = useState(null);
  useEffect(() => { api('GET', '/hazard-library').then((r) => setLib(r.library)); }, []);

  if (!data.setup_complete) return <div className="note">Risk scoring starts once the schedule exists and photos are analysed.</div>;
  const { sdi, safety, matrix, hazards, defects, history } = data.risk;

  async function addHazard(e) {
    e.preventDefault(); setMsg('');
    try { await api('POST', `/projects/${pid}/hazards`, { library_id: Number(form.library_id), likelihood: Number(form.likelihood), severity: Number(form.severity), notes: form.notes || undefined }); reload(); } catch (er) { setMsg(er.message); }
  }
  async function patch(id, body) { await api('PATCH', `/projects/${pid}/hazards/${id}`, body); reload(); }
  const defectsByMedia = defects.reduce((m, d) => ((m[d.media_id] ??= []).push(d), m), {});

  return (
    <>
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
              <p className="tiny">Severity = worst defect score ÷ 0.6 (the “critical” level); density = share of photos with a violation-level defect; progression = worsening versus the previous 7 days plus persistence. Weights shift as inspection history grows. Bands: ≥2.5 moderate, ≥5 high, ≥7.5 critical.</p>
            </>
          ) : <div className="note">No inspection photos in the last 7 days, so no index is computed. Upload site photos in the Daily log tab.</div>}
          {history.length > 1 && <p className="small">History: {history.slice(-8).map((h) => `${dateText(h.date)} ${h.sdi}`).join(' · ')}</p>}
        </div>
        <div className="card">
          <h2>Risk matrix</h2>
          <p className="small muted">Count of open hazards by likelihood × severity (ISO 31000 / IEC 31010). Overall safety: <Badge status={safety.status} /> · {safety.open_hazards} open · worst rating {safety.worst_rating}/25</p>
          <div className="matrix" role="table" aria-label="Risk matrix">
            <div />{L.map((l, i) => <div key={l} className="tiny" style={{ textAlign: 'center' }}>{i + 1}</div>)}
            {[4, 3, 2, 1, 0].map((si) => (
              <MatrixRow key={si} si={si} counts={matrix[si]} />
            ))}
          </div>
          <p className="tiny">Rows: severity (5 {S[4]} … 1 {S[0]}). Columns: likelihood (1 {L[0]} … 5 {L[4]}). Colour bands follow the ALARP zones: ≥15 intolerable, 5–14 tolerable only if ALARP, ≤4 acceptable (HSE R2P2).</p>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Hazards</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Hazard</th><th>Category</th><th className="num">L</th><th className="num">S</th><th className="num">Rating</th><th>ALARP zone</th><th>Status</th><th>Standard</th><th /></tr></thead>
            <tbody>
              {hazards.map((h) => (
                <Fragment key={h.id}>
                  <tr>
                    <td><b>{h.title}</b><div className="tiny">{h.source === 'auto_defect' ? 'detected from photos' : 'entered by engineer'} · {dateText(h.identified_on)}</div></td>
                    <td>{h.category}</td><td className="num">{h.likelihood}</td><td className="num">{h.severity}</td><td className="num"><b>{h.rating}</b></td>
                    <td><span className={`badge s-${ZONE[h.zone][0]}`}><i>{h.zone === 'intolerable' ? '✕' : h.zone === 'alarp' ? '!' : '✓'}</i>{ZONE[h.zone][1]}</span></td>
                    <td><select value={h.status} onChange={(e) => patch(h.id, { status: e.target.value })}><option value="open">open</option><option value="mitigating">mitigating</option><option value="closed">closed</option></select></td>
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
              {!hazards.length && <tr><td colSpan={9} className="muted">No hazards recorded.</td></tr>}
            </tbody>
          </table>
        </div>
        <form className="row" style={{ marginTop: 12 }} onSubmit={addHazard}>
          <label className="field">Add hazard from library
            <select required value={form.library_id} onChange={(e) => setForm({ ...form, library_id: e.target.value })}>
              <option value="">Choose…</option>{lib.map((l) => <option key={l.id} value={l.id}>{l.category} — {l.title}</option>)}
            </select></label>
          <label className="field">Likelihood<select value={form.likelihood} onChange={(e) => setForm({ ...form, likelihood: e.target.value })}>{L.map((l, i) => <option key={l} value={i + 1}>{i + 1} {l}</option>)}</select></label>
          <label className="field">Severity<select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>{S.map((l, i) => <option key={l} value={i + 1}>{i + 1} {l}</option>)}</select></label>
          <button className="primary" style={{ alignSelf: 'end' }}>Add</button>
          {msg && <span className="err">{msg}</span>}
        </form>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Detected defects</h2>
        <p className="small muted">Source: OpenCV colour/texture heuristics from the POC (ACI 201.1R terminology). Severity bands: score &lt;0.15 low, &lt;0.35 medium, &lt;0.60 high, else critical. Not a certified structural judgement.</p>
        <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>Type</th><th className="num">Score</th><th>Severity</th><th>Violation</th><th /></tr></thead>
          <tbody>{defects.slice().reverse().slice(0, 25).map((d) => (
            <tr key={d.id}><td>{dateText(d.detected_on)}</td><td>{d.type.replace('_', ' ')}</td><td className="num">{Number(d.score).toFixed(2)}</td><td>{d.severity}</td><td>{d.is_violation ? 'Yes' : 'No'}</td>
              <td><button className="link" onClick={() => setShot(d.media_id)}>View photo</button></td></tr>
          ))}{!defects.length && <tr><td colSpan={6} className="muted">No defects detected yet.</td></tr>}</tbody>
        </table></div>
        {shot && <Overlay mediaId={shot} defects={defectsByMedia[shot] ?? []} onClose={() => setShot(null)} />}
      </div>
    </>
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
      <div className="row" style={{ justifyContent: 'space-between' }}><b>Annotated photo</b><button className="link" onClick={onClose}>Close</button></div>
      <div className="overlay">
        <AuthImage mediaId={mediaId} alt="Annotated site photo">
          <svg viewBox={`0 0 ${size[0]} ${size[1]}`} preserveAspectRatio="none" aria-hidden>
            {defects.map((d) => { const [x1, y1, x2, y2] = d.bbox; const c = d.is_violation ? 'var(--critical)' : 'var(--warning)'; return (
              <g key={d.id}><rect x={x1} y={y1} width={x2 - x1} height={y2 - y1} fill="none" stroke={c} strokeWidth={3} /><text x={x1 + 4} y={y1 + 16} fill="#fff" stroke="#000" strokeWidth={0.5} fontSize={14}>{d.type.replace('_', ' ')} {d.severity}</text></g>); })}
          </svg>
        </AuthImage>
      </div>
    </div>
  );
}
