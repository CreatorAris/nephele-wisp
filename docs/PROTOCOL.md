# Wisp Protocol v1

The wire protocol between Nephele Workshop (desktop) and the Wisp
extension (browser). This document is the authoritative contract —
any behavior change MUST update this file in the same commit.

## Transport

Native Messaging over stdio, as specified by Chrome's Native Messaging
API. Messages are UTF-8 JSON preceded by a 32-bit little-endian length
prefix. Chrome enforces a 1 MB per-message cap (binary assets are
transferred out-of-band, see "Large Binary Transfer").

```
[4 bytes: uint32 LE message length] [N bytes: UTF-8 JSON payload]
```

Nephele registers a Native Messaging Host named
`com.arisfusion.nephele_wisp`. The manifest's `path` field points at
`%NEPHELE_INSTALL%\nephele.exe --nmh`. The extension initiates the
connection via `chrome.runtime.connectNative("com.arisfusion.nephele_wisp")`.

## Topology

The desktop side of the bridge is split across two processes:

1. **NMH subprocess** — spawned by Chrome/Edge per Native Messaging
   connection. Owns stdio with the browser. Handles `system.*` requests
   locally (handshake, heartbeat) without needing any other process.
2. **Nephele Workshop UI process** — the long-running desktop app.
   Handles business requests (`publisher.*`, `creator.*`, `inbox.*`,
   `scheduler.*`). Exposes a local TCP server on `127.0.0.1` using the
   same framed JSON envelope as the browser wire protocol.

Message flow for a business request:

```
Browser extension
    ⇅ stdio (framed JSON)
NMH subprocess
    ⇅ TCP 127.0.0.1:<port> (framed JSON, identical envelope)
Nephele UI process (business handlers)
```

`system.*` messages terminate at the NMH subprocess — the UI is not
consulted, so handshake succeeds even if the UI is closed.

Any non-`system.*` request when the UI is absent returns
`NEPHELE_NOT_RUNNING`. The extension surfaces this as a
"Nephele Workshop is not running" hint, and the desktop side SHOULD
NOT auto-retry — the user launches Nephele and retries manually.

### Endpoint discovery

On startup, the Nephele UI process:

1. Binds to `127.0.0.1` on an OS-assigned port.
2. Writes `%APPDATA%\Nephele\nmh\endpoint.json`:
   ```json
   {
       "host": "127.0.0.1",
       "port": 54321,
       "pid": 12345,
       "started_at": "2026-04-20T12:34:56Z"
   }
   ```
3. Deletes this file on clean exit.

Stale `endpoint.json` from crashes is tolerated — the NMH subprocess
attempts to connect and treats connection refusal as UI-not-running.

The NMH subprocess reads `endpoint.json` lazily (on the first
non-`system.*` request) and keeps the TCP connection open for the
lifetime of the browser connection.

### Namespace gate

NMH enforces which request type namespaces are forwarded:

- Forwarded: `publisher.*`, `creator.*`, `inbox.*`, `scheduler.*`
- Local (NMH-handled): `system.*`
- Anything else: `INVALID_PAYLOAD` (rejected at NMH layer — prevents
  extension/UI schema drift from silently opening new attack surface)

New business namespaces are introduced in a single commit that updates
this gate, this document's Type Catalog, and the UI-side handler set.

## Envelope

Every message is a JSON object:

```json
{
    "v": 1,
    "id": "msg_01HGZK...",
    "kind": "request",
    "type": "publisher.upload_draft",
    "payload": { }
}
```

- `v` — protocol version, currently `1`. Both sides MUST reject
  unknown versions.
- `id` — ULID. Requests generate one; responses echo it.
- `kind` — `request` (expects response), `response` (reply to a
  request), or `event` (one-way notification, no response).
- `type` — domain-specific message type. Lowercase snake case,
  dot-separated namespace (e.g. `publisher.upload_draft`,
  `creator.fetch_stats`).
- `payload` — type-specific body.

Responses carry either `payload.result` (success) or `payload.error`:

```json
{
    "v": 1,
    "id": "msg_01HGZK...",
    "kind": "response",
    "type": "publisher.upload_draft",
    "payload": {
        "error": {
            "code": "AUTH_REQUIRED",
            "message": "User not logged in on bilibili.com"
        }
    }
}
```

## Handshake

Immediately after `connectNative`, the extension SHALL send:

```json
{
    "v": 1, "id": "...", "kind": "request", "type": "system.hello",
    "payload": {
        "extension_version": "0.4.0",
        "extension_build_sha": "abc123",
        "browser": "chrome",
        "browser_version": "131.0.6778.86",
        "user_profile_id": "<hashed, stable per profile>"
    }
}
```

Nephele MUST respond:

```json
{
    "v": 1, "id": "...", "kind": "response", "type": "system.hello",
    "payload": {
        "result": {
            "nephele_version": "0.4.0",
            "protocol_version": 1,
            "compatible": true,
            "session_token": "<opaque, this connection only>"
        }
    }
}
```

If `compatible: false`, the extension SHOULD surface an in-product
"update required" prompt and disconnect. `session_token` is used by
asset-transfer endpoints below.

Heartbeats (`system.heartbeat`) flow in both directions every 60s.
Missing three consecutive heartbeats triggers reconnect.

## Type Catalog

### v1 — ships with Nephele v0.4 beta

Scope: B站 draft upload.

| Type | Direction | Purpose |
|---|---|---|
| `system.hello` | ext → neph | handshake |
| `system.heartbeat` | both | liveness |
| `system.disconnect_reason` | either | graceful disconnect notice |
| `publisher.upload_draft` | neph → ext | fill upload form on a platform |
| `publisher.progress` | ext → neph | step-by-step progress event |
| `publisher.captcha_detected` | ext → neph | pause, user action required |
| `publisher.captcha_resolved` | neph → ext | user confirmed, resume |
| `publisher.draft_ready` | ext → neph | draft saved, awaiting user publish |

### v2 — ships with Nephele v0.4.1

Scope: creator dashboard data ingest.

| Type | Direction | Purpose |
|---|---|---|
| `creator.fetch_stats` | neph → ext | pull dashboard metrics |
| `creator.fetch_works_list` | neph → ext | list user's own posted works |
| `creator.stats_updated` | ext → neph | periodic push from `chrome.alarms` |

### v3 — ships with Nephele v0.5

Scope: inbox (comments + DMs), scheduled publishing.

| Type | Direction | Purpose |
|---|---|---|
| `inbox.fetch_comments` | neph → ext | pull comments for a work |
| `inbox.fetch_dms` | neph → ext | pull DMs |
| `inbox.reply` | neph → ext | post a user-composed reply |
| `inbox.new_message` | ext → neph | push notification |
| `scheduler.execute` | neph → ext | run a pre-scheduled publish now |

Versioning rule: additive changes (new types, new optional fields) do
NOT bump `v`. Removing types or changing semantics of existing fields
bumps `v`, and both sides negotiate via handshake `compatible`.

## Request / Response Pattern

Default timeout: 60s. Publishing flows (which may wait for captcha)
use 300s. Timeout produces an error response with code `TIMEOUT`;
the caller MUST NOT auto-retry — retry is user-driven.

## Event Pattern

Events are fire-and-forget. Recipients MUST NOT respond. Events carry
no delivery guarantee; important state changes SHOULD additionally be
fetchable via a `fetch_*` request for reliable reconciliation.

## Humanization Pipeline (non-negotiable)

Every message whose type namespace is `publisher.*`, `inbox.reply`, or
`scheduler.execute` — and any future type causing a write on a
third-party page — is processed by the extension-side Humanization
Pipeline. The pipeline wraps all DOM mutations:

1. **Pre-action delay** — `Uniform(200, 800)ms` before any
   mouse/keyboard dispatch.
2. **Mouse jitter** — target coordinate offset by Gaussian noise
   `σ=1.5px`, clamped to element bounding box.
3. **Move-then-click** — always dispatch `mouseMoved` before
   `mousePressed`, with 50–150ms gap.
4. **Typing cadence** — per-character `Input.dispatchKeyEvent` with
   inter-key delay sampled from `Normal(μ=130ms, σ=40ms)`, clamped to
   `[60ms, 400ms]`.
5. **Step dwell** — between distinct form steps,
   `Uniform(800, 3000)ms`.
6. **Schedule jitter** — scheduled actions fire at
   `target_time + Uniform(-15min, +15min)`.

These rules are NOT configurable by the desktop side. The extension
enforces them regardless of what Nephele requests. A desktop message
requesting faster execution returns `INVALID_PAYLOAD`.

## Rate Limits

Hard caps enforced per platform by the extension. Not overridable.

| Scope | Limit |
|---|---|
| Publishes / day / platform | 5 |
| Replies / day / platform | 50 |
| Creator stats poll / hour / platform | 4 |
| Search queries / hour / platform | 10 |

Exceeding a limit returns `RATE_LIMITED` synchronously. The desktop
side MUST surface this to the user without auto-retrying.

## Circuit Breaker

Any of the following triggers a 24-hour cooldown for the affected
platform. All requests to that platform during cooldown fail with
`PLATFORM_COOLDOWN`:

- Captcha / human verification detected (geetest, reCAPTCHA, ...)
- HTTP 403 / 429 from the platform's own endpoints
- DOM structure unrecognized (expected selector missing after
  human-paced retries)
- Account anomaly banner detected

Cooldown stored in `chrome.storage.local` keyed by
`cooldown:<platform>`. User may clear it manually via the extension
options page (the clear action is logged to the same storage for
audit).

## Large Binary Transfer

Images and videos exceed the 1 MB Native Messaging cap. Nephele runs
a localhost HTTP asset server on a random port chosen per session.

1. Nephele writes the binary to a temp file, issues a one-time upload
   token, and includes in the request payload:
   ```json
   {
       "asset": {
           "url": "http://127.0.0.1:<port>/assets/<token>",
           "sha256": "<hex>",
           "bytes": 1234567,
           "mime": "image/png"
       }
   }
   ```
2. Extension fetches the URL, verifies sha256, uses the Blob in
   `DataTransfer` or `input.files` injection.
3. Tokens expire 5 minutes after issue and are single-use. Replay or
   sha mismatch returns HTTP 410.
4. The asset server binds `127.0.0.1` only and requires the
   `X-Wisp-Session` header matching `session_token` from handshake.

No network path is open to external processes. No cross-origin
preflight is permitted.

## Error Codes

| Code | Meaning |
|---|---|
| `AUTH_REQUIRED` | User not logged into target site |
| `RATE_LIMITED` | Per-platform cap hit |
| `PLATFORM_COOLDOWN` | Circuit breaker active |
| `CAPTCHA_REQUIRED` | Human verification in-page; user action needed |
| `DOM_NOT_FOUND` | Expected selector absent after retries |
| `TIMEOUT` | Request exceeded timeout |
| `INVALID_PAYLOAD` | Schema mismatch or unknown request type |
| `VERSION_INCOMPATIBLE` | Handshake `v` mismatch |
| `TOKEN_EXPIRED` | Asset-transfer token invalid |
| `NEPHELE_NOT_RUNNING` | Nephele UI process is not running; business request cannot be served |
| `INTERNAL` | Unhandled error |

## Security Boundary

The extension:
- Connects only to the registered NMH name; no outbound sockets.
- Fetches from `127.0.0.1:<session port>` for assets only; all other
  network activity is within `host_permissions`-listed platform sites.
- Never exfiltrates data to any server other than the local Nephele
  process.
- Treats NMH connection loss as critical: aborts pending tasks, sets
  action-badge warning, notifies user.

Nephele (desktop):
- Writes the NMH manifest to the per-browser path on install; removes
  on uninstall.
- Writes no files outside `%APPDATA%\Nephele\`, the user-chosen
  install directory, and the temp asset directory.
- Binds the asset HTTP server to `127.0.0.1` only; validates
  `X-Wisp-Session` on every request.

## Versioning

Current protocol: `v1`. Additive evolution does not bump `v`. Breaking
changes bump `v` and MUST be handled via handshake `compatible`
negotiation. Extension and Nephele releases ship compatible versions
together; mismatched versions surface "update required" in-product.
