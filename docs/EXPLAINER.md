# TCG Studio, explained

## The idea
Coding agents need to find *where* in a repository a change belongs. Most code-retrieval tools
build a graph of the code (who calls whom, who imports whom) from **one snapshot**. They ignore
history, even though history predicts which code changes together and where bugs appear.

A **temporal code graph** (TCG) keeps structure and history in **one graph**:
- **Nodes** are files, classes, functions and methods.
- **Structural edges** are `contains`, `imports`, `calls` and `inherits`.
- **History edges** are `co-change`: two symbols edited in the same commit, weighted so that
  recent commits count more.
- Every node and edge stores the **range of commits `[s, f)` it existed for**, so you can ask
  for the graph *as it was at any commit τ* (written G<sub>τ</sub>).

## How a build works
1. Clone the repo (shallow) and list the last N commits along the main branch.
2. Parse every file at the oldest commit with Tree-sitter. This is the base snapshot.
3. For each later commit, re-parse **only the files it changed** and map diff lines onto symbols
   (the set changed by that commit is Δ<sub>t</sub>). Open intervals for anything new and close
   them for anything removed.
4. Link references to definitions across files (heuristically; a name with k candidate
   definitions gets k edges of weight 1/k).
5. Compute history signals:
   - **co-change** weight for each pair edited together
   - a **change prior** h(v; τ) for each symbol: how much it changed recently
6. Detect modules (communities), central "god" nodes, hidden coupling and lifetimes, then save
   everything to SQLite.

Signals at commit τ use only commits up to τ, so nothing leaks from the future.

## The app
- **Graph:**
  - opens on a **module map**; click a module to see its symbols
  - drag the **timeline** to travel through history, or turn on **Compare** to see what
    changed between two commits
  - hover a node for a summary card; right-click it for the dependency flow, the path finder,
    hide or pin
  - press `?` for the legend and `F` for fullscreen
- **Stats:** growth over time, hidden coupling (always edited together but never linked in
  code), churn hotspots, god nodes, modules, how long edges survive, and commit activity.
- **Timeline:** each commit with the symbols it changed and the edges it opened or closed.
- **Retrieve:** paste an issue and get ranked, token-budgeted code context from time-aware
  PageRank, side by side with a version that ignores history.
- **Report:** a Graphify-style summary, with downloads of `REPORT.md` and `graph.json`.

## Code map
- `backend/tcg/`: Python (FastAPI)
  - `parse.py`: Tree-sitter parsing
  - `resolve.py`: name resolution
  - `builder.py`: incremental history walk
  - `history.py`: co-change and change prior
  - `analysis.py`: modules, god nodes, stats
  - `retrieve.py`: ranking and packing
  - `store.py`: SQLite
  - `api.py`: HTTP API
- `frontend/src/`: React + TypeScript
  - `features/graph/` holds the explorer (`temporal.ts` filters G<sub>τ</sub> in the browser)
