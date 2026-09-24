'use strict';

const fs = require('fs');
const {parentPort, workerData} = require('worker_threads');
const scanner = require('./scanner');
const mm = require('music-metadata');

let cancelled = false;
parentPort.on('message', (message) => { if (message === 'cancel') cancelled = true; });

async function run() {
    const previous = new Map(workerData.previous.map((row) => [row.filePath, row]));
    const scan = await scanner.scanDirectory(workerData.rootPath, workerData.extensions, {
        shouldCancel: () => cancelled,
        onProgress: (progress) => parentPort.postMessage({type: 'progress', ...progress}),
    });
    const files = [];
    let reparsed = 0;
    let unreadable = false;
    for (let i = 0; i < scan.files.length && !cancelled; i++) {
        const filePath = scan.files[i];
        try {
            const stat = await fs.promises.stat(filePath);
            const fingerprint = {filePath, fileMtimeMs: stat.mtimeMs, fileSize: stat.size};
            const old = previous.get(filePath);
            if (!old || old.fileMtimeMs !== stat.mtimeMs || old.fileSize !== stat.size) {
                try {
                    const tags = await mm.parseFile(filePath, {skipCovers: true, duration: false});
                    fingerprint.title = tags.common.title || null;
                    fingerprint.artist = tags.common.artist || null;
                    fingerprint.album = tags.common.album || null;
                    fingerprint.genre = tags.common.genre?.[0] || null;
                    fingerprint.durationSeconds = tags.format.duration || null;
                    reparsed++;
                } catch (_) { /* Preserve filename fallback for unreadable tags. */ }
            }
            files.push(fingerprint);
        } catch (_) { unreadable = true; /* A file may disappear while scanning. */ }
        if (i % 100 === 0) parentPort.postMessage({type: 'metadata-progress', done: i + 1, total: scan.files.length});
    }
    parentPort.postMessage({type: 'done', files, reparsed,
        complete: !cancelled && !scan.truncated && !scan.incomplete && !unreadable,
        truncated: scan.truncated, cancelled});
}

run().catch((error) => parentPort.postMessage({type: 'error', error: error.message}));
