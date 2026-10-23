'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {app, BrowserWindow, Menu, screen, ipcMain} = require('electron');
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
const largeBytes = sampleRate * 2 * 4800;
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
        await new Promise(resolve=>setTimeout(resolve,200));
        assert.equal(await window.webContents.executeJavaScript('document.getElementById("rd-heading").textContent'),'Getting started',
            'an empty first run must offer folder/server onboarding');
        await window.webContents.executeJavaScript(`document.getElementById('roadmap-dialog').close();
            window.api.setStoreValue('onboardingComplete',true);setActiveTab('player');`);
        // Exercise renderer -> preload -> main native popup wiring without showing OS UI.
        const originalPopup = Menu.prototype.popup;
        let popupRows = 0;
        let popupCalls = 0;
        let popupChoice = 81;
        Menu.prototype.popup = function (options) {
            popupCalls++;
            popupRows = this.items.length;
            setImmediate(() => {
                if (popupChoice !== null) this.items[popupChoice].click();
                options.callback();
            });
        };
        try {
            const selection = await window.webContents.executeJavaScript(`(async () => {
                const select = document.createElement('select');
                select.id = 'native-popup-fixture';
                for (let i = 0; i < 82; i++) select.add(new Option('Option ' + i, 'duplicate'));
                select.options[1].disabled = true;
                document.body.append(select);
                let changes = 0, inputs = 0;
                select.addEventListener('change', () => changes++);
                select.addEventListener('input', () => inputs++);
                select.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, cancelable:true, button:0}));
                await new Promise(resolve => setTimeout(resolve, 120));
                const result = {index: select.selectedIndex, changes, inputs,
                    collapsed: select.getAttribute('aria-expanded') === 'false'};
                return result;
            })()`);
            assert.equal(popupRows, 82);
            assert.deepEqual(selection, {index: 81, changes: 1, inputs: 1, collapsed: true});
            popupChoice = null;
            const cancelled = await window.webContents.executeJavaScript(`(async () => {
                const select = document.getElementById('native-popup-fixture');
                select.dispatchEvent(new KeyboardEvent('keydown', {key:'F4', bubbles:true, cancelable:true}));
                await new Promise(resolve => setTimeout(resolve, 120));
                const index = select.selectedIndex; return index;
            })()`);
            assert.equal(cancelled, 81);
            const beforeLocked = popupCalls;
            await window.webContents.executeJavaScript(`(async () => {
                setLocked(true);
                const select = document.getElementById('native-popup-fixture');
                select.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, cancelable:true, button:0}));
                select.dispatchEvent(new KeyboardEvent('keydown', {key:'F4', bubbles:true, cancelable:true}));
                await new Promise(resolve => setTimeout(resolve, 120));
                select.remove(); setLocked(false);
            })()`);
            assert.equal(popupCalls, beforeLocked);
            popupChoice = 6; // Heading followed by playback speeds; 1.25x is row 6.
            const speed = await window.webContents.executeJavaScript(`(async () => {
                document.getElementById('speed-btn').click();
                await new Promise(resolve => setTimeout(resolve, 120));
                const label = document.getElementById('speed-label').textContent;
                document.querySelector('[data-rate="1"]').click();
                return label;
            })()`);
            assert.equal(speed, '1.25x');
            console.log('PASS: native combobox long-list selection, duplicate values, events, cancellation and menu actions');
        } finally {
            Menu.prototype.popup = originalPopup;
        }

        const menuSwitches = await window.webContents.executeJavaScript(`(() => {
            document.getElementById('lyrics-dropdown-btn').click();
            const menu=document.getElementById('lyrics-dropdown-menu');
            const rect=menu.getBoundingClientRect();
            const fits=menu.classList.contains('show')&&rect.left>=0&&rect.top>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight;
            const button=document.getElementById('toggle-manual-scroll-btn');
            const label=button.textContent;
            const before=button.getAttribute('aria-pressed');button.click();
            const stable=button.textContent===label&&button.getAttribute('aria-pressed')!==before;
            const switchVisible=getComputedStyle(button,'::after').content!=='none';
            button.click();closeAllMenus();
            return {fits,stable,switchVisible};
        })()`);
        for(const [name,value] of Object.entries(menuSwitches))assert.equal(value,true,'menu switch '+name);
        console.log('PASS: themed menu bounds, stable toggle labels and visible switches');
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
        assert.ok(bounds.x === work.x || bounds.x + bounds.width === work.x + work.width || bounds.y === work.y,
            'docked window must touch the left, right or top edge');
        await window.webContents.executeJavaScript('window.api.edgeDockExpand(true)');
        await new Promise((resolve) => setTimeout(resolve, 350));
        assert.equal(window.getBounds().width, 220, 'hover expansion must have room for the vertical player');
        await window.webContents.executeJavaScript('window.api.setActiveTab("settings")');
        await new Promise((resolve) => setTimeout(resolve, 350));
        const panelBounds = window.getBounds();
        assert.equal(panelBounds.width, 340, 'docked settings must remain readable');
        assert.ok(panelBounds.x === work.x || panelBounds.x + panelBounds.width === work.x + work.width || panelBounds.y === work.y);
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
        const parser=require('music-metadata');
        const realParseFile=parser.parseFile;
        parser.parseFile=async(filePath,options)=>{
            if(filePath===largeTonePath)await new Promise(resolve=>setTimeout(resolve,1800));
            return realParseFile(filePath,options);
        };
        try{
            const startup=await window.webContents.executeJavaScript(`(async()=>{
                playlist=[${JSON.stringify(largeTonePath)}];originalPlaylist=[...playlist];
                const started=performance.now();let metadataDone=false;
                const loading=playTrack(0,{startAtBeginning:true}).then(()=>{metadataDone=true;});
                while(!audio.isPlaying()&&performance.now()-started<4000)await new Promise(r=>setTimeout(r,10));
                const result={startMs:performance.now()-started,playing:audio.isPlaying(),
                    beforeMetadata:!metadataDone,transportReady:currentSound===audio,duration:audio.duration()};
                audio.interrupt();await loading;return result;
            })()`);
            assert.ok(startup.playing&&startup.beforeMetadata&&startup.transportReady,JSON.stringify(startup));
            assert.ok(startup.startMs<1500,JSON.stringify(startup));
            console.log('PASS: 211 MB streamed playback starts before delayed metadata:',startup);
        }finally{parser.parseFile=realParseFile;}
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
        const libraryTools=require('../src/main/services/library-tools');
        const handle=require('../src/main/services/database').handle();
        handle.transaction(()=>{
            const insert=handle.prepare(`INSERT OR IGNORE INTO tracks(filePath,basename,title,artist,album,addedAt,lastSeenAt)
                VALUES(?,?,?,?,?,datetime('now'),datetime('now'))`);
            for(let i=0;i<10000;i++)insert.run(`virtual-${i}.mp3`,`virtual-${i}.mp3`,`Song ${String(i).padStart(5,'0')}`,'Virtual artist','Virtual album');
        })();
        const toolsCheck=await window.webContents.executeJavaScript(`(async()=>{
            const editorModel=buildEditorLines('[offset:100]\\n[00:12.00][01:44.00]<00:12.00>Hello <00:12.40>world\\nUntimed line');
            const roundTrip=processLyrics(editorLinesToLrc(editorModel));
            const lyricRoundTrip=Math.abs(roundTrip.lines[1].words[1].time-104.3)<.01&&editorModel.some(l=>l.time===null);
            await window.roadmapTools.open('Library');
            const list=document.querySelector('.rd-results');
            const first=document.querySelectorAll('.rd-track').length;
            list.scrollTop=56*9900;list.dispatchEvent(new Event('scroll'));
            await new Promise(r=>setTimeout(r,300));
            const last=document.querySelectorAll('.rd-track').length;
            const scrolled=document.querySelector('.rd-track .rd-label').textContent.includes('098');
            await window.roadmapTools.open('Appearance');
            const mode=document.querySelector('#rd-body select');mode.value='scope';
            const save=[...document.querySelectorAll('#rd-body button')].find(b=>b.textContent==='Apply and save');save.click();
            await new Promise(r=>setTimeout(r,80));
            const visual=!(document.getElementById('rd-visual').hidden);
            const unsafe=await window.api.roadmap('appearanceSave',{visualizer:'scope',css:'@import url(https://example.test)'});
            await window.roadmapTools.open('Practice');
            [...document.querySelectorAll('#rd-body button')].find(b=>b.textContent==='Read AutoEQ profile').click();
            [...document.querySelectorAll('#rd-body button')].find(b=>b.textContent==='Apply parametric EQ').click();
            await new Promise(r=>setTimeout(r,50));
            const filters=audio.insertChain.length;
            [...document.querySelectorAll('#rd-body button')].find(b=>b.textContent==='Bypass parametric EQ').click();
            const bypass=audio.insertChain.length===0;
            document.getElementById('roadmap-dialog').close();
            await window.roadmapTools.nowPlaying();
            const full=Boolean(document.querySelector('.rd-full'));
            document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
            await new Promise(r=>setTimeout(r,100));
            for(const page of ['Editor','Accounts','Broadcasts','Layouts','Settings'])await window.roadmapTools.open(page);
            document.getElementById('roadmap-dialog').close();
            return {lyricRoundTrip,first,last,scrolled,visual,unsafeRejected:!unsafe.ok,filters,bypass,full,closed:!document.querySelector('.rd-full')};
        })()`);
        console.log('[ui-smoke] embedded settings:',toolsCheck);
        assert.ok(toolsCheck.first<=40&&toolsCheck.last<=40,'10,000-song library must keep at most 40 visible track rows');
        assert.equal(toolsCheck.scrolled,true);assert.equal(toolsCheck.visual,true);assert.equal(toolsCheck.unsafeRejected,true);
        assert.equal(toolsCheck.filters,2);assert.equal(toolsCheck.bypass,true);assert.equal(toolsCheck.full,true);assert.equal(toolsCheck.closed,true);
        assert.equal(toolsCheck.lyricRoundTrip,true,'lyrics editor must preserve repeated enhanced word timing, offsets and untimed text');
        console.log('PASS: onboarding, virtual library, custom appearance, parametric EQ and Now Playing:',toolsCheck);
        const openBehavior=await window.webContents.executeJavaScript(`(async()=>{
            const waitReady=async()=>{for(let n=0;n<100&&audio.isBusy();n++)await new Promise(r=>setTimeout(r,20));};
            await loadPlaylistAndPlay([${JSON.stringify(largeTonePath)}],0,{startPaused:true});await waitReady();
            audio.seek(123);savePlaybackState();
            await window.api.bookPositionGet(${JSON.stringify(largeTonePath)});
            await loadPlaylistAndPlay([${JSON.stringify(tonePath)}],0,{startPaused:true});await waitReady();
            await loadPlaylistAndPlay([${JSON.stringify(largeTonePath)}],0,{startPaused:true});await waitReady();
            const resumed=Math.abs(audio.seek()-123)<1;
            await loadPlaylistAndPlay([${JSON.stringify(largeTonePath)}],0,{startPaused:true});await waitReady();
            const restarted=audio.seek()<1;
            const before=audio.ticket;
            document.getElementById('queue-mode').checked=true;
            document.getElementById('queue-mode').dispatchEvent(new Event('change'));
            const files=Array.from({length:20},(_,i)=>'batch-'+i+'.mp3');
            await loadPlaylistAndPlay(files);
            const queued=audio.ticket===before&&!audio.isPlaying()&&files.every((f,i)=>playlist[currentIndex+1+i]===f);
            document.getElementById('queue-mode').checked=false;
            document.getElementById('queue-mode').dispatchEvent(new Event('change'));
            lyricsSelectable=false;isManualScrollEnabled=false;applyLyricsInteraction();
            document.getElementById('toggle-lyrics-selection-btn').click();
            const selection=getComputedStyle(lyricsContainer).userSelect==='text';
            document.getElementById('toggle-manual-scroll-btn').click();
            const manual=isManualScrollEnabled&&getComputedStyle(lyricsContainer).overflowY==='auto';
            document.getElementById('toggle-lyrics-selection-btn').click();
            document.getElementById('toggle-manual-scroll-btn').click();
            return {resumed,restarted,queued,selection,manual};
        })()`);
        console.log('[ui-smoke] file and lyric controls:', openBehavior);
        for(const [name,value] of Object.entries(openBehavior))assert.equal(value,true,name);
        const originalSaveDialog=require('electron').dialog.showSaveDialog;
        const lyricExportPath=path.join(scratch,'exported.lrc');
        try {
            require('electron').dialog.showSaveDialog=async()=>({filePath:lyricExportPath,canceled:false});
            const exported=await window.webContents.executeJavaScript(`window.api.exportLyrics({title:'Test',synced:true,text:'[00:01.00]Hello'})`);
            assert.equal(exported.ok,true);
            assert.equal(fs.readFileSync(lyricExportPath,'utf8'),'[00:01.00]Hello');
        } finally {require('electron').dialog.showSaveDialog=originalSaveDialog;}
        console.log('PASS: long-track resume, reopen restart, 20-file queue mode, selectable lyrics, manual scroll and LRC export');
        const abChecks=await window.webContents.executeJavaScript(`(()=>{
            const range=document.getElementById('ab-range');
            audio.clearLoop();pendingLoopStart=null;audio.seek(100);cycleAbRepeat();
            const start=range.classList.contains('visible')&&range.classList.contains('pending');
            audio.seek(140);cycleAbRepeat();
            const selected=range.classList.contains('visible')&&!range.classList.contains('pending')&&parseFloat(range.style.width)>0;
            const visible=Number(getComputedStyle(range).zIndex)>Number(getComputedStyle(progressBar).zIndex)&&range.parentElement===progressBar.parentElement;
            const themed=getComputedStyle(range).backgroundColor!=='rgba(0, 0, 0, 0)';
            cycleAbRepeat();return {start,selected,visible,themed,cleared:!range.classList.contains('visible')};
        })()`);
        for(const [name,value] of Object.entries(abChecks))assert.equal(value,true,'A-B '+name);
        console.log('PASS: A marker, completed loop range, theme color, progress overlay stacking and clearing');
        const interruptionChecks=await window.webContents.executeJavaScript(`(async()=>{
            const wait=()=>new Promise(r=>setTimeout(r,70));
            audio.seek(90);await audio.play();await wait();
            const position=audio.seek();setLocked(true);handleMediaCommand('pause');await wait();
            const lockedPause=!audio.isPlaying()&&Math.abs(audio.seek()-position)<.5;
            setLocked(false);await audio.play();await wait();
            await audio.ctx.suspend();await wait();
            const focusPause=!audio.isPlaying();await audio.ctx.resume();await wait();
            const noResume=!audio.isPlaying();await audio.play();await wait();
            return {lockedPause,focusPause,noResume};
        })()`);
        for(const [name,value] of Object.entries(interruptionChecks))assert.equal(value,true,name);
        window.webContents.send('audio-interruption',{reason:'communication'});
        await new Promise(r=>setTimeout(r,80));
        assert.equal(await window.webContents.executeJavaScript('audio.isPlaying()'),false);
        await window.webContents.executeJavaScript('audio.play()');
        require('electron').powerMonitor.emit('suspend');
        await new Promise(r=>setTimeout(r,80));
        assert.equal(await window.webContents.executeJavaScript('audio.isPlaying()'),false);
        console.log('PASS: locked system pause, real audio-context interruption, no automatic resume, call IPC and system-sleep pause');
        // Exercise the real link IPC, playback and save dialog using tagged local audio.
        const tools=require('node:child_process');
        const ffmpeg=process.env.FFMPEG_TEST_BINARY||'ffmpeg';
        const ffmpegAvailable=tools.spawnSync(ffmpeg,['-version'],{windowsHide:true}).status===0;
        if(ffmpegAvailable){
            const platformAudio=require('../src/main/services/platform-audio');
            const realDownload=platformAudio.download;
            const cacheDir=path.join(require('../src/main/core/paths').getDataRoot(),'platform-cache','fixture');
            fs.mkdirSync(cacheDir,{recursive:true});
            const tagged=path.join(cacheDir,'Artist - Fixture.mp3');
            tools.execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-i',tonePath,'-metadata','title=Fixture Title',
                '-metadata','artist=Fixture Artist','-metadata','album=Fixture Album','-id3v2_version','3',tagged],{windowsHide:true});
            const exportedMp3=path.join(scratch,'downloaded-fixture.mp3');
            try{
                platformAudio.download=async()=>({files:[tagged],errors:[],provider:'youtube',cached:false});
                require('electron').dialog.showSaveDialog=async()=>({filePath:exportedMp3,canceled:false});
                const linkPlayed=await window.webContents.executeJavaScript(`(async()=>{
                    document.getElementById('remote-audio-url').value='https://youtu.be/abcdefghijk';
                    document.getElementById('remote-audio-play').click();
                    for(let n=0;n<150&&document.getElementById('remote-audio-play').disabled;n++)await new Promise(r=>setTimeout(r,20));
                    return currentSongData?.title==='Fixture Title'&&playlist.length===1;
                })()`);
                assert.equal(linkPlayed,true);
                const download=await window.webContents.executeJavaScript(`window.api.remoteAudioDownload(${JSON.stringify(tagged)})`);
                assert.equal(download.ok,true,download.error);
                const metadata=await require('music-metadata').parseFile(exportedMp3);
                assert.equal(metadata.common.title,'Fixture Title');assert.equal(metadata.common.artist,'Fixture Artist');
                assert.equal(metadata.common.album,'Fixture Album');
                assert.deepEqual(fs.readFileSync(tagged),fs.readFileSync(exportedMp3));
                console.log('PASS: platform link IPC, Play Link UI and downloaded MP3 retains title, artist, album and original bytes');
            }finally{
                platformAudio.download=realDownload;
                require('electron').dialog.showSaveDialog=originalSaveDialog;
            }
        }else console.log('SKIP: FFmpeg missing; tagged platform export fixture unavailable');
        const libraryStore=require('../src/main/services/library-store');
        const sourceRoot=libraryStore.addRoot(path.join(scratch,'music-sources'));
        const insertSource=handle.prepare(`INSERT INTO tracks(filePath,rootId,basename,title,artist,album,durationSeconds,missing,addedAt,lastSeenAt)
            VALUES(?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`);
        insertSource.run('source-long.mp3',sourceRoot.id,'source-long.mp3','Zulu Episode','Host','Podcast',600);
        insertSource.run('source-short.mp3',sourceRoot.id,'source-short.mp3','Alpha Song','Singer','Album',180);
        const sourceList=libraryStore.createPlaylist('Browse fixture',['source-long.mp3','source-short.mp3']);
        const browseChecks=await window.webContents.executeJavaScript(`(async()=>{
            const filter=document.getElementById('playlist-filter'),sort=document.getElementById('playlist-sort');
            const titles=()=>[...playlistResults.querySelectorAll('.playlist-row-title')].map(el=>el.textContent);
            activeLibraryView='all';librarySearchInput.value='';filter.value='all';sort.value='title';
            await renderActiveLibraryView();
            const all=playlistResults.querySelectorAll('.playlist-row').length===2&&playlistResults.textContent.indexOf('Alpha Song')<playlistResults.textContent.indexOf('Zulu Episode');
            filter.value='long';await renderActiveLibraryView();
            const duration=playlistResults.querySelectorAll('.playlist-row').length===1&&playlistResults.textContent.includes('Zulu Episode');
            filter.value='all';librarySearchInput.value='Singer';await renderActiveLibraryView();
            const search=playlistResults.querySelectorAll('.playlist-row').length===1&&playlistResults.textContent.includes('Alpha Song');
            playlist=['source-long.mp3','source-short.mp3'];originalPlaylist=[...playlist];currentIndex=0;
            activeLibraryView='queue';librarySearchInput.value='';sort.value='title';await renderActiveLibraryView();
            const sorted=playlistResults.textContent.indexOf('Alpha Song')<playlistResults.textContent.indexOf('Zulu Episode')&&playlist[0]==='source-long.mp3';
            librarySearchInput.value='Singer';await renderActiveLibraryView();
            const scoped=playlistResults.querySelectorAll('.playlist-row').length===1&&playlistResults.textContent.includes('Alpha Song');
            activeLibraryView='named';namedPlaylistId=${JSON.stringify(sourceList.id)};
            await renderActiveLibraryView();
            const named=playlistResults.querySelectorAll('.playlist-row').length===1&&playlistResults.textContent.includes('Alpha Song');
            librarySearchInput.value='';filter.value='liked';favoritesPlaylist.push('source-long.mp3');
            await renderActiveLibraryView();
            const liked=playlistResults.querySelectorAll('.playlist-row').length===1&&playlistResults.textContent.includes('Zulu Episode');
            favoritesPlaylist=favoritesPlaylist.filter(path=>path!=='source-long.mp3');
            librarySearchInput.value='';filter.value='all';sort.value='original';activeLibraryView='queue';
            setActiveTab('player');isMagnifierEnabled=true;updateMagnifierUI();positionAlbumArtPreview();
            const popup=document.getElementById('magnifier-popup');popup.style.display='block';
            const rect=popup.getBoundingClientRect();
            const preview=rect.top>=15&&rect.left>=15&&rect.right<=innerWidth-15&&rect.bottom<=innerHeight-15;
            popup.style.display='';
            const volume=document.querySelector('.volume-control-wrapper');volume.classList.add('dragging');
            const box=volume.querySelector('.volume-slider-popup').getBoundingClientRect();
            const bridge=getComputedStyle(volume.querySelector('.volume-slider-popup'),'::after');
            const connected=parseFloat(bridge.height)>=volume.getBoundingClientRect().top-box.bottom;
            volume.classList.remove('dragging');
            return {all,duration,search,sorted,scoped,named,liked,preview,connected};
        })()`);
        const volumeTravel = await window.webContents.executeJavaScript(`(async () => {
            setActiveTab('player');
            const wrapper = document.querySelector('.volume-control-wrapper');
            const popup = wrapper.querySelector('.volume-slider-popup');
            const button = wrapper.getBoundingClientRect();
            const origin = {clientX:button.left+button.width/2,clientY:button.top+button.height/2};
            wrapper.dispatchEvent(new PointerEvent('pointerenter', origin));
            const rect = popup.getBoundingClientRect();
            wrapper.dispatchEvent(new PointerEvent('pointerleave', origin));
            // Diagonal travel from the button toward the slider's far left end.
            document.dispatchEvent(new PointerEvent('pointermove', {
                clientX:(origin.clientX+rect.left+6)/2,
                clientY:(origin.clientY+rect.bottom-2)/2,bubbles:true}));
            await new Promise(resolve => setTimeout(resolve, 300));
            const diagonal = wrapper.classList.contains('pointer-open') && getComputedStyle(popup).display !== 'none';
            popup.dispatchEvent(new PointerEvent('pointerenter', {clientX:rect.left+8,clientY:rect.top+8}));
            wrapper.dispatchEvent(new PointerEvent('pointerenter', {clientX:rect.left+8,clientY:rect.top+8}));
            const reached = wrapper.classList.contains('pointer-open');
            wrapper.dispatchEvent(new PointerEvent('pointerleave', {clientX:rect.left+8,clientY:rect.top+8}));
            document.dispatchEvent(new PointerEvent('pointermove', {clientX:0,clientY:window.innerHeight-1,bubbles:true}));
            await new Promise(resolve => setTimeout(resolve, 300));
            return {diagonal,reached,closed:!wrapper.classList.contains('pointer-open')};
        })()`);
        for (const [name, value] of Object.entries(volumeTravel)) assert.equal(value, true, 'volume pointer ' + name);
        console.log('PASS: volume popup survives diagonal pointer travel and closes after moving away');
        // Navigation must follow the window, while pages stop above it.
        for (const tab of ['player','playlist','settings','playlist-options']) {
            await window.webContents.executeJavaScript(`setActiveTab('${tab}');containerEl.classList.add('lyrics-hidden');`);
            await new Promise(resolve => setTimeout(resolve, 120));
            window.setSize(660, 560);
            await new Promise(resolve => setTimeout(resolve, 120));
            const layout = await window.webContents.executeJavaScript(`(() => {
                const nav=document.getElementById('tab-pager').getBoundingClientRect();
                const page=document.querySelector('#tab-settings.show,#playlist-panel.show,#tab-playlist-options.show');
                const labels=[...document.querySelectorAll('.tab-btn-label')];
                return {bottom:window.innerHeight-nav.bottom,
                    overlap:page ? page.getBoundingClientRect().bottom>nav.top : false,
                    labels:labels.every(label=>getComputedStyle(label).display!=='none'),
                    aligned:Math.abs(containerEl.getBoundingClientRect().left)<1&&containerEl.scrollLeft===0};
            })()`);
            assert.ok(layout.bottom>=0&&layout.bottom<20, tab+' bottom navigation');
            assert.equal(layout.overlap,false,tab+' content stays above navigation');
            assert.equal(layout.labels,true,tab+' visible tab labels');
            assert.equal(layout.aligned,true,tab+' no horizontal page shift');
        }
        const pageFlows=await window.webContents.executeJavaScript(`(async()=>{
            setActiveTab('playlist');
            document.getElementById('playlist-options-open').click();
            const options=activeTab==='playlist-options' && document.getElementById('remote-audio-url').closest('#tab-playlist-options')!==null;
            document.getElementById('playlist-options-back').click();
            const back=activeTab==='playlist';
            const row=makeRow({filePath:${JSON.stringify(secondTonePath)},title:'Second song',onPlay:()=>{}});
            playlistResults.append(row);row.querySelector('[title="Edit tags"]').click();
            await new Promise(resolve=>setTimeout(resolve,150));
            const chosen=tagsLoadedPath===${JSON.stringify(secondTonePath)} && activeTab==='tags';
            await loadTagsForCurrentTrack();
            const pinned=tagsLoadedPath===${JSON.stringify(secondTonePath)};
            document.getElementById('tags-close').click();
            const tagBack=activeTab==='playlist';
            document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true,cancelable:true}));
            const settings=activeTab==='settings'&&!document.getElementById('roadmap-dialog').open;
            await window.roadmapTools.open('Appearance');
            const embedded=document.getElementById('roadmap-dialog').parentElement.id==='tab-settings' && !document.querySelector('dialog:modal');
            document.getElementById('roadmap-dialog').close();
            return {options,back,chosen,pinned,tagBack,settings,embedded};
        })()`);
        for(const [name,value] of Object.entries(pageFlows))assert.equal(value,true,'page flow '+name);
        console.log('PASS: bottom labelled tabs after resizing, separate playlist options, per-song tags and embedded settings');
        if(process.env.RHYTHM_TEST_EXTRA_FORMATS){
            const tools=require('../src/main/services/media-tools');
            const executable=process.env.FFMPEG_TEST_BINARY||'ffmpeg';
            for(const [extension,codec]of [['m4a','alac'],['aif','pcm_s16be'],['wma','wmav2'],['webm','libopus'],['mka','flac'],['wv','wavpack'],['tta','tta']]){
                const source=path.join(scratch,'playback-'+codec+'.'+extension);
                await tools.run(executable,['-hide_banner','-nostdin','-i',tonePath,'-c:a',codec,source]);
                const played=await window.webContents.executeJavaScript(`(async()=>{
                    await loadPlaylistAndPlay([${JSON.stringify(source)}]);
                    const until=Date.now()+5000;
                    while(audio.element.readyState<3&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,30));
                    audio.seek(.3);await new Promise(resolve=>setTimeout(resolve,100));
                    const result={ready:audio.element.readyState>=3,playing:audio.isPlaying(),seek:audio.seek()>=.25,
                        original:currentSongData.filePath===${JSON.stringify(source)}};
                    audio.pause();return result;
                })()`);
                for(const [name,value]of Object.entries(played))assert.equal(value,true,extension+' actual Electron '+name);
            }
            console.log('PASS: real Electron playback, seeking and original file identity for ALAC, AIF, WMA, WebM, MKA, WV and TTA');
        }
        if(process.env.RHYTHM_UI_SCREENSHOTS){
            await window.webContents.executeJavaScript(`window.api.toggleOrientation(false)`);
            await new Promise(resolve=>setTimeout(resolve,300));
            await window.webContents.executeJavaScript(`{
                const style=document.createElement('style');style.textContent='*{transition:none!important;animation:none!important}';document.head.append(style);
            }`);
            for(const tab of ['playlist','playlist-options','settings']){
                await window.webContents.executeJavaScript(`setActiveTab('${tab}')`);
                await new Promise(resolve=>setTimeout(resolve,500));
                await window.webContents.capturePage();
                await new Promise(resolve=>setTimeout(resolve,100));
                const image=await window.webContents.capturePage();
                const target=path.join(scratch,tab+'.png');fs.writeFileSync(target,image.toPNG());console.log('UI screenshot:',target);
            }
        }
        console.log('[ui-smoke] playlist browsing and popovers:',browseChecks);
        for(const [name,value] of Object.entries(browseChecks))assert.equal(value,true,name);
        for(const [hovered,dragging,locked,saved,expected] of [
            [true,false,false,.5,.85],[true,true,false,.4,.4],
            [true,false,true,.5,.5],[false,false,false,.5,.5],[true,false,false,.8,.8],
        ]){
            await window.webContents.executeJavaScript(`savedWindowOpacity=${saved};opacityHovered=${hovered};opacityDragging=${dragging};isLocked=${locked};refreshWindowOpacity();`);
            await new Promise(resolve=>setTimeout(resolve,30));
            if(process.platform!=='linux')assert.ok(Math.abs(window.getOpacity()-expected)<.01,'hover opacity policy');
        }
        await window.webContents.executeJavaScript(`savedWindowOpacity=.85;opacityHovered=false;opacityDragging=false;isLocked=false;refreshWindowOpacity();`);
        console.log('PASS: opacity hover boost, slider preview, lock behavior, pointer exit and 80 percent threshold');
        const playlistLabel=await window.webContents.executeJavaScript(`(async()=>{
            await loadPlaylistAndPlay([${JSON.stringify(tonePath)}],0,{startPaused:true,playlistName:'My Evening Mix'});
            const named=document.getElementById('current-playlist-name').textContent==='My Evening Mix';
            setActiveTab('player');document.getElementById('current-playlist').click();
            const opensQueue=activeTab==='playlist'&&activeLibraryView==='queue';
            savePlaybackState();
            const saved=await window.api.getStoreValue('lastPlaybackState');
            return {named,opensQueue,persisted:saved.playlistName==='My Evening Mix'};
        })()`);
        for(const [name,value] of Object.entries(playlistLabel))assert.equal(value,true,name);
        console.log('PASS: current playlist name, queue navigation and saved playlist context');
        const unavailableCheck=await window.webContents.executeJavaScript(`(async()=>{
            const missing=${JSON.stringify(path.join(scratch,'missing-track.mp3'))};
            playlist=[${JSON.stringify(tonePath)},missing];originalPlaylist=[...playlist];currentIndex=0;
            activeLibraryView='queue';librarySearchInput.value='';
            document.getElementById('playlist-sort').value='original';document.getElementById('playlist-filter').value='all';
            renderQueue();await refreshPlaylistFileStatus();
            const rows=[...playlistResults.querySelectorAll('.playlist-row')];
            const missingRed=rows[1].classList.contains('unavailable')&&rows[1].textContent.includes('skipped');
            const readableNormal=!rows[0].classList.contains('unavailable');
            markPlaylistTrackFailed(${JSON.stringify(tonePath)});renderQueue();await refreshPlaylistFileStatus();
            const failureRetained=playlistResults.querySelector('.playlist-row').classList.contains('unavailable');
            const removeAvailable=Boolean(playlistResults.querySelectorAll('.playlist-row')[1].querySelector('.playlist-row-action'));
            failedPlaylistTracks.delete(${JSON.stringify(tonePath)});
            return {missingRed,readableNormal,failureRetained,removeAvailable};
        })()`);
        for(const [name,value] of Object.entries(unavailableCheck))assert.equal(value,true,name);
        console.log('PASS: missing tracks red, readable tracks normal, failed status survives redraw and removal stays available');
        const virtualQueueCheck=await window.webContents.executeJavaScript(`(async()=>{
            playlist=Array.from({length:10000},(_,i)=>'queue-'+i+'.mp3');originalPlaylist=[...playlist];currentIndex=500;
            activeLibraryView='queue';librarySearchInput.value='';setActiveTab('playlist');renderQueue();
            playlistResults.scrollTop=44*9900;playlistResults.dispatchEvent(new Event('scroll'));
            const rows=[...playlistResults.querySelectorAll('.playlist-row')],count=rows.length;
            const source=Number(rows[0].dataset.queueIndex),target=Number(rows[1].dataset.queueIndex),before=playlist[source];
            const transfer=new DataTransfer();rows[0].dispatchEvent(new DragEvent('dragstart',{dataTransfer:transfer,bubbles:true}));
            rows[1].dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));
            const moved=playlist[target]===before,playingTrack=playlist[currentIndex]==='queue-500.mp3';
            await window.roadmapTools.palette();
            const palette=activeTab==='settings'&&!document.getElementById('roadmap-dialog').open&&document.querySelectorAll('[data-settings-page]').length>=9;
            const tree=await window.api.roadmap('folderChildren','');
            return {count,source,moved,playingTrack,palette,tree:tree.ok};
        })()`);
        assert.ok(virtualQueueCheck.count<=40&&virtualQueueCheck.source>9800);assert.equal(virtualQueueCheck.moved,true);
        assert.equal(virtualQueueCheck.playingTrack,true);assert.equal(virtualQueueCheck.palette,true);assert.equal(virtualQueueCheck.tree,true);
        await window.webContents.executeJavaScript('audio.pause();playlist=[];originalPlaylist=[];currentIndex=-1;');
        window.webContents.send('launch-files',{files:[tonePath,secondTonePath],enqueue:true});
        await new Promise(r=>setTimeout(r,400));
        const launch=await window.webContents.executeJavaScript('({queue:playlist,playing:audio.isPlaying()})');
        assert.deepEqual(launch.queue,[tonePath,secondTonePath]);assert.equal(launch.playing,false);
        const episodeUrl='https://audio.example.test/episode.mp3';
        assert.equal((await window.webContents.executeJavaScript(`window.api.roadmap('podcastPositionSet',{url:${JSON.stringify(episodeUrl)},seconds:12.5})`)).ok,true);
        assert.equal((await window.webContents.executeJavaScript(`window.api.roadmap('podcastPositionGet',${JSON.stringify(episodeUrl)})`)).data,12.5);
        const radioServer=require('node:http').createServer((_req,res)=>{
            res.writeHead(200,{'Content-Type':'audio/wav','Content-Length':wav.length,'Access-Control-Allow-Origin':'*'});res.end(wav);
        });
        await new Promise(r=>radioServer.listen(0,'127.0.0.1',r));
        try {
            const radioUrl=`http://127.0.0.1:${radioServer.address().port}/radio.wav`;
            await window.webContents.executeJavaScript(`window.roadmapTools.playRadio({url:${JSON.stringify(radioUrl)},title:'Fixture radio'})`);
            let radio;const until=Date.now()+5000;
            do {await new Promise(r=>setTimeout(r,100));radio=await window.webContents.executeJavaScript('({playing:audio.isPlaying(),seconds:audio.seek(),title:currentSongData.title,empty:playlist.length===0})');
            } while((!radio.playing||radio.seconds<.1)&&Date.now()<until);
            assert.ok(radio.playing&&radio.seconds>.1,'a direct radio stream must play through the real engine');
            assert.equal(radio.title,'Fixture radio');assert.equal(radio.empty,true);
            const blocked=await window.webContents.executeJavaScript(`window.api.roomCreate({serverUrl:'http://127.0.0.1:1'})`);
            assert.equal(blocked.ok,false);assert.match(blocked.error,/local song/);
            await window.webContents.executeJavaScript(`loadPlaylistAndPlay([${JSON.stringify(tonePath)}],0,{startPaused:true})`);
        } finally {radioServer.closeAllConnections();await new Promise(r=>radioServer.close(r));}
        console.log('PASS: 10,000-track queue windowing, actual drag/drop handlers, paused CLI batch, podcast resume and real streamed radio');
        const organizeSource=path.join(scratch,'organize.wav'),organizeDestination=path.join(scratch,'organized');
        fs.writeFileSync(organizeSource,wav);fs.mkdirSync(organizeDestination);
        handle.prepare(`INSERT INTO tracks(filePath,basename,title,addedAt,lastSeenAt) VALUES(?,?,?,datetime('now'),datetime('now'))`)
            .run(organizeSource,'organize.wav','Organize fixture');
        libraryTools.bookmark({filePath:organizeSource,seconds:1,label:'Preserved bookmark'});
        await window.webContents.executeJavaScript(`playlist=[${JSON.stringify(organizeSource)}];originalPlaylist=[...playlist];currentIndex=-1;`);
        const organize=await window.webContents.executeJavaScript(`window.api.roadmap('filePreview',{files:[${JSON.stringify(organizeSource)}],mode:'organise',destination:${JSON.stringify(organizeDestination)},template:'Moved song'})`);
        assert.equal(organize.ok,true,organize.error);const movedPath=organize.data.rows[0].target;
        const applied=await window.webContents.executeJavaScript(`window.api.roadmap('fileApply',${JSON.stringify(organize.data.id)})`);
        assert.equal(applied.ok,true,applied.error);assert.equal(applied.data.state,'done');
        await new Promise(r=>setTimeout(r,100));
        assert.deepEqual(await window.webContents.executeJavaScript('playlist'),[movedPath]);
        assert.equal(libraryTools.bookmarks(movedPath)[0].label,'Preserved bookmark');
        assert.ok(handle.prepare('SELECT rootId FROM tracks WHERE filePath=?').get(movedPath).rootId);
        const undone=await window.webContents.executeJavaScript(`window.api.roadmap('fileUndo',${JSON.stringify(organize.data.id)})`);
        assert.equal(undone.ok,true,undone.error);assert.deepEqual(fs.readFileSync(organizeSource),wav);
        await new Promise(r=>setTimeout(r,100));
        assert.deepEqual(await window.webContents.executeJavaScript('playlist'),[organizeSource]);
        assert.equal(libraryTools.bookmarks(organizeSource)[0].label,'Preserved bookmark');
        console.log('PASS: real organizer IPC updates the library root, bookmarks and live queue, and undo restores original audio');
        if(process.env.FFMPEG_TEST_BINARY){
            const shape=await window.webContents.executeJavaScript(`window.api.roadmap('waveform',${JSON.stringify(tonePath)})`);
            assert.equal(shape.ok,true,shape.error);assert.equal(shape.data.peaks.length,512);
            const cachedShape=await window.webContents.executeJavaScript(`window.api.roadmap('waveform',${JSON.stringify(tonePath)})`);
            assert.equal(cachedShape.data.cached,true);
        }
        process.env.PORT = '0'; process.env.HOST = '127.0.0.1';
        process.env.CREATE_SECRET = 'local-smoke-secret'; process.env.TELEGRAM_BOT_TOKEN = '';
        process.env.ROOM_STATE_FILE='';process.env.CRASH_REPORTS_DIR=path.join(scratch,'crash-reports');
        const {server} = require('../../server/src/index');
        if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
        const localServerUrl=`http://127.0.0.1:${server.address().port}`;
        const health=await window.webContents.executeJavaScript(`window.api.roadmap('serverCheck',${JSON.stringify(localServerUrl)})`);
        assert.equal(health.ok,true,health.error);
        assert.equal((await window.webContents.executeJavaScript(`window.api.roadmap('crashReportTest')`)).data,false,'reporting must be disabled by default');
        const endpoint=localServerUrl+'/api/crash-reports';
        const config=await window.webContents.executeJavaScript(`window.api.roadmap('crashConfigSave',{enabled:true,endpoint:${JSON.stringify(endpoint)}})`);
        assert.equal(config.ok,true,config.error);
        assert.equal((await window.webContents.executeJavaScript(`window.api.roadmap('crashReportTest')`)).data,true);
        const reportFiles=fs.readdirSync(process.env.CRASH_REPORTS_DIR);assert.equal(reportFiles.length,1);
        const reportBody=fs.readFileSync(path.join(process.env.CRASH_REPORTS_DIR,reportFiles[0]),'utf8');
        assert.ok(!reportBody.includes(scratch)&&!reportBody.includes('token')&&!reportBody.includes('secret'));
        await window.webContents.executeJavaScript(`window.api.roadmap('crashConfigSave',{enabled:false,endpoint:''})`);
        const base = `http://127.0.0.1:${server.address().port}`;
        await window.webContents.executeJavaScript('playlist = []; originalPlaylist = []; currentIndex = -1; savePlaybackState();');
        const created = await window.webContents.executeJavaScript(`window.api.roomCreate({
            serverUrl: ${JSON.stringify(base)}, name: 'Smoke Host', secret: 'local-smoke-secret'})`);
        assert.equal(created.ok, true, created.error);
        const savedHost=await window.webContents.executeJavaScript('window.api.roomSavedHost()');
        if(created.resumeSaved){assert.equal(savedHost.code,created.room.code);assert.equal(savedHost.hostToken,undefined);
            const settingsFile=path.join(data,'RhythmDock','config','config.json');
            assert.ok(!fs.readFileSync(settingsFile,'utf8').includes(created.room.hostToken),'the saved host token must not be plaintext');}
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
        assert.equal(await window.webContents.executeJavaScript('window.api.roomSavedHost()'),null,'explicit Leave must forget the saved host');
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
        await window.webContents.executeJavaScript(`(async()=>{
            await window.api.setMinimizeToTray(true);
            await audio.play();
        })()`);
        await new Promise(resolve=>setTimeout(resolve,120));
        const beforeClose=await window.webContents.executeJavaScript('({playing:audio.isPlaying(),time:audio.seek()})');
        assert.equal(beforeClose.playing,true);
        window.close();
        assert.equal(window.isDestroyed(),false,'close-to-tray keeps the renderer alive');
        assert.equal(window.isVisible(),false);
        await new Promise(resolve=>setTimeout(resolve,120));
        const afterClose=await window.webContents.executeJavaScript('({playing:audio.isPlaying(),time:audio.seek()})');
        assert.equal(afterClose.playing,true,'closing to tray must not pause playback');
        assert.ok(afterClose.time>=beforeClose.time);
        const persisted=await window.webContents.executeJavaScript('window.api.getMinimizeToTray()');
        assert.equal(persisted,true);
        await window.webContents.executeJavaScript('window.api.setMinimizeToTray(false)');
        console.log('PASS: close-to-tray preserves the live window, playback and persisted setting');
        console.log('PASS: settings switch, lock, queue positions, and wall dock in the real renderer');
        app.exit(0);
    } catch (error) {
        console.error(error);
        app.exit(1);
    }
}).catch((error) => { console.error(error); app.exit(1); });
