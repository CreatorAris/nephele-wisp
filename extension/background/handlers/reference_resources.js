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

const DEFAULT_SCROLL_ROUNDS = 3;
const DEFAULT_MAX_ITEMS = 48;
const DEFAULT_NAV_TIMEOUT_MS = 30_000;
// We now inline only small THUMBNAILS (the picker shows these; full images
// are fetched on-select via reference.fetch_full over the HTTP ingest
// channel). Thumbs are ~6-10 KB so dozens fit under the 1 MB NM frame.
const DEFAULT_TOTAL_INLINE_BYTES = 900_000;
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

export async function extractPageResources(payload) {
    const url = String(payload?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
        const err = new Error('INVALID_PAYLOAD: url must start with http(s)');
        err.code = 'INVALID_PAYLOAD';
        throw err;
    }

    const maxItems = Math.min(60, Math.max(1,
        parseInt(payload?.max_items, 10) || DEFAULT_MAX_ITEMS));
    const scrollRounds = Math.min(8, Math.max(0,
        parseInt(payload?.scroll_rounds, 10) || DEFAULT_SCROLL_ROUNDS));
    const minSize = Math.max(0, parseInt(payload?.min_size, 10) || 160);
    const totalInlineLimit = Math.min(900_000, Math.max(80_000,
        parseInt(payload?.max_total_bytes, 10) || DEFAULT_TOTAL_INLINE_BYTES));

    return await withCdpTab(url, async (session) => {
        try {
            await session.navigate(url, { timeoutMs: DEFAULT_NAV_TIMEOUT_MS });
        } catch (e) {
            const err = new Error(`TIMEOUT: page load failed (${e?.message || e})`);
            err.code = 'TIMEOUT';
            throw err;
        }

        for (let i = 0; i < scrollRounds; i++) {
            await session.evaluateFn(() => {
                window.scrollBy(0, window.innerHeight * 0.9);
            });
            await preActionDelay();
            await sleep(650 + Math.floor(Math.random() * 450));
        }

        const candidates = await session.evaluateFn((cap, minPx) => {
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
            const LAZY_ATTRS = ['data-background', 'data-src', 'data-original', 'data-lazy', 'data-bg'];
            const lazySel = LAZY_ATTRS.map((a) => `[${a}]`).join(',') + ',[data-srcset]';
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

            return out;
        }, [maxItems, minSize]);

        const finalUrl = await session.getUrl();

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
            if (t === 'lazy') return 360000;
            if (t === 'source') return 10000;
            return 1;
        };
        const ranked = (candidates || []).slice().sort((a, b) => _rank(b) - _rank(a));

        const filtered = [];
        const seen = new Set();
        for (const item of ranked) {
            const normalized = _normalizeUrl(item.url, finalUrl);
            if (!normalized || seen.has(normalized)) continue;
            // Trust DOM-confident sources (img / source / background) — the
            // DOM already proves they are images, and their URLs are often
            // opaque/extensionless (e.g. pbs.twimg.com/media/<id>?format=jpg),
            // which the weak _isLikelyImageUrl proxy would wrongly drop.
            // Only gate ambiguous performance-entry candidates through it.
            const ambiguous = String(item.source_type || '').startsWith('performance');
            if (ambiguous && !_isLikelyImageUrl(normalized)) continue;
            seen.add(normalized);
            filtered.push({ ...item, url: normalized });
            if (filtered.length >= maxItems) break;
        }

        const items = [];
        const skipped = [];
        let totalBytes = 0;

        for (const item of filtered) {
            if (items.length >= maxItems) break;
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), PER_IMAGE_FETCH_TIMEOUT_MS);
                let resp;
                try {
                    resp = await fetch(item.url, {
                        credentials: 'include',
                        signal: controller.signal,
                    });
                } finally {
                    clearTimeout(timer);
                }
                if (!resp.ok) {
                    skipped.push({ url: item.url, reason: `http_${resp.status}` });
                    continue;
                }
                // Reject non-images that slipped through URL heuristics
                // (fonts/css/json from performance entries). Tolerate a
                // missing or octet-stream type — some CDNs mislabel images.
                const ctype = (resp.headers.get('content-type') || '').toLowerCase();
                if (ctype && !ctype.startsWith('image/') && !ctype.includes('octet-stream')) {
                    skipped.push({ url: item.url, reason: 'not_image', content_type: ctype });
                    continue;
                }
                const blob = await resp.blob();
                if (!blob.size) {
                    skipped.push({ url: item.url, reason: 'empty' });
                    continue;
                }
                // Inline a small THUMBNAIL only — the full image is fetched
                // on-select via reference.fetch_full (HTTP ingest channel), so
                // there is no per-full-image size cap and dozens fit per frame.
                let thumb;
                try {
                    thumb = await _makeThumb(blob);
                } catch (e) {
                    skipped.push({ url: item.url, reason: 'thumb_failed', message: e?.message || String(e) });
                    continue;
                }
                if (totalBytes + thumb.bytes > totalInlineLimit) {
                    skipped.push({ url: item.url, reason: 'thumb_budget_exceeded', bytes: thumb.bytes });
                    continue;
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
        }

        // The caller can't see where it landed. A 404 or a wiki's generic shell
        // still yields a pageful of chrome images, and the desktop side has been
        // reporting those as "official artwork" because nothing in the result
        // said which page they came from. The title is the cheapest tell:
        // 「达妮娅 - 中文Minecraft Wiki镜像」 and 「bilibili游戏中心 - WIKI」 both
        // announce the mistake outright.
        let pageTitle = '';
        try {
            pageTitle = await session.evaluateFn(() => document.title || '');
        } catch (_) { /* title is a nicety — never fail the extraction over it */ }

        return {
            items,
            skipped,
            total: items.length,
            candidate_count: filtered.length,
            final_url: finalUrl,
            page_title: pageTitle,
            inline_bytes: totalBytes,
        };
    }, { keepTab: false, active: false });
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
