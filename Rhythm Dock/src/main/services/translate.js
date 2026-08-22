'use strict';

/**
 * Lyrics translation (request #15).
 *
 * Runs in the main process on purpose. The renderer has a strict CSP with an explicit
 * `connect-src` allow-list; doing translation there would mean amending the CSP for every
 * provider a user might point at, which defeats the point of having one. `net.request`
 * in main is not subject to CSP, so a custom endpoint needs no policy change.
 *
 * Providers are pluggable. The default is Google's public translate endpoint (no key,
 * no account); a LibreTranslate provider is included for anyone who wants to self-host,
 * which is likely given the VPS in Phase 6.
 *
 * Results are cached in the lyrics database, keyed by (songKey, targetLanguage), because
 * translating a 60-line lyric on every replay is both slow and rude to the provider.
 */

const {net} = require('electron');

const LANGUAGES = [
    {code: 'en', label: 'English', rtl: false},
    {code: 'fa', label: 'فارسی (Persian)', rtl: true},
    {code: 'fr', label: 'Français (French)', rtl: false},
    {code: 'ar', label: 'العربية (Arabic)', rtl: true},
];

const RTL_CODES = new Set(LANGUAGES.filter((l) => l.rtl).map((l) => l.code));

// Translating line-by-line would mean one request per line. Instead lines are joined
// with a separator the translator will not mangle, sent as one request, and split back
// apart. A bare newline gets collapsed by most engines; this survives.
const LINE_SEPARATOR = '\n\u2063\n';
const SEPARATOR_PATTERN = /\s*\u2063\s*/;

const REQUEST_TIMEOUT_MS = 15000;
const MAX_CHARS_PER_REQUEST = 4000;

/** Promise wrapper around net.request with a timeout. */
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
            reject(new Error('Translation request timed out'));
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
                    reject(new Error(`Translation provider returned ${response.statusCode}`));
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

/**
 * Default provider: Google's public endpoint. Returns a deeply nested array; the
 * translated segments are the first element of each entry in result[0].
 */
async function googleProvider(text, targetLanguage, sourceLanguage = 'auto') {
    const url =
        'https://translate.googleapis.com/translate_a/single' +
        '?client=gtx' +
        `&sl=${encodeURIComponent(sourceLanguage)}` +
        `&tl=${encodeURIComponent(targetLanguage)}` +
        '&dt=t' +
        `&q=${encodeURIComponent(text)}`;

    const raw = await httpRequest({method: 'GET', url});

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (_) {
        throw new Error('Could not parse translation response');
    }

    if (!Array.isArray(parsed) || !Array.isArray(parsed[0])) {
        throw new Error('Unexpected translation response shape');
    }

    // Segments are re-joined without separators: the API splits on its own sentence
    // boundaries, which do not correspond to our lines.
    return parsed[0].map((segment) => (segment && segment[0]) || '').join('');
}

/** LibreTranslate, for self-hosting. */
async function libreProvider(text, targetLanguage, sourceLanguage = 'auto', config = {}) {
    const endpoint = config.endpoint || 'https://libretranslate.com/translate';

    const payload = JSON.stringify({
        q: text,
        source: sourceLanguage === 'auto' ? 'auto' : sourceLanguage,
        target: targetLanguage,
        format: 'text',
        ...(config.apiKey ? {api_key: config.apiKey} : {}),
    });

    const raw = await httpRequest(
        {method: 'POST', url: endpoint, headers: {'Content-Type': 'application/json'}},
        payload
    );

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.translatedText !== 'string') {
        throw new Error(parsed && parsed.error ? parsed.error : 'Unexpected LibreTranslate response');
    }
    return parsed.translatedText;
}

const PROVIDERS = {google: googleProvider, libre: libreProvider};

/** Splits an array of lines into batches under the per-request character budget. */
function batchLines(lines) {
    const batches = [];
    let current = [];
    let length = 0;

    for (const line of lines) {
        const cost = line.length + LINE_SEPARATOR.length;
        if (length + cost > MAX_CHARS_PER_REQUEST && current.length > 0) {
            batches.push(current);
            current = [];
            length = 0;
        }
        current.push(line);
        length += cost;
    }
    if (current.length > 0) batches.push(current);
    return batches;
}

/**
 * Translates an array of lyric lines.
 *
 * Blank lines are held out of the request and reinserted afterwards, so the translated
 * output keeps the same line count and stays aligned with the timestamps.
 */
async function translateLines(lines, targetLanguage, config = {}) {
    if (!Array.isArray(lines) || lines.length === 0) return [];

    const provider = PROVIDERS[config.provider] || PROVIDERS.google;

    // Map from "index among non-empty lines" back to the original index.
    const indices = [];
    const payloadLines = [];
    lines.forEach((line, index) => {
        if (typeof line === 'string' && line.trim().length > 0) {
            indices.push(index);
            payloadLines.push(line.trim());
        }
    });

    if (payloadLines.length === 0) return [...lines];

    const translated = new Array(lines.length).fill('');
    let cursor = 0;

    for (const batch of batchLines(payloadLines)) {
        const joined = batch.join(LINE_SEPARATOR);
        const result = await provider(joined, targetLanguage, config.sourceLanguage || 'auto', config);
        const pieces = result.split(SEPARATOR_PATTERN).map((piece) => piece.trim());

        for (let i = 0; i < batch.length; i++) {
            // If the provider lost a separator the counts diverge; fall back to the
            // original line rather than shifting every subsequent translation up by one.
            const value = pieces.length === batch.length ? pieces[i] : batch[i];
            translated[indices[cursor + i]] = value;
        }
        cursor += batch.length;
    }

    return translated;
}

function isRightToLeft(languageCode) {
    return RTL_CODES.has(languageCode);
}

module.exports = {
    LANGUAGES,
    PROVIDERS,
    translateLines,
    isRightToLeft,
    batchLines,
    LINE_SEPARATOR,
};
