'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {Readable, Transform} = require('node:stream');
const {pipeline} = require('node:stream/promises');

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_CACHE_BYTES = 512 * 1024 * 1024;
const TTL_MS = 2 * 24 * 60 * 60 * 1000;
const TYPES = {'.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
    '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.aac': 'audio/aac'};
const TYPE_EXT = Object.fromEntries(Object.entries(TYPES).map(([ext, mime]) => [mime, ext]));
const activeTransfers = new Set();
let playingFiles = [];
function protect(files) {playingFiles=(files||[]).filter(file=>typeof file==='string'&&path.isAbsolute(file)).slice(0,2);}

function validateUrl(value) {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password ||
        host === 'localhost' || host.endsWith('.local') ||
        /^127\.|^10\.|^192\.168\.|^169\.254\.|^0\.|^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
        host === '[::1]' || host.startsWith('[fc') || host.startsWith('[fd')) {
        throw new Error('Use a public HTTPS audio link.');
    }
    return url;
}

function cleanName(url, mime) {
    const raw = path.posix.basename(decodeURIComponent(url.pathname));
    const originalExt = path.extname(raw).toLowerCase();
    const ext = TYPES[originalExt] ? originalExt : TYPE_EXT[mime];
    if (!ext) throw new Error('The link does not point to a supported audio file.');
    const stem = path.basename(raw, originalExt).replace(/[^\p{L}\p{N} ._()-]/gu, '_').trim().slice(0, 100);
    return `${stem || 'remote-song'}${ext}`;
}

function listCacheFiles(root) {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, {withFileTypes: true}).filter((entry) => entry.isDirectory())
        .flatMap((entry) => fs.readdirSync(path.join(root, entry.name))
            .map((name) => path.join(root, entry.name, name)))
        .filter((filePath) => fs.statSync(filePath).isFile());
}

function prune(root, protectedFiles = []) {
    const protectedSet = new Set([...protectedFiles, ...activeTransfers, ...playingFiles]);
    const files = listCacheFiles(root).map((filePath) =>
        ({filePath, stat: fs.statSync(filePath)})).sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
    let total = files.reduce((sum, item) => sum + item.stat.size, 0);
    for (const item of files) {
        if (protectedSet.has(item.filePath)) continue;
        if (Date.now() - item.stat.mtimeMs <= TTL_MS && total <= MAX_CACHE_BYTES) continue;
        fs.rmSync(item.filePath, {force: true});
        total -= item.stat.size;
    }
    return total;
}

async function download(value, root, fetchImpl = fetch, onProgress = () => {}, protectedFiles = []) {
    let url = validateUrl(value);
    const key = crypto.createHash('sha256').update(url.href).digest('hex');
    const dir = path.join(root, key);
    fs.mkdirSync(dir, {recursive: true});
    prune(root, protectedFiles);
    for (const filePath of fs.readdirSync(dir).map((name) => path.join(dir, name))
        .filter((candidate) => TYPES[path.extname(candidate).toLowerCase()] && fs.statSync(candidate).isFile())) {
        const stat = fs.statSync(filePath);
        if (Date.now() - stat.mtimeMs < TTL_MS && stat.size > 0) return {filePath, cached: true};
    }
    let response;
    for (let redirect = 0; redirect < 4; redirect++) {
        response = await fetchImpl(url, {redirect: 'manual', signal: AbortSignal.timeout(120000)});
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('location');
        if (!location) throw new Error('The audio link redirected without a destination.');
        await response.body?.cancel();
        url = validateUrl(new URL(location, url).href);
    }
    if (!response?.ok || !response.body) throw new Error(`Audio download failed (${response?.status || 'network'}).`);
    const mime = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (mime && !mime.startsWith('audio/') && mime !== 'application/octet-stream' && mime !== 'application/ogg')
        throw new Error('The link returned a page rather than audio.');
    const fileName = cleanName(url, mime);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_FILE_BYTES) throw new Error('Audio link exceeds the 100 MB limit.');
    const filePath = path.join(dir, fileName);
    const temporary = `${filePath}.part-${crypto.randomBytes(4).toString('hex')}`;
    activeTransfers.add(temporary);
    let received = 0;
    try {
        await pipeline(Readable.fromWeb(response.body), new Transform({
            transform(chunk, _encoding, callback) {
                received += chunk.length;
                if (received > MAX_FILE_BYTES) callback(new Error('Audio link exceeds the 100 MB limit.'));
                else { onProgress(received, length); callback(null, chunk); }
            },
        }), fs.createWriteStream(temporary, {flags: 'wx'}));
        if (!received) throw new Error('The audio link was empty.');
        fs.renameSync(temporary, filePath);
        if (prune(root, [...protectedFiles, filePath]) > MAX_CACHE_BYTES) {
            fs.rmSync(filePath, {force: true});
            throw new Error('The playlist exceeds the 512 MB temporary cache. Save songs or import a smaller playlist.');
        }
        return {filePath, cached: false};
    } catch (error) {
        fs.rmSync(temporary, {force: true});
        throw error;
    } finally {
        activeTransfers.delete(temporary);
    }
}

function save(filePath, root, incomingRoot) {
    const relative = path.relative(root, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(filePath))
        throw new Error('Only a cached audio link can be saved.');
    const target = path.join(incomingRoot, path.basename(path.dirname(filePath)), path.basename(filePath));
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(filePath, target);
    return target;
}

module.exports = {download, save, prune, validateUrl, cleanName,protect};
