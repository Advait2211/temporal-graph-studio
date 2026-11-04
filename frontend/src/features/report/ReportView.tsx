import { useEffect, useState, type ReactNode } from 'react'
import { Download, FileJson, FileText, Loader2, MessageCircleQuestion } from 'lucide-react'
import type { WS } from '../../pages/Workspace'
import { api } from '../../api'
import { Card } from '../../ui'

export default function ReportView({ ws }: { ws: WS }) {
  const [md, setMd] = useState<string | null>(null)
  useEffect(() => { api.report(ws.repoId).then((r) => setMd(r.markdown)).catch(() => setMd('# Report unavailable')) }, [ws.repoId])
  return (
    <div className="rep">
      <Card>{md == null ? <div className="row muted"><Loader2 className="spin" size={16} /> Writing report…</div> : <div className="md">{renderMd(md)}</div>}</Card>
      <div className="col rep-side" style={{ gap: 16 }}>
        <Card fill="yellow" title="Export">
          <div className="col" style={{ gap: 10 }}>
            <a className="btn" href={`/api/repos/${ws.repoId}/export/report.md`}><FileText size={16} /> REPORT.md</a>
            <a className="btn" href={`/api/repos/${ws.repoId}/export/graph.json`}><FileJson size={16} /> graph.json (temporal)</a>
            <span style={{ fontSize: 12.5 }}>graph.json holds every node and edge with its validity intervals, plus co-change terms, so G<sub>τ</sub> can be rebuilt for any commit.</span>
          </div>
        </Card>
        <Card title={<span className="row" style={{ gap: 8 }}><MessageCircleQuestion size={18} /> Suggested questions</span>}>
          <div className="col" style={{ gap: 10 }}>
            {ws.stats.questions.map((q) => (
              <div key={q} className="card tight flat" style={{ fontSize: 13.5 }}>
                {inline(q)}
              </div>
            ))}
          </div>
        </Card>
        <a className="btn sm" href={`/api/repos/${ws.repoId}/export/report.md`} style={{ alignSelf: 'flex-start' }}><Download size={14} /> Download</a>
      </div>
    </div>
  )
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const t = m[0]
    if (t.startsWith('`')) out.push(<code key={i++}>{t.slice(1, -1)}</code>)
    else if (t.startsWith('**')) out.push(<b key={i++}>{t.slice(2, -2)}</b>)
    else out.push(<i key={i++}>{t.slice(1, -1)}</i>)
    last = m.index + t.length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}

function renderMd(md: string): ReactNode[] {
  const lines = md.split('\n')
  const out: ReactNode[] = []
  let i = 0
  let k = 0
  while (i < lines.length) {
    const l = lines[i]
    if (l.startsWith('# ')) { out.push(<h1 key={k++}>{inline(l.slice(2))}</h1>); i++; continue }
    if (l.startsWith('## ')) { out.push(<h2 key={k++}>{inline(l.slice(3))}</h2>); i++; continue }
    if (l.startsWith('> ')) { out.push(<blockquote key={k++}>{inline(l.slice(2))}</blockquote>); i++; continue }
    if (l.trim() === '---') { out.push(<hr key={k++} />); i++; continue }
    if (l.startsWith('- ')) {
      const items: string[] = []
      while (i < lines.length && lines[i].startsWith('- ')) items.push(lines[i++].slice(2))
      out.push(<ul key={k++}>{items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ul>)
      continue
    }
    if (l.startsWith('|')) {
      const rows: string[][] = []
      while (i < lines.length && lines[i].startsWith('|')) {
        const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim())
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells)
        i++
      }
      const [head, ...body] = rows
      out.push(
        <table key={k++}><thead><tr>{head.map((h, j) => <th key={j}>{inline(h)}</th>)}</tr></thead>
          <tbody>{body.map((r, j) => <tr key={j}>{r.map((c, x) => <td key={x} className={/^[+−-]?[\d,.]+/.test(c) ? 'mono' : ''}>{inline(c)}</td>)}</tr>)}</tbody></table>,
      )
      continue
    }
    if (l.trim()) out.push(<p key={k++}>{inline(l)}</p>)
    i++
  }
  return out
}
