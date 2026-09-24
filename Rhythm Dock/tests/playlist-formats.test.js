'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const formats = require('../src/main/services/playlist-formats');

const directory = path.resolve('C:/Music');
const tracks = [path.join(directory, 'one.mp3'), path.join(directory, 'two.flac')];
for (const extension of ['.m3u8', '.pls', '.xspf']) {
    const output = formats.serialize(tracks, extension, directory);
    assert.deepEqual(formats.parse(output, extension, directory), tracks, `${extension} round trip`);
}
assert.deepEqual(formats.parse('#EXTM3U\nhttps://example.com/stream.mp3\none.mp3\n', '.m3u8', directory),
    [tracks[0]], 'remote entries must not turn into local paths');
console.log('PASS: M3U, PLS and XSPF playlist files round-trip local tracks');
