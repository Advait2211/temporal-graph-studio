import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, Clock3, FolderGit2, GitBranch, History, Loader2, Network, Search, Sparkles, Star, Trash2 } from 'lucide-react'
import { api, type BuildSnapshot, type RepoCard } from '../api'
import { Card, Github, Marquee, Spark, ThemeToggle, Wordmark } from '../ui'
import { ago, compact, fmt } from '../lib/format'
import { LANG_COLOR } from '../lib/colors'
import HeroGraph from './HeroGraph'

const EXAMPLES = ['pallets/flask', 'psf/requests', 'encode/httpx', 'fastapi/typer', 'expressjs/express', 'sindresorhus/ky', 'gin-gonic/gin']
const DEPTHS = [100, 300, 1000]

export default function Home() {
  const nav = useNavigate()
  const [src, setSrc] = useState('')
  const [depth, setDepth] = useState(300)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [repos, setRepos] = useState<RepoCard[] | null>(null)
  const [running, setRunning] = useState<BuildSnapshot[]>([])

  const load = () => api.repos().then((r) => { setRepos(r.repos); setRunning(r.running) }).catch(() => setRepos([]))
  useEffect(() => { load() }, [])

  async function submit(e?: FormEvent, value?: string) {
    e?.preventDefault()
    const s = (value ?? src).trim()
    if (!s) { setErr('Paste a GitHub URL like github.com/pallets/flask'); return }
    setBusy(true); setErr(null)
    try {
      const job = await api.build(s, depth)
      nav(`/build/${job.id}`)
    } catch (ex) {
      setErr((ex as Error).message); setBusy(false)
    }
  }

  return (
    <div className="home">
      <header className="topbar">
        <Wordmark />
        <nav className="row" style={{ gap: 10 }}>
          <a className="btn ghost sm" href="#how">How it works</a>
          <a className="btn ghost sm" href="#graphs">Your graphs</a>
          <ThemeToggle />
        </nav>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <motion.span className="sticker fill-pink" initial={{ rotate: -12, scale: 0.6, opacity: 0 }} animate={{ rotate: -3, scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 14 }}>
            <Sparkles size={15} strokeWidth={2.6} /> time-native code graph
          </motion.span>
          <motion.h1 className="display" initial={{ y: 18, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.05 }}>
            Your repo,<br /><span className="hl">through time.</span>
          </motion.h1>
          <p className="lede">
            Paste a GitHub link. TCG Studio walks the commit history, parses every change with Tree-sitter and
            builds <b>one graph</b> where calls, imports, inheritance <i>and</i> co-change edges remember the commits
            they were true for. Scrub it, measure it, and retrieve context <b>as of any commit</b>.
          </p>

          <form className="card build-box" onSubmit={submit}>
            <label htmlFor="src" className="eyebrow">GitHub repository</label>
            <div className="row build-row">
              <div className="input-wrap grow">
                <Github size={20} strokeWidth={2.4} />
                <input id="src" className="input" autoFocus placeholder="github.com/owner/repo" value={src}
                  onChange={(e) => setSrc(e.target.value)} spellCheck={false} autoComplete="off" />
              </div>
              <button className="btn primary big" disabled={busy}>
                {busy ? <Loader2 className="spin" size={20} /> : <Network size={20} strokeWidth={2.6} />} Build graph
              </button>
            </div>
            <div className="row wrap between" style={{ gap: 12 }}>
              <div className="row" style={{ gap: 8 }}>
                <span className="muted" style={{ fontSize: 13 }}><History size={14} style={{ verticalAlign: -2 }} /> History depth</span>
                <div className="seg">
                  {DEPTHS.map((d) => (
                    <button type="button" key={d} className={d === depth ? 'on' : ''} onClick={() => setDepth(d)}>{d} commits</button>
                  ))}
                </div>
              </div>
              <span className="muted" style={{ fontSize: 12.5 }}>Python · JS · TS · Go · Java. Local git repos work too: paste the full path.</span>
            </div>
            {err && <div className="err">{err}</div>}
            <div className="row wrap" style={{ gap: 8 }}>
              <span className="muted" style={{ fontSize: 13 }}>Try</span>
              {EXAMPLES.map((ex) => (
                <button type="button" key={ex} className="chip" onClick={() => { setSrc(ex); submit(undefined, ex) }}>{ex}</button>
              ))}
            </div>
          </form>
        </div>

        <motion.div className="card hero-art" initial={{ rotate: 2, y: 20, opacity: 0 }} animate={{ rotate: 1, y: 0, opacity: 1 }} transition={{ delay: 0.12 }}>
          <div className="row between" style={{ marginBottom: 6 }}>
            <span className="eyebrow">G<sub>τ</sub> as τ moves</span>
            <span className="badge fill-lime">live</span>
          </div>
          <HeroGraph />
        </motion.div>
      </section>

      <Marquee items={['calls', 'imports', 'inherits', 'co-change', 'validity intervals [s, f)', 'as-of queries', 'leakage-safe by ancestry',
        'time-aware PageRank', 'token-budgeted packing', 'hidden coupling', 'churn hotspots', 'communities']} />

      <section className="how" id="how">
        <div className="section-head">
          <span className="eyebrow">Why it exists</span>
          <h2 className="h2">Snapshot graphs forget. Ours doesn't.</h2>
          <p className="muted">Our survey found that no code retrieval system stores a repository as one graph whose edges
            record the commits over which they held. TCG Studio is that missing piece.</p>
        </div>
        <div className="how-grid">
          <Card fill="cyan" className="lift">
            <GitBranch size={28} strokeWidth={2.4} />
            <h3 className="h3" style={{ margin: '12px 0 6px' }}>Walk once, incrementally</h3>
            <p>The oldest commit is parsed in full; every later commit re-parses only the files it touched and opens or closes edge intervals.</p>
          </Card>
          <Card fill="yellow" className="lift">
            <Clock3 size={28} strokeWidth={2.4} />
            <h3 className="h3" style={{ margin: '12px 0 6px' }}>History lives in the edges</h3>
            <p>Co-change weights decay with recency, and a change prior marks hot code. Both are computed only from ancestors of τ, so nothing leaks from the future.</p>
          </Card>
          <Card fill="pink" className="lift">
            <Search size={28} strokeWidth={2.4} />
            <h3 className="h3" style={{ margin: '12px 0 6px' }}>Retrieve as of any commit</h3>
            <p>Seeds from the issue text, personalised PageRank over mixed edges, then packing into a token budget, compared side by side with a static-only ablation.</p>
          </Card>
        </div>
        <Card className="compare" title="Snapshot code graph vs temporal code graph" sub="Graphify-style tools do the left column well. TCG keeps all of it and adds the right.">
          <table className="tbl">
            <thead><tr><th>Capability</th><th>Snapshot graph</th><th>TCG Studio</th></tr></thead>
            <tbody>
              {[
                ['Tree-sitter symbols, calls, imports, inheritance', '✓', '✓'],
                ['Communities, god nodes, report', '✓', '✓'],
                ['Edges carry validity intervals over commits', '—', '✓'],
                ['Query the graph as of any commit (G_τ)', '—', '✓'],
                ['Co-change edges & recency-decayed change prior', '—', '✓'],
                ['Hidden coupling: no import, yet always edited together', '—', '✓'],
                ['Leakage-safe retrieval for benchmark tasks', '—', '✓'],
              ].map(([a, b, c]) => (
                <tr key={a}><td>{a}</td><td className="mono muted">{b}</td><td className="mono" style={{ fontWeight: 700 }}>{c === '✓' ? <span className="badge fill-lime">✓</span> : c}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      </section>

      <section className="graphs" id="graphs">
        <div className="section-head row between wrap">
          <div>
            <span className="eyebrow">Your graphs</span>
            <h2 className="h2">Built locally, cached forever</h2>
          </div>
        </div>
        {running.length > 0 && (
          <div className="row wrap" style={{ marginBottom: 16 }}>
            {running.map((j) => (
              <button key={j.id} className="chip" onClick={() => nav(`/build/${j.id}`)}>
                <Loader2 size={14} className="spin" /> building {j.name}, {Math.round(j.progress * 100)}%
              </button>
            ))}
          </div>
        )}
        {repos === null ? (
          <div className="repo-grid">{[0, 1, 2].map((i) => <div key={i} className="skel" style={{ height: 210 }} />)}</div>
        ) : repos.length === 0 ? (
          <Card className="flat" style={{ borderStyle: 'dashed' }}>
            <div className="col" style={{ alignItems: 'center', padding: 24, textAlign: 'center' }}>
              <FolderGit2 size={34} strokeWidth={2.2} />
              <b>No graphs yet</b>
              <span className="muted">Pick an example above. pallets/flask takes about ten seconds.</span>
            </div>
          </Card>
        ) : (
          <div className="repo-grid">
            {repos.map((r, i) => <RepoTile key={r.id} r={r} i={i} onDelete={async () => { await api.deleteRepo(r.id); load() }} />)}
          </div>
        )}
      </section>

      <footer className="foot">
        <Wordmark />
        <span className="muted">Temporal code graphs for context retrieval in coding agents · VJTI final-year project</span>
      </footer>
    </div>
  )
}

const FILLS = ['yellow', 'cyan', 'pink', 'lime', 'violet', 'orange']

function RepoTile({ r, i, onDelete }: { r: RepoCard; i: number; onDelete: () => void }) {
  const nav = useNavigate()
  const langs = Object.entries(r.languages || {}).sort((a, b) => b[1] - a[1])
  const total = langs.reduce((s, [, v]) => s + v, 0) || 1
  return (
    <motion.article className="card lift repo-tile" initial={{ y: 14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: i * 0.04 }}
      onClick={() => nav(`/r/${r.id}/graph`)} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/r/${r.id}/graph`)}>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div className="row" style={{ minWidth: 0 }}>
          {r.avatar ? <img src={r.avatar} alt="" className="avatar" /> : <span className={`avatar fill-${FILLS[i % FILLS.length]}`}><FolderGit2 size={18} /></span>}
          <div style={{ minWidth: 0 }}>
            <div className="ellipsis" style={{ fontWeight: 700, fontSize: 16.5 }}>{r.name}</div>
            <div className="muted mono" style={{ fontSize: 11.5 }}>built {ago(r.built_at)} · {r.depth} commits</div>
          </div>
        </div>
        <button className="btn sm icon ghost" aria-label={`Delete ${r.name}`} onClick={(e) => { e.stopPropagation(); onDelete() }}><Trash2 size={15} /></button>
      </div>
      <p className="muted repo-desc">{r.description || (r.kind === 'local' ? 'Local repository' : 'No description')}</p>
      <div className="row between" style={{ alignItems: 'flex-end' }}>
        <div className="kv">
          <span><b className="tnum">{compact(r.kpis.symbols)}</b> symbols</span>
          <span><b className="tnum">{compact(r.kpis.edges)}</b> edges</span>
          <span><b className="tnum">{compact(r.kpis.cochange_pairs)}</b> co-change</span>
        </div>
        <Spark data={r.spark} width={110} height={38} fill={`var(--${FILLS[i % FILLS.length]})`} />
      </div>
      <div className="langbar" aria-label="Languages by file count">
        {langs.map(([l, v]) => <span key={l} style={{ width: `${(v / total) * 100}%`, background: LANG_COLOR[l] ?? 'var(--s-other)' }} title={`${l}: ${v} files`} />)}
      </div>
      <div className="row between">
        <span className="row muted" style={{ gap: 12, fontSize: 12.5 }}>
          {r.stars != null && <span className="row" style={{ gap: 4 }}><Star size={13} /> {compact(r.stars)}</span>}
          {langs.slice(0, 2).map(([l]) => <span key={l}>{l}</span>)}
          <span>{fmt(r.kpis.span_days)} days</span>
        </span>
        <span className="row" style={{ gap: 4, fontWeight: 700, fontSize: 13 }}>Open <ArrowRight size={15} /></span>
      </div>
    </motion.article>
  )
}
