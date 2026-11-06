import { useEffect, useMemo, useState } from 'react'
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom'
import { Atom, BarChart3, Download, FileText, GitCommitHorizontal, Home, Loader2, Network, RefreshCw, Search } from 'lucide-react'
import { api, type GithubMeta, type Stats, type Temporal } from '../api'
import { Card, Github, ThemeToggle, Wordmark } from '../ui'
import { compact, date, fmt } from '../lib/format'
import { TemporalModel } from '../features/graph/temporal'
import GraphView from '../features/graph/GraphView'
import StatsView from '../features/stats/StatsView'
import TimelineView from '../features/timeline/TimelineView'
import RetrieveView from '../features/retrieve/RetrieveView'
import ReportView from '../features/report/ReportView'
import QuantumView from '../features/quantum/QuantumView'

export interface WS {
  repoId: string
  model: TemporalModel
  temporal: Temporal
  stats: Stats
  github: GithubMeta
  tau: number
  setTau: (t: number) => void
  focus: string | null
  setFocus: (k: string | null) => void
  go: (tab: string, key?: string | null) => void
}

const TABS = [
  { id: 'graph', label: 'Graph', icon: Network, k: 'G' },
  { id: 'stats', label: 'Stats', icon: BarChart3, k: 'S' },
  { id: 'timeline', label: 'Timeline', icon: GitCommitHorizontal, k: 'T' },
  { id: 'retrieve', label: 'Retrieve', icon: Search, k: 'R' },
  { id: 'quantum', label: 'Quantum', icon: Atom, k: 'Q' },
  { id: 'report', label: 'Report', icon: FileText, k: 'P' },
]

export default function Workspace() {
  const { repoId = '', tab = 'graph' } = useParams()
  const nav = useNavigate()
  const [temporal, setTemporal] = useState<Temporal | null>(null)
  const [stats, setStats] = useState<{ stats: Stats; github: GithubMeta } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [tau, setTau] = useState(0)
  const [focus, setFocus] = useState<string | null>(null)

  useEffect(() => {
    setTemporal(null); setStats(null); setErr(null)
    Promise.all([api.temporal(repoId), api.stats(repoId)])
      .then(([t, s]) => { setTemporal(t); setStats(s); setTau(t.T - 1) })
      .catch((e) => setErr((e as Error).message))
  }, [repoId])

  const model = useMemo(() => (temporal ? new TemporalModel(temporal) : null), [temporal])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = TABS.find((x) => x.k.toLowerCase() === e.key.toLowerCase())
      if (t) nav(`/r/${repoId}/${t.id}`)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nav, repoId])

  if (err) {
    return (
      <div className="home">
        <header className="topbar"><Link to="/" style={{ textDecoration: 'none' }}><Wordmark /></Link><ThemeToggle /></header>
        <Card fill="pink" title="Could not open this graph"><p>{err}</p><Link className="btn" to="/">Back home</Link></Card>
      </div>
    )
  }

  const ws: WS | null = model && temporal && stats ? {
    repoId, model, temporal, stats: stats.stats, github: stats.github, tau, setTau, focus, setFocus,
    go: (t, key) => { if (key !== undefined) setFocus(key); nav(`/r/${repoId}/${t}`) },
  } : null
  const gh = stats?.github
  const name = temporal?.repo?.name ?? repoId.replace('__', '/')
  const ghUrl = temporal?.repo?.kind === 'github' ? `https://github.com/${temporal.repo.owner}/${temporal.repo.repo}` : null

  return (
    <div className="ws">
      <aside className="rail">
        <Link to="/" style={{ textDecoration: 'none' }} aria-label="Home"><Wordmark /></Link>
        <nav>
          {TABS.map((t) => (
            <NavLink key={t.id} to={`/r/${repoId}/${t.id}`} className={() => `rail-link ${tab === t.id ? 'on' : ''}`}>
              <t.icon size={19} strokeWidth={2.5} /> {t.label} <span className="kbd k">{t.k}</span>
            </NavLink>
          ))}
        </nav>
        {temporal && stats && (
          <div className="repo-mini col" style={{ gap: 6 }}>
            <span className="eyebrow" style={{ fontSize: 10 }}>Window</span>
            <span><b>{fmt(temporal.T)}</b> commits</span>
            <span className="muted">{date(temporal.commits[0].ts)} → {date(temporal.commits[temporal.T - 1].ts)}</span>
            <span><b>{fmt(stats.stats.kpis.symbols)}</b> symbols · <b>{fmt(stats.stats.kpis.edges)}</b> edges</span>
          </div>
        )}
        <div className="rail-foot col" style={{ marginTop: 'auto', gap: 8 }}>
          <Link className="btn sm" to="/"><Home size={14} /> All graphs</Link>
        </div>
      </aside>

      <main className="ws-main">
        <div className="ws-top">
          <div className="ws-title">
            {gh?.avatar && <img className="avatar" src={gh.avatar} alt="" />}
            <div style={{ minWidth: 0 }}>
              <h1 className="mono ellipsis">{name}</h1>
              <div className="muted ellipsis" style={{ fontSize: 13.5, maxWidth: 640 }}>{gh?.description ?? 'Temporal code graph'}</div>
            </div>
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            {gh?.stars != null && <span className="badge">★ {compact(gh.stars)}</span>}
            {gh?.license && <span className="badge">{gh.license}</span>}
            {ghUrl && <a className="btn sm" href={ghUrl} target="_blank" rel="noreferrer"><Github size={14} /> GitHub</a>}
            <a className="btn sm" href={`/api/repos/${repoId}/export/graph.json`}><Download size={14} /> graph.json</a>
            <button className="btn sm" onClick={async () => {
              const j = await api.build(temporal?.repo?.kind === 'local' ? (temporal.repo as unknown as { path: string }).path : name, temporal?.repo?.depth ?? 300, true)
              nav(`/build/${j.id}`)
            }}><RefreshCw size={14} /> Rebuild</button>
            <ThemeToggle />
          </div>
        </div>

        {!ws ? (
          <div className="col" style={{ alignItems: 'center', padding: 80, gap: 14 }}>
            <Loader2 size={34} className="spin" />
            <span className="muted">Loading the temporal graph…</span>
          </div>
        ) : tab === 'stats' ? <StatsView ws={ws} />
          : tab === 'timeline' ? <TimelineView ws={ws} />
          : tab === 'retrieve' ? <RetrieveView ws={ws} />
          : tab === 'report' ? <ReportView ws={ws} />
          : tab === 'quantum' ? <QuantumView ws={ws} />
          : <GraphView ws={ws} />}
      </main>
    </div>
  )
}
