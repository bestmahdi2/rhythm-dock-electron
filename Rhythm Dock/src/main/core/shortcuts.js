'use strict';

/**
 * Global (system-wide) shortcuts (request #5).
 *
 * The previous build hardcoded the three media keys. This adds user-configurable
 * accelerators for showing and hiding the window, and — importantly — reports which
 * registrations failed.
 *
 * globalShortcut.register() returns false when another application already owns the
 * accelerator. The old code ignored the return value, so a conflicting shortcut simply
 * did nothing with no explanation.
 */

const {globalShortcut} = require('electron');

const DEFAULTS = {
    // Media keys, as before.
    playPause: 'MediaPlayPause',
    next: 'MediaNextTrack',
    previous: 'MediaPreviousTrack',
    // New: window visibility.
    showWindow: 'CommandOrControl+Alt+M',
    hideWindow: 'CommandOrControl+Alt+H',
    toggleWindow: 'CommandOrControl+Alt+R',
    toggleEdgeDock: 'CommandOrControl+Alt+D',
};

let registered = new Map();

/**
 * Registers every accelerator in `bindings`.
 *
 * @param {Record<string, string>} bindings  action -> accelerator
 * @param {Record<string, Function>} handlers action -> callback
 * @returns {{registered: string[], failed: Array<{action, accelerator, reason}>}}
 */
function registerAll(bindings, handlers) {
    unregisterAll();

    const succeeded = [];
    const failed = [];

    for (const [action, accelerator] of Object.entries(bindings)) {
        const handler = handlers[action];
        if (!handler || !accelerator) continue;

        try {
            // Already taken by a shortcut we registered a moment ago in this same loop.
            if (globalShortcut.isRegistered(accelerator)) {
                failed.push({action, accelerator, reason: 'already registered'});
                continue;
            }

            const ok = globalShortcut.register(accelerator, handler);
            if (ok) {
                registered.set(action, accelerator);
                succeeded.push(action);
            } else {
                // Another application owns this combination.
                failed.push({action, accelerator, reason: 'in use by another application'});
            }
        } catch (error) {
            // An accelerator string Electron cannot parse throws rather than returning false.
            failed.push({action, accelerator, reason: error.message});
        }
    }

    if (failed.length) {
        for (const failure of failed) {
            console.warn(
                `[shortcuts] Could not bind "${failure.accelerator}" for ${failure.action}: ${failure.reason}`
            );
        }
    }

    return {registered: succeeded, failed};
}

function unregisterAll() {
    for (const accelerator of registered.values()) {
        try {
            globalShortcut.unregister(accelerator);
        } catch (_) { /* already gone */ }
    }
    registered = new Map();
}

/** Merges stored overrides over the defaults. */
function resolveBindings(store) {
    const saved = store.get('globalShortcuts', {});
    return {...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {})};
}

/**
 * Validates an accelerator without permanently claiming it, so the settings UI can tell
 * the user a combination is unavailable before they commit to it.
 */
function testAccelerator(accelerator) {
    if (!accelerator) return {ok: false, reason: 'empty'};
    if (globalShortcut.isRegistered(accelerator)) {
        return {ok: false, reason: 'already in use'};
    }
    try {
        const ok = globalShortcut.register(accelerator, () => {});
        if (ok) globalShortcut.unregister(accelerator);
        return ok ? {ok: true} : {ok: false, reason: 'in use by another application'};
    } catch (error) {
        return {ok: false, reason: error.message};
    }
}

module.exports = {DEFAULTS, registerAll, unregisterAll, resolveBindings, testAccelerator};
