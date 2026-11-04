import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

// The proposal's toy repository (Fig. "temporal code graph across three commits"), animated.
type N = { id: string; x: number; y: number; w: number; label: string; kind: 'fn' | 'cls'; from: number }
const NODES: N[] = [
  { id: 'co', x: 62, y: 122, w: 96, label: 'checkout()', kind: 'fn', from: 0 },
  { id: 'inv', x: 196, y: 58, w: 82, label: 'Invoice', kind: 'cls', from: 0 },
  { id: 'to', x: 196, y: 134, w: 76, label: 'total()', kind: 'fn', from: 0 },
  { id: 'tx', x: 344, y: 78, w: 64, label: 'tax()', kind: 'fn', from: 0 },
  { id: 'rc', x: 344, y: 168, w: 112, label: 'round_cents()', kind: 'fn', from: 1 },
]
const pos = (id: string) => NODES.find((n) => n.id === id)!
type E = { a: string; b: string; s: number; f: number; type: 'calls' | 'cochange' }
const EDGES: E[] = [
  { a: 'co', b: 'to', s: 0, f: 9, type: 'calls' },
  { a: 'to', b: 'tx', s: 0, f: 2, type: 'calls' },
  { a: 'tx', b: 'rc', s: 1, f: 9, type: 'calls' },
  { a: 'to', b: 'rc', s: 2, f: 9, type: 'calls' },
  { a: 'to', b: 'tx', s: 1, f: 9, type: 'cochange' },
  { a: 'to', b: 'rc', s: 2, f: 9, type: 'cochange' },
]
const CAPTIONS = ['c₁ · initial structure', 'c₂ · adds round_cents(); total() and tax() edited together', 'c₃ · total() calls round_cents() directly']

function edgePath(e: E) {
  const A = pos(e.a), B = pos(e.b)
  const ax = A.x + A.w / 2, bx = B.x - B.w / 2
  const reverse = ax > bx
  const x1 = reverse ? A.x : ax, x2 = reverse ? B.x : bx
  if (e.type === 'cochange') {
    const mx = (A.x + B.x) / 2, my = Math.min(A.y, B.y) - 46
    return `M${A.x},${A.y - 14} Q${mx},${my} ${B.x},${B.y - 14}`
  }
  return `M${x1},${A.y} C${x1 + 40},${A.y} ${x2 - 40},${B.y} ${x2},${B.y}`
}

export default function HeroGraph() {
  const [t, setT] = useState(0)
  useEffect(() => {
    const iv = setInterval(() => setT((x) => (x + 1) % 3), 2600)
    return () => clearInterval(iv)
  }, [])
  const xs = [150, 250, 350]
  const lanes: { label: string; s: number; f: number }[] = [
    { label: 'checkout → total', s: 0, f: 9 },
    { label: 'total → tax', s: 0, f: 2 },
    { label: 'tax → round_cents', s: 1, f: 9 },
    { label: 'total → round_cents', s: 2, f: 9 },
  ]
  return (
    <svg viewBox="0 0 440 360" width="100%" role="img" aria-label="Animated temporal code graph: edges open and close across three commits">
      <defs>
        <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--ink)" />
        </marker>
      </defs>
      {/* file groups */}
      {[
        { x: 8, y: 92, w: 110, h: 62, label: 'api.py' },
        { x: 146, y: 28, w: 104, h: 132, label: 'billing.py' },
        { x: 280, y: 48, w: 130, h: 148, label: 'tax.py' },
      ].map((g) => (
        <g key={g.label}>
          <rect x={g.x} y={g.y} width={g.w} height={g.h} rx={9} fill="var(--surface-2)" stroke="var(--ink)" strokeWidth={2} strokeDasharray="5 4" />
          <text x={g.x + 8} y={g.y - 6} fontFamily="var(--mono)" fontSize={10.5} fontWeight={700} fill="var(--ink-2)">{g.label}</text>
        </g>
      ))}
      <line x1={196} y1={70} x2={196} y2={122} stroke="var(--ink-3)" strokeWidth={2} />
      {/* edges */}
      <AnimatePresence>
        {EDGES.filter((e) => e.s <= t && t < e.f).map((e) => (
          <motion.path
            key={`${e.a}-${e.b}-${e.type}`}
            d={edgePath(e)}
            fill="none"
            stroke={e.type === 'cochange' ? 'var(--s2)' : 'var(--ink)'}
            strokeWidth={e.type === 'cochange' ? (t - e.s === 0 ? 5 : 3) : 2.5}
            strokeOpacity={e.type === 'cochange' ? 0.75 : 1}
            strokeDasharray={e.type === 'cochange' ? '1 0' : undefined}
            strokeLinecap="round"
            markerEnd={e.type === 'calls' ? 'url(#arr)' : undefined}
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            exit={{ opacity: 0, stroke: '#ff5d5d', transition: { duration: 0.9 } }}
            transition={{ duration: 0.7, ease: 'easeOut' }}
          />
        ))}
      </AnimatePresence>
      {t === 2 && (
        <motion.text key="x" x={270} y={110} fontSize={22} fontWeight={700} fill="#e34948" initial={{ scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: [0, 1, 1, 0] }} transition={{ duration: 1.6 }}>×</motion.text>
      )}
      {/* nodes */}
      {NODES.map((n) => {
        const alive = n.from <= t
        return (
          <motion.g key={n.id} initial={false} animate={{ opacity: alive ? 1 : 0.18, scale: alive ? 1 : 0.92 }} style={{ originX: `${n.x}px`, originY: `${n.y}px` }}>
            <rect x={n.x - n.w / 2 + 3} y={n.y - 13 + 3} width={n.w} height={26} rx={6} fill="var(--ink)" />
            <rect x={n.x - n.w / 2} y={n.y - 13} width={n.w} height={26} rx={6}
              fill={n.kind === 'cls' ? 'var(--violet)' : n.id === 'rc' ? 'var(--pink)' : n.id === 'to' ? 'var(--yellow)' : 'var(--cyan)'}
              stroke="var(--ink)" strokeWidth={2.5} strokeDasharray={alive ? undefined : '4 3'} />
            <text x={n.x} y={n.y + 4.5} textAnchor="middle" fontFamily="var(--mono)" fontSize={11.5} fontWeight={700} fill="#0a0a0a">{n.label}</text>
          </motion.g>
        )
      })}
      {/* validity lanes */}
      <g transform="translate(0, 218)">
        <text x={8} y={10} fontFamily="var(--mono)" fontSize={10.5} fontWeight={700} fill="var(--ink-2)" letterSpacing="0.08em">EDGE VALIDITY [s, f)</text>
        {xs.map((x, i) => (
          <g key={i}>
            <line x1={x} y1={18} x2={x} y2={130} stroke="var(--grid)" strokeWidth={2} />
            <text x={x} y={142} textAnchor="middle" fontFamily="var(--mono)" fontSize={11} fontWeight={700} fill={i === t ? 'var(--ink)' : 'var(--ink-3)'}>c{i + 1}</text>
          </g>
        ))}
        <motion.rect y={14} height={120} width={18} rx={4} fill="var(--yellow)" fillOpacity={0.35} stroke="var(--ink)" strokeWidth={1.5}
          animate={{ x: xs[t] - 9 }} transition={{ type: 'spring', stiffness: 220, damping: 22 }} />
        {lanes.map((l, i) => {
          const y = 34 + i * 26
          const x1 = xs[l.s]
          const end = l.f < 9 ? xs[l.f] : 420
          const visibleEnd = Math.min(end, t >= l.s ? (l.f <= t ? end : xs[t] + 30) : x1)
          return (
            <g key={l.label}>
              <text x={8} y={y + 4} fontFamily="var(--mono)" fontSize={10} fill="var(--ink-2)">{l.label}</text>
              <motion.rect x={x1} y={y - 5} height={10} rx={3} fill="var(--s1)" stroke="var(--ink)" strokeWidth={1.5}
                initial={false} animate={{ width: Math.max(0, visibleEnd - x1) }} transition={{ duration: 0.6 }} />
              {l.f < 9 && t >= l.f && <line x1={end} y1={y - 9} x2={end} y2={y + 9} stroke="#e34948" strokeWidth={3} />}
            </g>
          )
        })}
      </g>
      <text x={8} y={352} fontSize={12} fontWeight={600} fill="var(--ink)">{CAPTIONS[t]}</text>
    </svg>
  )
}
