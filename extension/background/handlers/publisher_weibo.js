/*
 * 微博 图片微博 upload handler — home compose flow (v0.4).
 *
 * Strategy:
 *
 *   1. Navigate weibo.com/ — 微博 doesn't have a dedicated publisher
 *      page; the compose box lives at the top of the home timeline.
 *      Visitor pass-through redirect (passport.weibo.com) ⇒ AUTH_REQUIRED.
 *   2. File upload — 微博 has a 图片 toolbar button which opens a hidden
 *      <input type="file" multiple>. We try direct DOM.setFileInputFiles
 *      first (the input is usually present in the DOM, just visually
 *      hidden); if not present, fall back to coord-clicking the toolbar
 *      icon and intercepting the chooser.
 *   3. Caption — single contenteditable / textarea on the compose box.
 *      Topic is embedded inline as `#话题#` since 微博's autocomplete
 *      binds via inline syntax — no separate topic picker needed.
 *   4. Wait for image upload thumbnails to appear.
 *   5. Detect publish button enabled state (text "发送" / "发布").
 *      NEVER click — Wisp stops at draft_ready.
 *
 * 微博's modern frontend uses hash-based atomic CSS classes that drift
 * frequently, so this handler leans on:
 *   - placeholder + aria text for inputs
 *   - visible button text + click target geometry for buttons
 *   - liberal diag dump on DOM_NOT_FOUND so first-run failure can be
 *     debugged without another iteration.
 */

import { sleep, stepDwell } from '../humanize.js';
import { fetchAsset } from '../asset.js';

const HOME_URL = 'https://weibo.com/';

// Login / visitor wall hints.
const LOGIN_URL_RE = /passport\.weibo\.com|\/visitor\/|\/login(\?|$)/;
const LOGIN_TEXT_HINTS = ['登录后查看', '立即登录', '账号登录', '请登录'];

// Compose textarea / contenteditable candidates. 微博 has historically
// alternated between <textarea> and contenteditable across redesigns.
const COMPOSE_CANDIDATES = [
    'textarea[placeholder*="新鲜事"]',
    'textarea[placeholder*="想法"]',
    'textarea[placeholder*="分享"]',
    'div[contenteditable="true"][aria-label*="微博"]',
    '.Form_input_2gtXR',                    // legacy Vue2 hash, still present in some accounts
    'textarea',
    'div[contenteditable="true"]',
];

// File input candidates — 微博's image-button-spawned hidden input.
const FILE_INPUT_CANDIDATES = [
    'input[type="file"][multiple][accept*="image"]',
    'input[type="file"][accept*="image"]',
    'input[type="file"][multiple]',
    'input[type="file"]',
];

// Image-button text/aria hints — used when direct file input isn't
// present and we must coord-click the toolbar icon to spawn it.
const IMAGE_BUTTON_TEXT_HINTS = ['图片', '上传图片', '添加图片'];
const IMAGE_BUTTON_ARIA_HINTS = ['图片', 'photo', 'image'];

// Publish button text hints.
const PUBLISH_BUTTON_TEXT_HINTS = ['发送', '发布', '发微博'];

export async function handleWeiboUploadDraft(session, payload) {
    payload = payload || {};
    const caption = payload.caption || '';
    const topic = (payload.topic || '').replace(/^#+|#+$/g, '').trim();
    const title = payload.title || '';  // 微博 has no title — ignored, recorded for parity

    const rawAssets = Array.isArray(payload.assets) && payload.assets.length
        ? payload.assets
        : (payload.asset ? [payload.asset] : []);

    if (rawAssets.length > 9) {
        const err = new Error(`INVALID_PAYLOAD: 微博图片微博 ≤ 9 张图,got ${rawAssets.length}`);
        err.code = 'INVALID_PAYLOAD';
        throw err;
    }
    if (rawAssets.length === 0 && !caption) {
        const err = new Error('INVALID_PAYLOAD: 微博需要 caption 或至少 1 张图');
        err.code = 'INVALID_PAYLOAD';
        throw err;
    }

    // ── Step 0: fetch + verify all assets. ──
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
            mime: blob.type || a.mime || 'image/jpeg',
            sha256_ok: true,
        });
    }
    const hasImages = localPaths.length > 0;
    const legacyAssetInfo = assetsInfo[0] || null;

    // ── Step 1: enable file-chooser intercept up-front in case we have
    //           to fallback to button-click. Cheap; harmless if unused. ──
    if (hasImages) {
        await session.send('Page.setInterceptFileChooserDialog', { enabled: true });
    }

    await session.navigate(HOME_URL);

    const url = await session.getUrl();
    if (LOGIN_URL_RE.test(url)) {
        const err = new Error('AUTH_REQUIRED: 微博 session expired — please log in manually');
        err.code = 'AUTH_REQUIRED';
        err.data = {
            asset_received: legacyAssetInfo,
            assets_received: assetsInfo,
            final_url: url,
        };
        throw err;
    }
    const loginVisible = await session.evaluateFn((hints) => {
        const text = (document.body && document.body.innerText) || '';
        let hits = 0;
        for (const h of hints) if (text.includes(h)) hits++;
        return hits >= 2;
    }, [LOGIN_TEXT_HINTS]);
    if (loginVisible) {
        const err = new Error('AUTH_REQUIRED: 微博 login wall visible — please log in manually');
        err.code = 'AUTH_REQUIRED';
        err.data = {
            asset_received: legacyAssetInfo,
            assets_received: assetsInfo,
            final_url: url,
        };
        throw err;
    }

    const captcha = await session.detectCaptcha();
    if (captcha) {
        const err = new Error(`CAPTCHA_REQUIRED: ${captcha.selector}`);
        err.code = 'CAPTCHA_REQUIRED';
        err.data = { asset_received: legacyAssetInfo, assets_received: assetsInfo };
        throw err;
    }

    // ── Step 2: locate compose box. ──
    const composeSel = await waitForAnyCandidate(session, COMPOSE_CANDIDATES, 12000);
    if (!composeSel) {
        const diag = await dumpPageDiag(session);
        const err = new Error(
            'DOM_NOT_FOUND: 微博 compose textarea — UI structure may have changed.',
        );
        err.code = 'DOM_NOT_FOUND';
        err.data = { final_url: url, diag };
        throw err;
    }
    await stepDwell();

    // ── Step 3: fill caption (with inline #topic# if provided). ──
    // 微博 binds topics via inline syntax: `#话题名#` triggers their
    // autocomplete and resolves to a topic chip on send. We append the
    // topic to the caption (or use it alone if no caption provided).
    let captionFilled = false;
    let topicNote = '';
    const finalCaption = composeFinalCaption(caption, topic);
    if (finalCaption) {
        await fillCompose(session, composeSel, finalCaption);
        captionFilled = true;
        if (topic) topicNote = `topic_inline_inserted:${topic}`;
        await sleep(300);
    } else if (topic) {
        // image-only post with topic — write just the #topic# tag
        await fillCompose(session, composeSel, `#${topic}#`);
        topicNote = `topic_inline_inserted:${topic}`;
        await sleep(300);
    }

    // ── Step 4: upload images. ──
    if (hasImages) {
        // Snapshot visible img count BEFORE upload. 微博's compose box
        // sits below a timeline full of post images, so we can't rely
        // on absolute counts — only on the delta.
        const baseline = await countVisibleImgs(session);
        await uploadImages(session, localPaths);
        await waitForUploadsRendered(session, localPaths.length, { baseline });
    }

    const publishEnabled = await isPublishEnabled(session);
    const pageTitle = await session.getTitle();

    return {
        success: true,
        message: '微博草稿已填好，请在浏览器中检查后点击「发送」',
        data: {
            platform: 'weibo',
            page_title: pageTitle,
            final_url: await session.getUrl(),
            asset_received: legacyAssetInfo,
            assets_received: assetsInfo,
            title_filled: false,                 // 微博 has no title field
            title_supplied_but_unused: Boolean(title),
            caption_filled: captionFilled,
            image_uploaded: hasImages,
            images_uploaded: localPaths.length,
            topic_note: topicNote,
            publish_button_enabled: publishEnabled,
        },
    };
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function composeFinalCaption(caption, topic) {
    if (!caption) return '';
    if (!topic) return caption;
    // Avoid double-wrapping if user already included the topic.
    const tagPattern = new RegExp(`#${escapeRegExp(topic)}#`);
    if (tagPattern.test(caption)) return caption;
    return `${caption} #${topic}#`;
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function waitForAnyCandidate(session, candidates, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const sel of candidates) {
            const visible = await session.evaluateFn((s) => {
                const el = document.querySelector(s);
                if (!el) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            }, [sel]);
            if (visible) return sel;
        }
        await sleep(250);
    }
    return null;
}

async function fillCompose(session, sel, text) {
    // Detect element type — textarea uses execCommand insertText after
    // focus; contenteditable also works with execCommand.
    const kind = await session.evaluateFn((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return 'input';
        if (el.getAttribute('contenteditable') === 'true') return 'contenteditable';
        return 'unknown';
    }, [sel]);

    if (kind === 'contenteditable') {
        await session.typeContentEditable(sel, text);
        return;
    }

    // textarea / input path
    await session.click(sel);
    await sleep(100);
    await session.pressShortcut({ mods: ['Control'], key: 'a' });
    await sleep(60);
    await session.press('Delete');
    await sleep(80);
    const ok = await session.evaluateFn((s, t) => {
        const el = document.querySelector(s);
        if (!el) return false;
        el.focus();
        return document.execCommand('insertText', false, t);
    }, [sel, text]);
    if (!ok) {
        // Some textareas reject execCommand — fallback to per-key.
        await session.type(sel, text, { focusFirst: false });
    }
    // Fire input event to nudge Vue/React reactivity if execCommand
    // didn't bubble through their handler.
    await session.evaluateFn((s) => {
        const el = document.querySelector(s);
        if (el) el.dispatchEvent(new Event('input', { bubbles: true }));
    }, [sel]);
}

async function uploadImages(session, localPaths) {
    // Path A: try direct setFileInputFiles on a present <input type="file">.
    // 微博 image-button typically reveals a hidden input that's already in
    // the DOM at compose-box mount; we don't need a click first.
    const directInput = await waitForFileInputCandidate(session, 1500);
    if (directInput) {
        await session.setFileInputFiles(directInput, localPaths);
        return;
    }

    // Path B: click image-button to spawn input, intercept fileChooser.
    const btn = await findImageButton(session);
    if (!btn) {
        const diag = await dumpPageDiag(session);
        const err = new Error('DOM_NOT_FOUND: 微博 image button — toolbar selector drift');
        err.code = 'DOM_NOT_FOUND';
        err.data = { upload_diag: diag };
        throw err;
    }
    const chooserPromise = session.waitForFileChooser({ timeoutMs: 8000 });
    await session.elaborateClick(btn.cx, btn.cy);
    let chooser;
    try {
        chooser = await chooserPromise;
    } catch (e) {
        // Maybe click revealed the input instead of opening chooser —
        // try setFileInputFiles again.
        const sel = await waitForFileInputCandidate(session, 2000);
        if (sel) {
            await session.setFileInputFiles(sel, localPaths);
            return;
        }
        throw e;
    }
    await session.send('DOM.setFileInputFiles', {
        backendNodeId: chooser.backendNodeId,
        files: localPaths,
    });
}

async function waitForFileInputCandidate(session, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const sel of FILE_INPUT_CANDIDATES) {
            const exists = await session.evaluateFn((s) => !!document.querySelector(s), [sel]);
            if (exists) return sel;
        }
        await sleep(200);
    }
    return null;
}

async function findImageButton(session) {
    return await session.evaluateFn((textHints, ariaHints) => {
        const all = document.querySelectorAll('button, div[role="button"], a, span, i, [class*="icon"]');
        for (const el of all) {
            if (!el.offsetParent) continue;
            const t = (el.innerText || '').trim();
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            const title = (el.getAttribute('title') || '');
            const tested = [t, aria, title.toLowerCase()];
            let hit = false;
            for (const v of tested) {
                if (!v) continue;
                if (v.length > 12) continue;
                for (const h of textHints) {
                    if (v === h || v.includes(h)) { hit = true; break; }
                }
                if (!hit) for (const h of ariaHints) {
                    if (v.includes(h.toLowerCase())) { hit = true; break; }
                }
                if (hit) break;
            }
            if (!hit) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
        }
        return null;
    }, [IMAGE_BUTTON_TEXT_HINTS, IMAGE_BUTTON_ARIA_HINTS]);
}

async function countVisibleImgs(session) {
    return await session.evaluateFn(() => {
        let n = 0;
        for (const img of document.querySelectorAll('img')) {
            if (img.offsetParent) n++;
        }
        return n;
    }, []);
}

async function waitForUploadsRendered(session, expectedCount, { timeoutMs = 30000, baseline = 0 } = {}) {
    // Detection strategy: post-upload, 微博 inserts N new <img> previews
    // into the compose box. We wait until visible-img count grows by
    // expectedCount above the pre-upload baseline. This sidesteps
    // having to identify the right container via class hash.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const cur = await countVisibleImgs(session);
        if (cur >= baseline + expectedCount) {
            await sleep(400);  // settle
            return;
        }
        await sleep(400);
    }
    const after = await countVisibleImgs(session);
    const imgDump = await dumpRecentImages(session);
    const err = new Error(
        `DOM_NOT_FOUND: 微博 image preview not detected ` +
        `(baseline=${baseline}, after=${after}, expected delta ≥ ${expectedCount}).`,
    );
    err.code = 'DOM_NOT_FOUND';
    err.data = {
        baseline_imgs: baseline,
        after_imgs: after,
        expected_delta: expectedCount,
        recent_images: imgDump,
        page_diag: await dumpPageDiag(session),
    };
    throw err;
}

// Dump the LAST 12 visible <img> elements with their src + ancestor
// class chain. The new preview <img>s appended on upload should be
// near the end. Knowing where they actually live in the DOM lets us
// either tighten the detector or learn 微博's preview class naming.
async function dumpRecentImages(session) {
    return await session.evaluateFn(() => {
        const out = [];
        const imgs = Array.from(document.querySelectorAll('img'));
        const visible = imgs.filter((i) => i.offsetParent);
        const tail = visible.slice(-12);
        for (const img of tail) {
            const chain = [];
            let a = img.parentElement;
            for (let i = 0; i < 5 && a; i++) {
                const cls = (typeof a.className === 'string') ? a.className : '';
                chain.push(`${a.tagName.toLowerCase()}.${cls.slice(0, 60)}`);
                a = a.parentElement;
            }
            out.push({
                src_head: (img.src || '').slice(0, 80),
                alt: (img.alt || '').slice(0, 30),
                w: img.naturalWidth, h: img.naturalHeight,
                ancestors: chain,
            });
        }
        return out;
    }, []);
}

async function isPublishEnabled(session) {
    return await session.evaluateFn((hints) => {
        const buttons = document.querySelectorAll('button, div[role="button"], [class*="btn"]');
        for (const btn of buttons) {
            if (!btn.offsetParent) continue;
            const t = (btn.innerText || '').trim();
            for (const h of hints) {
                if (t === h) {
                    const cls = typeof btn.className === 'string' ? btn.className : '';
                    const disabled = cls.includes('disabled') || btn.disabled === true
                        || btn.getAttribute('aria-disabled') === 'true';
                    return !disabled;
                }
            }
        }
        return false;
    }, [PUBLISH_BUTTON_TEXT_HINTS]);
}

async function dumpPageDiag(session) {
    return await session.evaluateFn(() => {
        const visible = (el) => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        };
        const describe = (el) => ({
            tag: el.tagName.toLowerCase(),
            cls: (typeof el.className === 'string') ? el.className.slice(0, 80) : '',
            placeholder: el.getAttribute('placeholder') || '',
            aria: el.getAttribute('aria-label') || '',
            text: ((el.innerText || el.value || '').slice(0, 60)),
            visible: visible(el),
        });
        const out = {
            url: location.href,
            title: document.title,
            file_inputs: [],
            textareas: [],
            contenteditables: [],
            buttons: [],
        };
        document.querySelectorAll('input[type="file"]').forEach((el) => out.file_inputs.push(describe(el)));
        document.querySelectorAll('textarea').forEach((el, i) => {
            if (i < 8) out.textareas.push(describe(el));
        });
        document.querySelectorAll('[contenteditable="true"]').forEach((el, i) => {
            if (i < 6) out.contenteditables.push(describe(el));
        });
        document.querySelectorAll('button, div[role="button"]').forEach((el, i) => {
            const t = (el.innerText || '').trim();
            if (t && t.length < 12 && i < 30) out.buttons.push(describe(el));
        });
        return out;
    }, []);
}
