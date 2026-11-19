"""Quantum-software awareness: gates, qubits and circuits in Qiskit / Cirq / PennyLane code and OpenQASM.

Two entry points feed the ordinary FileFacts that the temporal graph is built from:

* `parse_qasm` is a small line-oriented parser for OpenQASM 2 and 3 (Tree-sitter has no QASM grammar).
  `gate` / `def` / `opaque` declarations become definitions, `include` becomes an import and every gate
  application becomes a reference, so gate-to-gate call edges and their [s, f) intervals come for free.
* `python_qmeta` annotates the definitions of a Python file that imports a quantum framework with the
  gates they apply, two-qubit / measurement counts and a width estimate.

Both fill `facts.qmeta[qual]` ("" = module level) with
    {framework, gates: {canonical name: count}, n_gates, two_qubit, measure, qubits, circuit}
`quantum_stats` turns the per-node annotations and the builder's per-commit aggregates into the
Quantum code panel.
"""

from __future__ import annotations

from collections import Counter
import re

from .parse import Def, FileFacts, Import, Ref

# ---------------------------------------------------------------------------- vocabularies

CANON = {
    # qiskit / qasm (lowercase already)
    "cnot": "cx", "toffoli": "ccx", "fredkin": "cswap", "measure_all": "measure", "measure_active": "measure",
    "u1": "p", "phase": "p", "mcx": "mcx", "i": "id",
    # cirq
    "H": "h", "X": "x", "Y": "y", "Z": "z", "S": "s", "T": "t", "CNOT": "cx", "CX": "cx", "CZ": "cz",
    "SWAP": "swap", "ISWAP": "iswap", "TOFFOLI": "ccx", "CCX": "ccx", "CCZ": "ccz", "FREDKIN": "cswap",
    "CSWAP": "cswap", "Rx": "rx", "Ry": "ry", "Rz": "rz", "rx": "rx", "ry": "ry", "rz": "rz", "measure": "measure",
    # pennylane
    "Hadamard": "h", "PauliX": "x", "PauliY": "y", "PauliZ": "z", "SX": "sx", "RX": "rx", "RY": "ry", "RZ": "rz",
    "Rot": "u", "PhaseShift": "p", "Toffoli": "ccx", "CY": "cy", "CRX": "crx", "CRY": "cry", "CRZ": "crz",
    "CRot": "cu", "ControlledPhaseShift": "cp", "IsingXX": "rxx", "IsingYY": "ryy", "IsingZZ": "rzz",
    "MultiRZ": "mrz", "QubitUnitary": "unitary", "expval": "measure", "probs": "measure", "sample": "measure",
    "counts": "measure", "var": "measure",
}
QISKIT_GATES = set("""h x y z s sdg t tdg sx sxdg rx ry rz p u u1 u2 u3 r id i cx cy cz ch cp crx cry crz cu cu1 cu3 csx
swap iswap dcx ecr rxx ryy rzz rzx ccx ccz cswap mcx mcp measure measure_all measure_active reset unitary
initialize prepare_state""".split())
CIRQ_GATES = set("""H X Y Z S T CNOT CX CZ SWAP ISWAP TOFFOLI CCX CCZ FREDKIN CSWAP Rx Ry Rz rx ry rz measure""".split())
PENNYLANE_GATES = set("""Hadamard PauliX PauliY PauliZ S T SX RX RY RZ Rot PhaseShift CNOT CZ CY SWAP ISWAP Toffoli CSWAP
CRX CRY CRZ CRot ControlledPhaseShift IsingXX IsingYY IsingZZ MultiRZ QubitUnitary measure expval probs sample
counts var""".split())
MULTI = {"cx", "cy", "cz", "ch", "cp", "crx", "cry", "crz", "cu", "cu1", "cu3", "csx", "swap", "iswap", "dcx", "ecr",
         "rxx", "ryy", "rzz", "rzx", "ccx", "ccz", "cswap", "mcx", "mcp", "mrz"}
NOT_GATE = {"reset", "initialize", "prepare_state", "unitary", "barrier", "id"}
FRAMEWORKS = {"qiskit": "Qiskit", "cirq": "Cirq", "pennylane": "PennyLane"}
_MODULE_RECEIVERS = {"np", "numpy", "math", "torch", "os", "sys", "re", "json", "plt", "random", "jnp", "tf", "self"}

# issue words → canonical gates, used to seed retrieval
GATE_WORDS = {"cnot": "cx", "cx": "cx", "hadamard": "h", "toffoli": "ccx", "ccx": "ccx", "fredkin": "cswap",
              "cswap": "cswap", "swap": "swap", "iswap": "iswap", "cz": "cz", "rz": "rz", "rx": "rx", "ry": "ry",
              "rzz": "rzz", "measure": "measure", "measurement": "measure", "measurements": "measure",
              "measuring": "measure", "sdg": "sdg", "tdg": "tdg", "ecr": "ecr"}
CIRCUIT_WORDS = {"circuit", "circuits", "qubit", "qubits", "quantum", "entangle", "entangled", "entanglement",
                 "bell", "ghz", "transpile", "transpiler", "statevector", "ansatz"}

_INT = re.compile(r"\b(\d+)\b")


def canon(name: str) -> str:
    return CANON.get(name, name.lower())


def _empty(framework: str) -> dict:
    return {"framework": framework, "gates": {}, "n_gates": 0, "two_qubit": 0, "measure": 0, "qubits": 0,
            "circuit": False}


def _add_gate(m: dict, name: str, n_operands: int = 0) -> None:
    g = canon(name)
    m["gates"][g] = m["gates"].get(g, 0) + 1
    if g == "measure":
        m["measure"] += 1
    elif g not in NOT_GATE:
        m["n_gates"] += 1
        if g in MULTI or n_operands >= 2:
            m["two_qubit"] += 1


# ---------------------------------------------------------------------------- python


def framework_of(facts: FileFacts) -> str | None:
    for imp in facts.imports:
        head = (imp.module or "").split(".")[0]
        if head in FRAMEWORKS:
            return head
    return None


def python_qmeta(facts: FileFacts, src: bytes) -> None:
    fw = framework_of(facts)
    if fw is None:
        return
    lines = src.decode("utf-8", "replace").splitlines()
    metas: dict[str, dict] = {}
    rec_ok = {"qiskit": None, "cirq": {"cirq"}, "pennylane": {"qml", "pennylane"}}[fw]
    vocab = {"qiskit": QISKIT_GATES, "cirq": CIRQ_GATES, "pennylane": PENNYLANE_GATES}[fw]

    def meta(scope: str | None) -> dict:
        key = scope if scope in facts.defs else ""
        return metas.setdefault(key, _empty(FRAMEWORKS[fw]))

    for ref in facts.refs:
        name, recv, args = ref.name, ref.receiver or "", ref.args
        head = recv.split(".")[0]
        m = None
        # circuit constructors and width hints
        if name in ("QuantumCircuit", "QuantumRegister") or (name == "Circuit" and head == "cirq"):
            m = meta(ref.src)
            m["circuit"] = True
            ints = [int(x) for x in _INT.findall(args)[:2]]
            if ints and name != "Circuit":
                m["qubits"] = max(m["qubits"], ints[0] if name == "QuantumCircuit" else m["qubits"] + ints[0])
            continue
        if name == "range" and recv.endswith(("LineQubit", "GridQubit")):
            ints = [int(x) for x in _INT.findall(args)]
            if ints:
                meta(ref.src)["qubits"] = max(meta(ref.src)["qubits"], max(ints))
            continue
        if name == "device" and head in ("qml", "pennylane"):
            mt = re.search(r"wires\s*=\s*(\d+)", args)
            if mt:
                meta(ref.src)["qubits"] = max(meta(ref.src)["qubits"], int(mt.group(1)))
            continue
        if name not in vocab:
            continue
        if rec_ok is None:  # qiskit: method call on a circuit object
            if not recv or head in _MODULE_RECEIVERS or head in ("cirq", "qml"):
                continue
            if len(name) <= 2 and not args.strip("() "):
                continue  # e.g. obj.t() with no operands is not a gate
        elif head not in rec_ok:
            continue
        m = meta(ref.src)
        # python call arguments mix angles and qubits, so multi-qubit is decided by the gate's name
        _add_gate(m, name)
        idx = [int(x) for x in re.findall(r"(?:^|[\[\s,(])(\d+)(?=[\],\s)]|$)", args)]
        if idx and rec_ok is None:
            m["qubits"] = max(m["qubits"], max(idx) + 1)
        mt = re.search(r"wires\s*=\s*\[?([\d,\s]+)\]?", args)
        if mt:
            ws = [int(x) for x in re.findall(r"\d+", mt.group(1))]
            if ws:
                m["qubits"] = max(m["qubits"], max(ws) + 1)

    # PennyLane QNodes are circuits by decoration
    for qual, d in facts.defs.items():
        above = "\n".join(lines[max(0, d.start - 4): d.start - 1])
        if re.search(r"@\s*(qml\.)?qnode\b", above):
            metas.setdefault(qual, _empty(FRAMEWORKS[fw]))["circuit"] = True

    for k, m in metas.items():
        if m["n_gates"] >= 2:
            m["circuit"] = True
        if m["n_gates"] or m["measure"] or m["circuit"]:
            facts.qmeta[k] = m


# ---------------------------------------------------------------------------- openqasm

_QASM_KEYWORDS = {"OPENQASM", "include", "qreg", "creg", "qubit", "bit", "gate", "def", "opaque", "barrier", "if",
                  "else", "for", "while", "let", "const", "input", "output", "return", "int", "uint", "float",
                  "angle", "bool", "duration", "stretch", "complex", "array", "box", "delay", "defcal", "cal",
                  "extern", "end", "break", "continue", "pragma", "gphase"}
_DECL = re.compile(r"\b(gate|def|opaque)\s+([A-Za-z_]\w*)\s*(\([^)]*\))?\s*([^{;]*)([{;])")
_INCLUDE = re.compile(r'\binclude\s+"([^"]+)"\s*;')
_QREG = re.compile(r"\bqreg\s+\w+\s*\[\s*(\d+)\s*\]|\bqubit\s*\[\s*(\d+)\s*\]\s*\w+|\bqubit\s+\w+\s*;")


def _strip_comments(text: str) -> str:
    """Blank out // and /* */ comments, keeping every newline so line numbers survive."""
    out = re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), text, flags=re.S)
    return re.sub(r"//[^\n]*", lambda m: " " * len(m.group(0)), out)


def parse_qasm(path: str, src: bytes) -> FileFacts:
    text = _strip_comments(src.decode("utf-8", "replace"))
    facts = FileFacts(path=path, lang="openqasm", lines=text.count("\n") + 1)

    def line_of(pos: int) -> int:
        return text.count("\n", 0, pos) + 1

    for mt in _INCLUDE.finditer(text):
        facts.imports.append(Import(mt.group(1)))

    # declarations and their bodies
    bodies: list[tuple[int, int, str]] = []  # (start offset, end offset, qual)
    for mt in _DECL.finditer(text):
        kind, name, prm, args, opener = mt.groups()
        start = mt.start()
        if opener == "{":
            depth, j = 0, mt.end() - 1
            while j < len(text):
                if text[j] == "{":
                    depth += 1
                elif text[j] == "}":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            end = j
            bodies.append((mt.end(), end, name))
        else:
            end = mt.end()
        sig = " ".join(f"{kind} {name}{prm or ''} {args}".split())
        if name not in facts.defs:
            facts.defs[name] = Def(name, name, "function", line_of(start), line_of(end), sig, "", None)
            m = _empty("OpenQASM")
            m["qubits"] = len([a for a in args.split(",") if a.strip()]) if kind != "def" else 0
            m["circuit"] = False
            facts.qmeta[name] = m

    def owner(pos: int) -> str | None:
        for a, b, q in bodies:
            if a <= pos <= b:
                return q
        return None

    file_meta = _empty("OpenQASM")
    for mt in _QREG.finditer(text):
        if owner(mt.start()):
            continue
        file_meta["qubits"] += int(mt.group(1) or mt.group(2) or 1)

    # statements: split on ';' and braces, attribute each to its enclosing gate / def
    pos = 0
    for stmt in re.split(r"([;{}])", text):
        here = pos
        pos += len(stmt)
        st = stmt.strip()
        if not st or st in ";{}":
            continue
        # QASM 3 measurement assignment "c[0] = measure q[0]" and QASM 2 "measure q -> c"
        if re.search(r"\bmeasure\b", st):
            q = owner(here)
            facts.refs.append(Ref(q, "measure"))
            _add_gate(facts.qmeta[q] if q else file_meta, "measure")
            continue
        st = re.sub(r"^\s*(if\s*\([^)]*\)\s*)", "", st)
        st = re.sub(r"^((ctrl|negctrl|inv|pow)\s*(\([^)]*\))?\s*@\s*)+", "c", st)  # ctrl @ x → cx
        mt = re.match(r"([A-Za-z_]\w*)\s*(\([^)]*\))?\s*(.*)$", st, re.S)
        if not mt:
            continue
        name, _, operands = mt.groups()
        if name in _QASM_KEYWORDS or name in facts.defs and _DECL.match(st) or not operands.strip():
            continue
        q = owner(here)
        n_ops = len([o for o in operands.split(",") if o.strip()])
        facts.refs.append(Ref(q, name))
        _add_gate(facts.qmeta[q] if q else file_meta, name, n_ops)
    if file_meta["n_gates"] or file_meta["measure"]:
        file_meta["circuit"] = True
        facts.qmeta[""] = file_meta
    return facts


# ---------------------------------------------------------------------------- aggregation


def aggregate(t: int, live: dict[str, dict]) -> dict:
    """One point of the quantum growth curve: totals over every live annotated node at commit t."""
    out = {"t": t, "circuits": 0, "gates": 0, "two_qubit": 0, "measure": 0, "max_qubits": 0, "annotated": len(live)}
    for m in live.values():
        out["circuits"] += int(bool(m.get("circuit")))
        out["gates"] += m.get("n_gates", 0)
        out["two_qubit"] += m.get("two_qubit", 0)
        out["measure"] += m.get("measure", 0)
        out["max_qubits"] = max(out["max_qubits"], m.get("qubits", 0))
    return out


def quantum_stats(nodes: list[dict], growth: list[dict], T: int) -> dict | None:
    annotated = [n for n in nodes if n.get("qmeta")]
    if not annotated:
        return None
    alive = [n for n in annotated if n["f"] is None]
    mix: Counter = Counter()
    fw: Counter = Counter()
    for n in alive:
        mix.update(n["qmeta"]["gates"])
        fw[n["qmeta"]["framework"]] += 1
    last = growth[-1] if growth else aggregate(T - 1, {n["key"]: n["qmeta"] for n in alive})
    first = growth[0] if growth else last
    top = sorted(alive, key=lambda n: (-n["qmeta"]["n_gates"], n["key"]))[:20]
    gate_defs = sum(1 for n in alive if n["lang"] == "openqasm" and n["kind"] == "function")
    step = max(1, len(growth) // 400)
    return {
        "kpis": {"circuits": last["circuits"], "gates": last["gates"], "two_qubit": last["two_qubit"],
                 "measure": last["measure"], "max_qubits": last["max_qubits"], "annotated": len(alive),
                 "gate_defs": gate_defs, "gates_delta": last["gates"] - first["gates"],
                 "circuits_delta": last["circuits"] - first["circuits"], "ever_annotated": len(annotated)},
        "frameworks": dict(fw),
        "gate_mix": [{"gate": g, "count": c} for g, c in mix.most_common(14)],
        "growth": growth[::step] + ([growth[-1]] if growth and (len(growth) - 1) % step else []),
        "top": [{"key": n["key"], "name": n["name"], "path": n["path"], "kind": n["kind"], "lang": n["lang"],
                 "framework": n["qmeta"]["framework"], "n_gates": n["qmeta"]["n_gates"],
                 "two_qubit": n["qmeta"]["two_qubit"], "measure": n["qmeta"]["measure"],
                 "qubits": n["qmeta"]["qubits"], "circuit": n["qmeta"]["circuit"], "s": n["s"], "f": n["f"]}
                for n in top],
    }
