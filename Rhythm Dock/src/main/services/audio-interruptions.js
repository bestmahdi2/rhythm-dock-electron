'use strict';
const path=require('node:path');
const {spawn}=require('node:child_process');

function create({powerMonitor,send,getStore,platform=process.platform,spawnImpl=spawn}){
    let child=null,status='disabled',buffer='',attached=false;
    const pause=reason=>send('audio-interruption',{reason});
    const onSuspend=()=>{if(getStore()?.get('pauseOnSleep',true))pause('sleep');};
    function stopNative(){
        if(!child)return;
        const current=child;child=null;
        current.stdin.end();
        const timer=setTimeout(()=>{if(current.exitCode===null)current.kill();},2500);timer.unref();
        current.once('exit',()=>clearTimeout(timer));
    }
    function configure(){
        if(!attached){powerMonitor.on('suspend',onSuspend);attached=true;}
        if(!getStore()?.get('pauseOnInterruption',true)){stopNative();status='disabled';return;}
        if(platform!=='win32'){status='platform-events';return;}
        if(child)return;
        status='starting';buffer='';
        const script=path.join(__dirname,'native','windows-audio-interruptions.ps1').replace(/app\.asar([\\/])/,'app.asar.unpacked$1');
        const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
        const current=spawnImpl(powershell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',script,'-ParentProcessId',String(process.pid)],
            {windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
        child=current;
        current.stdin.on('error',()=>{});
        current.stdout.on('data',bytes=>{
            if(child!==current)return;
            buffer=(buffer+bytes.toString()).slice(-4096);
            const lines=buffer.split(/\r?\n/);buffer=lines.pop();
            for(const line of lines){
                if(line==='ready'||line==='unavailable'){status=line;send('audio-interruption-status',{native:status,platform});}
                if(line==='communication'&&getStore()?.get('pauseOnInterruption',true))pause('communication');
            }
        });
        current.stderr.on('data',()=>{});
        const failed=()=>{if(child===current){child=null;status='unavailable';send('audio-interruption-status',{native:status,platform});}};
        current.once('error',failed);
        current.once('exit',failed);
    }
    function stop(){stopNative();if(attached)powerMonitor.removeListener('suspend',onSuspend);attached=false;status='disabled';}
    return {configure,stop,status:()=>({native:status,platform})};
}
module.exports={create};
