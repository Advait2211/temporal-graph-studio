"""Context retrieval over G_τ (proposal §Retrieval).

1. Seeds: exact identifiers / paths in the issue, stack-trace frames, BM25 top-m,
   multiplied by the change prior:  p(v) ∝ p0(v) · (1 + β h(v; τ)).
2. Time-aware personalised PageRank over mixed edge types:
   W = Σ_r α_r A^(r),  π = (1 − δ) p + δ Pᵀ π.
3. Budgeted packing: full bodies up to ρ·B tokens, then signatures until B.
The static-only ablation (α_cochange = β = 0) runs alongside for comparison.
"""

from __future__ import annotations

from collections import defaultdict
import math
import re
import threading
from pathlib import Path

import numpy as np
from rank_bm25 import BM25Okapi
import scipy.sparse as sp
import tiktoken

from . import gitio, history, store
from .parse import parse_file

_ENC = tiktoken.get_encoding("cl100k_base")
_IDENT = re.compile(r"`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)(\()?")
_PATH = re.compile(r"([\w./-]+\.(?:py|pyi|js|jsx|mjs|ts|tsx|go|java))")
_FRAME = re.compile(r"""(?:File\s+"([^"]+)",\s+line\s+(\d+))|(?:([\w./-]+\.(?:py|js|jsx|mjs|ts|tsx|go|java)):(\d+))""")
_SPLIT = re.compile(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+")
_STOP = set("""the a an and or of to in is it this that for on with as be by not are was were when what why how
should would could can does do did has have had from at if then else but into out up down use used using get set
issue error bug fix fails failing failed expected actual return returns value values true false none null new old
file line code test tests call calls called function method class object type data name names one two all any""".split())

DEFAULTS = {"alpha_calls": 1.0, "alpha_imports": 0.4, "alpha_inherits": 0.8, "alpha_contains": 0.6,
            "alpha_cochange": 1.2, "beta": 0.8, "delta": 0.8, "rho": 0.7, "m": 20, "lambda": history.DEFAULT_LAMBDA}


def _tok(text: str) -> list[str]:
    out = []
    for w in re.findall(r"[A-Za-z_][A-Za-z0-9_]*", text):
        out.append(w.lower())
        parts = _SPLIT.findall(w)
        if len(parts) > 1:
            out.extend(p.lower() for p in parts)
        if "_" in w:
            out.extend(p.lower() for p in w.split("_") if p)
    return out


def ntok(text: str) -> int:
    return len(_ENC.encode(text, disallowed_special=()))


class _Snapshot:
    """Everything retrieval needs at one commit τ, built once and cached."""

    def __init__(self, repo_id: str, tau: int):
        conn = store.connect(repo_id)
        try:
            self.repo = store.get_meta(conn, "repo")
            self.T = conn.execute("SELECT COUNT(*) FROM commits").fetchone()[0]
            self.tau = max(0, min(tau, self.T - 1))
            self.sha = conn.execute("SELECT sha FROM commits WHERE idx = ?", (self.tau,)).fetchone()[0]
            nodes = store.nodes_as_of(conn, self.tau)
            edges = store.edges_as_of(conn, self.tau)
            sym_rows = store.changes_upto(conn, self.tau, "sym")
            cc = store.get_meta(conn, "cochange", [])
        finally:
            conn.close()
        self.nodes = [dict(n) for n in nodes]
        self.idx = {n["key"]: i for i, n in enumerate(self.nodes)}
        self.root_key = {n["root"]: n["key"] for n in self.nodes}
        D = history.deltas(sym_rows)
        self.prior = history.change_prior(D, self.tau, DEFAULTS["lambda"])
        self.last_change: dict[str, int] = {}
        for r in sym_rows:
            self.last_change[r[2]] = int(r[0])
        contrib = {(a, b): [tuple(x) for x in terms] for a, b, terms in cc}
        self.cochange = history.cochange_weights(contrib, self.tau, DEFAULTS["lambda"])
        self.edges = [(e["src"], e["dst"], e["type"], e["weight"]) for e in edges
                      if e["src"] in self.idx and e["dst"] in self.idx]
        self.by_name: dict[str, list[int]] = defaultdict(list)
        self.by_path: dict[str, list[int]] = defaultdict(list)
        for i, n in enumerate(self.nodes):
            if n["kind"] != "file":
                self.by_name[n["name"]].append(i)
            self.by_path[n["path"]].append(i)
        self._load_sources()

    def _load_sources(self) -> None:
        """Bodies at τ: re-parse each live file at commit τ for exact spans."""
        repo_dir = Path(self.repo["repo_dir"])
        reader = gitio.BlobReader(repo_dir)
        self.body: dict[int, str] = {}
        self.spans: dict[int, tuple[int, int]] = {}
        self.file_facts = {}
        try:
            for path in self.by_path:
                data = reader.read(self.sha, path)
                if data is None:
                    continue
                facts = parse_file(path, data)
                if facts is None:
                    continue
                self.file_facts[path] = facts
                lines = data.decode("utf-8", "replace").splitlines()
                for i in self.by_path[path]:
                    n = self.nodes[i]
                    if n["kind"] == "file":
                        continue
                    d = facts.defs.get(n["qual"])
                    if d is None:
                        continue
                    self.spans[i] = (d.start, d.end)
                    self.body[i] = "\n".join(lines[d.start - 1:d.end])
        finally:
            reader.close()
        self.doc_ids = [i for i, n in enumerate(self.nodes) if n["kind"] != "file"]
        corpus = []
        for i in self.doc_ids:
            n = self.nodes[i]
            text = f"{n['name']} {n['qual']} {n['sig']} {n['doc']} {n['path']} {self.body.get(i, '')[:4000]}"
            corpus.append(_tok(text) or ["_"])
        self.bm25 = BM25Okapi(corpus) if corpus else None


_CACHE: dict[tuple[str, int], _Snapshot] = {}
_LOCK = threading.Lock()


def snapshot(repo_id: str, tau: int) -> _Snapshot:
    key = (repo_id, tau)
    with _LOCK:
        s = _CACHE.get(key)
        if s is None:
            s = _Snapshot(repo_id, tau)
            if len(_CACHE) > 6:
                _CACHE.pop(next(iter(_CACHE)))
            _CACHE[key] = s
    return s


def invalidate(repo_id: str) -> None:
    with _LOCK:
        for k in [k for k in _CACHE if k[0] == repo_id]:
            _CACHE.pop(k, None)


# ---------------------------------------------------------------------------- seeds


def _seeds(S: _Snapshot, issue: str, m: int) -> dict[int, list[tuple[str, float, str]]]:
    """node index -> list of (reason, weight, evidence)."""
    seeds: dict[int, list[tuple[str, float, str]]] = defaultdict(list)

    # stack-trace frames: file + line -> enclosing symbol
    for mt in _FRAME.finditer(issue):
        path, line = (mt.group(1), mt.group(2)) if mt.group(1) else (mt.group(3), mt.group(4))
        line = int(line)
        for p in S.by_path:
            if p.endswith(path.lstrip("./")) or path.endswith(p):
                facts = S.file_facts.get(p)
                d = facts.def_at(line) if facts else None
                key = f"{p}::{d.qual}" if d else p
                if key in S.idx:
                    seeds[S.idx[key]].append(("stack frame", 4.0, f"{path}:{line}"))
                break

    # file paths
    for mt in _PATH.finditer(issue):
        frag = mt.group(1).lstrip("./")
        for p in S.by_path:
            if p.endswith(frag):
                fi = S.idx.get(p)
                if fi is not None:
                    seeds[fi].append(("path", 2.0, frag))

    # identifiers
    for mt in _IDENT.finditer(issue):
        code, word, paren = mt.group(1), mt.group(2), mt.group(3)
        tokens = re.findall(r"[A-Za-z_][A-Za-z0-9_]*", code) if code else [word.split(".")[-1]] + word.split(".")[:-1]
        for j, tokn in enumerate(tokens):
            if len(tokn) < 3 or tokn.lower() in _STOP:
                continue
            hits = S.by_name.get(tokn)
            if not hits:
                continue
            codey = bool(code) or bool(paren) or "_" in tokn or (tokn[0].isupper() and any(c.islower() for c in tokn[1:])) \
                or "." in (word or "") or any(c.isupper() for c in tokn[1:])
            if not codey and len(tokn) < 5:
                continue
            w = (3.0 if codey else 1.2) / math.sqrt(len(hits))
            for i in hits[:8]:
                if all(r[0] != "identifier" for r in seeds[i]):
                    seeds[i].append(("identifier", w, tokn))

    # BM25 top-m
    if S.bm25 is not None:
        q = _tok(issue)
        if q:
            scores = S.bm25.get_scores(q)
            top = np.argsort(-scores)[:m]
            mx = float(scores[top[0]]) if len(top) else 0.0
            if mx > 0:
                for j in top:
                    if scores[j] <= 0:
                        break
                    seeds[S.doc_ids[j]].append(("bm25", float(scores[j]) / mx, f"{scores[j]:.2f}"))
    return seeds


# ---------------------------------------------------------------------------- ppr


def _ppr(S: _Snapshot, p: np.ndarray, params: dict, use_history: bool) -> np.ndarray:
    n = len(S.nodes)
    rows, cols, vals = [], [], []

    def add(a: int, b: int, w: float) -> None:
        if w > 0:
            rows.append(a)
            cols.append(b)
            vals.append(w)

    a = params
    for src, dst, typ, w in S.edges:
        i, j = S.idx[src], S.idx[dst]
        if typ == "calls":
            add(i, j, a["alpha_calls"] * w)
            add(j, i, 0.7 * a["alpha_calls"] * w)  # callers are plausible edit sites too
        elif typ == "imports":
            add(i, j, a["alpha_imports"] * w)
            add(j, i, a["alpha_imports"] * w)
        elif typ == "inherits":
            add(i, j, a["alpha_inherits"] * w)
            add(j, i, a["alpha_inherits"] * w)
        elif typ == "contains":
            add(i, j, a["alpha_contains"] * w)
            add(j, i, a["alpha_contains"] * w)
    if use_history and a["alpha_cochange"] > 0:
        for (ra, rb), w in S.cochange.items():
            ka, kb = S.root_key.get(ra), S.root_key.get(rb)
            if ka and kb:
                i, j = S.idx[ka], S.idx[kb]
                add(i, j, a["alpha_cochange"] * w)
                add(j, i, a["alpha_cochange"] * w)
    W = sp.csr_matrix((vals, (rows, cols)), shape=(n, n))
    out = np.asarray(W.sum(axis=1)).ravel()
    inv = np.divide(1.0, out, out=np.zeros_like(out), where=out > 0)
    P = sp.diags(inv) @ W
    PT = P.T.tocsr()
    dangling = out == 0
    delta = a["delta"]
    pi = p.copy()
    for _ in range(60):
        nxt = (1 - delta) * p + delta * (PT @ pi + pi[dangling].sum() * p)
        if np.abs(nxt - pi).sum() < 1e-9:
            pi = nxt
            break
        pi = nxt
    return pi


# ---------------------------------------------------------------------------- main


def retrieve(repo_id: str, issue: str, tau: int | None, budget: int, params: dict | None = None) -> dict:
    conn = store.connect(repo_id)
    T = conn.execute("SELECT COUNT(*) FROM commits").fetchone()[0]
    conn.close()
    tau = T - 1 if tau is None else tau
    S = snapshot(repo_id, tau)
    a = {**DEFAULTS, **{k: float(v) for k, v in (params or {}).items() if k in DEFAULTS}}
    n = len(S.nodes)
    seeds = _seeds(S, issue, int(a["m"]))

    def personalisation(beta: float) -> np.ndarray:
        p = np.zeros(n)
        for i, rs in seeds.items():
            p[i] = sum(w for _, w, _ in rs)
        if p.sum() == 0:  # no evidence at all: fall back to the change prior
            for i, nd in enumerate(S.nodes):
                p[i] = S.prior.get(nd["root"], 0.0) if beta > 0 else 1.0
            if p.sum() == 0:
                p[:] = 1.0
        if beta > 0:
            h = np.array([S.prior.get(nd["root"], 0.0) for nd in S.nodes])
            p = p * (1 + beta * h)
        return p / p.sum()

    pi = _ppr(S, personalisation(a["beta"]), a, True)
    pi_static = _ppr(S, personalisation(0.0), {**a, "alpha_cochange": 0.0}, False)

    units = [i for i, nd in enumerate(S.nodes) if nd["kind"] in ("function", "method")]
    order = sorted(units, key=lambda i: -pi[i])
    order_static = sorted(units, key=lambda i: -pi_static[i])
    rank_static = {i: r for r, i in enumerate(order_static)}
    rank_full = {i: r for r, i in enumerate(order)}

    # budgeted packing
    packed, used, body_tokens, sig_tokens = [], 0, 0, 0
    body_limit = a["rho"] * budget
    for i in order:
        if used >= budget:
            break
        nd = S.nodes[i]
        body = S.body.get(i)
        if body is None:
            continue
        header = f"# {nd['path']}:{S.spans.get(i, (nd['start'], nd['end_line']))[0]}\n"
        if used < body_limit:
            cost = ntok(header + body)
            if used + cost <= budget:
                packed.append({"key": nd["key"], "mode": "body", "tokens": cost, "text": header + body})
                used += cost
                body_tokens += cost
                continue
        sig = nd["sig"] or body.splitlines()[0]
        cost = ntok(header + sig)
        if used + cost > budget:
            continue
        packed.append({"key": nd["key"], "mode": "signature", "tokens": cost, "text": header + sig})
        used += cost
        sig_tokens += cost

    def item(i: int, r: int) -> dict:
        nd = S.nodes[i]
        rs = rank_static.get(i)
        return {
            "rank": r + 1, "key": nd["key"], "name": nd["name"], "qual": nd["qual"], "kind": nd["kind"],
            "path": nd["path"], "score": float(pi[i]), "static_rank": (rs + 1) if rs is not None else None,
            "moved": (rs - r) if rs is not None else None, "prior": round(S.prior.get(nd["root"], 0.0), 3),
            "last_change": S.last_change.get(nd["root"]), "community": nd["community"],
            "seed": [{"reason": rr, "weight": round(w, 3), "evidence": ev} for rr, w, ev in seeds.get(i, [])],
            "tokens": ntok(S.body.get(i, "")) if r < 40 else None,
        }

    ranking = [item(i, r) for r, i in enumerate(order[:40])]
    static_ranking = [{"rank": r + 1, "key": S.nodes[i]["key"], "name": S.nodes[i]["name"],
                       "path": S.nodes[i]["path"], "score": float(pi_static[i]),
                       "full_rank": rank_full.get(i, 0) + 1}
                      for r, i in enumerate(order_static[:40])]

    file_score: dict[str, float] = defaultdict(float)
    for i in range(n):
        file_score[S.nodes[i]["path"]] += float(pi[i])
    files = [{"path": p, "score": s} for p, s in sorted(file_score.items(), key=lambda kv: -kv[1])[:15]]

    seed_list = sorted(
        ({"key": S.nodes[i]["key"], "name": S.nodes[i]["name"], "kind": S.nodes[i]["kind"],
          "weight": round(sum(w for _, w, _ in rs), 3),
          "reasons": sorted({r for r, _, _ in rs})} for i, rs in seeds.items()),
        key=lambda x: -x["weight"])[:30]

    # subgraph for the mini graph: top-ranked + seeds, with edges among them
    keep = {S.nodes[i]["key"] for i in order[:25]} | {s["key"] for s in seed_list[:10]}
    sub_edges = [{"source": s, "target": d, "type": t} for s, d, t, _ in S.edges if s in keep and d in keep and t != "contains"]
    for (ra, rb), w in S.cochange.items():
        ka, kb = S.root_key.get(ra), S.root_key.get(rb)
        if ka in keep and kb in keep and w > 0.15:
            sub_edges.append({"source": ka, "target": kb, "type": "cochange"})
    sub_nodes = [{"id": k, "name": S.nodes[S.idx[k]]["name"], "kind": S.nodes[S.idx[k]]["kind"],
                  "score": float(pi[S.idx[k]]), "seed": S.idx[k] in seeds,
                  "community": S.nodes[S.idx[k]]["community"]} for k in keep]

    overlap = len({x["key"] for x in ranking[:10]} & {x["key"] for x in static_ranking[:10]})
    return {
        "tau": S.tau, "sha": S.sha, "budget": budget, "params": a,
        "seeds": seed_list, "ranking": ranking, "static_ranking": static_ranking, "files": files,
        "packed": packed, "tokens": {"used": used, "body": body_tokens, "signature": sig_tokens, "budget": budget},
        "subgraph": {"nodes": sub_nodes, "links": sub_edges},
        "summary": {"graph_nodes": n, "graph_edges": len(S.edges), "cochange_edges": len(S.cochange),
                    "seed_count": len(seeds), "top10_overlap_with_static": overlap},
    }

