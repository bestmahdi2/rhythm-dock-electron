'use strict';

const assert = require('node:assert/strict');
const {mp4Chapters, parseCue} = require('../src/main/library/chapters');

assert.deepEqual(mp4Chapters({sampleRate: 44100, chapters: [
    {title: 'One', sampleOffset: 0}, {title: 'Two', sampleOffset: 882000},
]}), [{title: 'One', start: 0}, {title: 'Two', start: 20}]);
const cue = `FILE "Album.flac" WAVE
  TRACK 01 AUDIO
    TITLE "Opening"
    INDEX 01 00:00:00
  TRACK 02 AUDIO
    TITLE "Second"
    INDEX 00 03:59:00
    INDEX 01 04:00:37
FILE "Other.flac" WAVE
  TRACK 03 AUDIO
    INDEX 01 00:00:00`;
const chapters = parseCue(cue, '/music/Album.flac');
assert.equal(chapters.length, 2);
assert.equal(chapters[1].title, 'Second');
assert.equal(chapters[1].start, 240 + 37 / 75);
assert.equal(parseCue(cue, '/music/Other.flac').length, 1);
console.log('PASS: MP4 and CUE chapter offsets');
