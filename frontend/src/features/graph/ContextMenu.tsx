import { useEffect, useRef } from 'react'
import { Copy, Crosshair, ExternalLink, EyeOff, FolderOpen, GitFork, Pin, PinOff, Route } from 'lucide-react'
import type { VNode } from './temporal'
import { splitKey } from '../../lib/format'

export type MenuAction = 'focus' | 'flow' | 'path' | 'open' | 'hide' | 'pin' | 'unpin' | 'github' | 'copy'

export default function ContextMenu({ node, x, y, width, height, pinned, hasGithub, onAction, onClose }: {
  node: VNode; x: number; y: number; width: number; height: number; pinned: boolean; hasGithub: boolean
  onAction: (a: MenuAction) => void; onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('mousedown', away, true)
    window.addEventListener('keydown', esc, true)
    return () => { window.removeEventListener('mousedown', away, true); window.removeEventListener('keydown', esc, true) }
  }, [onClose])
  const isModule = node.kind === 'module'
  const items: { a: MenuAction; label: string; icon: React.ReactNode; hint?: string }[] = isModule
    ? [
        { a: 'open', label: 'Open this module', icon: <FolderOpen size={15} /> },
        { a: pinned ? 'unpin' : 'pin', label: pinned ? 'Unpin position' : 'Pin position', icon: pinned ? <PinOff size={15} /> : <Pin size={15} /> },
      ]
    : [
        { a: 'focus', label: 'Show details', icon: <Crosshair size={15} />, hint: 'click' },
        { a: 'flow', label: 'Show dependency flow', icon: <GitFork size={15} /> },
        { a: 'path', label: 'Find path from here…', icon: <Route size={15} /> },
        { a: 'hide', label: 'Hide this node', icon: <EyeOff size={15} /> },
        { a: pinned ? 'unpin' : 'pin', label: pinned ? 'Unpin position' : 'Pin position', icon: pinned ? <PinOff size={15} /> : <Pin size={15} /> },
        ...(hasGithub ? [{ a: 'github' as MenuAction, label: 'Open on GitHub at τ', icon: <ExternalLink size={15} /> }] : []),
        { a: 'copy', label: 'Copy name', icon: <Copy size={15} /> },
      ]
  const left = Math.min(x, width - 250)
  const top = Math.min(y, height - (items.length * 36 + 52))
  const k = splitKey(node.id)
  return (
    <div ref={ref} className="ctxmenu" style={{ left: Math.max(6, left), top: Math.max(6, top) }} role="menu" onContextMenu={(e) => e.preventDefault()}>
      <div className="ctx-title mono ellipsis">{isModule ? node.name : k.sym || k.file}</div>
      {items.map((it) => (
        <button key={it.a} role="menuitem" onClick={() => { onAction(it.a); onClose() }}>
          {it.icon}
          <span className="grow">{it.label}</span>
          {it.hint && <span className="muted" style={{ fontSize: 11 }}>{it.hint}</span>}
        </button>
      ))}
    </div>
  )
}
