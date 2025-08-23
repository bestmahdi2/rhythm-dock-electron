const {app, BrowserWindow, ipcMain, dialog, globalShortcut, clipboard, shell} = require('electron');
const path = require('path');
const fs = require('fs');
const mm = require('music-metadata');
const Store = require('electron-store');
const Database = require('better-sqlite3');

Store.initRenderer();
const store = new Store();

let mainWindow;
let db;

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
    mainWindow = new BrowserWindow({
        width: 380,
        height: 180,
        useContentSize: true,
        resizable: false,
        frame: false,
        transparent: true,
        alwaysOnTop: store.get('isPinned', true), // Load pinned state
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
        },
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

// --- Single Instance Lock ---
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine) => {
        if (mainWindow) {
            const filePath = commandLine.pop();
            if (filePath && fs.existsSync(filePath)) {
                sendFilePathToWindow(filePath);
            } else {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.focus();
            }
        }
    });

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
}

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

    // 1. Get the current state from the renderer before changing anything
    const state = await mainWindow.webContents.executeJavaScript('window.getCurrentAppState()', true);

    // 2. Determine the new HTML file to load
    const newHtmlPath = isVertical
        ? path.join(__dirname, 'renderer/index_vertical.html')
        : path.join(__dirname, 'renderer/index.html');

    // 3. Load the new HTML file
    await mainWindow.loadFile(newHtmlPath);

    // 4. After the new page is ready, resize the window and send the state back
    const HORIZONTAL_SIZE = {width: 380, height: 180};
    const VERTICAL_SIZE = {width: 105, height: 420};
    const newSize = isVertical ? VERTICAL_SIZE : HORIZONTAL_SIZE;

    // Use a 'ready-to-show' listener to avoid flashes of unstyled content
    mainWindow.once('ready-to-show', () => {
        mainWindow.setSize(newSize.width, newSize.height, true); // Animate the resize
        sendToRenderer('restore-state', state); // Restore the player state
        mainWindow.show();
    });
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