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
 * The insert chain is empty for now; Phase 5 splices the equalizer bands into it via
 * `setInsertChain()` without touching anything else.
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

        /** @type {TransportState} */
        this.state = STATE.IDLE;

        this.volume = 1.0;
        this.muted = false;
        this.rate = 1.0;

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

        this.element = new Audio();
        this.element.preload = 'auto';
        // Without this the element streams through its own output as well as through
        // the WebAudio graph, and everything plays twice.
        this.element.crossOrigin = 'anonymous';

        this.source = this.ctx.createMediaElementSource(this.element);
        this.gain = this.ctx.createGain();
        // Start silent. Nothing is audible until an explicit play() ramps this up,
        // which is the belt-and-braces fix for the phantom one second of the previous
        // track that played on launch (#22).
        this.gain.gain.value = 0;

        this._rebuildGraph();
        this._attachElementHandlers();
    }

    /** Reconnects source -> [inserts] -> gain -> destination. */
    _rebuildGraph() {
        if (!this.ctx) return;

        try {
            this.source.disconnect();
        } catch (_) { /* not yet connected */ }
        for (const node of this.insertChain) {
            try {
                node.disconnect();
            } catch (_) { /* not yet connected */ }
        }
        try {
            this.gain.disconnect();
        } catch (_) { /* not yet connected */ }

        let tail = this.source;
        for (const node of this.insertChain) {
            tail.connect(node);
            tail = node;
        }
        tail.connect(this.gain);
        this.gain.connect(this.ctx.destination);
    }

    /**
     * Phase 5 hook: hand in the equalizer's filter nodes, already chained to each other,
     * and they are spliced between the source and the gain.
     */
    setInsertChain(nodes) {
        this.insertChain = Array.isArray(nodes) ? nodes : [];
        this._rebuildGraph();
    }

    _attachElementHandlers() {
        const el = this.element;

        this._handlers = {
            // Fired as soon as duration is known — long before the file has buffered.
            // This is what lets the UI paint a real progress bar instantly (#18).
            loadedmetadata: () => {
                this.emit('metadata', {duration: el.duration});
            },

            canplay: () => {
                if (this.state === STATE.LOADING) this.emit('ready', {duration: el.duration});
            },

            progress: () => {
                if (!el.buffered.length || !el.duration) return;
                this.emit('buffered', {
                    end: el.buffered.end(el.buffered.length - 1),
                    duration: el.duration,
                });
            },

            timeupdate: () => this.emit('time', {seek: el.currentTime, duration: el.duration}),

            play: () => this._setState(STATE.PLAYING),

            pause: () => {
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
                this._setState(STATE.ENDED);
                this.emit('ended', {});
            },

            error: () => {
                const code = el.error ? el.error.code : 0;
                this._setState(STATE.ERROR);
                this.emit('error', {code, src: el.currentSrc});
            },

            // Fired when the browser gives up mid-stream (network drop, file deleted).
            stalled: () => this.emit('stalled', {}),
        };

        for (const [event, handler] of Object.entries(this._handlers)) {
            el.addEventListener(event, handler);
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

        // Silence immediately so nothing from the outgoing track leaks out while the
        // new one is being wired up.
        this._applyGain(0, 0);

        this._setState(STATE.LOADING);

        this.element.src = toFileURL(filePath);
        this.element.playbackRate = this.rate;
        this.element.load();

        if (seek > 0) {
            // currentTime can only be set once the browser knows the duration.
            const applySeek = () => {
                if (ticket !== this.ticket) return;
                try {
                    this.element.currentTime = seek;
                } catch (error) {
                    console.warn('[audio] Could not restore seek position:', error);
                }
            };
            this.element.addEventListener('loadedmetadata', applySeek, {once: true});
        }

        if (autoplay) {
            const start = () => {
                if (ticket !== this.ticket) return;
                this.play();
            };
            this.element.addEventListener('canplay', start, {once: true});
        }

        return ticket;
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

        // Request #21: pressing play on a finished track used to seek past the end and
        // silently do nothing. Restart it instead.
        if (this.state === STATE.ENDED || this._isAtEnd()) {
            this.seek(0);
        }

        try {
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

    /** Releases the current source without tearing down the graph. */
    unload() {
        if (!this.element) return;
        this.ticket++;
        this._applyGain(0, 0);
        this.element.pause();
        this.element.removeAttribute('src');
        this.element.load();
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
    setRate(rate, {preservePitch = true} = {}) {
        this.rate = clamp(rate, 0.25, 4.0);
        if (!this.element) return this.rate;

        this.element.playbackRate = this.rate;
        // Vendor-prefixed variants are still needed on older WebKit.
        this.element.preservesPitch = preservePitch;
        this.element.mozPreservesPitch = preservePitch;
        this.element.webkitPreservesPitch = preservePitch;

        this.emit('ratechange', {rate: this.rate});
        return this.rate;
    }

    getRate() {
        return this.rate;
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
