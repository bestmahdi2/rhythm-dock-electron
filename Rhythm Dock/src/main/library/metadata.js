'use strict';

/**
 * Artist / title extraction (request #2).
 *
 * Music files name themselves badly. The same track can arrive as any of:
 *
 *   Daft Punk - Around The World.mp3
 *   Around The World - Daft Punk.mp3
 *   03. Daft Punk - Around The World [320kbps].mp3
 *   Daft_Punk_-_Around_The_World.mp3
 *   www.SomeSite.com_Daft Punk - Around The World (Official Video).mp3
 *   Around The World (feat. Someone) - Daft Punk - Homework.mp3
 *
 * There is no rule that resolves all of these, so this module scores candidates rather
 * than following a fixed pattern. Evidence is combined from four places:
 *
 *   1. Embedded tags        — trusted most, but frequently blank or junk ("Unknown").
 *   2. The filename itself  — separator position, track numbers, bracketed noise.
 *   3. The containing folder— often the artist or "Artist - Album".
 *   4. Sibling filenames    — the side of the separator that repeats across a directory
 *                             is almost always the artist. This is the strongest signal
 *                             available and the previous implementation ignored it.
 */

const path = require('path');

// Values tag editors leave behind that carry no information.
const NULL_TAG_VALUES = new Set([
    'unknown', 'unknown artist', 'unknown album', 'various', 'various artists',
    'va', 'n/a', 'na', 'none', 'null', 'undefined', 'untitled', 'no artist',
    'track', 'audiotrack', 'audio track', '-', '--', '', 'artist', 'title',
]);

// Bracketed or trailing noise that is never part of an artist or a title.
const JUNK_PATTERNS = [
    // Site watermarks: www.foo.com, [Foo.net], (downloaded from bar.org)
    //
    // The trailing lookahead is deliberately NOT \b. Watermarks are very often glued to
    // the rest of the name with an underscore ("www.site.com_Artist - Title"), and \b
    // does not match between "com" and "_" because underscore counts as a word
    // character — so the pattern silently failed on exactly the case it exists for.
    /(?:^|[^a-z0-9])(?:www\.)?[a-z0-9-]+\.(?:com|net|org|ir|ru|info|biz|co|me|tv|xyz|to|cc|in|us)(?![a-z0-9])/gi,
    /\b(?:downloaded|download(?:ed)?\s+(?:from|by)|courtesy\s+of|uploaded\s+by)\b[^)\]}]*/gi,
    // Quality / encoding markers.
    /\b\d{2,3}\s?kbps\b/gi,
    /\b(?:320|256|192|128|96|64)k\b/gi,
    /\b(?:mp3|flac|wav|m4a|aac|ogg|opus)\b/gi,
    /\b(?:hq|hd|full\s?hd|4k|1080p|720p|480p|cd\s?rip|cdrip|web\s?rip|vbr|cbr)\b/gi,
    // Platform / release noise.
    /\b(?:official|officiel)\s*(?:music\s*)?(?:video|audio|lyric[s]?|version|hd)\b/gi,
    /\b(?:lyric[s]?\s*video|music\s*video|audio\s*only|visualizer|with\s*lyrics)\b/gi,
    /\b(?:free\s*download|exclusive|promo|explicit|clean\s*version)\b/gi,
];

// Bracketed segments worth KEEPING because they genuinely qualify the title.
const MEANINGFUL_BRACKET = /\b(?:remix|mix|edit|remaster(?:ed)?|live|acoustic|instrumental|cover|version|feat|ft|featuring|radio|extended|club|demo|reprise|unplugged|bonus|deluxe|part|pt|vol|original)\b/i;

// Separators that divide artist from title, longest first so " - " wins over "-".
const SEPARATORS = [
    ' -- ', ' — ', ' – ', ' - ', '_-_', ' _ ', ' | ', ' :: ',
    '—', '–', ' _', '_ ', ' - ',
];

// Words that mark the side they appear on as a TITLE rather than an artist.
const TITLE_MARKERS = /\b(?:remix|edit|remaster(?:ed)?|live|acoustic|instrumental|cover|version|radio\s*edit|extended|club\s*mix|bootleg|mashup|intro|outro|interlude|reprise)\b/i;

// Words that mark the side they appear on as an ARTIST.
const ARTIST_MARKERS = /\b(?:band|orchestra|ensemble|quartet|trio|choir|dj|mc|feat\.?|ft\.?|presents|pres\.)\b/i;

/** Is a tag value actually usable? */
function isUsableTag(value) {
    if (typeof value !== 'string') return false;
    const trimmed = value.trim();
    if (!trimmed) return false;
    if (NULL_TAG_VALUES.has(trimmed.toLowerCase())) return false;
    // A "tag" that is just a number is a track index that leaked into the wrong field.
    if (/^\d+$/.test(trimmed)) return false;
    return true;
}

/**
 * Strips bracketed segments, but keeps the ones that qualify a title
 * ("(Live)", "(Radio Edit)") because removing those loses real information.
 */
function stripBrackets(input) {
    return input.replace(/[\[({<]([^\])}>]*)[\])}>]/g, (match, inner) =>
        MEANINGFUL_BRACKET.test(inner) ? match : ' '
    );
}

/** Removes watermark / quality / platform noise. */
function stripJunk(input) {
    let output = input;
    for (const pattern of JUNK_PATTERNS) {
        output = output.replace(pattern, ' ');
    }
    return output;
}

/**
 * Removes a leading track number: "01.", "01 -", "1)", "[03]", "07_".
 * Deliberately capped at 3 digits so a title that *starts* with a year
 * ("1979 - Smashing Pumpkins") is not mangled.
 */
function stripTrackNumber(input) {
    return input
        .replace(/^\s*[\[({]?\s*(\d{1,3})\s*[\])}]?\s*[-._)\]]\s+/, (match, num) =>
            // A number above 200 is far more likely to be part of the title.
            parseInt(num, 10) <= 200 ? ' ' : match
        )
        .replace(/^\s*(\d{1,2})\s+(?=[A-Za-z])/, ' ');
}

/** Collapses separator characters used in place of spaces. */
function normalizeWhitespace(input) {
    return input
        .replace(/[_]+/g, ' ')
        // Dots between letters are usually spaces, but leave "Mr." and "A.M." alone.
        .replace(/(?<=[a-z]{2})\.(?=[a-z]{2})/gi, ' ')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\s\-–—_.|]+|[\s\-–—_.|]+$/g, '')
        .trim();
}

/** Full cleaning pipeline for one side of a filename. */
function cleanSegment(input) {
    if (!input) return '';
    return normalizeWhitespace(stripJunk(stripBrackets(input)));
}

/**
 * Splits a cleaned basename on the first separator that yields two non-empty sides.
 * Returns every plausible split, not just the first, so the scorer can choose.
 */
function findSplits(name) {
    const splits = [];
    for (const separator of SEPARATORS) {
        let index = name.indexOf(separator);
        while (index > 0) {
            const left = name.slice(0, index).trim();
            const right = name.slice(index + separator.length).trim();
            if (left && right) {
                splits.push({left, right, separator});
            }
            index = name.indexOf(separator, index + separator.length);
        }
        if (splits.length) break; // Prefer the most explicit separator available.
    }
    return splits;
}

function normalizeForCompare(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '')
        .trim();
}

/**
 * Scores the hypothesis "left is the artist, right is the title".
 * A positive score favours that reading; a negative score favours the reverse.
 */
function scoreOrientation(left, right, context) {
    const {tagArtist, tagTitle, folderName, siblingCounts} = context;
    let score = 0;
    const reasons = [];

    const leftKey = normalizeForCompare(left);
    const rightKey = normalizeForCompare(right);

    // --- Tag agreement: decisive when available. ---
    if (isUsableTag(tagArtist)) {
        const tagKey = normalizeForCompare(tagArtist);
        if (tagKey && leftKey.includes(tagKey)) {
            score += 100;
            reasons.push('left matches artist tag');
        }
        if (tagKey && rightKey.includes(tagKey)) {
            score -= 100;
            reasons.push('right matches artist tag');
        }
    }
    if (isUsableTag(tagTitle)) {
        const tagKey = normalizeForCompare(tagTitle);
        if (tagKey && rightKey.includes(tagKey)) {
            score += 80;
            reasons.push('right matches title tag');
        }
        if (tagKey && leftKey.includes(tagKey)) {
            score -= 80;
            reasons.push('left matches title tag');
        }
    }

    // --- Sibling repetition: the side that repeats across the folder is the artist. ---
    //
    // The bar is "appears at least twice, and more often than the other side". An
    // earlier version required a margin of 2, which silently did nothing on short
    // albums: in a 2-track folder the artist appears twice and each title once, and
    // 2 > 1 + 1 is false — so exactly the folders that need this signal never got it.
    if (siblingCounts) {
        const leftCount = siblingCounts.get(leftKey) || 0;
        const rightCount = siblingCounts.get(rightKey) || 0;
        if (leftCount >= 2 && leftCount > rightCount) {
            score += Math.min(50, (leftCount - rightCount) * 15);
            reasons.push(`left repeats across ${leftCount} files`);
        } else if (rightCount >= 2 && rightCount > leftCount) {
            score -= Math.min(50, (rightCount - leftCount) * 15);
            reasons.push(`right repeats across ${rightCount} files`);
        }
    }

    // --- Folder name: "Daft Punk" or "Daft Punk - Homework". ---
    if (folderName) {
        const folderKey = normalizeForCompare(folderName);
        if (folderKey.length > 2) {
            if (folderKey.includes(leftKey) && leftKey.length > 2) {
                score += 30;
                reasons.push('left matches folder');
            }
            if (folderKey.includes(rightKey) && rightKey.length > 2) {
                score -= 30;
                reasons.push('right matches folder');
            }
        }
    }

    // --- Lexical markers. ---
    if (TITLE_MARKERS.test(right)) {
        score += 15;
        reasons.push('right looks like a title');
    }
    if (TITLE_MARKERS.test(left)) {
        score -= 15;
        reasons.push('left looks like a title');
    }
    if (ARTIST_MARKERS.test(left)) {
        score += 12;
        reasons.push('left looks like an artist');
    }
    if (ARTIST_MARKERS.test(right)) {
        score -= 12;
        reasons.push('right looks like an artist');
    }

    // --- Weak shape heuristics, only meaningful when nothing else fired. ---
    // Titles tend to be longer and wordier than artist names.
    const leftWords = left.split(/\s+/).length;
    const rightWords = right.split(/\s+/).length;
    if (rightWords > leftWords + 2) {
        score += 4;
        reasons.push('right is notably longer');
    } else if (leftWords > rightWords + 2) {
        score -= 4;
        reasons.push('left is notably longer');
    }

    // "Artist - Title" is the dominant convention, so break exact ties with it.
    score += 2;

    return {score, reasons};
}

/**
 * Extracts artist and title for one file.
 *
 * @param {string} filePath        Absolute path to the audio file.
 * @param {object} tags            Whatever the tag reader produced ({artist, title, album}).
 * @param {object} [context]
 * @param {Map<string, number>} [context.siblingCounts]
 *        Normalised segment -> how many files in the same directory contain it. Built by
 *        buildSiblingCounts(). Supplying this dramatically improves accuracy.
 */
function parseTrackName(filePath, tags = {}, context = {}) {
    const extension = path.extname(filePath);
    const rawBasename = path.basename(filePath, extension);
    const folderName = context.folderName !== undefined
        ? context.folderName
        : path.basename(path.dirname(filePath));

    const tagArtist = isUsableTag(tags.artist) ? tags.artist.trim() : null;
    const tagTitle = isUsableTag(tags.title) ? tags.title.trim() : null;

    // Best case: both tags are present and meaningful. Nothing beats that.
    if (tagArtist && tagTitle) {
        return {
            artist: tagArtist,
            title: tagTitle,
            album: isUsableTag(tags.album) ? tags.album.trim() : null,
            source: 'tags',
            confidence: 1.0,
            reasons: ['both tags usable'],
        };
    }

    const cleaned = normalizeWhitespace(
        stripTrackNumber(cleanSegment(rawBasename))
    ) || rawBasename;

    const splits = findSplits(cleaned);

    if (splits.length === 0) {
        // No separator. The filename is the title; fall back to the tag or the folder
        // for the artist, since a folder is usually named after the artist.
        const folderArtist = cleanSegment(folderName);
        return {
            artist: tagArtist || (folderArtist && !/^(music|songs?|audio|downloads?|new|album)$/i.test(folderArtist)
                ? folderArtist
                : 'Unknown Artist'),
            title: tagTitle || cleaned,
            album: isUsableTag(tags.album) ? tags.album.trim() : null,
            source: tagArtist ? 'tags+filename' : 'filename',
            confidence: tagArtist ? 0.7 : 0.35,
            reasons: ['no separator in filename'],
        };
    }

    // Score every candidate split in both orientations and keep the best.
    let best = null;
    for (const split of splits) {
        const left = cleanSegment(split.left);
        const right = cleanSegment(split.right);
        if (!left || !right) continue;

        const {score, reasons} = scoreOrientation(left, right, {
            tagArtist, tagTitle, folderName, siblingCounts: context.siblingCounts,
        });

        const candidate = score >= 0
            ? {artist: left, title: right, score: Math.abs(score), reasons}
            : {artist: right, title: left, score: Math.abs(score), reasons};

        if (!best || candidate.score > best.score) best = candidate;
    }

    if (!best) {
        return {
            artist: tagArtist || 'Unknown Artist',
            title: tagTitle || cleaned,
            album: isUsableTag(tags.album) ? tags.album.trim() : null,
            source: 'filename',
            confidence: 0.3,
            reasons: ['split produced empty segments'],
        };
    }

    // Map the raw score onto a 0-1 confidence. 100+ means a tag corroborated it.
    const confidence = Math.max(0.3, Math.min(1, best.score / 100));

    return {
        // A usable tag always wins over the filename for its own field.
        artist: tagArtist || best.artist,
        title: tagTitle || best.title,
        album: isUsableTag(tags.album) ? tags.album.trim() : null,
        source: tagArtist || tagTitle ? 'tags+filename' : 'filename',
        confidence: tagArtist ? Math.max(confidence, 0.8) : confidence,
        reasons: best.reasons,
    };
}

/**
 * Counts how often each separator-delimited segment appears across a set of filenames
 * in the same directory.
 *
 * This is the sibling signal: in a folder of "Pink Floyd - X.mp3" files, "Pink Floyd"
 * appears 12 times and each title appears once, so the artist side is unambiguous even
 * with no tags at all.
 */
function buildSiblingCounts(filePaths) {
    const counts = new Map();

    for (const filePath of filePaths) {
        const base = normalizeWhitespace(
            stripTrackNumber(cleanSegment(path.basename(filePath, path.extname(filePath))))
        );
        const splits = findSplits(base);
        if (!splits.length) continue;

        // Only the first split is considered, to avoid double-counting long names.
        const {left, right} = splits[0];
        for (const side of [cleanSegment(left), cleanSegment(right)]) {
            const key = normalizeForCompare(side);
            if (!key) continue;
            counts.set(key, (counts.get(key) || 0) + 1);
        }
    }

    return counts;
}

/**
 * Splits a combined artist field into individual performers, so that
 * "A feat. B", "A & B", "A x B" all index under both A and B.
 */
function splitArtists(artist) {
    if (!artist) return [];
    return String(artist)
        // The optional dot must be consumed before the boundary check. Writing
        // `\bfeat\.?\b` lets the regex match "feat" and stop, because there is already a
        // boundary between "t" and ".", which leaves a stray ". " on the next artist.
        .split(/\s*(?:,|;|\/|&|\bfeat\.?(?=\s|$)|\bft\.?(?=\s|$)|\bfeaturing\b|\bx\b|\bvs\.?(?=\s|$)|\band\b|\bwith\b)\s*/i)
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && !NULL_TAG_VALUES.has(part.toLowerCase()));
}

module.exports = {
    parseTrackName,
    buildSiblingCounts,
    splitArtists,
    isUsableTag,
    cleanSegment,
    stripTrackNumber,
    stripBrackets,
    stripJunk,
    normalizeForCompare,
    findSplits,
};
