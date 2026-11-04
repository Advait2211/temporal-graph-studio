"""GitHub URL parsing and repository metadata (REST API, unauthenticated unless GITHUB_TOKEN is set)."""

from __future__ import annotations

import os
import re
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
    p = Path(os.path.expanduser(s))
    if p.is_dir() and (p / ".git").exists():
        name = p.resolve().name
        return {"kind": "local", "owner": "local", "repo": name, "id": f"local__{name}".lower(),
                "path": str(p.resolve()), "name": name}
    raise ValueError("Enter a GitHub URL (github.com/owner/repo), owner/repo, or a local git repository path")


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
