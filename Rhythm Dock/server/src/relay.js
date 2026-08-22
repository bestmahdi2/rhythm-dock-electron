'use strict';

/**
 * Audio relay.
 *
 * The host's music lives on the host's disk. The VPS must serve it to listeners without
 * ever storing it, so an HTTP request from a listener is translated into a request over
 * the host's WebSocket, and the bytes the host sends back are piped into the HTTP
 * response:
 *
 *   listener  --HTTP GET (Range: bytes=0-)-->  VPS
 *   VPS       --ws {stream:request, id, range}-->  host
 *   host      --ws binary [16-byte header][chunk]-->  VPS
 *   VPS       --HTTP 206 body-->  listener
 *
 * Why binary frames rather than JSON: a 64KB chunk base64-encoded inside JSON becomes
 * ~85KB and has to be parsed as a string. Raw binary with a small fixed header costs
 * nothing.
 *
 * Frame layout, big-endian:
 *   bytes 0..15   request id, hex-decoded (8 bytes) + sequence number (uint32) + flags (uint32)
 *   bytes 16..    payload
 *
 * flags bit 0 = final chunk.
 */

const crypto = require('crypto');

const HEADER_BYTES = 16;
const FLAG_FINAL = 1;

// A stalled host must not pin a listener's HTTP socket open forever.
const REQUEST_TIMEOUT_MS = 20000;
// Backpressure guard: if a listener reads slower than the host sends, stop asking for
// more until the response drains. Without this a fast host + slow phone grows the
// Node process heap without bound.
const HIGH_WATER_MARK = 4 * 1024 * 1024;

class RelayRequest {
    constructor(id, response) {
        this.id = id;
        this.response = response;
        this.bytesWritten = 0;
        this.finished = false;
        this.timer = setTimeout(() => this.fail('host timed out'), REQUEST_TIMEOUT_MS);
    }

    /** Resets the inactivity timer; called on each chunk, not just at the start. */
    touch() {
        clearTimeout(this.timer);
        if (this.finished) return;
        this.timer = setTimeout(() => this.fail('host stopped sending'), REQUEST_TIMEOUT_MS);
    }

    write(chunk) {
        if (this.finished) return true;
        this.bytesWritten += chunk.length;
        this.touch();
        // write() returns false when the socket buffer is full.
        return this.response.write(chunk);
    }

    end() {
        if (this.finished) return;
        this.finished = true;
        clearTimeout(this.timer);
        try {
            this.response.end();
        } catch (_) { /* client already gone */ }
    }

    fail(reason) {
        if (this.finished) return;
        this.finished = true;
        clearTimeout(this.timer);
        try {
            if (!this.response.headersSent) {
                this.response.status(502).json({error: reason});
            } else {
                // Headers are out; the only way to signal failure is to cut the body.
                this.response.destroy();
            }
        } catch (_) { /* client already gone */ }
    }
}

class AudioRelay {
    constructor() {
        /** @type {Map<string, RelayRequest>} */
        this.pending = new Map();
    }

    /**
     * Starts a relayed read.
     *
     * @param {object} options
     * @param {object} options.room
     * @param {string} options.trackId
     * @param {{start:number|null,end:number|null}} options.range
     * @param {import('express').Response} options.response
     */
    request({room, trackId, range, response}) {
        const host = room.host;
        if (!host || !host.socket || host.socket.readyState !== 1) {
            response.status(503).json({error: 'host is offline'});
            return null;
        }

        // 8 random bytes, hex-encoded to 16 chars, so it round-trips through the binary
        // header as raw bytes and through JSON as a string.
        const id = crypto.randomBytes(8).toString('hex');
        const pending = new RelayRequest(id, response);
        this.pending.set(id, pending);

        // If the listener hangs up (closed the tab, skipped the track), stop the host
        // sending bytes nobody will read.
        response.on('close', () => {
            if (!pending.finished) {
                pending.finished = true;
                clearTimeout(pending.timer);
                this.cancel(room, id);
            }
            this.pending.delete(id);
        });

        try {
            host.socket.send(JSON.stringify({
                type: 'stream:request',
                id,
                trackId,
                start: range.start,
                end: range.end,
            }));
        } catch (error) {
            this.pending.delete(id);
            pending.fail('could not reach host');
            return null;
        }

        return pending;
    }

    /** Host answered with metadata (size, mime, resolved range) before the bytes. */
    onMeta(id, meta, response) {
        const pending = this.pending.get(id);
        if (!pending) return;

        pending.touch();

        if (pending.response.headersSent) return;

        const headers = {
            'Content-Type': meta.mime || 'audio/mpeg',
            // Range support is what makes seeking work in an <audio> element.
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
        };

        if (meta.partial) {
            headers['Content-Range'] = `bytes ${meta.start}-${meta.end}/${meta.size}`;
            headers['Content-Length'] = String(meta.end - meta.start + 1);
            pending.response.writeHead(206, headers);
        } else {
            headers['Content-Length'] = String(meta.size);
            pending.response.writeHead(200, headers);
        }
    }

    /**
     * A binary frame arrived from the host.
     * Returns true if the host should pause sending (listener is behind).
     */
    onChunk(frame) {
        if (frame.length < HEADER_BYTES) return false;

        const id = frame.subarray(0, 8).toString('hex');
        const flags = frame.readUInt32BE(12);
        const payload = frame.subarray(HEADER_BYTES);

        const pending = this.pending.get(id);
        if (!pending) return false;

        let ok = true;
        if (payload.length > 0) ok = pending.write(payload);

        if (flags & FLAG_FINAL) {
            pending.end();
            this.pending.delete(id);
            return false;
        }

        // Ask the host to hold off while the listener catches up.
        return !ok || pending.response.writableLength > HIGH_WATER_MARK;
    }

    onError(id, reason) {
        const pending = this.pending.get(id);
        if (!pending) return;
        pending.fail(reason || 'host could not read the file');
        this.pending.delete(id);
    }

    cancel(room, id) {
        const host = room.host;
        if (host && host.socket && host.socket.readyState === 1) {
            try {
                host.socket.send(JSON.stringify({type: 'stream:cancel', id}));
            } catch (_) { /* host gone */ }
        }
    }

    /** Fails every in-flight request for a room whose host just vanished. */
    abortAll(reason = 'host disconnected') {
        for (const [id, pending] of this.pending) {
            pending.fail(reason);
            this.pending.delete(id);
        }
    }
}

/** Parses an HTTP Range header into {start, end}. Returns null when absent/invalid. */
function parseRange(header) {
    if (!header || typeof header !== 'string') return null;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) return null;

    const startText = match[1];
    const endText = match[2];
    if (startText === '' && endText === '') return null;

    // "bytes=-500" means the LAST 500 bytes, not "up to 500".
    if (startText === '') {
        return {start: null, end: null, suffixLength: parseInt(endText, 10)};
    }

    return {
        start: parseInt(startText, 10),
        end: endText === '' ? null : parseInt(endText, 10),
        suffixLength: null,
    };
}

module.exports = {AudioRelay, parseRange, HEADER_BYTES, FLAG_FINAL};
