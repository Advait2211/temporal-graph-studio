"""HTTP API for TCG Studio."""

from __future__ import annotations

import asyncio
import json
import math
from collections import defaultdict
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel, Field

from . import gitio, history, pipeline, report, retrieve, store
from .parse import parse_file

app = FastAPI(title="TCG Studio", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

EDGE_TYPES = ["contains", "imports", "calls", "inherits"]


def _conn(repo_id: str):
    if not store.db_path(repo_id).exists():
        raise HTTPException(404, f"No graph built for {repo_id}")
    return store.connect(repo_id)


# ---------------------------------------------------------------------------- builds


class BuildReq(BaseModel):
    source: str
    depth: int = Field(300, ge=10, le=3000)
    refresh: bool = False


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/builds")
def create_build(req: BuildReq):
    try:
        job = pipeline.start(req.source, req.depth, req.refresh)
    except ValueError as e:
        raise HTTPException(400, str(e))
    retrieve.invalidate(job.source["id"])
    return job.snapshot()


@app.get("/api/builds/{job_id}")
def get_build(job_id: str):
    job = pipeline.JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown build")
    return job.snapshot()


@app.post("/api/builds/{job_id}/cancel")
def cancel_build(job_id: str):
    job = pipeline.JOBS.get(job_id)
    if job:
        job.cancel = True
    return {"ok": True}


@app.get("/api/builds/{job_id}/events")
async def build_events(job_id: str):
    job = pipeline.JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown build")

    async def stream():
        seen = -1
        while True:
            if job.version != seen:
                seen = job.version
                yield f"data: {json.dumps(job.snapshot())}\n\n"
            if job.state in ("done", "error") and seen == job.version:
                break
            await asyncio.sleep(0.15)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------------------- repos


def _card(repo_id: str) -> dict | None:
    try:
        conn = store.connect(repo_id)
    except Exception:
        return None
    try:
        repo = store.get_meta(conn, "repo")
        if not repo:
            return None
        gh = store.get_meta(conn, "github", {}) or {}
        stats = store.get_meta(conn, "stats", {}) or {}
    finally:
        conn.close()
    growth = stats.get("growth", [])
    step = max(1, len(growth) // 40)
    spark = [g["n_class"] + g["n_function"] + g["n_method"] for g in growth[::step]]
    return {
        "id": repo_id, "name": repo["name"], "kind": repo["kind"], "built_at": repo.get("built_at"),
        "depth": repo.get("depth"), "description": gh.get("description"), "stars": gh.get("stars"),
        "forks": gh.get("forks"), "avatar": gh.get("avatar"), "languages": stats.get("languages", {}).get("files", {}),
        "kpis": stats.get("kpis", {}), "spark": spark, "timings": repo.get("timings"),
    }


@app.get("/api/repos")
def list_repos():
    cards = [c for c in (_card(r) for r in store.list_repo_ids()) if c]
    cards.sort(key=lambda c: -(c.get("built_at") or 0))
    running = [j.snapshot() for j in pipeline.JOBS.values() if j.state in ("queued", "running")]
    return {"repos": cards, "running": running}


@app.get("/api/repos/{repo_id}")
def get_repo(repo_id: str):
    card = _card(repo_id)
    if not card:
        raise HTTPException(404, "Not found")
    conn = _conn(repo_id)
    try:
        card["github"] = store.get_meta(conn, "github", {})
    finally:
        conn.close()
    return card


@app.delete("/api/repos/{repo_id}")
def delete_repo(repo_id: str):
    p = store.db_path(repo_id)
    if p.exists():
        p.unlink()
    retrieve.invalidate(repo_id)
    return {"ok": True}


@app.get("/api/repos/{repo_id}/stats")
def get_stats(repo_id: str):
    conn = _conn(repo_id)
    try:
        return {"stats": store.get_meta(conn, "stats"), "github": store.get_meta(conn, "github", {}),
                "repo": store.get_meta(conn, "repo")}
    finally:
        conn.close()


@app.get("/api/repos/{repo_id}/temporal")
def get_temporal(repo_id: str):
    """The whole temporal graph in one payload; the client filters to G_τ while scrubbing."""
    conn = _conn(repo_id)
    try:
        T = conn.execute("SELECT COUNT(*) FROM commits").fetchone()[0]
        commits = [{"i": r["idx"], "sha": r["sha"], "ts": r["ts"], "author": r["author"], "msg": r["msg"],
                    "delta": r["n_delta"], "ins": r["ins"], "del": r["del"], "files": r["files"]}
                   for r in conn.execute("SELECT * FROM commits ORDER BY idx")]
        nodes: dict[str, dict] = {}
        for r in conn.execute("SELECT * FROM nodes ORDER BY s"):
            n = nodes.get(r["key"])
            iv = [r["s"], r["f"] if r["f"] is not None else T]
            if n is None:
                nodes[r["key"]] = {"id": r["key"], "root": r["root"], "kind": r["kind"], "name": r["name"],
                                   "qual": r["qual"], "path": r["path"], "lang": r["lang"], "start": r["start"],
                                   "end": r["end_line"], "test": r["is_test"], "c": r["community"],
                                   "pr": round(r["pagerank"], 6), "iv": [iv]}
            else:
                n["iv"].append(iv)
                n.update(start=r["start"], end=r["end_line"], c=r["community"] if r["community"] >= 0 else n["c"])
        index = {k: i for i, k in enumerate(nodes)}
        grouped: dict[tuple[int, int, int], list] = {}
        for r in conn.execute("SELECT src, dst, type, weight, s, f FROM edges ORDER BY s"):
            si, di = index.get(r["src"]), index.get(r["dst"])
            if si is None or di is None:
                continue
            k = (si, di, EDGE_TYPES.index(r["type"]))
            iv = [r["s"], r["f"] if r["f"] is not None else T]
            g = grouped.get(k)
            if g is None:
                grouped[k] = [si, di, k[2], r["weight"], [iv]]
            else:
                g[3] = r["weight"]
                g[4].append(iv)
        deltas: dict[int, list[int]] = defaultdict(list)
        for r in conn.execute("SELECT t, key FROM changes WHERE level = 'sym'"):
            i = index.get(r["key"])
            if i is not None:
                deltas[r["t"]].append(i)
        stats = store.get_meta(conn, "stats", {})
        cc = store.get_meta(conn, "cochange", [])
        repo = store.get_meta(conn, "repo")
    finally:
        conn.close()
    payload = {
        "repo": repo, "T": T, "commits": commits, "nodes": list(nodes.values()), "edge_types": EDGE_TYPES,
        "edges": list(grouped.values()), "cochange": cc, "deltas": deltas,
        "communities": stats.get("communities", []), "lambda": stats.get("params", {}).get("lambda", 60),
    }
    return JSONResponse(payload)


@app.get("/api/repos/{repo_id}/commits/{idx}")
def get_commit(repo_id: str, idx: int):
    conn = _conn(repo_id)
    try:
        c = conn.execute("SELECT * FROM commits WHERE idx = ?", (idx,)).fetchone()
        if not c:
            raise HTTPException(404, "No such commit")
        changed = [dict(r) for r in conn.execute("SELECT key, path, level FROM changes WHERE t = ?", (idx,))]
        opened = conn.execute("SELECT src, dst, type FROM edges WHERE s = ? AND s > 0 AND type != 'contains' LIMIT 200",
                              (idx,)).fetchall()
        closed = conn.execute("SELECT src, dst, type FROM edges WHERE f = ? AND type != 'contains' LIMIT 200",
                              (idx,)).fetchall()
        born = conn.execute("SELECT key, kind FROM nodes WHERE s = ? AND s > 0 AND kind != 'file' LIMIT 200",
                            (idx,)).fetchall()
        died = conn.execute("SELECT key, kind FROM nodes WHERE f = ? AND kind != 'file' LIMIT 200", (idx,)).fetchall()
        repo = store.get_meta(conn, "repo")
    finally:
        conn.close()
    gh_url = None
    if repo and repo.get("kind") == "github":
        gh_url = f"https://github.com/{repo['owner']}/{repo['repo']}/commit/{c['sha']}"
    return {
        "commit": dict(c), "url": gh_url,
        "symbols": [r["key"] for r in changed if r["level"] == "sym"],
        "files": [r["key"] for r in changed if r["level"] == "file"],
        "edges_opened": [dict(r) for r in opened], "edges_closed": [dict(r) for r in closed],
        "nodes_born": [dict(r) for r in born], "nodes_died": [dict(r) for r in died],
    }


@app.get("/api/repos/{repo_id}/symbol")
def get_symbol(repo_id: str, key: str, tau: int | None = None):
    conn = _conn(repo_id)
    try:
        T = conn.execute("SELECT COUNT(*) FROM commits").fetchone()[0]
        tau = T - 1 if tau is None else max(0, min(tau, T - 1))
        rows = conn.execute("SELECT * FROM nodes WHERE key = ? ORDER BY s", (key,)).fetchall()
        if not rows:
            raise HTTPException(404, "Unknown symbol")
        root = rows[-1]["root"]
        hist = conn.execute(
            "SELECT c.t, c.key, k.sha, k.msg, k.author, k.ts FROM changes c JOIN commits k ON k.idx = c.t "
            "WHERE c.root = ? AND c.level = ? ORDER BY c.t DESC",
            (root, "file" if rows[-1]["kind"] == "file" else "sym")).fetchall()
        alive = store.ALIVE
        out_e = conn.execute(f"SELECT dst AS other, type, weight, s, f FROM edges WHERE src = :k AND {alive}",
                             {"k": key, "tau": tau}).fetchall()
        in_e = conn.execute(f"SELECT src AS other, type, weight, s, f FROM edges WHERE dst = :k AND {alive}",
                            {"k": key, "tau": tau}).fetchall()
        sym_rows = store.changes_upto(conn, tau, "file" if rows[-1]["kind"] == "file" else "sym")
        cc = store.get_meta(conn, "cochange", [])
        repo = store.get_meta(conn, "repo")
        sha = conn.execute("SELECT sha FROM commits WHERE idx = ?", (tau,)).fetchone()[0]
        lam = (store.get_meta(conn, "stats", {}) or {}).get("params", {}).get("lambda", history.DEFAULT_LAMBDA)
        root_key = {r["root"]: r["key"] for r in store.nodes_as_of(conn, tau)}
    finally:
        conn.close()
    my_t = sorted(int(r[0]) for r in sym_rows if r[2] == root)
    prior_series = []
    for t in range(0, tau + 1, max(1, (tau + 1) // 80)):
        prior_series.append({"t": t, "h": round(sum(math.exp(-(t - x) / lam) for x in my_t if x <= t), 4)})
    partners = []
    for a, b, terms in cc:
        if root in (a, b):
            other = b if a == root else a
            w = sum(n * math.exp(-(tau - t) / lam) for t, n in terms if t <= tau)
            if w > 0 and other in root_key:
                partners.append({"key": root_key[other], "weight": round(w, 3), "times": sum(1 for t, _ in terms if t <= tau)})
    partners.sort(key=lambda p: -p["weight"])
    r = rows[-1]
    code = None
    try:
        data = gitio.BlobReader(Path(repo["repo_dir"]))
        blob = data.read(sha, r["path"])
        data.close()
        if blob is not None:
            if r["kind"] == "file":
                code = "\n".join(blob.decode("utf-8", "replace").splitlines()[:120])
            else:
                facts = parse_file(r["path"], blob)
                d = facts.defs.get(r["qual"]) if facts else None
                if d:
                    code = "\n".join(blob.decode("utf-8", "replace").splitlines()[d.start - 1:min(d.end, d.start + 159)])
    except Exception:
        code = None
    return {
        "key": key, "kind": r["kind"], "name": r["name"], "qual": r["qual"], "path": r["path"], "lang": r["lang"],
        "start": r["start"], "end": r["end_line"], "sig": r["sig"], "doc": r["doc"], "community": r["community"],
        "pagerank": r["pagerank"], "intervals": [[x["s"], x["f"] if x["f"] is not None else T] for x in rows],
        "T": T, "tau": tau, "root": root,
        "history": [dict(h) for h in hist[:60]], "changes": len(hist),
        "out": [dict(e) for e in out_e], "in": [dict(e) for e in in_e],
        "cochange": partners[:12], "prior_series": prior_series,
        "prior": prior_series[-1]["h"] if prior_series else 0, "code": code,
    }


class RetrieveReq(BaseModel):
    issue: str
    tau: int | None = None
    budget: int = Field(4000, ge=256, le=64000)
    params: dict = Field(default_factory=dict)


@app.post("/api/repos/{repo_id}/retrieve")
def do_retrieve(repo_id: str, req: RetrieveReq):
    _conn(repo_id).close()
    if not req.issue.strip():
        raise HTTPException(400, "Paste an issue, a question, or a stack trace")
    return retrieve.retrieve(repo_id, req.issue, req.tau, req.budget, req.params)


@app.get("/api/repos/{repo_id}/export/report.md")
def export_report(repo_id: str):
    conn = _conn(repo_id)
    try:
        md = report.markdown(store.get_meta(conn, "repo"), store.get_meta(conn, "github", {}) or {},
                             store.get_meta(conn, "stats"))
    finally:
        conn.close()
    return PlainTextResponse(md, media_type="text/markdown",
                             headers={"Content-Disposition": f'attachment; filename="{repo_id}-REPORT.md"'})


@app.get("/api/repos/{repo_id}/report")
def get_report(repo_id: str):
    conn = _conn(repo_id)
    try:
        md = report.markdown(store.get_meta(conn, "repo"), store.get_meta(conn, "github", {}) or {},
                             store.get_meta(conn, "stats"))
    finally:
        conn.close()
    return {"markdown": md}


@app.get("/api/repos/{repo_id}/export/graph.json")
def export_graph(repo_id: str):
    data = get_temporal(repo_id)
    return JSONResponse(json.loads(data.body), headers={
        "Content-Disposition": f'attachment; filename="{repo_id}-graph.json"'})
