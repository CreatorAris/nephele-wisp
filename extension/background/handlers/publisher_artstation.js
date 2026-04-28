/*
 * ArtStation 作品上传 handler — artwork submit (v0.4).
 *
 * ArtStation is a portfolio-grade artist platform. Upload form has a
 * title, description (rich-text), tags chip input, multi-image
 * gallery, and various advanced settings (categories, software used,
 * etc). We fill the minimum: title + description + image(s) + cover.
 *
 * Strategy:
 *   1. Navigate www.artstation.com/studio/projects/new — modern
 *      submit UI. Anonymous redirects to /users/sign_in ⇒ AUTH_REQUIRED.
 *   2. File input — <input type="file" multiple accept="image/*">.
 *   3. Title — <input> with explicit name or aria-label "Title".
 *   4. Description — Quill / Trix contenteditable rich-text editor.
 *   5. Tags — best-effort chip input.
 *   6. Detect Submit/Publish enabled. NEVER click.
 */

import { sleep, stepDwell } from '../humanize.js';
import { fetchAsset } from '../asset.js';

// ArtStation has refactored their upload routing several times. We try
// known candidates in order; if none lands on a form, fall back to /
// and click the "Submit Project" / "Upload" button via text match.
// All historical static upload URLs (`/artwork/new`, `/studio/projects/new`,
// `/projects/new`) now 404 on modern ArtStation. The current entry is
// the home navbar's "+" / "Upload" / user-menu dropdown — we navigate
// to home, harvest any anchor with href containing "/projects/new" or
// matching CTA text, follow it. If that fails, dump full anchor list
// to diag for tuning.
const HOME_URLS = [
    'https://www.artstation.com/',
];

const SUBMIT_LINK_TEXT_HINTS = [
    'Submit Project', 'Submit a Project', 'New Project',
    'Upload', 'New artwork', 'Add Artwork',
];

const FILE_INPUT_CANDIDATES = [
    'input[type="file"][multiple][accept*="image"]',
    'input[type="file"][accept*="image"]',
    'input[type="file"][multiple]',
    'input[type="file"]',
];

const TITLE_CANDIDATES = [
    'input[name*="title" i]',
    'input[aria-label*="Title" i]',
    'input[placeholder*="Title" i]',
    'input.title',
];

// ArtStation uses a rich-text editor (historically Trix, now Quill).
const DESCRIPTION_CANDIDATES = [
    '.ql-editor[contenteditable="true"]',
    'trix-editor',
    'div[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    'textarea[name*="description" i]',
    'textarea[placeholder*="description" i]',
    'textarea',
];

const PUBLISH_BUTTON_TEXT_HINTS = ['Publish', 'Submit', 'Post', 'Save'];

const LOGIN_URL_RE = /\/users\/sign_in|\/login(\?|$)|\/sign-in/;
const LOGIN_TEXT_HINTS = ['Sign In', 'Email or username', 'Forgot password'];

export async function handleArtstationUploadDraft(session, payload) {
    payload = payload || {};
    const caption = payload.caption || '';
    const title = payload.title || '';
    const topic = (payload.topic || '').replace(/^#+|#+$/g, '').trim();

    const rawAssets = Array.isArray(payload.assets) && payload.assets.length
        ? payload.assets
        : (payload.asset ? [payload.asset] : []);

    if (rawAssets.length === 0) {
        const err = new Error('INVALID_PAYLOAD: ArtStation 作品必须有至少 1 张图');
        err.code = 'INVALID_PAYLOAD';
        throw err;
    }
    if (rawAssets.length > 100) {
        const err = new Error(`INVALID_PAYLOAD: ArtStation 作品 ≤ 100 张图,got ${rawAssets.length}`);
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
    const legacyAssetInfo = assetsInfo[0] || null;

    // Try each candidate URL until one resolves to a non-404 page.
    // ArtStation renders 404 in-page (URL doesn't change to /404), so
    // we check document.title for "404" rather than relying on URL.
    let url = '';
    let landedTitle = '';
    for (const u of HOME_URLS) {
        await session.navigate(u);
        url = await session.getUrl();
        landedTitle = await session.getTitle();
        if (LOGIN_URL_RE.test(url)) break;
        if (/404/.test(landedTitle)) continue;
        if (url.replace(/\/$/, '') === 'https://www.artstation.com') continue;
        break;
    }
    if (LOGIN_URL_RE.test(url)) {
        const err = new Error('AUTH_REQUIRED: ArtStation session expired — please log in manually');
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
        const err = new Error('AUTH_REQUIRED: ArtStation login wall — please log in manually');
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

    let fileSelector = await waitForFileInput(session, FILE_INPUT_CANDIDATES, 6000);
    let ctaUsed = null;

    // No file input on initial landing — find the Submit Project /
    // Upload CTA via either a known href pattern (preferred — survives
    // hidden user-menu items) or visible text.
    if (!fileSelector) {
        const cta = await findSubmitCta(session);
        if (cta) {
            ctaUsed = cta;
            if (cta.kind === 'jsclick-marker') {
                await session.evaluateFn(() => {
                    const el = document.querySelector('[data-wisp-cta="1"]');
                    if (el) el.click();
                }, []);
            } else {
                await session.elaborateClick(cta.cx, cta.cy);
            }
            // Wait for SPA route to settle. ArtStation does in-place
            // route updates (no full page reload) — give it time.
            await sleep(2000);
            fileSelector = await waitForFileInput(session, FILE_INPUT_CANDIDATES, 12000);
        }
    }

    if (!fileSelector) {
        // Check for a blocking modal/dialog FIRST. ArtStation shows a
        // one-time first-creator agreement modal that hides the upload
        // form behind it. We deliberately do NOT auto-click — the
        // user's account is at stake, and a "Continue" lookalike could
        // accept a content/payment policy change. Bail with
        // ACTION_REQUIRED so the user resolves it manually.
        const modal = await detectBlockingModal(session);
        if (modal) {
            const err = new Error(
                'ACTION_REQUIRED: ArtStation 弹窗挡在上传路径上,需要你在浏览器里点确认。' +
                ' Wisp 不会自动操作账号级弹窗 (TOS/创作者协议/付费/内容政策等)。' +
                ' 请在浏览器中处理弹窗后重试。'
            );
            err.code = 'ACTION_REQUIRED';
            err.data = {
                asset_received: legacyAssetInfo,
                assets_received: assetsInfo,
                final_url: await session.getUrl(),
                modal_diag: modal,
            };
            throw err;
        }

        const diag = await dumpPageDiag(session);
        if (looksLikeLoginGate(diag)) {
            const err = new Error('AUTH_REQUIRED: ArtStation login gate detected');
            err.code = 'AUTH_REQUIRED';
            err.data = {
                asset_received: legacyAssetInfo,
                assets_received: assetsInfo,
                final_url: await session.getUrl(),
                diag,
            };
            throw err;
        }
        // Add anchor hrefs found on landing page for tuning.
        const anchors = await session.evaluateFn(() => {
            const out = [];
            const links = document.querySelectorAll('a[href]');
            const seen = new Set();
            for (const a of links) {
                const href = a.getAttribute('href') || '';
                const text = (a.innerText || '').trim().slice(0, 30);
                const key = href + '|' + text;
                if (seen.has(key)) continue;
                seen.add(key);
                if (out.length < 60) out.push({ href, text });
            }
            return out;
        }, []);
        const err = new Error('DOM_NOT_FOUND: ArtStation file input — UI may have changed');
        err.code = 'DOM_NOT_FOUND';
        err.data = { final_url: await session.getUrl(), landed_title: landedTitle,
                      cta_attempted: ctaUsed, page_anchors: anchors, diag };
        throw err;
    }
    await stepDwell();

    const baselineImgs = await countVisibleImgs(session);

    await session.setFileInputFiles(fileSelector, localPaths);
    await waitForUploadsRendered(session, localPaths.length, { baseline: baselineImgs });

    let titleFilled = false;
    if (title) {
        titleFilled = await typeIntoFirstMatch(session, TITLE_CANDIDATES, title.slice(0, 80));
    }

    let captionFilled = false;
    if (caption) {
        const sel = await waitForAnyCandidate(session, DESCRIPTION_CANDIDATES, 6000);
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

    let topicNote = '';
    if (topic) {
        try {
            const ok = await tryAddArtstationTag(session, topic);
            topicNote = ok ? `tag_added:${topic}` : `tag_input_not_found:${topic}`;
        } catch (e) {
            topicNote = `tag_failed:${topic}:${(e && e.message) || 'unknown'}`;
        }
    }

    const publishEnabled = await isPublishEnabled(session);
    const pageTitle = await session.getTitle();

    return {
        success: true,
        message: 'ArtStation 作品草稿已填好,请在浏览器中检查后点击「Publish」',
        data: {
            platform: 'artstation',
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

// Detect a visible blocking modal/dialog without a file input behind
// it. Returns descriptor on hit, null otherwise. Used to short-circuit
// to ACTION_REQUIRED instead of auto-clicking — surfaces the modal
// (TOS, content agreement, paywall, etc.) to the user.
async function detectBlockingModal(session) {
    return await session.evaluateFn(() => {
        const isVisible = (el) => {
            if (!el || !el.offsetParent) return false;
            const r = el.getBoundingClientRect();
            return r.width > 200 && r.height > 100;
        };
        // Generous selector net — catches react-modal, MUI Dialog,
        // Bootstrap modal, custom .modal, .dialog, [role=dialog].
        const candidates = document.querySelectorAll(
            '[role="dialog"], [role="alertdialog"], ' +
            '.modal:not([style*="display: none"]), ' +
            '.dialog:not([style*="display: none"]), ' +
            '[class*="Modal"]:not([class*="ModalRoot"]), ' +
            '[class*="Dialog"]'
        );
        for (const m of candidates) {
            if (!isVisible(m)) continue;
            // If there's a file input inside, treat as the upload form
            // (sometimes wrapped in a dialog) — don't bail.
            if (m.querySelector('input[type="file"]')) continue;
            // Collect button text from inside the modal.
            const btns = [];
            m.querySelectorAll('button, a, [role="button"]').forEach((b) => {
                if (!b.offsetParent) return;
                const t = (b.innerText || '').trim();
                if (t && t.length < 60) btns.push(t);
            });
            if (btns.length === 0) continue;  // empty modal — likely loading shell
            const headlineEl = m.querySelector('h1, h2, h3, h4, [class*="title"], [class*="heading"]');
            return {
                headline: headlineEl ? (headlineEl.innerText || '').trim().slice(0, 200) : '',
                body_preview: (m.innerText || '').trim().slice(0, 400),
                buttons: btns.slice(0, 8),
                cls: (typeof m.className === 'string') ? m.className.slice(0, 80) : '',
                role: m.getAttribute('role') || '',
            };
        }
        return null;
    }, []);
}

async function findSubmitCta(session) {
    // ArtStation's "New Artwork" link is a real <a href="/community/projects/new">
    // but ALSO requires user-menu open (avatar dropdown) to make it
    // visible. We prefer clicking the visible-text anchor; fall back
    // to navigating href directly. The href-only anchor (empty text)
    // sits in the dropdown — clicking it requires the dropdown to be
    // open. Fortunately when not visible we can also click the
    // hidden anchor via JS .click() which trips the SPA router (since
    // ArtStation's React Router intercepts <a href> clicks).
    return await session.evaluateFn((hints) => {
        const HREF_PATTERNS = [
            /\/community\/projects\/new/i,
            /\/projects\/new(\?|$|\/)/i,
            /\/artwork\/new/i,
            /\/upload/i,
        ];
        const linkInfo = (a, kind) => {
            const r = a.getBoundingClientRect();
            return {
                kind,
                href: a.getAttribute('href') || '',
                text: (a.innerText || '').trim().slice(0, 40),
                cx: r.left + r.width / 2,
                cy: r.top + r.height / 2,
                visible: r.width > 0 && r.height > 0 && !!a.offsetParent,
            };
        };
        const allAnchors = Array.from(document.querySelectorAll('a[href]'));

        // Pass 1: VISIBLE anchor with href matching upload pattern. Prefer
        // visible because click coords work; SPA router will navigate.
        for (const a of allAnchors) {
            const href = a.getAttribute('href') || '';
            for (const pat of HREF_PATTERNS) {
                if (!pat.test(href)) continue;
                const info = linkInfo(a, 'click');
                if (info.visible) return info;
            }
        }
        // Pass 2: HIDDEN anchor with matching href — js .click() it.
        // ArtStation user-menu items are typically display:none until
        // dropdown opens, but SPA router-bound <a>s respond to .click()
        // even when hidden.
        for (const a of allAnchors) {
            const href = a.getAttribute('href') || '';
            for (const pat of HREF_PATTERNS) {
                if (!pat.test(href)) continue;
                // Stash a marker so the handler can find this element
                // after returning here.
                a.setAttribute('data-wisp-cta', '1');
                return { kind: 'jsclick-marker', href, text: (a.innerText || '').trim().slice(0, 40) };
            }
        }
        // Pass 3: visible button by text.
        const all = document.querySelectorAll('a, button, [role="button"]');
        for (const el of all) {
            if (!el.offsetParent) continue;
            const t = (el.innerText || '').trim();
            if (!t || t.length > 30) continue;
            for (const h of hints) {
                if (t === h || t.toLowerCase() === h.toLowerCase()) {
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    return { kind: 'click', cx: r.left + r.width / 2, cy: r.top + r.height / 2, text: t };
                }
            }
        }
        return null;
    }, [SUBMIT_LINK_TEXT_HINTS]);
}

async function tryAddArtstationTag(session, tag) {
    const selectors = [
        'input[placeholder*="Tags" i]',
        'input[placeholder*="Tag" i]',
        'input[aria-label*="Tag" i]',
        'input[name*="tag" i]',
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
    const err = new Error(
        `DOM_NOT_FOUND: ArtStation image preview not detected ` +
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
    if ((diag.file_inputs || []).length > 0) return false;
    for (const b of diag.buttons || []) {
        if (!b || !b.visible) continue;
        const t = (b.text || '').replace(/\s+/g, '');
        if (t === 'SignIn' || t === 'LogIn' || t === 'Login') return true;
    }
    for (const inp of diag.text_inputs || []) {
        if (!inp || !inp.visible) continue;
        const ph = (inp.placeholder || '').toLowerCase();
        if (ph.includes('email') || ph.includes('username') || ph.includes('password')) return true;
    }
    return false;
}

async function isPublishEnabled(session) {
    return await session.evaluateFn((hints) => {
        const buttons = document.querySelectorAll('button, [role="button"], [class*="btn"]');
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
        document.querySelectorAll('button, [role="button"]').forEach((el, i) => {
            const t = (el.innerText || '').trim();
            if (t && t.length < 18 && i < 30) out.buttons.push(describe(el));
        });
        return out;
    }, []);
}
