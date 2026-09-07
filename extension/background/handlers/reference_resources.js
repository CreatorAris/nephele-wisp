/*
 * Generic webpage resource extraction via the user's real browser.
 *
 * This is the structural path for "save/download images from this page":
 * Wisp opens the URL in a normal browser tab, lets the page render, scrolls
 * lazy content into view, extracts image candidates from DOM + performance
 * entries, then fetches bytes from inside the extension/browser context.
 *
 * Native Messaging frames are capped at 1 MB, so bytes are capped per item
 * and per response. Oversized or blocked images are reported explicitly.
 */
import { withCdpTab, isLocalIngestUrl } from '../cdp.js';
import { sleep, preActionDelay } from '../humanize.js';
import { withReferenceSession } from './reference_sessions.js';

// Score standing in for the area of an unlaid-out lazy slide, and the floor
// for "big enough to be the artwork" — 600x600, under any real cover and over
// every name plate and icon.
const ART_RANK = 360000;
// Every element type the collection passes below can draw a candidate from,
// as one selector. Kept module-level because the settle census counts the
// same population the extraction will later walk.
const LAZY_ATTRS = ['data-background', 'data-src', 'data-original', 'data-lazy', 'data-bg'];
const LAZY_SELECTOR = LAZY_ATTRS.map((a) => `[${a}]`).join(',') + ',[data-srcset]';
// Ceiling and cadence for waiting out a client-rendered page (see _settle).
const DEFAULT_SETTLE_MAX_MS = 8_000;
const SETTLE_POLL_MS = 400;
const SETTLE_STABLE_ROUNDS = 3;
// A quiet census does not mean "done" — it also describes a page sitting on
// an in-flight fetch with nothing rendered yet. Measured: a page that renders
// its artwork at t+3s was declared settled at 835ms and extracted with only
// its placeholder thumbnails, i.e. exactly the failure this wait exists to
// prevent. So no run may conclude before observing for this long.
const SETTLE_MIN_MS = 2_000;
const DEFAULT_SCROLL_ROUNDS = 3;
const DEFAULT_MAX_ITEMS = 48;
const DEFAULT_NAV_TIMEOUT_MS = 30_000;
// We now inline only small THUMBNAILS (the picker shows these; full images
// are fetched on-select via reference.fetch_full over the HTTP ingest
// channel). Thumbs are ~6-10 KB so dozens fit under the 1 MB NM frame.
const DEFAULT_TOTAL_INLINE_BYTES = 600_000;
const THUMB_MAX_EDGE = 256;
const THUMB_QUALITY = 0.62;
const PER_IMAGE_FETCH_TIMEOUT_MS = 12_000;
const FULL_FETCH_TIMEOUT_MS = 20_000;

function _arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

// Downscale an image blob to a small JPEG thumbnail (SW-side, OffscreenCanvas).
async function _makeThumb(blob) {
    const bmp = await createImageBitmap(blob);
    const ow = bmp.width || THUMB_MAX_EDGE;
    const oh = bmp.height || THUMB_MAX_EDGE;
    const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(ow, oh));
    const w = Math.max(1, Math.round(ow * scale));
    const h = Math.max(1, Math.round(oh * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, w, h);
    try { bmp.close(); } catch (_) {}
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: THUMB_QUALITY });
    const buf = await out.arrayBuffer();
    return { b64: _arrayBufferToBase64(buf), mime: 'image/jpeg', bytes: buf.byteLength, w: ow, h: oh };
}

function _normalizeUrl(url, baseUrl) {
    if (!url || typeof url !== 'string') return '';
    const trimmed = url.trim();
    if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return '';
    try {
        return new URL(trimmed, baseUrl).href;
    } catch (_) {
        return '';
    }
}

function _isLikelyImageUrl(url) {
    return /\.(png|jpe?g|webp|gif|avif|bmp)(\?|#|$)/i.test(url)
        || /\/(image|img|photo|picture|thumb|large|small|medium)\//i.test(url)
        || /(images?|thumb|cover|avatar|asset)/i.test(url);
}

// Identity tokens for the page being extracted, used to float THIS page's
// artwork above its neighbours'. Carousel-driven sites ship the whole roster
// in one swiper, so every character page yields the same slides in the same
// order — on zzz.mihoyo.com a request for 千夏 (character?id=161826) returns
// all 60 covers, and area ranking alone leaves the one actually asked for
// wherever DOM order happens to put it. The id in the page URL reappears as a
// path segment in its art URL (content-v2/nap/161826/<hash>.png), which is
// enough to pick it out without a per-site extractor.
const _ID_PARAM_RE = /^(id|cid|char|charid|character|item|itemid|aid|pid|uid)$/i;

export function _identityTokens(pageUrl) {
    const tokens = new Set();
    try {
        const u = new URL(pageUrl);
        for (const [key, value] of u.searchParams.entries()) {
            if (!_ID_PARAM_RE.test(key)) continue;
            const token = String(value || '').trim();
            // 3+ chars keeps "1"/"en" from matching half the CDN paths.
            if (/^[A-Za-z0-9_-]{3,}$/.test(token)) tokens.add(token);
        }
        // Path-style ids (/character/161826). Digits only — a slug like
        // "character" would match the site's own asset folders.
        const last = u.pathname.split('/').filter(Boolean).pop() || '';
        if (/^\d{3,}$/.test(last)) tokens.add(last);
    } catch (_) { /* unparseable → no boost, plain area ranking */ }
    return tokens;
}

// Whole-segment match only: a substring test would let id 1618 claim
// /content-v2/nap/161826/.
export function _matchesIdentity(imageUrl, tokens) {
    if (!tokens || !tokens.size) return false;
    try {
        return new URL(imageUrl).pathname.split('/').filter(Boolean)
            .some((seg) => tokens.has(seg));
    } catch (_) {
        return false;
    }
}

// Full-resolution URL candidates from a (often grid-thumbnail) image URL,
// best-first, with the ORIGINAL always last as a fallback. Pure URL rewriting
// of known CDN size tokens — a light heuristic, not a per-platform extractor
// (cf. find_references' Pixiv hi-res upgrade). fetch_full tries each in order
// and falls back to the original if an upgraded URL 404s, so a wrong guess
// never costs the user the image.
export function _fullResCandidates(url) {
    const out = [];
    try {
        const u = new URL(url);
        const path = u.pathname;
        // ArtStation: /.../<id>/<timestamp>/<square>/<name>.<ext>
        //          →  /.../<id>/large/<name>.webp
        // The full renditions (large / 4k) drop the timestamp directory AND are
        // served as .webp — verified live: the grid's smaller_square/<n>.jpg
        // upgrades to large/<n>.webp (528 KB vs 64 KB). Try large first (what
        // the artwork page itself displays, always present), then 4k.
        const as = path.match(
            /^(.*)\/\d{6,}\/(?:micro_square|smaller_square|small_square|medium_square|larger_square)\/([^/]+?)\.(jpe?g|png|webp)$/i);
        if (as) {
            const stem = as[1];          // .../<id>
            const name = as[2];          // filename without extension
            const ext = as[3].toLowerCase();
            for (const size of ['large', '4k']) {
                for (const e of ['webp', ext]) {
                    out.push(`${u.origin}${stem}/${size}/${name}.${e}${u.search}`);
                }
            }
        } else {
            // Generic CDN size-token swap (non-ArtStation): /<size>/<file> → bigger.
            const gen = path.match(
                /\/(micro_square|smaller_square|small_square|medium_square|larger_square|small|medium|thumb)\/([^/]+)$/);
            if (gen) {
                for (const big of ['large', '4k']) {
                    out.push(`${u.origin}${path.replace(`/${gen[1]}/${gen[2]}`, `/${big}/${gen[2]}`)}${u.search}`);
                }
            }
        }
    } catch (_) { /* unparseable → original only */ }
    out.push(url);
    return Array.from(new Set(out));
}

// Count requests in flight in the target tab, straight off the debugger
// already attached to it. Must be started BEFORE navigation: a SPA fires its
// data fetch during document parse, so a tracker armed afterwards sees the
// completion of a request it never saw begin — which is how the first cut of
// this reported peak:0 on a page that was visibly waiting on its API.
//
// Browser-level, so unlike wrapping window.fetch it leaves no trace in the
// page for an anti-bot script to find.
function _trackNetwork(session) {
    let inflight = 0;
    let peak = 0;
    let live = false;
    const onEvent = (src, method) => {
        if (!src || src.tabId !== session.tabId) return;
        if (method === 'Network.requestWillBeSent') {
            inflight++;
            if (inflight > peak) peak = inflight;
        } else if (method === 'Network.loadingFinished'
                || method === 'Network.loadingFailed') {
            if (inflight > 0) inflight--;
        }
    };
    const start = async () => {
        try {
            chrome.debugger.onEvent.addListener(onEvent);
            await session.send('Network.enable', {});
            live = true;
        } catch (_) {
            // No Network domain — the DOM census carries on alone, which is
            // still better than the fixed budget it replaced.
            try { chrome.debugger.onEvent.removeListener(onEvent); } catch (_2) { /* noop */ }
        }
    };
    return {
        start,
        get live() { return live; },
        get inflight() { return inflight; },
        get peak() { return peak; },
        stop() {
            if (!live) return;
            live = false;
            try { chrome.debugger.onEvent.removeListener(onEvent); } catch (_) { /* noop */ }
            session.send('Network.disable', {}).catch(() => { /* best-effort */ });
        },
    };
}

// Wait until the page stops producing new image candidates.
//
// The previous flow navigated, scrolled a fixed number of rounds, and
// extracted — which bets that a client-rendered page finishes within that
// budget. On a fast machine it does; the 2026-08 zzz.mihoyo.com failures all
// came back holding exactly the DOM prefix that exists mid-render (roster
// thumbnails, no covers, not even the page's own large <img>), i.e. the bet
// lost on slower clients. Census the candidate population instead and move on
// when it stops growing, so the wait scales with the machine and the network
// rather than with a constant chosen on a developer's box.
//
// Three conditions, all required: the census holds steady for
// SETTLE_STABLE_ROUNDS, nothing is in flight, and at least SETTLE_MIN_MS has
// passed. The network check is what stops a page sitting on an unanswered
// fetch from being mistaken for a finished one — measured: a page rendering
// its artwork on a 3s API was declared settled at 835ms by the census alone
// and extracted with only its placeholders.
//
// Cheap by construction: two querySelectorAll counts per poll, no geometry,
// no getComputedStyle. Capped so a page with a live-updating feed (counts
// never settle, sockets never close) cannot push handler time into the
// service worker's kill window — a timeout is not an error, just "extract
// what is there".
async function _settle(session, maxMs, net) {
    const started = Date.now();
    const deadline = started + maxMs;
    let last = -1;
    let stable = 0;
    let polls = 0;
    const report = (settled, count) => ({
        settled, polls, ms: Date.now() - started, count,
        network: net?.live ? { peak: net.peak, left: net.inflight } : null,
    });
    while (Date.now() < deadline) {
        let count;
        try {
            count = await session.evaluateFn(
                (sel) => document.images.length + document.querySelectorAll(sel).length,
                [LAZY_SELECTOR]);
        } catch (_) {
            // Navigation swapped the execution context out from under us;
            // the next poll re-evaluates against the new document.
            count = -1;
        }
        polls++;
        const quiet = !net?.live || net.inflight <= 0;
        if (count >= 0 && count === last && quiet) {
            stable++;
            if (stable >= SETTLE_STABLE_ROUNDS && Date.now() - started >= SETTLE_MIN_MS) {
                return report(true, count);
            }
        } else {
            stable = 0;
            last = count;
        }
        await sleep(SETTLE_POLL_MS);
    }
    return report(false, last);
}

// `parseInt(x, 10) || fallback` silently rewrites a legitimate 0 into the
// default — scroll_rounds:0 ("don't scroll") had been running 3 rounds.
function _intOpt(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
}

export async function extractPageResources(payload) {
    const url = String(payload?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
        const err = new Error('INVALID_PAYLOAD: url must start with http(s)');
        err.code = 'INVALID_PAYLOAD';
        throw err;
    }

    const maxItems = Math.min(60, Math.max(1,
        _intOpt(payload?.max_items, DEFAULT_MAX_ITEMS)));
    const scrollRounds = Math.min(8, Math.max(0,
        _intOpt(payload?.scroll_rounds, DEFAULT_SCROLL_ROUNDS)));
    const minSize = Math.max(0, _intOpt(payload?.min_size, 160));
    const totalInlineLimit = Math.min(600_000, Math.max(80_000,
        _intOpt(payload?.max_total_bytes, DEFAULT_TOTAL_INLINE_BYTES)));
    // Callers extracting from SPA feeds pass a short budget: the grid is
    // rendered within seconds while the load event trails by 30s+, and the
    // wasted wait pushes total handler time toward the SW kill window.
    const navTimeoutMs = Math.min(60_000, Math.max(5_000,
        _intOpt(payload?.nav_timeout_ms, DEFAULT_NAV_TIMEOUT_MS)));
    // 0 disables the settle wait entirely (callers that know the page is
    // static and want the old fixed-budget behaviour).
    const settleMaxMs = Math.min(20_000, Math.max(0,
        _intOpt(payload?.settle_max_ms, DEFAULT_SETTLE_MAX_MS)));

    return await withReferenceSession(payload, url, async (state) => {
    const resuming = state.tabId !== null;
    const deadline = Date.now() + Math.min(50_000, Number(payload?.budget_ms) || 50_000);
    return await withCdpTab(url, async (session, tab) => {
        state.tabId = tab.id;
        let navTimedOut = false;
        // The tab opened on about:blank (blankFirst below), so arming here
        // means the navigation just past this point is the only one on the
        // wire — every request the page makes is counted. Navigating a live
        // tab to about:blank instead does NOT work: its load event races the
        // real navigation's, and the wait returns against a blank document.
        const net = _trackNetwork(session);
        if (settleMaxMs > 0) await net.start();
        let settle;
        const glimpses = [];
        // Everything between start() and stop() can throw when a navigation
        // swaps the execution context (_settle already guards its own poll for
        // that). Without the finally, the debugger listener registered in
        // start() outlives the batch, and a retried session stacks another.
        try {
        try {
            if (!resuming) await session.navigate(url, { timeoutMs: Math.min(navTimeoutMs, 12_000) });
        } catch (e) {
            // Heavy SPA feeds (B站 space dynamics and other infinite
            // scrollers) keep the load event hostage to analytics/websocket
            // stragglers — the grid has long rendered when the nav budget
            // expires. Failing hard here returned TIMEOUT for perfectly
            // extractable pages (hit live on space.bilibili.com/*/dynamic,
            // 2026-08-15). Proceed and let extraction speak: a genuinely
            // dead navigation yields zero candidates, which callers already
            // handle; the flag below keeps the slow-load fact observable.
            navTimedOut = true;
        }

        // Do NOT add session.pumpFrame() here. It was tried (2026-08-20) on
        // the theory that Chrome parks rAF in background tabs and starves
        // swiper-driven galleries — the theory did not survive: a minimised
        // window still yielded every cover. Worse, a captureScreenshot on
        // this path tore down the native port on a slow-rendering page,
        // every time, surfacing desktop-side as a bare "connection closed".
        // waitForAnySelector's use of pumpFrame is fine — it pairs each pump
        // with a selector wait; a bare pump in the middle of extraction is
        // not. _settle above is what actually addresses late-rendering pages.
        const capture = async () => {
            let rows;
            try {
            rows = await session.evaluateFn(() => Array.from(document.images || []).map(img => ({
                url: img.currentSrc || img.src, alt: img.alt || '', width: img.naturalWidth,
                height: img.naturalHeight, page_url: img.closest('a')?.href || location.href, source_type: 'img',
            })).filter(img => img.url && img.width >= 160 && img.height >= 160));
            } catch (_) {
                rows = null; // context swapped mid-scroll — the final collection pass still runs
            }
            glimpses.push(...(rows || []));
        };
        await capture();
        for (let i = 0; i < (state.pending.some(item => (item.attempts || 0) < 2) ? 0 : scrollRounds); i++) {
            await session.evaluateFn(() => {
                window.scrollBy(0, window.innerHeight * 0.9);
            });
            await preActionDelay();
            await sleep(650 + Math.floor(Math.random() * 450));
            await capture();
        }

        // Scrolling is what triggers lazy loaders, so settle AFTER it: the
        // census must see whatever the last scroll kicked off.
        settle = settleMaxMs > 0
            ? await _settle(session, settleMaxMs, net)
            : { settled: false, polls: 0, ms: 0, count: -1, skipped: true };
        } finally {
            net.stop();
        }

        const collected = await session.evaluateFn((cap, minPx, lazySel) => {
            const abs = (u) => {
                try { return new URL(u, location.href).href; } catch (_) { return ''; }
            };
            const add = (out, seen, item) => {
                if (!item || !item.url || seen.has(item.url)) return;
                seen.add(item.url);
                out.push(item);
            };
            const bestFromSrcset = (srcset) => {
                if (!srcset) return '';
                const parts = String(srcset).split(',').map((part) => {
                    const bits = part.trim().split(/\s+/);
                    const u = bits[0] || '';
                    const score = parseInt((bits[1] || '').replace(/[^\d]/g, ''), 10) || 0;
                    return { u, score };
                }).filter((x) => x.u);
                parts.sort((a, b) => b.score - a.score);
                return parts[0]?.u || '';
            };

            const out = [];
            const seen = new Set();

            for (const img of Array.from(document.images || [])) {
                const rect = img.getBoundingClientRect();
                const width = img.naturalWidth || Math.round(rect.width) || 0;
                const height = img.naturalHeight || Math.round(rect.height) || 0;
                if (Math.max(width, height) < minPx) continue;
                const src = img.currentSrc || bestFromSrcset(img.srcset) || img.src || '';
                const pageLink = img.closest('a[href]')?.href || '';
                add(out, seen, {
                    url: abs(src),
                    page_url: pageLink ? abs(pageLink) : location.href,
                    alt: img.alt || img.title || '',
                    width,
                    height,
                    source_type: 'img',
                });
                if (out.length >= cap * 3) break;
            }
            const afterImgs = out.length;

            for (const source of Array.from(document.querySelectorAll('source[srcset]'))) {
                const src = bestFromSrcset(source.getAttribute('srcset'));
                add(out, seen, {
                    url: abs(src),
                    page_url: location.href,
                    alt: '',
                    width: 0,
                    height: 0,
                    source_type: 'source',
                });
            }

            const afterSource = out.length;

            for (const el of Array.from(document.querySelectorAll('*'))) {
                if (out.length >= cap * 4) break;
                const bg = getComputedStyle(el).backgroundImage || '';
                const matches = Array.from(bg.matchAll(/url\(["']?([^"')]+)["']?\)/g));
                for (const m of matches) {
                    const rect = el.getBoundingClientRect();
                    if (Math.max(rect.width || 0, rect.height || 0) < minPx) continue;
                    add(out, seen, {
                        url: abs(m[1]),
                        page_url: location.href,
                        alt: el.getAttribute('aria-label') || el.getAttribute('title') || '',
                        width: Math.round(rect.width) || 0,
                        height: Math.round(rect.height) || 0,
                        source_type: 'background',
                    });
                }
            }

            // Lazy loaders (Swiper's swiper-lazy, lazysizes, …) park the real
            // URL in a data-* attribute until the slide is activated. Scrolling
            // the page does NOT activate a carousel, so a scan can run while
            // every slide is still blank: zzz.mihoyo.com serves its 1297x1369
            // character art as a lazy background and the passes above saw none
            // of it — only the site logo and the 79x82 roster thumbnails.
            // Deliberately no minPx gate here: an unactivated slide has no laid
            // out box, and dropping the art is worse than admitting an icon.
            //
            // This list must stay in step with the module-level LAZY_ATTRS the
            // settle census counts through `lazySel` — the wait would otherwise
            // be watching a different population than the one collected here.
            // It cannot simply reference it: this function is serialised into
            // the page, where the module scope does not exist.
            const afterBg = out.length;
            const LAZY_ATTRS = ['data-background', 'data-src', 'data-original', 'data-lazy', 'data-bg'];
            for (const el of Array.from(document.querySelectorAll(lazySel))) {
                if (out.length >= cap * 5) break;
                let url = '';
                for (const a of LAZY_ATTRS) {
                    const v = el.getAttribute(a);
                    if (v) { url = v; break; }
                }
                if (!url) url = bestFromSrcset(el.getAttribute('data-srcset'));
                if (!url) continue;
                const rect = el.getBoundingClientRect();
                add(out, seen, {
                    url: abs(url),
                    page_url: location.href,
                    alt: el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '',
                    width: Math.round(rect.width) || 0,
                    height: Math.round(rect.height) || 0,
                    source_type: 'lazy',
                });
            }

            const afterLazy = out.length;

            const perf = performance.getEntriesByType('resource') || [];
            for (const entry of perf) {
                if (out.length >= cap * 5) break;
                if (entry.initiatorType !== 'img' && entry.initiatorType !== 'css') continue;
                add(out, seen, {
                    url: abs(entry.name),
                    page_url: location.href,
                    alt: '',
                    width: 0,
                    height: 0,
                    source_type: `performance:${entry.initiatorType}`,
                });
            }

            // Per-pass yields. When an extraction comes back wrong these say
            // WHICH pass went quiet, which is the difference between "the page
            // never rendered" and "we ranked the artwork off the end".
            return {
                out,
                stats: {
                    imgs: afterImgs,
                    source: afterSource - afterImgs,
                    background: afterBg - afterSource,
                    lazy: afterLazy - afterBg,
                    perf: out.length - afterLazy,
                    dom_images: document.images.length,
                    dom_lazy: document.querySelectorAll(lazySel).length,
                },
            };
        }, [maxItems, minSize, LAZY_SELECTOR]);
        const prior = new Map(state.pending.map(item => [item.url, item]));
        const candidates = [...state.pending, ...glimpses, ...(collected?.out || [])]
            .map(item => prior.has(item.url) ? prior.get(item.url) : item);
        const passStats = collected?.stats || {};

        const finalUrl = await session.getUrl();
        // Why the page yielded nothing matters more than that it did: a wall
        // reported as "extract_failed" sends people hunting for stale
        // selectors. EdgeOne's interstitial (huaban; markers verified
        // 2026-08-08: title "Security Verification", body "正在验证连接安全性 …
        // Protected by Tencent Cloud EdgeOne") and 小红书's forced-login modal
        // (verified 2026-09-08: .login-modal + .login-container visible, zero
        // images, "登录后查看搜索结果") are the two seen in the field.
        const gate = await session.evaluateFn(() => {
            const visible = el => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
            const text = `${document.title} ${(document.body?.innerText || '').slice(0, 2000)}`;
            // A challenge counts only when it is the page: a reCAPTCHA badge or
            // hCaptcha box serving some form elsewhere on a fully rendered
            // gallery must not read as a wall, so the widget has to be visible
            // AND the page has to have yielded nothing (no art-sized image).
            const hasArt = [...document.images].some(img => img.naturalWidth >= 160 && img.naturalHeight >= 160);
            const widget = [...document.querySelectorAll('iframe[src*="geetest"], iframe[src*="recaptcha/api2/bframe"], iframe[src*="hcaptcha.com/captcha"], .geetest_holder, .geetest_panel')].some(visible);
            if (widget && !hasArt) return 'CAPTCHA_REQUIRED';
            if (['Tencent Cloud EdgeOne', 'Security Verification', '正在验证连接安全性', '验证完成后'].some(m => text.includes(m))) return 'CAPTCHA_REQUIRED';
            if (/\/(login|signin)(\/|$)/i.test(location.pathname)
                || [...document.querySelectorAll('.login-container, .login-modal, [data-testid="login-modal"]')].some(visible)
                || text.includes('登录后查看搜索结果')) return 'AUTH_REQUIRED';
            return '';
        });
        if (gate) throw Object.assign(new Error(gate), { code: gate });

        // Collection runs <img> → <source> → background → lazy → performance,
        // and the cut below is a plain "first maxItems". On a page carrying 193
        // nav icons and roster thumbnails that spends every slot before the
        // background pass contributes — zzz.mihoyo.com's 1297x1369 character
        // art was collected and then ranked off the end, so the picker showed
        // the site logo instead. Rank by pixel area so the artwork survives.
        // A lazy slide has no laid-out box, so score it as art-sized rather
        // than zero: an unactivated carousel slide is usually the thing the
        // user came for. Performance entries stay last — they are guesses.
        const _rank = (it) => {
            const area = (it.width || 0) * (it.height || 0);
            if (area) return area;
            const t = String(it.source_type || '');
            if (t === 'lazy') return ART_RANK;
            if (t === 'source') return 10000;
            return 1;
        };
        // The page's own art first, then everything else by area. Sites that
        // put no id in the URL yield no tokens and fall through to plain area
        // ranking, which is the previous behaviour. The boost is gated on
        // ART_RANK because a character page also serves its own name plate,
        // icons and css-referenced scraps under the same id — unqualified,
        // those 227x70 pieces would outrank every neighbouring artwork and
        // eat the picker's first rows.
        const identity = _identityTokens(finalUrl);
        const _score = (it) => {
            const base = _rank(it);
            const mine = base >= ART_RANK && _matchesIdentity(it.url, identity);
            return (mine ? 1e9 : 0) + base;
        };
        const ranked = (candidates || []).slice().sort((a, b) => (a.attempts || 0) - (b.attempts || 0) || _score(b) - _score(a));

        const filtered = [];
        const seen = new Set();
        for (const item of ranked) {
            const normalized = _normalizeUrl(item.url, finalUrl);
            if (!normalized || seen.has(normalized) || state.seen.has(normalized)) continue;
            // Trust DOM-confident sources (img / source / background) — the
            // DOM already proves they are images, and their URLs are often
            // opaque/extensionless (e.g. pbs.twimg.com/media/<id>?format=jpg),
            // which the weak _isLikelyImageUrl proxy would wrongly drop.
            // Only gate ambiguous performance-entry candidates through it.
            const ambiguous = String(item.source_type || '').startsWith('performance');
            if (ambiguous && !_isLikelyImageUrl(normalized)) continue;
            seen.add(normalized);
            filtered.push({ ...item, url: normalized });
            if (filtered.length >= 1000) break;
        }

        const items = [];
        const skipped = [];
        let totalBytes = 0;

        let cursor = 0;
        const download = async (item) => {
            if (Date.now() >= deadline) return;
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), Math.min(PER_IMAGE_FETCH_TIMEOUT_MS, Math.max(1, deadline - Date.now())));
                let resp;
                try {
                    resp = await fetch(item.url, {
                        credentials: 'include',
                        signal: controller.signal,
                    });
                } catch (error) {
                    clearTimeout(timer);
                    throw error;
                }
                if (!resp.ok) {
                    clearTimeout(timer);
                    skipped.push({ url: item.url, reason: `http_${resp.status}` });
                    return;
                }
                // Reject non-images that slipped through URL heuristics
                // (fonts/css/json from performance entries). Tolerate a
                // missing or octet-stream type — some CDNs mislabel images.
                const ctype = (resp.headers.get('content-type') || '').toLowerCase();
                if (ctype && !ctype.startsWith('image/') && !ctype.includes('octet-stream')) {
                    clearTimeout(timer);
                    skipped.push({ url: item.url, reason: 'not_image', content_type: ctype });
                    return;
                }
                let blob;
                try { blob = await resp.blob(); } finally { clearTimeout(timer); }
                if (!blob.size) {
                    skipped.push({ url: item.url, reason: 'empty' });
                    return;
                }
                // Inline a small THUMBNAIL only — the full image is fetched
                // on-select via reference.fetch_full (HTTP ingest channel), so
                // there is no per-full-image size cap and dozens fit per frame.
                let thumb;
                try {
                    thumb = await _makeThumb(blob);
                } catch (e) {
                    skipped.push({ url: item.url, reason: 'thumb_failed', message: e?.message || String(e) });
                    return;
                }
                if (totalBytes + thumb.bytes > totalInlineLimit) {
                    skipped.push({ url: item.url, reason: 'thumb_budget_exceeded', bytes: thumb.bytes });
                    return;
                }
                totalBytes += thumb.bytes;
                items.push({
                    ...item,
                    // url stays = the FULL image URL (download-on-select).
                    thumb_b64: thumb.b64,
                    image_b64: thumb.b64,  // back-compat field name; carries the thumb
                    image_mime: thumb.mime,
                    image_bytes: thumb.bytes,
                    full_bytes: blob.size,
                    is_thumb: true,
                });
            } catch (e) {
                skipped.push({
                    url: item.url,
                    reason: e?.name === 'AbortError' ? 'timeout' : 'fetch_failed',
                    message: e?.message || String(e),
                });
            }
        };
        while (cursor < filtered.length && items.length < maxItems && Date.now() < deadline) {
            const wave = filtered.slice(cursor, cursor + Math.min(4, maxItems - items.length));
            cursor += wave.length;
            await Promise.all(wave.map(download));
        }
        items.sort((a, b) => filtered.findIndex(x => x.url === a.url) - filtered.findIndex(x => x.url === b.url));
        // The caller can't see where it landed. A 404 or a wiki's generic shell
        // still yields a pageful of chrome images, and the desktop side has been
        // reporting those as "official artwork" because nothing in the result
        // said which page they came from. The title is the cheapest tell:
        // 「达妮娅 - 中文Minecraft Wiki镜像」 and 「bilibili游戏中心 - WIKI」 both
        // announce the mistake outright.
        let pageTitle = '';
        try {
            pageTitle = String(await session.evaluateFn(() => document.title || '')).slice(0, 1000);
        } catch (_) { /* title is a nicety — never fail the extraction over it */ }

        const output = {
            items,
            skipped: skipped.slice(0, 20).map(item => ({ ...item, url: String(item.url || "").slice(0, 300), message: String(item.message || "").slice(0, 200) })),
            skipped_count: skipped.length,
            total: items.length,
            candidate_count: filtered.length,
            final_url: finalUrl,
            page_title: pageTitle,
            inline_bytes: totalBytes,
            nav_timed_out: navTimedOut,
            diag: {
                passes: passStats,
                settle,
                scroll_rounds: scrollRounds,
                collected: candidates.length,
                identity: Array.from(identity),
            },
        };
        while (items.length && new TextEncoder().encode(JSON.stringify(output)).length > 850_000) items.pop();
        output.total = items.length;
        const delivered = new Set(items.map(item => item.url));
        state.pending = filtered.filter(item => !delivered.has(item.url)).map(item => ({ ...item,
            attempts: (item.attempts || 0) + (filtered.indexOf(item) < cursor ? 1 : 0) }));
        for (const item of items) state.seen.add(item.url);
        return output;
    }, { keepTab: true, owned: true, reuseTabId: state.tabId, active: false, blankFirst: settleMaxMs > 0 });
    });
}

/*
 * reference.fetch_full — fetch FULL-resolution images the user picked, in
 * the user's real session (so anti-bot / cookie-gated CDNs serve them), and
 * stream the bytes back to the UI over the out-of-band HTTP ingest channel
 * (POST to http://127.0.0.1:<port>/wisp/ingest/<token>), bypassing the NM
 * 1 MB frame cap entirely. No CDP tab needed — these are plain authenticated
 * fetches from the extension/page-cookie context.
 *
 * payload: { items: [{ url, ingest_url, candidates? }, ...] }
 *   candidates: desktop-computed best-first full-res URLs (canonical); if
 *   absent, the extension's built-in _fullResCandidates(url) is used.
 * returns: { results: [{ url, ok, used_url?, upgraded?, bytes?, mime?, reason? }], ok_count, total }
 */
export async function fetchFullImages(payload) {
    const reqItems = Array.isArray(payload?.items) ? payload.items.slice(0, 80) : [];
    const results = [];
    for (const it of reqItems) {
        const url = String(it?.url || '');
        const ingestUrl = String(it?.ingest_url || '');
        if (!/^https?:\/\//i.test(url) || !isLocalIngestUrl(ingestUrl)) {
            results.push({ url, ok: false, reason: 'bad_item' });
            continue;
        }
        try {
            // Gallery/profile pages only expose grid thumbnails, so the picked
            // url is often a small image; full-res candidates get the real
            // artwork (a wrong guess 404s / non-image and falls through).
            // Prefer desktop-computed candidates (canonical, evolves via self-
            // update with no extension re-submit); fall back to the built-in
            // rewriter for older desktops. `url` is always a final fallback.
            let candidates = (Array.isArray(it.candidates) ? it.candidates : [])
                .filter((c) => typeof c === 'string' && /^https?:\/\//i.test(c))
                .slice(0, 8);
            if (!candidates.length) candidates = _fullResCandidates(url);
            if (!candidates.includes(url)) candidates.push(url);
            let resp = null;
            let usedUrl = url;
            for (const cand of candidates) {
                const isLast = cand === candidates[candidates.length - 1];
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), isLast ? FULL_FETCH_TIMEOUT_MS : 8000);
                try {
                    const r = await fetch(cand, { credentials: 'include', signal: controller.signal });
                    const ct = (r.headers.get('content-type') || '').toLowerCase();
                    if (r.ok && (!ct || ct.startsWith('image/') || ct.includes('octet-stream'))) {
                        resp = r;
                        usedUrl = cand;
                        break;
                    }
                } catch (_) {
                    // upgraded guess failed → try the next candidate
                } finally {
                    clearTimeout(timer);
                }
            }
            if (!resp) {
                results.push({ url, ok: false, reason: 'http_failed' });
                continue;
            }
            const buf = await resp.arrayBuffer();
            if (!buf.byteLength) {
                results.push({ url, ok: false, reason: 'empty' });
                continue;
            }
            const mime = resp.headers.get('content-type') || 'image/jpeg';
            const post = await fetch(ingestUrl, {
                method: 'POST',
                body: buf,
                headers: { 'Content-Type': mime },
            });
            if (!post.ok) {
                results.push({ url, ok: false, reason: `ingest_${post.status}` });
                continue;
            }
            results.push({ url, ok: true, used_url: usedUrl, upgraded: usedUrl !== url, bytes: buf.byteLength, mime });
        } catch (e) {
            results.push({
                url,
                ok: false,
                reason: e?.name === 'AbortError' ? 'timeout' : 'fetch_failed',
                message: e?.message || String(e),
            });
        }
    }
    return { results, ok_count: results.filter((r) => r.ok).length, total: results.length };
}
