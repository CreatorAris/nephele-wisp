/*
 * Shared dashboard-capture primitive for creator.fetch_stats handlers.
 *
 * Every supported platform follows the same shape: open the platform's
 * own creator-center page in a background tab, let the page render its
 * own XHRs, observe via CDP Network domain, and pull each response
 * body the moment loadingFinished fires.
 *
 * Platform-specific bits — dashboard URL, URL filter regex, AUTH /
 * CAPTCHA detection — are passed in by the platform's handler module.
 * The capture loop itself never knows which platform it's looking at.
 *
 * Body GC contract: getResponseBody is only reliable in a narrow
 * window after loadingFinished, so we fire it INSIDE the event
 * callback (returns a promise we accumulate in bodyFetches) instead
 * of after the wait loop. Draining bodyFetches at the end ensures all
 * settled responses are in `captured` before we return.
 */
import { sleep } from '../humanize.js';
import { withCdpTab } from '../cdp.js';

const DEFAULT_IDLE_MS = 2500;
const DEFAULT_HARD_TIMEOUT_MS = 30000;

/**
 * Open `dashboardUrl` in a background tab, capture JSON XHR bodies
 * that match `urlIncludeRegex`, return when the XHR storm settles.
 *
 * `afterInitialIdle` opt: after the first XHR storm settles, the
 * callback is invoked with the session. Use it to trigger SPA
 * in-page navigation (e.g. evaluateFn that clicks a sidebar `<a>`),
 * then capture continues for another idle window. This is the pattern
 * required when direct navigation to a sub-route is intercepted and
 * redirected back to home by the SPA router (B站 creator-center does
 * this for /platform/data-up/* paths).
 *
 * @param {Object} opts
 * @param {string} opts.dashboardUrl
 * @param {RegExp} opts.urlIncludeRegex
 * @param {RegExp} [opts.noiseMimeRegex]
 * @param {number} [opts.idleMs]            settle window since last response (default 2500)
 * @param {number} [opts.hardTimeoutMs]     hard cap on the WHOLE flow (default 30000)
 * @param {Function} [opts.classifyResponse]
 * @param {Function} [opts.classifyFinalUrl]
 * @param {Function} [opts.afterInitialIdle] async (session) => void
 * @returns {Promise<{captured: Object, finalUrl: string}>}
 */
export async function captureDashboardXhrs(opts) {
    const {
        dashboardUrl,
        urlIncludeRegex,
        noiseMimeRegex = /^(image\/|font\/|text\/css|application\/javascript|application\/x-javascript|application\/wasm|video\/|audio\/)/,
        idleMs = DEFAULT_IDLE_MS,
        hardTimeoutMs = DEFAULT_HARD_TIMEOUT_MS,
        classifyResponse,
        classifyFinalUrl,
        afterInitialIdle,
    } = opts;

    return await withCdpTab(dashboardUrl, async (session, _tab) => {
        await session.send('Network.enable');

        const captured = {};
        const pendingBodies = new Map();
        const bodyFetches = [];
        let lastResponseAt = Date.now();
        let earlyError = null;

        const onEvent = (src, method, params) => {
            if (src.tabId !== session.tabId) return;

            if (method === 'Network.responseReceived') {
                const resp = params.response || {};
                const url = resp.url || '';
                const mime = resp.mimeType || '';
                if (!urlIncludeRegex.test(url)) return;
                if (noiseMimeRegex.test(mime) && resp.status >= 200 && resp.status < 300) return;
                pendingBodies.set(params.requestId, { url, status: resp.status, mime });
                return;
            }

            if (method === 'Network.loadingFinished') {
                const meta = pendingBodies.get(params.requestId);
                if (!meta) return;
                pendingBodies.delete(params.requestId);
                lastResponseAt = Date.now();

                const p = session.send('Network.getResponseBody', {
                    requestId: params.requestId,
                }).then((res) => {
                    const body = res.body || '';
                    if (!body) return;
                    const trimmed = body.trimStart();
                    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return;
                    captured[meta.url] = {
                        status: meta.status,
                        mime: meta.mime,
                        body,
                        base64: res.base64Encoded || false,
                    };
                    if (classifyResponse) {
                        try {
                            const parsed = JSON.parse(body);
                            classifyResponse(parsed, meta.url);
                        } catch (e) {
                            if (e && e.code) earlyError = e;
                        }
                    }
                }).catch(() => { /* body gone — tolerate */ });
                bodyFetches.push(p);
            }
        };

        const waitIdle = async () => {
            const start = Date.now();
            while (Date.now() - start < hardTimeoutMs) {
                if (earlyError) break;
                if (Date.now() - lastResponseAt > idleMs) break;
                await sleep(250);
            }
        };

        chrome.debugger.onEvent.addListener(onEvent);
        try {
            await waitIdle();
            if (afterInitialIdle && !earlyError) {
                try {
                    await afterInitialIdle(session);
                } catch (e) {
                    if (e && e.code) {
                        earlyError = e;
                    } else {
                        // Non-fatal — log but continue capturing whatever we got.
                        console.warn('[creator_common] afterInitialIdle threw:', e && e.message);
                    }
                }
                if (!earlyError) {
                    // Reset idle clock so the second wave gets its own window.
                    lastResponseAt = Date.now();
                    await waitIdle();
                }
            }
            await Promise.allSettled(bodyFetches);
        } finally {
            try { chrome.debugger.onEvent.removeListener(onEvent); } catch (_) { /* noop */ }
        }

        if (earlyError) throw earlyError;

        const finalUrl = await session.getUrl();
        if (classifyFinalUrl) classifyFinalUrl(finalUrl);

        return { captured, finalUrl };
    });
}
