'use strict';

const fs = require('fs');

/** Debounced root notifications. A periodic fallback covers platforms without recursive fs.watch. */
class RootWatcher {
    constructor(onChange, {debounceMs = 1200, fallbackMs = 60000} = {}) {
        this.onChange = onChange;
        this.debounceMs = debounceMs;
        this.fallbackMs = fallbackMs;
        this.entries = new Map();
    }

    add(root) {
        if (!root || this.entries.has(root.id)) return;
        const entry = {root, watcher: null, interval: null, timer: null, busy: false, pending: false};
        const schedule = () => {
            if (entry.timer) clearTimeout(entry.timer);
            entry.timer = setTimeout(() => this._run(entry), this.debounceMs);
        };
        try {
            entry.watcher = fs.watch(root.path, {recursive: true}, schedule);
            entry.watcher.on('error', (error) => {
                console.warn(`[library] Watch failed for ${root.path}: ${error.message}`);
                entry.watcher?.close();
                entry.watcher = null;
                if (!entry.interval) entry.interval = setInterval(schedule, this.fallbackMs);
            });
        } catch (error) {
            console.warn(`[library] Using periodic scan for ${root.path}: ${error.message}`);
            entry.interval = setInterval(schedule, this.fallbackMs);
        }
        this.entries.set(root.id, entry);
    }

    async _run(entry) {
        if (this.entries.get(entry.root.id) !== entry) return;
        entry.timer = null;
        if (entry.busy) { entry.pending = true; return; }
        entry.busy = true;
        try { await this.onChange(entry.root); }
        catch (error) { console.warn(`[library] Watched rescan failed: ${error.message}`); }
        finally {
            entry.busy = false;
            if (entry.pending) {
                entry.pending = false;
                entry.timer = setTimeout(() => this._run(entry), this.debounceMs);
            }
        }
    }

    remove(id) {
        const entry = this.entries.get(id);
        if (!entry) return;
        this.entries.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.interval) clearInterval(entry.interval);
        entry.watcher?.close();
    }

    close() { for (const id of this.entries.keys()) this.remove(id); }
}

module.exports = {RootWatcher};
