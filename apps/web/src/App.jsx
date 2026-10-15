import { Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { session } from './api.js';
import Login from './pages/Login.jsx';
import Projects from './pages/Projects.jsx';
import Users from './pages/Users.jsx';
import NotificationBell from './components/NotificationBell.jsx';
import ProjectPage from './pages/ProjectPage.jsx';

function Shell({ children }) {
  const s = session.get();
  const nav = useNavigate();
  const roleName = { admin: 'Administrator', engineer: 'Site engineer', investor: 'Investor' }[s?.user?.role];
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">SafelyBuild</Link>
        {s?.user?.role === 'admin' && <Link to="/users" className="small">Accounts</Link>}
        <span className="spacer" />
        <NotificationBell />
        <span className="small muted">{s?.user?.full_name} · {roleName}</span>
        <button onClick={() => { session.clear(); nav('/login'); }}>Sign out</button>
      </header>
      <main className="page">{children}</main>
    </>
  );
}

function Private({ children }) {
  return session.get()?.token ? <Shell>{children}</Shell> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Private><Projects /></Private>} />
      <Route path="/users" element={<Private><Users /></Private>} />
      <Route path="/p/:id/*" element={<Private><ProjectPage /></Private>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
