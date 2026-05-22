/*
 * ArtStation reference search — POST API matching the SPA.
 *
 * Why POST instead of GET on /api/v2/search/projects.json:
 *   The GET form works but ignores `pro_first`, which is the killer
 *   relevance booster — the website's /search?query=X view sends POST
 *   with body `{query, page, per_page, sorting:"relevance",
 *   pro_first:"1", filters:[], additional_fields:[]}` and ranks Pro
 *   members' work above hobby/student posts. Without pro_first our
 *   GET results led with amateur sketches (e.g. lizchief at #0 for
 *   "techwear") while the real screen led with finished Pro work
 *   (ramens "Techwear Girl"). Verified 2026-05-22 via system.eval
 *   intercept on a logged-in tab; SPA call site is in
 *   common_head_js bundle's httpClient.post(...).
 *
 * CSRF:
 *   ArtStation rejects POST without a `Public-Csrf-Token` header
 *   (412 Invalid CSRF Token). The token is published in
 *   `<meta name="public-csrf-token">` on any HTML page. We fetch
 *   https://www.artstation.com/ once, regex the meta, cache in
 *   module-scope for FETCH_CSRF_TTL_MS, retry once on 412.
 *
 * Field shape (POST response, verified 2026-05-22):
 *   data: [{
 *     id, hash_id, slug, title,
 *     smaller_square_cover_url,           // flat, not nested under cover
 *     url, permalink,
 *     user: { username, full_name, pro_member, ... }
 *   }, ...]
 */

const SEARCH_API_URL = 'https://www.artstation.com/api/v2/search/projects.json';
const CSRF_PAGE_URL = 'https://www.artstation.com/';
// Match the meta tag broadly first, then extract content separately, so
// attribute order swap (`content` before `name`) doesn't silently miss
// the token and look like a logged-out state.
const CSRF_META_TAG_RE = /<meta\b[^>]*name=["']public-csrf-token["'][^>]*>/i;
const CSRF_CONTENT_RE = /content=["']([^"']+)["']/i;

const DEFAULT_MAX_ITEMS = 40;
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_CSRF_TTL_MS = 10 * 60 * 1000; // 10 min

let _csrfCache = { token: null, fetchedAt: 0 };

function _upgradeThumb(url) {
    if (!url) return '';
    return url.replace(
        /\/(micro_square|smaller_square|small_square|small|medium_square|medium)\//,
        '/large/'
    );
}

async function _fetchCsrfToken({ force = false } = {}) {
    if (!force && _csrfCache.token
        && Date.now() - _csrfCache.fetchedAt < FETCH_CSRF_TTL_MS) {
        return _csrfCache.token;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const resp = await fetch(CSRF_PAGE_URL, {
            credentials: 'include',
            headers: { 'Accept': 'text/html' },
            signal: controller.signal,
        });
        if (resp.status === 401 || resp.status === 403) {
            const err = new Error(`AUTH_REQUIRED: ArtStation ${resp.status} on CSRF fetch`);
            err.code = 'AUTH_REQUIRED';
            err.data = { status: resp.status };
            throw err;
        }
        if (!resp.ok) {
            const err = new Error(`NETWORK_ERROR: CSRF fetch HTTP ${resp.status}`);
            err.code = 'NETWORK_ERROR';
            throw err;
        }
        const html = await resp.text();
        const tagMatch = html.match(CSRF_META_TAG_RE);
        const contentMatch = tagMatch && tagMatch[0].match(CSRF_CONTENT_RE);
        if (!contentMatch) {
            const err = new Error('AUTH_REQUIRED: no public-csrf-token meta found');
            err.code = 'AUTH_REQUIRED';
            throw err;
        }
        _csrfCache = { token: contentMatch[1], fetchedAt: Date.now() };
        return contentMatch[1];
    } finally {
        clearTimeout(timer);
    }
}

async function _searchPost(query, maxItems, csrfToken) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let resp;
    try {
        resp = await fetch(SEARCH_API_URL, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Public-Csrf-Token': csrfToken,
            },
            body: JSON.stringify({
                query,
                page: 1,
                per_page: maxItems,
                sorting: 'relevance',
                pro_first: '1',
                filters: [],
                additional_fields: [],
            }),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
    return resp;
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

    let csrfToken = await _fetchCsrfToken();

    let resp;
    try {
        resp = await _searchPost(query, maxItems, csrfToken);
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

    // 412 = CSRF expired/rotated. Refetch token once and retry.
    if (resp.status === 412) {
        csrfToken = await _fetchCsrfToken({ force: true });
        try {
            resp = await _searchPost(query, maxItems, csrfToken);
        } catch (e) {
            if (e?.name === 'AbortError') {
                const err = new Error(`TIMEOUT: retry timed out after ${FETCH_TIMEOUT_MS}ms`);
                err.code = 'TIMEOUT';
                throw err;
            }
            const err = new Error(`NETWORK_ERROR: retry failed (${e?.message || e})`);
            err.code = 'NETWORK_ERROR';
            throw err;
        }
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
