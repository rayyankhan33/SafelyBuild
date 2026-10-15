// TEMPORARY (see docs/temporary-features.md): upload footage and see what the vision model detects.
// Results are a sandbox: they never become progress, spend, hazards or any other evidence.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fetchBlobUrl } from '../../api.js';

function FrameImage({ id, alt }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let url; let cancelled = false;
    fetchBlobUrl(`/test-frames/${id}/image`).then((u) => { url = u; if (!cancelled) setSrc(u); }).catch(() => {});
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [id]);
  return src ? <img src={src} alt={alt} style={{ width: '100%', display: 'block', borderRadius: 6 }} /> : <div className="tiny" style={{ padding: 8 }}>Loading…</div>;
}

const active = (r) => r && ['queued', 'running'].includes(r.status);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export default function TestFootage({ pid }) {
  const [defaults, setDefaults] = useState(null);
  const [runs, setRuns] = useState([]);
  const [selected, setSelected] = useState(null);
  const [run, setRun] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState(null);
  const [form, setForm] = useState({ interval_s: '3', conf: '0.10', max_frames: '400', prompts: '', model: 'yolo_world' });
  const fileRef = useRef(null);

  const loadRuns = useCallback(async () => {
    const r = await api('GET', `/projects/${pid}/test-runs`);
    setRuns(r.runs);
    return r.runs;
  }, [pid]);

  useEffect(() => {
    api('GET', '/test-footage/defaults')
      .then((d) => { setDefaults(d); setForm((f) => ({ ...f, interval_s: String(d.interval_s), conf: String(d.conf), max_frames: String(d.max_frames), prompts: d.prompts.join('\n') })); })
      .catch((e) => setError(e.message));
    loadRuns().then((rs) => { if (rs[0]) setSelected(rs[0].id); }).catch((e) => setError(e.message));
  }, [loadRuns]);

  // poll the selected run while it is being analysed
  useEffect(() => {
    if (!selected) { setRun(null); return undefined; }
    let stop = false; let timer;
    const tick = async () => {
      try {
        const r = (await api('GET', `/projects/${pid}/test-runs/${selected}`)).run;
        if (stop) return;
        setRun(r);
        if (active(r)) timer = setTimeout(tick, 1500); else loadRuns().catch(() => {});
      } catch (e) { if (!stop) { setError(e.message); setRun(null); } }
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [pid, selected, loadRuns]);

  async function start(e) {
    e.preventDefault(); setError('');
    if (!file) { setError('Choose a video or image first.'); return; }
    const body = new FormData();
    body.append('file', file);
    for (const k of ['interval_s', 'conf', 'max_frames', 'prompts', 'model']) body.append(k, form[k]);
    setBusy(true);
    try {
      const r = await api('POST', `/projects/${pid}/test-runs`, body);
      setFile(null); if (fileRef.current) fileRef.current.value = '';
      await loadRuns(); setSelected(r.run.id);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  async function remove(id) {
    setError('');
    try { await api('DELETE', `/projects/${pid}/test-runs/${id}`); if (selected === id) { setSelected(null); setRun(null); } loadRuns(); } catch (err) { setError(err.message); }
  }
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const running = runs.some(active);

  return (
    <div className="grid">
      <div className="note" style={{ borderLeft: '4px solid var(--warning, #b45309)' }}>
        <b>Temporary testing tool.</b> Footage uploaded here is analysed by the vision model so you can see what it finds. It is a sandbox:
        nothing found here becomes progress, spend, a hazard or a risk score, because the project's measurements come only from the fixed cameras.
        This tool will be removed.
      </div>

      <form className="card" onSubmit={start}>
        <h2>Analyse footage</h2>
        <div className="row" style={{ marginBottom: 12 }}>
          <input ref={fileRef} type="file" accept="video/*,image/jpeg,image/png,image/webp,image/bmp" onChange={(e) => setFile(e.target.files[0] ?? null)} />
        </div>
        <label style={{ display: 'block', marginBottom: 12 }}>Model
          <select value={form.model} onChange={set('model')}>
            {(defaults?.models ?? ['yolo_world']).map((m) => <option key={m} value={m}>{m === 'yolo_world' ? 'YOLO-World (site objects: columns, sand, bags…)' : `${m} (defects, e.g. cracks)`}</option>)}
          </select>
        </label>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <label style={{ flex: '1 1 140px' }}>Look at one frame every (seconds)
            <input type="number" min="1" max="10" step="0.5" value={form.interval_s} onChange={set('interval_s')} />
          </label>
          <label style={{ flex: '1 1 140px' }}>Minimum confidence
            <input type="number" min="0.01" max="0.9" step="0.01" value={form.conf} onChange={set('conf')} />
          </label>
          <label style={{ flex: '1 1 140px' }}>Most frames to analyse
            <input type="number" min="1" max="600" step="1" value={form.max_frames} onChange={set('max_frames')} />
          </label>
        </div>
        <p className="tiny" style={{ margin: '8px 0' }}>
          Why 3 seconds: site work changes over minutes, so a frame every few seconds sees everything that matters. In each window
          the sharpest of several candidate frames is chosen (motion blur is what ruins detection), and a frame that looks the same as the
          previous one is not analysed again. A detection counts as <b>confirmed</b> only when it appears in two consecutive analysed frames.
          {defaults ? '' : ' (Loading defaults…)'}
        </p>
        {form.model === 'yolo_world' && (
          <label>What to look for (one per line)
            <textarea rows={6} value={form.prompts} onChange={set('prompts')} style={{ width: '100%' }} />
          </label>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" disabled={busy || running || !file}>{busy ? 'Uploading…' : 'Start analysis'}</button>
          {running && <span className="tiny">A run is already in progress for this project.</span>}
        </div>
        {error && <p className="err" role="alert">{error}</p>}
      </form>

      <div className="card table-wrap">
        <h2>Runs</h2>
        <table>
          <thead><tr><th>File</th><th>Status</th><th>Frames</th><th>Started</th><th /></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} style={r.id === selected ? { background: 'var(--soft)' } : undefined}>
                <td><button className="link" onClick={() => setSelected(r.id)}>{r.filename}</button></td>
                <td>{r.status}{r.error ? ` – ${r.error}` : ''}</td>
                <td>{r.frames}</td>
                <td>{new Date(r.created_at).toLocaleString('en-GB')}</td>
                <td><button className="link" onClick={() => remove(r.id)}>Delete</button></td>
              </tr>
            ))}
            {!runs.length && <tr><td colSpan={5} className="muted">No runs yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {run && <Result run={run} />}
    </div>
  );
}

function Result({ run }) {
  const per = Object.entries(run.summary?.per_label ?? {});
  const p = run.progress ?? {};
  return (
    <>
      <div className="card">
        <h2>{run.filename}</h2>
        <p className="small muted">
          {run.status === 'running' || run.status === 'queued'
            ? `Analysing… ${p.sampled ?? 0} of about ${p.estimated_total ?? '?'} frames sampled (${p.analysed ?? 0} analysed, ${p.reused ?? 0} reused).`
            : `${run.status}. ${p.sampled ?? run.frames.length} frames sampled, ${p.analysed ?? 0} analysed by the model, ${p.reused ?? 0} reused because the scene had not changed.`}
          {run.video?.duration_s ? ` Footage length ${mmss(run.video.duration_s)}, one frame every ${run.params.effective_interval_s ?? run.params.interval_s} s.` : ''}
        </p>
        {run.error && <p className="err">{run.error}</p>}
        {(run.summary?.notes ?? []).map((n) => <p key={n} className="tiny">{n}</p>)}
        {per.length > 0 && (
          <table>
            <thead><tr><th>Object</th><th>Detections</th><th>Confirmed</th><th>Best confidence</th></tr></thead>
            <tbody>{per.map(([label, v]) => <tr key={label}><td>{label}</td><td>{v.detections}</td><td>{v.confirmed}</td><td>{Math.round(v.best_conf * 100)}%</td></tr>)}</tbody>
          </table>
        )}
        {!per.length && run.status === 'done' && <p className="muted">Nothing was detected. Try a lower confidence or different prompts.</p>}
        <p className="tiny" style={{ marginTop: 8 }}>Green boxes are confirmed detections; orange boxes appeared in a single frame only and are less trustworthy.</p>
      </div>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
        {run.frames.map((f) => (
          <div key={f.id} className="card" style={{ padding: 8 }}>
            <FrameImage id={f.id} alt={`Frame at ${mmss(f.t_s)}`} />
            <div className="tiny" style={{ marginTop: 4 }}>
              {mmss(f.t_s)} · {f.reused ? 'reused' : `${f.ms} ms`} · {f.detections.length} detection{f.detections.length === 1 ? '' : 's'}
              {f.detections.length > 0 && <> ({[...new Set(f.detections.map((d) => d.label))].join(', ')})</>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
