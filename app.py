#!/usr/bin/env python3
import eventlet
eventlet.monkey_patch()

import atexit
import csv
import hashlib
import heapq
import hmac
import ipaddress
import json
import getpass
import os
import random
import re
import secrets
import shutil
import string
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Dict, Any, Optional

from flask import Flask, send_from_directory, send_file, request, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room
import requests
import bcrypt
from collections import defaultdict
from cryptography.fernet import Fernet, InvalidToken

# -------------------------
# Paths & constants
# -------------------------
BASE_DIR = Path(__file__).resolve().parent
PERSIST_FILE = BASE_DIR / "config.txt"        # persisted settings (JSON)
CHALLENGE_CSV = BASE_DIR / "challenges.csv"   # optional challenge bank
EXCEPTION_HELP_CSV = BASE_DIR / "exception_help.csv"
LEADERBOARD_CSV = BASE_DIR / "leaderboard.csv"
CHALLENGE_SCORE_FILE = BASE_DIR / "challenge_scores.json"
SANDBOX_DIR = BASE_DIR / "sandboxes"
ASSIGNMENTS_DIR = BASE_DIR / "assignments"

INPUT_TOKEN = "[[_IDE_INPUT_]]"
MAX_WALL_TIME = 30.0       # seconds (hard kill for user code)
IDLE_TIMEOUT = 10.0        # reserved, if you later want idle detection
MAX_OUTPUT_BYTES = 500_000  # 500 KB max stdout before killing the process
MAX_ASSISTANT_CODE_CHARS = 12_000
MAX_RUN_CODE_CHARS = 200_000
MAX_STDIN_CHARS = 10_000

# HTML runtime defaults/safeguards
HTML_RUNTIME_DEFAULT_TIMEOUT = 30
HTML_RUNTIME_DEFAULT_MAX_FPS = 30
HTML_RUNTIME_DEFAULT_MEMORY_MB = 128
HTML_RUNTIME_DEFAULT_MAX_DOM_NODES = 3000
HTML_RUNTIME_DEFAULT_MAX_POPUPS = 2

# File count limits
MAX_FILES_PER_FOLDER = 20
MAX_FILES_PER_ACCOUNT = 100
ALLOWED_EXTENSIONS = {".py", ".js", ".html", ".css", ".txt", ".csv"}
EXAMPLES_DIR_NAME = "Examples"
EXAMPLE_FILES: dict[str, str] = {
    "hello.py": 'print("Hello from EagleIDE!")\nname = input("What is your name? ")\nprint(f"Welcome, {name}!")\n',
    "hello.js": 'const name = input("What is your name? ");\nconsole.log(`Hello from EagleIDE, ${name}!`);\n',
    "sample.csv": "name,score\nAva,95\nNoah,88\n",
    "notes.txt": "Welcome to EagleIDE!\n\n- Open a file from Examples.\n- Edit the code.\n- Click Run.\n",
    "index.html": '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>EagleIDE Example</title>\n  <link rel="stylesheet" href="styles.css">\n</head>\n<body>\n  <main class="card">\n    <h1>EagleIDE HTML Example</h1>\n    <p>Edit this file and <strong>Run</strong> it to see live changes.</p>\n  </main>\n</body>\n</html>\n',
    "styles.css": "body {\n  font-family: Arial, sans-serif;\n  background: #f2f6ff;\n  color: #102a43;\n  margin: 0;\n  min-height: 100vh;\n  display: grid;\n  place-items: center;\n}\n\n.card {\n  background: white;\n  border: 2px solid #7fb2eb;\n  border-radius: 12px;\n  padding: 20px;\n  max-width: 420px;\n  box-shadow: 0 8px 24px rgba(16, 42, 67, 0.12);\n}\n",
}

os.makedirs(SANDBOX_DIR, exist_ok=True)
os.makedirs(ASSIGNMENTS_DIR, exist_ok=True)

USERS_FILE = BASE_DIR / "users.json"
USER_FILES_DIR = BASE_DIR / "user_files"
CLASSES_FILE = BASE_DIR / "classes.json"
ADMIN_KEY_FILE = BASE_DIR / ".admin_key"
SIGN_IN_EVENTS_FILE = BASE_DIR / "sign_in_events.json"
SERVER_EVENTS_FILE = BASE_DIR / "server_events.json"
SERVER_STATE_FILE = BASE_DIR / "server_state.json"
APP_LOG_FILE = BASE_DIR / "server.log"
os.makedirs(USER_FILES_DIR, exist_ok=True)

# -------------------------
# Defaults from config.py
# -------------------------
try:
    from config import DEFAULT_CONFIG, DEFAULT_ADMIN_PASSWORD, ADMIN_EMAIL, SERVER_PORT, USER_STORAGE_LIMIT_MB, DEBUG_MODE
except Exception:
    DEFAULT_ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "password")
    ADMIN_EMAIL = "admin@eagleide.local"
    SERVER_PORT = 8000
    USER_STORAGE_LIMIT_MB = 250
    DEBUG_MODE = False
    DEFAULT_CONFIG = {
        "notes_html": "<h2>Welcome</h2><p>Edit me in Admin.</p>",
        "lesson_url": "https://publish.obsidian.md/mrgodwinsclassroom/Coding/Coding+1/2.+Python+Basics/1.+What+Is+Python",
        "lesson_use_local": False,
        "lesson_html": "<p>(No local lesson yet)</p>",
        "ai_explainer_enabled": True,
        "ai_ollama_url": "http://127.0.0.1:11434",
        "ai_model": "gemma3:4b",
        "ai_assistant_preprompt": (
            "You are a helpful programming tutor for high-school students working in Python, JavaScript, HTML, and CSS. "
            "Only answer questions about programming and debugging code. "
            "Keep explanations short, accurate, and step-by-step. If a question is not about coding, "
            "politely decline and redirect to programming topics."
        ),
        "html_runtime_enabled": True,
        "html_runtime_timeout_seconds": HTML_RUNTIME_DEFAULT_TIMEOUT,
        "html_runtime_allow_external_internet": False,
        "html_runtime_allow_popups": False,
        "html_runtime_allow_navigation": False,
        "html_runtime_max_fps": HTML_RUNTIME_DEFAULT_MAX_FPS,
        "html_runtime_memory_limit_mb": HTML_RUNTIME_DEFAULT_MEMORY_MB,
        "html_runtime_max_dom_nodes": HTML_RUNTIME_DEFAULT_MAX_DOM_NODES,
        "html_runtime_max_popups": HTML_RUNTIME_DEFAULT_MAX_POPUPS,
        "page_title": "Eagle IDE (Python + JavaScript + HTML + CSS)",
        "topbar_color": "linear-gradient(90deg,#a5c8f0,#7fb2eb)",
        "registration_enabled": True,
    }

# -------------------------
# App & Socket
# -------------------------
app = Flask(__name__, static_folder=None)
socketio = SocketIO(
    app,
    async_mode="eventlet",
    cors_allowed_origins="*",
    logger=False,
    engineio_logger=False
)

@app.after_request
def _add_security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "geolocation=(), camera=(), microphone=()")
    return response

# Suppress noisy werkzeug HTTP request logs when not in debug mode
if not DEBUG_MODE:
    import logging as _logging
    _logging.getLogger('werkzeug').setLevel(_logging.ERROR)

# -------------------------
# Config load/save
# -------------------------
_cfg_lock = threading.Lock()
_admin_tokens = set()   # ephemeral, cleared on restart

def _load_config() -> Dict[str, Any]:
    # Start with defaults so any keys added to DEFAULT_CONFIG are always present.
    merged = DEFAULT_CONFIG.copy()
    with _cfg_lock:
        if PERSIST_FILE.exists():
            try:
                stored = json.loads(PERSIST_FILE.read_text(encoding="utf-8"))
                merged.update(stored)
                return merged
            except Exception as e:
                print(f"Warning: Failed to load config from {PERSIST_FILE}: {e}")
                print("Creating default config...")
    # No valid config file — _cfg_lock is released above before calling _save_config.
    _save_config(merged)
    return merged

def _save_config(new_cfg: Dict[str, Any]) -> None:
    with _cfg_lock:
        tmp = PERSIST_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(new_cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(PERSIST_FILE)

def _update_config(partial: Dict[str, Any]) -> Dict[str, Any]:
    cfg = _load_config()
    cfg.update(partial or {})
    _save_config(cfg)
    return cfg

CONFIG = _load_config()
print(f"Configuration loaded successfully with {len(CONFIG)} settings")

ADMIN_ACCOUNT_EMAIL = ADMIN_EMAIL
ADMIN_ACCOUNT_PASSWORD = DEFAULT_ADMIN_PASSWORD


def _load_or_create_admin_key() -> bytes:
    if ADMIN_KEY_FILE.exists():
        return ADMIN_KEY_FILE.read_bytes()
    key = Fernet.generate_key()
    ADMIN_KEY_FILE.write_bytes(key)
    try:
        os.chmod(ADMIN_KEY_FILE, 0o600)
    except Exception:
        pass
    return key


def _admin_cipher() -> Fernet:
    return Fernet(_load_or_create_admin_key())


def _encrypt_admin_password(password: str) -> str:
    return _admin_cipher().encrypt(password.encode("utf-8")).decode("utf-8")


def _decrypt_admin_password(token: str) -> str:
    return _admin_cipher().decrypt(token.encode("utf-8")).decode("utf-8")


def _bootstrap_admin_credentials() -> None:
    global ADMIN_ACCOUNT_EMAIL, ADMIN_ACCOUNT_PASSWORD
    cfg = _load_config()
    stored_email = str(cfg.get("admin_email", "")).strip()
    stored_encrypted_pw = str(cfg.get("admin_password_encrypted", "")).strip()
    if stored_email and stored_encrypted_pw:
        try:
            ADMIN_ACCOUNT_EMAIL = stored_email
            ADMIN_ACCOUNT_PASSWORD = _decrypt_admin_password(stored_encrypted_pw)
            return
        except (InvalidToken, Exception):
            print("Warning: Stored admin credentials could not be decrypted. Re-prompting setup.")
    print("\nFirst-time admin setup is required.\n")
    max_attempts = 10
    for _ in range(max_attempts):
        entered_email = input("Enter admin email: ").strip()
        entered_password = getpass.getpass("Enter admin password: ").strip()
        if entered_email and entered_password:
            ADMIN_ACCOUNT_EMAIL = entered_email
            ADMIN_ACCOUNT_PASSWORD = entered_password
            _update_config({
                "admin_email": entered_email,
                "admin_password_encrypted": _encrypt_admin_password(entered_password),
            })
            return
        print("Admin email and password are required. They cannot be blank.\n")
    raise RuntimeError("Admin credential setup failed after maximum attempts")


_bootstrap_admin_credentials()


def _cfg_bool(cfg: Dict[str, Any], key: str, default: bool) -> bool:
    return bool(cfg.get(key, default))


def _cfg_int(cfg: Dict[str, Any], key: str, default: int, minimum: int, maximum: int) -> int:
    raw = cfg.get(key, default)
    try:
        val = int(raw)
    except Exception:
        val = default
    return max(minimum, min(maximum, val))

def _require_admin(req) -> bool:
    token = req.headers.get("X-Admin-Token", "").strip()
    return token in _admin_tokens


_html_runtime_lock = threading.Lock()
_html_runtime_sessions: Dict[str, Dict[str, Any]] = {}


def _delete_path_quietly(path: Path) -> None:
    try:
        resolved = path.resolve()
        sandbox_root = SANDBOX_DIR.resolve()
        common = os.path.commonpath([str(resolved), str(sandbox_root)])
        if common != str(sandbox_root):
            return
        if not resolved.name.startswith("html_runtime_"):
            return
        if resolved.exists():
            shutil.rmtree(resolved, ignore_errors=True)
    except Exception:
        pass


def _cleanup_expired_html_runtime_sessions(force: bool = False) -> None:
    now = time.time()
    to_remove: list[tuple[str, Path]] = []
    with _html_runtime_lock:
        for runtime_id, session in list(_html_runtime_sessions.items()):
            expires_at = float(session.get("expires_at", 0))
            if force or expires_at <= now:
                runtime_dir = Path(session.get("runtime_dir", ""))
                to_remove.append((runtime_id, runtime_dir))
                _html_runtime_sessions.pop(runtime_id, None)
    for _, runtime_dir in to_remove:
        _delete_path_quietly(runtime_dir)


def _remove_html_runtime_session(runtime_id: str) -> None:
    runtime_dir = None
    with _html_runtime_lock:
        session = _html_runtime_sessions.pop(runtime_id, None)
        if session:
            runtime_dir = Path(session.get("runtime_dir", ""))
    if runtime_dir:
        _delete_path_quietly(runtime_dir)


atexit.register(lambda: _cleanup_expired_html_runtime_sessions(force=True))


def _is_html_file(path: Path) -> bool:
    return path.suffix.lower() in {".html", ".htm"}

# -------------------------
# User account management
# -------------------------
_users_lock = threading.Lock()
_student_tokens: Dict[str, dict] = {}  # token -> user info dict
_teacher_tokens: Dict[str, dict] = {}  # token -> teacher info dict
_reg_rate_limit: dict = defaultdict(list)  # ip -> list of timestamps
_login_rate_limit: dict = defaultdict(list)  # ip -> list of timestamps
_classes_lock = threading.Lock()
_server_health_lock = threading.Lock()
SERVER_START_EPOCH = time.time()
_server_start_recorded = False

def _sanitize_email_for_path(email: str) -> str:
    """Convert email to safe directory name"""
    safe = email.replace("@", "_at_").replace(".", "_dot_")
    safe = re.sub(r"[^a-zA-Z0-9_-]", "", safe)
    safe = safe[:64]  # limit length
    if safe:
        return safe
    digest = hashlib.sha256(email.encode("utf-8")).hexdigest()[:16]
    return f"user_{digest}"

def _load_users() -> dict:
    with _users_lock:
        if USERS_FILE.exists():
            try:
                return _normalize_users_data(json.loads(USERS_FILE.read_text(encoding="utf-8")))
            except Exception:
                pass
        return {"users": []}


def _normalize_user_record(user: dict) -> dict:
    normalized = dict(user or {})
    role = str(normalized.get("role") or "student").strip().lower()
    if role not in {"student", "teacher"}:
        role = "student"
    normalized["role"] = role
    normalized["class_id"] = normalized.get("class_id") or None
    normalized.setdefault("enabled", True)
    return normalized


def _normalize_users_data(data: dict) -> dict:
    users = [_normalize_user_record(u) for u in (data or {}).get("users", []) if isinstance(u, dict)]
    return {"users": users}


def _save_users(data: dict) -> None:
    with _users_lock:
        data = _normalize_users_data(data)
        tmp = USERS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(USERS_FILE)

def _find_user(email: str) -> Optional[dict]:
    data = _load_users()
    for u in data.get("users", []):
        if u.get("email", "").lower() == email.lower():
            return _normalize_user_record(u)
    return None


def _load_classes() -> dict:
    with _classes_lock:
        if CLASSES_FILE.exists():
            try:
                data = json.loads(CLASSES_FILE.read_text(encoding="utf-8"))
            except Exception:
                data = {}
        else:
            data = {}
        classes = []
        for c in data.get("classes", []):
            if not isinstance(c, dict):
                continue
            settings = c.get("settings") or {}
            students = list(dict.fromkeys([str(s).strip().lower() for s in c.get("students", []) if str(s).strip()]))
            classes.append({
                "id": str(c.get("id") or uuid.uuid4().hex),
                "name": str(c.get("name") or "Class").strip()[:120] or "Class",
                "teacher_email": str(c.get("teacher_email") or "").strip().lower(),
                "join_code": str(c.get("join_code") or "").strip().upper(),
                "settings": {
                    "ai_enabled": bool(settings.get("ai_enabled", True)),
                    "wiki_enabled": bool(settings.get("wiki_enabled", True)),
                    "wiki_url": str(settings.get("wiki_url") or ""),
                    "wiki_html": str(settings.get("wiki_html") or ""),
                },
                "students": students,
                "created_at": c.get("created_at") or _current_timestamp(),
            })
        return {"classes": classes}


def _save_classes(data: dict) -> None:
    with _classes_lock:
        tmp = CLASSES_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(CLASSES_FILE)


def _find_class_by_code(join_code: str) -> Optional[dict]:
    code = str(join_code or "").strip().upper()
    if not code:
        return None
    for c in _load_classes().get("classes", []):
        if str(c.get("join_code", "")).upper() == code:
            return c
    return None


def _find_class_by_id(class_id: str) -> Optional[dict]:
    cid = str(class_id or "").strip()
    if not cid:
        return None
    for c in _load_classes().get("classes", []):
        if c.get("id") == cid:
            return c
    return None


def _generate_join_code(existing_codes: set[str]) -> str:
    alphabet = string.ascii_uppercase + string.digits
    max_attempts = 5000
    for _ in range(max_attempts):
        code = "".join(secrets.choice(alphabet) for _ in range(6))
        if code not in existing_codes:
            return code
    raise RuntimeError("Could not generate unique class join code")


def _require_teacher(req) -> Optional[dict]:
    token = req.headers.get("X-Teacher-Token", "").strip()
    return _teacher_tokens.get(token)

def _current_timestamp() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")

def _read_json_list_file(path: Path) -> list[dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return [entry for entry in data if isinstance(entry, dict)]
    except Exception:
        pass
    return []

def _write_json_list_file(path: Path, payload: list[dict]) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)

def _append_server_log(message: str, level: str = "INFO") -> None:
    try:
        ts = _current_timestamp()
        APP_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with APP_LOG_FILE.open("a", encoding="utf-8") as handle:
            handle.write(f"{ts} [{(level or 'INFO').upper()}] {message}\n")
    except Exception:
        pass

def _append_server_event(event_type: str, message: str, level: str = "info", details: Optional[dict] = None) -> None:
    entry = {
        "timestamp": _current_timestamp(),
        "ts": int(time.time()),
        "type": str(event_type or "event"),
        "level": str(level or "info"),
        "message": str(message or "").strip(),
        "details": details or {},
    }
    with _server_health_lock:
        events = _read_json_list_file(SERVER_EVENTS_FILE)
        events.append(entry)
        events = events[-500:]
        try:
            _write_json_list_file(SERVER_EVENTS_FILE, events)
        except Exception:
            pass

def _record_sign_in_event(email: str, role: str, ip: str, source: str) -> None:
    event = {
        "timestamp": _current_timestamp(),
        "ts": int(time.time()),
        "email": (email or "").strip().lower(),
        "role": str(role or "student"),
        "ip": str(ip or ""),
        "source": str(source or "login"),
    }
    with _server_health_lock:
        events = _read_json_list_file(SIGN_IN_EVENTS_FILE)
        events.append(event)
        cutoff = int(time.time()) - (90 * 24 * 3600)
        events = [row for row in events if int(row.get("ts", 0)) >= cutoff][-10000:]
        try:
            _write_json_list_file(SIGN_IN_EVENTS_FILE, events)
        except Exception:
            pass
    _append_server_log(
        f"Sign-in: role={event['role']} email={event['email'] or 'admin'} ip={event['ip'] or 'unknown'} source={event['source']}",
        "INFO",
    )

def _count_sign_ins(window_seconds: int) -> int:
    now = int(time.time())
    cutoff = now - max(1, int(window_seconds))
    with _server_health_lock:
        events = _read_json_list_file(SIGN_IN_EVENTS_FILE)
    return sum(1 for row in events if int(row.get("ts", 0)) >= cutoff)

def _parse_ip(raw: str) -> Optional[str]:
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        addr = ipaddress.ip_address(text)
        return str(addr)
    except Exception:
        return None

def _is_public_ip(raw: str) -> bool:
    parsed = _parse_ip(raw)
    if not parsed:
        return False
    try:
        addr = ipaddress.ip_address(parsed)
        return not (addr.is_private or addr.is_loopback or addr.is_reserved or addr.is_multicast or addr.is_unspecified)
    except Exception:
        return False

def _get_request_ip(req) -> str:
    cf_ip = _parse_ip(req.headers.get("CF-Connecting-IP", ""))
    if cf_ip:
        return cf_ip
    xff_raw = req.headers.get("X-Forwarded-For", "")
    xff_candidates = [_parse_ip(part.strip()) for part in xff_raw.split(",") if part.strip()]
    xff_candidates = [ip for ip in xff_candidates if ip]
    for candidate in xff_candidates:
        if _is_public_ip(candidate):
            return candidate
    if xff_candidates:
        return xff_candidates[0]
    real_ip = _parse_ip(req.headers.get("X-Real-IP", ""))
    if real_ip:
        return real_ip
    remote = _parse_ip(req.remote_addr or "")
    if remote:
        return remote
    return "unknown"

def _parse_meminfo_bytes() -> tuple[int, int]:
    total = 0
    available = 0
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("MemTotal:"):
                    total = int(line.split()[1]) * 1024
                elif line.startswith("MemAvailable:"):
                    available = int(line.split()[1]) * 1024
        if total > 0 and available >= 0:
            used = max(0, total - available)
            return total, used
    except Exception:
        pass
    return 0, 0

def _estimate_cpu_percent() -> float:
    try:
        load1 = float(os.getloadavg()[0])
        cpus = max(1, os.cpu_count() or 1)
        return round(max(0.0, min(100.0, (load1 / cpus) * 100.0)), 1)
    except Exception:
        return 0.0

def _read_server_log_tail(max_lines: int = 200) -> list[str]:
    try:
        if not APP_LOG_FILE.exists():
            return []
        with APP_LOG_FILE.open("r", encoding="utf-8", errors="replace") as handle:
            lines = handle.readlines()
        return [line.rstrip("\n") for line in lines[-max(1, min(1000, int(max_lines))):]]
    except Exception:
        return []

def _mark_server_running_state(running: bool) -> None:
    payload = {
        "running": bool(running),
        "updated_at": _current_timestamp(),
        "ts": int(time.time()),
        "pid": os.getpid(),
    }
    try:
        tmp = SERVER_STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(SERVER_STATE_FILE)
    except Exception:
        pass

def _record_server_startup_event() -> None:
    global _server_start_recorded
    prior = {}
    try:
        if SERVER_STATE_FILE.exists():
            prior = json.loads(SERVER_STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        prior = {}
    if bool(prior.get("running")):
        _append_server_event(
            "server_crash",
            "Previous server instance appears to have terminated unexpectedly.",
            "critical",
            {"previous_pid": prior.get("pid"), "last_seen": prior.get("updated_at")},
        )
        _append_server_log("Detected prior unclean shutdown (possible crash).", "ERROR")
    _append_server_event("server_start", "Server started.", "info", {"pid": os.getpid()})
    _append_server_log("Server started.", "INFO")
    _mark_server_running_state(True)
    _server_start_recorded = True

def _record_server_stop_event() -> None:
    if not _server_start_recorded:
        return
    _append_server_event("server_stop", "Server stopped.", "warning", {"pid": os.getpid()})
    _append_server_log("Server stopped.", "WARNING")
    _mark_server_running_state(False)

atexit.register(_record_server_stop_event)

def _sanitize_storage_component(value: str, fallback: str = "item", max_length: int = 100) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9 _-]", "", (value or "").strip()).strip(" ")
    return cleaned[:max_length] or fallback

def _record_user_sign_in(email: str, ip: str = "") -> Optional[str]:
    users_data = _load_users()
    timestamp = _current_timestamp()
    changed = False
    for user in users_data.get("users", []):
        if user.get("email", "").lower() == email.lower():
            user["last_sign_in"] = timestamp
            if ip:
                user["last_ip"] = ip
            changed = True
            break
    if changed:
        _save_users(users_data)
        return timestamp
    return None

def _sorted_assignment_submissions(submissions: list[dict]) -> list[dict]:
    return sorted(
        submissions or [],
        key=lambda sub: ((sub.get("name") or sub.get("email") or "").lower(), (sub.get("email") or "").lower())
    )

SUBMISSION_HEADER_PREFIX_PATTERN = re.compile(r"^(?:# Submitted (?:by|at): .*\n?)+")

def _prepend_submission_timestamp(content: str, submitted_at: str, student_name: str) -> str:
    student_label = student_name or "Student"
    name_header = f"# Submitted by: {student_label}"
    time_header = f"# Submitted at: {submitted_at}"
    content = SUBMISSION_HEADER_PREFIX_PATTERN.sub("", content)
    if content:
        return f"{name_header}\n{time_header}\n{content}"
    return f"{name_header}\n{time_header}"

def _write_assignment_submission_copy(owner_email: str, assignment_name: str, student_name: str, source_name: str, content: str) -> str:
    owner_dir = _get_user_dir(owner_email)
    owner_dir.mkdir(parents=True, exist_ok=True)
    assignment_dir = _validate_user_path(owner_dir, _sanitize_storage_component(assignment_name, fallback="Assignment"))
    if not assignment_dir:
        raise ValueError("Invalid assignment storage path")
    assignment_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(source_name).suffix.lower() or ".py"
    filename = _sanitize_storage_component(student_name, fallback="Student") + suffix
    target = _validate_user_path(owner_dir, str((assignment_dir / filename).relative_to(owner_dir.resolve())))
    if not target:
        raise ValueError("Invalid submission file path")
    target.write_text(content, encoding="utf-8")
    return str(target.relative_to(owner_dir))

def _get_user_dir(email: str) -> Path:
    return USER_FILES_DIR / _sanitize_email_for_path(email)


def _seed_example_files(email: str) -> None:
    """Create starter Examples files for newly-created accounts."""
    try:
        safe_component = _sanitize_email_for_path(email)
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", safe_component):
            return
        user_dir = _validate_user_path(USER_FILES_DIR, safe_component)
        if not user_dir:
            return
        examples_dir = _validate_user_path(USER_FILES_DIR, f"{safe_component}/{EXAMPLES_DIR_NAME}")
        if not examples_dir:
            return
        examples_dir.mkdir(parents=True, exist_ok=True)
        for file_name, content in EXAMPLE_FILES.items():
            target = _validate_user_path(USER_FILES_DIR, f"{safe_component}/{EXAMPLES_DIR_NAME}/{file_name}")
            if not target:
                continue
            if not target.exists():
                target.write_text(content, encoding="utf-8")
    except Exception:
        pass

def _require_user(req) -> Optional[dict]:
    token = req.headers.get("X-User-Token", "").strip()
    return _student_tokens.get(token)

def _require_user_for_files(req) -> Optional[dict]:
    """Allow a student, teacher, or the admin to access file routes."""
    user = _require_user(req)
    if user:
        return user
    teacher = _require_teacher(req)
    if teacher:
        return teacher
    admin_token = req.headers.get("X-Admin-Token", "").strip()
    if admin_token and admin_token in _admin_tokens:
        return {"email": ADMIN_ACCOUNT_EMAIL, "name": "Admin", "role": "admin"}
    return None

def _get_user_storage_used(user_dir: Path) -> int:
    """Return total bytes used in user directory"""
    total = 0
    if user_dir.exists():
        for f in user_dir.rglob("*"):
            if f.is_file():
                try:
                    total += f.stat().st_size
                except Exception:
                    pass
    return total

def _count_files_in_folder(directory: Path) -> int:
    """Count files (allowed extensions only) directly in a directory (not recursive)."""
    if not directory.exists() or not directory.is_dir():
        return 0
    return sum(1 for f in directory.iterdir() if f.is_file() and f.suffix.lower() in ALLOWED_EXTENSIONS)

def _count_all_files_for_user(user_dir: Path) -> int:
    """Count all files (allowed extensions only) recursively under user directory."""
    if not user_dir.exists():
        return 0
    return sum(1 for f in user_dir.rglob("*") if f.is_file() and f.suffix.lower() in ALLOWED_EXTENSIONS)

def _enforce_file_limits(user_dir: Path) -> int:
    """Delete oldest files exceeding per-folder (20) and per-account (100) limits.
    Returns the number of files deleted."""
    if not user_dir.exists():
        return 0
    deleted = 0
    # Enforce per-folder limit first
    all_dirs = [user_dir] + [d for d in user_dir.rglob("*") if d.is_dir()]
    for folder in all_dirs:
        files = sorted(
            [f for f in folder.iterdir() if f.is_file() and f.suffix.lower() in ALLOWED_EXTENSIONS],
            key=lambda f: f.stat().st_mtime
        )
        while len(files) > MAX_FILES_PER_FOLDER:
            try:
                files[0].unlink()
                deleted += 1
            except (OSError, FileNotFoundError) as exc:
                print(f"Warning: could not delete {files[0]}: {exc}")
            files.pop(0)
    # Enforce per-account limit
    all_files = sorted(
        [f for f in user_dir.rglob("*") if f.is_file() and f.suffix.lower() in ALLOWED_EXTENSIONS],
        key=lambda f: f.stat().st_mtime
    )
    while len(all_files) > MAX_FILES_PER_ACCOUNT:
        try:
            all_files[0].unlink()
            deleted += 1
        except (OSError, FileNotFoundError) as exc:
            print(f"Warning: could not delete {all_files[0]}: {exc}")
        all_files.pop(0)
    return deleted

def _cleanup_all_user_files() -> None:
    """Enforce file limits for all existing users at startup."""
    if not USER_FILES_DIR.exists():
        return
    for user_dir in USER_FILES_DIR.iterdir():
        if user_dir.is_dir():
            removed = _enforce_file_limits(user_dir)
            if removed:
                print(f"Startup cleanup: removed {removed} excess file(s) from {user_dir.name}")

def _validate_user_path(user_dir: Path, path_str: str) -> Optional[Path]:
    """Validate and resolve a path within user directory. Returns None if invalid."""
    try:
        p = (user_dir / path_str).resolve()
        user_dir_resolved = user_dir.resolve()
        # Use os.path.commonpath for robust cross-platform containment check
        common = os.path.commonpath([str(p), str(user_dir_resolved)])
        if common != str(user_dir_resolved):
            return None
        return p
    except Exception:
        return None


def _assignment_actor(req) -> Optional[dict]:
    teacher = _require_teacher(req)
    if teacher:
        return {"role": "teacher", "email": (teacher.get("email") or "").strip().lower()}
    return None


def _get_teacher_classes(teacher_email: str) -> list[dict]:
    email = (teacher_email or "").strip().lower()
    return [c for c in _load_classes().get("classes", []) if (c.get("teacher_email") or "").lower() == email]


def _class_for_student(email: str) -> Optional[dict]:
    normalized = (email or "").strip().lower()
    for c in _load_classes().get("classes", []):
        if normalized in [s.lower() for s in c.get("students", [])]:
            return c
    return None


def _student_in_teacher_class(teacher_email: str, student_email: str) -> Optional[dict]:
    t_email = (teacher_email or "").strip().lower()
    s_email = (student_email or "").strip().lower()
    for c in _load_classes().get("classes", []):
        if (c.get("teacher_email") or "").lower() == t_email and s_email in [s.lower() for s in c.get("students", [])]:
            return c
    return None


def _revoke_student_class_rooms(student_email: str, class_id: Optional[str] = None) -> None:
    target_email = (student_email or "").strip().lower()
    target_class = (class_id or "").strip()
    for sid, info in list(_socket_sid_info.items()):
        if info.get("role") != "student" or (info.get("email") or "").lower() != target_email:
            continue
        rooms = list(_socket_sid_rooms.get(sid, set()))
        for joined_class_id in rooms:
            if target_class and joined_class_id != target_class:
                continue
            room_name = f"class_{joined_class_id}"
            try:
                leave_room(room_name, sid=sid)
                _socket_sid_rooms.setdefault(sid, set()).discard(joined_class_id)
                socketio.emit("class_membership_revoked", {"class_id": joined_class_id}, to=sid)
            except Exception as exc:
                print(f"Warning: failed to remove sid {sid} from class room {room_name}: {exc}")


def _effective_ai_enabled(req, payload: Optional[dict] = None) -> tuple[bool, Optional[str]]:
    cfg = _load_config()
    if not cfg.get("ai_explainer_enabled", False):
        return False, "AI features disabled by admin"
    user = _require_user(req)
    if user:
        class_id = user.get("class_id") or (_find_user(user.get("email", "")) or {}).get("class_id")
        if not class_id:
            return False, "Join a class to use AI features"
        cls = _find_class_by_id(class_id)
        if not cls:
            return False, "Class not found"
        if not (cls.get("settings") or {}).get("ai_enabled", True):
            return False, "AI features disabled for your class"
        return True, None
    teacher = _require_teacher(req)
    if teacher:
        class_id = str((payload or {}).get("classId") or "").strip()
        if class_id:
            cls = _find_class_by_id(class_id)
            if not cls or (cls.get("teacher_email") or "").lower() != (teacher.get("email") or "").lower():
                return False, "Invalid class selected"
            if not (cls.get("settings") or {}).get("ai_enabled", True):
                return False, "AI features disabled for this class"
        return True, None
    return True, None

# -------------------------
# Admin & Config routes
# -------------------------
@app.post("/api/admin/login")
def admin_login():
    # Rate limiting: max 10 admin login attempts per 15 minutes per IP
    ip = _get_request_ip(request)
    now = time.time()
    _login_rate_limit[ip] = [t for t in _login_rate_limit[ip] if now - t < 900]
    if len(_login_rate_limit[ip]) >= 10:
        return jsonify(ok=False, error="Too many login attempts. Please wait and try again."), 429
    _login_rate_limit[ip].append(now)

    data = request.get_json(silent=True) or {}
    email = str(data.get("email", "")).strip()
    pw = str(data.get("password", ""))
    # Constant-time comparison to prevent timing attacks
    email_ok = hmac.compare_digest(email.lower(), ADMIN_ACCOUNT_EMAIL.lower())
    pw_ok = hmac.compare_digest(pw, ADMIN_ACCOUNT_PASSWORD)
    if email_ok and pw_ok:
        token = uuid.uuid4().hex
        _admin_tokens.add(token)
        _record_sign_in_event(ADMIN_ACCOUNT_EMAIL, "admin", ip, "admin_login")
        return jsonify(ok=True, token=token)
    return jsonify(ok=False, error="Invalid email or password"), 401

@app.get("/api/config")
def get_config():
    cfg = _load_config()
    sanitized = dict(cfg)
    sanitized.pop("admin_password_encrypted", None)
    return jsonify(ok=True, data=sanitized)

@app.post("/api/config/save")
def save_config():
    if not _require_admin(request):
        return jsonify(ok=False, error="Admin token required"), 401
    data = request.get_json(silent=True) or {}
    partial = data.get("data", {})
    if isinstance(partial, dict):
        partial.pop("admin_password_encrypted", None)
        partial.pop("admin_email", None)
    new_cfg = _update_config(partial)
    new_cfg.pop("admin_password_encrypted", None)
    return jsonify(ok=True, data=new_cfg)

# -------------------------
# Student auth endpoints
# -------------------------
@app.post("/api/auth/register")
def auth_register():
    cfg = _load_config()
    if not cfg.get("registration_enabled", True):
        return jsonify(ok=False, error="Registration is currently disabled"), 403
    
    # Rate limiting: max 5 registrations per hour per IP
    ip = _get_request_ip(request)
    now = time.time()
    timestamps = _reg_rate_limit[ip]
    # Clean old entries for this IP
    _reg_rate_limit[ip] = [t for t in timestamps if now - t < 3600]
    if len(_reg_rate_limit[ip]) >= 5:
        return jsonify(ok=False, error="Too many registration attempts. Try again later."), 429
    # Probabilistically evict IPs with no recent activity (~5 % of requests)
    # to prevent unbounded dict growth without paying full scan cost every time.
    if random.random() < 0.05:
        stale_ips = [k for k, v in list(_reg_rate_limit.items()) if not v]
        for stale_ip in stale_ips:
            _reg_rate_limit.pop(stale_ip, None)
    
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = (data.get("password") or "")
    name = (data.get("name") or "").strip()
    
    if not email or not password or not name:
        return jsonify(ok=False, error="Email, password, and name are required"), 400
    if len(password) < 6:
        return jsonify(ok=False, error="Password must be at least 6 characters"), 400
    if len(name) > 100:
        name = name[:100]
    # Basic email validation (simple, non-backtracking)
    at_idx = email.find('@')
    if at_idx <= 0 or at_idx == len(email) - 1:
        return jsonify(ok=False, error="Invalid email address"), 400
    dot_idx = email.find('.', at_idx)
    if dot_idx <= at_idx + 1 or dot_idx == len(email) - 1:
        return jsonify(ok=False, error="Invalid email address"), 400
    
    if _find_user(email):
        return jsonify(ok=False, error="Email already registered"), 409
    
    password_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    timestamp = _current_timestamp()
    user = {
        "email": email,
        "password_hash": password_hash,
        "name": name,
        "role": "student",
        "class_id": None,
        "created_at": timestamp,
        "last_sign_in": timestamp,
        "last_ip": ip if ip != "unknown" else "",
        "enabled": True
    }
    
    users_data = _load_users()
    users_data["users"].append(user)
    _save_users(users_data)
    _reg_rate_limit[ip].append(now)
    
    # Create user directory
    user_dir = _get_user_dir(email)
    user_dir.mkdir(parents=True, exist_ok=True)
    _seed_example_files(email)
    
    # Issue token
    token = uuid.uuid4().hex
    user_info = {"email": email, "name": name, "role": "student", "class_id": None}
    _student_tokens[token] = user_info
    _record_sign_in_event(email, "student", ip, "registration")
    
    return jsonify(ok=True, token=token, user=user_info)

@app.post("/api/auth/login")
def auth_login():
    # Rate limiting: max 20 login attempts per 15 minutes per IP
    ip = _get_request_ip(request)
    now = time.time()
    _login_rate_limit[ip] = [t for t in _login_rate_limit[ip] if now - t < 900]
    if len(_login_rate_limit[ip]) >= 20:
        return jsonify(ok=False, error="Too many login attempts. Please wait and try again."), 429
    _login_rate_limit[ip].append(now)
    if random.random() < 0.05:
        stale = [k for k, v in list(_login_rate_limit.items()) if not v]
        for k in stale:
            _login_rate_limit.pop(k, None)

    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    password = (data.get("password") or "")
    
    if not email or not password:
        return jsonify(ok=False, error="Email and password required"), 400
    
    user = _find_user(email)
    if not user:
        return jsonify(ok=False, error="Invalid email or password"), 401
    if not user.get("enabled", True):
        return jsonify(ok=False, error="Account is disabled"), 403
    
    try:
        pw_ok = bcrypt.checkpw(password.encode("utf-8"), user["password_hash"].encode("utf-8"))
    except Exception:
        pw_ok = False
    
    if not pw_ok:
        return jsonify(ok=False, error="Invalid email or password"), 401
    
    # Ensure user directory exists
    user_dir = _get_user_dir(email)
    user_dir.mkdir(parents=True, exist_ok=True)
    _seed_example_files(email)
    
    _record_user_sign_in(email, ip=ip)
    token = uuid.uuid4().hex
    role = user.get("role", "student")
    if role == "teacher":
        user_info = {"email": email, "name": user.get("name", ""), "role": "teacher"}
        _teacher_tokens[token] = user_info
        _record_sign_in_event(email, "teacher", ip, "login")
        return jsonify(ok=True, token=token, user=user_info, role="teacher")
    user_info = {"email": email, "name": user.get("name", ""), "role": "student", "class_id": user.get("class_id")}
    _student_tokens[token] = user_info
    _record_sign_in_event(email, "student", ip, "login")
    return jsonify(ok=True, token=token, user=user_info, role="student")

@app.post("/api/auth/logout")
def auth_logout():
    token = request.headers.get("X-User-Token", "").strip()
    teacher_token = request.headers.get("X-Teacher-Token", "").strip()
    _student_tokens.pop(token, None)
    _teacher_tokens.pop(teacher_token, None)
    return jsonify(ok=True)

@app.get("/api/auth/me")
def auth_me():
    user = _require_user(request)
    if not user:
        user = _require_teacher(request)
    if not user:
        return jsonify(ok=False, error="Not authenticated"), 401
    return jsonify(ok=True, user=user)

# -------------------------
# File management endpoints
# -------------------------
@app.get("/api/files/list")
def files_list():
    user = _require_user_for_files(request)
    if not user:
        return jsonify(ok=False, error="Authentication required"), 401
    
    user_dir = _get_user_dir(user["email"])
    user_dir.mkdir(parents=True, exist_ok=True)
    
    def build_tree(directory: Path, base: Path) -> list:
        items = []
        try:
            for entry in sorted(directory.iterdir(), key=lambda x: (x.is_file(), x.name.lower())):
                rel = str(entry.relative_to(base))
                if entry.is_dir():
                    items.append({
                        "name": entry.name,
                        "path": rel,
                        "type": "folder",
                        "children": build_tree(entry, base)
                    })
                elif entry.is_file() and entry.suffix.lower() in ALLOWED_EXTENSIONS:
                    items.append({
                        "name": entry.name,
                        "path": rel,
                        "type": "file",
                        "size": entry.stat().st_size
                    })
        except PermissionError:
            pass
        return items
    
    tree = build_tree(user_dir, user_dir)
    return jsonify(ok=True, files=tree)

@app.post("/api/files/create")
def files_create():
    user = _require_user_for_files(request)
    if not user:
        return jsonify(ok=False, error="Authentication required"), 401
    
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    file_type = (data.get("type") or "file")
    parent = (data.get("parent") or "").strip()
    
    if not name:
        return jsonify(ok=False, error="Name required"), 400
    
    user_dir = _get_user_dir(user["email"])
    
    if parent:
        parent_path = _validate_user_path(user_dir, parent)
        if not parent_path:
            return jsonify(ok=False, error="Invalid parent path"), 400
        target = parent_path / name
    else:
        target = user_dir / name
    
    # Validate target is within user dir
    try:
        rel = target.relative_to(user_dir.resolve())
        target_validated = _validate_user_path(user_dir, str(rel))
    except ValueError:
        target_validated = _validate_user_path(user_dir, name)
    if not target_validated:
        return jsonify(ok=False, error="Invalid path"), 400
    
    if file_type == "folder":
        target_validated.mkdir(parents=True, exist_ok=True)
        return jsonify(ok=True, path=str(target_validated.relative_to(user_dir)))
    else:
        # File - check extension
        suffix = Path(name).suffix.lower()
        if suffix not in ALLOWED_EXTENSIONS:
            return jsonify(ok=False, error=f"Only {', '.join(ALLOWED_EXTENSIONS)} files allowed"), 400
        # Check file count limits (only for new files)
        if not target_validated.exists():
            parent_dir = target_validated.parent
            if _count_files_in_folder(parent_dir) >= MAX_FILES_PER_FOLDER:
                return jsonify(ok=False, error=f"Folder limit reached (max {MAX_FILES_PER_FOLDER} files per folder)"), 400
            if _count_all_files_for_user(user_dir) >= MAX_FILES_PER_ACCOUNT:
                return jsonify(ok=False, error=f"Account limit reached (max {MAX_FILES_PER_ACCOUNT} files per account)"), 400
        target_validated.parent.mkdir(parents=True, exist_ok=True)
        if not target_validated.exists():
            target_validated.write_text("", encoding="utf-8")
        return jsonify(ok=True, path=str(target_validated.relative_to(user_dir)))

@app.get("/api/files/read")
def files_read():
    user = _require_user_for_files(request)
    if not user:
        return jsonify(ok=False, error="Authentication required"), 401
    
    path_str = request.args.get("path", "")
    if not path_str:
        return jsonify(ok=False, error="Path required"), 400
    
    user_dir = _get_user_dir(user["email"])
    target = _validate_user_path(user_dir, path_str)
    if not target or not target.exists() or not target.is_file():
        return jsonify(ok=False, error="File not found"), 404
    
    if target.suffix.lower() not in ALLOWED_EXTENSIONS:
        return jsonify(ok=False, error="File type not allowed"), 400
    
    try:
        content = target.read_text(encoding="utf-8")
        return jsonify(ok=True, content=content, path=path_str)
    except Exception:
        return jsonify(ok=False, error="Could not read file"), 500

@app.post("/api/files/write")
def files_write():
    user = _require_user_for_files(request)
    if not user:
        return jsonify(ok=False, error="Authentication required"), 401
    
    data = request.get_json(silent=True) or {}
    path_str = (data.get("path") or "").strip()
    content = data.get("content", "")
    
    if not path_str:
        return jsonify(ok=False, error="Path required"), 400
    
    user_dir = _get_user_dir(user["email"])
    target = _validate_user_path(user_dir, path_str)
    if not target:
        return jsonify(ok=False, error="Invalid path"), 400
    
    if target.suffix.lower() not in ALLOWED_EXTENSIONS:
        return jsonify(ok=False, error="File type not allowed"), 400
    
    # Check storage limit
    limit_bytes = USER_STORAGE_LIMIT_MB * 1024 * 1024
    used = _get_user_storage_used(user_dir)
    content_bytes = len(content.encode("utf-8"))
    existing_size = target.stat().st_size if target.exists() else 0
    if used - existing_size + content_bytes > limit_bytes:
        return jsonify(ok=False, error=f"Storage limit of {USER_STORAGE_LIMIT_MB}MB exceeded"), 413
    
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return jsonify(ok=True)
    except Exception:
        return jsonify(ok=False, error="Could not write file"), 500

@app.post("/api/files/rename")
def files_rename():
    user = _require_user_for_files(request)
    if not user:
        return jsonify(ok=False, error="Authentication required"), 401
    
    data = request.get_json(silent=True) or {}
    old_path = (data.get("old_path") or "").strip()
    new_name = (data.get("new_name") or "").strip()
    
    if not old_path or not new_name:
        return jsonify(ok=False, error="old_path and new_name required"), 400
    
    user_dir = _get_user_dir(user["email"])
    old = _validate_user_path(user_dir, old_path)
    if not old or not old.exists():
        return jsonify(ok=False, error="File not found"), 404
    
    new = old.parent / new_name
    new_validated = _validate_user_path(user_dir, str(new.relative_to(user_dir.resolve())))
    if not new_validated:
        return jsonify(ok=False, error="Invalid new name"), 400
    
    if new_validated.exists():
        return jsonify(ok=False, error="A file/folder with that name already exists"), 409
    
    try:
        old.rename(new_validated)
        return jsonify(ok=True, new_path=str(new_validated.relative_to(user_dir)))
    except Exception:
        return jsonify(ok=False, error="Could not rename item"), 500

@app.delete("/api/files/delete")
def files_delete():
    user = _require_user_for_files(request)
    if not user:
        return jsonify(ok=False, error="Authentication required"), 401
    
    data = request.get_json(silent=True) or {}
    path_str = (data.get("path") or "").strip()
    
    if not path_str:
        return jsonify(ok=False, error="Path required"), 400
    
    user_dir = _get_user_dir(user["email"])
    target = _validate_user_path(user_dir, path_str)
    if not target or not target.exists():
        return jsonify(ok=False, error="File not found"), 404
    
    try:
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink()
        return jsonify(ok=True)
    except Exception:
        return jsonify(ok=False, error="Could not delete item"), 500

@app.post("/api/files/upload")
def files_upload():
    user = _require_user_for_files(request)
    if not user:
        return jsonify(ok=False, error="Authentication required"), 401
    
    if "file" not in request.files:
        return jsonify(ok=False, error="No file provided"), 400
    
    f = request.files["file"]
    parent = request.form.get("parent", "").strip()
    
    filename = f.filename or ""
    if not filename:
        return jsonify(ok=False, error="No filename"), 400
    
    # Sanitize filename
    filename = Path(filename).name  # Strip path components
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        return jsonify(ok=False, error=f"Only {', '.join(ALLOWED_EXTENSIONS)} files allowed"), 400
    
    user_dir = _get_user_dir(user["email"])
    
    if parent:
        parent_path = _validate_user_path(user_dir, parent)
        if not parent_path or not parent_path.is_dir():
            return jsonify(ok=False, error="Invalid parent directory"), 400
        target = parent_path / filename
    else:
        target = user_dir / filename
    
    target_validated = _validate_user_path(user_dir, str(target.relative_to(user_dir.resolve())))
    if not target_validated:
        return jsonify(ok=False, error="Invalid path"), 400
    
    # Check storage limit
    content = f.read()
    limit_bytes = USER_STORAGE_LIMIT_MB * 1024 * 1024
    used = _get_user_storage_used(user_dir)
    existing_size = target_validated.stat().st_size if target_validated.exists() else 0
    if used - existing_size + len(content) > limit_bytes:
        return jsonify(ok=False, error=f"Storage limit exceeded"), 413

    # Check file count limits (only for new files)
    if not target_validated.exists():
        parent_dir = target_validated.parent
        if _count_files_in_folder(parent_dir) >= MAX_FILES_PER_FOLDER:
            return jsonify(ok=False, error=f"Folder limit reached (max {MAX_FILES_PER_FOLDER} files per folder)"), 400
        if _count_all_files_for_user(user_dir) >= MAX_FILES_PER_ACCOUNT:
            return jsonify(ok=False, error=f"Account limit reached (max {MAX_FILES_PER_ACCOUNT} files per account)"), 400
    
    try:
        target_validated.write_bytes(content)
        return jsonify(ok=True, path=str(target_validated.relative_to(user_dir)))
    except Exception:
        return jsonify(ok=False, error="Could not save uploaded file"), 500

@app.get("/api/files/download")
def files_download():
    """Download a user file as an attachment"""
    user = _require_user_for_files(request)
    if not user:
        return jsonify(ok=False, error="Authentication required"), 401

    path_str = request.args.get("path", "")
    if not path_str:
        return jsonify(ok=False, error="Path required"), 400

    user_dir = _get_user_dir(user["email"])
    target = _validate_user_path(user_dir, path_str)
    if not target or not target.exists() or not target.is_file():
        return jsonify(ok=False, error="File not found"), 404

    if target.suffix.lower() not in ALLOWED_EXTENSIONS:
        return jsonify(ok=False, error="File type not allowed"), 400

    ext = target.suffix.lower()
    mimetypes_map = {
        ".py": "text/x-python",
        ".js": "text/javascript",
        ".html": "text/html",
        ".css": "text/css",
        ".txt": "text/plain",
        ".csv": "text/csv",
    }
    mimetype = mimetypes_map.get(ext, "text/plain")

    try:
        data = target.read_bytes()
    except Exception:
        return jsonify(ok=False, error="Could not read file"), 500

    from flask import Response
    return Response(
        data,
        mimetype=mimetype,
        headers={"Content-Disposition": f'attachment; filename="{target.name}"'}
    )

@app.get("/api/files/storage")
def files_storage():
    user = _require_user_for_files(request)
    if not user:
        return jsonify(ok=False, error="Authentication required"), 401
    
    user_dir = _get_user_dir(user["email"])
    used = _get_user_storage_used(user_dir)
    limit = USER_STORAGE_LIMIT_MB * 1024 * 1024
    return jsonify(ok=True, used_bytes=used, limit_bytes=limit)

@app.post("/api/files/move")
def files_move():
    """Move a file or folder to a new parent directory"""
    user = _require_user_for_files(request)
    if not user:
        return jsonify(ok=False, error="Authentication required"), 401

    data = request.get_json(silent=True) or {}
    src_path = (data.get("src") or "").strip()
    dest_folder = (data.get("dest") or "").strip()  # destination folder path ("" = root)

    if not src_path:
        return jsonify(ok=False, error="src path required"), 400

    user_dir = _get_user_dir(user["email"])
    src = _validate_user_path(user_dir, src_path)
    if not src or not src.exists():
        return jsonify(ok=False, error="Source not found"), 404

    if dest_folder:
        dest_dir = _validate_user_path(user_dir, dest_folder)
        if not dest_dir or not dest_dir.is_dir():
            return jsonify(ok=False, error="Destination folder not found"), 404
    else:
        dest_dir = user_dir.resolve()

    # Prevent moving a folder into itself or any of its descendants
    if src.is_dir():
        try:
            dest_dir.resolve().relative_to(src.resolve())
            return jsonify(ok=False, error="Cannot move a folder into itself or its subfolders"), 400
        except ValueError:
            pass  # dest_dir is not inside src — this is the valid case

    # Extract and validate the base filename (Path.name strips directory components)
    safe_name = src.name  # Path.name is always just the final component
    # Reject any name that is empty, '.' or '..'
    if not safe_name or safe_name in ('.', '..'):
        return jsonify(ok=False, error="Invalid source name"), 400

    new_dest = dest_dir / safe_name
    new_validated = _validate_user_path(user_dir, str(new_dest.relative_to(user_dir.resolve())))
    if not new_validated:
        return jsonify(ok=False, error="Invalid destination path"), 400

    if new_validated.exists():
        return jsonify(ok=False, error="A file or folder with that name already exists in the destination"), 409

    try:
        src.rename(new_validated)
        return jsonify(ok=True, new_path=str(new_validated.relative_to(user_dir.resolve())))
    except Exception:
        return jsonify(ok=False, error="Could not move item"), 500

# -------------------------
# Background image
# -------------------------
@app.get("/api/background")
def serve_background():
    """Serve the background image if it exists"""
    for ext in ("png", "jpg", "jpeg", "webp", "gif"):
        img = BASE_DIR / f"background.{ext}"
        if img.exists():
            return send_file(str(img))
    return jsonify(ok=False, error="No background image found"), 404

@app.get("/api/background_dark")
def serve_background_dark():
    """Serve the dark-mode background image; falls back to the regular background"""
    for ext in ("png", "jpg", "jpeg", "webp", "gif"):
        img = BASE_DIR / f"background_dark.{ext}"
        if img.exists():
            return send_file(str(img))
    # Fallback to regular background
    return serve_background()

# -------------------------
# Admin user management
# -------------------------
@app.get("/api/admin/users")
def admin_list_users():
    if not _require_admin(request):
        return jsonify(ok=False, error="Admin token required"), 401
    data = _load_users()
    classes = {c.get("id"): c for c in _load_classes().get("classes", [])}
    users = []
    for u in data.get("users", []):
        class_id = u.get("class_id")
        class_name = (classes.get(class_id) or {}).get("name") if class_id else None
        email = u.get("email", "")
        user_dir = _get_user_dir(email)
        storage_bytes = _get_user_storage_used(user_dir)
        file_count = _count_all_files_for_user(user_dir)
        users.append({
            "email": email,
            "name": u.get("name"),
            "role": u.get("role", "student"),
            "class_id": class_id,
            "class_name": class_name,
            "created_at": u.get("created_at"),
            "last_sign_in": u.get("last_sign_in", ""),
            "last_ip": u.get("last_ip", ""),
            "enabled": u.get("enabled", True),
            "storage_bytes": storage_bytes,
            "file_count": file_count,
        })
    users.sort(key=lambda user: ((user.get("name") or "").lower(), (user.get("email") or "").lower()))
    return jsonify(ok=True, users=users)


@app.post("/api/admin/teachers/create")
def admin_create_teacher():
    if not _require_admin(request):
        return jsonify(ok=False, error="Admin token required"), 401
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    name = (data.get("name") or "").strip()
    password = (data.get("password") or "").strip()
    if not email or not name or not password:
        return jsonify(ok=False, error="Name, email, and password are required"), 400
    if len(password) < 8:
        return jsonify(ok=False, error="Password must be at least 8 characters"), 400
    if _find_user(email):
        return jsonify(ok=False, error="Email already registered"), 409
    users_data = _load_users()
    timestamp = _current_timestamp()
    users_data["users"].append({
        "email": email,
        "password_hash": bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8"),
        "name": name[:100],
        "role": "teacher",
        "class_id": None,
        "created_at": timestamp,
        "last_sign_in": "",
        "enabled": True,
    })
    _save_users(users_data)
    return jsonify(ok=True)

@app.post("/api/admin/users/reset-password")
def admin_reset_password():
    if not _require_admin(request):
        return jsonify(ok=False, error="Admin token required"), 401
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    if not email:
        return jsonify(ok=False, error="Email required"), 400
    
    new_password = secrets.token_urlsafe(16)
    password_hash = bcrypt.hashpw(new_password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    
    users_data = _load_users()
    found = False
    for u in users_data.get("users", []):
        if u.get("email", "").lower() == email:
            u["password_hash"] = password_hash
            found = True
            break
    
    if not found:
        return jsonify(ok=False, error="User not found"), 404
    
    _save_users(users_data)
    
    # Invalidate existing tokens
    for token, info in list(_student_tokens.items()):
        if info.get("email", "").lower() == email:
            del _student_tokens[token]
    for token, info in list(_teacher_tokens.items()):
        if info.get("email", "").lower() == email:
            del _teacher_tokens[token]
    
    return jsonify(ok=True, temp_password=new_password)

@app.post("/api/admin/users/delete")
def admin_delete_user():
    if not _require_admin(request):
        return jsonify(ok=False, error="Admin token required"), 401
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    if not email:
        return jsonify(ok=False, error="Email required"), 400
    if not _delete_user_by_email(email):
        return jsonify(ok=False, error="User not found"), 404
    return jsonify(ok=True)

@app.post("/api/admin/users/toggle")
def admin_toggle_user():
    if not _require_admin(request):
        return jsonify(ok=False, error="Admin token required"), 401
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    enabled = data.get("enabled", True)
    if not email:
        return jsonify(ok=False, error="Email required"), 400
    
    users_data = _load_users()
    found = False
    for u in users_data.get("users", []):
        if u.get("email", "").lower() == email:
            u["enabled"] = bool(enabled)
            found = True
            break
    
    if not found:
        return jsonify(ok=False, error="User not found"), 404
    
    _save_users(users_data)
    
    # If disabling, invalidate tokens
    if not enabled:
        for token, info in list(_student_tokens.items()):
            if info.get("email", "").lower() == email:
                del _student_tokens[token]
        for token, info in list(_teacher_tokens.items()):
            if info.get("email", "").lower() == email:
                del _teacher_tokens[token]
    
    return jsonify(ok=True)

@app.post("/api/admin/users/clear-files")
def admin_clear_user_files():
    """Delete all stored files for a user account without viewing the content."""
    if not _require_admin(request):
        return jsonify(ok=False, error="Admin token required"), 401
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    if not email:
        return jsonify(ok=False, error="Email required"), 400
    if not _find_user(email):
        return jsonify(ok=False, error="User not found"), 404
    user_dir = _get_user_dir(email).resolve()
    # Ensure path is strictly within USER_FILES_DIR to prevent any traversal
    try:
        user_dir.relative_to(USER_FILES_DIR.resolve())
    except ValueError:
        return jsonify(ok=False, error="Invalid user path"), 400
    if user_dir.exists():
        try:
            shutil.rmtree(user_dir)
            user_dir.mkdir(parents=True, exist_ok=True)
            _seed_example_files(email)
        except Exception as exc:
            return jsonify(ok=False, error=f"Failed to clear files: {type(exc).__name__}"), 500
    else:
        user_dir.mkdir(parents=True, exist_ok=True)
        _seed_example_files(email)
    _append_server_log(f"Admin cleared files for {email}; Examples restored.", "WARNING")
    return jsonify(ok=True)


def _delete_user_by_email(email: str) -> bool:
    """Remove a user record, invalidate tokens, clean up class memberships and files.
    Returns True if the user was found and deleted, False otherwise."""
    users_data = _load_users()
    deleted_user = next(
        (u for u in users_data.get("users", []) if (u.get("email") or "").lower() == email),
        None,
    )
    before = len(users_data.get("users", []))
    users_data["users"] = [u for u in users_data.get("users", []) if u.get("email", "").lower() != email]
    if len(users_data["users"]) == before:
        return False
    _save_users(users_data)
    for token, info in list(_student_tokens.items()):
        if info.get("email", "").lower() == email:
            del _student_tokens[token]
    for token, info in list(_teacher_tokens.items()):
        if info.get("email", "").lower() == email:
            del _teacher_tokens[token]
    classes_data = _load_classes()
    changed_classes = False
    for c in classes_data.get("classes", []):
        before_students = len(c.get("students", []))
        c["students"] = [s for s in c.get("students", []) if s.lower() != email]
        if len(c["students"]) != before_students:
            changed_classes = True
    if deleted_user and deleted_user.get("role") == "teacher":
        before_count = len(classes_data.get("classes", []))
        classes_data["classes"] = [
            c for c in classes_data.get("classes", [])
            if (c.get("teacher_email") or "").lower() != email
        ]
        changed_classes = changed_classes or len(classes_data["classes"]) != before_count
    if changed_classes:
        _save_classes(classes_data)
    if deleted_user and deleted_user.get("role") == "student":
        _revoke_student_class_rooms(email)
    user_dir = _get_user_dir(email).resolve()
    # Ensure path is strictly within USER_FILES_DIR to prevent any traversal
    try:
        user_dir.relative_to(USER_FILES_DIR.resolve())
    except ValueError:
        print(f"Warning: _delete_user_by_email path containment check failed for {email}")
        return False
    if user_dir.exists():
        try:
            shutil.rmtree(user_dir)
        except Exception as exc:
            print(f"Warning: failed to delete user directory for {email}: {type(exc).__name__}")
    return True


@app.post("/api/admin/users/bulk-delete")
def admin_bulk_delete_users():
    """Delete multiple user accounts and all their data."""
    if not _require_admin(request):
        return jsonify(ok=False, error="Admin token required"), 401
    data = request.get_json(silent=True) or {}
    emails = data.get("emails") or []
    if not isinstance(emails, list) or not emails:
        return jsonify(ok=False, error="emails list required"), 400
    deleted = []
    not_found = []
    for raw in emails:
        email = (str(raw) or "").strip().lower()
        if not email:
            continue
        if _delete_user_by_email(email):
            deleted.append(email)
        else:
            not_found.append(email)
    return jsonify(ok=True, deleted=deleted, not_found=not_found)


@app.post("/api/admin/users/bulk-toggle")
def admin_bulk_toggle_users():
    """Enable or disable multiple user accounts."""
    if not _require_admin(request):
        return jsonify(ok=False, error="Admin token required"), 401
    data = request.get_json(silent=True) or {}
    emails = data.get("emails") or []
    enabled = bool(data.get("enabled", True))
    if not isinstance(emails, list) or not emails:
        return jsonify(ok=False, error="emails list required"), 400
    users_data = _load_users()
    updated = []
    for raw in emails:
        email = (str(raw) or "").strip().lower()
        if not email:
            continue
        for u in users_data.get("users", []):
            if u.get("email", "").lower() == email:
                u["enabled"] = enabled
                updated.append(email)
                break
    _save_users(users_data)
    if not enabled:
        for email in updated:
            for token, info in list(_student_tokens.items()):
                if info.get("email", "").lower() == email:
                    del _student_tokens[token]
            for token, info in list(_teacher_tokens.items()):
                if info.get("email", "").lower() == email:
                    del _teacher_tokens[token]
    return jsonify(ok=True, updated=updated)


@app.post("/api/admin/users/bulk-clear-files")
def admin_bulk_clear_files():
    """Delete all stored files for multiple user accounts without viewing the content."""
    if not _require_admin(request):
        return jsonify(ok=False, error="Admin token required"), 401
    data = request.get_json(silent=True) or {}
    emails = data.get("emails") or []
    if not isinstance(emails, list) or not emails:
        return jsonify(ok=False, error="emails list required"), 400
    cleared = []
    errors = []
    for raw in emails:
        email = (str(raw) or "").strip().lower()
        if not email or not _find_user(email):
            continue
        user_dir = _get_user_dir(email).resolve()
        # Ensure path is strictly within USER_FILES_DIR to prevent any traversal
        try:
            user_dir.relative_to(USER_FILES_DIR.resolve())
        except ValueError:
            errors.append(email)
            continue
        if user_dir.exists():
            try:
                shutil.rmtree(user_dir)
                user_dir.mkdir(parents=True, exist_ok=True)
                _seed_example_files(email)
                cleared.append(email)
            except Exception:
                errors.append(email)
        else:
            user_dir.mkdir(parents=True, exist_ok=True)
            _seed_example_files(email)
            cleared.append(email)
    if cleared:
        _append_server_log(f"Admin bulk-cleared files for {len(cleared)} account(s); Examples restored.", "WARNING")
    return jsonify(ok=True, cleared=cleared, errors=errors)


@app.post("/api/admin/registration")
def admin_toggle_registration():
    if not _require_admin(request):
        return jsonify(ok=False, error="Admin token required"), 401
    data = request.get_json(silent=True) or {}
    enabled = data.get("enabled", True)
    _update_config({"registration_enabled": bool(enabled)})
    return jsonify(ok=True, registration_enabled=bool(enabled))


@app.get("/api/classes/current")
def get_current_class():
    user = _require_user(request)
    if not user:
        return jsonify(ok=True, classData=None)
    class_id = user.get("class_id")
    if not class_id:
        user_obj = _find_user(user.get("email", ""))
        class_id = (user_obj or {}).get("class_id")
        user["class_id"] = class_id
    cls = _find_class_by_id(class_id) if class_id else None
    if not cls:
        return jsonify(ok=True, classData=None)
    return jsonify(ok=True, classData={
        "id": cls.get("id"),
        "name": cls.get("name"),
        "settings": cls.get("settings", {}),
        "teacher_email": cls.get("teacher_email"),
    })


@app.post("/api/classes/join")
def join_class():
    user = _require_user(request)
    if not user:
        return jsonify(ok=False, error="Student login required"), 401
    join_code = (request.get_json(silent=True) or {}).get("joinCode", "")
    target = _find_class_by_code(join_code)
    if not target:
        return jsonify(ok=False, error="Invalid join code"), 404
    users_data = _load_users()
    target_email = (user.get("email") or "").strip().lower()
    student = next((u for u in users_data.get("users", []) if (u.get("email") or "").lower() == target_email), None)
    if not student:
        return jsonify(ok=False, error="Student not found"), 404
    if student.get("role") != "student":
        return jsonify(ok=False, error="Only student accounts can join classes"), 400
    if student.get("class_id"):
        return jsonify(ok=False, error="You are already in a class"), 409
    classes_data = _load_classes()
    joined = None
    for c in classes_data.get("classes", []):
        if c.get("id") == target.get("id"):
            students = c.setdefault("students", [])
            if target_email not in students:
                students.append(target_email)
            joined = c
            break
    if not joined:
        return jsonify(ok=False, error="Class not found"), 404
    student["class_id"] = joined.get("id")
    _save_users(users_data)
    _save_classes(classes_data)
    user["class_id"] = joined.get("id")
    return jsonify(ok=True, classData={
        "id": joined.get("id"),
        "name": joined.get("name"),
        "settings": joined.get("settings", {}),
    })


@app.get("/api/teacher/classes")
def teacher_list_classes():
    teacher = _require_teacher(request)
    if not teacher:
        return jsonify(ok=False, error="Teacher token required"), 401
    teacher_email = (teacher.get("email") or "").strip().lower()
    classes = _get_teacher_classes(teacher_email)
    users_by_email = {u.get("email", "").lower(): u for u in _load_users().get("users", [])}
    result = []
    for c in classes:
        students = []
        for student_email in c.get("students", []):
            student_user = users_by_email.get(student_email.lower(), {})
            students.append({
                "email": student_email,
                "name": student_user.get("name") or student_email,
                "enabled": student_user.get("enabled", True),
            })
        result.append({
            "id": c.get("id"),
            "name": c.get("name"),
            "join_code": c.get("join_code"),
            "settings": c.get("settings", {}),
            "students": sorted(students, key=lambda s: ((s.get("name") or "").lower(), (s.get("email") or "").lower()))
        })
    return jsonify(ok=True, classes=result)


@app.post("/api/teacher/classes/create")
def teacher_create_class():
    teacher = _require_teacher(request)
    if not teacher:
        return jsonify(ok=False, error="Teacher token required"), 401
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify(ok=False, error="Class name required"), 400
    classes_data = _load_classes()
    existing_codes = {str(c.get("join_code", "")).upper() for c in classes_data.get("classes", [])}
    class_row = {
        "id": uuid.uuid4().hex,
        "name": _sanitize_storage_component(name, fallback="Class", max_length=120),
        "teacher_email": (teacher.get("email") or "").strip().lower(),
        "join_code": _generate_join_code(existing_codes),
        "settings": {
            "ai_enabled": True,
            "wiki_enabled": True,
            "wiki_url": "",
            "wiki_html": "",
        },
        "students": [],
        "created_at": _current_timestamp(),
    }
    classes_data.setdefault("classes", []).append(class_row)
    _save_classes(classes_data)
    return jsonify(ok=True, classData=class_row)


@app.post("/api/teacher/classes/settings")
def teacher_update_class_settings():
    teacher = _require_teacher(request)
    if not teacher:
        return jsonify(ok=False, error="Teacher token required"), 401
    data = request.get_json(silent=True) or {}
    class_id = (data.get("classId") or "").strip()
    settings = data.get("settings") or {}
    cfg = _load_config()
    ai_master_enabled = bool(cfg.get("ai_explainer_enabled", False))
    classes_data = _load_classes()
    teacher_email = (teacher.get("email") or "").strip().lower()
    target = None
    for c in classes_data.get("classes", []):
        if c.get("id") == class_id and (c.get("teacher_email") or "").lower() == teacher_email:
            current = c.setdefault("settings", {})
            if ai_master_enabled and "ai_enabled" in settings:
                current["ai_enabled"] = bool(settings.get("ai_enabled"))
            if "wiki_enabled" in settings:
                current["wiki_enabled"] = bool(settings.get("wiki_enabled"))
            if "wiki_url" in settings:
                current["wiki_url"] = str(settings.get("wiki_url") or "")[:1000]
            if "wiki_html" in settings:
                current["wiki_html"] = str(settings.get("wiki_html") or "")
            target = c
            break
    if not target:
        return jsonify(ok=False, error="Class not found"), 404
    _save_classes(classes_data)
    return jsonify(ok=True, classData=target)


@app.post("/api/teacher/classes/remove-student")
def teacher_remove_student():
    teacher = _require_teacher(request)
    if not teacher:
        return jsonify(ok=False, error="Teacher token required"), 401
    data = request.get_json(silent=True) or {}
    class_id = (data.get("classId") or "").strip()
    student_email = (data.get("studentEmail") or "").strip().lower()
    if not class_id or not student_email:
        return jsonify(ok=False, error="classId and studentEmail are required"), 400
    classes_data = _load_classes()
    teacher_email = (teacher.get("email") or "").strip().lower()
    found = False
    for c in classes_data.get("classes", []):
        if c.get("id") == class_id and (c.get("teacher_email") or "").lower() == teacher_email:
            c["students"] = [s for s in c.get("students", []) if s.lower() != student_email]
            found = True
            break
    if not found:
        return jsonify(ok=False, error="Class not found"), 404
    users_data = _load_users()
    for u in users_data.get("users", []):
        if (u.get("email") or "").lower() == student_email:
            u["class_id"] = None
            break
    _save_classes(classes_data)
    _save_users(users_data)
    for token, info in list(_student_tokens.items()):
        if (info.get("email") or "").lower() == student_email:
            del _student_tokens[token]
    _revoke_student_class_rooms(student_email, class_id)
    return jsonify(ok=True)


@app.post("/api/teacher/classes/delete")
def teacher_delete_class():
    teacher = _require_teacher(request)
    if not teacher:
        return jsonify(ok=False, error="Teacher token required"), 401
    data = request.get_json(silent=True) or {}
    class_id = (data.get("classId") or "").strip()
    if not class_id:
        return jsonify(ok=False, error="classId is required"), 400
    teacher_email = (teacher.get("email") or "").strip().lower()
    classes_data = _load_classes()
    target_class = None
    remaining_classes = []
    for cls in classes_data.get("classes", []):
        if cls.get("id") == class_id and (cls.get("teacher_email") or "").lower() == teacher_email:
            target_class = cls
            continue
        remaining_classes.append(cls)
    if not target_class:
        return jsonify(ok=False, error="Class not found"), 404
    student_emails = [str(email).strip().lower() for email in target_class.get("students", []) if str(email).strip()]
    users_data = _load_users()
    for user in users_data.get("users", []):
        if (user.get("role") or "").lower() != "student":
            continue
        if (user.get("email") or "").strip().lower() in student_emails:
            user["class_id"] = None
    classes_data["classes"] = remaining_classes
    _save_classes(classes_data)
    _save_users(users_data)
    for token, info in list(_student_tokens.items()):
        if (info.get("email") or "").strip().lower() in student_emails:
            info["class_id"] = None
    for student_email in student_emails:
        _revoke_student_class_rooms(student_email, class_id)
    return jsonify(ok=True, deletedClassId=class_id, unassignedStudents=len(student_emails))


@app.post("/api/teacher/students/reset-password")
def teacher_reset_password():
    teacher = _require_teacher(request)
    if not teacher:
        return jsonify(ok=False, error="Teacher token required"), 401
    email = ((request.get_json(silent=True) or {}).get("email") or "").strip().lower()
    if not email:
        return jsonify(ok=False, error="Email required"), 400
    if not _student_in_teacher_class(teacher.get("email", ""), email):
        return jsonify(ok=False, error="Student is not in one of your classes"), 403
    new_password = secrets.token_urlsafe(16)
    users_data = _load_users()
    found = False
    for u in users_data.get("users", []):
        if (u.get("email") or "").lower() == email and u.get("role") == "student":
            u["password_hash"] = bcrypt.hashpw(new_password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
            found = True
            break
    if not found:
        return jsonify(ok=False, error="Student not found"), 404
    _save_users(users_data)
    for token, info in list(_student_tokens.items()):
        if (info.get("email") or "").lower() == email:
            del _student_tokens[token]
    return jsonify(ok=True, temp_password=new_password)


@app.post("/api/teacher/change-password")
def teacher_change_password():
    teacher = _require_teacher(request)
    if not teacher:
        return jsonify(ok=False, error="Teacher token required"), 401
    data = request.get_json(silent=True) or {}
    current_password = str(data.get("currentPassword") or "")
    new_password = str(data.get("newPassword") or "")
    if not current_password or not new_password:
        return jsonify(ok=False, error="Current and new password are required"), 400
    if len(new_password) < 8:
        return jsonify(ok=False, error="New password must be at least 8 characters"), 400
    email = (teacher.get("email") or "").strip().lower()
    users_data = _load_users()
    teacher_record = next(
        (u for u in users_data.get("users", []) if (u.get("email") or "").lower() == email and u.get("role") == "teacher"),
        None
    )
    if not teacher_record:
        return jsonify(ok=False, error="Teacher account not found"), 404
    try:
        current_ok = bcrypt.checkpw(current_password.encode("utf-8"), teacher_record["password_hash"].encode("utf-8"))
    except Exception:
        current_ok = False
    if not current_ok:
        return jsonify(ok=False, error="Current password is incorrect"), 403
    teacher_record["password_hash"] = bcrypt.hashpw(new_password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    _save_users(users_data)
    for token, info in list(_teacher_tokens.items()):
        if (info.get("email") or "").lower() == email and token != request.headers.get("X-Teacher-Token", "").strip():
            del _teacher_tokens[token]
    return jsonify(ok=True)


@app.post("/api/teacher/students/toggle")
def teacher_toggle_student():
    teacher = _require_teacher(request)
    if not teacher:
        return jsonify(ok=False, error="Teacher token required"), 401
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    enabled = bool(data.get("enabled", True))
    if not email:
        return jsonify(ok=False, error="Email required"), 400
    if not _student_in_teacher_class(teacher.get("email", ""), email):
        return jsonify(ok=False, error="Student is not in one of your classes"), 403
    users_data = _load_users()
    found = False
    for u in users_data.get("users", []):
        if (u.get("email") or "").lower() == email and u.get("role") == "student":
            u["enabled"] = enabled
            found = True
            break
    if not found:
        return jsonify(ok=False, error="Student not found"), 404
    _save_users(users_data)
    if not enabled:
        for token, info in list(_student_tokens.items()):
            if (info.get("email") or "").lower() == email:
                del _student_tokens[token]
    return jsonify(ok=True)

# -------------------------
# Ollama helpers (AI)
# -------------------------
def call_ollama_generate(ollama_url: str, model: str, prompt: str, timeout: float = 25.0) -> Dict[str, Any]:
    url = ollama_url.rstrip("/") + "/api/generate"
    payload = {"model": model, "prompt": prompt, "stream": False}
    try:
        r = requests.post(url, json=payload, timeout=timeout)
        r.raise_for_status()
        j = r.json()
        text = j.get("response") or j.get("data") or ""
        return {"ok": True, "text": text}
    except requests.exceptions.RequestException as e:
        return {"ok": False, "error": f"Ollama connection failed: {e}"}
    except Exception as e:
        return {"ok": False, "error": f"Ollama error: {e}"}


def _normalize_language_hint(language: Any, file_name: str = "") -> str:
    raw = str(language or "").strip().lower()
    file_name = (file_name or "").strip().lower()
    if raw in {"html", "htm", "htmlmixed", "xml"} or file_name.endswith(".html") or file_name.endswith(".htm"):
        return "html"
    if raw in {"css"} or file_name.endswith(".css"):
        return "css"
    if raw in {"js", "javascript", "node", "nodejs"} or file_name.endswith(".js"):
        return "javascript"
    return "python"


def _language_label(language: str) -> str:
    if language == "javascript":
        return "JavaScript"
    if language == "html":
        return "HTML"
    if language == "css":
        return "CSS"
    return "Python"


def _language_best_practices(language: str) -> str:
    if language == "javascript":
        return "Does it follow JavaScript best practices?"
    if language == "html":
        return "Does it follow HTML best practices?"
    if language == "css":
        return "Does it follow CSS best practices?"
    return "Does it follow Python best practices?"

# -------------------------
# Explain endpoint
# -------------------------
@app.post("/api/explain")
def api_explain():
    data = request.get_json(silent=True) or {}
    allowed, error = _effective_ai_enabled(request, data)
    if not allowed:
        return jsonify(ok=False, error=error or "AI unavailable"), 403
    cfg = _load_config()
    code = data.get("code", "")
    file_name = (data.get("fileName") or data.get("file_name") or "").strip()
    language = _normalize_language_hint(data.get("language"), file_name)
    language_label = _language_label(language)
    if not code:
        return jsonify(ok=False, error="No code provided"), 400

    pretext = (
        "Explain the following {language} code in 2-3 concise sentences. "
        "If there are any errors or issues, identify them and suggest how to fix them. "
        "Keep your response brief and focused. "
        "If it is clearly not {language} code, say that briefly.\n\n"
    ).format(language=language_label)
    res = call_ollama_generate(cfg.get("ai_ollama_url", ""), cfg.get("ai_model", "gemma3:4b"), pretext + code)
    if not res.get("ok"):
        return jsonify(ok=False, error=res.get("error", "AI error"))
    return jsonify(ok=True, text=res.get("text", ""), cooldown=random.randint(30, 90))

# -------------------------
# Challenge system (CSV)
# -------------------------
_lb_lock = threading.Lock()
_exception_help_lock = threading.Lock()
_exception_help_cache_mtime: Optional[float] = None
_exception_help_cache_rows: list[dict] = []

def _read_exception_help_rows() -> list[dict]:
    global _exception_help_cache_mtime, _exception_help_cache_rows
    if not EXCEPTION_HELP_CSV.exists():
        raise FileNotFoundError("exception_help.csv not found")
    with _exception_help_lock:
        mtime = EXCEPTION_HELP_CSV.stat().st_mtime
        if _exception_help_cache_mtime == mtime and _exception_help_cache_rows:
            return list(_exception_help_cache_rows)

        rows = []
        with EXCEPTION_HELP_CSV.open("r", newline="", encoding="utf-8") as f:
            rd = csv.DictReader(f)
            for r in rd:
                exc = (r.get("Exception") or "").strip()
                if not exc:
                    continue
                rows.append({
                    "exception": exc,
                    "description": (r.get("Description") or "").strip(),
                    "troubleshooting": (r.get("Troubleshooting") or "").strip(),
                })
        _exception_help_cache_mtime = mtime
        _exception_help_cache_rows = rows
        return rows

@app.get("/api/exception-help")
def api_exception_help():
    try:
        rows = _read_exception_help_rows()
    except FileNotFoundError:
        return jsonify(ok=False, error="exception_help.csv not found"), 404
    if not rows:
        return jsonify(ok=False, error="exception_help.csv is empty"), 404
    return jsonify(ok=True, entries=rows)

def _read_challenges() -> list[dict]:
    rows = []
    if not CHALLENGE_CSV.exists():
        return rows
    with CHALLENGE_CSV.open("r", newline="", encoding="utf-8") as f:
        rd = csv.DictReader(f)
        for r in rd:
            try:
                diff = int(r.get("difficulty", "1"))
                pts = int(r.get("points", "3"))
                text = (r.get("text") or "").strip()
                if text:
                    rows.append({"difficulty": diff, "points": pts, "text": text})
            except Exception:
                continue
    return rows

def _challenge_id_for_row(row: dict) -> str:
    raw = f"{row.get('difficulty', 0)}|{row.get('points', 0)}|{row.get('text', '')}"
    # 32 hex chars represent 128 bits of the SHA-256 hash while keeping challenge IDs compact in the client.
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]

def _find_challenge_by_id(challenge_id: str) -> Optional[dict]:
    for row in _read_challenges():
        if _challenge_id_for_row(row) == challenge_id:
            return row
    return None

def _load_challenge_scores() -> dict:
    if CHALLENGE_SCORE_FILE.exists():
        try:
            data = json.loads(CHALLENGE_SCORE_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("students", {}), dict):
                return data
        except Exception:
            pass
    return {"students": {}}

def _save_challenge_scores(data: dict) -> None:
    tmp = CHALLENGE_SCORE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(CHALLENGE_SCORE_FILE)

def _build_challenge_leaderboard() -> list[dict]:
    tracker = _load_challenge_scores()
    students = tracker.get("students", {})
    leaderboard = []
    for user in _load_users().get("users", []):
        email = (user.get("email") or "").strip().lower()
        if not email or email == ADMIN_ACCOUNT_EMAIL.lower():
            continue
        student_entry = students.get(email, {})
        challenges = student_entry.get("challenges", {})
        total_score = sum(max(0, int(challenge.get("score", 0) or 0)) for challenge in challenges.values())
        leaderboard.append({
            "name": student_entry.get("name") or user.get("name") or email,
            "email": email,
            "score": total_score,
            "challengeCount": len(challenges),
        })
    leaderboard.sort(key=lambda row: (-row["score"], row["name"].lower(), row["email"]))
    return leaderboard

@app.post("/api/challenge/random")
def challenge_random():
    data = request.get_json(silent=True) or {}
    try:
        target = int(data.get("difficulty", 1))
    except (ValueError, TypeError):
        target = 1
    all_rows = _read_challenges()
    if not all_rows:
        return jsonify(ok=False, error="No challenges.csv found or it is empty")
    matches = [r for r in all_rows if r["difficulty"] == target] or all_rows
    ch = random.choice(matches)
    return jsonify(ok=True, challengeId=_challenge_id_for_row(ch), difficulty=ch["difficulty"], points=ch["points"], challenge=ch["text"])

@app.post("/api/challenge/score")
def challenge_score():
    user = _require_user(request)
    if not user:
        return jsonify(ok=False, error="Student login required"), 401

    data = request.get_json(silent=True) or {}
    cfg = _load_config()
    allowed, error = _effective_ai_enabled(request, data)
    if not allowed:
        return jsonify(ok=False, error=error or "AI unavailable"), 403

    code = data.get("code", "")
    challenge_text = data.get("challenge", "")
    try:
        points = max(1, min(100, int(data.get("points", 3))))
    except (TypeError, ValueError):
        points = 3
    if not code or not challenge_text:
        return jsonify(ok=False, error="Missing code or challenge"), 400

    file_name = (data.get("fileName") or data.get("file_name") or "").strip()
    language = _normalize_language_hint(data.get("language"), file_name)
    language_label = _language_label(language)
    prompt = (
        "Grade the student's {language} solution with strict adherence to the challenge and high rigor strictly from 0 to {max_points}.\n"
        "Return ONLY the integer number, with no words.\n\n"
        "Challenge:\n{challenge}\n\n"
        "Student code:\n{code}\n"
    ).format(language=language_label, max_points=points, challenge=challenge_text, code=code)

    res = call_ollama_generate(cfg.get("ai_ollama_url", ""), cfg.get("ai_model", "gemma3:4b"), prompt)
    if not res.get("ok"):
        return jsonify(ok=False, error=res.get("error", "AI error"))
    raw = (res.get("text") or "").strip()

    score = None
    for tok in raw.split():
        if tok.strip("-+").isdigit():
            score = int(tok)
            break
    if score is None:
        digits = "".join([c for c in raw if c.isdigit()])
        if digits:
            score = int(digits)
    if score is None:
        return jsonify(ok=False, error=f"AI returned invalid score: {raw!r}")
    score = max(0, min(points, score))
    return jsonify(ok=True, score=score, max=points, student=user.get("name") or user.get("email"))

@app.post("/api/challenge/submit")
def challenge_submit():
    user = _require_user(request)
    if not user:
        return jsonify(ok=False, error="Student login required"), 401

    data = request.get_json(silent=True) or {}
    challenge_id = (data.get("challengeId") or "").strip()
    try:
        score = int(data.get("score", 0))
    except Exception:
        score = 0
    if not challenge_id:
        return jsonify(ok=False, error="Challenge ID required"), 400
    # Zero scores are allowed for latest challenge submissions; only negative scores are rejected.
    if score < 0:
        return jsonify(ok=False, error="Score must be non-negative"), 400

    challenge = _find_challenge_by_id(challenge_id)
    if not challenge:
        return jsonify(ok=False, error="Challenge not found"), 404

    student_email = (user.get("email") or "").strip().lower()
    student_name = user.get("name") or student_email
    submitted_at = _current_timestamp()

    with _lb_lock:
        tracker = _load_challenge_scores()
        students = tracker.setdefault("students", {})
        student_entry = students.setdefault(student_email, {"name": student_name, "challenges": {}})
        student_entry["name"] = student_name
        student_entry.setdefault("challenges", {})[challenge_id] = {
            "challengeId": challenge_id,
            "text": challenge.get("text", ""),
            "difficulty": challenge.get("difficulty", 1),
            "points": challenge.get("points", 0),
            "score": score,
            "submittedAt": submitted_at,
        }
        _save_challenge_scores(tracker)
        leaderboard = _build_challenge_leaderboard()

    return jsonify(ok=True, leaderboard=leaderboard, top=leaderboard, heldScore=score, submittedAt=submitted_at)

@app.get("/api/challenge/leaderboard")
def challenge_leaderboard():
    with _lb_lock:
        leaderboard = _build_challenge_leaderboard()
    return jsonify(ok=True, leaderboard=leaderboard, top=leaderboard)

# -------------------------
# NEW: AI Assistant chat (15s cooldown per client SID)
# -------------------------
_ASSISTANT_LAST: Dict[str, float] = {}
_ASSISTANT_LOCK = threading.Lock()
ASSISTANT_COOLDOWN = 15  # seconds
ASSISTANT_STALE_SECONDS = 3600
ASSISTANT_MAX_SIDS = 2048


def _prune_assistant_sessions(now: float) -> None:
    stale_cutoff = now - ASSISTANT_STALE_SECONDS
    for stale_sid in [sid for sid, seen in list(_ASSISTANT_LAST.items()) if seen < stale_cutoff]:
        _ASSISTANT_LAST.pop(stale_sid, None)
    overflow = len(_ASSISTANT_LAST) - ASSISTANT_MAX_SIDS
    if overflow > 0:
        oldest = heapq.nsmallest(overflow, _ASSISTANT_LAST.items(), key=lambda item: item[1])
        for sid, _ in oldest:
            _ASSISTANT_LAST.pop(sid, None)

@app.post("/api/assistant/chat")
def assistant_chat():
    data = request.get_json(silent=True) or {}
    allowed, error = _effective_ai_enabled(request, data)
    if not allowed:
        return jsonify(ok=False, error=error or "AI unavailable"), 403
    cfg = _load_config()
    sid = (request.headers.get("X-SID") or data.get("sid") or "").strip()
    msgs = data.get("messages", [])  # [{role: 'user'|'assistant', content: '...'}, ...]
    file_name = (data.get("fileName") or data.get("file_name") or "").strip()
    language = _normalize_language_hint(data.get("language"), file_name)
    language_label = _language_label(language)
    code = str(data.get("code") or "")[:MAX_ASSISTANT_CODE_CHARS]

    if not sid:
        return jsonify(ok=False, error="Missing SID"), 400
    if not isinstance(msgs, list) or not msgs:
        return jsonify(ok=False, error="No messages"), 400

    now = time.time()
    with _ASSISTANT_LOCK:
        _prune_assistant_sessions(now)
        last = _ASSISTANT_LAST.get(sid, 0)
        remain = ASSISTANT_COOLDOWN - int(now - last)
        if remain > 0:
            return jsonify(ok=False, error="Cooldown", cooldown=remain), 429

    # Build prompt: preprompt + condensed transcript
    preprompt = cfg.get("ai_assistant_preprompt") or ""
    transcript_lines = []
    for m in msgs[-12:]:  # limit history
        role = (m.get("role") or "").strip().lower()
        content = (m.get("content") or "").strip()
        if not content:
            continue
        if role == "user":
            transcript_lines.append(f"User: {content}")
        else:
            transcript_lines.append(f"Assistant: {content}")
    context_lines = [
        f"The student is currently working in {language_label}.",
    ]
    if file_name:
        context_lines.append(f"Current file: {file_name}")
    if code:
        context_lines.append(f"Current {language_label} code:\n{code}")
    prompt = preprompt.strip() + "\n\n" + "\n".join(context_lines) + "\n\n" + "\n".join(transcript_lines) + "\n\nAssistant:"

    res = call_ollama_generate(cfg.get("ai_ollama_url", ""), cfg.get("ai_model", "gemma3:4b"), prompt)
    if not res.get("ok"):
        return jsonify(ok=False, error=res.get("error", "AI error"))

    with _ASSISTANT_LOCK:
        _ASSISTANT_LAST[sid] = time.time()
        _prune_assistant_sessions(time.time())
    return jsonify(ok=True, reply=(res.get("text") or "").strip(), cooldown=ASSISTANT_COOLDOWN)

# -------------------------
# Minimal static index.html
# -------------------------
@app.get("/")
def root():
    return send_from_directory(BASE_DIR, "index.html")


def _html_runtime_js_bridge(cfg: Dict[str, Any]) -> str:
    bridge_cfg = {
        "allow_external_internet": _cfg_bool(cfg, "html_runtime_allow_external_internet", False),
        "allow_navigation": _cfg_bool(cfg, "html_runtime_allow_navigation", False),
        "allow_popups": _cfg_bool(cfg, "html_runtime_allow_popups", False),
        "max_fps": _cfg_int(cfg, "html_runtime_max_fps", HTML_RUNTIME_DEFAULT_MAX_FPS, 1, 120),
        "memory_limit_mb": _cfg_int(cfg, "html_runtime_memory_limit_mb", HTML_RUNTIME_DEFAULT_MEMORY_MB, 32, 2048),
        "max_dom_nodes": _cfg_int(cfg, "html_runtime_max_dom_nodes", HTML_RUNTIME_DEFAULT_MAX_DOM_NODES, 100, 200000),
        "max_popups": _cfg_int(cfg, "html_runtime_max_popups", HTML_RUNTIME_DEFAULT_MAX_POPUPS, 0, 20),
    }
    config_json = json.dumps(bridge_cfg, ensure_ascii=False)
    return f"""
<script>
(function(){{
  const CFG = {config_json};
  const TAG = "__eagleHtmlRuntime";
  const send = (type, payload = {{}}) => {{
    try {{ parent.postMessage({{ [TAG]: true, type, ...payload }}, "*"); }} catch {{}}
  }};

  const stringify = (value) => {{
    if (typeof value === "string") return value;
    try {{ return JSON.stringify(value); }} catch {{ return String(value); }}
  }};

  ["log","warn","error","info"].forEach((level) => {{
    const original = console[level];
    console[level] = function(...args){{
      send("console", {{ level, message: args.map(stringify).join(" ") }});
      return original.apply(console, args);
    }};
  }});

  window.addEventListener("error", (event) => {{
    send("error", {{
      message: event?.message || "JavaScript error",
      source: event?.filename || "",
      line: event?.lineno || 0,
      column: event?.colno || 0,
      stack: event?.error?.stack || ""
    }});
  }});

  window.addEventListener("unhandledrejection", (event) => {{
    send("error", {{ message: "Unhandled promise rejection: " + stringify(event?.reason) }});
  }});

  if (!CFG.allow_navigation) {{
    const blocked = () => send("status", {{ message: "Navigation blocked by admin settings." }});
    const guardNavigation = (url) => {{
      const raw = String(url || "").trim();
      if (!raw) return true;
      if (raw.startsWith("#")) return true;
      try {{
        const parsed = new URL(raw, window.location.href);
        if (parsed.origin !== window.location.origin || parsed.pathname !== window.location.pathname) {{
          blocked();
          return false;
        }}
      }} catch {{}}
      return true;
    }};
    document.addEventListener("click", (event) => {{
      const anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
      if (!anchor) return;
      if (!guardNavigation(anchor.getAttribute("href"))) {{
        event.preventDefault();
        event.stopPropagation();
      }}
    }}, true);
    try {{
      const locAssign = window.location.assign.bind(window.location);
      const locReplace = window.location.replace.bind(window.location);
      window.location.assign = (url) => {{
        if (!guardNavigation(url)) return;
        locAssign(url);
      }};
      window.location.replace = (url) => {{
        if (!guardNavigation(url)) return;
        locReplace(url);
      }};
    }} catch {{}}
  }}

  if (!CFG.allow_external_internet) {{
    const isAllowedUrl = (rawUrl) => {{
      try {{
        const parsed = new URL(String(rawUrl || ""), window.location.href);
        return parsed.origin === window.location.origin;
      }} catch {{
        return true;
      }}
    }};
    const deny = (kind, rawUrl) => {{
      const urlText = String(rawUrl || "");
      send("error", {{ message: "Blocked " + kind + " request: " + urlText }});
      throw new Error("External internet access is disabled by admin settings.");
    }};

    const originalFetch = window.fetch;
    window.fetch = function(resource, init) {{
      const target = (typeof resource === "string") ? resource : (resource && resource.url ? resource.url : "");
      if (!isAllowedUrl(target)) return Promise.reject(deny("fetch", target));
      return originalFetch.call(this, resource, init);
    }};

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {{
      if (!isAllowedUrl(url)) deny("xhr", url);
      return originalOpen.call(this, method, url, ...rest);
    }};

    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = function(url, protocols) {{
      if (!isAllowedUrl(url)) deny("websocket", url);
      return protocols !== undefined ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
    }};

    const OriginalEventSource = window.EventSource;
    if (OriginalEventSource) {{
      window.EventSource = function(url, config) {{
        if (!isAllowedUrl(url)) deny("eventsource", url);
        return config !== undefined ? new OriginalEventSource(url, config) : new OriginalEventSource(url);
      }};
    }}
  }}

  const fpsCap = Math.max(1, Number(CFG.max_fps) || 30);
  const frameInterval = 1000 / fpsCap;
  const originalRaf = window.requestAnimationFrame.bind(window);
  let lastFrame = 0;
  window.requestAnimationFrame = (callback) => originalRaf((timestamp) => {{
    if ((timestamp - lastFrame) >= frameInterval) {{
      lastFrame = timestamp;
      callback(timestamp);
    }}
  }});

  if (Number(CFG.max_dom_nodes) > 0) {{
    const maxNodes = Number(CFG.max_dom_nodes);
    setInterval(() => {{
      const count = document.getElementsByTagName("*").length;
      if (count > maxNodes) {{
        send("limit", {{ message: "Execution time limit reached." }});
        throw new Error("DOM node limit reached.");
      }}
    }}, 500);
  }}

  if (Number(CFG.max_popups) >= 0) {{
    const maxPopups = Number(CFG.max_popups);
    let opened = 0;
    const originalOpen = window.open ? window.open.bind(window) : null;
    window.open = function(...args) {{
      if (!CFG.allow_popups) {{
        send("error", {{ message: "Popup blocked by admin settings." }});
        return null;
      }}
      if (opened >= maxPopups) {{
        send("error", {{ message: "Popup limit reached." }});
        return null;
      }}
      opened += 1;
      return originalOpen ? originalOpen(...args) : null;
    }};
  }}

  if (Number(CFG.memory_limit_mb) > 0 && performance && performance.memory) {{
    const maxMemory = Number(CFG.memory_limit_mb);
    setInterval(() => {{
      const usedMb = Number(performance.memory.usedJSHeapSize || 0) / (1024 * 1024);
      if (usedMb > maxMemory) {{
        send("limit", {{ message: "Execution time limit reached." }});
        throw new Error("Memory limit reached.");
      }}
    }}, 1000);
  }}

  send("ready", {{ message: "HTML runtime ready." }});
}})();
</script>
""".strip()


@app.post("/api/html-runtime/start")
def start_html_runtime():
    cfg = _load_config()
    if not _cfg_bool(cfg, "html_runtime_enabled", True):
        return jsonify(ok=False, error="HTML runtime is disabled by admin settings."), 403

    user = _require_user_for_files(request)
    if not user:
        return jsonify(ok=False, error="Authentication required"), 401

    data = request.get_json(silent=True) or {}
    file_path = (data.get("file_path") or "").strip()
    if not file_path:
        return jsonify(ok=False, error="file_path is required"), 400

    user_dir = _get_user_dir(user["email"])
    target = _validate_user_path(user_dir, file_path)
    if not target or not target.exists() or not target.is_file():
        return jsonify(ok=False, error="HTML file not found"), 404
    if not _is_html_file(target):
        return jsonify(ok=False, error="Only .html files can use HTML runtime"), 400

    runtime_id = uuid.uuid4().hex
    runtime_dir = SANDBOX_DIR / f"html_runtime_{runtime_id}"
    source_root = user_dir.resolve()
    entry_path = str(target.resolve().relative_to(source_root)).replace("\\", "/")
    runtime_resolved = runtime_dir.resolve()
    sandbox_root = SANDBOX_DIR.resolve()
    if os.path.commonpath([str(runtime_resolved), str(sandbox_root)]) != str(sandbox_root):
        return jsonify(ok=False, error="Invalid runtime directory"), 500
    try:
        shutil.copytree(source_root, runtime_resolved, dirs_exist_ok=True, symlinks=False, ignore_dangling_symlinks=True)
    except Exception:
        _delete_path_quietly(runtime_dir)
        return jsonify(ok=False, error="Could not prepare HTML runtime environment"), 500

    timeout_seconds = _cfg_int(cfg, "html_runtime_timeout_seconds", HTML_RUNTIME_DEFAULT_TIMEOUT, 1, 600)
    session_ttl_seconds = timeout_seconds + 120
    _cleanup_expired_html_runtime_sessions()
    with _html_runtime_lock:
        _html_runtime_sessions[runtime_id] = {
            "runtime_dir": str(runtime_resolved),
            "entry_file": entry_path,
            "expires_at": time.time() + session_ttl_seconds,
        }

    return jsonify(
        ok=True,
        runtime_id=runtime_id,
        view_url=f"/api/html-runtime/view/{runtime_id}/{entry_path}",
        timeout_seconds=timeout_seconds,
        allow_external_internet=_cfg_bool(cfg, "html_runtime_allow_external_internet", False),
        allow_popups=_cfg_bool(cfg, "html_runtime_allow_popups", False),
        allow_navigation=_cfg_bool(cfg, "html_runtime_allow_navigation", False),
        max_fps=_cfg_int(cfg, "html_runtime_max_fps", HTML_RUNTIME_DEFAULT_MAX_FPS, 1, 120),
        memory_limit_mb=_cfg_int(cfg, "html_runtime_memory_limit_mb", HTML_RUNTIME_DEFAULT_MEMORY_MB, 32, 2048),
        max_dom_nodes=_cfg_int(cfg, "html_runtime_max_dom_nodes", HTML_RUNTIME_DEFAULT_MAX_DOM_NODES, 100, 200000),
        max_popups=_cfg_int(cfg, "html_runtime_max_popups", HTML_RUNTIME_DEFAULT_MAX_POPUPS, 0, 20),
    )


@app.post("/api/html-runtime/cleanup")
def cleanup_html_runtime():
    data = request.get_json(silent=True) or {}
    runtime_id = str(data.get("runtime_id") or "").strip()
    if runtime_id:
        _remove_html_runtime_session(runtime_id)
    return jsonify(ok=True)


@app.get("/api/html-runtime/view/<runtime_id>/<path:asset_path>")
def view_html_runtime_asset(runtime_id: str, asset_path: str):
    _cleanup_expired_html_runtime_sessions()
    with _html_runtime_lock:
        session = _html_runtime_sessions.get(runtime_id)
    if not session:
        return jsonify(ok=False, error="Runtime session not found or expired"), 404

    runtime_root = Path(session.get("runtime_dir", ""))
    target = _validate_user_path(runtime_root, asset_path)
    if not target or not target.exists() or not target.is_file():
        return jsonify(ok=False, error="Runtime asset not found"), 404

    ext = target.suffix.lower()
    if ext == ".html":
        cfg = _load_config()
        try:
            html = target.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return jsonify(ok=False, error="Could not load HTML asset"), 500
        bridge = _html_runtime_js_bridge(cfg)
        if "</head>" in html:
            html = html.replace("</head>", bridge + "\n</head>", 1)
        elif re.search(r"<body[^>]*>", html, flags=re.IGNORECASE):
            html = re.sub(r"(<body[^>]*>)", r"\1\n" + bridge + "\n", html, count=1, flags=re.IGNORECASE)
        else:
            html = bridge + "\n" + html
        response = app.response_class(html, mimetype="text/html")
        if not _cfg_bool(cfg, "html_runtime_allow_external_internet", False):
            response.headers["Content-Security-Policy"] = (
                "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; "
                "img-src 'self' data: blob:; "
                "font-src 'self' data:; "
                "connect-src 'self'; "
                "media-src 'self' data: blob:; "
                "frame-src 'self'; "
                "child-src 'self'"
            )
        return response
    return send_file(str(target))

# -------------------------
# Execution sandbox
# -------------------------
class Runner:
    def __init__(self, sid: str):
        self.sid = sid
        self.proc: Optional[subprocess.Popen] = None
        self.thread: Optional[threading.Thread] = None
        self.stop_evt = threading.Event()
        self.started_at = 0.0

    def start(self, code: str, user_dir: Optional[Path] = None, allowed_root: Optional[Path] = None):
        if self.proc:
            self.stop()

        sbox = SANDBOX_DIR / f"pyide_{self.sid}"
        try:
            if sbox.exists():
                for p in sbox.iterdir():
                    try: p.unlink()
                    except Exception: pass
            else:
                sbox.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass

        runner_py = sbox / "runner.py"
        runner_py.write_text(code, encoding="utf-8")

        # Use user_dir as cwd if provided and exists, so relative file paths work
        cwd = str(user_dir) if (user_dir and user_dir.exists()) else str(sbox)

        # Create wrapper script that intercepts input() to send INPUT_TOKEN
        # Escape backslashes in the path for Windows compatibility
        runner_py_escaped = str(runner_py).replace("\\", "\\\\")
        cwd_escaped = cwd.replace("\\", "\\\\")
        allowed_root_dir = str(allowed_root) if (allowed_root and allowed_root.exists()) else cwd
        allowed_root_escaped = allowed_root_dir.replace("\\", "\\\\")

        wrapper_code = f'''import sys
import builtins
import os as _os

# ---- Read user code BEFORE sandbox is applied ----
with open(r"{runner_py_escaped}", "r", encoding="utf-8") as _f:
    _user_code = _f.read()

# ---- Security sandbox ----
_ALLOWED_DIR = _os.path.realpath(r"{allowed_root_escaped}")

# Apply resource limits (POSIX/Linux only – silently ignored elsewhere)
try:
    import resource as _resource
    # Max virtual memory: 256 MB
    _resource.setrlimit(_resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
    # Max open file descriptors
    _resource.setrlimit(_resource.RLIMIT_NOFILE, (64, 64))
except Exception:
    pass

# Restrict open() to the allowed working directory
_real_open = builtins.open
def _safe_open(file, mode="r", *args, **kwargs):
    try:
        p = _os.path.realpath(str(file))
        if _os.path.commonpath([p, _ALLOWED_DIR]) != _ALLOWED_DIR:
            raise PermissionError(f"Access to {{file!r}} is not allowed in this environment")
    except TypeError:
        return _real_open(file, mode, *args, **kwargs)
    except ValueError:
        raise PermissionError(f"Access to {{file!r}} is not allowed in this environment")
    return _real_open(file, mode, *args, **kwargs)
builtins.open = _safe_open

# Block modules that allow network access, process spawning, or privilege escalation
_BLOCKED_MODULES = frozenset([
    "subprocess", "multiprocessing", "socket", "socketserver",
    "ftplib", "http", "urllib", "xmlrpc", "smtplib", "imaplib",
    "poplib", "nntplib", "telnetlib", "ssl", "asyncio",
    "ctypes", "cffi", "mmap",
])
_real_import = builtins.__import__
def _safe_import(name, *args, **kwargs):
    top = name.split(".")[0]
    if top in _BLOCKED_MODULES:
        raise ImportError(f"Module {{name!r}} is not available in this environment")
    return _real_import(name, *args, **kwargs)
builtins.__import__ = _safe_import

# Disable dangerous os-level calls (process spawning / shell execution)
def _blocked_call(*a, **kw):
    raise PermissionError("This operation is not allowed in this environment")
_os.system = _blocked_call
_os.popen  = _blocked_call
for _fn in ("fork", "forkpty", "execv", "execve", "execvp", "execvpe",
            "spawnl", "spawnle", "spawnlp", "spawnlpe",
            "spawnv", "spawnve", "spawnvp", "spawnvpe"):
    if hasattr(_os, _fn):
        setattr(_os, _fn, _blocked_call)
# Block filesystem introspection/mutation helper APIs.
for _fn in ("listdir", "scandir", "walk", "readlink", "remove", "unlink", "rmdir", "removedirs", "rename", "replace"):
    if hasattr(_os, _fn):
        setattr(_os, _fn, _blocked_call)
# ---- End security sandbox ----

def _ide_input(prompt=""):
    if prompt:
        sys.stdout.write(str(prompt))
        sys.stdout.flush()
    sys.stdout.write("{INPUT_TOKEN}\\n")
    sys.stdout.flush()
    # Wait for user input
    line = sys.stdin.readline()
    # Echo back the user's input WITHOUT newline
    # (Frontend will add newline after displaying input inline with prompt)
    user_input = line.rstrip("\\n")
    sys.stdout.write(user_input + "\\n")
    sys.stdout.flush()
    return user_input

builtins.input = _ide_input

# Execute user code
exec(_user_code, {{}})
'''

        self.proc = subprocess.Popen(
            [sys.executable, "-u", "-c", wrapper_code],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=cwd,
            env={"PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"},
            close_fds=True
        )
        self.started_at = time.time()
        self.stop_evt.clear()
        self.thread = threading.Thread(target=self._pump, daemon=True)
        self.thread.start()

        socketio.emit("output", {"data": "[Process started]\n"}, to=self.sid)

    def _pump(self):
        assert self.proc and self.proc.stdout and self.proc.stdin
        stdout = self.proc.stdout
        total_output_bytes = [0]  # mutable container for closure

        # Batch output to avoid overwhelming the browser with rapid socket messages.
        # Lines are collected until BATCH_BYTES is reached or BATCH_SECS has elapsed.
        BATCH_BYTES = 4096
        BATCH_SECS = 0.05  # 50 ms

        def reader():
            buf: list[str] = []
            buf_size = 0
            last_flush = time.time()

            def flush():
                nonlocal buf, buf_size, last_flush
                if buf:
                    try:
                        socketio.emit("output", {"data": "".join(buf)}, to=self.sid)
                    except Exception:
                        pass
                buf = []
                buf_size = 0
                last_flush = time.time()

            while not self.stop_evt.is_set():
                b = stdout.readline()
                if not b:
                    flush()
                    break
                total_output_bytes[0] += len(b)
                if total_output_bytes[0] > MAX_OUTPUT_BYTES:
                    flush()
                    try:
                        self.proc.kill()
                    except Exception:
                        pass
                    try:
                        socketio.emit("output", {"data": "\n[Output limit exceeded (500 KB) -- process killed to protect your browser]\n"}, to=self.sid)
                    except Exception:
                        pass
                    return
                decoded = b.decode("utf-8", errors="replace")
                buf.append(decoded)
                buf_size += len(decoded)  # track decoded character count for batch threshold
                # Immediately flush when an input() prompt token is detected
                # so the user sees the prompt without waiting for the batch timer
                if INPUT_TOKEN in decoded:
                    flush()
                else:
                    now = time.time()
                    if buf_size >= BATCH_BYTES or (now - last_flush) >= BATCH_SECS:
                        flush()
            flush()

        t = threading.Thread(target=reader, daemon=True)
        t.start()

        while self.proc and self.proc.poll() is None and not self.stop_evt.is_set():
            now = time.time()
            if now - self.started_at > MAX_WALL_TIME:
                try: self.proc.kill()
                except Exception: pass
                socketio.emit("output", {"data": "\n[Process killed due to wall-time limit]\n"}, to=self.sid)
                break
            time.sleep(0.05)

        try:
            socketio.emit("finished", {}, to=self.sid)
        except Exception:
            pass

    def send_stdin(self, data: str):
        if self.proc and self.proc.stdin and self.proc.poll() is None:
            try:
                self.proc.stdin.write((data + "\n").encode("utf-8"))
                self.proc.stdin.flush()
                self.started_at = max(self.started_at, time.time() - 1.0)
            except Exception:
                pass

    def stop(self):
        self.stop_evt.set()
        if self.proc and self.proc.poll() is None:
            try: self.proc.terminate()
            except Exception: pass
            try:
                for _ in range(10):
                    if self.proc.poll() is not None: break
                    time.sleep(0.1)
                if self.proc.poll() is None:
                    self.proc.kill()
            except Exception:
                pass
        self.proc = None

_runners: Dict[str, "Runner | JsRunner"] = {}
_runner_lock = threading.Lock()
_socket_sid_info: Dict[str, dict] = {}
_socket_sid_rooms: Dict[str, set] = {}

NODE_EXECUTABLE = shutil.which("node") or "node"

class JsRunner:
    """Runs JavaScript code via Node.js, mirrors the Runner API."""

    def __init__(self, sid: str):
        self.sid = sid
        self.proc: Optional[subprocess.Popen] = None
        self.thread: Optional[threading.Thread] = None
        self.stop_evt = threading.Event()
        self.started_at = 0.0

    def start(self, code: str, user_dir: Optional[Path] = None):
        if self.proc:
            self.stop()

        sbox = SANDBOX_DIR / f"jside_{self.sid}"
        try:
            if sbox.exists():
                for p in sbox.iterdir():
                    try: p.unlink()
                    except Exception: pass
            else:
                sbox.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass

        runner_js = sbox / "runner.js"
        runner_js.write_text(code, encoding="utf-8")

        cwd = str(user_dir) if (user_dir and user_dir.exists()) else str(sbox)

        runner_js_repr = repr(str(runner_js))
        cwd_repr = repr(cwd)

        # Wrapper that provides synchronous input() and executes JS in a locked-down vm context.
        wrapper_code = f"""
const fs = require('fs');
const vm = require('vm');
const INPUT_TOKEN = {repr(INPUT_TOKEN)};

// Synchronous input() — writes prompt + INPUT_TOKEN, then reads a line from stdin.
function input(prompt) {{
  if (prompt !== undefined && prompt !== null) {{
    process.stdout.write(String(prompt));
  }}
  process.stdout.write(INPUT_TOKEN + '\\n');
  // Read from stdin one byte at a time (synchronous).
  const buf = Buffer.alloc(1);
  let line = '';
  while (true) {{
    let bytes = 0;
    try {{ bytes = fs.readSync(0, buf, 0, 1); }} catch (e) {{ break; }}
    if (bytes === 0) break;
    const ch = buf.toString('utf8', 0, 1);
    if (ch === '\\n') break;
    if (ch !== '\\r') line += ch;
  }}
  process.stdout.write(line + '\\n');
  return line;
}}

const safeConsole = Object.freeze({{
  log: (...args) => process.stdout.write(args.map(v => String(v)).join(' ') + '\\n'),
  info: (...args) => process.stdout.write(args.map(v => String(v)).join(' ') + '\\n'),
  warn: (...args) => process.stdout.write(args.map(v => String(v)).join(' ') + '\\n'),
  error: (...args) => process.stderr.write(args.map(v => String(v)).join(' ') + '\\n')
}});

try {{
  const __userCode = fs.readFileSync({runner_js_repr}, 'utf8');
  process.chdir({cwd_repr});
  const sandbox = {{
    console: safeConsole,
    input,
    Math, Date, JSON,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    setTimeout, setInterval, clearTimeout, clearInterval
  }};
  const context = vm.createContext(sandbox, {{ codeGeneration: {{ strings: false, wasm: false }} }});
  const script = new vm.Script(__userCode, {{ filename: 'runner.js' }});
  script.runInContext(context, {{ timeout: {int(MAX_WALL_TIME * 1000)} }});
}} catch (e) {{
  process.stderr.write((e && e.stack) ? e.stack : String(e));
  process.stderr.write('\\n');
  process.exit(1);
}}
"""

        self.proc = subprocess.Popen(
            [NODE_EXECUTABLE, "--max-old-space-size=256", "-e", wrapper_code],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=cwd,
            env={"NODE_DISABLE_COLORS": "1"},
            close_fds=True
        )
        self.started_at = time.time()
        self.stop_evt.clear()
        self.thread = threading.Thread(target=self._pump, daemon=True)
        self.thread.start()

        socketio.emit("output", {"data": "[Process started]\n"}, to=self.sid)

    def _pump(self):
        assert self.proc and self.proc.stdout and self.proc.stdin
        stdout = self.proc.stdout
        total_output_bytes = [0]

        BATCH_BYTES = 4096
        BATCH_SECS = 0.05

        def reader():
            buf: list[str] = []
            buf_size = 0
            last_flush = time.time()

            def flush():
                nonlocal buf, buf_size, last_flush
                if buf:
                    try:
                        socketio.emit("output", {"data": "".join(buf)}, to=self.sid)
                    except Exception:
                        pass
                buf = []
                buf_size = 0
                last_flush = time.time()

            while not self.stop_evt.is_set():
                b = stdout.readline()
                if not b:
                    flush()
                    break
                total_output_bytes[0] += len(b)
                if total_output_bytes[0] > MAX_OUTPUT_BYTES:
                    flush()
                    try:
                        self.proc.kill()
                    except Exception:
                        pass
                    try:
                        socketio.emit("output", {"data": "\n[Output limit exceeded (500 KB) -- process killed to protect your browser]\n"}, to=self.sid)
                    except Exception:
                        pass
                    return
                decoded = b.decode("utf-8", errors="replace")
                buf.append(decoded)
                buf_size += len(decoded)
                if INPUT_TOKEN in decoded:
                    flush()
                else:
                    now = time.time()
                    if buf_size >= BATCH_BYTES or (now - last_flush) >= BATCH_SECS:
                        flush()
            flush()

        t = threading.Thread(target=reader, daemon=True)
        t.start()

        while self.proc and self.proc.poll() is None and not self.stop_evt.is_set():
            now = time.time()
            if now - self.started_at > MAX_WALL_TIME:
                try: self.proc.kill()
                except Exception: pass
                socketio.emit("output", {"data": "\n[Process killed due to wall-time limit]\n"}, to=self.sid)
                break
            time.sleep(0.05)

        try:
            socketio.emit("finished", {}, to=self.sid)
        except Exception:
            pass

    def send_stdin(self, data: str):
        if self.proc and self.proc.stdin and self.proc.poll() is None:
            try:
                self.proc.stdin.write((data + "\n").encode("utf-8"))
                self.proc.stdin.flush()
                self.started_at = max(self.started_at, time.time() - 1.0)
            except Exception:
                pass

    def stop(self):
        self.stop_evt.set()
        if self.proc and self.proc.poll() is None:
            try: self.proc.terminate()
            except Exception: pass
            try:
                for _ in range(10):
                    if self.proc.poll() is not None: break
                    time.sleep(0.1)
                if self.proc.poll() is None:
                    self.proc.kill()
            except Exception:
                pass
        self.proc = None


def _get_runner(sid: str) -> Runner:
    stale_runner = None
    with _runner_lock:
        r = _runners.get(sid)
        if isinstance(r, Runner) and not isinstance(r, JsRunner):
            return r
        stale_runner = r
        r = Runner(sid)
        _runners[sid] = r
    if stale_runner:
        try:
            stale_runner.stop()
        except Exception:
            pass
    return r


def _get_active_runner(sid: str):
    with _runner_lock:
        return _runners.get(sid)


def _pop_runner(sid: str):
    with _runner_lock:
        return _runners.pop(sid, None)


def _get_js_runner(sid: str) -> JsRunner:
    stale_runner = None
    with _runner_lock:
        r = _runners.get(sid)
        if isinstance(r, JsRunner):
            return r
        stale_runner = r
        r = JsRunner(sid)
        _runners[sid] = r
    if stale_runner:
        try:
            stale_runner.stop()
        except Exception:
            pass
    return r

# -------------------------
# Socket.IO handlers
# -------------------------
@socketio.on("connect")
def on_connect():
    _socket_sid_rooms[request.sid] = set()
    emit("connected", {"sid": request.sid})

@socketio.on("disconnect")
def on_disconnect():
    r = _pop_runner(request.sid)
    if r:
        try:
            r.stop()
        except Exception:
            pass
    _socket_sid_info.pop(request.sid, None)
    _socket_sid_rooms.pop(request.sid, None)

@socketio.on("run_code")
def on_run_code(payload):
    payload = payload or {}
    raw_code = payload.get("code", "")
    code = str(raw_code if isinstance(raw_code, str) else "")
    if len(code) > MAX_RUN_CODE_CHARS:
        emit("output", {"data": f"[Run rejected: code exceeds {MAX_RUN_CODE_CHARS} characters]\n"})
        emit("finished", {})
        return
    user_token = (payload or {}).get("user_token", "")
    teacher_token = (payload or {}).get("teacher_token", "")
    admin_token = (payload or {}).get("admin_token", "")
    file_path = (payload or {}).get("file_path", "")  # relative path of the open file
    run_dir = None
    allowed_root_dir = None
    if user_token:
        user_info = _student_tokens.get(user_token)
        if user_info:
            user_root_dir = _get_user_dir(user_info["email"])
            allowed_root_dir = user_root_dir
            # Use the directory containing the open file as CWD so relative
            # file operations in user code work from that folder.
            if file_path:
                file_abs = _validate_user_path(user_root_dir, file_path)
                if file_abs and file_abs.exists():
                    run_dir = file_abs.parent
            if not run_dir:
                run_dir = user_root_dir
    elif teacher_token:
        teacher_info = _teacher_tokens.get(teacher_token)
        if teacher_info:
            teacher_root_dir = _get_user_dir(teacher_info["email"])
            teacher_root_dir.mkdir(parents=True, exist_ok=True)
            allowed_root_dir = teacher_root_dir
            if file_path:
                file_abs = _validate_user_path(teacher_root_dir, file_path)
                if file_abs and file_abs.exists():
                    run_dir = file_abs.parent
            if not run_dir:
                run_dir = teacher_root_dir
    elif admin_token and admin_token in _admin_tokens:
        admin_root_dir = _get_user_dir(ADMIN_ACCOUNT_EMAIL)
        admin_root_dir.mkdir(parents=True, exist_ok=True)
        allowed_root_dir = admin_root_dir
        if file_path:
            file_abs = _validate_user_path(admin_root_dir, file_path)
            if file_abs and file_abs.exists():
                run_dir = file_abs.parent
        if not run_dir:
            run_dir = admin_root_dir

    # Choose the appropriate runner based on language hint or file extension.
    language_hint = _normalize_language_hint(payload.get("language"), file_path)
    is_js = language_hint == "javascript" or (Path(file_path).suffix.lower() == ".js" if file_path else False)
    if is_js:
        r = _get_js_runner(request.sid)
    else:
        r = _get_runner(request.sid)
    try:
        if isinstance(r, JsRunner):
            r.start(code, user_dir=run_dir)
        else:
            r.start(code, user_dir=run_dir, allowed_root=allowed_root_dir)
        emit("run_ack", {"ok": True})
    except Exception as e:
        emit("output", {"data": f"[Error starting process] {e}\n"})
        emit("finished", {})

@socketio.on("send_input")
def on_send_input(payload):
    data = str((payload or {}).get("data", ""))
    if len(data) > MAX_STDIN_CHARS:
        emit("output", {"data": f"[Input rejected: exceeds {MAX_STDIN_CHARS} characters]\n"})
        return
    r = _get_active_runner(request.sid)
    if not r:
        emit("output", {"data": "[Input ignored: no active process]\n"})
        return
    try:
        r.send_stdin(str(data))
    except Exception:
        pass

@socketio.on("stop")
def on_stop(_=None):
    r = _pop_runner(request.sid)
    if r:
        r.stop()
    emit("output", {"data": "\n[Stopped]\n"})
    emit("finished", {})

@socketio.on("teacher_code_update")
def on_teacher_code_update(payload):
    """Broadcast teacher code updates to a class room (admin/teacher only)."""
    token = (payload or {}).get("token", "")
    class_id = str((payload or {}).get("class_id") or "").strip()
    role = str((payload or {}).get("role") or "").strip().lower()
    if not class_id:
        return
    if role == "teacher":
        if token not in _teacher_tokens:
            return
    else:
        if token not in _admin_tokens:
            return
    code = (payload or {}).get("code", "")
    emit("teacher_code", {"code": code, "class_id": class_id}, to=f"class_{class_id}", include_self=False)


@socketio.on("join_class_room")
def on_join_class_room(payload):
    class_id = str((payload or {}).get("class_id") or "").strip()
    role = str((payload or {}).get("role") or "").strip().lower()
    token = str((payload or {}).get("token") or "").strip()
    if not class_id or not token:
        return
    if role == "student":
        student = _student_tokens.get(token)
        if not student:
            return
        student_class = student.get("class_id") or (_find_user(student.get("email", "")) or {}).get("class_id")
        if student_class != class_id:
            return
        _socket_sid_info[request.sid] = {"role": "student", "email": (student.get("email") or "").strip().lower()}
    elif role == "teacher":
        teacher = _teacher_tokens.get(token)
        cls = _find_class_by_id(class_id)
        if not teacher or not cls or (cls.get("teacher_email") or "").lower() != (teacher.get("email") or "").lower():
            return
        _socket_sid_info[request.sid] = {"role": "teacher", "email": (teacher.get("email") or "").strip().lower()}
    elif role == "admin":
        if token not in _admin_tokens:
            return
        _socket_sid_info[request.sid] = {"role": "admin", "email": ADMIN_ACCOUNT_EMAIL.lower()}
    else:
        return
    join_room(f"class_{class_id}")
    _socket_sid_rooms.setdefault(request.sid, set()).add(class_id)


@socketio.on("leave_class_room")
def on_leave_class_room(payload):
    class_id = str((payload or {}).get("class_id") or "").strip()
    if not class_id:
        return
    leave_room(f"class_{class_id}")
    _socket_sid_rooms.setdefault(request.sid, set()).discard(class_id)

# -------------------------
# Assignment system
# -------------------------
_assignment_lock = threading.Lock()

def _get_assignment_path(name: str) -> Path:
    """Get the path to an assignment's JSON file"""
    # Sanitize name to prevent directory traversal
    safe_name = "".join(c for c in name if c.isalnum() or c in (' ', '-', '_')).strip()
    return ASSIGNMENTS_DIR / f"{safe_name}.json"

def _load_assignment(name: str) -> Optional[Dict[str, Any]]:
    """Load an assignment by name"""
    with _assignment_lock:
        path = _get_assignment_path(name)
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"Error loading assignment {name}: {e}")
            return None

def _save_assignment(assignment: Dict[str, Any]) -> bool:
    """Save an assignment"""
    with _assignment_lock:
        name = assignment.get("name", "").strip()
        if not name:
            return False
        path = _get_assignment_path(name)
        try:
            path.write_text(json.dumps(assignment, ensure_ascii=False, indent=2), encoding="utf-8")
            return True
        except Exception as e:
            print(f"Error saving assignment {name}: {e}")
            return False

def _list_assignments() -> list:
    """List all assignments"""
    with _assignment_lock:
        assignments = []
        if not ASSIGNMENTS_DIR.exists():
            return assignments
        for path in ASSIGNMENTS_DIR.iterdir():
            if path.suffix == ".json":
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                    assignments.append(data)
                except Exception as e:
                    print(f"Error loading assignment {path.name}: {e}")
        return sorted(assignments, key=lambda a: a.get("name", ""))

@app.get("/api/assignments")
def get_assignments():
    """Get all assignments"""
    if _require_admin(request):
        return jsonify(ok=False, error="Admins cannot access assignments"), 403
    actor = _assignment_actor(request)
    is_teacher = bool(actor and actor.get("role") == "teacher")
    teacher_email = (actor or {}).get("email", "")
    all_assignments = _list_assignments()
    
    if is_teacher:
        teacher_assignments = [a for a in all_assignments if (a.get("createdByEmail") or "").lower() == teacher_email.lower()]
        return jsonify(ok=True, assignments=teacher_assignments, isAdmin=False, isTeacher=True, canManage=True)

    user = _require_user(request)
    if not user:
        return jsonify(ok=True, assignments=[], isAdmin=False, isTeacher=False, canManage=False)
    class_id = (user or {}).get("class_id")
    if not class_id and user:
        class_id = (_find_user(user.get("email", "")) or {}).get("class_id")
        user["class_id"] = class_id
    if not class_id:
        return jsonify(ok=True, assignments=[], isAdmin=False, isTeacher=False, canManage=False)
    visible_assignments = []
    for a in all_assignments:
        target_class = a.get("targetClassId")
        if not target_class or target_class != class_id:
            continue
        assignment_copy = dict(a)
        assignment_copy.pop("submissions", None)
        visible_assignments.append(assignment_copy)
    return jsonify(ok=True, assignments=visible_assignments, isAdmin=False, isTeacher=False, canManage=False)

@app.post("/api/assignments/create")
def create_assignment():
    """Create a new assignment (teacher only)."""
    actor = _assignment_actor(request)
    if not actor:
        return jsonify(ok=False, error="Teacher token required"), 401
    
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    task = (data.get("task") or "").strip()
    max_score = data.get("maxScore", 100)
    
    if not name:
        return jsonify(ok=False, error="Assignment name required"), 400
    
    # Check if assignment already exists
    if _load_assignment(name):
        return jsonify(ok=False, error="Assignment with this name already exists"), 400
    
    target_class_id = (data.get("classId") or "").strip() or None
    target_class_name = None
    if actor.get("role") == "teacher":
        if not target_class_id:
            return jsonify(ok=False, error="Teachers must select a class"), 400
        teacher_class = _find_class_by_id(target_class_id)
        if not teacher_class or (teacher_class.get("teacher_email") or "").lower() != actor.get("email", "").lower():
            return jsonify(ok=False, error="Invalid class"), 403
        target_class_name = teacher_class.get("name")
    assignment = {
        "name": name,
        "task": task,
        "maxScore": max_score,
        "active": False,
        "quiz": data.get("quiz") or None,
        "targetClassId": target_class_id,
        "targetClassName": target_class_name,
        "createdByEmail": actor.get("email"),
        "createdByRole": actor.get("role"),
        "submissions": []
    }
    
    if _save_assignment(assignment):
        return jsonify(ok=True, assignment=assignment)
    return jsonify(ok=False, error="Failed to save assignment"), 500

@app.post("/api/assignments/update")
def update_assignment():
    """Update an assignment (teacher owner)."""
    actor = _assignment_actor(request)
    if not actor:
        return jsonify(ok=False, error="Teacher token required"), 401
    
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    
    if not name:
        return jsonify(ok=False, error="Assignment name required"), 400
    
    assignment = _load_assignment(name)
    if not assignment:
        return jsonify(ok=False, error="Assignment not found"), 404
    if actor.get("role") == "teacher" and (assignment.get("createdByEmail") or "").lower() != actor.get("email", "").lower():
        return jsonify(ok=False, error="You can only edit your own assignments"), 403
    
    # Update fields
    if "task" in data:
        assignment["task"] = data["task"]
    if "maxScore" in data:
        assignment["maxScore"] = data["maxScore"]
    if "active" in data:
        assignment["active"] = data["active"]
    if "quiz" in data:
        assignment["quiz"] = data["quiz"]
    if "classId" in data:
        class_id = (data.get("classId") or "").strip() or None
        class_name = None
        if actor.get("role") == "teacher":
            if not class_id:
                return jsonify(ok=False, error="Teachers must select a class"), 400
            cls = _find_class_by_id(class_id)
            if not cls or (cls.get("teacher_email") or "").lower() != actor.get("email", "").lower():
                return jsonify(ok=False, error="Invalid class"), 403
            class_name = cls.get("name")
        assignment["targetClassId"] = class_id
        assignment["targetClassName"] = class_name
    
    if _save_assignment(assignment):
        return jsonify(ok=True, assignment=assignment)
    return jsonify(ok=False, error="Failed to save assignment"), 500

@app.post("/api/assignments/delete")
def delete_assignment():
    """Delete an assignment (teacher owner)."""
    actor = _assignment_actor(request)
    if not actor:
        return jsonify(ok=False, error="Teacher token required"), 401
    
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    
    if not name:
        return jsonify(ok=False, error="Assignment name required"), 400
    
    assignment_data = _load_assignment(name)
    if not assignment_data:
        return jsonify(ok=False, error="Assignment not found"), 404
    if actor.get("role") == "teacher" and (assignment_data.get("createdByEmail") or "").lower() != actor.get("email", "").lower():
        return jsonify(ok=False, error="You can only delete your own assignments"), 403

    with _assignment_lock:
        path = _get_assignment_path(name)
        if not path.exists():
            return jsonify(ok=False, error="Assignment not found"), 404
        try:
            path.unlink()
            owner_email = (assignment_data.get("createdByEmail") or "").strip().lower()
            if not owner_email:
                owner_email = (actor.get("email") or "").strip().lower()
            owner_root = _get_user_dir(owner_email)
            owner_assignment_dir = _validate_user_path(owner_root, _sanitize_storage_component(name, fallback="Assignment"))
            if owner_assignment_dir and owner_assignment_dir.exists():
                try:
                    shutil.rmtree(owner_assignment_dir)
                except Exception as cleanup_error:
                    print(f"Warning: failed to remove assignment folder for {name}: {cleanup_error}")
            return jsonify(ok=True)
        except Exception as e:
            print(f"Error deleting assignment {name}: {e}")
            return jsonify(ok=False, error="Failed to delete assignment"), 500

@app.post("/api/assignments/submit")
def submit_assignment():
    """Submit a selected file for an assignment using the logged-in student account."""
    user = _require_user(request)
    if not user:
        return jsonify(ok=False, error="Student login required"), 401

    data = request.get_json(silent=True) or {}
    assignment_name = (data.get("assignmentName") or "").strip()
    file_path = (data.get("filePath") or "").strip()
    quiz_responses = data.get("quizResponses", [])

    if not assignment_name or not file_path:
        return jsonify(ok=False, error="Assignment name and file path required"), 400

    assignment = _load_assignment(assignment_name)
    if not assignment:
        return jsonify(ok=False, error="Assignment not found"), 404
    if not assignment.get("active", False):
        return jsonify(ok=False, error="Assignment is not active"), 403

    student_email = (user.get("email") or "").strip().lower()
    student_name = user.get("name") or student_email
    student_dir = _get_user_dir(student_email)
    source_file = _validate_user_path(student_dir, file_path)
    if not source_file or not source_file.exists() or not source_file.is_file():
        return jsonify(ok=False, error="Selected file not found"), 404

    try:
        original_code = source_file.read_text(encoding="utf-8")
    except Exception:
        return jsonify(ok=False, error="Could not read selected file"), 500

    submissions = assignment.get("submissions", [])
    existing_idx = next((i for i, sub in enumerate(submissions) if sub.get("email", "").lower() == student_email), None)
    previous = submissions[existing_idx] if existing_idx is not None else {}

    submitted_at = _current_timestamp()
    submitted_code = _prepend_submission_timestamp(original_code, submitted_at, student_name)
    target_class_id = assignment.get("targetClassId")
    student_class_id = user.get("class_id") or (_find_user(student_email) or {}).get("class_id")
    if not target_class_id or target_class_id != student_class_id:
        return jsonify(ok=False, error="This assignment is not assigned to your class"), 403

    owner_email = (assignment.get("createdByEmail") or "").strip().lower()
    if not owner_email:
        return jsonify(ok=False, error="Assignment owner not found"), 500
    try:
        admin_file_path = _write_assignment_submission_copy(owner_email, assignment_name, student_name, source_file.name, submitted_code)
    except Exception as exc:
        print(f"Error copying assignment submission for {assignment_name}: {exc}")
        return jsonify(ok=False, error="Could not copy submission to assignment owner workspace"), 500
    submitted_filename = Path(admin_file_path).name

    submission = {
        "name": student_name,
        "email": student_email,
        "sourceFilePath": file_path,
        "submittedFileName": submitted_filename,
        "adminFilePath": admin_file_path,
        "code": submitted_code,
        "submittedAt": submitted_at,
        "codeScore": None,
        "quizResponses": previous.get("quizResponses", []),
        "quizScore": previous.get("quizScore"),
        "totalScore": None,
    }

    if quiz_responses and assignment.get("quiz"):
        quiz = assignment["quiz"]
        quiz_score = 0
        for response in quiz_responses:
            question_id = response.get("questionId")
            question = next((q for q in quiz.get("questions", []) if q.get("id") == question_id), None)
            if not question:
                continue
            if question.get("type") == "multiple_choice":
                if response.get("answer") == question.get("correctAnswer"):
                    response["isCorrect"] = True
                    response["pointsEarned"] = question.get("points", 0)
                    quiz_score += question.get("points", 0)
                else:
                    response["isCorrect"] = False
                    response["pointsEarned"] = 0
            else:
                response["pointsEarned"] = 0
                response["aiScore"] = None
                response["manualScore"] = None
        submission["quizResponses"] = quiz_responses
        submission["quizScore"] = quiz_score

    code_score_value = submission.get("codeScore") if submission.get("codeScore") is not None else 0
    quiz_score_value = submission.get("quizScore") if submission.get("quizScore") is not None else 0
    has_any_score = submission.get("codeScore") is not None or submission.get("quizScore") is not None
    submission["totalScore"] = code_score_value + quiz_score_value if has_any_score else None

    if existing_idx is not None:
        submissions[existing_idx] = submission
    else:
        submissions.append(submission)

    assignment["submissions"] = submissions
    if _save_assignment(assignment):
        return jsonify(ok=True, message="Submission saved successfully", submission=submission)
    return jsonify(ok=False, error="Failed to save submission"), 500

@app.post("/api/assignments/score")
def score_submission():
    """Set a score for a student submission (assignment owner teacher only)."""
    actor = _assignment_actor(request)
    if not actor:
        return jsonify(ok=False, error="Teacher token required"), 401
    
    data = request.get_json(silent=True) or {}
    assignment_name = (data.get("assignmentName") or "").strip()
    student_email = (data.get("studentEmail") or "").strip()
    score = data.get("score")  # This is now the code score
    
    if not assignment_name or not student_email:
        return jsonify(ok=False, error="Assignment name and email required"), 400
    
    assignment = _load_assignment(assignment_name)
    if not assignment:
        return jsonify(ok=False, error="Assignment not found"), 404
    if actor.get("role") == "teacher" and (assignment.get("createdByEmail") or "").lower() != actor.get("email", "").lower():
        return jsonify(ok=False, error="You can only score your own assignments"), 403
    
    submissions = assignment.get("submissions", [])
    found = False
    for sub in submissions:
        if sub.get("email", "").lower() == student_email.lower():
            # Handle both old "score" field and new "codeScore" field
            if "codeScore" in sub or "quizScore" in sub:
                sub["codeScore"] = score
                # Recalculate total score
                code_score = sub.get("codeScore") or 0
                quiz_score = sub.get("quizScore") or 0
                sub["totalScore"] = code_score + quiz_score if (sub.get("codeScore") is not None or sub.get("quizScore") is not None) else None
            else:
                # Backward compatibility - old format
                sub["score"] = score
            found = True
            break
    
    if not found:
        return jsonify(ok=False, error="Submission not found"), 404
    
    if _save_assignment(assignment):
        return jsonify(ok=True)
    return jsonify(ok=False, error="Failed to save score"), 500

@app.post("/api/assignments/grade-ai")
def grade_assignment_ai():
    """Grade a student submission using AI (assignment owner teacher only)."""
    actor = _assignment_actor(request)
    if not actor:
        return jsonify(ok=False, error="Teacher token required"), 401
    
    cfg = _load_config()
    allowed, error = _effective_ai_enabled(request, request.get_json(silent=True) or {})
    if not allowed:
        return jsonify(ok=False, error=error or "AI unavailable"), 403
    
    data = request.get_json(silent=True) or {}
    assignment_name = (data.get("assignmentName") or "").strip()
    student_email = (data.get("studentEmail") or "").strip()
    code = data.get("code", "")
    task = data.get("task", "")
    max_score = data.get("maxScore", 100)
    file_name = (data.get("fileName") or data.get("file_name") or "").strip()
    language = _normalize_language_hint(data.get("language"), file_name)
    language_label = _language_label(language)
    
    if not assignment_name or not student_email or not code or not task:
        return jsonify(ok=False, error="Missing required fields"), 400
    
    # Validate and sanitize inputs
    if len(code) > 100000:  # Limit code to 100KB
        return jsonify(ok=False, error="Code is too long"), 400
    if len(task) > 10000:  # Limit task description to 10KB
        return jsonify(ok=False, error="Task description is too long"), 400
    
    # Build prompt for AI grading
    prompt = (
        "Grade the following student's {language} code submission strictly from 0 to {max_score}.\n"
        "Return ONLY the integer score, with no additional words or explanation.\n\n"
        "Assignment Task:\n{task}\n\n"
        "Student Code:\n{code}\n\n"
        "Grading Criteria:\n"
        "- Does the code solve the problem correctly?\n"
        "- Is the code efficient and well-structured?\n"
        "- Are there any errors or bugs?\n"
        "- {best_practices}\n\n"
        "Score (0-{max_score}):"
    ).format(
        language=language_label,
        best_practices=_language_best_practices(language),
        max_score=max_score,
        task=task,
        code=code,
    )
    
    res = call_ollama_generate(cfg.get("ai_ollama_url", ""), cfg.get("ai_model", "gemma3:4b"), prompt, timeout=30.0)
    if not res.get("ok"):
        return jsonify(ok=False, error=res.get("error", "AI error"))
    
    raw = (res.get("text") or "").strip()
    
    # Extract score from AI response
    score = None
    # Look for first positive integer in the response
    for tok in raw.split():
        tok = tok.strip('.,!?;:')  # Remove punctuation
        if tok.isdigit():
            score = int(tok)
            break
    
    # Fallback: extract all digits as a number
    if score is None:
        digits = "".join([c for c in raw if c.isdigit()])
        if digits:
            score = int(digits)
    
    if score is None:
        return jsonify(ok=False, error=f"AI returned invalid score: {raw!r}")
    
    # Ensure score is within valid range
    score = max(0, min(max_score, score))
    
    # Save the score
    assignment = _load_assignment(assignment_name)
    if not assignment:
        return jsonify(ok=False, error="Assignment not found"), 404
    if actor.get("role") == "teacher" and (assignment.get("createdByEmail") or "").lower() != actor.get("email", "").lower():
        return jsonify(ok=False, error="You can only grade your own assignments"), 403
    
    submissions = assignment.get("submissions", [])
    found = False
    for sub in submissions:
        if sub.get("email", "").lower() == student_email.lower():
            # Handle both old and new format
            if "codeScore" in sub or "quizScore" in sub:
                sub["codeScore"] = score
                # Recalculate total score
                code_score = sub.get("codeScore") or 0
                quiz_score = sub.get("quizScore") or 0
                sub["totalScore"] = code_score + quiz_score if (sub.get("codeScore") is not None or sub.get("quizScore") is not None) else None
            else:
                # Backward compatibility
                sub["score"] = score
            found = True
            break
    
    if not found:
        return jsonify(ok=False, error="Submission not found"), 404
    
    if _save_assignment(assignment):
        return jsonify(ok=True, score=score)
    return jsonify(ok=False, error="Failed to save score"), 500

@app.get("/api/assignments/<assignment_name>/csv")
def download_assignment_csv(assignment_name: str):
    """Download CSV of student scores (assignment owner teacher only)."""
    actor = _assignment_actor(request)
    if not actor:
        return jsonify(ok=False, error="Teacher token required"), 401
    
    assignment = _load_assignment(assignment_name)
    if not assignment:
        return jsonify(ok=False, error="Assignment not found"), 404
    if actor.get("role") == "teacher" and (assignment.get("createdByEmail") or "").lower() != actor.get("email", "").lower():
        return jsonify(ok=False, error="You can only export your own assignments"), 403
    
    from flask import Response
    import io
    
    output = io.StringIO()
    writer = csv.writer(output)
    
    # Check if we have new-style submissions with separate scores
    submissions = assignment.get("submissions", [])
    has_new_format = any("codeScore" in sub or "quizScore" in sub for sub in submissions)
    
    if has_new_format:
        writer.writerow(["Name", "Email", "Submitted File", "Assignment", "Code Score", "Quiz Score", "Total Score", "Submission Date"])
        for sub in _sorted_assignment_submissions(submissions):
            writer.writerow([
                sub.get("name", ""),
                sub.get("email", ""),
                sub.get("submittedFileName", ""),
                assignment_name,
                sub.get("codeScore", ""),
                sub.get("quizScore", ""),
                sub.get("totalScore", ""),
                sub.get("submittedAt", "")
            ])
    else:
        # Old format - backward compatibility
        writer.writerow(["Student Number", "Score"])
        for sub in submissions:
            email = sub.get("email", "")
            student_num = email.split("@")[0] if "@" in email else email
            score = sub.get("score", "")
            writer.writerow([student_num, score])
    
    output.seek(0)
    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment;filename={assignment_name}_scores.csv"}
    )

@app.post("/api/assignments/student-scores")
def get_student_scores():
    """Get scores for the logged-in student."""
    user = _require_user(request)
    email = (user or {}).get("email", "")
    if not email:
        return jsonify(ok=False, error="Authentication required"), 401

    all_assignments = _list_assignments()
    class_id = (_find_user(email) or {}).get("class_id") if email else None
    if not class_id:
        return jsonify(ok=True, scores=[])
    student_scores = []
    for assignment in all_assignments:
        target_class_id = assignment.get("targetClassId")
        if not target_class_id or target_class_id != class_id:
            continue
        submissions = assignment.get("submissions", [])
        for sub in submissions:
            if sub.get("email", "").lower() != email:
                continue
            if "codeScore" in sub or "quizScore" in sub:
                student_scores.append({
                    "assignmentName": assignment.get("name", ""),
                    "maxScore": assignment.get("maxScore", 100),
                    "codeScore": sub.get("codeScore"),
                    "quizScore": sub.get("quizScore"),
                    "totalScore": sub.get("totalScore"),
                    "submittedAt": sub.get("submittedAt", ""),
                    "submittedFileName": sub.get("submittedFileName", ""),
                    "active": assignment.get("active", False)
                })
            else:
                student_scores.append({
                    "assignmentName": assignment.get("name", ""),
                    "maxScore": assignment.get("maxScore", 100),
                    "score": sub.get("score"),
                    "submittedAt": sub.get("submittedAt", ""),
                    "active": assignment.get("active", False)
                })
            break

    student_scores.sort(key=lambda item: (not item.get("active", False), item.get("assignmentName", "").lower()))
    return jsonify(ok=True, scores=student_scores)

@app.get("/api/quiz/<assignment_name>")
def get_quiz(assignment_name: str):
    """Get quiz for a specific assignment"""
    assignment = _load_assignment(assignment_name)
    if not assignment:
        return jsonify(ok=False, error="Assignment not found"), 404
    
    quiz = assignment.get("quiz")
    if not quiz:
        return jsonify(ok=False, error="No quiz for this assignment"), 404
    
    user = _require_user(request)
    if not user:
        return jsonify(ok=False, error="Student login required"), 401
    class_id = (user or {}).get("class_id") or (_find_user((user or {}).get("email", "")) or {}).get("class_id")
    target_class_id = assignment.get("targetClassId")
    if not target_class_id or target_class_id != class_id:
        return jsonify(ok=False, error="Quiz not assigned to your class"), 403
    # Remove correct answers from multiple choice questions for students
    import copy
    quiz_copy = copy.deepcopy(quiz)
    for question in quiz_copy.get("questions", []):
        if question.get("type") == "multiple_choice":
            question.pop("correctAnswer", None)
    return jsonify(ok=True, quiz=quiz_copy)

@app.post("/api/quiz/submit")
def submit_quiz():
    """Submit quiz responses using the logged-in student account."""
    user = _require_user(request)
    if not user:
        return jsonify(ok=False, error="Student login required"), 401

    data = request.get_json(silent=True) or {}
    assignment_name = (data.get("assignmentName") or "").strip()
    quiz_responses = data.get("quizResponses", [])
    student_email = (user.get("email") or "").strip().lower()
    student_name = user.get("name") or student_email

    if not assignment_name:
        return jsonify(ok=False, error="Assignment name required"), 400

    assignment = _load_assignment(assignment_name)
    if not assignment:
        return jsonify(ok=False, error="Assignment not found"), 404
    if not assignment.get("active", False):
        return jsonify(ok=False, error="Assignment is not active"), 403
    target_class_id = assignment.get("targetClassId")
    student_class_id = (user.get("class_id") or (_find_user(student_email) or {}).get("class_id"))
    if not target_class_id or target_class_id != student_class_id:
        return jsonify(ok=False, error="Quiz not assigned to your class"), 403

    quiz = assignment.get("quiz")
    if not quiz:
        return jsonify(ok=False, error="No quiz for this assignment"), 404

    quiz_score = 0
    for response in quiz_responses:
        question_id = response.get("questionId")
        question = next((q for q in quiz.get("questions", []) if q.get("id") == question_id), None)
        if not question:
            continue
        if question.get("type") == "multiple_choice":
            if response.get("answer") == question.get("correctAnswer"):
                response["isCorrect"] = True
                response["pointsEarned"] = question.get("points", 0)
                quiz_score += question.get("points", 0)
            else:
                response["isCorrect"] = False
                response["pointsEarned"] = 0
        else:
            response["pointsEarned"] = 0
            response["aiScore"] = None
            response["manualScore"] = None

    submissions = assignment.get("submissions", [])
    existing_idx = None
    for i, sub in enumerate(submissions):
        if sub.get("email", "").lower() == student_email:
            existing_idx = i
            break

    if existing_idx is not None:
        existing = submissions[existing_idx]
        existing["name"] = student_name
        existing["email"] = student_email
        existing["quizResponses"] = quiz_responses
        existing["quizScore"] = quiz_score
        code_score = existing.get("codeScore") or 0
        existing["totalScore"] = code_score + quiz_score if existing.get("codeScore") is not None else quiz_score
        existing["submittedAt"] = existing.get("submittedAt") or _current_timestamp()
    else:
        submissions.append({
            "name": student_name,
            "email": student_email,
            "code": "",
            "sourceFilePath": "",
            "submittedFileName": "",
            "adminFilePath": "",
            "submittedAt": _current_timestamp(),
            "codeScore": None,
            "quizResponses": quiz_responses,
            "quizScore": quiz_score,
            "totalScore": quiz_score,
        })

    assignment["submissions"] = submissions
    if _save_assignment(assignment):
        return jsonify(ok=True, message="Quiz submitted successfully", quizScore=quiz_score)
    return jsonify(ok=False, error="Failed to save quiz submission"), 500

@app.post("/api/quiz/grade-written")
def grade_written_response():
    """Grade a written response using AI (assignment owner teacher only)."""
    actor = _assignment_actor(request)
    if not actor:
        return jsonify(ok=False, error="Teacher token required"), 401
    
    cfg = _load_config()
    allowed, error = _effective_ai_enabled(request, request.get_json(silent=True) or {})
    if not allowed:
        return jsonify(ok=False, error=error or "AI unavailable"), 403
    
    data = request.get_json(silent=True) or {}
    assignment_name = (data.get("assignmentName") or "").strip()
    student_email = (data.get("studentEmail") or "").strip()
    question_id = (data.get("questionId") or "").strip()
    answer = data.get("answer", "")
    question_text = data.get("questionText", "")
    max_points = data.get("maxPoints", 10)
    
    if not assignment_name or not student_email or not question_id:
        return jsonify(ok=False, error="Missing required fields"), 400
    
    # Build prompt for AI grading
    prompt = (
        f"Grade the following student's written response to a question strictly from 0 to {max_points}.\n"
        f"Return ONLY the integer score, with no additional words or explanation.\n\n"
        f"Question: {question_text}\n\n"
        f"Student Answer: {answer}\n\n"
        f"Grading Criteria:\n"
        f"- Is the answer accurate and complete?\n"
        f"- Does it demonstrate understanding of the concept?\n"
        f"- Is it well-explained?\n\n"
        f"Score (0-{max_points}):"
    )
    
    res = call_ollama_generate(cfg.get("ai_ollama_url", ""), cfg.get("ai_model", "gemma3:4b"), prompt, timeout=30.0)
    if not res.get("ok"):
        return jsonify(ok=False, error=res.get("error", "AI error"))
    
    raw = (res.get("text") or "").strip()
    
    # Extract score from AI response using multiple strategies
    score = None
    
    # Strategy 1: Look for standalone integer
    import re
    matches = re.findall(r'\b(\d+)\b', raw)
    if matches:
        score = int(matches[0])
    
    # Strategy 2: Look for "X/Y" or "X out of Y" patterns
    if score is None:
        fraction_match = re.search(r'(\d+)\s*[/out of]+\s*\d+', raw, re.IGNORECASE)
        if fraction_match:
            score = int(fraction_match.group(1))
    
    # Strategy 3: Extract first number with decimal point and round
    if score is None:
        decimal_match = re.search(r'(\d+\.?\d*)', raw)
        if decimal_match:
            score = round(float(decimal_match.group(1)))
    
    if score is None:
        return jsonify(ok=False, error=f"AI returned invalid score: {raw!r}")
    
    # Ensure score is within valid range
    score = max(0, min(max_points, score))
    
    # Update the submission
    assignment = _load_assignment(assignment_name)
    if not assignment:
        return jsonify(ok=False, error="Assignment not found"), 404
    if actor.get("role") == "teacher" and (assignment.get("createdByEmail") or "").lower() != actor.get("email", "").lower():
        return jsonify(ok=False, error="You can only grade your own assignments"), 403
    
    submissions = assignment.get("submissions", [])
    found = False
    for sub in submissions:
        if sub.get("email", "").lower() == student_email.lower():
            quiz_responses = sub.get("quizResponses", [])
            for response in quiz_responses:
                if response.get("questionId") == question_id:
                    response["aiScore"] = score
                    # If no manual override, use AI score
                    if response.get("manualScore") is None:
                        response["pointsEarned"] = score
                    found = True
                    break
            if found:
                # Recalculate quiz score
                quiz_score = sum(r.get("pointsEarned", 0) for r in quiz_responses)
                sub["quizScore"] = quiz_score
                # Recalculate total score
                code_score = sub.get("codeScore") or 0
                sub["totalScore"] = code_score + quiz_score if sub.get("codeScore") is not None else quiz_score
                break
    
    if not found:
        return jsonify(ok=False, error="Submission or question not found"), 404
    
    if _save_assignment(assignment):
        return jsonify(ok=True, aiScore=score)
    return jsonify(ok=False, error="Failed to save score"), 500

@app.post("/api/quiz/override-score")
def override_quiz_score():
    """Override quiz question score manually (assignment owner teacher only)."""
    actor = _assignment_actor(request)
    if not actor:
        return jsonify(ok=False, error="Teacher token required"), 401
    
    data = request.get_json(silent=True) or {}
    assignment_name = (data.get("assignmentName") or "").strip()
    student_email = (data.get("studentEmail") or "").strip()
    question_id = (data.get("questionId") or "").strip()
    manual_score = data.get("manualScore")
    
    if not assignment_name or not student_email or not question_id:
        return jsonify(ok=False, error="Missing required fields"), 400
    
    assignment = _load_assignment(assignment_name)
    if not assignment:
        return jsonify(ok=False, error="Assignment not found"), 404
    if actor.get("role") == "teacher" and (assignment.get("createdByEmail") or "").lower() != actor.get("email", "").lower():
        return jsonify(ok=False, error="You can only edit scores for your own assignments"), 403
    
    submissions = assignment.get("submissions", [])
    found = False
    for sub in submissions:
        if sub.get("email", "").lower() == student_email.lower():
            quiz_responses = sub.get("quizResponses", [])
            for response in quiz_responses:
                if response.get("questionId") == question_id:
                    response["manualScore"] = manual_score
                    # Manual score takes precedence
                    if manual_score is not None:
                        response["pointsEarned"] = manual_score
                    elif response.get("aiScore") is not None:
                        response["pointsEarned"] = response["aiScore"]
                    found = True
                    break
            if found:
                # Recalculate quiz score
                quiz_score = sum(r.get("pointsEarned", 0) for r in quiz_responses)
                sub["quizScore"] = quiz_score
                # Recalculate total score
                code_score = sub.get("codeScore") or 0
                sub["totalScore"] = code_score + quiz_score if sub.get("codeScore") is not None else quiz_score
                break
    
    if not found:
        return jsonify(ok=False, error="Submission or question not found"), 404
    
    if _save_assignment(assignment):
        return jsonify(ok=True)
    return jsonify(ok=False, error="Failed to save score"), 500

# -------------------------
# Admin server health
# -------------------------
@app.get("/api/admin/server-health")
def admin_server_health():
    if not _require_admin(request):
        return jsonify(ok=False, error="Admin token required"), 401
    now = time.time()
    uptime_seconds = max(0, int(now - SERVER_START_EPOCH))
    disk = shutil.disk_usage(BASE_DIR)
    mem_total, mem_used = _parse_meminfo_bytes()
    mem_percent = round((mem_used / mem_total) * 100, 1) if mem_total > 0 else 0.0
    disk_percent = round((disk.used / disk.total) * 100, 1) if disk.total > 0 else 0.0
    with _server_health_lock:
        event_feed = _read_json_list_file(SERVER_EVENTS_FILE)[-100:]
    event_feed = sorted(event_feed, key=lambda e: int(e.get("ts", 0)), reverse=True)
    return jsonify(
        ok=True,
        data={
            "uptime_seconds": uptime_seconds,
            "started_at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(SERVER_START_EPOCH)),
            "cpu_percent": _estimate_cpu_percent(),
            "cpu_cores": int(os.cpu_count() or 1),
            "memory": {
                "total_bytes": mem_total,
                "used_bytes": mem_used,
                "percent": mem_percent,
            },
            "storage": {
                "total_bytes": disk.total,
                "used_bytes": disk.used,
                "free_bytes": disk.free,
                "percent": disk_percent,
            },
            "sign_ins": {
                "last_24_hours": _count_sign_ins(24 * 3600),
                "last_7_days": _count_sign_ins(7 * 24 * 3600),
                "last_30_days": _count_sign_ins(30 * 24 * 3600),
            },
            "alerts": event_feed,
            "server_log_tail": _read_server_log_tail(250),
        },
    )

# -------------------------
# Health
# -------------------------
@app.get("/health")
def health():
    return jsonify(ok=True)

# -------------------------
# Main
# -------------------------
if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", str(SERVER_PORT)))
    _record_server_startup_event()
    print(f"Async mode: {socketio.async_mode}", flush=True)
    print(f"EagleIDE server starting on http://{host}:{port}", flush=True)
    print("Press Ctrl+C to stop.", flush=True)
    _append_server_log(f"Server listening on http://{host}:{port} (async={socketio.async_mode})", "INFO")
    _cleanup_all_user_files()
    try:
        socketio.run(app, host=host, port=port, debug=False)
    except (KeyboardInterrupt, SystemExit):
        pass
    print("Server stopped.")
