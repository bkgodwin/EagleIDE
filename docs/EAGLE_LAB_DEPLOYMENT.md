# Embedded Eagle Lab deployment

Students use EagleIDE's existing public HTTPS address to reach PVE servers on
the EagleIDE host's LAN. The embedded workspace carries PVE management on HTTPS
port 8006, API writes, uploads/downloads, xterm.js terminals and nested noVNC
console WebSockets. Browsers never connect directly to the private PVE address.

## Existing address, automatic relay

Run `./start.sh` or `python app.py` normally. Node.js 18+, already required by
EagleIDE, is sufficient; no npm install is needed. The launcher automatically
starts the relay on the existing `HOST`/`PORT` and moves Flask to a private,
automatically selected loopback port. The existing public tunnel continues to
target the same port, such as `http://127.0.0.1:8000`.

No new hostname, public port, certificate or per-server tunnel route is required.
The existing tunnel must forward all paths, preserve Host and support WebSocket
upgrades. Use trusted public HTTPS, disable caching of protected responses, and
avoid authentication interstitials inside frames. EagleIDE does not alter DNS,
firewalls or tunnel configuration. The EagleIDE host must be able to reach each
enrolled PVE server over its LAN; PVE does not need public exposure.

```text
School device on WAN → existing EagleIDE HTTPS address → EagleIDE relay → LAN PVE:8006
```

Ordinary EagleIDE requests and Socket.IO use the same listener. A private
process key authenticates peer-address restoration before existing trusted-proxy
rules; incoming callers cannot supply that key. Use the normal single-process
launcher. Custom multi-worker WSGI hosting is not supported by this relay or its
in-memory authorization sessions.

PVE documents remain in an **opaque sandbox**, enforced by both the iframe and
response CSP, including when a capability URL is opened directly. PVE cannot
read EagleIDE's DOM, browser storage or account tokens. A one-use POST launch
creates a random session path; treat this path as private. Referrers and caches
are disabled. Only the enrolled destination can be proxied, and authority is
rechecked throughout active transfers and consoles.

The compatibility runtime maps root-relative PVE resources, API requests and
console WebSockets into that path. PVE cookies and browser preferences are held
in bounded server-side memory for this session. No PVE cookie is installed on
EagleIDE's browser origin. Refresh retains the PVE login/preferences; disconnect,
expiry or restarting EagleIDE requires reconnecting. This transient state is
separate from saved assignments and report drafts. Native password/PAM/PVE
authentication is used; origin-bound WebAuthn, third-party SSO and native viewer
workflows are not covered by the browser fixture.

## Administrator and teacher setup

1. Enable Eagle Lab in Settings → Eagle Lab.
2. Enroll the node's RFC1918 IPv4 address, PVE HTTPS port, PVE username/password,
   and certificate policy. Self-signed upstream TLS can be trusted per node;
   traffic remains encrypted. Use a valid PVE certificate when verification is on.
3. Set an optional **4–12 digit student server PIN**. Blank on edit preserves it;
   Remove existing PIN clears it. Only password hashes are stored. Provide each
   student/group only its assigned PIN.
4. The class owner enables access in Dashboard → Eagle Lab, selects the servers,
   and decides whether students can reveal credentials. Admin and owning teacher
   access does not require a student PIN.
5. Students select a server, enter its PIN, and Connect. The embedded workspace
   provides Exit, Credentials, clipboard hints and continuous lab report windows.
   Reports autosave independently of console traffic.

The launch ticket expires after 60 seconds and is exchanged once by POST. Proxy
sessions last at most four hours and never outlive the EagleIDE login. Editing a
server/PIN, removing class access, global disablement, or revoking the EagleIDE
login stops delivery. Active transfers and WebSockets recheck within about two
seconds plus the bounded authorization timeout. Exit revokes that user's node
sessions. PVE authentication and native permissions remain in force.

PINs control entry to a relay destination. Shared root credentials can still
control other nodes in the same cluster through PVE's API. Use dedicated PVE
users/roles/ACLs or independent lab clusters for resource isolation. A PIN cannot
change a PVE password a student already knows.

## Clipboard and consoles

The opaque PVE window delegates text copy/paste through a session-keyed broker
in the EagleIDE page. Public HTTPS, focus and browser clipboard permission are
required; school device policy still applies. No EagleIDE account data is sent
to PVE.

- Host/LXC terminals: select xterm.js and use Ctrl+Shift+C / Ctrl+Shift+V (Cmd on
  macOS where supported).
- Graphical VMs: use noVNC's clipboard panel when the PVE version and guest
  support it. Guest clipboard integration remains a guest/PVE capability. A
  configured serial terminal is an alternative for text work.
- WSS console connections preserve binary frames, subprotocols and query tickets
  through the existing public address. SPICE requires its external native client;
  use browser noVNC on school devices.

## Existing separate-hostname deployments

Deployments already setting `EAGLEIDE_LAB_PROXY_DOMAIN` retain the previous
separate-origin mode automatically. To use the existing address instead, set
`EAGLEIDE_LAB_TRANSPORT=path` and restart; old wildcard routes can then be retired
by the operator. No lab catalog or assignment migration is required.

Optional separate-origin configuration remains supported:

```sh
EAGLEIDE_LAB_TRANSPORT=origin
EAGLEIDE_PUBLIC_ORIGIN=https://code.school.example
EAGLEIDE_LAB_PROXY_DOMAIN=pve.school.example
EAGLEIDE_LAB_GATEWAY_PORT=8010
```

In this mode Flask keeps its original listener and Node listens on loopback
8010. Route `*.pve.school.example` to `http://127.0.0.1:8010`, preserve Host and
WebSockets, and use a trusted certificate covering that wildcard. Only
`s-<32-character enrolled server ID>.pve.school.example` hosts are accepted.
Keep the proxy in the same host/network namespace. `EAGLEIDE_LAB_INTERNAL_URL`
can override the loopback HTTP authorization callback in this mode. PVE session
cookies are host-only, Secure, HttpOnly, partitioned; school browsers must permit
them. The parent delegates clipboard/fullscreen. Separate-origin mode retains
its cookie bridge and does not use the opaque path runtime.

`EAGLEIDE_LAB_TRANSPORT=disabled` restores the direct Flask listener and disables
embedded launches. It does not remove lab data or change the global/class rules.

## Limits and data preservation

The relay streams requests/downloads with a 2 GiB upload cap, 32 MiB maximum
rewritten HTML/JS/CSS response, 128 active transfers globally and 16 per session.
HTTP asset bursts queue for up to 15 seconds, bounded at 256 global/64 per session;
WebSocket admission is immediate. There are at most 128 pending authorization
calls. Control calls time out after four seconds, upstream HTTP inactivity after
two minutes and WebSocket handshakes after 15 seconds. Path profiles are limited
to 2,048 sessions, 128 KiB each, including at most 32 KiB of PVE cookies.

No account, class, assignment, submission, report or PVE disk data is migrated or
deleted by this listener change. Existing nodes without PINs keep that setting.
Use the existing private backup workflow for `lab_data/catalog.json` together
with `lab_data/secret.key`, assignments and report drafts. Never commit them.

## Acceptance check on the installation

From outside the LAN: sign in, unlock a node, load the PVE interface and sign in
to PVE. Open a host/LXC xterm.js terminal and a VM's nested noVNC console. Check
clipboard and report save/close/reopen. Attempt another node without its PIN.
Change a PIN or disable class access while a console is open and verify it
disconnects. Check uploads/downloads within gateway/tunnel limits. Synthetic
tests exercise these protocols; real PVE versions, certificates, school policies
and guest behavior require this acceptance check on the actual installation.

## Optional isolated browser checks

With Playwright/Chromium installed for development, run
`EAGLE_LAB_TEST_TRANSPORT=path node tests/eagle_lab_browser_checks.mjs`, then use
`EAGLE_LAB_TEST_TRANSPORT=origin` for legacy mode. The fixture generates an
ephemeral test TLS certificate and starts synthetic loopback PVE/portal services.
It does not alter DNS, certificate stores, live accounts/configuration or PVE.
It checks PIN denial, isolated login/refresh/preferences, clipboard, module-based
nested binary consoles, report recovery, mobile/themes and live revocation.

`EAGLE_LAB_TEST_PYTHON` selects the venv Python;
`EAGLE_LAB_PLAYWRIGHT_MODULE` selects an installed Playwright module;
`PLAYWRIGHT_BROWSERS_PATH` selects its browser cache; `EAGLE_LAB_SCREENSHOT`
selects an optional private scratch screenshot. The temporary browser context
grants clipboard permission to exercise the browser permission flow.
