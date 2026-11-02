"""Encrypted, additive persistence for the native Eagle Lab section."""

from __future__ import annotations

import copy
import ipaddress
import json
import os
import re
import threading
import time
import uuid
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken


SCHEMA_VERSION = 1
MAX_SERVERS = 100
_HOST_RE = re.compile(r"^[^\x00-\x1f\x7f]{1,120}$")
_RFC1918_NETWORKS = tuple(
    ipaddress.ip_network(value)
    for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
)


class EagleLabDataError(ValueError):
    pass


def _private_ipv4(value: object) -> str:
    try:
        address = ipaddress.ip_address(str(value or "").strip())
    except ValueError as exc:
        raise EagleLabDataError("Enter a private IPv4 address") from exc
    if address.version != 4 or not any(address in network for network in _RFC1918_NETWORKS):
        raise EagleLabDataError("PVE servers must use a private LAN IPv4 address")
    return str(address)


def _text(value: object, limit: int, *, required: bool = False) -> str:
    result = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+", "", str(value or "")).strip()
    if required and not result:
        raise EagleLabDataError("A required field is missing")
    if len(result) > limit:
        raise EagleLabDataError("A field is too long")
    return result


class EagleLabStore:
    def __init__(self, base_dir: Path):
        self.base_dir = Path(base_dir).resolve()
        self.catalog_path = self.base_dir / "catalog.json"
        self.key_path = self.base_dir / "secret.key"
        self._lock = threading.RLock()
        self.base_dir.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.base_dir, 0o700)
        except OSError:
            pass
        self._cipher = Fernet(self._load_key())

    def _load_key(self) -> bytes:
        if self.key_path.exists():
            key = self.key_path.read_bytes().strip()
            Fernet(key)
            return key
        key = Fernet.generate_key()
        temporary = self.key_path.with_suffix(".tmp")
        temporary.write_bytes(key)
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass
        temporary.replace(self.key_path)
        return key

    def _empty(self) -> dict:
        return {"schema_version": SCHEMA_VERSION, "servers": [], "class_rules": {}}

    def _read(self) -> dict:
        if not self.catalog_path.exists():
            return self._empty()
        try:
            raw = json.loads(self.catalog_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise EagleLabDataError("Eagle Lab storage is unavailable") from exc
        if not isinstance(raw, dict) or not isinstance(raw.get("servers", []), list) or not isinstance(raw.get("class_rules", {}), dict):
            raise EagleLabDataError("Eagle Lab storage is invalid")
        raw.setdefault("schema_version", SCHEMA_VERSION)
        raw.setdefault("servers", [])
        raw.setdefault("class_rules", {})
        return raw

    def _write(self, data: dict) -> None:
        data["schema_version"] = SCHEMA_VERSION
        temporary = self.catalog_path.with_suffix(f".{uuid.uuid4().hex}.tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass
        temporary.replace(self.catalog_path)

    def _encrypt(self, value: str) -> str:
        return "v1:" + self._cipher.encrypt(value.encode("utf-8")).decode("ascii")

    def _decrypt(self, value: object) -> str:
        token = str(value or "")
        if not token.startswith("v1:"):
            raise EagleLabDataError("Stored PVE credentials need to be re-entered")
        try:
            return self._cipher.decrypt(token[3:].encode("ascii")).decode("utf-8")
        except (InvalidToken, UnicodeError, ValueError) as exc:
            raise EagleLabDataError("Stored PVE credentials could not be decrypted") from exc

    @staticmethod
    def public_server(server: dict) -> dict:
        return {
            "id": server.get("id"),
            "hostname": server.get("hostname"),
            "ip": server.get("ip"),
            "port": server.get("port", 8006),
            "username": server.get("username", "root"),
            "notes": server.get("notes", ""),
            "allow_self_signed": bool(server.get("allow_self_signed", True)),
            "created_at": server.get("created_at"),
        }

    def list_servers(self) -> list[dict]:
        with self._lock:
            return [self.public_server(item) for item in self._read()["servers"]]

    def _server(self, data: dict, server_id: str) -> dict:
        found = next((item for item in data["servers"] if item.get("id") == str(server_id)), None)
        if not found:
            raise EagleLabDataError("Lab server not found")
        return found

    def get_server(self, server_id: str, *, credentials: bool = False) -> dict | None:
        with self._lock:
            data = self._read()
            try:
                server = self._server(data, server_id)
            except EagleLabDataError:
                return None
            result = self.public_server(server)
            if credentials:
                result["password"] = self._decrypt(server.get("password"))
            return result

    def save_server(self, raw: dict, server_id: str | None = None) -> dict:
        if not isinstance(raw, dict):
            raise EagleLabDataError("A server record is required")
        hostname = _text(raw.get("hostname"), 120, required=True)
        if not _HOST_RE.fullmatch(hostname):
            raise EagleLabDataError("Server hostname is invalid")
        ip = _private_ipv4(raw.get("ip"))
        username = _text(raw.get("username") or "root", 120, required=True)
        notes = _text(raw.get("notes"), 6000)
        try:
            port = int(raw.get("port", 8006))
        except (TypeError, ValueError) as exc:
            raise EagleLabDataError("PVE port must be a number") from exc
        if not 1 <= port <= 65535:
            raise EagleLabDataError("PVE port must be between 1 and 65535")
        allow_self_signed = raw.get("allow_self_signed", True)
        if not isinstance(allow_self_signed, bool):
            raise EagleLabDataError("Certificate trust must be enabled or disabled")
        password = raw.get("password")
        if password is not None:
            if not isinstance(password, str) or not password or len(password) > 512:
                raise EagleLabDataError("Enter a PVE password of at most 512 characters")
        with self._lock:
            data = self._read()
            duplicate = next((item for item in data["servers"] if item.get("ip") == ip and int(item.get("port", 8006)) == port and item.get("id") != server_id), None)
            if duplicate:
                raise EagleLabDataError("That PVE address and port are already enrolled")
            if server_id:
                server = self._server(data, server_id)
                if password is not None:
                    server["password"] = self._encrypt(password)
            else:
                if len(data["servers"]) >= MAX_SERVERS:
                    raise EagleLabDataError("The lab server limit has been reached")
                if password is None:
                    raise EagleLabDataError("Enter the PVE password")
                server = {"id": uuid.uuid4().hex, "password": self._encrypt(password), "created_at": int(time.time())}
                data["servers"].append(server)
            server.update(hostname=hostname, ip=ip, port=port, username=username, notes=notes, allow_self_signed=allow_self_signed)
            self._write(data)
            return self.public_server(server)

    def delete_server(self, server_id: str) -> bool:
        with self._lock:
            data = self._read()
            before = len(data["servers"])
            data["servers"] = [item for item in data["servers"] if item.get("id") != str(server_id)]
            if len(data["servers"]) == before:
                return False
            for rule in data["class_rules"].values():
                if isinstance(rule, dict):
                    rule["server_ids"] = [item for item in rule.get("server_ids", []) if item != str(server_id)]
            self._write(data)
            return True

    def class_rule(self, class_id: object) -> dict:
        with self._lock:
            data = self._read()
            raw = data["class_rules"].get(str(class_id), {})
            known = {item.get("id") for item in data["servers"]}
            return {
                "enabled": bool(raw.get("enabled", False)),
                "show_credentials": bool(raw.get("show_credentials", False)),
                "server_ids": [item for item in raw.get("server_ids", []) if item in known],
            }

    def set_class_rule(self, class_id: object, raw: dict) -> dict:
        if not isinstance(raw, dict) or not isinstance(raw.get("enabled", False), bool) or not isinstance(raw.get("show_credentials", False), bool):
            raise EagleLabDataError("Invalid class lab settings")
        requested = raw.get("server_ids", [])
        if not isinstance(requested, list) or len(requested) > MAX_SERVERS or any(not isinstance(item, str) for item in requested):
            raise EagleLabDataError("Invalid class server selection")
        with self._lock:
            data = self._read()
            known = {item.get("id") for item in data["servers"]}
            if any(item not in known for item in requested):
                raise EagleLabDataError("A selected server no longer exists")
            rule = {
                "enabled": raw["enabled"],
                "show_credentials": raw["show_credentials"],
                "server_ids": list(dict.fromkeys(requested)),
            }
            data["class_rules"][str(class_id)] = rule
            self._write(data)
            return copy.deepcopy(rule)

    def servers_for_class(self, class_id: object) -> list[dict]:
        rule = self.class_rule(class_id)
        if not rule["enabled"]:
            return []
        allowed = set(rule["server_ids"])
        return [item for item in self.list_servers() if item["id"] in allowed]
