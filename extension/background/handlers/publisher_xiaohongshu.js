/*
 * 小红书 图文笔记 upload handler — image-note draft flow (v0.4).
 *
 * Strategy:
 *
 *   1. Navigate creator.xiaohongshu.com/publish/publish?target=image
 *      directly — `?target=image` skips the homepage type-chooser
 *      ("上传视频" vs "上传图文") and lands on the image-note compose UI.
 *      Redirect to passport.xiaohongshu.com or visible login modal ⇒
 *      AUTH_REQUIRED.
 *   2. File upload — 小红书 exposes a non-gated <input type="file"> in
 *      the upload zone. Direct DOM.setFileInputFiles works without any
 *      synthetic click or fileChooser dance (unlike B站). Multi-image:
 *      pass all paths in a single setFileInputFiles call (the input
 *      has `multiple`).
 *   3. Wait for upload — poll for image preview tiles to render. 小红书's
 *      DOM after successful upload shows N images in the upload area.
 *   4. Title — <input placeholder="填写标题..."> or [class*="title"] input.
 *      Direct execCommand insertText.
 *   5. Caption — single [contenteditable="true"] div (Quill-based editor).
 *      Use typeContentEditable.
 *   6. Topic (optional) — click "话题" button → type per-char → pick
 *      first suggestion. 小红书's autocomplete is debounced ~300ms.
 *   7. Detect publish button enabled state. NEVER click.
 *
 * On structural failure (DOM_NOT_FOUND), dump diag describing visible
 * file inputs / textareas / contenteditables / nearby button text so the
 * caller can surface "selector drift" and we can update without another
 * round-trip.
 */

import { sleep, stepDwell } from '../humanize.js';
import { fetchAsset } from '../asset.js';

const HOME_URL = 'https://creator.xiaohongshu.com/publish/publish?target=image';

// File input candidates. 小红书 has historically used a plain hidden
// <input type="file" multiple accept="image/*"> in the upload card; we
// also accept any image-accepting file input as a fallback.
const FILE_INPUT_CANDIDATES = [
    'input[type="file"][accept*="image"]',
    'input.upload-input',
    'input[type="file"]',
];

// Title input candidates. Order matters — prefer placeholder match over
// generic [class*="title"] which can match unrelated UI text.
const TITLE_CANDIDATES = [
    'input[placeholder*="标题"]',
    'input[placeholder*="title" i]',
    '.title input',
    '[class*="title"] input',
];

// Caption / body candidates (contenteditable Quill editor).
const CAPTION_CANDIDATES = [
    '.ql-editor[contenteditable="true"]',
    '[contenteditable="true"][data-placeholder]',
    '.editor [contenteditable="true"]',
    '[contenteditable="true"]',
];

// Topic activator — the chip/button in the toolbar that opens the topic
// picker. We resolve by visible Chinese text since the class names are
// hash-based and unstable.
const TOPIC_BUTTON_TEXT_HINTS = ['话题', '#话题'];

// Topic input (appears after activator click, sometimes in a popover).
const TOPIC_INPUT_CANDIDATES = [
    'input[placeholder*="话题"]',
    '.topic-search input',
    '[class*="topic"] input[type="text"]',
];

// Publish button text. We check enable state by looking for the cn-btn
// class with a disabled marker, or for a button with the text "发布".
const PUBLISH_BUTTON_TEXT_HINTS = ['发布', '立即发布', '确认发布'];

// Login wall hints — 小红书 redirects to passport for auth, but the
// publisher page may also render an inline login modal.
const LOGIN_URL_RE = /passport\.xiaohongshu\.com|\/login(\?|$)/;
const LOGIN_TEXT_HINTS = ['手机号', '验证码', '登录小红书', '请登录'];

export async function handleXiaohongshuUploadDraft(session, payload) {
    payload = payload || {};
    const caption = payload.caption || '';
    const title = payload.title || '';
    const topic = (payload.topic || '').replace(/^#+|#+$/g, '').trim();

    const rawAssets = Array.isArray(payload.assets) && payload.assets.length
        ? payload.assets
        : (payload.asset ? [payload.asset] : []);

    if (rawAssets.length === 0) {
        const err = new Error('INVALID_PAYLOAD: 小红书图文笔记必须有至少 1 张图');
        err.code = 'INVALID_PAYLOAD';
        throw err;
    }
    if (rawAssets.length > 18) {
        const err = new Error(`INVALID_PAYLOAD: 小红书图文笔记 ≤ 18 张图,got ${rawAssets.length}`);
        err.code = 'INVALID_PAYLOAD';
        throw err;
    }

    // ── Step 0: fetch + verify all assets, collect local_paths. ──
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
    const legacyAssetInfo = assetsInfo[0] || null;

    await session.navigate(HOME_URL);

    const url = await session.getUrl();
    if (LOGIN_URL_RE.test(url)) {
        const err = new Error('AUTH_REQUIRED: 小红书 session expired — please log in manually');
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
        // Both phone-number AND code hints visible together is the
        // canonical login modal — single hint can match unrelated copy.
        let hits = 0;
        for (const h of hints) if (text.includes(h)) hits++;
        return hits >= 2;
    }, [LOGIN_TEXT_HINTS]);
    if (loginVisible) {
        const err = new Error('AUTH_REQUIRED: 小红书 login modal visible — please log in manually');
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

    // Wait for the publisher chrome to render — we don't know one
    // canonical container selector, so probe for any of the file input
    // candidates becoming present.
    const fileSelector = await waitForFileInput(session, FILE_INPUT_CANDIDATES, 15000);
    if (!fileSelector) {
        // 小红书 anonymous landing on creator.xiaohongshu.com renders an
        // inline login panel WITHOUT a passport redirect — the page
        // shows a "登录" button + login form inputs. Detect this case
        // before declaring DOM_NOT_FOUND, since "user needs to log in"
        // is the dominant cause of the file input never appearing.
        const diag = await dumpPageDiag(session);
        if (looksLikeLoginGate(diag)) {
            const err = new Error('AUTH_REQUIRED: 小红书 anonymous landing — please log in manually');
            err.code = 'AUTH_REQUIRED';
            err.data = {
                asset_received: legacyAssetInfo,
                assets_received: assetsInfo,
                final_url: await session.getUrl(),
                diag,
            };
            throw err;
        }
        const err = new Error('DOM_NOT_FOUND: 小红书 file input — UI structure may have changed');
        err.code = 'DOM_NOT_FOUND';
        err.data = { final_url: url, diag };
        throw err;
    }
    await stepDwell();

    // ── Upload images via DOM.setFileInputFiles (no click / chooser). ──
    await session.setFileInputFiles(fileSelector, localPaths);
    await waitForUploadsRendered(session, localPaths.length);

    // ── Title (best-effort — 小红书 may have title above caption). ──
    let titleFilled = false;
    if (title) {
        titleFilled = await typeIntoFirstMatch(session, TITLE_CANDIDATES, title.slice(0, 20));
    }

    // ── Caption (contenteditable). ──
    let captionFilled = false;
    if (caption) {
        const captionSel = await waitForAnyCandidate(session, CAPTION_CANDIDATES, 8000);
        if (captionSel) {
            await session.typeContentEditable(captionSel, caption);
            captionFilled = true;
            await sleep(300);
        }
    }

    // ── Topic (best-effort, optional). ──
    let topicNote = '';
    if (topic) {
        try {
            await pickTopic(session, topic);
            topicNote = `topic_likely_bound:${topic}`;
        } catch (e) {
            topicNote = `topic_search_failed:${topic}:${(e && e.message) || 'unknown'}`;
        }
    }

    const publishEnabled = await isPublishEnabled(session);
    const pageTitle = await session.getTitle();

    return {
        success: true,
        message: '小红书图文笔记草稿已填好，请在浏览器中检查后点击「发布」',
        data: {
            platform: 'xiaohongshu',
            page_title: pageTitle,
            final_url: await session.getUrl(),
            asset_received: legacyAssetInfo,
            assets_received: assetsInfo,
            title_filled: titleFilled,
            caption_filled: captionFilled,
            image_uploaded: true,
            images_uploaded: localPaths.length,
            topic_note: topicNote,
            publish_button_enabled: publishEnabled,
        },
    };
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

async function waitForFileInput(session, candidates, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const sel of candidates) {
            const exists = await session.evaluateFn((s) => {
                return !!document.querySelector(s);
            }, [sel]);
            if (exists) return sel;
        }
        await sleep(250);
    }
    return null;
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

async function typeIntoFirstMatch(session, candidates, text) {
    const sel = await waitForAnyCandidate(session, candidates, 4000);
    if (!sel) return false;
    await session.click(sel);
    await sleep(80);
    const ok = await session.evaluateFn((s, t) => {
        const el = document.querySelector(s);
        if (!el) return false;
        el.focus();
        el.select && el.select();
        return document.execCommand('insertText', false, t);
    }, [sel, text]);
    if (!ok) {
        await session.pressShortcut({ mods: ['Control'], key: 'a' });
        await session.press('Delete');
        await session.type(sel, text, { focusFirst: false });
    }
    return true;
}

async function waitForUploadsRendered(session, expectedCount, { timeoutMs = 60000 } = {}) {
    // 小红书 renders preview thumbnails inside the upload zone after
    // each image's server-side processing completes. We poll for
    // visible <img> tags inside any container whose class hints at the
    // upload area, or for at least N image-preview-shaped elements.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const count = await session.evaluateFn(() => {
            // Heuristic: count visible <img> elements that sit inside
            // an ancestor whose class contains 'upload' or 'pic' or
            // 'image'. Excludes header/avatar imgery whose ancestor
            // chain doesn't hit those tokens.
            const imgs = document.querySelectorAll('img');
            let n = 0;
            for (const img of imgs) {
                if (!img.offsetParent) continue;
                let a = img.parentElement;
                let depth = 0;
                while (a && depth < 6) {
                    const cls = (typeof a.className === 'string') ? a.className.toLowerCase() : '';
                    if (cls.includes('upload') || cls.includes('preview') || cls.includes('img-list') || cls.includes('image-list')) {
                        n++;
                        break;
                    }
                    a = a.parentElement;
                    depth++;
                }
            }
            return n;
        }, []);
        if (count >= expectedCount) {
            await sleep(400);
            return;
        }
        await sleep(500);
    }
    // Soft fail — record diag but don't throw, since the heuristic is
    // imperfect and the user may visually confirm uploads in browser.
    const diag = await dumpPageDiag(session);
    const err = new Error(
        `DOM_NOT_FOUND: 小红书 image preview not detected (expected ${expectedCount}). ` +
        `Selector heuristic may need tuning — see data.upload_diag.`,
    );
    err.code = 'DOM_NOT_FOUND';
    err.data = { upload_diag: diag };
    throw err;
}

async function pickTopic(session, topicName) {
    // Find topic activator by visible text. 小红书 toolbar buttons are
    // typically <span> or <div> with class hash, so resolve by text.
    const activator = await session.evaluateFn((hints) => {
        const all = document.querySelectorAll('button, div, span, a');
        for (const el of all) {
            if (!el.offsetParent) continue;
            const t = (el.innerText || '').trim();
            if (!t || t.length > 6) continue;
            for (const h of hints) {
                if (t === h || t === `#${h}` || t.startsWith(h)) {
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
                }
            }
        }
        return null;
    }, [TOPIC_BUTTON_TEXT_HINTS]);
    if (!activator) {
        throw new Error('TOPIC_ACTIVATOR_NOT_FOUND');
    }
    await session.elaborateClick(activator.cx, activator.cy);
    await sleep(500);

    const inputSel = await waitForAnyCandidate(session, TOPIC_INPUT_CANDIDATES, 4000);
    if (!inputSel) {
        throw new Error('TOPIC_INPUT_NOT_FOUND');
    }

    // Per-char type — autocomplete listens to keydown stream.
    await session.type(inputSel, topicName);
    await sleep(600);

    // Pick first suggestion item that contains the topic name. 小红书's
    // suggestion list class varies; we accept anything with 'topic' or
    // 'suggest' in an ancestor's class.
    const target = await session.evaluateFn((clean) => {
        const candidates = document.querySelectorAll(
            '[class*="topic"] li, [class*="topic"] [role="option"], [class*="suggest"] li, ul[class*="dropdown"] li',
        );
        for (const el of candidates) {
            if (!el.offsetParent) continue;
            const t = (el.innerText || '').trim();
            if (!t.includes(clean)) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
        }
        return null;
    }, [topicName]);
    if (!target) {
        throw new Error('TOPIC_SUGGESTION_NOT_FOUND');
    }
    await session.elaborateClick(target.cx, target.cy);
    await sleep(400);
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

// Heuristic: does the diag look like an unauthenticated landing? 小红书
// renders inline login panel ("登录" button + phone/code text inputs)
// instead of redirecting to passport, so the URL-based check misses it.
// Trigger when any visible button/link text matches "登录" (allowing
// full-width space variants like "登 录" the page sometimes uses) AND
// the publisher's contenteditable / file input never rendered.
function looksLikeLoginGate(diag) {
    if (!diag) return false;
    if ((diag.contenteditables || []).length > 0) return false;
    if ((diag.file_inputs || []).length > 0) return false;
    const buttons = diag.buttons || [];
    for (const b of buttons) {
        if (!b || !b.visible) continue;
        const t = (b.text || '').replace(/\s+/g, '');
        if (t === '登录' || t === '登入' || t === '登录账号') return true;
    }
    return false;
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
            text: ((el.innerText || el.value || '').slice(0, 60)),
            visible: visible(el),
        });
        const out = {
            url: location.href,
            title: document.title,
            file_inputs: [],
            text_inputs: [],
            contenteditables: [],
            buttons: [],
        };
        document.querySelectorAll('input[type="file"]').forEach((el) => out.file_inputs.push(describe(el)));
        document.querySelectorAll('input[type="text"], input:not([type])').forEach((el, i) => {
            if (i < 12) out.text_inputs.push(describe(el));
        });
        document.querySelectorAll('[contenteditable="true"]').forEach((el, i) => {
            if (i < 6) out.contenteditables.push(describe(el));
        });
        document.querySelectorAll('button').forEach((el, i) => {
            const t = (el.innerText || '').trim();
            if (t && t.length < 12 && i < 30) out.buttons.push(describe(el));
        });
        return out;
    }, []);
}
