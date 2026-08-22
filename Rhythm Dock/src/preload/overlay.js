const {contextBridge, ipcRenderer} = require('electron');

/**
 * Preload for the desktop lyrics overlay (Phase 9).
 *
 * Deliberately tiny and separate from the main preload. That one hands the renderer
 * file dialogs, the tag writer, the library index and the room client; a floating strip
 * that shows one line of text has no business being able to reach any of it. Four
 * channels is the whole surface: receive a line, send a transport command, set
 * click-through, close.
 */
contextBridge.exposeInMainWorld('overlay', {
    onUpdate: (callback) => ipcRenderer.on('overlay:update', (_event, payload) => callback(payload)),
    onStyle: (callback) => ipcRenderer.on('overlay:style', (_event, payload) => callback(payload)),
    command: (action) => ipcRenderer.send('overlay:command', action),
    setClickThrough: (enabled) => ipcRenderer.invoke('overlay:set-click-through', enabled),
    close: () => ipcRenderer.send('overlay:close'),
});
