'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Only predefined fields are written. URLs, paths, credentials and error text
// never enter the file, even when a caller passes an entire request object.
const FIELDS = new Set(['reason', 'code', 'count', 'role', 'state', 'version', 'attempt']);
class Diagnostics {
    constructor(root) { this.filePath = path.join(root, 'diagnostics.jsonl'); fs.mkdirSync(root, {recursive: true}); }
    record(event, details = {}) {
        if (!/^[a-z][a-z0-9:-]{1,60}$/.test(event)) return;
        const safe = {};
        for (const [key, value] of Object.entries(details || {})) {
            if (!FIELDS.has(key)) continue;
            if (typeof value === 'number' || typeof value === 'boolean') safe[key] = value;
            else if (typeof value === 'string' && /^[a-zA-Z0-9 ._:-]{0,80}$/.test(value) &&
                !/token|password|secret|bearer/i.test(value)) safe[key] = value;
        }
        try {
            if (fs.existsSync(this.filePath) && fs.statSync(this.filePath).size > 256 * 1024) {
                const previous = this.filePath + '.previous';
                fs.rmSync(previous, {force: true}); fs.renameSync(this.filePath, previous);
            }
            fs.appendFileSync(this.filePath, JSON.stringify({at: new Date().toISOString(), event, ...safe}) + '\n');
        } catch (_) { /* Diagnostics must never stop playback. */ }
    }
    text() {
        return [this.filePath + '.previous', this.filePath]
            .filter((file) => fs.existsSync(file)).map((file) => fs.readFileSync(file, 'utf8')).join('');
    }
}
module.exports = {Diagnostics};
