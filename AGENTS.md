# AGENTS.md

## Purpose

This file is the working map for agents modifying EagleIDE. Read it before changing code, then confirm assumptions against the current implementation. Keep this document updated when files, commands, or architectural boundaries change.

## Product Summary

EagleIDE is a classroom-focused browser IDE for Python, JavaScript, HTML, and CSS. A single Flask + Socket.IO process serves the page, static assets, REST APIs, and real-time execution on port 8000.

There is no frontend build system, package manager, or separate API service. The browser UI uses plain HTML, CSS, and global JavaScript. Most application data is stored in JSON, CSV, and per-user directories beside the source tree; the wiki uses a local SQLite catalog plus ordinary Markdown/media files.

Required runtime components:

- Python 3.12+ and the packages in `requirements.txt` (including `simple-websocket` for threaded Socket.IO and Matplotlib/NumPy for charts).
- Linux Landlock ABI 3+ for native student modules (`sqlite3`, `inspect`, NumPy, and Matplotlib); those modules fail closed on unsupported hosts.
- Node.js 18+ for running student JavaScript.
- A modern browser with internet access at page load for CDN-hosted CodeMirror, Socket.IO client, DOMPurify, marked, highlight.js, and fonts.
- Ollama only for AI explain, assistant, challenge grading, and mastery feedback features.

## Repository Map

```text
.
|-- app.py                       Main Flask/Socket.IO app, APIs, auth, persistence, and runners
|-- assignment_workflow.py       Private deadlines/windows, submission bundles/history, and previews
|-- assignment_development.py    Controlled assignment files, clipboard policy, and private delta timelines
|-- assignment_organization.py   Owner-managed class folders, atomic assignment membership, and folder authorization
|-- file_provenance.py           Bounded paste ranges outside workspaces; submission snapshots use UTF-16 offsets
|-- notebook_practice.py         Bounded practice feedback, revision guards, and protected notebook checks
|-- notebook_media.py            Quota-counted photo uploads, protected previews, and shared-tab copies
|-- workspace_data.py            Bounded CSV pages and version-checked streaming workspace edits
|-- server_metrics.py            On-demand Linux/Windows per-core CPU counters
|-- classroom_features.py        Classroom signals, file sharing, audit routes, and socket events
|-- lesson_plan_features.py      Lesson-plan APIs, source linking, link previews, and public routes
|-- lesson_plan_store.py         Atomic plans, external links, source mappings, and share tokens
|-- wiki_features.py             Public wiki and protected admin/teacher/student HTTP routes
|-- wiki_store.py                Wiki SQLite catalog, search, assets, drafts, revisions, and backups
|-- network_features.py          Optional simulator auth, topology, class access, and lab HTTP routes
|-- network_store.py             Validated simulator persistence, reachability, and lab grading
|-- network_content.py           Source-controlled example topologies, labs, and CLI reference
|-- external_tools.py            Generic tool registration, class grants, scoped launch sessions, and workspace routes
|-- tool_store.py                Bounded atomic private tool catalog and network policy
|-- tool_gateway.py              Pinned private HTTP transport, resource limits and credential-redacted access logs
|-- sandbox_worker.py            Restricted Python execution worker launched by app.py
|-- js_worker.js                 Student JavaScript VM realm, safe I/O, timers, and denied imports
|-- trace_support.py             Bounded Python Step Mode snapshots and deterministic narration
|-- sandbox_policy.py            Student module catalog, ACL normalization, and locked imports
|-- sandbox_containment.py       Per-worker Linux Landlock filesystem boundary
|-- config.py                    Checked-in defaults and server constants
|-- autocomplete_metadata.csv   Editable Python completion signatures, return types, and descriptions
|-- index.html                   Entire SPA document and DOM structure
|-- lesson_plan_public.html      Public and embeddable lesson-plan document
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
|       |-- connection.js        Client outage warnings, health probes, and bounded workspace requests
|       |-- feature-loader.js    On-demand loading for large optional browser features
|       |-- app-core.js          Active main UI state, APIs, sockets, auth, files, quizzes, admin
|       |-- teacher-assignments.js Teacher assignment library, section navigation, draft retention, and composer presentation
|       |-- assignment-workflow.js Collapsed assignment cards, attachments, feedback, and presentation
|       |-- assignment-development.js Clipboard guards, one-second changed-code sampling, and bounded retry journal
|       |-- file-provenance.js     Silent editor paste ranges, edit remapping, and bounded undo/redo recovery
|       |-- workspace-data.js    Paged editable CSV grid and lazy JSON tree/source controls
|       |-- server-performance.js On-demand admin CPU graphs; browser history only
|       |-- external-tools.js     Tool workspace, class grants, navigation and account/session cleanup
|       |-- external-tools-admin.js Lazy generic catalog, policy, test and compatibility confirmation UI
|       |-- editor-init.js       CodeMirror setup and textarea fallback
|       |-- editor-feedback.js   Local occurrences, delimiters, diagnostics, block guides, and caret visibility
|       |-- editor-behavior.js   Predictable Python Enter indentation and CodeMirror block folding
|       |-- autocomplete.js      Bounded code analysis, catalog-backed suggestions, and completion UI
|       |-- layout.js            Responsive panels and layout controls
|       |-- lazy-libs.js         Lazy browser dependency helpers
|       |-- markdown.js          Sanitized Markdown rendering helpers
|       |-- shell-commands.js    Browser-side virtual shell over workspace APIs
|       |-- step-mode.js         Python trace playback, variables, narration, and navigation
|       |-- classroom-signals.js Raise-hand/question UI and socket handling
|       |-- classroom-files.js   Sharing and teacher file-audit UI
|       |-- student-notebook.js  Notebook tabs, practice feedback/notes, recovery, checks, and inline runs
|       |-- notebook-sync.js     Pure three-way draft merging and conflict recovery
|       |-- notebook-photos.js   Device-photo resizing, lazy authenticated previews, and URL cleanup
|       |-- student-dashboard.js Student mastery dashboard and achievements
|       |-- lesson-plans.js      Teacher editing and student home lesson-plan controller
|       |-- lesson-plan-renderer.js Shared safe weekly-plan renderer
|       |-- lesson-plan-public.js Public/embed navigation and print controller
|       |-- wiki-reader.js       Public/embedded wiki reader, tree, search, links, and IDE handoff
|       |-- wiki-admin.js        Admin authoring, uploads, ordering, analytics, and recovery UI
|       |-- wiki-tools.js        Lazy interactive binary and IPv4 subnet wiki calculators
|       |-- network-sim.js       Browser topology engine, packet tools, CLI, labs, and teacher UI
|       |-- network-sim-advanced.js Diagnostics, capture, deterministic traffic, IPv6, routing, and canvas tools
|       |-- network-sim-worker.js Seeded background-traffic generator running off the UI thread
|       |-- ui/modal.js          Shared modal helper
|       |-- state-socket.js      Migration-era source fragment; not loaded directly
|       `-- app-main.js          Migration-era source fragment; not loaded directly
|-- tests/
|   |-- test_execution_limits.py Execution admission, runner limits, files, and stream safeguards
|   |-- test_file_browser.py     Student file operations, creation races, and workspace path safety
|   |-- test_file_open_performance.py Bounded class snapshots and live workspace permission changes
|   |-- connection_ui.test.js    Offline warnings, file guards, reconnect state, and stalled response checks
|   |-- js_worker.test.js        JavaScript constructor escapes, imports, input, and timer limits
|   |-- test_auth_frontend.py    Session restoration and sign-in/class-refresh JavaScript checks
|   |-- test_layout_runtime.py   Pointer/keyboard resize and visual-viewport JavaScript checks
|   |-- test_classroom_signals.py Atomic simultaneous classroom signal persistence
|   |-- *_ui.test.js            Dependency-free Node tests for classroom/file UI state races
|   |-- editor_feedback_ui.test.js Local symbol, selection, diagnostics, bracket, and block-guide regressions
|   |-- editor_behavior_ui.test.js Editor indentation, folding, and error-unfold regression checks
|   |-- student_notebook_ui.test.js Notebook toggle and visible-viewport regression test
|   |-- test_python_sandbox.py   Module ACL, native containment, SQLite, and chart security
|   |-- test_startup.py          Launcher safety, dependency pinning, and environment checks
|   |-- test_html_runtime.py     HTML runtime security, assets, bridge, and cleanup
|   |-- test_notebook.py         Notebook persistence, practice queue, cooldowns, legacy data, and access
|   |-- test_grade_exports.py    Account student numbers and notebook completion CSV exports
|   |-- notebook_export_ui.test.js Notebook export downloads, errors, and account switches
|   |-- notebook_practice_ui.test.js Draft merging, output framing, tab locks, and shared runner checks
|   |-- notebook_photos_ui.test.js Photo scaling, lazy loading, read-only checks, and stale uploads
|   |-- test_assignments.py      Assignment ownership, submissions, legacy/beta grading, and rubric validation
|   |-- test_assignment_workflow.py Deadlines/windows, multi-file storage/history, and submission access
|   |-- assignment_workflow_ui.test.js Current/past cards, submission state, and attachment rendering
|   |-- test_assignment_development.py Controlled file identity, timeline persistence, playback auth, and cleanup
|   |-- assignment_development_ui.test.js Changed-only sampling, Unicode deltas, retries, and clipboard guards
|   |-- test_teacher_review.py    Individual make-up access, score races/validation, and paste snapshots
|   |-- file_provenance_ui.test.js Paste range edits, undo/redo, and escaped teacher highlights
|   |-- wiki_reference_ui.test.js Class-local agenda dates and stale reference response guards
|   |-- ide_review_ui.test.js     Late submission opens, draft saves during edits, and per-document undo
|   |-- assignment_grading_ui.test.js Assignment views and unsaved grading-draft regression checks
|   |-- teacher_assignments_ui.test.js Assignment library search, sorting, filters, and account/class isolation
|   |-- test_assignment_organization.py Folder ownership, concurrent moves, finalization retention, and class deletion
|   |-- test_server_lifecycle.py Graceful shutdown state and false crash-alert regression coverage
|   |-- test_static_html.py      Static HTML structure, IDs, and local asset wiring
|   |-- test_network_sim.py      Simulator validation, persistence, grading, auth, and class access
|   |-- test_external_tools.py   Generic HTTP fixture, tool permissions, revocation, SSRF and gateway boundaries
|   |-- external_tools_ui.test.js Tool launch, late responses, outage, navigation and lifecycle regressions
|   `-- test_wiki.py             Wiki persistence, auth, media, class features, and backup tests
|-- tools/
|   |-- migrate_ux.py            Historical one-time CSS/JS extraction script
|   `-- apply_index_migration.py Historical one-time index migration script
|-- .github/workflows/tests.yml  Linux/Landlock regression test workflow
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

Student profiles retain `name` as the joined display name and store `first_name`,
`last_name`, and a string `student_id` (preserving leading zeroes). Legacy names
become first names without splitting, and missing last names/IDs remain blank.
Teacher rosters and grading views sort by last name, then first name. Assignment
CSV exports use student IDs, with blank IDs for accounts that have not added one.
Class `coteachers` are a subset of the student roster, not a global account role.
Only routes explicitly using `allow_coteacher=True` may accept a promoted student's
token in `X-Teacher-Token`; they must check current class membership on every
request. CoTeachers can read class reports/rosters, edit lesson plans, create
assignments/prompts, and grade submissions. Owners retain membership, profile,
lock/unlock, delete, assignment-setting, and lesson-plan sharing/source controls.

All Ollama generation goes through the shared in-memory AI dispatcher in `app.py`. It keeps the configured concurrency full while healthy, queues excess interactive and background work, applies a global cooldown when Ollama reports overload, and retries overloaded requests. Assignment grading adds a durable submission-status layer with teacher queue inspection and cancellation; do not bypass the dispatcher with direct Ollama HTTP calls.

### External applications

`external_tools.py` registers an empty, disabled-by-default external application
gateway with the existing auth/class callbacks. Admins own destinations and global
enablement; teachers can open all globally enabled, verified tools without class
grants or class ownership. CoTeachers retain student tool-access rules. Only class
owners mutate student grants. Students use the union of current
class grants; guests receive none. `tool_store.py` owns private atomic
`tool_data/catalog.json` (override `EAGLEIDE_TOOL_DATA_DIR`), including explicit
allowed private application CIDRs and denied management/EagleIDE CIDRs. Never
seed third-party apps or put project contents in this catalog.

Tool capabilities are revocable in-memory credentials bound to the originating
auth session, current entitlement and tool revision. Keep their URL segments
redacted in access logs. `tool_gateway.py` validates all DNS answers and pins the
checked numerical destination, preserving TLS hostname validation; do not add an
arbitrary URL proxy, ambient credentials or permissive localhost flags. Restrict
methods, uploads, responses, connections and timeouts independently of runners.
Keep binary resources streamed (256 MiB / 180-second cap) with bounded asset-burst
waiting (64 global / 12 per session, 15 seconds), 16 global / four per-session
active transfers, and fresh authorization after promotion. HTML alone is buffered
up to 2 MiB, with bounded gzip/deflate decoding. Add anonymous crossorigin to
SRI-bearing link/script tags lacking it; preserve hashes, scripts, URLs and CSP.
Cookie/login, WebSocket/SSE, workers and unsupported native storage flows fail
closed. HTML/application responses enforce CSP sandbox without allow-same-origin
as well as the iframe sandbox; direct document navigation must not bypass it.
Opaque Origin:null CORS applies only to authorized instance resources, never
EagleIDE APIs. Preserve upstream CSP/frame restrictions and existing HTML runtime
isolation. Compatibility confirmation is an admin attestation after a private
preview, not an automated security certification. Setup and operational limits
are in `static/docs/external-tools.html`.

Tool routing extends the current wiki/IDE/network lifecycle. Do not retain hidden
application iframes after confirmed departure or account changes. Preserve IDE
and notebook buffers, reject stale launches, revalidate suspended/restored views,
and distinguish transient outages from confirmed revocation. The tool frame fills
the available viewport beneath a single compact site banner.
Keep status/save help in its Info disclosure and preserve the mounted frame during
access refreshes, renewals, viewport changes and transient outages. The wider admin
manager separates Applications, Network & access, and Compatibility guide; its
permission descriptions must distinguish HTML forms from HTTP writes without
implying that cookies/storage or live connections can be enabled. Never clear all
origin storage. The operator manages LXC/network isolation, not EagleIDE.

The optional `tests/external_tools_browser_checks.js` Playwright check uses only
`tests/external_tools_browser_fixture.py`. It checks viewport bounds, rendering,
outage recovery, and a live document/draft beyond its original 90-second lease.
For a public static app build, start the same fixture with `--app-directory` and
run `tests/external_tools_solidcraft_browser_checks.js` to verify a real SolidCraft
release (CAD box, undo/redo, canvas sizing and retention beyond the lease). Never
serve a private source/data folder. The test does not download or install apps.
Set `EAGLE_TOOL_TEST_URL` to the fixture's loopback URL, `EAGLE_TOOL_BROWSER` to an
installed Chromium browser, and `EAGLE_TOOL_SCREENSHOT_DIR` to a scratch folder.

### Frontend

`index.html` contains the complete UI markup. Scripts are classic global scripts, not ES modules, and their order is significant. The active order at the end of the page is:

1. `app.js`, then `connection.js` and shared modal/lazy/layout/editor/Markdown/shell helpers.
2. `app-core.js`, which owns the central mutable state and main socket connection.
3. The wiki reader/admin, classroom, notebook, and student dashboard feature scripts. These consume state exposed through `window.EagleIDE`. The feature loader fetches the base and advanced network simulator scripts together when the simulator is first requested; the advanced simulator uses the explicit `window.NetworkSim` integration API and `network-sim:*` DOM events.

`app-core.js` is the active main application script. `state-socket.js` and `app-main.js` are not referenced by `index.html`; editing them alone has no browser effect. The historical `tools/migrate_ux.py` can rebuild `app-core.js` from those fragments, so do not run either migration script as a normal build or formatting step. They can overwrite newer UI work. Interactive wiki calculators live in `wiki-tools.js` with `features/wiki-tools.css`; both are loaded together by `feature-loader.js` only when a tool page is opened.

`static/css/main.css` is the only local stylesheet entry point. It imports tokens, foundations, feature styles, and finally `legacy.css`. Prefer the closest feature file for new rules and preserve the import order. Check desktop, tablet, mobile, light, and dark appearances after layout or token changes.

The minimized teacher submission dashboard uses a normal-flow review row below the topbar, outside the dashboard modal. Keep its return button and previous/next controls clear of the toolbar, and hide the row when leaving submission review.

### Execution Flows

Notebook AI feedback is formative practice without mastery contributions. The teacher
Notebook Responses dashboard exports completion grades through
`/api/teacher/notebook-prompts/csv`: a saved nonempty response earns 100%, a blank
or missing response earns 0%, independently of AI feedback. Exports include the
current class roster and use account `student_id` values (blank if missing), with
percent or numeric 0–100 output. Completion grades are derived at export time;
preserve legacy score/feedback fields on disk. `notebook_practice.py`
registers student submission and teacher read-only notebook-check routes against
the loaded app module. Its durable per-block snapshot/status is protected from
student saves; a bounded 256-job worker uses only the shared AI dispatcher, with
one pending job per student and a 180-second per-prompt resubmission cooldown.
Failed feedback bypasses that cooldown while preserving its submission timestamp.
The private `notebooks/.practice-queue.json` identity journal restores accepted
jobs at startup without an open browser; preserve FIFO order and never put source
in this journal. Background admission waits for dispatcher capacity without
spending generation timeout. Overload pauses/retries remain in the shared
dispatcher. Practice requests run sequentially with minimum start spacing and
one bounded correction for invalid feedback format; exceptions must settle
status instead of leaving stale queued labels.
AI results check submission identity and current enrollment before applying.
A bounded local check rejects blank/comment-only and clearly noncoding attempts
before model admission. The model reviews relevance for remaining code. Prompts
treat all source as untrusted coding data; solution code blocks are rejected.
`ai_notebook_feedback_enabled` (admin AI settings, default true) applies independently
of general `ai_explainer_enabled` and class `ai_enabled`. Feedback evaluates code
quality and assignment fulfillment; topic notes define the primary coding concept
and give reusable reminders without critiquing the submitted attempt.
Student-edited Markdown notes survive later AI
results. Teacher comments remain editable without grading controls.

Notebooks carry an incrementing `revision`; stale saves return HTTP 409 plus the
authorized current notebook. `notebook-sync.js` merges disjoint editable fields
and preserves overlapping local work in recovery tabs. Scoped device drafts cover
offline edits, slow responses, class/account changes, and iPad page suspension;
never apply a stale load/save after its account/class changes. Browser-storage
failure must remain visible. `editLocked` is a student's per-tab padlock, separate
from the fixed Assignments tab and teacher prompt locks. Serialize only source
HTML, never CodeMirror controls, runtime shells/output, or highlight spans.
Only one prompt body is mounted at a time; highlighting and output are bounded.
Notebook resizing uses pointer capture and visualViewport bounds. Inline runners
claim the IDE's shared execution state before emitting, frame split input tokens,
and accept input only from the active notebook block.
Execution workers own stdin echo. Strip INPUT_TOKEN's following protocol newline,
including split CRLF/chunks, without removing the student's prompt spacing.

Notebook photos are bounded, metadata-free static JPEG/PNG files under each
workspace's `images/` folder, at most 1920 pixels per edge and subject to storage
and file-count quotas. Protected previews use current notebook/class access,
including read-only teacher/co-teacher checks. Persist `data-notebook-image`
paths, never tokens, blob URLs, or preview controls. Lazy previews limit parallel
loads and release offscreen/closed image URLs. Removing a photo from a page keeps
the workspace file available in Files; ordinary file deletion remains recoverable
through Trash. Sharing a tab copies referenced photos to the recipient workspace
and checks its quotas rather than granting access to the sender's files.

`connection.js` combines browser online/offline events, the execution socket, and bounded same-origin `/health` probes. Outages keep the editor local and editable, show red page/Shell/file warnings, and block workspace requests and execution. Reconnection saves the retained buffer without reloading its source. Saves are serialized; file opens reject stale account, file, and editor-buffer responses. The close-tab warning applies to an outage or actual unsaved editor/notebook work, so saved connected sessions can exit immediately. No service worker, offline execution, third-party cookies, or browser security-policy relaxation is used. Autocomplete menus pause during outages without changing the saved preference; local indentation and highlighting remain available.

Python and JavaScript runs begin with the Socket.IO `run_code` event. Output returns through `output`, startup is acknowledged by `run_ack`, and completion returns through `finished`. `send_input` and `stop` control the active runner for a socket session.

Run admission is centralized and bounded before a process is created. It enforces global capacity, one active or queued run per authenticated account, constrained guest capacity, start/input rate limits, connection limits, and server memory/disk pressure checks. Excess validated Python, JavaScript, and Step Mode requests enter a bounded in-memory FIFO queue, receive targeted position updates, and are authorized again before promotion. Finished, stopped, failed, disconnected, and administrator-halted runs must release runner/queue state and their admission slot; queued source must never be persisted or exposed in admin status responses.

Assignment AI grading uses a durable background queue sorted by student name for whole-class grading. It processes one submission at a time by default (`EAGLE_ASSIGNMENT_AI_BATCH_SIZE`, bounded by global AI concurrency) so multi-stage beta requests do not compete for a local model and time out; the shared dispatcher remains available to other AI features. Grading JSON contains itemized point deductions, and the server computes the score from those deductions. AI feedback is teacher-only unless the assignment owner enables `shareAiFeedback`; shared browser views use student-facing labels and omit the integrity-review section from the rendered card.
The default legacy grader categorizes deductions as core, objective, execution, or incidental; the saved 1–10 rigor level controls which categories count, caps incidental deductions at two points, and limits no-effort scores. The per-assignment `rubric_beta` mode instead uses only teacher-selected criteria and an explicitly accepted rubric. The `external` mode reuses the selected criteria and validated point rubric but disables the built-in queue. Its owner-only package route exports a system prompt, assignment/rubric, and code keyed only by normalized student email; it excludes stored student names, class/teacher identity, filenames, timestamps, and EagleIDE's generated submission header. Its multipart CSV import requires the exact `student_email,score,feedback` schema and a complete, unique current submission set, then atomically saves scores and feedback. `ASSIGNMENT_GRADING_CRITERIA` in `app.py` supplies the checklist catalog. Rubric generation uses the shared dispatcher and returns an unsaved draft plus a context hash. Accepted plain-text headings use exact criterion labels followed by `(N points)` and a final `Total: N points` line; server validation enforces total/per-criterion budgets and complete selected-criterion evaluation. Description, maximum-score, or checklist changes invalidate acceptance. Queued/running grading settings are fingerprinted so stale results cannot overwrite scores. Browser assignment refreshes preserve unsaved grader drafts. Legacy rigor and automatic deductions never apply to beta or external results.
Each assignment has a stable `createdAt` value for chronological teacher views; legacy records receive a timestamp from their metadata file on first load. The Teacher Dashboard uses a searchable, filterable assignment library beside a workspace with Submissions, Overview, Grading setup, and Manage sections. `teacher-assignments.js` moves the existing bound controls into these sections and groups the create/edit form; mutation handlers remain in `app-core.js` and `assignment-workflow.js`. Grading drafts stay in memory across assignment switches, are scoped to the current authentication context, and are restored only while the saved grading context matches. The dashboard styles live in `features/teacher-assignments.css`. The right-side teacher Assignment tab presents only unlocked assignments from the selected class.

The assignment library and workspace scroll independently. Library cards default to newest first within each folder; open assignments have a distinct highlight. `assignment_organization.py` stores named, flat class folders and assignment memberships atomically under `assignments/.organization/`, using hashed class filenames and the assignment lock. Only the class owner may organize folders; current CoTeachers may read them. Folder deletion moves work to Unfiled without deleting assignments. Drag-and-drop and the Manage section's folder selector use the same protected endpoint, and stale class/account responses must never repaint the current library.

Finalize grading applies to every assignment, not only controlled files. It closes submissions, prevents reactivation/extensions, and purges development databases and obsolete recording bindings. Pending AI grading must finish or be canceled first. Keep all retained submission versions, quiz answers, scores, feedback, and student workspace files. Assignment deletion or class deletion removes the corresponding private submission copies and recording storage; class deletion must not remove another class's data or student workspace files. Creation, copying, class deletion, folder mutations, and finalization share the assignment lock.

`assignment_workflow.py` is registered against the loaded app module and owns assignment file submissions, protected read-only attachment previews, teacher feedback editing, un-submit, and roster accommodation/window routes. Student Resources has collapsed Current/Past cards with personalized deadlines. Private per-class `accommodations[email]` never appear in student class summaries; only that student's effective deadline/note are returned. Extended deadlines skip Saturday/Sunday in the class IANA time zone; `tzdata` supplies zones on hosts without an OS catalog. No-deadline work moves to Past on the ordinary deadline but remains submittable while explicitly unlocked. Weekday submission windows gate files and quizzes equally; an assignment may bypass its class window. Only the class owner manages accommodations/windows/un-submit; class co-teachers may view attachments/history and edit feedback under existing assignment-access checks.

`assignment_development.py` registers clipboard policy and development-history
routes. Class `editor_clipboard` is `allow` (default), `block`, or `outstanding`.
The strictest enrolled-class rule applies across class switches; outstanding means
released work accepting that student's submissions with required files/questions
still missing and attempts remaining. Policy probes share a source-free summary
cache, invalidated by assignment saves. The browser guards code editors, textarea fallback, notebook code,
cut, paste, copy, and dropping text; teacher/admin views remain exempt. This is a
browser deterrent, never an authorship guarantee.

Assignment `fileControl` and `fileControlExtension` are fixed at creation and
require single-file submissions. Provision the collision-safe title-based Home
file once when a released assignment is loaded by its student; never overwrite
or recreate a binding. Submission validation uses that exact workspace identity.
Move/rename/delete/upload guards and Python worker write guards protect the file
through the student's effective deadline (including accommodations/make-ups and
manual reopen), or indefinitely without a deadline until grading completion.
Recording stops at that effective deadline; ordinary editing/saving may continue.
Protected bindings live in `assignments/.development/index.sqlite3`, outside
workspaces. Each assignment's separate SQLite database stores compressed UTF-16
splices, server receipt/device sample times, and checkpoints every 120 changes.
Unchanged code creates no frames. The browser samples changes once per second,
batches every ten seconds, flushes on save/suspension, and keeps a bounded 2 MB
device retry journal. Batches are idempotent and version checked; resynchronization
and direct file saves are labelled. Large changes use the normal save snapshot.
Playback is teacher/co-teacher only, paged to 120 changes with bounded browser
cache and seek reconstruction from checkpoints. `assignment-workflow.js` shares
one playback controller between the history modal and the submission editor's
review bar. Historical editor frames are read-only and bypass autosave; returning
to submitted code restores its source and paste marks. Pause/dispose on file,
student, or account changes and reject late responses. Follow edits scrolls only
when the changed position leaves the viewport, and can be disabled for reading.
Completion minutes measure first-to-last recorded edits, including idle time,
never active typing time. `tests/assignment_playback_ui.test.js` covers playback,
checkpoint seeks, scrolling, lifecycle races, and save/restore safety.
Limits: 2 MB source, 30 frames /
512 KB request, 100,000 frames / 16 MB compressed history per student-assignment,
and a 512 MB server recording budget checked at most every 30 seconds. Limit or
network failures must remain visible and never prevent saving source. Device
times are untrusted; accept bounded delayed uploads up to seven days old.
Owner-only grading completion closes submissions permanently, stops recording,
releases file protection, and deletes the recording database while retaining
bindings, immutable submissions, feedback, and scores. Copy the assignment for a
new recorded attempt. Serialize history access/purge with `_assignment_lock` and
take it before the workspace provenance lock; never recreate a purged recording.

Owner-only `/api/assignments/extend-student` grants/removes an individual make-up
window for a previously released assignment, including locked/past work. Days
mean calendar days from the grant (1–365; 0 removes). During that window only the
selected currently enrolled student bypasses ordinary locks, deadlines, and school
hours, with at least one additional file/quiz attempt if limits were exhausted.
Keep counts, scores, and submission evidence; never globally unlock the assignment
or expose its private `studentExtensions` map to students.

`file-provenance.js` tracks paste events in the student's text editor without
student-facing indicators. `file_provenance.py` stores bounded UTF-16 ranges and
content hashes in private `file_provenance/<workspace>/` sidecars outside student
workspace roots. File saves, moves/Trash/restore, and immutable submitted files
preserve provenance. Teacher previews and the submission editor highlight these
ranges; a locally saved assignment-menu toggle hides highlights and roster flags
for presentations. Public/student submission payloads omit this metadata. This
is an observed paste signal, not proof of outside authorship, AI use, or misconduct;
browser telemetry can be inspected/evaded and does not cover direct attachments,
changes outside the IDE, or historical files. Do not inspect unrelated clipboard
content. Never send pasted content separately or put it into source-file markup.

Written responses can be graded by question across the class using 0/half/full
credit or fractional manual scores. Both manual grading endpoints share locked,
range-checked server updates; browser requests carry the submission revision to
reject stale scores. AI question results reload under that lock and check the
question and submission revision before applying; manual overrides take priority.
Student answers are canonicalized and duplicate/unknown
question IDs and client-supplied scoring fields cannot influence quiz scores.
The reference pane keeps its contents toolbar and a bounded, collapsible current
class agenda above the article. Load the shared lesson-plan renderer before the
wiki reader, guard late class/article responses, and preserve an open reference
article during background home refreshes.
Programmatic main-editor source loads clear CodeMirror history so Undo cannot
restore another file/account's source. Draft saves preserve edits made while the
request is pending, and late teacher submission opens obey the editor/auth guards.

Teacher assignment list responses omit submission source and carry `hasGradableFiles`; opening a file fetches its content separately. Student dashboard source excerpts are capped at 4,000 characters, while protected file previews retain their individual size limits. Keep list rendering and queue/navigation eligibility compatible with these metadata responses.

Attachments of any type are copied into protected class/assignment/student/revision folders (20 files, 25 MiB combined; direct uploads remain subject to the existing 16 MiB HTTP request limit). Python/JavaScript sources have a 2 MiB individual limit and are the only files passed to AI grading; all eligible files from the latest revision are included and Python syntax is checked per file. Unsupported/binary attachments download with an attachment disposition and `nosniff`; text/JSON, paged CSV, and bounded images have read-only previews. Persist latest plus three previous immutable revisions, with teacher-only history access. Quiz resubmissions also snapshot the associated files. Whole submission/attempt/history mutations use `_assignment_lock`; AI results/failures check revision identity before applying. Teacher feedback overrides AI feedback for student sharing, including an intentionally cleared override. Un-submit retains evidence and restores one consumed attempt without deleting history.

Rubric generation uses a compact array JSON schema passed through the dispatcher (`response_schema`) and server-side text formatting, with one bounded correction attempt for invalid model output. Each generated criterion has one expectation of at most 120 characters, with shared partial/no-credit rules; generated drafts are capped at 4,000 characters while teacher edits retain the 12,000-character limit. Creation sends only the saved description, maximum, selected criteria, and prompting/schema, never submissions or browser editor context. Generated point weights are proportionally apportioned to the exact maximum using integer largest remainders; invalid weights remain rejected. Normalization applies only to generated drafts, never teacher acceptance or grading. Valid older structured/string rubric responses remain supported with strict totals. Beta grading verifies coverage/budgets, derives deductions and totals, and rejects copied expectations, generic placeholders, or unsupported full-credit claims. Every ordered result must include concrete source evidence, including full-credit results; scoring uses proportional best-fit judgment and reserves zero for absent or fundamentally incorrect requirements. Small requests use one ordered earned-credit response. Broad rubrics or long submissions inspect every source character in line-labelled evidence chunks, then grade at most six criteria per response and combine validated earned credit server-side; no source truncation is permitted. Each stage gets one bounded correction attempt, and cancellation is checked between stages. Only creation/beta grading opt into `ai_rubric_context_tokens` (admin AI settings, default 16,384, bounded 2,048–65,536). Model context uses a conservative UTF-8-aware token estimate with separate response/template headroom; serialized HTTP bytes have an independent 2 MiB safeguard. Smaller requests allocate less context. Oversized single stages warn without score/rubric mutation. Legacy grading and other AI context defaults remain unchanged. Checklist `rigorLevel` values organize a single-column browser list into four guidance groups without affecting scoring. Generation failures return JSON with `errorCode`, `requestId`, and allowlisted diagnostics; rejected attempts log controlled validation reasons without prompts, code, credentials, or raw output. Invalid output is HTTP 422 (not 502). The browser reports status, endpoint, context/request size diagnostics, and guidance for non-JSON application/proxy responses, including settings-save failures.

- Python: `Runner` writes a temporary script, launches `sandbox_worker.py`, reserves the configured per-run memory, restricts filesystem access to the user's root, and applies import, CPU, process, memory, file, file descriptor, wall-time, write-budget, and output limits. `sandbox_policy.py` permits standard-library, reviewed chart-dependency, and student-workspace imports while keeping process/network/FFI modules locked. On Linux, `sandbox_containment.py` applies Landlock before enabling SQLite, Inspect, NumPy, or Matplotlib. Matplotlib's reviewed `mpl_toolkits` namespace enables static 3D projections without adding a native/browser GUI. `plt.show()` uses Agg and writes uniquely indexed PNG artifacts beside the Python source file, retaining at most 20 per source; new images are announced through `run_artifacts`. Before execution, the worker performs bounded, non-blocking educational checks for protected/private member access; a trusted trace callback checks supported parameter and return annotations at runtime without evaluating student annotations. These checks emit capped `[Warning]` lines and never reject or stop a run. Student tracebacks retain source names and line numbers but redact server and sandbox paths.
- Python Step Mode: `trace_code` uses `TraceRunner` and the same execution admission, authentication, resource limits, module policy, workspace boundary, and `sandbox_worker.py` process as ordinary Python runs. `trace_support.py` records bounded student-file line/call/return/input/exception events with safe value serialization, deterministic AST narration, defined-item metadata, and recorded custom-call boundaries. Imported-module frames remain outside the trace. Trace payloads are framed separately from student output and chunked for Socket.IO delivery. Playback, step-over, and autoplay are browser-side, so navigation never re-executes code or requests captured input again; calls that raised exceptions cannot be stepped over.
- JavaScript: `JsRunner` invokes `js_worker.js` in Node with a restricted `vm` context, a 384 MB V8 heap, a separate 1.5 GB POSIX virtual-address ceiling for V8 startup/native overhead, and CPU, process, wall-time, and output controls. Student globals and I/O wrappers use the VM's own realm; host functions, Errors, and Timeout objects must never be returned. Dynamic imports are denied with a realm-created Error (the VM-module flag is needed to invoke the deny hook); timers return numeric handles and callback/microtask execution is bounded. Node's VM remains defense in depth, not an OS security boundary. Windows Python venv workers launch the actual interpreter directly with only the trusted venv package path so the redirector cannot exceed the one-process Job Object limit.
- Operating-system containment: POSIX runners use process groups, resource limits, lower priority, and per-worker Landlock for native Python modules; Windows runners are assigned to kill-on-close Job Objects with CPU, memory, and active-process limits but native modules fail closed because Landlock is unavailable.
- HTML/CSS: `/api/html-runtime/*` serves files from the user's live workspace. JavaScript is enabled only through an operator-attested, cross-site preview origin; otherwise the preview applies `script-src 'none'` and safely renders HTML/CSS only. See `docs/HARDENING_AND_PERFORMANCE.md`.
- Interactive input: `INPUT_TOKEN` must remain identical in `app.py`, `sandbox_worker.py`, and the browser runtime.

Do not weaken path validation, sandbox restrictions, CSP, resource limits, or process cleanup to make a feature easier to implement. Treat execution code as a security boundary, not just application logic.

## Data and Persistence

CSV reads return metadata followed by `workspace_data.py` pages of at most 50
records and 40 columns, with a 512 KB page-content budget and 256 KB record cap.
Edits stream through a temporary file with version checks, quota enforcement,
and atomic replacement; keep byte-offset remapping and quoted newline handling.
JSON files use the normal bounded text editor plus a lazy tree for files up to
1 MB. Python's reviewed `json` module works with workspace files. Admin Python
execution time is `python_execution_timeout_seconds` (default 30, range 1–300),
sampled when a Python/Step Mode worker starts. JavaScript limits stay separate.
Per-core CPU counters are sampled only while the admin performance menu is
visible; no background collector or persistent history is created.

Checked-in seed/reference data is limited to files such as `challenges.csv` and `exception_help.csv`. Normal application use creates local state including:

- `config.txt` and `.admin_key`
- `users.json`, `classes.json`, and `skills.json`
- `assignments/` (assignment metadata), `assignment_submissions/` (class/assignment
  submission files that do not count against teacher workspace quotas), `notebooks/`,
  `user_files/`, and `sandboxes/`; each user workspace
  has a protected visible `Trash/` folder and private `.eagleide/trash.json`
  restore metadata. Ordinary file-browser and teacher-audit deletes move items to
  Trash, top-level items restore to their original paths, and expired items are
  purged after seven days during startup or file-tree access.
- `lesson_plans/` (weekly plans, class-source mappings, and revocable public-link tokens)
- `background_assets/` (administrator IDE/home backgrounds and per-class home backgrounds)
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

- Accounts, classes, files, assignments, quizzes, mastery, admin, AI, or core API behavior: `app.py` plus the matching section of `app-core.js`. Keep the Trash root protected, use the locked metadata helpers for restore records, and preserve the distinction between recoverable active-workspace deletion and permanent deletion inside Trash.
- Network simulator catalog, permissions, grading, migrations, or storage: `network_features.py`, `network_store.py`, and `network_content.py`. Core browser topology/packet behavior belongs in `network-sim.js`; diagnostics, capture, deterministic traffic, IPv6, dynamic-routing views, and productivity tools belong in `network-sim-advanced.js`; background generation belongs in `network-sim-worker.js`; visuals belong in `features/network-sim.css`. Saved topology schema version 2 supports media-aware ports, parallel links, link properties, IPv6, RSTP, routing protocols, wireless radio settings, stateful policy, and seeded simulation metadata; preserve `migrate_topology()` compatibility when evolving it.
- Raise hand, classroom questions, file sharing, or teacher audit: `classroom_features.py`, `classroom-signals.js`, and/or `classroom-files.js`.
- Notebook prompts and student notes: notebook helpers/routes in `app.py`, `student-notebook.js`, and `features/student-notebook.css`.
- Student mastery dashboard: mastery routes in `app.py`, `student-dashboard.js`, and `features/student-dashboard.css`.
- Weekly lesson plans: `lesson_plan_features.py`, `lesson_plan_store.py`, `lesson-plans.js`, `lesson-plan-renderer.js`, `lesson-plan-public.js`, `lesson_plan_public.html`, and `features/lesson-plans.css`.
- Wiki catalog/search/assets/backup or HTTP authorization: `wiki_store.py` and `wiki_features.py`; reader/teacher actions: `wiki-reader.js`; admin authoring: `wiki-admin.js`; visuals: `features/wiki.css`.
- Editor initialization or teacher stream editor: `editor-init.js`; predictable Enter indentation and folding: `editor-behavior.js`; most run/open/save behavior remains in `app-core.js`. CodeMirror folding uses the pinned CDN fold addons loaded by `index.html`.
- Workspace orientation and viewport sizing: `layout.js`; pointer/keyboard splitters and per-orientation sizes: `app-core.js`. Vertical (side-by-side) is the default; horizontal puts the editor above Shell/Resources and uses a right-hand file-action rail. Orientation and each layout's sizes persist in localStorage. Keep collapse/view controls and splitter ARIA axes working in both orientations.
- Editor occurrences, local lexical diagnostics, delimiter shading, block guides, and caret-line visuals: `editor-feedback.js` and `features/editor.css`. Feedback is bounded, debounced, and browser-local; no student code is sent or executed. Undefined-name hints are advisory Python/JavaScript checks, not full scope analysis. The removed indent-guide toggle must not be restored; guides follow actual blocks. Insert overwrite is disabled in the editable editor (including its textarea fallback), while Shift+Insert keeps paste.
- Autocomplete analysis, popup lifecycle, import/from-module suggestions, and user-symbol inference: `autocomplete.js`; editable Python member help belongs in `autocomplete_metadata.csv`, while the effective import-module list comes from `sandbox_policy.py` through the read-only catalog API in `app.py`.
- Virtual shell parsing: `shell-commands.js`; it must call workspace APIs and must never expose an operating-system shell.
- DOM structure or third-party CDN versions: `index.html`.
- Theme values: `tokens.css`; reusable UI primitives: `components.css`; feature visuals: the matching `features/*.css` file.
- Defaults exposed through `/api/config`: update `config.py` and the fallback `DEFAULT_CONFIG` in `app.py` together.
- Python execution policy: `sandbox_policy.py`, `sandbox_containment.py`, `sandbox_worker.py`, and the `Runner`/admission integration in `app.py`. Keep native modules fail-closed without active Landlock.

When a feature crosses the browser/server boundary, trace and update the full path: DOM element, event binding, request or socket payload, server validation, persistence, response/event, and render state.

## Setup and Startup

Linux LXC (recommended):

```bash
./start.sh
```

The launcher installs supported Debian/Ubuntu or Fedora system prerequisites
when authorized, creates an isolated `.venv`, installs pinned binary wheels
when `requirements.txt` changes, verifies package provenance/versions, reports
Landlock status, validates Node.js 18+, and executes `app.py` with the venv
interpreter. `EAGLEIDE_SETUP_ONLY=1 ./start.sh` performs setup without starting
the server. Landlock must be enabled on the container host and cannot be
enabled by the launcher.

Manual Linux/macOS development:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --only-binary=:all: -r requirements.txt
HOST=127.0.0.1 PORT=8000 python app.py
```

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
node --test tests/*.test.js
```

Focused runs:

```bash
python -m unittest discover -s tests -p test_execution_limits.py -v
python -m unittest tests.test_python_sandbox -v
python -m unittest tests.test_html_runtime -v
python -m unittest tests.test_notebook -v
python -m unittest tests.test_wiki -v
```

The tests patch application globals to temporary directories and restore token maps during teardown. New persistence tests should do the same so real local accounts and classroom data are never touched.

There is no configured linter or frontend build system. Dependency-free frontend
regressions use Node's built-in test runner and Python wrappers; put Node on PATH
to include those checks in the full suite. For browser-facing changes, also start the server and verify:

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
