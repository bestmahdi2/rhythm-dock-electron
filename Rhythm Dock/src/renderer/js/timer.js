'use strict';

/**
 * Work / sleep timer (request #26).
 *
 * Counts down, fades the music out rather than cutting it, then raises a notification
 * telling the user to get back to work.
 *
 * Two implementation points worth stating:
 *
 *   - The remaining time is derived from a wall-clock deadline, not by decrementing a
 *     counter on each tick. setInterval is throttled hard when a window is hidden or the
 *     machine sleeps, so a decrementing counter drifts badly — a 25 minute timer can
 *     easily run 30+ minutes of real time.
 *   - "End of track" mode is offered because stopping mid-song is jarring; it defers the
 *     stop until the current track finishes.
 */

const TIMER_PRESETS = [
    {label: '5 min', minutes: 5},
    {label: '15 min', minutes: 15},
    {label: '25 min', minutes: 25},
    {label: '45 min', minutes: 45},
    {label: '60 min', minutes: 60},
];

const FADE_SECONDS = 8;

class SleepTimer {
    /**
     * @param {object} options
     * @param {import('./audio/engine').AudioEngine} options.engine
     * @param {(remainingMs: number, totalMs: number) => void} options.onTick
     * @param {(reason: string) => void} options.onFinish
     */
    constructor(options) {
        this.engine = options.engine;
        this.onTick = options.onTick || (() => {});
        this.onFinish = options.onFinish || (() => {});

        this.deadline = 0;
        this.totalMs = 0;
        this.interval = null;
        this.waitingForTrackEnd = false;
        this.fading = false;
        this.restoreVolume = null;
    }

    get active() {
        return this.interval !== null || this.waitingForTrackEnd;
    }

    get remainingMs() {
        if (!this.deadline) return 0;
        return Math.max(0, this.deadline - Date.now());
    }

    /**
     * @param {number} minutes
     * @param {object} [options]
     * @param {boolean} [options.finishTrack] Wait for the current track to end.
     * @param {boolean} [options.fade]        Fade out over the last few seconds.
     */
    start(minutes, {finishTrack = false, fade = true} = {}) {
        this.cancel();

        this.totalMs = Math.max(0, minutes) * 60 * 1000;
        if (this.totalMs === 0) return false;

        this.deadline = Date.now() + this.totalMs;
        this.finishTrack = finishTrack;
        this.fade = fade;

        this.interval = setInterval(() => this._tick(), 500);
        this._tick();
        return true;
    }

    _tick() {
        const remaining = this.remainingMs;
        this.onTick(remaining, this.totalMs);

        // Begin the fade before the deadline so it completes as time runs out.
        if (this.fade && !this.fading && remaining <= FADE_SECONDS * 1000 && remaining > 0) {
            this._beginFade(remaining);
        }

        if (remaining > 0) return;

        clearInterval(this.interval);
        this.interval = null;

        if (this.finishTrack && this.engine.isPlaying()) {
            // Let the track play out. The renderer calls trackEnded() from the engine's
            // 'ended' event; the fade is undone so the last track is heard properly.
            this.waitingForTrackEnd = true;
            this._cancelFade();
            this.onTick(0, this.totalMs);
            return;
        }

        this._stopPlayback('elapsed');
    }

    /** Ramps the engine gain down over the remaining time. */
    _beginFade(remainingMs) {
        this.fading = true;
        this.restoreVolume = this.engine.volume;
        // Reuse the engine's own ramp so the fade goes through the same gain node the
        // rest of the app uses, rather than fighting it.
        this.engine._applyGain(0, Math.max(250, remainingMs));
    }

    _cancelFade() {
        if (!this.fading) return;
        this.fading = false;
        if (this.restoreVolume !== null) {
            this.engine.setVolume(this.restoreVolume, {immediate: false});
            this.restoreVolume = null;
        }
    }

    /** Called by the renderer when a track ends, for "stop after this track" mode. */
    trackEnded() {
        if (!this.waitingForTrackEnd) return false;
        this.waitingForTrackEnd = false;
        this._stopPlayback('track-end');
        return true;
    }

    _stopPlayback(reason) {
        this.engine.pause();

        // Put the volume back, or the next manual play would be silent.
        this.fading = false;
        if (this.restoreVolume !== null) {
            this.engine.setVolume(this.restoreVolume, {immediate: true});
            this.restoreVolume = null;
        }

        this.deadline = 0;
        this.onFinish(reason);
    }

    cancel() {
        clearInterval(this.interval);
        this.interval = null;
        this.waitingForTrackEnd = false;
        this._cancelFade();
        this.deadline = 0;
        this.totalMs = 0;
    }

    /** Adds minutes to a running timer. */
    extend(minutes) {
        if (!this.deadline) return false;
        this.deadline += minutes * 60 * 1000;
        this.totalMs += minutes * 60 * 1000;
        this._cancelFade();
        if (!this.interval) this.interval = setInterval(() => this._tick(), 500);
        return true;
    }
}

/** mm:ss for the countdown readout. */
function formatRemaining(ms) {
    const total = Math.ceil(ms / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

window.RhythmTimer = {SleepTimer, PRESETS: TIMER_PRESETS, formatRemaining};
