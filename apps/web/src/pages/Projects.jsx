import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, dateText, isoToday, session } from '../api.js';
import { Badge } from '../components.jsx';

export default function Projects() {
  const [projects, setProjects] = useState(null);
  const [heads, setHeads] = useState({});
  const [error, setError] = useState('');
  const role = session.get().user.role;
  const [form, setForm] = useState({ name: '', location: '', start_date: isoToday() });
  const [formError, setFormError] = useState('');

  async function load() {
    try {
      const { projects } = await api('GET', '/projects');
      setProjects(projects);
      const entries = await Promise.all(projects.map((p) => api('GET', `/projects/${p.id}/dashboard`).then((d) => [p.id, d]).catch(() => [p.id, null])));
      setHeads(Object.fromEntries(entries));
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function create(e) {
    e.preventDefault(); setFormError('');
    try { await api('POST', '/projects', form); setForm({ ...form, name: '', location: '' }); load(); } catch (err) { setFormError(err.message); }
  }

  if (error) return <div className="err">{error}</div>;
  if (!projects) return <p className="muted">Loading projects…</p>;
  return (
    <>
      <h1>Your projects</h1>
      {projects.length === 0 && <p className="muted">You have not been added to any projects yet.</p>}
      <div className="grid cols-2">
        {projects.map((p) => {
          const h = heads[p.id]?.headline;
          return (
            <Link key={p.id} to={`/p/${p.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <div className="card">
                <h2>{p.name}{p.is_demo && <span className="badge s-neutral" style={{ marginLeft: 8 }}><i>·</i>Demo</span>}</h2>
                <div className="small muted">{p.location} · started {dateText(p.start_date)}</div>
                {h ? (
                  <div className="row" style={{ marginTop: 10 }}>
                    <b>{Math.round(h.percent_complete)}% complete</b>
                    <Badge status={h.budget.status} /><Badge status={h.schedule.status} />
                  </div>
                ) : <div className="small muted" style={{ marginTop: 10 }}>Setup in progress</div>}
              </div>
            </Link>
          );
        })}
      </div>
      {role !== 'investor' && (
        <form className="card" style={{ marginTop: 24 }} onSubmit={create}>
          <h2>Start a new project</h2>
          <div className="row">
            <label className="field">Name<input required minLength={2} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="field">Location<input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></label>
            <label className="field">Start date<input type="date" required value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} /></label>
            <button className="primary" style={{ alignSelf: 'end' }}>Create project</button>
          </div>
          {formError && <div className="err" role="alert">{formError}</div>}
        </form>
      )}
    </>
  );
}
