"use strict";
const fs = require('node:fs');
const path = require('node:path');
const formats = require('../../shared/media-formats');
const playlists = require('./playlist-formats');

// Explicitly opened playlists/CUE files expand to audio. Folder scans only index audio.
function expandFiles(inputs, {limit = 10000} = {}) {
    const output = new Set(), visited = new Set();
    function visit(input, depth = 0) {
        if (typeof input !== 'string' || output.size >= limit || depth > 5) return;
        const file = path.resolve(input), extension = path.extname(file).toLowerCase();
        if (visited.has(file)) return;
        visited.add(file);
        let stat;
        try { stat = fs.statSync(file); } catch (_) { return; }
        if (!stat.isFile()) return;
        if (formats.isAudio(file)) { output.add(file); return; }
        if (!formats.playlists.includes(extension) && extension !== '.cue') return;
        if (stat.size > 5 * 1024 * 1024) throw new Error('Playlist or CUE file exceeds 5 MB.');
        if (formats.playlists.includes(extension)) {
            for (const entry of playlists.parse(fs.readFileSync(file,'utf8'),extension,path.dirname(file))) visit(entry,depth+1);
        } else if (extension === '.cue') {
            const text = fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'');
            for (const match of text.matchAll(/^\s*FILE\s+(?:"([^"]+)"|(\S+))\s+\S+/gim)) {
                const name = (match[1] || match[2]).replace(/\\/g,path.sep);
                if (!/[\0\r\n]/.test(name)) visit(path.resolve(path.dirname(file),name),depth+1);
            }
        }
    }
    for (const input of inputs) visit(input);
    return [...output];
}
module.exports = {expandFiles};
