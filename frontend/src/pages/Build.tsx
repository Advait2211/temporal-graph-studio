import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { AlertTriangle, ArrowLeft, ArrowRight, Check, Loader2, RotateCcw, X } from 'lucide-react'
import { api, streamBuild, type BuildSnapshot } from '../api'
import { Card, Marquee, StatTile, ThemeToggle, Wordmark } from '../ui'
import { fmt } from '../lib/format'

const DESC: Record<string, string> = {
  meta: 'stars, languages, contributors',
  clone: 'shallow, single branch',
  snapshot: 'parse every file at c₀',
  resolve: 'link refs → defs, 1/k',
  walk: 'per commit: diff, re-parse, open/close [s, f)',
  signals: 'co-change w, prior h',
  communities: 'Louvain on the union graph',
  store: 'SQLite interval rows',
}

export default function Build() {
  const { jobId = '' } = useParams()
  const nav = useNavigate()
  const [s, setS] = useState<BuildSnapshot | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const termRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let off = () => {}
    api.buildStatus(jobId).then((first) => {
      setS(first)
      off = streamBuild(jobId, setS)
    }).catch((e) => setErr((e as Error).message))
    return () => off()
  }, [jobId])

  useEffect(() => {
    if (s?.state === 'done') {
      const t = setTimeout(() => nav(`/r/${s.repo_id}/graph`), 1400)
      return () => clearTimeout(t)
    }
  }, [s?.state, s?.repo_id, nav])

  useEffect(() => { termRef.current?.scrollTo({ top: 1e9 }) }, [s?.log.length])

  if (err) {
    return (
      <div className="build-page">
        <header className="topbar"><Link to="/" style={{ textDecoration: 'none' }}><Wordmark /></Link><ThemeToggle /></header>
        <Card fill="pink"><b>Build not found.</b> {err} <Link to="/">Start a new one</Link></Card>
      </div>
    )
  }
  const stages = s?.stages ?? []
  const idx = stages.findIndex((x) => x.id === s?.stage)
  const pct = Math.round((s?.progress ?? 0) * 100)
  const c = s?.counters ?? {}
  const done = s?.state === 'done'
  const failed = s?.state === 'error'

  return (
    <div>
      <div className="build-page">
        <header className="topbar">
          <Link to="/" style={{ textDecoration: 'none' }}><Wordmark /></Link>
          <div className="row">
            <Link to="/" className="btn sm"><ArrowLeft size={15} /> Home</Link>
            <ThemeToggle />
          </div>
        </header>

        <div className="build-hero">
          <div className="col" style={{ gap: 12 }}>
            <span className="eyebrow">{done ? 'Graph ready' : failed ? 'Build failed' : 'Building temporal code graph'}</span>
            <h1 style={{ fontSize: 'clamp(30px, 4.6vw, 54px)', letterSpacing: '-0.04em' }} className="mono">{s?.name ?? '…'}</h1>
            <span className="muted">{s ? `${fmt(s.elapsed, 1)} s elapsed` : 'connecting…'}{c.total_commits ? ` · ${fmt(c.total_commits)} commits in window` : ''}</span>
          </div>
          <motion.div className="pct" key={done ? 'd' : 'p'} initial={{ scale: done ? 0.7 : 1 }} animate={{ scale: 1 }}>
            {done ? <span className="hl">100%</span> : <>{pct}<span style={{ fontSize: '0.45em' }}>%</span></>}
          </motion.div>
        </div>

        <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${pct}%`, animationPlayState: done || failed ? 'paused' : 'running', background: failed ? 'var(--red)' : done ? 'var(--lime)' : undefined }} />
        </div>

        <div className="stages">
          {stages.map((st, i) => {
            const state = done || i < idx ? 'done' : i === idx ? (failed ? 'pending' : 'active') : 'pending'
            return (
              <motion.div key={st.id} className={`stage ${state}`} layout>
                <span className="row between">
                  <span className="n">0{i + 1}</span>
                  {state === 'done' ? <Check size={16} strokeWidth={3} /> : state === 'active' ? <Loader2 size={15} className="spin" /> : null}
                </span>
                <span>
                  <div className="l">{st.label}</div>
                  <div style={{ fontSize: 11, opacity: 0.75, marginTop: 3 }}>{DESC[st.id]}</div>
                </span>
                {state === 'active' && <span className="fillbar" style={{ width: `${(s?.stage_frac ?? 0) * 100}%` }} />}
              </motion.div>
            )
          })}
        </div>

        <div className="counters">
          <StatTile label="Commits walked" value={c.commits ?? 0} hint={c.total_commits ? `of ${fmt(c.total_commits)}` : undefined} fill="yellow" />
          <StatTile label="Code files" value={c.files ?? 0} />
          <StatTile label="Symbols" value={c.symbols ?? 0} fill="cyan" />
          <StatTile label="Open edges" value={c.edges ?? 0} />
          <StatTile label="Co-change pairs" value={c.cochange ?? '—'} fill="pink" />
        </div>

        <div className="g2" style={{ marginTop: 20 }}>
          <div className="term" ref={termRef} aria-live="polite">
            <div className="dots"><span /><span /><span /></div>
            {(s?.log ?? []).map((l, i, arr) => <div key={i} className={`ln ${i === arr.length - 1 ? 'last' : ''}`}>{l}</div>)}
            {!done && !failed && <div className="ln last"><span className="spin" style={{ display: 'inline-block' }}>◐</span></div>}
          </div>
          <Card fill={done ? 'lime' : failed ? 'pink' : undefined} title={done ? 'Your graph is ready' : failed ? 'Something went wrong' : 'What is happening'}>
            {failed ? (
              <div className="col">
                <div className="row" style={{ alignItems: 'flex-start' }}><AlertTriangle size={20} /><span style={{ fontWeight: 600 }}>{s?.error}</span></div>
                <div className="row">
                  <button className="btn" onClick={async () => { const j = await api.build(s!.name, 300, true); nav(`/build/${j.id}`) }}><RotateCcw size={16} /> Retry</button>
                  <Link to="/" className="btn ghost">Back</Link>
                </div>
              </div>
            ) : done ? (
              <div className="col">
                <span>Opening the explorer…</span>
                <Link to={`/r/${s!.repo_id}/graph`} className="btn primary">Open workspace <ArrowRight size={16} /></Link>
              </div>
            ) : (
              <div className="col" style={{ fontSize: 14 }}>
                <p style={{ margin: 0 }}>We walk the <b>first-parent chain</b> oldest to newest. Each commit re-parses only the files it changed,
                  maps diff hunks onto symbols (Δ<sub>t</sub>), and closes or opens validity intervals for nodes and edges.</p>
                <p style={{ margin: 0 }} className="muted">Ancestry, not timestamps, orders history, so a graph as of commit τ never sees the future.</p>
                <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => api.cancel(jobId)}><X size={14} /> Cancel</button>
              </div>
            )}
          </Card>
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <Marquee items={[`${fmt(c.commits ?? 0)} commits`, `${fmt(c.symbols ?? 0)} symbols`, `${fmt(c.edges ?? 0)} edges open`,
          `stage: ${stages[idx]?.label ?? '…'}`, `${pct}% done`, s?.message?.slice(0, 60) ?? '']} />
      </div>
    </div>
  )
}
