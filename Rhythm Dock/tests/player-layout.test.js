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
        const ids = ['prev-btn','play-pause-btn','next-btn','volume-btn','volume-slider','shuffle-btn','loop-btn',
            'ab-repeat-btn','like-btn','file-dropdown-btn','speed-btn','lyrics-dropdown-btn','app-dropdown-btn',
            'pin-btn','lock-btn','minimize-btn','close-btn','progress-bar','current-playlist',
            'lyrics-offset-minus-btn','lyrics-offset-plus-btn','translate-toggle-btn','chapter-select'];
        for (const [name,width,height,vertical,collapsed] of [
            ['horizontal',380,360,false,false], ['dock',380,260,false,false],
            ['vertical',220,560,true,false], ['edge-expanded',220,420,true,false],
            ['stick',48,420,true,true],
        ]) {
            window.setMinimumSize(collapsed ? 48 : 105,110);
            window.setContentSize(width,height);
            await window.webContents.executeJavaScript(`containerEl.dataset.activeTab='player';
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
                return {missing,outside, width:innerWidth, layout: [...document.querySelectorAll('.header-bar,.content-wrapper,.side-controls,.tab-bar')].map(e=>({name:e.className,top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom}))};
            })()`);
            if(process.env.RHYTHM_UI_CAPTURE_DIR){
                fs.mkdirSync(process.env.RHYTHM_UI_CAPTURE_DIR,{recursive:true});
                fs.writeFileSync(path.join(process.env.RHYTHM_UI_CAPTURE_DIR,`player-${name}.png`),(await window.webContents.capturePage()).toPNG());
            }
            assert.deepEqual(checks.missing, [], `${name}: controls must survive redesign`);
            assert.ok(Math.abs(checks.width-width)<=2,`${name}: viewport ${checks.width} must match ${width} within Windows DPI rounding`);
            assert.deepEqual(checks.outside, [], `${name}: controls must fit above navigation: ${JSON.stringify(checks)}`);
            console.log(`PASS: ${name} control preservation and bounds`);
        }
        app.exit(0);
    } catch(error){console.error(error);app.exit(1);}
});
