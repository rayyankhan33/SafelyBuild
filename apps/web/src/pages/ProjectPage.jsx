// One project, three different workspaces. Each role gets its own tabs and pages; nothing is shared except
// the project header. See docs/design.md section 10 for what each role may do.
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, dateText, session } from '../api.js';
import { Alerts, Badge } from '../components.jsx';
import { Header as InvestorHeader } from './investor/Shared.jsx';
import InvSummary from './investor/Summary.jsx';
import InvBudget from './investor/Budget.jsx';
import InvProgress from './investor/Progress.jsx';
import InvSafety from './investor/Safety.jsx';
import InvPhotos from './investor/Photos.jsx';
import Overview from './engineer/Overview.jsx';
import Design from './engineer/Design.jsx';
import Schedule from './engineer/Schedule.jsx';
import SiteStatus from './engineer/SiteStatus.jsx';
import Evidence from './engineer/Evidence.jsx';
import Risk from './engineer/Risk.jsx';
import TestFootage from './engineer/TestFootage.jsx';
import AdminSummary from './admin/Summary.jsx';
import Cameras from './admin/Cameras.jsx';
import PriceBook from './admin/PriceBook.jsx';
import Access from './admin/Access.jsx';
import Audit from './admin/Audit.jsx';

const TABS = {
  investor: [['summary', 'Summary'], ['budget', 'Budget'], ['progress', 'Progress & schedule'], ['safety', 'Safety'], ['photos', 'Site photos']],
  engineer: [['overview', 'Overview'], ['design', 'Design & estimate'], ['schedule', 'Schedule'], ['site', 'Crews & equipment'], ['evidence', 'Evidence'], ['risk', 'Risk & safety'], ['testing', 'Test footage']],
  admin: [['summary', 'Summary'], ['cameras', 'Cameras'], ['prices', 'Price book'], ['access', 'Access'], ['audit', 'Audit log']],
};

export default function ProjectPage() {
  const { id } = useParams();
  const role = session.get().user.role;
  const tabs = TABS[role];
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState(tabs[0][0]);

  const reload = useCallback(async () => {
    try { setData(await api('GET', `/projects/${id}/dashboard`)); setError(''); } catch (e) { setError(e.message); }
  }, [id]);
  useEffect(() => { reload(); }, [reload]);

  if (error) return <><Link to="/">← Projects</Link><p className="err">{error}</p></>;
  if (!data) return <p className="muted">Loading…</p>;

  const nav = (
    <nav className="tabs" role="tablist">
      {tabs.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>)}
    </nav>
  );

  if (role === 'investor') {
    return (
      <>
        <Link to="/">← Projects</Link>
        <div style={{ marginTop: 8 }}><InvestorHeader data={data} /></div>
        {nav}
        {tab === 'summary' && <InvSummary data={data} go={setTab} />}
        {tab === 'budget' && <InvBudget data={data} />}
        {tab === 'progress' && <InvProgress data={data} pid={id} />}
        {tab === 'safety' && <InvSafety data={data} />}
        {tab === 'photos' && <InvPhotos data={data} />}
      </>
    );
  }

  const isEngineer = role === 'engineer';
  return (
    <>
      <Link to="/">← Projects</Link>
      {data.project.is_demo && <div className="note" style={{ margin: '8px 0' }}><b>Demo project.</b> Camera frames are synthetic drawings generated for demonstration, processed by the same pipeline as real frames.</div>}
      <div className="row" style={{ justifyContent: 'space-between', margin: '8px 0 16px' }}>
        <div>
          <h1>{data.project.name}</h1>
          <div className="muted small">{data.project.location} · started {dateText(data.project.start_date)} · status as of {dateText(data.as_of)}</div>
        </div>
        {isEngineer && data.setup_complete && (
          <div className="row"><Badge status={data.headline.budget.status} /><Badge status={data.headline.schedule.status} /><Badge status={data.headline.safety.status} /></div>
        )}
      </div>
      {isEngineer && data.alerts.some((a) => a.level !== 'info') && (
        <div style={{ marginBottom: 12 }}><Alerts alerts={data.alerts} onAck={async (aid) => { await api('POST', `/projects/${id}/alerts/${aid}/ack`); reload(); }} /></div>
      )}
      {nav}
      {isEngineer && (
        <>
          {tab === 'overview' && <Overview data={data} />}
          {tab === 'design' && <Design pid={id} data={data} reload={reload} />}
          {tab === 'schedule' && <Schedule pid={id} data={data} reload={reload} />}
          {tab === 'site' && <SiteStatus pid={id} reload={reload} />}
          {tab === 'evidence' && <Evidence pid={id} data={data} />}
          {tab === 'risk' && <Risk data={data} />}
          {tab === 'testing' && <TestFootage pid={id} />}
        </>
      )}
      {role === 'admin' && (
        <>
          {tab === 'summary' && <AdminSummary data={data} go={setTab} />}
          {tab === 'cameras' && <Cameras data={data} pid={id} reload={reload} />}
          {tab === 'prices' && <PriceBook />}
          {tab === 'access' && <Access pid={id} />}
          {tab === 'audit' && <Audit pid={id} />}
        </>
      )}
    </>
  );
}
