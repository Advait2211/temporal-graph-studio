// Things painted on the graph canvas around the nodes: module hulls, labels, path numbers, flow headers.
import type { VNode } from './temporal'

type Pt = [number, number]

/** Andrew's monotone chain convex hull. */
export function convexHull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Pt[] = []
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop()
    lower.push(pt)
  }
  const upper: Pt[] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop()
    upper.push(pt)
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

export interface HullStyle {
  color: (c: number) => string
  label: (c: number) => string
  ink: string
  line: string
  hexA: (color: string, a: number) => string
}

/**
 * One soft, padded hull per community behind its nodes, with a sticker label on top.
 * The padding comes from stroking the hull with a thick round-joined line.
 */
export function drawHulls(ctx: CanvasRenderingContext2D, nodes: VNode[], scale: number, st: HullStyle, focus: Set<number> | null) {
  const groups = new Map<number, Pt[]>()
  for (const n of nodes) {
    if (n.ghost || n.ext || n.x === undefined || n.y === undefined || n.c < 0) continue
    const g = groups.get(n.c)
    if (g) g.push([n.x, n.y])
    else groups.set(n.c, [[n.x, n.y]])
  }
  const labels: { x: number; y: number; c: number; n: number }[] = []
  for (const [c, pts] of groups) {
    if (pts.length < 3) continue
    const hull = convexHull(pts)
    const pad = 16
    const faded = focus && !focus.has(c)
    const col = st.color(c)
    ctx.save()
    ctx.globalAlpha = faded ? 0.35 : 1
    ctx.beginPath()
    hull.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
    ctx.closePath()
    ctx.lineJoin = 'round'
    ctx.lineWidth = pad * 2
    ctx.strokeStyle = st.hexA(col, 0.1)
    ctx.fillStyle = st.hexA(col, 0.1)
    ctx.stroke()
    ctx.fill()
    ctx.restore()
    let cx = 0, minY = Infinity
    for (const [x, y] of pts) { cx += x; minY = Math.min(minY, y) }
    labels.push({ x: cx / pts.length, y: minY - pad - 6 / scale, c, n: pts.length })
  }
  // labels last so they sit above every hull
  for (const l of labels) {
    const faded = focus && !focus.has(l.c)
    const text = st.label(l.c)
    const fs = 12 / scale
    ctx.font = `700 ${fs}px "Space Grotesk", sans-serif`
    const w = ctx.measureText(text).width
    const padX = 6 / scale, h = fs + 6 / scale
    const x = l.x - w / 2 - padX, y = l.y - h
    ctx.globalAlpha = faded ? 0.4 : 1
    ctx.fillStyle = st.ink
    ctx.fillRect(x + 2 / scale, y + 2 / scale, w + padX * 2, h)
    ctx.fillStyle = st.color(l.c)
    ctx.fillRect(x, y, w + padX * 2, h)
    ctx.lineWidth = 1.4 / scale
    ctx.strokeStyle = st.line
    ctx.strokeRect(x, y, w + padX * 2, h)
    ctx.fillStyle = '#0a0a0a'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, x + padX, y + h / 2 + 0.5 / scale)
    ctx.globalAlpha = 1
  }
}

/** Numbered yellow badges on the nodes of a found path. */
export function drawPathBadges(ctx: CanvasRenderingContext2D, ids: string[], byId: Map<string, VNode>, scale: number, line: string) {
  ids.forEach((id, i) => {
    const n = byId.get(id)
    if (!n || n.x === undefined || n.y === undefined) return
    const r = 8 / scale
    const x = n.x - n.size - r * 0.4, y = (n.y ?? 0) - n.size - r * 0.4
    ctx.beginPath()
    ctx.arc(x, y, r, 0, 2 * Math.PI)
    ctx.fillStyle = '#ffd23f'
    ctx.fill()
    ctx.lineWidth = 1.5 / scale
    ctx.strokeStyle = line
    ctx.stroke()
    ctx.fillStyle = '#0a0a0a'
    ctx.font = `700 ${10 / scale}px "JetBrains Mono", monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(i + 1), x, y + 0.5 / scale)
  })
}

/** Column titles for the dependency-flow layout. */
export function drawHeaders(ctx: CanvasRenderingContext2D, headers: { x: number; y: number; text: string }[], scale: number, ink: string) {
  ctx.font = `700 ${11 / scale}px "JetBrains Mono", monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'bottom'
  ctx.fillStyle = ink
  for (const h of headers) ctx.fillText(h.text, h.x, h.y)
}
