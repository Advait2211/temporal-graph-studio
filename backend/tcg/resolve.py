"""Heuristic cross-file name resolution (proposal §Incremental Construction, step 4).

Tree-sitter gives us names, not bindings. We link each reference to candidate
definitions using, in order of preference: the enclosing class (for self/this
calls), the same file, the files it imports, and finally a global name index.
A reference with k candidates yields k edges of weight 1/k. Reverse indices
let the builder re-resolve only the files a commit can have affected.
"""

from __future__ import annotations

from collections import defaultdict
import posixpath
import re

from .parse import FileFacts

EdgeKey = tuple[str, str, str]  # (src node key, dst node key, type)

JS_EXTS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")
SELF_RECEIVERS = {"self", "this", "cls", "super()"}
GLOBAL_CAP = 3  # beyond this many same-named candidates, an unqualified global match is noise
_TOKEN = re.compile(r"[A-Za-z0-9_\-]+")
# receiver.method() names so generic that a global, untyped match is almost always wrong
COMMON_METHODS = {
    "get", "set", "update", "append", "extend", "pop", "items", "keys", "values", "copy", "add",
    "remove", "clear", "format", "join", "split", "strip", "replace", "read", "write", "close",
    "open", "send", "run", "start", "stop", "call", "apply", "bind", "push", "map", "filter",
    "reduce", "find", "index", "insert", "delete", "has", "then", "catch", "resolve", "reject",
    "emit", "on", "off", "toString", "length", "size", "next", "lower", "upper", "encode",
    "decode", "setdefault", "sort", "reverse", "count", "load", "loads", "dump", "dumps", "exists",
    "match", "search", "sub", "test", "log", "info", "debug", "warn", "warning", "error", "parse",
    "render", "init", "__init__", "__call__", "__enter__", "__exit__", "forEach", "slice", "splice",
}


def _is_aux(path: str) -> bool:
    p = "/" + path.lower()
    return any(s in p for s in ("/test/", "/tests/", "/testing/", "/examples/", "/example/", "/docs/",
                                 "/benchmarks/", "/__tests__/", "/fixtures/")) or "/test_" in p


def node_key(path: str, qual: str | None) -> str:
    return f"{path}::{qual}" if qual else path


def _strip_ext(path: str) -> str:
    return posixpath.splitext(path)[0]


class Resolver:
    def __init__(self) -> None:
        self.files: dict[str, FileFacts] = {}
        self.defs_by_name: dict[str, set[tuple[str, str]]] = defaultdict(set)  # name -> {(path, qual)}
        self.ref_index: dict[str, set[str]] = defaultdict(set)  # name -> files referencing it
        self.import_token_index: dict[str, set[str]] = defaultdict(set)  # token -> files importing it
        self.py_modules: dict[str, set[str]] = defaultdict(set)  # dotted suffix -> paths
        self.path_noext: dict[str, set[str]] = defaultdict(set)  # path without extension -> paths
        self.dirs: dict[str, set[str]] = defaultdict(set)  # dir -> paths
        self.noext_by_base: dict[str, set[str]] = defaultdict(set)  # basename -> noext keys
        self.dirs_by_base: dict[str, set[str]] = defaultdict(set)  # dir basename -> dirs
        self._import_cache: dict[str, list[str]] = {}

    # ------------------------------------------------------------------ indices

    def _py_suffixes(self, path: str) -> list[str]:
        mod = _strip_ext(path)
        if mod.endswith("/__init__"):
            mod = mod[: -len("/__init__")]
        parts = [p for p in mod.split("/") if p]
        return [".".join(parts[i:]) for i in range(len(parts))]

    def add_file(self, facts: FileFacts) -> None:
        path = facts.path
        self.files[path] = facts
        for qual, d in facts.defs.items():
            self.defs_by_name[d.name].add((path, qual))
        for r in facts.refs:
            self.ref_index[r.name].add(path)
        for _, base in facts.bases:
            self.ref_index[base].add(path)
        for imp in facts.imports:
            for tok in _TOKEN.findall(imp.module) + imp.names:
                self.import_token_index[tok].add(path)
        if facts.lang == "python":
            for s in self._py_suffixes(path):
                self.py_modules[s].add(path)
        noext = _strip_ext(path)
        self.path_noext[noext].add(path)
        self.noext_by_base[posixpath.basename(noext)].add(noext)
        d = posixpath.dirname(path)
        self.dirs[d].add(path)
        self.dirs_by_base[posixpath.basename(d)].add(d)
        self._import_cache.clear()

    def remove_file(self, path: str) -> FileFacts | None:
        facts = self.files.pop(path, None)
        if facts is None:
            return None
        for qual, d in facts.defs.items():
            s = self.defs_by_name.get(d.name)
            if s:
                s.discard((path, qual))
                if not s:
                    del self.defs_by_name[d.name]
        for r in facts.refs:
            self.ref_index.get(r.name, set()).discard(path)
        for _, base in facts.bases:
            self.ref_index.get(base, set()).discard(path)
        for imp in facts.imports:
            for tok in _TOKEN.findall(imp.module) + imp.names:
                self.import_token_index.get(tok, set()).discard(path)
        if facts.lang == "python":
            for s in self._py_suffixes(path):
                self.py_modules.get(s, set()).discard(path)
        self.path_noext.get(_strip_ext(path), set()).discard(path)
        self.dirs.get(posixpath.dirname(path), set()).discard(path)
        self._import_cache.clear()
        return facts

    def files_referencing(self, names: set[str]) -> set[str]:
        out: set[str] = set()
        for n in names:
            out |= self.ref_index.get(n, set())
        return out

    def files_importing_path(self, path: str) -> set[str]:
        stem = posixpath.basename(_strip_ext(path))
        toks = {stem}
        if stem in ("__init__", "index", "mod"):
            toks.add(posixpath.basename(posixpath.dirname(path)))
        out: set[str] = set()
        for t in toks:
            out |= self.import_token_index.get(t, set())
        return out

    # ------------------------------------------------------------------ imports

    def resolve_imports(self, facts: FileFacts) -> list[str]:
        cached = self._import_cache.get(facts.path)
        if cached is not None:
            return cached
        out: list[str] = []
        lang = facts.lang
        here = posixpath.dirname(facts.path)
        for imp in facts.imports:
            targets: set[str] = set()
            if lang == "python":
                if imp.level > 0:
                    base = here
                    for _ in range(imp.level - 1):
                        base = posixpath.dirname(base)
                    rel = posixpath.join(base, imp.module.replace(".", "/")) if imp.module else base
                    for cand in (rel + ".py", rel + "/__init__.py"):
                        if cand in self.files:
                            targets.add(cand)
                    for n in imp.names:
                        for cand in (f"{rel}/{n}.py", f"{rel}/{n}/__init__.py"):
                            if cand in self.files:
                                targets.add(cand)
                else:
                    targets |= self._best_py(imp.module)
                    for n in imp.names:
                        targets |= self._best_py(f"{imp.module}.{n}")
            elif lang in ("javascript", "typescript", "tsx"):
                m = imp.module
                if m.startswith("."):
                    base = posixpath.normpath(posixpath.join(here, m))
                elif m.startswith(("@/", "~/")):
                    base = m[2:]
                else:
                    base = None
                if base is not None:
                    if base in self.files:
                        targets.add(base)
                    else:
                        b = _strip_ext(base) if base.endswith(JS_EXTS) else base
                        for p in self.path_noext.get(b, set()):
                            targets.add(p)
                        for p in self.path_noext.get(b + "/index", set()):
                            targets.add(p)
                        if not targets and m.startswith(("@/", "~/")):
                            for key in self.noext_by_base.get(posixpath.basename(b), ()):
                                if key.endswith("/" + b):
                                    targets |= self.path_noext.get(key, set())
            elif lang == "go":
                for d in self.dirs_by_base.get(posixpath.basename(imp.module), ()):
                    if d and (imp.module == d or imp.module.endswith("/" + d)):
                        targets |= {p for p in self.dirs.get(d, ()) if p.endswith(".go") and not p.endswith("_test.go")}
                        break
            elif lang == "java":
                mod = imp.module
                if mod.endswith(".*"):
                    d = mod[:-2].replace(".", "/")
                    for dd in self.dirs_by_base.get(posixpath.basename(d), ()):
                        if dd == d or dd.endswith("/" + d):
                            targets |= self.dirs.get(dd, set())
                else:
                    suffix = mod.replace(".", "/")
                    for key in self.noext_by_base.get(posixpath.basename(suffix), ()):
                        if key == suffix or key.endswith("/" + suffix):
                            targets |= self.path_noext.get(key, set())
            targets.discard(facts.path)
            out.extend(sorted(targets)[:12])
        res = sorted(set(out))
        self._import_cache[facts.path] = res
        return res

    def _best_py(self, module: str) -> set[str]:
        """Module hits that strip the fewest leading path components (src/flask/app.py beats tests/x/flask.py)."""
        hits = self.py_modules.get(module)
        if not hits:
            return set()
        depth = module.count(".") + 1

        def stripped(p: str) -> int:
            mod = _strip_ext(p)
            if mod.endswith("/__init__"):
                mod = mod[: -len("/__init__")]
            return mod.count("/") + 1 - depth

        best = min(stripped(p) for p in hits)
        return {p for p in hits if stripped(p) == best}

    # ------------------------------------------------------------------ edges

    def _candidates(
        self,
        facts: FileFacts,
        name: str,
        imported: list[str],
        imported_names: set[str],
        kinds: set[str] | None,
        global_ok: bool = True,
    ) -> list[tuple[str, str]]:
        pool = self.defs_by_name.get(name)
        if not pool:
            return []
        if kinds:
            pool = {(p, q) for (p, q) in pool if self.files[p].defs[q].kind in kinds}
        if not pool:
            return []
        same = [(p, q) for (p, q) in pool if p == facts.path]
        if same:
            return same
        if imported:
            imp_set = set(imported)
            via = [(p, q) for (p, q) in pool if p in imp_set]
            if via:
                return via
        if not global_ok:
            return []
        # production code should not resolve into tests/examples on a name match alone
        if not _is_aux(facts.path):
            pool = {(p, q) for (p, q) in pool if not _is_aux(p)}
        if pool and (name in imported_names or len(pool) <= GLOBAL_CAP):
            return sorted(pool)[:GLOBAL_CAP]
        return []

    def compute_edges(self, path: str) -> dict[EdgeKey, float]:
        """All edges whose source lies in `path` (contains, imports, calls, inherits)."""
        facts = self.files.get(path)
        edges: dict[EdgeKey, float] = {}
        if facts is None:
            return edges

        def put(src: str, dst: str, typ: str, w: float) -> None:
            if src == dst:
                return
            k = (src, dst, typ)
            if edges.get(k, 0.0) < w:
                edges[k] = w

        # contains
        for qual, d in facts.defs.items():
            parent = node_key(path, d.parent) if d.parent and d.parent in facts.defs else path
            put(parent, node_key(path, qual), "contains", 1.0)

        # imports
        imported = self.resolve_imports(facts)
        for tgt in imported:
            put(path, tgt, "imports", 1.0)
        imported_names = {n for imp in facts.imports for n in imp.names}
        module_aliases = {imp.module.split(".")[-1].split("/")[-1] for imp in facts.imports if imp.module} | {
            n for imp in facts.imports for n in imp.names}

        # calls
        for ref in facts.refs:
            src = node_key(path, ref.src) if ref.src in facts.defs else path
            cands: list[tuple[str, str]] = []
            if ref.receiver in SELF_RECEIVERS and ref.src:
                # walk up to the enclosing class
                q = facts.defs.get(ref.src)
                cls = None
                while q is not None:
                    if q.kind == "class":
                        cls = q.qual
                        break
                    q = facts.defs.get(q.parent) if q.parent else None
                if cls and f"{cls}.{ref.name}" in facts.defs:
                    cands = [(path, f"{cls}.{ref.name}")]
                else:
                    cands = self._candidates(facts, ref.name, imported, imported_names, {"method"},
                                             global_ok=ref.name not in COMMON_METHODS)
            elif ref.receiver is None:
                cands = self._candidates(facts, ref.name, imported, imported_names, None)
            else:
                head = ref.receiver.split(".")[0].split("(")[0]
                if head in module_aliases:
                    # module.func(): only look in imported files
                    cands = self._candidates(facts, ref.name, imported, imported_names,
                                             {"function", "class"}, global_ok=False)
                else:
                    cands = self._candidates(facts, ref.name, imported, imported_names, {"method"},
                                             global_ok=ref.name not in COMMON_METHODS)
            if not cands:
                continue
            w = 1.0 / len(cands)
            for p, q in cands:
                put(src, node_key(p, q), "calls", w)

        # inherits
        for cls_qual, base in facts.bases:
            cands = self._candidates(facts, base, imported, imported_names, {"class"})
            if not cands:
                continue
            w = 1.0 / len(cands)
            for p, q in cands:
                put(node_key(path, cls_qual), node_key(p, q), "inherits", w)
        return edges
