"""QAOA for token-budgeted packing.

Which of the top-K ranked units get their full body into the context is a knapsack problem with a
history-aware pairwise bonus, written as a QUBO over x_i (body packed) and S slack bits y_b:

    E(x, y) = − Σ s_i x_i − μ Σ_{i<j} w_ij x_i x_j + P (Σ c̃_i x_i + Σ 2^b y_b − B̃)²

  s_i   normalised rank score of unit i (quantum walk or PPR)
  w_ij  normalised co-change weight: units that historically change together are packed together
  c̃_i  token cost in units of ρB / (2^S − 1), rounded up (so discretised-feasible ⇒ truly feasible)
  B̃    2^S − 1 units, i.e. the body budget ρB
  P     Σ s + μ Σ w, large enough that any violation costs more than any objective gain

The QUBO maps to an Ising Hamiltonian (x = (1 − Z)/2) and QAOA (Farhi et al. 2014) searches its ground
state. Greedy (rank order) and exact brute force run on the same candidates for comparison. Optionally,
the optimised circuit is re-run on a depolarising-noise model (Aer) to show NISQ degradation.
"""

from __future__ import annotations

import math

import numpy as np
from scipy.optimize import minimize

from . import qwalk, retrieve

SLACK_BITS = 4


# ---------------------------------------------------------------------------- QUBO / Ising


def build_qubo(s: np.ndarray, w: np.ndarray, cost_units: np.ndarray, cap_units: int, mu: float,
               slack_bits: int) -> tuple[np.ndarray, float, float]:
    """Upper-triangular Q (diagonal = linear terms) and constant, over [x_0..x_{K-1}, y_0..y_{S-1}]."""
    K = len(s)
    n = K + slack_bits
    a = np.concatenate([cost_units.astype(float), 2.0 ** np.arange(slack_bits)])
    iu = np.triu_indices(K, 1)
    P = float(s.sum() + mu * w[iu].sum()) + 1e-3
    Q = np.zeros((n, n))
    Q[np.diag_indices(n)] = P * (a ** 2 - 2 * cap_units * a)
    Q[np.diag_indices(K)] -= s
    for i in range(n):
        for j in range(i + 1, n):
            Q[i, j] = 2 * P * a[i] * a[j]
            if j < K:
                Q[i, j] -= mu * w[i, j]
    return Q, P * cap_units ** 2, P


def bit_matrix(n: int) -> np.ndarray:
    """Row z = bits of z, little-endian (column q = bit q), matching Qiskit's qubit order."""
    z = np.arange(2 ** n, dtype=np.int64)
    return ((z[:, None] >> np.arange(n)) & 1).astype(np.float64)


def energies(Q: np.ndarray, const: float = 0.0) -> np.ndarray:
    """E(z) for every bitstring z (n ≤ 20)."""
    B = bit_matrix(Q.shape[0])
    return ((B @ Q) * B).sum(axis=1) + const


def qubo_to_ising(Q: np.ndarray, const: float = 0.0):
    """SparsePauliOp H with diag(H) = E(x) under x_i = (1 − Z_i) / 2."""
    from qiskit.quantum_info import SparsePauliOp

    n = Q.shape[0]
    terms: list[tuple[str, list[int], float]] = []
    offset = const
    for i in range(n):
        offset += Q[i, i] / 2
        terms.append(("Z", [i], -Q[i, i] / 2))
        for j in range(i + 1, n):
            if Q[i, j] == 0:
                continue
            offset += Q[i, j] / 4
            terms.append(("Z", [i], -Q[i, j] / 4))
            terms.append(("Z", [j], -Q[i, j] / 4))
            terms.append(("ZZ", [i, j], Q[i, j] / 4))
    terms.append(("", [], offset))
    return SparsePauliOp.from_sparse_list(terms, num_qubits=n).simplify(atol=1e-12)


# ---------------------------------------------------------------------------- QAOA


def qaoa_state(E: np.ndarray, gammas: np.ndarray, betas: np.ndarray) -> np.ndarray:
    """|γ,β⟩ = Π_l e^{−iβ_l Σ X} e^{−iγ_l H_C} |+⟩^n, with H_C diagonal (fast numpy simulation)."""
    N = len(E)
    n = int(round(math.log2(N)))
    psi = np.full(N, 1 / math.sqrt(N), dtype=complex)
    for g, b in zip(gammas, betas):
        psi = psi * np.exp(-1j * g * E)
        c, s_ = math.cos(b), -1j * math.sin(b)
        for q in range(n):
            v = psi.reshape(-1, 2, 2 ** q)
            a0, a1 = v[:, 0, :].copy(), v[:, 1, :].copy()
            v[:, 0, :] = c * a0 + s_ * a1
            v[:, 1, :] = s_ * a0 + c * a1
            psi = v.reshape(N)
    return psi


def qaoa_circuit(H, gammas, betas):
    """The same state as a Qiskit circuit (QAOAAnsatz bound to the optimised angles)."""
    from qiskit.circuit.library import QAOAAnsatz

    reps = len(gammas)
    ans = QAOAAnsatz(H, reps=reps)
    binding = {}
    for prm in ans.parameters:
        idx = int(prm.name.split("[")[1].rstrip("]"))
        binding[prm] = float(betas[idx] if prm.name.startswith("β") else gammas[idx])
    return ans.assign_parameters(binding)


def optimise(E: np.ndarray, reps: int, seed: int = 7, maxiter: int = 150, restarts: int = 3):
    """COBYLA on ⟨H_C⟩ with energies scaled to [−1, 1]. Returns (gammas, betas, history, scale)."""
    scale = float(np.max(np.abs(E - E.mean()))) or 1.0
    Es = (E - E.mean()) / scale
    rng = np.random.default_rng(seed)
    best = None
    for r in range(restarts):
        if r == 0:  # linear-ramp start (a discretised annealing path)
            x0 = np.concatenate([np.linspace(0.1, 0.8, reps) * math.pi, np.linspace(0.8, 0.1, reps) * math.pi / 4])
        else:
            x0 = np.concatenate([rng.uniform(0, math.pi, reps), rng.uniform(0, math.pi / 2, reps)])
        hist: list[float] = []

        def f(x, hist=hist):
            psi = qaoa_state(Es, x[:reps], x[reps:])
            val = float(np.real(np.vdot(psi, Es * psi)))
            hist.append(val)
            return val

        out = minimize(f, x0, method="COBYLA", options={"maxiter": maxiter, "rhobeg": 0.4})
        if best is None or out.fun < best[0]:
            best = (out.fun, out.x, hist)
    _, x, hist = best
    return x[:reps], x[reps:], hist, scale, Es


# ---------------------------------------------------------------------------- solvers


def _value(xsel: np.ndarray, s: np.ndarray, w: np.ndarray, mu: float) -> float:
    """Objective to maximise: Σ s x + μ Σ_{i<j} w x x."""
    x = xsel.astype(float)
    return float(s @ x + mu * (x @ np.triu(w, 1) @ x))


def exact(s, w, costs, cap, mu) -> np.ndarray:
    K = len(s)
    B = bit_matrix(K)
    vals = B @ s + mu * ((B @ np.triu(w, 1)) * B).sum(axis=1)
    feas = B @ costs <= cap
    vals[~feas] = -np.inf
    return B[int(np.argmax(vals))].astype(int)


def greedy(costs, cap) -> np.ndarray:
    x = np.zeros(len(costs), dtype=int)
    used = 0
    for i, c in enumerate(costs):  # candidates are already in rank order
        if used + c <= cap:
            x[i] = 1
            used += c
    return x


BASIS = ["cx", "rz", "sx", "x", "h"]


def sample(tq, shots: int, noise_p: float = 0.0, seed: int = 7) -> dict[str, int]:
    """Run a transpiled circuit on Aer, optionally under depolarising noise on every 1q / 2q gate."""
    from qiskit_aer import AerSimulator
    from qiskit_aer.noise import NoiseModel, depolarizing_error

    if noise_p <= 0:
        return AerSimulator(seed_simulator=seed).run(tq, shots=shots).result().get_counts()
    nm = NoiseModel()
    nm.add_all_qubit_quantum_error(depolarizing_error(noise_p, 1), ["rz", "sx", "x", "h"])
    nm.add_all_qubit_quantum_error(depolarizing_error(min(1.0, 2 * noise_p), 2), ["cx"])
    return AerSimulator(noise_model=nm, seed_simulator=seed).run(tq, shots=shots).result().get_counts()


# ---------------------------------------------------------------------------- main


def pack(repo_id: str, issue: str, tau: int | None, budget: int, k: int = 10, reps: int = 2,
         ranking: str = "quantum", mu: float = 0.3, noise_p: float = 0.0, shots: int = 2048,
         params: dict | None = None) -> dict:
    from qiskit import transpile

    ws = qwalk.WalkState(repo_id, issue, tau, params)
    S, a = ws.S, ws.a
    scores = ws.q if ranking == "quantum" else ws.pi
    order = ws.order(scores)
    rho = a["rho"]
    cap = rho * budget
    unit = cap / (2 ** SLACK_BITS - 1)

    # candidates: top-K units whose body fits in the body budget on its own
    cand: list[int] = []
    tok: list[int] = []
    for i in order:
        if len(cand) >= min(max(k, 2), 14):
            break
        body = S.body.get(i)
        if body is None:
            continue
        c = retrieve.ntok(retrieve.header(S, i) + body)
        if c <= cap:
            cand.append(i)
            tok.append(c)
    K = len(cand)
    if K < 2:
        raise ValueError("Not enough candidate units fit the body budget; raise the budget")
    costs = np.array(tok, dtype=float)
    cu = np.ceil(costs / unit).astype(int)
    sc = np.array([scores[i] for i in cand])
    s = sc / sc.max() if sc.max() > 0 else np.ones(K)
    w = np.zeros((K, K))
    roots = [S.nodes[i]["root"] for i in cand]
    for x in range(K):
        for y in range(x + 1, K):
            ra, rb = sorted((roots[x], roots[y]))
            w[x, y] = w[y, x] = S.cochange.get((ra, rb), 0.0)
    if w.max() > 0:
        w /= w.max()

    Q, const, P = build_qubo(s, w, cu, 2 ** SLACK_BITS - 1, mu, SLACK_BITS)
    n = Q.shape[0]
    E = energies(Q, const)
    gam, bet, hist, scale, Es = optimise(E, reps)
    psi = qaoa_state(Es, gam, bet)
    probs = np.abs(psi) ** 2

    x_exact = exact(s, w, costs, cap, mu)
    x_greedy = greedy(costs, cap)
    v_exact = _value(x_exact, s, w, mu)

    # sample the real circuit (transpiled to a hardware basis first; Aer simulates it gate by gate)
    H = qubo_to_ising(Q / scale, (const - E.mean()) / scale)
    qc = qaoa_circuit(H, gam, bet)
    qc_m = qc.copy()
    qc_m.measure_all()
    tq = transpile(qc_m, basis_gates=BASIS, optimization_level=1, seed_transpiler=7)
    counts = sample(tq, shots)

    def decode(bits: str) -> np.ndarray:
        z = int(bits, 2)
        return np.array([(z >> q) & 1 for q in range(K)], dtype=int)

    def best_feasible(cnts: dict[str, int]) -> tuple[np.ndarray, float, float]:
        best_x, best_v, feas = np.zeros(K, dtype=int), 0.0, 0
        total = sum(cnts.values())
        for bits, c in cnts.items():
            x = decode(bits)
            if costs @ x <= cap:
                feas += c
                v = _value(x, s, w, mu)
                if v > best_v:
                    best_x, best_v = x, v
        return best_x, best_v, feas / max(1, total)

    x_qaoa, v_qaoa, feas_frac = best_feasible(counts)
    # baseline: the same number of uniformly random bitstrings (does QAOA beat blind sampling?)
    rng = np.random.default_rng(7)
    rand = rng.integers(0, 2 ** n, size=shots)
    rc: dict[str, int] = {}
    for z in rand:
        b = format(int(z), f"0{n}b")
        rc[b] = rc.get(b, 0) + 1
    x_rand, _, rand_feas = best_feasible(rc)
    opt_mask = (bit_matrix(n)[:, :K] == x_exact).all(axis=1)
    p_opt = float(probs[opt_mask].sum())
    # the most likely bitstring (what a single-shot answer would be)
    top_x = decode(format(int(np.argmax(probs)), f"0{n}b"))

    noisy = None
    if noise_p > 0:
        nc = sample(tq, min(shots, 1024), noise_p)
        nx, nv, nf = best_feasible(nc)
        tot = sum(nc.values())
        p_opt_noisy = sum(c for b, c in nc.items() if (decode(b) == x_exact).all()) / max(1, tot)
        noisy = {"noise_p": noise_p, "value": nv, "ratio": nv / v_exact if v_exact > 0 else None,
                 "feasible_fraction": nf, "p_opt": p_opt_noisy, "selection": nx.tolist(), "shots": tot}

    ops = {k_: v for k_, v in tq.count_ops().items() if k_ not in ("measure", "barrier")}

    def sol(x: np.ndarray) -> dict:
        return {"selection": x.tolist(), "value": _value(x, s, w, mu), "tokens": int(costs @ x),
                "feasible": bool(costs @ x <= cap), "ratio": _value(x, s, w, mu) / v_exact if v_exact > 0 else None}

    bodies = {cand[j] for j in range(K) if x_qaoa[j]}
    pk = retrieve._pack(S, order, budget, rho, bodies=bodies)
    candidates = [{"key": S.nodes[i]["key"], "name": S.nodes[i]["name"], "path": S.nodes[i]["path"],
                   "kind": S.nodes[i]["kind"], "score": float(s[j]), "tokens": int(costs[j]), "units": int(cu[j]),
                   "cochange": [{"with": S.nodes[cand[y]]["key"], "w": round(float(w[j, y]), 3)}
                                for y in range(K) if w[j, y] > 0]} for j, i in enumerate(cand)]
    return {
        "tau": S.tau, "budget": budget, "body_budget": cap, "rho": rho, "ranking": ranking, "mu": mu,
        "qubits": n, "candidates_k": K, "slack_bits": SLACK_BITS, "reps": reps, "penalty": P, "unit_tokens": unit,
        "candidates": candidates,
        "solutions": {"greedy": sol(x_greedy), "random": {**sol(x_rand), "feasible_fraction": rand_feas},
                      "exact": sol(x_exact), "qaoa": {**sol(x_qaoa), "feasible_fraction": feas_frac,
                                                                              "p_opt": p_opt, "most_likely": top_x.tolist()}},
        "noisy": noisy,
        "convergence": [round(v, 6) for v in hist],
        "angles": {"gamma": [float(g) for g in gam], "beta": [float(b) for b in bet]},
        "circuit": {"qubits": n, "depth": tq.depth(lambda ins: ins.operation.name not in ("measure", "barrier")), "cx": int(ops.get("cx", 0)), "gates": int(sum(ops.values())),
                    "pauli_terms": len(H)},
        "packed": pk["packed"], "tokens": pk["tokens"],
    }
