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
    const coverCache = require('../src/main/library/cover-cache');
    try {
        const handle = database.initialize();
        assert.equal(database.getLyrics('test-song'), 'keep these lyrics');
        assert.equal(handle.pragma('user_version', {simple: true}), database.TARGET_VERSION);
        const stablePath = paths.getDatabasePath();
        const art = fs.readFileSync(path.join(__dirname, '../src/assets/images/volume.png'));
        const coverDir = path.join(scratch, 'covers');
        const firstCover = coverCache.thumbnail(art, coverDir);
        assert.match(firstCover, /^data:image\/png;base64,/);
        assert.equal(coverCache.thumbnail(art, coverDir), firstCover,
            'identical embedded art should reuse its cached thumbnail');
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
        libraryStore.updateTrackMetadata('C:\\music\\one.mp3', {artist: 'Artist', album: 'First', genre: 'Jazz'});
        libraryStore.updateTrackMetadata('C:\\music\\two.mp3', {artist: 'Artist', album: 'First', genre: 'Jazz'});
        libraryStore.recordPlay('C:\\music\\two.mp3', 120000);
        assert.equal(libraryStore.setRating('C:\\music\\one.mp3', 4), true);
        assert.equal(libraryStore.setRating('C:\\music\\one.mp3', 7), false);
        assert.equal(libraryStore.getRating('C:\\music\\one.mp3'), 4);
        assert.equal(libraryStore.setBookPosition('C:\\music\\book.m4b', 234.5), true);
        assert.equal(libraryStore.setBookPosition('C:\\music\\one.mp3', 234.5), false);
        assert.equal(libraryStore.getBookPosition('C:\\music\\book.m4b'), 234.5);
        const suggested = libraryStore.recommendations({filePath: 'C:\\music\\one.mp3', artist: 'Artist', genre: 'Jazz'});
        assert.equal(suggested[0].filePath, 'C:\\music\\two.mp3');
        assert.match(suggested[0].reason, /Artist/);
        assert.equal(libraryStore.recommendations({hidden: ['C:\\music\\two.mp3']})
            .some((row) => row.filePath === 'C:\\music\\two.mp3'), false);
        libraryStore.syncRoot(root.id, ['C:\\music\\one.mp3', 'C:\\music\\two.mp3',
            'C:\\music\\three.mp3', 'C:\\music\\four.mp3']);
        for (const name of ['three', 'four']) {
            libraryStore.updateTrackMetadata(`C:\\music\\${name}.mp3`,
                {artist: 'Other', album: 'Second', genre: 'Jazz'});
        }
        const albumSuggestions = libraryStore.albumRecommendations({artist: 'Artist',
            album: 'First', genre: 'Jazz'});
        assert.equal(albumSuggestions[0].album, 'Second');
        assert.equal(albumSuggestions[0].tracks.length, 2);
        assert.equal(libraryStore.setPreference('C:\\music\\three.mp3', {mood: 'focus', feedback: 1}), true);
        assert.equal(libraryStore.setPreference('C:\\music\\four.mp3', {mood: 'focus'}), true);
        assert.equal(libraryStore.setPreference('C:\\music\\two.mp3', {feedback: -1}), true);
        assert.equal(libraryStore.setPreference('C:\\music\\one.mp3', {mood: 'invalid'}), false);
        const feedbackSuggestions = libraryStore.recommendations({mood: 'focus'});
        assert.equal(feedbackSuggestions.length, 2);
        assert.equal(feedbackSuggestions[0].filePath, 'C:\\music\\three.mp3');
        assert.ok(feedbackSuggestions.every((row) => row.mood === 'focus'));
        assert.equal(libraryStore.recommendations().some((row) => row.filePath === 'C:\\music\\two.mp3'), false);
        const audioAnalysis = require('../src/main/services/audio-analysis');
        const analysed = path.join(scratch, 'analysed.wav');
        fs.writeFileSync(analysed, 'audio fixture');
        audioAnalysis.save(analysed, {integratedLufs: -20, truePeakDb: -4, gainDb: 2, targetLufs: -18});
        assert.equal(audioAnalysis.get(analysed).gainDb, 2);
        const albumSecond = path.join(scratch, 'album-second.wav');
        fs.writeFileSync(albumSecond, 'second audio fixture');
        audioAnalysis.saveAlbum([analysed, albumSecond], {gainDb: 1});
        assert.equal(audioAnalysis.get(analysed).albumGainDb, 1);
        fs.appendFileSync(albumSecond, 'changed');
        assert.equal(audioAnalysis.get(analysed).albumGainDb, null, 'any changed album file invalidates album gain');
        fs.appendFileSync(analysed, 'changed');
        assert.equal(audioAnalysis.get(analysed), null, 'changed files invalidate stored loudness');
        const playlist = libraryStore.createPlaylist('Test playlist', ['C:\\music\\one.mp3']);
        assert.equal(playlist.ok, true);
        assert.equal(libraryStore.playlistTracks(playlist.id).length, 1);
        const snapshot = libraryStore.exportAll();
        assert.equal(snapshot.ratings[0].rating, 4);
        assert.equal(snapshot.bookPositions[0].seconds, 234.5);
        assert.equal(snapshot.playlists[0].name, 'Test playlist');
        assert.equal(snapshot.playlists[0].tracks.length, 1);
        assert.equal(snapshot.preferences.length, 3);
        assert.equal(snapshot.audioAnalysis.length, 1);
        assert.equal(libraryStore.importAll(snapshot).ok, true);
        assert.equal(libraryStore.playlistTracks(playlist.id).length, 1,
            'restoring the same backup must not duplicate playlist entries');
        database.close();

        database.initialize();
        assert.equal(database.getLyrics('test-song'), 'keep these lyrics', 'reopening must preserve data');
        assert.equal(libraryStore.playlistTracks(playlist.id).length, 1,
            'reopening must preserve named playlists');
        assert.equal(libraryStore.getRating('C:\\music\\one.mp3'), 4,
            'reopening must preserve ratings');
        assert.equal(libraryStore.getBookPosition('C:\\music\\book.m4b'), 234.5,
            'reopening must preserve audiobook position');
        assert.equal(libraryStore.preferences().length, 3, 'reopen must preserve discovery feedback');
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
