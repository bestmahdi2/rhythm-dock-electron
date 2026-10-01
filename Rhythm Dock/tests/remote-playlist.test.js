'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const playlist = require('../src/main/services/remote-playlist');
(async () => {
    const base = 'https://example.com/music/list.m3u';
    assert.deepEqual(playlist.parse('#EXTM3U\na.mp3\nhttps://localhost/private.mp3\na.mp3\nb.mp3', '.m3u', base),
        ['https://example.com/music/a.mp3', 'https://example.com/music/b.mp3']);
    assert.deepEqual(playlist.parse('[playlist]\nFile2=b.mp3\nFile1=a.mp3', '.pls', base),
        ['https://example.com/music/a.mp3', 'https://example.com/music/b.mp3']);
    assert.deepEqual(playlist.parse('<location>a.mp3?x=1&amp;y=2</location>', '.xspf', base),
        ['https://example.com/music/a.mp3?x=1&y=2']);
    assert.throws(() => playlist.parse('#EXT-X-TARGETDURATION:10', '.m3u8', base), /HLS/);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rhythm-playlist-test-'));
    try {
        const request = async (url) => {
            if (url.pathname.endsWith('.m3u')) return new Response('a.mp3\nmissing.mp3\nb.mp3');
            if (url.pathname.endsWith('missing.mp3')) return new Response('', {status: 404});
            return new Response('audio', {headers: {'Content-Type': 'audio/mpeg'}});
        };
        const result = await playlist.download(base, scratch, request);
        assert.deepEqual(result.files.map((file) => path.basename(file)), ['a.mp3', 'b.mp3']);
        assert.equal(result.errors.length, 1);
        await assert.rejects(() => playlist.urls(base, async () => new Response('', {status: 302,
            headers: {Location: 'https://127.0.0.1/private.m3u'}})), /public/);
        await assert.rejects(() => playlist.urls(base, async () => new Response('x', {
            headers: {'Content-Length': '2000000'}})), /1 MB/);
        console.log('PASS: remote playlist order, partial failures, size limits and redirect validation');
    } finally { fs.rmSync(scratch, {recursive: true, force: true}); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
