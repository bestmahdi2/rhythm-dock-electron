'use strict';
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);
let pending;
async function installed() {
    const options = {windowsHide:true, timeout:15000, maxBuffer:8 * 1024 * 1024};
    if (process.platform === 'win32') {
        const {stdout} = await run('powershell.exe', ['-NoProfile','-NonInteractive','-Command',
            '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families.Name | ConvertTo-Json -Compress'], options);
        return [].concat(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()));
    }
    if (process.platform === 'darwin') {
        const {stdout} = await run('system_profiler', ['SPFontsDataType','-json'], options);
        return (JSON.parse(stdout).SPFontsDataType || []).flatMap(font => (font.typefaces || []).map(face => face.family || face._name));
    }
    const {stdout} = await run('fc-list', ['--format=%{family}\n'], options);
    return stdout.split('\n').flatMap(line => line.split(','));
}
async function list(database) {
    if (!pending) pending = installed().then(names => [...new Set(names.map(n => String(n || '').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b)))
        .catch(error => { console.warn('[fonts]', error.message); pending = null; return []; });
    const fonts = await pending;
    const pinned = database.getAppPreference('lyricsPinnedFonts') || ['B Nazanin', 'IRANSansX'];
    database.setAppPreference('lyricsPinnedFonts', pinned);
    return {fonts, pinned};
}
module.exports = {list};
