'use strict';

/**
 * Rhythm Dock room protocol.
 *
 * One file, shared verbatim by the server, the desktop app and the browser client, so
 * the three can never drift apart on message names or role rules.
 *
 * Transport is a single WebSocket per member. Control messages are JSON text frames;
 * audio travels as binary frames (see relay.js) because base64-in-JSON would inflate
 * every chunk by a third.
 */

const PROTOCOL_VERSION = 1;

/** Who may do what. */
const ROLES = {
    /** Owns the library and the audio. Exactly one per room. */
    HOST: 'host',
    /** Can play/pause/seek/skip and edit the queue. */
    CONTROLLER: 'controller',
    /** Can listen and nothing else — the "only-viewer" role. */
    LISTENER: 'listener',
};

const CLIENT = {
    HELLO: 'hello',
    TIME_PING: 'time:ping',
    /** Host publishes authoritative playback state. */
    STATE: 'state',
    /** Host publishes its library / queue. */
    LIBRARY: 'library',
    /** Host publishes lyrics for the current track. */
    LYRICS: 'lyrics',
    /** Host publishes shared appearance + lyric settings. */
    SETTINGS: 'settings',
    /** Controller asks the host to do something. */
    CONTROL: 'control',
    /** Host answers a relay request with metadata; chunks follow as binary. */
    STREAM_META: 'stream:meta',
    STREAM_ERROR: 'stream:error',
    /** Host promotes/demotes/kicks. */
    MEMBER_UPDATE: 'member:update',
    KICK: 'member:kick',
    PING: 'ping',
};

const SERVER = {
    WELCOME: 'welcome',
    ERROR: 'error',
    TIME_PONG: 'time:pong',
    STATE: 'state',
    LIBRARY: 'library',
    LYRICS: 'lyrics',
    SETTINGS: 'settings',
    MEMBERS: 'members',
    /** Forwarded controller intent, host only. */
    CONTROL: 'control',
    /** Server asks the host for a byte range. */
    STREAM_REQUEST: 'stream:request',
    HOST_GONE: 'host:gone',
    HOST_BACK: 'host:back',
    KICKED: 'kicked',
    PONG: 'pong',
};

/** Control verbs a controller may send. */
const CONTROL_ACTIONS = new Set([
    'play', 'pause', 'toggle', 'next', 'previous', 'seek',
    'select', 'rate', 'queue:add', 'queue:remove', 'queue:move', 'shuffle', 'loop',
]);

/**
 * Permission model, in one place so the server and both clients agree.
 * A listener is strictly read-only: it receives state, lyrics and audio, and may send
 * nothing but time pings and keepalives.
 */
const PERMISSIONS = {
    [ROLES.HOST]: {control: true, publish: true, manageMembers: true, listen: true},
    [ROLES.CONTROLLER]: {control: true, publish: false, manageMembers: false, listen: true},
    [ROLES.LISTENER]: {control: false, publish: false, manageMembers: false, listen: true},
};

function can(role, permission) {
    const entry = PERMISSIONS[role];
    return Boolean(entry && entry[permission]);
}

/**
 * Playback state shape published by the host.
 *
 * `positionMs` is paired with `atServerTime`: a position alone is stale the instant it
 * is sent, so listeners extrapolate forward using their measured clock offset. See
 * projectPosition().
 */
function makeState(overrides = {}) {
    return {
        trackId: null,
        title: '',
        artist: '',
        album: '',
        durationMs: 0,
        positionMs: 0,
        playing: false,
        rate: 1,
        /** Server clock (ms) at which positionMs was accurate. */
        atServerTime: 0,
        queueIndex: -1,
        shuffle: false,
        loop: 'off',
        ...overrides,
    };
}

/**
 * Where playback should be *now*, given a state snapshot and the current server time.
 * Clamped to the track duration so a paused-at-end state does not project past the end.
 */
function projectPosition(state, serverNow) {
    if (!state || !state.playing) return state ? state.positionMs : 0;
    const elapsed = Math.max(0, serverNow - state.atServerTime);
    const projected = state.positionMs + elapsed * (state.rate || 1);
    return state.durationMs > 0 ? Math.min(projected, state.durationMs) : projected;
}

/**
 * Shared appearance and lyric settings, mirrored from the host to every member so a
 * phone in the room looks and behaves like the laptop driving it.
 */
function makeSettings(overrides = {}) {
    return {
        theme: 'dark',
        accent: '#1db954',
        // Lyric behaviour.
        lyricsOffsetMs: 0,
        lyricsVisible: true,
        translationLanguage: null,
        // Playback shape the host wants mirrored.
        rate: 1,
        equalizer: null,
        ...overrides,
    };
}

module.exports = {
    PROTOCOL_VERSION,
    ROLES,
    CLIENT,
    SERVER,
    CONTROL_ACTIONS,
    PERMISSIONS,
    can,
    makeState,
    makeSettings,
    projectPosition,
};
