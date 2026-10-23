"use strict";
// One format registry for scanning, imports, playback preparation and associations.
(function (root) {
    const direct = ['.mp3','.aac','.m4a','.m4b','.mp4','.flac','.wav','.ogg','.opus','.webm'];
    const decoded = ['.wma','.aif','.aiff','.ape','.wv','.mpc','.tta','.tak','.mka','.dsf','.dff','.mod','.xm','.it','.s3m'];
    const midi = ['.mid','.midi'];
    const containers = ['.m4a','.m4b','.mp4'];
    const audio = [...direct,...decoded,...midi];
    const playlists = ['.m3u','.m3u8','.pls','.xspf'];
    const indexes = ['.cue'];
    const extension = file => /\.[^./\\]+$/.exec(String(file || ''))?.[0].toLowerCase() || '';
    const formats = {direct,decoded,midi,containers,audio,playlists,indexes,
        openable:[...audio,...playlists,...indexes],
        isAudio:file=>audio.includes(extension(file)),
        needsPreparation:file=>[...decoded,...midi,...containers].includes(extension(file))};
    if (typeof module !== 'undefined' && module.exports) module.exports = formats;
    else root.RhythmFormats = formats;
})(typeof window === 'undefined' ? globalThis : window);
