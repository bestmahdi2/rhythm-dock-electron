# Rhythm Dock — prioritized task checklist

Updated **2026-10-02** after the source audit and local implementation/test pass. This is the single backlog for the original requests, follow-ups, and unfinished roadmap phases.

**Checkbox meaning:** `[x]` = implemented within the stated scope, or a requested investigation has a recorded decision; `[ ]` = work remains. Acceptance tasks are separate so a working feature can be checked without pretending it was deployed or heard on every device. API/server credentials and live acceptance are deliberately left for later, as requested. This pass covers Phase 9 and feasible work through Phase 16. Open implementation tasks explicitly say what still needs code. See [later-phase setup and limits](docs/LATER-PHASES.md).

## P0 — shared listening and data safety

- [x] Host-authoritative shared queue; authorized guests add at top/next/end, remove, reorder, and see the same queue. Persistent library catalog uses opaque IDs rather than exposing host paths. Exact local queue order is saved and restored, including shuffle order and an empty queue. Fixed first-song insertion into an empty queue.
- [x] Both friends contribute local audio. Authorized uploads are capped at 30 MB, retrieved only by the host, imported into stable app data, and acknowledged. Repeated retrieval can reuse an identical imported file; changing rooms during import cannot add it to the new room.
- [x] Desktop room reconnect, fresh welcome snapshots, host queue/settings/lyrics republishing, old-socket isolation, failed-login rejection, and connection timeout. An actual loopback server with a host and two desktop clients passes catalog, audio-byte relay, queue fan-out, and host/guest reconnect checks.
- [x] Telegram private-chat pairing, supported attachments, HTTPS audio/playlist links, top/next/end placement, duplicate update suppression, and optional persisted polling offset. Mocked Bot API tests pass. Pairing code possession authorizes the private chat; `/unpair` revokes it. Pairings must be recreated after a server restart.
- [x] Stable data paths, additive schema migrations through v13, pre-migration backups, library export/merge restore, and paused session restoration. Fixed startup ordering so a newly created settings file cannot block legacy settings migration. Tests preserve lyrics, playlists, ratings, book positions, discovery preferences, measured loudness, smart playlists, history and bookmarks.
- [x] Bounded local diagnostics with predefined fields, export action, and one automatic renderer-crash recovery. Queue restores paused. URLs, file paths, and credential fields are excluded from diagnostic records. Crash uploading is disabled by default and requires explicit opt-in plus an endpoint.
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

- `npm test` passed: parser, appearance/settings validation, filename patterns, preview/apply/undo and interrupted-copy recovery, signed provider requests, actual optional Discord IPC framing/privacy, geometry/cache/scan/output tests, actual loopback desktop rooms, actual server-process restart and fresh host reclaim, v1→v13 migration/reopen, mocked provider retry/Telegram tests, persistence/privacy/expiry checks, and **48 existing server checks**.
- Database fixture: 20,000 songs, bounded paged search **19–20 ms** on the latest Windows runs; heap growth capped by the test. This is a query budget, not a whole-app CPU benchmark.
- `npm run test:ui-smoke` passed with optional `FFMPEG_TEST_BINARY`: prior critical paths plus first-run onboarding, enhanced-LRC editor round trip, 10,000-song library/queue with **40 DOM rows**, actual queue drag/drop handlers, command palette, custom appearance rejection, parametric EQ insertion/bypass, full-screen Now Playing/Escape, podcast position persistence, paused batch launch and direct radio fixture through the real engine. Organizer IPC preserves library roots/bookmarks/live queue and restores original bytes. Waveform generation/cache, server health, opt-in crash delivery/privacy and encrypted saved-host/Leave checks pass. Physical extra-output routing was skipped because only one real device was connected.
- `npm run test:media-integration` passed with FFmpeg: actual FLAC metadata/embedded Persian lyrics, byte-exact tag undo, streaming 512-bin waveform, multi-cut/fade/+12-semitone export with preserved duration/originals, loudness, CUE, M4B and WavPack fixtures.
- Tests use isolated app data, temporary media and loopback servers. Live service credentials, deployment, packaged-platform/hardware acceptance and human listening remain open. See `docs/AUDIO-TOOLS.md` and `docs/LATER-PHASES.md` for reproducible commands and optional tools.

## Phase 9 onward — implemented code and remaining work

### Phase 9 — lyrics

- [x] Existing v1.6 lyrics editor/tap sync, sidecar/embed/providers, karaoke timing, full screen/desktop overlay, typography, per-track offset and translation cache. Keep its API and installed-app regression checks in P0 acceptance.
- [x] Repeated enhanced-LRC chorus lines shift word timestamps correctly; offsets and untimed lines survive the real editor round trip.
- [x] Tag writes keep the audio extension in their temporary filename, fixing embedded lyric/tag saves; real FLAC and Persian lyric fixtures pass.
- [x] Provider fallback after failure, bounded 2 MB lyric/translation responses, unique per-path application-data sidecars and legacy mirror fallback; offline provider and translation-cache regression checks.
- [ ] Accept actual configured lyrics/translation APIs and overlay typography with real songs; code and offline fixtures are ready.

### Phase 10 — interface

- [x] Optional FFmpeg waveform generation into 512 cached peaks; click/keyboard seek with a slider label and file-change invalidation.
- [x] Now Playing full screen with artwork, live lyric, transport and Escape restoration; spectrum/scope/VU visualizers, disabled by default and paused when hidden.
- [x] Dominant album-art accent; editable five-color theme JSON and restricted user CSS without remote imports/resources.
- [x] Searchable Ctrl/Cmd+K command palette.
- [x] SQLite catalog paging/search/sort, 40-row library/large-queue windows and queue drag-to-reorder preserving current playback.
- [x] Empty-library folder/server onboarding, server health check and saved named window layout presets.
- [ ] Better icon/logo/name options and human selection; retain the stable app data directory.
- [ ] Human visual acceptance of later tools at compact sizes, reduced motion, light/dark themes and multiple monitors.

### Phase 11 — library management

- [x] Named playlists and M3U/PLS/XSPF round trips; recent/added views; explicit queue insertion and exact session order.
- [x] Named playlist duplicate and validated exact reorder; queue remains separate from saved playlists.
- [x] Persistent AND-rule smart playlists: artist/album/genre, minimum rating, unplayed days and duration limit; backup/merge restore.
- [x] Artist/album artwork grids (40 groups per page, 2,000 groups maximum), lazy folder-tree browsing and folder filtering.
- [x] Checkbox/visible-range Shift selection, play/queue/batch-tag actions, sorting and filter-as-you-type.
- [x] Chronological play/skip history capped at 10,000 records (latest 200 shown), and tag/duration duplicate candidates for manual review.
- [x] Optional durable room identity/queue/settings snapshots, paused restore, hashed host credentials, bounded seven-day default retention and unhealthy-storage reporting.
- [x] Encrypted desktop host credential and explicit Resume hosted room action; fresh-client host reclaim tested. Explicit Leave forgets the credential. Requires OS secure storage and optional server persistence.
- [ ] Configure `ROOM_STATE_FILE`/retention and accept real server/desktop restart together. Pending uploads and Telegram pairing remain temporary; pair again after server restart.
- [ ] Audio-fingerprint duplicate matching and a full catalog/grid performance acceptance budget; current duplicates are candidates, not audio identity proof.

### Phase 12 — tags and files

- [x] Audio converter, A–B trim/export and chapter/CUE splitting were promoted before Phase 9. FFmpeg is optional, not bundled.
- [x] Shared batch tags and filename→tag patterns; mandatory preview, preserved-byte backups and hash-guarded undo.
- [x] Tag→filename/folder organization with collision checks, copy verification, interrupted-copy rollback and library/root/queue path updates. Audio files only; companion LRC/CUE files stay in place.
- [x] User-reviewed MusicBrainz recording/release matching, AcoustID/fpcalc adapter, Cover Art Archive fetch/embed and named tag presets.
- [x] Multi-cut editor: add/reorder/remove sections, gain/fades, 50-step session undo, selected-section loop preview, optional FFmpeg export/cancel preserving originals.
- [ ] Configure AcoustID key/fpcalc and accept live metadata/cover lookup. Optional tool/API adapters exist; actual fpcalc execution/live results are not yet accepted.
- [ ] Optional rating/ReplayGain tag sync, companion-file organization, persisted editor projects and broader interactive effects/live pitch preview still need code.

### Phase 13 — desktop integration

- [x] Windows thumbnail toolbar and single-instance/open-file paths.
- [x] Multiple launch files, `--play`, `--enqueue`, `--hidden`, second-instance queueing and batched macOS open-file handling; actual paused batch IPC tested.
- [x] Installed Windows/macOS launch-at-login preference and packaged-only portable marker/data directory logic.
- [x] Opt-in silent track notifications with artwork/click-to-restore, macOS notification transport actions and Touch Bar transport code.
- [ ] Native Linux MPRIS and macOS Now Playing/Control Centre integrations still need code.
- [ ] Linux desktop-entry autostart still needs code; unsupported login setting is disabled there.
- [ ] Auto-update still needs implementation after the P0 installer data-safety gate.
- [ ] Accept installed startup/portable/file association/notification behavior on Windows and macOS; macOS Touch Bar and Wayland positioning need real-platform testing.

### Phase 14 — connected features

- [x] Offline recommendations, shared queues and direct audio/playlist intake were promoted before Phase 9.
- [x] Encrypted account configuration with explicit enable/disconnect; Last.fm browser authorization/session signing and ListenBrainz token adapter.
- [x] Persistent scrobble outbox: qualified listens, original start timestamps, disabled-by-default submission, acknowledged removal, bounded retries/30-day expiry, pending clear and path-free payloads.
- [x] Opt-in Last.fm similar-artist lookup with local-library matching; existing offline recommendations continue without network accounts.
- [x] Direct radio streams through the audio engine, saved stations and Radio Browser search adapter; radio is local playback and cannot host a shared file room.
- [x] RSS/Atom podcasts: follow/remove, bounded episode lists, download/save via existing cache and separate resume positions (saved every five seconds).
- [x] Protect active/next downloaded audio from cache pruning while playing.
- [x] Optional Discord listening status through local IPC: configurable application ID, fragmented-frame/handshake handling, ping/pong, bounded deduplicated updates and clearing on pause/disable/quit. Disabled by default; publishes title/artist only.
- [ ] YouTube playlist discovery/visible player and Spotify OAuth/authorized player/local-library matching. These still need implementation and provider setup; their audio is not handled by the local cache/output graph. See provider planning in `docs/ROADMAP.md`.
- [ ] Progressive remote-file start, HLS, standalone LAN remote control and a casting route still need code.
- [ ] Configure/accept live Last.fm, ListenBrainz, MusicBrainz, Radio Browser, podcast feeds and Discord application/client visibility. Fixture/API-shape/IPC tests and direct-stream playback are complete; service connectivity remains deferred.

### Phase 15 — musician/native tools

- [ ] Native exclusive/bit-perfect output backend with device format negotiation; separate bypass path for effects and multi-output mixing.
- [ ] MIDI rendering with chosen synthesizer, soundfont picker/licensing, and sample cache. MIDI is not claimed as a supported input yet.
- [x] Practice mode with slowdown/A–B and four-click count-in; rate-aware manual-tempo WebAudio metronome with pause/end/unload cancellation.
- [x] Offline ±12-semitone pitch-shift export with preserved duration through optional FFmpeg; real fixture passes.
- [x] Optional spectrogram visualizer, named bookmark save/jump/delete, Ctrl+Shift+B and backup restore.
- [x] Up to 16 parametric EQ bands, frequency/Q/gain/preamp controls, response curve, PK/LS/HS AutoEQ text import and graphic-EQ bypass integration.
- [ ] Live independent pitch shift, automatic BPM/key detection and detected-tempo metronome synchronization still need code.
- [ ] Accept audible metronome alignment, pitch-render sound quality and AutoEQ response with real headphones; native hardware tools remain separate implementations.
- [x] A–B audio export promoted to the pre-9 work; plugin/script API remains a future scoped decision.

### Phase 16 — quality and accessibility

- [x] Bounded local logs, crash recovery and automated critical-path suite promoted before Phase 9.
- [x] Local diagnostic viewer/export and optional sanitized crash sender; server receiver is disabled by default, rate/size/storage limited and expires reports after 30 days.
- [x] Validated settings import/export with confirmation and restart guidance; account credentials, local paths, output routing and queue are excluded.
- [x] Dialog navigation/status labels, waveform keyboard seek, palette keyboard access and missing button title→ARIA labels.
- [x] Query/DOM performance regression budgets at 20,000/10,000 songs and expanded offline/real-Electron/real-media/server-restart suites.
- [x] Local documentation site and maintained setup/testing/limits guide (`docs/index.html`, `docs/LATER-PHASES.md`).
- [ ] Configure and accept opt-in reporting over real HTTPS; publish the documentation site if desired.
- [ ] Complete screen-reader/full-keyboard audit, externalize interface strings and implement full interface translations/RTL layouts.
- [ ] Measure whole-app startup/idle CPU/long-session memory on real large libraries and each platform; current query/DOM budgets do not close that acceptance task.
