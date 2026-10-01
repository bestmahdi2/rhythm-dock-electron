'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tags = require('../library/tags');
const FIELDS = ['artist','albumArtist','title','album','genre','comment','year','track','trackCount','disc'];
function component(value) {
    const clean=String(value || 'Unknown').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,120);
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? '_'+clean : clean || 'Unknown';
}
function filename(template, values) {
    if (typeof template!=='string' || !template || template.length>300 || /(^|[\\/])\.\.?([\\/]|$)/.test(template) || path.isAbsolute(template))
        throw new Error('Use a relative pattern such as %artist%/%album%/%track% %title%.');
    const parts=template.split(/[\\/]/);
    if(parts.some(p => !p)) throw new Error('The pattern has an empty folder name.');
    return parts.map(p => component(p.replace(/%([a-zA-Z]+)%/g,(_, key) => {
        if (!FIELDS.includes(key)) throw new Error('Unknown pattern field: '+key);
        return key==='track' ? String(Number(values.track)||0).padStart(2,'0') : component(values[key]);
    }))).join(path.sep);
}
function tagsFromFilename(template, filePath) {
    const fields=[]; const pattern=String(template).split(/(%[a-zA-Z]+%)/).map(part => {
        const match=/^%([a-zA-Z]+)%$/.exec(part);
        if(!match) return part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        if(!FIELDS.includes(match[1])) throw new Error('Unknown pattern field: '+match[1]);
        fields.push(match[1]); return '(.+?)';
    }).join('');
    const match=new RegExp('^'+pattern+'$','u').exec(path.basename(filePath,path.extname(filePath)));
    if(!match) throw new Error('The filename does not match this pattern.');
    return Object.fromEntries(fields.map((f,i) => [f,match[i+1]]));
}
async function hash(file) {
    const h=crypto.createHash('sha256'); for await(const chunk of fs.createReadStream(file)) h.update(chunk); return h.digest('hex');
}
class FileTools {
    constructor(root,{read=tags.read,write=tags.write,onChange=()=>{},validateTarget=()=>{}}={}) {
        this.root=root; this.read=read; this.write=write; this.onChange=onChange; this.validateTarget=validateTarget; this.busy=false;
        fs.mkdirSync(root,{recursive:true});
    }
    save(journal) {
        const file=path.join(this.root,journal.id+'.json'),tmp=file+'.tmp';
        fs.writeFileSync(tmp,JSON.stringify(journal)); fs.renameSync(tmp,file);
    }
    async preview({files,mode='tags',values={},template='%artist% - %title%',destination,cover}) {
        if (!Array.isArray(files) || files.length<1 || files.length>50 || new Set(files).size!==files.length)
            throw new Error('Select between 1 and 50 different songs.');
        if(!['tags','fromFilename','organise'].includes(mode)) throw new Error('Choose a file operation.');
        if(cover && (!['image/png','image/jpeg'].includes(cover.mimeType) || typeof cover.data!=='string' ||
            cover.data.length>7*1024*1024))throw new Error('Choose a PNG or JPEG cover up to 5 MB.');
        if(mode==='organise' && (!path.isAbsolute(destination || '') || !fs.statSync(destination).isDirectory()))
            throw new Error('Choose the destination folder.');
        const journal={id:crypto.randomUUID(),mode,createdAt:new Date().toISOString(),rows:[],state:'preview'};
        let total=0; const destinations=new Set();
        for(const filePath of files) {
            if(!path.isAbsolute(filePath) || !fs.statSync(filePath).isFile()) throw new Error('A selected file no longer exists.');
            total+=fs.statSync(filePath).size;
            if(total>512*1024*1024) throw new Error('Select a smaller batch (at most 512 MB).');
            const original=this.read(filePath); if(!original.ok) throw new Error(original.error);
            const row={filePath,before:await hash(filePath),state:'pending'};
            if(mode==='organise') {
                const relative=filename(template,original.tags || original);
                row.target=path.join(destination,relative+path.extname(filePath));
                const key=row.target.toLowerCase();
                if(destinations.has(key) || fs.existsSync(row.target)) throw new Error('Two songs would have the same name, or a destination already exists. Change the pattern.');
                this.validateTarget(row.target);
                destinations.add(key);
            } else {
                row.values=mode==='fromFilename' ? tagsFromFilename(template,filePath) :
                    Object.fromEntries(Object.entries(values).filter(([key]) => FIELDS.includes(key)));
                if(cover)row.cover=cover;
                if(!Object.keys(row.values).length && !cover) throw new Error('Choose at least one tag to change.');
            }
            journal.rows.push(row);
        }
        this.save(journal); return journal;
    }
    load(id) {
        if(!/^[a-f0-9-]{36}$/.test(String(id))) throw new Error('Invalid preview.');
        return JSON.parse(fs.readFileSync(path.join(this.root,id+'.json'),'utf8'));
    }
    async apply(id) {
        if(this.busy) throw new Error('A file operation is already running.'); this.busy=true;
        try {
            const j=this.load(id); if(j.state!=='preview') throw new Error('Create a fresh preview first.');
            // Validate the complete batch before touching any file.
            for(const r of j.rows) {
                if(await hash(r.filePath)!==r.before || (r.target && fs.existsSync(r.target))) throw new Error('A file changed after the preview. Create a new preview.');
                if(r.target)this.validateTarget(r.target);
            }
            j.state='applying'; this.save(j);
            for(const [i,r] of j.rows.entries()) {
                try {
                    if(j.mode==='organise') {
                        fs.mkdirSync(path.dirname(r.target),{recursive:true});
                        fs.copyFileSync(r.filePath,r.target,fs.constants.COPYFILE_EXCL);
                        if(await hash(r.target)!==r.before || await hash(r.filePath)!==r.before) throw new Error('A file changed during the move. Both copies were preserved.');
                        r.after=r.before; r.state='copied'; this.save(j);
                        fs.unlinkSync(r.filePath); r.state='done'; this.save(j);
                        this.onChange(r.filePath,r.target);
                    } else {
                        r.backup=path.join(this.root,j.id+'-'+i+path.extname(r.filePath));
                        fs.copyFileSync(r.filePath,r.backup,fs.constants.COPYFILE_EXCL); r.state='backed-up'; this.save(j);
                        const result=this.write(r.filePath,r.values,r.cover); if(!result.ok) throw new Error(result.error);
                        r.after=await hash(r.filePath); r.state='done'; this.save(j); this.onChange(r.filePath,r.filePath);
                    }
                } catch(error) {r.error=error.message; this.save(j); break;}
                await new Promise(resolve => setImmediate(resolve));
            }
            j.state=j.rows.every(r => r.state==='done')?'done':'partial'; this.save(j); return j;
        } finally {this.busy=false;}
    }
    async undo(id) {
        if(this.busy) throw new Error('A file operation is already running.'); this.busy=true;
        try {
            const j=this.load(id);
            for(const r of [...j.rows].reverse()) {
                // A copy interrupted before removal can be safely rolled back only
                // while both copies still match the previewed original.
                if(r.state==='copied') {
                    if(!fs.existsSync(r.filePath)) {
                        r.state='done';this.save(j);
                    } else {
                        if(await hash(r.filePath)!==r.before || !fs.existsSync(r.target) || await hash(r.target)!==r.before)
                            throw new Error('An interrupted move changed. Both copies were preserved for review.');
                        fs.unlinkSync(r.target);r.state='undone';this.save(j);continue;
                    }
                }
                if(r.state!=='done') continue;
                const current=r.target || r.filePath;
                if(!fs.existsSync(current) || await hash(current)!==r.after) throw new Error('A changed file cannot be safely undone. It has been preserved.');
                if(r.target) {
                    if(fs.existsSync(r.filePath)) throw new Error('The original filename is occupied. Undo stopped without overwriting it.');
                    fs.copyFileSync(r.target,r.filePath,fs.constants.COPYFILE_EXCL);
                    if(await hash(r.filePath)!==r.before) throw new Error('Could not verify the restored file. Both copies were preserved.');
                    fs.unlinkSync(r.target); this.onChange(r.target,r.filePath);
                } else {
                    if(await hash(r.backup)!==r.before) throw new Error('The backup changed. Undo stopped.');
                    const temp=r.filePath+'.undo-'+j.id;
                    fs.copyFileSync(r.backup,temp,fs.constants.COPYFILE_EXCL); fs.renameSync(temp,r.filePath); this.onChange(r.filePath,r.filePath);
                }
                r.state='undone'; this.save(j);
            }
            j.state='undone'; this.save(j); return j;
        } finally {this.busy=false;}
    }
    journals() { return fs.readdirSync(this.root).filter(n => n.endsWith('.json')).map(n => {
        try {const j=JSON.parse(fs.readFileSync(path.join(this.root,n),'utf8')); return {id:j.id,state:j.state,mode:j.mode,createdAt:j.createdAt,count:j.rows.length};}
        catch(_) {return null;}
    }).filter(Boolean).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).slice(0,50); }
}
module.exports={FileTools,filename,tagsFromFilename,component,hash};
