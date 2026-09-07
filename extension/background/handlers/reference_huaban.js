import { extractPageResources } from './reference_resources.js';

export async function fetchHuabanReferences(payload) {
    const query = String(payload?.query || '').trim();
    if (!query) throw Object.assign(new Error('query required'), { code: 'INVALID_PAYLOAD' });
    const result = await extractPageResources({ ...payload,
        url: `https://huaban.com/search?q=${encodeURIComponent(query)}` });
    return { ...result, items: result.items.map(item => ({ ...item,
        thumb_url: item.url, large_url: item.url })) };
}
