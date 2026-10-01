'use strict';

/**
 * Room client for the desktop app (main process).
 *
 * Two modes:
 *
 *   HOST      — this machine owns the music. It publishes playback state, the queue,
 *               lyrics and settings, answers relay requests by reading files off disk,
 *               and applies control intents forwarded from members.
 *   MEMBER    — this machine joins someone else's room and behaves like the browser
 *               client, but inside the app.
 *
 * File reads happen here in the main process rather than the renderer, because only
 * main has fs access and because a 5MB chunk should never cross the IPC bridge.
 *
 * Security note: a member can only ask for a trackId, never a path. The map from
 * trackId to a real path is held here and is populated exclusively from the host's own
 * published library, so a malicious member cannot ask for /etc/passwd.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

// 64KB chunks: large enough that per-frame overhead is negligible, small enough that a
// listener seeking mid-file does not wait for a huge read to finish.
const CHUNK_BYTES = 64 * 1024;
const HEADER_BYTES = 16;
const FLAG_FINAL = 1;

const MIME_TYPES = {
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.opus': 'audio/opus', '.wma': 'audio/x-ms-wma', '.aiff': 'audio/aiff',
    '.mp4': 'video/mp4',
};

function mimeFor(filePath) {
    return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/** Stable, non-reversible id for a path. Members never see the path itself. */
function trackIdFor(filePath) {
    return crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16);
}

class RoomClient {
    /**
     * @param {object} options
     * @param {(event: string, payload: any) => void} options.emit  Forwards to the renderer.
     */
    constructor(options = {}) {
        this.emit = options.emit || (() => {});

        this.socket = null;
        this.serverUrl = null;
        this.roomCode = null;
        this.hostToken = null;
        this.password = '';
        this.role = null;
        this.memberId = null;
        this.uploadToken = null;
        this.connected = false;

        /** @type {Map<string, string>} trackId -> absolute path */
        this.trackPaths = new Map();
        this.trackSources = new Map();
        /** @type {Map<string, {cancelled: boolean, paused: boolean}>} */
        this.activeStreams = new Map();

        this.reconnectTimer = null;
        this.reconnectDelay = 1000;
        this.shouldReconnect = false;
    }

    get isHost() {
        return this.role === 'host';
    }

    // --- Room lifecycle ---------------------------------------------------------

    /**
     * Creates a room on the server and connects as its host.
     * @param {string} serverUrl e.g. https://music.example.com
     */
    async createRoom(serverUrl, {name, password, everyoneCanControl = true, secret} = {}) {
        const base = String(serverUrl).replace(/\/+$/, '');

        const response = await fetch(`${base}/api/rooms`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name, password, everyoneCanControl, secret}),
        });

        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error || `Server returned ${response.status}`);
        }

        const room = await response.json();

        this.serverUrl = base;
        this.roomCode = room.code;
        this.hostToken = room.hostToken;
        this.password = password || '';

        await this.connect({role: 'host', name: name || 'Host'});
        return room;
    }

    /** Joins an existing room as a member. */
    async joinRoom(serverUrl, code, {name, password} = {}) {
        this.serverUrl = String(serverUrl).replace(/\/+$/, '');
        this.roomCode = String(code).toUpperCase();
        this.hostToken = null;
        this.password = password || '';

        await this.connect({role: 'listener', name: name || 'Guest'});
        return {code: this.roomCode};
    }

    connect({role, name}) {
        return new Promise((resolve, reject) => {
            clearTimeout(this.reconnectTimer);
            for (const stream of this.activeStreams.values()) stream.cancelled = true;
            this.activeStreams.clear();
            if (this.socket) this.socket.terminate();
            this.connected = false;
            const wsUrl = this.serverUrl.replace(/^http/, 'ws') + '/ws';
            const socket = new WebSocket(wsUrl);
            this.socket = socket;
            this.shouldReconnect = true;
            this._pendingHello = {role, name};
            let welcomed = false;
            const handshake = setTimeout(() => {
                this.shouldReconnect = false;
                reject(new Error('The room connection timed out. Check the server address.'));
                socket.terminate();
            }, 10000);

            const onError = (error) => { clearTimeout(handshake); reject(error); };
            socket.once('error', onError);

            socket.on('open', () => {
                socket.off('error', onError);
                this.reconnectDelay = 1000;
                this._send({
                    type: 'hello',
                    roomCode: this.roomCode,
                    password: this.password,
                    hostToken: this.hostToken,
                    role,
                    name,
                });
            });

            socket.on('message', (data, isBinary) => {
                if (this.socket !== socket) return;
                if (isBinary) return;
                let message;
                try {
                    message = JSON.parse(data.toString());
                } catch (_) {
                    return;
                }

                if (message.type === 'welcome' && !this.connected) {
                    welcomed = true;
                    clearTimeout(handshake);
                    this.connected = true;
                    this.role = message.role;
                    this.memberId = message.memberId;
                    this.uploadToken = message.uploadToken || null;
                    resolve(message);
                }
                if (message.type === 'error' && message.fatal) {
                    this.shouldReconnect = false;
                    clearTimeout(handshake);
                    reject(new Error(message.error || 'Could not join the room.'));
                    socket.close();
                }
                this._handle(message);
            });

            socket.on('close', (code) => {
                clearTimeout(handshake);
                if (this.socket !== socket) return;
                if (!welcomed) reject(new Error('The room connection closed before joining.'));
                this.connected = false;
                this.emit('room:disconnected', {code});
                // 4000/4001 are deliberate closures (room gone, kicked); do not fight them.
                if (this.shouldReconnect && code !== 4000 && code !== 4001) {
                    this._scheduleReconnect();
                }
            });

            socket.on('error', (error) => {
                this.emit('room:error', {error: error.message});
            });
        });
    }

    _scheduleReconnect() {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            this.emit('room:reconnecting', {});
            this.connect(this._pendingHello).catch(() => { if (this.shouldReconnect) this._scheduleReconnect(); });
        }, this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15000);
    }

    leave() {
        this.shouldReconnect = false;
        clearTimeout(this.reconnectTimer);
        for (const stream of this.activeStreams.values()) stream.cancelled = true;
        this.activeStreams.clear();
        if (this.socket) {
            try {
                this.socket.close(1000, 'left');
            } catch (_) { /* already closed */ }
        }
        this.connected = false;
        this.role = null;
        this.uploadToken = null;
        this.roomCode = null;
    }

    _send(message) {
        if (!this.socket || this.socket.readyState !== 1) return false;
        try {
            this.socket.send(JSON.stringify(message));
            return true;
        } catch (_) {
            return false;
        }
    }

    // --- Host publishing --------------------------------------------------------

    /**
     * Publishes the queue. Paths are converted to opaque ids here — this is the only
     * place the id/path mapping is created.
     */
    publishLibrary(queuePaths, trackInfo = {}, catalog = []) {
        if (!this.isHost) return;

        this.trackPaths.clear();
        this.trackSources.clear();
        const describe = (filePath, info = {}) => {
            const id = trackIdFor(filePath);
            this.trackPaths.set(id, info.playbackPath || filePath);
            this.trackSources.set(id, filePath);
            return {
                id,
                title: info.title || path.basename(filePath, path.extname(filePath)),
                artist: info.artist || '',
                album: info.album || '',
                durationMs: info.durationMs || Math.round((info.durationSeconds || 0) * 1000),
            };
        };
        const tracks = catalog.map((track) => describe(track.filePath, track));
        const queue = queuePaths.map((filePath) => describe(filePath, trackInfo[filePath] || {}));

        this._send({type: 'library', queue, tracks});
    }

    publishState(state) {
        if (!this.isHost) return;
        this._send({type: 'state', state});
    }

    publishLyrics({trackPath, lines, isSynced, translation}) {
        if (!this.isHost) return;
        this._send({
            type: 'lyrics',
            trackId: trackPath ? trackIdFor(trackPath) : null,
            lines,
            isSynced,
            translation,
        });
    }

    publishSettings(settings) {
        if (!this.isHost) return;
        this._send({type: 'settings', settings});
    }

    setMemberRole(memberId, role) {
        this._send({type: 'member:update', memberId, role});
    }

    kickMember(memberId) {
        this._send({type: 'member:kick', memberId});
    }

    /** Member-side: ask the host to do something. */
    sendControl(action, value) {
        this._send({type: 'control', action, value});
    }

    // --- Message handling -------------------------------------------------------

    _handle(message) {
        switch (message.type) {
            case 'welcome':
                this.role = message.role;
                this.uploadToken = message.uploadToken || null;
                this.emit('room:welcome', message);
                break;

            case 'stream:request':
                // Host only: a listener wants bytes.
                this._serveRange(message);
                break;

            case 'stream:cancel': {
                const stream = this.activeStreams.get(message.id);
                if (stream) stream.cancelled = true;
                break;
            }

            case 'stream:pause': {
                // Backpressure from the server: a listener is behind.
                const stream = this.activeStreams.get(message.id);
                if (stream) stream.paused = true;
                break;
            }

            case 'control':
                // Only the host acts on these; the renderer performs the action.
                this.emit('room:control', message);
                break;

            case 'upload:ready':
                if (this.isHost) this.emit('room:upload-ready', message);
                break;
            case 'link:ready':
                if (this.isHost) this.emit('room:link-ready', message);
                break;
            case 'upload:accepted':
                this.emit('room:upload-accepted', message);
                break;

            case 'state':    this.emit('room:state', message); break;
            case 'library':  this.emit('room:library', message); break;
            case 'lyrics':   this.emit('room:lyrics', message); break;
            case 'settings': this.emit('room:settings', message); break;
            case 'members':  this.emit('room:members', message); break;
            case 'host:gone': this.emit('room:host-gone', message); break;
            case 'host:back': this.emit('room:host-back', message); break;
            case 'kicked':   this.shouldReconnect = false; this.emit('room:kicked', {}); break;
            case 'error':    this.emit('room:error', message); break;
        }
    }

    // --- Relay: serving file bytes ---------------------------------------------

    /**
     * Answers a stream:request by streaming the requested byte range back as binary
     * frames.
     *
     * Reads are done chunk by chunk with an explicit position rather than with a
     * ReadStream, because the server may ask us to pause (backpressure) and resuming a
     * paused ReadStream mid-flight is far more error-prone than simply not issuing the
     * next read.
     */
    async _serveRange({id, trackId, start, end}) {
        if (!this.isHost) return;

        const filePath = this.trackPaths.get(trackId);
        // An unknown id is either a stale request or someone probing. Either way, no.
        if (!filePath) {
            return this._send({type: 'stream:error', id, reason: 'unknown track'});
        }

        let handle = null;
        try {
            const stats = await fs.promises.stat(filePath);
            const size = stats.size;

            const rangeStart = Number.isFinite(start) && start !== null ? Math.max(0, start) : 0;
            const rangeEnd = Number.isFinite(end) && end !== null
                ? Math.min(end, size - 1)
                : size - 1;

            if (rangeStart > rangeEnd || rangeStart >= size) {
                return this._send({type: 'stream:error', id, reason: 'range not satisfiable'});
            }

            this._send({
                type: 'stream:meta',
                id,
                meta: {
                    size,
                    start: rangeStart,
                    end: rangeEnd,
                    mime: mimeFor(filePath),
                    partial: !(rangeStart === 0 && rangeEnd === size - 1),
                },
            });

            const stream = {cancelled: false, paused: false};
            this.activeStreams.set(id, stream);

            handle = await fs.promises.open(filePath, 'r');

            const idBytes = Buffer.from(trackId ? id : id, 'hex');
            let position = rangeStart;
            let sequence = 0;

            while (position <= rangeEnd) {
                if (stream.cancelled) break;

                // Wait out backpressure rather than buffering into the socket.
                while (stream.paused && !stream.cancelled) {
                    await new Promise((resolve) => setTimeout(resolve, 60));
                    // The server clears the pause implicitly once it drains; give it a
                    // window, then resume. A permanently stuck listener is handled by
                    // the server's own request timeout.
                    stream.paused = false;
                }

                const toRead = Math.min(CHUNK_BYTES, rangeEnd - position + 1);
                const buffer = Buffer.alloc(toRead);
                const {bytesRead} = await handle.read(buffer, 0, toRead, position);
                if (bytesRead === 0) break;

                position += bytesRead;
                const isFinal = position > rangeEnd;

                const header = Buffer.alloc(HEADER_BYTES);
                idBytes.copy(header, 0, 0, 8);
                header.writeUInt32BE(sequence++, 8);
                header.writeUInt32BE(isFinal ? FLAG_FINAL : 0, 12);

                if (this.socket && this.socket.readyState === 1) {
                    this.socket.send(Buffer.concat([header, buffer.subarray(0, bytesRead)]));
                } else {
                    break;
                }
            }

            // Always terminate the response, or the listener's HTTP request hangs until
            // the server's timeout fires.
            if (!stream.cancelled && this.socket && this.socket.readyState === 1) {
                const header = Buffer.alloc(HEADER_BYTES);
                idBytes.copy(header, 0, 0, 8);
                header.writeUInt32BE(sequence, 8);
                header.writeUInt32BE(FLAG_FINAL, 12);
                this.socket.send(header);
            }
        } catch (error) {
            console.error('[room] Failed to serve range:', error);
            this._send({type: 'stream:error', id, reason: error.code || error.message});
        } finally {
            if (handle) await handle.close().catch(() => {});
            this.activeStreams.delete(id);
        }
    }
}

module.exports = {RoomClient, trackIdFor, mimeFor, CHUNK_BYTES};
