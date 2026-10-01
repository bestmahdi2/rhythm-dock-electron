'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let devices = [], active = ['default'], pauses = 0, playing = true, audioContext = null, bindings = 0;
const context = {window: {}, console, setTimeout, clearTimeout, navigator: {mediaDevices: {
    enumerateDevices: async () => devices, addEventListener() {}, removeEventListener() {},
}}};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/js/audio/devices.js'), 'utf8'), context);
const watcher = new context.window.RhythmDevices.OutputDeviceWatcher({onDisconnect: () => pauses++,
    isPlaying: () => playing, activeOutputs: () => active, getContext: () => audioContext});
const item = (deviceId, groupId, label = '') => ({kind: 'audiooutput', deviceId, groupId, label});
(async () => {
    devices = [item('default', 'speakers'), item('speakers', 'speakers'), item('buds', 'buds', 'Headphones')];
    await watcher.start();
    audioContext = {addEventListener() { bindings++; }, removeEventListener() { bindings--; }};
    watcher.bindContext(); watcher.bindContext(); assert.equal(bindings, 1, 'a lazy audio context must bind once');
    devices = devices.filter((device) => device.deviceId !== 'buds');
    await watcher._check(); assert.equal(pauses, 0, 'unused headphones must not interrupt speakers');
    devices = [item('default', 'buds'), item('buds', 'buds', 'Headphones'), item('speakers', 'speakers')];
    await watcher._snapshot();
    devices = [item('default', 'speakers'), item('speakers', 'speakers')];
    await watcher._check(); assert.equal(pauses, 1, 'default alias switching away from headphones must pause');
    active = ['speakers', 'buds']; devices.push(item('buds', 'buds'));
    await watcher._snapshot(); devices.pop();
    await watcher._check(); assert.equal(pauses, 2, 'active extra output removal must pause');
    playing = false; await watcher._snapshot(); devices = [];
    await watcher._check(); assert.equal(pauses, 2, 'paused playback must stay paused');
    watcher.stop(); assert.equal(bindings, 0);
    console.log('PASS: disconnect watcher distinguishes active, default, extra and unused outputs');
})().catch((error) => { console.error(error); process.exitCode = 1; });
