'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {create}=require('../src/main/services/audio-interruptions');

const emitter=()=>{
    const object=new EventEmitter();object.addEventListener=object.on.bind(object);object.removeEventListener=object.removeListener.bind(object);return object;
};
const session=emitter();session.state='inactive';
let playing=true,context=emitter(),pauses=[];
context.state='suspended';
const scope={window:{},console,setTimeout,clearTimeout,navigator:{audioSession:session}};
vm.createContext(scope);vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/renderer/js/audio/devices.js'),'utf8'),scope);
const watcher=new scope.window.RhythmDevices.AudioInterruptionWatcher({getContext:()=>context,isPlaying:()=>playing,onInterrupt:reason=>pauses.push(reason)});
watcher.start();watcher.bindContext();
assert.equal(pauses.length,0,'initial browser autoplay suspension is not an interruption');
context.state='running';context.emit('statechange');
context.state='suspended';context.emit('statechange');assert.equal(pauses.length,1);
context.state='running';context.emit('statechange');assert.equal(pauses.length,1,'audio recovery never auto-resumes or toggles playback');
session.state='interrupted';session.emit('statechange');assert.equal(pauses.length,2);
playing=false;context.state='interrupted';context.emit('statechange');assert.equal(pauses.length,2);
playing=true;watcher.stop();session.emit('statechange');context.emit('statechange');assert.equal(pauses.length,2);
watcher.start();assert.equal(context.listenerCount('statechange'),1);
const old=context;context=emitter();context.state='running';watcher.bindContext();assert.equal(old.listenerCount('statechange'),0);
watcher.stop();assert.equal(context.listenerCount('statechange'),0);assert.equal(session.listenerCount('statechange'),0);

const powerMonitor=new EventEmitter();const settings={pauseOnInterruption:true,pauseOnSleep:true};
let child,launches=0;const messages=[];
const monitor=create({powerMonitor,platform:'win32',getStore:()=>({get:(key,fallback)=>settings[key]??fallback}),
    send:(channel,value)=>messages.push({channel,value}),spawnImpl:(_exe,_args,options)=>{
        assert.equal(options.windowsHide,true);assert.equal(options.shell,false);launches++;
        child=new EventEmitter();child.stdin=emitter();child.stdin.end=()=>{child.exitCode=0;child.emit('exit',0);};
        child.stdout=emitter();child.stderr=emitter();return child;
    }});
monitor.configure();monitor.configure();assert.equal(launches,1);
child.stdout.emit('data',Buffer.from('rea'));child.stdout.emit('data',Buffer.from('dy\ncommuni'));
child.stdout.emit('data',Buffer.from('cation\n'));
assert.equal(monitor.status().native,'ready');
assert.equal(messages.filter(item=>item.value.reason==='communication').length,1);
powerMonitor.emit('suspend');assert.equal(messages.at(-1).value.reason,'sleep');
settings.pauseOnSleep=false;const count=messages.length;powerMonitor.emit('suspend');assert.equal(messages.length,count);
settings.pauseOnInterruption=false;monitor.configure();assert.equal(monitor.status().native,'disabled');
child.stdout.emit('data',Buffer.from('communication\n'));assert.equal(messages.length,count);
settings.pauseOnInterruption=true;monitor.configure();assert.equal(launches,2);
monitor.stop();assert.equal(powerMonitor.listenerCount('suspend'),0);

// A late canplay event must not defeat an interruption while a track is buffering.
const engineScope={window:{},console,URL,clearTimeout};vm.createContext(engineScope);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/renderer/js/audio/engine.js'),'utf8'),engineScope);
const engine=engineScope.window.RhythmAudio.engine;
engine._ensureGraph=()=>{};engine._applyPreservePitch=()=>{};engine._releaseIdleDeck=()=>{};
let starts=0,deckPauses=0;const handlers={};
const element={load(){},pause(){deckPauses++;},addEventListener:(name,handler)=>{handlers[name]=handler;}};
engine.decks=[{element},{element:{pause(){deckPauses++;}}}];engine.element=element;
engine.play=()=>{starts++;};
element.duration=600;
engine.load('/audio/song.wav',{autoplay:true,seek:30});engine.interrupt();handlers.loadedmetadata();
assert.equal(starts,0);assert.equal(deckPauses,2);assert.equal(engine.state,'paused');
engine.load('/audio/next.wav',{autoplay:true});assert.equal(starts,1,'a deliberate new track can play immediately');
console.log('PASS: audio focus, optional session events, sleep, Windows call notifications, settings, cleanup and buffering interruptions');
