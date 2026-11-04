// Geometric hit-testing for force-graph canvases.
//
// force-graph finds the node under the pointer by reading a colour-coded shadow canvas. On
// displays where Chrome colour-manages canvas readback, those colours come back off by ±1 per
// channel, the lookup fails, and hover/click silently stop working. Picking by distance in graph
// coordinates avoids the problem entirely.

interface Screen2Graph {
  screen2GraphCoords: (x: number, y: number) => { x: number; y: number }
  zoom: () => number
}

export function pickNode<N extends { x?: number; y?: number }>(
  fg: Screen2Graph | undefined,
  canvas: HTMLCanvasElement | null | undefined,
  clientX: number,
  clientY: number,
  nodes: N[],
  radius: (n: N) => number,
): N | null {
  if (!fg || !canvas) return null
  const rect = canvas.getBoundingClientRect()
  const p = fg.screen2GraphCoords(clientX - rect.left, clientY - rect.top)
  const k = fg.zoom() || 1
  const slack = 5 / k // a few screen pixels of forgiveness at any zoom
  let best: N | null = null
  let bestD = Infinity
  for (const n of nodes) {
    if (n.x === undefined || n.y === undefined) continue
    const dx = n.x - p.x
    const dy = n.y - p.y
    const d = Math.sqrt(dx * dx + dy * dy)
    if (d <= radius(n) + slack && d < bestD) {
      best = n
      bestD = d
    }
  }
  return best
}
