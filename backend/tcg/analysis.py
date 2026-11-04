"""Whole-graph analysis computed once per build: communities, god nodes, hidden
coupling, growth and lifetime series, hotspots, contributors and KPIs."""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timezone
import posixpath

import networkx as nx

from . import history
from .builder import BuildResult
from .parse import LANG_LABEL
from .resolve import _is_aux

STRUCT_TYPES = ("calls", "imports", "inherits", "contains")
KINDS = ("file", "class", "function", "method")


def _community_label(members: list[dict], pr: dict[str, float]) -> str:
    prod = [m for m in members if not m.get("is_test")]
    members = prod or members
    dirs = Counter()
    for m in members:
        d = posixpath.dirname(m["path"])
        dirs[d.rsplit("/", 1)[-1] if d else m["path"].rsplit(".", 1)[0]] += 1
    top_dir = dirs.most_common(1)[0][0] if dirs else "root"
    named = [m for m in members if m["kind"] in ("class", "function", "method")]
    named.sort(key=lambda m: -pr.get(m["key"], 0))
    head = named[0]["name"] if named else members[0]["name"]
    return f"{top_dir} · {head}"


def analyze(res: BuildResult, lam: float = history.DEFAULT_LAMBDA, K: int = history.DEFAULT_K) -> dict:
    commits = res.commits
    T = len(commits)
    tau = T - 1
    nodes, edges = res.nodes, res.edges
    alive_nodes = [n for n in nodes if n["f"] is None]
    alive_edges = [e for e in edges if e[5] is None]
    by_key = {n["key"]: n for n in alive_nodes}
    root_alive = {n["root"]: n["key"] for n in alive_nodes}

    # ------------------------------------------------------------- history signals
    sym_rows = [c for c in res.changes if c[4] == "sym"]
    file_rows = [c for c in res.changes if c[4] == "file"]
    D, Df = history.deltas(sym_rows), history.deltas(file_rows)
    prior = history.change_prior(D, tau, lam)
    counts = history.change_counts(D, tau)
    fprior = history.change_prior(Df, tau, lam)
    fcounts = history.change_counts(Df, tau)
    contrib = history.cochange_contributions(D, K)
    w_cc = history.cochange_weights(contrib, tau, lam)
    fcontrib = history.cochange_contributions(Df, 25)
    fw_cc = history.cochange_weights(fcontrib, tau, lam)

    # ------------------------------------------------------------- pagerank (final snapshot)
    G = nx.DiGraph()
    for n in alive_nodes:
        G.add_node(n["key"])
    for src, dst, typ, w, s, f in alive_edges:
        if typ == "contains":
            G.add_edge(dst, src, weight=0.3 * w)
        else:
            G.add_edge(src, dst, weight=w * (0.6 if typ == "imports" else 1.0))
    pr = nx.pagerank(G, alpha=0.85, weight="weight") if G.number_of_nodes() else {}
    # god nodes: centrality from dependencies only (containment would crown big classes nobody calls)
    Gd = nx.DiGraph()
    Gd.add_nodes_from(G.nodes)
    for src, dst, typ, w, s, f in alive_edges:
        if typ != "contains":
            Gd.add_edge(src, dst, weight=w * (0.6 if typ == "imports" else 1.0))
    pr_dep = nx.pagerank(Gd, alpha=0.85, weight="weight") if Gd.number_of_nodes() else {}

    # ------------------------------------------------------------- communities on the union graph
    U = nx.Graph()
    latest: dict[str, dict] = {}
    for n in nodes:
        latest[n["key"]] = n
        U.add_node(n["key"])
    for src, dst, typ, w, s, f in edges:
        if src in latest and dst in latest:
            wt = {"contains": 1.0, "calls": 1.0, "inherits": 1.2, "imports": 0.5}.get(typ, 0.5) * w
            U.add_edge(src, dst, weight=U.get_edge_data(src, dst, {}).get("weight", 0) + wt)
    key_of_root = {}
    for n in nodes:
        key_of_root.setdefault(n["root"], n["key"])
    key_of_root.update(root_alive)
    for (a, b), w in w_cc.items():
        ka, kb = key_of_root.get(a), key_of_root.get(b)
        if ka and kb and ka != kb:
            U.add_edge(ka, kb, weight=U.get_edge_data(ka, kb, {}).get("weight", 0) + 1.5 * w)
    comm_sets = nx.community.louvain_communities(U, weight="weight", resolution=1.0, seed=7) if U.number_of_nodes() else []
    # colour slots go to the communities with the most live production code, so hiding tests keeps colour
    comm_sets = sorted(comm_sets, key=lambda cs: (sum(1 for k in cs if k in by_key and not by_key[k]["is_test"]), len(cs)),
                       reverse=True)
    community: dict[str, int] = {}
    communities = []
    for cid, cs in enumerate(comm_sets):
        members = [latest[k] for k in cs]
        for k in cs:
            community[k] = cid
        alive_members = [m for m in members if m["key"] in by_key]
        files = {m["path"] for m in members}
        communities.append({
            "id": cid,
            "label": _community_label(alive_members or members, pr),
            "size": len(alive_members),
            "size_all": len(cs),
            "files": len(files),
            "top": [m["key"] for m in sorted(alive_members, key=lambda m: -pr.get(m["key"], 0))[:6]],
            "churn": round(sum(prior.get(m["root"], 0) for m in alive_members), 2),
        })
    for n in nodes:
        n["community"] = community.get(n["key"], -1)
        n["pagerank"] = pr.get(n["key"], 0.0)

    # ------------------------------------------------------------- degree, god nodes
    deg = Counter()
    for src, dst, typ, w, s, f in alive_edges:
        if typ != "contains":
            deg[src] += 1
            deg[dst] += 1
    sym_alive = [n for n in alive_nodes if n["kind"] != "file"]
    prod_syms = [n for n in sym_alive if not n["is_test"]] or sym_alive
    god = sorted(prod_syms, key=lambda n: -pr_dep.get(n["key"], 0))[:12]
    in_calls = Counter(e[1] for e in alive_edges if e[2] == "calls")
    god_nodes = [{
        "key": n["key"], "name": n["name"], "qual": n["qual"], "kind": n["kind"], "path": n["path"],
        "pagerank": pr_dep.get(n["key"], 0), "degree": deg[n["key"]], "callers": in_calls[n["key"]],
        "community": community.get(n["key"], -1), "prior": round(prior.get(n["root"], 0), 3),
    } for n in god]

    deg_hist = Counter(deg[n["key"]] for n in sym_alive)
    degree_distribution = [{"degree": d, "count": c} for d, c in sorted(deg_hist.items())]

    # ------------------------------------------------------------- hidden coupling
    adj: dict[str, set[str]] = defaultdict(set)
    file_links: set[tuple[str, str]] = set()
    for src, dst, typ, w, s, f in alive_edges:
        if typ in ("calls", "inherits"):
            adj[src].add(dst)
            adj[dst].add(src)
            fa, fb = src.split("::")[0], dst.split("::")[0]
            if fa != fb:
                file_links.add((min(fa, fb), max(fa, fb)))
        elif typ == "imports":
            file_links.add((min(src, dst), max(src, dst)))

    hidden_sym = []
    strong_pairs = 0
    for (ra, rb), w in sorted(w_cc.items(), key=lambda kv: -kv[1]):
        ka, kb = root_alive.get(ra), root_alive.get(rb)
        if not ka or not kb:
            continue
        na, nb = by_key[ka], by_key[kb]
        if na["path"] == nb["path"]:
            continue
        strong_pairs += 1
        linked = kb in adj[ka] or bool(adj[ka] & adj[kb]) or (min(na["path"], nb["path"]), max(na["path"], nb["path"])) in file_links
        if not linked:
            n_co = len(contrib.get((ra, rb), []))
            hidden_sym.append({"a": ka, "b": kb, "weight": round(w, 3), "times": n_co,
                               "aux": _is_aux(na["path"]) or _is_aux(nb["path"])})
        if len(hidden_sym) >= 40:
            break

    hidden_files = []
    for (fa, fb), w in sorted(fw_cc.items(), key=lambda kv: -kv[1]):
        if fa not in by_key or fb not in by_key:
            continue
        if (min(fa, fb), max(fa, fb)) in file_links:
            continue
        hidden_files.append({"a": fa, "b": fb, "weight": round(w, 3), "times": len(fcontrib.get((fa, fb), [])),
                             "aux": _is_aux(fa) or _is_aux(fb)})
        if len(hidden_files) >= 30:
            break

    top_cochange = []
    for (ra, rb), w in sorted(w_cc.items(), key=lambda kv: -kv[1])[:15]:
        ka, kb = root_alive.get(ra), root_alive.get(rb)
        if ka and kb:
            linked = kb in adj[ka]
            top_cochange.append({"a": ka, "b": kb, "weight": round(w, 3), "times": len(contrib[(ra, rb)]),
                                 "static_link": linked})

    # ------------------------------------------------------------- surprising connections
    big = {c["id"] for c in communities if c["size"] >= 4}
    surprising = []
    for src, dst, typ, w, s, f in alive_edges:
        if typ not in ("calls", "inherits"):
            continue
        ca, cb = community.get(src, -1), community.get(dst, -1)
        if ca == cb or ca not in big or cb not in big:
            continue
        surprising.append({"a": src, "b": dst, "type": typ, "ca": ca, "cb": cb,
                           "score": pr.get(src, 0) * pr.get(dst, 0)})
    surprising.sort(key=lambda x: -x["score"])
    seen_pairs = set()
    surprising_out = []
    for s_ in surprising:
        key = (min(s_["ca"], s_["cb"]), max(s_["ca"], s_["cb"]))
        if key in seen_pairs:
            continue
        seen_pairs.add(key)
        surprising_out.append(s_)
        if len(surprising_out) >= 10:
            break

    # ------------------------------------------------------------- growth series (sweep)
    node_delta = {k: [0] * (T + 1) for k in KINDS}
    edge_delta = {k: [0] * (T + 1) for k in STRUCT_TYPES}
    born = [0] * (T + 1)
    died = [0] * (T + 1)
    for n in nodes:
        node_delta[n["kind"]][n["s"]] += 1
        if n["f"] is not None:
            node_delta[n["kind"]][n["f"]] -= 1
    for src, dst, typ, w, s, f in edges:
        edge_delta[typ][s] += 1
        if s > 0:
            born[s] += 1
        if f is not None:
            edge_delta[typ][f] -= 1
            died[f] += 1
    first_seen: dict[tuple[str, str], int] = {pair: terms[0][0] for pair, terms in contrib.items()}
    cc_new = [0] * (T + 1)
    for t in first_seen.values():
        cc_new[t] += 1
    growth = []
    acc_n = {k: 0 for k in KINDS}
    acc_e = {k: 0 for k in STRUCT_TYPES}
    acc_cc = 0
    for t in range(T):
        for k in KINDS:
            acc_n[k] += node_delta[k][t]
        for k in STRUCT_TYPES:
            acc_e[k] += edge_delta[k][t]
        acc_cc += cc_new[t]
        growth.append({"t": t, "ts": commits[t].ts, **{f"n_{k}": acc_n[k] for k in KINDS},
                       **{f"e_{k}": acc_e[k] for k in STRUCT_TYPES}, "e_cochange": acc_cc,
                       "born": born[t], "died": died[t], "delta": res.n_delta[t] if t < len(res.n_delta) else 0})

    # ------------------------------------------------------------- edge lifetimes
    buckets = [(1, 1), (2, 2), (3, 5), (6, 10), (11, 25), (26, 50), (51, 100), (101, 10**9)]
    labels = ["1", "2", "3–5", "6–10", "11–25", "26–50", "51–100", "100+"]
    life_hist = {lab: {"closed": 0, "open": 0} for lab in labels}
    life_by_type: dict[str, list[int]] = defaultdict(list)
    born_in_window = survived = 0
    for src, dst, typ, w, s, f in edges:
        if s == 0 or typ == "contains":
            continue
        born_in_window += 1
        life = (f if f is not None else T) - s
        status = "closed" if f is not None else "open"
        if f is None:
            survived += 1
        else:
            life_by_type[typ].append(life)
        for (lo, hi), lab in zip(buckets, labels):
            if lo <= life <= hi:
                life_hist[lab][status] += 1
                break
    lifetimes = {
        "histogram": [{"bucket": lab, **life_hist[lab]} for lab in labels],
        "median_closed": {t: (sorted(v)[len(v) // 2] if v else None) for t, v in life_by_type.items()},
        "born_in_window": born_in_window,
        "survival_rate": round(survived / born_in_window, 3) if born_in_window else None,
    }

    # ------------------------------------------------------------- hotspots
    hot_files = sorted((n for n in alive_nodes if n["kind"] == "file"), key=lambda n: -fprior.get(n["root"], 0))[:12]
    hotspots_files = [{"key": n["key"], "prior": round(fprior.get(n["root"], 0), 3),
                       "changes": fcounts.get(n["root"], 0), "lang": n["lang"]} for n in hot_files
                      if fprior.get(n["root"], 0) > 0]
    hot_syms = sorted(sym_alive, key=lambda n: -prior.get(n["root"], 0))[:12]
    hotspots_symbols = [{"key": n["key"], "name": n["name"], "kind": n["kind"], "path": n["path"],
                         "prior": round(prior.get(n["root"], 0), 3), "changes": counts.get(n["root"], 0)}
                        for n in hot_syms if prior.get(n["root"], 0) > 0]

    # ------------------------------------------------------------- activity & contributors
    by_day = Counter()
    punch = Counter()
    for c in commits:
        dt = datetime.fromtimestamp(c.ts, tz=timezone.utc)
        by_day[dt.strftime("%Y-%m-%d")] += 1
        punch[(dt.weekday(), dt.hour)] += 1
    authors: dict[str, dict] = {}
    delta_by_t = Counter(r[0] for r in sym_rows)
    for i, c in enumerate(commits):
        a = authors.setdefault(c.author, {"name": c.author, "email": c.email, "commits": 0, "insertions": 0,
                                          "deletions": 0, "symbols": 0, "first": c.ts, "last": c.ts})
        a["commits"] += 1
        a["insertions"] += c.insertions
        a["deletions"] += c.deletions
        a["symbols"] += delta_by_t.get(i, 0) if i > 0 else 0
        a["first"] = min(a["first"], c.ts)
        a["last"] = max(a["last"], c.ts)
    contributors = sorted(authors.values(), key=lambda a: -a["commits"])

    # ------------------------------------------------------------- KPIs
    lang_files = Counter(LANG_LABEL.get(n["lang"], n["lang"]) for n in alive_nodes if n["kind"] == "file")
    lang_syms = Counter(LANG_LABEL.get(n["lang"], n["lang"]) for n in sym_alive)
    g0, gT = growth[0], growth[-1]

    def nsym(g):
        return g["n_class"] + g["n_function"] + g["n_method"]

    def nedge(g):
        return g["e_calls"] + g["e_imports"] + g["e_inherits"]

    kpis = {
        "commits": T,
        "span_days": round((commits[-1].ts - commits[0].ts) / 86400, 1) if T > 1 else 0,
        "first_ts": commits[0].ts, "last_ts": commits[-1].ts,
        "files": gT["n_file"], "files_delta": gT["n_file"] - g0["n_file"],
        "symbols": nsym(gT), "symbols_delta": nsym(gT) - nsym(g0),
        "edges": nedge(gT), "edges_delta": nedge(gT) - nedge(g0),
        "contains": gT["e_contains"],
        "cochange_pairs": len(w_cc), "cochange_strong": sum(1 for terms in contrib.values() if len(terms) >= 3),
        "communities": sum(1 for c in communities if c["size"] >= 3),
        "contributors": len(authors),
        "languages": len(lang_files),
        "edges_opened": sum(born), "edges_closed": sum(died),
        "nodes_ever": len({n["key"] for n in nodes}),
        "changed_commits": sum(1 for d in res.n_delta[1:] if d > 0),
        "insertions": sum(c.insertions for c in commits[1:]),
        "deletions": sum(c.deletions for c in commits[1:]),
        "hidden_share": round(len(hidden_sym) / strong_pairs, 3) if strong_pairs else None,
    }

    biggest = sorted(range(1, T), key=lambda t: -(res.n_delta[t] if t < len(res.n_delta) else 0))[:8]
    biggest_commits = [{"t": t, "sha": commits[t].sha, "msg": commits[t].msg, "author": commits[t].author,
                        "delta": res.n_delta[t]} for t in biggest if res.n_delta[t] > 0]

    questions = []
    if god_nodes:
        g = max(god_nodes, key=lambda x: x["callers"])
        questions.append(f"What breaks if `{g['qual'] or g['name']}` changes? It has {g['callers']} direct callers.")
    hf = [h for h in hidden_files if not h["aux"]] or hidden_files
    if hf:
        h = hf[0]
        questions.append(f"Why do `{h['a']}` and `{h['b']}` keep changing together ({h['times']}×) with no import between them?")
    if hotspots_symbols:
        h = hotspots_symbols[0]
        questions.append(f"Is `{h['name']}` ({h['changes']} recent changes) a design hotspot that should be split?")
    if surprising_out:
        s_ = surprising_out[0]
        questions.append(f"Should `{s_['a'].split('::')[-1]}` really depend on `{s_['b'].split('::')[-1]}` across module boundaries?")
    if lifetimes["survival_rate"] is not None:
        questions.append(f"Only {round(100 * lifetimes['survival_rate'])}% of call edges added in this window survive. Which parts of the API are still in flux?")

    return {
        "kpis": kpis,
        "growth": growth,
        "node_kinds": {k: gT[f"n_{k}"] for k in KINDS},
        "edge_types": {**{k: gT[f"e_{k}"] for k in STRUCT_TYPES}, "cochange": len(w_cc)},
        "languages": {"files": dict(lang_files), "symbols": dict(lang_syms)},
        "activity": {"by_day": dict(sorted(by_day.items())),
                     "punchcard": [{"dow": d, "hour": h, "count": c} for (d, h), c in sorted(punch.items())]},
        "contributors": contributors[:15],
        "hotspots": {"files": hotspots_files, "symbols": hotspots_symbols},
        "hidden_coupling": {"symbols": hidden_sym, "files": hidden_files},
        "top_cochange": top_cochange,
        "god_nodes": god_nodes,
        "communities": communities,
        "degree_distribution": degree_distribution,
        "lifetimes": lifetimes,
        "surprising": surprising_out,
        "biggest_commits": biggest_commits,
        "questions": questions,
        "params": {"lambda": lam, "K": K},
        "_cochange_contrib": contrib,  # stripped before storing as JSON
    }
