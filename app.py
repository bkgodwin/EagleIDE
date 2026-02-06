#!/usr/bin/env python3
import os, sys, json, time, uuid, csv, random, threading, subprocess
from pathlib import Path
from typing import Dict, Any, Optional

from flask import Flask, send_from_directory, request, jsonify
from flask_socketio import SocketIO, emit
import requests

# -------------------------
# Paths & constants
# -------------------------
BASE_DIR = Path(__file__).resolve().parent
PERSIST_FILE = BASE_DIR / "config.txt"        # persisted settings (JSON)
CHALLENGE_CSV = BASE_DIR / "challenges.csv"   # optional challenge bank
LEADERBOARD_CSV = BASE_DIR / "leaderboard.csv"
SANDBOX_DIR = BASE_DIR / "sandboxes"
ASSIGNMENTS_DIR = BASE_DIR / "assignments"

INPUT_TOKEN = "[[_IDE_INPUT_]]"
MAX_WALL_TIME = 30.0       # seconds (hard kill for user code)
IDLE_TIMEOUT = 10.0        # reserved, if you later want idle detection

os.makedirs(SANDBOX_DIR, exist_ok=True)
os.makedirs(ASSIGNMENTS_DIR, exist_ok=True)

# -------------------------
# Defaults from config.py
# -------------------------
try:
    from config import DEFAULT_CONFIG, DEFAULT_ADMIN_PASSWORD
except Exception:
    DEFAULT_ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "password")
    DEFAULT_CONFIG = {
        "notes_html": "<h2>Welcome</h2><p>Edit me in Admin.</p>",
        "lesson_url": "https://publish.obsidian.md/mrgodwinsclassroom/Coding/Coding+1/2.+Python+Basics/1.+What+Is+Python",
        "lesson_use_local": False,
        "lesson_html": "<p>(No local lesson yet)</p>",
        "ai_explainer_enabled": True,
        "ai_ollama_url": "http://127.0.0.1:11434",
        "ai_model": "gemma3:4b",
        "ai_assistant_preprompt": (
            "You are a helpful Python tutor for high-school students. "
            "Only answer questions about programming and debugging code. "
            "Keep explanations short, accurate, and step-by-step. If a question is not about coding, "
            "politely decline and redirect to Python topics."
        ),
    }

# -------------------------
# App & Socket
# -------------------------
app = Flask(__name__, static_folder=None)
socketio = SocketIO(
    app,
    async_mode="threading",             # LXC/containers friendly
    cors_allowed_origins="*",
    logger=False,
    engineio_logger=False
)

# -------------------------
# Config load/save
# -------------------------
_cfg_lock = threading.Lock()
_admin_tokens = set()   # ephemeral, cleared on restart

def _load_config() -> Dict[str, Any]:
    with _cfg_lock:
        if PERSIST_FILE.exists():
            try:
                return json.loads(PERSIST_FILE.read_text(encoding="utf-8"))
            except Exception as e:
                print(f"Warning: Failed to load config from {PERSIST_FILE}: {e}")
                print("Creating default config...")
    # Call _save_config OUTSIDE the lock context
    _save_config(DEFAULT_CONFIG)
    return DEFAULT_CONFIG.copy()

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

def _require_admin(req) -> bool:
    token = req.headers.get("X-Admin-Token", "").strip()
    return token in _admin_tokens

# -------------------------
# Admin & Config routes
# -------------------------
@app.post("/api/admin/login")
def admin_login():
    data = request.get_json(silent=True) or {}
    pw = str(data.get("password", ""))
    if pw == DEFAULT_ADMIN_PASSWORD:
        token = uuid.uuid4().hex
        _admin_tokens.add(token)
        return jsonify(ok=True, token=token)
    return jsonify(ok=False, error="Invalid password"), 401

@app.get("/api/config")
def get_config():
    return jsonify(ok=True, data=_load_config())

@app.post("/api/config/save")
def save_config():
    if not _require_admin(request):
        return jsonify(ok=False, error="Admin token required"), 401
    data = request.get_json(silent=True) or {}
    partial = data.get("data", {})
    new_cfg = _update_config(partial)
    return jsonify(ok=True, data=new_cfg)

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

# -------------------------
# Explain endpoint
# -------------------------
@app.post("/api/explain")
def api_explain():
    cfg = _load_config()
    if not cfg.get("ai_explainer_enabled", False):
        return jsonify(ok=False, error="AI features disabled by admin"), 403

    data = request.get_json(silent=True) or {}
    code = data.get("code", "")
    if not code:
        return jsonify(ok=False, error="No code provided"), 400

    pretext = (
        "Explain the following Python code in 2-3 concise sentences. "
        "If there are any errors or issues, identify them and suggest how to fix them. "
        "Keep your response brief and focused:\n\n"
    )
    res = call_ollama_generate(cfg.get("ai_ollama_url", ""), cfg.get("ai_model", "gemma3:4b"), pretext + code)
    if not res.get("ok"):
        return jsonify(ok=False, error=res.get("error", "AI error"))
    return jsonify(ok=True, text=res.get("text", ""), cooldown=random.randint(30, 90))

# -------------------------
# Challenge system (CSV)
# -------------------------
_lb_lock = threading.Lock()

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
    return jsonify(ok=True, difficulty=ch["difficulty"], points=ch["points"], challenge=ch["text"])

@app.post("/api/challenge/score")
def challenge_score():
    cfg = _load_config()
    if not cfg.get("ai_explainer_enabled", False):
        return jsonify(ok=False, error="AI features disabled by admin"), 403

    data = request.get_json(silent=True) or {}
    code = data.get("code", "")
    challenge_text = data.get("challenge", "")
    points = int(data.get("points", 3))
    if not code or not challenge_text:
        return jsonify(ok=False, error="Missing code or challenge"), 400

    prompt = (
        "Grade the student's Python solution strictly from 0 to {max_points}.\n"
        "Return ONLY the integer number, with no words.\n\n"
        "Challenge:\n{challenge}\n\n"
        "Student code:\n{code}\n"
    ).format(max_points=points, challenge=challenge_text, code=code)

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
    return jsonify(ok=True, score=score, max=points)

@app.post("/api/challenge/submit")
def challenge_submit():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    try:
        score = int(data.get("score", 0))
    except Exception:
        score = 0
    if not name:
        return jsonify(ok=False, error="Name required"), 400
    if score <= 0:
        return jsonify(ok=False, error="Non-positive score"), 400

    with _lb_lock:
        scores: Dict[str, int] = {}
        if LEADERBOARD_CSV.exists():
            with LEADERBOARD_CSV.open("r", newline="", encoding="utf-8") as f:
                rd = csv.reader(f)
                for r in rd:
                    if len(r) >= 2:
                        try:
                            scores[r[0]] = int(r[1])
                        except Exception:
                            pass
        scores[name] = scores.get(name, 0) + score
        with LEADERBOARD_CSV.open("w", newline="", encoding="utf-8") as f:
            wr = csv.writer(f)
            for k, v in scores.items():
                wr.writerow([k, v])

        top = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[:10]
        return jsonify(ok=True, top=[{"name": k, "score": v} for k, v in top])

@app.get("/api/challenge/leaderboard")
def challenge_leaderboard():
    with _lb_lock:
        scores = []
        if LEADERBOARD_CSV.exists():
            with LEADERBOARD_CSV.open("r", newline="", encoding="utf-8") as f:
                rd = csv.reader(f)
                for r in rd:
                    if len(r) >= 2:
                        try:
                            scores.append((r[0], int(r[1])))
                        except Exception:
                            pass
        top = sorted(scores, key=lambda kv: kv[1], reverse=True)[:10]
        return jsonify(ok=True, top=[{"name": k, "score": v} for k, v in top])

# -------------------------
# NEW: AI Assistant chat (15s cooldown per client SID)
# -------------------------
_ASSISTANT_LAST: Dict[str, float] = {}
ASSISTANT_COOLDOWN = 15  # seconds

@app.post("/api/assistant/chat")
def assistant_chat():
    cfg = _load_config()
    if not cfg.get("ai_explainer_enabled", False):
        return jsonify(ok=False, error="AI features disabled by admin"), 403

    data = request.get_json(silent=True) or {}
    sid = (request.headers.get("X-SID") or data.get("sid") or "").strip()
    msgs = data.get("messages", [])  # [{role: 'user'|'assistant', content: '...'}, ...]

    if not sid:
        return jsonify(ok=False, error="Missing SID"), 400
    if not isinstance(msgs, list) or not msgs:
        return jsonify(ok=False, error="No messages"), 400

    now = time.time()
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
    prompt = preprompt + "\n\n" + "\n".join(transcript_lines) + "\n\nAssistant:"

    res = call_ollama_generate(cfg.get("ai_ollama_url", ""), cfg.get("ai_model", "gemma3:4b"), prompt)
    if not res.get("ok"):
        return jsonify(ok=False, error=res.get("error", "AI error"))

    _ASSISTANT_LAST[sid] = time.time()
    return jsonify(ok=True, reply=(res.get("text") or "").strip(), cooldown=ASSISTANT_COOLDOWN)

# -------------------------
# Minimal static index.html
# -------------------------
@app.get("/")
def root():
    return send_from_directory(BASE_DIR, "index.html")

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

    def start(self, code: str):
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

        # Create wrapper script that intercepts input() to send INPUT_TOKEN
        # Escape backslashes in the path for Windows compatibility
        runner_py_escaped = str(runner_py).replace("\\", "\\\\")
        
        wrapper_code = f'''import sys
import builtins

def _ide_input(prompt=""):
    if prompt:
        sys.stdout.write(str(prompt))
        sys.stdout.flush()
    sys.stdout.write("{INPUT_TOKEN}\\n")
    sys.stdout.flush()
    # Wait for user input
    line = sys.stdin.readline()
    # Echo back the user's input (without newline) on same line
    user_input = line.rstrip("\\n")
    sys.stdout.write(user_input + "\\n")
    sys.stdout.flush()
    return user_input

builtins.input = _ide_input

# Execute user code
exec(open(r"{runner_py_escaped}", "r", encoding="utf-8").read(), {{}})
'''

        self.proc = subprocess.Popen(
            [sys.executable, "-u", "-c", wrapper_code],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=str(sbox)
        )
        self.started_at = time.time()
        self.stop_evt.clear()
        self.thread = threading.Thread(target=self._pump, daemon=True)
        self.thread.start()

        socketio.emit("output", {"data": "[Process started]\n"}, to=self.sid)

    def _pump(self):
        assert self.proc and self.proc.stdout and self.proc.stdin
        stdout = self.proc.stdout

        def reader():
            while not self.stop_evt.is_set():
                b = stdout.readline()
                if not b:
                    break
                try:
                    socketio.emit("output", {"data": b.decode("utf-8", errors="replace")}, to=self.sid)
                except Exception:
                    pass

        t = threading.Thread(target=reader, daemon=True)
        t.start()

        while self.proc and self.proc.poll() is None and not self.stop_evt.is_set():
            now = time.time()
            if now - self.started_at > MAX_WALL_TIME:
                try: self.proc.kill()
                except Exception: pass
                socketio.emit("output", {"data": "\n[Process killed due to wall-time limit]\n"}, to=self.sid)
                break
            time.sleep(0.15)

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

_runners: Dict[str, Runner] = {}
_runner_lock = threading.Lock()

def _get_runner(sid: str) -> Runner:
    with _runner_lock:
        r = _runners.get(sid)
        if not r:
            r = Runner(sid)
            _runners[sid] = r
        return r

# -------------------------
# Socket.IO handlers
# -------------------------
@socketio.on("connect")
def on_connect():
    emit("connected", {"sid": request.sid})

@socketio.on("disconnect")
def on_disconnect():
    try:
        r = _runners.get(request.sid)
        if r:
            r.stop()
    except Exception:
        pass

@socketio.on("run_code")
def on_run_code(payload):
    code = (payload or {}).get("code", "")
    r = _get_runner(request.sid)
    try:
        r.start(code)
        emit("run_ack", {"ok": True})
    except Exception as e:
        emit("output", {"data": f"[Error starting process] {e}\n"})
        emit("finished", {})

@socketio.on("send_input")
def on_send_input(payload):
    data = (payload or {}).get("data", "")
    r = _get_runner(request.sid)
    try:
        r.send_stdin(str(data))
    except Exception:
        pass

@socketio.on("stop")
def on_stop(_=None):
    r = _get_runner(request.sid)
    r.stop()
    emit("output", {"data": "\n[Stopped]\n"})
    emit("finished", {})

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
    is_admin = _require_admin(request)
    all_assignments = _list_assignments()
    
    if is_admin:
        # Admins see all assignments with submissions
        return jsonify(ok=True, assignments=all_assignments, isAdmin=True)
    else:
        # Students see all assignments (both active and past) but without submissions data
        for a in all_assignments:
            a.pop("submissions", None)
        return jsonify(ok=True, assignments=all_assignments, isAdmin=False)

@app.post("/api/assignments/create")
def create_assignment():
    """Create a new assignment (admin only)"""
    if not _require_admin(request):
        return jsonify(ok=False, error="Admin token required"), 401
    
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    task = (data.get("task") or "").strip()
    max_score = data.get("maxScore", 100)
    
    if not name:
        return jsonify(ok=False, error="Assignment name required"), 400
    
    # Check if assignment already exists
    if _load_assignment(name):
        return jsonify(ok=False, error="Assignment with this name already exists"), 400
    
    assignment = {
        "name": name,
        "task": task,
        "maxScore": max_score,
        "active": False,
        "submissions": []
    }
    
    if _save_assignment(assignment):
        return jsonify(ok=True, assignment=assignment)
    return jsonify(ok=False, error="Failed to save assignment"), 500

@app.post("/api/assignments/update")
def update_assignment():
    """Update an assignment (admin only)"""
    if not _require_admin(request):
        return jsonify(ok=False, error="Admin token required"), 401
    
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    
    if not name:
        return jsonify(ok=False, error="Assignment name required"), 400
    
    assignment = _load_assignment(name)
    if not assignment:
        return jsonify(ok=False, error="Assignment not found"), 404
    
    # Update fields
    if "task" in data:
        assignment["task"] = data["task"]
    if "maxScore" in data:
        assignment["maxScore"] = data["maxScore"]
    if "active" in data:
        assignment["active"] = data["active"]
    
    if _save_assignment(assignment):
        return jsonify(ok=True, assignment=assignment)
    return jsonify(ok=False, error="Failed to save assignment"), 500

@app.post("/api/assignments/delete")
def delete_assignment():
    """Delete an assignment (admin only)"""
    if not _require_admin(request):
        return jsonify(ok=False, error="Admin token required"), 401
    
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    
    if not name:
        return jsonify(ok=False, error="Assignment name required"), 400
    
    with _assignment_lock:
        path = _get_assignment_path(name)
        if not path.exists():
            return jsonify(ok=False, error="Assignment not found"), 404
        try:
            path.unlink()
            return jsonify(ok=True)
        except Exception as e:
            return jsonify(ok=False, error=f"Failed to delete: {e}"), 500

@app.post("/api/assignments/submit")
def submit_assignment():
    """Submit code for an assignment"""
    data = request.get_json(silent=True) or {}
    assignment_name = (data.get("assignmentName") or "").strip()
    student_name = (data.get("studentName") or "").strip()
    student_email = (data.get("studentEmail") or "").strip()
    class_period = (data.get("classPeriod") or "").strip()
    code = data.get("code", "")
    
    if not assignment_name or not student_email:
        return jsonify(ok=False, error="Assignment name and email required"), 400
    
    assignment = _load_assignment(assignment_name)
    if not assignment:
        return jsonify(ok=False, error="Assignment not found"), 404
    
    if not assignment.get("active", False):
        return jsonify(ok=False, error="Assignment is not active"), 403
    
    # Create or update submission
    submissions = assignment.get("submissions", [])
    
    # Find existing submission by email
    existing_idx = None
    for i, sub in enumerate(submissions):
        if sub.get("email", "").lower() == student_email.lower():
            existing_idx = i
            break
    
    submission = {
        "name": student_name,
        "email": student_email,
        "classPeriod": class_period,
        "code": code,
        "submittedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "score": None
    }
    
    if existing_idx is not None:
        # Overwrite existing submission
        submissions[existing_idx] = submission
    else:
        # Add new submission
        submissions.append(submission)
    
    assignment["submissions"] = submissions
    
    if _save_assignment(assignment):
        return jsonify(ok=True, message="Submission saved successfully")
    return jsonify(ok=False, error="Failed to save submission"), 500

@app.post("/api/assignments/score")
def score_submission():
    """Set a score for a student submission (admin only)"""
    if not _require_admin(request):
        return jsonify(ok=False, error="Admin token required"), 401
    
    data = request.get_json(silent=True) or {}
    assignment_name = (data.get("assignmentName") or "").strip()
    student_email = (data.get("studentEmail") or "").strip()
    score = data.get("score")
    
    if not assignment_name or not student_email:
        return jsonify(ok=False, error="Assignment name and email required"), 400
    
    assignment = _load_assignment(assignment_name)
    if not assignment:
        return jsonify(ok=False, error="Assignment not found"), 404
    
    submissions = assignment.get("submissions", [])
    found = False
    for sub in submissions:
        if sub.get("email", "").lower() == student_email.lower():
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
    """Grade a student submission using AI (admin only)"""
    if not _require_admin(request):
        return jsonify(ok=False, error="Admin token required"), 401
    
    cfg = _load_config()
    if not cfg.get("ai_explainer_enabled", False):
        return jsonify(ok=False, error="AI features disabled by admin"), 403
    
    data = request.get_json(silent=True) or {}
    assignment_name = (data.get("assignmentName") or "").strip()
    student_email = (data.get("studentEmail") or "").strip()
    code = data.get("code", "")
    task = data.get("task", "")
    max_score = data.get("maxScore", 100)
    
    if not assignment_name or not student_email or not code or not task:
        return jsonify(ok=False, error="Missing required fields"), 400
    
    # Validate and sanitize inputs
    if len(code) > 100000:  # Limit code to 100KB
        return jsonify(ok=False, error="Code is too long"), 400
    if len(task) > 10000:  # Limit task description to 10KB
        return jsonify(ok=False, error="Task description is too long"), 400
    
    # Build prompt for AI grading
    prompt = (
        "Grade the following student's Python code submission strictly from 0 to {max_score}.\n"
        "Return ONLY the integer score, with no additional words or explanation.\n\n"
        "Assignment Task:\n{task}\n\n"
        "Student Code:\n{code}\n\n"
        "Grading Criteria:\n"
        "- Does the code solve the problem correctly?\n"
        "- Is the code efficient and well-structured?\n"
        "- Are there any errors or bugs?\n"
        "- Does it follow Python best practices?\n\n"
        "Score (0-{max_score}):"
    ).format(max_score=max_score, task=task, code=code)
    
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
    
    submissions = assignment.get("submissions", [])
    found = False
    for sub in submissions:
        if sub.get("email", "").lower() == student_email.lower():
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
    """Download CSV of student numbers and scores (admin only)"""
    if not _require_admin(request):
        return jsonify(ok=False, error="Admin token required"), 401
    
    assignment = _load_assignment(assignment_name)
    if not assignment:
        return jsonify(ok=False, error="Assignment not found"), 404
    
    from flask import Response
    import io
    
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Student Number", "Score"])
    
    submissions = assignment.get("submissions", [])
    for sub in submissions:
        email = sub.get("email", "")
        # Extract student number (everything before @)
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
    """Get scores for a specific student email across all assignments"""
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    
    if not email:
        return jsonify(ok=False, error="Email required"), 400
    
    all_assignments = _list_assignments()
    student_scores = []
    
    for assignment in all_assignments:
        submissions = assignment.get("submissions", [])
        # Find submission for this email
        for sub in submissions:
            if sub.get("email", "").lower() == email:
                student_scores.append({
                    "assignmentName": assignment.get("name", ""),
                    "maxScore": assignment.get("maxScore", 100),
                    "score": sub.get("score"),
                    "submittedAt": sub.get("submittedAt", ""),
                    "active": assignment.get("active", False)
                })
                break
    
    return jsonify(ok=True, scores=student_scores)

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
    port = int(os.environ.get("PORT", "8000"))
    print("Server initialized for threading.")
    socketio.run(app, host=host, port=port, debug=False, allow_unsafe_werkzeug=True)

