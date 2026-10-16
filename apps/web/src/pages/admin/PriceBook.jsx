// Administrator: the central material price book. Site staff cannot change prices; each estimate stores the
// prices it used, and spend is costed at the price in force when a material is first used.
import { useEffect, useState } from 'react';
import { api } from '../../api.js';

const MATERIALS = ['CEMENT', 'SAND', 'AGGREGATE', 'REBAR', 'BRICK'];
const UNIT = { CEMENT: 'bag', REBAR: 'kg', BRICK: 'brick' };

export default function PriceBook() {
  const [rates, setRates] = useState({});
  const [msg, setMsg] = useState({ type: '', text: '' });
  useEffect(() => { api('GET', '/price-book').then((r) => setRates(r.rates)).catch((e) => setMsg({ type: 'err', text: e.message })); }, []);

  async function save() {
    try {
      await api('PUT', '/price-book', Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, Number(v)])));
      setMsg({ type: 'ok', text: 'Price book saved. New estimates will use these prices.' });
    } catch (e) { setMsg({ type: 'err', text: e.details?.length ? `${e.message}: ${e.details.map((d) => d.message ?? d).join('; ')}` : e.message }); }
  }

  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <h2>Price book (PKR)</h2>
      <p className="small muted">Demo values: replace with current local prices before relying on a budget.</p>
      <div className="grid">
        {MATERIALS.map((m) => (
          <label className="field" key={m}>{m.toLowerCase()} (per {UNIT[m] ?? 'm³'})
            <input type="number" min={0} step="any" value={rates[m] ?? ''} onChange={(e) => setRates({ ...rates, [m]: e.target.value })} /></label>
        ))}
      </div>
      <button style={{ marginTop: 12 }} onClick={save}>Save price book</button>
      {msg.text && <div className={msg.type === 'err' ? 'err' : 'ok'} role="status" style={{ marginTop: 8 }}>{msg.text}</div>}
    </div>
  );
}
