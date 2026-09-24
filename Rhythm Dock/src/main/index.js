const {app, BrowserWindow, ipcMain, dialog, globalShortcut, clipboard, shell, nativeTheme, Notification, screen} = require('electron');
const path = require('path');
const fs = require('fs');
const mm = require('music-metadata');
const Store = require('electron-store');
const pkg = require('../../package.json');

const paths = require('./core/paths');
const database = require('./services/database');
const windowState = require('./windows/window-state');
const edgeGeometry = require('./windows/edge-dock');
const scanner = require('./library/scanner');
const metadata = require('./library/metadata');
const tags = require('./library/tags');
const {LibraryIndex} = require('./library/index');
const libraryStore = require('./services/library-store');
const tray = require('./windows/tray');
const lyricsOverlay = require('./windows/lyrics-overlay');
const shortcuts = require('./core/shortcuts');
const translate = require('./services/translate');
const lyrics = require('./services/lyrics');
const {RoomClient} = require('./services/room-client');
const remoteCache = require('./services/remote-cache');

// Lazily constructed: most sessions never open a room, and constructing it eagerly
// would pull in the ws dependency for no reason.
let roomClient = null;

function getRoomClient() {
    if (!roomClient) {
        roomClient = new RoomClient({emit: (event, payload) => {
            if (event === 'room:upload-ready') {
                importRoomUpload(payload).catch((error) =>
                    sendToRenderer('room:error', {error: `Could not import song: ${error.message}`}));
            } else sendToRenderer(event, payload);
        }});
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
let edgeDock = {active: false, expanded: false, side: 'right'};
let normalBounds = null;
let normalPinned = false;
let normalResizable = true;
let edgeSnapTimer = null;

function edgeBounds(side, y, display = screen.getPrimaryDisplay(), width = edgeGeometry.COLLAPSED_WIDTH) {
    return edgeGeometry.boundsFor(side, y, display.workArea,
        width === edgeGeometry.EXPANDED_WIDTH);
}

function setEdgeDock(active) {
    if (!mainWindow || mainWindow.isDestroyed() || edgeDock.active === Boolean(active)) return edgeDock.active;
    if (active) {
        normalBounds = mainWindow.getBounds();
        windowState.save(store, mainWindow, {layout: currentLayout});
        normalPinned = mainWindow.isAlwaysOnTop();
        normalResizable = mainWindow.isResizable();
        edgeDock.active = true;
        edgeDock.expanded = false;
        const saved = store.get('edgeDock', {});
        const display = screen.getDisplayNearestPoint({x: normalBounds.x, y: normalBounds.y});
        edgeDock.side = ['left', 'right'].includes(saved.side) ? saved.side
            : edgeGeometry.sideForPoint(normalBounds.x + normalBounds.width / 2, display.workArea);
        mainWindow.setMinimumSize(edgeGeometry.COLLAPSED_WIDTH, 110);
        mainWindow.setResizable(false);
        mainWindow.setAlwaysOnTop(true);
        mainWindow.setBounds(edgeBounds(edgeDock.side, saved.y ?? normalBounds.y, display));
        if (!mainWindow.isVisible()) mainWindow.show();
    } else {
        edgeDock.active = false;
        edgeDock.expanded = false;
        mainWindow.setResizable(normalResizable);
        mainWindow.setMinimumSize(windowState.LIMITS.minWidth, windowState.LIMITS.minHeight);
        mainWindow.setAlwaysOnTop(normalPinned);
        if (normalBounds) mainWindow.setBounds(normalBounds);
        windowState.save(store, mainWindow, {layout: currentLayout});
        sendToRenderer('set-orientation-class', currentLayout === 'vertical');
    }
    store.set('edgeDock', {active: edgeDock.active, side: edgeDock.side,
        y: mainWindow.getBounds().y});
    sendToRenderer('edge-dock-changed', {...edgeDock});
    return edgeDock.active;
}

function expandEdgeDock(expanded) {
    if (!edgeDock.active || !mainWindow || mainWindow.isDestroyed()) return;
    if (edgeDock.expanded === Boolean(expanded)) return;
    edgeDock.expanded = Boolean(expanded);
    const old = mainWindow.getBounds();
    const display = screen.getDisplayNearestPoint({x: old.x + old.width / 2, y: old.y});
    mainWindow.setBounds(edgeBounds(edgeDock.side, old.y, display,
        edgeDock.expanded ? edgeGeometry.EXPANDED_WIDTH : edgeGeometry.COLLAPSED_WIDTH));
    sendToRenderer('edge-dock-changed', {...edgeDock});
}

function snapEdgeDock() {
    if (!edgeDock.active || !mainWindow || mainWindow.isDestroyed()) return;
    const bounds = mainWindow.getBounds();
    const center = {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2};
    const display = screen.getDisplayNearestPoint(center);
    edgeDock.side = edgeGeometry.sideForPoint(center.x, display.workArea);
    const target = edgeBounds(edgeDock.side, bounds.y, display,
        edgeDock.expanded ? edgeGeometry.EXPANDED_WIDTH : edgeGeometry.COLLAPSED_WIDTH);
    if (target.x !== bounds.x || target.y !== bounds.y || target.height !== bounds.height)
        mainWindow.setBounds(target);
    store.set('edgeDock', {active: true, side: edgeDock.side, y: target.y});
    sendToRenderer('edge-dock-changed', {...edgeDock});
}

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
    : path.join(__dirname, '..', '..', 'build', 'icons', 'media');

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
        // Full-screen lyrics (Phase 9) needs this. It was false because nothing used
        // to full-screen the dock, and setFullScreen() fails silently without it.
        fullscreenable: true,
        frame: false,
        transparent: true,
        show: false,
        backgroundColor: '#00000000',
        alwaysOnTop: store.get('isPinned', false),
        webPreferences: {
            preload: path.join(__dirname, '..', 'preload', 'index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            // Renderer-side spellcheck is dead weight for a music player.
            spellcheck: false,
        },
    });

    // Paint once before showing, so the window does not flash a transparent frame.
    mainWindow.once('ready-to-show', () => {
        if (store.get('edgeDock', {}).active) setEdgeDock(true);
        mainWindow.show();
    });

    // Debounced persistence on move/resize, plus a final flush returned for 'close'.
    persistWindowState = windowState.track(store, mainWindow, () =>
        ({layout: currentLayout, skipSave: edgeDock.active}));
    mainWindow.on('moved', () => {
        clearTimeout(edgeSnapTimer);
        edgeSnapTimer = setTimeout(snapEdgeDock, 30);
    });
    screen.on('display-removed', snapEdgeDock);

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

    // The OS can leave full-screen without asking us (the green button on macOS, F11
    // on Windows), so the renderer is told rather than assuming its own state holds.
    mainWindow.on('enter-full-screen', () => sendToRenderer('window:fullscreen-changed', true));
    mainWindow.on('leave-full-screen', () => sendToRenderer('window:fullscreen-changed', false));

    // Same treatment for the minimise button when the option is on.
    mainWindow.on('minimize', (event) => {
        if (store.get('minimizeToTray', false)) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    mainWindow.on('closed', () => {
        screen.off('display-removed', snapEdgeDock);
        mainWindow = null;
        // The overlay is a real window, so leaving it open would keep the app alive
        // past 'window-all-closed' with no player behind it feeding it lines.
        lyricsOverlay.close(store);
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
    try { remoteCache.prune(path.join(paths.getDataRoot(), 'remote-cache')); }
    catch (error) { console.warn('[cache] Could not prune old audio:', error.message); }
    createWindow();

    // Reopen the desktop lyrics strip if it was showing at shutdown. Deliberately after
    // createWindow(), so the player exists to answer the state request it triggers.
    if (store.get('lyricsOverlayEnabled', false)) {
        lyricsOverlay.create(store);
    }

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
        toggleEdgeDock: () => { if (!store.get('isLocked', false)) setEdgeDock(!edgeDock.active); },
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
app.on('before-quit', () => {
    tray.setQuitting(true);
    // Flushes the strip's position before the window is torn down.
    if (store) lyricsOverlay.close(store);
});

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

// --- Lyrics (Phase 9) -------------------------------------------------------------
//
// The renderer used to call lrclib directly with fetch(). That put a provider URL in
// the CSP, gave the renderer no way to read an .lrc sidecar, and meant one provider
// outage read to the user as "this song has no lyrics". Resolution now happens here,
// behind a chain of sources. See services/lyrics.js.

const LYRICS_DEFAULTS = {
    providerOrder: lyrics.DEFAULT_PROVIDER_ORDER,
    geniusToken: '',
    autoSaveLrc: false,
    typography: {
        fontFamily: '',
        fontSize: 15,
        fontWeight: 600,
        align: 'center',
        lineHeight: 1.4,
    },
};

function getLyricsConfig() {
    const stored = store.get('lyrics', {}) || {};
    return {
        ...LYRICS_DEFAULTS,
        ...stored,
        typography: {...LYRICS_DEFAULTS.typography, ...(stored.typography || {})},
    };
}

ipcMain.handle('lyrics:get-config', () => getLyricsConfig());

ipcMain.handle('lyrics:set-config', (_event, config) => {
    const merged = {...getLyricsConfig(), ...(config || {})};
    merged.typography = {...getLyricsConfig().typography, ...((config || {}).typography || {})};
    store.set('lyrics', merged);
    return merged;
});

/**
 * Resolves lyrics for a track: database cache first, then the provider chain.
 *
 * `forceRefetch` bypasses the cache but never the sidecar - a user asking to search
 * again should not have their own hand-synced file thrown away underneath them.
 */
ipcMain.handle('lyrics:resolve', async (_event, request = {}) => {
    const {songKey, forceRefetch} = request;
    const config = getLyricsConfig();
    const offsetMs = songKey ? (database.getLyricsPrefs(songKey)?.offsetMs || 0) : 0;

    if (songKey && !forceRefetch) {
        const cached = database.getLyricsRow(songKey);
        if (cached && cached.lyricsText) {
            return {
                ok: true,
                text: cached.lyricsText,
                source: cached.source || 'cache',
                isSynced: Boolean(cached.isSynced),
                hasWordTiming: Boolean(cached.hasWordTiming),
                cached: true,
                offsetMs,
            };
        }
    }

    const result = await lyrics.resolve({
        ...request,
        lyricsDir: paths.getLyricsDir(),
        order: config.providerOrder,
    }, config);

    if (result.ok && songKey) {
        // A refetch replaces the lyric, so any cached translation of the previous one
        // is now misaligned line for line. Dropping it is cheaper than detecting it.
        if (forceRefetch) database.clearTranslations(songKey);

        database.saveLyrics(songKey, result.text, {
            source: result.source,
            isSynced: result.isSynced,
            hasWordTiming: result.hasWordTiming,
            artist: request.artist || null,
            title: request.title || null,
        });
        if (result.sidecarPath) {
            database.saveLyricsPrefs(songKey, {
                source: result.source,
                sidecarPath: result.sidecarPath,
            });
        }
    }

    return {...result, cached: false, offsetMs};
});

/**
 * Saves a lyric the user authored or edited: the database always, plus an .lrc
 * sidecar and/or the file's own tags on request.
 *
 * Returns per-destination results rather than a single boolean, because embedding can
 * fail (unsupported container) while the sidecar succeeded, and the user needs to know
 * which of the two actually happened.
 */
ipcMain.handle('lyrics:save', async (_event, payload = {}) => {
    const {songKey, filePath, text, saveSidecar, embed, artist, title} = payload;
    if (!text) return {ok: false, error: 'Nothing to save.'};

    const shape = {
        isSynced: lyrics.isSynced(text),
        hasWordTiming: lyrics.hasWordTiming(text),
    };

    if (songKey) {
        database.saveLyrics(songKey, text, {...shape, source: 'user', artist, title});
        database.clearTranslations(songKey);
    }

    const result = {ok: true, ...shape};

    if (saveSidecar && filePath) {
        const written = lyrics.writeSidecar(filePath, text, paths.getLyricsDir());
        result.sidecar = written;
        if (written.ok && songKey) {
            database.saveLyricsPrefs(songKey, {
                source: 'user',
                sidecarPath: written.sidecarPath,
            });
        }
    }

    if (embed && filePath) {
        result.embedded = tags.writeLyrics(filePath, text);
    }

    return result;
});

ipcMain.handle('lyrics:get-offset', (_event, songKey) => (
    database.getLyricsPrefs(songKey)?.offsetMs || 0
));

ipcMain.handle('lyrics:set-offset', (_event, {songKey, offsetMs} = {}) => {
    if (!songKey) return false;
    database.saveLyricsPrefs(songKey, {offsetMs: Number(offsetMs) || 0});
    return true;
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
    if (edgeDock.active) return;

    currentLayout = isVertical ? 'vertical' : 'horizontal';

    // Snap to the layout preset without re-locking min == max, so the user can still
    // drag the window afterwards.
    windowState.applyPreset(mainWindow, currentLayout);
    persistWindowState();

    sendToRenderer('set-orientation-class', isVertical);
});

ipcMain.handle('edge-dock-toggle', () => {
    if (store.get('isLocked', false)) return edgeDock.active;
    return setEdgeDock(!edgeDock.active);
});
ipcMain.handle('edge-dock-status', () => ({...edgeDock}));
ipcMain.on('edge-dock-expand', (_event, expanded) => expandEdgeDock(expanded));

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

/**
 * Full-screen lyrics (Phase 9).
 *
 * The overlay itself is renderer-side, but it has to be paired with real window
 * full-screen: the dock is 180px tall, and a "full-screen" lyric view inside a
 * 180px window is a joke. Bounds are restored by Electron on exit, but the
 * always-on-top flag is not - a pinned dock that stayed on top of everything after
 * leaving full-screen was the first thing that went wrong here.
 */
let wasPinnedBeforeFullscreen = false;

ipcMain.handle('window:set-fullscreen', (_event, enabled) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;

    if (enabled) {
        wasPinnedBeforeFullscreen = mainWindow.isAlwaysOnTop();
        mainWindow.setAlwaysOnTop(false);
    } else {
        mainWindow.setAlwaysOnTop(wasPinnedBeforeFullscreen);
    }

    mainWindow.setFullScreen(Boolean(enabled));
    return Boolean(enabled);
});

ipcMain.handle('window:is-fullscreen', () => Boolean(mainWindow?.isFullScreen()));

// --- Desktop lyrics overlay (Phase 9) ---------------------------------------------
//
// The overlay is a second window with its own tiny preload; see windows/lyrics-overlay.js.
// Main is the only path between the two renderers, which is the point: the strip can
// receive a line and send a transport command, and nothing else.

ipcMain.handle('overlay:toggle', (_event, enabled) => {
    const shouldOpen = enabled === undefined ? !lyricsOverlay.isOpen() : Boolean(enabled);
    const open = shouldOpen ? Boolean(lyricsOverlay.create(store)) : lyricsOverlay.close(store);
    store.set('lyricsOverlayEnabled', open);

    // A freshly created window has missed every push so far, so the player is asked
    // for the current line rather than leaving the strip blank until the next one.
    if (open) sendToRenderer('overlay:request-state');
    return open;
});

ipcMain.handle('overlay:is-open', () => lyricsOverlay.isOpen());

ipcMain.on('overlay:update', (_event, payload) => lyricsOverlay.send('overlay:update', payload));
ipcMain.on('overlay:style', (_event, payload) => lyricsOverlay.send('overlay:style', payload));

ipcMain.handle('overlay:set-click-through', (_event, enabled) => (
    lyricsOverlay.setClickThrough(enabled)
));

// Transport buttons on the strip reuse the same channel the tray and the thumbar use,
// so there is one command vocabulary rather than three.
ipcMain.on('overlay:command', (_event, action) => sendToRenderer('media-key-event', action));

ipcMain.on('overlay:close', () => {
    lyricsOverlay.close(store);
    store.set('lyricsOverlayEnabled', false);
    sendToRenderer('overlay:closed');
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
ipcMain.handle('library-catalog', () => libraryStore.roomCatalog());

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

        // A scan only knows filenames; this is the first point at which real tags have
        // been read, so the stored row is upgraded from the guess to the truth.
        libraryStore.updateTrackMetadata(filePath, {
            title: resolved.title,
            artist: resolved.artist,
            album: resolved.album,
            durationSeconds: parsedTags.format?.duration,
        });

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

// --- Persistent library (Phase 7) -------------------------------------------------
//
// The in-memory index above answers search and artist browsing and is rebuilt on every
// scan. These handlers sit on top of services/library-store.js, which is the durable
// half: watched folders, the tracks in them, and play statistics that survive a
// rescan, a folder removal, and an app update.

/**
 * Scans one root and records the result, keeping the in-memory index in step.
 * Returns the sync summary so the caller can report how many missing tracks came back.
 */
async function scanRoot(root) {
    const {files, truncated} = await scanner.scanDirectory(root.path, SUPPORTED_EXTENSIONS, {
        onProgress: ({found, current}) => sendToRenderer('scan-progress', {found, current}),
    });

    library.ingest(files);
    if (truncated) sendToRenderer('scan-truncated', {count: files.length});

    return libraryStore.syncRoot(root.id, files);
}

async function importRoomUpload(upload) {
    const client = roomClient;
    if (!client?.isHost || !client.hostToken || !/^[a-f0-9]{36}$/.test(upload.id)) return;
    const extension = path.extname(upload.fileName || '').toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(extension) || upload.size > 30 * 1024 * 1024) return;
    const address = `${client.serverUrl}/api/rooms/${encodeURIComponent(client.roomCode)}/uploads/${upload.id}`;
    const headers = {Authorization: `Bearer ${client.hostToken}`};
    const response = await fetch(address, {headers});
    if (!response.ok) throw new Error(`server returned ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== upload.size || bytes.length > 30 * 1024 * 1024) throw new Error('incomplete file');
    const incomingDir = path.join(paths.getDataRoot(), 'incoming');
    fs.mkdirSync(incomingDir, {recursive: true});
    const filePath = path.join(incomingDir, `${upload.id}${extension}`);
    await fs.promises.writeFile(filePath, bytes, {flag: 'wx'});
    try {
        const root = libraryStore.addRoot(incomingDir);
        await scanRoot(root);
        sendToRenderer('room:incoming-track', {filePath, position: upload.position || 'end'});
        await fetch(address, {method: 'DELETE', headers});
    } catch (error) {
        fs.rmSync(filePath, {force: true});
        throw error;
    }
}

ipcMain.handle('library-roots', () => libraryStore.listRoots());
ipcMain.handle('library-stats', () => libraryStore.stats());
ipcMain.handle('library-view', (_event, view, limit) => libraryStore.view(view, limit));
ipcMain.handle('remote-audio-add', async (_event, url) => {
    try {
        const cacheRoot = path.join(paths.getDataRoot(), 'remote-cache');
        const result = await remoteCache.download(url, cacheRoot, fetch, (received, total) =>
            sendToRenderer('remote-audio-progress', {received, total}));
        library.ingest([result.filePath]);
        return {ok: true, ...result};
    } catch (error) { return {ok: false, error: error.message}; }
});
ipcMain.handle('remote-audio-save', async (_event, filePath) => {
    try {
        const cacheRoot = path.join(paths.getDataRoot(), 'remote-cache');
        const incoming = path.join(paths.getDataRoot(), 'incoming');
        const savedPath = remoteCache.save(filePath, cacheRoot, incoming);
        const root = libraryStore.addRoot(incoming);
        if (!root) throw new Error('Could not register saved songs folder.');
        await scanRoot(root);
        return {ok: true, filePath: savedPath};
    } catch (error) { return {ok: false, error: error.message}; }
});
ipcMain.handle('playlist-list', () => libraryStore.listPlaylists());
ipcMain.handle('playlist-tracks', (_event, id) => libraryStore.playlistTracks(id));
ipcMain.handle('playlist-create', (_event, name, filePaths) => libraryStore.createPlaylist(name, filePaths));
ipcMain.handle('playlist-add', (_event, id, filePath) => libraryStore.addToPlaylist(id, filePath));
ipcMain.handle('playlist-remove', (_event, id, filePath) => libraryStore.removeFromPlaylist(id, filePath));
ipcMain.handle('playlist-delete', async (_event, id) => {
    const item = libraryStore.listPlaylists().find((playlist) => playlist.id === Number(id));
    if (!item) return false;
    const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning', title: 'Delete playlist?',
        message: `Delete “${item.name}”?`,
        detail: 'The songs themselves will stay on disk.',
        buttons: ['Cancel', 'Delete Playlist'], defaultId: 0, cancelId: 0,
    });
    return result.response === 1 ? libraryStore.deletePlaylist(id) : false;
});

ipcMain.handle('library-add-root', async () => {
    const {canceled, filePaths} = await dialog.showOpenDialog({properties: ['openDirectory']});
    if (canceled || filePaths.length === 0) return null;

    const root = libraryStore.addRoot(filePaths[0]);
    if (!root) return null;

    const result = await scanRoot(root);
    sendToRenderer('library-updated', {
        trackCount: library.size,
        artists: library.listArtists(),
    });
    sendToRenderer('scan-complete', {
        total: result.seen,
        reparsed: result.added,
        missing: result.missing,
    });
    return {root, ...result};
});

ipcMain.handle('library-remove-root', (_event, rootId) => libraryStore.removeRoot(rootId));

/** Rescans one root, or every root when `rootId` is null. */
ipcMain.handle('library-rescan', async (_event, rootId) => {
    const roots = libraryStore.listRoots()
        .filter((root) => rootId == null || root.id === rootId);

    const totals = {seen: 0, added: 0, restored: 0, missing: 0};
    for (const root of roots) {
        // Sequential on purpose: two concurrent scans of a spinning disk or a network
        // share are slower than one, and they interleave their progress events.
        const result = await scanRoot(root);
        for (const key of Object.keys(totals)) totals[key] += result[key];
    }

    sendToRenderer('library-updated', {
        trackCount: library.size,
        artists: library.listArtists(),
    });
    sendToRenderer('scan-complete', {
        total: totals.seen,
        reparsed: totals.added,
        missing: totals.missing,
    });
    return totals;
});

ipcMain.handle('library-recheck-missing', () => libraryStore.recheckMissing());

ipcMain.on('library-record-play', (_event, filePath, listenedMs) => {
    libraryStore.recordPlay(filePath, listenedMs);
});

ipcMain.on('library-record-skip', (_event, filePath, listenedMs) => {
    libraryStore.recordSkip(filePath, listenedMs);
});

ipcMain.handle('library-export', async () => {
    const {canceled, filePath} = await dialog.showSaveDialog({
        title: 'Back up library',
        defaultPath: `rhythm-dock-library-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{name: 'JSON', extensions: ['json']}],
    });
    if (canceled || !filePath) return null;

    const snapshot = libraryStore.exportAll();
    if (!snapshot) return {ok: false, error: 'Could not read the library.'};

    try {
        fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
        return {ok: true, tracks: snapshot.tracks.length, filePath};
    } catch (error) {
        return {ok: false, error: error.message};
    }
});

ipcMain.handle('library-import', async () => {
    const {canceled, filePaths} = await dialog.showOpenDialog({
        title: 'Restore library backup',
        properties: ['openFile'],
        filters: [{name: 'JSON', extensions: ['json']}],
    });
    if (canceled || filePaths.length === 0) return null;

    try {
        const payload = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
        return libraryStore.importAll(payload);
    } catch (error) {
        return {ok: false, error: 'That file could not be read as JSON.'};
    }
});

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
        toggleEdgeDock: () => { if (!store.get('isLocked', false)) setEdgeDock(!edgeDock.active); },
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
        return {ok: true, room: {...room, role: roomClient.role}};
    } catch (error) {
        return {ok: false, error: error.message};
    }
});

ipcMain.handle('room-upload-song', async (_event, position = 'end') => {
    const client = roomClient;
    if (!client?.connected || client.role !== 'controller' || !client.uploadToken)
        return {ok: false, error: 'This room is listen-only or disconnected'};
    const selection = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'], filters: [{name: 'Audio', extensions: SUPPORTED_EXTENSIONS.map((ext) => ext.slice(1))}],
    });
    if (selection.canceled || !selection.filePaths.length) return {ok: false, cancelled: true};
    const filePath = selection.filePaths[0];
    const size = (await fs.promises.stat(filePath)).size;
    if (size < 1 || size > 30 * 1024 * 1024) return {ok: false, error: 'Song must be 30 MB or smaller'};
    const endpoint = `${client.serverUrl}/api/rooms/${encodeURIComponent(client.roomCode)}/uploads?position=${encodeURIComponent(position)}`;
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {'Content-Type': 'application/octet-stream', 'Content-Length': String(size),
            'X-Member-Id': client.memberId, 'X-Upload-Token': client.uploadToken,
            'X-File-Name': encodeURIComponent(path.basename(filePath))},
        body: await fs.promises.readFile(filePath),
    });
    const result = await response.json().catch(() => ({}));
    return response.ok ? {ok: true, id: result.id} : {ok: false, error: result.error || `Server returned ${response.status}`};
});

ipcMain.handle('room-telegram-pair', async () => {
    const client = roomClient;
    if (!client?.connected || !client.isHost) return {ok: false, error: 'Start a room first'};
    try {
        const response = await fetch(`${client.serverUrl}/api/rooms/${encodeURIComponent(client.roomCode)}/telegram-pair`, {
            method: 'POST', headers: {Authorization: `Bearer ${client.hostToken}`},
        });
        const result = await response.json();
        return response.ok ? {ok: true, ...result} : {ok: false, error: result.error};
    } catch (error) { return {ok: false, error: error.message}; }
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
ipcMain.on('room-publish-library', (_e, {queue, info, catalog}) => {
    if (!roomClient) return;
    roomClient.publishLibrary(queue || [], info || {}, catalog || []);
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
    if (edgeDock.active) return false;
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
