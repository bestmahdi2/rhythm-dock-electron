"use strict";
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const mm=require('music-metadata');
const tools=require('../src/main/services/media-tools');
(async()=>{
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'rhythm-format-audio-'));
 const executable=process.env.FFMPEG_TEST_BINARY||'ffmpeg';
 try{
  const cases=[['aif','pcm_s16be'],['aiff','pcm_s24be'],['wma','wmav2'],['webm','libopus'],
   ['mka','flac'],['wv','wavpack'],['tta','tta'],['m4a','alac'],['m4b','alac'],['mp4','alac'],['m4a','aac']];
  for(const [extension,codec]of cases){
   const file=path.join(scratch,codec+'.'+extension);
   await tools.run(executable,['-hide_banner','-nostdin','-f','lavfi','-i','sine=frequency=440:duration=0.4','-ar','48000','-c:a',codec,file]);
   const originalMetadata=await require('../src/main/services/media-metadata').parseFile(file,{},executable);
   assert.ok(originalMetadata.format.duration>.3,extension+' original metadata');
   const result=await tools.prepare(file,path.join(scratch,'cache'),{executable});
   const metadata=await mm.parseFile(result.filePath);
   assert.ok(metadata.format.duration>.3&&metadata.format.duration<.6,extension+' duration');
   if(codec==='alac')assert.equal(result.decoded,true,'ALAC must be converted for Chromium');
   if(codec==='aac')assert.equal(result.decoded,undefined,'AAC stays on the streaming path');
   if(result.decoded)assert.equal(metadata.format.codec,'FLAC');
   const seek=path.join(scratch,'seek-'+extension+'-'+codec+'.wav');
   await tools.convert(result.filePath,seek,{start:.1,end:.3,executable});
   const seekMetadata=await mm.parseFile(seek);
   assert.ok(Math.abs(seekMetadata.format.duration-.2)<.03,extension+' seek');
  }
  console.log('PASS: actual AIFF, WMA, WebM, Matroska, WavPack, TTA, ALAC and AAC decoding, duration and seek');
 }finally{fs.rmSync(scratch,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
