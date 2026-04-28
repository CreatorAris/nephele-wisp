/*
 * Pixiv 插画上传 handler — illust upload (v0.4).
 *
 * Pixiv is a Japan-dominant artist platform. The upload form is the
 * richest of all platforms we support — title + caption + tags +
 * R-18/R-18G + AI flag + work type. We fill the minimum required
 * (title, caption, image) and leave the rest at defaults; the user
 * reviews and tweaks before publishing.
 *
 * Strategy:
 *   1. Navigate www.pixiv.net/illustration/create (modern upload UI).
 *      Anonymous redirects to accounts.pixiv.net/login ⇒ AUTH_REQUIRED.
 *   2. File input — Pixiv has hidden <input type="file" multiple
 *      accept="image/*">. Direct setFileInputFiles works.
 *   3. Title — <input> with placeholder containing "タイトル" (JP) or
 *      "title" (EN) — Pixiv localizes per user setting.
 *   4. Caption — single <textarea> for description.
 *   5. Tags — separate chip input. Best-effort; not always populated.
 *   6. Detect 投稿/Submit button enabled. Never click.
 */

import { sleep, stepDwell } from '../humanize.js';
import { fetchAsset } from '../asset.js';

const HOME_URL = 'https://www.pixiv.net/illustration/create';

const FILE_INPUT_CANDIDATES = [
    'input[type="file"][multiple][accept*="image"]',
    'input[type="file"][accept*="image"]',
    'input[type="file"][multiple]',
    'input[type="file"]',
];

// Title — Pixiv shows "タイトル" (JP) or "Title" (EN). Match either.
const TITLE_CANDIDATES = [
    'input[placeholder*="タイトル"]',
    'input[placeholder*="Title" i]',
    'input[name*="title" i]',
    'input[aria-label*="タイトル"]',
    'input[aria-label*="title" i]',
];

// Caption / description.
const CAPTION_CANDIDATES = [
    'textarea[placeholder*="キャプション"]',
    'textarea[placeholder*="Caption" i]',
    'textarea[placeholder*="説明"]',
    'textarea[placeholder*="description" i]',
    'textarea[name*="caption" i]',
    'textarea[name*="description" i]',
    '[contenteditable="true"][data-placeholder*="キャプション"]',
    'textarea',
];

const LOGIN_URL_RE = /accounts\.pixiv\.net|\/login(\?|$)|\/signup/;
const LOGIN_TEXT_HINTS = ['ログイン', 'pixiv ID', 'Log in', 'メールアドレス'];

const PUBLISH_BUTTON_TEXT_HINTS = ['投稿', '投稿する', 'Submit', 'Post', '公開'];

export async function handlePixivUploadDraft(session, payload) {
    payload = payload || {};
    const caption = payload.caption || '';
    const title = payload.title || '';
    const topic = (payload.topic || '').replace(/^#+|#+$/g, '').trim();

    const rawAssets = Array.isArray(payload.assets) && payload.assets.length
        ? payload.assets
        : (payload.asset ? [payload.asset] : []);

    if (rawAssets.length === 0) {
        const err = new Error('INVALID_PAYLOAD: Pixiv 插画必须有至少 1 张图');
        err.code = 'INVALID_PAYLOAD';
        throw err;
    }
    if (rawAssets.length > 200) {
        const err = new Error(`INVALID_PAYLOAD: Pixiv 多页插画 ≤ 200 页,got ${rawAssets.length}`);
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
    const legacyAssetInfo = assetsInfo[0] || null;

    await session.navigate(HOME_URL);

    const url = await session.getUrl();
    if (LOGIN_URL_RE.test(url)) {
        const err = new Error('AUTH_REQUIRED: Pixiv session expired — please log in manually');
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
        const err = new Error('AUTH_REQUIRED: Pixiv login modal visible — please log in manually');
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

    const fileSelector = await waitForFileInput(session, FILE_INPUT_CANDIDATES, 15000);
    if (!fileSelector) {
        const diag = await dumpPageDiag(session);
        if (looksLikeLoginGate(diag)) {
            const err = new Error('AUTH_REQUIRED: Pixiv login gate — please log in manually');
            err.code = 'AUTH_REQUIRED';
            err.data = {
                asset_received: legacyAssetInfo,
                assets_received: assetsInfo,
                final_url: await session.getUrl(),
                diag,
            };
            throw err;
        }
        const err = new Error('DOM_NOT_FOUND: Pixiv file input — UI may have changed');
        err.code = 'DOM_NOT_FOUND';
        err.data = { final_url: url, diag };
        throw err;
    }
    await stepDwell();

    const baselineImgs = await countVisibleImgs(session);

    await session.setFileInputFiles(fileSelector, localPaths);
    await waitForUploadsRendered(session, localPaths.length, { baseline: baselineImgs });

    let titleFilled = false;
    if (title) {
        titleFilled = await typeIntoFirstMatch(session, TITLE_CANDIDATES, title.slice(0, 32));
    }

    let captionFilled = false;
    if (caption) {
        const sel = await waitForAnyCandidate(session, CAPTION_CANDIDATES, 6000);
        if (sel) {
            const kind = await session.evaluateFn((s) => {
                const el = document.querySelector(s);
                return el ? el.tagName.toLowerCase() : null;
            }, [sel]);
            if (kind === 'textarea' || kind === 'input') {
                await fillTextarea(session, sel, caption);
            } else {
                await session.typeContentEditable(sel, caption);
            }
            captionFilled = true;
            await sleep(300);
        }
    }

    // Tags / topic — Pixiv has a separate chip input. Best-effort only,
    // since chip widgets vary; we record what we tried.
    let topicNote = '';
    if (topic) {
        try {
            const ok = await tryAddPixivTag(session, topic);
            topicNote = ok ? `tag_added:${topic}` : `tag_input_not_found:${topic}`;
        } catch (e) {
            topicNote = `tag_failed:${topic}:${(e && e.message) || 'unknown'}`;
        }
    }

    const publishEnabled = await isPublishEnabled(session);
    const pageTitle = await session.getTitle();

    return {
        success: true,
        message: 'Pixiv 插画草稿已填好,请在浏览器中检查后点击「投稿」',
        data: {
            platform: 'pixiv',
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

// ── Helpers ──────────────────────────────────────────────────────────

async function tryAddPixivTag(session, tag) {
    // Try common Pixiv tag-input shapes — input with placeholder
    // containing "タグ" (tag in JP), or aria-label match.
    const selectors = [
        'input[placeholder*="タグ"]',
        'input[placeholder*="Tag" i]',
        'input[aria-label*="タグ"]',
        'input[aria-label*="tag" i]',
    ];
    for (const sel of selectors) {
        const exists = await session.evaluateFn((s) => {
            const el = document.querySelector(s);
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        }, [sel]);
        if (!exists) continue;
        await session.click(sel);
        await sleep(80);
        await session.type(sel, tag);
        await sleep(200);
        await session.press('Enter');
        await sleep(300);
        return true;
    }
    return false;
}

async function waitForFileInput(session, candidates, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const sel of candidates) {
            const exists = await session.evaluateFn((s) => !!document.querySelector(s), [sel]);
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
    await fillTextarea(session, sel, text);
    return true;
}

async function fillTextarea(session, sel, text) {
    await session.click(sel);
    await sleep(80);
    const ok = await session.evaluateFn((s, t) => {
        const el = document.querySelector(s);
        if (!el) return false;
        el.focus();
        el.select && el.select();
        const r = document.execCommand('insertText', false, t);
        // Always nudge React's synthetic input listener.
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return r;
    }, [sel, text]);
    if (!ok) {
        await session.pressShortcut({ mods: ['Control'], key: 'a' });
        await session.press('Delete');
        await session.type(sel, text, { focusFirst: false });
    }
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

async function waitForUploadsRendered(session, expectedCount, { timeoutMs = 60000, baseline = 0 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const cur = await countVisibleImgs(session);
        if (cur >= baseline + expectedCount) {
            await sleep(500);
            return;
        }
        await sleep(500);
    }
    const after = await countVisibleImgs(session);
    const recent = await dumpRecentImages(session);
    const diag = await dumpPageDiag(session);
    const err = new Error(
        `DOM_NOT_FOUND: Pixiv image preview not detected ` +
        `(baseline=${baseline}, after=${after}, expected delta ≥ ${expectedCount}).`,
    );
    err.code = 'DOM_NOT_FOUND';
    err.data = {
        baseline_imgs: baseline, after_imgs: after,
        expected_delta: expectedCount,
        recent_images: recent,
        page_diag: diag,
    };
    throw err;
}

async function dumpRecentImages(session) {
    return await session.evaluateFn(() => {
        const out = [];
        const visible = Array.from(document.querySelectorAll('img'))
            .filter((i) => i.offsetParent);
        for (const img of visible.slice(-12)) {
            const chain = [];
            let a = img.parentElement;
            for (let i = 0; i < 5 && a; i++) {
                const cls = (typeof a.className === 'string') ? a.className : '';
                chain.push(`${a.tagName.toLowerCase()}.${cls.slice(0, 60)}`);
                a = a.parentElement;
            }
            out.push({
                src_head: (img.src || '').slice(0, 80),
                w: img.naturalWidth, h: img.naturalHeight,
                ancestors: chain,
            });
        }
        return out;
    }, []);
}

function looksLikeLoginGate(diag) {
    if (!diag) return false;
    if ((diag.contenteditables || []).length > 0) return false;
    if ((diag.file_inputs || []).length > 0) return false;
    for (const b of diag.buttons || []) {
        if (!b || !b.visible) continue;
        const t = (b.text || '').replace(/\s+/g, '');
        if (t === 'ログイン' || t === 'Login' || t === 'Login' || t === '登录') return true;
    }
    for (const inp of diag.text_inputs || []) {
        if (!inp || !inp.visible) continue;
        const ph = (inp.placeholder || '').toLowerCase();
        if (ph.includes('pixiv id') || ph.includes('mail') || ph.includes('メール')) return true;
    }
    return false;
}

async function isPublishEnabled(session) {
    return await session.evaluateFn((hints) => {
        const buttons = document.querySelectorAll('button, a[role="button"], [class*="btn"]');
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
            url: location.href, title: document.title,
            file_inputs: [], text_inputs: [], textareas: [],
            contenteditables: [], buttons: [],
        };
        document.querySelectorAll('input[type="file"]').forEach((el) => out.file_inputs.push(describe(el)));
        document.querySelectorAll('input[type="text"], input[type="email"], input:not([type])').forEach((el, i) => {
            if (i < 12) out.text_inputs.push(describe(el));
        });
        document.querySelectorAll('textarea').forEach((el, i) => {
            if (i < 8) out.textareas.push(describe(el));
        });
        document.querySelectorAll('[contenteditable="true"]').forEach((el, i) => {
            if (i < 6) out.contenteditables.push(describe(el));
        });
        document.querySelectorAll('button, a[role="button"]').forEach((el, i) => {
            const t = (el.innerText || '').trim();
            if (t && t.length < 16 && i < 30) out.buttons.push(describe(el));
        });
        return out;
    }, []);
}
