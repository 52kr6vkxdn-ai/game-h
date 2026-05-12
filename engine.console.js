/* ============================================================
   Zengine — engine.console.js
   • Unified log() function used by all engine modules
   • Global JS error / unhandledrejection catcher
   • Floating console overlay (show/hide during play mode)
   • Console level filtering: log | warn | error | system
   ============================================================ */

import { state } from './engine.state.js';

// ── Log levels ────────────────────────────────────────────────
export const LOG  = 'log';
export const WARN = 'warn';
export const ERR  = 'error';
export const SYS  = 'system';

const LEVEL_COLORS = {
    log:    '#9ab8d4',
    warn:   '#facc15',
    error:  '#f87171',
    system: '#4ade80',
};

const LEVEL_ICONS = {
    log:    '›',
    warn:   '⚠',
    error:  '✖',
    system: '●',
};

// ── Internal log buffer (kept for float console sync) ─────────
const _buffer = []; // { level, text, ts, count }[]
const MAX_BUFFER = 500;

// ── Master log function ───────────────────────────────────────
export function engineLog(text, level = LOG) {
    const textStr = String(text);

    // Deduplicate: if the last entry has the same level+text, just increment counter
    const last = _buffer[_buffer.length - 1];
    if (last && last.level === level && last.text === textStr) {
        last.count = (last.count ?? 1) + 1;
        _updateLastEntryCount(document.getElementById('console-output'), last.count);
        _updateLastEntryCount(document.getElementById('float-console-output'), last.count);
        return;
    }

    const entry = { level, text: textStr, ts: performance.now(), count: 1 };

    // Trim buffer
    if (_buffer.length >= MAX_BUFFER) _buffer.shift();
    _buffer.push(entry);

    // Write to main console panel
    _appendToEl(document.getElementById('console-output'), entry);

    // Write to floating console if open
    _appendToEl(document.getElementById('float-console-output'), entry);
}

/** Update the repeat-count badge on the last console row */
function _updateLastEntryCount(container, count) {
    if (!container) return;
    const lastDiv = container.lastElementChild;
    if (!lastDiv) return;
    let badge = lastDiv.querySelector('.console-repeat-badge');
    if (!badge) {
        badge = document.createElement('span');
        badge.className = 'console-repeat-badge';
        badge.style.cssText = [
            'display:inline-block;margin-left:6px;padding:0 5px;',
            'background:rgba(255,255,255,.12);border-radius:8px;',
            'font-size:9px;font-weight:700;line-height:16px;',
            'vertical-align:middle;color:#ccc;',
        ].join('');
        // Insert after the first text node
        const firstLine = lastDiv.firstElementChild ?? lastDiv;
        firstLine.appendChild(badge);
    }
    badge.textContent = `×${count}`;
}

function _appendToEl(container, entry) {
    if (!container) return;
    const div = document.createElement('div');
    div.style.cssText = [
        `color:${LEVEL_COLORS[entry.level] ?? '#aaa'};`,
        'line-height:1.6;',
        'padding:2px 2px;',
        'border-bottom:1px solid rgba(255,255,255,.03);',
        'position:relative;',
        entry.level === 'error' ? 'background:rgba(248,113,113,.06);' : '',
        entry.level === 'warn'  ? 'background:rgba(250,204,21,.04);'  : '',
    ].join('');

    // Support multi-line messages (lines separated by \n)
    const icon = LEVEL_ICONS[entry.level] ?? '›';
    const rawText = String(entry.text);
    if (rawText.includes('\n')) {
        const parts = rawText.split('\n');
        parts.forEach((part, i) => {
            const line = document.createElement('div');
            line.style.cssText = i === 0 ? '' : 'padding-left:14px;opacity:0.8;font-size:0.95em;';
            line.textContent = i === 0 ? `${icon} ${part}` : part;
            div.appendChild(line);
        });
    } else {
        div.textContent = `${icon} ${rawText}`;
    }

    // Copy-to-clipboard button (appears on hover via CSS :hover is unavailable inline,
    // so we use mouseenter/leave)
    if (entry.level === 'error' || entry.level === 'warn') {
        const copyBtn = document.createElement('button');
        copyBtn.title = 'Copy error';
        copyBtn.textContent = '⎘';
        copyBtn.style.cssText = [
            'position:absolute;right:4px;top:50%;transform:translateY(-50%);',
            'background:rgba(255,255,255,.08);border:none;border-radius:3px;',
            'color:#666;cursor:pointer;font-size:10px;padding:1px 4px;',
            'display:none;',
        ].join('');
        copyBtn.addEventListener('click', () => {
            navigator.clipboard?.writeText(rawText).catch(() => {});
            copyBtn.textContent = '✓';
            setTimeout(() => { copyBtn.textContent = '⎘'; }, 1200);
        });
        div.addEventListener('mouseenter', () => { copyBtn.style.display = 'block'; });
        div.addEventListener('mouseleave', () => { copyBtn.style.display = 'none'; });
        div.appendChild(copyBtn);
    }

    container.appendChild(div);

    // Auto-scroll if enabled
    const autoScroll = document.getElementById('console-autoscroll');
    if (!autoScroll || autoScroll.checked) {
        container.scrollTop = container.scrollHeight;
    }
}

// ── Global error catcher ─────────────────────────────────────
let _errorsInstalled = false;

export function installGlobalErrorCatchers() {
    if (_errorsInstalled) return;
    _errorsInstalled = true;

    window.addEventListener('error', (e) => {
        // Skip errors that come from within the script editor overlay
        if (e.filename?.includes('ace.min')) return;
        // Skip engine-internal import errors (usually a sign of a missing asset,
        // not a user script bug) — still log them but distinguish clearly.
        const file = _shortFile(e.filename);
        const isEngineFile = file?.startsWith('engine.');
        const tag  = isEngineFile ? '⚙ Engine' : '✖ Uncaught';
        let msg = `${tag}: ${e.message}`;
        if (e.lineno) msg += ` (${file}:${e.lineno})`;
        // Provide a hint for the most common global errors
        if (e.message?.includes('Failed to fetch dynamically imported module')) {
            msg += '\n  💡 A script module failed to load — check your internet connection or reload the page.';
        } else if (e.message?.includes('out of memory')) {
            msg += '\n  💡 The engine ran out of memory. Reduce the number of spawned objects or stop infinite loops.';
        }
        engineLog(msg, ERR);
        // Auto-open console if playing so user sees the error immediately
        if (state.isPlaying) _autoShowConsole();
    });

    window.addEventListener('unhandledrejection', (e) => {
        const reason = e.reason;
        const msg    = reason?.message ?? String(reason);
        let text = `✖ Unhandled promise: ${msg}`;
        // Give a hint for common async failures in scripts
        if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
            text += '\n  💡 A network request failed. Check your connection, or avoid fetch() inside scripts.';
        } else if (msg.includes('AbortError')) {
            text += '\n  💡 An operation was aborted. This is usually harmless on scene switch.';
        } else if (reason?.stack) {
            // Show first useful stack frame
            const frame = reason.stack.split('\n').find(l => l.trim().startsWith('at ') && !l.includes('engine.'));
            if (frame) text += `\n  → ${frame.trim()}`;
        }
        engineLog(text, ERR);
        if (state.isPlaying) _autoShowConsole();
    });
}

function _shortFile(filename) {
    if (!filename) return 'unknown';
    return filename.split('/').pop();
}

function _autoShowConsole() {
    // Switch bottom panel to Console tab
    const consoleBtn = document.getElementById('tab-console-btn');
    if (consoleBtn) consoleBtn.click();
}

// ── Floating Console Overlay ──────────────────────────────────
let _floatEl = null;
let _isDragging = false;
let _dragOX = 0, _dragOY = 0;
let _floatX = null, _floatY = null;

export function openFloatingConsole() {
    if (_floatEl) {
        _floatEl.style.display = _floatEl.style.display === 'none' ? 'flex' : 'none';
        return;
    }

    _floatEl = document.createElement('div');
    _floatEl.id = 'float-console';
    _floatEl.style.cssText = [
        'position:fixed;',
        `bottom:220px;right:20px;`,
        'width:480px;height:280px;',
        'z-index:50000;',
        'display:flex;flex-direction:column;',
        'background:#0c0c0f;border:1px solid #1e2030;border-radius:6px;',
        'box-shadow:0 8px 32px rgba(0,0,0,.8);',
        'font-family:"Fira Code","Cascadia Code",monospace;',
        'resize:both;overflow:hidden;min-width:280px;min-height:120px;',
    ].join('');

    _floatEl.innerHTML = `
        <div id="float-console-header" style="
            display:flex;align-items:center;gap:8px;
            padding:5px 10px;background:#0f1018;border-bottom:1px solid #1a1d28;
            flex-shrink:0;cursor:grab;user-select:none;border-radius:5px 5px 0 0;
        ">
            <svg viewBox="0 0 24 24" style="width:12px;height:12px;fill:none;stroke:#4ade80;stroke-width:2.5;flex-shrink:0;">
                <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
            </svg>
            <span style="color:#4ade80;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;">Console</span>
            <div style="flex:1;"></div>
            <button id="float-console-clear" title="Clear" style="background:none;border:none;color:#444;cursor:pointer;font-size:10px;padding:2px 5px;border-radius:2px;" onmouseenter="this.style.color='#888'" onmouseleave="this.style.color='#444'">Clear</button>
            <select id="float-console-filter" style="background:#0d0d14;color:#666;border:1px solid #1a1d28;border-radius:3px;font-size:9px;padding:1px 4px;cursor:pointer;">
                <option value="all">All</option>
                <option value="log">Log only</option>
                <option value="warn">Warn+</option>
                <option value="error">Errors only</option>
            </select>
            <button id="float-console-minimize" title="Minimize" style="background:none;border:none;color:#444;cursor:pointer;font-size:11px;padding:2px 5px;border-radius:2px;" onmouseenter="this.style.color='#888'" onmouseleave="this.style.color='#444'">—</button>
            <button id="float-console-close" title="Close" style="background:none;border:none;color:#444;cursor:pointer;font-size:12px;padding:2px 5px;border-radius:2px;" onmouseenter="this.style.color='#f87171'" onmouseleave="this.style.color='#444'">✕</button>
        </div>
        <div id="float-console-output" style="flex:1;overflow-y:auto;padding:6px 8px;font-size:11px;line-height:1.6;color:#888;min-height:0;"></div>
    `;

    document.body.appendChild(_floatEl);

    // Populate with existing buffer
    const output = _floatEl.querySelector('#float-console-output');
    for (const entry of _buffer) _appendToEl(output, entry);
    output.scrollTop = output.scrollHeight;

    // ── Drag to move ────────────────────────────────────────────
    const header = _floatEl.querySelector('#float-console-header');
    header.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'SELECT') return;
        _isDragging = true;
        _dragOX = e.clientX - _floatEl.getBoundingClientRect().left;
        _dragOY = e.clientY - _floatEl.getBoundingClientRect().top;
        header.style.cursor = 'grabbing';
        e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
        if (!_isDragging) return;
        const x = Math.max(0, Math.min(window.innerWidth  - 100, e.clientX - _dragOX));
        const y = Math.max(0, Math.min(window.innerHeight - 40,  e.clientY - _dragOY));
        _floatEl.style.left   = x + 'px';
        _floatEl.style.top    = y + 'px';
        _floatEl.style.right  = 'auto';
        _floatEl.style.bottom = 'auto';
    });
    window.addEventListener('mouseup', () => {
        _isDragging = false;
        header.style.cursor = 'grab';
    });

    // ── Minimize ────────────────────────────────────────────────
    let _minimized = false;
    _floatEl.querySelector('#float-console-minimize').addEventListener('click', () => {
        _minimized = !_minimized;
        output.style.display = _minimized ? 'none' : 'block';
        _floatEl.style.resize = _minimized ? 'none' : 'both';
        _floatEl.querySelector('#float-console-minimize').textContent = _minimized ? '□' : '—';
    });

    // ── Close ───────────────────────────────────────────────────
    _floatEl.querySelector('#float-console-close').addEventListener('click', () => {
        _floatEl.style.display = 'none';
    });

    // ── Clear ───────────────────────────────────────────────────
    _floatEl.querySelector('#float-console-clear').addEventListener('click', () => {
        output.innerHTML = '<div style="color:#333;font-size:10px;font-style:italic;">Cleared</div>';
        _buffer.length = 0;
        const mainOut = document.getElementById('console-output');
        if (mainOut) mainOut.innerHTML = '<div style="color:#333;font-size:10px;font-style:italic;">Cleared</div>';
    });

    // ── Filter ──────────────────────────────────────────────────
    _floatEl.querySelector('#float-console-filter').addEventListener('change', (e) => {
        const f = e.target.value;
        output.innerHTML = '';
        const filtered = f === 'all'   ? _buffer :
                         f === 'error' ? _buffer.filter(b => b.level === 'error') :
                         f === 'warn'  ? _buffer.filter(b => b.level === 'warn' || b.level === 'error') :
                                         _buffer.filter(b => b.level === 'log');
        for (const entry of filtered) _appendToEl(output, entry);
        output.scrollTop = output.scrollHeight;
    });
}

// Auto-show floating console when play starts (if it was previously opened)
export function onPlayStart() {
    if (_floatEl) _floatEl.style.display = 'flex';
}

// ── Play mode console badge in the toolbar ────────────────────
// Shows a small pulsing badge on the Console tab button when there are errors during play
let _errorCountDuringPlay = 0;

export function resetPlayErrors() {
    _errorCountDuringPlay = 0;
    _updateErrorBadge();
}

export function recordPlayError() {
    _errorCountDuringPlay++;
    _updateErrorBadge();
    _autoShowConsole();
}

function _updateErrorBadge() {
    const btn = document.getElementById('tab-console-btn');
    if (!btn) return;
    let badge = btn.querySelector('.console-err-badge');
    if (_errorCountDuringPlay === 0) {
        badge?.remove();
        return;
    }
    if (!badge) {
        badge = document.createElement('span');
        badge.className = 'console-err-badge';
        badge.style.cssText = 'background:#f87171;color:#000;border-radius:8px;font-size:8px;font-weight:700;padding:0 4px;margin-left:4px;line-height:14px;display:inline-block;';
        btn.appendChild(badge);
    }
    badge.textContent = _errorCountDuringPlay > 9 ? '9+' : String(_errorCountDuringPlay);
}
