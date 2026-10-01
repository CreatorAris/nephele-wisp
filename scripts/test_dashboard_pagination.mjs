import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let now = 0;
let listener;
let scheduled = [];
let scrolls = 0;
let failRequest = false;
const emit = (method, params) => listener?.({ tabId: 1 }, method, params);
const sleep = async ms => {
    now += ms;
    const ready = scheduled.filter(event => event.at <= now);
    scheduled = scheduled.filter(event => event.at > now);
    for (const event of ready) event.run();
};
const session = {
    tabId: 1,
    getUrl: async () => 'https://example.invalid/orders',
    send: async method => {
        if (method === 'Runtime.evaluate' && ++scrolls === 1) {
            emit('Network.requestWillBeSent', {
                requestId: 'page-2', request: { url: 'https://example.invalid/api/orders?page=2' },
            });
            scheduled.push({ at: now + 3000, run: () => {
                if (failRequest) {
                    emit('Network.loadingFailed', { requestId: 'page-2' });
                } else {
                    emit('Network.responseReceived', {
                        requestId: 'page-2', response: {
                            url: 'https://example.invalid/api/orders?page=2',
                            mimeType: 'application/json', status: 200,
                        },
                    });
                    emit('Network.loadingFinished', { requestId: 'page-2' });
                }
            } });
        }
        if (method === 'Network.getResponseBody') return { body: '{"orders":[2]}' };
        return {};
    },
};
globalThis.chrome = { debugger: { onEvent: {
    addListener: fn => { listener = fn; },
    removeListener: fn => { if (listener === fn) listener = undefined; },
} } };
globalThis.__dashboardMock = { sleep, withCdpTab: async (_url, run) => run(session) };
let source = await readFile(new URL('../extension/background/handlers/creator_common.js', import.meta.url), 'utf8');
source = source.replace(/^import .*;$/gm, '');
source = 'const { sleep, withCdpTab } = globalThis.__dashboardMock;\n' + source;
const { captureDashboardXhrs } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const originalNow = Date.now;
Date.now = () => now;
try {
    const opts = {
        dashboardUrl: 'https://example.invalid/orders', urlIncludeRegex: /\/api\/orders/,
        idleMs: 100, hardTimeoutMs: 10000,
        paginate: { idleMs: 1200, triggerMs: 2500, budgetMs: 20000 },
    };
    const result = await captureDashboardXhrs(opts);
    assert.equal(result.pages, 2);
    assert.deepEqual(JSON.parse(result.captured['https://example.invalid/api/orders?page=2'].body), { orders: [2] });
    assert.equal(scrolls, 2, 'a slow page must finish before checking for another page');
    assert.equal(scheduled.length, 0);
    assert.equal(listener, undefined);

    now = 0;
    scrolls = 0;
    failRequest = true;
    const failed = await captureDashboardXhrs(opts);
    assert.deepEqual(failed.captured, {});
    assert.ok(now < 10000, 'failed requests must stop counting as in flight');
    assert.equal(scheduled.length, 0);
    assert.equal(listener, undefined);
    console.log('Dashboard pagination: slow pages captured; failed requests settle.');
} finally {
    Date.now = originalNow;
    delete globalThis.__dashboardMock;
}
