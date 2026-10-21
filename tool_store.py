"""Small, atomic external-tool catalog. No application packages or student projects."""
from __future__ import annotations

import copy
import ipaddress
import json
import os
from pathlib import Path
import re
import threading
import uuid


class ToolError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


RESERVED = set("api static ide wiki network socket.io health standards-coverage lesson-plans _tools background.jpg background_dark.png robots.txt favicon.ico".split())


def networks(values):
    if not isinstance(values, list) or len(values) > 32:
        raise ToolError("Use at most 32 network CIDRs")
    try:
        return sorted({str(ipaddress.ip_network(str(value).strip(), strict=False)) for value in values})
    except ValueError as exc:
        raise ToolError("Invalid network CIDR") from exc


def slug_value(value, reserved=()):
    value = str(value or "").strip().strip("/")
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,47}", value) or value in RESERVED or value in reserved:
        raise ToolError("Choose an unused single-segment path, such as /design/")
    return value


class ToolStore:
    def __init__(self, directory):
        self.path = Path(directory) / "catalog.json"
        self.lock = threading.RLock()

    def read(self):
        with self.lock:
            if not self.path.exists():
                return {"schema_version": 1, "revision": 0, "enabled": False,
                        "allowed_networks": [], "denied_networks": [], "tools": [], "class_tools": {}}
            try:
                if self.path.stat().st_size > 2 * 1024 * 1024:
                    raise ValueError()
                data = json.loads(self.path.read_text(encoding="utf-8"))
                if (data["schema_version"] != 1 or type(data["revision"]) is not int or data["revision"] < 0
                        or type(data["enabled"]) is not bool or not isinstance(data["tools"], list)
                        or len(data["tools"]) > 32 or not isinstance(data["class_tools"], dict)
                        or len(data["class_tools"]) > 10000):
                    raise ValueError()
                networks(data["allowed_networks"])
                networks(data["denied_networks"])
                from tool_gateway import target_url
                ids, slugs = set(), set()
                for tool in data["tools"]:
                    if not isinstance(tool, dict):
                        raise ValueError()
                    # Existing catalogs retain the stricter pre-upgrade profile.
                    for option in ("storage", "popups", "dialogs"):
                        tool.setdefault(option, False)
                    tool.setdefault("upload_mib", 1)
                    if (not isinstance(tool, dict) or not re.fullmatch(r"[a-f0-9]{32}", tool["id"])
                            or tool["id"] in ids or tool["slug"] in slugs or type(tool["revision"]) is not int
                            or type(tool["enabled"]) is not bool or type(tool["forms"]) is not bool
                            or any(type(tool[option]) is not bool for option in ("storage", "popups", "dialogs"))
                            or type(tool["upload_mib"]) is not int or not 1 <= tool["upload_mib"] <= 16
                            or tool["compatibility"] not in {"unverified", "verified"}
                            or not isinstance(tool["methods"], list) or not tool["methods"]
                            or any(method not in {"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"} for method in tool["methods"])
                            or not isinstance(tool["addresses"], list) or len(tool["addresses"]) > 8
                            or any(not isinstance(tool[key], str) or len(tool[key]) > 100 for key in ("name", "label"))):
                        raise ValueError()
                    slug_value(tool["slug"])
                    target_url(tool["backend_url"])
                    for address in tool["addresses"]:
                        ipaddress.ip_address(address)
                    ids.add(tool["id"])
                    slugs.add(tool["slug"])
                for class_id, grants in data["class_tools"].items():
                    if (not isinstance(class_id, str) or len(class_id) > 128 or not isinstance(grants, list)
                            or len(grants) > 32 or any(not isinstance(value, str) or value not in ids for value in grants)):
                        raise ValueError()
                return data
            except (OSError, ValueError, KeyError, TypeError) as exc:
                raise ToolError("External tools catalog is unavailable; restore a valid backup", 503) from exc

    def mutate(self, revision, change):
        with self.lock:
            data = self.read()
            if type(revision) is not int or revision != data["revision"]:
                raise ToolError("Settings changed. Reload before saving", 409)
            result = change(data)
            data["revision"] += 1
            encoded = json.dumps(data, ensure_ascii=False, indent=2)
            if len(encoded.encode("utf-8")) > 2 * 1024 * 1024:
                raise ToolError("External tools catalog size limit reached", 413)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_name(f".catalog.{uuid.uuid4().hex}.tmp")
            try:
                with temporary.open("w", encoding="utf-8", newline="\n") as handle:
                    handle.write(encoded)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, self.path)
            finally:
                temporary.unlink(missing_ok=True)
            return copy.deepcopy(result), data["revision"]

    @staticmethod
    def tool(data, tool_id):
        tool = next((item for item in data["tools"] if item["id"] == tool_id), None)
        if not tool:
            raise ToolError("Tool not found", 404)
        return tool

    def save_tool(self, raw, reserved):
        from tool_gateway import target_url
        if not isinstance(raw, dict):
            raise ToolError("A JSON object is required")
        name, label = str(raw.get("name", "")).strip(), str(raw.get("label", "")).strip()
        if not name or not label or len(name) > 100 or len(label) > 100:
            raise ToolError("Name and homepage label are required (100 characters maximum)")
        target = target_url(raw.get("backend_url"))
        slug = slug_value(raw.get("slug"), reserved)
        methods = raw.get("methods", ["GET", "HEAD"])
        upload_mib = raw.get("upload_mib", 1)
        if type(upload_mib) is not int or not 1 <= upload_mib <= 16:
            raise ToolError("Choose a server upload limit from 1 to 16 MiB")
        if not isinstance(methods, list) or not methods or any(not isinstance(value, str) for value in methods) or set(methods) - {"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"}:
            raise ToolError("Unsupported HTTP methods")
        def change(data):
            tool_id = raw.get("id")
            old = self.tool(data, tool_id) if tool_id else None
            if not old and len(data["tools"]) >= 32:
                raise ToolError("The catalog is limited to 32 tools")
            if any(item["slug"] == slug and item["id"] != tool_id for item in data["tools"]):
                raise ToolError("That public path is already registered", 409)
            tool = {"id": tool_id or uuid.uuid4().hex, "name": name, "label": label, "slug": slug,
                    "backend_url": target["url"], "methods": sorted(set(methods) | {"GET", "HEAD"}),
                    "forms": raw.get("forms") is True, "revision": (old or {}).get("revision", 0) + 1,
                    "storage": raw.get("storage") is True, "popups": raw.get("popups") is True,
                    "dialogs": raw.get("dialogs") is True,
                    "upload_mib": upload_mib,
                    "enabled": False, "compatibility": "unverified", "addresses": [], "test": "Not tested"}
            if old:
                data["tools"].remove(old)
            data["tools"].append(tool)
            return tool
        return self.mutate(raw.get("revision"), change)
