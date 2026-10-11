import { useCallback, useEffect, useState } from 'react';
import { api, dateText, pkr } from '../../api.js';
import { Badge } from '../../components.jsx';

export default function Schedule({ pid, data, reload }) {
  const [tasks, setTasks] = useState([]);
  const [crews, setCrews] = useState(1);
  const [msg, setMsg] = useState({ type: '', text: '' });
  const load = useCallback(async () => setTasks((await api('GET', `/projects/${pid}/schedule`)).tasks), [pid]);
  useEffect(() => { load(); }, [load]);

  async function generate(confirm_reset = false) {
    try {
      const r = await api('POST', `/projects/${pid}/schedule/generate`, { crews: Number(crews), confirm_reset });
      setMsg({ type: 'ok', text: `Schedule generated: ${r.schedule.tasks.length} tasks, planned finish ${dateText(r.schedule.planned_end)}.` });
      load(); reload();
    } catch (e) {
      if (e.status === 409 && window.confirm(`${e.message}\n\nReplace the schedule and erase recorded progress?`)) return generate(true);
      setMsg({ type: 'err', text: e.message });
    }
  }

  const sched = data.headline?.schedule;
  return (
    <>
      <div className="card">
        <h2>Baseline schedule</h2>
        <p className="small muted">Generated from the design elements: duration = volume ÷ (output per crew-day × crews), tasks in BOQ order (list elements in build order), one starting after the previous finishes, Monday–Saturday working week. Each task's budget comes from the active estimate.</p>
        <div className="row">
          <label className="field">Crews<input type="number" min={1} max={20} value={crews} onChange={(e) => setCrews(e.target.value)} /></label>
          <button className="primary" style={{ alignSelf: 'end' }} onClick={() => generate(false)}>{tasks.length ? 'Regenerate schedule' : 'Generate schedule'}</button>
          {sched && <span style={{ alignSelf: 'end' }}><Badge status={sched.status} /> <span className="small muted">{data.headline.schedule.technical}</span></span>}
        </div>
        {msg.text && <div className={msg.type === 'err' ? 'err' : 'ok'} role="status" style={{ marginTop: 8 }}>{msg.text}</div>}
      </div>
      <div className="card table-wrap" style={{ marginTop: 16 }}>
        <table>
          <thead><tr><th>#</th><th>Task</th><th>Planned start</th><th>Planned end</th><th className="num">Budget</th><th style={{ minWidth: 160 }}>Progress</th></tr></thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td>{t.seq}</td><td>{t.name}</td><td>{dateText(t.planned_start)}</td><td>{dateText(t.planned_end)}</td><td className="num">{pkr(t.planned_cost_pkr)}</td>
                <td><div className="bar"><div style={{ width: `${t.percent_complete}%` }} /></div><span className="tiny">{Math.round(t.percent_complete)}%</span></td>
              </tr>
            ))}
            {!tasks.length && <tr><td colSpan={6} className="muted">No schedule yet. Create an estimate first, then generate.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
