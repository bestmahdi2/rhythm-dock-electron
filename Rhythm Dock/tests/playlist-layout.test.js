'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {app, BrowserWindow, ipcMain, Menu} = require('electron');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rhythm-playlist-layout-'));
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

app.whenReady().then(async () => {
    try {
        await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Renderer timeout')),20000))]);
        const window = BrowserWindow.getAllWindows()[0];
        window.webContents.setBackgroundThrottling(false);
        for(let i=0;i<100;i++) {
            if(await window.webContents.executeJavaScript('document.documentElement.dataset.appReady === "true"'))break;
            await new Promise(resolve=>setTimeout(resolve,50));
        }
        const tracks = ['First Light','Evening Walk','Open Horizon','Weightless','Late Night','Distant Shore'].map((title,index)=>({
            title,filePath:path.join(scratch,`sample-${index}.wav`),artist:'Sample artist',album:'Design review',durationSeconds:180+index*35,
        }));
        const wav=Buffer.alloc(46);wav.write('RIFF');wav.writeUInt32LE(38,4);wav.write('WAVEfmt ',8);
        wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(22050,24);
        wav.writeUInt32LE(44100,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(2,40);
        const db=require('../src/main/services/database').handle();
        const insert=db.prepare(`INSERT INTO tracks(filePath,basename,title,artist,album,durationSeconds,addedAt,lastSeenAt)
            VALUES(?,?,?,?,?,?,datetime('now'),datetime('now'))`);
        tracks.forEach(track=>{fs.writeFileSync(track.filePath,wav);insert.run(track.filePath,path.basename(track.filePath),track.title,track.artist,track.album,track.durationSeconds);});
        await window.webContents.executeJavaScript(`{
            const style=document.createElement('style');style.textContent='*{transition:none!important;animation:none!important}';document.head.append(style);
            playlist=${JSON.stringify(tracks.map(track=>track.filePath))};originalPlaylist=[...playlist];currentIndex=0;
            setActiveTab('playlist');
        }`);
        await new Promise(resolve=>setTimeout(resolve,300));
        assert.equal(await window.webContents.executeJavaScript(`playlistResults.querySelector('.playlist-row-title').textContent`),'First Light','queue resolves title metadata');
        assert.equal(await window.webContents.executeJavaScript(`playlistResults.querySelector('.playlist-row-duration').textContent`),'3:00','queue shows duration');
        assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('#library-view-chips .chip').length + document.querySelectorAll('#library-more-views option[value]:not([value=""])').length`),7,'all browse views remain reachable');
        // Trigger the real native song menu to exercise keyboard-accessible reorder.
        const originalPopup=Menu.prototype.popup;
        Menu.prototype.popup=function(options){setImmediate(()=>{this.items.find(item=>item.label==='Move down').click();options.callback();});};
        try {
            await window.webContents.executeJavaScript(`playlistResults.querySelector('.playlist-row [title="More song actions"]').click()`);
            await new Promise(resolve=>setTimeout(resolve,120));
            assert.equal(await window.webContents.executeJavaScript('currentIndex'),1,'reordering keeps the current track selected');
            assert.equal(await window.webContents.executeJavaScript('playlist[1]'),tracks[0].filePath);
        }finally{Menu.prototype.popup=originalPopup;}
        const modes=[['horizontal',380,420,false],['dock',380,420,false],['vertical',340,560,true],['stick-expanded',340,420,true]];
        for(const [mode,width,height,vertical] of modes){
            for(const tab of ['playlist','playlist-options']){
                await window.webContents.executeJavaScript(`setActiveTab('${tab}');containerEl.classList.toggle('vertical-mode',${vertical});`);
                await new Promise(resolve=>setTimeout(resolve,150));
                window.setContentSize(width,height);
                await new Promise(resolve=>setTimeout(resolve,100));
                if(tab==='playlist-options') await window.webContents.executeJavaScript(`document.querySelectorAll('#tab-playlist-options details').forEach(d=>d.open=true)`);
                const layout=await window.webContents.executeJavaScript(`(()=>{
                    const panel=document.getElementById('${tab==='playlist'?'playlist-panel':'tab-playlist-options'}');
                    const rect=panel.getBoundingClientRect(),nav=document.querySelector('.tab-bar').getBoundingClientRect();
                    const scroller=panel.querySelector('${tab==='playlist'?'.playlist-results':'.settings-scroll'}');
                    return {overlap:rect.bottom>nav.top,horizontal:panel.scrollWidth>panel.clientWidth+1,
                        innerOverflow:scroller.scrollWidth>scroller.clientWidth+1,available:scroller.clientHeight,
                        wide:[...scroller.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().right>scroller.getBoundingClientRect().right+1).map(e=>e.id||e.className)};
                })()`);
                assert.equal(layout.overlap,false,mode+' '+tab+' clears navigation');
                assert.equal(layout.horizontal,false,mode+' '+tab+' has no horizontal overflow');
                assert.equal(layout.innerOverflow,false,mode+' '+tab+' scrolling content fits: '+JSON.stringify(layout.wide));
                assert.ok(layout.available>=44,mode+' '+tab+' retains usable scrolling content');
                if(process.env.RHYTHM_UI_CAPTURE_DIR){
                    fs.mkdirSync(process.env.RHYTHM_UI_CAPTURE_DIR,{recursive:true});
                    fs.writeFileSync(path.join(process.env.RHYTHM_UI_CAPTURE_DIR,`${tab}-${mode}.png`),(await window.webContents.capturePage()).toPNG());
                }
            }
            console.log('PASS: '+mode+' Playlist and Options bounds');
        }
        await window.webContents.executeJavaScript(`setActiveTab('playlist');document.getElementById('playlist-browse-toggle').click();`);
        assert.equal(await window.webContents.executeJavaScript(`document.getElementById('playlist-browse-panel').hidden`),false);
        const controls=['playlist-filter','playlist-sort','named-playlist-select','named-playlist-play','named-playlist-add-current',
            'named-playlist-delete','remote-audio-url','remote-audio-position','remote-audio-add','remote-audio-play','remote-audio-cancel',
            'remote-audio-save','remote-audio-download','named-playlist-name','named-playlist-create','named-playlist-save-queue',
            'named-playlist-import','named-playlist-export'];
        assert.deepEqual(await window.webContents.executeJavaScript(`${JSON.stringify(controls)}.filter(id=>document.querySelectorAll('#'+id).length!==1)`),[],'all original controls remain unique');
        const remote=await window.webContents.executeJavaScript(`(async()=>{
            room.connected=true;room.isHost=false;room.role='listener';room.remoteLibrary={queue:[]};
            renderLibraryViewChips();await renderActiveLibraryView();renderRoomUI();
            return {label:document.getElementById('playlist-view-label').textContent,
                localViews:document.getElementById('library-view-chips').classList.contains('hidden'),
                localFilters:document.getElementById('playlist-browse-toggle').hidden};
        })()`);
        assert.deepEqual(remote,{label:'Shared queue',localViews:true,localFilters:true},'guest permissions stay intact');
        console.log('PASS: metadata, seven views, native reorder, preserved controls and shared-queue restrictions');
        app.exit(0);
    }catch(error){console.error(error);app.exit(1);}
});
