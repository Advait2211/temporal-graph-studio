import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d'
import { ChevronRight, CircleHelp, Crosshair, Eye, GitFork, Layers, Maximize, Minimize, Route, Scan, Search, Undo2, X, ZoomIn, ZoomOut } from 'lucide-react'
import type { WS } from '../../pages/Workspace'
import { useCssVars, useTheme } from '../../lib/theme'
import { fmt, label, splitKey } from '../../lib/format'
import { EDGE_LABEL, EDGE_SLOT, KIND_LABEL, KIND_SLOT, SERIES } from '../../lib/colors'
import { Seg, Switch } from '../../ui'
import { alive, type Granularity, type LinkKind, type VLink, type VNode } from './temporal'
import TimeScrubber from './TimeScrubber'
import NodeDrawer from './NodeDrawer'
import { pickNode } from './pick'
import { buildAdj, shortestPath } from './paths'
import { clusterForce, collideForce, flowLayout } from './forces'
import { drawHeaders, drawHulls, drawPathBadges } from './overlay'
import HoverCard, { KindGlyph } from './HoverCard'
import ContextMenu, { type MenuAction } from './ContextMenu'
import { Coach, HowToRead } from './HowToRead'

type ColorBy = 'community' | 'kind' | 'heat'
type Mode = { kind: 'map' } | { kind: 'flow'; center: string } | { kind: 'path'; from: string; to: string | null }

const VARS = ['ink', 'ink-2', 'ink-3', 'surface', 'surface-2', 'surface-3', 'line', 'shadow-c', 'yellow', 'lime', 'red', 'pink',
  's-other', 'in-c', 'out-c', ...SERIES] as const
const HEAT_LIGHT = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b']
const HEAT_DARK = ['#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#86b6ef', '#b7d3f6']
const LINK_KINDS: LinkKind[] = ['calls', 'imports', 'inherits', 'cochange', 'contains']
const ALL_ON: Record<LinkKind, boolean> = { calls: true, imports: true, inherits: true, cochange: true, contains: true }
const DEP_KINDS = new Set<LinkKind>(['calls', 'imports', 'inherits'])

function useSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [s, setS] = useState({ w: 800, h: 560 })
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setS({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [ref])
  return s
}

const nid = (x: string | VNode) => (typeof x === 'string' ? x : x.id)

export default function GraphView({ ws }: { ws: WS }) {
  const { model, temporal, tau, setTau, focus, setFocus } = ws
  const theme = useTheme()
  const C = useCssVars(VARS)
  const wrap = useRef<HTMLDivElement>(null)
  const fg = useRef<ForceGraphMethods<VNode, VLink> | undefined>(undefined)
  const size = useSize(wrap)
  const [granularity, setGranularity] = useState<Granularity>('modules')
  const [scope, setScope] = useState<number | null>(null)
  const [mode, setMode] = useState<Mode>({ kind: 'map' })
  const [since, setSince] = useState<number | null>(null)
  const [colorBy, setColorBy] = useState<ColorBy>('community')
  const [hideTests, setHideTests] = useState(true)
  const [grouping, setGrouping] = useState(true)
  const [edgeOn, setEdgeOn] = useState<Record<LinkKind, boolean>>(ALL_ON)
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const [hover, setHover] = useState<VNode | null>(null)
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ node: VNode; x: number; y: number } | null>(null)
  const [howto, setHowto] = useState(false)
  const [q, setQ] = useState('')
  const [qOpen, setQOpen] = useState(false)
  const [qSel, setQSel] = useState(0)
  const [pathQ, setPathQ] = useState('')
  const [pathCC, setPathCC] = useState(false)
  const [ccThreshold, setCcThreshold] = useState(0.25)
  const [legendOpen, setLegendOpen] = useState(false)
  const [full, setFull] = useState(false)
  const pinned = useRef(new Set<string>())
  const pendingFly = useRef<string | null>(null)

  // ---------------------------------------------------------------- the view at τ
  const effGran: Granularity = mode.kind === 'map' ? granularity : 'symbols'
  const effScope = mode.kind === 'map' && effGran !== 'modules' ? scope : null
  const effSince = since != null ? Math.min(since, tau - 1) : null
  const view = useMemo(() => model.view({
    tau, since: effSince, granularity: effGran, scope: effScope, edgeOn: mode.kind === 'map' ? edgeOn : ALL_ON,
    hideTests, ccThreshold, hidden,
  }), [model, tau, effSince, effGran, effScope, mode.kind, edgeOn, hideTests, ccThreshold, hidden])
  const byId = useMemo(() => new Map(view.nodes.map((n) => [n.id, n])), [view])
  const byIdRef = useRef(byId)
  byIdRef.current = byId

  const adj = useMemo(() => {
    if (mode.kind === 'map') return null
    const kinds = new Set<LinkKind>(DEP_KINDS)
    if (mode.kind === 'flow' || pathCC) kinds.add('cochange')
    return buildAdj(view.links, kinds)
  }, [view, mode.kind, pathCC])

  const flow = useMemo(() => (mode.kind === 'flow' && adj && byId.has(mode.center)
    ? flowLayout(mode.center, adj, (id) => byId.get(id)?.pr ?? 0) : null), [mode, adj, byId])

  const path = useMemo(() => (mode.kind === 'path' && mode.to && adj ? shortestPath(adj, mode.from, mode.to) : null), [mode, adj])
  const pathNodes = useMemo(() => (path ? new Set(path.nodes) : null), [path])
  const pathEdges = useMemo(() => {
    if (!path) return null
    const s = new Set<string>()
    for (const h of path.hops) { s.add(`${h.from}|${h.to}`); s.add(`${h.to}|${h.from}`) }
    return s
  }, [path])

  const data = useMemo(() => {
    if (flow) {
      const nodes: VNode[] = []
      for (const [id, p] of flow.pos) {
        const n = byId.get(id)
        if (!n) continue
        n.fx = p.x; n.fy = p.y; n.x = p.x; n.y = p.y
        nodes.push(n)
      }
      const links = view.links.filter((l) => l.kind !== 'contains' && flow.ids.has(nid(l.source)) && flow.ids.has(nid(l.target)))
      return { nodes, links }
    }
    // place newcomers next to their file so they don't fly in from the origin
    for (const n of view.nodes) {
      if (n.x === undefined) {
        const parent = byId.get(n.path)
        if (parent && parent.x !== undefined && parent !== n) {
          n.x = parent.x + (Math.random() - 0.5) * 30
          n.y = (parent.y ?? 0) + (Math.random() - 0.5) * 30
        }
      }
    }
    return { nodes: view.nodes, links: view.links }
  }, [view, flow, byId])

  // leaving the flow layout releases its pins (except ones the user pinned by hand)
  useEffect(() => {
    if (!flow) return
    return () => {
      for (const id of flow.ids) {
        if (pinned.current.has(id)) continue
        const n = model.nodeCache.get(id)
        if (n) { n.fx = undefined; n.fy = undefined }
      }
    }
  }, [flow, model])

  // ---------------------------------------------------------------- highlight sets
  const hk = hoverKey ?? hover?.id ?? null
  const fk = hk ?? focus
  const focusSet = useMemo(() => {
    if (pathNodes) return pathNodes
    if (!fk || !byId.has(fk)) return null
    const s = new Set<string>([fk])
    for (const l of view.links) {
      const a = nid(l.source), b = nid(l.target)
      if (a === fk) s.add(b)
      if (b === fk) s.add(a)
    }
    return s
  }, [fk, view.links, byId, pathNodes])

  // ---------------------------------------------------------------- forces
  useEffect(() => {
    const f = fg.current
    if (!f) return
    const charge = f.d3Force('charge') as { strength: (v: number) => unknown; distanceMax?: (v: number) => unknown } | undefined
    charge?.strength(effGran === 'modules' ? -700 : effGran === 'files' ? -140 : -38)
    charge?.distanceMax?.(effGran === 'modules' ? 1500 : 420)
    const link = f.d3Force('link') as { distance: (fn: (l: VLink) => number) => { strength: (fn: (l: VLink) => number) => unknown } } | undefined
    link?.distance((l) => (effGran === 'modules' ? 200 : l.kind === 'contains' ? 14 : l.kind === 'cochange' ? 70 : effGran === 'files' ? 80 : 42))
      .strength((l) => (effGran === 'modules' ? 0.03 : l.kind === 'contains' ? 0.9 : l.kind === 'cochange' ? 0.04 : 0.12))
    f.d3Force('cluster', grouping && mode.kind === 'map' && effGran !== 'modules' ? clusterForce(effGran === 'files' ? 0.12 : 0.2) as never : null)
    f.d3Force('collide', effGran === 'modules' ? collideForce(90) as never : null)
    f.d3ReheatSimulation()
  }, [effGran, grouping, mode.kind, data])

  const fitted = useRef(false)
  const modeKey = mode.kind === 'flow' ? `flow:${mode.center}` : mode.kind
  useEffect(() => { fitted.current = false }, [effGran, hideTests, effScope, modeKey])

  // ---------------------------------------------------------------- colours
  const heatMax = useMemo(() => Math.max(0.0001, ...view.nodes.map((n) => n.heat)), [view])
  const commColor = useCallback((c: number) => (c >= 0 && c < SERIES.length ? C[SERIES[c]] : C['s-other']), [C])
  const nodeColor = useCallback((n: VNode) => {
    if (colorBy === 'heat') {
      if (n.heat <= 0.001) return C['surface-3']
      const ramp = theme === 'dark' ? HEAT_DARK : HEAT_LIGHT
      return ramp[Math.min(ramp.length - 1, Math.floor(Math.sqrt(n.heat / heatMax) * ramp.length))]
    }
    if (colorBy === 'kind' && n.kind !== 'module') return C[SERIES[KIND_SLOT[n.kind]]]
    return commColor(n.c)
  }, [colorBy, C, theme, heatMax, commColor])

  const topLabels = useMemo(() => new Set([...view.nodes].sort((a, b) => b.pr - a.pr)
    .slice(0, effGran === 'files' ? 30 : 18).map((n) => n.id)), [view, effGran])

  // ---------------------------------------------------------------- drawing
  const drawNode = useCallback((n: VNode, ctx: CanvasRenderingContext2D, scale: number) => {
    const r = n.size
    const x = n.x ?? 0, y = n.y ?? 0
    const dim = !!focusSet && !focusSet.has(n.id)
    ctx.globalAlpha = n.ghost ? 0.55 : dim ? 0.14 : n.ext ? 0.5 : 1
    const off = Math.max(1, 2.2 / Math.sqrt(scale)) * (n.kind === 'module' ? 2 : 1)
    const shape = () => {
      ctx.beginPath()
      if (n.kind === 'class') ctx.rect(x - r, y - r, 2 * r, 2 * r)
      else if (n.kind === 'file' && effGran !== 'files') {
        ctx.moveTo(x, y - r * 1.25); ctx.lineTo(x + r * 1.25, y); ctx.lineTo(x, y + r * 1.25); ctx.lineTo(x - r * 1.25, y); ctx.closePath()
      } else ctx.arc(x, y, r, 0, 2 * Math.PI)
    }
    if (!n.ghost && !dim) {
      ctx.save(); ctx.translate(off, off); shape(); ctx.fillStyle = C['shadow-c']; ctx.fill(); ctx.restore()
    }
    if (n.changed && !dim) {
      ctx.beginPath(); ctx.arc(x, y, r + (n.kind === 'module' ? 7 : 4.5), 0, 2 * Math.PI); ctx.fillStyle = C.yellow; ctx.fill()
      ctx.lineWidth = 1.2; ctx.strokeStyle = C.line; ctx.stroke()
    }
    shape()
    ctx.fillStyle = n.ghost ? C.surface : nodeColor(n)
    ctx.fill()
    ctx.lineWidth = (n.kind === 'module' ? 2.6 : Math.max(0.8, 1.6 / Math.sqrt(scale)))
    ctx.strokeStyle = n.ghost ? C.red : C.line
    if (n.ghost || n.ext) ctx.setLineDash([2.5, 2])
    ctx.stroke()
    ctx.setLineDash([])
    if (n.kind === 'method') { ctx.beginPath(); ctx.arc(x, y, Math.max(0.9, r * 0.32), 0, 2 * Math.PI); ctx.fillStyle = C.line; ctx.fill() }
    if (n.isNew && !n.ghost) {
      ctx.beginPath(); ctx.arc(x, y, r + 2.5, 0, 2 * Math.PI); ctx.lineWidth = 2.2; ctx.strokeStyle = C.lime; ctx.stroke()
    }
    const isFocus = hk === n.id || focus === n.id

    if (n.kind === 'module') {
      // number inside, name below: modules are always labelled
      ctx.globalAlpha = dim ? 0.3 : 1
      if (r * scale > 14) {
        ctx.font = `700 ${Math.min(r * 0.62, 15 / scale * 1.4)}px "Space Grotesk", sans-serif`
        ctx.fillStyle = '#0a0a0a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(fmt(n.members ?? 0), x, y + 0.5)
      }
      const fs = 13 / scale * (isFocus ? 1.1 : 1)
      ctx.font = `700 ${fs}px "Space Grotesk", sans-serif`
      const w = ctx.measureText(n.name).width
      const pad = 4 / scale
      const bx = x - w / 2 - pad, by = y + r + 6 / scale
      ctx.fillStyle = C['shadow-c']; ctx.fillRect(bx + 2 / scale, by + 2 / scale, w + pad * 2, fs + pad * 1.6)
      ctx.fillStyle = isFocus ? C.yellow : C.surface; ctx.fillRect(bx, by, w + pad * 2, fs + pad * 1.6)
      ctx.lineWidth = 1.4 / scale; ctx.strokeStyle = C.line; ctx.strokeRect(bx, by, w + pad * 2, fs + pad * 1.6)
      ctx.fillStyle = isFocus ? '#0a0a0a' : C.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'top'
      ctx.fillText(n.name, x, by + pad * 0.8)
      ctx.globalAlpha = 1
      return
    }

    const always = mode.kind === 'flow' || (pathNodes?.has(n.id) ?? false)
    const show = isFocus || always || (!dim && ((topLabels.has(n.id) && scale > 0.7) || scale * r > 13 || (!!focusSet && focusSet.has(n.id) && scale > 0.9)))
    if (show) {
      const name = n.kind === 'file' ? n.name : n.name + (n.kind === 'class' ? '' : '()')
      const fs = (12 / scale) * (isFocus ? 1.15 : 1)
      ctx.font = `700 ${fs}px "JetBrains Mono", monospace`
      const w = ctx.measureText(name).width
      const pad = 3 / scale
      const bx = x - w / 2 - pad, by = y + r + 4 / scale
      ctx.globalAlpha = n.ghost ? 0.6 : n.ext ? 0.7 : 1
      ctx.fillStyle = isFocus ? C.yellow : C.surface
      ctx.fillRect(bx, by, w + pad * 2, fs + pad * 1.6)
      ctx.lineWidth = 1 / scale; ctx.strokeStyle = C.line
      ctx.strokeRect(bx, by, w + pad * 2, fs + pad * 1.6)
      ctx.fillStyle = isFocus ? '#0a0a0a' : C.ink
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'
      ctx.fillText(name, x, by + pad * 0.8)
    }
    ctx.globalAlpha = 1
  }, [C, nodeColor, focusSet, hk, focus, topLabels, effGran, mode.kind, pathNodes])

  const edgeDir = useCallback((l: VLink): 'in' | 'out' | null => {
    if (!fk || l.kind === 'contains' || l.kind === 'cochange') return null
    if (nid(l.target) === fk) return 'in'
    if (nid(l.source) === fk) return 'out'
    return null
  }, [fk])

  const linkColor = useCallback((l: VLink) => {
    const a = nid(l.source), b = nid(l.target)
    if (pathEdges) return pathEdges.has(`${a}|${b}`) ? '#f2b705' : hexA(C['ink-3'], 0.08)
    if (l.ghost) return hexA(C.red, focusSet ? 0.2 : 0.9)
    const dir = edgeDir(l)
    if (dir) return dir === 'in' ? C['in-c'] : C['out-c']
    const touching = fk && (a === fk || b === fk)
    const dim = !!focusSet && !touching
    const slot = EDGE_SLOT[l.kind]
    const base = l.kind === 'calls' ? C.ink : slot >= 0 ? C[SERIES[slot]] : C['ink-3']
    const alpha = l.kind === 'contains' ? 0.22 : l.kind === 'cochange' ? 0.55 : effGran === 'modules' ? 0.6 : 0.5
    return hexA(base, dim ? alpha * 0.15 : l.fresh ? 1 : alpha)
  }, [C, focusSet, fk, edgeDir, pathEdges, effGran])

  const linkWidth = useCallback((l: VLink) => {
    if (pathEdges?.has(`${nid(l.source)}|${nid(l.target)}`)) return 4.5
    const focused = edgeDir(l) ? 1.4 : 0
    if (l.kind === 'cochange') return Math.min(7, 1 + l.w * 3.2)
    if (l.kind === 'contains') return 0.6
    if (effGran === 'modules') return Math.min(9, 1 + l.w * 1.2) + focused
    const base = effGran === 'files' ? Math.min(5, 0.6 + l.w) : 1
    return (l.fresh || l.ghost ? base + 1.4 : base) + focused
  }, [effGran, edgeDir, pathEdges])

  const hullStyle = useMemo(() => ({ color: commColor, label: (c: number) => model.label(c), ink: C['shadow-c'], line: C.line, hexA }), [commColor, model, C])
  const onRenderPre = useCallback((ctx: CanvasRenderingContext2D, scale: number) => {
    if (!grouping || mode.kind !== 'map' || effGran === 'modules') return
    drawHulls(ctx, data.nodes, scale, hullStyle, null, 'shapes')
  }, [grouping, mode.kind, effGran, data, hullStyle])

  const onRenderPost = useCallback((ctx: CanvasRenderingContext2D, scale: number) => {
    if (grouping && mode.kind === 'map' && effGran !== 'modules') drawHulls(ctx, data.nodes, scale, hullStyle, null, 'labels')
    if (path) drawPathBadges(ctx, path.nodes, byId, scale, C.line)
    if (flow) drawHeaders(ctx, flow.headers, scale, C.ink)
  }, [path, flow, byId, C, grouping, mode.kind, effGran, data, hullStyle])

  // ---------------------------------------------------------------- navigation helpers
  const flyTo = useCallback((id: string, select = true) => {
    const n = byIdRef.current.get(id)
    if (select) setFocus(id)
    if (n && n.x !== undefined && fg.current) {
      fg.current.centerAt(n.x, n.y, 600)
      fg.current.zoom(effGran === 'files' ? 2.2 : 3.2, 600)
    }
  }, [setFocus, effGran])

  useEffect(() => {
    const id = pendingFly.current
    if (!id) return
    const t = setTimeout(() => { pendingFly.current = null; flyTo(id) }, 900)
    return () => clearTimeout(t)
  }, [data, flyTo])

  const openModule = useCallback((c: number) => {
    setMode({ kind: 'map' }); setScope(c); setGranularity('symbols'); setFocus(null); setHover(null)
  }, [setFocus])
  const toOverview = useCallback(() => {
    setMode({ kind: 'map' }); setScope(null); setGranularity('modules'); setFocus(null); setHover(null)
  }, [setFocus])
  const startFlow = useCallback((id: string) => { setMode({ kind: 'flow', center: id }); setFocus(id); setHover(null) }, [setFocus])
  const startPath = useCallback((id: string) => { setMode({ kind: 'path', from: id, to: null }); setFocus(id); setPathQ(''); setHover(null) }, [setFocus])
  const leaveMode = useCallback(() => { setMode({ kind: 'map' }); setHover(null) }, [])

  /** Search every live symbol at τ; jump into the symbol view if it isn't on screen. */
  const results = useMemo(() => {
    if (!q.trim()) return []
    const s = q.toLowerCase()
    return temporal.nodes
      .filter((n) => alive(n.iv, tau) && !(hideTests && n.test) && (n.name.toLowerCase().includes(s) || n.id.toLowerCase().includes(s)))
      .sort((a, b) => (a.name.toLowerCase().startsWith(s) ? -1 : 0) - (b.name.toLowerCase().startsWith(s) ? -1 : 0) || b.pr - a.pr)
      .slice(0, 12)
  }, [q, temporal, tau, hideTests])
  const goToSymbol = useCallback((id: string) => {
    setQOpen(false)
    if (byIdRef.current.has(id) && effGran !== 'modules') { flyTo(id); return }
    const node = temporal.nodes.find((n) => n.id === id)
    setMode({ kind: 'map' }); setScope(null); setGranularity(node?.kind === 'file' ? 'files' : 'symbols'); setFocus(id)
    pendingFly.current = id
  }, [flyTo, effGran, temporal, setFocus])

  const pathResults = useMemo(() => {
    if (mode.kind !== 'path' || !pathQ.trim()) return []
    const s = pathQ.toLowerCase()
    return view.nodes.filter((n) => !n.ghost && n.id !== mode.from && (n.name.toLowerCase().includes(s) || n.id.toLowerCase().includes(s)))
      .sort((a, b) => b.pr - a.pr).slice(0, 8)
  }, [pathQ, view, mode])

  // ---------------------------------------------------------------- keyboard & fullscreen
  const fullRef = useRef(full)
  fullRef.current = full
  const escRef = useRef<() => void>(() => undefined)
  escRef.current = () => {
    if (howto) setHowto(false)
    else if (mode.kind !== 'map') leaveMode()
    else if (fullRef.current) setFull(false)
    else if (focus) setFocus(null)
    else if (scope != null || granularity !== 'modules') toOverview()
    setQOpen(false)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); document.getElementById('gx-search')?.focus() }
      const typing = (e.target as HTMLElement)?.closest('input, textarea, select')
      if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setFull((f) => !f) }
      if (!typing && e.key === '?') setHowto((h) => !h)
      if (e.key === 'Escape') escRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    try {
      if (full && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => undefined)
      if (!full && document.fullscreenElement) document.exitFullscreen?.().catch(() => undefined)
    } catch { /* fullscreen API unavailable: the overlay still fills the window */ }
    document.body.style.overflow = full ? 'hidden' : ''
    const t = setTimeout(() => fg.current?.zoomToFit(500, 60), 650)
    return () => clearTimeout(t)
  }, [full])
  useEffect(() => {
    const onChange = () => { if (!document.fullscreenElement) setFull(false) }
    document.addEventListener('fullscreenchange', onChange)
    return () => { document.removeEventListener('fullscreenchange', onChange); document.body.style.overflow = '' }
  }, [])

  // ---------------------------------------------------------------- pointer: pick, click, drag, right-click
  const dragRef = useRef<{ n: VNode; moved: boolean; x0: number; y0: number } | null>(null)
  const downAt = useRef<{ x: number; y: number } | null>(null)
  const canvasEl = () => wrap.current?.querySelector('canvas') ?? null
  const pick = (e: { clientX: number; clientY: number }) =>
    pickNode(fg.current, canvasEl(), e.clientX, e.clientY, data.nodes, (n) => n.size * (n.kind === 'file' && effGran !== 'files' ? 1.25 : 1) + 1.5)
  const setCursor = (c: string) => { const el = canvasEl(); if (el) el.style.cursor = c }

  const activate = (n: VNode) => {
    if (n.kind === 'module') { openModule(n.c); return }
    if (mode.kind === 'path' && !mode.to && n.id !== mode.from) { setMode({ ...mode, to: n.id }); return }
    if (mode.kind === 'flow' && n.id !== mode.center) { startFlow(n.id); return }
    setFocus(n.id)
    setQOpen(false)
  }

  const onMouseDownCapture = (e: React.MouseEvent) => {
    if (!(e.target instanceof HTMLCanvasElement) || e.button !== 0) return
    downAt.current = { x: e.clientX, y: e.clientY }
    setMenu(null)
    const n = pick(e)
    if (!n) return
    e.stopPropagation() // keep d3-zoom from panning while we drag a node
    dragRef.current = { n, moved: false, x0: e.clientX, y0: e.clientY }
    const move = (ev: MouseEvent) => {
      const d = dragRef.current
      const c = canvasEl()
      if (!d || !c || !fg.current) return
      if (!d.moved && Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) < 4) return
      d.moved = true
      setCursor('grabbing')
      const r = c.getBoundingClientRect()
      const p = fg.current.screen2GraphCoords(ev.clientX - r.left, ev.clientY - r.top)
      d.n.fx = p.x
      d.n.fy = p.y
      fg.current.d3ReheatSimulation()
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      const d = dragRef.current
      dragRef.current = null
      if (!d) return
      if (d.moved) { pinned.current.add(d.n.id); setCursor('pointer') } // stays where it was dropped
      else activate(d.n)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  const onCanvasClick = (e: React.MouseEvent) => {
    if (!(e.target instanceof HTMLCanvasElement) || !downAt.current) return
    const panned = Math.hypot(e.clientX - downAt.current.x, e.clientY - downAt.current.y) > 4
    if (!panned && !pick(e) && mode.kind === 'map') { setFocus(null); setQOpen(false) }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragRef.current || menu) return
    const n = e.target instanceof HTMLCanvasElement ? pick(e) : null
    if ((n?.id ?? null) !== (hover?.id ?? null)) setHover(n)
    if (e.target instanceof HTMLCanvasElement) setCursor(n ? 'pointer' : 'grab')
  }
  const onContextMenu = (e: React.MouseEvent) => {
    if (!(e.target instanceof HTMLCanvasElement)) return
    e.preventDefault()
    const n = pick(e)
    const r = wrap.current!.getBoundingClientRect()
    setHover(null)
    setMenu(n ? { node: n, x: e.clientX - r.left, y: e.clientY - r.top } : null)
  }

  const ghUrl = temporal.repo.kind === 'github' ? `https://github.com/${temporal.repo.owner}/${temporal.repo.repo}` : null
  const onMenu = (a: MenuAction) => {
    if (!menu) return
    const n = menu.node
    switch (a) {
      case 'focus': flyTo(n.id); break
      case 'open': openModule(n.c); break
      case 'flow': startFlow(n.id); break
      case 'path': startPath(n.id); break
      case 'hide': setHidden((h) => new Set(h).add(n.id)); if (focus === n.id) setFocus(null); break
      case 'pin': n.fx = n.x; n.fy = n.y; pinned.current.add(n.id); break
      case 'unpin': n.fx = undefined; n.fy = undefined; pinned.current.delete(n.id); fg.current?.d3ReheatSimulation(); break
      case 'github': if (ghUrl) window.open(`${ghUrl}/blob/${temporal.commits[tau].sha}/${n.path}${n.start ? `#L${n.start}` : ''}`, '_blank', 'noopener'); break
      case 'copy': navigator.clipboard?.writeText(n.kind === 'module' ? n.name : splitKey(n.id).sym || n.path); break
    }
  }

  const fitPad = effGran === 'modules' ? 120 : mode.kind === 'flow' ? 80 : 50
  const zoomBy = (f: number) => { const z = fg.current?.zoom(); if (z) fg.current?.zoom(z * f, 250) }

  // ---------------------------------------------------------------- legend & hover card
  const legend = colorBy === 'heat'
    ? [{ label: 'cold', color: (theme === 'dark' ? HEAT_DARK : HEAT_LIGHT)[0] }, { label: 'warm', color: (theme === 'dark' ? HEAT_DARK : HEAT_LIGHT)[3] }, { label: 'hot · recently changed', color: (theme === 'dark' ? HEAT_DARK : HEAT_LIGHT)[6] }]
    : colorBy === 'kind' && effGran !== 'modules'
      ? (['file', 'class', 'function', 'method'] as const).map((k) => ({ label: KIND_LABEL[k], color: C[SERIES[KIND_SLOT[k]]] }))
      : temporal.communities.slice(0, 8).map((c, i) => ({ label: c.label, color: C[SERIES[i]] })).concat([{ label: 'other', color: C['s-other'] }])

  const hovered = hk ? byId.get(hk) ?? null : null
  const hoverAt = hovered && hovered.x !== undefined && fg.current && !menu ? fg.current.graph2ScreenCoords(hovered.x, hovered.y ?? 0) : null
  const focusNode = fk ? byId.get(fk) : undefined
  const k = view.counts
  const scopeLabel = effScope != null ? model.label(effScope) : null

  return (
    <div className={full ? 'gx-full' : 'gx-wrap'}>
      <TimeScrubber temporal={temporal} tau={tau} setTau={setTau} since={since} setSince={setSince} extra={
        <div className="row wrap" style={{ gap: 8, fontSize: 12.5 }}>
          <span className="badge">{fmt(k.nodes)} {effGran === 'modules' ? 'modules' : 'nodes'}</span>
          <span className="badge">{fmt(k.edges)} edges</span>
          <span className="badge" style={{ background: 'var(--s2)', color: '#fff' }}>{fmt(k.cochange)} co-change</span>
          {(tau > 0 || since != null) && <>
            {since != null && <span className="badge fill-cyan">c{effSince} → c{tau}</span>}
            <span className="badge fill-lime">+{fmt(k.born)} symbols / +{fmt(k.opened)} edges</span>
            <span className="badge" style={{ background: 'var(--red)', color: '#0a0a0a' }}>−{fmt(k.died)} symbols / −{fmt(k.closed)} edges</span>
            <span className="badge fill-yellow">{fmt(k.changed)} symbols changed</span>
          </>}
          <span className="muted" style={{ marginLeft: 'auto' }}>←/→ step · space plays · F fullscreen · ? help</span>
        </div>
      } />

      <div className={`gx ${focus && mode.kind !== 'path' ? '' : 'nodrawer'}`}>
        <div className="card canvas-card" ref={wrap} onMouseDownCapture={onMouseDownCapture} onClick={onCanvasClick}
          onPointerMove={onPointerMove} onPointerLeave={() => { if (!dragRef.current) setHover(null) }} onContextMenu={onContextMenu}>
          <div className="gx-toolbar">
            <div className="gx-row">
              <div style={{ position: 'relative' }}>
                <div className="input-wrap" style={{ width: 260 }}>
                  <Search size={16} strokeWidth={2.6} style={{ left: 11 }} />
                  <input id="gx-search" className="input" style={{ height: 38, paddingLeft: 34, fontSize: 13.5, boxShadow: '3px 3px 0 var(--shadow-c)' }}
                    placeholder="Find symbol…  ⌘K" value={q}
                    onChange={(e) => { setQ(e.target.value); setQOpen(true); setQSel(0) }}
                    onFocus={() => setQOpen(true)}
                    onBlur={() => setTimeout(() => setQOpen(false), 150)}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown') { setQSel((s) => Math.min(results.length - 1, s + 1)); e.preventDefault() }
                      if (e.key === 'ArrowUp') { setQSel((s) => Math.max(0, s - 1)); e.preventDefault() }
                      if (e.key === 'Enter' && results[qSel]) goToSymbol(results[qSel].id)
                    }} />
                </div>
                {qOpen && results.length > 0 && (
                  <div className="gx-panel search-pop" role="listbox">
                    {results.map((r, i) => (
                      <button key={r.id} className={i === qSel ? 'sel' : ''} onMouseDown={(e) => { e.preventDefault(); goToSymbol(r.id) }}>
                        <KindGlyph kind={r.kind} color={commColor(r.c)} size={14} />
                        <b className="mono">{r.name}</b>
                        <span className="muted ellipsis" style={{ fontSize: 11.5 }}>{r.path}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {mode.kind === 'map' && (
                <div className="gx-panel row" style={{ gap: 8, padding: '5px 8px' }}>
                  <Layers size={15} />
                  <Seg value={granularity} onChange={(g) => { setGranularity(g); if (g === 'modules') setScope(null) }}
                    options={[{ value: 'modules', label: 'Modules' }, { value: 'files', label: 'Files' }, { value: 'symbols', label: 'Symbols' }]} />
                </div>
              )}
              <div className="gx-panel row" style={{ gap: 8, padding: '5px 8px' }}>
                <Eye size={15} />
                <Seg value={colorBy} onChange={setColorBy} options={[{ value: 'community', label: 'Module' }, { value: 'kind', label: 'Kind' }, { value: 'heat', label: 'Heat' }]} />
              </div>
            </div>

            <nav className="crumbs gx-panel" aria-label="Where you are">
              <button className={effGran === 'modules' && mode.kind === 'map' ? 'on' : ''} onClick={toOverview}>All modules</button>
              {scopeLabel && <><ChevronRight size={14} /><button className={mode.kind === 'map' ? 'on' : ''} onClick={leaveMode}>
                <span className="swatch" style={{ background: commColor(effScope!), width: 10, height: 10 }} /> {scopeLabel}</button></>}
              {mode.kind === 'map' && effGran !== 'modules' && !scopeLabel && <><ChevronRight size={14} /><span className="crumb-txt">every {effGran === 'files' ? 'file' : 'symbol'}</span></>}
              {mode.kind === 'flow' && <><ChevronRight size={14} /><span className="crumb-txt"><GitFork size={13} /> flow of <b className="mono">{label(mode.center)}</b>
                {flow && <span className="muted"> · {flow.callers} callers · {flow.callees} callees · {flow.partners} co-change</span>}</span></>}
              {mode.kind === 'path' && <><ChevronRight size={14} /><span className="crumb-txt"><Route size={13} /> path from <b className="mono">{label(mode.from)}</b></span></>}
              {mode.kind !== 'map' && <button className="crumb-back" onClick={leaveMode}><Undo2 size={13} /> Back to map</button>}
              {effScope != null && mode.kind === 'map' && <span className="muted crumb-hint">faded = outside this module</span>}
            </nav>

            {mode.kind === 'path' && (
              <div className="pathpanel gx-panel">
                {!mode.to ? (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>…to which symbol? Click one on the graph, or search:</div>
                    <input className="input" autoFocus style={{ height: 34, fontSize: 13 }} placeholder="e.g. wsgi_app" value={pathQ} onChange={(e) => setPathQ(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && pathResults[0]) setMode({ ...mode, to: pathResults[0].id }) }} />
                    {pathResults.map((r) => (
                      <button key={r.id} className="nb-row" style={{ width: '100%', background: 'none', border: 0, textAlign: 'left' }} onClick={() => setMode({ ...mode, to: r.id })}>
                        <KindGlyph kind={r.kind} color={commColor(r.c)} size={13} /><b className="mono">{r.name}</b>
                        <span className="muted ellipsis" style={{ fontSize: 11 }}>{r.path}</span>
                      </button>
                    ))}
                  </>
                ) : path ? (
                  <>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{path.hops.length} step{path.hops.length === 1 ? '' : 's'} from <span className="mono">{label(mode.from)}</span> to <span className="mono">{label(mode.to)}</span></div>
                    <ol className="hops">
                      {path.nodes.map((id, i) => (
                        <li key={id}>
                          <button className="hop-node mono" onClick={() => flyTo(id, false)}><span className="hop-n">{i + 1}</span>{label(id)}</button>
                          {i < path.hops.length && (
                            <span className="hop-edge">{path.hops[i].forward ? `—${EDGE_LABEL[path.hops[i].kind]}→` : `←${EDGE_LABEL[path.hops[i].kind]}—`}</span>
                          )}
                        </li>
                      ))}
                    </ol>
                  </>
                ) : (
                  <div style={{ fontSize: 13 }}>No connection between <b className="mono">{label(mode.from)}</b> and <b className="mono">{label(mode.to)}</b> through
                    {pathCC ? ' code or co-change' : ' calls, imports or inheritance'} at τ = {tau}.{!pathCC && ' Try including co-change.'}</div>
                )}
                <div className="row wrap" style={{ gap: 8 }}>
                  <Switch checked={pathCC} onChange={setPathCC}>Include co-change</Switch>
                  {mode.to && <button className="btn sm" onClick={() => setMode({ ...mode, to: null })}>Change target</button>}
                  {mode.to && <button className="btn sm" onClick={() => setMode({ kind: 'path', from: mode.to!, to: mode.from })}>Swap</button>}
                  <button className="btn sm icon" onClick={leaveMode} aria-label="Close path finder"><X size={14} /></button>
                </div>
              </div>
            )}

            {hidden.size > 0 && (
              <button className="chip" onClick={() => setHidden(new Set())} style={{ height: 30 }}><Eye size={13} /> Unhide {hidden.size} node{hidden.size === 1 ? '' : 's'}</button>
            )}
          </div>

          <Coach />

          <ForceGraph2D<VNode, VLink>
            ref={fg}
            graphData={data}
            width={size.w}
            height={size.h}
            backgroundColor="rgba(0,0,0,0)"
            nodeId="id"
            nodeRelSize={1}
            nodeVal={(n) => n.size * n.size}
            nodeCanvasObject={drawNode}
            onRenderFramePre={onRenderPre}
            onRenderFramePost={onRenderPost}
            linkColor={linkColor}
            linkWidth={linkWidth}
            linkLineDash={(l) => (l.ghost ? [3, 3] : l.kind === 'imports' && effGran !== 'modules' ? [4, 3] : null)}
            linkCurvature={(l) => (l.kind === 'cochange' ? 0.28 : effGran === 'modules' || mode.kind === 'flow' ? 0.12 : 0)}
            linkDirectionalArrowLength={(l) => (l.kind === 'calls' || l.kind === 'inherits' ? (effGran === 'modules' ? 9 : effGran === 'files' ? 5 : 3.4) : 0)}
            linkDirectionalArrowRelPos={0.9}
            linkDirectionalArrowColor={linkColor}
            linkDirectionalParticles={(l) => (edgeDir(l) || pathEdges?.has(`${nid(l.source)}|${nid(l.target)}`) ? 3 : 0)}
            linkDirectionalParticleWidth={(l) => (effGran === 'modules' ? 5 : pathEdges ? 4 : 3) + (l.w > 3 ? 1 : 0)}
            linkDirectionalParticleColor={linkColor}
            linkDirectionalParticleSpeed={0.007}
            enablePointerInteraction={false}
            cooldownTicks={mode.kind === 'flow' ? 30 : 140}
            d3AlphaDecay={0.035}
            d3VelocityDecay={0.32}
            warmupTicks={effGran === 'modules' ? 80 : effGran === 'files' ? 40 : 20}
            onEngineStop={() => { if (!fitted.current) { fg.current?.zoomToFit(500, fitPad); fitted.current = true } }}
            enableNodeDrag={false}
          />

          {hovered && hoverAt && !dragRef.current && (
            <HoverCard node={hovered} x={hoverAt.x} y={hoverAt.y} width={size.w} color={nodeColor(hovered)}
              label={model.label(hovered.c)} heatMax={heatMax} tau={tau} moduleView={hovered.kind === 'module'} />
          )}
          {menu && (
            <ContextMenu node={menu.node} x={menu.x} y={menu.y} width={size.w} height={size.h} pinned={menu.node.fx !== undefined}
              hasGithub={!!ghUrl && menu.node.kind !== 'module'} onAction={onMenu} onClose={() => setMenu(null)} />
          )}
          {howto && <HowToRead onClose={() => setHowto(false)} colorBy={colorBy} />}

          <div className="gx-legend gx-panel col" style={{ gap: 8 }}>
            <div className="row wrap" style={{ gap: 6 }}>
              {LINK_KINDS.map((lk) => {
                const slot = EDGE_SLOT[lk]
                const col = lk === 'calls' ? 'var(--ink)' : slot >= 0 ? `var(--${SERIES[slot]})` : 'var(--ink-3)'
                return (
                  <button key={lk} className={`edge-toggle ${edgeOn[lk] ? '' : 'off'}`} onClick={() => setEdgeOn((e) => ({ ...e, [lk]: !e[lk] }))} aria-pressed={edgeOn[lk]}>
                    <span className="ln" style={{ color: col, borderTopStyle: lk === 'imports' ? 'dashed' : 'solid', borderTopWidth: lk === 'cochange' ? 5 : 3 }} />
                    {EDGE_LABEL[lk]}
                  </button>
                )
              })}
              <button className="edge-toggle" onClick={() => setLegendOpen((o) => !o)} aria-expanded={legendOpen}>{legendOpen ? 'Less ▾' : 'More ▸'}</button>
            </div>
            {legendOpen && <><div className="row wrap" style={{ gap: 12, fontSize: 12 }}>
              {legend.map((it) => (
                <span key={it.label} className="row" style={{ gap: 5, maxWidth: 190 }}>
                  <span className="swatch" style={{ background: it.color, borderRadius: 6 }} />
                  <span className="ellipsis">{it.label}</span>
                </span>
              ))}
            </div>
            <div className="row wrap" style={{ gap: 14, fontSize: 12 }}>
              <Switch checked={grouping} onChange={setGrouping}>Group by module</Switch>
              <Switch checked={hideTests} onChange={setHideTests}>Hide tests</Switch>
              <label className="row" style={{ gap: 6 }}>
                co-change ≥
                <input className="range" type="range" min={0.05} max={1.5} step={0.05} value={ccThreshold} onChange={(e) => setCcThreshold(+e.target.value)} style={{ width: 90 }} aria-label="Co-change weight threshold" />
                <span className="mono">{ccThreshold.toFixed(2)}</span>
              </label>
            </div></>}
          </div>

          <div className="gx-fullbtn row" style={{ gap: 8 }}>
            <button className={`btn icon ${howto ? 'pressed' : ''}`} onClick={() => setHowto(!howto)} title="How to read this graph (?)" aria-label="How to read this graph"><CircleHelp size={18} strokeWidth={2.4} /></button>
            <button className={`btn ${full ? 'pink' : 'primary'}`} onClick={() => setFull(!full)} title={full ? 'Exit fullscreen (Esc)' : 'Fullscreen (F)'}>
              {full ? <Minimize size={17} strokeWidth={2.6} /> : <Maximize size={17} strokeWidth={2.6} />} {full ? 'Exit' : 'Fullscreen'}
            </button>
          </div>
          <div className="gx-hud">
            {focusNode && focusNode.kind !== 'module' && (
              <span className="focus-chip">
                <span style={{ color: 'var(--in-c)' }}>← used by <b>{focusNode.inDeg}</b></span>
                <span className="muted">·</span>
                <span style={{ color: 'var(--out-c)' }}>uses <b>{focusNode.outDeg}</b> →</span>
              </span>
            )}
            {focus && mode.kind === 'map' && <button className="btn sm" onClick={() => flyTo(focus)}><Crosshair size={14} /> Focus</button>}
            <button className="btn sm icon" onClick={() => zoomBy(1.4)} aria-label="Zoom in" title="Zoom in"><ZoomIn size={15} /></button>
            <button className="btn sm icon" onClick={() => zoomBy(1 / 1.4)} aria-label="Zoom out" title="Zoom out"><ZoomOut size={15} /></button>
            <button className="btn sm" onClick={() => fg.current?.zoomToFit(500, fitPad)}><Scan size={14} /> Fit</button>
          </div>
        </div>
        {focus && mode.kind !== 'path' && byId.get(focus)?.kind !== 'module' && (
          <NodeDrawer ws={ws} nodeKey={focus} onClose={() => { setFocus(null); if (mode.kind === 'flow') leaveMode() }}
            onPick={(id) => (mode.kind === 'flow' ? startFlow(id) : flyTo(id))}
            onFlow={startFlow} onPath={startPath} onHoverKey={setHoverKey} />
        )}
      </div>
    </div>
  )
}

function hexA(color: string, a: number): string {
  const c = color.trim()
  if (c.startsWith('#') && (c.length === 7 || c.length === 4)) {
    const full = c.length === 4 ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}` : c
    const r = parseInt(full.slice(1, 3), 16), g = parseInt(full.slice(3, 5), 16), b = parseInt(full.slice(5, 7), 16)
    return `rgba(${r},${g},${b},${a})`
  }
  return c
}
