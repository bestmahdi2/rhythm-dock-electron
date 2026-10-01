'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.PORT = '0'; process.env.HOST = '127.0.0.1';
process.env.CREATE_SECRET = 'local-test'; process.env.TELEGRAM_BOT_TOKEN = '';
const {server} = require('../../server/src/index');
const {RoomClient, trackIdFor} = require('../src/main/services/room-client');

const clients = [];
function client() {
    const events = [];
    const instance = new RoomClient({emit: (event, payload) => events.push({event, payload})});
    clients.push(instance); return {instance, events};
}
async function wait(test) {
    const deadline = Date.now() + 8000;
    while (!test()) {
        if (Date.now() > deadline) throw new Error('Room integration test timed out.');
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

(async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rhythm-room-client-'));
    try {
        await wait(() => server.listening);
        const base = `http://127.0.0.1:${server.address().port}`;
        const one = path.join(scratch, 'one.wav'), two = path.join(scratch, 'two.wav');
        fs.writeFileSync(one, 'test audio bytes one'); fs.writeFileSync(two, 'test audio bytes two');
        const host = client(), guest = client(), friend = client();
        const room = await host.instance.createRoom(base, {name: 'Host', password: 'local-password', secret: 'local-test'});
        await guest.instance.joinRoom(base, room.code, {name: 'Guest', password: 'local-password'});
        await friend.instance.joinRoom(base, room.code, {name: 'Friend', password: 'local-password'});
        const info = {[one]: {title: 'One'}, [two]: {title: 'Two'}};
        host.instance.publishLibrary([one], info, [{filePath: one}, {filePath: two}]);
        await wait(() => guest.events.some((item) => item.event === 'room:library'));
        const publicLibrary = guest.events.find((item) => item.event === 'room:library').payload;
        assert.ok(!JSON.stringify(publicLibrary).includes(scratch), 'shared library must not expose host paths');
        const range = await fetch(`${base}/api/rooms/${room.code}/stream/${trackIdFor(one)}?password=local-password`,
            {headers: {Range: 'bytes=0-8'}, signal: AbortSignal.timeout(5000)});
        assert.equal(range.status, 206);
        assert.equal(range.headers.get('access-control-allow-origin'), '*', 'desktop WebAudio needs CORS');
        assert.equal(await range.text(), 'test audi');
        guest.instance.sendControl('queue:add', {trackId: trackIdFor(two), position: 'next'});
        await wait(() => host.events.some((item) => item.event === 'room:control'));
        const control = host.events.find((item) => item.event === 'room:control').payload;
        assert.equal(control.value.position, 'next');
        host.instance.publishLibrary([one, two], info);
        await wait(() => friend.events.some((item) => item.event === 'room:library' && item.payload.library.queue.length === 2));
        host.instance.socket.terminate();
        await wait(() => host.events.filter((item) => item.event === 'room:welcome').length === 2);
        assert.equal(host.instance.isHost, true);
        host.instance.publishLibrary([one, two], info);
        guest.instance.socket.terminate();
        await wait(() => guest.events.filter((item) => item.event === 'room:welcome').length === 2);
        assert.equal(guest.instance.role, 'controller');
        const reconnect = guest.events.filter((item) => item.event === 'room:welcome').at(-1).payload;
        assert.equal(reconnect.library.queue.length, 2, 'reconnect must receive the current queue');
        const bad = client();
        await assert.rejects(bad.instance.joinRoom(base, room.code, {password: 'wrong'}), /password/);
        // A decoded file retains the source track id and keeps its path private.
        host.instance.publishLibrary([one], {[one]: {title: 'Decoded', playbackPath: two}});
        assert.equal(host.instance.trackPaths.get(trackIdFor(one)), two);
        assert.equal(host.instance.trackSources.get(trackIdFor(one)), one);
        console.log('PASS: real desktop room clients, private catalog, byte relay, queue fan-out, reconnect and rejected login');
    } finally {
        for (const instance of clients) instance.leave();
        fs.rmSync(scratch, {recursive: true, force: true});
        server.close();
    }
})().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
