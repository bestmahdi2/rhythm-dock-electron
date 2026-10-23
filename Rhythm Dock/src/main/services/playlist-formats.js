'use strict';

const path = require('node:path');
const {fileURLToPath, pathToFileURL} = require('node:url');

const SUPPORTED = new Set(require('../../shared/media-formats').audio);

function decodeFileUri(value) {
    try {
        return fileURLToPath(new URL(value));
    } catch (_) { return null; }
}

function resolveEntry(value, directory) {
    const raw = String(value || '').trim();
    if (!raw || /^(https?:|ftp:|data:)/i.test(raw)) return null;
    const decoded = /^file:/i.test(raw) ? decodeFileUri(raw) : raw;
    if (!decoded || /[\r\n\0]/.test(decoded)) return null;
    const filePath = path.resolve(directory, decoded);
    return SUPPORTED.has(path.extname(filePath).toLowerCase()) ? filePath : null;
}

function parse(text, extension, directory) {
    const entries = [];
    const source = String(text || '').replace(/^\uFEFF/, '');
    if (extension === '.m3u' || extension === '.m3u8') {
        for (const line of source.split(/\r?\n/)) {
            if (!line.trim() || line.trimStart().startsWith('#')) continue;
            entries.push(line.trim());
        }
    } else if (extension === '.pls') {
        const numbered = [];
        for (const match of source.matchAll(/^File(\d+)\s*=\s*(.+)$/gim)) numbered.push([Number(match[1]), match[2]]);
        entries.push(...numbered.sort((a, b) => a[0] - b[0]).map((item) => item[1]));
    } else if (extension === '.xspf') {
        for (const match of source.matchAll(/<location>\s*([^<]+)\s*<\/location>/gim)) {
            entries.push(match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>').replace(/&quot;/g, '"'));
        }
    } else throw new Error('Unsupported playlist format.');
    return [...new Set(entries.map((entry) => resolveEntry(entry, directory)).filter(Boolean))];
}

function serialize(paths, extension, directory) {
    const files = paths.filter((item) => typeof item === 'string' && SUPPORTED.has(path.extname(item).toLowerCase()));
    if (extension === '.m3u' || extension === '.m3u8')
        return '#EXTM3U\n' + files.map((item) => path.relative(directory, item)).join('\n') + '\n';
    if (extension === '.pls')
        return '[playlist]\n' + files.map((item, index) => `File${index + 1}=${path.relative(directory, item)}`).join('\n') +
            `\nNumberOfEntries=${files.length}\nVersion=2\n`;
    if (extension === '.xspf') {
        const xml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        return `<?xml version="1.0" encoding="UTF-8"?>\n<playlist version="1" xmlns="http://xspf.org/ns/0/"><trackList>` +
            files.map((item) => `<track><location>${xml(pathToFileURL(item).href)}</location></track>`).join('') +
            '</trackList></playlist>\n';
    }
    throw new Error('Unsupported playlist format.');
}

module.exports = {parse, serialize};
