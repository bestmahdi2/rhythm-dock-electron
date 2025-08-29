const {app, BrowserWindow, ipcMain, dialog, globalShortcut, clipboard, shell, screen} = require('electron');
const path = require('path');
const fs = require('fs');
const mm = require('music-metadata');
const Store = require('electron-store');
const Database = require('better-sqlite3');
const pkg = require('../package.json');

Store.initRenderer();
const store = new Store();

let mainWindow;
let db;
let currentLayout = 'horizontal';
let lastHorizontalHeight = 180;

const dbPath = app.isPackaged
    ? path.join(app.getPath('userData'), 'lyrics.db')
    : path.join(__dirname, '..', 'lyrics.db'); // In dev, creates lyrics.db in your project root

// --- Thumbar Buttons (Taskbar Media Controls) ---
// We define these here so we can update them easily.
let playPauseButton, prevButton, nextButton;
let thumbarButtons;
let isPlaying = false; // Keep track of playback state in main process

// development and in a packaged (asar) application.
const assetsPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'assets', 'images')
    : path.join(__dirname, 'assets', 'images');

const ICONS = {
    play: path.join(assetsPath, 'play.png'),
    pause: path.join(assetsPath, 'pause.png'),
    next: path.join(assetsPath, 'next.png'),
    prev: path.join(assetsPath, 'prev.png'),
};

function initializeDatabase() {
    db = new Database(dbPath);

    const createTableStmt = `
        CREATE TABLE IF NOT EXISTS lyrics
        (
            songKey
            TEXT
            PRIMARY
            KEY,
            lyricsText
            TEXT
            NOT
            NULL,
            lastUpdated
            TEXT
            NOT
            NULL
        );
    `;
    db.exec(createTableStmt);
}

function updateThumbar() {
    if (!mainWindow || process.platform !== 'win32') return;

    playPauseButton = {
        tooltip: isPlaying ? 'Pause' : 'Play',
        icon: isPlaying ? ICONS.pause : ICONS.play,
        click: () => sendToRenderer('media-key-event', 'play-pause'),
    };

    prevButton = {
        tooltip: 'Previous', icon: ICONS.prev, click: () => sendToRenderer('media-key-event', 'prev'),
    };

    nextButton = {
        tooltip: 'Next', icon: ICONS.next, click: () => sendToRenderer('media-key-event', 'next'),
    };

    thumbarButtons = [prevButton, playPauseButton, nextButton];
    mainWindow.setThumbarButtons(thumbarButtons);
}

const createWindow = () => {
    // Get the last saved position
    const lastPosition = store.get('lastWindowPosition');
    let validatedPosition = {}; // Start with an empty object

    // --- NEW: Validate the saved position to ensure it's on a visible screen ---
    if (lastPosition) {
        const displays = screen.getAllDisplays();
        const externalDisplay = displays.find((d) => {
            // Check if the saved position is within the bounds of any available display
            return (
                lastPosition.x >= d.bounds.x &&
                lastPosition.x < d.bounds.x + d.bounds.width &&
                lastPosition.y >= d.bounds.y &&
                lastPosition.y < d.bounds.y + d.bounds.height
            );
        });

        // If a display was found containing the position, use it.
        if (externalDisplay) {
            validatedPosition = lastPosition;
        }
    }
    // If no valid position was found, validatedPosition remains empty,
    // and Electron will center the window by default.
    // --- END of validation logic ---

    mainWindow = new BrowserWindow({
        width: 380,
        height: 180,
        // Use the validated position. If the properties don't exist, they are ignored.
        x: validatedPosition.x,
        y: validatedPosition.y,
        useContentSize: true,
        resizable: true,
        frame: false,
        transparent: true,
        alwaysOnTop: store.get('isPinned', false),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    const [initialWidth, initialHeight] = mainWindow.getSize();
    mainWindow.setMinimumSize(initialWidth, initialHeight);
    mainWindow.setMaximumSize(initialWidth, initialHeight);

    // --- AUTOMATIC RESIZE FOR DEVTOOLS ---
    let originalSize;

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

    // Save the window's position before it closes
    mainWindow.on('close', () => {
        const [x, y] = mainWindow.getPosition();
        store.set('lastWindowPosition', {x, y});
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
    // On Windows, the second argument is often the file path.
    // We check if it's not another switch (like --inspect) and if it exists.
    // The first arg is the app path, so we look at the second (index 1).
    if (argv.length >= 2 && !argv[1].startsWith('--')) {
        return argv[1];
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
                // Send the file path to the renderer process to be played
                mainWindow.webContents.send('play-file-on-open', filePath);
            }
        }
    });
}

app.whenReady().then(() => {
    initializeDatabase();
    createWindow();

    globalShortcut.register('MediaPlayPause', () => sendToRenderer('media-key-event', 'play-pause'));
    globalShortcut.register('MediaNextTrack', () => sendToRenderer('media-key-event', 'next'));
    globalShortcut.register('MediaPreviousTrack', () => sendToRenderer('media-key-event', 'prev'));

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    // Handle opening file on startup (Windows/Linux)
    const filePath = process.argv.length >= 2 ? process.argv[process.argv.length - 1] : null;
    if (filePath && fs.existsSync(filePath) && path.resolve(filePath) !== path.resolve(process.execPath)) {
        mainWindow.once('ready-to-show', () => {
            sendFilePathToWindow(filePath);
        });
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

async function scanDirectory(dirPath) {
    try {
        const files = await fs.promises.readdir(dirPath);
        const audioFiles = files.filter(file => {
            const ext = path.extname(file).toLowerCase();
            return ['.mp3', '.wav', '.flac', '.m4a', '.mp4'].includes(ext);
        }).map(file => path.join(dirPath, file));
        return audioFiles;
    } catch (error) {
        console.error(`Error scanning directory ${dirPath}:`, error);
        return [];
    }
}

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// --- IPC Handlers ---

// NEW: Listen for playback state changes from the renderer
ipcMain.on('playback-state-changed', (_event, state) => {
    isPlaying = state.isPlaying;
    updateThumbar(); // Update the taskbar buttons
});

ipcMain.handle('get-lyrics', (_event, songKey) => {
    if (!db) return null;
    try {
        const stmt = db.prepare('SELECT lyricsText FROM lyrics WHERE songKey = ?');
        const row = stmt.get(songKey);
        return row ? row.lyricsText : null;
    } catch (error) {
        console.error('Failed to get lyrics from DB:', error);
        return null;
    }
});

ipcMain.on('save-lyrics', (_event, songKey, lyricsText) => {
    if (!db) return;
    try {
        const stmt = db.prepare('INSERT OR REPLACE INTO lyrics (songKey, lyricsText, lastUpdated) VALUES (?, ?, datetime(\'now\'))');
        stmt.run(songKey, lyricsText);
    } catch (error) {
        console.error('Failed to save lyrics to DB:', error);
    }
});

ipcMain.handle('get-store-value', (_event, key) => store.get(key));
ipcMain.on('set-store-value', (_event, key, value) => store.set(key, value));
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
            lyrics: lyrics ? lyrics[0] : null
        };
    } catch (error) {
        console.error("Failed to parse metadata:", error);
        return {
            filePath,
            basename: path.basename(filePath),
            title: path.basename(filePath),
            artist: 'Unknown Artist',
            cover: null,
            lyrics: null
        };
    }
});

ipcMain.handle('open-files', async () => {
    const {canceled, filePaths} = await dialog.showOpenDialog({
        filters: [{name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a', 'mp4']}],
        properties: ['openFile', 'multiSelections']
    });
    return (canceled || filePaths.length === 0) ? null : filePaths;
});

ipcMain.handle('open-folder', async () => {
    const {canceled, filePaths} = await dialog.showOpenDialog({properties: ['openDirectory']});
    if (canceled || filePaths.length === 0) return null;
    return await scanDirectory(filePaths[0]);
});

ipcMain.handle('process-dropped-paths', async (_event, droppedPaths) => {
    const allAudioFiles = [];

    for (const droppedPath of droppedPaths) {
        try {
            const stats = fs.statSync(droppedPath);
            if (stats.isDirectory()) {
                const filesInDir = await scanDirectory(droppedPath);
                allAudioFiles.push(...filesInDir);
            } else if (stats.isFile()) {
                const ext = path.extname(droppedPath).toLowerCase();
                if (['.mp3', '.wav', '.flac', '.m4a', '.mp4'].includes(ext)) {
                    allAudioFiles.push(droppedPath);
                }
            }
        } catch (error) {
            console.error(`Error processing path ${droppedPath}:`, error);
        }
    }
    return allAudioFiles;
});

ipcMain.handle('toggle-orientation', async (_event, isVertical) => {
    if (!mainWindow) return;

    currentLayout = isVertical ? 'vertical' : 'horizontal';

    const HORIZONTAL_WIDTH = 380;
    const VERTICAL_SIZE = { width: 105, height: 420 };

    const newWidth = isVertical ? VERTICAL_SIZE.width : HORIZONTAL_WIDTH;
    const newHeight = isVertical ? VERTICAL_SIZE.height : lastHorizontalHeight;

    // Update the size lock first
    mainWindow.setMinimumSize(newWidth, newHeight);
    mainWindow.setMaximumSize(newWidth, newHeight);

    // Then set the size
    mainWindow.setSize(newWidth, newHeight, true);

    sendToRenderer('set-orientation-class', isVertical);
});

ipcMain.on('toggle-lyrics-visibility', (_event, isVisible) => {
    if (!mainWindow) return;

    const HEIGHT_WITH_LYRICS = 180;
    const HEIGHT_WITHOUT_LYRICS = 122;

    if (currentLayout === 'horizontal') {
        const HORIZONTAL_WIDTH = 380;
        const newHeight = isVisible ? HEIGHT_WITH_LYRICS : HEIGHT_WITHOUT_LYRICS;

        lastHorizontalHeight = newHeight;

        // Update the size lock first
        mainWindow.setMinimumSize(HORIZONTAL_WIDTH, newHeight);
        mainWindow.setMaximumSize(HORIZONTAL_WIDTH, newHeight);

        // Then set the size
        mainWindow.setSize(HORIZONTAL_WIDTH, newHeight, true);
    }
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