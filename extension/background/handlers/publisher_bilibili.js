/*
 * B站 upload handler — v0.4 PoC.
 *
 * Validates the CDP orchestration path end-to-end:
 *   1. Navigate a fresh tab to B站 creator studio.
 *   2. Wait for the page to render.
 *   3. Read back the page title as proof-of-life.
 *   4. Do NOT actually upload yet — full upload flow (image drag-drop,
 *      topic picker, title/caption fill, save-draft) lands in v0.4 beta
 *      once the PoC path is proven and icons/Web Store are ready.
 *
 * The final publish button is never clicked by Wisp, ever. Upload
 * reaches "draft saved" and returns control to the user for manual
 * publish review — policy documented in docs/ROADMAP.md §Non-goals.
 */

import { stepDwell } from '../humanize.js';
import { fetchAsset } from '../asset.js';

const CREATOR_STUDIO_URL = 'https://member.bilibili.com/platform/home';

export async function handleBilibiliUploadDraft(session, payload) {
    // If the request carries an asset (image/video), fetch + verify
    // it first so we fail fast on transfer errors before spending time
    // on CDP attach + navigate.
    let assetInfo = null;
    if (payload && payload.asset) {
        const blob = await fetchAsset(payload.asset);
        assetInfo = {
            bytes: blob.size,
            mime: blob.type,
            sha256_ok: true,  // fetchAsset throws on mismatch
        };
    }

    await session.navigate(CREATOR_STUDIO_URL);

    // Creator studio may redirect to login if the user's session has
    // expired. Detect via URL match and surface AUTH_REQUIRED so the
    // UI can prompt the user to log in manually.
    const url = await session.getUrl();
    if (url.includes('passport.bilibili.com') || url.includes('login')) {
        const err = new Error('AUTH_REQUIRED: B站 session expired — please log in manually');
        err.code = 'AUTH_REQUIRED';
        err.data = { asset_received: assetInfo };
        throw err;
    }

    await stepDwell();

    const captcha = await session.detectCaptcha();
    if (captcha) {
        const err = new Error(`CAPTCHA_REQUIRED: ${captcha.selector}`);
        err.code = 'CAPTCHA_REQUIRED';
        err.data = { asset_received: assetInfo };
        throw err;
    }

    const title = await session.getTitle();

    return {
        success: true,
        message: `[v0.4 PoC] B站 creator studio navigated: "${title}"`,
        data: {
            platform: 'bilibili',
            page_title: title,
            final_url: url,
            asset_received: assetInfo,
            next: 'Full upload flow (drag image, topic, caption, save-draft) in v0.4 beta.',
        },
    };
}
