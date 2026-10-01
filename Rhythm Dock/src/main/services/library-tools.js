'use strict';
const database = require('./database');
const path = require('node:path');
const db = () => database.handle();
const ORDER = {title: 't.title', artist: 't.artist', album: 't.album', added: 't.addedAt',
    played: 's.lastPlayedAt', rating: 'COALESCE(r.rating,0)', duration: 't.durationSeconds'};
function bounded(value, min, max, fallback) {
    return Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.trunc(Number(value)))) : fallback;
}
function rulesWhere(rules = {}) {
    if (!rules || typeof rules !== 'object' || Array.isArray(rules)) throw new Error('Choose valid playlist rules.');
    const clauses = ['t.missing = 0'], values = [];
    for (const key of ['artist', 'album', 'genre']) {
        if (rules[key]) { clauses.push(`t.${key} = ? COLLATE NOCASE`); values.push(String(rules[key]).slice(0, 300)); }
    }
    if (rules.minRating != null) { clauses.push('COALESCE(r.rating,0) >= ?'); values.push(bounded(rules.minRating, 0, 5, 0)); }
    if (rules.unplayedDays != null) {
        clauses.push('(s.lastPlayedAt IS NULL OR s.lastPlayedAt < ?)');
        values.push(new Date(Date.now() - bounded(rules.unplayedDays, 0, 36500, 30) * 86400000).toISOString());
    }
    if (rules.maxDuration != null) { clauses.push('t.durationSeconds <= ?'); values.push(bounded(rules.maxDuration, 1, 86400, 600)); }
    return {clauses, values};
}
function catalog(options = {}) {
    const {clauses, values} = rulesWhere(options.rules);
    if (options.query) {
        clauses.push("(COALESCE(t.title,'') || ' ' || COALESCE(t.artist,'') || ' ' || COALESCE(t.album,'') || ' ' || t.basename) LIKE ? ESCAPE '\\'");
        values.push('%' + String(options.query).slice(0, 300).replace(/[\\%_]/g, '\\$&') + '%');
    }
    if (options.folder) {
        clauses.push("t.filePath LIKE ? ESCAPE '\\'");
        const prefix=String(options.folder).endsWith(path.sep)?String(options.folder):String(options.folder)+path.sep;
        values.push(prefix.replace(/[\\%_]/g, '\\$&') + '%');
    }
    const from = `FROM tracks t LEFT JOIN track_stats s ON s.filePath=t.filePath
        LEFT JOIN track_ratings r ON r.filePath=t.filePath WHERE ${clauses.join(' AND ')}`;
    const total = db().prepare('SELECT COUNT(*) AS total ' + from).get(...values).total;
    const offset = bounded(options.offset, 0, 10000000, 0), limit = bounded(options.limit, 1, 200, 100);
    const order = ORDER[options.sort] || ORDER.title, direction = options.desc ? 'DESC' : 'ASC';
    const rows = db().prepare(`SELECT t.*, COALESCE(r.rating,0) AS rating, COALESCE(s.playCount,0) AS playCount,
        s.lastPlayedAt ${from} ORDER BY ${order} COLLATE NOCASE ${direction}, t.filePath LIMIT ? OFFSET ?`)
        .all(...values, limit, offset);
    return {rows, total, offset, limit};
}
function saveSmart({id, name, rules}) {
    rulesWhere(rules);
    name = String(name || '').trim().slice(0, 80);
    if (!name) throw new Error('Give the playlist a name.');
    if (id) db().prepare('UPDATE smart_playlists SET name=?, rules=? WHERE id=?').run(name, JSON.stringify(rules), id);
    else id = db().prepare('INSERT INTO smart_playlists(name,rules,createdAt) VALUES(?,?,?)')
        .run(name, JSON.stringify(rules), new Date().toISOString()).lastInsertRowid;
    return {id};
}
function smartList() { return db().prepare('SELECT * FROM smart_playlists ORDER BY name').all()
    .map(row => ({...row, rules: JSON.parse(row.rules)})); }
function deleteSmart(id) { db().prepare('DELETE FROM smart_playlists WHERE id=?').run(id); return true; }
function groups(kind) {
    if (!['artist', 'album'].includes(kind)) throw new Error('Choose albums or artists.');
    return db().prepare(`SELECT ${kind} AS name, MIN(filePath) AS filePath, COUNT(*) AS count
        FROM tracks WHERE missing=0 AND ${kind} IS NOT NULL AND ${kind}<>'' GROUP BY ${kind} COLLATE NOCASE
        ORDER BY ${kind} COLLATE NOCASE LIMIT 2000`).all();
}
function folders() {
    const counts = new Map();
    for (const row of db().prepare('SELECT filePath FROM tracks WHERE missing=0').iterate()) {
        const dir = path.dirname(row.filePath); counts.set(dir, (counts.get(dir) || 0) + 1);
    }
    return [...counts].map(([name,count]) => ({name,count})).sort((a,b) => a.name.localeCompare(b.name));
}
function folderChildren(parent='') {
    const nodes=new Map();
    for(const row of db().prepare('SELECT filePath FROM tracks WHERE missing=0').iterate()) {
        if(!path.isAbsolute(row.filePath))continue;
        const dir=path.dirname(row.filePath);let name;
        if(!parent)name=path.parse(dir).root;
        else {const relative=path.relative(parent,dir);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))continue;
            name=path.join(parent,relative.split(path.sep)[0]);}
        if(!nodes.has(name))nodes.set(name,{name,count:0,hasChildren:false});
        const node=nodes.get(name);node.count++;if(dir!==name)node.hasChildren=true;
    }
    return [...nodes.values()].sort((a,b)=>a.name.localeCompare(b.name));
}
function record(filePath, listenedMs, outcome) {
    if (typeof filePath !== 'string' || !filePath || !Number.isFinite(listenedMs)) return;
    db().prepare('INSERT INTO play_history(filePath,listenedMs,outcome,playedAt) VALUES(?,?,?,?)')
        .run(filePath, Math.max(0, Math.round(listenedMs)), outcome === 'skip' ? 'skip' : 'play', new Date().toISOString());
    db().prepare('DELETE FROM play_history WHERE id NOT IN (SELECT id FROM play_history ORDER BY id DESC LIMIT 10000)').run();
}
function history() { return db().prepare(`SELECT h.*, t.title, t.artist FROM play_history h
    LEFT JOIN tracks t ON t.filePath=h.filePath ORDER BY h.id DESC LIMIT 200`).all(); }
function duplicates() {
    // Candidate groups only: equal tags/duration are not proof of identical audio.
    const groups = new Map();
    for (const row of db().prepare('SELECT filePath,title,artist,durationSeconds,fileSize FROM tracks WHERE missing=0').iterate()) {
        if (!row.title || !row.artist || !row.durationSeconds) continue;
        const key = [row.title.trim().toLowerCase(), row.artist.trim().toLowerCase(), Math.round(row.durationSeconds)].join('\0');
        if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row);
    }
    return [...groups.values()].filter(rows => rows.length > 1).slice(0, 500);
}
function bookmark({filePath, seconds, label}) {
    if (typeof filePath !== 'string' || !filePath || !Number.isFinite(seconds) || seconds < 0)
        throw new Error('Load a song and choose a valid position.');
    db().prepare(`INSERT INTO bookmarks(filePath,seconds,label) VALUES(?,?,?)
        ON CONFLICT(filePath,seconds) DO UPDATE SET label=excluded.label`)
        .run(filePath, seconds, String(label || 'Cue').trim().slice(0, 100));
    return bookmarks(filePath);
}
function bookmarks(filePath) { return db().prepare('SELECT * FROM bookmarks WHERE filePath=? ORDER BY seconds').all(filePath); }
function deleteBookmark(id) { db().prepare('DELETE FROM bookmarks WHERE id=?').run(id); return true; }
function reorderPlaylist({id, paths}) {
    const existing = db().prepare('SELECT filePath FROM playlist_items WHERE playlistId=?').all(id).map(r => r.filePath);
    if (!Array.isArray(paths) || paths.length !== existing.length || new Set(paths).size !== paths.length ||
        existing.some(p => !paths.includes(p))) throw new Error('The playlist changed. Refresh it and try again.');
    db().transaction(() => paths.forEach((p,i) => db().prepare('UPDATE playlist_items SET position=? WHERE playlistId=? AND filePath=?').run(i,id,p)))();
    return true;
}
function extraBackup() { return {smart: smartList(), history: db().prepare('SELECT * FROM play_history').all(),
    bookmarks: db().prepare('SELECT * FROM bookmarks').all()}; }
function importExtra(data) {
    for (const row of data?.smart || []) { if (!smartList().some(p => p.name.toLowerCase()===String(row.name).toLowerCase())) saveSmart({name:row.name,rules:row.rules}); }
    for (const row of data?.bookmarks || []) { bookmark(row); }
    for (const row of data?.history || []) {
        if (typeof row.filePath !== 'string' || !Number.isFinite(row.listenedMs) || typeof row.playedAt !== 'string') continue;
        if (!db().prepare('SELECT id FROM play_history WHERE filePath=? AND playedAt=? AND outcome=?').get(row.filePath,row.playedAt,row.outcome))
            db().prepare('INSERT INTO play_history(filePath,listenedMs,outcome,playedAt) VALUES(?,?,?,?)')
                .run(row.filePath,Math.max(0,row.listenedMs),row.outcome==='skip'?'skip':'play',row.playedAt);
    }
}
module.exports = {catalog, rulesWhere, saveSmart, smartList, deleteSmart, groups, folders,folderChildren, record, history,
    duplicates, bookmark, bookmarks, deleteBookmark, reorderPlaylist, extraBackup, importExtra};
