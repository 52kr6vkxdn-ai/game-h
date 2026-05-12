/* ============================================================
   Zengine — engine.core.js
   Boot sequence.
   ============================================================ */

import { state }                          from './engine.state.js';
import { initScene, startGizmoSizeTicker }from './engine.renderer.js';
import { initCameraControls, initGizmoDrag, initKeyboardShortcuts } from './engine.input.js';
import {
    cacheInspectorElements,
    initInspectorListeners,
    setGizmoMode,
    syncPixiToInspector,
    refreshHierarchy,
    refreshAssetPanel,
    refreshPrefabPanel,
    initSceneDrop,
} from './engine.ui.js';
import { initScenes, toggleSceneDropdown } from './engine.scenes.js';
import { undo, redo, updateUndoButtons }   from './engine.history.js';
import { enterPlayMode, pausePlayMode, stopPlayMode, drawCameraBounds } from './engine.playmode.js';
import { saveProject, loadProject, newProject } from './engine.project.js';
import { createLight, LIGHT_TYPES, initLighting } from './engine.lights.js';
import { createTilemap } from './engine.tilemap.js';
import { createAutoTilemap } from './engine.autotile.js';
import { initCollisionOverlay, setCollisionVisible, refreshCollisionOverlay } from './engine.collision-overlay.js';

export function startEngine(opts = {}) {
    if (typeof PIXI === 'undefined') {
        document.getElementById('pixi-container').innerHTML =
            `<div style="color:red;padding:20px;">Error: PIXI.js failed to load.</div>`;
        return;
    }

    // ── Game-only mode (exported build) ──────────────────────
    if (opts.gameOnly || window.__ZENGINE_AUTOPLAY__) {
        _startGameOnly();
        return;
    }

    // Expose state globally for context menu and debug
    window._zState = state;

    const container = document.getElementById('pixi-container');
    state.app = new PIXI.Application({
        resizeTo:        container,
        backgroundColor: state.sceneSettings.bgColor,
        resolution:      window.devicePixelRatio || 1,
        autoDensity:     true,
        preference:      'webgl',
        antialias:       true,
    });
    container.appendChild(state.app.view);

    // ResizeObserver ensures the canvas fills correctly whenever panels are shown/hidden or resized
    const _ro = new ResizeObserver(() => { state.app?.resize?.(); });
    _ro.observe(container);

    // Also handle window-level resize (e.g. browser zoom changes devicePixelRatio)
    window.addEventListener('resize', () => { state.app?.resize?.(); });

    // Prevent browser context menu on canvas so right-click works for our context menu
    state.app.view.addEventListener('contextmenu', (e) => e.preventDefault());

    // Enable PIXI right-click interaction
    state.app.renderer.plugins.interaction?.mapPositionToPoint;
    state.app.stage.eventMode = 'static';

    // Image quality: use linear (bilinear) filtering — no pixelation on scale/zoom
    PIXI.settings.SCALE_MODE = PIXI.SCALE_MODES.LINEAR;
    // Preserve full resolution — no forced downscale
    PIXI.settings.MIPMAP_TEXTURES = PIXI.MIPMAP_MODES.ON;

    initScene();
    initLighting();
    startGizmoSizeTicker();
    initCameraControls();
    initGizmoDrag();
    initKeyboardShortcuts();
    cacheInspectorElements();
    initInspectorListeners();
    initSceneDrop();

    setGizmoMode('translate');

    syncPixiToInspector();
    refreshHierarchy();
    refreshAssetPanel();

    // Init scenes + menus
    initScenes();
    initMenus();
    initResizePanels();
    initGlobalShortcuts();

    // Init collision overlay layer (must be after PIXI app is ready)
    setTimeout(() => initCollisionOverlay(), 100);

    // Draw camera bounds overlay after a short delay (renderer must be ready)
    setTimeout(() => drawCameraBounds(), 300);
}

// ── Menu System ───────────────────────────────────────────────
function initMenus() {
    // Close any open menu on outside click
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.menu-item')) {
            document.querySelectorAll('.dropdown-menu').forEach(m => m.remove());
        }
    });

    // ── Play / Pause / Stop buttons ───────────────────────
    document.getElementById('btn-play')?.addEventListener('click', () => {
        if (state.isPlaying) return;
        enterPlayMode();
    });
    document.getElementById('btn-pause')?.addEventListener('click', () => {
        if (!state.isPlaying) return;
        pausePlayMode();
    });
    document.getElementById('btn-stop')?.addEventListener('click', () => {
        if (!state.isPlaying) return;
        stopPlayMode();
    });

    // ── Undo / Redo buttons ───────────────────────────────
    document.getElementById('btn-undo')?.addEventListener('click', undo);
    document.getElementById('btn-redo')?.addEventListener('click', redo);
    updateUndoButtons();

    // ── Collision overlay toggle ──────────────────────────
    document.getElementById('btn-collision-toggle')?.addEventListener('click', () => {
        setCollisionVisible(!state.showCollision);
    });

    // ── File menu ─────────────────────────────────────────
    const fileBtn = document.getElementById('menu-file');
    if (fileBtn) {
        fileBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleMenu(fileBtn, [
                { label: '🆕  New Project',      action: () => newProject() },
                { separator: true },
                { label: '💾  Save Project…',    action: () => saveProject() },
                { label: '📂  Load Project…',    action: () => loadProject() },
            ]);
        });
    }

    // ── Edit menu ─────────────────────────────────────────
    const editBtn = document.getElementById('menu-edit');
    if (editBtn) {
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleMenu(editBtn, [
                { label: '↩  Undo          Ctrl+Z', action: undo },
                { label: '↪  Redo          Ctrl+Y', action: redo },
                { separator: true },
                { label: '⎘  Copy          Ctrl+C', action: () => _copySelected() },
                { label: '⎗  Paste         Ctrl+V', action: () => _pasteObject() },
                { separator: true },
                { label: '🗑  Delete        Del',    action: () => import('./engine.objects.js').then(m => m.deleteSelected()) },
                { label: '✕  Deselect All',          action: () => import('./engine.objects.js').then(m => m.selectObject(null)) },
            ]);
        });
    }

    // ── Window menu ───────────────────────────────────────────
    const windowBtn = document.getElementById('menu-window');
    if (windowBtn) {
        windowBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const hierarchy  = document.getElementById('panel-hierarchy');
            const inspector  = document.getElementById('panel-inspector');
            const bottom     = document.getElementById('panel-bottom');
            const hVis = hierarchy?.style.display !== 'none';
            const iVis = inspector?.style.display  !== 'none';
            const bVis = bottom?.style.display     !== 'none';
            toggleMenu(windowBtn, [
                {
                    label: (hVis ? '✓ ' : '    ') + 'Hierarchy',
                    action: () => {
                        if (hierarchy) hierarchy.style.display = hVis ? 'none' : '';
                        // Force PIXI to recalculate canvas size after panel toggle
                        requestAnimationFrame(() => state.app?.resize?.());
                    }
                },
                {
                    label: (iVis ? '✓ ' : '    ') + 'Inspector',
                    action: () => {
                        if (inspector) inspector.style.display = iVis ? 'none' : '';
                        requestAnimationFrame(() => state.app?.resize?.());
                    }
                },
                {
                    label: (bVis ? '✓ ' : '    ') + 'Assets / Console',
                    action: () => {
                        if (bottom) bottom.style.display = bVis ? 'none' : '';
                        requestAnimationFrame(() => state.app?.resize?.());
                    }
                },
                { separator: true },
                { label: '⊞  Reset Layout', action: () => {
                    if (hierarchy) hierarchy.style.display = '';
                    if (inspector) inspector.style.display = '';
                    if (bottom)    bottom.style.display    = '';
                }},
            ]);
        });
    }

    // Assets menu
    const assetsBtn = document.getElementById('menu-assets');
    if (assetsBtn) {
        assetsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleMenu(assetsBtn, [
                {
                    label: '📁 Import Asset…',
                    action: () => {
                        document.getElementById('asset-file-input')?.click();
                    }
                },
                { separator: true },
                { label: 'Create Folder', action: () => {} },
                { label: 'Refresh', action: () => refreshAssetPanel() },
            ]);
        });
    }

    // File input for assets (images + audio)
    const fileInput = document.getElementById('asset-file-input');
    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            Array.from(e.target.files).forEach(file => {
                const reader = new FileReader();

                if (file.type.startsWith('image/')) {
                    reader.onload = (ev) => {
                        const asset = {
                            id:      'asset_' + Date.now() + '_' + Math.random().toString(36).slice(2),
                            name:    file.name,
                            type:    'sprite',
                            dataURL: ev.target.result,
                        };
                        state.assets.push(asset);
                        refreshAssetPanel();
                    };
                    reader.readAsDataURL(file);

                } else if (file.type.startsWith('audio/')) {
                    reader.onload = (ev) => {
                        const asset = {
                            id:      'asset_' + Date.now() + '_' + Math.random().toString(36).slice(2),
                            name:    file.name,
                            type:    'audio',
                            dataURL: ev.target.result,
                            size:    file.size,
                            mimeType: file.type,
                        };
                        state.assets.push(asset);
                        refreshAssetPanel();
                        // Auto-switch to audio folder view
                        import('./engine.ui.js').then(m => m.setAssetFilter('audio'));
                    };
                    reader.readAsDataURL(file);
                }
            });
            fileInput.value = '';
        });
    }

    // Save as Prefab button
    const prefabBtn = document.getElementById('btn-save-prefab');
    if (prefabBtn) {
        prefabBtn.addEventListener('click', () => {
            if (!state.gameObject) return;
            import('./engine.prefabs.js').then(m => {
                const prefab = m.saveAsPrefab(state.gameObject);
                if (prefab) {
                    syncPixiToInspector();
                    document.getElementById('tab-prefabs-btn')?.click();
                }
            });
        });
    }

    // Apply to THIS prefab template only (new Unity-style button)
    const applyThisBtn = document.getElementById('btn-prefab-apply-this');
    if (applyThisBtn) {
        applyThisBtn.addEventListener('click', () => {
            const go = state.gameObject;
            if (!go?.prefabId) return;
            import('./engine.prefabs.js').then(m => m.applyInstanceToPrefab(go));
        });
    }

    // Apply to all instances across all scenes
    const applyAllBtn = document.getElementById('btn-prefab-apply-all');
    if (applyAllBtn) {
        applyAllBtn.addEventListener('click', () => {
            const go = state.gameObject;
            if (!go?.prefabId) return;
            import('./engine.prefabs.js').then(m => m.applyPrefabToAll(go.prefabId, go));
        });
    }

    // Unlink from prefab
    const unlinkBtn = document.getElementById('btn-prefab-unlink');
    if (unlinkBtn) {
        unlinkBtn.addEventListener('click', () => {
            if (state.gameObject) {
                import('./engine.prefabs.js').then(m => m.unlinkFromPrefab(state.gameObject));
            }
        });
    }

    // Edit Animation quick-jump from inspector
    const editAnimBtn = document.getElementById('btn-edit-animation');
    if (editAnimBtn) {
        editAnimBtn.addEventListener('click', () => {
            const go = state.gameObject;
            if (!go) return;
            import('./engine.animator.js').then(m => m.openAnimationEditor(go));
        });
    }

    // GameObject menu — lights + tilemap
    const goBtn = document.getElementById('menu-gameobject');
    if (goBtn) {
        goBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const lightItems = Object.entries(LIGHT_TYPES).map(([type, def]) => ({
                label: `${def.icon}  ${def.label}`,
                action: () => createLight(type),
            }));
            toggleMenu(goBtn, [
                { label: '── 2D Lights ──', disabled: true },
                ...lightItems,
                { separator: true },
                { label: '── World ──', disabled: true },
                {
                    label: '▦  Tilemap',
                    action: () => createTilemap(),
                },
                {
                    label: '▣  Auto Tilemap',
                    action: () => createAutoTilemap(),
                },
            ]);
        });
    }
}

function toggleMenu(anchor, items) {
    document.querySelectorAll('.dropdown-menu').forEach(m => m.remove());
    const menu = document.createElement('div');
    menu.className = 'dropdown-menu';

    for (const item of items) {
        if (item.separator) {
            const sep = document.createElement('div');
            sep.className = 'dropdown-separator';
            menu.appendChild(sep);
            continue;
        }
        const row = document.createElement('div');
        row.className = 'dropdown-item' + (item.disabled ? ' disabled' : '');
        row.textContent = item.label;
        if (!item.disabled) {
            row.addEventListener('click', e => { e.stopPropagation(); menu.remove(); item.action(); });
        }
        menu.appendChild(row);
    }

    const rect = anchor.getBoundingClientRect();
    menu.style.left = rect.left + 'px';
    menu.style.top  = (rect.bottom + 2) + 'px';
    document.body.appendChild(menu);
}

// ── Resizable Panels ──────────────────────────────────────────
function initResizePanels() {
    // Hierarchy (left) resize
    const hierarchyResizer = document.getElementById('resizer-hierarchy');
    const hierarchyPanel   = document.getElementById('panel-hierarchy');
    if (hierarchyResizer && hierarchyPanel) {
        makeHorizResizer(hierarchyResizer, hierarchyPanel, 'left', 140, 400);
    }

    // Inspector (right) resize
    const inspectorResizer = document.getElementById('resizer-inspector');
    const inspectorPanel   = document.getElementById('panel-inspector');
    if (inspectorResizer && inspectorPanel) {
        makeHorizResizer(inspectorResizer, inspectorPanel, 'right', 200, 500);
    }

    // Bottom panel (project/assets) resize
    const bottomResizer = document.getElementById('resizer-bottom');
    const bottomPanel   = document.getElementById('panel-bottom');
    if (bottomResizer && bottomPanel) {
        makeVertResizer(bottomResizer, bottomPanel, 120, 500);
    }
}

function makeHorizResizer(handle, panel, side, minW, maxW) {
    let dragging = false, startX = 0, startW = 0;

    handle.addEventListener('mousedown', (e) => {
        dragging = true;
        startX   = e.clientX;
        startW   = panel.getBoundingClientRect().width;
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const delta = side === 'left' ? e.clientX - startX : startX - e.clientX;
        const newW  = Math.max(minW, Math.min(maxW, startW + delta));
        panel.style.width = newW + 'px';
        state.app?.resize?.();
    });

    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        state.app?.resize?.();
    });
}

function makeVertResizer(handle, panel, minH, maxH) {
    let dragging = false, startY = 0, startH = 0;

    handle.addEventListener('mousedown', (e) => {
        dragging = true;
        startY   = e.clientY;
        startH   = panel.getBoundingClientRect().height;
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const newH = Math.max(minH, Math.min(maxH, startH - (e.clientY - startY)));
        panel.style.height = newH + 'px';
        state.app?.resize?.();
    });

    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        state.app?.resize?.();
    });
}

// ── Copy / Paste ──────────────────────────────────────────────
function _copySelected() {
    const obj = state.gameObject;
    if (!obj) return;

    if (obj.isLight) {
        state.clipboard = {
            isLight: true, lightType: obj.lightType,
            label: obj.label, x: obj.x + 25, y: obj.y + 25, unityZ: obj.unityZ || 0,
            lightProps: JSON.parse(JSON.stringify(obj.lightProps)),
        };
    } else if (obj.isTilemap) {
        state.clipboard = {
            isTilemap: true,
            label: obj.label, x: obj.x + 25, y: obj.y + 25, unityZ: obj.unityZ || 0,
            tilemapData: { ...obj.tilemapData, tiles: Array.from(obj.tilemapData.tiles) },
        };
    } else if (obj.isAutoTilemap) {
        const td = obj.autoTileData;
        state.clipboard = {
            isAutoTilemap: true,
            label: obj.label, x: obj.x + 25, y: obj.y + 25, unityZ: obj.unityZ || 0,
            autoTileData: { ...td, cells: Array.from(td.cells), brushList: td.brushList.slice() },
        };
    } else {
        state.clipboard = {
            label: obj.label, isImage: obj.isImage, assetId: obj.assetId,
            prefabId: null, x: obj.x + 25, y: obj.y + 25,
            scaleX: obj.scale.x, scaleY: obj.scale.y,
            rotation: obj.rotation, unityZ: obj.unityZ || 0,
            tint: obj.spriteGraphic?.tint ?? 0xFFFFFF,
            animations: obj.animations ? JSON.parse(JSON.stringify(obj.animations)) : [],
            activeAnimIndex: obj.activeAnimIndex || 0,
            // ── Physics / collision settings ─────────────────────
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
            physicsSize:        obj.physicsSize        ? JSON.parse(JSON.stringify(obj.physicsSize))     : null,
            physicsPolygon:     obj.physicsPolygon     ? JSON.parse(JSON.stringify(obj.physicsPolygon))  : null,
            physicsPolygons:    obj.physicsPolygons    ? JSON.parse(JSON.stringify(obj.physicsPolygons)) : null,
            _polyUnit:          obj._polyUnit || null,
            _collisionShapeInit: !!obj._collisionShapeInit,
            // ── Misc visual settings ─────────────────────────────
            visible:  obj.visible !== false,
            alpha:    obj.alpha ?? 1,
        };
    }
    _logConsole('⎘ Copied: ' + obj.label, '#9bc');
}

function _pasteObject() {
    const cb = state.clipboard;
    if (!cb) return;

    import('./engine.history.js').then(({ pushUndo }) => pushUndo());

    // Light paste
    if (cb.isLight) {
        import('./engine.lights.js').then(({ createLight, _buildLightHelper }) => {
            const obj = createLight(cb.lightType, cb.x, cb.y);
            if (!obj) return;
            obj.label = cb.label + ' (copy)';
            obj.lightProps = JSON.parse(JSON.stringify(cb.lightProps));
            obj.unityZ = cb.unityZ || 0;
            _buildLightHelper(obj);
            state.clipboard = { ...cb, x: cb.x + 25, y: cb.y + 25 };
            _logConsole('⎗ Pasted: ' + obj.label, '#8f8');
        });
        return;
    }
    // Tilemap paste
    if (cb.isTilemap) {
        import('./engine.tilemap.js').then(({ restoreTilemap }) => {
            restoreTilemap({ ...cb }).then(obj => {
                if (!obj) return;
                obj.label = cb.label + ' (copy)';
                state.clipboard = { ...cb, x: cb.x + 25, y: cb.y + 25 };
                _logConsole('⎗ Pasted: ' + obj.label, '#8f8');
            });
        });
        return;
    }
    // Auto-Tilemap paste
    if (cb.isAutoTilemap) {
        import('./engine.autotile.js').then(({ restoreAutoTilemap }) => {
            restoreAutoTilemap({ ...cb }).then(obj => {
                if (!obj) return;
                obj.label = cb.label + ' (copy)';
                state.clipboard = { ...cb, x: cb.x + 25, y: cb.y + 25 };
                _logConsole('⎗ Pasted: ' + obj.label, '#8f8');
            });
        });
        return;
    }

    // Sprite paste
    import('./engine.objects.js').then(({ createImageObject }) => {
        if (!cb.isImage || !cb.assetId) return;
        const asset = state.assets.find(a => a.id === cb.assetId);
        if (!asset) return;
        const obj = createImageObject(asset, cb.x, cb.y);
        if (!obj) return;

        obj.label    = cb.label + ' (copy)';
        obj.scale.x  = cb.scaleX;
        obj.scale.y  = cb.scaleY;
        obj.rotation = cb.rotation;
        obj.unityZ   = cb.unityZ;
        obj.prefabId = null;
        if (obj.spriteGraphic?.tint !== undefined) obj.spriteGraphic.tint = cb.tint;

        // ── Animations: re-id frames so they are unique, but keep an id-map so
        //               per-frame physics polygons stay attached to the right frame.
        const idMap = {};   // oldFrameId → newFrameId
        if (cb.animations?.length) {
            obj.animations = JSON.parse(JSON.stringify(cb.animations)).map((anim, ai) => {
                const newAnim = {
                    ...anim,
                    id: 'anim_' + Date.now() + '_' + ai + '_' + Math.random().toString(36).slice(2),
                    frames: anim.frames.map((f, fi) => {
                        const nid = 'frame_' + Date.now() + '_' + ai + '_' + fi + '_' + Math.random().toString(36).slice(2);
                        if (f.id) idMap[f.id] = nid;
                        return { ...f, id: nid };
                    }),
                };
                return newAnim;
            });
            obj.activeAnimIndex = cb.activeAnimIndex || 0;
        }

        // ── Physics / collision settings ─────────────────────────
        if (cb.physicsBody)                          obj.physicsBody              = cb.physicsBody;
        if (cb.physicsShape)                         obj.physicsShape             = cb.physicsShape;
        if (typeof cb.physicsFriction    === 'number') obj.physicsFriction          = cb.physicsFriction;
        if (typeof cb.physicsRestitution === 'number') obj.physicsRestitution       = cb.physicsRestitution;
        if (typeof cb.physicsDensity     === 'number') obj.physicsDensity           = cb.physicsDensity;
        if (typeof cb.physicsGravityScale  === 'number') obj.physicsGravityScale    = cb.physicsGravityScale;
        if (typeof cb.physicsGravityXScale === 'number') obj.physicsGravityXScale   = cb.physicsGravityXScale;
        if (typeof cb.physicsLinearDamping  === 'number') obj.physicsLinearDamping  = cb.physicsLinearDamping;
        if (typeof cb.physicsAngularDamping === 'number') obj.physicsAngularDamping = cb.physicsAngularDamping;
        obj.physicsFixedRotation     = !!cb.physicsFixedRotation;
        obj.physicsIsSensor          = !!cb.physicsIsSensor;
        if (typeof cb.physicsCollisionCategory === 'number') obj.physicsCollisionCategory = cb.physicsCollisionCategory;
        if (typeof cb.physicsCollisionMask     === 'number') obj.physicsCollisionMask     = cb.physicsCollisionMask;
        if (cb.physicsSize)     obj.physicsSize     = JSON.parse(JSON.stringify(cb.physicsSize));
        if (cb.physicsPolygon)  obj.physicsPolygon  = JSON.parse(JSON.stringify(cb.physicsPolygon));
        if (cb.physicsPolygons) {
            // Remap per-frame polygon keys to the newly-generated frame ids
            const remapped = {};
            for (const k in cb.physicsPolygons) {
                const v = cb.physicsPolygons[k];
                if (k === 'shared')      remapped.shared    = JSON.parse(JSON.stringify(v));
                else if (idMap[k])       remapped[idMap[k]] = JSON.parse(JSON.stringify(v));
                else                     remapped[k]        = JSON.parse(JSON.stringify(v)); // legacy
            }
            obj.physicsPolygons = remapped;
        }
        if (cb._polyUnit) obj._polyUnit = cb._polyUnit;
        obj._collisionShapeInit = !!cb._collisionShapeInit;

        // Visual misc
        if (typeof cb.alpha === 'number') obj.alpha = cb.alpha;
        if (typeof cb.visible === 'boolean') obj.visible = cb.visible;

        if (state._bindGizmoHandles) state._bindGizmoHandles(obj);
        state.clipboard = { ...cb, x: cb.x + 25, y: cb.y + 25 };
        _logConsole('⎗ Pasted: ' + obj.label, '#8f8');
    });
}

function _logConsole(msg, color = '#aaa') {
    const cons = document.getElementById('console-output') || document.getElementById('tab-console');
    if (!cons) return;
    const line = document.createElement('div');
    line.style.color = color;
    line.textContent = msg;
    cons.appendChild(line);
    cons.scrollTop = cons.scrollHeight;
}

// ── Global keyboard shortcuts ─────────────────────────────────
function initGlobalShortcuts() {
    document.addEventListener('keydown', (e) => {
        const tag = document.activeElement?.tagName;
        const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

        // Escape = stop play mode
        if (e.code === 'Escape' && state.isPlaying) {
            e.preventDefault();
            stopPlayMode();
            return;
        }

        // Space = play/stop toggle (not in input)
        if (e.code === 'Space' && !inInput) {
            e.preventDefault();
            if (state.isPlaying) stopPlayMode();
            else enterPlayMode();
            return;
        }

        // P = pause while playing
        if (e.code === 'KeyP' && state.isPlaying && !inInput) {
            e.preventDefault();
            pausePlayMode();
            return;
        }

        // C = toggle collision overlay (not in input, not ctrl)
        if (e.code === 'KeyC' && !inInput && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            setCollisionVisible(!state.showCollision);
            return;
        }

        if (!e.ctrlKey && !e.metaKey) return;

        switch (e.key.toLowerCase()) {
            case 'z':
                e.preventDefault();
                if (e.shiftKey) redo(); else undo();
                break;
            case 'y':
                e.preventDefault();
                redo();
                break;
            case 'c':
                if (!inInput) { e.preventDefault(); _copySelected(); }
                break;
            case 'v':
                if (!inInput) { e.preventDefault(); _pasteObject(); }
                break;
            case 's':
                e.preventDefault();
                saveProject();
                break;
        }
    });
}

// ── Game-Only Boot (exported build) ──────────────────────────
async function _startGameOnly() {
    const project = window.__ZENGINE_PROJECT__;
    if (!project) {
        document.body.innerHTML = '<div style="color:red;font-size:24px;padding:40px;">Error: No project data found.</div>';
        return;
    }

    // Restore state from injected project JSON
    state.assets   = project.assets   ?? [];
    state.scripts  = project.scripts  ?? [];
    state.prefabs  = project.prefabs  ?? [];
    state.scenes   = project.scenes   ?? [];
    state.activeSceneIndex = project.activeSceneIndex ?? 0;
    state.sceneSettings    = project.sceneSettings ?? { bgColor: 0x282828, gameWidth: 1280, gameHeight: 720, cameraPreset: 'landscape-desktop', gravityX: 0, gravityY: 1 };

    // Register all asset textures from data URLs so PIXI.Texture.from() works
    for (const asset of state.assets) {
        if (asset.dataURL && asset.type === 'image') {
            try { PIXI.Texture.from(asset.dataURL); } catch(_) {}
        }
    }

    const container = document.getElementById('pixi-container');
    state.app = new PIXI.Application({
        width:           window.innerWidth,
        height:          window.innerHeight,
        backgroundColor: state.sceneSettings.bgColor,
        resolution:      window.devicePixelRatio || 1,
        autoDensity:     true,
        preference:      'webgl',
        antialias:       true,
    });
    container.appendChild(state.app.view);
    window.addEventListener('resize', () => {
        state.app?.renderer?.resize(window.innerWidth, window.innerHeight);
    });

    PIXI.settings.SCALE_MODE    = PIXI.SCALE_MODES.LINEAR;
    PIXI.settings.MIPMAP_TEXTURES = PIXI.MIPMAP_MODES.ON;

    // Create scene container (no grid, no gizmos)
    state.sceneContainer = new PIXI.Container();
    state.sceneContainer.sortableChildren = true;
    state.app.stage.addChild(state.sceneContainer);
    state.app.stage.eventMode = 'static';

    // Load and enter play mode for starting scene
    const { playModeGotoScene } = await import('./engine.scenes.js');
    state.isPlaying = true;
    state.isPaused  = false;

    // Expand canvas to full screen immediately
    const sw = window.innerWidth, sh = window.innerHeight;
    const gw = state.sceneSettings.gameWidth ?? 1280;
    const gh = state.sceneSettings.gameHeight ?? 720;
    const scale = Math.min(sw / gw, sh / gh);
    state.sceneContainer.scale.set(scale);
    state.sceneContainer.x = sw / 2;
    state.sceneContainer.y = sh / 2;
    if (state.app.renderer) state.app.renderer.background.color = state.sceneSettings.bgColor;

    // Load starting scene directly
    playModeGotoScene(state.activeSceneIndex);

    // Wire keyboard stop shortcut (Escape) — useful during dev
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            // In game-only mode pressing Escape reloads the page
            window.location.reload();
        }
    });

    // Input system (touch + keyboard) must be initialised for scripts
    const { initInput } = await import('./engine.input.js');
    initInput();
    const { initKeys } = await import('./engine.keys.js');
    initKeys();
}
