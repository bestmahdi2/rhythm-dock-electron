'use strict';

/**
 * Pause playback when headphones are unplugged (request #3).
 *
 * There is no browser API that says "the headphones were removed". What we get is
 * `navigator.mediaDevices.devicechange`, which fires for *any* change to the device
 * list — plugging in a webcam, a monitor with speakers waking up, a Bluetooth device
 * reconnecting. Pausing on every one of those would be maddening.
 *
 * So this module keeps a snapshot of the audio *output* devices and only reacts when a
 * active output disappears or the system default switches away from it. The rules:
 *
 *   1. Compare output device IDs before and after. Only removals count; additions never
 *      pause. (This alone rules out the webcam case.)
 *   2. If the removed device was the one we were playing through, pause.
 *   3. When default identity is unavailable, a headphone disappearance is a fallback.
 *
 * Device labels are only populated once the page has microphone permission, which a
 * music player does not have. Rule 1 works on IDs and needs no labels, so it remains
 * correct without permission; rule 3 is a best-effort refinement when labels exist.
 */

// Substrings that identify a personal listening device across common OS namings,
// including a few non-English labels Windows produces.
const HEADPHONE_HINTS = [
    'headphone', 'headset', 'earphone', 'earbud', 'airpod', 'buds', 'handsfree',
    'hands-free', 'bluetooth', 'usb audio', 'wh-', 'wf-', 'quietcomfort', 'beats',
    'écouteur', 'casque', 'kopfhörer', 'auricular', 'наушник',
];

const DEBOUNCE_MS = 250;

function looksLikeHeadphones(label) {
    const text = String(label || '').toLowerCase();
    if (!text) return false;
    return HEADPHONE_HINTS.some((hint) => text.includes(hint));
}

class OutputDeviceWatcher {
    /**
     * @param {object} options
     * @param {() => void} options.onDisconnect  Called when headphones appear to be gone.
     * @param {() => boolean} options.isPlaying  Only fire when something is playing.
     */
    constructor(options) {
        this.onDisconnect = options.onDisconnect;
        this.isPlaying = options.isPlaying || (() => false);
        this.activeOutputs = options.activeOutputs || (() => ['default']);
        this.getContext = options.getContext || (() => null);

        this.enabled = false;
        /** deviceId -> {label, groupId} */
        this.outputs = new Map();
        this.timer = null;
        this._handler = () => this._scheduleCheck();
        this.supported = Boolean(
            navigator.mediaDevices && navigator.mediaDevices.enumerateDevices
        );
    }

    async start() {
        if (!this.supported || this.enabled) return this.supported;

        this.enabled = true;
        await this._snapshot();
        if (!this.enabled) return false;
        navigator.mediaDevices.addEventListener('devicechange', this._handler);
        this.bindContext();
        return true;
    }

    bindContext() {
        if (!this.enabled) return;
        const context = this.getContext();
        if (context === this.context) return;
        this.context?.removeEventListener('sinkchange', this._handler);
        this.context = context;
        this.context?.addEventListener('sinkchange', this._handler);
    }

    stop() {
        if (!this.enabled) return;
        this.enabled = false;
        clearTimeout(this.timer);
        this.context?.removeEventListener('sinkchange', this._handler);
        if (this.supported) {
            navigator.mediaDevices.removeEventListener('devicechange', this._handler);
        }
    }

    async _snapshot() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            this.outputs = new Map(
                devices
                    .filter((device) => device.kind === 'audiooutput')
                    // Keep the default alias group so a default-output switch is observable.
                    .filter((device) => device.deviceId && device.deviceId !== 'communications')
                    .map((device) => [device.deviceId, {label: device.label || '', groupId: device.groupId || ''}])
            );
        } catch (error) {
            console.warn('[devices] Could not enumerate audio outputs:', error);
        }
    }

    /**
     * A single unplug can emit several devicechange events in quick succession.
     * Debounce so we evaluate the settled state once.
     */
    _scheduleCheck() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this._check(), DEBOUNCE_MS);
    }

    async _check() {
        if (!this.enabled) return;

        const previous = this.outputs;
        await this._snapshot();
        if (!this.enabled) return;
        const current = this.outputs;

        // Rule 1: only removals matter.
        const removed = [...previous.entries()].filter(([id, item]) => !current.has(id) ||
            (item.groupId && current.get(id).groupId && item.groupId !== current.get(id).groupId));
        if (removed.length === 0) return;

        // Nothing playing means nothing to pause.
        if (!this.isPlaying()) return;

        // Compare the selected outputs and their physical aliases before using labels.
        const active = this.activeOutputs();
        const activeGroups = active.map((id) => previous.get(id)?.groupId).filter(Boolean);
        const selectedRemoved = removed.some(([id, item]) => active.includes(id) ||
            (item.groupId && activeGroups.includes(item.groupId)));
        const unidentifiedDefault = active.includes('default') && !activeGroups.length;
        const headphoneRemoved = removed.some(([, item]) => looksLikeHeadphones(item.label));
        const noLabels = [...previous.values()].every((item) => !item.label);
        if (!selectedRemoved && !(unidentifiedDefault && (headphoneRemoved || noLabels))) return;

        try {
            this.onDisconnect();
        } catch (error) {
            console.error('[devices] Disconnect handler threw:', error);
        }
    }
}

window.RhythmDevices = {OutputDeviceWatcher, looksLikeHeadphones, HEADPHONE_HINTS};
