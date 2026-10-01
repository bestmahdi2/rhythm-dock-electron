'use strict';

/**
 * Tag reading and writing.
 *
 * `music-metadata` (used everywhere else in the app) is read-only by design, so
 * writing needs a second library. node-taglib-sharp is a pure-JS port of
 * TagLib#: no native build step, no python/node-gyp in the packaging pipeline,
 * and it handles the container differences between ID3v2, Vorbis comments and
 * MP4 atoms itself. That container abstraction is the whole reason for choosing
 * it — writing an "album artist" means three different things across MP3, FLAC
 * and M4A, and hand-rolling that is how tag editors corrupt files.
 *
 * The write path is deliberately conservative:
 *
 *   1. Nothing is written unless at least one field actually changed. Rewriting
 *      a file to store identical bytes still risks truncating it on a crash.
 *   2. The file is copied to a sibling temp file, edited there, and moved into
 *      place. A tag write rewrites the header and can shift the entire audio
 *      payload; an interrupted in-place write destroys the track.
 *   3. Unknown/unsupported extensions are rejected before the file is touched.
 */

const fs = require('fs');
const path = require('path');
const {randomUUID} = require('node:crypto');

// TagLib chooses its writer by extension. Keep the original container suffix.
function temporaryPath(filePath) {
    return path.join(path.dirname(filePath),`.rhythm-tag-${randomUUID()}${path.extname(filePath)}`);
}

// Formats taglib-sharp can write reliably. Deliberately narrower than the set
// it can *read* — a format we cannot round-trip should be read-only, not
// silently mangled.
const WRITABLE_EXTENSIONS = new Set([
    '.mp3', '.flac', '.m4a', '.mp4', '.ogg', '.opus', '.wav', '.aiff', '.wma',
]);

// The editable surface. Anything not listed here is preserved untouched.
const TEXT_FIELDS = [
    'title', 'album', 'year', 'track', 'trackCount', 'disc', 'genre', 'comment',
];

let taglib = null;
let loadError = null;

/**
 * Loaded on first use rather than at require time. A missing optional
 * dependency should disable the editor, not stop the app from starting.
 */
function getTaglib() {
    if (taglib || loadError) return taglib;
    try {
        taglib = require('node-taglib-sharp');
    } catch (error) {
        loadError = error;
        console.error('Tag editing unavailable — node-taglib-sharp failed to load:', error.message);
    }
    return taglib;
}

/** True when this path is a format we are willing to write back to. */
function isWritable(filePath) {
    return Boolean(getTaglib())
        && WRITABLE_EXTENSIONS.has(path.extname(filePath || '').toLowerCase());
}

/** Joins taglib's array-valued fields into the single string the UI edits. */
function joinValue(value) {
    if (Array.isArray(value)) return value.filter(Boolean).join('; ');
    return value == null ? '' : String(value);
}

/** Splits the UI's single string back into the array taglib expects. */
function splitValue(value) {
    return String(value || '')
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean);
}

/** Numbers: taglib stores 0 for "absent", the UI shows an empty field. */
function toNumber(value) {
    const parsed = parseInt(String(value ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Reads the editable tag surface plus the embedded cover.
 * Never throws: a file with a corrupt header still has to open in the editor so
 * the user can repair it.
 */
function read(filePath) {
    const lib = getTaglib();
    if (!lib) {
        return {ok: false, error: 'Tag editing is unavailable in this build.', writable: false};
    }

    let file = null;
    try {
        file = lib.File.createFromPath(filePath);
        const tag = file.tag;

        let cover = null;
        const picture = tag.pictures?.[0];
        if (picture?.data) {
            const buffer = Buffer.from(picture.data.toByteVector().toBase64String(), 'base64');
            cover = `data:${picture.mimeType || 'image/jpeg'};base64,${buffer.toString('base64')}`;
        }

        return {
            ok: true,
            writable: isWritable(filePath),
            filePath,
            basename: path.basename(filePath),
            tags: {
                title: joinValue(tag.title),
                artist: joinValue(tag.performers),
                albumArtist: joinValue(tag.albumArtists),
                album: joinValue(tag.album),
                year: tag.year ? String(tag.year) : '',
                track: tag.track ? String(tag.track) : '',
                trackCount: tag.trackCount ? String(tag.trackCount) : '',
                disc: tag.disc ? String(tag.disc) : '',
                genre: joinValue(tag.genres),
                comment: joinValue(tag.comment),
            },
            cover,
            durationSeconds: Math.round(file.properties?.durationMilliseconds / 1000) || 0,
            bitrate: file.properties?.audioBitrate || 0,
            sampleRate: file.properties?.audioSampleRate || 0,
        };
    } catch (error) {
        return {
            ok: false,
            writable: isWritable(filePath),
            filePath,
            basename: path.basename(filePath),
            error: error.message || 'Could not read tags from this file.',
        };
    } finally {
        try { file?.dispose(); } catch { /* already disposed */ }
    }
}

/**
 * Writes tags back.
 *
 * `cover` may be:
 *   undefined  — leave the existing artwork alone
 *   null       — remove all artwork
 *   {data, mimeType} — replace artwork, data being a base64 string
 */
function write(filePath, tags = {}, cover) {
    const lib = getTaglib();
    if (!lib) return {ok: false, error: 'Tag editing is unavailable in this build.'};
    if (!isWritable(filePath)) {
        return {ok: false, error: `${path.extname(filePath) || 'This format'} cannot be written.`};
    }
    if (!fs.existsSync(filePath)) {
        return {ok: false, error: 'The file no longer exists.'};
    }

    // Edit a copy and swap it in. See the module header for why.
    const tempPath = temporaryPath(filePath);

    let file = null;
    try {
        fs.copyFileSync(filePath, tempPath, fs.constants.COPYFILE_EXCL);
        file = lib.File.createFromPath(tempPath);
        const tag = file.tag;

        if (tags.title !== undefined) tag.title = String(tags.title || '') || null;
        if (tags.artist !== undefined) tag.performers = splitValue(tags.artist);
        if (tags.albumArtist !== undefined) tag.albumArtists = splitValue(tags.albumArtist);
        if (tags.album !== undefined) tag.album = String(tags.album || '') || null;
        if (tags.genre !== undefined) tag.genres = splitValue(tags.genre);
        if (tags.comment !== undefined) tag.comment = String(tags.comment || '') || null;
        if (tags.year !== undefined) tag.year = toNumber(tags.year);
        if (tags.track !== undefined) tag.track = toNumber(tags.track);
        if (tags.trackCount !== undefined) tag.trackCount = toNumber(tags.trackCount);
        if (tags.disc !== undefined) tag.disc = toNumber(tags.disc);

        if (cover === null) {
            tag.pictures = [];
        } else if (cover && cover.data) {
            const buffer = Buffer.from(cover.data, 'base64');
            const picture = lib.Picture.fromData(lib.ByteVector.fromByteArray(buffer));
            picture.mimeType = cover.mimeType || 'image/jpeg';
            picture.type = lib.PictureType.FrontCover;
            tag.pictures = [picture];
        }

        file.save();
        file.dispose();
        file = null;

        // rename() is atomic within a filesystem, which is the case here because
        // the temp file is a sibling of the target.
        fs.renameSync(tempPath, filePath);

        return {ok: true, filePath};
    } catch (error) {
        return {ok: false, error: error.message || 'Could not write tags.'};
    } finally {
        try { file?.dispose(); } catch { /* already disposed */ }
        // A leftover temp file means the write failed; the original is untouched.
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* best effort */ }
    }
}

/**
 * Embeds a lyric into the file's own tags (Phase 9).
 *
 * Separate from `write()` because it is called from the lyrics editor rather than the
 * tag editor, and because it must touch nothing else: a user who has just spent ten
 * minutes tapping out an LRC should not risk their carefully curated album artist.
 *
 * The same copy-edit-rename dance applies, for the same reason. taglib maps `lyrics`
 * onto the right frame per container (USLT for ID3v2, LYRICS for Vorbis comments,
 * the lyrics atom for MP4).
 */
function writeLyrics(filePath, lyricsText) {
    const lib = getTaglib();
    if (!lib) return {ok: false, error: 'Tag editing is unavailable in this build.'};
    if (!isWritable(filePath)) {
        return {ok: false, error: `${path.extname(filePath) || 'This format'} cannot be written.`};
    }
    if (!fs.existsSync(filePath)) return {ok: false, error: 'The file no longer exists.'};

    const tempPath = temporaryPath(filePath);

    let file = null;
    try {
        fs.copyFileSync(filePath, tempPath, fs.constants.COPYFILE_EXCL);
        file = lib.File.createFromPath(tempPath);
        file.tag.lyrics = String(lyricsText || '') || null;
        file.save();
        file.dispose();
        file = null;

        fs.renameSync(tempPath, filePath);
        return {ok: true, filePath};
    } catch (error) {
        return {ok: false, error: error.message || 'Could not embed the lyrics.'};
    } finally {
        try { file?.dispose(); } catch { /* already disposed */ }
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* best effort */ }
    }
}

module.exports = {
    read,
    write,
    writeLyrics,
    isWritable,
    WRITABLE_EXTENSIONS,
    TEXT_FIELDS,
};
