const {contextBridge, ipcRenderer} = require('electron');

// Restricted overlay bridge.
contextBridge.exposeInMainWorld('overlay', {
    onUpdate: (callback) => ipcRenderer.on('overlay:update', (_event, payload) => callback(payload)),
    onStyle: (callback) => ipcRenderer.on('overlay:style', (_event, payload) => callback(payload)),
    command: (action) => ipcRenderer.send('overlay:command', action),
    setClickThrough: (enabled) => ipcRenderer.invoke('overlay:set-click-through', enabled),
    ready: () => ipcRenderer.send('overlay:ready'),
    setInteractive: value => ipcRenderer.send('overlay:interactive', value),
    resize: bounds => ipcRenderer.invoke('overlay:resize', bounds),
    close: () => ipcRenderer.send('overlay:close'),
});
