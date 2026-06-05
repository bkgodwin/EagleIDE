#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
from typing import Any

INPUT_TOKEN = "[[_IDE_INPUT_]]"
MAX_MEMORY_BYTES = 256 * 1024 * 1024
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


class SafeOpen:
    __slots__ = ("_normalize", "_assert_allowed", "_opener")

    def __init__(self, policy: PathPolicy):
        import io

        self._normalize = policy.normalize
        self._assert_allowed = policy.assert_allowed
        self._opener = io.open

    def __call__(self, file: Any, mode: str = "r", *args: Any, **kwargs: Any):
        if isinstance(file, int):
            raise PermissionError("File descriptor access is not allowed in this environment")
        normalized_path = self._normalize(file)
        self._assert_allowed(normalized_path, file)
        return self._opener(normalized_path, mode, *args, **kwargs)


class SafeImport:
    __slots__ = ("_blocked_exact", "_blocked_roots", "_harden_os_module", "_orig_import")

    def __init__(self, policy: PathPolicy):
        self._orig_import = __import__
        self._blocked_roots = BLOCKED_ROOT_MODULES
        self._blocked_exact = BLOCKED_EXACT_MODULES
        self._harden_os_module = _make_os_hardener(policy)

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

        resource.setrlimit(resource.RLIMIT_AS, (MAX_MEMORY_BYTES, MAX_MEMORY_BYTES))
        resource.setrlimit(resource.RLIMIT_NOFILE, (MAX_NOFILE, MAX_NOFILE))
    except Exception:
        pass


def _build_safe_builtins(policy: PathPolicy) -> dict[str, Any]:
    builtins_mod = __import__("builtins")
    safe = dict(builtins_mod.__dict__)
    safe["open"] = SafeOpen(policy)
    safe["__import__"] = SafeImport(policy)
    safe["input"] = _safe_input
    return safe


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
    safe_builtins = _build_safe_builtins(policy)
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
