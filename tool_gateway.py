"""Pinned, bounded HTTP transport for the restricted external-tool profile."""
from __future__ import annotations

import http.client
import ipaddress
import logging
import re
import socket
import ssl
import threading
import time
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit

from tool_store import ToolError

MAX_UPLOAD = 1024 * 1024
MAX_RESPONSE = 64 * 1024 * 1024
CONNECT_TIMEOUT = 3
READ_TIMEOUT = 5
TOTAL_TIMEOUT = 60
PRIVATE = tuple(ipaddress.ip_network(value) for value in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"))


def safe_path(value, *, query=False):
    if not isinstance(value, str) or len(value) > (4096 if query else 2048):
        raise ToolError("Invalid application path")
    if re.search(r"[\x00-\x20\x7f\\]", value) or re.search(r"%(?:00|0a|0d|25|2f|5c)", value, re.I):
        raise ToolError("Encoded separators, controls and nested escapes are not supported")
    try:
        decoded = unquote(value, errors="strict")
    except UnicodeError as exc:
        raise ToolError("Invalid path encoding") from exc
    if any(ord(char) < 32 or ord(char) == 127 for char in decoded):
        raise ToolError("Invalid application path")
    if not query and (any(part in {".", ".."} for part in decoded.split("/")) or decoded.startswith("/")):
        raise ToolError("Application path escapes its prefix")
    return value if query else quote(decoded, safe="/-._~")


def target_url(value):
    try:
        parsed = urlsplit(str(value or "").strip())
        host = parsed.hostname or ""
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        if parsed.scheme not in {"http", "https"} or not host or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError()
        if not re.fullmatch(r"[A-Za-z0-9.:-]{1,253}", host) or not 1 <= port <= 65535:
            raise ValueError()
        base = parsed.path or "/"
        safe_path(base.lstrip("/"))
        if "//" in base or "%" in base:
            raise ValueError()
        base = base.rstrip("/") + "/"
        authority = f"[{host}]" if ":" in host else host
        authority += f":{port}"
        return {"scheme": parsed.scheme, "host": host.lower(), "port": port, "base": base,
                "url": urlunsplit((parsed.scheme, authority, base, "", ""))}
    except (ValueError, UnicodeError) as exc:
        raise ToolError("Use a full HTTP/HTTPS backend URL without credentials, query or fragment") from exc


def approve_addresses(target, policy, self_addresses=()):
    allowed = [ipaddress.ip_network(value) for value in policy.get("allowed_networks", [])]
    denied = [ipaddress.ip_network(value) for value in policy.get("denied_networks", [])]
    try:
        answers = {str(ipaddress.ip_address(row[4][0])) for row in socket.getaddrinfo(target["host"], target["port"], type=socket.SOCK_STREAM)}
    except (OSError, ValueError) as exc:
        raise ToolError("Backend DNS resolution failed", 422) from exc
    if not answers or len(answers) > 8:
        raise ToolError("Backend must resolve to at most eight approved private addresses")
    for answer in answers:
        address = ipaddress.ip_address(answer)
        if (answer == "fd00:ec2::254" or address.is_loopback or address.is_link_local or address.is_multicast or address.is_unspecified
                or (isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped)):
            raise ToolError("Loopback, link-local, metadata and mapped addresses are forbidden")
        if not any(address in net for net in PRIVATE) or not any(address in net for net in allowed):
            raise ToolError("Backend is outside the administrator-approved private application networks")
        if any(address in net for net in denied) or answer in set(self_addresses):
            raise ToolError("Backend is a denied management or EagleIDE address")
        # UDP connect selects the local route without sending a datagram. This
        # catches a local service address even when hostname DNS lists loopback only.
        try:
            family = socket.AF_INET6 if address.version == 6 else socket.AF_INET
            with socket.socket(family, socket.SOCK_DGRAM) as probe:
                probe.connect((answer, target["port"]))
                if probe.getsockname()[0] == answer:
                    raise ToolError("The EagleIDE host cannot be an application destination")
        except OSError:
            pass  # A missing route is handled by the bounded actual connection.
    return sorted(answers)


def local_addresses():
    result = {"127.0.0.1", "::1"}
    try:
        result.update(row[4][0] for row in socket.getaddrinfo(socket.gethostname(), None))
    except OSError:
        pass
    return result


class PinnedConnection(http.client.HTTPConnection):
    def __init__(self, target, address):
        super().__init__(target["host"], target["port"], timeout=CONNECT_TIMEOUT)
        self.target, self.address = target, address

    def connect(self):
        sock = socket.create_connection((self.address, self.port), CONNECT_TIMEOUT)
        try:
            if self.target["scheme"] == "https":
                sock = ssl.create_default_context().wrap_socket(sock, server_hostname=self.target["host"])
            sock.settimeout(READ_TIMEOUT)
            self.sock = sock
        except BaseException:
            sock.close()
            raise


def redirect_path(location, target, current):
    resolved = urlsplit(urljoin(target["url"] + current, location))
    original = urlsplit(target["url"])
    if (resolved.scheme, resolved.hostname, resolved.port or (443 if resolved.scheme == "https" else 80)) != (target["scheme"], target["host"], target["port"]):
        raise ToolError("Application redirected outside its approved backend", 502)
    if not resolved.path.startswith(original.path):
        raise ToolError("Application redirect escaped its configured base path", 502)
    suffix = safe_path(resolved.path[len(original.path):])
    if resolved.query:
        suffix += "?" + safe_path(resolved.query, query=True)
    if resolved.fragment:
        suffix += "#" + quote(unquote(resolved.fragment), safe="-._~")
    return suffix


class Gateway:
    def __init__(self):
        self.slots = threading.BoundedSemaphore(16)
        self.lock = threading.Lock()
        self.active = {}

    def admit(self, owner):
        with self.lock:
            if self.active.get(owner, 0) >= 4 or not self.slots.acquire(blocking=False):
                raise ToolError("Application gateway is busy. Try again shortly", 429)
            self.active[owner] = self.active.get(owner, 0) + 1
        released = False
        def release():
            nonlocal released
            with self.lock:
                if released:
                    return
                released = True
                self.active[owner] -= 1
                if not self.active[owner]:
                    del self.active[owner]
            self.slots.release()
        return release

    def open(self, tool, policy, path="", query="", method="GET", body=None, headers=None, owner="test", self_ips=(), permit=None):
        release = permit or self.admit(owner)
        connection = None
        def close():
            if connection:
                connection.close()
            release()
        try:
            target = target_url(tool["backend_url"])
            path = safe_path(path)
            query = safe_path(query, query=True)
            # Admission also bounds concurrent DNS work. Connect to the checked numerical
            # address; the original hostname is used only for Host and TLS verification.
            addresses = approve_addresses(target, policy, self_ips)
            if tool.get("addresses") and addresses != tool["addresses"]:
                raise ToolError("Backend addresses changed; an administrator must test and approve them again", 503)
            connection = PinnedConnection(target, addresses[0])
            outbound = {"Accept-Encoding": "identity", "Connection": "close"}
            outbound.update(headers or {})
            connection.request(method, target["base"] + path + (("?" + query) if query else ""), body=body, headers=outbound)
            response = connection.getresponse()
            if response.status == 101 or response.getheader("Content-Type", "").split(";", 1)[0].strip().lower() == "text/event-stream":
                raise ToolError("WebSockets and server-sent events are unsupported", 502)
            length = response.getheader("Content-Length")
            if length and (not length.isdigit() or int(length) > MAX_RESPONSE):
                raise ToolError("Application response exceeds the gateway limit", 502)
            return response, close, target, addresses
        except ToolError:
            close()
            raise
        except (OSError, http.client.HTTPException) as exc:
            close()
            raise ToolError("Application connection failed or timed out", 502) from exc
        except BaseException:
            close()
            raise


class CapabilityLogFilter(logging.Filter):
    def filter(self, record):
        message = record.getMessage()
        record.msg = re.sub(r"(/_tools/[a-f0-9]{32}/)[A-Za-z0-9_-]+", r"\1[redacted]", message)
        record.args = ()
        return True


def stream_body(response, close, authorized):
    start, size = time.monotonic(), 0
    try:
        while True:
            if time.monotonic() - start > TOTAL_TIMEOUT or not authorized():
                return
            chunk = response.read(64 * 1024)
            if not chunk:
                return
            size += len(chunk)
            if size > MAX_RESPONSE:
                return
            yield chunk
    except (OSError, http.client.HTTPException):
        return
    finally:
        close()
