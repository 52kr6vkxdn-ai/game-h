/* ============================================================
   Zengine — engine.input.js
   Camera controls, gizmo drag, keyboard shortcuts.
   ============================================================ */

import { state, SNAP_GRID } from './engine.state.js';
import { syncPixiToInspector } from './engine.ui.js';
import { deleteSelected } from './engine.objects.js';
import { updateCameraBoundsIfVisible } from './engine.playmode.js';

let _pushUndo = null;
async function _getUndo() {
    if (!_pushUndo) _pushUndo = (await import('./engine.history.js')).pushUndo;
    return _pushUndo;
}

// ── Camera Controls ──────────────────────────────────────────
export function initCameraControls() {
    const canvas = state.app.view;
    let isPanning = false;

    canvas.addEventListener('mousedown', (e) => {
        if (state.isPlaying) return;   // block in play mode
        if (e.button === 1) { isPanning = true; e.preventDefault(); }
    });
    canvas.addEventListener('mouseup',   ()  => { isPanning = false; });
    canvas.addEventListener('mousemove', (e) => {
        if (!isPanning || state.isPlaying) return;
        state.sceneContainer.x += e.movementX;
        state.sceneContainer.y += e.movementY;
        updateCameraBoundsIfVisible();
    });

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (state.isPlaying) return;   // block zoom in play mode
        const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
        const pointer    = state.app.renderer.events.pointer.global;
        const localPos   = state.sceneContainer.toLocal(pointer);

        state.sceneContainer.scale.x *= zoomFactor;
        state.sceneContainer.scale.y *= zoomFactor;

        const newGlobal = state.sceneContainer.toGlobal(localPos);
        state.sceneContainer.x += pointer.x - newGlobal.x;
        state.sceneContainer.y += pointer.y - newGlobal.y;
        updateCameraBoundsIfVisible();
    }, { passive: false });
}

// ── Keyboard Shortcuts ────────────────────────────────────────
export function initKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
        // Ignore when typing in an input, textarea or select
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        // Block editor shortcuts during play mode
        if (state.isPlaying) return;

        switch (e.key) {
            case 'Delete':
            case 'Backspace':
                if (state._selectedAudioSource) {
                    import('./engine.audio.js').then(m => m.removeAudioSource(state._selectedAudioSource));
                } else {
                    deleteSelected();
                }
                break;
            case 'w': case 'W':
                document.getElementById('btn-tool-translate')?.click();
                break;
            case 'e': case 'E':
                document.getElementById('btn-tool-rotate')?.click();
                break;
            case 'r': case 'R':
                document.getElementById('btn-tool-scale')?.click();
                break;
            case 'f': case 'F':
                // Focus editor camera on selected object
                if (state.gameObject) {
                    const obj = state.gameObject;
                    const sc  = state.sceneContainer;
                    const renderer = state.app.renderer;
                    const cx = renderer.width  / 2;
                    const cy = renderer.height / 2;
                    // Get world position of the object
                    const gp = obj.getGlobalPosition ? obj.getGlobalPosition() : { x: obj.x, y: obj.y };
                    // Shift scene container so the object lands at screen centre
                    sc.x += cx - gp.x;
                    sc.y += cy - gp.y;
                    import('./engine.playmode.js').then(m => m.updateCameraBoundsIfVisible?.());
                }
                break;
        }
    });
}

// ── Gizmo Drag ───────────────────────────────────────────────
export function initGizmoDrag() {
    const { app, sceneContainer } = state;

    let activeDrag     = null;
    let dragStartLocal = null;
    let objStartData   = null;
    let activeObj      = null;   // which object is being dragged

    function onDragStart(e, mode, obj) {
        // Block gizmo interaction during play mode
        if (state.isPlaying) { e.stopPropagation(); return; }

        activeObj      = obj;
        activeDrag     = mode;
        dragStartLocal = sceneContainer.toLocal(e.global);
        objStartData   = {
            x:   obj.x,
            y:   obj.y,
            sx:  obj.scale.x,
            sy:  obj.scale.y,
            rot: obj.rotation,
        };

        // Record undo before drag begins
        _getUndo().then(push => push());

        if (mode === 'r') {
            const localCenter = obj.parent.toLocal(obj.getGlobalPosition());
            objStartData.startAngle = Math.atan2(
                dragStartLocal.y - localCenter.y,
                dragStartLocal.x - localCenter.x
            );
        }
        e.stopPropagation();
    }

    function onDragMove(e) {
        if (!activeDrag || !activeObj) return;

        const snap = e.originalEvent?.shiftKey || e.shiftKey || false;
        const currentLocal = sceneContainer.toLocal(e.global);
        const dx = currentLocal.x - dragStartLocal.x;
        const dy = currentLocal.y - dragStartLocal.y;

        const obj = activeObj;

        switch (activeDrag) {
            case 'tC': {
                let nx = objStartData.x + dx;
                let ny = objStartData.y + dy;
                if (snap) { nx = Math.round(nx / SNAP_GRID) * SNAP_GRID; ny = Math.round(ny / SNAP_GRID) * SNAP_GRID; }
                obj.x = nx; obj.y = ny;
                break;
            }
            case 'tX':
            case 'tY': {
                const angle = obj.rotation;
                const isX   = activeDrag === 'tX';
                const axisX = isX ? Math.cos(angle) : Math.cos(angle - Math.PI / 2);
                const axisY = isX ? Math.sin(angle) : Math.sin(angle - Math.PI / 2);
                const proj  = dx * axisX + dy * axisY;
                let nx = objStartData.x + proj * axisX;
                let ny = objStartData.y + proj * axisY;
                if (snap) { nx = Math.round(nx / SNAP_GRID) * SNAP_GRID; ny = Math.round(ny / SNAP_GRID) * SNAP_GRID; }
                obj.x = nx; obj.y = ny;
                break;
            }
            case 'sX':
            case 'sY': {
                const angle = obj.rotation;
                const isX   = activeDrag === 'sX';
                const axisX = isX ? Math.cos(angle) : Math.cos(angle - Math.PI / 2);
                const axisY = isX ? Math.sin(angle) : Math.sin(angle - Math.PI / 2);
                const proj  = dx * axisX + dy * axisY;
                const delta = proj / 50;
                if (isX) obj.scale.x = Math.max(0.05, objStartData.sx + delta);
                else     obj.scale.y = Math.max(0.05, objStartData.sy + delta);
                break;
            }
            case 'sC': {
                const delta = (dx - dy) / 50;
                obj.scale.set(
                    Math.max(0.05, objStartData.sx + delta),
                    Math.max(0.05, objStartData.sy + delta)
                );
                break;
            }
            case 'r': {
                const localCenter  = obj.parent.toLocal(obj.getGlobalPosition());
                const currentAngle = Math.atan2(
                    currentLocal.y - localCenter.y,
                    currentLocal.x - localCenter.x
                );
                let newRot = objStartData.rot + (currentAngle - objStartData.startAngle);
                if (snap) newRot = Math.round(newRot / (Math.PI / 8)) * (Math.PI / 8); // 22.5° snap
                obj.rotation = newRot;
                break;
            }
        }

        syncPixiToInspector();
    }

    function onDragEnd() {
        activeDrag = null;
        activeObj  = null;
        updateCameraBoundsIfVisible();
    }

    // Re-bind whenever the selected object changes by hooking into app ticker
    // We use a single stage listener and dispatch to the active object's handles
    app.stage.eventMode = 'static';
    app.stage.hitArea   = new PIXI.Rectangle(-100000, -100000, 200000, 200000);
    app.stage.on('pointermove',      onDragMove);
    app.stage.on('pointerup',        onDragEnd);
    app.stage.on('pointerupoutside', onDragEnd);

    // Click on empty space → deselect everything + show scene settings
    app.stage.on('pointerdown', (e) => {
        if (state.isPlaying) return;
        if (e.button !== 0) return;
        // Deselect any game object
        if (state.gameObject) {
            const oldGizmo = state.gameObject._gizmoContainer;
            if (oldGizmo) oldGizmo.visible = false;
            state.gameObject = state.gizmoContainer = state.grpTranslate =
                state.grpRotate = state.grpScale = state._gizmoHandles = state.spriteBox = null;
        }
        // Deselect audio source and show scene settings panel in inspector
        import('./engine.ui.js').then(m => m.deselectAudioSource());
    });

    // Store binder so new objects can register
    // Tilemaps / auto-tilemaps: translate-only (no scale, no rotate)
    state._bindGizmoHandles = (obj) => {
        const h = obj._gizmoHandles;
        const isTilelike = obj.isTilemap || obj.isAutoTilemap;
        h.transX.on('pointerdown',      e => onDragStart(e, 'tX', obj));
        h.transY.on('pointerdown',      e => onDragStart(e, 'tY', obj));
        h.transCenter.on('pointerdown', e => onDragStart(e, 'tC', obj));
        if (!isTilelike) {
            // Rotate ring is available for all non-tilemap objects (including lights)
            h.rotRing.on('pointerdown', e => onDragStart(e, 'r', obj));
            // Scale handles only for regular objects (not lights, not tilemaps)
            if (!obj.isLight) {
                h.scaleX.on('pointerdown',      e => onDragStart(e, 'sX', obj));
                h.scaleY.on('pointerdown',      e => onDragStart(e, 'sY', obj));
                h.scaleCenter.on('pointerdown', e => onDragStart(e, 'sC', obj));
            }
        }
    };
}
