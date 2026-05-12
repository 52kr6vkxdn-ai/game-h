/* ============================================================
   Zengine — engine.lights.js
   Advanced 2D Lighting System
   ============================================================ */

import { state } from './engine.state.js';

// ── Light type definitions ───────────────────────────────────
export const LIGHT_TYPES = {
    point:       { label: 'Point Light',       icon: '💡' },
    spot:        { label: 'Spot Light',         icon: '🔦' },
    directional: { label: 'Directional Light',  icon: '☀️' },
    area:        { label: 'Area Light',         icon: '▭'  },
};

// Default properties per light type
export function defaultLightProps(type) {
    const base = {
        color:     0xFFFFFF,
        intensity: 1.0,
        enabled:   true,
    };
    switch (type) {
        case 'point':
            return { ...base, radius: 200, falloff: 2.0, castShadows: false };
        case 'spot':
            return { ...base, radius: 250, angle: 45, falloff: 1.8, direction: 0, castShadows: false };
        case 'directional':
            return { ...base, angle: 0, softness: 0.3 };
        case 'area':
            return { ...base, width: 150, height: 80, falloff: 1.5 };
        default:
            return base;
    }
}

// ── Create a 2D Light object ─────────────────────────────────
export function createLight(type = 'point', x = 0, y = 0) {
    const { _uniqueLightName } = _nameUtils();

    const container = new PIXI.Container();
    container.x = x;
    container.y = y;
    container.isLight    = true;
    container.lightType  = type;
    container.label      = _uniqueLightName(LIGHT_TYPES[type]?.label || 'Light');
    container.lightProps = defaultLightProps(type);
    container.animations = [];
    container.activeAnimIndex = 0;
    container.unityZ = 0;

    // Build the editor helper gizmo (visible in editor, hidden in play)
    _buildLightHelper(container);

    // Attach standard gizmo handles for translate
    _attachTranslateGizmo(container);

    if (state._bindGizmoHandles) state._bindGizmoHandles(container);
    state.sceneContainer.addChild(container);
    state.gameObjects.push(container);

    _makeLightSelectable(container);

    // Select it
    import('./engine.objects.js').then(m => m.selectObject(container));
    import('./engine.ui.js').then(m => { m.refreshHierarchy(); });

    return container;
}

// ── Build the visual helper shown in editor ──────────────────
export function _buildLightHelper(container) {
    // Remove old helper
    if (container._lightHelper) {
        container.removeChild(container._lightHelper);
        try { container._lightHelper.destroy(); } catch(_) {}
    }

    const g = new PIXI.Graphics();
    const p = container.lightProps;
    const col = p.color ?? 0xFFFFFF;
    const r = ((col >> 16) & 0xFF) / 255;
    const gv = ((col >> 8) & 0xFF) / 255;
    const b = (col & 0xFF) / 255;
    const hexCol = col;

    switch (container.lightType) {
        case 'point': {
            const rad = p.radius ?? 200;
            // Outer radius ring (dashed look via many segments)
            g.lineStyle(1, hexCol, 0.35);
            g.drawCircle(0, 0, rad);
            // Falloff gradient rings
            g.lineStyle(1, hexCol, 0.15);
            g.drawCircle(0, 0, rad * 0.66);
            g.lineStyle(1, hexCol, 0.08);
            g.drawCircle(0, 0, rad * 0.33);
            // Center cross + dot
            g.lineStyle(1.5, hexCol, 0.9);
            g.moveTo(-8, 0); g.lineTo(8, 0);
            g.moveTo(0, -8); g.lineTo(0, 8);
            g.lineStyle(0);
            g.beginFill(hexCol, 1); g.drawCircle(0, 0, 3); g.endFill();
            // Inner glow fill
            g.beginFill(hexCol, 0.07); g.drawCircle(0, 0, rad); g.endFill();
            break;
        }
        case 'spot': {
            const rad = p.radius ?? 250;
            const halfAngle = ((p.angle ?? 45) / 2) * Math.PI / 180;
            const dir = (p.direction ?? 0) * Math.PI / 180;
            const x1 = Math.cos(dir - halfAngle) * rad;
            const y1 = Math.sin(dir - halfAngle) * rad;
            const x2 = Math.cos(dir + halfAngle) * rad;
            const y2 = Math.sin(dir + halfAngle) * rad;
            // Cone outline
            g.lineStyle(1.5, hexCol, 0.7);
            g.moveTo(0, 0); g.lineTo(x1, y1);
            g.moveTo(0, 0); g.lineTo(x2, y2);
            // Arc
            g.lineStyle(1, hexCol, 0.5);
            g.arc(0, 0, rad, dir - halfAngle, dir + halfAngle);
            // Fill cone
            g.lineStyle(0);
            g.beginFill(hexCol, 0.08);
            g.moveTo(0, 0); g.lineTo(x1, y1);
            g.arc(0, 0, rad, dir - halfAngle, dir + halfAngle);
            g.lineTo(0, 0); g.endFill();
            // Center dot
            g.beginFill(hexCol, 1); g.drawCircle(0, 0, 4); g.endFill();
            // Direction tick
            g.lineStyle(2, hexCol, 0.9);
            g.moveTo(0, 0); g.lineTo(Math.cos(dir) * 20, Math.sin(dir) * 20);
            break;
        }
        case 'directional': {
            const angle = (p.angle ?? 0) * Math.PI / 180;
            const len = 80;
            // Multiple parallel rays
            for (let i = -2; i <= 2; i++) {
                const offX = Math.cos(angle + Math.PI/2) * i * 14;
                const offY = Math.sin(angle + Math.PI/2) * i * 14;
                const alpha = i === 0 ? 0.9 : 0.4 - Math.abs(i) * 0.1;
                g.lineStyle(i === 0 ? 2 : 1, hexCol, alpha);
                g.moveTo(offX, offY);
                g.lineTo(offX + Math.cos(angle) * len, offY + Math.sin(angle) * len);
                // Arrowhead
                if (i === 0) {
                    const ax = offX + Math.cos(angle) * len;
                    const ay = offY + Math.sin(angle) * len;
                    g.moveTo(ax - Math.cos(angle - 0.4) * 10, ay - Math.sin(angle - 0.4) * 10);
                    g.lineTo(ax, ay);
                    g.lineTo(ax - Math.cos(angle + 0.4) * 10, ay - Math.sin(angle + 0.4) * 10);
                }
            }
            // Sun center
            g.lineStyle(0);
            g.beginFill(hexCol, 1); g.drawCircle(0, 0, 8); g.endFill();
            g.beginFill(hexCol, 0.2); g.drawCircle(0, 0, 16); g.endFill();
            break;
        }
        case 'area': {
            const hw = (p.width ?? 150) / 2;
            const hh = (p.height ?? 80) / 2;
            // Filled rect
            g.lineStyle(0);
            g.beginFill(hexCol, 0.08); g.drawRoundedRect(-hw, -hh, hw*2, hh*2, 4); g.endFill();
            // Outline
            g.lineStyle(1.5, hexCol, 0.7);
            g.drawRoundedRect(-hw, -hh, hw*2, hh*2, 4);
            // Center cross
            g.lineStyle(1, hexCol, 0.5);
            g.moveTo(-hw, 0); g.lineTo(hw, 0);
            g.moveTo(0, -hh); g.lineTo(0, hh);
            // Center dot
            g.lineStyle(0);
            g.beginFill(hexCol, 1); g.drawCircle(0, 0, 3); g.endFill();
            // Rays downward from surface
            for (let i = -2; i <= 2; i++) {
                const rx = (hw * 0.4) * i / 2;
                g.lineStyle(1, hexCol, 0.3);
                g.moveTo(rx, hh); g.lineTo(rx, hh + 24);
            }
            break;
        }
    }

    container._lightHelper = g;
    container.addChildAt(g, 0);
}

// ── Translate-only gizmo for lights ─────────────────────────
function _attachTranslateGizmo(container) {
    const gizmoContainer = new PIXI.Container();
    container.addChild(gizmoContainer);
    container._gizmoContainer = gizmoContainer;

    const transX = _makeAxisLine(0xFF4F4B, 50, false); transX.cursor = 'ew-resize';
    const transY = _makeAxisLine(0x8FC93A, 50, true);  transY.cursor = 'ns-resize';
    const transCenter = _makeSquareHandle(0xFFFFFF, 0.4, 'move');
    const grpTranslate = new PIXI.Container();
    grpTranslate.addChild(transX, transY, transCenter);
    container._grpTranslate = grpTranslate;

    // Rotate ring — same style as sprite gizmo (yellow circle)
    const rotRing = new PIXI.Graphics();
    rotRing.lineStyle(3, 0xFACC15, 0.8);
    rotRing.drawCircle(0, 0, 50);
    rotRing.eventMode = 'static';
    rotRing.cursor    = 'crosshair';
    rotRing.hitArea   = new PIXI.Circle(0, 0, 60);
    const grpRotate = new PIXI.Container();
    grpRotate.addChild(rotRing);
    container._grpRotate = grpRotate;

    // Lights have no scale gizmo
    const grpScale = new PIXI.Container(); grpScale.visible = false;
    container._grpScale = grpScale;

    gizmoContainer.addChild(grpTranslate, grpRotate, grpScale);
    container._gizmoHandles = {
        transX, transY, transCenter,
        rotRing,
        scaleX: transX, scaleY: transY, scaleCenter: transCenter,
    };

    // Stop propagation so gizmo handles don't bubble to stage deselect
    [transX, transY, transCenter, rotRing].forEach(h => {
        h.on('pointerdown', e => e.stopPropagation());
    });

    container.cursor = 'pointer';
    grpTranslate.visible = true;
    // grpRotate visibility set by selectObject / setGizmoMode
}

function _makeLightSelectable(container) {
    container.eventMode = 'static';
    // Keep helper non-interactive so gizmo handles (which sit on top) receive events.
    // The container itself catches clicks that miss the gizmo handles.
    container._lightHelper.eventMode = 'none';

    container.on('pointerdown', (e) => {
        if (state.isPlaying) { e.stopPropagation(); return; }
        if (e.button !== 0) return;
        e.stopPropagation();
        import('./engine.objects.js').then(m => m.selectObject(container));
    });
}

// ── Show/hide helpers in play mode ──────────────────────────
export function setLightHelpersVisible(visible) {
    for (const obj of state.gameObjects) {
        if (!obj.isLight) continue;
        if (obj._lightHelper) obj._lightHelper.visible = visible;
        if (obj._gizmoContainer) obj._gizmoContainer.visible = visible && (obj === state.gameObject);
    }
}

// ============================================================
//  DYNAMIC 2D LIGHTING COMPOSITOR
//  - Builds an offscreen "darkness" RenderTexture filled with
//    ambient color, then ADD-blends each light's contribution
//    using cached gradient/cone/area textures. The result is
//    blitted over the scene with MULTIPLY → unlit areas darken,
//    lit areas reveal full color.
//  - A second additive "bloom" pass on top gives soft halos.
// ============================================================

const _lightTexCache = new Map();
let _lightingInited  = false;
let _lightingTickerFn = null;

// Editor ambient is brighter so the scene stays workable; play mode
// drops to a dramatic dark ambient so lights pop.
const AMBIENT_EDIT = 0x6e6e80;
const AMBIENT_PLAY = 0x0e0e1a;

export function initLighting() {
    if (_lightingInited || !state.app) return;
    const { app } = state;
    const w = Math.max(1, app.screen.width);
    const h = Math.max(1, app.screen.height);
    const res = app.renderer.resolution;

    state.lightingMaskRT     = PIXI.RenderTexture.create({ width: w, height: h, resolution: res });
    state.lightingMaskSprite = new PIXI.Sprite(state.lightingMaskRT);
    state.lightingMaskSprite.blendMode = PIXI.BLEND_MODES.MULTIPLY;
    state.lightingMaskSprite.eventMode = 'none';

    state.lightingGlowRT     = PIXI.RenderTexture.create({ width: w, height: h, resolution: res });
    state.lightingGlowSprite = new PIXI.Sprite(state.lightingGlowRT);
    state.lightingGlowSprite.blendMode = PIXI.BLEND_MODES.ADD;
    state.lightingGlowSprite.eventMode = 'none';

    // Sit on top of the scene container, below any future overlay UI
    app.stage.addChild(state.lightingMaskSprite);
    app.stage.addChild(state.lightingGlowSprite);

    state._lightingScratch = new PIXI.Container();

    _lightingTickerFn = _renderLightingFrame;
    app.ticker.add(_lightingTickerFn);

    app.renderer.on('resize', _onLightingResize);
    _lightingInited = true;
}

function _onLightingResize() {
    const { app } = state;
    if (!state.lightingMaskRT) return;
    const w = Math.max(1, app.screen.width);
    const h = Math.max(1, app.screen.height);
    state.lightingMaskRT.resize(w, h);
    state.lightingGlowRT.resize(w, h);
    // Resize shadow canvas too
    if (state._shadowCanvas) {
        state._shadowCanvas.width  = w;
        state._shadowCanvas.height = h;
    }
}

// ── Shadow canvas (2D, CPU ray-cast) ──────────────────────────
function _ensureShadowCanvas() {
    if (state._shadowCanvas) return;
    const c = document.createElement('canvas');
    c.width  = Math.max(1, state.app.screen.width);
    c.height = Math.max(1, state.app.screen.height);
    state._shadowCanvas = c;
    state._shadowCtx    = c.getContext('2d');
    // PIXI texture that wraps the canvas — updated each frame
    state._shadowTex    = PIXI.Texture.from(c);
    state._shadowSprite = new PIXI.Sprite(state._shadowTex);
    state._shadowSprite.blendMode = PIXI.BLEND_MODES.MULTIPLY;
    state._shadowSprite.eventMode = 'none';
    // Insert between the mask and glow sprites
    const idx = state.app.stage.children.indexOf(state.lightingGlowSprite);
    state.app.stage.addChildAt(state._shadowSprite, idx);
}

// ── Collect occluder AABBs in screen space ────────────────────
function _getOccluders() {
    const sc = state.sceneContainer;
    const occluders = [];
    for (const obj of state.gameObjects) {
        if (obj.isLight) continue;
        if (obj.lightProps?.castsShadow === false) continue; // explicit opt-out
        // Only sprite objects cast shadows (tilemaps can opt in too)
        if (!obj.isImage && !obj.isTilemap) continue;

        try {
            const b = obj.getBounds(); // screen-space AABB
            if (b.width < 2 || b.height < 2) continue;
            occluders.push({
                x: b.x, y: b.y, w: b.width, h: b.height,
                // 4 corner points for the AABB
                corners: [
                    { x: b.x,          y: b.y },
                    { x: b.x + b.width,y: b.y },
                    { x: b.x + b.width,y: b.y + b.height },
                    { x: b.x,          y: b.y + b.height },
                ],
                // 4 segments
                segments: [
                    [{ x: b.x,          y: b.y },          { x: b.x + b.width, y: b.y }],
                    [{ x: b.x + b.width,y: b.y },          { x: b.x + b.width, y: b.y + b.height }],
                    [{ x: b.x + b.width,y: b.y + b.height },{ x: b.x,          y: b.y + b.height }],
                    [{ x: b.x,          y: b.y + b.height },{ x: b.x,          y: b.y }],
                ],
            });
        } catch (_) {}
    }
    return occluders;
}

// ── Ray-segment intersection (returns t along ray, or Infinity) ─
function _raySegIntersect(ox, oy, dx, dy, ax, ay, bx, by) {
    const r_dx = dx, r_dy = dy;
    const s_dx = bx - ax, s_dy = by - ay;
    const denom = r_dx * s_dy - r_dy * s_dx;
    if (Math.abs(denom) < 1e-10) return Infinity;
    const t = ((ax - ox) * s_dy - (ay - oy) * s_dx) / denom;
    const u = ((ax - ox) * r_dy - (ay - oy) * r_dx) / denom;
    if (t >= 0 && u >= 0 && u <= 1) return t;
    return Infinity;
}

// ── Build visibility polygon for one light ────────────────────
function _buildVisibilityPolygon(lx, ly, radius, occluders, screenW, screenH) {
    // Boundary segments (screen edges, slightly padded)
    const pad = 2;
    const boundary = [
        [{ x: -pad,     y: -pad      }, { x: screenW+pad, y: -pad       }],
        [{ x: screenW+pad,y: -pad    }, { x: screenW+pad,  y: screenH+pad}],
        [{ x: screenW+pad,y:screenH+pad},{ x: -pad,        y: screenH+pad}],
        [{ x: -pad,     y:screenH+pad}, { x: -pad,         y: -pad       }],
    ];

    const allSegs = [
        ...boundary,
        ...occluders.flatMap(o => o.segments),
    ];

    // Unique angles to cast rays toward — occluder corners + tiny offsets
    const angles = new Set();
    const boundaryCorners = [
        { x: -pad, y: -pad }, { x: screenW+pad, y: -pad },
        { x: screenW+pad, y: screenH+pad }, { x: -pad, y: screenH+pad },
    ];
    const allCorners = [
        ...boundaryCorners,
        ...occluders.flatMap(o => o.corners),
    ];

    for (const c of allCorners) {
        const a = Math.atan2(c.y - ly, c.x - lx);
        angles.add(a - 0.0001);
        angles.add(a);
        angles.add(a + 0.0001);
    }

    // Cast each ray, find closest intersection
    const hits = [];
    for (const angle of angles) {
        const dx = Math.cos(angle);
        const dy = Math.sin(angle);

        let minT = Infinity;
        for (const seg of allSegs) {
            const t = _raySegIntersect(lx, ly, dx, dy, seg[0].x, seg[0].y, seg[1].x, seg[1].y);
            if (t < minT) minT = t;
        }
        if (minT === Infinity) minT = radius * 2;
        // Clamp to radius
        const clampedT = Math.min(minT, radius);
        hits.push({ angle, x: lx + dx * clampedT, y: ly + dy * clampedT });
    }

    // Sort by angle
    hits.sort((a, b) => a.angle - b.angle);
    return hits;
}

// ── Draw shadow layer for one frame ──────────────────────────
function _renderShadowFrame(lights, occluders) {
    _ensureShadowCanvas();
    const c    = state._shadowCanvas;
    const ctx  = state._shadowCtx;
    const w    = c.width;
    const h    = c.height;

    // Start fully lit (white = no darkening in MULTIPLY)
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    const shadowCasters = lights.filter(L =>
        L.lightProps?.castShadows &&
        (L.lightType === 'point' || L.lightType === 'spot') &&
        L.lightProps?.enabled
    );

    if (!shadowCasters.length) {
        // No shadow lights — leave canvas white (neutral MULTIPLY)
        state._shadowSprite.visible = false;
        state._shadowTex.update();
        return;
    }
    state._shadowSprite.visible = true;

    for (const L of shadowCasters) {
        const p   = L.lightProps;
        const pos = state.sceneContainer.toGlobal(new PIXI.Point(L.x, L.y));
        const lx  = pos.x, ly = pos.y;
        const camScale = state.sceneContainer.scale.x;
        const radius   = (p.radius ?? 200) * camScale;

        // Darken area within radius to shadow-gray, lit polygon will restore it
        // Use a clipping/compositing trick:
        // 1. Draw dark circle (shadow zone) with destination-in or manual polygon

        const poly = _buildVisibilityPolygon(lx, ly, radius, occluders, w, h);
        if (poly.length < 3) continue;

        // Save state
        ctx.save();

        // Draw the dark falloff disk first (this is the "shadow zone")
        // We darken everything within radius, then cut out the lit polygon
        const grd = ctx.createRadialGradient(lx, ly, 0, lx, ly, radius);
        grd.addColorStop(0,   'rgba(0,0,0,0.72)');
        grd.addColorStop(0.6, 'rgba(0,0,0,0.55)');
        grd.addColorStop(1,   'rgba(0,0,0,0)');
        ctx.beginPath();
        ctx.arc(lx, ly, radius, 0, Math.PI * 2);
        ctx.fillStyle = grd;
        ctx.fill();

        // Now cut out the visibility polygon using destination-out on a temp layer
        // i.e. draw lit area brighter: paint white polygon on top (restores white = lit)
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = 'rgba(0,0,0,0.72)'; // match the center shadow strength

        // Lit polygon
        ctx.beginPath();
        ctx.moveTo(poly[0].x, poly[0].y);
        for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
        ctx.closePath();
        ctx.fill();

        ctx.restore();
    }

    // Push updated pixels to PIXI texture
    state._shadowTex.update();
}

function _renderLightingFrame() {
    if (!_lightingInited) return;
    const { app, sceneContainer } = state;
    if (!sceneContainer) return;

    const lights = state.gameObjects.filter(o => o.isLight && o.lightProps?.enabled);

    if (!lights.length) {
        state.lightingMaskSprite.visible = false;
        state.lightingGlowSprite.visible = false;
        if (state._shadowSprite) state._shadowSprite.visible = false;
        return;
    }
    state.lightingMaskSprite.visible = true;
    state.lightingGlowSprite.visible = true;

    const scratch = state._lightingScratch;
    scratch.removeChildren();

    // ── Pass 1: darkness mask (MULTIPLY) ──────────────────
    const ambient = state.isPlaying ? (state.ambientPlay ?? AMBIENT_PLAY)
                                    : (state.ambientEdit ?? AMBIENT_EDIT);
    const base = new PIXI.Sprite(PIXI.Texture.WHITE);
    base.tint = ambient;
    base.width  = app.screen.width;
    base.height = app.screen.height;
    scratch.addChild(base);

    for (const L of lights) {
        const s = _buildLightContribution(L, false);
        if (s) scratch.addChild(s);
    }
    app.renderer.render(scratch, { renderTexture: state.lightingMaskRT, clear: true });

    // ── Pass 2: bloom/glow (ADD) ──────────────────────────
    scratch.removeChildren();
    for (const L of lights) {
        const s = _buildLightContribution(L, true);
        if (s) scratch.addChild(s);
    }
    app.renderer.render(scratch, { renderTexture: state.lightingGlowRT, clear: true });

    // ── Pass 3: shadows (MULTIPLY canvas overlay) ─────────
    const occluders = _getOccluders();
    _renderShadowFrame(lights, occluders);
}

function _buildLightContribution(L, forGlow) {
    const p = L.lightProps;
    if (!p) return null;
    const camScale = state.sceneContainer.scale.x;

    // Scene-local → screen position
    const pos = state.sceneContainer.toGlobal(new PIXI.Point(L.x, L.y));

    // Glow contribution is softer and slightly tinted-up
    const intensityMul = forGlow ? 0.45 : 1.0;
    const baseIntensity = (p.intensity ?? 1) * intensityMul;

    if (L.lightType === 'directional') {
        // A directional/sun light tints everything additively.
        // We bias the tint toward the light direction with a soft gradient.
        const tex = _getDirectionalTexture(p.softness ?? 0.3);
        const s = new PIXI.Sprite(tex);
        s.anchor.set(0.5);
        s.width  = state.app.screen.width  * 1.5;
        s.height = state.app.screen.height * 1.5;
        s.x = state.app.screen.width  / 2;
        s.y = state.app.screen.height / 2;
        s.rotation = ((p.angle ?? 0) * Math.PI) / 180;
        s.tint = p.color ?? 0xFFFFFF;
        s.blendMode = PIXI.BLEND_MODES.ADD;
        s.alpha = Math.min(1.0, baseIntensity * 0.6);
        return s;
    }

    let tex, w, h, rotation = 0;
    if (L.lightType === 'point') {
        tex = _getPointTexture(p.falloff ?? 2);
        const r = (p.radius ?? 200) * camScale * 2;
        w = h = r;
    } else if (L.lightType === 'spot') {
        tex = _getSpotTexture(p.angle ?? 45, p.falloff ?? 1.8);
        const r = (p.radius ?? 250) * camScale * 2;
        w = h = r;
        rotation = ((p.direction ?? 0) * Math.PI) / 180;
    } else if (L.lightType === 'area') {
        tex = _getAreaTexture(p.falloff ?? 1.5);
        // Soft texture is square; stretch to width/height with a bit of bleed
        w = (p.width  ?? 150) * camScale * 1.8;
        h = (p.height ?? 80)  * camScale * 1.8;
    } else {
        return null;
    }

    const s = new PIXI.Sprite(tex);
    s.anchor.set(0.5);
    s.x = pos.x;
    s.y = pos.y;
    s.width  = w;
    s.height = h;
    s.rotation = rotation;
    s.tint = p.color ?? 0xFFFFFF;
    s.blendMode = PIXI.BLEND_MODES.ADD;
    s.alpha = Math.min(2.0, baseIntensity);
    return s;
}

// Cached gradient textures ────────────────────────────────────
function _getPointTexture(falloff) {
    const key = `point:${Math.round(falloff * 10)}`;
    if (_lightTexCache.has(key)) return _lightTexCache.get(key);
    const size = 256;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const cx = size / 2, cy = size / 2;
    const img = ctx.createImageData(size, size);
    const data = img.data;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = (x - cx) / cx, dy = (y - cy) / cy;
            const d = Math.sqrt(dx * dx + dy * dy);
            const t = Math.max(0, 1 - d);
            const a = Math.pow(t, falloff);
            const i = (y * size + x) * 4;
            data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
            data[i + 3] = (a * 255) | 0;
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = PIXI.Texture.from(c);
    _lightTexCache.set(key, tex);
    return tex;
}

function _getSpotTexture(angleDeg, falloff) {
    const key = `spot:${Math.round(angleDeg)}:${Math.round(falloff * 10)}`;
    if (_lightTexCache.has(key)) return _lightTexCache.get(key);
    const size = 256;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const cx = size / 2, cy = size / 2;
    const halfRad = (angleDeg / 2) * Math.PI / 180;
    const img = ctx.createImageData(size, size);
    const data = img.data;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = (x - cx) / cx, dy = (y - cy) / cy;
            const d = Math.sqrt(dx * dx + dy * dy);
            let a = 0;
            if (d <= 1 && (dx !== 0 || dy !== 0)) {
                // Cone axis points along +X (rotation handled by sprite)
                const ang = Math.atan2(dy, dx);
                const aa = Math.abs(ang);
                const angT = 1 - Math.min(1, aa / halfRad);
                // Soft edge on the cone sides
                const angSoft = Math.pow(Math.max(0, angT), 1.3);
                const radSoft = Math.pow(1 - d, falloff);
                a = angSoft * radSoft;
            }
            const i = (y * size + x) * 4;
            data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
            data[i + 3] = (Math.min(1, a) * 255) | 0;
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = PIXI.Texture.from(c);
    _lightTexCache.set(key, tex);
    return tex;
}

function _getAreaTexture(falloff) {
    const key = `area:${Math.round(falloff * 10)}`;
    if (_lightTexCache.has(key)) return _lightTexCache.get(key);
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const data = img.data;
    const half = size / 2;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            // Squared distance from edge — gives a soft rectangle with rounded corners
            const fx = Math.max(0, Math.abs(x - half) / half);
            const fy = Math.max(0, Math.abs(y - half) / half);
            const d  = Math.sqrt(fx * fx + fy * fy) * 0.85 + Math.max(fx, fy) * 0.15;
            const a  = Math.pow(Math.max(0, 1 - d), falloff);
            const i  = (y * size + x) * 4;
            data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
            data[i + 3] = (Math.min(1, a) * 255) | 0;
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = PIXI.Texture.from(c);
    _lightTexCache.set(key, tex);
    return tex;
}

function _getDirectionalTexture(softness) {
    const key = `dir:${Math.round(softness * 100)}`;
    if (_lightTexCache.has(key)) return _lightTexCache.get(key);
    const size = 256;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const data = img.data;
    // Gradient that brightens toward +X side, softness widens the bright band
    const sharpness = 1 + (1 - Math.min(1, Math.max(0, softness))) * 4;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const tx = x / (size - 1);     // 0 (left/back) → 1 (right/front)
            const a  = Math.pow(tx, sharpness);
            const i  = (y * size + x) * 4;
            data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
            data[i + 3] = (Math.min(1, a) * 255) | 0;
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = PIXI.Texture.from(c);
    _lightTexCache.set(key, tex);
    return tex;
}

// Legacy entry point — kept for older callers
export function applyLighting() { initLighting(); }

// ── Inspector HTML for a light object ───────────────────────
export function buildLightInspectorHTML(obj) {
    if (!obj?.isLight) return '';
    const p = obj.lightProps;
    const type = obj.lightType;

    const hexColor = '#' + (p.color >>> 0).toString(16).padStart(6, '0').slice(-6);
    const pct = v => Math.round(v * 100);

    let typeSpecific = '';
    if (type === 'point') {
        typeSpecific = `
        <div class="prop-row">
            <span class="prop-label">Radius</span>
            <input type="range" id="li-radius" min="10" max="800" step="5" value="${p.radius}" class="light-slider">
            <span id="li-radius-val" class="prop-val">${p.radius}px</span>
        </div>
        <div class="prop-row">
            <span class="prop-label">Falloff</span>
            <input type="range" id="li-falloff" min="0.5" max="5" step="0.1" value="${p.falloff}" class="light-slider">
            <span id="li-falloff-val" class="prop-val">${p.falloff.toFixed(1)}</span>
        </div>
        <div class="prop-row" style="margin-top:4px;">
            <span class="prop-label">Cast Shadows</span>
            <input type="checkbox" id="li-cast-shadows" ${p.castShadows ? 'checked' : ''} style="accent-color:#facc15;width:14px;height:14px;">
        </div>`;
    } else if (type === 'spot') {
        typeSpecific = `
        <div class="prop-row">
            <span class="prop-label">Radius</span>
            <input type="range" id="li-radius" min="20" max="800" step="5" value="${p.radius}" class="light-slider">
            <span id="li-radius-val" class="prop-val">${p.radius}px</span>
        </div>
        <div class="prop-row">
            <span class="prop-label">Angle</span>
            <input type="range" id="li-angle" min="5" max="170" step="1" value="${p.angle}" class="light-slider">
            <span id="li-angle-val" class="prop-val">${p.angle}°</span>
        </div>
        <div class="prop-row">
            <span class="prop-label">Direction</span>
            <input type="range" id="li-direction" min="0" max="360" step="1" value="${p.direction}" class="light-slider">
            <span id="li-direction-val" class="prop-val">${p.direction}°</span>
        </div>
        <div class="prop-row">
            <span class="prop-label">Falloff</span>
            <input type="range" id="li-falloff" min="0.5" max="5" step="0.1" value="${p.falloff}" class="light-slider">
            <span id="li-falloff-val" class="prop-val">${p.falloff.toFixed(1)}</span>
        </div>
        <div class="prop-row" style="margin-top:4px;">
            <span class="prop-label">Cast Shadows</span>
            <input type="checkbox" id="li-cast-shadows" ${p.castShadows ? 'checked' : ''} style="accent-color:#facc15;width:14px;height:14px;">
        </div>`;
    } else if (type === 'directional') {
        typeSpecific = `
        <div class="prop-row">
            <span class="prop-label">Angle</span>
            <input type="range" id="li-angle" min="0" max="360" step="1" value="${p.angle}" class="light-slider">
            <span id="li-angle-val" class="prop-val">${p.angle}°</span>
        </div>
        <div class="prop-row">
            <span class="prop-label">Softness</span>
            <input type="range" id="li-softness" min="0" max="1" step="0.05" value="${p.softness}" class="light-slider">
            <span id="li-softness-val" class="prop-val">${p.softness.toFixed(2)}</span>
        </div>`;
    } else if (type === 'area') {
        typeSpecific = `
        <div class="prop-row">
            <span class="prop-label">Width</span>
            <input type="range" id="li-width" min="20" max="600" step="5" value="${p.width}" class="light-slider">
            <span id="li-width-val" class="prop-val">${p.width}px</span>
        </div>
        <div class="prop-row">
            <span class="prop-label">Height</span>
            <input type="range" id="li-height" min="20" max="400" step="5" value="${p.height}" class="light-slider">
            <span id="li-height-val" class="prop-val">${p.height}px</span>
        </div>
        <div class="prop-row">
            <span class="prop-label">Falloff</span>
            <input type="range" id="li-falloff" min="0.5" max="5" step="0.1" value="${p.falloff}" class="light-slider">
            <span id="li-falloff-val" class="prop-val">${p.falloff.toFixed(1)}</span>
        </div>`;
    }

    return `
    <div class="component-block" id="inspector-light-section">
        <div class="component-header">
            <div class="flex items-center gap-2">
                <input type="checkbox" id="li-enabled" ${p.enabled ? 'checked' : ''} style="accent-color:#facc15;">
                <svg viewBox="0 0 24 24" class="icon-stroke" style="color:#facc15;"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
                <span style="font-weight:600; color:#facc15;">${LIGHT_TYPES[type]?.label || 'Light'}</span>
            </div>
        </div>
        <div class="component-body">
            <div class="prop-row">
                <span class="prop-label">Color</span>
                <input type="color" id="li-color" value="${hexColor}">
            </div>
            <div class="prop-row">
                <span class="prop-label">Intensity</span>
                <input type="range" id="li-intensity" min="0" max="3" step="0.05" value="${p.intensity}" class="light-slider">
                <span id="li-intensity-val" class="prop-val">${p.intensity.toFixed(2)}</span>
            </div>
            ${typeSpecific}
        </div>
    </div>`;
}

// ── Bind light inspector events ──────────────────────────────
export function bindLightInspector(obj) {
    if (!obj?.isLight) return;
    const p = obj.lightProps;

    const bind = (id, prop, parse, fmtId, fmt) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', () => {
            p[prop] = parse(el.value);
            const valEl = document.getElementById(fmtId);
            if (valEl) valEl.textContent = fmt(p[prop]);
            _buildLightHelper(obj);
        });
    };

    const col = document.getElementById('li-color');
    if (col) col.addEventListener('input', () => {
        p.color = parseInt(col.value.replace('#', ''), 16);
        _buildLightHelper(obj);
    });

    const en = document.getElementById('li-enabled');
    if (en) en.addEventListener('change', () => {
        p.enabled = en.checked;
        if (obj._lightHelper) obj._lightHelper.alpha = p.enabled ? 1 : 0.3;
    });

    const cs = document.getElementById('li-cast-shadows');
    if (cs) cs.addEventListener('change', () => { p.castShadows = cs.checked; });

    bind('li-intensity', 'intensity', parseFloat, 'li-intensity-val', v => v.toFixed(2));
    bind('li-radius',    'radius',    parseFloat, 'li-radius-val',    v => v + 'px');
    bind('li-angle',     'angle',     parseFloat, 'li-angle-val',     v => v + '°');
    bind('li-direction', 'direction', parseFloat, 'li-direction-val', v => v + '°');
    bind('li-falloff',   'falloff',   parseFloat, 'li-falloff-val',   v => v.toFixed(1));
    bind('li-softness',  'softness',  parseFloat, 'li-softness-val',  v => v.toFixed(2));
    bind('li-width',     'width',     parseFloat, 'li-width-val',     v => v + 'px');
    bind('li-height',    'height',    parseFloat, 'li-height-val',    v => v + 'px');
}

// ── Snapshot helpers ─────────────────────────────────────────
export function snapshotLight(obj) {
    return {
        isLight: true, lightType: obj.lightType,
        label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
        lightProps: JSON.parse(JSON.stringify(obj.lightProps)),
    };
}

export async function restoreLight(s) {
    const obj = createLight(s.lightType, s.x, s.y);
    obj.label = s.label;
    obj.unityZ = s.unityZ || 0;
    obj.lightProps = JSON.parse(JSON.stringify(s.lightProps));
    // Ensure castShadows default exists for older snapshots
    if (obj.lightProps.castShadows === undefined &&
        (s.lightType === 'point' || s.lightType === 'spot')) {
        obj.lightProps.castShadows = false;
    }
    _buildLightHelper(obj);
    return obj;
}

// ── Internal helpers ─────────────────────────────────────────
function _nameUtils() {
    return {
        _uniqueLightName(base) {
            const existing = new Set(state.gameObjects.map(o => o.label));
            if (!existing.has(base)) return base;
            let i = 2;
            while (existing.has(`${base} (${i})`)) i++;
            return `${base} (${i})`;
        }
    };
}

function _makeAxisLine(color, length, isY) {
    const g = new PIXI.Graphics();
    g.beginFill(color);
    g.lineStyle(2, color);
    if (isY) g.drawRect(-1, -length, 2, length);
    else     g.drawRect(0, -1, length, 2);
    g.lineStyle(0);
    if (isY) { g.moveTo(-6, -length); g.lineTo(0, -length-10); g.lineTo(6, -length); }
    else     { g.moveTo(length, -6);  g.lineTo(length+10, 0);  g.lineTo(length, 6); }
    g.endFill();
    g.eventMode = 'static';
    return g;
}

function _makeSquareHandle(color, alpha, cursor) {
    const g = new PIXI.Graphics();
    g.beginFill(color, alpha); g.drawRect(-7, -7, 14, 14); g.endFill();
    g.eventMode = 'static'; g.cursor = cursor;
    return g;
}
