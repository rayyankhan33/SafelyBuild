// Engineer: labour, equipment and overhead rates. Entered ONCE at the start of the project, then locked:
// the API and the database refuse changes (changing them later needs change control, which is not built yet).
import { useEffect, useState } from 'react';
import { api, pkrFull } from '../../api.js';

const blank = { type: '', rate_pkr: '', planned_units: 1 };

export default function CostRates({ pid, reload }) {
  const [rates, setRates] = useState(undefined);        // undefined = loading, null = not set
  const [form, setForm] = useState({ crew_rate_pkr: '', overhead_pct: '8', equipment: [{ ...blank }] });
  const [msg, setMsg] = useState({ type: '', text: '' });

  const load = () => api('GET', `/projects/${pid}/cost-rates`).then((r) => setRates(r.rates)).catch((e) => setMsg({ type: 'err', text: e.message }));
  useEffect(() => { load(); }, [pid]);

  const setEq = (i, k, v) => setForm({ ...form, equipment: form.equipment.map((e, j) => (j === i ? { ...e, [k]: v } : e)) });

  async function save(e) {
    e.preventDefault();
    if (!window.confirm('These rates are locked as soon as you save them and cannot be changed afterwards. Continue?')) return;
    const body = {
      crew_rate_pkr: Number(form.crew_rate_pkr), overhead_pct: Number(form.overhead_pct),
      equipment: form.equipment.filter((x) => x.type.trim()).map((x) => ({ type: x.type, rate_pkr: Number(x.rate_pkr), planned_units: Number(x.planned_units) })),
    };
    try {
      const r = await api('POST', `/projects/${pid}/cost-rates`, body);
      setMsg({ type: 'ok', text: r.note }); setRates(r.rates); reload();
    } catch (err) { setMsg({ type: 'err', text: err.details?.length ? `${err.message}: ${err.details.map((d) => d.message ?? d).join('; ')}` : err.message }); }
  }

  if (rates === undefined) return null;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Labour, equipment and overheads</h2>
      {msg.text && <div className={msg.type === 'err' ? 'err' : 'ok'} role="status" style={{ marginBottom: 8 }}>{msg.text}</div>}
      {rates ? (
        <>
          <p className="small muted">Entered once at the start of the project and now <b>locked</b>. They add labour, equipment and overheads to the budget and to the cost recorded each day from your crew and equipment log. Regenerate the schedule after setting them so the baseline includes these costs.</p>
          <table>
            <tbody>
              <tr><td>Labour, per crew per working day</td><td className="num">{pkrFull(rates.crew_rate_pkr)}</td></tr>
              <tr><td>Site overheads</td><td className="num">{rates.overhead_pct}% of direct cost</td></tr>
              {rates.equipment.map((e) => <tr key={e.type}><td>Equipment: {e.type} (planned {e.planned_units})</td><td className="num">{pkrFull(e.rate_pkr)} per unit per day</td></tr>)}
            </tbody>
          </table>
        </>
      ) : (
        <form onSubmit={save}>
          <p className="small muted">Until these are set, the budget covers materials only. Enter them <b>once</b>: they are locked after saving. Equipment on site that has no rate here is not costed.</p>
          <div className="row">
            <label className="field">Labour: cost of one crew per working day (PKR)<input type="number" required min={0} step="any" value={form.crew_rate_pkr} onChange={(e) => setForm({ ...form, crew_rate_pkr: e.target.value })} /></label>
            <label className="field">Site overheads (% of direct cost)<input type="number" required min={0} max={100} step="any" value={form.overhead_pct} onChange={(e) => setForm({ ...form, overhead_pct: e.target.value })} /></label>
          </div>
          <h3>Equipment hire</h3>
          {form.equipment.map((x, i) => (
            <div className="row" key={i} style={{ marginBottom: 8 }}>
              <label className="field">Type<input value={x.type} placeholder="e.g. Concrete mixer" onChange={(e) => setEq(i, 'type', e.target.value)} /></label>
              <label className="field">Hire per unit per day (PKR)<input type="number" min={0} step="any" value={x.rate_pkr} onChange={(e) => setEq(i, 'rate_pkr', e.target.value)} /></label>
              <label className="field">Planned units<input type="number" min={0} step={1} value={x.planned_units} onChange={(e) => setEq(i, 'planned_units', e.target.value)} /></label>
              {form.equipment.length > 1 && <button type="button" className="link" style={{ alignSelf: 'end' }} onClick={() => setForm({ ...form, equipment: form.equipment.filter((_, j) => j !== i) })}>Remove</button>}
            </div>
          ))}
          <div className="row">
            <button type="button" className="link" onClick={() => setForm({ ...form, equipment: [...form.equipment, { ...blank }] })}>+ Add equipment</button>
            <button className="primary">Save and lock</button>
          </div>
        </form>
      )}
    </div>
  );
}
