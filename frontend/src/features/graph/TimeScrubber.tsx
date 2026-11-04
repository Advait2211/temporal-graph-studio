import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, GitCompareArrows, Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import type { Temporal } from '../../api'
import { date, fmt, shortDate } from '../../lib/format'

export default function TimeScrubber({ temporal, tau, setTau, extra, since, setSince }: {
  temporal: Temporal; tau: number; setTau: (t: number) => void; extra?: React.ReactNode
  since?: number | null; setSince?: (t: number | null) => void
}) {
  const comparing = since != null && setSince != null
  const T = temporal.T
  const ref = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [drag, setDrag] = useState<false | 'tau' | 'since'>(false)
  const tauRef = useRef(tau)
  tauRef.current = tau
  const max = useMemo(() => Math.max(1, ...temporal.commits.map((c) => c.delta)), [temporal])
  const bigCut = useMemo(() => {
    const d = temporal.commits.map((c) => c.delta).sort((a, b) => b - a)
    return d[Math.min(d.length - 1, Math.floor(d.length * 0.05))] || Infinity
  }, [temporal])

  const fromX = useCallback((clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    return Math.min(T - 1, Math.floor(f * T))
  }, [T])

  useEffect(() => {
    if (!playing) return
    const iv = setInterval(() => {
      setTau(Math.min(T - 1, tauRef.current + 1))
      if (tauRef.current >= T - 2) setPlaying(false)
    }, 160)
    return () => clearInterval(iv)
  }, [playing, T, setTau])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return
      if (e.key === 'ArrowLeft') { setTau(Math.max(0, tauRef.current - (e.shiftKey ? 10 : 1))); e.preventDefault() }
      if (e.key === 'ArrowRight') { setTau(Math.min(T - 1, tauRef.current + (e.shiftKey ? 10 : 1))); e.preventDefault() }
      if (e.key === ' ') { setPlaying((p) => !p); e.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [T, setTau])

  const c = temporal.commits[tau]
  const moveTo = (which: 'tau' | 'since', t: number) => {
    if (which === 'since' && setSince) setSince(Math.max(0, Math.min(t, tau - 1)))
    else setTau(comparing ? Math.max(since! + 1, t) : t)
  }
  const c0 = comparing ? temporal.commits[since!] : null
  // year/month axis labels, ~6 of them
  const axis = useMemo(() => {
    const n = Math.min(6, T)
    return Array.from({ length: n }, (_, i) => Math.round((i / Math.max(1, n - 1)) * (T - 1)))
  }, [T])

  return (
    <div className="card scrubber">
      <div className="row between wrap" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm icon" aria-label="First commit" onClick={() => setTau(0)}><SkipBack size={15} /></button>
          <button className="btn sm icon" aria-label="Previous commit" onClick={() => setTau(Math.max(0, tau - 1))}><ChevronLeft size={16} /></button>
          <button className={`btn sm ${playing ? 'pink' : 'primary'}`} onClick={() => { if (tau >= T - 1) setTau(0); setPlaying(!playing) }} style={{ minWidth: 92 }}>
            {playing ? <Pause size={15} /> : <Play size={15} />} {playing ? 'Pause' : 'Play'}
          </button>
          <button className="btn sm icon" aria-label="Next commit" onClick={() => setTau(Math.min(T - 1, tau + 1))}><ChevronRight size={16} /></button>
          <button className="btn sm icon" aria-label="Newest commit" onClick={() => setTau(T - 1)}><SkipForward size={15} /></button>
          {setSince && (
            <button className={`btn sm ${comparing ? 'cyan pressed' : ''}`} title="Compare two commits: what changed between them"
              onClick={() => setSince(comparing ? null : Math.max(0, Math.min(tau - 1, tau - 50)))} aria-pressed={comparing} disabled={T < 2}>
              <GitCompareArrows size={15} /> {comparing ? 'Comparing' : 'Compare'}
            </button>
          )}
        </div>
        <div className="scrub-meta grow" style={{ justifyContent: 'flex-end' }}>
          {c0 && <>
            <span className="mono" style={{ fontWeight: 700 }}>from c{since}</span>
            <span className="sha" style={{ background: 'var(--cyan)', color: '#0a0a0a' }}>{c0.sha.slice(0, 7)}</span>
            <span className="muted">{date(c0.ts)}</span>
            <span style={{ fontWeight: 700 }}>→</span>
          </>}
          <span className="mono" style={{ fontWeight: 700 }}>τ = {tau}<span className="muted">/{T - 1}</span></span>
          <span className="sha">{c.sha.slice(0, 7)}</span>
          <span className="muted">{date(c.ts)}</span>
          {!c0 && <span className="ellipsis" style={{ maxWidth: 380, fontWeight: 600 }} title={c.msg}>{c.msg}</span>}
          {!c0 && <span className="badge" title="Symbols touched by this commit (|Δ_t|)">Δ {fmt(c.delta)}</span>}
        </div>
      </div>
      <div
        className="scrub-track"
        ref={ref}
        role="slider"
        aria-label="Commit (τ)"
        aria-valuemin={0}
        aria-valuemax={T - 1}
        aria-valuenow={tau}
        tabIndex={0}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId)
          setPlaying(false)
          const t = fromX(e.clientX)
          const which = comparing && Math.abs(t - since!) < Math.abs(t - tau) ? 'since' : 'tau'
          setDrag(which)
          moveTo(which, t)
        }}
        onPointerMove={(e) => { if (drag) moveTo(drag, fromX(e.clientX)) }}
        onPointerUp={() => setDrag(false)}
      >
        <div className="scrub-ticks">
          {temporal.commits.map((cm) => (
            <span key={cm.i} className={`${cm.i > tau || (comparing && cm.i <= since!) ? 'future' : ''} ${cm.delta >= bigCut && cm.delta > 0 ? 'big' : ''}`}
              style={{ height: `${8 + (Math.log1p(cm.delta) / Math.log1p(max)) * 92}%` }} />
          ))}
        </div>
        {comparing && (
          <>
            <div className="scrub-range" style={{ left: `${((since! + 0.5) / T) * 100}%`, width: `${(Math.max(0, tau - since!) / T) * 100}%` }} />
            <div className="scrub-handle since" style={{ left: `${((since! + 0.5) / T) * 100}%` }}><span className="knob" /></div>
          </>
        )}
        <div className="scrub-handle" style={{ left: `${((tau + 0.5) / T) * 100}%` }}><span className="knob" /></div>
        <div className="scrub-axis">
          {axis.map((i) => <span key={i} style={{ left: `${((i + 0.5) / T) * 100}%` }}>{shortDate(temporal.commits[i].ts)}</span>)}
        </div>
      </div>
      {extra}
    </div>
  )
}
