'use strict';
const path=require('node:path');
const fs=require('node:fs');
function parseArgs(argv,cwd=process.cwd(),supported=()=>true,expand=file=>[file]) {
    const files=[],options={play:false,enqueue:false,hidden:false};
    for(const value of argv.slice(1)) {
        if(value==='--play') options.play=true;
        else if(value==='--enqueue') options.enqueue=true;
        else if(value==='--hidden') options.hidden=true;
        else if(!value.startsWith('-') && value!=='.') {
            const file=path.resolve(cwd,value);
            try {if(fs.statSync(file).isFile() && supported(file) && !files.includes(file)) files.push(...expand(file).filter(item=>!files.includes(item)));} catch(_) {}
        }
    }
    return {...options,files};
}
function dataRoot({packaged,exePath,portableDir,appData,exists=fs.existsSync}) {
    const dir=portableDir && path.isAbsolute(portableDir) ? portableDir : path.dirname(exePath);
    const portable=Boolean(packaged && exists(path.join(dir,'rhythm-dock.portable')));
    return {root:portable?path.join(dir,'RhythmDockData'):path.join(appData,'RhythmDock'),portable};
}
module.exports={parseArgs,dataRoot};
