/*
 * browser.capture — bounded CDP capture passthrough.
 *
 * The desktop drives WHAT to capture by naming a CDP method + params; the
 * extension is a thin, generic engine. This banks the screenshot / DOM-capture
 * capability once: new capture features (region, element, full-page, PDF, page
 * HTML) are just different params from the desktop — no extension re-submission.
 *
 * SAFETY: only a fixed whitelist of READ-ONLY capture methods is accepted —
 * never Runtime.evaluate / Input.* / Network.* / Fetch.* etc. The desktop
 * cannot run arbitrary code or mutate the page through this route (that would
 * be a remote-code surface + a Store-review rejection). Arbitrary eval stays in
 * the dev-only probe handler, which pack.py strips from the store build.
 *
 * payload: { url, method?, params?, scroll_rounds?, ingest_url? }
 *   method default Page.captureScreenshot. Binary results (screenshot/PDF) are
 *   streamed to ingest_url (HTTP, breaks the 1 MB NM frame) or returned inline
 *   when small; DOM results return inline (or ingest when large).
 * returns: { ok, ingested?, data_b64?, result?, bytes?, mime?, method, reason? }
 */
import { withCdpTab, isLocalIngestUrl } from '../cdp.js';
import { sleep, preActionDelay } from '../humanize.js';

const NAV_TIMEOUT_MS = 30_000;
const INLINE_CAP = 700_000;  // base64/text chars to stay under the 1 MB NM frame
const CAPTURE_WHITELIST = new Set([
    'Page.captureScreenshot',
    'Page.printToPDF',
    'DOM.getDocument',
    'DOM.getOuterHTML',
    'DOMSnapshot.captureSnapshot',
]);

function _b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

async function _ingest(ingestUrl, body, mime) {
    const post = await fetch(ingestUrl, { method: 'POST', body, headers: { 'Content-Type': mime } });
    return post.ok;
}

export async function capturePage(payload) {
    const url = String(payload?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
        const e = new Error('INVALID_PAYLOAD: url must start with http(s)');
        e.code = 'INVALID_PAYLOAD';
        throw e;
    }
    const method = String(payload?.method || 'Page.captureScreenshot');
    if (!CAPTURE_WHITELIST.has(method)) {
        const e = new Error(`INVALID_PAYLOAD: capture method not allowed: ${method}`);
        e.code = 'INVALID_PAYLOAD';
        throw e;
    }
    const params = payload?.params && typeof payload.params === 'object' ? payload.params : {};
    const ingestUrl = String(payload?.ingest_url || '');
    const hasIngest = isLocalIngestUrl(ingestUrl);
    const scrollRounds = Math.min(8, Math.max(0, parseInt(payload?.scroll_rounds, 10) || 0));

    return await withCdpTab(url, async (session) => {
        try {
            await session.navigate(url, { timeoutMs: NAV_TIMEOUT_MS });
        } catch (e) {
            const err = new Error(`TIMEOUT: page load failed (${e?.message || e})`);
            err.code = 'TIMEOUT';
            throw err;
        }

        // Pre-scroll to trigger lazy-loaded content (captureBeyondViewport alone
        // won't fire scroll-gated loaders), then return to top for the capture.
        for (let i = 0; i < scrollRounds; i++) {
            await session.evaluateFn(() => window.scrollBy(0, window.innerHeight * 0.9));
            await preActionDelay();
            await sleep(500 + Math.floor(Math.random() * 400));
        }
        if (scrollRounds > 0) {
            await session.evaluateFn(() => window.scrollTo(0, 0));
        }

        const result = await session.send(method, params);

        // Binary capture (screenshot / PDF): CDP returns base64 in `data`.
        if (typeof result?.data === 'string' && result.data) {
            const bytes = _b64ToBytes(result.data);
            const mime = method === 'Page.printToPDF' ? 'application/pdf' : 'image/png';
            if (hasIngest) {
                const ok = await _ingest(ingestUrl, bytes, mime);
                return { ok, ingested: ok, bytes: bytes.length, mime, method };
            }
            if (result.data.length <= INLINE_CAP) {
                return { ok: true, data_b64: result.data, mime, method };
            }
            return { ok: false, reason: 'too_large_needs_ingest', bytes: bytes.length, method };
        }

        // Structured/text capture (DOM): return inline when small, else ingest.
        const text = JSON.stringify(result ?? null);
        if (text.length <= INLINE_CAP) {
            return { ok: true, result, method };
        }
        if (hasIngest) {
            const ok = await _ingest(ingestUrl, text, 'application/json');
            return { ok, ingested: ok, bytes: text.length, method };
        }
        return { ok: false, reason: 'too_large_needs_ingest', bytes: text.length, method };
    }, { keepTab: false, active: false });
}
