import type { CSSProperties, ReactNode } from 'react'
import { Moon, Sun } from 'lucide-react'
import { setTheme, useTheme } from '../lib/theme'
import { fmt, signed } from '../lib/format'

export function Logo({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect x="2" y="2" width="28" height="28" rx="6" fill="#FFD23F" stroke="var(--line)" strokeWidth="3" />
      <path d="M10 11.5 L21.5 20.5" stroke="#0A0A0A" strokeWidth="2.5" />
      <path d="M10 11.5 L21 10" stroke="#0A0A0A" strokeWidth="2.5" strokeDasharray="2.5 2.5" />
      <circle cx="10" cy="11.5" r="3.6" fill="#0A0A0A" />
      <circle cx="21.5" cy="20.5" r="3.6" fill="#FF8FB8" stroke="#0A0A0A" strokeWidth="2" />
      <circle cx="21.5" cy="10" r="2.4" fill="#7FD8F5" stroke="#0A0A0A" strokeWidth="2" />
    </svg>
  )
}

export function Wordmark() {
  return (
    <span className="row" style={{ gap: 10 }}>
      <Logo />
      <span style={{ fontWeight: 700, fontSize: 19, letterSpacing: '-0.03em' }}>
        TCG<span style={{ fontWeight: 500 }}> Studio</span>
      </span>
    </span>
  )
}

export function ThemeToggle() {
  const theme = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <button className="btn icon" aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`} onClick={() => setTheme(next)}>
      {theme === 'dark' ? <Sun size={18} strokeWidth={2.5} /> : <Moon size={18} strokeWidth={2.5} />}
    </button>
  )
}

export function Card({ children, className = '', style, title, sub, actions, fill }: {
  children?: ReactNode; className?: string; style?: CSSProperties; title?: ReactNode; sub?: ReactNode; actions?: ReactNode; fill?: string
}) {
  return (
    <section className={`card ${fill ? `fill-${fill}` : ''} ${className}`} style={style}>
      {(title || actions) && (
        <div className="card-head">
          <div className="grow">
            {title && <h3 className="h3">{title}</h3>}
            {sub && <div className="sub">{sub}</div>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}

export function StatTile({ label, value, delta, fill, hint, icon }: {
  label: string; value: ReactNode; delta?: number | null; fill?: string; hint?: ReactNode; icon?: ReactNode
}) {
  return (
    <div className={`card tile ${fill ? `fill-${fill}` : ''}`}>
      <div className="row between">
        <span className="label">{label}</span>
        {icon}
      </div>
      <span className="value">{typeof value === 'number' ? fmt(value) : value}</span>
      <span className="row" style={{ gap: 8, minHeight: 18 }}>
        {delta != null && <span className={`delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}`}>{signed(delta)}</span>}
        {hint && <span className="muted" style={{ fontSize: 12 }}>{hint}</span>}
      </span>
    </div>
  )
}

export function Spark({ data, width = 120, height = 34, color = 'var(--ink)', fill = 'var(--yellow)' }: {
  data: number[]; width?: number; height?: number; color?: string; fill?: string
}) {
  if (data.length < 2) return <svg width={width} height={height} />
  const min = Math.min(...data)
  const max = Math.max(...data)
  const span = max - min || 1
  const pts = data.map((v, i) => [(i / (data.length - 1)) * (width - 4) + 2, height - 3 - ((v - min) / span) * (height - 8)])
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  return (
    <svg width={width} height={height} aria-hidden>
      <path d={`${d} L${width - 2},${height} L2,${height} Z`} fill={fill} opacity={0.9} />
      <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
    </svg>
  )
}

export function Switch({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      {children}
    </label>
  )
}

export function Seg<T extends string>({ value, options, onChange }: {
  value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void
}) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Marquee({ items }: { items: ReactNode[] }) {
  const row = items.map((it, i) => <span key={i}>✦ {it}</span>)
  return (
    <div className="marquee" aria-hidden>
      <div className="track">{row}{row}</div>
    </div>
  )
}

export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="row wrap" style={{ gap: 14, fontSize: 12.5, fontWeight: 600 }}>
      {items.map((it) => (
        <span key={it.label} className="row" style={{ gap: 6 }}>
          <span className="swatch" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  )
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="col" style={{ alignItems: 'center', textAlign: 'center', padding: '36px 16px', gap: 8 }}>
      {icon}
      <div style={{ fontWeight: 700, fontSize: 17 }}>{title}</div>
      {children && <div className="muted" style={{ maxWidth: 420 }}>{children}</div>}
    </div>
  )
}

export function ChartTip({ title, rows }: { title?: ReactNode; rows: { label: string; value: ReactNode; color?: string }[] }) {
  return (
    <div className="tip">
      {title && <div className="t">{title}</div>}
      {rows.map((r) => (
        <div className="r" key={r.label}>
          <span className="row" style={{ gap: 6 }}>
            {r.color && <span className="swatch" style={{ background: r.color, width: 10, height: 10 }} />}
            {r.label}
          </span>
          <b>{r.value}</b>
        </div>
      ))}
    </div>
  )
}

export function Github({ size = 18, style }: { size?: number; strokeWidth?: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden style={style}>
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.4-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  )
}
