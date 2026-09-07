import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withReferenceSession } from '../extension/background/handlers/reference_sessions.js';

const tabs = new Map();
const removed = [];
globalThis.chrome = { tabs: { remove: async id => { removed.push(id); tabs.delete(id); } } };
let executions = 0;
const run = async state => { executions++; state.tabId = 777; return { items: [{ url: 'one' }] }; };
const first = await withReferenceSession({}, 'https://test.invalid/a', run);
const second = await withReferenceSession({ continuation: first.continuation }, 'https://test.invalid/a', run);
assert.equal(executions, 2);
assert.deepEqual(await withReferenceSession({ continuation: first.continuation }, 'https://test.invalid/a', run), second);
assert.equal(executions, 2, 'lost-response retry must replay same batch');
await assert.rejects(withReferenceSession({ continuation: second.continuation }, 'https://test.invalid/other', run), /SESSION_EXPIRED/);
await assert.rejects(withReferenceSession({ continuation: second.continuation }, 'https://test.invalid/a', async () => { throw Error('timeout'); }), /timeout/);
assert.ok((await withReferenceSession({ continuation: second.continuation }, 'https://test.invalid/a', run)).continuation);

let navCalls = 0;
let tabSerial = 0;
let pool = [];
let gate = '';
const session = {
    send: async () => ({}),
    navigate: async () => { navCalls++; },
    getUrl: async () => 'https://x.com/theposearchives/media?filter=photo',
    evaluateFn: async fn => {
        const text = fn.toString();
        if (text.includes('const abs')) return { out: pool, stats: {} };
        if (text.includes('const visible')) return gate;
        if (text.includes('Array.from(document.images')) return pool;
        if (text.includes('document.title')) return 'ThePoseArchives';
        return undefined;
    },
};
globalThis.__referenceMock = {
    withCdpTab: async (url, fn, options) => {
        const id = options.reuseTabId ?? ++tabSerial;
        tabs.set(id, url);
        return fn(session, { id });
    },
    isLocalIngestUrl: () => true,
    sleep: async () => {}, preActionDelay: async () => {}, withReferenceSession,
};
globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
globalThis.createImageBitmap = async () => ({ width: 640, height: 480, close() {} });
globalThis.OffscreenCanvas = class { getContext() { return { drawImage() {} }; } async convertToBlob() { return new Blob([new Uint8Array(10)]); } };
let source = await readFile(new URL('../extension/background/handlers/reference_resources.js', import.meta.url), 'utf8');
source = source.replace(/^import .*;$/gm, '');
source = 'const { withCdpTab, isLocalIngestUrl, sleep, preActionDelay, withReferenceSession } = globalThis.__referenceMock;\n' + source;
const { extractPageResources } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const img = id => ({ url: `https://pbs.twimg.com/media/${id}?format=jpg`, width: 640, height: 480, source_type: 'img', alt: `pose ${id}` });
pool = Array.from({ length: 60 }, (_, i) => img(i));
const params = { url: 'https://x.com/theposearchives/media?filter=photo', max_items: 40, scroll_rounds: 0, settle_max_ms: 0 };
const a = await extractPageResources(params);
const b = await extractPageResources({ ...params, continuation: a.continuation });
assert.equal(a.items.length, 40);
assert.equal(b.items.length, 20);
pool = [...Array.from({ length: 57 }, (_, i) => img(i)), img(60), img(61), img(62)];
const c = await extractPageResources({ ...params, continuation: b.continuation });
assert.equal(c.items.length, 3, '57 old images must not consume next-batch slots');
assert.equal(navCalls, 1, 'continuation must reuse the original page');
assert.equal(new Set([...a.items, ...b.items, ...c.items].map(item => item.url)).size, 63);
gate = 'AUTH_REQUIRED';
await assert.rejects(extractPageResources({ ...params, continuation: c.continuation }), /AUTH_REQUIRED/);
gate = '';
pool = [img(63)];
const d = await extractPageResources({ ...params, continuation: c.continuation });
assert.equal(d.items.length, 1, 'login failure must retain continuation');
console.log('Reference session and retained-page continuation: passed (40/20/3, one navigation).');

let scrolls = 0;
const originalEvaluate = session.evaluateFn;
session.evaluateFn = async fn => {
    if (fn.toString().includes('window.scrollBy')) scrolls++;
    return originalEvaluate(fn);
};
pool = [img(999)];
globalThis.fetch = async () => new Response('', { status: 500 });
const failed1 = await extractPageResources({ ...params, scroll_rounds: 1 });
const failed2 = await extractPageResources({ ...params, continuation: failed1.continuation, scroll_rounds: 1 });
const beforeResume = scrolls;
await extractPageResources({ ...params, continuation: failed2.continuation, scroll_rounds: 1 });
assert.ok(scrolls > beforeResume, 'permanently failing visible image must not block scrolling');

pool = Array.from({ length: 40 }, (_, i) => img(1000 + i));
globalThis.fetch = async () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/jpeg' } });
globalThis.OffscreenCanvas = class { getContext() { return { drawImage() {} }; } async convertToBlob() { return new Blob([new Uint8Array(20000)]); } };
let budgetBatch = await extractPageResources(params);
const budgetSeen = new Set();
for (let i = 0; i < 6 && budgetSeen.size < 40; i++) {
    assert.ok(Buffer.byteLength(JSON.stringify(budgetBatch), 'utf8') < 880000);
    for (const item of budgetBatch.items) budgetSeen.add(item.url);
    if (budgetSeen.size < 40) budgetBatch = await extractPageResources({ ...params, continuation: budgetBatch.continuation });
}
assert.equal(budgetSeen.size, 40, 'wire-size trimming must preserve pending images');
console.log('Failed thumbnails cannot starve scroll; full response budget preserves all candidates.');

let apiSource = await readFile(new URL('../extension/background/handlers/reference_pinterest.js', import.meta.url), 'utf8');
apiSource = apiSource.replace(/^import .*;$/gm, '');
apiSource = 'const sleep = async () => {};\n' + apiSource + '\nexport { tryApiExtraction };';
const { tryApiExtraction } = await import('data:text/javascript;base64,' + Buffer.from(apiSource).toString('base64'));
const bookmarks = [];
let apiPage = 0;
globalThis.fetch = async url => {
    const parsed = new URL(url, 'https://www.pinterest.com');
    bookmarks.push(JSON.parse(parsed.searchParams.get('data')).options.bookmarks || []);
    const start = apiPage++ * 60;
    return Response.json({ resource_response: { bookmark: apiPage < 2 ? 'page-two' : '-end-', data: {
        results: Array.from({ length: 60 }, (_, i) => ({ id: String(start + i), images: {
            '236x': { url: `https://i.pinimg.com/236x/ab/${start + i}.jpg` },
        } })),
    } } });
};
const apiSession = { evaluateFn: async () => true, evaluateAsyncFn: async (fn, args) => fn(...args) };
const p1 = await tryApiExtraction(apiSession, 'picture book girl', 40, 1);
const p2 = await tryApiExtraction(apiSession, 'picture book girl', 40, 1, p1.continuation);
const p3 = await tryApiExtraction(apiSession, 'picture book girl', 40, 1, p2.continuation);
assert.deepEqual(bookmarks, [[], ['page-two']]);
assert.deepEqual([p1.items.length, p2.items.length, p3.items.length], [40, 40, 40]);
assert.equal(new Set([...p1.items, ...p2.items, ...p3.items].map(item => item.pin_id)).size, 120);
assert.equal(p3.has_more, false);
console.log('Pinterest bookmark contract: 120 unique candidates, two API requests.');
