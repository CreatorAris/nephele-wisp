/*
 * Huaban (花瓣) reference search handler (Wisp read-side).
 *
 * Why a Wisp handler:
 *   Huaban is fronted by Tencent EdgeOne. Anonymous curl / Playwright
 *   get HTTP 405 on the homepage and 403/567 on CDN image URLs even
 *   with a browser UA + referer. The CDN apparently fingerprints the
 *   real browser (TLS / cookie / EdgeOne challenge token combo) and
 *   refuses everything else. Running inside the user's logged-in Edge
 *   via CDP attach is the only path that works.
 *
 * Inline-base64 image transfer:
 *   Unlike Pinterest/ArtStation (Python can download thumbs directly
 *   from their CDNs), the huaban CDN refuses Python requests outright.
 *   So this handler downloads each thumbnail INSIDE the SW (which
 *   shares the browser's cookies + EdgeOne challenge state) and
 *   inlines the bytes as base64 on each item. Python decodes and
 *   writes the cache file from the inline data — no follow-up fetch.
 *
 *   Each thumbnail is ~10-20 KB at 240px width; base64 inflates by
 *   33%, so 20 items ≈ 520 KB — fits inside the NMH 1 MB frame cap
 *   with headroom.
 *
 * Flow:
 *   1. Open https://huaban.com/search?q=<query> via withCdpTab.
 *   2. Wait for `a[href^="/pins/"]` pin links to render.
 *   3. Scroll N times so lazy-loaded pins fill the viewport.
 *   4. Extract {pin_id, thumb_url, page_url, alt, w, h} from each
 *      pin link's inner <img>.
 *   5. For each pin, SW-side fetch the thumbnail and base64 it.
 *      Skip pins whose fetch fails (CDN sometimes 410s on expired
 *      auth_key signatures).
 *   6. Return { items: [{ ..., image_b64, image_mime }, ...] }.
 */
import { withCdpTab } from '../cdp.js';
import { sleep, preActionDelay } from '../humanize.js';

const SEARCH_URL_BASE = 'https://huaban.com/search?q=';
const PIN_LINK_SELECTOR = 'a[href^="/pins/"]';

// Huaban sits behind Tencent Cloud EdgeOne, which intermittently serves a
// "prove you're human" interstitial instead of the site. The browser normally
// holds a clearance cookie and we never see it, which is why the same query
// succeeds for one user and fails for another on the same day. When it does
// appear, the pin grid never renders and the old code reported DOM_NOT_FOUND —
// i.e. "our extractor broke", sending everyone hunting for stale selectors.
// The selectors are fine; the page simply isn't huaban.
//
// Verified 2026-08-08 against the live site: title "Security Verification",
// body "正在验证连接安全性，请勾选下方复选框。… Protected by Tencent Cloud EdgeOne".
// Matched on several independent markers so a copy tweak on their side
// degrades to the old DOM_NOT_FOUND rather than a wrong diagnosis.
const CHALLENGE_MARKERS = [
    'Tencent Cloud EdgeOne',
    'Security Verification',
    '正在验证连接安全性',
    '验证完成后',
];

const DEFAULT_SCROLL_ROUNDS = 4;
const DEFAULT_MAX_ITEMS = 24;        // cap lower than Pinterest — bytes weigh more
const DEFAULT_GRID_TIMEOUT_MS = 15_000;
const PER_IMAGE_FETCH_TIMEOUT_MS = 10_000;


function _arrayBufferToBase64(buf) {
    // Direct String.fromCharCode chunked — avoids the call-stack limit
    // hit by spreading a Uint8Array of >100k bytes into fromCharCode.
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(
            null, bytes.subarray(i, i + chunkSize),
        );
    }
    return btoa(binary);
}


/**
 * @param {Object} payload
 * @param {string} payload.query           Search keywords (required).
 * @param {number} [payload.max_items]     Cap on returned items (default 24).
 * @param {number} [payload.scroll_rounds] Scroll rounds for lazy load (default 4).
 */
export async function fetchHuabanReferences(payload) {
    const query = String(payload?.query || '').trim();
    if (!query) {
        const err = new Error('INVALID_PAYLOAD: query is required');
        err.code = 'INVALID_PAYLOAD';
        throw err;
    }
    const maxItems = Math.min(40, Math.max(6,
        parseInt(payload?.max_items, 10) || DEFAULT_MAX_ITEMS));
    const scrollRounds = Math.min(8, Math.max(1,
        parseInt(payload?.scroll_rounds, 10) || DEFAULT_SCROLL_ROUNDS));

    const url = SEARCH_URL_BASE + encodeURIComponent(query);

    return await withCdpTab(url, async (session) => {
        // 1. Wait for pin links to appear. Huaban sometimes shows an
        //    onboarding overlay first; the search grid sits behind it.
        try {
            await session.waitForAnySelector([PIN_LINK_SELECTOR], {
                timeoutMs: DEFAULT_GRID_TIMEOUT_MS,
                pollMs: 400,
            });
        } catch (e) {
            const finalUrl = await session.getUrl();
            // Before blaming the extractor, look at what the page actually is.
            let probe = null;
            try {
                probe = await session.evaluateFn(() => ({
                    title: document.title || '',
                    text: ((document.body && document.body.innerText) || '').slice(0, 400),
                }));
            } catch (_) { /* page may be mid-navigation — fall through */ }

            const haystack = `${probe?.title || ''}\n${probe?.text || ''}`;
            const hit = CHALLENGE_MARKERS.find((m) => haystack.includes(m));
            if (hit) {
                const err = new Error(
                    'CAPTCHA_REQUIRED: huaban is behind an EdgeOne human-verification page',
                );
                err.code = 'CAPTCHA_REQUIRED';
                err.data = { final_url: finalUrl, matched: hit };
                throw err;
            }

            // Genuinely no grid and no challenge. Keep the honest code, but
            // carry evidence so the next occurrence is diagnosable instead of
            // guesswork — this is the branch a real DOM change would land in.
            // The title rides in the MESSAGE, not just `data`: the desktop
            // logs `err_obj.message` and drops `data`, so anything only in
            // `data` is invisible where the diagnosis actually happens.
            const err = new Error(
                'DOM_NOT_FOUND: huaban pin grid never rendered'
                + ` (title=${JSON.stringify(probe?.title || '')})`,
            );
            err.code = 'DOM_NOT_FOUND';
            err.data = {
                final_url: finalUrl,
                page_title: probe?.title || '',
                page_head: (probe?.text || '').slice(0, 200),
            };
            throw err;
        }

        // 2. Scroll to load more pins. Huaban uses virtual scroll like
        //    Pinterest — fire a window.scrollBy and pause for lazy-load.
        for (let i = 0; i < scrollRounds; i++) {
            await session.evaluateFn(() => {
                window.scrollBy(0, window.innerHeight * 0.9);
            });
            await preActionDelay();
            await sleep(700 + Math.floor(Math.random() * 400));
        }

        // 3. Extract pin metadata. The pin link's href is
        //    /pins/<id>?<long query trail>; canonicalize to /pins/<id>.
        const pins = await session.evaluateFn((selector, cap) => {
            const seen = new Set();
            const out = [];
            for (const a of document.querySelectorAll(selector)) {
                if (out.length >= cap) break;
                const img = a.querySelector('img');
                if (!img || !img.src) continue;
                const m = a.getAttribute('href').match(/^\/pins\/(\d+)/);
                if (!m) continue;
                const pinId = m[1];
                if (seen.has(pinId)) continue;
                seen.add(pinId);
                out.push({
                    pin_id: pinId,
                    thumb_url: img.src,
                    page_url: new URL(`/pins/${pinId}`, location.origin).href,
                    alt: img.alt || '',
                    width: img.naturalWidth || 0,
                    height: img.naturalHeight || 0,
                });
            }
            return out;
        }, [PIN_LINK_SELECTOR, maxItems]);

        if (pins.length === 0) {
            // Grid existed but yielded no usable pins. Could be all
            // ad/promo blocks above the fold; let the caller decide.
            return {
                items: [],
                total: 0,
                final_url: await session.getUrl(),
                query,
            };
        }

        // 4. SW-side fetch each thumbnail. credentials:'include' is
        //    critical — huaban CDN demands the EdgeOne challenge cookie
        //    the user's browser already holds.
        const items = [];
        for (const pin of pins) {
            try {
                const controller = new AbortController();
                const timer = setTimeout(
                    () => controller.abort(), PER_IMAGE_FETCH_TIMEOUT_MS,
                );
                let resp;
                try {
                    resp = await fetch(pin.thumb_url, {
                        credentials: 'include',
                        signal: controller.signal,
                    });
                } finally {
                    clearTimeout(timer);
                }
                if (!resp.ok) continue;
                const ab = await resp.arrayBuffer();
                if (ab.byteLength === 0) continue;
                items.push({
                    ...pin,
                    image_b64: _arrayBufferToBase64(ab),
                    image_mime: resp.headers.get('content-type') || 'image/jpeg',
                    image_bytes: ab.byteLength,
                });
            } catch (e) {
                // single-image fetch failures are silently dropped — a
                // few 410s among 20 is normal on signed-URL CDNs.
            }
        }

        return {
            items,
            total: items.length,
            final_url: await session.getUrl(),
            query,
        };
    }, { keepTab: false, active: false });
}
