"""Persistent catalog and file storage for EagleIDE's public coding wiki.

Markdown and uploaded assets remain ordinary files. SQLite stores the tree,
search metadata, class features, bookmarks, revisions, redirects, and aggregate
analytics. All mutating methods are safe for the application's threaded Flask
process and use atomic file replacement for content.
"""

from __future__ import annotations

import copy
import hashlib
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import threading
import time
import unicodedata
import uuid
import zipfile
from collections import OrderedDict, defaultdict
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Iterator, Optional
from urllib.parse import urlsplit


SCHEMA_VERSION = 1
MAX_PAGE_BYTES = 2 * 1024 * 1024
MAX_BACKUP_MANIFEST_BYTES = 50 * 1024 * 1024
MAX_BACKUP_ENTRIES = 100_000
DEFAULT_HOME_TITLE = "Learn it. Try it. Build it."
DEFAULT_HOME_SUBTITLE = (
    "Browse classroom-ready programming topics, open examples directly in the IDE, "
    "and keep important lessons close at hand."
)
DEFAULT_FOOTER_TEXT = (
    "Created by Ben Godwin | Computer Science Department ARCA High School | "
    "Youngsville Louisiana | Contact bgodwin@acadianacharter.org"
)
MAX_REVISIONS_PER_PAGE = 3
MAX_HOME_STANDARDS_BYTES = 512 * 1024
MAX_STANDARDS = 500
MAX_STANDARD_ID_CHARS = 120
MAX_STANDARD_DESCRIPTION_CHARS = 4000
MAX_EXTERNAL_RESOURCES = 100

ASSET_TYPES: dict[str, tuple[str, str, bool]] = {
    ".png": ("image", "image/png", False),
    ".jpg": ("image", "image/jpeg", False),
    ".jpeg": ("image", "image/jpeg", False),
    ".webp": ("image", "image/webp", False),
    ".gif": ("image", "image/gif", False),
    ".mp4": ("video", "video/mp4", False),
    ".pdf": ("pdf", "application/pdf", False),
    ".txt": ("file", "text/plain; charset=utf-8", False),
    ".csv": ("file", "text/csv; charset=utf-8", False),
    ".py": ("file", "text/x-python; charset=utf-8", False),
    ".js": ("file", "text/javascript; charset=utf-8", True),
    ".html": ("file", "text/html; charset=utf-8", True),
    ".css": ("file", "text/css; charset=utf-8", False),
    ".json": ("file", "application/json; charset=utf-8", False),
    ".zip": ("file", "application/zip", True),
}

AUTO_LINK_STOP_TERMS = {
    "about", "basics", "code", "coding", "conclusion", "example", "examples",
    "exercise", "exercises", "help", "home", "introduction", "lesson", "lessons",
    "more", "notes", "overview", "practice", "reference", "resources", "summary",
    "topic", "topics", "video", "videos", "wiki",
}

_HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$")
_HTML_RE = re.compile(r"<[^>]+>")
_DIRECTIVE_ID_RE = re.compile(r"\{\{(?:image|video|file):([0-9a-f]{32})\b", re.I)
_WIKI_LINK_RE = re.compile(r"\]\(/wiki/([a-z0-9][a-z0-9-]{0,159})(?:#[^)]+)?\)", re.I)


def utc_timestamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def normalize_term(value: Any) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(value or "")).strip()).casefold()


def slugify(value: Any, fallback: str = "topic") -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.encode("ascii", "ignore").decode("ascii").lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return (text[:140].strip("-") or fallback)[:140]


def safe_title(value: Any, fallback: str = "Untitled") -> str:
    text = re.sub(r"[\x00-\x1f\x7f]+", " ", str(value or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return (text[:200] or fallback)[:200]


def safe_description(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:1000]


def safe_icon(value: Any) -> str:
    text = re.sub(r"[\x00-\x1f\x7f]+", "", str(value or "")).strip()
    return text[:32]


def safe_footer_text(value: Any) -> str:
    text = re.sub(r"[\x00-\x1f\x7f]+", " ", str(value or ""))
    return (re.sub(r"\s+", " ", text).strip() or DEFAULT_FOOTER_TEXT)[:1000]


def safe_home_standards(value: Any) -> str:
    text = str(value or "").replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if len(text.encode("utf-8")) > MAX_HOME_STANDARDS_BYTES:
        raise ValueError("Home standards Markdown exceeds the 512KB limit")
    return text


def safe_standards(value: Any) -> list[dict[str, Any]]:
    if value in (None, ""):
        return []
    if not isinstance(value, list):
        raise ValueError("Standards must be a list")
    if len(value) > MAX_STANDARDS:
        raise ValueError(f"Standards are limited to {MAX_STANDARDS} entries")
    standards: list[dict[str, Any]] = []
    seen: set[str] = set()
    seen_record_ids: set[str] = set()
    for order, raw in enumerate(value):
        if not isinstance(raw, dict):
            raise ValueError("Each standard must contain a Standard ID and description")
        standard_id = re.sub(r"[\x00-\x1f\x7f]+", " ", str(raw.get("standard_id") or ""))
        standard_id = re.sub(r"\s+", " ", standard_id).strip()[:MAX_STANDARD_ID_CHARS]
        description = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+", " ", str(raw.get("description") or ""))
        description = re.sub(r"\s+", " ", description).strip()[:MAX_STANDARD_DESCRIPTION_CHARS]
        normalized_id = normalize_term(standard_id)
        if not standard_id or not description:
            raise ValueError("Every standard requires a Standard ID and description")
        if normalized_id in seen:
            raise ValueError(f"Standard ID '{standard_id}' is duplicated")
        seen.add(normalized_id)
        raw_id = str(raw.get("id") or "").strip().lower()
        if re.fullmatch(r"[0-9a-f]{32}", raw_id):
            if raw_id in seen_record_ids:
                raise ValueError("A standard record was submitted more than once")
            seen_record_ids.add(raw_id)
        standards.append({
            "id": raw_id if re.fullmatch(r"[0-9a-f]{32}", raw_id) else "",
            "standard_id": standard_id,
            "normalized_id": normalized_id,
            "description": description,
            "sort_order": order,
        })
    return standards


def safe_external_resources(value: Any) -> list[dict[str, str]]:
    if value in (None, ""):
        return []
    if not isinstance(value, list):
        raise ValueError("External resources must be a list")
    if len(value) > MAX_EXTERNAL_RESOURCES:
        raise ValueError(f"External resources are limited to {MAX_EXTERNAL_RESOURCES} entries")
    resources: list[dict[str, str]] = []
    for raw in value:
        if not isinstance(raw, dict):
            raise ValueError("Each external resource must contain a title, URL, and description")
        title = safe_title(raw.get("title"), "")
        description = safe_description(raw.get("description"))
        url = str(raw.get("url") or "").strip()[:2048]
        parsed = urlsplit(url)
        if not title or parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
            raise ValueError("Each external resource requires a title and a valid HTTP or HTTPS URL")
        if parsed.username or parsed.password:
            raise ValueError("External resource URLs cannot contain credentials")
        resources.append({"title": title, "url": url, "description": description})
    return resources


def safe_filename(value: Any) -> str:
    name = Path(str(value or "")).name
    name = re.sub(r"[\x00-\x1f<>:\"/\\|?*]+", "_", name).strip(" .")
    return (name[:180] or "upload")[:180]


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temp.write_text(content, encoding="utf-8")
    os.replace(temp, path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _strip_inline_markdown(text: str) -> str:
    text = re.sub(r"!\[([^]]*)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"\[([^]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"[`*_~]", "", text)
    return re.sub(r"\s+", " ", _HTML_RE.sub("", text)).strip()


def parse_markdown(markdown: str) -> tuple[list[dict[str, Any]], str]:
    headings: list[dict[str, Any]] = []
    used_anchors: dict[str, int] = {}
    plain_lines: list[str] = []
    fence: Optional[str] = None
    for line in str(markdown or "").splitlines():
        stripped = line.lstrip()
        marker = stripped[:3]
        if marker in {"```", "~~~"}:
            if fence is None:
                fence = marker
            elif fence == marker:
                fence = None
            continue
        if fence:
            plain_lines.append(line)
            continue
        match = _HEADING_RE.match(line)
        if match:
            heading = safe_title(_strip_inline_markdown(match.group(2)), "Section")
            base = slugify(heading, "section")
            used_anchors[base] = used_anchors.get(base, 0) + 1
            anchor = base if used_anchors[base] == 1 else f"{base}-{used_anchors[base]}"
            headings.append({
                "id": uuid.uuid4().hex,
                "anchor": anchor,
                "heading": heading,
                "level": len(match.group(1)),
                "ordinal": len(headings),
            })
        cleaned = _strip_inline_markdown(line)
        if cleaned:
            plain_lines.append(cleaned)
    plain = re.sub(r"\s+", " ", "\n".join(plain_lines)).strip()
    return headings, plain


def validate_asset_signature(path: Path, extension: str) -> bool:
    ext = extension.lower()
    try:
        with path.open("rb") as handle:
            head = handle.read(64)
        if ext == ".png":
            return head.startswith(b"\x89PNG\r\n\x1a\n")
        if ext in {".jpg", ".jpeg"}:
            return head.startswith(b"\xff\xd8\xff")
        if ext == ".gif":
            return head.startswith((b"GIF87a", b"GIF89a"))
        if ext == ".webp":
            return len(head) >= 12 and head.startswith(b"RIFF") and head[8:12] == b"WEBP"
        if ext == ".pdf":
            return head.startswith(b"%PDF-")
        if ext == ".mp4":
            return len(head) >= 12 and head[4:8] == b"ftyp"
        if ext == ".zip":
            return head.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"))
        if ext in {".txt", ".csv", ".py", ".js", ".html", ".css", ".json"}:
            path.read_text(encoding="utf-8")
            if ext == ".json":
                json.loads(path.read_text(encoding="utf-8"))
            return True
    except Exception:
        return False
    return False


class WikiStore:
    def __init__(
        self,
        base_dir: Path,
        *,
        backup_dir: Optional[Path] = None,
        max_asset_bytes: int = 1024 * 1024 * 1024,
        max_total_asset_bytes: int = 10 * 1024 * 1024 * 1024,
    ) -> None:
        self.base_dir = Path(base_dir)
        self.content_dir = self.base_dir / "content"
        self.media_dir = self.base_dir / "media"
        self.revisions_dir = self.base_dir / "revisions"
        self.drafts_dir = self.base_dir / "drafts"
        self.staging_dir = self.base_dir / "staging"
        self.db_path = self.base_dir / "wiki.db"
        self.backup_dir = Path(backup_dir or self.base_dir.parent / "wiki_backups")
        self.max_asset_bytes = max(1024 * 1024, int(max_asset_bytes))
        self.max_total_asset_bytes = max(self.max_asset_bytes, int(max_total_asset_bytes))
        self._write_lock = threading.RLock()
        self._cache_lock = threading.Lock()
        self._node_cache: OrderedDict[tuple[Any, ...], dict[str, Any]] = OrderedDict()
        self._tree_cache: OrderedDict[tuple[Any, ...], list[dict[str, Any]]] = OrderedDict()
        self._search_cache: OrderedDict[tuple[Any, ...], list[dict[str, Any]]] = OrderedDict()
        self._link_cache: OrderedDict[tuple[Any, ...], list[dict[str, str]]] = OrderedDict()
        self._prepare_directories()
        self._init_schema()
        self.prune_revisions()
        self.cleanup_staging()

    def _prepare_directories(self) -> None:
        for directory in (
            self.base_dir,
            self.content_dir,
            self.media_dir,
            self.revisions_dir,
            self.drafts_dir,
            self.staging_dir,
            self.backup_dir,
        ):
            directory.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def _connect(self, path: Optional[Path] = None) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(str(path or self.db_path), timeout=10.0)
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA busy_timeout=10000")
            conn.execute("PRAGMA synchronous=NORMAL")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init_schema(self) -> None:
        with self._write_lock, self._connect() as conn:
            # WAL mode persists in the database. Negotiating it once at startup
            # avoids a locking pragma on every concurrent read request.
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS schema_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS nodes (
                    id TEXT PRIMARY KEY,
                    parent_id TEXT REFERENCES nodes(id),
                    kind TEXT NOT NULL CHECK(kind IN ('folder','page','image','video','pdf','file')),
                    title TEXT NOT NULL,
                    icon TEXT NOT NULL DEFAULT '',
                    slug TEXT NOT NULL UNIQUE,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
                    file_name TEXT NOT NULL DEFAULT '',
                    storage_name TEXT NOT NULL DEFAULT '',
                    mime_type TEXT NOT NULL DEFAULT '',
                    size_bytes INTEGER NOT NULL DEFAULT 0,
                    description TEXT NOT NULL DEFAULT '',
                    version INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_wiki_nodes_parent ON nodes(parent_id, sort_order, title);
                CREATE INDEX IF NOT EXISTS idx_wiki_nodes_status ON nodes(status, deleted_at);
                CREATE TABLE IF NOT EXISTS aliases (
                    id TEXT PRIMARY KEY,
                    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
                    term TEXT NOT NULL,
                    normalized TEXT NOT NULL,
                    anchor TEXT NOT NULL DEFAULT '',
                    UNIQUE(node_id, normalized, anchor)
                );
                CREATE INDEX IF NOT EXISTS idx_wiki_alias_normalized ON aliases(normalized);
                CREATE TABLE IF NOT EXISTS sections (
                    id TEXT PRIMARY KEY,
                    page_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
                    anchor TEXT NOT NULL,
                    heading TEXT NOT NULL,
                    normalized TEXT NOT NULL,
                    level INTEGER NOT NULL,
                    ordinal INTEGER NOT NULL,
                    UNIQUE(page_id, anchor)
                );
                CREATE INDEX IF NOT EXISTS idx_wiki_section_normalized ON sections(normalized);
                CREATE TABLE IF NOT EXISTS redirects (
                    old_slug TEXT PRIMARY KEY,
                    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS class_features (
                    class_id TEXT NOT NULL,
                    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
                    teacher_email TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(class_id, node_id)
                );
                CREATE TABLE IF NOT EXISTS bookmarks (
                    id TEXT PRIMARY KEY,
                    owner_email TEXT NOT NULL,
                    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
                    class_id TEXT NOT NULL DEFAULT '',
                    kind TEXT NOT NULL CHECK(kind IN ('personal','lesson_material')),
                    created_at TEXT NOT NULL,
                    UNIQUE(owner_email, node_id, class_id, kind)
                );
                CREATE INDEX IF NOT EXISTS idx_wiki_bookmarks_owner ON bookmarks(owner_email, created_at);
                CREATE INDEX IF NOT EXISTS idx_wiki_bookmarks_class ON bookmarks(class_id, kind, created_at);
                CREATE TABLE IF NOT EXISTS revisions (
                    id TEXT PRIMARY KEY,
                    page_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
                    storage_name TEXT NOT NULL,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS page_drafts (
                    page_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
                    storage_name TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS standards (
                    id TEXT PRIMARY KEY,
                    standard_id TEXT NOT NULL,
                    normalized_id TEXT NOT NULL UNIQUE,
                    description TEXT NOT NULL,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS page_standards (
                    page_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
                    standard_id TEXT NOT NULL REFERENCES standards(id) ON DELETE CASCADE,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(page_id, standard_id)
                );
                CREATE INDEX IF NOT EXISTS idx_wiki_page_standards_page ON page_standards(page_id, sort_order);
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS analytics_daily (
                    day TEXT NOT NULL,
                    event TEXT NOT NULL,
                    event_key TEXT NOT NULL,
                    count INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(day, event, event_key)
                );
                """
            )
            node_columns = {row["name"] for row in conn.execute("PRAGMA table_info(nodes)")}
            if "icon" not in node_columns:
                conn.execute("ALTER TABLE nodes ADD COLUMN icon TEXT NOT NULL DEFAULT ''")
            conn.execute(
                "INSERT INTO schema_meta(key,value) VALUES('schema_version',?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (str(SCHEMA_VERSION),),
            )
            conn.execute("INSERT OR IGNORE INTO settings(key,value) VALUES('catalog_version','1')")
            migrated = conn.execute(
                "SELECT value FROM settings WHERE key='structured_standards_migrated'"
            ).fetchone()
            if not migrated:
                legacy = conn.execute(
                    "SELECT value FROM settings WHERE key='home_standards_markdown'"
                ).fetchone()
                legacy_markdown = str(legacy["value"] or "").strip() if legacy else ""
                if legacy_markdown and not conn.execute("SELECT 1 FROM standards LIMIT 1").fetchone():
                    _headings, plain = parse_markdown(legacy_markdown)
                    description = re.sub(r"\s+", " ", plain).strip()[:MAX_STANDARD_DESCRIPTION_CHARS]
                    if description:
                        now = utc_timestamp()
                        conn.execute(
                            "INSERT INTO standards(id,standard_id,normalized_id,description,sort_order,created_at,updated_at) "
                            "VALUES(?,?,?,?,0,?,?)",
                            (uuid.uuid4().hex, "Imported-Standards", normalize_term("Imported-Standards"), description, now, now),
                        )
                conn.execute(
                    "INSERT OR REPLACE INTO settings(key,value) VALUES('structured_standards_migrated','1')"
                )
            try:
                conn.execute(
                    "CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5("
                    "node_id UNINDEXED, title, aliases, headings, body, "
                    "tokenize='unicode61 remove_diacritics 2')"
                )
                conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('fts5','1')")
            except sqlite3.OperationalError:
                conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('fts5','0')")

    def _cache_get(self, cache: OrderedDict, key: tuple[Any, ...]) -> Any:
        with self._cache_lock:
            value = cache.get(key)
            if value is None:
                return None
            cache.move_to_end(key)
        return copy.deepcopy(value)

    def _cache_put(self, cache: OrderedDict, key: tuple[Any, ...], value: Any, limit: int) -> None:
        cached_value = copy.deepcopy(value)
        with self._cache_lock:
            cache[key] = cached_value
            cache.move_to_end(key)
            while len(cache) > limit:
                cache.popitem(last=False)

    def _clear_read_caches(self) -> None:
        with self._cache_lock:
            self._node_cache.clear()
            self._tree_cache.clear()
            self._search_cache.clear()
            self._link_cache.clear()

    def checkpoint(self) -> None:
        with self._connect() as conn:
            try:
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except sqlite3.DatabaseError:
                pass

    @staticmethod
    def _row_dict(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        for key in ("sort_order", "size_bytes", "version"):
            if key in result:
                result[key] = int(result[key] or 0)
        return result

    @staticmethod
    def _validate_id(value: Any) -> str:
        cleaned = str(value or "").strip().lower()
        if not re.fullmatch(r"[0-9a-f]{32}", cleaned):
            raise ValueError("Invalid wiki identifier")
        return cleaned

    def _unique_slug(self, conn: sqlite3.Connection, requested: str, exclude_id: str = "") -> str:
        base = slugify(requested)
        candidate = base
        for number in range(2, 10_002):
            row = conn.execute("SELECT id FROM nodes WHERE slug=?", (candidate,)).fetchone()
            if not row or row["id"] == exclude_id:
                return candidate
            candidate = f"{base[:130]}-{number}"
        raise ValueError("Could not create a unique wiki URL")

    @staticmethod
    def _parent_exists(conn: sqlite3.Connection, parent_id: Optional[str]) -> None:
        if not parent_id:
            return
        row = conn.execute(
            "SELECT kind,deleted_at FROM nodes WHERE id=?", (parent_id,)
        ).fetchone()
        if not row or row["deleted_at"] or row["kind"] != "folder":
            raise ValueError("Parent folder not found")

    @staticmethod
    def _next_order(conn: sqlite3.Connection, parent_id: Optional[str]) -> int:
        if parent_id:
            row = conn.execute(
                "SELECT COALESCE(MAX(sort_order),-1)+1 value FROM nodes WHERE parent_id=? AND deleted_at IS NULL",
                (parent_id,),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT COALESCE(MAX(sort_order),-1)+1 value FROM nodes WHERE parent_id IS NULL AND deleted_at IS NULL"
            ).fetchone()
        return int(row["value"] or 0)

    def _bump_version(self, conn: sqlite3.Connection) -> int:
        row = conn.execute("SELECT value FROM settings WHERE key='catalog_version'").fetchone()
        value = int(row["value"] if row else 0) + 1
        conn.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('catalog_version',?)", (str(value),))
        self._clear_read_caches()
        return value

    def catalog_version(self) -> int:
        with self._connect() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key='catalog_version'").fetchone()
            return int(row["value"] if row else 1)

    def home_settings(self) -> dict[str, Any]:
        values = {
            "title": DEFAULT_HOME_TITLE,
            "subtitle": DEFAULT_HOME_SUBTITLE,
            "footer_text": DEFAULT_FOOTER_TEXT,
            "standards_markdown": "",
            "standards": [],
            "external_resources": [],
        }
        with self._connect() as conn:
            for row in conn.execute(
                "SELECT key,value FROM settings WHERE key IN ('home_title','home_subtitle','home_footer_text','home_standards_markdown','home_external_resources')"
            ):
                if row["key"] == "home_title":
                    values["title"] = str(row["value"] or DEFAULT_HOME_TITLE)
                elif row["key"] == "home_subtitle":
                    values["subtitle"] = str(row["value"] or DEFAULT_HOME_SUBTITLE)
                elif row["key"] == "home_footer_text":
                    values["footer_text"] = safe_footer_text(row["value"])
                elif row["key"] == "home_standards_markdown":
                    values["standards_markdown"] = str(row["value"] or "")
                elif row["key"] == "home_external_resources":
                    try:
                        values["external_resources"] = safe_external_resources(json.loads(row["value"] or "[]"))
                    except (ValueError, TypeError, json.JSONDecodeError):
                        values["external_resources"] = []
            values["standards"] = self._list_standards_locked(conn)
        return values

    @staticmethod
    def _list_standards_locked(conn: sqlite3.Connection) -> list[dict[str, Any]]:
        return [dict(row) for row in conn.execute(
            "SELECT id,standard_id,description,sort_order FROM standards ORDER BY sort_order,standard_id COLLATE NOCASE"
        )]

    def list_standards(self) -> list[dict[str, Any]]:
        with self._connect() as conn:
            return self._list_standards_locked(conn)

    def _replace_standards(self, conn: sqlite3.Connection, standards: Any) -> None:
        cleaned = safe_standards(standards)
        existing = {row["id"]: dict(row) for row in conn.execute(
            "SELECT id,normalized_id,created_at FROM standards"
        )}
        existing_by_normalized = {row["normalized_id"]: row for row in existing.values()}
        retained: set[str] = set()
        now = utc_timestamp()
        assignments: list[tuple[dict[str, Any], Optional[dict[str, Any]], str]] = []
        for item in cleaned:
            current = existing.get(item["id"]) or existing_by_normalized.get(item["normalized_id"])
            standard_key = current["id"] if current else uuid.uuid4().hex
            retained.add(standard_key)
            assignments.append((item, current, standard_key))
        for standard_key in existing:
            conn.execute(
                "UPDATE standards SET normalized_id=? WHERE id=?",
                (f"__updating__{standard_key}", standard_key),
            )
        for item, current, standard_key in assignments:
            conn.execute(
                "INSERT INTO standards(id,standard_id,normalized_id,description,sort_order,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET "
                "standard_id=excluded.standard_id,normalized_id=excluded.normalized_id,description=excluded.description,"
                "sort_order=excluded.sort_order,updated_at=excluded.updated_at",
                (
                    standard_key, item["standard_id"], item["normalized_id"], item["description"],
                    item["sort_order"], current["created_at"] if current else now, now,
                ),
            )
        for standard_key in set(existing) - retained:
            conn.execute("DELETE FROM standards WHERE id=?", (standard_key,))

    def update_home_settings(
        self,
        title: Any,
        subtitle: Any,
        standards_markdown: Any = None,
        external_resources: Any = None,
        standards: Any = None,
        footer_text: Any = None,
    ) -> dict[str, Any]:
        current = self.home_settings()
        clean_title = current["title"] if title is None else safe_title(title, DEFAULT_HOME_TITLE)
        clean_subtitle = current["subtitle"] if subtitle is None else (safe_description(subtitle) or DEFAULT_HOME_SUBTITLE)
        clean_standards = current["standards_markdown"] if standards_markdown is None else safe_home_standards(standards_markdown)
        clean_resources = current["external_resources"] if external_resources is None else safe_external_resources(external_resources)
        clean_footer = current["footer_text"] if footer_text is None else safe_footer_text(footer_text)
        if standards is not None:
            safe_standards(standards)
        with self._write_lock, self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO settings(key,value) VALUES('home_title',?)",
                (clean_title,),
            )
            conn.execute(
                "INSERT OR REPLACE INTO settings(key,value) VALUES('home_subtitle',?)",
                (clean_subtitle,),
            )
            conn.execute(
                "INSERT OR REPLACE INTO settings(key,value) VALUES('home_standards_markdown',?)",
                (clean_standards,),
            )
            conn.execute(
                "INSERT OR REPLACE INTO settings(key,value) VALUES('home_external_resources',?)",
                (json.dumps(clean_resources, ensure_ascii=False, separators=(",", ":")),),
            )
            conn.execute(
                "INSERT OR REPLACE INTO settings(key,value) VALUES('home_footer_text',?)",
                (clean_footer,),
            )
            if standards is not None:
                self._replace_standards(conn, standards)
            self._bump_version(conn)
        return self.home_settings()

    def import_standards(self, standards: Any) -> dict[str, Any]:
        """Merge validated standards by their human-readable Standard ID."""
        imported = safe_standards(standards)
        if not imported:
            raise ValueError("The CSV file does not contain any standards")
        with self._write_lock, self._connect() as conn:
            existing = self._list_standards_locked(conn)
            combined = [dict(item) for item in existing]
            positions = {
                normalize_term(item["standard_id"]): index
                for index, item in enumerate(combined)
            }
            for item in imported:
                current_index = positions.get(item["normalized_id"])
                if current_index is None:
                    positions[item["normalized_id"]] = len(combined)
                    combined.append({
                        "standard_id": item["standard_id"],
                        "description": item["description"],
                    })
                else:
                    combined[current_index] = {
                        **combined[current_index],
                        "standard_id": item["standard_id"],
                        "description": item["description"],
                    }
            self._replace_standards(conn, combined)
            self._bump_version(conn)
        return self.home_settings()

    def _replace_page_standards(
        self, conn: sqlite3.Connection, page_id: str, standard_ids: Iterable[Any]
    ) -> None:
        requested: list[str] = []
        for raw_id in standard_ids or []:
            standard_id = self._validate_id(raw_id)
            if standard_id not in requested:
                requested.append(standard_id)
        if len(requested) > MAX_STANDARDS:
            raise ValueError(f"A page can cover at most {MAX_STANDARDS} standards")
        if requested:
            placeholders = ",".join("?" for _ in requested)
            found = {row["id"] for row in conn.execute(
                f"SELECT id FROM standards WHERE id IN ({placeholders})", requested
            )}
            if found != set(requested):
                raise ValueError("One or more selected standards no longer exist")
        conn.execute("DELETE FROM page_standards WHERE page_id=?", (page_id,))
        conn.executemany(
            "INSERT INTO page_standards(page_id,standard_id,sort_order) VALUES(?,?,?)",
            [(page_id, standard_id, order) for order, standard_id in enumerate(requested)],
        )

    def _replace_aliases(self, conn: sqlite3.Connection, node_id: str, aliases: Iterable[Any]) -> None:
        conn.execute("DELETE FROM aliases WHERE node_id=?", (node_id,))
        seen: set[str] = set()
        for raw in aliases or []:
            term = safe_title(raw, "")
            normalized = normalize_term(term)
            if not term or not normalized or normalized in seen:
                continue
            seen.add(normalized)
            conn.execute(
                "INSERT INTO aliases(id,node_id,term,normalized,anchor) VALUES(?,?,?,?, '')",
                (uuid.uuid4().hex, node_id, term, normalized),
            )

    def _replace_sections(self, conn: sqlite3.Connection, page_id: str, markdown: str) -> tuple[list[dict[str, Any]], str]:
        previous = {
            (normalize_term(row["heading"]), int(row["ordinal"])): row["id"]
            for row in conn.execute("SELECT id,heading,ordinal FROM sections WHERE page_id=?", (page_id,))
        }
        headings, plain = parse_markdown(markdown)
        conn.execute("DELETE FROM sections WHERE page_id=?", (page_id,))
        for item in headings:
            item["id"] = previous.get((normalize_term(item["heading"]), item["ordinal"]), item["id"])
            conn.execute(
                "INSERT INTO sections(id,page_id,anchor,heading,normalized,level,ordinal) VALUES(?,?,?,?,?,?,?)",
                (
                    item["id"], page_id, item["anchor"], item["heading"],
                    normalize_term(item["heading"]), item["level"], item["ordinal"],
                ),
            )
        return headings, plain

    def _reindex_node(self, conn: sqlite3.Connection, node_id: str, markdown: str = "") -> None:
        fts = conn.execute("SELECT value FROM settings WHERE key='fts5'").fetchone()
        if not fts or fts["value"] != "1":
            return
        row = conn.execute("SELECT title FROM nodes WHERE id=?", (node_id,)).fetchone()
        if not row:
            return
        aliases = " ".join(
            item["term"] for item in conn.execute("SELECT term FROM aliases WHERE node_id=?", (node_id,))
        )
        headings = " ".join(
            item["heading"] for item in conn.execute("SELECT heading FROM sections WHERE page_id=? ORDER BY ordinal", (node_id,))
        )
        _, plain = parse_markdown(markdown)
        conn.execute("DELETE FROM wiki_fts WHERE node_id=?", (node_id,))
        conn.execute(
            "INSERT INTO wiki_fts(node_id,title,aliases,headings,body) VALUES(?,?,?,?,?)",
            (node_id, row["title"], aliases, headings, plain),
        )

    def create_folder(self, title: Any, parent_id: Optional[str] = None, icon: Any = "") -> dict[str, Any]:
        title = safe_title(title, "New Folder")
        parent_id = self._validate_id(parent_id) if parent_id else None
        now = utc_timestamp()
        node_id = uuid.uuid4().hex
        with self._write_lock, self._connect() as conn:
            self._parent_exists(conn, parent_id)
            slug = self._unique_slug(conn, title)
            conn.execute(
                "INSERT INTO nodes(id,parent_id,kind,title,icon,slug,sort_order,status,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?, 'published',?,?)",
                (node_id, parent_id, "folder", title, safe_icon(icon), slug, self._next_order(conn, parent_id), now, now),
            )
            self._bump_version(conn)
        return self.get_node(node_id, include_drafts=True) or {}

    def create_page(
        self,
        title: Any,
        content: str = "",
        parent_id: Optional[str] = None,
        *,
        status: str = "draft",
        aliases: Iterable[Any] = (),
        description: Any = "",
        icon: Any = "",
        file_name: str = "",
        standard_ids: Iterable[Any] = (),
    ) -> dict[str, Any]:
        title = safe_title(title, "Untitled Page")
        parent_id = self._validate_id(parent_id) if parent_id else None
        content = str(content or "")
        if len(content.encode("utf-8")) > MAX_PAGE_BYTES:
            raise ValueError("Markdown page exceeds the 2MB limit")
        status = "published" if status == "published" else "draft"
        node_id = uuid.uuid4().hex
        storage_name = f"{node_id}.md"
        path = self.content_dir / storage_name
        now = utc_timestamp()
        atomic_write_text(path, content)
        try:
            with self._write_lock, self._connect() as conn:
                self._parent_exists(conn, parent_id)
                slug = self._unique_slug(conn, title)
                conn.execute(
                    "INSERT INTO nodes(id,parent_id,kind,title,icon,slug,sort_order,status,file_name,storage_name,mime_type,size_bytes,description,created_at,updated_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,'text/markdown; charset=utf-8',?,?,?,?)",
                    (
                        node_id, parent_id, "page", title, safe_icon(icon), slug, self._next_order(conn, parent_id), status,
                        safe_filename(file_name or f"{slug}.md"), storage_name, len(content.encode("utf-8")),
                        safe_description(description), now, now,
                    ),
                )
                self._replace_aliases(conn, node_id, aliases)
                self._replace_page_standards(conn, node_id, standard_ids)
                self._replace_sections(conn, node_id, content)
                self._reindex_node(conn, node_id, content)
                if status == "published":
                    self._create_revision_locked(conn, node_id, title, content)
                self._bump_version(conn)
        except Exception:
            path.unlink(missing_ok=True)
            raise
        return self.get_node(node_id, include_drafts=True) or {}

    def _create_revision_locked(self, conn: sqlite3.Connection, page_id: str, title: str, content: str) -> str:
        revision_id = uuid.uuid4().hex
        storage_name = f"{page_id}/{revision_id}.md"
        atomic_write_text(self.revisions_dir / storage_name, content)
        conn.execute(
            "INSERT INTO revisions(id,page_id,storage_name,title,created_at) VALUES(?,?,?,?,?)",
            (revision_id, page_id, storage_name, safe_title(title), utc_timestamp()),
        )
        stale = list(conn.execute(
            "SELECT id,storage_name FROM revisions WHERE page_id=? "
            "ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET ?",
            (page_id, MAX_REVISIONS_PER_PAGE),
        ))
        for row in stale:
            conn.execute("DELETE FROM revisions WHERE id=?", (row["id"],))
            (self.revisions_dir / Path(row["storage_name"]).as_posix()).unlink(missing_ok=True)
        return revision_id

    def prune_revisions(self) -> int:
        removed = 0
        with self._write_lock, self._connect() as conn:
            page_ids = [row["page_id"] for row in conn.execute("SELECT DISTINCT page_id FROM revisions")]
            for page_id in page_ids:
                stale = list(conn.execute(
                    "SELECT id,storage_name FROM revisions WHERE page_id=? "
                    "ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET ?",
                    (page_id, MAX_REVISIONS_PER_PAGE),
                ))
                for row in stale:
                    conn.execute("DELETE FROM revisions WHERE id=?", (row["id"],))
                    (self.revisions_dir / Path(row["storage_name"]).as_posix()).unlink(missing_ok=True)
                    removed += 1
        return removed

    def update_node(
        self,
        node_id: str,
        *,
        title: Any = None,
        slug: Any = None,
        description: Any = None,
        icon: Any = None,
        status: Optional[str] = None,
        aliases: Optional[Iterable[Any]] = None,
        content: Optional[str] = None,
        standard_ids: Optional[Iterable[Any]] = None,
    ) -> dict[str, Any]:
        node_id = self._validate_id(node_id)
        if content is not None:
            content = str(content)
            if len(content.encode("utf-8")) > MAX_PAGE_BYTES:
                raise ValueError("Markdown page exceeds the 2MB limit")
        with self._write_lock, self._connect() as conn:
            row = conn.execute("SELECT * FROM nodes WHERE id=? AND deleted_at IS NULL", (node_id,)).fetchone()
            if not row:
                raise ValueError("Wiki item not found")
            current = dict(row)
            next_title = safe_title(title, current["title"]) if title is not None else current["title"]
            next_slug = current["slug"]
            if slug is not None:
                requested = slugify(slug, next_title)
                next_slug = self._unique_slug(conn, requested, node_id)
                if next_slug != current["slug"]:
                    conn.execute(
                        "INSERT OR REPLACE INTO redirects(old_slug,node_id,created_at) VALUES(?,?,?)",
                        (current["slug"], node_id, utc_timestamp()),
                    )
            next_description = safe_description(description) if description is not None else current["description"]
            next_icon = (
                safe_icon(icon)
                if icon is not None and current["kind"] in {"folder", "page"}
                else current.get("icon", "")
            )
            next_status = current["status"]
            if status is not None:
                next_status = "published" if status == "published" else "draft"
            size_bytes = int(current["size_bytes"] or 0)
            page_content = ""
            if current["kind"] == "page":
                page_path = self.content_dir / current["storage_name"]
                if content is not None:
                    atomic_write_text(page_path, content)
                    size_bytes = len(content.encode("utf-8"))
                    page_content = content
                else:
                    page_content = page_path.read_text(encoding="utf-8") if page_path.exists() else ""
            elif content is not None:
                raise ValueError("Only Markdown pages have editable content")
            elif standard_ids is not None:
                raise ValueError("Only Markdown pages can be tagged with standards")
            conn.execute(
                "UPDATE nodes SET title=?,slug=?,description=?,icon=?,status=?,size_bytes=?,version=version+1,updated_at=? WHERE id=?",
                (next_title, next_slug, next_description, next_icon, next_status, size_bytes, utc_timestamp(), node_id),
            )
            if aliases is not None:
                self._replace_aliases(conn, node_id, aliases)
            if current["kind"] == "page":
                if standard_ids is not None:
                    self._replace_page_standards(conn, node_id, standard_ids)
                self._replace_sections(conn, node_id, page_content)
                self._reindex_node(conn, node_id, page_content)
                if next_status == "published" and (current["status"] != "published" or content is not None):
                    self._create_revision_locked(conn, node_id, next_title, page_content)
                if content is not None:
                    draft = conn.execute("SELECT storage_name FROM page_drafts WHERE page_id=?", (node_id,)).fetchone()
                    conn.execute("DELETE FROM page_drafts WHERE page_id=?", (node_id,))
                    if draft:
                        (self.drafts_dir / Path(draft["storage_name"]).name).unlink(missing_ok=True)
            else:
                self._reindex_node(conn, node_id, "")
            self._bump_version(conn)
        return self.get_node(node_id, include_drafts=True) or {}

    def save_page_draft(self, page_id: str, content: str) -> dict[str, Any]:
        page_id = self._validate_id(page_id)
        content = str(content or "")
        if len(content.encode("utf-8")) > MAX_PAGE_BYTES:
            raise ValueError("Markdown page exceeds the 2MB limit")
        storage_name = f"{page_id}.md"
        with self._write_lock, self._connect() as conn:
            row = conn.execute("SELECT kind,deleted_at FROM nodes WHERE id=?", (page_id,)).fetchone()
            if not row or row["deleted_at"] or row["kind"] != "page":
                raise ValueError("Wiki page not found")
            atomic_write_text(self.drafts_dir / storage_name, content)
            updated_at = utc_timestamp()
            conn.execute(
                "INSERT INTO page_drafts(page_id,storage_name,updated_at) VALUES(?,?,?) "
                "ON CONFLICT(page_id) DO UPDATE SET storage_name=excluded.storage_name,updated_at=excluded.updated_at",
                (page_id, storage_name, updated_at),
            )
        return {"page_id": page_id, "updated_at": updated_at}

    def list_revisions(self, page_id: str) -> list[dict[str, Any]]:
        page_id = self._validate_id(page_id)
        with self._connect() as conn:
            return [
                dict(row) for row in conn.execute(
                    "SELECT id,page_id,title,created_at FROM revisions WHERE page_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?",
                    (page_id, MAX_REVISIONS_PER_PAGE),
                )
            ]

    def restore_revision(self, page_id: str, revision_id: str) -> dict[str, Any]:
        page_id = self._validate_id(page_id)
        revision_id = self._validate_id(revision_id)
        with self._connect() as conn:
            row = conn.execute(
                "SELECT storage_name FROM revisions WHERE id=? AND page_id=?", (revision_id, page_id)
            ).fetchone()
        if not row:
            raise ValueError("Revision not found")
        path = self.revisions_dir / row["storage_name"]
        if not path.exists():
            raise ValueError("Revision file is missing")
        return self.update_node(page_id, content=path.read_text(encoding="utf-8"), status="published")

    def move_node(self, node_id: str, parent_id: Optional[str]) -> dict[str, Any]:
        node_id = self._validate_id(node_id)
        parent_id = self._validate_id(parent_id) if parent_id else None
        if parent_id == node_id:
            raise ValueError("An item cannot be moved into itself")
        with self._write_lock, self._connect() as conn:
            row = conn.execute("SELECT id FROM nodes WHERE id=? AND deleted_at IS NULL", (node_id,)).fetchone()
            if not row:
                raise ValueError("Wiki item not found")
            self._parent_exists(conn, parent_id)
            cursor = parent_id
            while cursor:
                if cursor == node_id:
                    raise ValueError("A folder cannot be moved into one of its descendants")
                parent = conn.execute("SELECT parent_id FROM nodes WHERE id=?", (cursor,)).fetchone()
                cursor = parent["parent_id"] if parent else None
            conn.execute(
                "UPDATE nodes SET parent_id=?,sort_order=?,version=version+1,updated_at=? WHERE id=?",
                (parent_id, self._next_order(conn, parent_id), utc_timestamp(), node_id),
            )
            self._bump_version(conn)
        return self.get_node(node_id, include_drafts=True) or {}

    def reorder_node(self, node_id: str, direction: str) -> dict[str, Any]:
        node_id = self._validate_id(node_id)
        direction = "up" if direction == "up" else "down"
        with self._write_lock, self._connect() as conn:
            node = conn.execute("SELECT id,parent_id,sort_order FROM nodes WHERE id=? AND deleted_at IS NULL", (node_id,)).fetchone()
            if not node:
                raise ValueError("Wiki item not found")
            if node["parent_id"]:
                siblings = list(conn.execute(
                    "SELECT id,sort_order FROM nodes WHERE parent_id=? AND deleted_at IS NULL ORDER BY sort_order,title",
                    (node["parent_id"],),
                ))
            else:
                siblings = list(conn.execute(
                    "SELECT id,sort_order FROM nodes WHERE parent_id IS NULL AND deleted_at IS NULL ORDER BY sort_order,title"
                ))
            index = next((i for i, item in enumerate(siblings) if item["id"] == node_id), -1)
            target_index = index - 1 if direction == "up" else index + 1
            if index >= 0 and 0 <= target_index < len(siblings):
                target = siblings[target_index]
                conn.execute("UPDATE nodes SET sort_order=? WHERE id=?", (target["sort_order"], node_id))
                conn.execute("UPDATE nodes SET sort_order=? WHERE id=?", (node["sort_order"], target["id"]))
                self._bump_version(conn)
        return self.get_node(node_id, include_drafts=True) or {}

    def position_node(self, node_id: str, target_id: str, position: str) -> dict[str, Any]:
        node_id = self._validate_id(node_id)
        target_id = self._validate_id(target_id)
        position = str(position or "").strip().lower()
        if position not in {"before", "after", "inside"}:
            raise ValueError("Drop position must be before, after, or inside")
        if node_id == target_id:
            raise ValueError("An item cannot be dropped onto itself")
        with self._write_lock, self._connect() as conn:
            node = conn.execute(
                "SELECT id,parent_id,kind FROM nodes WHERE id=? AND deleted_at IS NULL", (node_id,)
            ).fetchone()
            target = conn.execute(
                "SELECT id,parent_id,kind FROM nodes WHERE id=? AND deleted_at IS NULL", (target_id,)
            ).fetchone()
            if not node or not target:
                raise ValueError("Wiki item not found")
            if position == "inside":
                if target["kind"] != "folder":
                    raise ValueError("Items can only be dropped inside folders")
                parent_id = target_id
            else:
                parent_id = target["parent_id"]
            cursor = parent_id
            while cursor:
                if cursor == node_id:
                    raise ValueError("A folder cannot be moved into one of its descendants")
                parent = conn.execute("SELECT parent_id FROM nodes WHERE id=?", (cursor,)).fetchone()
                cursor = parent["parent_id"] if parent else None
            if parent_id:
                siblings = list(conn.execute(
                    "SELECT id FROM nodes WHERE parent_id=? AND id<>? AND deleted_at IS NULL ORDER BY sort_order,title COLLATE NOCASE",
                    (parent_id, node_id),
                ))
            else:
                siblings = list(conn.execute(
                    "SELECT id FROM nodes WHERE parent_id IS NULL AND id<>? AND deleted_at IS NULL ORDER BY sort_order,title COLLATE NOCASE",
                    (node_id,),
                ))
            ordered_ids = [row["id"] for row in siblings]
            if position == "inside":
                insert_at = len(ordered_ids)
            else:
                try:
                    target_index = ordered_ids.index(target_id)
                except ValueError as exc:
                    raise ValueError("Drop target is not in the expected folder") from exc
                insert_at = target_index if position == "before" else target_index + 1
            ordered_ids.insert(insert_at, node_id)
            now = utc_timestamp()
            for order, item_id in enumerate(ordered_ids):
                if item_id == node_id:
                    conn.execute(
                        "UPDATE nodes SET parent_id=?,sort_order=?,version=version+1,updated_at=? WHERE id=?",
                        (parent_id, order, now, item_id),
                    )
                else:
                    conn.execute("UPDATE nodes SET sort_order=? WHERE id=?", (order, item_id))
            if node["parent_id"] != parent_id:
                if node["parent_id"]:
                    old_siblings = conn.execute(
                        "SELECT id FROM nodes WHERE parent_id=? AND id<>? AND deleted_at IS NULL ORDER BY sort_order,title COLLATE NOCASE",
                        (node["parent_id"], node_id),
                    )
                else:
                    old_siblings = conn.execute(
                        "SELECT id FROM nodes WHERE parent_id IS NULL AND id<>? AND deleted_at IS NULL ORDER BY sort_order,title COLLATE NOCASE",
                        (node_id,),
                    )
                for order, row in enumerate(old_siblings):
                    conn.execute("UPDATE nodes SET sort_order=? WHERE id=?", (order, row["id"]))
            self._bump_version(conn)
        return self.get_node(node_id, include_drafts=True) or {}

    def soft_delete(self, node_id: str) -> None:
        node_id = self._validate_id(node_id)
        with self._write_lock, self._connect() as conn:
            if not conn.execute("SELECT id FROM nodes WHERE id=? AND deleted_at IS NULL", (node_id,)).fetchone():
                raise ValueError("Wiki item not found")
            descendants = self._descendant_ids(conn, node_id, include_root=True)
            stamp = utc_timestamp()
            conn.executemany("UPDATE nodes SET deleted_at=?,updated_at=? WHERE id=?", [(stamp, stamp, item) for item in descendants])
            if conn.execute("SELECT value FROM settings WHERE key='fts5'").fetchone()["value"] == "1":
                conn.executemany("DELETE FROM wiki_fts WHERE node_id=?", [(item,) for item in descendants])
            self._bump_version(conn)

    def restore_deleted(self, node_id: str) -> None:
        node_id = self._validate_id(node_id)
        with self._write_lock, self._connect() as conn:
            if not conn.execute("SELECT id FROM nodes WHERE id=?", (node_id,)).fetchone():
                raise ValueError("Wiki item not found")
            descendants = self._descendant_ids(conn, node_id, include_root=True)
            conn.executemany("UPDATE nodes SET deleted_at=NULL,updated_at=? WHERE id=?", [(utc_timestamp(), item) for item in descendants])
            for item in descendants:
                row = conn.execute("SELECT kind,storage_name FROM nodes WHERE id=?", (item,)).fetchone()
                markdown = ""
                if row and row["kind"] == "page":
                    path = self.content_dir / row["storage_name"]
                    markdown = path.read_text(encoding="utf-8") if path.exists() else ""
                self._reindex_node(conn, item, markdown)
            self._bump_version(conn)

    @staticmethod
    def _descendant_ids(conn: sqlite3.Connection, node_id: str, include_root: bool = False) -> list[str]:
        rows = conn.execute(
            "WITH RECURSIVE descendants(id) AS ("
            "SELECT id FROM nodes WHERE parent_id=? UNION ALL "
            "SELECT n.id FROM nodes n JOIN descendants d ON n.parent_id=d.id) SELECT id FROM descendants",
            (node_id,),
        ).fetchall()
        result = [row["id"] for row in rows]
        if include_root:
            result.insert(0, node_id)
        return result

    def _breadcrumbs(self, conn: sqlite3.Connection, node: sqlite3.Row) -> list[dict[str, str]]:
        items: list[dict[str, str]] = []
        cursor: Optional[sqlite3.Row] = node
        seen: set[str] = set()
        while cursor and cursor["id"] not in seen:
            seen.add(cursor["id"])
            items.append({"id": cursor["id"], "title": cursor["title"], "slug": cursor["slug"], "kind": cursor["kind"]})
            cursor = conn.execute(
                "SELECT id,parent_id,title,slug,kind FROM nodes WHERE id=? AND deleted_at IS NULL",
                (cursor["parent_id"],),
            ).fetchone() if cursor["parent_id"] else None
        items.reverse()
        return items

    def get_node(
        self,
        identifier: str,
        *,
        include_drafts: bool = False,
        include_content: bool = True,
    ) -> Optional[dict[str, Any]]:
        cleaned = str(identifier or "").strip()
        cache_version = self.catalog_version() if not include_drafts else 0
        cache_key = (cache_version, cleaned.casefold(), bool(include_content))
        if not include_drafts:
            cached = self._cache_get(self._node_cache, cache_key)
            if cached is not None:
                return cached
        with self._connect() as conn:
            if re.fullmatch(r"[0-9a-f]{32}", cleaned.lower()):
                row = conn.execute("SELECT * FROM nodes WHERE id=?", (cleaned.lower(),)).fetchone()
            else:
                row = conn.execute("SELECT * FROM nodes WHERE slug=?", (slugify(cleaned),)).fetchone()
                if not row:
                    redirect = conn.execute("SELECT node_id FROM redirects WHERE old_slug=?", (slugify(cleaned),)).fetchone()
                    row = conn.execute("SELECT * FROM nodes WHERE id=?", (redirect["node_id"],)).fetchone() if redirect else None
            if not row or row["deleted_at"] or (not include_drafts and row["status"] != "published"):
                return None
            result = self._row_dict(row)
            result["aliases"] = [item["term"] for item in conn.execute("SELECT term FROM aliases WHERE node_id=? ORDER BY term", (row["id"],))]
            result["standards"] = [dict(item) for item in conn.execute(
                "SELECT s.id,s.standard_id,s.description FROM page_standards ps "
                "JOIN standards s ON s.id=ps.standard_id WHERE ps.page_id=? "
                "ORDER BY ps.sort_order,s.sort_order,s.standard_id COLLATE NOCASE",
                (row["id"],),
            )] if row["kind"] == "page" else []
            result["standard_ids"] = [item["id"] for item in result["standards"]]
            result["breadcrumbs"] = self._breadcrumbs(conn, row)
            result["sections"] = [dict(item) for item in conn.execute(
                "SELECT id,anchor,heading,level,ordinal FROM sections WHERE page_id=? ORDER BY ordinal", (row["id"],)
            )]
            if row["kind"] == "page" and include_content:
                path = self.content_dir / row["storage_name"]
                result["markdown"] = path.read_text(encoding="utf-8") if path.exists() else ""
                if include_drafts:
                    draft = conn.execute("SELECT storage_name,updated_at FROM page_drafts WHERE page_id=?", (row["id"],)).fetchone()
                    draft_path = self.drafts_dir / Path(draft["storage_name"]).name if draft else None
                    result["draft_markdown"] = draft_path.read_text(encoding="utf-8") if draft_path and draft_path.exists() else ""
                    result["draft_updated_at"] = draft["updated_at"] if draft else ""
            else:
                result["markdown"] = ""
            result["media_url"] = f"/api/wiki/media/{row['id']}" if row["kind"] in {"image", "video", "pdf", "file"} else ""
            result["download_url"] = f"/api/wiki/media/{row['id']}?download=1" if row["kind"] in {"image", "video", "pdf", "file"} else ""
            if not include_drafts:
                self._cache_put(self._node_cache, cache_key, result, 32)
            return result

    def get_tree(
        self,
        *,
        include_drafts: bool = False,
        include_deleted: bool = False,
        include_images: bool = True,
    ) -> list[dict[str, Any]]:
        cache_key = (
            self.catalog_version(), bool(include_drafts), bool(include_deleted), bool(include_images)
        )
        cached = self._cache_get(self._tree_cache, cache_key)
        if cached is not None:
            return cached
        conditions = []
        if not include_deleted:
            conditions.append("deleted_at IS NULL")
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        with self._connect() as conn:
            rows = [self._row_dict(row) for row in conn.execute(
                f"SELECT id,parent_id,kind,title,icon,slug,sort_order,status,description,mime_type,size_bytes,updated_at,deleted_at "
                f"FROM nodes {where} ORDER BY sort_order,title COLLATE NOCASE"
            )]
        if not include_images:
            rows = [item for item in rows if item["kind"] != "image"]
        if not include_drafts:
            rows = [item for item in rows if item["kind"] != "image"]
            by_id = {item["id"]: item for item in rows}
            visible = {item["id"] for item in rows if item["status"] == "published"}
            changed = True
            while changed:
                changed = False
                for item_id in list(visible):
                    parent_id = by_id[item_id]["parent_id"]
                    if parent_id and parent_id not in visible:
                        visible.remove(item_id)
                        changed = True
            rows = [item for item in rows if item["id"] in visible]
        by_parent: dict[Optional[str], list[dict[str, Any]]] = defaultdict(list)
        node_lookup = {item["id"]: item for item in rows}
        ids = {item["id"] for item in rows}
        for item in rows:
            item["children"] = []
            parent = item["parent_id"] if item["parent_id"] in ids else None
            by_parent[parent].append(item)
        for parent_id, children in by_parent.items():
            children.sort(key=lambda item: (item["sort_order"], item["title"].casefold()))
            if parent_id and parent_id in ids:
                parent = node_lookup.get(parent_id)
                if parent:
                    parent["children"] = children
        tree = by_parent.get(None, [])
        self._cache_put(self._tree_cache, cache_key, tree, 8)
        return tree

    def _link_candidates(self, markdown: str, current_id: str) -> list[dict[str, str]]:
        cache_key = (self.catalog_version(), str(current_id or ""))
        cached = self._cache_get(self._link_cache, cache_key)
        if cached is not None:
            return cached
        haystack = normalize_term(markdown)
        if not haystack:
            return []
        terms: dict[str, list[dict[str, str]]] = defaultdict(list)
        with self._connect() as conn:
            for row in conn.execute(
                "SELECT id,title,slug FROM nodes WHERE status='published' AND deleted_at IS NULL AND kind!='image'"
            ):
                term = normalize_term(row["title"])
                terms[term].append({"term": row["title"], "node_id": row["id"], "slug": row["slug"], "anchor": "", "title": row["title"]})
            for row in conn.execute(
                "SELECT a.term,a.normalized,a.node_id,a.anchor,n.slug,n.title FROM aliases a "
                "JOIN nodes n ON n.id=a.node_id WHERE n.status='published' AND n.deleted_at IS NULL"
            ):
                terms[row["normalized"]].append({"term": row["term"], "node_id": row["node_id"], "slug": row["slug"], "anchor": row["anchor"], "title": row["title"]})
            for row in conn.execute(
                "SELECT s.heading,s.normalized,s.page_id,s.anchor,n.slug,n.title FROM sections s "
                "JOIN nodes n ON n.id=s.page_id WHERE n.status='published' AND n.deleted_at IS NULL"
            ):
                terms[row["normalized"]].append({"term": row["heading"], "node_id": row["page_id"], "slug": row["slug"], "anchor": row["anchor"], "title": row["title"]})
        candidates: list[dict[str, str]] = []
        for normalized, destinations in terms.items():
            if len(normalized) < 3 or normalized in AUTO_LINK_STOP_TERMS or normalized not in haystack:
                continue
            unique_nodes = {item["node_id"] for item in destinations}
            if len(unique_nodes) != 1:
                continue
            root_destination = next((item for item in destinations if not item["anchor"]), None)
            unique_targets = {(item["node_id"], item["anchor"]) for item in destinations}
            if not root_destination and len(unique_targets) != 1:
                continue
            item = root_destination or destinations[0]
            if item["node_id"] == current_id:
                continue
            candidates.append(item)
        candidates.sort(key=lambda item: (-len(item["term"]), item["term"].casefold()))
        candidates = candidates[:250]
        self._cache_put(self._link_cache, cache_key, candidates, 64)
        return candidates

    def page_response(self, identifier: str, *, include_drafts: bool = False) -> Optional[dict[str, Any]]:
        node = self.get_node(identifier, include_drafts=include_drafts)
        if not node:
            return None
        node["link_candidates"] = self._link_candidates(node.get("markdown", ""), node["id"]) if node["kind"] == "page" else []
        with self._connect() as conn:
            if node["kind"] == "folder":
                node["children"] = [self._row_dict(row) for row in conn.execute(
                    "SELECT id,parent_id,kind,title,slug,sort_order,status,description,mime_type,size_bytes,updated_at "
                    "FROM nodes WHERE parent_id=? AND deleted_at IS NULL "
                    + ("" if include_drafts else "AND status='published' ")
                    + "ORDER BY sort_order,title COLLATE NOCASE",
                    (node["id"],),
                )]
            else:
                node["children"] = []
        return {"node": node, "catalog_version": self.catalog_version()}

    @staticmethod
    def _page_locations(markdown: str, term: Any = "", anchor: Any = "") -> list[dict[str, str]]:
        requested_term = re.sub(r"\s+", " ", str(term or "")).strip()[:200]
        requested_anchor = slugify(anchor, "") if anchor else ""
        used: dict[str, int] = {}
        sections: list[dict[str, Any]] = [{"heading": "Overview", "anchor": "", "lines": []}]
        current = sections[0]
        fence: Optional[str] = None
        for raw_line in str(markdown or "").splitlines():
            stripped = raw_line.lstrip()
            marker = stripped[:3]
            if marker in {"```", "~~~"}:
                fence = None if fence == marker else marker if fence is None else fence
                continue
            if fence:
                continue
            heading_match = _HEADING_RE.match(raw_line)
            if heading_match:
                heading = safe_title(_strip_inline_markdown(heading_match.group(2)), "Section")
                base = slugify(heading, "section")
                used[base] = used.get(base, 0) + 1
                section_anchor = base if used[base] == 1 else f"{base}-{used[base]}"
                current = {"heading": heading, "anchor": section_anchor, "lines": []}
                sections.append(current)
                continue
            cleaned = _strip_inline_markdown(raw_line)
            if cleaned:
                current["lines"].append(cleaned)

        locations: list[dict[str, str]] = []
        seen: set[tuple[str, str]] = set()
        term_folded = requested_term.casefold()

        def add_location(section: dict[str, Any], excerpt: str) -> None:
            excerpt = re.sub(r"\s+", " ", excerpt).strip()[:420]
            key = (section["anchor"], excerpt.casefold())
            if excerpt and key not in seen:
                seen.add(key)
                locations.append({
                    "heading": section["heading"],
                    "anchor": section["anchor"],
                    "excerpt": excerpt,
                })

        if requested_anchor:
            exact = next((section for section in sections if section["anchor"] == requested_anchor), None)
            if exact:
                exact_match_count = len(locations)
                if term_folded:
                    for line in exact["lines"]:
                        folded = line.casefold()
                        start = 0
                        while len(locations) < 12:
                            index = folded.find(term_folded, start)
                            if index < 0:
                                break
                            left = max(0, index - 150)
                            right = min(len(line), index + len(requested_term) + 210)
                            add_location(exact, f"{'…' if left else ''}{line[left:right]}{'…' if right < len(line) else ''}")
                            start = index + max(1, len(requested_term))
                if len(locations) == exact_match_count:
                    add_location(exact, " ".join(exact["lines"][:4]) or exact["heading"])

        if term_folded:
            for section in sections:
                if term_folded in section["heading"].casefold():
                    add_location(section, " ".join(section["lines"][:4]) or section["heading"])
                for line in section["lines"]:
                    folded = line.casefold()
                    start = 0
                    while len(locations) < 12:
                        index = folded.find(term_folded, start)
                        if index < 0:
                            break
                        left = max(0, index - 150)
                        right = min(len(line), index + len(requested_term) + 210)
                        prefix = "…" if left else ""
                        suffix = "…" if right < len(line) else ""
                        add_location(section, f"{prefix}{line[left:right]}{suffix}")
                        start = index + max(1, len(requested_term))
                if len(locations) >= 12:
                    break

        if not locations:
            fallback = next((section for section in sections if section["lines"]), sections[0])
            add_location(fallback, " ".join(fallback["lines"][:4]) or fallback["heading"])
        return locations[:12]

    def preview(self, identifier: str, *, term: Any = "", anchor: Any = "") -> Optional[dict[str, Any]]:
        node = self.get_node(identifier, include_drafts=False, include_content=True)
        if not node:
            return None
        summary = node.get("description", "")
        if not summary and node["kind"] == "page":
            _, plain = parse_markdown(node.get("markdown", ""))
            summary = plain[:280]
        return {
            "id": node["id"], "title": node["title"], "slug": node["slug"], "kind": node["kind"],
            "summary": summary[:280], "breadcrumbs": node["breadcrumbs"],
            "thumbnail_url": node["media_url"] if node["kind"] == "image" else "",
            "locations": self._page_locations(node.get("markdown", ""), term, anchor) if node["kind"] == "page" else [],
        }

    def _decorate_search_results(self, rows: Iterable[Any], query: str) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for source in rows:
            item = dict(source)
            node = self.get_node(item["id"], include_drafts=False, include_content=True)
            locations = self._page_locations(node.get("markdown", ""), query) if node and node["kind"] == "page" else []
            location = locations[0] if locations else {"heading": "", "anchor": "", "excerpt": item.get("description", "")}
            item["anchor"] = location.get("anchor", "")
            item["location_heading"] = location.get("heading", "")
            item["excerpt"] = location.get("excerpt", "")
            results.append(item)
        return results

    def search(self, query: Any, limit: int = 20, offset: int = 0) -> list[dict[str, Any]]:
        raw = re.sub(r"\s+", " ", str(query or "")).strip()[:200]
        tokens = re.findall(r"[\w-]+", raw, flags=re.UNICODE)[:8]
        if not tokens:
            return []
        limit = max(1, min(50, int(limit)))
        offset = max(0, min(10_000, int(offset)))
        cache_key = (self.catalog_version(), normalize_term(raw), limit, offset)
        cached = self._cache_get(self._search_cache, cache_key)
        if cached is not None:
            return cached
        with self._connect() as conn:
            fts = conn.execute("SELECT value FROM settings WHERE key='fts5'").fetchone()
            if fts and fts["value"] == "1":
                expression = " AND ".join(f'"{token.replace(chr(34), "")}"*' for token in tokens)
                try:
                    rows = conn.execute(
                        "SELECT n.id,n.kind,n.title,n.slug,n.description,n.updated_at,"
                        "snippet(wiki_fts,4,'<mark>','</mark>',' … ',24) snippet,bm25(wiki_fts,8.0,6.0,4.0,1.0) rank "
                        "FROM wiki_fts JOIN nodes n ON n.id=wiki_fts.node_id "
                        "WHERE wiki_fts MATCH ? AND n.status='published' AND n.deleted_at IS NULL "
                        "ORDER BY rank,n.title LIMIT ? OFFSET ?",
                        (expression, limit, offset),
                    ).fetchall()
                    results = self._decorate_search_results(rows, raw)
                    self._cache_put(self._search_cache, cache_key, results, 128)
                    return results
                except sqlite3.OperationalError:
                    pass
            like = f"%{normalize_term(raw)}%"
            rows = conn.execute(
                "SELECT DISTINCT n.id,n.kind,n.title,n.slug,n.description,n.updated_at,'' snippet,0 rank "
                "FROM nodes n LEFT JOIN aliases a ON a.node_id=n.id LEFT JOIN sections s ON s.page_id=n.id "
                "WHERE n.status='published' AND n.deleted_at IS NULL AND "
                "(lower(n.title) LIKE ? OR lower(n.description) LIKE ? OR a.normalized LIKE ? OR s.normalized LIKE ?) "
                "ORDER BY CASE WHEN lower(n.title)=? THEN 0 ELSE 1 END,n.title LIMIT ? OFFSET ?",
                (like, like, like, like, normalize_term(raw), limit, offset),
            ).fetchall()
            results = self._decorate_search_results(rows, raw)
            self._cache_put(self._search_cache, cache_key, results, 128)
            return results

    def current_asset_bytes(self) -> int:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT COALESCE(SUM(size_bytes),0) value FROM nodes WHERE kind IN ('image','video','pdf','file') AND deleted_at IS NULL"
            ).fetchone()
            return int(row["value"] or 0)

    def create_asset_from_file(
        self,
        source: Path,
        filename: str,
        parent_id: Optional[str] = None,
        *,
        title: Any = "",
        description: Any = "",
    ) -> dict[str, Any]:
        source = Path(source)
        filename = safe_filename(filename)
        extension = Path(filename).suffix.lower()
        if extension not in ASSET_TYPES:
            raise ValueError("File type is not allowed in the wiki")
        size = source.stat().st_size
        if size <= 0:
            raise ValueError("Uploaded file is empty")
        if size > self.max_asset_bytes:
            raise ValueError("Uploaded file exceeds the configured per-file limit")
        if self.current_asset_bytes() + size > self.max_total_asset_bytes:
            raise ValueError("Wiki media storage limit exceeded")
        if not validate_asset_signature(source, extension):
            raise ValueError("File contents do not match the expected file type")
        kind, mime_type, _ = ASSET_TYPES[extension]
        # Images are a global media library resource, not folder-tree content.
        parent_id = None if kind == "image" else (self._validate_id(parent_id) if parent_id else None)
        node_id = uuid.uuid4().hex
        storage_name = f"{node_id}{extension}"
        target = self.media_dir / storage_name
        os.replace(source, target)
        now = utc_timestamp()
        item_title = safe_title(title, Path(filename).stem or "File")
        try:
            with self._write_lock, self._connect() as conn:
                self._parent_exists(conn, parent_id)
                conn.execute(
                    "INSERT INTO nodes(id,parent_id,kind,title,slug,sort_order,status,file_name,storage_name,mime_type,size_bytes,description,created_at,updated_at) "
                    "VALUES(?,?,?,?,?,?, 'published',?,?,?,?,?,?,?)",
                    (
                        node_id, parent_id, kind, item_title, self._unique_slug(conn, item_title),
                        self._next_order(conn, parent_id), filename, storage_name, mime_type, size,
                        safe_description(description), now, now,
                    ),
                )
                self._reindex_node(conn, node_id, "")
                self._bump_version(conn)
        except Exception:
            target.unlink(missing_ok=True)
            raise
        return self.get_node(node_id, include_drafts=True) or {}

    def media_path(self, node_id: str, *, include_drafts: bool = False) -> tuple[Optional[dict[str, Any]], Optional[Path]]:
        node = self.get_node(node_id, include_drafts=include_drafts, include_content=False)
        if not node or node["kind"] not in {"image", "video", "pdf", "file"}:
            return None, None
        path = self.media_dir / Path(node["storage_name"]).name
        if not path.exists() or path.parent.resolve() != self.media_dir.resolve():
            return None, None
        return node, path

    def list_images(self) -> list[dict[str, Any]]:
        reference_pages: dict[str, set[str]] = defaultdict(set)
        with self._connect() as conn:
            pages = list(conn.execute(
                "SELECT n.id,n.title,n.storage_name,d.storage_name draft_storage FROM nodes n "
                "LEFT JOIN page_drafts d ON d.page_id=n.id "
                "WHERE n.kind='page' AND n.deleted_at IS NULL"
            ))
            images = [self._row_dict(row) for row in conn.execute(
                "SELECT id,parent_id,kind,title,slug,status,file_name,storage_name,mime_type,size_bytes,description,created_at,updated_at "
                "FROM nodes WHERE kind='image' AND deleted_at IS NULL ORDER BY updated_at DESC,title COLLATE NOCASE"
            )]
        for page in pages:
            paths = [self.content_dir / page["storage_name"]]
            if page["draft_storage"]:
                paths.append(self.drafts_dir / Path(page["draft_storage"]).name)
            for path in paths:
                if not path.exists():
                    continue
                for image_id in _DIRECTIVE_ID_RE.findall(path.read_text(encoding="utf-8", errors="replace")):
                    reference_pages[image_id.lower()].add(page["id"])
        for image in images:
            image["media_url"] = f"/api/wiki/media/{image['id']}"
            image["reference_count"] = len(reference_pages.get(image["id"], set()))
        return images

    @staticmethod
    def _remove_image_directive(markdown: str, image_id: str) -> str:
        token = re.compile(r"\{\{image:" + re.escape(image_id) + r"(?:\|[^}]*)?\}\}", re.I)
        cleaned = token.sub("", str(markdown or ""))
        return re.sub(r"\n{3,}", "\n\n", cleaned)

    def delete_image_permanently(self, node_id: str) -> dict[str, Any]:
        node_id = self._validate_id(node_id)
        with self._connect() as conn:
            image = conn.execute(
                "SELECT * FROM nodes WHERE id=? AND kind='image' AND deleted_at IS NULL", (node_id,)
            ).fetchone()
            if not image:
                raise ValueError("Wiki image not found")
            pages = list(conn.execute(
                "SELECT n.id,n.storage_name,d.storage_name draft_storage FROM nodes n "
                "LEFT JOIN page_drafts d ON d.page_id=n.id "
                "WHERE n.kind='page' AND n.deleted_at IS NULL"
            ))
        changed_pages = 0
        for page in pages:
            main_path = self.content_dir / page["storage_name"]
            main = main_path.read_text(encoding="utf-8") if main_path.exists() else ""
            draft_path = self.drafts_dir / Path(page["draft_storage"]).name if page["draft_storage"] else None
            draft = draft_path.read_text(encoding="utf-8") if draft_path and draft_path.exists() else None
            clean_main = self._remove_image_directive(main, node_id)
            clean_draft = self._remove_image_directive(draft, node_id) if draft is not None else None
            changed = clean_main != main or (draft is not None and clean_draft != draft)
            if clean_main != main:
                self.update_node(page["id"], content=clean_main)
                if draft is not None:
                    self.save_page_draft(page["id"], clean_draft or "")
            elif draft is not None and clean_draft != draft:
                self.save_page_draft(page["id"], clean_draft or "")
            if changed:
                changed_pages += 1

        media_path = self.media_dir / Path(image["storage_name"]).name
        tombstone = self.staging_dir / f"delete-{node_id}-{uuid.uuid4().hex}.tmp"
        if media_path.exists():
            os.replace(media_path, tombstone)
        try:
            with self._write_lock, self._connect() as conn:
                fts = conn.execute("SELECT value FROM settings WHERE key='fts5'").fetchone()
                if fts and fts["value"] == "1":
                    conn.execute("DELETE FROM wiki_fts WHERE node_id=?", (node_id,))
                deleted = conn.execute("DELETE FROM nodes WHERE id=? AND kind='image'", (node_id,)).rowcount
                if not deleted:
                    raise ValueError("Wiki image not found")
                self._bump_version(conn)
        except Exception:
            if tombstone.exists():
                os.replace(tombstone, media_path)
            raise
        tombstone.unlink(missing_ok=True)
        return {"id": node_id, "removed_from_pages": changed_pages}

    def create_upload_session(
        self,
        filename: Any,
        total_size: int,
        *,
        parent_id: Optional[str] = None,
        title: Any = "",
        description: Any = "",
        purpose: str = "asset",
    ) -> dict[str, Any]:
        filename = safe_filename(filename)
        total_size = int(total_size)
        purpose = "restore" if purpose == "restore" else "asset"
        extension = Path(filename).suffix.lower()
        if purpose == "restore":
            if extension != ".zip":
                raise ValueError("Wiki restore requires a .zip backup archive")
            max_size = self.max_total_asset_bytes + MAX_BACKUP_MANIFEST_BYTES
        else:
            if extension not in ASSET_TYPES:
                raise ValueError("File type is not allowed in the wiki")
            max_size = self.max_asset_bytes
        if total_size <= 0 or total_size > max_size:
            raise ValueError("Upload size is outside the configured limits")
        parent_id = self._validate_id(parent_id) if parent_id else None
        with self._connect() as conn:
            self._parent_exists(conn, parent_id)
        upload_id = uuid.uuid4().hex
        metadata = {
            "id": upload_id,
            "filename": filename,
            "total_size": total_size,
            "parent_id": parent_id,
            "title": safe_title(title, Path(filename).stem),
            "description": safe_description(description),
            "purpose": purpose,
            "created_epoch": time.time(),
        }
        atomic_write_text(self.staging_dir / f"{upload_id}.json", json.dumps(metadata, ensure_ascii=False))
        (self.staging_dir / f"{upload_id}.part").touch()
        return {"upload_id": upload_id, "offset": 0, "chunk_size": 8 * 1024 * 1024}

    def _upload_metadata(self, upload_id: str) -> tuple[dict[str, Any], Path, Path]:
        upload_id = self._validate_id(upload_id)
        meta_path = self.staging_dir / f"{upload_id}.json"
        part_path = self.staging_dir / f"{upload_id}.part"
        if not meta_path.exists() or not part_path.exists():
            raise ValueError("Upload session not found")
        metadata = json.loads(meta_path.read_text(encoding="utf-8"))
        return metadata, meta_path, part_path

    def append_upload_chunk(self, upload_id: str, offset: int, chunk: bytes) -> int:
        if not chunk:
            raise ValueError("Upload chunk is empty")
        if len(chunk) > 8 * 1024 * 1024:
            raise ValueError("Upload chunk exceeds the 8MB chunk limit")
        with self._write_lock:
            metadata, _, part_path = self._upload_metadata(upload_id)
            current = part_path.stat().st_size
            if int(offset) != current:
                raise ValueError(f"Upload offset mismatch; expected {current}")
            if current + len(chunk) > int(metadata["total_size"]):
                raise ValueError("Upload exceeds its declared size")
            with part_path.open("ab") as handle:
                handle.write(chunk)
                handle.flush()
                os.fsync(handle.fileno())
            return current + len(chunk)

    def complete_upload(self, upload_id: str) -> dict[str, Any]:
        with self._write_lock:
            metadata, meta_path, part_path = self._upload_metadata(upload_id)
            if part_path.stat().st_size != int(metadata["total_size"]):
                raise ValueError("Upload is incomplete")
            if metadata["purpose"] == "restore":
                result = self.restore_archive(part_path)
            else:
                result = self.create_asset_from_file(
                    part_path,
                    metadata["filename"],
                    metadata.get("parent_id"),
                    title=metadata.get("title"),
                    description=metadata.get("description"),
                )
            meta_path.unlink(missing_ok=True)
            part_path.unlink(missing_ok=True)
            return result

    def cleanup_staging(self, max_age_seconds: int = 24 * 3600) -> None:
        cutoff = time.time() - max_age_seconds
        try:
            for path in self.staging_dir.iterdir():
                try:
                    if path.is_file() and path.stat().st_mtime < cutoff:
                        path.unlink(missing_ok=True)
                except OSError:
                    continue
        except OSError:
            pass

    def add_personal_bookmark(self, email: str, node_id: str) -> None:
        self._add_bookmark(email, node_id, "", "personal")

    def add_lesson_bookmark(self, teacher_email: str, class_id: str, node_id: str) -> None:
        class_id = str(class_id or "").strip()
        if not class_id:
            raise ValueError("A class is required for Lesson Material")
        self._add_bookmark(teacher_email, node_id, class_id, "lesson_material")

    def _add_bookmark(self, email: str, node_id: str, class_id: str, kind: str) -> None:
        email = str(email or "").strip().lower()
        node_id = self._validate_id(node_id)
        if not email:
            raise ValueError("Account email is required")
        with self._write_lock, self._connect() as conn:
            row = conn.execute("SELECT status,deleted_at FROM nodes WHERE id=?", (node_id,)).fetchone()
            if not row or row["deleted_at"] or row["status"] != "published":
                raise ValueError("Published wiki item not found")
            conn.execute(
                "INSERT OR IGNORE INTO bookmarks(id,owner_email,node_id,class_id,kind,created_at) VALUES(?,?,?,?,?,?)",
                (uuid.uuid4().hex, email, node_id, class_id, kind, utc_timestamp()),
            )

    def remove_bookmark(self, email: str, node_id: str, *, class_id: str = "", kind: str = "personal") -> None:
        email = str(email or "").strip().lower()
        node_id = self._validate_id(node_id)
        with self._write_lock, self._connect() as conn:
            conn.execute(
                "DELETE FROM bookmarks WHERE owner_email=? AND node_id=? AND class_id=? AND kind=?",
                (email, node_id, str(class_id or "").strip(), kind),
            )

    def list_bookmarks(
        self,
        email: str,
        *,
        class_ids: Iterable[str] = (),
        role: str = "student",
        selected_class_id: str = "",
    ) -> list[dict[str, Any]]:
        email = str(email or "").strip().lower()
        class_list = [str(item).strip() for item in class_ids if str(item).strip()]
        params: list[Any] = [email]
        clauses = ["(b.owner_email=? AND b.kind='personal')"]
        if role == "teacher":
            if selected_class_id:
                clauses.append("(b.owner_email=? AND b.kind='lesson_material' AND b.class_id=?)")
                params.extend([email, selected_class_id])
            else:
                clauses.append("(b.owner_email=? AND b.kind='lesson_material')")
                params.append(email)
        elif class_list:
            placeholders = ",".join("?" for _ in class_list)
            clauses.append(f"(b.kind='lesson_material' AND b.class_id IN ({placeholders}))")
            params.extend(class_list)
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT b.id,b.owner_email,b.node_id,b.class_id,b.kind,b.created_at,n.title,n.slug,n.kind node_kind,n.description "
                "FROM bookmarks b JOIN nodes n ON n.id=b.node_id "
                f"WHERE ({' OR '.join(clauses)}) AND n.status='published' AND n.deleted_at IS NULL "
                "ORDER BY b.created_at DESC,n.title",
                params,
            ).fetchall()
        return [dict(row) for row in rows]

    def set_class_feature(self, class_id: str, node_id: str, teacher_email: str) -> None:
        class_id = str(class_id or "").strip()
        teacher_email = str(teacher_email or "").strip().lower()
        node_id = self._validate_id(node_id)
        if not class_id or not teacher_email:
            raise ValueError("Class and teacher are required")
        with self._write_lock, self._connect() as conn:
            row = conn.execute("SELECT status,deleted_at FROM nodes WHERE id=?", (node_id,)).fetchone()
            if not row or row["deleted_at"] or row["status"] != "published":
                raise ValueError("Published wiki item not found")
            conn.execute(
                "INSERT OR REPLACE INTO class_features(class_id,node_id,teacher_email,created_at) VALUES(?,?,?,?)",
                (class_id, node_id, teacher_email, utc_timestamp()),
            )

    def remove_class_feature(self, class_id: str, node_id: str) -> None:
        node_id = self._validate_id(node_id)
        with self._write_lock, self._connect() as conn:
            conn.execute("DELETE FROM class_features WHERE class_id=? AND node_id=?", (str(class_id or "").strip(), node_id))

    def list_class_features(self, class_id: str) -> list[dict[str, Any]]:
        with self._connect() as conn:
            return [dict(row) for row in conn.execute(
                "SELECT f.class_id,f.node_id,f.teacher_email,f.created_at,n.title,n.slug,n.kind,n.description "
                "FROM class_features f JOIN nodes n ON n.id=f.node_id "
                "WHERE f.class_id=? AND n.status='published' AND n.deleted_at IS NULL ORDER BY f.created_at DESC",
                (str(class_id or "").strip(),),
            )]

    def record_analytics(self, event: str, event_key: Any = "") -> None:
        event = re.sub(r"[^a-z0-9_]+", "", str(event or "").lower())[:40]
        key = re.sub(r"\s+", " ", str(event_key or "")).strip()[:200].casefold()
        if not event:
            return
        day = time.strftime("%Y-%m-%d", time.gmtime())
        try:
            with self._write_lock, self._connect() as conn:
                conn.execute(
                    "INSERT INTO analytics_daily(day,event,event_key,count) VALUES(?,?,?,1) "
                    "ON CONFLICT(day,event,event_key) DO UPDATE SET count=count+1",
                    (day, event, key),
                )
        except sqlite3.DatabaseError:
            pass

    def diagnostics(self) -> dict[str, Any]:
        missing_files: list[dict[str, str]] = []
        broken_directives: list[dict[str, str]] = []
        broken_links: list[dict[str, str]] = []
        with self._connect() as conn:
            nodes = list(conn.execute("SELECT id,kind,title,slug,storage_name FROM nodes WHERE deleted_at IS NULL"))
            node_ids = {row["id"] for row in nodes}
            slugs = {row["slug"] for row in nodes}
            for row in nodes:
                if row["kind"] == "page":
                    path = self.content_dir / row["storage_name"]
                elif row["kind"] in {"image", "video", "pdf", "file"}:
                    path = self.media_dir / row["storage_name"]
                else:
                    continue
                if not path.exists():
                    missing_files.append({"id": row["id"], "title": row["title"]})
                    continue
                if row["kind"] == "page":
                    markdown = path.read_text(encoding="utf-8", errors="replace")
                    for referenced in _DIRECTIVE_ID_RE.findall(markdown):
                        if referenced.lower() not in node_ids:
                            broken_directives.append({"page_id": row["id"], "page": row["title"], "target": referenced})
                    for referenced_slug in _WIKI_LINK_RE.findall(markdown):
                        if referenced_slug.lower() not in slugs:
                            broken_links.append({"page_id": row["id"], "page": row["title"], "target": referenced_slug})
            conflicts = [dict(row) for row in conn.execute(
                "SELECT normalized,COUNT(DISTINCT node_id) destinations,GROUP_CONCAT(DISTINCT term) terms "
                "FROM aliases GROUP BY normalized HAVING COUNT(DISTINCT node_id)>1 ORDER BY normalized"
            )]
            unpublished = int(conn.execute("SELECT COUNT(*) value FROM nodes WHERE status='draft' AND deleted_at IS NULL").fetchone()["value"])
        return {
            "missing_files": missing_files,
            "broken_directives": broken_directives,
            "broken_links": broken_links,
            "alias_conflicts": conflicts,
            "unpublished_count": unpublished,
        }

    def analytics_summary(self) -> dict[str, Any]:
        with self._connect() as conn:
            top_pages = [dict(row) for row in conn.execute(
                "SELECT a.event_key node_id,n.title,n.slug,SUM(a.count) views FROM analytics_daily a "
                "LEFT JOIN nodes n ON n.id=a.event_key WHERE a.event='page_view' "
                "GROUP BY a.event_key,n.title,n.slug ORDER BY views DESC LIMIT 8"
            )]
            top_searches = [dict(row) for row in conn.execute(
                "SELECT event_key query,SUM(count) searches FROM analytics_daily WHERE event='search_completed' "
                "GROUP BY event_key ORDER BY searches DESC LIMIT 8"
            )]
            no_results = [dict(row) for row in conn.execute(
                "SELECT event_key query,SUM(count) searches FROM analytics_daily WHERE event='search_no_results_completed' "
                "GROUP BY event_key ORDER BY searches DESC LIMIT 8"
            )]
            totals = {
                "page_views": int(conn.execute("SELECT COALESCE(SUM(count),0) value FROM analytics_daily WHERE event='page_view'").fetchone()["value"]),
                "searches": int(conn.execute("SELECT COALESCE(SUM(count),0) value FROM analytics_daily WHERE event='search_completed'").fetchone()["value"]),
                "nodes": int(conn.execute("SELECT COUNT(*) value FROM nodes WHERE deleted_at IS NULL").fetchone()["value"]),
                "published_pages": int(conn.execute("SELECT COUNT(*) value FROM nodes WHERE kind='page' AND status='published' AND deleted_at IS NULL").fetchone()["value"]),
                "media_bytes": self.current_asset_bytes(),
            }
        return {"totals": totals, "top_pages": top_pages, "top_searches": top_searches, "no_result_searches": no_results, "diagnostics": self.diagnostics()}

    @staticmethod
    def _table_rows(conn: sqlite3.Connection, table: str) -> list[dict[str, Any]]:
        return [dict(row) for row in conn.execute(f"SELECT * FROM {table}")]

    def create_backup(self, destination: Optional[Path] = None) -> Path:
        self.checkpoint()
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        destination = Path(destination or self.backup_dir / f"wiki_backup_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}.zip")
        temp = destination.with_suffix(".tmp")
        checksums: dict[str, str] = {}
        with self._connect() as conn:
            manifest = {
                "format": "eagleide-wiki-backup",
                "schema_version": SCHEMA_VERSION,
                "exported_at": utc_timestamp(),
                "nodes": self._table_rows(conn, "nodes"),
                "aliases": self._table_rows(conn, "aliases"),
                "sections": self._table_rows(conn, "sections"),
                "redirects": self._table_rows(conn, "redirects"),
                "class_features": self._table_rows(conn, "class_features"),
                "revisions": self._table_rows(conn, "revisions"),
                "page_drafts": self._table_rows(conn, "page_drafts"),
                "standards": self._table_rows(conn, "standards"),
                "page_standards": self._table_rows(conn, "page_standards"),
                "settings": self._table_rows(conn, "settings"),
                "analytics_daily": self._table_rows(conn, "analytics_daily"),
                "bookmarks_included": False,
            }
        with zipfile.ZipFile(temp, "w", allowZip64=True) as archive:
            for root_name, directory in (("content", self.content_dir), ("media", self.media_dir), ("revisions", self.revisions_dir), ("drafts", self.drafts_dir)):
                if not directory.exists():
                    continue
                for path in directory.rglob("*"):
                    if not path.is_file():
                        continue
                    relative = path.relative_to(directory).as_posix()
                    archive_name = f"{root_name}/{relative}"
                    checksums[archive_name] = sha256_file(path)
                    compression = zipfile.ZIP_STORED if path.suffix.lower() in {".mp4", ".zip", ".pdf"} else zipfile.ZIP_DEFLATED
                    archive.write(path, archive_name, compress_type=compression)
            manifest["checksums"] = checksums
            archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2), compress_type=zipfile.ZIP_DEFLATED)
        os.replace(temp, destination)
        return destination

    @staticmethod
    def _safe_archive_name(name: str) -> str:
        pure = PurePosixPath(name)
        if pure.is_absolute() or ".." in pure.parts or not pure.parts:
            raise ValueError("Backup contains an unsafe path")
        cleaned = pure.as_posix()
        if cleaned.startswith("/") or "\\" in cleaned:
            raise ValueError("Backup contains an unsafe path")
        return cleaned

    def _validate_backup_manifest(self, manifest: dict[str, Any], infos: list[zipfile.ZipInfo]) -> None:
        """Validate catalog references before any restored path is used."""
        file_sizes: dict[str, int] = {}
        seen_names: set[str] = set()
        for info in infos:
            name = self._safe_archive_name(info.filename)
            if name in seen_names:
                raise ValueError("Backup contains duplicate file names")
            seen_names.add(name)
            if info.is_dir():
                continue
            file_sizes[name] = int(info.file_size)
        checksums = manifest.get("checksums")
        if not isinstance(checksums, dict):
            raise ValueError("Backup checksums are missing")
        for name, size in file_sizes.items():
            if name == "manifest.json":
                continue
            checksum = checksums.get(name)
            if not isinstance(checksum, str) or not re.fullmatch(r"[0-9a-f]{64}", checksum):
                raise ValueError(f"Backup checksum is missing for {name}")

        def rows(table: str) -> list[dict[str, Any]]:
            value = manifest.get(table) or []
            if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
                raise ValueError(f"Backup table {table} is invalid")
            return value

        def valid_id(value: Any, label: str) -> str:
            result = str(value or "")
            if not re.fullmatch(r"[0-9a-f]{32}", result):
                raise ValueError(f"Backup contains an invalid {label}")
            return result

        node_rows = rows("nodes")
        if len(node_rows) > MAX_BACKUP_ENTRIES:
            raise ValueError("Backup contains too many wiki items")
        node_ids: set[str] = set()
        node_kinds: dict[str, str] = {}
        parent_ids: dict[str, Optional[str]] = {}
        media_total = 0
        for row in node_rows:
            node_id = valid_id(row.get("id"), "node ID")
            if node_id in node_ids:
                raise ValueError("Backup contains duplicate node IDs")
            node_ids.add(node_id)
            kind = str(row.get("kind") or "")
            if kind not in {"folder", "page", "image", "video", "pdf", "file"}:
                raise ValueError("Backup contains an invalid wiki item type")
            node_kinds[node_id] = kind
            icon = str(row.get("icon") or "")
            if safe_icon(icon) != icon:
                raise ValueError("Backup contains an invalid folder icon")
            parent = row.get("parent_id")
            parent_ids[node_id] = valid_id(parent, "parent ID") if parent else None
            storage_name = str(row.get("storage_name") or "")
            if kind == "folder":
                if storage_name:
                    raise ValueError("Backup folder contains an invalid storage path")
                continue
            if kind == "page":
                expected_storage = f"{node_id}.md"
                archive_name = f"content/{expected_storage}"
                if storage_name != expected_storage:
                    raise ValueError("Backup page contains an invalid storage path")
                if str(row.get("mime_type") or "") != "text/markdown; charset=utf-8":
                    raise ValueError("Backup page contains an invalid media type")
                if archive_name not in file_sizes or file_sizes[archive_name] > MAX_PAGE_BYTES:
                    raise ValueError("Backup page content is missing or too large")
            else:
                file_name = str(row.get("file_name") or "")
                if safe_filename(file_name) != file_name:
                    raise ValueError("Backup media contains an invalid file name")
                extension = Path(file_name).suffix.lower()
                if extension not in ASSET_TYPES or ASSET_TYPES[extension][0] != kind:
                    raise ValueError("Backup media type does not match its file name")
                if str(row.get("mime_type") or "") != ASSET_TYPES[extension][1]:
                    raise ValueError("Backup media contains an invalid media type")
                expected_storage = f"{node_id}{extension}"
                archive_name = f"media/{expected_storage}"
                if storage_name != expected_storage:
                    raise ValueError("Backup media contains an invalid storage path")
                size = file_sizes.get(archive_name, -1)
                if size < 0 or size > self.max_asset_bytes:
                    raise ValueError("Backup media is missing or exceeds the per-file limit")
                if int(row.get("size_bytes") or 0) != size:
                    raise ValueError("Backup media size does not match its catalog entry")
                media_total += size
        if media_total > self.max_total_asset_bytes:
            raise ValueError("Backup media exceeds the configured storage limit")
        for node_id, parent_id in parent_ids.items():
            if parent_id and parent_id not in node_ids:
                raise ValueError("Backup contains an unknown parent item")
            seen = {node_id}
            current = parent_id
            while current:
                if current in seen:
                    raise ValueError("Backup wiki tree contains a cycle")
                seen.add(current)
                current = parent_ids.get(current)

        for row in rows("revisions"):
            revision_id = valid_id(row.get("id"), "revision ID")
            page_id = valid_id(row.get("page_id"), "revision page ID")
            expected = f"{page_id}/{revision_id}.md"
            if node_kinds.get(page_id) != "page" or str(row.get("storage_name") or "") != expected:
                raise ValueError("Backup revision contains an invalid storage path")
            if file_sizes.get(f"revisions/{expected}", MAX_PAGE_BYTES + 1) > MAX_PAGE_BYTES:
                raise ValueError("Backup revision is missing or too large")
        for row in rows("page_drafts"):
            page_id = valid_id(row.get("page_id"), "draft page ID")
            expected = f"{page_id}.md"
            if node_kinds.get(page_id) != "page" or str(row.get("storage_name") or "") != expected:
                raise ValueError("Backup draft contains an invalid storage path")
            if file_sizes.get(f"drafts/{expected}", MAX_PAGE_BYTES + 1) > MAX_PAGE_BYTES:
                raise ValueError("Backup draft is missing or too large")
        for table, id_column in (
            ("aliases", "node_id"), ("sections", "page_id"), ("redirects", "node_id"),
            ("class_features", "node_id"),
        ):
            for row in rows(table):
                referenced = valid_id(row.get(id_column), f"{table} node ID")
                if referenced not in node_ids:
                    raise ValueError(f"Backup table {table} references an unknown wiki item")
        standard_ids: set[str] = set()
        normalized_standard_ids: set[str] = set()
        for row in rows("standards"):
            standard_key = valid_id(row.get("id"), "standard ID")
            standard_id = str(row.get("standard_id") or "").strip()
            description = str(row.get("description") or "").strip()
            normalized_id = normalize_term(standard_id)
            if (
                standard_key in standard_ids or not standard_id or not description
                or len(standard_id) > MAX_STANDARD_ID_CHARS
                or len(description) > MAX_STANDARD_DESCRIPTION_CHARS
                or normalized_id in normalized_standard_ids
                or str(row.get("normalized_id") or "") != normalized_id
            ):
                raise ValueError("Backup contains an invalid curriculum standard")
            standard_ids.add(standard_key)
            normalized_standard_ids.add(normalized_id)
        for row in rows("page_standards"):
            page_id = valid_id(row.get("page_id"), "standard page ID")
            standard_key = valid_id(row.get("standard_id"), "standard ID")
            if node_kinds.get(page_id) != "page" or standard_key not in standard_ids:
                raise ValueError("Backup page standard references an unknown page or standard")
        rows("settings")
        rows("analytics_daily")

    def _read_backup_manifest(self, archive_path: Path) -> tuple[dict[str, Any], list[zipfile.ZipInfo]]:
        if not zipfile.is_zipfile(archive_path):
            raise ValueError("Restore file is not a valid ZIP archive")
        with zipfile.ZipFile(archive_path, "r", allowZip64=True) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_BACKUP_ENTRIES:
                raise ValueError("Backup contains too many files")
            total = 0
            for info in infos:
                self._safe_archive_name(info.filename)
                total += int(info.file_size)
                if total > self.max_total_asset_bytes + 2 * 1024 * 1024 * 1024:
                    raise ValueError("Backup expands beyond the configured restore limit")
            try:
                manifest_info = archive.getinfo("manifest.json")
            except KeyError as exc:
                raise ValueError("Backup manifest is missing") from exc
            if manifest_info.file_size > MAX_BACKUP_MANIFEST_BYTES:
                raise ValueError("Backup manifest is too large")
            manifest = json.loads(archive.read(manifest_info).decode("utf-8"))
        if manifest.get("format") != "eagleide-wiki-backup" or int(manifest.get("schema_version", 0)) != SCHEMA_VERSION:
            raise ValueError("Backup format or schema version is not supported")
        if manifest.get("bookmarks_included") not in {False, None}:
            raise ValueError("This restore format must not contain bookmarks")
        self._validate_backup_manifest(manifest, infos)
        return manifest, infos

    def restore_archive(self, archive_path: Path) -> dict[str, Any]:
        archive_path = Path(archive_path)
        manifest, infos = self._read_backup_manifest(archive_path)
        restore_root = self.base_dir.parent / f".{self.base_dir.name}.restore.{uuid.uuid4().hex}"
        old_root = self.base_dir.parent / f".{self.base_dir.name}.old.{uuid.uuid4().hex}"
        preserved_bookmarks: list[dict[str, Any]] = []
        with self._connect() as conn:
            preserved_bookmarks = self._table_rows(conn, "bookmarks")
        try:
            new_store = WikiStore(
                restore_root,
                backup_dir=self.backup_dir,
                max_asset_bytes=self.max_asset_bytes,
                max_total_asset_bytes=self.max_total_asset_bytes,
            )
            checksums = manifest.get("checksums") or {}
            with zipfile.ZipFile(archive_path, "r", allowZip64=True) as archive:
                for info in infos:
                    name = self._safe_archive_name(info.filename)
                    if name == "manifest.json" or info.is_dir():
                        continue
                    if not any(name.startswith(prefix) for prefix in ("content/", "media/", "revisions/", "drafts/")):
                        raise ValueError("Backup contains an unexpected file")
                    destination = restore_root / PurePosixPath(name)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(info, "r") as source, destination.open("wb") as target:
                        shutil.copyfileobj(source, target, length=1024 * 1024)
                    expected = str(checksums.get(name) or "")
                    if not expected or sha256_file(destination) != expected:
                        raise ValueError(f"Backup checksum failed for {name}")
            table_columns = {
                "nodes": ("id","parent_id","kind","title","icon","slug","sort_order","status","file_name","storage_name","mime_type","size_bytes","description","version","created_at","updated_at","deleted_at"),
                "aliases": ("id","node_id","term","normalized","anchor"),
                "sections": ("id","page_id","anchor","heading","normalized","level","ordinal"),
                "redirects": ("old_slug","node_id","created_at"),
                "class_features": ("class_id","node_id","teacher_email","created_at"),
                "revisions": ("id","page_id","storage_name","title","created_at"),
                "page_drafts": ("page_id","storage_name","updated_at"),
                "standards": ("id","standard_id","normalized_id","description","sort_order","created_at","updated_at"),
                "page_standards": ("page_id","standard_id","sort_order"),
                "settings": ("key","value"),
                "analytics_daily": ("day","event","event_key","count"),
            }
            with new_store._write_lock, new_store._connect() as conn:
                conn.execute("PRAGMA foreign_keys=OFF")
                for table in ("aliases","sections","redirects","class_features","bookmarks","page_standards","page_drafts","revisions","analytics_daily","standards","nodes","settings"):
                    conn.execute(f"DELETE FROM {table}")
                for table, columns in table_columns.items():
                    rows = manifest.get(table) or []
                    placeholders = ",".join("?" for _ in columns)
                    statement = f"INSERT INTO {table}({','.join(columns)}) VALUES({placeholders})"
                    for row in rows:
                        if not isinstance(row, dict):
                            raise ValueError(f"Backup table {table} is invalid")
                        values = tuple((row.get(column) or "") if table == "nodes" and column == "icon" else row.get(column) for column in columns)
                        conn.execute(statement, values)
                valid_ids = {row["id"] for row in manifest.get("nodes") or [] if isinstance(row, dict)}
                bookmark_columns = ("id","owner_email","node_id","class_id","kind","created_at")
                for row in preserved_bookmarks:
                    if row.get("node_id") not in valid_ids:
                        continue
                    conn.execute(
                        f"INSERT OR IGNORE INTO bookmarks({','.join(bookmark_columns)}) VALUES(?,?,?,?,?,?)",
                        tuple(row.get(column) for column in bookmark_columns),
                    )
                conn.execute("INSERT OR REPLACE INTO schema_meta(key,value) VALUES('schema_version',?)", (str(SCHEMA_VERSION),))
                try:
                    conn.execute("DELETE FROM wiki_fts")
                except sqlite3.OperationalError:
                    pass
                for row in conn.execute("SELECT id,kind,file_name,storage_name FROM nodes"):
                    markdown = ""
                    if row["kind"] == "page":
                        path = new_store.content_dir / row["storage_name"]
                        if not path.exists():
                            raise ValueError("Backup is missing a Markdown content file")
                        markdown = path.read_text(encoding="utf-8")
                    elif row["kind"] in {"image","video","pdf","file"}:
                        media_path = new_store.media_dir / row["storage_name"]
                        if not media_path.exists():
                            raise ValueError("Backup is missing an uploaded media file")
                        if not validate_asset_signature(media_path, Path(row["file_name"]).suffix.lower()):
                            raise ValueError("Backup media contents do not match the expected file type")
                    new_store._reindex_node(conn, row["id"], markdown)
                conn.execute("PRAGMA foreign_keys=ON")
            new_store.prune_revisions()
            new_store.checkpoint()
            diagnostics = new_store.diagnostics()
            if diagnostics["missing_files"]:
                raise ValueError("Restored backup is missing files")
            pre_restore = self.create_backup(self.backup_dir / f"pre_restore_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}.zip")
            self.checkpoint()
            with self._write_lock:
                os.replace(self.base_dir, old_root)
                try:
                    os.replace(restore_root, self.base_dir)
                except Exception:
                    os.replace(old_root, self.base_dir)
                    raise
            shutil.rmtree(old_root, ignore_errors=True)
            self._prepare_directories()
            self._clear_read_caches()
            return {"ok": True, "pre_restore_backup": pre_restore.name, "catalog_version": self.catalog_version()}
        except Exception:
            shutil.rmtree(restore_root, ignore_errors=True)
            if old_root.exists() and not self.base_dir.exists():
                os.replace(old_root, self.base_dir)
            raise
