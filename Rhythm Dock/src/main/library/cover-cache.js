'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {nativeImage} = require('electron');

function thumbnail(imageBytes, directory) {
    const source = Buffer.from(imageBytes);
    const key = crypto.createHash('sha256').update(source).digest('hex');
    fs.mkdirSync(directory, {recursive: true});
    const target = path.join(directory, `${key}.png`);
    if (!fs.existsSync(target)) {
        const image = nativeImage.createFromBuffer(source);
        if (image.isEmpty()) return null;
        const size = image.getSize();
        const scale = Math.min(1, 512 / Math.max(size.width, size.height));
        const resized = scale < 1 ? image.resize({width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale)), quality: 'good'}) : image;
        const temporary = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, resized.toPNG());
        try { fs.renameSync(temporary, target); }
        catch (error) {
            fs.rmSync(temporary, {force: true});
            if (!fs.existsSync(target)) throw error;
        }
    }
    return `data:image/png;base64,${fs.readFileSync(target).toString('base64')}`;
}

function prune(directory, maxEntries = 1000) {
    if (!fs.existsSync(directory)) return;
    const entries = fs.readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.png$/.test(name))
        .map((name) => ({name, mtime: fs.statSync(path.join(directory, name)).mtimeMs}))
        .sort((a, b) => b.mtime - a.mtime);
    for (const entry of entries.slice(maxEntries)) fs.rmSync(path.join(directory, entry.name), {force: true});
}

module.exports = {thumbnail, prune};
