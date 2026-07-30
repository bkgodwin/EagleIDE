"""Linux Landlock containment for untrusted student Python workers.

Landlock is applied inside the already-created worker process after its source
has been read but before user code executes. The worker keeps the Python audit
hook and resource limits as defense in depth; Landlock is the native-code
filesystem boundary used by SQLite, NumPy, and Matplotlib.
"""

from __future__ import annotations

import errno
import os
import sys
from pathlib import Path
from typing import Any, Iterable


LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_RULE_PATH_BENEATH = 1
PR_SET_NO_NEW_PRIVS = 38

ACCESS_FS_EXECUTE = 1 << 0
ACCESS_FS_WRITE_FILE = 1 << 1
ACCESS_FS_READ_FILE = 1 << 2
ACCESS_FS_READ_DIR = 1 << 3
ACCESS_FS_REMOVE_DIR = 1 << 4
ACCESS_FS_REMOVE_FILE = 1 << 5
ACCESS_FS_MAKE_CHAR = 1 << 6
ACCESS_FS_MAKE_DIR = 1 << 7
ACCESS_FS_MAKE_REG = 1 << 8
ACCESS_FS_MAKE_SOCK = 1 << 9
ACCESS_FS_MAKE_FIFO = 1 << 10
ACCESS_FS_MAKE_BLOCK = 1 << 11
ACCESS_FS_MAKE_SYM = 1 << 12
ACCESS_FS_REFER = 1 << 13
ACCESS_FS_TRUNCATE = 1 << 14
ACCESS_FS_IOCTL_DEV = 1 << 15

READ_ACCESS = ACCESS_FS_EXECUTE | ACCESS_FS_READ_FILE | ACCESS_FS_READ_DIR
WORKSPACE_ACCESS = (
    READ_ACCESS
    | ACCESS_FS_WRITE_FILE
    | ACCESS_FS_REMOVE_DIR
    | ACCESS_FS_REMOVE_FILE
    | ACCESS_FS_MAKE_DIR
    | ACCESS_FS_MAKE_REG
    | ACCESS_FS_MAKE_FIFO
    | ACCESS_FS_MAKE_SYM
    | ACCESS_FS_REFER
    | ACCESS_FS_TRUNCATE
)


def _supported_access(abi: int) -> int:
    rights = (
        ACCESS_FS_EXECUTE
        | ACCESS_FS_WRITE_FILE
        | ACCESS_FS_READ_FILE
        | ACCESS_FS_READ_DIR
        | ACCESS_FS_REMOVE_DIR
        | ACCESS_FS_REMOVE_FILE
        | ACCESS_FS_MAKE_CHAR
        | ACCESS_FS_MAKE_DIR
        | ACCESS_FS_MAKE_REG
        | ACCESS_FS_MAKE_SOCK
        | ACCESS_FS_MAKE_FIFO
        | ACCESS_FS_MAKE_BLOCK
        | ACCESS_FS_MAKE_SYM
    )
    if abi >= 2:
        rights |= ACCESS_FS_REFER
    if abi >= 3:
        rights |= ACCESS_FS_TRUNCATE
    if abi >= 5:
        rights |= ACCESS_FS_IOCTL_DEV
    return rights


def _syscall_numbers() -> tuple[int, int, int]:
    # Landlock uses these numbers on Linux's generic syscall table, including
    # x86_64 and aarch64, the two deployment architectures EagleIDE supports.
    return 444, 445, 446


def landlock_status() -> dict[str, Any]:
    if sys.platform != "linux":
        return {
            "available": False,
            "active": False,
            "abi": 0,
            "reason": "Linux Landlock is required for native student modules",
        }
    try:
        import ctypes

        libc = ctypes.CDLL(None, use_errno=True)
        create_ruleset, _, _ = _syscall_numbers()
        abi = int(libc.syscall(create_ruleset, 0, 0, LANDLOCK_CREATE_RULESET_VERSION))
        if abi < 0:
            error_number = ctypes.get_errno()
            reason = os.strerror(error_number) if error_number else "Landlock is unavailable"
            return {"available": False, "active": False, "abi": 0, "reason": reason}
        if abi < 3:
            return {
                "available": False,
                "active": False,
                "abi": abi,
                "reason": "Landlock ABI 3 or newer is required",
            }
        return {"available": True, "active": False, "abi": abi, "reason": ""}
    except Exception as exc:
        return {"available": False, "active": False, "abi": 0, "reason": str(exc)}


def apply_landlock(
    workspace: str | os.PathLike[str],
    *,
    readonly_paths: Iterable[str | os.PathLike[str]] = (),
) -> dict[str, Any]:
    status = landlock_status()
    if not status.get("available"):
        return status

    import ctypes

    class RulesetAttr(ctypes.Structure):
        _fields_ = [("handled_access_fs", ctypes.c_uint64)]

    class PathBeneathAttr(ctypes.Structure):
        _fields_ = [
            ("allowed_access", ctypes.c_uint64),
            ("parent_fd", ctypes.c_int32),
            ("reserved", ctypes.c_uint32),
        ]

    libc = ctypes.CDLL(None, use_errno=True)
    create_ruleset, add_rule, restrict_self = _syscall_numbers()
    abi = int(status["abi"])
    handled_access = _supported_access(abi)
    ruleset_attr = RulesetAttr(handled_access_fs=handled_access)
    ruleset_fd = int(libc.syscall(create_ruleset, ctypes.byref(ruleset_attr), ctypes.sizeof(ruleset_attr), 0))
    if ruleset_fd < 0:
        error_number = ctypes.get_errno()
        return {
            "available": True,
            "active": False,
            "abi": abi,
            "reason": os.strerror(error_number) if error_number else "Could not create Landlock ruleset",
        }

    opened_fds: list[int] = []

    def add_path(path_value: str | os.PathLike[str], access: int) -> None:
        path = Path(path_value).expanduser().resolve()
        if not path.exists():
            return
        flags = int(getattr(os, "O_PATH", os.O_RDONLY)) | int(getattr(os, "O_CLOEXEC", 0))
        fd = os.open(path, flags)
        opened_fds.append(fd)
        attr = PathBeneathAttr(
            allowed_access=access & handled_access,
            parent_fd=fd,
            reserved=0,
        )
        result = int(
            libc.syscall(
                add_rule,
                ruleset_fd,
                LANDLOCK_RULE_PATH_BENEATH,
                ctypes.byref(attr),
                0,
            )
        )
        if result < 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, os.strerror(error_number), str(path))

    try:
        add_path(workspace, WORKSPACE_ACCESS)
        seen: set[str] = {str(Path(workspace).expanduser().resolve())}
        for raw_path in readonly_paths:
            try:
                normalized = str(Path(raw_path).expanduser().resolve())
            except Exception:
                continue
            if normalized in seen:
                continue
            seen.add(normalized)
            add_path(normalized, READ_ACCESS)

        if int(libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) != 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, os.strerror(error_number))
        if int(libc.syscall(restrict_self, ruleset_fd, 0)) != 0:
            error_number = ctypes.get_errno()
            raise OSError(error_number, os.strerror(error_number))
        return {"available": True, "active": True, "abi": abi, "reason": ""}
    except OSError as exc:
        reason = exc.strerror or str(exc)
        if exc.errno == errno.ENOMSG:
            reason = "The requested filesystem access is not supported by this Landlock ABI"
        return {"available": True, "active": False, "abi": abi, "reason": reason}
    finally:
        for fd in opened_fds:
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            os.close(ruleset_fd)
        except OSError:
            pass
