'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const audio=require('../src/main/services/platform-audio');

(async()=>{
    const youtube='https://www.youtube.com/watch?v=abcdefghijk';
    assert.equal(audio.source('https://music.youtube.com/watch?v=abcdefghijk&list=unused').url,youtube);
    assert.equal(audio.source('https://youtu.be/abcdefghijk?t=20').url,youtube);
    assert.equal(audio.source('https://youtube.com/shorts/abcdefghijk').url,youtube);
    assert.equal(audio.source('https://example.com/song.mp3'),null);
    assert.throws(()=>audio.source('https://youtube.com/playlist?list=foo'),/video/);
    assert.throws(()=>audio.source('https://open.spotify.com/playlist/abc'),/individual/);
    assert.throws(()=>audio.source('file:///tmp/file'),/HTTPS/);
    const spotify='https://open.spotify.com/track/1234567890123456789012';
    assert.equal(audio.source(spotify).provider,'spotify');
    const youtubeCommand=audio.commandFor(audio.source(youtube),'/cache',{ffmpeg:'/tools/ffmpeg'});
    for(const flag of ['--ignore-config','--no-playlist','--embed-metadata','--embed-thumbnail','--extract-audio'])assert.ok(youtubeCommand.args.includes(flag));
    assert.equal(youtubeCommand.args.at(-1),youtube);
    const spotifyCommand=audio.commandFor(audio.source(spotify),'/cache',{});
    assert.equal(spotifyCommand.executable,'spotdl');assert.ok(spotifyCommand.args.includes('--headless'));
    const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'rhythm-platform-audio-'));
    try{
        let downloads=0;
        const fakeRun=async(_executable,_args,{directory})=>{
            downloads++;fs.writeFileSync(path.join(directory,'Artist - Title.mp3'),'ID3-tagged-audio');
        };
        const first=await audio.download(youtube,temporary,{runImpl:fakeRun});
        assert.equal(first.cached,false);
        const cached=await audio.download('https://youtu.be/abcdefghijk',temporary,{runImpl:fakeRun});
        assert.equal(cached.cached,true);assert.equal(downloads,1);
        assert.equal(fs.readFileSync(cached.files[0],'utf8'),'ID3-tagged-audio');
        assert.equal(audio.cachedFile(cached.files[0],[temporary]),fs.realpathSync(cached.files[0]));
        assert.throws(()=>audio.cachedFile(__filename,[temporary]),/cached/);
        const outside=path.join(temporary,'..',path.basename(temporary)+'-outside.mp3');
        fs.writeFileSync(outside,'external');
        try{assert.throws(()=>audio.cachedFile(outside,[temporary]),/cached/);}finally{fs.rmSync(outside);}
        const aborted=new AbortController();aborted.abort();
        await assert.rejects(audio.download(spotify,temporary,{signal:aborted.signal,runImpl:fakeRun}),/cancelled/);
        assert.equal(fs.readdirSync(path.join(temporary,'.jobs')).length,0,'cancelled jobs must clean up');
        await assert.rejects(audio.run('not-installed',[],{spawnImpl:()=>{
            const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
            process.nextTick(()=>child.emit('error',Object.assign(new Error('missing'),{code:'ENOENT'})));
            return child;
        }}),/not installed/);
        let usedShell;
        await audio.run('fake',[],{spawnImpl:(_exe,_args,options)=>{
            usedShell=options.shell;
            const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
            process.nextTick(()=>child.emit('close',0));return child;
        }});
        assert.equal(usedShell,false);
    }finally{fs.rmSync(temporary,{recursive:true,force:true});}
    console.log('PASS: platform URLs, downloader arguments, metadata flags, cache reuse, cancellation, cleanup and export boundaries');
})().catch(error=>{console.error(error);process.exitCode=1;});
