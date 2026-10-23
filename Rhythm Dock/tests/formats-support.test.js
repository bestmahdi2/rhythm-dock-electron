"use strict";
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const formats=require('../src/shared/media-formats');
const playlists=require('../src/main/services/playlist-formats');
const {expandFiles}=require('../src/main/services/input-files');
const scanner=require('../src/main/library/scanner');
const launch=require('../src/main/core/launch-options');
const tools=require('../src/main/services/media-tools');
const {EventEmitter}=require('node:events');
(async()=>{
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'rhythm-formats-'));
 try{
  const tracks=formats.audio.map(ext=>path.join(scratch,'track'+ext.toUpperCase()));
  tracks.forEach(file=>fs.writeFileSync(file,'audio'));
  assert.equal(new Set(formats.audio).size,formats.audio.length);
  assert.deepEqual(require('../../server/src/audio-formats'),formats.audio);
  const scanned=await scanner.scanDirectory(scratch,formats.audio);
  assert.equal(scanned.files.length,tracks.length);
  for(const ext of formats.playlists){
   const file=path.join(scratch,'collection'+ext);
   fs.writeFileSync(file,playlists.serialize(tracks,ext,scratch));
   assert.deepEqual(expandFiles([file]),tracks);
   const parsed=launch.parseArgs(['electron',file],scratch,()=>true,input=>expandFiles([input]));
   assert.deepEqual(parsed.files,tracks);
  }
  const cue=path.join(scratch,'album.cue');
  fs.writeFileSync(cue,'FILE "track.FLAC" WAVE\n TRACK 01 AUDIO\n INDEX 01 00:00:00\n');
  assert.deepEqual(expandFiles([cue,tracks.find(file=>file.endsWith('.FLAC'))]),[path.join(scratch,'track.FLAC')]);
  const Module=require('node:module'),load=Module._load;let lyrics;
  try{Module._load=function(name,...args){return name==='electron'?{net:{}}:load.call(this,name,...args);};lyrics=require('../src/main/services/lyrics');}
  finally{Module._load=load;}
  const song=path.join(scratch,'track.FLAC');
  fs.writeFileSync(path.join(scratch,'track.txt'),'\ufeffPlain text lyrics');
  assert.equal(lyrics.readSidecar(song).text,'Plain text lyrics');
  fs.writeFileSync(path.join(scratch,'track.lrc'),'[00:01.00]Timed lyrics');
  assert.equal(lyrics.readSidecar(song).text,'[00:01.00]Timed lyrics');
  const font=path.join(scratch,'instruments.sf2');fs.writeFileSync(font,'SoundFont fixture');
  const midi=path.join(scratch,'track.MID');let calls=0,lastArgs;
  const spawnImpl=(executable,args)=>{
   calls++;lastArgs=args;const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>child.emit('close',1);
   setImmediate(()=>{fs.writeFileSync(args[args.indexOf('-F')+1],Buffer.alloc(256));child.emit('close',0);});return child;
  };
  await assert.rejects(tools.prepare(midi,path.join(scratch,'cache'),{}),/SoundFont/);
  const prepared=await tools.prepare(midi,path.join(scratch,'cache'),{soundfont:font,spawnImpl});
  assert.equal(prepared.decoded,true);assert.ok(prepared.filePath.endsWith('.wav'));
  assert.ok(lastArgs.includes(font));assert.ok(lastArgs.includes(midi));
  assert.equal(lastArgs[lastArgs.indexOf('-T')+1],'wav');
  await tools.prepare(midi,path.join(scratch,'cache'),{soundfont:font,spawnImpl});assert.equal(calls,1);
  fs.appendFileSync(font,'changed');
  await tools.prepare(midi,path.join(scratch,'cache'),{soundfont:font,spawnImpl});assert.equal(calls,2);
  console.log('PASS: unified format scanning, playlist/CLI expansion, CUE opening, TXT/LRC priority and MIDI rendering/cache');
 }finally{fs.rmSync(scratch,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
