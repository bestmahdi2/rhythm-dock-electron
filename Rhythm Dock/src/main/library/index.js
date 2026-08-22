'use strict';

/**
 * In-memory library index (requests #16 and #17).
 *
 * Holds one entry per known track, plus an artist -> tracks map, and supports the
 * "search for an artist and play everything by them" flow. Deliberately in-memory:
 * a library of tens of thousands of tracks is only a few MB of strings, and keeping it
 * out of SQLite means a rescan cannot corrupt anything the user cares about.
 */

const path = require('path');
const metadata = require('./metadata');

/** Foldable comparison key: case-insensitive, punctuation- and accent-insensitive. */
function foldKey(value) {
    return String(value || '')
        .normalize('NFD')
        // Strip combining marks so "Beyoncé" and "Beyonce" collide.
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\u0600-\u06ff\u0400-\u04ff]+/g, ' ')
        .trim();
}

/**
 * Subsequence match: do all characters of `needle` appear in `haystack`, in order?
 * This is what makes "dftpnk" find "Daft Punk".
 */
function isSubsequence(needle, haystack) {
    let index = 0;
    for (const char of haystack) {
        if (char === needle[index]) index++;
        if (index === needle.length) return true;
    }
    return index === needle.length;
}

/**
 * Scores how well `query` matches `candidate`. 0 means no match.
 * Ordered so that exact > prefix > word-prefix > substring > subsequence.
 */
function scoreMatch(query, candidate) {
    if (!query) return 0;
    const target = foldKey(candidate);
    if (!target) return 0;

    if (target === query) return 1000;
    if (target.startsWith(query)) return 800 - (target.length - query.length);

    // Prefix of any word: "punk" matches "Daft Punk".
    const words = target.split(' ');
    if (words.some((word) => word.startsWith(query))) return 600 - (target.length - query.length);

    const index = target.indexOf(query);
    if (index > -1) return 400 - index;

    const compact = query.replace(/\s+/g, '');
    if (compact.length >= 3 && isSubsequence(compact, target.replace(/\s+/g, ''))) {
        return 150;
    }

    return 0;
}

class LibraryIndex {
    constructor() {
        /** @type {Map<string, object>} filePath -> track */
        this.tracks = new Map();
        /** @type {Map<string, {name: string, paths: Set<string>}>} artistKey -> bucket */
        this.artists = new Map();
    }

    get size() {
        return this.tracks.size;
    }

    clear() {
        this.tracks.clear();
        this.artists.clear();
    }

    /**
     * Adds or replaces one track.
     * @param {string} filePath
     * @param {object} parsed  Output of metadata.parseTrackName().
     */
    add(filePath, parsed) {
        const track = {
            filePath,
            basename: path.basename(filePath),
            directory: path.dirname(filePath),
            artist: parsed.artist || 'Unknown Artist',
            title: parsed.title || path.basename(filePath),
            album: parsed.album || null,
            confidence: parsed.confidence ?? 0,
            source: parsed.source || 'unknown',
        };

        // Replacing an existing entry must not leave the old artist buckets pointing at it.
        if (this.tracks.has(filePath)) this.remove(filePath);

        this.tracks.set(filePath, track);

        // Index under each individual performer, so a track credited to
        // "Calvin Harris feat. Rihanna" is findable under either name.
        for (const name of metadata.splitArtists(track.artist)) {
            const key = foldKey(name);
            if (!key) continue;
            if (!this.artists.has(key)) {
                this.artists.set(key, {name, paths: new Set()});
            }
            this.artists.get(key).paths.add(filePath);
        }

        return track;
    }

    remove(filePath) {
        const track = this.tracks.get(filePath);
        if (!track) return false;

        for (const name of metadata.splitArtists(track.artist)) {
            const key = foldKey(name);
            const bucket = this.artists.get(key);
            if (!bucket) continue;
            bucket.paths.delete(filePath);
            if (bucket.paths.size === 0) this.artists.delete(key);
        }

        this.tracks.delete(filePath);
        return true;
    }

    get(filePath) {
        return this.tracks.get(filePath) || null;
    }

    /**
     * Ingests a batch of scanned files.
     * Sibling counts are computed per directory, because the "which side repeats"
     * signal is only meaningful within one folder.
     */
    ingest(filePaths, tagLookup = () => ({})) {
        const byDirectory = new Map();
        for (const filePath of filePaths) {
            const directory = path.dirname(filePath);
            if (!byDirectory.has(directory)) byDirectory.set(directory, []);
            byDirectory.get(directory).push(filePath);
        }

        const added = [];
        for (const [directory, files] of byDirectory) {
            const siblingCounts = metadata.buildSiblingCounts(files);
            const folderName = path.basename(directory);

            for (const filePath of files) {
                const parsed = metadata.parseTrackName(filePath, tagLookup(filePath) || {}, {
                    siblingCounts,
                    folderName,
                });
                added.push(this.add(filePath, parsed));
            }
        }
        return added;
    }

    /** All distinct artists, with track counts, sorted by name. */
    listArtists() {
        return [...this.artists.entries()]
            .map(([key, bucket]) => ({key, name: bucket.name, count: bucket.paths.size}))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}));
    }

    /** Every track by an artist, in album/title order (request #16). */
    getTracksByArtist(artistKeyOrName) {
        const key = this.artists.has(artistKeyOrName) ? artistKeyOrName : foldKey(artistKeyOrName);
        const bucket = this.artists.get(key);
        if (!bucket) return [];

        return [...bucket.paths]
            .map((filePath) => this.tracks.get(filePath))
            .filter(Boolean)
            .sort((a, b) =>
                (a.album || '').localeCompare(b.album || '') ||
                a.title.localeCompare(b.title, undefined, {numeric: true, sensitivity: 'base'})
            );
    }

    /**
     * Fuzzy search across artists, titles and albums.
     * Returns artist matches and track matches separately so the UI can offer
     * "Play all 14 songs by Daft Punk" above the individual hits.
     */
    search(rawQuery, {limit = 25} = {}) {
        const query = foldKey(rawQuery);
        if (!query) return {artists: [], tracks: []};

        const artistHits = [];
        for (const [key, bucket] of this.artists) {
            const score = scoreMatch(query, bucket.name);
            if (score > 0) artistHits.push({key, name: bucket.name, count: bucket.paths.size, score});
        }
        artistHits.sort((a, b) => b.score - a.score || b.count - a.count);

        const trackHits = [];
        for (const track of this.tracks.values()) {
            // Title matches are what the user usually means, so weight them above a
            // match that only came from the artist or album field.
            const score = Math.max(
                scoreMatch(query, track.title),
                scoreMatch(query, track.artist) * 0.6,
                scoreMatch(query, track.album || '') * 0.4
            );
            if (score > 0) trackHits.push({...track, score});
        }
        trackHits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

        return {
            artists: artistHits.slice(0, limit),
            tracks: trackHits.slice(0, limit),
        };
    }

    /** Serialisable snapshot for the renderer. */
    toJSON() {
        return {
            tracks: [...this.tracks.values()],
            artists: this.listArtists(),
        };
    }
}

module.exports = {LibraryIndex, foldKey, scoreMatch, isSubsequence};
