const {app, BrowserWindow, ipcMain, dialog, globalShortcut, clipboard, shell, nativeTheme, Notification} = require('electron');
const path = require('path');
const fs = require('fs');
const mm = require('music-metadata');
const Store = require('electron-store');
const pkg = require('../package.json');

const paths = require('./main/paths');
const database = require('./main/database');
const windowState = require('./main/window-state');
const scanner = require('./main/library/scanner');
const metadata = require('./main/library/metadata');
const tags = require('./main/library/tags');
const {LibraryIndex} = require('./main/library/index');
const tray = require('./main/tray');
const shortcuts = require('./main/shortcuts');
const translate = require('./main/translate');
const {RoomClient} = require('./main/room-client');

// Lazily constructed: most sessions never open a room, and constructing it eagerly
// would pull in the ws dependency for no reason.
let roomClient = null;

function getRoomClient() {
    if (!roomClient) {
        roomClient = new RoomClient({emit: (event, payload) => sendToRenderer(event, payload)});
    }
    return roomClient;
}

// The scanned library. Rebuilt whenever a folder is opened; never persisted, because
// re-scanning is cheap and a stale cache is worse than none.
const library = new LibraryIndex();

Store.initRenderer();

// `cwd` pins settings to <appData>/RhythmDock/config instead of the product-name
// directory, so an update or a rename can no longer orphan them. See main/paths.js.
let store;

let mainWindow;
let persistWindowState = () => {};
let currentLayout = 'horizontal';

// --- Thumbar Buttons (Taskbar Media Controls) ---
// We define these here so we can update them easily.
let playPauseButton, prevButton, nextButton;
let thumbarButtons;
let isPlaying = false; // Keep track of playback state in main process

/**
 * Thumbar icons are generated (light + dark variants) by scripts/generate-icons.js.
 *
 * Request #4: Windows does not tint thumbar images, so a single dark glyph set is
 * invisible on a dark taskbar. We ship both and pick per theme, re-picking whenever
 * nativeTheme reports a change.
 */
const mediaIconRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'build', 'icons', 'media')
    : path.join(__dirname, '..', 'build', 'icons', 'media');

// A dark taskbar needs LIGHT glyphs, hence the apparent inversion here.
const currentIconVariant = () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');

// Kept in step with `build.fileAssociations` in package.json and with the FILE_TYPES
// table in scripts/generate-icons.js. Previously this list was duplicated in three
// places and only covered five formats.
const SUPPORTED_EXTENSIONS = [
    '.mp3', '.m4a', '.flac', '.wav', '.ogg', '.opus', '.aac', '.wma', '.aiff', '.mp4',
];

const isSupportedAudioFile = (filePath) =>
    SUPPORTED_EXTENSIONS.includes(path.extname(filePath).toLowerCase());

const iconFor = (name) => path.join(mediaIconRoot, currentIconVariant(), `${name}.png`);

// A missing icon file makes setThumbarButtons() throw and takes the whole window with
// it, so every icon is verified before it is handed to Electron.
const resolveIcon = (iconPath) => (fs.existsSync(iconPath) ? iconPath : null);

function updateThumbar() {
    if (!mainWindow || mainWindow.isDestroyed() || process.platform !== 'win32') return;

    const icons = {
        play: resolveIcon(iconFor('play')),
        pause: resolveIcon(iconFor('pause')),
        next: resolveIcon(iconFor('next')),
        prev: resolveIcon(iconFor('prev')),
    };

    // Bail out rather than crash if the icons have not been generated for this build.
    if (!icons.play || !icons.pause || !icons.next || !icons.prev) {
        console.warn('[thumbar] Media icons missing - run `npm run icons`.');
        return;
    }

    playPauseButton = {
        tooltip: isPlaying ? 'Pause' : 'Play',
        icon: isPlaying ? icons.pause : icons.play,
        click: () => sendToRenderer('media-key-event', 'play-pause'),
    };

    prevButton = {
        tooltip: 'Previous', icon: icons.prev, click: () => sendToRenderer('media-key-event', 'prev'),
    };

    nextButton = {
        tooltip: 'Next', icon: icons.next, click: () => sendToRenderer('media-key-event', 'next'),
    };

    thumbarButtons = [prevButton, playPauseButton, nextButton];
    try {
        mainWindow.setThumbarButtons(thumbarButtons);
    } catch (error) {
        console.error('Failed to set thumbar buttons:', error);
    }
}

const createWindow = () => {
    // Geometry (size + position) comes back from window-state, which validates the
    // saved coordinates against the displays that are actually attached right now.
    const geometry = windowState.restore(store, 'horizontal');

    mainWindow = new BrowserWindow({
        ...geometry,
        useContentSize: true,
        // The window used to be pinned shut by setting min == max size. That made every
        // panel planned for later phases impossible to lay out, so it is now genuinely
        // resizable between the bounds declared in window-state.js.
        resizable: true,
        maximizable: false,
        fullscreenable: false,
        frame: false,
        transparent: true,
        show: false,
        backgroundColor: '#00000000',
        alwaysOnTop: store.get('isPinned', false),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            // Renderer-side spellcheck is dead weight for a music player.
            spellcheck: false,
        },
    });

    // Paint once before showing, so the window does not flash a transparent frame.
    mainWindow.once('ready-to-show', () => mainWindow.show());

    // Debounced persistence on move/resize, plus a final flush returned for 'close'.
    persistWindowState = windowState.track(store, mainWindow, () => ({layout: currentLayout}));

    mainWindow.setOpacity(store.get('windowOpacity', 0.85));

    mainWindow.webContents.on('devtools-opened', () => {
        originalSize = mainWindow.getSize();
        mainWindow.setSize(1000, 600, true);
    });

    mainWindow.webContents.on('devtools-closed', () => {
        if (originalSize) {
            mainWindow.setSize(originalSize[0], originalSize[1], true);
        }
    });

    // Flush the final geometry before the window goes away.
    mainWindow.on('close', (event) => {
        persistWindowState();

        // Request #5: with minimise-to-tray enabled, closing hides instead of quitting.
        // tray.isQuitting() distinguishes that from a real Quit, otherwise the app could
        // never be shut down at all.
        if (store.get('minimizeToTray', false) && !tray.isQuitting()) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    // Same treatment for the minimise button when the option is on.
    mainWindow.on('minimize', (event) => {
        if (store.get('minimizeToTray', false)) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // Set initial thumbar buttons
    updateThumbar();
};

// --- Helper function to safely send messages to the renderer ---
const sendToRenderer = (channel, ...args) => {
    // THIS IS THE FIX: Check if mainWindow exists and is not destroyed
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, ...args);
    }
};

const sendFilePathToWindow = (filePath) => {
    if (!mainWindow) return;
    sendToRenderer('open-file-path', filePath);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
};

// Function to parse command-line arguments for a file path
const getFilePathFromArgs = (argv) => {
    // The last argument is the most likely candidate for a file path,
    // especially in packaged apps or during development.
    const lastArg = argv[argv.length - 1];

    // It's not a file path if it's the app executable itself or a project path like '.'
    if (lastArg && path.resolve(lastArg) !== path.resolve(process.execPath) && lastArg !== '.') {
        // A final check to ensure the file actually exists prevents errors.
        if (fs.existsSync(lastArg)) {
            return lastArg;
        }
    }
    return null;
};

// --- Single Instance Lock ---
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    // This is the primary instance.
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        // Someone tried to run a second instance, we should focus our window.
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();

            // Check if the second instance was launched with a file path
            const filePath = getFilePathFromArgs(commandLine);
            if (filePath) {
                sendFilePathToWindow(filePath);
            }
        }
    });
}

app.whenReady().then(() => {
    // Order matters: paths must exist before the store is pointed at them, and the
    // store must exist before createWindow() reads the saved geometry from it.
    store = new Store({cwd: paths.getConfigDir()});
    database.initialize();
    createWindow();

    // --- Global shortcuts (request #5) ---
    // registerAll reports conflicts instead of failing silently, which is what the old
    // three bare register() calls did whenever another app already owned a media key.
    const shortcutResult = shortcuts.registerAll(shortcuts.resolveBindings(store), {
        playPause: () => sendToRenderer('media-key-event', 'play-pause'),
        next: () => sendToRenderer('media-key-event', 'next'),
        previous: () => sendToRenderer('media-key-event', 'prev'),
        showWindow: () => tray.showWindow(mainWindow),
        hideWindow: () => tray.hideWindow(mainWindow),
        toggleWindow: () => tray.toggleWindow(mainWindow),
    });
    if (shortcutResult.failed.length) {
        sendToRenderer('shortcut-conflicts', shortcutResult.failed);
    }

    // --- Tray (request #5) ---
    tray.create({
        getWindow: () => mainWindow,
        isPlaying: () => isPlaying,
        onCommand: (command) => sendToRenderer('media-key-event', command),
    });

    // Windows and Linux repaint the taskbar glyphs on a theme switch; macOS repaints
    // the tray. Either way the icon variant we chose at startup is now wrong.
    nativeTheme.on('updated', () => {
        updateThumbar();
        tray.rebuildMenu({
            getWindow: () => mainWindow,
            isPlaying: () => isPlaying,
            onCommand: (command) => sendToRenderer('media-key-event', command),
        });
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

// This new listener handles the startup logic once the renderer signals it's ready.
ipcMain.on('renderer-ready', () => {
    const filePath = getFilePathFromArgs(process.argv);
    if (filePath) {
        // Launched with a file: tell the renderer to play it.
        sendFilePathToWindow(filePath);
    } else {
        // Normal launch: tell the renderer to restore the last session.
        sendToRenderer('restore-state');
    }
});

// macOS specific: Handle opening files when the app is running
app.on('open-file', (event, path) => {
    event.preventDefault();
    // This is another safety check. Make sure the app is ready before creating windows.
    if (app.isReady()) {
        if (!mainWindow || mainWindow.isDestroyed()) {
            createWindow();
            mainWindow.once('ready-to-show', () => sendFilePathToWindow(path));
        } else {
            sendFilePathToWindow(path);
        }
    }
});

/**
 * Scans a folder recursively and folds the results into the library index.
 * Replaces the old single-level readdir, which never saw an Artist/Album/track.mp3
 * layout at all (request #8).
 */
async function scanAndIndex(dirPath) {
    try {
        const {files, truncated} = await scanner.scanDirectory(dirPath, SUPPORTED_EXTENSIONS, {
            onProgress: ({found, current}) => sendToRenderer('scan-progress', {found, current}),
        });

        // Filename-only parse for now; tags are read lazily per track when it plays.
        // Parsing tags for a 10,000 file library up front would take minutes.
        library.ingest(files);

        if (truncated) {
            sendToRenderer('scan-truncated', {count: files.length});
        }
        sendToRenderer('library-updated', {
            trackCount: library.size,
            artists: library.listArtists(),
        });

        return files;
    } catch (error) {
        console.error(`Error scanning directory ${dirPath}:`, error);
        return [];
    }
}

// Set the quitting flag first, so the window 'close' handler stops hiding the window
// and lets it actually close.
app.on('before-quit', () => tray.setQuitting(true));

app.on('will-quit', () => {
    shortcuts.unregisterAll();
    globalShortcut.unregisterAll();
    tray.destroy();
    // Checkpoint the WAL back into the main file so the database is left as a single
    // clean artifact that an installer cannot half-copy.
    database.close();
});

app.on('window-all-closed', () => {
    // With minimise-to-tray on, the window being gone is not a reason to exit — the
    // tray icon is still there and is the whole point of the feature.
    if (store && store.get('minimizeToTray', false) && !tray.isQuitting()) return;
    if (process.platform !== 'darwin') app.quit();
});

// --- IPC Handlers ---

// NEW: Listen for playback state changes from the renderer
ipcMain.on('playback-state-changed', (_event, state) => {
    isPlaying = state.isPlaying;
    updateThumbar();

    // Keep the tray's Play/Pause label and tooltip in step with playback.
    tray.rebuildMenu({
        getWindow: () => mainWindow,
        isPlaying: () => isPlaying,
        onCommand: (command) => sendToRenderer('media-key-event', command),
    });
    if (state.title) {
        tray.updateTooltip(`${state.title}${state.artist ? ' - ' + state.artist : ''}`);
    }
});

ipcMain.handle('get-lyrics', (_event, songKey) => database.getLyrics(songKey));

ipcMain.on('save-lyrics', (_event, songKey, lyricsText, details) => {
    database.saveLyrics(songKey, lyricsText, details || {});
});

ipcMain.handle('get-store-value', (_event, key) => store.get(key));
ipcMain.on('set-store-value', (_event, key, value) => store.set(key, value));
/**
 * Extracts ReplayGain from parsed tags (Phase 8).
 *
 * music-metadata normalises the common cases into `common.replaygain_*`, but a
 * large amount of real-world music carries the values only as raw Vorbis comments
 * or ID3 TXXX frames, so the native tag list is checked as a fallback. Album gain
 * is preferred when present: normalising each track of an album independently
 * flattens the dynamics the mastering engineer put between them.
 */
function readReplayGain(metadata) {
    const common = metadata?.common || {};

    const fromCommon = (value) => {
        if (value == null) return null;
        if (typeof value === 'number') return value;
        if (typeof value.dB === 'number') return value.dB;
        const parsed = parseFloat(String(value.ratio ?? value));
        return Number.isFinite(parsed) ? parsed : null;
    };

    let album = fromCommon(common.replaygain_album_gain);
    let track = fromCommon(common.replaygain_track_gain);

    if (album == null || track == null) {
        for (const tags of Object.values(metadata?.native || {})) {
            for (const tag of tags) {
                const id = String(tag.id || '').toUpperCase();
                const raw = typeof tag.value === 'string'
                    ? tag.value
                    : (tag.value?.description ?? tag.value?.text ?? '');
                const parsed = parseFloat(String(raw));
                if (!Number.isFinite(parsed)) continue;

                if (album == null && id.includes('REPLAYGAIN_ALBUM_GAIN')) album = parsed;
                if (track == null && id.includes('REPLAYGAIN_TRACK_GAIN')) track = parsed;
            }
        }
    }

    if (album == null && track == null) return null;
    return {album, track};
}

ipcMain.handle('get-metadata', async (_event, filePath) => {
    try {
        const metadata = await mm.parseFile(filePath);
        const {title, artist, picture, lyrics} = metadata.common;
        let cover = null;
        if (picture?.[0]) {
            const imageBuffer = Buffer.from(picture[0].data);
            cover = `data:${picture[0].format};base64,${imageBuffer.toString('base64')}`;
        }
        return {
            filePath,
            basename: path.basename(filePath),
            title: title || path.basename(filePath),
            artist: artist || 'Unknown Artist',
            cover,
            lyrics: lyrics ? lyrics[0] : null,
            replayGain: readReplayGain(metadata)
        };
    } catch (error) {
        console.error("Failed to parse metadata:", error);
        return {
            filePath,
            basename: path.basename(filePath),
            title: path.basename(filePath),
            artist: 'Unknown Artist',
            cover: null,
            lyrics: null,
            replayGain: null
        };
    }
});

// --- Tag editor -------------------------------------------------------------
//
// Reads/writes go through main because the renderer has no filesystem access,
// and because a half-written tag is a destroyed music file: the swap-through-
// temp-file dance in library/tags.js has to happen somewhere trusted.

ipcMain.handle('read-tags', (_event, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return {ok: false, error: 'No file loaded.'};
    return tags.read(filePath);
});

ipcMain.handle('write-tags', (_event, {filePath, tags: values, cover} = {}) => {
    if (typeof filePath !== 'string' || !filePath) return {ok: false, error: 'No file loaded.'};

    const result = tags.write(filePath, values || {}, cover);

    // The library index caches the old artist/title, so a rename would otherwise
    // not show up in search until the next folder scan.
    if (result.ok) {
        try {
            library.ingest([filePath]);
            sendToRenderer('library-updated', {
                trackCount: library.size,
                artists: library.listArtists(),
            });
        } catch (error) {
            console.error('Failed to refresh the library after a tag write:', error);
        }
    }

    return result;
});

/** Picks a cover image and returns it as base64, ready to embed. */
ipcMain.handle('pick-cover-image', async () => {
    const {canceled, filePaths} = await dialog.showOpenDialog({
        title: 'Choose album art',
        properties: ['openFile'],
        filters: [{name: 'Images', extensions: ['jpg', 'jpeg', 'png']}],
    });
    if (canceled || !filePaths.length) return null;

    try {
        const imagePath = filePaths[0];
        const data = fs.readFileSync(imagePath).toString('base64');
        const mimeType = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
        return {data, mimeType, dataUrl: `data:${mimeType};base64,${data}`};
    } catch (error) {
        console.error('Failed to read the chosen image:', error);
        return null;
    }
});

ipcMain.handle('open-files', async () => {
    const {canceled, filePaths} = await dialog.showOpenDialog({
        filters: [
            {name: 'Audio', extensions: SUPPORTED_EXTENSIONS.map(ext => ext.slice(1))},
            {name: 'All Files', extensions: ['*']},
        ],
        properties: ['openFile', 'multiSelections']
    });
    return (canceled || filePaths.length === 0) ? null : filePaths;
});

ipcMain.handle('open-folder', async () => {
    const {canceled, filePaths} = await dialog.showOpenDialog({properties: ['openDirectory']});
    if (canceled || filePaths.length === 0) return null;
    return await scanAndIndex(filePaths[0]);
});

ipcMain.handle('process-dropped-paths', async (_event, droppedPaths) => {
    const {files, truncated} = await scanner.resolvePaths(droppedPaths, SUPPORTED_EXTENSIONS, {
        onProgress: ({found, current}) => sendToRenderer('scan-progress', {found, current}),
    });

    library.ingest(files);
    if (truncated) sendToRenderer('scan-truncated', {count: files.length});
    sendToRenderer('library-updated', {
        trackCount: library.size,
        artists: library.listArtists(),
    });

    return files;
});

ipcMain.handle('toggle-orientation', async (_event, isVertical) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    currentLayout = isVertical ? 'vertical' : 'horizontal';

    // Snap to the layout preset without re-locking min == max, so the user can still
    // drag the window afterwards.
    windowState.applyPreset(mainWindow, currentLayout);
    persistWindowState();

    sendToRenderer('set-orientation-class', isVertical);
});

ipcMain.on('toggle-lyrics-visibility', (_event, isVisible) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (currentLayout !== 'horizontal') return;

    // Keep whatever width the user has chosen; only the height changes with the pane.
    windowState.applyPreset(
        mainWindow,
        isVisible ? 'horizontal' : 'horizontalCompact',
        {preserveWidth: true}
    );
    persistWindowState();
});

ipcMain.handle('pin-window', () => {
    if (!mainWindow) return;
    const isPinned = !mainWindow.isAlwaysOnTop();
    mainWindow.setAlwaysOnTop(isPinned);
    store.set('isPinned', isPinned); // Save pinned state
    return isPinned;
});

ipcMain.handle('minimize-window', () => mainWindow?.minimize());
ipcMain.handle('close-window', () => mainWindow?.close());

ipcMain.handle('show-file-in-folder', (_event, filePath) => {
    if (filePath && fs.existsSync(filePath)) {
        shell.showItemInFolder(filePath);
    }
});

ipcMain.handle('copy-to-clipboard', (_event, text) => clipboard.writeText(text));

ipcMain.on('set-opacity', (_event, opacity) => {
    if (mainWindow) {
        mainWindow.setOpacity(opacity);
        store.set('windowOpacity', opacity); // Save for persistence
    }
});

ipcMain.on('open-github', () => { //
    const url = pkg.homepage; //
    if (url) {
        shell.openExternal(url); //
    } else {
        console.error('Homepage URL is not defined in package.json');
    }
});

ipcMain.on('open-author-url', () => {
    const url = pkg.author?.url; // Use optional chaining for safety
    if (url) {
        shell.openExternal(url);
    } else {
        console.error('Author URL is not defined in package.json');
    }
});

ipcMain.handle('get-app-version', () => {
    return app.getVersion();
});

// --- Library IPC (requests #13, #16, #17) ---------------------------------------

ipcMain.handle('library-search', (_event, query) => library.search(query || ''));

ipcMain.handle('library-artists', () => library.listArtists());

ipcMain.handle('library-tracks-by-artist', (_event, artistKey) =>
    library.getTracksByArtist(artistKey).map(track => track.filePath));

ipcMain.handle('library-get-track', (_event, filePath) => library.get(filePath));

/**
 * Parses artist/title for a single file on demand, using its real tags plus the
 * sibling-name evidence from its directory. Used by the "copy title & artist" item and
 * to upgrade a filename-only guess once a track actually plays.
 */
ipcMain.handle('library-resolve-track', async (_event, filePath) => {
    try {
        const parsedTags = await mm.parseFile(filePath, {skipCovers: true});
        const {title, artist, album} = parsedTags.common;

        const directory = path.dirname(filePath);
        let siblingCounts;
        try {
            const entries = await fs.promises.readdir(directory);
            siblingCounts = metadata.buildSiblingCounts(
                entries.filter(isSupportedAudioFile).map(name => path.join(directory, name))
            );
        } catch (_) {
            siblingCounts = undefined;
        }

        const resolved = metadata.parseTrackName(filePath, {title, artist, album}, {
            siblingCounts,
            folderName: path.basename(directory),
        });

        library.add(filePath, resolved);
        return resolved;
    } catch (error) {
        console.error('Failed to resolve track:', error);
        return metadata.parseTrackName(filePath, {});
    }
});

// --- File operations for the file dropdown (request #13) ------------------------

ipcMain.handle('open-path', async (_event, filePath) => {
    if (!filePath || !fs.existsSync(filePath)) return false;
    // Opens in the user's default player, rather than in Rhythm Dock.
    const error = await shell.openPath(filePath);
    if (error) console.error('Failed to open path:', error);
    return !error;
});

ipcMain.handle('open-containing-folder', async (_event, filePath) => {
    if (!filePath) return false;
    const directory = path.dirname(filePath);
    if (!fs.existsSync(directory)) return false;
    const error = await shell.openPath(directory);
    return !error;
});

/**
 * Deletes a file. Uses the OS trash rather than unlink, so a misclick is recoverable.
 * The renderer is responsible for confirming with the user first.
 */
ipcMain.handle('delete-file', async (_event, filePath) => {
    if (!filePath || !fs.existsSync(filePath)) return {ok: false, reason: 'not-found'};
    try {
        await shell.trashItem(filePath);
        library.remove(filePath);
        return {ok: true};
    } catch (error) {
        console.error('Failed to move file to trash:', error);
        return {ok: false, reason: error.message};
    }
});

/**
 * Per-directory exclusion list. Excluding a track hides it from any playlist built
 * from that folder, without touching the file itself.
 */
const EXCLUSIONS_KEY = 'directoryExclusions';

ipcMain.handle('get-exclusions', (_event, directory) => {
    const all = store.get(EXCLUSIONS_KEY, {});
    return all[directory] || [];
});

ipcMain.handle('toggle-exclusion', (_event, filePath) => {
    const directory = path.dirname(filePath);
    const all = store.get(EXCLUSIONS_KEY, {});
    const list = new Set(all[directory] || []);

    const excluded = !list.has(filePath);
    if (excluded) list.add(filePath); else list.delete(filePath);

    if (list.size > 0) {
        all[directory] = [...list];
    } else {
        delete all[directory];
    }
    store.set(EXCLUSIONS_KEY, all);

    return {excluded, directory};
});

ipcMain.handle('scan-folder-path', async (_event, dirPath) => scanAndIndex(dirPath));

// --- Tray & shortcut settings (request #5) --------------------------------------

ipcMain.handle('get-minimize-to-tray', () => store.get('minimizeToTray', false));

ipcMain.handle('set-minimize-to-tray', (_event, enabled) => {
    store.set('minimizeToTray', Boolean(enabled));
    return Boolean(enabled);
});

ipcMain.handle('hide-to-tray', () => {
    tray.hideWindow(mainWindow);
    return true;
});

ipcMain.handle('get-shortcuts', () => shortcuts.resolveBindings(store));

ipcMain.handle('set-shortcuts', (_event, bindings) => {
    store.set('globalShortcuts', bindings || {});
    const result = shortcuts.registerAll(shortcuts.resolveBindings(store), {
        playPause: () => sendToRenderer('media-key-event', 'play-pause'),
        next: () => sendToRenderer('media-key-event', 'next'),
        previous: () => sendToRenderer('media-key-event', 'prev'),
        showWindow: () => tray.showWindow(mainWindow),
        hideWindow: () => tray.hideWindow(mainWindow),
        toggleWindow: () => tray.toggleWindow(mainWindow),
    });
    return result;
});

ipcMain.handle('test-shortcut', (_event, accelerator) => shortcuts.testAccelerator(accelerator));

// --- Translation (request #15) ---------------------------------------------------

// Native notification for the work timer (request #26).
ipcMain.handle('notify', (_event, {title, body} = {}) => {
    try {
        if (!Notification.isSupported()) return false;
        const notification = new Notification({
            title: title || 'Rhythm Dock',
            body: body || '',
            silent: false,
        });
        // Clicking the toast should bring the player back, not just dismiss it.
        notification.on('click', () => tray.showWindow(mainWindow));
        notification.show();
        return true;
    } catch (error) {
        console.error('Notification failed:', error);
        return false;
    }
});

ipcMain.handle('get-languages', () => translate.LANGUAGES);

/**
 * Translates lyric lines, using the DB cache when possible.
 *
 * The cache key is (songKey, language). A cache hit costs one SQLite read; a miss costs
 * a network round trip, so this matters on replay.
 */
ipcMain.handle('translate-lyrics', async (_event, {songKey, lines, targetLanguage}) => {
    if (!Array.isArray(lines) || lines.length === 0) {
        return {ok: false, reason: 'no lines'};
    }
    if (!targetLanguage) return {ok: false, reason: 'no target language'};

    if (songKey) {
        const cached = database.getTranslation(songKey, targetLanguage);
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                // Only trust the cache if it still lines up with the current lyrics;
                // a re-fetched lyric with a different line count would desynchronise.
                if (Array.isArray(parsed) && parsed.length === lines.length) {
                    return {ok: true, lines: parsed, cached: true,
                            rtl: translate.isRightToLeft(targetLanguage)};
                }
            } catch (_) { /* corrupt cache entry; fall through and re-translate */ }
        }
    }

    const config = store.get('translation', {}) || {};

    try {
        const translated = await translate.translateLines(lines, targetLanguage, config);
        if (songKey) {
            database.saveTranslation(
                songKey, targetLanguage, JSON.stringify(translated), config.provider || 'google'
            );
        }
        return {ok: true, lines: translated, cached: false,
                rtl: translate.isRightToLeft(targetLanguage)};
    } catch (error) {
        console.error('Translation failed:', error);
        return {ok: false, reason: error.message};
    }
});

ipcMain.handle('get-translation-config', () => ({
    ...{provider: 'google', targetLanguage: 'en', endpoint: '', apiKey: ''},
    ...(store.get('translation', {}) || {}),
}));

ipcMain.handle('set-translation-config', (_event, config) => {
    store.set('translation', config || {});
    return true;
});

// --- Tab layout (request #14) ----------------------------------------------------

/**
 * The Player tab is the compact dock; Playlist and Settings need real estate. Rather
 * than forcing one size on all three, the window grows when a taller tab is selected
 * and returns to the dock size for the player.
 */
// --- Rooms / streaming (request: Phase 6) ---------------------------------------

ipcMain.handle('room-create', async (_event, options) => {
    try {
        const room = await getRoomClient().createRoom(options.serverUrl, options);
        return {ok: true, room};
    } catch (error) {
        return {ok: false, error: error.message};
    }
});

ipcMain.handle('room-join', async (_event, options) => {
    try {
        const room = await getRoomClient().joinRoom(options.serverUrl, options.code, options);
        return {ok: true, room};
    } catch (error) {
        return {ok: false, error: error.message};
    }
});

ipcMain.handle('room-leave', () => {
    if (roomClient) roomClient.leave();
    return true;
});

ipcMain.handle('room-status', () => {
    if (!roomClient || !roomClient.connected) return {connected: false};
    return {
        connected: true,
        code: roomClient.roomCode,
        role: roomClient.role,
        serverUrl: roomClient.serverUrl,
        isHost: roomClient.isHost,
    };
});

// Host publications. Each is a no-op unless this instance is the host, so the renderer
// can call them unconditionally.
ipcMain.on('room-publish-state', (_e, state) => roomClient?.publishState(state));
ipcMain.on('room-publish-library', (_e, {queue, info}) => {
    if (!roomClient) return;
    roomClient.publishLibrary(queue || [], info || {});
    // The renderer needs the same path -> id mapping so its state messages reference
    // ids members can actually resolve. Sending it back keeps one authority (main).
    const map = {};
    for (const [id, filePath] of roomClient.trackPaths) map[filePath] = id;
    sendToRenderer('room:track-ids', map);
});
ipcMain.on('room-publish-lyrics', (_e, payload) => roomClient?.publishLyrics(payload || {}));
ipcMain.on('room-publish-settings', (_e, settings) => roomClient?.publishSettings(settings));
ipcMain.on('room-control', (_e, {action, value}) => roomClient?.sendControl(action, value));
ipcMain.on('room-set-role', (_e, {memberId, role}) => roomClient?.setMemberRole(memberId, role));
ipcMain.on('room-kick', (_e, {memberId}) => roomClient?.kickMember(memberId));

ipcMain.handle('set-active-tab', (_event, tab) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (currentLayout === 'vertical') return false;

    const bounds = mainWindow.getBounds();
    const targetHeight = tab === 'player' ? (store.get('playerTabHeight', 180)) : 420;

    // Remember the player height so a user who resized the dock keeps their size.
    if (tab !== 'player' && bounds.height <= 260) {
        store.set('playerTabHeight', bounds.height);
    }

    mainWindow.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: Math.max(bounds.width, tab === 'player' ? 0 : 340),
        height: targetHeight,
    }, true);

    return true;
});