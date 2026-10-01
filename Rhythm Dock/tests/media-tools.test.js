'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {EventEmitter} = require('node:events');
const tools = require('../src/main/services/media-tools');
const {Diagnostics} = require('../src/main/services/diagnostics');

(async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rhythm-media-test-'));
    try {
        const source = path.join(scratch, 'an album & song.wav');
        fs.writeFileSync(source, 'original audio');
        const invocations = [];
        const fakeSpawn = (executable, args, options) => {
            invocations.push({executable, args, options});
            const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
            child.kill = () => child.emit('close', 1);
            setImmediate(() => {
                if (args.at(-1) !== '-') fs.writeFileSync(args.at(-1), 'converted audio');
                child.stdout.emit('data', Buffer.from('out_time_us=1500000\n'));
                child.stderr.emit('data', Buffer.from('{"input_i":"-28", "input_tp":"-12"}'));
                child.emit('close', 0);
            });
            return child;
        };
        const measurement = await tools.analyse(source, {spawnImpl: fakeSpawn});
        assert.equal(measurement.gainDb, 10);
        assert.equal(tools.loudnessResult('{"input_i":"-28","input_tp":"-3"}').gainDb, 2,
            'true peak must constrain a boost');
        assert.throws(() => tools.loudnessResult('{"input_i":"-inf","input_tp":"-inf"}'), /silent/);
        const target = path.join(scratch, 'selection.flac');
        await tools.convert(source, target, {start: 1, end: 2.5, spawnImpl: fakeSpawn});
        const command = invocations.at(-1);
        assert.equal(command.options.shell, false, 'filenames must never execute as shell text');
        assert.equal(command.args[command.args.indexOf('-t') + 1], '1.5');
        assert.equal(fs.readFileSync(source, 'utf8'), 'original audio');
        assert.equal(fs.readFileSync(target, 'utf8'), 'converted audio');
        await assert.rejects(tools.convert(source, source, {spawnImpl: fakeSpawn}), /new filename/);
        await assert.rejects(tools.convert(source, path.join(scratch, 'bad.flac'), {start: 2, end: 1}), /end/);
        assert.equal(fs.readdirSync(scratch).some((name) => name.endsWith('.part')), false);
        const abort = new AbortController();
        const cancelled = tools.run('ffmpeg', [], {signal: abort.signal, spawnImpl: () => {
            const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
            child.kill = () => child.emit('close', 1); return child;
        }});
        abort.abort(); await assert.rejects(cancelled, /cancelled/);
        const missing = tools.run('missing', [], {spawnImpl: () => {
            const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
            setImmediate(() => child.emit('error', Object.assign(new Error('missing'), {code: 'ENOENT'})));
            return child;
        }});
        await assert.rejects(missing, /Choose its executable/);
        const diagnostics = new Diagnostics(path.join(scratch, 'logs'));
        diagnostics.record('room:error', {code: 401, token: 'SECRET', reason: 'https://host/?password=SECRET', filePath: source});
        assert.ok(diagnostics.text().includes('401'));
        assert.ok(!diagnostics.text().includes('SECRET') && !diagnostics.text().includes(source));
        console.log('PASS: loudness peak protection, safe export, cancellation, missing tools and private diagnostics');
    } finally { fs.rmSync(scratch, {recursive: true, force: true}); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
