'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {RootWatcher} = require('../src/main/library/root-watcher');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rhythm-watch-'));
let changed = 0;
const watcher = new RootWatcher(async () => { changed++; }, {debounceMs: 100, fallbackMs: 150});

(async () => {
    try {
        watcher.add({id: 1, path: directory});
        fs.writeFileSync(path.join(directory, 'new.mp3'), 'audio');
        const deadline = Date.now() + 3000;
        while (changed === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.ok(changed > 0, 'new file should trigger a watched rescan');
        watcher.remove(1);
        console.log('PASS: library root watcher responds to file changes');
    } finally {
        watcher.close();
        fs.rmSync(directory, {recursive: true, force: true});
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
