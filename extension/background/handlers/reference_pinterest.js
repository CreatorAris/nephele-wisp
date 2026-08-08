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
const DEFAULT_NAV_TIMEOUT_MS = 20_000;
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
async function tryApiExtraction(session, query, maxItems, rounds) {
    const landed = await waitForPinterestOrigin(session, DEFAULT_NAV_TIMEOUT_MS);
    if (!landed) return null;

    let out = null;
    try {
        out = await session.evaluateAsyncFn(async (q, cap, maxRounds) => {
            const collect = [];
            let bookmark = null;
            for (let round = 0; round < maxRounds && collect.length < cap; round++) {
                const options = { query: q, scope: 'pins', rs: 'typed' };
                if (bookmark) options.bookmarks = [bookmark];
                const url = '/resource/BaseSearchResource/get/?source_url='
                    + encodeURIComponent('/search/pins/?q=' + encodeURIComponent(q))
                    + '&data=' + encodeURIComponent(JSON.stringify({ options, context: {} }));
                const r = await fetch(url, {
                    headers: {
                        'X-Requested-With': 'XMLHttpRequest',
                        'Accept': 'application/json, text/javascript, */*, q=0.01',
                        'x-pinterest-pws-handler': 'www/search/[scope].js',
                        'x-pinterest-appstate': 'active',
                    },
                    credentials: 'include',
                });
                if (r.status !== 200) return { status: r.status, items: collect };
                let j = null;
                try { j = await r.json(); } catch (_) { return { status: -1, items: collect }; }
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
                    if (collect.length >= cap) break;
                }
                bookmark = rr.bookmark || null;
                if (!bookmark || bookmark === '-end-') break;
            }
            return { status: 200, items: collect };
        }, [query, maxItems, Math.max(2, rounds)]);
    } catch (_) {
        return null; // context died / eval refused — DOM fallback decides
    }

    if (!out || !Array.isArray(out.items) || !out.items.length) return null;

    const seen = new Set();
    const items = [];
    for (const it of out.items) {
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
    return items;
}

/**
 * @param {Object} payload
 * @param {string} payload.query           Search keywords (required).
 * @param {number} [payload.max_items]     Cap on returned items (default 60).
 * @param {number} [payload.scroll_rounds] How many viewport scrolls (default 4).
 * @returns {Promise<{items: Array, total: number, final_url: string}>}
 */
export async function fetchPinterestReferences(payload) {
    const query = String(payload?.query || '').trim();
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

    return await withCdpTab(url, async (session) => {
        // 0. Preferred path: Pinterest's internal search API, fetched from
        //    the page's own JS context (real cookies + fingerprint, so
        //    anti-bot treats it as the site's own XHR). Zero DOM/rendering
        //    dependence — background tabs park rAF and throttle timers, so
        //    cold-cookie sessions (no SSR grid, client-side rAF-gated
        //    hydration) never render the grid and the DOM walk below times
        //    out with DOM_NOT_FOUND. That was the whole "extract_failed
        //    even with a working VPN" class. fetch() is not throttled.
        const apiItems = await tryApiExtraction(session, query, maxItems, scrollRounds);
        if (apiItems && apiItems.length) {
            const finalUrl = await session.getUrl();
            return {
                items: apiItems,
                total: apiItems.length,
                final_url: finalUrl,
                query,
            };
        }

        // 1. Fallback: wait for the grid container to appear and walk the
        //    DOM (original path — still the one that works if the API
        //    contract drifts). Pinterest can render a "Sign up"
        //    interstitial first; the grid often sits behind it in the
        //    DOM, so we look for the grid selector regardless.
        let gridSel = null;
        try {
            gridSel = await session.waitForAnySelector(GRID_SELECTORS, {
                timeoutMs: DEFAULT_GRID_TIMEOUT_MS,
                pollMs: 400,
                // Pump frames so rAF-gated hydration makes progress in
                // background tabs — necessary but not always sufficient
                // (timer chains stay 1Hz-throttled), hence API-first.
                framePump: true,
            });
        } catch (e) {
            // Grid never appeared. Check if we were redirected to login.
            const finalUrl = await session.getUrl();
            if (LOGIN_RE.test(finalUrl)) {
                const err = new Error('AUTH_REQUIRED: Pinterest forced login');
                err.code = 'AUTH_REQUIRED';
                err.data = { final_url: finalUrl };
                throw err;
            }
            throw e;
        }

        // 2. Scroll to load more pins. Pinterest uses virtual scrolling so
        //    we need actual viewport movement, not just scrollTo — fire
        //    Page.scrollIntoViewIfNeeded via evaluateFn on body, then a
        //    short humanized pause between rounds.
        for (let i = 0; i < scrollRounds; i++) {
            await session.evaluateFn(() => {
                // Scroll roughly one viewport height per round. Pinterest's
                // grid lazy-loads when bottom approaches the scrollable area.
                window.scrollBy(0, window.innerHeight * 0.9);
            });
            await preActionDelay();
            // Lazy-load only fires on painted frames — keep pumping in
            // background tabs so each scroll round actually loads pins.
            await session.pumpFrame();
            await sleep(700 + Math.floor(Math.random() * 500));
            await session.pumpFrame();
        }

        // 3. Extract pin metadata via DOM walk.
        const items = await session.evaluateFn((selector, cap) => {
            const cells = Array.from(document.querySelectorAll(selector));
            const seen = new Set();
            const out = [];
            for (const cell of cells) {
                if (out.length >= cap) break;
                // <img> is always inside the pin cell. Prefer naturalWidth-
                // bearing images so we skip lazy placeholders.
                const img = cell.querySelector('img');
                if (!img || !img.src) continue;
                // Pinterest CDN size variants: /236x/ (thumb), /564x/
                // (card detail, default for picker grid), /736x/ (large
                // preview, what we expose for zoom and Eagle save), and
                // /originals/ (full source — sometimes 404s when the
                // upload format differs, so we prefer /736x/ as the
                // "large" tier).
                let thumbUrl = img.src;
                let largeUrl = thumbUrl;
                const m = thumbUrl.match(/^(https?:\/\/[^/]+)\/(\d+x|\d+x\d+|originals)\/(.*)$/);
                if (m && m[2] !== 'originals') {
                    thumbUrl = `${m[1]}/564x/${m[3]}`;
                    largeUrl = `${m[1]}/736x/${m[3]}`;
                } else if (m && m[2] === 'originals') {
                    largeUrl = thumbUrl;  // already largest
                }
                if (seen.has(thumbUrl)) continue;
                seen.add(thumbUrl);
                // The cell wraps the pin in an <a href="/pin/<id>/">.
                let pageUrl = '';
                let pinId = '';
                const link = cell.querySelector('a[href^="/pin/"]');
                if (link) {
                    const href = link.getAttribute('href');
                    pageUrl = new URL(href, location.origin).href;
                    // /pin/123456789012345/ → 123456789012345
                    const idMatch = href.match(/\/pin\/(\d+)/);
                    if (idMatch) pinId = idMatch[1];
                }
                out.push({
                    thumb_url: thumbUrl,
                    large_url: largeUrl,
                    page_url: pageUrl,
                    pin_id: pinId,
                    alt: img.alt || '',
                    width: img.naturalWidth || 0,
                    height: img.naturalHeight || 0,
                });
            }
            return out;
        }, [gridSel, maxItems]);

        const finalUrl = await session.getUrl();

        // 4. Final auth check — even if grid rendered, the page may have
        //    swapped to a login wall mid-flow (rare but seen on cold IPs).
        if (LOGIN_RE.test(finalUrl) && items.length === 0) {
            const err = new Error('AUTH_REQUIRED: Pinterest forced login mid-scroll');
            err.code = 'AUTH_REQUIRED';
            err.data = { final_url: finalUrl };
            throw err;
        }

        return {
            items,
            total: items.length,
            final_url: finalUrl,
            query,
        };
    }, { keepTab: false, active: false });
}
