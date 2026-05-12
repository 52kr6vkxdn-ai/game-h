// ============================================================
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
