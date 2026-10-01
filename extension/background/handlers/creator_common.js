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

// Infinite-scroll lists only fetch page 2+ when the user scrolls near the
// bottom (米画师 InfiniteScrollLoader: distance 600px, element-ui
// v-infinite-scroll on the nearest scrollable ancestor, measured
// 2026-09-22). One round = scroll every scroll container to its end,
// give the page's throttled scroll handler time to START a request (a
// background tab's timers run at 1 Hz, so this is generous), then let
// the responses settle. A scroll that provokes no request means the list
// is exhausted (page >= pageCount disables the directive) or was never
// paginated. The round cap and time budget keep a runaway feed from
// eating the whole sweep.
const DEFAULT_PAGINATE_ROUNDS = 60;
const DEFAULT_PAGINATE_TRIGGER_MS = 2500;
const DEFAULT_PAGINATE_IDLE_MS = 1200;
const DEFAULT_PAGINATE_BUDGET_MS = 60000;

const SCROLL_TO_END_EXPRESSION = `(() => {
    const targets = [document.scrollingElement || document.documentElement];
    for (const el of document.querySelectorAll('*')) {
        const style = getComputedStyle(el);
        if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1) targets.push(el);
    }
    for (const el of targets) el.scrollTop = el.scrollHeight;
    window.scrollTo(0, document.documentElement.scrollHeight);
    return targets.length;
})()`;

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
 * @param {string}   [opts.preScript]  JS injected into every new document
 *     BEFORE the page's own scripts run (Page.addScriptToEvaluateOnNewDocument).
 *     Needed when a SPA reads its initial state (tab filters, etc.) from
 *     localStorage during component init — by the time we could evaluate
 *     into a loaded page, the XHRs we wanted to influence already fired.
 *     Implies a blank-first tab so the registration beats the navigation.
 * @param {boolean}  [opts.blankFirst]  open about:blank, attach, enable the
 *     Network domain, THEN navigate. Without it the tab is created on the
 *     target URL and Network.enable races the page: a warm SPA (bundle
 *     cached, second view of a sweep) fires and finishes its list XHRs
 *     before we are listening, and the capture comes back empty
 *     (measured 2026-09-10 on mihuashi: views 2-4 of a sweep captured 0
 *     endpoints every time, view 1 only sometimes).
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
        preScript,
        blankFirst = false,
        paginate = false,
    } = opts;
    const deferNavigation = blankFirst || !!preScript;

    return await withCdpTab(dashboardUrl, async (session, _tab) => {
        await session.send('Network.enable');
        if (preScript) {
            await session.send('Page.enable');
            await session.send('Page.addScriptToEvaluateOnNewDocument', { source: preScript });
        }
        if (deferNavigation) {
            await session.send('Page.navigate', { url: dashboardUrl });
        }

        const captured = {};
        const pendingBodies = new Map();
        const pendingRequests = new Set();
        const bodyFetches = [];
        let lastResponseAt = Date.now();
        let earlyError = null;
        let requestCount = 0;
        let finishedCount = 0;
        let extraPages = 0;

        const onEvent = (src, method, params) => {
            if (src.tabId !== session.tabId) return;

            if (method === 'Network.requestWillBeSent') {
                const url = (params.request && params.request.url) || '';
                if (urlIncludeRegex.test(url)) {
                    requestCount += 1;
                    pendingRequests.add(params.requestId);
                }
                return;
            }

            if (method === 'Network.loadingFailed') {
                if (pendingRequests.delete(params.requestId)) lastResponseAt = Date.now();
                pendingBodies.delete(params.requestId);
                return;
            }

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
                if (pendingRequests.delete(params.requestId)) lastResponseAt = Date.now();
                const meta = pendingBodies.get(params.requestId);
                if (!meta) return;
                pendingBodies.delete(params.requestId);
                lastResponseAt = Date.now();
                finishedCount += 1;

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

        const waitIdle = async (quietMs = idleMs) => {
            const start = Date.now();
            while (Date.now() - start < hardTimeoutMs) {
                if (earlyError) break;
                if (pendingRequests.size === 0 && Date.now() - lastResponseAt > quietMs) break;
                await sleep(250);
            }
        };

        // Returns how many extra pages the scrolling provoked.
        const scrollThroughPages = async () => {
            const cfg = paginate && typeof paginate === 'object' ? paginate : {};
            const maxRounds = cfg.maxRounds || DEFAULT_PAGINATE_ROUNDS;
            const triggerMs = cfg.triggerMs || DEFAULT_PAGINATE_TRIGGER_MS;
            const quietMs = cfg.idleMs || DEFAULT_PAGINATE_IDLE_MS;
            const deadline = Date.now() + (cfg.budgetMs || DEFAULT_PAGINATE_BUDGET_MS);
            let rounds = 0;
            while (rounds < maxRounds && Date.now() < deadline && !earlyError) {
                const requestsBefore = requestCount;
                const finishedBefore = finishedCount;
                try {
                    await session.send('Runtime.evaluate', {
                        expression: SCROLL_TO_END_EXPRESSION,
                        returnByValue: true,
                    });
                } catch (e) {
                    console.warn('[creator_common] scroll-to-end failed:', e && e.message);
                    break;
                }
                const scrolledAt = Date.now();
                while (Date.now() - scrolledAt < triggerMs && requestCount === requestsBefore && !earlyError) {
                    await sleep(100);
                }
                if (requestCount === requestsBefore) break;
                lastResponseAt = Date.now();
                await waitIdle(quietMs);
                if (finishedCount === finishedBefore) break;
                rounds += 1;
            }
            return rounds;
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
            if (paginate && !earlyError) {
                extraPages = await scrollThroughPages();
            }
            await Promise.allSettled(bodyFetches);
        } finally {
            try { chrome.debugger.onEvent.removeListener(onEvent); } catch (_) { /* noop */ }
        }

        if (earlyError) throw earlyError;

        const finalUrl = await session.getUrl();
        if (classifyFinalUrl) classifyFinalUrl(finalUrl);

        return { captured, finalUrl, pages: 1 + extraPages };
    }, { blankFirst: deferNavigation });
}
