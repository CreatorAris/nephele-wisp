/*
 * Shared order-capture primitive for orders.fetch handlers.
 *
 * Commission platforms put a creator's orders behind several views —
 * in-progress, awaiting payment, completed, archived — each its own SPA
 * route with its own paginated XHRs. Unlike creator dashboards, there is
 * no single page that carries the whole picture, so we capture a LIST of
 * views and merge what comes back.
 *
 * The view list is supplied by the desktop rather than hardcoded here.
 * Platform routes change and the desktop can ship a new list through
 * remote config, whereas changing this file means re-submitting the
 * extension to the store. Each handler declares fallback views so a
 * desktop that sends nothing still does something sensible.
 *
 * Capture stays generic: this module never parses a platform payload.
 * It hands the desktop every JSON body the page fetched, keyed by URL,
 * and the Python normalizer decides what any of it means. That is what
 * makes the first run against a new platform a reconnaissance run and
 * the implementation at the same time.
 */
import { captureDashboardXhrs } from './creator_common.js';

const MAX_VIEWS = 8;

// Native messaging kills the port outright above 1 MiB per frame, and an
// order sweep merges bodies from several pages — far more than a single
// creator-dashboard capture. Budget well under the limit and report what
// was dropped rather than silently returning a truncated picture.
const MAX_BODY_BYTES = 400_000;
const MAX_TOTAL_BYTES = 700_000;

/**
 * Normalize a desktop-supplied view list against a handler's fallbacks.
 *
 * @param {any} supplied      payload.views — [{url, label}] or ['url', ...]
 * @param {Array} fallback    handler's own default views
 * @param {RegExp} hostRegex  only same-platform URLs are accepted
 */
export function resolveViews(supplied, fallback, hostRegex) {
    const raw = Array.isArray(supplied) && supplied.length ? supplied : fallback;
    const views = [];
    for (const entry of raw) {
        const url = typeof entry === 'string' ? entry : (entry && entry.url) || '';
        if (!/^https?:\/\//i.test(url)) continue;
        // A desktop-supplied URL must stay on the platform it claims to
        // be — this route opens a tab in the user's logged-in browser,
        // so it must never be steerable to an unrelated origin.
        if (!hostRegex.test(url)) continue;
        views.push({
            url,
            label: (typeof entry === 'object' && entry && entry.label) || '',
            storage: sanitizeStorage(typeof entry === 'object' && entry && entry.storage),
            click: sanitizeClick(typeof entry === 'object' && entry && entry.click),
        });
        if (views.length >= MAX_VIEWS) break;
    }
    return views.length ? views : [];
}

// localStorage presets a view wants in place BEFORE the SPA boots —
// string keys/values only, and only a handful. 画加's order tabs read
// their filter from localStorage during component init (measured
// 2026-08-22: receiveAssignmentStage defaults to "processing", so a
// sweep never sees finished commissions unless "" = 全部 is preset).
const MAX_STORAGE_KEYS = 8;

function sanitizeStorage(storage) {
    if (!storage || typeof storage !== 'object' || Array.isArray(storage)) return null;
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(storage)) {
        if (typeof k !== 'string' || typeof v !== 'string') continue;
        out[k] = v;
        if ((n += 1) >= MAX_STORAGE_KEYS) break;
    }
    return n ? out : null;
}

// After the first XHR storm settles, click the in-page tab whose exact
// text matches `click`, then capture a second idle window. Needed for
// components that hardcode their initial filter in memory (画加's
// CommissionReceived boots at stage="processing" and reads NOTHING —
// no localStorage, no URL query — so the finished list only exists
// behind a real tab click). Text-match only, leaf elements only: this
// runs in the user's logged-in session and must never press anything
// but a filter tab.
const MAX_CLICK_TEXT = 24;

function sanitizeClick(click) {
    if (typeof click !== 'string') return null;
    const text = click.trim();
    if (!text || text.length > MAX_CLICK_TEXT) return null;
    return text;
}

function clickTabExpression(text) {
    return `(() => {
        const want = ${JSON.stringify(text)};
        const els = document.querySelectorAll('a,button,[role="tab"],li,span,div,label');
        for (const el of els) {
            if (el.childElementCount === 0 && el.textContent.trim() === want) {
                el.click();
                return true;
            }
        }
        return false;
    })()`;
}

function storagePreScript(storage) {
    const sets = Object.entries(storage)
        .map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
        .join(' ');
    // Runs in every new document incl. sandboxed iframes where
    // localStorage access throws — swallow, never break the page.
    return `try { ${sets} } catch (e) {}`;
}

/**
 * Capture every view in turn, merging their JSON bodies.
 *
 * Returns { raw, views, final_url } where `raw` maps request URL ->
 * { status, mime, body } exactly as creator_common produces it, and
 * `views` records what each view contributed so a desktop-side recon
 * can tell an empty route from a route that simply had no orders.
 */
export async function captureOrderViews(opts) {
    const {
        views,
        urlIncludeRegex,
        classifyResponse,
        classifyFinalUrl,
        idleMs,
        hardTimeoutMs,
    } = opts;

    const raw = {};
    const viewReports = [];
    let lastFinalUrl = '';
    let firstError = null;
    let totalBytes = 0;
    let droppedCount = 0;
    let droppedBytes = 0;

    for (const view of views) {
        try {
            const { captured, finalUrl } = await captureDashboardXhrs({
                dashboardUrl: view.url,
                urlIncludeRegex,
                classifyResponse,
                classifyFinalUrl,
                idleMs,
                hardTimeoutMs,
                preScript: view.storage ? storagePreScript(view.storage) : undefined,
                afterInitialIdle: view.click
                    ? async (session) => {
                        await session.send('Runtime.evaluate', {
                            expression: clickTabExpression(view.click),
                            returnByValue: true,
                        });
                    }
                    : undefined,
            });
            let added = 0;
            // Smallest first: when the budget runs out, what gets dropped
            // is the giant bundle/config blob, not the order list.
            const entries = Object.entries(captured).sort(
                (a, b) => (a[1].body || '').length - (b[1].body || '').length
            );
            for (const [url, entry] of entries) {
                const size = (entry.body || '').length;
                if (size > MAX_BODY_BYTES || totalBytes + size > MAX_TOTAL_BYTES) {
                    droppedCount += 1;
                    droppedBytes += size;
                    continue;
                }
                // Later views win on collision: the same endpoint fetched
                // from a deeper route usually carries the richer page.
                if (!(url in raw)) {
                    added += 1;
                    totalBytes += size;
                } else {
                    totalBytes += size - ((raw[url].body || '').length);
                }
                raw[url] = entry;
            }
            lastFinalUrl = finalUrl;
            viewReports.push({
                url: view.url,
                label: view.label,
                ok: true,
                endpoints: Object.keys(captured).length,
                new_endpoints: added,
                final_url: finalUrl,
            });
        } catch (e) {
            // AUTH_REQUIRED / CAPTCHA_REQUIRED are fatal for the whole
            // pull — no later view will fare better, so stop early and
            // report the reason rather than burning 30s per remaining
            // view. Anything else is per-view and the sweep continues.
            const code = (e && e.code) || '';
            viewReports.push({
                url: view.url,
                label: view.label,
                ok: false,
                code: code || 'VIEW_FAILED',
                message: (e && e.message) || String(e),
            });
            if (code === 'AUTH_REQUIRED' || code === 'CAPTCHA_REQUIRED') {
                firstError = e;
                break;
            }
        }
    }

    if (firstError && Object.keys(raw).length === 0) throw firstError;

    return {
        raw,
        views: viewReports,
        final_url: lastFinalUrl,
        bytes: totalBytes,
        dropped: droppedCount,
        dropped_bytes: droppedBytes,
    };
}

/**
 * Build the standard { code } error a handler throws for a login wall.
 */
export function authError(message, data) {
    const err = new Error(`AUTH_REQUIRED: ${message}`);
    err.code = 'AUTH_REQUIRED';
    if (data) err.data = data;
    return err;
}

export function captchaError(message, data) {
    const err = new Error(`CAPTCHA_REQUIRED: ${message}`);
    err.code = 'CAPTCHA_REQUIRED';
    if (data) err.data = data;
    return err;
}

// Platforms scatter the human-readable reason across message / msg /
// error / detail, and 画加 puts the English one in `msg` while the
// Chinese lives in `error` — reading only the first field found made an
// expired session look like an empty order list (measured 2026-08-17:
// {code: 2003, error: "登录已失效，请重新登录", msg: "session expired"}).
// Concatenate every candidate and match against the union.
export function reasonText(parsed) {
    if (!parsed || typeof parsed !== 'object') return '';
    return ['message', 'msg', 'error', 'detail', 'errmsg', 'error_msg']
        .map((k) => (typeof parsed[k] === 'string' ? parsed[k] : ''))
        .filter(Boolean)
        .join(' | ');
}

const AUTH_RE = /未登录|请登录|登录已(过期|失效)|重新登录|登录状态|not.?log(ged)?.?in|unauthor|session.?expired|need.?login/i;
const CAPTCHA_RE_TEXT = /验证码|人机|滑块|captcha|verify.?code|risk.?control/i;

/**
 * Shared envelope check. `authCodes` lists the platform's own numeric
 * codes for "you are not logged in" — the text match alone is not
 * enough, and the numeric code alone is not portable.
 */
export function classifyEnvelope(parsed, authCodes) {
    if (!parsed || typeof parsed !== 'object') return;
    const code = parsed.code ?? parsed.status ?? null;
    const text = reasonText(parsed);
    if ((authCodes && authCodes.includes(code)) || AUTH_RE.test(text)) {
        throw authError(text || `code ${code}`);
    }
    if (CAPTCHA_RE_TEXT.test(text)) {
        throw captchaError(text || `code ${code}`);
    }
}
