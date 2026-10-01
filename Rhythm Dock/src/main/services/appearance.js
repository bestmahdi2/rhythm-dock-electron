'use strict';
function validate(value) {
    if(!value||!['none','spectrum','scope','vu','spectrogram'].includes(value.visualizer))throw new Error('Choose a visualizer.');
    const theme={};for(const [key,color] of Object.entries(value.theme||{})){
        if(!['accent','bg','text','surface','text-muted'].includes(key)||!/^#[a-f0-9]{6}$/i.test(color))throw new Error('Theme colors must be six-digit hex values.');
        theme[key]=color;
    }
    const css=String(value.css||'');if(css.length>10000||/@|url\s*\(|expression\s*\(|<|>/i.test(css))throw new Error('Custom CSS supports local styling only; imports and URLs are disabled.');
    return {visualizer:value.visualizer,artAccent:Boolean(value.artAccent),waveform:Boolean(value.waveform),theme,css};
}
module.exports={validate};
