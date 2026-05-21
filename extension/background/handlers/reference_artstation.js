/*
 * ArtStation reference search handler (Wisp read-side).
 *
 * Why: Danbooru is anime-only and thumbnails are blurry; Pinterest's
 * anti-bot wall returns captchas. ArtStation is the professional/
 * concept-art/illustration channel — high-res thumbs, curated, strong
 * for cinematic / landscape / fantasy / character-design mood queries
 * that Danbooru can't match in visual polish.
 *
 * Flow mirrors the Pinterest handler — withCdpTab, wait for grid,
 * scroll N times, extract project cards via DOM walk.
 *
 * ArtStation's grid is built from `<a href="/artwork/<hash>">` anchors;
 * we walk those rather than class names so the handler survives
 * Vue/React class-name churn.
 */
import { withCdpTab } from '../cdp.js';
import { sleep, preActionDelay } from '../humanize.js';

const SEARCH_URL_BASE = 'https://www.artstation.com/search?query=';
const LOGIN_RE = /artstation\.com\/users\/sign_in/;

// Selectors to wait for — `/artwork/` href anchors are the load-bearing
// signal; class-named containers are fallbacks for older A/B variants.
const GRID_SELECTORS = [
    'a[href*="/artwork/"]',
    '.project-card',
    '.thumb-content',
];

const DEFAULT_SCROLL_ROUNDS = 4;
const DEFAULT_MAX_ITEMS = 40;
const DEFAULT_GRID_TIMEOUT_MS = 15_000;

/**
 * @param {Object} payload
 * @param {string} payload.query           Search keywords (required).
 * @param {number} [payload.max_items]     Cap on returned items (default 40).
 * @param {number} [payload.scroll_rounds] How many viewport scrolls (default 4).
 * @returns {Promise<{items: Array, total: number, final_url: string}>}
 */
export async function fetchArtstationReferences(payload) {
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
        // Wait for the artwork-anchor grid. ArtStation's SPA delays
        // rendering ~1-2s after navigation while it hydrates.
        try {
            await session.waitForAnySelector(GRID_SELECTORS, {
                timeoutMs: DEFAULT_GRID_TIMEOUT_MS,
                pollMs: 400,
            });
        } catch (e) {
            const finalUrl = await session.getUrl();
            if (LOGIN_RE.test(finalUrl)) {
                const err = new Error('AUTH_REQUIRED: ArtStation forced login');
                err.code = 'AUTH_REQUIRED';
                err.data = { final_url: finalUrl };
                throw err;
            }
            throw e;
        }

        // Scroll for lazy-load. ArtStation appends ~24 cards per round.
        for (let i = 0; i < scrollRounds; i++) {
            await session.evaluateFn(() => {
                window.scrollBy(0, window.innerHeight * 0.9);
            });
            await preActionDelay();
            await sleep(700 + Math.floor(Math.random() * 500));
        }

        const items = await session.evaluateFn((cap) => {
            // Walk every `/artwork/<id>` anchor — that's the stable
            // signal across all ArtStation grid layouts.
            const anchors = Array.from(document.querySelectorAll('a[href*="/artwork/"]'));
            const seenHrefs = new Set();
            const out = [];
            for (const a of anchors) {
                if (out.length >= cap) break;
                const href = a.getAttribute('href');
                if (!href || seenHrefs.has(href)) continue;
                // Some anchors are decorative (e.g. wrap a comment count);
                // require a child <img> as the "this is a card" signal.
                const img = a.querySelector('img');
                if (!img) continue;
                seenHrefs.add(href);

                // Resolve thumb URL. ArtStation uses several patterns:
                //   - direct src on <img>
                //   - srcset (newer; pick widest)
                //   - data-src for lazy-load (not yet swapped to src)
                let thumbUrl = img.currentSrc || img.src || img.dataset.src || '';
                if (!thumbUrl && img.srcset) {
                    const parts = img.srcset.split(',').map(s => s.trim().split(' ')[0]).filter(Boolean);
                    thumbUrl = parts[parts.length - 1] || '';
                }
                if (!thumbUrl) continue;

                // Upgrade thumbnail size — ArtStation serves /small_square/
                // /medium_square/ /large/ variants via URL path. /large/
                // gives ~1200px wide (vs /small_square/ at 200px square).
                thumbUrl = thumbUrl.replace(
                    /\/(micro_square|smaller_square|small_square|small|medium_square|medium)\//,
                    '/large/'
                );

                const pageUrl = new URL(href, location.origin).href;

                // Try to find the artist's name near this card. Common
                // patterns: a sibling anchor like /<username>, or text
                // node with the user link. Falls back to empty string.
                let artist = '';
                let parent = a.parentElement;
                for (let depth = 0; depth < 4 && parent; depth++, parent = parent.parentElement) {
                    const userLink = parent.querySelector('a[href^="/"]:not([href*="/artwork/"]):not([href*="/search"])');
                    if (userLink) {
                        artist = (userLink.textContent || '').trim();
                        if (artist) break;
                    }
                }

                out.push({
                    thumb_url: thumbUrl,
                    page_url: pageUrl,
                    alt: img.alt || '',
                    artist: artist,
                    width: img.naturalWidth || 0,
                    height: img.naturalHeight || 0,
                });
            }
            return out;
        }, [maxItems]);

        const finalUrl = await session.getUrl();

        if (LOGIN_RE.test(finalUrl) && items.length === 0) {
            const err = new Error('AUTH_REQUIRED: ArtStation forced login mid-scroll');
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
