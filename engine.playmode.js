/* Zengine — engine.playmode.js v3 */
import { state } from './engine.state.js';

// Dynamic resolution from scene settings
export function getGameWidth()  { return state.sceneSettings?.gameWidth  ?? 1280; }
export function getGameHeight() { return state.sceneSettings?.gameHeight ?? 720;  }
// Keep legacy exports for any existing imports
export const GAME_WIDTH  = 1280;
export const GAME_HEIGHT = 720;

export function enterPlayMode() {
    if (state.isPlaying) return;
    state._playSnapshot = _snapshotScene();
    state.isPlaying = true;
    state.isPaused  = false;
    _hideEditorUI();
    _expandCanvasGameCamera();   // use game camera, not editor camera
    _hideAllGizmosAndGrid();
    _deselect();
    _blockEditorInput(true);     // block selection, scroll, zoom
    _showPlayOverlay();
    _startFPSCounter();
    // Reset play-mode error counter + open floating console if it exists
    import('./engine.console.js').then(m => { m.resetPlayErrors(); m.onPlayStart(); });
    // Start animating all objects
    import('./engine.playmode.js').then(m => m.startRuntimeAnimations());
    // Start physics simulation
    import('./engine.physics.js').then(m => m.startPhysics());
    // Start 3D positional audio
    import('./engine.audio.js').then(m => m.startPlayAudio());
    // Start user scripts (sandboxed, play-mode only)
    import('./engine.scripting.js').then(m => m.startScripts());
    _logConsole('▶ Play Mode — Space or ■ to stop', '#4ade80');
}

export function pausePlayMode() {
    if (!state.isPlaying) return;
    state.isPaused = !state.isPaused;
    _updatePlayButtons();
    const o = document.getElementById('play-pause-overlay');
    if (o) o.style.display = state.isPaused ? 'flex' : 'none';
    // Freeze/unfreeze animated sprites
    for (const obj of state.gameObjects) {
        if (obj._runtimeSprite) {
            if (state.isPaused) obj._runtimeSprite.stop();
            else                obj._runtimeSprite.play();
        }
    }
    _logConsole(state.isPaused ? '⏸ Paused' : '▶ Resumed', '#facc15');
}

export function stopPlayMode() {
    if (!state.isPlaying) return;
    state.isPlaying = false;
    state.isPaused  = false;
    _stopFPSCounter();
    _removePlayOverlay();
    // Stop all runtime animations before restoring scene
    stopRuntimeAnimations();
    // Stop physics
    import('./engine.physics.js').then(m => m.stopPhysics());
    // Stop 3D positional audio
    import('./engine.audio.js').then(m => { m.stopPlayAudio(); m._stopAllScriptSounds(); });
    // Stop user scripts + clean up transitions/debug graphics
    import('./engine.scripting.js').then(m => m.stopScripts());
    import('./engine.transitions.js').then(m => m.cleanupTransitions());
    _blockEditorInput(false);    // restore input
    _showEditorUI();
    // Restore audio source visuals (hidden during play mode)
    for (const src of state.audioSources) {
        if (src._container) src._container.visible = true;
    }
    // Store snapshot ref now — _restoreScene will clear state._playSnapshot
    const snap = state._playSnapshot;
    state._playSnapshot = null;
    _restoreCanvas(snap);
    _updatePlayButtons();
    if (snap) _restoreScene(snap);
    _logConsole('■ Stopped — scene restored', '#f87171');
}

/* ── Camera Bounds Overlay (editor only) ── */
export function drawCameraBounds() {
    document.getElementById('camera-bounds-overlay')?.remove();
    if (state.isPlaying) return;
    const pixiEl = document.getElementById('pixi-container');
    if (!pixiEl || !state.app) return;

    const gw = getGameWidth();
    const gh = getGameHeight();
    const preset = state.sceneSettings?.cameraPreset || 'landscape-desktop';

    const presetLabel = {
        'landscape-desktop': 'Desktop 16:9',
        'landscape-both':    'Desktop+Android',
        'portrait':          'Portrait 9:16',
        'automatic':         'Auto',
    }[preset] || '';

    const bounds = document.createElement('div');
    bounds.id = 'camera-bounds-overlay';
    // Semi-transparent outside vignette via box-shadow, inner border shows exact frame
    bounds.style.cssText = [
        'position:absolute;pointer-events:none;z-index:10;',
        'border:1.5px solid rgba(255,200,60,0.85);',
        'border-radius:1px;',
        'box-shadow:0 0 0 9999px rgba(0,0,0,0.28);',   // dims outside camera
        'overflow:visible;',
    ].join('');
    _positionCameraBounds(bounds);
    pixiEl.style.position = 'relative';
    pixiEl.appendChild(bounds);

    // Label with preset info
    const lbl = document.createElement('div');
    lbl.style.cssText = [
        'position:absolute;top:-20px;left:-1px;',
        'color:rgba(255,200,60,0.9);font-size:9px;font-family:monospace;',
        'white-space:nowrap;letter-spacing:0.5px;',
        'background:rgba(0,0,0,0.55);padding:1px 5px 2px;border-radius:2px 2px 0 0;',
    ].join('');
    lbl.textContent = `▸ CAMERA  ${gw}×${gh}  [${presetLabel}]`;
    bounds.appendChild(lbl);

    // Corner L-brackets
    ['tl','tr','bl','br'].forEach(corner => {
        const c = document.createElement('div');
        const isR = corner.includes('r'), isB = corner.includes('b');
        c.style.cssText = [
            `position:absolute;width:14px;height:14px;`,
            `${isB ? 'bottom:-1px' : 'top:-1px'};`,
            `${isR ? 'right:-1px'  : 'left:-1px'};`,
            `border-${isB ? 'top' : 'bottom'}:2px solid rgba(255,200,60,1);`,
            `border-${isR ? 'left' : 'right'}:2px solid rgba(255,200,60,1);`,
        ].join('');
        bounds.appendChild(c);
    });
}

function _positionCameraBounds(el) {
    if (!state.sceneContainer) return;
    const sc  = state.sceneContainer;
    const gw  = getGameWidth();
    const gh  = getGameHeight();
    const tlx = sc.x + (-gw/2) * sc.scale.x;
    const tly = sc.y + (-gh/2) * sc.scale.y;
    const w   = gw * sc.scale.x;
    const h   = gh * sc.scale.y;
    el.style.left   = tlx + 'px';
    el.style.top    = tly + 'px';
    el.style.width  = w + 'px';
    el.style.height = h + 'px';
}

export function updateCameraBoundsIfVisible() {
    if (state.isPlaying) return;
    const el = document.getElementById('camera-bounds-overlay');
    if (el) _positionCameraBounds(el);
}

/* ── Canvas expand using GAME CAMERA (not editor camera) ── */
function _expandCanvasGameCamera() {
    const el = document.getElementById('pixi-container');
    if (!el) return;
    el.dataset.origStyle = el.getAttribute('style') || '';
    el.style.cssText = 'position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:9000!important;background:#000;';

    if (state.app && state.sceneContainer) {
        const sw     = window.innerWidth;
        const sh     = window.innerHeight;
        const preset = state.sceneSettings?.cameraPreset || 'landscape-desktop';

        state.app.renderer.resize(sw, sh);

        let gw = getGameWidth();
        let gh = getGameHeight();

        if (preset === 'automatic') {
            // Adapt: if device is portrait use portrait dims, else use landscape dims
            const isPortrait = sh > sw;
            if (isPortrait) {
                // Ensure game dims are portrait
                if (gw > gh) { const t = gw; gw = gh; gh = t; }
            } else {
                // Ensure game dims are landscape
                if (gh > gw) { const t = gw; gw = gh; gh = t; }
            }
            // Fill: scale to cover (no black bars, may crop)
            const gameCamScale = Math.max(sw / gw, sh / gh);
            state.sceneContainer.scale.set(gameCamScale);
        } else {
            // Letterbox: fit inside screen, preserving aspect ratio
            const scaleX = sw / gw;
            const scaleY = sh / gh;
            const gameCamScale = Math.min(scaleX, scaleY);
            state.sceneContainer.scale.set(gameCamScale);
        }

        state.sceneContainer.x = sw / 2;
        state.sceneContainer.y = sh / 2;
    }
}

/* ── Block/unblock all editor interaction during play ── */
function _blockEditorInput(block) {
    const canvas = state.app?.view;
    if (!canvas) return;
    if (block) {
        // Overlay a transparent div that eats all pointer events on the canvas
        let blocker = document.getElementById('play-input-blocker');
        if (!blocker) {
            blocker = document.createElement('div');
            blocker.id = 'play-input-blocker';
            blocker.style.cssText = 'position:fixed;inset:0;z-index:8999;cursor:default;touch-action:none;';
            // Block wheel (zoom) and pointer (editor selection) — but let touch/click
            // events continue bubbling so scripts receive mousedown/mouseup/touchstart/touchend.
            blocker.addEventListener('wheel',       e => e.stopPropagation(), { passive: false });
            blocker.addEventListener('pointerdown', e => {
                // Only stop propagation for mouse (not touch) to block editor gizmo drag.
                // Touch events have already been relayed to scripts via the window listeners.
                if (e.pointerType === 'mouse') e.stopPropagation();
            });
            blocker.addEventListener('contextmenu', e => e.preventDefault());
            document.body.appendChild(blocker);
        }
        // Also freeze sceneContainer so middle-mouse pan won't move camera
        state._playModeCamLocked = true;
    } else {
        document.getElementById('play-input-blocker')?.remove();
        state._playModeCamLocked = false;
    }
}

/* ── Canvas expand/restore (legacy, no longer used for enter — kept for restore) ── */
function _expandCanvas() {
    const el = document.getElementById('pixi-container');
    if (!el) return;
    el.dataset.origStyle = el.getAttribute('style') || '';
    el.style.cssText = 'position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;z-index:9000!important;background:#000;';
    if (state.app) {
        state.app.renderer.resize(window.innerWidth, window.innerHeight);
        if (state.sceneContainer) {
            state.sceneContainer.x = window.innerWidth  / 2;
            state.sceneContainer.y = window.innerHeight / 2;
        }
    }
}

function _restoreCanvas(snap) {
    const el = document.getElementById('pixi-container');
    if (!el) return;
    el.setAttribute('style', el.dataset.origStyle || '');
    delete el.dataset.origStyle;
    setTimeout(() => {
        if (!state.app) return;
        const rect = el.getBoundingClientRect();
        if (rect.width && rect.height) state.app.renderer.resize(rect.width, rect.height);
        // Restore editor camera from snapshot (pos + zoom)
        if (snap && state.sceneContainer) {
            state.sceneContainer.x       = snap.camX;
            state.sceneContainer.y       = snap.camY;
            state.sceneContainer.scale.x = snap.camScaleX;
            state.sceneContainer.scale.y = snap.camScaleY;
        } else if (state.sceneContainer) {
            state.sceneContainer.x = rect.width  / 2;
            state.sceneContainer.y = rect.height / 2;
        }
        // Restore grid visibility
        if (state.gridGraphics) state.gridGraphics.visible = true;
        import('./engine.renderer.js').then(m => m.drawGrid());
        import('./engine.playmode.js').then(m => m.drawCameraBounds());
    }, 80);
}

/* ── Hide/show editor UI ── */
const HIDE_SELECTORS = ['.menu-bar','#panel-left','#panel-right','#panel-bottom','.toolbar'];

function _hideEditorUI() {
    HIDE_SELECTORS.forEach(sel =>
        document.querySelectorAll(sel).forEach(el => {
            el.dataset.pmHidden = '1';
            el.style.display = 'none';
        })
    );
    document.getElementById('camera-bounds-overlay')?.remove();

    const bar = document.createElement('div');
    bar.id = 'play-mode-bar';
    bar.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;gap:4px;background:rgba(10,16,24,0.85);backdrop-filter:blur(8px);border:1px solid #3A72A5;border-radius:6px;padding:6px 10px;box-shadow:0 4px 24px rgba(0,0,0,0.7);';
    bar.innerHTML = `
        <button id="pm-play"  style="background:rgba(74,222,128,0.15);border:1px solid #4ade80;color:#4ade80;border-radius:4px;padding:6px 16px;cursor:pointer;font-size:12px;font-weight:bold;letter-spacing:0.5px;">▶ PLAYING</button>
        <button id="pm-pause" title="Pause (P)" style="background:rgba(250,204,21,0.1);border:1px solid #facc15;color:#facc15;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:13px;">⏸</button>
        <button id="pm-stop"  title="Stop (Space / Esc)" style="background:rgba(248,113,113,0.1);border:1px solid #f87171;color:#f87171;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:12px;">■ Stop</button>
    `;
    document.body.appendChild(bar);
    bar.querySelector('#pm-pause').onclick = () => pausePlayMode();
    bar.querySelector('#pm-stop').onclick  = () => stopPlayMode();
}

function _showEditorUI() {
    document.querySelectorAll('[data-pm-hidden]').forEach(el => {
        el.style.display = '';
        delete el.dataset.pmHidden;
    });
    document.getElementById('play-mode-bar')?.remove();
}

/* ── Gizmos + grid ── */
function _hideAllGizmosAndGrid() {
    state.gameObjects.forEach(obj => {
        if (obj._gizmoContainer) obj._gizmoContainer.visible = false;
        if (obj.isLight && obj._lightHelper) obj._lightHelper.visible = false;
        if (obj.isTilemap && obj._tilemapHelper) obj._tilemapHelper.visible = false;
        if (obj.isAutoTilemap && obj._autoTileHelper) obj._autoTileHelper.visible = false;
    });
    // Hide audio source visuals in play mode (they are editor-only)
    for (const src of state.audioSources) {
        if (src._container) src._container.visible = false;
    }
    if (state.gridGraphics) state.gridGraphics.visible = false;
    if (state.spriteBox)    state.spriteBox.visible    = false;
}

function _showGrid() {
    if (state.gridGraphics) state.gridGraphics.visible = true;
}

function _deselect() {
    if (state.gameObject) {
        const gc = state.gameObject._gizmoContainer;
        if (gc) gc.visible = false;
    }
    state.gameObject = null;
}

/* ── Play overlays ── */
function _showPlayOverlay() {
    const pause = document.createElement('div');
    pause.id = 'play-pause-overlay';
    pause.style.cssText = 'position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);display:none;align-items:center;justify-content:center;flex-direction:column;gap:16px;';
    pause.innerHTML = '<div style="font-size:64px;color:rgba(250,204,21,0.9);filter:drop-shadow(0 0 24px #facc15);">⏸</div><div style="color:#facc15;font-size:20px;letter-spacing:4px;font-weight:bold;">PAUSED</div><div style="color:#555;font-size:11px;">Press ⏸ to resume</div>';
    document.body.appendChild(pause);

    const stats = document.createElement('div');
    stats.id = 'play-stats-bar';
    stats.style.cssText = 'position:fixed;bottom:14px;right:18px;z-index:9999;color:rgba(74,222,128,0.7);font-family:monospace;font-size:11px;text-align:right;pointer-events:none;line-height:1.7;text-shadow:0 1px 4px rgba(0,0,0,0.8);';
    document.body.appendChild(stats);

    const res = document.createElement('div');
    res.id = 'play-res-label';
    res.style.cssText = 'position:fixed;bottom:14px;left:18px;z-index:9999;color:rgba(255,255,255,0.2);font-family:monospace;font-size:10px;pointer-events:none;';
    res.textContent = `${getGameWidth()}×${getGameHeight()}  ·  PREVIEW MODE`;
    document.body.appendChild(res);
}

function _removePlayOverlay() {
    ['play-pause-overlay','play-stats-bar','play-res-label'].forEach(id => document.getElementById(id)?.remove());
}

/* ── FPS counter ── */
let _fpsInt = null;
function _startFPSCounter() {
    _stopFPSCounter();
    _fpsInt = setInterval(() => {
        const bar = document.getElementById('play-stats-bar');
        if (!bar || !state.app) return;
        const fps  = Math.round(state.app.ticker.FPS);
        const col  = fps >= 55 ? '#4ade80' : fps >= 30 ? '#facc15' : '#f87171';
        const objs = state.gameObjects.length;
        bar.innerHTML = `<div style="color:${col}">${fps} FPS</div><div style="color:rgba(255,255,255,0.3)">${objs} obj</div>`;
    }, 250);
}
function _stopFPSCounter() { if (_fpsInt) { clearInterval(_fpsInt); _fpsInt = null; } }

/* ── Button states ── */
function _updatePlayButtons() {
    const pmPause = document.getElementById('pm-pause');
    const pmPlay  = document.getElementById('pm-play');
    if (pmPause) { pmPause.textContent = state.isPaused ? '▶' : '⏸'; }
    if (pmPlay)  {
        pmPlay.textContent = state.isPaused ? '⏸ PAUSED' : '▶ PLAYING';
        pmPlay.style.color = state.isPaused ? '#facc15' : '#4ade80';
        pmPlay.style.borderColor = state.isPaused ? '#facc15' : '#4ade80';
    }
    ['btn-play','btn-pause','btn-stop'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('active', false);
    });
    const pb = document.getElementById('btn-play');
    if (pb) pb.classList.toggle('active', state.isPlaying && !state.isPaused);
}

/* ── Snapshot / restore ── */
function _snapshotScene() {
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
                prefabId: obj.prefabId || null, x: obj.x, y: obj.y,
                scaleX: obj.scale.x, scaleY: obj.scale.y, rotation: obj.rotation, unityZ: obj.unityZ || 0,
                tint: obj.spriteGraphic?.tint ?? 0xFFFFFF,
                animations: obj.animations ? JSON.parse(JSON.stringify(obj.animations)) : [],
                activeAnimIndex: obj.activeAnimIndex || 0,
                // ── Physics / collision ─────────────────────────────
                physicsBody:             obj.physicsBody             ?? 'none',
                physicsFriction:         obj.physicsFriction         ?? 0.3,
                physicsRestitution:      obj.physicsRestitution      ?? 0.1,
                physicsDensity:          obj.physicsDensity          ?? 0.001,
                physicsGravityScale:     obj.physicsGravityScale     ?? 1,
                physicsLinearDamping:    obj.physicsLinearDamping    ?? 0,
                physicsAngularDamping:   obj.physicsAngularDamping   ?? 0,
                physicsFixedRotation:    !!obj.physicsFixedRotation,
                physicsIsSensor:         !!obj.physicsIsSensor,
                physicsCollisionCategory: obj.physicsCollisionCategory ?? 1,
                physicsCollisionMask:    obj.physicsCollisionMask    ?? 0xFFFFFFFF,
                physicsShape:            obj.physicsShape            ?? 'box',
                physicsSize:     obj.physicsSize     ? JSON.parse(JSON.stringify(obj.physicsSize))     : null,
                physicsPolygon:  obj.physicsPolygon  ? JSON.parse(JSON.stringify(obj.physicsPolygon))  : null,
                physicsPolygons: obj.physicsPolygons ? JSON.parse(JSON.stringify(obj.physicsPolygons)) : null,
                _polyUnit:           obj._polyUnit || null,
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
        camX: state.sceneContainer?.x ?? 0, camY: state.sceneContainer?.y ?? 0,
        camScaleX: state.sceneContainer?.scale.x ?? 1, camScaleY: state.sceneContainer?.scale.y ?? 1,
        selectedLabel: state.gameObject?.label ?? null,
        // Capture per-scene settings (resolution, bgColor, cameraPreset, gravity)
        // so stopPlayMode restores this scene exactly as it was configured.
        sceneSettings: JSON.parse(JSON.stringify(state.sceneSettings ?? {})),
        // Remember which scene was active when Play was pressed so stopPlayMode
        // always returns to the correct editor scene, even if gotoScene() ran.
        originSceneIndex: state.activeSceneIndex,
    };
}

function _restoreScene(snap) {
    // Hide canvas during object swap to prevent one-frame flicker
    if (state.sceneContainer) state.sceneContainer.visible = false;
    // Suppress per-object refreshHierarchy during bulk restore
    state._loadingScene = true;

    for (const obj of state.gameObjects) {
        state.sceneContainer?.removeChild(obj);
        try { obj.destroy({ children: true }); } catch(_) {}
    }
    state.gameObjects = []; state.gameObject = null; state.gizmoContainer = null;

    // ── Always return editor to the scene that was active when Play was pressed ──
    if (snap.originSceneIndex != null && snap.originSceneIndex !== state.activeSceneIndex) {
        state.activeSceneIndex = snap.originSceneIndex;
        import('./engine.scenes.js').then(sm => sm.refreshSceneUI?.());
    }

    // Restore per-scene camera AND scene settings (preserves each scene's resolution/bg)
    if (state.sceneContainer) {
        state.sceneContainer.x       = snap.camX;
        state.sceneContainer.y       = snap.camY;
        state.sceneContainer.scale.x = snap.camScaleX;
        state.sceneContainer.scale.y = snap.camScaleY;
    }
    // Restore the scene settings (gameWidth/gameHeight/bgColor/etc) that were live
    // when Play was pressed — this is what each scene independently configured.
    if (snap.sceneSettings) {
        state.sceneSettings = JSON.parse(JSON.stringify(snap.sceneSettings));
        if (state.app?.renderer) state.app.renderer.background.color = state.sceneSettings.bgColor;
        import('./engine.playmode.js').then(m => m.drawCameraBounds());
        import('./engine.ui.js').then(m => m.refreshSceneSettingsPanel?.());
    }

    const restorePromises = snap.objects.map(s => {
        if (s.isLight) {
            return import('./engine.lights.js').then(({ createLight, _buildLightHelper }) => {
                const obj = createLight(s.lightType, s.x, s.y);
                if (!obj) return null;
                obj.label   = s.label; obj.unityZ = s.unityZ || 0;
                obj.visible = s.visible !== false; obj.alpha = s.alpha ?? 1;
                obj.lightProps = JSON.parse(JSON.stringify(s.lightProps));
                _buildLightHelper(obj);
                return obj;
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
                if (!obj) return null;
                obj.label = s.label; obj.unityZ = s.unityZ || 0;
                obj.visible = s.visible !== false; obj.alpha = s.alpha ?? 1;
                obj.scriptName = s.scriptName ?? null;
                obj._scriptTag = s.scriptTag  ?? null;
                obj._scriptGroup = s.scriptGroup ?? null;
                if (state._bindGizmoHandles) state._bindGizmoHandles(obj);
                return obj;
            });
        }
        return import('./engine.objects.js').then(({ createImageObject }) => {
            if (s.isImage && s.assetId) {
                const asset = state.assets.find(a => a.id === s.assetId);
                if (!asset) return null;
                const obj = createImageObject(asset, s.x, s.y);
                if (!obj) return null;
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
                return obj;
            }
            return null;
        });
    });

    Promise.all(restorePromises).then(() => {
        // Sort by Z-order so layers are correct after async restore
        _applyZOrder();
        state._loadingScene = false;
        if (state.sceneContainer) state.sceneContainer.visible = true;
        import('./engine.objects.js').then(({ selectObject }) => {
            const target = snap.selectedLabel
                ? state.gameObjects.find(o => o.label === snap.selectedLabel)
                : null;
            if (target) selectObject(target);
            import('./engine.ui.js').then(m => { m.syncPixiToInspector(); m.refreshHierarchy(); });
        });
    });
}

function _applyZOrder() {
    if (!state.sceneContainer) return;
    state.gameObjects.sort((a, b) => (a.unityZ || 0) - (b.unityZ || 0));
    for (let i = 0; i < state.gameObjects.length; i++) {
        const obj = state.gameObjects[i];
        try {
            const curIdx = state.sceneContainer.getChildIndex(obj);
            const target = Math.min(i, state.sceneContainer.children.length - 1);
            if (curIdx !== target) state.sceneContainer.setChildIndex(obj, target);
        } catch(_) {}
    }
}

function _logConsole(msg, color = '#e0e0e0') {
    const level = color === '#f87171' ? 'error' : color === '#facc15' ? 'warn' : color === '#4ade80' ? 'system' : 'log';
    import('./engine.console.js').then(m => m.engineLog(msg, level));
}

/* ============================================================
   🎮 SURPRISE: Mini Runtime — plays object animations in Play Mode
   Objects with animations actually animate when you press Play.
   Uses PIXI.AnimatedSprite for smooth frame playback.
   ============================================================ */

export function startRuntimeAnimations() {
    for (const obj of state.gameObjects) {
        if (obj.isLight)  { obj.visible = false; continue; }
        if (obj.isText)   { obj.visible = obj._savedPlayVisible !== false ? true : obj.visible; continue; }
        if (obj.isTilemap) {
            obj.visible = true;
            import('./engine.tilemap.js').then(m => m.rebuildTilemapSprites(obj));
            continue;
        }
        if (obj.isAutoTilemap) {
            obj.visible = true;
            if (obj._autoTileHelper) obj._autoTileHelper.visible = false;
            import('./engine.autotile.js').then(m => m.rebuildAutoTileSprites(obj));
            continue;
        }
        obj.visible = true;
        _playObjectIdleAnim(obj);
    }
    // Enforce Z-order at play start
    _applyZOrder();
    _startCulling();
}

export function stopRuntimeAnimations() {
    _stopCulling();
    for (const obj of state.gameObjects) {
        _stopObjectAnim(obj);
        obj.visible = true;
        // Restore editor helpers
        if (obj.isLight && obj._lightHelper) obj._lightHelper.visible = true;
        if (obj.isTilemap && obj._tilemapHelper) obj._tilemapHelper.visible = true;
        if (obj.isAutoTilemap && obj._autoTileHelper) obj._autoTileHelper.visible = true;
    }
}

/* ── Camera Culling + Scene Clipping ────────────────────────── */
let _cullTicker = null;
let _sceneMask  = null;  // single Graphics that clips the whole scene to game bounds

function _startCulling() {
    _stopCulling();

    // ONE mask on the sceneContainer — nothing outside the camera rect ever renders.
    // This is the correct fix for the white-flash bug caused by per-object masks.
    if (state.app && state.sceneContainer) {
        _sceneMask = new PIXI.Graphics();
        state.app.stage.addChild(_sceneMask);
        state.sceneContainer.mask = _sceneMask;
        _updateSceneMask();
    }

    _cullTicker = () => {
        if (!state.isPlaying || !state.app || !state.sceneContainer) return;
        // Update the scene clipping mask every frame so it stays in sync
        // with camera movement (including cameraFollow).
        _updateSceneMask();
        // Update 3D audio listener position every frame
        import('./engine.audio.js').then(m => m.updateAudioListener());
        // NOTE: We do NOT cull individual object visibility here.
        // The Pixi mask (_sceneMask) already clips everything outside the camera
        // bounds perfectly. Per-object visibility culling causes objects to flicker
        // or disappear when the camera follows a moving target, and it also fights
        // any setVisible(false) calls from scripts.
    };
    state.app.ticker.add(_cullTicker);
}

function _updateSceneMask() {
    if (!_sceneMask || !state.sceneContainer) return;
    const sc    = state.sceneContainer;
    const gw    = getGameWidth();
    const gh    = getGameHeight();
    const scale = sc.scale.x;
    const sw    = state.app?.screen?.width  ?? window.innerWidth;
    const sh    = state.app?.screen?.height ?? window.innerHeight;
    // Mask covers the FIXED letterbox area on screen.
    // sc.x/sc.y change when the camera follows an object — the game's visible
    // window stays fixed at the centre of the screen regardless of camera pan.
    const w = gw * scale;
    const h = gh * scale;
    const x = (sw - w) / 2;
    const y = (sh - h) / 2;
    _sceneMask.clear();
    _sceneMask.beginFill(0xFFFFFF, 1);
    _sceneMask.drawRect(x, y, w, h);
    _sceneMask.endFill();
}

/** Called by scripting after camera moves — keeps mask in sync with camera follow */
export function updateSceneMask() { _updateSceneMask(); }

function _stopCulling() {
    if (_cullTicker && state.app) {
        try { state.app.ticker.remove(_cullTicker); } catch (_) {}
        _cullTicker = null;
    }
    // Remove scene mask
    if (_sceneMask) {
        if (state.sceneContainer) state.sceneContainer.mask = null;
        try { state.app?.stage?.removeChild(_sceneMask); _sceneMask.destroy(); } catch (_) {}
        _sceneMask = null;
    }
    // Note: we do NOT forcibly restore obj.visible here — the playmode restore
    // snapshots handle that. Just clear the culling flag.
    for (const obj of state.gameObjects) {
        obj._wasCulled = false;
    }
}

function _playObjectIdleAnim(obj) {
    if (!obj.animations?.length) return;

    // Find the active (or idle) animation
    const anim = obj.animations[obj.activeAnimIndex || 0] || obj.animations[0];
    if (!anim?.frames?.length) return;

    // Build PIXI AnimatedSprite
    const textures = anim.frames.map(f => {
        try { return PIXI.Texture.from(f.dataURL); }
        catch (_) { return PIXI.Texture.WHITE; }
    });

    if (textures.length === 0) return;

    // Remove old animated sprite
    if (obj._runtimeSprite) {
        obj.removeChild(obj._runtimeSprite);
        try { obj._runtimeSprite.destroy(); } catch (_) {}
        obj._runtimeSprite = null;
    }

    const as = new PIXI.AnimatedSprite(textures);
    as.animationSpeed = Math.max(0.01, (anim.fps || 12) / 60);
    as.loop           = anim.loop !== false;
    as.anchor.set(0.5);

    // Match size to existing spriteGraphic
    if (obj.spriteGraphic) {
        const sg = obj.spriteGraphic;
        as.width  = sg.width  || 100;
        as.height = sg.height || 100;
        as.tint   = sg.tint   ?? 0xFFFFFF;
        obj.removeChild(sg);
        obj._savedSpriteGraphic = sg;
    }

    obj.addChildAt(as, 0);
    obj._runtimeSprite = as;
    as.play();
}

function _stopObjectAnim(obj) {
    if (obj._runtimeSprite) {
        obj.removeChild(obj._runtimeSprite);
        try { obj._runtimeSprite.destroy(); } catch (_) {}
        obj._runtimeSprite = null;
    }
    // Restore original graphic
    if (obj._savedSpriteGraphic) {
        obj.addChildAt(obj._savedSpriteGraphic, 0);
        obj.spriteGraphic       = obj._savedSpriteGraphic;
        obj._savedSpriteGraphic = null;
    }
}
