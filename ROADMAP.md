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

**Phase 7 is not optional.** The library is currently rebuilt from scratch on
every folder open and never persisted. Almost everything in Phases 11–14 —
play counts, smart playlists, ratings, duplicate detection, scrobbling history —
is impossible to build on top of an in-memory index that dies with the process.
If you skip Phase 7 and build the fun stuff first, you will rewrite it later.

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

---

## Phase 9 — Lyrics, properly

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
