# AGENTS.md

## Purpose

This file is the working map for agents modifying EagleIDE. Read it before changing code, then confirm assumptions against the current implementation. Keep this document updated when files, commands, or architectural boundaries change.

## Product Summary

EagleIDE is a classroom-focused browser IDE for Python, JavaScript, HTML, and CSS. A single Flask + Socket.IO process serves the page, static assets, REST APIs, and real-time execution on port 8000.

There is no frontend build system, package manager, or separate API service. The browser UI uses plain HTML, CSS, and global JavaScript. Most application data is stored in JSON, CSV, and per-user directories beside the source tree; the wiki uses a local SQLite catalog plus ordinary Markdown/media files.

Required runtime components:

- Python 3.9+ and the packages in `requirements.txt` (including `simple-websocket` for threaded Socket.IO).
- Node.js 18+ for running student JavaScript.
- A modern browser with internet access at page load for CDN-hosted CodeMirror, Socket.IO client, DOMPurify, marked, highlight.js, and fonts.
- Ollama only for AI explain, assistant, challenge grading, and mastery feedback features.

## Repository Map

```text
.
|-- app.py                       Main Flask/Socket.IO app, APIs, auth, persistence, and runners
|-- classroom_features.py        Classroom signals, file sharing, audit routes, and socket events
|-- wiki_features.py             Public wiki and protected admin/teacher/student HTTP routes
|-- wiki_store.py                Wiki SQLite catalog, search, assets, drafts, revisions, and backups
|-- network_features.py          Optional simulator auth, topology, class access, and lab HTTP routes
|-- network_store.py             Validated simulator persistence, reachability, and lab grading
|-- network_content.py           Source-controlled example topologies, labs, and CLI reference
|-- sandbox_worker.py            Restricted Python execution worker launched by app.py
|-- config.py                    Checked-in defaults and server constants
|-- index.html                   Entire SPA document and DOM structure
|-- static/
|   |-- css/
|   |   |-- main.css             Ordered stylesheet import entry point
|   |   |-- tokens.css           Theme variables and design tokens
|   |   |-- base.css             Reset and base element rules
|   |   |-- layout.css           Main responsive panel layout
|   |   |-- components.css       Shared controls and surfaces
|   |   |-- legacy.css           Compatibility/older rules; imported last
|   |   `-- features/            Feature-specific styles
|   `-- js/
|       |-- app.js               Creates the `window.EagleIDE` namespace
|       |-- app-core.js          Active main UI state, APIs, sockets, auth, files, quizzes, admin
|       |-- editor-init.js       CodeMirror setup and textarea fallback
|       |-- layout.js            Responsive panels and layout controls
|       |-- lazy-libs.js         Lazy browser dependency helpers
|       |-- markdown.js          Sanitized Markdown rendering helpers
|       |-- shell-commands.js    Browser-side virtual shell over workspace APIs
|       |-- classroom-signals.js Raise-hand/question UI and socket handling
|       |-- classroom-files.js   Sharing and teacher file-audit UI
|       |-- student-notebook.js  Notebook tabs, blocks, prompts, saving, and grading UI
|       |-- student-dashboard.js Student mastery dashboard and achievements
|       |-- wiki-reader.js       Public/embedded wiki reader, tree, search, links, and IDE handoff
|       |-- wiki-admin.js        Admin authoring, uploads, ordering, analytics, and recovery UI
|       |-- network-sim.js       Browser topology engine, packet tools, CLI, labs, and teacher UI
|       |-- network-sim-advanced.js Diagnostics, capture, deterministic traffic, IPv6, routing, and canvas tools
|       |-- network-sim-worker.js Seeded background-traffic generator running off the UI thread
|       |-- ui/modal.js          Shared modal helper
|       |-- state-socket.js      Migration-era source fragment; not loaded directly
|       `-- app-main.js          Migration-era source fragment; not loaded directly
|-- tests/
|   |-- test_execution_limits.py Execution admission, runner limits, files, and stream safeguards
|   |-- test_html_runtime.py     HTML runtime security, assets, bridge, and cleanup
|   |-- test_notebook.py         Notebook prompts, locking, grading, and mastery integration
|   |-- test_server_lifecycle.py Graceful shutdown state and false crash-alert regression coverage
|   |-- test_static_html.py      Static HTML structure, IDs, and local asset wiring
|   |-- test_network_sim.py      Simulator validation, persistence, grading, auth, and class access
|   `-- test_wiki.py             Wiki persistence, auth, media, class features, and backup tests
|-- tools/
|   |-- migrate_ux.py            Historical one-time CSS/JS extraction script
|   `-- apply_index_migration.py Historical one-time index migration script
|-- challenges.csv               Checked-in coding challenge bank
|-- exception_help.csv           Checked-in troubleshooting lookup data
|-- background.jpg               Light background asset
|-- background_dark.png          Dark background asset
|-- requirements.txt             Python runtime dependencies
|-- REQUIREMENTS.md              Dependency and compatibility audit
|-- README.txt                   User/admin documentation
`-- start.sh                     Linux setup and launch helper
```

## Architectural Boundaries

### Backend

`app.py` is intentionally broad and is the source of truth for most server behavior. Its major areas, in file order, are configuration and admin bootstrap, account/class helpers, file storage, notebook helpers, REST routes, HTML runtime, execution runners, Socket.IO handlers, assignments/quizzes, mastery reporting, and server health. Socket.IO uses standard threaded mode with `simple-websocket`; do not reintroduce Eventlet monkey-patching.

`classroom_features.py` is registered near the end of `app.py` with `register_classroom_features(app, socketio)`. It obtains the loaded app module through `_eagle()` and reuses private helpers and token stores from `app.py`. Changes to those private names can therefore break classroom features even if no import statement points to them directly.

`wiki_features.py` is also registered near the end of `app.py`. It adapts the existing in-memory admin, teacher, and student authentication to `WikiStore`. Keep public reads separate from protected mutations, require teacher ownership for every class feature or Lesson Material bookmark, and do not expose drafts through public routes.

`network_features.py` is registered independently near the wiki module and adapts the same auth/class callbacks to `NetworkStore`. The global configuration switch and per-class access both apply to students; guests require only the global switch and cannot save; admins may privately preview while disabled. Built-in topology/lab content belongs in `network_content.py`, while all mutable data stays under `network_data/`.

Authentication uses ephemeral in-memory token maps. Protected HTTP requests pass one of `X-Admin-Token`, `X-Teacher-Token`, or `X-User-Token`. Socket events carry the corresponding token in their payload and join role-specific rooms. Preserve authorization and class-ownership checks on every new route or event.

### Frontend

`index.html` contains the complete UI markup. Scripts are classic global scripts, not ES modules, and their order is significant. The active order at the end of the page is:

1. `app.js`, then shared modal/lazy/layout/editor/Markdown/shell helpers.
2. `app-core.js`, which owns the central mutable state and main socket connection.
3. The base network simulator followed by its advanced engine, then wiki reader/admin, classroom, notebook, and student dashboard feature scripts. These consume state exposed through `window.EagleIDE`; the advanced simulator also uses the explicit `window.NetworkSim` integration API and `network-sim:*` DOM events.

`app-core.js` is the active main application script. `state-socket.js` and `app-main.js` are not referenced by `index.html`; editing them alone has no browser effect. The historical `tools/migrate_ux.py` can rebuild `app-core.js` from those fragments, so do not run either migration script as a normal build or formatting step. They can overwrite newer UI work.

`static/css/main.css` is the only local stylesheet entry point. It imports tokens, foundations, feature styles, and finally `legacy.css`. Prefer the closest feature file for new rules and preserve the import order. Check desktop, tablet, mobile, light, and dark appearances after layout or token changes.

### Execution Flows

Python and JavaScript runs begin with the Socket.IO `run_code` event. Output returns through `output`, startup is acknowledged by `run_ack`, and completion returns through `finished`. `send_input` and `stop` control the active runner for a socket session.

Run admission is centralized and bounded before a process is created. It enforces global capacity, one active run per authenticated account, constrained guest capacity, start/input rate limits, connection limits, and server memory/disk pressure checks. Finished, stopped, failed, and disconnected runs must release both runner state and their admission slot.

- Python: `Runner` writes a temporary script, launches `sandbox_worker.py`, restricts filesystem access to the user's root, and applies import, CPU, process, memory, file, file descriptor, wall-time, write-budget, and output limits.
- JavaScript: `JsRunner` invokes Node with a restricted `vm` context and matching heap, CPU, process, wall-time, and output controls.
- Operating-system containment: POSIX runners use process groups, resource limits, and lower priority; Windows runners are assigned to kill-on-close Job Objects with CPU, memory, and active-process limits.
- HTML/CSS: `/api/html-runtime/*` serves files from the user's live workspace. JavaScript is enabled only through an operator-attested, cross-site preview origin; otherwise the preview applies `script-src 'none'` and safely renders HTML/CSS only. See `docs/HARDENING_AND_PERFORMANCE.md`.
- Interactive input: `INPUT_TOKEN` must remain identical in `app.py`, `sandbox_worker.py`, and the browser runtime.

Do not weaken path validation, sandbox restrictions, CSP, resource limits, or process cleanup to make a feature easier to implement. Treat execution code as a security boundary, not just application logic.

## Data and Persistence

Checked-in seed/reference data is limited to files such as `challenges.csv` and `exception_help.csv`. Normal application use creates local state including:

- `config.txt` and `.admin_key`
- `users.json`, `classes.json`, and `skills.json`
- `assignments/`, `notebooks/`, `user_files/`, and `sandboxes/`
- `wiki_data/` (SQLite catalog, Markdown, media, drafts, and revisions) and `wiki_backups/`
- `network_data/` (class access, lab assignments/progress, and per-account saved topologies)
- `challenge_scores.json` and `leaderboard.csv`
- `classroom_events.json` and `classroom_signals.json`
- server/sign-in event JSON files and `server.log`

Treat all of these as runtime data, not source fixtures. Do not delete, reset, commit, or hand-edit them unless the task explicitly concerns persistence or recovery. Some runtime files are not currently listed in `.gitignore`, so always inspect `git status` before finishing.

Persistence helpers generally use a lock plus write-to-temporary-file and replace. Follow that pattern for shared JSON state. Validate all user-relative paths with the existing path helpers and keep per-user storage inside `USER_FILES_DIR`.

Wiki content is runtime data. `WikiStore` owns its SQLite connections and file layout; use its methods instead of hand-editing the database or media directories. Portable restores intentionally exclude bookmarks, preserve live bookmarks, validate archive paths/checksums, and make a pre-restore backup. `EAGLEIDE_WIKI_DATA_DIR` and `EAGLEIDE_WIKI_BACKUP_DIR` can isolate these paths for deployment or testing.

Network simulator definitions are source data in `network_content.py`; assignments, progress, and personal topologies are runtime data. Use `NetworkStore` so validation and atomic per-student progress files remain intact. `EAGLEIDE_NETWORK_DATA_DIR` can isolate simulator runtime data.

## Where to Make Changes

- Accounts, classes, files, assignments, quizzes, mastery, admin, AI, or core API behavior: `app.py` plus the matching section of `app-core.js`.
- Network simulator catalog, permissions, grading, migrations, or storage: `network_features.py`, `network_store.py`, and `network_content.py`. Core browser topology/packet behavior belongs in `network-sim.js`; diagnostics, capture, deterministic traffic, IPv6, dynamic-routing views, and productivity tools belong in `network-sim-advanced.js`; background generation belongs in `network-sim-worker.js`; visuals belong in `features/network-sim.css`. Saved topology schema version 2 supports media-aware ports, parallel links, link properties, IPv6, RSTP, routing protocols, wireless radio settings, stateful policy, and seeded simulation metadata; preserve `migrate_topology()` compatibility when evolving it.
- Raise hand, classroom questions, file sharing, or teacher audit: `classroom_features.py`, `classroom-signals.js`, and/or `classroom-files.js`.
- Notebook prompts and student notes: notebook helpers/routes in `app.py`, `student-notebook.js`, and `features/student-notebook.css`.
- Student mastery dashboard: mastery routes in `app.py`, `student-dashboard.js`, and `features/student-dashboard.css`.
- Wiki catalog/search/assets/backup or HTTP authorization: `wiki_store.py` and `wiki_features.py`; reader/teacher actions: `wiki-reader.js`; admin authoring: `wiki-admin.js`; visuals: `features/wiki.css`.
- Editor initialization or teacher stream editor: `editor-init.js`; most run/open/save behavior remains in `app-core.js`.
- Virtual shell parsing: `shell-commands.js`; it must call workspace APIs and must never expose an operating-system shell.
- DOM structure or third-party CDN versions: `index.html`.
- Theme values: `tokens.css`; reusable UI primitives: `components.css`; feature visuals: the matching `features/*.css` file.
- Defaults exposed through `/api/config`: update `config.py` and the fallback `DEFAULT_CONFIG` in `app.py` together.
- Python execution policy: `sandbox_worker.py` and the `Runner` integration in `app.py`.

When a feature crosses the browser/server boundary, trace and update the full path: DOM element, event binding, request or socket payload, server validation, persistence, response/event, and render state.

## Setup and Startup

Linux/macOS:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
HOST=127.0.0.1 PORT=8000 python app.py
```

On Linux, `./start.sh` creates or repairs `.venv`, installs dependencies, and starts on `0.0.0.0:8000`.

Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
$env:HOST = "127.0.0.1"
$env:PORT = "8000"
python app.py
```

`app.py` performs admin credential setup during import. On a fresh non-interactive environment, pre-seed `config.txt` and `.admin_key` before starting:

```python
import json
import os
from pathlib import Path
from cryptography.fernet import Fernet
from config import DEFAULT_CONFIG

base = Path(".")
key = Fernet.generate_key()
(base / ".admin_key").write_bytes(key)
os.chmod(base / ".admin_key", 0o600)
encrypted = Fernet(key).encrypt(b"DevAdmin123").decode()
config = {
    **DEFAULT_CONFIG,
    "admin_email": "admin@eagleide.local",
    "admin_password_encrypted": encrypted,
}
(base / "config.txt").write_text(json.dumps(config, indent=2), encoding="utf-8")
```

The local development credentials in that example are `admin@eagleide.local` / `DevAdmin123`. Never use them for a public deployment. Both generated credential files must remain uncommitted.

## Verification

Run the automated suite from the repository root:

```bash
python -m unittest discover -s tests -v
```

Focused runs:

```bash
python -m unittest discover -s tests -p test_execution_limits.py -v
python -m unittest tests.test_html_runtime -v
python -m unittest tests.test_notebook -v
python -m unittest tests.test_wiki -v
```

The tests patch application globals to temporary directories and restore token maps during teardown. New persistence tests should do the same so real local accounts and classroom data are never touched.

There is no configured linter or frontend unit-test runner. For browser-facing changes, also start the server and verify:

1. `GET /health` returns `{"ok": true}`.
2. Sign-in and the affected student, teacher, or admin view work.
3. A Python hello-world run streams output and reaches `finished`.
4. JavaScript execution works when Node.js is installed if runner code changed.
5. HTML runtime opens and resolves local CSS/JS if web runtime code changed.
6. The modified UI works at desktop and narrow viewport widths in both themes.

Ollama is not required for editor, file, notebook, classroom, or code-run tests. If it is unavailable, verify that AI features fail gracefully rather than blocking unrelated workflows.

## Coding and Safety Conventions

- Keep Socket.IO in standard threaded mode unless a separately reviewed deployment migration replaces it.
- Preserve existing JSON response style: success/error payloads use an `ok` boolean and appropriate HTTP status codes.
- Reuse auth, ownership, rate-limit, path, normalization, and atomic-write helpers rather than duplicating weaker versions.
- Keep student HTML and Markdown sanitized. DOMPurify is the browser-side default; server-generated HTML must still be treated as untrusted.
- Avoid introducing a build system or framework for a small UI change. This project deliberately runs directly from checked-in assets.
- Keep script-global naming and load order in mind. Prefer the existing `window.EagleIDE` integration pattern for new feature modules.
- Add or update tests for server behavior, especially authorization, traversal, locking, normalization, grading, and persistence.
- Never commit credentials, auth tokens, student information, submissions, logs, generated reports, or local runtime state.
- Do not run the scripts in `tools/` unless the task explicitly asks to repeat the historical UX migration and the overwrite impact has been reviewed.

## Completion Checklist

Before handing work back:

1. Review `git diff` and `git status`; preserve unrelated user changes and exclude runtime data.
2. Run the full automated suite, or state exactly why it could not run.
3. Exercise the affected browser flow for UI or Socket.IO changes.
4. Confirm authorization and path boundaries for new server behavior.
5. Update this file if the repository map, startup process, tests, or architectural boundaries changed.
