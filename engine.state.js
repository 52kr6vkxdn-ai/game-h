/* ============================================================
   Zengine — engine.state.js
   Shared constants and mutable global state.
   ============================================================ */

export const PIXELS_PER_UNIT = 100;
export const SNAP_GRID       = 25;

export const state = {
    /** @type {PIXI.Application|null} */
    app: null,

    /** @type {PIXI.Container|null} */
    sceneContainer: null,

    /** @type {PIXI.Graphics|null} */
    gridLayer: null,

    /** @type {PIXI.Graphics|null} */
    cameraBounds: null,

    // ── Multi-object support ──────────────────────────────
    /** @type {PIXI.Container[]} */
    gameObjects: [],

    /** @type {PIXI.Container|null} */
    gameObject: null,

    /** @type {PIXI.Graphics|null} */
    spriteBox: null,

    // ── Gizmo state ───────────────────────────────────────
    /** @type {PIXI.Container|null} */
    gizmoContainer: null,
    /** @type {PIXI.Container|null} */
    grpTranslate: null,
    /** @type {PIXI.Container|null} */
    grpRotate: null,
    /** @type {PIXI.Container|null} */
    grpScale: null,

    /** @type {'translate'|'rotate'|'scale'|'all'} */
    gizmoMode: 'translate',

    // ── Asset registry (shared across ALL scenes) ─────────
    /** @type {Array<{id:string, name:string, type:string, dataURL:string}>} */
    assets: [],

    // ── Tile brush registry (auto-tiler brushes, shared) ──
    /**
     * Each brush:
     *   { id, name, type:'16-tile', tileW, tileH,
     *     tiles: Array<string|null>  // length 16, dataURLs by neighbor mask }
     * @type {Array<object>}
     */
    tilesetBrushes: [],

    // ── Prefab registry ────────────────────────────────────
    /**
     * @type {Array<{id:string, name:string, shapeKey:string, isImage:boolean,
     *               assetId:string|null, tint:number, scaleX:number, scaleY:number,
     *               rotation:number, animations:any[]}>}
     */
    prefabs: [],

    // ── Scene registry ────────────────────────────────────
    /**
     * @type {Array<{id:string, name:string, snapshot:object|null}>}
     * snapshot=null means this scene is currently live (no save needed to read it)
     */
    scenes: [],

    /** @type {number} Index into state.scenes */
    activeSceneIndex: 0,

    // ── Internal gizmo binding ────────────────────────────
    _gizmoHandles: null,

    // ── Undo / Redo ───────────────────────────────────────
    /** @type {Array<object>} */
    undoStack: [],
    /** @type {Array<object>} */
    redoStack: [],
    /** Guard: true while undo/redo is being applied — prevents re-push */
    _applyingHistory: false,

    // ── Clipboard ─────────────────────────────────────────
    /** @type {object|null} */
    clipboard: null,

    // ── Play Mode ─────────────────────────────────────────
    isPlaying:  false,
    isPaused:   false,
    /** snapshot taken when play was pressed, to restore on stop */
    _playSnapshot: null,

    // ── Bulk-load guard — suppresses mid-load hierarchy spam ──
    /** true while a scene is loading from snapshot; prevents N hierarchy rebuilds */
    _loadingScene: false,

    // ── Collision overlay visibility ──────────────────────
    /** Whether collision shapes are drawn in the editor viewport */
    showCollision: false,

    // ── Scene Settings ────────────────────────────────────
    sceneSettings: {
        bgColor:       0x282828,
        gameWidth:     1280,
        gameHeight:    720,
        /** 'landscape-desktop' | 'landscape-both' | 'portrait' | 'automatic' */
        cameraPreset:  'landscape-desktop',
        /** World gravity — applied to all dynamic physics bodies */
        gravityX:      0,
        gravityY:      1,
    },

    // ── Audio Sources (positional, in-scene) ──────────────
    /**
     * @type {Array<{id:string, assetId:string, label:string,
     *   x:number, y:number, range:number, volume:number, loop:boolean,
     *   _container:PIXI.Container|null}>}
     */
    audioSources: [],

    // ── Scripts (stored in project alongside assets) ──────────
    /**
     * @type {Array<{id:string, name:string, code:string, updatedAt:number}>}
     */
    scripts: [],
};
