'use strict';

// Run with Electron, not Node: better-sqlite3 is rebuilt for Electron's ABI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {app} = require('electron');
const Database = require('better-sqlite3');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rhythm-dock-db-test-'));
const appData = path.join(scratch, 'app-data');
const legacyData = path.join(scratch, 'old-user-data');
fs.mkdirSync(appData, {recursive: true});
fs.mkdirSync(legacyData, {recursive: true});
app.setPath('appData', appData);
app.setPath('userData', legacyData);

app.whenReady().then(() => {
    const legacyPath = path.join(legacyData, 'lyrics.db');
    const original = new Database(legacyPath);
    original.exec(`CREATE TABLE lyrics (
        songKey TEXT PRIMARY KEY, lyricsText TEXT NOT NULL, lastUpdated TEXT NOT NULL
    )`);
    original.prepare('INSERT INTO lyrics VALUES (?, ?, ?)').run('test-song', 'keep these lyrics', '2026-01-01');
    original.pragma('user_version = 1');
    original.close();

    const paths = require('../src/main/core/paths');
    const database = require('../src/main/services/database');
    const libraryStore = require('../src/main/services/library-store');
    try {
        const handle = database.initialize();
        assert.equal(database.getLyrics('test-song'), 'keep these lyrics');
        assert.equal(handle.pragma('user_version', {simple: true}), database.TARGET_VERSION);
        const stablePath = paths.getDatabasePath();
        assert.ok(fs.existsSync(stablePath));
        assert.ok(fs.existsSync(legacyPath), 'migration must keep the original');
        const backups = fs.readdirSync(paths.getBackupDir()).filter((name) => name.endsWith('.db'));
        assert.ok(backups.length > 0, 'schema upgrade must create a backup');
        const root = libraryStore.addRoot('C:\\music');
        libraryStore.syncRoot(root.id, ['C:\\music\\one.mp3', 'C:\\music\\two.mp3']);
        assert.equal(libraryStore.scanSnapshot(root.id).length, 2);
        libraryStore.syncRoot(root.id, [{filePath: 'C:\\music\\one.mp3', fileMtimeMs: 123, fileSize: 456}],
            {complete: false});
        assert.equal(libraryStore.scanSnapshot(root.id)[0].fileSize, 456);
        assert.equal(libraryStore.stats().missing, 0,
            'incomplete scan must not mark unvisited files missing');
        libraryStore.updateTrackMetadata('C:\\music\\one.mp3', {artist: 'Artist', genre: 'Jazz'});
        libraryStore.updateTrackMetadata('C:\\music\\two.mp3', {artist: 'Artist', genre: 'Jazz'});
        libraryStore.recordPlay('C:\\music\\two.mp3', 120000);
        const suggested = libraryStore.recommendations({filePath: 'C:\\music\\one.mp3', artist: 'Artist', genre: 'Jazz'});
        assert.equal(suggested[0].filePath, 'C:\\music\\two.mp3');
        assert.match(suggested[0].reason, /Artist/);
        assert.equal(libraryStore.recommendations({hidden: ['C:\\music\\two.mp3']})
            .some((row) => row.filePath === 'C:\\music\\two.mp3'), false);
        const playlist = libraryStore.createPlaylist('Test playlist', ['C:\\music\\one.mp3']);
        assert.equal(playlist.ok, true);
        assert.equal(libraryStore.playlistTracks(playlist.id).length, 1);
        const snapshot = libraryStore.exportAll();
        assert.equal(snapshot.playlists[0].name, 'Test playlist');
        assert.equal(snapshot.playlists[0].tracks.length, 1);
        assert.equal(libraryStore.importAll(snapshot).ok, true);
        assert.equal(libraryStore.playlistTracks(playlist.id).length, 1,
            'restoring the same backup must not duplicate playlist entries');
        database.close();

        database.initialize();
        assert.equal(database.getLyrics('test-song'), 'keep these lyrics', 'reopening must preserve data');
        assert.equal(libraryStore.playlistTracks(playlist.id).length, 1,
            'reopening must preserve named playlists');
        database.close();
        console.log('PASS: legacy import, schema upgrade, backup, and reopen preserve lyrics and playlists');
        app.exit(0);
    } catch (error) {
        database.close();
        console.error(error);
        app.exit(1);
    }
}).catch((error) => {
    console.error(error);
    app.exit(1);
});
