"""Noise and quantum error correction for the quantum walk.

Follows NPTEL (IIT Madras) "Fixing quantum errors with quantum tricks: a brief introduction to QEC",
Parts 1–3: NISQ noise and decoherence, the 3-qubit bit-flip and phase-flip codes with syndrome
measurement, and Shor's 9-qubit code.

The quantum walk of `qwalk.circuit` runs for t/2 on k logical qubits (a 2^k-node subgraph), the state
then sits in a noisy quantum memory, and the walk runs for the remaining t/2. A phase error at the very
end would not change the measured node probabilities, but in the middle of the walk it changes the
interference and therefore the ranking. Three versions are compared:

  ideal   no noise
  noisy   a Pauli channel with probability p on every qubit in the window, no protection
  qec     every logical qubit encoded before the window; syndrome extraction, correction and decoding after

  code          physical / logical     corrects              correction
  bitflip       3 data + 2 ancilla     one X per block       ZZ parities measured into ancillas, feed-forward X
  phaseflip     3 data + 2 ancilla     one Z per block       the same inside a Hadamard frame
  shor          9 data                 any one Pauli         coherent (CNOT + Toffoli majority), syndrome read out

As in an introductory course, encoding and decoding gates are noiseless: this shows what the codes
correct, not fault tolerance.
"""

from __future__ import annotations

from functools import lru_cache
import time

import numpy as np
import scipy.linalg as la
from scipy.stats import kendalltau

from . import qwalk

CODES = ("bitflip", "phaseflip", "shor")
CHANNELS = ("bit", "phase", "depol")
PER_BLOCK = {"none": 1, "bitflip": 3, "phaseflip": 3, "shor": 9}
ANCILLA = {"bitflip": 2, "phaseflip": 2}
SYN_BITS = {"bitflip": 2, "phaseflip": 2, "shor": 8}
MAX_LOGICAL = {"bitflip": 3, "phaseflip": 3, "shor": 2, "none": 5}


def channel_error(channel: str, p: float):
    """Pauli channel on one qubit: bit (X), phase (Z) or depolarising (X, Y, Z each p/3)."""
    from qiskit_aer.noise import pauli_error

    if p <= 0:
        return None
    p = min(p, 1.0)
    if channel == "bit":
        return pauli_error([("X", p), ("I", 1 - p)])
    if channel == "phase":
        return pauli_error([("Z", p), ("I", 1 - p)])
    if channel == "depol":
        return pauli_error([("X", p / 3), ("Y", p / 3), ("Z", p / 3), ("I", 1 - p)])
    raise ValueError(f"unknown channel {channel}")


# ---------------------------------------------------------------------------- layout and code circuits


class Layout:
    def __init__(self, code: str, k: int):
        per = PER_BLOCK[code]
        na = ANCILLA.get(code, 0)
        self.code, self.k = code, k
        self.blocks = [list(range(j * per, (j + 1) * per)) for j in range(k)]
        self.anc = [[k * per + na * j + a for a in range(na)] for j in range(k)] if na else [[] for _ in range(k)]
        self.data = [q for b in self.blocks for q in b]
        self.n = k * per + na * k
        self.logical = [b[0] for b in self.blocks]


def encode(qc, b: list[int], code: str) -> None:
    if code in ("bitflip", "phaseflip"):
        qc.cx(b[0], b[1])
        qc.cx(b[0], b[2])
        if code == "phaseflip":
            qc.h(b[:3])
    elif code == "shor":
        qc.cx(b[0], b[3])
        qc.cx(b[0], b[6])
        qc.h([b[0], b[3], b[6]])
        for c in (0, 3, 6):
            qc.cx(b[c], b[c + 1])
            qc.cx(b[c], b[c + 2])


def correct_with_syndrome(qc, b: list[int], anc: list[int], syn, code: str) -> None:
    """Measure the syndrome into `syn`, fix the flagged qubit by feed-forward, then decode."""
    if code in ("bitflip", "phaseflip"):
        if code == "phaseflip":
            qc.h(b[:3])
        qc.cx(b[0], anc[0])
        qc.cx(b[1], anc[0])
        qc.cx(b[1], anc[1])
        qc.cx(b[2], anc[1])
        qc.measure(anc[0], syn[0])
        qc.measure(anc[1], syn[1])
        for value, target in ((1, b[0]), (3, b[1]), (2, b[2])):
            with qc.if_test((syn, value)):
                qc.x(target)
        qc.cx(b[0], b[2])
        qc.cx(b[0], b[1])
    elif code == "shor":
        correct_coherent(qc, b, code)
        for j, q in enumerate([b[1], b[2], b[4], b[5], b[7], b[8], b[3], b[6]]):
            qc.measure(q, syn[j])


def correct_coherent(qc, b: list[int], code: str) -> None:
    """Ancilla-free correction (Nielsen & Chuang §10.1): undo the encoding, Toffoli majority vote."""
    if code in ("bitflip", "phaseflip"):
        if code == "phaseflip":
            qc.h(b[:3])
        qc.cx(b[0], b[1])
        qc.cx(b[0], b[2])
        qc.ccx(b[2], b[1], b[0])
    elif code == "shor":
        for c in (0, 3, 6):
            qc.cx(b[c], b[c + 1])
            qc.cx(b[c], b[c + 2])
            qc.ccx(b[c + 2], b[c + 1], b[c])
        qc.h([b[0], b[3], b[6]])
        qc.cx(b[0], b[3])
        qc.cx(b[0], b[6])
        qc.ccx(b[6], b[3], b[0])


def syndrome_label(code: str, bits: str) -> str:
    """Bits as Qiskit prints a register (rightmost = bit 0) → what the decoder concluded."""
    v = [int(c) for c in reversed(bits)]
    if code in ("bitflip", "phaseflip"):
        e = "X" if code == "bitflip" else "Z"
        return {(0, 0): "none", (1, 0): f"{e} on q0", (1, 1): f"{e} on q1", (0, 1): f"{e} on q2"}[(v[0], v[1])]
    out = []
    for c in range(3):  # bit-flip syndrome of block c, read from its two auxiliary qubits
        pair = (v[2 * c], v[2 * c + 1])
        q = {(1, 1): 3 * c, (1, 0): 3 * c + 1, (0, 1): 3 * c + 2}.get(pair)
        if q is not None:
            out.append(f"X on q{q}")
    blk = {(1, 1): 0, (1, 0): 1, (0, 1): 2}.get((v[6], v[7]))
    if blk is not None:
        out.append(f"Z on block {blk}")
    return " + ".join(out) or "none"


# ---------------------------------------------------------------------------- the walk through noisy memory


def memory_circuit(code: str, k: int, amps: np.ndarray, U1: np.ndarray | None, U2: np.ndarray | None,
                   channel: str, p: float, inject: list[tuple[str, int]] | None = None):
    """prep → U1 → [encode] → noise window → [syndrome, correct, decode] → U2 → save ρ of the logical qubits."""
    from qiskit import ClassicalRegister, QuantumCircuit, QuantumRegister
    from qiskit.circuit.library import StatePreparation, UnitaryGate

    lay = Layout(code, k)
    qr = QuantumRegister(lay.n, "q")
    syns = [ClassicalRegister(SYN_BITS[code], f"syn{j}") for j in range(k)] if code != "none" else []
    qc = QuantumCircuit(qr, *syns)
    qc.append(StatePreparation(amps.astype(complex), label="prep √p"), lay.logical)
    if U1 is not None:
        qc.append(UnitaryGate(U1, label="walk t/2"), lay.logical)
    if code != "none":
        for b in lay.blocks:
            encode(qc, b, code)
    qc.barrier(label="memory")
    err = channel_error(channel, p)
    if err is not None:
        for q in lay.data:
            qc.append(err, [q])
    for pauli, q in inject or []:  # deterministic errors, for tests: q indexes lay.data
        getattr(qc, pauli.lower())(lay.data[q])
    qc.barrier()
    if code != "none":
        for j, b in enumerate(lay.blocks):
            correct_with_syndrome(qc, b, lay.anc[j], syns[j], code)
    if U2 is not None:
        qc.append(UnitaryGate(U2, label="walk t/2"), lay.logical)
    qc.save_density_matrix(lay.logical, label="rho")
    return qc, lay


def run_memory(qc, shots: int, seed: int = 7, exact: bool = False) -> tuple[np.ndarray, dict[str, int]]:
    """Aer run. exact=True uses the density-matrix method (channels applied exactly, no trajectories);
    otherwise each shot samples one Pauli error pattern and ρ is the average over shots."""
    from qiskit import transpile
    from qiskit_aer import AerSimulator

    sim = AerSimulator(method="density_matrix" if exact else "statevector", seed_simulator=seed)
    res = sim.run(transpile(qc, sim, optimization_level=0), shots=shots).result()
    data = res.data(0)
    rho = np.asarray(data["rho"])
    counts = res.get_counts() if qc.num_clbits else {}
    return rho, counts


def syndromes(code: str, k: int, counts: dict[str, int]) -> list[dict]:
    """Histogram of decoder conclusions, pooled over the k logical qubits."""
    tally: dict[str, int] = {}
    total = 0
    for key, c in counts.items():
        parts = key.split(" ")[::-1]  # Qiskit prints the last register first
        for j in range(min(k, len(parts))):
            lab = syndrome_label(code, parts[j])
            tally[lab] = tally.get(lab, 0) + c
            total += c
    return [{"label": lab, "count": c, "frac": c / max(1, total)}
            for lab, c in sorted(tally.items(), key=lambda kv: (kv[0] != "none", -kv[1]))]


def _fid(rho: np.ndarray, psi: np.ndarray) -> float:
    return float(np.real(np.vdot(psi, rho @ psi)))


def walk_qec(repo_id: str, issue: str, tau: int | None, qubits: int = 2, t: float | None = None,
             code: str = "bitflip", channel: str = "bit", p: float = 0.05, shots: int = 1024,
             params: dict | None = None) -> dict:
    if code not in CODES:
        raise ValueError(f"code must be one of {CODES}")
    if channel not in CHANNELS:
        raise ValueError(f"channel must be one of {CHANNELS}")
    t0 = time.time()
    k = int(min(max(qubits, 1), MAX_LOGICAL[code]))
    ws = qwalk.WalkState(repo_id, issue, tau, params)
    S = ws.S
    t_max = float(t if t is not None else ws.qa["qw_time"])
    sel = qwalk.select_subgraph(ws, k)
    Lsub, amps = qwalk.sub_problem(ws, sel, k)
    U = la.expm(-1j * Lsub * t_max / 2)
    psi = U @ (U @ amps.astype(complex))
    ideal = np.abs(psi) ** 2

    qn, _ = memory_circuit("none", k, amps, U, U, channel, p)
    rho_n, _ = run_memory(qn, 1, exact=True)
    qq, lay = memory_circuit(code, k, amps, U, U, channel, p)
    if lay.n > 15:  # 18-qubit Shor runs simulate every trajectory: keep the request interactive
        shots = min(shots, 256)
    rho_q, counts = run_memory(qq, shots)
    noisy = np.clip(np.real(np.diag(rho_n)), 0, None)
    qec = np.clip(np.real(np.diag(rho_q)), 0, None)

    def kendall(x: np.ndarray) -> float | None:
        if len(x) < 3:
            return None
        v = kendalltau(ideal, x).statistic
        return None if np.isnan(v) else float(v)

    N = 2 ** k
    nodes = []
    for j in range(N):
        i = sel[j] if j < len(sel) else None
        nd = S.nodes[i] if i is not None else None
        nodes.append({"index": j, "bits": format(j, f"0{k}b"), "key": nd["key"] if nd else None,
                      "name": nd["name"] if nd else "(padding)", "kind": nd["kind"] if nd else None,
                      "seed": bool(i is not None and i in ws.seeds),
                      "ideal": float(ideal[j]), "noisy": float(noisy[j]), "qec": float(qec[j])})
    top = int(np.argmax(ideal))
    return {
        "tau": S.tau, "code": code, "channel": channel, "p": p, "shots": shots, "logical_qubits": k,
        "physical_qubits": lay.n, "data_qubits": len(lay.data), "t_max": t_max, "nodes": nodes,
        "metrics": {
            "tvd_noisy": qwalk.tvd(noisy, ideal), "tvd_qec": qwalk.tvd(qec, ideal),
            "fidelity_noisy": _fid(rho_n, psi), "fidelity_qec": _fid(rho_q, psi),
            "kendall_noisy": kendall(noisy), "kendall_qec": kendall(qec),
            "top1_noisy": int(np.argmax(noisy)) == top, "top1_qec": int(np.argmax(qec)) == top,
        },
        "syndromes": syndromes(code, k, counts),
        "circuit_text": diagram(code),
        "seconds": round(time.time() - t0, 2),
    }


# ---------------------------------------------------------------------------- lecture-style views


def diagram(code: str) -> str:
    """One logical qubit: encode → noise window → syndrome → correct → decode."""
    from qiskit import ClassicalRegister, QuantumCircuit, QuantumRegister

    lay = Layout(code, 1)
    qc = QuantumCircuit(QuantumRegister(lay.n, "q"), ClassicalRegister(SYN_BITS[code], "syn"))
    encode(qc, lay.blocks[0], code)
    qc.barrier(label="noise")
    correct_with_syndrome(qc, lay.blocks[0], lay.anc[0], qc.cregs[0], code)
    return qc.draw("text", fold=-1).single_string()


def theory(code: str, channel: str, p: float) -> float | None:
    """Logical error probability under ideal encode/decode, where a closed form is simple."""
    if code == "none":
        return p
    match = (code, channel) in (("bitflip", "bit"), ("phaseflip", "phase"))
    wrong = (code, channel) in (("bitflip", "phase"), ("phaseflip", "bit"))
    if match:
        return 3 * p ** 2 - 2 * p ** 3  # two or more of three qubits flipped
    if wrong:
        return 3 * p * (1 - p) ** 2 + p ** 3  # an odd number of errors the code cannot see
    return None


def _logical_error(code: str, channel: str, p: float) -> float:
    """1 − entanglement fidelity: the logical qubit is half of a Bell pair with a noiseless reference."""
    from qiskit import QuantumCircuit, transpile
    from qiskit_aer import AerSimulator

    lay = Layout(code, 1) if code != "none" else None
    data = lay.blocks[0] if lay else [0]
    ref = len(data)
    qc = QuantumCircuit(ref + 1)
    qc.h(data[0])
    qc.cx(data[0], ref)
    if code != "none":
        encode(qc, data, code)
    err = channel_error(channel, p)
    if err is not None:
        for q in data:
            qc.append(err, [q])
    if code != "none":
        correct_coherent(qc, data, code)
    qc.save_density_matrix([data[0], ref], label="rho")
    sim = AerSimulator(method="density_matrix")
    rho = np.asarray(sim.run(transpile(qc, sim, optimization_level=0)).result().data(0)["rho"])
    bell = np.array([1, 0, 0, 1], dtype=complex) / np.sqrt(2)
    return float(max(0.0, 1.0 - np.real(np.vdot(bell, rho @ bell))))


@lru_cache(maxsize=32)
def sweep(code: str, channel: str, points: int = 21) -> dict:
    """Logical vs physical error rate, exact (density-matrix simulation), with the closed-form curves."""
    if code not in CODES or channel not in CHANNELS:
        raise ValueError("unknown code or channel")
    ps = np.linspace(0.0, 0.5, points)
    rows = []
    for p in ps:
        p = float(p)
        rows.append({"p": round(p, 4), "unprotected": _logical_error("none", channel, p),
                     "protected": _logical_error(code, channel, p), "theory": theory(code, channel, p)})
    # break-even: the first p > 0 where the code stops helping
    breakeven = next((r["p"] for r in rows[1:] if r["protected"] >= r["unprotected"] - 1e-9), None)
    return {"code": code, "channel": channel, "rows": rows, "breakeven": breakeven,
            "physical_qubits": PER_BLOCK[code] + ANCILLA.get(code, 0)}
