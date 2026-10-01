'use strict';
function create({electron,getStore,getWindow,send}) {
    let notification=null,lastTrack=null;
    function update(state){
        const identity=state.trackId||`${state.artist||''}:${state.title||''}`;
        if(!state.isPlaying||!state.title||identity===lastTrack)return;
        lastTrack=identity;
        if(!getStore()?.get('trackNotifications',false)||!electron.Notification.isSupported())return;
        notification?.close();
        const options={title:String(state.title).slice(0,200),body:String(state.artist||'Rhythm Dock').slice(0,200),silent:true};
        if(typeof state.cover==='string'&&state.cover.startsWith('data:image/')&&state.cover.length<500000)
            options.icon=electron.nativeImage.createFromDataURL(state.cover);
        if(process.platform==='darwin')options.actions=[{type:'button',text:'Play / Pause'},{type:'button',text:'Next'}];
        notification=new electron.Notification(options);
        notification.on('click',()=>{const w=getWindow();if(w){if(w.isMinimized())w.restore();w.show();w.focus();}});
        notification.on('action',(_event,index)=>send('media-key-event',index===0?'play-pause':'next'));
        notification.show();
    }
    function touchBar(window){
        if(process.platform!=='darwin'||!electron.TouchBar)return;
        const {TouchBar}=electron,{TouchBarButton}=TouchBar;
        window.setTouchBar(new TouchBar({items:[new TouchBarButton({label:'Previous',click:()=>send('media-key-event','prev')}),
            new TouchBarButton({label:'Play / Pause',click:()=>send('media-key-event','play-pause')}),
            new TouchBarButton({label:'Next',click:()=>send('media-key-event','next')})]}));
    }
    return {update,touchBar};
}
module.exports={create};
