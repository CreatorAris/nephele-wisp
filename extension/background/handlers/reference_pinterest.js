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
        // 1. Wait for the grid container to appear. Pinterest can render
        //    a "Sign up" interstitial first; the grid often sits behind
        //    it in the DOM, so we look for the grid selector regardless.
        let gridSel = null;
        try {
            gridSel = await session.waitForAnySelector(GRID_SELECTORS, {
                timeoutMs: DEFAULT_GRID_TIMEOUT_MS,
                pollMs: 400,
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
            await sleep(700 + Math.floor(Math.random() * 500));
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
                // Pinterest serves thumbs at /236x/ — rewrite to a larger
                // size /564x/ which is the standard "card detail" image
                // (works without auth, hotlink-friendly via headers).
                let thumbUrl = img.src;
                const m = thumbUrl.match(/^(https?:\/\/[^/]+)\/(\d+x|\d+x\d+|originals)\/(.*)$/);
                if (m && m[2] !== 'originals') {
                    thumbUrl = `${m[1]}/564x/${m[3]}`;
                }
                if (seen.has(thumbUrl)) continue;
                seen.add(thumbUrl);
                // The cell wraps the pin in an <a href="/pin/<id>/">.
                let pageUrl = '';
                const link = cell.querySelector('a[href^="/pin/"]');
                if (link) {
                    pageUrl = new URL(link.getAttribute('href'), location.origin).href;
                }
                out.push({
                    thumb_url: thumbUrl,
                    page_url: pageUrl,
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
