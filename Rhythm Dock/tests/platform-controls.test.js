'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the macOS branch on any test host, including while paused.
let menu;
const commands = [];
const context = {module: {exports: {}}, process: {platform: 'darwin'}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/services/platform-controls.js'), 'utf8'), context);
const controls = context.module.exports.create({
    electron: {app: {dock: {setMenu: value => { menu = value; }}}, Menu: {buildFromTemplate: items => items}},
    getStore: () => ({get: () => false}), getWindow: () => null,
    send: (channel, command) => commands.push([channel, command]),
});
controls.update({isPlaying: false});
assert.equal(menu.map(item => item.label).join(','), 'Previous Track,Play,Next Track');
menu.forEach(item => item.click());
assert.deepEqual(commands, [['media-key-event', 'prev'], ['media-key-event', 'play-pause'], ['media-key-event', 'next']]);
controls.update({isPlaying: true, title: 'Song'});
assert.equal(menu[1].label, 'Pause');

// Test the actual renderer transport and media-session adapter without the UI.
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/js/renderer.js'), 'utf8');
const adapter = source.slice(source.indexOf('function handleMediaCommand('), source.indexOf('window.api.onSetOrientationClass'));
const handlers = {};
const clicks = [];
let interruptions=0;
const renderer = {
    isLocked: false, isPlaying: false, currentSongData: null, console,
    playPauseBtn: {click: () => clicks.push('toggle')},
    prevBtn: {click: () => clicks.push('prev')}, nextBtn: {click: () => clicks.push('next')},
    window: {api: {onMediaKey: () => {}}},
    navigator: {mediaSession: {setActionHandler: (name, handler) => { handlers[name] = handler; }}},
    MediaMetadata: class {constructor(data) {Object.assign(this, data);}},
    pauseForInterruption: () => {if(renderer.isPlaying)interruptions++;},
};
vm.createContext(renderer);
vm.runInContext(adapter, renderer);
handlers.play(); handlers.pause(); handlers.previoustrack(); handlers.nexttrack();
assert.deepEqual(clicks, ['toggle', 'prev', 'next']);
renderer.isPlaying = true;
handlers.play(); handlers.pause();
assert.equal(interruptions,1);
assert.equal(clicks.length, 3);
renderer.isLocked = true;
handlers.nexttrack(); handlers.pause();
assert.equal(clicks.length, 3, 'navigation must respect the player lock');
assert.equal(interruptions,2,'a system pause must work even while the UI is locked');
renderer.currentSongData = {title: 'Song', artist: 'Artist', cover: 'data:image/png;base64,AA=='};
renderer.updateSystemMediaSession();
assert.equal(renderer.navigator.mediaSession.playbackState, 'playing');
assert.equal(renderer.navigator.mediaSession.metadata.title, 'Song');
renderer.isPlaying = false;
renderer.updateSystemMediaSession();
assert.equal(renderer.navigator.mediaSession.playbackState, 'paused');
renderer.currentSongData = null;
renderer.updateSystemMediaSession();
assert.equal(renderer.navigator.mediaSession.metadata, null);
assert.equal(renderer.navigator.mediaSession.playbackState, 'none');
vm.runInNewContext(adapter, {...renderer, navigator: {}});
console.log('Platform controls tests passed.');
