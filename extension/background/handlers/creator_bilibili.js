/*
 * B站 创作中心 stats fetch handler.
 *
 * Strategy is platform-agnostic — see ../creator_common.js. This module
 * only owns:
 *   - the dashboard URL (member.bilibili.com/platform/home)
 *   - the bilibili.com URL filter
 *   - AUTH detection (passport redirect, B站 code:-101 / -111)
 *   - account_uid extraction (from /x/web-interface/nav body)
 *
 * Returns:
 *   { platform: 'bilibili', account_uid, captured_at, final_url,
 *     endpoint_count, raw: { [url]: { status, mime, body } } }
 *
 * The Phase 2 normalizer (core/dashboard/normalizer.py::BilibiliNormalizer)
 * downstream knows which endpoint paths carry which metrics; see the M2
 * test fixtures for the canonical mapping.
 */
import { captureDashboardXhrs } from './creator_common.js';

// Bilibili creator-center sub-pages. The home page only renders summary
// numbers; time-series trend data lives under /platform/data/*. Probe
// builds with --page <name> select the route; production fetch defaults
// to 'home' until we confirm which sub-page is worth pulling regularly.
const DASHBOARD_ROUTES = {
    'home':         'https://member.bilibili.com/platform/home',
    // Real B站 data-analytics paths (confirmed via search May 2026):
    'data-video':   'https://member.bilibili.com/platform/data-up/video/',
    'data-fans':    'https://member.bilibili.com/platform/data-up/fan/',
    'data-overview':'https://member.bilibili.com/platform/data-up/overview/',
    'data-source':  'https://member.bilibili.com/platform/data-up/source/',
};
const URL_INCLUDE = /^https?:\/\/[^/]*\.?bilibili\.com\//;
const PASSPORT_RE = /passport\.bilibili\.com\/login/;

function classifyBilibiliResponse(parsed, _url) {
    if (parsed && (parsed.code === -101 || parsed.code === -111)) {
        const err = new Error('AUTH_REQUIRED: bilibili session expired');
        err.code = 'AUTH_REQUIRED';
        throw err;
    }
}

function classifyBilibiliFinalUrl(finalUrl) {
    if (PASSPORT_RE.test(finalUrl)) {
        const err = new Error('AUTH_REQUIRED: bilibili login required');
        err.code = 'AUTH_REQUIRED';
        err.data = { final_url: finalUrl };
        throw err;
    }
}

function extractBilibiliUid(captured) {
    for (const [url, entry] of Object.entries(captured)) {
        if (!/\/x\/web-interface\/nav/.test(url)) continue;
        try {
            const j = JSON.parse(entry.body);
            const mid = j?.data?.mid;
            if (mid) return String(mid);
        } catch (_) { /* noop */ }
    }
    return '';
}

// Map a sub-route key to the SPA path we click into. Direct top-level
// navigation to /platform/data-up/* is intercepted by B站's Vue Router
// and redirected back to /platform/home, so we always start at /home
// and then click a sidebar anchor into the sub-route.
const SUBROUTE_PATH_HINTS = {
    'data-video': '/platform/data-up/video',
    'data-fans':  '/platform/data-up/fan',
    'data-source':'/platform/data-up/source',
};

// Production default route sequence: home (summary KPI + income) →
// data-video (the data-up subtree, which carries v3/fans/stat/graph
// — the real 7-day time-series we want). Single fetch yields full
// dataset; ~17s total observed.
const DEFAULT_ROUTE_SEQUENCE = ['home', 'data-video'];

export async function fetchBilibiliStats(payload) {
    const pageArg = payload && payload.page ? String(payload.page) : '';

    // Probe debug mode: list sidebar anchors so we can see real hrefs.
    if (pageArg === 'debug-anchors') {
        return await fetchBilibiliDebugAnchors();
    }

    // Single-route mode (probe/manual). Default → multi-route prod flow.
    const routes = pageArg ? [pageArg] : DEFAULT_ROUTE_SEQUENCE;
    return await fetchBilibiliMultiRoute(routes);
}

async function fetchBilibiliMultiRoute(routes) {
    const mergedRaw = {};
    let lastFinalUrl = '';
    const pagesVisited = [];

    for (const routeKey of routes) {
        const subroutePath = SUBROUTE_PATH_HINTS[routeKey] || '';
        const opts = {
            dashboardUrl: DASHBOARD_ROUTES.home,  // SPA forces redirect, always start at /home
            urlIncludeRegex: URL_INCLUDE,
            classifyResponse: classifyBilibiliResponse,
            classifyFinalUrl: classifyBilibiliFinalUrl,
        };
        if (subroutePath) {
            opts.afterInitialIdle = async (session) => {
                await session.evaluateFn((needle) => {
                    const anchors = document.querySelectorAll('a[href]');
                    for (const a of anchors) {
                        const href = a.getAttribute('href') || '';
                        if (href.indexOf(needle) === 0 || href.endsWith(needle)
                            || href.indexOf(needle + '/') >= 0) {
                            a.setAttribute('data-wisp-cta', '1');
                            a.click();
                            return { clicked: true, href };
                        }
                    }
                    return { clicked: false };
                }, [subroutePath]);
            };
        }
        const { captured, finalUrl } = await captureDashboardXhrs(opts);
        // Later routes overwrite earlier captures for the same URL (the
        // data-up page may refresh some home endpoints with more data).
        for (const [url, entry] of Object.entries(captured)) {
            mergedRaw[url] = entry;
        }
        lastFinalUrl = finalUrl;
        pagesVisited.push(routeKey);
    }

    return {
        platform: 'bilibili',
        account_uid: extractBilibiliUid(mergedRaw),
        captured_at: new Date().toISOString(),
        final_url: lastFinalUrl,
        endpoint_count: Object.keys(mergedRaw).length,
        raw: mergedRaw,
        pages_visited: pagesVisited,
    };
}

async function fetchBilibiliDebugAnchors() {
    let debugAnchors = null;
    const { captured, finalUrl } = await captureDashboardXhrs({
        dashboardUrl: DASHBOARD_ROUTES.home,
        urlIncludeRegex: URL_INCLUDE,
        classifyResponse: classifyBilibiliResponse,
        classifyFinalUrl: classifyBilibiliFinalUrl,
        afterInitialIdle: async (session) => {
            debugAnchors = await session.evaluateFn(() => {
                const out = [];
                const anchors = document.querySelectorAll('a[href]');
                for (const a of anchors) {
                    const href = a.getAttribute('href') || '';
                    if (!href || href.startsWith('javascript:')) continue;
                    out.push({
                        href,
                        text: (a.innerText || a.textContent || '').trim().slice(0, 40),
                    });
                    if (out.length > 60) break;
                }
                return { anchor_count: anchors.length, sample: out };
            }, []);
        },
    });
    return {
        platform: 'bilibili',
        account_uid: extractBilibiliUid(captured),
        captured_at: new Date().toISOString(),
        final_url: finalUrl,
        endpoint_count: Object.keys(captured).length,
        raw: captured,
        page: 'debug-anchors',
        debug_anchors: debugAnchors,
    };
}
