# October 22 follow-up: PR 1

This bounded follow-up fixes the approved session, ingestion, configuration and
repository-guard issues. It does not close the complete security audit. The
[supplied follow-up report](audit-2026-10-22.md) is attached as a redacted reference;
the original remains outside Git. Its recommendations are not operating
instructions, and its statements about production have not been reverified here.

## Disposition and implementation

| Finding | Status in this PR and exact boundary |
|---|---|
| NEW-A-01 | **Fixed.** Teacher disable persists the disabled account, then calls `_revoke_account_sessions`, disconnecting all of that account's bound sockets. Session issuance collects expired/evicted token IDs under the token locks and disconnects only those tokens after releasing the locks. The five-session cap and other valid sessions remain. Tests cover all four roles, explicit targeted eviction, teacher disable, and HTTP rejection disconnects. |
| EAG-SEC-052 | **Fixed for the reported HTTP fallback.** Student, teacher and wiki-manager guards share `_current_session_user`, require a live enabled account with the matching current role, and return current public profile/membership fields. Missing records no longer authorize from cached token data; rejected known tokens and their sockets are revoked. Role maps remain separate. Co-teacher elevation requires explicit opt-in plus a current student account and membership in both class lists. Route-specific ownership/access checks remain required. No durable device ledger or broader session redesign is claimed. |
| NEW-C-01 | **Fixed for new ingestion.** `_store_background_upload` calls `media_security.clean_image` after existing type/dimension/input-byte checks and checks stored bytes again. This covers admin IDE/Home and teacher class backgrounds. JPEG/PNG/WebP signatures, orientation, animation, frame/pixel budgets and atomic storage remain. Existing media is unchanged; EXIF/GPS/text in previously stored images needs an operator-approved maintenance pass. |
| NEW-C-02 | **Audit claim not reproduced; functional defect fixed.** `_add_security_headers` already adds the enforcing main CSP to the popup response at the audited base. Chrome showed that this policy blocked the popup's inline script, leaving it at “Preparing preview…”. The bootstrap now loads from `static/js/html-runtime-popup.js`, using the route-validated channel ID from a data attribute. CSP, COOP, iframe sandbox, bridge protocol and capability cleanup remain in force. Browser checks exercise ready/load/stop/timeout/exit and cleanup. |
| NEW-D-01 | **Fixed.** Both source defaults use `http://127.0.0.1:11434`. Explicit stored `ai_ollama_url` values win unchanged. A preexisting config that omits this key now inherits localhost; the operator must set its intended remote endpoint before deploying if it previously relied on the old implicit LAN default. No remote host discovery or configuration migration runs. |
| NEW-D-03 | **Fixed for the reported guard gap.** The tracked/staged guard rejects case-insensitive `.db`, `.sqlite`, `.sqlite3`, their `-wal`, `-shm`, `-journal` sidecars, and SQLite header signatures even under renamed files outside known private roots. Diagnostics contain paths/types only. Safe source files remain accepted. This is a preventive guard, not proof that arbitrary data/PII or renamed non-SQLite databases are absent. |
| EAG-SEC-004 / 017 / 020 | **Follow-up hardening of existing controls.** Socket eviction, shared background cleaning and database prevention are extended as described above. This PR performs no repository history analysis, rewrite, credential rotation or old-media migration. |

NEW-A-02/A-03 remain accepted limiter trade-offs; no admin exemption or live-window
eviction is added. NEW-B-02 is a role-scoping observation and NEW-D-02 remains an
existing CSP compatibility trade-off. NEW-B-01 (audit-ledger identity/retention)
remains **Open** for a separately approved lifecycle design.

The other audit findings retain their prior dispositions. In particular, runner OS
isolation and pre-exec limits (030/045), complete erasure/retention (025/026/027/022),
encryption and backups (014/016/019/029), external-grading identifiers (038), parser
sanitization (036), forced password change (006), safe draft disposal (023), share
and print capabilities (039/040), remembered-device revocation (005), and workspace
identifier migration (049) are not implemented by PR 1. They remain engineering
or design work, not tasks silently reassigned to the operator.

## Compatibility and validation

There is no data schema change, automatic migration, file relocation, background
purge, password change, dependency update or production operation in this PR.
Existing explicit AI endpoints and media references are retained. Ordinary
authorized users keep the same API and UI flows. Intended visible changes are
immediate disconnection after disable/eviction, rejection of stale account/role
sessions, cleaned new backgrounds, and working HTML popup controls under CSP.

The frequent file auth path deliberately omits co-teacher catalog enumeration;
`/api/auth/me` still returns the full current UI profile. The existing performance
regression verifies that opening one file does not copy unrelated class rosters.
Old tests that injected tokens without accounts now create real temporary account
records, preserving their original authorization assertions.

Validation on Windows with Python 3.12 and the current hash-locked dependencies:

- Baseline: 523 Python tests (one Linux-only native-containment skip), 204 Node tests.
- Updated full suites: 533 Python tests (one Linux-only native-containment skip)
  and 204 Node tests pass; Linux/Landlock runs in required GitHub CI.
- Focused tests cover every changed security boundary and rejection preserving
  existing configuration/assets, profile membership freshness, role separation,
  orientation/animation, and force-staged database content without content logging.
- Chrome: enforcing main CSP, inert direct HTM/SVG, opaque preview storage, hidden
  file denial, anonymous AI denial; popup lifecycle/cleanup and desktop/mobile;
  two live student sockets disconnected by teacher disable with editor buffer
  retained and teacher connection usable.
- Existing wiki-manager browser smoke: admin account creation, login/restore,
  publish/edit, account controls, Python execution, audited rollback, and
  desktop/tablet/mobile light/dark layouts and Home scrolling.

Logs and screenshots stay outside Git. See the PR checks/body for final counts
and the exact commit's Linux CI result. Browser tests use only disposable loopback
fixtures; they do not connect to the classroom deployment.

## Operator rollout: required steps

1. **Before updating, inspect the saved Ollama setting privately.** In the current
   Admin AI settings, save the intended URL explicitly. A missing key will change
   its effective endpoint from the old LAN default to localhost. Explicitly saved
   remote URLs do not change. Test AI from the deployment after updating.
2. **Use a maintenance window after required CI passes and the PR is merged.** Ask
   users to save/sync or download pending work and finish active runs. Take a
   private backup of configuration, the device key and mutable application data.
   Deploy the merged source and its new static script together using the existing
   update process. Do not overwrite runtime files with this checkout's fixtures.
3. **Perform one normal restart.** EagleIDE is a single process; this PR cannot
   promise a zero-downtime restart. Running jobs/sockets end and in-memory sessions
   clear as on any restart. Remembered devices can restore normally if their
   credentials/key are still valid. No added migration command is required.
4. **Smoke-test before reopening class:** health, each account role's sign-in,
   workspace save/reopen, Python/JavaScript execution, a notebook, configured
   external apps, background upload, HTML popup Run/Stop/Exit, and AI if used.
   Test disable/re-enable with a disposable account: disable disconnects it;
   re-enable requires a fresh sign-in. A sixth sign-in closes the oldest session.
5. **Rollback if needed:** restore the prior source/static release together and
   restart, retaining current runtime files. This PR changes no stored schema.
   Rollback restores the reported authorization gaps and old implicit AI default;
   treat it as a temporary recovery measure and retain the private backup.

Previously assigned owner actions remain independent: production port-8000
bind/firewall and Cloudflare policy, production Node upgrade, dry-run/backup/apply
of the existing legacy-password migration, key custody, prior-image cleanup, and
GitHub Support PR-ref/cache removal. No claims about their completion are made.
Do not run the migration/image tools automatically as part of this update.
