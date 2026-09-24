'use strict';

/**
 * Rhythm Dock browser client.
 *
 * Runs on any phone or laptop with a browser — no install, which is the point. The
 * desktop app speaks the same protocol; this is the zero-install path into a room.
 *
 * The interesting part is synchronisation. The server publishes "position P was
 * accurate at server time T". A client cannot use that directly because its own clock
 * may be seconds off. So:
 *
 *   1. Measure the offset between local and server clocks (NTP-style, below).
 *   2. Project where playback should be *now*.
 *   3. Correct drift by nudging playbackRate rather than seeking, because a seek is
 *      audible and a 2% rate change is not.
 */

// ---- Configuration ---------------------------------------------------------

// Beyond this we give up on nudging and just seek: something big happened (a skip,
// a long stall, a laptop waking from sleep).
const HARD_SEEK_THRESHOLD_MS = 1500;
// Below this we do nothing. Chasing sub-50ms drift makes the rate oscillate audibly.
const DEADBAND_MS = 60;
// Maximum rate adjustment. 4% is inaudible on music; 10% is not.
const MAX_RATE_TRIM = 0.04;

const SYNC_SAMPLES = 8;
const RESYNC_INTERVAL_MS = 30000;
const DRIFT_CHECK_MS = 1000;

// ---- State -----------------------------------------------------------------

const app = {
    socket: null,
    room: null,
    memberId: null,
    uploadToken: null,
    role: 'listener',
    password: '',
    state: null,
    settings: null,
    library: {tracks: [], queue: []},
    lyrics: {lines: [], isSynced: false},
    members: [],

    clockOffsetMs: 0,
    clockJitterMs: 0,
    samples: [],

    currentTrackId: null,
    reconnectDelay: 1000,
    intentionalClose: false,
};

const el = (id) => document.getElementById(id);
const audio = el('audio-element');

// ---- Clock synchronisation -------------------------------------------------

/**
 * NTP-style offset estimation.
 *
 *   t0 = local send time, t1 = server receive time, t2 = local receive time
 *   round trip = t2 - t0, and assuming symmetry the server clock leads local by
 *   offset = t1 - t0 - roundTrip/2
 *
 * Several samples are taken and the one with the SMALLEST round trip is used rather
 * than the mean: a delayed packet only ever inflates the error, so the fastest sample
 * is the most trustworthy. This is what NTP itself does.
 */
function syncClock() {
    let received = 0;
    const results = [];

    for (let i = 0; i < SYNC_SAMPLES; i++) {
        setTimeout(() => {
            const t0 = Date.now();
            pendingPings.set(t0, (t1) => {
                const t2 = Date.now();
                const roundTrip = t2 - t0;
                results.push({offset: t1 - t0 - roundTrip / 2, roundTrip});
                received++;

                if (received === SYNC_SAMPLES) {
                    results.sort((a, b) => a.roundTrip - b.roundTrip);
                    const best = results[0];
                    app.clockOffsetMs = best.offset;
                    app.clockJitterMs = results[results.length - 1].roundTrip - best.roundTrip;
                    updateSyncIndicator();
                }
            });
            sendJSON({type: 'time:ping', t0});
        }, i * 120);
    }
}

const pendingPings = new Map();

/** Server time as best we can estimate it. */
function serverNow() {
    return Date.now() + app.clockOffsetMs;
}

function updateSyncIndicator() {
    const indicator = el('sync-indicator');
    if (!indicator) return;
    const rtt = Math.round(app.clockJitterMs);
    indicator.textContent = rtt < 80 ? '\u25cf' : rtt < 250 ? '\u25cf' : '\u25cf';
    indicator.className = 'sync-indicator ' + (rtt < 80 ? 'good' : rtt < 250 ? 'ok' : 'poor');
    indicator.title = `Clock offset ${Math.round(app.clockOffsetMs)}ms, jitter ${rtt}ms`;
}

// ---- Networking ------------------------------------------------------------

function sendJSON(message) {
    if (app.socket && app.socket.readyState === 1) {
        app.socket.send(JSON.stringify(message));
    }
}

/** Controllers send intents; the host is the only thing that actually plays. */
function sendControl(action, value) {
    if (app.role === 'listener') {
        toast('You are in listen-only mode');
        return;
    }
    sendJSON({type: 'control', action, value});
}

function connect({code, name, password}) {
    app.intentionalClose = false;
    app.password = password || '';

    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${scheme}//${location.host}/ws`);
    app.socket = socket;

    socket.addEventListener('open', () => {
        app.reconnectDelay = 1000;
        sendJSON({type: 'hello', roomCode: code, name, password, role: 'listener'});
    });

    socket.addEventListener('message', (event) => {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch (_) {
            return;
        }
        handleMessage(message);
    });

    socket.addEventListener('close', () => {
        if (app.intentionalClose) return;
        toast('Disconnected — reconnecting...');
        // Exponential backoff, capped: a server restart should not be hammered by
        // every phone in the room at once.
        setTimeout(() => connect({code, name, password}), app.reconnectDelay);
        app.reconnectDelay = Math.min(app.reconnectDelay * 2, 15000);
    });

    socket.addEventListener('error', () => {/* close handler does the recovery */});
}

function handleMessage(message) {
    switch (message.type) {
        case 'welcome':
            app.memberId = message.memberId;
            app.uploadToken = message.uploadToken || null;
            app.role = message.role;
            app.room = message.room;
            applySettings(message.settings);
            applyLibrary(message.library);
            applyLyrics(message.lyrics);
            applyMembers(message.members);
            applyState(message.state);
            showPlayer();
            syncClock();
            if (message.roleChanged) toast(`You are now a ${message.role}`);
            break;

        case 'time:pong': {
            const resolver = pendingPings.get(message.t0);
            if (resolver) {
                pendingPings.delete(message.t0);
                resolver(message.t1);
            }
            break;
        }

        case 'state':    applyState(message.state); break;
        case 'settings': applySettings(message.settings); break;
        case 'library':  applyLibrary(message.library); break;
        case 'lyrics':   applyLyrics(message.lyrics); break;
        case 'members':  applyMembers(message.members); break;
        case 'upload:accepted':
            el('upload-status').textContent = 'Your song was added by the host.';
            break;

        case 'host:gone':
            toast('The host disconnected');
            audio.pause();
            break;

        case 'host:back':
            toast('The host is back');
            break;

        case 'kicked':
            app.intentionalClose = true;
            toast('You were removed from the room');
            setTimeout(() => location.reload(), 1500);
            break;

        case 'error':
            if (message.fatal) {
                app.intentionalClose = true;
                showJoinError(message.error);
                if (/password/i.test(message.error)) {
                    el('join-password').classList.remove('hidden');
                }
            } else {
                toast(message.error);
            }
            break;
    }
}

// ---- Playback --------------------------------------------------------------

/**
 * Applies a state snapshot: loads the track if it changed, then aligns position.
 */
function applyState(state) {
    if (!state) return;
    app.state = state;

    if (state.trackId !== app.currentTrackId) {
        app.currentTrackId = state.trackId;
        if (state.trackId) {
            const query = app.password ? `?password=${encodeURIComponent(app.password)}` : '';
            // The relay endpoint honours Range requests, so the element streams and
            // can seek without downloading the whole file.
            audio.src = `/api/rooms/${app.room.code}/stream/${encodeURIComponent(state.trackId)}${query}`;
            audio.load();
        } else {
            audio.removeAttribute('src');
        }
    }

    audio.playbackRate = state.rate || 1;
    renderNowPlaying();

    if (state.playing) {
        // Autoplay is blocked until the user interacts with the page. The join button
        // click counts, which is why joining is a button rather than an auto-connect.
        audio.play().catch(() => toast('Tap play to start audio'));
    } else {
        audio.pause();
        alignPosition(true);
    }
}

/**
 * Brings local playback in line with where the room says it should be.
 * @param {boolean} force Seek regardless of how small the difference is.
 */
function alignPosition(force = false) {
    if (!app.state || !app.currentTrackId) return;
    if (!Number.isFinite(audio.duration)) return;

    const targetMs = projectPosition(app.state, serverNow());
    const localMs = audio.currentTime * 1000;
    const drift = targetMs - localMs;

    if (force || Math.abs(drift) > HARD_SEEK_THRESHOLD_MS) {
        audio.currentTime = Math.max(0, targetMs / 1000);
        audio.playbackRate = app.state.rate || 1;
        return;
    }

    if (!app.state.playing) return;

    if (Math.abs(drift) < DEADBAND_MS) {
        audio.playbackRate = app.state.rate || 1;
        return;
    }

    // Behind -> speed up slightly; ahead -> slow down. Proportional, clamped.
    const trim = Math.max(-MAX_RATE_TRIM, Math.min(MAX_RATE_TRIM, drift / 8000));
    audio.playbackRate = (app.state.rate || 1) * (1 + trim);
}

/** Local copy of protocol.projectPosition, so the client needs no build step. */
function projectPosition(state, now) {
    if (!state || !state.playing) return state ? state.positionMs : 0;
    const elapsed = Math.max(0, now - state.atServerTime);
    const projected = state.positionMs + elapsed * (state.rate || 1);
    return state.durationMs > 0 ? Math.min(projected, state.durationMs) : projected;
}

setInterval(() => alignPosition(false), DRIFT_CHECK_MS);
setInterval(() => { if (app.socket && app.socket.readyState === 1) syncClock(); }, RESYNC_INTERVAL_MS);

// ---- Rendering -------------------------------------------------------------

function formatTime(ms) {
    if (!Number.isFinite(ms) || ms < 0) ms = 0;
    const total = Math.floor(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function renderNowPlaying() {
    const state = app.state;
    if (!state) return;

    el('track-title').textContent = state.title || 'Nothing playing';
    el('track-artist').textContent = state.artist || '';
    el('artwork').classList.toggle('spinning', Boolean(state.playing));

    el('play-icon-path').setAttribute(
        'd',
        state.playing ? 'M6 19h4V5H6v14zm8-14v14h4V5h-4z' : 'M8 5v14l11-7z'
    );
    el('play-button').setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
}

function renderProgress() {
    const state = app.state;
    if (!state) return;

    const position = projectPosition(state, serverNow());
    const duration = state.durationMs || 0;
    const percent = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

    el('progress-fill').style.width = `${percent}%`;
    el('time-current').textContent = formatTime(position);
    el('time-total').textContent = formatTime(duration);

    renderActiveLyric(position);
}

setInterval(renderProgress, 250);

/**
 * Applies the host's theme and lyric settings, so a phone in the room matches the
 * laptop driving it.
 */
function applySettings(settings) {
    if (!settings) return;
    app.settings = settings;

    document.body.classList.toggle('light', settings.theme === 'light');
    if (settings.accent) {
        document.documentElement.style.setProperty('--accent', settings.accent);
    }
    el('lyrics').classList.toggle('hidden', settings.lyricsVisible === false);
}

function applyLibrary(library) {
    if (!library) return;
    app.library = library;

    const list = el('queue-list');
    list.innerHTML = '';

    const queue = library.queue || [];
    if (queue.length === 0) {
        list.innerHTML = '<p class="empty">The host has not shared a queue.</p>';
        renderCatalogResults();
        return;
    }

    queue.forEach((track, index) => {
        const item = document.createElement('div');
        item.className = 'queue-item';
        const row = document.createElement('button');
        row.className = 'row' + (index === (app.state && app.state.queueIndex) ? ' active' : '');
        row.innerHTML =
            `<span class="row-title"></span><span class="row-sub"></span>`;
        row.querySelector('.row-title').textContent = track.title || track.id;
        row.querySelector('.row-sub').textContent = track.artist || '';

        // Listeners see the queue but cannot change it.
        if (app.role === 'listener') {
            row.disabled = true;
            row.classList.add('readonly');
        } else {
            row.addEventListener('click', () => sendControl('select', index));
        }
        item.appendChild(row);
        if (app.role !== 'listener') {
            for (const [label, title, action, value] of [
                ['↑', 'Move up', 'queue:move', {trackId: track.id, direction: 'up'}],
                ['↓', 'Move down', 'queue:move', {trackId: track.id, direction: 'down'}],
                ['×', 'Remove', 'queue:remove', {trackId: track.id}],
            ]) {
                if (action === 'queue:move' &&
                    ((value.direction === 'up' && index === 0) ||
                     (value.direction === 'down' && index === queue.length - 1))) continue;
                const button = document.createElement('button');
                button.className = 'queue-action';
                button.textContent = label;
                button.title = title;
                button.setAttribute('aria-label', `${title}: ${track.title || track.id}`);
                button.addEventListener('click', () => sendControl(action, value));
                item.appendChild(button);
            }
        }
        list.appendChild(item);
    });
    renderCatalogResults();
}

function renderCatalogResults() {
    const editor = el('queue-editor');
    const results = el('catalog-results');
    if (!editor || !results) return;
    editor.classList.toggle('hidden', app.role === 'listener');
    results.replaceChildren();
    if (app.role === 'listener') return;
    const query = el('catalog-search').value.trim().toLocaleLowerCase();
    if (!query) return;
    const tracks = (app.library.tracks || []).filter((track) =>
        `${track.title || ''} ${track.artist || ''}`.toLocaleLowerCase().includes(query)).slice(0, 30);
    for (const track of tracks) {
        const row = document.createElement('div');
        row.className = 'catalog-result';
        const name = document.createElement('span');
        name.textContent = `${track.title || track.id} — ${track.artist || ''}`;
        row.appendChild(name);
        for (const [label, position] of [['Top', 'first'], ['Next', 'next'], ['End', 'end']]) {
            const button = document.createElement('button');
            button.className = 'queue-action';
            button.textContent = label;
            button.title = `Add ${track.title || track.id} ${position}`;
            button.addEventListener('click', () => sendControl('queue:add', {trackId: track.id, position}));
            row.appendChild(button);
        }
        results.appendChild(row);
    }
}

function applyLyrics(lyrics) {
    if (!lyrics) return;
    app.lyrics = lyrics;

    const container = el('lyrics');
    container.innerHTML = '';
    container.classList.remove('rtl');

    const lines = lyrics.translation && lyrics.translation.lines
        ? lyrics.translation.lines
        : lyrics.lines;

    if (lyrics.translation && lyrics.translation.rtl) container.classList.add('rtl');

    if (!lines || lines.length === 0) {
        container.innerHTML = '<p class="empty">No lyrics</p>';
        return;
    }

    lines.forEach((line, index) => {
        const p = document.createElement('p');
        p.className = 'lyric-line';
        p.dataset.index = String(index);
        p.textContent = typeof line === 'string' ? line : line.text;
        container.appendChild(p);
    });
}

let lastLyricIndex = -1;

function renderActiveLyric(positionMs) {
    if (!app.lyrics.isSynced || !app.lyrics.lines.length) return;

    // The host's lyric offset is mirrored, so everyone sees the same timing.
    const offset = (app.settings && app.settings.lyricsOffsetMs) || 0;
    const adjusted = positionMs + offset;

    let index = -1;
    for (let i = 0; i < app.lyrics.lines.length; i++) {
        const line = app.lyrics.lines[i];
        const timeMs = typeof line === 'object' ? line.timeMs : 0;
        if (timeMs <= adjusted) index = i; else break;
    }

    if (index === lastLyricIndex) return;
    lastLyricIndex = index;

    const container = el('lyrics');
    container.querySelectorAll('.lyric-line.active').forEach((n) => n.classList.remove('active'));

    const active = container.querySelector(`[data-index="${index}"]`);
    if (!active) return;
    active.classList.add('active');
    container.scrollTop = active.offsetTop - container.clientHeight / 2 + active.offsetHeight / 2;
}

function applyMembers(members) {
    app.members = members || [];

    const badge = el('role-badge');
    badge.textContent = app.role === 'listener' ? 'Listen only' : app.role;
    badge.className = 'badge ' + app.role;

    // Hide transport entirely for listeners: a disabled button they can press and get
    // an error from is worse than no button.
    el('transport').classList.toggle('hidden', app.role === 'listener');
    applyLibrary(app.library);

    const list = el('members-list');
    list.innerHTML = '';
    for (const member of app.members) {
        const row = document.createElement('div');
        row.className = 'row static';
        row.innerHTML = `<span class="row-title"></span><span class="row-sub"></span>`;
        row.querySelector('.row-title').textContent =
            member.name + (member.id === app.memberId ? ' (you)' : '');
        row.querySelector('.row-sub').textContent = member.isHost ? 'Host' : member.role;
        list.appendChild(row);
    }
}

el('catalog-search')?.addEventListener('input', renderCatalogResults);

el('upload-song')?.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file || !app.room || !app.uploadToken) return;
    const status = el('upload-status');
    if (file.size > 30 * 1024 * 1024) {
        status.textContent = 'This song exceeds the 30 MB limit.';
        return;
    }
    status.textContent = 'Uploading song to the host…';
    try {
        const position = el('upload-position').value;
        const response = await fetch(`/api/rooms/${encodeURIComponent(app.room.code)}/uploads?position=${position}`, {
            method: 'POST',
            headers: {'Content-Type': 'application/octet-stream', 'X-Member-Id': app.memberId,
                'X-Upload-Token': app.uploadToken, 'X-File-Name': encodeURIComponent(file.name)},
            body: file,
        });
        const result = await response.json();
        status.textContent = response.ok ? 'Uploaded. Waiting for the host to add it to the queue.' : `Upload failed: ${result.error}`;
    } catch (error) {
        status.textContent = `Upload failed: ${error.message}`;
    } finally {
        event.target.value = '';
    }
});

// ---- UI plumbing -----------------------------------------------------------

let toastTimer = null;

function toast(message) {
    const node = el('toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}

function showJoinError(message) {
    el('join-error').textContent = message || '';
}

function showPlayer() {
    el('join-screen').classList.remove('active');
    el('player-screen').classList.add('active');
    el('room-code-label').textContent = app.room.code;
    try {
        history.replaceState(null, '', `/r/${app.room.code}`);
    } catch (_) { /* file:// or blocked */ }
}

el('join-button').addEventListener('click', () => {
    const code = el('join-code').value.trim().toUpperCase();
    const name = el('join-name').value.trim() || 'Guest';
    const password = el('join-password').value;

    if (code.length < 4) return showJoinError('Enter the room code');
    showJoinError('');

    // Unlock audio here: this click is the user gesture browsers require before an
    // <audio> element may play. Doing it later means the first track is silent.
    audio.play().catch(() => {});
    audio.pause();

    localStorage.setItem('rd-name', name);
    connect({code, name, password});
});

el('join-code').addEventListener('input', (event) => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

el('play-button').addEventListener('click', () => sendControl('toggle'));
el('next-button').addEventListener('click', () => sendControl('next'));
el('prev-button').addEventListener('click', () => sendControl('previous'));

el('progress-track').addEventListener('click', (event) => {
    if (!app.state || !app.state.durationMs) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    sendControl('seek', Math.round(ratio * app.state.durationMs));
});

// Volume is local-only, so it works for listeners too.
el('volume').addEventListener('input', (event) => {
    audio.volume = parseFloat(event.target.value);
    localStorage.setItem('rd-volume', event.target.value);
});

el('members-button').addEventListener('click', () => el('members-panel').classList.add('show'));
el('close-members').addEventListener('click', () => el('members-panel').classList.remove('show'));
el('close-queue').addEventListener('click', () => el('queue-panel').classList.remove('show'));

document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        el('queue-panel').classList.toggle('show', tab.dataset.view === 'queue');
        el('lyrics').classList.toggle('expanded', tab.dataset.view === 'lyrics');
    });
});

// A stall means the relay is behind; realign once it recovers rather than drifting on.
audio.addEventListener('canplay', () => alignPosition(true));
audio.addEventListener('stalled', () => toast('Buffering...'));

// Restore prior session details.
(function restore() {
    const savedName = localStorage.getItem('rd-name');
    if (savedName) el('join-name').value = savedName;

    const savedVolume = localStorage.getItem('rd-volume');
    if (savedVolume !== null) {
        audio.volume = parseFloat(savedVolume);
        el('volume').value = savedVolume;
    }

    // Deep link: /r/ABC123 pre-fills the code.
    const match = /^\/r\/([A-Z0-9]{4,8})/i.exec(location.pathname);
    if (match) el('join-code').value = match[1].toUpperCase();
})();
