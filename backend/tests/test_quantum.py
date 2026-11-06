"""Quantum TCG: quantum-walk ranking, QAOA packing, QEC, and quantum-code awareness.

A toy quantum repository (Qiskit circuits + an OpenQASM gate library) is committed twice; the second
commit adds a CX-heavy gate and a GHZ circuit. It is built and stored like any other repository so the
quantum modules are exercised end to end through retrieve.prepare.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
import pytest
import scipy.linalg as la
import scipy.sparse as sp

from tcg import analysis, pipeline, qcode, qec, qpack, qwalk, retrieve, store
from tcg.builder import Builder
from tcg.parse import parse_file

Q1 = {
    "circuits.py": (
        "from qiskit import QuantumCircuit\n\n"
        "def bell():\n    qc = QuantumCircuit(2, 2)\n    qc.h(0)\n    qc.cx(0, 1)\n    qc.measure([0, 1], [0, 1])\n    return qc\n\n"
        "def run(shots):\n    qc = bell()\n    return simulate(qc, shots)\n\n"
        "def simulate(qc, shots):\n    return {'00': shots}\n"
    ),
    "adder.qasm": (
        'OPENQASM 2.0;\ninclude "qelib1.inc";\n'
        "gate majority a, b, c {\n  cx c, b;\n  cx c, a;\n  ccx a, b, c;\n}\n"
        "qreg q[3];\ncreg c[3];\nmajority q[0], q[1], q[2];\nmeasure q -> c;\n"
    ),
}
Q2 = {
    **Q1,
    "circuits.py": Q1["circuits.py"] + (
        "\ndef ghz(n):\n    qc = QuantumCircuit(3)\n    qc.h(0)\n    qc.cx(0, 1)\n    qc.cx(1, 2)\n    qc.measure_all()\n"
        "    return qc\n"
    ),
    "adder.qasm": (
        'OPENQASM 2.0;\ninclude "qelib1.inc";\n'
        "gate majority a, b, c {\n  cx c, b;\n  cx c, a;\n  ccx a, b, c;\n}\n"
        "gate unmaj a, b, c {\n  ccx a, b, c;\n  cx c, a;\n  cx a, b;\n}\n"
        "qreg q[3];\ncreg c[3];\nmajority q[0], q[1], q[2];\nunmaj q[0], q[1], q[2];\nmeasure q -> c;\n"
    ),
}
ISSUE = "The CNOT in ghz() entangles the wrong qubits, so measuring the circuit gives a broken GHZ state."


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


@pytest.fixture(scope="module")
def qrepo(tmp_path_factory) -> Path:
    repo = tmp_path_factory.mktemp("qtoy")
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@example.com")
    _git(repo, "config", "user.name", "Test")
    for i, snap in enumerate([Q1, Q2], 1):
        for name, body in snap.items():
            (repo / name).write_text(body)
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", f"q{i}")
    return repo


@pytest.fixture(scope="module")
def qbuilt(qrepo):
    return Builder(qrepo).build(50)


@pytest.fixture(scope="module")
def stored(qrepo, qbuilt, tmp_path_factory):
    """Write the toy graph into a temporary store so retrieve.prepare can load it."""
    home = tmp_path_factory.mktemp("home")
    old = store.DB_DIR, store.REPO_DIR
    store.DB_DIR, store.REPO_DIR = home / "db", home / "repos"
    stats = analysis.analyze(qbuilt)
    contrib = stats.pop("_cochange_contrib")
    src = {"id": "local__qtoy", "name": "qtoy", "kind": "local", "path": str(qrepo)}
    pipeline._write(src, qrepo, 50, {}, qbuilt, stats, contrib)
    retrieve.invalidate("local__qtoy")
    yield "local__qtoy"
    retrieve.invalidate("local__qtoy")
    store.DB_DIR, store.REPO_DIR = old


# ---------------------------------------------------------------------------- quantum walk


def test_ctqw_is_unitary_and_static_without_edges():
    rng = np.random.default_rng(0)
    A = sp.random(30, 30, density=0.15, random_state=1)
    L = qwalk.laplacian(A)
    p = rng.random(30)
    p /= p.sum()
    q, traj, _ = qwalk.ctqw(L, np.sqrt(p), 3.0, 12)
    assert np.allclose(traj.sum(axis=1), 1.0, atol=1e-9)  # probability is conserved at every t
    assert q.sum() == pytest.approx(1.0)
    q0, _, _ = qwalk.ctqw(qwalk.laplacian(sp.csr_matrix((30, 30))), np.sqrt(p), 3.0, 12)
    assert np.allclose(q0, p)  # no edges: the walker never moves


def test_trotter_circuit_matches_exact_evolution():
    from qiskit.quantum_info import Statevector

    A = np.array([[0, 1, 0.5, 0], [1, 0, 1, 0], [0.5, 1, 0, 1], [0, 0, 1, 0]], dtype=float)
    Lsub = qwalk.laplacian(sp.csr_matrix(A)).toarray()
    amps = np.sqrt(np.array([0.7, 0.1, 0.1, 0.1]))
    from qiskit import transpile

    exact = np.abs(la.expm(-1j * Lsub * 1.3) @ amps) ** 2
    errs = []
    for reps in (1, 4):
        qc, _ = qwalk.walk_circuit(Lsub, amps, 1.3, reps=reps, measure=False)
        tq = transpile(qc, basis_gates=qwalk.BASIS, optimization_level=1)  # real gates, real Trotter error
        errs.append(qwalk.tvd(Statevector(tq).probabilities(), exact))
    assert errs[1] < 0.02 and errs[1] < errs[0]


def test_walk_on_stored_graph(stored):
    r = qwalk.walk(stored, ISSUE, None)
    names = [x["name"] for x in r["ranking"][:4]]
    assert "ghz" in names  # named in the issue and applies the CNOTs it mentions
    ghz = next(x for x in r["ranking"] if x["name"] == "ghz")
    assert "quantum" in ghz["seed"]
    assert all(0.0 <= row["seed_mass"] <= 1.0 + 1e-9 for row in r["trajectory"])
    # τ = 0 predates ghz(): the walk at τ must not see it
    r0 = qwalk.walk(stored, ISSUE, 0)
    assert all(x["name"] != "ghz" for x in r0["ranking"])


def test_circuit_endpoint_logic(stored):
    r = qwalk.circuit(stored, ISSUE, None, qubits=2, reps=4, shots=4096)
    assert len(r["nodes"]) == 4 and r["stats"]["qubits"] == 2
    assert r["tvd_trotter_exact"] < 0.02 and r["tvd_sampled_exact"] < 0.05


# ---------------------------------------------------------------------------- QAOA packing


def test_ising_diagonal_and_qaoa_state_match_qiskit():
    from qiskit.quantum_info import Statevector

    rng = np.random.default_rng(3)
    Q = np.triu(rng.normal(size=(5, 5)))
    E = qpack.energies(Q, 0.7)
    H = qpack.qubo_to_ising(Q, 0.7)
    assert np.allclose(np.real(np.diag(H.to_matrix())), E)
    g, b = np.array([0.3, 1.1]), np.array([0.5, 0.2])
    p_np = np.abs(qpack.qaoa_state(E, g, b)) ** 2
    assert np.allclose(Statevector(qpack.qaoa_circuit(H, g, b)).probabilities(), p_np, atol=1e-8)


def test_qubo_penalty_makes_ground_state_feasible():
    rng = np.random.default_rng(5)
    K, S_ = 6, 3
    s = rng.random(K)
    w = np.triu(rng.random((K, K)), 1)
    w = w + w.T
    cu = rng.integers(1, 5, K)
    cap = 2 ** S_ - 1
    Q, const, _ = qpack.build_qubo(s, w, cu, cap, 0.3, S_)
    E = qpack.energies(Q, const)
    z = int(np.argmin(E))
    x = np.array([(z >> q) & 1 for q in range(K)])
    assert cu @ x <= cap
    best = qpack.exact(s, w, cu.astype(float), float(cap), 0.3)
    assert qpack._value(x, s, w, 0.3) == pytest.approx(qpack._value(best, s, w, 0.3))


def test_pack_on_stored_graph(stored):
    r = qpack.pack(stored, ISSUE, None, budget=600, k=4, reps=2, shots=1024)
    sols = r["solutions"]
    assert sols["exact"]["feasible"] and sols["qaoa"]["feasible"] and sols["greedy"]["feasible"]
    assert sols["exact"]["value"] >= sols["greedy"]["value"] - 1e-9
    assert sols["exact"]["value"] >= sols["qaoa"]["value"] - 1e-9
    assert r["tokens"]["used"] <= 600
    assert r["qubits"] == r["candidates_k"] + qpack.SLACK_BITS


# ---------------------------------------------------------------------------- QEC


@pytest.mark.parametrize("code,paulis", [("bitflip", "X"), ("phaseflip", "Z"), ("shor", "XYZ")])
def test_every_single_qubit_error_is_corrected(code, paulis):
    amps = np.array([0.6, 0.8j])
    for P in paulis:
        for q in range(qec.PER_BLOCK[code]):
            qc, _ = qec.memory_circuit(code, 1, amps, None, None, "bit", 0.0, inject=[(P, q)])
            rho, counts = qec.run_memory(qc, 8)
            assert np.real(np.vdot(amps, rho @ amps)) == pytest.approx(1.0, abs=1e-9)
            labels = {s["label"] for s in qec.syndromes(code, 1, counts)}
            if code == "shor":
                expect = set()
                if P in "XY":
                    expect.add(f"X on q{q}")
                if P in "ZY":
                    expect.add(f"Z on block {q // 3}")
                assert labels == {" + ".join(sorted(expect, key=lambda e: e[0]))}
            else:
                assert labels == {f"{P} on q{q}"}


@pytest.mark.parametrize("code,channel", [("bitflip", "bit"), ("phaseflip", "phase"), ("bitflip", "phase")])
def test_sweep_matches_closed_form(code, channel):
    s = qec.sweep(code, channel, 11)
    for r in s["rows"]:
        assert r["protected"] == pytest.approx(r["theory"], abs=1e-6)
        assert r["unprotected"] == pytest.approx(r["p"], abs=1e-6)


def test_walk_qec_noiseless_and_noisy(stored):
    r0 = qec.walk_qec(stored, ISSUE, None, qubits=2, code="bitflip", channel="bit", p=0.0, shots=64)
    for n in r0["nodes"]:
        assert n["noisy"] == pytest.approx(n["ideal"], abs=1e-9)
        assert n["qec"] == pytest.approx(n["ideal"], abs=1e-9)
    assert r0["syndromes"] == [{"label": "none", "count": 128, "frac": 1.0}]
    r = qec.walk_qec(stored, ISSUE, None, qubits=2, code="phaseflip", channel="phase", p=0.1, shots=2048)
    m = r["metrics"]
    assert m["fidelity_qec"] > m["fidelity_noisy"]
    assert r["physical_qubits"] == 10


# ---------------------------------------------------------------------------- quantum-code awareness


def test_quantum_extraction_from_snippets():
    f = parse_file("circuits.py", Q2["circuits.py"].encode())
    assert f.qmeta["bell"]["gates"] == {"h": 1, "cx": 1, "measure": 1}
    assert f.qmeta["ghz"]["two_qubit"] == 2 and f.qmeta["ghz"]["qubits"] == 3
    assert "run" not in f.qmeta and "simulate" not in f.qmeta
    cirq = parse_file("c.py", b"import cirq\n\ndef c():\n    q = cirq.LineQubit.range(3)\n"
                                b"    return cirq.Circuit([cirq.H(q[0]), cirq.CNOT(q[0], q[1]), cirq.measure(*q)])\n")
    assert cirq.qmeta["c"]["gates"] == {"h": 1, "cx": 1, "measure": 1} and cirq.qmeta["c"]["qubits"] == 3
    pl = parse_file("p.py", b"import pennylane as qml\ndev = qml.device('default.qubit', wires=2)\n\n"
                            b"@qml.qnode(dev)\ndef f(t):\n    qml.Hadamard(wires=0)\n    qml.CNOT(wires=[0, 1])\n"
                            b"    return qml.probs(wires=[0, 1])\n")
    assert pl.qmeta["f"]["circuit"] and pl.qmeta["f"]["gates"]["cx"] == 1
    qa = parse_file("adder.qasm", Q2["adder.qasm"].encode())
    assert set(qa.defs) == {"majority", "unmaj"}
    assert [i.module for i in qa.imports] == ["qelib1.inc"]
    assert ("majority", "ccx") in {(r.src, r.name) for r in qa.refs}
    assert (None, "unmaj") in {(r.src, r.name) for r in qa.refs}
    assert qa.qmeta[""]["qubits"] == 3 and qa.qmeta["majority"]["gates"] == {"cx": 2, "ccx": 1}


def test_quantum_history_over_commits(qbuilt):
    g = qbuilt.q_growth
    assert len(g) == 2 and g[1]["gates"] > g[0]["gates"] and g[1]["circuits"] > g[0]["circuits"]
    unmaj = [n for n in qbuilt.nodes if n["key"] == "adder.qasm::unmaj"]
    assert unmaj and unmaj[0]["s"] == 1 and unmaj[0]["f"] is None and unmaj[0]["qmeta"]["n_gates"] == 3
    # the top-level circuit calls the QASM gate it defines: a resolved call edge, opened at q2
    e = [e for e in qbuilt.edges if e[0] == "adder.qasm" and e[1] == "adder.qasm::unmaj" and e[2] == "calls"]
    assert e and e[0][4] == 1
    st = qcode.quantum_stats(qbuilt.nodes, qbuilt.q_growth, 2)
    assert st["kpis"]["gate_defs"] == 2 and st["frameworks"] == {"Qiskit": 2, "OpenQASM": 3}


def test_retrieve_still_works_on_quantum_repo(stored):
    r = retrieve.retrieve(stored, ISSUE, None, 2000)
    assert {"ranking", "static_ranking", "packed", "tokens", "summary"} <= set(r)
    assert r["ranking"][0]["name"] == "ghz"
