'use strict';

/**
 * Window geometry persistence.
 *
 * v1.3.7 locked the window by setting min == max size, which made every later feature
 * (playlist panel, settings tab, equalizer) impossible to lay out. This module keeps the
 * *presets* the app already used, but expresses them as `setBounds` calls against a
 * genuinely resizable window with sane limits, and remembers whatever the user chose.
 */

const {screen} = require('electron');

const STORE_KEY = 'windowState';

// The compact dock the app has always opened as.
const PRESETS = {
    horizontal: {width: 380, height: 360},
    horizontalCompact: {width: 380, height: 260},
    vertical: {width: 220, height: 560},
};

const LIMITS = {
    minWidth: 105,
    minHeight: 110,
    maxWidth: 1600,
    maxHeight: 1400,
};

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * True if the given point sits inside the work area of any currently attached display.
 * Guards against restoring a window onto a monitor that has been unplugged.
 */
function isPointVisible(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    return screen.getAllDisplays().some((display) => {
        const {x: dx, y: dy, width, height} = display.workArea;
        return x >= dx && x < dx + width && y >= dy && y < dy + height;
    });
}

/**
 * Reads the saved state and returns BrowserWindow constructor options.
 * Anything invalid is dropped rather than trusted, so Electron falls back to centring.
 */
function restore(store, fallbackPreset = 'horizontal') {
    const preset = PRESETS[fallbackPreset] || PRESETS.horizontal;
    const saved = store.get(STORE_KEY);

    const options = {
        width: preset.width,
        height: preset.height,
        ...LIMITS,
    };

    if (!saved || typeof saved !== 'object') {
        // Fall back to the pre-1.4 key so existing users keep their window position.
        const legacyPosition = store.get('lastWindowPosition');
        if (legacyPosition && isPointVisible(legacyPosition.x, legacyPosition.y)) {
            options.x = legacyPosition.x;
            options.y = legacyPosition.y;
        }
        return options;
    }

    if (Number.isFinite(saved.width) && Number.isFinite(saved.height)) {
        options.width = clamp(saved.width, LIMITS.minWidth, LIMITS.maxWidth);
        options.height = clamp(saved.height, LIMITS.minHeight, LIMITS.maxHeight);
    }

    // Only honour a saved position if that corner is still on a real screen.
    if (isPointVisible(saved.x, saved.y)) {
        options.x = saved.x;
        options.y = saved.y;
    }

    return options;
}

/**
 * Writes the window's current bounds. Called on move/resize (debounced) and on close.
 */
function save(store, window, extra = {}) {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized() || window.isMaximized() || window.isFullScreen()) return;
    if (extra.skipSave) return;

    const bounds = window.getBounds();
    store.set(STORE_KEY, {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        ...extra,
    });
}

/**
 * Debounced save, attached to the window's move/resize events.
 */
function track(store, window, extra = () => ({})) {
    let timer = null;
    const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(() => save(store, window, extra()), 400);
    };

    window.on('move', schedule);
    window.on('resize', schedule);

    return () => {
        clearTimeout(timer);
        save(store, window, extra());
    };
}

/**
 * Applies one of the layout presets without re-locking the window.
 *
 * `preserveHeight` lets the horizontal preset keep whatever height the user has
 * dragged the window to instead of snapping back to 180px every time they toggle
 * the lyrics pane.
 */
function applyPreset(window, presetName, {preserveWidth = false, preserveHeight = false} = {}) {
    if (!window || window.isDestroyed()) return;
    const preset = PRESETS[presetName];
    if (!preset) return;

    const current = window.getBounds();
    const width = preserveWidth ? current.width : preset.width;
    const height = preserveHeight ? current.height : preset.height;

    window.setBounds(
        {
            x: current.x,
            y: current.y,
            width: clamp(width, LIMITS.minWidth, LIMITS.maxWidth),
            height: clamp(height, LIMITS.minHeight, LIMITS.maxHeight),
        },
        true
    );
}

module.exports = {
    STORE_KEY,
    PRESETS,
    LIMITS,
    restore,
    save,
    track,
    applyPreset,
    isPointVisible,
};
