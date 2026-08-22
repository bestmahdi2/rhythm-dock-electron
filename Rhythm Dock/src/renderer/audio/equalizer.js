'use strict';

/**
 * 10-band equalizer (request #25).
 *
 * Plugs into the insert chain the Phase 2 engine deliberately left open:
 *
 *   <audio> -> source -> [preamp -> band0 .. band9] -> gain -> destination
 *
 * Design notes:
 *
 *   - The outer bands are shelving filters, not peaking ones. A peaking filter at 32Hz
 *     leaves everything below it untouched, so dragging the bass slider up does almost
 *     nothing audible; a lowshelf lifts the whole bottom end, which is what a user
 *     expects a "32Hz" slider to do. Same argument for the 16kHz highshelf.
 *   - Boosting bands adds gain and will clip. A preamp sits in front, and the default
 *     presets ship with negative preamp values proportional to their maximum boost.
 *   - Gain changes are ramped, because writing straight to `.gain.value` on a live
 *     BiquadFilterNode produces an audible click.
 */

// ISO standard 10-band centre frequencies.
const BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

const MIN_GAIN = -12;
const MAX_GAIN = 12;

// Q for the peaking bands. ~1.4 gives roughly one-octave bandwidth, so adjacent bands
// overlap slightly rather than leaving gaps between them.
const PEAKING_Q = 1.41;
const SHELF_Q = 0.71;

const RAMP_SECONDS = 0.05;

/**
 * Presets are 10 gain values, one per band, plus a preamp.
 * The preamp offsets the loudest boost so a preset cannot clip on its own.
 */
const PRESETS = {
    flat: {label: 'Flat', preamp: 0, gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]},
    bass: {label: 'Bass Boost', preamp: -4, gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0]},
    treble: {label: 'Treble Boost', preamp: -4, gains: [0, 0, 0, 0, 0, 1, 3, 4, 5, 6]},
    vocal: {label: 'Vocal', preamp: -2, gains: [-2, -2, 0, 2, 4, 4, 3, 1, 0, -1]},
    rock: {label: 'Rock', preamp: -4, gains: [5, 4, 2, -1, -2, 0, 2, 4, 5, 5]},
    pop: {label: 'Pop', preamp: -3, gains: [-1, 0, 2, 4, 4, 2, 0, -1, -1, -1]},
    jazz: {label: 'Jazz', preamp: -3, gains: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3]},
    classical: {label: 'Classical', preamp: -2, gains: [4, 3, 2, 0, -1, -1, 0, 2, 3, 4]},
    electronic: {label: 'Electronic', preamp: -4, gains: [5, 4, 1, 0, -2, 2, 1, 2, 4, 5]},
    podcast: {label: 'Speech', preamp: -2, gains: [-4, -3, 0, 3, 5, 5, 4, 2, 0, -2]},
};

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/** Converts a dB value to a linear gain multiplier, for the preamp GainNode. */
function dbToLinear(db) {
    return Math.pow(10, db / 20);
}

class Equalizer {
    /**
     * @param {import('./engine').AudioEngine} engine
     */
    constructor(engine) {
        this.engine = engine;
        this.enabled = false;
        this.preampDb = 0;
        this.gains = new Array(BANDS.length).fill(0);
        this.presetName = 'flat';

        /** @type {GainNode|null} */
        this.preamp = null;
        /** @type {BiquadFilterNode[]} */
        this.filters = [];
        this.built = false;
    }

    get bands() {
        return BANDS;
    }

    /** Builds the filter chain. Requires the engine's AudioContext to exist. */
    _build() {
        if (this.built) return true;

        // Touching play() creates the context; before that there is nothing to attach to.
        this.engine._ensureGraph();
        const ctx = this.engine.ctx;
        if (!ctx) return false;

        this.preamp = ctx.createGain();
        this.preamp.gain.value = dbToLinear(this.preampDb);

        this.filters = BANDS.map((frequency, index) => {
            const filter = ctx.createBiquadFilter();

            if (index === 0) {
                filter.type = 'lowshelf';
                filter.Q.value = SHELF_Q;
            } else if (index === BANDS.length - 1) {
                filter.type = 'highshelf';
                filter.Q.value = SHELF_Q;
            } else {
                filter.type = 'peaking';
                filter.Q.value = PEAKING_Q;
            }

            filter.frequency.value = frequency;
            filter.gain.value = this.gains[index];
            return filter;
        });

        this.built = true;
        return true;
    }

    /**
     * Attaches or detaches the chain.
     *
     * Detaching hands the engine an empty insert chain rather than zeroing every band:
     * a bank of ten biquads at 0dB is not perfectly transparent (each still applies its
     * phase response), so "off" should mean genuinely bypassed.
     */
    setEnabled(enabled) {
        this.enabled = Boolean(enabled);

        if (this.enabled) {
            if (!this._build()) return false;
            this.engine.setInsertChain([this.preamp, ...this.filters]);
        } else {
            this.engine.setInsertChain([]);
        }
        return this.enabled;
    }

    /** Sets one band's gain in dB. */
    setBandGain(index, db) {
        if (index < 0 || index >= BANDS.length) return;

        const value = clamp(Number(db) || 0, MIN_GAIN, MAX_GAIN);
        this.gains[index] = value;
        this.presetName = 'custom';

        if (this.built && this.filters[index]) {
            const param = this.filters[index].gain;
            const now = this.engine.ctx.currentTime;
            // Ramp rather than assign: a step change in a live biquad's gain clicks.
            param.cancelScheduledValues(now);
            param.setValueAtTime(param.value, now);
            param.linearRampToValueAtTime(value, now + RAMP_SECONDS);
        }
    }

    setPreamp(db) {
        this.preampDb = clamp(Number(db) || 0, MIN_GAIN, MAX_GAIN);
        if (this.built && this.preamp) {
            const param = this.preamp.gain;
            const now = this.engine.ctx.currentTime;
            param.cancelScheduledValues(now);
            param.setValueAtTime(param.value, now);
            param.linearRampToValueAtTime(dbToLinear(this.preampDb), now + RAMP_SECONDS);
        }
    }

    applyPreset(name) {
        const preset = PRESETS[name];
        if (!preset) return false;

        preset.gains.forEach((gain, index) => this.setBandGain(index, gain));
        this.setPreamp(preset.preamp);
        // setBandGain marks the state custom; restore the real name afterwards.
        this.presetName = name;
        return true;
    }

    reset() {
        this.applyPreset('flat');
    }

    /** Serialisable state for persistence. */
    toJSON() {
        return {
            enabled: this.enabled,
            preamp: this.preampDb,
            gains: [...this.gains],
            preset: this.presetName,
        };
    }

    /** Restores persisted state. Does not build the graph until enabled. */
    fromJSON(state) {
        if (!state || typeof state !== 'object') return;

        if (Array.isArray(state.gains) && state.gains.length === BANDS.length) {
            this.gains = state.gains.map((gain) => clamp(Number(gain) || 0, MIN_GAIN, MAX_GAIN));
        }
        this.preampDb = clamp(Number(state.preamp) || 0, MIN_GAIN, MAX_GAIN);
        this.presetName = typeof state.preset === 'string' ? state.preset : 'custom';

        if (this.built) {
            this.gains.forEach((gain, index) => {
                if (this.filters[index]) this.filters[index].gain.value = gain;
            });
            if (this.preamp) this.preamp.gain.value = dbToLinear(this.preampDb);
        }

        this.setEnabled(Boolean(state.enabled));
    }
}

window.RhythmEQ = {Equalizer, PRESETS, BANDS, MIN_GAIN, MAX_GAIN};
