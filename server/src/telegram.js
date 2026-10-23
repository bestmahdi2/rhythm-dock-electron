'use strict';

// Optional Bot API polling. The token stays on the server and never crosses the
// WebSocket or app renderer. Pairing is temporary and tied to a live room.
const crypto = require('crypto');
const path = require('path');
const fs = require('node:fs');

const PAIR_TTL_MS = 10 * 60 * 1000;
const MAX_FILE_BYTES = 20 * 1024 * 1024; // Official hosted Bot API getFile limit.
const AUDIO_EXTENSIONS = new Set(require('./audio-formats'));

class TelegramIntake {
    constructor({token, registry, onAudio, onLink, request = fetch, statePath = ''}) {
        this.token = token;
        this.registry = registry;
        this.onAudio = onAudio;
        this.onLink = onLink;
        this.statePath = statePath;
        this.request = request;
        this.pairCodes = new Map();
        this.chatRooms = new Map();
        this.offset = 0;
        this.seenUpdates = new Set();
        try {
            const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            if (Number.isSafeInteger(saved.offset) && saved.offset >= 0) this.offset = saved.offset;
        } catch (_) { /* Fresh installation or optional offset storage is unavailable. */ }
        this.running = false;
        this.abort = null;
    }

    get enabled() { return Boolean(this.token); }

    createPairCode(room) {
        const code = crypto.randomBytes(5).toString('hex').toUpperCase();
        this.pairCodes.set(code, {roomCode: room.code, expiresAt: Date.now() + PAIR_TTL_MS});
        return code;
    }

    async call(method, body, signal) {
        const response = await this.request(`https://api.telegram.org/bot${this.token}/${method}`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body), signal,
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(`Telegram ${method} failed`);
        return result.result;
    }

    async reply(chatId, text) {
        await this.call('sendMessage', {chat_id: chatId, text});
    }

    async handleUpdate(update) {
        if (Number.isSafeInteger(update.update_id)) {
            if (update.update_id < this.offset || this.seenUpdates.has(update.update_id)) return;
            this.seenUpdates.add(update.update_id);
            if (this.seenUpdates.size > 4096) this.seenUpdates.delete(this.seenUpdates.values().next().value);
        }
        const message = update.message;
        if (!message || !message.chat || message.chat.type !== 'private') return;
        const chatId = String(message.chat.id);
        const command = (message.text || '').trim();
        if (command.startsWith('/pair ')) {
            const code = command.slice(6).trim().toUpperCase();
            const pair = this.pairCodes.get(code);
            this.pairCodes.delete(code);
            const room = pair && pair.expiresAt > Date.now() && this.registry.get(pair.roomCode);
            if (!room || !room.hostOnline) return this.reply(chatId, 'Pair code expired or host offline. Ask the host for a new code.');
            this.chatRooms.set(chatId, room.code);
            return this.reply(chatId, `Paired with room ${room.code}. Send audio up to 20 MB or a direct HTTPS audio/playlist link. Use /next or /first to choose its queue position; otherwise it goes at the end.`);
        }
        if (command === '/unpair') {
            this.chatRooms.delete(chatId);
            return this.reply(chatId, 'Disconnected from the room.');
        }
        const room = this.registry.get(this.chatRooms.get(chatId));
        if (!room) {
            this.chatRooms.delete(chatId);
            return this.reply(chatId, 'Send /pair CODE from the room host first.');
        }
        const attachment = message.audio || message.document;
        const position = /^\/next\b/.test(command || message.caption || '') ? 'next' :
            /^\/first\b/.test(command || message.caption || '') ? 'first' : 'end';
        if (!attachment) {
            const link = /https:\/\/[^\s<>]+/i.exec(command)?.[0];
            if (!link || !this.onLink) return this.reply(chatId, 'Send an audio file or a direct HTTPS audio/playlist link.');
            try {
                const url = new URL(link);
                if (url.username || url.password) throw new Error('Links with embedded login details are not supported.');
                if (/(^|\.)(youtube\.com|youtu\.be|spotify\.com)$/.test(url.hostname))
                    throw new Error('Use a direct audio link. YouTube and Spotify playback need a separate provider integration.');
                if (!room.hostOnline) throw new Error('The host is offline.');
                await this.onLink({room, url: url.href, position, chatId});
                return this.reply(chatId, 'The host is downloading your audio link into the queue.');
            } catch (error) { return this.reply(chatId, `Could not add this link: ${error.message}`); }
        }
        const fileName = path.basename(attachment.file_name ||
            (message.audio ? `${attachment.file_unique_id || 'song'}.mp3` : ''));
        if (!AUDIO_EXTENSIONS.has(path.extname(fileName).toLowerCase()))
            return this.reply(chatId, 'Unsupported audio format.');
        if (attachment.file_size > MAX_FILE_BYTES)
            return this.reply(chatId, 'Telegram bots can download files up to 20 MB.');
        try {
            const file = await this.call('getFile', {file_id: attachment.file_id});
            if (!file.file_path || file.file_size > MAX_FILE_BYTES)
                throw new Error('File exceeds the 20 MB limit');
            const response = await this.request(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
            if (!response.ok) throw new Error('Telegram file download failed');
            const bytes = Buffer.from(await response.arrayBuffer());
            if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error('File exceeds the 20 MB limit');
            await this.onAudio({room, fileName, bytes, chatId, position});
            return this.reply(chatId, `Sent ${fileName} to room ${room.code}. The host is adding it to the queue.`);
        } catch (error) {
            return this.reply(chatId, `Could not add this song: ${error.message}`);
        }
    }

    start() {
        if (!this.enabled || this.running) return;
        this.running = true;
        this.poll().catch((error) => console.error('[telegram] Polling stopped:', error.message));
    }

    stop() {
        this.running = false;
        this.abort?.abort();
    }

    async poll() {
        while (this.running) {
            try {
                this.abort = new AbortController();
                const updates = await this.call('getUpdates', {
                    offset: this.offset, timeout: 20, allowed_updates: ['message'], limit: 25,
                }, this.abort.signal);
                for (const update of updates) {
                    if (!this.running) break;
                    try { await this.handleUpdate(update); }
                    catch (error) { console.error('[telegram] Update failed:', error.message); }
                    this.offset = Math.max(this.offset, update.update_id + 1);
                    if (this.statePath) {
                        fs.mkdirSync(path.dirname(this.statePath), {recursive: true});
                        const temporary = this.statePath + '.tmp';
                        fs.writeFileSync(temporary, JSON.stringify({offset: this.offset}));
                        fs.renameSync(temporary, this.statePath);
                    }
                }
            } catch (error) {
                if (!this.running) break;
                console.error('[telegram] Poll error:', error.message);
                await new Promise((resolve) => setTimeout(resolve, 5000));
            }
        }
    }
}

module.exports = {TelegramIntake};
