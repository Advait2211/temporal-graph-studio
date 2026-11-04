"""End-to-end build job: GitHub metadata → clone → TCG walk → analysis → SQLite."""

from __future__ import annotations

from dataclasses import dataclass, field
import shutil
import threading
import time
import traceback
import uuid
from pathlib import Path

from . import analysis, github, gitio, store
from .builder import Builder

# overall progress weights per stage (sum = 1)
STAGES = [
    ("meta", "GitHub metadata", 0.02),
    ("clone", "Clone", 0.22),
    ("snapshot", "Base snapshot", 0.12),
    ("resolve", "Resolve names", 0.06),
    ("walk", "Walk history", 0.40),
    ("signals", "History signals", 0.06),
    ("communities", "Communities", 0.06),
    ("store", "Write store", 0.06),
]
STAGE_INDEX = {s[0]: i for i, s in enumerate(STAGES)}


@dataclass
class Job:
    id: str
    source: dict
    depth: int
    refresh: bool = False
    state: str = "queued"  # queued | running | done | error
    stage: str = "meta"
    stage_frac: float = 0.0
    message: str = ""
    counters: dict = field(default_factory=dict)
    error: str | None = None
    started: float = field(default_factory=time.time)
    finished: float | None = None
    log: list[str] = field(default_factory=list)
    version: int = 0
    cancel: bool = False

    @property
    def progress(self) -> float:
        i = STAGE_INDEX.get(self.stage, 0)
        done = sum(w for _, _, w in STAGES[:i])
        return min(1.0, done + STAGES[i][2] * self.stage_frac) if self.state != "done" else 1.0

    def update(self, stage: str | None = None, frac: float | None = None, message: str | None = None,
               counters: dict | None = None) -> None:
        if stage:
            if stage != self.stage:
                self.stage_frac = 0.0
            self.stage = stage
        if frac is not None:
            self.stage_frac = max(0.0, min(1.0, frac))
        if message:
            self.message = message
            self.log.append(message)
            self.log = self.log[-60:]
        if counters:
            self.counters.update(counters)
        self.version += 1

    def snapshot(self) -> dict:
        return {
            "id": self.id, "repo_id": self.source["id"], "name": self.source["name"], "state": self.state,
            "stage": self.stage, "stage_frac": round(self.stage_frac, 4), "progress": round(self.progress, 4),
            "message": self.message, "counters": self.counters, "error": self.error,
            "elapsed": round((self.finished or time.time()) - self.started, 1), "log": self.log[-14:],
            "stages": [{"id": s, "label": lab} for s, lab, _ in STAGES],
        }


JOBS: dict[str, Job] = {}


def start(source_text: str, depth: int, refresh: bool) -> Job:
    source = github.parse_source(source_text)
    for j in JOBS.values():
        if j.source["id"] == source["id"] and j.state in ("queued", "running"):
            return j
    job = Job(id=uuid.uuid4().hex[:12], source=source, depth=max(10, min(depth, 3000)), refresh=refresh)
    JOBS[job.id] = job
    threading.Thread(target=_run, args=(job,), daemon=True).start()
    return job


def _run(job: Job) -> None:
    job.state = "running"
    src = job.source
    try:
        # ---- metadata
        meta: dict = {}
        if src["kind"] == "github":
            job.update("meta", 0.1, f"Fetching github.com/{src['owner']}/{src['repo']}")
            meta = github.fetch_meta(src["owner"], src["repo"])
        job.update("meta", 1.0, counters={"stars": meta.get("stars"), "forks": meta.get("forks")})

        # ---- clone
        if src["kind"] == "github":
            dest = store.REPO_DIR / src["id"]
            if dest.exists() and (job.refresh or not (dest / ".git").exists()):
                shutil.rmtree(dest)
            if dest.exists():
                job.update("clone", 1.0, "Using cached clone")
            else:
                job.update("clone", 0.0, f"git clone --depth {job.depth} {src['url']}")
                gitio.clone(src["url"], dest, job.depth,
                            lambda f, line: job.update("clone", f, line if job.version % 8 == 0 else None))
                job.update("clone", 1.0, "Clone complete")
        else:
            dest = Path(src["path"])
            job.update("clone", 1.0, f"Using local repository {dest}")

        # ---- walk
        def on_prog(e: dict) -> None:
            job.update(e.get("stage"), e.get("frac"), e.get("message"), e.get("counters"))

        builder = Builder(dest, on_prog, lambda: job.cancel)
        res = builder.build(job.depth)

        # ---- analysis
        job.update("signals", 0.3, "Co-change weights and change priors (λ = 60 commits)")
        job.update("communities", 0.2, "Louvain communities on the union graph")
        stats = analysis.analyze(res)
        contrib = stats.pop("_cochange_contrib")
        job.update("communities", 1.0, f"{stats['kpis']['communities']} communities",
                   counters={"cochange": stats["kpis"]["cochange_pairs"], "communities": stats["kpis"]["communities"]})

        # ---- store
        job.update("store", 0.1, "Writing interval store")
        _write(src, dest, job.depth, meta, res, stats, contrib)
        job.update("store", 1.0, "Done")
        job.state = "done"
    except Exception as e:  # surfaced to the UI
        job.error = str(e) or e.__class__.__name__
        job.state = "error"
        job.log.append(traceback.format_exc(limit=3))
    finally:
        job.finished = time.time()
        job.version += 1


def _write(src: dict, repo_dir: Path, depth: int, meta: dict, res, stats: dict, contrib: dict) -> None:
    conn = store.connect(src["id"] + ".tmp", fresh=True)
    try:
        conn.executemany(
            "INSERT INTO commits VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            [(i, c.sha, c.parent, c.author, c.email, c.ts, c.msg, len(c.changes), c.insertions, c.deletions,
              res.n_delta[i] if i < len(res.n_delta) else 0, res.code_files[i] if i < len(res.code_files) else 0)
             for i, c in enumerate(res.commits)],
        )
        conn.executemany(
            "INSERT INTO nodes(key, root, kind, name, qual, path, lang, start, end_line, sig, doc, is_test, s, f,"
            " community, pagerank) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [(n["key"], n["root"], n["kind"], n["name"], n["qual"], n["path"], n["lang"], n["start"], n["end_line"],
              n["sig"], n["doc"], n["is_test"], n["s"], n["f"], n.get("community", -1), n.get("pagerank", 0.0))
             for n in res.nodes],
        )
        conn.executemany("INSERT INTO edges(src, dst, type, weight, s, f) VALUES (?,?,?,?,?,?)", res.edges)
        conn.executemany("INSERT INTO changes VALUES (?,?,?,?,?)", res.changes)
        # co-change contributions, pruned to pairs that matter (kept as JSON: they are read whole)
        ranked = sorted(contrib.items(), key=lambda kv: -sum(n for _, n in kv[1]))
        kept = [[a, b, terms] for (a, b), terms in ranked if len(terms) >= 2 or sum(n for _, n in terms) >= 0.5][:6000]
        store.set_meta(conn, "cochange", kept)
        store.set_meta(conn, "repo", {**src, "repo_dir": str(repo_dir), "depth": depth,
                                      "built_at": time.time(), "timings": res.timings})
        store.set_meta(conn, "github", meta)
        store.set_meta(conn, "stats", stats)
        conn.commit()
    finally:
        conn.close()
    store.db_path(src["id"] + ".tmp").replace(store.db_path(src["id"]))
