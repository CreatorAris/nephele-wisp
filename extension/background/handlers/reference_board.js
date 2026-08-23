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
// API cursor walk: ~100x the scroll walk's throughput and immune to
// background-tab throttling, so the default ceiling can afford to cover
// the "tens of thousands of pins" boards users actually curate.
const API_CEILING = 20_000;
const API_PAGE_FETCH_TIMEOUT_MS = 30_000;
const API_PAGE_PAUSE_MS = 250;

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

/*
 * ---- API cursor walk ----------------------------------------------------
 *
 * When the desktop rule carries `api: {kind, page_size?, ceiling?}`, the
 * harvest walks the site's own paginated feed API instead of scrolling the
 * grid: the board tab is still opened (cookies, Origin/Referer, and the
 * page world the fetch runs in), but items come from cursor-paginated JSON,
 * so virtualized-grid unmounting, background-tab rAF throttling, and the
 * scroll walk's wall-clock ceiling stop mattering. Verified 2026-08-23
 * against live sites: huaban /v3 max-cursor walks a 5470-pin board in 52s;
 * Pinterest BoardFeedResource bookmark-walks 1847 pins with no cap.
 *
 * The fetch itself is kicked into the page and POLLED via short sync
 * evaluates with a frame pump between rounds. A fresh background tab
 * resolves awaited fetches fine (evaluateAsyncFn's doc, and the short
 * reference_pinterest.js API loop, are both correct for that regime) —
 * but this walk is the one Wisp path meant to run PAST Chrome's
 * ~5-minute intensive-throttling threshold, and on an intensively
 * throttled tab a kicked fetch was measured staying pending
 * indefinitely (2026-08-23, hours-old background tab: >30s pending,
 * setTimeout races never fired). An in-flight awaited evaluate has no
 * rescue once the renderer parks; SW-side polling with a BeginFrame
 * pump per round keeps pages resolving past the threshold. Parsing
 * happens in-page too: only compact item rows cross CDP and the NMH
 * socket, never raw feed JSON.
 *
 * Any bootstrap or page failure falls back to the scroll walk — the API
 * shapes are living targets and the DOM path is the one that only needs
 * the site to render at all.
 */

/* Runs IN PAGE (self-contained). Fetches one feed page, parses it by
 * `kind`, leaves {st, items, cursor, done} (or {st:'err'}) on window[slot]
 * for the poller. `pinterest_board_resource` is the bootstrap lookup: it
 * resolves the numeric board id instead of items. */
function pageApiFetch(slot, url, headers, kind) {
    window[slot] = { st: 'pending' };
    fetch(url, { credentials: 'include', headers: headers || {} })
        .then((r) => {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        })
        .then((j) => {
            const out = { st: 'done', items: [], cursor: '', done: false };
            if (kind === 'huaban_v3') {
                const pins = (j && j.pins) || [];
                for (const p of pins) {
                    const f = p.file || {};
                    const src = f.url || (f.key ? 'https://gd-hbimg.huaban.com/' + f.key : '');
                    if (!src || !p.pin_id) continue;
                    out.items.push({
                        url: src,
                        page_url: 'https://huaban.com/pins/' + p.pin_id,
                        pin_id: String(p.pin_id),
                        alt: String(p.raw_text || '').trim().slice(0, 120),
                        width: f.width || 0,
                        height: f.height || 0,
                    });
                }
                // Cursor from the RAW pins array (the API's pagination
                // boundary), not the filtered items; a trailing pin with no
                // id would otherwise page with max=undefined — treat that
                // as the end instead.
                const lastId = pins.length ? pins[pins.length - 1].pin_id : '';
                out.cursor = lastId ? String(lastId) : '';
                out.done = !pins.length || !out.cursor;
            } else if (kind === 'pinterest_board_feed') {
                const rr = (j && j.resource_response) || {};
                const data = Array.isArray(rr.data) ? rr.data : [];
                for (const it of data) {
                    const orig = it && it.images && it.images.orig;
                    if (!orig || !orig.url || !it.id) continue;
                    out.items.push({
                        url: orig.url,
                        page_url: 'https://www.pinterest.com/pin/' + it.id + '/',
                        pin_id: String(it.id),
                        alt: String(it.grid_title || it.description || '').trim().slice(0, 120),
                        width: orig.width || 0,
                        height: orig.height || 0,
                    });
                }
                const bm = rr.bookmark && rr.bookmark !== '-end-' ? String(rr.bookmark) : '';
                out.cursor = bm;
                out.done = !data.length || !bm;
            } else if (kind === 'pinterest_board_resource') {
                const node = j && j.resource_response && j.resource_response.data
                    && j.resource_response.data.node_id;
                if (!node) throw new Error('BoardResource: no node_id');
                const decoded = atob(String(node));           // "Board:<id>"
                out.board_id = decoded.split(':')[1] || '';
                if (!out.board_id) throw new Error('BoardResource: bad node_id ' + decoded);
                out.done = true;
            } else {
                throw new Error('unknown api kind: ' + kind);
            }
            window[slot] = out;
        })
        .catch((e) => { window[slot] = { st: 'err', msg: String((e && e.message) || e) }; });
}

/* CDP sends have no timeout of their own, and a tab parked by the
 * browser's memory saver / tab discard never runs its callbacks — an
 * unguarded await there hangs the whole harvest forever (observed
 * 2026-08-23 as intermittent walk stalls under heavy browser use).
 * Errors carry .stuck so the caller knows the TAB is dead, not the API:
 * falling back to the scroll walk on the same tab would hang the same
 * way, so stuck errors must fail the harvest instead. */
function _withCdpTimeout(tag, ms, promise) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => {
            const err = new Error(`CDP_STUCK: ${tag} did not return in ${ms}ms`);
            err.stuck = true;
            reject(err);
        }, ms)),
    ]);
}
const CDP_OP_TIMEOUT_MS = 15_000;

/* Kick one in-page API fetch and poll it out. Throws on page error or
 * timeout — callers treat a non-stuck throw as "fall back to the scroll
 * walk" and a .stuck throw as "the tab is gone, stop the harvest". */
async function _fetchApiPage(session, url, headers, kind) {
    const slot = '__nw_api_' + Math.floor(Math.random() * 1e9);
    await _withCdpTimeout('api kick', CDP_OP_TIMEOUT_MS,
        session.evaluateFn(pageApiFetch, [slot, url, headers, kind]));
    const deadline = Date.now() + API_PAGE_FETCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await _withCdpTimeout('api pump', CDP_OP_TIMEOUT_MS,
            session.pumpFrame()).catch((e) => { if (e && e.stuck) throw e; });
        await sleep(300);
        const out = await _withCdpTimeout('api poll', CDP_OP_TIMEOUT_MS,
            session.evaluateFn((s) => {
                const v = window[s];
                if (v && v.st !== 'pending') { try { delete window[s]; } catch (_) { /* keep */ } }
                return v && v.st !== 'pending' ? v : null;
            }, [slot]));
        if (out && out.st === 'done') return out;
        if (out && out.st === 'err') throw new Error(`api page: ${out.msg}`);
    }
    throw new Error('api page: fetch timed out');
}

/* Walks the feed API to the board's end. `sink(items)` de-dupes/emits and
 * returns false once the cap is hit. Returns the stop reason; throws to
 * request fallback to the scroll walk. */
async function apiWalk(session, rules, startUrl, { sink, isCancelled, deadlineAt }) {
    const kind = rules.api.kind;
    const pageSize = Math.min(200, Math.max(20, parseInt(rules.api.page_size, 10) || 100));
    const origin = new URL(startUrl).origin;

    let buildUrl;
    let headers;
    if (kind === 'huaban_v3') {
        const m = new URL(startUrl).pathname.match(/^\/boards\/(\d+)/);
        if (!m) throw new Error('api: not a huaban board url');
        const boardId = m[1];
        headers = { Accept: 'application/json' };
        buildUrl = (cursor) => `${origin}/v3/boards/${boardId}/pins?limit=${pageSize}`
            + (cursor ? `&max=${cursor}` : '');
    } else if (kind === 'pinterest_board_feed') {
        const segs = new URL(startUrl).pathname.split('/').filter(Boolean);
        if (segs.length < 2) throw new Error('api: not a pinterest board url');
        const sourceUrl = `/${segs[0]}/${segs[1]}/`;
        // The PWS front rejects bare XHRs; the recipe below matches what the
        // page's own client sends (sniffed 2026-08-23). appVersion comes from
        // the page HTML and changes per deploy — omitting it 403s.
        const appVersion = await _withCdpTimeout('app version', CDP_OP_TIMEOUT_MS,
            session.evaluateFn(() => {
                const m2 = document.documentElement.outerHTML
                    .match(/"appVersion"\s*:\s*"([0-9a-f]{6,})"/);
                return (m2 && m2[1]) || '';
            }));
        headers = {
            Accept: 'application/json, text/javascript, */*, q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
            'X-Pinterest-AppState': 'active',
            'X-Pinterest-Source-Url': sourceUrl,
            'X-Pinterest-PWS-Handler': 'www/[username]/[slug].js',
        };
        if (appVersion) headers['X-APP-VERSION'] = appVersion;
        const brData = JSON.stringify({
            options: { username: segs[0], slug: segs[1], field_set_key: 'detailed' },
            context: {},
        });
        const brUrl = `${origin}/resource/BoardResource/get/?source_url=`
            + `${encodeURIComponent(sourceUrl)}&data=${encodeURIComponent(brData)}`;
        const br = await _fetchApiPage(session, brUrl, headers, 'pinterest_board_resource');
        const boardId = br.board_id;
        buildUrl = (cursor) => {
            const options = {
                board_id: boardId,
                board_url: sourceUrl,
                currentFilter: -1,
                field_set_key: 'react_grid_pin',
                filter_section_pins: true,
                sort: 'default',
                layout: 'default',
                page_size: pageSize,
                redux_normalize_feed: true,
            };
            if (cursor) options.bookmarks = [cursor];
            const data = JSON.stringify({ options, context: {} });
            return `${origin}/resource/BoardFeedResource/get/?source_url=`
                + `${encodeURIComponent(sourceUrl)}&data=${encodeURIComponent(data)}`;
        };
    } else {
        throw new Error(`api: unknown kind ${kind}`);
    }

    let cursor = '';
    while (true) {
        if (isCancelled()) return 'cancelled';
        if (Date.now() > deadlineAt) return 'time_limit';
        const page = await _fetchApiPage(session, buildUrl(cursor), headers, kind);
        if (page.items.length && !sink(page.items)) return 'max_items';
        if (page.done) return 'api_end';
        cursor = page.cursor;
        await sleep(API_PAGE_PAUSE_MS + Math.floor(Math.random() * 150));
    }
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
    const rawMax = Math.max(0, parseInt(payload?.max_items, 10) || 0);
    const maxItems = rawMax || HARD_CEILING;
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

            // API cursor walk first when the rule offers one; the scroll
            // walk below is the fallback for bootstrap/page failures.
            if (rules.api && rules.api.kind) {
                const apiMax = rawMax
                    || Math.max(0, parseInt(rules.api.ceiling, 10) || 0)
                    || API_CEILING;
                const sink = (items) => {
                    for (const item of items) {
                        const key = item.pin_id || item.url;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        total += 1;
                        pending.push(item);
                        if (total >= apiMax) { flush(true); return false; }
                    }
                    flush(false);
                    return true;
                };
                try {
                    const apiStop = await apiWalk(session, rules, startUrl, {
                        sink,
                        isCancelled: () => _cancelled.has(harvestId),
                        deadlineAt: startedAt + MAX_RUN_MS,
                    });
                    flush(true);
                    return {
                        harvest_id: harvestId,
                        board_title: boardTitle,
                        final_url: await session.getUrl().catch(() => startUrl),
                        total,
                        stopped_by: apiStop === 'max_items' && !rawMax ? 'ceiling' : apiStop,
                    };
                } catch (e) {
                    if (e && e.stuck) {
                        // The tab itself stopped answering CDP (memory-saver
                        // park / discard). The scroll walk would hang on the
                        // same dead tab, so fail the harvest cleanly — the
                        // desktop keeps everything already emitted.
                        const err = new Error(`TAB_STALLED: ${e.message}`);
                        err.code = 'TAB_STALLED';
                        throw err;
                    }
                    console.warn('[board] api walk failed, falling back to scroll:', e.message);
                    // Partial API items stay in `seen`/`total` and were already
                    // emitted; the scroll walk below only adds unseen pins.
                }
            }

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
