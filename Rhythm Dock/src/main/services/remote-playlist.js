'use strict';
const path = require('node:path');
const cache = require('./remote-cache');
const MAX_BYTES = 1024 * 1024;
const MAX_TRACKS = 50;

function parse(text, extension, base) {
    const entries = [];
    if (['.m3u', '.m3u8'].includes(extension)) {
        if (/^#EXT-X-/m.test(text)) throw new Error('This is an HLS stream. Use a direct audio file or an audio playlist.');
        entries.push(...text.split(/\r?\n/).filter((line) => line.trim() && !line.trimStart().startsWith('#')));
    } else if (extension === '.pls') {
        const rows = [...text.matchAll(/^File(\d+)\s*=\s*(.+)$/gim)].sort((a, b) => Number(a[1]) - Number(b[1]));
        entries.push(...rows.map((row) => row[2]));
    } else if (extension === '.xspf') {
        for (const row of text.matchAll(/<location>\s*([^<]+)\s*<\/location>/gim)) entries.push(row[1].replace(/&amp;/g, '&'));
    } else throw new Error('Use an M3U, PLS, or XSPF playlist.');
    const urls = [];
    for (const entry of entries) {
        try { urls.push(cache.validateUrl(new URL(entry.trim(), base).href).href); }
        catch (_) { /* Local files and private links never enter an online import. */ }
    }
    return [...new Set(urls)].slice(0, MAX_TRACKS);
}

async function urls(value, request = fetch) {
    let url = cache.validateUrl(value), response;
    for (let redirect = 0; redirect < 4; redirect++) {
        response = await request(url, {redirect: 'manual', signal: AbortSignal.timeout(30000)});
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('Playlist redirect has no destination.');
        url = cache.validateUrl(new URL(location, url).href);
    }
    if (!response?.ok || !response.body) throw new Error('Could not download the playlist.');
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Playlist exceeds the 1 MB limit.');
    let bytes = 0; const chunks = [];
    for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) throw new Error('Playlist exceeds the 1 MB limit.');
        chunks.push(Buffer.from(chunk));
    }
    const extension = path.extname(url.pathname).toLowerCase();
    const result = parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''), extension, url.href);
    if (!result.length) throw new Error('The playlist has no public HTTPS audio links.');
    return result;
}

async function download(value, root, request = fetch, progress = () => {}) {
    const links = /\.(m3u8?|pls|xspf)$/i.test(new URL(value).pathname) ? await urls(value, request) : [value];
    const files = [], errors = [];
    for (let index = 0; index < links.length; index++) {
        try {
            const result = await cache.download(links[index], root, request,
                (received, total) => progress({received, total, index: index + 1, count: links.length}), files);
            files.push(result.filePath);
        } catch (error) { errors.push({index: index + 1, error: error.message}); }
    }
    if (!files.length) throw new Error(errors[0]?.error || 'No playable audio was found.');
    return {files, errors};
}
module.exports = {parse, urls, download};
