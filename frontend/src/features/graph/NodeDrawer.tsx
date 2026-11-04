import { useEffect, useState } from 'react'
import { ExternalLink, Flame, GitCommitHorizontal, GitFork, Loader2, Route, X } from 'lucide-react'
import { api, type SymbolInfo } from '../../api'
import { Spark } from '../../ui'
import { date, fmt, label, splitKey } from '../../lib/format'
import { KIND_LABEL, KIND_SLOT, seriesVar } from '../../lib/colors'
import type { WS } from '../../pages/Workspace'

const GROUPS: { id: string; dir: 'out' | 'in'; type: string; title: string }[] = [
  { id: 'calls-out', dir: 'out', type: 'calls', title: 'Calls' },
  { id: 'calls-in', dir: 'in', type: 'calls', title: 'Called by' },
  { id: 'inherits-out', dir: 'out', type: 'inherits', title: 'Inherits from' },
  { id: 'inherits-in', dir: 'in', type: 'inherits', title: 'Subclassed by' },
  { id: 'imports-out', dir: 'out', type: 'imports', title: 'Imports' },
  { id: 'imports-in', dir: 'in', type: 'imports', title: 'Imported by' },
  { id: 'contains-out', dir: 'out', type: 'contains', title: 'Contains' },
]

export default function NodeDrawer({ ws, nodeKey, onClose, onPick, onFlow, onPath, onHoverKey }: {
  ws: WS; nodeKey: string; onClose: () => void; onPick: (k: string) => void
  onFlow?: (k: string) => void; onPath?: (k: string) => void; onHoverKey?: (k: string | null) => void
}) {
  const hov = (k: string) => ({ onMouseEnter: () => onHoverKey?.(k), onMouseLeave: () => onHoverKey?.(null) })
  const [info, setInfo] = useState<SymbolInfo | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const { tau } = ws
  useEffect(() => {
    let live = true
    setErr(null)
    const t = setTimeout(() => {
      api.symbol(ws.repoId, nodeKey, tau).then((x) => live && setInfo(x)).catch((e) => live && setErr((e as Error).message))
    }, 120)
    return () => { live = false; clearTimeout(t) }
  }, [ws.repoId, nodeKey, tau])

  const k = splitKey(nodeKey)
  const comm = info ? ws.temporal.communities.find((c) => c.id === info.community) : null
  const kind = info?.kind ?? 'function'
  const gh = ws.temporal.repo.kind === 'github' ? `https://github.com/${ws.temporal.repo.owner}/${ws.temporal.repo.repo}` : null

  return (
    <aside className="drawer card" aria-label="Symbol details">
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <span className="badge" style={{ background: seriesVar(KIND_SLOT[kind]), color: kind === 'file' ? '#0a0a0a' : '#fff' }}>{KIND_LABEL[kind]}</span>
          <h2 className="mono" style={{ fontSize: 21, marginTop: 8, wordBreak: 'break-all' }}>{k.sym || k.file}</h2>
          <div className="muted mono" style={{ fontSize: 12, marginTop: 4, wordBreak: 'break-all' }}>
            {k.path}{info ? `:${info.start}–${info.end}` : ''}
          </div>
        </div>
        <button className="btn sm icon" onClick={onClose} aria-label="Close details"><X size={15} /></button>
      </div>

      {err && <div className="err">{err}</div>}
      {(onFlow || onPath) && (
        <div className="row" style={{ gap: 8 }}>
          {onFlow && <button className="btn sm cyan grow" onClick={() => onFlow(nodeKey)} title="Who uses it, and what it uses, as a left-to-right chart"><GitFork size={14} /> Dependency flow</button>}
          {onPath && <button className="btn sm grow" onClick={() => onPath(nodeKey)} title="Shortest connection from this symbol to another"><Route size={14} /> Find path to…</button>}
        </div>
      )}
      {!info ? (
        <div className="row muted"><Loader2 size={16} className="spin" /> loading history…</div>
      ) : (
        <>
          {comm && (
            <div className="row" style={{ gap: 8, fontSize: 13 }}>
              <span className="swatch" style={{ background: seriesVar(comm.id) }} />
              <span>Community <b>{comm.label}</b></span>
            </div>
          )}
          <div className="g2e" style={{ gap: 10 }}>
            <div className="card tight flat fill-yellow">
              <div className="eyebrow" style={{ fontSize: 10 }}>Change prior h(v; τ)</div>
              <div className="row between">
                <b style={{ fontSize: 24 }} className="tnum">{fmt(info.prior, 2)}</b>
                <Flame size={20} />
              </div>
              <Spark data={info.prior_series.map((p) => p.h)} width={130} height={28} fill="rgba(10,10,10,0.15)" color="#0a0a0a" />
            </div>
            <div className="card tight flat">
              <div className="eyebrow" style={{ fontSize: 10 }}>Changes in window</div>
              <b style={{ fontSize: 24 }} className="tnum">{fmt(info.changes)}</b>
              <div className="muted" style={{ fontSize: 12 }}>PageRank {(info.pagerank * 1000).toFixed(2)}‰</div>
              <div className="muted" style={{ fontSize: 12 }}>{info.in.filter((e) => e.type === 'calls').length} callers at τ</div>
            </div>
          </div>

          <div>
            <div className="sec-title">Lifetime [b, d)</div>
            <div className="life">
              {info.intervals.map(([s, f], i) => (
                <span key={i} style={{ left: `${(s / info.T) * 100}%`, width: `${Math.max(0.6, ((f - s) / info.T) * 100)}%` }} />
              ))}
              <i className="now" style={{ left: `calc(${((tau + 0.5) / info.T) * 100}% - 1.5px)` }} />
            </div>
            <div className="row between muted mono" style={{ fontSize: 11, marginTop: 4 }}>
              <span>c{info.intervals[0][0]}</span>
              <span>{info.intervals.map(([s, f]) => `[${s}, ${f >= info.T ? '∞' : f})`).join(' ')}</span>
            </div>
          </div>

          {info.sig && <pre className="code" style={{ whiteSpace: 'pre-wrap' }}>{info.sig}</pre>}
          {info.doc && <p className="muted" style={{ margin: 0, fontSize: 13 }}>{info.doc}</p>}

          {info.cochange.length > 0 && (
            <div>
              <div className="sec-title">Co-change partners (history only)</div>
              {info.cochange.slice(0, 8).map((p) => (
                <div key={p.key} className="nb-row" onClick={() => onPick(p.key)} {...hov(p.key)}>
                  <span className="swatch" style={{ background: 'var(--s2)' }} />
                  <span className="mono grow ellipsis" title={p.key}>{label(p.key)}</span>
                  <span className="muted mono" style={{ fontSize: 11 }}>{p.times}× · w {p.weight}</span>
                </div>
              ))}
            </div>
          )}

          {GROUPS.map((g) => {
            const items = (g.dir === 'out' ? info.out : info.in).filter((e) => e.type === g.type)
            if (!items.length) return null
            return (
              <div key={g.id}>
                <div className="sec-title">{g.title} · {items.length}</div>
                {items.slice(0, 10).map((e) => (
                  <div key={e.other} className="nb-row" onClick={() => onPick(e.other)} title={e.other} {...hov(e.other)}>
                    <span className="mono grow ellipsis">{label(e.other)}</span>
                    <span className="muted mono" style={{ fontSize: 11 }}>since c{e.s}{e.weight < 1 ? ` · 1/${Math.round(1 / e.weight)}` : ''}</span>
                  </div>
                ))}
                {items.length > 10 && <div className="muted" style={{ fontSize: 12 }}>+{items.length - 10} more</div>}
              </div>
            )
          })}

          {info.code && (
            <div>
              <div className="sec-title">Source at τ = {tau}</div>
              <pre className="code" style={{ maxHeight: 280 }}>{info.code}</pre>
            </div>
          )}

          <div>
            <div className="sec-title">Commits that touched it</div>
            {info.history.length === 0 && <div className="muted" style={{ fontSize: 13 }}>Untouched since the window began.</div>}
            {info.history.slice(0, 14).map((h) => (
              <div key={`${h.t}-${h.key ?? ''}`} className="nb-row" onClick={() => ws.setTau(h.t)}>
                <GitCommitHorizontal size={15} />
                <span className="mono" style={{ fontSize: 11.5, fontWeight: 700 }}>{h.sha.slice(0, 7)}</span>
                <span className="grow ellipsis" title={h.msg}>{h.msg}</span>
                <span className="muted mono" style={{ fontSize: 11 }}>{date(h.ts)}</span>
              </div>
            ))}
          </div>
          {gh && (
            <a className="btn sm" href={`${gh}/blob/${ws.temporal.commits[tau].sha}/${info.path}#L${info.start}-L${info.end}`} target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> View on GitHub at τ
            </a>
          )}
        </>
      )}
    </aside>
  )
}
