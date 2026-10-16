// Administrator: install, enable and disable the fixed cameras. Frames arrive only from these cameras, each
// with its own secret key, which is shown once.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';

const STATUS = { ok: ['good', '✓', 'Reporting'], stale: ['critical', '✕', 'Overdue'], never: ['critical', '✕', 'Never reported'], idle: ['neutral', '–', 'Not needed now'], disabled: ['neutral', '–', 'Disabled'] };
const KIND = { zone: 'Zone (one element)', yard: 'Material yard', overview: 'Inspection / overview' };

export default function Cameras({ data, pid, reload }) {
  const [cams, setCams] = useState([]);
  const [elements, setElements] = useState([]);
  const [form, setForm] = useState({ name: '', kind: 'overview', element_id: '', scale_m_per_px: '0.1' });
  const [newKey, setNewKey] = useState(null);
  const [error, setError] = useState('');

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
  const health = Object.fromEntries((data.evidence?.cameras ?? []).map((h) => [h.id, h]));

  return (
    <>
      <div className="note" style={{ marginBottom: 16 }}>Only administrators install cameras. A frame is accepted only from a registered camera with its secret key, the camera clock is checked, and each frame can be submitted once.</div>
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
                  <td><button className="link" onClick={() => toggle(c)}>{c.active ? 'Disable' : 'Enable'}</button></td>
                </tr>
              );
            })}
            {!cams.length && <tr><td colSpan={7} className="muted">No cameras installed yet.</td></tr>}
          </tbody>
        </table>
      </div>

      <form className="card" style={{ marginTop: 16 }} onSubmit={create}>
        <h2>Install a camera</h2>
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
    </>
  );
}
