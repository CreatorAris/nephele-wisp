/*
 * 米画师 (mihuashi.com) order pull.
 *
 * The artist-side order list lives behind login in an SPA whose routes
 * we deliberately do not hardcode — the desktop supplies them (remote
 * config) and the fallbacks below are only a starting point for the
 * first reconnaissance run. Whatever JSON the pages fetch comes back
 * raw; the Python normalizer decides which endpoint is the order list.
 *
 * Anti-bot note (measured 2026-06 by the desktop's headless client):
 * mihuashi runs 阿里云 WAF with request signing and headless detection.
 * This handler sidesteps all of it by never issuing a request itself —
 * the user's own logged-in browser renders the page and signs its own
 * XHRs. Keep it user-driven and single-shot; do not poll.
 */
import { captureOrderViews, resolveViews, authError, captchaError, classifyEnvelope } from './orders_common.js';

const HOST_RE = /^https?:\/\/([^/]*\.)?mihuashi\.com\//i;
const URL_INCLUDE = /^https?:\/\/([^/]*\.)?mihuashi\.com\/api\//i;
const LOGIN_RE = /mihuashi\.com\/(login|signin|passport)/i;
const CAPTCHA_RE = /(captcha|verify|punish)/i;

// Starting points only. The order list route is confirmed by the first
// recon run against a real account and then shipped from the desktop.
const FALLBACK_VIEWS = [
    { url: 'https://www.mihuashi.com/', label: 'root' },
];

// mihuashi's success envelope uses code 0 / absent; 401 is the observed
// unauth status. Kept as a list so a newly-seen code is a one-line change.
const AUTH_CODES = [401];

function classifyResponse(parsed, _url) {
    classifyEnvelope(parsed, AUTH_CODES);
}

function classifyFinalUrl(finalUrl) {
    if (CAPTCHA_RE.test(finalUrl) && HOST_RE.test(finalUrl)) {
        throw captchaError('mihuashi verification redirect', { final_url: finalUrl });
    }
    if (LOGIN_RE.test(finalUrl)) {
        throw authError('mihuashi login redirect', { final_url: finalUrl });
    }
}

function extractUid(raw) {
    // Measured 2026-08-17: mihuashi carries the logged-in uid in the PATH
    // of every dashboard call (/api/v1/users/<uid>/dashboard/...), and has
    // no /users/me-style endpoint at all. Read the path first.
    for (const url of Object.keys(raw)) {
        const m = url.match(/\/api\/v\d+\/users\/(\d+)\//);
        if (m) return m[1];
    }
    for (const [url, entry] of Object.entries(raw)) {
        if (!/\/api\/v\d+\/(session|users?\/(me|self|current))/i.test(url)) continue;
        try {
            const j = JSON.parse(entry.body);
            const uid = j?.user?.id ?? j?.data?.id ?? j?.id;
            if (uid) return String(uid);
        } catch (_) { /* noop */ }
    }
    return '';
}

export async function fetchMihuashiOrders(payload) {
    const views = resolveViews(payload && payload.views, FALLBACK_VIEWS, HOST_RE);
    const cap = await captureOrderViews({
        views,
        urlIncludeRegex: URL_INCLUDE,
        classifyResponse,
        classifyFinalUrl,
    });
    return {
        platform: 'mihuashi',
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
