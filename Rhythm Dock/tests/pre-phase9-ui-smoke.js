'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {app, BrowserWindow, screen, ipcMain} = require('electron');
const Database = require('better-sqlite3');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rhythm-ui-smoke-'));
const data = path.join(scratch, 'app-data');
fs.mkdirSync(data, {recursive: true});
app.setPath('appData', data);
const userData = path.join(data, 'test-user');
fs.mkdirSync(userData, {recursive: true});
app.setPath('userData', userData);
// A valid empty legacy DB takes priority over any database in the checkout.
const isolatedLegacyDb = new Database(path.join(userData, 'lyrics.db'));
isolatedLegacyDb.exec('CREATE TABLE IF NOT EXISTS smoke_marker (id INTEGER PRIMARY KEY)');
isolatedLegacyDb.close();
// Exercise the real window/renderer without flashing a test window on the desktop.
BrowserWindow.prototype.show = function () {};
const rendererReady = new Promise((resolve) => ipcMain.once('renderer-ready', resolve));
// The app treats command-line file paths as songs; this test script is not one.
process.argv.splice(1);
require('../src/main/index');

async function waitForWindow() {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        const window = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
        if (window && !window.webContents.isLoadingMainFrame()) {
            const ready = await window.webContents.executeJavaScript('document.readyState === "complete" && Boolean(window.api)');
            if (ready) return window;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Player window did not finish loading.');
}

app.whenReady().then(async () => {
    try {
        const window = await waitForWindow();
        await Promise.race([rendererReady, new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Renderer did not finish initialization.')), 15000))]);
        // renderer-ready is sent after handlers are wired, while async settings
        // restoration can still be applying its saved lock state.
        await new Promise((resolve) => setTimeout(resolve, 400));
        const checks = await window.webContents.executeJavaScript(`(() => {
            const theme = document.getElementById('light-mode-btn');
            const lock = document.getElementById('lock-btn');
            const edgeTitle = document.getElementById('edge-title');
            const actions = queueActions('C:\\\\test.mp3').map((action) => action.title);
            const before = theme.getAttribute('aria-checked');
            theme.click();
            const after = theme.getAttribute('aria-checked');
            lock.click();
            const locked = document.querySelector('.container').classList.contains('locked');
            return {role: theme.getAttribute('role'), before, after, locked,
                edgeTitle: Boolean(edgeTitle), actions};
        })()`);
        assert.equal(checks.role, 'switch');
        assert.notEqual(checks.before, checks.after);
        assert.equal(checks.locked, true);
        assert.equal(checks.edgeTitle, true);
        assert.ok(checks.actions.some((title) => /next/i.test(title)));
        assert.ok(checks.actions.some((title) => /top/i.test(title)));
        assert.ok(checks.actions.some((title) => /end/i.test(title)));

        const lockSecond = await window.webContents.executeJavaScript(`(async () => {
            const button = document.getElementById('lock-btn');
            let fired = false;
            button.addEventListener('click', () => { fired = true; }, {once: true});
            button.click();
            return {fired, disabled: button.disabled, pointer: getComputedStyle(button).pointerEvents,
                locked: isLocked, stored: await window.api.getStoreValue('isLocked')};
        })()`);
        assert.equal(lockSecond.locked, false);
        assert.equal(lockSecond.stored, false);
        const docked = await window.webContents.executeJavaScript('window.api.edgeDockToggle()');
        assert.equal(docked, true);
        const bounds = window.getBounds();
        const work = screen.getDisplayMatching(bounds).workArea;
        assert.ok(bounds.x === work.x || bounds.x + bounds.width === work.x + work.width,
            'docked window must touch a screen wall');
        const routing = await window.webContents.executeJavaScript(`(async () => {
            const devices = (await navigator.mediaDevices.enumerateDevices())
                .filter((device) => device.kind === 'audiooutput');
            const primary = devices.find((device) => device.deviceId === 'default');
            const extra = devices.find((device) => device.deviceId !== 'default' &&
                (!primary?.groupId || device.groupId !== primary.groupId));
            if (!extra) return {devices: devices.map((device) => device.label), skipped: true};
            const engine = window.RhythmAudio.engine;
            const result = await engine.addOutput(extra.deviceId, {delayMs: 120});
            const listed = engine.listOutputs().some((item) => item.deviceId === extra.deviceId && item.delayMs === 120);
            engine.removeOutput(extra.deviceId);
            return {devices: devices.map((device) => device.label), extra: extra.label,
                result, listed, released: !engine.listOutputs().some((item) => item.deviceId === extra.deviceId)};
        })()`);
        console.log('[ui-smoke] audio routing:', routing);
        if (!routing.skipped) {
            assert.equal(routing.result.ok, true, routing.result.error);
            assert.equal(routing.listed, true);
            assert.equal(routing.released, true);
        }
        console.log('PASS: settings switch, lock, queue positions, and wall dock in the real renderer');
        app.exit(0);
    } catch (error) {
        console.error(error);
        app.exit(1);
    }
}).catch((error) => { console.error(error); app.exit(1); });
