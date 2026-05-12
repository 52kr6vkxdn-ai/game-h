/* ============================================================
   Zengine — engine.spritesheet.js
   Sprite Sheet Slicer
   Import a sheet image → configure rows/cols or tile size →
   preview the grid overlay → export individual frames directly
   into the currently selected animation in the animator,
   OR into a new animation clip on the target object.
   ============================================================ */

import { state } from './engine.state.js';

let _resolve = null; // resolves with array of frame dataURLs

/**
 * openSpritesheetSlicer(obj)
 *   Opens the slicer modal attached to `obj`.
 *   When slicing is confirmed the frames are injected into
 *   obj.animations[obj.activeAnimIndex].frames and the animator
 *   is refreshed if it's open.
 */
export function openSpritesheetSlicer(obj) {
    document.getElementById('ss-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'ss-modal';
    modal.style.cssText = `
        position:fixed;inset:0;z-index:20000;
        background:rgba(0,0,0,0.92);
        display:flex;align-items:center;justify-content:center;
        font-family:'Inter','Segoe UI',sans-serif;font-size:11px;color:#d8d8e8;
    `;

    modal.innerHTML = `
    <div style="background:#1a1a24;border:1px solid #3a3a48;border-radius:10px;
                width:880px;max-width:96vw;max-height:94vh;display:flex;flex-direction:column;
                box-shadow:0 24px 80px rgba(0,0,0,0.9);overflow:hidden;">

      <!-- Header -->
      <div style="display:flex;align-items:center;gap:10px;padding:14px 20px;
                  border-bottom:1px solid #2e2e3a;flex-shrink:0;background:#141420;">
        <svg viewBox="0 0 24 24" style="width:18px;height:18px;fill:none;stroke:#3A72A5;stroke-width:2;">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/>
          <line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>
        </svg>
        <span style="font-size:14px;font-weight:700;color:#fff;">Sprite Sheet Slicer</span>
        <span style="color:#505060;">— ${obj.label}</span>
        <div style="flex:1;"></div>
        <button id="ss-close" style="background:none;border:none;color:#666;cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;">✕</button>
      </div>

      <!-- Body -->
      <div style="display:flex;flex:1;overflow:hidden;">

        <!-- Left: controls -->
        <div style="width:240px;flex-shrink:0;border-right:1px solid #2e2e3a;
                    padding:16px;display:flex;flex-direction:column;gap:14px;overflow-y:auto;">

          <!-- Step 1: Import -->
          <div>
            <div style="font-size:10px;font-weight:700;color:#7a7a90;letter-spacing:.8px;margin-bottom:8px;">1 · IMPORT SHEET</div>
            <label id="ss-import-label" style="display:flex;align-items:center;justify-content:center;gap:6px;
                   background:#1e3050;border:1px solid #3A72A5;color:#7aabcc;border-radius:5px;
                   padding:8px;cursor:pointer;font-size:11px;">
              <svg viewBox="0 0 24 24" style="width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2;">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              Choose Image…
            </label>
            <input type="file" id="ss-file-input" accept="image/*" style="display:none;">
            <div id="ss-sheet-info" style="margin-top:6px;font-size:10px;color:#505060;text-align:center;">No image loaded</div>
          </div>

          <!-- Step 2: Slice mode -->
          <div id="ss-config" style="opacity:0.35;pointer-events:none;">
            <div style="font-size:10px;font-weight:700;color:#7a7a90;letter-spacing:.8px;margin-bottom:8px;">2 · SLICE MODE</div>
            <div style="display:flex;gap:4px;margin-bottom:10px;">
              <button class="ss-mode-btn ss-mode-active" data-mode="grid" style="flex:1;padding:5px;border-radius:4px;border:1px solid #3A72A5;background:#1e3050;color:#7aabcc;cursor:pointer;font-size:10px;">Grid (Rows×Cols)</button>
              <button class="ss-mode-btn" data-mode="size" style="flex:1;padding:5px;border-radius:4px;border:1px solid #2e2e3a;background:transparent;color:#606070;cursor:pointer;font-size:10px;">Tile Size (px)</button>
            </div>

            <!-- Grid mode -->
            <div id="ss-grid-mode">
              <div class="ss-row">
                <span class="ss-lbl">Columns</span>
                <input type="number" id="ss-cols" value="4" min="1" max="128" class="ss-inp">
              </div>
              <div class="ss-row">
                <span class="ss-lbl">Rows</span>
                <input type="number" id="ss-rows" value="4" min="1" max="128" class="ss-inp">
              </div>
              <div class="ss-row">
                <span class="ss-lbl">Frame count</span>
                <input type="number" id="ss-count" value="16" min="1" max="4096" class="ss-inp">
              </div>
            </div>

            <!-- Size mode (hidden by default) -->
            <div id="ss-size-mode" style="display:none;">
              <div class="ss-row">
                <span class="ss-lbl">Tile width</span>
                <input type="number" id="ss-tw" value="32" min="1" max="2048" class="ss-inp">
              </div>
              <div class="ss-row">
                <span class="ss-lbl">Tile height</span>
                <input type="number" id="ss-th" value="32" min="1" max="2048" class="ss-inp">
              </div>
              <div class="ss-row">
                <span class="ss-lbl">Frame count</span>
                <input type="number" id="ss-count-sz" value="16" min="1" max="4096" class="ss-inp">
              </div>
            </div>

            <!-- Offset/padding -->
            <div style="margin-top:8px;">
              <div class="ss-row">
                <span class="ss-lbl">Offset X</span>
                <input type="number" id="ss-offx" value="0" min="0" max="512" class="ss-inp">
              </div>
              <div class="ss-row">
                <span class="ss-lbl">Offset Y</span>
                <input type="number" id="ss-offy" value="0" min="0" max="512" class="ss-inp">
              </div>
              <div class="ss-row">
                <span class="ss-lbl">Spacing X</span>
                <input type="number" id="ss-spx" value="0" min="0" max="64" class="ss-inp">
              </div>
              <div class="ss-row">
                <span class="ss-lbl">Spacing Y</span>
                <input type="number" id="ss-spy" value="0" min="0" max="64" class="ss-inp">
              </div>
            </div>
          </div>

          <!-- Step 3: Target animation -->
          <div id="ss-target-sec" style="opacity:0.35;pointer-events:none;">
            <div style="font-size:10px;font-weight:700;color:#7a7a90;letter-spacing:.8px;margin-bottom:8px;">3 · TARGET ANIMATION</div>
            <select id="ss-anim-select" style="width:100%;background:#16161e;border:1px solid #3a3a48;
                    color:#d8d8e8;border-radius:4px;padding:5px 6px;font-size:11px;outline:none;"></select>
            <label style="display:flex;align-items:center;gap:6px;margin-top:6px;cursor:pointer;">
              <input type="checkbox" id="ss-replace-check" checked style="accent-color:#3A72A5;">
              <span style="color:#9a9ab0;font-size:10px;">Replace existing frames</span>
            </label>
          </div>

          <!-- Stats -->
          <div id="ss-stats" style="background:#0e0e18;border-radius:5px;padding:10px;font-size:10px;color:#505060;line-height:1.8;display:none;">
            <div>Sheet: <span id="ss-st-size" style="color:#9bc;">—</span></div>
            <div>Tile: <span id="ss-st-tile" style="color:#9bc;">—</span></div>
            <div>Frames: <span id="ss-st-frames" style="color:#4ade80;">—</span></div>
          </div>
        </div>

        <!-- Right: preview canvas -->
        <div style="flex:1;display:flex;flex-direction:column;overflow:hidden;background:#0e0e18;">
          <div style="padding:10px 14px;border-bottom:1px solid #1e1e2e;font-size:10px;color:#505060;flex-shrink:0;display:flex;align-items:center;gap:8px;">
            <span>Preview</span>
            <span id="ss-hover-info" style="color:#7a7a90;margin-left:auto;"></span>
          </div>
          <div style="flex:1;overflow:auto;display:flex;align-items:center;justify-content:center;padding:16px;">
            <div style="position:relative;display:inline-block;">
              <canvas id="ss-preview-canvas" style="display:block;image-rendering:pixelated;max-width:100%;"></canvas>
              <canvas id="ss-overlay-canvas" style="position:absolute;inset:0;pointer-events:none;"></canvas>
            </div>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;
                  padding:12px 20px;border-top:1px solid #2e2e3a;flex-shrink:0;background:#141420;">
        <span id="ss-footer-msg" style="color:#505060;font-size:10px;flex:1;"></span>
        <button id="ss-cancel" style="background:#1a1a24;border:1px solid #3a3a48;color:#9a9ab0;
                border-radius:5px;padding:7px 18px;cursor:pointer;font-size:11px;">Cancel</button>
        <button id="ss-slice-btn" disabled style="background:#1e3050;border:1px solid #3A72A5;color:#7aabcc;
                border-radius:5px;padding:7px 20px;cursor:not-allowed;font-size:11px;font-weight:600;
                opacity:0.4;">Slice & Import Frames</button>
      </div>
    </div>

    <style>
      .ss-row { display:flex;align-items:center;justify-content:space-between;margin-bottom:6px; }
      .ss-lbl { color:#7a7a90;font-size:10px; }
      .ss-inp { width:70px;background:#16161e;border:1px solid #3a3a48;color:#d8d8e8;
                border-radius:3px;padding:3px 5px;font-size:11px;outline:none;text-align:right; }
      .ss-inp:focus { border-color:#3A72A5; }
      .ss-mode-active { border-color:#3A72A5 !important;background:#1e3050 !important;color:#7aabcc !important; }
    </style>
    `;

    document.body.appendChild(modal);
    _wireModal(modal, obj);
}

function _wireModal(modal, obj) {
    let imgEl = null;     // loaded HTMLImageElement
    let sliceMode = 'grid'; // 'grid' | 'size'

    const previewCanvas = modal.querySelector('#ss-preview-canvas');
    const overlayCanvas = modal.querySelector('#ss-overlay-canvas');
    const ctx = previewCanvas.getContext('2d');
    const octx = overlayCanvas.getContext('2d');

    // ── Close / cancel ──────────────────────────────────────
    const closeModal = () => modal.remove();
    modal.querySelector('#ss-close').addEventListener('click', closeModal);
    modal.querySelector('#ss-cancel').addEventListener('click', closeModal);
    modal.addEventListener('mousedown', e => { if (e.target === modal) closeModal(); });

    // ── File import ─────────────────────────────────────────
    modal.querySelector('#ss-import-label').addEventListener('click', () => {
        modal.querySelector('#ss-file-input').click();
    });

    modal.querySelector('#ss-file-input').addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
            const img = new Image();
            img.onload = () => {
                imgEl = img;
                // Draw onto preview canvas
                previewCanvas.width  = img.width;
                previewCanvas.height = img.height;
                overlayCanvas.width  = img.width;
                overlayCanvas.height = img.height;
                ctx.drawImage(img, 0, 0);
                // Enable controls
                modal.querySelector('#ss-config').style.opacity  = '1';
                modal.querySelector('#ss-config').style.pointerEvents = '';
                modal.querySelector('#ss-target-sec').style.opacity  = '1';
                modal.querySelector('#ss-target-sec').style.pointerEvents = '';
                modal.querySelector('#ss-stats').style.display = 'block';
                modal.querySelector('#ss-sheet-info').textContent = `${img.width} × ${img.height} px`;
                // Populate anim list
                _populateAnimSelect(modal, obj);
                // Enable slice button
                modal.querySelector('#ss-slice-btn').disabled = false;
                modal.querySelector('#ss-slice-btn').style.opacity = '1';
                modal.querySelector('#ss-slice-btn').style.cursor = 'pointer';
                _updateOverlay();
            };
            img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    });

    // ── Slice mode toggle ───────────────────────────────────
    modal.querySelectorAll('.ss-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            sliceMode = btn.dataset.mode;
            modal.querySelectorAll('.ss-mode-btn').forEach(b => b.classList.remove('ss-mode-active'));
            btn.classList.add('ss-mode-active');
            modal.querySelector('#ss-grid-mode').style.display = sliceMode === 'grid' ? '' : 'none';
            modal.querySelector('#ss-size-mode').style.display = sliceMode === 'size' ? '' : 'none';
            _updateOverlay();
        });
    });

    // ── Input changes → redraw overlay ──────────────────────
    ['ss-cols','ss-rows','ss-count','ss-tw','ss-th','ss-count-sz',
     'ss-offx','ss-offy','ss-spx','ss-spy'].forEach(id => {
        modal.querySelector('#' + id)?.addEventListener('input', _updateOverlay);
    });

    // ── Overlay drawing ─────────────────────────────────────
    function _getSliceParams() {
        const offX = parseInt(modal.querySelector('#ss-offx').value) || 0;
        const offY = parseInt(modal.querySelector('#ss-offy').value) || 0;
        const spX  = parseInt(modal.querySelector('#ss-spx').value)  || 0;
        const spY  = parseInt(modal.querySelector('#ss-spy').value)  || 0;

        if (!imgEl) return null;
        const W = imgEl.width, H = imgEl.height;

        let tileW, tileH, cols, rows, count;

        if (sliceMode === 'grid') {
            cols  = Math.max(1, parseInt(modal.querySelector('#ss-cols').value) || 4);
            rows  = Math.max(1, parseInt(modal.querySelector('#ss-rows').value) || 4);
            tileW = Math.floor((W - offX - spX * (cols - 1)) / cols);
            tileH = Math.floor((H - offY - spY * (rows - 1)) / rows);
            count = parseInt(modal.querySelector('#ss-count').value) || (cols * rows);
        } else {
            tileW = Math.max(1, parseInt(modal.querySelector('#ss-tw').value)  || 32);
            tileH = Math.max(1, parseInt(modal.querySelector('#ss-th').value)  || 32);
            cols  = Math.floor((W - offX) / (tileW + spX));
            rows  = Math.floor((H - offY) / (tileH + spY));
            count = parseInt(modal.querySelector('#ss-count-sz').value) || (cols * rows);
        }

        count = Math.min(count, cols * rows);
        return { tileW, tileH, cols, rows, count, offX, offY, spX, spY };
    }

    function _updateOverlay() {
        const p = _getSliceParams();
        if (!p || !imgEl) return;
        const { tileW, tileH, cols, rows, count, offX, offY, spX, spY } = p;

        octx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        // Dim overlay
        octx.fillStyle = 'rgba(0,0,0,0.3)';
        octx.fillRect(0, 0, overlayCanvas.width, overlayCanvas.height);

        let drawn = 0;
        for (let r = 0; r < rows && drawn < count; r++) {
            for (let c = 0; c < cols && drawn < count; c++) {
                const x = offX + c * (tileW + spX);
                const y = offY + r * (tileH + spY);
                // Bright tile outline
                octx.strokeStyle = drawn === 0 ? '#facc15' : 'rgba(58,114,165,0.9)';
                octx.lineWidth = 1;
                octx.strokeRect(x + 0.5, y + 0.5, tileW - 1, tileH - 1);
                // Light fill
                octx.fillStyle = 'rgba(58,114,165,0.08)';
                octx.fillRect(x, y, tileW, tileH);
                // Frame number
                octx.fillStyle = 'rgba(255,255,255,0.5)';
                octx.font = `bold ${Math.max(8, Math.min(12, tileW / 4))}px monospace`;
                octx.fillText(drawn + 1, x + 3, y + 12);
                drawn++;
            }
        }

        // Update stats
        modal.querySelector('#ss-st-size').textContent   = `${imgEl.width} × ${imgEl.height}`;
        modal.querySelector('#ss-st-tile').textContent   = `${tileW} × ${tileH}`;
        modal.querySelector('#ss-st-frames').textContent = count;
        modal.querySelector('#ss-footer-msg').textContent = `${count} frames will be imported`;
    }

    // ── Mouse hover info ────────────────────────────────────
    overlayCanvas.addEventListener('mousemove', e => {
        if (!imgEl) return;
        const p = _getSliceParams();
        if (!p) return;
        const rect = overlayCanvas.getBoundingClientRect();
        const mx = (e.clientX - rect.left) * (imgEl.width  / rect.width);
        const my = (e.clientY - rect.top)  * (imgEl.height / rect.height);
        const col = Math.floor((mx - p.offX) / (p.tileW + p.spX));
        const row = Math.floor((my - p.offY) / (p.tileH + p.spY));
        if (col >= 0 && col < p.cols && row >= 0 && row < p.rows) {
            const idx = row * p.cols + col;
            modal.querySelector('#ss-hover-info').textContent =
                idx < p.count ? `Frame ${idx + 1}  (col ${col + 1}, row ${row + 1})` : '';
        } else {
            modal.querySelector('#ss-hover-info').textContent = '';
        }
    });

    // ── Slice & import ──────────────────────────────────────
    modal.querySelector('#ss-slice-btn').addEventListener('click', async () => {
        const p = _getSliceParams();
        if (!p || !imgEl) return;
        const { tileW, tileH, cols, rows, count, offX, offY, spX, spY } = p;

        const btn = modal.querySelector('#ss-slice-btn');
        btn.textContent = 'Slicing…';
        btn.disabled = true;

        // Slice on an offscreen canvas
        const offscreen = document.createElement('canvas');
        offscreen.width  = tileW;
        offscreen.height = tileH;
        const offCtx = offscreen.getContext('2d');

        const frames = [];
        let idx = 0;
        for (let r = 0; r < rows && idx < count; r++) {
            for (let c = 0; c < cols && idx < count; c++) {
                const sx = offX + c * (tileW + spX);
                const sy = offY + r * (tileH + spY);
                offCtx.clearRect(0, 0, tileW, tileH);
                offCtx.drawImage(imgEl, sx, sy, tileW, tileH, 0, 0, tileW, tileH);
                frames.push({
                    id:      'frame_ss_' + Date.now() + '_' + idx,
                    name:    `frame_${idx}`,
                    dataURL: offscreen.toDataURL('image/png'),
                });
                idx++;
                // Yield to keep UI responsive every 32 frames
                if (idx % 32 === 0) await new Promise(r => setTimeout(r, 0));
            }
        }

        // Inject into target animation
        const animIdx = parseInt(modal.querySelector('#ss-anim-select').value);
        const anim = obj.animations[animIdx];
        if (!anim) { btn.textContent = 'Slice & Import Frames'; btn.disabled = false; return; }

        const replace = modal.querySelector('#ss-replace-check').checked;
        if (replace) {
            anim.frames = frames;
        } else {
            anim.frames.push(...frames);
        }

        // Also update idle frame if this is the idle anim and obj is image
        if (anim.isIdle && frames.length > 0) {
            // Keep first frame as idle reference
        }

        // Log to console
        const cons = document.getElementById('console-output') || document.getElementById('tab-console');
        if (cons) {
            const l = document.createElement('div');
            l.style.color = '#4ade80';
            l.textContent = `✂ Sliced "${anim.name}": ${frames.length} frames from ${imgEl.width}×${imgEl.height} sheet`;
            cons.appendChild(l); cons.scrollTop = cons.scrollHeight;
        }

        // Refresh hierarchy (idle frame thumbnail may update)
        import('./engine.ui.js').then(m => m.refreshHierarchy());

        // If animator is open, refresh it
        const animModal = document.getElementById('anim-editor-modal');
        if (animModal) {
            import('./engine.animator.js').then(m => m.openAnimationEditor(obj));
        }

        closeModal();
    });
}

function _populateAnimSelect(modal, obj) {
    const sel = modal.querySelector('#ss-anim-select');
    sel.innerHTML = '';
    obj.animations.forEach((a, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = a.name + (a.isIdle ? ' (Idle)' : '');
        if (i === obj.activeAnimIndex) opt.selected = true;
        sel.appendChild(opt);
    });
    // Option to create new anim
    const newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.textContent = '+ New Animation';
    sel.appendChild(newOpt);

    sel.addEventListener('change', () => {
        if (sel.value === '__new__') {
            const name = prompt('Animation name:', 'Walk') || 'Animation';
            const anim = {
                id: 'anim_' + Date.now() + '_' + Math.random().toString(36).slice(2),
                name, fps: 12, loop: true, isIdle: false, frames: [],
            };
            obj.animations.push(anim);
            obj.activeAnimIndex = obj.animations.length - 1;
            _populateAnimSelect(modal, obj);
        }
    });
}
