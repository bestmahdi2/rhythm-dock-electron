# Rhythm Dock — Feature Roadmap (Phase 7 onward)

Continues from `PHASES.md`, which ends at Phase 6 (streaming & shared rooms).
Everything here is a proposal, not a commitment — pick what fits the player you
actually want to build.

---

## How to read this

Each phase has a **theme**, and phases are ordered so that later ones can
assume earlier ones exist. Within a phase, features are roughly ordered by
value-per-effort.

Effort is rated relative to this codebase:

| | Meaning |
|---|---|
| **S** | A day or two. Contained in one or two files. |
| **M** | A week-ish. New module, some IPC, some UI. |
| **L** | Multi-week. New subsystem or a hard dependency. |
| **XL** | A project of its own. Consider whether you want it at all. |

Two honest warnings before the list:

**Scope is the enemy here.** Every feature below is defensible in isolation.
Shipped all together they produce a bloated player with a confused identity.
Rhythm Dock's current identity is *"a compact dock that gets out of the way"* —
Phases 7–10 protect and deepen that. Phases 11+ progressively turn it into a
full library manager, which is a different product. That is a legitimate choice,
but make it deliberately rather than by accretion.

**Phase 7 is foundational.** The persistent SQLite library, incremental worker
scan, folder watching, ratings, and art cache are now implemented. The in-memory
search index is still rebuilt from the saved roots on startup. Installed-app
acceptance for large libraries and upgrades remains in `TASKS.md`.

---

## Phase 7 — Persistent library

**Theme: give the app a memory.** The single highest-leverage phase in this
document, and the least visible to a user. Everything downstream depends on it.

| Feature | Effort | Description |
|---|---|---|
| SQLite library schema | M | Tracks, albums, artists, folders, and their relationships in the existing `better-sqlite3` database alongside the lyrics cache. Schema versioned and migrated, never recreated. |
| Incremental scanning | M | Scan compares `mtime` + size against what is stored and only re-parses changed files. A 50,000-file library currently re-parses entirely on every open; this makes it near-instant on the second run. |
| Multiple library roots | S | Track more than one folder. Most people have music in at least two places. |
| Folder watching | M | `chokidar` or `fs.watch` picks up files added or deleted while the app is running, instead of requiring a manual rescan. |
| Missing-file handling | S | Tracks whose files have vanished are flagged rather than silently dropped, so a temporarily unmounted external drive does not erase half the library. |
| Play counts, last played, skip counts | S | Recorded per track. The raw material for "recently played", smart playlists, and any recommendation feature later. |
| Ratings | S | 0–5 stars, or a simple loved/neutral/disliked. Stored in the DB *and* optionally written to the file's tags so it survives a library reset. |
| Background scan worker | M | Move scanning and metadata parsing to a `worker_thread`. Currently a large scan blocks the main process, which stutters playback. |
| Thumbnail cache | M | Album art decoded once, resized, and cached to disk by content hash. Essential before any grid view — decoding 500 embedded JPEGs per scroll is not viable. |
| Library backup & restore | S | Export/import the DB. You have already been bitten once by an update wiping data. |

---

## Phase 8 — Audio engine depth

**Theme: sound quality and playback correctness.** This is where a music player
earns credibility with people who care about audio.

| Feature | Effort | Description |
|---|---|---|
| **Pitch-preserving speed** | M | Currently changing speed changes pitch, which makes the feature unusable for music (it is fine for podcasts). A phase vocoder or `SoundTouch`-style time-stretch via WebAudio `AudioWorklet` fixes it. Arguably a bug fix, not a feature. |
| Gapless playback | M | Pre-buffer the next track and hand off at the sample boundary. Live albums, DJ mixes, and most classical are broken without it. |
| Crossfade | S | Configurable 0–12s overlap, with an option to disable it for gapless albums specifically. |
| ReplayGain / EBU R128 | L | Scan tracks for loudness, store the gain in the DB and optionally in tags, apply on playback. Stops a quiet 1970s master being inaudible after a loud modern one. Track gain and album gain both. |
| Output device selection | S | Pick the output device explicitly instead of following the system default. `devices.js` already exists; this exposes it. |
| Exclusive / bit-perfect output | XL | WASAPI exclusive on Windows, hog mode on macOS. Requires leaving WebAudio for a native addon. Only worth it if you are targeting audiophiles; be honest about whether you are. |
| A–B repeat | S | Set two points and loop between them. Trivial to build, disproportionately loved by anyone learning an instrument or a language. |
| Skip silence | S | Detect and skip leading/trailing silence and long gaps. |
| Balance & channel mixer | S | L/R balance, mono downmix, channel swap. Accessibility feature as much as an audio one — genuinely important for users with single-sided hearing loss. |
| Wider format support | M | APE, WavPack, DSD, MIDI, tracker modules. Each needs a decoder; scope this by what you actually own. |
| CUE sheet support | M | Single-file albums split into tracks by an accompanying `.cue`. |
| Chapters (m4b) | M | Audiobook chapter navigation, with per-book position memory. |

2026-09-24 code pass: CUE sidecars and MP4/M4B chapters now have navigation in
the player; per-M4B positions use schema v10 and the library backup. Test
chaptered media in the installed app before treating format support as accepted.
Other Phase 8 audio-quality and hardware checks remain open in `TASKS.md`.

---

## Pre-Phase-9 player gate — requested 2026-09-24

Phase 9 lyrics shipped earlier in v1.6.0. Before expanding that phase or calling
the intervening player work accepted, verify these seven requests. Engineering
code and real-device acceptance are separate; `TASKS.md` tracks the latter.

1. Edge-docked super-minimize: the wall strip, hover expansion, vertical movement,
   side switching, title scroll, and Ctrl+Alt+D are implemented. Installed-app
   visual and multi-monitor acceptance remains.
2. Theme mode: Settings uses a real switch control for light/dark, not a checkbox.
3. Simultaneous audio outputs: one shared WebAudio graph mirrors to extra outputs
   with per-device delay; the system-default alias is screened to avoid duplicate
   playback when device identity is available. **Priority gate:** test a wired
   device, speakers, and multiple Bluetooth earbuds together on the target OS.
   The current development machine exposes only one playback endpoint.
4. Queue placement: local and room controls offer top, after-current, and end.
5. Lock: controls are blocked until unlock, including in the wall strip.
6. Recommendations: offline track and album suggestions use artist, album,
   genre, ratings, likes, plays, and skips. Vibe inference, learning from
   explicit feedback, and optional online enrichment remain in Phase 14.
7. Online sources: direct HTTPS audio is streamed into a two-day bounded cache
   and can be saved. YouTube/Spotify links and playlists need provider-specific
   discovery and a supported playable source; plan them in Phase 14. Do not label
   those sources implemented merely because direct media URLs work.

## Phase 9 — Lyrics, properly ✅ *shipped in v1.6.0*

Every row in the table below is implemented. Notes on how, where it is not
obvious from the feature name:

- **Provider chain** lives in `src/main/services/lyrics.js` and runs in the main
  process, so no provider needs a `connect-src` entry in the renderer's CSP.
  Genius is used to *identify* a track (its API does not expose lyric bodies)
  and the corrected artist/title is re-queried against lrclib.
- **Sidecar `.lrc`** files are written next to the audio file, falling back to
  `<appData>/RhythmDock/lyrics/` when that directory is not writable — plenty of
  libraries sit on read-only media.
- **Per-track offset** and the `hasWordTiming` flag are schema v4
  (`lyrics_prefs`). The offset is a separate table so it survives a refetch.
- **Full screen** moves the live lyric element into the overlay rather than
  rendering a second copy, so there is one render path and one tick loop.
- **The desktop overlay** is a second `BrowserWindow` with its own minimal
  preload; all timing stays in the player, which already knows the current line.

**Theme: the feature you are already best at, taken further.** Lyrics are
Rhythm Dock's clearest differentiator. Deepening them is better positioning
than adding a tenth library view.

| Feature | Effort | Description |
|---|---|---|
| Lyrics editor with tap-to-sync | M | Play the track, tap a key on each line, get a timed LRC. The single most requested feature in every lyrics-capable player, and nobody does it well. |
| Save LRC beside the file / embed in tags | S | Your work should survive a library reset or a move to another player. |
| Multiple providers with fallback | S | lrclib → NetEase → Genius (unsynced) → embedded. Currently a single source is a single point of failure. |
| Word-level karaoke (enhanced LRC) | M | Highlight within the line, not just the line. Parse and render `<mm:ss.xx>` word tags. |
| Full-screen lyrics mode | S | Large type, blurred album art behind, no chrome. |
| Desktop lyrics overlay | M | A borderless always-on-top strip that floats over other apps, showing only the current line. Extremely popular in Asian music players and largely absent in Western ones. |
| Lyrics typography settings | S | Font, size, weight, alignment, line spacing. Matters a lot for CJK and RTL scripts. |
| Manual offset saved per track | S | The offset control exists but is per-session; persist it per file. |
| Translation caching | S | Cache translated lines in the DB so a re-listen does not re-hit the API. |

---

## Phase 10 — Interface & experience

**Theme: make the compact player excellent rather than merely small.**

| Feature | Effort | Description |
|---|---|---|
| Waveform seek bar | M | Render a peak file per track (cached in the DB) so the progress bar shows the song's shape. Makes seeking to a chorus or a drop a single click. |
| Now Playing full-screen view | M | Large art, blurred backdrop, lyrics, transport. The "put it on the second monitor" mode. |
| Visualizer | M | Spectrum analyser, oscilloscope, or a simple VU. WebAudio `AnalyserNode` makes this cheap; the work is making it look good rather than making it work. |
| Accent colour from album art | S | Extract a dominant colour and drive `--accent` from it. Pairs naturally with the ten-theme token system already in place. |
| Command palette | S | `Ctrl/Cmd+K` for every action. The fastest way to make a feature-dense app feel light, and it makes deep features discoverable without more chrome. |
| Custom themes / user CSS | S | The theme system is already pure tokens. Let users drop a JSON palette in the config folder. Very low cost, high goodwill. |
| Virtualised lists | M | The library list will not survive 20,000 rows without windowing. Do this before the grid views in Phase 11, not after. |
| Drag to reorder the queue | S | Currently the queue is not directly manipulable. |
| Onboarding | S | First run currently shows an empty dock with no instruction. One screen: pick a folder. |
| Layout presets | S | Save and recall window size/position/mode combinations. |

---

## Phase 11 — Library management

**Theme: this is the fork in the road.** From here on, the app stops being a
dock and starts being a library manager. Worth pausing to decide.

| Feature | Effort | Description |
|---|---|---|
| Playlists | M | Real, persistent, named playlists — distinct from the play queue. Reorder, duplicate, delete. |
| M3U / PLS / XSPF import & export | S | Interoperability with everything else the user owns. |
| Smart playlists | M | Rule-based: "rating ≥ 4 AND not played in 30 days AND genre is jazz". Only possible on Phase 7's schema. |
| Queue vs playlist separation | S | "Play next" and "Add to queue" as distinct actions from "play now". A surprisingly deep UX change, and the thing people miss most when moving from a mature player. |
| Album / artist grid views | M | Art-first browsing. Needs Phase 7's thumbnail cache and Phase 10's virtualisation. |
| Folder tree browser | S | Some libraries are organised by folder and no amount of tag inference beats just showing the tree. |
| Sorting, filtering, multi-select | M | Column sorting, filter-as-you-type, shift/ctrl selection, bulk operations. |
| Play history | S | A chronological log. Cheap once play counts exist. |
| Duplicate detection | M | By tags, by file size/duration, or by audio fingerprint. Offer a review screen — never auto-delete. |
| Recently added / recently played | S | Two queries against Phase 7 data. |

---

## Phase 12 — Tag & file management

**Theme: extend the tag editor you now have into a library-wide tool.**

| Feature | Effort | Description |
|---|---|---|
| Batch tag editing | M | Select many tracks, edit shared fields, write once. The natural next step for the Phase 5 editor. |
| Tag from filename / filename from tag | M | Pattern-based, with a live preview: `%artist% - %title%`. Your `metadata.js` scoring already does the hard inference part. |
| Auto-organise files | M | Move/rename into `Artist/Album/## Title.ext` by a user template. **Always dry-run first, always undoable** — this feature has destroyed more libraries than any other. |
| MusicBrainz lookup | L | Match an album against the MusicBrainz database and fill in tags, including cover art and release dates. |
| AcoustID fingerprinting | L | Identify untagged files by their audio. The only real answer to a folder of `track01.mp3`. Needs `chromaprint`. |
| Album art fetching | M | Download missing covers, embed or save as `folder.jpg`. |
| Tag presets & templates | S | Reusable field sets for a series or a bootleg collection. |
| Format conversion | L | Transcode via a bundled `ffmpeg`. Useful, but it doubles your binary size — consider making it an optional download. |
| ReplayGain scan UI | S | The batch front-end to Phase 8's analysis. |

---

## Phase 13 — System & platform integration

**Theme: behave like a native app on all three OSes.** Several items here are
gaps rather than additions.

| Feature | Effort | Description |
|---|---|---|
| **MPRIS (Linux)** | M | Without it there are no media-key or desktop-widget controls on Linux at all. You ship `.deb` and `.rpm`, so this is a real gap, not a nicety. |
| **macOS Now Playing** | M | `MPNowPlayingInfoCenter` integration — Control Centre, lock screen, AirPods controls. Same gap, other platform. |
| Auto-update | M | `electron-updater` against your existing GitHub Releases. Given that an update once wiped the database, do this only with the Phase 7 migration path proven. |
| Launch at login | S | Per-OS, via `app.setLoginItemSettings`. |
| CLI arguments | S | `rhythm-dock /path/to/song.mp3 --play`. Also what makes "Open With" reliable. |
| Portable mode | S | Detect a marker file and keep all data beside the executable. |
| Rich notifications | S | Track-change toasts with art and inline transport buttons. |
| macOS Touch Bar / Windows thumbnail toolbar | S | Small, native, and cheap once the transport is abstracted. |
| Wayland compatibility pass | M | Always-on-top and window positioning behave differently under Wayland; worth testing explicitly since you target Fedora. |
| Single-instance + file queueing | S | Opening ten files from the file manager should enqueue ten tracks in one window, not open ten windows. |

---

## Phase 14 — Connected features

**Theme: the network features people actually ask for.**

| Feature | Effort | Description |
|---|---|---|
| Last.fm scrobbling | M | The default expectation for any serious player. Needs OAuth and an offline scrobble queue. |
| ListenBrainz scrobbling | S | Same shape, open API, no key negotiation. Often easier to ship first. |
| Discord Rich Presence | S | Shows what you are listening to. Trivial to implement, disproportionately good for word-of-mouth. |
| Internet radio | M | Stream URLs plus a directory (Radio Browser API). Reuses the whole playback path. |
| Podcast support | L | RSS subscriptions, episode list, download management, per-episode resume. This is genuinely a second app inside your app — scope carefully. |
| Remote control web UI | M | A tiny page served on the LAN so a phone can control the player. Your room server already establishes the pattern. |
| Chromecast / DLNA / AirPlay | L | Cast to speakers. Three different protocols; pick one and do it properly. |
| Recommendations | L | "More like this" from local play data, or via the Last.fm similar-artists API. |

---

## Phase 15 — Musician & power-user tools

**Theme: the reason a *developer who is into music* would use this over
Spotify.** This is the most distinctive phase in the document. If Rhythm Dock
is going to have a reason to exist alongside commercial players, it is probably
here.

| Feature | Effort | Description |
|---|---|---|
| Practice mode | M | A–B loop + pitch-preserving slowdown + a count-in. Everything needed to learn a solo, in one screen. Depends on Phase 8. |
| Pitch / key shift | M | Transpose in semitones without changing tempo. For singers and for transposing instruments. |
| BPM detection | M | Per track, stored in the DB. Enables tempo-based smart playlists and a running/workout mode. |
| Key detection | L | Musical key via chroma analysis. Pairs with BPM for DJ-style sorting. |
| Metronome / click track | S | Synced to the detected BPM. |
| Spectrogram view | M | Frequency over time. Also the fastest way to spot a transcoded fake FLAC, which the audio-hoarder crowd cares about intensely. |
| Bookmarks & cue points | S | Named positions within a track, with keyboard jumps. |
| Parametric EQ | M | Beyond the current 10-band graphic EQ: arbitrary bands, Q control, a response curve display, and importable AutoEQ profiles for headphones. |
| Audio export of a selection | M | Save a looped region as a new file. |
| Scriptable actions / plugin API | XL | Let users extend the player. Powerful, and a permanent maintenance and security commitment. Think hard. |

---

## Phase 16 — Quality, accessibility, trust

**Theme: not features, but the things that decide whether people keep using
it.** Do not leave this until last in practice, even though it is last in the
list — pull items forward continuously.

| Feature | Effort | Description |
|---|---|---|
| Crash recovery | S | Restore the queue, position and window state after an unclean exit. |
| Structured logging & log viewer | S | A user reporting a bug should be able to hand you a file. |
| Opt-in error reporting | M | Off by default, clearly explained, no telemetry beyond crashes. |
| Automated tests | M | Your `package.json` `test` script currently exits 1. Start with the pure logic — `metadata.js` scoring, LRC parsing, tag round-trips. Those are where silent regressions hide. |
| Screen reader support | M | ARIA roles and labels throughout. Currently the SVG-only buttons are largely unreadable to assistive tech. |
| Full keyboard navigation | S | Partly done in Patch 3; extend to the library and the tag editor. |
| Interface translation (i18n) | M | Externalise strings. You already ship RTL lyrics rendering, so an RTL *interface* is a natural pairing. |
| Settings import/export | S | Move a configuration between machines. |
| Performance budget | M | Measure memory and CPU with a large library and hold a line. Electron players earn their reputation by ignoring this. |
| Documentation site | S | Even a single well-organised page beats a README section once the feature count triples. |

---

## Suggested sequencing

If you want a short answer to "what next", this is it:

1. **Phase 7** — persistent library. Everything else is built on it.
2. **Phase 8's first three rows** — pitch-preserving speed, gapless, crossfade.
   The speed one is a bug fix in feature clothing.
3. **Phase 9's lyrics editor** — your strongest differentiator, and nobody else
   does it well.
4. **Phase 13's MPRIS and macOS Now Playing** — you already ship for those
   platforms; right now the app is a second-class citizen on both.
5. **Phase 14's ListenBrainz + Discord** — a weekend each, and they are the two
   features that make people tell other people about a player.

Then decide, deliberately, whether you are building a dock (stop here, polish
via Phase 10 and 16) or a library manager (continue into 11 and 12).

---

## Things I would deliberately *not* build

Worth stating, because a roadmap is also a list of what you are declining:

- **A streaming-service client.** Spotify/Apple Music integration means API
  terms, DRM, and a permanent dependency on someone else's product decisions.
- **A social network.** Comments, follows, shared profiles. Your room feature
  already covers the genuinely social use case at the right scale.
- **AI playlist generation**, unless you have a specific idea that beats
  "shuffle by BPM". It is currently a checkbox feature that rarely survives
  contact with a real library.
- **A mobile app.** A different codebase, a different store, a different
  release cadence. The Phase 14 remote-control web UI gets you most of the
  value for a fraction of the cost.

---

## Phase 9.5 — Edge dock, discovery and streaming

### Request check-in (2026-09-24)

This section records the follow-up requests before planning more phases. Source-level
implementation is not a substitute for testing the installed app with real devices.

| Request | Current status / next action |
|---|---|
| Better button icons, app logo, and possible new name | Open design task for Phase 10. Produce a small set of names and visual concepts, check file-association and tray readability, then choose before changing the app ID or data path. |
| Bot connection to receive songs and put them in the queue | Promoted to P0 in `TASKS.md`, immediately after collaborative room queue edits and friend song intake. Define bot pairing, authorization, accepted media/link types, and whether incoming items require confirmation. |
| Edge-docked super-minimize mode | Implemented with a 48px wall strip, hover expansion, vertical movement, wall switching, title scroll, and Ctrl+Alt+D. Installed-app and multi-monitor acceptance remain. |
| Dark/light switch | Already a visual switch in Settings (`.settings-action`), with the button toggling counterpart palettes. |
| Simultaneous wired, speaker, and Bluetooth outputs | Implemented in Settings and the audio engine. The 2026-09-24 pass prevents duplicate routing, cleans up failed outputs, and retries a stream after a playback gesture. Accept only after testing the actual device mix and adjusting per-output delay; operating-system Bluetooth limits still apply. |
| Queue at top / next / end | Implemented as actions on library rows. |
| Control lock | Implemented with lock button and Ctrl+L. Verify alongside edge mode in the installed app. |
| Offline/online recommendations | Offline song and album suggestions now use local metadata and listening history. Vibe learning and optional online enrichment remain open. |
| YouTube/Spotify URLs and playlists, temporary cache, saved imports | Direct HTTPS audio links now download to a bounded, two-day cache with an explicit save action. Progressive playback, real URL acceptance, Telegram links, and YouTube/Spotify playlist discovery remain open. Define playlist import as metadata/links separately from playable audio. |
| Missing “Controls” button | The Lyrics menu currently has Show/Hide Controls. Reproduce which screen or mode lost the expected button, then restore the relevant control in Phase 10. |
| Highlight A–B range | Implemented in the player progress track on 2026-09-24; check theme contrast and narrow layouts. |
| Export A–B section | Open Phase 15 task. Export the selected time span with a bundled or optional transcoder, choose output format, and preserve the original file. |
| Audio editor and converter | Open Phase 15 task. Scope trim/split, preview, metadata, supported formats, and whether FFmpeg is bundled or optional. |
| Recently added playlist/view | Already implemented as the “Added” library view, ordered from library added timestamps. |


Added after Phase 8 from user requests. Current implementation status is in
`TASKS.md`; the sections below retain the design background and future work.

### Edge-docked mini mode

**Implemented; installed-app acceptance open.** The main process manages window
geometry and a 48px collapsed strip. The renderer handles controls and title
scroll. Multi-monitor and display-disconnect behavior still need visual testing.

The following table and discussion are original design notes. The current
implementation is in `src/main/index.js` and `src/renderer/js/renderer.js`.

| Piece | Description |
|---|---|
| Magnetic snapping | Drag near a screen edge and the window latches to it. `screen.getDisplayNearestPoint()` gives the work area; the snap itself is a threshold check on `will-move`. |
| Collapsed strip | ~28px wide against the wall: play/pause, next, and the title scrolling vertically. Everything else hides. |
| Hover expansion | Pointer enters, the window animates out to full vertical mode, still anchored to the wall. Leaves, it collapses again — with a delay, or it flickers as the cursor crosses it. |
| Vertical drag along the wall | Free movement on Y, locked on X. |
| Wall switching | Drag past the midpoint and it re-latches to the opposite edge. |
| Shortcut | Toggle in and out of edge mode from the keyboard. |
| Multi-monitor | Which display's edge? The one the window is on, not the primary. This is where most implementations break. |

**The hard part is hover.** An Electron window only receives mouse events inside
its own bounds, so a 28px strip cannot detect a cursor approaching it. Two
options, and the choice shapes everything else:

1. **Keep the window full-size and transparent**, painting only the strip. Hover
   works natively. Costs: a large always-on-top transparent window, and
   `setIgnoreMouseEvents` juggling so clicks pass through the invisible part.
2. **Genuinely resize to 28px** and poll `screen.getCursorScreenPoint()` at
   ~60ms while docked. Cheap and reliable; a timer runs whenever docked.

Option 2 is the more honest fit for a lightweight dock. Option 1 gives smoother
animation. Worth prototyping both before committing.

macOS caveat: an always-on-top window over a full-screen Space needs
`setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true})`, or the dock
vanishes exactly when a user in full-screen video most wants it.

### Recommendations

**Effort: L–XL.** Feasible, but only after Phase 7 has accumulated real history —
a recommender with no play counts has nothing to recommend from.

| Piece | Description |
|---|---|
| Offline similarity | Artist, genre, year, BPM and key (Phase 15) as a feature vector; nearest-neighbour over the local library. No network, no accounts. |
| Learned weighting | Skips are the strongest signal available and the most underused: a track skipped twice in its first 30 seconds should stop appearing. Weight the vector from play/skip ratios per feature. |
| Session radio | "Keep playing things like this" — build a rolling queue instead of a static list. |
| Online enrichment | Last.fm or ListenBrainz similar-artists to reach beyond what is already owned. Optional, off by default. |
| Explanation | Say *why* a track was picked ("similar tempo, same era"). Unexplained recommendations feel broken when they miss. |

Start with the offline version. It is a few hundred lines over data Phase 7
already stores, it works with no account and no network, and it is genuinely
useful before any of the clever parts exist.

### Streaming from URLs

**Effort: XL, and partly not possible as described.** Worth being precise about
which parts are which, because the three services behave very differently.

| Source | Status |
|---|---|
| **Direct audio URLs** and podcast/radio streams | **Buildable now, cleanly.** The playback path already streams; it needs URL sources in the queue, a disk cache, and an expiry sweep. This is the honest version of the feature. |
| **YouTube** | Technically possible with `yt-dlp`, but extracting audio breaks YouTube's Terms of Service. It also breaks whenever YouTube changes, meaning a permanent maintenance burden and support load. Shipping it in a signed, distributed binary is a materially different risk from running it yourself. |
| **Spotify** | **Not possible.** The Web API returns 30-second preview clips, never full audio. Full playback requires the Web Playback SDK, which is Premium-only, runs in an embedded player you cannot pipe into your own audio graph, and would bypass every feature in this app — no EQ, no crossfade, no simultaneous outputs. There is no version of this that works. |

If the goal is "play a link a friend sent me", the achievable shape is: accept
direct audio URLs and podcast feeds, and for the rest, resolve the *metadata*
from the link (artist and title) and offer to play the matching local file. That
is genuinely useful and does not put a ToS violation inside a distributed
binary.

**Cache design**, whichever sources are supported: content-addressed by URL hash,
a size ceiling as well as the two-day expiry (a ceiling is what actually stops a
cache filling a disk), swept on startup rather than on a timer, and "keep this
one" promoting a file out of the cache into the library.
