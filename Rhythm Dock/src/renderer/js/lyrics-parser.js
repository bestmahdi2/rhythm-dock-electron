/* Shared parser: the renderer and regression tests use the same implementation. */
(function(root) {
'use strict';
const LRC_LINE_STAMP = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?]/g;
const LRC_WORD_STAMP = /<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/g;
const LRC_ID_TAG = /^\[([a-z]+):([^\]]*)]$/i;

/** `mm`, `ss`, `xx` capture groups to seconds. A 2-digit fraction is centiseconds. */
function stampToSeconds(minutes, seconds, fraction) {
    const frac = fraction
        ? parseInt(fraction, 10) / Math.pow(10, fraction.length)
        : 0;
    return parseInt(minutes, 10) * 60 + parseInt(seconds, 10) + frac;
}

/**
 * Splits an enhanced-LRC line body into timed word segments.
 * Returns null when the line has no word stamps, so callers can cheaply tell whether
 * to render a plain line or a span per word.
 */
function parseWordStamps(body, lineTime) {
    LRC_WORD_STAMP.lastIndex = 0;
    if (!LRC_WORD_STAMP.test(body)) return null;

    LRC_WORD_STAMP.lastIndex = 0;
    const words = [];
    let match;
    let cursor = 0;
    let pendingTime = lineTime;

    while ((match = LRC_WORD_STAMP.exec(body)) !== null) {
        // Text between the previous stamp and this one belongs to the previous stamp.
        const text = body.slice(cursor, match.index);
        if (text) words.push({time: pendingTime, text});
        pendingTime = stampToSeconds(match[1], match[2], match[3]);
        cursor = match.index + match[0].length;
    }

    const tail = body.slice(cursor);
    if (tail) words.push({time: pendingTime, text: tail});

    return words.length ? words : null;
}

function processLyrics(lyricsText) {
    if (!lyricsText) return {isSynced: false, hasWordTiming: false, lines: []};

    const rawLines = String(lyricsText).split(/\r?\n/);
    const synced = [];
    const plain = [];
    let hasWordTiming = false;
    let globalOffset = 0;

    for (const rawLine of rawLines) {
        const line = rawLine.trim();
        if (!line) continue;

        const idTag = line.match(LRC_ID_TAG);
        if (idTag) {
            if (idTag[1].toLowerCase() === 'offset') {
                const parsed = parseInt(idTag[2], 10);
                // The tag is in milliseconds and is positive when the lyric should
                // appear *earlier*, which is the opposite sign to our own offset.
                if (Number.isFinite(parsed)) globalOffset = -parsed / 1000;
            }
            continue;
        }

        LRC_LINE_STAMP.lastIndex = 0;
        const stamps = [];
        let match;
        while ((match = LRC_LINE_STAMP.exec(line)) !== null) {
            // Stamps only count as such while they are still a contiguous prefix;
            // a bracketed `[laughs]` mid-line is lyric text, not a timestamp.
            if (match.index !== LRC_LINE_STAMP.lastIndex - match[0].length) break;
            if (stamps.length && match.index !== stamps[stamps.length - 1].end) break;
            if (!stamps.length && match.index !== 0) break;
            stamps.push({
                time: stampToSeconds(match[1], match[2], match[3]),
                end: match.index + match[0].length,
            });
        }

        if (!stamps.length) {
            plain.push(line);
            continue;
        }

        const body = line.slice(stamps[stamps.length - 1].end).trim();
        if (!body) continue;

        const cleanText = body.replace(LRC_WORD_STAMP, '').replace(/\s+/g, ' ').trim();
        if (!cleanText) continue;

        for (const stamp of stamps) {
            const words = parseWordStamps(body, stamps[0].time);
            if (words) words.forEach(word => { word.time += stamp.time - stamps[0].time; });
            if (words) hasWordTiming = true;
            synced.push({time: stamp.time, text: cleanText, words});
        }
    }

    if (synced.length) {
        // Repeated-chorus stamps arrive out of order; the tick loop scans backwards
        // and would find the wrong line if they were not sorted.
        synced.sort((a, b) => a.time - b.time);
        if (globalOffset) {
            for (const line of synced) {
                line.time += globalOffset;
                if (line.words) line.words.forEach((word) => { word.time += globalOffset; });
            }
        }
        return {isSynced: true, hasWordTiming, lines: synced};
    }

    return {isSynced: false, hasWordTiming: false, lines: plain};
}


const api = {processLyrics, stampToSeconds, parseWordStamps,LRC_LINE_STAMP,LRC_WORD_STAMP,LRC_ID_TAG};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.RhythmLyrics = api;
})(typeof window !== 'undefined' ? window : globalThis);
