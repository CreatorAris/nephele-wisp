/*
 * browser.read_page — general authenticated page read.
 *
 * Opens an arbitrary URL in an ephemeral background tab inside the user's
 * REAL browser session (so login-walled / anti-bot pages render normally),
 * scrolls to trigger lazy content, then extracts a normalized snapshot of
 * the page: readable text, links, optional images, optional CSS-selector
 * structured rows, and meta tags. Read-only — no clicks, no form fills, no
 * navigation beyond the requested URL.
 *
 * The returned shape MUST stay in sync with the desktop canonical extractor
 * (nephele core/browser/page_reader.py CANONICAL_READ_JS) — the desktop
 * persistent/headless fallback tiers run that script and the page_reader
 * cascade assumes one shape across all tiers. The contract is documented in
 * docs/PROTOCOL.md → browser.*.
 *
 * Native Messaging frames cap at 1 MB. Per-field caps plus a final
 * serialized-size guard in the extractor keep a single read under that
 * budget even with include_html + many selectors (see __wispExtractPage).
 */
import { withCdpTab } from '../cdp.js';
import { sleep, preActionDelay } from '../humanize.js';

const DEFAULT_MAX_CHARS = 6000;
const DEFAULT_MAX_LINKS = 60;
const DEFAULT_MAX_IMAGES = 0;
const DEFAULT_SCROLL_ROUNDS = 2;
const DEFAULT_NAV_TIMEOUT_MS = 30_000;

const HARD_MAX_CHARS = 20_000;
const HARD_MAX_LINKS = 200;
const HARD_MAX_IMAGES = 120;
const HARD_SCROLL_ROUNDS = 8;

function clampInt(v, lo, hi, dflt) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
}

// Self-contained in-page extractor. Serialized via session.evaluateFn and
// run in the page's own context — it MUST NOT reference any outer scope.
// Mirror of desktop CANONICAL_READ_JS; keep both in lockstep.
function __wispExtractPage(opts) {
    opts = opts || {};
    const maxChars = opts.maxChars || 6000;
    const maxLinks = opts.maxLinks || 60;
    const maxImages = opts.maxImages || 0;
    const selectors = Array.isArray(opts.selectors) ? opts.selectors : [];
    const includeHtml = !!opts.includeHtml;

    const abs = (u) => { try { return new URL(u, location.href).href; } catch (_) { return ''; } };
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

    let text = '';
    try {
        const root = document.querySelector('main')
            || document.querySelector('article')
            || document.querySelector('[role="main"]')
            || document.body;
        if (root) text = root.innerText || root.textContent || '';
    } catch (_) { text = ''; }
    text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const fullLen = text.length;
    const truncated = fullLen > maxChars;
    if (truncated) text = text.slice(0, maxChars);
    const wordCount = text ? (text.split(/\s+/).filter(Boolean).length) : 0;

    const links = [];
    const seenHref = new Set();
    try {
        for (const a of Array.from(document.querySelectorAll('a[href]'))) {
            if (links.length >= maxLinks) break;
            const href = abs(a.getAttribute('href'));
            if (!href || !/^https?:/i.test(href)) continue;
            if (seenHref.has(href)) continue;
            seenHref.add(href);
            links.push({ href, text: clean(a.innerText || a.textContent).slice(0, 160) });
        }
    } catch (_) {}

    const images = [];
    if (maxImages > 0) {
        try {
            const bestSrcset = (ss) => {
                if (!ss) return '';
                const parts = String(ss).split(',').map((p) => {
                    const b = p.trim().split(/\s+/);
                    return { u: b[0] || '', s: parseInt((b[1] || '').replace(/[^\d]/g, ''), 10) || 0 };
                }).filter((x) => x.u);
                parts.sort((a, b) => b.s - a.s);
                return parts[0] ? parts[0].u : '';
            };
            const seenImg = new Set();
            for (const img of Array.from(document.images || [])) {
                if (images.length >= maxImages) break;
                const src = abs(img.currentSrc || bestSrcset(img.srcset) || img.src || '');
                if (!src || seenImg.has(src)) continue;
                seenImg.add(src);
                images.push({
                    src,
                    alt: clean(img.alt || img.title).slice(0, 160),
                    w: img.naturalWidth || 0,
                    h: img.naturalHeight || 0,
                });
            }
        } catch (_) {}
    }

    const structured = {};
    for (const sel of selectors) {
        const rows = [];
        try {
            const nodes = document.querySelectorAll(sel);
            for (const node of Array.from(nodes)) {
                if (rows.length >= 50) break;
                const row = { text: clean(node.innerText || node.textContent).slice(0, 400) };
                const href = node.getAttribute && node.getAttribute('href');
                if (href) row.href = abs(href).slice(0, 500);
                const src = node.getAttribute && (node.getAttribute('src') || node.getAttribute('data-src'));
                if (src) row.src = abs(src).slice(0, 500);
                rows.push(row);
            }
        } catch (_) {}
        structured[sel] = rows;
    }

    const meta = {};
    try {
        const pick = (q, key) => {
            const el = document.querySelector(q);
            if (el) { const v = clean(el.getAttribute('content')); if (v) meta[key] = v.slice(0, 300); }
        };
        pick('meta[name="description"]', 'description');
        pick('meta[name="keywords"]', 'keywords');
        pick('meta[name="author"]', 'author');
        pick('meta[property="og:title"]', 'og:title');
        pick('meta[property="og:description"]', 'og:description');
        pick('meta[property="og:site_name"]', 'og:site_name');
        pick('meta[property="og:image"]', 'og:image');
    } catch (_) {}

    let loginRequired = false;
    try {
        const pw = document.querySelector('input[type="password"]');
        if (pw) {
            const r = pw.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && fullLen < 600) loginRequired = true;
        }
    } catch (_) {}

    const out = {
        final_url: location.href,
        title: document.title || '',
        text,
        text_truncated: truncated,
        full_text_length: fullLen,
        word_count: wordCount,
        links,
        links_count: links.length,
        images,
        structured,
        meta,
        login_required: loginRequired,
    };
    if (includeHtml) {
        try { out.html = (document.documentElement.outerHTML || '').slice(0, 200000); } catch (_) { out.html = ''; }
    }
    // Frame-budget guard. The Wisp tier ships this object back over Native
    // Messaging, which silently drops frames > 1 MB (a drop stalls the RPC
    // for the full timeout before falling through). Per-field caps don't
    // bound the SUM, so if the serialized object would blow the budget, trim
    // the largest fields: drop html, then shrink structured/links/images,
    // then truncate text. login_required/title/url are always preserved.
    try {
        let s = JSON.stringify(out);
        if (s.length > 760000) {
            if (out.html) { delete out.html; out.html_dropped = true; s = JSON.stringify(out); }
            if (s.length > 760000) {
                for (const k in out.structured) out.structured[k] = (out.structured[k] || []).slice(0, 15);
                out.links = (out.links || []).slice(0, 80);
                out.links_count = out.links.length;
                out.images = (out.images || []).slice(0, 40);
                out.oversize_trimmed = true;
                s = JSON.stringify(out);
            }
            if (s.length > 760000 && out.text) { out.text = out.text.slice(0, 8000); out.oversize_trimmed = true; }
        }
    } catch (_) {}
    return out;
}

export async function readPage(payload) {
    const url = String(payload?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
        const err = new Error('INVALID_PAYLOAD: url must start with http(s)');
        err.code = 'INVALID_PAYLOAD';
        throw err;
    }

    const navTimeout = clampInt(payload?.nav_timeout_ms, 3000, 60_000, DEFAULT_NAV_TIMEOUT_MS);
    const scrollRounds = clampInt(payload?.scroll_rounds, 0, HARD_SCROLL_ROUNDS, DEFAULT_SCROLL_ROUNDS);
    const extractOpts = {
        maxChars: clampInt(payload?.max_chars, 200, HARD_MAX_CHARS, DEFAULT_MAX_CHARS),
        maxLinks: clampInt(payload?.max_links, 0, HARD_MAX_LINKS, DEFAULT_MAX_LINKS),
        maxImages: clampInt(payload?.max_images, 0, HARD_MAX_IMAGES, DEFAULT_MAX_IMAGES),
        selectors: Array.isArray(payload?.selectors)
            ? payload.selectors.filter((s) => typeof s === 'string' && s.trim()).slice(0, 12)
            : [],
        includeHtml: !!payload?.include_html,
    };

    return await withCdpTab(url, async (session) => {
        try {
            await session.navigate(url, { timeoutMs: navTimeout });
        } catch (e) {
            // Preserve the real cause. _waitForLoadEvent rejects with a
            // "TIMEOUT: ..." message (no .code); Page.navigate failures
            // (tab discarded, invalid URL, net error) are something else —
            // hard-coding TIMEOUT for all of them obscures triage.
            const msg = (e && e.message) || String(e);
            const isTimeout = /^TIMEOUT/i.test(msg);
            const err = new Error(isTimeout ? msg : `page navigation failed: ${msg}`);
            err.code = isTimeout ? 'TIMEOUT' : ((e && e.code) || 'INTERNAL');
            throw err;
        }

        for (let i = 0; i < scrollRounds; i++) {
            try {
                await session.evaluateFn(() => { window.scrollBy(0, window.innerHeight * 0.9); });
            } catch (_) { /* best-effort */ }
            await preActionDelay();
            await sleep(550 + Math.floor(Math.random() * 350));
        }

        const data = await session.evaluateFn(__wispExtractPage, [extractOpts]);
        return data || {};
    }, { keepTab: false, active: false });
}
