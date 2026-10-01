# Audio tools and pre-Phase-9 verification

Updated 2026-10-02. Implementation and acceptance status live in [TASKS.md](../TASKS.md).

## Optional FFmpeg setup

Ordinary playback does not require FFmpeg. Loudness scanning, conversion, selection
export, chapter splitting and uncommon-format preparation do.

1. Install an FFmpeg build with the decoders/encoders you need, or use an existing
   executable. The app does not download or bundle a binary.
2. In **Settings → Audio tools**, choose that executable and press **Check FFmpeg**.
   If FFmpeg is on PATH, the default also works.
3. Load a song. Analyse its loudness, analyse its indexed album, or analyse the queue.
   Album analysis requires matching album/artist tags and 2–64 indexed local tracks.
4. Enable ReplayGain in audio settings and choose track or album mode. Existing tags
   take priority; stored measurements supply the missing gain.
5. Choose WAV, FLAC, MP3, M4A or OGG for conversion. To trim, set A and B in the player,
   preview the loop, then export the selection. Choose a new filename; the original
   and existing output files are preserved. Progress and Cancel are available.
6. With a CUE sidecar or chaptered M4B, **Queue Chapters** creates independently
   playable tagged FLAC sections in temporary app data.

Analysis uses FFmpeg's [loudnorm filter](https://ffmpeg.org/ffmpeg-filters.html#loudnorm)
for integrated loudness and true peak. The app targets −18 LUFS with a −1 dB true-peak
ceiling and limits gain to −24…+12 dB. Album analysis measures the concatenated album
and stores one shared gain to retain relative track dynamics. Measurements are
invalidated when file size or modification time changes; changing any album member
invalidates its album gain. Analysis does not rewrite tags or audio.

Extra formats APE/WavPack/DSF/DFF/MOD/XM/IT/S3M are prepared as 48 kHz FLAC, depending
on the selected FFmpeg build. This is conversion into the WebAudio path, not native
DSD/bit-perfect output. MIDI requires a synthesizer/soundfont and remains Phase 15.
Real WavPack is covered by fixtures; every uncommon decoder is not independently
certified by this test set.

Media operations run one at a time, are cancellable, have a 30-minute timeout and a
1 GB output cap. Decoder/chapter caches are bounded to 2 GB each and expire after two
days. Unsaved remote audio uses a separate 512 MB cache, 100 MB/file limit and two-day
expiry. Exported/saved files are outside those temporary caches.

## Multiple outputs

Select a main output and add extra outputs in Settings. Every route shares the same
master mix. Delay controls exist for the main route and each extra route, from 0 to
2000 ms. Delay faster speakers/wired outputs to meet the slowest Bluetooth route;
the app does not automatically measure acoustic latency. Physical aliases are
excluded when the OS supplies device group identity. OS/device clock drift and
Bluetooth limits still need listening acceptance.

A phone can join a shared room in its browser. It becomes a local output only when
the operating system exposes it as a playback endpoint. Output-disconnect pause
does not detect an earbud being removed from the ear while it remains connected.

## Reproduce local tests

From the repository root in Windows PowerShell:

```powershell
Set-Location '.\Rhythm Dock'
npm test
npm run test:ui-smoke
```

For real FFmpeg fixture tests, set the absolute path to your executable:

```powershell
$env:FFMPEG_TEST_BINARY = 'C:\Tools\ffmpeg\bin\ffmpeg.exe'
npm run test:media-integration
npm run test:ui-smoke
```

On Linux/macOS from the application directory:

```sh
npm test
npm run test:ui-smoke
FFMPEG_TEST_BINARY=/absolute/path/to/ffmpeg npm run test:media-integration
FFMPEG_TEST_BINARY=/absolute/path/to/ffmpeg npm run test:ui-smoke
```

Electron needs a graphical session; these commands do not promise a headless or
WSL audio/device test. Tests use isolated temporary app data. The renderer smoke
test includes a deliberate renderer crash and verifies paused recovery. It skips
physical extra-output playback if a second distinct device is absent. FFmpeg app
tests are enabled only when `FFMPEG_TEST_BINARY` is supplied; the separate media
integration command requires it or FFmpeg on PATH. No Telegram credentials or remote
server are required for the mocked and loopback tests.

The latest Windows pass loaded a sparse 159 MB, one-hour WAV in 21–42 ms, verified actual
prebuffer reuse/crossfade handoff, and preserved migrated data through schema v12.
This is engineering evidence, not a listening or packaged-installer certification.

## Deferred access and implementation

| Item | Later action |
|---|---|
| Room server | Set HTTPS/WSS URL, creation secret and password; test separate networks |
| Telegram | Set server-only bot token and writable offset file; test real messages |
| Translation/lyrics providers | Configure optional provider credentials/endpoints and verify live responses |
| YouTube/Spotify | Provider adapters and authorized playback still need implementation; credentials alone are insufficient |
| Native exclusive output/MIDI | New output backend or synthesizer and soundfont settings, tracked in Phase 15 |

Local diagnostics export predefined event fields only and rotate at approximately
256 KB with one previous file. They are local; no automatic upload is enabled.
