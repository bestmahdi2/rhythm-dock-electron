const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('api', {
    // Renderer to Main
    sendPlaybackState: (state) => ipcRenderer.send('playback-state-changed', state), // <-- ADD THIS LINE
    getMetadata: (filePath) => ipcRenderer.invoke('get-metadata', filePath),
    openFiles: () => ipcRenderer.invoke('open-files'),
    openFolder: () => ipcRenderer.invoke('open-folder'),
    processDroppedPaths: (paths) => ipcRenderer.invoke('process-dropped-paths', paths),
    copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
    copyFileToClipboard: (filePath) => ipcRenderer.invoke('copy-file-to-clipboard', filePath),
    showFileInFolder: (filePath) => ipcRenderer.invoke('show-file-in-folder', filePath),
    toggleOrientation: (isVertical) => ipcRenderer.invoke('toggle-orientation', isVertical),
    pinWindow: () => ipcRenderer.invoke('pin-window'),
    minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
    closeWindow: () => ipcRenderer.invoke('close-window'),
    getStoreValue: (key) => ipcRenderer.invoke('get-store-value', key),
    setStoreValue: (key, value) => ipcRenderer.send('set-store-value', key, value),
    getLyrics: (songKey) => ipcRenderer.invoke('get-lyrics', songKey),
    saveLyrics: (songKey, lyricsText) => ipcRenderer.send('save-lyrics', songKey, lyricsText),

    // Main to Renderer
    onFilePathReceived: (callback) => ipcRenderer.on('open-file-path', (_event, filePath) => callback(filePath)),
    onMediaKey: (callback) => ipcRenderer.on('media-key-event', (_event, command) => callback(command)),

    onRestoreState: (callback) => ipcRenderer.on('restore-state', (_event, state) => callback(state)),
});