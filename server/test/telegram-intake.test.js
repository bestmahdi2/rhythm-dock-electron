'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {TelegramIntake} = require('../src/telegram');
(async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rhythm-telegram-test-'));
    try {
        const statePath = path.join(scratch, 'offset.json');
        const links = [], audio = [], replies = [];
        const registry = {get: (code) => code === 'ROOM' ? {code, hostOnline: true} : null};
        const request = async (url, options) => {
            if (url.endsWith('/sendMessage')) replies.push(JSON.parse(options.body).text);
            if (url.endsWith('/getFile')) return {ok: true, json: async () => ({ok: true,
                result: {file_path: 'test.mp3', file_size: 3}})};
            if (url.includes('/file/')) return {ok: true, arrayBuffer: async () => Buffer.from('abc')};
            return {ok: true, json: async () => ({ok: true, result: {}})};
        };
        const bot = new TelegramIntake({token: 'test', registry, statePath, request,
            onAudio: async (item) => audio.push(item), onLink: async (item) => links.push(item)});
        const chat = {id: 1, type: 'private'};
        const pair = bot.createPairCode({code: 'ROOM'});
        await bot.handleUpdate({update_id: 1, message: {chat, text: `/pair ${pair}`}});
        const update = {update_id: 2, message: {chat, text: '/next https://example.com/list.m3u'}};
        await bot.handleUpdate(update); await bot.handleUpdate(update);
        assert.equal(links.length, 1); assert.equal(links[0].position, 'next');
        await bot.handleUpdate({update_id: 3, message: {chat, caption: '/first',
            audio: {file_id: 'file', file_name: 'song.mp3', file_size: 3}}});
        assert.equal(audio[0].position, 'first');
        await bot.handleUpdate({update_id: 4, message: {chat, text: 'https://open.spotify.com/track/abc'}});
        assert.equal(links.length, 1); assert.ok(replies.some((text) => /provider integration/.test(text)));
        let polled = false;
        bot.request = async (url, options) => {
            if (!url.endsWith('/getUpdates')) return request(url, options);
            if (polled) { bot.running = false; return {ok: true, json: async () => ({ok: true, result: []})}; }
            polled = true;
            return {ok: true, json: async () => ({ok: true, result: [
                {update_id: 5, message: {chat, text: 'https://example.com/song.mp3'}}]})};
        };
        bot.running = true; await bot.poll();
        assert.equal(JSON.parse(fs.readFileSync(statePath)).offset, 6);
        const restarted = new TelegramIntake({token: 'test', registry, statePath, request,
            onLink: async () => assert.fail('processed update must not repeat')});
        assert.equal(restarted.offset, 6);
        await restarted.handleUpdate({update_id: 5, message: {chat, text: 'https://example.com/song.mp3'}});
        console.log('PASS: Telegram queue positions, links, duplicate updates and persisted restart offset');
    } finally { fs.rmSync(scratch, {recursive: true, force: true}); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
