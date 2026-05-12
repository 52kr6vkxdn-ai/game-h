/* ============================================================
   Zengine — engine.tilemap.js
   TILESET tilemap: paint individual tiles from a single sliced
   image asset onto a grid.

   For the auto-tiler (multi-image brush trainer) see
   engine.autotile.js — that is an entirely separate system
   with its own object type and editor UI.

   Per-tilemap data:
     obj.tilemapData = {
       tileW, tileH, cols, rows,
       assetId,                       // tileset image asset
       tilesetCols, tilesetRows,
       tiles:      Int32Array         // tile index per cell, -1 = empty
       filterMode: 'pixelated'|'smooth'   // sharp pixel art vs curves
     }
   ============================================================ */

import { state } from './engine.state.js';

// ── Create a Tilemap object ──────────────────────────────────
export function createTilemap(x = 0, y = 0) {
    const label = _uniqueName('Tilemap');

    const container = new PIXI.Container();
    container.x = x; container.y = y;
    container.isTilemap = true;
    container.isLight   = false;
    container.isImage   = false;
    container.label     = label;
    container.unityZ    = 0;
    container.animations = [];
    container.activeAnimIndex = 0;

    container.tilemapData = {
        tileW: 32, tileH: 32,
        cols: 20, rows: 15,
        assetId: null,
        tiles: new Int32Array(20 * 15).fill(-1),
        tilesetCols: 1, tilesetRows: 1,
        filterMode: 'smooth',
    };

    _buildTilemapHelper(container);
    _attachTranslateGizmo(container);
    if (state._bindGizmoHandles) state._bindGizmoHandles(container);

    state.sceneContainer.addChild(container);
    state.gameObjects.push(container);

    container.eventMode = 'static';
    container.cursor = 'pointer';
    container.on('pointerdown', e => {
        if (state.isPlaying) { e.stopPropagation(); return; }
        if (e.button !== 0) return;
        e.stopPropagation();
        import('./engine.objects.js').then(m => m.selectObject(container));
    });

    import('./engine.objects.js').then(m => m.selectObject(container));
    import('./engine.ui.js').then(m => m.refreshHierarchy());

    return container;
}

function _migrate(d) {
    if (!d.filterMode) d.filterMode = 'smooth';
}

// ── Build editor wireframe ────────────────────────────────────
export function _buildTilemapHelper(container) {
    if (container._tilemapHelper) {
        container.removeChild(container._tilemapHelper);
        try { container._tilemapHelper.destroy(); } catch(_) {}
    }
    const d = container.tilemapData;
    const g = new PIXI.Graphics();
    const W = d.cols * d.tileW;
    const H = d.rows * d.tileH;

    g.beginFill(0x1a2535, 0.6); g.drawRect(0, 0, W, H); g.endFill();
    g.lineStyle(1, 0x3A72A5, 0.25);
    for (let c = 0; c <= d.cols; c++) { g.moveTo(c * d.tileW, 0); g.lineTo(c * d.tileW, H); }
    for (let r = 0; r <= d.rows; r++) { g.moveTo(0, r * d.tileH); g.lineTo(W, r * d.tileH); }
    g.lineStyle(2, 0x3A72A5, 0.7);
    g.drawRect(0, 0, W, H);
    const text = new PIXI.Text('TILEMAP', {
        fontFamily: 'monospace', fontSize: 10, fill: 0x3A72A5, alpha: 0.5,
    });
    text.x = 4; text.y = 4;
    g.addChild(text);

    container._tilemapHelper = g;
    container.addChildAt(g, 0);
    g.eventMode = 'none';
}

// ── Rebuild tile sprites from data ───────────────────────────
export function rebuildTilemapSprites(container) {
    if (container._tileContainer) {
        container.removeChild(container._tileContainer);
        try { container._tileContainer.destroy({ children: true }); } catch(_) {}
    }

    const d = container.tilemapData;
    _migrate(d);
    if (!d.assetId) return;

    const asset = state.assets.find(a => a.id === d.assetId);
    if (!asset) return;

    const baseTex = PIXI.Texture.from(asset.dataURL);
    if (!baseTex.valid) { baseTex.on('loaded', () => rebuildTilemapSprites(container)); return; }
    if (baseTex.baseTexture) {
        baseTex.baseTexture.scaleMode = (d.filterMode === 'pixelated')
            ? PIXI.SCALE_MODES.NEAREST : PIXI.SCALE_MODES.LINEAR;
    }

    const tw = d.tileW, th = d.tileH;
    const tileContainer = new PIXI.Container();

    for (let i = 0; i < d.tiles.length; i++) {
        const tileIdx = d.tiles[i];
        if (tileIdx < 0) continue;

        const col = i % d.cols;
        const row = Math.floor(i / d.cols);
        const tsc = tileIdx % d.tilesetCols;
        const tsr = Math.floor(tileIdx / d.tilesetCols);

        const frame = new PIXI.Rectangle(tsc * tw, tsr * th, tw, th);
        const tex   = new PIXI.Texture(baseTex.baseTexture, frame);
        const sp    = new PIXI.Sprite(tex);
        sp.x = col * tw;
        sp.y = row * th;
        tileContainer.addChild(sp);
    }

    container._tileContainer = tileContainer;
    const gizmoIdx = container.children.indexOf(container._gizmoContainer);
    if (gizmoIdx >= 0) container.addChildAt(tileContainer, gizmoIdx);
    else container.addChild(tileContainer);
}

// ── Open the tilemap editor panel ────────────────────────────
export function openTilemapEditor(obj) {
    document.getElementById('tm-editor')?.remove();
    _migrate(obj.tilemapData);

    const panel = document.createElement('div');
    panel.id = 'tm-editor';
    panel.style.cssText = `
        position:fixed;inset:0;z-index:15000;background:rgba(0,0,0,0.92);
        display:flex;font-family:'Inter','Segoe UI',sans-serif;font-size:11px;color:#d8d8e8;
    `;

    const d = obj.tilemapData;

    panel.innerHTML = `
    <div style="display:flex;width:100%;height:100%;">

      <!-- Left: Tileset + tools -->
      <div style="width:260px;flex-shrink:0;background:#1a1a24;border-right:1px solid #2e2e3a;
                  display:flex;flex-direction:column;overflow:hidden;">
        <div style="padding:12px 14px;border-bottom:1px solid #2e2e3a;display:flex;align-items:center;gap:8px;flex-shrink:0;">
          <svg viewBox="0 0 24 24" style="width:16px;height:16px;fill:none;stroke:#3A72A5;stroke-width:2;">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/>
            <line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>
          </svg>
          <span style="font-weight:700;color:#fff;">Tilemap Editor</span>
          <div style="flex:1;"></div>
          <button id="tm-close" style="background:none;border:none;color:#666;cursor:pointer;font-size:16px;padding:2px 5px;">✕</button>
        </div>

        <div style="padding:10px 14px;border-bottom:1px solid #2e2e3a;flex-shrink:0;">
          <div style="font-size:9px;font-weight:700;color:#505060;letter-spacing:.8px;margin-bottom:8px;">MAP SETTINGS</div>
          <div class="tm-row"><span class="tm-lbl">Columns</span><input type="number" id="tm-cols" value="${d.cols}" min="1" max="512" class="tm-inp"></div>
          <div class="tm-row"><span class="tm-lbl">Rows</span><input type="number" id="tm-rows" value="${d.rows}" min="1" max="512" class="tm-inp"></div>
          <div class="tm-row"><span class="tm-lbl">Tile W</span><input type="number" id="tm-tw" value="${d.tileW}" min="4" max="512" class="tm-inp"></div>
          <div class="tm-row"><span class="tm-lbl">Tile H</span><input type="number" id="tm-th" value="${d.tileH}" min="4" max="512" class="tm-inp"></div>
          <div class="tm-row"><span class="tm-lbl">Render</span>
            <select id="tm-filter" class="tm-inp" style="width:auto;">
              <option value="smooth"    ${d.filterMode==='smooth'?'selected':''}>Smooth (curves)</option>
              <option value="pixelated" ${d.filterMode==='pixelated'?'selected':''}>Pixelated</option>
            </select>
          </div>
          <button id="tm-apply-settings" style="width:100%;margin-top:6px;background:#1e3050;border:1px solid #3A72A5;
                  color:#7aabcc;border-radius:4px;padding:5px;cursor:pointer;font-size:10px;">Apply</button>
        </div>

        <div style="padding:10px 14px;border-bottom:1px solid #2e2e3a;flex-shrink:0;">
          <div style="font-size:9px;font-weight:700;color:#505060;letter-spacing:.8px;margin-bottom:8px;">TILESET</div>
          <select id="tm-tileset-select" style="width:100%;background:#16161e;border:1px solid #3a3a48;
                  color:#d8d8e8;border-radius:4px;padding:5px;font-size:10px;outline:none;">
            <option value="">— None —</option>
          </select>
        </div>

        <div style="padding:10px 14px;border-bottom:1px solid #2e2e3a;flex-shrink:0;">
          <div style="font-size:9px;font-weight:700;color:#505060;letter-spacing:.8px;margin-bottom:8px;">TOOLS</div>
          <div style="display:flex;gap:4px;">
            <button class="tm-tool-btn tm-tool-active" data-tool="paint" title="Paint (B)">
              <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/></svg>
            </button>
            <button class="tm-tool-btn" data-tool="erase" title="Erase (E)">
              <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;"><path d="M20 20H7L3 16l10-10 7 7-1.5 1.5"/></svg>
            </button>
            <button class="tm-tool-btn" data-tool="fill" title="Fill (F)">
              <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;"><path d="M16 6l2 2-8 8-4-4 8-8z"/><path d="M2 22l4-4"/><circle cx="20" cy="20" r="2"/></svg>
            </button>
            <button class="tm-tool-btn" data-tool="pick" title="Pick tile (I)">
              <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
            </button>
          </div>
        </div>

        <div style="flex:1;overflow:hidden;display:flex;flex-direction:column;padding:10px 14px;">
          <div style="font-size:9px;font-weight:700;color:#505060;letter-spacing:.8px;margin-bottom:6px;">SELECT TILE <span id="tm-sel-tile-info" style="color:#7aabcc;font-weight:400;"></span></div>
          <div style="flex:1;overflow:auto;background:#0e0e18;border-radius:4px;position:relative;">
            <canvas id="tm-tileset-canvas" style="display:block;cursor:crosshair;"></canvas>
            <canvas id="tm-tileset-overlay" style="position:absolute;inset:0;pointer-events:none;"></canvas>
          </div>
        </div>
      </div>

      <div style="flex:1;display:flex;flex-direction:column;overflow:hidden;background:#0e0e18;">
        <div style="padding:8px 14px;border-bottom:1px solid #1e1e2e;font-size:10px;color:#505060;
                    flex-shrink:0;display:flex;align-items:center;gap:10px;">
          <span id="tm-cursor-info" style="color:#7a7a90;">Hover over map to paint</span>
          <span style="margin-left:auto;color:#3a3a48;">B=Paint  E=Erase  F=Fill  I=Pick  Ctrl+Z=Undo</span>
        </div>
        <div id="tm-canvas-wrap" style="flex:1;overflow:auto;padding:20px;display:flex;align-items:flex-start;justify-content:flex-start;">
          <div style="position:relative;display:inline-block;flex-shrink:0;">
            <canvas id="tm-map-canvas" style="display:block;cursor:crosshair;"></canvas>
            <canvas id="tm-map-overlay" style="position:absolute;inset:0;pointer-events:none;"></canvas>
          </div>
        </div>
      </div>
    </div>

    <style>
      .tm-row { display:flex;align-items:center;justify-content:space-between;margin-bottom:5px; }
      .tm-lbl { color:#7a7a90;font-size:10px; }
      .tm-inp { width:65px;background:#16161e;border:1px solid #3a3a48;color:#d8d8e8;
                border-radius:3px;padding:3px 5px;font-size:10px;outline:none;text-align:right; }
      .tm-inp:focus { border-color:#3A72A5; }
      .tm-tool-btn { background:#16161e;border:1px solid #2e2e3a;color:#606070;border-radius:4px;
                     padding:6px;cursor:pointer;display:flex;align-items:center;justify-content:center;
                     transition:all .1s; }
      .tm-tool-btn:hover { border-color:#3A72A5;color:#9bc; }
      .tm-tool-active { border-color:#3A72A5 !important;background:#1e3050 !important;color:#7aabcc !important; }
    </style>
    `;

    document.body.appendChild(panel);
    _wireTilemapEditor(panel, obj);
}

function _wireTilemapEditor(panel, obj) {
    const d = obj.tilemapData;
    let tool = 'paint';
    let selectedTile = 0;
    let isPainting = false;
    let tilesetImg = null;
    const undoStack = [];

    const mapCanvas   = panel.querySelector('#tm-map-canvas');
    const mapOverlay  = panel.querySelector('#tm-map-overlay');
    const tsCanvas    = panel.querySelector('#tm-tileset-canvas');
    const tsOverlay   = panel.querySelector('#tm-tileset-overlay');
    const mctx = mapCanvas.getContext('2d');
    const moctx = mapOverlay.getContext('2d');
    const tsctx = tsCanvas.getContext('2d');
    const tsoctx = tsOverlay.getContext('2d');

    function _applySmoothness() {
        const sharp = d.filterMode === 'pixelated';
        for (const cv of [mapCanvas, mapOverlay, tsCanvas, tsOverlay]) {
            cv.style.imageRendering = sharp ? 'pixelated' : 'auto';
        }
        for (const cx of [mctx, moctx, tsctx, tsoctx]) {
            cx.imageSmoothingEnabled = !sharp;
            cx.imageSmoothingQuality = 'high';
        }
    }

    panel.querySelector('#tm-close').addEventListener('click', () => {
        rebuildTilemapSprites(obj);
        _buildTilemapHelper(obj);
        import('./engine.ui.js').then(m => { m.syncPixiToInspector(); m.refreshHierarchy(); });
        panel.remove();
        window.removeEventListener('keydown', _onKey);
    });

    const sel = panel.querySelector('#tm-tileset-select');
    state.assets.filter(a => a.type !== 'audio').forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = a.name;
        if (a.id === d.assetId) opt.selected = true;
        sel.appendChild(opt);
    });
    sel.addEventListener('change', () => {
        d.assetId = sel.value || null;
        _loadTileset();
    });

    function _loadTileset() {
        if (!d.assetId) { tilesetImg = null; _drawTileset(); return; }
        const asset = state.assets.find(a => a.id === d.assetId);
        if (!asset) return;
        const img = new Image();
        img.onload = () => {
            tilesetImg = img;
            d.tilesetCols = Math.max(1, Math.floor(img.width  / d.tileW));
            d.tilesetRows = Math.max(1, Math.floor(img.height / d.tileH));
            _drawTileset();
            _drawMap();
        };
        img.src = asset.dataURL;
    }

    function _drawTileset() {
        if (!tilesetImg) {
            tsCanvas.width = 200; tsCanvas.height = 60;
            tsctx.fillStyle = '#0e0e18'; tsctx.fillRect(0,0,200,60);
            tsctx.fillStyle = '#505060'; tsctx.font = '11px monospace';
            tsctx.fillText('No tileset selected', 10, 36);
            tsOverlay.width = tsCanvas.width; tsOverlay.height = tsCanvas.height;
            return;
        }
        tsCanvas.width  = tilesetImg.width;
        tsCanvas.height = tilesetImg.height;
        tsOverlay.width = tilesetImg.width; tsOverlay.height = tilesetImg.height;
        _applySmoothness();
        tsctx.drawImage(tilesetImg, 0, 0);
        tsctx.strokeStyle = 'rgba(58,114,165,0.4)'; tsctx.lineWidth = 0.5;
        tsctx.beginPath();
        for (let c = 0; c <= d.tilesetCols; c++) {
            tsctx.moveTo(c * d.tileW, 0); tsctx.lineTo(c * d.tileW, tilesetImg.height);
        }
        for (let r = 0; r <= d.tilesetRows; r++) {
            tsctx.moveTo(0, r * d.tileH); tsctx.lineTo(tilesetImg.width, r * d.tileH);
        }
        tsctx.stroke();
        _drawTilesetSelection();
    }

    function _drawTilesetSelection() {
        tsoctx.clearRect(0, 0, tsCanvas.width, tsCanvas.height);
        const sc = selectedTile % d.tilesetCols;
        const sr = Math.floor(selectedTile / d.tilesetCols);
        tsoctx.strokeStyle = '#facc15'; tsoctx.lineWidth = 2;
        tsoctx.strokeRect(sc * d.tileW + 1, sr * d.tileH + 1, d.tileW - 2, d.tileH - 2);
        panel.querySelector('#tm-sel-tile-info').textContent = `#${selectedTile}`;
    }

    tsCanvas.addEventListener('mousedown', e => {
        const rect = tsCanvas.getBoundingClientRect();
        const mx = (e.clientX - rect.left) * (tsCanvas.width  / rect.width);
        const my = (e.clientY - rect.top)  * (tsCanvas.height / rect.height);
        const c = Math.floor(mx / d.tileW);
        const r = Math.floor(my / d.tileH);
        if (c >= 0 && c < d.tilesetCols && r >= 0 && r < d.tilesetRows) {
            selectedTile = r * d.tilesetCols + c;
            _drawTilesetSelection();
            if (tool === 'pick') setTool('paint');
        }
    });

    function _initMapCanvas() {
        mapCanvas.width  = d.cols * d.tileW;
        mapCanvas.height = d.rows * d.tileH;
        mapOverlay.width  = mapCanvas.width;
        mapOverlay.height = mapCanvas.height;
        _applySmoothness();
    }

    function _drawMap() {
        _applySmoothness();
        mctx.fillStyle = '#1a2535';
        mctx.fillRect(0, 0, mapCanvas.width, mapCanvas.height);
        if (tilesetImg) {
            for (let i = 0; i < d.tiles.length; i++) {
                const tIdx = d.tiles[i];
                if (tIdx < 0) continue;
                const col = i % d.cols, row = Math.floor(i / d.cols);
                const tsc = tIdx % d.tilesetCols, tsr = Math.floor(tIdx / d.tilesetCols);
                mctx.drawImage(tilesetImg,
                    tsc * d.tileW, tsr * d.tileH, d.tileW, d.tileH,
                    col * d.tileW, row * d.tileH, d.tileW, d.tileH);
            }
        }
        mctx.strokeStyle = 'rgba(58,114,165,0.18)'; mctx.lineWidth = 0.5;
        mctx.beginPath();
        for (let c = 0; c <= d.cols; c++) { mctx.moveTo(c * d.tileW, 0); mctx.lineTo(c * d.tileW, mapCanvas.height); }
        for (let r = 0; r <= d.rows; r++) { mctx.moveTo(0, r * d.tileH); mctx.lineTo(mapCanvas.width, r * d.tileH); }
        mctx.stroke();
        mctx.strokeStyle = 'rgba(58,114,165,0.6)'; mctx.lineWidth = 2;
        mctx.strokeRect(0, 0, mapCanvas.width, mapCanvas.height);
    }

    function _getCell(e) {
        const rect = mapCanvas.getBoundingClientRect();
        const mx = (e.clientX - rect.left) * (mapCanvas.width  / rect.width);
        const my = (e.clientY - rect.top)  * (mapCanvas.height / rect.height);
        return { c: Math.floor(mx / d.tileW), r: Math.floor(my / d.tileH) };
    }
    function _validCell(c, r) { return c >= 0 && c < d.cols && r >= 0 && r < d.rows; }

    function _paintCell(c, r) {
        if (!_validCell(c, r)) return;
        const i = r * d.cols + c;
        if (tool === 'paint') {
            if (d.tiles[i] === selectedTile) return;
            d.tiles[i] = selectedTile;
        } else if (tool === 'erase') {
            if (d.tiles[i] === -1) return;
            d.tiles[i] = -1;
        }
        _drawMap();
    }

    function _fill(c, r) {
        if (!_validCell(c, r)) return;
        const target = d.tiles[r * d.cols + c];
        const replace = tool === 'erase' ? -1 : selectedTile;
        if (target === replace) return;
        const queue = [[c, r]];
        const visited = new Uint8Array(d.cols * d.rows);
        while (queue.length) {
            const [cc, cr] = queue.shift();
            if (!_validCell(cc, cr)) continue;
            const idx = cr * d.cols + cc;
            if (visited[idx] || d.tiles[idx] !== target) continue;
            visited[idx] = 1;
            d.tiles[idx] = replace;
            queue.push([cc-1,cr],[cc+1,cr],[cc,cr-1],[cc,cr+1]);
        }
        _drawMap();
    }

    function _pushUndo() {
        undoStack.push(new Int32Array(d.tiles));
        if (undoStack.length > 30) undoStack.shift();
    }
    function _undo() {
        if (!undoStack.length) return;
        d.tiles = undoStack.pop();
        _drawMap();
    }

    mapCanvas.addEventListener('mousedown', e => {
        const { c, r } = _getCell(e);
        if (!_validCell(c, r)) return;
        _pushUndo();
        if (tool === 'fill') { _fill(c, r); return; }
        if (tool === 'pick') {
            const idx = r * d.cols + c;
            if (d.tiles[idx] >= 0) { selectedTile = d.tiles[idx]; _drawTilesetSelection(); }
            setTool('paint'); return;
        }
        isPainting = true;
        _paintCell(c, r);
    });
    window.addEventListener('mouseup', () => { isPainting = false; });
    mapCanvas.addEventListener('mousemove', e => {
        const { c, r } = _getCell(e);
        panel.querySelector('#tm-cursor-info').textContent =
            _validCell(c, r) ? `Col ${c+1}, Row ${r+1}  (tile ${d.tiles[r*d.cols+c]})` : '';
        moctx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
        if (_validCell(c, r)) {
            if (tool === 'paint' && tilesetImg) {
                const tsc = selectedTile % d.tilesetCols, tsr = Math.floor(selectedTile / d.tilesetCols);
                moctx.globalAlpha = 0.55;
                moctx.drawImage(tilesetImg,
                    tsc*d.tileW, tsr*d.tileH, d.tileW, d.tileH,
                    c*d.tileW, r*d.tileH, d.tileW, d.tileH);
                moctx.globalAlpha = 1;
            }
            moctx.strokeStyle = '#facc15'; moctx.lineWidth = 2;
            moctx.strokeRect(c*d.tileW+1, r*d.tileH+1, d.tileW-2, d.tileH-2);
        }
        if (isPainting && (tool === 'paint' || tool === 'erase')) _paintCell(c, r);
    });
    mapCanvas.addEventListener('mouseleave', () => {
        moctx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
        panel.querySelector('#tm-cursor-info').textContent = '';
    });

    function setTool(t) {
        tool = t;
        panel.querySelectorAll('.tm-tool-btn').forEach(b => {
            b.classList.toggle('tm-tool-active', b.dataset.tool === t);
        });
    }
    panel.querySelectorAll('.tm-tool-btn').forEach(b => {
        b.addEventListener('click', () => setTool(b.dataset.tool));
    });

    const _onKey = e => {
        if (e.target.tagName === 'INPUT') return;
        if (e.key === 'b' || e.key === 'B') setTool('paint');
        if (e.key === 'e' || e.key === 'E') setTool('erase');
        if (e.key === 'f' || e.key === 'F') setTool('fill');
        if (e.key === 'i' || e.key === 'I') setTool('pick');
        if ((e.ctrlKey||e.metaKey) && e.key === 'z') { e.preventDefault(); _undo(); }
    };
    window.addEventListener('keydown', _onKey);

    panel.querySelector('#tm-apply-settings').addEventListener('click', () => {
        const nc = Math.max(1, parseInt(panel.querySelector('#tm-cols').value)||20);
        const nr = Math.max(1, parseInt(panel.querySelector('#tm-rows').value)||15);
        const tw = Math.max(4, parseInt(panel.querySelector('#tm-tw').value)||32);
        const th = Math.max(4, parseInt(panel.querySelector('#tm-th').value)||32);
        const fm = panel.querySelector('#tm-filter').value;
        const newTiles = new Int32Array(nc * nr).fill(-1);
        for (let r = 0; r < Math.min(nr, d.rows); r++) {
            for (let c = 0; c < Math.min(nc, d.cols); c++) {
                newTiles[r * nc + c] = d.tiles[r * d.cols + c];
            }
        }
        d.cols = nc; d.rows = nr; d.tileW = tw; d.tileH = th; d.tiles = newTiles;
        d.filterMode = fm;
        if (tilesetImg) {
            d.tilesetCols = Math.max(1, Math.floor(tilesetImg.width  / tw));
            d.tilesetRows = Math.max(1, Math.floor(tilesetImg.height / th));
        }
        _initMapCanvas();
        _drawTileset();
        _drawMap();
    });

    _initMapCanvas();
    _drawMap();
    if (d.assetId) _loadTileset();
}

// ── Inspector HTML for tilemap ───────────────────────────────
export function buildTilemapInspectorHTML(obj) {
    const d = obj.tilemapData; _migrate(d);
    const asset = d.assetId ? state.assets.find(a => a.id === d.assetId) : null;
    return `
    <div class="component-block" id="inspector-tilemap-section">
      <div class="component-header">
        <svg viewBox="0 0 24 24" class="comp-icon" style="color:#4ade80;">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/>
          <line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>
        </svg>
        <span style="font-weight:600;color:#4ade80;">Tilemap</span>
      </div>
      <div class="component-body" style="display:flex;flex-direction:column;gap:5px;">
        <div class="prop-row"><span class="prop-label">Size</span><span style="color:#9bc;">${d.cols} × ${d.rows} tiles</span></div>
        <div class="prop-row"><span class="prop-label">Tile size</span><span style="color:#9bc;">${d.tileW} × ${d.tileH} px</span></div>
        <div class="prop-row"><span class="prop-label">Render</span><span style="color:#9bc;">${d.filterMode}</span></div>
        <div class="prop-row"><span class="prop-label">Tileset</span><span style="color:#9bc;font-size:10px;overflow:hidden;text-overflow:ellipsis;">${asset ? asset.name : '— none —'}</span></div>
        <button id="btn-open-tilemap-editor" style="width:100%;background:#1a2a1a;border:1px solid #4ade80;color:#4ade80;
                border-radius:4px;padding:6px;cursor:pointer;font-size:11px;margin-top:4px;
                display:flex;align-items:center;justify-content:center;gap:6px;">
          <svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2;">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          Open Tilemap Editor
        </button>
      </div>
    </div>`;
}

// ── Snapshot / restore ───────────────────────────────────────
export function snapshotTilemap(obj) {
    return {
        isTilemap: true,
        label: obj.label, x: obj.x, y: obj.y, unityZ: obj.unityZ || 0,
        tilemapData: { ...obj.tilemapData, tiles: Array.from(obj.tilemapData.tiles) },
    };
}

export async function restoreTilemap(s) {
    const obj = createTilemap(s.x, s.y);
    obj.label = s.label; obj.unityZ = s.unityZ || 0;
    obj.tilemapData = { ...s.tilemapData, tiles: new Int32Array(s.tilemapData.tiles) };
    _migrate(obj.tilemapData);
    _buildTilemapHelper(obj);
    rebuildTilemapSprites(obj);
    return obj;
}

// ── Helpers ──────────────────────────────────────────────────
function _uniqueName(base) {
    const existing = new Set(state.gameObjects.map(o => o.label));
    if (!existing.has(base)) return base;
    let i = 2; while (existing.has(`${base} (${i})`)) i++;
    return `${base} (${i})`;
}

function _attachTranslateGizmo(container) {
    const gizmoContainer = new PIXI.Container();
    container.addChild(gizmoContainer);
    container._gizmoContainer = gizmoContainer;
    const g1 = _makeAxisLine(0xFF4F4B, 50, false);
    const g2 = _makeAxisLine(0x8FC93A, 50, true);
    const g3 = _makeSquare();
    const grpT = new PIXI.Container(); grpT.addChild(g1, g2, g3);
    const grpR = new PIXI.Container(); grpR.visible = false;
    const grpS = new PIXI.Container(); grpS.visible = false;
    container._grpTranslate = grpT; container._grpRotate = grpR; container._grpScale = grpS;
    gizmoContainer.addChild(grpT, grpR, grpS);
    container._gizmoHandles = { transX:g1, transY:g2, transCenter:g3, scaleX:g1, scaleY:g2, scaleCenter:g3, rotRing:g3 };
    [g1, g2, g3].forEach(h => h.on('pointerdown', e => e.stopPropagation()));
}
function _makeAxisLine(color, len, isY) {
    const g = new PIXI.Graphics();
    g.beginFill(color); g.lineStyle(2, color);
    if (isY) g.drawRect(-1,-len,2,len); else g.drawRect(0,-1,len,2);
    g.lineStyle(0);
    if (isY) { g.moveTo(-5,-len); g.lineTo(0,-len-9); g.lineTo(5,-len); }
    else     { g.moveTo(len,-5);  g.lineTo(len+9,0);   g.lineTo(len,5); }
    g.endFill(); g.eventMode='static'; return g;
}
function _makeSquare() {
    const g = new PIXI.Graphics();
    g.beginFill(0xFFFFFF, 0.4); g.drawRect(-7,-7,14,14); g.endFill();
    g.eventMode='static'; g.cursor='move'; return g;
}
