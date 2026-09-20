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
from pathlib import Path
from types import FrameType, TracebackType
from typing import Any, Callable


MAX_TRACE_STEPS = 2_000
MAX_TRACE_OUTPUT_CHARS = 200_000
MAX_VISIBLE_VARIABLES = 80
MAX_VALUE_CHARS = 240
MAX_CONTAINER_ITEMS = 12
MAX_CONTAINER_DEPTH = 3
MAX_TRACE_ESTIMATED_CHARS = 3_500_000


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
    if isinstance(value, type):
        return f"<class {_safe_type_name(value)}>"
    if callable(value):
        name = getattr(value, "__name__", _safe_type_name(value))
        return f"<{_safe_type_name(value)} {_clip(name, 80)}>"
    return f"<{_safe_type_name(value)} instance>"


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
        try:
            tree = ast.parse(source)
        except SyntaxError:
            tree = None
        if tree is not None:
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

    def describe_line(self, line: int) -> str:
        node = self.nodes.get(line)
        code = self.source_line(line)
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            names = ", ".join(self._segment(target, "a variable") for target in targets)
            value = self._segment(node.value, "the expression")
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
            return f"Create the function {node.name} so it can be called later. Its body does not run yet."
        if isinstance(node, ast.Return):
            return f"Send {self._segment(node.value, 'None')} back to the code that called this function."
        if isinstance(node, ast.Expr):
            if isinstance(node.value, ast.Call):
                return f"Run the function call {self._segment(node.value, 'shown on this line')}."
            return f"Evaluate {self._segment(node.value)}."
        if isinstance(node, ast.Import):
            return "Load the named module so its tools are available to this program."
        if isinstance(node, ast.ImportFrom):
            return f"Load selected tools from {node.module or 'the module'}."
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
        self._estimated_chars = 0

    def _student_frame(self, frame: FrameType | None) -> FrameType | None:
        current = frame
        while current is not None:
            if Path(str(current.f_code.co_filename)).name == self.display_name:
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
                        "type": _safe_type_name(value),
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

    def trace(self, frame: FrameType, event: str, arg: Any) -> Callable | None:
        if Path(str(frame.f_code.co_filename)).name != self.display_name:
            return self.trace
        line = max(1, int(frame.f_lineno or 1))
        function_name = frame.f_code.co_name
        depth = 0
        parent = frame.f_back
        while parent is not None:
            if Path(str(parent.f_code.co_filename)).name == self.display_name:
                depth += 1
            parent = parent.f_back
        if event == "call" and function_name != "<module>":
            args = []
            arg_count = frame.f_code.co_argcount + frame.f_code.co_kwonlyargcount
            for name in frame.f_code.co_varnames[:arg_count]:
                if name in frame.f_locals:
                    args.append(f"{name}={safe_value(frame.f_locals[name])}")
            self._add_step(
                {
                    "event": "call",
                    "line": line,
                    "function": function_name,
                    "depth": depth,
                    "source": self.narrator.source_line(line),
                    "narration": f"Enter {function_name}({', '.join(args)}).",
                    "arguments": args,
                },
                frame,
            )
        elif event == "line":
            self._add_step(
                {
                    "event": "line",
                    "line": line,
                    "function": function_name,
                    "depth": depth,
                    "source": self.narrator.source_line(line),
                    "narration": self.narrator.describe_line(line),
                },
                frame,
            )
        elif event == "return" and function_name != "<module>":
            rendered = safe_value(arg)
            self._add_step(
                {
                    "event": "return",
                    "line": line,
                    "function": function_name,
                    "depth": depth,
                    "source": self.narrator.source_line(line),
                    "returnValue": rendered,
                    "narration": f"{function_name} finishes and returns {rendered} to its caller.",
                },
                frame,
            )
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
                    "depth": 0,
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
            if Path(str(tb.tb_frame.f_code.co_filename)).name == self.display_name:
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
            "depth": 0,
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
        return {
            "version": 1,
            "language": "python",
            "steps": self.steps,
            "output": self.output.getvalue(),
            "outputTruncated": self.output.truncated,
            "inputs": self.inputs,
            "truncated": self.truncated,
            "exception": self.exception,
        }
