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

// Minimal map for shortcut keys we actually use (a–z letters + common
// named keys). CDP's `code` field expects physical-key codes, not the
// produced character. Extend when a new key is needed.
function keyToCode(key) {
    if (key.length === 1) {
        const c = key.toLowerCase();
        if (c >= 'a' && c <= 'z') return `Key${c.toUpperCase()}`;
        if (c >= '0' && c <= '9') return `Digit${c}`;
    }
    const named = {
        Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace',
        Delete: 'Delete', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
        ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Space: 'Space',
    };
    return named[key] || key;
}

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
        // Auto-clear attached flag if the debugger gets detached out
        // from under us (e.g. cross-origin navigation, target swap on
        // some platforms). Subsequent ops will see attached=false and
        // can re-attach via _ensureAttached().
        if (!this._detachListenerInstalled) {
            this._detachListenerInstalled = true;
            chrome.debugger.onDetach.addListener((src, _reason) => {
                if (src && src.tabId === this.tabId) {
                    this.attached = false;
                }
            });
        }
        // Enable the domains we use. Order matters for DOM.enable —
        // must be on before DOM.querySelector calls.
        await this.send('Page.enable');
        await this.send('DOM.enable');
        await this.send('Runtime.enable');
    }

    async _ensureAttached() {
        if (this.attached) return;
        await this.attach();
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

    // Raw CDP command. Throws on error. Auto-reattaches once on
    // "Detached" — cross-origin navigation (e.g. anonymous publisher
    // URL → sso/passport login redirect) detaches the debugger
    // session; the tab is still alive and we should pick back up
    // rather than crash with INTERNAL.
    async send(method, params = {}, { _retry = false } = {}) {
        const exec = () => new Promise((resolve, reject) => {
            chrome.debugger.sendCommand(this.target, method, params, (result) => {
                const err = chrome.runtime.lastError;
                if (err) reject(new Error(`${method}: ${err.message}`));
                else resolve(result);
            });
        });
        try {
            return await exec();
        } catch (e) {
            const msg = (e && e.message) || '';
            if (!_retry && /Detached|Cannot find context|debugger is not attached/i.test(msg)) {
                this.attached = false;
                await this._ensureAttached();
                return await exec();
            }
            throw e;
        }
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

    // Wait until the selector matches AND the element is truly visible —
    // non-zero bounding box and not display:none. B站's Vue often hydrates
    // container DOM before the child is styled visible, so
    // waitForSelector can pass while click() still throws zero-size.
    async waitForVisible(selector, { timeoutMs = 10000, pollMs = 200 } = {}) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const r = await this.evaluate(`
                (() => {
                    const el = document.querySelector(${JSON.stringify(selector)});
                    if (!el) return false;
                    const rect = el.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0) return false;
                    const cs = getComputedStyle(el);
                    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
                    return true;
                })()
            `);
            if (r.value === true) return;
            await sleep(pollMs);
        }
        throw new Error(`DOM_NOT_FOUND: ${selector} not visible (timeout ${timeoutMs}ms)`);
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
        // Retry zero-size: Vue/React animations can flicker an element
        // through rect=(0,0) mid-transition even after it's functionally
        // mounted. Three tries (≈600ms total) covers all the flicker
        // windows we've observed on bilibili t.bilibili.com.
        let box = null, lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                box = await this._elementBox(selector);
                break;
            } catch (e) {
                lastErr = e;
                if (!String(e.message).includes('zero-size') && !String(e.message).includes('DOM_NOT_FOUND')) throw e;
                await sleep(200 + attempt * 150);
            }
        }
        if (!box) throw lastErr;

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

    // Press a modified shortcut. Shape: { mods: ['Control'|'Shift'|'Alt'|'Meta'],
    // key: 'a'|'Enter'|... }. Modifiers are held for the duration of the
    // primary key. Used for Ctrl+A, Ctrl+Z, etc.
    async pressShortcut({ mods = [], key }) {
        const MOD_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
        let modifiers = 0;
        for (const m of mods) modifiers |= (MOD_BITS[m] || 0);
        for (const m of mods) {
            await this.send('Input.dispatchKeyEvent', {
                type: 'keyDown', key: m, code: m + 'Left',
            });
        }
        await this.send('Input.dispatchKeyEvent', {
            type: 'rawKeyDown', key, code: keyToCode(key), modifiers,
        });
        await sleep(30);
        await this.send('Input.dispatchKeyEvent', {
            type: 'keyUp', key, code: keyToCode(key), modifiers,
        });
        for (const m of mods.slice().reverse()) {
            await this.send('Input.dispatchKeyEvent', {
                type: 'keyUp', key: m, code: m + 'Left',
            });
        }
    }

    // Evaluate a function expression with JSON-serializable args.
    // Encodes args inline so the function body sees them as locals. Use
    // this instead of string interpolation to avoid injection bugs and
    // quote-escaping pain.
    async evaluateFn(fn, args = []) {
        const argsJson = JSON.stringify(args);
        const expr = `(${fn.toString()}).apply(null, ${argsJson})`;
        const r = await this.evaluate(expr);
        return r.value;
    }

    // Wait until at least one of the selectors is present. Returns the
    // first matching selector. Throws DOM_NOT_FOUND on timeout.
    async waitForAnySelector(selectors, { timeoutMs = 10000, pollMs = 250 } = {}) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            for (const sel of selectors) {
                const r = await this.evaluate(
                    `!!document.querySelector(${JSON.stringify(sel)})`,
                );
                if (r.value === true) return sel;
            }
            await sleep(pollMs);
        }
        throw new Error(
            `DOM_NOT_FOUND: none of [${selectors.join(', ')}] (timeout ${timeoutMs}ms)`,
        );
    }

    // Register a script to run on every new document load — useful for
    // patching page globals BEFORE any page script runs (e.g., stubbing
    // window.showOpenFilePicker before the platform calls it).
    async addScriptOnNewDocument(source) {
        const r = await this.send('Page.addScriptToEvaluateOnNewDocument', {
            source,
        });
        return r.identifier;
    }

    // Type text into a contenteditable element. B站's 动态 editor is a
    // contenteditable div — plain keyboard dispatch into a focused node
    // doesn't stick through React/Vue controllers that listen only for
    // input/compositionend. execCommand('insertText') dispatches a real
    // InputEvent that frameworks handle correctly.
    async typeContentEditable(selector, text) {
        await preActionDelay();
        await this.click(selector);
        await sleep(120);
        // Clear existing content first (select all + delete).
        await this.pressShortcut({ mods: ['Control'], key: 'a' });
        await sleep(80);
        await this.press('Delete');
        await sleep(100);
        const ok = await this.evaluateFn((sel, t) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            el.focus();
            return document.execCommand('insertText', false, t);
        }, [selector, text]);
        if (!ok) {
            // Fallback: per-key dispatch. Slower but Vue/React will at
            // least see individual input events from the focused node.
            for (const ch of text) {
                await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch });
                await this.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch });
                await typingInterval();
            }
        }
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

    // Multi-step approach click — dispatches a trail of mouseMoved
    // events from an offset point to the target, then press + hold +
    // release. Some Vue trust gates (B站's topic-item binder is one)
    // appear to check the INCOMING MOUSE PATH, not just isTrusted: a
    // teleport-to-target + press fails them, but an arc of intermediate
    // mouseMoved events with realistic timing passes. Mirrors
    // Playwright's `page.mouse.move(..., steps=N)` pattern.
    async elaborateClick(cx, cy) {
        const offsetX = cx - 40;
        const offsetY = cy + 40;
        const lerp = (a, b, t) => a + (b - a) * t;
        const stepMove = async (fromX, fromY, toX, toY, steps) => {
            for (let i = 1; i <= steps; i++) {
                const t = i / steps;
                await this.send('Input.dispatchMouseEvent', {
                    type: 'mouseMoved',
                    x: lerp(fromX, toX, t),
                    y: lerp(fromY, toY, t),
                });
                await sleep(15 + Math.random() * 10);
            }
        };
        await stepMove(offsetX - 30, offsetY + 20, offsetX, offsetY, 3);
        await sleep(80);
        await stepMove(offsetX, offsetY, cx, cy, 5);
        await sleep(120);
        await this.send('Input.dispatchMouseEvent', {
            type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1,
        });
        await sleep(80);
        await this.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1,
        });
    }

    // JS click — bypasses coordinate-based mouse simulation. Useful for
    // buttons that are animating or styled with transform:scale(0)
    // momentarily — getBoundingClientRect may flicker zero-size mid-
    // animation even though the element is functionally clickable.
    // The humanization pipeline applies to *typing* (keystroke cadence
    // is what anti-bot systems profile); a single JS click is
    // indistinguishable from coordinate click at the event-handler
    // level.
    async jsClick(selector) {
        await preActionDelay();
        const ok = await this.evaluateFn((sel) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            el.click();
            return true;
        }, [selector]);
        if (!ok) throw new Error(`DOM_NOT_FOUND: ${selector}`);
    }

    // Wait for the next Page.fileChooserOpened event on this tab.
    // Assumes Page.setInterceptFileChooserDialog(true) is already in
    // effect — enable it up-front (e.g., before navigate) rather than
    // per-click, otherwise the native OS dialog has a propagation-race
    // window where it flashes briefly before the intercept kicks in.
    waitForFileChooser({ timeoutMs = 8000 } = {}) {
        const tabId = this.tabId;
        return new Promise((resolve, reject) => {
            let settled = false;
            const listener = (src, method, params) => {
                if (settled || src.tabId !== tabId) return;
                if (method !== 'Page.fileChooserOpened') return;
                settled = true;
                cleanup();
                resolve(params);
            };
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error(`TIMEOUT: file chooser did not open in ${timeoutMs}ms`));
            }, timeoutMs);
            const cleanup = () => {
                clearTimeout(timer);
                chrome.debugger.onEvent.removeListener(listener);
            };
            chrome.debugger.onEvent.addListener(listener);
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

// If `keepTab: true`, the tab is left open after fn resolves/rejects —
// only the debugger is detached. Used for publisher flows where the
// user must visually review the filled draft and hit 发布 manually, so
// closing the tab would discard their work. Default is to remove the
// tab (suitable for fire-and-forget data-ingest flows like creator.*
// and inbox.fetch_*).
export async function withCdpTab(initialUrl, fn, { keepTab = false, active = false } = {}) {
    const tab = await new Promise((resolve, reject) => {
        chrome.tabs.create({ url: initialUrl, active }, (t) => {
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
        if (!keepTab) {
            try {
                await new Promise((resolve) => {
                    chrome.tabs.remove(tab.id, () => resolve());
                });
            } catch (_) { /* noop */ }
        }
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
