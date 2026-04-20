# Background layer

Service worker + CDP orchestration for the Wisp extension.

## Files

```
background/
├── service_worker.js        ← MV3 SW entry point (module)
├── humanize.js              ← Humanization Pipeline primitives
├── cdp.js                   ← chrome.debugger wrapper (CdpSession)
└── handlers/
    └── publisher_bilibili.js  ← per-platform handlers
```

## Responsibility split

| File | Responsibility |
|---|---|
| `service_worker.js` | NMH connection lifecycle, handshake, heartbeat, request routing. Imports CDP + handlers. Delegates, does not implement platform-specific behavior. |
| `humanize.js` | Pure utility. Delays, mouse jitter, typing cadence — all parameters hardcoded to match PROTOCOL.md §Humanization Pipeline. **Not configurable** from the desktop side. |
| `cdp.js` | `CdpSession` class wrapping `chrome.debugger`: attach/detach, navigate, click, type, waitForSelector, evaluate, setFileInputFiles, screenshot, captcha detection. Every DOM mutation routes through Humanization. |
| `handlers/<platform>.js` | Business logic per platform. Receives a ready-to-use `CdpSession` plus the request payload, returns a result dict, throws on failure with `.code` attached. |

## Adding a new business request type

Wire-up checklist:

1. Add the type to `docs/PROTOCOL.md` Type Catalog with direction.
2. Add a `case` in `service_worker.js` `routeRequest()` → call
   `dispatchAsync(msg, myHandler)`.
3. Implement the handler (usually thin, delegates to `handlers/...`).
4. If it needs a new platform, add `handlers/<ns>_<platform>.js`.
5. If it touches a new origin, add to `host_permissions` in
   `manifest.json` and justify on the next Web Store submission.
6. Add an entry to `docs/SECURITY.md` explaining what the handler does
   and what data crosses the bridge.

## Handler contract

```js
// async function, receives payload dict from Nephele side
export async function myHandler(session, payload) {
    // Drive the page via session.click / type / setFileInputFiles...
    // Throw Error with .code = '<PROTOCOL_CODE>' on failure.
    //   e.g. err.code = 'AUTH_REQUIRED' when login redirect detected.
    // Return a plain object to ship as the response result.
    return { success: true, message: '...', data: {...} };
}
```

Error codes must match `docs/PROTOCOL.md` §Error Codes. Unknown errors
are classified as `INTERNAL` by `classifyCdpError` in `cdp.js`.

## What's NOT allowed

- Bypassing Humanization (any raw `Input.dispatchMouseEvent` outside
  of `cdp.js` is a bug).
- Clicking the "publish" / "post" / "submit" final button on any
  platform. Wisp always stops at the draft-saved state and hands
  control back to the user. Policy: `docs/ROADMAP.md` §Non-goals.
- Auto-solving captchas. Detection → `CAPTCHA_REQUIRED` error, user
  resolves in their own browser window, desktop retries.
- Network requests to any origin not in `manifest.json`
  `host_permissions`. The asset server (`127.0.0.1:<session port>`)
  is the only allowed out-of-platform fetch.
