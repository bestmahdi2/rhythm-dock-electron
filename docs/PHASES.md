# Rhythm Dock — Rework Roadmap

**Current implementation note (2026-10-02):** this document retains the original
Phase 1–6 patch plan. Use `../TASKS.md` for checked implementation/acceptance status
and `ROADMAP.md` for Phase 7 onward. The current engine is streamed HTML media plus
WebAudio, not Howler; icons use current-color SVG plus generated native variants;
the vertical preset is 220×560 with wider panels. Local tests pass through schema
v13 and critical shared-room paths. Later library, editing, practice and connected
features are documented in `LATER-PHASES.md`; checked tasks are in `../TASKS.md`.
Installer, hardware and live provider/server
acceptance remain separate. NSIS currently retains one-click install and preserves
app data on uninstall; automatic updating is still gated on installer acceptance.

Every phase ships as a standalone `git apply`-able patch file. Apply them **in order**;
each phase assumes the previous one is applied. Patches are rooted at the repository
root (the folder that contains `Rhythm Dock/`, `manage.ps1`, `.github/`).

```bash
git apply --3way phase-01-foundations.patch
```

---

## Pre-flight notes

The notes below describe the original pre-rework snapshot. The retired PNG
controls, Howler bundle and separate vertical page have since been removed;
current layouts share `src/renderer/index.html` and use the WebAudio engine.

**Missing assets.** The supplied `Project_Backup.zip` does not contain
`Rhythm Dock/src/assets/images/` (placeholder.png, play.png, pause.png, next.png,
prev.png) or `Rhythm Dock/src/assets/vendor/howler.core.min.js`, even though the code
references them. They exist in your working copy — the backup just omitted them. All
patches assume they are present. Phase 1 adds a generator so the *icon* assets are
produced deterministically at build time instead of being hand-maintained binaries.

**Architectural direction.** The app is currently a fixed-size, frameless mini-dock
(380×180, min == max). Requests 12, 13, 14, 16, 17, 25 and 26 cannot coexist with a
hard-locked window, so Phase 1 converts the window to a *bounded resizable* window with
persisted geometry, and Phase 5 introduces the tabbed shell. The compact dock look is
preserved as the default "Dock" size preset.

**Code structure.** `main.js` (468 lines) and `renderer.js` (1161 lines) are split into
modules progressively across the phases. Nothing is rewritten wholesale in one step —
each phase moves only what it needs, so every patch stays reviewable.

---

## Phase 1 — Build system, packaging & data safety

*Ships: `phase-01-foundations.patch`*

Foundation work. Nothing user-visible changes except that updates stop eating your data.

| # | Request | What happens |
|---|---------|--------------|
| — | Builders broken on mac/linux | Full `mac` (dmg + zip, x64 + arm64), `linux` (AppImage, deb, rpm, tar.gz) and `win` (nsis + portable) targets in `electron-builder`. `better-sqlite3` is a native module, so a rebuild step and `npmRebuild`/`buildDependencies` config is added. GitHub Actions becomes a 3-OS build matrix instead of a Windows-only job. |
| 1 | mp3 icon must differ from other formats | Per-extension file-association icons. A `scripts/generate-icons.js` build step renders a distinct badge + accent colour per container (mp3 / m4a / flac / wav / mp4 / ogg / opus / aac / wma / aiff) into `.ico`, `.icns` and `.png`, so every platform gets the right artwork without committing 30 binaries. |
| 7 | DB wiped on update | The lyrics DB and settings move to a stable, product-name-independent directory (`<appData>/RhythmDock/data/`). A one-shot migration copies any pre-existing `lyrics.db` over. NSIS is switched off one-click/silent-uninstall semantics (`deleteAppDataOnUninstall: false`, `oneClick: false` with a proper updater path), a rolling backup is taken before each schema change, and the schema is versioned so future upgrades migrate instead of recreate. |

Also in this patch: `src/main/` module folder created (`paths.js`, `database.js`,
`window-state.js`), window becomes resizable with remembered geometry and sane
min/max bounds, `.gitignore`/`.gitattributes` fixed for cross-platform line endings
(the current CRLF-everywhere state breaks shell scripts on Linux builds).

---

## Phase 2 — Playback engine correctness

*Ships: `phase-02-playback.patch`*

The audio layer is extracted into `src/renderer/audio/engine.js` and rebuilt on a proper
WebAudio graph (source → EQ chain → gain → destination), which everything later hangs off.

| # | Request | What happens |
|---|---------|--------------|
| 21 | Play does nothing after a song ends | `onend` now parks the sound in an explicit `ended` state; pressing play restarts from 0 instead of seeking past `duration`. |
| 11 | Pause icon never returns to ▶ at end, lyrics stuck | Transport state becomes a single state machine (`idle / loading / playing / paused / ended`) with one `renderTransport()` sink, so the icon can no longer desync. Lyrics reset to line 0 on `ended`. |
| 22 | Blast of volume on start; 1 s of the last song plays at launch | Gain ramps 0 → target over 400 ms on every start. The restore-session path now loads with `autoplay: false` **and** mutes until `onload` fires, killing the stray one-second burst (which was Howler auto-playing before `startPaused` was applied). |
| 18 | Big files stall the UI | Two-stage load: `html5: true` streaming Howl for instant playback, with metadata + waveform-independent duration resolved from `music-metadata` first, so the UI paints immediately and the decode happens behind it. |
| 19, 23 | Speed control | 0.5×–2.0× playback rate with pitch preservation, exposed as a control and persisted per session. |
| 6 | Lyric flash when skipping fast | The existing `loadTicket` guard is extended to cover the async lyrics fetch and the DOM write, so a late-arriving fetch for a skipped track is dropped instead of painted. |
| 24 | Progress bar invisible in dark mode; wheel-seek hitbox too small | Progress bar restyled with a filled-track gradient that has contrast in both themes, and wrapped in a 10 px padded hit area that owns the wheel/middle-click seek. |
| 20 | Drag & drop only works on one section | Drop handling moves to `window` with a full-surface overlay, so any part of the app accepts files. |

---

## Phase 3 — Library intelligence & file operations

*Ships: `phase-03-library.patch`*

Introduces `src/main/library/` — a scanner, a metadata normaliser and an in-memory index.

| # | Request | What happens |
|---|---------|--------------|
| 2 | Smarter artist detection | A scoring parser: ID3/Vorbis/MP4 tags first, then filename heuristics that recognise `Artist - Title`, `Title - Artist`, `NN. Artist - Title`, `[Label] Artist - Title (Remix)`, underscore/dot separators, bracketed junk (`320kbps`, `Official Video`, site watermarks like `www.example.com`), and cross-checks the candidate against the folder name and the rest of the directory to decide which side is the artist. |
| 8 | Search songs in subfolders | Scanner becomes recursive with depth limiting, symlink-loop protection, `.nomedia`-style skip files and a concurrency-capped walker so huge trees don't block. |
| 16 | Search + play all songs by an artist | Artist index built during scan; a search box filters by artist/title/album with fuzzy matching, and "Play all by X" builds a playlist. |
| 17 | Play the liked playlist | Favourites promoted from a flat path array to a real named playlist that can be loaded, shuffled and played as a queue. |
| 13 | Full file dropdown | Show in folder, copy filename, copy title & artist from tag, copy file path, copy full path, open file, open containing folder, show/hide playlist panel, delete file (with confirm, to recycle bin), exclude from this directory's playlist (persisted per-directory exclusion list). |

---

## Phase 4 — Interface rebuild

*Ships: `phase-04-ui.patch`*

The biggest visual patch. Replaces the ad-hoc inline SVGs with an icon system and fixes
the layout defects.

| # | Request | What happens |
|---|---------|--------------|
| 4 | Buttons invisible in Windows dark mode; taskbar icons poor | Thumbar icons regenerated at runtime in both light and dark variants and swapped on `nativeTheme.updated`. In-app icons move to a bundled Font Awesome 6 subset (self-hosted — the CSP forbids CDNs) with a currentColor-driven palette that has guaranteed contrast in both themes. |
| 9 | Current lyric line too big when it wraps | The active line measures itself and steps its font size down (three tiers) until it fits the container without clipping. |
| 10 | Lyrics slide behind the sync-offset button | Lyrics section relaid out: offset controls become an overlay chip that fades out while scrolling and the text column gets its own padded track, so nothing overlaps. |
| 12 | Vertical mode is broken | Vertical layout rebuilt from scratch — proper stacking order, wrapped title/artist, vertical volume, compact transport row, and lyrics kept (currently they are just hidden). |
| 5 | Show/hide shortcuts + minimise to tray | System tray icon with a context menu, "minimise to tray" option, and configurable global shortcuts to restore and to hide the window. |
| 24 | *(styling half)* | Dark-mode progress bar, slider thumbs and focus rings finalised alongside the icon system. |

---

## Phase 5 — Tabbed shell, settings & extras

*Ships: `phase-05-shell.patch`*

| # | Request | What happens |
|---|---------|--------------|
| 14 | Three tabs + 3-dot switcher | App shell becomes Player / Playlist / Settings views with a bottom three-dot pager. Window auto-resizes per tab (dock-sized for Player, taller for Playlist/Settings). |
| 25 | Equalizer | 10-band `BiquadFilterNode` graph on the Phase 2 audio chain, with presets (Flat, Bass, Vocal, Rock, Classical, Custom), a preamp, and persistence. |
| 26 | Work timer | Countdown that fades the music out and stops it, then raises a native notification + a modal nudge to get back to work. Presets and a custom duration. |
| 3 | Pause when earbuds are removed | `navigator.mediaDevices.devicechange` + `AudioContext.sinkchange` watcher pauses on default-output loss, plus Windows/macOS-specific device-id comparison so it only fires on an actual disconnect, not a volume change. |
| 15 | Translator (FA / EN / FR / AR) | Lyrics translation with a target language picker in Settings and a toggle button in the lyrics bar. Pluggable provider interface so you can point it at your own endpoint; ships with a free provider by default and caches translations in the DB next to the lyrics. RTL-aware rendering for Persian/Arabic. |

---

## Phase 6 — Streaming & shared rooms

*Ships: `phase-06-streaming.patch`*

The last patch. Adds `server/` — a standalone Node service you deploy on your VPS, plus
the client half in the app.

- **Host mode:** your laptop registers with the VPS, publishes its library index, and
  streams the audio (HTTP range-request relay, so the VPS never stores your files).
- **Rooms:** a room is created by the host with a join code. Anyone with the app —
  desktop, and a browser client served by the VPS so phones work with no install — can
  join, listen in sync, and (if the host grants control) play/pause/skip/queue.
- **Sync:** server-authoritative clock with NTP-style offset estimation; clients drift-correct
  by nudging playback rate rather than seeking, so nobody hears a jump.
- **Auth:** room codes + optional password, per-member control permissions, host kick.
- Ships with a `docker-compose.yml`, a systemd unit and an nginx reverse-proxy config
  for the VPS, plus a `Settings → Sharing` panel in the app.

---

### Phase 6 status: shipped

`server/` contains the VPS service; `src/main/room-client.js` the app half. See
`server/README.md` for the full deployment guide. Test with `cd server && npm test`.

---

## Sequencing rationale

Phase 2 must precede 5 because the equalizer and the earbud watcher both attach to the
audio graph Phase 2 builds. Phase 3 must precede 4 and 5 because the playlist tab and the
file dropdown render data the library layer produces. Phase 6 is last because it consumes
the library index (Phase 3), the transport state machine (Phase 2) and the settings shell
(Phase 5).
