'use strict';
const net=require('node:net'),path=require('node:path'),crypto=require('node:crypto');
const LIMIT=65536;
function config(value={}) {
    const clientId=String(value.clientId||'').trim();
    if(clientId&&!/^\d{17,20}$/.test(clientId))throw new Error('Enter a valid Discord application ID.');
    if(value.enabled&&!clientId)throw new Error('Enter the Discord application ID before enabling presence.');
    return {enabled:Boolean(value.enabled),clientId};
}
function ipcPaths() {
    if(process.platform==='win32')return Array.from({length:10},(_,i)=>`\\\\?\\pipe\\discord-ipc-${i}`);
    const root=process.env.XDG_RUNTIME_DIR||process.env.TMPDIR||process.env.TMP||process.env.TEMP||'/tmp';
    return Array.from({length:10},(_,i)=>path.join(root,`discord-ipc-${i}`));
}
function frame(opcode,data) {
    const body=Buffer.from(JSON.stringify(data)),header=Buffer.alloc(8);
    if(body.length>LIMIT)throw new Error('Presence message is too large.');
    header.writeUInt32LE(opcode);header.writeUInt32LE(body.length,4);return Buffer.concat([header,body]);
}
function activity(state) {
    if(!state?.isPlaying||!state.title)return null;
    const text=v=>Array.from(String(v)).slice(0,128).join('');
    return {type:2,details:text(state.title),state:text(state.artist||'Rhythm Dock')};
}
class DiscordPresence {
    constructor({getConfig,paths=ipcPaths,intervalMs=15000,retryMs=30000}) {
        this.getConfig=getConfig;this.paths=paths;this.intervalMs=intervalMs;this.retryMs=retryMs;
        this.socket=null;this.ready=false;this.buffer=Buffer.alloc(0);this.connecting=false;this.pending=null;
        this.lastSent=null;this.lastAt=0;this.nextAttempt=0;this.timer=null;this.generation=0;this.lastState={};this.error='';
    }
    status(){return {connected:this.ready,error:this.error};}
    configure(){this.close();this.nextAttempt=0;this.update(this.lastState);}
    update(state) {
        this.lastState=state||{};
        const current=config(this.getConfig());
        if(!current.enabled){if(this.socket||this.connecting)this.close();return;}
        this.pending=activity(state);
        if(!this.socket&&!this.connecting&&this.pending&&Date.now()>=this.nextAttempt)
            this.connect(current.clientId).catch(()=>{});
        if(this.ready)this.flush();
    }
    async connect(clientId) {
        this.connecting=true;this.error='';const generation=this.generation;
        try {
            for(const file of this.paths()) {
                if(generation!==this.generation)return;
                const socket=await new Promise(resolve=>{
                    const candidate=net.createConnection(file);const timeout=setTimeout(()=>{candidate.destroy();resolve(null);},500);
                    candidate.once('error',()=>{clearTimeout(timeout);candidate.destroy();resolve(null);});
                    candidate.once('connect',()=>{clearTimeout(timeout);resolve(candidate);});
                });
                if(!socket)continue;
                if(generation!==this.generation){socket.destroy();return;}
                this.socket=socket;this.buffer=Buffer.alloc(0);this.ready=false;
                socket.on('error',()=>{this.error='Discord disconnected. Open its desktop app and try again.';});
                socket.on('close',()=>{if(this.socket===socket){this.socket=null;this.ready=false;this.nextAttempt=Date.now()+this.retryMs;}});
                socket.on('data',bytes=>this.receive(bytes,socket));
                const handshake=setTimeout(()=>{if(!this.ready)socket.destroy();},3000);handshake.unref();
                socket.once('close',()=>clearTimeout(handshake));
                socket.write(frame(0,{v:1,client_id:clientId}));return;
            }
            this.error='Discord desktop was not found. Open it and try again.';this.nextAttempt=Date.now()+this.retryMs;
        }finally{if(generation===this.generation)this.connecting=false;}
    }
    receive(bytes,socket) {
        if(this.socket!==socket)return;
        this.buffer=Buffer.concat([this.buffer,bytes]);
        if(this.buffer.length>2*LIMIT){socket.destroy();return;}
        while(this.buffer.length>=8) {
            const opcode=this.buffer.readUInt32LE(0),length=this.buffer.readUInt32LE(4);
            if(length>LIMIT){socket.destroy();return;}
            if(this.buffer.length<8+length)return;
            const payload=this.buffer.subarray(8,8+length);this.buffer=this.buffer.subarray(8+length);
            if(opcode===3){const header=Buffer.alloc(8);header.writeUInt32LE(4);header.writeUInt32LE(length,4);socket.write(Buffer.concat([header,payload]));continue;}
            if(opcode===2){socket.destroy();return;}
            if(opcode!==1){socket.destroy();return;}
            let message;try{message=JSON.parse(payload.toString('utf8'));}catch(_){socket.destroy();return;}
            if(message.evt==='READY'){this.ready=true;this.lastSent=null;this.lastAt=0;this.flush();}
            else if(message.evt==='ERROR'){this.error='Discord rejected presence. Check the application ID and Discord settings.';socket.destroy();return;}
        }
    }
    flush() {
        if(!this.ready||!this.socket)return;
        const serialized=JSON.stringify(this.pending);if(serialized===this.lastSent)return;
        const delay=Math.max(0,this.lastAt+this.intervalMs-Date.now());
        if(delay){if(!this.timer){this.timer=setTimeout(()=>{this.timer=null;this.flush();},delay);this.timer.unref();}return;}
        this.lastSent=serialized;this.lastAt=Date.now();
        this.socket.write(frame(1,{cmd:'SET_ACTIVITY',args:{pid:process.pid,activity:this.pending},nonce:crypto.randomUUID()}));
    }
    close() {
        this.generation++;clearTimeout(this.timer);this.timer=null;this.connecting=false;
        const socket=this.socket;this.socket=null;this.ready=false;this.lastSent=null;
        if(socket){if(socket.writable)socket.end(frame(1,{cmd:'SET_ACTIVITY',args:{pid:process.pid,activity:null},nonce:crypto.randomUUID()}));
            const retire=setTimeout(()=>socket.destroy(),200);retire.unref();}
    }
}
module.exports={DiscordPresence,config,activity,frame,ipcPaths};
