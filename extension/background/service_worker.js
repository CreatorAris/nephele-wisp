/*
 * Nephele Wisp — service worker entry point (MV3 module).
 *
 * Responsibilities:
 *   1. Own the Native Messaging connection to the Nephele desktop app.
 *   2. Perform the system.hello handshake on connect.
 *   3. Route incoming messages:
 *        response → resolve matching pending Promise from request()
 *        request  → dispatch via routeRequest()
 *        event    → handleEvent()
 *   4. Emit system.heartbeat events every 60s while connected.
 *   5. Surface connection status to the popup via broadcastStatus().
 *
 * Business-request handling (publisher.upload_draft, etc.) delegates
 * to the CDP orchestrator in ./cdp.js and per-platform handlers under
 * ./handlers/.
 *
 * Protocol: see docs/PROTOCOL.md (v1).
 */

import { CdpSession, withCdpTab, classifyCdpError, sweepOrphanTabs, clearOrphanTabLedger } from './cdp.js';
import { handleBilibiliUploadDraft } from './handlers/publisher_bilibili.js';
import { handleXiaohongshuUploadDraft } from './handlers/publisher_xiaohongshu.js';
import { handleWeiboUploadDraft } from './handlers/publisher_weibo.js';
import { handleDouyinUploadDraft } from './handlers/publisher_douyin.js';
import { handlePixivUploadDraft } from './handlers/publisher_pixiv.js';
import { handleTwitterUploadDraft } from './handlers/publisher_twitter.js';
import { handleArtstationUploadDraft } from './handlers/publisher_artstation.js';
import { fetchBilibiliStats } from './handlers/creator_bilibili.js';
import { fetchPixivStats } from './handlers/creator_pixiv.js';
import { fetchXStats } from './handlers/creator_x.js';
import { fetchMihuashiOrders } from './handlers/orders_mihuashi.js';
import { fetchHuajiaOrders } from './handlers/orders_huajia.js';
import { fetchPinterestReferences } from './handlers/reference_pinterest.js';
import { fetchArtstationReferences } from './handlers/reference_artstation.js';
import { fetchHuabanReferences } from './handlers/reference_huaban.js';
import { extractPageResources, fetchFullImages } from './handlers/reference_resources.js';
import { harvestBoard, stopBoardHarvest } from './handlers/reference_board.js';
import { readPage, interactPage } from './handlers/browser_read.js';
import { capturePage } from './handlers/browser_capture.js';
import { installClipSurfaces } from './clip.js';

const NMH_NAME = 'com.arisfusion.nephele_wisp';
const PROTOCOL_VERSION = 1;
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
// 'dev' in source and in unpacked dev loads. scripts/pack.py rewrites
// this to the manifest version when building the store artifact, so the
// handshake reports the real build AND the dev-only eval gate below
// fails closed (it requires BUILD_SHA === 'dev') even if the dev-only
// strip were ever skipped — defense in depth on top of the strip.
const BUILD_SHA = 'dev';

// Heartbeat cadence in minutes (chrome.alarms unit). 0.5 = 30s is both
// chrome.alarms' minimum periodInMinutes (anything smaller is silently
// clamped in production) and the MV3 service-worker idle-suspend window
// — firing exactly at that interval resets the idle timer before it
// expires, which is what keeps the native messaging port from being
// torn down. setInterval cannot do this: its callback is destroyed when
// the SW is recycled, alarms persist and re-wake the SW.
const HEARTBEAT_ALARM_NAME = 'wisp-heartbeat';
const HEARTBEAT_PERIOD_MIN = 0.5;
const MAX_BACKOFF_MS = 32 * 1000;
// Heartbeats are now end-to-end (NMH forwards to Workshop UI). If the
// UI dies behind a live NMH process, these requests start failing.
// Tolerate transient timeouts (Workshop restart, brief network blip)
// before declaring the pipe dead — 2 misses = ~1min worst case.
const MAX_HEARTBEAT_FAILURES = 2;

// ──────────────────────────────────────────────────────────────────
// Module state
// ──────────────────────────────────────────────────────────────────

let port = null;
let sessionToken = null;
let nepheleVersion = null;
let connected = false;
let reconnectAttempts = 0;
let lastStatusBroadcast = 0;
let heartbeatFailures = 0;
// Alarm ticks spent in the port-open-but-not-handshaken state. Grace
// counter for the watchdog: 0 = healthy/first sighting, 1 = already saw
// this state one tick ago, recycle the port now.
let handshakeStalledTicks = 0;

const pendingResponses = new Map();  // id -> callback(response)

// ──────────────────────────────────────────────────────────────────
// Logging
// ──────────────────────────────────────────────────────────────────

function log(...args) { console.log('[Wisp]', ...args); }
function warn(...args) { console.warn('[Wisp]', ...args); }
function error(...args) { console.error('[Wisp]', ...args); }

// ──────────────────────────────────────────────────────────────────
// Envelope
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
// Incoming routing
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

// ──────────────────────────────────────────────────────────────────
// Request dispatch
// ──────────────────────────────────────────────────────────────────

function routeRequest(msg) {
    switch (msg.type) {
        case 'system.heartbeat':
            send(envelope('response', 'system.heartbeat', { result: { ok: true } }, msg.id));
            return;

        case 'system.version':
            // Reverse version check: the desktop asks the RUNNING worker what
            // it actually is. getManifest() can lag reality (Edge caches the
            // loaded-manifest snapshot across hot swaps — measured 2026-08-22:
            // manifest said 0.5.0 while the worker ran build 0.5.10), so
            // BUILD_SHA, stamped into the code itself at pack time, is the
            // authoritative answer.
            send(envelope('response', 'system.version', {
                result: {
                    version: chrome.runtime.getManifest().version,
                    build_sha: BUILD_SHA,
                },
            }, msg.id));
            return;

        case 'publisher.upload_draft':
            dispatchAsync(msg, handlePublisherUploadDraft);
            return;

        case 'creator.fetch_stats':
            dispatchAsync(msg, handleCreatorFetchStats);
            return;

        case 'orders.fetch':
            // Read-only sweep of the user's own commission-order pages.
            // Same observe-don't-request contract as creator.fetch_stats;
            // never writes to the platform.
            dispatchAsync(msg, handleOrdersFetch);
            return;

        case 'reference.fetch_pinterest':
            // Read-side: open Pinterest search in CDP tab, scrape pin
            // grid via DOM walk. Bypasses headless anti-bot by running
            // in the user's real browser session.
            dispatchAsync(msg, fetchPinterestReferences);
            return;

        case 'reference.fetch_artstation':
            // ArtStation professional concept art / illustration —
            // higher-resolution thumbnails than Danbooru, cleaner than
            // Pinterest. Same CDP scrape pattern.
            dispatchAsync(msg, fetchArtstationReferences);
            return;

        case 'reference.fetch_huaban':
            // Huaban (花瓣) — 中文画师常驻平台. EdgeOne CDN refuses
            // Python downloads even with browser UA + cookies, so this
            // handler fetches each thumbnail SW-side and inlines as
            // base64 in the response. Bytes shipped per call ~500KB
            // (capped at 40 items × ~20KB base64).
            dispatchAsync(msg, fetchHuabanReferences);
            return;

        case 'reference.extract_resources':
            // Generic "save/download images from this webpage" path.
            // Runs in the user's real browser session, not Playwright
            // headless, and returns browser-fetched inline image bytes
            // within the Native Messaging frame budget.
            dispatchAsync(msg, extractPageResources);
            return;

        case 'reference.fetch_full':
            // On-select: fetch the FULL-res images the user picked (in their
            // real session) and stream the bytes back over the HTTP ingest
            // channel — breaks the NM 1 MB cap. Paired with the thumbnails
            // reference.extract_resources now returns.
            dispatchAsync(msg, fetchFullImages);
            return;

        case 'reference.harvest_board':
            // Whole-board walk (Pinterest 采集板 / 花瓣画板): scroll ONE board to
            // its bottom and stream item metadata back as board_progress events.
            // No bytes here — the desktop pulls full-res through fetch_full, so
            // an unbounded board never approaches the 1 MB frame cap. Selectors
            // arrive in the payload (desktop-canonical), so a DOM change ships
            // as a desktop self-update, not a store re-submission.
            dispatchAsync(msg, (p) => harvestBoard(p, (type, payload) => send(
                envelope('event', type, payload),
            )));
            return;

        case 'reference.board_stop':
            // Cooperative cancel for the above. Returns at once; the harvest
            // notices at its next round and finishes normally, so everything
            // already collected still lands.
            dispatchAsync(msg, stopBoardHarvest);
            return;

        case 'browser.read_page':
            // Generic authenticated page READ — open any URL in an
            // ephemeral background tab in the user's real browser and
            // return a normalized text/links/structured snapshot. Read-only
            // (no clicks/writes); writes stay in the audited publisher.*
            // path. Backs the desktop wisp_read_page tool's Tier 1.
            dispatchAsync(msg, readPage);
            return;

        case 'browser.interact':
            // Scripted navigation — navigate then run a click/type/scroll/
            // press/wait sequence (search / submit / paginate) and read the
            // result. Read-oriented; account writes stay in publisher.*.
            // Backs wisp_interact's Tier 1.
            dispatchAsync(msg, interactPage);
            return;

        case 'browser.capture':
            // Bounded CDP capture passthrough — desktop names a whitelisted
            // read-only capture method (Page.captureScreenshot / printToPDF /
            // DOM.*); bytes stream back over the HTTP ingest channel. Generic
            // engine: new capture features are desktop params, no re-submission.
            dispatchAsync(msg, capturePage);
            return;

        // Removed: 'inbox.fetch_comments', 'inbox.reply', 'scheduler.execute'
        // (Phase 3 — protocol namespace gate already permits them when added).

        // @wisp-dev-only:start — scripts/pack.py strips this block from
        // the store artifact (and the pack FAILS if 'system.eval'
        // survives), so the eval probe exists ONLY in unpacked dev loads.
        case 'system.eval':
            // Dev probe used by the desktop repo's scripts/wisp_probe.py
            // to diagnose handler DOM drift. Doubly guarded: stripped at
            // build time, and BUILD_SHA === 'dev' gated in handleSystemEval.
            dispatchAsync(msg, handleSystemEval);
            return;
        // @wisp-dev-only:end

        // Future: inbox.fetch_comments, inbox.reply, scheduler.execute, ...

        default:
            send(envelope(
                'response',
                msg.type,
                { error: { code: 'INVALID_PAYLOAD', message: `unknown request type: ${msg.type}` } },
                msg.id,
            ));
    }
}

// Async handler wrapper: runs fn(payload) → { result } or { error };
// writes framed response back. Handlers MUST throw on failure, and
// SHOULD attach `.code` to the Error for protocol error-code mapping.
function dispatchAsync(msg, fn) {
    (async () => {
        try {
            const result = await fn(msg.payload || {});
            send(envelope('response', msg.type, { result }, msg.id));
        } catch (e) {
            const code = e.code || classifyCdpError(e);
            error(`${msg.type} failed:`, code, e.message);
            const errObj = { code, message: e.message };
            if (e.data) errObj.data = e.data;
            send(envelope('response', msg.type, { error: errObj }, msg.id));
        }
    })();
}

// Platform router for creator.fetch_stats — keeps the dispatch table
// next to the publisher dispatch for symmetry. New platform = one more
// row here + a creator_{platform}.js module under ./handlers/.
async function handleCreatorFetchStats(payload) {
    const platform = payload.platform_key || payload.platform || '';
    const dispatchTable = {
        bilibili: fetchBilibiliStats,
        pixiv: fetchPixivStats,
        x: fetchXStats,
    };
    const fn = dispatchTable[platform];
    if (!fn) {
        const err = new Error(`unsupported platform: ${platform || '(missing)'}`);
        err.code = 'INVALID_PAYLOAD';
        throw err;
    }
    return await fn(payload);
}


// Platform router for orders.fetch. B站工房 is absent on purpose: its
// creator side is app-only (web has no order console to observe), so
// that channel stays manual until a web surface exists to read.
async function handleOrdersFetch(payload) {
    const platform = payload.platform_key || payload.platform || '';
    const dispatchTable = {
        mihuashi: fetchMihuashiOrders,
        huajia: fetchHuajiaOrders,
    };
    const fn = dispatchTable[platform];
    if (!fn) {
        const err = new Error(`unsupported platform: ${platform || '(missing)'}`);
        err.code = 'INVALID_PAYLOAD';
        throw err;
    }
    return await fn(payload);
}


async function handlePublisherUploadDraft(payload) {
    const platform = payload.platform_key || '';
    // keepTab + active: user needs the filled draft tab left open and
    // focused so they can review and hit publish manually. Wisp never
    // publishes for the user — draft_ready is the hard stop, the same
    // contract for every platform.
    const dispatchTable = {
        bilibili: handleBilibiliUploadDraft,
        xiaohongshu: handleXiaohongshuUploadDraft,
        weibo: handleWeiboUploadDraft,
        douyin: handleDouyinUploadDraft,
        pixiv: handlePixivUploadDraft,
        twitter: handleTwitterUploadDraft,
        artstation: handleArtstationUploadDraft,
    };
    const handler = dispatchTable[platform];
    if (!handler) {
        const err = new Error(`unsupported platform: ${platform || '(missing)'}`);
        err.code = 'INVALID_PAYLOAD';
        throw err;
    }
    return await withCdpTab(
        'about:blank',
        async (session) => {
            const result = await handler(session, payload);
            // Optional CDP screenshot capture for store-listing
            // automation. Wrapped here (not per-handler) so all 7
            // platform handlers stay focused on their own DOM logic.
            // Only fires on success path; the session is still
            // attached at this point (withCdpTab detaches afterwards).
            if (payload && payload.capture_screenshot
                && result && typeof result === 'object' && result.data) {
                try {
                    result.data.screenshot_b64 = await session.screenshot();
                } catch (e) {
                    result.data.screenshot_error = (e && e.message) || String(e);
                }
            }
            return result;
        },
        { keepTab: true, active: true },
    );
}

// @wisp-dev-only:start — scripts/pack.py strips this whole block from
// the store artifact; the CI pack also FAILS if 'handleSystemEval' or
// 'system.eval' survive, so this probe never reaches a published build.
// ──────────────────────────────────────────────────────────────────
// system.eval — dev probe
// ──────────────────────────────────────────────────────────────────
//
// Attaches a temporary CDP session to a tab matched by URL pattern
// (or the currently-active tab if no pattern given), runs
// Runtime.evaluate, returns the serialized result. Used by the desktop
// repo's `scripts/wisp_probe.py` to diagnose publisher handler DOM
// drift. Two independent guards keep it out of production: (1) the
// build-time strip above, and (2) the BUILD_SHA === 'dev' check below,
// which fails closed because pack.py rewrites BUILD_SHA to the version.
async function handleSystemEval(payload) {
    if (BUILD_SHA !== 'dev') {
        const err = new Error('FORBIDDEN: system.eval disabled on non-dev builds');
        err.code = 'FORBIDDEN';
        throw err;
    }
    payload = payload || {};
    const expression = String(payload.expression || '');
    if (!expression) {
        const err = new Error('INVALID_PAYLOAD: expression required');
        err.code = 'INVALID_PAYLOAD';
        throw err;
    }
    const urlPattern = payload.url_pattern || null;
    const awaitPromise = Boolean(payload.await_promise);
    const returnByValue = payload.return_by_value !== false;

    const query = urlPattern
        ? { url: urlPattern }
        : { active: true, currentWindow: true };
    const tabs = await new Promise((resolve, reject) => {
        chrome.tabs.query(query, (ts) => {
            const e = chrome.runtime.lastError;
            if (e) reject(new Error(`tabs.query: ${e.message}`));
            else resolve(ts || []);
        });
    });
    if (!tabs.length) {
        const err = new Error(
            `TAB_NOT_FOUND: no tab matched ${urlPattern || '(active)'}`,
        );
        err.code = 'TAB_NOT_FOUND';
        throw err;
    }
    const tab = tabs[0];
    const session = new CdpSession(tab.id);
    try {
        await session.attach();
        const r = await session.send('Runtime.evaluate', {
            expression,
            returnByValue,
            awaitPromise,
        });
        if (r.exceptionDetails) {
            const desc = (r.exceptionDetails.exception && r.exceptionDetails.exception.description)
                || r.exceptionDetails.text
                || 'eval failed';
            const err = new Error(`EVAL_ERROR: ${desc}`);
            err.code = 'EVAL_ERROR';
            err.data = { exception: r.exceptionDetails };
            throw err;
        }
        return {
            tab_id: tab.id,
            tab_url: tab.url,
            tab_title: tab.title,
            value: r.result && r.result.value,
            type: r.result && r.result.type,
            unserializable: r.result && r.result.unserializableValue,
            tab_matches: tabs.length,
        };
    } finally {
        try { await session.detach(); } catch (_) { /* noop */ }
    }
}
// @wisp-dev-only:end

function handleEvent(msg) {
    switch (msg.type) {
        case 'system.ui_online':
            // NMH's reconnector picked up the Workshop UI process.
            // Flip "connected" on without waiting for next heartbeat.
            log('UI online event, nephele', msg.payload?.nephele_version);
            nepheleVersion = msg.payload?.nephele_version ?? nepheleVersion;
            connected = true;
            heartbeatFailures = 0;
            broadcastStatus();
            return;

        case 'system.ui_shutdown': {
            // Workshop UI cleanly shut down. Flip "connected" off
            // immediately instead of waiting up to 30s for the next
            // heartbeat to time out. Also drop the port so the next
            // alarm tick reconnects fresh once UI comes back.
            // Self-initiated port.disconnect() does NOT reliably fire
            // our own onDisconnect — do its cleanup inline.
            log('UI shutdown event:', msg.payload?.reason ?? '(no reason)');
            connected = false;
            sessionToken = null;
            nepheleVersion = null;
            heartbeatFailures = 0;
            handshakeStalledTicks = 0;
            broadcastStatus();
            const dead = port;
            port = null;
            try { dead?.disconnect(); } catch (e) { /* ignore */ }
            scheduleReconnect();
            return;
        }
        case 'system.reload_request':
            // Fast-channel update flow: the desktop app has just swapped the
            // unpacked extension's files on disk and asks us to pick them up.
            // runtime.reload() re-reads the folder; the NMH port re-connects
            // on the fresh SW boot. Harmless on the store copy (plain restart).
            log('reload requested by desktop — reloading');
            chrome.runtime.reload();
            return;

        default:
            log('event (ignored)', msg.type, msg.payload);
    }
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
        // ui_online is the truth about the full pipe — NMH responding
        // doesn't prove Workshop is running. Defaults to true for
        // protocol back-compat with NMH builds that don't ship the flag.
        connected = result.ui_online !== false;
        reconnectAttempts = 0;
        heartbeatFailures = 0;
        handshakeStalledTicks = 0;
        log('handshake ok, nephele', nepheleVersion,
            'ui_online=', connected);
        startHeartbeat();
        broadcastStatus();
        reportWindowState();
        return true;
    } catch (e) {
        error('handshake failed:', e.message);
        return false;
    }
}

// ──────────────────────────────────────────────────────────────────
// Window state (system.window_state event)
// ──────────────────────────────────────────────────────────────────
// Edge startup boost keeps this SW alive with zero windows — "connected"
// on the desktop side then says nothing about whether tabs.create can
// work. Push the normal-window count so the UI can show a standby state.
// Fire-and-forget; desktop builds whose NMH predates the
// system.window_state forward-allowlist just drop it.

async function reportWindowState() {
    if (!port || !connected) return;
    try {
        const wins = await chrome.windows.getAll();
        const count = wins.filter((w) => w.type === 'normal').length;
        // browser rides along so the desktop's auto-launch bootstrap spawns
        // the browser Wisp actually lives in (daily-Chrome users) instead
        // of unconditionally popping Edge. ext_id lets the desktop tell the
        // fast-channel (unpacked) copy from the store copy — drives the
        // "installed on disk but not yet loaded in the browser" walkthrough.
        send(envelope('event', 'system.window_state', {
            count,
            browser: detectBrowser(),
            ext_id: chrome.runtime.id,
        }));
    } catch (e) {
        error('reportWindowState failed:', e.message);
    }
}

chrome.windows.onCreated.addListener(() => reportWindowState());
chrome.windows.onRemoved.addListener(() => reportWindowState());

// ──────────────────────────────────────────────────────────────────
// Heartbeat
// ──────────────────────────────────────────────────────────────────

function startHeartbeat() {
    chrome.alarms.create(HEARTBEAT_ALARM_NAME, {
        // delayInMinutes fires the first alarm after the period so the SW
        // wake-up cadence starts immediately, not at module load.
        delayInMinutes: HEARTBEAT_PERIOD_MIN,
        periodInMinutes: HEARTBEAT_PERIOD_MIN,
    });
}

function stopHeartbeat() {
    chrome.alarms.clear(HEARTBEAT_ALARM_NAME);
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
        heartbeatFailures = 0;
        handshakeStalledTicks = 0;
        // Intentionally NOT calling stopHeartbeat() here. The alarm is now
        // the only event source guaranteed to fire after MV3 suspends the
        // SW — clearing it would orphan the extension if the SW is recycled
        // before scheduleReconnect's setTimeout fires (setTimeout is also
        // destroyed on suspend). Leaving the alarm armed means the next
        // alarm tick wakes the SW, the listener sees `!port`, and kicks
        // connect() — the recovery path that setTimeout cannot guarantee.
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
    if (now - lastStatusBroadcast < 100) return;
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
// Lifecycle
// ──────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
    log('onInstalled, version', EXTENSION_VERSION);
    connect();
});

// Every SW start (idle wake, post-update reload): close capture tabs whose
// withCdpTab cleanup never ran because the previous SW died mid-capture.
// Delayed so a real browser launch lets onStartup drop the stale ledger
// first (extension reloads don't fire onStartup and sweep normally).
setTimeout(() => { sweepOrphanTabs(); }, 2000);

chrome.runtime.onStartup.addListener(() => {
    log('onStartup');
    // Browser relaunch: every ledger tab id is stale, and session restore
    // may recycle one onto a tab the user opened — drop, don't sweep.
    clearOrphanTabLedger();
    connect();
});

// Clip entry points (context menu + keyboard command). Registered at top level
// so onClicked/onCommand survive SW suspension; each fires a fire-and-forget
// reference.clip event to the desktop, which owns the capture/save logic.
// If the native port dropped while the SW stayed awake, send() returns false —
// kick a reconnect and flash a badge so the clip isn't silently lost.
installClipSurfaces((payload) => {
    const ok = send(envelope('event', 'reference.clip', payload));
    if (!ok) {
        connect();  // no-op if a connection is already being established
        try {
            chrome.action.setBadgeText({ text: '!' });
            chrome.action.setBadgeBackgroundColor({ color: '#E05C3A' });
            setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
        } catch (_) { /* action badge unavailable — best-effort signal only */ }
    }
    return ok;
});

// MV3 keepalive — must be registered at module top-level so the SW wakes
// on alarm fire after suspension. The handler itself is the keepalive: the
// alarm event resets the SW idle timer, and sending the heartbeat as a
// request (not fire-and-forget event) yields a port.onMessage response
// that resets it again. Module re-evaluation on wake calls connect() at
// the bottom of this file, so the alarm listener can usually skip the
// re-connect path; it just kicks one if `port` is still null.
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== HEARTBEAT_ALARM_NAME) return;
    if (!port) {
        connect();
        return;
    }
    if (!connected) {
        // Port is open but the handshake never completed (NMH alive with
        // the Workshop UI down, or the hello timed out). This state used to
        // be PERMANENT: `!port` was false so no reconnect ever ran, and
        // this early-return skipped the heartbeat that would have detected
        // the dead pipe — the SW then woke every 30s to do exactly nothing.
        // One tick of grace covers an in-flight handshake (hello timeout
        // 10s < alarm period 30s); after that, recycle the port and retry.
        if (!handshakeStalledTicks) {
            handshakeStalledTicks = 1;
            return;
        }
        handshakeStalledTicks = 0;
        warn('port open but never handshook — recycling port');
        const dead = port;
        port = null;
        try { dead?.disconnect(); } catch (err) { /* ignore */ }
        connect();
        return;
    }
    handshakeStalledTicks = 0;
    try {
        await request('system.heartbeat', { ts: Date.now() }, 5000);
        heartbeatFailures = 0;
    } catch (e) {
        heartbeatFailures++;
        warn('heartbeat failed:', heartbeatFailures, '/', MAX_HEARTBEAT_FAILURES,
             '—', e.message);
        if (heartbeatFailures >= MAX_HEARTBEAT_FAILURES) {
            // End-to-end pipe is dead. UI is gone behind a possibly-live
            // NMH; flip status off so the popup stops lying, then force a
            // fresh port so we re-handshake when Workshop comes back.
            // Self-initiated port.disconnect() does NOT reliably fire our
            // own onDisconnect listener in Chrome, so do its work inline.
            warn('heartbeat threshold reached → marking disconnected');
            connected = false;
            sessionToken = null;
            nepheleVersion = null;
            heartbeatFailures = 0;
            broadcastStatus();
            const dead = port;
            port = null;
            try { dead?.disconnect(); } catch (err) { /* ignore */ }
            scheduleReconnect();
        }
    }
});

// Also connect on SW wakeup — MV3 service workers may be started for
// various events (alarms, messages, installed) and we want the NMH
// connection up whenever the SW is alive.
//
// Arm the watchdog alarm on EVERY SW boot, not only after a successful
// handshake (startHeartbeat used to run solely from performHandshake).
// Without this, a boot whose connect()/handshake fails outright — and
// whose profile never armed the alarm in a past life — has only
// scheduleReconnect's setTimeout left, which MV3 destroys with the SW:
// the extension then stays dead until an unrelated event wakes it.
// chrome.alarms.create with the same name replaces the existing alarm,
// so re-arming here is idempotent and keeps the ≤30s cadence.
startHeartbeat();
connect();
