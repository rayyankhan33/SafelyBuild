import { useEffect, useState } from 'react';
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fetchBlobUrl, pkr, pkrFull, shortDate, statusInfo, dateText } from './api.js';

export function Badge({ status, labels }) {
  const { tone, label, icon } = statusInfo(status, labels);
  return <span className={`badge s-${tone}`}><i aria-hidden>{icon}</i>{label}</span>;
}

export function Kpi({ label, value, sub, badge, children }) {
  return (
    <div className="card kpi">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {badge}
      {sub && <div className="sub" style={{ marginTop: 6 }}>{sub}</div>}
      {children}
    </div>
  );
}

export function Alerts({ alerts, onAck }) {
  if (!alerts?.length) return <div className="note">No open warnings.</div>;
  const icon = { critical: '✕', warning: '!', info: 'i' };
  return alerts.map((a) => (
    <div key={a.id} className={`alert ${a.level}`} role="alert">
      <b aria-hidden>{icon[a.level]}</b>
      <div style={{ flex: 1 }}>
        <div><span className="tiny" style={{ textTransform: 'uppercase' }}>{a.kind} · {a.level}</span></div>
        <div>{a.message}</div>
      </div>
      {onAck && !a.acknowledged && <button className="link" onClick={() => onAck(a.id)}>Acknowledge</button>}
    </div>
  ));
}

export function AuthImage({ mediaId, alt = '', children }) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url; let cancelled = false;
    fetchBlobUrl(`/media/${mediaId}/file`).then((u) => { url = u; if (!cancelled) setSrc(u); }).catch(() => setFailed(true));
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [mediaId]);
  if (failed) return <div className="tiny" style={{ padding: 8 }}>Image unavailable</div>;
  return src ? <>{<img src={src} alt={alt} />}{children}</> : <div className="tiny" style={{ padding: 8 }}>Loading…</div>;
}

// ------------------------------------------------------------------ charts
const C = { plan: 'var(--series-1)', spent: 'var(--series-2)', earned: 'var(--series-3)' };
const AXIS = { stroke: 'var(--muted)', fontSize: 12, tickLine: false, axisLine: { stroke: 'var(--axis)' } };

function ChartCard({ title, subtitle, legend, rows, columns, children, height = 260 }) {
  const [table, setTable] = useState(false);
  return (
    <div className="card">
      <div className="chart-title">
        <h3>{title}</h3>
        <button className="link small" onClick={() => setTable(!table)}>{table ? 'Show chart' : 'Show table'}</button>
      </div>
      {subtitle && <div className="small muted">{subtitle}</div>}
      {legend && <div className="legend">{legend.map(([name, c]) => <span key={name} style={{ '--c': c }}>{name}</span>)}</div>}
      {table ? (
        <div className="table-wrap" style={{ maxHeight: height, overflowY: 'auto' }}>
          <table><thead><tr>{columns.map((c) => <th key={c.key} className={c.num ? 'num' : ''}>{c.label}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i}>{columns.map((c) => <td key={c.key} className={c.num ? 'num' : ''}>{c.fmt ? c.fmt(r[c.key]) : r[c.key] ?? '-'}</td>)}</tr>)}</tbody></table>
        </div>
      ) : (
        <div style={{ height }}>{children}</div>
      )}
    </div>
  );
}

function Tip({ active, payload, label, fmt }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tooltip">
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{dateText(label)}</div>
      {payload.filter((p) => p.value !== null && p.value !== undefined).map((p) => (
        <div key={p.dataKey} style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--ink-2)' }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: p.color, marginRight: 6 }} />{p.name}</span>
          <b>{fmt(p.value)}</b>
        </div>
      ))}
    </div>
  );
}

/** Cumulative: planned budget curve vs money spent vs value of work done. */
export function MoneyChart({ series, bac }) {
  const byDate = new Map(series.planned.map((p) => [p.date, { date: p.date, plan: p.pv }]));
  for (const a of series.actual) byDate.set(a.date, { ...(byDate.get(a.date) ?? { date: a.date }), spent: a.ac, earned: a.ev });
  const data = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const fmt = (v) => pkr(v);
  return (
    <ChartCard title="Money: planned vs spent vs work completed" subtitle="Where the rupees have gone compared with the value of work actually finished."
      legend={[['Planned spend', C.plan], ['Spent so far', C.spent], ['Value of work completed', C.earned]]}
      rows={series.actual} columns={[{ key: 'date', label: 'Date', fmt: dateText }, { key: 'pv', label: 'Planned', num: true, fmt: pkrFull }, { key: 'ac', label: 'Spent', num: true, fmt: pkrFull }, { key: 'ev', label: 'Work completed', num: true, fmt: pkrFull }]}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="date" tickFormatter={shortDate} {...AXIS} minTickGap={32} />
          <YAxis tickFormatter={(v) => (v >= 1e7 ? `${(v / 1e7).toFixed(1)}cr` : `${(v / 1e5).toFixed(0)}L`)} {...AXIS} width={48} />
          <Tooltip content={<Tip fmt={fmt} />} cursor={{ stroke: 'var(--axis)' }} />
          {bac > 0 && <ReferenceLine y={bac} stroke="var(--axis)" strokeDasharray="4 4" label={{ value: 'Budget', fill: 'var(--muted)', fontSize: 12, position: 'insideTopLeft' }} />}
          <Line dataKey="plan" name="Planned spend" stroke={C.plan} strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line dataKey="spent" name="Spent so far" stroke={C.spent} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
          <Line dataKey="earned" name="Value of work completed" stroke={C.earned} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function ProgressChart({ series, bac }) {
  const pct = (v) => (bac > 0 ? Math.round((v / bac) * 1000) / 10 : 0);
  const byDate = new Map(series.planned.map((p) => [p.date, { date: p.date, plan: pct(p.pv) }]));
  for (const a of series.actual) byDate.set(a.date, { ...(byDate.get(a.date) ?? { date: a.date }), actual: pct(a.ev) });
  const data = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return (
    <ChartCard title="Progress: planned vs actual" subtitle="Share of the whole project completed, weighted by cost."
      legend={[['Planned', C.plan], ['Actual', C.earned]]}
      rows={series.actual.map((a) => ({ date: a.date, planned: pct(a.pv), actual: pct(a.ev) }))}
      columns={[{ key: 'date', label: 'Date', fmt: dateText }, { key: 'planned', label: 'Planned %', num: true }, { key: 'actual', label: 'Actual %', num: true }]}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="date" tickFormatter={shortDate} {...AXIS} minTickGap={32} />
          <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} {...AXIS} width={44} />
          <Tooltip content={<Tip fmt={(v) => `${v}%`} />} cursor={{ stroke: 'var(--axis)' }} />
          <Line dataKey="plan" name="Planned" stroke={C.plan} strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line dataKey="actual" name="Actual" stroke={C.earned} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function DailySpendChart({ series }) {
  const data = series.actual.map((a) => ({ date: a.date, spend: a.daily_spend }));
  return (
    <ChartCard title="Daily spend on materials" subtitle="Money spent on materials each day logged on site." height={220}
      rows={data} columns={[{ key: 'date', label: 'Date', fmt: dateText }, { key: 'spend', label: 'Spent', num: true, fmt: pkrFull }]}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="date" tickFormatter={shortDate} {...AXIS} minTickGap={32} />
          <YAxis tickFormatter={(v) => `${(v / 1e5).toFixed(0)}L`} {...AXIS} width={44} />
          <Tooltip content={<Tip fmt={pkr} />} cursor={{ fill: 'var(--soft)' }} />
          <Bar dataKey="spend" name="Spent" fill={C.spent} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function ProductivityChart({ series }) {
  const data = series.actual.filter((a) => a.productivity !== null).map((a) => ({ date: a.date, productivity: Math.round(a.productivity * 100) }));
  return (
    <ChartCard title="Site productivity" subtitle="Work completed as a percentage of work planned for the same period. 100% means exactly on plan." height={220}
      rows={data} columns={[{ key: 'date', label: 'Date', fmt: dateText }, { key: 'productivity', label: 'Productivity %', num: true }]}>
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="date" tickFormatter={shortDate} {...AXIS} minTickGap={32} />
          <YAxis tickFormatter={(v) => `${v}%`} {...AXIS} width={44} domain={[0, (m) => Math.max(120, m)]} />
          <Tooltip content={<Tip fmt={(v) => `${v}%`} />} cursor={{ stroke: 'var(--axis)' }} />
          <ReferenceLine y={100} stroke="var(--axis)" strokeDasharray="4 4" />
          <Area dataKey="productivity" name="Productivity" stroke={C.earned} fill={C.earned} fillOpacity={0.12} strokeWidth={2} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function PhotoGrid({ media }) {
  if (!media?.length) return <div className="note">No site photos yet.</div>;
  return (
    <div className="photos">
      {media.map((m) => (
        <div className="photo" key={m.id}>
          <AuthImage mediaId={m.id} alt={`Site photo ${dateText(m.date)}`} />
          <div className="cap">{shortDate(m.date)}{m.violations > 0 ? ' · quality issue flagged' : ''}</div>
        </div>
      ))}
    </div>
  );
}
