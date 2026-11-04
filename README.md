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
   - **Graph:** scrub G<sub>τ</sub> through time and watch edges open (lime) and close (red).
   - **Stats:** growth, hidden coupling, churn hotspots, god nodes, communities, edge lifetimes and activity.
   - **Timeline:** per-commit Δ<sub>t</sub>, plus the edges and symbols each commit opened or closed.
   - **Retrieve:** issue → seeds → time-aware personalised PageRank → token-budgeted context, side by side with a static-only ablation.
   - **Report:** a Graphify-style `REPORT.md`, with `graph.json` export.

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
`~/.cache/tcg-studio` (override with `TCG_HOME`). Local repository paths work in the URL box too.

Languages: Python, JavaScript, TypeScript, Go and Java.

## Tests

```bash
cd backend && uv run pytest
```

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
  store.py      SQLite interval store;  pipeline.py  build jobs;  api.py  FastAPI
frontend/src/
  features/graph    force graph, time scrubber, node drawer, client-side G_τ filter
  features/stats    dashboard
  features/{timeline,retrieve,report}
```
