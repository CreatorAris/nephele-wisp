/*
 * Humanization Pipeline — non-negotiable defaults.
 *
 * Wraps every DOM mutation the CDP orchestrator performs with
 * human-like timing and spatial noise, so anti-automation heuristics
 * on target platforms cannot distinguish Wisp from a real user by
 * behavioral fingerprint.
 *
 * Pulled directly from PROTOCOL.md §Humanization Pipeline. These
 * constants are NOT exposed to configuration — the desktop side
 * cannot ask for faster execution. Respond to any such request with
 * INVALID_PAYLOAD at the NMH layer.
 */

// Low-level sleep — awaitable.
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Uniform random delay in [minMs, maxMs].
export function randomDelay(minMs, maxMs) {
    return sleep(minMs + Math.random() * (maxMs - minMs));
}

// Box–Muller transform: standard normal sample.
function standardNormal() {
    const u = 1 - Math.random();
    const v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ── Pipeline stages (PROTOCOL.md §Humanization Pipeline) ──────────

// 1. Pre-action delay — before any mouse/keyboard dispatch.
export function preActionDelay() {
    return randomDelay(200, 800);
}

// 2. Mouse jitter — Gaussian σ=1.5 px, clamped to element bounds.
export function jitterPoint(cx, cy, bounds = null, sigma = 1.5) {
    let x = cx + sigma * standardNormal();
    let y = cy + sigma * standardNormal();
    if (bounds) {
        x = Math.max(bounds.left, Math.min(bounds.right, x));
        y = Math.max(bounds.top, Math.min(bounds.bottom, y));
    }
    return { x, y };
}

// 3. Move-then-click gap — between mouseMoved and mousePressed.
export function clickMoveGap() {
    return randomDelay(50, 150);
}

// Press-hold — brief delay between mousePressed and mouseReleased.
// Not explicitly in PROTOCOL.md but real clicks are never instant.
export function clickHold() {
    return randomDelay(30, 80);
}

// 4. Typing cadence — per character inter-key delay from
//    Normal(μ=130ms, σ=40ms), clamped to [60ms, 400ms].
export function typingInterval() {
    const v = 130 + 40 * standardNormal();
    return sleep(Math.max(60, Math.min(400, v)));
}

// 5. Step dwell — between distinct form steps.
export function stepDwell() {
    return randomDelay(800, 3000);
}

// 6. Schedule jitter — offset for scheduled actions.
//    Returns a signed offset in ms uniformly distributed in ±15 min.
export function scheduleJitterMs() {
    return (Math.random() - 0.5) * 30 * 60 * 1000;
}
