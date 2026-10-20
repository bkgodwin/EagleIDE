"""Pinned, bounded HTTP transport for the restricted external-tool profile."""
from __future__ import annotations

import http.client
from html.parser import HTMLParser
import ipaddress
import logging
import re
import socket
import ssl
import threading
import time
import zlib
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit

from tool_store import ToolError

MAX_UPLOAD = 1024 * 1024
MAX_RESPONSE = 256 * 1024 * 1024
MAX_HTML = 2 * 1024 * 1024
MAX_WAITING = 64
MAX_OWNER_WAITING = 12
ADMISSION_TIMEOUT = 15
CONNECT_TIMEOUT = 3
READ_TIMEOUT = 15
TOTAL_TIMEOUT = 180
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
        self.guard_socket = None

    def connect(self):
        sock = socket.create_connection((self.address, self.port), CONNECT_TIMEOUT)
        try:
            self.guard_socket = sock.dup()
            if self.target["scheme"] == "https":
                sock = ssl.create_default_context().wrap_socket(sock, server_hostname=self.target["host"])
            sock.settimeout(READ_TIMEOUT)
            self.sock = sock
        except BaseException:
            if self.guard_socket:
                self.guard_socket.close()
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
        self.changed = threading.Condition(self.lock)
        self.active = {}
        self.waiting = []

    def admit(self, owner, *, wait=False):
        ticket = (owner, object())
        with self.changed:
            if len(self.waiting) >= MAX_WAITING or sum(item[0] == owner for item in self.waiting) >= MAX_OWNER_WAITING:
                raise ToolError("Application gateway queue is full. Try again shortly", 429)
            self.waiting.append(ticket)
            deadline = time.monotonic() + (ADMISSION_TIMEOUT if wait else 0)
            try:
                while True:
                    # Serve the first eligible request, so one busy account cannot
                    # block another account with available per-account capacity.
                    first = next((item for item in self.waiting if self.active.get(item[0], 0) < 4), None)
                    if first is ticket and self.slots.acquire(blocking=False):
                        self.active[owner] = self.active.get(owner, 0) + 1
                        break
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise ToolError("Application gateway is busy. Try again shortly", 429)
                    self.changed.wait(min(remaining, 0.1))
            finally:
                self.waiting.remove(ticket)
                self.changed.notify_all()
        released = False
        def release():
            nonlocal released
            with self.changed:
                if released:
                    return
                released = True
                self.active[owner] -= 1
                if not self.active[owner]:
                    del self.active[owner]
                self.slots.release()
                self.changed.notify_all()
        return release

    def open(self, tool, policy, path="", query="", method="GET", body=None, headers=None, owner="test", self_ips=(), permit=None):
        release = permit or self.admit(owner)
        connection, response, guard, watchdog = None, None, None, None
        expired = threading.Event()
        def interrupt():
            expired.set()
            if guard:
                try:
                    guard.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        def close():
            if watchdog:
                watchdog.cancel()
            if guard:
                try:
                    guard.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                guard.close()
            if response:
                response.close()
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
            connection.connect()
            # A duplicate of the underlying transport can interrupt blocked
            # header/body reads, including TLS and Connection: close responses.
            guard = getattr(connection, "guard_socket", None) or connection.sock.dup()
            watchdog = threading.Timer(TOTAL_TIMEOUT, interrupt)
            watchdog.daemon = True
            watchdog.start()
            outbound = {"Accept-Encoding": "identity", "Connection": "close"}
            outbound.update(headers or {})
            connection.request(method, target["base"] + path + (("?" + query) if query else ""), body=body, headers=outbound)
            response = connection.getresponse()
            if expired.is_set():
                raise ToolError("Application response deadline exceeded", 502)
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


def stream_body(response, close, authorized, *, fail_on_error=False):
    start, size, checked = time.monotonic(), 0, float("-inf")
    try:
        while True:
            now = time.monotonic()
            if now - start > TOTAL_TIMEOUT:
                if fail_on_error:
                    raise ToolError("Application HTML response timed out", 502)
                return
            if now - checked >= 1:
                if not authorized():
                    if fail_on_error:
                        raise ToolError("Application access expired or was revoked", 403)
                    return
                checked = now
            chunk = response.read1(64 * 1024)
            if not chunk:
                return
            size += len(chunk)
            if size > MAX_RESPONSE:
                return
            yield chunk
    except (OSError, http.client.HTTPException) as exc:
        if fail_on_error:
            raise ToolError("Application HTML transfer ended early", 502) from exc
        return
    finally:
        close()


def html_body(response, close, authorized):
    """Preserve SRI while making its resource requests CORS-enabled in an opaque frame.

    Only start tags are extended; scripts, URLs, integrity hashes and CSP stay intact.
    Latin-1 round-tripping keeps byte offsets and the original document encoding.
    """
    chunks, size = [], 0
    stream = stream_body(response, close, authorized, fail_on_error=True)
    try:
        for chunk in stream:
            size += len(chunk)
            if size > MAX_HTML:
                raise ToolError("Application HTML exceeds the 2 MiB document limit", 502)
            chunks.append(chunk)
    finally:
        stream.close()
    body = b"".join(chunks)
    length = response.getheader("Content-Length")
    if length and len(body) != int(length):
        raise ToolError("Application HTML transfer ended early", 502)
    encoding = response.getheader("Content-Encoding", "identity").strip().lower()
    if encoding not in {"", "identity"}:
        if encoding not in {"gzip", "deflate"}:
            raise ToolError("Serve application HTML with identity, gzip or deflate encoding", 502)
        try:
            decoder = zlib.decompressobj(31 if encoding == "gzip" else zlib.MAX_WBITS)
            body = decoder.decompress(body, MAX_HTML + 1)
            if len(body) > MAX_HTML or not decoder.eof or decoder.unused_data:
                raise ValueError()
        except (zlib.error, ValueError) as exc:
            raise ToolError("Application HTML encoding is invalid or exceeds 2 MiB", 502) from exc
    text = body.decode("latin-1")
    insertions = []
    current_line, line_start = 1, 0

    class Resources(HTMLParser):
        def handle_starttag(self, tag, attrs):
            nonlocal current_line, line_start
            attributes = dict(attrs)
            if tag not in {"link", "script"} or "integrity" not in attributes or "crossorigin" in attributes:
                return
            raw = self.get_starttag_text()
            line, column = self.getpos()
            while current_line < line:
                line_start = text.index("\n", line_start) + 1
                current_line += 1
            end = len(raw) - (2 if raw.endswith("/>") else 1)
            insertions.append(line_start + column + end)

        handle_startendtag = handle_starttag

    Resources(convert_charrefs=False).feed(text)
    pieces, start = [], 0
    for position in insertions:
        pieces.extend((text[start:position], ' crossorigin="anonymous"'))
        start = position
    pieces.append(text[start:])
    if not authorized():
        raise ToolError("Application access expired or was revoked", 403)
    return ''.join(pieces).encode("latin-1")
