"""Small, dependency-free controls shared by the HTTP security boundaries."""

from collections import OrderedDict, deque
from ipaddress import ip_address, ip_network
from threading import Lock, RLock
from time import monotonic


class AttemptLimiter:
    """Bounded sliding windows. Admission consumes an attempt atomically."""

    def __init__(self, limit, seconds, capacity=8192):
        self.limit, self.seconds, self.capacity = limit, seconds, capacity
        self.entries = OrderedDict()
        self.lock = Lock()

    def admit(self, key, now=None):
        now = monotonic() if now is None else now
        with self.lock:
            while self.entries:
                oldest = next(iter(self.entries))
                if self.entries[oldest][-1] > now - self.seconds:
                    break
                self.entries.popitem(last=False)
            recent = self.entries.get(key)
            if recent is None:
                # Never evict a live window: rotating identities must not reset it.
                if len(self.entries) >= self.capacity:
                    return False
                recent = self.entries[key] = deque()
            while recent and recent[0] <= now - self.seconds:
                recent.popleft()
            if len(recent) >= self.limit:
                return False
            recent.append(now)
            self.entries.move_to_end(key)
            return True

    def clear(self, key=None):
        with self.lock:
            if key is None:
                self.entries.clear()
            else:
                self.entries.pop(key, None)


def trusted_proxy(peer, configured="127.0.0.1/32,::1/128"):
    try:
        address = ip_address(peer or "")
        networks = [ip_network(part.strip(), strict=False) for part in configured.split(",") if part.strip()]
        return any(address in network for network in networks)
    except ValueError:
        return False


def client_ip(req, configured="127.0.0.1/32,::1/128"):
    try:
        peer = str(ip_address(req.remote_addr or ""))
    except ValueError:
        return "unknown"
    if trusted_proxy(peer, configured):
        # CF supplies one address. For other explicitly configured proxies, use
        # the rightmost XFF address, which that proxy must overwrite/append.
        candidates = [req.headers.get("CF-Connecting-IP", "")]
        forwarded = req.headers.get("X-Forwarded-For", "")
        if forwarded:
            candidates.append(forwarded.rsplit(",", 1)[-1].strip())
        candidates.append(req.headers.get("X-Real-IP", ""))
        for candidate in candidates:
            try:
                return str(ip_address(candidate))
            except ValueError:
                continue
    return peer


def secure_request(req, configured="127.0.0.1/32,::1/128"):
    return bool(req.is_secure or (trusted_proxy(req.remote_addr, configured)
                and req.headers.get("X-Forwarded-Proto", "").split(",", 1)[0].strip().lower() == "https"))


class SessionTokens(dict):
    """Keep existing token-map interfaces while enforcing lifetime on every lookup."""

    def __init__(self, absolute=12 * 3600, idle=4 * 3600):
        super().__init__()
        self.absolute, self.idle = absolute, idle
        self.times, self.lock = {}, RLock()

    def __setitem__(self, token, value):
        with self.lock:
            now = monotonic()
            self.times[token] = self.times.get(token, (now, now))
            super().__setitem__(token, value)

    def get(self, token, default=None):
        return self.active(token, default, refresh=True)

    def active(self, token, default=None, *, refresh=False):
        with self.lock:
            value = super().get(token)
            if value is None:
                return default
            now = monotonic()
            issued, seen = self.times.get(token, (0, 0))
            if now - issued >= self.absolute or now - seen >= self.idle:
                self.pop(token, None)
                return default
            if refresh:
                self.times[token] = issued, now
            return value

    def __getitem__(self, token):
        value = self.get(token)
        if value is None:
            raise KeyError(token)
        return value

    def __contains__(self, token):
        return self.get(token) is not None

    def __delitem__(self, token):
        with self.lock:
            self.times.pop(token, None)
            super().__delitem__(token)

    def pop(self, token, *default):
        with self.lock:
            self.times.pop(token, None)
            return super().pop(token, *default)

    def clear(self):
        with self.lock:
            self.times.clear()
            super().clear()

    def update(self, *args, **kwargs):
        for token, value in dict(*args, **kwargs).items():
            self[token] = value


class AdministratorTokens(set):
    def __init__(self):
        super().__init__()
        self.sessions = SessionTokens(absolute=8 * 3600)

    def add(self, token):
        with self.sessions.lock:
            self.sessions[token] = True
            super().add(token)

    def __contains__(self, token):
        with self.sessions.lock:
            if self.sessions.get(token):
                return True
            super().discard(token)
            return False

    def discard(self, token):
        with self.sessions.lock:
            self.sessions.pop(token, None)
            super().discard(token)

    def remove(self, token):
        with self.sessions.lock:
            self.sessions.pop(token, None)
            super().remove(token)

    def clear(self):
        with self.sessions.lock:
            self.sessions.clear()
            super().clear()

    def update(self, *iterables):
        for values in iterables:
            for token in values:
                self.add(token)

    def pop(self):
        with self.sessions.lock:
            token = super().pop()
            self.sessions.pop(token, None)
            return token
