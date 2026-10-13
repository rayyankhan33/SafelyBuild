// Where the numbers come from: camera health, the latest frames and what was measured in them, which
// model measured them, and (admin only) camera installation.
import { useCallback, useEffect, useState } from 'react';
import { api, dateText, session } from '../../api.js';
import { AuthImage } from '../../components.jsx';

const STATUS = { ok: ['good', '✓', 'Reporting'], stale: ['critical', '✕', 'Overdue'], never: ['critical', '✕', 'Never reported'], idle: ['neutral', '–', 'Not needed now'], disabled: ['neutral', '–', 'Disabled'] };
const KIND = { zone: 'Zone (one element)', yard: 'Material yard', overview: 'Inspection / overview' };

export default function Evidence({ data, pid, reload }) {
  const isAdmin = session.get().user.role === 'admin';
  const ev = data.evidence;
  const [cams, setCams] = useState([]);
  const [elements, setElements] = useState([]);
  const [form, setForm] = useState({ name: '', kind: 'overview', element_id: '', scale_m_per_px: '0.1' });
  const [newKey, setNewKey] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    const [c, e] = await Promise.all([api('GET', `/projects/${pid}/cameras`), api('GET', `/projects/${pid}/elements`)]);
    setCams(c.cameras); setElements(e.elements);
  }, [pid]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  async function create(e) {
    e.preventDefault(); setError(''); setNewKey(null);
    try {
      const body = { name: form.name, kind: form.kind };
      if (form.kind === 'zone') body.element_id = form.element_id;
      if (form.kind === 'yard') body.scale_m_per_px = Number(form.scale_m_per_px);
      const r = await api('POST', `/projects/${pid}/cameras`, body);
      setNewKey({ name: r.camera.name, key: r.key }); setForm({ ...form, name: '' }); load(); reload();
    } catch (err) { setError(err.details?.length ? `${err.message}: ${err.details.map((d) => d.message).join('; ')}` : err.message); }
  }
  async function toggle(c) { await api('PATCH', `/projects/${pid}/cameras/${c.id}`, { active: !c.active }); load(); reload(); }
  const health = Object.fromEntries((ev?.cameras ?? []).map((h) => [h.id, h]));

  return (
    <>
      <div className="note" style={{ marginBottom: 16 }}>
        {ev?.note} Frames arrive only from registered cameras with their own secret key; the camera clock is checked and a frame can be submitted once. Engineers cannot upload, edit or delete evidence.
        {data.project.is_demo && <b> This is a demo project: the camera frames are synthetic drawings, not real site photos.</b>}
      </div>

      <div className="card table-wrap">
        <h2>Cameras</h2>
        <table>
          <thead><tr><th>Camera</th><th>Type</th><th>Watches</th><th>Status</th><th>Last frame</th><th className="num">Frames</th><th /></tr></thead>
          <tbody>
            {cams.map((c) => {
              const h = health[c.id]; const [tone, icon, label] = STATUS[h?.status ?? (c.active ? 'ok' : 'disabled')];
              return (
                <tr key={c.id}>
                  <td>{c.name}</td><td>{KIND[c.kind]}</td><td>{c.element_label ?? (c.scale_m_per_px ? `scale ${c.scale_m_per_px} m/px` : '—')}</td>
                  <td><span className={`badge s-${tone}`}><i>{icon}</i>{label}</span></td>
                  <td>{c.last_frame_at ? new Date(c.last_frame_at).toLocaleString('en-GB') : '—'}</td><td className="num">{c.frames}</td>
                  <td>{isAdmin && <button className="link" onClick={() => toggle(c)}>{c.active ? 'Disable' : 'Enable'}</button>}</td>
                </tr>
              );
            })}
            {!cams.length && <tr><td colSpan={7} className="muted">No cameras installed yet. Nothing can be measured until an administrator installs them.</td></tr>}
          </tbody>
        </table>
        {ev?.uncovered_tasks?.length > 0 && <p className="err small">No camera covers: {ev.uncovered_tasks.join(', ')}. Their progress cannot be measured.</p>}
      </div>

      {isAdmin && (
        <form className="card" style={{ marginTop: 16 }} onSubmit={create}>
          <h2>Install a camera (administrator)</h2>
          <div className="row">
            <label className="field">Name<input required minLength={2} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="field">Type<select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            {form.kind === 'zone' && <label className="field">Element it watches<select required value={form.element_id} onChange={(e) => setForm({ ...form, element_id: e.target.value })}><option value="">Choose…</option>{elements.map((el) => <option key={el.id} value={el.id}>{el.label}</option>)}</select></label>}
            {form.kind === 'yard' && <label className="field">Ground scale (m per pixel)<input type="number" step="any" min={0.001} required value={form.scale_m_per_px} onChange={(e) => setForm({ ...form, scale_m_per_px: e.target.value })} /></label>}
            <button className="primary" style={{ alignSelf: 'end' }}>Create camera</button>
          </div>
          {error && <div className="err" role="alert">{error}</div>}
          {newKey && <div className="alert warning" style={{ marginTop: 12 }}><b>!</b><div>Key for <b>{newKey.name}</b> — shown once, store it in the camera now:<br /><code style={{ wordBreak: 'break-all' }}>{newKey.key}</code></div></div>}
        </form>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Latest frames and what was measured</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Time</th><th>Camera</th><th>Measured</th><th /></tr></thead>
            <tbody>
              {(ev?.frames ?? []).map((f) => (
                <tr key={f.id}>
                  <td>{new Date(f.captured_at).toLocaleString('en-GB')}</td><td>{f.camera}</td>
                  <td>{f.stage ? (f.stage.fraction != null && f.kind === 'zone' ? `stage ${f.stage.stage}, ${Math.round(f.stage.fraction * 100)}% covered` : `stage ${f.stage.stage}`) : f.kind === 'yard' ? 'material stock' : 'defect check'}
                    {f.violations > 0 && <span className="err"> · {f.violations} defect finding(s)</span>}</td>
                  <td><button className="link" onClick={() => setOpen(open === f.id ? null : f.id)}>{open === f.id ? 'Hide' : 'View'}</button></td>
                </tr>
              ))}
              {!(ev?.frames ?? []).length && <tr><td colSpan={4} className="muted">No frames received yet.</td></tr>}
            </tbody>
          </table>
        </div>
        {open && <div style={{ marginTop: 12, maxWidth: 560 }}><div className="photo" style={{ aspectRatio: '4/3' }}><AuthImage mediaId={open} alt="Camera frame" /></div></div>}
        <p className="tiny">Each analysis is stored with the model that produced it (name and version), so any figure can be traced and re-run when a better model is installed. Dates: {dateText(data.as_of)}.</p>
      </div>
    </>
  );
}
