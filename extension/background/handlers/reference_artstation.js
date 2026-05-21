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

const PROJECTS_API_URL = 'https://www.artstation.com/projects?keywords=';
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

    const url = PROJECTS_API_URL + encodeURIComponent(query);
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
    const items = data.slice(0, maxItems).map((p) => {
        const cover = p.cover || {};
        const thumbUrl = _upgradeThumb(
            cover.thumb_url || cover.small_square_url || cover.micro_square_image_url || ''
        );
        return {
            thumb_url: thumbUrl,
            page_url: p.permalink
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
