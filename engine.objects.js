/* ============================================================
   Zengine — engine.objects.js
   Sprite game object creation (image-based only).
   Shapes removed — all game objects must be image sprites.
   ============================================================ */

import { state } from './engine.state.js';
import { syncPixiToInspector, refreshHierarchy } from './engine.ui.js';

// ── Build the mandatory Idle animation ───────────────────────
function _makeIdleAnim(dataURL, frameName = 'Idle') {
    return {
        id:       'anim_idle_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        name:     'Idle',
        fps:      12,
        loop:     true,
        isIdle:   true,
        frames:   dataURL
            ? [{ id: 'frame_0_' + Date.now(), name: frameName || 'frame_0', dataURL }]
            : [],
    };
}

let _pushUndo = null;
async function _getUndo() {
    if (!_pushUndo) _pushUndo = (await import('./engine.history.js')).pushUndo;
    return _pushUndo;
}

// ── Unique Name Generator ────────────────────────────────────
function _uniqueName(base) {
    const existing = new Set(state.gameObjects.map(o => o.label));
    if (!existing.has(base)) return base;
    let i = 2;
    while (existing.has(`${base} (${i})`)) i++;
    return `${base} (${i})`;
}

// ── Create Image Sprite Object ───────────────────────────────
export function createImageObject(asset, x = 0, y = 0) {
    _getUndo().then(push => push());

    const container  = new PIXI.Container();
    container.x      = x;
    container.y      = y;
    container.unityZ = 0;
    container.label  = _uniqueName(
        asset.name.replace(/\.[^.]+$/, '') || 'Sprite'
    );
    container.shapeKey = null;
    container.isImage  = true;
    container.isLight  = false;
    container.assetId  = asset.id;

    const tex    = PIXI.Texture.from(asset.dataURL);
    const sprite = new PIXI.Sprite(tex);
    sprite.anchor.set(0.5);
    const maxDim = Math.max(tex.width || 100, tex.height || 100);
    sprite.scale.set(100 / maxDim);
    sprite.tint = 0xFFFFFF;
    container.addChild(sprite);
    container.spriteGraphic = sprite;

    // Idle animation: first frame is the imported sprite itself
    container.animations      = [_makeIdleAnim(asset.dataURL, asset.name)];
    container.activeAnimIndex = 0;

    _attachGizmos(container);
    if (state._bindGizmoHandles) state._bindGizmoHandles(container);
    state.sceneContainer.addChild(container);
    state.gameObjects.push(container);
    _makeSelectable(container);

    selectObject(container);
    refreshHierarchy();
    return container;
}

// Keep createShapeObject as a no-op stub so old code doesn't crash
export function createShapeObject(shapeKey, x = 0, y = 0, colorOverride = null) {
    // Shapes are removed — use import to create sprite objects
    console.warn('[Zengine] createShapeObject is disabled. Import an image asset to create a game object.');
    return null;
}

// ── Create Text Object ────────────────────────────────────────
/**
 * Creates a PIXI.Text game object that lives in the scene.
 * Can be used as UI (set unityZ high) or placed anywhere in the world.
 *
 * @param {string}  text        Initial text content
 * @param {number}  x           World X position
 * @param {number}  y           World Y position
 * @param {object}  styleOpts   PIXI TextStyle overrides
 *   fontSize, fontFamily, fill, stroke, strokeThickness, align,
 *   wordWrap, wordWrapWidth, bold, italic, dropShadow, dropShadowColor,
 *   dropShadowBlur, dropShadowDistance
 */
export function createTextObject(text = 'Text', x = 0, y = 0, styleOpts = {}) {
    _getUndo().then(push => push());

    const style = new PIXI.TextStyle({
        fontFamily:       styleOpts.fontFamily       ?? 'Arial',
        fontSize:         styleOpts.fontSize         ?? 32,
        fill:             styleOpts.fill             ?? '#ffffff',
        stroke:           styleOpts.stroke           ?? '#000000',
        strokeThickness:  styleOpts.strokeThickness  ?? 0,
        align:            styleOpts.align            ?? 'left',
        wordWrap:         styleOpts.wordWrap         ?? false,
        wordWrapWidth:    styleOpts.wordWrapWidth    ?? 400,
        fontWeight:       styleOpts.bold             ? 'bold'   : (styleOpts.fontWeight ?? 'normal'),
        fontStyle:        styleOpts.italic           ? 'italic' : (styleOpts.fontStyle  ?? 'normal'),
        dropShadow:       styleOpts.dropShadow       ?? false,
        dropShadowColor:  styleOpts.dropShadowColor  ?? '#000000',
        dropShadowBlur:   styleOpts.dropShadowBlur   ?? 4,
        dropShadowDistance: styleOpts.dropShadowDistance ?? 4,
    });

    const pixiText = new PIXI.Text(String(text), style);
    pixiText.anchor.set(0.5);

    const container = new PIXI.Container();
    container.x      = x;
    container.y      = y;
    container.unityZ = styleOpts.unityZ ?? 999;  // default: render on top like UI
    container.label  = _uniqueName(styleOpts.label ?? 'Text');
    container.isText    = true;
    container.isImage   = false;
    container.isLight   = false;
    container.assetId   = null;
    container.prefabId  = null;
    container.animations = [];
    container.activeAnimIndex = 0;
    container._pixiText  = pixiText;
    container.textContent = String(text);
    container.textStyle   = {
        fontFamily:         style.fontFamily,
        fontSize:           style.fontSize,
        fill:               style.fill,
        stroke:             style.stroke,
        strokeThickness:    style.strokeThickness,
        align:              style.align,
        wordWrap:           style.wordWrap,
        wordWrapWidth:      style.wordWrapWidth,
        fontWeight:         style.fontWeight,
        fontStyle:          style.fontStyle,
        dropShadow:         style.dropShadow,
        dropShadowColor:    style.dropShadowColor,
        dropShadowBlur:     style.dropShadowBlur,
        dropShadowDistance: style.dropShadowDistance,
    };

    // Expose a spriteGraphic shim so the inspector's transform controls work
    container.spriteGraphic = pixiText;
    container.addChild(pixiText);

    _attachGizmos(container);
    if (state._bindGizmoHandles) state._bindGizmoHandles(container);
    state.sceneContainer.addChild(container);
    state.gameObjects.push(container);
    _makeSelectable(container);

    selectObject(container);
    refreshHierarchy();
    return container;
}

/**
 * Update the text content of a text object.
 * Also used by scripting setText() API.
 */
export function setTextContent(obj, text) {
    if (!obj?.isText || !obj._pixiText) return;
    obj.textContent = String(text);
    obj._pixiText.text = String(text);
}

/**
 * Update one or more style properties on a text object.
 */
export function setTextStyle(obj, styleOpts = {}) {
    if (!obj?.isText || !obj._pixiText) return;
    const s = obj._pixiText.style;
    if (styleOpts.fontSize         != null) s.fontSize         = styleOpts.fontSize;
    if (styleOpts.fontFamily       != null) s.fontFamily       = styleOpts.fontFamily;
    if (styleOpts.fill             != null) s.fill             = styleOpts.fill;
    if (styleOpts.stroke           != null) s.stroke           = styleOpts.stroke;
    if (styleOpts.strokeThickness  != null) s.strokeThickness  = styleOpts.strokeThickness;
    if (styleOpts.align            != null) s.align            = styleOpts.align;
    if (styleOpts.wordWrap         != null) s.wordWrap         = styleOpts.wordWrap;
    if (styleOpts.wordWrapWidth    != null) s.wordWrapWidth    = styleOpts.wordWrapWidth;
    if (styleOpts.bold             != null) s.fontWeight       = styleOpts.bold ? 'bold' : 'normal';
    if (styleOpts.italic           != null) s.fontStyle        = styleOpts.italic ? 'italic' : 'normal';
    if (styleOpts.dropShadow       != null) s.dropShadow       = styleOpts.dropShadow;
    if (styleOpts.dropShadowColor  != null) s.dropShadowColor  = styleOpts.dropShadowColor;
    if (styleOpts.dropShadowBlur   != null) s.dropShadowBlur   = styleOpts.dropShadowBlur;
    if (styleOpts.dropShadowDistance != null) s.dropShadowDistance = styleOpts.dropShadowDistance;
    // Mirror to stored textStyle for save/restore
    Object.assign(obj.textStyle, styleOpts);
}

// ── Select Object ─────────────────────────────────────────────
export function selectObject(obj) {
    if (state.gameObject && state.gameObject !== obj) {
        const oldGizmo = state.gameObject._gizmoContainer;
        if (oldGizmo) oldGizmo.visible = false;
    }

    state.gameObject = obj;

    if (obj) {
        const gc = obj._gizmoContainer;
        if (gc) gc.visible = true;

        state.gizmoContainer = obj._gizmoContainer;
        state.grpTranslate   = obj._grpTranslate;
        state.grpRotate      = obj._grpRotate;
        state.grpScale       = obj._grpScale;
        state._gizmoHandles  = obj._gizmoHandles;
        state.spriteBox      = obj.spriteGraphic || null;

        if (obj._grpTranslate) {
            if (obj.isTilemap || obj.isAutoTilemap) {
                // Tilemaps: translate only
                obj._grpTranslate.visible = true;
                obj._grpRotate.visible    = false;
                obj._grpScale.visible     = false;
            } else if (obj.isLight) {
                // Lights: translate + rotate, never scale
                const m = state.gizmoMode || 'translate';
                obj._grpTranslate.visible = m === 'translate' || m === 'all';
                obj._grpRotate.visible    = m === 'rotate'    || m === 'all';
                obj._grpScale.visible     = false;
            } else {
                const m = state.gizmoMode || 'translate';
                obj._grpTranslate.visible = m === 'translate' || m === 'all';
                obj._grpRotate.visible    = m === 'rotate'    || m === 'all';
                obj._grpScale.visible     = m === 'scale'     || m === 'all';
            }
        }
    }

    syncPixiToInspector();
    refreshHierarchy();
}

// ── Delete Selected Object ────────────────────────────────────
export function deleteSelected() {
    const obj = state.gameObject;
    if (!obj) return;

    // Push undo BEFORE we destroy anything — the snapshot must include this object
    import('./engine.history.js').then(({ pushUndo }) => {
        pushUndo();

        const idx = state.gameObjects.indexOf(obj);
        if (idx !== -1) state.gameObjects.splice(idx, 1);

        state.sceneContainer.removeChild(obj);
        try { obj.destroy({ children: true }); } catch(_) {}

        const next = state.gameObjects[Math.min(idx, state.gameObjects.length - 1)] || null;
        state.gameObject = null;
        if (next) selectObject(next);
        else {
            state.gameObject = state.gizmoContainer = state.grpTranslate =
                state.grpRotate = state.grpScale = state._gizmoHandles = state.spriteBox = null;
            syncPixiToInspector();
            refreshHierarchy();
        }
    });
}

// ── Prefab stubs ──────────────────────────────────────────────
export function saveAsPrefab(obj) {
    return import('./engine.prefabs.js').then(m => m.saveAsPrefab(obj));
}
export function instantiatePrefab(prefab, x = 0, y = 0) {
    return import('./engine.prefabs.js').then(m => m.instantiatePrefab(prefab, x, y));
}
export function applyPrefabToAll(prefabId, src) {
    return import('./engine.prefabs.js').then(m => m.applyPrefabToAll(prefabId, src));
}

// ── Z-order ───────────────────────────────────────────────────
export function moveObjectUp(obj) {
    const arr = state.gameObjects, i = arr.indexOf(obj);
    if (i <= 0) return;
    [arr[i-1], arr[i]] = [arr[i], arr[i-1]];
    state.sceneContainer.removeChild(obj);
    state.sceneContainer.addChildAt(obj, state.sceneContainer.children.indexOf(arr[i]));
    refreshHierarchy();
}
export function moveObjectDown(obj) {
    const arr = state.gameObjects, i = arr.indexOf(obj);
    if (i < 0 || i >= arr.length-1) return;
    [arr[i], arr[i+1]] = [arr[i+1], arr[i]];
    state.sceneContainer.removeChild(obj);
    const ref = arr[i];
    state.sceneContainer.addChildAt(obj, state.sceneContainer.children.indexOf(ref)+1);
    refreshHierarchy();
}
export function sortByZ() {
    state.gameObjects.sort((a, b) => (a.unityZ || 0) - (b.unityZ || 0));
    for (const obj of state.gameObjects) {
        state.sceneContainer.removeChild(obj);
        state.sceneContainer.addChild(obj);
    }
    refreshHierarchy();
}

// ── Gizmo attachment ──────────────────────────────────────────
function _attachGizmos(container) {
    const gizmoContainer = new PIXI.Container();
    container.addChild(gizmoContainer);
    container._gizmoContainer = gizmoContainer;

    const transX      = _makeAxisLine(0xFF4F4B,  60, 'arrow', false); transX.cursor = 'ew-resize';
    const transY      = _makeAxisLine(0x8FC93A,  60, 'arrow', true);  transY.cursor = 'ns-resize';
    const transCenter = _makeSquareHandle(0xFFFFFF, 0.4, 'move');
    const grpTranslate = new PIXI.Container();
    grpTranslate.addChild(transX, transY, transCenter);
    container._grpTranslate = grpTranslate;

    const scaleX      = _makeAxisLine(0xFF4F4B, 60, 'square', false); scaleX.cursor = 'ew-resize';
    const scaleY      = _makeAxisLine(0x8FC93A, 60, 'square', true);  scaleY.cursor = 'ns-resize';
    const scaleCenter = _makeSquareHandle(0x999999, 1.0, 'nwse-resize');
    const grpScale = new PIXI.Container();
    grpScale.addChild(scaleX, scaleY, scaleCenter);
    container._grpScale = grpScale;

    const rotRing = new PIXI.Graphics();
    rotRing.lineStyle(3, 0xFACC15, 0.8);
    rotRing.drawCircle(0, 0, 50);
    rotRing.eventMode = 'static';
    rotRing.cursor    = 'crosshair';
    rotRing.hitArea   = new PIXI.Circle(0, 0, 60);
    const grpRotate = new PIXI.Container();
    grpRotate.addChild(rotRing);
    container._grpRotate = grpRotate;

    gizmoContainer.addChild(grpTranslate, grpRotate, grpScale);
    container._gizmoHandles = { transX, transY, transCenter, scaleX, scaleY, scaleCenter, rotRing };

    const m = state.gizmoMode || 'translate';
    grpTranslate.visible = m === 'translate' || m === 'all';
    grpRotate.visible    = m === 'rotate'    || m === 'all';
    grpScale.visible     = m === 'scale'     || m === 'all';
}

function _makeSelectable(container) {
    container.eventMode = 'static';
    let _lastTap = 0;
    container.on('pointerdown', (e) => {
        if (state.isPlaying) { e.stopPropagation(); return; }
        if (e.button === 2) {
            selectObject(container);
            e.stopPropagation();
            _showContextMenu(e.global.x, e.global.y, container);
            return;
        }
        if (e.button !== 0) return;
        selectObject(container);
        e.stopPropagation();
        const now = Date.now();
        if (now - _lastTap < 350) {
            import('./engine.animator.js').then(m => m.openAnimationEditor(container));
        }
        _lastTap = now;
    });
}

function _showContextMenu(screenX, screenY, obj) {
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    const isPrefab = !!obj.prefabId;
    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.style.cssText = `position:fixed;left:${screenX}px;top:${screenY}px;background:#1e1e2e;border:1px solid #3A72A5;border-radius:6px;box-shadow:0 8px 32px rgba(0,0,0,0.8);z-index:99999;font-size:11px;color:#e0e0e0;min-width:190px;padding:4px 0;user-select:none;`;

    const sep = () => { const d = document.createElement('div'); d.style.cssText='border-top:1px solid #2a2a3a;margin:3px 0;'; return d; };
    const row = (svg, label, cb, color='#e0e0e0', disabled=false) => {
        const r = document.createElement('div');
        r.style.cssText=`padding:7px 14px;cursor:${disabled?'default':'pointer'};color:${disabled?'#555':color};display:flex;align-items:center;gap:8px;`;
        r.innerHTML=`<span style="width:16px;flex-shrink:0;">${svg}</span><span>${label}</span>`;
        if (!disabled) {
            r.addEventListener('mouseenter', () => r.style.background='rgba(58,114,165,0.3)');
            r.addEventListener('mouseleave', () => r.style.background='');
            r.addEventListener('click', e => { e.stopPropagation(); menu.remove(); cb(); });
        }
        return r;
    };

    const hdr = document.createElement('div');
    hdr.style.cssText='padding:5px 14px 7px;color:#666;font-size:10px;font-weight:bold;letter-spacing:0.5px;border-bottom:1px solid #2a2a3a;';
    hdr.textContent=(obj.label||'Object').slice(0,24);
    menu.appendChild(hdr);

    const editSvg = `<svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    const delSvg  = `<svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:none;stroke:#f87171;stroke-width:2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>`;
    const animSvg = `<svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
    const upSvg   = `<svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2"><polyline points="18 15 12 9 6 15"/></svg>`;
    const dnSvg   = `<svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2"><polyline points="6 9 12 15 18 9"/></svg>`;

    menu.appendChild(row(editSvg, 'Rename', () => _inlineRenameObj(obj)));
    menu.appendChild(row(delSvg,  'Delete', () => deleteSelected(), '#f87171'));
    menu.appendChild(sep());
    menu.appendChild(row(animSvg, 'Edit Animations…', () => import('./engine.animator.js').then(m => m.openAnimationEditor(obj)), '#9bc'));
    menu.appendChild(sep());
    if (isPrefab) {
        menu.appendChild(row('💾', 'Apply to Prefab', () => import('./engine.prefabs.js').then(m => m.applyInstanceToPrefab(obj)), '#8f8'));
        menu.appendChild(row('🌐', 'Apply to All',     () => import('./engine.prefabs.js').then(m => m.applyPrefabToAll(obj.prefabId, obj)), '#6fc'));
        menu.appendChild(row('↗',  'Unlink from Prefab', () => import('./engine.prefabs.js').then(m => m.unlinkFromPrefab(obj)), '#facc15'));
    } else {
        menu.appendChild(row('📦', 'Save as Prefab', () => import('./engine.prefabs.js').then(m => { m.saveAsPrefab(obj); document.getElementById('tab-prefabs-btn')?.click(); }), '#9bc'));
    }
    menu.appendChild(sep());
    menu.appendChild(row(upSvg, 'Move Up (draw order)',   () => moveObjectUp(obj)));
    menu.appendChild(row(dnSvg, 'Move Down (draw order)', () => moveObjectDown(obj)));

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    if (rect.right  > window.innerWidth)  menu.style.left = (screenX - rect.width)  + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top  = (screenY - rect.height) + 'px';
    const close = e => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', close); } };
    setTimeout(() => document.addEventListener('pointerdown', close), 0);
}

function _inlineRenameObj(obj) {
    const items = document.querySelectorAll('#hierarchy-list .tree-item');
    for (const item of items) {
        const idx = parseInt(item.dataset.objId);
        if (state.gameObjects[idx] === obj) {
            const nameEl = item.querySelector('span');
            if (nameEl) nameEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            break;
        }
    }
}

function _makeAxisLine(color, length, capStyle, isY) {
    const g = new PIXI.Graphics();
    g.beginFill(color); g.lineStyle(2, color);
    if (isY) g.drawRect(-1, -length, 2, length);
    else     g.drawRect(0, -1, length, 2);
    g.lineStyle(0);
    if (capStyle === 'arrow') {
        if (isY) { g.moveTo(-6,-length); g.lineTo(0,-length-12); g.lineTo(6,-length); }
        else     { g.moveTo(length,-6);  g.lineTo(length+12,0);  g.lineTo(length,6); }
    } else {
        if (isY) g.drawRect(-5,-length-10,10,10);
        else     g.drawRect(length,-5,10,10);
    }
    g.endFill();
    g.eventMode = 'static'; g.cursor = 'pointer';
    return g;
}

function _makeSquareHandle(color, alpha, cursor) {
    const g = new PIXI.Graphics();
    g.beginFill(color, alpha); g.drawRect(-8,-8,16,16); g.endFill();
    g.eventMode = 'static'; g.cursor = cursor;
    return g;
}

// SHAPES export kept for any code that references it (now empty)
export const SHAPES = {};
