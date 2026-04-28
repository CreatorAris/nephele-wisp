/*
 * Twitter / X 推文 upload handler — image post (v0.4).
 *
 * Twitter migrated to x.com but twitter.com still resolves. We use
 * x.com as primary. Compose box has stable data-testid attributes —
 * Twitter is the best-behaved of all platforms we support for
 * scraping/automation precisely BECAUSE accessibility/test infra is
 * exposed (a11y suite + Playwright cypress mocking community keeps
 * them stable).
 *
 * Strategy:
 *   1. Navigate x.com/compose/post — modal compose UI.
 *      Anonymous redirects to x.com/i/flow/login ⇒ AUTH_REQUIRED.
 *   2. Compose body — contenteditable with
 *      data-testid="tweetTextarea_0".
 *   3. File upload — hidden <input type="file" multiple
 *      data-testid="fileInput"> (or generic input[type="file"]).
 *   4. Detect Tweet/Post button enabled
 *      (data-testid="tweetButton" or "tweetButtonInline"). NEVER click.
 *
 * No title; topic is inline as #hashtag in the caption.
 */

import { sleep, stepDwell } from '../humanize.js';
import { fetchAsset } from '../asset.js';

const HOME_URL = 'https://x.com/compose/post';

const FILE_INPUT_CANDIDATES = [
    'input[data-testid="fileInput"]',
    'input[type="file"][accept*="image"]',
    'input[type="file"][multiple]',
    'input[type="file"]',
];

const COMPOSE_CANDIDATES = [
    'div[data-testid="tweetTextarea_0"][contenteditable="true"]',
    'div[contenteditable="true"][data-testid*="tweetTextarea"]',
    '[role="textbox"][contenteditable="true"]',
];

const PUBLISH_TESTIDS = ['tweetButton', 'tweetButtonInline'];
const PUBLISH_BUTTON_TEXT_HINTS = ['Post', 'Tweet', '发推', '发帖', 'ポスト', '投稿する'];

const LOGIN_URL_RE = /\/i\/flow\/login|\/login(\?|$)|\/account\/access/;
const LOGIN_TEXT_HINTS = ['Sign in to X', 'Sign in to Twitter', 'Phone, email', 'パスワード', '登录到 X'];

export async function handleTwitterUploadDraft(session, payload) {
    payload = payload || {};
    const caption = payload.caption || '';
    const topic = (payload.topic || '').replace(/^#+|#+$/g, '').trim();
    const title = payload.title || '';  // Twitter has no title; recorded for parity.

    const rawAssets = Array.isArray(payload.assets) && payload.assets.length
        ? payload.assets
        : (payload.asset ? [payload.asset] : []);

    if (rawAssets.length > 4) {
        const err = new Error(`INVALID_PAYLOAD: Twitter/X 单帖最多 4 张图,got ${rawAssets.length}`);
        err.code = 'INVALID_PAYLOAD';
        throw err;
    }
    if (rawAssets.length === 0 && !caption) {
        const err = new Error('INVALID_PAYLOAD: Twitter/X 需要 caption 或至少 1 张图');
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
            mime: blob.type || a.mime || 'image/jpeg',
            sha256_ok: true,
        });
    }
    const hasImages = localPaths.length > 0;
    const legacyAssetInfo = assetsInfo[0] || null;

    await session.navigate(HOME_URL);

    const url = await session.getUrl();
    if (LOGIN_URL_RE.test(url)) {
        const err = new Error('AUTH_REQUIRED: Twitter/X session expired — please log in manually');
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
        return hits >= 1;  // Twitter login text is distinctive enough that 1 hit suffices.
    }, [LOGIN_TEXT_HINTS]);

    const composeSel = await waitForAnyCandidate(session, COMPOSE_CANDIDATES, 12000);
    if (!composeSel) {
        const diag = await dumpPageDiag(session);
        if (loginVisible || looksLikeLoginGate(diag)) {
            const err = new Error('AUTH_REQUIRED: Twitter/X login wall visible');
            err.code = 'AUTH_REQUIRED';
            err.data = {
                asset_received: legacyAssetInfo,
                assets_received: assetsInfo,
                final_url: await session.getUrl(),
                diag,
            };
            throw err;
        }
        const err = new Error('DOM_NOT_FOUND: Twitter/X compose textarea — UI may have changed');
        err.code = 'DOM_NOT_FOUND';
        err.data = { final_url: url, diag };
        throw err;
    }

    const captcha = await session.detectCaptcha();
    if (captcha) {
        const err = new Error(`CAPTCHA_REQUIRED: ${captcha.selector}`);
        err.code = 'CAPTCHA_REQUIRED';
        err.data = { asset_received: legacyAssetInfo, assets_received: assetsInfo };
        throw err;
    }

    await stepDwell();

    // Compose caption (with optional inline #topic#).
    let captionFilled = false;
    let topicNote = '';
    const finalCaption = composeFinalCaption(caption, topic);
    if (finalCaption) {
        await session.typeContentEditable(composeSel, finalCaption);
        captionFilled = true;
        if (topic) topicNote = `topic_inline_inserted:${topic}`;
        await sleep(300);
    }

    // Upload images.
    if (hasImages) {
        const baselineImgs = await countVisibleImgs(session);
        const fileSel = await waitForFileInput(session, FILE_INPUT_CANDIDATES, 8000);
        if (!fileSel) {
            const diag = await dumpPageDiag(session);
            const err = new Error('DOM_NOT_FOUND: Twitter/X file input not present');
            err.code = 'DOM_NOT_FOUND';
            err.data = { diag };
            throw err;
        }
        await session.setFileInputFiles(fileSel, localPaths);
        await waitForUploadsRendered(session, localPaths.length, { baseline: baselineImgs });
    }

    const publishEnabled = await isPublishEnabled(session);
    const pageTitle = await session.getTitle();

    return {
        success: true,
        message: 'Twitter/X 推文草稿已填好,请在浏览器中检查后点击「Post」',
        data: {
            platform: 'twitter',
            page_title: pageTitle,
            final_url: await session.getUrl(),
            asset_received: legacyAssetInfo,
            assets_received: assetsInfo,
            title_filled: false,
            title_supplied_but_unused: Boolean(title),
            caption_filled: captionFilled,
            image_uploaded: hasImages,
            images_uploaded: localPaths.length,
            topic_note: topicNote,
            publish_button_enabled: publishEnabled,
        },
    };
}

// ── Helpers ──────────────────────────────────────────────────────────

function composeFinalCaption(caption, topic) {
    if (!caption && !topic) return '';
    if (!caption) return `#${topic}`;
    if (!topic) return caption;
    if (new RegExp(`#${escapeRegExp(topic)}\\b`, 'i').test(caption)) return caption;
    return `${caption} #${topic}`;
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
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const cur = await countVisibleImgs(session);
        if (cur >= baseline + expectedCount) {
            await sleep(400);
            return;
        }
        await sleep(400);
    }
    const after = await countVisibleImgs(session);
    const err = new Error(
        `DOM_NOT_FOUND: Twitter/X image preview not detected ` +
        `(baseline=${baseline}, after=${after}, expected delta ≥ ${expectedCount}).`,
    );
    err.code = 'DOM_NOT_FOUND';
    err.data = {
        baseline_imgs: baseline, after_imgs: after,
        expected_delta: expectedCount,
        page_diag: await dumpPageDiag(session),
    };
    throw err;
}

function looksLikeLoginGate(diag) {
    if (!diag) return false;
    if ((diag.contenteditables || []).length > 0) return false;
    for (const b of diag.buttons || []) {
        if (!b || !b.visible) continue;
        const t = (b.text || '').replace(/\s+/g, '');
        if (t === 'Signin' || t === 'Login' || t === 'Createaccount' || t === '登录') return true;
    }
    return false;
}

async function isPublishEnabled(session) {
    return await session.evaluateFn((testIds, hints) => {
        // Prefer testid-based detection.
        for (const tid of testIds) {
            const btn = document.querySelector(`[data-testid="${tid}"]`);
            if (btn && btn.offsetParent) {
                const disabled = btn.disabled === true
                    || btn.getAttribute('aria-disabled') === 'true';
                return !disabled;
            }
        }
        // Fallback: text match.
        const buttons = document.querySelectorAll('button, [role="button"]');
        for (const btn of buttons) {
            if (!btn.offsetParent) continue;
            const t = (btn.innerText || '').trim();
            for (const h of hints) {
                if (t === h) {
                    const disabled = btn.disabled === true
                        || btn.getAttribute('aria-disabled') === 'true'
                        || (typeof btn.className === 'string' && btn.className.toLowerCase().includes('disabled'));
                    return !disabled;
                }
            }
        }
        return false;
    }, [PUBLISH_TESTIDS, PUBLISH_BUTTON_TEXT_HINTS]);
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
            testid: el.getAttribute('data-testid') || '',
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
        document.querySelectorAll('[contenteditable="true"]').forEach((el, i) => {
            if (i < 6) out.contenteditables.push(describe(el));
        });
        document.querySelectorAll('button, [role="button"]').forEach((el, i) => {
            const t = (el.innerText || '').trim();
            if (t && t.length < 20 && i < 30) out.buttons.push(describe(el));
        });
        return out;
    }, []);
}
