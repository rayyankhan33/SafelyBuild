// Administrator: the audit log. Every input by a person, every camera frame received and every change of
// access is recorded here and cannot be edited.
import { useEffect, useState } from 'react';
import { api } from '../../api.js';

export default function Audit({ pid }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => { api('GET', `/projects/${pid}/audit`).then((r) => setRows(r.audit)).catch((e) => setError(e.message)); }, [pid]);
  return (
    <div className="card table-wrap">
      <h2>Audit log (latest 200)</h2>
      {error && <p className="err">{error}</p>}
      <table>
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>On</th><th>Details</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.created_at).toLocaleString('en-GB')}</td><td>{r.full_name ?? 'system'}</td><td>{r.action}</td><td>{r.entity}</td>
              <td className="tiny">{Object.keys(r.details ?? {}).length ? JSON.stringify(r.details).slice(0, 120) : ''}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={5} className="muted">Nothing recorded yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
