# Rhythm Dock — prioritized task checklist

Updated 2026-09-24 from `docs/PHASES.md`, `docs/ROADMAP.md`, `server/README.md`, and the current source. **This order follows the requested product goal:** friends hear one synchronized queue and can both add music, including songs sent to a Telegram bot. The numbered requests from the earlier lists are included below. `[x]` means a code path exists; `[ ]` means implementation or acceptance remains. Source presence alone does not prove an installed release works.

## P0 — shared listening and data safety

- [ ] **1. Finish collaborative room queues — implementation in progress.** Phase 6 already streams the host's audio and synchronizes browser/desktop guests. The 2026-09-24 P0 pass adds host-authoritative add at top/next/end, remove, and move; shares a path-free catalog from the persistent library; and exposes those actions to authorized browser and desktop guests. Move/remove use track IDs so a stale row number cannot target another song. Server permission/routing tests pass. Still required: live two-guest acceptance, reconnect and rapid-edit checks, queue state persistence policy, and a scalable catalog search for very large libraries. A guest must see a track added by the other guest and hear it at the same position before this box is checked.
- [ ] **2. Let both friends contribute music — code path implemented, device acceptance open.** Browser and desktop controllers can submit local audio to the host at top/next/end. The server enforces a 30 MB limit and audio extension allowlist; only the host token can retrieve a pending file. The host imports into its stable data directory, indexes it, queues it, and removes the temporary server copy. Pending uploads expire after two days or server restart. The browser and desktop show pending/error/success feedback. Server tests cover upload authorization and host retrieval. Still test actual audio import/playback, interrupted transfers, concurrent uploads, and two real clients. Listener access remains blocked.
- [ ] **3. Telegram bot intake — code path implemented for attachments, live acceptance and links open.** Optional server-side `TELEGRAM_BOT_TOKEN` enables Bot API polling; the host creates a ten-minute pairing code and a private chat sends `/pair CODE`. Supported audio attachments up to the hosted Bot API's 20 MB download limit use the same temporary host-import path, with success/error replies. A mock API test covers pairing and attachment intake. Still required: obtain the bot token, test against Telegram, handle supported playable links/playlist intake, verify duplicate update/restart behavior, and decide host approval policy. Do not check off until live acceptance passes.
- [ ] **4. Prove the room end to end on a real server.** Configure HTTPS/WSS, creation secret and room password, then test two friends on separate networks/devices: join, grant control, add/reorder songs, play in sync, disconnect/reconnect, and host loss. The server is a relay; it does not persist audio or room state. Add a deployment/restart persistence decision if the queue must survive a server restart. No server deployment is done by this checklist.
- [ ] **5. Protect library data through installed upgrades.** Stable paths, migration, and backups are in code (original #7; Phase 7). The 2026-09-24 Electron smoke test passed legacy import, v1→v5 schema migration, backup creation, and reopen using isolated temporary data. Still test a real old-to-new installer upgrade with library, lyrics, settings, and backup/restore before checking this off. Gate auto-update on this proof.
- [ ] **6. Verify simultaneous outputs on the requested devices.** Main plus extra outputs and manual delay exist in Settings. The 2026-09-24 code pass prevents the same selected device being both primary and extra and improves failure/retry behavior. Test wired + speakers + two or three Bluetooth devices on the target OS, calibrate delay, and present clear failures when the OS cannot connect that mix. This was the user's earlier critical audio request.
- [ ] **7. Establish project tests and diagnostics for the critical paths.** `npm test` runs the isolated Electron database migration smoke test and the server's corrected async suite (now 48 checks, including guest upload and a mocked Telegram intake). Add direct host queue mutation/import, audio routing, and crash/reconnect tests. Add structured logs that let a user report a room or output failure without exposing tokens. Phase 16.

## P1 — requested player and sharing experience

- [ ] **8. Edge-docked super-minimize.** Build a left/right anchored narrow strip with essential controls and vertically scrolling title; expand to the full vertical player on hover, keep it wall-aligned while moving up/down or switching walls, handle multiple monitors, and add a global toggle shortcut. Test with control lock and normal minimize-to-tray. Phase 9.5; original follow-up #1.
- [ ] **9. Direct audio URL intake and bounded cache.** Make remote playable audio a queue source for rooms and Telegram. Add a two-day expiry for unsaved files, a disk-size ceiling, and a deliberate “save to library” action. Treat YouTube/Spotify playlist imports as link/metadata discovery until a supported playback source is established; do not promise their full audio in the shared queue. Phase 9.5; follow-up #7.
- [ ] **10. Named playlists and complete file actions.** The current file menu has show/open/copy/delete/exclude and shows the queue. Add named playlist selection, add/remove/play actions, and persistent playlist CRUD separate from the live queue. Resolve whether “file path” and “full path” need distinct copy actions. Original #13; Phase 11.
- [ ] **11. Make the requested three-tab shell.** Current bottom pager has Player, Library, Edit tags, and Settings (four tabs). Move tag editing to a track action or Settings and retain Player, Playlist, Settings as three clear destinations. Original #14.
- [ ] **12. Reproduce the missing Controls button.** Lyrics menu currently exposes Show/Hide Controls. Identify which mode/screen the report refers to and restore the intended button there. Phase 10.
- [ ] **13. Visually accept the A–B region.** The 2026-09-24 progress-bar highlight uses the current accent. Check it in dark/light themes and compact/vertical sizes, including start/end changes and track switches. Follow-up A–B request.
- [ ] **14. Add offline recommendations.** Use persisted play/skip history and available artist/genre metadata to suggest next tracks/albums, explain why, and let the user reject a suggestion. Add optional online enrichment only after the offline experience works. Phase 9.5/14; follow-up #6.
- [ ] **15. Improve icons, logo, and name.** Prepare a few concrete visual/name options, test taskbar/tray/filetype readability in both themes, then change branding without changing the stable data path. Also visually verify the Windows thumbnail buttons; the app still uses inline SVG rather than a Font Awesome set. Original #4 and follow-up branding request.
- [ ] **16. Finish layout and audio acceptance on the installed app.** Check the vertical player (#12), lyric sizing/overlap (#9–10), end/replay state (#11, #21), fast-skip lyric flash (#6), restored-song volume burst (#22), theme contrast and padded middle-click progress seek (#24), timer notification (#26), and earbud-removal pause (#3) on representative hardware. Fix regressions found.
- [ ] **17. Decide whether explicit 10% buffering is needed.** The engine already streams large files instead of decoding the whole file. Measure startup on large local and remote files; only add a 10% threshold if it improves responsiveness. Original #18.

## P2 — unfinished roadmap features

### Phase 7 — library foundation

- [x] SQLite library tables, multiple roots, missing-file flags, play/skip counts, recent/added views, and JSON library backup/restore exist in `src/main/services/library-store.js` and database migrations.
- [ ] Incremental scan based on file mtime/size; avoid re-reading unchanged metadata.
- [ ] Watch library roots for adds/deletes and update the index while running.
- [ ] Run large scans and metadata parsing off the main process with progress/cancellation.
- [ ] Add a content-keyed album-art thumbnail cache for larger views.
- [ ] Add persistent ratings (and optional tag sync) without confusing them with the existing Like control.

### Phase 8 — audio depth

- [x] Playback-rate/pitch-preservation option, gapless prebuffer/crossfade, tag-based ReplayGain application, output selection, A–B repeat, skip silence, balance/mono/swap, equalizer and simultaneous output code exist.
- [ ] Validate pitch quality, true gapless handoff, crossfade, ReplayGain loudness, and multi-output latency with audio fixtures; add a ReplayGain scan/analysis path if tag data is missing.
- [ ] Scope extra decoders for APE/WavPack/DSD/MIDI/tracker files against actual demand.
- [ ] Add CUE sheet track navigation and m4b chapter/resume support.
- [ ] Investigate exclusive/bit-perfect native output separately; the WebAudio EQ path cannot provide it.

### Phase 9 — lyrics

- [x] `docs/ROADMAP.md` labels Phase 9 shipped: editor/tap sync, sidecar/embed, providers, karaoke timing, full screen, desktop overlay, typography, per-track offset, and translation cache. Keep regression checks in P1.

### Phase 10 — interface

- [ ] Waveform seek bar with cached peaks; Now Playing full-screen view; visualizer.
- [ ] Album-art-derived accent, custom theme import/user CSS, and a command palette.
- [ ] Virtualized library lists before large libraries or grid views; drag-to-reorder queue.
- [ ] First-run folder onboarding and saved layout presets.

### Phase 11 — library management

- [ ] Named playlists, M3U/PLS/XSPF import/export, and rule-based smart playlists.
- [ ] Explicit queue-versus-playlist behavior throughout player, rooms, and Telegram.
- [ ] Album/artist art grids and folder-tree browsing.
- [ ] Sorting, filtering, multi-select and bulk actions; chronological play history; duplicate review (never automatic deletion).
- [x] Recently added/recently played queries and queue insertion positions exist.

### Phase 12 — tags and files

- [ ] Batch tag editing; filename/tag pattern conversion with preview; undoable file organization with dry run.
- [ ] MusicBrainz lookup, AcoustID identification, missing-cover fetch, tag presets.
- [ ] Format conversion and basic audio editor (trim/split/preview); export an A–B selection as a new file without changing the original. Decide whether FFmpeg is bundled or optional.

### Phase 13 — desktop integration

- [ ] MPRIS on Linux and macOS Now Playing controls.
- [ ] Auto-update after the P0 data-upgrade test; launch-at-login; CLI arguments; portable mode.
- [ ] Rich track notifications and a Wayland positioning pass.
- [x] Windows thumbnail toolbar and single-instance/open-file handling have code paths; test packaged behavior, especially opening several files into one queue.

### Phase 14 — connected features beyond rooms

- [ ] Last.fm and ListenBrainz scrobbling with an offline submission queue; Discord Rich Presence.
- [ ] Internet radio; podcast feeds/download/resume; LAN remote web control.
- [ ] Choose and implement one casting route (Chromecast, DLNA, or AirPlay) before promising all three.
- [ ] Complete room collaboration and Telegram integration in P0 before expanding the service surface.

### Phase 15 — musician tools

- [ ] Practice mode and pitch/key shifting; BPM and musical-key detection; metronome.
- [ ] Spectrogram, named bookmarks/cue points, parametric EQ/response curve/AutoEQ profiles.
- [ ] A–B export and editor/converter in Phase 12 above; evaluate a plugin/script API only with a clear use case and security model.

### Phase 16 — quality and accessibility

- [ ] Crash recovery and readable structured logs; opt-in crash reporting.
- [ ] Automated test suite (P0), screen-reader labels, full keyboard navigation, interface i18n including RTL.
- [ ] Settings import/export, large-library CPU/memory budget, and a maintained documentation site.

## Already implemented from the original 26 requests

The earlier code audit found implemented paths for distinct MP3 icons (#1), artist inference (#2), tray and shortcuts (#5), stale-lyric guards (#6), recursive subfolder scanning (#8), lyric fit/layout (#9–10), transport end handling (#11, #21–22), vertical layout (#12), lyrics translation (#15), artist search/play-all (#16), liked-song play (#17), speed control (#19 and duplicate #23), full-window drop (#20), equalizer (#25), and work timer (#26). Items with an acceptance risk or a remaining specification gap are listed in P0/P1. The dark/light control is already drawn as a switch, control lock is implemented, and “Added” is a library view.
