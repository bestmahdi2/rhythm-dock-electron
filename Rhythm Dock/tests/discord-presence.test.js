'use strict';
const assert=require('node:assert/strict'),net=require('node:net'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DiscordPresence,config,frame,activity}=require('../src/main/services/discord-presence');
async function wait(test){const until=Date.now()+3000;while(!test()){if(Date.now()>until)throw new Error('Presence fixture timed out.');await new Promise(r=>setTimeout(r,5));}}
(async()=>{
    assert.throws(()=>config({enabled:true}));assert.throws(()=>config({clientId:'invalid'}));
    assert.equal(activity({isPlaying:false,title:'Song'}),null);
    const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'rd-presence-'));
    const pipe=process.platform==='win32'?`\\\\.\\pipe\\rhythm-discord-${crypto.randomUUID()}`:path.join(scratch,'discord.sock');
    const frames=[],connections=new Set();
    const server=net.createServer(socket=>{
        connections.add(socket);socket.on('close',()=>connections.delete(socket));socket.on('error',()=>{});let buffer=Buffer.alloc(0);
        socket.on('data',bytes=>{buffer=Buffer.concat([buffer,bytes]);while(buffer.length>=8){
            const opcode=buffer.readUInt32LE(),length=buffer.readUInt32LE(4);if(buffer.length<8+length)return;
            const body=buffer.subarray(8,8+length);buffer=buffer.subarray(8+length);frames.push({opcode,data:JSON.parse(body)});
            if(opcode===0){const ready=frame(1,{evt:'READY',data:{}});socket.write(ready.subarray(0,5));setTimeout(()=>{
                if(!socket.destroyed){socket.write(ready.subarray(5));socket.write(frame(3,{ping:'fixture'}));}},5);}
        }});
    });
    await new Promise(r=>server.listen(pipe,r));let enabled=false,attempts=0;
    const presence=new DiscordPresence({getConfig:()=>({enabled,clientId:'123456789012345678'}),paths:()=>{attempts++;return [pipe];},intervalMs:60,retryMs:10});
    try{
        presence.update({isPlaying:true,title:'Song',artist:'Artist',filePath:'never-sent',token:'never-sent'});
        assert.equal(attempts,0,'disabled presence must not connect to Discord');enabled=true;presence.configure();
        await wait(()=>frames.some(f=>f.data.cmd==='SET_ACTIVITY'&&f.data.args.activity?.details==='Song'));
        assert.equal(frames[0].opcode,0);assert.equal(frames[0].data.client_id,'123456789012345678');
        await wait(()=>frames.some(f=>f.opcode===4));assert.equal(presence.status().connected,true);
        const initial=frames.filter(f=>f.data.cmd==='SET_ACTIVITY').length;
        presence.update({isPlaying:true,title:'Song',artist:'Artist'});
        await new Promise(r=>setTimeout(r,10));assert.equal(frames.filter(f=>f.data.cmd==='SET_ACTIVITY').length,initial,'identical activity must be deduplicated');
        presence.update({isPlaying:true,title:'Older',artist:'Artist'});presence.update({isPlaying:true,title:'Latest',artist:'Artist'});
        await wait(()=>frames.some(f=>f.data.args?.activity?.details==='Latest'));
        assert.ok(!frames.some(f=>f.data.args?.activity?.details==='Older'),'throttled updates must retain only the latest song');
        assert.ok(!JSON.stringify(frames).includes('never-sent'),'presence must only publish allowed song tags');
        presence.update({isPlaying:false});await wait(()=>frames.some(f=>f.data.cmd==='SET_ACTIVITY'&&f.data.args.activity===null));
        enabled=false;presence.configure();assert.equal(presence.status().connected,false);
        console.log('PASS: optional Discord IPC handshake, fragmented frames, ping/pong, song privacy, deduplication, rate limit and pause/disable clearing');
    }finally{presence.close();for(const s of connections)s.destroy();await new Promise(r=>server.close(r));fs.rmSync(scratch,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
