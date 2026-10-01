'use strict';
// Copy preferences, never device IDs, local paths, authentication, or the play queue.
const SCHEMA = {
    theme:'string', colorTheme:'string', lastVolume:'number', playbackRate:'number', timeDisplayMode:'string',
    minimizeToTray:'boolean', windowOpacity:'number', isMagnifierEnabled:'boolean',
    trackNotifications:'boolean',pauseOnUnplug:'boolean',replayGainMode:'string',
    areLyricsVisible:'boolean', areLyricsControlsVisible:'boolean', magnifierEnabled:'boolean',equalizer:'object',
    crossfadeMs:'number', gapless:'boolean', preservePitch:'boolean', limiterEnabled:'boolean',
    skipSilence:'boolean', monoMix:'boolean', swapChannels:'boolean', balance:'number',
    roadmapAppearance:'object', parametricEQ:'object', tagPresets:'object', interfaceLanguage:'string',
    lyrics:'object',translation:'object',
};
function safe(value, depth=0) {
    if (depth>8) throw new Error('Settings contain too many nested values.');
    if (value===null || ['boolean','number','string'].includes(typeof value)) {
        if (typeof value==='number' && !Number.isFinite(value)) throw new Error('Settings contain an invalid number.');
        if (typeof value==='string' && value.length>10000) throw new Error('A setting is too long.');
        return value;
    }
    if (Array.isArray(value)) { if(value.length>100) throw new Error('Too many settings.'); return value.map(v => safe(v,depth+1)); }
    if (!value || typeof value!=='object') throw new Error('Invalid settings.');
    const output={};
    for (const [key,v] of Object.entries(value)) {
        if (['__proto__','prototype','constructor'].includes(key) || /token|secret|password|endpoint|path|url|key/i.test(key)) continue;
        output[key]=safe(v,depth+1);
    }
    return output;
}
function validate(values) {
    if (!values || typeof values!=='object' || Array.isArray(values)) throw new Error('Choose a valid settings file.');
    const result={};
    for (const [key,type] of Object.entries(SCHEMA)) {
        if (!(key in values)) continue;
        if (typeof values[key]!==type || values[key]===null) throw new Error(`Invalid setting: ${key}`);
        result[key]=safe(values[key]);
    }
    if ('windowOpacity' in result && (result.windowOpacity<0.2 || result.windowOpacity>1)) throw new Error('Window opacity must be between 0.2 and 1.');
    if ('playbackRate' in result && (result.playbackRate<0.5 || result.playbackRate>2)) throw new Error('Speed must be between 0.5 and 2.');
    if(result.roadmapAppearance)result.roadmapAppearance=require('./appearance').validate(result.roadmapAppearance);
    if(result.parametricEQ)result.parametricEQ=require('../../renderer/js/audio/parametric').validate(result.parametricEQ);
    return result;
}
function exportSettings(values) { return {format:'rhythm-dock-settings',version:1,settings:validate(values)}; }
function importSettings(data) {
    if (data?.format!=='rhythm-dock-settings' || data.version!==1) throw new Error('That is not a supported Rhythm Dock settings file.');
    return validate(data.settings);
}
module.exports={exportSettings,importSettings,validate};
