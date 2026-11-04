import { useMemo, useState } from 'react'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Scatter, ScatterChart,
  Tooltip, XAxis, YAxis, ZAxis,
} from 'recharts'
import { ArrowUpRight, Crown, Flame, GitCommitHorizontal, Link2Off, Timer, Users } from 'lucide-react'
import type { WS } from '../../pages/Workspace'
import { Card, ChartTip, Legend, Seg, StatTile, Switch } from '../../ui'
import { compact, date, fmt, label, shortDate, splitKey } from '../../lib/format'
import { EDGE_LABEL, KIND_LABEL, LANG_COLOR, seriesVar } from '../../lib/colors'

const AX = { stroke: 'var(--ink-3)', fontSize: 11, fontFamily: 'var(--mono)' }
const GRID = { stroke: 'var(--grid)', strokeDasharray: '0', vertical: false }

export default function StatsView({ ws }: { ws: WS }) {
  const { stats: s, temporal } = ws
  const k = s.kpis
  const [growthMode, setGrowthMode] = useState<'symbols' | 'edges' | 'churn'>('symbols')
  const [hotMode, setHotMode] = useState<'symbols' | 'files'>('symbols')
  const [withTests, setWithTests] = useState(false)
  const [hiddenMode, setHiddenMode] = useState<'files' | 'symbols'>('files')

  const growth = useMemo(() => s.growth.map((g) => ({ ...g, label: date(g.ts) })), [s.growth])
  const tickIdx = useMemo(() => {
    const n = Math.min(6, growth.length)
    return Array.from({ length: n }, (_, i) => Math.round((i / Math.max(1, n - 1)) * (growth.length - 1)))
  }, [growth])

  const edgeMix = (['calls', 'imports', 'inherits', 'cochange'] as const).map((t, i) => ({ name: EDGE_LABEL[t], value: s.edge_types[t] ?? 0, color: seriesVar([0, 2, 6, 1][i]) }))
  const kindMix = (['class', 'function', 'method', 'file'] as const).map((t) => ({ name: KIND_LABEL[t], value: s.node_kinds[t] ?? 0, color: seriesVar({ class: 6, function: 0, method: 2, file: 3 }[t]) }))

  const hidden = (hiddenMode === 'files' ? s.hidden_coupling.files : s.hidden_coupling.symbols).filter((p) => withTests || !p.aux).slice(0, 7)
  const hotItems = hotMode === 'symbols'
    ? s.hotspots.symbols.map((h) => ({ key: h.key, name: h.name, sub: h.path, v: h.prior, n: h.changes }))
    : s.hotspots.files.map((h) => ({ key: h.key, name: splitKey(h.key).file, sub: splitKey(h.key).dir, v: h.prior, n: h.changes }))
  const hotMax = Math.max(0.001, ...hotItems.map((h) => h.v))

  const comms = s.communities.filter((c) => c.size >= 3).slice(0, 10)
  const commMax = Math.max(1, ...comms.map((c) => c.size))

  const days = useMemo(() => calendar(s.activity.by_day), [s.activity.by_day])
  const punchMax = Math.max(1, ...s.activity.punchcard.map((p) => p.count))
  const punch = useMemo(() => {
    const m = new Map(s.activity.punchcard.map((p) => [`${p.dow}-${p.hour}`, p.count]))
    return m
  }, [s.activity.punchcard])

  const deg = s.degree_distribution.filter((d) => d.degree > 0)
  const langs = Object.entries(ws.github?.languages ?? {}).sort((a, b) => b[1] - a[1])
  const langTotal = langs.reduce((a, [, v]) => a + v, 0) || 1
  const sr = s.lifetimes.survival_rate

  return (
    <div className="stats">
      <div className="kpi-grid">
        <StatTile label="Commits walked" value={k.commits} hint={`${fmt(k.span_days)} days`} fill="yellow" icon={<GitCommitHorizontal size={18} />} />
        <StatTile label="Symbols" value={k.symbols} delta={k.symbols_delta} hint="vs c₀" />
        <StatTile label="Structural edges" value={k.edges} delta={k.edges_delta} hint="calls·imports·inherits" />
        <StatTile label="Co-change pairs" value={k.cochange_pairs} hint={`${fmt(k.cochange_strong)} seen 3+ times`} fill="pink" />
        <StatTile label="Edges opened / closed" value={<>{compact(k.edges_opened)}<span className="muted" style={{ fontSize: 22 }}> / {compact(k.edges_closed)}</span></>} hint="inside the window" fill="cyan" />
        <StatTile label="Communities" value={k.communities} hint={`${fmt(k.contributors)} contributors`} icon={<Users size={18} />} />
      </div>

      <div className="g2">
        <Card title="How the graph grew" sub={growthMode === 'churn' ? 'Edges opened (up) and closed (down) by each commit' : `Live ${growthMode} at every commit τ, stacked by type`}
          actions={<Seg value={growthMode} onChange={setGrowthMode} options={[{ value: 'symbols', label: 'Symbols' }, { value: 'edges', label: 'Edges' }, { value: 'churn', label: 'Churn' }]} />}>
          <div style={{ height: 290 }}>
            <ResponsiveContainer>
              {growthMode === 'churn' ? (
                <BarChart data={growth.map((g) => ({ ...g, died: -g.died }))} stackOffset="sign" barCategoryGap={0}>
                  <CartesianGrid {...GRID} />
                  <XAxis dataKey="t" {...AX} ticks={tickIdx} tickFormatter={(t) => shortDate(growth[t]?.ts ?? 0)} />
                  <YAxis {...AX} width={40} />
                  <Tooltip cursor={{ fill: 'var(--grid)' }} content={({ active, payload }) => active && payload?.length ? (
                    <ChartTip title={`c${payload[0].payload.t} · ${payload[0].payload.label}`} rows={[
                      { label: 'opened', value: fmt(payload[0].payload.born), color: 'var(--s3)' },
                      { label: 'closed', value: fmt(-payload[0].payload.died), color: 'var(--s8)' },
                      { label: '|Δ|', value: fmt(payload[0].payload.delta) },
                    ]} />) : null} />
                  <Bar dataKey="born" stackId="a" fill="var(--s3)" stroke="var(--line)" strokeWidth={0.5} />
                  <Bar dataKey="died" stackId="a" fill="var(--s8)" stroke="var(--line)" strokeWidth={0.5} />
                </BarChart>
              ) : (
                <AreaChart data={growth} onClick={(e) => { const t = (e as { activeLabel?: number })?.activeLabel; if (t != null) { ws.setTau(+t); ws.go('graph') } }}>
                  <CartesianGrid {...GRID} />
                  <XAxis dataKey="t" {...AX} ticks={tickIdx} tickFormatter={(t) => shortDate(growth[t]?.ts ?? 0)} />
                  <YAxis {...AX} width={44} tickFormatter={compact} />
                  <Tooltip cursor={{ stroke: 'var(--ink)', strokeWidth: 2 }} content={({ active, payload }) => active && payload?.length ? (
                    <ChartTip title={`c${payload[0].payload.t} · ${payload[0].payload.label}`} rows={[...payload].reverse().map((p) => ({ label: String(p.name), value: fmt(p.value as number), color: p.color as string }))} />
                  ) : null} />
                  {(growthMode === 'symbols'
                    ? [['n_method', 'methods', 2], ['n_function', 'functions', 0], ['n_class', 'classes', 6]]
                    : [['e_inherits', 'inherits', 6], ['e_imports', 'imports', 2], ['e_calls', 'calls', 0]]
                  ).map(([key, name, slot]) => (
                    <Area key={key as string} type="stepAfter" dataKey={key as string} name={name as string} stackId="1" stroke="var(--line)" strokeWidth={1.5}
                      fill={seriesVar(slot as number)} fillOpacity={0.9} isAnimationActive={false} />
                  ))}
                </AreaChart>
              )}
            </ResponsiveContainer>
          </div>
          <div className="row between wrap" style={{ marginTop: 10 }}>
            <Legend items={growthMode === 'churn'
              ? [{ label: 'opened', color: 'var(--s3)' }, { label: 'closed', color: 'var(--s8)' }]
              : growthMode === 'symbols'
                ? [{ label: 'classes', color: seriesVar(6) }, { label: 'functions', color: seriesVar(0) }, { label: 'methods', color: seriesVar(2) }]
                : [{ label: 'calls', color: seriesVar(0) }, { label: 'imports', color: seriesVar(2) }, { label: 'inherits', color: seriesVar(6) }]} />
            {growthMode !== 'churn' && <span className="muted" style={{ fontSize: 12 }}>Click a point to open the graph at that commit</span>}
          </div>
        </Card>

        <Card title="What the graph is made of" sub="Edges and nodes at the newest commit">
          <div className="g2e" style={{ gap: 8 }}>
            <Donut data={edgeMix} center={compact(edgeMix.reduce((a, d) => a + d.value, 0))} sub="edges" />
            <Donut data={kindMix} center={compact(kindMix.reduce((a, d) => a + d.value, 0))} sub="nodes" />
          </div>
          <div className="col" style={{ gap: 6, marginTop: 6 }}>
            {[...edgeMix, ...kindMix].map((d) => (
              <div key={d.name} className="row between" style={{ fontSize: 13 }}>
                <span className="row" style={{ gap: 7 }}><span className="swatch" style={{ background: d.color }} />{d.name}</span>
                <b className="mono">{fmt(d.value)}</b>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="g2e">
        <Card title={<span className="row" style={{ gap: 8 }}><Link2Off size={19} /> Hidden coupling</span>}
          sub="Always edited together, yet no import, call or inheritance links them. A snapshot graph cannot see this."
          actions={<Seg value={hiddenMode} onChange={setHiddenMode} options={[{ value: 'files', label: 'Files' }, { value: 'symbols', label: 'Symbols' }]} />}>
          <div className="pairs">
            {hidden.length === 0 && <div className="muted">No hidden pairs at this threshold. History and structure agree here.</div>}
            {hidden.map((p) => {
              const a = splitKey(p.a), b = splitKey(p.b)
              return (
                <div key={p.a + p.b} className="pair" style={{ cursor: 'pointer' }} onClick={() => ws.go('graph', p.a)}>
                  <div className="node"><b>{a.sym || a.file}</b><span>{a.sym ? a.path : a.dir || '.'}</span></div>
                  <div className="link"><b>{p.times}×</b></div>
                  <div className="node"><b>{b.sym || b.file}</b><span>{b.sym ? b.path : b.dir || '.'}</span></div>
                </div>
              )
            })}
          </div>
          <div className="row between wrap" style={{ marginTop: 12 }}>
            <Switch checked={withTests} onChange={setWithTests}>Include tests & docs</Switch>
            {k.hidden_share != null && <span className="badge fill-pink">{Math.round(k.hidden_share * 100)}% of cross-file co-change is hidden</span>}
          </div>
        </Card>

        <Card title={<span className="row" style={{ gap: 8 }}><Flame size={19} /> Churn hotspots</span>}
          sub={<>Recency-decayed change prior h(v; τ), λ = {s.params.lambda} commits: the code most likely to change next</>}
          actions={<Seg value={hotMode} onChange={setHotMode} options={[{ value: 'symbols', label: 'Symbols' }, { value: 'files', label: 'Files' }]} />}>
          <div className="col" style={{ gap: 9 }}>
            {hotItems.slice(0, 9).map((h, i) => (
              <div key={h.key} className="hbar" style={{ cursor: 'pointer' }} onClick={() => ws.go('graph', h.key)} title={h.key}>
                <div className="lab">
                  <span className="row between" style={{ gap: 8 }}>
                    <b className="mono ellipsis" style={{ fontSize: 12.5 }}>{h.name}</b>
                    <span className="muted mono ellipsis" style={{ fontSize: 11 }}>{h.sub}</span>
                  </span>
                  <span className="track" style={{ marginTop: 3 }}>
                    <span style={{ width: `${(h.v / hotMax) * 100}%`, background: i < 3 ? 'var(--s2)' : 'var(--orange)' }} />
                  </span>
                </div>
                <span className="num" style={{ fontSize: 12 }}><b>{h.v.toFixed(2)}</b><br /><span className="muted">{h.n}×</span></span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="g2">
        <Card title={<span className="row" style={{ gap: 8 }}><Crown size={19} /> God nodes</span>} sub="Most central symbols by PageRank. Most of the system flows through them.">
          <div className="scroll">
            <table className="tbl">
              <thead><tr><th>#</th><th>Symbol</th><th>Community</th><th className="num">Callers</th><th className="num">Degree</th><th className="num">h(v)</th></tr></thead>
              <tbody>
                {s.god_nodes.slice(0, 10).map((g, i) => (
                  <tr key={g.key} className="click" onClick={() => ws.go('graph', g.key)}>
                    <td className="mono" style={{ fontWeight: 700 }}>{i + 1}</td>
                    <td>
                      <div className="mono" style={{ fontWeight: 700, fontSize: 12.5 }}>{g.qual || g.name}</div>
                      <div className="muted" style={{ fontSize: 11.5 }}>{KIND_LABEL[g.kind]} · {g.path}</div>
                    </td>
                    <td><span className="row" style={{ gap: 6, fontSize: 12 }}><span className="swatch" style={{ background: seriesVar(g.community) }} /><span className="ellipsis" style={{ maxWidth: 140 }}>{s.communities[g.community]?.label}</span></span></td>
                    <td className="num">{g.callers}</td>
                    <td className="num">{g.degree}</td>
                    <td className="num">{g.prior.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Communities" sub="Louvain over structure and co-change on the union graph, so colours stay stable through time">
          <div className="col" style={{ gap: 9 }}>
            {comms.map((c) => (
              <div key={c.id} className="hbar" title={c.top.map(label).join(', ')}>
                <div className="lab">
                  <span className="row between" style={{ gap: 8 }}>
                    <span className="row" style={{ gap: 6, minWidth: 0 }}><span className="swatch" style={{ background: seriesVar(c.id) }} /><b className="ellipsis" style={{ fontSize: 12.5 }}>{c.label}</b></span>
                    <span className="muted mono" style={{ fontSize: 11 }}>{c.files} files</span>
                  </span>
                  <span className="track" style={{ marginTop: 3 }}><span style={{ width: `${(c.size / commMax) * 100}%`, background: seriesVar(c.id) }} /></span>
                </div>
                <span className="num" style={{ fontSize: 12.5 }}><b>{c.size}</b></span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="g3">
        <Card title={<span className="row" style={{ gap: 8 }}><Timer size={19} /> How long do edges live?</span>}
          sub={sr != null ? `${Math.round(sr * 100)}% of the ${fmt(s.lifetimes.born_in_window)} edges born in the window are still alive` : 'Lifetimes in commits'}>
          <div style={{ height: 210 }}>
            <ResponsiveContainer>
              <BarChart data={s.lifetimes.histogram} barCategoryGap="18%">
                <CartesianGrid {...GRID} />
                <XAxis dataKey="bucket" {...AX} interval={0} fontSize={10} />
                <YAxis {...AX} width={34} />
                <Tooltip cursor={{ fill: 'var(--grid)' }} content={({ active, payload }) => active && payload?.length ? (
                  <ChartTip title={`${payload[0].payload.bucket} commits`} rows={[
                    { label: 'closed', value: fmt(payload[0].payload.closed), color: 'var(--s8)' },
                    { label: 'still open', value: fmt(payload[0].payload.open), color: 'var(--s1)' }]} />) : null} />
                <Bar dataKey="closed" stackId="l" fill="var(--s8)" stroke="var(--line)" strokeWidth={1.5} />
                <Bar dataKey="open" stackId="l" fill="var(--s1)" stroke="var(--line)" strokeWidth={1.5} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <Legend items={[{ label: 'closed', color: 'var(--s8)' }, { label: 'still open (censored)', color: 'var(--s1)' }]} />
        </Card>

        <Card title="Degree distribution" sub="Symbols by number of structural edges (log–log). A heavy tail means a few hubs.">
          <div style={{ height: 230 }}>
            <ResponsiveContainer>
              <ScatterChart margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="var(--grid)" />
                <XAxis dataKey="degree" type="number" scale="log" domain={[1, 'auto']} {...AX} allowDataOverflow tickFormatter={compact} name="degree" />
                <YAxis dataKey="count" type="number" scale="log" domain={[1, 'auto']} {...AX} width={36} tickFormatter={compact} name="symbols" />
                <ZAxis range={[70, 70]} />
                <Tooltip cursor={false} content={({ active, payload }) => active && payload?.length ? (
                  <ChartTip rows={[{ label: 'degree', value: fmt(payload[0].payload.degree) }, { label: 'symbols', value: fmt(payload[0].payload.count) }]} />) : null} />
                <Scatter data={deg} fill="var(--s7)" stroke="var(--line)" strokeWidth={1.5} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title="Biggest commits" sub="By symbols touched, |Δₜ|. Click one to jump the graph there.">
          <div className="col" style={{ gap: 4 }}>
            {s.biggest_commits.slice(0, 7).map((b) => (
              <div key={b.sha} className="nb-row" onClick={() => { ws.setTau(b.t); ws.go('graph') }}>
                <span className="badge fill-orange" style={{ minWidth: 46, justifyContent: 'center' }}>{b.delta}</span>
                <span className="grow ellipsis" title={b.msg}>{b.msg}</span>
                <ArrowUpRight size={14} />
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="g2">
        <Card title="Commit activity" sub={`${fmt(k.commits)} commits on the first-parent chain, by day`}>
          <div className="cal" aria-label="Commit calendar heatmap">
            {days.map((d) => (
              <span key={d.day} title={`${d.day}: ${d.n} commit${d.n === 1 ? '' : 's'}`}
                style={{ background: d.n < 0 ? 'transparent' : d.n === 0 ? 'var(--surface-3)' : ['', '#86b6ef', '#3987e5', '#256abf', '#0d366b'][Math.min(4, d.n)], borderColor: d.n < 0 ? 'transparent' : undefined }} />
            ))}
          </div>
          <div className="row between muted" style={{ fontSize: 11.5, marginTop: 6 }}>
            <span>{date(k.first_ts)}</span>
            <span className="row" style={{ gap: 4 }}>less {['var(--surface-3)', '#86b6ef', '#3987e5', '#256abf', '#0d366b'].map((c) => <span key={c} className="swatch" style={{ background: c, width: 11, height: 11 }} />)} more</span>
            <span>{date(k.last_ts)}</span>
          </div>
          <div className="sec-title eyebrow" style={{ margin: '18px 0 8px' }}>When commits land (UTC)</div>
          <div className="punch">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((dn, dow) => (
              <div key={dn} style={{ display: 'contents' }}>
                <span className="muted">{dn}</span>
                {Array.from({ length: 24 }, (_, h) => {
                  const n = punch.get(`${dow}-${h}`) ?? 0
                  const r = n ? 3 + (Math.sqrt(n / punchMax) * 9) : 0
                  return <span key={h} className="dot" title={`${dn} ${h}:00, ${n}`}>{n > 0 && <i style={{ width: r, height: r }} />}</span>
                })}
              </div>
            ))}
            <span />
            {Array.from({ length: 24 }, (_, h) => <span key={h} className="muted" style={{ textAlign: 'center' }}>{h % 6 === 0 ? h : ''}</span>)}
          </div>
        </Card>

        <Card title="People & languages" sub="From the walk and the GitHub API">
          {langs.length > 0 && (
            <>
              <div className="langbar" style={{ height: 18, marginBottom: 8 }}>
                {langs.map(([l, v]) => <span key={l} title={`${l} ${Math.round((v / langTotal) * 100)}%`} style={{ width: `${(v / langTotal) * 100}%`, background: LANG_COLOR[l] ?? 'var(--s-other)' }} />)}
              </div>
              <div className="row wrap" style={{ gap: 10, fontSize: 12, marginBottom: 14 }}>
                {langs.slice(0, 6).map(([l, v]) => <span key={l} className="row" style={{ gap: 5 }}><span className="swatch" style={{ background: LANG_COLOR[l] ?? 'var(--s-other)' }} />{l} <b className="mono">{v / langTotal < 0.01 ? '<1' : Math.round((v / langTotal) * 100)}%</b></span>)}
              </div>
            </>
          )}
          <div className="scroll"><table className="tbl">
            <thead><tr><th>Author</th><th className="num">Commits</th><th className="num">+/−</th><th className="num">Symbols</th></tr></thead>
            <tbody>
              {s.contributors.slice(0, 8).map((c) => {
                const noreply = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/.exec(c.email)?.[1]?.toLowerCase()
                const av = ws.github?.contributors?.find((g) => g.login.toLowerCase() === noreply || g.login.toLowerCase() === c.name.toLowerCase().replace(/\s/g, ''))
                const initials = c.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()
                return (
                  <tr key={c.name}>
                    <td><span className="row" style={{ gap: 8 }}>
                      {av ? <img src={av.avatar} alt="" style={{ width: 22, height: 22, borderRadius: 5, border: '1.5px solid var(--line)' }} /> : <span className="swatch" style={{ width: 22, height: 22, borderRadius: 5, background: 'var(--yellow)', color: '#0a0a0a', fontSize: 9.5, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>{initials}</span>}
                      <span className="ellipsis" style={{ maxWidth: 170, fontWeight: 600 }}>{c.name}</span></span></td>
                    <td className="num">{c.commits}</td>
                    <td className="num" style={{ fontSize: 11.5 }}><span style={{ color: 'var(--s6)' }}>+{compact(c.insertions)}</span> <span style={{ color: 'var(--s8)' }}>−{compact(c.deletions)}</span></td>
                    <td className="num">{fmt(c.symbols)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table></div>
        </Card>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>Window {date(temporal.commits[0].ts)} → {date(temporal.commits[temporal.T - 1].ts)}. All history signals use only ancestors of τ.</div>
    </div>
  )
}

function Donut({ data, center, sub }: { data: { name: string; value: number; color: string }[]; center: string; sub: string }) {
  return (
    <div style={{ height: 170, position: 'relative' }}>
      <ResponsiveContainer>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="92%" stroke="var(--line)" strokeWidth={2} paddingAngle={1.5} isAnimationActive={false}>
            {data.map((d) => <Cell key={d.name} fill={d.color} />)}
          </Pie>
          <Tooltip content={({ active, payload }) => active && payload?.length ? (
            <ChartTip rows={[{ label: String(payload[0].name), value: fmt(payload[0].value as number), color: (payload[0].payload as { color: string }).color }]} />) : null} />
        </PieChart>
      </ResponsiveContainer>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
        <b style={{ fontSize: 22, letterSpacing: '-0.03em' }}>{center}</b>
        <span className="muted" style={{ fontSize: 11.5 }}>{sub}</span>
      </div>
    </div>
  )
}

/** Week-column calendar covering the last ≤ 53 weeks that have commits. */
function calendar(byDay: Record<string, number>) {
  const keys = Object.keys(byDay).sort()
  if (!keys.length) return []
  const end = new Date(keys[keys.length - 1] + 'T00:00:00Z')
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - 7 * 52)
  const first = new Date(keys[0] + 'T00:00:00Z')
  const from = first > start ? first : start
  const d = new Date(from)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)) // back to Monday
  const out: { day: string; n: number }[] = []
  while (d <= end) {
    const key = d.toISOString().slice(0, 10)
    out.push({ day: key, n: d < from ? -1 : byDay[key] ?? 0 })
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out
}
