/* ============================================================
   Zengine — engine.scripting.js
   Complete sandboxed scripting system.

   Key design:
   - `this.x`, `this.y`, `this.tag` for clarity — no ambiguity
   - scene variables (shared across all scripts in a scene)
   - global variables (persist across scene changes)
   - camera.follow(), camera.moveTo(), camera.position()
   - gotoScene(name/index), currentScene(), getSceneCount()
   - Overlap detection (AABB) for non-physics objects
   - Collision tracking: instant (onCollisionEnter) + continuous (onCollisionStay) + exit (onCollisionExit)
   - Gravity per object via this.gravity(x, y) in script
   - All APIs have clear `this.` prefixed names
   ============================================================ */

import { state } from './engine.state.js';

// ── Ace CDN ───────────────────────────────────────────────────
const ACE_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.2';

function _loadAce() {
    return new Promise(resolve => {
        if (window.ace) { resolve(window.ace); return; }
        const s = document.createElement('script');
        s.src = `${ACE_BASE}/ace.min.js`;
        s.onload = () => {
            const lt = document.createElement('script');
            lt.src = `${ACE_BASE}/ext-language_tools.min.js`;
            lt.onload = () => resolve(window.ace);
            document.head.appendChild(lt);
        };
        document.head.appendChild(s);
    });
}

// ── Script CRUD (state.scripts) ───────────────────────────────
export function saveScript(name, code) {
    const existing = state.scripts.find(s => s.name === name);
    if (existing) {
        existing.code      = code;
        existing.updatedAt = Date.now();
    } else {
        state.scripts.push({
            id: 'script_' + Date.now() + '_' + Math.random().toString(36).slice(2),
            name, code, updatedAt: Date.now(),
        });
    }
    refreshScriptPanel();
}

export function getScript(name) {
    return state.scripts.find(s => s.name === name) ?? null;
}

export function deleteScriptByName(name) {
    const idx = state.scripts.findIndex(s => s.name === name);
    if (idx !== -1) state.scripts.splice(idx, 1);
    refreshScriptPanel();
}

// ── Script Panel ──────────────────────────────────────────────
export function refreshScriptPanel() {
    const grid = document.getElementById('script-asset-grid');
    if (!grid) return;
    grid.innerHTML = '';

    if (state.scripts.length === 0) {
        const e = document.createElement('div');
        e.style.cssText = 'color:#505060;font-size:11px;padding:20px;text-align:center;width:100%;';
        e.textContent = 'No scripts yet';
        grid.appendChild(e);
        return;
    }

    const banner = document.createElement('div');
    banner.style.cssText = 'width:100%;padding:5px 10px;background:#080c12;border-bottom:1px solid #12192a;font-size:9px;color:#2a4a6a;line-height:1.6;';
    banner.innerHTML = '📎 <b style="color:#3a6a9a;">To use:</b> select a sprite → Inspector → Load Script';
    grid.appendChild(banner);

    const defaults    = state.scripts.filter(s => s.isDefault);
    const userScripts = state.scripts.filter(s => !s.isDefault);

    function addSection(label, color, bgColor, scripts) {
        if (!scripts.length) return;
        const hdr = document.createElement('div');
        hdr.style.cssText = `width:100%;padding:4px 10px;color:${color};font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;background:${bgColor};border-bottom:1px solid ${color}22;`;
        hdr.textContent = label;
        grid.appendChild(hdr);
        for (const script of scripts) grid.appendChild(_makeScriptCard(script, script.isDefault));
    }

    addSection('⭐ Built-in Scripts', '#3a7a3a', '#060d06', defaults);
    addSection('📝 My Scripts',       '#2a5a8a', '#06080d', userScripts);
}

function _makeScriptCard(script, isDefault) {
    const item = document.createElement('div');
    item.className = 'asset-item';
    item.style.cssText = 'cursor:pointer;position:relative;';
    const stroke = isDefault ? '#4ade80' : '#7cb9f0';
    const bg     = isDefault ? '#060d06' : '#06080d';
    const border = isDefault ? '#1a3a1a' : '#1a2a3a';
    item.innerHTML = `
        <div class="asset-thumb" style="background:${bg};border:1px solid ${border};position:relative;">
            <svg viewBox="0 0 24 24" style="width:26px;height:26px;fill:none;stroke:${stroke};stroke-width:1.5;">
                <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
            </svg>
            ${isDefault ? '<div style="position:absolute;bottom:1px;left:0;right:0;text-align:center;font-size:7px;color:#3a7a3a;font-weight:700;">BUILT-IN</div>' : ''}
        </div>
        <div class="asset-name" title="${script.name}.js">${script.name.length > 11 ? script.name.slice(0,10)+'…' : script.name}</div>
        ${!isDefault ? '<div class="script-del-btn" style="display:none;position:absolute;top:2px;right:2px;"><button style="background:rgba(24,6,6,.92);border:1px solid #3a1a1a;color:#f87171;border-radius:3px;padding:1px 4px;font-size:10px;cursor:pointer;">✕</button></div>' : ''}
    `;
    if (!isDefault) {
        item.addEventListener('mouseenter', () => item.querySelector('.script-del-btn').style.display = 'block');
        item.addEventListener('mouseleave', () => item.querySelector('.script-del-btn').style.display = 'none');
        item.querySelector('.script-del-btn button')?.addEventListener('click', e => {
            e.stopPropagation();
            if (confirm(`Delete script "${script.name}"?`)) deleteScriptByName(script.name);
        });
    }
    item.addEventListener('click', () => openScriptEditor(null, script.name, script.code));
    return item;
}

// ── Scene-level shared variables (reset on scene change) ──────
const _sceneVars  = {};
// ── Global variables — ONE shared object, all scripts see it ──
// This is a true singleton. Any script can write globalVar.score = 10
// and every other script reading globalVar.score sees 10.
// Survives scene changes. Only cleared when Play is stopped.
const _globalVars = {};

export function clearSceneVars()  { for (const k in _sceneVars)  delete _sceneVars[k];  }
// globalVar intentionally NOT cleared on scene change — that's the whole point.
// Only clear on Play stop so data doesn't bleed between play sessions.
export function clearGlobalVars() { for (const k in _globalVars) delete _globalVars[k]; }

// ── Camera API (wraps sceneContainer in play mode) ────────────
const _camera = {
    _followTarget: null,
    _smoothing:    6,

    /** Follow an object every frame. target = result of find() or findWithTag() */
    follow(target, smoothing = 6) {
        this._followTarget = target;
        this._smoothing    = smoothing;
    },
    /** Stop following */
    unfollow() { this._followTarget = null; },
    /** Instantly move camera to world position */
    moveTo(wx, wy) {
        this._followTarget = null;
        if (!state.sceneContainer) return;
        const sc    = state.sceneContainer;
        const scale = sc.scale.x;
        sc.x = window.innerWidth  / 2 - wx * 100 * scale;
        sc.y = window.innerHeight / 2 + wy * 100 * scale;
    },
    /** Get current camera centre in world units */
    get x() {
        if (!state.sceneContainer) return 0;
        const sc = state.sceneContainer;
        return (window.innerWidth / 2 - sc.x) / (sc.scale.x * 100);
    },
    get y() {
        if (!state.sceneContainer) return 0;
        const sc = state.sceneContainer;
        return (sc.y - window.innerHeight / 2) / (sc.scale.y * 100);
    },
    /** Shake the camera (amplitude in world units, duration in seconds) */
    shake(amplitude = 0.2, duration = 0.3) {
        _cameraShake.amplitude = amplitude;
        _cameraShake.duration  = duration;
        _cameraShake.elapsed   = 0;
    },
};

const _cameraShake = { amplitude: 0, duration: 0, elapsed: 0 };

function _updateCamera(dt) {
    if (!state.sceneContainer || !state.isPlaying) return;
    const sc    = state.sceneContainer;
    const scale = sc.scale.x;

    // Follow
    if (_camera._followTarget) {
        const t  = _camera._followTarget;
        const tx = window.innerWidth  / 2 - (t._ref ? t._ref.x : t.x * 100) * scale;
        const ty = window.innerHeight / 2 + (t._ref ? t._ref.y : -t.y * 100) * scale;
        const sm = Math.max(0, Math.min(1, _camera._smoothing * dt));
        sc.x += (tx - sc.x) * sm;
        sc.y += (ty - sc.y) * sm;
    }

    // Shake
    if (_cameraShake.elapsed < _cameraShake.duration) {
        _cameraShake.elapsed += dt;
        const t   = _cameraShake.elapsed / _cameraShake.duration;
        const amp = _cameraShake.amplitude * (1 - t) * 100 * scale;
        sc.x += (Math.random() - 0.5) * amp;
        sc.y += (Math.random() - 0.5) * amp;
    }
}

// ── Global message bus ────────────────────────────────────────
const _tagRegistry   = new Map();
const _groupRegistry = new Map();

function _registerInstance(inst) {
    const tag   = inst.obj._scriptTag;
    const group = inst.obj._scriptGroup;
    if (tag) {
        if (!_tagRegistry.has(tag))   _tagRegistry.set(tag, new Set());
        _tagRegistry.get(tag).add(inst);
    }
    if (group) {
        if (!_groupRegistry.has(group)) _groupRegistry.set(group, new Set());
        _groupRegistry.get(group).add(inst);
    }
}

function _clearRegistries() { _tagRegistry.clear(); _groupRegistry.clear(); }

function _deliverMsg(inst, msg, data) {
    const handler = inst._messageHandlers?.get(msg);
    if (!handler) return;
    try { handler(data); }
    catch (e) {
        const friendly = _friendlyScriptError(e, null, inst.name, inst.obj?.label ?? '?', `onMessage("${msg}")`);
        for (const line of friendly) _logConsole(line, '#f87171');
        import('./engine.console.js').then(m => m.recordPlayError());
    }
}

function _sendMessageToTag(tag, msg, data) {
    const set = _tagRegistry.get(tag);
    if (!set || set.size === 0) return;
    const [first] = set;
    _deliverMsg(first, msg, data);
}
function _broadcastToTag(tag, msg, data)    { const s = _tagRegistry.get(tag);   if (s) for (const i of s) _deliverMsg(i, msg, data); }
function _broadcastToGroup(grp, msg, data)  { const s = _groupRegistry.get(grp); if (s) for (const i of s) _deliverMsg(i, msg, data); }
function _broadcastGlobal(msg, data)        { for (const i of _instances) _deliverMsg(i, msg, data); }

// ── Overlap (AABB) detection for non-physics objects ──────────
function _getAABB(obj) {
    const hw = (obj.spriteGraphic?.width  ?? obj._bounds?.width  ?? 100) / 2;
    const hh = (obj.spriteGraphic?.height ?? obj._bounds?.height ?? 100) / 2;
    const sx  = Math.abs(obj.scale?.x ?? 1);
    const sy  = Math.abs(obj.scale?.y ?? 1);
    return {
        left:   obj.x - hw * sx,
        right:  obj.x + hw * sx,
        top:    obj.y - hh * sy,
        bottom: obj.y + hh * sy,
    };
}

function _aabbOverlap(a, b) {
    const ba = _getAABB(a);
    const bb = _getAABB(b);
    return ba.right > bb.left && ba.left < bb.right &&
           ba.bottom > bb.top && ba.top  < bb.bottom;
}

function _isOverlapping(objA, objB) {
    if (!objA || !objB) return false;
    return _aabbOverlap(objA, objB);
}

// ── Script timer system (wait X seconds then call fn) ─────────
const _timers = [];

function _scheduleTimer(seconds, fn, scriptName, objLabel) {
    if (typeof seconds !== 'number' || seconds < 0) seconds = 0;
    _timers.push({ remaining: seconds, fn, scriptName: scriptName ?? 'wait()', objLabel: objLabel ?? '?' });
}

function _tickTimers(dt) {
    for (let i = _timers.length - 1; i >= 0; i--) {
        _timers[i].remaining -= dt;
        if (_timers[i].remaining <= 0) {
            try { _timers[i].fn(); }
            catch (e) {
                const friendly = _friendlyScriptError(e, null, _timers[i].scriptName ?? 'wait()', _timers[i].objLabel ?? '?', 'wait timer');
                for (const line of friendly) _logConsole(line, '#f87171');
                import('./engine.console.js').then(m => m.recordPlayError());
            }
            _timers.splice(i, 1);
        }
    }
}

function _clearTimers() { _timers.length = 0; }

// ── Tween easing functions ────────────────────────────────────
function _easing(t, name) {
    switch (name) {
        case 'easeIn':     return t * t;
        case 'easeOut':    return 1 - (1 - t) ** 2;
        case 'easeInOut':  return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) ** 2;
        case 'easeInCubic':  return t ** 3;
        case 'easeOutCubic': return 1 - (1 - t) ** 3;
        case 'elastic': {
            if (t === 0 || t === 1) return t;
            return -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * (2 * Math.PI) / 3);
        }
        case 'elasticOut': {
            if (t === 0 || t === 1) return t;
            return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI) / 3) + 1;
        }
        case 'bounce': {
            const n1 = 7.5625, d1 = 2.75;
            if (t < 1 / d1)       return n1 * t * t;
            if (t < 2 / d1)       { t -= 1.5  / d1; return n1 * t * t + 0.75; }
            if (t < 2.5 / d1)     { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
            t -= 2.625 / d1;      return n1 * t * t + 0.984375;
        }
        case 'steps2':  return Math.round(t * 2) / 2;
        case 'steps4':  return Math.round(t * 4) / 4;
        case 'linear':
        default:        return t;
    }
}

function _applyTweenProp(api, key, v) {
    switch (key) {
        case 'x':        api.x        = v; break;
        case 'y':        api.y        = v; break;
        case 'alpha':    api.alpha    = v; break;
        case 'scaleX':   api.scaleX   = v; break;
        case 'scaleY':   api.scaleY   = v; break;
        case 'rotation': api.rotation = v; break;
        case 'scale':    api.scaleX   = v; api.scaleY = v; break;
    }
}

// ── Debug line system ─────────────────────────────────────────
let _debugGfx   = null;
const _debugLines = [];

function _ensureDebugGfx() {
    if (_debugGfx && state.sceneContainer?.children?.includes(_debugGfx)) return _debugGfx;
    if (!window.PIXI || !state.sceneContainer) return null;
    _debugGfx = new window.PIXI.Graphics();
    _debugGfx.zIndex = 9999;
    state.sceneContainer.addChild(_debugGfx);
    return _debugGfx;
}

function _tickDebugLines(dt) {
    if (_debugLines.length === 0 && !_debugGfx) return;
    for (let i = _debugLines.length - 1; i >= 0; i--) {
        _debugLines[i].remaining -= dt;
        if (_debugLines[i].remaining <= 0) _debugLines.splice(i, 1);
    }
    const gfx = _ensureDebugGfx();
    if (!gfx) return;
    gfx.clear();
    for (const l of _debugLines) {
        const c = typeof l.color === 'string' ? parseInt(l.color.replace('#',''), 16) : (l.color ?? 0xffffff);
        gfx.lineStyle(l.width ?? 2, c, l.alpha ?? 0.85);
        gfx.moveTo(l.x1 * 100, -l.y1 * 100);
        gfx.lineTo(l.x2 * 100, -l.y2 * 100);
        if (l.circle) {
            const cx = l.x1 * 100, cy = -l.y1 * 100;
            const r  = l.circle * 100;
            gfx.lineStyle(l.width ?? 2, c, l.alpha ?? 0.85);
            gfx.drawCircle(cx, cy, r);
        }
    }
}

function _clearDebugGfx() {
    _debugLines.length = 0;
    if (_debugGfx) { try { _debugGfx.destroy(); } catch(_) {} _debugGfx = null; }
}

// ── Repeat ID counter ─────────────────────────────────────────
let _repeatIdCounter = 0;

// ── Sandbox API builder ───────────────────────────────────────
function _buildSandbox(obj, instRef) {
    const _keys         = new Set();
    const _keysJustDown = new Set();
    const _keysJustUp   = new Set();
    const _mouse        = { x: 0, y: 0, down: false, justDown: false, justUp: false };

    // Per-object velocity — integrated each frame
    const _vel = { x: 0, y: 0 };
    // Per-object manual gravity (script can call this.gravity(0, 9.8))
    const _grav = { x: 0, y: 0 };

    // Per-sandbox tween queue, repeat timers, and key event handlers
    const _tweens          = [];
    const _repeats         = [];
    const _keyDownHandlers = new Map();
    const _keyUpHandlers   = new Map();
    // Hammer.js gesture handlers
    const _swipeHandlers   = new Map(); // direction → fn
    let   _pinchHandler    = null;
    let   _tapHandler      = null;

    const api = {

        // ── IDENTITY ─────────────────────────────────────────
        /** This object's name/label */
        get name()  { return obj.label; },

        /** This object's tag (used for messaging and findWithTag) */
        get tag()   { return obj._scriptTag  ?? ''; },
        set tag(v)  { obj._scriptTag = String(v); if (instRef[0]) _registerInstance(instRef[0]); },

        /** This object's group */
        get group() { return obj._scriptGroup ?? ''; },
        set group(v){ obj._scriptGroup = String(v); if (instRef[0]) _registerInstance(instRef[0]); },

        // ── POSITION — this.x, this.y ─────────────────────────
        /** World X position of this object */
        get x()  { return  obj.x  / 100; },
        set x(v) {
            if (obj.physicsImmovable) return;
            obj.x = v * 100;
            // For kinematic bodies: a direct x= write is a teleport-style move.
            // Reset prevX so stepPhysics picks it up as a delta from the NEW position
            // and doesn't double-apply it alongside velocity.
            if (obj.physicsBody === 'kinematic') obj._kinematicPrevX = obj.x;
        },
        /** World Y position of this object */
        get y()  { return -obj.y  / 100; },
        set y(v) {
            if (obj.physicsImmovable) return;
            obj.y = -v * 100;
            if (obj.physicsBody === 'kinematic') obj._kinematicPrevY = obj.y;
        },

        // ── VELOCITY ─────────────────────────────────────────
        /** Horizontal velocity in world units/second (auto-applied each frame) */
        get velocityX()  { return _vel.x; },
        set velocityX(v) { _vel.x = v; },
        /** Vertical velocity in world units/second (auto-applied each frame) */
        get velocityY()  { return _vel.y; },
        set velocityY(v) { _vel.y = v; },
        /** Short alias for velocityX */
        get vx()  { return _vel.x; },
        set vx(v) { _vel.x = v; },
        /** Short alias for velocityY */
        get vy()  { return _vel.y; },
        set vy(v) { _vel.y = v; },

        /** Set both velocity components at once */
        setVelocity(vx, vy) { _vel.x = vx; _vel.y = vy; },
        /** Stop all movement */
        stopMovement() { _vel.x = 0; _vel.y = 0; },
        /** Bounce velocityX (e.g. hit a wall) */
        bounceX() { _vel.x = -_vel.x; },
        /** Bounce velocityY (e.g. hit a floor) */
        bounceY() { _vel.y = -_vel.y; },

        // ── MANUAL GRAVITY ────────────────────────────────────
        /**
         * Apply manual gravity to this object (world units/s²).
         * Call inside onUpdate — it's additive per frame.
         * Example: this.gravity(0, -9.8)  ← falls downward
         */
        gravity(gx, gy) { _grav.x = gx ?? 0; _grav.y = gy ?? 0; },

        // ── INTERNAL vel/grav for runtime ─────────────────────
        _vel,
        _grav,
        // ANY-key helpers
        _anyKeyDown()     { return _keys.size > 0; },
        _anyKeyJustDown() { return _keysJustDown.size > 0; },
        _anyKeyJustUp()   { return _keysJustUp.size > 0; },

        // ── ROTATION / SCALE ─────────────────────────────────
        /** This object's rotation in degrees */
        get rotation()   { return -(obj.rotation * 180 / Math.PI); },
        set rotation(v)  { obj.rotation = -(v * Math.PI / 180); },
        get scaleX()     { return obj.scale?.x ?? 1; },
        set scaleX(v)    { if (obj.scale) obj.scale.x = v; },
        get scaleY()     { return obj.scale?.y ?? 1; },
        set scaleY(v)    { if (obj.scale) obj.scale.y = v; },
        /** Width in world units */
        get width()      { return (obj.spriteGraphic?.width  ?? 100) / 100; },
        /** Height in world units */
        get height()     { return (obj.spriteGraphic?.height ?? 100) / 100; },

        // ── DISPLAY ───────────────────────────────────────────
        get visible()    { return obj.visible; },
        set visible(v)   { obj.visible = !!v; },
        get alpha()      { return obj.alpha; },
        set alpha(v)     { obj.alpha = Math.max(0, Math.min(1, v)); },

        // ── MOVEMENT HELPERS ─────────────────────────────────
        /** Move by (dx, dy) world units this frame.
         *  For kinematic bodies, accumulates into the AABB sweep so
         *  the move is collision-resolved — no more tunneling through walls. */
        move(dx, dy) {
            if (obj.physicsImmovable) return;
            if (obj.physicsBody === 'kinematic') {
                // Accumulate into pending delta; stepPhysics will sweep it
                if (!obj._pendingKinematicDelta) obj._pendingKinematicDelta = { x: 0, y: 0 };
                obj._pendingKinematicDelta.x +=  dx * 100;
                obj._pendingKinematicDelta.y -= dy * 100;
            } else {
                obj.x += dx * 100;
                obj.y -= dy * 100;
            }
        },
        translate(dx, dy) {
            if (obj.physicsImmovable) return;
            if (obj.physicsBody === 'kinematic') {
                if (!obj._pendingKinematicDelta) obj._pendingKinematicDelta = { x: 0, y: 0 };
                obj._pendingKinematicDelta.x +=  dx * 100;
                obj._pendingKinematicDelta.y -= dy * 100;
            } else {
                obj.x += dx * 100;
                obj.y -= dy * 100;
            }
        },
        moveTo(x, y) {
            if (obj.physicsImmovable) return;
            // moveTo is a teleport — goes direct even on kinematic
            // (intentional: respawn, warp, etc.)
            obj.x =  x * 100;
            obj.y = -y * 100;
            if (obj.physicsBody === 'kinematic') {
                // Reset prev so next frame doesn't treat this as a large velocity
                obj._kinematicPrevX = obj.x;
                obj._kinematicPrevY = obj.y;
            }
        },
        /** Rotate to face a world point */
        lookAt(tx, ty) {
            obj.rotation = -Math.atan2(-((-ty*100) - obj.y), (tx*100) - obj.x);
        },
        /** Move forward along current rotation direction (sweep-resolved for kinematic) */
        moveForward(speed) {
            const r  = -obj.rotation;
            const dx = Math.cos(r) * speed * 100;
            const dy = Math.sin(r) * speed * 100;
            if (obj.physicsBody === 'kinematic') {
                if (!obj._pendingKinematicDelta) obj._pendingKinematicDelta = { x: 0, y: 0 };
                obj._pendingKinematicDelta.x += dx;
                obj._pendingKinematicDelta.y -= dy;
            } else {
                obj.x += dx;
                obj.y -= dy;
            }
        },
        flipX() { if (obj.scale) obj.scale.x *= -1; },
        flipY() { if (obj.scale) obj.scale.y *= -1; },

        // ── PHYSICS BODY ─────────────────────────────────────
        physics: {
            /** Apply a continuous force (world units). Call every frame for sustained push. Dynamic only. */
            applyForce(fx, fy) {
                if (window.planck && obj._physicsBody)
                    obj._physicsBody.applyForce(window.planck.Vec2(fx, -fy), obj._physicsBody.getWorldCenter(), true);
            },
            /**
             * Apply an instantaneous impulse (velocity change). Dynamic only.
             * ix/iy in world units/sec. +Y = up.
             */
            applyImpulse(ix, iy) {
                if (window.planck && obj._physicsBody) {
                    const b   = obj._physicsBody;
                    const vel = b.getLinearVelocity();
                    b.setLinearVelocity(window.planck.Vec2(
                        vel.x + ix * 100 / (b.getMass() || 1),
                        vel.y - iy * 100 / (b.getMass() || 1),
                    ));
                }
            },
            /** Set physics body velocity directly (world units/sec, +Y=up). Dynamic bodies only. */
            setVelocity(vx, vy) {
                if (window.planck && obj._physicsBody && obj.physicsBody === 'dynamic')
                    obj._physicsBody.setLinearVelocity(window.planck.Vec2(vx * 100, -vy * 100));
            },
            /**
             * Read this body's actual velocity X in world units/sec.
             * Works for both dynamic and kinematic bodies.
             */
            get velX() {
                if (obj.physicsBody === 'kinematic')
                    return  (obj._kinematicActualVx ?? 0) / 100;
                return  (obj._physicsBody?.getLinearVelocity()?.x ?? 0) / 100;
            },
            /**
             * Read this body's actual velocity Y in world units/sec (+Y = up).
             * Works for both dynamic and kinematic bodies.
             */
            get velY() {
                if (obj.physicsBody === 'kinematic')
                    return -(obj._kinematicActualVy ?? 0) / 100;
                return -(obj._physicsBody?.getLinearVelocity()?.y ?? 0) / 100;
            },
            /**
             * True when this kinematic body is resting on a floor this frame.
             * Use this to stop gravity from accumulating: if (isOnGround()) velocityY = 0;
             */
            get isOnGround()  { return !!obj._isOnGround; },
            /** True when this kinematic body bumped a ceiling this frame. */
            get isOnCeiling() { return !!obj._isOnCeiling; },
            /** True when this kinematic body is pressed against a wall this frame. */
            get isOnWall()    { return !!obj._isOnWall; },
            /** Lock this body completely — nothing can move it, including scripts. */
            setImmovable(val) {
                obj.physicsImmovable = !!val;
                import('./engine.physics.js').then(m => m.rebuildBodyForObject(obj));
            },
            /** Returns true if this body is currently locked immovable. */
            get immovable() { return !!obj.physicsImmovable; },
            /** Zero the physics body velocity (dynamic) or stop kinematic movement. */
            stop() {
                if (obj.physicsBody === 'kinematic') {
                    obj._kinematicVx = 0;
                    obj._kinematicVy = 0;
                    obj._pendingKinematicDelta = { x: 0, y: 0 };
                } else if (window.planck && obj._physicsBody) {
                    obj._physicsBody.setLinearVelocity(window.planck.Vec2(0, 0));
                }
            },
        },

        // ── ANIMATION ────────────────────────────────────────
        playAnimation(name) {
            const idx = obj.animations?.findIndex(a => a.name === name) ?? -1;
            if (idx >= 0) {
                obj.activeAnimIndex = idx;
                try { if (obj._runtimeSprite) obj._runtimeSprite.gotoAndPlay(0); } catch(_) {}
            }
        },
        stopAnimation()  { try { obj._runtimeSprite?.stop(); }    catch(_) {} },
        pauseAnimation() { try { obj._runtimeSprite?.stop(); }    catch(_) {} },
        get currentAnimation() { return obj.animations?.[obj.activeAnimIndex]?.name ?? ''; },

        // ── INPUT ────────────────────────────────────────────
        input: {
            isKeyDown:        k => _keys.has(k.toLowerCase()),
            isKeyJustDown:    k => _keysJustDown.has(k.toLowerCase()),
            isKeyJustUp:      k => _keysJustUp.has(k.toLowerCase()),
            get mouseX()      { return _mouse.x / 100; },
            get mouseY()      { return -_mouse.y / 100; },
            /** Mouse position in world units */
            get worldMouseX() { return _mouse.x / 100; },
            get worldMouseY() { return -_mouse.y / 100; },
            get mouseDown()   { return _mouse.down; },
            get mouseJustDown(){ return _mouse.justDown; },
            get mouseJustUp() { return _mouse.justUp; },
            /** Horizontal axis from A/D or arrow keys: -1, 0, or 1 */
            get axisH() {
                return ((_keys.has('d')||_keys.has('arrowright'))?1:0)
                      -((_keys.has('a')||_keys.has('arrowleft') )?1:0);
            },
            /** Vertical axis from W/S or arrow keys: -1, 0, or 1 */
            get axisV() {
                return ((_keys.has('w')||_keys.has('arrowup')   )?1:0)
                      -((_keys.has('s')||_keys.has('arrowdown')  )?1:0);
            },
        },

        // ── SCENE QUERIES ────────────────────────────────────
        /** Find an object by its exact label/name */
        find(label) {
            const f = state.gameObjects.find(o => o.label === label);
            return f ? _makeProxy(f) : null;
        },
        /** Find the FIRST object with a given tag */
        findWithTag(tag) {
            const set = _tagRegistry.get(tag);
            if (!set || !set.size) return null;
            const [first] = set;
            return _makeProxy(first.obj);
        },
        /** Find ALL objects with a given tag → array of proxies */
        findAllWithTag(tag) {
            const set = _tagRegistry.get(tag);
            if (!set) return [];
            return [...set].map(i => _makeProxy(i.obj));
        },
        /** Find ALL objects in a group → array of proxies */
        findAllInGroup(grp) {
            const set = _groupRegistry.get(grp);
            if (!set) return [];
            return [...set].map(i => _makeProxy(i.obj));
        },

        // ── OVERLAP DETECTION (no physics body needed) ───────
        /**
         * Check if this object overlaps another right now (AABB).
         * Works on any object — no physics body required.
         * Example: if (this.overlaps(this.find("Coin"))) { ... }
         */
        overlaps(other) {
            return _isOverlapping(obj, other?._ref ?? other);
        },
        /**
         * Check if this object overlaps any object with a given tag.
         * Returns the first overlapping object's proxy, or null.
         */
        overlapsTag(tag) {
            const set = _tagRegistry.get(tag);
            if (!set) return null;
            for (const inst of set) {
                if (inst.obj !== obj && _isOverlapping(obj, inst.obj)) return _makeProxy(inst.obj);
            }
            return null;
        },
        /**
         * Get ALL objects with tag that this object overlaps right now.
         */
        overlapsAllWithTag(tag) {
            const set = _tagRegistry.get(tag);
            if (!set) return [];
            const result = [];
            for (const inst of set) {
                if (inst.obj !== obj && _isOverlapping(obj, inst.obj)) result.push(_makeProxy(inst.obj));
            }
            return result;
        },

        // ── DESTROY ──────────────────────────────────────────
        destroySelf()     { obj._markedForDestroy = true; },
        destroy(other)    { if (other?._ref) other._ref._markedForDestroy = true; },

        // ── MESSAGING ────────────────────────────────────────
        /**
         * Send to FIRST object with this tag.
         * Example: this.sendMessage("Enemy", "takeDamage", 10)
         */
        sendMessage(tag, msg, data)      { _sendMessageToTag(String(tag), String(msg), data); },
        /**
         * Send to ALL objects with this tag.
         * Example: this.broadcast("Enemy", "freeze")
         */
        broadcast(tag, msg, data)        { _broadcastToTag(String(tag), String(msg), data); },
        /**
         * Send to all objects in a group.
         */
        broadcastGroup(grp, msg, data)   { _broadcastToGroup(String(grp), String(msg), data); },
        /**
         * Send to every scripted object in the scene.
         */
        broadcastAll(msg, data)          { _broadcastGlobal(String(msg), data); },

        // ── SCENE MANAGEMENT ─────────────────────────────────
        /**
         * Switch scenes. Optionally play a transition effect.
         * gotoScene("Level2")               — instant switch
         * gotoScene(1)                       — by index
         * gotoScene("Level2", "fade")        — fade to black
         * gotoScene("Level2", "fadewhite")   — fade to white
         * gotoScene("Level2", "slide-left")  — slide left
         * gotoScene("Level2", "slide-right") — slide right
         * gotoScene("Level2", "zoom")        — zoom in/out
         */
        gotoScene(nameOrIndex, transition = null) {
            let idx = -1;
            if (typeof nameOrIndex === 'number') {
                idx = nameOrIndex;
            } else {
                idx = state.scenes.findIndex(s => s.name === String(nameOrIndex));
                if (idx === -1) {
                    _logConsole(`[Script] gotoScene("${nameOrIndex}") — not found. Available: ${state.scenes.map(s=>'"'+s.name+'"').join(', ')}`, '#f87171');
                    return;
                }
            }
            if (idx < 0 || idx >= state.scenes.length) {
                _logConsole(`[Script] gotoScene(${idx}) — index out of range (0–${state.scenes.length-1})`, '#f87171');
                return;
            }
            if (state.isPlaying) {
                // Use playModeGotoScene — switches scene while STAYING in play mode,
                // never touching the editor. No flash, no stopPlayMode, no enterPlayMode.
                if (transition) {
                    const t = String(transition);
                    import('./engine.transitions.js').then(tm => {
                        tm.transitionOut(t, 0.5).then(() => {
                            import('./engine.scenes.js').then(sm => {
                                sm.playModeGotoScene(idx, () => tm.transitionIn(t, 0.5));
                            });
                        });
                    });
                } else {
                    import('./engine.scenes.js').then(sm => sm.playModeGotoScene(idx, null));
                }
            } else {
                import('./engine.scenes.js').then(m => m.switchToScene(idx));
            }
        },
        /** Get the name of the current scene */
        get currentScene() { return state.scenes[state.activeSceneIndex]?.name ?? ''; },
        /** Get the index of the current scene */
        get currentSceneIndex() { return state.activeSceneIndex; },
        /** Get total number of scenes */
        get sceneCount() { return state.scenes.length; },
        /** Get the name of a scene by index */
        getSceneName(i) { return state.scenes[i]?.name ?? ''; },

        /**
         * Pause or unpause the current scene from a script.
         * pauseScene()       → pauses  (same as pressing ⏸)
         * pauseScene(false)  → resumes
         * pauseScene(true)   → pauses
         */
        pauseScene(shouldPause = true) {
            if (!state.isPlaying) return;
            if (shouldPause === state.isPaused) return; // already in requested state
            import('./engine.playmode.js').then(m => m.pausePlayMode());
        },

        /**
         * Restart the current scene from scratch — stops all scripts and physics,
         * then reloads the scene snapshot exactly as it was when Play started,
         * without leaving play mode. Great for "Retry" buttons.
         */
        restartScene() {
            if (!state.isPlaying) return;
            const currentIdx = state.activeSceneIndex;
            import('./engine.scenes.js').then(sm => sm.playModeGotoScene(currentIdx));
            _logConsole(`↺ Scene restarted: "${state.scenes[currentIdx]?.name}"`, '#4ade80');
        },

        // ── CAMERA ───────────────────────────────────────────
        camera: _camera,

        // ── SCENE VARIABLES ──────────────────────────────────
        /** Shared across all scripts in this scene. Resets on scene change. */
        get sceneVar() { return _sceneVars; },

        // ── GLOBAL VARIABLES ─────────────────────────────────
        /**
         * Shared across ALL scripts in ALL scenes. Persists until Play stops.
         * Example:  globalVar.score = 0;   globalVar.score += 10;
         * Any script can read/write the same values.
         */
        get globalVar() { return _globalVars; },

        // ── SOUND ─────────────────────────────────────────────
        /**
         * Play a sound asset by name.
         * soundPlay("Jump", { x:0, y:0, loop:false, range:400, volume:1.0 })
         */
        soundPlay(assetName, opts = {}) {
            const asset = state.assets.find(a => a.label === assetName || a.name === assetName);
            if (!asset) { _logConsole(`soundPlay: asset "${assetName}" not found`, '#facc15'); return; }
            import('./engine.audio.js').then(m => {
                m._playScriptSound(asset, {
                    x:      (opts.x ?? obj.x / 100),
                    y:      (opts.y ?? -obj.y / 100),
                    loop:   opts.loop   ?? false,
                    range:  opts.range  ?? 400,
                    volume: opts.volume ?? 1.0,
                    id:     assetName,
                });
            });
        },
        /**
         * Stop a specific sound by name.
         * soundStop("Jump")
         */
        soundStop(assetName) {
            import('./engine.audio.js').then(m => m._stopScriptSound(assetName));
        },
        /** Stop all currently playing sounds */
        soundStopAll() {
            import('./engine.audio.js').then(m => m._stopAllScriptSounds());
        },

        // ── TIMERS ────────────────────────────────────────────
        /**
         * Wait a number of seconds then call a function.
         * Works inside onUpdate — call once and it schedules itself.
         * Example:  wait(2, () => { log("2 seconds passed!"); });
         */
        wait(seconds, fn) {
            _scheduleTimer(seconds, fn, this.name ?? 'wait()', obj?.label ?? '?');
        },

        // ── PHYSICS CONTROL FROM SCRIPT ───────────────────────
        /**
         * Change this object's physics body type at runtime.
         * setPhysicsType("static") | "kinematic" | "dynamic" | "none"
         * static    = immovable, infinite mass, not affected by any force.
         * kinematic = script-controlled, no gravity, pushes dynamic bodies.
         * dynamic   = full physics (gravity + forces + collisions).
         */
        setPhysicsType(type) {
            obj.physicsBody = type;
            // Rebuild the physics body at runtime if physics is running
            if (state.isPlaying) {
                import('./engine.physics.js').then(m => m.rebuildBodyForObject(obj));
            }
        },
        /**
         * Enable or disable collision detection for this object.
         * setCollision(false) — object passes through everything (sensor).
         */
        setCollision(enabled) {
            obj.physicsIsSensor = !enabled;
            if (obj._physicsBody && window.planck) {
                for (let f = obj._physicsBody.getFixtureList(); f; f = f.getNext()) f.setSensor(!enabled);
            }
        },
        /**
         * Make this object a sensor (detects overlaps but no physical response).
         */
        setSensor(v) {
            obj.physicsIsSensor = !!v;
            if (obj._physicsBody && window.planck) {
                for (let f = obj._physicsBody.getFixtureList(); f; f = f.getNext()) f.setSensor(!!v);
            }
        },
        /**
         * Set which collision category layer this object belongs to.
         * setCollisionCategory(2)
         */
        setCollisionCategory(cat) {
            obj.physicsCollisionCategory = cat;
            if (obj._physicsBody && window.planck) {
                for (let f = obj._physicsBody.getFixtureList(); f; f = f.getNext()) {
                    const fd = f.getFilterData();
                    f.setFilterData({ ...fd, categoryBits: cat & 0xFFFF });
                }
            }
        },
        /**
         * Set which categories this object collides with (bitmask).
         * setCollisionMask(-1) = collide with everything (default)
         * setCollisionMask(0)  = collide with nothing
         */
        setCollisionMask(mask) {
            obj.physicsCollisionMask = mask;
            if (obj._physicsBody && window.planck) {
                for (let f = obj._physicsBody.getFixtureList(); f; f = f.getNext()) {
                    const fd = f.getFilterData();
                    f.setFilterData({ ...fd, maskBits: mask >>> 0 & 0xFFFF });
                }
            }
        },

        // ── SPRITE TINT ───────────────────────────────────────
        /**
         * Set this object's tint colour.
         * tint("#ff0000") or tint(0xff0000)
         * tint(null) or tint("#ffffff") to remove tint.
         */
        get tint() {
            const t = obj.spriteGraphic?.tint;
            return t !== undefined ? '#' + t.toString(16).padStart(6, '0') : '#ffffff';
        },
        set tint(v) {
            const hex = typeof v === 'string'
                ? parseInt(v.replace('#',''), 16)
                : (v ?? 0xffffff);
            obj._scriptTint = hex;
            if (obj.spriteGraphic) obj.spriteGraphic.tint = hex;
        },

        // ── DISTANCE ─────────────────────────────────────────
        /**
         * Get the distance from this object to another position or object.
         * distanceTo(other)         — proxy from find/findWithTag
         * distanceTo(x, y)          — world coordinates
         * distanceTo("player")      — tag name (finds first object with that tag)
         */
        distanceTo(targetOrX, y) {
            let tx, ty;
            if (typeof targetOrX === 'string') {
                const found = _tagRegistry.get(targetOrX);
                if (!found || !found.size) return Infinity;
                const [first] = found;
                tx = first.obj.x / 100;
                ty = -first.obj.y / 100;
            } else if (targetOrX && typeof targetOrX === 'object' && '_ref' in targetOrX) {
                tx = targetOrX.x;
                ty = targetOrX.y;
            } else if (typeof targetOrX === 'number') {
                tx = targetOrX;
                ty = y ?? 0;
            } else {
                return Infinity;
            }
            const ox = obj.x / 100;
            const oy = -obj.y / 100;
            return Math.sqrt((tx - ox) ** 2 + (ty - oy) ** 2);
        },

        // ── TIME ─────────────────────────────────────────────
        /** Total seconds since Play was pressed */
        get time()    { return performance.now() / 1000; },
        get elapsed() { return performance.now() / 1000; },

        // ── MATH ─────────────────────────────────────────────
        math: {
            lerp:    (a,b,t)      => a + (b-a) * Math.max(0,Math.min(1,t)),
            clamp:   (v,lo,hi)    => Math.max(lo, Math.min(hi,v)),
            dist:    (x1,y1,x2,y2) => Math.sqrt((x2-x1)**2+(y2-y1)**2),
            rand:    (mn,mx)      => Math.random()*(mx-mn)+mn,
            randInt: (mn,mx)      => Math.floor(Math.random()*(mx-mn+1))+mn,
            sign:    v            => Math.sign(v),
            toRad:   d            => d * Math.PI / 180,
            toDeg:   r            => r * 180 / Math.PI,
            map:     (v,a1,b1,a2,b2) => a2 + (b2-a2)*((v-a1)/(b1-a1)),
            wrap:    (v,mn,mx)    => ((v-mn)%(mx-mn)+(mx-mn))%(mx-mn)+mn,
            sin:  Math.sin,  cos:  Math.cos,  tan:   Math.tan,
            abs:  Math.abs,  sqrt: Math.sqrt, pow:   Math.pow,
            atan2:Math.atan2,floor:Math.floor,ceil:  Math.ceil,
            round:Math.round,PI:   Math.PI,   max:   Math.max,  min: Math.min,
        },

        // ── DEBUG ─────────────────────────────────────────────
        log(...a)   { _logConsole(`[${obj.label}] ${a.map(String).join(' ')}`, '#9bc');    },
        warn(...a)  { _logConsole(`[${obj.label}] ⚠ ${a.map(String).join(' ')}`, '#facc15'); },
        error(...a) { _logConsole(`[${obj.label}] ✖ ${a.map(String).join(' ')}`, '#f87171'); },

        // ── PER-OBJECT STORE (lives only during play session) ─
        store: (() => {
            const d = {};
            return {
                set(k, v)   { d[k] = v; },
                get(k, def) { return k in d ? d[k] : def; },
                has(k)      { return k in d; },
                del(k)      { delete d[k]; },
            };
        })(),

        // ── TWEEN — animate properties over time ─────────────
        /**
         * Animate this object's properties smoothly over time.
         * tween({ alpha:0 }, 0.5)
         * tween({ x:5, scaleX:2 }, 1, "easeOut")
         * tween({ rotation:360 }, 2, "linear", () => log("done"))
         *
         * Supported props: x, y, alpha, scaleX, scaleY, rotation, scale
         * Easings: "linear","easeIn","easeOut","easeInOut","easeInCubic","easeOutCubic",
         *          "elastic","elasticOut","bounce","steps2","steps4"
         */
        tween(props, duration = 0.3, easing = 'linear', onComplete = null) {
            if (!props || typeof props !== 'object') return;
            const entries = [];
            for (const [key, to] of Object.entries(props)) {
                let from;
                switch (key) {
                    case 'x':        from = api.x;        break;
                    case 'y':        from = api.y;        break;
                    case 'alpha':    from = api.alpha;    break;
                    case 'scaleX':   from = api.scaleX;   break;
                    case 'scaleY':   from = api.scaleY;   break;
                    case 'rotation': from = api.rotation; break;
                    case 'scale':    from = api.scaleX;   break;
                    default: continue;
                }
                entries.push({ key, from: Number(from), to: Number(to) });
            }
            if (entries.length > 0)
                _tweens.push({ entries, duration: Math.max(0, duration), elapsed: 0, easing: String(easing), onComplete });
        },

        // ── REPEAT TIMERS ─────────────────────────────────────
        /**
         * Call a function repeatedly every `interval` seconds.
         * Returns an ID you can pass to cancelRepeat().
         * var id = repeat(1.5, () => { spawnEnemy(); })
         */
        repeat(interval, fn) {
            const id = ++_repeatIdCounter;
            _repeats.push({ id, interval: Math.max(0.016, interval), elapsed: Math.max(0.016, interval), fn });
            return id;
        },
        /** Cancel a repeating timer returned by repeat(). */
        cancelRepeat(id) {
            const idx = _repeats.findIndex(r => r.id === id);
            if (idx !== -1) _repeats.splice(idx, 1);
        },

        // ── SPAWN OBJECT ──────────────────────────────────────
        /**
         * Create a new object from an asset at a world position.
         * spawnObject("Bullet", x, y, (obj) => { obj.velocityX = 10; })
         * The callback receives a proxy to the new object.
         */
        spawnObject(assetName, wx, wy, onSpawned = null) {
            const asset = state.assets.find(a => a.label === assetName || a.name === assetName || a.id === assetName);
            if (!asset) { _logConsole(`spawnObject: asset "${assetName}" not found`, '#facc15'); return null; }
            import('./engine.objects.js').then(({ createImageObject }) => {
                const newObj = createImageObject(asset, wx * 100, -wy * 100);
                if (!newObj) return;
                if (newObj._gizmoContainer) newObj._gizmoContainer.visible = false;
                if (onSpawned) {
                    try { onSpawned(_makeProxy(newObj)); }
                    catch (e) {
                        const friendly = _friendlyScriptError(e, null, 'spawnObject callback', obj?.label ?? '?', 'onSpawned');
                        for (const line of friendly) _logConsole(line, '#f87171');
                        import('./engine.console.js').then(m => m.recordPlayError());
                    }
                }
            });
        },

        // ── RAYCAST (AABB-based) ──────────────────────────────
        /**
         * Cast a ray from (x1,y1) to (x2,y2) and return the first object hit.
         * raycast(0, 0, 10, 0)            — hit any object
         * raycast(0, 0, 10, 0, "enemy")   — hit only objects tagged "enemy"
         * Returns: proxy or null
         */
        raycast(x1, y1, x2, y2, tag = null) {
            const px1 = x1 * 100, py1 = -y1 * 100;
            const px2 = x2 * 100, py2 = -y2 * 100;
            const dx = px2 - px1, dy = py2 - py1;
            const len2 = dx * dx + dy * dy;
            if (len2 === 0) return null;

            const candidates = tag
                ? [...(_tagRegistry.get(tag) || [])].map(i => i.obj)
                : state.gameObjects;

            let best = null, bestT = 2;
            for (const o of candidates) {
                if (o === obj) continue;
                const bb = _getAABB(o);
                const cx = (bb.left + bb.right)  / 2;
                const cy = (bb.top  + bb.bottom) / 2;
                const t  = Math.max(0, Math.min(1, ((cx - px1) * dx + (cy - py1) * dy) / len2));
                const closestX = px1 + t * dx;
                const closestY = py1 + t * dy;
                const hw = (bb.right - bb.left) / 2;
                const hh = (bb.bottom - bb.top) / 2;
                if (Math.abs(closestX - cx) <= hw && Math.abs(closestY - cy) <= hh) {
                    if (t < bestT) { bestT = t; best = o; }
                }
            }
            return best ? _makeProxy(best) : null;
        },

        // ── RADIUS QUERY ──────────────────────────────────────
        /**
         * Find all objects within a circle radius in world units.
         * getObjectsInRadius(3, 4, 2)            — all objects within 2 units
         * getObjectsInRadius(3, 4, 2, "coin")    — only "coin" tagged objects
         * Returns: array of proxies
         */
        getObjectsInRadius(cx, cy, radius, tag = null) {
            const px  = cx * 100, py = -cy * 100;
            const pr2 = (radius * 100) ** 2;
            const candidates = tag
                ? [...(_tagRegistry.get(tag) || [])].map(i => i.obj)
                : state.gameObjects;
            const result = [];
            for (const o of candidates) {
                if (o === obj) continue;
                const ddx = o.x - px, ddy = o.y - py;
                if (ddx * ddx + ddy * ddy <= pr2) result.push(_makeProxy(o));
            }
            return result;
        },

        // ── Z-ORDER ───────────────────────────────────────────
        /** Set render order (higher = drawn on top). */
        setZOrder(n) {
            obj.zIndex = n;
            if (obj.parent?.sortChildren) obj.parent.sortChildren();
            else if (obj.parent) {
                // Manual sort for PIXI containers without sortableChildren
                obj.parent.children.sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
            }
        },
        /** Get current render order. */
        getZOrder() { return obj.zIndex ?? 0; },

        // ── COORDINATE CONVERSION ─────────────────────────────
        /**
         * Convert screen pixel position → world units.
         * var pos = screenToWorld(e.clientX, e.clientY)
         * log(pos.x, pos.y)
         */
        screenToWorld(sx, sy) {
            const sc = state.sceneContainer;
            if (!sc) return { x: 0, y: 0 };
            return {
                x:  (sx - sc.x) / (sc.scale.x * 100),
                y: -(sy - sc.y) / (sc.scale.y * 100),
            };
        },
        /** Convert world position → screen pixels. */
        worldToScreen(wx, wy) {
            const sc = state.sceneContainer;
            if (!sc) return { x: 0, y: 0 };
            return {
                x:  wx * 100 * sc.scale.x + sc.x,
                y: -wy * 100 * sc.scale.y + sc.y,
            };
        },

        // ── KEY EVENT HANDLERS ────────────────────────────────
        /**
         * Register a callback fired once when a key is pressed.
         * onKeyDown("space", () => { jump(); })
         */
        onKeyDown(key, fn) { _keyDownHandlers.set(key.toLowerCase(), fn); },
        /** Register a callback fired once when a key is released. */
        onKeyUp(key, fn)   { _keyUpHandlers.set(key.toLowerCase(), fn); },

        // ── MOBILE / GESTURE HANDLERS (Hammer.js) ─────────────
        /**
         * Register a swipe handler.
         * direction: "left" | "right" | "up" | "down" | "any"
         * fn receives the direction string when triggered.
         */
        onSwipe(direction, fn) {
            const d = String(direction).toLowerCase();
            _swipeHandlers.set(d, fn);
        },
        /** Register a pinch (two-finger zoom) handler. fn receives the scale factor. */
        onPinch(fn) { _pinchHandler = fn; },
        /** Register a tap handler (short touch). */
        onTap(fn)   { _tapHandler   = fn; },

        // Expose gesture maps so ScriptInstance can wire Hammer.js
        get _swipeHandlers() { return _swipeHandlers; },
        get _pinchHandler()  { return _pinchHandler;  },
        get _tapHandler()    { return _tapHandler;    },

        // ── PHYSICS HELPERS ───────────────────────────────────
        /**
         * Change this object's physics gravity scale.
         * setGravityScale(0) — floats freely
         * setGravityScale(2) — falls twice as fast
         */
        setGravityScale(n) {
            obj.physicsGravityScale = n;
        },
        /** Actual physics body velocity X in world units/sec (dynamic or kinematic). */
        getPhysicsVelX() {
            if (obj.physicsBody === 'kinematic')
                return  (obj._kinematicActualVx ?? 0) / 100;
            return  (obj._physicsBody?.getLinearVelocity()?.x ?? 0) / 100;
        },
        /** Actual physics body velocity Y in world units/sec +Y=up (dynamic or kinematic). */
        getPhysicsVelY() {
            if (obj.physicsBody === 'kinematic')
                return -(obj._kinematicActualVy ?? 0) / 100;
            return -(obj._physicsBody?.getLinearVelocity()?.y ?? 0) / 100;
        },

        // ── MATH EXTRAS ───────────────────────────────────────
        /**
         * smoothstep(lo, hi, x) — smooth S-curve interpolation between lo and hi.
         * Returns 0 below lo, 1 above hi, smooth in-between.
         */
        smoothstep(lo, hi, x) {
            const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
            return t * t * (3 - 2 * t);
        },
        /**
         * Normalize a 2D vector (make its length = 1).
         * var n = normalize(dx, dy)   →  { x, y }
         */
        normalize(vx, vy) {
            const len = Math.sqrt(vx * vx + vy * vy);
            return len > 0 ? { x: vx / len, y: vy / len } : { x: 0, y: 0 };
        },
        /**
         * Angle from point A to point B in degrees.
         * var deg = angleTo(x1,y1, x2,y2)
         */
        angleTo(x1, y1, x2, y2) {
            return Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
        },
        /**
         * Returns true if the value has changed direction compared to last check
         * (useful for walking animations).
         */
        hasSignChanged(prev, curr) { return Math.sign(prev) !== Math.sign(curr) && curr !== 0; },

        // ── DEBUG DRAW ────────────────────────────────────────
        /**
         * Draw a temporary line in the scene (only visible during Play).
         * drawDebugLine(0, 0, 5, 5)                   — white line for 1 frame
         * drawDebugLine(0, 0, 5, 5, "#ff0000", 0.5)   — red line for 0.5 sec
         * drawDebugLine(0, 0, 5, 5, "#00ff00", 1, 3)  — green, 1s, 3px wide
         */
        drawDebugLine(x1, y1, x2, y2, color = '#ffffff', duration = 0, width = 2) {
            _debugLines.push({ x1, y1, x2, y2, color, remaining: Math.max(0.016, duration), width, alpha: 0.85 });
        },
        /**
         * Draw a temporary circle outline.
         * drawDebugCircle(x, y, radius)
         * drawDebugCircle(x, y, 1.5, "#ff0000", 1)
         */
        drawDebugCircle(cx, cy, radius, color = '#ffffff', duration = 0, width = 2) {
            _debugLines.push({ x1: cx, y1: cy, x2: cx, y2: cy, circle: radius, color, remaining: Math.max(0.016, duration), width, alpha: 0.85 });
        },
    };

    return { api, _keys, _keysJustDown, _keysJustUp, _mouse, _tweens, _repeats, _keyDownHandlers, _keyUpHandlers };
}

// ── Object proxy (returned by find / findWithTag etc.) ────────
function _makeProxy(f) {
    return {
        _ref:         f,
        get name()    { return f.label; },
        get tag()     { return f._scriptTag   ?? ''; },
        get group()   { return f._scriptGroup ?? ''; },
        /** World X of the found object */
        get x()       { return  f.x  / 100; },
        /** World Y of the found object */
        get y()       { return -f.y  / 100; },
        get visible() { return f.visible; },
        set visible(v){ f.visible = !!v; },
        get alpha()   { return f.alpha; },
        set alpha(v)  { f.alpha = v; },

        // ── Text object helpers ───────────────────────────────
        /**
         * Get or set the text content of a Text object.
         * Usage:  find("ScoreLabel").text = score + " pts";
         */
        get text() { return f.isText ? (f.textContent ?? '') : ''; },
        set text(v) {
            if (!f.isText || !f._pixiText) return;
            f.textContent  = String(v);
            f._pixiText.text = String(v);
        },
        /**
         * Set text content — callable form.
         * find("ScoreLabel").setText("New text")
         */
        setText(v) {
            if (!f.isText || !f._pixiText) return;
            f.textContent  = String(v);
            f._pixiText.text = String(v);
        },
        /**
         * Change text style properties at runtime.
         * find("Title").setTextStyle({ fontSize: 48, fill: "#ff0000" })
         * Supported keys: fontSize, fontFamily, fill, stroke, strokeThickness,
         *   align, bold, italic, dropShadow, wordWrap, wordWrapWidth
         */
        setTextStyle(opts = {}) {
            if (!f.isText || !f._pixiText) return;
            import('./engine.objects.js').then(({ setTextStyle }) => setTextStyle(f, opts));
        },

        /** Send a message directly to this specific object */
        sendMessage(msg, data) {
            const inst = _instances.find(i => i.obj === f);
            if (inst) _deliverMsg(inst, msg, data);
        },
    };
}

// ── Script Instance ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
// SMART SCRIPT SAFETY LAYER
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Pre-flight scan of user script code.
 * Returns { fatal: bool, messages: string[] }
 * fatal=true  → script is blocked from running entirely (engine-breaking)
 * fatal=false → warnings only, script still runs but user is informed
 */
function _scanScriptForDangers(code, scriptName, objLabel) {
    const prefix  = `[Script "${scriptName}" on "${objLabel}"]`;
    const messages = [];
    let fatal = false;

    // Strip comments and string literals to avoid false positives
    const stripped = code
        .replace(/\/\/[^\n]*/g, ' ')          // line comments
        .replace(/\/\*[\s\S]*?\*\//g, ' ')    // block comments
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')  // double-quoted strings
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")  // single-quoted strings
        .replace(/`(?:[^`\\]|\\.)*`/g, '``'); // template literals

    // ── FATAL: engine-breaking patterns ──────────────────────────────────────
    const fatalPatterns = [
        { re: /\bdocument\.write\s*\(/,        msg: 'document.write() destroys the engine canvas — use log() to print values instead.' },
        { re: /\bdocument\.body\s*=\s*/,       msg: 'Assigning to document.body will break the engine UI.' },
        { re: /\blocation\s*\.\s*(?:href|replace|assign)\s*=/,
                                                msg: 'Redirecting location.href will leave the engine — use gotoScene() to change scenes.' },
        { re: /\blocation\s*=\s*/,             msg: 'Assigning to location will navigate away from the engine.' },
        { re: /\bdocument\.open\s*\(/,         msg: 'document.open() clears the page — use log() to print output.' },
        { re: /\bwindow\s*\.\s*onload\s*=/,    msg: 'Overwriting window.onload will break engine startup.' },
        { re: /\bwhile\s*\(\s*true\s*\)\s*\{(?!\s*\/\/.*break)/,
                                                msg: 'while(true){} without a break will freeze the engine. Use onUpdate(fn) for repeating logic.' },
        { re: /\bfor\s*\(\s*;;\s*\)\s*\{/,    msg: 'for(;;){} infinite loop will freeze the engine. Use onUpdate(fn) for repeating logic.' },
        { re: /\bdocument\.getElementById\s*\([^)]+\)\s*\.innerHTML\s*=/,
                                                msg: 'Writing innerHTML to engine DOM elements can destroy the UI. Use the engine API instead.' },
    ];

    for (const { re, msg } of fatalPatterns) {
        if (re.test(stripped)) {
            messages.push(`${prefix} 🚫 BLOCKED — ${msg}`);
            fatal = true;
        }
    }

    // ── WARNINGS: potentially harmful but not always fatal ───────────────────
    const warnPatterns = [
        { re: /\bdocument\.querySelector\s*\(/,
          msg: `Accessing DOM elements directly may interfere with the engine UI. Consider using the engine API (log, spawnObject, etc.) instead.` },
        { re: /\bsetInterval\s*\(/,
          msg: `setInterval() persists after Play stops and can slow down the browser. Use repeat(fn, seconds) instead.` },
        { re: /\bsetTimeout\s*\(/,
          msg: `setTimeout() may fire after Play stops. Use wait(seconds, fn) instead for engine-aware delays.` },
        { re: /\bXMLHttpRequest\b|\bfetch\s*\(/,
          msg: `Network calls (fetch/XHR) may not resolve and can slow play mode. Cache data before pressing Play.` },
        { re: /\bconsole\s*\.\s*log\s*\(/,
          msg: `console.log() output goes to the browser devtools, not the engine console. Use log() instead.` },
        { re: /\balert\s*\(/,
          msg: `alert() pauses the whole browser tab. Use log() to print messages to the engine console.` },
        { re: /\beval\s*\(/,
          msg: `eval() is unsafe and may throw Content-Security-Policy errors. Build logic directly in the script.` },
        { re: /new\s+Function\s*\(/,
          msg: `new Function() is unsafe and may be blocked by CSP. Build logic directly in the script.` },
    ];

    for (const { re, msg } of warnPatterns) {
        if (re.test(stripped)) {
            messages.push(`${prefix} ⚠ ${msg}`);
        }
    }

    return { fatal, messages };
}

/**
 * Turn a caught JS Error into helpful, actionable console lines.
 * Returns an array of strings to log (first is the main error, rest are hints).
 */
function _friendlyScriptError(err, code, scriptName, objLabel, phase) {
    const prefix = `[Script "${scriptName}" on "${objLabel}"] ✖ ${phase} error`;
    const msg    = err?.message ?? String(err);
    const lines  = [`${prefix}: ${msg}`];

    // ── Line number extraction (works across Chrome, Firefox, Safari) ────────
    let lineNum = null;
    if (err?.lineNumber) {
        // Firefox gives lineNumber directly
        lineNum = err.lineNumber;
    } else if (err?.stack) {
        // Chrome/Edge: look for  <anonymous>:NN:CC  or  Function:NN:CC
        const m = err.stack.match(/<anonymous>:(\d+)|\bFunction\b[^:]*:(\d+)|\bat eval[^:]*:(\d+)/);
        if (m) lineNum = parseInt(m[1] ?? m[2] ?? m[3], 10);
    }

    // Adjust for prelude offset: the prelude injected before user code is ~597 lines
    const PRELUDE_LINES = 597;
    if (lineNum != null && lineNum > PRELUDE_LINES) {
        const userLine = lineNum - PRELUDE_LINES;
        lines[0] += ` (your script line ~${userLine})`;

        // Show the offending source line if code is available
        if (code) {
            const codeLines = code.split('\n');
            if (userLine >= 1 && userLine <= codeLines.length) {
                const srcLine = codeLines[userLine - 1]?.trim();
                if (srcLine) lines.push(`  → ${srcLine}`);
            }
        }
    }

    // ── Actionable fix hints ─────────────────────────────────────────────────
    const hint = _getErrorHint(msg, err?.stack ?? '');
    if (hint) lines.push(`  💡 ${hint}`);

    return lines;
}

/**
 * Map common error messages to actionable fix suggestions.
 */
function _getErrorHint(msg, stack) {
    const m = msg.toLowerCase();

    if (m.includes('is not defined')) {
        const name = msg.match(/(\w+) is not defined/i)?.[1];
        if (name) {
            // Check if it looks like a common typo of an engine function
            const apiNames = ['log','warn','error','gotoScene','spawnObject','destroy','setPos','getPos',
                'velocityX','velocityY','onStart','onUpdate','onStop','onCollisionEnter','isKeyDown',
                'isKeyJustDown','mouseX','mouseY','sceneVar','globalVar','soundPlay','wait','repeat'];
            const similar = apiNames.find(a => _levenshtein(a.toLowerCase(), name.toLowerCase()) <= 2 && a !== name);
            if (similar) return `Did you mean "${similar}"? Check the API reference (? button in the toolbar).`;
            return `"${name}" hasn't been declared. Check for typos, or declare it with: var ${name} = ...`;
        }
    }

    if (m.includes('cannot read propert') || m.includes("cannot read properties of")) {
        const prop = msg.match(/reading '(\w+)'/i)?.[1];
        if (prop) return `A variable you're reading "${prop}" from is null or undefined. Add a null check: if (obj) obj.${prop}`;
        return 'A variable is null or undefined. Add a null check before accessing its properties.';
    }

    if (m.includes('is not a function')) {
        const name = msg.match(/(\S+) is not a function/i)?.[1];
        if (name) return `"${name}" is not callable. Check the spelling and make sure it's a function, not a variable.`;
    }

    if (m.includes('stack overflow') || m.includes('maximum call stack')) {
        return 'A function is calling itself forever (infinite recursion). Make sure recursive calls have an exit condition.';
    }

    if (m.includes('rangeerror') || m.includes('invalid array length')) {
        return 'An array or number is out of valid range. Check loops and array indices.';
    }

    if (m.includes('syntaxerror') || m.includes('unexpected token') || m.includes('unexpected end')) {
        return 'The script has a syntax error. Check for missing brackets }, parentheses ), or semicolons.';
    }

    if (m.includes('typeerror') && m.includes('assignment')) {
        return 'You tried to assign to a read-only or const value. Use "var" or "let" for your own variables.';
    }

    return null;
}

/** Levenshtein distance for typo detection */
function _levenshtein(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++)
            dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
                : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    return dp[a.length][b.length];
}

// ══════════════════════════════════════════════════════════════════════════════

class ScriptInstance {
    constructor(obj, name, code) {
        this.obj              = obj;
        this.name             = name;
        // All registered callbacks
        this._onStart         = null;
        this._onUpdate        = null;
        this._onStop          = null;
        this._onCollisionEnter= null;  // fired once when collision begins
        this._onCollisionStay = null;  // fired every frame while colliding
        this._onCollisionExit = null;  // fired once when collision ends
        this._onOverlapEnter  = null;  // AABB overlap starts
        this._onOverlapExit   = null;  // AABB overlap ends
        this._onVisible       = null;
        this._onHide          = null;
        this._onMouseClick    = null;
        this._onMouseEnter    = null;
        this._onMouseLeave    = null;
        this._messageHandlers = new Map();

        // Collision / overlap tracking
        this._activeCollisions = new Set(); // Set of other obj refs currently colliding
        this._activeOverlaps   = new Set(); // Set of other obj refs currently overlapping

        // instRef array so _buildSandbox can back-reference this instance
        const instRef = [null];
        const { api, _keys, _keysJustDown, _keysJustUp, _mouse,
                _tweens, _repeats, _keyDownHandlers, _keyUpHandlers } = _buildSandbox(obj, instRef);
        instRef[0]          = this;
        this.api            = api;
        this._keys          = _keys;
        this._keysJustDown  = _keysJustDown;
        this._keysJustUp    = _keysJustUp;
        this._mouse         = _mouse;
        this._tweens        = _tweens;
        this._repeats       = _repeats;
        this._keyDownHandlers = _keyDownHandlers;
        this._keyUpHandlers   = _keyUpHandlers;
        this._compile(code, api);
    }

    _compile(code, api) {
        // ── The full scripting prelude — everything accessible in scripts ──
        const prelude = `
"use strict";
var _onStart=null, _onUpdate=null, _onStop=null;
var _onCollisionEnter=null, _onCollisionStay=null, _onCollisionExit=null;
var _onOverlapEnter=null, _onOverlapExit=null;
var _onVisible=null, _onHide=null, _onMouseClick=null, _onMouseEnter=null, _onMouseLeave=null;
var _msgHandlers = new Map();

// ═══════════════════════════════════════════════════════════════
// EVENT REGISTRATION
// Register functions to run at specific moments in the game loop.
// ═══════════════════════════════════════════════════════════════

/** Runs once when Play is pressed */
function onStart(fn)             { _onStart          = fn; }
/** Runs every frame. dt = seconds since last frame (use for smooth movement) */
function onUpdate(fn)            { _onUpdate         = fn; }
/** Runs once when Play is stopped */
function onStop(fn)              { _onStop           = fn; }
/** Runs once when this object begins touching another (physics) */
function onCollisionEnter(fn)    { _onCollisionEnter = fn; }
/** Runs every frame while this object is still touching another (physics) */
function onCollisionStay(fn)     { _onCollisionStay  = fn; }
/** Runs once when this object stops touching another (physics) */
function onCollisionExit(fn)     { _onCollisionExit  = fn; }
/** Runs once when this object's AABB begins overlapping another (no physics needed) */
function onOverlapEnter(fn)      { _onOverlapEnter   = fn; }
/** Runs once when this object's AABB stops overlapping another */
function onOverlapExit(fn)       { _onOverlapExit    = fn; }
/** Runs when this object becomes visible */
function onBecomeVisible(fn)     { _onVisible        = fn; }
/** Runs when this object becomes hidden */
function onBecomeHidden(fn)      { _onHide           = fn; }
/** Runs when this object is clicked */
function onMouseClick(fn)        { _onMouseClick     = fn; }
/** Runs when the mouse enters this object's area */
function onMouseEnter(fn)        { _onMouseEnter     = fn; }
/** Runs when the mouse leaves this object's area */
function onMouseLeave(fn)        { _onMouseLeave     = fn; }
/**
 * Runs when this object receives a message.
 * Example: onMessage("takeDamage", (amount) => { ... })
 */
function onMessage(msg, fn)      { _msgHandlers.set(String(msg), fn); }

// ═══════════════════════════════════════════════════════════════
// THIS OBJECT — use "this." prefix for clarity
// All of these refer to the object this script is attached to.
// ═══════════════════════════════════════════════════════════════
var self = api;  // "self" is a backup alias for "this"

// ── Position ──────────────────────────────────────────────────
/** this.x — world X position of this object */
function getX()        { return api.x; }
function setX(v)       { api.x = v; }
/** this.y — world Y position (positive = up) */
function getY()        { return api.y; }
function setY(v)       { api.y = v; }
/** Move by (dx, dy) world units */
function move(dx, dy)  { api.move(dx, dy); }
/** Same as move */
function translate(dx, dy) { api.move(dx, dy); }
/** Warp this object to exact position */
function moveTo(x, y)  { api.moveTo(x, y); }
/** Move in the direction this object is currently facing */
function moveForward(speed) { api.moveForward(speed); }
/** Rotate this object to face a world position */
function lookAt(tx, ty){ api.lookAt(tx, ty); }
function flipX()       { api.flipX(); }
function flipY()       { api.flipY(); }
/** Width of this object in world units */
function getWidth()    { return api.width; }
/** Height of this object in world units */
function getHeight()   { return api.height; }

// ── Rotation and scale ────────────────────────────────────────
/** this.rotation — degrees (clockwise positive) */
function getRotation()   { return api.rotation; }
function setRotation(v)  { api.rotation = v; }
/** this.scaleX / this.scaleY */
function getScaleX()     { return api.scaleX; }
function setScaleX(v)    { api.scaleX = v; }
function getScaleY()     { return api.scaleY; }
function setScaleY(v)    { api.scaleY = v; }

// ── Velocity (applied every frame automatically) ─────────────
/**
 * this.velocityX / vx — horizontal speed in world units/second.
 * Set this and the object moves that direction automatically.
 * Example: this.velocityX = 5;  // moves right at 5 units/sec
 */
var velocityX = 0;
var velocityY = 0;
var vx = 0;
var vy = 0;
function setVelocity(x, y)  { api.setVelocity(x, y); velocityX=x; vx=x; velocityY=y; vy=y; }
function stopMovement()     { api.stopMovement(); velocityX=0; vx=0; velocityY=0; vy=0; }
function bounceX()          { api.bounceX(); velocityX=api.velocityX; vx=velocityX; }
function bounceY()          { api.bounceY(); velocityY=api.velocityY; vy=velocityY; }
function _syncVelocityToApi() { api._vel.x = velocityX; api._vel.y = velocityY; vx = velocityX; vy = velocityY; }

// ── Manual gravity ────────────────────────────────────────────
/**
 * Apply gravity to this object (world units/s²).
 * Call once in onStart to enable:
 *   this.gravity(0, -9.8)   ← falls downward every frame
 *   this.gravity(0, 0)      ← disable gravity
 */
function gravity(gx, gy) { api.gravity(gx, gy); }

// ── Display ───────────────────────────────────────────────────
function show()           { api.visible = true; }
function hide()           { api.visible = false; }
function getVisible()     { return api.visible; }
function setVisible(v)    { api.visible = v; }
function getAlpha()       { return api.alpha; }
function setAlpha(v)      { api.alpha = v; }
function fadeIn(t, dt)    { api.alpha = Math.min(1, api.alpha + dt/Math.max(0.001,t)); }
function fadeOut(t, dt)   { api.alpha = Math.max(0, api.alpha - dt/Math.max(0.001,t)); }

// ── Tag and group ─────────────────────────────────────────────
/**
 * this.tag — label for this object (used in findWithTag, sendMessage).
 * Set it in onStart:  setTag("player")
 */
function setTag(t)        { api.tag   = t; }
function getTag()         { return api.tag; }
function setGroup(g)      { api.group = g; }
function getGroup()       { return api.group; }

// ── Messaging ─────────────────────────────────────────────────
/**
 * Send a message to the FIRST object with this tag.
 * Example: sendMessage("Enemy", "takeDamage", 10)
 * On the receiving end: onMessage("takeDamage", (amount) => { ... })
 */
function sendMessage(tag, msg, data)      { api.sendMessage(tag, msg, data); }
/**
 * Send to ALL objects with this tag.
 * Example: broadcast("Enemy", "freeze")
 */
function broadcast(tag, msg, data)        { api.broadcast(tag, msg, data); }
/**
 * Send to all objects in a group.
 * Example: broadcastGroup("wave1", "explode")
 */
function broadcastGroup(grp, msg, data)   { api.broadcastGroup(grp, msg, data); }
/**
 * Send to EVERY scripted object in the scene.
 * Example: broadcastAll("gameOver")
 */
function broadcastAll(msg, data)          { api.broadcastAll(msg, data); }

// ── Finding other objects ─────────────────────────────────────
/**
 * Find an object by its exact name.
 * Returns an object proxy with .x, .y, .name, .sendMessage()
 * Example:  var player = find("Player");  log(player.x);
 */
function find(label)                { return api.find(label); }
/** Find the first object with a given tag */
function findWithTag(tag)           { return api.findWithTag(tag); }
/** Find ALL objects with a given tag — returns an array */
function findAllWithTag(tag)        { return api.findAllWithTag(tag); }
/** Find ALL objects in a group — returns an array */
function findAllInGroup(grp)        { return api.findAllInGroup(grp); }

// ── Overlap detection (no physics body needed) ────────────────
/**
 * Check if this object is overlapping another RIGHT NOW (AABB box check).
 * Does not need a physics body — works on any object.
 * Example: if (overlaps(find("Coin"))) { ... }
 */
function overlaps(other)            { return api.overlaps(other); }
/** Returns the first object with this tag that this object overlaps, or null */
function overlapsTag(tag)           { return api.overlapsTag(tag); }
/** Returns ALL objects with this tag that this object overlaps */
function overlapsAllWithTag(tag)    { return api.overlapsAllWithTag(tag); }

// ── Destroy ───────────────────────────────────────────────────
/** Remove this object from the scene */
function destroySelf()              { api.destroySelf(); }
/** Remove another object (pass a proxy from find/findWithTag) */
function destroy(other)             { api.destroy(other); }

// ── Scene management ──────────────────────────────────────────
/**
 * Switch to a different scene by name or index.
 * Example: gotoScene("Level2")  or  gotoScene(1)
 */
function gotoScene(nameOrIndex)     { api.gotoScene(nameOrIndex); }
/** Name of the current scene */
function currentScene()             { return api.currentScene; }
/** Index of the current scene (0-based) */
function currentSceneIndex()        { return api.currentSceneIndex; }
/** Total number of scenes */
function sceneCount()               { return api.sceneCount; }
/** Get scene name by index */
function getSceneName(i)            { return api.getSceneName(i); }
/**
 * Pause or resume the scene.
 * pauseScene()       → pauses  (same as pressing ⏸)
 * pauseScene(false)  → resumes
 */
function pauseScene(on = true)      { api.pauseScene(on); }
/**
 * Restart the current scene without leaving play mode.
 * All objects, physics and scripts are reset to their initial state.
 */
function restartScene()             { api.restartScene(); }

// ── Camera ────────────────────────────────────────────────────
/**
 * Make the camera follow an object smoothly.
 * Example:  cameraFollow(find("Player"))
 *           cameraFollow(find("Player"), 8)   ← faster smoothing
 */
function cameraFollow(target, smoothing)    { api.camera.follow(target, smoothing); }
/** Stop camera from following */
function cameraUnfollow()                   { api.camera.unfollow(); }
/** Move camera instantly to a world position */
function cameraMoveTo(wx, wy)              { api.camera.moveTo(wx, wy); }
/** Get camera X position in world units */
function getCameraX()                      { return api.camera.x; }
/** Get camera Y position in world units */
function getCameraY()                      { return api.camera.y; }
/** Shake the camera */
function cameraShake(amplitude, duration)  { api.camera.shake(amplitude, duration); }

// ── Animation ─────────────────────────────────────────────────
function playAnimation(name)  { api.playAnimation(name); }
function stopAnimation()      { api.stopAnimation(); }
function pauseAnimation()     { api.pauseAnimation(); }
function currentAnimation()   { return api.currentAnimation; }

// ── Physics body (Planck.js) ───────────────────────────────────
var physics = api.physics;

// ── Physics helpers (readable shortcuts) ──────────────────────
/**
 * Apply a continuous force to this object every frame.
 * Use inside onUpdate() for sustained pushes (wind, jets, etc).
 * Only works on Dynamic bodies.
 *   applyForce(0, 5)   → push upward
 *   applyForce(3, 0)   → push right
 */
function applyForce(fx, fy)         { physics.applyForce(fx, fy); }

/**
 * Apply an instant impulse — like applyForce but for a single hit.
 * Great for jump, knockback, explosions.
 * Only works on Dynamic bodies.
 *   applyImpulse(0, 8)   → jump
 *   applyImpulse(-5, 0)  → knockback left
 */
function applyImpulse(ix, iy)       { physics.applyImpulse(ix, iy); }

/**
 * Directly set the physics body velocity (world units/second).
 * Only works on Dynamic bodies. Use setVelocity() for full control.
 *   setPhysicsVelocity(0, -5)  → fall at 5 u/s
 */
function setPhysicsVelocity(vx, vy) { physics.setVelocity(vx, vy); }

/**
 * Read the actual velocity X of this body in world units/sec.
 * Works for Dynamic and Kinematic bodies.
 */
function getVelX()                  { return physics.velX; }

/**
 * Read the actual velocity Y of this body in world units/sec (+Y = up).
 * Works for Dynamic and Kinematic bodies.
 */
function getVelY()                  { return physics.velY; }

/**
 * Is this kinematic body resting on a floor?
 * Use to gate jumps:  if (isOnGround()) { applyImpulse(0, 8); }
 */
function isOnGround()               { return physics.isOnGround; }

/**
 * Is this kinematic body touching a ceiling?
 */
function isOnCeiling()              { return physics.isOnCeiling; }

/**
 * Is this kinematic body pressing against a wall?
 */
function isOnWall()                 { return physics.isOnWall; }

/**
 * Immediately stop all physics movement on this body.
 * Works for Dynamic and Kinematic bodies.
 */
function stopPhysics()              { physics.stop(); }

/**
 * Make this object physically immovable (no force can move it).
 * setImmovable(true)  — frozen in place (stronger than static)
 * setImmovable(false) — restore normal physics
 */
function setImmovable(val)          { physics.setImmovable(val); }

// ── Key / Mouse constants ─────────────────────────────────────
// Use Key.W, Key.SPACE, Key.ARROW_LEFT etc. instead of raw strings.
// Use Mouse.LEFT, Mouse.RIGHT, Mouse.MIDDLE for mouse button names.
var Key   = window.Key   || {};
var Mouse = window.Mouse || {};

// ── Input ─────────────────────────────────────────────────────
var input = api.input;
/** Is key currently held? Accepts Key.X constants or raw strings like "w".
 *  Pass Key.ANY to check if ANY key is held. */
function isKeyDown(k)     {
    if (k === '__any__' || k === Key.ANY) return api._anyKeyDown();
    return input.isKeyDown(k);
}
/** Was key pressed for the first time this frame? */
function isKeyJustDown(k) {
    if (k === '__any__' || k === Key.ANY) return api._anyKeyJustDown();
    return input.isKeyJustDown(k);
}
/** Was key released this frame? */
function isKeyJustUp(k) {
    if (k === '__any__' || k === Key.ANY) return api._anyKeyJustUp();
    return input.isKeyJustUp(k);
}
/** Horizontal axis from A/D or arrow keys. Returns -1, 0, or 1 */
function axisH()              { return input.axisH; }
/** Vertical axis from W/S or arrow keys. Returns -1, 0, or 1 */
function axisV()              { return input.axisV; }
/** Mouse X in world units */
function mouseX()             { return input.worldMouseX; }
/** Mouse Y in world units */
function mouseY()             { return input.worldMouseY; }
/** Is mouse button held? */
function mouseDown()          { return input.mouseDown; }
/** Was mouse button clicked this frame? */
function mouseJustDown()      { return input.mouseJustDown; }

// ── Mobile / Touch ────────────────────────────────────────────
/**
 * Is ANY finger currently touching the screen?
 * Works the same as mouseDown() on mobile.
 */
function isTouching()         { return input.mouseDown; }
/**
 * Did a new finger touch start this frame?
 * Works the same as mouseJustDown() on mobile.
 */
function touchJustStarted()   { return input.mouseJustDown; }
/**
 * Register a swipe handler using Hammer.js.
 * direction: "left" | "right" | "up" | "down" | "any"
 *
 * Example:
 *   onSwipe("left",  () => { move(-3, 0); });
 *   onSwipe("right", () => { move( 3, 0); });
 *   onSwipe("up",    () => { velocityY = 5; });
 *   onSwipe("any",   (dir) => { log("swiped " + dir); });
 */
function onSwipe(direction, fn) { api.onSwipe(direction, fn); }
/**
 * Register a pinch handler (two-finger pinch/zoom).
 * fn receives the pinch scale (>1 = zoom in, <1 = zoom out).
 *
 * Example:
 *   onPinch((scale) => { setScaleX(getScaleX() * scale); setScaleY(getScaleY() * scale); });
 */
function onPinch(fn)            { api.onPinch(fn); }
/**
 * Register a tap handler (triggered by a quick touch tap).
 *
 * Example:
 *   onTap(() => { gotoScene("Menu"); });
 */
function onTap(fn)              { api.onTap(fn); }

// ── Time ──────────────────────────────────────────────────────
/** Total seconds since Play was pressed */
function getTime()            { return api.time; }

// ── Shared variables ──────────────────────────────────────────
/**
 * sceneVar — variables shared between ALL scripts in the current scene.
 * Reset when you switch scenes.
 * Example:  sceneVar.score = 0;   sceneVar.score += 1;
 */
var sceneVar  = api.sceneVar;
/**
 * globalVar — variables that survive even when you switch scenes.
 * Example:  globalVar.totalDeaths += 1;
 */
var globalVar = api.globalVar;

// ── Per-script key/value store ────────────────────────────────
/** store — private to this script, reset on Play stop */
var store = api.store;

// ── Sound ─────────────────────────────────────────────────────
/**
 * Play a sound asset by name.
 * soundPlay("Jump")
 * soundPlay("BgMusic", { loop:true, volume:0.8, range:400 })
 * soundPlay("Boom", { x:3, y:2, range:600 })   // at world position
 */
function soundPlay(name, opts)    { api.soundPlay(name, opts || {}); }
/** Stop a specific sound by name */
function soundStop(name)          { api.soundStop(name); }
/** Stop all currently playing sounds */
function soundStopAll()           { api.soundStopAll(); }

// ── Timers ────────────────────────────────────────────────────
/**
 * Wait X seconds then run a function. Non-blocking.
 * Example:  wait(2, () => { log("2 seconds!"); })
 */
function wait(seconds, fn)        { api.wait(seconds, fn); }

// ── Physics control ───────────────────────────────────────────
/**
 * Change this object's physics body type.
 * setPhysicsType("static") | "kinematic" | "dynamic" | "none"
 */
function setPhysicsType(type)     { api.setPhysicsType(type); }
/**
 * Enable or disable collision for this object.
 * setCollision(false) — passes through everything
 */
function setCollision(enabled)    { api.setCollision(enabled); }
/** Make this object a sensor (no physical response but fires collision events) */
function setSensor(v)             { api.setSensor(v); }
/** Set collision layer category */
function setCollisionCategory(c)  { api.setCollisionCategory(c); }
/** Set collision layer mask (which layers to collide with) */
function setCollisionMask(m)      { api.setCollisionMask(m); }

// ── Tint ──────────────────────────────────────────────────────
/**
 * Set this object's colour tint.
 * setTint("#ff0000")      — red tint
 * setTint("#ffffff")      — remove tint (white = no effect)
 * setTint(0x00ff00)       — green tint (hex number)
 */
function setTint(v)               { api.tint = v; }
function getTint()                { return api.tint; }

// ── Distance ──────────────────────────────────────────────────
/**
 * Distance from this object to another.
 * distanceTo("enemy")              — first object with tag "enemy"
 * distanceTo(find("Boss"))         — a specific object
 * distanceTo(3, 5)                 — world position x=3, y=5
 */
function distanceTo(targetOrX, y) { return api.distanceTo(targetOrX, y); }

// ── Math helpers ──────────────────────────────────────────────
var math    = api.math;
var lerp    = math.lerp;
var clamp   = math.clamp;
var dist    = math.dist;
var rand    = math.rand;
var randInt = math.randInt;
var sign    = math.sign;
var toRad   = math.toRad;
var toDeg   = math.toDeg;
var mapRange= math.map;
var wrap    = math.wrap;
var sin     = math.sin;   var cos   = math.cos;   var tan   = math.tan;
var abs     = math.abs;   var sqrt  = math.sqrt;  var pow   = math.pow;
var atan2   = math.atan2; var floor = math.floor; var ceil  = math.ceil;
var round   = math.round; var PI    = math.PI;
var max     = math.max;   var min   = math.min;

// ── Debug ─────────────────────────────────────────────────────
/** Print to the console */
function log(...a)    { api.log(...a); }
/** Print a warning */
function warn(...a)   { api.warn(...a); }
/** Print an error */
function error(...a)  { api.error(...a); }
/** Returns the label/name of the game object this script is attached to */
function selfName()   { return api.name; }

// ── Tween ──────────────────────────────────────────────────────
/**
 * Animate this object's properties over time.
 * tween({ x:5, alpha:0 }, 0.5)
 * tween({ scaleX:2 }, 1, "easeOut", () => { log("done!"); })
 * Easings: linear easeIn easeOut easeInOut easeInCubic easeOutCubic
 *          elastic elasticOut bounce steps2 steps4
 */
function tween(props, duration, easing, onComplete) {
    return api.tween(props, duration, easing, onComplete);
}

// ── Repeat timers ──────────────────────────────────────────────
/**
 * Call fn every interval seconds. Returns an id for cancelRepeat().
 * var id = repeat(2, () => { spawnCoin(); });
 */
function repeat(interval, fn) { return api.repeat(interval, fn); }
/** Cancel a repeating timer by id. */
function cancelRepeat(id)     { api.cancelRepeat(id); }

// ── Spawn object ───────────────────────────────────────────────
/**
 * Create a new object at a world position.
 * spawnObject("Bullet", x, y)
 * spawnObject("Bullet", x, y, (obj) => { obj.velocityX = 10; })
 */
function spawnObject(assetName, x, y, onSpawned) {
    return api.spawnObject(assetName, x, y, onSpawned);
}

/**
 * Create a text object in the scene from a script.
 * Returns a proxy so you can immediately update it.
 *
 * Example:
 *   var score = drawText("Score: 0", 0, 3, { fontSize: 36, fill: "#fff" });
 *   score.text = "Score: " + points;
 *
 * Style options: fontSize, fontFamily, fill, stroke, strokeThickness,
 *   align, bold, italic, dropShadow, wordWrap, wordWrapWidth
 */
function drawText(text, x, y, styleOpts = {}) {
    // Convert from world coordinates to PIXI pixels
    const px = (x  ?? 0) * 100;
    const py = (-(y ?? 0)) * 100;
    let result = null;
    import('./engine.objects.js').then(({ createTextObject }) => {
        const obj = createTextObject(String(text), px, py, styleOpts);
        if (obj && result) result._ref = obj;
    });
    // Return a live proxy — _ref will be filled in once the async create resolves.
    // Scripts can store the return value and call .setText() on it later.
    result = {
        _ref: null,
        get text() { return this._ref?.textContent ?? ''; },
        set text(v) {
            if (!this._ref?._pixiText) return;
            this._ref.textContent   = String(v);
            this._ref._pixiText.text = String(v);
        },
        setText(v) { this.text = v; },
        setTextStyle(opts) {
            if (!this._ref) return;
            import('./engine.objects.js').then(({ setTextStyle }) => setTextStyle(this._ref, opts));
        },
        get visible() { return this._ref?.visible ?? true; },
        set visible(v){ if (this._ref) this._ref.visible = !!v; },
    };
    return result;
}

// ── Raycast (AABB) ─────────────────────────────────────────────
/**
 * Fire a ray from (x1,y1) → (x2,y2) and return the first object hit.
 * raycast(x, y, x+10, y)             — any object
 * raycast(x, y, x+10, y, "enemy")   — only tagged "enemy"
 */
function raycast(x1, y1, x2, y2, tag) { return api.raycast(x1, y1, x2, y2, tag); }

// ── Radius query ───────────────────────────────────────────────
/**
 * Return all objects within radius world-units of (cx, cy).
 * getObjectsInRadius(x, y, 3)             — all
 * getObjectsInRadius(x, y, 3, "coin")    — only tagged "coin"
 */
function getObjectsInRadius(cx, cy, radius, tag) {
    return api.getObjectsInRadius(cx, cy, radius, tag);
}

// ── Z-order ────────────────────────────────────────────────────
/** Set render order (higher = drawn on top). */
function setZOrder(n)   { api.setZOrder(n); }
/** Get current render order. */
function getZOrder()    { return api.getZOrder(); }

// ── Coordinate conversion ──────────────────────────────────────
/** Convert screen pixel position → world position {x, y}. */
function screenToWorld(sx, sy) { return api.screenToWorld(sx, sy); }
/** Convert world position → screen pixel position {x, y}. */
function worldToScreen(wx, wy) { return api.worldToScreen(wx, wy); }

// ── Key event handlers ─────────────────────────────────────────
/**
 * Fire a callback once each time a key is pressed.
 * onKeyDown("arrowleft", () => { moveLeft(); })
 * onKeyDown("any", (key) => { log("pressed:", key); })
 */
function onKeyDown(key, fn) { api.onKeyDown(key, fn); }
/** Fire a callback once each time a key is released. */
function onKeyUp(key, fn)   { api.onKeyUp(key, fn); }

// ── Physics helpers ────────────────────────────────────────────
/** Actual physics body velocity X (world units/sec). Works for kinematic and dynamic. */
function getPhysicsVelX()   { return api.getPhysicsVelX(); }
/** Actual physics body velocity Y (world units/sec, positive = up). Works for kinematic and dynamic. */
function getPhysicsVelY()   { return api.getPhysicsVelY(); }
/** Change this object's gravity scale (0 = floats, 2 = 2× gravity). Dynamic bodies only. */
function setGravityScale(n) { api.setGravityScale(n); }
/**
 * isOnGround() — true if this kinematic body is resting on a floor this frame.
 * Use this to stop gravity from building up:
 *   if (isOnGround()) velocityY = 0;
 *   if (isOnGround() && isKeyJustDown("space")) velocityY = 10; // jump
 */
function isOnGround()   { return physics.isOnGround; }
/**
 * isOnCeiling() — true if this kinematic body just hit a ceiling.
 * Use to cancel upward velocity: if (isOnCeiling()) velocityY = 0;
 */
function isOnCeiling()  { return physics.isOnCeiling; }
/**
 * isOnWall() — true if this kinematic body is pressed against a wall.
 * Use to stop horizontal velocity: if (isOnWall()) velocityX = 0;
 */
function isOnWall()     { return physics.isOnWall; }

// ── Extra math ────────────────────────────────────────────────
/** Smooth S-curve between lo and hi. */
function smoothstep(lo, hi, x)         { return api.smoothstep(lo, hi, x); }
/** Normalize a 2D vector → {x, y}. */
function normalize(vx, vy)             { return api.normalize(vx, vy); }
/** Angle in degrees from point A to point B. */
function angleTo(x1, y1, x2, y2)      { return api.angleTo(x1, y1, x2, y2); }

// ── Debug draw ────────────────────────────────────────────────
/**
 * Draw a temporary line (only visible during Play).
 * drawDebugLine(0, 0, 5, 5)
 * drawDebugLine(0, 0, 5, 5, "#ff0000", 1.0, 3)
 */
function drawDebugLine(x1, y1, x2, y2, color, duration, width) {
    api.drawDebugLine(x1, y1, x2, y2, color, duration, width);
}
/**
 * Draw a temporary circle outline.
 * drawDebugCircle(x, y, 1.5)
 * drawDebugCircle(x, y, 1.5, "#ff0000", 1.0)
 */
function drawDebugCircle(cx, cy, radius, color, duration, width) {
    api.drawDebugCircle(cx, cy, radius, color, duration, width);
}
`;

        const postlude = `
;__out._onStart          = _onStart;
__out._onUpdate          = _onUpdate;
__out._onStop            = _onStop;
__out._onCollisionEnter  = _onCollisionEnter;
__out._onCollisionStay   = _onCollisionStay;
__out._onCollisionExit   = _onCollisionExit;
__out._onOverlapEnter    = _onOverlapEnter;
__out._onOverlapExit     = _onOverlapExit;
__out._onVisible         = _onVisible;
__out._onHide            = _onHide;
__out._onMouseClick      = _onMouseClick;
__out._onMouseEnter      = _onMouseEnter;
__out._onMouseLeave      = _onMouseLeave;
__out._msgHandlers       = _msgHandlers;
__out._initVX            = typeof velocityX !== 'undefined' ? velocityX : 0;
__out._initVY            = typeof velocityY !== 'undefined' ? velocityY : 0;
__out._syncVel           = typeof _syncVelocityToApi !== 'undefined' ? _syncVelocityToApi : null;
`;
        // ── Pre-flight safety scan ────────────────────────────────────────────
        // Detect patterns that would crash or corrupt the engine before even
        // trying to compile. We only scan the user's raw code (not the prelude).
        const safetyWarnings = _scanScriptForDangers(code, this.name, this.obj.label);
        if (safetyWarnings.fatal) {
            // Hard block: do not run the script at all
            for (const w of safetyWarnings.messages) _logConsole(w, '#f87171');
            import('./engine.console.js').then(m => m.recordPlayError());
            return; // leave all handlers null — script simply won't run
        }
        for (const w of safetyWarnings.messages) _logConsole(w, '#facc15');

        try {
            const fn = new Function('api', '__out', prelude + '\n' + code + '\n' + postlude); // eslint-disable-line no-new-func
            const out = {};
            fn(api, out);
            this._onStart         = out._onStart         ?? null;
            this._onUpdate        = out._onUpdate        ?? null;
            this._onStop          = out._onStop          ?? null;
            this._onCollisionEnter= out._onCollisionEnter ?? null;
            this._onCollisionStay = out._onCollisionStay  ?? null;
            this._onCollisionExit = out._onCollisionExit  ?? null;
            this._onOverlapEnter  = out._onOverlapEnter   ?? null;
            this._onOverlapExit   = out._onOverlapExit    ?? null;
            this._onVisible       = out._onVisible        ?? null;
            this._onHide          = out._onHide           ?? null;
            this._onMouseClick    = out._onMouseClick     ?? null;
            this._onMouseEnter    = out._onMouseEnter     ?? null;
            this._onMouseLeave    = out._onMouseLeave     ?? null;
            this._messageHandlers = out._msgHandlers      ?? new Map();
            this._syncVel         = out._syncVel          ?? null;
            // Apply initial velocity values from top-level declarations
            api._vel.x = out._initVX ?? 0;
            api._vel.y = out._initVY ?? 0;
        } catch (err) {
            const friendly = _friendlyScriptError(err, code, this.name, this.obj.label, 'compile');
            for (const line of friendly) _logConsole(line, '#f87171');
            import('./engine.console.js').then(m => m.recordPlayError());
        }
    }

    start() {
        if (!this._onStart) return;
        try { this._onStart(); }
        catch (e) {
            const friendly = _friendlyScriptError(e, null, this.name, this.obj.label, 'onStart');
            for (const line of friendly) _logConsole(line, '#f87171');
            import('./engine.console.js').then(m => m.recordPlayError());
        }
    }

    update(dt) {
        const vel  = this.api._vel;
        const grav = this.api._grav;
        const obj  = this.obj;

        // ── 1. Run the user's onUpdate first so changes take effect this frame ──
        if (this._onUpdate) {
            try { this._onUpdate(dt); }
            catch (e) {
                // Throttle: only log the first occurrence + every 60th after that
                // so a broken onUpdate doesn't spam thousands of console lines.
                this._updateErrCount = (this._updateErrCount ?? 0) + 1;
                if (this._updateErrCount === 1) {
                    const friendly = _friendlyScriptError(e, null, this.name, obj.label, 'onUpdate');
                    for (const line of friendly) _logConsole(line, '#f87171');
                    _logConsole(`  ↳ This error repeats every frame — fix the script to stop the spam.`, '#facc15');
                    import('./engine.console.js').then(m => m.recordPlayError());
                } else if (this._updateErrCount % 300 === 0) {
                    // Remind the user the script is still broken every ~5s at 60fps
                    _logConsole(`[Script "${this.name}" on "${obj.label}"] ✖ onUpdate still failing (${this._updateErrCount} frames). Open the script to fix it.`, '#f87171');
                }
            }
        }

        // ── 2. Sync local velocityX/Y vars (written directly in script) to api._vel ──
        if (this._syncVel) {
            try { this._syncVel(); } catch(_) {}
        }

        // ── 3. Tick tweens (after onUpdate so user code runs first) ───
        for (let i = this._tweens.length - 1; i >= 0; i--) {
            const tw = this._tweens[i];
            tw.elapsed = Math.min(tw.elapsed + dt, tw.duration);
            const t  = tw.duration > 0 ? tw.elapsed / tw.duration : 1;
            const et = _easing(t, tw.easing);
            for (const e of tw.entries) {
                _applyTweenProp(this.api, e.key, e.from + (e.to - e.from) * et);
            }
            if (tw.elapsed >= tw.duration) {
                try { tw.onComplete?.(); } catch(_) {}
                this._tweens.splice(i, 1);
            }
        }

        // ── 4. Tick repeat timers ──────────────────────────────
        for (const r of this._repeats) {
            r.elapsed -= dt;
            if (r.elapsed <= 0) {
                try { r.fn(); }
                catch (e) {
                    const friendly = _friendlyScriptError(e, null, this.name, obj.label, 'repeat timer');
                    for (const line of friendly) _logConsole(line, '#f87171');
                    import('./engine.console.js').then(m => m.recordPlayError());
                }
                r.elapsed = r.interval;
            }
        }

        // ── 3. Apply manual gravity accumulation ───────────────────────
        if (grav.x !== 0) vel.x += grav.x * dt;
        if (grav.y !== 0) vel.y += grav.y * dt;

        // ── 4. Apply velocity to position / physics body ───────────────
        const hasKinematicBody = obj.physicsBody === 'kinematic';
        const hasDynamicBody   = obj.physicsBody === 'dynamic' && obj._physicsBody;

        if (hasKinematicBody) {
            // Kinematic: store desired velocity for the AABB sweep in stepPhysics.
            // stepPhysics runs after all scripts this frame, sweeps the sprite AABB
            // against tile/static AABBs, resolves collisions, and writes the
            // corrected position to obj.x/y. No Matter body involved.
            if (!obj.physicsImmovable) {
                obj._kinematicVx =  vel.x * 100;
                obj._kinematicVy = -vel.y * 100;
            }
        } else if (hasDynamicBody) {
            // ── Dynamic: velocityX/Y override the physics body velocity directly.
            // This is the most intuitive behaviour — setting velocityX = 5 means
            // the body moves at exactly 5 world units/sec on that axis, regardless
            // of what forces or gravity are doing.  Physics forces (gravity, impulses)
            // are still applied on top AFTER this each step by stepPhysics.
            // Only override if the script actually set a velocity this frame.
            if (vel.x !== 0 || vel.y !== 0) {
                // Convert world units/sec → px/sec (Planck uses px)
                // Y is flipped: script +Y = up = Planck -Y
                obj._physicsBody.setLinearVelocity(window.planck.Vec2(vel.x * 100, -vel.y * 100));
            }
        } else {
            // ── No physics body — pure scripting movement ──────────────
            if (vel.x !== 0) obj.x +=  vel.x * dt * 100;
            if (vel.y !== 0) obj.y -= vel.y * dt * 100;
        }

        // Destroy queue
        if (obj._markedForDestroy) _destroyObject(obj);

        // Clear per-frame input flags
        this._keysJustDown.clear();
        this._keysJustUp.clear();
        this._mouse.justDown = false;
        this._mouse.justUp   = false;
    }

    stop() {
        if (!this._onStop) return;
        try { this._onStop(); }
        catch (e) {
            const friendly = _friendlyScriptError(e, null, this.name, this.obj.label, 'onStop');
            for (const line of friendly) _logConsole(line, '#f87171');
        }
    }

    // ── Collision callbacks (physics — fired by engine.physics.js) ──
    handleCollisionEnter(other) {
        if (!other) return;
        this._activeCollisions.add(other);
        if (this._onCollisionEnter) {
            const proxy = _makeProxy(other);
            try { this._onCollisionEnter(proxy); }
            catch (e) {
                const friendly = _friendlyScriptError(e, null, this.name, this.obj.label, `onCollisionEnter (hit "${other.label}")`);
                for (const line of friendly) _logConsole(line, '#f87171');
                import('./engine.console.js').then(m => m.recordPlayError());
            }
        }
    }

    handleCollisionStay(other) {
        if (this._onCollisionStay) {
            const proxy = _makeProxy(other);
            try { this._onCollisionStay(proxy); }
            catch (e) {
                // Throttle stay errors like onUpdate — they fire every frame
                this._collStayErrCount = (this._collStayErrCount ?? 0) + 1;
                if (this._collStayErrCount === 1) {
                    const friendly = _friendlyScriptError(e, null, this.name, this.obj.label, 'onCollisionStay');
                    for (const line of friendly) _logConsole(line, '#f87171');
                }
            }
        }
    }

    handleCollisionExit(other) {
        this._activeCollisions.delete(other);
        if (this._onCollisionExit) {
            const proxy = _makeProxy(other);
            try { this._onCollisionExit(proxy); }
            catch (e) {
                const friendly = _friendlyScriptError(e, null, this.name, this.obj.label, 'onCollisionExit');
                for (const line of friendly) _logConsole(line, '#f87171');
                import('./engine.console.js').then(m => m.recordPlayError());
            }
        }
    }

    // ── Overlap callbacks (AABB — fired by scripting runtime) ────────
    handleOverlapEnter(other) {
        this._activeOverlaps.add(other);
        if (this._onOverlapEnter) {
            const proxy = _makeProxy(other);
            try { this._onOverlapEnter(proxy); }
            catch (e) {
                const friendly = _friendlyScriptError(e, null, this.name, this.obj.label, `onOverlapEnter (with "${other.label}")`);
                for (const line of friendly) _logConsole(line, '#f87171');
                import('./engine.console.js').then(m => m.recordPlayError());
            }
        }
    }

    handleOverlapExit(other) {
        this._activeOverlaps.delete(other);
        if (this._onOverlapExit) {
            const proxy = _makeProxy(other);
            try { this._onOverlapExit(proxy); }
            catch (e) {
                const friendly = _friendlyScriptError(e, null, this.name, this.obj.label, 'onOverlapExit');
                for (const line of friendly) _logConsole(line, '#f87171');
            }
        }
    }

    _handleKeyDown(key) {
        const k = key.toLowerCase();
        if (!this._keys.has(k)) {
            this._keysJustDown.add(k);
            const h = this._keyDownHandlers.get(k) ?? this._keyDownHandlers.get('any');
            if (h) try { h(k); }
            catch(e) {
                const friendly = _friendlyScriptError(e, null, this.name, this.obj?.label ?? '?', `onKeyDown("${k}")`);
                for (const line of friendly) _logConsole(line, '#f87171');
                import('./engine.console.js').then(m => m.recordPlayError());
            }
        }
        this._keys.add(k);
    }
    _handleKeyUp(key) {
        const k = key.toLowerCase();
        this._keysJustUp.add(k);
        this._keys.delete(k);
        const h = this._keyUpHandlers.get(k) ?? this._keyUpHandlers.get('any');
        if (h) try { h(k); }
        catch(e) {
            const friendly = _friendlyScriptError(e, null, this.name, this.obj?.label ?? '?', `onKeyUp("${k}")`);
            for (const line of friendly) _logConsole(line, '#f87171');
            import('./engine.console.js').then(m => m.recordPlayError());
        }
    }
    _handleMouseMove(x, y) { this._mouse.x = x; this._mouse.y = y; }
    _handleMouseDown()     { this._mouse.down = true;  this._mouse.justDown = true; }
    _handleMouseUp()       { this._mouse.down = false; this._mouse.justUp   = true; }
    _handleMouseClick(cx, cy) {
        // Hit-test: does the canvas point (cx,cy) land inside this object?
        if (!this._onMouseClick || !this.obj) return;
        const obj = this.obj;
        if (!obj.visible) return;
        // Use PIXI getBounds on the display object
        try {
            const b = obj.getBounds();
            if (cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height) {
                try { this._onMouseClick(); }
                catch (e) {
                    const friendly = _friendlyScriptError(e, null, this.name, obj.label, 'onMouseClick');
                    for (const line of friendly) _logConsole(line, '#f87171');
                    import('./engine.console.js').then(m => m.recordPlayError());
                }
            }
        } catch(_) {}
    }
}

// ── Object destroy helper ─────────────────────────────────────
function _destroyObject(obj) {
    obj.visible = false;
    try { state.sceneContainer?.removeChild(obj); } catch(_) {}
    const idx = state.gameObjects.indexOf(obj);
    if (idx !== -1) state.gameObjects.splice(idx, 1);
    obj._markedForDestroy = false;
}

// ── Runtime state ─────────────────────────────────────────────
const _instances = [];
let   _ticker    = null;
let   _hammerInst = null; // Hammer.js Manager instance for the play canvas

function _initHammer() {
    _destroyHammer();
    const canvas = state.app?.view;
    if (!canvas || typeof window.Hammer === 'undefined') return;

    const hm = new window.Hammer.Manager(canvas, {
        recognizers: [
            [window.Hammer.Swipe,  { direction: window.Hammer.DIRECTION_ALL, threshold: 10, velocity: 0.3 }],
            [window.Hammer.Pinch,  { enable: true }],
            [window.Hammer.Tap,    { event: 'tap' }],
        ],
    });

    const DIRECTION_MAP = {
        [window.Hammer.DIRECTION_LEFT]:  'left',
        [window.Hammer.DIRECTION_RIGHT]: 'right',
        [window.Hammer.DIRECTION_UP]:    'up',
        [window.Hammer.DIRECTION_DOWN]:  'down',
    };

    hm.on('swipe', (ev) => {
        const dir = DIRECTION_MAP[ev.direction] ?? 'any';
        for (const inst of _instances) {
            const map = inst.api?._swipeHandlers;
            if (!map) continue;
            const fn = map.get(dir) ?? map.get('any');
            if (fn) try { fn(dir); }
            catch (e) {
                const friendly = _friendlyScriptError(e, null, inst.name, inst.obj?.label ?? '?', 'onSwipe');
                for (const line of friendly) _logConsole(line, '#f87171');
                import('./engine.console.js').then(m => m.recordPlayError());
            }
        }
    });

    hm.on('pinch', (ev) => {
        for (const inst of _instances) {
            const fn = inst.api?._pinchHandler;
            if (fn) try { fn(ev.scale); }
            catch (e) {
                const friendly = _friendlyScriptError(e, null, inst.name, inst.obj?.label ?? '?', 'onPinch');
                for (const line of friendly) _logConsole(line, '#f87171');
                import('./engine.console.js').then(m => m.recordPlayError());
            }
        }
    });

    hm.on('tap', () => {
        for (const inst of _instances) {
            const fn = inst.api?._tapHandler;
            if (fn) try { fn(); }
            catch (e) {
                const friendly = _friendlyScriptError(e, null, inst.name, inst.obj?.label ?? '?', 'onTap');
                for (const line of friendly) _logConsole(line, '#f87171');
                import('./engine.console.js').then(m => m.recordPlayError());
            }
        }
    });

    _hammerInst = hm;
}

function _destroyHammer() {
    if (_hammerInst) {
        try { _hammerInst.destroy(); } catch(_) {}
        _hammerInst = null;
    }
}
let   _physicsModule = null; // cached physics module ref — resolved once on first step

// ── Input event relay ─────────────────────────────────────────
function _kd(e) { for (const i of _instances) i._handleKeyDown(e.key); }
function _ku(e) { for (const i of _instances) i._handleKeyUp(e.key); }
function _mm(e) {
    const c = state.app?.view; if (!c) return;
    const r = c.getBoundingClientRect();
    for (const i of _instances) i._handleMouseMove(e.clientX - r.left, e.clientY - r.top);
}
function _md(e) {
    for (const i of _instances) i._handleMouseDown();
}
function _mu(e) {
    for (const i of _instances) i._handleMouseUp();
    // Dispatch onMouseClick to any instance whose object bounds contain the click point
    if (!state.app?.view) return;
    const canvas = state.app.view;
    const rect   = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    for (const i of _instances) {
        if (i._onMouseClick) i._handleMouseClick(cx, cy);
    }
}
// Touch relay — maps touch events to mouse equivalents
function _td(e) {
    for (const i of _instances) i._handleMouseDown();
    _muTouchPos = e.changedTouches[0];
}
function _tu(e) {
    for (const i of _instances) i._handleMouseUp();
    const t = e.changedTouches[0];
    if (!state.app?.view) return;
    const rect = state.app.view.getBoundingClientRect();
    const cx = t.clientX - rect.left;
    const cy = t.clientY - rect.top;
    for (const i of _instances) {
        if (i._onMouseClick) i._handleMouseClick(cx, cy);
    }
}
function _tm(e) {
    const t = e.changedTouches[0];
    if (!state.app?.view) return;
    const r = state.app.view.getBoundingClientRect();
    for (const i of _instances) i._handleMouseMove(t.clientX - r.left, t.clientY - r.top);
}
let _muTouchPos = null;

// ── Overlap check pass (runs every frame) ─────────────────────
function _runOverlapChecks() {
    // Only check instances that have overlap handlers
    const tracked = _instances.filter(i => i._onOverlapEnter || i._onOverlapExit);
    if (tracked.length === 0) return;

    for (const inst of tracked) {
        for (const other of _instances) {
            if (other === inst) continue;
            const wasOverlapping = inst._activeOverlaps.has(other.obj);
            const isNow = _isOverlapping(inst.obj, other.obj);
            if (isNow && !wasOverlapping)  inst.handleOverlapEnter(other.obj);
            if (!isNow && wasOverlapping)  inst.handleOverlapExit(other.obj);
        }
    }
}

// ── Continuous collision stay pass (runs every frame) ─────────
function _runCollisionStayChecks() {
    for (const inst of _instances) {
        if (!inst._onCollisionStay) continue;
        for (const otherObj of inst._activeCollisions) {
            inst.handleCollisionStay(otherObj);
        }
    }
}

// ── Start scripts (enterPlayMode) ─────────────────────────────
export function startScripts() {
    stopScripts();
    _clearRegistries();
    _camera._followTarget = null;

    let count = 0;
    for (const obj of state.gameObjects) {
        if (!obj.scriptName) continue;
        const rec = getScript(obj.scriptName);
        if (!rec) {
            _logConsole(`[Scripting] Script "${obj.scriptName}" not found for "${obj.label}"`, '#facc15');
            continue;
        }
        const inst = new ScriptInstance(obj, obj.scriptName, rec.code);
        _instances.push(inst);
        _registerInstance(inst);
        count++;
    }

    if (count === 0) return;

    // Fire onStart for all instances after all are registered
    // (so messaging and findWithTag work in onStart)
    for (const i of _instances) i.start();

    window.addEventListener('keydown',   _kd);
    window.addEventListener('keyup',     _ku);
    window.addEventListener('mousemove', _mm);
    window.addEventListener('mousedown', _md);
    window.addEventListener('mouseup',   _mu);
    // Touch support (mobile)
    window.addEventListener('touchstart', _td, { passive: true });
    window.addEventListener('touchend',   _tu, { passive: true });
    window.addEventListener('touchmove',  _tm, { passive: true });

    // ── Hammer.js gesture recognition ────────────────────────
    _initHammer();

    // Cache playmode reference so we can update the camera mask each frame
    // without a per-frame dynamic import (which is expensive).
    let _playmodeRef = null;
    import('./engine.playmode.js').then(m => { _playmodeRef = m; });

    let _last = performance.now();
    _ticker = () => {
        if (!state.isPlaying || state.isPaused) return;
        const now = performance.now();
        const dt  = Math.min((now - _last) / 1000, 0.1);
        _last = now;

        _updateCamera(dt);
        // Update scene clipping mask AFTER camera moves so objects never flicker
        // out-of-bounds when the camera follows a moving object.
        if (_playmodeRef) _playmodeRef.updateSceneMask();

        _runOverlapChecks();
        _runCollisionStayChecks();
        _tickTimers(dt);
        _tickDebugLines(dt);

        // 1. Run all scripts — they write desired velocity into obj._kinematicVx/Vy
        const snap = [..._instances];
        for (const i of snap) {
            if (!state.gameObjects.includes(i.obj)) continue;
            i.update(dt);
        }

        // 2. Step physics — reads _kinematicVx/Vy, runs Planck, writes corrected
        //    positions back. Scripts and physics are in the same frame, no race.
        if (_physicsModule) {
            _physicsModule.stepPhysics(dt);
        } else {
            import('./engine.physics.js').then(m => { _physicsModule = m; m.stepPhysics(dt); });
        }
    };
    state.app.ticker.add(_ticker);
    _logConsole(`▶ Scripts: ${count} instance${count!==1?'s':''} running`, '#4ade80');
}

// ── Stop scripts (stopPlayMode) ───────────────────────────────
export function stopScripts() {
    for (const i of _instances) i.stop();
    _instances.length = 0;
    _clearRegistries();
    _camera._followTarget = null;
    clearSceneVars();
    clearGlobalVars();  // reset between play sessions
    _clearTimers();
    _clearDebugGfx();
    _physicsModule = null; // clear cached ref so next play session re-resolves cleanly
    if (_ticker && state.app) { state.app.ticker.remove(_ticker); _ticker = null; }
    window.removeEventListener('keydown',   _kd);
    window.removeEventListener('keyup',     _ku);
    window.removeEventListener('mousemove', _mm);
    window.removeEventListener('mousedown', _md);
    window.removeEventListener('mouseup',   _mu);
    window.removeEventListener('touchstart', _td);
    window.removeEventListener('touchend',   _tu);
    window.removeEventListener('touchmove',  _tm);
    _destroyHammer();
}

// ── Public console log (used by engine.scenes for play-mode messages) ─────
export function _logConsolePublic(msg, color) { _logConsole(msg, color); }

// ── Collision bridge (called from engine.physics.js) ──────────
export function triggerCollision(objA, objB) {
    for (const i of _instances) {
        if (i.obj === objA) i.handleCollisionEnter(objB);
        if (i.obj === objB) i.handleCollisionEnter(objA);
    }
}

// ── Collision exit bridge (called from engine.physics.js) ─────
export function triggerCollisionEnd(objA, objB) {
    for (const i of _instances) {
        if (i.obj === objA) i.handleCollisionExit(objB);
        if (i.obj === objB) i.handleCollisionExit(objA);
    }
}


// ── Ace autocomplete — only the allowed scripting API ─────────
const COMPLETIONS = [
    // Events
    { n:'onStart',           m:'● event',     v:"onStart(() => {\n  \n});" },
    { n:'onUpdate',          m:'● event',     v:"onUpdate((dt) => {\n  \n});" },
    { n:'onStop',            m:'● event',     v:"onStop(() => {\n  \n});" },
    { n:'onCollisionEnter',  m:'● event',     v:"onCollisionEnter((other) => {\n  // other.name, other.x, other.y\n});" },
    { n:'onCollisionStay',   m:'● event',     v:"onCollisionStay((other) => {\n  \n});" },
    { n:'onCollisionExit',   m:'● event',     v:"onCollisionExit((other) => {\n  \n});" },
    { n:'onOverlapEnter',    m:'● event',     v:"onOverlapEnter((other) => {\n  \n});" },
    { n:'onOverlapExit',     m:'● event',     v:"onOverlapExit((other) => {\n  \n});" },
    { n:'onMessage',         m:'● event',     v:"onMessage('${1:messageName}', (data) => {\n  \n});" },
    { n:'onBecomeVisible',   m:'● event',     v:"onBecomeVisible(() => {\n  \n});" },
    { n:'onBecomeHidden',    m:'● event',     v:"onBecomeHidden(() => {\n  \n});" },
    { n:'onMouseClick',      m:'● event',     v:"onMouseClick(() => {\n  \n});" },
    { n:'onMouseEnter',      m:'● event',     v:"onMouseEnter(() => {\n  \n});" },
    { n:'onMouseLeave',      m:'● event',     v:"onMouseLeave(() => {\n  \n});" },
    // this.x / this.y position
    { n:'getX',              m:'↔ position',  v:'getX()' },
    { n:'setX',              m:'↔ position',  v:'setX(${1:value})' },
    { n:'getY',              m:'↔ position',  v:'getY()' },
    { n:'setY',              m:'↔ position',  v:'setY(${1:value})' },
    { n:'moveTo',            m:'↔ position',  v:'moveTo(${1:x}, ${2:y})' },
    { n:'move',              m:'↔ position',  v:'move(${1:dx}, ${2:dy})' },
    { n:'moveForward',       m:'↔ position',  v:'moveForward(${1:speed})' },
    { n:'lookAt',            m:'↔ position',  v:'lookAt(${1:tx}, ${2:ty})' },
    { n:'flipX',             m:'↔ position',  v:'flipX()' },
    { n:'flipY',             m:'↔ position',  v:'flipY()' },
    // Velocity
    { n:'velocityX',         m:'⚡ velocity',  v:'velocityX' },
    { n:'velocityY',         m:'⚡ velocity',  v:'velocityY' },
    { n:'vx',                m:'⚡ velocity',  v:'vx' },
    { n:'vy',                m:'⚡ velocity',  v:'vy' },
    { n:'setVelocity',       m:'⚡ velocity',  v:'setVelocity(${1:vx}, ${2:vy})' },
    { n:'stopMovement',      m:'⚡ velocity',  v:'stopMovement()' },
    { n:'bounceX',           m:'⚡ velocity',  v:'bounceX()' },
    { n:'bounceY',           m:'⚡ velocity',  v:'bounceY()' },
    // Gravity
    { n:'gravity',           m:'↓ gravity',   v:'gravity(${1:0}, ${2:-9.8})' },
    // Rotation / Scale
    { n:'getRotation',       m:'↻ rotation',  v:'getRotation()' },
    { n:'setRotation',       m:'↻ rotation',  v:'setRotation(${1:degrees})' },
    { n:'getScaleX',         m:'⤡ scale',     v:'getScaleX()' },
    { n:'setScaleX',         m:'⤡ scale',     v:'setScaleX(${1:value})' },
    { n:'getScaleY',         m:'⤡ scale',     v:'getScaleY()' },
    { n:'setScaleY',         m:'⤡ scale',     v:'setScaleY(${1:value})' },
    // Display
    { n:'show',              m:'👁 display',   v:'show()' },
    { n:'hide',              m:'👁 display',   v:'hide()' },
    { n:'setVisible',        m:'👁 display',   v:'setVisible(${1:true})' },
    { n:'getAlpha',          m:'👁 display',   v:'getAlpha()' },
    { n:'setAlpha',          m:'👁 display',   v:'setAlpha(${1:1})' },
    { n:'fadeIn',            m:'👁 display',   v:'fadeIn(${1:duration}, dt)' },
    { n:'fadeOut',           m:'👁 display',   v:'fadeOut(${1:duration}, dt)' },
    // Tag / Group
    { n:'setTag',            m:'🏷 tag',       v:"setTag('${1:myTag}')" },
    { n:'getTag',            m:'🏷 tag',       v:'getTag()' },
    { n:'setGroup',          m:'🏷 group',     v:"setGroup('${1:myGroup}')" },
    { n:'getGroup',          m:'🏷 group',     v:'getGroup()' },
    // Messaging
    { n:'sendMessage',       m:'📨 message',   v:"sendMessage('${1:tag}', '${2:message}', ${3:data})" },
    { n:'broadcast',         m:'📨 message',   v:"broadcast('${1:tag}', '${2:message}')" },
    { n:'broadcastGroup',    m:'📨 message',   v:"broadcastGroup('${1:group}', '${2:message}')" },
    { n:'broadcastAll',      m:'📨 message',   v:"broadcastAll('${1:message}')" },
    // Finding objects
    { n:'find',              m:'🔍 find',      v:"find('${1:label}')" },
    { n:'findWithTag',       m:'🔍 find',      v:"findWithTag('${1:tag}')" },
    { n:'findAllWithTag',    m:'🔍 find',      v:"findAllWithTag('${1:tag}')" },
    { n:'findAllInGroup',    m:'🔍 find',      v:"findAllInGroup('${1:group}')" },
    // Overlap
    { n:'overlaps',          m:'⬡ overlap',    v:'overlaps(${1:other})' },
    { n:'overlapsTag',       m:'⬡ overlap',    v:"overlapsTag('${1:tag}')" },
    { n:'overlapsAllWithTag',m:'⬡ overlap',    v:"overlapsAllWithTag('${1:tag}')" },
    // Destroy
    { n:'destroySelf',       m:'💥 destroy',   v:'destroySelf()' },
    { n:'destroy',           m:'💥 destroy',   v:'destroy(${1:other})' },
    // Scene
    { n:'gotoScene',         m:'🎬 scene',     v:"gotoScene('${1:SceneName}')" },
    { n:'pauseScene',        m:'⏸ scene',      v:'pauseScene()' },
    { n:'resumeScene',       m:'▶ scene',      v:'pauseScene(false)' },
    { n:'restartScene',      m:'↺ scene',      v:'restartScene()' },
    { n:'drawText',          m:'🔤 text',       v:"drawText('${1:Hello}', ${2:0}, ${3:0}, { fontSize: ${4:32}, fill: '${5:#ffffff}' })" },
    { n:'currentScene',      m:'🎬 scene',     v:'currentScene()' },
    { n:'currentSceneIndex', m:'🎬 scene',     v:'currentSceneIndex()' },
    { n:'sceneCount',        m:'🎬 scene',     v:'sceneCount()' },
    { n:'getSceneName',      m:'🎬 scene',     v:'getSceneName(${1:index})' },
    // Camera
    { n:'cameraFollow',      m:'📷 camera',    v:'cameraFollow(find("${1:Player}"), ${2:6})' },
    { n:'cameraUnfollow',    m:'📷 camera',    v:'cameraUnfollow()' },
    { n:'cameraMoveTo',      m:'📷 camera',    v:'cameraMoveTo(${1:x}, ${2:y})' },
    { n:'getCameraX',        m:'📷 camera',    v:'getCameraX()' },
    { n:'getCameraY',        m:'📷 camera',    v:'getCameraY()' },
    { n:'cameraShake',       m:'📷 camera',    v:'cameraShake(${1:0.2}, ${2:0.3})' },
    // Input
    { n:'isKeyDown',         m:'🎮 input',     v:"isKeyDown('${1:w}')" },
    { n:'isKeyJustDown',     m:'🎮 input',     v:"isKeyJustDown('${1:Space}')" },
    { n:'isKeyJustUp',       m:'🎮 input',     v:"isKeyJustUp('${1:w}')" },
    { n:'axisH',             m:'🎮 input',     v:'axisH()' },
    { n:'axisV',             m:'🎮 input',     v:'axisV()' },
    { n:'mouseX',            m:'🎮 input',     v:'mouseX()' },
    { n:'mouseY',            m:'🎮 input',     v:'mouseY()' },
    { n:'mouseDown',         m:'🎮 input',     v:'mouseDown()' },
    { n:'mouseJustDown',     m:'🎮 input',     v:'mouseJustDown()' },
    // Mobile / Touch
    { n:'isTouching',        m:'📱 mobile',    v:'isTouching()' },
    { n:'touchJustStarted',  m:'📱 mobile',    v:'touchJustStarted()' },
    { n:'onSwipe',           m:'📱 mobile',    v:"onSwipe('${1:left}', () => {\n  \n});" },
    { n:'onTap',             m:'📱 mobile',    v:"onTap(() => {\n  \n});" },
    { n:'onPinch',           m:'📱 mobile',    v:"onPinch((scale) => {\n  \n});" },
    // Animation
    { n:'playAnimation',     m:'▶ anim',      v:"playAnimation('${1:name}')" },
    { n:'stopAnimation',     m:'▶ anim',      v:'stopAnimation()' },
    { n:'currentAnimation',  m:'▶ anim',      v:'currentAnimation()' },
    // Physics — readable helper functions
    { n:'applyForce',        m:'⚙ physics',   v:'applyForce(${1:fx}, ${2:fy})' },
    { n:'applyImpulse',      m:'⚙ physics',   v:'applyImpulse(${1:ix}, ${2:iy})' },
    { n:'setPhysicsVelocity',m:'⚙ physics',   v:'setPhysicsVelocity(${1:vx}, ${2:vy})' },
    { n:'getVelX',           m:'⚙ physics',   v:'getVelX()' },
    { n:'getVelY',           m:'⚙ physics',   v:'getVelY()' },
    { n:'stopPhysics',       m:'⚙ physics',   v:'stopPhysics()' },
    { n:'setImmovable',      m:'⚙ physics',   v:'setImmovable(${1:true})' },
    // Kinematic ground / wall detection
    { n:'isOnGround',           m:'⚙ kinematic',         v:'isOnGround()' },
    { n:'isOnCeiling',          m:'⚙ kinematic',         v:'isOnCeiling()' },
    { n:'isOnWall',             m:'⚙ kinematic',         v:'isOnWall()' },
    // Physics body (advanced — direct access)
    { n:'physics.setVelocity',  m:'⚙ physics (dynamic)', v:'physics.setVelocity(${1:vx}, ${2:vy})' },
    { n:'physics.applyForce',   m:'⚙ physics (dynamic)', v:'physics.applyForce(${1:fx}, ${2:fy})' },
    { n:'physics.applyImpulse', m:'⚙ physics (dynamic)', v:'physics.applyImpulse(${1:ix}, ${2:iy})' },
    { n:'physics.velX',         m:'⚙ physics',           v:'physics.velX' },
    { n:'physics.velY',         m:'⚙ physics',           v:'physics.velY' },
    { n:'physics.isOnGround',   m:'⚙ kinematic',         v:'physics.isOnGround' },
    { n:'physics.isOnCeiling',  m:'⚙ kinematic',         v:'physics.isOnCeiling' },
    { n:'physics.isOnWall',     m:'⚙ kinematic',         v:'physics.isOnWall' },
    { n:'physics.stop',         m:'⚙ physics',           v:'physics.stop()' },
    { n:'physics.setImmovable', m:'⚙ physics',           v:'physics.setImmovable(${1:true})' },
    { n:'physics.immovable',    m:'⚙ physics',           v:'physics.immovable' },
    // Shared variables
    { n:'sceneVar',          m:'📦 vars',      v:'sceneVar.${1:myVar}' },
    { n:'globalVar',         m:'📦 vars',      v:'globalVar.${1:myVar}' },
    { n:'store.set',         m:'📦 vars',      v:"store.set('${1:key}', ${2:value})" },
    { n:'store.get',         m:'📦 vars',      v:"store.get('${1:key}', ${2:default})" },
    // Time
    { n:'getTime',           m:'⏱ time',      v:'getTime()' },
    // Math
    { n:'lerp',              m:'∑ math',      v:'lerp(${1:a}, ${2:b}, ${3:t})' },
    { n:'clamp',             m:'∑ math',      v:'clamp(${1:v}, ${2:min}, ${3:max})' },
    { n:'dist',              m:'∑ math',      v:'dist(${1:x1}, ${2:y1}, ${3:x2}, ${4:y2})' },
    { n:'rand',              m:'∑ math',      v:'rand(${1:min}, ${2:max})' },
    { n:'randInt',           m:'∑ math',      v:'randInt(${1:min}, ${2:max})' },
    { n:'sign',              m:'∑ math',      v:'sign(${1:v})' },
    { n:'toRad',             m:'∑ math',      v:'toRad(${1:degrees})' },
    { n:'toDeg',             m:'∑ math',      v:'toDeg(${1:radians})' },
    { n:'mapRange',          m:'∑ math',      v:'mapRange(${1:v}, ${2:a1}, ${3:b1}, ${4:a2}, ${5:b2})' },
    { n:'sin',               m:'∑ math',      v:'sin(${1:a})' },
    { n:'cos',               m:'∑ math',      v:'cos(${1:a})' },
    { n:'abs',               m:'∑ math',      v:'abs(${1:v})' },
    { n:'sqrt',              m:'∑ math',      v:'sqrt(${1:v})' },
    { n:'PI',                m:'∑ math',      v:'PI' },
    { n:'floor',             m:'∑ math',      v:'floor(${1:v})' },
    { n:'ceil',              m:'∑ math',      v:'ceil(${1:v})' },
    { n:'round',             m:'∑ math',      v:'round(${1:v})' },
    { n:'max',               m:'∑ math',      v:'max(${1:a}, ${2:b})' },
    { n:'min',               m:'∑ math',      v:'min(${1:a}, ${2:b})' },
    // Debug
    { n:'log',               m:'🐛 debug',    v:'log(${1:value})' },
    { n:'warn',              m:'🐛 debug',    v:'warn(${1:value})' },
    { n:'error',             m:'🐛 debug',    v:'error(${1:value})' },
    // Sound
    { n:'soundPlay',         m:'🔊 sound',    v:"soundPlay('${1:assetName}')" },
    { n:'soundPlay opts',    m:'🔊 sound',    v:"soundPlay('${1:name}', { loop:${2:false}, volume:${3:1.0}, range:${4:400} })" },
    { n:'soundStop',         m:'🔊 sound',    v:"soundStop('${1:assetName}')" },
    { n:'soundStopAll',      m:'🔊 sound',    v:'soundStopAll()' },
    // Timer
    { n:'wait',              m:'⏳ timer',    v:'wait(${1:seconds}, () => {\n  ${2:// code here}\n})' },
    // Physics control
    { n:'setPhysicsType',    m:'⚙ physics',   v:"setPhysicsType('${1:kinematic}')" },
    { n:'setCollision',      m:'⚙ physics',   v:'setCollision(${1:true})' },
    { n:'setSensor',         m:'⚙ physics',   v:'setSensor(${1:true})' },
    { n:'setCollisionCategory',m:'⚙ physics', v:'setCollisionCategory(${1:1})' },
    { n:'setCollisionMask',  m:'⚙ physics',   v:'setCollisionMask(${1:-1})' },
    // Tint
    { n:'setTint',           m:'🎨 tint',     v:"setTint('${1:#ffffff}')" },
    { n:'getTint',           m:'🎨 tint',     v:'getTint()' },
    // Distance
    { n:'distanceTo',        m:'📐 distance', v:"distanceTo('${1:tag}')" },
    { n:'distanceTo pos',    m:'📐 distance', v:'distanceTo(${1:x}, ${2:y})' },
    { n:'distanceTo obj',    m:'📐 distance', v:'distanceTo(find("${1:label}"))' },
    // Tween
    { n:'tween',             m:'✨ tween',    v:"tween({ ${1:alpha}:${2:0} }, ${3:0.5}, '${4:easeOut}')" },
    { n:'tween complete',    m:'✨ tween',    v:"tween({ ${1:x}:${2:5} }, ${3:1}, '${4:linear}', () => {\n  ${5:// done}\n})" },
    // Repeat timers
    { n:'repeat',            m:'⏲ repeat',   v:'repeat(${1:1}, () => {\n  ${2:// code}\n})' },
    { n:'cancelRepeat',      m:'⏲ repeat',   v:'cancelRepeat(${1:id})' },
    // Spawn
    { n:'spawnObject',       m:'➕ spawn',    v:"spawnObject('${1:AssetName}', ${2:x}, ${3:y})" },
    { n:'spawnObject cb',    m:'➕ spawn',    v:"spawnObject('${1:AssetName}', ${2:x}, ${3:y}, (obj) => {\n  ${4:// obj.velocityX = 10;}\n})" },
    // Raycast
    { n:'raycast',           m:'🔦 raycast',  v:'raycast(${1:x1}, ${2:y1}, ${3:x2}, ${4:y2})' },
    { n:'raycast tag',       m:'🔦 raycast',  v:"raycast(${1:x1}, ${2:y1}, ${3:x2}, ${4:y2}, '${5:enemy}')" },
    // Radius query
    { n:'getObjectsInRadius',m:'⭕ radius',   v:'getObjectsInRadius(${1:cx}, ${2:cy}, ${3:radius})' },
    // Z-order
    { n:'setZOrder',         m:'🔢 zorder',   v:'setZOrder(${1:10})' },
    { n:'getZOrder',         m:'🔢 zorder',   v:'getZOrder()' },
    // Coordinate conversion
    { n:'screenToWorld',     m:'📍 coords',   v:'screenToWorld(${1:sx}, ${2:sy})' },
    { n:'worldToScreen',     m:'📍 coords',   v:'worldToScreen(${1:wx}, ${2:wy})' },
    // Key event handlers
    { n:'onKeyDown',         m:'🎮 key event',v:"onKeyDown('${1:arrowleft}', () => {\n  ${2:// code}\n})" },
    { n:'onKeyUp',           m:'🎮 key event',v:"onKeyUp('${1:arrowleft}', () => {\n  ${2:// code}\n})" },
    // Physics helpers
    { n:'getPhysicsVelX',    m:'⚙ physics',  v:'getPhysicsVelX()' },
    { n:'getPhysicsVelY',    m:'⚙ physics',  v:'getPhysicsVelY()' },
    { n:'setGravityScale',   m:'⚙ physics',  v:'setGravityScale(${1:0})' },
    // Extra math
    { n:'smoothstep',        m:'∑ math',     v:'smoothstep(${1:lo}, ${2:hi}, ${3:x})' },
    { n:'normalize',         m:'∑ math',     v:'normalize(${1:vx}, ${2:vy})' },
    { n:'angleTo',           m:'∑ math',     v:'angleTo(${1:x1}, ${2:y1}, ${3:x2}, ${4:y2})' },
    // Debug draw
    { n:'drawDebugLine',     m:'🖊 debug draw',v:'drawDebugLine(${1:x1}, ${2:y1}, ${3:x2}, ${4:y2})' },
    { n:'drawDebugCircle',   m:'🖊 debug draw',v:'drawDebugCircle(${1:cx}, ${2:cy}, ${3:radius})' },
    // Scene transitions
    { n:'gotoScene fade',    m:'🎬 scene',    v:"gotoScene('${1:Level2}', 'fade')" },
    { n:'gotoScene slide',   m:'🎬 scene',    v:"gotoScene('${1:Level2}', 'slide-left')" },
].map(c => ({ caption:c.n, value:c.v, meta:c.m, score:950 }));


// ── Script Editor (Ace-powered) ───────────────────────────────
export async function openScriptEditor(obj, scriptName, initialCode) {
    document.getElementById('zengine-script-editor')?.remove();

    if (initialCode === undefined || initialCode === null) {
        initialCode = getScript(scriptName)?.code ?? _defaultScript(scriptName);
    }

    const ace = await _loadAce();
    ace.config.set('basePath', ACE_BASE);

    const overlay = document.createElement('div');
    overlay.id = 'zengine-script-editor';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#0b0d14;display:flex;flex-direction:column;font-family:system-ui,sans-serif;';

    const canDetach = !!obj && !!obj.scriptName && obj.scriptName === scriptName;
    const objLabel  = obj?.label ?? '';

    overlay.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:7px 14px;background:#0d0f1a;border-bottom:1px solid #1a1d2e;flex-shrink:0;user-select:none;">
            <svg viewBox="0 0 24 24" style="width:15px;height:15px;flex-shrink:0;fill:none;stroke:#7cb9f0;stroke-width:2.5;"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
            <span style="color:#7cb9f0;font-weight:700;font-size:13px;">${scriptName}.js</span>
            ${obj ? `<span style="color:#252535;">│</span><span style="color:#5a7a9a;font-size:11px;">attached to: <b style="color:#9bc;">${objLabel}</b></span>` : ''}
            <div style="flex:1;"></div>
            <span id="se-status" style="font-size:11px;transition:color .2s;margin-right:6px;"></span>
            <button id="se-save"   style="${_bs('#0f2540','#7cb9f0','#1e4a7a')}">Save <kbd style="opacity:.4;font-size:9px;">Ctrl+S</kbd></button>
            ${canDetach ? `<button id="se-detach" style="${_bs('#200a0a','#f87171','#3a1515')}margin-left:4px;">Detach</button>` : ''}
            <button id="se-close"  style="${_bs('#0f1018','#666','#1a1d28')}margin-left:4px;">✕</button>
        </div>
        <div style="display:flex;flex:1;min-height:0;">
            <div style="flex:1;position:relative;min-width:0;">
                <div id="se-ace" style="position:absolute;inset:0;"></div>
            </div>
            <div style="width:212px;flex-shrink:0;background:#080a11;border-left:1px solid #131525;overflow-y:auto;">
                ${_sidebarHTML()}
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    const editor = ace.edit('se-ace');
    editor.setTheme('ace/theme/tomorrow_night');
    editor.session.setMode('ace/mode/javascript');
    editor.setValue(initialCode, -1);
    editor.setOptions({
        enableBasicAutocompletion: true,
        enableSnippets:            true,
        enableLiveAutocompletion:  true,
        showPrintMargin:           false,
        fontSize:                  '13px',
        fontFamily:                '"Fira Code","Cascadia Code","Consolas",monospace',
        tabSize:                   2,
        useSoftTabs:               true,
        highlightActiveLine:       true,
        displayIndentGuides:       true,
        scrollPastEnd:             0.3,
    });

    const langTools = ace.require('ace/ext/language_tools');
    langTools.addCompleter({
        getCompletions(_ed, _sess, _pos, prefix, cb) {
            const lp = prefix.toLowerCase();
            cb(null, !lp ? COMPLETIONS : COMPLETIONS.filter(c => c.caption.toLowerCase().startsWith(lp)));
        },
    });

    let _dirty = false;
    const statusEl = overlay.querySelector('#se-status');
    editor.on('change', () => {
        if (!_dirty) { _dirty = true; statusEl.textContent = '● unsaved'; statusEl.style.color = '#facc15'; }
    });

    async function _doSave() {
        saveScript(scriptName, editor.getValue());
        if (obj) obj.scriptName = scriptName;
        _dirty = false;
        statusEl.textContent = '✓ saved'; statusEl.style.color = '#4ade80';
        setTimeout(() => { if (!_dirty) statusEl.textContent = ''; }, 2000);
        _logConsole(`💾 Script "${scriptName}" saved`, '#4ade80');
        import('./engine.ui.js').then(m => m.syncPixiToInspector());
    }

    overlay.querySelector('#se-save').addEventListener('click', _doSave);
    overlay.querySelector('#se-close').addEventListener('click', async () => {
        if (_dirty && !confirm('Unsaved changes — save before closing?')) { overlay.remove(); return; }
        if (_dirty) await _doSave();
        overlay.remove();
    });
    overlay.querySelector('#se-detach')?.addEventListener('click', () => {
        if (obj) { obj.scriptName = null; _logConsole(`✂️ Script detached from "${obj.label}"`, '#facc15'); import('./engine.ui.js').then(m => m.syncPixiToInspector()); }
        overlay.remove();
    });

    editor.commands.addCommand({ name:'save', bindKey:{win:'Ctrl-S',mac:'Command-S'}, exec:_doSave });
    editor.focus();
}

// ── Create Script prompt ──────────────────────────────────────
export function promptCreateScript(obj) {
    const modal = _modal();
    modal.innerHTML = `
        <div style="padding:22px;min-width:330px;">
            <div style="color:#e0e0e0;font-weight:700;font-size:14px;margin-bottom:4px;">Create Script</div>
            <div style="color:#555;font-size:11px;margin-bottom:14px;">Enter a name for the new script</div>
            <input id="sn-input" type="text" placeholder="e.g. PlayerController" autocomplete="off"
                style="width:100%;box-sizing:border-box;background:#0d0d14;color:#e0e0e0;border:1px solid #3a72a5;border-radius:4px;padding:7px 10px;font-size:13px;outline:none;font-family:monospace;">
            <div id="sn-err" style="color:#f87171;font-size:11px;margin-top:4px;min-height:14px;"></div>
            <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end;">
                <button id="sn-cancel" style="${_bs('#0f1018','#888','#1a1d28')}">Cancel</button>
                <button id="sn-ok"     style="${_bs('#0f2540','#7cb9f0','#1e4a7a')}">Create</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    const inp = modal.querySelector('#sn-input');
    const err = modal.querySelector('#sn-err');
    inp.focus();
    modal.querySelector('#sn-cancel').onclick = () => modal.remove();
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') modal.remove(); });
    modal.querySelector('#sn-ok').onclick = () => {
        const name = inp.value.trim().replace(/[^a-zA-Z0-9_\-]/g, '');
        if (!name) { err.textContent = 'Name is required'; return; }
        if (state.scripts.find(s => s.name === name)) { err.textContent = `"${name}" already exists`; return; }
        modal.remove();
        openScriptEditor(obj, name, _defaultScript(name));
    };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') modal.querySelector('#sn-ok').click(); });
}

// ── Load / Attach Script prompt ───────────────────────────────
export function promptLoadScript(obj) {
    const modal = _modal();
    if (state.scripts.length === 0) {
        modal.innerHTML = `
            <div style="padding:24px;min-width:280px;text-align:center;">
                <div style="font-size:26px;margin-bottom:8px;">📄</div>
                <div style="color:#e0e0e0;font-weight:600;margin-bottom:6px;">No scripts yet</div>
                <div style="color:#555;font-size:11px;margin-bottom:14px;">Use "Create Script" to write your first script</div>
                <button id="sn-close" style="${_bs('#0f1018','#aaa','#1a1d28')}">Close</button>
            </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('#sn-close').onclick = () => modal.remove();
        return;
    }

    const rows = state.scripts.map(s => {
        const attached = obj.scriptName === s.name;
        const ts = new Date(s.updatedAt).toLocaleDateString();
        return `
            <div class="sl-row" data-name="${s.name}"
                style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:4px;margin:2px 0;
                background:${attached ? 'rgba(58,114,165,.15)' : 'transparent'};">
                <svg viewBox="0 0 24 24" style="width:12px;height:12px;flex-shrink:0;fill:none;stroke:${attached?'#7cb9f0':'#383850'};stroke-width:2;">
                    <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
                </svg>
                <div style="flex:1;min-width:0;">
                    <div style="color:${attached?'#7cb9f0':'#ccc'};font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                        ${s.name}${attached ? ' <span style="color:#4ade80;font-size:10px;font-weight:400;">● attached</span>' : ''}
                        ${s.isDefault ? ' <span style="color:#4ade80;font-size:9px;font-weight:400;">BUILT-IN</span>' : ''}
                    </div>
                    <div style="color:#383850;font-size:10px;">${ts}</div>
                </div>
                <button class="sl-edit"   data-name="${s.name}" style="${_bs('#0d200d','#8f8','#1e3a1e','3px')}font-size:10px;padding:3px 8px;">Edit</button>
                <button class="sl-attach" data-name="${s.name}" style="${_bs('#0f2540','#7cb9f0','#1e4a7a','3px')}font-size:10px;padding:3px 8px;">${attached ? '✓' : 'Attach'}</button>
            </div>
        `;
    }).join('');

    modal.innerHTML = `
        <div style="padding:18px;min-width:380px;max-height:70vh;display:flex;flex-direction:column;">
            <div style="color:#e0e0e0;font-weight:700;font-size:14px;margin-bottom:3px;">Load Script</div>
            <div style="color:#444;font-size:11px;margin-bottom:10px;">Attach a script to <span style="color:#9bc;">${obj.label}</span></div>
            <div style="flex:1;overflow-y:auto;">${rows}</div>
            ${obj.scriptName ? `<div style="margin-top:10px;padding-top:8px;border-top:1px solid #1a1a28;display:flex;justify-content:space-between;align-items:center;">
                <span style="color:#444;font-size:11px;">Attached: <span style="color:#9bc;">${obj.scriptName}</span></span>
                <button id="sl-detach" style="${_bs('#1a0808','#f87171','#3a1818','3px')}font-size:10px;padding:3px 10px;">Detach</button>
            </div>` : ''}
            <button id="sl-cancel" style="margin-top:10px;${_bs('#0f1018','#888','#1a1d28')}width:100%;text-align:center;">Cancel</button>
        </div>
    `;
    document.body.appendChild(modal);

    modal.querySelectorAll('.sl-row').forEach(r => {
        r.addEventListener('mouseenter', () => { if (!r.style.background.includes('165')) r.style.background = 'rgba(255,255,255,.04)'; });
        r.addEventListener('mouseleave', () => { if (!r.style.background.includes('165')) r.style.background = 'transparent'; });
    });
    modal.querySelectorAll('.sl-edit').forEach(b => {
        b.onclick = e => {
            e.stopPropagation();
            const rec = getScript(b.dataset.name);
            modal.remove();
            openScriptEditor(obj, b.dataset.name, rec?.code ?? '');
        };
    });
    modal.querySelectorAll('.sl-attach').forEach(b => {
        b.onclick = e => {
            e.stopPropagation();
            obj.scriptName = b.dataset.name;
            _logConsole(`📎 "${b.dataset.name}" attached to "${obj.label}"`, '#4ade80');
            modal.remove();
            import('./engine.ui.js').then(m => m.syncPixiToInspector());
        };
    });
    modal.querySelector('#sl-detach')?.addEventListener('click', () => {
        const old = obj.scriptName; obj.scriptName = null;
        _logConsole(`✂️ "${old}" detached from "${obj.label}"`, '#facc15');
        modal.remove();
        import('./engine.ui.js').then(m => m.syncPixiToInspector());
    });
    modal.querySelector('#sl-cancel').onclick = () => modal.remove();
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') modal.remove(); });
}

// ── Shared helpers ────────────────────────────────────────────
function _bs(bg, color, border, radius='4px') {
    return `background:${bg};color:${color};border:1px solid ${border};border-radius:${radius};padding:5px 12px;cursor:pointer;font-family:inherit;font-size:12px;`;
}

function _modal() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;';
    const box = document.createElement('div');
    box.style.cssText = 'background:#0d0f1a;border:1px solid #1e2038;border-radius:8px;box-shadow:0 24px 64px rgba(0,0,0,.9);font-family:system-ui,sans-serif;';
    wrap.appendChild(box);
    Object.defineProperty(wrap,'innerHTML',{ get:()=>box.innerHTML, set:v=>{ box.innerHTML=v; } });
    wrap.querySelector    = s => box.querySelector(s);
    wrap.querySelectorAll = s => box.querySelectorAll(s);
    wrap.addEventListener('click', e => { if (e.target===wrap) wrap.remove(); });
    return wrap;
}

function _sidebarHTML() {
    const G = [
        ['Events',         ['onStart(fn)', 'onUpdate(fn)', 'onStop(fn)', 'onCollisionEnter(fn)', 'onCollisionStay(fn)', 'onCollisionExit(fn)', 'onOverlapEnter(fn)', 'onOverlapExit(fn)', 'onMessage("msg",fn)', 'onMouseClick(fn)']],
        ['this.position',  ['getX() / setX(v)', 'getY() / setY(v)', 'moveTo(x, y)', 'move(dx, dy)', 'moveForward(speed)', 'lookAt(tx, ty)', 'flipX() / flipY()']],
        ['this.velocity',  ['velocityX / vx', 'velocityY / vy', 'setVelocity(vx,vy)', 'stopMovement()', 'bounceX() / bounceY()']],
        ['this.gravity',   ['gravity(gx, gy)', '  gravity(0,-9.8) = fall down', '  gravity(0, 9.8) = float up']],
        ['Rotation/Scale', ['getRotation()', 'setRotation(deg)', 'getScaleX/Y()', 'setScaleX/Y(v)']],
        ['Display',        ['show() / hide()', 'setVisible(v)', 'getAlpha() / setAlpha(v)', 'fadeIn(t, dt)', 'fadeOut(t, dt)', 'setTint("#ff0000")', 'getTint()']],
        ['Tag & Group',    ['setTag("name") / getTag()', 'setGroup("name") / getGroup()']],
        ['Messaging',      ['sendMessage(tag, msg, data)', 'broadcast(tag, msg)', 'broadcastGroup(grp, msg)', 'broadcastAll(msg)', 'onMessage("msg", fn)']],
        ['Find objects',   ['find("label")', 'findWithTag("tag")', 'findAllWithTag("tag")', 'findAllInGroup("grp")']],
        ['Overlap (AABB)', ['overlaps(other)', 'overlapsTag("tag")', 'overlapsAllWithTag("tag")', 'onOverlapEnter(fn)', 'onOverlapExit(fn)']],
        ['Distance',       ['distanceTo("tag")', 'distanceTo(x, y)', 'distanceTo(find("label"))']],
        ['Destroy',        ['destroySelf()', 'destroy(other)']],
        ['Scene',          ['gotoScene("Name") / gotoScene(1)', 'gotoScene("Level2", "fade")', 'gotoScene("Level2", "slide-left")', 'gotoScene("Level2", "zoom")', 'pauseScene()  →  pause', 'pauseScene(false)  →  resume', 'restartScene()  →  restart from beginning', 'currentScene()', 'currentSceneIndex()', 'sceneCount()']],
        ['Text Objects',   ['drawText("Hello", x, y, { fontSize:32, fill:"#fff" })', 'var t = drawText("Score: 0", 0, 3)', 't.text = "Score: " + n', 'find("Label").text = "New text"', 'find("Label").setText("text")', 'find("Label").setTextStyle({ fontSize:48, fill:"#f00" })']],
        ['Camera',         ['cameraFollow(obj, smooth)', 'cameraUnfollow()', 'cameraMoveTo(x, y)', 'getCameraX/Y()', 'cameraShake(amp, dur)']],
        ['Input',          ['isKeyDown("w")', 'isKeyJustDown("Space")', 'isKeyJustUp("w")', 'axisH() → -1/0/1', 'axisV() → -1/0/1', 'mouseX() / mouseY()', 'mouseDown() / mouseJustDown()', 'onKeyDown("a", fn)', 'onKeyUp("a", fn)']],
        ['Mobile / Touch (Hammer.js)', ['isTouching()  — finger on screen?', 'touchJustStarted()  — new tap this frame?', 'onSwipe("left"|"right"|"up"|"down"|"any", fn)', 'onTap(fn)  — quick touch anywhere', 'onPinch(fn)  — fn receives scale (>1 zoom in)', 'onMouseClick(fn)  — works for tap too']],
        ['Animation',      ['playAnimation("name")', 'stopAnimation()', 'currentAnimation()']],
        ['Tween',          ['tween({ alpha:0 }, 0.5)', 'tween({ x:5 }, 1, "easeOut")', 'tween({ scaleX:2 }, 1, "linear", () => {})', 'Easings: linear easeIn easeOut easeInOut', '  easeInCubic easeOutCubic elastic', '  elasticOut bounce steps2 steps4']],
        ['Repeat / Timer', ['repeat(1.5, fn) → id', 'cancelRepeat(id)', 'wait(seconds, fn)']],
        ['Spawn / Query',  ['spawnObject("Asset", x, y)', 'spawnObject("Asset", x, y, (obj)=>{})', 'raycast(x1,y1, x2,y2)', 'raycast(x1,y1, x2,y2, "tag")', 'getObjectsInRadius(cx,cy, r)', 'getObjectsInRadius(cx,cy, r, "tag")']],
        ['Z-order / Coords',['setZOrder(n) / getZOrder()', 'screenToWorld(sx, sy) → {x,y}', 'worldToScreen(wx, wy) → {x,y}']],
        ['Physics (readable helpers)', ['applyForce(fx, fy)  — push every frame (dynamic)', 'applyImpulse(ix, iy)  — instant hit / jump', 'setPhysicsVelocity(vx, vy)  — set speed directly', 'getVelX() / getVelY()  — read current speed', 'stopPhysics()  — freeze body', 'setImmovable(true/false)', 'isOnGround() / isOnCeiling() / isOnWall()', 'setGravityScale(n)']],
        ['Physics (advanced)', ['physics.setVelocity(vx,vy)', 'physics.applyForce(fx,fy)', 'physics.applyImpulse(ix,iy)', 'physics.stop()', 'physics.velX / velY', 'physics.isOnGround / isOnCeiling / isOnWall', 'physics.setImmovable(v) / physics.immovable']],
        ['Physics control',['setPhysicsType("static"|"kinematic"|"dynamic"|"none")', 'setCollision(true/false)', 'setSensor(true)', 'setCollisionCategory(n)', 'setCollisionMask(n)']],
        ['Sound',          ['soundPlay("name")', "soundPlay('n', {loop,volume,range})", 'soundStop("name")', 'soundStopAll()']],
        ['Shared vars',    ['sceneVar.myVar (scene-wide)', 'globalVar.myVar (all scenes)', 'store.set/get (private)']],
        ['Time',           ['getTime() → seconds']],
        ['Math',           ['lerp / clamp / dist', 'rand / randInt / sign', 'toRad / toDeg / mapRange', 'sin / cos / abs / sqrt', 'PI / floor / ceil / round', 'max / min', 'smoothstep(lo, hi, x)', 'normalize(vx, vy) → {x,y}', 'angleTo(x1,y1, x2,y2) → deg']],
        ['Debug draw',     ['drawDebugLine(x1,y1, x2,y2)', 'drawDebugLine(x1,y1, x2,y2, "#f00", 1, 2)', 'drawDebugCircle(cx,cy, radius)', 'drawDebugCircle(cx,cy, r, "#f00", 1)']],
        ['Debug',          ['log(...)', 'warn(...)', 'error(...)']],
    ];
    return `<style>
        .se-g  { padding:5px 0 2px; border-top:1px solid #0f111c; }
        .se-g:first-child { border-top:none; }
        .se-gt { padding:4px 10px 2px; color:#1e4a7a; font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:1px; }
        .se-gi { padding:1px 10px; color:#2a3a4a; font-size:10px; line-height:1.7; font-family:monospace; }
        .se-gi:hover { color:#5a8aaa; cursor:default; }
    </style>` + G.map(([t,items]) => `
        <div class="se-g">
            <div class="se-gt">${t}</div>
            ${items.map(i=>`<div class="se-gi">${i}</div>`).join('')}
        </div>
    `).join('');
}

function _defaultScript(name) {
    return `// ================================================================
// Script: ${name}
// Runs only during Play Mode. The editor is always safe.
//
// POSITION:      getX() / setX(v)      getY() / setY(v)
// MOVEMENT:      move(dx, dy)          moveTo(x, y)        moveForward(speed)
// VELOCITY:      velocityX = 5         velocityY = -3       (kinematic/no-body: auto-applied)
// PHYSICS:       applyForce(fx, fy)    applyImpulse(ix, iy)   setPhysicsVelocity(vx, vy)
//                getVelX() / getVelY() stopPhysics()  isOnGround()  isOnWall()
// GRAVITY:       gravity(0, -9.8)      (call once in onStart)
// TAG:           setTag("player")      findWithTag("enemy")
// MESSAGE:       sendMessage("tag","msg",data)   onMessage("msg",fn)
// SCENE:         gotoScene("Level2")   currentScene()
// CAMERA:        cameraFollow(find("Player"), 6)
// SOUND:         soundPlay("Jump")     soundStop("Jump")
// TIMER:         wait(2, () => { log("done!"); })
// TINT:          setTint("#ff0000")    setTint("#ffffff")
// DISTANCE:      distanceTo("enemy")   distanceTo(x, y)
// OVERLAP:       overlapsTag("Coin")   onOverlapEnter(fn)
// MOBILE:        onSwipe("left", fn)   onTap(fn)   isTouching()
// PHYSICS TYPE:  setPhysicsType("static")   setCollision(false)
// GLOBAL VARS:   globalVar.score = 0   (shared across ALL scripts)
// SCENE VARS:    sceneVar.lives = 3    (shared within this scene)
// ================================================================


onStart(() => {
  // Runs once when Play is pressed.
  setTag("${name.toLowerCase()}");
  log("${name} started!");

  // Example: make camera follow this object
  // cameraFollow(find("${name}"), 6);

  // Example: enable gravity (negative Y = down in this engine)
  // gravity(0, -9.8);

  // Example: play background music on start
  // soundPlay("Music", { loop: true, volume: 0.6 });
});


onUpdate((dt) => {
  // Runs every frame. dt = seconds since last frame.
  // Always multiply movement values by dt for smooth motion.

  // ── Keyboard movement ─────────────────────────────────────
  const speed = 5;
  move(axisH() * speed * dt,   // A / D  or  ← →
       axisV() * speed * dt);  // W / S  or  ↑ ↓

  // ── Velocity-based movement ───────────────────────────────
  // velocityX = axisH() * speed;   // set each frame
  // velocityY = axisV() * speed;   // (auto-applied, no need to call move)

  // ── Overlap check (no physics body needed) ────────────────
  // var coin = overlapsTag("coin");
  // if (coin) {
  //   globalVar.score = (globalVar.score || 0) + 1;
  //   log("Score: " + globalVar.score);
  //   destroy(coin);
  //   soundPlay("Pickup");
  // }

  // ── Distance check ────────────────────────────────────────
  // var d = distanceTo("enemy");
  // if (d < 2) { warn("Enemy too close!"); }

});


onStop(() => {
  // Runs once when Play is stopped.
  soundStopAll();
  log("${name} stopped.");
});


onCollisionEnter((other) => {
  // Fires the MOMENT this object touches another (needs physics body).
  if (!other) return;
  log("Touched: " + other.name);

  // Example: bounce off a wall
  // if (other.tag === "wall") bounceX();
});


onCollisionStay((other) => {
  // Fires every frame WHILE touching another object.
  // Good for: floor detection, damage over time, etc.
});


onCollisionExit((other) => {
  // Fires the MOMENT contact ends.
});


onOverlapEnter((other) => {
  // Like onCollisionEnter but works WITHOUT a physics body (pure AABB).
  // Perfect for: coins, checkpoints, trigger zones, doors.
  if (!other) return;
  log("Overlapped: " + other.name);
});


onMessage("takeDamage", (amount) => {
  // Called when: sendMessage("${name.toLowerCase()}", "takeDamage", 10)
  warn("Took " + amount + " damage!");
  // setTint("#ff0000");
  // wait(0.2, () => setTint("#ffffff"));
});


onMessage("heal", (amount) => {
  log("Healed by " + amount);
});
`;
}

function _logConsole(msg, color = '#e0e0e0') {
    const level = color === '#f87171' ? 'error' : color === '#facc15' ? 'warn' : color === '#4ade80' ? 'system' : 'log';
    import('./engine.console.js').then(m => m.engineLog(msg, level));
}
