"""Incremental construction of the temporal code graph.

Walks the first-parent history once, oldest first. The oldest commit in the
window is parsed in full (the base snapshot); for every later commit only the
files it changed are re-parsed, their symbols' intervals are opened or closed,
and only the files whose references could have changed are re-resolved.
The same per-commit step would serve live updates.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import time
from pathlib import Path
from typing import Callable

from . import gitio, qcode
from .parse import FileFacts, is_test_path, lang_for, parse_file
from .resolve import EdgeKey, Resolver, node_key

ProgressFn = Callable[[dict], None]


def defs_touched(facts: FileFacts, a: int, b: int) -> set[str]:
    """Quals of definitions that own at least one line of [a, b] as their innermost definition."""
    if facts is None or b < a:
        return set()
    cands = [d for d in facts.defs.values() if d.start <= b and d.end >= a]
    if not cands:
        return set()
    by_parent: dict[str | None, list] = {}
    for d in cands:
        by_parent.setdefault(d.parent, []).append(d)
    out: set[str] = set()
    for d in cands:
        lo, hi = max(a, d.start), min(b, d.end)
        kids = sorted(((max(lo, k.start), min(hi, k.end)) for k in by_parent.get(d.qual, [])), key=lambda x: x[0])
        covered_to = lo - 1
        uncovered = False
        for ks, ke in kids:
            if ks > covered_to + 1:
                uncovered = True
                break
            covered_to = max(covered_to, ke)
        if uncovered or covered_to < hi:
            out.add(d.qual)
    return out


@dataclass
class BuildResult:
    commits: list[gitio.Commit]
    nodes: list[dict]
    edges: list[list]  # [src, dst, type, weight, s, f]
    changes: list[tuple]  # (t, key, root, path, level)
    n_delta: list[int] = field(default_factory=list)
    code_files: list[int] = field(default_factory=list)
    timings: dict = field(default_factory=dict)
    q_growth: list[dict] = field(default_factory=list)  # per-commit quantum aggregates (qcode.aggregate)


class Builder:
    def __init__(self, repo: Path, on_progress: ProgressFn | None = None, cancelled: Callable[[], bool] | None = None):
        self.repo = repo
        self.R = Resolver()
        self.nodes: list[dict] = []
        self.node_open: dict[str, int] = {}
        self.root_of: dict[str, str] = {}
        self.edges: list[list] = []
        self.edge_open: dict[EdgeKey, int] = {}
        self.edges_by_dst: dict[str, set[EdgeKey]] = {}
        self.out_edges: dict[str, dict[EdgeKey, float]] = {}
        self.changes: list[tuple] = []
        self.q_live: dict[str, dict] = {}  # live nodes carrying a quantum annotation
        self.q_growth: list[dict] = []
        self.on_progress = on_progress or (lambda e: None)
        self.cancelled = cancelled or (lambda: False)

    # ------------------------------------------------------------------ nodes

    def _open_node(self, key: str, t: int, facts: FileFacts, qual: str | None, root: str | None) -> None:
        if key in self.node_open:
            return
        if qual is None:
            row = dict(key=key, kind="file", name=facts.path.rsplit("/", 1)[-1], qual="", path=facts.path,
                       lang=facts.lang, start=1, end_line=facts.lines, sig="", doc="")
        else:
            d = facts.defs[qual]
            row = dict(key=key, kind=d.kind, name=d.name, qual=qual, path=facts.path, lang=facts.lang,
                       start=d.start, end_line=d.end, sig=d.signature, doc=d.doc)
        self._set_qmeta(row, key, facts.qmeta.get(qual or ""))
        row["root"] = root or self.root_of.get(key) or key
        row["is_test"] = int(is_test_path(facts.path))
        row["s"], row["f"] = t, None
        self.root_of[key] = row["root"]
        self.node_open[key] = len(self.nodes)
        self.nodes.append(row)

    def _set_qmeta(self, row: dict, key: str, qm: dict | None) -> None:
        row["qmeta"] = qm
        if qm:
            self.q_live[key] = qm
        else:
            self.q_live.pop(key, None)

    def _close_node(self, key: str, t: int) -> None:
        self.q_live.pop(key, None)
        i = self.node_open.pop(key, None)
        if i is not None:
            self.nodes[i]["f"] = t

    def _refresh_node(self, key: str, facts: FileFacts, qual: str | None) -> None:
        i = self.node_open.get(key)
        if i is None:
            return
        row = self.nodes[i]
        self._set_qmeta(row, key, facts.qmeta.get(qual or ""))
        if qual is None:
            row["end_line"] = facts.lines
        else:
            d = facts.defs[qual]
            row.update(start=d.start, end_line=d.end, sig=d.signature, doc=d.doc, kind=d.kind)

    @staticmethod
    def _keys(facts: FileFacts | None) -> dict[str, str | None]:
        if facts is None:
            return {}
        out: dict[str, str | None] = {facts.path: None}
        for q in facts.defs:
            out[node_key(facts.path, q)] = q
        return out

    def _sync_nodes(self, old: FileFacts | None, new: FileFacts | None, t: int) -> set[str]:
        """Open/close node intervals for one file change. Returns closed keys."""
        old_k, new_k = self._keys(old), self._keys(new)
        renamed = old is not None and new is not None and old.path != new.path
        closed = set()
        for k in old_k:
            if k not in new_k:
                self._close_node(k, t)
                closed.add(k)
        for k, q in new_k.items():
            if k in old_k:
                self._refresh_node(k, new, q)
            else:
                root = None
                if renamed:
                    okey = node_key(old.path, q) if q else old.path
                    root = self.root_of.get(okey)
                self._open_node(k, t, new, q, root)
        return closed

    # ------------------------------------------------------------------ edges

    def _open_edge(self, k: EdgeKey, w: float, t: int) -> None:
        self.edge_open[k] = len(self.edges)
        self.edges.append([k[0], k[1], k[2], round(w, 4), t, None])
        self.edges_by_dst.setdefault(k[1], set()).add(k)

    def _close_edge(self, k: EdgeKey, t: int) -> None:
        i = self.edge_open.pop(k, None)
        if i is not None:
            self.edges[i][5] = t
        s = self.edges_by_dst.get(k[1])
        if s:
            s.discard(k)

    def _reresolve(self, files: set[str], t: int) -> None:
        for path in files:
            new = self.R.compute_edges(path) if path in self.R.files else {}
            old = self.out_edges.get(path, {})
            for k in old.keys() - new.keys():
                self._close_edge(k, t)
            for k, w in new.items():
                if k not in old:
                    self._open_edge(k, w, t)
                elif abs(old[k] - w) > 1e-9 and k in self.edge_open:
                    self.edges[self.edge_open[k]][3] = round(w, 4)
            if new:
                self.out_edges[path] = new
            else:
                self.out_edges.pop(path, None)

    def _drop_dangling(self, closed: set[str], t: int) -> None:
        for key in closed:
            for k in list(self.edges_by_dst.get(key, ())):
                self._close_edge(k, t)
                src_file = k[0].split("::", 1)[0]
                oe = self.out_edges.get(src_file)
                if oe:
                    oe.pop(k, None)

    # ------------------------------------------------------------------ walk

    def build(self, depth: int) -> BuildResult:
        t0 = time.time()
        commits = gitio.first_parent_log(self.repo, depth)
        if not commits:
            raise RuntimeError("No commits found on the default branch")
        T = len(commits)
        self.on_progress({"stage": "snapshot", "frac": 0.0, "message": f"{T} commits on the first-parent chain"})
        reader = gitio.BlobReader(self.repo)
        n_delta: list[int] = []
        code_files: list[int] = []
        try:
            # ---- base snapshot at c_0
            base = commits[0]
            paths = [p for p in gitio.ls_tree(self.repo, base.sha) if lang_for(p)]
            for i, p in enumerate(paths):
                if self.cancelled():
                    raise RuntimeError("cancelled")
                data = reader.read(base.sha, p)
                facts = parse_file(p, data) if data is not None else None
                if facts is not None:
                    self.R.add_file(facts)
                    self._sync_nodes(None, facts, 0)
                if i % 25 == 0 or i == len(paths) - 1:
                    self.on_progress({"stage": "snapshot", "frac": (i + 1) / max(1, len(paths)),
                                      "message": p, "counters": self._counters(0, T)})
            self.on_progress({"stage": "resolve", "frac": 0.0, "message": "Resolving names across files",
                              "counters": self._counters(0, T)})
            files = list(self.R.files)
            for i in range(0, len(files), 50):
                self._reresolve(set(files[i:i + 50]), 0)
                self.on_progress({"stage": "resolve", "frac": min(1.0, (i + 50) / max(1, len(files))),
                                  "counters": self._counters(0, T)})
            n_delta.append(0)
            code_files.append(len(self.R.files))
            self.q_growth.append(qcode.aggregate(0, self.q_live))
            t_snapshot = time.time() - t0

            # ---- walk c_1 .. c_{T-1}
            for t in range(1, T):
                if self.cancelled():
                    raise RuntimeError("cancelled")
                c = commits[t]
                delta = self._apply_commit(c, t, reader)
                n_delta.append(delta)
                code_files.append(len(self.R.files))
                self.q_growth.append(qcode.aggregate(t, self.q_live))
                if t % 3 == 0 or t == T - 1:
                    self.on_progress({"stage": "walk", "frac": t / max(1, T - 1),
                                      "message": f"{c.sha[:7]} {c.msg[:80]}", "commit": t,
                                      "counters": self._counters(t, T)})
        finally:
            reader.close()
        return BuildResult(commits, self.nodes, self.edges, self.changes, n_delta, code_files,
                           {"snapshot_s": round(t_snapshot, 2), "total_s": round(time.time() - t0, 2)},
                           q_growth=self.q_growth if self.q_live or any(g["annotated"] for g in self.q_growth) else [])

    def _counters(self, t: int, T: int) -> dict:
        return {"commits": t + 1, "total_commits": T, "files": len(self.R.files),
                "symbols": len(self.node_open) - len(self.R.files), "edges": len(self.edge_open)}

    def _apply_commit(self, c: gitio.Commit, t: int, reader: gitio.BlobReader) -> int:
        work: list[tuple[str, str | None, str | None]] = []
        for st, old, new in c.changes:
            old_ok = old is not None and lang_for(old) is not None
            new_ok = new is not None and lang_for(new) is not None
            if not old_ok and not new_ok:
                continue
            if st == "R" and not old_ok:
                st, old = "A", None
            elif st == "R" and not new_ok:
                st, new = "D", None
            work.append((st, old if old_ok else None, new if new_ok else None))
        if not work:
            return 0

        hunk_paths = sorted({p for st, o, n in work if st in ("M", "R") for p in (o, n) if p})
        hunks = gitio.diff_hunks(self.repo, c.parent, c.sha, hunk_paths) if (c.parent and hunk_paths) else {}

        changed_names: set[str] = set()
        touched_files: set[str] = set()
        closed: set[str] = set()
        delta_keys: set[str] = set()
        delta_files: set[str] = set()

        for st, old_p, new_p in work:
            old_f = self.R.files.get(old_p) if old_p else None
            new_f = None
            if new_p:
                data = reader.read(c.sha, new_p)
                new_f = parse_file(new_p, data) if data is not None else None
            # Δ_t: which symbols did this change touch?
            if st == "A" and new_f is not None:
                delta_keys |= {node_key(new_p, q) for q in new_f.defs}
            elif st == "D" and old_f is not None:
                delta_keys |= {node_key(old_p, q) for q in old_f.defs}
            else:
                for os_, ol, ns_, nl in hunks.get(new_p or old_p, []):
                    if ol > 0 and old_f is not None:
                        for q in defs_touched(old_f, os_, os_ + ol - 1):
                            nk = node_key(new_p, q) if (new_f is not None and q in new_f.defs) else node_key(old_p, q)
                            delta_keys.add(nk)
                    if nl > 0 and new_f is not None:
                        delta_keys |= {node_key(new_p, q) for q in defs_touched(new_f, ns_, ns_ + nl - 1)}
            delta_files.add(new_p or old_p)

            # names whose definitions appeared or disappeared
            old_names = {d.name for d in old_f.defs.values()} if old_f else set()
            new_names = {d.name for d in new_f.defs.values()} if new_f else set()
            old_quals = set(old_f.defs) if old_f else set()
            new_quals = set(new_f.defs) if new_f else set()
            if old_p != new_p:
                changed_names |= old_names | new_names
            else:
                changed_names |= old_names ^ new_names
                changed_names |= {old_f.defs[q].name for q in old_quals - new_quals} if old_f else set()
                changed_names |= {new_f.defs[q].name for q in new_quals - old_quals} if new_f else set()

            if old_p:
                self.R.remove_file(old_p)
                touched_files.add(old_p)
            if new_f is not None:
                self.R.add_file(new_f)
                touched_files.add(new_p)
            if old_p != new_p or new_f is None or old_f is None:
                for p in (old_p, new_p):
                    if p:
                        touched_files |= self.R.files_importing_path(p)
            closed |= self._sync_nodes(old_f, new_f, t)

        # record changes (Δ_t) by lineage root
        for k in delta_keys:
            root = self.root_of.get(k, k)
            self.changes.append((t, k, root, k.split("::", 1)[0], "sym"))
        for p in delta_files:
            self.changes.append((t, p, self.root_of.get(p, p), p, "file"))

        affected = touched_files | self.R.files_referencing(changed_names)
        self._drop_dangling(closed, t)
        self._reresolve(affected, t)
        return len(delta_keys)
