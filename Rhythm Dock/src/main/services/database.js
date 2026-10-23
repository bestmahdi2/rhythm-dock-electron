'use strict';

/**
 * Lyrics database.
 *
 * Design rules, all of which exist because the previous version lost data on update:
 *
 *   - The file is NEVER deleted or recreated by this module. Schema changes are applied
 *     as forward-only migrations keyed off SQLite's `user_version` pragma.
 *   - A copy is taken before any migration runs, so a failed upgrade is recoverable.
 *   - If the database on disk is unreadable (truncated, wrong format, locked by a
 *     crashed process) we move it aside with a timestamp rather than dropping it.
 *   - Legacy database files from older install layouts are migrated in, once.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const paths = require('../core/paths');

const MAX_BACKUPS = 10;

/**
 * Forward-only migrations. Index N upgrades `user_version` from N to N+1.
 * Append to this array; never edit or reorder an existing entry.
 */
const MIGRATIONS = [
    // 0 -> 1: the original schema, as shipped through v1.3.7.
    (db) => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS lyrics
            (
                songKey     TEXT PRIMARY KEY,
                lyricsText  TEXT NOT NULL,
                lastUpdated TEXT NOT NULL
            );
        `);
    },

    // 1 -> 2: provenance + lookup columns. Additive only, so existing rows survive.
    (db) => {
        const columns = db.prepare(`PRAGMA table_info(lyrics)`).all().map((c) => c.name);
        const addColumn = (name, definition) => {
            if (!columns.includes(name)) {
                db.exec(`ALTER TABLE lyrics ADD COLUMN ${name} ${definition}`);
            }
        };
        addColumn('source', `TEXT NOT NULL DEFAULT 'unknown'`);
        addColumn('isSynced', `INTEGER NOT NULL DEFAULT 0`);
        addColumn('artist', `TEXT`);
        addColumn('title', `TEXT`);

        db.exec(`CREATE INDEX IF NOT EXISTS idx_lyrics_artist_title ON lyrics (artist, title);`);
        db.exec(`
            CREATE TABLE IF NOT EXISTS meta
            (
                key   TEXT PRIMARY KEY,
                value TEXT
            );
        `);
    },

    // 2 -> 3: translation cache (request #15). Keyed by song + target language, so the
    // same lyric can hold a Persian and a French translation side by side.
    (db) => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS translations
            (
                songKey        TEXT NOT NULL,
                targetLanguage TEXT NOT NULL,
                translatedText TEXT NOT NULL,
                provider       TEXT,
                lastUpdated    TEXT NOT NULL,
                PRIMARY KEY (songKey, targetLanguage)
            );
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_translations_song ON translations (songKey);`);
    },

    // 3 -> 4: Phase 9. Per-track lyric preferences (offset, resolved provider, the
    // sidecar we last wrote) and a flag for word-level timing on the cached lyric.
    //
    // Deliberately a separate table rather than more columns on `lyrics`: an offset is
    // meaningful for a track whose lyrics came from an embedded tag and were therefore
    // never cached here, and a preference should survive a refetch of the lyric.
    (db) => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS lyrics_prefs
            (
                songKey     TEXT PRIMARY KEY,
                offsetMs    INTEGER NOT NULL DEFAULT 0,
                source      TEXT,
                sidecarPath TEXT,
                lastUpdated TEXT NOT NULL
            );
        `);

        const columns = db.prepare(`PRAGMA table_info(lyrics)`).all().map((c) => c.name);
        if (!columns.includes('hasWordTiming')) {
            db.exec(`ALTER TABLE lyrics ADD COLUMN hasWordTiming INTEGER NOT NULL DEFAULT 0`);
        }
    },

    // 4 -> 5: the persistent library (Phase 7). Watched folders, the tracks found in
    // them, and per-track play statistics.
    //
    // `track_stats` is a separate table from `tracks` on purpose. A rescan rewrites
    // rows in `tracks`; play counts must not be collateral damage of that, and a user
    // who removes a folder and adds it back expects their history intact. The two are
    // joined on filePath rather than related by foreign key for the same reason -
    // statistics outlive the track row.
    (db) => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS roots
            (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                path       TEXT NOT NULL UNIQUE,
                addedAt    TEXT NOT NULL,
                lastScanAt TEXT
            );
        `);

        db.exec(`
            CREATE TABLE IF NOT EXISTS tracks
            (
                filePath        TEXT PRIMARY KEY,
                rootId          INTEGER,
                basename        TEXT NOT NULL,
                title           TEXT,
                artist          TEXT,
                album           TEXT,
                durationSeconds REAL,
                addedAt         TEXT NOT NULL,
                lastSeenAt      TEXT NOT NULL,
                missing         INTEGER NOT NULL DEFAULT 0
            );
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tracks_root ON tracks (rootId);`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tracks_added ON tracks (addedAt);`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks (artist);`);

        db.exec(`
            CREATE TABLE IF NOT EXISTS track_stats
            (
                filePath     TEXT PRIMARY KEY,
                playCount    INTEGER NOT NULL DEFAULT 0,
                skipCount    INTEGER NOT NULL DEFAULT 0,
                listenedMs   INTEGER NOT NULL DEFAULT 0,
                lastPlayedAt TEXT
            );
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_stats_played ON track_stats (lastPlayedAt);`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_stats_count ON track_stats (playCount);`);
    },

    // 5 -> 6: named playlists are independent of the live playback queue.
    (db) => {
        db.exec(`
            CREATE TABLE IF NOT EXISTS playlists (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                createdAt TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS playlist_items (
                playlistId INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
                filePath TEXT NOT NULL,
                position INTEGER NOT NULL,
                PRIMARY KEY (playlistId, filePath)
            );
            CREATE INDEX IF NOT EXISTS idx_playlist_items_order
                ON playlist_items (playlistId, position);
        `);
    },

    // 6 -> 7: keep genre tags for local recommendations. Existing rows remain valid.
    (db) => {
        db.exec('ALTER TABLE tracks ADD COLUMN genre TEXT');
        db.exec('CREATE INDEX IF NOT EXISTS idx_tracks_genre ON tracks (genre)');
    },

    // 7 -> 8: fingerprints let a rescan skip unchanged tag reads.
    (db) => {
        db.exec('ALTER TABLE tracks ADD COLUMN fileMtimeMs REAL');
        db.exec('ALTER TABLE tracks ADD COLUMN fileSize INTEGER');
    },

    // 8 -> 9: ratings outlive a removed library root, like play history.
    (db) => {
        db.exec(`CREATE TABLE track_ratings (
            filePath TEXT PRIMARY KEY,
            rating INTEGER NOT NULL CHECK (rating BETWEEN 0 AND 5),
            updatedAt TEXT NOT NULL
        )`);
    },

    // 9 -> 10: audiobook resume positions survive playlist and app changes.
    (db) => {
        db.exec(`CREATE TABLE book_positions (
            filePath TEXT PRIMARY KEY,
            seconds REAL NOT NULL DEFAULT 0,
            updatedAt TEXT NOT NULL
        )`);
    },
    // 10 -> 11: measured loudness and explicit discovery preferences survive rescans.
    (db) => {
        db.exec(`CREATE TABLE audio_analysis (
            filePath TEXT PRIMARY KEY, fileSize INTEGER NOT NULL, fileMtimeMs REAL NOT NULL,
            integratedLufs REAL NOT NULL, truePeakDb REAL NOT NULL, gainDb REAL NOT NULL,
            targetLufs REAL NOT NULL, updatedAt TEXT NOT NULL
        );
        CREATE TABLE track_preferences (
            filePath TEXT PRIMARY KEY, mood TEXT NOT NULL DEFAULT '',
            feedback INTEGER NOT NULL DEFAULT 0 CHECK (feedback BETWEEN -1 AND 1),
            updatedAt TEXT NOT NULL
        );`);
    },
    // 11 -> 12: album levelling keeps relative dynamics between its tracks.
    (db) => {
        db.exec('ALTER TABLE audio_analysis ADD COLUMN albumGainDb REAL');
        db.exec('ALTER TABLE audio_analysis ADD COLUMN albumFiles TEXT');
    },
    // 12 -> 13: later-roadmap data is additive and independent of scanned roots.
    (db) => {
        db.exec(`CREATE TABLE smart_playlists (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            rules TEXT NOT NULL, createdAt TEXT NOT NULL);
        CREATE TABLE play_history (id INTEGER PRIMARY KEY, filePath TEXT NOT NULL, listenedMs INTEGER NOT NULL,
            outcome TEXT NOT NULL, playedAt TEXT NOT NULL);
        CREATE INDEX idx_history_date ON play_history(playedAt);
        CREATE TABLE bookmarks (id INTEGER PRIMARY KEY, filePath TEXT NOT NULL, seconds REAL NOT NULL,
            label TEXT NOT NULL, UNIQUE(filePath, seconds));
        CREATE TABLE waveform_cache (filePath TEXT PRIMARY KEY, fileSize INTEGER NOT NULL,
            fileMtimeMs REAL NOT NULL, peaks TEXT NOT NULL, duration REAL NOT NULL);
        CREATE TABLE delivery_jobs (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, payload TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0, nextAttempt INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL);`);
    },
];

const TARGET_VERSION = MIGRATIONS.length;

let db = null;

function timestampSuffix() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Copies the database (and its WAL sidecars) into the backup directory, then prunes
 * old backups. Returns the backup path, or null if there was nothing to back up.
 */
function backupDatabase(dbPath, reason) {
    if (!fs.existsSync(dbPath)) return null;

    const backupPath = path.join(
        paths.getBackupDir(),
        `lyrics-${reason}-${timestampSuffix()}.db`
    );

    try {
        fs.copyFileSync(dbPath, backupPath);
        for (const sidecar of ['-wal', '-shm']) {
            if (fs.existsSync(dbPath + sidecar)) {
                fs.copyFileSync(dbPath + sidecar, backupPath + sidecar);
            }
        }
        pruneBackups();
        return backupPath;
    } catch (error) {
        console.error('[db] Backup failed:', error);
        return null;
    }
}

function pruneBackups() {
    try {
        const dir = paths.getBackupDir();
        const backups = fs
            .readdirSync(dir)
            .filter((name) => name.startsWith('lyrics-') && name.endsWith('.db'))
            .map((name) => ({name, mtime: fs.statSync(path.join(dir, name)).mtimeMs}))
            .sort((a, b) => b.mtime - a.mtime);

        for (const stale of backups.slice(MAX_BACKUPS)) {
            for (const sidecar of ['', '-wal', '-shm']) {
                const target = path.join(dir, stale.name + sidecar);
                if (fs.existsSync(target)) fs.unlinkSync(target);
            }
        }
    } catch (error) {
        console.error('[db] Could not prune backups:', error);
    }
}

/**
 * One-shot import of a database from a previous install layout. Only runs when the
 * new location has no database at all, so it can never clobber current data.
 */
function migrateLegacyDatabase(targetPath) {
    if (fs.existsSync(targetPath)) return false;

    for (const legacyPath of paths.getLegacyDatabasePaths()) {
        try {
            if (!fs.existsSync(legacyPath)) continue;
            if (path.resolve(legacyPath) === path.resolve(targetPath)) continue;
            if (fs.statSync(legacyPath).size === 0) continue;

            // Copy rather than move: if anything goes wrong the original is untouched.
            fs.copyFileSync(legacyPath, targetPath);
            for (const sidecar of ['-wal', '-shm']) {
                if (fs.existsSync(legacyPath + sidecar)) {
                    fs.copyFileSync(legacyPath + sidecar, targetPath + sidecar);
                }
            }
            console.log(`[db] Migrated legacy database from ${legacyPath}`);
            return true;
        } catch (error) {
            console.error(`[db] Could not migrate legacy database at ${legacyPath}:`, error);
        }
    }
    return false;
}

/**
 * One-shot import of a legacy electron-store config file.
 */
function migrateLegacyConfig() {
    const targetPath = path.join(paths.getConfigDir(), 'config.json');
    if (fs.existsSync(targetPath)) return false;

    for (const legacyPath of paths.getLegacyConfigPaths()) {
        try {
            if (!fs.existsSync(legacyPath)) continue;
            if (path.resolve(legacyPath) === path.resolve(targetPath)) continue;
            fs.copyFileSync(legacyPath, targetPath);
            console.log(`[db] Migrated legacy settings from ${legacyPath}`);
            return true;
        } catch (error) {
            console.error(`[db] Could not migrate legacy settings at ${legacyPath}:`, error);
        }
    }
    return false;
}

function openDatabase(dbPath) {
    let handle = null;
    try {
        handle = new Database(dbPath);
        // better-sqlite3 opens lazily: the constructor succeeds even for a file that is
        // not a database at all, and the failure only surfaces on first use. So probe it
        // here, while we are still in a position to recover cleanly.
        handle.pragma('user_version');
        return handle;
    } catch (error) {
        if (handle) {
            try {
                handle.close();
            } catch (_) {
                /* already unusable */
            }
        }
        // Corrupt or otherwise unopenable. Preserve it, then start fresh — losing the
        // lyrics cache is survivable, silently deleting the user's file is not.
        console.error('[db] Failed to open database, quarantining it:', error);
        const quarantinePath = path.join(
            paths.getBackupDir(),
            `lyrics-corrupt-${timestampSuffix()}.db`
        );
        try {
            fs.renameSync(dbPath, quarantinePath);
            for (const sidecar of ['-wal', '-shm']) {
                if (fs.existsSync(dbPath + sidecar)) {
                    fs.renameSync(dbPath + sidecar, quarantinePath + sidecar);
                }
            }
            console.error(`[db] Quarantined to ${quarantinePath}`);
        } catch (renameError) {
            console.error('[db] Quarantine failed:', renameError);
        }
        return new Database(dbPath);
    }
}

function runMigrations(handle, dbPath) {
    const currentVersion = handle.pragma('user_version', {simple: true});

    if (currentVersion > TARGET_VERSION) {
        // A newer build of the app has already touched this file. Do not downgrade it.
        console.warn(
            `[db] Database schema v${currentVersion} is newer than this build expects ` +
            `(v${TARGET_VERSION}). Leaving it alone.`
        );
        return;
    }

    if (currentVersion === TARGET_VERSION) return;

    if (currentVersion > 0) {
        const backup=backupDatabase(dbPath, `v${currentVersion}-to-v${TARGET_VERSION}`);
        if(!backup)throw new Error('Database upgrade stopped because a safety backup could not be created. Your existing database has not been migrated.');
    }

    const applyAll = handle.transaction(() => {
        for (let version = currentVersion; version < TARGET_VERSION; version++) {
            console.log(`[db] Applying migration ${version} -> ${version + 1}`);
            MIGRATIONS[version](handle);
        }
        handle.pragma(`user_version = ${TARGET_VERSION}`);
    });

    applyAll();
}

/**
 * Opens (never recreates) the database, migrating legacy locations and schemas.
 */
function initialize() {
    const dbPath = paths.getDatabasePath();

    migrateLegacyDatabase(dbPath);
    migrateLegacyConfig();

    db = openDatabase(dbPath);

    // WAL survives an unclean shutdown far better than the default rollback journal,
    // which matters when the app is killed by an installer mid-write.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');

    runMigrations(db, dbPath);

    console.log(`[db] Ready at ${dbPath} (schema v${TARGET_VERSION})`);
    return db;
}

function getLyrics(songKey) {
    if (!db || !songKey) return null;
    try {
        const row = db.prepare('SELECT lyricsText FROM lyrics WHERE songKey = ?').get(songKey);
        return row ? row.lyricsText : null;
    } catch (error) {
        console.error('[db] Failed to read lyrics:', error);
        return null;
    }
}

/** The full cached row, including provenance. Used by the Phase 9 provider chain. */
function getLyricsRow(songKey) {
    if (!db || !songKey) return null;
    try {
        return db
            .prepare('SELECT lyricsText, source, isSynced, hasWordTiming FROM lyrics WHERE songKey = ?')
            .get(songKey) || null;
    } catch (error) {
        console.error('[db] Failed to read lyrics row:', error);
        return null;
    }
}

function saveLyrics(songKey, lyricsText, details = {}) {
    if (!db || !songKey || !lyricsText) return;
    try {
        db.prepare(
            `INSERT INTO lyrics (songKey, lyricsText, lastUpdated, source, isSynced, artist, title,
                                 hasWordTiming)
             VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?)
             ON CONFLICT(songKey) DO UPDATE SET lyricsText    = excluded.lyricsText,
                                                lastUpdated   = excluded.lastUpdated,
                                                source        = excluded.source,
                                                isSynced      = excluded.isSynced,
                                                hasWordTiming = excluded.hasWordTiming,
                                                artist        = COALESCE(excluded.artist, lyrics.artist),
                                                title         = COALESCE(excluded.title, lyrics.title)`
        ).run(
            songKey,
            lyricsText,
            details.source || 'unknown',
            details.isSynced ? 1 : 0,
            details.artist || null,
            details.title || null,
            details.hasWordTiming ? 1 : 0
        );
    } catch (error) {
        console.error('[db] Failed to save lyrics:', error);
    }
}

// --- Translation cache (request #15) --------------------------------------------

function getTranslation(songKey, targetLanguage) {
    if (!db || !songKey || !targetLanguage) return null;
    try {
        const row = db
            .prepare('SELECT translatedText FROM translations WHERE songKey = ? AND targetLanguage = ?')
            .get(songKey, targetLanguage);
        return row ? row.translatedText : null;
    } catch (error) {
        console.error('[db] Failed to read translation:', error);
        return null;
    }
}

function saveTranslation(songKey, targetLanguage, translatedText, provider = 'unknown') {
    if (!db || !songKey || !targetLanguage || !translatedText) return;
    try {
        db.prepare(
            `INSERT INTO translations (songKey, targetLanguage, translatedText, provider, lastUpdated)
             VALUES (?, ?, ?, ?, datetime('now'))
             ON CONFLICT(songKey, targetLanguage) DO UPDATE SET translatedText = excluded.translatedText,
                                                                provider       = excluded.provider,
                                                                lastUpdated    = excluded.lastUpdated`
        ).run(songKey, targetLanguage, translatedText, provider);
    } catch (error) {
        console.error('[db] Failed to save translation:', error);
    }
}

// --- Per-track lyric preferences (Phase 9) --------------------------------------

/**
 * Returns `{offsetMs, source, sidecarPath}` for a track, or null.
 *
 * The offset control used to be session-only, which meant re-nudging the same badly
 * timed lyric on every listen.
 */
function getLyricsPrefs(songKey) {
    if (!db || !songKey) return null;
    try {
        return db
            .prepare('SELECT offsetMs, source, sidecarPath FROM lyrics_prefs WHERE songKey = ?')
            .get(songKey) || null;
    } catch (error) {
        console.error('[db] Failed to read lyric preferences:', error);
        return null;
    }
}

/** Upserts one or more preferences. Unspecified fields keep their stored value. */
function saveLyricsPrefs(songKey, prefs = {}) {
    if (!db || !songKey) return;
    try {
        db.prepare(
            `INSERT INTO lyrics_prefs (songKey, offsetMs, source, sidecarPath, lastUpdated)
             VALUES (?, ?, ?, ?, datetime('now'))
             ON CONFLICT(songKey) DO UPDATE SET offsetMs    = COALESCE(excluded.offsetMs, lyrics_prefs.offsetMs),
                                                source      = COALESCE(excluded.source, lyrics_prefs.source),
                                                sidecarPath = COALESCE(excluded.sidecarPath, lyrics_prefs.sidecarPath),
                                                lastUpdated = excluded.lastUpdated`
        ).run(
            songKey,
            Number.isFinite(prefs.offsetMs) ? Math.round(prefs.offsetMs) : null,
            prefs.source || null,
            prefs.sidecarPath || null
        );
    } catch (error) {
        console.error('[db] Failed to save lyric preferences:', error);
    }
}

/**
 * Drops every cached translation for a track. Called whenever its lyrics change:
 * a translation is stored as a line-for-line array, so a lyric with a different
 * line count would render against the wrong lines.
 */
function clearTranslations(songKey) {
    if (!db || !songKey) return;
    try {
        db.prepare('DELETE FROM translations WHERE songKey = ?').run(songKey);
    } catch (error) {
        console.error('[db] Failed to clear translations:', error);
    }
}

/** Handle for the library store, which owns its own statements. */
function handle() {
    return db;
}

/** Flushes the WAL back into the main file so the DB is a single clean artifact. */
function close() {
    if (!db) return;
    try {
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.close();
    } catch (error) {
        console.error('[db] Error closing database:', error);
    } finally {
        db = null;
    }
}

module.exports = {
    initialize,
    close,
    getLyrics,
    getLyricsRow,
    saveLyrics,
    getLyricsPrefs,
    saveLyricsPrefs,
    clearTranslations,
    handle,
    getTranslation,
    saveTranslation,
    backupDatabase,
    TARGET_VERSION,
};
