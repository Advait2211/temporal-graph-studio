# TCG Studio

A local web app for the **temporal code graph** (TCG) from our survey and proposal
(`../papers/`). Paste a GitHub URL and TCG Studio:

1. clones the repo (shallow, first-parent history, default 300 commits),
2. parses the oldest commit in full with Tree-sitter, then walks every later commit and re-parses
   **only the files it changed**,
3. stores one SQLite graph whose nodes and edges (contains · imports · calls · inherits) carry
   **validity intervals `[s, f)`** over commits, plus co-change edges and a change prior computed
   only from ancestors of τ (leakage-safe),
4. serves a neo-brutalist UI with these views:
   - **Graph:** opens on a module map you can drill into; scrub G<sub>τ</sub> through time or compare
     two commits; hover cards, right-click actions, dependency-flow view, path finder, fullscreen
     and a built-in legend (`?`).
   - **Stats:** growth, hidden coupling, churn hotspots, god nodes, communities, edge lifetimes and activity.
   - **Timeline:** per-commit Δ<sub>t</sub>, plus the edges and symbols each commit opened or closed.
   - **Retrieve:** issue → seeds → time-aware personalised PageRank → token-budgeted context, side by side with a static-only ablation.
   - **Report:** a Graphify-style `REPORT.md`, with `graph.json` export.
   - **Quantum:** the quantum version of the pipeline, simulated locally with Qiskit and Qiskit Aer:
     - *Quantum walk:* ranks code with a continuous-time quantum walk over the same mixed-edge graph and
       seeds, next to PPR and the static ablation.
     - *Circuit:* runs the same walk as a gate-based circuit on the top 2ᵏ nodes (state preparation,
       Suzuki–Trotter evolution, measurement) and checks the result against the exact evolution.
     - *QAOA pack:* picks which bodies fit the token budget by solving a QUBO (rank score, co-change
       bonus, slack-encoded budget) with QAOA. It compares against greedy, random sampling and exact
       brute force, with optional gate noise.
     - *Error correction:* puts a noisy memory window in the middle of the walk and protects it with
       the 3-qubit bit-flip and phase-flip codes and Shor's 9-qubit code (syndrome readout,
       feed-forward correction). It also plots logical vs physical error rate against 3p² − 2p³.
     - *Quantum code:* finds gates, qubits and circuits in Qiskit, Cirq, PennyLane and OpenQASM, tracks
       them over commits, and seeds retrieval from gate names in the issue (CNOT, Hadamard, …).

## Run

```bash
./dev.sh            # API on :8000, UI on http://localhost:5173
```

Or run the two halves separately:

```bash
cd backend  && uv run uvicorn tcg.api:app --port 8000 --reload
cd frontend && npm install && npx vite
```

Needs `git`, `uv` and Node 20+. Set `GITHUB_TOKEN` to lift the GitHub API's 60 requests per hour
limit (only used for stars, languages and contributors). Graphs and clones are cached in
`~/.cache/tcg-studio` (override with `TCG_HOME`).

**Local repositories:** paste the full path of any folder inside a git repository (for example
`/Users/you/projects/app` or `~/projects/app/src`). It needs at least one commit, and only
committed history is used. A plain folder that isn't a git repo is refused with instructions;
run `git init && git add -A && git commit -m "Initial commit"` there first. The time slider fills
in as you keep committing and click Rebuild.

Languages: Python, JavaScript, TypeScript, Go, Java and OpenQASM 2/3.

All quantum computation is classical simulation on your machine. Graphs are much too large for
today's hardware, so the circuit, QAOA and QEC views work on small subproblems: up to 5, 18 and 18
qubits respectively.

## Tests

```bash
cd backend && uv run pytest
```

`tests/test_quantum.py` builds a toy quantum repository (Qiskit circuits and an OpenQASM gate
library). It checks:
- that the walk conserves probability, and that Trotter error falls as reps increase;
- that the QUBO→Ising mapping is correct;
- that QAOA stays feasible;
- that every single-qubit error is corrected (X for bit-flip, Z for phase-flip, X/Y/Z for Shor);
- that the error-rate sweep matches the closed form;
- that gate counts and intervals over the commit history are right.

The tests build the proposal's toy repository (`checkout / total / tax / round_cents`) with
`git init` and check interval open and close, Δ<sub>t</sub>, co-change weights, the change prior,
and that no commit after τ leaks into G<sub>τ</sub>.

## Layout

```
backend/tcg/
  parse.py      tree-sitter symbol, call, import and base extraction
  resolve.py    heuristic cross-file name resolution (1/k weights, reverse indices)
  builder.py    incremental commit walker: Δ_t, opening and closing [s, f)
  history.py    co-change w_cc(u,v;τ) and change prior h(v;τ)
  analysis.py   communities, god nodes, hidden coupling, growth, lifetimes, KPIs
  retrieve.py   seeds → time-aware PPR → budgeted packing (+ static ablation)
  qwalk.py      continuous-time quantum walk ranking; the same walk as a Trotterised Qiskit circuit
  qpack.py      token packing as a QUBO → Ising → QAOA (vs greedy, random, exact; optional noise)
  qec.py        noisy memory + bit-flip / phase-flip / Shor codes; logical vs physical error sweep
  qcode.py      Qiskit / Cirq / PennyLane gate extraction and an OpenQASM parser
  store.py      SQLite interval store;  pipeline.py  build jobs;  api.py  FastAPI
frontend/src/
  features/graph    force graph, time scrubber, node drawer, client-side G_τ filter
  features/stats    dashboard
  features/{timeline,retrieve,report}
  features/quantum  walk · circuit · QAOA pack · error correction · quantum code
```

A plain-language walkthrough of the idea and the code is in [`docs/EXPLAINER.md`](docs/EXPLAINER.md).
