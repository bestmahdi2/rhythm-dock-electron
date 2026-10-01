const {contextBridge, ipcRenderer, webUtils} = require('electron');

contextBridge.exposeInMainWorld('api', {
    // Renderer to Main
    rendererReady: () => ipcRenderer.send('renderer-ready'),
    diagnosticEvent: (event, details) => ipcRenderer.send('diagnostic-event', event, details),
    diagnosticsExport: () => ipcRenderer.invoke('diagnostics-export'),
    sendPlaybackState: (state) => ipcRenderer.send('playback-state-changed', state), // <-- ADD THIS LINE
    getMetadata: (filePath) => ipcRenderer.invoke('get-metadata', filePath),
    mediaToolsPick: () => ipcRenderer.invoke('media-tools-pick'),
    mediaToolsCheck: () => ipcRenderer.invoke('media-tools-check'),
    mediaToolsCancel: () => ipcRenderer.invoke('media-tools-cancel'),
    mediaPrepare: (filePath) => ipcRenderer.invoke('media-prepare', filePath),
    mediaAnalyse: (files) => ipcRenderer.invoke('media-analyse', files),
    mediaAnalyseAlbum: (filePath) => ipcRenderer.invoke('media-analyse-album', filePath),
    mediaExport: (options) => ipcRenderer.invoke('media-export', options),
    mediaChapterTracks: (filePath) => ipcRenderer.invoke('media-chapter-tracks', filePath),
    onMediaToolsProgress: (callback) => ipcRenderer.on('media-tools-progress', (_e, value) => callback(value)),
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
    libraryCatalog: () => ipcRenderer.invoke('library-catalog'),
    libraryArtists: () => ipcRenderer.invoke('library-artists'),
    libraryTracksByArtist: (artistKey) => ipcRenderer.invoke('library-tracks-by-artist', artistKey),
    libraryGetTrack: (filePath) => ipcRenderer.invoke('library-get-track', filePath),
    libraryResolveTrack: (filePath) => ipcRenderer.invoke('library-resolve-track', filePath),
    scanFolderPath: (dirPath) => ipcRenderer.invoke('scan-folder-path', dirPath),
    onLibraryUpdated: (callback) => ipcRenderer.on('library-updated', (_e, payload) => callback(payload)),
    onScanProgress: (callback) => ipcRenderer.on('scan-progress', (_e, payload) => callback(payload)),
    onScanTruncated: (callback) => ipcRenderer.on('scan-truncated', (_e, payload) => callback(payload)),
    onScanComplete: (callback) => ipcRenderer.on('scan-complete', (_e, payload) => callback(payload)),

    // --- Persistent library & play statistics (Phase 7) ---
    libraryRoots: () => ipcRenderer.invoke('library-roots'),
    libraryStats: () => ipcRenderer.invoke('library-stats'),
    libraryView: (view, limit) => ipcRenderer.invoke('library-view', view, limit),
    libraryRecommendations: (options) => ipcRenderer.invoke('library-recommendations', options),
    libraryPreferences: () => ipcRenderer.invoke('library-preferences'),
    libraryPreferenceSet: (filePath, preference) => ipcRenderer.invoke('library-preference-set', filePath, preference),
    libraryPreferencesReset: () => ipcRenderer.invoke('library-preferences-reset'),
    libraryAlbumRecommendations: (options) => ipcRenderer.invoke('library-album-recommendations', options),
    librarySetRating: (filePath, rating) => ipcRenderer.invoke('library-set-rating', filePath, rating),
    bookPositionGet: (filePath) => ipcRenderer.invoke('book-position-get', filePath),
    bookPositionSet: (filePath, seconds) => ipcRenderer.invoke('book-position-set', filePath, seconds),
    remoteAudioAdd: (url) => ipcRenderer.invoke('remote-audio-add', url),
    remoteAudioSave: (filePath) => ipcRenderer.invoke('remote-audio-save', filePath),
    onRemoteAudioProgress: (callback) => ipcRenderer.on('remote-audio-progress', (_e, value) => callback(value)),
    playlistList: () => ipcRenderer.invoke('playlist-list'),
    playlistTracks: (id) => ipcRenderer.invoke('playlist-tracks', id),
    playlistCreate: (name, paths) => ipcRenderer.invoke('playlist-create', name, paths),
    playlistAdd: (id, filePath) => ipcRenderer.invoke('playlist-add', id, filePath),
    playlistRemove: (id, filePath) => ipcRenderer.invoke('playlist-remove', id, filePath),
    playlistDelete: (id) => ipcRenderer.invoke('playlist-delete', id),
    playlistImportFile: () => ipcRenderer.invoke('playlist-import-file'),
    playlistExportFile: (id) => ipcRenderer.invoke('playlist-export-file', id),
    libraryAddRoot: () => ipcRenderer.invoke('library-add-root'),
    libraryRemoveRoot: (rootId) => ipcRenderer.invoke('library-remove-root', rootId),
    libraryRescan: (rootId) => ipcRenderer.invoke('library-rescan', rootId ?? null),
    libraryCancelScan: () => ipcRenderer.invoke('library-cancel-scan'),
    libraryRecheckMissing: () => ipcRenderer.invoke('library-recheck-missing'),
    libraryRecordPlay: (filePath, listenedMs) => ipcRenderer.send('library-record-play', filePath, listenedMs),
    libraryRecordSkip: (filePath, listenedMs) => ipcRenderer.send('library-record-skip', filePath, listenedMs),
    libraryExport: () => ipcRenderer.invoke('library-export'),
    libraryImport: () => ipcRenderer.invoke('library-import'),

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

    // --- Lyrics (Phase 9) ---
    lyricsResolve: (request) => ipcRenderer.invoke('lyrics:resolve', request),
    lyricsSave: (payload) => ipcRenderer.invoke('lyrics:save', payload),
    lyricsGetOffset: (songKey) => ipcRenderer.invoke('lyrics:get-offset', songKey),
    lyricsSetOffset: (songKey, offsetMs) => ipcRenderer.invoke('lyrics:set-offset', {songKey, offsetMs}),
    lyricsGetConfig: () => ipcRenderer.invoke('lyrics:get-config'),
    lyricsSetConfig: (config) => ipcRenderer.invoke('lyrics:set-config', config),

    // --- Window / full-screen lyrics (Phase 9) ---
    setFullscreen: (enabled) => ipcRenderer.invoke('window:set-fullscreen', enabled),
    isFullscreen: () => ipcRenderer.invoke('window:is-fullscreen'),
    onFullscreenChanged: (callback) => ipcRenderer.on(
        'window:fullscreen-changed', (_e, enabled) => callback(enabled)
    ),

    // --- Desktop lyrics overlay (Phase 9) ---
    overlayToggle: (enabled) => ipcRenderer.invoke('overlay:toggle', enabled),
    overlayIsOpen: () => ipcRenderer.invoke('overlay:is-open'),
    overlayUpdate: (payload) => ipcRenderer.send('overlay:update', payload),
    overlayStyle: (payload) => ipcRenderer.send('overlay:style', payload),
    onOverlayRequestState: (callback) => ipcRenderer.on('overlay:request-state', () => callback()),
    onOverlayClosed: (callback) => ipcRenderer.on('overlay:closed', () => callback()),

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
    roomUploadSong: (position) => ipcRenderer.invoke('room-upload-song', position),
    roomTelegramPair: () => ipcRenderer.invoke('room-telegram-pair'),
    edgeDockToggle: () => ipcRenderer.invoke('edge-dock-toggle'),
    edgeDockStatus: () => ipcRenderer.invoke('edge-dock-status'),
    edgeDockExpand: (expanded) => ipcRenderer.send('edge-dock-expand', expanded),
    onEdgeDockChanged: (callback) => ipcRenderer.on('edge-dock-changed', (_e, state) => callback(state)),
    roomPublishState: (state) => ipcRenderer.send('room-publish-state', state),
    roomPublishLibrary: (payload) => ipcRenderer.send('room-publish-library', payload),
    roomPublishLyrics: (payload) => ipcRenderer.send('room-publish-lyrics', payload),
    roomPublishSettings: (settings) => ipcRenderer.send('room-publish-settings', settings),
    roomControl: (action, value) => ipcRenderer.send('room-control', {action, value}),
    roomSetRole: (memberId, role) => ipcRenderer.send('room-set-role', {memberId, role}),
    roomKick: (memberId) => ipcRenderer.send('room-kick', {memberId}),
    onRoomEvent: (event, callback) => ipcRenderer.on(event, (_e, payload) => callback(payload)),
});
