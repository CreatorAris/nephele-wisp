/*
 * X (Twitter) own-profile stats fetch handler.
 *
 * Unlike B站/Pixiv there is no separate creator-center: the public
 * profile page already carries every metric we surface (per-post
 * views / likes / reposts / replies / bookmarks via GraphQL). Two-pass
 * flow because the handle is unknown until we are on the profile:
 *
 *   1. Open /home, click the sidebar Profile link (SPA nav discovers
 *      the user's own handle) → UserByScreenName + UserTweets fire.
 *   2. Direct-navigate to /<handle>/media → UserMedia (the works grid).
 *      X's router allows direct sub-route navigation, so no click
 *      dance is needed on the second pass.
 *
 * URL filter is deliberately NARROW (three GraphQL ops), unlike the
 * wide B站/Pixiv filters: /home floods XHRs with other people's
 * timeline content we must not persist into the raw store.
 *
 * AUTH detection: logged-out x.com redirects to /i/flow/login, and the
 * Profile sidebar link only renders for authenticated sessions —
 * either signal throws AUTH_REQUIRED.
 *
 * Returns the same envelope as the other creator handlers:
 *   { platform: 'x', account_uid, captured_at, final_url,
 *     endpoint_count, raw: { [url]: { status, mime, body } } }
 */
import { captureDashboardXhrs } from './creator_common.js';

const HOME_URL = 'https://x.com/home';
const URL_INCLUDE = /\/i\/api\/graphql\/[^/]+\/(UserByScreenName|UserTweets|UserMedia)/;
const LOGIN_RE = /(x|twitter)\.com\/(i\/flow\/login|login)/;

function classifyXFinalUrl(finalUrl) {
    if (LOGIN_RE.test(finalUrl)) {
        const err = new Error('AUTH_REQUIRED: X login required');
        err.code = 'AUTH_REQUIRED';
        err.data = { final_url: finalUrl };
        throw err;
    }
}

function extractXUid(captured) {
    for (const [url, entry] of Object.entries(captured)) {
        if (!/UserByScreenName/.test(url)) continue;
        try {
            const j = JSON.parse(entry.body);
            const restId = j?.data?.user?.result?.rest_id;
            if (restId) return String(restId);
        } catch (_) { /* noop */ }
    }
    return '';
}

// The profile pass ends on x.com/<handle> — everything else on x.com
// ("home", "explore", reserved single-segment routes) never appears as
// the final URL of a successful Profile-link click.
function handleFromUrl(finalUrl) {
    const m = /^https?:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?:[/?#]|$)/.exec(finalUrl || '');
    if (!m) return '';
    const seg = m[1];
    if (/^(home|explore|notifications|messages|i|search|settings)$/.test(seg)) return '';
    return seg;
}

export async function fetchXStats(_payload) {
    // Pass 1: /home → click own Profile link → UserByScreenName + UserTweets.
    const { captured, finalUrl } = await captureDashboardXhrs({
        dashboardUrl: HOME_URL,
        urlIncludeRegex: URL_INCLUDE,
        classifyFinalUrl: classifyXFinalUrl,
        afterInitialIdle: async (session) => {
            const res = await session.evaluateFn(() => {
                const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
                if (!a) return { clicked: false };
                a.click();
                return { clicked: true, href: a.getAttribute('href') || '' };
            }, []);
            if (!res || !res.clicked) {
                const err = new Error('AUTH_REQUIRED: X profile link not found (logged out?)');
                err.code = 'AUTH_REQUIRED';
                throw err;
            }
        },
    });

    const mergedRaw = { ...captured };
    let lastFinalUrl = finalUrl;

    // Pass 2: works grid. Best-effort — account metrics from pass 1 are
    // already worth persisting even if the media pass fails.
    const handle = handleFromUrl(finalUrl);
    if (handle) {
        try {
            const media = await captureDashboardXhrs({
                dashboardUrl: `https://x.com/${handle}/media`,
                urlIncludeRegex: URL_INCLUDE,
                classifyFinalUrl: classifyXFinalUrl,
            });
            for (const [url, entry] of Object.entries(media.captured)) {
                mergedRaw[url] = entry;
            }
            lastFinalUrl = media.finalUrl;
        } catch (e) {
            // Pass 1 already proved the session is authenticated (Profile
            // link existed and clicked through), so even AUTH_REQUIRED here
            // is a soft wall on the second navigation — keep pass-1 data.
            console.warn('[creator_x] media pass failed (non-fatal):', e && e.message);
        }
    }

    return {
        platform: 'x',
        account_uid: extractXUid(mergedRaw),
        captured_at: new Date().toISOString(),
        final_url: lastFinalUrl,
        endpoint_count: Object.keys(mergedRaw).length,
        raw: mergedRaw,
    };
}
