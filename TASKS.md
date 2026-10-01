# Rhythm Dock — prioritized task checklist

Updated **2026-10-02** after the source audit and local implementation/test pass. This is the single backlog for the original requests, follow-ups, and unfinished roadmap phases.

**Checkbox meaning:** `[x]` = implemented, or a requested investigation has a recorded decision; `[ ]` = work remains. Acceptance tasks are separate so a working feature can be checked without pretending it was deployed or heard on every device. API/server credentials and live acceptance are deliberately left for later, as requested. Phase 9 lyrics already existed; this pass completes the local Phase 1–8 work and the feasible follow-ups promoted before it.

## P0 — shared listening and data safety

- [x] Host-authoritative shared queue; authorized guests add at top/next/end, remove, reorder, and see the same queue. Persistent library catalog uses opaque IDs rather than exposing host paths. Exact local queue order is saved and restored, including shuffle order and an empty queue. Fixed first-song insertion into an empty queue.
- [x] Both friends contribute local audio. Authorized uploads are capped at 30 MB, retrieved only by the host, imported into stable app data, and acknowledged. Repeated retrieval can reuse an identical imported file; changing rooms during import cannot add it to the new room.
- [x] Desktop room reconnect, fresh welcome snapshots, host queue/settings/lyrics republishing, old-socket isolation, failed-login rejection, and connection timeout. An actual loopback server with a host and two desktop clients passes catalog, audio-byte relay, queue fan-out, and host/guest reconnect checks.
- [x] Telegram private-chat pairing, supported attachments, HTTPS audio/playlist links, top/next/end placement, duplicate update suppression, and optional persisted polling offset. Mocked Bot API tests pass. Pairing code possession authorizes the private chat; `/unpair` revokes it. Pairings must be recreated after a server restart.
- [x] Stable data paths, additive schema migrations through v12, pre-migration backups, library export/merge restore, and paused session restoration. Fixed startup ordering so a newly created settings file cannot block legacy settings migration. Tests preserve lyrics, playlists, ratings, book positions, discovery preferences, and measured loudness.
- [x] Bounded local diagnostics with predefined fields, export action, and one automatic renderer-crash recovery. Queue restores paused. URLs, file paths, and credential fields are excluded from diagnostic records; nothing is uploaded automatically.
- [x] Repeatable local tests for critical database, renderer, media, room, Telegram, cache, and output paths.

### Deferred setup and real-world acceptance — highest priority when access is ready

- [ ] Configure room server domain, HTTPS/WSS, `CREATE_SECRET`, and room password; verify two friends on separate networks hear the same queue and can both add songs. Loopback protocol/byte tests are complete; internet synchronization and human listening are not.
- [ ] Configure `TELEGRAM_BOT_TOKEN` and writable `TELEGRAM_STATE_FILE`; test actual pairing, attachments, links, reconnect, and restarts. Docker Compose now supplies a dedicated offset volume. A crash between delivery and saving the offset can repeat the last update; this is not an exactly-once delivery guarantee.
- [ ] Accept a real old-to-new Windows installer upgrade with settings/library/lyrics and backup restore. Automated legacy import/reopen is complete. Keep auto-update blocked until this installer check passes.
- [ ] Listen through speakers plus headphones/earbuds, align delays, then add more outputs if available. A phone counts as a room listener unless Windows exposes it as an audio output. The 2026-09-24 two-output smoke pass remains recorded; the latest run exposed only Realtek speakers and skipped the real extra-output route.
- [ ] Check earbud disconnect on hardware. Removing an earbud from the ear while it stays connected requires device-specific wear detection; the implemented watcher reacts to output disappearance/default changes, not physical wear sensors.
- [ ] Accept vertical/docked layouts, hover/drag, monitor removal, A–B colors, Windows thumbnail/tray/file icons, lyric wrapping/fast skips, timer notification, and startup sound by using the packaged app. Automated geometry, control lock, transport and replay checks pass.
- [ ] Accept speed/pitch sound quality, audible gapless/crossfade boundaries, measured loudness, and Bluetooth latency by listening. HTML media prebuffer reuse is tested; sample-exact native output is not claimed.

## Completed local work before Phase 9

### Phases 1–6 — foundations and original 26 requests

- [x] #1 Distinct MP3/filetype icons, deterministic icon generation, Windows/macOS/Linux packaging definitions and build workflows. Cross-platform installer execution remains acceptance work.
- [x] #2 Tag-first artist/title inference plus filename, folder and sibling evidence.
- [x] #3 Pause when an active/default/extra output disconnects; ignore removal of an unused device. Device watcher tests include default alias changes.
- [x] #4 Theme-aware Windows thumbnail icons and current-color in-app SVG buttons. A new logo/name or alternative icon set remains a Phase 10 design task.
- [x] #5 Tray minimize/restore, configurable global shortcuts, and failure reporting for shortcuts owned by another app.
- [x] #6 Async track/lyric guards discard results from skipped tracks.
- [x] #7 Keep the database/settings on updates; tested legacy import, schema migration, backup and reopen.
- [x] #8 Recursive subfolder scanning and artist/library search.
- [x] #9–10 Active lyric font fitting and separate lyric/control layout.
- [x] #11/#21 End state returns transport to play; replay rewinds; lyrics reset. Real renderer audio-fixture tests pass.
- [x] #12 Readable vertical player (220px), wider vertical Playlist/Settings panels (340px), layout restoration and wall anchoring.
- [x] #13 File actions: reveal/open file/folder; copy filename, title/artist, absolute file path and folder path; delete to trash; persistent folder exclusion; playlist show/hide and named-list management. “File Path” is already the full absolute path.
- [x] #14 Player/Playlist/Settings tabs with three bottom dots; tags remain a separate file action returning to the previous tab.
- [x] #15 Persian/English/French/Arabic translation selection, button, cache and RTL presentation. Live provider acceptance remains deferred.
- [x] #16 Artist search and play-all; #17 liked-song queue.
- [x] #18 Streaming local-file startup. A sparse 159 MB, one-hour WAV became ready in 21–42 ms in the latest Electron test. A forced 10% threshold would delay local start. Remote imports currently complete their bounded download before queueing; progressive remote start remains Phase 14.
- [x] #19/#23 Speed control and pitch-preservation setting (duplicate request consolidated).
- [x] #20 Full-window file drop; drops are ignored while controls are locked.
- [x] #22 Gain ramp on start and paused startup/session restore; rapid pause/resume cannot be stopped by a stale pause timer.
- [x] #24 Theme-aware progress track and padded wheel/middle-click seeking.
- [x] #25 Equalizer, presets and saved settings; #26 countdown stop/fade and work reminder.
- [x] Shared rooms, browser/desktop membership, clock projection, drift correction, listener permissions, host controls, byte-range relay and deployment templates. Live server acceptance is listed in P0 above.

### Phase 7 — persistent library

- [x] SQLite tracks/roots/missing flags/play and skip counts/recent and added views; JSON backup/merge restore.
- [x] Incremental mtime/size fingerprints; unchanged files avoid tag parsing.
- [x] Background worker scanning with progress/cancel; incomplete scans preserve prior missing flags.
- [x] Root watching with debouncing and fallback rescan.
- [x] Bounded embedded-art thumbnail cache.
- [x] Persistent 0–5 ratings independent of likes, included in backup and recommendations. Optional tag-writing is deferred to Phase 12.

### Phase 8 — audio depth

- [x] Playback speed with Chromium pitch preservation; prebuffered two-deck handoff and configurable crossfade. Fixed crossfade queue advancement reloading the incoming song and retiring the fading deck too early. Buffered paused loads now have a usable paused state.
- [x] Track/album ReplayGain tags and missing-tag loudness analysis. Optional FFmpeg scans a song, queue or indexed album, stores EBU R128 loudness/true peak, and applies bounded gain with peak protection. Changes to any analysed album file invalidate its album gain.
- [x] Primary output selection plus simultaneous extra outputs; common master graph, separate delays including **main-output delay**, duplicate physical/default alias prevention, failed-route cleanup and retry.
- [x] A–B repeat, skip silence, balance/mono/channel swap and equalizer paths.
- [x] CUE and M4B chapter navigation and per-book resume/backup. Added bounded Nero `chpl` parsing for real FFmpeg-produced M4B files.
- [x] Queue chapter/CUE sections as separately playable tagged FLAC tracks with optional FFmpeg; originals stay untouched. Real generated chapter/section fixtures pass.
- [x] Wider-format scope and decoder path: optional FFmpeg prepares APE, WavPack, DSF/DFF and MOD/XM/IT/S3M into a bounded two-day FLAC cache. Real WavPack decoding and app IPC playback preparation pass. Availability of the other decoders depends on the chosen FFmpeg build.
- [x] Exclusive/bit-perfect and MIDI feasibility decision recorded: these require a separate native output backend and soundfont/synth configuration respectively. Their actual implementation is explicitly queued in Phase 15 below, rather than promised by the WebAudio graph.

### Follow-ups promoted before Phase 9

- [x] Wall-docked mini mode, vertical scrolling title, hover expansion, vertical movement, left/right switching and Ctrl+Alt+D; no middle-screen resting position. Expanded panels remain wall anchored.
- [x] Real light/dark switch with switch role and accessible state.
- [x] Multiple local outputs with main/extra delay alignment controls (priority request #3).
- [x] Add at top / after current / end from library and shared-room controls.
- [x] Lock button and Ctrl+L; only unlock remains interactive, including in the wall strip.
- [x] Offline song/album recommendations from artist/genre/likes/ratings/plays/skips; opt-in next-song radio, manual mood labels/filters, learned “More/Less like this” feedback, explanation and reset. Feedback survives rescans, restart and backup.
- [x] Public HTTPS audio and M3U/M3U8/PLS/XSPF playlists, partial-failure reporting, preserved insertion order, cache reuse, two-day expiry, 100 MB/file and 512 MB/cache caps, explicit save. HLS and provider pages are not treated as audio files.
- [x] Permanent “Show Lyrics Controls” action in Settings, in addition to the lyrics menu.
- [x] Theme-colored A–B selection plus export to a new WAV/FLAC/MP3/M4A/OGG file; full-track conversion and chapter splitting. Optional FFmpeg executable picker/check, progress and cancellation; existing files/originals are preserved.
- [x] “Added” library view and named playlist create/add/remove/play/import/export/delete.

## Validation evidence — latest local pass

- `npm test`: geometry, caches/playlists, worker/watcher, chapters, output routing/device watcher, media-tool safety, actual loopback desktop rooms, v1→v12 migration/reopen, mocked Telegram restart/link tests, and **48 server checks passed**.
- `npm run test:ui-smoke` with optional `FFMPEG_TEST_BINARY`: actual Electron startup settings migration, theme switch, click lock/unlock, queue insertion/reorder/remove/persistence, wall/vertical panel geometry, end replay, rapid pause/resume, rate/pitch properties, primary delay, A–B looping, prebuffer reuse, crossfade without reload, large-file startup, WavPack preparation, CUE section queueing, actual guest upload into an empty desktop queue, byte-identical audio relay and renderer-crash paused recovery passed. Latest physical extra-output route skipped because only one real device was connected. Fixture lyrics providers are offline.
- `npm run test:media-integration` with FFmpeg: real loudness/album measurement, accurate 1.5-second A–B FLAC export, original preservation, tagged CUE section, embedded M4B chapters and WavPack decode passed.
- See `docs/AUDIO-TOOLS.md` for optional FFmpeg setup, reproducible tests and limits. No bot/server credentials were added, no deployment was performed, and no bundled FFmpeg binary was committed.

## Later roadmap — implementation still required

### Phase 9 — lyrics

- [x] Existing v1.6 lyrics editor/tap sync, sidecar/embed/providers, karaoke timing, full screen/desktop overlay, typography, per-track offset and translation cache. Keep its API and installed-app regression checks in P0 acceptance.

### Phase 10 — interface

- [ ] Waveform seek bar with cached peaks, Now Playing full screen and visualizer.
- [ ] Album-art accent, custom themes/user CSS and command palette.
- [ ] Virtualized lists and drag-to-reorder queue; large catalog paging/search beyond current whole-catalog snapshots.
- [ ] First-run folder onboarding and saved layout presets.
- [ ] Better icon/logo/name options and human selection; retain the stable app data directory.

### Phase 11 — library management

- [x] Named playlists and M3U/PLS/XSPF round trips; recent/added views; explicit queue insertion and exact session order.
- [ ] Rule-based smart playlists; album/artist art grids and folder-tree browsing.
- [ ] Multi-select/bulk actions, sorting/filtering, chronological history and duplicate review.
- [ ] Optional durable server room identity/persistence and room-history policy. Current rooms/pending uploads are temporary; a server restart requires a new room. The desktop saved queue survives.

### Phase 12 — tags and files

- [x] Audio converter, A–B trim/export and chapter/CUE splitting were promoted before Phase 9. FFmpeg is optional, not bundled.
- [ ] Batch tag editing, filename/tag patterns with preview, undoable dry-run file organization and optional rating-tag sync.
- [ ] MusicBrainz/AcoustID lookup, missing-cover fetch and tag presets.
- [ ] Advanced editor (arbitrary multi-cut timeline, fades/effects, undo); current editing is A–B selection and chapter split.

### Phase 13 — desktop integration

- [x] Windows thumbnail toolbar and single-instance/open-file paths.
- [ ] Linux MPRIS/macOS Now Playing, launch-at-login, richer CLI options and explicit portable data mode.
- [ ] Auto-update only after the P0 installer data-safety gate; track notifications and Wayland checks.

### Phase 14 — connected features

- [x] Offline recommendations, shared queues and direct audio/playlist intake were promoted before Phase 9.
- [ ] Online recommendation enrichment/provider adapters (accounts, matching and fallback); credentials alone do not implement this.
- [ ] YouTube playlist discovery/visible player and Spotify OAuth/authorized player/local-library matching. These still need implementation and provider setup; their audio is not handled by the local cache/output graph. See provider planning in `docs/ROADMAP.md`.
- [ ] Progressive remote-file playback, radio streams and HLS, podcasts, LAN remote control and one chosen casting route.
- [ ] Last.fm/ListenBrainz scrobbling with offline submission queue and Discord presence.

### Phase 15 — musician/native tools

- [ ] Native exclusive/bit-perfect output backend with device format negotiation; separate bypass path for effects and multi-output mixing.
- [ ] MIDI rendering with chosen synthesizer, soundfont picker/licensing, and sample cache. MIDI is not claimed as a supported input yet.
- [ ] Practice mode/count-in, pitch/key shift, BPM/key detection and metronome.
- [ ] Spectrogram, named bookmarks/cue points and parametric EQ/AutoEQ.
- [x] A–B audio export promoted to the pre-9 work; plugin/script API remains a future scoped decision.

### Phase 16 — quality and accessibility

- [x] Bounded local logs, crash recovery and automated critical-path suite promoted before Phase 9.
- [ ] Opt-in crash reporting, screen-reader/keyboard audit, interface i18n/RTL, settings import/export, large-library CPU/memory budgets and maintained documentation site.
