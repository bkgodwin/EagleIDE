"""Shared student-Python module policy.

The admin-facing catalog is intentionally smaller than the complete Python
standard library. Modules not listed here remain available unless they are in
``SECURITY_LOCKED_MODULES``. The catalog contains the classroom modules that an
administrator is most likely to enable or disable deliberately.
"""

from __future__ import annotations

import sys
from typing import Any


SECURITY_LOCKED_MODULES = frozenset(
    {
        "_ctypes",
        "_multiprocessing",
        "_posixsubprocess",
        "_posixshmem",
        "_socket",
        "_ssl",
        "_testbuffer",
        "_testcapi",
        "_testclinic",
        "_testconsole",
        "_testimportmultiple",
        "_testinternalcapi",
        "_testmultiphase",
        "_tkinter",
        "_xxsubinterpreters",
        "asyncio",
        "cffi",
        "ctypes",
        "fcntl",
        "ftplib",
        "http",
        "imaplib",
        "mmap",
        "multiprocessing",
        "nntplib",
        "nt",
        "poplib",
        "posix",
        "pty",
        "resource",
        "smtplib",
        "socket",
        "socketserver",
        "ssl",
        "subprocess",
        "telnetlib",
        "test",
        "tkinter",
        "venv",
        "webbrowser",
        "xmlrpc",
    }
)

SECURITY_LOCKED_EXACT_MODULES = frozenset({"asyncio.subprocess"})

# These modules expose live interpreter/native file behavior that is only
# acceptable when the Linux Landlock boundary is active. ``_sqlite3`` is
# included so importing the C extension directly cannot bypass the sqlite3
# policy.
CONTAINMENT_REQUIRED_MODULES = frozenset(
    {
        "PIL",
        "_sqlite3",
        "contourpy",
        "inspect",
        "kiwisolver",
        "matplotlib",
        "mpl_toolkits",
        "numpy",
        "sqlite3",
    }
)

# Student programs may import the Python standard library, their own workspace
# modules, and this small dependency set. Server-only packages such as Flask,
# Requests, bcrypt, and cryptography are intentionally not exposed to student
# code just because they happen to be installed in the server virtualenv.
STUDENT_THIRD_PARTY_MODULES = frozenset(
    {
        "PIL",
        "contourpy",
        "cycler",
        "dateutil",
        "fontTools",
        "kiwisolver",
        "matplotlib",
        "mpl_toolkits",
        "numpy",
        "packaging",
        "pyparsing",
        "six",
    }
)

STUDENT_STDLIB_MODULES = frozenset(sys.stdlib_module_names)


MODULE_CATALOG: tuple[dict[str, Any], ...] = (
    {
        "name": "dataclasses",
        "label": "Dataclasses",
        "category": "Python language",
        "description": "Structured data classes and the @dataclass decorator.",
        "default_enabled": True,
        "depends_on": ("inspect",),
    },
    {
        "name": "inspect",
        "label": "Inspect",
        "category": "Python language",
        "description": "Safe introspection inside the contained student worker.",
        "default_enabled": True,
        "requires_containment": True,
    },
    {
        "name": "typing",
        "label": "Typing",
        "category": "Python language",
        "description": "Type hints, protocols, generics, and related helpers.",
        "default_enabled": True,
    },
    {
        "name": "collections",
        "label": "Collections",
        "category": "Data structures",
        "description": "Specialized containers, including collections.abc.",
        "default_enabled": True,
    },
    {
        "name": "contextlib",
        "label": "Contextlib",
        "category": "Python language",
        "description": "Context managers and resource-cleanup helpers.",
        "default_enabled": True,
    },
    {
        "name": "functools",
        "label": "Functools",
        "category": "Python language",
        "description": "Decorators, caching, partial functions, and reduce.",
        "default_enabled": True,
    },
    {
        "name": "itertools",
        "label": "Itertools",
        "category": "Data structures",
        "description": "Memory-efficient iterator building blocks.",
        "default_enabled": True,
    },
    {
        "name": "pathlib",
        "label": "Pathlib",
        "category": "Workspace files",
        "description": "Object-oriented paths confined to the current workspace.",
        "default_enabled": True,
    },
    {
        "name": "os",
        "label": "OS workspace helpers",
        "category": "Workspace files",
        "description": "Hardened file and directory helpers; process APIs stay blocked.",
        "default_enabled": True,
    },
    {
        "name": "tempfile",
        "label": "Temporary files",
        "category": "Workspace files",
        "description": "Temporary files stored inside the student's workspace.",
        "default_enabled": True,
    },
    {
        "name": "shutil",
        "label": "Shutil",
        "category": "Workspace files",
        "description": "High-level copy and archive operations confined to the workspace.",
        "default_enabled": True,
    },
    {
        "name": "csv",
        "label": "CSV",
        "category": "Data formats",
        "description": "Read and write comma-separated data.",
        "default_enabled": True,
    },
    {
        "name": "json",
        "label": "JSON",
        "category": "Data formats",
        "description": "Encode and decode JSON data.",
        "default_enabled": True,
    },
    {
        "name": "sqlite3",
        "label": "SQLite3",
        "category": "Databases",
        "description": "Workspace-confined SQLite databases and in-memory databases.",
        "default_enabled": True,
        "requires_containment": True,
    },
    {
        "name": "math",
        "label": "Math",
        "category": "Math and measurement",
        "description": "Common mathematical functions and constants.",
        "default_enabled": True,
    },
    {
        "name": "statistics",
        "label": "Statistics",
        "category": "Math and measurement",
        "description": "Descriptive statistics for ordinary Python data.",
        "default_enabled": True,
    },
    {
        "name": "decimal",
        "label": "Decimal",
        "category": "Math and measurement",
        "description": "Configurable decimal floating-point arithmetic.",
        "default_enabled": True,
    },
    {
        "name": "fractions",
        "label": "Fractions",
        "category": "Math and measurement",
        "description": "Exact rational-number arithmetic.",
        "default_enabled": True,
    },
    {
        "name": "random",
        "label": "Random",
        "category": "Math and measurement",
        "description": "Pseudo-random values for simulations and exercises.",
        "default_enabled": True,
    },
    {
        "name": "time",
        "label": "Time",
        "category": "Time and dates",
        "description": "Clock and timing functions.",
        "default_enabled": True,
    },
    {
        "name": "timeit",
        "label": "Timeit",
        "category": "Time and dates",
        "description": "Small-code performance measurement.",
        "default_enabled": True,
    },
    {
        "name": "datetime",
        "label": "Datetime",
        "category": "Time and dates",
        "description": "Dates, times, timedeltas, and time zones.",
        "default_enabled": True,
    },
    {
        "name": "logging",
        "label": "Logging",
        "category": "Testing and diagnostics",
        "description": "Console and workspace-file logging; network handlers remain blocked.",
        "default_enabled": True,
    },
    {
        "name": "unittest",
        "label": "Unittest",
        "category": "Testing and diagnostics",
        "description": "Unit tests, assertions, discovery, and unittest.mock.",
        "default_enabled": True,
        "depends_on": ("inspect",),
    },
    {
        "name": "pprint",
        "label": "Pretty print",
        "category": "Testing and diagnostics",
        "description": "Readable formatting for nested Python values.",
        "default_enabled": True,
        "depends_on": ("dataclasses",),
    },
    {
        "name": "re",
        "label": "Regular expressions",
        "category": "Text",
        "description": "Pattern matching and text replacement.",
        "default_enabled": True,
    },
    {
        "name": "string",
        "label": "String helpers",
        "category": "Text",
        "description": "Constants, templates, and string formatting helpers.",
        "default_enabled": True,
    },
    {
        "name": "textwrap",
        "label": "Textwrap",
        "category": "Text",
        "description": "Wrap, indent, shorten, and dedent text.",
        "default_enabled": True,
    },
    {
        "name": "numpy",
        "label": "NumPy runtime",
        "category": "Charts",
        "description": "Native numerical runtime required by Matplotlib.",
        "default_enabled": True,
        "requires_containment": True,
    },
    {
        "name": "matplotlib",
        "label": "Matplotlib",
        "category": "Charts",
        "description": "Headless 2D and 3D chart generation saved beside the Python source file.",
        "default_enabled": True,
        "requires_containment": True,
        "depends_on": ("numpy", "inspect"),
    },
)

_CATALOG_BY_NAME = {str(row["name"]): row for row in MODULE_CATALOG}


def default_module_access() -> dict[str, bool]:
    return {
        name: bool(row.get("default_enabled", True))
        for name, row in _CATALOG_BY_NAME.items()
    }


def normalize_module_access(value: Any) -> dict[str, bool]:
    """Return a complete, dependency-consistent managed-module access map."""

    result = default_module_access()
    if isinstance(value, dict):
        for raw_name, enabled in value.items():
            name = str(raw_name or "").strip()
            if name in result:
                result[name] = bool(enabled)

    # A disabled dependency disables its dependents. Iterate to a fixed point so
    # chains such as inspect -> dataclasses -> pprint are handled consistently.
    changed = True
    while changed:
        changed = False
        for name, row in _CATALOG_BY_NAME.items():
            if not result.get(name, False):
                continue
            dependencies = tuple(row.get("depends_on") or ())
            if any(not result.get(str(dependency), False) for dependency in dependencies):
                result[name] = False
                changed = True
    return result


def disabled_module_roots(value: Any) -> frozenset[str]:
    access = normalize_module_access(value)
    disabled = {name for name, enabled in access.items() if not enabled}
    if "sqlite3" in disabled:
        disabled.add("_sqlite3")
    if "matplotlib" in disabled:
        disabled.add("mpl_toolkits")
    return frozenset(disabled)


def is_student_module_root(root: str) -> bool:
    normalized = str(root or "").strip()
    return normalized in STUDENT_STDLIB_MODULES or normalized in STUDENT_THIRD_PARTY_MODULES


def public_module_catalog() -> list[dict[str, Any]]:
    return [
        {
            "name": str(row["name"]),
            "label": str(row.get("label") or row["name"]),
            "category": str(row.get("category") or "Other"),
            "description": str(row.get("description") or ""),
            "default_enabled": bool(row.get("default_enabled", True)),
            "requires_containment": bool(row.get("requires_containment", False)),
            "depends_on": list(row.get("depends_on") or ()),
        }
        for row in MODULE_CATALOG
    ]
