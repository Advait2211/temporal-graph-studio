import { useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import { ArrowDown, ArrowUp, Copy, Loader2, Play, Sparkles, Wand2 } from 'lucide-react'
import type { WS } from '../../pages/Workspace'
import { api, type RetrieveResult } from '../../api'
import { Card, Seg, StatTile } from '../../ui'
import { pickNode } from '../graph/pick'
import { date, fmt, label, splitKey } from '../../lib/format'
import { useCssVars } from '../../lib/theme'
import { SERIES } from '../../lib/colors'

const BUDGETS = [1000, 2000, 4000, 8000, 16000]
const PARAMS: { key: string; label: string; min: number; max: number; step: number; hint: string }[] = [
  { key: 'alpha_calls', label: 'α calls', min: 0, max: 2, step: 0.1, hint: 'weight of call edges' },
  { key: 'alpha_imports', label: 'α imports', min: 0, max: 2, step: 0.1, hint: 'file-level imports' },
  { key: 'alpha_inherits', label: 'α inherits', min: 0, max: 2, step: 0.1, hint: 'class hierarchy' },
  { key: 'alpha_cochange', label: 'α co-change', min: 0, max: 3, step: 0.1, hint: 'history edges (0 = static)' },
  { key: 'beta', label: 'β change prior', min: 0, max: 3, step: 0.1, hint: 'p(v) ∝ p₀(v)(1 + β·h)' },
  { key: 'delta', label: 'δ damping', min: 0.3, max: 0.95, step: 0.05, hint: 'walk vs. teleport to seeds' },
]
const DEFAULTS: Record<string, number> = { alpha_calls: 1, alpha_imports: 0.4, alpha_inherits: 0.8, alpha_cochange: 1.2, beta: 0.8, delta: 0.8 }

export default function RetrieveView({ ws }: { ws: WS }) {
  const { temporal, stats } = ws
  const T = temporal.T
  const examples = useMemo(() => {
    const hot = stats.hotspots.symbols[0]
    const god = stats.god_nodes[0]
    const hid = stats.hidden_coupling.files.find((h) => !h.aux)
    const out: string[] = []
    if (hot) out.push(`After the latest release, \`${hot.name}\` behaves differently and raises an exception in some cases. Where should we fix this?`)
    if (god) out.push(`Calling ${god.name}() with a custom configuration ignores the user's settings. Expected the override to be respected.`)
    if (hid) out.push(`Changing behaviour in ${splitKey(hid.a).file} breaks ${splitKey(hid.b).file} even though neither imports the other.`)
    out.push('Traceback (most recent call last):\n  File "' + (stats.hotspots.symbols[1]?.path ?? 'src/app.py') + '", line 42, in handler\nKeyError: missing key')
    return out
  }, [stats])

  const [issue, setIssue] = useState(examples[0] ?? '')
  const [tau, setTau] = useState(ws.tau)
  const [budget, setBudget] = useState(4000)
  const [params, setParams] = useState<Record<string, number>>(DEFAULTS)
  const [res, setRes] = useState<RetrieveResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  async function run() {
    setBusy(true); setErr(null)
    try {
      setRes(await api.retrieve(ws.repoId, { issue, tau, budget, params }))
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  useEffect(() => { if (issue) run() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const c = temporal.commits[tau]
  return (
    <div className="rv">
      <div className="col" style={{ gap: 16 }}>
        <Card title="Issue" sub="Paste an issue, a question or a stack trace">
          <textarea className="textarea" rows={7} value={issue} onChange={(e) => setIssue(e.target.value)} placeholder="Describe the bug…" />
          <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
            <Wand2 size={14} />
            {examples.map((ex, i) => <button key={i} className="chip" style={{ height: 28, fontSize: 12 }} onClick={() => setIssue(ex)}>Example {i + 1}</button>)}
          </div>
        </Card>

        <Card title="As of commit τ" sub="The graph, the co-change weights and the prior use only ancestors of τ">
          <input className="range" type="range" min={0} max={T - 1} value={tau} onChange={(e) => setTau(+e.target.value)} aria-label="As-of commit" />
          <div className="row between" style={{ fontSize: 12.5, marginTop: 8, gap: 8 }}>
            <span className="mono" style={{ fontWeight: 700 }}>c{tau} · {c.sha.slice(0, 7)}</span>
            <span className="muted">{date(c.ts)}</span>
          </div>
          <div className="ellipsis muted" style={{ fontSize: 12.5 }} title={c.msg}>{c.msg}</div>
        </Card>

        <Card title="Budget & weights">
          <div className="col" style={{ gap: 14 }}>
            <div className="col" style={{ gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Token budget B</span>
              <Seg value={String(budget)} onChange={(v) => setBudget(+v)} options={BUDGETS.map((b) => ({ value: String(b), label: `${b / 1000}k` }))} />
            </div>
            {PARAMS.map((p) => (
              <div key={p.key} className="param" title={p.hint}>
                <span style={{ fontWeight: 600 }}>{p.label} <span className="muted" style={{ fontWeight: 400, fontSize: 11.5 }}>{p.hint}</span></span>
                <span className="v">{params[p.key].toFixed(2)}</span>
                <input className="range" type="range" min={p.min} max={p.max} step={p.step} value={params[p.key]} onChange={(e) => setParams({ ...params, [p.key]: +e.target.value })} aria-label={p.label} />
              </div>
            ))}
            <div className="row" style={{ gap: 8 }}>
              <button className="btn primary grow" onClick={run} disabled={busy || !issue.trim()}>
                {busy ? <Loader2 size={17} className="spin" /> : <Play size={17} />} Retrieve context
              </button>
              <button className="btn" onClick={() => setParams(DEFAULTS)}>Reset</button>
            </div>
          </div>
        </Card>
      </div>

      <div className="col" style={{ gap: 16, minWidth: 0 }}>
        {err && <div className="err">{err}</div>}
        {!res ? (
          <Card><div className="row muted" style={{ padding: 30, justifyContent: 'center' }}>{busy ? <><Loader2 className="spin" /> Ranking…</> : 'Run a query to see the ranked context.'}</div></Card>
        ) : (
          <>
            <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
              <StatTile label="Seeds" value={res.summary.seed_count} hint="identifier · path · frame · BM25" fill="yellow" />
              <StatTile label="Graph at τ" value={res.summary.graph_nodes} hint={`${fmt(res.summary.graph_edges)} edges · ${fmt(res.summary.cochange_edges)} co-change`} />
              <StatTile label="Top-10 shared w/ static" value={`${res.summary.top10_overlap_with_static}/10`} hint="what history changed" fill="pink" />
              <StatTile label="Tokens packed" value={res.tokens.used} hint={`of ${fmt(res.budget)}`} fill="cyan" />
            </div>

            <Card title="Packed context" sub={`Full bodies until ρ·B, then signatures only. Ordered by rank so the best code comes first.`}
              actions={<button className="btn sm" onClick={() => navigator.clipboard?.writeText(res.packed.map((p) => p.text).join('\n\n'))}><Copy size={14} /> Copy</button>}>
              <div className="tokbar" role="img" aria-label={`${res.tokens.body} body tokens, ${res.tokens.signature} signature tokens of ${res.budget}`}>
                <span style={{ width: `${(res.tokens.body / res.budget) * 100}%`, background: 'var(--s1)' }} />
                <span style={{ width: `${(res.tokens.signature / res.budget) * 100}%`, background: 'var(--s4)' }} />
              </div>
              <div className="row between" style={{ fontSize: 12, marginTop: 6 }}>
                <span className="row" style={{ gap: 12 }}>
                  <span className="row" style={{ gap: 5 }}><span className="swatch" style={{ background: 'var(--s1)' }} /> bodies {fmt(res.tokens.body)}</span>
                  <span className="row" style={{ gap: 5 }}><span className="swatch" style={{ background: 'var(--s4)' }} /> signatures {fmt(res.tokens.signature)}</span>
                </span>
                <span className="muted mono">{res.packed.length} units · B = {fmt(res.budget)}</span>
              </div>
              <div className="col" style={{ gap: 6, marginTop: 12, maxHeight: 340, overflow: 'auto' }}>
                {res.packed.map((p, i) => (
                  <div key={p.key}>
                    <button className="nb-row" style={{ width: '100%', background: 'none', border: 0, borderBottom: '1.5px dashed var(--grid)', textAlign: 'left' }} onClick={() => setOpen(open === p.key ? null : p.key)}>
                      <span className="mono muted" style={{ width: 24 }}>{i + 1}</span>
                      <span className={`mv ${p.mode === 'body' ? 'up' : 'new'}`}>{p.mode === 'body' ? 'body' : 'sig'}</span>
                      <span className="mono grow ellipsis" style={{ fontWeight: 700 }}>{label(p.key)}</span>
                      <span className="muted mono" style={{ fontSize: 11 }}>{p.tokens} tok</span>
                    </button>
                    {open === p.key && <pre className="code" style={{ maxHeight: 260, marginTop: 6 }}>{p.text}</pre>}
                  </div>
                ))}
              </div>
            </Card>

            <div className="g2e">
              <Card title={<span className="row" style={{ gap: 8 }}><Sparkles size={18} /> TCG ranking</span>} sub="Time-aware PPR with co-change edges and the change prior. Arrows show movement vs static.">
                {res.ranking.slice(0, 15).map((r) => (
                  <div key={r.key} className="rank-row" title={r.key}>
                    <span className="r">{r.rank}</span>
                    <span className="col" style={{ gap: 1, minWidth: 0 }}>
                      <span className="mono ellipsis" style={{ fontWeight: 700 }}>{r.name}</span>
                      <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                        <span className="muted ellipsis" style={{ fontSize: 11, maxWidth: 170 }}>{r.qual.includes('.') ? `${r.qual.split('.').slice(0, -1).join('.')} · ` : ''}{r.path.split('/').pop()}</span>
                        {r.seed.map((s) => <span key={s.reason} className="badge" style={{ height: 18, fontSize: 9.5, padding: '0 5px' }}>{s.reason}</span>)}
                      </span>
                    </span>
                    <Moved m={r.moved} />
                    <span className="num" style={{ fontSize: 11 }}>{(r.score * 100).toFixed(2)}</span>
                  </div>
                ))}
              </Card>
              <Card title="Static-only ablation" sub="Same seeds and graph, α co-change = β = 0. That is the snapshot baseline.">
                {res.static_ranking.slice(0, 15).map((r) => (
                  <div key={r.key} className="rank-row" title={r.key} style={{ gridTemplateColumns: '34px minmax(0, 1fr) 64px' }}>
                    <span className="r">{r.rank}</span>
                    <span className="col" style={{ gap: 1, minWidth: 0 }}>
                      <span className="mono ellipsis" style={{ fontWeight: 700 }}>{r.name}</span>
                      <span className="muted ellipsis" style={{ fontSize: 11 }}>{r.path}</span>
                    </span>
                    <span className="num muted" style={{ fontSize: 11 }}>TCG #{r.full_rank}</span>
                  </div>
                ))}
              </Card>
            </div>

            <div className="g2e">
              <Card title="Neighbourhood of the answer" sub="Top-ranked symbols and seeds. Size = PPR score, ringed = seed, orange = co-change.">
                <MiniGraph res={res} onPick={(k) => ws.go('graph', k)} />
              </Card>
              <Card title="Seeds" sub="Where the walk starts: p(v) ∝ p₀(v)·(1 + β h(v; τ))">
                <div className="col" style={{ gap: 0, maxHeight: 330, overflow: 'auto' }}>
                  {res.seeds.slice(0, 16).map((s) => (
                    <div key={s.key} className="nb-row" onClick={() => ws.go('graph', s.key)} title={s.key}>
                      <span className="mono grow ellipsis" style={{ fontWeight: 600 }}>{label(s.key)}</span>
                      {s.reasons.map((r) => <span key={r} className={`badge ${r === 'identifier' ? 'fill-yellow' : r === 'bm25' ? 'fill-cyan' : r === 'stack frame' ? 'fill-pink' : 'fill-lime'}`} style={{ height: 20, fontSize: 10 }}>{r}</span>)}
                      <span className="mono muted" style={{ fontSize: 11, width: 40, textAlign: 'right' }}>{s.weight.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Moved({ m }: { m: number | null }) {
  if (m == null) return <span className="mv new">new</span>
  if (m === 0) return <span className="mono muted" style={{ fontSize: 12, textAlign: 'center' }}>=</span>
  return m > 0
    ? <span className="mv up row" style={{ gap: 2 }}><ArrowUp size={11} strokeWidth={3} />{m}</span>
    : <span className="mv down row" style={{ gap: 2 }}><ArrowDown size={11} strokeWidth={3} />{-m}</span>
}

type MN = { id: string; name: string; score: number; seed: boolean; community: number; x?: number; y?: number }
function MiniGraph({ res, onPick }: { res: RetrieveResult; onPick: (k: string) => void }) {
  const C = useCssVars(['ink', 'line', 'surface', 'yellow', 's2', 's-other', 'shadow-c', ...SERIES] as const)
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(400)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  const data = useMemo(() => ({ nodes: res.subgraph.nodes.map((n) => ({ ...n })), links: res.subgraph.links.map((l) => ({ ...l })) }), [res])
  const max = Math.max(...res.subgraph.nodes.map((n) => n.score), 1e-6)
  const labelled = useMemo(() => new Set([...res.subgraph.nodes].sort((a, b) => b.score - a.score).slice(0, 8).map((n) => n.id)), [res])
  const fgRef = useRef<{
    zoomToFit: (ms?: number, px?: number) => void
    d3Force: (n: string) => { strength?: (v: number) => void } | undefined
    screen2GraphCoords: (x: number, y: number) => { x: number; y: number }
    zoom: () => number
  } | undefined>(undefined)
  const radius = (n: MN) => 3 + Math.sqrt(n.score / max) * 11
  const pickAt = (e: React.MouseEvent) =>
    e.target instanceof HTMLCanvasElement ? pickNode(fgRef.current, e.target, e.clientX, e.clientY, data.nodes as MN[], (n) => radius(n) + 2) : null
  useEffect(() => { fgRef.current?.d3Force('charge')?.strength?.(-160) }, [data])
  return (
    <div ref={ref} onClick={(e) => { const n = pickAt(e); if (n) onPick(n.id) }}
      onPointerMove={(e) => { if (e.target instanceof HTMLCanvasElement) e.target.style.cursor = pickAt(e) ? 'pointer' : 'grab' }}
      style={{ height: 320, border: 'var(--bw-sm) solid var(--line)', borderRadius: 8, overflow: 'hidden', backgroundImage: 'radial-gradient(var(--bg-dot) 1.2px, transparent 1.2px)', backgroundSize: '18px 18px' }}>
      <ForceGraph2D
        ref={fgRef as never}
        graphData={data}
        width={w}
        height={316}
        backgroundColor="rgba(0,0,0,0)"
        cooldownTicks={80}
        linkColor={(l: { type?: string }) => (l.type === 'cochange' ? C.s2 : C.ink)}
        linkWidth={(l: { type?: string }) => (l.type === 'cochange' ? 3 : 1)}
        linkCurvature={(l: { type?: string }) => (l.type === 'cochange' ? 0.25 : 0)}
        linkDirectionalArrowLength={(l: { type?: string }) => (l.type === 'calls' ? 3 : 0)}
        linkDirectionalArrowRelPos={0.9}
        enablePointerInteraction={false}
        enableNodeDrag={false}
        nodeCanvasObject={(n: MN, ctx: CanvasRenderingContext2D, scale: number) => {
          const r = radius(n)
          const x = n.x ?? 0, y = n.y ?? 0
          ctx.beginPath(); ctx.arc(x + 1.5, y + 1.5, r, 0, 2 * Math.PI); ctx.fillStyle = C['shadow-c']; ctx.fill()
          if (n.seed) { ctx.beginPath(); ctx.arc(x, y, r + 3.5, 0, 2 * Math.PI); ctx.fillStyle = C.yellow; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = C.line; ctx.stroke() }
          ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI)
          ctx.fillStyle = n.community >= 0 && n.community < 8 ? C[SERIES[n.community]] : C['s-other']
          ctx.fill(); ctx.lineWidth = 1.4; ctx.strokeStyle = C.line; ctx.stroke()
          if (labelled.has(n.id) || scale > 2.2) {
            const fs = 11 / scale
            ctx.font = `700 ${fs}px "JetBrains Mono", monospace`
            ctx.fillStyle = C.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'top'
            ctx.fillText(n.name, x, y + r + 2)
          }
        }}
        nodePointerAreaPaint={(n: MN, color: string, ctx: CanvasRenderingContext2D) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(n.x ?? 0, n.y ?? 0, 12, 0, 2 * Math.PI); ctx.fill() }}
        onEngineStop={() => fgRef.current?.zoomToFit(400, 30)}
      />
    </div>
  )
}
