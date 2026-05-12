/* ============================================================
   Zengine — engine.physics.js  (PLANCK.JS BACKEND)
   Physics backend replaced: Matter.js → Planck.js
   All exported APIs and object interfaces unchanged.
   ============================================================ */

import { state } from './engine.state.js';
import {
    collisionGeom, rawSpriteSize,
    tileAlphaBoundsForAsset, unionTileAlphaBounds,
} from './engine.collision-overlay.js';

const PLANCK_CDN = 'https://cdn.jsdelivr.net/npm/planck@1.0.0/dist/planck.min.js';

// px/s² — 980 = 9.8 m/s² with 100 px = 1 m
const GRAVITY_PX = 980;

// ── Module state ───────────────────────────────────────────────
let _world  = null;
let _rafId  = null;
let _bodies     = [];   // { obj, body: planck.Body, type }[]
let _tileBodies = [];   // { body: planck.Body, ownerLabel }[]
const _pendingCollisions  = [];
const _kinematicContacts  = new Map();

// ── Collision event dispatch ──────────────────────────────────
function _fireCollisionEvents() {
    if (_pendingCollisions.length === 0) return;
    const batch = _pendingCollisions.splice(0);
    import('./engine.scripting.js').then(m => {
        for (const { p: pair, type } of batch) {
            const entA = _bodies.find(e => e.body === pair.bodyA);
            const entB = _bodies.find(e => e.body === pair.bodyB);
            if (entA && entB) {
                if (type === 'start') m.triggerCollision(entA.obj, entB.obj);
                else                  m.triggerCollisionEnd(entA.obj, entB.obj);
                continue;
            }
            const spriteEnt = entA || entB;
            if (!spriteEnt) continue;
            const otherBody = spriteEnt === entA ? pair.bodyB : pair.bodyA;
            const tileEnt   = _tileBodies.find(t => t.body === otherBody);
            if (!tileEnt) continue;
            import('./engine.state.js').then(({ state }) => {
                const tileObj = state.gameObjects.find(o => o.label === tileEnt.ownerLabel);
                if (!tileObj) return;
                if (type === 'start') m.triggerCollision(spriteEnt.obj, tileObj);
                else                  m.triggerCollisionEnd(spriteEnt.obj, tileObj);
            });
        }
    });
}

// ── CDN loader ────────────────────────────────────────────────
function _loadPlanck() {
    return new Promise((resolve, reject) => {
        if (window.planck) { resolve(); return; }
        const el = document.getElementById('planck-js-script');
        if (el) {
            el.addEventListener('load',  resolve);
            el.addEventListener('error', () => reject(new Error('Planck.js load failed')));
            return;
        }
        const s  = document.createElement('script');
        s.id     = 'planck-js-script';
        s.src    = PLANCK_CDN;
        s.onload  = resolve;
        s.onerror = () => reject(new Error('Planck.js load failed: ' + PLANCK_CDN));
        document.head.appendChild(s);
    });
}

// ── Size helpers ───────────────────────────────────────────────
function _rawSize(obj) {
    const sg  = obj.spriteGraphic;
    const rs  = obj._runtimeSprite;
    const src = sg || rs;
    if (src?.texture?.orig)  return { w: src.texture.orig.width,  h: src.texture.orig.height };
    if (src?.texture?.width) return { w: src.texture.width,       h: src.texture.height };
    const sx = Math.abs(obj.scale?.x ?? 1) || 1;
    const sy = Math.abs(obj.scale?.y ?? 1) || 1;
    if (src?.width && src?.height) return { w: src.width / sx, h: src.height / sy };
    return { w: 40, h: 40 };
}

function _innerScale(obj) {
    const src = obj.spriteGraphic || obj._runtimeSprite;
    return {
        x: Math.abs(src?.scale?.x ?? 1) || 1,
        y: Math.abs(src?.scale?.y ?? 1) || 1,
    };
}

export function migratePolygonsToContainer(obj) {
    if (!obj || obj._polyUnit === 'container') return;
    const { x: ssx, y: ssy } = _innerScale(obj);
    if (ssx === 1 && ssy === 1) { obj._polyUnit = 'container'; return; }
    if (Array.isArray(obj.physicsPolygon)) {
        obj.physicsPolygon = obj.physicsPolygon.map(p => ({ x: p.x * ssx, y: p.y * ssy }));
    }
    if (obj.physicsPolygons && typeof obj.physicsPolygons === 'object') {
        for (const k in obj.physicsPolygons) {
            const arr = obj.physicsPolygons[k];
            if (Array.isArray(arr)) {
                obj.physicsPolygons[k] = arr.map(p => ({ x: p.x * ssx, y: p.y * ssy }));
            }
        }
    }
    obj._polyUnit = 'container';
}

// ── Active polygon for animated frame ────────────────────────
function _getActivePolygon(obj) {
    migratePolygonsToContainer(obj);
    const map = obj.physicsPolygons;
    if (!map) return obj.physicsPolygon || null;
    if (obj._runtimePhysicsFrameId
        && Array.isArray(map[obj._runtimePhysicsFrameId])
        && map[obj._runtimePhysicsFrameId].length >= 3) {
        return map[obj._runtimePhysicsFrameId];
    }
    const anim    = obj.animations?.[obj.activeAnimIndex ?? 0];
    const frameId = anim?.frames?.[0]?.id;
    if (frameId && Array.isArray(map[frameId]) && map[frameId].length >= 3) return map[frameId];
    if (Array.isArray(map.shared) && map.shared.length >= 3) return map.shared;
    return null;
}

// ── Fixture / body options ────────────────────────────────────
function _bodyOpts(obj) {
    return {
        isSensor:           !!obj.physicsIsSensor,
        friction:           obj.physicsFriction    ?? 0.3,
        restitution:        obj.physicsRestitution ?? 0.1,
        density:            obj.physicsDensity     ?? 0.001,
        filterCategoryBits: (obj.physicsCollisionCategory ?? 0x0001) & 0xFFFF,
        filterMaskBits:     (obj.physicsCollisionMask ?? -1) >>> 0 & 0xFFFF,
    };
}

// ── Get world-space AABB of a Planck body ─────────────────────
function _getPlanckBodyBounds(body) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let f = body.getFixtureList(); f; f = f.getNext()) {
        try {
            const aabb = f.getAABB(0);
            if (aabb.lowerBound.x < minX) minX = aabb.lowerBound.x;
            if (aabb.lowerBound.y < minY) minY = aabb.lowerBound.y;
            if (aabb.upperBound.x > maxX) maxX = aabb.upperBound.x;
            if (aabb.upperBound.y > maxY) maxY = aabb.upperBound.y;
        } catch (_) {}
    }
    if (!isFinite(minX)) {
        const pos = body.getPosition();
        return { min: { x: pos.x - 16, y: pos.y - 16 }, max: { x: pos.x + 16, y: pos.y + 16 } };
    }
    return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

// ── Build a Planck body for a game object ─────────────────────
function _makeBody(obj, cx, cy, bodyType) {
    const P    = window.planck;
    const opts = _bodyOpts(obj);
    const sx   = Math.abs(obj.scale?.x ?? 1) || 1;
    const sy   = Math.abs(obj.scale?.y ?? 1) || 1;
    const g    = collisionGeom(obj);
    const w    = g.w * sx;
    const h    = g.h * sy;
    const r    = g.r * Math.min(sx, sy);
    const ox   = (g.ox || 0) * sx;
    const oy   = (g.oy || 0) * sy;

    // Body positioned at the collider centre (includes rotated offset)
    const rot  = obj.rotation || 0;
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    const bcx  = cx + ox * cosR - oy * sinR;
    const bcy  = cy + ox * sinR + oy * cosR;

    const shape = obj.physicsShape ?? 'box';
    const poly  = _getActivePolygon(obj);

    // kinematic bodies: treated as static + manually teleported each frame
    const isStatic = bodyType === 'static' || bodyType === 'kinematic';

    const body = _world.createBody({
        type:           isStatic ? 'static' : 'dynamic',
        position:       P.Vec2(bcx, bcy),
        angle:          bodyType !== 'static' ? rot : 0,
        linearDamping:  obj.physicsLinearDamping  ?? 0.01,
        angularDamping: obj.physicsAngularDamping ?? 0,
        fixedRotation:  bodyType === 'dynamic' && !!obj.physicsFixedRotation,
        userData:       { label: obj.label },
    });

    const fixDef = {
        density:            bodyType === 'dynamic' ? (opts.density || 0.001) : 0,
        friction:           opts.friction,
        restitution:        opts.restitution,
        isSensor:           opts.isSensor,
        filterCategoryBits: opts.filterCategoryBits,
        filterMaskBits:     opts.filterMaskBits,
        filterGroupIndex:   0,
    };

    if (shape === 'circle') {
        body.createFixture({ ...fixDef, shape: P.Circle(Math.max(r, 2)) });
    } else if (shape === 'capsule') {
        const capW = (obj.physicsSize?.capW ?? g.w) * sx;
        const capH = (obj.physicsSize?.capH ?? g.h) * sy;
        const capR = Math.min(capW, capH) / 2;
        const len  = Math.max(capW, capH) / 2 - capR;
        const capFix = { ...fixDef, density: bodyType === 'dynamic' ? ((opts.density || 0.001) / 3) : 0 };
        try {
            if (capW >= capH) {
                body.createFixture({ ...capFix, shape: P.Box(Math.max(len, 1), Math.max(capH / 2, 1)) });
                body.createFixture({ ...capFix, shape: P.Circle(P.Vec2(len, 0), Math.max(capR, 1)) });
                body.createFixture({ ...capFix, shape: P.Circle(P.Vec2(-len, 0), Math.max(capR, 1)) });
            } else {
                body.createFixture({ ...capFix, shape: P.Box(Math.max(capW / 2, 1), Math.max(len, 1)) });
                body.createFixture({ ...capFix, shape: P.Circle(P.Vec2(0, -len), Math.max(capR, 1)) });
                body.createFixture({ ...capFix, shape: P.Circle(P.Vec2(0,  len), Math.max(capR, 1)) });
            }
        } catch (e) {
            console.warn('[Physics] capsule fixture failed, using box:', e.message);
            body.createFixture({ ...fixDef, shape: P.Box(Math.max(w / 2, 2), Math.max(h / 2, 2)) });
        }
    } else if ((shape === 'polygon' || shape === 'shared') && Array.isArray(poly) && poly.length >= 3) {
        try {
            const verts = poly.slice(0, 8).map(p => P.Vec2(p.x * sx, p.y * sy));
            body.createFixture({ ...fixDef, shape: P.Polygon(verts) });
        } catch (e) {
            console.warn('[Physics] polygon fixture failed, using box:', e.message);
            body.createFixture({ ...fixDef, shape: P.Box(Math.max(w / 2, 2), Math.max(h / 2, 2)) });
        }
    } else {
        body.createFixture({ ...fixDef, shape: P.Box(Math.max(w / 2, 2), Math.max(h / 2, 2)) });
    }

    body._zenOffset = { x: ox, y: oy };
    return body;
}

// ── startPhysics ──────────────────────────────────────────────
export async function startPhysics() {
    if (_world) stopPhysics();
    try { await _loadPlanck(); }
    catch (err) { console.error('[Physics]', err); return; }

    const P = window.planck;
    _world = P.World({ gravity: P.Vec2(0, 0) });
    _bodies           = [];
    _tileBodies.length = 0;
    _kinematicContacts.clear();

    for (const obj of state.gameObjects) {
        // ── Tilemap → one static body per filled cell ────────
        if (obj.isTilemap) {
            const td = obj.tilemapData;
            for (let row = 0; row < td.rows; row++) {
                for (let col = 0; col < td.cols; col++) {
                    const aid = td.tiles[row * td.cols + col];
                    if (!aid) continue;
                    const ab = tileAlphaBoundsForAsset(aid, td.tileW, td.tileH);
                    const cx = obj.x + col * td.tileW + td.tileW / 2 + ab.ox;
                    const cy = obj.y + row * td.tileH + td.tileH / 2 + ab.oy;
                    const tb = _world.createBody({ type: 'static', position: P.Vec2(cx, cy) });
                    tb.createFixture({ shape: P.Box(Math.max(ab.w / 2, 1), Math.max(ab.h / 2, 1)), friction: 0.3, restitution: 0.1 });
                    tb.setUserData({ label: `tm_${obj.label}_${row}_${col}` });
                    tb._zenOffset = { x: 0, y: 0 };
                    _tileBodies.push({ body: tb, ownerLabel: obj.label });
                }
            }
            continue;
        }

        if (obj.isAutoTilemap) {
            const d = obj.autoTileData;
            for (let row = 0; row < d.rows; row++) {
                for (let col = 0; col < d.cols; col++) {
                    const v   = d.cells[row * d.cols + col];
                    const ids = Array.isArray(v) ? v : (v ? [v] : []);
                    if (!ids.length) continue;
                    const ab = unionTileAlphaBounds(ids, d.tileW, d.tileH);
                    const cx = obj.x + col * d.tileW + d.tileW / 2 + ab.ox;
                    const cy = obj.y + row * d.tileH + d.tileH / 2 + ab.oy;
                    const tb = _world.createBody({ type: 'static', position: P.Vec2(cx, cy) });
                    tb.createFixture({ shape: P.Box(Math.max(ab.w / 2, 1), Math.max(ab.h / 2, 1)), friction: 0.3, restitution: 0.1 });
                    tb.setUserData({ label: `at_${obj.label}_${row}_${col}` });
                    tb._zenOffset = { x: 0, y: 0 };
                    _tileBodies.push({ body: tb, ownerLabel: obj.label });
                }
            }
            continue;
        }

        // ── Regular sprite ────────────────────────────────────
        const type = obj.physicsBody || 'none';
        if (type === 'none') continue;

        if (type === 'kinematic') {
            obj._kinematicVx           = 0;
            obj._kinematicVy           = 0;
            obj._pendingKinematicDelta = { x: 0, y: 0 };
            obj._kinematicPrevX        = obj.x;
            obj._kinematicPrevY        = obj.y;
            _kinematicContacts.set(obj, new Set());
            const kBody = _makeBody(obj, obj.x, obj.y, 'kinematic');
            if (kBody) {
                _bodies.push({ obj, body: kBody, type: 'kinematic' });
                obj._physicsBody = kBody;
            } else {
                _bodies.push({ obj, body: null, type: 'kinematic' });
            }
            continue;
        }

        const body = _makeBody(obj, obj.x, obj.y, type);
        if (!body) continue;

        const entry = { obj, body, type };
        _bodies.push(entry);
        obj._physicsBody = body;

        // Per-frame collision shape swap for animated sprites
        const as    = obj._runtimeSprite;
        const anim  = obj.animations?.[obj.activeAnimIndex ?? 0];
        const frArr = anim?.frames;
        if (type !== 'static' && as && as.onFrameChange !== undefined && frArr?.length > 1) {
            obj._runtimePhysicsFrameId = frArr[as.currentFrame ?? 0]?.id || frArr[0].id;
            as.onFrameChange = (idx) => {
                const f = frArr[idx];
                if (!f || obj._runtimePhysicsFrameId === f.id) return;
                obj._runtimePhysicsFrameId = f.id;
                _rebuildBodyForFrame(entry);
            };
        } else if (type !== 'static') {
            const f0 = frArr?.[0];
            if (f0?.id) obj._runtimePhysicsFrameId = f0.id;
        }
    }

    // Wire Planck.js collision events
    _world.on('begin-contact', (contact) => {
        const bodyA = contact.getFixtureA().getBody();
        const bodyB = contact.getFixtureB().getBody();
        _pendingCollisions.push({ p: { bodyA, bodyB }, type: 'start' });
    });
    _world.on('end-contact', (contact) => {
        const bodyA = contact.getFixtureA().getBody();
        const bodyB = contact.getFixtureB().getBody();
        _pendingCollisions.push({ p: { bodyA, bodyB }, type: 'end' });
    });

    _rafId = 1;
}

// ── AABB helpers for kinematic sweep ─────────────────────────
function _getKinematicAABB(obj) {
    const sx = Math.abs(obj.scale?.x ?? 1) || 1;
    const sy = Math.abs(obj.scale?.y ?? 1) || 1;
    const g  = collisionGeom(obj);
    const w  = (g.w || 32) * sx;
    const h  = (g.h || 32) * sy;
    const ox = (g.ox || 0) * sx;
    const oy = (g.oy || 0) * sy;
    return { x: obj.x + ox - w / 2, y: obj.y + oy - h / 2, w, h };
}

// Skin tolerance — prevents false-positive when the body is flush against a surface
const SWEEP_SKIN  = 1;   // px
// Distance to probe below feet to detect ground while standing still
const PROBE_DIST  = 4;   // px

// Axis-separated AABB sweep (X then Y) with skin tolerance and direction flags.
// Returns resolved (x, y) corner plus hit booleans and the list of touched statics.
function _sweepAABB(ax, ay, aw, ah, dx, dy, statics) {
    let x = ax, y = ay;
    let hitX = false, hitY = false;
    let hitDown = false, hitUp = false, hitLeft = false, hitRight = false;
    const hitStatics = [];

    // ── X pass ────────────────────────────────────────────────
    x += dx;
    for (const s of statics) {
        // Require meaningful vertical overlap (inset by SKIN on both sides)
        const overY = (y + ah - SWEEP_SKIN > s.y + SWEEP_SKIN) &&
                      (y + SWEEP_SKIN       < s.y + s.h - SWEEP_SKIN);
        if (!overY) continue;
        if (x + aw - SWEEP_SKIN > s.x && x + SWEEP_SKIN < s.x + s.w) {
            hitX = true;
            if (dx > 0) { x = s.x - aw;      hitRight = true; }
            else        { x = s.x + s.w;      hitLeft  = true; }
            if (!hitStatics.includes(s)) hitStatics.push(s);
        }
    }

    // ── Y pass ────────────────────────────────────────────────
    y += dy;
    for (const s of statics) {
        const overX = (x + aw - SWEEP_SKIN > s.x + SWEEP_SKIN) &&
                      (x + SWEEP_SKIN       < s.x + s.w - SWEEP_SKIN);
        if (!overX) continue;
        if (y + ah - SWEEP_SKIN > s.y && y + SWEEP_SKIN < s.y + s.h) {
            hitY = true;
            if (dy > 0) { y = s.y - ah;       hitDown = true; }
            else        { y = s.y + s.h;       hitUp   = true; }
            if (!hitStatics.includes(s)) hitStatics.push(s);
        }
    }

    return { x, y, hitX, hitY, hitDown, hitUp, hitLeft, hitRight, hitStatics };
}

// Check if there is a solid surface within PROBE_DIST px below the AABB.
// Used to detect ground while standing still (no downward movement this frame).
function _probeGround(aabb, statics) {
    const { x: ax, y: ay, w: aw, h: ah } = aabb;
    for (const s of statics) {
        const overX = (ax + aw - SWEEP_SKIN > s.x + SWEEP_SKIN) &&
                      (ax + SWEEP_SKIN       < s.x + s.w - SWEEP_SKIN);
        if (!overX) continue;
        const gap = s.y - (ay + ah);
        if (gap >= -SWEEP_SKIN && gap <= PROBE_DIST) return true;
    }
    return false;
}

// Static grid for the kinematic AABB sweep.
// excludeObj — the kinematic object currently being swept (excluded to avoid self-collision).
// Includes: tile cells, static-type bodies, other kinematic bodies, non-sensor dynamic bodies.
function _buildStaticGrid(excludeObj = null) {
    const statics = [];

    // 1. Tilemap / auto-tilemap cells (always static)
    for (const t of _tileBodies) {
        const b = _getPlanckBodyBounds(t.body);
        statics.push({
            x: b.min.x, y: b.min.y,
            w: b.max.x - b.min.x,
            h: b.max.y - b.min.y,
            ownerLabel: t.ownerLabel,
        });
    }

    // 2. All non-sensor sprite bodies except the object being swept
    for (const { obj: o, body, type } of _bodies) {
        if (o === excludeObj || !body || o.physicsIsSensor) continue;

        if (type === 'static' || type === 'kinematic') {
            // Use the object's live position — it may have just been updated this frame
            const aabb = _getKinematicAABB(o);
            statics.push({ x: aabb.x, y: aabb.y, w: aabb.w, h: aabb.h, ownerLabel: o.label });
        } else if (type === 'dynamic') {
            // Use Planck body bounds (position from the last physics step)
            const b = _getPlanckBodyBounds(body);
            statics.push({
                x: b.min.x, y: b.min.y,
                w: b.max.x - b.min.x,
                h: b.max.y - b.min.y,
                ownerLabel: o.label,
            });
        }
    }

    return statics;
}

// ── stepPhysics(dt) ───────────────────────────────────────────
export function stepPhysics(dt) {
    if (!_world) return;
    if (state.isPaused) return;

    const P = window.planck;

    // ── KINEMATIC BODIES ──────────────────────────────────────
    // Each kinematic object gets its own static grid (excludes itself so it
    // doesn't self-collide) that includes: tile cells, static sprite bodies,
    // other kinematic bodies, and non-sensor dynamic bodies.
    for (const { obj, body, type } of _bodies) {
        if (type !== 'kinematic') continue;

        // Immovable kinematic: just keep Planck body in sync and stay put
        if (obj.physicsImmovable) {
            obj._kinematicVx           = 0;
            obj._kinematicVy           = 0;
            obj._pendingKinematicDelta = { x: 0, y: 0 };
            obj._kinematicPrevX        = obj.x;
            obj._kinematicPrevY        = obj.y;
            obj._isOnGround  = false;
            obj._isOnCeiling = false;
            obj._isOnWall    = false;
            if (body) {
                const off  = body._zenOffset || { x: 0, y: 0 };
                const cosR = Math.cos(obj.rotation || 0);
                const sinR = Math.sin(obj.rotation || 0);
                body.setTransform(
                    P.Vec2(obj.x + off.x * cosR - off.y * sinR,
                           obj.y + off.x * sinR + off.y * cosR),
                    obj.rotation || 0
                );
            }
            continue;
        }

        // 1. Consume desired velocity / pending delta from scripts
        const vx = obj._kinematicVx ?? 0;
        const vy = obj._kinematicVy ?? 0;
        obj._kinematicVx = 0;
        obj._kinematicVy = 0;
        const pd = obj._pendingKinematicDelta || { x: 0, y: 0 };
        obj._pendingKinematicDelta = { x: 0, y: 0 };

        // directDx/Y: any teleport/position-write done directly by scripts this frame
        const prevX = obj._kinematicPrevX ?? obj.x;
        const prevY = obj._kinematicPrevY ?? obj.y;
        const directDx = obj.x - prevX;
        const directDy = obj.y - prevY;

        // Total desired displacement in px (screen space, +Y = down)
        const dx = vx * dt + pd.x + directDx;
        const dy = vy * dt + pd.y + directDy;

        // 2. Build static grid excluding this object
        const statics = _buildStaticGrid(obj);

        if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) {
            // Not moving this frame — only run the ground probe for isOnGround
            const aabb = _getKinematicAABB(obj);
            obj._isOnGround  = _probeGround(aabb, statics);
            obj._isOnCeiling = false;
            obj._isOnWall    = false;
            obj._kinematicActualVx = 0;
            obj._kinematicActualVy = 0;
            obj._kinematicPrevX = obj.x;
            obj._kinematicPrevY = obj.y;
            if (body) {
                const off  = body._zenOffset || { x: 0, y: 0 };
                const cosR = Math.cos(obj.rotation || 0);
                const sinR = Math.sin(obj.rotation || 0);
                body.setTransform(
                    P.Vec2(obj.x + off.x * cosR - off.y * sinR,
                           obj.y + off.x * sinR + off.y * cosR),
                    obj.rotation || 0
                );
            }
            continue;
        }

        // 3. Reset to last confirmed-safe position before sweeping
        //    (scripts may have written to obj.x/y; directDx captured the delta)
        obj.x = prevX;
        obj.y = prevY;

        // 4–7. Substep the sweep so fast-moving kinematics never tunnel through
        //      dynamic objects. Each substep: sweep a fraction of dx/dy, teleport
        //      the Planck body, run a mini world.step so dynamics get pushed out
        //      incrementally — same SUBSTEPS count used by the main Planck loop.
        const KIN_SUBSTEPS = 3;
        const subDx = dx / KIN_SUBSTEPS;
        const subDy = dy / KIN_SUBSTEPS;
        const subDt = dt / KIN_SUBSTEPS;

        const scX = Math.abs(obj.scale?.x ?? 1) || 1;
        const scY = Math.abs(obj.scale?.y ?? 1) || 1;
        const g   = collisionGeom(obj);
        const ox  = (g.ox || 0) * scX;
        const oy  = (g.oy || 0) * scY;

        let nx = 0, ny = 0;
        let hitX = false, hitY = false;
        let hitDown = false, hitUp = false, hitLeft = false, hitRight = false;
        const hitStatics = [];
        let curAabb = _getKinematicAABB(obj);

        for (let _ks = 0; _ks < KIN_SUBSTEPS; _ks++) {
            // Rebuild static grid each substep — dynamic positions may have shifted
            const subStatics = _buildStaticGrid(obj);
            const res = _sweepAABB(curAabb.x, curAabb.y, curAabb.w, curAabb.h, subDx, subDy, subStatics);

            nx = res.x; ny = res.y;
            if (res.hitX) { hitX = true; hitLeft  = hitLeft  || res.hitLeft;  hitRight = hitRight || res.hitRight; }
            if (res.hitY) { hitY = true; hitDown  = hitDown  || res.hitDown;  hitUp    = hitUp    || res.hitUp; }
            for (const s of res.hitStatics) if (!hitStatics.includes(s)) hitStatics.push(s);

            // Apply sub-resolved position to sprite
            obj.x = nx + curAabb.w / 2 - ox;
            obj.y = ny + curAabb.h / 2 - oy;

            // Teleport Planck body so dynamics are pushed out this substep
            if (body) {
                const off  = body._zenOffset || { x: 0, y: 0 };
                const cosR = Math.cos(obj.rotation || 0);
                const sinR = Math.sin(obj.rotation || 0);
                body.setTransform(
                    P.Vec2(obj.x + off.x * cosR - off.y * sinR,
                           obj.y + off.x * sinR + off.y * cosR),
                    obj.rotation || 0
                );
            }

            // Mini world step — pushes dynamics out of the kinematic body
            _world.step(subDt, 8, 3);

            // After Planck depenetrates, apply velocity to touched dynamic bodies.
            // Planck only corrects position (ejects the body) but gives it no velocity,
            // so without this the dynamic gets pushed out but immediately stops.
            // We add the kinematic's sub-velocity to any dynamic whose AABB overlaps ours.
            if (Math.abs(subDx) > 0.001 || Math.abs(subDy) > 0.001) {
                const kinAabb = _getKinematicAABB(obj);
                // kinematic velocity in Planck units (px → planck: /100? No — engine uses px directly)
                // subDx/subDy are in px, subDt in seconds → velocity in px/s
                const kvx = subDx / Math.max(subDt, 0.001);
                const kvy = subDy / Math.max(subDt, 0.001);
                for (const { body: dynBody, type: dynType, obj: dynObj } of _bodies) {
                    if (dynType !== 'dynamic' || !dynBody || dynObj.physicsIsSensor) continue;
                    const db = _getPlanckBodyBounds(dynBody);
                    // AABB overlap test
                    if (db.max.x < kinAabb.x || db.min.x > kinAabb.x + kinAabb.w) continue;
                    if (db.max.y < kinAabb.y || db.min.y > kinAabb.y + kinAabb.h) continue;
                    // Overlapping — add kinematic velocity to this dynamic body.
                    // Use setLinearVelocity blended with existing velocity so we don't
                    // cancel motion the dynamic already had from gravity/other forces.
                    const cur = dynBody.getLinearVelocity();
                    // Only add velocity components in the direction the kinematic is pushing
                    const newVx = (kvx !== 0) ? kvx : cur.x;
                    const newVy = (kvy !== 0) ? -kvy : cur.y; // Planck Y is flipped
                    dynBody.setLinearVelocity(P.Vec2(newVx, newVy));
                    dynBody.setAwake(true);
                }
            }

            curAabb = _getKinematicAABB(obj);
            if (res.hitX && res.hitY) break; // fully blocked, no need for more substeps
        }

        obj._kinematicPrevX = obj.x;
        obj._kinematicPrevY = obj.y;

        // 6. Ground / wall / ceiling flags
        obj._isOnGround  = hitDown || _probeGround({ x: nx, y: ny, w: curAabb.w, h: curAabb.h }, _buildStaticGrid(obj));
        obj._isOnCeiling = hitUp;
        obj._isOnWall    = hitLeft || hitRight;

        // Track actual velocity (px/s) so physics.velX/velY work for kinematic too
        obj._kinematicActualVx =  (obj.x - prevX) / Math.max(dt, 0.001);
        obj._kinematicActualVy =  (obj.y - prevY) / Math.max(dt, 0.001);

        // 8. Collision events for kinematic ↔ solid surfaces
        if (hitX || hitY) {
            const contacts    = _kinematicContacts.get(obj) || new Set();
            const nowTouching = new Set(hitStatics.map(s => s.ownerLabel).filter(Boolean));
            import('./engine.scripting.js').then(m => {
                for (const label of nowTouching) {
                    if (!contacts.has(label)) {
                        const other = state.gameObjects.find(o => o.label === label);
                        if (other) m.triggerCollision(obj, other);
                    }
                }
                for (const label of contacts) {
                    if (!nowTouching.has(label)) {
                        const other = state.gameObjects.find(o => o.label === label);
                        if (other) m.triggerCollisionEnd(obj, other);
                    }
                }
                _kinematicContacts.set(obj, nowTouching);
            });
        } else {
            const contacts = _kinematicContacts.get(obj);
            if (contacts && contacts.size > 0) {
                import('./engine.scripting.js').then(m => {
                    for (const label of contacts) {
                        const other = state.gameObjects.find(o => o.label === label);
                        if (other) m.triggerCollisionEnd(obj, other);
                    }
                    _kinematicContacts.set(obj, new Set());
                });
            }
        }
    }

    // ── DYNAMIC: apply per-body gravity ───────────────────────
    for (const { obj, body, type } of _bodies) {
        if (type !== 'dynamic' || !body) continue;
        if (body.isStatic()) continue;
        const gravScale = obj.physicsGravityScale ?? 1;
        if (gravScale !== 0) {
            const gy = GRAVITY_PX * 0.001 * gravScale;
            const gx = (obj.physicsGravityXScale ?? 0) * GRAVITY_PX * 0.001;
            body.applyForce(
                P.Vec2(gx * body.getMass(), gy * body.getMass()),
                body.getWorldCenter(),
                true
            );
        }
    }

    // Run Planck in substeps to prevent tunnelling
    const SUBSTEPS = 3;
    const subDt    = dt / SUBSTEPS;
    for (let _s = 0; _s < SUBSTEPS; _s++) {
        _world.step(subDt, 8, 3);
    }

    // ── POST-STEP: sync dynamic body position → sprite ────────
    for (const { obj, body, type } of _bodies) {
        if (type !== 'dynamic' || !body) continue;
        const pos  = body.getPosition();
        const ang  = body.getAngle();
        const off  = body._zenOffset || { x: 0, y: 0 };
        const cosR = Math.cos(ang);
        const sinR = Math.sin(ang);
        obj.x = pos.x - (off.x * cosR - off.y * sinR);
        obj.y = pos.y - (off.x * sinR + off.y * cosR);
        obj.rotation = ang;
    }

    _fireCollisionEvents();
}

// ── stopPhysics ───────────────────────────────────────────────
export function stopPhysics() {
    _rafId = null;
    for (const { obj } of _bodies) {
        const as = obj?._runtimeSprite;
        if (as && as.onFrameChange) as.onFrameChange = null;
        if (obj) {
            delete obj._runtimePhysicsFrameId;
            delete obj._physicsBody;
            delete obj._kinematicVx;
            delete obj._kinematicVy;
            delete obj._kinematicActualVx;
            delete obj._kinematicActualVy;
            delete obj._kinematicPrevX;
            delete obj._kinematicPrevY;
            delete obj._pendingKinematicDelta;
            delete obj._isOnGround;
            delete obj._isOnCeiling;
            delete obj._isOnWall;
        }
    }
    _world  = null;
    _bodies = [];
    _tileBodies.length = 0;
    _kinematicContacts.clear();
    _pendingCollisions.length = 0;
}

// ── Ground / wall / ceiling queries ──────────────────────────
/** Returns true if the kinematic body is currently resting on a floor. */
export function getIsOnGround(obj)   { return !!obj._isOnGround; }
/** Returns true if the kinematic body bumped a ceiling this frame. */
export function getIsOnCeiling(obj)  { return !!obj._isOnCeiling; }
/** Returns true if the kinematic body is pressed against a wall. */
export function getIsOnWall(obj)     { return !!obj._isOnWall; }

// ── rebuildBodyForObject ──────────────────────────────────────
export function rebuildBodyForObject(obj) {
    if (!_world) return;
    const idx = _bodies.findIndex(e => e.obj === obj);
    if (idx !== -1) {
        const { body } = _bodies[idx];
        if (body) { try { _world.destroyBody(body); } catch (_) {} }
        delete obj._physicsBody;
        _bodies.splice(idx, 1);
    }
    _kinematicContacts.delete(obj);

    const type = obj.physicsBody;
    if (!type || type === 'none') return;

    if (type === 'kinematic') {
        obj._kinematicVx           = 0;
        obj._kinematicVy           = 0;
        obj._pendingKinematicDelta = { x: 0, y: 0 };
        obj._kinematicPrevX        = obj.x;
        obj._kinematicPrevY        = obj.y;
        _kinematicContacts.set(obj, new Set());
        const kBody = _makeBody(obj, obj.x, obj.y, 'kinematic');
        if (kBody) {
            _bodies.push({ obj, body: kBody, type: 'kinematic' });
            obj._physicsBody = kBody;
        } else {
            _bodies.push({ obj, body: null, type: 'kinematic' });
        }
        return;
    }

    const body = _makeBody(obj, obj.x, obj.y, type);
    if (!body) return;
    _bodies.push({ obj, body, type });
    obj._physicsBody = body;
}

// ── Rebuild body when animation frame changes ─────────────────
function _rebuildBodyForFrame(entry) {
    if (!_world) return;
    const { obj, body: oldBody, type } = entry;
    if (!oldBody || type === 'kinematic') return;

    const pos    = oldBody.getPosition();
    const vel    = oldBody.getLinearVelocity();
    const angle  = oldBody.getAngle();
    const angVel = oldBody.getAngularVelocity();

    const newBody = _makeBody(obj, pos.x, pos.y, type);
    if (!newBody) return;
    newBody.setTransform(pos, angle);
    if (type !== 'static') {
        newBody.setLinearVelocity(vel);
        newBody.setAngularVelocity(angVel);
    }

    _world.destroyBody(oldBody);
    entry.body       = newBody;
    obj._physicsBody = newBody;
}

// ── Inspector HTML ────────────────────────────────────────────

export function buildPhysicsInspectorHTML(obj) {
    if (obj.isTilemap || obj.isAutoTilemap) {
        return `<div class="component-block" id="inspector-physics-section">
          <div class="component-header">
            <svg viewBox="0 0 24 24" class="comp-icon" style="color:#facc15;fill:none;stroke:currentColor;stroke-width:2;">
              <rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/>
            </svg>
            <span style="font-weight:600;color:#facc15;">Physics</span>
          </div>
          <div class="component-body" style="display:flex;flex-direction:column;gap:5px;">
            <div class="prop-row">
              <span class="prop-label">Body</span>
              <span style="color:#60a5fa;font-size:11px;font-weight:600;">🔵 Static (locked)</span>
            </div>
            <div style="background:#1a1a10;border:1px solid #facc1533;border-radius:3px;padding:4px 6px;font-size:9px;color:#facc1566;">
              Tilemaps are always static colliders — one box per filled tile.
            </div>
          </div>
        </div>`;
    }

    const type   = obj.physicsBody      ?? 'none';
    const fric   = obj.physicsFriction        ?? 0.3;
    const rest   = obj.physicsRestitution     ?? 0.1;
    const dens   = obj.physicsDensity         ?? 0.001;
    const grav   = obj.physicsGravityScale    ?? 1;
    const ldamp  = obj.physicsLinearDamping   ?? 0.01;  // FIX 8: consistent default
    const adamp  = obj.physicsAngularDamping  ?? 0;
    const fixRot  = !!obj.physicsFixedRotation;
    const sensor  = !!obj.physicsIsSensor;
    const immov   = !!obj.physicsImmovable;
    const shape  = obj.physicsShape           ?? 'box';

    const isDynamic   = type === 'dynamic';
    const isKinematic = type === 'kinematic';
    const isStatic    = type === 'static';
    const hasPhysics  = type !== 'none';

    const OPT  = (v, l) => `<option value="${v}" ${type  === v ? 'selected' : ''}>${l}</option>`;
    const SOPT = (v, l) => `<option value="${v}" ${shape === v ? 'selected' : ''}>${l}</option>`;

    const geom   = collisionGeom(obj);
    const psW    = +geom.w.toFixed(1);
    const psH    = +geom.h.toFixed(1);
    const psR    = +geom.r.toFixed(1);
    const psCapW = +(obj.physicsSize?.capW ?? geom.w).toFixed(1);
    const psCapH = +(obj.physicsSize?.capH ?? geom.h).toFixed(1);
    const hasOverride = !!(obj.physicsSize && (obj.physicsSize.w || obj.physicsSize.h || obj.physicsSize.r));

    const typeDescs = {
        none:      '',
        static:    '🔵 Completely immovable. Infinite mass — not affected by gravity, forces, or collisions. Use for floors, walls, and buildings. Dynamic bodies bounce/stop against it; kinematic bodies pass through or collide.',
        kinematic: '🟡 Script-controlled movement. Not affected by gravity or forces. Pushes dynamic bodies; not pushed back. Use for moving platforms, doors, and scripted NPCs. Set velocity via velocityX/Y or move().',
        dynamic:   '🔴 Fully physics-driven. Affected by gravity, forces, and impulses. Reacts realistically to everything. Use for boxes, balls, and falling objects.',
    };

    const anims   = obj.animations || [];
    const frames  = anims.flatMap(a => (a.frames || []).map(f => ({ id: f.id, name: f.name || f.id })));
    const polyMap = obj.physicsPolygons || {};
    const frameTabsHTML = frames.length > 0
        ? `<div style="margin-top:4px;">
            <div style="color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px;">Per-frame shapes</div>
            <div style="display:flex;flex-wrap:wrap;gap:3px;">
              <button class="pe-frame-btn" data-frame="shared"
                style="${_frameBtn(!frames.some(f => (polyMap[f.id]?.length >= 3)), 'shared')}">
                All frames
              </button>
              ${frames.map(f => `
              <button class="pe-frame-btn" data-frame="${f.id}"
                style="${_frameBtn(!!(polyMap[f.id]?.length >= 3), f.id)}">
                ${f.name}
              </button>`).join('')}
            </div>
          </div>`
        : '';

    const sharedSummary = _polySummary(polyMap.shared);

    const sizeEditorsHTML = `
        <div id="phys-box-row" style="display:${shape==='box'?'flex':'none'};flex-direction:column;gap:4px;background:#0a0a18;border:1px solid #1a1a30;border-radius:3px;padding:6px 8px;">
          <div style="color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.06em;">Box size (px)</div>
          <div class="prop-row">
            <span class="prop-label">Width</span>
            <input id="phys-box-w" type="number" min="1" step="1" value="${psW}" style="width:80px;${_inp()}">
          </div>
          <div class="prop-row">
            <span class="prop-label">Height</span>
            <input id="phys-box-h" type="number" min="1" step="1" value="${psH}" style="width:80px;${_inp()}">
          </div>
          <button id="phys-size-reset-box" style="${_btn(hasOverride?'#06b6d4':'#444')}width:100%;font-size:10px;">↻ Auto-fit to sprite</button>
        </div>
        <div id="phys-circle-row" style="display:${shape==='circle'?'flex':'none'};flex-direction:column;gap:4px;background:#0a0a18;border:1px solid #1a1a30;border-radius:3px;padding:6px 8px;">
          <div style="color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.06em;">Radius (px)</div>
          <div class="prop-row">
            <span class="prop-label">Radius</span>
            <input id="phys-circle-r" type="number" min="1" step="1" value="${psR}" style="width:80px;${_inp()}">
          </div>
          <button id="phys-size-reset-circle" style="${_btn(hasOverride?'#06b6d4':'#444')}width:100%;font-size:10px;">↻ Auto-fit to sprite</button>
        </div>
        <div id="phys-capsule-row" style="display:${shape==='capsule'?'flex':'none'};flex-direction:column;gap:4px;background:#0a0a18;border:1px solid #1a1a30;border-radius:3px;padding:6px 8px;">
          <div style="color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.06em;">Capsule size (px)</div>
          <div class="prop-row">
            <span class="prop-label">Width</span>
            <input id="phys-cap-w" type="number" min="1" step="1" value="${psCapW}" style="width:80px;${_inp()}">
          </div>
          <div class="prop-row">
            <span class="prop-label">Height</span>
            <input id="phys-cap-h" type="number" min="1" step="1" value="${psCapH}" style="width:80px;${_inp()}">
          </div>
          <div style="color:#555;font-size:9px;">Pill shape — round ends on the short axis</div>
          <button id="phys-size-reset-capsule" style="${_btn(hasOverride?'#06b6d4':'#444')}width:100%;font-size:10px;">↻ Auto-fit to sprite</button>
        </div>
        <div id="phys-polygon-row" style="display:${shape==='polygon'?'flex':'none'};flex-direction:column;gap:4px;">
          <button id="phys-edit-polygon" style="${_btn('#7c3aed')}width:100%;">✏ Edit Collision Shape</button>
          <button id="phys-autofit" style="${_btn('#06b6d4')}width:100%;margin-top:2px;">🎯 Auto-fit from Sprite</button>
          <div style="color:#666;font-size:9px;text-align:center;">${sharedSummary}</div>
          ${frameTabsHTML}
        </div>
    `;

    const materialHTML = `
        <div style="border-top:1px solid #1a1a30;margin:2px 0;"></div>
        <div style="color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.06em;">Material</div>
        <div class="prop-row">
          <span class="prop-label">Friction</span>
          <input id="phys-friction" type="number" value="${fric}" min="0" max="1" step="0.05" style="width:60px;${_inp()}">
          <span style="color:#555;font-size:9px;">0=ice, 1=sticky</span>
        </div>
        <div class="prop-row">
          <span class="prop-label">Bounce</span>
          <input id="phys-bounce" type="number" value="${rest}" min="0" max="1" step="0.05" style="width:60px;${_inp()}">
          <span style="color:#555;font-size:9px;">0=none, 1=full</span>
        </div>
    `;

    const massHTML = isDynamic ? `
        <div class="prop-row">
          <span class="prop-label">Density</span>
          <input id="phys-density" type="number" value="${dens}" min="0.0001" max="100" step="0.0005" style="width:60px;${_inp()}">
          <span style="color:#555;font-size:9px;">affects mass</span>
        </div>
    ` : '';

    const dampingHTML = isDynamic ? `
        <div style="border-top:1px solid #1a1a30;margin:2px 0;"></div>
        <div style="color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.06em;">Damping</div>
        <div class="prop-row">
          <span class="prop-label">Linear</span>
          <input id="phys-linear-damp" type="number" value="${ldamp}" min="0" max="100" step="0.01" style="width:60px;${_inp()}">
          <span style="color:#555;font-size:9px;">air drag (0.01 default)</span>
        </div>
        <div class="prop-row">
          <span class="prop-label">Angular</span>
          <input id="phys-angular-damp" type="number" value="${adamp}" min="0" max="100" step="0.05" style="width:60px;${_inp()}">
          <span style="color:#555;font-size:9px;">spin drag</span>
        </div>
    ` : '';

    const gravityHTML = isDynamic ? `
        <div style="border-top:1px solid #1a1a30;margin:2px 0;"></div>
        <div style="color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.06em;">Gravity</div>
        <div class="prop-row">
          <span class="prop-label">Scale Y</span>
          <input id="phys-gravity-scale" type="number" value="${grav}" min="0" max="20" step="0.1" style="width:60px;${_inp()}">
          <span style="color:#555;font-size:9px;">0=float, 1=normal</span>
        </div>
        <div style="background:#0a0a18;border:1px solid #1a1a30;border-radius:3px;padding:4px 8px;font-size:9px;color:#4a4a6a;">
          Or in script: <code style="color:#7cb9f0;">velocityY -= 9.8 * dt</code>
        </div>
    ` : '';

    const constraintsHTML = (isDynamic || isKinematic) ? `
        <div style="border-top:1px solid #1a1a30;margin:2px 0;"></div>
        <div style="color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.06em;">Constraints</div>
        <div class="prop-row">
          <span class="prop-label" title="Lock this body in place — nothing can move it">Immovable</span>
          <input id="phys-immovable" type="checkbox" ${immov ? 'checked' : ''} style="width:14px;height:14px;accent-color:#ef4444;cursor:pointer;">
          <span style="color:#555;font-size:9px;">locks position</span>
        </div>
        ${isDynamic ? `
        <div class="prop-row">
          <span class="prop-label" title="Prevent this body from rotating">Fix rotation</span>
          <input id="phys-fixed-rot" type="checkbox" ${fixRot ? 'checked' : ''} style="width:14px;height:14px;accent-color:#facc15;cursor:pointer;">
          <span style="color:#555;font-size:9px;">no spin</span>
        </div>` : ''}
        <div class="prop-row">
          <span class="prop-label" title="Detects overlaps but causes no physics response">Is Sensor</span>
          <input id="phys-sensor" type="checkbox" ${sensor ? 'checked' : ''} style="width:14px;height:14px;accent-color:#facc15;cursor:pointer;">
          <span style="color:#555;font-size:9px;">detect only</span>
        </div>
    ` : (isStatic ? `
        <div style="border-top:1px solid #1a1a30;margin:2px 0;"></div>
        <div style="color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.06em;">Constraints</div>
        <div class="prop-row">
          <span class="prop-label">Is Sensor</span>
          <input id="phys-sensor" type="checkbox" ${sensor ? 'checked' : ''} style="width:14px;height:14px;accent-color:#facc15;cursor:pointer;">
          <span style="color:#555;font-size:9px;">detect only</span>
        </div>
    ` : '');

    const kinematicNote = isKinematic ? `
        <div style="background:#1a1400;border:1px solid #facc1533;border-radius:3px;padding:5px 8px;font-size:9px;color:#facc1588;margin-top:2px;">
            🟡 Kinematic bodies have no gravity or forces.<br>
            Move them via <code style="color:#facc15;">velocityX/Y</code> or <code style="color:#facc15;">move()</code>.<br>
            They push dynamic bodies but are not pushed back.
        </div>` : '';

    const layersHTML = hasPhysics ? `
        <div style="border-top:1px solid #1a1a30;margin:2px 0;"></div>
        <div style="color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.06em;">Collision Layers</div>
        <div class="prop-row">
          <span class="prop-label" title="Bitmask: which layer this body belongs to">Category</span>
          <input id="phys-col-cat" type="number" value="${obj.physicsCollisionCategory ?? 1}" min="1" max="2147483647" step="1" style="width:80px;${_inp()}">
        </div>
        <div class="prop-row">
          <span class="prop-label" title="Bitmask: which layers to collide with (−1 = all)">Mask</span>
          <input id="phys-col-mask" type="number" value="${obj.physicsCollisionMask ?? -1}" min="-2147483648" max="2147483647" step="1" style="width:80px;${_inp()}">
        </div>
    ` : '';

    return `
    <div class="component-block" id="inspector-physics-section">
      <div class="component-header">
        <svg viewBox="0 0 24 24" class="comp-icon" style="color:#facc15;fill:none;stroke:currentColor;stroke-width:2;">
          <circle cx="12" cy="12" r="3"/>
          <path d="M12 2v3M12 19v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M2 12h3M19 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/>
        </svg>
        <span style="font-weight:600;color:#facc15;">Physics</span>
      </div>
      <div class="component-body" style="display:flex;flex-direction:column;gap:6px;">
        <div class="prop-row">
          <span class="prop-label">Body type</span>
          <select id="phys-type" style="${_sel()}">
            ${OPT('none','❌ None')}
            ${OPT('static','🔵 Static')}
            ${OPT('kinematic','🟡 Kinematic')}
            ${OPT('dynamic','🔴 Dynamic')}
          </select>
        </div>
        ${hasPhysics && typeDescs[type] ? `
        <div style="background:${type==='static'?'#0a1020':type==='kinematic'?'#1a1400':'#1a0a0a'};border:1px solid ${type==='static'?'#60a5fa33':type==='kinematic'?'#facc1533':'#f8717133'};border-radius:3px;padding:5px 8px;font-size:9px;color:${type==='static'?'#60a5fa88':type==='kinematic'?'#facc1588':'#f8717188'};line-height:1.5;">
            ${typeDescs[type]}
        </div>` : ''}
        <div id="phys-extra" style="display:${hasPhysics?'flex':'none'};flex-direction:column;gap:5px;">
          <div class="prop-row">
            <span class="prop-label">Shape</span>
            <select id="phys-shape" style="${_sel()}">
              ${SOPT('box','▭ Box')}
              ${SOPT('circle','◯ Circle')}
              ${SOPT('capsule','⬩ Capsule')}
              ${SOPT('polygon','⬡ Polygon')}
            </select>
          </div>
          ${sizeEditorsHTML}
          ${materialHTML}
          ${massHTML}
          ${gravityHTML}
          ${dampingHTML}
          ${constraintsHTML}
          ${kinematicNote}
          ${layersHTML}
          <div style="background:#1a1400;border:1px solid #facc1533;border-radius:3px;padding:4px 6px;font-size:9px;color:#facc1566;margin-top:2px;">
            ▶ Physics runs in Play Mode only
          </div>
          <button id="phys-show-collision" style="${_btn('#facc15')}width:100%;margin-top:2px;font-size:10px;${state.showCollision?'background:#facc1533;':''}">
            ${state.showCollision ? '👁 Hide Collision Shape' : '👁 Show Collision Shape'}
          </button>
        </div>
      </div>
    </div>`;
}

function _frameBtn(hasShape, frameId) {
    const active = hasShape;
    return `background:${active ? '#1a1a30' : '#0a0a18'};border:1px solid ${active ? '#7c3aed' : '#1a1a30'};
            color:${active ? '#a78bfa' : '#555'};border-radius:3px;padding:2px 6px;cursor:pointer;
            font-size:9px;font-weight:${active ? '700' : '400'};`;
}

function _polySummary(poly) {
    return (Array.isArray(poly) && poly.length >= 3)
        ? `${poly.length} vertices defined`
        : 'No shape — draw one below';
}

// ── Auto-fit ──────────────────────────────────────────────────
export function autoFitCollisionShape(obj, onDone) {
    _autoFitCollisionShape(obj, onDone);
}

function _autoFitCollisionShape(obj, onDone) {
    const dataURL = obj.animations?.[obj.activeAnimIndex ?? 0]?.frames?.[0]?.dataURL
                 || obj.spriteGraphic?.texture?.baseTexture?.resource?.source?.src
                 || null;
    if (dataURL) {
        _alphaHullFromDataURL(dataURL, obj, onDone);
    } else {
        const raw = rawSpriteSize(obj);
        if (!obj.physicsPolygons) obj.physicsPolygons = {};
        obj.physicsPolygons.shared = _defaultBox(raw.w, raw.h);
        obj.physicsShape = 'polygon';
        obj._polyUnit = 'container';
        obj.physicsPolygon = obj.physicsPolygons.shared.slice();
        try { onDone?.(); } catch(_) {}
    }
}

function _alphaHullFromDataURL(dataURL, obj, onDone) {
    const img = new Image();
    img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width  = img.naturalWidth  || 64;
        canvas.height = img.naturalHeight || 64;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        try {
            const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
            let hull     = _computeAlphaOBB(pixels, canvas.width, canvas.height);
            if (hull && hull.length >= 3) {
                const { x: ssx, y: ssy } = _innerScale(obj);
                hull = hull.map(p => ({ x: p.x * ssx, y: p.y * ssy }));
                if (!obj.physicsPolygons) obj.physicsPolygons = {};
                obj.physicsPolygons.shared = hull;
                obj.physicsShape  = 'polygon';
                obj.physicsPolygon = hull.slice();
                obj._polyUnit = 'container';
                const firstFrameId = obj.animations?.[obj.activeAnimIndex ?? 0]?.frames?.[0]?.id;
                if (firstFrameId) obj.physicsPolygons[firstFrameId] = hull.slice();
                try { onDone?.(); } catch(_) {}
                return;
            }
        } catch(_) {}
        const raw = rawSpriteSize(obj);
        if (!obj.physicsPolygons) obj.physicsPolygons = {};
        obj.physicsPolygons.shared = _defaultBox(raw.w, raw.h);
        obj.physicsShape = 'polygon';
        obj.physicsPolygon = obj.physicsPolygons.shared.slice();
        obj._polyUnit = 'container';
        const firstFrameId = obj.animations?.[obj.activeAnimIndex ?? 0]?.frames?.[0]?.id;
        if (firstFrameId) obj.physicsPolygons[firstFrameId] = obj.physicsPolygons.shared.slice();
        try { onDone?.(); } catch(_) {}
    };
    img.src = dataURL;
}

function _computeAlphaOBB(imageData, w, h) {
    const data = imageData.data;
    const THRESHOLD = 20;
    let minX = w, maxX = 0, minY = h, maxY = 0, found = false;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (data[(y * w + x) * 4 + 3] > THRESHOLD) {
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                found = true;
            }
        }
    }
    if (!found) return null;
    minX = Math.max(0, minX - 1); minY = Math.max(0, minY - 1);
    maxX = Math.min(w - 1, maxX + 1); maxY = Math.min(h - 1, maxY + 1);
    const cx = w / 2, cy = h / 2;
    return [
        { x: minX - cx, y: minY - cy }, { x: maxX - cx, y: minY - cy },
        { x: maxX - cx, y: maxY - cy }, { x: minX - cx, y: maxY - cy },
    ];
}

// ── Inspector bindings ────────────────────────────────────────
export function bindPhysicsInspector(obj) {
    const typeEl  = document.getElementById('phys-type');
    const extra   = document.getElementById('phys-extra');
    const shapeEl = document.getElementById('phys-shape');
    const polyRow = document.getElementById('phys-polygon-row');
    const editBtn = document.getElementById('phys-edit-polygon');
    const fricEl  = document.getElementById('phys-friction');
    const bnceEl  = document.getElementById('phys-bounce');
    if (!typeEl) return;

    typeEl.addEventListener('change', () => {
        obj.physicsBody = typeEl.value;
        if (typeEl.value !== 'none' && !obj._collisionShapeInit) {
            obj.physicsShape = obj.physicsShape || 'box';
            obj._collisionShapeInit = true;
        }
        _pushUndo();
        import('./engine.ui.js').then(m => m.syncPixiToInspector());
        import('./engine.collision-overlay.js').then(m => m.refreshCollisionOverlay());
    });

    shapeEl?.addEventListener('change', () => {
        obj.physicsShape = shapeEl.value;
        const boxRow     = document.getElementById('phys-box-row');
        const circleRow  = document.getElementById('phys-circle-row');
        const capsuleRow = document.getElementById('phys-capsule-row');
        if (polyRow)     polyRow.style.display    = shapeEl.value === 'polygon' ? 'flex' : 'none';
        if (boxRow)      boxRow.style.display     = shapeEl.value === 'box'     ? 'flex' : 'none';
        if (circleRow)   circleRow.style.display  = shapeEl.value === 'circle'  ? 'flex' : 'none';
        if (capsuleRow)  capsuleRow.style.display = shapeEl.value === 'capsule' ? 'flex' : 'none';
        _pushUndo();
        import('./engine.collision-overlay.js').then(m => {
            if (!state.showCollision) m.setCollisionVisible(true);
            m.refreshCollisionOverlay();
        });
    });

    const capW = document.getElementById('phys-cap-w');
    const capH = document.getElementById('phys-cap-h');
    const onCapsuleSizeChange = () => {
        const w = Math.max(1, parseFloat(capW?.value) || 1);
        const h = Math.max(1, parseFloat(capH?.value) || 1);
        obj.physicsSize = { ...(obj.physicsSize || {}), capW: w, capH: h };
        import('./engine.collision-overlay.js').then(m => { if (!state.showCollision) m.setCollisionVisible(true); m.refreshCollisionOverlay(); });
    };
    capW?.addEventListener('input',  onCapsuleSizeChange);
    capH?.addEventListener('input',  onCapsuleSizeChange);
    capW?.addEventListener('change', () => _pushUndo());
    capH?.addEventListener('change', () => _pushUndo());
    document.getElementById('phys-size-reset-capsule')?.addEventListener('click', () => {
        if (obj.physicsSize) { delete obj.physicsSize.capW; delete obj.physicsSize.capH; }
        _pushUndo();
        import('./engine.ui.js').then(m => m.syncPixiToInspector?.());
        import('./engine.collision-overlay.js').then(m => m.refreshCollisionOverlay());
    });

    const boxW = document.getElementById('phys-box-w');
    const boxH = document.getElementById('phys-box-h');
    const onBoxSizeChange = () => {
        const w = Math.max(1, parseFloat(boxW?.value) || 1);
        const h = Math.max(1, parseFloat(boxH?.value) || 1);
        obj.physicsSize = { ...(obj.physicsSize || {}), w, h };
        import('./engine.collision-overlay.js').then(m => { if (!state.showCollision) m.setCollisionVisible(true); m.refreshCollisionOverlay(); });
    };
    boxW?.addEventListener('input',  onBoxSizeChange);
    boxH?.addEventListener('input',  onBoxSizeChange);
    boxW?.addEventListener('change', () => { onBoxSizeChange(); _pushUndo(); });
    boxH?.addEventListener('change', () => { onBoxSizeChange(); _pushUndo(); });

    const circleR = document.getElementById('phys-circle-r');
    const onCircleSizeChange = () => {
        const r = Math.max(1, parseFloat(circleR?.value) || 1);
        obj.physicsSize = { ...(obj.physicsSize || {}), r };
        import('./engine.collision-overlay.js').then(m => { if (!state.showCollision) m.setCollisionVisible(true); m.refreshCollisionOverlay(); });
    };
    circleR?.addEventListener('input',  onCircleSizeChange);
    circleR?.addEventListener('change', () => { onCircleSizeChange(); _pushUndo(); });

    document.getElementById('phys-size-reset-box')?.addEventListener('click', () => {
        if (obj.physicsSize) { delete obj.physicsSize.w; delete obj.physicsSize.h; }
        _pushUndo(); import('./engine.ui.js').then(m => m.syncPixiToInspector?.()); import('./engine.collision-overlay.js').then(m => m.refreshCollisionOverlay());
    });
    document.getElementById('phys-size-reset-circle')?.addEventListener('click', () => {
        if (obj.physicsSize) { delete obj.physicsSize.r; }
        _pushUndo(); import('./engine.ui.js').then(m => m.syncPixiToInspector?.()); import('./engine.collision-overlay.js').then(m => m.refreshCollisionOverlay());
    });

    editBtn?.addEventListener('click', () => {
        const firstFrameId = obj.animations?.[obj.activeAnimIndex ?? 0]?.frames?.[0]?.id;
        openPolygonEditor(obj, firstFrameId || 'shared');
    });

    document.getElementById('phys-autofit')?.addEventListener('click', () => {
        _autoFitCollisionShape(obj, () => {
            _pushUndo();
            import('./engine.ui.js').then(m => m.syncPixiToInspector?.());
            import('./engine.collision-overlay.js').then(m => { if (!state.showCollision) m.setCollisionVisible(true); m.refreshCollisionOverlay(); });
            const toast = document.createElement('div');
            toast.style.cssText = 'position:fixed;bottom:40px;left:50%;transform:translateX(-50%);background:#0a2a1a;border:1px solid #4ade80;color:#4ade80;border-radius:4px;padding:6px 18px;font-size:11px;z-index:99999;pointer-events:none;';
            toast.textContent = '🎯 Collision shape auto-fitted';
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 2000);
        });
    });

    document.querySelectorAll('.pe-frame-btn').forEach(btn => {
        btn.addEventListener('click', () => openPolygonEditor(obj, btn.dataset.frame));
    });

    fricEl?.addEventListener('change', () => { obj.physicsFriction = Math.max(0, Math.min(1, parseFloat(fricEl.value) || 0)); _pushUndo(); });
    bnceEl?.addEventListener('change', () => { obj.physicsRestitution = Math.max(0, Math.min(1, parseFloat(bnceEl.value) || 0)); _pushUndo(); });
    document.getElementById('phys-density')?.addEventListener('change', (e) => { obj.physicsDensity = Math.max(0.0001, parseFloat(e.target.value) || 0.001); _pushUndo(); });
    document.getElementById('phys-gravity-scale')?.addEventListener('change', (e) => { obj.physicsGravityScale = parseFloat(e.target.value) ?? 1; _pushUndo(); });
    document.getElementById('phys-gravity-x-scale')?.addEventListener('change', (e) => { obj.physicsGravityXScale = parseFloat(e.target.value) ?? 0; _pushUndo(); });
    document.getElementById('phys-linear-damp')?.addEventListener('change', (e) => { obj.physicsLinearDamping = Math.max(0, parseFloat(e.target.value) || 0); _pushUndo(); });
    document.getElementById('phys-angular-damp')?.addEventListener('change', (e) => { obj.physicsAngularDamping = Math.max(0, parseFloat(e.target.value) || 0); _pushUndo(); });
    document.getElementById('phys-immovable')?.addEventListener('change', (e) => {
        obj.physicsImmovable = e.target.checked;
        import('./engine.physics.js').then(m => m.rebuildBodyForObject(obj));
        _pushUndo();
    });
    document.getElementById('phys-fixed-rot')?.addEventListener('change', (e) => { obj.physicsFixedRotation = e.target.checked; _pushUndo(); });
    document.getElementById('phys-sensor')?.addEventListener('change', (e) => { obj.physicsIsSensor = e.target.checked; _pushUndo(); });
    document.getElementById('phys-col-cat')?.addEventListener('change', (e) => { obj.physicsCollisionCategory = Math.max(1, parseInt(e.target.value) || 1); _pushUndo(); });
    document.getElementById('phys-col-mask')?.addEventListener('change', (e) => { obj.physicsCollisionMask = parseInt(e.target.value) ?? -1; _pushUndo(); });

    document.getElementById('phys-show-collision')?.addEventListener('click', () => {
        import('./engine.collision-overlay.js').then(m => {
            m.setCollisionVisible(!state.showCollision);
            const btn = document.getElementById('phys-show-collision');
            if (btn) {
                btn.textContent = state.showCollision ? '👁 Hide Collision Shape' : '👁 Show Collision Shape';
                btn.style.background = state.showCollision ? '#facc1533' : '';
            }
        });
    });
}

function _pushUndo() { import('./engine.history.js').then(({ pushUndo }) => pushUndo()); }

// ── Polygon Editor ────────────────────────────────────────────
export function openPolygonEditor(obj, frameId = 'shared', opts = {}) {
    document.getElementById('poly-editor-panel')?.remove();
    if (!obj.physicsPolygons || typeof obj.physicsPolygons !== 'object') {
        obj.physicsPolygons = {};
        if (Array.isArray(obj.physicsPolygon) && obj.physicsPolygon.length >= 3)
            obj.physicsPolygons.shared = obj.physicsPolygon.map(p => ({ x: p.x, y: p.y }));
    }
    migratePolygonsToContainer(obj);

    const raw = rawSpriteSize(obj);
    const sprW = raw.w, sprH = raw.h;
    const BORDER = Math.max(sprW, sprH, 80);
    const totalW = sprW + 2 * BORDER;
    const totalH = sprH + 2 * BORDER;
    const FIT_SCALE = Math.min(420 / totalW, 420 / totalH, 4);
    let SCALE = FIT_SCALE;
    let cvW   = Math.round(totalW * SCALE);
    let cvH   = Math.round(totalH * SCALE);

    const existing = obj.physicsPolygons[frameId];
    let pts = (Array.isArray(existing) && existing.length >= 3)
        ? existing.map(p => ({ x: p.x, y: p.y }))
        : _defaultBox(sprW, sprH);

    let previewURL = null;
    if (frameId !== 'shared') {
        for (const anim of (obj.animations || [])) {
            const f = (anim.frames || []).find(f => f.id === frameId);
            if (f) { previewURL = f.dataURL; break; }
        }
    } else {
        previewURL = obj.animations?.[0]?.frames?.[0]?.dataURL || null;
    }
    if (!previewURL && obj.spriteGraphic?.texture?.baseTexture?.resource?.source) {
        const src = obj.spriteGraphic.texture.baseTexture.resource.source;
        previewURL = src.src || src.currentSrc || null;
    }

    const frameLabel = frameId === 'shared' ? 'All Frames (Shared)' : (frameId || 'shared');
    const panel = document.createElement('div');
    panel.id = 'poly-editor-panel';
    panel.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.8);backdrop-filter:blur(4px);font-family:sans-serif;';

    panel.innerHTML = `
    <div style="background:#0d0d1e;border:1px solid #7c3aed66;border-radius:8px;overflow:hidden;
                display:flex;flex-direction:column;width:min(700px,95vw);max-height:92vh;">
      <div style="padding:12px 16px;border-bottom:1px solid #1a1a30;display:flex;align-items:center;gap:10px;">
        <span style="color:#7c3aed;font-weight:700;font-size:13px;">Collision Shape Editor</span>
        <span style="color:#555;font-size:11px;">→</span>
        <span style="color:#a78bfa;font-size:11px;">${frameLabel}</span>
        <div style="display:flex;gap:5px;margin-left:auto;">
          <button id="pe-zoom-out" title="Zoom out" style="${_btn('#a78bfa')}padding:4px 7px;">−</button>
          <span id="pe-zoom-label" style="color:#a78bfa;font-size:10px;align-self:center;min-width:36px;text-align:center;">100%</span>
          <button id="pe-zoom-in"  title="Zoom in"  style="${_btn('#a78bfa')}padding:4px 7px;">+</button>
          <button id="pe-zoom-fit" title="Fit"      style="${_btn('#a78bfa')}padding:4px 7px;">⤢</button>
          <span style="border-left:1px solid #1a1a30;margin:0 4px;"></span>
          <button id="pe-box"    style="${_btn('#3b82f6')}">↺ Box</button>
          <button id="pe-circle" style="${_btn('#06b6d4')}">↺ Circle</button>
          <button id="pe-clear"  style="${_btn('#ef4444')}">✕ Clear</button>
        </div>
      </div>
      <div style="display:flex;flex:1;overflow:hidden;">
        <div style="display:flex;flex-direction:column;align-items:center;padding:14px;gap:6px;flex:1;min-width:0;">
          <div style="color:#555;font-size:9px;text-transform:uppercase;letter-spacing:.05em;text-align:center;">
            Click: add point  •  Drag: move  •  Right-click: delete  •  Ctrl+Wheel: zoom
          </div>
          <div id="pe-canvas-wrap" style="overflow:auto;max-width:600px;max-height:560px;background:#04040a;border:1px solid #1a1a30;border-radius:4px;display:flex;">
            <canvas id="pe-canvas" width="${cvW}" height="${cvH}"
              style="background:#080812;cursor:crosshair;display:block;flex-shrink:0;"
              oncontextmenu="return false;"></canvas>
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            <label style="color:#666;font-size:10px;display:flex;align-items:center;gap:4px;">
              <input id="pe-show-grid" type="checkbox" checked style="accent-color:#7c3aed;"> Grid
            </label>
            <label style="color:#666;font-size:10px;display:flex;align-items:center;gap:4px;">
              <input id="pe-show-sprite" type="checkbox" checked style="accent-color:#7c3aed;"> Preview sprite
            </label>
          </div>
        </div>
        <div style="width:180px;flex-shrink:0;border-left:1px solid #1a1a30;display:flex;flex-direction:column;overflow:hidden;">
          <div style="padding:8px 10px;border-bottom:1px solid #1a1a30;color:#888;font-size:9px;text-transform:uppercase;letter-spacing:.06em;">Vertices (local px)</div>
          <div id="pe-vlist" style="flex:1;overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:3px;"></div>
          <div id="pe-status" style="padding:6px 10px;border-top:1px solid #1a1a30;color:#555;font-size:9px;"></div>
        </div>
      </div>
      <div style="padding:10px 16px;border-top:1px solid #1a1a30;display:flex;justify-content:flex-end;gap:8px;">
        <button id="pe-cancel" style="${_btn('#555')}">Cancel</button>
        <button id="pe-copy-to-all" style="${_btn('#06b6d4')}" title="Copy this shape to all frames">Copy to all frames</button>
        <button id="pe-save"   style="${_btn('#7c3aed')}font-weight:700;">✓ Save</button>
      </div>
    </div>`;

    document.body.appendChild(panel);
    const canvas = panel.querySelector('#pe-canvas');
    const wrap   = panel.querySelector('#pe-canvas-wrap');
    const zoomLbl = panel.querySelector('#pe-zoom-label');
    const ctx    = canvas.getContext('2d');
    let spriteImg = null, showGrid = true, showSprite = true;

    if (previewURL) { spriteImg = new Image(); spriteImg.onload = draw; spriteImg.src = previewURL; }
    requestAnimationFrame(() => {
        const spriteCenterX = (BORDER + sprW / 2) * SCALE;
        const spriteCenterY = (BORDER + sprH / 2) * SCALE;
        wrap.scrollLeft = Math.max(0, spriteCenterX - wrap.clientWidth  / 2);
        wrap.scrollTop  = Math.max(0, spriteCenterY - wrap.clientHeight / 2);
    });

    let dragging = -1, hover = -1;
    const ZOOM_MIN = 0.25, ZOOM_MAX = 16;

    function applyZoom(newScale, anchorClient) {
        const old  = SCALE;
        const next = Math.max(ZOOM_MIN * FIT_SCALE, Math.min(ZOOM_MAX * FIT_SCALE, newScale));
        if (Math.abs(next - old) < 0.001) return;
        const wrapRect = wrap.getBoundingClientRect();
        const cvRect   = canvas.getBoundingClientRect();
        const ax = anchorClient ? anchorClient.x - cvRect.left : (wrap.clientWidth  / 2 - (cvRect.left - wrapRect.left));
        const ay = anchorClient ? anchorClient.y - cvRect.top  : (wrap.clientHeight / 2 - (cvRect.top  - wrapRect.top ));
        const localX = ax / old, localY = ay / old;
        SCALE = next;
        cvW = Math.round(totalW * SCALE); cvH = Math.round(totalH * SCALE);
        canvas.width = cvW; canvas.height = cvH;
        wrap.scrollLeft = Math.max(0, localX * SCALE - ax);
        wrap.scrollTop  = Math.max(0, localY * SCALE - ay);
        if (zoomLbl) zoomLbl.textContent = Math.round((SCALE / FIT_SCALE) * 100) + '%';
        draw();
    }

    function toCanvas(p) { return { x: (p.x + sprW/2 + BORDER) * SCALE, y: (p.y + sprH/2 + BORDER) * SCALE }; }
    function toLocal(cx, cy) { return { x: cx / SCALE - sprW/2 - BORDER, y: cy / SCALE - sprH/2 - BORDER }; }
    function evPos(e) {
        const r  = canvas.getBoundingClientRect();
        const sx = cvW / r.width, sy = cvH / r.height;
        const s  = e.touches ? e.touches[0] : e;
        return { cx: (s.clientX - r.left) * sx, cy: (s.clientY - r.top) * sy };
    }
    function nearestPt(cx, cy) {
        let best = -1, bd = Infinity;
        pts.forEach((p, i) => { const c = toCanvas(p); const d = Math.hypot(cx - c.x, cy - c.y); if (d < bd) { bd = d; best = i; } });
        return bd < 10 ? best : -1;
    }

    function draw() {
        ctx.clearRect(0, 0, cvW, cvH);
        ctx.fillStyle = '#080812'; ctx.fillRect(0, 0, cvW, cvH);
        const sprLeft = BORDER * SCALE, sprTop = BORDER * SCALE;
        const sprPxW = sprW * SCALE, sprPxH = sprH * SCALE;
        if (showSprite && spriteImg?.complete && spriteImg.naturalWidth > 0) {
            ctx.globalAlpha = 0.4; ctx.drawImage(spriteImg, sprLeft, sprTop, sprPxW, sprPxH); ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1; ctx.setLineDash([4,4]);
        ctx.strokeRect(sprLeft, sprTop, sprPxW, sprPxH); ctx.setLineDash([]);
        if (showGrid) {
            const step = Math.max(8, Math.round(Math.min(sprW, sprH) / 8)) * SCALE;
            const ox = cvW / 2, oy = cvH / 2;
            ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 0.5;
            for (let x = ox % step; x < cvW; x += step) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,cvH); ctx.stroke(); }
            for (let y = oy % step; y < cvH; y += step) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(cvW,y); ctx.stroke(); }
            ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.setLineDash([3,3]);
            ctx.beginPath(); ctx.moveTo(ox,0); ctx.lineTo(ox,cvH); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0,oy); ctx.lineTo(cvW,oy); ctx.stroke();
            ctx.setLineDash([]);
        }
        if (pts.length === 0) {
            ctx.fillStyle='#444'; ctx.font='11px sans-serif'; ctx.textAlign='center';
            ctx.fillText('Click to add vertices', cvW/2, cvH/2); ctx.textAlign='left';
            rebuildList(); updateStatus(); return;
        }
        const c0 = toCanvas(pts[0]);
        ctx.beginPath(); ctx.moveTo(c0.x, c0.y);
        for (let i = 1; i < pts.length; i++) { const c = toCanvas(pts[i]); ctx.lineTo(c.x, c.y); }
        if (pts.length >= 3) ctx.closePath();
        ctx.fillStyle = 'rgba(124,58,237,0.2)'; if (pts.length >= 3) ctx.fill();
        ctx.strokeStyle = '#7c3aed'; ctx.lineWidth = 1.5; ctx.stroke();
        pts.forEach((p, i) => {
            const c = toCanvas(p), big = i === dragging || i === hover;
            ctx.beginPath(); ctx.arc(c.x, c.y, big ? 7 : 4, 0, Math.PI*2);
            ctx.fillStyle = i === dragging ? '#facc15' : i === hover ? '#fff' : '#a78bfa';
            ctx.strokeStyle = '#0d0d1e'; ctx.lineWidth = 1.5; ctx.fill(); ctx.stroke();
            ctx.fillStyle = i === dragging ? '#000' : '#fff'; ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText(String(i), c.x, c.y + 3); ctx.textAlign = 'left';
        });
        rebuildList(); updateStatus();
    }

    function updateStatus() {
        const el = panel.querySelector('#pe-status');
        if (!el) return;
        el.textContent = pts.length >= 3 ? `✓ ${pts.length} vertices — valid` : `${pts.length} / 3+ vertices needed`;
        el.style.color = pts.length >= 3 ? '#4ade80' : '#ef4444';
    }

    function rebuildList() {
        const el = panel.querySelector('#pe-vlist');
        if (!el) return;
        el.innerHTML = '';
        pts.forEach((p, i) => {
            const row = document.createElement('div');
            row.style.cssText = `display:flex;align-items:center;gap:3px;background:${i===hover?'#140e28':'transparent'};border-radius:2px;padding:1px 2px;`;
            row.innerHTML = `
              <span style="color:#7c3aed;font-size:9px;min-width:12px;">${i}</span>
              <input type="number" data-i="${i}" data-ax="x" value="${p.x.toFixed(1)}" style="width:46px;${_inp()}background:#0a0a12;font-size:9px;padding:1px 3px;">
              <input type="number" data-i="${i}" data-ax="y" value="${p.y.toFixed(1)}" style="width:46px;${_inp()}background:#0a0a12;font-size:9px;padding:1px 3px;">
              <button data-del="${i}" style="${_btn('#ef4444')}padding:1px 3px;font-size:9px;line-height:1;">✕</button>`;
            el.appendChild(row);
        });
        el.querySelectorAll('input[data-i]').forEach(inp => inp.addEventListener('change', () => { pts[parseInt(inp.dataset.i)][inp.dataset.ax] = parseFloat(inp.value) || 0; draw(); }));
        el.querySelectorAll('button[data-del]').forEach(btn => btn.addEventListener('click', () => { pts.splice(parseInt(btn.dataset.del), 1); draw(); }));
    }

    canvas.addEventListener('mousedown', e => {
        e.preventDefault();
        const { cx, cy } = evPos(e);
        if (e.button === 2) { const i = nearestPt(cx, cy); if (i >= 0) { pts.splice(i, 1); hover = -1; draw(); } return; }
        const i = nearestPt(cx, cy);
        if (i >= 0) { dragging = i; canvas.style.cursor = 'grabbing'; }
        else { pts.push(toLocal(cx, cy)); draw(); }
    });
    const _onMove = e => {
        const { cx, cy } = evPos(e);
        if (dragging >= 0) { pts[dragging] = toLocal(cx, cy); draw(); return; }
        const old = hover; hover = nearestPt(cx, cy);
        canvas.style.cursor = hover >= 0 ? 'grab' : 'crosshair';
        if (hover !== old) draw();
    };
    const _onUp = () => { if (dragging >= 0) { dragging = -1; canvas.style.cursor = hover >= 0 ? 'grab' : 'crosshair'; draw(); } };
    window.addEventListener('mousemove', _onMove);
    window.addEventListener('mouseup',   _onUp);
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    panel.querySelector('#pe-show-grid').addEventListener('change',   e => { showGrid   = e.target.checked; draw(); });
    panel.querySelector('#pe-show-sprite').addEventListener('change', e => { showSprite = e.target.checked; draw(); });
    panel.querySelector('#pe-box').addEventListener('click',    () => { pts = _defaultBox(sprW, sprH); draw(); });
    panel.querySelector('#pe-circle').addEventListener('click', () => { pts = _defaultCircle(Math.min(sprW, sprH) / 2); draw(); });
    panel.querySelector('#pe-clear').addEventListener('click',  () => { pts = []; draw(); });
    panel.querySelector('#pe-zoom-in') .addEventListener('click', () => applyZoom(SCALE * 1.25));
    panel.querySelector('#pe-zoom-out').addEventListener('click', () => applyZoom(SCALE / 1.25));
    panel.querySelector('#pe-zoom-fit').addEventListener('click', () => applyZoom(FIT_SCALE));
    wrap.addEventListener('wheel', (e) => { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); applyZoom(SCALE * (e.deltaY < 0 ? 1.15 : 1/1.15), { x: e.clientX, y: e.clientY }); }, { passive: false });

    function saveAndClose() {
        window.removeEventListener('mousemove', _onMove);
        window.removeEventListener('mouseup',   _onUp);
        if (pts.length >= 3) {
            if (!obj.physicsPolygons) obj.physicsPolygons = {};
            obj.physicsPolygons[frameId] = pts.map(p => ({ x: p.x, y: p.y }));
            obj.physicsShape = 'polygon';
            obj._polyUnit = 'container';
            if (frameId === 'shared') {
                obj.physicsPolygon = obj.physicsPolygons.shared.slice();
                const firstFrameId = obj.animations?.[obj.activeAnimIndex ?? 0]?.frames?.[0]?.id;
                if (firstFrameId && !obj.physicsPolygons[firstFrameId])
                    obj.physicsPolygons[firstFrameId] = obj.physicsPolygons.shared.slice();
            }
            const firstFrameId = obj.animations?.[obj.activeAnimIndex ?? 0]?.frames?.[0]?.id;
            if (frameId === firstFrameId) {
                obj.physicsPolygon = pts.map(p => ({ x: p.x, y: p.y }));
                obj.physicsPolygons.shared = obj.physicsPolygon.slice();
            }
        }
        import('./engine.ui.js').then(m => m.syncPixiToInspector?.());
        import('./engine.collision-overlay.js').then(m => m.refreshCollisionOverlay());
        _pushUndo();
        panel.remove();
        try { opts?.onSave?.(frameId); } catch (_) {}
    }

    panel.querySelector('#pe-save').addEventListener('click', saveAndClose);
    panel.querySelector('#pe-copy-to-all').addEventListener('click', () => {
        if (pts.length < 3) return;
        if (!obj.physicsPolygons) obj.physicsPolygons = {};
        obj.physicsPolygons.shared = pts.map(p => ({ x: p.x, y: p.y }));
        (obj.animations || []).forEach(anim => (anim.frames || []).forEach(f => { obj.physicsPolygons[f.id] = pts.map(p => ({ x: p.x, y: p.y })); }));
        obj._polyUnit = 'container';
        saveAndClose();
    });
    panel.querySelector('#pe-cancel').addEventListener('click', () => {
        window.removeEventListener('mousemove', _onMove); window.removeEventListener('mouseup', _onUp); panel.remove();
    });
    panel.addEventListener('mousedown', e => {
        if (e.target === panel) {
            if (pts.length >= 3) saveAndClose();
            else { window.removeEventListener('mousemove', _onMove); window.removeEventListener('mouseup', _onUp); panel.remove(); }
        }
    });
    const _onKey = (e) => {
        if (e.key === 'Escape') {
            if (pts.length >= 3) saveAndClose();
            else { window.removeEventListener('mousemove', _onMove); window.removeEventListener('mouseup', _onUp); panel.remove(); }
            window.removeEventListener('keydown', _onKey);
        }
    };
    window.addEventListener('keydown', _onKey);
    draw();
}

// ── Default shapes ────────────────────────────────────────────
function _defaultBox(w, h) {
    const hw = w/2 - 0.5, hh = h/2 - 0.5;
    return [{ x:-hw,y:-hh },{ x:hw,y:-hh },{ x:hw,y:hh },{ x:-hw,y:hh }];
}
function _defaultCircle(r, n = 12) {
    return Array.from({ length: n }, (_, i) => ({
        x: Math.round(Math.cos((i/n)*Math.PI*2) * (r-0.5) * 10) / 10,
        y: Math.round(Math.sin((i/n)*Math.PI*2) * (r-0.5) * 10) / 10,
    }));
}

// ── Snapshot helpers ──────────────────────────────────────────
export function snapshotPhysics(obj) {
    return {
        physicsBody:              obj.physicsBody              ?? 'none',
        physicsFriction:          obj.physicsFriction          ?? 0.3,
        physicsRestitution:       obj.physicsRestitution       ?? 0.1,
        physicsShape:             obj.physicsShape             ?? 'box',
        physicsDensity:           obj.physicsDensity           ?? 0.001,
        physicsGravityScale:      obj.physicsGravityScale      ?? 1,
        physicsGravityXScale:     obj.physicsGravityXScale     ?? 0,
        physicsLinearDamping:     obj.physicsLinearDamping     ?? 0.01,
        physicsAngularDamping:    obj.physicsAngularDamping    ?? 0,
        physicsFixedRotation:     !!obj.physicsFixedRotation,
        physicsIsSensor:          !!obj.physicsIsSensor,
        physicsImmovable:         !!obj.physicsImmovable,
        physicsCollisionCategory: obj.physicsCollisionCategory ?? 1,
        physicsCollisionMask:     obj.physicsCollisionMask     ?? -1,
        physicsSize:     obj.physicsSize     ? JSON.parse(JSON.stringify(obj.physicsSize))     : null,
        physicsPolygon:  obj.physicsPolygon  ? JSON.parse(JSON.stringify(obj.physicsPolygon))  : null,
        physicsPolygons: obj.physicsPolygons ? JSON.parse(JSON.stringify(obj.physicsPolygons)) : null,
        _polyUnit:               obj._polyUnit || null,
        _collisionShapeInit:     !!obj._collisionShapeInit,
    };
}

export function restorePhysics(obj, snap) {
    if (!snap) return;
    obj.physicsBody              = snap.physicsBody              ?? 'none';
    obj.physicsFriction          = snap.physicsFriction          ?? 0.3;
    obj.physicsRestitution       = snap.physicsRestitution       ?? 0.1;
    obj.physicsShape             = snap.physicsShape             ?? 'box';
    obj.physicsDensity           = snap.physicsDensity           ?? 0.001;
    obj.physicsGravityScale      = snap.physicsGravityScale      ?? 1;
    obj.physicsGravityXScale     = snap.physicsGravityXScale     ?? 0;
    obj.physicsLinearDamping     = snap.physicsLinearDamping     ?? 0.01;
    obj.physicsAngularDamping    = snap.physicsAngularDamping    ?? 0;
    obj.physicsFixedRotation     = !!snap.physicsFixedRotation;
    obj.physicsIsSensor          = !!snap.physicsIsSensor;
    obj.physicsImmovable         = !!snap.physicsImmovable;
    obj.physicsCollisionCategory = snap.physicsCollisionCategory ?? 1;
    obj.physicsCollisionMask     = snap.physicsCollisionMask     ?? -1;
    obj.physicsSize     = snap.physicsSize     ? JSON.parse(JSON.stringify(snap.physicsSize))     : null;
    obj.physicsPolygon  = snap.physicsPolygon  ? JSON.parse(JSON.stringify(snap.physicsPolygon))  : null;
    obj.physicsPolygons = snap.physicsPolygons ? JSON.parse(JSON.stringify(snap.physicsPolygons)) : null;
    obj._polyUnit            = snap._polyUnit || null;
    obj._collisionShapeInit  = !!snap._collisionShapeInit;
}

// ── Style helpers ─────────────────────────────────────────────
function _btn(c)  { return `background:${c}22;border:1px solid ${c}66;color:${c};border-radius:3px;padding:4px 10px;cursor:pointer;font-size:11px;font-weight:600;`; }
function _sel()   { return `background:#111;border:1px solid #333;color:#e0e0e0;border-radius:3px;padding:2px 6px;font-size:11px;cursor:pointer;`; }
function _inp()   { return `background:#111;border:1px solid #333;color:#e0e0e0;border-radius:3px;padding:2px 4px;font-size:11px;`; }
