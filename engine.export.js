/* ============================================================
   Zengine — engine.export.js
   Exports the current project as a standalone playable game zip.
   The export contains:
     /index.html          ← game entry point (no editor UI)
     /engine.*.js         ← all engine modules
     /assets/             ← all project assets embedded as data URLs
     /game/               ← all user scripts
   The exported game auto-starts play mode on load, runs at full
   resolution, and has no editor panels or toolbar.
   ============================================================ */

import { state } from './engine.state.js';

// ── Public entry ─────────────────────────────────────────────
export async function exportGame() {
    const btn = document.getElementById('btn-export-game');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Building…'; }

    try {
        // 1. Save current scene into its snapshot slot
        await import('./engine.scenes.js').then(m => m._saveCurrentScenePublic?.() ?? _saveViaState());

        // 2. Collect all engine source files
        const engineFiles = [
            'engine.state.js','engine.core.js','engine.renderer.js','engine.scenes.js',
            'engine.objects.js','engine.playmode.js','engine.scripting.js','engine.physics.js',
            'engine.audio.js','engine.input.js','engine.keys.js','engine.animator.js',
            'engine.lights.js','engine.tilemap.js','engine.autotile.js','engine.prefabs.js',
            'engine.transitions.js','engine.console.js','engine.spritesheet.js',
            'engine.collision-overlay.js','engine.defaultscripts.js','engine.history.js',
            'engine.ui.js','engine.project.js','engine.export.js',
        ];

        const fileFetches = await Promise.all(
            engineFiles.map(name =>
                fetch(name)
                    .then(r => r.ok ? r.text() : null)
                    .then(text => text ? { name, text } : null)
                    .catch(() => null)
            )
        );
        const fetchedEngineFiles = fileFetches.filter(Boolean);

        // 3. Collect user scripts from state
        const userScripts = [];
        for (const script of (state.scripts ?? [])) {
            userScripts.push({ name: `game/${script.name}.js`, text: script.code ?? '' });
        }
        // Also collect scripts attached to objects
        for (const obj of (state.gameObjects ?? [])) {
            if (obj.scriptName && !userScripts.find(s => s.name === `game/${obj.scriptName}.js`)) {
                const sc = state.scripts?.find(s => s.name === obj.scriptName);
                if (sc) userScripts.push({ name: `game/${sc.name}.js`, text: sc.code ?? '' });
            }
        }

        // 4. Collect assets (already base64 data URLs in state.assets)
        const assetManifest = (state.assets ?? []).map(a => ({
            id: a.id, name: a.name, type: a.type, dataURL: a.dataURL,
        }));

        // 5. Serialize the full project (all scenes + settings)
        const projectData = {
            scenes:   state.scenes,
            assets:   assetManifest,
            scripts:  state.scripts ?? [],
            prefabs:  state.prefabs ?? [],
            sceneSettings: state.sceneSettings,
            activeSceneIndex: state.activeSceneIndex,
        };

        // 6. Build the runtime game HTML — no editor panels, auto-starts play
        const gameHtml = _buildGameHTML(projectData, fetchedEngineFiles, userScripts);

        // 7. Pack into a zip using JSZip (loaded from CDN or local)
        const zip = await _buildZip(gameHtml, fetchedEngineFiles, userScripts, assetManifest, projectData);

        // 8. Trigger download
        const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        const projectName = (state.projectName ?? 'MyGame').replace(/[^a-zA-Z0-9_-]/g, '_');
        _downloadBlob(blob, `${projectName}_export.zip`);

        import('./engine.console.js').then(m =>
            m.engineLog(`✅ Game exported as "${projectName}_export.zip" — open index.html to play`, 'system')
        );
    } catch (err) {
        import('./engine.console.js').then(m =>
            m.engineLog(`❌ Export failed: ${err.message}`, 'error')
        );
        console.error('[Export]', err);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '📦 Export Game'; }
    }
}

// ── Build the standalone game HTML ───────────────────────────
function _buildGameHTML(projectData, engineFiles, userScripts) {
    // Inline the project data as a JSON blob so the game is fully self-contained.
    const projectJson = JSON.stringify(projectData)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e');

    // List of pixi + matter CDN lines from the original index.html
    // (will be replaced by local copies if available)
    const libs = [
        '<script src="pixi.min.js"></script>',
        '<script src="matter.min.js"></script>',
    ].join('\n    ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>${state.projectName ?? 'My Game'}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html,body { width:100%; height:100%; background:#000; overflow:hidden; }
    #pixi-container { width:100vw; height:100vh; display:block; }
    canvas { display:block; }
  </style>
</head>
<body>
  <div id="pixi-container"></div>
  ${libs}
  <script type="module">
    // ── Injected project data ─────────────────────────────────
    window.__ZENGINE_PROJECT__ = ${projectJson};
    window.__ZENGINE_AUTOPLAY__ = true;

    // ── Boot the engine in game-only mode ─────────────────────
    import('./engine.core.js').then(m => m.startEngine({ gameOnly: true }));
  </script>
</body>
</html>`;
}

// ── Build the zip file ────────────────────────────────────────
async function _buildZip(gameHtml, engineFiles, userScripts, assetManifest, projectData) {
    // Load JSZip — try local first, then CDN
    let JSZip = window.JSZip;
    if (!JSZip) {
        try {
            await _loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
            JSZip = window.JSZip;
        } catch (_) {}
    }

    if (!JSZip) {
        // Fallback: download single-file HTML (no zip)
        _downloadBlob(new Blob([gameHtml], { type: 'text/html' }),
            `${(state.projectName ?? 'MyGame').replace(/[^a-zA-Z0-9_-]/g,'_')}_export.html`);
        import('./engine.console.js').then(m =>
            m.engineLog('ℹ JSZip not available — exported as single HTML file instead. All assets are embedded.', 'warn')
        );
        throw new Error('JSZip not available — single HTML file downloaded instead');
    }

    const zip = new JSZip();

    // Root HTML
    zip.file('index.html', gameHtml);

    // Engine files
    for (const { name, text } of engineFiles) {
        zip.file(name, text);
    }

    // User scripts
    for (const { name, text } of userScripts) {
        zip.file(name, text);
    }

    // Project JSON (for potential hot-reload / editor re-import)
    zip.file('project.json', JSON.stringify(projectData, null, 2));

    // Assets as separate files (already in data URL form — extract binary)
    const assetsFolder = zip.folder('assets');
    for (const asset of assetManifest) {
        if (!asset.dataURL) continue;
        try {
            const [header, b64] = asset.dataURL.split(',');
            if (!b64) continue;
            const mimeMatch = header.match(/data:([^;]+)/);
            const mime      = mimeMatch?.[1] ?? 'application/octet-stream';
            const ext       = _mimeToExt(mime);
            const safeName  = asset.name.replace(/[^a-zA-Z0-9._-]/g, '_');
            const fileName  = safeName.includes('.') ? safeName : `${safeName}.${ext}`;
            assetsFolder.file(fileName, b64, { base64: true });
        } catch (_) {}
    }

    // README
    zip.file('README.txt', [
        `${state.projectName ?? 'My Game'} — exported from Zengine`,
        '='.repeat(50),
        '',
        'HOW TO PLAY:',
        '  1. Extract this zip to a folder',
        '  2. Open index.html in a modern browser',
        '     (Chrome/Edge recommended)',
        '',
        '  Note: Due to browser security, you may need to serve',
        '  the files via a local server rather than opening directly.',
        '  Use: npx serve .   or   python -m http.server 8080',
        '',
        'FILES:',
        '  index.html      Game entry point',
        '  engine.*.js     Engine modules',
        '  game/*.js       Your game scripts',
        '  assets/         All game assets',
        '  project.json    Scene / project data (Zengine re-import)',
        '',
        `Exported: ${new Date().toLocaleString()}`,
    ].join('\n'));

    return zip;
}

// ── Helpers ───────────────────────────────────────────────────
function _saveViaState() {
    // Fallback if _saveCurrentScenePublic isn't exported
    return Promise.resolve();
}

function _downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href  = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

function _loadScript(src) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload  = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
    });
}

function _mimeToExt(mime) {
    const map = {
        'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
        'image/webp': 'webp', 'image/svg+xml': 'svg',
        'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
        'audio/mp4': 'm4a',
    };
    return map[mime] ?? 'bin';
}
