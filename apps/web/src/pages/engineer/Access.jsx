// Administrator: who can see this project. An engineer creates a project and the admin is notified;
// the admin then adds the investors who should follow it.
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';

export default function Access({ pid }) {
  const [members, setMembers] = useState([]);
  const [users, setUsers] = useState([]);
  const [pick, setPick] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [m, u] = await Promise.all([api('GET', `/projects/${pid}/members`), api('GET', '/users')]);
    setMembers(m.members); setUsers(u.users);
  }, [pid]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  const ids = new Set(members.map((m) => m.id));
  const candidates = users.filter((u) => !ids.has(u.id) && u.role !== 'admin'); // admins already see every project

  async function add(e) {
    e.preventDefault(); setError('');
    try { await api('POST', `/projects/${pid}/members`, { user_id: pick }); setPick(''); load(); } catch (err) { setError(err.message); }
  }
  async function remove(id) {
    setError('');
    try { await api('DELETE', `/projects/${pid}/members/${id}`); load(); } catch (err) { setError(err.message); }
  }

  return (
    <>
      <div className="note" style={{ marginBottom: 16 }}>Administrators see every project in the organisation. Engineers and investors see only the projects they are added to here.</div>
      <div className="card table-wrap">
        <h2>People with access</h2>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th /></tr></thead>
          <tbody>
            {members.map((m) => <tr key={m.id}><td>{m.full_name}</td><td>{m.email}</td><td>{m.role}</td><td><button className="link" onClick={() => remove(m.id)}>Remove</button></td></tr>)}
            {!members.length && <tr><td colSpan={4} className="muted">No one yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <form className="card row" style={{ marginTop: 16 }} onSubmit={add}>
        <label className="field">Add a person<select required value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Choose…</option>{candidates.map((u) => <option key={u.id} value={u.id}>{u.full_name} ({u.role})</option>)}</select></label>
        <button className="primary" style={{ alignSelf: 'end' }}>Add</button>
        {error && <span className="err" role="alert">{error}</span>}
      </form>
    </>
  );
}
