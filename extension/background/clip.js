/*
 * Web-clipper entry points — the irreducible in-browser invocation surfaces.
 *
 * A clipper's *invocation points* (context menu, keyboard command) can only
 * live in the extension, so they are declared/registered here once. The actual
 * capture + save logic lives DESKTOP-SIDE: each invocation sends a thin,
 * fire-and-forget `reference.clip` event to the Nephele app, which decides what
 * to do (fetch the image full-res, save the page, etc.) and evolves via fast
 * self-update — no extension re-submission for new clip behaviour.
 *
 * The one page-read this module does — clip-time post context — is equally
 * irreducible: only at the click, in the LIVE tab (the user's real scroll
 * position), can the clicked image be tied to its enclosing feed post. The
 * in-page function reads at most that post's permalink + timestamp; all
 * interpretation stays desktop-side, and the fields are page-controlled input
 * the desktop MUST validate (docs/SECURITY.md).
 *
 * Payload shape (reference.clip event):
 *   { kind: 'image'|'link'|'selection'|'page',
 *     src_url, link_url, selection_text, page_url, tab_id, tab_title,
 *     post_url?, post_time? }   // image clips on feed pages, when locatable
 */

const MENU_ROOT = 'nephele-clip';
const MENU_CONTEXTS = ['image', 'link', 'selection', 'page'];

// Post-context collection is gated to hosts whose feed DOM we know how to
// read; everything else clips exactly as before (no page read at all).
const POST_CONTEXT_HOSTS = ['bilibili.com'];

function _classify(info) {
    if (info.srcUrl) return 'image';
    if (info.linkUrl) return 'link';
    if (info.selectionText) return 'selection';
    return 'page';
}

function _isPostContextHost(pageUrl) {
    try {
        const host = new URL(pageUrl).hostname.toLowerCase();
        return POST_CONTEXT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
    } catch (_) {
        return false;
    }
}

/**
 * Runs IN PAGE via chrome.scripting.executeScript — must stay fully
 * self-contained (no closure over module scope). Finds the clipped image by
 * its bfs content-hash identity, walks to the enclosing Bilibili dynamic
 * card, and returns { post_url, post_time }:
 *   - post_url only when the card exposes exactly ONE post id in the DOM
 *     (title-bearing opus cards; ordinary image dynamics keep their id in JS
 *     state). A repost's quoted block is preferred when it exposes ids, so
 *     the ORIGINAL post wins over the reposter's shell.
 *   - post_time is the card's `.bili-dyn-time` text, verbatim — the desktop
 *     parses it (relative/yearless forms) and treats it as untrusted input.
 * Returns null when the image / card can't be located. Read-only.
 */
function pagePostContext(srcUrl) {
    try {
        let ident = '';
        try {
            const u = new URL(srcUrl, location.href);
            if (u.pathname.includes('/bfs/')) {
                ident = (u.pathname.split('/').pop() || '').split('@')[0].toLowerCase();
            }
        } catch (_) { /* no identity → null below */ }
        if (!ident) return null;
        const img = [...document.images].find(
            (i) => (i.currentSrc || i.src || '').toLowerCase().includes(ident),
        );
        if (!img) return null;
        const card = img.closest('.bili-dyn-item');
        if (!card) return null;
        const idsIn = (scope) => {
            const ids = new Set();
            for (const a of scope.querySelectorAll('a[href]')) {
                const m = (a.href || '').match(/(?:t\.bilibili\.com|bilibili\.com\/opus)\/(\d{8,20})/);
                if (m) ids.add(m[1]);
            }
            for (const el of scope.querySelectorAll('[data-url]')) {
                const v = el.getAttribute('data-url') || '';
                if (/^\d{8,20}$/.test(v)) ids.add(v);
            }
            return ids;
        };
        // Prefer the quoted-original block of a repost when it exposes ids.
        const quote = img.closest('.bili-dyn-content__orig');
        let ids = quote ? idsIn(quote) : new Set();
        if (ids.size === 0) ids = idsIn(card);
        const t = card.querySelector('.bili-dyn-time');
        const out = {
            post_url: ids.size === 1 ? `https://www.bilibili.com/opus/${[...ids][0]}` : '',
            post_time: t ? (t.textContent || '').trim().slice(0, 40) : '',
        };
        return (out.post_url || out.post_time) ? out : null;
    } catch (_) {
        return null;
    }
}

/**
 * Collect { post_url?, post_time? } for an image clip from the live tab, or
 * null. Bounded: known hosts only, 1.5s budget, never throws — a failure
 * degrades to the plain payload (pre-context clip behaviour).
 */
async function _collectPostContext(tabId, srcUrl) {
    if (!chrome.scripting?.executeScript) return null;
    try {
        const run = chrome.scripting.executeScript({
            target: { tabId },
            func: pagePostContext,
            args: [String(srcUrl || '')],
        });
        const timeout = new Promise((resolve) => { setTimeout(() => resolve(null), 1500); });
        const results = await Promise.race([run, timeout]);
        const value = Array.isArray(results) ? results[0]?.result : null;
        if (!value || typeof value !== 'object') return null;
        const out = {};
        if (typeof value.post_url === 'string' && value.post_url) out.post_url = value.post_url.slice(0, 200);
        if (typeof value.post_time === 'string' && value.post_time) out.post_time = value.post_time.slice(0, 40);
        return (out.post_url || out.post_time) ? out : null;
    } catch (_) {
        return null;  // page gone / no injection rights (chrome://) — clip proceeds bare
    }
}

/**
 * Wire the clip surfaces. `sendClip(payload)` is a caller-supplied callback that
 * fire-and-forget delivers a reference.clip event to the desktop (returns
 * truthy on success). Listeners are registered at module top-level (every SW
 * wake); the menu itself is created in onInstalled (persists across wakes).
 */
export function installClipSurfaces(sendClip) {
    // Create the menu on install/update. removeAll first so an updated title /
    // context set replaces cleanly (create with a duplicate id throws).
    chrome.runtime.onInstalled.addListener(() => {
        try {
            chrome.contextMenus.removeAll(() => {
                void chrome.runtime.lastError;  // ignore "no menus" on first run
                chrome.contextMenus.create({
                    id: MENU_ROOT,
                    title: '保存到 Nephele',
                    contexts: MENU_CONTEXTS,
                });
            });
        } catch (_) {
            // contextMenus unavailable (permission stripped) — clip via command still works.
        }
    });

    if (chrome.contextMenus?.onClicked) {
        chrome.contextMenus.onClicked.addListener((info, tab) => {
            if (info.menuItemId !== MENU_ROOT) return;
            const payload = {
                kind: _classify(info),
                src_url: info.srcUrl || '',
                link_url: info.linkUrl || '',
                selection_text: info.selectionText || '',
                page_url: info.pageUrl || tab?.url || '',
                tab_id: tab?.id ?? null,
                tab_title: tab?.title || '',
            };
            // Image clips on known feed hosts: enrich with the enclosing
            // post's context from the LIVE tab (the only moment the clicked
            // element and the user's scroll position exist together).
            if (payload.kind === 'image' && tab?.id != null && _isPostContextHost(payload.page_url)) {
                _collectPostContext(tab.id, payload.src_url)
                    .then((ctx) => sendClip(ctx ? { ...payload, ...ctx } : payload))
                    .catch(() => sendClip(payload));
                return;
            }
            sendClip(payload);
        });
    }

    if (chrome.commands?.onCommand) {
        chrome.commands.onCommand.addListener((command, tab) => {
            if (command !== 'clip-page') return;
            sendClip({
                kind: 'page',
                src_url: '',
                link_url: '',
                selection_text: '',
                page_url: tab?.url || '',
                tab_id: tab?.id ?? null,
                tab_title: tab?.title || '',
            });
        });
    }
}
