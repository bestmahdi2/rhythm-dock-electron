'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mm = require('music-metadata');
const tools = require('../src/main/services/media-tools');
const chapters = require('../src/main/library/chapters');

(async () => {
    const executable = process.env.FFMPEG_TEST_BINARY || 'ffmpeg';
    await tools.run(executable, ['-version'], {timeoutMs: 5000});
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rhythm-real-media-'));
    const options = {executable};
    try {
        const source = path.join(scratch, 'album.wav');
        await tools.run(executable, ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i',
            'sine=frequency=440:duration=4', '-af', 'volume=0.25', source]);
        const measurement = await tools.analyse(source, options);
        assert.ok(Number.isFinite(measurement.integratedLufs));
        assert.ok(measurement.gainDb > 0 && measurement.gainDb <= 12);
        const originalBytes = fs.readFileSync(source);
        const selection = path.join(scratch, 'selection.flac');
        await tools.convert(source, selection, {start: 1, end: 2.5, ...options});
        const selected = await mm.parseFile(selection);
        assert.ok(Math.abs(selected.format.duration - 1.5) < 0.03, 'A–B export must have the selected duration');
        assert.deepEqual(fs.readFileSync(source), originalBytes, 'export must preserve the original');
        const albumGain = await tools.analyseAlbum([source, selection], options);
        assert.ok(Number.isFinite(albumGain.gainDb) && albumGain.gainDb > 0);
        const cue = 'FILE "album.wav" WAVE\n TRACK 01 AUDIO\n TITLE "First"\n INDEX 01 00:00:00\n' +
            ' TRACK 02 AUDIO\n TITLE "Second"\n INDEX 01 00:02:00\n';
        const cueList = chapters.parseCue(cue, source);
        assert.equal(cueList.length, 2);
        const chapterOut = path.join(scratch, 'chapter.flac');
        await tools.convert(source, chapterOut, {start: cueList[1].start, end: 4,
            tags: {title: cueList[1].title}, ...options});
        const chapter = await mm.parseFile(chapterOut);
        assert.equal(chapter.common.title, 'Second');
        assert.ok(Math.abs(chapter.format.duration - 2) < 0.03);
        const chapterMetadata = path.join(scratch, 'chapters.txt');
        fs.writeFileSync(chapterMetadata, ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2000\ntitle=First\n' +
            '[CHAPTER]\nTIMEBASE=1/1000\nSTART=2000\nEND=4000\ntitle=Second\n');
        const book = path.join(scratch, 'book.m4b');
        await tools.run(executable, ['-hide_banner', '-nostdin', '-i', source, '-i', chapterMetadata,
            '-map_metadata', '1', '-map_chapters', '1', '-c:a', 'aac', book]);
        const parsedBook = await mm.parseFile(book, {includeChapters: true});
        const bookChapters = chapters.mp4Chapters(parsedBook.format);
        if (!bookChapters.length) bookChapters.push(...await chapters.readMp4Chapters(book));
        assert.equal(bookChapters.length, 2, 'real M4B must expose both embedded chapters');
        assert.ok(Math.abs(bookChapters[1].start - 2) < 0.1);
        // WavPack exercises a decoder that Chromium cannot play directly.
        const wv = path.join(scratch, 'extra.wv');
        await tools.run(executable, ['-hide_banner', '-nostdin', '-i', source, '-c:a', 'wavpack', wv]);
        const decoded = await tools.prepare(wv, path.join(scratch, 'cache'), options);
        assert.equal(decoded.decoded, true);
        assert.ok((await mm.parseFile(decoded.filePath)).format.duration > 3.9);
        console.log('PASS: real FFmpeg loudness, accurate A–B export, CUE track, M4B chapters and WavPack decode');
    } finally { fs.rmSync(scratch, {recursive: true, force: true}); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
