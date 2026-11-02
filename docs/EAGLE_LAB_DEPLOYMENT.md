# Embedded Eagle Lab deployment

EagleIDE serves the Lab page, assignment reports, authentication and class rules.
A Node gateway beside Flask carries the PVE management interface, HTTP API writes,
uploads/downloads, xterm.js terminals and nested noVNC console WebSockets to the
enrolled PVE LAN address (normally HTTPS port 8006). The student's browser never
connects directly to the LAN address.

## Public HTTPS routing

Use separate proxy hostnames so PVE scripts cannot read EagleIDE's DOM, storage,
or session tokens. One wildcard route serves all enrolled nodes through the same
loopback listener; no per-node public ports are needed. Example environment:

```sh
EAGLEIDE_PUBLIC_ORIGIN=https://code.school.example
EAGLEIDE_LAB_PROXY_DOMAIN=pve.school.example
EAGLEIDE_LAB_GATEWAY_PORT=8010
```

Set these in the environment that starts `./start.sh` or `python app.py`, then
restart EagleIDE. The normal launcher starts Node automatically when the proxy
domain is configured. Without these settings, existing EagleIDE deployments
continue normally and embedded connections show a setup message. Node.js 18+
already required by EagleIDE is sufficient; no npm install is needed.

Configure the existing reverse proxy/tunnel with these routes:

| Public hostname | Backend on the EagleIDE host |
| --- | --- |
| `code.school.example` | existing EagleIDE listener, e.g. `http://127.0.0.1:8000` |
| `*.pve.school.example` | `http://127.0.0.1:8010` |

The gateway accepts only `s-<32-character enrolled server ID>.pve.school.example`.
Preserve the original Host header and forward WebSocket upgrades. Terminate
HTTPS with a certificate trusted by school devices covering these exact nested
hostnames (`*.pve.school.example`). A wildcard for `*.school.example` does not
cover them. Keep gateway traffic uncached, including launch POSTs, HTML and JS.
Do not add an authentication redirect or an interstitial inside the iframe.

The gateway binds **127.0.0.1 only**. Keep the tunnel/proxy on the same host or
network namespace. Containers hosting the tunnel separately need an operator-
managed loopback transport; publishing 8010 broadly is not a substitute. The
school's tunnel service must support the wildcard route, required TLS certificate
and WebSockets. If it cannot, provision individual proxy hostnames/certificates
using its normal supported configuration. EagleIDE does not change DNS, tunnel
configuration, certificates or firewall rules automatically.

The gateway's private authorization callback defaults to Flask's configured
`PORT` on loopback. An advanced deployment may set
`EAGLEIDE_LAB_INTERNAL_URL=http://127.0.0.1:8000`; only loopback HTTP is accepted.
Use the normal single-process launcher so both services share the same in-memory
EagleIDE auth sessions. Custom multi-worker WSGI hosting is not supported for the
gateway. Neither the control key nor an EagleIDE auth token belongs in tunnel
configuration, browser URLs, PVE headers or the enrolled catalog.

## Administrator and teacher setup

1. Enable Eagle Lab in Settings → Eagle Lab.
2. Enroll the node's RFC1918 IPv4 address, PVE HTTPS port, PVE username/password,
   and certificate policy. Self-signed upstream TLS can be trusted per node;
   traffic remains encrypted. Use a valid PVE certificate when verification is on.
3. Set an optional **4–12 digit student server PIN**. Blank on edit preserves the
   existing PIN; Remove existing PIN clears it. Hashes, never plaintext PINs, are
   stored. Provide each student/group only its assigned PIN.
4. The class owner enables access in Dashboard → Eagle Lab, selects the servers,
   and decides whether students can reveal credentials. Admin and owning teacher
   access does not require a student PIN.
5. Students open Eagle Lab, choose a server, enter its PIN, and Connect. The thin
   workspace bar provides Exit, Credentials, clipboard hints and lab reports.
   Reports open above PVE and autosave independently of console traffic.

Entering a correct PIN creates a short-lived one-use launch ticket. A form POST
exchanges it for an HttpOnly, Secure, host-only, partitioned session cookie; the
ticket is never placed in the iframe URL. The gateway forwards only the current
server's namespaced PVE session cookie upstream. PVE login still uses native PVE
authentication; no root login or PVE authorization is bypassed.

Changing a PIN or editing/removing the server invalidates existing capabilities.
Removing class/server access, global disablement, or revocation/expiry of the
originating EagleIDE login also stops delivery. Active HTTP transfers and binary
WebSockets recheck within about two seconds, plus the bounded control timeout.
Exit destroys the frame and revokes that user's gateway sessions for that node.
School browsers must allow partitioned cookies and the site's embedded content.

## Clipboard and consoles

Use trusted HTTPS for **both** the portal and proxy hostnames. The frame delegates
clipboard read/write and fullscreen, and the relay preserves PVE's session/CSRF
flows, console query tickets, binary WebSocket subprotocol and frame nesting.

- For host and LXC terminals, choose xterm.js and use Ctrl+Shift+C / Ctrl+Shift+V
  (Cmd on macOS where supported). Browser clipboard permission and focus rules
  still apply; school browser policy must permit the operation.
- For graphical VMs, use PVE/noVNC's clipboard panel when the guest and PVE version
  support it. Guest clipboard support is a guest/PVE capability, not something a
  web proxy can add. A configured serial console with xterm.js provides a text
  alternative. Test your actual guest image before assigning clipboard work.
- noVNC and terminal WebSockets use WSS on the public side and TLS to PVE. Raw
  binary frames and tickets pass unchanged. SPICE's external native viewer is a
  separate client/network workflow; use the browser noVNC view on school devices.

## Limits and data preservation

The relay streams requests/downloads, with a 2 GiB upload cap, 32 MiB maximum
rewritten HTML/JS response, 128 active transfers globally and 16 per session.
Control calls time out after four seconds; upstream HTTP inactivity after two
minutes, and handshake after 15 seconds. Proxy sessions last at most four hours
and never outlive the originating EagleIDE login. Launch tickets expire after
60 seconds. A restart invalidates gateway sessions; reconnect from Eagle Lab.

Existing PVE servers without PINs remain without PINs until explicitly edited.
Existing assignment/account/workspace/submission data is retained. Back up
`lab_data/catalog.json` with `lab_data/secret.key` and assignment/draft storage
using the existing private backup workflow. Do not commit these files.

PINs protect entry to the relay, not PVE's native permission model. Shared root
credentials may control every node in a PVE cluster through an assigned node's
API. Use dedicated PVE users/roles/ACLs (or independent lab clusters) when students
must be unable to modify other students' resources. Keep PVE management addresses
private and isolate the lab network from the EagleIDE host's other services.

## Acceptance check after routing

From a device outside the LAN: sign in, enter a node PIN, load the complete PVE
interface, sign in to PVE, open a host/LXC xterm.js terminal, and open a VM's
nested noVNC console. Check clipboard and report save/close/reopen. Attempt a
different node without its PIN. Disable class access or change the PIN while a
console is open and confirm disconnection. Check downloads/uploads within the
gateway and tunnel's limits. Synthetic transport tests cover these protocols;
deployed certificates, school device policy and real guest behavior require this
acceptance check on the actual installation.

## Optional isolated browser check

With Playwright/Chromium available in a development environment, run
`node tests/eagle_lab_browser_checks.mjs`. It generates an ephemeral test-only
TLS certificate through Python, starts synthetic loopback PVE/portal/proxy
servers and maps reserved `.test` hosts inside Chromium. It does not modify DNS,
certificate stores, live configuration, accounts or PVE nodes.
`EAGLE_LAB_TEST_PYTHON` selects the project venv Python;
`EAGLE_LAB_PLAYWRIGHT_MODULE` optionally selects an installed Playwright module;
`PLAYWRIGHT_BROWSERS_PATH` selects a browser cache and `EAGLE_LAB_SCREENSHOT`
selects an optional private scratch screenshot. No generated TLS key is saved.
The fixture explicitly grants clipboard permission in its temporary browser
context to model the user permission flow. Browser permissions still follow the
[Clipboard API](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API)
and [Permissions Policy](https://www.w3.org/TR/permissions-policy/) requirements.
