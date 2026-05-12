/* ============================================================
   Zengine — engine.collision-overlay.js
   Draws collision shape overlays on every physics-enabled object
   in the editor viewport.  Works as a PIXI ticker so it stays
   in sync when objects are moved/scaled/rotated.

   Public API
   ──────────
   initCollisionOverlay()   — call once after PIXI is ready
   refreshCollisionOverlay()— redraw everything now
   setCollisionVisible(v)   — show / hide all overlays
   rawSpriteSize(obj)       — visible sprite size in container-local px
   alphaBounds(obj)         — alpha-trimmed bounds (cached) {w,h,ox,oy}
   collisionGeom(obj)       — effective collision geometry honouring
                              user overrides + alpha-trim defaults
   tileAlphaBounds(asset)   — alpha bounds for a tilemap tile asset
   ============================================================ */

import { state } from './engine.state.js';

// ── Module-level PIXI.Graphics layer ─────────────────────────
let _layer      = null;
let _ticker     = null;
let _visible    = false;

// ─────────────────────────────────────────────────────────────
// Init — must be called after state.app is ready
// ─────────────────────────────────────────────────────────────
export function initCollisionOverlay() {
    if (_layer) return;
    if (!state.app) return;

    _layer = new PIXI.Graphics();
    _layer.zIndex = 9999;
    _layer.visible = false;

    // CRITICAL: the overlay must NEVER intercept pointer events,
    // otherwise the user can no longer click sprites or drag gizmos
    // while the collision shapes are visible.
    _layer.eventMode = 'none';
    _layer.interactiveChildren = false;
    _layer.hitArea = null;

    state.app.stage.addChild(_layer);

    _ticker = () => {
        if (!_layer) return;
        if (state.isPlaying) {
            if (_layer.visible) {
                _layer.visible = false;
                _layer.clear();
            }
            return;
        }
        const want = _visible;
        if (_layer.visible !== want) _layer.visible = want;
        if (want) _redrawAll();
    };
    state.app.ticker.add(_ticker);
}

// ─────────────────────────────────────────────────────────────
// Show / Hide
// ─────────────────────────────────────────────────────────────
export function setCollisionVisible(v) {
    _visible = !!v;
    state.showCollision = _visible;
    if (_layer) {
        const shouldShow = _visible && !state.isPlaying;
        _layer.visible = shouldShow;
        if (shouldShow) _redrawAll();
        else _layer.clear();
    }
    const badge = document.getElementById('collision-toggle-badge');
    const btn   = document.getElementById('btn-collision-toggle');
    if (badge) badge.style.display = _visible ? 'block' : 'none';
    if (btn)   btn.classList.toggle('active', _visible);
}

export function refreshCollisionOverlay() {
    if (_visible && _layer && !state.isPlaying) _redrawAll();
}

// ─────────────────────────────────────────────────────────────
// Core draw — loops over all game objects
// ─────────────────────────────────────────────────────────────
function _redrawAll() {
    if (!_layer) return;
    _layer.clear();
    if (!state.sceneContainer) return;

    const sc = state.sceneContainer;
    for (const obj of state.gameObjects) {
        _drawObjectCollision(obj, sc);
    }
}

function _drawObjectCollision(obj, sc) {
    if (obj.isTilemap && obj.tilemapData) {
        _drawTilemapCollision(obj, sc);
        return;
    }
    if (obj.isAutoTilemap && obj.autoTileData) {
        _drawAutoTilemapCollision(obj, sc);
        return;
    }

    const type = obj.physicsBody ?? 'none';
    if (type === 'none') return;

    const shape = obj.physicsShape ?? 'box';
    const sx    = Math.abs(obj.scale?.x ?? 1) || 1;
    const sy    = Math.abs(obj.scale?.y ?? 1) || 1;

    const g    = collisionGeom(obj);
    const w    = g.w * sx;
    const h    = g.h * sy;
    const r    = g.r * Math.min(sx, sy);

    // Object world position
    const objWx = sc.x + obj.x * sc.scale.x;
    const objWy = sc.y + obj.y * sc.scale.y;
    const wsx   = sx   * sc.scale.x;
    const wsy   = sy   * sc.scale.y;
    const rot   = obj.rotation ?? 0;

    // Apply collision offset (rotated by obj rotation, scaled by obj scale × camera)
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    const ox   = (g.ox || 0) * sx;
    const oy   = (g.oy || 0) * sy;
    const wx   = objWx + (ox * cosR - oy * sinR) * sc.scale.x;
    const wy   = objWy + (ox * sinR + oy * cosR) * sc.scale.y;

    const col = _bodyColor(type);
    _layer.lineStyle(1.5, col, 0.85);
    _layer.beginFill(col, 0.10);

    if (shape === 'circle') {
        _drawRotatedCircle(wx, wy, Math.max(r, 2) * sc.scale.x, rot);
    } else if (shape === 'capsule') {
        const capW = (obj.physicsSize?.capW ?? g.w) * sx * sc.scale.x;
        const capH = (obj.physicsSize?.capH ?? g.h) * sy * sc.scale.y;
        _drawCapsule(wx, wy, capW, capH, rot);
    } else if ((shape === 'polygon') && _hasPolygon(obj)) {
        const poly = _getPolygon(obj);
        _drawPolygon(objWx, objWy, poly, wsx, wsy, rot);
    } else {
        _drawRotatedRect(wx, wy, w * sc.scale.x, h * sc.scale.y, rot);
    }

    _layer.endFill();

    // Origin dot at object centre
    _layer.lineStyle(0);
    _layer.beginFill(col, 0.9);
    _layer.drawCircle(objWx, objWy, 2.5);
    _layer.endFill();
}

// ─────────────────────────────────────────────────────────────
// Tilemap helpers — collision per tile, using each tile asset's
// alpha-trimmed bounds (so only the visible pixels are colliders)
// ─────────────────────────────────────────────────────────────
function _drawTilemapCollision(obj, sc) {
    const td = obj.tilemapData;
    if (!td) return;
    _layer.lineStyle(1, 0x38bdf8, 0.6);
    _layer.beginFill(0x38bdf8, 0.08);
    for (let r = 0; r < td.rows; r++) {
        for (let c = 0; c < td.cols; c++) {
            const aid = td.tiles[r * td.cols + c];
            if (!aid) continue;
            const ab  = tileAlphaBoundsForAsset(aid, td.tileW, td.tileH);
            const cx  = obj.x + c * td.tileW + td.tileW / 2 + ab.ox;
            const cy  = obj.y + r * td.tileH + td.tileH / 2 + ab.oy;
            const wx  = sc.x + cx * sc.scale.x;
            const wy  = sc.y + cy * sc.scale.y;
            const tw  = ab.w * sc.scale.x;
            const th  = ab.h * sc.scale.y;
            _layer.drawRect(wx - tw/2, wy - th/2, tw, th);
        }
    }
    _layer.endFill();
}

function _drawAutoTilemapCollision(obj, sc) {
    const d = obj.autoTileData;
    if (!d) return;
    _layer.lineStyle(1, 0x38bdf8, 0.6);
    _layer.beginFill(0x38bdf8, 0.08);
    for (let r = 0; r < d.rows; r++) {
        for (let c = 0; c < d.cols; c++) {
            const v = d.cells[r * d.cols + c];
            const ids = Array.isArray(v) ? v : (v ? [v] : []);
            if (!ids.length) continue;
            // Use union of all stacked tile alpha bounds for the cell
            const ab = unionTileAlphaBounds(ids, d.tileW, d.tileH);
            const cx = obj.x + c * d.tileW + d.tileW / 2 + ab.ox;
            const cy = obj.y + r * d.tileH + d.tileH / 2 + ab.oy;
            const wx = sc.x + cx * sc.scale.x;
            const wy = sc.y + cy * sc.scale.y;
            const tw = ab.w * sc.scale.x;
            const th = ab.h * sc.scale.y;
            _layer.drawRect(wx - tw/2, wy - th/2, tw, th);
        }
    }
    _layer.endFill();
}

// ─────────────────────────────────────────────────────────────
// Shape draw helpers
// ─────────────────────────────────────────────────────────────
function _drawRotatedRect(cx, cy, w, h, angle) {
    if (Math.abs(angle) < 0.001) {
        _layer.drawRect(cx - w/2, cy - h/2, w, h);
        return;
    }
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const hw  = w/2, hh = h/2;
    const corners = [
        { x: -hw, y: -hh }, { x: hw, y: -hh },
        { x: hw, y:  hh }, { x: -hw, y: hh },
    ];
    const pts = corners.map(p => ({
        x: cx + p.x * cos - p.y * sin,
        y: cy + p.x * sin + p.y * cos,
    }));
    _layer.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) _layer.lineTo(pts[i].x, pts[i].y);
    _layer.closePath();
}

function _drawRotatedCircle(cx, cy, r, angle) {
    _layer.drawCircle(cx, cy, r);
    const ex = cx + Math.cos(angle) * r;
    const ey = cy + Math.sin(angle) * r;
    _layer.moveTo(cx, cy);
    _layer.lineTo(ex, ey);
}

// Draws a pill/capsule shape: two semicircles joined by straight lines, rotated by angle
function _drawCapsule(cx, cy, w, h, angle) {
    // Capsule: pill oriented along the longer axis
    const r   = Math.min(w, h) / 2;
    const len = Math.max(w, h) / 2 - r;        // half-length of the straight section
    const cos = Math.cos(angle), sin = Math.sin(angle);
    // Axis direction (along the long axis of the capsule)
    const ax = (w >= h) ? cos : -sin;
    const ay = (w >= h) ? sin :  cos;
    // Perpendicular
    const px = -ay, py = ax;

    // 4 corner-ish anchor points on the rectangle part
    const x1 = cx + ax * len + px * r, y1 = cy + ay * len + py * r;
    const x2 = cx + ax * len - px * r, y2 = cy + ay * len - py * r;
    const x3 = cx - ax * len - px * r, y3 = cy - ay * len - py * r;
    const x4 = cx - ax * len + px * r, y4 = cy - ay * len + py * r;

    const SEGS = 16;
    const pts = [];
    // Right semicircle
    for (let i = 0; i <= SEGS; i++) {
        const a = angle + (i / SEGS) * Math.PI - Math.PI / 2;
        pts.push({ x: cx + ax * len + Math.cos(a) * r, y: cy + ay * len + Math.sin(a) * r });
    }
    // Left semicircle
    for (let i = 0; i <= SEGS; i++) {
        const a = angle + (i / SEGS) * Math.PI + Math.PI / 2;
        pts.push({ x: cx - ax * len + Math.cos(a) * r, y: cy - ay * len + Math.sin(a) * r });
    }
    if (pts.length === 0) return;
    _layer.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) _layer.lineTo(pts[i].x, pts[i].y);
    _layer.closePath();
}

function _drawPolygon(cx, cy, poly, wsx, wsy, angle) {
    if (!poly || poly.length < 3) return;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const pts = poly.map(p => {
        const lx = p.x * wsx;
        const ly = p.y * wsy;
        return {
            x: cx + lx * cos - ly * sin,
            y: cy + lx * sin + ly * cos,
        };
    });
    _layer.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) _layer.lineTo(pts[i].x, pts[i].y);
    _layer.closePath();
    _layer.lineStyle(0);
    _layer.beginFill(0xa78bfa, 0.9);
    pts.forEach(p => _layer.drawCircle(p.x, p.y, 2));
    _layer.endFill();
    _layer.lineStyle(1.5, _bodyColor('polygon'), 0.85);
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function _bodyColor(type) {
    switch (type) {
        case 'static':    return 0x60a5fa;  // 🔵 blue
        case 'dynamic':   return 0xf87171;  // 🔴 red
        case 'kinematic': return 0xfacc15;  // 🟡 yellow
        case 'polygon':   return 0xa78bfa;
        default:          return 0x94a3b8;
    }
}

// ─────────────────────────────────────────────────────────────
// Visible sprite size in container-local pixels
// (= texture raw size × inner sprite scale).  This is the size
// the user sees in the editor BEFORE the object's own scale.
// ─────────────────────────────────────────────────────────────
export function rawSpriteSize(obj) {
    const src = obj.spriteGraphic || obj._runtimeSprite;
    if (!src) return { w: 40, h: 40 };

    // Inner sprite scale (typically 100/maxDim from createImageObject)
    const ssx = Math.abs(src.scale?.x ?? 1) || 1;
    const ssy = Math.abs(src.scale?.y ?? 1) || 1;

    if (src.texture?.orig) {
        return {
            w: src.texture.orig.width  * ssx,
            h: src.texture.orig.height * ssy,
        };
    }
    if (src.texture?.width) {
        return {
            w: src.texture.width  * ssx,
            h: src.texture.height * ssy,
        };
    }
    if (src.width && src.height) {
        // Already in container-local space
        return { w: src.width, h: src.height };
    }
    return { w: 40, h: 40 };
}

// ─────────────────────────────────────────────────────────────
// Alpha-trimmed bounds for a sprite object (cached).
// Returns {w, h, ox, oy} in container-local pixels, where (ox,oy)
// is the offset from sprite-centre to alpha-bbox-centre.
// Returns null while async-loading the first time.
// ─────────────────────────────────────────────────────────────
const _alphaCache = new Map(); // key: dataURL → { w, h, ox, oy } in TEXTURE pixels
const _alphaPending = new Set();

function _getDataURL(obj) {
    const anim = obj.animations?.[obj.activeAnimIndex ?? 0];
    // Honour runtime per-frame override (set by physics when AnimatedSprite frame changes)
    if (obj._runtimePhysicsFrameId && anim?.frames) {
        const f = anim.frames.find(fr => fr.id === obj._runtimePhysicsFrameId);
        if (f?.dataURL) return f.dataURL;
    }
    const f0   = anim?.frames?.[0];
    if (f0?.dataURL) return f0.dataURL;
    const src = obj.spriteGraphic?.texture?.baseTexture?.resource?.source;
    if (src?.src) return src.src;
    if (src?.currentSrc) return src.currentSrc;
    return null;
}

// Sync getter returning alpha bounds in TEXTURE px for an arbitrary dataURL.
// Returns null while computing the first time (cb fires when ready).
export function alphaBoundsForDataURL(dataURL, onReady) {
    if (!dataURL) return null;
    if (_alphaCache.has(dataURL)) return _alphaCache.get(dataURL);
    _computeAlphaBoundsTex(dataURL, (b) => { try { onReady?.(b); } catch(_) {} });
    return null;
}

function _computeAlphaBoundsTex(dataURL, cb) {
    if (_alphaCache.has(dataURL)) { cb(_alphaCache.get(dataURL)); return; }
    if (_alphaPending.has(dataURL)) return;
    _alphaPending.add(dataURL);

    const img = new Image();
    img.onload = () => {
        _alphaPending.delete(dataURL);
        const w = img.naturalWidth || 1, h = img.naturalHeight || 1;
        try {
            const cv = document.createElement('canvas');
            cv.width = w; cv.height = h;
            const ctx = cv.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            const data = ctx.getImageData(0, 0, w, h).data;
            const T = 8; // alpha threshold (0..255)
            let minX = w, maxX = -1, minY = h, maxY = -1;
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    if (data[(y * w + x) * 4 + 3] > T) {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }
            }
            let bounds;
            if (maxX < minX) {
                // fully transparent → use whole texture
                bounds = { w, h, ox: 0, oy: 0 };
            } else {
                const bw = maxX - minX + 1;
                const bh = maxY - minY + 1;
                const bcx = (minX + maxX + 1) / 2;
                const bcy = (minY + maxY + 1) / 2;
                bounds = { w: bw, h: bh, ox: bcx - w / 2, oy: bcy - h / 2 };
            }
            _alphaCache.set(dataURL, bounds);
            cb(bounds);
        } catch (e) {
            // CORS or other failure → fallback to full texture
            const bounds = { w, h, ox: 0, oy: 0 };
            _alphaCache.set(dataURL, bounds);
            cb(bounds);
        }
    };
    img.onerror = () => { _alphaPending.delete(dataURL); };
    img.src = dataURL;
}

// Public sync getter — returns current bounds in container-local px,
// or null if not yet computed (kicks off async compute).
export function alphaBounds(obj) {
    const url = _getDataURL(obj);
    if (!url) return null;

    const src = obj.spriteGraphic || obj._runtimeSprite;
    const ssx = Math.abs(src?.scale?.x ?? 1) || 1;
    const ssy = Math.abs(src?.scale?.y ?? 1) || 1;

    if (_alphaCache.has(url)) {
        const t = _alphaCache.get(url);
        return { w: t.w * ssx, h: t.h * ssy, ox: t.ox * ssx, oy: t.oy * ssy };
    }
    // Kick off async compute, then refresh overlay when ready
    _computeAlphaBoundsTex(url, () => {
        try { refreshCollisionOverlay(); } catch(_) {}
    });
    return null;
}

// Tilemap tile alpha-bounds: cached per asset id.
// Returns {w, h, ox, oy} in TILE pixels (w/h clamped to tileW/tileH).
const _tileAlphaCache = new Map(); // assetId → {w,h,ox,oy} in texture px
export function tileAlphaBoundsForAsset(assetId, tileW, tileH) {
    const fallback = { w: tileW, h: tileH, ox: 0, oy: 0 };
    if (!assetId) return fallback;
    const asset = state.assets?.find(a => a.id === assetId);
    if (!asset?.dataURL) return fallback;

    if (_tileAlphaCache.has(assetId)) {
        const t = _tileAlphaCache.get(assetId);
        // Scale to tile size
        const scaleX = tileW / (t._texW || tileW);
        const scaleY = tileH / (t._texH || tileH);
        return {
            w: Math.max(1, t.w * scaleX),
            h: Math.max(1, t.h * scaleY),
            ox: t.ox * scaleX,
            oy: t.oy * scaleY,
        };
    }

    _computeAlphaBoundsTex(asset.dataURL, (bounds) => {
        // Stash texture size for later scaling
        const img = new Image();
        img.onload = () => {
            _tileAlphaCache.set(assetId, {
                ...bounds,
                _texW: img.naturalWidth,
                _texH: img.naturalHeight,
            });
            try { refreshCollisionOverlay(); } catch(_) {}
        };
        img.src = asset.dataURL;
    });
    return fallback;
}

export function unionTileAlphaBounds(assetIds, tileW, tileH) {
    const items = assetIds.map(id => tileAlphaBoundsForAsset(id, tileW, tileH));
    if (!items.length) return { w: tileW, h: tileH, ox: 0, oy: 0 };
    let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity;
    for (const it of items) {
        l = Math.min(l, it.ox - it.w / 2);
        r = Math.max(r, it.ox + it.w / 2);
        t = Math.min(t, it.oy - it.h / 2);
        b = Math.max(b, it.oy + it.h / 2);
    }
    return {
        w: Math.max(1, r - l),
        h: Math.max(1, b - t),
        ox: (l + r) / 2,
        oy: (t + b) / 2,
    };
}

// ─────────────────────────────────────────────────────────────
// Effective collision geometry — the single source of truth.
// Honours user overrides (obj.physicsSize), defaults to alpha-
// trimmed bounds (only visible pixels), falls back to full sprite.
// All values in container-local pixels (= what you see in editor
// before obj.scale).  ox,oy are offset from sprite centre.
// ─────────────────────────────────────────────────────────────
export function collisionGeom(obj) {
    const raw = rawSpriteSize(obj);
    const ab  = alphaBounds(obj) || { w: raw.w, h: raw.h, ox: 0, oy: 0 };
    const ps  = obj.physicsSize || {};

    const w = (typeof ps.w === 'number' && ps.w > 0) ? ps.w : ab.w;
    const h = (typeof ps.h === 'number' && ps.h > 0) ? ps.h : ab.h;
    const r = (typeof ps.r === 'number' && ps.r > 0)
        ? ps.r
        : Math.min(ab.w, ab.h) / 2;
    const ox = (typeof ps.ox === 'number') ? ps.ox : ab.ox;
    const oy = (typeof ps.oy === 'number') ? ps.oy : ab.oy;
    return { w, h, r, ox, oy, raw, alpha: ab };
}

function _migrate(obj) {
    if (!obj || obj._polyUnit === 'container') return;
    // Lazy-load to avoid a hard import cycle with engine.physics.js
    import('./engine.physics.js').then(m => {
        m.migratePolygonsToContainer?.(obj);
        try { refreshCollisionOverlay(); } catch(_) {}
    });
}

function _hasPolygon(obj) {
    _migrate(obj);
    const map = obj.physicsPolygons;
    if (!map) return !!(obj.physicsPolygon?.length >= 3);
    const anim    = obj.animations?.[obj.activeAnimIndex ?? 0];
    const frameId = anim?.frames?.[0]?.id;
    if (frameId && Array.isArray(map[frameId]) && map[frameId].length >= 3) return true;
    return Array.isArray(map.shared) && map.shared.length >= 3;
}

function _getPolygon(obj) {
    _migrate(obj);
    const map = obj.physicsPolygons;
    if (!map) return obj.physicsPolygon || null;
    // Always prefer the first frame polygon — that is what the engine renders in edit mode.
    const anim    = obj.animations?.[obj.activeAnimIndex ?? 0];
    const frameId = anim?.frames?.[0]?.id;
    if (frameId && Array.isArray(map[frameId]) && map[frameId].length >= 3) return map[frameId];
    // Fall back to shared, then legacy single polygon
    if (Array.isArray(map.shared) && map.shared.length >= 3) return map.shared;
    return obj.physicsPolygon || null;
}
