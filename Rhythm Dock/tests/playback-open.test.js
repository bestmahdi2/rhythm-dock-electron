'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {artifacts, configure} = require('../src/main/services/file-menu');
const context = {window:{}, console, URL, clearTimeout};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/renderer/js/audio/engine.js'),'utf8'),context);
const engine = context.window.RhythmAudio.engine;
engine._ensureGraph = () => {};
engine._releaseIdleDeck = () => {};
engine._applyPreservePitch = () => {};
const listeners = {};
const element = {load(){}, addEventListener(name, handler){listeners[name]=handler;}};
engine.decks = [{element}];
for (const [duration, seek, expected] of [
    [299,120,0], [300,120,120], [3600,10,0], [3600,10.1,10.1],
    [3600,3590,0], [3600,3589,3589], [3600,3700,0], [NaN,120,0],
]) {
    element.duration=duration; element.currentTime=0;
    engine.load('/music/podcast.mp3',{seek,resumeFromHistory:true});
    listeners.loadedmetadata();
    assert.equal(element.currentTime,expected,`resume ${seek}/${duration}`);
}
engine.load('/music/podcast.mp3',{seek:42,resumeFromHistory:true});
const obsolete = listeners.loadedmetadata;
engine.load('/music/other.mp3',{seek:0});
element.currentTime=0;obsolete();
assert.equal(element.currentTime,0,'late metadata must not seek a newer track');

const rendererSource = fs.readFileSync(path.join(__dirname,'../src/renderer/js/renderer.js'),'utf8');
const queueSource = rendererSource.slice(rendererSource.indexOf('const QUEUE_POSITIONS ='),rendererSource.indexOf('/** The three queue actions'));
const queueContext = {playlist:['current','old-next'],originalPlaylist:[],currentIndex:0,
    updateNextTrackHint(){},savePlaybackState(){},publishRoomLibrary(){},isPlaylistVisible:false,showToast(){}};
vm.createContext(queueContext);vm.runInContext(queueSource,queueContext);
queueContext.enqueueFiles(['one','two','three']);
assert.equal(queueContext.playlist.join(','),'current,one,two,three,old-next');
queueContext.enqueueFiles(['one','one']);
assert.equal(queueContext.playlist.filter(file=>file==='one').length,1);
const config = {home:'/home/test',extensions:['.mp3','.wav'],mimeTypes:['audio/mpeg'],command:["/opt/Player's App/player"]};
const linux=artifacts({...config,platform:'linux'});
assert.equal(linux.length,4);
assert.ok(linux[0].text.includes('--enqueue "${files[@]}"'));
assert.ok(linux[0].text.includes("'/opt/Player'\"'\"'s App/player'"));
assert.ok(linux[3].text.includes(' %F'));
const mac=artifacts({...config,platform:'darwin'});
assert.equal(mac.length,2);
assert.ok(mac[1].text.includes('runWorkflowAsService') || mac[0].text.includes('runWorkflowAsService'));
assert.ok(mac[1].text.includes('files=()'));
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
if (fs.existsSync(bash)) {
    const {spawnSync} = require('node:child_process');
    const command = [process.execPath.replace(/\\/g,'/'), '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--'];
    const selections = ["/music/artist's song.MP3", '/music/remix $(echo unsafe).wav', '/music/unsupported.txt'];
    const linuxScript = artifacts({...config,platform:'linux',command})[0].text;
    const environment = {...process.env, MSYS_NO_PATHCONV:'1'};
    const result = spawnSync(bash,['-c',linuxScript,'--',...selections],{encoding:'utf8',env:environment});
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),['--enqueue',...selections.slice(0,2)]);
    const workflow = artifacts({...config,platform:'darwin',command})[1].text;
    const script = workflow.match(/<key>COMMAND_STRING<\/key><string>([\s\S]*?)<\/string>/)[1]
        .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
    const service = spawnSync(bash,['-c',script],{input:selections.join('\n')+'\n',encoding:'utf8',env:environment});
    assert.equal(service.status,0,service.stderr);
    assert.deepEqual(JSON.parse(service.stdout),['--enqueue',...selections.slice(0,2)]);
}
(async()=>{
    const temporary=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'rhythm-file-menu-'));
    try {
        const options={...config,home:temporary,platform:'linux'};
        await configure({...options,enabled:true});
        for(const file of artifacts(options))assert.equal(fs.readFileSync(file.path,'utf8'),file.text);
        await configure({...options,enabled:false});
        for(const file of artifacts(options))assert.equal(fs.existsSync(file.path),false);
    } finally {fs.rmSync(temporary,{recursive:true,force:true});}
    console.log('PASS: resume boundaries, stale seeks, ordered queue batches and file-menu artifacts/install/remove');
})().catch(error=>{console.error(error);process.exitCode=1;});
