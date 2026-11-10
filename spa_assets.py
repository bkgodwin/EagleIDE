"""Fingerprint the local scripts and styles used by the IDE document."""

import hashlib
import re
from functools import lru_cache
from pathlib import Path


_DOCUMENT_ASSET = re.compile(
    r'(?P<prefix>(?:src|href)="/static/)'
    r'(?P<path>js/[\w./-]+\.js|css/main\.css)(?:\?v=[^"]*)?"'
)
_STYLESHEET_IMPORT = re.compile(
    r'(?P<prefix>^@import url\(")(?P<path>[\w./-]+\.css)(?:\?v=[^"]*)?"',
    re.MULTILINE,
)


def fingerprint(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()[:20]


@lru_cache(maxsize=256)
def _cached_file_version(path: Path, mtime_ns: int, size: int) -> str:
    return fingerprint(path.read_bytes())


def _file_version(path: Path) -> str:
    stat = path.stat()
    return _cached_file_version(path, stat.st_mtime_ns, stat.st_size)


def render_stylesheet(static_dir: Path) -> bytes:
    css_dir = static_dir / "css"
    source = (css_dir / "main.css").read_text(encoding="utf-8")

    def version_import(match: re.Match) -> str:
        path = match["path"]
        return f'{match["prefix"]}{path}?v={_file_version(css_dir / path)}"'

    return _STYLESHEET_IMPORT.sub(version_import, source).encode("utf-8")


def render_document(index: Path, static_dir: Path) -> bytes:
    def version_asset(match: re.Match) -> str:
        path = match["path"]
        version = (
            fingerprint(render_stylesheet(static_dir))
            if path == "css/main.css"
            else _file_version(static_dir / path)
        )
        return f'{match["prefix"]}{path}?v={version}"'

    return _DOCUMENT_ASSET.sub(version_asset, index.read_text(encoding="utf-8")).encode("utf-8")
