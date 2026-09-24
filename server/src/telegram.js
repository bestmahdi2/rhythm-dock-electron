'use strict';

// Optional Bot API polling. The token stays on the server and never crosses the
// WebSocket or app renderer. Pairing is temporary and tied to a live room.
const crypto = require('crypto');
const path = require('path');

const PAIR_TTL_MS = 10 * 60 * 1000;
const MAX_FILE_BYTES = 20 * 1024 * 1024; // Official hosted Bot API getFile limit.
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.flac', '.wav', '.ogg', '.opus', '.aac', '.wma', '.aiff']);

class TelegramIntake {
    constructor({token, registry, onAudio, request = fetch}) {
        this.token = token;
        this.registry = registry;
        this.onAudio = onAudio;
        this.request = request;
        this.pairCodes = new Map();
        this.chatRooms = new Map();
        this.offset = 0;
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
            return this.reply(chatId, `Paired with room ${room.code}. Send an audio file up to 20 MB to add it to the queue.`);
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
        if (!attachment) return this.reply(chatId, 'Send an audio file. Links are not supported yet.');
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
            await this.onAudio({room, fileName, bytes, chatId});
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
