(function(root){
'use strict';
function color(bytes){
    const bins=new Map();
    for(let i=0;i<bytes.length;i+=4){const r=bytes[i],g=bytes[i+1],b=bytes[i+2];
        if(bytes[i+3]<128||Math.max(r,g,b)<30||Math.min(r,g,b)>235)continue;
        const key=[r>>5,g>>5,b>>5].join(':');if(!bins.has(key))bins.set(key,{count:0,r:0,g:0,b:0});
        const bin=bins.get(key);bin.count++;bin.r+=r;bin.g+=g;bin.b+=b;
    }
    const ranked=[...bins.values()].sort((a,b)=>b.count-a.count);if(!ranked.length)return null;
    const chosen=ranked[0],rgb=['r','g','b'].map(k=>chosen[k]/chosen.count),maximum=Math.max(...rgb,1);
    return '#'+rgb.map(v=>Math.round(v/maximum*190+50).toString(16).padStart(2,'0')).join('');
}
if(typeof module!=='undefined'&&module.exports)module.exports={color};else root.RhythmArtAccent={color};
})(typeof window!=='undefined'?window:globalThis);
