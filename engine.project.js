/* ============================================================
   Zengine — engine.project.js
   Save / Load entire project as a single JSON file.
   Includes: all scenes, assets (as dataURLs), prefabs.
   ============================================================ */

import { state } from './engine.state.js';

const PROJECT_VERSION = 1;

// ── Save project to JSON file download ───────────────────────
export function saveProject() {
    // Snapshot the active scene first
    _saveActiveScene();

    const project = {
        version:     PROJECT_VERSION,
        name:        'ZengineProject',
        savedAt:     new Date().toISOString(),
        assets:      state.assets,
        tilesetBrushes: state.tilesetBrushes,
        prefabs:     state.prefabs,
        scripts:     state.scripts,
        scenes:      state.scenes,
        activeScene: state.activeSceneIndex,
    };

    const json = JSON.stringify(project, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);

    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'zengine-project.json';
    a.click();
    URL.revokeObjectURL(url);

    _logConsole('💾 Project saved', '#4ade80');
}

// ── Load project from JSON file ──────────────────────────────
export function loadProject() {
    const input = document.createElement('input');
    input.type   = 'file';
    input.accept = '.json,application/json';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const project = JSON.parse(ev.target.result);
                _applyProject(project);
            } catch (err) {
                alert('Failed to load project: ' + err.message);
            }
        };
        reader.readAsText(file);
    };
    input.click();
}

// ── New (blank) project ──────────────────────────────────────
export function newProject() {
    if (!confirm('Start a new project? Unsaved changes will be lost.')) return;

    // Clear all objects
    for (const obj of state.gameObjects) {
        state.sceneContainer?.removeChild(obj);
        try { obj.destroy({ children: true }); } catch (_) {}
    }
    state.gameObjects    = [];
    state.gameObject     = null;
    state.gizmoContainer = null;
    state.assets         = [];
    state.tilesetBrushes = [];
    state.prefabs        = [];
    state.scripts        = [];
    state.scenes         = [{ id: 'scene_1', name: 'Scene-1', snapshot: null }];
    // Inject the built-in example scripts
    import('./engine.defaultscripts.js').then(m => {
        m.injectDefaultScripts(state.scripts);
        import('./engine.scripting.js').then(s => s.refreshScriptPanel());
    });
    state.activeSceneIndex = 0;
    // Clear audio sources
    import('./engine.audio.js').then(m => m.clearAudioSources());
    // Reset scene settings
    state.sceneSettings = { bgColor: 0x282828, gameWidth: 1280, gameHeight: 720, cameraPreset: 'landscape-desktop' };
    if (state.app?.renderer) state.app.renderer.background.color = state.sceneSettings.bgColor;

    import('./engine.renderer.js').then(m => m.drawGrid());
    import('./engine.ui.js').then(m => {
        m.syncPixiToInspector();
        m.refreshHierarchy();
        m.refreshAssetPanel();
        m.refreshPrefabPanel();
    });
    import('./engine.scripting.js').then(m => m.refreshScriptPanel());
    import('./engine.scenes.js').then(m => m.initScenes());
    _logConsole('🆕 New project created', '#9bc');
}

// ── Apply loaded project data ─────────────────────────────────
function _applyProject(project) {
    if (!project.version) {
        alert('Invalid project file.');
        return;
    }

    // Clear current scene
    for (const obj of state.gameObjects) {
        state.sceneContainer?.removeChild(obj);
        try { obj.destroy({ children: true }); } catch (_) {}
    }
    state.gameObjects    = [];
    state.gameObject     = null;
    state.gizmoContainer = null;

    // Clear audio sources from old scene
    import('./engine.audio.js').then(m => m.clearAudioSources());

    // Restore globals
    state.assets         = project.assets  || [];
    state.tilesetBrushes = project.tilesetBrushes || [];
    state.prefabs        = project.prefabs || [];
    state.scripts        = project.scripts || [];
    // Inject built-in scripts if the project has none yet
    if (state.scripts.length === 0) {
        import('./engine.defaultscripts.js').then(m => m.injectDefaultScripts(state.scripts));
    }
    state.scenes   = project.scenes  || [{ id: 'scene_1', name: 'Scene-1', snapshot: null }];
    state.activeSceneIndex = project.activeScene ?? 0;

    // Reload active scene
    import('./engine.scenes.js').then(m => {
        m.initScenes();
        // initScenes resets to scene_1; we need to switch to the saved active
        if (project.activeScene > 0) m.switchToScene(project.activeScene);
    });

    import('./engine.ui.js').then(m => {
        m.refreshAssetPanel();
        m.refreshPrefabPanel();
    });
    import('./engine.scripting.js').then(m => m.refreshScriptPanel());

    _logConsole('📂 Project loaded: ' + (project.name || 'unknown'), '#4ade80');
}

// ── Snapshot active scene into state.scenes ──────────────────
function _saveActiveScene() {
    const idx   = state.activeSceneIndex;
    const scene = state.scenes[idx];
    if (!scene) return;

    scene.snapshot = {
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
            if (obj.isAutoTilemap) {
                const td = obj.autoTileData;
                return {
                    isAutoTilemap: true, label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
                    autoTileData: { ...td, cells: Array.from(td.cells), brushList: td.brushList.slice() },
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
        }),
        camX:         state.sceneContainer?.x       ?? 0,
        camY:         state.sceneContainer?.y       ?? 0,
        camScaleX:    state.sceneContainer?.scale.x ?? 1,
        camScaleY:    state.sceneContainer?.scale.y ?? 1,
        audioSources: state.audioSources.map(s => ({
            id: s.id, assetId: s.assetId, label: s.label,
            x: s.x, y: s.y, range: s.range, volume: s.volume, loop: s.loop,
        })),
        sceneSettings: JSON.parse(JSON.stringify(state.sceneSettings)),
    };
}

function _logConsole(msg, color = '#e0e0e0') {
    const cons = document.getElementById('console-output') || document.getElementById('tab-console');
    if (!cons) return;
    const line = document.createElement('div');
    line.style.color = color;
    line.textContent = msg;
    cons.appendChild(line);
    cons.scrollTop = cons.scrollHeight;
}
