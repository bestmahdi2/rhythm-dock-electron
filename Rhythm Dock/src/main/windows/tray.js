'use strict';

/**
 * System tray integration (request #5).
 *
 * Provides:
 *   - a tray icon with a transport context menu,
 *   - "minimise to tray" so the window can be hidden without quitting,
 *   - correct quit semantics: closing the window with minimise-to-tray on should hide
 *     rather than exit, but an explicit Quit must actually exit.
 *
 * Platform notes:
 *   - macOS uses a template image (monochrome, auto-inverted by the OS). The file MUST
 *     be named *Template.png for that to happen.
 *   - On Linux, left-clicking a tray icon is not a reliable event across desktop
 *     environments, so the context menu is the primary interaction there.
 */

const path = require('path');
const fs = require('fs');
const {Tray, Menu, nativeImage, app} = require('electron');

let tray = null;
let quitting = false;

/**
 * Icons are generated into build/icons by scripts/generate-icons.js. In a packaged app
 * that directory is copied into resources; in dev it sits next to the sources.
 */
function iconDirectory() {
    const packaged = path.join(process.resourcesPath || '', 'build', 'icons', 'tray');
    if (app.isPackaged && fs.existsSync(packaged)) return packaged;
    return path.join(__dirname, '..', '..', '..', 'build', 'icons', 'tray');
}

function loadTrayImage() {
    const directory = iconDirectory();
    const candidates = process.platform === 'darwin'
        ? ['trayTemplate.png', 'tray.png']
        : process.platform === 'win32'
            ? ['tray.ico', 'tray.png']
            : ['tray.png'];

    for (const candidate of candidates) {
        const iconPath = path.join(directory, candidate);
        if (!fs.existsSync(iconPath)) continue;

        const image = nativeImage.createFromPath(iconPath);
        if (image.isEmpty()) continue;

        // Only a template image gets inverted by macOS for light/dark menu bars.
        if (process.platform === 'darwin' && candidate.includes('Template')) {
            image.setTemplateImage(true);
        }
        return image;
    }

    console.warn('[tray] No tray icon found in', directory, '- run `npm run icons`.');
    return null;
}

/**
 * @param {object} options
 * @param {() => Electron.BrowserWindow|null} options.getWindow
 * @param {(command: string) => void} options.onCommand   'play-pause' | 'next' | 'prev'
 * @param {() => boolean} options.isPlaying
 */
function create(options) {
    if (tray) return tray;

    const image = loadTrayImage();
    if (!image) return null;

    try {
        tray = new Tray(image);
    } catch (error) {
        console.error('[tray] Could not create tray icon:', error);
        return null;
    }

    tray.setToolTip('Rhythm Dock');

    // Left click toggles visibility on the platforms where the event is dependable.
    if (process.platform !== 'linux') {
        tray.on('click', () => toggleWindow(options.getWindow()));
    }
    tray.on('double-click', () => showWindow(options.getWindow()));

    rebuildMenu(options);
    return tray;
}

/**
 * The menu is rebuilt rather than mutated because Electron's Menu items are immutable
 * once built — the play/pause label has to change with playback state.
 */
function rebuildMenu(options) {
    if (!tray) return;

    const window = options.getWindow();
    const visible = Boolean(window && window.isVisible() && !window.isMinimized());

    tray.setContextMenu(Menu.buildFromTemplate([
        {
            label: visible ? 'Hide Rhythm Dock' : 'Show Rhythm Dock',
            click: () => toggleWindow(options.getWindow()),
        },
        {type: 'separator'},
        {
            label: options.isPlaying() ? 'Pause' : 'Play',
            click: () => options.onCommand('play-pause'),
        },
        {label: 'Next Track', click: () => options.onCommand('next')},
        {label: 'Previous Track', click: () => options.onCommand('prev')},
        {type: 'separator'},
        {
            label: 'Quit',
            click: () => {
                // Without this the close handler would just hide the window again.
                setQuitting(true);
                app.quit();
            },
        },
    ]));
}

function showWindow(window) {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
}

function hideWindow(window) {
    if (!window || window.isDestroyed()) return;
    window.hide();
}

function toggleWindow(window) {
    if (!window || window.isDestroyed()) return;
    const visible = window.isVisible() && !window.isMinimized();
    if (visible) hideWindow(window); else showWindow(window);
}

/**
 * Distinguishes "the user closed the window" from "the app is genuinely quitting".
 * Set before app.quit() so the close handler stops intercepting.
 */
function setQuitting(value) {
    quitting = Boolean(value);
}

function isQuitting() {
    return quitting;
}

function updateTooltip(text) {
    if (tray && !tray.isDestroyed()) {
        // Windows truncates tooltips around 127 characters.
        tray.setToolTip(String(text || 'Rhythm Dock').slice(0, 120));
    }
}

function destroy() {
    if (tray && !tray.isDestroyed()) tray.destroy();
    tray = null;
}

module.exports = {
    create,
    rebuildMenu,
    showWindow,
    hideWindow,
    toggleWindow,
    setQuitting,
    isQuitting,
    updateTooltip,
    destroy,
};
