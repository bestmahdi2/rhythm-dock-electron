'use strict';
// Later roadmap UI uses explicit preload operations and the existing transport.
window.RhythmRoadmap = {install};
function install(actions) {
    const api=window.api,engine=actions.engine;
    const call=async(name,value)=>{const r=await api.roadmap(name,value);if(!r.ok)throw new Error(r.error);return r.data;};
    const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;};
    const button=(text,fn,parent)=>{const b=el('button',text);b.type='button';b.addEventListener('click',async()=>{
        try{await fn();}catch(error){status.textContent=error.message;}});if(parent)parent.append(b);return b;};
    const field=(label,type='text',value='',parent=body)=>{const l=el('label',null,'rd-field');l.append(el('span',label));
        const input=el(type==='textarea'?'textarea':'input');if(type!=='textarea')input.type=type;input.value=value;l.append(input);parent.append(l);return input;};
    const select=(label,choices,parent=body)=>{const l=el('label',null,'rd-field');l.append(el('span',label));const s=el('select');
        for(const [value,text] of choices){const o=el('option',text);o.value=value;s.append(o);}l.append(s);parent.append(l);return s;};
    const row=(parent=body)=>{const r=el('div',null,'rd-row');parent.append(r);return r;};
    const dialog=el('dialog',null,'rd-dialog');dialog.id='roadmap-dialog';dialog.setAttribute('aria-labelledby','rd-heading');
    const head=el('div',null,'rd-head'),heading=el('h2','Tools');heading.id='rd-heading';head.append(heading);
    const status=el('p',null,'rd-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const nav=el('nav',null,'rd-nav');nav.setAttribute('aria-label','Tools');const body=el('div');body.id='rd-body';
    dialog.append(head,nav,status,body);document.body.append(dialog);button('Close',()=>dialog.close(),head);
    let pageTicket=0,selected=new Set(),appearance={},peaks=null,trackKey='',waveTicket=0,full=null,fullTimer=null,lastFocus;
    const names={Library:'Library',Appearance:'Appearance',Practice:'Practice',Editor:'Audio editor',Broadcasts:'Radio & podcasts',Files:'Tags & files',Accounts:'Accounts',Setup:'Getting started',Layouts:'Layouts',Settings:'Settings & logs'};
    for(const [key,name] of Object.entries(names))button(name,()=>open(key),nav).dataset.page=key;
    const settingsPanel=document.getElementById('tab-settings');
    const card=el('section',null,'settings-block');card.id='roadmap-tools-card';
    card.append(el('h3','More settings'));
    const categories=el('div',null,'settings-category-grid');card.append(categories);
    for(const [key,name] of Object.entries(names)) {
        if(key!=='Setup') button(name,()=>open(key),categories).dataset.settingsPage=key;
    }
    settingsPanel?.querySelector('.settings-scroll')?.prepend(card);
    dialog.addEventListener('close',()=>{
        pageTicket++;settingsPanel?.classList.remove('settings-detail-open');lastFocus?.focus({preventScroll:true});
    });
    async function open(page='Library') {
        if(actions.isLocked())return;
        const embedded=page!=='Setup';
        if(embedded&&dialog.open&&!settingsPanel.classList.contains('show'))actions.tab('settings');
        if(dialog.open && (dialog.dataset.embedded==='true')!==embedded) dialog.close();
        if(!dialog.open){
            lastFocus=document.activeElement;
            actions.tab('settings');
            await new Promise(r=>setTimeout(r,80));
            dialog.dataset.embedded=String(embedded);
            if(embedded){settingsPanel.append(dialog);settingsPanel.classList.add('settings-detail-open');dialog.show();}
            else {document.body.append(dialog);dialog.showModal();}
        }
        head.querySelector('button').textContent=embedded?'Back to settings':'Close';
        const ticket=++pageTicket;body.replaceChildren();status.textContent='';heading.textContent=names[page]||page;
        for(const b of nav.querySelectorAll('button'))b.setAttribute('aria-current',b.dataset.page===page?'page':'false');
        try{await pages[page](ticket);}catch(error){if(ticket===pageTicket)status.textContent=error.message;}
    }
    function isCurrent(ticket){return dialog.open&&ticket===pageTicket;}
    function paths(){const list=[...selected];return list.length?list:actions.track()?.filePath?[actions.track().filePath]:[];}
    const pages={Library:library,Appearance:appearancePage,Practice:practice,Editor:editor,Broadcasts:broadcasts,Files:filePage,Accounts:accounts,Setup:setup,Layouts:layouts,Settings:settingsPage};
    async function library(ticket) {
        const controls=row();const query=field('Search','search','',controls),sort=select('Sort',[['title','Title'],['artist','Artist'],['album','Album'],['rating','Rating'],['added','Added'],['played','Played'],['duration','Duration']],controls);
        const view=select('Browse',[['tracks','Songs'],['artist','Artists'],['album','Albums'],['folders','Folders'],['history','History'],['duplicates','Possible duplicates'],['smart','Smart playlists'],['playlists','Saved playlists']],controls);
        const desc=button('Reverse order',()=>{descending=!descending;refresh();},controls);let descending=false,rules={},folder='',total=0,ticketQuery=0;
        const bulk=row();button('Play selection',()=>actions.playPaths(paths()),bulk);button('Queue selection',async()=>{for(const p of paths())await actions.enqueue(p);},bulk);
        button('Clear selection',()=>{selected.clear();refresh();},bulk);button('Edit selected tags',()=>open('Files'),bulk);
        const list=el('div',null,'rd-results');list.tabIndex=0;list.setAttribute('aria-label','Library results');body.append(list);
        let timer,lastStart=-1,currentRows=[],anchor=null;
        function choose(p,index,event){if(event.shiftKey&&anchor!==null){for(const r of currentRows.filter(r=>r.index>=Math.min(index,anchor)&&r.index<=Math.max(index,anchor)))selected.add(r.filePath);}
            else if(selected.has(p))selected.delete(p);else selected.add(p);anchor=index;refresh(false);}
        async function render(start=0){
            const request=++ticketQuery;
            const data=await call('catalog',{query:query.value,sort:sort.value,desc:descending,rules,folder,offset:start,limit:40});
            if(!isCurrent(ticket)||request!==ticketQuery)return;
            total=data.total;lastStart=start;currentRows=data.rows.map((r,i)=>({...r,index:start+i}));
            const top=el('div');top.style.height=start*56+'px';const frag=document.createDocumentFragment();frag.append(top);
            for(const r of currentRows){const item=el('div',null,'rd-track');item.dataset.path=r.filePath;
                const check=el('input');check.type='checkbox';check.checked=selected.has(r.filePath);check.setAttribute('aria-label','Select '+(r.title||r.basename));
                check.addEventListener('click',e=>choose(r.filePath,r.index,e));item.append(check);
                const label=el('span',r.title||r.basename,'rd-label');label.title=r.filePath;label.append(el('small',[r.artist,r.album,r.rating?'Rating '+r.rating:''].filter(Boolean).join(' · ')));item.append(label);
                button('Edit tags',()=>{dialog.close();actions.editTags(r.filePath);},item);button('Play',()=>actions.playPaths([r.filePath]),item);button('+',()=>actions.enqueue(r.filePath),item).setAttribute('aria-label','Queue '+(r.title||r.basename));frag.append(item);
            }
            const bottom=el('div');bottom.style.height=Math.max(0,total-start-data.rows.length)*56+'px';frag.append(bottom);list.replaceChildren(frag);
            status.textContent=`${total} songs · ${selected.size} selected`;
        }
        async function refresh(reset=true){if(!isCurrent(ticket))return;if(reset){list.scrollTop=0;lastStart=-1;}await render(Math.max(0,Math.floor(list.scrollTop/56)-5));}
        list.addEventListener('scroll',()=>{if(view.value!=='tracks')return;clearTimeout(timer);timer=setTimeout(()=>{
            const start=Math.max(0,Math.floor(list.scrollTop/56)-5);if(Math.abs(start-lastStart)>=5)render(start).catch(e=>status.textContent=e.message);},80);});
        query.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(()=>{view.value='tracks';rules={};folder='';refresh();},180);});
        sort.addEventListener('change',()=>refresh());
        view.addEventListener('change',async()=>{
            try{
                ticketQuery++;rules={};folder='';list.scrollTop=0;list.replaceChildren();
                if(view.value==='tracks')return refresh();
                if(['artist','album'].includes(view.value)){
                    const kind=view.value,groups=await call('groups',kind);if(!isCurrent(ticket))return;
                    const grid=el('div',null,'rd-grid');list.append(grid);let index=0;
                    // Art loading stays bounded along with the page; groups are paged in the UI.
                    const show=async()=>{for(const g of groups.slice(index,index+40)){
                        const b=button(`${g.name} (${g.count})`,()=>{rules={[kind]:g.name};view.value='tracks';refresh();},grid);
                        api.getMetadata(g.filePath).then(m=>{if(m.cover&&isCurrent(ticket)){const img=el('img');img.src=m.cover;img.alt='';b.prepend(img);}}).catch(()=>{});
                    }index+=40;};await show();if(groups.length>40)button('More',show,list);
                }else if(view.value==='folders'){
                    const branch=async(parent,target)=>{
                        const folders=await call('folderChildren',parent);if(!isCurrent(ticket))return;
                        for(const f of folders){const details=el('details'),summary=el('summary',`${f.name.split(/[\\/]/).filter(Boolean).at(-1)||f.name} (${f.count})`);
                            details.append(summary);target.append(details);
                            button('Browse songs',()=>{folder=f.name;view.value='tracks';refresh();},details);
                            if(f.hasChildren){const children=el('div');children.style.paddingInlineStart='12px';details.append(children);
                                let loaded=false;details.addEventListener('toggle',()=>{if(details.open&&!loaded){loaded=true;branch(f.name,children).catch(e=>status.textContent=e.message);}});}
                        }
                    };await branch('',list);
                }else if(view.value==='history'){
                    for(const r of await call('history'))button(`${new Date(r.playedAt).toLocaleString()} · ${r.title||r.filePath.split(/[\\/]/).pop()} · ${r.outcome}`,()=>actions.playPaths([r.filePath]),list);
                }else if(view.value==='duplicates'){
                    list.append(el('p','Candidates share title, artist and rounded duration. Review the files before deleting anything.'));
                    for(const group of await call('duplicates')){list.append(el('h3',group[0].title));for(const r of group)button(r.filePath,()=>api.showFileInFolder(r.filePath),list);}
                }else if(view.value==='smart'){
                    const fields=row(list),name=field('Name','text','',fields),genre=field('Genre','text','',fields),rating=field('Minimum rating','number','4',fields),days=field('Unplayed days','number','30',fields);
                    button('Save smart playlist',async()=>{await call('smartSave',{name:name.value,rules:{genre:genre.value,minRating:Number(rating.value),unplayedDays:Number(days.value)}});view.dispatchEvent(new Event('change'));},list);
                    for(const p of await call('smartList')){const r=row(list);button(p.name,()=>{rules=p.rules;view.value='tracks';refresh();},r);button('Delete',async()=>{await call('smartDelete',p.id);view.dispatchEvent(new Event('change'));},r);}
                }else{
                    for(const p of await api.playlistList()){const r=row(list);button(p.name,async()=>actions.playPaths((await api.playlistTracks(p.id)).map(t=>t.filePath)),r);
                        const n=field('Copy name','text',p.name+' copy',r);button('Duplicate',async()=>{await call('playlistDuplicate',{id:p.id,name:n.value});view.dispatchEvent(new Event('change'));},r);
                        button('Edit order',async()=>{const tracks=await api.playlistTracks(p.id);list.replaceChildren();
                            const paint=()=>{list.replaceChildren();tracks.forEach((t,i)=>{const rowEl=row(list);rowEl.append(el('span',t.title||t.filePath.split(/[\\/]/).pop()));
                                button('↑',()=>{if(i){[tracks[i-1],tracks[i]]=[tracks[i],tracks[i-1]];paint();}},rowEl);
                                button('↓',()=>{if(i<tracks.length-1){[tracks[i+1],tracks[i]]=[tracks[i],tracks[i+1]];paint();}},rowEl);});
                                button('Save order',async()=>{await call('playlistReorder',{id:p.id,paths:tracks.map(t=>t.filePath)});status.textContent='Playlist order saved.';},list);};paint();},r);
                    }
                }
            }catch(e){status.textContent=e.message;}
        });await refresh();
    }
    function applyAppearance(value){
        appearance=value||{};
        const root=document.documentElement;
        const tokens={accent:'accent',bg:'bg',text:'text',surface:'surface-2','text-muted':'text-3'};
        for(const key of Object.values(tokens))root.style.removeProperty('--'+key);
        for(const [key,color] of Object.entries(appearance.theme||{}))root.style.setProperty('--'+tokens[key],color);
        let custom=document.getElementById('rd-custom-style');if(!custom){custom=el('style');custom.id='rd-custom-style';document.head.append(custom);}custom.textContent=appearance.css||'';
        visual.hidden=!appearance.visualizer||appearance.visualizer==='none';wave.hidden=!appearance.waveform;
        if(!appearance.waveform)peaks=null;else trackKey='';
        updateArtAccent();
    }
    async function appearancePage(){
        const mode=select('Visualizer',[['none','Off'],['spectrum','Spectrum'],['scope','Oscilloscope'],['vu','VU meter'],['spectrogram','Spectrogram']]);mode.value=appearance.visualizer||'none';
        const accent=field('Accent color','color',appearance.theme?.accent||'#1ed760');
        const flags=row(),art=field('Accent from album art','checkbox','',flags),shape=field('Waveform seek bar (FFmpeg)','checkbox','',flags);art.checked=appearance.artAccent;shape.checked=appearance.waveform;
        const palette=field('Theme JSON (optional)','textarea',JSON.stringify(appearance.theme||{},null,2));
        const css=field('Local custom CSS (optional)','textarea',appearance.css||'');
        button('Apply and save',async()=>{const theme=JSON.parse(palette.value||'{}');theme.accent=accent.value;
            applyAppearance(await call('appearanceSave',{visualizer:mode.value,artAccent:art.checked,waveform:shape.checked,theme,css:css.value}));status.textContent='Appearance saved.';},body);
        button('Now Playing full screen',()=>nowPlaying(),body);
    }
    const parametric=new window.RhythmParametric.Parametric(engine,actions.equalizer);
    let bpm=120,clickTimer=null,nextBeat=0,countTimer=null;const clickNodes=new Set();
    function stopClick(){clearInterval(clickTimer);clickTimer=null;clearTimeout(countTimer);countTimer=null;
        for(const osc of clickNodes){try{osc.stop();}catch(_) {}}clickNodes.clear();}
    function click(at,strong){const ctx=engine.ctx;if(!ctx)return;
        const osc=ctx.createOscillator(),gain=ctx.createGain();osc.frequency.value=strong?1200:800;
        gain.gain.setValueAtTime(0,at);gain.gain.linearRampToValueAtTime(.05,at+.002);gain.gain.exponentialRampToValueAtTime(.0001,at+.045);
        osc.connect(gain);gain.connect(engine.gain);clickNodes.add(osc);osc.start(at);osc.stop(at+.05);osc.onended=()=>{clickNodes.delete(osc);osc.disconnect();gain.disconnect();};}
    async function startClick(){stopClick();engine._ensureGraph();await engine.ctx.resume();nextBeat=engine.ctx.currentTime+.03;let beat=0;
        const schedule=()=>{const interval=60/(bpm*engine.rate);while(nextBeat<engine.ctx.currentTime+.12){click(nextBeat,beat++%4===0);nextBeat+=interval;}};
        schedule();clickTimer=setInterval(schedule,40);}
    async function countIn(){stopClick();engine.pause();engine._ensureGraph();await engine.ctx.resume();
        const first=engine.ctx.currentTime+.1,interval=60/bpm;for(let i=0;i<4;i++)click(first+i*interval,i===0);
        countTimer=setTimeout(()=>{countTimer=null;if(!actions.isLocked())engine.play();},(4*interval+.1)*1000);}
    async function practice(){
        body.append(el('p','Use A–B repeat and pitch-preserving speed on the player. Count-in gives four beats before playback.'));
        const controls=row(),tempo=field('Tempo (BPM)','number',String(bpm),controls);tempo.min='30';tempo.max='300';
        tempo.addEventListener('change',()=>{bpm=Math.max(30,Math.min(300,Number(tempo.value)||120));tempo.value=bpm;});
        button('Start metronome',startClick,controls);button('Stop click',stopClick,controls);button('Four-beat count-in',countIn,controls);
        const cue=row(),label=field('Bookmark name','text','Cue',cue);button('Bookmark current position',async()=>{
            await call('bookmark',{filePath:actions.track()?.filePath,seconds:engine.seek(),label:label.value});await showBookmarks();},cue);
        const cues=el('div');body.append(cues);
        async function showBookmarks(){cues.replaceChildren();if(!actions.track()?.filePath)return;
            for(const mark of await call('bookmarks',actions.track().filePath)){const r=row(cues);button(`${mark.label} · ${mark.seconds.toFixed(1)}s`,()=>engine.seek(mark.seconds),r);
                button('Delete',async()=>{await call('bookmarkDelete',mark.id);showBookmarks();},r);}}
        await showBookmarks();
        body.append(el('h3','Parametric equalizer'));
        const profile=field('AutoEQ text profile','textarea','Preamp: -6 dB\nFilter 1: ON PK Fc 100 Hz Gain 3 dB Q 1');
        const bands=field('Editable bands (JSON)','textarea',JSON.stringify(parametric.state,null,2));
        const response=el('canvas',null,'rd-response');response.width=600;response.height=120;body.append(response);
        function draw(){const ctx=response.getContext('2d');ctx.clearRect(0,0,600,120);const freq=Float32Array.from({length:300},(_,i)=>20*(1000**(i/299)));
            const values=parametric.response(freq);ctx.strokeStyle=getComputedStyle(document.documentElement).getPropertyValue('--accent');ctx.beginPath();
            values.forEach((v,i)=>{const y=60-Math.max(-30,Math.min(30,20*Math.log10(v)))*2;i?ctx.lineTo(i*2,y):ctx.moveTo(0,y);});ctx.stroke();}
        button('Read AutoEQ profile',()=>{bands.value=JSON.stringify(window.RhythmParametric.autoEQ(profile.value),null,2);},body);
        button('Apply parametric EQ',()=>{const state=JSON.parse(bands.value);state.enabled=true;parametric.apply(state);
            api.setStoreValue('parametricEQ',parametric.state);api.setStoreValue('equalizer',actions.equalizer.toJSON());
            const graphic=document.getElementById('eq-enabled');if(graphic)graphic.checked=false;draw();status.textContent='Parametric EQ active. Graphic EQ is off.';},body);
        button('Bypass parametric EQ',()=>{parametric.apply({...parametric.state,enabled:false});api.setStoreValue('parametricEQ',parametric.state);draw();},body);draw();
    }
    let editState=null,editUndo=[];
    async function editor(){
        const track=actions.track();if(!track?.filePath)throw new Error('Open a song first.');
        if(editState?.filePath!==track.filePath){editState={filePath:track.filePath,sections:[{start:0,end:engine.duration(),gain:0,fadeIn:0,fadeOut:0}],pitch:0};editUndo=[];}
        body.append(el('p','Export a new file from one or more sections, in this order. Fades and gain apply to each section. Pitch shift preserves duration and is rendered with FFmpeg; the original song stays untouched.'));
        const history=()=>{editUndo.push(JSON.parse(JSON.stringify(editState)));if(editUndo.length>50)editUndo.shift();};
        const sections=el('div');body.append(sections);
        const paint=()=>{sections.replaceChildren();editState.sections.forEach((s,i)=>{
            const r=row(sections);r.append(el('strong',`Section ${i+1}`));
            for(const [key,label] of [['start','Start (s)'],['end','End (s)'],['gain','Gain (dB)'],['fadeIn','Fade in (s)'],['fadeOut','Fade out (s)']]){
                const input=field(label,'number',String(s[key]),r);input.step='.1';input.addEventListener('change',()=>{history();s[key]=Number(input.value);});}
            button('Preview section',()=>{engine.seek(s.start);engine.setLoop(s.start,s.end);engine.play();},r);
            button('↑',()=>{if(i){history();[editState.sections[i-1],editState.sections[i]]=[s,editState.sections[i-1]];paint();}},r);
            button('Remove',()=>{history();editState.sections.splice(i,1);paint();},r);
        });};paint();
        button('Add section from A–B',()=>{const loop=engine.getLoop();if(loop.start==null||loop.end==null)throw new Error('Set A and B on the player first.');
            history();editState.sections.push({start:loop.start,end:loop.end,gain:0,fadeIn:0,fadeOut:0});paint();},body);
        button('Add section at playhead',()=>{history();editState.sections.push({start:engine.seek(),end:engine.duration(),gain:0,fadeIn:0,fadeOut:0});paint();},body);
        button('Undo editor change',()=>{if(editUndo.length){editState=editUndo.pop();paint();}},body);
        button('Stop preview',()=>{engine.pause();engine.clearLoop();},body);
        const pitch=field('Pitch shift (semitones)','number',String(editState.pitch));pitch.min='-12';pitch.max='12';pitch.step='1';
        pitch.addEventListener('change',()=>{history();editState.pitch=Number(pitch.value);});
        const format=select('Export format',[['.flac','FLAC'],['.wav','WAV'],['.mp3','MP3'],['.m4a','M4A'],['.ogg','OGG']]);
        button('Export edited audio',async()=>{const result=await api.timelineExport({...editState,extension:format.value});
            if(!result.ok)throw new Error(result.error);if(!result.canceled)status.textContent=`Exported ${result.duration.toFixed(1)} seconds. Your original is preserved.`;},body);
        button('Cancel export',()=>api.mediaToolsCancel(),body);
    }
    async function filePage(ticket){
        const list=paths();body.append(el('p',`${list.length} selected songs. A preview is required before changes. Backups and undo records stay in your application data.`));
        const mode=select('Operation',[['tags','Edit shared tags'],['fromFilename','Tags from filename'],['organise','Organize filenames and folders']]);
        const inputs={};const fields=row();for(const key of ['artist','title','album','genre','year','track'])inputs[key]=field(key[0].toUpperCase()+key.slice(1),'text','',fields);
        const template=field('Filename pattern','text','%artist% - %title%'),destination=field('Destination folder','text','');destination.readOnly=true;
        button('Choose destination',async()=>{destination.value=await call('folderPick')||'';},body);
        let releaseId='',cover=null;
        const showMatches=results=>{if(!isCurrent(ticket))return;const container=el('div');body.append(container);
            for(const r of results)button(`${r.artist} — ${r.title} (${r.album}, ${r.year||''})`,()=>{
                for(const key of Object.keys(inputs))if(r[key])inputs[key].value=r[key];releaseId=r.releaseId;
                status.textContent='Match copied into the preview fields. Review before saving.';},container);};
        const lookup=row();button('Look up current song',async()=>{
            showMatches(await call('musicBrainz',actions.track()||{}));
        },lookup);
        button('Identify by audio',async()=>showMatches(await call('acoustID',list[0])),lookup);
        button('Fetch cover for chosen match',async()=>{const result=await call('coverArt',releaseId);if(!isCurrent(ticket))return;cover=result;
            const image=el('img');image.src=`data:${cover.mimeType};base64,${cover.data}`;image.alt='Cover to apply';image.width=120;body.append(image);
            status.textContent='Cover added to the next tag preview.';},lookup);
        const presets=await call('tagPresetsGet');if(!isCurrent(ticket))return;
        const preset=select('Saved tag preset',[['','Choose'],...presets.map(p=>[p.name,p.name])]);preset.addEventListener('change',()=>{
            const p=presets.find(p=>p.name===preset.value);if(p)for(const [key,value] of Object.entries(p.values))if(inputs[key])inputs[key].value=value;});
        const presetName=field('Preset name','text','');const values=()=>Object.fromEntries(Object.entries(inputs).filter(([,v])=>v.value!=='').map(([k,v])=>[k,v.value]));
        button('Save tag preset',async()=>{await call('tagPresetSave',{name:presetName.value,values:values()});status.textContent='Preset saved.';},body);
        const preview=el('pre',null,'rd-preview');body.append(preview);let journal=null;
        button('Preview changes',async()=>{journal=await call('filePreview',{files:list,mode:mode.value,values:values(),template:template.value,destination:destination.value,cover});
            preview.textContent=journal.rows.map(r=>`${r.filePath}\n→ ${r.target||JSON.stringify(r.values)}`).join('\n\n');},body);
        const apply=button('Apply this preview',async()=>{if(!journal)throw new Error('Preview the changes first.');apply.disabled=true;
            try{journal=await call('fileApply',journal.id);preview.textContent=JSON.stringify(journal.rows.map(r=>({file:r.filePath,state:r.state,error:r.error})),null,2);
                status.textContent=journal.state==='done'?'Changes saved. Undo is available below.':'Some files need attention. Review the result; completed files can be undone.';}finally{apply.disabled=false;}},body);
        for(const j of await call('fileJournals'))if(['done','partial'].includes(j.state))button(`Undo ${j.mode} · ${new Date(j.createdAt).toLocaleString()} · ${j.count} songs`,async()=>{
            await call('fileUndo',j.id);status.textContent='Changes undone.';},body);
        button('Refresh undo list',()=>open('Files'),body);
    }
    let activeEpisode=null,episodeSaveAt=0;
    const playRadio=station=>{activeEpisode=null;dialog.close();actions.playStream(station.url,station.title);};
    async function broadcasts(ticket){
        body.append(el('h3','Internet radio'));
        body.append(el('p','Play a direct HTTPS audio stream or find a station. Live radio plays locally; shared rooms use imported audio files. HLS stations require a future decoder.'));
        const radio=row(),url=field('Station URL','url','',radio),title=field('Station name','text','Radio',radio);
        button('Save station',async()=>{await call('radioSave',{url:url.value,title:title.value});open('Broadcasts');},radio);
        const search=field('Find stations','search','');
        button('Search Radio Browser',async()=>{const results=await call('radioSearch',search.value);if(!isCurrent(ticket))return;const list=el('div');body.append(list);
            for(const s of results){const r=row(list);button(`${s.title} · ${s.country||''}`,()=>playRadio(s),r);button('Save',async()=>{await call('radioSave',s);status.textContent='Station saved.';},r);}},body);
        for(const s of await call('radioList')){if(!isCurrent(ticket))return;const r=row();button(s.title,()=>playRadio(s),r);button('Delete',async()=>{await call('radioDelete',s.url);open('Broadcasts');},r);}
        body.append(el('h3','Podcasts'));
        const feed=field('RSS or Atom feed address','url','');button('Follow podcast',async()=>{await call('podcastSubscribe',feed.value);open('Broadcasts');},body);
        for(const p of await call('podcastList')){if(!isCurrent(ticket))return;
            const details=el('details'),summary=el('summary',`${p.title} · ${p.episodes.length} episodes`);details.append(summary);body.append(details);
            const controls=row(details);button('Refresh',async()=>{await call('podcastSubscribe',p.url);open('Broadcasts');},controls);
            button('Unfollow',async()=>{await call('podcastRemove',p.url);open('Broadcasts');},controls);
            for(const episode of p.episodes){const r=row(details);r.append(el('span',episode.title));
                button('Download & resume',async()=>{status.textContent='Downloading episode…';const file=await call('podcastDownload',episode.url);
                    const seconds=await call('podcastPositionGet',episode.url);activeEpisode={url:episode.url,filePath:file.filePath};dialog.close();
                    await actions.playPaths([file.filePath],0,{seekTime:seconds});},r);
                button('Save download',async()=>{const file=await call('podcastDownload',episode.url);const saved=await api.remoteAudioSave(file.filePath);
                    if(!saved.ok)throw new Error(saved.error);status.textContent='Episode saved in your incoming music folder.';},r);
            }
        }
        body.append(el('p','Unsaved episodes use the existing two-day audio cache. Resume positions are remembered separately.'));
    }
    async function accounts(){
        const state=await call('providerStatus');body.append(el('p','Sharing server and account credentials are configured here. Scrobbling is off until enabled. Only song tags and listening times are sent; local paths are excluded.'));
        const lb=field('ListenBrainz token','password','');lb.autocomplete='off';const enabled=field('Submit listens to ListenBrainz','checkbox','');enabled.checked=state.listenbrainz.enabled;
        button('Save ListenBrainz',async()=>{await call('providerSave',{provider:'listenbrainz',token:lb.value,enabled:enabled.checked});lb.value='';status.textContent='ListenBrainz settings saved.';},body);
        body.append(el('h3','Last.fm'));
        const key=field('API key','password',''),secret=field('API secret','password','');key.autocomplete=secret.autocomplete='off';
        const lfEnabled=field('Submit listens to Last.fm','checkbox','');lfEnabled.checked=state.lastfm.enabled;
        button('Save Last.fm',async()=>{await call('providerSave',{provider:'lastfm',enabled:lfEnabled.checked,apiKey:key.value,apiSecret:secret.value});key.value=secret.value='';status.textContent='Saved. Connect the account next.';},body);
        button('1. Connect Last.fm',async()=>{await call('lastfmStart');status.textContent='Approve Rhythm Dock in your browser, then select Finish connection.';},body);
        button('2. Finish connection',async()=>{await call('lastfmFinish');status.textContent='Last.fm connected.';},body);
        body.append(el('h3','Discord listening status'));
        const discord=await call('discordGet'),clientId=field('Discord application ID','text',discord.clientId),showDiscord=field('Share song title and artist on Discord','checkbox','');
        showDiscord.checked=discord.enabled;
        body.append(el('p',discord.connected?'Discord connected.':discord.error||'Off by default. Requires the Discord desktop app; song tags become visible on your profile.'));
        button('Save Discord preference',async()=>{await call('discordSave',{enabled:showDiscord.checked,clientId:clientId.value});status.textContent='Discord preference saved. Start a song to connect.';},body);
        body.append(el('h3','Audio identification'));
        const acoust=field('AcoustID application key','password','');acoust.autocomplete='off';
        button('Save AcoustID key',async()=>{await call('acoustidSave',acoust.value);acoust.value='';status.textContent='AcoustID configured.';},body);
        button('Choose Chromaprint fpcalc',async()=>{if(await call('fpcalcPick'))status.textContent='Fingerprint tool saved.';},body);
        button('Send pending listens',async()=>{status.textContent=JSON.stringify(await call('scrobbleFlush'));},body);
        button('Discard pending listens',async()=>{await call('scrobbleClear');status.textContent='Pending listens removed.';},body);
        for(const p of ['listenbrainz','lastfm'])button('Disconnect '+p,async()=>{await call('providerDisconnect',p);open('Accounts');},body);
        status.textContent=`ListenBrainz ${state.listenbrainz.connected?'connected':'not connected'} · Last.fm ${state.lastfm.connected?'connected':'not connected'}\nPending: ${state.pending.reduce((n,p)=>n+p.pending,0)}`;
        button('Find similar local artists online',async()=>{
            const results=await call('similarArtists',actions.track()?.artist),list=el('div');body.append(list);
            for(const r of results)button(r.artist,async()=>{const data=await call('catalog',{rules:{artist:r.artist},limit:200});if(!data.total)throw new Error('This artist is not in your library yet.');actions.playPaths(data.rows.map(t=>t.filePath));},list);
        },body);
    }
    async function setup(){
        const saved=await api.roomSavedHost();
        if(saved)button(`Resume hosted room ${saved.code}`,async()=>{const result=await api.roomResumeHost();
            if(!result.ok)throw new Error(result.error);status.textContent='Room resumed. Playback stays paused until you press Play.';},body);
        body.append(el('p','Start with your music folder. To listen together, enter the server address once, check the connection, then use Sharing to create or join a room. Your phone can join through the server’s browser page.'));
        button('Choose music folder',async()=>{const r=await api.libraryAddRoot();if(r?.ok===false)throw new Error(r.error);api.setStoreValue('onboardingComplete',true);status.textContent='Folder added. Browse Library while the scan finishes.';},body);
        const server=field('Sharing server address','url',(await api.getStoreValue('roomServerUrl'))||'');server.placeholder='https://music.example.com';
        button('Check and save server',async()=>{const r=await call('serverCheck',server.value.trim());status.textContent=r.message;
            const existing=document.getElementById('room-server');if(existing)existing.value=server.value.trim();},body);
        button('Open Sharing settings',()=>{dialog.close();actions.tab('settings');document.getElementById('room-server')?.scrollIntoView();},body);
        button('Set up later',()=>{api.setStoreValue('onboardingComplete',true);dialog.close();},body);
    }
    async function layouts(){
        const name=field('Layout name','text','');button('Save current window layout',async()=>{await call('layoutSave',name.value);open('Layouts');},body);
        for(const p of await call('layoutList')){const r=row();button(p.name,async()=>{dialog.close();await call('layoutApply',p.name);actions.tab('player');},r);
            button('Delete',async()=>{await call('layoutDelete',p.name);open('Layouts');},r);}
    }
    async function settingsPage(){
        button('Export preferences',async()=>{if(await call('settingsExport'))status.textContent='Preferences exported. Accounts and device routing were excluded.';},body);
        button('Import preferences',async()=>{if(await call('settingsImport'))status.textContent='Preferences imported. Restart Rhythm Dock to apply all changes.';},body);
        const login=field('Start at login (installed Windows/macOS app)','checkbox','');login.checked=await call('loginGet');
        login.disabled=/Linux/i.test(navigator.platform);
        login.addEventListener('change',async()=>{try{login.checked=await call('loginSet',login.checked);}catch(e){login.checked=!login.checked;status.textContent=e.message;}});
        const notifications=field('Show track-change notifications','checkbox','');notifications.checked=Boolean(await api.getStoreValue('trackNotifications'));
        notifications.addEventListener('change',()=>api.setStoreValue('trackNotifications',notifications.checked));
        button('Show local diagnostics',async()=>{const pre=el('pre',await call('diagnostics'),'rd-preview');body.append(pre);},body);
        button('Export diagnostics',()=>api.diagnosticsExport(),body);
        body.append(el('h3','Crash reports (off by default)'));
        body.append(el('p','When enabled, a crash sends the last 50 diagnostic events to your endpoint. Reports contain app version, event names and codes, without file paths, URLs, account details or error stacks.'));
        const config=await call('crashConfigGet'),endpoint=field('Crash-report endpoint','url',config.endpoint),enabled=field('Send anonymous crash reports','checkbox','');enabled.checked=config.enabled;
        button('Save crash-report preference',async()=>{await call('crashConfigSave',{enabled:enabled.checked,endpoint:endpoint.value});status.textContent='Crash-report preference saved.';},body);
        button('Send a test report',async()=>{if(!await call('crashReportTest'))throw new Error('Reporting is off or the endpoint could not accept the report.');status.textContent='Test report accepted.';},body);
    }
    async function palette(){
        if(actions.isLocked())return;
        if(dialog.open)dialog.close();
        actions.tab('settings');
        const scroll=settingsPanel.querySelector('.settings-scroll');
        if(scroll)scroll.scrollTop=0;
        if(window.settingsNavigation)window.settingsNavigation.home();
        else categories.querySelector('button')?.focus({preventScroll:true});
    }
    const visual=el('canvas');visual.id='rd-visual';visual.width=512;visual.height=64;visual.setAttribute('aria-label','Audio visualizer');visual.hidden=true;
    const wave=el('canvas');wave.id='rd-waveform';wave.width=512;wave.height=52;wave.tabIndex=0;wave.setAttribute('role','slider');wave.setAttribute('aria-label','Waveform seek');wave.hidden=true;
    const progress=document.getElementById('progress-bar');progress?.parentElement.append(wave,visual);
    function updateArtAccent(){if(!appearance.artAccent)return;const image=document.getElementById('album-art');
        if(!image?.complete||!image.naturalWidth)return;
        try{const canvas=el('canvas');canvas.width=canvas.height=32;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0,32,32);
            const color=window.RhythmArtAccent.color(ctx.getImageData(0,0,32,32).data);if(color)document.documentElement.style.setProperty('--accent',color);
        }catch(_) {}}
    document.getElementById('album-art')?.addEventListener('load',updateArtAccent);
    wave.addEventListener('click',e=>{if(actions.isLocked()||!actions.canControl())return;engine.seek((e.clientX-wave.getBoundingClientRect().left)/wave.clientWidth*engine.duration());});
    wave.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key)||actions.isLocked()||!actions.canControl())return;
        e.preventDefault();engine.seek(Math.max(0,engine.seek()+(e.key==='ArrowLeft'?-5:5)));});
    function drawVisual(canvas,mode){
        const ctx=canvas.getContext('2d'),a=engine.analyser;if(!a)return;const w=canvas.width,h=canvas.height;
        const color=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()||'#1ed760';
        const bytes=new Uint8Array(a.frequencyBinCount);
        if(mode==='spectrogram'){
            const previous=ctx.getImageData(1,0,w-1,h);ctx.putImageData(previous,0,0);a.getByteFrequencyData(bytes);
            for(let y=0;y<h;y++){const value=bytes[Math.floor((h-y-1)/h*bytes.length)];ctx.fillStyle=`hsl(${240-value*.8} 85% ${value/5}%)`;ctx.fillRect(w-1,y,1,1);}return;
        }
        ctx.clearRect(0,0,w,h);ctx.fillStyle=ctx.strokeStyle=color;
        if(mode==='scope'||mode==='vu'){
            a.getByteTimeDomainData(bytes);
            if(mode==='vu'){const rms=Math.sqrt(bytes.reduce((n,v)=>n+((v-128)/128)**2,0)/bytes.length);ctx.fillRect(0,0,Math.min(w,rms*w*2),h);return;}
            ctx.beginPath();for(let i=0;i<bytes.length;i++){const x=i/bytes.length*w,y=bytes[i]/256*h;i?ctx.lineTo(x,y):ctx.moveTo(x,y);}ctx.stroke();
        }else{a.getByteFrequencyData(bytes);for(let i=0;i<64;i++){const value=bytes[Math.floor(i/64*bytes.length)]/255*h;ctx.fillRect(i*w/64,h-value,w/64-2,value);}}
    }
    async function nowPlaying(){
        if(actions.isLocked())return;if(full)return;dialog.close();await actions.exitLyricsFullscreen();await api.setFullscreen(true);
        full=el('section',null,'rd-full');full.setAttribute('role','dialog');full.setAttribute('aria-label','Now Playing');
        const close=button('Exit full screen (Esc)',()=>closeFull(),full),art=el('img'),title=el('h1'),artist=el('p'),line=el('div',null,'rd-current-lyric');art.alt='Album art';
        const canvas=el('canvas');canvas.width=800;canvas.height=100;full.append(art,title,artist,line,canvas);const transport=row(full);
        button('Previous',()=>actions.transport('prev'),transport);button('Play / Pause',()=>actions.transport('play-pause'),transport);button('Next',()=>actions.transport('next'),transport);
        document.body.append(full);close.focus();
        fullTimer=setInterval(()=>{if(document.hidden)return;const track=actions.track();title.textContent=track?.title||'Nothing playing';artist.textContent=track?.artist||'';
            const src=document.getElementById('album-art')?.src;if(src&&art.src!==src)art.src=src;line.textContent=actions.lyric();
            line.dir=/[\u0600-\u06ff]/.test(line.textContent)?'rtl':'auto';drawVisual(canvas,appearance.visualizer==='none'?'spectrum':appearance.visualizer||'spectrum');},80);
    }
    async function closeFull(){clearInterval(fullTimer);full?.remove();full=null;await api.setFullscreen(false);document.getElementById('play-pause-btn')?.focus();}
    const drawTimer=setInterval(()=>{
        if(activeEpisode&&actions.track()?.filePath===activeEpisode.filePath&&Date.now()-episodeSaveAt>5000){
            episodeSaveAt=Date.now();call('podcastPositionSet',{url:activeEpisode.url,seconds:engine.hasEnded()?0:engine.seek()}).catch(()=>{});}
        if(document.hidden)return;
        if(!visual.hidden&&engine.isPlaying())drawVisual(visual,appearance.visualizer);
        if(peaks&&!wave.hidden){const ctx=wave.getContext('2d');ctx.clearRect(0,0,512,52);const seek=engine.seek()/engine.duration()*512;
            const color=getComputedStyle(document.documentElement).getPropertyValue('--accent');
            for(let i=0;i<peaks.length;i++){ctx.fillStyle=i<seek?color:'#888';ctx.fillRect(i,26-peaks[i]*25,1,Math.max(1,peaks[i]*50));}
            wave.setAttribute('aria-valuenow',String(Math.round(engine.seek())));wave.setAttribute('aria-valuemax',String(Math.round(engine.duration())));wave.setAttribute('aria-valuemin','0');}
        const track=actions.track();if(!track?.filePath||track.filePath===trackKey)return;
        trackKey=track.filePath;peaks=null;const key=trackKey,ticket=++waveTicket;
        if(appearance.waveform)call('waveform',key).then(r=>{if(ticket===waveTicket){peaks=r.peaks;wave.title='Click to seek; arrow keys move five seconds.';}})
            .catch(error=>{if(ticket===waveTicket)wave.title=error.message;});
        updateArtAccent();
    },80);
    engine.on('statechange',({state})=>{if(['ended','paused','error','idle'].includes(state))stopClick();});
    document.getElementById('eq-enabled')?.addEventListener('change',()=>{parametric.state.enabled=false;api.setStoreValue('parametricEQ',parametric.state);});
    document.addEventListener('keydown',e=>{
        if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();e.stopImmediatePropagation();palette();}
        if(e.key==='Escape'&&full){e.preventDefault();closeFull();}
        if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key.toLowerCase()==='b'){e.preventDefault();open('Practice');}
    });
    api.onFullscreenChanged?.(enabled=>{if(!enabled&&full){clearInterval(fullTimer);full.remove();full=null;}});
    const ready=async()=>{
        for(const b of document.querySelectorAll('button[title]'))if(!b.hasAttribute('aria-label'))b.setAttribute('aria-label',b.title);
        applyAppearance(await call('appearanceGet'));
        const saved=await api.getStoreValue('parametricEQ');if(saved?.enabled)parametric.apply(saved);
        if(!await api.getStoreValue('onboardingComplete')&&!(await api.libraryRoots()).length&&!actions.track())open('Setup');
    };
    const observer=new MutationObserver(()=>{if(document.documentElement.dataset.appReady==='true'){observer.disconnect();ready().catch(()=>{});}});
    observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-app-ready']});
    if(document.documentElement.dataset.appReady==='true'){observer.disconnect();ready().catch(()=>{});}
    window.addEventListener('beforeunload',()=>{clearInterval(drawTimer);clearInterval(fullTimer);stopClick();observer.disconnect();});
    return {open,palette,parametric,call,selected,nowPlaying,playRadio};
}
