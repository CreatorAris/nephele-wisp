/*
 * B站 动态 upload handler — real draft flow (v0.4).
 *
 * Ports the Playwright uploader at
 * tools/publisher/uploaders/bilibili.py (main repo, kept for reference
 * during migration) to the extension-side CDP orchestrator. Steps:
 *
 *   1. Navigate t.bilibili.com. Redirect to passport.bilibili.com ⇒
 *      AUTH_REQUIRED.
 *   2. Wait for .bili-dyn-publishing to render — it hydrates after the
 *      initial load and its presence proves the user is signed in and
 *      the compose UI is ready.
 *   3. If a title is provided, fill it into .bili-dyn-publishing__title__input
 *      (B站 caps title at 20 chars).
 *   4. Fill the caption into .bili-rich-textarea__inner (contenteditable).
 *   5. Image upload — B站 uses window.showOpenFilePicker (File System
 *      Access API). We install a stub via Page.addScriptToEvaluateOnNewDocument
 *      that returns a synthetic FileSystemFileHandle backed by the bytes
 *      we fetched via the Wisp asset channel, then click the
 *      .bili-pics-uploader__add tile to trigger the picker.
 *   6. Wait for .bili-pics-uploader__item.success + publish-enabled.
 *   7. Optional topic via .bili-topic-search__input — same fragile-selector
 *      pain as the Playwright path. We type the topic text; the user
 *      finishes the binding with one click if auto-bind misses.
 *   8. Return draft_ready. The final 发布 button is NEVER clicked.
 *
 * Fatal selector drift ⇒ DOM_NOT_FOUND; B站 detection popup ⇒
 * CAPTCHA_REQUIRED. Both leave the tab open with useful state for the
 * user.
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

// Install-on-new-document stub. Runs BEFORE B站's page scripts so the
// FSA API override is in place by the time B站's Vue components query
// window.showOpenFilePicker. The stub reads a pending-file descriptor
// from a page global that we set via Runtime.evaluate just before
// triggering the picker click.
const PICKER_STUB = `
(function () {
    if (window.__nephele_picker_installed) return;
    window.__nephele_picker_installed = true;
    const originalPicker = window.showOpenFilePicker;
    window.showOpenFilePicker = async function (opts) {
        const pending = window.__nephele_pending_file;
        if (!pending) {
            if (originalPicker) return originalPicker.call(this, opts);
            throw new Error('No pending file for showOpenFilePicker');
        }
        window.__nephele_pending_file = null;
        const { b64, name, mime } = pending;
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const file = new File([bytes], name, { type: mime });
        return [{
            kind: 'file',
            name: name,
            getFile: async () => file,
            queryPermission: async () => 'granted',
            requestPermission: async () => 'granted',
        }];
    };
})();
`;

// Convert a Blob to base64 — no FileReader in MV3 service worker,
// so buffer → btoa(chunked).
async function blobToBase64(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < buf.length; i += CHUNK) {
        const slice = buf.subarray(i, Math.min(i + CHUNK, buf.length));
        binary += String.fromCharCode.apply(null, slice);
    }
    return btoa(binary);
}

function extForMime(mime) {
    if (!mime) return 'png';
    const m = mime.toLowerCase();
    if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
    if (m.includes('png')) return 'png';
    if (m.includes('gif')) return 'gif';
    if (m.includes('webp')) return 'webp';
    return 'png';
}

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

    // ── Step 0: fetch the asset before any page interaction so a bad
    //           token fails fast with no side effects on the page. ──
    let pendingFile = null;
    let assetInfo = null;
    if (payload.asset) {
        const blob = await fetchAsset(payload.asset);
        const b64 = await blobToBase64(blob);
        const ext = extForMime(blob.type || payload.asset.mime);
        pendingFile = {
            b64,
            name: payload.asset.name || `nephele_upload.${ext}`,
            mime: blob.type || payload.asset.mime || 'image/png',
        };
        assetInfo = { bytes: blob.size, mime: pendingFile.mime, sha256_ok: true };
    }

    // ── Step 1: install the showOpenFilePicker stub on next navigation,
    //           then navigate. Order matters — Page.addScriptToEvaluateOnNewDocument
    //           applies to loads after it's installed. ──
    if (pendingFile) {
        await session.addScriptOnNewDocument(PICKER_STUB);
    }
    await session.navigate(HOME_URL);

    // ── Step 2: auth / captcha gates ──
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

    // ── Step 3: wait for compose UI. If it never renders within the
    //           timeout, the user is likely logged out (same UX surface
    //           but the compose widget is behind login). We treat that
    //           as AUTH_REQUIRED rather than DOM_NOT_FOUND. ──
    try {
        await session.waitForSelector(DRAFT_ROOT_SELECTOR, { timeoutMs: 10000 });
    } catch (e) {
        const err = new Error('AUTH_REQUIRED: compose UI not rendered — user may not be signed in');
        err.code = 'AUTH_REQUIRED';
        err.data = { asset_received: assetInfo, final_url: url };
        throw err;
    }
    await stepDwell();

    // ── Step 4: title ──
    if (title) {
        await typeIntoInput(session, TITLE_SELECTOR, title.slice(0, 20));
    }

    // ── Step 5: caption ──
    if (caption) {
        await session.typeContentEditable(CAPTION_SELECTOR, caption);
        await sleep(300);
    }

    // ── Step 6: image ──
    if (pendingFile) {
        await uploadImage(session, pendingFile);
        await waitForUploadComplete(session);
    }

    // ── Step 7: topic (optional, best-effort) ──
    let topicNote = '';
    if (topic) {
        try {
            await pickTopic(session, topic);
            topicNote = `topic_bound:${topic}`;
        } catch (e) {
            topicNote = `topic_manual_followup:${topic}:${e.message}`;
        }
    }

    // ── Step 8: enabled check + return ──
    const publishEnabled = await isPublishEnabled(session);
    const pageTitle = await session.getTitle();

    return {
        success: true,
        message: `B站动态草稿已填好，请在浏览器中检查后点击「发布」`,
        data: {
            platform: 'bilibili',
            page_title: pageTitle,
            final_url: await session.getUrl(),
            asset_received: assetInfo,
            title_filled: Boolean(title),
            caption_filled: Boolean(caption),
            image_uploaded: Boolean(pendingFile),
            topic_note: topicNote,
            publish_button_enabled: publishEnabled,
        },
    };
}

// ── Helpers ──────────────────────────────────────────────────────────

// Standard <input> typing — focus, select-all, delete, type. Used for
// the title input; the caption uses typeContentEditable.
async function typeIntoInput(session, selector, text) {
    await preActionDelay();
    await session.click(selector);
    await sleep(100);
    await session.pressShortcut({ mods: ['Control'], key: 'a' });
    await sleep(80);
    await session.press('Delete');
    await sleep(100);
    await session.type(selector, text, { focusFirst: false });
}

async function uploadImage(session, pendingFile) {
    // Activate the pic tool tab if not already active. B站 renders the
    // uploader only once the pic tool is selected.
    const picActive = await session.evaluateFn((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        return el.className.includes('active');
    }, [PIC_TOOL_SELECTOR]);
    if (picActive === null) {
        throw new Error(`DOM_NOT_FOUND: ${PIC_TOOL_SELECTOR}`);
    }
    if (!picActive) {
        await session.click(PIC_TOOL_SELECTOR);
        await sleep(500);
    }

    await session.waitForSelector(PIC_ADD_SELECTOR, { timeoutMs: 5000 });

    // Stash the pending file on the page before clicking the add tile.
    // The stub registered via addScriptOnNewDocument is already patched
    // into window.showOpenFilePicker — it consumes this global on call.
    await session.evaluateFn((file) => {
        window.__nephele_pending_file = file;
    }, [pendingFile]);

    // Click the + tile. B站's Vue handler invokes showOpenFilePicker,
    // which our stub handles synchronously with the stashed bytes.
    await session.click(PIC_ADD_SELECTOR);
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
        throw new Error(
            `DOM_NOT_FOUND: ${UPLOAD_SUCCESS_SELECTOR} (upload never succeeded in ${timeoutMs}ms)`,
        );
    }
    // Image ok but publish never enabled — still return; caller reports
    // publish_button_enabled: false in the data so the user knows.
}

// Topic binding mirrors the Playwright path: B站's Vue handler gates
// binding on browser-trust signals that synthesized input doesn't
// always satisfy. Best-effort — if the mouse click doesn't bind, we
// throw; the caller surfaces a "please click the topic manually" note.
async function pickTopic(session, topicName) {
    // Dismiss the marketing bulletin (it intercepts clicks on the input)
    // and dispatch a click sequence on the input wrapper.
    await session.evaluateFn(() => {
        const banner = document.querySelector('.bili-topic-selector__bulletin');
        if (banner) banner.style.display = 'none';
    }, []);
    await sleep(150);
    await session.click(TOPIC_INPUT_SELECTOR);
    await sleep(400);

    // Force the hidden input visible if the click didn't reveal it —
    // some Vue versions gate display on focus state we can't reach.
    await session.evaluateFn(() => {
        const inner = document.querySelector('.bili-topic-search__input__inner');
        const txt = document.querySelector('.bili-topic-search__input__text');
        if (inner) { inner.style.display = ''; inner.focus(); }
        if (txt) txt.style.display = 'none';
    }, []);
    await sleep(200);

    // Type into the inner input using per-key dispatch so Vue's debounce
    // fires the suggestion lookup.
    await session.type('.bili-topic-search__input__inner', topicName, {
        focusFirst: false,
    });
    await sleep(1200);

    // Wait up to 5s for results or empty state.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const vis = await session.evaluateFn(() => {
            const r = document.querySelector('.bili-topic-search__result');
            const e = document.querySelector('.bili-topic-search__empty');
            const cs = (el) => el && window.getComputedStyle(el);
            const rv = cs(r);
            const ev = cs(e);
            return {
                resultVisible: !!rv && rv.display !== 'none' && rv.visibility !== 'hidden',
                emptyVisible: !!ev && ev.display !== 'none' && ev.visibility !== 'hidden',
            };
        }, []);
        if (vis.emptyVisible) {
            throw new Error(`B站未找到话题「${topicName}」`);
        }
        if (vis.resultVisible) break;
        await sleep(300);
    }

    // Pick the first exact-name match.
    const target = await session.evaluateFn((clean) => {
        const items = document.querySelectorAll(
            '.bili-topic-search__result .bili-topic-item',
        );
        for (let i = 0; i < items.length; i++) {
            const txt = (items[i].textContent || '').split('\n')[0].trim();
            if (txt === clean) {
                const r = items[i].getBoundingClientRect();
                return {
                    idx: i,
                    cx: r.left + r.width / 2,
                    cy: r.top + r.height / 2,
                    w: r.width, h: r.height,
                    x: r.left, y: r.top,
                };
            }
        }
        return null;
    }, [topicName]);

    if (!target) {
        throw new Error('TOPIC_NEEDS_MANUAL_CLICK: no exact-name match in results');
    }

    // Humanized click via raw CDP input (session.click takes a selector,
    // not coordinates, and these items are selected by index in a list
    // that doesn't have stable distinguishing attributes).
    await preActionDelay();
    await session.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: target.cx, y: target.cy,
    });
    await sleep(90);
    await session.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: target.cx, y: target.cy,
        button: 'left', clickCount: 1,
    });
    await sleep(50);
    await session.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: target.cx, y: target.cy,
        button: 'left', clickCount: 1,
    });
    await sleep(600);

    const bound = await session.evaluateFn((clean) => {
        const area = document.querySelector('.bili-dyn-publishing__topic');
        if (!area) return false;
        const w = document.createTreeWalker(area, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
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

    if (!bound) {
        throw new Error('TOPIC_NEEDS_MANUAL_CLICK');
    }
}

async function isPublishEnabled(session) {
    return await session.evaluateFn((sel) => {
        const btn = document.querySelector(sel);
        if (!btn) return false;
        return !(btn.className || '').includes('disabled');
    }, [PUBLISH_BTN_SELECTOR]);
}
