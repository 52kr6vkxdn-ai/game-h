// ============================================================
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
