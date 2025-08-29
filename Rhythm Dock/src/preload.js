const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('api', {
    // Renderer to Main
    sendPlaybackState: (state) => ipcRenderer.send('playback-state-changed', state), // <-- ADD THIS LINE
    getMetadata: (filePath) => ipcRenderer.invoke('get-metadata', filePath),
    openFiles: () => ipcRenderer.invoke('open-files'),
    openFolder: () => ipcRenderer.invoke('open-folder'),
    processDroppedPaths: (paths) => ipcRenderer.invoke('process-dropped-paths', paths),
    copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
    showFileInFolder: (filePath) => ipcRenderer.invoke('show-file-in-folder', filePath),
    toggleOrientation: (isVertical) => ipcRenderer.invoke('toggle-orientation', isVertical),
    pinWindow: () => ipcRenderer.invoke('pin-window'),
    minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
    closeWindow: () => ipcRenderer.invoke('close-window'),
    getStoreValue: (key) => ipcRenderer.invoke('get-store-value', key),
    setStoreValue: (key, value) => ipcRenderer.send('set-store-value', key, value),
    getLyrics: (songKey) => ipcRenderer.invoke('get-lyrics', songKey),
    saveLyrics: (songKey, lyricsText) => ipcRenderer.send('save-lyrics', songKey, lyricsText),
    onFilePathReceived: (callback) => ipcRenderer.on('open-file-path', (_event, filePath) => callback(filePath)),
    onMediaKey: (callback) => ipcRenderer.on('media-key-event', (_event, command) => callback(command)),
    onRestoreState: (callback) => ipcRenderer.on('restore-state', (_event, state) => callback(state)),
    onPlayFile: (callback) => {
        ipcRenderer.on('play-file-on-open', (event, filePath) => callback(filePath));
    },
    onSetOrientationClass: (callback) => ipcRenderer.on('set-orientation-class', (_event, isVertical) => callback(isVertical)),
    setOpacity: (value) => ipcRenderer.send('set-opacity', value),
    openGitHub: () => ipcRenderer.send('open-github'),
    openAuthorUrl: () => ipcRenderer.send('open-author-url'),
    toggleLyricsVisibility: (isVisible) => ipcRenderer.send('toggle-lyrics-visibility', isVisible), // <-- ADD THIS LINE
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
});