/* ============================================================
   Zengine — engine.prefabs.js  (v2 — Unity/GDevelop inspired)
   ============================================================ */

import { state } from './engine.state.js';

export function saveAsPrefab(obj) {
    if (!obj) return null;
    const prefab = {
        id:        'prefab_' + Date.now() + '_' + Math.random().toString(36).slice(2),
        name:      obj.label || 'Prefab',
        shapeKey:  obj.shapeKey  || 'square',
        isImage:   obj.isImage   || false,
        assetId:   obj.assetId   || null,
        tint:      obj.spriteGraphic?.tint ?? 0xFFFFFF,
        // NOTE: rotation and scale are intentionally NOT stored in the prefab template.
        // Each instance manages its own rotation and scale independently.
        animations:      obj.animations ? JSON.parse(JSON.stringify(obj.animations)) : [],
        activeAnimIndex: obj.activeAnimIndex || 0,
        // ── Physics / collision ─────────────────────────────────
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
        physicsSize:             obj.physicsSize     ? JSON.parse(JSON.stringify(obj.physicsSize))     : null,
        physicsPolygon:          obj.physicsPolygon  ? JSON.parse(JSON.stringify(obj.physicsPolygon))  : null,
        physicsPolygons:         obj.physicsPolygons ? JSON.parse(JSON.stringify(obj.physicsPolygons)) : null,
        _polyUnit:               obj._polyUnit || null,
        _collisionShapeInit:     !!obj._collisionShapeInit,
        // ───────────────────────────────────────────────────────
        thumbnail:       _generateThumbnail(obj),
        createdAt:       Date.now(),
    };
    state.prefabs.push(prefab);
    obj.prefabId = prefab.id;
    refreshPrefabPanel();
    return prefab;
}

export async function instantiatePrefab(prefab, x = 0, y = 0) {
    const { createImageObject } = await import('./engine.objects.js');
    let obj;
    if (prefab.isImage && prefab.assetId) {
        const asset = state.assets.find(a => a.id === prefab.assetId);
        if (!asset) return null;
        obj = createImageObject(asset, x, y);
    } else {
        return null; // no shape fallback — prefabs must be image-based
    }
    if (!obj) return null;
    _applyPrefabDataToInstance(prefab, obj);
    obj.prefabId = prefab.id;
    if (state._bindGizmoHandles) state._bindGizmoHandles(obj);
    const { refreshHierarchy } = await import('./engine.ui.js');
    refreshHierarchy();
    return obj;
}

function _applyPrefabDataToInstance(prefab, obj, { includeAnims = true } = {}) {
    obj.label = prefab.name;
    if (obj.spriteGraphic?.tint !== undefined) obj.spriteGraphic.tint = prefab.tint;
    // Rotation and scale are NEVER copied from prefab — each instance is independent
    if (includeAnims && prefab.animations?.length) {
        obj.animations      = JSON.parse(JSON.stringify(prefab.animations));
        obj.activeAnimIndex = prefab.activeAnimIndex || 0;
    }
    // ── Physics / collision ──────────────────────────────────────
    if (prefab.physicsBody && prefab.physicsBody !== 'none') {
        obj.physicsBody             = prefab.physicsBody;
        obj.physicsFriction         = prefab.physicsFriction         ?? 0.3;
        obj.physicsRestitution      = prefab.physicsRestitution      ?? 0.1;
        obj.physicsDensity          = prefab.physicsDensity          ?? 0.001;
        obj.physicsGravityScale     = prefab.physicsGravityScale     ?? 1;
        obj.physicsLinearDamping    = prefab.physicsLinearDamping    ?? 0;
        obj.physicsAngularDamping   = prefab.physicsAngularDamping   ?? 0;
        obj.physicsFixedRotation    = !!prefab.physicsFixedRotation;
        obj.physicsIsSensor         = !!prefab.physicsIsSensor;
        obj.physicsCollisionCategory = prefab.physicsCollisionCategory ?? 1;
        obj.physicsCollisionMask    = prefab.physicsCollisionMask    ?? 0xFFFFFFFF;
        obj.physicsShape            = prefab.physicsShape            ?? 'box';
        obj.physicsSize             = prefab.physicsSize     ? JSON.parse(JSON.stringify(prefab.physicsSize))     : null;
        obj.physicsPolygon          = prefab.physicsPolygon  ? JSON.parse(JSON.stringify(prefab.physicsPolygon))  : null;
        obj.physicsPolygons         = prefab.physicsPolygons ? JSON.parse(JSON.stringify(prefab.physicsPolygons)) : null;
        obj._polyUnit               = prefab._polyUnit || null;
        obj._collisionShapeInit     = !!prefab._collisionShapeInit;
    }
}

export function applyInstanceToPrefab(obj) {
    if (!obj?.prefabId) return;
    const prefab = state.prefabs.find(p => p.id === obj.prefabId);
    if (!prefab) return;
    prefab.tint            = obj.spriteGraphic?.tint ?? 0xFFFFFF;
    // rotation and scale are NOT stored — instances are independent
    prefab.name            = obj.label;
    prefab.animations      = obj.animations ? JSON.parse(JSON.stringify(obj.animations)) : [];
    prefab.activeAnimIndex = obj.activeAnimIndex || 0;
    // ── Physics / collision ──────────────────────────────────────
    prefab.physicsBody             = obj.physicsBody             ?? 'none';
    prefab.physicsFriction         = obj.physicsFriction         ?? 0.3;
    prefab.physicsRestitution      = obj.physicsRestitution      ?? 0.1;
    prefab.physicsDensity          = obj.physicsDensity          ?? 0.001;
    prefab.physicsGravityScale     = obj.physicsGravityScale     ?? 1;
    prefab.physicsLinearDamping    = obj.physicsLinearDamping    ?? 0;
    prefab.physicsAngularDamping   = obj.physicsAngularDamping   ?? 0;
    prefab.physicsFixedRotation    = !!obj.physicsFixedRotation;
    prefab.physicsIsSensor         = !!obj.physicsIsSensor;
    prefab.physicsCollisionCategory = obj.physicsCollisionCategory ?? 1;
    prefab.physicsCollisionMask    = obj.physicsCollisionMask    ?? 0xFFFFFFFF;
    prefab.physicsShape            = obj.physicsShape            ?? 'box';
    prefab.physicsSize             = obj.physicsSize     ? JSON.parse(JSON.stringify(obj.physicsSize))     : null;
    prefab.physicsPolygon          = obj.physicsPolygon  ? JSON.parse(JSON.stringify(obj.physicsPolygon))  : null;
    prefab.physicsPolygons         = obj.physicsPolygons ? JSON.parse(JSON.stringify(obj.physicsPolygons)) : null;
    prefab._polyUnit               = obj._polyUnit || null;
    prefab._collisionShapeInit     = !!obj._collisionShapeInit;
    // ────────────────────────────────────────────────────────────
    prefab.thumbnail       = _generateThumbnail(obj);
    refreshPrefabPanel();
    _logConsole(`✔ Prefab "${prefab.name}" updated from this instance`, '#8f8');
}

export async function applyPrefabToAll(prefabId, sourceObj = null) {
    const prefab = state.prefabs.find(p => p.id === prefabId);
    if (!prefab) return;
    if (sourceObj) {
        prefab.tint            = sourceObj.spriteGraphic?.tint ?? 0xFFFFFF;
        // rotation and scale are NOT stored — instances are independent
        prefab.name            = sourceObj.label;
        prefab.animations      = sourceObj.animations ? JSON.parse(JSON.stringify(sourceObj.animations)) : [];
        prefab.activeAnimIndex = sourceObj.activeAnimIndex || 0;
        // ── Physics / collision ──────────────────────────────────
        prefab.physicsBody             = sourceObj.physicsBody             ?? 'none';
        prefab.physicsFriction         = sourceObj.physicsFriction         ?? 0.3;
        prefab.physicsRestitution      = sourceObj.physicsRestitution      ?? 0.1;
        prefab.physicsDensity          = sourceObj.physicsDensity          ?? 0.001;
        prefab.physicsGravityScale     = sourceObj.physicsGravityScale     ?? 1;
        prefab.physicsLinearDamping    = sourceObj.physicsLinearDamping    ?? 0;
        prefab.physicsAngularDamping   = sourceObj.physicsAngularDamping   ?? 0;
        prefab.physicsFixedRotation    = !!sourceObj.physicsFixedRotation;
        prefab.physicsIsSensor         = !!sourceObj.physicsIsSensor;
        prefab.physicsCollisionCategory = sourceObj.physicsCollisionCategory ?? 1;
        prefab.physicsCollisionMask    = sourceObj.physicsCollisionMask    ?? 0xFFFFFFFF;
        prefab.physicsShape            = sourceObj.physicsShape            ?? 'box';
        prefab.physicsSize             = sourceObj.physicsSize     ? JSON.parse(JSON.stringify(sourceObj.physicsSize))     : null;
        prefab.physicsPolygon          = sourceObj.physicsPolygon  ? JSON.parse(JSON.stringify(sourceObj.physicsPolygon))  : null;
        prefab.physicsPolygons         = sourceObj.physicsPolygons ? JSON.parse(JSON.stringify(sourceObj.physicsPolygons)) : null;
        prefab._polyUnit               = sourceObj._polyUnit || null;
        prefab._collisionShapeInit     = !!sourceObj._collisionShapeInit;
        // ────────────────────────────────────────────────────────
        prefab.thumbnail       = _generateThumbnail(sourceObj);
    }
    let count = 0;
    for (const obj of state.gameObjects) {
        if (obj.prefabId !== prefabId) continue;
        _applyPrefabDataToInstance(prefab, obj, { includeAnims: true });
        count++;
    }
    for (const scene of state.scenes) {
        if (!scene.snapshot?.objects) continue;
        for (const s of scene.snapshot.objects) {
            if (s.prefabId !== prefabId) continue;
            s.tint            = prefab.tint;
            s.animations      = JSON.parse(JSON.stringify(prefab.animations));
            s.activeAnimIndex = prefab.activeAnimIndex;
            // ── Physics / collision ──────────────────────────────
            s.physicsBody             = prefab.physicsBody;
            s.physicsFriction         = prefab.physicsFriction;
            s.physicsRestitution      = prefab.physicsRestitution;
            s.physicsDensity          = prefab.physicsDensity;
            s.physicsGravityScale     = prefab.physicsGravityScale;
            s.physicsLinearDamping    = prefab.physicsLinearDamping;
            s.physicsAngularDamping   = prefab.physicsAngularDamping;
            s.physicsFixedRotation    = prefab.physicsFixedRotation;
            s.physicsIsSensor         = prefab.physicsIsSensor;
            s.physicsCollisionCategory = prefab.physicsCollisionCategory;
            s.physicsCollisionMask    = prefab.physicsCollisionMask;
            s.physicsShape            = prefab.physicsShape;
            s.physicsSize             = prefab.physicsSize     ? JSON.parse(JSON.stringify(prefab.physicsSize))     : null;
            s.physicsPolygon          = prefab.physicsPolygon  ? JSON.parse(JSON.stringify(prefab.physicsPolygon))  : null;
            s.physicsPolygons         = prefab.physicsPolygons ? JSON.parse(JSON.stringify(prefab.physicsPolygons)) : null;
            s._polyUnit               = prefab._polyUnit;
            s._collisionShapeInit     = prefab._collisionShapeInit;
            // ────────────────────────────────────────────────────
            count++;
        }
    }
    refreshPrefabPanel();
    const { syncPixiToInspector, refreshHierarchy } = await import('./engine.ui.js');
    syncPixiToInspector();
    refreshHierarchy();
    _logConsole(`🔄 Prefab "${prefab.name}" → ${count} instance${count !== 1 ? 's' : ''} updated`, '#4ade80');
}

export function deletePrefab(prefabId) {
    const idx = state.prefabs.findIndex(p => p.id === prefabId);
    if (idx === -1) return;
    state.prefabs.splice(idx, 1);
    for (const obj of state.gameObjects) {
        if (obj.prefabId === prefabId) obj.prefabId = null;
    }
    refreshPrefabPanel();
}

export function renamePrefab(prefabId, name) {
    const p = state.prefabs.find(p => p.id === prefabId);
    if (p) { p.name = name; refreshPrefabPanel(); }
}

export function unlinkFromPrefab(obj) {
    if (!obj) return;
    const prefabName = state.prefabs.find(p => p.id === obj.prefabId)?.name || '';
    obj.prefabId = null;
    import('./engine.ui.js').then(m => m.syncPixiToInspector());
    _logConsole(`↗ Unlinked from prefab "${prefabName}"`, '#facc15');
}

export function refreshPrefabPanel() {
    const grid = document.getElementById('prefab-grid');
    if (!grid) return;
    grid.innerHTML = '';

    if (!state.prefabs.length) {
        grid.innerHTML = `<div style="color:#555;font-style:italic;padding:16px;font-size:11px;text-align:center;width:100%;"><div style="font-size:24px;margin-bottom:8px;">📦</div>No prefabs yet.<br>Select an object → <strong style="color:#9bc">Save as Prefab</strong></div>`;
        return;
    }

    for (const prefab of state.prefabs) {
        const instanceCount = state.gameObjects.filter(o => o.prefabId === prefab.id).length;
        const hasAnims = prefab.animations?.some(a => a.frames?.length > 0);

        const item = document.createElement('div');
        item.draggable = true;
        item.dataset.prefabId = prefab.id;
        item.className = 'asset-item'; item.style.cssText = 'position:relative;width:88px;';
        item.title = `${prefab.name}\n${instanceCount} instance(s) in scene · Drag to place`;

        const thumb = document.createElement('div');
        thumb.className = 'asset-thumb'; thumb.style.cssText = 'width:60px;height:60px;position:relative;';
        if (prefab.thumbnail) {
            const img = document.createElement('img');
            img.src = prefab.thumbnail;
            img.style.cssText = 'width:100%;height:100%;object-fit:contain;';
            thumb.appendChild(img);
        } else {
            thumb.innerHTML = '<svg viewBox="0 0 24 24" style="width:28px;height:28px;fill:none;stroke:#3A72A5;stroke-width:1.5;"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="#3A72A5"/><path d="M21 15l-5-5L5 21"/></svg>';
        }
        if (hasAnims) {
            const animBadge = document.createElement('div');
            animBadge.style.cssText = 'position:absolute;bottom:2px;right:2px;background:#1e3a1e;border:1px solid #2a6a2a;color:#8f8;font-size:7px;padding:1px 3px;border-radius:2px;';
            animBadge.textContent = '▶';
            thumb.appendChild(animBadge);
        }
        item.appendChild(thumb);

        const nameEl = document.createElement('span');
        nameEl.textContent = prefab.name.length > 12 ? prefab.name.slice(0,11)+'…' : prefab.name;
        nameEl.title = prefab.name;
        nameEl.className = 'asset-name';
        item.appendChild(nameEl);

        if (instanceCount > 0) {
            const badge = document.createElement('div');
            badge.style.cssText = 'font-size:9px;color:#4a7a9a;background:#141e2a;border:1px solid #1e3040;border-radius:8px;padding:1px 6px;';
            badge.textContent = `×${instanceCount}`;
            item.appendChild(badge);
        }

        const pfLabel = document.createElement('div');
        pfLabel.style.cssText = 'position:absolute;top:2px;left:2px;background:#1e3050;border:1px solid #3A72A5;color:#9bc;font-size:7px;padding:1px 3px;border-radius:2px;letter-spacing:0.5px;';
        pfLabel.textContent = 'PREFAB';
        item.appendChild(pfLabel);

        const delBtn = document.createElement('button');
        delBtn.textContent = '✕';
        delBtn.title = 'Delete prefab';
        delBtn.style.cssText = 'position:absolute;top:2px;right:2px;background:#3a1a1a;border:1px solid #6a2a2a;color:#f88;border-radius:2px;width:15px;height:15px;cursor:pointer;font-size:9px;display:none;align-items:center;justify-content:center;padding:0;line-height:1;';
        item.appendChild(delBtn);

        item.addEventListener('mouseenter', () => {
            item.style.transform='translateY(-1px)'; delBtn.style.display='flex';
        });
        item.addEventListener('mouseleave', () => {
            item.style.transform=''; delBtn.style.display='none';
        });

        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (instanceCount > 0 && !confirm(`Delete prefab "${prefab.name}"?\n${instanceCount} instance(s) will be unlinked.`)) return;
            deletePrefab(prefab.id);
        });

        nameEl.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            const inp = document.createElement('input');
            inp.type='text'; inp.value=prefab.name;
            inp.style.cssText='background:#1e1e1e;border:1px solid #3A72A5;color:#fff;font-size:10px;padding:1px 3px;width:80px;border-radius:2px;outline:none;text-align:center;';
            nameEl.replaceWith(inp);
            inp.focus(); inp.select();
            const commit=()=>renamePrefab(prefab.id,inp.value.trim()||prefab.name);
            inp.addEventListener('blur',commit);
            inp.addEventListener('keydown',ev=>{if(ev.key==='Enter')inp.blur();ev.stopPropagation();});
        });

        item.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('prefabId', prefab.id);
            e.dataTransfer.effectAllowed = 'copy';
            item.style.opacity = '0.5';
        });
        item.addEventListener('dragend', () => { item.style.opacity='1'; });

        grid.appendChild(item);
    }
}

function _shapeIcon(k) {
    return ({square:'■',circle:'●',triangle:'▲',diamond:'◆',pentagon:'⬠',hexagon:'⬡',star:'★',capsule:'▬',rightTriangle:'◤',arrow:'↑'})[k]||'■';
}

function _generateThumbnail(obj) {
    try {
        const renderer = state.app?.renderer;
        if (!renderer) return null;
        const bounds = obj.getBounds();
        if (bounds.width < 1 || bounds.height < 1) return null;
        const tex    = renderer.generateTexture(obj,{resolution:1,region:bounds});
        const canvas = renderer.plugins.extract.canvas(tex);
        const out    = document.createElement('canvas');
        out.width=out.height=60;
        const ctx=out.getContext('2d');
        const s=Math.min(56/canvas.width,56/canvas.height);
        ctx.drawImage(canvas,(60-canvas.width*s)/2,(60-canvas.height*s)/2,canvas.width*s,canvas.height*s);
        tex.destroy(true);
        return out.toDataURL();
    } catch(_){return null;}
}

function _logConsole(msg,color='#aaa'){
    const c=document.getElementById('console-output') || document.getElementById('tab-console');
    if(!c)return;
    const l=document.createElement('div');
    l.style.color=color; l.textContent=msg;
    c.appendChild(l); c.scrollTop=c.scrollHeight;
}
