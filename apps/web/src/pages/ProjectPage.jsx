import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, dateText, session } from '../api.js';
import { Alerts, Badge } from '../components.jsx';
import Investor from './Investor.jsx';
import Overview from './engineer/Overview.jsx';
import Design from './engineer/Design.jsx';
import Schedule from './engineer/Schedule.jsx';
import SiteStatus from './engineer/SiteStatus.jsx';
import Evidence from './engineer/Evidence.jsx';
import Risk from './engineer/Risk.jsx';
import Access from './engineer/Access.jsx';
import TestFootage from './engineer/TestFootage.jsx';

const BASE_TABS = [['overview', 'Overview'], ['design', 'Design & estimate'], ['schedule', 'Schedule'], ['site', 'Crews & equipment'], ['evidence', 'Evidence'], ['risk', 'Risk & safety'], ['testing', 'Test footage']];
const ADMIN_TAB = ['access', 'Access'];

export default function ProjectPage() {
  const { id } = useParams();
  const role = session.get().user.role;
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('overview');
  const TABS = role === 'admin' ? [...BASE_TABS, ADMIN_TAB] : BASE_TABS;

  const reload = useCallback(async () => {
    try { setData(await api('GET', `/projects/${id}/dashboard`)); setError(''); } catch (e) { setError(e.message); }
  }, [id]);
  useEffect(() => { reload(); }, [reload]);

  if (error) return <><Link to="/">← Projects</Link><p className="err">{error}</p></>;
  if (!data) return <p className="muted">Loading…</p>;
  if (role === 'investor') return <><Link to="/">← Projects</Link><Investor data={data} /></>;

  return (
    <>
      <Link to="/">← Projects</Link>
      {data.project.is_demo && <div className="note" style={{ margin: '8px 0' }}><b>Demo project.</b> Camera frames are synthetic drawings generated for demonstration, processed by the same pipeline as real frames.</div>}
      <div className="row" style={{ justifyContent: 'space-between', margin: '8px 0 16px' }}>
        <div>
          <h1>{data.project.name}</h1>
          <div className="muted small">{data.project.location} · started {dateText(data.project.start_date)} · status as of {dateText(data.as_of)}</div>
        </div>
        {data.setup_complete && (
          <div className="row"><Badge status={data.headline.budget.status} /><Badge status={data.headline.schedule.status} /><Badge status={data.headline.safety.status} /></div>
        )}
      </div>
      {data.alerts.some((a) => a.level !== 'info') && (
        <div style={{ marginBottom: 12 }}><Alerts alerts={data.alerts} onAck={async (aid) => { await api('POST', `/projects/${id}/alerts/${aid}/ack`); reload(); }} /></div>
      )}
      <nav className="tabs" role="tablist">
        {TABS.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>)}
      </nav>
      {tab === 'overview' && <Overview data={data} />}
      {tab === 'design' && <Design pid={id} data={data} reload={reload} />}
      {tab === 'schedule' && <Schedule pid={id} data={data} reload={reload} />}
      {tab === 'site' && <SiteStatus pid={id} reload={reload} />}
      {tab === 'evidence' && <Evidence pid={id} data={data} reload={reload} />}
      {tab === 'risk' && <Risk data={data} />}
      {tab === 'testing' && <TestFootage pid={id} />}
      {tab === 'access' && role === 'admin' && <Access pid={id} />}
    </>
  );
}
