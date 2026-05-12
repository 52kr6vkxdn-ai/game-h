/* ============================================================
   Zengine — engine.transitions.js
   Scene transition visual effects for gotoScene() calls.

   Supported transition names:
     "fade"        — fade to black, switch scene, fade from black
     "fadewhite"   — fade to white, switch scene, fade from white
     "slide-left"  — scene slides out to the left, new scene slides in from right
     "slide-right" — scene slides out to the right, new scene slides in from left
     "zoom"        — zoom into black, switch, zoom out from black

   Usage in scripts:
     gotoScene("Level2", "fade")
     gotoScene(1,        "slide-left")
     gotoScene("Menu",   "fadewhite")
   ============================================================ */

import { state } from './engine.state.js';

let _overlay    = null;
let _animHandle = null;

// ── Overlay element (shared, reused) ──────────────────────────
function _ensureOverlay(color = '#000') {
    if (_overlay && _overlay.isConnected) {
        _overlay.style.background = color;
        return _overlay;
    }
    _overlay = document.createElement('div');
    _overlay.id = 'zen-transition-overlay';
    _overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:99998',
        'pointer-events:none', 'opacity:0',
        `background:${color}`, 'will-change:opacity,transform',
    ].join(';');
    document.body.appendChild(_overlay);
    return _overlay;
}

function _stopAnim() {
    if (_animHandle) { cancelAnimationFrame(_animHandle); _animHandle = null; }
}

// ── rAF-based eased animation ─────────────────────────────────
function _animValue(from, to, duration, applyFn) {
    _stopAnim();
    return new Promise(resolve => {
        const start = performance.now();

        function tick() {
            const raw = (performance.now() - start) / (duration * 1000);
            const t   = Math.min(raw, 1);
            // ease-in-out quad
            const et  = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) ** 2;
            applyFn(from + (to - from) * et, t);
            if (t < 1) {
                _animHandle = requestAnimationFrame(tick);
            } else {
                _animHandle = null;
                resolve();
            }
        }
        _animHandle = requestAnimationFrame(tick);
    });
}

function _animOverlay(from, to, duration, color = '#000') {
    const ov = _ensureOverlay(color);
    ov.style.opacity = String(from);
    return _animValue(from, to, duration, (v) => { ov.style.opacity = String(v); });
}

function _animSlide(fromX, toX, duration) {
    const sc = state.sceneContainer;
    if (!sc) return Promise.resolve();
    const baseX = sc.x;
    return _animValue(fromX, toX, duration, (v) => { sc.x = baseX + v; });
}

function _animZoom(fromScale, toScale, fromAlpha, toAlpha, duration) {
    const ov  = _ensureOverlay('#000');
    const sc  = state.sceneContainer;
    const bsX = sc?.scale.x ?? 1;
    const bsY = sc?.scale.y ?? 1;
    ov.style.opacity = String(fromAlpha);
    return _animValue(0, 1, duration, (_, t) => {
        const et      = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) ** 2;
        const alpha   = fromAlpha + (toAlpha - fromAlpha) * et;
        const scaleV  = fromScale + (toScale - fromScale) * et;
        ov.style.opacity = String(alpha);
        if (sc) { sc.scale.x = bsX * scaleV; sc.scale.y = bsY * scaleV; }
    });
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Play the exit half of a transition (current scene disappears).
 * @param {string} type      Transition name
 * @param {number} duration  Total transition duration in seconds
 */
export async function transitionOut(type = 'fade', duration = 0.5) {
    const half = duration / 2;
    switch (type) {
        case 'fadewhite':
            return _animOverlay(0, 1, half, '#fff');
        case 'slide-left':
            return _animSlide(0, -window.innerWidth, half);
        case 'slide-right':
            return _animSlide(0, window.innerWidth, half);
        case 'zoom':
            return _animZoom(1, 1.2, 0, 1, half);
        case 'fade':
        default:
            return _animOverlay(0, 1, half, '#000');
    }
}

/**
 * Play the entrance half of a transition (new scene appears).
 * @param {string} type      Transition name (same as used in transitionOut)
 * @param {number} duration  Total transition duration in seconds
 */
export async function transitionIn(type = 'fade', duration = 0.5) {
    const half = duration / 2;
    switch (type) {
        case 'fadewhite':
            return _animOverlay(1, 0, half, '#fff').then(cleanupTransitions);
        case 'slide-left': {
            const sc = state.sceneContainer;
            if (sc) sc.x += window.innerWidth; // position new scene off-screen right
            return _animSlide(window.innerWidth, 0, half);
        }
        case 'slide-right': {
            const sc = state.sceneContainer;
            if (sc) sc.x -= window.innerWidth; // position new scene off-screen left
            return _animSlide(-window.innerWidth, 0, half);
        }
        case 'zoom':
            return _animZoom(0.85, 1, 1, 0, half).then(cleanupTransitions);
        case 'fade':
        default:
            return _animOverlay(1, 0, half, '#000').then(cleanupTransitions);
    }
}

/**
 * Remove the transition overlay and stop any running animation.
 * Called automatically after transition-in, and on stopPlayMode.
 */
export function cleanupTransitions() {
    _stopAnim();
    if (_overlay) { _overlay.style.opacity = '0'; _overlay.remove(); _overlay = null; }
}
