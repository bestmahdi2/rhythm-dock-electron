'use strict';
const fs = require('node:fs');
const database = require('./database');

function get(filePath) {
    const row = database.handle()?.prepare('SELECT * FROM audio_analysis WHERE filePath = ?').get(filePath);
    if (!row) return null;
    try {
        const stat = fs.statSync(filePath);
        if (stat.size !== row.fileSize || stat.mtimeMs !== row.fileMtimeMs) return null;
        if (row.albumFiles) {
            try {
                for (const item of JSON.parse(row.albumFiles)) {
                    const albumStat = fs.statSync(item.filePath);
                    if (albumStat.size !== item.size || albumStat.mtimeMs !== item.mtimeMs) row.albumGainDb = null;
                }
            } catch (_) { row.albumGainDb = null; }
        }
        return row;
    } catch (_) { return null; }
}

function save(filePath, measurement) {
    const stat = fs.statSync(filePath);
    database.handle().prepare(`INSERT INTO audio_analysis
        (filePath, fileSize, fileMtimeMs, integratedLufs, truePeakDb, gainDb, targetLufs, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(filePath) DO UPDATE SET
        fileSize=excluded.fileSize, fileMtimeMs=excluded.fileMtimeMs,
        integratedLufs=excluded.integratedLufs, truePeakDb=excluded.truePeakDb,
            gainDb=excluded.gainDb, targetLufs=excluded.targetLufs, updatedAt=excluded.updatedAt,
            albumGainDb=NULL, albumFiles=NULL`)
        .run(filePath, stat.size, stat.mtimeMs, measurement.integratedLufs, measurement.truePeakDb,
            measurement.gainDb, measurement.targetLufs, new Date().toISOString());
}

function saveAlbum(files, measurement) {
    const snapshots = files.map((filePath) => {
        const stat = fs.statSync(filePath); return {filePath, size: stat.size, mtimeMs: stat.mtimeMs};
    });
    const handle = database.handle();
    handle.transaction(() => {
        for (const filePath of files) handle.prepare(`UPDATE audio_analysis SET albumGainDb=?, albumFiles=? WHERE filePath=?`)
            .run(measurement.gainDb, JSON.stringify(snapshots), filePath);
    })();
}

module.exports = {get, save, saveAlbum};
