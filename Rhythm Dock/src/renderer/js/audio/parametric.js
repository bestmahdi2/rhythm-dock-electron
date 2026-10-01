(function(root){
'use strict';
function validate(state) {
    if(!state || !Array.isArray(state.bands) || state.bands.length>16) throw new Error('Use at most 16 equalizer bands.');
    const preamp=Number(state.preamp || 0);
    if(!Number.isFinite(preamp)||preamp>0||preamp< -36) throw new Error('Preamp must be between −36 and 0 dB.');
    const bands=state.bands.map(b=>{
        const frequency=Number(b.frequency),gain=Number(b.gain),q=Number(b.q);
        if(!['peaking','lowshelf','highshelf'].includes(b.type)||!Number.isFinite(frequency)||frequency<10||frequency>22000||
            !Number.isFinite(gain)||Math.abs(gain)>24||!Number.isFinite(q)||q<0.1||q>20)throw new Error('A band has invalid frequency, gain or Q.');
        return {type:b.type,frequency,gain,q};
    });return {preamp,bands,enabled:Boolean(state.enabled)};
}
function autoEQ(text) {
    const bands=[];let preamp=0;
    for(const line of String(text).split(/\r?\n/)) {
        const p=/^Preamp:\s*([+-]?[\d.]+)\s*dB/i.exec(line.trim());if(p){preamp=Number(p[1]);continue;}
        const b=/^Filter\s+\d+:\s+ON\s+(PK|LSC?|HSC?)\s+Fc\s+([\d.]+)\s+Hz\s+Gain\s+([+-]?[\d.]+)\s+dB\s+Q\s+([\d.]+)/i.exec(line.trim());
        if(b)bands.push({type:b[1]==='PK'?'peaking':b[1].startsWith('LS')?'lowshelf':'highshelf',frequency:Number(b[2]),gain:Number(b[3]),q:Number(b[4])});
        else if(/^Filter\s+\d+:\s+ON/i.test(line.trim()))throw new Error('This AutoEQ profile uses an unsupported filter.');
    }
    if(!bands.length)throw new Error('Paste an AutoEQ parametric profile with enabled filters.');
    return validate({preamp,bands,enabled:true});
}
class Parametric {
    constructor(engine,graphic){this.engine=engine;this.graphic=graphic;this.nodes=[];this.state={enabled:false,preamp:0,bands:[]};}
    apply(value){
        const state=validate(value);
        this.graphic.setEnabled(false);
        this.engine.setInsertChain([]);this.nodes.forEach(n=>n.disconnect());this.nodes=[];
        this.state=state;
        if(!state.enabled)return;
        this.engine._ensureGraph();const ctx=this.engine.ctx;
        const pre=ctx.createGain();pre.gain.value=10**(state.preamp/20);this.nodes.push(pre);
        for(const b of state.bands){const n=ctx.createBiquadFilter();n.type=b.type;
            n.frequency.value=Math.min(b.frequency,ctx.sampleRate/2-1);n.gain.value=b.gain;n.Q.value=b.q;this.nodes.push(n);}
        this.engine.setInsertChain(this.nodes);
    }
    response(frequencies){
        const values=new Float32Array(frequencies.length).fill(10**(this.state.preamp/20));
        for(const n of this.nodes.slice(1)){const mag=new Float32Array(values.length),phase=new Float32Array(values.length);
            n.getFrequencyResponse(frequencies,mag,phase);for(let i=0;i<values.length;i++)values[i]*=mag[i];}
        return values;
    }
}
const api={validate,autoEQ,Parametric};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.RhythmParametric=api;
})(typeof window!=='undefined'?window:globalThis);
