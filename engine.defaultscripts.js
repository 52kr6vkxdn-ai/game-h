/* ============================================================
   Zengine — engine.defaultscripts.js
   Ready-to-use starter scripts. Injected into every new project.

   Users attach these to any sprite via Inspector → Load Script.

   Scripts:
     PlatformerPlayer  — WASD/arrows + jump + gravity (kinematic body)
     TopDownPlayer     — 8-dir movement + mouse aim + camera (kinematic or none)
     PatrolEnemy       — patrol + player detection + messaging
     HealthSystem      — HP, damage, heal, flash invincibility
     Rotator           — constant rotation (coins, hazards)
     Destroyer         — self-destruct after a timer with fade
     Oscillator        — sine-wave bobbing motion
     SceneManager      — handles scene transitions & score display
   ============================================================ */

export const DEFAULT_SCRIPTS = [

// ── 1. Platformer Player ─────────────────────────────────────
{
    name: 'PlatformerPlayer',
    code: `// ============================================================
// PLATFORMER PLAYER
// Requires: Kinematic physics body on this object.
//           A tilemap or static floor below to land on.
//
// Controls:
//   A / D  or  ← →     move left / right
//   W / Space  or  ↑   jump
// ============================================================

// ── Tuning ───────────────────────────────────────────────────
var SPEED       = 5;     // world units per second
var JUMP_FORCE  = 12;    // upward velocity applied on jump
var GRAVITY     = -28;   // downward acceleration per second squared
var MAX_FALL    = -20;   // terminal velocity (cap)
var COYOTE_TIME = 0.12;  // seconds you can still jump after leaving a ledge

// ── State ────────────────────────────────────────────────────
var grounded    = false;
var coyote      = 0;
var facing      = 1;     // 1 = right, -1 = left

onStart(() => {
  setTag("player");
  setGroup("characters");
  log("Platformer Player ready — A/D to move, W/Space to jump");

  // Camera follows this object
  cameraFollow(findWithTag("player"), 7);
});

onUpdate((dt) => {

  // ── Gravity ────────────────────────────────────────────────
  velocityY = velocityY + GRAVITY * dt;
  if (velocityY < MAX_FALL) velocityY = MAX_FALL;

  // ── Horizontal movement ────────────────────────────────────
  var h = axisH();
  velocityX = h * SPEED;
  if (h > 0) { facing = 1; setScaleX(1); }
  if (h < 0) { facing = -1; setScaleX(-1); }

  // ── Jump ──────────────────────────────────────────────────
  coyote = coyote - dt;
  if (coyote < 0) coyote = 0;

  if (isKeyJustDown("w") || isKeyJustDown("arrowup") || isKeyJustDown(" ")) {
    if (grounded || coyote > 0) {
      velocityY = JUMP_FORCE;
      grounded  = false;
      coyote    = 0;
    }
  }

  // ── Animation ─────────────────────────────────────────────
  if (!grounded) {
    playAnimation(velocityY > 0 ? "jump" : "fall");
  } else if (abs(velocityX) > 0.1) {
    playAnimation("run");
  } else {
    playAnimation("idle");
  }

});

onCollisionEnter((other) => {
  if (!other) return;
  // Landing detection — we are above the other object
  if (getY() >= other.y) {
    grounded = true;
    coyote   = COYOTE_TIME;
    if (velocityY < 0) velocityY = 0;
  }
});

onCollisionExit((other) => {
  if (grounded) {
    grounded = false;
    coyote   = COYOTE_TIME;
  }
});

onStop(() => {
  velocityX = 0;
  velocityY = 0;
  grounded  = false;
});
`,
},

// ── 2. Top-Down Player ───────────────────────────────────────
{
    name: 'TopDownPlayer',
    code: `// ============================================================
// TOP-DOWN PLAYER
// 8-directional WASD/arrows movement.
// Camera follows this object smoothly.
// Mouse rotates the player to aim.
//
// Works with or without a physics body.
// ============================================================

var SPEED = 5;   // world units per second

onStart(() => {
  setTag("player");
  log("Top-Down Player ready — WASD or arrows to move, mouse to aim");

  // Camera follows this object
  cameraFollow(findWithTag("player"), 6);
});

onUpdate((dt) => {

  // ── Movement ──────────────────────────────────────────────
  var h = axisH();
  var v = axisV();
  move(h * SPEED * dt, v * SPEED * dt);

  // ── Aim toward mouse ──────────────────────────────────────
  lookAt(mouseX(), mouseY());

  // ── Animation ─────────────────────────────────────────────
  var moving = abs(h) > 0.01 || abs(v) > 0.01;
  playAnimation(moving ? "walk" : "idle");

});

onOverlapEnter((other) => {
  if (!other) return;
  if (other.tag === "coin") {
    sceneVar.score = (sceneVar.score || 0) + 1;
    log("Score: " + sceneVar.score);
    destroy(other);
  }
});

onMessage("enemySpotted", () => {
  warn("Enemy has spotted you!");
});

onStop(() => { /* nothing to clean up */ });
`,
},

// ── 3. Patrol Enemy ──────────────────────────────────────────
{
    name: 'PatrolEnemy',
    code: `// ============================================================
// PATROL ENEMY
// Walks back and forth. Detects the player. Responds to damage.
//
// Setup: Give this object a Kinematic physics body.
//        Attach HealthSystem script as well for full HP logic.
// ============================================================

var SPEED        = 2.5;   // patrol speed (world units/sec)
var PATROL_DIST  = 4;     // world units to walk each direction
var DETECT_RANGE = 4;     // detection radius (world units)
var HP           = 3;

var startX  = 0;
var dirX    = 1;      // 1 = right, -1 = left
var alerted = false;

onStart(() => {
  setTag("enemy");
  setGroup("enemies");
  startX = getX();
  log("Patrol Enemy ready  HP: " + HP);
});

onUpdate((dt) => {
  if (HP <= 0) return;

  // ── Patrol ────────────────────────────────────────────────
  move(dirX * SPEED * dt, 0);
  setScaleX(dirX);

  if (getX() > startX + PATROL_DIST) dirX = -1;
  if (getX() < startX - PATROL_DIST) dirX =  1;

  // ── Player detection ──────────────────────────────────────
  var player = findWithTag("player");
  if (player) {
    var d = dist(getX(), getY(), player.x, player.y);
    if (d < DETECT_RANGE && !alerted) {
      alerted = true;
      broadcast("player", "enemySpotted");
      warn("Player detected at distance " + d.toFixed(1));
    }
    if (d >= DETECT_RANGE + 1) alerted = false;
  }
});

onCollisionEnter((other) => {
  if (!other || other.tag === "player") return;
  dirX = -dirX;   // reverse on hitting a wall
});

onMessage("takeDamage", (amount) => {
  HP = HP - (amount || 1);
  warn("Enemy hit!  HP: " + HP);
  if (HP <= 0) {
    log("Enemy defeated!");
    sceneVar.score = (sceneVar.score || 0) + 10;
    destroySelf();
  }
});

onMessage("freeze", () => {
  dirX = 0;
});

onStop(() => {
  HP      = 3;
  alerted = false;
});
`,
},

// ── 4. Health System ─────────────────────────────────────────
{
    name: 'HealthSystem',
    code: `// ============================================================
// HEALTH SYSTEM
// Gives any object hitpoints, damage, healing, and death.
// Works via messages — attach to any object.
//
// Send messages from another script:
//   sendMessage("player", "takeDamage", 1)
//   sendMessage("player", "heal", 2)
// ============================================================

var MAX_HP    = 10;
var I_FRAMES  = 1.0;   // invincibility seconds after being hit

var hp         = MAX_HP;
var invincible = false;
var iTimer     = 0;

onStart(() => {
  hp = MAX_HP;
  setAlpha(1);
  log("Health system ready  HP: " + hp + " / " + MAX_HP);
});

onUpdate((dt) => {
  if (invincible) {
    iTimer = iTimer - dt;
    // Flash effect while invincible
    setAlpha(iTimer % 0.15 < 0.075 ? 0.25 : 1.0);
    if (iTimer <= 0) {
      invincible = false;
      setAlpha(1);
    }
  }
});

onMessage("takeDamage", (amount) => {
  if (invincible) return;
  hp = hp - (amount || 1);
  if (hp < 0) hp = 0;
  warn("Took " + (amount||1) + " damage — HP: " + hp + "/" + MAX_HP);
  invincible = true;
  iTimer     = I_FRAMES;
  cameraShake(0.15, 0.2);
  if (hp <= 0) {
    log("Died!");
    broadcastAll("entityDied");
    destroySelf();
  }
});

onMessage("heal", (amount) => {
  hp = hp + (amount || 1);
  if (hp > MAX_HP) hp = MAX_HP;
  setAlpha(1);
  log("Healed — HP: " + hp + "/" + MAX_HP);
});

onMessage("getHP", () => hp);

onStop(() => {
  hp         = MAX_HP;
  invincible = false;
  setAlpha(1);
});
`,
},

// ── 5. Rotator ────────────────────────────────────────────────
{
    name: 'Rotator',
    code: `// ============================================================
// ROTATOR
// Rotates this object at a constant speed.
// Great for: coins, spinning hazards, loading icons.
// ============================================================

var DEGREES_PER_SECOND = 180;   // positive = clockwise

onUpdate((dt) => {
  setRotation(getRotation() + DEGREES_PER_SECOND * dt);
});
`,
},

// ── 6. Destroyer ─────────────────────────────────────────────
{
    name: 'Destroyer',
    code: `// ============================================================
// DESTROYER
// Removes this object after a set lifetime.
// Fades out near the end.
// Perfect for: bullets, explosions, pickup flashes, VFX.
// ============================================================

var LIFETIME   = 3.0;   // seconds until removed
var FADE_START = 0.8;   // seconds before death to begin fading

var elapsed = 0;

onStart(() => {
  elapsed = 0;
  setAlpha(1);
});

onUpdate((dt) => {
  elapsed = elapsed + dt;

  if (elapsed > LIFETIME - FADE_START) {
    var t = (LIFETIME - elapsed) / FADE_START;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    setAlpha(t);
  }

  if (elapsed >= LIFETIME) {
    destroySelf();
  }
});
`,
},

// ── 7. Oscillator ────────────────────────────────────────────
{
    name: 'Oscillator',
    code: `// ============================================================
// OSCILLATOR
// Bobs this object up and down (or side to side) with a
// smooth sine wave.
// Great for: floating platforms, coins, decorative elements.
// ============================================================

var AMPLITUDE = 0.5;    // how far to move (world units)
var FREQUENCY = 1.0;    // oscillations per second
var AXIS      = "y";    // "y" = up/down,  "x" = left/right

var originX = 0;
var originY = 0;

onStart(() => {
  originX = getX();
  originY = getY();
});

onUpdate((dt) => {
  var t      = getTime() * FREQUENCY * PI * 2;
  var offset = sin(t) * AMPLITUDE;

  if (AXIS === "y") {
    setY(originY + offset);
  } else {
    setX(originX + offset);
  }
});
`,
},

// ── 8. Scene Manager ─────────────────────────────────────────
{
    name: 'SceneManager',
    code: `// ============================================================
// SCENE MANAGER
// Manages score, lives, and scene transitions.
// Attach to any persistent object (like a UI overlay sprite).
//
// Other scripts can do:
//   sceneVar.score += 10;
//   sendMessage("scenemanager", "nextScene");
//   sendMessage("scenemanager", "restartScene");
//   sendMessage("scenemanager", "gotoScene", "Level2");
// ============================================================

onStart(() => {
  setTag("scenemanager");

  sceneVar.score  = sceneVar.score  || 0;
  sceneVar.lives  = sceneVar.lives  || 3;
  sceneVar.paused = false;

  globalVar.highScore = globalVar.highScore || 0;

  log("Scene: " + currentScene() + "  (" + (currentSceneIndex()+1) + " of " + sceneCount() + ")");
  log("Score: " + sceneVar.score + "  Lives: " + sceneVar.lives);
});

onUpdate((dt) => {
  if (sceneVar.score > (globalVar.highScore || 0)) {
    globalVar.highScore = sceneVar.score;
  }
});

onMessage("nextScene", () => {
  var next = currentSceneIndex() + 1;
  if (next < sceneCount()) {
    log("Going to scene: " + getSceneName(next));
    gotoScene(next);
  } else {
    log("No more scenes! Final score: " + sceneVar.score);
    broadcastAll("gameComplete");
  }
});

onMessage("restartScene", () => {
  log("Restarting: " + currentScene());
  gotoScene(currentSceneIndex());
});

onMessage("gotoScene", (nameOrIndex) => {
  gotoScene(nameOrIndex);
});

onMessage("addScore", (amount) => {
  sceneVar.score = sceneVar.score + (amount || 1);
  log("Score: " + sceneVar.score);
});

onMessage("loseLife", () => {
  sceneVar.lives = sceneVar.lives - 1;
  warn("Lives remaining: " + sceneVar.lives);
  if (sceneVar.lives <= 0) {
    broadcastAll("gameOver");
    log("GAME OVER — final score: " + sceneVar.score);
  }
});

onMessage("entityDied", () => {
  sceneVar.score = sceneVar.score + 5;
});
`,
},

];

// ── Inject default scripts into a fresh project ───────────────
export function injectDefaultScripts(scriptStore) {
    for (const ds of DEFAULT_SCRIPTS) {
        if (!scriptStore.find(s => s.name === ds.name)) {
            scriptStore.push({
                id:        'default_' + ds.name,
                name:      ds.name,
                code:      ds.code,
                updatedAt: Date.now(),
                isDefault: true,
            });
        }
    }
}

// ── Force-refresh default scripts (replaces existing ones) ────
export function refreshDefaultScripts(scriptStore) {
    for (const ds of DEFAULT_SCRIPTS) {
        const existing = scriptStore.find(s => s.name === ds.name && s.isDefault);
        if (existing) {
            existing.code      = ds.code;
            existing.updatedAt = Date.now();
        } else {
            scriptStore.push({
                id:        'default_' + ds.name,
                name:      ds.name,
                code:      ds.code,
                updatedAt: Date.now(),
                isDefault: true,
            });
        }
    }
}
