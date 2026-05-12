/* ============================================================
   Zengine — engine.audio.js
   Positional (3D-like) audio sources placed in the scene.
   - Drag an audio asset onto the viewport → AudioSource object
   - Shows a speaker icon + range circle (editable in inspector)
   - At play-time uses Web Audio API PannerNode so volume
     attenuates with distance from the camera (listener).
   ============================================================ */

import { state, PIXELS_PER_UNIT } from './engine.state.js';

// ── Web Audio runtime ─────────────────────────────────────────
let _actx = null;
let _runtimeNodes = [];   // { bufSrc, gainNode, panner }

function _getCtx() {
    if (!_actx || _actx.state === 'closed') {
        _actx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return _actx;
}

// ── Unique label helper ───────────────────────────────────────
function _uniqueName(base) {
    const used = new Set([
        ...state.gameObjects.map(o => o.label),
        ...state.audioSources.map(a => a.label),
    ]);
    if (!used.has(base)) return base;
    let i = 2;
    while (used.has(`${base} (${i})`)) i++;
    return `${base} (${i})`;
}

// ── Create an in-scene audio source ──────────────────────────
export function createAudioSource(asset, worldX, worldY) {
    import('./engine.history.js').then(m => m.pushUndo());

    const src = {
        id:         'aud_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        assetId:    asset.id,
        label:      _uniqueName(asset.name.replace(/\.[^.]+$/, '') || 'AudioSource'),
        x:          worldX,
        y:          worldY,
        range:      400,   // world pixels
        volume:     1.0,
        loop:       true,
        _container: null,
    };

    _buildAudioVisual(src);
    state.audioSources.push(src);

    import('./engine.ui.js').then(m => {
        m.refreshHierarchy();
        m.selectAudioSource(src);
    });

    return src;
}

// ── Build PIXI visual ─────────────────────────────────────────
export function _buildAudioVisual(src) {
    if (src._container) {
        try {
            state.sceneContainer.removeChild(src._container);
            src._container.destroy({ children: true });
        } catch (_) {}
    }

    const c = new PIXI.Container();
    c.x = src.x;
    c.y = src.y;
    c._isAudioSource = true;
    c._audioSrcRef   = src;
    src._container   = c;

    _redrawVisual(c, src);

    c.eventMode = 'static';
    c.cursor    = 'pointer';

    let _dragging = false, _ox = 0, _oy = 0;

    const _onDown = (e) => {
        if (e.button !== 0) return;
        import('./engine.ui.js').then(m => m.selectAudioSource(src));
        _dragging = true;
        const local = state.sceneContainer.toLocal(e.global);
        _ox = local.x - src.x;
        _oy = local.y - src.y;
        e.stopPropagation();
    };
    const _onMove = (e) => {
        if (!_dragging) return;
        const local = state.sceneContainer.toLocal(e.global);
        src.x = local.x - _ox;
        src.y = local.y - _oy;
        c.x = src.x;
        c.y = src.y;
        import('./engine.ui.js').then(m => m.syncAudioSourceToInspector(src));
    };
    const _onUp = () => {
        if (_dragging) {
            _dragging = false;
            import('./engine.history.js').then(m => m.pushUndo());
        }
    };

    c.on('pointerdown', _onDown);
    if (state.app?.stage) {
        state.app.stage.on('pointermove', _onMove);
        state.app.stage.on('pointerup',   _onUp);
        // Store cleanup refs on container so we can remove them when destroyed
        c._cleanupDrag = () => {
            state.app?.stage?.off('pointermove', _onMove);
            state.app?.stage?.off('pointerup',   _onUp);
        };
    }

    state.sceneContainer.addChild(c);
    return c;
}

function _redrawVisual(c, src) {
    c.removeChildren();

    // Range circle
    const circle = new PIXI.Graphics();
    circle.lineStyle(1.5, 0x3A9AD9, 0.4);
    circle.beginFill(0x3A9AD9, 0.07);
    circle.drawCircle(0, 0, src.range);
    circle.endFill();
    c._rangeCircle = circle;
    c.addChild(circle);

    // Speaker body
    const icon = new PIXI.Graphics();
    icon.beginFill(0x5aabdd);
    icon.drawRoundedRect(-9, -7, 8, 14, 2);
    icon.endFill();
    // Speaker cone
    icon.beginFill(0x5aabdd);
    icon.moveTo(-1, -7);
    icon.lineTo(11, -14);
    icon.lineTo(11, 14);
    icon.lineTo(-1, 7);
    icon.closePath();
    icon.endFill();
    // Sound waves
    icon.lineStyle(1.5, 0xaae4ff, 0.9);
    icon.arc(0, 0, 16, -0.65, 0.65);
    icon.lineStyle(1.5, 0x88ccee, 0.5);
    icon.arc(0, 0, 23, -0.85, 0.85);
    c.addChild(icon);

    // Label below
    const lbl = new PIXI.Text(src.label || '', {
        fontSize: 10, fill: 0xaaddff,
        fontFamily: 'monospace',
        dropShadow: true, dropShadowDistance: 1, dropShadowColor: 0x000000,
    });
    lbl.x = -lbl.width / 2;
    lbl.y = 20;
    c._lbl = lbl;
    c.addChild(lbl);
}

export function updateAudioSourceLabel(src) {
    if (src._container?._lbl) {
        src._container._lbl.text = src.label || '';
        src._container._lbl.x   = -src._container._lbl.width / 2;
    }
}

export function updateAudioRange(src) {
    if (!src._container?._rangeCircle) return;
    const g = src._container._rangeCircle;
    g.clear();
    g.lineStyle(1.5, 0x3A9AD9, 0.4);
    g.beginFill(0x3A9AD9, 0.07);
    g.drawCircle(0, 0, src.range);
    g.endFill();
}

// ── Remove ────────────────────────────────────────────────────
export function removeAudioSource(src) {
    import('./engine.history.js').then(m => m.pushUndo());
    if (src._container) {
        try {
            if (src._container._cleanupDrag) src._container._cleanupDrag();
            state.sceneContainer.removeChild(src._container);
            src._container.destroy({ children: true });
        } catch (_) {}
    }
    const idx = state.audioSources.indexOf(src);
    if (idx !== -1) state.audioSources.splice(idx, 1);
    import('./engine.ui.js').then(m => {
        m.refreshHierarchy();
        m.deselectAudioSource();
    });
}

// ── Inspector HTML ────────────────────────────────────────────
export function buildAudioInspectorHTML(src) {
    const asset = state.assets.find(a => a.id === src.assetId);
    const name  = asset ? asset.name : '—';
    return `
<div class="component-block" style="border-left:3px solid #3A9AD9;">
  <div class="component-header" style="background:#0e1e2e;">
    <svg viewBox="0 0 24 24" class="comp-icon" style="color:#5aabdd;">
      <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
    </svg>
    <span style="color:#8dd4f8;font-weight:600;">Audio Source</span>
  </div>
  <div class="component-body">
    <div class="prop-row">
      <span class="prop-label">Asset</span>
      <span style="color:#9bc;font-size:11px;font-style:italic;overflow:hidden;text-overflow:ellipsis;">${name}</span>
    </div>
    <div class="prop-row">
      <span class="prop-label">Position X</span>
      <input type="number" id="aud-pos-x" value="${(src.x / PIXELS_PER_UNIT).toFixed(2)}" step="0.1"
        style="width:80px;background:#1a1a24;border:1px solid #2a3a4a;color:#d8d8e8;border-radius:3px;padding:2px 4px;font-size:11px;">
    </div>
    <div class="prop-row">
      <span class="prop-label">Position Y</span>
      <input type="number" id="aud-pos-y" value="${(-src.y / PIXELS_PER_UNIT).toFixed(2)}" step="0.1"
        style="width:80px;background:#1a1a24;border:1px solid #2a3a4a;color:#d8d8e8;border-radius:3px;padding:2px 4px;font-size:11px;">
    </div>
    <div class="prop-row">
      <span class="prop-label">Volume</span>
      <input type="range" id="aud-volume" min="0" max="1" step="0.01" value="${src.volume.toFixed(2)}"
        style="flex:1;accent-color:#3A9AD9;">
      <span id="aud-volume-val" style="color:#aaa;font-size:10px;min-width:30px;text-align:right;">${Math.round(src.volume*100)}%</span>
    </div>
    <div class="prop-row">
      <span class="prop-label">Range (px)</span>
      <input type="number" id="aud-range" value="${Math.round(src.range)}" step="10" min="10"
        style="width:80px;background:#1a1a24;border:1px solid #2a3a4a;color:#d8d8e8;border-radius:3px;padding:2px 4px;font-size:11px;">
    </div>
    <div class="prop-row">
      <span class="prop-label">Loop</span>
      <input type="checkbox" id="aud-loop" ${src.loop ? 'checked' : ''} style="accent-color:#3A9AD9;width:16px;height:16px;">
    </div>
    <div style="margin-top:8px;">
      <button id="btn-aud-delete" style="
        background:rgba(180,50,50,0.15);border:1px solid rgba(180,50,50,0.4);
        color:#f88;border-radius:4px;padding:4px 10px;font-size:11px;
        cursor:pointer;width:100%;">
        Remove Audio Source
      </button>
    </div>
  </div>
</div>`;
}

export function bindAudioInspector(src) {
    const posXEl  = document.getElementById('aud-pos-x');
    const posYEl  = document.getElementById('aud-pos-y');
    const volEl   = document.getElementById('aud-volume');
    const volDisp = document.getElementById('aud-volume-val');
    const rangeEl = document.getElementById('aud-range');
    const loopEl  = document.getElementById('aud-loop');
    const delBtn  = document.getElementById('btn-aud-delete');

    const _pushU = () => import('./engine.history.js').then(m => m.pushUndo());

    if (posXEl) {
        posXEl.addEventListener('focus', _pushU);
        posXEl.addEventListener('input', () => {
            src.x = (parseFloat(posXEl.value) || 0) * PIXELS_PER_UNIT;
            if (src._container) src._container.x = src.x;
        });
    }
    if (posYEl) {
        posYEl.addEventListener('focus', _pushU);
        posYEl.addEventListener('input', () => {
            src.y = -(parseFloat(posYEl.value) || 0) * PIXELS_PER_UNIT;
            if (src._container) src._container.y = src.y;
        });
    }
    if (volEl) {
        volEl.addEventListener('input', () => {
            src.volume = parseFloat(volEl.value);
            if (volDisp) volDisp.textContent = Math.round(src.volume * 100) + '%';
        });
        volEl.addEventListener('change', _pushU);
    }
    if (rangeEl) {
        rangeEl.addEventListener('focus', _pushU);
        rangeEl.addEventListener('input', () => {
            src.range = Math.max(10, parseFloat(rangeEl.value) || 10);
            updateAudioRange(src);
        });
    }
    if (loopEl) {
        loopEl.addEventListener('change', () => {
            _pushU();
            src.loop = loopEl.checked;
        });
    }
    if (delBtn) {
        delBtn.addEventListener('click', () => removeAudioSource(src));
    }
}

export function syncAudioSourceToInspector(src) {
    const posXEl = document.getElementById('aud-pos-x');
    const posYEl = document.getElementById('aud-pos-y');
    if (posXEl) posXEl.value = (src.x / PIXELS_PER_UNIT).toFixed(2);
    if (posYEl) posYEl.value = (-src.y / PIXELS_PER_UNIT).toFixed(2);
}

// ── Serialize / restore for scenes and undo ──────────────────
export function serializeAudioSources() {
    return state.audioSources.map(s => ({
        id:      s.id,
        assetId: s.assetId,
        label:   s.label,
        x:       s.x,
        y:       s.y,
        range:   s.range,
        volume:  s.volume,
        loop:    s.loop,
    }));
}

export function restoreAudioSources(arr) {
    if (!Array.isArray(arr)) return;
    clearAudioSources();
    for (const s of arr) {
        const asset = state.assets.find(a => a.id === s.assetId);
        if (!asset) continue;
        const src = { ...s, _container: null };
        _buildAudioVisual(src);
        updateAudioSourceLabel(src);
        state.audioSources.push(src);
    }
}

export function clearAudioSources() {
    for (const s of state.audioSources) {
        if (s._container) {
            try {
                if (s._container._cleanupDrag) s._container._cleanupDrag();
                state.sceneContainer.removeChild(s._container);
                s._container.destroy({ children: true });
            } catch (_) {}
        }
    }
    state.audioSources = [];
}

// ── Play-mode audio ───────────────────────────────────────────
export async function startPlayAudio() {
    stopPlayAudio();
    if (!state.audioSources.length) return;

    const ctx = _getCtx();
    if (ctx.state === 'suspended') await ctx.resume();

    for (const src of state.audioSources) {
        const asset = state.assets.find(a => a.id === src.assetId);
        if (!asset?.dataURL) continue;
        try {
            const buf = await _decodeDataURL(ctx, asset.dataURL);
            const bufSrc = ctx.createBufferSource();
            bufSrc.buffer = buf;
            bufSrc.loop   = src.loop;

            const gainNode = ctx.createGain();
            gainNode.gain.value = src.volume;

            const panner = ctx.createPanner();
            panner.panningModel  = 'HRTF';
            // 'linear' model: gain = 1 - rolloff*(dist-ref)/(max-ref)
            // → reaches 0 exactly at the blue circle edge (src.range px → units)
            const rangeU = src.range / PIXELS_PER_UNIT;
            panner.distanceModel = 'linear';
            panner.refDistance   = Math.max(0.01, rangeU * 0.1); // full vol within 10% of range
            panner.maxDistance   = Math.max(0.02, rangeU);
            panner.rolloffFactor = 1;
            panner.setPosition(src.x / PIXELS_PER_UNIT, -src.y / PIXELS_PER_UNIT, 0);

            bufSrc.connect(gainNode);
            gainNode.connect(panner);
            panner.connect(ctx.destination);
            bufSrc.start(0);

            _runtimeNodes.push({ bufSrc, gainNode, panner, srcRef: src });
        } catch (e) {
            console.warn('[Zengine Audio] decode error:', e);
        }
    }
}

export function stopPlayAudio() {
    for (const n of _runtimeNodes) {
        try { n.bufSrc.stop(); } catch (_) {}
    }
    _runtimeNodes = [];
}

// Called every frame during play to update listener to camera world pos
export function updateAudioListener() {
    if (!_runtimeNodes.length || !_actx || !state.sceneContainer) return;
    const sc  = state.sceneContainer;
    const sw  = state.app?.screen.width  || 0;
    const sh  = state.app?.screen.height || 0;
    // Camera world pos in pixels → convert to units (same space as panner positions)
    const camPxX =  -(sc.x - sw / 2) / sc.scale.x;
    const camPxY =  (sc.y - sh / 2)  / sc.scale.y;
    const camX   = camPxX / PIXELS_PER_UNIT;
    const camY   = camPxY / PIXELS_PER_UNIT;
    const ctx  = _actx;
    if (ctx.listener.positionX) {
        ctx.listener.positionX.setValueAtTime(camX,  ctx.currentTime);
        ctx.listener.positionY.setValueAtTime(-camY, ctx.currentTime);
        ctx.listener.positionZ.setValueAtTime(0,     ctx.currentTime);
    } else {
        ctx.listener.setPosition(camX, -camY, 0);
    }
}

async function _decodeDataURL(ctx, dataURL) {
    const res = await fetch(dataURL);
    const ab  = await res.arrayBuffer();
    return ctx.decodeAudioData(ab);
}

// ── Script-driven sound playback ─────────────────────────────
// Separate from scene audioSources — these are triggered by scripts.
let _scriptNodes = [];  // { bufSrc, gainNode, id }

export async function _playScriptSound(asset, opts = {}) {
    if (!asset?.dataURL) return;
    const ctx = _getCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch(_){} }

    // Stop existing sound with this id before replaying
    if (opts.id) _stopScriptSound(opts.id);

    try {
        const buf    = await _decodeDataURL(ctx, asset.dataURL);
        const src    = ctx.createBufferSource();
        src.buffer   = buf;
        src.loop     = opts.loop ?? false;

        const gain   = ctx.createGain();
        gain.gain.value = Math.max(0, Math.min(1, opts.volume ?? 1.0));

        if (opts.range && opts.range > 0) {
            // Positional sound
            const panner = ctx.createPanner();
            panner.panningModel  = 'HRTF';
            panner.distanceModel = 'linear';
            const rangeU = opts.range / PIXELS_PER_UNIT;
            panner.refDistance   = Math.max(0.01, rangeU * 0.1);
            panner.maxDistance   = rangeU;
            panner.rolloffFactor = 1;
            panner.setPosition(opts.x ?? 0, -(opts.y ?? 0), 0);
            src.connect(gain);
            gain.connect(panner);
            panner.connect(ctx.destination);
        } else {
            // Non-positional
            src.connect(gain);
            gain.connect(ctx.destination);
        }

        src.start(0);
        _scriptNodes.push({ bufSrc: src, gainNode: gain, id: opts.id ?? null });

        src.onended = () => {
            const idx = _scriptNodes.findIndex(n => n.bufSrc === src);
            if (idx !== -1) _scriptNodes.splice(idx, 1);
        };
    } catch (e) {
        console.warn('[Zengine Audio] script sound error:', e);
    }
}

export function _stopScriptSound(id) {
    const nodes = _scriptNodes.filter(n => n.id === id);
    for (const n of nodes) {
        try { n.bufSrc.stop(); } catch(_) {}
    }
    _scriptNodes = _scriptNodes.filter(n => n.id !== id);
}

export function _stopAllScriptSounds() {
    for (const n of _scriptNodes) {
        try { n.bufSrc.stop(); } catch(_) {}
    }
    _scriptNodes = [];
}
