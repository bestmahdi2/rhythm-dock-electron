const {app, BrowserWindow, Menu, ipcMain, dialog, globalShortcut, clipboard, shell, nativeTheme, Notification, screen, safeStorage, powerMonitor} = require('electron');
const path = require('path');
const fs = require('fs');
const {Worker} = require('worker_threads');
const mm = {parseFile:(file,options)=>require('./services/media-metadata').parseFile(file,options,store?.get('ffmpegPath','')||'ffmpeg')};
const Store = require('electron-store');
const pkg = require('../../package.json');

const paths = require('./core/paths');
const database = require('./services/database');
const windowState = require('./windows/window-state');
const edgeGeometry = require('./windows/edge-dock');
const scanner = require('./library/scanner');
const {RootWatcher} = require('./library/root-watcher');
const coverCache = require('./library/cover-cache');
const chapters = require('./library/chapters');
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
const remotePlaylist = require('./services/remote-playlist');
const playlistFormats = require('./services/playlist-formats');
const mediaTools = require('./services/media-tools');
const audioAnalysis = require('./services/audio-analysis');
const {Diagnostics} = require('./services/diagnostics');
let diagnostics = null;
let rendererRecoveryCount = 0;
let mediaOperation = null;

async function withMediaOperation(work) {
    if (mediaOperation) return {ok: false, error: 'An audio operation is already running. Wait or cancel it first.'};
    mediaOperation = new AbortController();
    const options = {executable: store.get('ffmpegPath', '') || 'ffmpeg', signal: mediaOperation.signal,
        onProgress: (seconds) => sendToRenderer('media-tools-progress', {seconds})};
    try { return {ok: true, ...await work(options)}; }
    catch (error) { return {ok: false, error: error.message}; }
    finally { mediaOperation = null; }
}

// Lazily constructed: most sessions never open a room, and constructing it eagerly
// would pull in the ws dependency for no reason.
let roomClient = null;

function getRoomClient() {
    if (!roomClient) {
        roomClient = new RoomClient({emit: (event, payload) => {
            if (event === 'room:welcome') payload = {...payload, serverUrl: roomClient.serverUrl};
            if (['room:connected', 'room:disconnected', 'room:error'].includes(event))
                diagnostics?.record(event, {code: payload?.code, role: payload?.role});
            if (event === 'room:upload-ready') {
                importRoomUpload(payload).catch((error) =>
                    sendToRenderer('room:error', {error: `Could not import song: ${error.message}`}));
            } else if (event === 'room:link-ready') {
                const sourceCode = roomClient.roomCode;
                importRemoteAudio(payload.url).then((result) => {
                    if (!result.ok) throw new Error(result.error);
                    if (!roomClient.connected || !roomClient.isHost || roomClient.roomCode !== sourceCode) return;
                    const files = payload.position === 'first' || payload.position === 'next' ? [...result.files].reverse() : result.files;
                    for (const filePath of files) sendToRenderer('room:incoming-track',
                        {filePath, position: payload.position || 'end'});
                }).catch(() => sendToRenderer('room:error', {error: 'Could not import the Telegram audio link.'}));
            } else sendToRenderer(event, payload);
        }});
    }
    return roomClient;
}

// The scanned library. Rebuilt whenever a folder is opened; never persisted, because
// re-scanning is cheap and a stale cache is worse than none.
const library = new LibraryIndex();
const rootWatcher = new RootWatcher(async (root) => {
    const current = libraryStore.listRoots().find((item) => item.id === root.id);
    if (!current) return;
    await scanRoot(current);
    sendToRenderer('library-updated', {trackCount: library.size, artists: library.listArtists()});
});

Store.initRenderer();

// `cwd` pins settings to <appData>/RhythmDock/config instead of the product-name
// directory, so an update or a rename can no longer orphan them. See main/paths.js.
let store;

let mainWindow;
let persistWindowState = () => {};
let currentLayout = 'horizontal';
let currentTab = 'player';
let appFullscreenMode = false;
let edgeDock = {active: false, expanded: false, side: 'right'};
let normalBounds = null;
let normalPinned = false;
let normalResizable = true;
let edgeSnapTimer = null;

function edgeBounds(side, y, display = screen.getPrimaryDisplay(), width = edgeGeometry.COLLAPSED_WIDTH, x = mainWindow?.getBounds().x) {
    return edgeGeometry.boundsFor(side, y, display.workArea,
        width === edgeGeometry.EXPANDED_WIDTH, currentTab === 'player' ? edgeGeometry.EXPANDED_WIDTH : 340, x);
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
        edgeDock.side = ['left', 'right', 'top'].includes(saved.side) ? saved.side
            : edgeGeometry.sideForPoint(normalBounds.x + normalBounds.width / 2, display.workArea, normalBounds.y);
        mainWindow.setMinimumSize(edgeGeometry.COLLAPSED_WIDTH, edgeGeometry.COLLAPSED_WIDTH);
        mainWindow.setResizable(false);
        mainWindow.setAlwaysOnTop(true);
        mainWindow.setBounds(edgeBounds(edgeDock.side, saved.y ?? normalBounds.y, display, edgeGeometry.COLLAPSED_WIDTH, saved.x ?? normalBounds.x));
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
        x: mainWindow.getBounds().x, y: mainWindow.getBounds().y});
    sendToRenderer('edge-dock-changed', {...edgeDock});
    return edgeDock.active;
}

function expandEdgeDock(expanded) {
    if (!edgeDock.active || !mainWindow || mainWindow.isDestroyed()) return;
    const wantedWidth = expanded ? (currentTab === 'player' ? edgeGeometry.EXPANDED_WIDTH : 340)
        : edgeDock.side === 'top' ? edgeGeometry.HEIGHT : edgeGeometry.COLLAPSED_WIDTH;
    if (edgeDock.expanded === Boolean(expanded) && mainWindow.getBounds().width === wantedWidth) return;
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
    // Use the nearest outside edge of the dragged strip, with a small top-edge
    // threshold so an expanded top panel does not jump to a side when it opens.
    edgeDock.side = bounds.y <= display.workArea.y + 32 ? 'top'
        : edgeGeometry.sideForPoint(center.x, display.workArea, center.y);
    const target = edgeBounds(edgeDock.side, bounds.y, display,
        edgeDock.expanded ? edgeGeometry.EXPANDED_WIDTH : edgeGeometry.COLLAPSED_WIDTH);
    if (target.x !== bounds.x || target.y !== bounds.y || target.height !== bounds.height || target.width !== bounds.width)
        mainWindow.setBounds(target);
    store.set('edgeDock', {active: true, side: edgeDock.side, x: target.x, y: target.y});
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
const mediaFormats = require('../shared/media-formats');
const inputFiles = require('./services/input-files');
const SUPPORTED_EXTENSIONS = mediaFormats.audio;
const isOpenableFile = file => mediaFormats.openable.includes(path.extname(file).toLowerCase());

const isSupportedAudioFile = (filePath) =>
    SUPPORTED_EXTENSIONS.includes(path.extname(filePath).toLowerCase());
const launchOptions = require('./core/launch-options');
let pendingLaunch = launchOptions.parseArgs(process.argv, process.cwd(), isOpenableFile, file => inputFiles.expandFiles([file]));
let rendererIsReady = false;

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
        if(!showOnReadyHidden)mainWindow.show();
    });
    // Some Bluetooth/USB accessories deliver separate pause/stop app commands.
    // These must stay idempotent, even when the player's UI is locked.
    mainWindow.on('app-command',(_event,command)=>{
        if(command==='media-pause'||command==='media-stop')sendToRenderer('media-key-event','pause');
    });
    const showOnReadyHidden=pendingLaunch.hidden;

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
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
        rendererIsReady=false;
        diagnostics?.record('renderer:exit', {reason: details.reason, code: details.exitCode});
        if(details.reason==='crashed')roadmap.reportCrash().catch(()=>{});
        if (['crashed', 'oom', 'abnormal-exit'].includes(details.reason) && rendererRecoveryCount++ === 0) {
            // The persisted queue is restored paused; a crash must not blast audio.
            setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload(); }, 500);
        }
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
    mainWindow.on('leave-full-screen', () => { appFullscreenMode = false; sendToRenderer('window:fullscreen-changed', false); });

    // Same treatment for the minimise button when the option is on.
    mainWindow.on('minimize', (event) => {
        if (store.get('minimizeToTray', false)) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    rendererIsReady=false;
    platformControls.touchBar(mainWindow);
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    mainWindow.on('closed', () => {
        screen.off('display-removed', snapEdgeDock);
        mainWindow = null;
        // The overlay is a real window, so leaving it open would keep the app alive
        // past 'window-all-closed' with no player behind it feeding it lines.
        lyricsOverlay.close(store);
    });

    // Windows needs a taskbar button before its thumbnail toolbar can be installed.
    mainWindow.on('show', updateThumbar);
    mainWindow.once('ready-to-show', updateThumbar);
    platformControls.update({isPlaying});
};

// --- Helper function to safely send messages to the renderer ---
const sendToRenderer = (channel, ...args) => {
    // Background scans and room events can finish while crash recovery replaces
    // the frame. Fresh startup state is sent after the new renderer is ready.
    if(!rendererIsReady||!mainWindow||mainWindow.isDestroyed())return;
    const contents=mainWindow.webContents;
    if(contents.isDestroyed()||contents.isCrashed())return;
    try{contents.send(channel,...args);}catch(_){/* The frame may retire between the checks and send. */}
};
const platformControls=require('./services/platform-controls').create({electron:require('electron'),getStore:()=>store,
    getWindow:()=>mainWindow,send:sendToRenderer});
const audioInterruptions=require('./services/audio-interruptions').create({powerMonitor,getStore:()=>store,send:sendToRenderer});
const discordPresence=new (require('./services/discord-presence').DiscordPresence)({getConfig:()=>store?.get('discordPresence',{})||{}});

const roadmap = require('./services/roadmap-ipc').install({
    getStore:()=>store, getWindow:()=>mainWindow,discordPresence,
    getLayout:()=>({layout:currentLayout,edge:{active:edgeDock.active,side:edgeDock.side}}),
    applyLayout:preset=>{
        setEdgeDock(false);
        currentLayout=preset.layout==='vertical'?'vertical':'horizontal'; currentTab='player';
        const restored=windowState.restore({get:()=>preset.bounds});
        const bounds={width:restored.width,height:restored.height};
        if(Number.isFinite(restored.x)){bounds.x=restored.x;bounds.y=restored.y;}
        mainWindow.setBounds(bounds); if(!Number.isFinite(restored.x))mainWindow.center();
        mainWindow.setAlwaysOnTop(Boolean(preset.pinned));store.set('isPinned',Boolean(preset.pinned));
        sendToRenderer('set-orientation-class',currentLayout==='vertical');
        if(preset.edge?.active){edgeDock.side=['left','right','top'].includes(preset.edge.side)?preset.edge.side:'right';
            store.set('edgeDock', {...store.get('edgeDock', {}),side:edgeDock.side});setEdgeDock(true);}
        persistWindowState();
    },
    updated:(oldPath,newPath)=>{
        for(const root of libraryStore.listRoots())rootWatcher.add(root);
        if(oldPath!==newPath) library.remove(oldPath);
        const read=tags.read(newPath); if(read.ok)library.ingest([newPath],()=>read.tags);
        sendToRenderer('library-updated',{trackCount:library.size,artists:library.listArtists()});
        if(oldPath!==newPath)sendToRenderer('file-moved',{oldPath,newPath});
    },
});

const sendFilePathToWindow = (filePath) => {
    if (!mainWindow) return;
    sendToRenderer('open-file-path', filePath);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
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
            const launch = launchOptions.parseArgs(commandLine,workingDirectory,isOpenableFile,file=>inputFiles.expandFiles([file]));
            if (launch.files.length) {
                if(rendererIsReady)sendToRenderer('launch-files',launch);
                else pendingLaunch={...launch,files:[...pendingLaunch.files,...launch.files]};
            }
        }
    });
}

app.whenReady().then(() => {
    // Order matters: paths must exist before the store is pointed at them, and the
    // store must exist before createWindow() reads the saved geometry from it.
    database.initialize();
    // Import legacy settings before electron-store creates the new config file.
    store = new Store({cwd: paths.getConfigDir()});
    audioInterruptions.configure();
    store.delete('radioPlaying');
    currentLayout = store.get('windowState.layout') === 'vertical' ? 'vertical' : 'horizontal';
    diagnostics = new Diagnostics(path.join(paths.getDataRoot(), 'logs'));
    diagnostics.record('app:start', {version: pkg.version});
    try { remoteCache.prune(path.join(paths.getDataRoot(), 'remote-cache')); }
    catch (error) { console.warn('[cache] Could not prune old audio:', error.message); }
    try { coverCache.prune(path.join(paths.getDataRoot(), 'cover-thumbs')); }
    catch (error) { console.warn('[cache] Could not prune cover art:', error.message); }
    createWindow();
    const savedRoots = libraryStore.listRoots();
    for (const root of savedRoots) rootWatcher.add(root);
    (async () => {
        for (const root of savedRoots) {
            if (!libraryStore.listRoots().some((item) => item.id === root.id)) continue;
            try { await scanRoot(root); }
            catch (error) { console.warn(`[library] Startup scan failed: ${error.message}`); }
        }
        sendToRenderer('library-updated', {trackCount: library.size, artists: library.listArtists()});
    })();

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
    rendererIsReady=true;
    sendToRenderer('set-orientation-class', currentLayout === 'vertical');
    if (pendingLaunch.files.length) {
        // Launched with a file: tell the renderer to play it.
        sendToRenderer('launch-files',pendingLaunch);
    } else {
        // Normal launch: tell the renderer to restore the last session.
        sendToRenderer('restore-state');
    }
    if(pendingLaunch.hidden) mainWindow.hide();
    pendingLaunch={files:[],play:false,enqueue:false,hidden:false};
});

// macOS delivers one open-file event per item; combine a file-manager batch.
let macOpenFiles=[],macOpenTimer;
app.on('open-file',(event,filePath)=>{
    event.preventDefault();if(!isOpenableFile(filePath))return;
    const opened=inputFiles.expandFiles([filePath]);
    if(!rendererIsReady){pendingLaunch.files.push(...opened);return;}
    macOpenFiles.push(...opened);clearTimeout(macOpenTimer);
    macOpenTimer=setTimeout(()=>{
        if(!mainWindow||mainWindow.isDestroyed()){pendingLaunch.files.push(...macOpenFiles);macOpenFiles=[];createWindow();return;}
        sendToRenderer('launch-files',{files:[...new Set(macOpenFiles)]});macOpenFiles=[];
        if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();
    },40);
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
    platformImportAbort?.abort();
    tray.setQuitting(true);
    rootWatcher.close();
    discordPresence.close();
    // Flushes the strip's position before the window is torn down.
    if (store) lyricsOverlay.close(store);
});

app.on('will-quit', () => {
    audioInterruptions.stop();
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
require('./windows/native-popup').registerNativePopup({
    ipcMain, Menu, screen, getWindow: () => mainWindow
});

ipcMain.handle('lyrics-export', async (_event, payload) => {
    try {
        if (!payload || typeof payload.text !== 'string' || !payload.text.trim()) return {error:'No lyrics available'};
        const extension = payload.synced ? 'lrc' : 'txt';
        const name = String(payload.title || 'Lyrics').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 160);
        const result = await dialog.showSaveDialog(mainWindow, {title:'Export Lyrics', defaultPath:`${name}.${extension}`,
            filters:[{name:payload.synced?'Synced Lyrics':'Lyrics Text', extensions:[extension]}]});
        if (result.canceled || !result.filePath) return {canceled:true};
        await fs.promises.writeFile(result.filePath, payload.text, 'utf8');
        return {ok:true};
    } catch (error) { return {error:error.message}; }
});
ipcMain.handle('file-menu-configure', async (_event, enabled) => {
    try {
        if (typeof enabled !== 'boolean') throw new Error('Invalid file menu setting');
        const result = await require('./services/file-menu').configure({enabled,
            command: app.isPackaged ? [process.env.APPIMAGE || process.execPath] : [process.execPath, app.getAppPath()],
            extensions: mediaFormats.openable, home: app.getPath('home'), dataHome: process.env.XDG_DATA_HOME,
            mimeTypes: [...new Set([...pkg.build.linux.mimeTypes, 'audio/*',
                'application/x-mod', 'application/x-s3m', 'application/x-xm', 'application/x-it'])]});
        store.set('fileMenuInstalled', enabled);
        return result;
    } catch (error) { return {error:error.message}; }
});

// NEW: Listen for playback state changes from the renderer
ipcMain.on('playback-state-changed', (_event, state) => {
    remoteCache.protect([state.trackId,state.nextPath]);
    isPlaying = state.isPlaying;
    updateThumbar();
    platformControls.update(state);
    discordPresence.update(state);

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

ipcMain.handle('get-store-value', (_event, key, fallback) => store.get(key, fallback));
ipcMain.on('diagnostic-event', (_event, event, details) => diagnostics?.record(event, details));
ipcMain.handle('diagnostics-export', async () => {
    const selected = await dialog.showSaveDialog(mainWindow, {title: 'Export diagnostics',
        defaultPath: 'rhythm-dock-diagnostics.jsonl', filters: [{name: 'Diagnostics', extensions: ['jsonl']}]});
    if (selected.canceled) return {cancelled: true};
    try { fs.writeFileSync(selected.filePath, diagnostics?.text() || ''); return {ok: true}; }
    catch (error) { return {ok: false, error: error.message}; }
});
ipcMain.on('set-store-value', (_event, key, value) => {
    store.set(key, value);
    if(key==='pauseOnInterruption'||key==='pauseOnSleep')audioInterruptions.configure();
});
ipcMain.handle('audio-interruption-status',()=>audioInterruptions.status());
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

async function cueChaptersFor(filePath) {
    const directory = path.dirname(filePath);
    let names;
    try { names = (await fs.promises.readdir(directory)).filter((name) => /\.cue$/i.test(name)); }
    catch (_) { return []; }
    const stem = path.basename(filePath, path.extname(filePath)).toLocaleLowerCase();
    names.sort((a, b) => Number(path.basename(b, path.extname(b)).toLocaleLowerCase() === stem) -
        Number(path.basename(a, path.extname(a)).toLocaleLowerCase() === stem));
    for (const name of names.slice(0, 12)) {
        const source = path.join(directory, name);
        try {
            if ((await fs.promises.stat(source)).size > 1024 * 1024) continue;
            const result = chapters.parseCue(await fs.promises.readFile(source, 'utf8'), filePath);
            if (result.length) return result;
        } catch (_) { /* Another sidecar may still be readable. */ }
    }
    return [];
}

ipcMain.handle('get-metadata', async (_event, filePath) => {
    if(/^https:\/\//i.test(filePath)){
        const station=store.get('radioStations',[]).find(s=>s.url===filePath);
        if(station)return {filePath,basename:station.title,title:station.title,artist:'Internet radio',album:'',genre:'',cover:null,lyrics:null,isStream:true};
    }
    try {
        const metadata = await mm.parseFile(filePath, {includeChapters: /\.m4b$/i.test(filePath)});
        const {title, artist, album, picture, lyrics, genre} = metadata.common;
        const chapterList = chapters.mp4Chapters(metadata.format);
        if (!chapterList.length && /\.(m4b|m4a|mp4)$/i.test(filePath)) {
            try { chapterList.push(...await chapters.readMp4Chapters(filePath)); }
            catch (_) { /* Metadata remains useful if chapter atoms are damaged. */ }
        }
        if (!chapterList.length) chapterList.push(...await cueChaptersFor(filePath));
        let cover = null;
        if (picture?.[0]) {
            const imageBuffer = Buffer.from(picture[0].data);
            try { cover = coverCache.thumbnail(imageBuffer, path.join(paths.getDataRoot(), 'cover-thumbs')); }
            catch (error) { console.warn('[cover] Could not cache art:', error.message); }
            if (!cover) cover = `data:${picture[0].format};base64,${imageBuffer.toString('base64')}`;
        }
        return {
            filePath,
            basename: path.basename(filePath),
            title: title || path.basename(filePath),
            artist: artist || 'Unknown Artist',
            album: album || '',
            genre: Array.isArray(genre) ? genre.join('; ') : (genre || ''),
            chapters: chapterList,
            cover,
            lyrics: lyrics ? lyrics[0] : null,
            durationSeconds: metadata.format.duration || 0,
            replayGain: readReplayGain(metadata),
            analysis: audioAnalysis.get(filePath)
        };
    } catch (error) {
        console.error("Failed to parse metadata:", error);
        return {
            filePath,
            basename: path.basename(filePath),
            title: path.basename(filePath),
            artist: 'Unknown Artist',
            album: '',
            genre: '',
            chapters: [],
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
            {name: 'Audio, playlists and CUE', extensions: mediaFormats.openable.map(ext => ext.slice(1))},
            {name: 'All Files', extensions: ['*']},
        ],
        properties: ['openFile', 'multiSelections']
    });
    return (canceled || filePaths.length === 0) ? null : inputFiles.expandFiles(filePaths);
});

ipcMain.handle('open-folder', async () => {
    const {canceled, filePaths} = await dialog.showOpenDialog({properties: ['openDirectory']});
    if (canceled || filePaths.length === 0) return null;
    return await scanAndIndex(filePaths[0]);
});

ipcMain.handle('process-dropped-paths', async (_event, droppedPaths) => {
    const {files: inputs, truncated} = await scanner.resolvePaths(droppedPaths, mediaFormats.openable, {
        onProgress: ({found, current}) => sendToRenderer('scan-progress', {found, current}),
    });

    const files = inputFiles.expandFiles(inputs);
    library.ingest(files);
    if (truncated) sendToRenderer('scan-truncated', {count: files.length});
    sendToRenderer('library-updated', {
        trackCount: library.size,
        artists: library.listArtists(),
    });

    return files;
});

function getViewMode() {
    return appFullscreenMode ? 'fullscreen' : edgeDock.active ? 'stick' : currentLayout === 'vertical' ? 'vertical'
        : store.get('horizontalViewMode', 'horizontal');
}
ipcMain.handle('get-view-mode', () => getViewMode());
ipcMain.handle('select-view-mode', (_event, mode) => {
    if (!mainWindow || mainWindow.isDestroyed() || store.get('isLocked', false) ||
        !['horizontal', 'vertical', 'dock', 'stick', 'fullscreen'].includes(mode)) return getViewMode();
    if (mode === 'fullscreen') {
        if (edgeDock.active) setEdgeDock(false);
        appFullscreenMode = true;
        mainWindow.setFullScreen(true);
        return 'fullscreen';
    }
    if (appFullscreenMode) { appFullscreenMode = false; mainWindow.setFullScreen(false); }
    if (mode === 'stick') { setEdgeDock(true); return getViewMode(); }
    if (edgeDock.active) setEdgeDock(false);
    currentLayout = mode === 'vertical' ? 'vertical' : 'horizontal';
    if (mode !== 'vertical') {
        store.set('horizontalViewMode', mode);
        store.set('playerTabHeight', windowState.PRESETS[mode === 'dock' ? 'horizontalCompact' : 'horizontal'].height);
    }
    windowState.applyPreset(mainWindow, mode === 'dock' ? 'horizontalCompact' : currentLayout);
    if (currentTab !== 'player') mainWindow.setSize(mode === 'vertical' ? 340 : 380,
        mode === 'vertical' ? windowState.PRESETS.vertical.height : 420);
    persistWindowState();
    sendToRenderer('set-orientation-class', currentLayout === 'vertical');
    return getViewMode();
});
ipcMain.handle('toggle-orientation', async (_event, isVertical) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (edgeDock.active) return;
    if (appFullscreenMode) { appFullscreenMode = false; mainWindow.setFullScreen(false); }

    currentLayout = isVertical ? 'vertical' : 'horizontal';

    // Snap to the layout preset without re-locking min == max, so the user can still
    // drag the window afterwards.
    windowState.applyPreset(mainWindow, currentLayout);
    if (isVertical && currentTab !== 'player') mainWindow.setSize(340, windowState.PRESETS.vertical.height);
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
    if (appFullscreenMode) return;
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
    if(!Number.isFinite(opacity)||opacity<0.3||opacity>1)return;
    if (mainWindow) {
        mainWindow.setOpacity(opacity);
        store.set('windowOpacity', opacity); // Save for persistence
    }
});
ipcMain.on('preview-opacity',(_event,opacity)=>{
    if(Number.isFinite(opacity)&&opacity>=0.3&&opacity<=1&&mainWindow&&!mainWindow.isDestroyed())mainWindow.setOpacity(opacity);
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
ipcMain.handle('playlist-file-status',async(_event,files)=>{
    if(!Array.isArray(files))return [];
    return Promise.all(files.slice(0,250).filter(file=>typeof file==='string').map(async filePath=>{
        if(/^https?:\/\//i.test(filePath))return {filePath,available:true};
        try{
            await fs.promises.access(filePath,fs.constants.R_OK);
            const stat=await fs.promises.stat(filePath);
            return {filePath,available:stat.isFile()&&stat.size>0};
        }catch(_){return {filePath,available:false};}
    }));
});
ipcMain.handle('library-track-details', async (_event, files) => {
    if (!Array.isArray(files)) return [];
    const stored = database.handle().prepare('SELECT * FROM tracks WHERE filePath IN (SELECT value FROM json_each(?))')
        .all(JSON.stringify(files.filter(file => typeof file === 'string')));
    const details = new Map(stored.map(row => [row.filePath,row]));
    const pending = [...new Set(files.filter(file => typeof file === 'string' && !details.get(file)?.durationSeconds))];
    let index=0;
    await Promise.all(Array.from({length:Math.min(4,pending.length)},async()=>{
        while(index<pending.length){
            const filePath=pending[index++];
            try {
                const parsed=await mm.parseFile(filePath,{skipCovers:true});
                details.set(filePath,{...details.get(filePath),filePath,basename:path.basename(filePath),
                    title:parsed.common.title||path.basename(filePath),artist:parsed.common.artist||'',
                    album:parsed.common.album||'',durationSeconds:parsed.format.duration||0});
            } catch (_) { /* Missing files remain visible through their existing metadata or filename. */ }
        }
    }));
    return [...details.values()];
});
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
            genre: Array.isArray(parsedTags.common?.genre) ? parsedTags.common.genre.join('; ') : null,
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
let scanSequence = Promise.resolve();
function scanRoot(root) {
    const job = scanSequence.catch(() => {}).then(() => performScanRoot(root));
    scanSequence = job.catch(() => {});
    return job;
}

async function performScanRoot(root) {
    if (!libraryStore.listRoots().some((item) => item.id === root.id)) {
        return {seen: 0, added: 0, restored: 0, missing: 0, reparsed: 0, cancelled: true};
    }
    const previous = libraryStore.scanSnapshot(root.id);
    const result = await new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'library', 'scan-worker.js'), {
            workerData: {rootPath: root.path, extensions: SUPPORTED_EXTENSIONS, previous,ffmpeg:store.get('ffmpegPath','')||'ffmpeg'},
        });
        let settled = false;
        worker.on('message', (message) => {
            if (message.type === 'progress') sendToRenderer('scan-progress', message);
            if (message.type === 'metadata-progress') sendToRenderer('scan-metadata-progress', message);
            if (message.type === 'done') {
                settled = true;
                resolve(message);
                worker.terminate();
            }
            if (message.type === 'error') {
                settled = true;
                reject(new Error(message.error));
                worker.terminate();
            }
        });
        worker.on('error', reject);
        worker.on('exit', (code) => { if (!settled) reject(new Error(`Library scan worker exited (${code})`)); });
        activeScanWorker = worker;
    }).finally(() => { activeScanWorker = null; });
    if (result.cancelled) return {seen: 0, added: 0, restored: 0, missing: 0, cancelled: true};
    if (!libraryStore.listRoots().some((item) => item.id === root.id)) {
        return {seen: 0, added: 0, restored: 0, missing: 0, cancelled: true};
    }
    const scannedTags = new Map(result.files.map((file) => [file.filePath, file]));
    library.ingest(result.files.map((file) => file.filePath),
        (filePath) => scannedTags.get(filePath) || {});
    if (result.truncated) sendToRenderer('scan-truncated', {count: result.files.length});
    return {...libraryStore.syncRoot(root.id, result.files, {complete: result.complete}),
        reparsed: result.reparsed, incomplete: !result.complete};
}

let activeScanWorker = null;
ipcMain.handle('library-cancel-scan', () => {
    if (!activeScanWorker) return false;
    activeScanWorker.postMessage('cancel');
    return true;
});

async function importRoomUpload(upload) {
    const client = roomClient;
    diagnostics?.record('room:upload-ready', {role: client?.role, state: Boolean(client?.hostToken),
        code: String(upload.id || '').length, count: upload.size});
    if (!client?.isHost || !client.hostToken || !/^[a-f0-9]{36}$/.test(upload.id)) return;
    const sourceCode = client.roomCode;
    const extension = path.extname(upload.fileName || '').toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(extension) || upload.size > 30 * 1024 * 1024) return;
    const address = `${client.serverUrl}/api/rooms/${encodeURIComponent(client.roomCode)}/uploads/${upload.id}`;
    const headers = {Authorization: `Bearer ${client.hostToken}`};
    const response = await fetch(address, {headers});
    if (!response.ok) throw new Error(`server returned ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== upload.size || bytes.length > 30 * 1024 * 1024) throw new Error('incomplete file');
    if (roomClient !== client || client.roomCode !== sourceCode || !client.isHost || !client.connected)
        throw new Error('The room changed during download.');
    const incomingDir = path.join(paths.getDataRoot(), 'incoming');
    fs.mkdirSync(incomingDir, {recursive: true});
    const filePath = path.join(incomingDir, `${upload.id}${extension}`);
    try { await fs.promises.writeFile(filePath, bytes, {flag: 'wx'}); }
    catch (error) {
        if (error.code !== 'EEXIST' || !fs.readFileSync(filePath).equals(bytes)) throw error;
    }
    try {
        const root = libraryStore.addRoot(incomingDir);
        await scanRoot(root);
        if (roomClient !== client || client.roomCode !== sourceCode || !client.isHost || !client.connected)
            throw new Error('The room changed during import.');
        sendToRenderer('room:incoming-track', {filePath, position: upload.position || 'end'});
        await fetch(address, {method: 'DELETE', headers});
    } catch (error) {
        throw error;
    }
}

ipcMain.handle('library-roots', () => libraryStore.listRoots());
ipcMain.handle('midi-tools-pick', async (_event, kind) => {
    if (!['synth','soundfont'].includes(kind)) return {ok:false,error:'Unknown MIDI setting.'};
    const picked = await dialog.showOpenDialog(mainWindow, {
        title:kind==='synth'?'Choose FluidSynth executable':'Choose MIDI SoundFont',properties:['openFile'],
        filters:kind==='soundfont'?[{name:'SoundFont',extensions:['sf2','sf3']}]:
            process.platform==='win32'?[{name:'Executable',extensions:['exe']}]:[]});
    if (picked.canceled || !picked.filePaths.length) return {cancelled:true};
    const file = picked.filePaths[0];
    try {
        if (kind==='synth') await mediaTools.run(file,['--version'],{timeoutMs:5000});
        else {
            const fd=await fs.promises.open(file,'r');
            try {
                const header=Buffer.alloc(12);await fd.read(header,0,12,0);
                if(header.toString('ascii',0,4)!=='RIFF'||header.toString('ascii',8,12)!=='sfbk')
                    throw new Error('Choose a valid SF2 or SF3 SoundFont.');
            } finally {await fd.close();}
        }
        store.set(kind==='synth'?'fluidsynthPath':'midiSoundfont',file);
        return {ok:true,name:path.basename(file)};
    } catch(error){return {ok:false,error:error.message};}
});
ipcMain.handle('midi-tools-check', async () => {
    try {
        const font=store.get('midiSoundfont','');
        if (!font || !fs.existsSync(font)) throw new Error('Choose a SoundFont before playing MIDI files.');
        await mediaTools.run(store.get('fluidsynthPath','')||'fluidsynth',['--version'],{timeoutMs:5000});
        return {ok:true,name:path.basename(font)};
    } catch(error){return {ok:false,error:error.message};}
});
ipcMain.handle('lyrics-import-file', async () => {
    const picked=await dialog.showOpenDialog(mainWindow,{title:'Import lyrics',properties:['openFile'],
        filters:[{name:'Lyrics',extensions:['lrc','txt']}]});
    if(picked.canceled||!picked.filePaths.length)return {cancelled:true};
    try {
        const file=picked.filePaths[0];
        if((await fs.promises.stat(file)).size>2*1024*1024)throw new Error('Lyrics file exceeds 2 MB.');
        return {ok:true,text:(await fs.promises.readFile(file,'utf8')).replace(/^\uFEFF/,'')};
    }catch(error){return {ok:false,error:error.message};}
});

ipcMain.handle('media-tools-pick', async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {title: 'Choose FFmpeg executable',
        properties: ['openFile'], filters: process.platform === 'win32' ? [{name: 'Executable', extensions: ['exe']}] : []});
    if (picked.canceled) return {cancelled: true};
    const executable = picked.filePaths[0];
    try {
        await mediaTools.run(executable, ['-version'], {timeoutMs: 5000});
        store.set('ffmpegPath', executable);
        return {ok: true};
    } catch (error) { return {ok: false, error: error.message}; }
});
ipcMain.handle('media-tools-check', async () => {
    try {
        const result = await mediaTools.run(store.get('ffmpegPath', '') || 'ffmpeg', ['-version'], {timeoutMs: 5000});
        return {ok: true, version: result.stdout.split(/\r?\n/)[0]};
    } catch (error) { return {ok: false, error: error.message}; }
});
ipcMain.handle('media-tools-cancel', () => { mediaOperation?.abort(); return true; });
ipcMain.handle('media-prepare', (_event, filePath) => withMediaOperation(async (options) => {
    const result = await mediaTools.prepare(filePath, path.join(paths.getDataRoot(), 'decoded-cache'), {...options,
        fluidsynth:store.get('fluidsynthPath',''),soundfont:store.get('midiSoundfont','')});
    // Update the relay before playback publishes new state, so guests receive
    // decoded bytes before the next catalog snapshot arrives.
    if (roomClient?.isHost) for (const [id, source] of roomClient.trackSources) {
        if (source === filePath) roomClient.trackPaths.set(id, result.filePath);
    }
    return result;
}));
ipcMain.handle('media-analyse', (_event, files) => withMediaOperation(async (options) => {
    const unique = [...new Set(Array.isArray(files) ? files : [])].slice(0, 500);
    if (!unique.length) throw new Error('Choose a song or queue to analyse.');
    const results = [];
    for (let index = 0; index < unique.length; index++) {
        const filePath = unique[index];
        sendToRenderer('media-tools-progress', {index: index + 1, total: unique.length});
        const before = fs.statSync(filePath);
        const measurement = await mediaTools.analyse(filePath, options);
        const after = fs.statSync(filePath);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
            throw new Error('The file changed during analysis. Please analyse it again.');
        audioAnalysis.save(filePath, measurement);
        results.push({filePath, ...measurement});
    }
    return {results};
}));
ipcMain.handle('media-analyse-album', (_event, filePath) => withMediaOperation(async (options) => {
    const tags = (await mm.parseFile(filePath, {skipCovers: true})).common;
    if (!tags.album) throw new Error('This song has no album tag. Add album tags and a library folder first.');
    const files = libraryStore.roomCatalog().filter((track) => track.album === tags.album && track.artist === tags.artist)
        .map((track) => track.filePath);
    if (files.length < 2) throw new Error('Add the album folder to the library before analysing its tracks together.');
    const before = files.map((file) => fs.statSync(file));
    for (const file of files) if (!audioAnalysis.get(file)) audioAnalysis.save(file, await mediaTools.analyse(file, options));
    const measurement = await mediaTools.analyseAlbum(files, options);
    if (files.some((file, index) => { const stat = fs.statSync(file);
        return stat.size !== before[index].size || stat.mtimeMs !== before[index].mtimeMs; }))
        throw new Error('An album file changed during analysis. Please analyse it again.');
    audioAnalysis.saveAlbum(files, measurement);
    return {measurement, analysis: audioAnalysis.get(filePath)};
}));
ipcMain.handle('media-export', async (_event, {filePath, start = 0, end = null, extension = '.flac'} = {}) => {
    if (!['.wav', '.flac', '.mp3', '.m4a', '.ogg'].includes(extension)) return {ok: false, error: 'Unsupported output format.'};
    const selected = await dialog.showSaveDialog(mainWindow, {title: 'Export audio to a new file',
        defaultPath: `${path.basename(filePath, path.extname(filePath))}-export${extension}`,
        filters: [{name: 'Audio', extensions: [extension.slice(1)]}]});
    if (selected.canceled) return {cancelled: true};
    return withMediaOperation((options) => mediaTools.convert(filePath, selected.filePath, {start, end, ...options}));
});

ipcMain.handle('timeline-export',async (_event,options={})=>{
    try {
        const extension=['.wav','.flac','.mp3','.m4a','.ogg'].includes(options.extension)?options.extension:'.flac';
        const picked=await dialog.showSaveDialog(mainWindow,{defaultPath:path.basename(options.filePath,path.extname(options.filePath))+'-edit'+extension,
            filters:[{name:'Audio',extensions:[extension.slice(1)]}]});
        if(picked.canceled)return {ok:true,canceled:true};
        return withMediaOperation(settings=>require('./services/timeline').exportTimeline({...options,targetPath:picked.filePath},settings));
    }catch(error){return {ok:false,error:error.message};}
});
ipcMain.handle('media-chapter-tracks', (_event, filePath) => withMediaOperation(async (options) => {
    const parsed = await mm.parseFile(filePath, {includeChapters: true});
    const list = chapters.mp4Chapters(parsed.format);
    if (!list.length && /\.(m4b|m4a|mp4)$/i.test(filePath)) list.push(...await chapters.readMp4Chapters(filePath));
    if (!list.length) list.push(...await cueChaptersFor(filePath));
    if (list.length < 2) throw new Error('No chapter list or matching CUE sheet was found.');
    const stat = fs.statSync(filePath);
    const crypto = require('node:crypto');
    const root = path.join(paths.getDataRoot(), 'chapter-cache');
    fs.mkdirSync(root, {recursive: true});
    const files = [];
    for (let index = 0; index < Math.min(list.length, 200); index++) {
        const chapter = list[index];
        const end = list[index + 1]?.start ?? parsed.format.duration;
        if (!Number.isFinite(end) || end <= chapter.start) continue;
        const key = crypto.createHash('sha256').update(JSON.stringify([filePath, stat.size, stat.mtimeMs, chapter, end])).digest('hex');
        const target = path.join(root, `${String(index + 1).padStart(3, '0')}-${key}.flac`);
        sendToRenderer('media-tools-progress', {index: index + 1, total: list.length});
        if (!fs.existsSync(target)) await mediaTools.convert(filePath, target, {...options,
            start: chapter.start, end, tags: {title: chapter.title,
                artist: parsed.common.artist, album: parsed.common.album}});
        files.push(target);
    }
    mediaTools.pruneCache(root, files);
    return {files};
}));
ipcMain.handle('library-stats', () => libraryStore.stats());
ipcMain.handle('library-view', (_event, view, limit) => libraryStore.view(view, limit));
ipcMain.handle('library-recommendations', (_event, options) => libraryStore.recommendations(options || {}));
ipcMain.handle('library-preferences', () => libraryStore.preferences());
ipcMain.handle('library-preference-set', (_event, filePath, preference) => libraryStore.setPreference(filePath, preference));
ipcMain.handle('library-preferences-reset', () => {
    database.handle().prepare('DELETE FROM track_preferences').run();
    store.set('hiddenRecommendations', []); return true;
});
ipcMain.handle('library-album-recommendations', (_event, options) => libraryStore.albumRecommendations(options || {}));
ipcMain.handle('library-set-rating', (_event, filePath, rating) => libraryStore.setRating(filePath, rating));
ipcMain.handle('book-position-get', (_event, filePath) => libraryStore.getBookPosition(filePath));
ipcMain.handle('book-position-set', (_event, filePath, seconds) => libraryStore.setBookPosition(filePath, seconds));
let remoteImports = 0;
const platformAudio = require('./services/platform-audio');
let platformImportAbort = null;
function linkTools() {return {ytdlp:store.get('ytDlpPath',''),spotdl:store.get('spotdlPath',''),ffmpeg:store.get('ffmpegPath','')};}
ipcMain.handle('link-tool-pick',async(_event,tool)=>{
    const key={ytdlp:'ytDlpPath',spotdl:'spotdlPath'}[tool];
    if(!key)return {error:'Unknown link tool'};
    const picked=await dialog.showOpenDialog(mainWindow,{title:`Choose ${tool}`,properties:['openFile']});
    if(picked.canceled)return {canceled:true};
    store.set(key,picked.filePaths[0]);return {ok:true};
});
ipcMain.handle('link-tools-check',async()=>{
    const tools=linkTools(),results=[];
    for(const [name,executable,args] of [['yt-dlp',tools.ytdlp||'yt-dlp',['--version']],
        ['spotDL',tools.spotdl||'spotdl',['--version']],['FFmpeg',tools.ffmpeg||'ffmpeg',['-version']],['Deno','deno',['--version']]]){
        try {await platformAudio.run(executable,args,{timeoutMs:15000});results.push(`${name}: ready`);}
        catch(_){results.push(`${name}: missing or could not start`);}
    }
    return {message:results.join(' · ')};
});
ipcMain.handle('remote-audio-cancel',()=>{platformImportAbort?.abort();return {ok:true};});
ipcMain.handle('remote-audio-download',async(_event,filePath)=>{
    try {
        const input=platformAudio.cachedFile(filePath,['remote-cache','platform-cache'].map(name=>path.join(paths.getDataRoot(),name)));
        const result=await dialog.showSaveDialog(mainWindow,{title:'Download MP3',
            defaultPath:path.join(app.getPath('downloads'),`${path.basename(input,path.extname(input))}.mp3`),
            filters:[{name:'MP3 Audio',extensions:['mp3']}]});
        if(result.canceled||!result.filePath)return {canceled:true};
        if(path.resolve(input)===path.resolve(result.filePath))throw new Error('Choose a destination outside the temporary cache.');
        if(path.extname(input).toLowerCase()==='.mp3')await fs.promises.copyFile(input,result.filePath);
        else await mediaTools.convert(input,result.filePath,{executable:linkTools().ffmpeg});
        return {ok:true,filePath:result.filePath};
    }catch(error){return {error:error.message};}
});
async function importRemoteAudio(url) {
    if (remoteImports >= 3) return {ok: false, error: 'Three link imports are already running. Try again shortly.'};
    remoteImports++;
    let controller;
    try {
        if(platformImportAbort)throw new Error('A link is already downloading. Wait or cancel it first.');
        controller=new AbortController();platformImportAbort=controller;
        const cacheRoot = path.join(paths.getDataRoot(), 'remote-cache');
        let result;
        if(platformAudio.source(url)){
            result=await platformAudio.download(url,path.join(paths.getDataRoot(),'platform-cache'),{
                tools:linkTools(),signal:controller.signal,onProgress:progress=>sendToRenderer('remote-audio-progress',progress)});}
        else result = await remotePlaylist.download(url, cacheRoot, (resource,options)=>fetch(resource,{...options,signal:controller.signal}), (progress) =>
            sendToRenderer('remote-audio-progress', progress));
        if(controller.signal.aborted)throw new Error('Link download cancelled.');
        library.ingest(result.files);
        return {ok: true, ...result, filePath: result.files[0]};
    } catch (error) { return {ok: false, error: error.message}; }
    finally { remoteImports--; if(platformImportAbort===controller)platformImportAbort=null; }
}
ipcMain.handle('remote-audio-add', (_event, url) => importRemoteAudio(url));
ipcMain.handle('remote-audio-save', async (_event, filePath) => {
    try {
        const roots=['remote-cache','platform-cache'].map(name=>path.join(paths.getDataRoot(),name));
        platformAudio.cachedFile(filePath,roots);
        const cacheRoot = roots.find(root=>{const relative=path.relative(root,filePath);return relative&&!relative.startsWith('..')&&!path.isAbsolute(relative);});
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
ipcMain.handle('playlist-import-file', async () => {
    const picked = await dialog.showOpenDialog(mainWindow, {title: 'Import playlist',
        properties: ['openFile'], filters: [{name: 'Playlists', extensions: ['m3u', 'm3u8', 'pls', 'xspf']}]});
    if (picked.canceled || !picked.filePaths.length) return {cancelled: true};
    const source = picked.filePaths[0];
    try {
        if ((await fs.promises.stat(source)).size > 5 * 1024 * 1024) throw new Error('Playlist file is too large.');
        const paths = playlistFormats.parse(await fs.promises.readFile(source, 'utf8'),
            path.extname(source).toLowerCase(), path.dirname(source))
            .filter((filePath) => fs.existsSync(filePath));
        if (!paths.length) return {ok: false, error: 'No supported local songs were found in that playlist.'};
        const created = libraryStore.createPlaylist(path.basename(source, path.extname(source)), paths);
        return {...created, count: paths.length};
    } catch (error) { return {ok: false, error: error.message}; }
});
ipcMain.handle('playlist-export-file', async (_event, id) => {
    const item = libraryStore.listPlaylists().find((playlist) => playlist.id === Number(id));
    if (!item) return {ok: false, error: 'Choose a playlist first.'};
    const picked = await dialog.showSaveDialog(mainWindow, {title: 'Export playlist',
        defaultPath: `${item.name}.m3u8`, filters: [
            {name: 'M3U', extensions: ['m3u8']}, {name: 'PLS', extensions: ['pls']},
            {name: 'XSPF', extensions: ['xspf']},
        ]});
    if (picked.canceled || !picked.filePath) return {cancelled: true};
    try {
        const filePaths = libraryStore.playlistTracks(id).map((track) => track.filePath);
        const content = playlistFormats.serialize(filePaths, path.extname(picked.filePath).toLowerCase(),
            path.dirname(picked.filePath));
        await fs.promises.writeFile(picked.filePath, content, 'utf8');
        return {ok: true, count: filePaths.length};
    } catch (error) { return {ok: false, error: error.message}; }
});

ipcMain.handle('library-add-root', async () => {
    const {canceled, filePaths} = await dialog.showOpenDialog({properties: ['openDirectory']});
    if (canceled || filePaths.length === 0) return null;

    const root = libraryStore.addRoot(filePaths[0]);
    if (!root) return null;

    const result = await scanRoot(root);
    rootWatcher.add(root);
    sendToRenderer('library-updated', {
        trackCount: library.size,
        artists: library.listArtists(),
    });
    sendToRenderer('scan-complete', {
        total: result.seen,
        reparsed: result.reparsed,
        missing: result.missing,
    });
    return {root, ...result};
});

ipcMain.handle('library-remove-root', (_event, rootId) => {
    const removed = libraryStore.removeRoot(rootId);
    if (removed) rootWatcher.remove(rootId);
    return removed;
});

/** Rescans one root, or every root when `rootId` is null. */
ipcMain.handle('library-rescan', async (_event, rootId) => {
    const roots = libraryStore.listRoots()
        .filter((root) => rootId == null || root.id === rootId);

    const totals = {seen: 0, added: 0, restored: 0, missing: 0, reparsed: 0};
    for (const root of roots) {
        // Sequential on purpose: two concurrent scans of a spinning disk or a network
        // share are slower than one, and they interleave their progress events.
        const result = await scanRoot(root);
        if (result.cancelled) { totals.cancelled = true; break; }
        for (const key of Object.keys(totals)) totals[key] += result[key];
    }

    sendToRenderer('library-updated', {
        trackCount: library.size,
        artists: library.listArtists(),
    });
    sendToRenderer('scan-complete', {
        total: totals.seen,
        reparsed: totals.reparsed,
        missing: totals.missing,
    });
    return totals;
});

ipcMain.handle('library-recheck-missing', () => libraryStore.recheckMissing());

async function submitListen(filePath,listenedMs,startedAt) {
    if(!roadmap.scrobbler.hasEnabled())return;
    try {
        let track=database.handle()?.prepare('SELECT * FROM tracks WHERE filePath=?').get(filePath);
        if(!track){const parsed=await mm.parseFile(filePath,{skipCovers:true});track={artist:parsed.common.artist,title:parsed.common.title,
            album:parsed.common.album,durationSeconds:parsed.format.duration};}
        roadmap.scrobbler.enqueue({...track,duration:track.durationSeconds,listenedMs,startedAt});
    }catch(_){/* Missing files and streams cannot provide a local-tag scrobble. */}
}
ipcMain.on('library-record-play', (_event, filePath, listenedMs, startedAt) => {
    libraryStore.recordPlay(filePath, listenedMs);
    require('./services/library-tools').record(filePath,listenedMs,'play');
    submitListen(filePath,listenedMs,startedAt);
});

ipcMain.on('library-record-skip', (_event, filePath, listenedMs, startedAt) => {
    libraryStore.recordSkip(filePath, listenedMs);
    require('./services/library-tools').record(filePath,listenedMs,'skip');
    submitListen(filePath,listenedMs,startedAt);
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

function savedHostedRoom() {
    try {const encrypted=store.get('hostedRoomCredential','');return encrypted?
        JSON.parse(safeStorage.decryptString(Buffer.from(encrypted,'base64'))):null;}catch(_){return null;}
}
ipcMain.handle('room-saved-host',()=>{
    const saved=savedHostedRoom();return saved?{code:saved.code,serverUrl:saved.serverUrl,name:saved.name}:null;
});
ipcMain.handle('room-resume-host',async()=>{
    if(store.get('radioPlaying',false))return {ok:false,error:'Open a local song before hosting a shared room.'};
    try {const saved=savedHostedRoom();if(!saved)throw new Error('No saved hosted room is available.');
        const room=await getRoomClient().resumeRoom(saved);return {ok:true,room};
    }catch(error){return {ok:false,error:error.message};}
});

ipcMain.handle('room-create', async (_event, options) => {
    if(store.get('radioPlaying',false))return {ok:false,error:'Open a local song before hosting a shared room.'};
    try {
        const room = await getRoomClient().createRoom(options.serverUrl, options);
        let resumeSaved=false;
        if(safeStorage.isEncryptionAvailable()&&safeStorage.getSelectedStorageBackend?.()!=='basic_text') {
            try {store.set('hostedRoomCredential',safeStorage.encryptString(JSON.stringify({serverUrl:roomClient.serverUrl,
                code:room.code,hostToken:room.hostToken,password:options.password||'',name:options.name||'Host'})).toString('base64'));resumeSaved=true;}
            catch(_){store.delete('hostedRoomCredential');}
        }else store.delete('hostedRoomCredential');
        return {ok: true, room, resumeSaved};
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
    store.delete('hostedRoomCredential');
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
    for (const [id, filePath] of roomClient.trackSources) map[filePath] = id;
    sendToRenderer('room:track-ids', map);
});
ipcMain.on('room-publish-lyrics', (_e, payload) => roomClient?.publishLyrics(payload || {}));
ipcMain.on('room-publish-settings', (_e, settings) => roomClient?.publishSettings(settings));
ipcMain.on('room-control', (_e, {action, value}) => roomClient?.sendControl(action, value));
ipcMain.on('room-set-role', (_e, {memberId, role}) => roomClient?.setMemberRole(memberId, role));
ipcMain.on('room-kick', (_e, {memberId}) => roomClient?.kickMember(memberId));

ipcMain.handle('set-active-tab', (_event, tab) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (!['player', 'playlist', 'settings', 'tags'].includes(tab)) return false;
    const previousTab = currentTab;
    currentTab = tab;
    if (appFullscreenMode) return true;
    if (edgeDock.active) {
        expandEdgeDock(true);
        return true;
    }
    if (currentLayout === 'vertical') {
        const bounds = mainWindow.getBounds();
        mainWindow.setBounds({...bounds, width: tab === 'player' ? windowState.PRESETS.vertical.width : 340,
            height: Math.max(bounds.height, windowState.PRESETS.vertical.height)}, true);
        return true;
    }

    const bounds = mainWindow.getBounds();
    const targetHeight = tab === 'player'
        ? store.get('playerTabHeight', windowState.PRESETS.horizontal.height) : 420;

    // Remember the player height so a user who resized the dock keeps their size.
    if (tab !== 'player' && previousTab === 'player') {
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
