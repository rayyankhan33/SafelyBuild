// Administrator: manage accounts in the organisation (create, delete).
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, session } from '../api.js';

const ROLE = { admin: 'Administrator', engineer: 'Engineer (lead engineer)', investor: 'Investor' };

export default function Users() {
  const me = session.get().user;
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [form, setForm] = useState({ full_name: '', email: '', password: '', role: 'engineer', pec_number: '' });
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    try { setUsers((await api('GET', '/users')).users); setError(''); } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function remove(u) {
    if (!window.confirm(`Delete the account of ${u.full_name} (${u.email})?\n\nTheir sign-in stops working immediately. Projects and records they created are kept, and the audit trail keeps their name. This cannot be undone.`)) return;
    setNote('');
    try { await api('DELETE', `/users/${u.id}`); setNote(`Deleted ${u.full_name}.`); load(); } catch (e) { setError(e.message); }
  }
  async function create(e) {
    e.preventDefault(); setFormError(''); setNote('');
    try {
      await api('POST', '/users', { ...form, pec_number: form.pec_number || undefined });
      setNote(`Created ${form.full_name}.`); setForm({ ...form, full_name: '', email: '', password: '', pec_number: '' }); load();
    } catch (err) { setFormError(err.details?.length ? `${err.message}: ${err.details.map((d) => `${d.path} ${d.message}`).join('; ')}` : err.message); }
  }

  return (
    <>
      <Link to="/">← Projects</Link>
      <h1 style={{ marginTop: 8 }}>Accounts</h1>
      <p className="muted small">Administrators manage accounts and project access. They do not create projects: engineers do, and you are notified when they do.</p>
      {error && <div className="err" role="alert">{error}</div>}
      {note && <div className="ok" role="status">{note}</div>}
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>PEC no.</th><th /></tr></thead>
          <tbody>
            {(users ?? []).map((u) => (
              <tr key={u.id}>
                <td>{u.full_name}{u.id === me.id && <span className="tiny"> (you)</span>}</td><td>{u.email}</td><td>{ROLE[u.role]}</td><td>{u.pec_number ?? '—'}</td>
                <td>{u.id !== me.id && <button className="link err" onClick={() => remove(u)}>Delete</button>}</td>
              </tr>
            ))}
            {users === null && <tr><td colSpan={5} className="muted">Loading…</td></tr>}
          </tbody>
        </table>
      </div>
      <form className="card" style={{ marginTop: 16 }} onSubmit={create}>
        <h2>Create an account</h2>
        <div className="row">
          <label className="field">Full name<input required value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></label>
          <label className="field">Email<input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <label className="field">Temporary password (8+ characters)<input type="password" required minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
          <label className="field">Role<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          {form.role === 'engineer' && <label className="field">PEC number (optional)<input value={form.pec_number} onChange={(e) => setForm({ ...form, pec_number: e.target.value })} /></label>}
          <button className="primary" style={{ alignSelf: 'end' }}>Create</button>
        </div>
        {formError && <div className="err" role="alert">{formError}</div>}
      </form>
    </>
  );
}
