import { useCallback, useEffect, useState } from 'react';
import { api, pkr, pkrFull } from '../../api.js';
import CostRates from './CostRates.jsx';

const TYPES = [
  ['footing', 'Footing', ['length_m', 'width_m', 'height_m'], { height_m: 'depth (m)' }],
  ['column', 'Column', ['length_m', 'width_m', 'height_m'], { length_m: 'section length (m)', width_m: 'section width (m)', height_m: 'height (m)' }],
  ['beam', 'Beam', ['length_m', 'width_m', 'height_m'], { length_m: 'span (m)', height_m: 'depth (m)' }],
  ['slab', 'Slab', ['length_m', 'width_m', 'thickness_m'], {}],
  ['masonry_wall', 'Masonry wall', ['length_m', 'height_m', 'thickness_m'], {}],
];
const DIM_LABEL = { length_m: 'length (m)', width_m: 'width (m)', height_m: 'height (m)', thickness_m: 'thickness (m)' };
const MATERIALS = ['CEMENT', 'SAND', 'AGGREGATE', 'REBAR', 'BRICK'];

export default function Design({ pid, data, reload }) {
  const [elements, setElements] = useState([]);
  const [rates, setRates] = useState({});
  const [msg, setMsg] = useState({ type: '', text: '' });
  const [est, setEst] = useState(null);
  const [contingency, setContingency] = useState(5);
  const [f, setF] = useState({ label: '', element_type: 'slab', quantity: 1, concrete_fc_mpa: 25 });

  const load = useCallback(async () => {
    const [e, r] = await Promise.all([api('GET', `/projects/${pid}/elements`), api('GET', '/price-book')]);
    setElements(e.elements); setRates(r.rates);
  }, [pid]);
  useEffect(() => { load(); }, [load]);
  const flash = (type, text) => setMsg({ type, text });
  const fail = (e) => flash('err', e.details?.length ? `${e.message}: ${e.details.map((d) => d.message ?? d).join('; ')}` : e.message);

  const type = TYPES.find((t) => t[0] === f.element_type);
  const isConcrete = f.element_type !== 'masonry_wall';

  async function addElement(ev) {
    ev.preventDefault();
    const body = { label: f.label, element_type: f.element_type, quantity: Number(f.quantity) };
    for (const d of type[2]) body[d] = Number(f[d]);
    if (isConcrete) body.concrete_fc_mpa = Number(f.concrete_fc_mpa);
    if (f.rebar_kg_per_m3) body.rebar_kg_per_m3 = Number(f.rebar_kg_per_m3);
    try { await api('POST', `/projects/${pid}/elements`, body); setF({ ...f, label: '' }); flash('ok', 'Element added.'); load(); } catch (e) { fail(e); }
  }
  async function remove(id) {
    try { await api('DELETE', `/projects/${pid}/elements/${id}`); load(); } catch (e) { fail(e); }
  }
  async function runEstimate() {
    try { const r = await api('POST', `/projects/${pid}/estimates`, { contingency_pct: Number(contingency), activate: true }); setEst(r.estimate); flash('ok', `Estimate v${r.estimate.version} created and set as the project budget. Regenerate the schedule so task budgets match.`); reload(); } catch (e) { fail(e); }
  }

  const shown = est ? { total_pkr: est.total_pkr, by_material: est.byMaterial, mixes: est.mixes, warnings: est.warnings, excluded: est.excluded, contingency_pct: est.contingency_pct, compaction: est.compaction_factor_coarse }
    : data.estimate ? { total_pkr: data.estimate.total_pkr, by_material: data.estimate.by_material, mixes: data.estimate.mixes, warnings: data.estimate.warnings, excluded: data.estimate.excluded, contingency_pct: data.estimate.contingency_pct, compaction: data.estimate.compaction_factor_coarse } : null;

  return (
    <>
      {msg.text && <div className={msg.type === 'err' ? 'err' : 'ok'} role="status" style={{ marginBottom: 12 }}>{msg.text}</div>}
      <div className="card">
        <h2>Bill of quantities</h2>
        <p className="small muted">This is the engineer's input for the initial budget. Enter each structural element once with a quantity, listed in the order it will be built. Volumes use: footing, column, beam = L × W × H; slab = L × W × thickness; masonry wall = L × H × thickness.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Element</th><th>Type</th><th className="num">Qty</th><th>Dimensions (m)</th><th className="num">f′c (MPa)</th><th /></tr></thead>
            <tbody>
              {elements.map((e) => (
                <tr key={e.id}>
                  <td>{e.label}</td><td>{e.element_type.replace('_', ' ')}</td><td className="num">{e.quantity}</td>
                  <td>{['length_m', 'width_m', 'height_m', 'thickness_m'].filter((k) => e[k]).map((k) => `${DIM_LABEL[k].split(' ')[0]} ${e[k]}`).join(' × ')}</td>
                  <td className="num">{e.concrete_fc_mpa ?? '—'}</td>
                  <td><button className="link" onClick={() => remove(e.id)}>Remove</button></td>
                </tr>
              ))}
              {!elements.length && <tr><td colSpan={6} className="muted">No elements yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <form onSubmit={addElement} style={{ marginTop: 16 }}>
          <h3>Add element</h3>
          <div className="row">
            <label className="field">Label<input required value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="e.g. Columns C1" /></label>
            <label className="field">Type<select value={f.element_type} onChange={(e) => setF({ ...f, element_type: e.target.value })}>{TYPES.map((t) => <option key={t[0]} value={t[0]}>{t[1]}</option>)}</select></label>
            <label className="field">Quantity<input type="number" min={1} step={1} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></label>
            {type[2].map((d) => <label className="field" key={d}>{type[3][d] ?? DIM_LABEL[d]}<input type="number" required min={0.01} step="any" value={f[d] ?? ''} onChange={(e) => setF({ ...f, [d]: e.target.value })} /></label>)}
            {isConcrete && <label className="field">Concrete f′c (MPa)<input type="number" min={15} max={35} step={1} value={f.concrete_fc_mpa} onChange={(e) => setF({ ...f, concrete_fc_mpa: e.target.value })} /></label>}
            {isConcrete && <label className="field">Steel kg/m³ (optional)<input type="number" min={0} step="any" value={f.rebar_kg_per_m3 ?? ''} onChange={(e) => setF({ ...f, rebar_kg_per_m3: e.target.value })} /></label>}
            <button className="primary" style={{ alignSelf: 'end' }}>Add</button>
          </div>
        </form>
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>Material prices (PKR)</h2>
          <p className="small muted">Prices are set centrally by the administrator, not by site staff, and are shown here for reference. Each estimate stores the prices it used.</p>
          <table>
            <tbody>
              {MATERIALS.map((m) => <tr key={m}><td>{m.toLowerCase()} (per {m === 'CEMENT' ? 'bag' : m === 'REBAR' ? 'kg' : m === 'BRICK' ? 'brick' : 'm³'})</td><td className="num">{Number(rates[m] ?? 0).toLocaleString('en-PK')}</td></tr>)}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h2>Cost estimate</h2>
          <p className="small muted">Mix design by the ACI 211.1 absolute-volume method; required strength margin per ACI 318. This is the materials budget; labour, equipment and overheads are added below.</p>
          <div className="row">
            <label className="field">Contingency %<input type="number" min={0} max={50} value={contingency} onChange={(e) => setContingency(e.target.value)} /></label>
            <button className="primary" style={{ alignSelf: 'end' }} onClick={runEstimate} disabled={!elements.length}>Create estimate</button>
          </div>
          {shown && <div style={{ marginTop: 12 }}><div className="small muted">Active budget</div><div style={{ fontSize: 26, fontWeight: 650 }}>{pkr(shown.total_pkr)}</div><div className="tiny">{pkrFull(shown.total_pkr)} incl. {shown.contingency_pct}% contingency</div></div>}
        </div>
      </div>

      <CostRates pid={pid} reload={reload} />

      {shown && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>Estimate breakdown</h2>
          {shown.warnings?.map((w, i) => <div key={i} className="alert warning"><b>!</b><div>{w.message ?? w}</div></div>)}
          <div className="table-wrap">
            <table>
              <thead><tr><th>Material</th><th className="num">Quantity</th><th>Unit</th><th className="num">Rate</th><th className="num">Cost</th></tr></thead>
              <tbody>{Object.entries(shown.by_material).map(([code, m]) => (
                <tr key={code}><td>{code.toLowerCase()}</td><td className="num">{m.quantity.toLocaleString('en-PK')}</td><td>{m.unit}</td><td className="num">{m.rate_pkr.toLocaleString('en-PK')}</td><td className="num">{pkrFull(m.cost_pkr)}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <h3 style={{ marginTop: 16 }}>Concrete mixes used (per m³, kg) — ACI 211.1</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th className="num">f′c</th><th className="num">f′cr</th><th className="num">w/c</th><th className="num">Water</th><th className="num">Cement</th><th className="num">Sand</th><th className="num">Coarse agg.</th><th className="num">Air %</th></tr></thead>
              <tbody>{shown.mixes.map((m) => <tr key={m.fc}><td className="num">{m.fc}</td><td className="num">{m.fcr}</td><td className="num">{m.wc}</td><td className="num">{m.water}</td><td className="num">{m.cement}</td><td className="num">{m.fine}</td><td className="num">{m.coarse}</td><td className="num">{m.airPct}</td></tr>)}</tbody>
            </table>
          </div>
          <p className="small muted">Purchase quantities convert mass to loose volume using bulk densities; coarse-aggregate compaction factor (rodded ÷ loose) = {shown.compaction}. Excluded: {shown.excluded?.join(', ')}.</p>
        </div>
      )}
    </>
  );
}
