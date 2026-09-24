'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const connections = [];
const node = (name) => ({name, connect(target) { connections.push([name, target.name]); }, disconnect() {}});
const parameter = {value: 0, cancelScheduledValues() {}, setValueAtTime(value) { this.value = value; },
    linearRampToValueAtTime(value) { this.value = value; }};
const devices = [
    {kind: 'audiooutput', deviceId: 'default', groupId: 'speaker'},
    {kind: 'audiooutput', deviceId: 'speakers', groupId: 'speaker'},
    {kind: 'audiooutput', deviceId: 'buds-a', groupId: 'a'},
    {kind: 'audiooutput', deviceId: 'buds-b', groupId: 'b'},
];
class FakeAudio {
    async setSinkId(id) { this.sinkId = id; }
    async play() { this.playing = true; }
    pause() { this.playing = false; }
}
const context = {
    window: {}, Audio: FakeAudio, URL, console, Float32Array,
    navigator: {mediaDevices: {enumerateDevices: async () => devices}},
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/js/audio/engine.js'), 'utf8'), context);
const audio = context.window.RhythmAudio.engine;
audio._ensureGraph = () => {
    audio.ctx = {currentTime: 0, createDelay: () => ({...node('delay'), delayTime: {...parameter}}),
        createMediaStreamDestination: () => ({...node('stream'), stream: {getTracks: () => [{stop() {}}]}})};
    audio.gain = node('master');
};

(async () => {
    assert.equal((await audio.addOutput('speakers')).ok, false,
        'system default must not be mirrored to the same physical speakers');
    assert.equal((await audio.addOutput('buds-a', {delayMs: 120})).ok, true);
    assert.equal((await audio.addOutput('buds-b', {delayMs: 250})).ok, true);
    assert.equal(audio.listOutputs().length, 2);
    assert.equal(connections.filter(([source, target]) => source === 'master' && target === 'delay').length, 2,
        'both devices receive the same master graph');
    audio.setOutputDelay('buds-a', 180);
    assert.equal(audio.listOutputs().find((output) => output.deviceId === 'buds-a').delayMs, 180);
    audio.removeOutput('buds-b');
    assert.equal(audio.listOutputs().length, 1);
    console.log('PASS: multiple outputs share the master and exclude default-device duplication');
})().catch((error) => { console.error(error); process.exitCode = 1; });
