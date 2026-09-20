"""Bounded, deterministic execution traces for EagleIDE Step Mode.

This module is loaded only by ``sandbox_worker.py`` after the ordinary process,
filesystem, import, and memory boundaries have been established.  It never
uses ``repr`` on arbitrary student objects: a user-defined ``__repr__`` must
not be able to turn the educational variable viewer into another execution
surface.
"""

from __future__ import annotations

import ast
import difflib
import io
import re
from types import FrameType, FunctionType, ModuleType, TracebackType
from typing import Any, Callable


MAX_TRACE_STEPS = 2_000
MAX_TRACE_OUTPUT_CHARS = 200_000
MAX_VISIBLE_VARIABLES = 80
MAX_VALUE_CHARS = 240
MAX_CONTAINER_ITEMS = 12
MAX_CONTAINER_DEPTH = 3
MAX_TRACE_ESTIMATED_CHARS = 3_500_000
MAX_DEFINED_ITEMS = 200


class TraceLimitReached(BaseException):
    """Stop an educational trace before it can exhaust server/browser memory."""


def _clip(text: Any, limit: int = MAX_VALUE_CHARS) -> str:
    value = str(text)
    if len(value) <= limit:
        return value
    return value[: max(0, limit - 1)] + "…"


def _safe_type_name(value: Any) -> str:
    try:
        return _clip(type(value).__name__, 80)
    except BaseException:
        return "object"


def safe_value(value: Any, depth: int = 0) -> str:
    """Render common values without invoking student-defined representation code."""

    value_type = type(value)
    if value is None or value_type in {bool, int, float, complex}:
        return _clip(repr(value))
    if value_type is str:
        return _clip(repr(value))
    if value_type is bytes:
        return _clip(repr(value))
    if depth >= MAX_CONTAINER_DEPTH:
        return f"<{_safe_type_name(value)} …>"
    if value_type in {list, tuple}:
        opener, closer = ("[", "]") if value_type is list else ("(", ")")
        items = [safe_value(item, depth + 1) for item in value[:MAX_CONTAINER_ITEMS]]
        if len(value) > MAX_CONTAINER_ITEMS:
            items.append(f"… {len(value) - MAX_CONTAINER_ITEMS} more")
        suffix = "," if value_type is tuple and len(value) == 1 else ""
        return _clip(opener + ", ".join(items) + suffix + closer)
    if value_type in {set, frozenset}:
        items = []
        for index, item in enumerate(value):
            if index >= MAX_CONTAINER_ITEMS:
                items.append("…")
                break
            items.append(safe_value(item, depth + 1))
        rendered = "{" + ", ".join(items) + "}"
        return _clip(rendered if value_type is set else f"frozenset({rendered})")
    if value_type is dict:
        items = []
        for index, (key, item) in enumerate(value.items()):
            if index >= MAX_CONTAINER_ITEMS:
                items.append(f"… {len(value) - MAX_CONTAINER_ITEMS} more")
                break
            items.append(f"{safe_value(key, depth + 1)}: {safe_value(item, depth + 1)}")
        return _clip("{" + ", ".join(items) + "}")
    if value_type is range:
        return f"range({value.start}, {value.stop}, {value.step})"
    if value_type is slice:
        return f"slice({safe_value(value.start)}, {safe_value(value.stop)}, {safe_value(value.step)})"
    if value_type is ModuleType:
        return f"<imported module {_clip(value.__name__, 120)}>"
    if isinstance(value, type):
        try:
            name = type.__getattribute__(value, "__name__")
        except BaseException:
            name = _safe_type_name(value)
        return f"<class {_clip(name, 120)}>"
    if value_type is FunctionType:
        return f"<function {_clip(value.__name__, 120)}>"
    if callable(value):
        return f"<callable {_safe_type_name(value)}>"
    return f"<{_safe_type_name(value)} instance>"


def _value_kind(value: Any) -> str:
    value_type = type(value)
    if value_type is ModuleType:
        return "imported module"
    if isinstance(value, type):
        return "class"
    if value_type is FunctionType:
        return "function"
    if callable(value):
        return "callable"
    return _safe_type_name(value)


class TraceOutput(io.TextIOBase):
    """Capture student output while still looking enough like a text stream."""

    encoding = "utf-8"
    errors = "replace"

    def __init__(self, limit: int = MAX_TRACE_OUTPUT_CHARS):
        super().__init__()
        self._parts: list[str] = []
        self._length = 0
        self._limit = max(1, int(limit))
        self.truncated = False

    def writable(self) -> bool:
        return True

    def write(self, value: Any) -> int:
        text = str(value)
        original_length = len(text)
        remaining = self._limit - self._length
        if remaining > 0:
            accepted = text[:remaining]
            self._parts.append(accepted)
            self._length += len(accepted)
        if original_length > max(0, remaining):
            self.truncated = True
        return original_length

    def flush(self) -> None:
        return

    def isatty(self) -> bool:
        return False

    def getvalue(self) -> str:
        return "".join(self._parts)

    def tell(self) -> int:
        return self._length


class SourceNarrator:
    """Generate short pseudocode-style descriptions from Python's AST."""

    def __init__(self, source: str):
        self.source = source
        self.lines = source.splitlines()
        self.nodes: dict[int, ast.AST] = {}
        self.import_bindings: dict[str, str] = {}
        self.user_functions: set[str] = set()
        self.user_classes: set[str] = set()
        self.user_methods: set[str] = set()
        self.definition_by_line: dict[int, tuple[str, str]] = {}
        self.defined_items: list[dict[str, Any]] = []
        try:
            tree = ast.parse(source)
        except SyntaxError:
            tree = None
        if tree is not None:
            self._index_definitions(tree.body)
            for node in ast.walk(tree):
                line = int(getattr(node, "lineno", 0) or 0)
                if line <= 0 or not isinstance(node, ast.stmt):
                    continue
                current = self.nodes.get(line)
                # Prefer the smallest statement starting on this line.
                if current is None or int(getattr(node, "end_lineno", line) or line) <= int(
                    getattr(current, "end_lineno", line) or line
                ):
                    self.nodes[line] = node
        self.defined_items.sort(key=lambda item: (int(item["line"]), str(item["name"]).casefold()))

    def _add_defined_item(self, name: str, kind: str, line: int, origin: str) -> None:
        if len(self.defined_items) >= MAX_DEFINED_ITEMS:
            return
        self.defined_items.append({
            "name": _clip(name, 140),
            "type": kind,
            "scope": "source",
            "value": _clip(origin, 180),
            "line": max(1, int(line or 1)),
        })

    def _index_definitions(self, statements: list[ast.stmt], owner: str = "") -> None:
        for node in statements:
            line = int(getattr(node, "lineno", 1) or 1)
            if isinstance(node, ast.Import):
                for alias in node.names:
                    binding = alias.asname or alias.name.split(".", 1)[0]
                    self.import_bindings[binding] = alias.name
                    self._add_defined_item(binding, "imported module", line, f"imports {alias.name}")
            elif isinstance(node, ast.ImportFrom):
                module = node.module or "relative module"
                for alias in node.names:
                    if alias.name == "*":
                        continue
                    binding = alias.asname or alias.name
                    origin = f"{module}.{alias.name}"
                    self.import_bindings[binding] = origin
                    self._add_defined_item(binding, "imported item", line, f"imports {origin}")
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                qualified = f"{owner}.{node.name}" if owner else node.name
                kind = "method" if owner else "function"
                self.definition_by_line[line] = (qualified, kind)
                if owner:
                    self.user_methods.add(qualified)
                else:
                    self.user_functions.add(node.name)
                label = "special method" if node.name.startswith("__") and node.name.endswith("__") else kind
                self._add_defined_item(qualified, label, line, f"defined in this file at line {line}")
            elif isinstance(node, ast.ClassDef):
                qualified = f"{owner}.{node.name}" if owner else node.name
                self.user_classes.add(qualified)
                self.definition_by_line[line] = (qualified, "class")
                self._add_defined_item(qualified, "class", line, f"defined in this file at line {line}")
                self._index_definitions(node.body, qualified)

    def source_line(self, line: int) -> str:
        if 1 <= line <= len(self.lines):
            return self.lines[line - 1].strip()
        return ""

    def _segment(self, node: ast.AST | None, fallback: str = "this expression") -> str:
        if node is None:
            return fallback
        try:
            segment = ast.get_source_segment(self.source, node)
        except Exception:
            segment = None
        return _clip((segment or fallback).strip(), 180)

    def _call_path(self, node: ast.AST | None) -> str:
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            base = self._call_path(node.value)
            return f"{base}.{node.attr}" if base else node.attr
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "super":
            return "super()"
        return self._segment(node, "")

    @staticmethod
    def _literal_string(node: ast.AST | None) -> str | None:
        if node is None:
            return None
        try:
            value = ast.literal_eval(node)
        except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
            return None
        return value if type(value) is str else None

    def _keyword(self, call: ast.Call, name: str) -> ast.AST | None:
        return next((item.value for item in call.keywords if item.arg == name), None)

    @staticmethod
    def _mode_explanation(mode: str) -> str:
        action = "read an existing file"
        if "x" in mode:
            action = "create a new file and fail if it already exists"
        elif "w" in mode:
            action = "create or replace the file for writing"
        elif "a" in mode:
            action = "append new data at the end of the file"
        elif "r" in mode:
            action = "read an existing file"
        data_kind = "binary data" if "b" in mode else "text"
        update = " and allow both reading and writing" if "+" in mode else ""
        return f"{action} as {data_kind}{update}"

    def _describe_open(self, call: ast.Call, target: str = "", managed: bool = False) -> str:
        is_method = isinstance(call.func, ast.Attribute)
        if is_method:
            path_node = call.func.value
            mode_node = call.args[0] if call.args else self._keyword(call, "mode")
        else:
            path_node = call.args[0] if call.args else self._keyword(call, "file")
            mode_node = call.args[1] if len(call.args) > 1 else self._keyword(call, "mode")
        path = self._segment(path_node, "the requested path")
        mode_literal = self._literal_string(mode_node) if mode_node is not None else "r"
        mode_text = repr(mode_literal) if mode_literal is not None else self._segment(mode_node, "the selected mode")
        if mode_literal is not None:
            explanation = self._mode_explanation(mode_literal)
        else:
            explanation = "The mode expression decides whether the file is read, written, appended to, or opened as binary data."
        parts = [f"Open {path} with mode {mode_text} to {explanation}"]
        encoding = self._keyword(call, "encoding")
        newline = self._keyword(call, "newline")
        if encoding is not None:
            parts.append(f"Use encoding {self._segment(encoding)}")
        if newline is not None:
            parts.append(f"Use newline setting {self._segment(newline)}")
        if target:
            parts.append(f"Store the file object in {target}")
        if managed:
            parts.append("The with block closes the file automatically, even if an error occurs")
        return ". ".join(parts) + "."

    def _describe_file_method(self, call: ast.Call, owner: str, method: str) -> str:
        first = self._segment(call.args[0], "the supplied data") if call.args else ""
        if method == "read":
            amount = f"up to {first} characters or bytes" if first else "all remaining content"
            return f"Read {amount} from file object {owner}. The read data is returned to this line."
        if method == "readline":
            return f"Read the next line from file object {owner}. The newline is kept when one is present."
        if method == "readlines":
            return f"Read the remaining lines from file object {owner} and return them as a list."
        if method == "write":
            return (
                f"Write {first or 'the supplied data'} to file object {owner}. "
                "In text mode, write returns the number of characters written."
            )
        if method == "writelines":
            return (
                f"Write each string from {first or 'the supplied iterable'} to file object {owner}. "
                "Python does not add newline characters automatically."
            )
        if method == "seek":
            return f"Move file object {owner}'s current position using {self._segment(call, method + '(...)')}."
        if method == "tell":
            return f"Ask file object {owner} for its current read or write position."
        if method == "flush":
            return f"Flush buffered data from file object {owner} to its underlying file."
        if method == "truncate":
            return f"Resize the file through {owner} at the requested position."
        return f"Close file object {owner}. Further reads or writes through it are not allowed."

    def _describe_csv_call(self, call: ast.Call, path: str) -> str:
        source = self._segment(call.args[0], "the file object") if call.args else "the file object"
        settings = [
            f"{item.arg}={self._segment(item.value)}"
            for item in call.keywords
            if item.arg in {"dialect", "delimiter", "quotechar", "quoting", "lineterminator", "escapechar"}
        ]
        settings_text = f" CSV settings: {', '.join(settings)}." if settings else ""
        if path == "csv.reader":
            return f"Create a CSV reader for {source}. It will parse each row into a list of column values.{settings_text}"
        if path == "csv.DictReader":
            return f"Create a CSV DictReader for {source}. Each row will be returned as a dictionary keyed by column heading.{settings_text}"
        if path == "csv.writer":
            return f"Create a CSV writer for {source}. It will quote and separate column values correctly when rows are written.{settings_text}"
        if path == "csv.DictWriter":
            fields = self._keyword(call, "fieldnames")
            field_text = self._segment(fields, "the supplied field names")
            return f"Create a CSV DictWriter for {source} using {field_text} as the column order.{settings_text}"
        if path.endswith(".writerow"):
            row = self._segment(call.args[0], "one row") if call.args else "one row"
            return f"Write {row} as one CSV row, applying CSV quoting and delimiters where needed."
        if path.endswith(".writerows"):
            rows = self._segment(call.args[0], "the rows") if call.args else "the rows"
            return f"Write every row from {rows} to the CSV file."
        if path.endswith(".writeheader"):
            return "Write the DictWriter's field names as the CSV header row."
        return ""

    def _import_origin(self, path: str) -> str:
        root = path.split(".", 1)[0]
        origin = self.import_bindings.get(root)
        if not origin:
            return ""
        suffix = path[len(root):]
        return origin + suffix

    def _describe_dunder_definition(self, qualified: str, name: str) -> str:
        owner = qualified.rsplit(".", 1)[0] if "." in qualified else "this class"
        explanations = {
            "__init__": f"Define {qualified}, the initializer Python calls after creating a new {owner} object. It usually stores starting values on self.",
            "__str__": f"Define {qualified}, which supplies friendly text for str(...) and print(...).",
            "__repr__": f"Define {qualified}, which supplies a developer-focused representation of the object.",
            "__len__": f"Define {qualified}, which answers len(...) for objects of this class.",
            "__iter__": f"Define {qualified}, which starts iteration for a for loop or iter(...).",
            "__next__": f"Define {qualified}, which returns the next item during iteration.",
            "__enter__": f"Define {qualified}, which runs when a with block begins.",
            "__exit__": f"Define {qualified}, which runs when a with block ends and receives any exception details.",
            "__call__": f"Define {qualified}, which lets an instance be called like a function.",
            "__eq__": f"Define {qualified}, which decides how == compares this object.",
            "__bool__": f"Define {qualified}, which decides whether this object counts as true or false.",
            "__contains__": f"Define {qualified}, which answers membership checks using in.",
            "__getitem__": f"Define {qualified}, which handles indexed or keyed access with square brackets.",
            "__setitem__": f"Define {qualified}, which handles assignment through square brackets.",
            "__add__": f"Define {qualified}, which handles + when this object is on the left.",
            "__sub__": f"Define {qualified}, which handles - when this object is on the left.",
            "__lt__": f"Define {qualified}, which handles < comparisons.",
            "__hash__": f"Define {qualified}, which supplies a hash value for dictionaries and sets.",
        }
        return explanations.get(name, f"Define special method {qualified}. Python calls this automatically for its matching language operation.")

    def describe_call_frame(self, qualified: str, function_name: str, args: list[str], kind: str) -> str:
        rendered = f"{qualified}({', '.join(args)})"
        if kind == "class body":
            return f"Build class {qualified} by executing its definitions. Method bodies are created now but do not run yet."
        if function_name == "__init__":
            owner = qualified.rsplit(".", 1)[0] if "." in qualified else "the class"
            return f"Enter {rendered}. Python is running {owner}'s initializer for the newly created object; self refers to that object."
        dunder_actions = {
            "__str__": "Python requested user-friendly text for this object",
            "__repr__": "Python requested a developer representation of this object",
            "__len__": "Python requested this object's length",
            "__iter__": "Python is starting iteration over this object",
            "__next__": "Python is requesting the next item from this iterator",
            "__enter__": "Python is entering a with block",
            "__exit__": "Python is leaving a with block",
            "__call__": "Python is calling this object like a function",
            "__eq__": "Python is comparing this object with ==",
            "__bool__": "Python needs to decide whether this object is true or false",
            "__contains__": "Python is checking membership with in",
            "__getitem__": "Python is reading an item through square brackets",
            "__setitem__": "Python is assigning an item through square brackets",
            "__add__": "Python is applying + with this object on the left",
            "__sub__": "Python is applying - with this object on the left",
            "__lt__": "Python is comparing this object with <",
            "__hash__": "Python needs this object's hash value",
        }
        if function_name in dunder_actions:
            return f"Enter {rendered}. {dunder_actions[function_name]}, so it called this special method."
        if kind == "method":
            return f"Enter user-defined method {rendered}. Step Mode can follow its statements or step over the recorded call."
        return f"Enter user-defined function {rendered}. Step Mode can follow its statements or step over the recorded call."

    def call_kind(self, qualified: str, function_name: str, argument_names: list[str]) -> str:
        cleaned = qualified.replace(".<locals>", "")
        if cleaned in self.user_classes or (function_name in self.user_classes and "." not in cleaned):
            return "class body"
        if cleaned in self.user_methods or (argument_names and argument_names[0] in {"self", "cls"}):
            return "method"
        return "function"

    def _describe_common_call(self, call: ast.Call, path: str) -> str:
        args = [self._segment(item) for item in call.args]
        if isinstance(call.func, ast.Attribute):
            owner = self._segment(call.func.value, "the value")
            method = call.func.attr
            descriptions = {
                "upper": f"Create an uppercase copy of string {owner}; the original string is unchanged.",
                "lower": f"Create a lowercase copy of string {owner}; the original string is unchanged.",
                "strip": f"Return a copy of string {owner} with matching characters removed from both ends.",
                "lstrip": f"Return a copy of string {owner} with matching characters removed from the left end.",
                "rstrip": f"Return a copy of string {owner} with matching characters removed from the right end.",
                "split": f"Split string {owner} into a list of smaller strings using {args[0] if args else 'whitespace'} as the separator.",
                "join": f"Join the strings from {args[0] if args else 'the iterable'} using {owner} between each item.",
                "replace": f"Return a copy of string {owner} with {args[0] if args else 'the old text'} replaced by {args[1] if len(args) > 1 else 'new text'}.",
                "find": f"Find the first position of {args[0] if args else 'the requested text'} in string {owner}, returning -1 when it is absent.",
                "capitalize": f"Return a copy of string {owner} with its first character capitalized and remaining characters lowercased.",
                "title": f"Return a title-cased copy of string {owner}, capitalizing the start of each word.",
                "startswith": f"Check whether string {owner} begins with {args[0] if args else 'the requested prefix'}.",
                "endswith": f"Check whether string {owner} ends with {args[0] if args else 'the requested suffix'}.",
                "format": f"Insert the supplied values into the replacement fields of string {owner}.",
                "isdigit": f"Check whether string {owner} is nonempty and contains only digit characters.",
                "isalpha": f"Check whether string {owner} is nonempty and contains only alphabetic characters.",
                "append": f"Add {args[0] if args else 'one item'} to the end of list {owner}. This changes the list in place.",
                "extend": f"Add every item from {args[0] if args else 'the iterable'} to the end of list {owner}. This changes the list in place.",
                "insert": f"Insert {args[1] if len(args) > 1 else 'an item'} into list {owner} at index {args[0] if args else 'the requested position'}.",
                "remove": f"Remove the first item equal to {args[0] if args else 'the requested value'} from list {owner}.",
                "pop": f"Remove and return an item from {owner}, using {args[0] if args else 'the last position'} as its index.",
                "sort": f"Sort list {owner} in place. The method changes the list and returns None.",
                "reverse": f"Reverse list {owner} in place. The method changes the list and returns None.",
                "clear": f"Remove every item from {owner}. This changes the collection in place.",
                "copy": f"Create a shallow copy of {owner}; nested objects are still shared.",
                "index": f"Find the position of the first matching value in {owner}; raise ValueError if it is absent.",
                "count": f"Count how many times the requested value appears in {owner}.",
            }
            if method in descriptions:
                return descriptions[method]
        builtins = {
            "len": f"Count the items in {args[0] if args else 'the value'} and return that integer.",
            "range": f"Create a sequence of integers from the supplied bounds; the stop value is not included.",
            "enumerate": f"Pair each item from {args[0] if args else 'the iterable'} with a running index.",
            "zip": "Group items from the supplied iterables by position, stopping when the shortest iterable ends.",
            "sum": f"Add the numeric items from {args[0] if args else 'the iterable'} and return the total.",
            "min": "Return the smallest supplied item.",
            "max": "Return the largest supplied item.",
            "sorted": f"Return a new sorted list from {args[0] if args else 'the iterable'} without changing the original.",
            "any": f"Return True if at least one item from {args[0] if args else 'the iterable'} is truthy.",
            "all": f"Return True only if every item from {args[0] if args else 'the iterable'} is truthy.",
            "int": f"Convert {args[0] if args else 'the value'} to an integer.",
            "float": f"Convert {args[0] if args else 'the value'} to a floating-point number.",
            "str": f"Convert {args[0] if args else 'the value'} to text.",
            "list": f"Create a list from {args[0] if args else 'no starting items'}.",
            "dict": "Create a dictionary from the supplied keys and values.",
            "set": f"Create a set of unique items from {args[0] if args else 'the supplied values'}.",
            "type": f"Return the type of {args[0] if args else 'the value'}.",
            "isinstance": f"Check whether {args[0] if args else 'the value'} belongs to the requested type.",
            "print": "Display the supplied values in the program output.",
            "input": f"Display {args[0] if args else 'a prompt'}, wait for the user, and return the entered text as a string.",
        }
        return builtins.get(path, "")

    def _describe_call(self, call: ast.Call) -> str:
        path = self._call_path(call.func)
        if path == "open" or path.endswith(".open"):
            return self._describe_open(call)
        if isinstance(call.func, ast.Attribute):
            owner = self._segment(call.func.value, "the object")
            method = call.func.attr
            if method in {"read", "readline", "readlines", "write", "writelines", "seek", "tell", "flush", "truncate", "close"}:
                return self._describe_file_method(call, owner, method)
            if method in {"writerow", "writerows", "writeheader"}:
                return self._describe_csv_call(call, path)
            if isinstance(call.func.value, ast.Call) and self._call_path(call.func.value.func) == "super":
                if method == "__init__":
                    return "Call the parent class initializer through super(), so inherited setup runs before this class adds its own setup."
                return f"Call the parent class method {method} through super(), using the current object."
        origin = self._import_origin(path)
        csv_path = origin if origin in {"csv.reader", "csv.DictReader", "csv.writer", "csv.DictWriter"} else path
        if csv_path in {"csv.reader", "csv.DictReader", "csv.writer", "csv.DictWriter"}:
            return self._describe_csv_call(call, csv_path)
        common = self._describe_common_call(call, path)
        if common:
            return common
        if origin:
            return (
                f"Call {origin} from an imported module. Step Mode does not enter imported library code; "
                "it continues with the next recorded statement in this file."
            )
        if isinstance(call.func, ast.Name) and call.func.id in self.user_functions:
            return f"Call user-defined function {self._segment(call)}. You can step into its code or step over the recorded call."
        if isinstance(call.func, ast.Name) and call.func.id in self.user_classes:
            return f"Create a {call.func.id} object. Python will call its __init__ method when one is defined."
        if isinstance(call.func, ast.Attribute) and call.func.attr in {item.rsplit(".", 1)[-1] for item in self.user_methods}:
            return f"Call user-defined method {self._segment(call)}. You can step into its code or step over the recorded call."
        return f"Run the function call {self._segment(call, 'shown on this line')}."

    def describe_line(self, line: int) -> str:
        node = self.nodes.get(line)
        code = self.source_line(line)
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            names = ", ".join(self._segment(target, "a variable") for target in targets)
            value = self._segment(node.value, "the expression")
            if isinstance(node.value, ast.Call):
                return f"{self._describe_call(node.value)} Save the returned value as {names}."
            return f"Calculate {value}, then save the result as {names}."
        if isinstance(node, ast.AugAssign):
            symbols = {
                ast.Add: "+=", ast.Sub: "-=", ast.Mult: "*=", ast.Div: "/=",
                ast.FloorDiv: "//=", ast.Mod: "%=", ast.Pow: "**=",
                ast.BitAnd: "&=", ast.BitOr: "|=", ast.BitXor: "^=",
                ast.LShift: "<<=", ast.RShift: ">>=", ast.MatMult: "@=",
            }
            symbol = symbols.get(type(node.op), "an update operation")
            return (
                f"Update {self._segment(node.target, 'the variable')} by applying {symbol} "
                f"with {self._segment(node.value)}, then save the new value."
            )
        if isinstance(node, ast.If):
            return f"Test the condition {self._segment(node.test)}, then follow the branch that matches the result."
        if isinstance(node, ast.For):
            return (
                f"Get the next item from {self._segment(node.iter)} and place it in "
                f"{self._segment(node.target, 'the loop variable')}."
            )
        if isinstance(node, ast.While):
            return f"Test {self._segment(node.test)}. Repeat the loop only while this condition is true."
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            qualified, kind = self.definition_by_line.get(line, (node.name, "function"))
            if node.name.startswith("__") and node.name.endswith("__"):
                return self._describe_dunder_definition(qualified, node.name)
            if kind == "method":
                return f"Define method {qualified} for objects of this class. Its body runs only when the method is called."
            return f"Create function {qualified} so it can be called later. Its body does not run yet."
        if isinstance(node, ast.ClassDef):
            return f"Create class {node.name}. The class groups data and methods into a reusable object type."
        if isinstance(node, ast.Return):
            return f"Send {self._segment(node.value, 'None')} back to the code that called this function."
        if isinstance(node, ast.Expr):
            if isinstance(node.value, ast.Call):
                return self._describe_call(node.value)
            return f"Evaluate {self._segment(node.value)}."
        if isinstance(node, ast.Import):
            imports = ", ".join(
                f"{alias.name}" + (f" as {alias.asname}" if alias.asname else "")
                for alias in node.names
            )
            return f"Import {imports}. Calls into that module stay outside Step Mode; playback continues in this file."
        if isinstance(node, ast.ImportFrom):
            names = ", ".join(alias.asname or alias.name for alias in node.names)
            return f"Import {names} from {node.module or 'the module'}. Step Mode explains the call but does not enter library source."
        if isinstance(node, ast.With):
            for item in node.items:
                if isinstance(item.context_expr, ast.Call):
                    path = self._call_path(item.context_expr.func)
                    if path == "open" or path.endswith(".open"):
                        target = self._segment(item.optional_vars, "the file variable") if item.optional_vars else ""
                        return self._describe_open(item.context_expr, target, managed=True)
            return "Enter this managed with block. Python will clean up its context when the block ends."
        if isinstance(node, ast.Try):
            return "Begin a protected block; a matching except block can handle an error raised here."
        if isinstance(node, ast.Raise):
            return f"Raise {self._segment(node.exc, 'an exception')} and stop the normal flow."
        if isinstance(node, ast.Assert):
            return f"Verify that {self._segment(node.test)} is true; otherwise raise AssertionError."
        if isinstance(node, ast.Break):
            return "Leave the current loop immediately."
        if isinstance(node, ast.Continue):
            return "Skip the rest of this iteration and begin the next one."
        if isinstance(node, ast.Pass):
            return "Do nothing here, then continue to the next statement."
        return f"Execute: {code or 'this line'}."


class TraceRecorder:
    def __init__(self, source: str, display_name: str, max_steps: int = MAX_TRACE_STEPS):
        self.source = source
        self.display_name = display_name
        self.max_steps = max(10, int(max_steps))
        self.narrator = SourceNarrator(source)
        self.output = TraceOutput()
        self.steps: list[dict[str, Any]] = []
        self.inputs: list[dict[str, Any]] = []
        self.truncated = False
        self.exception: dict[str, Any] | None = None
        self._last_variables_by_frame: dict[int, dict[str, str]] = {}
        self._frame_call_ids: dict[int, int] = {}
        self._call_step_indexes: dict[int, int] = {}
        self._call_end_indexes: dict[int, int] = {}
        self._exception_call_ids: set[int] = set()
        self._next_call_id = 1
        self._estimated_chars = 0

    def _is_main_file(self, frame: FrameType) -> bool:
        return str(frame.f_code.co_filename) == self.display_name

    def _student_frame(self, frame: FrameType | None) -> FrameType | None:
        current = frame
        while current is not None:
            if self._is_main_file(current):
                return current
            current = current.f_back
        return None

    def _variables(self, frame: FrameType) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        locals_rows: list[dict[str, Any]] = []
        global_rows: list[dict[str, Any]] = []
        local_names = set(frame.f_locals)

        def rows(mapping: dict[str, Any], scope: str, skip: set[str] | None = None) -> list[dict[str, Any]]:
            result = []
            for name in sorted(mapping, key=str.casefold):
                if len(result) >= MAX_VISIBLE_VARIABLES:
                    break
                if not isinstance(name, str) or name.startswith("__") or (skip and name in skip):
                    continue
                value = mapping[name]
                result.append(
                    {
                        "name": _clip(name, 100),
                        "type": _value_kind(value),
                        "value": safe_value(value),
                        "scope": scope,
                    }
                )
            return result

        locals_rows = rows(frame.f_locals, "local")
        if frame.f_code.co_name != "<module>":
            global_rows = rows(frame.f_globals, "global", local_names)
        remaining = max(0, MAX_VISIBLE_VARIABLES - len(locals_rows))
        return locals_rows[:MAX_VISIBLE_VARIABLES], global_rows[:remaining]

    def _add_step(self, step: dict[str, Any], frame: FrameType | None = None) -> None:
        if len(self.steps) >= self.max_steps:
            self.truncated = True
            raise TraceLimitReached("Step Mode stopped after reaching its trace limit")
        if frame is not None:
            local_rows, global_rows = self._variables(frame)
            current = {f"{row['scope']}:{row['name']}": row["value"] for row in (*local_rows, *global_rows)}
            previous = self._last_variables_by_frame.get(id(frame), {})
            changed = sorted(key.split(":", 1)[1] for key, value in current.items() if previous.get(key) != value)
            self._last_variables_by_frame[id(frame)] = current
            step["locals"] = local_rows
            step["globals"] = global_rows
            step["changed"] = changed[:MAX_VISIBLE_VARIABLES]
        step.setdefault("locals", [])
        step.setdefault("globals", [])
        step.setdefault("changed", [])
        step["outputLength"] = self.output.tell()
        step["index"] = len(self.steps)
        estimate = len(str(step.get("narration", ""))) + len(str(step.get("source", ""))) + 180
        for row in (*step.get("locals", []), *step.get("globals", [])):
            estimate += len(row.get("name", "")) + len(row.get("type", "")) + len(row.get("value", "")) + 40
        if self._estimated_chars + estimate > MAX_TRACE_ESTIMATED_CHARS:
            self.truncated = True
            raise TraceLimitReached("Step Mode stopped after reaching its trace size limit")
        self._estimated_chars += estimate
        self.steps.append(step)

    def _depth(self, frame: FrameType | None) -> int:
        depth = 0
        parent = frame.f_back if frame is not None else None
        while parent is not None:
            if self._is_main_file(parent):
                depth += 1
            parent = parent.f_back
        return depth

    def _parent_call_id(self, frame: FrameType) -> int:
        parent = frame.f_back
        while parent is not None:
            if self._is_main_file(parent):
                return int(self._frame_call_ids.get(id(parent), 0))
            parent = parent.f_back
        return 0

    @staticmethod
    def _return_narration(qualified: str, function_name: str, rendered: str) -> str:
        if function_name == "__init__":
            owner = qualified.rsplit(".", 1)[0] if "." in qualified else "The class"
            return f"{qualified} finishes. The new {owner} object is now initialized and ready to use."
        if function_name == "__str__":
            return f"{qualified} returns {rendered} as the object's user-friendly text."
        if function_name == "__repr__":
            return f"{qualified} returns {rendered} as the object's developer representation."
        if function_name == "__len__":
            return f"{qualified} returns {rendered} as the object's length."
        if function_name == "__enter__":
            return f"{qualified} returns {rendered} for the with block to use."
        if function_name == "__exit__":
            return f"{qualified} finishes with {rendered}; this decides whether a with-block exception is suppressed."
        return f"{qualified} finishes and returns {rendered} to its caller."

    def trace(self, frame: FrameType, event: str, arg: Any) -> Callable | None:
        if not self._is_main_file(frame):
            return self.trace
        line = max(1, int(frame.f_lineno or 1))
        function_name = frame.f_code.co_name
        qualified = getattr(frame.f_code, "co_qualname", function_name)
        depth = self._depth(frame)
        if event == "call" and function_name == "<module>":
            self._frame_call_ids[id(frame)] = 0
        elif event == "call":
            args = []
            arg_count = frame.f_code.co_argcount + frame.f_code.co_kwonlyargcount
            argument_names = list(frame.f_code.co_varnames[:arg_count])
            for name in argument_names:
                if name in frame.f_locals:
                    args.append(f"{name}={safe_value(frame.f_locals[name])}")
            call_id = self._next_call_id
            self._next_call_id += 1
            self._frame_call_ids[id(frame)] = call_id
            kind = self.narrator.call_kind(qualified, function_name, argument_names)
            parent_call_id = self._parent_call_id(frame)
            step_index = len(self.steps)
            self._add_step(
                {
                    "event": "call",
                    "line": line,
                    "function": function_name,
                    "qualifiedFunction": qualified,
                    "callKind": kind,
                    "callId": call_id,
                    "parentCallId": parent_call_id,
                    "supportsStepChoice": kind in {"function", "method"},
                    "depth": depth,
                    "source": self.narrator.source_line(line),
                    "narration": self.narrator.describe_call_frame(qualified, function_name, args, kind),
                    "arguments": args,
                },
                frame,
            )
            self._call_step_indexes[call_id] = step_index
        elif event == "line":
            call_id = int(self._frame_call_ids.get(id(frame), 0))
            self._add_step(
                {
                    "event": "line",
                    "line": line,
                    "function": function_name,
                    "qualifiedFunction": qualified,
                    "callId": call_id,
                    "depth": depth,
                    "source": self.narrator.source_line(line),
                    "narration": self.narrator.describe_line(line),
                },
                frame,
            )
        elif event == "exception":
            current: FrameType | None = frame
            while current is not None:
                if self._is_main_file(current):
                    call_id = int(self._frame_call_ids.get(id(current), 0))
                    if call_id:
                        self._exception_call_ids.add(call_id)
                current = current.f_back
        elif event == "return" and function_name != "<module>":
            call_id = int(self._frame_call_ids.get(id(frame), 0))
            rendered = safe_value(arg)
            self._add_step(
                {
                    "event": "return",
                    "line": line,
                    "function": function_name,
                    "qualifiedFunction": qualified,
                    "callId": call_id,
                    "depth": depth,
                    "source": self.narrator.source_line(line),
                    "returnValue": rendered,
                    "narration": self._return_narration(qualified, function_name, rendered),
                },
                frame,
            )
            if call_id:
                self._call_end_indexes[call_id] = len(self.steps) - 1
            self._last_variables_by_frame.pop(id(frame), None)
        return self.trace

    def make_input(self, real_stdout: Any, stdin: Any, input_token: str) -> Callable[[Any], str]:
        def traced_input(prompt: Any = "") -> str:
            prompt_text = str(prompt) if prompt else ""
            if prompt_text:
                self.output.write(prompt_text)
                real_stdout.write(prompt_text)
            real_stdout.write(f"{input_token}\n")
            real_stdout.flush()
            line = stdin.readline()
            value = line.rstrip("\n").rstrip("\r")
            self.output.write(value + "\n")
            frame = self._student_frame(__import__("sys")._getframe(1))
            line_number = int(frame.f_lineno) if frame is not None else 1
            row = {"prompt": _clip(prompt_text, 300), "value": _clip(value, 2_000), "line": line_number}
            self.inputs.append(row)
            self._add_step(
                {
                    "event": "input",
                    "line": line_number,
                    "function": frame.f_code.co_name if frame is not None else "<module>",
                    "qualifiedFunction": getattr(frame.f_code, "co_qualname", frame.f_code.co_name) if frame is not None else "<module>",
                    "callId": int(self._frame_call_ids.get(id(frame), 0)) if frame is not None else 0,
                    "depth": self._depth(frame),
                    "source": self.narrator.source_line(line_number),
                    "input": row,
                    "narration": (
                        f"The program displayed {prompt_text!r} and received {value!r}. "
                        "Step Mode saved this response for playback, so it will not ask again."
                    ),
                },
                frame,
            )
            return value

        return traced_input

    def record_uncaught_exception(
        self,
        exc: BaseException,
        traceback_obj: TracebackType | None,
        safe_traceback: str,
    ) -> None:
        frame = None
        tb = traceback_obj
        while tb is not None:
            if self._is_main_file(tb.tb_frame):
                frame = tb.tb_frame
            tb = tb.tb_next
        line = int(getattr(exc, "lineno", 0) or (frame.f_lineno if frame is not None else 1))
        error_type = type(exc).__name__
        try:
            message = _clip(str(exc), 2_000)
        except BaseException:
            message = "The exception message could not be displayed safely."
        source_line = self.narrator.source_line(line)
        troubleshooting = self._troubleshooting(error_type, message, source_line, frame)
        narration = f"Python stopped with {error_type}{(': ' + message) if message else ''}. "
        if source_line:
            narration += f"The error occurred while running `{source_line}`. "
        narration += "Review the captured values and troubleshooting steps below."
        exception_data = {
            "type": error_type,
            "message": message,
            "line": line,
            "source": source_line,
            "traceback": _clip(safe_traceback, 12_000),
            "troubleshooting": troubleshooting,
        }
        self.exception = exception_data
        if safe_traceback:
            if self.output.tell() and not self.output.getvalue().endswith("\n"):
                self.output.write("\n")
            self.output.write(safe_traceback)
        # A trace-limit event may already have filled the bounded list. Replace
        # its last ordinary event so the student always receives the reason the
        # trace ended.
        step = {
            "event": "exception",
            "line": line,
            "function": frame.f_code.co_name if frame is not None else "<module>",
            "qualifiedFunction": getattr(frame.f_code, "co_qualname", frame.f_code.co_name) if frame is not None else "<module>",
            "callId": int(self._frame_call_ids.get(id(frame), 0)) if frame is not None else 0,
            "depth": self._depth(frame),
            "source": source_line,
            "narration": narration,
            "exception": exception_data,
        }
        if len(self.steps) >= self.max_steps:
            self.steps[-1] = {**step, "index": len(self.steps) - 1, "locals": [], "globals": [], "changed": [], "outputLength": self.output.tell()}
        else:
            try:
                self._add_step(step, frame)
            except TraceLimitReached:
                self.truncated = True
                replacement = {**step, "index": max(0, len(self.steps) - 1), "locals": [], "globals": [], "changed": [], "outputLength": self.output.tell()}
                if self.steps:
                    self.steps[-1] = replacement
                else:
                    self.steps.append(replacement)

    def _troubleshooting(
        self,
        error_type: str,
        message: str,
        source_line: str,
        frame: FrameType | None,
    ) -> list[str]:
        variables = {}
        if frame is not None:
            variables.update(frame.f_globals)
            variables.update(frame.f_locals)
        visible = {
            name: safe_value(value)
            for name, value in variables.items()
            if isinstance(name, str) and not name.startswith("__")
        }
        details = []
        if source_line:
            referenced = [name for name in visible if re.search(rf"\b{re.escape(name)}\b", source_line)]
            if referenced:
                filled = ", ".join(f"{name} = {visible[name]}" for name in referenced[:8])
                details.append(f"At this line, the relevant values were: {filled}.")

        advice: dict[str, list[str]] = {
            "NameError": [
                "Check the spelling and capitalization of every name on this line.",
                "Make sure the variable is assigned before this line runs and that it is in the current scope.",
            ],
            "UnboundLocalError": [
                "Python treats this name as local because it is assigned inside the function.",
                "Assign it before reading it, pass it as an argument, or deliberately declare the intended outer scope.",
            ],
            "TypeError": [
                "Compare the displayed variable types with the operation on the failing line.",
                "Convert input text explicitly when a numeric value is required, for example with int(...) or float(...).",
            ],
            "ValueError": [
                "The value has the right general type but an unacceptable format or range.",
                "Inspect the value shown above and validate it before converting or using it.",
            ],
            "IndexError": [
                "A sequence index is outside the available positions.",
                "Check len(sequence) and remember that valid indexes run from 0 through len(sequence) - 1.",
            ],
            "KeyError": [
                "The requested dictionary key is not present.",
                "Inspect the dictionary's keys or use dictionary.get(key) when a missing key is expected.",
            ],
            "ZeroDivisionError": [
                "The divisor evaluated to zero on this execution path.",
                "Check the divisor before dividing and decide what the program should do when it is zero.",
            ],
            "AttributeError": [
                "The object does not provide the requested attribute or method.",
                "Check the object's displayed type and the spelling of the attribute after the dot.",
            ],
            "FileNotFoundError": [
                "The requested file was not found in the program's current workspace folder.",
                "Check the filename, extension, capitalization, and relative folder path.",
            ],
            "ModuleNotFoundError": [
                "The module is unavailable or its name is misspelled.",
                "Use a classroom-approved module or place the local module inside the same student workspace.",
            ],
            "RecursionError": [
                "The function kept calling itself without reaching a stopping case.",
                "Verify the base case and confirm that each recursive call moves closer to it.",
            ],
            "AssertionError": [
                "The asserted condition evaluated to false.",
                "Compare the expected condition with the variable values shown for this step.",
            ],
            "SyntaxError": [
                "Python could not parse the program, so execution never began.",
                "Check punctuation, matching parentheses and quotes, and the statement immediately before the highlighted line.",
            ],
            "IndentationError": [
                "Python found indentation that does not form a valid block.",
                "Use consistent spaces and align this line with neighboring statements in the same block.",
            ],
        }
        details.extend(advice.get(error_type, [
            "Read the final traceback entry first; it identifies the exception type and closest student-code line.",
            "Compare the operation on that line with the captured variable values, then correct one assumption at a time.",
        ]))

        if error_type == "NameError":
            match = re.search(r"name ['\"]([^'\"]+)['\"] is not defined", message)
            if match:
                missing = match.group(1)
                matches = difflib.get_close_matches(missing, list(visible), n=3, cutoff=0.55)
                if matches:
                    details.insert(0, f"`{missing}` is undefined. Did you mean {', '.join(f'`{name}`' for name in matches)}?")
        return details

    def result(self) -> dict[str, Any]:
        final_index = max(0, len(self.steps) - 1)
        for call_id, step_index in self._call_step_indexes.items():
            if not (0 <= step_index < len(self.steps)):
                continue
            step = self.steps[step_index]
            end_index = self._call_end_indexes.get(call_id)
            has_exception = call_id in self._exception_call_ids
            can_step_over = bool(
                step.get("supportsStepChoice")
                and not has_exception
                and end_index is not None
            )
            step["hasException"] = has_exception
            step["canStepOver"] = can_step_over
            if end_index is not None:
                step["callEndIndex"] = end_index
                step["stepOverIndex"] = min(final_index, end_index + 1)
        return {
            "version": 1,
            "language": "python",
            "steps": self.steps,
            "definedItems": self.narrator.defined_items,
            "output": self.output.getvalue(),
            "outputTruncated": self.output.truncated,
            "inputs": self.inputs,
            "truncated": self.truncated,
            "exception": self.exception,
        }
