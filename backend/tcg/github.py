"""GitHub URL parsing and repository metadata (REST API, unauthenticated unless GITHUB_TOKEN is set)."""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import httpx

_GH = re.compile(r"^(?:https?://)?(?:www\.)?github\.com[/:]([\w.-]+)/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$")
_SHORT = re.compile(r"^([\w.-]+)/([\w.-]+)$")


def parse_source(text: str) -> dict:
    """Returns {kind: github|local, owner, repo, id, url|path} or raises ValueError."""
    s = text.strip()
    m = _GH.match(s) or (_SHORT.match(s) if not s.startswith((".", "/", "~")) else None)
    if m:
        owner, repo = m.group(1), m.group(2)
        return {
            "kind": "github",
            "owner": owner,
            "repo": repo,
            "id": f"{owner}__{repo}".lower(),
            "url": f"https://github.com/{owner}/{repo}.git",
            "name": f"{owner}/{repo}",
        }
    if s.startswith(("/", "~", ".")) or os.sep in s:
        return _local_source(s)
    raise ValueError("Enter a GitHub URL (github.com/owner/repo), owner/repo, or the full path of a local git repository")


def _local_source(s: str) -> dict:
    """A local path: any folder inside a git repository with at least one commit."""
    p = Path(os.path.expanduser(s)).resolve()
    if not p.exists():
        raise ValueError(f"No such folder: {p}")
    if not p.is_dir():
        raise ValueError(f"{p} is a file. Enter the folder of a git repository.")
    top = subprocess.run(["git", "-C", str(p), "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    if top.returncode != 0:
        raise ValueError(
            f"{p} is not inside a git repository. TCG Studio builds the graph from commit history, so run "
            f"`git init && git add -A && git commit -m \"Initial commit\"` in that folder first."
        )
    root = Path(top.stdout.strip())
    head = subprocess.run(["git", "-C", str(root), "rev-parse", "--verify", "HEAD"], capture_output=True, text=True)
    if head.returncode != 0:
        raise ValueError(f"{root} is a git repository with no commits yet. Make a first commit, then build again.")
    name = root.name
    return {"kind": "local", "owner": "local", "repo": name, "id": f"local__{name}".lower(),
            "path": str(root), "name": name, "subdir": str(p.relative_to(root)) if p != root else ""}


def fetch_meta(owner: str, repo: str) -> dict:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "tcg-studio"}
    tok = os.environ.get("GITHUB_TOKEN")
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    meta: dict = {}
    try:
        with httpx.Client(base_url="https://api.github.com", headers=headers, timeout=8.0) as c:
            r = c.get(f"/repos/{owner}/{repo}")
            if r.status_code == 200:
                j = r.json()
                meta = {
                    "full_name": j.get("full_name"),
                    "description": j.get("description"),
                    "stars": j.get("stargazers_count"),
                    "forks": j.get("forks_count"),
                    "watchers": j.get("subscribers_count"),
                    "open_issues": j.get("open_issues_count"),
                    "default_branch": j.get("default_branch"),
                    "license": (j.get("license") or {}).get("spdx_id"),
                    "topics": j.get("topics") or [],
                    "homepage": j.get("homepage"),
                    "created_at": j.get("created_at"),
                    "pushed_at": j.get("pushed_at"),
                    "avatar": (j.get("owner") or {}).get("avatar_url"),
                    "html_url": j.get("html_url"),
                    "size_kb": j.get("size"),
                }
            elif r.status_code == 404:
                raise ValueError(f"github.com/{owner}/{repo} was not found (or is private)")
            r = c.get(f"/repos/{owner}/{repo}/languages")
            if r.status_code == 200:
                meta["languages"] = r.json()
            r = c.get(f"/repos/{owner}/{repo}/contributors", params={"per_page": 12})
            if r.status_code == 200:
                meta["contributors"] = [
                    {"login": u.get("login"), "avatar": u.get("avatar_url"), "contributions": u.get("contributions")}
                    for u in r.json() if isinstance(u, dict)
                ]
    except httpx.HTTPError:
        pass
    return meta
