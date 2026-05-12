/* ============================================================
   Zengine — engine.animator.js
   Full-screen Animation Editor modal.
   Opens on double-click of any scene object.

   Data model stored on each container object:
     obj.animations = [
       {
         id:     string,
         name:   string,
         fps:    number,
         loop:   boolean,
         frames: [ { id:string, dataURL:string, name:string } ]
       },
       ...
     ]
     obj.activeAnimIndex = 0   (which anim is selected in editor)
     obj._animTicker = null    (PIXI ticker callback if previewing)
 * ============================================================ */

import { state } from './engine.state.js';
import { alphaBoundsForDataURL } from './engine.collision-overlay.js';

// ── Auto-fit collision shape from a specific dataURL ─────────
function _autoFitFromDataURL(obj, dataURL, frameId, onDone) {
    const img = new Image();
    img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || 64;
        canvas.height = img.naturalHeight || 64;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const w = canvas.width, h = canvas.height;
        let minX = w, maxX = 0, minY = h, maxY = 0, found = false;
        try {
            const data = ctx.getImageData(0, 0, w, h).data;
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                if (data[(y * w + x) * 4 + 3] > 20) {
                    if (x < minX) minX = x; if (x > maxX) maxX = x;
                    if (y < minY) minY = y; if (y > maxY) maxY = y;
                    found = true;
                }
            }
        } catch(_) {}
        const cx = w / 2, cy = h / 2;
        // Hull is computed in TEXTURE pixels, then scaled into container-local px
        // so it matches obj.scale / physicsSize / alpha-bounds units used everywhere else.
        const src = obj.spriteGraphic || obj._runtimeSprite;
        const ssx = Math.abs(src?.scale?.x ?? 1) || 1;
        const ssy = Math.abs(src?.scale?.y ?? 1) || 1;
        const hullTex = found ? [
            { x: minX - cx, y: minY - cy }, { x: maxX - cx, y: minY - cy },
            { x: maxX - cx, y: maxY - cy }, { x: minX - cx, y: maxY - cy },
        ] : [
            { x: -cx, y: -cy }, { x: cx, y: -cy },
            { x: cx, y: cy },  { x: -cx, y: cy },
        ];
        const hull = hullTex.map(p => ({ x: p.x * ssx, y: p.y * ssy }));
        if (!obj.physicsPolygons) obj.physicsPolygons = {};
        obj.physicsPolygons[frameId] = hull;
        if (frameId === 'shared') obj.physicsPolygon = hull.slice();
        obj.physicsShape = 'polygon';
        obj._polyUnit = 'container';
        onDone?.();
    };
    img.src = dataURL;
}

// ── Public: open the editor for an object ────────────────────
export function openAnimationEditor(obj) {
    if (!obj) return;

    // Ensure data structure exists — minimum 1 animation (Idle)
    if (!obj.animations) {
        obj.animations      = [];
        obj.activeAnimIndex = 0;
    }
    if (obj.animations.length === 0) {
        // Re-create Idle — use sprite dataURL if image object
        const idleDataURL = obj.isImage
            ? state.assets.find(a => a.id === obj.assetId)?.dataURL ?? null
            : null;
        obj.animations.push({
            id: 'anim_idle_' + Date.now(),
            name: 'Idle', fps: 12, loop: true, isIdle: true,
            frames: idleDataURL
                ? [{ id: 'frame_idle_0', name: 'frame_0', dataURL: idleDataURL }]
                : [],
        });
    }
    // Guarantee Idle is always first
    if (!obj.animations[0].isIdle) {
        const idleIdx = obj.animations.findIndex(a => a.isIdle);
        if (idleIdx > 0) {
            const [idle] = obj.animations.splice(idleIdx, 1);
            obj.animations.unshift(idle);
            obj.activeAnimIndex = Math.max(0, obj.activeAnimIndex);
        }
    }

    _stopPreview(obj);
    _buildModal(obj);
}

// ── Build the modal DOM ───────────────────────────────────────
function _buildModal(obj) {
    // Remove any existing modal
    document.getElementById('anim-editor-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'anim-editor-modal';
    modal.style.cssText = `
        position: fixed; inset: 0; z-index: 10000;
        background: rgba(0,0,0,0.85);
        display: flex; flex-direction: column;
        font-family: 'Segoe UI', Tahoma, sans-serif;
        font-size: 11px; color: #e0e0e0;
        user-select: none;
    `;

    modal.innerHTML = _buildHTML(obj);
    document.body.appendChild(modal);

    _wire(modal, obj);
    _renderAnimList(modal, obj);
    _renderFrameStrip(modal, obj);
    _renderPreviewCanvas(modal, obj);
}

// ── HTML skeleton ─────────────────────────────────────────────
function _buildHTML(obj) {
    return `
    <!-- Title bar -->
    <div style="height:40px; background:#1a1a1a; border-bottom:2px solid #111;
                display:flex; align-items:center; padding:0 16px; gap:12px; flex-shrink:0;">
        <svg viewBox="0 0 24 24" style="width:18px;height:18px;fill:none;stroke:#3A72A5;stroke-width:2;">
            <rect x="2" y="4" width="20" height="16" rx="2"/>
            <path d="M8 4v16M2 9h6M2 15h6"/>
        </svg>
        <span style="font-size:14px; font-weight:bold; color:#fff;">Animation Editor</span>
        <span style="color:#666;">—</span>
        <span style="color:#aaa;">${obj.label || 'Object'}</span>
        <div style="flex:1;"></div>
        <!-- Import zip/folder -->
        <label id="anim-import-label" style="background:#2a4a6a; border:1px solid #3A72A5; color:#cce;
               border-radius:3px; padding:4px 12px; cursor:pointer; font-size:11px;">
            ⬆ Import ZIP / Images
        </label>
        <input type="file" id="anim-file-input" accept=".zip,image/*" multiple style="display:none;">
        <!-- Spritesheet slicer -->
        <button id="anim-slice-sheet-btn" style="background:#2a3a2a; border:1px solid #4ade80; color:#4ade80;
                border-radius:3px; padding:4px 12px; cursor:pointer; font-size:11px; display:flex; align-items:center; gap:5px;">
            <svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2;">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/>
              <line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>
            </svg>
            Slice Sheet
        </button>
        <button id="anim-close-btn" style="background:#3a2a2a; border:1px solid #6a3a3a; color:#f88;
                border-radius:3px; padding:4px 12px; cursor:pointer; font-size:12px;">✕ Close</button>
    </div>

    <!-- Main area -->
    <div style="flex:1; display:flex; overflow:hidden;">

        <!-- LEFT: Animation list -->
        <div style="width:200px; background:#242424; border-right:2px solid #111;
                    display:flex; flex-direction:column; flex-shrink:0;">
            <div style="padding:8px 10px; background:#1e1e1e; border-bottom:1px solid #111;
                        font-weight:bold; color:#aaa; font-size:10px; letter-spacing:1px;">
                ANIMATIONS
            </div>
            <div id="anim-list" style="flex:1; overflow-y:auto;"></div>
            <div style="padding:8px; border-top:1px solid #111;">
                <button id="anim-new-btn" style="width:100%; background:#1e3a1e; border:1px solid #2a6a2a;
                        color:#8f8; border-radius:3px; padding:5px; cursor:pointer; font-size:11px;">
                    ＋ New Animation
                </button>
            </div>
        </div>

        <!-- CENTRE: Preview + frame strip -->
        <div style="flex:1; display:flex; flex-direction:column; min-width:0;">

            <!-- Preview area -->
            <div style="flex:1; display:flex; align-items:center; justify-content:center;
                        background:#1e1e1e; position:relative; min-height:0;">
                <canvas id="anim-preview-canvas"
                        style="max-width:100%; max-height:100%; image-rendering:pixelated;
                               border:1px solid #333; background:#282828;"></canvas>
                <div id="anim-empty-hint" style="position:absolute; color:#444; font-size:16px;
                     pointer-events:none; display:none;">
                    No frames — import images or a ZIP to begin
                </div>

                <!-- Playback controls overlay -->
                <div style="position:absolute; bottom:12px; left:50%; transform:translateX(-50%);
                            display:flex; gap:6px; background:rgba(0,0,0,0.7);
                            border:1px solid #333; border-radius:20px; padding:6px 14px; align-items:center;">
                    <button id="anim-prev-frame" title="Prev frame"
                            style="background:none; border:none; color:#aaa; cursor:pointer; font-size:16px;">⏮</button>
                    <button id="anim-play-btn" title="Play/Pause"
                            style="background:#3A72A5; border:none; color:#fff; cursor:pointer;
                                   font-size:16px; width:32px; height:32px; border-radius:50%;">▶</button>
                    <button id="anim-next-frame" title="Next frame"
                            style="background:none; border:none; color:#aaa; cursor:pointer; font-size:16px;">⏭</button>
                    <div style="width:1px; height:20px; background:#333; margin:0 4px;"></div>
                    <span style="color:#666; font-size:10px;">Frame</span>
                    <span id="anim-frame-counter" style="color:#ccc; min-width:40px; text-align:center;">0 / 0</span>
                </div>
            </div>

            <!-- Frame strip -->
            <div style="height:130px; background:#2a2a2a; border-top:2px solid #111;
                        display:flex; flex-direction:column; flex-shrink:0;">
                <div style="display:flex; align-items:center; padding:4px 10px; background:#222;
                            border-bottom:1px solid #111; gap:8px; flex-shrink:0;">
                    <span style="color:#888; font-size:10px; font-weight:bold; letter-spacing:1px;">FRAMES</span>
                    <div style="flex:1;"></div>
                    <span style="color:#666; font-size:10px;">Drag to reorder · Click to select · Del to remove</span>
                </div>
                <div id="anim-frame-strip" style="flex:1; overflow-x:auto; overflow-y:hidden;
                     display:flex; align-items:center; gap:6px; padding:6px 10px;"></div>
            </div>
        </div>

        <!-- RIGHT: Animation settings -->
        <div style="width:220px; background:#242424; border-left:2px solid #111;
                    display:flex; flex-direction:column; flex-shrink:0;">
            <div style="padding:8px 10px; background:#1e1e1e; border-bottom:1px solid #111;
                        font-weight:bold; color:#aaa; font-size:10px; letter-spacing:1px;">
                SETTINGS
            </div>
            <div style="padding:12px; display:flex; flex-direction:column; gap:12px;">

                <!-- Name -->
                <div>
                    <label style="color:#888; font-size:10px; display:block; margin-bottom:4px;">Name</label>
                    <input id="anim-name-input" type="text" placeholder="Animation name"
                           style="width:100%; background:#1e1e1e; border:1px solid #333; color:#fff;
                                  border-radius:3px; padding:5px 8px; font-size:12px; outline:none;">
                </div>

                <!-- FPS -->
                <div>
                    <label style="color:#888; font-size:10px; display:block; margin-bottom:4px;">
                        Frames Per Second
                    </label>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <input id="anim-fps-slider" type="range" min="1" max="60" value="12"
                               style="flex:1; accent-color:#3A72A5;">
                        <span id="anim-fps-value" style="color:#fff; min-width:24px; text-align:right;">12</span>
                    </div>
                </div>

                <!-- Loop -->
                <div style="display:flex; align-items:center; gap:8px;">
                    <input id="anim-loop-check" type="checkbox" checked
                           style="accent-color:#3A72A5; width:14px; height:14px;">
                    <label for="anim-loop-check" style="color:#ccc; cursor:pointer;">Loop animation</label>
                </div>

                <!-- Divider -->
                <div style="border-top:1px solid #333;"></div>

                <!-- Stats -->
                <div style="background:#1a1a1a; border-radius:4px; padding:10px; display:flex; flex-direction:column; gap:6px;">
                    <div style="display:flex; justify-content:space-between;">
                        <span style="color:#666;">Frames</span>
                        <span id="anim-stat-frames" style="color:#aaa;">0</span>
                    </div>
                    <div style="display:flex; justify-content:space-between;">
                        <span style="color:#666;">Duration</span>
                        <span id="anim-stat-duration" style="color:#aaa;">0.00s</span>
                    </div>
                    <div style="display:flex; justify-content:space-between;">
                        <span style="color:#666;">Resolution</span>
                        <span id="anim-stat-res" style="color:#aaa;">—</span>
                    </div>
                </div>

                <!-- Divider -->
                <div style="border-top:1px solid #333;"></div>

                <!-- Apply to object -->
                <button id="anim-apply-btn"
                        style="background:#1e3a1e; border:1px solid #2a6a2a; color:#8f8;
                               border-radius:3px; padding:7px; cursor:pointer; font-size:11px; width:100%;">
                    ✔ Apply to Object
                </button>

                <!-- Delete animation -->
                <button id="anim-delete-anim-btn"
                        style="background:#3a1e1e; border:1px solid #6a2a2a; color:#f88;
                               border-radius:3px; padding:6px; cursor:pointer; font-size:11px; width:100%;">
                    🗑 Delete Animation
                </button>

                <!-- ── Collision Shape Section ──────────── -->
                <div style="border-top:1px solid #333; margin-top:4px;"></div>
                <div style="display:flex; align-items:center; justify-content:space-between;">
                    <span style="color:#facc15; font-size:10px; font-weight:bold; letter-spacing:1px;">⬡ COLLISION</span>
                    <button id="anim-col-toggle-vis" title="Toggle collision overlay (C)"
                            style="background:#facc1522;border:1px solid #facc1544;color:#facc15;
                                   border-radius:3px;padding:2px 7px;cursor:pointer;font-size:9px;">👁 Show</button>
                </div>

                <div id="anim-col-frame-info"
                     style="background:#1a1400;border:1px solid #facc1533;border-radius:3px;
                            padding:5px 7px;font-size:9px;color:#888;line-height:1.5;">
                    Select a frame below to edit its shape.
                </div>

                <div style="display:flex;flex-direction:column;gap:4px;">
                    <button id="anim-col-edit-frame"
                            style="background:#7c3aed22;border:1px solid #7c3aed66;color:#a78bfa;
                                   border-radius:3px;padding:5px 8px;cursor:pointer;font-size:10px;width:100%;">
                        ✏ Edit This Frame's Shape
                    </button>
                    <button id="anim-col-edit-shared"
                            style="background:#1e1a30;border:1px solid #3a3060;color:#7c6aaa;
                                   border-radius:3px;padding:5px 8px;cursor:pointer;font-size:10px;width:100%;">
                        ✏ Edit Shared Shape
                    </button>
                    <button id="anim-col-autofit"
                            style="background:#06b6d422;border:1px solid #06b6d444;color:#67e8f9;
                                   border-radius:3px;padding:5px 8px;cursor:pointer;font-size:10px;width:100%;">
                        🎯 Auto-fit from Frame
                    </button>
                    <button id="anim-col-copy-all"
                            style="background:#1a1e1a;border:1px solid #3a4a3a;color:#6a9a6a;
                                   border-radius:3px;padding:4px 8px;cursor:pointer;font-size:9px;width:100%;">
                        📋 Copy Shape to All Frames
                    </button>
                </div>
            </div>
        </div>
    </div>
    `;
}

// ── Wire all events ───────────────────────────────────────────
function _wire(modal, obj) {
    let playInterval  = null;
    let currentFrame  = 0;
    let isPlaying     = false;
    let _dirty        = false;  // tracks whether any animation changes were made

    // ── Close ───────────────────────────────────────────────
    modal.querySelector('#anim-close-btn').addEventListener('click', () => {
        _stopPlay();
        // Ask about prefab sync once on close, only if something changed
        if (_dirty && obj?.prefabId) {
            _askPrefabSyncOnClose(obj);
        }
        modal.remove();
    });

    // ── Slice Sheet ─────────────────────────────────────────
    modal.querySelector('#anim-slice-sheet-btn')?.addEventListener('click', () => {
        import('./engine.spritesheet.js').then(m => m.openSpritesheetSlicer(obj));
    });

    // ── Import file(s) ──────────────────────────────────────
    modal.querySelector('#anim-import-label').addEventListener('click', () => {
        modal.querySelector('#anim-file-input').click();
    });

    modal.querySelector('#anim-file-input').addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        if (!files.length) return;

        const anim = _currentAnim(obj);
        if (!anim) return;

        // Separate ZIPs from images
        const zips   = files.filter(f => f.name.endsWith('.zip'));
        const images = files.filter(f => f.type.startsWith('image/'));

        // Load plain images directly
        for (const img of images) {
            await _loadImageFile(img, anim);
        }

        // Unzip and load images from each zip
        for (const zip of zips) {
            await _loadZip(zip, anim);
        }

        _dirty = true;
        e.target.value = '';
        _renderFrameStrip(modal, obj);
        _renderPreviewCanvas(modal, obj);
        _updateSettings(modal, obj);
        _updateStats(modal, obj);
        currentFrame = 0;
        _showFrame(modal, obj, currentFrame);
    });

    // ── New animation ───────────────────────────────────────
    modal.querySelector('#anim-new-btn').addEventListener('click', () => {
        const anim = _newAnim('Animation ' + (obj.animations.length + 1));
        obj.animations.push(anim);
        obj.activeAnimIndex = obj.animations.length - 1;
        currentFrame = 0;
        _dirty = true;
        _renderAnimList(modal, obj);
        _renderFrameStrip(modal, obj);
        _renderPreviewCanvas(modal, obj);
        _updateSettings(modal, obj);
        _updateStats(modal, obj);
        // No mid-session popup — user will be asked on close if needed
    });

    // ── Settings: name ──────────────────────────────────────
    modal.querySelector('#anim-name-input').addEventListener('input', (e) => {
        const anim = _currentAnim(obj);
        if (anim) { anim.name = e.target.value; _dirty = true; _renderAnimList(modal, obj); }
    });

    // ── Settings: fps ───────────────────────────────────────
    const fpsSlider = modal.querySelector('#anim-fps-slider');
    const fpsValue  = modal.querySelector('#anim-fps-value');
    fpsSlider.addEventListener('input', () => {
        const anim = _currentAnim(obj);
        fpsValue.textContent = fpsSlider.value;
        if (anim) {
            anim.fps = parseInt(fpsSlider.value);
            _dirty = true;
            _updateStats(modal, obj);
            if (isPlaying) { _stopPlay(); _startPlay(); }
        }
    });

    // ── Settings: loop ──────────────────────────────────────
    modal.querySelector('#anim-loop-check').addEventListener('change', (e) => {
        const anim = _currentAnim(obj);
        if (anim) { anim.loop = e.target.checked; _dirty = true; }
    });

    // ── Delete animation ─────────────────────────────────────
    modal.querySelector('#anim-delete-anim-btn').addEventListener('click', () => {
        if (obj.animations.length <= 1) {
            // Cannot delete the last animation — just clear frames (unless it's Idle)
            const anim = _currentAnim(obj);
            if (anim?.isIdle) {
                _showToast(modal, '⚠ Cannot delete the Idle animation');
                return;
            }
            if (anim) { anim.frames = []; _dirty = true; }
        } else {
            const anim = _currentAnim(obj);
            if (anim?.isIdle) {
                _showToast(modal, '⚠ Cannot delete the Idle animation');
                return;
            }
            obj.animations.splice(obj.activeAnimIndex, 1);
            obj.activeAnimIndex = Math.max(0, obj.activeAnimIndex - 1);
            _dirty = true;
            // No mid-session popup — user will be asked on close if needed
        }
        currentFrame = 0;
        _renderAnimList(modal, obj);
        _renderFrameStrip(modal, obj);
        _renderPreviewCanvas(modal, obj);
        _updateSettings(modal, obj);
        _updateStats(modal, obj);
    });

    // ── Apply to object ──────────────────────────────────────
    modal.querySelector('#anim-apply-btn').addEventListener('click', () => {
        _applyAnimToObject(obj);
        _dirty = true;
        _showToast(modal, 'Animation applied ✔');
    });

    modal.querySelector('#anim-apply-btn').addEventListener('click', () => {
        _applyAnimToObject(obj);
        _dirty = true;
        _showToast(modal, 'Animation applied ✔');
    });

    // ── Collision section ────────────────────────────────────
    const _updateColFrameInfo = () => {
        const anim  = _currentAnim(obj);
        const frame = anim?.frames?.[currentFrame];
        const info  = modal.querySelector('#anim-col-frame-info');
        if (!info) return;
        if (!frame) {
            info.textContent = 'No frame selected.';
            info.style.color = '#555';
            return;
        }
        const polyMap = obj.physicsPolygons || {};
        const hasFr   = Array.isArray(polyMap[frame.id]) && polyMap[frame.id].length >= 3;
        const hasSh   = Array.isArray(polyMap.shared)    && polyMap.shared.length >= 3;
        info.innerHTML = `
            <span style="color:#ccc;">Frame:</span> <span style="color:#a78bfa;">${frame.name}</span><br>
            <span style="color:#${hasFr ? '4ade80' : '555'};">● Per-frame shape: ${hasFr ? 'defined' : 'none'}</span><br>
            <span style="color:#${hasSh ? '4ade80' : '555'};">● Shared shape: ${hasSh ? 'defined' : 'none'}</span>
        `;
    };

    // Override _selectFrame to also update collision info
    const _origSelectFrame = modal._selectFrame;
    modal._selectFrame = (idx) => {
        _origSelectFrame?.(idx);
        currentFrame = idx;
        _updateColFrameInfo();
    };

    _updateColFrameInfo();

    modal.querySelector('#anim-col-toggle-vis')?.addEventListener('click', () => {
        import('./engine.collision-overlay.js').then(m => {
            m.setCollisionVisible(!state.showCollision);
            const btn = modal.querySelector('#anim-col-toggle-vis');
            if (btn) btn.textContent = state.showCollision ? '👁 Hide' : '👁 Show';
        });
    });

    const _onPolySaved = () => {
        // Re-render frame thumbs + preview so the new shape shows up immediately
        _renderFrameStrip(modal, obj);
        _renderPreviewCanvas(modal, obj);
        _updateColFrameInfo();
        _dirty = true;
    };

    modal.querySelector('#anim-col-edit-frame')?.addEventListener('click', () => {
        const anim  = _currentAnim(obj);
        const frame = anim?.frames?.[currentFrame];
        if (!frame) { _showToast(modal, '⚠ Select a frame first'); return; }
        import('./engine.physics.js').then(m => m.openPolygonEditor(obj, frame.id, { onSave: _onPolySaved }));
        _dirty = true;
    });

    modal.querySelector('#anim-col-edit-shared')?.addEventListener('click', () => {
        import('./engine.physics.js').then(m => m.openPolygonEditor(obj, 'shared', { onSave: _onPolySaved }));
        _dirty = true;
    });

    modal.querySelector('#anim-col-autofit')?.addEventListener('click', () => {
        const anim  = _currentAnim(obj);
        const frame = anim?.frames?.[currentFrame];
        if (!frame) { _showToast(modal, '⚠ Select a frame first'); return; }
        // Auto-fit from this specific frame's dataURL
        _autoFitFromDataURL(obj, frame.dataURL, frame.id, () => {
            _updateColFrameInfo();
            _showToast(modal, '🎯 Shape auto-fitted from frame');
            import('./engine.collision-overlay.js').then(m => m.refreshCollisionOverlay());
        });
        _dirty = true;
    });

    modal.querySelector('#anim-col-copy-all')?.addEventListener('click', () => {
        // Make sure all polygons share the unified container-local unit before copy
        import('./engine.physics.js').then(m => m.migratePolygonsToContainer?.(obj));
        const anim  = _currentAnim(obj);
        const frame = anim?.frames?.[currentFrame];
        const polyMap = obj.physicsPolygons || {};
        const src   = (frame && polyMap[frame.id]?.length >= 3) ? polyMap[frame.id]
                    : polyMap.shared?.length >= 3 ? polyMap.shared
                    : null;
        if (!src) { _showToast(modal, '⚠ No shape on this frame to copy'); return; }
        if (!obj.physicsPolygons) obj.physicsPolygons = {};
        obj.physicsPolygons.shared = src.map(p => ({ ...p }));
        const allAnims = obj.animations || [];
        allAnims.forEach(a => (a.frames || []).forEach(f => {
            obj.physicsPolygons[f.id] = src.map(p => ({ ...p }));
        }));
        obj._polyUnit = 'container';
        _updateColFrameInfo();
        _showToast(modal, '📋 Shape copied to all frames');
        import('./engine.collision-overlay.js').then(m => m.refreshCollisionOverlay());
        _dirty = true;
    });

    // ── Playback ────────────────────────────────────────────
    const playBtn    = modal.querySelector('#anim-play-btn');
    const prevBtn    = modal.querySelector('#anim-prev-frame');
    const nextBtn    = modal.querySelector('#anim-next-frame');

    function _startPlay() {
        const anim = _currentAnim(obj);
        if (!anim || !anim.frames.length) return;
        isPlaying = true;
        playBtn.textContent = '⏸';
        playBtn.style.background = '#5a3a3a';
        const ms = 1000 / (anim.fps || 12);
        playInterval = setInterval(() => {
            currentFrame++;
            if (currentFrame >= anim.frames.length) {
                if (anim.loop) currentFrame = 0;
                else { currentFrame = anim.frames.length - 1; _stopPlay(); return; }
            }
            _showFrame(modal, obj, currentFrame);
        }, ms);
    }

    function _stopPlay() {
        isPlaying = false;
        playBtn.textContent = '▶';
        playBtn.style.background = '#3A72A5';
        clearInterval(playInterval);
        playInterval = null;
    }

    playBtn.addEventListener('click', () => {
        if (isPlaying) _stopPlay(); else _startPlay();
    });
    prevBtn.addEventListener('click', () => {
        _stopPlay();
        const anim = _currentAnim(obj);
        if (!anim?.frames.length) return;
        currentFrame = (currentFrame - 1 + anim.frames.length) % anim.frames.length;
        _showFrame(modal, obj, currentFrame);
    });
    nextBtn.addEventListener('click', () => {
        _stopPlay();
        const anim = _currentAnim(obj);
        if (!anim?.frames.length) return;
        currentFrame = (currentFrame + 1) % anim.frames.length;
        _showFrame(modal, obj, currentFrame);
    });

    // ── Keyboard shortcuts ───────────────────────────────────
    modal._keyHandler = (e) => {
        if (e.target.tagName === 'INPUT') return;
        if (e.key === 'Escape') {
            _stopPlay();
            if (_dirty && obj?.prefabId) _askPrefabSyncOnClose(obj);
            modal.remove();
        }
        if (e.key === ' ')      { e.preventDefault(); isPlaying ? _stopPlay() : _startPlay(); }
        if (e.key === 'ArrowLeft')  { _stopPlay(); prevBtn.click(); }
        if (e.key === 'ArrowRight') { _stopPlay(); nextBtn.click(); }
    };
    document.addEventListener('keydown', modal._keyHandler);
    modal.addEventListener('remove', () => document.removeEventListener('keydown', modal._keyHandler));

    // Store stop fn on modal for cleanup
    modal._stopPlay = _stopPlay;

    // ── Expose frame selector for strip clicks ───────────────
    modal._selectFrame = (idx) => {
        _stopPlay();
        currentFrame = idx;
        _showFrame(modal, obj, currentFrame);
    };
    modal._getCurrentFrame = () => currentFrame;
}

// ── Render animation list (left sidebar) ──────────────────────
function _renderAnimList(modal, obj) {
    const list = modal.querySelector('#anim-list');
    list.innerHTML = '';
    obj.animations.forEach((anim, i) => {
        const isActive = i === obj.activeAnimIndex;
        const isIdle   = !!anim.isIdle;
        const row = document.createElement('div');
        row.style.cssText = `
            padding: 8px 12px; cursor: pointer; display:flex; align-items:center; gap:6px;
            background: ${isActive ? '#2D5C88' : isIdle ? 'rgba(74,222,128,0.05)' : 'transparent'};
            border-left: 3px solid ${isActive ? '#3A72A5' : isIdle ? '#4ade80' : 'transparent'};
        `;
        row.innerHTML = `
            ${isIdle
                ? `<svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:none;stroke:#4ade80;stroke-width:2;flex-shrink:0;"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>`
                : `<svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:none;stroke:#aaa;stroke-width:2;flex-shrink:0;"><polygon points="5 3 19 12 5 21 5 3"/></svg>`
            }
            <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:${isActive ? '#fff' : isIdle ? '#8f8' : '#ccc'};">${anim.name}${isIdle ? '' : ''}</span>
            ${isIdle ? '<span style="font-size:8px;color:#4ade80;background:rgba(74,222,128,0.15);border:1px solid rgba(74,222,128,0.3);border-radius:2px;padding:1px 4px;letter-spacing:0.5px;">IDLE</span>' : ''}
            <span style="color:#555; font-size:9px;">${anim.frames.length}f</span>
        `;
        row.addEventListener('click', () => {
            obj.activeAnimIndex = i;
            modal._stopPlay?.();
            _renderAnimList(modal, obj);
            _renderFrameStrip(modal, obj);
            _renderPreviewCanvas(modal, obj);
            _updateSettings(modal, obj);
            _updateStats(modal, obj);
            _showFrame(modal, obj, 0);
        });
        list.appendChild(row);
    });
}

// ── Render frame strip ────────────────────────────────────────
function _renderFrameStrip(modal, obj) {
    const strip = modal.querySelector('#anim-frame-strip');
    strip.innerHTML = '';

    const anim = _currentAnim(obj);
    if (!anim || !anim.frames.length) {
        strip.innerHTML = '<span style="color:#444; font-style:italic; padding:0 10px;">No frames — import images or a ZIP</span>';
        return;
    }

    const currentFrame = modal._getCurrentFrame?.() || 0;

    anim.frames.forEach((frame, i) => {
        const cell = document.createElement('div');
        cell.draggable = true;
        cell.dataset.frameIdx = i;
        cell.style.cssText = `
            flex-shrink: 0; width: 76px; height: 84px;
            background: ${i === currentFrame ? '#2D4A6A' : '#1e1e1e'};
            border: 2px solid ${i === currentFrame ? '#3A72A5' : '#333'};
            border-radius: 4px; display:flex; flex-direction:column;
            align-items:center; cursor:pointer; position:relative;
            transition: border-color 0.1s;
        `;

        cell.innerHTML = `
            <img src="${frame.dataURL}" style="width:64px; height:64px; object-fit:contain; margin-top:4px; image-rendering:pixelated;">
            <span style="font-size:9px; color:#888; margin-top:2px; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; width:70px; text-align:center;">${i + 1}. ${frame.name}</span>
            <button class="frame-del-btn" data-idx="${i}" title="Delete frame"
                    style="position:absolute; top:2px; right:2px; background:#3a1a1a; border:1px solid #6a2a2a;
                           color:#f88; border-radius:2px; width:16px; height:16px; cursor:pointer;
                           font-size:10px; display:none; align-items:center; justify-content:center; padding:0;">✕</button>
        `;

        // Show/hide delete btn on hover
        cell.addEventListener('mouseenter', () => { cell.querySelector('.frame-del-btn').style.display = 'flex'; });
        cell.addEventListener('mouseleave', () => { cell.querySelector('.frame-del-btn').style.display = 'none'; });

        // Click to select frame
        cell.addEventListener('click', (e) => {
            if (e.target.classList.contains('frame-del-btn')) return;
            modal._selectFrame?.(i);
            _renderFrameStrip(modal, obj); // re-highlight
        });

        // Delete frame
        cell.querySelector('.frame-del-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            anim.frames.splice(i, 1);
            const cf = modal._getCurrentFrame?.() || 0;
            if (cf >= anim.frames.length) modal._selectFrame?.(Math.max(0, anim.frames.length - 1));
            _renderFrameStrip(modal, obj);
            _renderPreviewCanvas(modal, obj);
            _updateStats(modal, obj);
        });

        // ── Drag-to-reorder ──────────────────────────────────
        let dragSrcIdx = null;
        cell.addEventListener('dragstart', (e) => {
            dragSrcIdx = i;
            e.dataTransfer.effectAllowed = 'move';
            cell.style.opacity = '0.4';
        });
        cell.addEventListener('dragend', () => { cell.style.opacity = '1'; });
        cell.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            cell.style.borderColor = '#FACC15';
        });
        cell.addEventListener('dragleave', () => {
            cell.style.borderColor = i === currentFrame ? '#3A72A5' : '#333';
        });
        cell.addEventListener('drop', (e) => {
            e.preventDefault();
            const src = parseInt(e.dataTransfer.getData('text/plain') || dragSrcIdx);
            if (isNaN(src) || src === i) { _renderFrameStrip(modal, obj); return; }
            const moved = anim.frames.splice(src, 1)[0];
            anim.frames.splice(i, 0, moved);
            _renderFrameStrip(modal, obj);
            _showFrame(modal, obj, i);
        });
        cell.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', String(i));
        });

        strip.appendChild(cell);
    });
}

// ── Render/update preview canvas ──────────────────────────────
function _renderPreviewCanvas(modal, obj) {
    const canvas  = modal.querySelector('#anim-preview-canvas');
    const hint    = modal.querySelector('#anim-empty-hint');
    const anim    = _currentAnim(obj);
    if (!anim || !anim.frames.length) {
        canvas.style.display = 'none';
        hint.style.display   = 'block';
        modal.querySelector('#anim-frame-counter').textContent = '0 / 0';
        return;
    }
    canvas.style.display = 'block';
    hint.style.display   = 'none';
    _showFrame(modal, obj, modal._getCurrentFrame?.() || 0);
}

// ── Draw one frame to preview canvas ─────────────────────────
function _showFrame(modal, obj, idx) {
    const anim = _currentAnim(obj);
    if (!anim || !anim.frames.length) return;
    idx = Math.max(0, Math.min(idx, anim.frames.length - 1));

    const frame  = anim.frames[idx];
    const canvas = modal.querySelector('#anim-preview-canvas');
    const ctx    = canvas.getContext('2d');
    const counter= modal.querySelector('#anim-frame-counter');

    const img = new Image();
    img.onload = () => {
        // Size canvas to fit preview area on first load
        if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
            canvas.width  = img.naturalWidth  || 200;
            canvas.height = img.naturalHeight || 200;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        // Draw collision shape overlay on preview canvas
        _drawCollisionOnCanvas(ctx, obj, frame, canvas.width, canvas.height);

        // Update stats
        modal.querySelector('#anim-stat-res').textContent = `${img.naturalWidth}×${img.naturalHeight}`;
    };
    img.src = frame.dataURL;
    counter.textContent = `${idx + 1} / ${anim.frames.length}`;

    // Highlight active cell
    modal.querySelectorAll('#anim-frame-strip > div').forEach((cell, i) => {
        const active = i === idx;
        cell.style.background   = active ? '#2D4A6A' : '#1e1e1e';
        cell.style.borderColor  = active ? '#3A72A5' : '#333';
    });
}

// ── Sync settings panel to current anim ──────────────────────
function _updateSettings(modal, obj) {
    const anim = _currentAnim(obj);
    if (!anim) return;
    modal.querySelector('#anim-name-input').value = anim.name;
    const slider = modal.querySelector('#anim-fps-slider');
    slider.value = anim.fps || 12;
    modal.querySelector('#anim-fps-value').textContent = slider.value;
    modal.querySelector('#anim-loop-check').checked = !!anim.loop;
}

function _updateStats(modal, obj) {
    const anim = _currentAnim(obj);
    if (!anim) return;
    const fps = anim.fps || 12;
    const dur = anim.frames.length / fps;
    modal.querySelector('#anim-stat-frames').textContent   = anim.frames.length;
    modal.querySelector('#anim-stat-duration').textContent = dur.toFixed(2) + 's';
}

// ── Apply animation to live PIXI object ──────────────────────
function _applyAnimToObject(obj) {
    const anim = _currentAnim(obj);
    if (!anim || !anim.frames.length) return;

    // Remove old animated sprite if any
    if (obj._animSprite) {
        obj.removeChild(obj._animSprite);
        try { obj._animSprite.destroy(); } catch (_) {}
        obj._animSprite = null;
    }

    // Build PIXI textures from dataURLs
    const textures = anim.frames.map(f => {
        try { return PIXI.Texture.from(f.dataURL); }
        catch (_) { return PIXI.Texture.WHITE; }
    });
    const animSprite = new PIXI.AnimatedSprite(textures);
    animSprite.animationSpeed = (anim.fps || 12) / 60;
    animSprite.loop   = !!anim.loop;
    animSprite.anchor.set(0.5);

    const maxDim = Math.max(animSprite.texture.width || 100, animSprite.texture.height || 100);
    animSprite.scale.set(100 / maxDim);

    // Preserve tint from old spriteGraphic
    if (obj.spriteGraphic?.tint !== undefined) {
        animSprite.tint = obj.spriteGraphic.tint;
    }

    // Replace the static spriteGraphic
    if (obj.spriteGraphic) {
        obj.removeChild(obj.spriteGraphic);
        obj.spriteGraphic = null;
    }
    obj.addChildAt(animSprite, 0);
    obj.spriteGraphic = animSprite;
    obj._animSprite   = animSprite;

    // Only auto-play when in play mode; in edit mode show first frame statically
    if (window._zState?.isPlaying) {
        animSprite.play();
    } else {
        animSprite.stop();
        animSprite.gotoAndStop(0);
    }
}

// ── Stop any live preview ticker ──────────────────────────────
function _stopPreview(obj) {
    if (obj?._animInterval) {
        clearInterval(obj._animInterval);
        obj._animInterval = null;
    }
}

// ── Apply animation to object — used by undo/redo restore.
//    Shows the FIRST frame statically (no playback in edit mode).
export function reapplyAnimationToObject(obj) {
    _applyAnimToObject(obj);
    // In edit mode, stop playback immediately and freeze on frame 0
    if (!window._zState?.isPlaying && obj._animSprite) {
        obj._animSprite.stop();
        obj._animSprite.gotoAndStop(0);
    }
}

// ── Helpers ───────────────────────────────────────────────────
function _currentAnim(obj) {
    if (!obj.animations?.length) return null;
    return obj.animations[Math.min(obj.activeAnimIndex || 0, obj.animations.length - 1)];
}

function _newAnim(name) {
    return {
        id:     'anim_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        name:   name,
        fps:    12,
        loop:   true,
        frames: [],
    };
}

function _newFrame(name, dataURL) {
    return {
        id:      'frame_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        name:    name,
        dataURL: dataURL,
    };
}

// ── Load a single image File → add to anim ───────────────────
async function _loadImageFile(file, anim) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            anim.frames.push(_newFrame(file.name.replace(/\.[^.]+$/, ''), e.target.result));
            resolve();
        };
        reader.readAsDataURL(file);
    });
}

// ── Load a ZIP file using JSZip (loaded from CDN if needed) ──
async function _loadZip(file, anim) {
    // Ensure JSZip is available
    await _ensureJSZip();
    if (typeof JSZip === 'undefined') {
        _showGlobalToast('JSZip failed to load — import images directly instead');
        return;
    }

    const arrayBuffer = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);

    // Collect image entries sorted by name
    const imageEntries = [];
    zip.forEach((relativePath, zipEntry) => {
        if (zipEntry.dir) return;
        const lower = relativePath.toLowerCase();
        if (lower.match(/\.(png|jpg|jpeg|gif|webp|bmp|svg)$/)) {
            imageEntries.push({ path: relativePath, entry: zipEntry });
        }
    });

    // Natural sort by filename
    imageEntries.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));

    for (const { path, entry } of imageEntries) {
        const blob      = await entry.async('blob');
        const dataURL   = await _blobToDataURL(blob);
        const frameName = path.split('/').pop().replace(/\.[^.]+$/, '');
        anim.frames.push(_newFrame(frameName, dataURL));
    }
}

async function _ensureJSZip() {
    if (typeof JSZip !== 'undefined') return;
    await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        s.onload  = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

// ── Draw collision shape overlay on 2D canvas ─────────────────
// Used in the animation editor preview to show collision per frame
function _drawCollisionOnCanvas(ctx, obj, frame, cvW, cvH) {
    if (!obj || !frame) return;

    // Get polygon for this specific frame, fallback to shared
    const polyMap = obj.physicsPolygons || {};
    let poly = null;
    if (frame.id && Array.isArray(polyMap[frame.id]) && polyMap[frame.id].length >= 3) {
        poly = polyMap[frame.id];
    } else if (Array.isArray(polyMap.shared) && polyMap.shared.length >= 3) {
        poly = polyMap.shared;
    } else if (Array.isArray(obj.physicsPolygon) && obj.physicsPolygon.length >= 3) {
        poly = obj.physicsPolygon;
    }

    // Polygons + physicsSize are stored in CONTAINER-local pixels (= texture-px × innerScale).
    // The animator preview canvas is sized in TEXTURE pixels (frame's natural image dims).
    // To draw container-local values on the texture-px canvas we multiply by 1/innerScale.
    const sg = obj.spriteGraphic;
    let innerSx = Math.abs(sg?.scale?.x ?? 0) || 0;
    let innerSy = Math.abs(sg?.scale?.y ?? 0) || 0;
    if (!innerSx || !innerSy) {
        // Fallback: derive innerScale from "fit max dimension to 100" rule
        const maxDim = Math.max(cvW, cvH) || 1;
        const fit    = 100 / maxDim;
        innerSx = innerSx || fit;
        innerSy = innerSy || fit;
    }
    const ratioX = 1 / innerSx;   // container-px → canvas-px
    const ratioY = 1 / innerSy;

    const shape = obj.physicsShape ?? 'box';
    const cx    = cvW / 2;
    const cy    = cvH / 2;
    const ps    = obj.physicsSize || {};
    const ox    = (typeof ps.ox === 'number' ? ps.ox : 0) * ratioX;
    const oy    = (typeof ps.oy === 'number' ? ps.oy : 0) * ratioY;

    // Determine colour by body type
    const typeColours = {
        static:    '#4ade80',
        dynamic:   '#60a5fa',
        kinematic: '#facc15',
    };
    const col = typeColours[obj.physicsBody] || '#a78bfa';

    // Per-frame alpha-trim bounds in TEXTURE px (cached, async first time)
    const ab = frame.dataURL
        ? alphaBoundsForDataURL(frame.dataURL, () => {
            // When ready, request a redraw of this frame thumb
            try { _scheduleFrameThumbRedraw?.(obj, frame); } catch (_) {}
        })
        : null;

    ctx.save();

    if (shape === 'circle') {
        let r, ccx, ccy;
        if (typeof ps.r === 'number' && ps.r > 0) {
            r   = ps.r * Math.min(ratioX, ratioY);
            ccx = cx + ox;     // user-set offset (already container→canvas scaled)
            ccy = cy + oy;
        } else if (ab) {
            // ab.ox/oy is the alpha-bbox CENTRE offset from texture centre (texture px)
            r   = Math.min(ab.w, ab.h) / 2;
            ccx = cx + ab.ox;
            ccy = cy + ab.oy;
        } else {
            r   = Math.min(cvW, cvH) / 2 - 1;
            ccx = cx; ccy = cy;
        }
        ctx.strokeStyle = col;
        ctx.lineWidth   = 1.5;
        ctx.globalAlpha = 0.75;
        ctx.fillStyle   = col + '28';
        ctx.beginPath();
        ctx.arc(ccx, ccy, Math.max(1, r), 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    } else if (shape === 'polygon' && poly) {
        ctx.strokeStyle = col;
        ctx.lineWidth   = 1.5;
        ctx.globalAlpha = 0.75;
        ctx.fillStyle   = col + '28';
        ctx.beginPath();
        poly.forEach((p, i) => {
            const px = cx + p.x * ratioX;
            const py = cy + p.y * ratioY;
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // Vertex dots
        ctx.fillStyle   = col;
        ctx.globalAlpha = 0.9;
        poly.forEach(p => {
            ctx.beginPath();
            ctx.arc(cx + p.x * ratioX, cy + p.y * ratioY, 2.5, 0, Math.PI * 2);
            ctx.fill();
        });
    } else {
        // Default / box — use physicsSize if present, else alpha-trim of this frame
        let w, h, bx, by;
        if (typeof ps.w === 'number' && ps.w > 0 && typeof ps.h === 'number' && ps.h > 0) {
            w  = ps.w * ratioX;
            h  = ps.h * ratioY;
            bx = cx - w / 2 + ox;
            by = cy - h / 2 + oy;
        } else if (ab) {
            // ab.ox/oy is the alpha-bbox CENTRE offset from texture centre
            w  = ab.w;
            h  = ab.h;
            bx = cx + ab.ox - w / 2;
            by = cy + ab.oy - h / 2;
        } else {
            const pad = 1;
            w = cvW - pad * 2; h = cvH - pad * 2;
            bx = pad; by = pad;
        }
        ctx.strokeStyle = col;
        ctx.lineWidth   = 1.5;
        ctx.globalAlpha = 0.65;
        ctx.fillStyle   = col + '1a';
        ctx.fillRect(bx, by, Math.max(1, w), Math.max(1, h));
        ctx.strokeRect(bx, by, Math.max(1, w), Math.max(1, h));
    }

    // Label what source the shape is from
    if (obj.physicsBody && obj.physicsBody !== 'none') {
        const isFrameSpecific = frame.id && Array.isArray(polyMap[frame.id]) && polyMap[frame.id].length >= 3;
        const label = isFrameSpecific ? '⬡ frame' : (polyMap.shared?.length >= 3 ? '⬡ shared' : '⬡ default');
        ctx.globalAlpha = 0.7;
        ctx.fillStyle   = col;
        ctx.font        = 'bold 8px monospace';
        ctx.fillText(label, 3, cvH - 4);
    }

    ctx.restore();
}

function _blobToDataURL(blob) {
    return new Promise((res) => {
        const r = new FileReader();
        r.onload = e => res(e.target.result);
        r.readAsDataURL(blob);
    });
}

function _showToast(modal, msg) {
    const t = document.createElement('div');
    t.style.cssText = `
        position:absolute; bottom:160px; left:50%; transform:translateX(-50%);
        background:#1e3a1e; border:1px solid #2a6a2a; color:#8f8;
        border-radius:4px; padding:8px 20px; font-size:12px; z-index:10001;
        pointer-events:none; animation: fadeout 2s forwards;
    `;
    t.textContent = msg;
    modal.appendChild(t);
    setTimeout(() => t.remove(), 2000);
}

function _showGlobalToast(msg) {
    const t = document.createElement('div');
    t.style.cssText = `position:fixed; bottom:30px; left:50%; transform:translateX(-50%);
        background:#3a1e1e; border:1px solid #6a2a2a; color:#f88;
        border-radius:4px; padding:8px 20px; font-size:12px; z-index:10002;`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}

// ── Ask prefab sync once, on close, only if changes were made ─
function _askPrefabSyncOnClose(obj) {
    if (!obj?.prefabId) return;
    const prefab = (window._zState?.prefabs ?? []).find(p => p.id === obj.prefabId);
    if (!prefab) return;

    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position:fixed; inset:0; z-index:20000; background:rgba(0,0,0,0.6);
        display:flex; align-items:center; justify-content:center;
    `;
    overlay.innerHTML = `
        <div style="background:#1a2535; border:1px solid #3A72A5; border-radius:6px;
                    padding:24px 28px; max-width:380px; color:#e0e0e0; font-size:12px;
                    box-shadow:0 12px 40px rgba(0,0,0,0.8);">
            <div style="font-size:14px; font-weight:bold; margin-bottom:10px; color:#fff;">
                📦 Prefab: <span style="color:#9bc;">${prefab.name}</span>
            </div>
            <div style="color:#aaa; margin-bottom:18px;">
                You made animation changes on a prefab instance.<br>
                Propagate these changes to other instances?
            </div>
            <div style="display:flex; gap:10px; justify-content:flex-end;">
                <button id="ps-this" style="background:#1e2535; border:1px solid #445; color:#aaa; border-radius:4px; padding:7px 16px; cursor:pointer; font-size:11px;">This instance only</button>
                <button id="ps-all"  style="background:#1e3a1e; border:1px solid #4a8a4a; color:#8f8; border-radius:4px; padding:7px 16px; cursor:pointer; font-size:11px;">Apply to ALL instances</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('#ps-this').onclick = () => overlay.remove();
    overlay.querySelector('#ps-all').onclick  = () => {
        overlay.remove();
        import('./engine.prefabs.js').then(m => m.applyPrefabToAll(obj.prefabId, obj));
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}
