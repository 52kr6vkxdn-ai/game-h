// ============================================================
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
