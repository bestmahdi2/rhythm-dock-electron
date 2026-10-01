'use strict';
const {ipcMain,dialog,app,safeStorage,shell} = require('electron');
const fs=require('node:fs');
const path=require('node:path');
const database=require('./database');
const libraryTools=require('./library-tools');
const libraryStore=require('./library-store');
const settings=require('./settings-transfer');
const providers=require('./connected-providers');
const tags=require('../library/tags');
const {FileTools}=require('./file-tools');
const paths=require('../core/paths');
function install({getStore,getWindow,getLayout,applyLayout,updated,discordPresence}) {
    const store=()=>getStore();
    const credentials=()=> {
        try {const encrypted=store().get('providerCredentials','');
            return encrypted?JSON.parse(safeStorage.decryptString(Buffer.from(encrypted,'base64'))):{};} catch(_) {return {};}
    };
    const saveCredentials=data=> {
        if(!safeStorage.isEncryptionAvailable()||safeStorage.getSelectedStorageBackend?.()==='basic_text')
            throw new Error('Secure account storage is unavailable on this computer. Enable the system keyring first.');
        store().set('providerCredentials',safeStorage.encryptString(JSON.stringify(data)).toString('base64'));
    };
    const scrobbler=new providers.Scrobbler({getConfig:credentials});
    let fileTools;
    const files=()=>fileTools ||= new FileTools(path.join(paths.getDataRoot(),'file-operations'),{
        validateTarget:target=>{
            for(const table of ['tracks','track_stats','track_ratings','track_preferences','book_positions','bookmarks','playlist_items','play_history'])
                if(database.handle().prepare(`SELECT 1 FROM ${table} WHERE filePath=? LIMIT 1`).get(target))
                    throw new Error('A destination has existing library history. Choose another filename pattern.');
        },onChange:(oldPath,newPath)=>{
        if(oldPath!==newPath) {
            const db=database.handle();
            db.transaction(()=>{
                for(const table of ['tracks','track_stats','track_ratings','track_preferences','book_positions','bookmarks','playlist_items','play_history'])
                    db.prepare(`UPDATE OR IGNORE ${table} SET filePath=? WHERE filePath=?`).run(newPath,oldPath);
                const root=libraryStore.listRoots().sort((a,b)=>b.path.length-a.path.length).find(r=>{
                    const relative=path.relative(r.path,newPath);return !relative.startsWith('..')&&!path.isAbsolute(relative);
                })||libraryStore.addRoot(path.dirname(newPath));
                db.prepare('UPDATE tracks SET basename=?,missing=0,rootId=? WHERE filePath=?').run(path.basename(newPath),root?.id||null,newPath);
            })();
        }
        const read=tags.read(newPath); if(read.ok) libraryStore.updateTrackMetadata(newPath,{...read.tags,durationSeconds:read.durationSeconds});
        updated(oldPath,newPath);
    }});
    let lastfmToken=null,waveAbort=null;
    let reporting=false;
    const reportCrash=async()=>{
        const config=store().get('crashReporting',{});
        if(!config.enabled||!config.endpoint||reporting)return false;
        reporting=true;
        try {
            const logFile=path.join(paths.getDataRoot(),'logs','diagnostics.jsonl');
            const rows=fs.readFileSync(logFile,'utf8').trim().split(/\r?\n/).slice(-50).map(line=>JSON.parse(line));
            const events=require('./diagnostics').sanitizeEvents(rows);
            await providers.jsonRequest(config.endpoint,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({events})});return true;
        }catch(_){return false;}finally{reporting=false;}
    };
    const handlers={
        discordGet:()=>({...store().get('discordPresence',{enabled:false,clientId:''}),...discordPresence.status()}),
        discordSave:value=>{const result=require('./discord-presence').config(value);store().set('discordPresence',result);discordPresence.configure();return result;},
        catalog:libraryTools.catalog, smartList:libraryTools.smartList, smartSave:libraryTools.saveSmart,smartDelete:libraryTools.deleteSmart,
        groups:libraryTools.groups,folders:libraryTools.folders,history:libraryTools.history,duplicates:libraryTools.duplicates,
        folderChildren:libraryTools.folderChildren,
        bookmark:libraryTools.bookmark,bookmarks:libraryTools.bookmarks,bookmarkDelete:libraryTools.deleteBookmark,
        playlistReorder:libraryTools.reorderPlaylist,
        playlistDuplicate:({id,name})=>libraryStore.createPlaylist(name,libraryStore.playlistTracks(id).map(t=>t.filePath)),
        waveform:filePath=>{waveAbort?.abort();waveAbort=new AbortController();return require('./visual-analysis').waveform(filePath,
            {executable:store().get('ffmpegPath','')||'ffmpeg',signal:waveAbort.signal});},
        diagnostics:()=>getStore() && require('node:fs').readFileSync(path.join(paths.getDataRoot(),'logs','diagnostics.jsonl'),'utf8').slice(-65536),
        crashConfigGet:()=>store().get('crashReporting',{enabled:false,endpoint:''}),
        crashConfigSave:value=>{
            const endpoint=String(value?.endpoint||'').trim();
            if(endpoint){const u=new URL(endpoint);if(u.username||u.password||u.hash||u.search||
                (u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname))))throw new Error('Use an HTTPS crash-report endpoint.');}
            if(value.enabled&&!endpoint)throw new Error('Enter a crash-report endpoint first.');
            const config={enabled:Boolean(value.enabled),endpoint};store().set('crashReporting',config);return config;
        },
        crashReportTest:()=>reportCrash(),
        appearanceGet:()=>store().get('roadmapAppearance',{}),
        appearanceSave:value=>{
            const result=require('./appearance').validate(value);
            store().set('roadmapAppearance',result); return result;
        },
        layoutList:()=>store().get('layoutPresets',[]),
        layoutSave:name=>{
            name=String(name||'').trim().slice(0,60); if(!name) throw new Error('Name this layout.');
            const presets=store().get('layoutPresets',[]).filter(p=>p.name!==name);
            presets.push({name,...getLayout(),bounds:getWindow().getBounds(),pinned:getWindow().isAlwaysOnTop()});
            if(presets.length>20) throw new Error('At most 20 layouts can be saved.'); store().set('layoutPresets',presets);return presets;
        },
        layoutApply:name=>{const preset=store().get('layoutPresets',[]).find(p=>p.name===name);
            if(!preset) throw new Error('Choose a saved layout.'); applyLayout(preset); return true;},
        layoutDelete:name=>{const list=store().get('layoutPresets',[]).filter(p=>p.name!==name);store().set('layoutPresets',list);return list;},
        settingsExport:async()=>{
            const result=await dialog.showSaveDialog(getWindow(),{defaultPath:'Rhythm-Dock-settings.json',filters:[{name:'Settings',extensions:['json']}]});
            if(result.canceled)return false;
            fs.writeFileSync(result.filePath,JSON.stringify(settings.exportSettings(store().store),null,2)); return true;
        },
        settingsImport:async()=>{
            const result=await dialog.showOpenDialog(getWindow(),{properties:['openFile'],filters:[{name:'Settings',extensions:['json']}]});
            if(result.canceled)return false;
            if(fs.statSync(result.filePaths[0]).size>1024*1024) throw new Error('Settings file exceeds 1 MB.');
            const values=settings.importSettings(JSON.parse(fs.readFileSync(result.filePaths[0],'utf8')));
            const confirm=await dialog.showMessageBox(getWindow(),{type:'question',buttons:['Cancel','Import'],defaultId:0,
                message:`Import ${Object.keys(values).length} preferences?`,detail:'Accounts, device routing and the play queue are preserved. Restart the app to apply all imported preferences.'});
            if(confirm.response!==1)return false;
            for(const [key,value] of Object.entries(values))store().set(key,value); return true;
        },
        loginGet:()=>['win32','darwin'].includes(process.platform)?app.getLoginItemSettings().openAtLogin:false,
        loginSet:enabled=>{if(!['win32','darwin'].includes(process.platform))throw new Error('Launch at login currently supports Windows and macOS.');
            if(!app.isPackaged) throw new Error('Launch at login is available in the installed app.');
            app.setLoginItemSettings({openAtLogin:Boolean(enabled),args:['--hidden']});return app.getLoginItemSettings().openAtLogin;},
        folderPick:async()=>{const r=await dialog.showOpenDialog(getWindow(),{properties:['openDirectory']});return r.canceled?null:r.filePaths[0];},
        filePreview:async options=>{
            const preview=await files().preview(options);
            if(preview.mode==='organise'&&preview.rows.some(r=>database.handle().prepare('SELECT 1 FROM tracks WHERE filePath=?').get(r.target)))
                throw new Error('A destination has existing library history. Choose another filename pattern.');
            return preview;
        },fileApply:id=>files().apply(id),fileUndo:id=>files().undo(id),fileJournals:()=>files().journals(),
        tagPresetsGet:()=>store().get('tagPresets',[]),
        tagPresetSave:({name,values})=>{name=String(name||'').trim().slice(0,80);if(!name)throw new Error('Name this preset.');
            const list=store().get('tagPresets',[]).filter(p=>p.name!==name);list.push({name,values:Object.fromEntries(Object.entries(values||{}).filter(([k,v])=>
                tags.TEXT_FIELDS.includes(k)||['artist','albumArtist'].includes(k)).map(([k,v])=>[k,String(v).slice(0,500)]))});
            if(list.length>50)throw new Error('At most 50 presets can be saved.');store().set('tagPresets',list);return list;},
        musicBrainz:providers.musicBrainz,
        acoustID:filePath=>providers.acoustID({filePath,executable:store().get('fpcalcPath','')||'fpcalc',client:credentials().acoustid?.token}),
        coverArt:providers.coverArt,
        fpcalcPick:async()=>{const r=await dialog.showOpenDialog(getWindow(),{properties:['openFile']});
            if(!r.canceled)store().set('fpcalcPath',r.filePaths[0]);return !r.canceled;},
        acoustidSave:token=>{const c=credentials();c.acoustid={token:String(token||'').trim().slice(0,200)};saveCredentials(c);return true;},
        radioSearch:require('./broadcasts').radioSearch,
        radioList:()=>store().get('radioStations',[]),
        radioSave:value=>{const url=require('./remote-cache').validateUrl(value.url).href;
            const list=store().get('radioStations',[]).filter(s=>s.url!==url);list.push({url,title:String(value.title||'Radio').slice(0,300)});
            if(list.length>100)throw new Error('At most 100 stations can be saved.');store().set('radioStations',list);return list;},
        radioDelete:url=>{const list=store().get('radioStations',[]).filter(s=>s.url!==url);store().set('radioStations',list);return list;},
        podcastList:()=>store().get('podcasts',[]),
        podcastSubscribe:async url=>{const data=await require('./broadcasts').feed(url);const list=store().get('podcasts',[]).filter(p=>p.url!==data.url);
            list.push(data);if(list.length>50)throw new Error('At most 50 podcasts can be followed.');store().set('podcasts',list);return data;},
        podcastRemove:url=>{const list=store().get('podcasts',[]).filter(p=>p.url!==url);store().set('podcasts',list);return list;},
        podcastDownload:async url=>require('./remote-cache').download(url,path.join(paths.getDataRoot(),'remote-cache')),
        podcastPositionGet:url=>store().get('podcastPositions',{})[url]||0,
        podcastPositionSet:({url,seconds})=>{require('./remote-cache').validateUrl(url);
            if(!Number.isFinite(seconds)||seconds<0||seconds>604800)throw new Error('Invalid episode position.');
            const positions=store().get('podcastPositions',{});positions[url]=seconds;
            const keys=Object.keys(positions);for(const key of keys.slice(0,Math.max(0,keys.length-1000)))delete positions[key];
            store().set('podcastPositions',positions);return true;},
        similarArtists:artist=>providers.similarArtists(artist,credentials().lastfm?.apiKey),
        providerStatus:()=>{
            const c=credentials();return {listenbrainz:{enabled:Boolean(c.listenbrainz?.enabled),connected:Boolean(c.listenbrainz?.token)},
                lastfm:{enabled:Boolean(c.lastfm?.enabled),configured:Boolean(c.lastfm?.apiKey&&c.lastfm?.apiSecret),connected:Boolean(c.lastfm?.sessionKey)},
                acoustid:{configured:Boolean(c.acoustid?.token)},pending:scrobbler.status()};},
        providerSave:({provider,enabled,token,apiKey,apiSecret})=>{
            if(!['listenbrainz','lastfm'].includes(provider))throw new Error('Choose a service.');
            const c=credentials(); c[provider]||={};c[provider].enabled=Boolean(enabled);
            for(const [k,v] of Object.entries({token,apiKey,apiSecret}))if(v)c[provider][k]=String(v).trim().slice(0,200);
            saveCredentials(c); return true;},
        providerDisconnect:provider=>{if(!['listenbrainz','lastfm'].includes(provider))throw new Error('Choose a service.');
            const c=credentials();delete c[provider];saveCredentials(c);database.handle().prepare('DELETE FROM delivery_jobs WHERE provider=?').run(provider);return true;},
        lastfmStart:async()=>{const c=credentials().lastfm||{},data=await providers.lastfm('auth.getToken',{},c);lastfmToken=data.token;
            const url=new URL('https://www.last.fm/api/auth/');url.search=new URLSearchParams({api_key:c.apiKey,token:data.token}).toString();
            await shell.openExternal(url.href);return true;},
        lastfmFinish:async()=>{if(!lastfmToken)throw new Error('Start account connection first.');const c=credentials();
            const data=await providers.lastfm('auth.getSession',{token:lastfmToken},c.lastfm);c.lastfm.sessionKey=data.session.key;
            saveCredentials(c);lastfmToken=null;return true;},
        scrobbleFlush:()=>scrobbler.flush(),scrobbleClear:()=>scrobbler.clear(),
        serverCheck:async value=>{
            const url=new URL(value);if(!['https:','wss:','http:','ws:'].includes(url.protocol)||url.username||url.password)throw new Error('Enter the sharing server URL.');
            if(['http:','ws:'].includes(url.protocol)&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Use HTTPS/WSS for an online server.');
            url.protocol=['wss:','https:'].includes(url.protocol)?'https:':'http:';url.pathname='/healthz';url.search='';url.hash='';
            const data=await providers.jsonRequest(url,{redirect:'error'});if(data.ok!==true)throw new Error('This is not a healthy Rhythm Dock server.');
            if(data.storageHealthy===false)throw new Error('The server is reachable but cannot save room state. Check its state folder and disk space.');
            store().set('roomServerUrl',value);return {ok:true,message:'Server reached. Create a room or enter your friend’s room code in Sharing.'};
        },
    };
    ipcMain.handle('roadmap-call',async(_event,operation,value)=>{
        try {if(!Object.prototype.hasOwnProperty.call(handlers,operation))throw new Error('Unknown action.');
            return {ok:true,data:await handlers[operation](value)};}catch(error){return {ok:false,error:error.message||'Could not complete this action.'};}
    });
    const timer=setInterval(()=>{if(database.handle()&&store())scrobbler.flush().catch(()=>{});},60000);timer.unref();
    app.on('before-quit',()=>{waveAbort?.abort();clearInterval(timer);});
    return {scrobbler,reportCrash};
}
module.exports={install};
