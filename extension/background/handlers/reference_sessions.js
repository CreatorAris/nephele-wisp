import { closeOwnedCdpTab } from '../cdp.js';

// Owned background pages survive between bounded reference batches.
const sessions = new Map();
const TTL_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 16;

function failure(code) {
    return Object.assign(new Error(code), { code });
}
async function close(id, state) {
    sessions.delete(id);
    if (state.tabId !== null) {
        await closeOwnedCdpTab(state.tabId);
    }
}

export async function withReferenceSession(payload, url, run) {
    const now = Date.now();
    for (const [id, state] of sessions) {
        if (!state.busy && now - state.touched > TTL_MS) await close(id, state);
    }
    const token = String(payload?.continuation || '');
    const [id, revision] = token.split(':');
    let state = token ? sessions.get(id) : null;
    if (token && (!state || state.url !== url)) throw failure('SESSION_EXPIRED');
    if (!state) {
        if (sessions.size >= MAX_SESSIONS) {
            const oldest = [...sessions].find(([, value]) => !value.busy);
            if (!oldest) throw failure('BUSY');
            await close(...oldest);
        }
        state = { id: crypto.randomUUID(), url, tabId: null, touched: now,
            revision: 0, pending: [], seen: new Set(), busy: false, lastToken: null, lastResult: null };
        sessions.set(state.id, state);
    }
    if (state.busy) throw failure('BUSY');
    if (token && token === state.lastToken) return state.lastResult;
    if (token && Number(revision) !== state.revision) throw failure('SESSION_EXPIRED');
    state.busy = true;
    state.touched = now;
    try {
        const result = await run(state);
        state.revision += 1;
        result.continuation = `${state.id}:${state.revision}`;
        result.has_more = state.revision < 50;
        result.stop_reason = !result.has_more ? 'page_limit' : result.items?.length ? '' : 'no_new_results';
        state.lastToken = token;
        state.lastResult = result;
        // Nothing left to page through: release the tab now rather than
        // letting it (and, on a windowless Edge, the hidden window created
        // for it) sit until the 15-minute sweep.
        if (!result.has_more) await close(state.id, state);
        return result;
    } catch (error) {
        if (/No tab|Invalid tab/i.test(error?.message || '')) {
            await close(state.id, state);
            throw failure('SESSION_EXPIRED');
        }
        throw error;
    } finally {
        state.busy = false;
    }
}

export async function closeAllReferenceSessions() {
    for (const [id, state] of [...sessions]) {
        if (!state.busy) await close(id, state);
    }
}

if (globalThis.chrome?.alarms) {
    chrome.alarms.create('reference-session-expiry', { periodInMinutes: 5 });
    chrome.alarms.onAlarm.addListener(async alarm => {
        if (alarm.name !== 'reference-session-expiry') return;
        for (const [id, state] of sessions) {
            if (!state.busy && Date.now() - state.touched > TTL_MS) await close(id, state);
        }
    });
}
