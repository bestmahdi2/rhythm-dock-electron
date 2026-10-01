'use strict';

/**
 * Persistent library store (Phase 7).
 *
 * The in-memory index in `library/index.js` answers "what is in the library right
 * now" for search and artist browsing, and is rebuilt from scratch on every scan.
 * This module is the durable half: which folders the user has added, which tracks
 * were found in them, and how often each has been played.
 *
 * Two rules the schema exists to enforce:
 *
 *   1. A rescan must never cost the user their play history. Statistics live in their
 *      own table keyed by path, so rewriting `tracks` cannot touch them, and removing
 *      a folder and adding it back leaves the counts intact.
 *   2. A file that has gone missing is *marked*, not deleted. External drives get
 *      unplugged and network shares drop; deleting the row would throw away the play
 *      count for a track that will be back in ten seconds.
 */

const path = require('path');
const fs = require('fs');
const database = require('./database');

const VIEW_LIMIT_MAX = 500;

function db() {
    return database.handle();
}

function nowIso() {
    return new Date().toISOString();
}

// --- Roots -----------------------------------------------------------------------

/** Every watched folder, with a live count of the tracks currently found in it. */
function listRoots() {
    const handle = db();
    if (!handle) return [];
    try {
        return handle.prepare(`
            SELECT r.id,
                   r.path,
                   r.addedAt,
                   r.lastScanAt,
                   (SELECT COUNT(*) FROM tracks t WHERE t.rootId = r.id AND t.missing = 0) AS liveCount
            FROM roots r
            ORDER BY r.addedAt
        `).all();
    } catch (error) {
        console.error('[library] Could not list roots:', error);
        return [];
    }
}

/**
 * Adds a folder, or returns the existing row if it is already watched.
 * Idempotent on purpose: picking the same folder twice from the dialog is a very easy
 * mistake and should not produce a duplicate that scans everything a second time.
 */
function addRoot(rootPath) {
    const handle = db();
    if (!handle || !rootPath) return null;
    try {
        handle.prepare(
            `INSERT INTO roots (path, addedAt) VALUES (?, ?) ON CONFLICT(path) DO NOTHING`
        ).run(rootPath, nowIso());
        return handle.prepare('SELECT * FROM roots WHERE path = ?').get(rootPath) || null;
    } catch (error) {
        console.error('[library] Could not add root:', error);
        return null;
    }
}

/**
 * Forgets a folder and the track rows under it. Statistics are deliberately left
 * behind, so re-adding the folder restores the history rather than starting from zero.
 */
function removeRoot(rootId) {
    const handle = db();
    if (!handle || !rootId) return false;
    try {
        const remove = handle.transaction(() => {
            handle.prepare('DELETE FROM tracks WHERE rootId = ?').run(rootId);
            handle.prepare('DELETE FROM roots WHERE id = ?').run(rootId);
        });
        remove();
        return true;
    } catch (error) {
        console.error('[library] Could not remove root:', error);
        return false;
    }
}

function scanSnapshot(rootId) {
    const handle = db();
    if (!handle) return [];
    return handle.prepare('SELECT filePath, fileMtimeMs, fileSize FROM tracks WHERE rootId = ?').all(rootId);
}

// --- Tracks ----------------------------------------------------------------------

/**
 * Records the result of a scan of one root.
 *
 * Everything happens in a single transaction: a scan interrupted halfway through
 * would otherwise leave half the library marked missing.
 *
 * Returns `{seen, added, restored, missing}` - `restored` counts tracks that were
 * marked missing and have come back, which is the number the UI reports.
 */
function syncRoot(rootId, files = [], {complete = true} = {}) {
    const handle = db();
    if (!handle) return {seen: 0, added: 0, restored: 0, missing: 0};

    const timestamp = nowIso();
    const result = {seen: files.length, added: 0, restored: 0, missing: 0};

    try {
        const previous = new Map(
            handle.prepare('SELECT filePath, missing FROM tracks WHERE rootId = ?')
                .all(rootId)
                .map((row) => [row.filePath, row.missing])
        );

        const upsert = handle.prepare(`
            INSERT INTO tracks (filePath, rootId, basename, title, artist, album, genre,
                                durationSeconds, addedAt, lastSeenAt, missing, fileMtimeMs, fileSize)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
            ON CONFLICT(filePath) DO UPDATE SET rootId     = excluded.rootId,
                                                basename   = excluded.basename,
                                                -- COALESCE: a scan carries filename-derived
                                                -- guesses, and must not overwrite better
                                                -- values already read from real tags.
                                                title      = COALESCE(excluded.title, tracks.title),
                                                artist     = COALESCE(excluded.artist, tracks.artist),
                                                album      = COALESCE(excluded.album, tracks.album),
                                                genre      = COALESCE(excluded.genre, tracks.genre),
                                                durationSeconds = COALESCE(excluded.durationSeconds, tracks.durationSeconds),
                                                fileMtimeMs = COALESCE(excluded.fileMtimeMs, tracks.fileMtimeMs),
                                                fileSize = COALESCE(excluded.fileSize, tracks.fileSize),
                                                lastSeenAt = excluded.lastSeenAt,
                                                missing    = 0
        `);

        const apply = handle.transaction(() => {
            for (const file of files) {
                const filePath = typeof file === 'string' ? file : file.filePath;
                if (!filePath) continue;

                const previousState = previous.get(filePath);
                if (previousState === undefined) result.added += 1;
                else if (previousState === 1) result.restored += 1;
                previous.delete(filePath);

                upsert.run(
                    filePath,
                    rootId,
                    path.basename(filePath),
                    (typeof file === 'object' && file.title) || null,
                    (typeof file === 'object' && file.artist) || null,
                    (typeof file === 'object' && file.album) || null,
                    (typeof file === 'object' && file.genre) || null,
                    (typeof file === 'object' && file.durationSeconds) || null,
                    timestamp,
                    timestamp,
                    typeof file === 'object' ? (file.fileMtimeMs ?? null) : null,
                    typeof file === 'object' ? (file.fileSize ?? null) : null
                );
            }

            // Whatever is left in `previous` was not seen this time.
            if (complete) {
                const markMissing = handle.prepare('UPDATE tracks SET missing = 1 WHERE filePath = ?');
                for (const [filePath, wasMissing] of previous) {
                    markMissing.run(filePath);
                    if (!wasMissing) result.missing += 1;
                }
            }

            handle.prepare('UPDATE roots SET lastScanAt = ? WHERE id = ?').run(timestamp, rootId);
        });

        apply();
    } catch (error) {
        console.error('[library] Could not sync root:', error);
    }

    return result;
}

/**
 * Re-tests every missing track and clears the flag for any that are back.
 * Cheap: it is one `existsSync` per missing row, and there are rarely many.
 */
function recheckMissing() {
    const handle = db();
    if (!handle) return 0;
    try {
        const missing = handle.prepare('SELECT filePath FROM tracks WHERE missing = 1').all();
        const clear = handle.prepare('UPDATE tracks SET missing = 0, lastSeenAt = ? WHERE filePath = ?');
        const timestamp = nowIso();

        let restored = 0;
        const apply = handle.transaction(() => {
            for (const row of missing) {
                if (!fs.existsSync(row.filePath)) continue;
                clear.run(timestamp, row.filePath);
                restored += 1;
            }
        });
        apply();
        return restored;
    } catch (error) {
        console.error('[library] Could not recheck missing tracks:', error);
        return 0;
    }
}

/** Upgrades a row with real tag data, once a track has actually been played. */
function updateTrackMetadata(filePath, {title, artist, album, genre, durationSeconds} = {}) {
    const handle = db();
    if (!handle || !filePath) return;
    try {
        handle.prepare(`
            UPDATE tracks
            SET title           = COALESCE(?, title),
                artist          = COALESCE(?, artist),
                album           = COALESCE(?, album),
                genre           = COALESCE(?, genre),
                durationSeconds = COALESCE(?, durationSeconds)
            WHERE filePath = ?
        `).run(title || null, artist || null, album || null, genre || null, durationSeconds || null, filePath);
    } catch (error) {
        console.error('[library] Could not update track metadata:', error);
    }
}

function stats() {
    const handle = db();
    const empty = {tracks: 0, artists: 0, plays: 0, missing: 0};
    if (!handle) return empty;
    try {
        const counts = handle.prepare(`
            SELECT COUNT(*)                                  AS tracks,
                   COUNT(DISTINCT artist)                    AS artists,
                   SUM(CASE WHEN missing = 1 THEN 1 ELSE 0 END) AS missing
            FROM tracks
        `).get();
        const plays = handle.prepare('SELECT COALESCE(SUM(playCount), 0) AS plays FROM track_stats').get();

        return {
            tracks: counts?.tracks || 0,
            artists: counts?.artists || 0,
            missing: counts?.missing || 0,
            plays: plays?.plays || 0,
        };
    } catch (error) {
        console.error('[library] Could not read stats:', error);
        return empty;
    }
}

// --- Play statistics -------------------------------------------------------------

/**
 * A play. The renderer decides what counts as one (it holds the listened-time
 * accounting); this just records the verdict.
 */
function recordPlay(filePath, listenedMs = 0) {
    const handle = db();
    if (!handle || !filePath) return;
    try {
        handle.prepare(`
            INSERT INTO track_stats (filePath, playCount, listenedMs, lastPlayedAt)
            VALUES (?, 1, ?, ?)
            ON CONFLICT(filePath) DO UPDATE SET playCount    = track_stats.playCount + 1,
                                                listenedMs   = track_stats.listenedMs + excluded.listenedMs,
                                                lastPlayedAt = excluded.lastPlayedAt
        `).run(filePath, Math.max(0, Math.round(listenedMs)), nowIso());
    } catch (error) {
        console.error('[library] Could not record play:', error);
    }
}

/** A skip. Counted separately so "most played" is not gamed by skipping. */
function recordSkip(filePath, listenedMs = 0) {
    const handle = db();
    if (!handle || !filePath) return;
    try {
        handle.prepare(`
            INSERT INTO track_stats (filePath, skipCount, listenedMs, lastPlayedAt)
            VALUES (?, 1, ?, ?)
            ON CONFLICT(filePath) DO UPDATE SET skipCount    = track_stats.skipCount + 1,
                                                listenedMs   = track_stats.listenedMs + excluded.listenedMs,
                                                lastPlayedAt = excluded.lastPlayedAt
        `).run(filePath, Math.max(0, Math.round(listenedMs)), nowIso());
    } catch (error) {
        console.error('[library] Could not record skip:', error);
    }
}

function setRating(filePath, rating) {
    const handle = db();
    if (!handle || typeof filePath !== 'string' || !filePath ||
        !Number.isInteger(rating) || rating < 0 || rating > 5) return false;
    handle.prepare(`INSERT INTO track_ratings (filePath, rating, updatedAt) VALUES (?, ?, ?)
        ON CONFLICT(filePath) DO UPDATE SET rating = excluded.rating, updatedAt = excluded.updatedAt`)
        .run(filePath, rating, nowIso());
    return true;
}

function getRating(filePath) {
    const handle = db();
    if (!handle || !filePath) return 0;
    return handle.prepare('SELECT rating FROM track_ratings WHERE filePath = ?').get(filePath)?.rating || 0;
}

function setBookPosition(filePath, seconds) {
    const handle = db();
    if (!handle || typeof filePath !== 'string' || !/\.m4b$/i.test(filePath) ||
        !Number.isFinite(seconds) || seconds < 0) return false;
    handle.prepare(`INSERT INTO book_positions (filePath, seconds, updatedAt) VALUES (?, ?, ?)
        ON CONFLICT(filePath) DO UPDATE SET seconds = excluded.seconds, updatedAt = excluded.updatedAt`)
        .run(filePath, seconds, nowIso());
    return true;
}

function getBookPosition(filePath) {
    const handle = db();
    if (!handle || typeof filePath !== 'string') return 0;
    return handle.prepare('SELECT seconds FROM book_positions WHERE filePath = ?').get(filePath)?.seconds || 0;
}

// --- Views -----------------------------------------------------------------------

/** Tracks a room host may offer to guests, including roots not opened this session. */
function roomCatalog() {
    const handle = db();
    if (!handle) return [];
    return handle.prepare(`
        SELECT filePath, basename, title, artist, album, durationSeconds
        FROM tracks WHERE missing = 0 ORDER BY artist, title, basename
    `).all();
}

const MOODS = ['', 'calm', 'energetic', 'focus', 'happy', 'melancholy'];
function setPreference(filePath, {mood, feedback} = {}) {
    const handle = db();
    if (!handle || typeof filePath !== 'string' || !filePath ||
        (mood !== undefined && !MOODS.includes(mood)) ||
        (feedback !== undefined && ![-1, 0, 1].includes(feedback))) return false;
    const old = handle.prepare('SELECT * FROM track_preferences WHERE filePath = ?').get(filePath);
    handle.prepare(`INSERT INTO track_preferences (filePath, mood, feedback, updatedAt) VALUES (?, ?, ?, ?)
        ON CONFLICT(filePath) DO UPDATE SET mood=excluded.mood, feedback=excluded.feedback, updatedAt=excluded.updatedAt`)
        .run(filePath, mood ?? old?.mood ?? '', feedback ?? old?.feedback ?? 0, nowIso());
    return true;
}

function preferences() {
    return db()?.prepare('SELECT filePath, mood, feedback, updatedAt FROM track_preferences').all() || [];
}

function learnedPreferences() {
    const rows = db().prepare(`SELECT t.artist, t.genre, p.mood, p.feedback FROM track_preferences p
        JOIN tracks t ON t.filePath = p.filePath WHERE p.feedback <> 0`).all();
    const weights = {artist: new Map(), genre: new Map(), mood: new Map()};
    for (const row of rows) for (const key of Object.keys(weights)) {
        const value = String(row[key] || '').toLocaleLowerCase();
        if (value) weights[key].set(value, (weights[key].get(value) || 0) + row.feedback);
    }
    return weights;
}

function recommendations({filePath, artist, album, genre, mood = '', liked = [], hidden = [], limit = 20} = {}) {
    const handle = db();
    if (!handle) return [];
    const likedSet = new Set(Array.isArray(liked) ? liked : []);
    const hiddenSet = new Set(Array.isArray(hidden) ? hidden : []);
    const bounded = Math.min(Math.max(1, Number(limit) || 20), 50);
    const learned = learnedPreferences();
    const rows = handle.prepare(`
        SELECT t.filePath, t.basename, t.title, t.artist, t.album, t.genre,
               COALESCE(s.playCount, 0) AS playCount,
               COALESCE(s.skipCount, 0) AS skipCount,
               COALESCE(r.rating, 0) AS rating,
               s.lastPlayedAt, COALESCE(p.mood, '') AS mood, COALESCE(p.feedback, 0) AS feedback
        FROM tracks t LEFT JOIN track_stats s ON s.filePath = t.filePath
                      LEFT JOIN track_ratings r ON r.filePath = t.filePath
                      LEFT JOIN track_preferences p ON p.filePath = t.filePath
        WHERE t.missing = 0
        ORDER BY COALESCE(s.playCount, 0) DESC, t.addedAt DESC
        LIMIT 5000
    `).all();
    const same = (a, b) => Boolean(a && b && String(a).toLocaleLowerCase() === String(b).toLocaleLowerCase());
    return rows.filter((row) => row.filePath !== filePath && !hiddenSet.has(row.filePath) && row.feedback >= 0 &&
            (!mood || row.mood === mood))
        .map((row) => {
            const byArtist = same(row.artist, artist);
            const byGenre = same(row.genre, genre);
            const byAlbum = same(row.album, album);
            const likedTrack = likedSet.has(row.filePath);
            const learnedScore = ['artist', 'genre', 'mood'].reduce((sum, key) => sum +
                Math.max(-3, Math.min(3, learned[key].get(String(row[key] || '').toLocaleLowerCase()) || 0)), 0);
            const score = (byArtist ? 7 : 0) + (byGenre ? 4 : 0) + (byAlbum ? 3 : 0) +
                (likedTrack ? 5 : 0) + row.rating * 1.5 + Math.log1p(row.playCount) * 2 - row.skipCount * 1.5 -
                (row.lastPlayedAt && Date.now() - Date.parse(row.lastPlayedAt) < 3600000 ? 4 : 0) +
                (row.playCount === 0 ? 0.5 : 0) + row.feedback * 3 + learnedScore * 2;
            const reason = mood ? `Your ${mood} music` : learnedScore > 0 ? 'Based on your discovery feedback' :
                byArtist ? `More from ${row.artist}` : byGenre ? `Similar ${row.genre} music` :
                byAlbum ? `From ${row.album}` : likedTrack ? 'You liked this' :
                row.playCount > row.skipCount ? 'Based on your listening' : 'Something new';
            return {...row, score, reason};
        })
        .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
        .slice(0, bounded);
}

function albumRecommendations({artist, album, genre, mood = '', liked = [], hidden = [], limit = 6} = {}) {
    const handle = db();
    if (!handle) return [];
    const hiddenSet = new Set(Array.isArray(hidden) ? hidden : []);
    const likedSet = new Set(Array.isArray(liked) ? liked : []);
    const learned = learnedPreferences();
    const rows = handle.prepare(`
        SELECT t.filePath, t.title, t.album, t.artist, t.genre,
               COALESCE(s.playCount, 0) AS playCount,
               COALESCE(s.skipCount, 0) AS skipCount,
               COALESCE(r.rating, 0) AS rating, COALESCE(p.feedback, 0) AS feedback, COALESCE(p.mood, '') AS mood
        FROM tracks t LEFT JOIN track_stats s ON s.filePath = t.filePath
                      LEFT JOIN track_ratings r ON r.filePath = t.filePath
                      LEFT JOIN track_preferences p ON p.filePath = t.filePath
        WHERE t.missing = 0 AND t.album IS NOT NULL AND TRIM(t.album) <> ''
        ORDER BY t.artist, t.album, t.title LIMIT 10000
    `).all();
    const groups = new Map();
    for (const row of rows) {
        if (hiddenSet.has(row.filePath) || row.feedback < 0 || (mood && row.mood !== mood)) continue;
        const key = `${row.artist || ''}\u0000${row.album}`.toLocaleLowerCase();
        if (!groups.has(key)) groups.set(key, {album: row.album, artist: row.artist,
            tracks: [], genres: new Set(), plays: 0, skips: 0, ratings: 0, liked: 0, learned: 0});
        const group = groups.get(key);
        group.tracks.push(row.filePath);
        if (row.genre) group.genres.add(row.genre.toLocaleLowerCase());
        group.plays += row.playCount;
        group.skips += row.skipCount;
        group.ratings += row.rating;
        group.learned += row.feedback * 3 + ['artist', 'genre', 'mood'].reduce((sum, key) => sum +
            Math.max(-3, Math.min(3, learned[key].get(String(row[key] || '').toLocaleLowerCase()) || 0)), 0);
        if (likedSet.has(row.filePath)) group.liked++;
    }
    const same = (left, right) => Boolean(left && right &&
        String(left).toLocaleLowerCase() === String(right).toLocaleLowerCase());
    return [...groups.values()].filter((group) => group.tracks.length >= 2 &&
        !(same(group.album, album) && same(group.artist, artist)))
        .map((group) => {
            const byArtist = same(group.artist, artist);
            const byGenre = genre && group.genres.has(String(genre).toLocaleLowerCase());
            const score = (byArtist ? 8 : 0) + (byGenre ? 5 : 0) +
                Math.min(5, group.liked * 2) + group.ratings / group.tracks.length +
                Math.log1p(group.plays) - group.skips / group.tracks.length + group.learned / group.tracks.length;
            return {album: group.album, artist: group.artist, tracks: group.tracks,
                score, reason: byArtist ? `More from ${group.artist}` :
                    byGenre ? `Similar ${genre} music` : group.liked ? 'Albums you may like' : 'From your library'};
        }).sort((a, b) => b.score - a.score || a.album.localeCompare(b.album))
        .slice(0, Math.min(Math.max(1, Number(limit) || 6), 20));
}

const VIEWS = {
    'recently-added': {
        where: 't.missing = 0',
        order: 't.addedAt DESC, t.basename',
    },
    'recently-played': {
        where: 't.missing = 0 AND s.lastPlayedAt IS NOT NULL',
        order: 's.lastPlayedAt DESC',
    },
    'most-played': {
        // Skipped tracks accumulate a lastPlayedAt but no plays, and would otherwise
        // fill this list with music the user actively avoids.
        where: 't.missing = 0 AND COALESCE(s.playCount, 0) > 0',
        order: 's.playCount DESC, s.lastPlayedAt DESC',
    },
};

/** Rows for one of the library chips. Unknown view names return nothing. */
function view(name, limit = 100) {
    const handle = db();
    const definition = VIEWS[name];
    if (!handle || !definition) return [];

    const bounded = Math.min(Math.max(1, Number(limit) || 100), VIEW_LIMIT_MAX);

    try {
        return handle.prepare(`
            SELECT t.filePath,
                   t.basename,
                   t.title,
                   t.artist,
                   t.album,
                   t.durationSeconds,
                   COALESCE(s.playCount, 0) AS playCount,
                   COALESCE(r.rating, 0) AS rating,
                   s.lastPlayedAt
            FROM tracks t
                     LEFT JOIN track_stats s ON s.filePath = t.filePath
                     LEFT JOIN track_ratings r ON r.filePath = t.filePath
            WHERE ${definition.where}
            ORDER BY ${definition.order}
            LIMIT ?
        `).all(bounded);
    } catch (error) {
        console.error(`[library] Could not read view "${name}":`, error);
        return [];
    }
}

// --- Named playlists -------------------------------------------------------------

function listPlaylists() {
    const handle = db();
    if (!handle) return [];
    return handle.prepare(`
        SELECT p.id, p.name, p.createdAt, COUNT(i.filePath) AS trackCount
        FROM playlists p LEFT JOIN playlist_items i ON i.playlistId = p.id
        GROUP BY p.id ORDER BY p.name COLLATE NOCASE
    `).all();
}

function playlistTracks(id) {
    const handle = db();
    if (!handle) return [];
    return handle.prepare(`
        SELECT i.filePath, i.position, t.basename, t.title, t.artist, t.missing
        FROM playlist_items i LEFT JOIN tracks t ON t.filePath = i.filePath
        WHERE i.playlistId = ? ORDER BY i.position
    `).all(id);
}

function createPlaylist(name, filePaths = []) {
    const handle = db();
    const trimmed = String(name || '').trim().slice(0, 80);
    if (!handle || !trimmed) return {ok: false, error: 'Enter a playlist name.'};
    try {
        const create = handle.transaction(() => {
            const result = handle.prepare('INSERT INTO playlists (name, createdAt) VALUES (?, ?)')
                .run(trimmed, nowIso());
            const add = handle.prepare('INSERT OR IGNORE INTO playlist_items (playlistId, filePath, position) VALUES (?, ?, ?)');
            let position = 0;
            for (const filePath of filePaths) {
                if (typeof filePath === 'string' && filePath) add.run(result.lastInsertRowid, filePath, position++);
            }
            return Number(result.lastInsertRowid);
        });
        return {ok: true, id: create()};
    } catch (error) {
        return {ok: false, error: /UNIQUE/i.test(error.message) ? 'A playlist with that name already exists.' : error.message};
    }
}

function addToPlaylist(id, filePath) {
    const handle = db();
    if (!handle || !filePath || !handle.prepare('SELECT id FROM playlists WHERE id = ?').get(id)) return false;
    const next = handle.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM playlist_items WHERE playlistId = ?').get(id);
    return handle.prepare('INSERT OR IGNORE INTO playlist_items (playlistId, filePath, position) VALUES (?, ?, ?)')
        .run(id, filePath, next.position).changes > 0;
}

function removeFromPlaylist(id, filePath) {
    const handle = db();
    return Boolean(handle && handle.prepare('DELETE FROM playlist_items WHERE playlistId = ? AND filePath = ?')
        .run(id, filePath).changes);
}

function deletePlaylist(id) {
    const handle = db();
    return Boolean(handle && handle.prepare('DELETE FROM playlists WHERE id = ?').run(id).changes);
}

// --- Backup and restore ----------------------------------------------------------

/**
 * A portable snapshot: roots, tracks and statistics as plain JSON.
 *
 * Not a copy of the .db file, deliberately. A SQLite file is version-locked to a
 * schema and useless to anything else; JSON can be restored into a later schema, read
 * by hand, or diffed when something looks wrong.
 */
function exportAll() {
    const handle = db();
    if (!handle) return null;
    try {
        return {
            format: 'rhythm-dock-library',
            version: 6,
            tools: require('./library-tools').extraBackup(),
            exportedAt: nowIso(),
            roots: handle.prepare('SELECT path, addedAt, lastScanAt FROM roots').all(),
            tracks: handle.prepare(`
                SELECT filePath, basename, title, artist, album, genre, durationSeconds,
                       addedAt, lastSeenAt, missing
                FROM tracks
            `).all(),
            stats: handle.prepare(`
                SELECT filePath, playCount, skipCount, listenedMs, lastPlayedAt
                FROM track_stats
            `).all(),
            ratings: handle.prepare('SELECT filePath, rating, updatedAt FROM track_ratings').all(),
            bookPositions: handle.prepare('SELECT filePath, seconds, updatedAt FROM book_positions').all(),
            preferences: preferences(),
            audioAnalysis: handle.prepare('SELECT * FROM audio_analysis').all(),
            playlists: handle.prepare('SELECT name, createdAt FROM playlists').all().map((playlist) => ({
                ...playlist,
                tracks: handle.prepare(`
                    SELECT i.filePath FROM playlist_items i JOIN playlists p ON p.id = i.playlistId
                    WHERE p.name = ? ORDER BY i.position
                `).all(playlist.name).map((item) => item.filePath),
            })),
        };
    } catch (error) {
        console.error('[library] Export failed:', error);
        return null;
    }
}

/**
 * Merges a snapshot in. Never destructive: existing rows win on conflict for track
 * metadata, and play counts are taken as the *higher* of the two rather than summed.
 * Summing would double a user's history the second time they restore the same file,
 * and there is no way to tell that apart from a genuine second listen.
 */
function importAll(payload) {
    const handle = db();
    if (!handle || !payload || payload.format !== 'rhythm-dock-library') {
        return {ok: false, error: 'That file is not a Rhythm Dock library backup.'};
    }

    try {
        let imported = 0;

        const insertRoot = handle.prepare(
            `INSERT INTO roots (path, addedAt, lastScanAt) VALUES (?, ?, ?)
             ON CONFLICT(path) DO NOTHING`
        );
        const insertTrack = handle.prepare(`
            INSERT INTO tracks (filePath, rootId, basename, title, artist, album, genre,
                                durationSeconds, addedAt, lastSeenAt, missing)
            VALUES (?, (SELECT id FROM roots WHERE ? LIKE path || '%' ORDER BY LENGTH(path) DESC LIMIT 1),
                    ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(filePath) DO UPDATE SET title  = COALESCE(tracks.title, excluded.title),
                                                artist = COALESCE(tracks.artist, excluded.artist),
                                                album  = COALESCE(tracks.album, excluded.album),
                                                genre  = COALESCE(tracks.genre, excluded.genre)
        `);
        const insertStats = handle.prepare(`
            INSERT INTO track_stats (filePath, playCount, skipCount, listenedMs, lastPlayedAt)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(filePath) DO UPDATE SET playCount    = MAX(track_stats.playCount, excluded.playCount),
                                                skipCount    = MAX(track_stats.skipCount, excluded.skipCount),
                                                listenedMs   = MAX(track_stats.listenedMs, excluded.listenedMs),
                                                lastPlayedAt = MAX(COALESCE(track_stats.lastPlayedAt, ''),
                                                                   COALESCE(excluded.lastPlayedAt, ''))
        `);
        const insertRating = handle.prepare(`INSERT INTO track_ratings (filePath, rating, updatedAt)
            VALUES (?, ?, ?) ON CONFLICT(filePath) DO NOTHING`);
        const insertBookPosition = handle.prepare(`INSERT INTO book_positions (filePath, seconds, updatedAt)
            VALUES (?, ?, ?) ON CONFLICT(filePath) DO NOTHING`);

        const apply = handle.transaction(() => {
            for (const root of payload.roots || []) {
                insertRoot.run(root.path, root.addedAt || nowIso(), root.lastScanAt || null);
            }
            for (const track of payload.tracks || []) {
                if (!track.filePath) continue;
                insertTrack.run(
                    track.filePath, track.filePath,
                    track.basename || path.basename(track.filePath),
                    track.title || null, track.artist || null, track.album || null, track.genre || null,
                    track.durationSeconds || null,
                    track.addedAt || nowIso(), track.lastSeenAt || nowIso(),
                    track.missing ? 1 : 0
                );
                imported += 1;
            }
            for (const stat of payload.stats || []) {
                if (!stat.filePath) continue;
                insertStats.run(
                    stat.filePath,
                    stat.playCount || 0,
                    stat.skipCount || 0,
                    stat.listenedMs || 0,
                    stat.lastPlayedAt || null
                );
            }
            for (const row of payload.ratings || []) {
                if (typeof row.filePath === 'string' && Number.isInteger(row.rating) &&
                    row.rating >= 0 && row.rating <= 5) {
                    insertRating.run(row.filePath, row.rating, row.updatedAt || nowIso());
                }
            }
            for (const row of payload.bookPositions || []) {
                if (typeof row.filePath === 'string' && /\.m4b$/i.test(row.filePath) &&
                    Number.isFinite(row.seconds) && row.seconds >= 0) {
                    insertBookPosition.run(row.filePath, row.seconds, row.updatedAt || nowIso());
                }
            }
            for (const row of payload.preferences || []) {
                if (typeof row.filePath !== 'string' || !MOODS.includes(row.mood) || ![-1, 0, 1].includes(row.feedback)) continue;
                handle.prepare(`INSERT OR IGNORE INTO track_preferences (filePath, mood, feedback, updatedAt)
                    VALUES (?, ?, ?, ?)`).run(row.filePath, row.mood, row.feedback, row.updatedAt || nowIso());
            }
            for (const row of payload.audioAnalysis || []) {
                if (typeof row.filePath !== 'string' || !['fileSize', 'fileMtimeMs', 'integratedLufs',
                    'truePeakDb', 'gainDb', 'targetLufs'].every((key) => Number.isFinite(row[key]))) continue;
                if (row.fileSize < 0 || row.gainDb < -24 || row.gainDb > 12) continue;
                handle.prepare(`INSERT OR IGNORE INTO audio_analysis
                    (filePath, fileSize, fileMtimeMs, integratedLufs, truePeakDb, gainDb, targetLufs, updatedAt, albumGainDb, albumFiles)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.filePath, row.fileSize, row.fileMtimeMs,
                        row.integratedLufs, row.truePeakDb, row.gainDb, row.targetLufs, row.updatedAt || nowIso(),
                        Number.isFinite(row.albumGainDb) && row.albumGainDb >= -24 && row.albumGainDb <= 12 ? row.albumGainDb : null,
                        typeof row.albumFiles === 'string' && row.albumFiles.length <= 65536 ? row.albumFiles : null);
            }
            for (const playlist of payload.playlists || []) {
                const name = String(playlist.name || '').trim().slice(0, 80);
                if (!name) continue;
                handle.prepare('INSERT OR IGNORE INTO playlists (name, createdAt) VALUES (?, ?)')
                    .run(name, playlist.createdAt || nowIso());
                const row = handle.prepare('SELECT id FROM playlists WHERE name = ? COLLATE NOCASE').get(name);
                const insert = handle.prepare('INSERT OR IGNORE INTO playlist_items (playlistId, filePath, position) VALUES (?, ?, ?)');
                let position = handle.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS value FROM playlist_items WHERE playlistId = ?')
                    .get(row.id).value;
                for (const filePath of playlist.tracks || []) {
                    if (typeof filePath === 'string' && filePath) insert.run(row.id, filePath, position++);
                }
            }
        });

        handle.transaction(() => {
            apply();
            require('./library-tools').importExtra(payload.tools);
        })();
        return {ok: true, imported};
    } catch (error) {
        console.error('[library] Import failed:', error);
        return {ok: false, error: error.message || 'Could not read that backup.'};
    }
}

module.exports = {
    listRoots,
    addRoot,
    removeRoot,
    scanSnapshot,
    syncRoot,
    recheckMissing,
    updateTrackMetadata,
    stats,
    recordPlay,
    recordSkip,
    setRating,
    getRating,
    setBookPosition,
    getBookPosition,
    view,
    roomCatalog,
    recommendations,
    setPreference,
    preferences,
    albumRecommendations,
    listPlaylists,
    playlistTracks,
    createPlaylist,
    addToPlaylist,
    removeFromPlaylist,
    deletePlaylist,
    exportAll,
    importAll,
};
