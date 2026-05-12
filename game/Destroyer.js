// ============================================================
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
