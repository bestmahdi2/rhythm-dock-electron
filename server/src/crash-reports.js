'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const FIELDS=new Set(['reason','code','count','role','state','version','attempt']);
function sanitize(events) {
    if(!Array.isArray(events)||events.length>100)throw new Error('Invalid report.');
    return events.map(row=>{
        if(!row||!/^[a-z][a-z0-9:-]{1,60}$/.test(row.event||'')||!Number.isFinite(Date.parse(row.at)))throw new Error('Invalid report event.');
        const safe={at:new Date(row.at).toISOString(),event:row.event};
        for(const [key,value] of Object.entries(row))if(FIELDS.has(key)) {
            if(typeof value==='number'&&Number.isFinite(value)||typeof value==='boolean')safe[key]=value;
            else if(typeof value==='string'&&/^[a-zA-Z0-9 ._:-]{0,80}$/.test(value)&&!/token|password|secret|bearer/i.test(value))safe[key]=value;
        }return safe;
    });
}
class CrashReports {
    constructor(root){this.root=root;this.clients=new Map();if(root){if(!path.isAbsolute(root))throw new Error('CRASH_REPORTS_DIR must be absolute.');fs.mkdirSync(root,{recursive:true});}}
    accept(events,ip){
        if(!this.root)throw new Error('Crash reporting is disabled.');
        const now=Date.now();for(const [key,c] of this.clients)if(now-c.at>60000)this.clients.delete(key);
        const client=this.clients.get(ip)||{at:now,count:0};if(client.count>=3||this.clients.size>=1000)throw new Error('Please try again later.');
        client.count++;this.clients.set(ip,client);
        const safe=sanitize(events);const data=JSON.stringify({format:'rhythm-dock-crash',version:1,events:safe});
        if(Buffer.byteLength(data)>65536)throw new Error('Report exceeds 64 KB.');
        const files=fs.readdirSync(this.root).filter(f=>/^[a-f0-9-]{36}\.json$/.test(f));
        for(const f of files)if(now-fs.statSync(path.join(this.root,f)).mtimeMs>30*86400000)fs.unlinkSync(path.join(this.root,f));
        if(fs.readdirSync(this.root).length>=1000)throw new Error('Report storage is full.');
        const id=crypto.randomUUID();fs.writeFileSync(path.join(this.root,id+'.json'),data,{flag:'wx',mode:0o600});return {id};
    }
}
module.exports={sanitize,CrashReports};
