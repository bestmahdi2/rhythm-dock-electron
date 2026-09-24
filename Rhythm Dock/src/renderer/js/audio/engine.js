'use strict';

/**
 * Rhythm Dock audio engine.
 *
 * Replaces the Howler-based `audioEngine` object that lived in renderer.js.
 *
 * Why the rewrite:
 *
 *   - Howler with `html5: false` decodes the whole file before it will play a single
 *     sample, which is what made large files hang the UI (request #18).
 *   - Howler with `html5: true` fixes that, but bypasses WebAudio entirely — which
 *     would take the volume boost with it and make the Phase 5 equalizer impossible.
 *   - The previous code worked around the volume ceiling by disconnecting
 *     `Howler.masterGain` from the destination and splicing in its own GainNode. That
 *     is a global mutation of Howler's internals and it broke whenever a second Howl
 *     instance appeared.
 *
 * So we drive an `<audio>` element directly and route it through WebAudio via a
 * MediaElementAudioSourceNode. The element streams (instant start, progressive
 * buffering) *and* we keep a real audio graph:
 *
 *   <audio> -> MediaElementSource -> [insert chain] -> gain -> destination
 *
 * Phase 8 generalises that into two decks feeding a shared processing chain:
 *
 *   deckA.element -> deckA.source -> deckA.gain --.
 *                                                 |-> [inserts] -> balance
 *   deckB.element -> deckB.source -> deckB.gain --'                   |
 *                                                                     v
 *      destination <- master <- limiter <- replayGain <- channelMatrix
 *
 * Two decks is what makes gapless handoff and crossfade possible at all: the next
 * track has to be decoding and buffered *before* the current one ends, and a
 * single element cannot hold two files. The deck gains do the crossfade; the
 * master gain keeps doing volume, mute and the play/pause fades, so those two
 * concerns never fight over the same AudioParam.
 *
 * The insert chain is shared by both decks, so the equalizer applies to whatever
 * is audible without being rebuilt on every track change. Phase 5 splices the
 * equalizer bands in via `setInsertChain()` exactly as before.
 *
 * The other half of this module is the transport state machine. Playback state used to
 * be a loose `isPlaying` boolean updated from five different callbacks, which is how the
 * play button ended up stuck on "pause" after a track finished (#11) and how pressing
 * play at the end of a song did nothing at all (#21). There is now exactly one state
 * variable and one place that changes it.
 */

/** @typedef {'idle'|'loading'|'playing'|'paused'|'ended'|'error'} TransportState */

const STATE = {
    IDLE: 'idle',
    LOADING: 'loading',
    PLAYING: 'playing',
    PAUSED: 'paused',
    ENDED: 'ended',
    ERROR: 'error',
};

// How long the gain ramps from silence to the target level when playback starts.
// Request #22: the previous build snapped straight to full volume, which is jarring
// and also let through any stray buffered audio from the previous track.
const FADE_IN_MS = 400;
const FADE_OUT_MS = 120;

// Treat "within this many seconds of the end" as finished, to absorb the fact that
// currentTime frequently stops a few milliseconds short of duration.
const END_EPSILON = 0.25;

// How early the next track is handed the file so it can buffer. Gapless needs the
// decoder warm before the crossover point, and 15s is comfortably more than a
// spinning disk or a network share needs without holding a descriptor all song.
const PRELOAD_LEAD_S = 15;

// Below this the crossfade is treated as off: ramping over 20ms is audibly a cut
// and costs a deck swap for nothing.
const MIN_CROSSFADE_MS = 120;

// Silence detection. -50 dBFS is quiet enough to be inaudible on any sane system
// but loud enough not to trip on dither or tape hiss.
const SILENCE_THRESHOLD_DB = -50;
const SILENCE_HOLD_MS = 400;

/**
 * Converts an OS path into a URL the <audio> element will accept.
 * Windows paths need their backslashes flipped and a leading slash; every path needs
 * its unsafe characters escaped (`#` in a filename otherwise truncates the URL).
 */
function toFileURL(filePath) {
    if (/^(file|https?|blob|data):/i.test(filePath)) return filePath;

    let normalized = filePath.replace(/\\/g, '/');
    if (!normalized.startsWith('/')) normalized = '/' + normalized;

    // encodeURI leaves '/' and ':' alone but escapes spaces, '#', '?' and friends.
    return 'file://' + encodeURI(normalized).replace(/[?#]/g, (c) => '%' + c.charCodeAt(0).toString(16));
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

class AudioEngine {
    constructor() {
        /** @type {AudioContext|null} */
        this.ctx = null;
        /** @type {HTMLAudioElement|null} */
        this.element = null;
        /** @type {MediaElementAudioSourceNode|null} */
        this.source = null;
        /** @type {GainNode|null} */
        this.gain = null;
        /** @type {AudioNode[]} */
        this.insertChain = [];

        /** Two decks so the next track can buffer while this one plays. */
        this.decks = [];
        this.activeDeck = 0;

        /** @type {TransportState} */
        this.state = STATE.IDLE;

        this.volume = 1.0;
        this.muted = false;
        this.rate = 1.0;
        this.preservePitch = true;

        // --- Phase 8 output stage -------------------------------------------
        this.crossfadeMs = 0;          // 0 = off
        this.gapless = true;
        this.balance = 0;              // -1 hard left .. +1 hard right
        this.monoMix = false;
        this.swapChannels = false;
        this.limiterEnabled = true;
        this.replayGainDb = 0;
        /** deviceId -> {dest, element, delay, delayMs}. See addOutput(). */
        this.auxOutputs = new Map();
        this.replayGainEnabled = true;
        this.skipSilence = false;
        this.outputDeviceId = '';

        // A-B repeat. Null when unset; both in seconds.
        this.loopStart = null;
        this.loopEnd = null;

        // What the next track will be, so it can be preloaded. Set by the app.
        this.nextFilePath = null;
        this._preloadedPath = null;
        this._crossfadeStarted = false;
        this._silenceSince = 0;

        // Incremented on every load. Async callbacks compare against it and bail if a
        // newer load has started, which is what stops a slow-loading skipped track from
        // stomping on the one the user actually wants (#6).
        this.ticket = 0;

        this.listeners = new Map();
        this._handlers = null;
    }

    // --- Event plumbing -----------------------------------------------------------

    on(event, callback) {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event).add(callback);
        return () => this.listeners.get(event)?.delete(callback);
    }

    emit(event, payload) {
        const callbacks = this.listeners.get(event);
        if (!callbacks) return;
        for (const callback of callbacks) {
            try {
                callback(payload);
            } catch (error) {
                console.error(`[audio] Listener for "${event}" threw:`, error);
            }
        }
    }

    /**
     * The single place `state` is allowed to change. Everything that cares about
     * transport state listens for 'statechange' rather than tracking its own boolean.
     */
    _setState(next) {
        if (this.state === next) return;
        const previous = this.state;
        this.state = next;
        this.emit('statechange', {state: next, previous});
    }

    // --- Graph --------------------------------------------------------------------

    /**
     * Builds the AudioContext and the element the first time it is needed.
     * Browsers require a user gesture before an AudioContext may start, so this is
     * called lazily from load()/play() rather than at construction.
     */
    _ensureGraph() {
        if (this.ctx) return;

        const ContextClass = window.AudioContext || window.webkitAudioContext;
        this.ctx = new ContextClass();

        // --- Decks --------------------------------------------------------
        for (let i = 0; i < 2; i++) {
            const element = new Audio();
            element.preload = 'auto';
            // Without this the element streams through its own output as well as
            // through the WebAudio graph, and everything plays twice.
            element.crossOrigin = 'anonymous';

            const source = this.ctx.createMediaElementSource(element);
            const gain = this.ctx.createGain();
            // Only the active deck is audible; the other is a silent preloader.
            gain.gain.value = i === 0 ? 1 : 0;
            source.connect(gain);

            this.decks.push({element, source, gain, index: i, handlers: null, filePath: null});
        }

        // --- Shared output stage -------------------------------------------
        //
        // Order matters and is not arbitrary:
        //   balance/matrix first, because they are routing, not level;
        //   replayGain next, so per-track normalisation happens before limiting;
        //   limiter after that, so it catches both the ReplayGain boost and the
        //   volume boost -- the two things that can actually clip;
        //   master last, so play/pause fades ride on top of everything.
        this.balanceNode = this.ctx.createStereoPanner();
        this.replayGainNode = this.ctx.createGain();

        // A safety limiter, not a compressor for effect. The threshold sits just
        // below 0 dBFS with a fast attack, so it is transparent until the signal
        // would otherwise clip -- which the volume boost above 100% guarantees.
        this.limiterNode = this.ctx.createDynamicsCompressor();
        this.limiterNode.threshold.value = -1.5;
        this.limiterNode.knee.value = 0;
        this.limiterNode.ratio.value = 20;
        this.limiterNode.attack.value = 0.002;
        this.limiterNode.release.value = 0.15;

        this.limiterBypass = this.ctx.createGain();

        this.gain = this.ctx.createGain();
        // Start silent. Nothing is audible until an explicit play() ramps this up,
        // which is the belt-and-braces fix for the phantom one second of the previous
        // track that played on launch (#22).
        this.gain.gain.value = 0;

        // Channel matrix for mono downmix and L/R swap. Built once and rewired by
        // _applyChannelMatrix() rather than created per change, because relinking
        // a live graph mid-playback clicks.
        this.matrixIn = this.ctx.createGain();
        this.matrixOut = this.ctx.createGain();
        this.splitter = this.ctx.createChannelSplitter(2);
        this.merger = this.ctx.createChannelMerger(2);

        // Analyser for silence detection. Tapped off the master so it hears exactly
        // what the user hears, including the EQ.
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 1024;
        this._analyserBuffer = new Float32Array(this.analyser.fftSize);

        // Backwards compatibility: renderer code and the equalizer still reach for
        // engine.element and engine.source expecting the single-deck fields.
        this.element = this.decks[0].element;
        this.source = this.decks[0].source;

        this._rebuildGraph();
        for (const deck of this.decks) this._attachDeckHandlers(deck);
    }

    /** The deck currently feeding the output. */
    get _deck() {
        return this.decks[this.activeDeck] || null;
    }

    /** The deck that is idle, or preloading the next track. */
    get _idleDeck() {
        return this.decks[1 - this.activeDeck] || null;
    }

    /** Reconnects decks -> [inserts] -> matrix -> balance -> RG -> limiter -> master. */
    _rebuildGraph() {
        if (!this.ctx) return;

        const safeDisconnect = (node) => {
            if (!node) return;
            try {
                node.disconnect();
            } catch (_) { /* not yet connected */ }
        };

        for (const deck of this.decks) safeDisconnect(deck.gain);
        for (const node of this.insertChain) safeDisconnect(node);
        safeDisconnect(this.matrixOut);
        safeDisconnect(this.balanceNode);
        safeDisconnect(this.replayGainNode);
        safeDisconnect(this.limiterNode);
        safeDisconnect(this.limiterBypass);
        safeDisconnect(this.gain);

        // Both decks feed the head of the shared chain, so the equalizer applies to
        // whichever is audible and survives a deck swap untouched.
        const head = this.insertChain[0] || this.matrixIn;
        for (const deck of this.decks) deck.gain.connect(head);

        let tail = head;
        for (let i = 1; i < this.insertChain.length; i++) {
            tail.connect(this.insertChain[i]);
            tail = this.insertChain[i];
        }
        if (this.insertChain.length) tail.connect(this.matrixIn);

        this._applyChannelMatrix();

        this.matrixOut.connect(this.balanceNode);
        this.balanceNode.connect(this.replayGainNode);

        if (this.limiterEnabled) {
            this.replayGainNode.connect(this.limiterNode);
            this.limiterNode.connect(this.gain);
        } else {
            this.replayGainNode.connect(this.limiterBypass);
            this.limiterBypass.connect(this.gain);
        }

        this.gain.connect(this.ctx.destination);
        this.gain.connect(this.analyser);

        // Extra speakers/headphones hang off the same master, so they carry the
        // volume, EQ and fades without any of it being recomputed.
        for (const output of this.auxOutputs.values()) {
            this.gain.connect(output.delay);
        }
    }

    // --- Simultaneous outputs ---------------------------------------------------
    //
    // Playing to several devices at once -- your earbuds and a friend's, plus the
    // laptop speakers -- looks like it should mean several players, and that is the
    // wrong way to build it. Two elements decoding the same file drift apart within
    // seconds, because nothing keeps their clocks together.
    //
    // Instead there is still exactly one decode and one graph. Each extra device
    // gets a MediaStreamAudioDestinationNode tapped off the same master gain, and
    // that stream is handed to a plain <audio> element pointed at the device with
    // setSinkId. Because every tap comes from one graph, they are sample-aligned by
    // construction and cannot drift.
    //
    // The element trick works here for the same reason it broke the main output:
    // these elements are fed by srcObject and are NOT captured by the AudioContext,
    // so setSinkId does what it says. The primary output is a captured graph and
    // must still go through ctx.setSinkId -- see setOutputDevice().
    //
    // What this cannot fix is latency. Bluetooth adds 100-300ms depending on the
    // codec, and it differs per device, so sample-aligned is not the same as
    // sounding aligned. That is what the per-output delay is for: it holds back the
    // *faster* outputs until they line up with the slowest.

    /**
     * Adds a device as an additional output.
     * @param {string} deviceId from navigator.mediaDevices.enumerateDevices()
     * @param {{delayMs?: number}} options
     */
    async addOutput(deviceId, {delayMs = 0} = {}) {
        if (!deviceId) return {ok: false, error: 'No device was given.'};
        this._ensureGraph();

        if (deviceId === this.outputDeviceId) {
            return {ok: false, error: 'This device is already the main output.'};
        }
        // The system-default alias and a concrete device id can name the same
        // speakers. Chromium exposes their shared groupId when available.
        try {
            const outputs = (await navigator.mediaDevices.enumerateDevices())
                .filter((device) => device.kind === 'audiooutput');
            const primary = outputs.find((device) => device.deviceId === (this.outputDeviceId || 'default'));
            const candidate = outputs.find((device) => device.deviceId === deviceId);
            if (primary?.groupId && candidate?.groupId && primary.groupId === candidate.groupId) {
                return {ok: false, error: 'This device is already the main output.'};
            }
        } catch (_) { /* Routing still works when device enumeration is unavailable. */ }

        if (this.auxOutputs.has(deviceId)) {
            this.setOutputDelay(deviceId, delayMs);
            return {ok: true, deviceId};
        }

        let delay;
        let dest;
        let element;
        try {
            delay = this.ctx.createDelay(2.0);
            delay.delayTime.value = Math.max(0, Math.min(2, delayMs / 1000));

            dest = this.ctx.createMediaStreamDestination();
            delay.connect(dest);

            element = new Audio();
            element.srcObject = dest.stream;
            element.autoplay = true;

            if (typeof element.setSinkId !== 'function') {
                throw new Error('This build cannot route to a chosen device.');
            }
            await element.setSinkId(deviceId);
            // A session restored before the first user gesture can hit the
            // browser's autoplay gate. Keep that stream and retry in play().
            try {
                await element.play();
            } catch (error) {
                if (error.name !== 'NotAllowedError') throw error;
            }

            this.gain.connect(delay);
            this.auxOutputs.set(deviceId, {dest, element, delay, delayMs});

            this.emit('outputschange', {outputs: this.listOutputs()});
            return {ok: true, deviceId};
        } catch (error) {
            try { element?.pause(); } catch (_) { /* not started */ }
            if (element) element.srcObject = null;
            try { delay?.disconnect(); } catch (_) { /* not connected */ }
            for (const track of dest?.stream.getTracks() || []) track.stop();
            console.warn('[audio] Could not add output:', error);
            return {ok: false, error: error.message || 'Could not open that device.'};
        }
    }

    /** Removes an additional output and releases its stream. */
    removeOutput(deviceId) {
        const output = this.auxOutputs.get(deviceId);
        if (!output) return false;

        try {
            this.gain.disconnect(output.delay);
        } catch (_) { /* already detached */ }
        try {
            output.delay.disconnect();
            output.element.pause();
            output.element.srcObject = null;
            for (const track of output.dest.stream.getTracks()) track.stop();
        } catch (_) { /* already torn down */ }

        this.auxOutputs.delete(deviceId);
        this.emit('outputschange', {outputs: this.listOutputs()});
        return true;
    }

    /**
     * Delays one output, in milliseconds.
     *
     * Only ever used to *hold back* an output, never to advance one: you cannot
     * send audio into the past, so alignment means delaying everything else to meet
     * the slowest device.
     */
    setOutputDelay(deviceId, delayMs) {
        const output = this.auxOutputs.get(deviceId);
        if (!output) return false;

        const seconds = Math.max(0, Math.min(2, (Number(delayMs) || 0) / 1000));
        output.delayMs = Math.round(seconds * 1000);

        const now = this.ctx.currentTime;
        output.delay.delayTime.cancelScheduledValues(now);
        output.delay.delayTime.setValueAtTime(output.delay.delayTime.value, now);
        // Ramped rather than jumped: a step change in delay is an audible click.
        output.delay.delayTime.linearRampToValueAtTime(seconds, now + 0.08);
        return true;
    }

    listOutputs() {
        return [...this.auxOutputs.entries()]
            .map(([deviceId, output]) => ({deviceId, delayMs: output.delayMs}));
    }

    removeAllOutputs() {
        for (const deviceId of [...this.auxOutputs.keys()]) this.removeOutput(deviceId);
    }

    /**
     * Wires matrixIn -> matrixOut, either straight through or via a splitter and
     * merger for mono downmix / channel swap.
     *
     * Both are accessibility features as much as audio ones: single-sided hearing
     * loss makes a hard-panned stereo mix unlistenable, and mono fixes it.
     */
    _applyChannelMatrix() {
        if (!this.ctx) return;

        const safeDisconnect = (node) => {
            try {
                node.disconnect();
            } catch (_) { /* not connected */ }
        };
        safeDisconnect(this.matrixIn);
        safeDisconnect(this.splitter);
        safeDisconnect(this.merger);

        if (!this.monoMix && !this.swapChannels) {
            this.matrixIn.connect(this.matrixOut);
            return;
        }

        this.matrixIn.connect(this.splitter);

        if (this.monoMix) {
            // Both inputs to both outputs. The merger sums, so each side carries
            // L+R; the resulting +6 dB is compensated on matrixOut below.
            this.splitter.connect(this.merger, 0, 0);
            this.splitter.connect(this.merger, 1, 0);
            this.splitter.connect(this.merger, 0, 1);
            this.splitter.connect(this.merger, 1, 1);
            this.matrixOut.gain.value = 0.5;
        } else {
            this.splitter.connect(this.merger, 0, 1);
            this.splitter.connect(this.merger, 1, 0);
            this.matrixOut.gain.value = 1;
        }

        this.merger.connect(this.matrixOut);
    }

    /**
     * Phase 5 hook: hand in the equalizer's filter nodes, already chained to each other,
     * and they are spliced between the source and the gain.
     */
    setInsertChain(nodes) {
        this.insertChain = Array.isArray(nodes) ? nodes : [];
        this._rebuildGraph();
    }

    /**
     * Attaches media handlers to one deck.
     *
     * Every handler is gated on the deck being the active one. The idle deck is
     * loading and buffering the next track the whole time it is silent, and its
     * `timeupdate`/`loadedmetadata` events would otherwise drive the progress bar
     * and the lyrics from the wrong file.
     */
    _attachDeckHandlers(deck) {
        const el = deck.element;
        const isLive = () => this.activeDeck === deck.index;

        deck.handlers = {
            // Fired as soon as duration is known — long before the file has buffered.
            // This is what lets the UI paint a real progress bar instantly (#18).
            loadedmetadata: () => {
                if (!isLive()) return;
                this.emit('metadata', {duration: el.duration});
            },

            canplay: () => {
                if (!isLive()) return;
                if (this.state === STATE.LOADING) this.emit('ready', {duration: el.duration});
            },

            progress: () => {
                if (!isLive() || !el.buffered.length || !el.duration) return;
                this.emit('buffered', {
                    end: el.buffered.end(el.buffered.length - 1),
                    duration: el.duration,
                });
            },

            timeupdate: () => {
                if (!isLive()) return;
                this._onTick(el);
                this.emit('time', {seek: el.currentTime, duration: el.duration});
            },

            play: () => {
                if (!isLive()) return;
                this._setState(STATE.PLAYING);
            },

            pause: () => {
                if (!isLive()) return;
                // Some engines fire `pause` immediately before `ended` when playback
                // runs out. If we honoured it we would flash the PAUSED state for a
                // frame — the play icon visibly flickers — and, worse, if `ended` were
                // ever dropped we would be stuck showing "paused" on a finished track
                // that refuses to resume. Both are request #11. So a pause that lands
                // at the very end of the media is treated as the end.
                if (this.state === STATE.ENDED) return;
                if (this._isAtEnd()) {
                    this._setState(STATE.ENDED);
                    return;
                }
                this._setState(STATE.PAUSED);
            },

            ended: () => {
                if (!isLive()) return;
                // A crossfade already handed over and emitted 'ended'; the outgoing
                // element reaching its true end afterwards must not fire it twice.
                if (this._crossfadeStarted) return;
                this._setState(STATE.ENDED);
                this.emit('ended', {});
            },

            error: () => {
                if (!isLive()) {
                    // A failed preload is not a playback error. Forget it and let the
                    // normal load path report the problem when the track comes up.
                    this._preloadedPath = null;
                    return;
                }
                const code = el.error ? el.error.code : 0;
                this._setState(STATE.ERROR);
                this.emit('error', {code, src: el.currentSrc});
            },

            // Fired when the browser gives up mid-stream (network drop, file deleted).
            stalled: () => {
                if (isLive()) this.emit('stalled', {});
            },
        };

        for (const [event, handler] of Object.entries(deck.handlers)) {
            el.addEventListener(event, handler);
        }
    }

    /**
     * Runs on every timeupdate of the live deck: A-B looping, silence skipping,
     * and the decision to start preloading or crossfading into the next track.
     */
    _onTick(el) {
        const position = el.currentTime;
        const duration = Number.isFinite(el.duration) ? el.duration : 0;

        // --- A-B repeat ---
        if (this.loopStart != null && this.loopEnd != null && position >= this.loopEnd) {
            this.seek(this.loopStart);
            this.emit('looped', {start: this.loopStart, end: this.loopEnd});
            return;
        }

        if (!duration) return;

        // --- Skip silence ---
        if (this.skipSilence) this._checkSilence(position, duration);

        const remaining = duration - position;

        // --- Preload the next track ---
        if (this.gapless && this.nextFilePath && remaining <= PRELOAD_LEAD_S
            && this._preloadedPath !== this.nextFilePath) {
            this.preloadNext(this.nextFilePath);
        }

        // --- Crossfade ---
        const fadeSeconds = this.crossfadeMs / 1000;
        if (this.crossfadeMs >= MIN_CROSSFADE_MS
            && this.nextFilePath
            && !this._crossfadeStarted
            && remaining <= fadeSeconds
            && remaining > 0) {
            this._beginCrossfade();
        }
    }

    /**
     * Measures the output level and jumps forward through dead air.
     *
     * Deliberately limited to the head and tail of a track. Mid-song silence is
     * usually intentional -- a rest, a false ending, an ambient passage -- and
     * skipping it would be a bug, not a feature.
     */
    _checkSilence(position, duration) {
        if (!this.analyser) return;

        const inHead = position < 20;
        const inTail = duration - position < 20;
        if (!inHead && !inTail) {
            this._silenceSince = 0;
            return;
        }

        this.analyser.getFloatTimeDomainData(this._analyserBuffer);
        let sum = 0;
        for (let i = 0; i < this._analyserBuffer.length; i++) {
            sum += this._analyserBuffer[i] * this._analyserBuffer[i];
        }
        const rms = Math.sqrt(sum / this._analyserBuffer.length);
        const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;

        if (db > SILENCE_THRESHOLD_DB) {
            this._silenceSince = 0;
            return;
        }

        const now = Date.now();
        if (!this._silenceSince) {
            this._silenceSince = now;
            return;
        }
        if (now - this._silenceSince < SILENCE_HOLD_MS) return;

        this._silenceSince = 0;
        if (inTail) {
            // Trailing silence: end the track rather than sitting through it.
            this._setState(STATE.ENDED);
            this.emit('ended', {reason: 'silence'});
        } else {
            this.seek(Math.min(position + 1, duration - 1));
        }
    }

    // --- Loading ------------------------------------------------------------------

    /**
     * Points the engine at a new file.
     *
     * Returns the ticket for this load. Callers that kick off async work (metadata
     * lookups, lyric fetches) should capture it and compare with `engine.ticket`
     * before applying their result.
     */
    load(filePath, {autoplay = false, seek = 0} = {}) {
        this._ensureGraph();

        const ticket = ++this.ticket;

        this._crossfadeStarted = false;
        this._silenceSince = 0;
        this.clearLoop();

        // If the idle deck has already buffered exactly this file -- which is what
        // gapless preloading is for -- swap to it instead of reloading. That is the
        // difference between an instant start and a fresh decode.
        const idle = this._idleDeck;
        if (idle && this._preloadedPath === filePath && seek === 0 && idle.element.src) {
            this._swapDecks({fadeMs: 0});
            this._preloadedPath = null;
            this._deck.element.playbackRate = this.rate;
            this._applyPreservePitch(this._deck.element);
            this._setState(STATE.LOADING);
            if (autoplay) this.play();
            return ticket;
        }

        // Silence immediately so nothing from the outgoing track leaks out while the
        // new one is being wired up.
        this._applyGain(0, 0);
        this._setState(STATE.LOADING);

        const deck = this._deck;
        deck.filePath = filePath;
        deck.element.src = toFileURL(filePath);
        deck.element.playbackRate = this.rate;
        this._applyPreservePitch(deck.element);
        deck.element.load();

        // The idle deck must not keep an old file buffered behind the new one.
        this._releaseIdleDeck();

        if (seek > 0) {
            // currentTime can only be set once the browser knows the duration.
            const applySeek = () => {
                if (ticket !== this.ticket) return;
                try {
                    deck.element.currentTime = seek;
                } catch (error) {
                    console.warn('[audio] Could not restore seek position:', error);
                }
            };
            deck.element.addEventListener('loadedmetadata', applySeek, {once: true});
        }

        if (autoplay) {
            const start = () => {
                if (ticket !== this.ticket) return;
                this.play();
            };
            deck.element.addEventListener('canplay', start, {once: true});
        }

        return ticket;
    }

    // --- Gapless and crossfade (Phase 8) ---------------------------------------

    /**
     * Tells the engine what is coming next so it can be buffered in advance.
     * The app calls this whenever the queue changes; passing null disables it.
     */
    setNextTrack(filePath) {
        this.nextFilePath = filePath || null;
        if (!filePath) this._releaseIdleDeck();
    }

    /** Starts buffering `filePath` on the idle deck, silently. */
    preloadNext(filePath) {
        this._ensureGraph();
        const idle = this._idleDeck;
        if (!idle || !filePath || this._preloadedPath === filePath) return;

        try {
            idle.gain.gain.value = 0;
            idle.element.src = toFileURL(filePath);
            idle.element.playbackRate = this.rate;
            this._applyPreservePitch(idle.element);
            idle.element.load();
            idle.filePath = filePath;
            this._preloadedPath = filePath;
        } catch (error) {
            console.warn('[audio] Preload failed:', error);
            this._preloadedPath = null;
        }
    }

    /** Drops whatever the idle deck was holding, freeing the descriptor. */
    _releaseIdleDeck() {
        const idle = this._idleDeck;
        if (!idle || !idle.element.src) return;
        try {
            idle.element.pause();
            idle.element.removeAttribute('src');
            idle.element.load();
        } catch (_) { /* nothing loaded */ }
        idle.filePath = null;
        this._preloadedPath = null;
    }

    /**
     * Makes the idle deck the live one.
     * The two deck gains ramp in opposite directions over the same window, which is
     * an equal-gain crossfade. Equal-*power* would hold loudness better for
     * unrelated material, but it lifts the sum above unity in the middle, and for a
     * player that mostly crossfades between tracks from the same album that trade
     * is not worth the risk of clipping.
     */
    _swapDecks({fadeMs = 0} = {}) {
        if (!this.ctx) return;
        const outgoing = this._deck;
        const incoming = this._idleDeck;
        if (!incoming) return;

        const now = this.ctx.currentTime;
        const seconds = Math.max(0, fadeMs) / 1000;

        for (const [node, target] of [[outgoing.gain, 0], [incoming.gain, 1]]) {
            node.gain.cancelScheduledValues(now);
            node.gain.setValueAtTime(node.gain.value, now);
            if (seconds > 0) {
                node.gain.linearRampToValueAtTime(target, now + seconds);
            } else {
                node.gain.setValueAtTime(target, now);
            }
        }

        this.activeDeck = 1 - this.activeDeck;

        // Keep the legacy single-deck aliases pointing at whatever is live.
        this.element = this._deck.element;
        this.source = this._deck.source;

        // Retire the outgoing deck once the fade has finished.
        const ticket = this.ticket;
        setTimeout(() => {
            if (ticket !== this.ticket) return;
            try {
                outgoing.element.pause();
                outgoing.element.removeAttribute('src');
                outgoing.element.load();
            } catch (_) { /* already released */ }
            outgoing.filePath = null;
        }, fadeMs + 60);
    }

    /** Begins the overlap into the preloaded next track. */
    _beginCrossfade() {
        const idle = this._idleDeck;
        if (!idle || !idle.element.src) {
            // Nothing buffered to fade into; let the track end normally.
            return;
        }

        this._crossfadeStarted = true;
        this.ticket++;

        idle.element.currentTime = 0;
        idle.element.play().catch(() => { /* superseded */ });

        this._swapDecks({fadeMs: this.crossfadeMs});
        this._preloadedPath = null;
        this._setState(STATE.PLAYING);

        // The app still needs to advance its queue pointer and update the UI, so the
        // same event fires as for a natural end -- just early.
        this.emit('ended', {reason: 'crossfade'});
    }

    // --- Transport ----------------------------------------------------------------

    /**
     * Ramps the gain to `target` over `ms`.
     * setTargetAtTime is deliberately avoided — it is exponential and never actually
     * reaches zero, which leaves a faint bleed on pause.
     */
    _applyGain(target, ms = FADE_IN_MS) {
        if (!this.ctx || !this.gain) return;
        const now = this.ctx.currentTime;
        const param = this.gain.gain;

        param.cancelScheduledValues(now);
        // Pin the current value first, otherwise the ramp starts from whatever was last
        // *scheduled* rather than what is actually playing, and it jumps.
        param.setValueAtTime(param.value, now);
        param.linearRampToValueAtTime(target, now + ms / 1000);
    }

    /** The gain the graph should sit at when audible. */
    _targetGain() {
        return this.muted ? 0 : this.volume;
    }

    async play() {
        this._ensureGraph();

        // Autoplay policy: the context starts suspended until a user gesture.
        if (this.ctx.state === 'suspended') {
            try {
                await this.ctx.resume();
            } catch (error) {
                console.warn('[audio] Could not resume AudioContext:', error);
            }
        }

        // One line, once per session. A graph that is wired but inaudible gives no
        // error anywhere, so the state that decides whether sound comes out is
        // worth printing rather than guessing at.
        if (!this._loggedGraph) {
            this._loggedGraph = true;
            console.log(
                `[audio] context=${this.ctx.state} `
                + `output=${this.outputDeviceId || 'system default'} `
                + `limiter=${this.limiterEnabled} decks=${this.decks.length}`
            );
        }

        // Request #21: pressing play on a finished track used to seek past the end and
        // silently do nothing. Restart it instead.
        if (this.state === STATE.ENDED || this._isAtEnd()) {
            this.seek(0);
        }

        try {
            // A restored media-stream element may have been blocked before the
            // first user gesture. Retry when the user actually starts playback.
            for (const output of this.auxOutputs.values()) {
                if (output.element.paused) {
                    output.element.play().catch((error) => {
                        console.warn('[audio] Could not resume extra output:', error);
                    });
                }
            }
            await this.element.play();
            this._applyGain(this._targetGain(), FADE_IN_MS);
        } catch (error) {
            // AbortError is normal: it means a newer load() superseded this play call.
            if (error && error.name !== 'AbortError') {
                console.error('[audio] play() rejected:', error);
                this._setState(STATE.ERROR);
                this.emit('error', {code: 0, src: this.element.currentSrc, error});
            }
        }
    }

    pause() {
        if (!this.element) return;
        this._applyGain(0, FADE_OUT_MS);
        // Let the fade finish before actually pausing, so it is a fade rather than a cut.
        const ticket = this.ticket;
        setTimeout(() => {
            if (ticket !== this.ticket) return;
            if (this.state === STATE.PLAYING || this.state === STATE.LOADING) {
                this.element.pause();
            }
        }, FADE_OUT_MS);
    }

    toggle() {
        if (this.state === STATE.PLAYING) {
            this.pause();
        } else {
            this.play();
        }
    }

    stop() {
        if (!this.element) return;
        this._applyGain(0, 0);
        this.element.pause();
        try {
            this.element.currentTime = 0;
        } catch (_) { /* nothing loaded */ }
        this._setState(STATE.IDLE);
    }

    /** Releases both decks without tearing down the graph. */
    unload() {
        if (!this.element) return;
        this.ticket++;
        this._applyGain(0, 0);
        this._crossfadeStarted = false;
        for (const deck of this.decks) {
            try {
                deck.element.pause();
                deck.element.removeAttribute('src');
                deck.element.load();
            } catch (_) { /* nothing loaded */ }
            deck.filePath = null;
        }
        this._preloadedPath = null;
        this._setState(STATE.IDLE);
    }

    _isAtEnd() {
        if (!this.element || !Number.isFinite(this.element.duration)) return false;
        return this.element.currentTime >= this.element.duration - END_EPSILON;
    }

    // --- Position -----------------------------------------------------------------

    /** Howler-compatible accessor: `seek()` reads, `seek(t)` writes. */
    seek(seconds) {
        if (!this.element) return 0;
        if (seconds === undefined) return this.element.currentTime || 0;

        const target = clamp(seconds, 0, this.duration() || 0);
        try {
            this.element.currentTime = target;
            // Seeking backwards out of a finished track makes it playable again.
            if (this.state === STATE.ENDED && target < this.duration() - END_EPSILON) {
                this._setState(STATE.PAUSED);
            }
        } catch (error) {
            console.warn('[audio] Seek failed:', error);
        }
        return target;
    }

    duration() {
        if (!this.element) return 0;
        return Number.isFinite(this.element.duration) ? this.element.duration : 0;
    }

    /** Seconds of contiguous audio buffered from the current position. */
    buffered() {
        if (!this.element || !this.element.buffered.length) return 0;
        return this.element.buffered.end(this.element.buffered.length - 1);
    }

    // --- Levels -------------------------------------------------------------------

    /**
     * Volume may exceed 1.0 — that is the volume-boost feature, and it works because
     * the GainNode has no ceiling (unlike HTMLMediaElement.volume, which clamps at 1).
     */
    setVolume(level, {immediate = false} = {}) {
        this.volume = Math.max(0, level);
        if (this.state === STATE.PLAYING) {
            this._applyGain(this._targetGain(), immediate ? 0 : 60);
        }
    }

    setMuted(muted) {
        this.muted = Boolean(muted);
        if (this.state === STATE.PLAYING) {
            this._applyGain(this._targetGain(), 60);
        }
    }

    /**
     * Playback speed (requests #19 / #23).
     * `preservesPitch` keeps voices from turning into chipmunks; it is on by default
     * but exposed so a "tape mode" can be offered later.
     */
    setRate(rate, {preservePitch = this.preservePitch} = {}) {
        this.rate = clamp(rate, 0.25, 4.0);
        this.preservePitch = preservePitch;
        if (!this.decks.length) return this.rate;

        // Both decks, or the preloaded track starts at the wrong speed on handover.
        for (const deck of this.decks) {
            deck.element.playbackRate = this.rate;
            this._applyPreservePitch(deck.element);
        }

        this.emit('ratechange', {rate: this.rate});
        return this.rate;
    }

    /** Vendor-prefixed variants are still needed on older WebKit. */
    _applyPreservePitch(element) {
        element.preservesPitch = this.preservePitch;
        element.mozPreservesPitch = this.preservePitch;
        element.webkitPreservesPitch = this.preservePitch;
    }

    /**
     * Turning this off gives tape-style pitch bend with speed, which some people
     * actively want for practice or for effect. On is the right default: without
     * it, changing speed makes voices unlistenable.
     */
    setPreservePitch(enabled) {
        this.preservePitch = Boolean(enabled);
        for (const deck of this.decks) this._applyPreservePitch(deck.element);
        return this.preservePitch;
    }

    getRate() {
        return this.rate;
    }

    // --- Output stage (Phase 8) -------------------------------------------------

    /** Crossfade length in ms. Anything under MIN_CROSSFADE_MS disables it. */
    setCrossfade(ms) {
        this.crossfadeMs = Math.max(0, Math.round(ms) || 0);
        return this.crossfadeMs;
    }

    /**
     * Gapless preloading. Separate from crossfade because they are different
     * wants: gapless is for albums that must not have a gap, crossfade is for
     * playlists that should blend. Crossfade implies gapless; gapless alone does
     * not blend.
     */
    setGapless(enabled) {
        this.gapless = Boolean(enabled);
        if (!this.gapless) this._releaseIdleDeck();
        return this.gapless;
    }

    /** -1 hard left, 0 centre, +1 hard right. */
    setBalance(value) {
        this.balance = clamp(Number(value) || 0, -1, 1);
        if (this.balanceNode) this.balanceNode.pan.value = this.balance;
        return this.balance;
    }

    setMonoMix(enabled) {
        this.monoMix = Boolean(enabled);
        this._applyChannelMatrix();
        return this.monoMix;
    }

    setSwapChannels(enabled) {
        this.swapChannels = Boolean(enabled);
        this._applyChannelMatrix();
        return this.swapChannels;
    }

    /**
     * The limiter is what makes the volume boost safe. With it off, boosting past
     * 100% clips hard; with it on, the peaks are caught instead.
     */
    setLimiter(enabled) {
        this.limiterEnabled = Boolean(enabled);
        this._rebuildGraph();
        return this.limiterEnabled;
    }

    /**
     * Applies a ReplayGain value in dB, read from the file's tags.
     *
     * This only *applies* existing tags -- it does not scan. Scanning means
     * decoding every file in the library and is a phase of its own; but a large
     * share of well-tagged music already carries these values, and honouring them
     * is what stops a quiet 1970s master being inaudible after a loud modern one.
     */
    setReplayGain(db) {
        this.replayGainDb = Number.isFinite(db) ? db : 0;
        this._applyReplayGain();
        return this.replayGainDb;
    }

    setReplayGainEnabled(enabled) {
        this.replayGainEnabled = Boolean(enabled);
        this._applyReplayGain();
        return this.replayGainEnabled;
    }

    _applyReplayGain() {
        if (!this.replayGainNode || !this.ctx) return;
        const db = this.replayGainEnabled ? this.replayGainDb : 0;
        // Clamped: a corrupt tag claiming +30 dB should not deafen anyone.
        const linear = Math.pow(10, clamp(db, -24, 12) / 20);
        const now = this.ctx.currentTime;
        this.replayGainNode.gain.cancelScheduledValues(now);
        this.replayGainNode.gain.setValueAtTime(this.replayGainNode.gain.value, now);
        this.replayGainNode.gain.linearRampToValueAtTime(linear, now + 0.05);
    }

    setSkipSilence(enabled) {
        this.skipSilence = Boolean(enabled);
        this._silenceSince = 0;
        return this.skipSilence;
    }

    /**
     * Routes output to a specific device rather than following the system default.
     *
     * This MUST go through the AudioContext, not through the media elements.
     *
     * HTMLMediaElement.setSinkId() re-points the *element's own* output at a
     * device. But these elements do not render their own output at all -- they
     * feed a MediaElementAudioSourceNode, and everything audible comes out of the
     * AudioContext's destination instead. Calling setSinkId on a captured element
     * detaches that routing and the graph goes silent. The promise resolves
     * successfully, nothing is logged, and playback continues with the progress
     * bar advancing over total silence, which is exactly what made this so hard to
     * spot.
     *
     * AudioContext.setSinkId (Chromium 110+, so fine on Electron 31) is the
     * supported way to move a WebAudio graph to another device.
     */
    async setOutputDevice(deviceId) {
        this._ensureGraph();
        const requested = deviceId || '';

        // An empty id means "system default", which is already the case. Doing
        // nothing here also means the common path never touches sink routing at
        // all -- the safest possible default.
        if (!requested) {
            if (typeof this.ctx.setSinkId === 'function') {
                try {
                    await this.ctx.setSinkId('');
                } catch (error) {
                    console.warn('[audio] Could not restore the default output:', error);
                    return false;
                }
            }
            this.outputDeviceId = '';
            return true;
        }

        if (typeof this.ctx.setSinkId !== 'function') {
            console.warn('[audio] This build cannot choose an output device; using the system default.');
            return false;
        }

        try {
            await this.ctx.setSinkId(requested);
            this.outputDeviceId = requested;
            // The same device cannot be both primary and an auxiliary stream.
            this.removeOutput(requested);
            return true;
        } catch (error) {
            console.warn('[audio] Could not set output device:', error);
            return false;
        }
    }

    // --- A-B repeat --------------------------------------------------------------

    /**
     * Loops between two points. The most requested feature by anyone learning an
     * instrument or a language, and about twenty lines of work.
     */
    setLoop(start, end) {
        if (start == null || end == null || end <= start) {
            this.clearLoop();
            return null;
        }
        this.loopStart = Math.max(0, start);
        this.loopEnd = end;
        this.emit('loopchange', {start: this.loopStart, end: this.loopEnd});
        return {start: this.loopStart, end: this.loopEnd};
    }

    clearLoop() {
        const had = this.loopStart != null;
        this.loopStart = null;
        this.loopEnd = null;
        if (had) this.emit('loopchange', {start: null, end: null});
    }

    getLoop() {
        return {start: this.loopStart, end: this.loopEnd};
    }

    // --- Queries ------------------------------------------------------------------

    isPlaying() {
        return this.state === STATE.PLAYING;
    }

    hasEnded() {
        return this.state === STATE.ENDED;
    }

    isBusy() {
        return this.state === STATE.LOADING;
    }
}

// Exposed as a global because the renderer is loaded as a classic script, not a module.
window.RhythmAudio = {
    AudioEngine,
    STATE,
    toFileURL,
    engine: new AudioEngine(),
};
