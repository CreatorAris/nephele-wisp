/*
 * Nephele Wisp — service worker entry point.
 *
 * Maintains the Native Messaging connection to the Nephele Workshop
 * desktop app, performs handshake, and routes typed requests to their
 * handlers. Single-file for now; split into modules when the handler
 * set grows beyond v0.4.
 *
 * Protocol: see docs/PROTOCOL.md (v1).
 */

const NMH_NAME = 'com.arisfusion.nephele_wisp';
const PROTOCOL_VERSION = 1;
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const BUILD_SHA = 'dev';

const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const MAX_BACKOFF_MS = 32 * 1000;

// ──────────────────────────────────────────────────────────────────
// Module state
// ──────────────────────────────────────────────────────────────────

let port = null;
let sessionToken = null;
let nepheleVersion = null;
let connected = false;
let reconnectAttempts = 0;
let heartbeatTimer = null;
let lastStatusBroadcast = 0;

const pendingResponses = new Map();  // id -> callback(response)

// ──────────────────────────────────────────────────────────────────
// Logging
// ──────────────────────────────────────────────────────────────────

function log(...args) { console.log('[Wisp]', ...args); }
function warn(...args) { console.warn('[Wisp]', ...args); }
function error(...args) { console.error('[Wisp]', ...args); }

// ──────────────────────────────────────────────────────────────────
// Envelope helpers
// ──────────────────────────────────────────────────────────────────

function makeId() {
    const t = Date.now().toString(36);
    const r = Math.random().toString(36).slice(2, 10);
    return `msg_${t}_${r}`;
}

function envelope(kind, type, payload = {}, id = null) {
    return {
        v: PROTOCOL_VERSION,
        id: id ?? makeId(),
        kind,
        type,
        payload,
    };
}

function detectBrowser() {
    const ua = self.navigator?.userAgent ?? '';
    if (ua.includes('Edg/')) return 'edge';
    return 'chrome';
}

function detectBrowserVersion() {
    const ua = self.navigator?.userAgent ?? '';
    const m = ua.match(/Chrom(?:e|ium)\/(\d+\.\d+\.\d+\.\d+)/);
    return m ? m[1] : 'unknown';
}

// ──────────────────────────────────────────────────────────────────
// Stable hashed profile ID (survives browser restarts on same profile)
// ──────────────────────────────────────────────────────────────────

async function getProfileId() {
    const key = 'wisp_profile_id';
    const stored = await chrome.storage.local.get(key);
    if (stored[key]) return stored[key];
    const fresh = `wp_${crypto.randomUUID()}`;
    await chrome.storage.local.set({ [key]: fresh });
    return fresh;
}

// ──────────────────────────────────────────────────────────────────
// Transport
// ──────────────────────────────────────────────────────────────────

function send(msg) {
    if (!port) {
        error('send: no port');
        return false;
    }
    try {
        port.postMessage(msg);
        return true;
    } catch (e) {
        error('send failed:', e);
        return false;
    }
}

function request(type, payload, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
        const msg = envelope('request', type, payload);
        const timer = setTimeout(() => {
            pendingResponses.delete(msg.id);
            reject(new Error(`timeout: ${type}`));
        }, timeoutMs);
        pendingResponses.set(msg.id, (response) => {
            clearTimeout(timer);
            if (response.payload?.error) {
                reject(Object.assign(new Error(response.payload.error.message || 'error'), {
                    code: response.payload.error.code,
                }));
            } else {
                resolve(response.payload?.result);
            }
        });
        if (!send(msg)) {
            clearTimeout(timer);
            pendingResponses.delete(msg.id);
            reject(new Error('send failed'));
        }
    });
}

// ──────────────────────────────────────────────────────────────────
// Incoming message routing
// ──────────────────────────────────────────────────────────────────

function handleIncoming(msg) {
    if (!msg || typeof msg !== 'object') {
        warn('recv: non-object', msg);
        return;
    }
    if (msg.v !== PROTOCOL_VERSION) {
        warn('recv: version mismatch', msg.v);
        return;
    }

    log('recv', msg.kind, msg.type, msg.id);

    switch (msg.kind) {
        case 'response': {
            const cb = pendingResponses.get(msg.id);
            if (cb) {
                pendingResponses.delete(msg.id);
                cb(msg);
            } else {
                warn('orphan response', msg.id);
            }
            return;
        }
        case 'request':
            routeRequest(msg);
            return;
        case 'event':
            handleEvent(msg);
            return;
        default:
            warn('recv: unknown kind', msg.kind);
    }
}

function routeRequest(msg) {
    switch (msg.type) {
        case 'system.heartbeat':
            send(envelope('response', 'system.heartbeat', { result: { ok: true } }, msg.id));
            return;

        // Future: publisher.upload_draft, creator.fetch_stats, ...
        // Each will live in its own module under background/handlers/
        // once implemented.

        default:
            send(envelope(
                'response',
                msg.type,
                { error: { code: 'INVALID_PAYLOAD', message: `unknown request type: ${msg.type}` } },
                msg.id,
            ));
    }
}

function handleEvent(msg) {
    // No event types from Nephele are expected in v1; log for diagnostics.
    log('event (ignored)', msg.type, msg.payload);
}

// ──────────────────────────────────────────────────────────────────
// Handshake
// ──────────────────────────────────────────────────────────────────

async function performHandshake() {
    const profileId = await getProfileId();
    try {
        const result = await request('system.hello', {
            extension_version: EXTENSION_VERSION,
            extension_build_sha: BUILD_SHA,
            browser: detectBrowser(),
            browser_version: detectBrowserVersion(),
            user_profile_id: profileId,
        }, 10000);

        if (!result?.compatible) {
            error('handshake: incompatible', result);
            await disconnect('VERSION_INCOMPATIBLE');
            return false;
        }

        sessionToken = result.session_token ?? null;
        nepheleVersion = result.nephele_version ?? null;
        connected = true;
        reconnectAttempts = 0;
        log('handshake ok, nephele', nepheleVersion);
        startHeartbeat();
        broadcastStatus();
        return true;
    } catch (e) {
        error('handshake failed:', e.message);
        return false;
    }
}

// ──────────────────────────────────────────────────────────────────
// Heartbeat (client → host)
// ──────────────────────────────────────────────────────────────────

function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
        if (!connected) return;
        send(envelope('event', 'system.heartbeat', { ts: Date.now() }));
    }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

// ──────────────────────────────────────────────────────────────────
// Connection lifecycle
// ──────────────────────────────────────────────────────────────────

async function connect() {
    if (port) return;
    log('connecting to', NMH_NAME);

    try {
        port = chrome.runtime.connectNative(NMH_NAME);
    } catch (e) {
        error('connectNative threw:', e);
        scheduleReconnect();
        return;
    }

    port.onMessage.addListener(handleIncoming);
    port.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError;
        log('disconnected:', err?.message ?? '(clean)');
        port = null;
        connected = false;
        sessionToken = null;
        nepheleVersion = null;
        stopHeartbeat();
        broadcastStatus();
        scheduleReconnect();
    });

    await performHandshake();
}

function scheduleReconnect() {
    reconnectAttempts++;
    const delay = Math.min(
        MAX_BACKOFF_MS,
        1000 * Math.pow(2, Math.min(reconnectAttempts, 5)),
    );
    log(`reconnect in ${delay}ms (attempt ${reconnectAttempts})`);
    setTimeout(connect, delay);
}

async function disconnect(reason) {
    if (port) {
        try {
            send(envelope('event', 'system.disconnect_reason', { reason }));
            port.disconnect();
        } catch (e) {
            error('disconnect error:', e);
        }
    }
}

// ──────────────────────────────────────────────────────────────────
// Popup / internal messaging
// ──────────────────────────────────────────────────────────────────

function broadcastStatus() {
    const now = Date.now();
    if (now - lastStatusBroadcast < 100) return;  // throttle
    lastStatusBroadcast = now;
    chrome.runtime.sendMessage({
        kind: 'internal',
        type: 'status_update',
        payload: { connected, nepheleVersion },
    }).catch(() => { /* popup not open */ });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'query_status') {
        sendResponse({
            connected,
            nepheleVersion,
            extensionVersion: EXTENSION_VERSION,
            reconnectAttempts,
        });
        return true;
    }
    if (msg?.type === 'force_reconnect') {
        log('force reconnect requested');
        (async () => {
            await disconnect('user_triggered');
            reconnectAttempts = 0;
            setTimeout(connect, 500);
        })();
        sendResponse({ ok: true });
        return true;
    }
});

// ──────────────────────────────────────────────────────────────────
// Lifecycle entry points
// ──────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
    log('onInstalled, version', EXTENSION_VERSION);
    connect();
});

chrome.runtime.onStartup.addListener(() => {
    log('onStartup');
    connect();
});

// Also connect on service-worker wakeup (MV3 SWs can be spawned on
// events like alarms or extension messaging).
connect();
