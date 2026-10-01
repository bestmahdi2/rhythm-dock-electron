'use strict';
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const mm = require('music-metadata');
const database = require('./database');
const PEAKS = 512, SAMPLE_RATE = 2000, MAX_SECONDS = 43200;
// Stream low-rate PCM into fixed-size buckets; never decode a whole file into RAM.
function collect(filePath, duration, {executable = 'ffmpeg', spawnImpl = spawn, signal} = {}) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('Cancelled.'));
        const child = spawnImpl(executable, ['-v','error','-nostdin','-i',filePath,'-map','0:a:0',
            '-ac','1','-ar',String(SAMPLE_RATE),'-t',String(MAX_SECONDS),'-f','f32le','pipe:1'],
            {shell:false, windowsHide:true, stdio:['ignore','pipe','pipe']});
        const peaks = new Array(PEAKS).fill(0); let leftover = Buffer.alloc(0), count = 0, failure;
        const stop = message => { failure = new Error(message); child.kill(); };
        const abort = () => stop('Cancelled.'); signal?.addEventListener('abort',abort,{once:true});
        const timer = setTimeout(() => stop('Waveform analysis timed out.'), 120000);
        const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort',abort); };
        child.stdout.on('data', chunk => {
            const data = Buffer.concat([leftover, chunk]); const length = data.length - data.length % 4;
            for (let i=0;i<length;i+=4) {
                const sample = data.readFloatLE(i), bucket = Math.min(PEAKS-1, Math.floor(count++ / (duration*SAMPLE_RATE) * PEAKS));
                if (Number.isFinite(sample)) peaks[bucket] = Math.max(peaks[bucket], Math.min(1,Math.abs(sample)));
            }
            leftover = data.subarray(length);
        });
        child.stderr.on('data', () => {});
        child.once('error', error => { clean(); reject(new Error(error.code === 'ENOENT' ?
            'Choose FFmpeg in Settings → Audio tools to generate waveforms.' : error.message)); });
        child.once('close', code => { clean(); if (failure || code !== 0 || !count)
            reject(failure || new Error('This file could not be analysed.'));
            else resolve({peaks:peaks.map(p => Math.round(p*1000)/1000), duration}); });
    });
}
async function waveform(filePath, options) {
    const stat = fs.statSync(filePath), db = database.handle();
    const cached = db.prepare('SELECT * FROM waveform_cache WHERE filePath=?').get(filePath);
    if (cached && cached.fileSize===stat.size && cached.fileMtimeMs===stat.mtimeMs)
        return {peaks:JSON.parse(cached.peaks),duration:cached.duration,cached:true};
    const metadata = await mm.parseFile(filePath,{duration:true,skipCovers:true});
    const duration = metadata.format.duration;
    if (!Number.isFinite(duration) || duration<=0 || duration>MAX_SECONDS) throw new Error('Waveforms support files up to 12 hours.');
    const result = await collect(filePath,duration,options);
    const after = fs.statSync(filePath);
    if (after.size!==stat.size || after.mtimeMs!==stat.mtimeMs) throw new Error('The file changed during analysis. Try again.');
    db.prepare(`INSERT INTO waveform_cache VALUES(?,?,?,?,?) ON CONFLICT(filePath) DO UPDATE SET
        fileSize=excluded.fileSize,fileMtimeMs=excluded.fileMtimeMs,peaks=excluded.peaks,duration=excluded.duration`)
        .run(filePath,stat.size,stat.mtimeMs,JSON.stringify(result.peaks),duration);
    return result;
}
module.exports = {collect,waveform,PEAKS};
