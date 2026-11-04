"""History signals (proposal eqs. cochange and prior).

    w_cc(u, v; τ) = Σ_{t ≤ τ, u,v ∈ Δ_t}  exp(-(τ - t)/λ) / (|Δ_t| - 1)
    h(v; τ)       = Σ_{t ≤ τ, v ∈ Δ_t}    exp(-(τ - t)/λ)

Both are computed from commits t ≤ τ only, which is what keeps G_τ leakage-safe.
Symbols are identified by their lineage root so that history survives file renames.
"""

from __future__ import annotations

from collections import defaultdict
from itertools import combinations
import math

DEFAULT_LAMBDA = 60.0  # decay constant, in commits
DEFAULT_K = 40  # skip commits touching more than K symbols (bulk reformat, vendoring)


def deltas(rows) -> dict[int, set[str]]:
    """rows: iterable of (t, key, root, path). Returns Δ_t as sets of roots."""
    out: dict[int, set[str]] = defaultdict(set)
    for r in rows:
        out[int(r[0])].add(r[2])
    return out


def change_prior(d: dict[int, set[str]], tau: int, lam: float = DEFAULT_LAMBDA) -> dict[str, float]:
    h: dict[str, float] = defaultdict(float)
    for t, roots in d.items():
        if t > tau:
            continue
        decay = math.exp(-(tau - t) / lam)
        for r in roots:
            h[r] += decay
    return dict(h)


def change_counts(d: dict[int, set[str]], tau: int) -> dict[str, int]:
    c: dict[str, int] = defaultdict(int)
    for t, roots in d.items():
        if t <= tau:
            for r in roots:
                c[r] += 1
    return dict(c)


def cochange_contributions(d: dict[int, set[str]], K: int = DEFAULT_K) -> dict[tuple[str, str], list[tuple[int, float]]]:
    """For every co-changed pair, the (t, 1/(|Δ_t|-1)) terms. Weight at τ is Σ term·exp(-(τ-t)/λ) for t ≤ τ."""
    contrib: dict[tuple[str, str], list[tuple[int, float]]] = defaultdict(list)
    for t, roots in sorted(d.items()):
        n = len(roots)
        if n < 2 or n > K:
            continue
        norm = 1.0 / (n - 1)
        for a, b in combinations(sorted(roots), 2):
            contrib[(a, b)].append((t, norm))
    return dict(contrib)


def cochange_weights(contrib: dict[tuple[str, str], list[tuple[int, float]]], tau: int,
                     lam: float = DEFAULT_LAMBDA) -> dict[tuple[str, str], float]:
    out: dict[tuple[str, str], float] = {}
    for pair, terms in contrib.items():
        w = 0.0
        for t, norm in terms:
            if t <= tau:
                w += norm * math.exp(-(tau - t) / lam)
        if w > 0:
            out[pair] = w
    return out
