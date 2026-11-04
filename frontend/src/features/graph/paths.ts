// Graph walks over the links currently on screen: k-hop neighbourhoods and shortest paths.
import type { LinkKind, VLink, VNode } from './temporal'

export interface Step { to: string; kind: LinkKind }
export interface Adj { out: Map<string, Step[]>; in: Map<string, Step[]> }

const idOf = (x: string | VNode) => (typeof x === 'string' ? x : x.id)

export function buildAdj(links: VLink[], kinds: Set<LinkKind>): Adj {
  const adj: Adj = { out: new Map(), in: new Map() }
  for (const l of links) {
    if (l.ghost || !kinds.has(l.kind)) continue
    const a = idOf(l.source), b = idOf(l.target)
    if (a === b) continue
    push(adj.out, a, { to: b, kind: l.kind })
    push(adj.in, b, { to: a, kind: l.kind })
    if (l.kind === 'cochange') {
      push(adj.out, b, { to: a, kind: l.kind })
      push(adj.in, a, { to: b, kind: l.kind })
    }
  }
  return adj
}

function push(m: Map<string, Step[]>, k: string, s: Step) {
  const arr = m.get(k)
  if (arr) arr.push(s)
  else m.set(k, [s])
}

/** Breadth-first hop distance from `start` following one direction, up to `depth`. */
export function hops(adj: Adj, start: string, dir: 'in' | 'out', depth: number, kinds?: Set<LinkKind>): Map<string, number> {
  const g = dir === 'out' ? adj.out : adj.in
  const dist = new Map<string, number>([[start, 0]])
  let frontier = [start]
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: string[] = []
    for (const u of frontier) {
      for (const s of g.get(u) ?? []) {
        if (kinds && !kinds.has(s.kind)) continue
        if (!dist.has(s.to)) {
          dist.set(s.to, d)
          next.push(s.to)
        }
      }
    }
    frontier = next
  }
  dist.delete(start)
  return dist
}

export interface PathHop { from: string; to: string; kind: LinkKind; forward: boolean }
export interface PathResult { nodes: string[]; hops: PathHop[] }

/** Shortest path ignoring direction, but remembering which way each edge really points. */
export function shortestPath(adj: Adj, a: string, b: string): PathResult | null {
  if (a === b) return { nodes: [a], hops: [] }
  const prev = new Map<string, PathHop>()
  const seen = new Set([a])
  let frontier = [a]
  while (frontier.length) {
    const next: string[] = []
    for (const u of frontier) {
      const steps: [Step, boolean][] = [
        ...(adj.out.get(u) ?? []).map((s) => [s, true] as [Step, boolean]),
        ...(adj.in.get(u) ?? []).map((s) => [s, false] as [Step, boolean]),
      ]
      for (const [s, forward] of steps) {
        if (seen.has(s.to)) continue
        seen.add(s.to)
        prev.set(s.to, { from: u, to: s.to, kind: s.kind, forward })
        if (s.to === b) {
          const hopsOut: PathHop[] = []
          let cur = b
          while (cur !== a) {
            const h = prev.get(cur)!
            hopsOut.unshift(h)
            cur = h.from
          }
          return { nodes: [a, ...hopsOut.map((h) => h.to)], hops: hopsOut }
        }
        next.push(s.to)
      }
    }
    frontier = next
  }
  return null
}
