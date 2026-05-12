// ============================================================
// ROTATOR
// Rotates this object at a constant speed.
// Great for: coins, spinning hazards, loading icons.
// ============================================================

var DEGREES_PER_SECOND = 180;   // positive = clockwise

onUpdate((dt) => {
  setRotation(getRotation() + DEGREES_PER_SECOND * dt);
});
