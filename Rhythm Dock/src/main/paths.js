'use strict';

/**
 * Stable application data paths.
 *
 * Historically the lyrics database lived in `app.getPath('userData')`, which resolves
 * to a directory named after the *product name*. That has two problems:
 *
 *   1. Renaming the product (or shipping a build where `productName` differs) silently
 *      orphans every previous install's data.
 *   2. The Windows NSIS updater runs the previous uninstaller before laying down the
 *      new version. With `oneClick: true` that uninstall is silent, and depending on
 *      the electron-builder version it can take the app-data directory with it — which
 *      is exactly the "my DB is gone after an update" symptom.
 *
 * So we anchor everything to a fixed, product-name-independent folder and migrate any
 * legacy data into it exactly once.
 */

const path = require('path');
const fs = require('fs');
const {app} = require('electron');

// Never derive this from productName. It is a constant, on purpose.
const VENDOR_DIR = 'RhythmDock';

let cachedRoot = null;

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, {recursive: true});
    return dirPath;
}

/**
 * Root of all persistent user data: `<appData>/RhythmDock`.
 *
 *   Windows  %APPDATA%\RhythmDock
 *   macOS    ~/Library/Application Support/RhythmDock
 *   Linux    ~/.config/RhythmDock  (respects XDG_CONFIG_HOME)
 */
function getDataRoot() {
    if (cachedRoot) return cachedRoot;
    cachedRoot = ensureDir(path.join(app.getPath('appData'), VENDOR_DIR));
    return cachedRoot;
}

/** Where the SQLite database and its backups live. */
function getDatabaseDir() {
    return ensureDir(path.join(getDataRoot(), 'data'));
}

/** Where rolling pre-migration database backups are kept. */
function getBackupDir() {
    return ensureDir(path.join(getDatabaseDir(), 'backups'));
}

/**
 * Directory handed to electron-store as its `cwd`, so settings survive updates for
 * the same reason the database does.
 */
function getConfigDir() {
    return ensureDir(path.join(getDataRoot(), 'config'));
}

function getDatabasePath() {
    return path.join(getDatabaseDir(), 'lyrics.db');
}

/**
 * Locations the database may have lived in before this version. Checked in order;
 * the first one that exists wins.
 */
function getLegacyDatabasePaths() {
    const candidates = [
        // The path used up to and including v1.3.7.
        path.join(app.getPath('userData'), 'lyrics.db'),
        // Dev builds wrote next to the sources.
        path.join(__dirname, '..', '..', 'lyrics.db'),
    ];

    // Older builds may have used a differently-named product directory.
    const appDataDir = app.getPath('appData');
    for (const legacyName of ['Rhythm Dock', 'rhythm-dock-electron', 'RhythmDock']) {
        candidates.push(path.join(appDataDir, legacyName, 'lyrics.db'));
    }

    return candidates.filter((candidate, index) => candidates.indexOf(candidate) === index);
}

/**
 * Legacy electron-store config files, for the same one-shot migration treatment.
 */
function getLegacyConfigPaths() {
    const appDataDir = app.getPath('appData');
    const candidates = [path.join(app.getPath('userData'), 'config.json')];
    for (const legacyName of ['Rhythm Dock', 'rhythm-dock-electron']) {
        candidates.push(path.join(appDataDir, legacyName, 'config.json'));
    }
    return candidates.filter((candidate, index) => candidates.indexOf(candidate) === index);
}

module.exports = {
    VENDOR_DIR,
    ensureDir,
    getDataRoot,
    getDatabaseDir,
    getBackupDir,
    getConfigDir,
    getDatabasePath,
    getLegacyDatabasePaths,
    getLegacyConfigPaths,
};
