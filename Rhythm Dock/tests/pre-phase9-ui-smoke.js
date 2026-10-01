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
const tonePath = path.join(scratch, 'routing-tone.wav');
const sampleRate = 22050;
const samples = sampleRate;
const wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++)
    wav.writeInt16LE(Math.round(250 * Math.sin(2 * Math.PI * 440 * i / sampleRate)), 44 + i * 2);
fs.writeFileSync(tonePath, wav);
const secondTonePath = path.join(scratch, 'second-tone.wav');
fs.writeFileSync(secondTonePath, wav);
// A sparse one-hour WAV exercises large-file startup without writing an hour of samples.
const largeTonePath = path.join(scratch, 'large-streaming.wav');
const largeBytes = sampleRate * 2 * 3600;
const largeHeader = Buffer.from(wav.subarray(0, 44));
largeHeader.writeUInt32LE(largeBytes + 36, 4); largeHeader.writeUInt32LE(largeBytes, 40);
const largeFd = fs.openSync(largeTonePath, 'w');
fs.writeSync(largeFd, largeHeader); fs.ftruncateSync(largeFd, largeBytes + 44); fs.closeSync(largeFd);
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
    ffmpegPath: process.env.FFMPEG_TEST_BINARY || '', migrationTestMarker: 'legacy-settings-kept',
    lyrics: {providerOrder: ['sidecar', 'embedded']}}));
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
        window.webContents.setBackgroundThrottling(false);
        await Promise.race([rendererReady, new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Renderer did not finish initialization.')), 15000))]);
        const deadline = Date.now() + 10000;
        while (!await window.webContents.executeJavaScript('document.documentElement.dataset.appReady === "true"')) {
            if (Date.now() > deadline) throw new Error('Settings and session did not finish restoring.');
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(await window.webContents.executeJavaScript('window.api.getStoreValue("migrationTestMarker")'),
            'legacy-settings-kept', 'startup must import settings before creating a new config');
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
            theme.click();
            const blockedClick = theme.getAttribute('aria-checked') === after;
            return {role: theme.getAttribute('role'), before, after, locked,
                blockedClick, edgeTitle: Boolean(edgeTitle), actions};
        })()`);
        assert.equal(checks.role, 'switch');
        assert.notEqual(checks.before, checks.after);
        assert.equal(checks.locked, true);
        assert.equal(checks.blockedClick, true, 'locked controls must reject programmatic and keyboard clicks');
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
        const queueCheck = await window.webContents.executeJavaScript(`(async () => {
            playlist = ['one.mp3', 'two.mp3', 'three.mp3'];
            originalPlaylist = [...playlist]; currentIndex = 0;
            enqueue('four.mp3', 'next');
            enqueue('three.mp3', 'first');
            const inserted = playlist.join('|');
            const current = playlist[currentIndex];
            moveQueueItem(0, 3);
            moveQueueItem(-1, 100);
            const moved = playlist.join('|');
            removeFromQueue(playlist.indexOf('two.mp3'));
            savePlaybackState();
            const stored = await window.api.getStoreValue('lastPlaybackState');
            return {inserted, current, moved, remaining: playlist.join('|'), stored: stored.queue.join('|')};
        })()`);
        assert.equal(queueCheck.inserted, 'three.mp3|one.mp3|four.mp3|two.mp3');
        assert.equal(queueCheck.current, 'one.mp3', 'queue edits must preserve the playing song');
        assert.equal(queueCheck.moved, 'one.mp3|four.mp3|two.mp3|three.mp3');
        assert.equal(queueCheck.remaining, 'one.mp3|four.mp3|three.mp3');
        assert.equal(queueCheck.stored, queueCheck.remaining, 'queue order must survive restart');
        await window.webContents.executeJavaScript('playlist = []; originalPlaylist = []; currentIndex = -1; savePlaybackState();');
        const docked = await window.webContents.executeJavaScript('window.api.edgeDockToggle()');
        assert.equal(docked, true);
        const bounds = window.getBounds();
        const work = screen.getDisplayMatching(bounds).workArea;
        assert.ok(bounds.x === work.x || bounds.x + bounds.width === work.x + work.width,
            'docked window must touch a screen wall');
        await window.webContents.executeJavaScript('window.api.edgeDockExpand(true)');
        await new Promise((resolve) => setTimeout(resolve, 350));
        assert.equal(window.getBounds().width, 220, 'hover expansion must have room for the vertical player');
        await window.webContents.executeJavaScript('window.api.setActiveTab("settings")');
        await new Promise((resolve) => setTimeout(resolve, 350));
        const panelBounds = window.getBounds();
        assert.equal(panelBounds.width, 340, 'docked settings must remain readable');
        assert.ok(panelBounds.x === work.x || panelBounds.x + panelBounds.width === work.x + work.width);
        await window.webContents.executeJavaScript('window.api.edgeDockToggle()');
        await window.webContents.executeJavaScript('window.api.toggleOrientation(true)');
        assert.equal(window.getBounds().width, 340);
        await window.webContents.executeJavaScript('window.api.setActiveTab("player")');
        await new Promise((resolve) => setTimeout(resolve, 350));
        assert.equal(window.getBounds().width, 220);
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
            let playback = null;
            if (result.ok) {
                engine.setVolume(0.1, {immediate: true});
                engine.load(${JSON.stringify(tonePath)});
                await new Promise((resolve) => engine.element.addEventListener('canplay', resolve, {once: true}));
                await engine.play();
                await new Promise((resolve) => setTimeout(resolve, 350));
                playback = {time: engine.element.currentTime, state: engine.state};
                engine.pause();
            }
            engine.removeOutput(extra.deviceId);
            return {devices: devices.map((device) => device.label), extra: extra.label,
                result, listed, playback,
                released: !engine.listOutputs().some((item) => item.deviceId === extra.deviceId)};
        })()`);
        console.log('[ui-smoke] audio routing:', routing);
        if (!routing.skipped) {
            assert.equal(routing.result.ok, true, routing.result.error);
            assert.equal(routing.listed, true);
            assert.ok(routing.playback.time > 0.1, 'audio should advance during two-output playback');
            assert.equal(routing.released, true);
        }
        const engineCheck = await window.webContents.executeJavaScript(`(async () => {
            const engine = window.RhythmAudio.engine;
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const wait = async (test) => {
                const deadline = Date.now() + 5000;
                while (!test()) { if (Date.now() > deadline) throw new Error('Audio fixture timed out'); await sleep(20); }
            };
            engine.setMuted(true); engine.setNextTrack(null); engine.setCrossfade(0);
            const started = performance.now(); engine.load(${JSON.stringify(largeTonePath)});
            await wait(() => engine.element.readyState >= 3);
            const large = {duration: engine.duration(), readyMs: Math.round(performance.now() - started)};
            engine.load(${JSON.stringify(tonePath)});
            await wait(() => engine.element.readyState >= 3);
            await engine.play(); await wait(() => engine.hasEnded());
            await engine.play(); await sleep(150);
            const replay = engine.isPlaying() && engine.seek() > 0.05 && engine.seek() < 0.5;
            engine.pause(); await engine.play(); await sleep(200);
            const resumed = engine.isPlaying();
            engine.setRate(1.5); engine.setPreservePitch(true);
            const pitch = engine.element.preservesPitch && engine.element.playbackRate === 1.5;
            engine.setPrimaryDelay(180);
            const primaryDelay = engine.primaryDelayMs === 180;
            engine.setPrimaryDelay(0);
            engine.setRate(1); engine.load(${JSON.stringify(tonePath)});
            await wait(() => engine.element.readyState >= 3);
            engine.setLoop(0.1, 0.25); await engine.play(); engine.seek(0.3); engine._onTick(engine.element);
            const loop = engine.seek() < 0.2;
            engine.clearLoop(); engine.pause();
            engine.preloadNext(${JSON.stringify(secondTonePath)});
            await wait(() => engine._idleDeck.element.readyState >= 3);
            const buffered = engine._idleDeck.element;
            engine.load(${JSON.stringify(secondTonePath)}, {autoplay: false});
            const gapless = engine.element === buffered && engine.state === 'paused';
            engine.load(${JSON.stringify(tonePath)});
            await wait(() => engine.element.readyState >= 3);
            engine.preloadNext(${JSON.stringify(secondTonePath)});
            await wait(() => engine._idleDeck.element.readyState >= 3);
            engine.setNextTrack(${JSON.stringify(secondTonePath)}); engine.setCrossfade(400);
            await engine.play(); engine.seek(0.75); engine._onTick(engine.element);
            const incoming = engine.element;
            const load = incoming.load; let reloads = 0;
            incoming.load = function () { reloads++; return load.call(this); };
            engine.load(${JSON.stringify(secondTonePath)}, {autoplay: true});
            incoming.load = load;
            const handoff = engine.element === incoming && reloads === 0;
            await sleep(150);
            const advances = engine.isPlaying() && engine.seek() > 0.05;
            engine.unload();
            return {replay, resumed, pitch, primaryDelay, loop, gapless, handoff, advances, large};
        })()`);
        console.log('[ui-smoke] engine:', engineCheck);
        assert.ok(engineCheck.large.duration > 3599 && engineCheck.large.readyMs < 5000);
        delete engineCheck.large;
        assert.deepEqual(engineCheck, {replay: true, resumed: true, pitch: true, primaryDelay: true,
            loop: true, gapless: true, handoff: true, advances: true});
        if (process.env.FFMPEG_TEST_BINARY) {
            const measurement = await window.webContents.executeJavaScript(`window.api.mediaAnalyse([${JSON.stringify(tonePath)}])`);
            assert.equal(measurement.ok, true, measurement.error);
            const metadata = await window.webContents.executeJavaScript(`window.api.getMetadata(${JSON.stringify(tonePath)})`);
            assert.ok(Number.isFinite(metadata.analysis.gainDb));
            const tools = require('../src/main/services/media-tools');
            const extra = path.join(scratch, 'decoder-test.wv');
            await tools.run(process.env.FFMPEG_TEST_BINARY, ['-hide_banner', '-nostdin', '-i', tonePath, '-c:a', 'wavpack', extra]);
            const decoded = await window.webContents.executeJavaScript(`(async () => {
                playlist = [${JSON.stringify(extra)}]; originalPlaylist = [...playlist];
                await playTrack(0, {startPaused: true});
                return {source: currentIndex === 0, decoded: /\\.flac$/.test(preparedAudio.get(playlist[0]) || ''), playing: audio.isPlaying()};
            })()`);
            assert.deepEqual(decoded, {source: true, decoded: true, playing: false});
            fs.writeFileSync(path.join(scratch, 'routing-tone.cue'),
                'FILE "routing-tone.wav" WAVE\n TRACK 01 AUDIO\n TITLE "First"\n INDEX 01 00:00:00\n' +
                ' TRACK 02 AUDIO\n TITLE "Second"\n INDEX 01 00:00:38\n');
            const sections = await window.webContents.executeJavaScript(`window.api.mediaChapterTracks(${JSON.stringify(tonePath)})`);
            assert.equal(sections.ok, true, sections.error);
            assert.equal(sections.files.length, 2);
            assert.equal((await require('music-metadata').parseFile(sections.files[1])).common.title, 'Second');
        }
        if (process.env.RHYTHM_UI_CAPTURE_DIR) {
            fs.mkdirSync(process.env.RHYTHM_UI_CAPTURE_DIR, {recursive: true});
            for (const tab of ['player', 'playlist', 'settings']) {
                await window.webContents.executeJavaScript(`setActiveTab(${JSON.stringify(tab)})`);
                await new Promise((resolve) => setTimeout(resolve, 350));
                const selected = await window.webContents.executeJavaScript(`({active: activeTab,
                    visible: ${JSON.stringify(tab)} === 'player' || getComputedStyle(document.getElementById(${JSON.stringify(tab === 'settings' ? 'tab-settings' : 'playlist-panel')})).visibility === 'visible'})`);
                assert.equal(selected.active, tab); assert.equal(selected.visible, true);
                fs.writeFileSync(path.join(process.env.RHYTHM_UI_CAPTURE_DIR, `vertical-${tab}.png`),
                    (await window.webContents.capturePage()).toPNG());
            }
        }
        process.env.PORT = '0'; process.env.HOST = '127.0.0.1';
        process.env.CREATE_SECRET = 'local-smoke-secret'; process.env.TELEGRAM_BOT_TOKEN = '';
        const {server} = require('../../server/src/index');
        if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        await window.webContents.executeJavaScript('playlist = []; originalPlaylist = []; currentIndex = -1; savePlaybackState();');
        const created = await window.webContents.executeJavaScript(`window.api.roomCreate({
            serverUrl: ${JSON.stringify(base)}, name: 'Smoke Host', secret: 'local-smoke-secret'})`);
        assert.equal(created.ok, true, created.error);
        const {RoomClient, trackIdFor} = require('../src/main/services/room-client');
        const guest = new RoomClient();
        await guest.joinRoom(base, created.room.code, {name: 'Upload Friend'});
        const uploaded = await fetch(`${base}/api/rooms/${created.room.code}/uploads?position=next`, {
            method: 'POST', headers: {'Content-Type': 'application/octet-stream',
                'X-Member-Id': guest.memberId, 'X-Upload-Token': guest.uploadToken, 'X-File-Name': 'friend.wav'}, body: wav,
        });
        assert.equal(uploaded.status, 201);
        const {id} = await uploaded.json();
        let imported;
        const importDeadline = Date.now() + 10000;
        while (!imported) {
            imported = await window.webContents.executeJavaScript(`playlist.find((file) => file.endsWith(${JSON.stringify(id + '.wav')}))`);
            if (Date.now() > importDeadline) {
                const state = await window.webContents.executeJavaScript('({room, playlist, status: playlistStatus.textContent})');
                console.log('[ui-smoke] local diagnostics:', fs.readFileSync(path.join(data, 'RhythmDock', 'logs', 'diagnostics.jsonl'), 'utf8'));
                throw new Error('Guest upload did not reach the real host queue: ' + JSON.stringify(state));
            }
            if (!imported) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.deepEqual(fs.readFileSync(imported), wav);
        await new Promise((resolve) => setTimeout(resolve, 150));
        const relayed = await fetch(`${base}/api/rooms/${created.room.code}/stream/${trackIdFor(imported)}`, {
            headers: {Range: 'bytes=0-255'},
        });
        assert.equal(relayed.status, 206);
        assert.deepEqual(Buffer.from(await relayed.arrayBuffer()), wav.subarray(0, 256));
        guest.leave(); await window.webContents.executeJavaScript('window.api.roomLeave()'); server.close();
        console.log('PASS: guest audio imports into the actual desktop queue and relays identical playable bytes');
        await window.webContents.executeJavaScript(`(async () => {
            playlist = [${JSON.stringify(tonePath)}, ${JSON.stringify(secondTonePath)}];
            originalPlaylist = [...playlist];
            await playTrack(0, {startPaused: true}); savePlaybackState();
        })()`);
        const reloaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
        window.webContents.forcefullyCrashRenderer();
        await Promise.race([reloaded, new Promise((_, reject) => setTimeout(() => reject(new Error('Crash recovery timed out')), 10000))]);
        const recoveredDeadline = Date.now() + 10000;
        while (!await window.webContents.executeJavaScript('document.documentElement.dataset.appReady === "true"')) {
            if (Date.now() > recoveredDeadline) throw new Error('Crash recovery did not restore the queue');
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const recovered = await window.webContents.executeJavaScript('({queue: playlist, playing: audio.isPlaying()})');
        assert.deepEqual(recovered.queue, [tonePath, secondTonePath]);
        assert.equal(recovered.playing, false, 'crash recovery must restore paused');
        console.log('PASS: settings switch, lock, queue positions, and wall dock in the real renderer');
        app.exit(0);
    } catch (error) {
        console.error(error);
        app.exit(1);
    }
}).catch((error) => { console.error(error); app.exit(1); });
