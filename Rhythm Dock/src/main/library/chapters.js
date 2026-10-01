'use strict';

const path = require('path');
const fs = require('node:fs/promises');

function mp4Chapters(format) {
    const rate = Number(format?.sampleRate);
    if (!rate || !Array.isArray(format?.chapters)) return [];
    return format.chapters.map((chapter, index) => ({
        title: String(chapter.title || `Chapter ${index + 1}`),
        start: Number(chapter.sampleOffset) / rate,
    })).filter((chapter) => Number.isFinite(chapter.start) && chapter.start >= 0)
        .sort((a, b) => a.start - b.start);
}

function parseCue(text, audioFilePath) {
    const target = path.basename(audioFilePath).toLocaleLowerCase();
    let currentFile = '';
    let track = null;
    const chapters = [];
    for (const raw of String(text).split(/\r?\n/)) {
        const line = raw.trim();
        const file = /^FILE\s+(?:"([^"]+)"|(\S+))\s+\S+/i.exec(line);
        if (file) { currentFile = path.basename((file[1] || file[2]).replace(/\\/g, '/')).toLocaleLowerCase(); track = null; continue; }
        const start = /^TRACK\s+(\d+)\s+AUDIO/i.exec(line);
        if (start) { track = {number: Number(start[1]), title: ''}; continue; }
        if (!track || currentFile !== target) continue;
        const title = /^TITLE\s+(?:"([^"]+)"|(.+))/i.exec(line);
        if (title) { track.title = (title[1] || title[2]).trim(); continue; }
        const index = /^INDEX\s+01\s+(\d+):(\d+):(\d+)/i.exec(line);
        if (index) {
            const minutes = Number(index[1]);
            const seconds = Number(index[2]);
            const frames = Number(index[3]);
            if (seconds < 60 && frames < 75) chapters.push({
                title: track.title || `Track ${track.number}`,
                start: minutes * 60 + seconds + frames / 75,
            });
        }
    }
    return chapters.sort((a, b) => a.start - b.start);
}

// Nero chpl chapters are common in FFmpeg-produced audiobooks, but the current
// music-metadata parser only reads QuickTime chapter tracks. Read just the small
// atom tree, never the audiobook's audio payload.
async function readMp4Chapters(filePath) {
    const file = await fs.open(filePath, 'r');
    try {
        const {size} = await file.stat();
        let visited = 0;
        const read = async (position, bytes) => {
            const buffer = Buffer.alloc(bytes);
            const result = await file.read(buffer, 0, bytes, position);
            return buffer.subarray(0, result.bytesRead);
        };
        const walk = async (from, to, depth = 0) => {
            if (depth > 4) return [];
            let offset = from;
            while (offset + 8 <= to && visited++ < 10000) {
                const header = await read(offset, 16);
                if (header.length < 8) break;
                let atomSize = header.readUInt32BE(0), headerSize = 8;
                const kind = header.toString('ascii', 4, 8);
                if (atomSize === 1) {
                    if (header.length < 16) break;
                    atomSize = Number(header.readBigUInt64BE(8)); headerSize = 16;
                } else if (atomSize === 0) atomSize = to - offset;
                if (!Number.isSafeInteger(atomSize) || atomSize < headerSize || offset + atomSize > to) break;
                if (kind === 'chpl' && atomSize <= 256 * 1024) {
                    const data = await read(offset + headerSize, atomSize - headerSize);
                    const countOffset = data[0] === 1 ? 8 : 4;
                    if (data.length <= countOffset) return [];
                    const list = []; let cursor = countOffset + 1;
                    for (let index = 0; index < data[countOffset] && cursor + 9 <= data.length; index++) {
                        const start = Number(data.readBigUInt64BE(cursor)) / 10000000;
                        const length = data[cursor + 8]; cursor += 9;
                        if (cursor + length > data.length) break;
                        list.push({start, title: data.toString('utf8', cursor, cursor + length) || `Chapter ${index + 1}`});
                        cursor += length;
                    }
                    return list.filter((chapter) => Number.isFinite(chapter.start) && chapter.start >= 0)
                        .sort((a, b) => a.start - b.start);
                }
                if (kind === 'moov' || kind === 'udta') {
                    const found = await walk(offset + headerSize, offset + atomSize, depth + 1);
                    if (found.length) return found;
                }
                offset += atomSize;
            }
            return [];
        };
        return await walk(0, size);
    } finally { await file.close(); }
}

module.exports = {mp4Chapters, parseCue, readMp4Chapters};
