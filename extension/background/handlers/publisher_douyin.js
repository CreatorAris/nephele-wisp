/*
 * 抖音 图文 upload handler — image-post draft flow (v0.4).
 *
 * Strategy:
 *
 *   1. Navigate creator.douyin.com/creator-micro/content/upload?default-tab=3
 *      — `default-tab=3` switches to 图文 (image-text) mode directly,
 *      skipping the video-upload default. Anonymous redirects to
 *      sso.douyin.com / passport.douyin.com ⇒ AUTH_REQUIRED.
 *   2. File upload — 抖音 creator backend uses a hidden <input type="file">
 *      that's typically present in the DOM at compose mount; direct
 *      DOM.setFileInputFiles works without click.
 *   3. Title — <input placeholder="填写作品标题..."> (≤ 30 chars).
 *      execCommand insertText.
 *   4. Body — single contenteditable / textarea. typeContentEditable.
 *   5. Topic (optional) — inline `#话题#` syntax in body, similar to
 *      微博. 抖音's autocomplete picks the topic chip on send.
 *   6. Detect publish enabled. Never click.
 *
 * Selectors are best-effort first-cut — first manual run will dump
 * full diag on any DOM_NOT_FOUND for tuning.
 */

import { sleep, stepDwell } from '../humanize.js';
import { fetchAsset } from '../asset.js';

const HOME_URL = 'https://creator.douyin.com/creator-micro/content/upload?default-tab=3';

// File input candidates.
const FILE_INPUT_CANDIDATES = [
    'input[type="file"][multiple][accept*="image"]',
    'input[type="file"][accept*="image"]',
    'input[type="file"][multiple]',
    'input[type="file"]',
];

// Title input (作品标题).
const TITLE_CANDIDATES = [
    'input[placeholder*="作品标题"]',
    'input[placeholder*="标题"]',
    '[class*="title"] input',
];

// Body / description (正文).
const BODY_CANDIDATES = [
    '.zone-container[contenteditable="true"]',
    '[contenteditable="true"][data-placeholder*="作品"]',
    '[contenteditable="true"][placeholder*="作品"]',
    'textarea[placeholder*="作品"]',
    '[contenteditable="true"]',
    'textarea',
];

// Login wall hints — 抖音 redirects to sso.douyin.com or passport.
const LOGIN_URL_RE = /sso\.douyin\.com|passport\.douyin\.com|\/login(\?|$)/;
const LOGIN_TEXT_HINTS = ['手机号登录', '验证码登录', '扫码登录', '请登录'];

const PUBLISH_BUTTON_TEXT_HINTS = ['发布', '发表', '立即发布'];

export async function handleDouyinUploadDraft(session, payload) {
    payload = payload || {};
    const caption = payload.caption || '';
    const title = payload.title || '';
    const topic = (payload.topic || '').replace(/^#+|#+$/g, '').trim();

    const rawAssets = Array.isArray(payload.assets) && payload.assets.length
        ? payload.assets
        : (payload.asset ? [payload.asset] : []);

    if (rawAssets.length === 0) {
        const err = new Error('INVALID_PAYLOAD: 抖音图文必须有至少 1 张图');
        err.code = 'INVALID_PAYLOAD';
        throw err;
    }
    if (rawAssets.length > 35) {
        // 抖音图文 cap is 35 images per post (current as of 2025+).
        const err = new Error(`INVALID_PAYLOAD: 抖音图文 ≤ 35 张图,got ${rawAssets.length}`);
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
        const err = new Error('AUTH_REQUIRED: 抖音 session expired — please log in manually');
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
        const err = new Error('AUTH_REQUIRED: 抖音 login wall visible — please log in manually');
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
            const err = new Error('AUTH_REQUIRED: 抖音 login gate — please log in manually');
            err.code = 'AUTH_REQUIRED';
            err.data = {
                asset_received: legacyAssetInfo,
                assets_received: assetsInfo,
                final_url: await session.getUrl(),
                diag,
            };
            throw err;
        }
        const err = new Error('DOM_NOT_FOUND: 抖音 file input — UI structure may have changed');
        err.code = 'DOM_NOT_FOUND';
        err.data = { final_url: url, diag };
        throw err;
    }
    await stepDwell();

    // Snapshot baseline visible img count so we can detect previews via
    // delta (抖音 creator backend uses styled-components hash classes,
    // class-based container detection is brittle).
    const baselineImgs = await countVisibleImgs(session);

    // ── Upload images. ──
    await session.setFileInputFiles(fileSelector, localPaths);
    await waitForUploadsRendered(session, localPaths.length, { baseline: baselineImgs });

    // ── Title (best-effort — 抖音 图文 has a title field). ──
    let titleFilled = false;
    if (title) {
        titleFilled = await typeIntoFirstMatch(session, TITLE_CANDIDATES, title.slice(0, 30));
    }

    // ── Body (with inline #topic# if provided). ──
    let bodyFilled = false;
    let topicNote = '';
    const finalBody = composeFinalBody(caption, topic);
    if (finalBody) {
        const bodySel = await waitForAnyCandidate(session, BODY_CANDIDATES, 8000);
        if (bodySel) {
            await session.typeContentEditable(bodySel, finalBody);
            bodyFilled = true;
            if (topic) topicNote = `topic_inline_inserted:${topic}`;
            await sleep(300);
        }
    }

    const publishEnabled = await isPublishEnabled(session);
    const pageTitle = await session.getTitle();

    return {
        success: true,
        message: '抖音图文草稿已填好，请在浏览器中检查后点击「发布」',
        data: {
            platform: 'douyin',
            page_title: pageTitle,
            final_url: await session.getUrl(),
            asset_received: legacyAssetInfo,
            assets_received: assetsInfo,
            title_filled: titleFilled,
            caption_filled: bodyFilled,
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

function composeFinalBody(caption, topic) {
    if (!caption && !topic) return '';
    if (!caption) return `#${topic}#`;
    if (!topic) return caption;
    const tagPattern = new RegExp(`#${escapeRegExp(topic)}#`);
    if (tagPattern.test(caption)) return caption;
    return `${caption} #${topic}#`;
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    // 抖音 image processing on creator backend is server-side
    // (transcoding for 图文 carousel), can take 10-30s per image.
    // Allow generous timeout. Detect via baseline-diff like 微博.
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
        `DOM_NOT_FOUND: 抖音 image preview not detected ` +
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
    // Button text match (when 抖音 renders a "登录" CTA explicitly).
    for (const b of diag.buttons || []) {
        if (!b || !b.visible) continue;
        const t = (b.text || '').replace(/\s+/g, '');
        if (t === '登录' || t === '登入' || t === '手机号登录' || t === '扫码登录') return true;
    }
    // Input aria/placeholder match — 抖音 renders an embedded login
    // form on the publisher URL with country selector aria="国家/地区"
    // and phone-number input. No publisher would have both.
    for (const inp of diag.text_inputs || []) {
        if (!inp || !inp.visible) continue;
        const aria = (inp.aria || '').replace(/\s+/g, '');
        const ph = (inp.placeholder || '').replace(/\s+/g, '');
        if (aria === '国家/地区' || aria === '手机号' || aria === '验证码') return true;
        if (ph === '手机号' || ph === '验证码') return true;
    }
    return false;
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
            text_inputs: [],
            textareas: [],
            contenteditables: [],
            buttons: [],
        };
        document.querySelectorAll('input[type="file"]').forEach((el) => out.file_inputs.push(describe(el)));
        document.querySelectorAll('input[type="text"], input:not([type])').forEach((el, i) => {
            if (i < 12) out.text_inputs.push(describe(el));
        });
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
