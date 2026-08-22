'use strict';

/**
 * Lyrics acquisition and persistence (Phase 9).
 *
 * Everything lyric-shaped that touches the network or the filesystem lives here, for
 * the same reason translation does: the renderer runs under a strict CSP, and adding
 * a `connect-src` entry per provider defeats the point of having one. `net.request`
 * in the main process is not subject to it, so adding a provider costs no policy
 * change and no renderer privilege.
 *
 * The resolver is a chain, tried in order until one yields something usable:
 *
 *   1. sidecar   - a .lrc next to the audio file, or one we wrote to app data.
 *                  Always first: it is the user's own work and must beat the network.
 *   2. embedded  - lyrics carried in the file's own tags.
 *   3. lrclib    - community LRC database. Synced, no key, generous limits.
 *   4. netease   - far better coverage of CJK repertoire, which lrclib is thin on.
 *   5. genius    - last resort, and only with a token; see geniusProvider.
 *
 * A single source was a single point of failure: when lrclib had no match, the user
 * saw "No lyrics available" for a track three other databases know by heart.
 */

const fs = require('fs');
const path = require('path');
const {net} = require('electron');

const REQUEST_TIMEOUT_MS = 12000;

const DEFAULT_PROVIDER_ORDER = ['sidecar', 'embedded', 'lrclib', 'netease', 'genius'];

// Line timestamps: [mm:ss.xx]. Word timestamps (enhanced LRC): <mm:ss.xx>.
const LINE_TIME_PATTERN = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?]/;
const WORD_TIME_PATTERN = /<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/;

// Global variant, for stripping rather than testing.
const ALL_TIMES_PATTERN = /[[<]\d{1,3}:\d{2}(?:[.:]\d{1,3})?[\]>]/g;

/** Promise wrapper around net.request with a timeout. Resolves the body as text. */
function httpRequest(options, body = null) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const request = net.request(options);

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
                request.abort();
            } catch (_) { /* already finished */ }
            reject(new Error('Lyrics request timed out'));
        }, REQUEST_TIMEOUT_MS);

        request.on('response', (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);

                const text = Buffer.concat(chunks).toString('utf8');
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    reject(new Error(`Provider returned ${response.statusCode}`));
                    return;
                }
                resolve(text);
            });
        });

        request.on('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });

        if (body) request.write(body);
        request.end();
    });
}

// --- Shape detection -------------------------------------------------------------

/** True when the text carries at least one line timestamp. */
function isSynced(text) {
    return Boolean(text) && LINE_TIME_PATTERN.test(text);
}

/** True when the text carries word-level (enhanced LRC) timestamps. */
function hasWordTiming(text) {
    return Boolean(text) && WORD_TIME_PATTERN.test(text);
}

/**
 * Rejects blank results and the placeholder some providers return for instrumentals.
 * A lone "[Instrumental]" is worse than nothing, because accepting it ends the chain
 * and displaces a real lyric a later provider would have found.
 */
function isUsable(text) {
    if (!text) return false;
    const stripped = String(text)
        .replace(/\[[a-z]+:[^\]]*]/gi, '')   // ID tags: [ar:...], [ti:...], [offset:...]
        .replace(ALL_TIMES_PATTERN, '')
        .trim();
    if (stripped.length < 4) return false;
    return !/^\[?instrumental]?$/i.test(stripped);
}

function describe(text, source) {
    return {
        ok: true,
        text,
        source,
        isSynced: isSynced(text),
        hasWordTiming: hasWordTiming(text),
    };
}

// --- Sidecar files ---------------------------------------------------------------

/** Filesystem-safe basename for the app-data mirror. */
function sanitiseName(name) {
    return String(name || 'track').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}

/**
 * Candidate .lrc locations for a track, most authoritative first.
 *
 * The sibling file is what every other player looks for, so it wins. The app-data
 * copy exists because plenty of libraries sit on read-only media or network shares,
 * and losing a tap-to-sync session to a permission error is not acceptable.
 */
function sidecarCandidates(filePath, lyricsDir) {
    if (!filePath) return [];
    const parsed = path.parse(filePath);
    const candidates = [path.join(parsed.dir, `${parsed.name}.lrc`)];
    if (lyricsDir) {
        candidates.push(path.join(lyricsDir, `${sanitiseName(parsed.name)}.lrc`));
    }
    return candidates;
}

function readSidecar(filePath, lyricsDir) {
    for (const candidate of sidecarCandidates(filePath, lyricsDir)) {
        try {
            if (!fs.existsSync(candidate)) continue;
            const text = fs.readFileSync(candidate, 'utf8');
            if (isUsable(text)) return {text, sidecarPath: candidate};
        } catch (error) {
            console.error(`[lyrics] Could not read ${candidate}:`, error.message);
        }
    }
    return null;
}

/**
 * Writes an .lrc beside the audio file, falling back to app data when that directory
 * refuses the write. Written through a temp file and renamed, so an interrupted save
 * cannot leave a truncated file where a good lyric used to be.
 */
function writeSidecar(filePath, text, lyricsDir) {
    const targets = sidecarCandidates(filePath, lyricsDir);
    let lastError = null;

    for (const target of targets) {
        const tempPath = `${target}.rdtmp`;
        try {
            fs.mkdirSync(path.dirname(target), {recursive: true});
            fs.writeFileSync(tempPath, text, 'utf8');
            fs.renameSync(tempPath, target);
            return {ok: true, sidecarPath: target};
        } catch (error) {
            lastError = error;
            try {
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            } catch (_) { /* best effort */ }
        }
    }

    return {
        ok: false,
        error: lastError ? lastError.message : 'No writable location for the .lrc file.',
    };
}

// --- Providers -------------------------------------------------------------------

/**
 * lrclib. The signature endpoint (artist + title + album + duration) is tried first
 * because it returns the lyric timed for *this* release rather than a same-titled
 * remaster running eight seconds longer; the search endpoint is the fallback.
 */
async function lrclibProvider({artist, title, album, durationSeconds}) {
    if (!artist && !title) return null;

    if (artist && title && Number.isFinite(durationSeconds) && durationSeconds > 0) {
        try {
            const url = 'https://lrclib.net/api/get'
                + `?artist_name=${encodeURIComponent(artist)}`
                + `&track_name=${encodeURIComponent(title)}`
                + `&album_name=${encodeURIComponent(album || '')}`
                + `&duration=${Math.round(durationSeconds)}`;
            const record = JSON.parse(await httpRequest({method: 'GET', url}));
            const text = record?.syncedLyrics || record?.plainLyrics;
            if (isUsable(text)) return text;
        } catch (_) { /* no exact match; fall through to search */ }
    }

    const searchUrl = 'https://lrclib.net/api/search'
        + `?track_name=${encodeURIComponent(title || '')}`
        + `&artist_name=${encodeURIComponent(artist || '')}`;
    const results = JSON.parse(await httpRequest({method: 'GET', url: searchUrl}));
    if (!Array.isArray(results) || results.length === 0) return null;

    // Prefer synced results, and among those the closest duration match.
    const scored = results
        .map((record) => ({
            text: record.syncedLyrics || record.plainLyrics,
            synced: Boolean(record.syncedLyrics),
            delta: Number.isFinite(durationSeconds) && record.duration
                ? Math.abs(record.duration - durationSeconds)
                : 999,
        }))
        .filter((entry) => isUsable(entry.text))
        .sort((a, b) => (Number(b.synced) - Number(a.synced)) || (a.delta - b.delta));

    return scored.length ? scored[0].text : null;
}

/**
 * NetEase Cloud Music. Its search API is public and hands back LRC directly, and its
 * coverage of Chinese, Japanese and Korean releases is in a different league.
 */
async function neteaseProvider({artist, title}) {
    if (!title) return null;

    const query = encodeURIComponent(`${title} ${artist || ''}`.trim());
    const searchUrl = `https://music.163.com/api/search/get?s=${query}&type=1&limit=5&offset=0`;
    const search = JSON.parse(await httpRequest({
        method: 'GET',
        url: searchUrl,
        // NetEase rejects requests without a plausible referer.
        headers: {Referer: 'https://music.163.com/'},
    }));

    const songs = search?.result?.songs;
    if (!Array.isArray(songs) || songs.length === 0) return null;

    for (const song of songs.slice(0, 3)) {
        try {
            const url = `https://music.163.com/api/song/lyric?id=${song.id}&lv=1&kv=1&tv=-1`;
            const payload = JSON.parse(await httpRequest({
                method: 'GET',
                url,
                headers: {Referer: 'https://music.163.com/'},
            }));
            const text = payload?.lrc?.lyric;
            if (isUsable(text)) return text;
        } catch (_) { /* try the next candidate */ }
    }
    return null;
}

/**
 * Genius, and only with a user-supplied token.
 *
 * Genius' API exposes metadata but not the lyric body; the body only comes from
 * scraping the page, which breaks every few months and is not something to run in a
 * background code path. What it is excellent at is *identification*, so a hit is used
 * to correct the artist/title and re-query lrclib. Without a token this is a no-op.
 */
async function geniusProvider({artist, title}, config = {}) {
    const token = String(config.geniusToken || '').trim();
    if (!token || !title) return null;

    const query = encodeURIComponent(`${title} ${artist || ''}`.trim());
    const payload = JSON.parse(await httpRequest({
        method: 'GET',
        url: `https://api.genius.com/search?q=${query}`,
        headers: {Authorization: `Bearer ${token}`},
    }));

    const hit = payload?.response?.hits?.[0]?.result;
    if (!hit) return null;

    const corrected = {
        artist: hit.primary_artist?.name || artist,
        title: hit.title || title,
    };
    // Nothing was corrected, so re-querying would just repeat the earlier miss.
    if (corrected.artist === artist && corrected.title === title) return null;

    return lrclibProvider(corrected);
}

const PROVIDERS = {
    lrclib: lrclibProvider,
    netease: neteaseProvider,
    genius: geniusProvider,
};

/**
 * Runs the chain and returns the first usable result.
 *
 * @param {object}   request
 * @param {string}   request.filePath          Track on disk; used for the sidecar lookup.
 * @param {string}   request.artist
 * @param {string}   request.title
 * @param {string}   [request.album]
 * @param {number}   [request.durationSeconds]
 * @param {string}   [request.embedded]        Lyrics read from the file's own tags.
 * @param {string}   [request.lyricsDir]       App-data mirror directory.
 * @param {string[]} [request.order]           Provider order override.
 * @param {boolean}  [request.allowNetwork]    False restricts the chain to local sources.
 * @param {object}   [config]                  { geniusToken }
 * @returns {Promise<object>} `{ok, text, source, isSynced, hasWordTiming, attempts}`
 */
async function resolve(request = {}, config = {}) {
    const order = Array.isArray(request.order) && request.order.length
        ? request.order
        : DEFAULT_PROVIDER_ORDER;

    // Reported back to the renderer so "not found" can say which sources were tried.
    const attempts = [];

    for (const name of order) {
        try {
            if (name === 'sidecar') {
                const found = readSidecar(request.filePath, request.lyricsDir);
                if (found) {
                    return {
                        ...describe(found.text, 'sidecar'),
                        sidecarPath: found.sidecarPath,
                        attempts,
                    };
                }
                attempts.push({provider: name, result: 'miss'});
                continue;
            }

            if (name === 'embedded') {
                if (isUsable(request.embedded)) {
                    return {...describe(request.embedded, 'embedded'), attempts};
                }
                attempts.push({provider: name, result: 'miss'});
                continue;
            }

            const provider = PROVIDERS[name];
            if (!provider) continue;

            if (request.allowNetwork === false) {
                attempts.push({provider: name, result: 'skipped'});
                continue;
            }

            const text = await provider(request, config);
            if (isUsable(text)) return {...describe(text, name), attempts};
            attempts.push({provider: name, result: 'miss'});
        } catch (error) {
            // One provider being down, rate-limited or reshaped must not end the chain.
            console.error(`[lyrics] ${name} failed:`, error.message);
            attempts.push({provider: name, result: 'error', error: error.message});
        }
    }

    return {
        ok: false,
        text: null,
        source: null,
        isSynced: false,
        hasWordTiming: false,
        attempts,
    };
}

module.exports = {
    resolve,
    readSidecar,
    writeSidecar,
    sidecarCandidates,
    isSynced,
    hasWordTiming,
    isUsable,
    DEFAULT_PROVIDER_ORDER,
};
