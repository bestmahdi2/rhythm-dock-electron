"use strict";
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {registerNativePopup} = require('../src/main/windows/native-popup');

(async () => {
    let handler, template, popup, built = 0;
    const window = new EventEmitter();
    window.isDestroyed = () => false;
    window.getContentBounds = () => ({x: -1200, y: 50, width: 400, height: 220});
    window.webContents = {mainFrame: {}, getZoomFactor: () => 1.5};
    const event = {sender: window.webContents, senderFrame: window.webContents.mainFrame};
    registerNativePopup({getWindow: () => window,
        ipcMain: {handle: (channel, fn) => { assert.equal(channel, 'native-popup'); handler = fn; }},
        screen: {getDisplayNearestPoint: () => ({workArea: {x: -1400, y: 0, width: 1400, height: 900}})},
        Menu: {buildFromTemplate: items => {
            built++; template = items;
            return {popup: options => { popup = options; }, closePopup: () => popup.callback()};
        }}
    });
    const request = {x: 100, y: 200, items: [
        {label: 'Rock & Roll', checked: true}, {type: 'separator'},
        {label: 'Unavailable', enabled: false},
        ...Array.from({length: 80}, (_, i) => ({label: `Option ${i}`}))
    ]};
    assert.equal(await handler({...event, sender: {}}, request), null);
    assert.equal(await handler({...event, senderFrame: {}}, request), null);
    assert.equal(await handler(event, {items: []}), null);
    assert.equal(built, 0);
    const picked = handler(event, request);
    assert.equal(popup.window, window);
    assert.equal(popup.x, -1050);
    assert.equal(popup.y, 350); // Below the 270px window bottom, never clamped to it.
    assert.equal(template.length, 83); // Full long list, without a window-height limit.
    assert.equal(template[0].label, 'Rock && Roll');
    assert.equal(template[0].type, 'checkbox');
    assert.equal(template[0].checked, true);
    assert.equal(template[2].enabled, false);
    template[82].click(); popup.callback();
    assert.equal(await picked, 82);
    assert.equal(window.listenerCount('move'), 0);
    const cancelled = handler(event, {...request, x: 9999, y: 9999});
    assert.equal(popup.x, -1); assert.equal(popup.y, 899);
    popup.callback(); assert.equal(await cancelled, null);
    const moved = handler(event, request);
    window.emit('move'); assert.equal(await moved, null);
    assert.equal(window.listenerCount('closed'), 0);
    assert.equal(window.listenerCount('resize'), 0);
    console.log('PASS: native popups preserve long lists, zoom, screen bounds, selection and cancellation');
})().catch(error => { console.error(error); process.exitCode = 1; });
