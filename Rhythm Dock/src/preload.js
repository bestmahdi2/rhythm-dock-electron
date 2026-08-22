const {contextBridge, ipcRenderer, webUtils} = require('electron');

contextBridge.exposeInMainWorld('api', {
    // Renderer to Main
    rendererReady: () => ipcRenderer.send('renderer-ready'),
    sendPlaybackState: (state) => ipcRenderer.send('playback-state-changed', state), // <-- ADD THIS LINE
    getMetadata: (filePath) => ipcRenderer.invoke('get-metadata', filePath),
    openFiles: () => ipcRenderer.invoke('open-files'),
    openFolder: () => ipcRenderer.invoke('open-folder'),
    processDroppedPaths: (paths) => ipcRenderer.invoke('process-dropped-paths', paths),
    // File.path was removed from the renderer in Electron 32+. webUtils is the
    // supported replacement; the optional chaining keeps this working on 31 too.
    getPathForFile: (file) => {
        try {
            return webUtils?.getPathForFile ? webUtils.getPathForFile(file) : file.path;
        } catch (_) {
            return file.path;
        }
    },
    copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
    showFileInFolder: (filePath) => ipcRenderer.invoke('show-file-in-folder', filePath),
    toggleOrientation: (isVertical) => ipcRenderer.invoke('toggle-orientation', isVertical),
    pinWindow: () => ipcRenderer.invoke('pin-window'),
    minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
    closeWindow: () => ipcRenderer.invoke('close-window'),
    getStoreValue: (key) => ipcRenderer.invoke('get-store-value', key),
    setStoreValue: (key, value) => ipcRenderer.send('set-store-value', key, value),
    getLyrics: (songKey) => ipcRenderer.invoke('get-lyrics', songKey),
    saveLyrics: (songKey, lyricsText, details) => ipcRenderer.send('save-lyrics', songKey, lyricsText, details),
    onFilePathReceived: (callback) => ipcRenderer.on('open-file-path', (_event, filePath) => callback(filePath)),
    onMediaKey: (callback) => ipcRenderer.on('media-key-event', (_event, command) => callback(command)),
    onRestoreState: (callback) => ipcRenderer.on('restore-state', (_event, state) => callback(state)),
    onSetOrientationClass: (callback) => ipcRenderer.on('set-orientation-class', (_event, isVertical) => callback(isVertical)),
    setOpacity: (value) => ipcRenderer.send('set-opacity', value),
    openGitHub: () => ipcRenderer.send('open-github'),
    openAuthorUrl: () => ipcRenderer.send('open-author-url'),
    toggleLyricsVisibility: (isVisible) => ipcRenderer.send('toggle-lyrics-visibility', isVisible), // <-- ADD THIS LINE
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),

    // --- Library (#16, #17) ---
    librarySearch: (query) => ipcRenderer.invoke('library-search', query),
    libraryArtists: () => ipcRenderer.invoke('library-artists'),
    libraryTracksByArtist: (artistKey) => ipcRenderer.invoke('library-tracks-by-artist', artistKey),
    libraryGetTrack: (filePath) => ipcRenderer.invoke('library-get-track', filePath),
    libraryResolveTrack: (filePath) => ipcRenderer.invoke('library-resolve-track', filePath),
    scanFolderPath: (dirPath) => ipcRenderer.invoke('scan-folder-path', dirPath),
    onLibraryUpdated: (callback) => ipcRenderer.on('library-updated', (_e, payload) => callback(payload)),
    onScanProgress: (callback) => ipcRenderer.on('scan-progress', (_e, payload) => callback(payload)),
    onScanTruncated: (callback) => ipcRenderer.on('scan-truncated', (_e, payload) => callback(payload)),

    // --- File operations for the file dropdown (#13) ---
    openPath: (filePath) => ipcRenderer.invoke('open-path', filePath),
    openContainingFolder: (filePath) => ipcRenderer.invoke('open-containing-folder', filePath),
    deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),
    getExclusions: (directory) => ipcRenderer.invoke('get-exclusions', directory),
    toggleExclusion: (filePath) => ipcRenderer.invoke('toggle-exclusion', filePath),

    // --- Tray & global shortcuts (#5) ---
    getMinimizeToTray: () => ipcRenderer.invoke('get-minimize-to-tray'),
    setMinimizeToTray: (enabled) => ipcRenderer.invoke('set-minimize-to-tray', enabled),
    hideToTray: () => ipcRenderer.invoke('hide-to-tray'),
    getShortcuts: () => ipcRenderer.invoke('get-shortcuts'),
    setShortcuts: (bindings) => ipcRenderer.invoke('set-shortcuts', bindings),
    testShortcut: (accelerator) => ipcRenderer.invoke('test-shortcut', accelerator),
    onShortcutConflicts: (callback) => ipcRenderer.on('shortcut-conflicts', (_e, list) => callback(list)),

    // --- Translation (#15) ---
    getLanguages: () => ipcRenderer.invoke('get-languages'),
    translateLyrics: (payload) => ipcRenderer.invoke('translate-lyrics', payload),
    getTranslationConfig: () => ipcRenderer.invoke('get-translation-config'),
    setTranslationConfig: (config) => ipcRenderer.invoke('set-translation-config', config),

    // --- Tag editor ---
    readTags: (filePath) => ipcRenderer.invoke('read-tags', filePath),
    writeTags: (payload) => ipcRenderer.invoke('write-tags', payload),
    pickCoverImage: () => ipcRenderer.invoke('pick-cover-image'),

    // --- Tabs (#14) ---
    setActiveTab: (tab) => ipcRenderer.invoke('set-active-tab', tab),

    // --- Notifications (#26) ---
    notify: (payload) => ipcRenderer.invoke('notify', payload),

    // --- Rooms / streaming ---
    roomCreate: (options) => ipcRenderer.invoke('room-create', options),
    roomJoin: (options) => ipcRenderer.invoke('room-join', options),
    roomLeave: () => ipcRenderer.invoke('room-leave'),
    roomStatus: () => ipcRenderer.invoke('room-status'),
    roomPublishState: (state) => ipcRenderer.send('room-publish-state', state),
    roomPublishLibrary: (payload) => ipcRenderer.send('room-publish-library', payload),
    roomPublishLyrics: (payload) => ipcRenderer.send('room-publish-lyrics', payload),
    roomPublishSettings: (settings) => ipcRenderer.send('room-publish-settings', settings),
    roomControl: (action, value) => ipcRenderer.send('room-control', {action, value}),
    roomSetRole: (memberId, role) => ipcRenderer.send('room-set-role', {memberId, role}),
    roomKick: (memberId) => ipcRenderer.send('room-kick', {memberId}),
    onRoomEvent: (event, callback) => ipcRenderer.on(event, (_e, payload) => callback(payload)),
});