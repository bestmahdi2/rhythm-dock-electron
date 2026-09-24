'use strict';

/**
 * Rhythm Dock room server.
 *
 * Runs on your VPS. Responsibilities, in order of importance:
 *
 *   1. Rendezvous: hand out room codes and let members find each other.
 *   2. State fan-out: mirror the host's playback state, queue, lyrics and settings to
 *      every member, and forward controller intents back to the host.
 *   3. Audio relay: stream the host's files to listeners; hold guest contributions
 *      temporarily until the host imports them.
 *   4. Clock: be the single authority members synchronise against.
 *
 * Room state is in memory. Guest upload files live in a temporary directory and
 * expire after two days; a restart deletes that temporary directory.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const {WebSocketServer} = require('ws');

const protocol = require('./protocol');
const {RoomRegistry} = require('./rooms');
const {AudioRelay, parseRange} = require('./relay');
const {TelegramIntake} = require('./telegram');

const {ROLES, CLIENT, SERVER} = protocol;

const PORT = parseInt(process.env.PORT || '8420', 10);
const HOST = process.env.HOST || '0.0.0.0';
// Set this to require a shared secret before anyone may CREATE a room, so a public
// server does not become an open relay. Joining still only needs the room code.
const CREATE_SECRET = process.env.CREATE_SECRET || '';
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS || '50', 10);

// A member that stops answering pings is dropped, otherwise half-open TCP connections
// accumulate and the member list fills with ghosts.
const HEARTBEAT_MS = 30000;

const app = express();
app.disable('x-powered-by');
app.use(express.json({limit: '1mb'}));

const registry = new RoomRegistry();
const relay = new AudioRelay();
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const UPLOAD_TTL_MS = 2 * 24 * 60 * 60 * 1000;
const UPLOAD_EXTENSIONS = new Set(['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.opus', '.aac', '.wma', '.aiff']);
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhythm-dock-uploads-'));
const uploads = new Map();
function hasUploadCapacity(roomCode) {
    return uploads.size < 100 && [...uploads.values()].filter((item) => item.roomCode === roomCode).length < 10;
}
const telegram = new TelegramIntake({token: process.env.TELEGRAM_BOT_TOKEN || '', registry,
    onAudio: async ({room, fileName, bytes, chatId}) => {
        if (!room.hostOnline) throw new Error('The host is offline');
        if (!hasUploadCapacity(room.code)) throw new Error('Too many pending songs; try again after the host imports them');
        const extension = path.extname(fileName).toLowerCase();
        if (!UPLOAD_EXTENSIONS.has(extension) || bytes.length > 20 * 1024 * 1024)
            throw new Error('Unsupported song or over the Telegram 20 MB limit');
        const id = crypto.randomBytes(18).toString('hex');
        const filePath = path.join(uploadDir, id + extension);
        fs.writeFileSync(filePath, bytes, {flag: 'wx'});
        uploads.set(id, {filePath, roomCode: room.code, fileName, size: bytes.length,
            position: 'end', at: Date.now(), chatId});
        send(room.host.socket, 'upload:ready', {id, fileName, size: bytes.length,
            position: 'end', by: {id: `telegram:${chatId}`, name: 'Telegram'}});
    },
});

// --- HTTP -----------------------------------------------------------------------

app.get('/healthz', (_req, res) => res.json({ok: true, ...registry.stats()}));

/** Creates a room. The response contains the host token, so it is returned exactly once. */
app.post('/api/rooms', (req, res) => {
    if (CREATE_SECRET && req.body.secret !== CREATE_SECRET) {
        return res.status(401).json({error: 'invalid create secret'});
    }
    if (registry.rooms.size >= MAX_ROOMS) {
        return res.status(503).json({error: 'server is at capacity'});
    }

    const room = registry.create({
        name: req.body.name,
        password: req.body.password,
        defaultRole: req.body.everyoneCanControl === false ? ROLES.LISTENER : ROLES.CONTROLLER,
    });

    console.log(`[rooms] Created ${room.code}`);
    res.json({code: room.code, hostToken: room.hostToken, ...room.summary()});
});

/** Public room info, so a joiner can be told "wrong code" vs "needs a password". */
app.get('/api/rooms/:code', (req, res) => {
    const room = registry.get(req.params.code);
    if (!room) return res.status(404).json({error: 'no such room'});
    res.json(room.summary());
});

app.post('/api/rooms/:code/telegram-pair', async (req, res) => {
    const room = registry.get(req.params.code);
    const a = crypto.createHash('sha256').update(req.get('Authorization') || '').digest();
    const b = crypto.createHash('sha256').update(`Bearer ${room?.hostToken || ''}`).digest();
    if (!room || !crypto.timingSafeEqual(a, b)) return res.sendStatus(403);
    if (!telegram.enabled) return res.status(503).json({error: 'Telegram bot is not configured'});
    try {
        const bot = await telegram.call('getMe', {});
        res.json({code: telegram.createPairCode(room), expiresInSeconds: 600,
            botUsername: bot.username});
    } catch (_) { res.status(503).json({error: 'Telegram bot is not reachable'}); }
});

// A controller may contribute one bounded audio file. Only the authenticated host
// can fetch it; pending bytes expire and are removed after successful import.
app.post('/api/rooms/:code/uploads', (req, res) => {
    const room = registry.get(req.params.code);
    const member = room && [...room.members.values()].find((item) =>
        item.id === req.get('X-Member-Id') &&
        item.uploadToken === req.get('X-Upload-Token'));
    if (!member || member.role !== ROLES.CONTROLLER) return res.status(403).json({error: 'controller access required'});
    if (!room.hostOnline) return res.status(409).json({error: 'host is offline'});
    if (!hasUploadCapacity(room.code)) return res.status(429).json({error: 'too many pending songs'});
    let fileName;
    try { fileName = path.basename(decodeURIComponent(req.get('X-File-Name') || '')); }
    catch (_) { return res.status(400).json({error: 'invalid file name'}); }
    const extension = path.extname(fileName).toLowerCase();
    if (!UPLOAD_EXTENSIONS.has(extension)) return res.status(415).json({error: 'unsupported audio type'});
    const length = Number(req.get('Content-Length'));
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_UPLOAD_BYTES)
        return res.status(413).json({error: 'file exceeds 30 MB limit'});
    const position = ['first', 'next', 'end'].includes(req.query.position) ? req.query.position : 'end';
    const id = crypto.randomBytes(18).toString('hex');
    const filePath = path.join(uploadDir, id + extension);
    const output = fs.createWriteStream(filePath, {flags: 'wx'});
    let received = 0;
    let failed = false;
    const fail = (status, error) => {
        if (failed) return;
        failed = true;
        output.destroy();
        fs.rm(filePath, {force: true}, () => {});
        if (!res.headersSent) res.status(status).json({error});
    };
    req.on('data', (chunk) => {
        received += chunk.length;
        if (received > MAX_UPLOAD_BYTES || received > length) {
            fail(413, 'file exceeds declared size');
            req.destroy();
        }
    });
    req.on('aborted', () => fail(400, 'upload aborted'));
    output.on('error', () => fail(500, 'upload failed'));
    output.on('finish', () => {
        if (failed) return;
        if (received !== length) return fail(400, 'incomplete upload');
        uploads.set(id, {filePath, roomCode: room.code, fileName, size: received, position,
            memberId: member.id, at: Date.now()});
        send(room.host.socket, 'upload:ready', {id, fileName, size: received, position, by: {id: member.id, name: member.name}});
        res.status(201).json({id, status: 'pending'});
    });
    req.pipe(output);
});

app.get('/api/rooms/:code/uploads/:id', (req, res) => {
    const room = registry.get(req.params.code);
    const upload = uploads.get(req.params.id);
    if (!room || !upload || upload.roomCode !== room.code) return res.sendStatus(404);
    const a = crypto.createHash('sha256').update(req.get('Authorization') || '').digest();
    const b = crypto.createHash('sha256').update(`Bearer ${room.hostToken}`).digest();
    if (!crypto.timingSafeEqual(a, b)) return res.sendStatus(403);
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Length', String(upload.size));
    fs.createReadStream(upload.filePath).on('error', () => res.destroy()).pipe(res);
});

app.delete('/api/rooms/:code/uploads/:id', (req, res) => {
    const room = registry.get(req.params.code);
    const upload = uploads.get(req.params.id);
    if (!room || !upload || upload.roomCode !== room.code) return res.sendStatus(404);
    const a = crypto.createHash('sha256').update(req.get('Authorization') || '').digest();
    const b = crypto.createHash('sha256').update(`Bearer ${room.hostToken}`).digest();
    if (!crypto.timingSafeEqual(a, b)) return res.sendStatus(403);
    uploads.delete(req.params.id);
    fs.rm(upload.filePath, {force: true}, () => {});
    if (upload.memberId) send(room.members.get(upload.memberId)?.socket, 'upload:accepted', {id: req.params.id});
    if (upload.chatId) telegram.reply(upload.chatId, 'The host imported your song.').catch(() => {});
    res.sendStatus(204);
});

/**
 * Audio endpoint. The <audio> element on a listener points here; the bytes come from
 * the host over the relay.
 */
app.get('/api/rooms/:code/stream/:trackId', (req, res) => {
    const room = registry.get(req.params.code);
    if (!room) return res.status(404).json({error: 'no such room'});

    // A password-protected room must not leak audio to anyone who guesses the code.
    if (room.passwordHash && !room.checkPassword(req.query.password)) {
        return res.status(403).json({error: 'password required'});
    }

    const range = parseRange(req.headers.range) || {start: 0, end: null, suffixLength: null};
    relay.request({room, trackId: req.params.trackId, range, response: res});
});

// The browser client, so phones need no install.
app.use(express.static(path.join(__dirname, '..', 'public'), {maxAge: '1h'}));

// SPA fallback: any unmatched GET renders the client, so /r/ABC123 deep links work.
//
// Written as middleware rather than app.get('*'), because Express 5 switched to
// path-to-regexp v8, which rejects a bare '*' as a malformed pattern. Middleware
// behaves identically on both v4 and v5.
app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    // Never swallow a mistyped API call into the HTML page; a 404 is far easier to debug.
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// --- WebSocket --------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({server, path: '/ws', maxPayload: 8 * 1024 * 1024});

function send(socket, type, payload = {}) {
    if (!socket || socket.readyState !== 1) return;
    try {
        socket.send(JSON.stringify({type, ...payload}));
    } catch (error) {
        console.error('[ws] send failed:', error.message);
    }
}

/** Sends to every member except, optionally, one. */
function broadcast(room, type, payload, exceptId = null) {
    for (const member of room.members.values()) {
        if (member.id === exceptId) continue;
        send(member.socket, type, payload);
    }
}

function broadcastMembers(room) {
    broadcast(room, SERVER.MEMBERS, {members: room.memberList()});
}

wss.on('connection', (socket, request) => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });

    /** @type {{room: import('./rooms').Room, memberId: string}|null} */
    let session = null;

    socket.on('message', (data, isBinary) => {
        // --- Binary: relay audio chunks from the host. ---
        if (isBinary) {
            if (!session || session.room.hostId !== session.memberId) return;
            const shouldPause = relay.onChunk(Buffer.from(data));
            if (shouldPause) {
                // Backpressure: tell the host to wait for the listener to catch up.
                send(socket, 'stream:pause', {});
            }
            return;
        }

        let message;
        try {
            message = JSON.parse(data.toString());
        } catch (_) {
            return send(socket, SERVER.ERROR, {error: 'malformed message'});
        }

        // --- Handshake must come first. ---
        if (!session) {
            if (message.type !== CLIENT.HELLO) {
                return send(socket, SERVER.ERROR, {error: 'expected hello'});
            }
            return handleHello(message);
        }

        const {room, memberId} = session;
        const member = room.members.get(memberId);
        if (!member) return;

        member.lastSeen = Date.now();
        handleMessage(room, member, message);
    });

    socket.on('close', () => {
        if (!session) return;
        const {room, memberId} = session;
        const wasHost = room.hostId === memberId;
        const member = room.removeMember(memberId);
        if (!member) return;

        console.log(`[ws] ${member.name} left ${room.code}${wasHost ? ' (host)' : ''}`);

        if (wasHost) {
            // Every in-flight audio read is now unanswerable.
            relay.abortAll('host disconnected');
            broadcast(room, SERVER.HOST_GONE, {graceMs: 120000});
            broadcast(room, SERVER.STATE, {state: room.state, serverTime: Date.now()});
        }
        broadcastMembers(room);
    });

    socket.on('error', (error) => console.error('[ws] socket error:', error.message));

    function handleHello(message) {
        const room = registry.get(message.roomCode);
        if (!room) return send(socket, SERVER.ERROR, {error: 'no such room', fatal: true});

        if (!room.checkPassword(message.password)) {
            return send(socket, SERVER.ERROR, {error: 'wrong password', fatal: true});
        }

        const result = room.addMember({
            socket,
            name: message.name,
            role: message.role,
            hostToken: message.hostToken,
        });

        if (result.error) {
            return send(socket, SERVER.ERROR, {error: result.error, fatal: true});
        }

        const member = result.member;
        session = {room, memberId: member.id};

        const isReturningHost = member.role === ROLES.HOST && room.hostLostAt !== null;

        send(socket, SERVER.WELCOME, {
            protocolVersion: protocol.PROTOCOL_VERSION,
            memberId: member.id,
            uploadToken: member.role === ROLES.CONTROLLER ? member.uploadToken : undefined,
            role: member.role,
            room: room.summary(),
            // Everything a joiner needs to render immediately, in one message.
            state: room.state,
            settings: room.settings,
            library: room.library,
            lyrics: room.lyrics,
            members: room.memberList(),
            serverTime: Date.now(),
        });

        console.log(`[ws] ${member.name} joined ${room.code} as ${member.role}`);
        broadcastMembers(room);

        if (member.role === ROLES.HOST && isReturningHost) {
            for (const [id, upload] of uploads) {
                if (upload.roomCode === room.code) send(socket, 'upload:ready', {
                    id, fileName: upload.fileName, size: upload.size, position: upload.position,
                    by: {id: 'pending', name: 'Pending upload'},
                });
            }
            broadcast(room, SERVER.HOST_BACK, {}, member.id);
        }
    }
});

/** Routes an authenticated message. */
function handleMessage(room, member, message) {
    const isHost = member.id === room.hostId;

    switch (message.type) {
        // --- Clock synchronisation, open to everyone including listeners. ---
        case CLIENT.TIME_PING:
            // t0 echoes back untouched; the client measures round trip and derives its
            // offset from t1. Doing the arithmetic client-side keeps the server stateless.
            return send(member.socket, SERVER.TIME_PONG, {t0: message.t0, t1: Date.now()});

        case CLIENT.PING:
            return send(member.socket, SERVER.PONG, {serverTime: Date.now()});

        // --- Host-only publications. ---
        case CLIENT.STATE: {
            if (!isHost) return;
            room.state = {
                ...protocol.makeState(),
                ...message.state,
                // The host's clock is not the room's clock. Stamping server-side is what
                // makes projectPosition() correct for members with skewed clocks.
                atServerTime: Date.now(),
            };
            return broadcast(room, SERVER.STATE, {state: room.state, serverTime: Date.now()}, member.id);
        }

        case CLIENT.LIBRARY: {
            if (!isHost) return;
            room.library = {
                tracks: Array.isArray(message.tracks) ? message.tracks : [],
                queue: Array.isArray(message.queue) ? message.queue : [],
                updatedAt: Date.now(),
            };
            return broadcast(room, SERVER.LIBRARY, {library: room.library}, member.id);
        }

        case CLIENT.LYRICS: {
            if (!isHost) return;
            room.lyrics = {
                trackId: message.trackId || null,
                lines: Array.isArray(message.lines) ? message.lines : [],
                isSynced: Boolean(message.isSynced),
                translation: message.translation || null,
            };
            return broadcast(room, SERVER.LYRICS, {lyrics: room.lyrics}, member.id);
        }

        case CLIENT.SETTINGS: {
            if (!isHost) return;
            room.settings = {...protocol.makeSettings(), ...message.settings};
            return broadcast(room, SERVER.SETTINGS, {settings: room.settings}, member.id);
        }

        // --- Relay responses. ---
        case CLIENT.STREAM_META:
            if (!isHost) return;
            return relay.onMeta(message.id, message.meta || {});

        case CLIENT.STREAM_ERROR:
            if (!isHost) return;
            return relay.onError(message.id, message.reason);

        // --- Control intents, forwarded to the host. ---
        case CLIENT.CONTROL: {
            // This is the listener ("only-viewer") gate. A listener may receive
            // everything but may never influence playback.
            if (!protocol.can(member.role, 'control')) {
                return send(member.socket, SERVER.ERROR, {error: 'you are in listen-only mode'});
            }
            if (!protocol.CONTROL_ACTIONS.has(message.action)) {
                return send(member.socket, SERVER.ERROR, {error: 'unknown action'});
            }
            const host = room.host;
            if (!host) return send(member.socket, SERVER.ERROR, {error: 'host is offline'});

            return send(host.socket, SERVER.CONTROL, {
                action: message.action,
                value: message.value,
                by: {id: member.id, name: member.name},
            });
        }

        // --- Membership management, host only. ---
        case CLIENT.MEMBER_UPDATE: {
            if (!protocol.can(member.role, 'manageMembers')) return;
            if (room.setRole(message.memberId, message.role)) {
                const target = room.members.get(message.memberId);
                send(target.socket, SERVER.WELCOME, {
                    roleChanged: true, role: target.role, memberId: target.id,
                    uploadToken: target.role === ROLES.CONTROLLER ? target.uploadToken : undefined,
                    state: room.state, settings: room.settings, library: room.library,
                    lyrics: room.lyrics, members: room.memberList(),
                    room: room.summary(), serverTime: Date.now(),
                    protocolVersion: protocol.PROTOCOL_VERSION,
                });
                broadcastMembers(room);
            }
            return;
        }

        case CLIENT.KICK: {
            if (!protocol.can(member.role, 'manageMembers')) return;
            const target = room.members.get(message.memberId);
            if (!target || target.id === room.hostId) return;
            send(target.socket, SERVER.KICKED, {});
            try {
                target.socket.close(4001, 'removed by host');
            } catch (_) { /* already gone */ }
            return;
        }

        default:
            return send(member.socket, SERVER.ERROR, {error: `unknown message type: ${message.type}`});
    }
}

// Drop half-open connections.
const heartbeat = setInterval(() => {
    for (const [id, upload] of uploads) {
        if (Date.now() - upload.at > UPLOAD_TTL_MS || !registry.get(upload.roomCode)) {
            uploads.delete(id);
            fs.rm(upload.filePath, {force: true}, () => {});
        }
    }
    for (const socket of wss.clients) {
        if (socket.isAlive === false) {
            socket.terminate();
            continue;
        }
        socket.isAlive = false;
        try {
            socket.ping();
        } catch (_) { /* closing */ }
    }
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeat));

if (telegram.enabled) telegram.start();

server.listen(PORT, HOST, () => {
    console.log(`Rhythm Dock room server listening on http://${HOST}:${PORT}`);
    if (!CREATE_SECRET) {
        console.warn('[warn] CREATE_SECRET is not set - anyone who can reach this server can create rooms.');
    }
});

// Containers send SIGTERM; exit cleanly so members get a close frame rather than a
// dangling socket that takes 30s to time out.
for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        console.log(`\n[server] ${signal} received, shutting down`);
        clearInterval(heartbeat);
        telegram.stop();
        for (const socket of wss.clients) {
            try {
                socket.close(1001, 'server shutting down');
            } catch (_) { /* already gone */ }
        }
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
    });
}

module.exports = {app, server, registry};
