/*
 * 网易画加 (huajia.163.com) order pull.
 *
 * Same contract as the mihuashi handler: user's logged-in browser does
 * the fetching, we observe. Views come from the desktop.
 *
 * 画加 is app-first — the web client exposes a subset of what the app
 * does. If a recon run comes back with no order-shaped payload, that is
 * a real answer about the platform, not a bug in this file: the desktop
 * falls back to manual entry for that channel.
 */
import { captureOrderViews, resolveViews, authError, classifyEnvelope } from './orders_common.js';

const HOST_RE = /^https?:\/\/([^/]*\.)?huajia\.163\.com\//i;
const URL_INCLUDE = /^https?:\/\/([^/]*\.)?(huajia\.163\.com|hj\.163\.com)\//i;
const LOGIN_RE = /(login\.163\.com|reg\.163\.com|\/login)/i;

const FALLBACK_VIEWS = [
    { url: 'https://huajia.163.com/', label: 'root' },
];

// Measured 2026-08-17 against a logged-out session: 画加 answers
//   {code: 2003, error: "登录已失效，请重新登录", msg: "session expired"}
// on every /napp/* endpoint. 2003 is its own code, not an HTTP status.
const AUTH_CODES = [401, 301, 2003];

function classifyResponse(parsed, _url) {
    classifyEnvelope(parsed, AUTH_CODES);
}

function classifyFinalUrl(finalUrl) {
    if (LOGIN_RE.test(finalUrl)) {
        throw authError('huajia login redirect', { final_url: finalUrl });
    }
}

function extractUid(raw) {
    // Measured 2026-08-17: /app/v1/session carries data.session.user
    // (null when logged out); /napp/account/home is the profile call.
    for (const [url, entry] of Object.entries(raw)) {
        if (!/\/(app\/v\d+\/session|napp\/account\/home)/i.test(url)) continue;
        try {
            const j = JSON.parse(entry.body);
            const user = j?.data?.session?.user ?? j?.data?.user ?? j?.data;
            const uid = user?.id ?? user?.uid ?? user?.user_id;
            if (uid) return String(uid);
        } catch (_) { /* noop */ }
    }
    return '';
}

export async function fetchHuajiaOrders(payload) {
    const views = resolveViews(payload && payload.views, FALLBACK_VIEWS, HOST_RE);
    const cap = await captureOrderViews({
        views,
        urlIncludeRegex: URL_INCLUDE,
        classifyResponse,
        classifyFinalUrl,
    });
    return {
        platform: 'huajia',
        account_uid: extractUid(cap.raw),
        captured_at: new Date().toISOString(),
        final_url: cap.final_url,
        endpoint_count: Object.keys(cap.raw).length,
        bytes: cap.bytes,
        dropped: cap.dropped,
        dropped_bytes: cap.dropped_bytes,
        views: cap.views,
        raw: cap.raw,
    };
}
