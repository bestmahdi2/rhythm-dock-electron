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
function syncRoot(rootId, files = []) {
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
            INSERT INTO tracks (filePath, rootId, basename, title, artist, album,
                                durationSeconds, addedAt, lastSeenAt, missing)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(filePath) DO UPDATE SET rootId     = excluded.rootId,
                                                basename   = excluded.basename,
                                                -- COALESCE: a scan carries filename-derived
                                                -- guesses, and must not overwrite better
                                                -- values already read from real tags.
                                                title      = COALESCE(excluded.title, tracks.title),
                                                artist     = COALESCE(excluded.artist, tracks.artist),
                                                album      = COALESCE(excluded.album, tracks.album),
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
                    (typeof file === 'object' && file.durationSeconds) || null,
                    timestamp,
                    timestamp
                );
            }

            // Whatever is left in `previous` was not seen this time.
            const markMissing = handle.prepare('UPDATE tracks SET missing = 1 WHERE filePath = ?');
            for (const [filePath, wasMissing] of previous) {
                markMissing.run(filePath);
                if (!wasMissing) result.missing += 1;
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
function updateTrackMetadata(filePath, {title, artist, album, durationSeconds} = {}) {
    const handle = db();
    if (!handle || !filePath) return;
    try {
        handle.prepare(`
            UPDATE tracks
            SET title           = COALESCE(?, title),
                artist          = COALESCE(?, artist),
                album           = COALESCE(?, album),
                durationSeconds = COALESCE(?, durationSeconds)
            WHERE filePath = ?
        `).run(title || null, artist || null, album || null, durationSeconds || null, filePath);
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

// --- Views -----------------------------------------------------------------------

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
                   s.lastPlayedAt
            FROM tracks t
                     LEFT JOIN track_stats s ON s.filePath = t.filePath
            WHERE ${definition.where}
            ORDER BY ${definition.order}
            LIMIT ?
        `).all(bounded);
    } catch (error) {
        console.error(`[library] Could not read view "${name}":`, error);
        return [];
    }
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
            version: 1,
            exportedAt: nowIso(),
            roots: handle.prepare('SELECT path, addedAt, lastScanAt FROM roots').all(),
            tracks: handle.prepare(`
                SELECT filePath, basename, title, artist, album, durationSeconds,
                       addedAt, lastSeenAt, missing
                FROM tracks
            `).all(),
            stats: handle.prepare(`
                SELECT filePath, playCount, skipCount, listenedMs, lastPlayedAt
                FROM track_stats
            `).all(),
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
            INSERT INTO tracks (filePath, rootId, basename, title, artist, album,
                                durationSeconds, addedAt, lastSeenAt, missing)
            VALUES (?, (SELECT id FROM roots WHERE ? LIKE path || '%' ORDER BY LENGTH(path) DESC LIMIT 1),
                    ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(filePath) DO UPDATE SET title  = COALESCE(tracks.title, excluded.title),
                                                artist = COALESCE(tracks.artist, excluded.artist),
                                                album  = COALESCE(tracks.album, excluded.album)
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

        const apply = handle.transaction(() => {
            for (const root of payload.roots || []) {
                insertRoot.run(root.path, root.addedAt || nowIso(), root.lastScanAt || null);
            }
            for (const track of payload.tracks || []) {
                if (!track.filePath) continue;
                insertTrack.run(
                    track.filePath, track.filePath,
                    track.basename || path.basename(track.filePath),
                    track.title || null, track.artist || null, track.album || null,
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
        });

        apply();
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
    syncRoot,
    recheckMissing,
    updateTrackMetadata,
    stats,
    recordPlay,
    recordSkip,
    view,
    exportAll,
    importAll,
};
