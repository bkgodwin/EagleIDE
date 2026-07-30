#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import socket as _compat_socket
import subprocess as _compat_subprocess
from pathlib import Path
from typing import Any

from sandbox_containment import apply_landlock
from sandbox_policy import (
    CONTAINMENT_REQUIRED_MODULES,
    SECURITY_LOCKED_EXACT_MODULES,
    SECURITY_LOCKED_MODULES,
    is_student_module_root,
)

INPUT_TOKEN = "[[_IDE_INPUT_]]"
MAX_MEMORY_BYTES = max(32 * 1024 * 1024, int(os.environ.get("EAGLE_MAX_MEMORY_BYTES", 750 * 1024 * 1024)))
MAX_CPU_SECONDS = max(1, int(os.environ.get("EAGLE_MAX_CPU_SECONDS", 8)))
MAX_FILE_BYTES = max(1024, int(os.environ.get("EAGLE_MAX_FILE_BYTES", 10 * 1024 * 1024)))
MAX_WRITE_BYTES = max(0, int(os.environ.get("EAGLE_RUN_WRITE_BUDGET_BYTES", 10 * 1024 * 1024)))
MAX_NEW_FILES = 20
RUNNER_TASK_HEADROOM = 32
MAX_NOFILE = 64
SYSTEM_FONT_READONLY_PATHS = (
    "/usr/share/fonts",
    "/usr/local/share/fonts",
    "/usr/X11R6/lib/X11/fonts",
    "/usr/X11/lib/X11/fonts",
    "/usr/lib/openoffice/share/fonts/truetype",
)

BLOCKED_OS_CALLS = (
    "system",
    "popen",
    "fork",
    "forkpty",
    "execv",
    "execve",
    "execvp",
    "execvpe",
    "spawnl",
    "spawnle",
    "spawnlp",
    "spawnlpe",
    "spawnv",
    "spawnve",
    "spawnvp",
    "spawnvpe",
    "chdir",
)
READ_GUARDED_OS_PATH_CALLS = ("listdir", "scandir", "walk", "readlink")
WRITE_GUARDED_OS_PATH_CALLS = ("remove", "unlink", "rmdir", "removedirs", "mkdir", "makedirs")


class PathPolicy:
    __slots__ = (
        "allowed_root",
        "_cwd",
        "_abspath",
        "_commonpath",
        "_fspath",
        "_isabs",
        "_isdir",
        "_isfile",
        "_join",
        "_realpath",
    )

    def __init__(self, allowed_root: str):
        import os

        self._fspath = os.fspath
        self._isabs = os.path.isabs
        self._isdir = os.path.isdir
        self._isfile = os.path.isfile
        self._join = os.path.join
        self._abspath = os.path.abspath
        self._realpath = os.path.realpath
        self._commonpath = os.path.commonpath
        self.allowed_root = self._realpath(self._abspath(allowed_root))
        cwd = self._realpath(self._abspath(os.getcwd()))
        try:
            if self._commonpath([cwd, self.allowed_root]) == self.allowed_root:
                self._cwd = cwd
            else:
                self._cwd = self.allowed_root
        except ValueError:
            self._cwd = self.allowed_root

    def normalize(self, target: Any) -> str:
        target_path = self._fspath(target)
        if not self._isabs(target_path):
            target_path = self._join(self._cwd, target_path)
        return self._realpath(self._abspath(target_path))

    def assert_allowed(self, normalized_path: str, original: Any) -> None:
        try:
            common = self._commonpath([normalized_path, self.allowed_root])
        except (TypeError, ValueError):
            raise PermissionError(f"Access to {original!r} is not allowed in this environment")
        if common != self.allowed_root:
            raise PermissionError(f"Access to {original!r} is not allowed in this environment")

    def has_local_module(self, root: str) -> bool:
        """Return whether a top-level import resolves to student workspace code."""

        name = str(root or "").strip()
        if not name or not name.isidentifier():
            return False
        for base in (self._cwd, self.allowed_root):
            module_file = self._realpath(self._join(base, f"{name}.py"))
            package_dir = self._realpath(self._join(base, name))
            try:
                self.assert_allowed(module_file, module_file)
                self.assert_allowed(package_dir, package_dir)
            except PermissionError:
                continue
            if self._isfile(module_file) or self._isdir(package_dir):
                return True
        return False


class WriteBudget:
    __slots__ = ("remaining_bytes", "remaining_files")

    def __init__(self, remaining_bytes: int, remaining_files: int):
        self.remaining_bytes = max(0, int(remaining_bytes))
        self.remaining_files = max(0, int(remaining_files))

    def reserve_file(self) -> None:
        if self.remaining_files <= 0:
            raise OSError("Per-run file creation limit reached")
        self.remaining_files -= 1

    def consume(self, data: Any, encoding: str = "utf-8") -> None:
        if isinstance(data, str):
            amount = len(data.encode(encoding or "utf-8", errors="replace"))
        else:
            amount = len(data)
        if amount > self.remaining_bytes:
            raise OSError("Per-run file write limit reached")
        self.remaining_bytes -= amount


class BudgetedFile:
    __slots__ = ("_file", "_budget", "_encoding")

    def __init__(self, file_obj: Any, budget: WriteBudget, encoding: str):
        self._file = file_obj
        self._budget = budget
        self._encoding = encoding

    def write(self, data: Any):
        self._budget.consume(data, self._encoding)
        return self._file.write(data)

    def writelines(self, lines: Any):
        for line in lines:
            self.write(line)

    def __enter__(self):
        self._file.__enter__()
        return self

    def __exit__(self, *args: Any):
        return self._file.__exit__(*args)

    def __iter__(self):
        return iter(self._file)

    def __next__(self):
        return next(self._file)

    def __getattr__(self, name: str):
        if name in {"buffer", "raw", "fileno"}:
            raise PermissionError("Raw file descriptor access is not allowed")
        return getattr(self._file, name)


class SafeOpen:
    __slots__ = ("_normalize", "_assert_allowed", "_opener", "_budget")

    def __init__(self, policy: PathPolicy, budget: WriteBudget):
        import io

        self._normalize = policy.normalize
        self._assert_allowed = policy.assert_allowed
        self._opener = io.open
        self._budget = budget

    def __call__(self, file: Any, mode: str = "r", *args: Any, **kwargs: Any):
        if isinstance(file, int):
            raise PermissionError("File descriptor access is not allowed in this environment")
        normalized_path = self._normalize(file)
        self._assert_allowed(normalized_path, file)
        writable = any(flag in str(mode) for flag in ("w", "a", "x", "+"))
        opened = self._opener(normalized_path, mode, *args, **kwargs)
        if not writable:
            return opened
        encoding = str(kwargs.get("encoding") or getattr(opened, "encoding", None) or "utf-8")
        return BudgetedFile(opened, self._budget, encoding)


class SafeImport:
    __slots__ = (
        "_artifact_manager",
        "_blocked_exact",
        "_blocked_roots",
        "_harden_os_module",
        "_is_allowed_module",
        "_is_local_module",
        "_orig_import",
        "_safe_open",
    )

    def __init__(
        self,
        policy: PathPolicy,
        safe_open: SafeOpen,
        blocked_roots: frozenset[str],
        blocked_exact: frozenset[str],
        artifact_manager: "ChartArtifactManager",
    ):
        self._orig_import = __import__
        self._blocked_roots = blocked_roots
        self._blocked_exact = blocked_exact
        import sys

        self._harden_os_module = _make_os_hardener(
            policy,
            (sys.base_prefix, sys.prefix, *SYSTEM_FONT_READONLY_PATHS),
        )
        self._is_allowed_module = is_student_module_root
        self._is_local_module = policy.has_local_module
        self._safe_open = safe_open
        self._artifact_manager = artifact_manager

    def __call__(
        self,
        name: str,
        globals: dict[str, Any] | None = None,
        locals: dict[str, Any] | None = None,
        fromlist: tuple[str, ...] = (),
        level: int = 0,
    ):
        root = name.split(".", 1)[0]
        if root in self._blocked_roots or name in self._blocked_exact:
            raise ImportError(f"Module {name!r} is not available in this environment")
        if level <= 0 and root and not self._is_allowed_module(root) and not self._is_local_module(root):
            raise ImportError(f"Module {name!r} is not available in this environment")
        module = self._orig_import(name, globals, locals, fromlist, level)
        if root == "os":
            self._harden_os_module(module)
        elif root == "pathlib":
            safe_open = self._safe_open

            def _path_open(path_obj: Any, mode: str = "r", buffering: int = -1, encoding=None, errors=None, newline=None):
                return safe_open(path_obj, mode, buffering, encoding, errors, newline)

            module.Path.open = _path_open
        if root == "matplotlib":
            self._artifact_manager.patch_show()
        return module


def _blocked_call(*_args: Any, **_kwargs: Any):
    raise PermissionError("This operation is not allowed in this environment")


def _make_os_hardener(policy: PathPolicy, trusted_read_roots: tuple[str, ...] = ()):
    realpath = os.path.realpath
    abspath = os.path.abspath
    commonpath = os.path.commonpath
    read_roots = tuple(realpath(abspath(root)) for root in trusted_read_roots)

    def _assert_read_allowed(path: Any) -> str:
        normalized = policy.normalize(path)
        try:
            policy.assert_allowed(normalized, path)
            return normalized
        except PermissionError:
            pass
        for root in read_roots:
            try:
                if commonpath([normalized, root]) == root:
                    return normalized
            except (TypeError, ValueError):
                continue
        raise PermissionError(f"Access to {path!r} is not allowed in this environment")

    def _guarded_os_path_call(os_fn, *, writable: bool):
        def _wrapper(path: Any = ".", *args: Any, **kwargs: Any):
            if writable:
                normalized = policy.normalize(path)
                policy.assert_allowed(normalized, path)
            else:
                normalized = _assert_read_allowed(path)
            return os_fn(normalized, *args, **kwargs)

        return _wrapper

    def _guarded_os_move(os_fn):
        def _wrapper(src: Any, dst: Any, *args: Any, **kwargs: Any):
            src_normalized = policy.normalize(src)
            dst_normalized = policy.normalize(dst)
            policy.assert_allowed(src_normalized, src)
            policy.assert_allowed(dst_normalized, dst)
            return os_fn(src_normalized, dst_normalized, *args, **kwargs)

        return _wrapper

    def _harden(module: Any) -> None:
        if getattr(module, "__sandbox_hardened__", False):
            return
        for fn_name in BLOCKED_OS_CALLS:
            if hasattr(module, fn_name):
                setattr(module, fn_name, _blocked_call)
        for fn_name in READ_GUARDED_OS_PATH_CALLS:
            if hasattr(module, fn_name):
                setattr(module, fn_name, _guarded_os_path_call(getattr(module, fn_name), writable=False))
        for fn_name in WRITE_GUARDED_OS_PATH_CALLS:
            if hasattr(module, fn_name):
                setattr(module, fn_name, _guarded_os_path_call(getattr(module, fn_name), writable=True))
        if hasattr(module, "rename"):
            setattr(module, "rename", _guarded_os_move(getattr(module, "rename")))
        if hasattr(module, "replace"):
            setattr(module, "replace", _guarded_os_move(getattr(module, "replace")))
        setattr(module, "__sandbox_hardened__", True)

    return _harden


def _safe_input(prompt: Any = "") -> str:
    import sys

    if prompt:
        sys.stdout.write(str(prompt))
        sys.stdout.flush()
    sys.stdout.write(f"{INPUT_TOKEN}\n")
    sys.stdout.flush()
    line = sys.stdin.readline()
    user_input = line.rstrip("\n")
    sys.stdout.write(user_input + "\n")
    sys.stdout.flush()
    return user_input


class ChartArtifactManager:
    """Turn ``plt.show()`` into deterministic PNG artifacts."""

    __slots__ = ("_artifact_dir", "_counter", "_patched", "_source_stem")

    def __init__(self, workspace: str):
        source_name = str(os.environ.get("EAGLE_RUN_SOURCE_NAME") or "python-chart")
        source_stem = Path(source_name).stem or "python-chart"
        safe_stem = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in source_stem).strip("-_")
        self._source_stem = safe_stem[:80] or "python-chart"
        workspace_path = Path(workspace).resolve()
        try:
            current_directory = Path.cwd().resolve()
            current_directory.relative_to(workspace_path)
            self._artifact_dir = current_directory
        except (OSError, ValueError):
            self._artifact_dir = workspace_path
        self._counter = 0
        self._patched = False

    def patch_show(self) -> None:
        if self._patched:
            return
        import sys

        pyplot = sys.modules.get("matplotlib.pyplot")
        if pyplot is None:
            return
        self._patched = True

        def save_open_figures(*_args: Any, **_kwargs: Any) -> None:
            figure_numbers = list(pyplot.get_fignums())
            if not figure_numbers:
                print("[Matplotlib: no open figures to save]")
                return
            for figure_number in figure_numbers:
                self._counter += 1
                figure = pyplot.figure(figure_number)
                target = self._artifact_dir / f"{self._source_stem}-figure-{self._counter}.png"
                figure.savefig(target, format="png", dpi=120, bbox_inches="tight")
                pyplot.close(figure)

        pyplot.show = save_open_figures


def _configured_disabled_modules() -> frozenset[str]:
    raw_value = str(os.environ.get("EAGLE_DISABLED_MODULES") or "[]")
    try:
        parsed = json.loads(raw_value)
    except Exception:
        parsed = []
    if not isinstance(parsed, list):
        return frozenset()
    return frozenset(
        str(value).strip()
        for value in parsed
        if str(value).strip() and str(value).strip().replace("_", "").isalnum()
    )


def _prepare_trusted_runtime_compatibility() -> None:
    """Resolve safe lazy runtime types before locked modules are purged.

    Python 3.13 exposes ``types.CapsuleType`` through ``types.__getattr__``,
    which imports the security-locked ``_socket`` extension solely to inspect
    the type of its C API capsule. Pillow imports this type annotation while
    Matplotlib starts. Cache only the inert type object during trusted worker
    bootstrap; the socket modules are still purged/blocked before student code.
    """

    import sys
    import types

    if sys.version_info >= (3, 13) and "CapsuleType" not in vars(types):
        types.CapsuleType = types.CapsuleType


def _apply_native_containment(allowed_root: str, code_path: Path) -> dict[str, Any]:
    import sys

    readonly_paths = {
        code_path,
        Path(__file__).resolve(),
        Path(sys.base_prefix).resolve(),
        Path(sys.prefix).resolve(),
    }
    # CPython extension modules commonly depend on distribution-provided
    # shared libraries outside sys.prefix (for example libsqlite3.so). These
    # locations contain executable/runtime assets rather than private server
    # data, and remain strictly read-only under Landlock.
    if sys.platform == "linux":
        readonly_paths.update(
            Path(path)
            for path in ("/lib", "/lib64", "/usr/lib", "/usr/lib64", "/usr/local/lib")
            if Path(path).exists()
        )
        readonly_paths.update(Path(path) for path in SYSTEM_FONT_READONLY_PATHS if Path(path).exists())
    return apply_landlock(allowed_root, readonly_paths=readonly_paths)


def _purge_security_modules(policy: PathPolicy, disabled_modules: frozenset[str]) -> None:
    """Remove privileged bootstrap modules before untrusted code can inspect them."""

    import sys

    blocked = set(SECURITY_LOCKED_MODULES | disabled_modules)
    # The platform backend is imported by core stdlib modules such as shutil.
    # Keep its already-loaded module object but harden it in place; direct
    # student imports are still rejected by SafeImport.
    platform_roots = {"nt", "posix"}
    for platform_root in platform_roots:
        module = sys.modules.get(platform_root)
        if module is not None:
            for call_name in BLOCKED_OS_CALLS:
                if hasattr(module, call_name):
                    setattr(module, call_name, _blocked_call)
    subprocess_module = sys.modules.get("subprocess")
    if subprocess_module is not None:
        for call_name in (
            "Popen",
            "call",
            "check_call",
            "check_output",
            "getoutput",
            "getstatusoutput",
            "run",
            "_fork_exec",
        ):
            if hasattr(subprocess_module, call_name):
                setattr(subprocess_module, call_name, _blocked_call)
        try:
            _make_os_hardener(
                policy,
                (sys.base_prefix, sys.prefix, *SYSTEM_FONT_READONLY_PATHS),
            )(subprocess_module.os)
        except Exception:
            pass
    socket_module = sys.modules.get("socket")
    if socket_module is not None:
        for call_name in (
            "SocketType",
            "create_connection",
            "create_server",
            "fromfd",
            "getaddrinfo",
            "getfqdn",
            "gethostbyaddr",
            "gethostbyname",
            "gethostbyname_ex",
            "socket",
            "socketpair",
        ):
            if hasattr(socket_module, call_name):
                setattr(socket_module, call_name, _blocked_call)
        # ``socket`` retains the imported C extension in a private module
        # attribute. Remove that reference as well as its public wrappers so a
        # student cannot recover ``_socket.socket`` through sys.modules.
        if hasattr(socket_module, "_socket"):
            setattr(socket_module, "_socket", None)
    # Reloading an already-hardened module could restore privileged process or
    # network functions without a normal import. Student programs do not need
    # runtime module reloads, so remove that bypass while retaining the rest of
    # importlib for normal standard-library dependencies.
    import importlib

    importlib.reload = _blocked_call
    blocked.add("sandbox_containment")
    for module_name in list(sys.modules):
        root = module_name.split(".", 1)[0]
        if root in platform_roots or root in {"socket", "subprocess"}:
            continue
        if module_name == "sandbox_containment" or root in blocked:
            sys.modules.pop(module_name, None)


def _apply_resource_limits() -> None:
    try:
        import resource
    except Exception:
        return
    limits = [
        (resource.RLIMIT_AS, (MAX_MEMORY_BYTES, MAX_MEMORY_BYTES)),
        (resource.RLIMIT_CPU, (MAX_CPU_SECONDS, MAX_CPU_SECONDS + 1)),
        (resource.RLIMIT_FSIZE, (MAX_FILE_BYTES, MAX_FILE_BYTES)),
        (resource.RLIMIT_NOFILE, (MAX_NOFILE, MAX_NOFILE)),
    ]
    if hasattr(resource, "RLIMIT_NPROC"):
        task_limit = _runner_task_limit()
        limits.append((resource.RLIMIT_NPROC, (task_limit, task_limit)))
    if hasattr(resource, "RLIMIT_CORE"):
        limits.append((resource.RLIMIT_CORE, (0, 0)))
    for limit_name, values in limits:
        try:
            resource.setrlimit(limit_name, values)
        except Exception:
            pass


def _runner_task_limit() -> int:
    """Bound worker-created tasks without colliding with the server's UID."""

    if os.name == "nt" or not hasattr(os, "getuid"):
        return 64
    live_tasks = 0
    try:
        uid = int(os.getuid())
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            try:
                status_text = (entry / "status").read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            real_uid = None
            threads = 1
            for line in status_text.splitlines():
                if line.startswith("Uid:"):
                    fields = line.split()
                    real_uid = int(fields[1]) if len(fields) > 1 else None
                elif line.startswith("Threads:"):
                    fields = line.split()
                    threads = max(1, int(fields[1])) if len(fields) > 1 else 1
            if real_uid == uid:
                live_tasks += threads
    except Exception:
        live_tasks = 0
    return max(64, live_tasks + RUNNER_TASK_HEADROOM)


def _build_safe_builtins(
    policy: PathPolicy,
    budget: WriteBudget,
    blocked_roots: frozenset[str],
    blocked_exact: frozenset[str],
    artifact_manager: ChartArtifactManager,
) -> dict[str, Any]:
    builtins_mod = __import__("builtins")
    safe = dict(builtins_mod.__dict__)
    safe_open = SafeOpen(policy, budget)
    safe["open"] = safe_open
    safe["__import__"] = SafeImport(policy, safe_open, blocked_roots, blocked_exact, artifact_manager)
    safe["input"] = _safe_input
    return safe


def _install_audit_hook(
    policy: PathPolicy,
    code_path: Path,
    budget: WriteBudget,
    blocked_roots: frozenset[str],
    blocked_exact: frozenset[str],
) -> None:
    """Enforce the path/import/process boundary across alternate stdlib APIs."""
    import sys

    realpath = os.path.realpath
    abspath = os.path.abspath
    commonpath = os.path.commonpath
    exists = os.path.exists
    module_root_allowed = is_student_module_root
    trusted_read_roots = {
        realpath(abspath(sys.base_prefix)),
        realpath(abspath(sys.prefix)),
        *(realpath(abspath(path)) for path in SYSTEM_FONT_READONLY_PATHS),
    }
    code_file = realpath(abspath(str(code_path)))
    write_flags = 0
    for flag_name in ("O_WRONLY", "O_RDWR", "O_CREAT", "O_TRUNC", "O_APPEND"):
        write_flags |= int(getattr(os, flag_name, 0))

    def _within(path: str, root: str) -> bool:
        try:
            return commonpath([path, root]) == root
        except (TypeError, ValueError):
            return False

    def _normalized(raw: Any) -> str:
        if isinstance(raw, int):
            raise TypeError("File descriptor does not have a path")
        return policy.normalize(raw)

    def _assert_workspace_path(raw: Any) -> None:
        normalized = _normalized(raw)
        policy.assert_allowed(normalized, raw)

    def _assert_read_path(raw: Any) -> None:
        normalized = _normalized(raw)
        try:
            policy.assert_allowed(normalized, raw)
            return
        except PermissionError:
            pass
        if normalized == code_file or any(_within(normalized, root) for root in trusted_read_roots):
            return
        raise PermissionError(f"Access to {raw!r} is not allowed in this environment")

    blocked_events = {
        "ctypes.dlopen",
        "os.exec",
        "os.fork",
        "os.forkpty",
        "os.kill",
        "os.posix_spawn",
        "os.spawn",
        "os.startfile",
        "os.system",
        "pty.spawn",
        "subprocess.Popen",
    }
    workspace_path_events = {
        "os.chdir",
        "os.chmod",
        "os.chown",
        "os.mkdir",
        "os.remove",
        "os.rmdir",
        "os.truncate",
        "os.unlink",
        "os.utime",
    }

    def audit(event: str, args: tuple[Any, ...]) -> None:
        if event == "import" and args:
            name = str(args[0] or "")
            root = name.split(".", 1)[0]
            if root in blocked_roots or name in blocked_exact:
                raise ImportError(f"Module {name!r} is not available in this environment")
            if root and not module_root_allowed(root) and not policy.has_local_module(root):
                raise ImportError(f"Module {name!r} is not available in this environment")
            return
        if event == "sqlite3.connect" and args:
            database = args[0]
            if str(database) == ":memory:":
                return
            if str(database).strip().casefold().startswith("file:"):
                raise PermissionError("SQLite URI database paths are not available in this environment")
            _assert_workspace_path(database)
            return
        if event in {"sqlite3.enable_load_extension", "sqlite3.load_extension"}:
            raise PermissionError("SQLite extension loading is not available in this environment")
        if event in blocked_events or event.startswith("socket."):
            raise PermissionError("This operation is not allowed in this environment")
        if event == "open" and args:
            raw_path = args[0]
            if isinstance(raw_path, int):
                return
            mode = str(args[1] or "") if len(args) > 1 else ""
            flags = int(args[2] or 0) if len(args) > 2 and isinstance(args[2], int) else 0
            writable = any(flag in mode for flag in ("w", "a", "x", "+")) or bool(flags & write_flags)
            if writable:
                _assert_workspace_path(raw_path)
                normalized = _normalized(raw_path)
                if not exists(normalized):
                    budget.reserve_file()
            else:
                _assert_read_path(raw_path)
            return
        if event in {"os.listdir", "os.scandir"} and args and args[0] is not None:
            _assert_read_path(args[0])
            return
        if event in workspace_path_events and args:
            _assert_workspace_path(args[0])
            return
        if event in {"os.link", "os.rename", "os.replace", "os.symlink"} and len(args) >= 2:
            _assert_workspace_path(args[0])
            _assert_workspace_path(args[1])

    sys.addaudithook(audit)


def _scrub_runtime_globals(safe_builtins: dict[str, Any]) -> None:
    globals()["__builtins__"] = safe_builtins
    for name in (
        "Path",
        "Any",
        "_compat_socket",
        "_compat_subprocess",
        "apply_landlock",
        "json",
        "os",
        "_apply_native_containment",
        "_prepare_trusted_runtime_compatibility",
        "_purge_security_modules",
        "is_student_module_root",
    ):
        globals()[name] = None


def main() -> int:
    import sys

    if len(sys.argv) != 3:
        print("Sandbox worker usage error", file=sys.stderr)
        return 2
    code_path = Path(sys.argv[1]).resolve()
    allowed_root = str(Path(sys.argv[2]).resolve())
    # The worker itself lives beside the server, so Python would otherwise use
    # the server directory as sys.path[0]. Put the contained student workspace
    # first so ordinary sibling modules and packages import as expected.
    workspace_import_path = str(Path(os.getcwd()).resolve())
    try:
        PathPolicy(allowed_root).assert_allowed(workspace_import_path, workspace_import_path)
    except PermissionError:
        workspace_import_path = allowed_root
    for import_path in (workspace_import_path, allowed_root):
        if import_path not in sys.path:
            sys.path.insert(0, import_path)
    try:
        user_code = code_path.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        print(f"Failed to read code from {code_path}: {exc}", file=sys.stderr)
        return 1

    policy = PathPolicy(allowed_root)
    _apply_resource_limits()
    containment = _apply_native_containment(allowed_root, code_path)
    if not containment.get("active") and os.environ.get("EAGLE_NATIVE_CONTAINMENT_DIAGNOSTIC") == "1":
        print(
            f"[Native containment unavailable: {containment.get('reason') or 'unknown error'}]",
            file=sys.stderr,
        )
    disabled_modules = _configured_disabled_modules()
    blocked_roots = frozenset(SECURITY_LOCKED_MODULES | disabled_modules)
    if not containment.get("active"):
        blocked_roots = frozenset(blocked_roots | CONTAINMENT_REQUIRED_MODULES)
    blocked_exact = SECURITY_LOCKED_EXACT_MODULES
    _prepare_trusted_runtime_compatibility()
    _purge_security_modules(policy, disabled_modules)

    matplotlib_cache = Path(allowed_root) / ".eagleide" / "matplotlib"
    try:
        matplotlib_cache.mkdir(parents=True, exist_ok=True)
        os.environ["MPLCONFIGDIR"] = str(matplotlib_cache)
    except OSError:
        pass

    write_budget = WriteBudget(MAX_WRITE_BYTES, MAX_NEW_FILES)
    artifact_manager = ChartArtifactManager(allowed_root)
    safe_builtins = _build_safe_builtins(
        policy,
        write_budget,
        blocked_roots,
        blocked_exact,
        artifact_manager,
    )
    _install_audit_hook(policy, code_path, write_budget, blocked_roots, blocked_exact)
    _scrub_runtime_globals(safe_builtins)

    sandbox_globals: dict[str, Any] = {
        "__builtins__": safe_builtins,
        "__name__": "__main__",
        "__file__": str(code_path),
        "__package__": None,
    }
    try:
        exec(compile(user_code, str(code_path), "exec"), sandbox_globals, sandbox_globals)
    except SystemExit:
        raise
    except Exception:
        import traceback

        traceback.print_exc()
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
