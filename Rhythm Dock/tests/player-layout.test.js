'use strict';

// Real renderer geometry and control preservation, with an isolated profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {app, BrowserWindow, ipcMain} = require('electron');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rhythm-player-layout-'));
app.setPath('appData', scratch);
app.setPath('userData', path.join(scratch, 'profile'));
BrowserWindow.prototype.show = function () {};
const Database = require('better-sqlite3');
fs.mkdirSync(app.getPath('userData'), {recursive:true});
fs.writeFileSync(path.join(app.getPath('userData'),'config.json'),JSON.stringify({onboardingComplete:true}));
const isolatedDb = new Database(path.join(app.getPath('userData'), 'lyrics.db'));
isolatedDb.exec('CREATE TABLE smoke_marker (id INTEGER PRIMARY KEY)');
isolatedDb.close();
const ready = new Promise(resolve => ipcMain.once('renderer-ready', resolve));
process.argv.splice(1);
require('../src/main/index');

app.whenReady().then(async () => {
    try {
        await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Renderer timeout')), 20000))]);
        const window = BrowserWindow.getAllWindows()[0];
        window.webContents.setBackgroundThrottling(false);
        for(let i=0;i<100;i++) {
            if(await window.webContents.executeJavaScript('document.documentElement.dataset.appReady === "true"')) break;
            await new Promise(resolve=>setTimeout(resolve,50));
        }
        await window.webContents.executeJavaScript(`document.getElementById('roadmap-dialog')?.close();
            window.api.setStoreValue('onboardingComplete',true);
            setActiveTab('player');
            document.documentElement.style.setProperty('--dur','0ms');
            const style=document.createElement('style');style.textContent='*{transition:none!important;animation:none!important}';document.head.append(style);`);
        // Allow the asynchronous Player tab resize to settle before setting test bounds.
        await new Promise(resolve=>setTimeout(resolve,350));
        for (const mode of ['vertical','dock','horizontal','stick','vertical','horizontal']) {
            assert.equal(await window.webContents.executeJavaScript(`window.api.selectViewMode('${mode}')`), mode);
            await new Promise(resolve=>setTimeout(resolve,80));
            const selection = await window.webContents.executeJavaScript(`(async()=>{
                await refreshViewModeSelection();
                return [...document.querySelectorAll('[data-view-mode][aria-checked="true"]')].map(button=>button.dataset.viewMode);
            })()`);
            assert.deepEqual(selection,[mode],'View marks exactly the active mode');
        }
        console.log('PASS: all four View choices, transitions from Stick and current-mode selection');
        for(const tab of ['player','playlist','settings']) {
            await window.webContents.executeJavaScript(`setActiveTab('${tab}')`);
            await new Promise(resolve=>setTimeout(resolve,350));
            window.setContentSize(500,420);
            await window.webContents.executeJavaScript("containerEl.classList.remove('vertical-mode','edge-docked','collapsed')");
            await window.webContents.capturePage();
            const header = await window.webContents.executeJavaScript(`(()=>{
                const name=document.getElementById('filename'),bar=document.querySelector('.header-bar');
                const r=name.getBoundingClientRect(),b=bar.getBoundingClientRect();
                const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
                return {drag:getComputedStyle(name).webkitAppRegion,bar:getComputedStyle(bar).webkitAppRegion,
                    button:getComputedStyle(document.getElementById('close-btn')).webkitAppRegion,
                    hit:hit===name,height:r.height>=b.height-parseFloat(getComputedStyle(bar).paddingBottom)-1};
            })()`);
            assert.deepEqual(header,{drag:'drag',bar:'drag',button:'no-drag',hit:true,height:true},tab+' filename drag region: '+JSON.stringify(header));
        }
        await window.webContents.executeJavaScript("setActiveTab('player')");
        await new Promise(resolve=>setTimeout(resolve,350));
        const ids = ['prev-btn','play-pause-btn','next-btn','volume-btn','volume-slider','shuffle-btn','loop-btn',
            'ab-repeat-btn','like-btn','file-dropdown-btn','speed-btn','lyrics-dropdown-btn','app-dropdown-btn',
            'pin-btn','lock-btn','minimize-btn','close-btn','progress-bar','current-playlist',
            'lyrics-offset-minus-btn','lyrics-offset-plus-btn','translate-toggle-btn','chapter-select'];
        for (const [name,width,height,vertical,collapsed] of [
            ['horizontal',380,360,false,false], ['dock',380,260,false,false],
            ['vertical',220,560,true,false], ['edge-expanded',220,420,true,false],
            ['stick',48,420,true,true], ['stick-top',420,48,true,true],
        ]) {
            window.setMinimumSize(collapsed ? 48 : 105,collapsed ? 48 : 110);
            window.setContentSize(width,height);
            await window.webContents.executeJavaScript(`containerEl.dataset.activeTab='player';
                containerEl.dataset.edgeSide='${name === 'stick-top' ? 'top' : 'right'}';
                containerEl.classList.toggle('vertical-mode',${vertical});
                containerEl.classList.toggle('edge-docked',${name.startsWith('edge') || collapsed});
                containerEl.classList.toggle('collapsed',${collapsed});`);
            await new Promise(resolve=>setTimeout(resolve,150));
            // Hidden Chromium windows can defer viewport updates until a frame is requested.
            await window.webContents.capturePage();
            const checks = await window.webContents.executeJavaScript(`(() => {
                const ids=${JSON.stringify(ids)};
                const missing=ids.filter(id=>!document.getElementById(id));
                const visibleIds=${JSON.stringify(collapsed?['edge-exit','edge-prev','edge-play','edge-next','edge-lock']:ids.filter(id=>!['volume-slider','chapter-select'].includes(id)))};
                const footer=document.querySelector('.tab-bar').getBoundingClientRect();
                const outside=visibleIds.filter(id=>{const r=document.getElementById(id).getBoundingClientRect();
                    return r.width===0 || r.left<0 || r.right>innerWidth+1 || r.top<0 || r.bottom>innerHeight+1 ||
                        (!${collapsed} && r.bottom>footer.top && !id.startsWith('edge-'));});
                const square=${collapsed} ? visibleIds.every(id=>{const r=document.getElementById(id).getBoundingClientRect();return Math.abs(r.width-r.height)<1;}) : true;
                return {missing,outside,square, width:innerWidth, layout: [...document.querySelectorAll('.header-bar,.content-wrapper,.side-controls,.tab-bar')].map(e=>({name:e.className,top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom}))};
            })()`);
            if(process.env.RHYTHM_UI_CAPTURE_DIR){
                fs.mkdirSync(process.env.RHYTHM_UI_CAPTURE_DIR,{recursive:true});
                fs.writeFileSync(path.join(process.env.RHYTHM_UI_CAPTURE_DIR,`player-${name}.png`),(await window.webContents.capturePage()).toPNG());
            }
            assert.deepEqual(checks.missing, [], `${name}: controls must survive redesign`);
            assert.equal(checks.square,true,`${name}: collapsed control buttons must be square`);
            assert.ok(Math.abs(checks.width-width)<=2,`${name}: viewport ${checks.width} must match ${width} within Windows DPI rounding`);
            assert.deepEqual(checks.outside, [], `${name}: controls must fit above navigation: ${JSON.stringify(checks)}`);
            console.log(`PASS: ${name} control preservation and bounds`);
        }
        await window.webContents.executeJavaScript(`containerEl.classList.remove('collapsed','edge-docked');setActiveTab('player');`);
        await new Promise(resolve=>setTimeout(resolve,350));
        assert.equal(await window.webContents.executeJavaScript("window.api.selectViewMode('fullscreen')"),'fullscreen');
        await new Promise(resolve=>setTimeout(resolve,350));
        await window.webContents.capturePage();
        const full = await window.webContents.executeJavaScript(`(async()=>{
            await refreshViewModeSelection();
            const lyrics=document.querySelector('.lyrics-section').getBoundingClientRect();
            const transport=document.querySelector('.content-wrapper').getBoundingClientRect();
            const button=document.getElementById('fullscreen-mode-btn');
            return {active:containerEl.classList.contains('app-fullscreen'),button:button.getAttribute('aria-pressed'),
                lyricsAbove:lyrics.bottom<=transport.top+1, bottom:transport.top>innerHeight/2};
        })()`);
        assert.deepEqual(full,{active:true,button:'true',lyricsAbove:true,bottom:true});
        const fullBounds=window.getBounds();
        await window.webContents.executeJavaScript("setActiveTab('settings')");
        await new Promise(resolve=>setTimeout(resolve,150));
        assert.deepEqual(window.getBounds(),fullBounds,'Settings does not resize the fullscreen window');
        await window.webContents.executeJavaScript("setActiveTab('player');lyricsContainer.textContent='Your lyrics, front and center';titleEl.textContent='Full screen player';artistEl.textContent='Rhythm Dock';");
        if(process.env.RHYTHM_UI_CAPTURE_DIR){
            await window.webContents.capturePage();await new Promise(resolve=>setTimeout(resolve,100));
            fs.writeFileSync(path.join(process.env.RHYTHM_UI_CAPTURE_DIR,'player-fullscreen.png'),(await window.webContents.capturePage()).toPNG());
        }
        await window.webContents.executeJavaScript("window.api.selectViewMode('horizontal')");
        console.log('PASS: fifth mode, dedicated button, centered lyric area, bottom transport and fullscreen tab navigation');
        app.exit(0);
    } catch(error){console.error(error);app.exit(1);}
});
