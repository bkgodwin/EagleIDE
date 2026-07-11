# EagleIDE Hardening and Performance Guide

## What is protected

EagleIDE applies admission control before starting student code, limits one active run per signed-in account, constrains guest use, and rejects work when the host is short on memory or disk. Python and JavaScript runners have CPU, memory, process, file, output, and wall-time limits. Process trees are terminated when runs stop, clients disconnect, or the server exits.

AI calls use a separate bounded pool. They have per-identity request limits, prompt and response caps, connection/read timeouts, short-lived duplicate-response caching, and a circuit breaker after repeated Ollama failures. AI congestion therefore cannot consume code-run capacity.

Socket.IO uses standard threaded mode with `simple-websocket`, exact same-origin validation, bounded message sizes, connection limits, and heartbeat timeouts. Classroom presence updates are event-driven; 30-second polling remains only as recovery for missed events.

Browser output is bounded and batched. Hidden tabs pause recovery polling, teacher editor updates are coalesced, notebook and shell output are capped, and static assets use short conditional browser caching.

## HTML preview isolation

An iframe timeout cannot stop a synchronous infinite loop. EagleIDE therefore enables student JavaScript previews only when the operator configures a separate, cross-site preview origin. Without that origin, HTML and CSS still render, but the response enforces `script-src 'none'`.

For full HTML, CSS, and JavaScript preview features, create a second DNS name on a different site from the main application and route it to the same EagleIDE service. Do not use a subdomain of the primary application site; browser process isolation is site-based. A practical deployment uses unrelated hostnames such as `ide.school.example` and `eagle-preview.example.net`.

Set both variables on the EagleIDE service:

```text
EAGLE_HTML_PREVIEW_ORIGIN=https://eagle-preview.example.net
EAGLE_HTML_PREVIEW_ISOLATED=1
```

`EAGLE_HTML_PREVIEW_ISOLATED=1` is an operator attestation that the origin is genuinely cross-site and is routed directly to EagleIDE. The preview origin must not share authentication cookies with the main application, must not host trusted school applications, and should be protected by the same TLS and reverse-proxy request limits. Student preview sessions use random capability URLs and expire automatically.

After deployment, verify that the preview iframe URL uses the preview hostname and that the browser places it in a separate renderer process. If the variables are absent or invalid, the safe script-disabled fallback is intentional.

## Capacity settings

Tune only after measuring the host under classroom load:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `EAGLE_MAX_CONCURRENT_RUNS` | half of CPU cores, capped at 4 | Global Python/JavaScript runner slots |
| `EAGLE_MAX_GUEST_RUNS_PER_IP` | 2 | Guest runner slots per address |
| `EAGLE_MAX_RUN_STARTS_PER_10_SECONDS` | 6 | Run-start burst limit per identity |
| `EAGLE_MAX_SOCKET_CONNECTIONS` | 512 | Global realtime connections |
| `EAGLE_MAX_SOCKET_CONNECTIONS_PER_IP` | 128 | Realtime connections per address |
| `EAGLE_MAX_CONCURRENT_AI_REQUESTS` | 2 | Concurrent Ollama calls |
| `EAGLE_MAX_AI_REQUESTS_PER_MINUTE` | 6 | AI calls per signed-in identity or address |
| `EAGLE_MAX_AI_PROMPT_CHARS` | 64000 | Maximum composed AI prompt |
| `EAGLE_MAX_AI_RESPONSE_CHARS` | 64000 | Maximum accepted AI response |
| `EAGLE_MAX_AI_HTTP_RESPONSE_BYTES` | 2097152 | Maximum Ollama HTTP response body |
| `EAGLE_AI_CIRCUIT_FAILURES` | 3 | Failures before opening the AI circuit |
| `EAGLE_AI_CIRCUIT_COOLDOWN_SECONDS` | 30 | Circuit-breaker recovery delay |

Increasing runner or AI concurrency raises peak CPU and memory use. Change one setting at a time and repeat the same load test.

## Reverse proxy requirements

Use TLS, preserve WebSocket upgrades, apply request-body and slow-client timeouts, and keep sticky routing if multiple EagleIDE instances are introduced. Do not expose the Flask development server directly to the internet. Keep the main and preview hostnames on the same EagleIDE release but separate browser sites.

For multiple application instances, move ephemeral tokens, Socket.IO coordination, and admission counters into a shared trusted store before enabling load balancing. Until then, run one EagleIDE application instance per deployment; adding independent instances would weaken global quotas and session consistency.

## Monitoring and load-test acceptance

The admin server-health response reports execution admission totals, active HTML sessions, and AI active/capacity/rejection/failure/cache/circuit metrics. During a load test, verify:

1. Infinite Python and JavaScript runs stop within their limits and release capacity.
2. Output floods stop at byte or line limits without growing the browser indefinitely.
3. Excess runs and AI calls receive a clear busy or rate-limit response while ordinary page requests remain responsive.
4. Disconnecting clients removes child processes and presence state.
5. HTML JavaScript runs only on the cross-site preview origin; the fallback sends `script-src 'none'`.
6. Memory and disk pressure reject new execution before the host becomes unstable.
7. Sign-in, files, assignments, notebooks, classroom streaming, quizzes, and AI recover normally after the stress period.

Record p50, p95, and p99 response time, rejected-work counts, process count, CPU, memory, disk, network throughput, and browser memory. A successful test has bounded resource use, no orphan processes, no server restart, and no loss of saved work.

## Rollback and incident response

If load causes instability, first lower `EAGLE_MAX_CONCURRENT_RUNS` and `EAGLE_MAX_CONCURRENT_AI_REQUESTS`, then disable AI or HTML runtime through admin settings if necessary. Preserve logs and the admin health snapshot. Do not weaken sandbox, CSP, origin, process, or path restrictions as a recovery shortcut.
