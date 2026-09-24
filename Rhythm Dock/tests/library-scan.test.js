'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {Worker} = require('node:worker_threads');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rhythm-scan-'));
const filePath = path.join(root, 'Artist - Song.mp3');
fs.writeFileSync(filePath, Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00'));

function scan(previous = []) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, '../src/main/library/scan-worker.js'), {
            workerData: {rootPath: root, extensions: ['.mp3'], previous},
        });
        worker.on('message', (message) => {
            if (message.type === 'done') { resolve(message); worker.terminate(); }
            if (message.type === 'error') { reject(new Error(message.error)); worker.terminate(); }
        });
        worker.on('error', reject);
    });
}

(async () => {
    try {
        const first = await scan();
        assert.equal(first.complete, true);
        assert.equal(first.files.length, 1);
        assert.ok(first.files[0].fileSize > 0);
        const second = await scan(first.files);
        assert.equal(second.reparsed, 0, 'unchanged files must skip metadata parsing');
        assert.deepEqual(second.files.map((file) => file.filePath), [filePath]);
        console.log('PASS: background scan fingerprints and skips unchanged tags');
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
