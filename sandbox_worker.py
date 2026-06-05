#!/usr/bin/env python3
from __future__ import annotations

import builtins as _builtins
import io
import os
from pathlib import Path
import sys
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
)


class PathPolicy:
    __slots__ = ("allowed_root",)

    def __init__(self, allowed_root: str):
        self.allowed_root = str(Path(allowed_root).resolve())

    def normalize(self, target: Any) -> str:
        target_path = Path(os.fspath(target))
        if not target_path.is_absolute():
            target_path = (Path.cwd() / target_path).resolve(strict=False)
        return str(target_path.resolve(strict=False))

    def assert_allowed(self, normalized_path: str, original: Any) -> None:
        try:
            common = os.path.commonpath([normalized_path, self.allowed_root])
        except Exception:
            raise PermissionError(f"Access to {original!r} is not allowed in this environment")
        if common != self.allowed_root:
            raise PermissionError(f"Access to {original!r} is not allowed in this environment")


class SafeOpen:
    __slots__ = ("_policy",)

    def __init__(self, policy: PathPolicy):
        self._policy = policy

    def __call__(self, file: Any, mode: str = "r", *args: Any, **kwargs: Any):
        if isinstance(file, int):
            return io.open(file, mode, *args, **kwargs)
        normalized_path = self._policy.normalize(file)
        self._policy.assert_allowed(normalized_path, file)
        return io.open(normalized_path, mode, *args, **kwargs)


class SafeImport:
    __slots__ = ("_policy", "_orig_import")

    def __init__(self, policy: PathPolicy):
        self._policy = policy
        self._orig_import = _builtins.__import__

    def __call__(
        self,
        name: str,
        globals: dict[str, Any] | None = None,
        locals: dict[str, Any] | None = None,
        fromlist: tuple[str, ...] = (),
        level: int = 0,
    ):
        root = name.split(".", 1)[0]
        if root in BLOCKED_ROOT_MODULES or name in BLOCKED_EXACT_MODULES:
            raise ImportError(f"Module {name!r} is not available in this environment")
        module = self._orig_import(name, globals, locals, fromlist, level)
        if root == "os":
            _harden_os_module(module, self._policy)
        return module


def _blocked_call(*_args: Any, **_kwargs: Any):
    raise PermissionError("This operation is not allowed in this environment")


def _guarded_os_path_call(policy: PathPolicy, fn_name: str):
    os_fn = getattr(os, fn_name)

    def _wrapper(path: Any = ".", *args: Any, **kwargs: Any):
        normalized = policy.normalize(path)
        policy.assert_allowed(normalized, path)
        return os_fn(normalized, *args, **kwargs)

    return _wrapper


def _guarded_os_rename(policy: PathPolicy):
    def _wrapper(src: Any, dst: Any, *args: Any, **kwargs: Any):
        src_normalized = policy.normalize(src)
        dst_normalized = policy.normalize(dst)
        policy.assert_allowed(src_normalized, src)
        policy.assert_allowed(dst_normalized, dst)
        return os.rename(src_normalized, dst_normalized, *args, **kwargs)

    return _wrapper


def _guarded_os_replace(policy: PathPolicy):
    def _wrapper(src: Any, dst: Any, *args: Any, **kwargs: Any):
        src_normalized = policy.normalize(src)
        dst_normalized = policy.normalize(dst)
        policy.assert_allowed(src_normalized, src)
        policy.assert_allowed(dst_normalized, dst)
        return os.replace(src_normalized, dst_normalized, *args, **kwargs)

    return _wrapper


def _harden_os_module(module: Any, policy: PathPolicy) -> None:
    for fn_name in BLOCKED_OS_CALLS:
        if hasattr(module, fn_name):
            setattr(module, fn_name, _blocked_call)

    for fn_name in ("listdir", "scandir", "walk", "readlink", "remove", "unlink", "rmdir", "removedirs", "mkdir", "makedirs", "chdir"):
        if hasattr(module, fn_name):
            setattr(module, fn_name, _guarded_os_path_call(policy, fn_name))
    if hasattr(module, "rename"):
        setattr(module, "rename", _guarded_os_rename(policy))
    if hasattr(module, "replace"):
        setattr(module, "replace", _guarded_os_replace(policy))


def _safe_input(prompt: Any = "") -> str:
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


def _safe_globals() -> dict[str, Any]:
    frame = sys._getframe(1)
    g = frame.f_globals
    return {k: v for k, v in g.items() if k != "__builtins__"}


def _safe_vars(obj: Any = None):
    if obj is None:
        return _safe_globals()
    return _builtins.vars(obj)


def _apply_resource_limits() -> None:
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_AS, (MAX_MEMORY_BYTES, MAX_MEMORY_BYTES))
        resource.setrlimit(resource.RLIMIT_NOFILE, (MAX_NOFILE, MAX_NOFILE))
    except Exception:
        pass


def _build_safe_builtins(policy: PathPolicy) -> dict[str, Any]:
    safe = dict(_builtins.__dict__)
    safe["open"] = SafeOpen(policy)
    safe["__import__"] = SafeImport(policy)
    safe["input"] = _safe_input
    safe["globals"] = _safe_globals
    safe["vars"] = _safe_vars
    return safe


def main() -> int:
    if len(sys.argv) != 3:
        print("Sandbox worker usage error", file=sys.stderr)
        return 2
    code_path = Path(sys.argv[1]).resolve()
    allowed_root = sys.argv[2]
    try:
        user_code = code_path.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        print(f"Failed to read code: {exc}", file=sys.stderr)
        return 1

    policy = PathPolicy(allowed_root)
    _apply_resource_limits()
    safe_builtins = _build_safe_builtins(policy)
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
