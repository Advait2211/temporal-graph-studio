import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { ArrowDown, ArrowUp, Atom, Check, Cpu, Loader2, Play, ShieldCheck, Sparkles, Wand2, Waves } from 'lucide-react'
import type { WS } from '../../pages/Workspace'
import {
  api, type QCircuitResult, type QecChannel, type QecCode, type QecResult, type QecSweep, type QPackResult, type QWalkResult,
} from '../../api'
import { Card, ChartTip, Empty, Legend, Seg, StatTile } from '../../ui'
import { date, fmt, label, shortDate, splitKey } from '../../lib/format'

const AX = { stroke: 'var(--ink-3)', fontSize: 11, fontFamily: 'var(--mono)' }
const GRID = { stroke: 'var(--grid)', strokeDasharray: '0', vertical: false }
const S = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)']

type Panel = 'walk' | 'circuit' | 'pack' | 'qec' | 'code'
const PANELS: { value: Panel; label: string; blurb: string }[] = [
  { value: 'walk', label: 'Quantum walk', blurb: 'Rank code with a continuous-time quantum walk instead of PageRank. Amplitudes interfere, so two paths to a function can reinforce or cancel.' },
  { value: 'circuit', label: 'Circuit', blurb: 'Run the same walk as a real gate-based Qiskit circuit on the top 2ᵏ nodes: state preparation, Trotterised Pauli evolution, measurement.' },
  { value: 'pack', label: 'QAOA pack', blurb: 'Choose which function bodies fit the token budget with QAOA on a QUBO that rewards rank and co-change, against greedy, random and exact.' },
  { value: 'qec', label: 'Error correction', blurb: 'Noise in the middle of the walk scrambles the ranking. The bit-flip, phase-flip and Shor codes (NPTEL QEC lectures 23–25) repair it.' },
  { value: 'code', label: 'Quantum code', blurb: 'Gates, qubits and circuits found in Qiskit, Cirq, PennyLane and OpenQASM files, tracked over the commit history.' },
]
const pct = (x: number | null | undefined, d = 1) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`)
const f3 = (x: number | null | undefined) => (x == null ? '–' : x.toFixed(3))

export default function QuantumView({ ws }: { ws: WS }) {
  const { stats, temporal } = ws
  const q = stats.quantum
  const examples = useMemo(() => {
    const out: string[] = []
    const top = q?.top.find((c) => c.circuit) ?? q?.top[0]
    if (top) out.push(`The CNOT in \`${top.name}\` entangles the wrong qubits, so measuring the circuit gives the wrong distribution.`)
    const hot = stats.hotspots.symbols[0]
    if (hot) out.push(`After the latest release, \`${hot.name}\` behaves differently and raises an exception in some cases. Where should we fix this?`)
    const god = stats.god_nodes[0]
    if (god) out.push(`Calling ${god.name}() with a custom configuration ignores the user's settings.`)
    return out
  }, [stats, q])
  const [panel, setPanel] = useState<Panel>(q ? 'code' : 'walk')
  const [issue, setIssue] = useState(examples[0] ?? '')
  const [tau, setTau] = useState(ws.tau)
  const T = temporal.T
  const c = temporal.commits[tau]
  const shared = (
    <>
      <Card title="Issue" sub="Every quantum run starts from the same seeds as Retrieve">
        <textarea className="textarea" rows={5} value={issue} onChange={(e) => setIssue(e.target.value)} placeholder="Describe the bug…" />
        <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
          <Wand2 size={14} />
          {examples.map((ex, i) => <button key={i} className="chip" style={{ height: 28, fontSize: 12 }} onClick={() => setIssue(ex)}>Example {i + 1}</button>)}
        </div>
      </Card>
      <Card title="As of commit τ" sub="Only ancestors of τ: no leakage from the future">
        <input className="range" type="range" min={0} max={T - 1} value={tau} onChange={(e) => setTau(+e.target.value)} aria-label="As-of commit" />
        <div className="row between" style={{ fontSize: 12.5, marginTop: 8, gap: 8 }}>
          <span className="mono" style={{ fontWeight: 700 }}>c{tau} · {c.sha.slice(0, 7)}</span>
          <span className="muted">{date(c.ts)}</span>
        </div>
      </Card>
    </>
  )
  const info = PANELS.find((p) => p.value === panel)!
  const props = { ws, issue, tau, shared }
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card row wrap between" style={{ gap: 14 }}>
        <div className="row" style={{ gap: 12, minWidth: 0, flex: '1 1 380px' }}>
          <Atom size={28} strokeWidth={2.4} style={{ flexShrink: 0 }} />
          <div className="col" style={{ gap: 2, minWidth: 0 }}>
            <b>{info.label}</b>
            <span className="muted" style={{ fontSize: 13 }}>{info.blurb}</span>
          </div>
        </div>
        <Seg value={panel} onChange={setPanel} options={PANELS.map((p) => ({ value: p.value, label: p.label }))} />
      </div>
      {panel === 'walk' && <WalkPanel {...props} />}
      {panel === 'circuit' && <CircuitPanel {...props} />}
      {panel === 'pack' && <PackPanel {...props} />}
      {panel === 'qec' && <QecPanel {...props} />}
      {panel === 'code' && <CodePanel ws={ws} />}
    </div>
  )
}

type PP = { ws: WS; issue: string; tau: number; shared: ReactNode }

function useRun<T>(fn: () => Promise<T>, auto: boolean) {
  const [res, setRes] = useState<T | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const run = async () => {
    setBusy(true); setErr(null)
    try { setRes(await fn()) } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  useEffect(() => { if (auto) run() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return { res, busy, err, run }
}

function Shell({ left, right, busy, err, res, waiting }: { left: ReactNode; right: ReactNode; busy: boolean; err: string | null; res: unknown; waiting: string }) {
  return (
    <div className="rv">
      <div className="col" style={{ gap: 16 }}>{left}</div>
      <div className="col" style={{ gap: 16, minWidth: 0 }}>
        {err && <div className="err">{err}</div>}
        {!res ? (
          <Card><div className="row muted" style={{ padding: 30, justifyContent: 'center', gap: 10 }}>{busy ? <><Loader2 className="spin" /> {waiting}</> : 'Run to see results.'}</div></Card>
        ) : right}
      </div>
    </div>
  )
}

function RunBtn({ busy, onClick, disabled, children }: { busy: boolean; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button className="btn primary grow" onClick={onClick} disabled={busy || disabled}>
      {busy ? <Loader2 size={17} className="spin" /> : <Play size={17} />} {children}
    </button>
  )
}

function Param({ label: l, hint, value, min, max, step, onChange, fmtv }: {
  label: string; hint: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmtv?: (v: number) => string
}) {
  return (
    <div className="param" title={hint}>
      <span style={{ fontWeight: 600 }}>{l} <span className="muted" style={{ fontWeight: 400, fontSize: 11.5 }}>{hint}</span></span>
      <span className="v">{fmtv ? fmtv(value) : value.toFixed(2)}</span>
      <input className="range" type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(+e.target.value)} aria-label={l} />
    </div>
  )
}

function Moved({ m }: { m: number | null }) {
  if (m == null) return <span className="mv new">new</span>
  if (m === 0) return <span className="mono muted" style={{ fontSize: 12, textAlign: 'center' }}>=</span>
  return m > 0
    ? <span className="mv up row" style={{ gap: 2 }}><ArrowUp size={11} strokeWidth={3} />{m}</span>
    : <span className="mv down row" style={{ gap: 2 }}><ArrowDown size={11} strokeWidth={3} />{-m}</span>
}

// ---------------------------------------------------------------------------- walk

function WalkPanel({ ws, issue, tau, shared }: PP) {
  const [t, setT] = useState(3)
  const [samples, setSamples] = useState(24)
  const { res, busy, err, run } = useRun<QWalkResult>(() => api.qwalk(ws.repoId, { issue, tau, params: { qw_time: t, qw_samples: samples } }), !!issue)
  const keys = res?.trajectory_keys.slice(0, 4) ?? []
  return (
    <Shell busy={busy} err={err} res={res} waiting="Evolving e^{−iHt}|ψ₀⟩…"
      left={<>
        {shared}
        <Card title="Walk" sub="H = normalised Laplacian of the mixed-edge graph, |ψ₀⟩ = √p">
          <div className="col" style={{ gap: 14 }}>
            <Param label="t max" hint="how far the walk spreads" value={t} min={0.5} max={10} step={0.5} onChange={setT} />
            <Param label="samples" hint="time-average grid" value={samples} min={8} max={64} step={4} onChange={setSamples} fmtv={(v) => String(v)} />
            <div className="row"><RunBtn busy={busy} onClick={run} disabled={!issue.trim()}>Run quantum walk</RunBtn></div>
          </div>
        </Card>
      </>}
      right={res && <>
        <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
          <StatTile label="Top-10 shared w/ PPR" value={`${res.summary.overlap_ppr}/10`} hint="quantum vs classical walk" fill="yellow" />
          <StatTile label="Top-10 shared w/ static" value={`${res.summary.overlap_static}/10`} hint={`PPR vs static: ${res.summary.overlap_ppr_static}/10`} />
          <StatTile label="Effective spread" value={res.summary.spread_nodes} hint="nodes the walk covers (1/Σq²)" fill="cyan" />
          <StatTile label="Hilbert space" value={`${res.summary.qubits_equivalent} qubits`} hint={`${fmt(res.summary.graph_nodes)} nodes = basis states`} fill="pink" />
        </div>
        <Card title={<span className="row" style={{ gap: 8 }}><Waves size={18} /> Interference over time</span>}
          sub="Probability of finding the walker on each top-ranked unit. Unlike a random walk it oscillates: amplitudes from different paths add and cancel. The score is the time average.">
          <Legend items={keys.map((k, i) => ({ label: k.name, color: S[i] }))} />
          <div style={{ height: 240, marginTop: 8 }}>
            <ResponsiveContainer>
              <LineChart data={res.trajectory} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="t" {...AX} type="number" domain={[0, 'dataMax']} tickFormatter={(v) => (+v).toFixed(1)} />
                <YAxis {...AX} tickFormatter={(v) => `${Math.round(v * 100)}%`} width={44} />
                <Tooltip cursor={{ stroke: 'var(--ink)', strokeWidth: 1 }} content={({ active, payload, label: l }) => active && payload?.length ? (
                  <ChartTip title={`t = ${(+(l ?? 0)).toFixed(2)}`} rows={keys.map((k, i) => ({ label: k.name, value: pct(payload[0].payload[k.key] as number), color: S[i] }))} />) : null} />
                {keys.map((k, i) => <Line key={k.key} dataKey={k.key} stroke={S[i]} strokeWidth={2} dot={false} isAnimationActive={false} />)}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="row between" style={{ marginTop: 10, gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>Probability still on the seeds</span>
            <span className="muted mono" style={{ fontSize: 12 }}>starts at 100%, leaks out, flows back</span>
          </div>
          <div style={{ height: 110 }}>
            <ResponsiveContainer>
              <LineChart data={res.trajectory} margin={{ top: 6, right: 12, left: -8, bottom: 0 }}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="t" {...AX} type="number" domain={[0, 'dataMax']} tickFormatter={(v) => (+v).toFixed(1)} />
                <YAxis {...AX} domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} width={44} />
                <Tooltip cursor={{ stroke: 'var(--ink)', strokeWidth: 1 }} content={({ active, payload, label: l }) => active && payload?.length ? (
                  <ChartTip title={`t = ${(+(l ?? 0)).toFixed(2)}`} rows={[{ label: 'on seeds', value: pct(payload[0].value as number) }]} />) : null} />
                <Line dataKey="seed_mass" stroke="var(--ink-2)" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <div className="g2e">
          <Card title={<span className="row" style={{ gap: 8 }}><Atom size={18} /> Quantum-walk ranking</span>} sub="Time-averaged |⟨v|ψ(t)⟩|². Arrows: movement vs PPR.">
            {res.ranking.slice(0, 15).map((r) => (
              <div key={r.key} className="rank-row" title={r.key} onClick={() => ws.go('graph', r.key)} style={{ cursor: 'pointer' }}>
                <span className="r">{r.rank}</span>
                <span className="col" style={{ gap: 1, minWidth: 0 }}>
                  <span className="mono ellipsis" style={{ fontWeight: 700 }}>{r.name}</span>
                  <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                    <span className="muted ellipsis" style={{ fontSize: 11, maxWidth: 170 }}>{r.path.split('/').pop()}</span>
                    {r.seed.map((s) => <span key={s} className={`badge ${s === 'quantum' ? 'fill-violet' : ''}`} style={{ height: 18, fontSize: 9.5, padding: '0 5px' }}>{s}</span>)}
                  </span>
                </span>
                <Moved m={r.moved} />
                <span className="num" style={{ fontSize: 11 }}>{(r.score * 100).toFixed(2)}</span>
              </div>
            ))}
          </Card>
          <Card title="Classical PPR ranking" sub="Same seeds, same graph, PageRank's random walk">
            {res.ppr_ranking.slice(0, 15).map((r) => (
              <div key={r.key} className="rank-row" title={r.key} style={{ gridTemplateColumns: '34px minmax(0, 1fr) 74px' }}>
                <span className="r">{r.rank}</span>
                <span className="col" style={{ gap: 1, minWidth: 0 }}>
                  <span className="mono ellipsis" style={{ fontWeight: 700 }}>{r.name}</span>
                  <span className="muted ellipsis" style={{ fontSize: 11 }}>{r.path}</span>
                </span>
                <span className="num muted" style={{ fontSize: 11 }}>{r.quantum_rank ? `QW #${r.quantum_rank}` : 'QW –'}</span>
              </div>
            ))}
          </Card>
        </div>
      </>}
    />
  )
}

// ---------------------------------------------------------------------------- circuit

function CircuitPanel({ ws, issue, tau, shared }: PP) {
  const [qubits, setQubits] = useState('3')
  const [reps, setReps] = useState(2)
  const [shots, setShots] = useState('4096')
  const { res, busy, err, run } = useRun<QCircuitResult>(() => api.qcircuit(ws.repoId, { issue, tau, qubits: +qubits, reps, shots: +shots }), !!issue)
  const bars = res?.nodes.map((n) => ({ ...n, label: n.bits })) ?? []
  return (
    <Shell busy={busy} err={err} res={res} waiting="Transpiling and sampling…"
      left={<>
        {shared}
        <Card title="Circuit" sub="k qubits hold a 2ᵏ-node subgraph: the walk's top nodes, seeds forced in">
          <div className="col" style={{ gap: 14 }}>
            <div className="col" style={{ gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Qubits k</span>
              <Seg value={qubits} onChange={setQubits} options={['2', '3', '4', '5'].map((v) => ({ value: v, label: `${v} · ${2 ** +v} nodes` }))} />
            </div>
            <Param label="Trotter reps" hint="2nd-order Suzuki steps" value={reps} min={1} max={6} step={1} onChange={setReps} fmtv={(v) => String(v)} />
            <div className="col" style={{ gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Shots</span>
              <Seg value={shots} onChange={setShots} options={['512', '4096', '16384'].map((v) => ({ value: v, label: fmt(+v) }))} />
            </div>
            <div className="row"><RunBtn busy={busy} onClick={run} disabled={!issue.trim()}>Run circuit</RunBtn></div>
          </div>
        </Card>
      </>}
      right={res && <>
        <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
          <StatTile label="Qubits" value={res.stats.qubits} hint={`${2 ** res.qubits} basis states`} fill="yellow" icon={<Cpu size={18} />} />
          <StatTile label="Depth" value={res.stats.depth} hint="cx · rz · sx · x basis" />
          <StatTile label="CNOTs" value={res.stats.cx} hint={`${fmt(res.stats.gates)} gates`} />
          <StatTile label="Pauli terms" value={res.stats.pauli_terms ?? 0} hint="in H" fill="cyan" />
          <StatTile label="TVD shots vs exact" value={res.tvd_sampled_exact.toFixed(3)} hint={`Trotter error ${res.tvd_trotter_exact.toFixed(4)}`} fill="pink" />
        </div>
        <Card title="Measured vs exact" sub={`Each bar is one basis state |bits⟩ = one code unit. Averaged over t ∈ {${res.times.map((x) => x.toFixed(2)).join(', ')}}, ${fmt(res.shots)} shots per t.`}>
          <Legend items={[{ label: 'exact e^{−iHt}', color: S[0] }, { label: 'circuit (sampled)', color: S[1] }]} />
          <div style={{ height: 250, marginTop: 8 }}>
            <ResponsiveContainer>
              <BarChart data={bars} barCategoryGap="22%" barGap={2} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="label" {...AX} interval={0} />
                <YAxis {...AX} tickFormatter={(v) => `${Math.round(v * 100)}%`} width={44} />
                <Tooltip cursor={{ fill: 'var(--grid)' }} content={({ active, payload }) => active && payload?.length ? (
                  <ChartTip title={`|${payload[0].payload.bits}⟩ ${payload[0].payload.name}`} rows={[
                    { label: 'exact', value: pct(payload[0].payload.exact), color: S[0] },
                    { label: 'sampled', value: pct(payload[0].payload.sampled), color: S[1] },
                    { label: 'start p₀', value: pct(payload[0].payload.p0) }]} />) : null} />
                <Bar dataKey="exact" fill={S[0]} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                <Bar dataKey="sampled" fill={S[1]} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <table className="qtable">
            <thead><tr><th>state</th><th>unit</th><th className="n">p₀</th><th className="n">exact</th><th className="n">sampled</th></tr></thead>
            <tbody>{res.nodes.map((n) => (
              <tr key={n.index}>
                <td className="mono">|{n.bits}⟩</td>
                <td className="mono ellipsis" title={n.key ?? ''}>{n.name}{n.seed && <span className="badge fill-yellow" style={{ height: 16, fontSize: 9, marginLeft: 6 }}>seed</span>}</td>
                <td className="n">{pct(n.p0)}</td><td className="n">{pct(n.exact)}</td><td className="n">{pct(n.sampled)}</td>
              </tr>))}</tbody>
          </table>
        </Card>
        <Card title="The circuit" sub="Prepare √p, evolve under H for time t, measure. Qiskit expands the evolution into the CNOT/RZ ladder counted above.">
          <pre className="code" style={{ maxHeight: 260, fontSize: 10.5 }}>{res.circuit_text}</pre>
        </Card>
      </>}
    />
  )
}

// ---------------------------------------------------------------------------- QAOA pack

function PackPanel({ ws, issue, tau, shared }: PP) {
  const [budget, setBudget] = useState('4000')
  const [k, setK] = useState(10)
  const [reps, setReps] = useState(2)
  const [mu, setMu] = useState(0.3)
  const [ranking, setRanking] = useState<'quantum' | 'ppr'>('quantum')
  const [noise, setNoise] = useState(0)
  const { res, busy, err, run } = useRun<QPackResult>(() => api.qpack(ws.repoId, { issue, tau, budget: +budget, k, reps, ranking, mu, noise_p: noise }), false)
  const [open, setOpen] = useState<string | null>(null)
  const sols = res ? ([['greedy', 'Greedy'], ['random', 'Random'], ['exact', 'Exact'], ['qaoa', 'QAOA']] as const) : []
  return (
    <Shell busy={busy} err={err} res={res} waiting="Optimising γ, β…"
      left={<>
        {shared}
        <Card title="QUBO" sub="E = −Σsᵢxᵢ − μΣwᵢⱼxᵢxⱼ + P(Σc̃ᵢxᵢ + slack − B̃)²">
          <div className="col" style={{ gap: 14 }}>
            <div className="col" style={{ gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Token budget B</span>
              <Seg value={budget} onChange={setBudget} options={['2000', '4000', '8000', '16000'].map((b) => ({ value: b, label: `${+b / 1000}k` }))} />
            </div>
            <div className="col" style={{ gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Scores from</span>
              <Seg value={ranking} onChange={setRanking} options={[{ value: 'quantum', label: 'Quantum walk' }, { value: 'ppr', label: 'PPR' }]} />
            </div>
            <Param label="K candidates" hint={`${k + 4} qubits with 4 slack`} value={k} min={4} max={14} step={1} onChange={setK} fmtv={(v) => String(v)} />
            <Param label="p layers" hint="QAOA depth" value={reps} min={1} max={4} step={1} onChange={setReps} fmtv={(v) => String(v)} />
            <Param label="μ co-change" hint="pack co-changing units together" value={mu} min={0} max={1.5} step={0.1} onChange={setMu} />
            <Param label="gate noise" hint="depolarising p per gate (NISQ)" value={noise} min={0} max={0.03} step={0.0025} onChange={setNoise} fmtv={(v) => pct(v, 2)} />
            <div className="row"><RunBtn busy={busy} onClick={run} disabled={!issue.trim()}>Run QAOA</RunBtn></div>
          </div>
        </Card>
      </>}
      right={res && <>
        <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
          <StatTile label="QAOA / exact" value={pct(res.solutions.qaoa.ratio)} hint={`best of ${fmt(2048)} shots`} fill="yellow" />
          <StatTile label="Greedy / exact" value={pct(res.solutions.greedy.ratio)} hint="rank order, today's packer" />
          <StatTile label="Random / exact" value={pct(res.solutions.random.ratio)} hint="same shots, no circuit" />
          <StatTile label="P(optimum)" value={pct(res.solutions.qaoa.p_opt, 2)} hint={`uniform: ${pct(1 / 2 ** res.candidates_k, 2)}`} fill="cyan" />
          <StatTile label={res.noisy ? `Noisy (${pct(res.noisy.noise_p, 2)})` : 'Qubits'} value={res.noisy ? pct(res.noisy.ratio) : res.qubits}
            hint={res.noisy ? `P(opt) ${pct(res.noisy.p_opt, 2)}` : `${res.circuit.cx} CNOTs · depth ${res.circuit.depth}`} fill="pink" />
        </div>
        <Card title="Which bodies go in" sub={`Body budget ρB = ${fmt(Math.round(res.body_budget))} tokens, discretised into units of ${Math.round(res.unit_tokens)}. ✓ = full body packed.`}>
          <table className="qtable">
            <thead><tr><th>#</th><th>unit</th><th className="n">score</th><th className="n">tokens</th>{sols.map(([s, l]) => <th key={s} className="c">{l}</th>)}</tr></thead>
            <tbody>{res.candidates.map((cd, i) => (
              <tr key={cd.key}>
                <td className="mono muted">{i + 1}</td>
                <td className="mono ellipsis" title={cd.key}>{cd.name}{cd.cochange.length > 0 && <span className="badge fill-pink" style={{ height: 16, fontSize: 9, marginLeft: 6 }} title={cd.cochange.map((x) => `${label(x.with)} (${x.w})`).join(', ')}>co-change {cd.cochange.length}</span>}</td>
                <td className="n">{cd.score.toFixed(2)}</td>
                <td className="n">{fmt(cd.tokens)}</td>
                {sols.map(([s]) => <td key={s} className="c">{res.solutions[s].selection[i] ? <Check size={15} strokeWidth={3} /> : <span className="muted">·</span>}</td>)}
              </tr>))}
              <tr className="tot">
                <td /><td>objective · tokens</td><td /><td />
                {sols.map(([s]) => <td key={s} className="c mono">{res.solutions[s].value.toFixed(2)}<br /><span className="muted">{fmt(res.solutions[s].tokens)}</span></td>)}
              </tr>
            </tbody>
          </table>
        </Card>
        <div className="g2e">
          <Card title="Optimiser" sub={`COBYLA on ⟨H_C⟩ (scaled), p = ${res.reps}. γ = [${res.angles.gamma.map((g) => g.toFixed(2)).join(', ')}], β = [${res.angles.beta.map((b) => b.toFixed(2)).join(', ')}]`}>
            <div style={{ height: 200 }}>
              <ResponsiveContainer>
                <LineChart data={res.convergence.map((v, i) => ({ i, v }))} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                  <CartesianGrid {...GRID} />
                  <XAxis dataKey="i" {...AX} type="number" domain={[0, 'dataMax']} />
                  <YAxis {...AX} width={44} tickFormatter={(v) => (+v).toFixed(2)} />
                  <Tooltip cursor={{ stroke: 'var(--ink)', strokeWidth: 1 }} content={({ active, payload }) => active && payload?.length ? (
                    <ChartTip title={`evaluation ${payload[0].payload.i}`} rows={[{ label: '⟨H_C⟩', value: (payload[0].value as number).toFixed(4) }]} />) : null} />
                  <Line dataKey="v" stroke={S[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              {res.qubits} qubits ({res.candidates_k} units + {res.slack_bits} slack) · {res.circuit.pauli_terms} Pauli terms · {res.circuit.cx} CNOTs · depth {res.circuit.depth}
            </div>
          </Card>
          <Card title="Packed context" sub="QAOA's bodies first, then signatures fill the rest of B">
            <div className="tokbar" role="img" aria-label={`${res.tokens.body} body tokens, ${res.tokens.signature} signature tokens of ${res.budget}`}>
              <span style={{ width: `${(res.tokens.body / res.budget) * 100}%`, background: 'var(--s1)' }} />
              <span style={{ width: `${(res.tokens.signature / res.budget) * 100}%`, background: 'var(--s4)' }} />
            </div>
            <div className="row" style={{ gap: 12, fontSize: 12, marginTop: 6 }}>
              <span className="row" style={{ gap: 5 }}><span className="swatch" style={{ background: 'var(--s1)' }} /> bodies {fmt(res.tokens.body)}</span>
              <span className="row" style={{ gap: 5 }}><span className="swatch" style={{ background: 'var(--s4)' }} /> signatures {fmt(res.tokens.signature)}</span>
            </div>
            <div className="col" style={{ gap: 4, marginTop: 10, maxHeight: 220, overflow: 'auto' }}>
              {res.packed.map((p) => (
                <div key={p.key}>
                  <button className="nb-row" style={{ width: '100%', background: 'none', border: 0, borderBottom: '1.5px dashed var(--grid)', textAlign: 'left' }} onClick={() => setOpen(open === p.key ? null : p.key)}>
                    <span className={`mv ${p.mode === 'body' ? 'up' : 'new'}`}>{p.mode === 'body' ? 'body' : 'sig'}</span>
                    <span className="mono grow ellipsis" style={{ fontWeight: 700 }}>{label(p.key)}</span>
                    <span className="muted mono" style={{ fontSize: 11 }}>{p.tokens} tok</span>
                  </button>
                  {open === p.key && <pre className="code" style={{ maxHeight: 220, marginTop: 6 }}>{p.text}</pre>}
                </div>
              ))}
            </div>
          </Card>
        </div>
      </>}
    />
  )
}

// ---------------------------------------------------------------------------- QEC

const CODE_INFO: Record<QecCode, { label: string; short: string; per: string; fixes: string }> = {
  bitflip: { label: '3-qubit bit-flip', short: 'Bit-flip', per: '3 data + 2 ancilla', fixes: 'one X error per block' },
  phaseflip: { label: '3-qubit phase-flip', short: 'Phase-flip', per: '3 data + 2 ancilla', fixes: 'one Z error per block' },
  shor: { label: 'Shor 9-qubit', short: 'Shor', per: '9 data', fixes: 'any one Pauli error per block' },
}
const CHANNEL_LABEL: Record<QecChannel, string> = { bit: 'Bit flip (X)', phase: 'Phase flip (Z)', depol: 'Depolarising' }
const CHANNEL_SHORT: Record<QecChannel, string> = { bit: 'X', phase: 'Z', depol: 'Depol.' }
const Arrow = ({ a, b }: { a: string; b: string }) => <span style={{ fontSize: 26 }}>{a}<span className="muted"> → </span>{b}</span>

function QecPanel({ ws, issue, tau, shared }: PP) {
  const [code, setCode] = useState<QecCode>('bitflip')
  const [channel, setChannel] = useState<QecChannel>('bit')
  const [p, setP] = useState(0.08)
  const [k, setK] = useState('2')
  const maxK = code === 'shor' ? 2 : 3
  const kk = String(Math.min(+k, maxK))
  const { res, busy, err, run } = useRun<QecResult>(() => api.qec(ws.repoId, { issue, tau, qubits: +kk, code, channel, p, shots: 1024 }), !!issue)
  const [sweepRes, setSweep] = useState<QecSweep | null>(null)
  useEffect(() => {
    let live = true
    api.qecSweep(code, channel).then((s) => live && setSweep(s)).catch(() => {})
    return () => { live = false }
  }, [code, channel])
  const sweep = sweepRes && sweepRes.code === code && sweepRes.channel === channel ? sweepRes : null
  const m = res?.metrics
  const totalSyn = res?.syndromes.reduce((a, s) => a + s.count, 0) ?? 1
  return (
    <Shell busy={busy} err={err} res={res} waiting="Simulating noisy trajectories…"
      left={<>
        {shared}
        <Card title="Noise and code" sub="prep → walk t/2 → encode → noisy memory → syndrome · correct · decode → walk t/2">
          <div className="col" style={{ gap: 14 }}>
            <div className="col" style={{ gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Code</span>
              <Seg value={code} onChange={setCode} options={(['bitflip', 'phaseflip', 'shor'] as const).map((c) => ({ value: c, label: CODE_INFO[c].short }))} />
              <span className="muted" style={{ fontSize: 12 }}>{CODE_INFO[code].per} per logical qubit · corrects {CODE_INFO[code].fixes}</span>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Noise channel</span>
              <Seg value={channel} onChange={setChannel} options={(['bit', 'phase', 'depol'] as const).map((c) => ({ value: c, label: CHANNEL_SHORT[c] }))} />
            </div>
            <Param label="p" hint="error probability per qubit" value={p} min={0} max={0.3} step={0.01} onChange={setP} />
            <div className="col" style={{ gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Logical qubits</span>
              <Seg value={kk} onChange={setK} options={Array.from({ length: maxK }, (_, i) => String(i + 1)).map((v) => ({ value: v, label: `${v} · ${2 ** +v} nodes` }))} />
            </div>
            <div className="row"><RunBtn busy={busy} onClick={run} disabled={!issue.trim()}>Run with QEC</RunBtn></div>
          </div>
        </Card>
      </>}
      right={res && m && <>
        <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
          <StatTile label="Physical qubits" value={res.physical_qubits} hint={`${res.logical_qubits} logical · ${res.data_qubits} data`} fill="yellow" icon={<ShieldCheck size={18} />} />
          <StatTile label="Distance to ideal" value={<Arrow a={m.tvd_noisy.toFixed(3)} b={m.tvd_qec.toFixed(3)} />} hint="TVD, noisy → with QEC" />
          <StatTile label="Fidelity" value={<Arrow a={f3(m.fidelity_noisy)} b={f3(m.fidelity_qec)} />} hint="⟨ψ|ρ|ψ⟩, noisy → QEC" fill="cyan" />
          <StatTile label="Ranking kept" value={<Arrow a={m.kendall_noisy == null ? (m.top1_noisy ? '✓' : '✗') : m.kendall_noisy.toFixed(2)} b={m.kendall_qec == null ? (m.top1_qec ? '✓' : '✗') : m.kendall_qec.toFixed(2)} />}
            hint={m.kendall_noisy == null ? 'top unit unchanged' : 'Kendall τ vs ideal order'} fill="pink" />
        </div>
        <Card title="Node probabilities after the walk" sub={`${CHANNEL_LABEL[res.channel]} noise with p = ${res.p} on every qubit in the memory window. QEC is averaged over ${fmt(res.shots)} noise trajectories; the unprotected run is exact.`}>
          <Legend items={[{ label: 'ideal', color: S[0] }, { label: 'noisy, unprotected', color: S[1] }, { label: `with ${CODE_INFO[res.code].label}`, color: S[2] }]} />
          <div style={{ height: 240, marginTop: 8 }}>
            <ResponsiveContainer>
              <BarChart data={res.nodes} barCategoryGap="20%" barGap={2} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="name" {...AX} interval={0} tickFormatter={(v: string) => (v.length > 12 ? `${v.slice(0, 11)}…` : v)} />
                <YAxis {...AX} tickFormatter={(v) => `${Math.round(v * 100)}%`} width={44} />
                <Tooltip cursor={{ fill: 'var(--grid)' }} content={({ active, payload }) => active && payload?.length ? (
                  <ChartTip title={`|${payload[0].payload.bits}⟩ ${payload[0].payload.name}`} rows={[
                    { label: 'ideal', value: pct(payload[0].payload.ideal), color: S[0] },
                    { label: 'noisy', value: pct(payload[0].payload.noisy), color: S[1] },
                    { label: 'QEC', value: pct(payload[0].payload.qec), color: S[2] }]} />) : null} />
                <Bar dataKey="ideal" fill={S[0]} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                <Bar dataKey="noisy" fill={S[1]} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                <Bar dataKey="qec" fill={S[2]} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <div className="g2e">
          <Card title="Syndromes" sub="What the decoder concluded on each block, pooled over logical qubits and shots">
            <div className="col" style={{ gap: 8 }}>
              {res.syndromes.slice(0, 9).map((s) => (
                <div key={s.label} className="col" style={{ gap: 3 }}>
                  <div className="row between" style={{ fontSize: 12.5 }}>
                    <span className="mono" style={{ fontWeight: 700 }}>{s.label}</span>
                    <span className="muted mono">{pct(s.count / totalSyn)}</span>
                  </div>
                  <div className="hc-bar"><span style={{ width: `${(s.count / totalSyn) * 100}%`, background: s.label === 'none' ? 'var(--s3)' : 'var(--s2)' }} /></div>
                </div>
              ))}
              {res.syndromes.length > 9 && <span className="muted" style={{ fontSize: 12 }}>+ {res.syndromes.length - 9} rarer patterns (multiple errors)</span>}
            </div>
          </Card>
          <Card title="When does the code help?" sub={sweep ? `Logical vs physical error rate for one logical qubit (exact density-matrix simulation). ${sweep.breakeven != null && sweep.breakeven < 0.5 ? `Break-even near p ≈ ${sweep.breakeven}.` : 'Helps for every p < 0.5.'}` : 'Computing…'}>
            {sweep ? <>
              <Legend items={[{ label: 'unprotected', color: S[1] }, { label: CODE_INFO[sweep.code].label, color: S[2] }, ...(sweep.rows.some((r) => r.theory != null) ? [{ label: 'theory', color: 'var(--ink-2)' }] : [])]} />
              <div style={{ height: 210, marginTop: 8 }}>
                <ResponsiveContainer>
                  <LineChart data={sweep.rows} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                    <CartesianGrid {...GRID} />
                    <XAxis dataKey="p" {...AX} type="number" domain={[0, 0.5]} ticks={[0, 0.1, 0.2, 0.3, 0.4, 0.5]} tickFormatter={(v) => (+v).toFixed(1)} />
                    <YAxis {...AX} domain={[0, 'auto']} width={44} tickFormatter={(v) => (+v).toFixed(2)} />
                    <Tooltip cursor={{ stroke: 'var(--ink)', strokeWidth: 1 }} content={({ active, payload }) => active && payload?.length ? (
                      <ChartTip title={`physical p = ${payload[0].payload.p}`} rows={[
                        { label: 'unprotected', value: f3(payload[0].payload.unprotected), color: S[1] },
                        { label: 'protected', value: f3(payload[0].payload.protected), color: S[2] },
                        ...(payload[0].payload.theory != null ? [{ label: 'theory', value: f3(payload[0].payload.theory) }] : [])]} />) : null} />
                    {res.p > 0 && <ReferenceLine x={res.p} stroke="var(--ink-3)" strokeDasharray="3 3" />}
                    <Line dataKey="unprotected" stroke={S[1]} strokeWidth={2} dot={false} isAnimationActive={false} />
                    <Line dataKey="protected" stroke={S[2]} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                    <Line dataKey="theory" stroke="var(--ink-2)" strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                {(sweep.code === 'bitflip' && sweep.channel === 'phase') || (sweep.code === 'phaseflip' && sweep.channel === 'bit')
                  ? 'The code cannot see this error type, so it makes things worse: three qubits to hit instead of one. That is why Shor combines both codes.'
                  : sweep.code !== 'shor' && sweep.channel === 'depol' ? 'Depolarising noise mixes X, Y and Z, and a 3-qubit code catches only one kind.'
                  : 'Theory for 3-qubit codes: two or more of three qubits fail, p_L = 3p² − 2p³.'}
              </div>
            </> : <div className="row muted" style={{ padding: 20, gap: 8 }}><Loader2 size={16} className="spin" /> Sweeping p…</div>}
          </Card>
        </div>
        <Card title={`${CODE_INFO[res.code].label} circuit, one logical qubit`} sub="Encode, the noisy memory window (barrier), syndrome extraction and correction, decode">
          <pre className="code" style={{ maxHeight: 300, fontSize: 10.5 }}>{res.circuit_text}</pre>
        </Card>
      </>}
    />
  )
}

// ---------------------------------------------------------------------------- quantum code

function CodePanel({ ws }: { ws: WS }) {
  const q = ws.stats.quantum
  const growth = useMemo(() => (q?.growth ?? []).map((g) => ({ ...g, ts: ws.temporal.commits[g.t]?.ts ?? 0 })), [q, ws.temporal])
  if (!q) {
    return (
      <Card>
        <Empty title="No quantum code in this repository" icon={<Atom size={30} />}>
          TCG tags definitions that use Qiskit, Cirq or PennyLane, plus OpenQASM <span className="mono">.qasm</span> files.
          Build a quantum repository (for example <span className="mono">qiskit-community/qiskit-optimization</span>) to see
          circuits and gates over its history. The quantum walk, circuit, QAOA and error-correction panels work on any repository.
        </Empty>
      </Card>
    )
  }
  const k = q.kpis
  const mixMax = Math.max(1, ...q.gate_mix.map((g) => g.count))
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="kpi-grid">
        <StatTile label="Circuits" value={k.circuits} delta={k.circuits_delta} hint="vs c₀" fill="yellow" icon={<Atom size={18} />} />
        <StatTile label="Gate applications" value={k.gates} delta={k.gates_delta} hint="static count" />
        <StatTile label="Multi-qubit gates" value={k.two_qubit} hint={k.gates ? `${pct(k.two_qubit / k.gates, 0)} of gates` : ''} />
        <StatTile label="Measurements" value={k.measure} hint="measure · expval · probs" fill="cyan" />
        <StatTile label="Widest circuit" value={`${k.max_qubits} q`} hint="estimated qubits" />
        <StatTile label="QASM gate defs" value={k.gate_defs} hint={Object.entries(q.frameworks).map(([f, n]) => `${f} ${n}`).join(' · ')} fill="pink" />
      </div>
      <div className="g2e">
        <Card title={<span className="row" style={{ gap: 8 }}><Sparkles size={18} /> Quantum code over time</span>} sub="Gate applications in live definitions at every commit, from the same interval store as the graph">
          <Legend items={[{ label: 'all gates', color: S[0] }, { label: 'multi-qubit', color: S[1] }, { label: 'measurements', color: S[2] }]} />
          <div style={{ height: 240, marginTop: 8 }}>
            <ResponsiveContainer>
              <LineChart data={growth} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                <CartesianGrid {...GRID} />
                <XAxis dataKey="t" {...AX} type="number" domain={['dataMin', 'dataMax']} tickFormatter={(t) => shortDate(ws.temporal.commits[t]?.ts ?? 0)} />
                <YAxis {...AX} width={44} allowDecimals={false} />
                <Tooltip cursor={{ stroke: 'var(--ink)', strokeWidth: 1 }} content={({ active, payload }) => active && payload?.length ? (
                  <ChartTip title={`c${payload[0].payload.t} · ${date(payload[0].payload.ts)}`} rows={[
                    { label: 'gates', value: fmt(payload[0].payload.gates), color: S[0] },
                    { label: 'multi-qubit', value: fmt(payload[0].payload.two_qubit), color: S[1] },
                    { label: 'measurements', value: fmt(payload[0].payload.measure), color: S[2] },
                    { label: 'circuits', value: fmt(payload[0].payload.circuits) }]} />) : null} />
                <ReferenceLine x={ws.tau} stroke="var(--ink-3)" strokeDasharray="3 3" />
                <Line dataKey="gates" stroke={S[0]} strokeWidth={2} dot={false} isAnimationActive={false} type="stepAfter" />
                <Line dataKey="two_qubit" stroke={S[1]} strokeWidth={2} dot={false} isAnimationActive={false} type="stepAfter" />
                <Line dataKey="measure" stroke={S[2]} strokeWidth={2} dot={false} isAnimationActive={false} type="stepAfter" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="Gate mix" sub="Canonical names across frameworks (CNOT = cx, Hadamard = h, Toffoli = ccx)">
          <div className="col" style={{ gap: 7 }}>
            {q.gate_mix.map((g) => (
              <div key={g.gate} className="row" style={{ gap: 10 }}>
                <span className="mono ellipsis" style={{ width: 92, flexShrink: 0, fontWeight: 700 }} title={g.gate}>{g.gate}</span>
                <div className="hc-bar grow"><span style={{ width: `${(g.count / mixMax) * 100}%` }} /></div>
                <span className="mono muted" style={{ width: 44, textAlign: 'right', fontSize: 12 }}>{fmt(g.count)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
      <Card title="Largest circuits and gates" sub="Click to open in the graph. Lifetime = commit interval [s, f) of the definition.">
        <table className="qtable">
          <thead><tr><th>definition</th><th>framework</th><th className="n">gates</th><th className="n">multi</th><th className="n">meas.</th><th className="n">qubits</th><th className="n">since</th></tr></thead>
          <tbody>{q.top.map((c) => (
            <tr key={c.key} onClick={() => ws.go('graph', c.key)} style={{ cursor: 'pointer' }}>
              <td className="ellipsis" title={c.key}><span className="mono" style={{ fontWeight: 700 }}>{c.name}</span> <span className="muted" style={{ fontSize: 11 }}>{splitKey(c.key).file}</span>
                {c.circuit && <span className="badge fill-violet" style={{ height: 16, fontSize: 9, marginLeft: 6 }}>circuit</span>}</td>
              <td>{c.framework}</td>
              <td className="n">{c.n_gates}</td><td className="n">{c.two_qubit}</td><td className="n">{c.measure}</td><td className="n">{c.qubits || '–'}</td>
              <td className="n mono">c{c.s}</td>
            </tr>))}</tbody>
        </table>
      </Card>
    </div>
  )
}
