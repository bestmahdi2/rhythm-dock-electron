'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cache = require('../src/main/services/remote-cache');

(async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rhythm-remote-test-'));
    try {
        let requests = 0;
        const fakeFetch = async () => {
            requests++;
            return new Response(Buffer.from('audio-bytes'), {
                headers: {'Content-Type': 'audio/mpeg', 'Content-Length': '11'},
            });
        };
        assert.throws(() => cache.validateUrl('http://example.com/song.mp3'), /HTTPS/);
        assert.throws(() => cache.validateUrl('https://127.0.0.1/song.mp3'), /public/);
        const first = await cache.download('https://example.com/song.mp3', path.join(scratch, 'cache'), fakeFetch);
        assert.equal(fs.readFileSync(first.filePath, 'utf8'), 'audio-bytes');
        const second = await cache.download('https://example.com/song.mp3', path.join(scratch, 'cache'), fakeFetch);
        assert.equal(second.cached, true);
        assert.equal(requests, 1);
        const saved = cache.save(first.filePath, path.join(scratch, 'cache'), path.join(scratch, 'incoming'));
        assert.equal(fs.readFileSync(saved, 'utf8'), 'audio-bytes');
        fs.utimesSync(first.filePath, new Date(0), new Date(0));
        cache.protect([first.filePath]);cache.prune(path.join(scratch,'cache'));
        assert.equal(fs.existsSync(first.filePath),true,'active playback must survive expiry pruning');
        cache.protect([]);
        cache.prune(path.join(scratch, 'cache'));
        assert.equal(fs.existsSync(first.filePath), false);
        assert.equal(fs.existsSync(saved), true);
        console.log('PASS: direct audio cache is bounded, reusable, expiring, and saveable');
    } finally {
        fs.rmSync(scratch, {recursive: true, force: true});
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
