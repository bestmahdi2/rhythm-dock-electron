'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {app, BrowserWindow, ipcMain} = require('electron');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rhythm-settings-layout-'));
app.setPath('appData', scratch);
app.setPath('userData', path.join(scratch, 'profile'));
fs.mkdirSync(app.getPath('userData'), {recursive:true});
fs.writeFileSync(path.join(app.getPath('userData'),'config.json'), JSON.stringify({onboardingComplete:true}));
const Database = require('better-sqlite3');
const legacy = new Database(path.join(app.getPath('userData'),'lyrics.db'));
legacy.exec('CREATE TABLE smoke_marker (id INTEGER PRIMARY KEY)');legacy.close();
BrowserWindow.prototype.show = function () {};
const ready = new Promise(resolve => ipcMain.once('renderer-ready', resolve));
process.argv.splice(1);
require('../src/main/index');
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));

app.whenReady().then(async()=>{
    try {
        await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Renderer timeout')),20000))]);
        const window=BrowserWindow.getAllWindows()[0];window.webContents.setBackgroundThrottling(false);
        for(let i=0;i<100;i++){
            if(await window.webContents.executeJavaScript('document.documentElement.dataset.appReady === "true" && !!window.settingsNavigation'))break;
            await pause(50);
        }
        await window.webContents.executeJavaScript(`{
            const style=document.createElement('style');style.textContent='*{transition:none!important;animation:none!important}';document.head.append(style);
            setActiveTab('settings');
        }`);
        await pause(350);
        // Every authored settings ID must still exist exactly once within Settings.
        const source=fs.readFileSync(path.join(__dirname,'../src/renderer/index.html'),'utf8');
        const block=source.slice(source.indexOf('<div id="tab-settings"'),source.indexOf('<div id="playlist-panel"'));
        const ids=[...block.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
        assert.deepEqual(await window.webContents.executeJavaScript(`${JSON.stringify(ids)}.filter(id=>document.querySelectorAll('#'+id).length!==1||!settingsTab.contains(document.getElementById(id)))`),[],'all original IDs remain unique and attached');
        assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll(".settings-category-entry").length'),8);
        // Change a real setting through its original event handler and confirm persistence.
        await window.webContents.executeJavaScript(`settingsNavigation.show('audio');document.getElementById('mono-toggle').checked=true;
            document.getElementById('mono-toggle').dispatchEvent(new Event('change',{bubbles:true}));`);
        await pause(100);
        assert.equal(await window.webContents.executeJavaScript('window.api.getStoreValue("monoMix")'),true);
        assert.equal(await window.webContents.executeJavaScript('audio.monoMix'),true);
        await window.webContents.executeJavaScript(`settingsNavigation.home();settingsNavigation.show('audio');`);
        assert.equal(await window.webContents.executeJavaScript('document.getElementById("mono-toggle").checked'),true,'category navigation retains form state');
        await window.webContents.executeJavaScript(`{
            const enabled=document.getElementById('eq-enabled');enabled.checked=true;enabled.dispatchEvent(new Event('change',{bubbles:true}));
            const band=document.querySelector('#eq-bands input');band.value='3';band.dispatchEvent(new Event('input',{bubbles:true}));
        }`);
        assert.equal(await window.webContents.executeJavaScript('equalizer.gains[0]'),3,'redesigned EQ preserves the audio handler');
        // The moved advanced entry still opens the existing embedded tool and returns to its category.
        await window.webContents.executeJavaScript(`settingsNavigation.show('appearance');document.querySelector('[data-settings-page="Appearance"]').click();`);
        await pause(180);
        assert.equal(await window.webContents.executeJavaScript(`document.getElementById('roadmap-dialog').open && document.getElementById('roadmap-dialog').parentElement===settingsTab`),true);
        await window.webContents.executeJavaScript(`document.getElementById('roadmap-dialog').close()`);
        await window.webContents.capturePage();await pause(30);
        assert.equal(await window.webContents.executeJavaScript('settingsTab.classList.contains("settings-detail-open")'),false,'closing an embedded tool restores category view');
        assert.equal(await window.webContents.executeJavaScript('settingsNavigation.active'),'appearance');
        await window.webContents.executeJavaScript(`document.querySelector('.settings-category-back').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
        assert.equal(await window.webContents.executeJavaScript('settingsNavigation.active'),'home','Escape returns to categories');
        const groups=['home','appearance','audio','playback','library','lyrics','sharing','shortcuts','tools'];
        for(const [mode,width,height,vertical] of [['horizontal',380,420,false],['dock',380,420,false],['vertical',340,560,true],['stick-expanded',340,420,true]]){
            window.setContentSize(width,height);
            await window.webContents.executeJavaScript(`containerEl.classList.toggle('vertical-mode',${vertical})`);
            await pause(100);await window.webContents.capturePage();
            for(const group of groups){
                await window.webContents.executeJavaScript(`settingsNavigation.show('${group}',{focus:false});
                    document.querySelectorAll('[data-settings-category="${group}"] details').forEach(d=>d.open=true);`);
                const check=await window.webContents.executeJavaScript(`(()=>{
                    const scroller=settingsTab.querySelector(':scope > .settings-scroll'),nav=document.querySelector('.tab-bar').getBoundingClientRect();
                    return {overlap:settingsTab.getBoundingClientRect().bottom>nav.top,
                        overflow:scroller.scrollWidth>scroller.clientWidth+1,
                        widths:[scroller.scrollWidth,scroller.clientWidth,scroller.scrollLeft],
                        internal:[...scroller.querySelectorAll('*')].filter(e=>e.clientWidth>0&&e.scrollWidth>e.clientWidth+1).map(e=>[e.id||e.className,e.scrollWidth,e.clientWidth]),
                        wide:[...scroller.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().right>scroller.getBoundingClientRect().right+1).map(e=>e.id||e.className),
                        available:scroller.clientHeight};
                })()`);
                assert.equal(check.overlap,false,mode+' '+group+' clears bottom navigation');
                assert.equal(check.overflow,false,mode+' '+group+' fits: '+JSON.stringify(check));
                assert.ok(check.available>100,mode+' '+group+' has a usable content area');
                if(process.env.RHYTHM_UI_CAPTURE_DIR && ['home','appearance','audio','lyrics'].includes(group)){
                    await window.webContents.capturePage();
                    await pause(80);
                    fs.mkdirSync(process.env.RHYTHM_UI_CAPTURE_DIR,{recursive:true});
                    fs.writeFileSync(path.join(process.env.RHYTHM_UI_CAPTURE_DIR,`settings-${group}-${mode}.png`),(await window.webContents.capturePage()).toPNG());
                }
            }
            console.log('PASS: '+mode+' eight categories and home fit above navigation');
        }
        await window.webContents.executeJavaScript(`settingsNavigation.show('audio');document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true,cancelable:true}));`);
        assert.equal(await window.webContents.executeJavaScript('settingsNavigation.active'),'home','Ctrl+K opens category home');
        console.log('PASS: original controls, saved setting handlers, retained values, embedded tools, back/Escape and Ctrl+K');
        app.exit(0);
    }catch(error){console.error(error);app.exit(1);}
});
