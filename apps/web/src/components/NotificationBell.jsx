// Bell with an unread count and a dropdown. Polls every 15 seconds. Each user sees only their own
// notifications (admins are notified when an engineer creates a project).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';

const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

export default function NotificationBell() {
  const nav = useNavigate();
  const [data, setData] = useState({ notifications: [], unread: 0 });
  const [open, setOpen] = useState(false);
  const box = useRef(null);

  const load = useCallback(() => api('GET', '/notifications?limit=20').then(setData).catch(() => {}), []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  useEffect(() => {
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  async function click(n) {
    if (!n.read_at) await api('POST', `/notifications/${n.id}/read`).catch(() => {});
    setOpen(false); load();
    if (n.project_id) nav(`/p/${n.project_id}`);
  }
  async function readAll() { await api('POST', '/notifications/read-all').catch(() => {}); load(); }

  return (
    <div className="bell" ref={box}>
      <button className="bell-btn" aria-label={`Notifications, ${data.unread} unread`} aria-expanded={open} onClick={() => { setOpen(!open); load(); }}>
        <span aria-hidden>🔔</span>
        {data.unread > 0 && <span className="bell-count">{data.unread > 9 ? '9+' : data.unread}</span>}
      </button>
      {open && (
        <div className="bell-menu" role="menu">
          <div className="row" style={{ justifyContent: 'space-between', padding: '8px 12px' }}>
            <b>Notifications</b>
            {data.unread > 0 && <button className="link small" onClick={readAll}>Mark all read</button>}
          </div>
          {data.notifications.length === 0 && <div className="muted small" style={{ padding: '8px 12px 14px' }}>Nothing yet.</div>}
          {data.notifications.map((n) => (
            <button key={n.id} role="menuitem" className={`bell-item ${n.read_at ? '' : 'unread'}`} onClick={() => click(n)}>
              <div><b>{n.title}</b> <span className="tiny">· {ago(n.created_at)}</span></div>
              <div className="small muted">{n.body}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
