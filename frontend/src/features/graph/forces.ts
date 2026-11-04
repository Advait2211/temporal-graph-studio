// Custom layout forces and fixed layouts for the graph explorer.
import type { Adj } from './paths'
import { hops } from './paths'
import type { LinkKind, VNode } from './temporal'

/** Pulls every node toward the centroid of its community, so modules separate into visible groups. */
export function clusterForce(strength: number) {
  let nodes: VNode[] = []
  const force = (alpha: number) => {
    const acc = new Map<number, [number, number, number]>()
    for (const n of nodes) {
      if (n.c < 0 || n.ext || n.x === undefined || n.y === undefined) continue
      const a = acc.get(n.c) ?? [0, 0, 0]
      a[0] += n.x
      a[1] += n.y
      a[2]++
      acc.set(n.c, a)
    }
    const k = strength * alpha
    for (const n of nodes) {
      const a = acc.get(n.c)
      if (!a || a[2] < 2 || n.x === undefined || n.y === undefined || n.fx !== undefined) continue
      n.vx = (n.vx ?? 0) + (a[0] / a[2] - n.x) * k
      n.vy = (n.vy ?? 0) + (a[1] / a[2] - n.y) * k
    }
  }
  force.initialize = (ns: VNode[]) => { nodes = ns }
  return force
}

export interface FlowLayout {
  ids: Set<string>
  pos: Map<string, { x: number; y: number }>
  headers: { x: number; y: number; text: string }[]
  callers: number
  callees: number
  partners: number
}

const COL = 240
const ROW = 30
const PER_COLUMN = 16

/**
 * Left-to-right dependency flow around one symbol:
 * callers (2 hops, 1 hop) | the symbol | callees (1 hop, 2 hops), co-change partners underneath.
 */
export function flowLayout(center: string, adj: Adj, rank: (id: string) => number): FlowLayout {
  const dep = new Set<LinkKind>(['calls', 'inherits', 'imports'])
  const up = hops(adj, center, 'in', 2, dep)
  const down = hops(adj, center, 'out', 2, dep)
  for (const [id, d] of down) if ((up.get(id) ?? 99) <= d) down.delete(id)
  for (const id of down.keys()) up.delete(id)
  const partners = (adj.out.get(center) ?? []).filter((s) => s.kind === 'cochange').map((s) => s.to)
    .filter((id) => !up.has(id) && !down.has(id))

  const pos = new Map<string, { x: number; y: number }>([[center, { x: 0, y: 0 }]])
  const columns: [number, string[]][] = [
    [-2, pick(up, 2)], [-1, pick(up, 1)], [1, pick(down, 1)], [2, pick(down, 2)],
  ]
  let maxH = 0
  for (const [col, ids] of columns) {
    ids.forEach((id, i) => pos.set(id, { x: col * COL, y: (i - (ids.length - 1) / 2) * ROW }))
    maxH = Math.max(maxH, ids.length * ROW)
  }
  const p = [...new Set(partners)].sort((a, b) => rank(b) - rank(a)).slice(0, 10)
  const rowY = Math.max(maxH / 2, ROW * 2) + 80
  p.forEach((id, i) => pos.set(id, { x: (i - (p.length - 1) / 2) * 130, y: rowY }))

  const top = -Math.max(maxH / 2, ROW) - 40
  const headers = [
    { x: -2 * COL, y: top, text: 'CALLED BY · 2 HOPS' },
    { x: -COL, y: top, text: 'CALLED BY' },
    { x: 0, y: top, text: 'SELECTED' },
    { x: COL, y: top, text: 'CALLS' },
    { x: 2 * COL, y: top, text: 'CALLS · 2 HOPS' },
  ].filter((_h, i) => i === 2 || columns[i < 2 ? i : i - 1][1].length > 0)
  if (p.length) headers.push({ x: 0, y: rowY - 34, text: 'ALWAYS CHANGES WITH (CO-CHANGE)' })

  function pick(m: Map<string, number>, d: number) {
    return [...m.entries()].filter(([, x]) => x === d).map(([id]) => id).sort((a, b) => rank(b) - rank(a)).slice(0, PER_COLUMN)
  }
  return {
    ids: new Set(pos.keys()), pos, headers,
    callers: [...up.values()].filter((d) => d === 1).length,
    callees: [...down.values()].filter((d) => d === 1).length,
    partners: p.length,
  }
}

/** Keeps big bubbles (module view) from overlapping. O(n²), fine for a few dozen nodes. */
export function collideForce(padding: number) {
  let nodes: VNode[] = []
  const force = () => {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j]
        if (a.x === undefined || a.y === undefined || b.x === undefined || b.y === undefined) continue
        const dx = b.x - a.x, dy = b.y - a.y
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01
        const min = a.size + b.size + padding
        if (d >= min) continue
        const push = ((min - d) / d) * 0.5
        if (a.fx === undefined) { a.x -= dx * push; a.y -= dy * push }
        if (b.fx === undefined) { b.x += dx * push; b.y += dy * push }
      }
    }
  }
  force.initialize = (ns: VNode[]) => { nodes = ns }
  return force
}
