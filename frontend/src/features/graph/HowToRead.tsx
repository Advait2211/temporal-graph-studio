import { useState } from 'react'
import { X } from 'lucide-react'
import { KindGlyph } from './HoverCard'

const COACH_KEY = 'tcg-coach-v1'

/** The legend card behind the "?" button: every mark on the canvas, explained. */
export function HowToRead({ onClose, colorBy }: { onClose: () => void; colorBy: 'community' | 'kind' | 'heat' }) {
  return (
    <div className="howto gx-panel" role="dialog" aria-label="How to read this graph">
      <div className="row between">
        <b style={{ fontSize: 15 }}>How to read this graph</b>
        <button className="btn sm icon ghost" onClick={onClose} aria-label="Close"><X size={15} /></button>
      </div>
      <div className="howto-grid">
        <section>
          <div className="eyebrow">Shapes</div>
          <Row icon={<KindGlyph kind="module" />} text="Module: a group of code that works together (click to open)" />
          <Row icon={<KindGlyph kind="file" />} text="File" />
          <Row icon={<KindGlyph kind="class" />} text="Class" />
          <Row icon={<KindGlyph kind="function" />} text="Function" />
          <Row icon={<KindGlyph kind="method" />} text="Method (a function inside a class)" />
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Bigger = more central (more of the code flows through it).</div>
        </section>
        <section>
          <div className="eyebrow">Colours & rings</div>
          <Row icon={<span className="swatch" style={{ background: 'var(--s1)' }} />}
            text={colorBy === 'community' ? 'Fill colour = which module it belongs to' : colorBy === 'kind' ? 'Fill colour = kind of symbol' : 'Darker blue = changed more recently (heat)'} />
          <Row icon={<span className="ring" style={{ background: 'var(--yellow)' }} />} text="Yellow halo: changed by the selected commit(s)" />
          <Row icon={<span className="ring" style={{ borderColor: 'var(--lime)', borderWidth: 3 }} />} text="Green ring: new at τ" />
          <Row icon={<span className="ring" style={{ borderColor: 'var(--red)', borderStyle: 'dashed' }} />} text="Red dashed: removed at τ" />
          <Row icon={<span className="ring" style={{ opacity: 0.45 }} />} text="Faded: outside the module you opened" />
        </section>
        <section>
          <div className="eyebrow">Lines</div>
          <Row icon={<Line color="var(--ink)" />} text="calls (arrow points to the function being called)" />
          <Row icon={<Line color="var(--s3)" dashed />} text="imports" />
          <Row icon={<Line color="var(--s7)" />} text="inherits from" />
          <Row icon={<Line color="var(--s2)" thick />} text="co-change: edited together in history, even with no code link" />
          <Row icon={<Line color="var(--ink-3)" thin />} text="contains (file → class → method)" />
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            When something is selected: <b style={{ color: 'var(--in-c)' }}>blue</b> = things that use it,
            {' '}<b style={{ color: 'var(--out-c)' }}>pink</b> = things it uses.
          </div>
        </section>
        <section>
          <div className="eyebrow">Do things</div>
          <Row icon={<span className="kbd">click</span>} text="details · on a module: open it" />
          <Row icon={<span className="kbd">right-click</span>} text="flow, find path, hide, pin, GitHub" />
          <Row icon={<span className="kbd">drag</span>} text="move a node (it stays put)" />
          <Row icon={<span className="kbd">scroll</span>} text="zoom · drag empty space to pan" />
          <Row icon={<span className="kbd">← →</span>} text="step through commits · space plays" />
          <Row icon={<span className="kbd">Esc</span>} text="go back one level" />
        </section>
      </div>
    </div>
  )
}

function Row({ icon, text }: { icon: React.ReactNode; text: string }) {
  return <div className="howto-row">{icon}<span>{text}</span></div>
}

function Line({ color, dashed, thick, thin }: { color: string; dashed?: boolean; thick?: boolean; thin?: boolean }) {
  return <span style={{ width: 26, height: 0, borderTop: `${thick ? 5 : thin ? 1.5 : 3}px ${dashed ? 'dashed' : 'solid'} ${color}`, flex: 'none' }} />
}

/** Three tips the first time the graph opens; dismissal is remembered per browser. */
export function Coach() {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(COACH_KEY) !== 'done' } catch { return true }
  })
  if (!open) return null
  const close = () => {
    setOpen(false)
    try { localStorage.setItem(COACH_KEY, 'done') } catch { /* private mode: just hide for now */ }
  }
  return (
    <div className="coach" role="note">
      <span className="coach-n">1</span> Drag the timeline to travel through history
      <span className="coach-n">2</span> Click a module bubble to open it
      <span className="coach-n">3</span> Right-click any node for actions
      <button className="btn sm" onClick={close} style={{ marginLeft: 6 }}>Got it</button>
    </div>
  )
}
