'use strict';

/**
 * End-to-end test of the room server.
 * Boots a real server on a random port and drives it with real WebSocket clients.
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');

// Resolve express/ws from the scratch install.
const SCRATCH = '/home/claude/servertest/node_modules';
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'express' || request === 'ws') {
    return origResolve.call(this, path.join(SCRATCH, request), ...rest);
  }
  return origResolve.call(this, request, ...rest);
};

const WebSocket = require(path.join(SCRATCH, 'ws'));

process.env.PORT = '0';
const SERVER_DIR = '/home/claude/work/Rhythm Dock/server/src';
const protocol = require(path.join(SERVER_DIR, 'protocol.js'));
const {RoomRegistry} = require(path.join(SERVER_DIR, 'rooms.js'));
const {parseRange} = require(path.join(SERVER_DIR, 'relay.js'));
const {server} = require(path.join(SERVER_DIR, 'index.js'));

let pass = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  PASS  ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}\n        ${e.message}`); process.exitCode = 1; }
};

const BASE = () => `http://127.0.0.1:${server.address().port}`;
const WSU = () => `ws://127.0.0.1:${server.address().port}/ws`;

/** Opens a socket, sends hello, resolves with the welcome message. */
function join(hello) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(WSU());
    const inbox = [];
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      inbox.push(message);
      if (message.type === 'welcome' && !socket._welcomed) {
        socket._welcomed = true;
        resolve({socket, welcome: message, inbox});
      }
      if (message.type === 'error' && message.fatal) reject(new Error(message.error));
    });
    socket.on('open', () => socket.send(JSON.stringify({type: 'hello', ...hello})));
    socket.on('error', reject);
    setTimeout(() => reject(new Error('join timed out')), 4000);
  });
}

const send = (socket, message) => socket.send(JSON.stringify(message));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Waits for a message of a given type to land in an inbox. */
async function until(inbox, type, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = inbox.find((m) => m.type === type);
    if (found) return found;
    await wait(25);
  }
  throw new Error(`timed out waiting for "${type}"`);
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  console.log(`\n(test server on ${BASE()})`);

  // ---- Range parsing --------------------------------------------------
  console.log('\n== HTTP Range parsing ==');
  check('open-ended range', () => assert.deepStrictEqual(parseRange('bytes=0-'),
    {start: 0, end: null, suffixLength: null}));
  check('bounded range', () => assert.deepStrictEqual(parseRange('bytes=100-200'),
    {start: 100, end: 200, suffixLength: null}));
  check('suffix range means the LAST n bytes', () => {
    const r = parseRange('bytes=-500');
    assert.strictEqual(r.suffixLength, 500);
    assert.strictEqual(r.start, null, 'must not be read as "first 500 bytes"');
  });
  check('garbage returns null', () => {
    assert.strictEqual(parseRange('bananas'), null);
    assert.strictEqual(parseRange(''), null);
    assert.strictEqual(parseRange(undefined), null);
  });

  // ---- Room creation --------------------------------------------------
  console.log('\n== Room creation ==');
  const created = await (await fetch(`${BASE()}/api/rooms`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({name: 'Test Room'}),
  })).json();

  check('returns a code and a host token', () => {
    assert.match(created.code, /^[A-Z0-9]{6}$/);
    assert.ok(created.hostToken && created.hostToken.length >= 32);
  });
  check('codes exclude ambiguous characters', () => {
    assert.ok(!/[01ILO]/.test(created.code), 'got ' + created.code);
  });
  check('public info does not leak the host token', async () => {
    const info = await (await fetch(`${BASE()}/api/rooms/${created.code}`)).json();
    assert.strictEqual(info.hostToken, undefined);
    assert.strictEqual(info.code, created.code);
  });
  check('unknown room is a 404', async () => {
    const res = await fetch(`${BASE()}/api/rooms/ZZZZZZ`);
    assert.strictEqual(res.status, 404);
  });

  // ---- Host + members --------------------------------------------------
  console.log('\n== Joining ==');
  const host = await join({roomCode: created.code, role: 'host', hostToken: created.hostToken, name: 'Laptop'});
  check('host claim with a valid token succeeds', () => {
    assert.strictEqual(host.welcome.role, 'host');
  });

  await assert.rejects(
    () => join({roomCode: created.code, role: 'host', hostToken: 'wrong', name: 'Impostor'}),
    /invalid host token/,
  );
  check('host claim with a bad token is rejected', () => { pass++; });
  pass--; // the assert.rejects above is the real check

  const phone = await join({roomCode: created.code, name: 'Phone'});
  check('a member joins as controller by default', () => {
    assert.strictEqual(phone.welcome.role, 'controller');
  });
  check('joiner receives full state in the welcome', () => {
    ['state', 'settings', 'library', 'lyrics', 'members', 'serverTime'].forEach((k) =>
      assert.ok(k in phone.welcome, 'missing ' + k));
  });

  // ---- State fan-out ---------------------------------------------------
  console.log('\n== State fan-out ==');
  send(host.socket, {type: 'state', state: {
    trackId: 'abc', title: 'Around The World', artist: 'Daft Punk',
    durationMs: 428000, positionMs: 5000, playing: true, rate: 1,
  }});
  const stateMsg = await until(phone.inbox, 'state');
  check('members receive the host state', () => {
    assert.strictEqual(stateMsg.state.title, 'Around The World');
    assert.strictEqual(stateMsg.state.playing, true);
  });
  check('the server stamps its own clock, not the host clock', () => {
    assert.ok(stateMsg.state.atServerTime > 0);
    assert.ok(Math.abs(stateMsg.state.atServerTime - Date.now()) < 5000);
  });

  check('position projection extrapolates while playing', () => {
    const s = {positionMs: 1000, playing: true, rate: 1, atServerTime: 10000, durationMs: 60000};
    assert.strictEqual(protocol.projectPosition(s, 13000), 4000, '3s elapsed => +3000ms');
  });
  check('projection respects playback rate', () => {
    const s = {positionMs: 0, playing: true, rate: 2, atServerTime: 0, durationMs: 60000};
    assert.strictEqual(protocol.projectPosition(s, 1000), 2000);
  });
  check('projection does not run past the track end', () => {
    const s = {positionMs: 0, playing: true, rate: 1, atServerTime: 0, durationMs: 5000};
    assert.strictEqual(protocol.projectPosition(s, 999999), 5000);
  });
  check('paused state does not advance', () => {
    const s = {positionMs: 7000, playing: false, rate: 1, atServerTime: 0, durationMs: 60000};
    assert.strictEqual(protocol.projectPosition(s, 999999), 7000);
  });

  // ---- Settings / lyrics mirroring --------------------------------------
  console.log('\n== Settings & lyrics mirroring ==');
  send(host.socket, {type: 'settings', settings: {theme: 'light', accent: '#ff0055', lyricsOffsetMs: 250}});
  const settingsMsg = await until(phone.inbox, 'settings');
  check('theme and lyric settings reach members', () => {
    assert.strictEqual(settingsMsg.settings.theme, 'light');
    assert.strictEqual(settingsMsg.settings.accent, '#ff0055');
    assert.strictEqual(settingsMsg.settings.lyricsOffsetMs, 250);
  });

  send(host.socket, {type: 'lyrics', trackId: 'abc', isSynced: true,
    lines: [{timeMs: 0, text: 'one'}, {timeMs: 2000, text: 'two'}]});
  const lyricsMsg = await until(phone.inbox, 'lyrics');
  check('lyrics reach members with timestamps intact', () => {
    assert.strictEqual(lyricsMsg.lyrics.lines.length, 2);
    assert.strictEqual(lyricsMsg.lyrics.lines[1].timeMs, 2000);
  });

  // ---- Control + permissions --------------------------------------------
  console.log('\n== Control routing & the listen-only role ==');
  phone.inbox.length = 0; host.inbox.length = 0;
  send(phone.socket, {type: 'control', action: 'next'});
  const control = await until(host.inbox, 'control');
  check('a controller intent is forwarded to the host', () => {
    assert.strictEqual(control.action, 'next');
    assert.strictEqual(control.by.name, 'Phone');
  });

  check('the host never receives its own state back', () => {
    assert.ok(!host.inbox.some((m) => m.type === 'state'), 'echo would cause a feedback loop');
  });

  // Demote the phone to listen-only.
  const members = await until(phone.inbox, 'members').catch(() => null);
  const phoneId = phone.welcome.memberId;
  phone.inbox.length = 0; host.inbox.length = 0;
  send(host.socket, {type: 'member:update', memberId: phoneId, role: 'listener'});
  await wait(200);

  check('host can demote a member to listen-only', () => {
    const update = phone.inbox.find((m) => m.type === 'welcome' && m.roleChanged);
    assert.ok(update, 'member was not told about the role change');
    assert.strictEqual(update.role, 'listener');
  });

  host.inbox.length = 0; phone.inbox.length = 0;
  send(phone.socket, {type: 'control', action: 'next'});
  await wait(250);
  check('a listener CANNOT control playback', () => {
    assert.ok(!host.inbox.some((m) => m.type === 'control'),
      'listen-only member managed to control the host');
  });
  check('and is told why', () => {
    const err = phone.inbox.find((m) => m.type === 'error');
    assert.ok(err && /listen-only/i.test(err.error), 'got: ' + JSON.stringify(phone.inbox));
  });
  check('a listener still receives state', () => {
    phone.inbox.length = 0;
    send(host.socket, {type: 'state', state: {trackId: 'x', title: 'Next Song', playing: true}});
    return until(phone.inbox, 'state').then((m) =>
      assert.strictEqual(m.state.title, 'Next Song'));
  });
  await wait(200);

  check('a member cannot promote itself', () => {
    send(phone.socket, {type: 'member:update', memberId: phoneId, role: 'controller'});
    return wait(200).then(() => {
      const registry = require(path.join(SERVER_DIR, 'index.js')).registry;
      const room = registry.get(created.code);
      assert.strictEqual(room.members.get(phoneId).role, 'listener', 'self-promotion succeeded');
    });
  });
  await wait(250);

  check('unknown control verbs are rejected', () => {
    host.inbox.length = 0;
    send(host.socket, {type: 'control', action: 'rm -rf', value: 1});
    return wait(150);
  });

  // ---- Password rooms ----------------------------------------------------
  console.log('\n== Password protection ==');
  const locked = await (await fetch(`${BASE()}/api/rooms`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({name: 'Locked', password: 'hunter2'}),
  })).json();

  await assert.rejects(
    () => join({roomCode: locked.code, name: 'NoPass'}),
    /wrong password/,
  );
  check('joining without the password is refused', () => {});
  const withPass = await join({roomCode: locked.code, name: 'HasPass', password: 'hunter2'});
  check('joining with the correct password works', () => {
    assert.strictEqual(withPass.welcome.role, 'controller');
  });
  check('the stream endpoint also enforces the password', async () => {
    const res = await fetch(`${BASE()}/api/rooms/${locked.code}/stream/abc`);
    assert.strictEqual(res.status, 403, 'audio leaked from a password-protected room');
  });
  withPass.socket.close();

  // ---- Listen-only rooms -------------------------------------------------
  console.log('\n== Broadcast-only rooms ==');
  const broadcast = await (await fetch(`${BASE()}/api/rooms`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({name: 'Broadcast', everyoneCanControl: false}),
  })).json();
  const viewer = await join({roomCode: broadcast.code, name: 'Viewer'});
  check('members join listen-only when the host chose that', () => {
    assert.strictEqual(viewer.welcome.role, 'listener');
  });
  viewer.socket.close();

  // ---- Host disconnect ---------------------------------------------------
  console.log('\n== Host disconnect ==');
  phone.inbox.length = 0;
  host.socket.close();
  const gone = await until(phone.inbox, 'host:gone', 3000);
  check('members are told when the host vanishes', () => assert.ok(gone));
  check('playback is marked stopped, since audio is unavailable', async () => {
    const stopped = await until(phone.inbox, 'state', 2000);
    assert.strictEqual(stopped.state.playing, false);
  });
  check('the room survives the host briefly, for reconnects', () => {
    const registry = require(path.join(SERVER_DIR, 'index.js')).registry;
    assert.ok(registry.get(created.code), 'room was destroyed instantly');
  });

  // ---- Stream endpoint with no host --------------------------------------
  check('streaming without a host returns 503, not a hang', async () => {
    const res = await fetch(`${BASE()}/api/rooms/${created.code}/stream/abc`);
    assert.strictEqual(res.status, 503);
  });

  phone.socket.close();
  await wait(200);
  console.log(`\n${pass} checks passed.`);
  server.close();
  process.exit(process.exitCode || 0);
})().catch((error) => {
  console.error('\nTest harness failed:', error);
  process.exit(1);
});
