/* ============================================================
   Zengine — engine.keys.js
   Keyboard key constants + mouse button constants.

   Use these in scripts instead of raw strings so you get
   autocomplete and never mistype a key name.

   Examples:
     if (isKeyDown(Key.W))            { ... }
     if (isKeyDown(Key.ARROW_LEFT))   { ... }
     if (isKeyDown(Key.SPACE))        { ... }
     if (isKeyJustDown(Key.ENTER))    { ... }
     if (mouseDown())                 { ... }   // left button
     if (isKeyDown(Key.ANY))          { ... }   // true if ANY key held

   The string values match the lowercased KeyboardEvent.key values
   that the engine's input system already uses internally, so you
   can mix Key.W and "w" freely — they are identical.
   ============================================================ */

// ── Keyboard constants ────────────────────────────────────────
export const Key = Object.freeze({

    // ── Letters ───────────────────────────────────────────────
    A: 'a', B: 'b', C: 'c', D: 'd', E: 'e',
    F: 'f', G: 'g', H: 'h', I: 'i', J: 'j',
    K: 'k', L: 'l', M: 'm', N: 'n', O: 'o',
    P: 'p', Q: 'q', R: 'r', S: 's', T: 't',
    U: 'u', V: 'v', W: 'w', X: 'x', Y: 'y',
    Z: 'z',

    // ── Digits (top row) ──────────────────────────────────────
    DIGIT_0: '0', DIGIT_1: '1', DIGIT_2: '2',
    DIGIT_3: '3', DIGIT_4: '4', DIGIT_5: '5',
    DIGIT_6: '6', DIGIT_7: '7', DIGIT_8: '8',
    DIGIT_9: '9',

    // ── Numpad ────────────────────────────────────────────────
    NUM_0: '0', NUM_1: '1', NUM_2: '2',
    NUM_3: '3', NUM_4: '4', NUM_5: '5',
    NUM_6: '6', NUM_7: '7', NUM_8: '8',
    NUM_9: '9',
    NUM_ADD:      '+',
    NUM_SUBTRACT: '-',
    NUM_MULTIPLY: '*',
    NUM_DIVIDE:   '/',
    NUM_DECIMAL:  '.',
    NUM_ENTER:    'enter',

    // ── Arrow keys ────────────────────────────────────────────
    ARROW_UP:    'arrowup',
    ARROW_DOWN:  'arrowdown',
    ARROW_LEFT:  'arrowleft',
    ARROW_RIGHT: 'arrowright',
    // Short aliases
    UP:    'arrowup',
    DOWN:  'arrowdown',
    LEFT:  'arrowleft',
    RIGHT: 'arrowright',

    // ── Whitespace / editing ──────────────────────────────────
    SPACE:     ' ',
    ENTER:     'enter',
    BACKSPACE: 'backspace',
    DELETE:    'delete',
    TAB:       'tab',
    ESCAPE:    'escape',
    ESC:       'escape',

    // ── Modifiers ─────────────────────────────────────────────
    SHIFT:      'shift',
    CTRL:       'control',
    CONTROL:    'control',
    ALT:        'alt',
    META:       'meta',       // Cmd on Mac, Win key on Windows
    CAPS_LOCK:  'capslock',

    // ── Function keys ─────────────────────────────────────────
    F1:  'f1',  F2:  'f2',  F3:  'f3',  F4:  'f4',
    F5:  'f5',  F6:  'f6',  F7:  'f7',  F8:  'f8',
    F9:  'f9',  F10: 'f10', F11: 'f11', F12: 'f12',

    // ── Navigation ────────────────────────────────────────────
    HOME:      'home',
    END:       'end',
    PAGE_UP:   'pageup',
    PAGE_DOWN: 'pagedown',
    INSERT:    'insert',

    // ── Punctuation / symbols ─────────────────────────────────
    COMMA:         ',',
    PERIOD:        '.',
    SLASH:         '/',
    BACKSLASH:     '\\',
    SEMICOLON:     ';',
    QUOTE:         "'",
    BACKTICK:      '`',
    OPEN_BRACKET:  '[',
    CLOSE_BRACKET: ']',
    MINUS:         '-',
    EQUALS:        '=',

    // ── Special: ANY ──────────────────────────────────────────
    // Pass Key.ANY to isKeyDown() to check if ANY keyboard key is held.
    ANY: '__any__',
});

// ── Mouse button constants ────────────────────────────────────
export const Mouse = Object.freeze({
    LEFT:   'left',
    MIDDLE: 'middle',
    RIGHT:  'right',
});

// ── Expose globally so scripts can use Key.W without an import ─
// The script sandbox already has these injected as globals
// (see engine.scripting.js _buildScriptScope). This file is the
// canonical definition; scripting injects it at runtime.
if (typeof window !== 'undefined') {
    window.Key   = Key;
    window.Mouse = Mouse;
}
