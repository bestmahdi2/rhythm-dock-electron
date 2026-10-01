'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
const {RoomClient,trackIdFor}=require('../src/main/services/room-client');
async function wait(test){const end=Date.now()+10000;while(!test()){if(Date.now()>end)throw new Error('Room restart test timed out.');await new Promise(r=>setTimeout(r,25));}}
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
(async()=>{
    const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'rd-server-restart-')),stateFile=path.join(scratch,'rooms.json'),port=await freePort();
    let processServer=null;const clients=[];
    const boot=async()=>{
        let output='';processServer=spawn(process.execPath,[path.resolve(__dirname,'../../server/src/index.js')],{windowsHide:true,shell:false,
            env:{...process.env,PORT:String(port),HOST:'127.0.0.1',CREATE_SECRET:'fixture-secret',TELEGRAM_BOT_TOKEN:'',ROOM_STATE_FILE:stateFile,CRASH_REPORTS_DIR:''},stdio:['ignore','pipe','pipe']});
        processServer.stdout.on('data',b=>output+=b);processServer.stderr.on('data',()=>{});
        await wait(()=>output.includes('room server listening')||processServer.exitCode!==null);
        if(processServer.exitCode!==null)throw new Error('Fixture server failed to start.');
    };
    const stop=async()=>{const p=processServer;if(!p)return;processServer=null;if(p.exitCode===null){p.kill();await new Promise(r=>p.once('exit',r));}};
    const client=()=>{const events=[],instance=new RoomClient({emit:(name,value)=>events.push({name,value})});clients.push(instance);return {events,instance};};
    try{
        await boot();const base=`http://127.0.0.1:${port}`,host=client(),guest=client();
        const one=path.join(scratch,'one.mp3'),two=path.join(scratch,'two.mp3');fs.writeFileSync(one,'playable relay fixture');fs.writeFileSync(two,'second fixture');
        const room=await host.instance.createRoom(base,{secret:'fixture-secret',password:'fixture-password',name:'Host'});
        await guest.instance.joinRoom(base,room.code,{password:'fixture-password',name:'Friend'});
        host.instance.publishLibrary([one,two],{[one]:{title:'One'},[two]:{title:'Two'}});
        await wait(()=>{try{return JSON.parse(fs.readFileSync(stateFile,'utf8')).rooms[0].library.queue.length===2;}catch(_){return false;}});
        const disk=fs.readFileSync(stateFile,'utf8');assert.ok(!disk.includes(room.hostToken));assert.ok(!disk.includes(scratch));
        await stop();await boot();
        await wait(()=>host.events.filter(e=>e.name==='room:welcome').length>=2&&guest.events.filter(e=>e.name==='room:welcome').length>=2);
        assert.equal(host.instance.isHost,true);assert.equal(guest.instance.role,'controller');
        const restored=guest.events.filter(e=>e.name==='room:welcome').at(-1).value;
        assert.equal(restored.library.queue.length,2);assert.equal(restored.state.playing,false);
        const relay=await fetch(`${base}/api/rooms/${room.code}/stream/${trackIdFor(one)}?password=fixture-password`,{headers:{Range:'bytes=0-7'},signal:AbortSignal.timeout(5000)});
        assert.equal(relay.status,206);assert.equal(await relay.text(),'playable');
        host.instance.leave();
        await new Promise(r=>setTimeout(r,100));
        const freshHost=client();await freshHost.instance.resumeRoom({serverUrl:base,code:room.code,hostToken:room.hostToken,password:'fixture-password'});
        freshHost.instance.publishLibrary([one,two],{[one]:{title:'One'},[two]:{title:'Two'}});
        assert.equal(freshHost.instance.isHost,true,'a fresh desktop client must reclaim the saved host identity');
        await assert.rejects(client().instance.resumeRoom({serverUrl:base,code:room.code,hostToken:'invalid'}),/invalid/);
        console.log('PASS: actual server process restart preserves room/queue, reconnects both desktop clients, authenticates the host and relays original bytes');
    }finally{for(const c of clients)c.leave();await stop();fs.rmSync(scratch,{recursive:true,force:true});}
})().then(()=>process.exit(0)).catch(error=>{console.error(error);process.exit(1);});
