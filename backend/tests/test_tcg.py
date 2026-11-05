"""Tests on the proposal's toy repository (checkout / total / tax / round_cents) across three commits."""

from __future__ import annotations

import math
import subprocess
from pathlib import Path

import pytest

from tcg import history
from tcg.builder import Builder, defs_touched
from tcg.parse import parse_file

C1 = {
    "api.py": "from billing import total\n\ndef checkout(items):\n    return total(items)\n",
    "billing.py": "from tax import tax\n\nclass Invoice:\n    pass\n\ndef total(items):\n    s = sum(items)\n    return s + tax(s)\n",
    "tax.py": "def tax(x):\n    return x * 0.2\n",
}
# c2: adds round_cents(), called by tax(); total() and tax() edited together
C2 = {
    **C1,
    "billing.py": "from tax import tax\n\nclass Invoice:\n    pass\n\ndef total(items):\n    s = sum(items) * 1.0\n    return s + tax(s)\n",
    "tax.py": "def round_cents(x):\n    return round(x, 2)\n\ndef tax(x):\n    return round_cents(x * 0.2)\n",
}
# c3: total() calls round_cents() directly; the total -> tax call edge closes
C3 = {
    **C2,
    "billing.py": "from tax import round_cents\n\nclass Invoice:\n    pass\n\ndef total(items):\n    s = sum(items) * 1.2\n    return round_cents(s)\n",
    "tax.py": "def round_cents(x):\n    return round(x, 2)\n\ndef tax(x):\n    return round_cents(x * 0.25)\n",
}


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


@pytest.fixture(scope="module")
def toy(tmp_path_factory) -> Path:
    repo = tmp_path_factory.mktemp("toy")
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@example.com")
    _git(repo, "config", "user.name", "Test")
    for i, snap in enumerate([C1, C2, C3], 1):
        for name, body in snap.items():
            (repo / name).write_text(body)
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", f"c{i}")
    return repo


@pytest.fixture(scope="module")
def built(toy):
    return Builder(toy).build(50)


def _edge(res, src, dst, typ):
    return [e for e in res.edges if e[0] == src and e[1] == dst and e[2] == typ]


def test_parse_extracts_defs_and_calls():
    f = parse_file("billing.py", C1["billing.py"].encode())
    assert set(f.defs) == {"Invoice", "total"}
    assert any(r.name == "tax" and r.src == "total" for r in f.refs)


def test_defs_touched_innermost():
    f = parse_file("tax.py", C2["tax.py"].encode())
    assert defs_touched(f, 5, 5) == {"tax"}
    assert defs_touched(f, 1, 2) == {"round_cents"}


def test_intervals_open_and_close(built):
    # total -> tax holds over [c0, c2): opened at the snapshot, closed by c3 (index 2)
    e = _edge(built, "billing.py::total", "tax.py::tax", "calls")
    assert len(e) == 1 and e[0][4] == 0 and e[0][5] == 2
    # tax -> round_cents opens at c2 (index 1) and is still open
    e = _edge(built, "tax.py::tax", "tax.py::round_cents", "calls")
    assert len(e) == 1 and e[0][4] == 1 and e[0][5] is None
    # total -> round_cents opens at c3 (index 2)
    e = _edge(built, "billing.py::total", "tax.py::round_cents", "calls")
    assert len(e) == 1 and e[0][4] == 2 and e[0][5] is None
    # round_cents() is born at c2
    n = [n for n in built.nodes if n["key"] == "tax.py::round_cents"]
    assert n and n[0]["s"] == 1 and n[0]["f"] is None


def test_delta_and_cochange_weights(built):
    D = history.deltas([c for c in built.changes if c[4] == "sym"])
    assert D[1] == {"billing.py::total", "tax.py::tax", "tax.py::round_cents"}
    contrib = history.cochange_contributions(D)
    lam = 60.0
    w = history.cochange_weights(contrib, 2, lam)
    # |Δ1| = 3 (total, tax, round_cents), so each pair's c2 term is 1 / (3 - 1) = 0.5
    terms = contrib[("billing.py::total", "tax.py::tax")]
    expected = sum(n * math.exp(-(2 - t) / lam) for t, n in terms)
    assert w[("billing.py::total", "tax.py::tax")] == pytest.approx(expected)
    assert terms[0] == (1, 0.5)


def test_prior_matches_formula(built):
    D = history.deltas([c for c in built.changes if c[4] == "sym"])
    h = history.change_prior(D, 2, 60.0)
    touched = [t for t, roots in D.items() if "billing.py::total" in roots]
    assert h["billing.py::total"] == pytest.approx(sum(math.exp(-(2 - t) / 60.0) for t in touched))


def test_no_leakage_from_future_commits(built):
    """G_τ and every history signal at τ use only commits t ≤ τ."""
    tau = 1
    alive = [e for e in built.edges if e[4] <= tau and (e[5] is None or e[5] > tau)]
    assert all(e[4] <= tau for e in alive)
    assert not _edge_alive(alive, "billing.py::total", "tax.py::round_cents")  # only exists from c3
    D = history.deltas([c for c in built.changes if c[4] == "sym"])
    w = history.cochange_weights(history.cochange_contributions(D), tau)
    h = history.change_prior(D, tau)
    D_trunc = {t: r for t, r in D.items() if t <= tau}
    assert w == history.cochange_weights(history.cochange_contributions(D_trunc), tau)
    assert h == history.change_prior(D_trunc, tau)


def _edge_alive(edges, src, dst):
    return any(e[0] == src and e[1] == dst for e in edges)


def test_parse_source_local_paths(toy, tmp_path):
    from tcg.github import parse_source

    src = parse_source(str(toy))
    assert src["kind"] == "local" and src["path"] == str(toy.resolve())
    sub = toy / "pkg"
    sub.mkdir(exist_ok=True)
    assert parse_source(str(sub))["path"] == str(toy.resolve())  # a subfolder resolves to its repo
    with pytest.raises(ValueError, match="not inside a git repository"):
        parse_source(str(tmp_path))
    with pytest.raises(ValueError, match="No such folder"):
        parse_source(str(tmp_path / "missing"))
    assert parse_source("pallets/flask")["id"] == "pallets__flask"


def test_single_commit_repo_builds(tmp_path):
    """`git init` + one commit (what the UI tells people to do) must build and analyse cleanly."""
    from tcg import analysis

    repo = tmp_path / "one"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@example.com")
    _git(repo, "config", "user.name", "Test")
    for name, body in C1.items():
        (repo / name).write_text(body)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "only")
    res = Builder(repo).build(50)
    stats = analysis.analyze(res)
    assert len(res.commits) == 1
    assert stats["kpis"]["symbols"] == 4 and stats["kpis"]["commits"] == 1
