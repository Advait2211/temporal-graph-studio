// Typed client for the TCG Studio backend.

export type Kind = 'file' | 'class' | 'function' | 'method'
export type EdgeType = 'contains' | 'imports' | 'calls' | 'inherits'

export interface BuildSnapshot {
  id: string
  repo_id: string
  name: string
  state: 'queued' | 'running' | 'done' | 'error'
  stage: string
  stage_frac: number
  progress: number
  message: string
  counters: Record<string, number | null>
  error: string | null
  elapsed: number
  log: string[]
  stages: { id: string; label: string }[]
}

export interface RepoCard {
  id: string
  name: string
  kind: 'github' | 'local'
  built_at: number
  depth: number
  description?: string
  stars?: number
  forks?: number
  avatar?: string
  languages: Record<string, number>
  kpis: Kpis
  spark: number[]
  github?: GithubMeta
}

export interface GithubMeta {
  full_name?: string
  description?: string
  stars?: number
  forks?: number
  watchers?: number
  open_issues?: number
  license?: string
  topics?: string[]
  languages?: Record<string, number>
  contributors?: { login: string; avatar: string; contributions: number }[]
  avatar?: string
  html_url?: string
  pushed_at?: string
  created_at?: string
}

export interface Kpis {
  commits: number
  span_days: number
  first_ts: number
  last_ts: number
  files: number
  files_delta: number
  symbols: number
  symbols_delta: number
  edges: number
  edges_delta: number
  contains: number
  cochange_pairs: number
  cochange_strong: number
  communities: number
  contributors: number
  languages: number
  edges_opened: number
  edges_closed: number
  nodes_ever: number
  changed_commits: number
  insertions: number
  deletions: number
  hidden_share: number | null
}

export interface GrowthPoint {
  t: number
  ts: number
  n_file: number
  n_class: number
  n_function: number
  n_method: number
  e_calls: number
  e_imports: number
  e_inherits: number
  e_contains: number
  e_cochange: number
  born: number
  died: number
  delta: number
}

export interface Community {
  id: number
  label: string
  size: number
  size_all: number
  files: number
  top: string[]
  churn: number
}

export interface Pair { a: string; b: string; weight: number; times: number; aux?: boolean; static_link?: boolean }

export interface Stats {
  kpis: Kpis
  growth: GrowthPoint[]
  node_kinds: Record<Kind, number>
  edge_types: Record<string, number>
  languages: { files: Record<string, number>; symbols: Record<string, number> }
  activity: { by_day: Record<string, number>; punchcard: { dow: number; hour: number; count: number }[] }
  contributors: { name: string; email: string; commits: number; insertions: number; deletions: number; symbols: number; first: number; last: number }[]
  hotspots: {
    files: { key: string; prior: number; changes: number; lang: string }[]
    symbols: { key: string; name: string; kind: Kind; path: string; prior: number; changes: number }[]
  }
  hidden_coupling: { symbols: Pair[]; files: Pair[] }
  top_cochange: Pair[]
  god_nodes: { key: string; name: string; qual: string; kind: Kind; path: string; pagerank: number; degree: number; callers: number; community: number; prior: number }[]
  communities: Community[]
  degree_distribution: { degree: number; count: number }[]
  lifetimes: {
    histogram: { bucket: string; closed: number; open: number }[]
    median_closed: Record<string, number | null>
    born_in_window: number
    survival_rate: number | null
  }
  surprising: { a: string; b: string; type: string; ca: number; cb: number; score: number }[]
  biggest_commits: { t: number; sha: string; msg: string; author: string; delta: number }[]
  questions: string[]
  params: { lambda: number; K: number }
}

export interface TNode {
  id: string
  root: string
  kind: Kind
  name: string
  qual: string
  path: string
  lang: string
  start: number
  end: number
  test: number
  c: number
  pr: number
  iv: [number, number][]
}

export interface Temporal {
  repo: { name: string; kind: string; owner: string; repo: string; depth: number }
  T: number
  commits: { i: number; sha: string; ts: number; author: string; msg: string; delta: number; ins: number; del: number; files: number }[]
  nodes: TNode[]
  edge_types: EdgeType[]
  edges: [number, number, number, number, [number, number][]][]
  cochange: [string, string, [number, number][]][]
  deltas: Record<string, number[]>
  communities: Community[]
  lambda: number
}

export interface SymbolInfo {
  key: string
  kind: Kind
  name: string
  qual: string
  path: string
  lang: string
  start: number
  end: number
  sig: string
  doc: string
  community: number
  pagerank: number
  intervals: [number, number][]
  T: number
  tau: number
  history: { t: number; key: string; sha: string; msg: string; author: string; ts: number }[]
  changes: number
  out: { other: string; type: string; weight: number; s: number; f: number | null }[]
  in: { other: string; type: string; weight: number; s: number; f: number | null }[]
  cochange: { key: string; weight: number; times: number }[]
  prior_series: { t: number; h: number }[]
  prior: number
  code: string | null
}

export interface CommitInfo {
  commit: { idx: number; sha: string; author: string; ts: number; msg: string; files: number; ins: number; del: number; n_delta: number }
  url: string | null
  symbols: string[]
  files: string[]
  edges_opened: { src: string; dst: string; type: string }[]
  edges_closed: { src: string; dst: string; type: string }[]
  nodes_born: { key: string; kind: string }[]
  nodes_died: { key: string; kind: string }[]
}

export interface RankItem {
  rank: number
  key: string
  name: string
  qual: string
  kind: Kind
  path: string
  score: number
  static_rank: number | null
  moved: number | null
  prior: number
  last_change: number | null
  community: number
  seed: { reason: string; weight: number; evidence: string }[]
  tokens: number | null
}

export interface RetrieveResult {
  tau: number
  sha: string
  budget: number
  params: Record<string, number>
  seeds: { key: string; name: string; kind: Kind; weight: number; reasons: string[] }[]
  ranking: RankItem[]
  static_ranking: { rank: number; key: string; name: string; path: string; score: number; full_rank: number }[]
  files: { path: string; score: number }[]
  packed: { key: string; mode: 'body' | 'signature'; tokens: number; text: string }[]
  tokens: { used: number; body: number; signature: number; budget: number }
  subgraph: { nodes: { id: string; name: string; kind: Kind; score: number; seed: boolean; community: number }[]; links: { source: string; target: string; type: string }[] }
  summary: { graph_nodes: number; graph_edges: number; cochange_edges: number; seed_count: number; top10_overlap_with_static: number }
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init })
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`
    try {
      const j = await r.json()
      msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j)
    } catch { /* keep status text */ }
    throw new Error(msg)
  }
  return r.json() as Promise<T>
}

export const api = {
  repos: () => req<{ repos: RepoCard[]; running: BuildSnapshot[] }>('/api/repos'),
  repo: (id: string) => req<RepoCard>(`/api/repos/${id}`),
  deleteRepo: (id: string) => req(`/api/repos/${id}`, { method: 'DELETE' }),
  build: (source: string, depth: number, refresh = false) =>
    req<BuildSnapshot>('/api/builds', { method: 'POST', body: JSON.stringify({ source, depth, refresh }) }),
  buildStatus: (id: string) => req<BuildSnapshot>(`/api/builds/${id}`),
  cancel: (id: string) => req(`/api/builds/${id}/cancel`, { method: 'POST' }),
  stats: (id: string) => req<{ stats: Stats; github: GithubMeta; repo: Record<string, unknown> }>(`/api/repos/${id}/stats`),
  temporal: (id: string) => req<Temporal>(`/api/repos/${id}/temporal`),
  symbol: (id: string, key: string, tau?: number) =>
    req<SymbolInfo>(`/api/repos/${id}/symbol?key=${encodeURIComponent(key)}${tau != null ? `&tau=${tau}` : ''}`),
  commit: (id: string, idx: number) => req<CommitInfo>(`/api/repos/${id}/commits/${idx}`),
  retrieve: (id: string, body: { issue: string; tau?: number; budget: number; params: Record<string, number> }) =>
    req<RetrieveResult>(`/api/repos/${id}/retrieve`, { method: 'POST', body: JSON.stringify(body) }),
  report: (id: string) => req<{ markdown: string }>(`/api/repos/${id}/report`),
}

export function streamBuild(id: string, onEvent: (s: BuildSnapshot) => void): () => void {
  const es = new EventSource(`/api/builds/${id}/events`)
  es.onmessage = (e) => {
    const s = JSON.parse(e.data) as BuildSnapshot
    onEvent(s)
    if (s.state === 'done' || s.state === 'error') es.close()
  }
  es.onerror = () => {
    es.close()
    // fall back to polling
    const iv = setInterval(async () => {
      try {
        const s = await api.buildStatus(id)
        onEvent(s)
        if (s.state === 'done' || s.state === 'error') clearInterval(iv)
      } catch { clearInterval(iv) }
    }, 600)
  }
  return () => es.close()
}
