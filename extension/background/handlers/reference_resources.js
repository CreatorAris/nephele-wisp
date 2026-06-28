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
import { withCdpTab } from '../cdp.js';
import { sleep, preActionDelay } from '../humanize.js';

const DEFAULT_SCROLL_ROUNDS = 3;
const DEFAULT_MAX_ITEMS = 24;
const DEFAULT_NAV_TIMEOUT_MS = 30_000;
const DEFAULT_TOTAL_INLINE_BYTES = 520_000;
const DEFAULT_PER_IMAGE_BYTES = 140_000;
const PER_IMAGE_FETCH_TIMEOUT_MS = 12_000;

function _arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
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
    const totalInlineLimit = Math.min(620_000, Math.max(80_000,
        parseInt(payload?.max_total_bytes, 10) || DEFAULT_TOTAL_INLINE_BYTES));
    const perImageLimit = Math.min(600_000, Math.max(20_000,
        parseInt(payload?.max_image_bytes, 10) || DEFAULT_PER_IMAGE_BYTES));

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
        const filtered = [];
        const seen = new Set();
        for (const item of candidates || []) {
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
                const ab = await resp.arrayBuffer();
                if (!ab.byteLength) {
                    skipped.push({ url: item.url, reason: 'empty' });
                    continue;
                }
                if (ab.byteLength > perImageLimit) {
                    skipped.push({ url: item.url, reason: 'too_large', bytes: ab.byteLength });
                    continue;
                }
                if (totalBytes + ab.byteLength > totalInlineLimit) {
                    skipped.push({ url: item.url, reason: 'response_budget_exceeded', bytes: ab.byteLength });
                    continue;
                }
                totalBytes += ab.byteLength;
                items.push({
                    ...item,
                    thumb_url: item.url,
                    image_b64: _arrayBufferToBase64(ab),
                    image_mime: resp.headers.get('content-type') || 'image/jpeg',
                    image_bytes: ab.byteLength,
                });
            } catch (e) {
                skipped.push({
                    url: item.url,
                    reason: e?.name === 'AbortError' ? 'timeout' : 'fetch_failed',
                    message: e?.message || String(e),
                });
            }
        }

        return {
            items,
            skipped,
            total: items.length,
            candidate_count: filtered.length,
            final_url: finalUrl,
            inline_bytes: totalBytes,
        };
    }, { keepTab: false, active: false });
}
