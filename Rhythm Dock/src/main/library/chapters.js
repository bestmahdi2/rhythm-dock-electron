'use strict';

const path = require('path');

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

module.exports = {mp4Chapters, parseCue};
