# AGENTS.md

## Cursor Cloud specific instructions

### Product overview

Eagle IDE is a single Flask + Socket.IO web app (no separate frontend build). One Python process serves `index.html`, static assets, REST APIs, and real-time code execution on port **8000**.

### System dependencies (one-time on fresh VMs)

- **Python 3.9+** with **`python3-venv`** (Ubuntu: `sudo apt install python3.12-venv python3-full`)
- **Node.js 18+** for JavaScript execution (`node` on PATH; already present in this cloud image)

### Dependency refresh (automatic)

On VM startup, the update script ensures `.venv` exists and runs `pip install -r requirements.txt`. See the configured update script in Cursor Cloud settings.

### Starting the server

```bash
source .venv/bin/activate
HOST=127.0.0.1 PORT=8000 python app.py
```

Or use `./start.sh` (creates `.venv`, installs deps, starts the server on `0.0.0.0:8000`).

### First-time admin bootstrap (non-interactive)

`app.py` prompts for admin email/password on first start via TTY (`getpass`), which blocks non-interactive shells. For cloud agents, pre-seed credentials before starting:

```bash
source .venv/bin/activate
python3 <<'PY'
import json, os
from pathlib import Path
from cryptography.fernet import Fernet
from config import DEFAULT_CONFIG

BASE = Path(".")
key = Fernet.generate_key()
(BASE / ".admin_key").write_bytes(key)
os.chmod(BASE / ".admin_key", 0o600)
enc = Fernet(key).encrypt(b"DevAdmin123").decode()
cfg = {**DEFAULT_CONFIG, "admin_email": "admin@eagleide.local", "admin_password_encrypted": enc}
(BASE / "config.txt").write_text(json.dumps(cfg, indent=2), encoding="utf-8")
print("ready")
PY
```

Default dev admin: `admin@eagleide.local` / `DevAdmin123`. Both `config.txt` and `.admin_key` are gitignored.

### Lint / tests

No lint config or automated test suite in this repo. Verify changes by starting the server and exercising the IDE in a browser.

### Optional services

- **Ollama** — required only for AI Explain, Assistant chat, and challenge grading. Not needed for editor, file, or code-run flows.
- **CDN internet** — the SPA loads CodeMirror, Socket.IO client, and fonts from CDNs at page load.

### Hello-world verification

1. `curl http://127.0.0.1:8000/health` → `{"ok":true}`
2. Open `http://127.0.0.1:8000`, enter `print("Hello from Eagle IDE!")`, click **Run ▶**, confirm output in the Shell panel.

Python and JavaScript runs use Socket.IO event `run_code`; output streams on `output` / `finished` events.
