// ============================================================
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
