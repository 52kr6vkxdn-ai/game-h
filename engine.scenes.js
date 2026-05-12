/* ============================================================
   Zengine — engine.scenes.js
   Multi-scene management. Assets are shared across all scenes.
   Each scene owns its own: gameObjects, camera position/zoom,
   selected object, and gizmo state.
   ============================================================ */

import { state } from './engine.state.js';
import { drawGrid } from './engine.renderer.js';
import { syncPixiToInspector, refreshHierarchy, refreshAssetPanel } from './engine.ui.js';

// ── Scene registry (lives in state.scenes) ────────────────────
// state.scenes  = [ { id, name, snapshot: {...} }, ... ]
// state.activeSceneIndex = number

let _sceneCounter = 1;

// ── Init: create the first scene slot ────────────────────────
export function initScenes() {
    state.scenes           = [];
    state.activeSceneIndex = 0;

    // "Scene-1" is the scene that was already set up by startEngine
    state.scenes.push({
        id:       'scene_1',
        name:     'Scene-1',
        snapshot: null,   // null = currently loaded, no need to save
    });

    _refreshSceneButton();
}

// ── Create a brand-new empty scene ───────────────────────────
export function createScene(name) {
    // Save current scene first
    _saveCurrentScene();

    _sceneCounter++;
    const newName = name || `Scene-${_sceneCounter}`;
    const id      = 'scene_' + Date.now();

    state.scenes.push({ id, name: newName, snapshot: _emptySnapshot() });
    state.activeSceneIndex = state.scenes.length - 1;

    _loadScene(state.activeSceneIndex);
    _refreshSceneButton();
    _refreshSceneDropdown();
}

// ── Switch to an existing scene ───────────────────────────────
export function switchToScene(index) {
    if (index === state.activeSceneIndex) return;
    if (index < 0 || index >= state.scenes.length) return;

    _saveCurrentScene();
    state.activeSceneIndex = index;
    _loadScene(index);
    _refreshSceneButton();
    _refreshSceneDropdown();
    // Clear scene-scoped variables when the scene changes
    if (state.isPlaying) {
        import('./engine.scripting.js').then(m => m.clearSceneVars());
    }
}

// ── Switch scene during PLAY MODE (does NOT corrupt editor snapshots) ──
// This is what gotoScene() calls at runtime. It:
// 1. Stops current scripts/physics without saving play state
// 2. Loads the target scene's editor snapshot
// 3. Restarts scripts/physics for the new scene
export function playModeGotoScene(index, onReady = null) {
    if (index < 0 || index >= state.scenes.length) {
        import('./engine.scripting.js').then(m =>
            m._logConsolePublic(`gotoScene: scene index ${index} out of range (have ${state.scenes.length} scenes)`, '#f87171')
        );
        return;
    }
    const target = state.scenes[index];
    if (!target) return;

    // Stop scripts/physics for the current scene
    Promise.all([
        import('./engine.scripting.js').then(m => { m.stopScripts(); m.clearSceneVars(); }),
        import('./engine.physics.js').then(m => m.stopPhysics()),
        import('./engine.audio.js').then(m => { m.stopPlayAudio(); m._stopAllScriptSounds(); }),
    ]).then(() => {
        // Destroy current play-mode objects WITHOUT saving to snapshot
        for (const obj of state.gameObjects) {
            state.sceneContainer?.removeChild(obj);
            try { obj.destroy({ children: true }); } catch(_) {}
        }
        state.gameObjects = [];
        state.gameObject  = null;

        // Reset camera to center for the new scene
        if (state.sceneContainer && state.app) {
            const snap = target.snapshot;
            if (snap?.camX != null) {
                state.sceneContainer.x       = snap.camX;
                state.sceneContainer.y       = snap.camY;
                state.sceneContainer.scale.x = snap.camScaleX ?? 1;
                state.sceneContainer.scale.y = snap.camScaleY ?? 1;
            }
            // Apply game-camera scale for play mode
            const sw = window.innerWidth, sh = window.innerHeight;
            const gw = snap?.sceneSettings?.gameWidth  ?? state.sceneSettings?.gameWidth  ?? 1280;
            const gh = snap?.sceneSettings?.gameHeight ?? state.sceneSettings?.gameHeight ?? 720;
            const gameCamScale = Math.min(sw / gw, sh / gh);
            state.sceneContainer.scale.set(gameCamScale);
            state.sceneContainer.x = sw / 2;
            state.sceneContainer.y = sh / 2;

            if (snap?.sceneSettings) {
                state.sceneSettings = { ...state.sceneSettings, ...snap.sceneSettings };
                if (state.app.renderer) state.app.renderer.background.color = state.sceneSettings.bgColor;
            }
        }

        state.activeSceneIndex = index;
        _refreshSceneButton();
        _refreshSceneDropdown();

        // Restore objects from target scene's snapshot
        const snap = target.snapshot;
        const objectRestorePromises = (snap?.objects ?? []).map(s => {
            if (s.isLight) {
                return import('./engine.lights.js').then(({ createLight, _buildLightHelper }) => {
                    const obj = createLight(s.lightType, s.x, s.y);
                    if (!obj) return;
                    obj.label = s.label; obj.unityZ = s.unityZ || 0;
                    obj.lightProps = JSON.parse(JSON.stringify(s.lightProps));
                    _buildLightHelper(obj);
                    if (obj._lightHelper) obj._lightHelper.visible = false;
                    if (obj._gizmoContainer) obj._gizmoContainer.visible = false;
                    obj.visible = false;
                });
            }
            if (s.isTilemap) {
                return import('./engine.tilemap.js').then(({ restoreTilemap }) => {
                    const obj = restoreTilemap(s);
                    return obj;
                });
            }
            if (s.isAutoTilemap) {
                return import('./engine.autotile.js').then(({ restoreAutoTilemap }) => restoreAutoTilemap(s));
            }
            // ── Text objects in play mode ──
            if (s.isText) {
                return import('./engine.objects.js').then(({ createTextObject }) => {
                    const obj = createTextObject(s.textContent ?? '', s.x, s.y, s.textStyle ?? {});
                    if (!obj) return;
                    obj.label = s.label; obj.unityZ = s.unityZ || 0;
                    obj.visible = s.visible !== false; obj.alpha = s.alpha ?? 1;
                    obj.scriptName   = s.scriptName   ?? null;
                    obj._scriptTag   = s.scriptTag    ?? null;
                    obj._scriptGroup = s.scriptGroup  ?? null;
                    if (obj._gizmoContainer) obj._gizmoContainer.visible = false;
                });
            }
            return import('./engine.objects.js').then(({ createImageObject }) => {
                if (!s.isImage || !s.assetId) return;
                const asset = state.assets.find(a => a.id === s.assetId);
                if (!asset) return;
                const obj = createImageObject(asset, s.x, s.y);
                if (!obj) return;
                obj.label = s.label; obj.scale.x = s.scaleX; obj.scale.y = s.scaleY;
                obj.rotation = s.rotation; obj.unityZ = s.unityZ; obj.prefabId = s.prefabId || null;
                if (obj.spriteGraphic?.tint !== undefined) obj.spriteGraphic.tint = s.tint ?? 0xFFFFFF;
                if (s.animations?.length) { obj.animations = JSON.parse(JSON.stringify(s.animations)); obj.activeAnimIndex = s.activeAnimIndex || 0; }
                obj.physicsBody             = s.physicsBody             ?? 'none';
                obj.physicsFriction         = s.physicsFriction         ?? 0.3;
                obj.physicsRestitution      = s.physicsRestitution      ?? 0.1;
                obj.physicsDensity          = s.physicsDensity          ?? 0.001;
                obj.physicsGravityScale     = s.physicsGravityScale     ?? 1;
                obj.physicsLinearDamping    = s.physicsLinearDamping    ?? 0;
                obj.physicsAngularDamping   = s.physicsAngularDamping   ?? 0;
                obj.physicsFixedRotation    = !!s.physicsFixedRotation;
                obj.physicsIsSensor         = !!s.physicsIsSensor;
                obj.physicsCollisionCategory = s.physicsCollisionCategory ?? 1;
                obj.physicsCollisionMask     = s.physicsCollisionMask    ?? 0xFFFFFFFF;
                obj.physicsShape            = s.physicsShape             ?? 'box';
                obj.physicsSize             = s.physicsSize     ? JSON.parse(JSON.stringify(s.physicsSize))     : null;
                obj.physicsPolygon          = s.physicsPolygon  ? JSON.parse(JSON.stringify(s.physicsPolygon))  : null;
                obj.physicsPolygons         = s.physicsPolygons ? JSON.parse(JSON.stringify(s.physicsPolygons)) : null;
                obj._polyUnit               = s._polyUnit || null;
                obj._collisionShapeInit     = !!s._collisionShapeInit;
                obj.visible  = s.visible !== false;
                obj.alpha    = s.alpha   ?? 1;
                obj.scriptName  = s.scriptName  ?? null;
                obj._scriptTag  = s.scriptTag   ?? null;
                obj._scriptGroup= s.scriptGroup ?? null;
                // Hide gizmos in play mode
                if (obj._gizmoContainer) obj._gizmoContainer.visible = false;
            });
        });

        Promise.all(objectRestorePromises).then(() => {
            // Sort by Z-order so objects render in the correct layer order
            _applyZOrder();
            // Restart play-mode animations, physics and scripts for the new scene
            import('./engine.playmode.js').then(m => {
                m.startRuntimeAnimations();
                import('./engine.physics.js').then(pm => pm.startPhysics());
                import('./engine.audio.js').then(am => am.startPlayAudio());
                import('./engine.scripting.js').then(sm => { sm.startScripts(); if (onReady) onReady(); });
            });
            import('./engine.scripting.js').then(m =>
                m._logConsolePublic(`▶ Scene loaded: "${target.name}"`, '#4ade80')
            );
        });
    });
}

// ── Rename active scene ───────────────────────────────────────
export function renameScene(index, newName) {
    if (!state.scenes[index]) return;
    state.scenes[index].name = newName;
    _refreshSceneButton();
    _refreshSceneDropdown();
}

// ── Delete a scene (must keep at least one) ──────────────────
export function deleteScene(index) {
    if (state.scenes.length <= 1) return;

    _saveCurrentScene();
    state.scenes.splice(index, 1);

    const newIdx = Math.max(0, Math.min(index, state.scenes.length - 1));
    state.activeSceneIndex = newIdx;
    _loadScene(newIdx);
    _refreshSceneButton();
    _refreshSceneDropdown();
}

// ── Save current live scene into snapshot ────────────────────
function _saveCurrentScene() {
    const idx   = state.activeSceneIndex;
    const scene = state.scenes[idx];
    if (!scene) return;

    const objectSnapshots = state.gameObjects.map(obj => {
        if (obj.isLight) {
            return {
                isLight: true, lightType: obj.lightType,
                label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
                visible: obj.visible !== false,
                alpha:   obj.alpha ?? 1,
                lightProps: JSON.parse(JSON.stringify(obj.lightProps)),
            };
        }
        if (obj.isTilemap) {
            return {
                isTilemap: true, label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
                tilemapData: { ...obj.tilemapData, tiles: Array.from(obj.tilemapData.tiles) },
            };
        }
        if (obj.isText) {
            return {
                isText: true,
                label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
                textContent:  obj.textContent ?? '',
                textStyle:    JSON.parse(JSON.stringify(obj.textStyle ?? {})),
                visible:      obj.visible !== false,
                alpha:        obj.alpha ?? 1,
                scriptName:   obj.scriptName  ?? null,
                scriptTag:    obj._scriptTag  ?? null,
                scriptGroup:  obj._scriptGroup ?? null,
            };
        }
        if (obj.isAutoTilemap) {
            const td = obj.autoTileData;
            return {
                isAutoTilemap: true, label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
                autoTileData: {
                    ...td,
                    cells: Array.from(td.cells),
                    brushList: td.brushList.slice(),
                    activeBrushIds: (td.activeBrushIds || []).slice(),
                },
            };
        }
        return {
            label: obj.label, isImage: obj.isImage, assetId: obj.assetId,
            prefabId: obj.prefabId || null,
            x: obj.x, y: obj.y, scaleX: obj.scale.x, scaleY: obj.scale.y,
            rotation: obj.rotation, unityZ: obj.unityZ || 0,
            tint: obj.spriteGraphic?.tint ?? 0xFFFFFF,
            animations: obj.animations ? JSON.parse(JSON.stringify(obj.animations)) : [],
            activeAnimIndex: obj.activeAnimIndex || 0,
            // ── Physics / collision ─────────────────────────────
            physicsBody:        obj.physicsBody        ?? 'none',
            physicsFriction:    obj.physicsFriction    ?? 0.3,
            physicsRestitution: obj.physicsRestitution ?? 0.1,
            physicsDensity:     obj.physicsDensity     ?? 0.001,
            physicsGravityScale:obj.physicsGravityScale?? 1,
            physicsLinearDamping:obj.physicsLinearDamping ?? 0,
            physicsAngularDamping:obj.physicsAngularDamping ?? 0,
            physicsFixedRotation:!!obj.physicsFixedRotation,
            physicsIsSensor:    !!obj.physicsIsSensor,
            physicsCollisionCategory: obj.physicsCollisionCategory ?? 1,
            physicsCollisionMask:     obj.physicsCollisionMask     ?? 0xFFFFFFFF,
            physicsShape:       obj.physicsShape       ?? 'box',
            physicsSize:        obj.physicsSize     ? JSON.parse(JSON.stringify(obj.physicsSize))     : null,
            physicsPolygon:     obj.physicsPolygon  ? JSON.parse(JSON.stringify(obj.physicsPolygon))  : null,
            physicsPolygons:    obj.physicsPolygons ? JSON.parse(JSON.stringify(obj.physicsPolygons)) : null,
            _polyUnit:          obj._polyUnit || null,
            _collisionShapeInit: !!obj._collisionShapeInit,
            // ── Visibility / alpha ──────────────────────────────
            visible: obj.visible !== false,
            alpha:   obj.alpha   ?? 1,
            // ── Script ─────────────────────────────────────────
            scriptName:  obj.scriptName  ?? null,
            scriptTag:   obj._scriptTag  ?? null,
            scriptGroup: obj._scriptGroup ?? null,
        };
    });

    scene.snapshot = {
        objects:       objectSnapshots,
        audioSources:  state.audioSources.map(s => ({
            id: s.id, assetId: s.assetId, label: s.label,
            x: s.x, y: s.y, range: s.range, volume: s.volume, loop: s.loop,
        })),
        sceneSettings: JSON.parse(JSON.stringify(state.sceneSettings)),
        camX:          state.sceneContainer.x,
        camY:          state.sceneContainer.y,
        camScaleX:     state.sceneContainer.scale.x,
        camScaleY:     state.sceneContainer.scale.y,
    };
}

// ── Load a scene from snapshot ────────────────────────────────
function _loadScene(index) {
    const scene = state.scenes[index];
    if (!scene) return;

    // Hide during swap to prevent one-frame flicker
    if (state.sceneContainer) state.sceneContainer.visible = false;
    // Guard: suppress per-object refreshHierarchy calls during bulk restore
    state._loadingScene = true;

    for (const obj of state.gameObjects) {
        state.sceneContainer.removeChild(obj);
        try { obj.destroy({ children: true }); } catch(_) {}
    }
    state.gameObjects = []; state.gameObject = null; state.gizmoContainer = null;
    state.grpTranslate = null; state.grpRotate = null; state.grpScale = null;
    state._gizmoHandles = null; state.spriteBox = null;

    const snap = scene.snapshot;
    if (snap) {
        state.sceneContainer.x       = snap.camX      ?? state.app.screen.width  / 2;
        state.sceneContainer.y       = snap.camY      ?? state.app.screen.height / 2;
        state.sceneContainer.scale.x = snap.camScaleX ?? 1;
        state.sceneContainer.scale.y = snap.camScaleY ?? 1;
    } else {
        state.sceneContainer.x = state.app.screen.width  / 2;
        state.sceneContainer.y = state.app.screen.height / 2;
        state.sceneContainer.scale.set(1);
    }

    drawGrid();

    import('./engine.audio.js').then(m => m.restoreAudioSources(snap?.audioSources || []));

    const _ssDefaults = { bgColor: 0x282828, gameWidth: 1280, gameHeight: 720, cameraPreset: 'landscape-desktop', gravityX: 0, gravityY: 1 };
    const ss = snap?.sceneSettings;
    state.sceneSettings = ss
        ? Object.assign({}, _ssDefaults, JSON.parse(JSON.stringify(ss)))
        : { ..._ssDefaults };
    if (state.app?.renderer) state.app.renderer.background.color = state.sceneSettings.bgColor;
    import('./engine.playmode.js').then(m => m.drawCameraBounds());
    import('./engine.ui.js').then(m => m.refreshSceneSettingsPanel());

    const sceneLabel = document.getElementById('hierarchy-scene-label');
    if (sceneLabel) sceneLabel.textContent = scene.name;

    const _finishLoad = () => {
        state._loadingScene = false;
        if (state.sceneContainer) state.sceneContainer.visible = true;
        refreshHierarchy();
        syncPixiToInspector();
    };

    if (snap?.objects?.length) {
        const restoreAll = snap.objects.map(s => {
            if (s.isLight) {
                return import('./engine.lights.js').then(({ createLight, _buildLightHelper }) => {
                    const obj = createLight(s.lightType, s.x, s.y);
                    if (!obj) return;
                    obj.label   = s.label; obj.unityZ = s.unityZ || 0;
                    obj.visible = s.visible !== false; obj.alpha = s.alpha ?? 1;
                    obj.lightProps = JSON.parse(JSON.stringify(s.lightProps));
                    _buildLightHelper(obj);
                });
            }
            if (s.isTilemap) {
                return import('./engine.tilemap.js').then(({ restoreTilemap }) => restoreTilemap(s));
            }
            if (s.isAutoTilemap) {
                return import('./engine.autotile.js').then(({ restoreAutoTilemap }) => restoreAutoTilemap(s));
            }
            if (s.isText) {
                return import('./engine.objects.js').then(({ createTextObject }) => {
                    const obj = createTextObject(s.textContent ?? '', s.x, s.y, s.textStyle ?? {});
                    if (!obj) return;
                    obj.label    = s.label;    obj.unityZ  = s.unityZ || 0;
                    obj.visible  = s.visible !== false; obj.alpha = s.alpha ?? 1;
                    obj.scriptName   = s.scriptName   ?? null;
                    obj._scriptTag   = s.scriptTag    ?? null;
                    obj._scriptGroup = s.scriptGroup  ?? null;
                    if (state._bindGizmoHandles) state._bindGizmoHandles(obj);
                });
            }
            return import('./engine.objects.js').then(({ createImageObject }) => {
                if (!s.isImage || !s.assetId) return;
                const asset = state.assets.find(a => a.id === s.assetId);
                if (!asset) return;
                const obj = createImageObject(asset, s.x, s.y);
                if (!obj) return;
                obj.label = s.label; obj.scale.x = s.scaleX; obj.scale.y = s.scaleY;
                obj.rotation = s.rotation; obj.unityZ = s.unityZ; obj.prefabId = s.prefabId || null;
                if (obj.spriteGraphic?.tint !== undefined) obj.spriteGraphic.tint = s.tint;
                if (s.animations?.length) { obj.animations = JSON.parse(JSON.stringify(s.animations)); obj.activeAnimIndex = s.activeAnimIndex || 0; }
                obj.physicsBody              = s.physicsBody             ?? 'none';
                obj.physicsFriction          = s.physicsFriction         ?? 0.3;
                obj.physicsRestitution       = s.physicsRestitution      ?? 0.1;
                obj.physicsDensity           = s.physicsDensity          ?? 0.001;
                obj.physicsGravityScale      = s.physicsGravityScale     ?? 1;
                obj.physicsLinearDamping     = s.physicsLinearDamping    ?? 0;
                obj.physicsAngularDamping    = s.physicsAngularDamping   ?? 0;
                obj.physicsFixedRotation     = !!s.physicsFixedRotation;
                obj.physicsIsSensor          = !!s.physicsIsSensor;
                obj.physicsCollisionCategory = s.physicsCollisionCategory ?? 1;
                obj.physicsCollisionMask     = s.physicsCollisionMask    ?? 0xFFFFFFFF;
                obj.physicsShape             = s.physicsShape            ?? 'box';
                obj.physicsSize              = s.physicsSize     ? JSON.parse(JSON.stringify(s.physicsSize))     : null;
                obj.physicsPolygon           = s.physicsPolygon  ? JSON.parse(JSON.stringify(s.physicsPolygon))  : null;
                obj.physicsPolygons          = s.physicsPolygons ? JSON.parse(JSON.stringify(s.physicsPolygons)) : null;
                obj._polyUnit                = s._polyUnit || null;
                obj._collisionShapeInit      = !!s._collisionShapeInit;
                obj.visible     = s.visible !== false;
                obj.alpha       = s.alpha   ?? 1;
                obj.scriptName  = s.scriptName  ?? null;
                obj._scriptTag  = s.scriptTag   ?? null;
                obj._scriptGroup= s.scriptGroup ?? null;
                if (state._bindGizmoHandles) state._bindGizmoHandles(obj);
            });
        });
        Promise.all(restoreAll).then(() => { _applyZOrder(); _finishLoad(); });
    } else {
        _finishLoad();
    }
}

// ── Sort sceneContainer children by unityZ so layers are correct ──
function _applyZOrder() {
    if (!state.sceneContainer) return;
    // Sort gameObjects array by unityZ ascending
    state.gameObjects.sort((a, b) => (a.unityZ || 0) - (b.unityZ || 0));
    // Reorder PIXI children to match sorted order
    // Grid, gizmo layer etc are non-gameObject children — preserve them
    for (let i = 0; i < state.gameObjects.length; i++) {
        const obj = state.gameObjects[i];
        const curIdx = state.sceneContainer.getChildIndex(obj);
        if (curIdx !== i) {
            try { state.sceneContainer.setChildIndex(obj, Math.min(i, state.sceneContainer.children.length - 1)); } catch(_) {}
        }
    }
}

// ── Empty snapshot (new blank scene) ─────────────────────────
function _emptySnapshot() {
    return {
        objects:      [],
        audioSources: [],
        sceneSettings: { bgColor: 0x282828, gameWidth: 1280, gameHeight: 720, cameraPreset: 'landscape-desktop', gravityX: 0, gravityY: 1 },
        camX:         null,
        camY:         null,
        camScaleX:    1,
        camScaleY:    1,
    };
}

// ── Refresh the scene button label in toolbar ─────────────────
function _refreshSceneButton() {
    const btn = document.getElementById('scene-switcher-btn');
    const active = state.scenes[state.activeSceneIndex];
    if (!active) return;

    const lbl = document.getElementById('hierarchy-scene-label');
    if (lbl) lbl.textContent = active.name;

    const sceneBtnLabel = document.getElementById('scene-btn-label');
    if (sceneBtnLabel) sceneBtnLabel.textContent = active.name;
}

/** Re-sync scene button label and dropdown to the current activeSceneIndex. */
export function refreshSceneUI() {
    _refreshSceneButton();
    _refreshSceneDropdown();
}

// ── Refresh the open dropdown if it's visible ────────────────
function _refreshSceneDropdown() {
    const existing = document.getElementById('scene-dropdown');
    if (existing) _buildSceneDropdown();
}

// ── Build & show scene dropdown ───────────────────────────────
export function toggleSceneDropdown() {
    const existing = document.getElementById('scene-dropdown');
    if (existing) { existing.remove(); return; }
    _buildSceneDropdown();
}

function _buildSceneDropdown() {
    document.getElementById('scene-dropdown')?.remove();

    const btn  = document.getElementById('scene-switcher-btn');
    const rect = btn?.getBoundingClientRect();
    if (!rect) return;

    const panel = document.createElement('div');
    panel.id = 'scene-dropdown';
    panel.style.cssText = `
        position: fixed;
        left: ${rect.left}px;
        top: ${rect.bottom + 4}px;
        min-width: 220px;
        background: #1a1a24;
        border: 1px solid #3a3a48;
        border-radius: 6px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.8);
        z-index: 9999;
        font-size: 11px;
        color: #d8d8e8;
        overflow: hidden;
    `;

    // Header
    panel.innerHTML = `
        <div style="padding:8px 12px; background:#1a1a1a; border-bottom:1px solid #333;
                    font-size:10px; font-weight:bold; color:#888; letter-spacing:1px;">
            SCENES
        </div>
    `;

    // Scene rows
    state.scenes.forEach((scene, i) => {
        const isActive = i === state.activeSceneIndex;
        const row = document.createElement('div');
        row.style.cssText = `
            display: flex; align-items: center;
            padding: 7px 12px;
            background: ${isActive ? '#1e3a5a' : 'transparent'};
            border-left: 3px solid ${isActive ? '#3A72A5' : 'transparent'};
            cursor: pointer; gap: 8px;
        `;

        row.innerHTML = `
            <svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:${isActive ? '#3A72A5' : '#666'};stroke-width:2;flex-shrink:0;">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <path d="M3 9h18M9 21V9"/>
            </svg>
            <span class="scene-row-name" data-idx="${i}" style="flex:1;color:${isActive ? '#fff' : '#ccc'};
                  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
                  title="Double-click to rename">${scene.name}</span>
            ${isActive ? '<span style="color:#3A72A5;font-size:9px;font-weight:bold;">ACTIVE</span>' : ''}
            <button class="scene-del-btn" data-idx="${i}"
                    style="background:none;border:none;color:#555;cursor:pointer;font-size:12px;padding:0 2px;
                           display:${state.scenes.length > 1 ? 'block' : 'none'};"
                    title="Delete scene">✕</button>
        `;

        // Click row → switch scene
        row.addEventListener('click', (e) => {
            if (e.target.classList.contains('scene-del-btn')) return;
            if (e.target.classList.contains('scene-row-name') && e.detail === 2) return; // dblclick handled below
            panel.remove();
            switchToScene(i);
        });

        // Double-click name → rename inline
        const nameEl = row.querySelector('.scene-row-name');
        nameEl.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            const inp = document.createElement('input');
            inp.type  = 'text';
            inp.value = scene.name;
            inp.style.cssText = `
                background:#1e1e1e; border:1px solid #3A72A5; color:#fff;
                font-size:11px; padding:1px 4px; border-radius:2px; width:100%; outline:none;
            `;
            nameEl.replaceWith(inp);
            inp.focus(); inp.select();
            const commit = () => {
                const v = inp.value.trim() || scene.name;
                renameScene(i, v);
            };
            inp.addEventListener('blur', commit);
            inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') inp.blur(); ev.stopPropagation(); });
        });

        // Delete button
        row.querySelector('.scene-del-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm(`Delete "${scene.name}"? This cannot be undone.`)) {
                panel.remove();
                deleteScene(i);
            }
        });

        // Hover
        row.addEventListener('mouseenter', () => { if (!isActive) row.style.background = '#2a2a2a'; });
        row.addEventListener('mouseleave', () => { if (!isActive) row.style.background = 'transparent'; });

        panel.appendChild(row);
    });

    // Divider
    const div = document.createElement('div');
    div.style.cssText = 'border-top:1px solid #333; margin:2px 0;';
    panel.appendChild(div);

    // New scene button
    const newBtn = document.createElement('div');
    newBtn.style.cssText = `
        padding: 8px 12px; cursor: pointer; display:flex; align-items:center; gap:8px;
        color: #8f8;
    `;
    newBtn.innerHTML = `
        <svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:#8f8;stroke-width:2;flex-shrink:0;">
            <circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/>
        </svg>
        New Scene
    `;
    newBtn.addEventListener('click', () => { panel.remove(); createScene(); });
    newBtn.addEventListener('mouseenter', () => newBtn.style.background = '#1e2e1e');
    newBtn.addEventListener('mouseleave', () => newBtn.style.background = '');
    panel.appendChild(newBtn);

    document.body.appendChild(panel);

    // Close on outside click
    setTimeout(() => {
        document.addEventListener('click', function handler(e) {
            if (!panel.contains(e.target) && e.target.id !== 'scene-switcher-btn') {
                panel.remove();
                document.removeEventListener('click', handler);
            }
        });
    }, 0);
}
