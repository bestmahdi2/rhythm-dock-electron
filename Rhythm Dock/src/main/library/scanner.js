'use strict';

/**
 * Recursive audio file scanner (request #8).
 *
 * The previous implementation was a single `readdir` — it saw only the top level of a
 * folder, so a normally-organised library (Artist/Album/track.mp3) appeared empty.
 *
 * Walking a real music library naively is a good way to hang the app, so this scanner:
 *
 *   - limits recursion depth,
 *   - caps how many directories are read concurrently (unbounded Promise.all over a
 *     large tree exhausts the file descriptor table),
 *   - tracks visited inodes so a symlink pointing at an ancestor cannot loop forever,
 *   - stops at a file cap so an accidental scan of `/` terminates,
 *   - skips the usual noise directories,
 *   - reports progress, because a big scan takes long enough to need feedback.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_OPTIONS = {
    maxDepth: 12,
    maxFiles: 50000,
    concurrency: 8,
    followSymlinks: false,
};

// Directories that never contain a user's music but are expensive to walk.
const SKIP_DIRECTORIES = new Set([
    'node_modules', '.git', '.svn', '.hg', '$RECYCLE.BIN', 'System Volume Information',
    '.Trash', '.Trashes', 'Trash', 'proc', 'sys', 'dev', '.cache', 'AppData',
    'Windows', 'Program Files', 'Program Files (x86)', '.local', 'Library',
]);

// A folder containing this file is skipped, mirroring the Android convention.
const SKIP_MARKER_FILES = ['.nomedia', '.noscan'];

/**
 * Walks `rootPath` and returns every supported audio file beneath it.
 *
 * @param {string} rootPath
 * @param {string[]} extensions       Lowercase, dot-prefixed (['.mp3', ...]).
 * @param {object}  [options]
 * @param {function} [options.onProgress]  Called with {scanned, found, current}.
 */
async function scanDirectory(rootPath, extensions, options = {}) {
    const config = {...DEFAULT_OPTIONS, ...options};
    const allowed = new Set(extensions.map((e) => e.toLowerCase()));

    const found = [];
    // Keyed by `${dev}:${ino}` — the only reliable cross-platform identity for a
    // directory. Comparing resolved paths misses hardlinked and bind-mounted loops.
    const visited = new Set();
    let scannedDirs = 0;
    let truncated = false;
    let incomplete = false;

    /** Reads one directory, returning its audio files and its subdirectories. */
    async function readDirectory(dirPath, depth) {
        if (config.shouldCancel?.() || depth > config.maxDepth || found.length >= config.maxFiles) return [];

        let entries;
        try {
            entries = await fs.promises.readdir(dirPath, {withFileTypes: true});
        } catch (error) {
            incomplete = true;
            // Permission denied, or the directory vanished mid-scan. Neither is fatal.
            if (error.code !== 'EACCES' && error.code !== 'EPERM' && error.code !== 'ENOENT') {
                console.error(`[scan] Cannot read ${dirPath}:`, error.message);
            }
            return [];
        }

        // Honour opt-out markers before doing any real work in here.
        if (entries.some((entry) => entry.isFile() && SKIP_MARKER_FILES.includes(entry.name))) {
            return [];
        }

        scannedDirs++;
        const subdirectories = [];

        for (const entry of entries) {
            if (config.shouldCancel?.()) break;
            if (found.length >= config.maxFiles) {
                truncated = true;
                break;
            }

            const fullPath = path.join(dirPath, entry.name);

            if (entry.isDirectory()) {
                if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue;
                subdirectories.push(fullPath);
            } else if (entry.isFile()) {
                if (allowed.has(path.extname(entry.name).toLowerCase())) {
                    found.push(fullPath);
                }
            } else if (entry.isSymbolicLink() && config.followSymlinks) {
                try {
                    const stats = await fs.promises.stat(fullPath); // resolves the link
                    if (stats.isDirectory()) {
                        subdirectories.push(fullPath);
                    } else if (stats.isFile() && allowed.has(path.extname(entry.name).toLowerCase())) {
                        found.push(fullPath);
                    }
                } catch (_) {
                    // Broken symlink. Ignore it.
                }
            }
        }

        if (config.onProgress) {
            config.onProgress({scanned: scannedDirs, found: found.length, current: dirPath});
        }

        return subdirectories;
    }

    /** Has this directory already been walked (directly or via a link)? */
    async function claimDirectory(dirPath) {
        try {
            const stats = await fs.promises.stat(dirPath);
            const key = `${stats.dev}:${stats.ino}`;
            if (visited.has(key)) return false;
            visited.add(key);
            return true;
        } catch (_) {
            incomplete = true;
            return false;
        }
    }

    // Breadth-first, level by level, with a bounded number of readdir calls in flight.
    // Recursing depth-first with Promise.all would fan out to thousands of concurrent
    // descriptors on a large library.
    let currentLevel = (await claimDirectory(rootPath)) ? [rootPath] : [];
    let depth = 0;

    while (currentLevel.length > 0 && depth <= config.maxDepth && found.length < config.maxFiles && !config.shouldCancel?.()) {
        const nextLevel = [];

        for (let i = 0; i < currentLevel.length; i += config.concurrency) {
            if (config.shouldCancel?.()) break;
            const batch = currentLevel.slice(i, i + config.concurrency);
            const results = await Promise.all(batch.map((dir) => readDirectory(dir, depth)));

            for (const subdirectories of results) {
                for (const subdirectory of subdirectories) {
                    if (await claimDirectory(subdirectory)) nextLevel.push(subdirectory);
                }
            }
        }

        currentLevel = nextLevel;
        depth++;
    }

    if (found.length >= config.maxFiles) truncated = true;

    // Natural sort, so "track2" precedes "track10" instead of following it.
    found.sort((a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'}));

    return {files: found, scannedDirectories: scannedDirs, truncated, incomplete,
        cancelled: Boolean(config.shouldCancel?.())};
}

/**
 * Resolves a mixed list of dropped/selected paths into audio files.
 * Directories are scanned recursively; files are filtered by extension.
 */
async function resolvePaths(inputPaths, extensions, options = {}) {
    const allowed = new Set(extensions.map((e) => e.toLowerCase()));
    const results = [];
    let truncated = false;

    for (const inputPath of inputPaths) {
        try {
            const stats = await fs.promises.stat(inputPath);
            if (stats.isDirectory()) {
                const scan = await scanDirectory(inputPath, extensions, options);
                results.push(...scan.files);
                truncated = truncated || scan.truncated;
            } else if (stats.isFile() && allowed.has(path.extname(inputPath).toLowerCase())) {
                results.push(inputPath);
            }
        } catch (error) {
            console.error(`[scan] Cannot process ${inputPath}:`, error.message);
        }
    }

    // A folder and a file inside it can both be dropped at once; de-duplicate.
    return {files: [...new Set(results)], truncated};
}

module.exports = {
    scanDirectory,
    resolvePaths,
    SKIP_DIRECTORIES,
    DEFAULT_OPTIONS,
};
