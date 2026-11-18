// AI assistant UI (docs/handoff-schedule-assistant.md part B): daily brief, chat, recovery options, evidence verdicts, admin run log.
// Everything the assistant writes is labelled as AI-generated. It only reads project data: nothing here can
// change a measurement, forecast, alert or the schedule.
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api, dateText } from '../api.js';

/** Is the assistant on for this project, and with which model? null while loading. */
export function useAgentStatus(pid) {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    let live = true;
    api('GET', `/projects/${pid}/agent/status`).then((s) => live && setStatus(s)).catch(() => live && setStatus({ enabled: false }));
    return () => { live = false; };
  }, [pid]);
  return status;
}

// ------------------------------------------------------------------ safe mini-markdown (no HTML injection)
function inline(text, key = 0) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => (p.startsWith('**') && p.endsWith('**') ? <b key={`${key}-${i}`}>{p.slice(2, -2)}</b> : <span key={`${key}-${i}`}>{p}</span>));
}

export function Markdown({ text }) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i += 1; }
      const cells = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      out.push(
        <div className="table-wrap" key={`t${i}`} style={{ margin: '8px 0' }}>
          <table><thead><tr>{cells[0].map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead>
            <tbody>{cells.slice(1).map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>)}</tbody></table>
        </div>);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '')); i += 1; }
      out.push(<ul key={`l${i}`} style={{ margin: '4px 0 8px', paddingLeft: 20 }}>{items.map((t, k) => <li key={k}>{inline(t, k)}</li>)}</ul>);
      continue;
    }
    if (/^#{1,4}\s/.test(line)) out.push(<div key={`h${i}`} style={{ fontWeight: 600, marginTop: 8 }}>{inline(line.replace(/^#+\s/, ''))}</div>);
    else if (line.trim()) out.push(<p key={`p${i}`} style={{ margin: '4px 0' }}>{inline(line, i)}</p>);
    i += 1;
  }
  return <div>{out}</div>;
}

/** One assistant answer with its label, the tools it used and, for staff, the number check. */
export function Answer({ run, staff }) {
  if (!run) return null;
  const g = run.grounding;
  return (
    <div>
      {run.notice && <div className={run.status === 'failed' ? 'err' : 'note'} role="status">{run.notice}</div>}
      {run.answer && <Markdown text={run.answer} />}
      {staff && g && !g.grounded && (
        <div className="alert warning" role="alert" style={{ marginTop: 8 }}>
          <b aria-hidden>!</b>
          <div>Check these figures: they do not appear in the data the assistant read ({g.ungrounded.join(', ')}).{run.status === 'withheld' ? ' Investors were not shown this answer.' : ''}</div>
        </div>
      )}
      <div className="tiny muted" style={{ marginTop: 6 }}>
        {run.ai_label} {run.model && <>· {run.model}</>}
        {staff && run.tools_used?.length > 0 && <> · looked at: {run.tools_used.join(', ')}</>}
        {run.status === 'step_limit' && ' · stopped at its step limit'}
      </div>
    </div>
  );
}

const VERDICT = { plausible: ['good', '✓', 'Plausible'], doubtful: ['critical', '✕', 'Doubtful'], needs_review: ['warning', '!', 'Needs a human look'] };
export function VerdictBadge({ verdict }) {
  const [tone, icon, label] = VERDICT[verdict] ?? ['neutral', '–', verdict ?? 'no verdict'];
  return <span className={`badge s-${tone}`}><i aria-hidden>{icon}</i>{label}</span>;
}

// ------------------------------------------------------------------ brief
export function BriefCard({ pid, staff }) {
  const [briefs, setBriefs] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    try { setBriefs((await api('GET', `/projects/${pid}/agent/briefs?limit=5`)).briefs); } catch (e) { setErr(e.message); }
  }, [pid]);
  useEffect(() => { load(); }, [load]);
  async function writeNow() {
    setBusy(true); setErr('');
    try { await api('POST', `/projects/${pid}/agent/briefs`); await load(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  const latest = briefs?.[0];
  return (
    <div className="card" aria-busy={busy}>
      <div className="chart-title">
        <h3>AI site brief{latest ? ` · ${dateText(latest.as_of)}` : ''}</h3>
        {staff && <button className="link small" onClick={writeNow} disabled={busy}>{busy ? 'Writing… (up to a minute)' : "Write today's brief"}</button>}
      </div>
      {err && <div className="err small">{err}</div>}
      {!briefs && !err && <div className="small muted">Loading…</div>}
      {briefs && !latest && <div className="note">No brief yet. One is written automatically on days when alerts open or close{staff ? ', or press the button' : ''}.</div>}
      {latest && <Answer run={latest} staff={staff} />}
      {briefs?.length > 1 && (
        <details style={{ marginTop: 8 }}>
          <summary className="small" style={{ cursor: 'pointer' }}>Earlier briefs</summary>
          {briefs.slice(1).map((b) => <div key={b.id} style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 8 }}><div className="small"><b>{dateText(b.as_of)}</b></div><Answer run={b} staff={staff} /></div>)}
        </details>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ chat
const SUGGEST = {
  staff: ['Why are we behind schedule?', 'Which task is causing the most delay?', 'What are the worst defects this week?', 'What if we add a crew?'],
  investor: ['Are we on time and on budget?', 'When will the building be finished?', 'Is the site safe right now?'],
};
export function Chat({ pid, staff }) {
  const [turns, setTurns] = useState([]);
  const [cid, setCid] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'nearest' }); }, [turns, busy]);
  async function send(message) {
    const q = (message ?? text).trim();
    if (!q || busy) return;
    setBusy(true); setErr(''); setText('');
    setTurns((t) => [...t, { q, run: null }]);
    try {
      const r = await api('POST', `/projects/${pid}/agent/chat`, { message: q, ...(cid ? { conversation_id: cid } : {}) });
      setCid(r.conversation_id);
      setTurns((t) => [...t.slice(0, -1), { q, run: r.run }]);
    } catch (e) {
      setErr(e.message);
      setTurns((t) => t.slice(0, -1));
      setText(q);
    } finally { setBusy(false); }
  }
  return (
    <div className="card" aria-busy={busy}>
      <div className="chart-title">
        <h3>Ask about this project</h3>
        {turns.length > 0 && <button className="link small" onClick={() => { setTurns([]); setCid(null); }}>New conversation</button>}
      </div>
      <p className="small muted">The assistant looks up the project's own data before answering. It cannot change anything{staff ? ', and every figure it gives is checked against the data it read' : ''}.</p>
      <div style={{ display: 'grid', gap: 12, margin: '8px 0' }}>
        {turns.map((t, i) => (
          <div key={i}>
            <div className="small" style={{ fontWeight: 600 }}>You: {t.q}</div>
            <div style={{ marginTop: 4, paddingLeft: 12, borderLeft: '3px solid var(--series-1)' }}>
              {t.run ? <Answer run={t.run} staff={staff} /> : <span className="small muted">Looking at the project data…</span>}
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      {!turns.length && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {SUGGEST[staff ? 'staff' : 'investor'].map((s) => <button key={s} className="link small" onClick={() => send(s)} disabled={busy}>{s}</button>)}
        </div>
      )}
      <form className="row" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input style={{ flex: 1, minWidth: 0 }} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} placeholder="Type a question" aria-label="Question for the assistant" disabled={busy} />
        <button className="primary" type="submit" disabled={busy || !text.trim()}>{busy ? 'Thinking…' : 'Ask'}</button>
      </form>
      {err && <div className="err small" role="alert" style={{ marginTop: 6 }}>{err}</div>}
    </div>
  );
}

/** The whole assistant tab for engineers and investors. */
export function AssistantPanel({ pid, role, status }) {
  const staff = role !== 'investor';
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {status?.offline && <div className="note"><b>Offline demo mode.</b> No language model is configured on this server, so answers are a plain read-out of the dashboard. Set GEMINI_API_KEYS to enable the full assistant.</div>}
      <BriefCard pid={pid} staff={staff} />
      <Chat pid={pid} staff={staff} />
    </div>
  );
}

// ------------------------------------------------------------------ engineer: recovery and triage
export function RecoveryPlanner({ pid }) {
  const [run, setRun] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function go() {
    setBusy(true); setErr('');
    try { setRun((await api('POST', `/projects/${pid}/agent/recovery`, {})).run); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <div className="card" style={{ marginTop: 16 }} aria-busy={busy}>
      <div className="chart-title">
        <h2>Recovery options (AI)</h2>
        <button className="primary" onClick={go} disabled={busy}>{busy ? 'Testing options… (up to a minute)' : run ? 'Ask again' : 'Suggest recovery options'}</button>
      </div>
      <p className="small muted">The assistant finds the tasks behind the delay and tests options with the what-if tools (more crews, a faster pace). It only advises: nothing changes until you regenerate the schedule yourself.</p>
      {err && <div className="err small">{err}</div>}
      {run && <Answer run={run} staff />}
    </div>
  );
}

export function TriageList({ pid }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { api('GET', `/projects/${pid}/agent/triage`).then((r) => setRows(r.triage)).catch(() => setRows([])); }, [pid]);
  if (!rows) return null;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>AI checks of doubtful frames</h3>
      <p className="small muted">When a camera frame is flagged (covered, blurred, moved) or shows an earlier stage than before, the assistant checks it. Its verdict is advice: stored measurements are never changed by it.</p>
      {!rows.length && <div className="note">No doubtful frames have been checked yet.</div>}
      {rows.map((r) => (
        <div key={r.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 8 }}>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}><VerdictBadge verdict={r.verdict} /><span className="small">{dateText(r.as_of)}</span><span className="tiny muted">frame {String(r.media_id).slice(0, 8)}</span></div>
          <Answer run={r} staff />
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ admin: run log
const JOB = { daily_analyst: 'Daily brief', chat: 'Chat', recovery_planner: 'Recovery', evidence_triage: 'Evidence check' };
export function AiActivity({ pid }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(null);
  useEffect(() => { api('GET', `/projects/${pid}/agent/runs`).then(setData).catch((e) => setErr(e.message)); }, [pid]);
  if (err) return <div className="err">{err}</div>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="card table-wrap">
        <h3>AI assistant use per day</h3>
        <p className="small muted">Limit: {data.daily_limit} runs per project per day. Keys are never stored; only which key of the pool was used.</p>
        <table><thead><tr><th>Date</th><th className="num">Runs</th><th className="num">Failed</th><th className="num">Withheld</th><th className="num">Tokens in</th><th className="num">Tokens out</th></tr></thead>
          <tbody>{data.totals.map((t) => <tr key={t.date}><td>{dateText(t.date)}</td><td className="num">{t.runs}</td><td className="num">{t.failed}</td><td className="num">{t.withheld}</td><td className="num">{t.input_tokens ?? 0}</td><td className="num">{t.output_tokens ?? 0}</td></tr>)}
            {!data.totals.length && <tr><td colSpan={6} className="muted">No assistant runs yet.</td></tr>}</tbody></table>
      </div>
      <div className="card table-wrap">
        <h3>Run log</h3>
        <table><thead><tr><th>When</th><th>Job</th><th>For</th><th>Status</th><th>Tools called</th><th className="num">Tokens</th><th>Key</th><th /></tr></thead>
          <tbody>{data.runs.map((r) => (
            <Fragment key={r.id}>
              <tr>
                <td>{new Date(r.created_at).toLocaleString('en-GB')}</td><td>{JOB[r.job] ?? r.job}</td><td>{r.audience}</td>
                <td>{r.status}{r.verdict ? ` (${r.verdict})` : ''}</td><td className="small">{r.tools_used.join(', ') || '-'}</td>
                <td className="num">{r.input_tokens + r.output_tokens}</td><td>{r.key_index ?? '-'}</td>
                <td><button className="link small" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Hide' : 'Details'}</button></td>
              </tr>
              {open === r.id && (
                <tr><td colSpan={8}>
                  {r.question && <div className="small"><b>Asked:</b> {r.question}</div>}
                  {r.error && <div className="err small">{r.error}</div>}
                  <ol className="small" style={{ paddingLeft: 20 }}>{r.steps.map((s) => <li key={s.index}>{s.tool_calls.length ? `called ${s.tool_calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(', ')}` : `answered${s.forced ? ' (forced at the step limit)' : ''}`}</li>)}</ol>
                  <Answer run={r} staff />
                </td></tr>
              )}
            </Fragment>
          ))}</tbody></table>
      </div>
    </div>
  );
}
