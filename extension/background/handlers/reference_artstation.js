/*
 * ArtStation reference search — direct SW-side fetch.
 *
 * Why no CDP tab: the Wisp extension's manifest already has
 * `*://*.artstation.com/*` in host_permissions, so the service worker
 * can fetch ArtStation's public JSON API (`/projects?keywords=X`)
 * directly with the user's cookies (credentials: 'include'). No tab
 * to open, no DOM scrape, no page-context flakiness.
 *
 * Field shape verified live 2026-05-21 via system.eval probe on
 * artstation.com homepage:
 *   data: [{
 *     id, hash_id, slug, title, description, permalink,
 *     likes_count, views_count, tag_list,
 *     cover: { thumb_url, small_square_url, micro_square_image_url },
 *     user: { username, full_name },
 *   }, ...]
 * cover.thumb_url is the /smaller_square/ variant; path-replacing to
 * /large/ gives ~1200px JPEG (HEAD 200 image/jpeg confirmed).
 */

// Use the REAL search API (verified via system.eval 2026-05-21).
// /projects?keywords= turned out to be a tag-popular feed that
// ignores the keyword param semantically — it returns recently-
// popular projects regardless of query. The frontend's actual search
// uses /api/v2/search/projects.json?query=X&page=N&per_page=M, which
// does proper relevance ranking.
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

export async function fetchArtstationReferences(payload) {
    const query = String(payload?.query || '').trim();
    if (!query) {
        const err = new Error('INVALID_PAYLOAD: query is required');
        err.code = 'INVALID_PAYLOAD';
        throw err;
    }
    const maxItems = Math.min(200, Math.max(8,
        parseInt(payload?.max_items, 10) || DEFAULT_MAX_ITEMS));

    const url = `${SEARCH_API_URL}?query=${encodeURIComponent(query)}&page=1&per_page=${maxItems}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let resp;
    try {
        resp = await fetch(url, {
            credentials: 'include',
            headers: { 'Accept': 'application/json' },
            signal: controller.signal,
        });
    } catch (e) {
        clearTimeout(timer);
        if (e?.name === 'AbortError') {
            const err = new Error(`TIMEOUT: fetch ${url} timed out after ${FETCH_TIMEOUT_MS}ms`);
            err.code = 'TIMEOUT';
            throw err;
        }
        const err = new Error(`NETWORK_ERROR: ${e?.message || e}`);
        err.code = 'NETWORK_ERROR';
        throw err;
    }
    clearTimeout(timer);

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
    // /api/v2/search/projects shape: each project has a flat
    // `smaller_square_cover_url` field, not the nested `cover` object the
    // /projects?keywords= feed used. Path-upgrade still works.
    const items = data.slice(0, maxItems).map((p) => {
        const thumbUrl = _upgradeThumb(p.smaller_square_cover_url || '');
        return {
            thumb_url: thumbUrl,
            page_url: p.url
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
        final_url: url,
        query,
    };
}
