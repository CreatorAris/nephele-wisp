/*
 * Whole-board harvest (Pinterest 采集板 / 花瓣画板 / any grid-paged feed).
 *
 * Distinct from reference_pinterest.js / reference_huaban.js, which scrape a
 * SEARCH page to a fixed cap: this one walks ONE board the user names, to the
 * bottom, however many pins that is. It returns metadata only — no image bytes
 * — so an unbounded board never approaches the Native Messaging 1 MB frame
 * cap. The desktop turns each item into full-res candidates and pulls the
 * bytes through the existing reference.fetch_full → HTTP ingest channel.
 *
 * Selectors are NOT baked in here. The desktop sends the rule with the
 * request (core/browser/board_rules.py), so a site DOM change ships in a
 * desktop self-update instead of an extension store re-submission — the same
 * contract reference.fetch_full already uses for its `candidates`.
 *
 * Streaming: items go back as `reference.board_progress` events in batches as
 * they are found, and the final response carries only counts. Events ride the
 * same ordered socket as the response, so the desktop assembles the full list
 * from the events it has already received by the time the response lands.
 *
 * Stopping (a board has no "total" to count down):
 *   - `stop` selector appears — the marker that the board's own grid ended and
 *     the site started padding with recommendations (huaban does this).
 *   - No new item for `idle_ms` (extended while a `spinner` is visible, so a
 *     slow-loading page is not mistaken for the bottom).
 *   - The tab navigated off the board (user took the tab, or a redirect).
 *   - The desktop asked to stop (reference.board_stop).
 *   - Safety ceilings: HARD_CEILING items, MAX_RUN_MS wall clock. Both are
 *     backstops against an infinite feed, not the intended exit.
 */
import { withCdpTab } from '../cdp.js';
import { sleep } from '../humanize.js';

const DEFAULT_IDLE_MS = 12_000;
const SPINNER_IDLE_MS = 30_000;
const DEFAULT_GRID_TIMEOUT_MS = 20_000;
const ROUND_PAUSE_MS = 450;
const EMIT_BATCH = 40;
// The size cap alone makes the desktop counter jump +40 at a time; the age
// cap keeps it ticking on slow boards. Whichever fills first flushes.
const EMIT_MAX_AGE_MS = 500;
// Backstops, not the exit condition. A board of 5000 pins is already past
// anything a person curates by hand, and 20 minutes is longer than any real
// board takes to walk — both exist so a bottomless feed (pinterest home) can
// not spin forever if it is ever pointed at one.
const HARD_CEILING = 5000;
const MAX_RUN_MS = 20 * 60_000;

// Harvests the desktop has asked to stop. Keyed by harvest_id, which the
// desktop generates; a stop for an unknown id is remembered for a short while
// so a stop that races ahead of the start still lands.
const _cancelled = new Set();
const _active = new Set();

/**
 * reference.board_stop — cooperative cancel. Returns immediately; the running
 * harvest notices at its next round boundary and finishes normally (the
 * desktop keeps everything already collected).
 */
export async function stopBoardHarvest(payload) {
    const id = String(payload?.harvest_id || '').trim();
    if (!id) {
        const err = new Error('INVALID_PAYLOAD: harvest_id is required');
        err.code = 'INVALID_PAYLOAD';
        throw err;
    }
    const running = _active.has(id);
    _cancelled.add(id);
    if (!running) {
        // Stop arrived before start (or after it finished) — drop the flag
        // after a grace window so it can not cancel an unrelated later run.
        setTimeout(() => _cancelled.delete(id), 30_000);
    }
    return { ok: true, running };
}

/**
 * Runs IN PAGE. Must stay self-contained — no closure over module scope.
 * Returns every currently-matching cell; cross-round de-duplication happens
 * SW-side, because virtualized grids recycle the same DOM nodes for new pins
 * and any in-page "already seen" marking would skip the recycled ones.
 */
function pageCollect(imageSel, linkSel, boxSel, excludeSel, ignoreAlt) {
    function srcOf(el) {
        if (el.tagName === 'IMG') return el.currentSrc || el.src || '';
        // Background-image cells (xiaohongshu-style covers).
        const bg = getComputedStyle(el).backgroundImage || '';
        const m = bg.match(/url\(["']?(.*?)["']?\)/);
        return m ? m[1] : '';
    }

    const out = [];
    for (const el of document.querySelectorAll(imageSel)) {
        // Eagle expresses "not inside the recommendations block" as a CSS
        // :not() on an exact Chinese attribute value — which their own build
        // mangled, so it never matches and the block gets saved as part of the
        // board. A closest() test is both correct and immune to the copy.
        if (excludeSel && el.closest(excludeSel)) continue;
        const src = srcOf(el);
        if (!src || src.startsWith('data:')) continue;

        const box = boxSel ? el.closest(boxSel) : null;
        let pageUrl = '';
        const link = (linkSel && (box || document).querySelector(linkSel))
            || el.closest('a[href]');
        if (link && link.getAttribute('href')) {
            try { pageUrl = new URL(link.getAttribute('href'), location.origin).href; } catch (_) { /* keep '' */ }
        }
        // Pin id: the stable identity across CDN size variants, so a grid that
        // re-serves 236x then 564x for the same pin de-dupes to one item.
        let pinId = '';
        const idm = pageUrl.match(/\/(?:pin|pins)\/(\d+)/);
        if (idm) pinId = idm[1];
        if (!pinId && box) pinId = box.getAttribute('data-pin-id') || box.getAttribute('data-grid-item') || '';

        let alt = '';
        if (!ignoreAlt) {
            alt = (el.getAttribute('alt') || '').trim();
            if (!alt && box) alt = (box.innerText || '').trim().slice(0, 120);
        }

        out.push({
            url: src,
            page_url: pageUrl,
            pin_id: String(pinId || ''),
            alt,
            width: el.naturalWidth || el.width || 0,
            height: el.naturalHeight || el.height || 0,
        });
    }
    return out;
}

/**
 * @param {Object} payload
 * @param {string} payload.url            Board URL (required).
 * @param {string} payload.harvest_id     Cancel handle (required).
 * @param {Object} payload.rules          Desktop-canonical selectors (required).
 * @param {number} [payload.max_items]    0 / absent = to the bottom.
 * @param {number} [payload.idle_ms]      Quiet window that means "bottom".
 * @param {Function} emit                 (type, payload) → boolean, injected by the SW.
 */
export async function harvestBoard(payload, emit) {
    const url = String(payload?.url || '').trim();
    const harvestId = String(payload?.harvest_id || '').trim();
    const rules = payload?.rules || {};
    if (!/^https?:\/\//i.test(url) || !harvestId || !rules.image) {
        const err = new Error('INVALID_PAYLOAD: url, harvest_id and rules.image are required');
        err.code = 'INVALID_PAYLOAD';
        throw err;
    }
    const maxItems = Math.max(0, parseInt(payload?.max_items, 10) || 0) || HARD_CEILING;
    const idleMs = Math.max(3_000, parseInt(payload?.idle_ms, 10) || DEFAULT_IDLE_MS);

    _active.add(harvestId);
    try {
        return await withCdpTab(url, async (session) => {
            // 1. Wait for the board's own grid. A board that never renders is
            //    reported as DOM_NOT_FOUND with the page title attached — the
            //    branch a login wall or a selector drift lands in, and the
            //    title is what tells those two apart afterwards.
            try {
                await session.waitForAnySelector([rules.image], {
                    timeoutMs: DEFAULT_GRID_TIMEOUT_MS,
                    pollMs: 400,
                    framePump: true,
                });
            } catch (_) {
                const finalUrl = await session.getUrl();
                let title = '';
                try { title = await session.evaluateFn(() => document.title || ''); } catch (_) { /* mid-nav */ }
                const err = new Error(
                    `DOM_NOT_FOUND: board grid never rendered (title=${JSON.stringify(title)})`,
                );
                err.code = 'DOM_NOT_FOUND';
                err.data = { final_url: finalUrl, page_title: title };
                throw err;
            }

            const boardTitle = await session.evaluateFn((titleSel) => {
                const el = titleSel ? document.querySelector(titleSel) : null;
                const t = (el && el.innerText || '').trim();
                return t || (document.title || '').trim();
            }, [rules.title || 'h1']);

            const startUrl = await session.getUrl();
            const startedAt = Date.now();
            const seen = new Set();
            let pending = [];
            let total = 0;
            let lastNewAt = Date.now();
            let stoppedBy = '';

            let lastEmitAt = Date.now();
            const flush = (force) => {
                if (!pending.length) return;
                if (!force && pending.length < EMIT_BATCH
                    && Date.now() - lastEmitAt < EMIT_MAX_AGE_MS) return;
                emit('reference.board_progress', {
                    harvest_id: harvestId,
                    items: pending,
                    total,
                    board_title: boardTitle,
                });
                pending = [];
                lastEmitAt = Date.now();
            };

            while (!stoppedBy) {
                if (_cancelled.has(harvestId)) { stoppedBy = 'cancelled'; break; }

                let found = [];
                try {
                    found = await session.evaluateFn(pageCollect, [
                        rules.image,
                        rules.link || '',
                        rules.box || '',
                        rules.exclude_ancestor || '',
                        !!rules.ignore_alt,
                    ]) || [];
                } catch (_) {
                    // Context died mid-evaluate (navigation / renderer swap).
                    // The URL check below decides whether that is the end.
                    found = [];
                }

                for (const item of found) {
                    const key = item.pin_id || item.url;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    total += 1;
                    lastNewAt = Date.now();
                    pending.push(item);
                    if (total >= maxItems) break;
                }
                flush(false);

                if (total >= maxItems) { stoppedBy = maxItems === HARD_CEILING ? 'ceiling' : 'max_items'; break; }
                if (Date.now() - startedAt > MAX_RUN_MS) { stoppedBy = 'time_limit'; break; }

                // The site started padding past the board's own content
                // (huaban appends a recommendations block once the board ends).
                // Guarded on total: a stop marker that is somehow present from
                // the first frame (selector drift, or a board whose own grid
                // carries the marker attribute) would otherwise end the run
                // with zero items and look like an empty board.
                if (rules.stop && total > 0) {
                    const hit = await session.evaluateFn(
                        (sel) => !!document.querySelector(sel), [rules.stop],
                    ).catch(() => false);
                    if (hit) { stoppedBy = 'stop_marker'; break; }
                }
                // The tab is no longer on the board — a redirect, or the user
                // navigated the tab we borrowed. Either way this run is over.
                const nowUrl = await session.getUrl().catch(() => '');
                if (nowUrl && nowUrl !== startUrl && !_sameBoard(nowUrl, startUrl)) {
                    stoppedBy = 'navigated_away';
                    break;
                }

                // Quiet long enough to call it the bottom — but a visible
                // spinner means the page is still fetching, so the window
                // stretches rather than declaring an early bottom.
                let spinning = false;
                if (rules.spinner) {
                    spinning = await session.evaluateFn((sel) => {
                        const el = document.querySelector(sel);
                        if (!el) return false;
                        const r = el.getBoundingClientRect();
                        return r.width > 0 && r.height > 0;
                    }, [rules.spinner]).catch(() => false);
                }
                if (Date.now() - lastNewAt > (spinning ? SPINNER_IDLE_MS : idleMs)) {
                    stoppedBy = 'bottom';
                    break;
                }

                // Advance. Half a viewport per round matches Eagle's cadence:
                // enough to keep a virtualized grid mounting new rows, small
                // enough that nothing scrolls past unmounted.
                await session.evaluateFn((sel) => {
                    const el = sel ? document.querySelector(sel) : null;
                    if (el) el.scrollBy(0, (el.clientHeight || 600) * 0.5);
                    else window.scrollBy(0, window.innerHeight * 0.5);
                }, [rules.scroll_ele || '']).catch(() => {});
                if (rules.more_btn) {
                    await session.evaluateFn((sel) => {
                        const btn = document.querySelector(sel);
                        if (btn) btn.click();
                    }, [rules.more_btn]).catch(() => {});
                }
                // Lazy-load fires on painted frames only; background tabs need
                // the pump or every round collects the same rows.
                await session.pumpFrame().catch(() => {});
                await sleep(ROUND_PAUSE_MS + Math.floor(Math.random() * 250));
            }

            flush(true);
            return {
                harvest_id: harvestId,
                board_title: boardTitle,
                final_url: await session.getUrl().catch(() => startUrl),
                total,
                stopped_by: stoppedBy || 'bottom',
            };
        }, { keepTab: false, active: false });
    } finally {
        _active.delete(harvestId);
        _cancelled.delete(harvestId);
    }
}

// Pinterest rewrites its own URL while a board scrolls (section anchors,
// tracking params), which is not a navigation away from the board.
function _sameBoard(a, b) {
    try {
        const ua = new URL(a);
        const ub = new URL(b);
        return ua.hostname === ub.hostname && ua.pathname === ub.pathname;
    } catch (_) {
        return false;
    }
}
