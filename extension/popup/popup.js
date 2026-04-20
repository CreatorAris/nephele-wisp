/*
 * Popup UI: reflects bridge connection status and offers manual reconnect.
 * Pulls state from the service worker via runtime messaging.
 */

const statusEl = document.getElementById('status');
const nepheleEl = document.getElementById('nephele');
const versionEl = document.getElementById('version');
const attemptsEl = document.getElementById('attempts');
const reconnectBtn = document.getElementById('reconnect');

async function refresh() {
    let res;
    try {
        res = await chrome.runtime.sendMessage({ type: 'query_status' });
    } catch (_) {
        res = null;
    }
    if (!res) {
        statusEl.textContent = 'Service worker idle';
        statusEl.className = 'status disconnected';
        return;
    }
    versionEl.textContent = `v${res.extensionVersion}`;
    attemptsEl.textContent = String(res.reconnectAttempts ?? 0);
    if (res.connected) {
        statusEl.textContent = 'Connected';
        statusEl.className = 'status connected';
        nepheleEl.textContent = res.nepheleVersion
            ? `v${res.nepheleVersion}`
            : 'handshake ok';
    } else {
        statusEl.textContent = 'Disconnected';
        statusEl.className = 'status disconnected';
        nepheleEl.textContent = '—';
    }
}

reconnectBtn.addEventListener('click', async () => {
    reconnectBtn.disabled = true;
    statusEl.textContent = 'Reconnecting…';
    statusEl.className = 'status pending';
    try {
        await chrome.runtime.sendMessage({ type: 'force_reconnect' });
    } catch (_) { /* noop */ }
    setTimeout(() => {
        reconnectBtn.disabled = false;
        refresh();
    }, 1500);
});

chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.kind === 'internal' && msg?.type === 'status_update') {
        refresh();
    }
});

refresh();
setInterval(refresh, 2000);
