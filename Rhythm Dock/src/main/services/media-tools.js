'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');

const EXTRA_FORMATS = ['.ape', '.wv', '.dsf', '.dff', '.mod', '.xm', '.it', '.s3m'];
const ENCODERS = {'.wav': ['pcm_s24le', 'wav'], '.flac': ['flac', 'flac'],
    '.mp3': ['libmp3lame', 'mp3'], '.m4a': ['aac', 'ipod'], '.ogg': ['libvorbis', 'ogg']};
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;
const CACHE_BYTES = 2 * MAX_OUTPUT_BYTES;
const TTL_MS = 2 * 86400000;

function localFile(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || !fs.statSync(value).isFile())
        throw new Error('Choose an existing local audio file.');
    return value;
}

function loudnessResult(stderr, target = -18) {
    const blocks = String(stderr).match(/\{[^{}]*"input_i"[^{}]*\}/g);
    if (!blocks?.length) throw new Error('No loudness measurement was returned.');
    const row = JSON.parse(blocks.at(-1));
    const integrated = Number(row.input_i), peak = Number(row.input_tp);
    if (!Number.isFinite(integrated) || !Number.isFinite(peak))
        throw new Error('This file is silent or its loudness could not be measured.');
    return {integratedLufs: integrated, truePeakDb: peak,
        gainDb: Math.max(-24, Math.min(12, target - integrated, -1 - peak)), targetLufs: target};
}

function run(executable, args, {signal, onProgress = () => {}, outputPath, timeoutMs = 30 * 60000,
    spawnImpl = spawn} = {}) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('Operation cancelled.'));
        const child = spawnImpl(executable || 'ffmpeg', args, {windowsHide: true, shell: false,
            stdio: ['ignore', 'pipe', 'pipe']});
        let stdout = '', stderr = '', failure = null, progressBuffer = '';
        const stop = (message) => { failure = new Error(message); child.kill(); };
        const abort = () => stop('Operation cancelled.');
        signal?.addEventListener('abort', abort, {once: true});
        const timer = setTimeout(() => stop('Audio operation timed out.'), timeoutMs);
        const sizeTimer = outputPath && setInterval(() => {
            try { if (fs.statSync(outputPath).size > MAX_OUTPUT_BYTES) stop('Audio output exceeds the 1 GB limit.'); }
            catch (_) { /* not yet created */ }
        }, 200);
        const clean = () => { clearTimeout(timer); clearInterval(sizeTimer); signal?.removeEventListener('abort', abort); };
        child.stdout.on('data', (data) => {
            stdout = (stdout + data).slice(-65536);
            progressBuffer += data;
            const lines = progressBuffer.split(/\r?\n/); progressBuffer = lines.pop();
            for (const line of lines) {
                const match = /^out_time_us=(\d+)/.exec(line);
                if (match) onProgress(Number(match[1]) / 1000000);
            }
        });
        child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-65536); });
        child.once('error', (error) => {
            clean(); reject(new Error(error.code === 'ENOENT' ?
                'FFmpeg is not installed. Choose its executable in Settings → Audio tools.' : error.message));
        });
        child.once('close', (code) => {
            clean();
            if (failure) return reject(failure);
            if (code !== 0) return reject(new Error('FFmpeg could not process this file. Check its format and your FFmpeg build.'));
            resolve({stdout, stderr});
        });
    });
}

const BASE = ['-hide_banner', '-nostdin', '-v', 'info', '-progress', 'pipe:1'];

async function analyse(filePath, options = {}) {
    localFile(filePath);
    const {stderr} = await run(options.executable, [...BASE, '-i', filePath, '-map', '0:a:0',
        '-af', 'loudnorm=I=-18:TP=-1:LRA=11:print_format=json', '-f', 'null', '-'], options);
    return loudnessResult(stderr);
}

async function analyseAlbum(files, options = {}) {
    if (!Array.isArray(files) || files.length < 2 || files.length > 64)
        throw new Error('Album analysis needs between 2 and 64 local tracks.');
    const args = [...BASE];
    files.forEach((filePath) => args.push('-i', localFile(filePath)));
    const inputs = files.map((_, index) => `[${index}:a:0]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${index}]`);
    const filter = inputs.join(';') + ';' + files.map((_, index) => `[a${index}]`).join('') +
        `concat=n=${files.length}:v=0:a=1,loudnorm=I=-18:TP=-1:LRA=11:print_format=json[out]`;
    args.push('-filter_complex', filter, '-map', '[out]', '-f', 'null', '-');
    const result = await run(options.executable, args, options);
    return loudnessResult(result.stderr);
}

async function convert(filePath, targetPath, {start = 0, end = null, tags = {}, ...options} = {}) {
    localFile(filePath);
    const encoding = ENCODERS[path.extname(targetPath).toLowerCase()];
    if (!encoding || !path.isAbsolute(targetPath)) throw new Error('Choose WAV, FLAC, MP3, M4A, or OGG output.');
    if (fs.existsSync(targetPath)) throw new Error('Choose a new filename; the original and existing files are preserved.');
    if (!Number.isFinite(start) || start < 0 || (end !== null && (!Number.isFinite(end) || end <= start)))
        throw new Error('The end must be after the start of the selection.');
    const temporary = path.join(path.dirname(targetPath), `.rhythm-${crypto.randomUUID()}.part`);
    const args = [...BASE, '-i', filePath, '-ss', String(start)];
    if (end !== null) args.push('-t', String(end - start));
    args.push('-map', '0:a:0', '-vn', '-map_metadata', '0', '-map_chapters', '-1', '-c:a', encoding[0]);
    // DSD and uncommon sample rates are converted to a browser-friendly PCM rate.
    if (EXTRA_FORMATS.includes(path.extname(filePath).toLowerCase())) args.push('-ar', '48000');
    for (const key of ['title', 'artist', 'album']) {
        if (tags[key]) args.push('-metadata', `${key}=${String(tags[key]).slice(0, 300)}`);
    }
    args.push('-f', encoding[1], temporary);
    try {
        await run(options.executable, args, {...options, outputPath: temporary});
        const size = fs.statSync(temporary).size;
        if (!size || size > MAX_OUTPUT_BYTES) throw new Error('Invalid or oversized audio output.');
        fs.copyFileSync(temporary, targetPath, fs.constants.COPYFILE_EXCL);
        return {filePath: targetPath};
    } finally { fs.rmSync(temporary, {force: true}); }
}

function pruneCache(root, protectedFiles = []) {
    fs.mkdirSync(root, {recursive: true});
    const protectedSet = new Set(protectedFiles);
    const files = fs.readdirSync(root).map((name) => path.join(root, name))
        .filter((file) => fs.statSync(file).isFile()).map((file) => ({file, stat: fs.statSync(file)}))
        .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
    let total = files.reduce((sum, item) => sum + item.stat.size, 0);
    for (const {file, stat} of files) {
        if (protectedSet.has(file) || (Date.now() - stat.mtimeMs < TTL_MS && total <= CACHE_BYTES)) continue;
        fs.rmSync(file, {force: true}); total -= stat.size;
    }
}

async function prepare(filePath, root, options = {}) {
    if (!EXTRA_FORMATS.includes(path.extname(filePath).toLowerCase())) return {filePath};
    const stat = fs.statSync(localFile(filePath));
    const key = crypto.createHash('sha256').update(`${filePath}:${stat.size}:${stat.mtimeMs}`).digest('hex');
    fs.mkdirSync(root, {recursive: true});
    const target = path.join(root, `${key}.flac`);
    if (!fs.existsSync(target)) await convert(filePath, target, options);
    pruneCache(root, [target]);
    return {filePath: target, sourcePath: filePath, decoded: true};
}

module.exports = {run, analyse, analyseAlbum, convert, prepare, pruneCache, loudnessResult, EXTRA_FORMATS};
