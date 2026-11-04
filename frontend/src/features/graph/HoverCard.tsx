import type { VKind, VNode } from './temporal'
import { fmt, splitKey } from '../../lib/format'

export const KIND_NAME: Record<VKind, string> = { module: 'Module', file: 'File', class: 'Class', function: 'Function', method: 'Method' }

/** Small SVG of the shape each kind is drawn with on the canvas. */
export function KindGlyph({ kind, color = 'var(--surface-3)', size = 16 }: { kind: VKind; color?: string; size?: number }) {
  const s = size, h = s / 2, st = 'var(--line)'
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} aria-hidden style={{ flex: 'none' }}>
      {kind === 'class' && <rect x={2} y={2} width={s - 4} height={s - 4} fill={color} stroke={st} strokeWidth={1.6} />}
      {kind === 'file' && <path d={`M${h} 1 L${s - 1} ${h} L${h} ${s - 1} L1 ${h} Z`} fill={color} stroke={st} strokeWidth={1.6} />}
      {(kind === 'function' || kind === 'method' || kind === 'module') && <circle cx={h} cy={h} r={h - 1.5} fill={color} stroke={st} strokeWidth={kind === 'module' ? 2.4 : 1.6} />}
      {kind === 'method' && <circle cx={h} cy={h} r={s / 7} fill={st} />}
    </svg>
  )
}

export default function HoverCard({ node, x, y, width, color, label, heatMax, tau, moduleView }: {
  node: VNode; x: number; y: number; width: number; color: string; label: string; heatMax: number; tau: number; moduleView: boolean
}) {
  const k = splitKey(node.id)
  const left = x + 300 > width ? x - 300 : x + 18
  const heatPct = Math.min(100, (node.heat / Math.max(heatMax, 1e-6)) * 100)
  return (
    <div className="hovercard" style={{ left: Math.max(8, left), top: Math.max(8, y - 12) }} role="tooltip">
      <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        <KindGlyph kind={node.kind} color={color} size={18} />
        <div style={{ minWidth: 0 }}>
          <div className="mono hc-name">{node.kind === 'module' ? node.name : k.sym || k.file}</div>
          <div className="muted" style={{ fontSize: 11.5 }}>
            {KIND_NAME[node.kind]}
            {node.kind !== 'module' && <> · <span className="mono">{k.path}{node.kind !== 'file' && node.start ? `:${node.start}` : ''}</span></>}
          </div>
        </div>
      </div>
      {node.kind === 'module' ? (
        <div className="hc-grid">
          <span>symbols</span><b>{fmt(node.members ?? 0)}</b>
          <span>files</span><b>{fmt(node.files ?? 0)}</b>
          <span>depends on</span><b>{node.outDeg} modules</b>
          <span>used by</span><b>{node.inDeg} modules</b>
        </div>
      ) : (
        <>
          <div className="row" style={{ gap: 6, fontSize: 12 }}>
            <span className="swatch" style={{ background: color }} />
            <span className="ellipsis">{label}</span>
            {node.ext && <span className="badge" style={{ height: 18, fontSize: 10 }}>outside module</span>}
          </div>
          <div className="hc-flow">
            <span><b>{node.inDeg}</b> use it</span>
            <span className="hc-dot" />
            <span>it uses <b>{node.outDeg}</b></span>
          </div>
        </>
      )}
      <div>
        <div className="row between" style={{ fontSize: 11 }}>
          <span className="muted">recent change activity h(v; τ)</span>
          <b className="mono">{node.heat.toFixed(2)}</b>
        </div>
        <div className="hc-bar"><span style={{ width: `${heatPct}%` }} /></div>
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        {node.changed && <span className="badge fill-yellow" style={{ height: 20 }}>changed {moduleView ? 'inside' : ''} at τ</span>}
        {node.isNew && <span className="badge fill-lime" style={{ height: 20 }}>new</span>}
        {node.ghost && <span className="badge" style={{ height: 20, background: 'var(--red)', color: '#0a0a0a' }}>removed</span>}
        {node.kind !== 'module' && node.born > 0 && !node.ghost && <span className="badge" style={{ height: 20 }}>since c{node.born}</span>}
        {node.kind !== 'module' && node.born === 0 && <span className="badge" style={{ height: 20 }}>since window start</span>}
        <span className="badge" style={{ height: 20 }}>τ = {tau}</span>
      </div>
      <div className="hc-hint">{moduleView ? 'Click to open this module' : 'Click for details · right-click for actions'}</div>
    </div>
  )
}
