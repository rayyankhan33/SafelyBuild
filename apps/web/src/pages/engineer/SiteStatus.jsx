// The only daily input an engineer gives: how many crews are on site and which equipment is available.
// Progress, material use, defects and hazards are measured from camera images and cannot be typed.
import { useCallback, useEffect, useState } from 'react';
import { api, dateText, isoToday } from '../../api.js';

export default function SiteStatus({ pid, reload }) {
  const [date, setDate] = useState(isoToday());
  const [crews, setCrews] = useState(1);
  const [equipment, setEquipment] = useState([{ type: '', count: 1 }]);
  const [history, setHistory] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: '' });

  const load = useCallback(async () => {
    const { site_status } = await api('GET', `/projects/${pid}/site-status`);
    setHistory(site_status);
    const existing = site_status.find((r) => r.log_date === date);
    if (existing) { setCrews(existing.crews); setEquipment(existing.equipment.length ? existing.equipment : [{ type: '', count: 1 }]); }
  }, [pid, date]);
  useEffect(() => { load().catch((e) => setMsg({ type: 'err', text: e.message })); }, [load]);

  async function save(e) {
    e.preventDefault(); setMsg({ type: '', text: '' });
    try {
      await api('PUT', `/projects/${pid}/site-status/${date}`, {
        crews: Number(crews), equipment: equipment.filter((x) => x.type.trim()).map((x) => ({ type: x.type.trim(), count: Number(x.count) })),
      });
      setMsg({ type: 'ok', text: `Saved for ${dateText(date)}.` });
      load(); reload();
    } catch (err) {
      setMsg({ type: 'err', text: err.details?.length ? `${err.message}: ${err.details.map((d) => d.message).join('; ')}` : err.message });
    }
  }

  return (
    <>
      <div className="note" style={{ marginBottom: 16 }}>
        You enter only the <b>crews on site</b> and the <b>equipment available</b>. Everything else (progress, materials used, money spent, defects and hazards) is measured from the site cameras
        and cannot be entered or changed by anyone, so the record cannot be falsified.
      </div>
      <form className="card" onSubmit={save}>
        <h2>Crews and equipment</h2>
        <div className="row">
          <label className="field">Date<input type="date" max={isoToday()} value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="field">Crews on site<input type="number" min={0} max={500} required value={crews} onChange={(e) => setCrews(e.target.value)} /></label>
        </div>
        <h3 style={{ marginTop: 16 }}>Equipment available</h3>
        {equipment.map((x, i) => (
          <div key={i} className="row" style={{ marginBottom: 6 }}>
            <input placeholder="e.g. Concrete mixer" aria-label="equipment type" value={x.type} onChange={(e) => setEquipment(equipment.map((y, j) => (j === i ? { ...y, type: e.target.value } : y)))} />
            <input type="number" min={0} aria-label="count" value={x.count} onChange={(e) => setEquipment(equipment.map((y, j) => (j === i ? { ...y, count: e.target.value } : y)))} />
            <button type="button" className="link" onClick={() => setEquipment(equipment.filter((_, j) => j !== i))}>remove</button>
          </div>
        ))}
        <button type="button" onClick={() => setEquipment([...equipment, { type: '', count: 1 }])}>+ Add equipment</button>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="primary">Save</button>
          {msg.text && <span className={msg.type === 'err' ? 'err' : 'ok'} role="status">{msg.text}</span>}
        </div>
      </form>

      <div className="card table-wrap" style={{ marginTop: 16 }}>
        <h2>Recent entries</h2>
        <table>
          <thead><tr><th>Date</th><th className="num">Crews</th><th>Equipment</th></tr></thead>
          <tbody>
            {history.slice(0, 15).map((r) => (
              <tr key={r.log_date}><td>{dateText(r.log_date)}</td><td className="num">{r.crews}</td><td>{r.equipment.map((x) => `${x.count} × ${x.type}`).join(', ') || '—'}</td></tr>
            ))}
            {!history.length && <tr><td colSpan={3} className="muted">Nothing entered yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
