#!/usr/bin/env python3
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

INPUT_TOKEN = "[[_IDE_INPUT_]]"
MAX_MEMORY_BYTES = max(32 * 1024 * 1024, int(os.environ.get("EAGLE_MAX_MEMORY_BYTES", 256 * 1024 * 1024)))
MAX_CPU_SECONDS = max(1, int(os.environ.get("EAGLE_MAX_CPU_SECONDS", 8)))
MAX_FILE_BYTES = max(1024, int(os.environ.get("EAGLE_MAX_FILE_BYTES", 10 * 1024 * 1024)))
MAX_WRITE_BYTES = max(0, int(os.environ.get("EAGLE_RUN_WRITE_BUDGET_BYTES", 10 * 1024 * 1024)))
MAX_NEW_FILES = 20
MAX_PROCESSES_AND_THREADS = 16
MAX_NOFILE = 64

BLOCKED_ROOT_MODULES = frozenset(
    {
        "subprocess",
        "multiprocessing",
        "socket",
        "socketserver",
        "ftplib",
        "http",
        "urllib",
        "xmlrpc",
        "smtplib",
        "imaplib",
        "poplib",
        "nntplib",
        "telnetlib",
        "ssl",
        "ctypes",
        "cffi",
        "mmap",
        "asyncio",
        "inspect",
        "resource",
        "fcntl",
        "pty",
        "posix",
        "nt",
        "_posixsubprocess",
    }
)
BLOCKED_EXACT_MODULES = frozenset({"asyncio.subprocess"})
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
GUARDED_OS_PATH_CALLS = ("listdir", "scandir", "walk", "readlink", "remove", "unlink", "rmdir", "removedirs", "mkdir", "makedirs")


class PathPolicy:
    __slots__ = (
        "allowed_root",
        "_cwd",
        "_abspath",
        "_commonpath",
        "_fspath",
        "_isabs",
        "_join",
        "_realpath",
    )

    def __init__(self, allowed_root: str):
        import os

        self._fspath = os.fspath
        self._isabs = os.path.isabs
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
    __slots__ = ("_blocked_exact", "_blocked_roots", "_harden_os_module", "_orig_import", "_safe_open")

    def __init__(self, policy: PathPolicy, safe_open: SafeOpen):
        self._orig_import = __import__
        self._blocked_roots = BLOCKED_ROOT_MODULES
        self._blocked_exact = BLOCKED_EXACT_MODULES
        self._harden_os_module = _make_os_hardener(policy)
        self._safe_open = safe_open

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
        module = self._orig_import(name, globals, locals, fromlist, level)
        if root == "os":
            self._harden_os_module(module)
        elif root == "pathlib":
            safe_open = self._safe_open

            def _path_open(path_obj: Any, mode: str = "r", buffering: int = -1, encoding=None, errors=None, newline=None):
                return safe_open(path_obj, mode, buffering, encoding, errors, newline)

            module.Path.open = _path_open
        return module


def _blocked_call(*_args: Any, **_kwargs: Any):
    raise PermissionError("This operation is not allowed in this environment")


def _make_os_hardener(policy: PathPolicy):
    def _guarded_os_path_call(os_fn):
        def _wrapper(path: Any = ".", *args: Any, **kwargs: Any):
            normalized = policy.normalize(path)
            policy.assert_allowed(normalized, path)
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
        for fn_name in GUARDED_OS_PATH_CALLS:
            if hasattr(module, fn_name):
                setattr(module, fn_name, _guarded_os_path_call(getattr(module, fn_name)))
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
        limits.append((resource.RLIMIT_NPROC, (MAX_PROCESSES_AND_THREADS, MAX_PROCESSES_AND_THREADS)))
    if hasattr(resource, "RLIMIT_CORE"):
        limits.append((resource.RLIMIT_CORE, (0, 0)))
    for limit_name, values in limits:
        try:
            resource.setrlimit(limit_name, values)
        except Exception:
            pass


def _build_safe_builtins(policy: PathPolicy, budget: WriteBudget) -> dict[str, Any]:
    builtins_mod = __import__("builtins")
    safe = dict(builtins_mod.__dict__)
    safe_open = SafeOpen(policy, budget)
    safe["open"] = safe_open
    safe["__import__"] = SafeImport(policy, safe_open)
    safe["input"] = _safe_input
    return safe


def _install_audit_hook(policy: PathPolicy, code_path: Path, budget: WriteBudget) -> None:
    """Enforce the path/import/process boundary across alternate stdlib APIs."""
    import sys

    realpath = os.path.realpath
    abspath = os.path.abspath
    commonpath = os.path.commonpath
    exists = os.path.exists
    trusted_read_roots = {
        realpath(abspath(sys.base_prefix)),
        realpath(abspath(sys.prefix)),
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
            if root in BLOCKED_ROOT_MODULES or name in BLOCKED_EXACT_MODULES:
                raise ImportError(f"Module {name!r} is not available in this environment")
            return
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
    for name in ("Path", "Any"):
        globals()[name] = None


def main() -> int:
    import sys

    if len(sys.argv) != 3:
        print("Sandbox worker usage error", file=sys.stderr)
        return 2
    code_path = Path(sys.argv[1]).resolve()
    allowed_root = str(Path(sys.argv[2]).resolve())
    try:
        user_code = code_path.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        print(f"Failed to read code from {code_path}: {exc}", file=sys.stderr)
        return 1

    policy = PathPolicy(allowed_root)
    _apply_resource_limits()
    write_budget = WriteBudget(MAX_WRITE_BYTES, MAX_NEW_FILES)
    safe_builtins = _build_safe_builtins(policy, write_budget)
    _install_audit_hook(policy, code_path, write_budget)
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
