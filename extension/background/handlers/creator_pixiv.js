/*
 * Pixiv 創作者ダッシュボード stats fetch handler.
 *
 * Pixiv's creator-side data is spread across several views:
 *   - /dashboard            — work-list + per-work stats (premium-leaning)
 *   - /users/<id>           — public profile (followers, total views)
 *   - /ajax/dashboard/...   — internal JSON endpoints the dashboard SPA calls
 *
 * First-pass URL filter is wide (anything on pixiv.net). The normalizer
 * downstream picks endpoints that carry durable metrics. Like the B站
 * handler, we do NOT call any internal API directly — we just observe
 * what the dashboard SPA naturally requests after navigation.
 *
 * AUTH detection: pixiv redirects unauthenticated visitors to
 * `accounts.pixiv.net/login`. CAPTCHA detection: pixiv occasionally
 * gates with hcaptcha — checks for `accounts.pixiv.net/captcha` in
 * final URL or known captcha JSON payloads.
 */
import { captureDashboardXhrs } from './creator_common.js';

const DASHBOARD_URL = 'https://www.pixiv.net/dashboard';
const URL_INCLUDE = /^https?:\/\/[^/]*\.?pixiv\.net\//;
const LOGIN_RE = /accounts\.pixiv\.net\/(login|signup)/;
const CAPTCHA_RE = /accounts\.pixiv\.net\/captcha/;

function classifyPixivResponse(parsed, _url) {
    // Pixiv's JSON envelope uses `error: true` for unauth/captcha; many
    // endpoints additionally include `message` describing the reason.
    if (parsed && parsed.error === true) {
        const msg = String(parsed.message || '').toLowerCase();
        if (msg.includes('login') || msg.includes('not logged')) {
            const err = new Error('AUTH_REQUIRED: pixiv login required');
            err.code = 'AUTH_REQUIRED';
            throw err;
        }
        if (msg.includes('captcha')) {
            const err = new Error('CAPTCHA_REQUIRED: pixiv captcha challenge');
            err.code = 'CAPTCHA_REQUIRED';
            throw err;
        }
    }
}

function classifyPixivFinalUrl(finalUrl) {
    if (CAPTCHA_RE.test(finalUrl)) {
        const err = new Error('CAPTCHA_REQUIRED: pixiv captcha redirect');
        err.code = 'CAPTCHA_REQUIRED';
        err.data = { final_url: finalUrl };
        throw err;
    }
    if (LOGIN_RE.test(finalUrl)) {
        const err = new Error('AUTH_REQUIRED: pixiv login redirect');
        err.code = 'AUTH_REQUIRED';
        err.data = { final_url: finalUrl };
        throw err;
    }
}

function extractPixivUid(captured) {
    // Pixiv exposes the logged-in uid in several places. Try the most
    // common: /ajax/user/self carries `body.userId`. As a fallback,
    // look for any /ajax/.../user/<id> response and grab the path id.
    for (const [url, entry] of Object.entries(captured)) {
        if (!/\/ajax\/user\/self/i.test(url)) continue;
        try {
            const j = JSON.parse(entry.body);
            const uid = j?.body?.userId || j?.body?.id;
            if (uid) return String(uid);
        } catch (_) { /* noop */ }
    }
    for (const [url, _entry] of Object.entries(captured)) {
        const m = url.match(/\/users\/(\d+)/);
        if (m) return m[1];
    }
    return '';
}

export async function fetchPixivStats(_payload) {
    const { captured, finalUrl } = await captureDashboardXhrs({
        dashboardUrl: DASHBOARD_URL,
        urlIncludeRegex: URL_INCLUDE,
        classifyResponse: classifyPixivResponse,
        classifyFinalUrl: classifyPixivFinalUrl,
    });
    return {
        platform: 'pixiv',
        account_uid: extractPixivUid(captured),
        captured_at: new Date().toISOString(),
        final_url: finalUrl,
        endpoint_count: Object.keys(captured).length,
        raw: captured,
    };
}
