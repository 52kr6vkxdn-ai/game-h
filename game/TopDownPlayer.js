// ============================================================
// TOP-DOWN PLAYER
// 8-directional WASD/arrows movement.
// Camera follows this object smoothly.
// Mouse rotates the player to aim.
//
// Works with or without a physics body.
// ============================================================

var SPEED = 5;   // world units per second

onStart(() => {
    setScaleX(0.2);
  setScaleY(0.2);
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
