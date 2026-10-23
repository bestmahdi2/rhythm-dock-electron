"use strict";
const metadata = require('music-metadata');
const {run} = require('./media-tools');

async function parseFile(filePath, options = {}, ffmpeg = 'ffmpeg') {
    try { return await metadata.parseFile(filePath,options); }
    catch (original) {
        // FFprobe fills reader gaps without decoding the whole file or modifying it.
        const probe = /ffmpeg(?:\.exe)?$/i.test(ffmpeg) ? ffmpeg.replace(/ffmpeg(\.exe)?$/i,'ffprobe$1') : 'ffprobe';
        try {
            const {stdout} = await run(probe,['-v','error','-show_format','-show_streams','-of','json','-i',filePath],{timeoutMs:10000});
            const data=JSON.parse(stdout), audio=data.streams?.find(stream=>stream.codec_type==='audio');
            if (!audio) throw original;
            const tags={};
            for(const [key,value]of Object.entries({...audio.tags,...data.format?.tags}))tags[key.toLowerCase()]=String(value);
            const number=value=>Number.isFinite(Number(value))?Number(value):undefined;
            return {
                common:{title:tags.title,artist:tags.artist,album:tags.album,
                    albumartist:tags.album_artist,genre:tags.genre?[tags.genre]:[],lyrics:tags.lyrics?[tags.lyrics]:[]},
                format:{container:data.format?.format_name,codec:audio.codec_name,
                    duration:number(audio.duration??data.format?.duration),
                    sampleRate:number(audio.sample_rate),numberOfChannels:number(audio.channels),
                    bitrate:number(audio.bit_rate??data.format?.bit_rate)},
                native:{ffprobe:Object.entries(tags).map(([id,value])=>({id,value}))}
            };
        } catch (_) { throw original; }
    }
}
module.exports = {parseFile};
