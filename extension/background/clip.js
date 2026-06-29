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
 * Payload shape (reference.clip event):
 *   { kind: 'image'|'link'|'selection'|'page',
 *     src_url, link_url, selection_text, page_url, tab_id, tab_title }
 */

const MENU_ROOT = 'nephele-clip';
const MENU_CONTEXTS = ['image', 'link', 'selection', 'page'];

function _classify(info) {
    if (info.srcUrl) return 'image';
    if (info.linkUrl) return 'link';
    if (info.selectionText) return 'selection';
    return 'page';
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
            sendClip({
                kind: _classify(info),
                src_url: info.srcUrl || '',
                link_url: info.linkUrl || '',
                selection_text: info.selectionText || '',
                page_url: info.pageUrl || tab?.url || '',
                tab_id: tab?.id ?? null,
                tab_title: tab?.title || '',
            });
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
