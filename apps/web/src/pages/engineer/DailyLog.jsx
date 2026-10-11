import { useCallback, useEffect, useState } from 'react';
import { api, isoToday, pkrFull } from '../../api.js';

const MATERIALS = ['CEMENT', 'SAND', 'AGGREGATE', 'REBAR', 'BRICK'];
const UNIT = { CEMENT: 'bags', SAND: 'm³', AGGREGATE: 'm³', REBAR: 'kg', BRICK: 'nos' };

export default function DailyLog({ pid, reload }) {
  const [date, setDate] = useState(isoToday());
  const [tasks, setTasks] = useState([]);
  const [form, setForm] = useState({ workers_present: '', weather: '', notes: '' });
  const [progress, setProgress] = useState({});
  const [materials, setMaterials] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [uploads, setUploads] = useState([]);
  const [tag, setTag] = useState('general');
  const [busy, setBusy] = useState(false);
  const [rates, setRates] = useState({});

  const load = useCallback(async () => {
    const [t, r] = await Promise.all([api('GET', `/projects/${pid}/schedule`), api('GET', `/projects/${pid}/rates`)]);
    setTasks(t.tasks); setRates(r.rates);
    let log = null;
    try { log = (await api('GET', `/projects/${pid}/logs/${date}`)).log; } catch (e) { if (e.status !== 404) throw e; }
    const p = {};
    for (const task of t.tasks) p[task.id] = log?.progress.find((x) => x.task_id === task.id)?.percent_complete ?? Math.round(task.percent_complete * 10) / 10;
    setProgress(p);
    setForm({ workers_present: log?.workers_present ?? '', weather: log?.weather ?? '', notes: log?.notes ?? '' });
    setMaterials((log?.materials ?? []).map((m) => ({ material_code: m.material_code, quantity: m.quantity, source: m.source, media_id: m.media_id, confidence: m.confidence })));
    setUploads([]);
  }, [pid, date]);
  useEffect(() => { load().catch((e) => setMsg({ type: 'err', text: e.message })); }, [load]);

  const spend = materials.reduce((s, m) => s + (Number(m.quantity) || 0) * (rates[m.material_code] ?? 0), 0);

  async function save() {
    setBusy(true); setMsg({ type: '', text: '' });
    try {
      const body = {
        workers_present: form.workers_present === '' ? undefined : Number(form.workers_present),
        weather: form.weather || undefined, notes: form.notes || undefined,
        progress: Object.entries(progress).map(([task_id, percent]) => ({ task_id, percent: Number(percent) })),
        materials: materials.filter((m) => m.quantity !== '' && Number(m.quantity) >= 0).map((m) => ({
          material_code: m.material_code, quantity: Number(m.quantity), source: m.source ?? 'manual',
          ...(m.media_id ? { media_id: m.media_id } : {}), ...(m.confidence ? { confidence: m.confidence } : {}) })),
      };
      const r = await api('PUT', `/projects/${pid}/logs/${date}`, body);
      setMsg({ type: 'ok', text: `Saved. Spend recorded for ${date}: ${pkrFull(spend)}.` + (r.status ? ` Budget: ${r.status.budget}, schedule: ${r.status.schedule}.` : '') });
      reload();
    } catch (e) {
      setMsg({ type: 'err', text: e.details?.length ? `${e.message}: ${e.details.map((d) => d.message ?? d).join('; ')}` : e.message });
    } finally { setBusy(false); }
  }

  async function upload(ev) {
    const files = [...ev.target.files];
    if (!files.length) return;
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    fd.append('tag', tag);
    setBusy(true); setMsg({ type: '', text: '' });
    try {
      const r = await api('POST', `/projects/${pid}/logs/${date}/media`, fd);
      setUploads((u) => [...r.uploads, ...u]);
      reload();
    } catch (e) { setMsg({ type: 'err', text: e.message }); } finally { setBusy(false); ev.target.value = ''; }
  }

  function useProposal(p, media_id, simulated) {
    setMaterials((m) => [...m, { material_code: p.material_code, quantity: p.quantity, source: simulated ? 'ai_simulated' : 'ai_confirmed', media_id, confidence: p.confidence }]);
  }

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Daily site log</h2>
          <label className="field">Date<input type="date" max={isoToday()} value={date} onChange={(e) => setDate(e.target.value)} /></label>
        </div>
        {!tasks.length && <div className="note" style={{ marginTop: 12 }}>Generate the schedule first so progress can be recorded per task.</div>}
        <div className="row" style={{ marginTop: 12 }}>
          <label className="field">Workers on site<input type="number" min={0} value={form.workers_present} onChange={(e) => setForm({ ...form, workers_present: e.target.value })} /></label>
          <label className="field">Weather<input value={form.weather} onChange={(e) => setForm({ ...form, weather: e.target.value })} /></label>
          <label className="field" style={{ flex: 1, minWidth: 220 }}>Notes<input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="card">
          <h3>Progress (cumulative % complete per task)</h3>
          {tasks.map((t) => (
            <div key={t.id} className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <span className="small">{t.seq}. {t.name}</span>
              <input type="number" min={0} max={100} step="0.1" aria-label={`${t.name} percent complete`} value={progress[t.id] ?? 0} onChange={(e) => setProgress({ ...progress, [t.id]: e.target.value })} />
            </div>
          ))}
        </div>
        <div className="card">
          <h3>Materials used today</h3>
          {materials.map((m, i) => (
            <div key={i} className="row" style={{ marginBottom: 6 }}>
              <select value={m.material_code} onChange={(e) => setMaterials(materials.map((x, j) => (j === i ? { ...x, material_code: e.target.value } : x)))}>{MATERIALS.map((c) => <option key={c}>{c}</option>)}</select>
              <input type="number" min={0} step="any" aria-label="quantity" value={m.quantity} onChange={(e) => setMaterials(materials.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
              <span className="small muted">{UNIT[m.material_code]}</span>
              {m.source && m.source !== 'manual' && <span className="tiny">{m.source === 'ai_simulated' ? 'simulated AI value' : 'from photo'}</span>}
              <button className="link" onClick={() => setMaterials(materials.filter((_, j) => j !== i))}>remove</button>
            </div>
          ))}
          <button onClick={() => setMaterials([...materials, { material_code: 'CEMENT', quantity: '', source: 'manual' }])}>+ Add material</button>
          <p className="small" style={{ marginBottom: 0 }}>Spend for the day at project rates: <b>{pkrFull(spend)}</b></p>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>Site photos</h3>
        <p className="small muted">Photos are analysed for rusted rebar and honeycombed concrete. Use <b>overview</b> for a fixed view of the site (compared with the previous overview to measure activity) and <b>materials</b> for stockpiles.</p>
        <div className="row">
          <label className="field">Photo type<select value={tag} onChange={(e) => setTag(e.target.value)}><option value="general">General inspection</option><option value="overview">Site overview</option><option value="material">Materials</option></select></label>
          <label className="field">Choose photos<input type="file" accept="image/jpeg,image/png,image/webp,image/bmp" multiple onChange={upload} disabled={busy} /></label>
        </div>
        {uploads.map((u) => <UploadResult key={u.media.id} u={u} onUse={useProposal} />)}
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <button className="primary" onClick={save} disabled={busy || !tasks.length}>Save log</button>
        {msg.text && <span className={msg.type === 'err' ? 'err' : 'ok'} role="status">{msg.text}</span>}
      </div>
    </>
  );
}

function UploadResult({ u, onUse }) {
  const d = u.analysis.defects; const a = u.analysis.activity; const m = u.analysis.materials;
  return (
    <div className="note" style={{ marginTop: 10 }}>
      <b>Photo ({u.media.tag})</b>{' '}
      {d.status === 'failed' ? <span className="err">analysis failed: {d.error}. The photo is saved; analysis can be re-run later.</span>
        : d.findings.length === 0 ? <span>no defects found.</span>
        : <span>{d.findings.length} finding(s) via {d.backend}: {d.findings.slice(0, 4).map((f) => `${f.defect_type.replace('_', ' ')} (${f.severity}, ${Number(f.score).toFixed(2)})`).join('; ')}{d.hazards_updated?.length ? ' — hazards updated.' : ''}</span>}
      {a && <div>Activity vs previous overview: {a.status === 'succeeded' ? `${Math.round(a.change_ratio * 100)}% of the scene changed${a.alignment_ok ? '' : ' (viewpoint differs, treat with caution)'}` : a.status === 'skipped' ? a.reason : `failed: ${a.error}`}</div>}
      {m && (m.status === 'failed' ? <div className="err">Material analysis failed: {m.error}</div> : (
        <div>
          {m.proposals.length === 0 ? <span>{m.note}</span> : <span>{m.simulated ? 'SIMULATED proposals (no counting model yet): ' : 'Proposed: '}</span>}
          {m.proposals.map((p, i) => <button key={i} className="link" style={{ marginLeft: 8 }} onClick={() => onUse(p, u.media.id, m.simulated)}>use {p.quantity} {p.unit} {p.material_code.toLowerCase()}</button>)}
        </div>
      ))}
    </div>
  );
}
