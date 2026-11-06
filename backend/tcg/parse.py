"""Tree-sitter symbol extraction.

For each source file we recover the facts the temporal code graph needs:
definitions (classes, functions, methods) with line spans and signatures,
call references attributed to their innermost enclosing definition, import
statements, and base classes. Name *resolution* happens later (resolve.py);
this module is purely syntactic, as Tree-sitter is.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
import posixpath

import tree_sitter_language_pack as tslp

EXT_LANG = {
    ".py": "python",
    ".pyi": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".tsx": "tsx",
    ".go": "go",
    ".java": "java",
    ".qasm": "openqasm",
}

LANG_LABEL = {
    "python": "Python",
    "javascript": "JavaScript",
    "typescript": "TypeScript",
    "tsx": "TypeScript",
    "go": "Go",
    "java": "Java",
    "openqasm": "OpenQASM",
}

SKIP_PARTS = (
    "node_modules/",
    "vendor/",
    "third_party/",
    "dist/",
    "build/",
    "__pycache__/",
    ".min.",
    "site-packages/",
    ".git/",
)

MAX_FILE_BYTES = 400_000


def lang_for(path: str) -> str | None:
    if any(p in path for p in SKIP_PARTS) or path.endswith(".d.ts"):
        return None
    return EXT_LANG.get(posixpath.splitext(path)[1].lower())


def is_test_path(path: str) -> bool:
    p = path.lower()
    base = posixpath.basename(p)
    return (
        "/test/" in f"/{p}"
        or "/tests/" in f"/{p}"
        or "__tests__/" in p
        or base.startswith("test_")
        or base.endswith("_test.py")
        or base.endswith("_test.go")
        or ".test." in base
        or ".spec." in base
        or base.endswith("test.java")
    )


@dataclass
class Def:
    qual: str  # qualified name within the file, e.g. "Flask.run"
    name: str
    kind: str  # class | function | method
    start: int  # 1-based inclusive
    end: int
    signature: str
    doc: str = ""
    parent: str | None = None  # qual of the enclosing def


@dataclass
class Ref:
    src: str | None  # qual of enclosing def, None = module level
    name: str
    receiver: str | None = None  # "self", "this", or other receiver text
    args: str = ""  # argument text, truncated (python only; feeds quantum gate / width detection)


@dataclass
class Import:
    module: str  # raw module string ("a.b", "./util", "fmt")
    names: list[str] = field(default_factory=list)
    level: int = 0  # python relative import level


@dataclass
class FileFacts:
    path: str
    lang: str
    lines: int
    defs: dict[str, Def] = field(default_factory=dict)
    refs: list[Ref] = field(default_factory=list)
    imports: list[Import] = field(default_factory=list)
    bases: list[tuple[str, str]] = field(default_factory=list)  # (class qual, base name)
    qmeta: dict[str, dict] = field(default_factory=dict)  # quantum annotations by def qual ("" = module)

    def def_at(self, line: int) -> Def | None:
        """Innermost definition containing `line`."""
        best: Def | None = None
        for d in self.defs.values():
            if d.start <= line <= d.end:
                if best is None or (d.end - d.start) < (best.end - best.start):
                    best = d
        return best


@lru_cache(maxsize=None)
def _parser(lang: str):
    return tslp.get_parser(lang)


def _text(node, src: bytes) -> str:
    return src[node.start_byte : node.end_byte].decode("utf-8", "replace")


def _sig(node, src: bytes, stop: str = "{:") -> str:
    """First logical line of a definition, cut at the body opener."""
    raw = _text(node, src)
    out = []
    depth = 0
    for ch in raw:
        if ch in "([<":
            depth += 1
        elif ch in ")]>":
            depth = max(0, depth - 1)
        if depth == 0 and ch in stop and out:
            if ch == ":":
                out.append(ch)
            break
        out.append(ch)
        if len(out) > 240:
            break
    return " ".join("".join(out).split())


class _Extractor:
    def __init__(self, path: str, lang: str, src: bytes):
        self.src = src
        self.facts = FileFacts(path=path, lang=lang, lines=src.count(b"\n") + 1)

    def add_def(self, qual: str, name: str, kind: str, node, signature: str, parent: str | None, doc: str = ""):
        start, end = node.start_point[0] + 1, node.end_point[0] + 1
        existing = self.facts.defs.get(qual)
        if existing:  # e.g. @property + @x.setter, or overloads: merge
            existing.end = max(existing.end, end)
            return
        self.facts.defs[qual] = Def(qual, name, kind, start, end, signature, doc, parent)

    def t(self, node) -> str:
        return _text(node, self.src)


# --------------------------------------------------------------------------- python


def _py_doc(body, ex: _Extractor) -> str:
    if body is None:
        return ""
    for child in body.named_children:
        if child.type == "expression_statement" and child.named_children:
            s = child.named_children[0]
            if s.type == "string":
                return ex.t(s).strip("\"' \n")[:300]
        break
    return ""


def _walk_python(node, ex: _Extractor, scope: str | None, in_class: bool):
    for child in node.named_children:
        tp = child.type
        if tp == "decorated_definition":
            _walk_python(child, ex, scope, in_class)
            continue
        if tp == "class_definition":
            name_node = child.child_by_field_name("name")
            if name_node is None:
                continue
            name = ex.t(name_node)
            qual = f"{scope}.{name}" if scope else name
            ex.add_def(qual, name, "class", child, _sig(child, ex.src, ":"), scope,
                       _py_doc(child.child_by_field_name("body"), ex))
            sup = child.child_by_field_name("superclasses")
            if sup is not None:
                for b in sup.named_children:
                    if b.type in ("identifier", "attribute"):
                        ex.facts.bases.append((qual, ex.t(b).split(".")[-1]))
            body = child.child_by_field_name("body")
            if body is not None:
                _walk_python(body, ex, qual, True)
            continue
        if tp == "function_definition":
            name_node = child.child_by_field_name("name")
            if name_node is None:
                continue
            name = ex.t(name_node)
            qual = f"{scope}.{name}" if scope else name
            kind = "method" if in_class else "function"
            ex.add_def(qual, name, kind, child, _sig(child, ex.src, ":"), scope,
                       _py_doc(child.child_by_field_name("body"), ex))
            body = child.child_by_field_name("body")
            if body is not None:
                _walk_python(body, ex, qual, False)
            params = child.child_by_field_name("parameters")
            if params is not None:
                _walk_python(params, ex, qual, False)
            continue
        if tp == "call":
            fn = child.child_by_field_name("function")
            argn = child.child_by_field_name("arguments")
            args = ex.t(argn)[:80] if argn is not None else ""
            if fn is not None:
                if fn.type == "identifier":
                    ex.facts.refs.append(Ref(scope, ex.t(fn), None, args))
                elif fn.type == "attribute":
                    attr = fn.child_by_field_name("attribute")
                    obj = fn.child_by_field_name("object")
                    if attr is not None:
                        recv = ex.t(obj) if obj is not None else None
                        ex.facts.refs.append(Ref(scope, ex.t(attr), recv, args))
        elif tp == "import_statement":
            for n in child.named_children:
                if n.type == "dotted_name":
                    ex.facts.imports.append(Import(ex.t(n)))
                elif n.type == "aliased_import":
                    dn = n.child_by_field_name("name")
                    if dn is not None:
                        ex.facts.imports.append(Import(ex.t(dn)))
            continue
        elif tp == "import_from_statement":
            mod = child.child_by_field_name("module_name")
            level = 0
            module = ""
            if mod is not None:
                if mod.type == "relative_import":
                    txt = ex.t(mod)
                    level = len(txt) - len(txt.lstrip("."))
                    module = txt.lstrip(".")
                else:
                    module = ex.t(mod)
            names = []
            for n in child.children_by_field_name("name"):
                if n.type == "dotted_name":
                    names.append(ex.t(n).split(".")[-1])
                elif n.type == "aliased_import":
                    dn = n.child_by_field_name("name")
                    if dn is not None:
                        names.append(ex.t(dn).split(".")[-1])
            ex.facts.imports.append(Import(module, names, level))
            continue
        _walk_python(child, ex, scope, in_class and tp in ("block",))


# --------------------------------------------------------------------------- js / ts

_JS_FUNC_VALUES = {"arrow_function", "function_expression", "function", "generator_function"}
_JS_CLASS_TYPES = {"class_declaration", "class", "abstract_class_declaration"}


def _js_doc(node, ex: _Extractor) -> str:
    prev = node.prev_named_sibling
    if prev is not None and prev.type == "comment":
        txt = ex.t(prev)
        if txt.startswith("/**"):
            return " ".join(txt.strip("/* \n").replace("*", " ").split())[:300]
    return ""


def _walk_js(node, ex: _Extractor, scope: str | None, in_class: bool):
    for child in node.named_children:
        tp = child.type
        if tp in _JS_CLASS_TYPES or tp == "interface_declaration":
            name_node = child.child_by_field_name("name")
            if name_node is None:
                _walk_js(child, ex, scope, False)
                continue
            name = ex.t(name_node)
            qual = f"{scope}.{name}" if scope else name
            ex.add_def(qual, name, "class", child, _sig(child, ex.src), scope, _js_doc(child, ex))
            for h in child.named_children:
                if h.type in ("class_heritage", "extends_clause", "implements_clause", "extends_type_clause"):
                    for ident in _iter_type(h):
                        if ident.type in ("identifier", "type_identifier"):
                            ex.facts.bases.append((qual, ex.t(ident)))
            body = child.child_by_field_name("body")
            if body is not None:
                _walk_js(body, ex, qual, True)
            continue
        if tp in ("function_declaration", "generator_function_declaration"):
            name_node = child.child_by_field_name("name")
            if name_node is not None:
                name = ex.t(name_node)
                qual = f"{scope}.{name}" if scope else name
                ex.add_def(qual, name, "function", child, _sig(child, ex.src), scope, _js_doc(child, ex))
                _walk_js(child, ex, qual, False)
                continue
        if tp in ("method_definition", "method_signature", "abstract_method_signature") and in_class:
            name_node = child.child_by_field_name("name")
            if name_node is not None:
                name = ex.t(name_node)
                qual = f"{scope}.{name}" if scope else name
                ex.add_def(qual, name, "method", child, _sig(child, ex.src), scope, _js_doc(child, ex))
                _walk_js(child, ex, qual, False)
                continue
        if tp in ("public_field_definition", "field_definition") and in_class:
            val = child.child_by_field_name("value")
            name_node = child.child_by_field_name("name") or child.child_by_field_name("property")
            if val is not None and val.type in _JS_FUNC_VALUES and name_node is not None:
                name = ex.t(name_node)
                qual = f"{scope}.{name}"
                ex.add_def(qual, name, "method", child, _sig(child, ex.src), scope)
                _walk_js(val, ex, qual, False)
                continue
        if tp == "variable_declarator":
            val = child.child_by_field_name("value")
            name_node = child.child_by_field_name("name")
            if val is not None and val.type in _JS_FUNC_VALUES and name_node is not None and name_node.type == "identifier":
                name = ex.t(name_node)
                qual = f"{scope}.{name}" if scope else name
                decl = child.parent if child.parent is not None else child
                ex.add_def(qual, name, "function", decl, _sig(child, ex.src), scope, _js_doc(decl, ex))
                _walk_js(val, ex, qual, False)
                continue
            if val is not None and val.type == "class" and name_node is not None:
                name = ex.t(name_node)
                qual = f"{scope}.{name}" if scope else name
                ex.add_def(qual, name, "class", child, _sig(child, ex.src), scope)
                body = val.child_by_field_name("body")
                if body is not None:
                    _walk_js(body, ex, qual, True)
                continue
        if tp == "call_expression":
            fn = child.child_by_field_name("function")
            if fn is not None:
                if fn.type == "identifier":
                    name = ex.t(fn)
                    if name == "require":
                        args = child.child_by_field_name("arguments")
                        if args is not None and args.named_children and args.named_children[0].type == "string":
                            ex.facts.imports.append(Import(ex.t(args.named_children[0]).strip("'\"`")))
                    else:
                        ex.facts.refs.append(Ref(scope, name))
                elif fn.type == "member_expression":
                    prop = fn.child_by_field_name("property")
                    obj = fn.child_by_field_name("object")
                    if prop is not None:
                        ex.facts.refs.append(Ref(scope, ex.t(prop), ex.t(obj) if obj is not None else None))
        elif tp == "new_expression":
            ctor = child.child_by_field_name("constructor")
            if ctor is not None and ctor.type == "identifier":
                ex.facts.refs.append(Ref(scope, ex.t(ctor)))
        elif tp == "import_statement":
            srcnode = child.child_by_field_name("source")
            if srcnode is not None:
                names = []
                for n in _iter_type(child):
                    if n.type == "import_specifier":
                        nm = n.child_by_field_name("name")
                        if nm is not None:
                            names.append(ex.t(nm))
                ex.facts.imports.append(Import(ex.t(srcnode).strip("'\"`"), names))
            continue
        elif tp == "export_statement":
            srcnode = child.child_by_field_name("source")
            if srcnode is not None:
                ex.facts.imports.append(Import(ex.t(srcnode).strip("'\"`")))
        _walk_js(child, ex, scope, in_class and tp in ("class_body",))


def _iter_type(node):
    stack = [node]
    while stack:
        n = stack.pop()
        yield n
        stack.extend(reversed(n.named_children))


# --------------------------------------------------------------------------- go


def _walk_go(node, ex: _Extractor, scope: str | None):
    for child in node.named_children:
        tp = child.type
        if tp == "function_declaration":
            name_node = child.child_by_field_name("name")
            if name_node is not None:
                name = ex.t(name_node)
                ex.add_def(name, name, "function", child, _sig(child, ex.src, "{"), None, _js_doc(child, ex))
                _walk_go(child, ex, name)
                continue
        if tp == "method_declaration":
            name_node = child.child_by_field_name("name")
            recv = child.child_by_field_name("receiver")
            if name_node is not None:
                name = ex.t(name_node)
                rtype = None
                if recv is not None:
                    for n in _iter_type(recv):
                        if n.type == "type_identifier":
                            rtype = ex.t(n)
                            break
                qual = f"{rtype}.{name}" if rtype else name
                ex.add_def(qual, name, "method", child, _sig(child, ex.src, "{"), rtype, _js_doc(child, ex))
                _walk_go(child, ex, qual)
                continue
        if tp == "type_spec":
            name_node = child.child_by_field_name("name")
            tnode = child.child_by_field_name("type")
            if name_node is not None and tnode is not None and tnode.type in ("struct_type", "interface_type"):
                name = ex.t(name_node)
                ex.add_def(name, name, "class", child, _sig(child, ex.src, "{"), None)
                for n in _iter_type(tnode):
                    if n.type == "field_declaration" and n.child_by_field_name("name") is None:
                        tt = n.child_by_field_name("type")
                        if tt is not None:
                            ex.facts.bases.append((name, ex.t(tt).lstrip("*").split(".")[-1]))
                continue
        if tp == "call_expression":
            fn = child.child_by_field_name("function")
            if fn is not None:
                if fn.type == "identifier":
                    ex.facts.refs.append(Ref(scope, ex.t(fn)))
                elif fn.type == "selector_expression":
                    fld = fn.child_by_field_name("field")
                    op = fn.child_by_field_name("operand")
                    if fld is not None:
                        ex.facts.refs.append(Ref(scope, ex.t(fld), ex.t(op) if op is not None else None))
        elif tp == "import_spec":
            p = child.child_by_field_name("path")
            if p is not None:
                ex.facts.imports.append(Import(ex.t(p).strip('"`')))
            continue
        _walk_go(child, ex, scope)


# --------------------------------------------------------------------------- java

_JAVA_CLASS = {"class_declaration", "interface_declaration", "enum_declaration", "record_declaration"}


def _walk_java(node, ex: _Extractor, scope: str | None):
    for child in node.named_children:
        tp = child.type
        if tp in _JAVA_CLASS:
            name_node = child.child_by_field_name("name")
            if name_node is not None:
                name = ex.t(name_node)
                qual = f"{scope}.{name}" if scope else name
                ex.add_def(qual, name, "class", child, _sig(child, ex.src, "{"), scope, _js_doc(child, ex))
                for fld in ("superclass", "interfaces"):
                    sup = child.child_by_field_name(fld)
                    if sup is not None:
                        for n in _iter_type(sup):
                            if n.type == "type_identifier":
                                ex.facts.bases.append((qual, ex.t(n)))
                body = child.child_by_field_name("body")
                if body is not None:
                    _walk_java(body, ex, qual)
                continue
        if tp in ("method_declaration", "constructor_declaration"):
            name_node = child.child_by_field_name("name")
            if name_node is not None:
                name = ex.t(name_node)
                qual = f"{scope}.{name}" if scope else name
                ex.add_def(qual, name, "method", child, _sig(child, ex.src, "{"), scope, _js_doc(child, ex))
                _walk_java(child, ex, qual)
                continue
        if tp == "method_invocation":
            nm = child.child_by_field_name("name")
            obj = child.child_by_field_name("object")
            if nm is not None:
                ex.facts.refs.append(Ref(scope, ex.t(nm), ex.t(obj) if obj is not None else None))
        elif tp == "object_creation_expression":
            tnode = child.child_by_field_name("type")
            if tnode is not None:
                ex.facts.refs.append(Ref(scope, ex.t(tnode).split("<")[0].split(".")[-1]))
        elif tp == "import_declaration":
            txt = ex.t(child).replace("import", "", 1).replace("static", "", 1).strip(" ;")
            ex.facts.imports.append(Import(txt))
            continue
        _walk_java(child, ex, scope)


# --------------------------------------------------------------------------- entry


def parse_file(path: str, src: bytes, lang: str | None = None) -> FileFacts | None:
    lang = lang or lang_for(path)
    if lang is None or len(src) > MAX_FILE_BYTES:
        return None
    if lang == "openqasm":  # no Tree-sitter grammar: a line-oriented parser (qcode.py)
        from .qcode import parse_qasm

        try:
            return parse_qasm(path, src)
        except Exception:
            return None
    try:
        tree = _parser(lang).parse(src)
    except Exception:
        return None
    ex = _Extractor(path, lang, src)
    root = tree.root_node
    if lang == "python":
        _walk_python(root, ex, None, False)
        from .qcode import python_qmeta

        python_qmeta(ex.facts, src)
    elif lang in ("javascript", "typescript", "tsx"):
        _walk_js(root, ex, None, False)
    elif lang == "go":
        _walk_go(root, ex, None)
    elif lang == "java":
        _walk_java(root, ex, None)
    return ex.facts
