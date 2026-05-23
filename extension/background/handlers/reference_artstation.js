/*
 * ArtStation reference search — GET API with pro_first ranking.
 *
 * History:
 *   - cf65baf (2026-05-XX): DOM scrape via CDP tab
 *   - b1106f9: drop CDP, switch to SW direct fetch
 *   - b795b80: switch to /api/v2/search/projects.json (was tag-popular feed)
 *   - 1a80842 (2026-05-22): switched to POST + CSRF + pro_first ranking
 *   - 2026-05-23: rolled back to GET. POST path died because
 *       1. artstation.com/ homepage now returns 403 (CF Bot Fight Mode),
 *          breaking the CSRF meta fetch that POST required
 *       2. Even with a hardcoded sentinel CSRF token, the SW POST gets
 *          412 from ArtStation — likely due to cross-origin Origin/
 *          Referer headers automatically attached by the browser to
 *          extension-side fetch (curl works because it sends neither).
 *          MV3 forbids modifying Origin from JS; the only fix would be
 *          declarativeNetRequest rules, adding deploy surface for no
 *          gain.
 *   The GET endpoint accepts `pro_first=1` as a query param and ranks
 *   identically to the POST form. Verified 2026-05-23: GET with
 *   pro_first=1 puts ramens "Techwear Girl" at #0, same as POST.
 *
 * Field shape (GET response, verified 2026-05-23):
 *   data: [{
 *     id, hash_id, slug, title,
 *     smaller_square_cover_url,           // flat, not nested under cover
 *     url, permalink,
 *     user: { username, full_name, pro_member, ... }
 *   }, ...]
 */

const SEARCH_API_URL = 'https://www.artstation.com/api/v2/search/projects.json';

const DEFAULT_MAX_ITEMS = 40;
const FETCH_TIMEOUT_MS = 15_000;

function _upgradeThumb(url) {
    if (!url) return '';
    return url.replace(
        /\/(micro_square|smaller_square|small_square|small|medium_square|medium)\//,
        '/large/'
    );
}

async function _searchGet(query, maxItems) {
    const params = new URLSearchParams({
        query,
        page: '1',
        per_page: String(maxItems),
        sorting: 'relevance',
        pro_first: '1',
    });
    const url = `${SEARCH_API_URL}?${params.toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        return await fetch(url, {
            method: 'GET',
            credentials: 'omit',
            headers: { 'Accept': 'application/json' },
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
}

export async function fetchArtstationReferences(payload) {
    const query = String(payload?.query || '').trim();
    if (!query) {
        const err = new Error('INVALID_PAYLOAD: query is required');
        err.code = 'INVALID_PAYLOAD';
        throw err;
    }
    const maxItems = Math.min(200, Math.max(8,
        parseInt(payload?.max_items, 10) || DEFAULT_MAX_ITEMS));

    let resp;
    try {
        resp = await _searchGet(query, maxItems);
    } catch (e) {
        if (e?.name === 'AbortError') {
            const err = new Error(`TIMEOUT: search timed out after ${FETCH_TIMEOUT_MS}ms`);
            err.code = 'TIMEOUT';
            throw err;
        }
        const err = new Error(`NETWORK_ERROR: ${e?.message || e}`);
        err.code = 'NETWORK_ERROR';
        throw err;
    }

    if (resp.status === 401 || resp.status === 403) {
        const err = new Error(`AUTH_REQUIRED: ArtStation ${resp.status}`);
        err.code = 'AUTH_REQUIRED';
        err.data = { status: resp.status };
        throw err;
    }
    if (!resp.ok) {
        const err = new Error(`NETWORK_ERROR: HTTP ${resp.status}`);
        err.code = 'NETWORK_ERROR';
        err.data = { status: resp.status };
        throw err;
    }

    let json;
    try {
        json = await resp.json();
    } catch (e) {
        const err = new Error(`NETWORK_ERROR: response not JSON (${e?.message || e})`);
        err.code = 'NETWORK_ERROR';
        throw err;
    }

    const data = Array.isArray(json?.data) ? json.data : [];
    const items = data.slice(0, maxItems).map((p) => {
        const thumbUrl = _upgradeThumb(p.smaller_square_cover_url || '');
        return {
            thumb_url: thumbUrl,
            page_url: p.url
                || p.permalink
                || (p.hash_id ? `https://www.artstation.com/artwork/${p.hash_id}` : ''),
            alt: p.title || '',
            artist: p.user?.username || p.user?.full_name || '',
            width: 0,
            height: 0,
        };
    }).filter((it) => it.thumb_url);

    return {
        items,
        total: json?.total_count ?? items.length,
        final_url: SEARCH_API_URL,
        query,
    };
}
