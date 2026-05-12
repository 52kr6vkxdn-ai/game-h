/* ============================================================
   Zengine — engine.autotile.js  v4
   Auto-tile brush system: 16-tile (4×4 blob) neighbor-aware
   tilemap painter with true LAYERED multi-brush painting.

   Cell data model:
     autoTileData.cells  = Array of length (cols*rows)
     Each element is either:
       - null / undefined / 0  → empty
       - Array of brushIds     → one entry per brush layer painted here
     Layers are rendered bottom-to-top so later layers appear on top.

   Exported surface:
     createAutoTilemap(x?, y?)       → PIXI.Container
     restoreAutoTilemap(snapshot)    → Promise<PIXI.Container>
     buildAutoTileInspectorHTML(obj) → string
     openAutoTileEditor(obj)         → void
     rebuildAutoTileSprites(obj)     → void
   ============================================================ */

import { state } from './engine.state.js';

// ── Constants ─────────────────────────────────────────────────
const TILE_SIZE    = 40;
const DEFAULT_COLS = 20;
const DEFAULT_ROWS = 15;

// 4-neighbor bitmask → slot index (0-15). Bits: N=1 E=2 S=4 W=8
const BITMASK_TO_SLOT = {
     0: 15,  1: 11,  2: 12,  3:  6,
     4:  9,  5: 10,  6:  0,  7:  3,
     8: 14,  9:  8, 10: 13, 11:  7,
    12:  2, 13:  5, 14:  1, 15:  4,
};

// Visual layout for the 16-slot grid panel (4 rows × 4 cols)
const SLOT_LAYOUT = [
    [0,  1,  2,  9],
    [3,  4,  5, 10],
    [6,  7,  8, 11],
    [12, 13, 14, 15],
];

// 4×4 sheet (left-to-right, top-to-bottom) index → slot id
const SHEET_TO_SLOT = [0, 1, 2, 9, 3, 4, 5, 10, 6, 7, 8, 11, 12, 13, 14, 15];

// ─────────────────────────────────────────────────────────────
// Brush registry  (state.tilesetBrushes)
// ─────────────────────────────────────────────────────────────

function _ensureBrushRegistry() {
    if (!Array.isArray(state.tilesetBrushes)) state.tilesetBrushes = [];
}

function _newBrush(name = 'New Brush') {
    _ensureBrushRegistry();
    const id    = 'brush_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const brush = { id, name, tiles: new Array(16).fill(null) };
    state.tilesetBrushes.push(brush);
    return brush;
}

function _getBrush(id) {
    _ensureBrushRegistry();
    return state.tilesetBrushes.find(b => b.id === id) || null;
}

// ─────────────────────────────────────────────────────────────
// Cell helpers — layered Array format
// ─────────────────────────────────────────────────────────────

/** Return the layers array for a cell, or [] if empty. */
function _getLayers(cells, idx) {
    const v = cells[idx];
    if (!v || !Array.isArray(v) || v.length === 0) return [];
    return v;
}

/** True if the cell has ANY brush painted on it. */
function _cellFilled(cells, idx) {
    return _getLayers(cells, idx).length > 0;
}

/** Add brushId to a cell's layer list (no duplicates). Returns true if changed. */
function _addLayer(cells, idx, brushId) {
    if (!Array.isArray(cells[idx])) cells[idx] = [];
    if (!cells[idx].includes(brushId)) { cells[idx].push(brushId); return true; }
    return false;
}

/** Remove brushId from a cell (or clear all layers if brushId is null). Returns true if changed. */
function _removeLayer(cells, idx, brushId) {
    if (!Array.isArray(cells[idx])) return false;
    if (brushId === null) { const had = cells[idx].length > 0; cells[idx] = []; return had; }
    const i = cells[idx].indexOf(brushId);
    if (i < 0) return false;
    cells[idx].splice(i, 1);
    return true;
}

/** Serialise cell array for snapshot (JSON-safe). */
function _serializeCells(cells) {
    return cells.map(v => (Array.isArray(v) && v.length > 0) ? v.slice() : null);
}

/** Deserialise cells from snapshot back to Array format. */
function _deserializeCells(raw, size) {
    const cells = new Array(size).fill(null);
    if (!Array.isArray(raw)) return cells;
    raw.forEach((v, i) => {
        if (i >= size) return;
        if (Array.isArray(v) && v.length > 0) cells[i] = v.slice();
        // legacy Uint8Array / number support → treat 1 as [LEGACY]
        else if (v === 1) cells[i] = ['__legacy__'];
    });
    return cells;
}

// ─────────────────────────────────────────────────────────────
// Internal PIXI helpers
// ─────────────────────────────────────────────────────────────

function _uniqueName(base) {
    const existing = new Set(state.gameObjects.map(o => o.label));
    if (!existing.has(base)) return base;
    let i = 2;
    while (existing.has(`${base} (${i})`)) i++;
    return `${base} (${i})`;
}

function _attachTranslateGizmo(container) {
    const gc = new PIXI.Container();
    container.addChild(gc);
    container._gizmoContainer = gc;

    const g1 = _makeAxisLine(0xFF4F4B, 50, false);
    const g2 = _makeAxisLine(0x8FC93A, 50, true);
    const g3 = _makeSquare();

    const grpT = new PIXI.Container(); grpT.addChild(g1, g2, g3);
    const grpR = new PIXI.Container(); grpR.visible = false;
    const grpS = new PIXI.Container(); grpS.visible = false;

    container._grpTranslate = grpT;
    container._grpRotate    = grpR;
    container._grpScale     = grpS;
    gc.addChild(grpT, grpR, grpS);

    container._gizmoHandles = {
        transX: g1, transY: g2, transCenter: g3,
        scaleX: g1, scaleY: g2, scaleCenter: g3,
        rotRing: g3,
    };
    [g1, g2, g3].forEach(h => h.on('pointerdown', e => e.stopPropagation()));
}

function _makeAxisLine(color, len, isY) {
    const g = new PIXI.Graphics();
    g.beginFill(color); g.lineStyle(2, color);
    if (isY) g.drawRect(-1, -len, 2, len); else g.drawRect(0, -1, len, 2);
    g.lineStyle(0);
    if (isY) { g.moveTo(-5, -len); g.lineTo(0, -len - 9); g.lineTo(5, -len); }
    else     { g.moveTo(len,  -5); g.lineTo(len + 9, 0);  g.lineTo(len,  5); }
    g.endFill(); g.eventMode = 'static'; return g;
}

function _makeSquare() {
    const g = new PIXI.Graphics();
    g.beginFill(0xFFFFFF, 0.4); g.drawRect(-7, -7, 14, 14); g.endFill();
    g.eventMode = 'static'; g.cursor = 'move'; return g;
}

// ─────────────────────────────────────────────────────────────
// Wireframe helper (editor only — hidden during play)
// ─────────────────────────────────────────────────────────────

function _buildAutoTileHelper(container) {
    if (container._autoTileHelper) {
        container.removeChild(container._autoTileHelper);
        try { container._autoTileHelper.destroy(); } catch (_) {}
    }

    const d = container.autoTileData;
    const W = d.cols * d.tileW, H = d.rows * d.tileH;

    const g = new PIXI.Graphics();
    g.lineStyle(1, 0x4ade80, 0.7); g.drawRect(0, 0, W, H);
    g.lineStyle(0.5, 0x4ade80, 0.15);
    for (let x = 1; x < d.cols; x++) { g.moveTo(x*d.tileW, 0); g.lineTo(x*d.tileW, H); }
    for (let y = 1; y < d.rows; y++) { g.moveTo(0, y*d.tileH); g.lineTo(W, y*d.tileH); }

    const lbl = new PIXI.Text(`Auto-Tile  ${d.cols}×${d.rows}`, { fontSize: 11, fill: 0x4ade80, fontFamily: 'sans-serif' });
    lbl.alpha = 0.65; lbl.x = 4; lbl.y = 2;

    const helper = new PIXI.Container();
    helper.addChild(g, lbl);
    helper.isHelper = true;
    container._autoTileHelper = helper;
    container.addChildAt(helper, 0);
}

// ─────────────────────────────────────────────────────────────
// Bitmask  (uses filled-check only — any layer = filled)
// ─────────────────────────────────────────────────────────────

function _calcBitmask(cells, cols, rows, col, row) {
    let m = 0;
    if (row > 0       && _cellFilled(cells, (row-1)*cols+col))   m += 1; // N
    if (col < cols-1  && _cellFilled(cells, row*cols+(col+1)))   m += 2; // E
    if (row < rows-1  && _cellFilled(cells, (row+1)*cols+col))   m += 4; // S
    if (col > 0       && _cellFilled(cells, row*cols+(col-1)))   m += 8; // W
    return m;
}

// ─────────────────────────────────────────────────────────────
// Sprite layer rebuild
// ─────────────────────────────────────────────────────────────

export function rebuildAutoTileSprites(container) {
    if (container._spriteLayer) {
        container.removeChild(container._spriteLayer);
        try { container._spriteLayer.destroy({ children: true }); } catch (_) {}
    }

    const layer = new PIXI.Container();
    container._spriteLayer = layer;
    container.addChildAt(layer, container._autoTileHelper ? 1 : 0);

    const d     = container.autoTileData;
    const cells = d.cells;

    for (let row = 0; row < d.rows; row++) {
        for (let col = 0; col < d.cols; col++) {
            const layers = _getLayers(cells, row * d.cols + col);
            if (!layers.length) continue;

            const mask   = _calcBitmask(cells, d.cols, d.rows, col, row);
            const slotId = BITMASK_TO_SLOT[mask] ?? 15;

            // Render each layer bottom-to-top
            for (const brushId of layers) {
                const brush   = (brushId === '__legacy__') ? null : _getBrush(brushId);
                const tiles   = brush ? brush.tiles : (d.brushList || []);
                const dataURL = tiles[slotId];
                if (!dataURL) continue;

                const tex = PIXI.Texture.from(dataURL);
                const spr = new PIXI.Sprite(tex);
                spr.x = col * d.tileW; spr.y = row * d.tileH;
                spr.width = d.tileW;   spr.height = d.tileH;
                layer.addChild(spr);
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────
// Public: create
// ─────────────────────────────────────────────────────────────

export function createAutoTilemap(x = 0, y = 0) {
    _ensureBrushRegistry();
    const label = _uniqueName('Auto-Tile');

    const container = new PIXI.Container();
    container.x = x; container.y = y;

    container.isAutoTilemap   = true;
    container.isTilemap       = false;
    container.isLight         = false;
    container.isImage         = false;
    container.label           = label;
    container.unityZ          = 0;
    container.animations      = [];
    container.activeAnimIndex = 0;

    container.autoTileData = {
        tileW:          TILE_SIZE,
        tileH:          TILE_SIZE,
        cols:           DEFAULT_COLS,
        rows:           DEFAULT_ROWS,
        brushList:      new Array(16).fill(null),  // legacy / inline fallback
        activeBrushIds: [],
        cells:          new Array(DEFAULT_COLS * DEFAULT_ROWS).fill(null),
    };

    _buildAutoTileHelper(container);
    _attachTranslateGizmo(container);
    if (state._bindGizmoHandles) state._bindGizmoHandles(container);

    state.sceneContainer.addChild(container);
    state.gameObjects.push(container);

    container.eventMode = 'static';
    container.cursor    = 'pointer';
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

// ─────────────────────────────────────────────────────────────
// Public: restore from snapshot
// ─────────────────────────────────────────────────────────────

export async function restoreAutoTilemap(s) {
    _ensureBrushRegistry();
    const obj  = createAutoTilemap(s.x, s.y);
    obj.label  = s.label;
    obj.unityZ = s.unityZ || 0;

    const td   = s.autoTileData;
    const cols = td.cols ?? DEFAULT_COLS;
    const rows = td.rows ?? DEFAULT_ROWS;

    obj.autoTileData = {
        tileW:          td.tileW          ?? TILE_SIZE,
        tileH:          td.tileH          ?? TILE_SIZE,
        cols,
        rows,
        brushList:      td.brushList      ? td.brushList.slice() : new Array(16).fill(null),
        activeBrushIds: td.activeBrushIds ? td.activeBrushIds.slice() : [],
        cells:          _deserializeCells(td.cells, cols * rows),
    };

    _buildAutoTileHelper(obj);
    rebuildAutoTileSprites(obj);
    return obj;
}

// ─────────────────────────────────────────────────────────────
// Public: inspector HTML
// ─────────────────────────────────────────────────────────────

export function buildAutoTileInspectorHTML(obj) {
    _ensureBrushRegistry();
    const d         = obj.autoTileData;
    const cells     = d.cells || [];
    const filled    = cells.filter(c => _cellFilled(cells, cells.indexOf(c))).length;
    // Recount properly
    let filledCount = 0;
    for (let i = 0; i < cells.length; i++) if (_cellFilled(cells, i)) filledCount++;

    const activeIds   = d.activeBrushIds || [];
    const brushSummary = activeIds.length
        ? activeIds.map(id => _getBrush(id)?.name || id).join(', ')
        : 'none active';

    return `
    <div class="component-block" id="inspector-autotile-section">
      <div class="component-header">
        <svg viewBox="0 0 24 24" class="comp-icon" style="color:#4ade80;fill:none;stroke:currentColor;stroke-width:2;">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>
          <circle cx="12" cy="12" r="2" fill="#4ade80" stroke="none"/>
        </svg>
        <span style="font-weight:600;color:#4ade80;">Auto-Tile</span>
      </div>
      <div class="component-body" style="display:flex;flex-direction:column;gap:5px;">
        <div class="prop-row"><span class="prop-label">Grid</span><span style="color:#9bc;">${d.cols} × ${d.rows}</span></div>
        <div class="prop-row"><span class="prop-label">Tile size</span><span style="color:#9bc;">${d.tileW}px</span></div>
        <div class="prop-row"><span class="prop-label">Painted</span><span style="color:#9bc;">${filledCount} cells</span></div>
        <div class="prop-row"><span class="prop-label">Brushes</span><span style="color:#9bc;font-size:10px;word-break:break-all;">${brushSummary}</span></div>
        <button id="btn-open-autotile-editor"
          style="width:100%;background:#1a2a1a;border:1px solid #4ade80;color:#4ade80;
                 border-radius:4px;padding:6px;cursor:pointer;font-size:11px;margin-top:4px;
                 display:flex;align-items:center;justify-content:center;gap:6px;">
          <svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2;">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          Open Auto-Tile Editor
        </button>
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────
// Public: full-screen editor
// ─────────────────────────────────────────────────────────────

export function openAutoTileEditor(obj) {
    _ensureBrushRegistry();
    document.getElementById('autotile-editor-panel')?.remove();

    const d = obj.autoTileData;
    if (!Array.isArray(d.activeBrushIds)) d.activeBrushIds = [];
    // Ensure cells is the new Array format
    if (!(d.cells instanceof Array)) {
        d.cells = _deserializeCells(d.cells, d.cols * d.rows);
    }

    const panel = document.createElement('div');
    panel.id = 'autotile-editor-panel';
    panel.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;background:rgba(0,0,0,0.65);backdrop-filter:blur(4px);font-family:sans-serif;font-size:13px;';

    panel.innerHTML = _editorHTML(d);
    document.body.appendChild(panel);
    _wireEditor(panel, obj);
}

// ─────────────────────────────────────────────────────────────
// Editor HTML template
// ─────────────────────────────────────────────────────────────

function _editorHTML(d) {
    return `
<div style="display:flex;width:100%;height:100%;overflow:hidden;">

  <!-- A: Brush Library -->
  <div style="width:230px;min-width:180px;background:#0e0e1c;border-right:1px solid #1a1a30;display:flex;flex-direction:column;overflow:hidden;">
    <div style="padding:10px 12px 8px;border-bottom:1px solid #1a1a30;display:flex;align-items:center;justify-content:space-between;">
      <span style="color:#4ade80;font-weight:700;font-size:12px;">Brush Library</span>
      <button id="at-new-brush" style="${BS('#4ade80')}">+ New</button>
    </div>

    <!-- Brush list -->
    <div id="at-brush-list" style="flex:1;overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:3px;"></div>

    <!-- Active brushes on this tilemap -->
    <div style="padding:8px 10px;border-top:1px solid #1a1a30;">
      <div style="color:#555;font-size:9px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px;">Active on map (paint order ↓)</div>
      <div id="at-active-list" style="display:flex;flex-direction:column;gap:3px;max-height:120px;overflow-y:auto;"></div>
    </div>
  </div>

  <!-- B: Slot Editor -->
  <div style="width:300px;min-width:250px;background:#0d0d1e;border-right:1px solid #1a1a30;display:flex;flex-direction:column;overflow:hidden;">
    <div style="padding:10px 12px 6px;border-bottom:1px solid #1a1a30;">
      <span style="color:#4ade80;font-weight:700;font-size:12px;">Slot Editor</span>
      <div id="at-editing-label" style="color:#666;font-size:10px;margin-top:2px;">← Select a brush to edit</div>
    </div>

    <!-- Upload toolbar -->
    <div style="padding:6px 10px 4px;display:flex;gap:5px;">
      <button id="at-upload-pieces" style="${BS('#3b82f6')}flex:1;">Upload Tiles</button>
      <button id="at-upload-sheet"  style="${BS('#7c3aed')}flex:1;">4×4 Sheet</button>
    </div>

    <!-- Gallery -->
    <div style="padding:0 10px 4px;">
      <div id="at-gallery" style="display:grid;grid-template-columns:repeat(5,1fr);gap:3px;max-height:90px;overflow-y:auto;"></div>
      <div id="at-gallery-empty" style="color:#444;font-size:10px;text-align:center;padding:4px 0;">Upload images to fill slots.</div>
    </div>

    <!-- Slot mode -->
    <div style="padding:0 10px 5px;display:flex;gap:5px;">
      <button id="at-mode-drag"  style="${TBTN(true)}flex:1;">✦ Drag</button>
      <button id="at-mode-erase" style="${TBTN(false)}flex:1;">✕ Erase px</button>
    </div>

    <!-- 16-slot grid -->
    <div style="flex:1;overflow-y:auto;padding:6px 10px;">
      <div id="at-slot-grid" style="display:flex;flex-direction:column;gap:4px;"></div>
    </div>

    <!-- Guide toggle -->
    <div style="padding:6px 10px;border-top:1px solid #1a1a30;">
      <button id="at-guide-toggle" style="${BS('#444')}font-size:10px;width:100%;">Grid Guides: ON</button>
    </div>

    <input id="at-file-pieces" type="file" multiple accept="image/*" style="display:none;">
    <input id="at-file-sheet"  type="file" accept="image/*"          style="display:none;">
  </div>

  <!-- C: Map Painter -->
  <div style="flex:1;background:#08080f;display:flex;flex-direction:column;overflow:hidden;">

    <!-- Toolbar -->
    <div style="padding:8px 12px;border-bottom:1px solid #1a1a30;display:flex;align-items:center;flex-wrap:wrap;gap:6px;flex-shrink:0;">
      <span style="color:#4ade80;font-weight:700;font-size:12px;">Map Painter</span>

      <!-- Active brush selector for painting -->
      <div style="display:flex;align-items:center;gap:5px;background:#111;border:1px solid #1a1a30;border-radius:4px;padding:3px 8px;">
        <span style="color:#666;font-size:10px;">Paint with:</span>
        <select id="at-paint-brush" style="${SEL()}width:120px;">
          <option value="">— all active —</option>
        </select>
      </div>

      <!-- Map draw mode -->
      <button id="at-map-paint" style="${TBTN(true)}">✏ Paint</button>
      <button id="at-map-erase" style="${TBTN(false)}">✕ Erase Layer</button>
      <button id="at-map-erase-all" style="${TBTN(false)}">✕✕ Erase All</button>

      <span style="color:#333;font-size:11px;">|</span>
      <label style="color:#777;font-size:11px;">Cols <input id="at-cols" type="number" value="${d.cols}" min="5" max="80" style="width:40px;${NI()}"></label>
      <label style="color:#777;font-size:11px;">Rows <input id="at-rows" type="number" value="${d.rows}" min="5" max="60" style="width:40px;${NI()}"></label>
      <label style="color:#777;font-size:11px;">Tile <input id="at-tileW" type="number" value="${d.tileW}" min="8" max="128" style="width:40px;${NI()}">px</label>
      <button id="at-apply-size" style="${BS('#3b82f6')}">Apply</button>
      <button id="at-clear-map"  style="${BS('#ef4444')}">Clear All</button>
      <button id="at-close"      style="${BS('#555')}margin-left:auto;">✕ Close</button>
    </div>

    <!-- Canvas -->
    <div style="flex:1;overflow:auto;padding:16px;">
      <canvas id="at-map-canvas"
        style="cursor:crosshair;image-rendering:pixelated;box-shadow:0 0 0 1px #1a1a30,0 4px 24px #000c;"
        oncontextmenu="return false;"></canvas>
    </div>

    <!-- Legend: layer visibility -->
    <div style="padding:5px 12px;border-top:1px solid #1a1a30;display:flex;align-items:center;gap:10px;flex-shrink:0;">
      <span style="color:#333;font-size:10px;">Left-click: paint layer  •  Right-click: erase active brush layer  •  Hold &amp; drag</span>
      <div id="at-layer-legend" style="display:flex;gap:6px;flex-wrap:wrap;margin-left:auto;"></div>
    </div>
  </div>
</div>`;
}

// ─────────────────────────────────────────────────────────────
// Style helpers
// ─────────────────────────────────────────────────────────────

const BS   = c => `background:${c}22;border:1px solid ${c}55;color:${c};border-radius:3px;padding:3px 8px;cursor:pointer;font-size:11px;font-weight:600;`;
const TBTN = a => a
    ? `background:#162816;border:1px solid #4ade80;color:#4ade80;border-radius:3px;padding:3px 8px;cursor:pointer;font-size:11px;font-weight:700;`
    : `background:#0a0a18;border:1px solid #1a1a30;color:#555;border-radius:3px;padding:3px 8px;cursor:pointer;font-size:11px;font-weight:600;`;
const NI   = () => `background:#0a0a18;border:1px solid #1a1a30;color:#e0e0e0;border-radius:3px;padding:2px 4px;font-size:11px;`;
const SEL  = () => `background:#0a0a18;border:1px solid #1a1a30;color:#e0e0e0;border-radius:3px;padding:2px 4px;font-size:11px;`;

// ─────────────────────────────────────────────────────────────
// Editor wiring
// ─────────────────────────────────────────────────────────────

function _wireEditor(panel, obj) {
    const d = obj.autoTileData;

    // ── Working state ──
    let activeBrushId  = null;    // which brush is selected in the library
    let slotMode       = 'drag';  // 'drag' | 'erase'
    let mapMode        = 'paint'; // 'paint' | 'erase' | 'eraseAll'
    let paintBrushId   = '';      // '' = paint with active brush
    let guidesOn       = true;
    let gallery        = [];
    let dragSrc        = null;

    // ── Slot eraser state ──
    let isSlotErasing  = false;
    let eraseCanvas    = null;
    let eraseCtx       = null;
    let eraseSlotId    = -1;
    let eraseBrushRef  = null;
    let eraseLast      = { x: 0, y: 0 };

    // ── Map canvas ──
    const mapCanvas = panel.querySelector('#at-map-canvas');
    const mapCtx    = mapCanvas.getContext('2d');
    let mapCols = d.cols, mapRows = d.rows;
    let tileW = d.tileW, tileH = d.tileH;

    // Deep-copy cells into editor local state
    let cells = d.cells.map(v => Array.isArray(v) ? v.slice() : null);

    let isMapDrawing  = false;
    let mapDrawVal    = 1; // 1 = paint, 0 = erase
    let imgCache      = {}; // brushId_slotId → HTMLImageElement

    function resizeCanvas() {
        mapCanvas.width  = mapCols * tileW;
        mapCanvas.height = mapRows * tileH;
    }
    resizeCanvas();

    // ── Bitmask (checks if ANY layer present) ──
    function bmask(col, row) {
        let m = 0;
        const idx = r => row + (r < 0 ? -1 : r > 0 ? 1 : 0);
        if (row > 0       && _cellFilled(cells, (row-1)*mapCols+col)) m += 1;
        if (col < mapCols-1 && _cellFilled(cells, row*mapCols+(col+1))) m += 2;
        if (row < mapRows-1 && _cellFilled(cells, (row+1)*mapCols+col)) m += 4;
        if (col > 0       && _cellFilled(cells, row*mapCols+(col-1))) m += 8;
        return m;
    }

    function _getImg(brushId, slotId, onLoad) {
        const key = (brushId || 'default') + '_' + slotId;
        if (imgCache[key]) return imgCache[key];
        const brush = brushId ? _getBrush(brushId) : null;
        const tiles = brush ? brush.tiles : (d.brushList || []);
        const url   = tiles[slotId];
        if (!url) return null;
        const img = new Image();
        img.onload = () => { imgCache[key] = img; onLoad?.(); };
        img.src = url;
        return null;
    }

    // ── Render one cell onto the canvas ──
    function renderCell(col, row) {
        const x = col * tileW, y = row * tileH;
        mapCtx.fillStyle = (row + col) % 2 === 0 ? '#0c0c1a' : '#090916';
        mapCtx.fillRect(x, y, tileW, tileH);

        const layers = _getLayers(cells, row * mapCols + col);
        if (layers.length) {
            const mask   = bmask(col, row);
            const slotId = BITMASK_TO_SLOT[mask] ?? 15;

            for (const brushId of layers) {
                const img = _getImg(brushId, slotId, () => renderCell(col, row));
                if (img) {
                    mapCtx.drawImage(img, x, y, tileW, tileH);
                } else {
                    // Placeholder tinted by hash of brushId
                    const hue = _strHue(brushId);
                    mapCtx.fillStyle = `hsla(${hue},70%,50%,0.3)`;
                    mapCtx.fillRect(x, y, tileW, tileH);
                }
            }
        }

        if (guidesOn) {
            mapCtx.strokeStyle = 'rgba(74,222,128,0.07)';
            mapCtx.lineWidth   = 0.5;
            mapCtx.strokeRect(x, y, tileW, tileH);
        }
    }

    function _strHue(s) {
        let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h;
    }

    function renderMap() {
        for (let r = 0; r < mapRows; r++)
            for (let c = 0; c < mapCols; c++)
                renderCell(c, r);
    }

    // ── Paint / erase a cell ──
    function paintCell(col, row) {
        if (col < 0 || col >= mapCols || row < 0 || row >= mapRows) return;
        const idx   = row * mapCols + col;
        let changed = false;

        if (mapMode === 'eraseAll') {
            if (_cellFilled(cells, idx)) { cells[idx] = []; changed = true; }
        } else if (mapMode === 'erase') {
            const bid = paintBrushId || activeBrushId || null;
            if (bid) changed = _removeLayer(cells, idx, bid);
            else     { if (_cellFilled(cells, idx)) { cells[idx] = []; changed = true; } }
        } else {
            // Paint: REPLACE the brush at this cell.
            // If the cell already has this exact brush, skip (no change).
            // If the cell has a DIFFERENT brush, replace it with the new one.
            // This means each cell holds exactly ONE brush at a time — switching
            // brush and painting overwrites the previous brush on that cell.
            const bid = paintBrushId || activeBrushId;
            if (!bid) return;
            const current = cells[idx];
            const alreadyThis = Array.isArray(current) && current.length === 1 && current[0] === bid;
            if (!alreadyThis) {
                cells[idx] = [bid];   // replace — always exactly one brush per cell
                changed = true;
            }
        }

        if (!changed) return;

        // Re-render self + neighbors (bitmask may change)
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            const r2 = row + dr, c2 = col + dc;
            if (r2 >= 0 && r2 < mapRows && c2 >= 0 && c2 < mapCols)
                renderCell(c2, r2);
        }
    }

    function getCell(e) {
        const rect = mapCanvas.getBoundingClientRect();
        const sx   = mapCanvas.width / rect.width, sy = mapCanvas.height / rect.height;
        return {
            col: Math.floor(((e.clientX - rect.left) * sx) / tileW),
            row: Math.floor(((e.clientY - rect.top)  * sy) / tileH),
        };
    }

    mapCanvas.addEventListener('mousedown', e => {
        if (e.button === 2) { mapMode = 'erase'; } // right-click always erases active layer
        isMapDrawing = true;
        const { col, row } = getCell(e);
        paintCell(col, row);
    });
    mapCanvas.addEventListener('contextmenu', e => e.preventDefault());

    const _mmove = e => { if (!isMapDrawing) return; const { col, row } = getCell(e); paintCell(col, row); };
    const _mup   = e => {
        if (isMapDrawing && e.button === 2) {
            // Restore map mode after right-click erase
            mapMode = panel.querySelector('#at-map-erase')?.classList?.contains?.('active') ? 'erase'
                    : panel.querySelector('#at-map-erase-all')?.classList?.contains?.('active') ? 'eraseAll'
                    : 'paint';
        }
        isMapDrawing = false;
    };
    window.addEventListener('mousemove', _mmove);
    window.addEventListener('mouseup',   _mup);

    // ── Map mode buttons ──
    function setMapMode(m) {
        mapMode = m;
        panel.querySelector('#at-map-paint').style.cssText    = TBTN(m === 'paint');
        panel.querySelector('#at-map-erase').style.cssText    = TBTN(m === 'erase');
        panel.querySelector('#at-map-erase-all').style.cssText = TBTN(m === 'eraseAll');
    }
    panel.querySelector('#at-map-paint').addEventListener('click',     () => setMapMode('paint'));
    panel.querySelector('#at-map-erase').addEventListener('click',     () => setMapMode('erase'));
    panel.querySelector('#at-map-erase-all').addEventListener('click', () => setMapMode('eraseAll'));

    // ── Paint brush selector ──
    function rebuildPaintBrushSel() {
        const sel = panel.querySelector('#at-paint-brush');
        const cur = sel.value;
        sel.innerHTML = '<option value="">— all active —</option>';
        _ensureBrushRegistry();
        state.tilesetBrushes.forEach(b => {
            const o = document.createElement('option');
            o.value = b.id; o.textContent = b.name;
            if (b.id === cur || (!cur && b.id === activeBrushId)) o.selected = true;
            sel.appendChild(o);
        });
        paintBrushId = sel.value;
    }
    panel.querySelector('#at-paint-brush').addEventListener('change', e => { paintBrushId = e.target.value; });

    // ── Layer legend ──
    function updateLegend() {
        const leg = panel.querySelector('#at-layer-legend');
        leg.innerHTML = '';
        (d.activeBrushIds || []).forEach(bid => {
            const b = _getBrush(bid);
            if (!b) return;
            const hue  = _strHue(bid);
            const chip = document.createElement('div');
            chip.style.cssText = `display:flex;align-items:center;gap:3px;font-size:9px;color:#aaa;`;
            chip.innerHTML = `<span style="width:10px;height:10px;border-radius:2px;background:hsla(${hue},70%,55%,0.7);display:inline-block;"></span>${b.name}`;
            leg.appendChild(chip);
        });
    }

    // ── Brush library ──
    function rebuildBrushLib() {
        _ensureBrushRegistry();
        const listEl   = panel.querySelector('#at-brush-list');
        const activeEl = panel.querySelector('#at-active-list');
        listEl.innerHTML = '';
        activeEl.innerHTML = '';

        if (!state.tilesetBrushes.length) {
            listEl.innerHTML = '<div style="color:#444;font-size:10px;text-align:center;padding:10px;">No brushes yet.</div>';
        }

        state.tilesetBrushes.forEach(b => {
            const isSelected = b.id === activeBrushId;
            const isActive   = (d.activeBrushIds || []).includes(b.id);

            // Library row
            const row = document.createElement('div');
            row.style.cssText = `display:flex;align-items:center;gap:4px;padding:4px 6px;border-radius:3px;cursor:pointer;border:1px solid ${isSelected ? '#4ade80' : '#1a1a30'};background:${isSelected ? '#162816' : '#111'};`;

            const nm = document.createElement('span');
            nm.style.cssText = 'flex:1;color:#ccc;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            nm.textContent   = b.name;

            const renBtn = document.createElement('button');
            renBtn.textContent = '✎'; renBtn.title = 'Rename';
            renBtn.style.cssText = BS('#888') + 'padding:1px 4px;font-size:10px;';
            renBtn.addEventListener('click', ev => {
                ev.stopPropagation();
                const n = prompt('Rename brush:', b.name);
                if (n && n.trim()) { b.name = n.trim(); rebuildBrushLib(); rebuildPaintBrushSel(); updateLegend(); }
            });

            const editBtn = document.createElement('button');
            editBtn.textContent = '✏'; editBtn.title = 'Edit slots';
            editBtn.style.cssText = BS('#4ade80') + 'padding:1px 4px;font-size:10px;';
            editBtn.addEventListener('click', ev => { ev.stopPropagation(); selectBrush(b.id); });

            const delBtn = document.createElement('button');
            delBtn.textContent = '✕'; delBtn.title = 'Delete';
            delBtn.style.cssText = BS('#ef4444') + 'padding:1px 4px;font-size:10px;';
            delBtn.addEventListener('click', ev => {
                ev.stopPropagation();
                if (!confirm(`Delete brush "${b.name}"?`)) return;
                const i = state.tilesetBrushes.indexOf(b);
                if (i >= 0) state.tilesetBrushes.splice(i, 1);
                const ai = (d.activeBrushIds || []).indexOf(b.id);
                if (ai >= 0) d.activeBrushIds.splice(ai, 1);
                // Remove from all cells
                cells.forEach((v, idx) => { if (Array.isArray(v)) _removeLayer(cells, idx, b.id); });
                if (activeBrushId === b.id) { activeBrushId = null; gallery = []; buildSlotGrid(null); }
                imgCache = {};
                rebuildBrushLib(); rebuildPaintBrushSel(); updateLegend(); renderMap();
            });

            row.appendChild(nm); row.appendChild(renBtn); row.appendChild(editBtn); row.appendChild(delBtn);
            row.addEventListener('click', () => selectBrush(b.id));
            listEl.appendChild(row);

            // Active-on-map checkbox
            const aRow = document.createElement('label');
            aRow.style.cssText = 'display:flex;align-items:center;gap:5px;cursor:pointer;';

            const chk = document.createElement('input');
            chk.type = 'checkbox'; chk.checked = isActive;
            chk.style.cssText = 'accent-color:#4ade80;cursor:pointer;margin:0;';
            chk.addEventListener('change', () => {
                if (!d.activeBrushIds) d.activeBrushIds = [];
                if (chk.checked) {
                    if (!d.activeBrushIds.includes(b.id)) d.activeBrushIds.push(b.id);
                } else {
                    const i = d.activeBrushIds.indexOf(b.id);
                    if (i >= 0) d.activeBrushIds.splice(i, 1);
                }
                imgCache = {}; rebuildPaintBrushSel(); updateLegend(); renderMap();
            });

            const hue  = _strHue(b.id);
            const dot  = document.createElement('span');
            dot.style.cssText = `width:8px;height:8px;border-radius:2px;background:hsla(${hue},70%,55%,0.8);flex-shrink:0;`;

            const lbl = document.createElement('span');
            lbl.style.cssText = 'color:#aaa;font-size:10px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            lbl.textContent   = b.name;

            aRow.appendChild(chk); aRow.appendChild(dot); aRow.appendChild(lbl);
            activeEl.appendChild(aRow);
        });

        rebuildPaintBrushSel();
        updateLegend();
    }

    // ── Select brush for editing ──
    function selectBrush(id) {
        activeBrushId = id;
        const b = _getBrush(id);
        panel.querySelector('#at-editing-label').textContent = b ? `Editing: ${b.name}` : '← Select a brush to edit';
        gallery = b ? b.tiles.filter(Boolean) : [];
        buildSlotGrid(b);
        refreshGallery();
        rebuildBrushLib();
        // Auto-set paint brush to this one
        paintBrushId = id;
        const sel = panel.querySelector('#at-paint-brush');
        if (sel) sel.value = id;
    }

    // ── New brush ──
    panel.querySelector('#at-new-brush').addEventListener('click', () => {
        const name = prompt('Brush name:', 'New Brush');
        if (!name) return;
        const b = _newBrush(name.trim());
        if (!d.activeBrushIds) d.activeBrushIds = [];
        if (!d.activeBrushIds.includes(b.id)) d.activeBrushIds.push(b.id);
        rebuildBrushLib();
        selectBrush(b.id);
    });

    // ── Slot grid ──
    function buildSlotGrid(brush) {
        const grid = panel.querySelector('#at-slot-grid');
        grid.innerHTML = '';
        if (!brush) {
            grid.innerHTML = '<div style="color:#444;font-size:11px;text-align:center;padding:16px;">Select a brush to edit its tile slots.</div>';
            return;
        }

        SLOT_LAYOUT.forEach(rowIds => {
            const rowEl = document.createElement('div');
            rowEl.style.cssText = 'display:flex;gap:4px;';
            rowIds.forEach(slotId => {
                const cell = document.createElement('div');
                cell.style.cssText = `width:52px;height:52px;background:#0c0c1a;border:1px solid ${guidesOn ? '#1a1a30' : 'transparent'};border-radius:3px;position:relative;overflow:hidden;cursor:pointer;box-sizing:border-box;flex-shrink:0;`;

                if (brush.tiles[slotId]) {
                    const cvs = document.createElement('canvas');
                    cvs.style.cssText = 'width:100%;height:100%;object-fit:fill;display:block;';
                    const img = new Image();
                    img.onload = () => { cvs.width = img.width || 64; cvs.height = img.height || 64; cvs.getContext('2d').drawImage(img, 0, 0); };
                    img.src    = brush.tiles[slotId];
                    cell.insertBefore(cvs, cell.firstChild);

                    if (slotMode === 'drag') {
                        const clrBtn = document.createElement('div');
                        clrBtn.style.cssText = 'display:none;position:absolute;top:0;right:0;background:#ef4444;color:#fff;padding:2px 4px;border-bottom-left-radius:3px;cursor:pointer;font-size:9px;line-height:1;';
                        clrBtn.textContent   = '✕';
                        clrBtn.addEventListener('click', ev => {
                            ev.stopPropagation();
                            brush.tiles[slotId] = null;
                            Object.keys(imgCache).forEach(k => { if (k.endsWith('_'+slotId)) delete imgCache[k]; });
                            buildSlotGrid(brush);
                            renderMap();
                        });
                        cell.appendChild(clrBtn);
                        cell.addEventListener('mouseenter', () => { clrBtn.style.display = 'block'; });
                        cell.addEventListener('mouseleave', () => { clrBtn.style.display = 'none'; });
                    }
                }

                const lbl = document.createElement('div');
                lbl.style.cssText = 'position:absolute;bottom:1px;left:2px;color:#333;font-size:7px;pointer-events:none;';
                lbl.textContent   = `S${slotId}`;
                cell.appendChild(lbl);

                // Drop target
                cell.addEventListener('dragover', e => { if (slotMode !== 'drag') return; e.preventDefault(); cell.style.boxShadow = 'inset 0 0 0 2px #3b82f6'; });
                cell.addEventListener('dragleave', () => { cell.style.boxShadow = ''; });
                cell.addEventListener('drop', e => {
                    if (slotMode !== 'drag') return;
                    e.preventDefault(); cell.style.boxShadow = '';
                    const src = dragSrc || e.dataTransfer.getData('text/plain');
                    if (!src) return;
                    brush.tiles[slotId] = src;
                    Object.keys(imgCache).forEach(k => { if (k.endsWith('_'+slotId)) delete imgCache[k]; });
                    buildSlotGrid(brush); renderMap();
                });

                // Pixel eraser
                cell.addEventListener('mousedown', e => {
                    if (slotMode !== 'erase') return;
                    const cvs = cell.querySelector('canvas');
                    if (!cvs) return;
                    e.preventDefault();
                    isSlotErasing = true; eraseCanvas = cvs; eraseSlotId = slotId; eraseBrushRef = brush;
                    eraseCtx = cvs.getContext('2d');
                    eraseCtx.globalCompositeOperation = 'destination-out';
                    eraseCtx.lineWidth = Math.max(4, cvs.width / 6);
                    eraseCtx.lineCap = 'round'; eraseCtx.lineJoin = 'round';
                    const p = _cvPos(cvs, e); eraseLast = p;
                    eraseCtx.beginPath(); eraseCtx.arc(p.x, p.y, eraseCtx.lineWidth/2, 0, Math.PI*2); eraseCtx.fill();
                });

                rowEl.appendChild(cell);
            });
            grid.appendChild(rowEl);
        });
    }

    // Pixel erase move/end
    const _em = e => {
        if (!isSlotErasing || !eraseCanvas) return;
        e.preventDefault();
        const p = _cvPos(eraseCanvas, e);
        eraseCtx.beginPath(); eraseCtx.moveTo(eraseLast.x, eraseLast.y); eraseCtx.lineTo(p.x, p.y); eraseCtx.stroke();
        eraseLast = p;
    };
    const _eu = () => {
        if (!isSlotErasing || !eraseCanvas) return;
        isSlotErasing = false;
        if (eraseBrushRef && eraseSlotId >= 0) {
            const url = eraseCanvas.toDataURL('image/png');
            eraseBrushRef.tiles[eraseSlotId] = url;
            Object.keys(imgCache).forEach(k => { if (k.endsWith('_'+eraseSlotId)) delete imgCache[k]; });
            renderMap();
        }
        eraseCanvas = null; eraseCtx = null; eraseSlotId = -1; eraseBrushRef = null;
    };
    window.addEventListener('mousemove', _em);
    window.addEventListener('mouseup',   _eu);

    function _cvPos(cvs, e) {
        const r = cvs.getBoundingClientRect();
        const sx = cvs.width/r.width, sy = cvs.height/r.height;
        const src = e.touches ? e.touches[0] : e;
        return { x: (src.clientX - r.left)*sx, y: (src.clientY - r.top)*sy };
    }

    // ── Gallery ──
    function addToGallery(url) { if (!gallery.includes(url)) { gallery.push(url); refreshGallery(); } }
    function refreshGallery() {
        const el = panel.querySelector('#at-gallery');
        const em = panel.querySelector('#at-gallery-empty');
        el.innerHTML = '';
        em.style.display = gallery.length ? 'none' : '';
        gallery.forEach(url => {
            const item = document.createElement('div');
            item.draggable = true;
            item.style.cssText = 'aspect-ratio:1;background:#090916;border:1px solid #1a1a30;border-radius:3px;overflow:hidden;cursor:grab;';
            const img = document.createElement('img');
            img.src = url; img.style.cssText = 'width:100%;height:100%;object-fit:cover;pointer-events:none;';
            item.appendChild(img);
            item.addEventListener('dragstart', e => { dragSrc = url; e.dataTransfer.setData('text/plain', url); e.dataTransfer.effectAllowed = 'copy'; });
            item.addEventListener('dragend',   () => { dragSrc = null; });
            el.appendChild(item);
        });
    }

    panel.querySelector('#at-upload-pieces').addEventListener('click', () => panel.querySelector('#at-file-pieces').click());
    panel.querySelector('#at-file-pieces').addEventListener('change', e => {
        const brush = activeBrushId ? _getBrush(activeBrushId) : null;
        Array.from(e.target.files).forEach(f => {
            if (!f.type.startsWith('image/')) return;
            const fr = new FileReader();
            fr.onload = ev => {
                addToGallery(ev.target.result);
                if (brush) {
                    const ei = brush.tiles.findIndex(t => !t);
                    if (ei >= 0) {
                        brush.tiles[ei] = ev.target.result;
                        Object.keys(imgCache).forEach(k => { if (k.endsWith('_'+ei)) delete imgCache[k]; });
                        buildSlotGrid(brush); renderMap();
                    }
                }
            };
            fr.readAsDataURL(f);
        });
        e.target.value = '';
    });

    panel.querySelector('#at-upload-sheet').addEventListener('click', () => {
        const brush = activeBrushId ? _getBrush(activeBrushId) : null;
        if (!brush) { alert('Select or create a brush first.'); return; }
        panel.querySelector('#at-file-sheet').click();
    });
    panel.querySelector('#at-file-sheet').addEventListener('change', e => {
        const brush = activeBrushId ? _getBrush(activeBrushId) : null;
        if (!brush) return;
        const f = e.target.files[0]; if (!f) return;
        const fr = new FileReader();
        fr.onload = ev => {
            const img = new Image();
            img.onload = () => {
                const slW = Math.floor(img.width/4), slH = Math.floor(img.height/4);
                const off = document.createElement('canvas'); off.width = slW; off.height = slH;
                const ctx = off.getContext('2d');
                SHEET_TO_SLOT.forEach((sid, idx) => {
                    ctx.clearRect(0, 0, slW, slH);
                    ctx.drawImage(img, (idx%4)*slW, Math.floor(idx/4)*slH, slW, slH, 0, 0, slW, slH);
                    const url = off.toDataURL('image/png');
                    brush.tiles[sid] = url;
                    addToGallery(url);
                    Object.keys(imgCache).forEach(k => { if (k.endsWith('_'+sid)) delete imgCache[k]; });
                });
                buildSlotGrid(brush); imgCache = {}; renderMap();
            };
            img.src = ev.target.result;
        };
        fr.readAsDataURL(f);
        e.target.value = '';
    });

    // ── Slot mode buttons ──
    function setSlotMode(m) {
        slotMode = m;
        panel.querySelector('#at-mode-drag').style.cssText  = TBTN(m === 'drag')  + 'flex:1;';
        panel.querySelector('#at-mode-erase').style.cssText = TBTN(m === 'erase') + 'flex:1;';
        buildSlotGrid(activeBrushId ? _getBrush(activeBrushId) : null);
    }
    panel.querySelector('#at-mode-drag').addEventListener('click',  () => setSlotMode('drag'));
    panel.querySelector('#at-mode-erase').addEventListener('click', () => setSlotMode('erase'));

    // ── Guide toggle ──
    panel.querySelector('#at-guide-toggle').addEventListener('click', () => {
        guidesOn = !guidesOn;
        panel.querySelector('#at-guide-toggle').textContent = `Grid Guides: ${guidesOn ? 'ON' : 'OFF'}`;
        buildSlotGrid(activeBrushId ? _getBrush(activeBrushId) : null);
        renderMap();
    });

    // ── Resize ──
    panel.querySelector('#at-apply-size').addEventListener('click', () => {
        const nc  = Math.max(5, Math.min(80,  parseInt(panel.querySelector('#at-cols').value)  || mapCols));
        const nr  = Math.max(5, Math.min(60,  parseInt(panel.querySelector('#at-rows').value)  || mapRows));
        const nt  = Math.max(8, Math.min(128, parseInt(panel.querySelector('#at-tileW').value) || tileW));
        if (nc !== mapCols || nr !== mapRows) {
            const nc2 = new Array(nc * nr).fill(null);
            for (let r = 0; r < Math.min(mapRows, nr); r++)
                for (let c = 0; c < Math.min(mapCols, nc); c++) {
                    const v = cells[r * mapCols + c];
                    if (Array.isArray(v) && v.length) nc2[r * nc + c] = v.slice();
                }
            cells = nc2; mapCols = nc; mapRows = nr;
        }
        tileW = nt; tileH = nt;
        resizeCanvas(); renderMap();
    });

    // ── Clear all ──
    panel.querySelector('#at-clear-map').addEventListener('click', () => { cells = new Array(mapCols * mapRows).fill(null); renderMap(); });

    // ── Save & close ──
    function save() {
        window.removeEventListener('mousemove', _mmove);
        window.removeEventListener('mouseup',   _mup);
        window.removeEventListener('mousemove', _em);
        window.removeEventListener('mouseup',   _eu);

        d.cols   = mapCols;
        d.rows   = mapRows;
        d.tileW  = tileW;
        d.tileH  = tileH;
        d.cells  = cells.map(v => Array.isArray(v) && v.length ? v.slice() : null);

        // Keep brushList up-to-date (merged snapshot for backward compat)
        const merged = new Array(16).fill(null);
        (d.activeBrushIds || []).forEach(bid => {
            const b = _getBrush(bid);
            if (b) b.tiles.forEach((url, i) => { if (url) merged[i] = url; });
        });
        d.brushList = merged;

        _buildAutoTileHelper(obj);
        rebuildAutoTileSprites(obj);
        import('./engine.ui.js').then(m => { m.refreshHierarchy(); m.syncPixiToInspector?.(); });
        import('./engine.history.js').then(({ pushUndo }) => pushUndo());
        panel.remove();
    }

    panel.querySelector('#at-close').addEventListener('click', save);
    panel.addEventListener('mousedown', e => { if (e.target === panel) save(); });

    // ── Init ──
    rebuildBrushLib();
    renderMap();
}
