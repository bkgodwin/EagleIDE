# Eagle IDE — Requirements Audit

This document lists every runtime dependency (Python packages, system programs, and
browser-side CDN libraries) required to run Eagle IDE.

---

## 1. Host System Programs

| Program | Minimum Version | Purpose | Install |
|---------|-----------------|---------|---------|
| **Python** | **3.12** | Runs `app.py` and the student code sandbox. Python 3.12+ is required by the pinned NumPy runtime used by Matplotlib. | See below |
| **Node.js** | **18** | Executes student `.js` files via the `node` subprocess runner. Not required for Python-only use, but `.js` file execution will fail without it. | See below |
| **Linux kernel with Landlock ABI 3+** | **Linux 5.19+ recommended** | Required to enable native student modules (`sqlite3`, `inspect`, NumPy, Pillow, and Matplotlib). They fail closed when the boundary is unavailable. | Included in current Debian/Ubuntu kernels |
| **Ollama** | Any recent | *(Optional)* Serves the local LLM for AI Explain, AI Assistant, and Challenge Scoring features. Can run on the same machine or a separate server. | https://ollama.ai |

### Installing Python 3.12+

```bash
# Ubuntu / Debian
sudo apt install python3.12 python3-pip python3-venv

# Fedora / RHEL
sudo dnf install python3.12

# macOS (Homebrew)
brew install python@3.12

# Windows
# Download from https://www.python.org/downloads/
```

### Installing Node.js 18+

```bash
# Ubuntu / Debian
sudo apt install nodejs       # Check version; if < 18 use NodeSource PPA
# OR using NodeSource PPA for v20:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Fedora / RHEL
sudo dnf install nodejs

# macOS (Homebrew)
brew install node

# Windows
# Download installer from https://nodejs.org/
```

Verify: `node --version` should print `v18` or higher.

---

## 2. Python Packages (`requirements.txt`)

Install all packages with:

```bash
./start.sh
```

The launcher creates and verifies `.venv`, installs pinned binary wheels, and
executes the server with `.venv/bin/python`. Direct `python3 app.py` launches
the system interpreter and is not a supported production start command.

| Package | Purpose |
|---------|---------|
| `flask` | Web framework — serves HTTP routes and static files |
| `flask-socketio` | WebSocket / Socket.IO support — streams real-time code output to the browser |
| `simple-websocket` | WebSocket transport used by Flask-SocketIO standard threading mode |
| `requests` | HTTP client — used to call the Ollama AI API for code explain / assistant features |
| `bcrypt` | Secure password hashing for student and admin accounts |
| `cryptography` | Encrypts stored admin credentials in `config.txt` using Fernet |
| `numpy` | Native numerical prerequisite used by Matplotlib inside contained Python workers |
| `matplotlib` | Headless `Agg` chart rendering; `plt.show()` saves PNG artifacts to the student's workspace |
| `Pillow` | Pinned image runtime used by Matplotlib and authenticated IDE image validation |

NumPy, Matplotlib, Pillow, bcrypt, and cryptography include native components.
Pinned releases provide wheels for supported Python versions and common
architectures, so a compiler is normally unnecessary. On an uncommon
architecture without compatible wheels, review any requested source build and
its toolchain before production deployment.

### Native student-module boundary

EagleIDE probes Linux Landlock at startup and applies a fresh filesystem
ruleset inside every Python worker. The student workspace is read/write, while
the interpreter and installed module files are read-only. The existing Python
audit hook, import policy, process controls, resource limits, and path
normalization remain active as defense in depth.

`sqlite3`, `inspect`, NumPy, Pillow, ContourPy, KiwiSolver, and Matplotlib are
disabled automatically if Landlock ABI 3 or newer is unavailable. Pure
standard-library exercises still run. Windows remains suitable for development
and ordinary Python exercises, but production use of the native modules
requires Linux.

---

## 3. Browser-Side CDN Libraries (loaded at page load)

These libraries are loaded from public CDNs when a student opens the IDE in their browser.
**An internet connection is required at page load** unless you self-host these files.

| Library | Version | CDN | Purpose |
|---------|---------|-----|---------|
| CodeMirror | 5.65.16 | cdnjs | Code editor with syntax highlighting (Python, JS, HTML, CSS) |
| Socket.IO client | 4.7.5 | cdn.socket.io | Real-time WebSocket communication with the server |
| marked | 18.0.7 | jsDelivr | Markdown → HTML rendering (AI output, notes) |
| DOMPurify | 3.4.7 | jsDelivr | HTML sanitizer (prevents XSS in rendered Markdown) |
| highlight.js | 11.9.0 | cdnjs | Syntax highlighting inside Markdown code blocks |
| Google Fonts (Inter) | — | fonts.googleapis.com | UI font |

---

## 4. Optional: Ollama AI Model

If AI features are enabled (`ai_explainer_enabled: true` in Admin settings), Ollama must be
running with a compatible model.

```bash
# Install Ollama (Linux)
curl -fsSL https://ollama.ai/install.sh | sh

# Pull the default model
ollama pull gemma3:4b

# Verify Ollama is running
curl http://localhost:11434/api/tags
```

The Ollama URL is configurable in `config.py` or via the Admin Settings panel.
Default: `http://127.0.0.1:11434` (same machine).

---

## 5. Quick Start Checklist

- [ ] Python 3.12+ installed (`python3 --version`)
- [ ] Linux Landlock ABI 3+ available for SQLite/Matplotlib and native chart dependencies (`Admin → Settings → Python Runtime`)
- [ ] Node.js 18+ installed (`node --version`)  ← required for `.js` execution
- [ ] `./start.sh` completes dependency and environment validation
- [ ] EagleIDE starts at the configured host and port
- [ ] Browser can reach `http://<server-ip>:8000`
- [ ] (Optional) Ollama running with `gemma3:4b` model for AI features
