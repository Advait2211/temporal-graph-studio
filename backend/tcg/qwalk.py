"""Quantum-walk ranking over G_τ.

A continuous-time quantum walk (CTQW) replaces PageRank's random walk. The Hamiltonian is the
normalised Laplacian of the symmetrised mixed-edge graph,

    H = I − D^-½ A D^-½,      A = ½ (W + Wᵀ),   W = Σ_r α_r A^(r) (+ α_cc · w_cc),

the walk starts in the amplitude encoding of the personalisation vector |ψ₀⟩ = Σ √p(v) |v⟩, and a
node's score is its time-averaged probability

    q(v) = mean_k |⟨v| e^{−iHt_k} |ψ₀⟩|²,   t_k ∈ [0, t_max].

Unlike PageRank, amplitudes interfere: two paths to a node can reinforce or cancel.

`exact()` simulates the walk on the whole graph (an n-node graph is an n-dimensional Hilbert space,
i.e. ⌈log₂ n⌉ qubits, so it is cheap to simulate classically). `circuit()` runs the same walk as a real
gate-based Qiskit circuit on the top 2^k nodes: state preparation, Trotterised Pauli evolution, measurement.
"""

from __future__ import annotations

import warnings

import numpy as np
import scipy.linalg as la
import scipy.sparse as sp
from scipy.sparse.linalg import expm_multiply

from . import retrieve

QW_DEFAULTS = {"qw_time": 3.0, "qw_samples": 24}


# ---------------------------------------------------------------------------- core maths


def laplacian(W: sp.spmatrix) -> sp.csr_matrix:
    """Normalised Laplacian of the symmetrised graph. Isolated nodes get a zero row (they never move)."""
    A = ((W + W.T) * 0.5).tocsr()
    d = np.asarray(A.sum(axis=1)).ravel()
    alive = d > 0
    dinv = np.zeros_like(d)
    dinv[alive] = 1.0 / np.sqrt(d[alive])
    Dm = sp.diags(dinv)
    return (sp.diags(alive.astype(float)) - Dm @ A @ Dm).tocsr()


def ctqw(L: sp.spmatrix, psi0: np.ndarray, t_max: float, samples: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Probabilities |⟨v|e^{−iLt}|ψ₀⟩|² on an even time grid. Returns (time-average, trajectory, times)."""
    samples = max(2, int(samples))
    ts = np.linspace(0.0, t_max, samples)
    states = expm_multiply(-1j * L.astype(complex), psi0.astype(complex), start=0.0, stop=t_max, num=samples,
                           endpoint=True)
    probs = np.abs(states) ** 2
    return probs.mean(axis=0), probs, ts


def tvd(a: np.ndarray, b: np.ndarray) -> float:
    return float(0.5 * np.abs(np.asarray(a) - np.asarray(b)).sum())


def _qparams(params: dict | None) -> dict:
    out = dict(QW_DEFAULTS)
    for k in QW_DEFAULTS:
        if params and k in params:
            out[k] = float(params[k])
    out["qw_time"] = min(max(out["qw_time"], 0.1), 20.0)
    out["qw_samples"] = int(min(max(out["qw_samples"], 4), 96))
    return out


# ---------------------------------------------------------------------------- exact walk on G_τ


class WalkState:
    """Everything a quantum ranking needs at τ: snapshot, seeds, p, A, L and both kinds of scores."""

    def __init__(self, repo_id: str, issue: str, tau: int | None, params: dict | None):
        self.S, self.seeds, self.a = retrieve.prepare(repo_id, issue, tau, params)
        self.qa = _qparams(params)
        S = self.S
        self.p = retrieve._personalisation(S, self.seeds, self.a["beta"])
        self.W = retrieve._mixed_weights(S, self.a, True)
        self.L = laplacian(self.W)
        self.q, self.traj, self.ts = ctqw(self.L, np.sqrt(self.p), self.qa["qw_time"], self.qa["qw_samples"])
        self.pi, self.pi_static = retrieve.rankings(S, self.seeds, self.a)
        self.units = retrieve.units(S)

    def order(self, scores: np.ndarray) -> list[int]:
        return sorted(self.units, key=lambda i: -scores[i])


def _overlap(a: list[int], b: list[int], k: int = 10) -> int:
    return len(set(a[:k]) & set(b[:k]))


def walk(repo_id: str, issue: str, tau: int | None, params: dict | None = None) -> dict:
    ws = WalkState(repo_id, issue, tau, params)
    S, q = ws.S, ws.q
    oq, op, os_ = ws.order(q), ws.order(ws.pi), ws.order(ws.pi_static)
    rp = {i: r for r, i in enumerate(op)}
    rs = {i: r for r, i in enumerate(os_)}

    def item(i: int, r: int) -> dict:
        nd = S.nodes[i]
        pr = rp.get(i)
        return {"rank": r + 1, "key": nd["key"], "name": nd["name"], "qual": nd["qual"], "kind": nd["kind"],
                "path": nd["path"], "score": float(q[i]), "p0": float(ws.p[i]),
                "ppr_rank": pr + 1 if pr is not None else None, "static_rank": (rs[i] + 1) if i in rs else None,
                "moved": (pr - r) if pr is not None else None, "community": nd["community"],
                "seed": sorted({rr for rr, _, _ in ws.seeds.get(i, [])})}

    def short(order: list[int], scores: np.ndarray) -> list[dict]:
        return [{"rank": r + 1, "key": S.nodes[i]["key"], "name": S.nodes[i]["name"], "path": S.nodes[i]["path"],
                 "score": float(scores[i]), "quantum_rank": oq.index(i) + 1 if i in oq[:200] else None}
                for r, i in enumerate(order[:40])]

    # interference picture: probability over time of the top units, plus total mass sitting on seeds
    top = oq[:6]
    seed_idx = np.array(sorted(ws.seeds), dtype=int)
    traj = []
    for k, t in enumerate(ws.ts):
        row = {"t": round(float(t), 4), "seed_mass": float(ws.traj[k, seed_idx].sum()) if len(seed_idx) else 0.0}
        for i in top:
            row[S.nodes[i]["key"]] = float(ws.traj[k, i])
        traj.append(row)

    # how far the walk spreads: participation ratio of the time-averaged distribution
    spread = float(1.0 / np.sum(q ** 2)) if q.sum() > 0 else 0.0
    return {
        "tau": S.tau, "sha": S.sha, "params": {**ws.a, **ws.qa},
        "ranking": [item(i, r) for r, i in enumerate(oq[:40])],
        "ppr_ranking": short(op, ws.pi), "static_ranking": short(os_, ws.pi_static),
        "trajectory": traj, "trajectory_keys": [{"key": S.nodes[i]["key"], "name": S.nodes[i]["name"]} for i in top],
        "summary": {
            "graph_nodes": len(S.nodes), "graph_edges": len(S.edges), "seed_count": len(ws.seeds),
            "overlap_ppr": _overlap(oq, op), "overlap_static": _overlap(oq, os_), "overlap_ppr_static": _overlap(op, os_),
            "spread_nodes": round(spread, 1), "qubits_equivalent": int(np.ceil(np.log2(max(2, len(S.nodes))))),
        },
    }


# ---------------------------------------------------------------------------- gate-based circuit


def select_subgraph(ws: WalkState, k: int) -> list[int]:
    """Top 2^k nodes of the exact walk, with the strongest seeds forced in."""
    N = 2 ** k
    seeds = sorted(ws.seeds, key=lambda i: -ws.p[i])[: max(1, N // 2)]
    chosen = list(dict.fromkeys(seeds))
    for i in np.argsort(-ws.q):
        if len(chosen) >= N:
            break
        if int(i) not in chosen:
            chosen.append(int(i))
    return chosen[:N]


def sub_problem(ws: WalkState, sel: list[int], k: int) -> tuple[np.ndarray, np.ndarray]:
    """Dense 2^k × 2^k normalised Laplacian of the induced subgraph (padded with isolated dummies) and √p."""
    N = 2 ** k
    A = ((ws.W + ws.W.T) * 0.5).tocsr()[sel][:, sel].toarray()
    Ap = np.zeros((N, N))
    Ap[: len(sel), : len(sel)] = A
    Lsub = laplacian(sp.csr_matrix(Ap)).toarray()
    p = np.zeros(N)
    p[: len(sel)] = ws.p[sel]
    if p.sum() <= 0:
        p[: len(sel)] = 1.0
    p /= p.sum()
    return Lsub, np.sqrt(p)


def walk_circuit(Lsub: np.ndarray, amps: np.ndarray, t: float, reps: int, measure: bool = True):
    """StatePreparation(√p) → exp(−iHt) as a Suzuki–Trotter product of Pauli rotations → measure."""
    from qiskit import QuantumCircuit
    from qiskit.circuit.library import PauliEvolutionGate, StatePreparation
    from qiskit.quantum_info import SparsePauliOp
    from qiskit.synthesis import SuzukiTrotter

    k = int(np.log2(len(amps)))
    H = SparsePauliOp.from_operator(Lsub).simplify(atol=1e-10)
    qc = QuantumCircuit(k, name="ctqw")
    qc.append(StatePreparation(amps.astype(complex), label="prep √p"), range(k))
    qc.append(PauliEvolutionGate(H, time=float(t), synthesis=SuzukiTrotter(order=2, reps=max(1, int(reps))),
                                 label=f"exp(-iH·{t:.2f})"), range(k))
    if measure:
        qc.measure_all()
    return qc, H


BASIS = ["cx", "rz", "sx", "x"]


def circuit_stats(qc) -> dict:
    from qiskit import transpile

    tq = transpile(qc.remove_final_measurements(inplace=False), basis_gates=BASIS, optimization_level=1,
                   seed_transpiler=7)
    ops = dict(tq.count_ops())
    return {"qubits": qc.num_qubits, "depth": tq.depth(), "cx": int(ops.get("cx", 0)), "gates": int(sum(ops.values())),
            "ops": {k: int(v) for k, v in ops.items()}}


def circuit(repo_id: str, issue: str, tau: int | None, qubits: int = 3, t: float | None = None, reps: int = 2,
            shots: int = 4096, times: int = 4, params: dict | None = None) -> dict:
    from qiskit import transpile
    from qiskit.primitives import StatevectorSampler
    from qiskit.quantum_info import Statevector

    warnings.filterwarnings("ignore", category=sp.SparseEfficiencyWarning)
    k = int(min(max(qubits, 2), 5))
    ws = WalkState(repo_id, issue, tau, params)
    S = ws.S
    t_max = float(t if t is not None else ws.qa["qw_time"])
    sel = select_subgraph(ws, k)
    Lsub, amps = sub_problem(ws, sel, k)
    N = 2 ** k
    tk = [(j + 0.5) * t_max / times for j in range(times)]  # midpoint rule over [0, t_max]

    exact = np.zeros(N)
    trotter = np.zeros(N)
    circuits = []
    H = None
    for t_ in tk:
        exact += np.abs(la.expm(-1j * Lsub * t_) @ amps) ** 2
        qc, H = walk_circuit(Lsub, amps, t_, reps)
        # synthesise to hardware gates first: simulating the PauliEvolutionGate object directly would use
        # the exact exponential and hide the Trotter error
        tq = transpile(qc, basis_gates=BASIS, optimization_level=1, seed_transpiler=7)
        trotter += Statevector(tq.remove_final_measurements(inplace=False)).probabilities()
        circuits.append(tq)
    exact /= times
    trotter /= times

    res = StatevectorSampler(seed=7).run(circuits, shots=int(shots)).result()
    sampled = np.zeros(N)
    for r in res:
        for bits, c in r.data.meas.get_counts().items():
            sampled[int(bits, 2)] += c
    sampled /= sampled.sum()

    st = circuit_stats(circuits[-1])
    st["pauli_terms"] = len(H) if H is not None else 0
    nodes = []
    for j in range(N):
        i = sel[j] if j < len(sel) else None
        nd = S.nodes[i] if i is not None else None
        nodes.append({
            "index": j, "bits": format(j, f"0{k}b"), "key": nd["key"] if nd else None,
            "name": nd["name"] if nd else "(padding)", "kind": nd["kind"] if nd else None,
            "seed": bool(i is not None and i in ws.seeds), "p0": float(amps[j] ** 2),
            "exact": float(exact[j]), "trotter": float(trotter[j]), "sampled": float(sampled[j]),
        })
    drawing = walk_circuit(Lsub, amps, tk[-1], reps)[0].draw("text", fold=-1).single_string()
    return {
        "tau": S.tau, "qubits": k, "t_max": t_max, "times": tk, "reps": reps, "shots": shots,
        "nodes": nodes, "stats": st,
        "tvd_sampled_exact": tvd(sampled, exact), "tvd_trotter_exact": tvd(trotter, exact),
        "circuit_text": drawing,
    }
