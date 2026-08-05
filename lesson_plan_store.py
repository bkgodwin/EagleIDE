"""Atomic persistence and validation for EagleIDE weekly lesson plans."""

from __future__ import annotations

import copy
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit


SCHEMA_VERSION = 2
DAYS = ("monday", "tuesday", "wednesday", "thursday", "friday")
MAX_DAY_MARKDOWN_CHARS = 20_000
MAX_NOTES_MARKDOWN_CHARS = 20_000
MAX_WIKI_PAGES_PER_DAY = 30
MAX_EXTERNAL_LINKS_PER_DAY = 20
MAX_EXTERNAL_URL_CHARS = 2_048
MAX_EXTERNAL_TITLE_CHARS = 200
MAX_WEEKS_PER_CLASS = 520
WIKI_NODE_ID_RE = re.compile(r"^[0-9a-f]{32}$")


class LessonPlanDataError(ValueError):
    pass


class LessonPlanConflictError(LessonPlanDataError):
    pass


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def normalize_week_start(value: Any = None, *, today: Optional[date] = None) -> str:
    if value in (None, ""):
        parsed = today or date.today()
    elif isinstance(value, date):
        parsed = value
    else:
        raw = str(value or "").strip()
        try:
            parsed = date.fromisoformat(raw)
        except ValueError as exc:
            raise LessonPlanDataError("Week must be an ISO date in YYYY-MM-DD format") from exc
    monday = parsed - timedelta(days=parsed.weekday())
    return monday.isoformat()


def _clean_markdown(value: Any, limit: int, field: str) -> str:
    text = str(value or "").replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")
    if len(text) > limit:
        raise LessonPlanDataError(f"{field} exceeds the {limit:,} character limit")
    return text


def _wiki_node_ids(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise LessonPlanDataError("Wiki page selections must be a list")
    result: list[str] = []
    for raw in value:
        node_id = str(raw or "").strip().lower()
        if not WIKI_NODE_ID_RE.fullmatch(node_id):
            raise LessonPlanDataError("A selected wiki page ID is invalid")
        if node_id not in result:
            result.append(node_id)
        if len(result) > MAX_WIKI_PAGES_PER_DAY:
            raise LessonPlanDataError(
                f"Each day may include at most {MAX_WIKI_PAGES_PER_DAY} wiki pages"
            )
    return result


def normalize_external_url(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw or len(raw) > MAX_EXTERNAL_URL_CHARS or any(char.isspace() for char in raw):
        raise LessonPlanDataError("External links require a valid HTTP or HTTPS URL")
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError as exc:
        raise LessonPlanDataError("External links require a valid HTTP or HTTPS URL") from exc
    if parsed.scheme.casefold() not in {"http", "https"} or not parsed.hostname:
        raise LessonPlanDataError("External links require a valid HTTP or HTTPS URL")
    if parsed.username or parsed.password:
        raise LessonPlanDataError("External link URLs cannot contain credentials")
    if port is not None and port not in {80, 443}:
        raise LessonPlanDataError("External link URLs must use the standard HTTP or HTTPS port")
    return raw


def _external_links(value: Any) -> list[dict[str, str]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise LessonPlanDataError("External links must be a list")
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw in value:
        if not isinstance(raw, dict):
            raise LessonPlanDataError("Each external link must be an object")
        url = normalize_external_url(raw.get("url"))
        title = " ".join(str(raw.get("title") or "").replace("\x00", "").split())
        if not title or len(title) > MAX_EXTERNAL_TITLE_CHARS:
            raise LessonPlanDataError(
                f"External link titles must be 1 to {MAX_EXTERNAL_TITLE_CHARS} characters"
            )
        identity = url.casefold()
        if identity not in seen:
            seen.add(identity)
            result.append({"url": url, "title": title})
        if len(result) > MAX_EXTERNAL_LINKS_PER_DAY:
            raise LessonPlanDataError(
                f"Each day may include at most {MAX_EXTERNAL_LINKS_PER_DAY} external links"
            )
    return result


def normalize_plan_payload(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise LessonPlanDataError("Lesson plan data must be an object")
    raw_days = raw.get("days")
    if raw_days is None:
        raw_days = {}
    if not isinstance(raw_days, dict):
        raise LessonPlanDataError("Lesson plan days must be an object")
    days: dict[str, dict[str, Any]] = {}
    for day in DAYS:
        item = raw_days.get(day) or {}
        if not isinstance(item, dict):
            raise LessonPlanDataError(f"{day.title()} plan data must be an object")
        days[day] = {
            "markdown": _clean_markdown(
                item.get("markdown"), MAX_DAY_MARKDOWN_CHARS, f"{day.title()} content"
            ),
            "wiki_node_ids": _wiki_node_ids(item.get("wiki_node_ids")),
            "external_links": _external_links(item.get("external_links")),
        }
    return {
        "days": days,
        "notes_markdown": _clean_markdown(
            raw.get("notes_markdown"), MAX_NOTES_MARKDOWN_CHARS, "Additional notes"
        ),
    }


class LessonPlanStore:
    def __init__(self, base_dir: Path):
        self.base_dir = Path(base_dir).resolve()
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.catalog_path = self.base_dir / "catalog.json"
        self._lock = threading.RLock()
        if not self.catalog_path.exists():
            self._write_json(
                self.catalog_path,
                {"schema_version": SCHEMA_VERSION, "tokens": {}, "plan_sources": {}},
            )

    @staticmethod
    def _class_key(class_id: str) -> str:
        normalized = str(class_id or "").strip()
        if not normalized or len(normalized) > 256:
            raise LessonPlanDataError("Class ID is invalid")
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()

    def _class_path(self, class_id: str) -> Path:
        return self.base_dir / f"class-{self._class_key(class_id)}.json"

    @staticmethod
    def _read_json(path: Path, default: dict[str, Any]) -> dict[str, Any]:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return copy.deepcopy(default)
        return data if isinstance(data, dict) else copy.deepcopy(default)

    @staticmethod
    def _write_json(path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
        encoded = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        with temporary.open("wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)

    @staticmethod
    def _empty_class_data(class_id: str) -> dict[str, Any]:
        return {
            "schema_version": SCHEMA_VERSION,
            "class_id": str(class_id),
            "public_token": "",
            "weeks": {},
        }

    def _class_data(self, class_id: str) -> dict[str, Any]:
        default = self._empty_class_data(class_id)
        data = self._read_json(self._class_path(class_id), default)
        if str(data.get("class_id") or "") != str(class_id):
            return default
        if not isinstance(data.get("weeks"), dict):
            data["weeks"] = {}
        data["schema_version"] = SCHEMA_VERSION
        return data

    def get_plan(self, class_id: str, week: Any = None) -> Optional[dict[str, Any]]:
        week_start = normalize_week_start(week)
        with self._lock:
            item = self._class_data(class_id).get("weeks", {}).get(week_start)
            return copy.deepcopy(item) if isinstance(item, dict) else None

    def save_plan(
        self,
        class_id: str,
        week: Any,
        raw: Any,
        *,
        expected_version: Optional[int] = None,
        updated_by: str = "",
    ) -> dict[str, Any]:
        week_start = normalize_week_start(week)
        normalized = normalize_plan_payload(raw)
        with self._lock:
            data = self._class_data(class_id)
            weeks = data.setdefault("weeks", {})
            existing = weeks.get(week_start) if isinstance(weeks.get(week_start), dict) else None
            current_version = int((existing or {}).get("version") or 0)
            if expected_version is not None and int(expected_version) != current_version:
                raise LessonPlanConflictError(
                    "This lesson plan changed in another tab. Reload it before publishing."
                )
            if not existing and len(weeks) >= MAX_WEEKS_PER_CLASS:
                raise LessonPlanDataError(
                    f"A class may retain at most {MAX_WEEKS_PER_CLASS} weekly plans"
                )
            now = utc_timestamp()
            stored = {
                **normalized,
                "week_start": week_start,
                "version": current_version + 1,
                "created_at": str((existing or {}).get("created_at") or now),
                "published_at": now,
                "updated_at": now,
                "updated_by": str(updated_by or "").strip().lower()[:320],
            }
            weeks[week_start] = stored
            self._write_json(self._class_path(class_id), data)
            return copy.deepcopy(stored)

    def published_weeks(self, class_id: str, *, through: Any = None) -> list[str]:
        maximum = normalize_week_start(through) if through is not None else ""
        with self._lock:
            weeks = sorted(
                key
                for key, value in self._class_data(class_id).get("weeks", {}).items()
                if isinstance(value, dict) and (not maximum or key <= maximum)
            )
        return weeks

    def navigation(self, class_id: str, week: Any, *, through: Any = None) -> dict[str, Optional[str]]:
        selected = normalize_week_start(week)
        weeks = self.published_weeks(class_id, through=through)
        previous = max((item for item in weeks if item < selected), default=None)
        following = min((item for item in weeks if item > selected), default=None)
        return {"previous_week": previous, "next_week": following}

    def _catalog(self) -> dict[str, Any]:
        data = self._read_json(
            self.catalog_path,
            {"schema_version": SCHEMA_VERSION, "tokens": {}, "plan_sources": {}},
        )
        if not isinstance(data.get("tokens"), dict):
            data["tokens"] = {}
        if not isinstance(data.get("plan_sources"), dict):
            data["plan_sources"] = {}
        data["schema_version"] = SCHEMA_VERSION
        return data

    def resolve_plan_source(self, class_id: str) -> str:
        origin = str(class_id or "").strip()
        self._class_key(origin)
        with self._lock:
            sources = self._catalog().get("plan_sources", {})
            current = origin
            seen: set[str] = set()
            while current not in seen:
                seen.add(current)
                source = str(sources.get(current) or "").strip()
                if not source:
                    return current
                current = source
            return origin

    def set_plan_source(self, class_id: str, source_class_id: Any = None) -> str:
        target = str(class_id or "").strip()
        source = str(source_class_id or "").strip()
        self._class_key(target)
        if source:
            self._class_key(source)
        with self._lock:
            catalog = self._catalog()
            sources = catalog.setdefault("plan_sources", {})
            if not source or source == target:
                sources.pop(target, None)
                self._write_json(self.catalog_path, catalog)
                return target
            current = source
            seen = {target}
            while current:
                if current in seen:
                    raise LessonPlanDataError("Lesson plan links cannot form a cycle")
                seen.add(current)
                current = str(sources.get(current) or "").strip()
            sources[target] = source
            self._write_json(self.catalog_path, catalog)
            return self.resolve_plan_source(target)

    def ensure_public_token(self, class_id: str) -> str:
        with self._lock:
            data = self._class_data(class_id)
            existing = str(data.get("public_token") or "")
            if existing:
                catalog = self._catalog()
                if catalog["tokens"].get(existing) != str(class_id):
                    catalog["tokens"][existing] = str(class_id)
                    self._write_json(self.catalog_path, catalog)
                return existing
            catalog = self._catalog()
            token = secrets.token_urlsafe(32)
            while token in catalog["tokens"]:
                token = secrets.token_urlsafe(32)
            data["public_token"] = token
            catalog["tokens"][token] = str(class_id)
            self._write_json(self._class_path(class_id), data)
            self._write_json(self.catalog_path, catalog)
            return token

    def reset_public_token(self, class_id: str) -> str:
        with self._lock:
            data = self._class_data(class_id)
            catalog = self._catalog()
            previous = str(data.get("public_token") or "")
            if previous:
                catalog["tokens"].pop(previous, None)
            token = secrets.token_urlsafe(32)
            while token in catalog["tokens"]:
                token = secrets.token_urlsafe(32)
            data["public_token"] = token
            catalog["tokens"][token] = str(class_id)
            self._write_json(self._class_path(class_id), data)
            self._write_json(self.catalog_path, catalog)
            return token

    def class_id_for_token(self, token: str) -> Optional[str]:
        wanted = str(token or "").strip()
        if len(wanted) < 32 or len(wanted) > 128:
            return None
        with self._lock:
            catalog = self._catalog()
            for candidate, class_id in catalog.get("tokens", {}).items():
                if hmac.compare_digest(str(candidate), wanted):
                    data = self._class_data(str(class_id))
                    if hmac.compare_digest(str(data.get("public_token") or ""), wanted):
                        return str(class_id)
                    return None
        return None

    def delete_class(self, class_id: str) -> None:
        with self._lock:
            data = self._class_data(class_id)
            token = str(data.get("public_token") or "")
            catalog = self._catalog()
            if token:
                catalog["tokens"].pop(token, None)
            sources = catalog.setdefault("plan_sources", {})
            sources.pop(str(class_id), None)
            for target, source in list(sources.items()):
                if str(source) == str(class_id):
                    sources.pop(target, None)
            self._write_json(self.catalog_path, catalog)
            self._class_path(class_id).unlink(missing_ok=True)
