export const fmt = (n: number | null | undefined, digits = 0) =>
  n == null || Number.isNaN(n) ? '–' : n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 })

export const compact = (n: number | null | undefined) =>
  n == null ? '–' : Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n)

export const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(Math.abs(n))}` : '±0')

export const date = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

export const shortDate = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })

export const ago = (ts: number) => {
  const s = Date.now() / 1000 - ts
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`
  return date(ts)
}

/** "src/flask/app.py::Flask.run" -> { file: "app.py", dir: "src/flask", sym: "Flask.run" } */
export function splitKey(key: string) {
  const [path, sym] = key.split('::')
  const i = path.lastIndexOf('/')
  return { path, dir: i >= 0 ? path.slice(0, i) : '', file: i >= 0 ? path.slice(i + 1) : path, sym: sym ?? '' }
}

export const label = (key: string) => {
  const k = splitKey(key)
  return k.sym || k.file
}
