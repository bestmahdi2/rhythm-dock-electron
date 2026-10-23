'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const cache = require('./remote-cache');
const MAX_BYTES = 200 * 1024 * 1024;
const pending = new Map();

function source(value) {
    const url = cache.validateUrl(value);
    const host = url.hostname.toLowerCase();
    if (['youtube.com','www.youtube.com','music.youtube.com','m.youtube.com','youtu.be'].includes(host)) {
        let id = host === 'youtu.be' ? url.pathname.slice(1).split('/')[0] : url.searchParams.get('v');
        if (!id) id = /^\/(?:shorts|embed|live)\/([^/]+)/.exec(url.pathname)?.[1];
        if (!/^[\w-]{11}$/.test(id || '')) throw new Error('Paste a YouTube video or YouTube Music song link.');
        return {provider:'youtube',url:`https://www.youtube.com/watch?v=${id}`};
    }
    if (['open.spotify.com','www.open.spotify.com'].includes(host)) {
        const match = /^\/(?:intl-[a-z]+\/)?track\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname);
        if (!match) throw new Error('Spotify currently supports individual track links.');
        return {provider:'spotify',url:`https://open.spotify.com/track/${match[1]}`};
    }
    return null;
}

function commandFor(item, directory, tools={}) {
    if(item.provider==='spotify') return {executable:tools.spotdl||'spotdl',args:[
        'download',item.url,'--format','mp3','--bitrate','0','--threads','1',
        '--output',path.join(directory,'{artists} - {title}.{output-ext}'),'--restrict',
        '--ffmpeg',tools.ffmpeg||'ffmpeg','--headless','--lyrics',
    ]};
    const args=['--ignore-config','--no-playlist','--no-progress','--newline','--no-warnings',
        '--socket-timeout','30','--retries','3','--max-filesize',String(MAX_BYTES),
        '--match-filter','!is_live','-f','bestaudio/best','--extract-audio','--audio-format','mp3',
        '--audio-quality','0','--embed-metadata','--embed-thumbnail','--convert-thumbnails','jpg',
        '--windows-filenames','--trim-filenames','180','--paths',directory,
        '--output','%(title).140B [%(id)s].%(ext)s'];
    if(tools.ffmpeg)args.push('--ffmpeg-location',tools.ffmpeg);
    args.push('--print','after_move:filepath','--',item.url);
    return {executable:tools.ytdlp||'yt-dlp',args};
}

function run(executable,args,{signal,directory,onProgress=()=>{},spawnImpl=spawn,timeoutMs=20*60000}={}) {
    return new Promise((resolve,reject)=>{
        if(signal?.aborted)return reject(new Error('Link download cancelled.'));
        const child=spawnImpl(executable,args,{shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
        let output='',failure=null;
        const stop=message=>{
            failure=new Error(message);
            if(process.platform==='win32'&&child.pid){
                const killer=spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore'});
                killer.once('error',()=>child.kill());
            }else{
                try{if(child.pid)process.kill(-child.pid,'SIGTERM');else child.kill();}
                catch(_){child.kill();}
            }
        };
        const abort=()=>stop('Link download cancelled.');
        signal?.addEventListener('abort',abort,{once:true});
        const timer=setTimeout(()=>stop('Link download timed out.'),timeoutMs);
        const sizeTimer=directory&&setInterval(()=>{
            try {
                const total=fs.readdirSync(directory).reduce((sum,name)=>{
                    const stat=fs.statSync(path.join(directory,name));return sum+(stat.isFile()?stat.size:0);
                },0);
                if(total>MAX_BYTES)stop('Link download exceeds the 200 MB limit.');
            }catch(_){/* A downloader may rename a temporary file during inspection. */}
        },500);
        const clean=()=>{clearTimeout(timer);clearInterval(sizeTimer);signal?.removeEventListener('abort',abort);};
        for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{
            output=(output+String(data).replace(/\x1b\[[0-9;]*m/g,'')).slice(-8192);
            onProgress({stage:'Downloading and tagging audio…'});
        });
        child.once('error',error=>{clean();reject(new Error(error.code==='ENOENT'
            ? `${path.basename(executable)} is not installed. Choose its executable in Settings → YouTube & Spotify links.`:error.message));});
        child.once('close',code=>{
            clean();
            if(failure)return reject(failure);
            if(code!==0)return reject(new Error(output.trim().slice(-1200)||'The provider could not download this track. Update yt-dlp/spotDL and check FFmpeg and Deno.'));
            resolve(output);
        });
    });
}

async function download(value,root,{tools={},signal,onProgress=()=>{},runImpl=run}={}) {
    const item=source(value);
    if(!item)throw new Error('Unsupported platform link.');
    const key=crypto.createHash('sha256').update(item.url).digest('hex');
    if(pending.has(key))return pending.get(key);
    const task=(async()=>{
        const directory=path.join(root,key),manifest=path.join(directory,'source.json');
        try {
            const entry=JSON.parse(fs.readFileSync(manifest,'utf8'));
            const filePath=path.join(directory,path.basename(entry.fileName));
            if(path.extname(filePath)==='.mp3'&&fs.statSync(filePath).size>0){
                const now=new Date();fs.utimesSync(filePath,now,now);fs.utimesSync(manifest,now,now);
                return {files:[filePath],errors:[],cached:true,provider:item.provider};
            }
        }catch(_){/* Missing/evicted/incomplete entry: fetch again. */}
        const work=path.join(root,'.jobs',`${key}-${crypto.randomUUID()}`);
        fs.mkdirSync(work,{recursive:true});
        try {
            onProgress({stage:item.provider==='spotify'?'Matching Spotify track on YouTube…':'Fetching YouTube audio…'});
            const command=commandFor(item,work,tools);
            await runImpl(command.executable,command.args,{directory:work,signal,onProgress});
            if(signal?.aborted)throw new Error('Link download cancelled.');
            const files=fs.readdirSync(work).filter(name=>name.toLowerCase().endsWith('.mp3'));
            if(files.length!==1)throw new Error('The provider did not produce one playable MP3.');
            const name=files[0],input=path.join(work,name),stat=fs.statSync(input);
            if(!stat.isFile()||!stat.size||stat.size>MAX_BYTES)throw new Error('Invalid or oversized downloaded audio.');
            fs.mkdirSync(directory,{recursive:true});
            const filePath=path.join(directory,name);
            fs.renameSync(input,filePath);
            fs.writeFileSync(manifest,JSON.stringify({...item,fileName:name}));
            if(cache.prune(root,[filePath,manifest])>512*1024*1024){
                fs.rmSync(filePath,{force:true});fs.rmSync(manifest,{force:true});
                throw new Error('Temporary cache is full. Save tracks or try again later.');
            }
            return {files:[filePath],errors:[],cached:false,provider:item.provider};
        }finally{fs.rmSync(work,{recursive:true,force:true});}
    })();
    pending.set(key,task);
    try{return await task;}finally{pending.delete(key);}
}

function cachedFile(filePath,roots) {
    if(typeof filePath!=='string'||!path.isAbsolute(filePath))throw new Error('Choose a cached link track.');
    const resolved=fs.realpathSync(filePath);
    const inside=roots.some(root=>{
        if(!fs.existsSync(root))return false;
        const relative=path.relative(fs.realpathSync(root),resolved);
        return relative&&!relative.startsWith('..')&&!path.isAbsolute(relative);
    });
    if(!inside||!fs.statSync(resolved).isFile())throw new Error('Choose a cached link track.');
    return resolved;
}
module.exports={source,commandFor,run,download,cachedFile};
