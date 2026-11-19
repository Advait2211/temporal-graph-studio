import type { EdgeType, Kind } from '../api'

// Categorical slots follow the dataviz reference palette, in fixed order.
export const SERIES = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'] as const
export const seriesVar = (i: number) => (i >= 0 && i < SERIES.length ? `var(--${SERIES[i]})` : 'var(--s-other)')

export const KIND_SLOT: Record<Kind, number> = { function: 0, class: 6, method: 2, file: 3 }
export const KIND_LABEL: Record<Kind, string> = { file: 'File', class: 'Class', function: 'Function', method: 'Method' }

export const EDGE_SLOT: Record<EdgeType | 'cochange', number> = { calls: 0, cochange: 1, imports: 2, inherits: 6, contains: -1 }
export const EDGE_LABEL: Record<EdgeType | 'cochange', string> = {
  calls: 'calls', imports: 'imports', inherits: 'inherits', contains: 'contains', cochange: 'co-change',
}

export const LANG_COLOR: Record<string, string> = {
  Python: 'var(--s1)', TypeScript: 'var(--s7)', JavaScript: 'var(--s4)', Go: 'var(--s3)', Java: 'var(--s2)', OpenQASM: 'var(--s6)',
}
