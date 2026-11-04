import type { EdgeType, Kind, Temporal, TNode } from '../../api'

export type LinkKind = EdgeType | 'cochange'
export type VKind = Kind | 'module'
export type Granularity = 'modules' | 'files' | 'symbols'

export interface VNode {
  id: string
  name: string
  kind: VKind
  path: string
  c: number // community id (module bubbles: the module's community, -1 = "other modules")
  pr: number
  test: boolean
  start: number
  born: number // start of the interval alive at τ
  isNew: boolean // alive at τ but not at the comparison point
  changed: boolean // touched by a commit in (since, τ]
  heat: number // change prior h(v; τ)
  ghost?: boolean // alive at the comparison point, gone at τ
  ext?: boolean // outside the drilled-in module, shown because it links into it
  size: number
  inDeg: number // "used by": incoming calls / imports / inherits at τ
  outDeg: number // "uses": outgoing calls / imports / inherits at τ
  members?: number // module bubbles only
  files?: number
  x?: number
  y?: number
  vx?: number
  vy?: number
  fx?: number
  fy?: number
}

export interface VLink {
  id: string
  source: string | VNode
  target: string | VNode
  kind: LinkKind
  w: number
  fresh: boolean // opened in (since, τ]
  ghost: boolean // closed in (since, τ]
  count?: number
}

export const alive = (iv: [number, number][], tau: number) => iv.some(([s, f]) => s <= tau && tau < f)
const bornAt = (iv: [number, number][], tau: number) => iv.find(([s, f]) => s <= tau && tau < f)?.[0] ?? -1

export const OTHER_MODULE = -1
const MAX_MODULES = 14

export interface ViewOpts {
  tau: number
  since?: number | null // compare mode: τ₀. Default τ − 1 (what this one commit changed)
  granularity: Granularity
  scope?: number | null // drilled-in module (community id, or OTHER_MODULE)
  edgeOn: Record<LinkKind, boolean>
  hideTests: boolean
  ccThreshold: number
  hidden?: Set<string>
}

export interface ModuleInfo { id: number; label: string; members: number }

export interface View {
  nodes: VNode[]
  links: VLink[]
  since: number
  modules: ModuleInfo[]
  counts: { nodes: number; edges: number; cochange: number; opened: number; closed: number; changed: number; born: number; died: number }
}

/** Precomputed indices over the temporal payload. */
export class TemporalModel {
  t: Temporal
  nodeCache = new Map<string, VNode>()
  linkCache = new Map<string, VLink>()

  constructor(t: Temporal) {
    this.t = t
  }

  label(c: number): string {
    if (c === OTHER_MODULE) return 'Other modules'
    return this.t.communities.find((x) => x.id === c)?.label ?? `module ${c}`
  }

  /** h(v; τ) per root, from Δ_t for t ≤ τ. */
  heat(tau: number): Map<string, number> {
    const lam = this.t.lambda || 60
    const h = new Map<string, number>()
    for (const [ts, idxs] of Object.entries(this.t.deltas)) {
      const t = +ts
      if (t > tau) continue
      const d = Math.exp(-(tau - t) / lam)
      for (const i of idxs) {
        const r = this.t.nodes[i].root
        h.set(r, (h.get(r) ?? 0) + d)
      }
    }
    return h
  }

  cochangeAt(tau: number, since: number): { a: string; b: string; w: number; fresh: boolean }[] {
    const lam = this.t.lambda || 60
    const out: { a: string; b: string; w: number; fresh: boolean }[] = []
    for (const [a, b, terms] of this.t.cochange) {
      let w = 0
      let fresh = false
      for (const [t, n] of terms) {
        if (t <= tau) {
          w += n * Math.exp(-(tau - t) / lam)
          if (t > since) fresh = true
        }
      }
      if (w > 0) out.push({ a, b, w, fresh })
    }
    return out
  }

  private vnode(n: TNode, i: number, s: Status, ghost: boolean, ext: boolean): VNode {
    let v = this.nodeCache.get(n.id)
    if (!v) {
      v = { id: n.id, name: n.name, kind: n.kind, path: n.path, c: n.c, pr: n.pr, test: !!n.test, start: n.start, born: 0,
        isNew: false, changed: false, heat: 0, size: 1, inDeg: 0, outDeg: 0 }
      this.nodeCache.set(n.id, v)
    }
    v.born = bornAt(n.iv, s.tau)
    v.isNew = s.marks && !!s.now[i] && !s.then[i]
    v.changed = s.changed.has(i)
    v.heat = s.heat.get(n.root) ?? 0
    v.ghost = ghost
    v.ext = ext
    v.inDeg = s.inDeg[i]
    v.outDeg = s.outDeg[i]
    return v
  }

  private vlink(id: string, source: string, target: string, kind: LinkKind, w: number, fresh: boolean, ghost: boolean, count?: number): VLink {
    let l = this.linkCache.get(id)
    if (!l) {
      l = { id, source, target, kind, w, fresh, ghost, count }
      this.linkCache.set(id, l)
    }
    l.w = w
    l.fresh = fresh
    l.ghost = ghost
    l.count = count
    return l
  }

  view(o: ViewOpts): View {
    const T = this.t
    const tau = o.tau
    const since = o.since != null ? Math.max(-1, Math.min(o.since, tau - 1)) : tau - 1
    const marks = since >= 0 && since < tau
    const N = T.nodes.length
    const s: Status = {
      tau, marks, heat: this.heat(tau), changed: new Set(),
      now: new Uint8Array(N), then: new Uint8Array(N), inDeg: new Int32Array(N), outDeg: new Int32Array(N),
    }
    if (marks) for (let t = since + 1; t <= tau; t++) for (const i of T.deltas[String(t)] ?? []) s.changed.add(i)

    let born = 0, died = 0
    T.nodes.forEach((n, i) => {
      if ((o.hideTests && n.test) || o.hidden?.has(n.id)) return
      s.now[i] = alive(n.iv, tau) ? 1 : 0
      s.then[i] = marks && alive(n.iv, since) ? 1 : 0
      if (n.kind !== 'file') {
        if (s.now[i] && marks && !s.then[i]) born++
        if (!s.now[i] && s.then[i]) died++
      }
    })

    const E = T.edges.length
    const eNow = new Uint8Array(E), eThen = new Uint8Array(E)
    let nEdges = 0, opened = 0, closed = 0
    T.edges.forEach(([si, di, ti, , iv], k) => {
      eNow[k] = alive(iv, tau) ? 1 : 0
      eThen[k] = marks && alive(iv, since) ? 1 : 0
      if (T.edge_types[ti] === 'contains') return
      if (eNow[k]) {
        nEdges++
        if (s.now[si] && s.now[di]) { s.outDeg[si]++; s.inDeg[di]++ }
        if (marks && !eThen[k]) opened++
      } else if (eThen[k]) closed++
    })

    // modules: the largest communities by live members; the rest fold into "other"
    const commCount = new Map<number, number>()
    T.nodes.forEach((n, i) => { if (s.now[i] && n.kind !== 'file') commCount.set(n.c, (commCount.get(n.c) ?? 0) + 1) })
    const top = [...commCount.entries()].filter(([c]) => c >= 0).sort((a, b) => b[1] - a[1]).slice(0, MAX_MODULES).map(([c]) => c)
    const topSet = new Set(top)
    const modOf = (c: number) => (topSet.has(c) ? c : OTHER_MODULE)
    const otherCount = [...commCount.entries()].filter(([c]) => !topSet.has(c)).reduce((a, [, v]) => a + v, 0)
    const modules: ModuleInfo[] = top.map((c) => ({ id: c, label: this.label(c), members: commCount.get(c) ?? 0 }))
    if (otherCount > 0) modules.push({ id: OTHER_MODULE, label: this.label(OTHER_MODULE), members: otherCount })

    const changedCount = s.changed.size
    const base = { since, modules }

    if (o.granularity === 'modules') {
      return this.finishModules(this.modulesView(o, s, eNow, modOf, since), base, { edges: nEdges, opened, closed, changed: changedCount, born, died })
    }

    const inScope = (i: number) => o.scope == null || modOf(T.nodes[i].c) === o.scope
    const isIn = new Uint8Array(N)
    const present = (i: number) => s.now[i] || s.then[i]
    if (o.granularity === 'symbols') {
      // inside a module only its symbols are shown: their files usually belong to other modules
      T.nodes.forEach((n, i) => {
        if (!present(i)) return
        if (n.kind !== 'file' ? inScope(i) : o.scope == null) isIn[i] = 1
      })
    } else {
      const scopeFiles = new Set<string>()
      T.nodes.forEach((n, i) => { if (s.now[i] && n.kind !== 'file' && inScope(i)) scopeFiles.add(n.path) })
      T.nodes.forEach((n, i) => {
        if (n.kind === 'file' && present(i) && (o.scope == null || scopeFiles.has(n.path) || modOf(n.c) === o.scope)) isIn[i] = 1
      })
    }

    // external neighbours when drilled in: things outside the module that link into it
    const ext = new Uint8Array(N)
    if (o.scope != null) {
      const cand = new Map<number, number>()
      const fileIdx = new Map<string, number>()
      if (o.granularity === 'files') T.nodes.forEach((n, i) => { if (n.kind === 'file') fileIdx.set(n.path, i) })
      T.edges.forEach(([si, di, ti], k) => {
        if (!eNow[k] || T.edge_types[ti] === 'contains') return
        let a = si, b = di
        if (o.granularity === 'files') { a = fileIdx.get(T.nodes[si].path) ?? -1; b = fileIdx.get(T.nodes[di].path) ?? -1 }
        if (a < 0 || b < 0 || a === b) return
        const other = isIn[a] && !isIn[b] ? b : isIn[b] && !isIn[a] ? a : -1
        if (other >= 0 && s.now[other]) cand.set(other, (cand.get(other) ?? 0) + 1)
      })
      ;[...cand.entries()].sort((x, y) => y[1] - x[1] || T.nodes[y[0]].pr - T.nodes[x[0]].pr).slice(0, 40).forEach(([i]) => { ext[i] = 1 })
    }

    const nodes: VNode[] = []
    const links: VLink[] = []
    T.nodes.forEach((n, i) => {
      if (o.granularity === 'files' && n.kind !== 'file') return
      if (isIn[i]) nodes.push(this.vnode(n, i, s, !s.now[i] && !!s.then[i], false))
      else if (ext[i]) nodes.push(this.vnode(n, i, s, false, true))
    })
    const presentIds = new Set(nodes.map((n) => n.id))
    let ccCount = 0

    if (o.granularity === 'symbols') {
      T.edges.forEach(([si, di, ti, w], k) => {
        if (!eNow[k] && !eThen[k]) return
        const kind = T.edge_types[ti]
        const a = T.nodes[si], b = T.nodes[di]
        if (!o.edgeOn[kind] || !presentIds.has(a.id) || !presentIds.has(b.id)) return
        if (kind === 'contains' && (ext[si] || ext[di])) return
        links.push(this.vlink(`${si}-${di}-${ti}`, a.id, b.id, kind, w, !!eNow[k] && marks && !eThen[k], !eNow[k] && !!eThen[k]))
      })
      const rootToId = new Map<string, string>()
      T.nodes.forEach((n, i) => { if (s.now[i] && presentIds.has(n.id)) rootToId.set(n.root, n.id) })
      for (const p of this.cochangeAt(tau, since)) {
        if (p.w < o.ccThreshold) continue
        const a = rootToId.get(p.a), b = rootToId.get(p.b)
        if (!a || !b || a === b) continue
        ccCount++
        if (o.edgeOn.cochange) links.push(this.vlink(`cc:${p.a}|${p.b}`, a, b, 'cochange', p.w, p.fresh, false))
      }
      sizeNodes(nodes)
      return { nodes, links, ...base, counts: { nodes: nodes.filter((n) => !n.ghost).length, edges: nEdges, cochange: ccCount, opened, closed, changed: changedCount, born, died } }
    }

    // ---- files: aggregate symbol edges into file → file links
    const fileNode = new Map<string, VNode>(nodes.map((n) => [n.path, n]))
    const fileHeat = new Map<string, number>()
    const filePr = new Map<string, number>()
    const fileChanged = new Set<string>()
    const fileIn = new Map<string, number>(), fileOut = new Map<string, number>()
    T.nodes.forEach((n, i) => {
      if (!s.now[i]) return
      fileHeat.set(n.path, (fileHeat.get(n.path) ?? 0) + (s.heat.get(n.root) ?? 0))
      filePr.set(n.path, (filePr.get(n.path) ?? 0) + n.pr)
      if (s.changed.has(i)) fileChanged.add(n.path)
    })
    const agg = new Map<string, { a: string; b: string; kind: LinkKind; n: number; fresh: boolean; ghost: boolean }>()
    T.edges.forEach(([si, di, ti], k) => {
      const kind = T.edge_types[ti]
      if (kind === 'contains' || (!eNow[k] && !eThen[k])) return
      const fa = T.nodes[si].path, fb = T.nodes[di].path
      if (fa === fb) return
      if (eNow[k]) { fileOut.set(fa, (fileOut.get(fa) ?? 0) + 1); fileIn.set(fb, (fileIn.get(fb) ?? 0) + 1) }
      if (!o.edgeOn[kind] || !fileNode.has(fa) || !fileNode.has(fb)) return
      const key = `${fa}>${fb}>${kind}`
      const isGhost = !eNow[k] && !!eThen[k]
      const fresh = !!eNow[k] && marks && !eThen[k]
      const g = agg.get(key)
      if (g) { if (eNow[k]) g.n++; g.fresh ||= fresh; g.ghost &&= isGhost }
      else agg.set(key, { a: fa, b: fb, kind, n: eNow[k] ? 1 : 0, fresh, ghost: isGhost })
    })
    for (const v of nodes) {
      v.heat = fileHeat.get(v.path) ?? 0
      v.changed = fileChanged.has(v.path)
      v.pr = filePr.get(v.path) ?? v.pr
      v.inDeg = fileIn.get(v.path) ?? 0
      v.outDeg = fileOut.get(v.path) ?? 0
    }
    for (const [key, g] of agg) links.push(this.vlink(`f:${key}`, g.a, g.b, g.kind, Math.log2(1 + Math.max(1, g.n)), g.fresh, g.ghost && g.n === 0, g.n))
    const rootPath = new Map<string, string>()
    T.nodes.forEach((n, i) => { if (s.now[i]) rootPath.set(n.root, n.path) })
    const fcc = new Map<string, { a: string; b: string; w: number; fresh: boolean }>()
    for (const p of this.cochangeAt(tau, since)) {
      const a = rootPath.get(p.a), b = rootPath.get(p.b)
      if (!a || !b || a === b) continue
      const [x, y] = a < b ? [a, b] : [b, a]
      const key = `${x}|${y}`
      const g = fcc.get(key)
      if (g) { g.w += p.w; g.fresh ||= p.fresh } else fcc.set(key, { a: x, b: y, w: p.w, fresh: p.fresh })
    }
    for (const [key, g] of fcc) {
      if (g.w < o.ccThreshold * 2) continue
      ccCount++
      if (o.edgeOn.cochange && fileNode.has(g.a) && fileNode.has(g.b)) links.push(this.vlink(`fcc:${key}`, g.a, g.b, 'cochange', g.w, g.fresh, false))
    }
    sizeNodes(nodes)
    return { nodes, links, ...base, counts: { nodes: nodes.filter((n) => !n.ghost).length, edges: nEdges, cochange: ccCount, opened, closed, changed: changedCount, born, died } }
  }

  private finishModules(m: { nodes: VNode[]; links: VLink[]; cochange: number }, base: { since: number; modules: ModuleInfo[] },
    c: { edges: number; opened: number; closed: number; changed: number; born: number; died: number }): View {
    return { nodes: m.nodes, links: m.links, ...base, counts: { nodes: m.nodes.length, cochange: m.cochange, ...c } }
  }

  /** One bubble per module; links are dependencies aggregated across module boundaries. */
  private modulesView(o: ViewOpts, s: Status, eNow: Uint8Array, modOf: (c: number) => number, since: number) {
    const T = this.t
    const agg = new Map<number, { members: number; files: Set<string>; heat: number; pr: number; changed: boolean; isNew: boolean }>()
    T.nodes.forEach((n, i) => {
      if (!s.now[i] || n.kind === 'file') return
      const m = modOf(n.c)
      const a = agg.get(m) ?? { members: 0, files: new Set<string>(), heat: 0, pr: 0, changed: false, isNew: false }
      a.members++
      a.files.add(n.path)
      a.heat += s.heat.get(n.root) ?? 0
      a.pr += n.pr
      a.changed ||= s.changed.has(i)
      agg.set(m, a)
    })
    const nodes: VNode[] = []
    for (const [m, a] of agg) {
      const id = `m:${m}`
      let v = this.nodeCache.get(id)
      if (!v) {
        v = { id, name: this.label(m), kind: 'module', path: '', c: m, pr: 0, test: false, start: 0, born: 0, isNew: false,
          changed: false, heat: 0, size: 10, inDeg: 0, outDeg: 0 }
        this.nodeCache.set(id, v)
      }
      v.name = this.label(m)
      v.members = a.members
      v.files = a.files.size
      v.heat = a.heat
      v.pr = a.pr
      v.changed = a.changed
      v.ghost = false
      v.ext = false
      v.size = 16 + Math.sqrt(a.members) * 6
      v.inDeg = 0
      v.outDeg = 0
      nodes.push(v)
    }
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const deps = new Map<string, { a: string; b: string; n: number; fresh: boolean }>()
    const depOn = o.edgeOn.calls || o.edgeOn.imports || o.edgeOn.inherits
    T.edges.forEach(([si, di, ti], k) => {
      const kind = T.edge_types[ti]
      if (!eNow[k] || kind === 'contains' || !o.edgeOn[kind]) return
      if (!s.now[si] || !s.now[di]) return
      const ma = modOf(T.nodes[si].c), mb = modOf(T.nodes[di].c)
      if (ma === mb) return
      const a = `m:${ma}`, b = `m:${mb}`
      if (!byId.has(a) || !byId.has(b)) return
      const key = `${a}>${b}`
      const g = deps.get(key)
      if (g) g.n++
      else deps.set(key, { a, b, n: 1, fresh: false })
    })
    const links: VLink[] = []
    if (depOn) {
      for (const [key, g] of deps) {
        if (g.n < 2 && deps.size > 30) continue // one stray call between two modules is noise at this level
        links.push(this.vlink(`md:${key}`, g.a, g.b, 'calls', Math.log2(1 + g.n), g.fresh, false, g.n))
        byId.get(g.a)!.outDeg++
        byId.get(g.b)!.inDeg++
      }
    }
    const rootMod = new Map<string, number>()
    T.nodes.forEach((n, i) => { if (s.now[i] && n.kind !== 'file') rootMod.set(n.root, modOf(n.c)) })
    const mcc = new Map<string, { a: string; b: string; w: number; fresh: boolean }>()
    for (const p of this.cochangeAt(o.tau, since)) {
      const ma = rootMod.get(p.a), mb = rootMod.get(p.b)
      if (ma === undefined || mb === undefined || ma === mb) continue
      const [x, y] = ma < mb ? [ma, mb] : [mb, ma]
      const key = `${x}|${y}`
      const g = mcc.get(key)
      if (g) { g.w += p.w; g.fresh ||= p.fresh } else mcc.set(key, { a: `m:${x}`, b: `m:${y}`, w: p.w, fresh: p.fresh })
    }
    let cochange = 0
    for (const [key, g] of mcc) {
      if (g.w < o.ccThreshold) continue
      cochange++
      if (o.edgeOn.cochange) links.push(this.vlink(`mcc:${key}`, g.a, g.b, 'cochange', Math.min(2, g.w), g.fresh, false))
    }
    return { nodes, links, cochange }
  }
}

interface Status {
  tau: number
  marks: boolean
  heat: Map<string, number>
  changed: Set<number>
  now: Uint8Array
  then: Uint8Array
  inDeg: Int32Array
  outDeg: Int32Array
}

function sizeNodes(nodes: VNode[]) {
  let max = 0
  for (const n of nodes) max = Math.max(max, n.pr)
  for (const n of nodes) {
    const base = n.kind === 'file' ? 4.5 : n.kind === 'class' ? 4 : 3
    n.size = base + (max > 0 ? Math.sqrt(n.pr / max) * 9 : 0)
  }
}
