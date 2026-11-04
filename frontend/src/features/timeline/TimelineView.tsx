import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, Loader2, Network, Search } from 'lucide-react'
import type { WS } from '../../pages/Workspace'
import { api, type CommitInfo } from '../../api'
import { Card, Switch } from '../../ui'
import { date, fmt, label } from '../../lib/format'

export default function TimelineView({ ws }: { ws: WS }) {
  const { temporal, tau, setTau } = ws
  const [q, setQ] = useState('')
  const [codeOnly, setCodeOnly] = useState(true)
  const [info, setInfo] = useState<CommitInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const max = useMemo(() => Math.max(1, ...temporal.commits.map((c) => c.delta)), [temporal])

  const rows = useMemo(() => {
    const s = q.toLowerCase()
    return [...temporal.commits].reverse().filter((c) =>
      (!codeOnly || c.delta > 0 || c.i === 0) && (!s || c.msg.toLowerCase().includes(s) || c.author.toLowerCase().includes(s) || c.sha.startsWith(s)))
  }, [temporal, q, codeOnly])

  useEffect(() => {
    let live = true
    setLoading(true)
    api.commit(ws.repoId, tau).then((x) => { if (live) { setInfo(x); setLoading(false) } }).catch(() => live && setLoading(false))
    return () => { live = false }
  }, [ws.repoId, tau])

  useEffect(() => {
    document.getElementById(`c-${tau}`)?.scrollIntoView({ block: 'nearest' })
  }, [tau])

  return (
    <div className="tl">
      <div className="col" style={{ gap: 12 }}>
        <div className="row wrap" style={{ gap: 12 }}>
          <div className="input-wrap grow" style={{ minWidth: 220 }}>
            <Search size={16} style={{ left: 12 }} />
            <input className="input" style={{ paddingLeft: 36 }} placeholder="Filter by message, author or sha" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Switch checked={codeOnly} onChange={setCodeOnly}>Only commits that touched code</Switch>
          <span className="badge">{fmt(rows.length)} commits</span>
        </div>
        <div className="card tl-list">
          <div className="tl-row" style={{ cursor: 'default', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--ink-2)', borderBottom: 'var(--bw-sm) solid var(--line)', position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 1 }}>
            <span>τ</span><span>SHA</span><span>MESSAGE</span><span className="hide-sm">|Δ| SYMBOLS</span><span>DATE</span>
          </div>
          {rows.map((c) => (
            <div key={c.i} id={`c-${c.i}`} className={`tl-row ${c.i === tau ? 'sel' : ''}`} onClick={() => setTau(c.i)}>
              <span className="mono" style={{ fontWeight: 700 }}>{c.i}</span>
              <span className="mono" style={{ fontSize: 12 }}>{c.sha.slice(0, 7)}</span>
              <span className="col" style={{ gap: 0, minWidth: 0 }}>
                <span className="ellipsis" style={{ fontWeight: 600 }}>{c.i === 0 ? '◆ base snapshot · ' : ''}{c.msg}</span>
                <span className="muted ellipsis" style={{ fontSize: 12 }}>{c.author} · <span style={{ color: 'var(--s6)' }}>+{fmt(c.ins)}</span> <span style={{ color: 'var(--s8)' }}>−{fmt(c.del)}</span></span>
              </span>
              <span className="row hide-sm" style={{ gap: 6 }}>
                <span className="dbar" style={{ width: `${Math.max(3, (Math.log1p(c.delta) / Math.log1p(max)) * 80)}px`, opacity: c.delta ? 1 : 0.2 }} />
                <span className="mono" style={{ fontSize: 11.5 }}>{c.delta}</span>
              </span>
              <span className="muted mono" style={{ fontSize: 11.5 }}>{date(c.ts)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="col" style={{ gap: 16, position: 'sticky', top: 18 }}>
        <Card fill="yellow">
          <div className="row between">
            <span className="eyebrow" style={{ color: '#0a0a0a' }}>Commit c{tau}</span>
            {loading && <Loader2 size={16} className="spin" />}
          </div>
          <h3 className="h3" style={{ margin: '8px 0 6px', lineHeight: 1.2 }}>{temporal.commits[tau].msg}</h3>
          <div className="mono" style={{ fontSize: 12 }}>{temporal.commits[tau].sha.slice(0, 12)} · {temporal.commits[tau].author} · {date(temporal.commits[tau].ts)}</div>
          <div className="row wrap" style={{ gap: 8, marginTop: 12 }}>
            <button className="btn sm" onClick={() => ws.go('graph')}><Network size={14} /> Graph at τ = {tau}</button>
            {info?.url && <a className="btn sm" href={info.url} target="_blank" rel="noreferrer"><ExternalLink size={14} /> GitHub</a>}
          </div>
        </Card>
        {info && (
          <>
            <div className="g2e" style={{ gap: 12 }}>
              <MiniStat n={info.symbols.length} label="symbols in Δ" fill="cyan" />
              <MiniStat n={info.edges_opened.length} label="edges opened" fill="lime" />
              <MiniStat n={info.nodes_born.length} label="symbols born" />
              <MiniStat n={info.edges_closed.length} label="edges closed" fill="pink" />
            </div>
            <Card title="Changed symbols (Δₜ)" className="tight">
              <List items={info.symbols} onPick={(k) => ws.go('graph', k)} empty={tau === 0 ? 'c₀ is the base snapshot: everything is parsed, nothing counts as changed.' : 'No code symbols changed (docs, config or tests outside the parsed set).'} />
            </Card>
            {(info.edges_opened.length > 0 || info.edges_closed.length > 0) && (
              <Card title="Edges opened / closed" className="tight">
                <div className="col" style={{ gap: 2, maxHeight: 260, overflow: 'auto' }}>
                  {info.edges_opened.slice(0, 30).map((e, i) => <EdgeRow key={`o${i}`} e={e} sign="+" />)}
                  {info.edges_closed.slice(0, 30).map((e, i) => <EdgeRow key={`c${i}`} e={e} sign="−" />)}
                </div>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function MiniStat({ n, label: l, fill }: { n: number; label: string; fill?: string }) {
  return (
    <div className={`card tight ${fill ? `fill-${fill}` : ''}`} style={{ padding: '10px 12px' }}>
      <b style={{ fontSize: 26, letterSpacing: '-0.03em' }} className="tnum">{fmt(n)}</b>
      <div style={{ fontSize: 12, fontWeight: 600 }}>{l}</div>
    </div>
  )
}

function List({ items, onPick, empty }: { items: string[]; onPick: (k: string) => void; empty: string }) {
  if (!items.length) return <div className="muted" style={{ fontSize: 13 }}>{empty}</div>
  return (
    <div className="col" style={{ gap: 0, maxHeight: 220, overflow: 'auto' }}>
      {items.slice(0, 60).map((k) => (
        <div key={k} className="nb-row" onClick={() => onPick(k)} title={k}>
          <span className="mono ellipsis grow" style={{ fontWeight: 600 }}>{label(k)}</span>
          <span className="muted ellipsis" style={{ fontSize: 11, maxWidth: 160 }}>{k.split('::')[0]}</span>
        </div>
      ))}
    </div>
  )
}

function EdgeRow({ e, sign }: { e: { src: string; dst: string; type: string }; sign: '+' | '−' }) {
  return (
    <div className="row" style={{ gap: 6, fontSize: 12, padding: '3px 0' }}>
      <span className={`mv ${sign === '+' ? 'up' : 'down'}`}>{sign}</span>
      <span className="mono ellipsis" style={{ maxWidth: 130 }} title={e.src}>{label(e.src)}</span>
      <span className="muted">—{e.type}→</span>
      <span className="mono ellipsis" style={{ maxWidth: 130 }} title={e.dst}>{label(e.dst)}</span>
    </div>
  )
}
