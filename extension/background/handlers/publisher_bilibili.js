/*
 * B站 动态 upload handler — real draft flow (v0.4).
 *
 * Strategy (based on Playwright/Puppeteer community workarounds for
 * File System Access API sites, e.g. playwright#8850):
 *
 *   1. BEFORE the page loads, null out window.showOpenFilePicker via
 *      Page.addScriptToEvaluateOnNewDocument. B站's bundle feature-
 *      detects FSA and falls back to a traditional <input type="file">
 *      when the API is absent. This is the ONLY reliable path — with
 *      debugger attached, Chrome silently rejects FSA calls in some
 *      cases (chromium#1019762), and FSA pickers don't trigger
 *      Page.fileChooserOpened (puppeteer#5210).
 *   2. Navigate t.bilibili.com. Redirect to passport ⇒ AUTH_REQUIRED.
 *   3. Wait for .bili-dyn-publishing.
 *   4. Optional title into .bili-dyn-publishing__title__input (≤ 20).
 *   5. Caption into .bili-rich-textarea__inner (contenteditable).
 *   6. Image:
 *        a. Activate pic tool if not already.
 *        b. Arm Page.setInterceptFileChooserDialog(true).
 *        c. Coord-click the + tile (trusted user gesture required —
 *           Chrome blocks programmatic file-picker calls from fake
 *           clicks even for <input type="file">).
 *        d. Await Page.fileChooserOpened event — backendNodeId is the
 *           real <input type="file"> B站 created via the fallback path.
 *        e. DOM.setFileInputFiles(backendNodeId, [localPath]).
 *        f. Turn intercept off.
 *        g. Poll for .bili-pics-uploader__item.success tile.
 *   7. Optional topic via .bili-topic-search__input (best-effort).
 *   8. Return draft_ready. 发布 button is NEVER clicked.
 */

import { sleep, stepDwell, preActionDelay } from '../humanize.js';
import { fetchAsset } from '../asset.js';

const HOME_URL = 'https://t.bilibili.com';
const DRAFT_ROOT_SELECTOR = '.bili-dyn-publishing';
const TITLE_SELECTOR = '.bili-dyn-publishing__title__input';
const CAPTION_SELECTOR = '.bili-rich-textarea__inner';
const PIC_TOOL_SELECTOR = '.bili-dyn-publishing__tools__item.pic';
const PIC_ADD_SELECTOR = '.bili-pics-uploader__add';
const UPLOAD_SUCCESS_SELECTOR = '.bili-pics-uploader__item.success';
// B站 currently uses `.error` (CSS class on the tile) with a child
// `.bili-pics-uploader-item-error__msg` carrying the human-visible
// reason text. Older builds used `.failed` — keep both in the
// selector list to be tolerant of A/B rollouts. Used in
// querySelectorAll which accepts comma-separated selector groups.
const UPLOAD_FAILED_SELECTOR = '.bili-pics-uploader__item.failed, .bili-pics-uploader__item.error';
const PUBLISH_BTN_SELECTOR = '.bili-dyn-publishing__action.launcher';
const TOPIC_INPUT_SELECTOR = '.bili-topic-search__input';

// Pre-page-load stub (Page.addScriptToEvaluateOnNewDocument), two layers:
//
// 1. FSA disable — B站 builds up to ~2026-07 preferred
//    window.showOpenFilePicker (captured at module-load time) with an
//    <input type="file"> fallback. Hiding FSA forces the fallback,
//    which plays nicely with CDP file-chooser interception. Kept for
//    A/B tolerance even though current builds dropped FSA entirely.
//
// 2. File-input click trap — the 2026-07-14 bundle creates a DETACHED
//    <input type="file"> (uploader._init: createElement, never appended)
//    and .click()s it from the + tile handler. Chooser interception does
//    NOT reliably emit Page.fileChooserOpened for detached inputs, so
//    the old event-wait path times out. The trap swallows programmatic
//    clicks on file inputs and stashes the element on
//    window.__nephele_file_input; the handler then delivers files
//    directly via DOM.setFileInputFiles({ objectId }) — no dialog, no
//    chooser event needed. setFileInputFiles fires input/change itself,
//    so B站's change listener runs as if the user picked files.
const FSA_DISABLE_STUB = `
(function () {
    try { delete window.showOpenFilePicker; } catch (_) {}
    try { delete window.chooseFileSystemEntries; } catch (_) {}
    try { delete window.showDirectoryPicker; } catch (_) {}
    try { delete window.showSaveFilePicker; } catch (_) {}
    // If delete is refused (non-configurable), shadow with a non-function
    // value so \`typeof fn === 'function'\` checks fail.
    try { Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true }); } catch (_) {}
    try { Object.defineProperty(window, 'chooseFileSystemEntries', { value: undefined, configurable: true }); } catch (_) {}
    try {
        const origClick = HTMLInputElement.prototype.click;
        HTMLInputElement.prototype.click = function () {
            if ((this.type || '').toLowerCase() === 'file') {
                window.__nephele_file_input = this;
                // One-shot: restore immediately so the user's own manual
                // uploads in this (kept-open) review tab work natively.
                HTMLInputElement.prototype.click = origClick;
                return;  // swallow: files arrive via DOM.setFileInputFiles
            }
            return origClick.call(this);
        };
    } catch (_) {}
})();
`;

export async function handleBilibiliUploadDraft(session, payload) {
    payload = payload || {};
    const caption = payload.caption || '';
    const title = payload.title || '';
    const topic = (payload.topic || '').replace(/^#+|#+$/g, '').trim();

    if (!caption && !title) {
        const err = new Error('INVALID_PAYLOAD: caption or title required');
        err.code = 'INVALID_PAYLOAD';
        throw err;
    }

    // ── Step 0: fetch for sha256 verify + pull local_path for CDP
    //           file delivery. assets[] preferred, falls back to legacy
    //           single asset. fetchAsset throws on integrity failure.
    //           B站 dynamic posts cap at 9 images. ──
    const rawAssets = Array.isArray(payload.assets) && payload.assets.length
        ? payload.assets
        : (payload.asset ? [payload.asset] : []);
    if (rawAssets.length > 9) {
        const err = new Error(`INVALID_PAYLOAD: bilibili dynamic accepts ≤ 9 images, got ${rawAssets.length}`);
        err.code = 'INVALID_PAYLOAD';
        throw err;
    }
    const localPaths = [];
    const assetsInfo = [];
    for (const a of rawAssets) {
        const blob = await fetchAsset(a);
        if (!a.local_path) {
            const err = new Error('INVALID_PAYLOAD: asset.local_path required');
            err.code = 'INVALID_PAYLOAD';
            throw err;
        }
        localPaths.push(a.local_path);
        assetsInfo.push({
            bytes: blob.size,
            mime: blob.type || a.mime || 'image/png',
            sha256_ok: true,
        });
    }
    const hasImages = localPaths.length > 0;
    const legacyAssetInfo = assetsInfo[0] || null;

    // ── Step 1: disable FSA via addScriptToEvaluateOnNewDocument BEFORE
    //           navigate. Must be in place before B站's bundle captures
    //           showOpenFilePicker references. Also enable file-chooser
    //           intercept up-front so the native OS dialog is fully
    //           suppressed — enabling it per-click has a renderer-side
    //           propagation race where the dialog flashes briefly
    //           before intercept kicks in. ──
    if (hasImages) {
        await session.addScriptOnNewDocument(FSA_DISABLE_STUB);
        await session.send('Page.setInterceptFileChooserDialog', { enabled: true });
    }

    await session.navigate(HOME_URL);

    const url = await session.getUrl();
    if (/passport\.bilibili\.com|\/login(\?|$)/.test(url)) {
        const err = new Error('AUTH_REQUIRED: B站 session expired — please log in manually');
        err.code = 'AUTH_REQUIRED';
        err.data = { asset_received: legacyAssetInfo, assets_received: assetsInfo, final_url: url };
        throw err;
    }
    const captcha = await session.detectCaptcha();
    if (captcha) {
        const err = new Error(`CAPTCHA_REQUIRED: ${captcha.selector}`);
        err.code = 'CAPTCHA_REQUIRED';
        err.data = { asset_received: legacyAssetInfo, assets_received: assetsInfo };
        throw err;
    }

    try {
        await session.waitForSelector(DRAFT_ROOT_SELECTOR, { timeoutMs: 10000 });
    } catch (e) {
        const err = new Error('AUTH_REQUIRED: compose UI not rendered — user may not be signed in');
        err.code = 'AUTH_REQUIRED';
        err.data = { asset_received: legacyAssetInfo, assets_received: assetsInfo, final_url: url };
        throw err;
    }
    await stepDwell();

    if (title) {
        await typeIntoInput(session, TITLE_SELECTOR, title.slice(0, 20));
    }

    if (caption) {
        await session.typeContentEditable(CAPTION_SELECTOR, caption);
        await sleep(300);
    }

    if (hasImages) {
        // Network diagnostic listener — captures ALL response events for
        // this tab during the upload window so we can see what request
        // B站 actually fires (URL pattern is unstable across builds, and
        // a too-narrow filter has missed the real upload endpoint).
        // Cap memory at 200 entries (well above expected traffic) and
        // skip noisy static asset MIMEs to keep the diag readable.
        await session.send('Network.enable');
        const NET_CAP = 200;
        const NOISE_MIME = /^(image\/(?!gif$).*|font\/|text\/css|application\/javascript|application\/x-javascript|application\/json;.*beacon|application\/wasm)/;
        const uploadResponses = [];
        const netListener = (src, method, params) => {
            if (src.tabId !== session.tabId) return;
            if (method !== 'Network.responseReceived') return;
            if (uploadResponses.length >= NET_CAP) return;
            const resp = params.response || {};
            const mime = resp.mimeType || '';
            // Drop pure static asset noise — but keep anything with
            // a non-2xx status, since errors are exactly what we want.
            if (NOISE_MIME.test(mime) && resp.status >= 200 && resp.status < 300) return;
            uploadResponses.push({
                url: resp.url || '',
                status: resp.status,
                request_id: params.requestId,
                mime,
                ts: Date.now(),
            });
        };
        chrome.debugger.onEvent.addListener(netListener);
        session.__uploadResponses = uploadResponses;
        try {
            await uploadImages(session, localPaths);
            await waitForUploadComplete(session, { expectedCount: localPaths.length });
        } finally {
            try { chrome.debugger.onEvent.removeListener(netListener); } catch (_) { /* noop */ }
        }
    }

    let topicNote = '';
    if (topic) {
        try {
            await pickTopic(session, topic);
            topicNote = `topic_bound:${topic}`;
        } catch (e) {
            // Detector is known-false-negative — visual bind usually
            // succeeds even when this throws. Keep the flag for UI to
            // hint "please verify in browser" without loudly reporting
            // failure.
            if (/TOPIC_NEEDS_MANUAL_CLICK/.test(e.message || '')) {
                topicNote = `topic_likely_bound:${topic}`;
            } else {
                topicNote = `topic_search_failed:${topic}:${e.message}`;
            }
        }
    }

    const publishEnabled = await isPublishEnabled(session);
    const pageTitle = await session.getTitle();

    return {
        success: true,
        message: 'B站动态草稿已填好，请在浏览器中检查后点击「发布」',
        data: {
            platform: 'bilibili',
            page_title: pageTitle,
            final_url: await session.getUrl(),
            asset_received: legacyAssetInfo,
            assets_received: assetsInfo,
            title_filled: Boolean(title),
            caption_filled: Boolean(caption),
            image_uploaded: hasImages,
            images_uploaded: localPaths.length,
            topic_note: topicNote,
            publish_button_enabled: publishEnabled,
        },
    };
}

// ── Helpers ──────────────────────────────────────────────────────────

// Fast fill for plain <input> fields (title, search query etc.) —
// execCommand('insertText') inserts the full string in one InputEvent,
// ~instant. The field in question is B站's title, which is not
// anti-bot scrutinized (unlike caption content), so we skip per-char
// humanized typing here. Caption still uses typeContentEditable.
async function typeIntoInput(session, selector, text) {
    await session.click(selector);
    await sleep(60);
    const ok = await session.evaluateFn((sel, t) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        el.focus();
        el.select && el.select();
        // Replace any existing content + insert new in one event.
        return document.execCommand('insertText', false, t);
    }, [selector, text]);
    if (!ok) {
        // Some browsers/inputs reject execCommand — fall back to the
        // humanized per-char path.
        await session.pressShortcut({ mods: ['Control'], key: 'a' });
        await session.press('Delete');
        await session.type(selector, text, { focusFirst: false });
    }
}

async function uploadImages(session, localPaths) {
    // Activate the pic tool tab if not already active.
    await session.waitForSelector(PIC_TOOL_SELECTOR, { timeoutMs: 5000 });
    const picActive = await session.evaluateFn((sel) => {
        const el = document.querySelector(sel);
        return el ? el.className.includes('active') : null;
    }, [PIC_TOOL_SELECTOR]);
    if (!picActive) {
        // Programmatic .click() rather than CDP Input.dispatchMouseEvent —
        // current B站 build does not flip the tab's `.active` class when
        // CDP-driven trusted clicks land on this Vue tab item (probable
        // ref-capture timing in their bundle). A direct el.click() runs
        // synchronously inside the Vue render frame and the active
        // toggle takes immediately. This is safe because PIC_TOOL is
        // just a tab switcher — no isTrusted gating, no file picker.
        // PIC_ADD below still uses session.click() (CDP trusted gesture)
        // because the file chooser DOES require isTrusted.
        await session.evaluateFn((sel) => {
            const el = document.querySelector(sel);
            if (el) el.click();
        }, [PIC_TOOL_SELECTOR]);
        await sleep(600);
    }

    await session.waitForVisible(PIC_ADD_SELECTOR, { timeoutMs: 8000 });

    // Two delivery paths, raced (see FSA_DISABLE_STUB comment):
    //   a. click trap — current B站 bundle clicks a DETACHED file input;
    //      the stub stashes it on window.__nephele_file_input and we set
    //      files via objectId.
    //   b. fileChooserOpened event — older bundles whose input reaches a
    //      real chooser (intercept was enabled up-front, before navigate,
    //      so the native OS dialog is fully suppressed).
    // B站's <input type="file"> has the `multiple` attribute, so a single
    // setFileInputFiles call with N paths uploads all images in one go.
    let chooserEvt = null;
    session.waitForFileChooser({ timeoutMs: 9000 })
        .then((c) => { chooserEvt = c; })
        .catch(() => { /* timeout is fine — trap path may win */ });

    // Coord click — trusted user gesture is REQUIRED. Chrome blocks
    // programmatic clicks from opening file pickers even for traditional
    // inputs unless within a user-gesture callstack. CDP's
    // Input.dispatchMouseEvent DOES confer activation; element.click()
    // does NOT.
    await session.click(PIC_ADD_SELECTOR);

    const deadline = Date.now() + 8000;
    let delivered = false;
    while (Date.now() < deadline) {
        if (chooserEvt) {
            await session.send('DOM.setFileInputFiles', {
                backendNodeId: chooserEvt.backendNodeId,
                files: localPaths,
            });
            delivered = true;
            break;
        }
        const r = await session.send('Runtime.evaluate', {
            expression: 'window.__nephele_file_input || null',
            returnByValue: false,
        });
        if (r && r.result && r.result.objectId) {
            await session.send('DOM.setFileInputFiles', {
                objectId: r.result.objectId,
                files: localPaths,
            });
            delivered = true;
            break;
        }
        await sleep(150);
    }
    if (!delivered) {
        const err = new Error(
            'TIMEOUT: neither a trapped file input nor a file chooser appeared in 8000ms',
        );
        err.code = 'TIMEOUT';
        throw err;
    }
}

async function waitForUploadComplete(session, { timeoutMs = 25000, expectedCount = 1 } = {}) {
    // Multi-image: poll until we have ≥ expectedCount visible .success
    // tiles. B站 renders one tile per image and flips each to .success
    // independently as its server-side processing completes. We wait
    // for ALL of them so the publish button gates on the full set.
    const deadline = Date.now() + timeoutMs;
    let allOk = false;
    while (Date.now() < deadline) {
        const state = await session.evaluateFn((sucSel, failSel, btnSel) => {
            const successTiles = document.querySelectorAll(sucSel);
            const failedTiles = document.querySelectorAll(failSel);
            const btn = document.querySelector(btnSel);
            const visibleCount = (nodes) => {
                let n = 0;
                for (const el of nodes) if (el.offsetParent !== null) n++;
                return n;
            };
            return {
                successCount: visibleCount(successTiles),
                failedCount: visibleCount(failedTiles),
                publishEnabled: btn
                    ? !(btn.className || '').includes('disabled')
                    : false,
            };
        }, [UPLOAD_SUCCESS_SELECTOR, UPLOAD_FAILED_SELECTOR, PUBLISH_BTN_SELECTOR]);
        if (state.failedCount > 0) {
            const failText = await session.evaluateFn((failSel) => {
                const t = document.querySelector(failSel);
                if (!t) return '';
                const msg = t.querySelector('.bili-pics-uploader-item-error__msg');
                return ((msg || t).innerText || '').trim().slice(0, 200);
            }, [UPLOAD_FAILED_SELECTOR]);
            // Pull the backend's actual rejection by fetching the body of
            // the most recent upload-related response captured by the
            // outer Network listener. B站 UI typically renders only "上传失败"
            // even when the backend returned a JSON error (rate limit,
            // banned account, mime-type mismatch, etc.) — this lifts that
            // detail into err.data.network_diag.
            const network_diag = await collectNetworkDiag(session);
            const detail = failText ? `：${failText}` : '';
            const err = new Error(
                `UPLOAD_REJECTED: B站拒绝上传图片（${state.failedCount} 张${detail}）`,
            );
            err.code = 'UPLOAD_REJECTED';
            err.data = {
                failed_count: state.failedCount,
                ui_message: failText,
                network_diag,
            };
            throw err;
        }
        if (!allOk && state.successCount >= expectedCount) allOk = true;
        if (allOk && state.publishEnabled) {
            await sleep(300);
            return;
        }
        await sleep(300);
    }
    if (!allOk) {
        const diag = await session.evaluateFn(() => {
            const all = document.querySelectorAll('.bili-pics-uploader__item');
            const tiles = [];
            all.forEach((el, i) => {
                if (i < 6) tiles.push({
                    classes: el.className,
                    visible: el.offsetParent !== null,
                });
            });
            return {
                tileCount: all.length,
                tiles,
                fsaDisabled: typeof window.showOpenFilePicker !== 'function',
                uploaderContent: (document.querySelector('.bili-pics-uploader__content')
                    || { className: null }).className,
            };
        }, []);
        const err = new Error(
            `DOM_NOT_FOUND: ${UPLOAD_SUCCESS_SELECTOR} (upload never succeeded in ${timeoutMs}ms) | diag=${JSON.stringify(diag)}`,
        );
        err.code = 'DOM_NOT_FOUND';
        err.data = { upload_diag: diag };
        throw err;
    }
}

// Bind a topic. Type-per-char into the search input, find the exact-
// name suggestion, elaborateClick to pass B站 Vue's trust gate.
//
// The bind detector at the end is known-false-negative (B站's bound
// chip renders in a DOM location the walker can't reliably match),
// but the VISUAL bind succeeds when elaborateClick's multi-step
// mouse path lands. Caller treats the throw as "likely bound" not
// "definitely failed".
async function pickTopic(session, topicName) {
    await session.evaluateFn(() => {
        const banner = document.querySelector('.bili-topic-selector__bulletin');
        if (banner) banner.style.display = 'none';
    }, []);
    await session.click(TOPIC_INPUT_SELECTOR);
    await sleep(120);

    await session.evaluateFn(() => {
        const inner = document.querySelector('.bili-topic-search__input__inner');
        const txt = document.querySelector('.bili-topic-search__input__text');
        if (inner) { inner.style.display = ''; inner.focus(); }
        if (txt) txt.style.display = 'none';
    }, []);
    await sleep(60);

    // Per-char typing — B站's autocomplete lookup listens to
    // @keydown/@keyup stream, not batched input events.
    await session.type('.bili-topic-search__input__inner', topicName, {
        focusFirst: false,
    });

    // Fixed settle — wait for B站's debounced network call to return
    // suggestions. This is the same 500ms the "10s success" version
    // used — dynamic empty-state checks added false negatives.
    await sleep(500);

    // Exact-name match (tolerates "· 80万阅读" suffix decorations).
    const target = await session.evaluateFn((clean) => {
        const items = document.querySelectorAll(
            '.bili-topic-search__result .bili-topic-item',
        );
        const nameOf = (el) => {
            const titleEl = el.querySelector(
                '.bili-topic-item__title, .bili-topic-item__name, [class*="title"], [class*="name"]',
            );
            const raw = (titleEl ? titleEl.textContent : el.textContent || '').trim();
            return raw.split('\n')[0].trim()
                .replace(/^#+|#+$/g, '')
                .split(/[·|]|\s·\s|\s{2,}/)[0].trim();
        };
        for (let i = 0; i < items.length; i++) {
            if (nameOf(items[i]) === clean) {
                const r = items[i].getBoundingClientRect();
                return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
            }
        }
        return null;
    }, [topicName]);

    if (!target) {
        throw new Error(`TOPIC_NEEDS_MANUAL_CLICK: "${topicName}" not in result list`);
    }

    // Elaborate mouse-path click — teleport-to-target click fails
    // B站's Vue trust gate, multi-step arc with timing passes it.
    // Mirrors old Playwright uploader's approach.
    await session.elaborateClick(target.cx, target.cy);
    await sleep(300);

    // Best-effort bind check — false-negative prone; caller treats
    // the throw as "likely bound, manual verify" not a hard failure.
    const deadline = Date.now() + 1200;
    while (Date.now() < deadline) {
        const bound = await session.evaluateFn((clean) => {
            const area = document.querySelector('.bili-dyn-publishing');
            if (!area) return false;
            const walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT);
            let n;
            while ((n = walker.nextNode())) {
                const t = (n.nodeValue || '').trim();
                if (!t || !t.includes(clean)) continue;
                let a = n.parentElement;
                let excluded = false;
                while (a && a !== area) {
                    const c = typeof a.className === 'string' ? a.className : '';
                    if (c.includes('bulletin') || c.includes('__result') || c.includes('__empty')) {
                        excluded = true;
                        break;
                    }
                    a = a.parentElement;
                }
                if (!excluded) return true;
            }
            return false;
        }, [topicName]);
        if (bound) return;
        await sleep(120);
    }
    throw new Error('TOPIC_NEEDS_MANUAL_CLICK');
}

// Pull bodies for upload-related responses captured by the handler's
// network listener. Used when B站 backend rejects an upload so the
// caller can see the real status + JSON error code instead of B站's
// vague "上传失败" UI. Best-effort — body fetch can fail on long-lived
// streams that closed before getResponseBody arrives; we tolerate.
async function collectNetworkDiag(session) {
    const responses = session.__uploadResponses || [];
    if (!responses.length) return { count: 0, note: 'no response captured' };
    // Show URL/status for the last 15 entries so we can spot the real
    // upload endpoint by inspection; fetch body only for responses
    // that look like an upload (anything with status != 200, OR URL
    // suggestive of upload/asset/image/picture). This keeps the diag
    // readable while still surfacing the failure signal.
    const tail = responses.slice(-15);
    const BODY_HINT = /upload|asset|create|/i;
    const out = [];
    for (const r of tail) {
        const entry = { url: r.url, status: r.status, mime: r.mime };
        const interesting = r.status >= 400
            || /upload|asset|create|image|pic|file/i.test(r.url);
        if (interesting) {
            try {
                const body = await session.send('Network.getResponseBody', {
                    requestId: r.request_id,
                });
                const raw = body.body || '';
                entry.body_preview = raw.slice(0, 600);
                if (body.base64Encoded) entry.base64 = true;
            } catch (e) {
                entry.body_fetch_error = (e && e.message) || String(e);
            }
        }
        out.push(entry);
    }
    return { count: responses.length, tail: out };
}

async function isPublishEnabled(session) {
    return await session.evaluateFn((sel) => {
        const btn = document.querySelector(sel);
        if (!btn) return false;
        return !(btn.className || '').includes('disabled');
    }, [PUBLISH_BTN_SELECTOR]);
}
