# Eagle IDE — Requirements Audit

This document lists every runtime dependency (Python packages, system programs, and
browser-side CDN libraries) required to run Eagle IDE.

---

## 1. Host System Programs

| Program | Minimum Version | Purpose | Install |
|---------|-----------------|---------|---------|
| **Python** | **3.9** | Runs `app.py` and the student code sandbox. *(Python 3.8 is NOT supported — the code uses PEP 585 built-in generic types, e.g. `list[tuple[...]]`.)* | See below |
| **Node.js** | **18** | Executes student `.js` files via the `node` subprocess runner. Not required for Python-only use, but `.js` file execution will fail without it. | See below |
| **Ollama** | Any recent | *(Optional)* Serves the local LLM for AI Explain, AI Assistant, and Challenge Scoring features. Can run on the same machine or a separate server. | https://ollama.ai |

### Installing Python 3.9+

```bash
# Ubuntu / Debian
sudo apt install python3.9 python3-pip python3-venv

# Fedora / RHEL
sudo dnf install python3.9

# macOS (Homebrew)
brew install python@3.9

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
pip install -r requirements.txt
```

| Package | Purpose |
|---------|---------|
| `flask` | Web framework — serves HTTP routes and static files |
| `flask-socketio` | WebSocket / Socket.IO support — streams real-time code output to the browser |
| `eventlet` | Async networking library required by `flask-socketio` (`async_mode="eventlet"`) |
| `requests` | HTTP client — used to call the Ollama AI API for code explain / assistant features |
| `bcrypt` | Secure password hashing for student and admin accounts |

> All packages are pure-Python or have pre-built wheels for common platforms.
> No system-level C build tools are required.

---

## 3. Browser-Side CDN Libraries (loaded at page load)

These libraries are loaded from public CDNs when a student opens the IDE in their browser.
**An internet connection is required at page load** unless you self-host these files.

| Library | Version | CDN | Purpose |
|---------|---------|-----|---------|
| CodeMirror | 5.65.16 | cdnjs | Code editor with syntax highlighting (Python, JS, HTML, CSS) |
| Socket.IO client | 4.7.5 | cdn.socket.io | Real-time WebSocket communication with the server |
| marked | latest | jsDelivr | Markdown → HTML rendering (AI output, notes) |
| DOMPurify | 3.1.6 | jsDelivr | HTML sanitizer (prevents XSS in rendered Markdown) |
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

- [ ] Python 3.9+ installed (`python3 --version`)
- [ ] Node.js 18+ installed (`node --version`)  ← required for `.js` execution
- [ ] `pip install -r requirements.txt` completed successfully
- [ ] `python app.py` starts without errors
- [ ] Browser can reach `http://<server-ip>:8000`
- [ ] (Optional) Ollama running with `gemma3:4b` model for AI features
