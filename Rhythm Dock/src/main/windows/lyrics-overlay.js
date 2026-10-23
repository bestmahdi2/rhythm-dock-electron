'use strict';

// Separate always-on-top lyrics window with persisted geometry and recoverable
// click-through controls. Its preload exposes no filesystem or library access.

const path = require('path');
const {BrowserWindow, screen} = require('electron');

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 180;
let clickThrough = false;

let overlayWindow = null;

/** Places the strip near the bottom centre of the primary display. */
function defaultBounds() {
    const {workArea} = screen.getPrimaryDisplay();
    return {
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        x: Math.round(workArea.x + (workArea.width - DEFAULT_WIDTH) / 2),
        y: Math.round(workArea.y + workArea.height - DEFAULT_HEIGHT - 72),
    };
}

/**
 * Returns saved bounds only if they still land on an attached display. Restoring an
 * overlay onto a monitor that has since been unplugged puts it somewhere the user
 * cannot see or reach, and unlike the main window there is no taskbar entry to
 * recover it from.
 */
function restoreBounds(store) {
    const saved = store.get('lyricsOverlayBounds', null);
    if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return defaultBounds();

    const visible = screen.getAllDisplays().some((display) => {
        const {x, y, width, height} = display.workArea;
        return saved.x < x + width && saved.x + (saved.width || DEFAULT_WIDTH) > x
            && saved.y < y + height && saved.y + (saved.height || DEFAULT_HEIGHT) > y;
    });

    return visible
        ? {
            width: saved.width || DEFAULT_WIDTH,
            height: saved.height || DEFAULT_HEIGHT,
            x: saved.x,
            y: saved.y,
        }
        : defaultBounds();
}

function isOpen() {
    return Boolean(overlayWindow && !overlayWindow.isDestroyed());
}

function get() {
    return isOpen() ? overlayWindow : null;
}

function create(store) {
    if (isOpen()) return overlayWindow;

    clickThrough = false;
    const bounds = restoreBounds(store);
    overlayWindow = new BrowserWindow({
        ...bounds,
        frame: false,
        transparent: true,
        resizable: true,
        movable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        // Not focusable by default would be nicer for click-through, but it also stops
        // the drag handle working, and being unable to move the thing is worse.
        focusable: true,
        show: false,
        backgroundColor: '#00000000',
        minWidth: 320,
        minHeight: 150,
        webPreferences: {
            preload: path.join(__dirname, '..', '..', 'preload', 'overlay.js'),
            contextIsolation: true,
            nodeIntegration: false,
            spellcheck: false,
            backgroundThrottling: false,
        },
    });

    // 'screen-saver' outranks ordinary always-on-top windows, which is what keeps the
    // strip visible over a full-screened video or another pinned player.
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    overlayWindow.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true});

    overlayWindow.loadFile(path.join(__dirname, '..', '..', 'renderer', 'overlay.html'));
    overlayWindow.once('ready-to-show', () => {
        if (!isOpen()) return;
        overlayWindow.setBounds(bounds);
        overlayWindow.show();
    });

    const persist = () => {
        if (!isOpen()) return;
        store.set('lyricsOverlayBounds', overlayWindow.getBounds());
    };
    overlayWindow.on('moved', persist);
    overlayWindow.on('resized', persist);

    overlayWindow.on('closed', () => {
        overlayWindow = null;
    });

    return overlayWindow;
}

function close(store) {
    if (!isOpen()) return false;
    try {
        store.set('lyricsOverlayBounds', overlayWindow.getBounds());
    } catch (_) { /* the window is going away either way */ }
    overlayWindow.close();
    overlayWindow = null;
    return false;
}

/** Toggles the overlay and returns its new visibility. */
function toggle(store) {
    if (isOpen()) {
        close(store);
        return false;
    }
    create(store);
    return true;
}

/**
 * Click-through mode: the strip stays visible but the pointer passes straight to
 * whatever is behind it. `forward: true` keeps hover events arriving, so the overlay
 * can still fade its own controls in when the pointer crosses it.
 */
function setClickThrough(enabled) {
    if (!isOpen()) return false;
    clickThrough = Boolean(enabled);
    overlayWindow.setIgnoreMouseEvents(clickThrough, {forward: true});
    return clickThrough;
}

/** Fire-and-forget push of the current line and transport state. */
function send(channel, payload) {
    if (!isOpen()) return;
    overlayWindow.webContents.send(channel, payload);
}

function setInteractive(interactive) {
    if (isOpen()) overlayWindow.setIgnoreMouseEvents(clickThrough && !interactive, {forward:true});
}
function resize(bounds) {
    if (!isOpen() || !bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return;
    const display = screen.getDisplayMatching(overlayWindow.getBounds()).workArea;
    overlayWindow.setSize(Math.round(Math.max(320, Math.min(display.width, bounds.width))),
        Math.round(Math.max(150, Math.min(display.height, bounds.height))));
    return overlayWindow.getBounds();
}

module.exports = {
    resize, setInteractive,
    create,
    close,
    toggle,
    isOpen,
    get,
    send,
    setClickThrough,
};
