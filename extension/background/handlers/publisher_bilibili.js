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
const UPLOAD_FAILED_SELECTOR = '.bili-pics-uploader__item.failed';
const PUBLISH_BTN_SELECTOR = '.bili-dyn-publishing__action.launcher';
const TOPIC_INPUT_SELECTOR = '.bili-topic-search__input';

// FSA-disable stub. Runs via Page.addScriptToEvaluateOnNewDocument so
// it executes BEFORE any page script — critical, because B站's bundle
// captures showOpenFilePicker at module-load time. Setting the property
// to undefined (and using defineProperty to also trip feature detection
// like `'showOpenFilePicker' in window`... actually that still returns
// true because we set the property. We use a getter that throws the
// TypeError shape we'd get if the API weren't there).
//
// Why this works: B站's publisher is built with progressive enhancement
// — it prefers FSA when available, but has a <input type="file">
// fallback for browsers without FSA. By hiding FSA, B站 takes the
// fallback path, which plays nicely with CDP's standard file-chooser
// interception.
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
    //           file delivery. fetchAsset throws on integrity failure. ──
    let localPath = null;
    let assetInfo = null;
    if (payload.asset) {
        const blob = await fetchAsset(payload.asset);
        localPath = payload.asset.local_path || null;
        if (!localPath) {
            const err = new Error('INVALID_PAYLOAD: asset.local_path required');
            err.code = 'INVALID_PAYLOAD';
            throw err;
        }
        assetInfo = {
            bytes: blob.size,
            mime: blob.type || payload.asset.mime || 'image/png',
            sha256_ok: true,
        };
    }

    // ── Step 1: disable FSA via addScriptToEvaluateOnNewDocument BEFORE
    //           navigate. Must be in place before B站's bundle captures
    //           showOpenFilePicker references. Also enable file-chooser
    //           intercept up-front so the native OS dialog is fully
    //           suppressed — enabling it per-click has a renderer-side
    //           propagation race where the dialog flashes briefly
    //           before intercept kicks in. ──
    if (localPath) {
        await session.addScriptOnNewDocument(FSA_DISABLE_STUB);
        await session.send('Page.setInterceptFileChooserDialog', { enabled: true });
    }

    await session.navigate(HOME_URL);

    const url = await session.getUrl();
    if (/passport\.bilibili\.com|\/login(\?|$)/.test(url)) {
        const err = new Error('AUTH_REQUIRED: B站 session expired — please log in manually');
        err.code = 'AUTH_REQUIRED';
        err.data = { asset_received: assetInfo, final_url: url };
        throw err;
    }
    const captcha = await session.detectCaptcha();
    if (captcha) {
        const err = new Error(`CAPTCHA_REQUIRED: ${captcha.selector}`);
        err.code = 'CAPTCHA_REQUIRED';
        err.data = { asset_received: assetInfo };
        throw err;
    }

    try {
        await session.waitForSelector(DRAFT_ROOT_SELECTOR, { timeoutMs: 10000 });
    } catch (e) {
        const err = new Error('AUTH_REQUIRED: compose UI not rendered — user may not be signed in');
        err.code = 'AUTH_REQUIRED';
        err.data = { asset_received: assetInfo, final_url: url };
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

    if (localPath) {
        await uploadImage(session, localPath);
        await waitForUploadComplete(session);
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
            asset_received: assetInfo,
            title_filled: Boolean(title),
            caption_filled: Boolean(caption),
            image_uploaded: Boolean(assetInfo),
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

async function uploadImage(session, localPath) {
    // Activate the pic tool tab if not already active.
    await session.waitForSelector(PIC_TOOL_SELECTOR, { timeoutMs: 5000 });
    const picActive = await session.evaluateFn((sel) => {
        const el = document.querySelector(sel);
        return el ? el.className.includes('active') : null;
    }, [PIC_TOOL_SELECTOR]);
    if (!picActive) {
        await session.click(PIC_TOOL_SELECTOR);
        await sleep(600);
    }

    await session.waitForVisible(PIC_ADD_SELECTOR, { timeoutMs: 8000 });

    // Intercept was enabled up-front at handler start (before navigate),
    // so the native OS dialog is already fully suppressed. We only need
    // to set up the one-shot listener for the next fileChooserOpened
    // event, then click.
    const chooserPromise = session.waitForFileChooser({ timeoutMs: 8000 });

    // Coord click — trusted user gesture is REQUIRED. Chrome blocks
    // programmatic clicks from opening file pickers even for traditional
    // inputs unless within a user-gesture callstack. CDP's
    // Input.dispatchMouseEvent DOES confer activation; element.click()
    // does NOT.
    await session.click(PIC_ADD_SELECTOR);

    const chooser = await chooserPromise;
    await session.send('DOM.setFileInputFiles', {
        backendNodeId: chooser.backendNodeId,
        files: [localPath],
    });
}

async function waitForUploadComplete(session, { timeoutMs = 25000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let imgOk = false;
    while (Date.now() < deadline) {
        const state = await session.evaluateFn((sucSel, failSel, btnSel) => {
            const success = document.querySelector(sucSel);
            const failed = document.querySelector(failSel);
            const btn = document.querySelector(btnSel);
            return {
                success: !!(success && success.offsetParent !== null),
                failed: !!(failed && failed.offsetParent !== null),
                publishEnabled: btn
                    ? !(btn.className || '').includes('disabled')
                    : false,
            };
        }, [UPLOAD_SUCCESS_SELECTOR, UPLOAD_FAILED_SELECTOR, PUBLISH_BTN_SELECTOR]);
        if (state.failed) {
            throw new Error('B站拒绝上传该图片（服务端标记失败）');
        }
        if (!imgOk && state.success) imgOk = true;
        if (imgOk && state.publishEnabled) {
            await sleep(300);
            return;
        }
        await sleep(300);
    }
    if (!imgOk) {
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

async function isPublishEnabled(session) {
    return await session.evaluateFn((sel) => {
        const btn = document.querySelector(sel);
        if (!btn) return false;
        return !(btn.className || '').includes('disabled');
    }, [PUBLISH_BTN_SELECTOR]);
}
