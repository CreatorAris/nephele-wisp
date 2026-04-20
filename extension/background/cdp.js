/*
 * CDP orchestration framework.
 *
 * Wraps chrome.debugger with a small, platform-agnostic session API
 * that every handler under background/handlers/ uses to drive a
 * target page. All DOM mutations are funneled through the
 * Humanization Pipeline — handlers never dispatch raw CDP input
 * events directly, they call click()/type() on a CdpSession.
 *
 * Chrome shows a yellow "Nephele Wisp is debugging this browser" bar
 * on attached tabs. This is intentional and documented in
 * docs/SECURITY.md — the debugger permission is the only way to
 * synthesize input at a level that defeats anti-automation while
 * still looking like the user from the platform's perspective.
 */

import {
    sleep, preActionDelay, clickMoveGap, clickHold,
    stepDwell, typingInterval, jitterPoint,
} from './humanize.js';

const DEBUGGER_VERSION = '1.3';

// ──────────────────────────────────────────────────────────────────
// Session
// ──────────────────────────────────────────────────────────────────

export class CdpSession {
    constructor(tabId) {
        this.tabId = tabId;
        this.target = { tabId };
        this.attached = false;
    }

    async attach() {
        if (this.attached) return;
        await new Promise((resolve, reject) => {
            chrome.debugger.attach(this.target, DEBUGGER_VERSION, () => {
                const err = chrome.runtime.lastError;
                if (err) reject(new Error(`attach: ${err.message}`));
                else resolve();
            });
        });
        this.attached = true;
        // Enable the domains we use. Order matters for DOM.enable —
        // must be on before DOM.querySelector calls.
        await this.send('Page.enable');
        await this.send('DOM.enable');
        await this.send('Runtime.enable');
    }

    async detach() {
        if (!this.attached) return;
        try {
            await new Promise((resolve) => {
                chrome.debugger.detach(this.target, () => resolve());
            });
        } catch (_) { /* ignore */ }
        this.attached = false;
    }

    // Raw CDP command. Throws on error.
    send(method, params = {}) {
        return new Promise((resolve, reject) => {
            chrome.debugger.sendCommand(this.target, method, params, (result) => {
                const err = chrome.runtime.lastError;
                if (err) reject(new Error(`${method}: ${err.message}`));
                else resolve(result);
            });
        });
    }

    // ── Navigation ────────────────────────────────────────────────

    async navigate(url, { timeoutMs = 30000 } = {}) {
        const loadWait = this._waitForLoadEvent(timeoutMs);
        await this.send('Page.navigate', { url });
        await loadWait;
        await stepDwell();
    }

    _waitForLoadEvent(timeoutMs) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const listener = (src, method) => {
                if (settled || src.tabId !== this.tabId) return;
                if (method === 'Page.loadEventFired') {
                    settled = true;
                    cleanup();
                    resolve();
                }
            };
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error(`TIMEOUT: page load ${timeoutMs}ms`));
            }, timeoutMs);
            const cleanup = () => {
                clearTimeout(timer);
                chrome.debugger.onEvent.removeListener(listener);
            };
            chrome.debugger.onEvent.addListener(listener);
        });
    }

    // ── Queries ───────────────────────────────────────────────────

    async waitForSelector(selector, { timeoutMs = 10000, pollMs = 250 } = {}) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const r = await this.evaluate(
                `!!document.querySelector(${JSON.stringify(selector)})`,
            );
            if (r.value === true) return;
            await sleep(pollMs);
        }
        throw new Error(`DOM_NOT_FOUND: ${selector} (timeout ${timeoutMs}ms)`);
    }

    async evaluate(expression) {
        const r = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
        });
        if (r.exceptionDetails) {
            throw new Error(`evaluate: ${r.exceptionDetails.text}`);
        }
        return r.result;
    }

    async getTitle() {
        const r = await this.evaluate('document.title');
        return r.value;
    }

    async getUrl() {
        const r = await this.evaluate('location.href');
        return r.value;
    }

    // Returns element's bounding box in viewport coordinates, or throws.
    async _elementBox(selector) {
        const r = await this.evaluate(`
            (() => {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return null;
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return null;
                return {
                    x: rect.left, y: rect.top,
                    w: rect.width, h: rect.height,
                    cx: rect.left + rect.width / 2,
                    cy: rect.top + rect.height / 2,
                };
            })()
        `);
        if (r.value == null) {
            throw new Error(`DOM_NOT_FOUND: ${selector} (or zero-size)`);
        }
        return r.value;
    }

    // ── Humanized interactions ────────────────────────────────────

    async click(selector) {
        await preActionDelay();
        const box = await this._elementBox(selector);
        const bounds = {
            left:   box.x + 1,
            right:  box.x + box.w - 1,
            top:    box.y + 1,
            bottom: box.y + box.h - 1,
        };
        const { x, y } = jitterPoint(box.cx, box.cy, bounds);

        await this.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved', x, y,
        });
        await clickMoveGap();
        await this.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x, y, button: 'left', clickCount: 1,
        });
        await clickHold();
        await this.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x, y, button: 'left', clickCount: 1,
        });
    }

    // Type text at the given selector (clicks to focus first, unless
    // disabled). Per-key dispatchKeyEvent — anti-automation detectors
    // that check for keydown/keyup events see them.
    async type(selector, text, { focusFirst = true } = {}) {
        await preActionDelay();
        if (focusFirst) {
            await this.click(selector);
            await sleep(120);  // post-focus settle
        }
        for (const ch of text) {
            await this.send('Input.dispatchKeyEvent', {
                type: 'keyDown', text: ch,
            });
            await this.send('Input.dispatchKeyEvent', {
                type: 'keyUp', text: ch,
            });
            await typingInterval();
        }
    }

    // Native key press (e.g., 'Enter', 'Escape', 'Tab').
    async press(key) {
        await this.send('Input.dispatchKeyEvent', {
            type: 'keyDown', key, code: key,
        });
        await sleep(30);
        await this.send('Input.dispatchKeyEvent', {
            type: 'keyUp', key, code: key,
        });
    }

    // ── File inputs (bypass OS dialog) ────────────────────────────

    async setFileInputFiles(selector, filePaths) {
        const doc = await this.send('DOM.getDocument');
        const q = await this.send('DOM.querySelector', {
            nodeId: doc.root.nodeId,
            selector,
        });
        if (!q.nodeId) {
            throw new Error(`DOM_NOT_FOUND: ${selector}`);
        }
        await this.send('DOM.setFileInputFiles', {
            nodeId: q.nodeId,
            files: filePaths,
        });
    }

    // ── Captures ──────────────────────────────────────────────────

    async screenshot() {
        const r = await this.send('Page.captureScreenshot', { format: 'png' });
        return r.data;  // base64 PNG
    }

    // ── Captcha detection ─────────────────────────────────────────

    // Heuristic scan for common human-verification widgets. Returns
    // the first match or null. Handlers SHOULD call this before
    // proceeding past critical steps and circuit-break if found.
    async detectCaptcha() {
        const r = await this.evaluate(`
            (() => {
                const selectors = [
                    'iframe[src*="geetest"]',
                    'iframe[src*="recaptcha"]',
                    'iframe[src*="hcaptcha"]',
                    '.geetest_holder',
                    '.geetest_panel',
                    '[class*="captcha"]:not([class*="captcha-container-placeholder"])',
                ];
                for (const sel of selectors) {
                    const el = document.querySelector(sel);
                    if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
                        return { selector: sel, outerHTML: el.outerHTML.slice(0, 200) };
                    }
                }
                return null;
            })()
        `);
        return r.value;
    }
}

// ──────────────────────────────────────────────────────────────────
// Convenience: create tab → attach → run fn → detach → remove tab
// ──────────────────────────────────────────────────────────────────

export async function withCdpTab(initialUrl, fn) {
    const tab = await new Promise((resolve, reject) => {
        chrome.tabs.create({ url: initialUrl, active: false }, (t) => {
            const err = chrome.runtime.lastError;
            if (err) reject(new Error(`tabs.create: ${err.message}`));
            else resolve(t);
        });
    });
    const session = new CdpSession(tab.id);
    try {
        await session.attach();
        return await fn(session, tab);
    } finally {
        try { await session.detach(); } catch (_) { /* noop */ }
        try {
            await new Promise((resolve) => {
                chrome.tabs.remove(tab.id, () => resolve());
            });
        } catch (_) { /* noop */ }
    }
}

// ──────────────────────────────────────────────────────────────────
// Error classification (maps thrown errors to PROTOCOL.md codes)
// ──────────────────────────────────────────────────────────────────

export function classifyCdpError(err) {
    const msg = (err && err.message) || String(err);
    if (msg.startsWith('DOM_NOT_FOUND')) return 'DOM_NOT_FOUND';
    if (msg.startsWith('TIMEOUT')) return 'TIMEOUT';
    if (msg.includes('attach')) return 'INTERNAL';  // debugger attach failure
    if (msg.toLowerCase().includes('captcha')) return 'CAPTCHA_REQUIRED';
    return 'INTERNAL';
}
