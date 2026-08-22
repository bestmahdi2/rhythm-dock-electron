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
const paths = require('./paths');

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
        backupDatabase(dbPath, `v${currentVersion}-to-v${TARGET_VERSION}`);
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

function saveLyrics(songKey, lyricsText, details = {}) {
    if (!db || !songKey || !lyricsText) return;
    try {
        db.prepare(
            `INSERT INTO lyrics (songKey, lyricsText, lastUpdated, source, isSynced, artist, title)
             VALUES (?, ?, datetime('now'), ?, ?, ?, ?)
             ON CONFLICT(songKey) DO UPDATE SET lyricsText  = excluded.lyricsText,
                                                lastUpdated = excluded.lastUpdated,
                                                source      = excluded.source,
                                                isSynced    = excluded.isSynced,
                                                artist      = COALESCE(excluded.artist, lyrics.artist),
                                                title       = COALESCE(excluded.title, lyrics.title)`
        ).run(
            songKey,
            lyricsText,
            details.source || 'unknown',
            details.isSynced ? 1 : 0,
            details.artist || null,
            details.title || null
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
    saveLyrics,
    getTranslation,
    saveTranslation,
    backupDatabase,
    TARGET_VERSION,
};
