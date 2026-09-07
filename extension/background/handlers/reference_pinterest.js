import { extractPageResources } from './reference_resources.js';

async function extractPinterestPage(payload) {
    const result = await extractPageResources(payload);
    return { ...result, items: result.items.map(item => ({ ...item, thumb_url: item.url, large_url: item.url })) };
}
/*
 * Pinterest reference search handler (Wisp read-side).
 *
 * Why a Wisp handler (not Playwright in the desktop app): Pinterest's
 * headless anti-bot (Tencent EdgeOne fronts the CN mirror too) returns
 * captcha pages to Playwright. Running inside the user's real browser
 * via CDP attach reuses their cookies and bypasses the bot detection,
 * which is the entire point of Wisp.
 *
 * Flow:
 *   1. Open https://www.pinterest.com/search/pins/?q=<query> in a
 *      background tab via withCdpTab.
 *   2. Wait for the pin grid container to render.
 *   3. Scroll N times with humanized pauses so lazy-load fills the
 *      viewport with thumbnails.
 *   4. evaluateFn() extracts {thumb_url, page_url, alt, width, height}
 *      from every `<div data-test-id="pin">` cell.
 *   5. Return { items: [...], total, final_url }.
 *
 * Failure modes the handler classifies:
 *   - AUTH_REQUIRED: redirect to login wall (Pinterest sometimes
 *     forces sign-in for hot tags from new sessions).
 *   - DOM_NOT_FOUND: grid never appeared within the wait window
 *     (rate limit / regional block / structure change).
 *   - empty items: query genuinely matched nothing on Pinterest.
 */
import { withCdpTab } from '../cdp.js';
import { sleep, preActionDelay } from '../humanize.js';

const SEARCH_URL_BASE = 'https://www.pinterest.com/search/pins/?q=';
const LOGIN_RE = /pinterest\.com\/login\/?/;

// Pinterest's grid uses a few different selectors across A/B variants.
// Try them in order — first hit wins.
const GRID_SELECTORS = [
    '[data-test-id="pin"]',
    'div[data-grid-item]',
    'div[data-test-id="pinrep"]',
];

const DEFAULT_SCROLL_ROUNDS = 4;
const DEFAULT_MAX_ITEMS = 60;
const DEFAULT_NAV_TIMEOUT_MS = 8_000;
const DEFAULT_GRID_TIMEOUT_MS = 15_000;

// Wait until the tab has actually landed on a pinterest.com document
// (withCdpTab creates the tab with the URL, but navigation may still be
// in flight — evaluating on about:blank would fetch from the wrong
// origin). Evaluate can throw while the context swaps; treat as not-ready.
async function waitForPinterestOrigin(session, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const ok = await session.evaluateFn(() =>
                location.hostname.includes('pinterest.') && document.readyState !== 'loading');
            if (ok === true) return true;
        } catch (_) { /* navigation in flight — retry */ }
        await sleep(300);
    }
    return false;
}

// Query Pinterest's internal BaseSearchResource API from the page's JS
// context. Returns items in the handler's output shape, or null when the
// API path is unavailable (wrong origin / non-200 / shape drift) so the
// caller falls back to the DOM walk. `rounds` maps scroll_rounds to
// bookmark-pagination depth — same "more scrolls, more pins" contract.
async function tryApiExtraction(session, query, maxItems, rounds, continuation = null) {
    const landed = await waitForPinterestOrigin(session, DEFAULT_NAV_TIMEOUT_MS);
    if (!landed) return null;

    let out = null;
    try {
        out = await session.evaluateAsyncFn(async (q, cap, maxRounds, prior) => {
            const collect = [...(prior?.pending || [])];
            let bookmark = prior?.bookmark || null;
            if (prior && !bookmark) return { status: 200, items: collect, bookmark: null };
            for (let round = 0; round < maxRounds && collect.length < cap; round++) {
                const options = { query: q, scope: 'pins', rs: 'typed' };
                if (bookmark) options.bookmarks = [bookmark];
                const url = '/resource/BaseSearchResource/get/?source_url='
                    + encodeURIComponent('/search/pins/?q=' + encodeURIComponent(q))
                    + '&data=' + encodeURIComponent(JSON.stringify({ options, context: {} }));
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 10_000);
                let r, j;
                try {
                r = await fetch(url, {
                    signal: controller.signal,
                    headers: {
                        'X-Requested-With': 'XMLHttpRequest',
                        'Accept': 'application/json, text/javascript, */*, q=0.01',
                        'x-pinterest-pws-handler': 'www/search/[scope].js',
                        'x-pinterest-appstate': 'active',
                    },
                    credentials: 'include',
                });
                j = r.status === 200 ? await r.json() : null;
                } finally { clearTimeout(timer); }
                if (r.status !== 200) return { status: r.status, items: collect, bookmark };
                const rr = (j || {}).resource_response || {};
                const results = (rr.data || {}).results || [];
                for (const x of results) {
                    if (!x || !x.images) continue;
                    const t236 = (x.images['236x'] || {}).url || '';
                    if (!t236) continue;
                    collect.push({
                        id: String(x.id || ''),
                        t236,
                        t736: (x.images['736x'] || {}).url || '',
                        w: (x.images.orig || {}).width || 0,
                        h: (x.images.orig || {}).height || 0,
                        alt: String(x.auto_alt_text || x.description || '').trim(),
                    });

                }
                bookmark = rr.bookmark || null;
                if (!bookmark || bookmark === '-end-') break;
            }
            return { status: 200, items: collect, bookmark };
        }, [query, maxItems, 1, continuation]);
    } catch (_) {
        return null; // context died / eval refused — DOM fallback decides
    }

    if (!out || !Array.isArray(out.items)) return null;
    if (out.status !== 200 && !out.items.length) {
        const code = out.status === 401 ? 'AUTH_REQUIRED' : out.status === 403 || out.status === 429 ? 'SITE_BLOCKED' : 'NETWORK_ERROR';
        throw Object.assign(new Error(code), { code });
    }

    const seen = new Set();
    const items = [];
    for (const it of out.items.slice(0, maxItems)) {
        // Same CDN tier policy as the DOM walk: 564x for the picker
        // grid, 736x for zoom/save (originals sometimes 404s).
        let thumbUrl = it.t236;
        let largeUrl = it.t736 || it.t236;
        const m = it.t236.match(/^(https?:\/\/[^/]+)\/(\d+x|\d+x\d+|originals)\/(.*)$/);
        if (m && m[2] !== 'originals') {
            thumbUrl = `${m[1]}/564x/${m[3]}`;
            largeUrl = `${m[1]}/736x/${m[3]}`;
        }
        if (seen.has(thumbUrl)) continue;
        seen.add(thumbUrl);
        items.push({
            thumb_url: thumbUrl,
            large_url: largeUrl,
            page_url: it.id ? `https://www.pinterest.com/pin/${it.id}/` : '',
            pin_id: it.id,
            alt: it.alt,
            width: it.w,
            height: it.h,
        });
    }
    const bookmark = out.bookmark && out.bookmark !== '-end-' ? out.bookmark : null;
    const pending = out.items.slice(maxItems);
    return { items, continuation: { query, bookmark, pending }, has_more: !!bookmark || pending.length > 0 };
}

/**
 * @param {Object} payload
 * @param {string} payload.query           Search keywords (required).
 * @param {number} [payload.max_items]     Cap on returned items (default 60).
 * @param {number} [payload.scroll_rounds] How many viewport scrolls (default 4).
 * @returns {Promise<{items: Array, total: number, final_url: string}>}
 */
export async function fetchPinterestReferences(payload) {
    const query = String(payload?.continuation?.query || payload?.query || '').trim();
    if (!query) {
        const err = new Error('INVALID_PAYLOAD: query is required');
        err.code = 'INVALID_PAYLOAD';
        throw err;
    }
    const maxItems = Math.min(120, Math.max(8,
        parseInt(payload?.max_items, 10) || DEFAULT_MAX_ITEMS));
    const scrollRounds = Math.min(8, Math.max(1,
        parseInt(payload?.scroll_rounds, 10) || DEFAULT_SCROLL_ROUNDS));

    const url = SEARCH_URL_BASE + encodeURIComponent(query);

    if (typeof payload?.continuation === 'string') {
        return await extractPinterestPage({ ...payload, url, max_items: maxItems });
    }
    return await withCdpTab(url, async (session) => {
        const api = await tryApiExtraction(session, query, maxItems, scrollRounds, payload?.continuation);
        if (api) return { ...api, total: api.items.length, final_url: await session.getUrl(), query };
        if (payload?.continuation) throw Object.assign(new Error('TIMEOUT: bookmark request failed'), { code: 'TIMEOUT' });
        return await extractPinterestPage({ url, max_items: maxItems, scroll_rounds: 2, budget_ms: 20_000, nav_timeout_ms: 5_000, settle_max_ms: 2_000 });
    }, { keepTab: false, active: false });
}
