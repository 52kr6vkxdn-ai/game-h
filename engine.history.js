/* ============================================================
   Zengine — engine.history.js
   Undo / Redo via granular scene snapshots.
   Tracks: object create/delete, number input changes,
   audio source changes, and scene setting changes.
   ============================================================ */

import { state } from './engine.state.js';

const MAX_HISTORY = 50;

// ── Capture full scene ────────────────────────────────────────
function _captureScene() {
    return {
        objects: state.gameObjects.map(obj => {
            if (obj.isLight) {
                return {
                    isLight: true, lightType: obj.lightType,
                    label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
                    lightProps: JSON.parse(JSON.stringify(obj.lightProps)),
                };
            }
            if (obj.isTilemap) {
                return {
                    isTilemap: true, label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
                    tilemapData: { ...obj.tilemapData, tiles: Array.from(obj.tilemapData.tiles) },
                };
            }
            return {
                label: obj.label, isImage: obj.isImage, assetId: obj.assetId,
                prefabId: obj.prefabId || null,
                x: obj.x, y: obj.y, scaleX: obj.scale.x, scaleY: obj.scale.y,
                rotation: obj.rotation, unityZ: obj.unityZ || 0,
                tint: obj.spriteGraphic?.tint ?? 0xFFFFFF,
                visible: obj.visible !== false,
                alpha: obj.alpha ?? 1,
                scriptName:  obj.scriptName  ?? null,
                scriptTag:   obj._scriptTag  ?? null,
                scriptGroup: obj._scriptGroup ?? null,
                animations: obj.animations ? JSON.parse(JSON.stringify(obj.animations)) : [],
                activeAnimIndex: obj.activeAnimIndex || 0,
                // ── Physics ───────────────────────────────────────────
                physicsBody:              obj.physicsBody              ?? 'none',
                physicsShape:             obj.physicsShape             ?? 'box',
                physicsFriction:          obj.physicsFriction          ?? 0.3,
                physicsRestitution:       obj.physicsRestitution       ?? 0.1,
                physicsDensity:           obj.physicsDensity           ?? 0.001,
                physicsGravityScale:      obj.physicsGravityScale      ?? 1,
                physicsGravityXScale:     obj.physicsGravityXScale     ?? 1,
                physicsLinearDamping:     obj.physicsLinearDamping     ?? 0,
                physicsAngularDamping:    obj.physicsAngularDamping    ?? 0,
                physicsFixedRotation:     !!obj.physicsFixedRotation,
                physicsIsSensor:          !!obj.physicsIsSensor,
                physicsCollisionCategory: obj.physicsCollisionCategory ?? 1,
                physicsCollisionMask:     obj.physicsCollisionMask     ?? -1,
                physicsSize:     obj.physicsSize     ? JSON.parse(JSON.stringify(obj.physicsSize))     : null,
                physicsPolygon:  obj.physicsPolygon  ? JSON.parse(JSON.stringify(obj.physicsPolygon))  : null,
                physicsPolygons: obj.physicsPolygons ? JSON.parse(JSON.stringify(obj.physicsPolygons)) : null,
                _polyUnit:       obj._polyUnit || null,
                _collisionShapeInit: !!obj._collisionShapeInit,
            };
        }),
        audioSources: state.audioSources.map(s => ({
            id: s.id, assetId: s.assetId, label: s.label,
            x: s.x, y: s.y, range: s.range, volume: s.volume, loop: s.loop,
        })),
        sceneSettings: JSON.parse(JSON.stringify(state.sceneSettings)),
        camX:      state.sceneContainer?.x       ?? 0,
        camY:      state.sceneContainer?.y       ?? 0,
        camScaleX: state.sceneContainer?.scale.x ?? 1,
        camScaleY: state.sceneContainer?.scale.y ?? 1,
        selectedLabel:     state.gameObject?.label ?? null,
        selectedAudioId:   state._selectedAudioSource?.id ?? null,
    };
}

// ── Push a checkpoint BEFORE a change ────────────────────────
export function pushUndo() {
    if (state.isPlaying || state._applyingHistory) return;
    const snap = _captureScene();
    state.undoStack.push(snap);
    if (state.undoStack.length > MAX_HISTORY) state.undoStack.shift();
    state.redoStack = [];
    _updateUndoButtons();
}

// ── Undo ─────────────────────────────────────────────────────
export function undo() {
    if (state.isPlaying || state.undoStack.length === 0) return;
    state.redoStack.push(_captureScene());
    const snap = state.undoStack.pop();
    _applyScene(snap);
    _updateUndoButtons();
}

// ── Redo ─────────────────────────────────────────────────────
export function redo() {
    if (state.isPlaying || state.redoStack.length === 0) return;
    state.undoStack.push(_captureScene());
    const snap = state.redoStack.pop();
    _applyScene(snap);
    _updateUndoButtons();
}

// ── Apply snapshot ────────────────────────────────────────────
function _applyScene(snap) {
    state._applyingHistory = true;

    // Clear objects
    for (const obj of state.gameObjects) {
        state.sceneContainer.removeChild(obj);
        try { obj.destroy({ children: true }); } catch (_) {}
    }
    state.gameObjects    = [];
    state.gameObject     = null;
    state.gizmoContainer = null;
    state.grpTranslate   = null;
    state.grpRotate      = null;
    state.grpScale       = null;
    state._gizmoHandles  = null;
    state.spriteBox      = null;

    // Restore camera
    if (state.sceneContainer) {
        state.sceneContainer.x       = snap.camX      ?? state.app.screen.width  / 2;
        state.sceneContainer.y       = snap.camY      ?? state.app.screen.height / 2;
        state.sceneContainer.scale.x = snap.camScaleX ?? 1;
        state.sceneContainer.scale.y = snap.camScaleY ?? 1;
    }

    // Restore scene settings
    if (snap.sceneSettings) {
        Object.assign(state.sceneSettings, snap.sceneSettings);
        import('./engine.ui.js').then(m => m.refreshSceneSettingsPanel());
        _applyBgColor(state.sceneSettings.bgColor);
        import('./engine.playmode.js').then(m => m.drawCameraBounds());
    }

    // Rebuild grid
    import('./engine.renderer.js').then(m => m.drawGrid());

    // Restore audio sources
    import('./engine.audio.js').then(m => {
        m.restoreAudioSources(snap.audioSources || []);
    });

    // Restore game objects
    const restoreAll = (snap.objects || []).map(s => {
        if (s.isLight) {
            return import('./engine.lights.js').then(({ createLight, _buildLightHelper }) => {
                const obj = createLight(s.lightType, s.x, s.y);
                if (!obj) return;
                obj.label = s.label; obj.unityZ = s.unityZ || 0;
                obj.lightProps = JSON.parse(JSON.stringify(s.lightProps));
                _buildLightHelper(obj);
            });
        }
        if (s.isTilemap) {
            return import('./engine.tilemap.js').then(({ restoreTilemap }) => restoreTilemap(s));
        }
        return import('./engine.objects.js').then(({ createImageObject }) => {
            if (!s.isImage || !s.assetId) return;
            const asset = state.assets.find(a => a.id === s.assetId);
            if (!asset) return;
            const obj = createImageObject(asset, s.x, s.y);
            if (!obj) return;
            obj.label = s.label; obj.scale.x = s.scaleX; obj.scale.y = s.scaleY;
            obj.rotation = s.rotation; obj.unityZ = s.unityZ; obj.prefabId = s.prefabId || null;
            if (typeof s.visible === 'boolean') obj.visible = s.visible;
            if (typeof s.alpha   === 'number')  obj.alpha   = s.alpha;
            if (s.scriptName !== undefined)  obj.scriptName  = s.scriptName  ?? null;
            if (s.scriptTag  !== undefined)  obj._scriptTag  = s.scriptTag   ?? null;
            if (s.scriptGroup!== undefined)  obj._scriptGroup= s.scriptGroup ?? null;
            if (obj.spriteGraphic?.tint !== undefined) obj.spriteGraphic.tint = s.tint;
            if (s.animations?.length) {
                obj.animations = JSON.parse(JSON.stringify(s.animations));
                obj.activeAnimIndex = s.activeAnimIndex || 0;
                // Re-apply animation frames so the correct sprite is showing
                import('./engine.animator.js').then(m => m.reapplyAnimationToObject?.(obj));
            }
            // ── Restore physics ───────────────────────────────────
            obj.physicsBody              = s.physicsBody              ?? 'none';
            obj.physicsShape             = s.physicsShape             ?? 'box';
            obj.physicsFriction          = s.physicsFriction          ?? 0.3;
            obj.physicsRestitution       = s.physicsRestitution       ?? 0.1;
            obj.physicsDensity           = s.physicsDensity           ?? 0.001;
            obj.physicsGravityScale      = s.physicsGravityScale      ?? 1;
            obj.physicsGravityXScale     = s.physicsGravityXScale     ?? 1;
            obj.physicsLinearDamping     = s.physicsLinearDamping     ?? 0;
            obj.physicsAngularDamping    = s.physicsAngularDamping    ?? 0;
            obj.physicsFixedRotation     = !!s.physicsFixedRotation;
            obj.physicsIsSensor          = !!s.physicsIsSensor;
            obj.physicsCollisionCategory = s.physicsCollisionCategory ?? 1;
            obj.physicsCollisionMask     = s.physicsCollisionMask     ?? -1;
            if (s.physicsSize)     obj.physicsSize     = JSON.parse(JSON.stringify(s.physicsSize));
            if (s.physicsPolygon)  obj.physicsPolygon  = JSON.parse(JSON.stringify(s.physicsPolygon));
            if (s.physicsPolygons) obj.physicsPolygons = JSON.parse(JSON.stringify(s.physicsPolygons));
            if (s._polyUnit)       obj._polyUnit       = s._polyUnit;
            obj._collisionShapeInit = !!s._collisionShapeInit;
            if (state._bindGizmoHandles) state._bindGizmoHandles(obj);
        });
    });

    Promise.all(restoreAll).then(() => {
        import('./engine.objects.js').then(({ selectObject }) => {
            const target = snap.selectedLabel
                ? state.gameObjects.find(o => o.label === snap.selectedLabel)
                : null;
            if (target) {
                selectObject(target);
            } else if (snap.selectedAudioId) {
                const audioSrc = state.audioSources.find(a => a.id === snap.selectedAudioId);
                if (audioSrc) {
                    import('./engine.ui.js').then(m => m.selectAudioSource(audioSrc));
                } else {
                    import('./engine.ui.js').then(m => {
                        m.syncPixiToInspector();
                        m.refreshHierarchy();
                    });
                }
            } else {
                import('./engine.ui.js').then(m => {
                    m.syncPixiToInspector();
                    m.refreshHierarchy();
                });
            }
            state._applyingHistory = false;
        });
    });
}

function _applyBgColor(color) {
    if (state.app?.renderer) {
        state.app.renderer.background.color = color;
    }
}

// ── Update toolbar buttons ────────────────────────────────────
function _updateUndoButtons() {
    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    if (undoBtn) undoBtn.style.opacity = state.undoStack.length ? '1' : '0.35';
    if (redoBtn) redoBtn.style.opacity = state.redoStack.length ? '1' : '0.35';
}

export { _updateUndoButtons as updateUndoButtons };
