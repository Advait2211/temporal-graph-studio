"""Thin, fast wrappers over the git CLI."""

from __future__ import annotations

from dataclasses import dataclass, field
import re
import subprocess
import threading
from pathlib import Path
from typing import Callable

_HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def git(repo: Path | str, *args: str, check: bool = True) -> str:
    res = subprocess.run(
        ["git", "-c", "core.quotePath=false", "-C", str(repo), *args],
        capture_output=True,
        check=False,
    )
    if check and res.returncode != 0:
        raise RuntimeError(res.stderr.decode("utf-8", "replace").strip() or f"git {' '.join(args)} failed")
    return res.stdout.decode("utf-8", "replace")


def clone(url: str, dest: Path, depth: int, on_progress: Callable[[float, str], None] | None = None) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(
        ["git", "clone", "--progress", "--single-branch", "--no-tags", "--depth", str(depth), url, str(dest)],
        stderr=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
    )
    assert proc.stderr is not None
    buf = b""
    tail = ""
    pct = re.compile(r"(Receiving objects|Resolving deltas|Counting objects|Compressing objects):\s+(\d+)%")
    weights = {"Counting objects": (0.0, 0.05), "Compressing objects": (0.05, 0.1),
               "Receiving objects": (0.1, 0.85), "Resolving deltas": (0.85, 1.0)}
    while True:
        ch = proc.stderr.read(1)
        if not ch:
            break
        if ch in (b"\r", b"\n"):
            line = buf.decode("utf-8", "replace")
            buf = b""
            tail = line or tail
            m = pct.search(line)
            if m and on_progress:
                lo, hi = weights[m.group(1)]
                on_progress(lo + (hi - lo) * int(m.group(2)) / 100.0, line.strip())
        else:
            buf += ch
    if proc.wait() != 0:
        raise RuntimeError(f"git clone failed: {tail.strip()}")


@dataclass
class Commit:
    sha: str
    parent: str | None
    author: str
    email: str
    ts: int
    msg: str
    changes: list[tuple[str, str | None, str | None]] = field(default_factory=list)  # (status, old, new)
    insertions: int = 0
    deletions: int = 0


def first_parent_log(repo: Path, limit: int) -> list[Commit]:
    """The last `limit` commits on the first-parent chain, oldest first, with name-status vs first parent."""
    out = git(
        repo, "log", "--first-parent", "--diff-merges=first-parent", "-M", "--name-status",
        f"-n{limit}", "--format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s",
    )
    commits: list[Commit] = []
    for block in out.split("\x1e"):
        if not block.strip():
            continue
        header, _, body = block.partition("\n")
        sha, parents, an, ae, at, subj = (header.split("\x1f") + [""] * 6)[:6]
        parent = parents.split()[0] if parents.strip() else None
        c = Commit(sha, parent, an, ae, int(at or 0), subj)
        for line in body.splitlines():
            if not line.strip():
                continue
            parts = line.split("\t")
            st = parts[0][:1]
            if st in ("R", "C") and len(parts) >= 3:
                c.changes.append((st if st == "R" else "A", parts[1] if st == "R" else None, parts[2]))
            elif st == "A" and len(parts) >= 2:
                c.changes.append(("A", None, parts[1]))
            elif st == "D" and len(parts) >= 2:
                c.changes.append(("D", parts[1], None))
            elif st in ("M", "T") and len(parts) >= 2:
                c.changes.append(("M", parts[1], parts[1]))
        commits.append(c)
    commits.reverse()
    # shortstat in a second pass (git can't combine it with name-status)
    stat = git(repo, "log", "--first-parent", "--diff-merges=first-parent", "--shortstat",
               f"-n{limit}", "--format=%x1e%H", check=False)
    by_sha = {c.sha: c for c in commits}
    ins_re, del_re = re.compile(r"(\d+) insertion"), re.compile(r"(\d+) deletion")
    for block in stat.split("\x1e"):
        block = block.strip()
        if not block:
            continue
        sha, _, rest = block.partition("\n")
        c = by_sha.get(sha.strip())
        if c is None:
            continue
        m1, m2 = ins_re.search(rest), del_re.search(rest)
        c.insertions = int(m1.group(1)) if m1 else 0
        c.deletions = int(m2.group(1)) if m2 else 0
    return commits


def ls_tree(repo: Path, sha: str) -> list[str]:
    return [p for p in git(repo, "ls-tree", "-r", "--name-only", "-z", sha).split("\0") if p]


Hunk = tuple[int, int, int, int]  # old_start, old_len, new_start, new_len


def diff_hunks(repo: Path, parent: str, sha: str, paths: list[str]) -> dict[str, list[Hunk]]:
    """Zero-context hunks per file (keyed by new path, or old path for deletions)."""
    if not paths:
        return {}
    out = git(repo, "diff", "-U0", "-M", "--no-color", "--no-ext-diff", parent, sha, "--", *paths, check=False)
    hunks: dict[str, list[Hunk]] = {}
    old_path = new_path = None
    for line in out.splitlines():
        if line.startswith("diff --git "):
            old_path = new_path = None
        elif line.startswith("--- "):
            old_path = line[6:] if line.startswith("--- a/") else None
        elif line.startswith("+++ "):
            new_path = line[6:] if line.startswith("+++ b/") else None
        elif line.startswith("@@"):
            m = _HUNK.match(line)
            if m:
                key = new_path or old_path
                if key is None:
                    continue
                os_, ol = int(m.group(1)), int(m.group(2)) if m.group(2) is not None else 1
                ns_, nl = int(m.group(3)), int(m.group(4)) if m.group(4) is not None else 1
                hunks.setdefault(key, []).append((os_, ol, ns_, nl))
    return hunks


class BlobReader:
    """One long-lived `git cat-file --batch` process for fast blob reads."""

    def __init__(self, repo: Path):
        self.proc = subprocess.Popen(
            ["git", "-C", str(repo), "cat-file", "--batch"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        self.lock = threading.Lock()

    def read(self, sha: str, path: str) -> bytes | None:
        assert self.proc.stdin and self.proc.stdout
        with self.lock:
            self.proc.stdin.write(f"{sha}:{path}\n".encode())
            self.proc.stdin.flush()
            header = self.proc.stdout.readline().decode()
            if header.endswith("missing\n") or not header.strip():
                return None
            parts = header.split()
            if len(parts) < 3:
                return None
            size = int(parts[2])
            data = self.proc.stdout.read(size)
            self.proc.stdout.read(1)  # trailing newline
            return data if parts[1] == "blob" else None

    def close(self) -> None:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
            self.proc.wait(timeout=2)
        except Exception:
            self.proc.kill()
