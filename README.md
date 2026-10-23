# Rhythm Dock

> A compact, feature-rich desktop music player built with Electron.

Rhythm Dock is a dock-sized player that stays out of your way: a 380x180 strip
with album art, transport, and live synced lyrics. When you need more, it
expands into a library, a tag editor, and a settings panel - then folds back
down.

Runs on **Windows**, **macOS**, and **Linux** (Ubuntu/Debian, Fedora/RHEL, and
anything that runs an AppImage).

---

## Download

[**Latest release**](https://github.com/bestmahdi2/rhythm-dock-electron/releases/latest)

| Platform | File | Notes |
| --- | --- | --- |
| Windows 10/11 | `Rhythm Dock Setup <version>-x64.exe` | One-click installer. `-ia32` for 32-bit. |
| Windows (no install) | `Rhythm Dock Portable <version>-x64.exe` | Runs from anywhere; settings still go to `%APPDATA%`. |
| macOS (Apple Silicon) | `Rhythm Dock-<version>-arm64.dmg` | See *Unsigned builds* below. |
| macOS (Intel) | `Rhythm Dock-<version>-x64.dmg` | See *Unsigned builds* below. |
| Ubuntu / Debian | `Rhythm Dock-<version>-x64.deb` | `sudo apt install ./Rhythm*.deb` |
| Fedora / RHEL | `Rhythm Dock-<version>-x64.rpm` | `sudo dnf install ./Rhythm*.rpm` |
| Any Linux | `Rhythm Dock-<version>-x64.AppImage` | `chmod +x` then run. No root needed. |

### Unsigned builds

The releases are not code-signed, because signing certificates cost money and
this is a hobby project. Each OS reacts differently:

- **macOS** quarantines the app. After dragging it to Applications:
  ```bash
  xattr -dr com.apple.quarantine "/Applications/Rhythm Dock.app"
  ```
- **Windows** shows a SmartScreen warning. *More info -> Run anyway*.
- **Linux** does not care.

---

## Features

### Playback
- MP3, M4A, FLAC, WAV, OGG, Opus, AAC, WMA, AIFF, and MP4 audio.
- Open files or whole folders; drag and drop anywhere on the window.
- Shuffle, and three loop modes (off / all / single).
- Playback speed from 0.5x to 2x, adjustable by scrolling the speed pill or
  with `[` and `]`.
- 10-band equalizer with presets and a preamp.
- Volume boost past 100% for quiet recordings.
- Auto-pause when headphones are unplugged.
- Sleep timer, with an option to let the current song finish first.

### Lyrics
- Five sources, tried in order until one has the song: an `.lrc` file beside the
  track, lyrics embedded in its tags, [lrclib.net](https://lrclib.net), NetEase
  (much better coverage of CJK repertoire), and Genius for matching.
- **Tap-to-sync editor.** Play the track, tap on each line, get a timed LRC.
  Save it to the library, beside the file as `.lrc`, or into the tags - your
  work survives a library reset or a move to another player.
- **Word-level karaoke** for enhanced LRC files: the highlight moves within the
  line, not just between lines.
- **Full-screen mode** - large type over blurred album art, no chrome (`F`).
- **Desktop overlay** - a borderless always-on-top strip that floats over other
  applications and shows the current line, with optional click-through.
- Typography settings: font, size, weight, alignment and line spacing, applied
  everywhere lyrics appear. Matters a great deal for CJK and RTL scripts.
- Cached locally in SQLite, so a track you have played once works offline.
- Per-track timing offset in 0.1s steps, remembered per song.
- Live translation (Google, or your own LibreTranslate instance), cached per
  song and language, with proper right-to-left rendering for Arabic and Persian.
- Manual scroll mode when you want to read ahead.

### Library
- Recursive folder scanning with artist/title resolution that scores evidence
  from the tags, the filename, the folder name, *and* sibling filenames - the
  last of these is what makes `03. Artist - Title [320kbps].mp3` resolve
  correctly.
- Fuzzy search across artists and songs.
- Liked songs, and per-folder exclusions.

### Tag editor
- Edit title, artist, album artist, album, track/disc numbers, year, genre and
  comment.
- Replace or remove embedded album art.
- Writes MP3, FLAC, M4A/MP4, OGG, Opus, WAV, AIFF and WMA.
- Writes go through a temp file and an atomic rename, so an interrupted save
  cannot corrupt your music.

### Interface
- **10 themes** - five dark (Midnight, Graphite, Ocean, Plum, Ember) and five
  light (Daylight, Paper, Sky, Sand, Rose).
- Horizontal dock or narrow vertical strip.
- Adjustable window opacity, always-on-top pinning, minimise to tray.
- Album art magnifier on hover.
- Full keyboard control, with `Esc` backing out one layer at a time.

### System integration
- Global media keys and taskbar transport controls.
- File associations for every supported audio format, on all three platforms.
- Tray icon that adapts to light and dark system themes.

### Listen together
- Host a room and share a six-character code; guests follow your playback,
  lyrics and theme in real time.
- Optional room password, and a toggle for whether guests can control playback.
- Requires the companion server in [`server/`](./server) - see
  [docs/SERVER-SETUP.md](./docs/SERVER-SETUP.md).

---

## Building from source

### Prerequisites

| Requirement | Why |
| --- | --- |
| Node.js 20+ | Runtime and build tooling. |
| Python 3.9+ | `node-gyp`, for the native dependency. |
| A C++ toolchain | Same. MSVC Build Tools on Windows, Xcode CLT on macOS, `build-essential` on Linux. |

**`better-sqlite3` is a native module.** This is the single most important
constraint on the build: it must be compiled against the exact Electron
version and target architecture. That means **electron-builder cannot
cross-compile** - a Windows installer has to be produced on Windows, a `.dmg`
on macOS, and so on. The [GitHub Actions workflow](./.github/workflows/release.yml)
does this with a three-runner matrix; do the same locally, or just push a tag.

### Setup

```bash
git clone https://github.com/bestmahdi2/rhythm-dock-electron.git
cd "rhythm-dock-electron/Rhythm Dock"

make install     # or: npm install
make start       # or: npm start
```

`make help` lists every target. `make doctor` reports which build tools are
missing on your machine.

### Packaging

Output lands in `dist/`.

```bash
make             # build for the platform you are on

make win         # Windows: NSIS installer (x64 + ia32) and a portable exe
make win64       #   x64 only
make win32       #   ia32 only

make mac         # macOS: dmg + zip, both architectures
make mac-arm64   #   Apple Silicon only
make mac-x64     #   Intel only

make linux       # Linux: AppImage + deb + rpm + tar.gz
make appimage    #   AppImage only
make deb         #   Debian/Ubuntu only
make rpm         #   Fedora/RHEL only
```

The equivalent npm scripts (`npm run dist:win`, `dist:mac`, `dist:linux`, ...)
work identically if you would rather not use `make`.

### Platform-specific build notes

**Windows.** Nothing unusual. If `npm install` fails on `better-sqlite3`,
install the *Desktop development with C++* workload from the Visual Studio
Build Tools and retry.

**macOS.** `make mac` builds both architectures, but the arm64 slice needs a
native rebuild that an Intel host cannot produce and vice versa. On a single
machine, prefer `make mac-arm64` or `make mac-x64`. Builds are unsigned;
`CSC_IDENTITY_AUTO_DISCOVERY=false` is set in CI so electron-builder does not
try to notarise and fail the job.

**Linux.** The `rpm` target needs `rpmbuild` on the *build* host even when you
are on Debian or Ubuntu:

```bash
# Debian / Ubuntu
sudo apt install rpm libarchive-tools fakeroot

# Fedora
sudo dnf install rpm-build fakeroot
```

Runtime dependencies for the deb and rpm packages are declared in
`package.json` and pulled in automatically on install. The AppImage bundles
everything and needs none of them.

---

## Project layout

```
Rhythm Dock/
|- Makefile              Build entry points
|- src/
|  |- main/              Electron main process
|  |  |- index.js        Entry point, app lifecycle, IPC surface
|  |  |- core/           paths.js, shortcuts.js
|  |  |- services/       database.js, translate.js, room-client.js
|  |  |- windows/        tray.js, window-state.js
|  |  |- library/        Scanning, metadata resolution, tag read/write
|  |- preload/
|  |  |- index.js        The renderer's only bridge to the system
|  |- renderer/
|  |  |- index.html      Markup for every panel
|  |  |- vertical.html   Compact vertical layout
|  |  |- overlay.html    Desktop lyrics strip (its own window)
|  |  |- styles/         Design tokens and all ten themes
|  |  |- js/             UI logic, plus audio/ (engine, equalizer, devices)
|  |- assets/            Bundled images and icons
|- scripts/              Icon generation

server/                  Optional "listen together" relay
docs/                    ROADMAP.md, PHASES.md, SERVER-SETUP.md
tools/                   Repo maintenance scripts (PowerShell / Python)
```

---

## Technology

- [Electron](https://www.electronjs.org/) - application shell
- [music-metadata](https://github.com/Borewit/music-metadata) - tag reading
- [node-taglib-sharp](https://github.com/benrr101/node-taglib-sharp) - tag writing
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) - lyrics cache
- [electron-store](https://github.com/sindresorhus/electron-store) - settings
- [ws](https://github.com/websockets/ws) - room transport
- [electron-builder](https://www.electron.build/) - packaging

---

## License

ISC. See [license.md](./license.md).

### Supported files

- Audio: MP3, AAC, M4A/M4B/MP4 (AAC or ALAC), FLAC, WAV, Ogg Vorbis, Opus and WebM.
- FFmpeg decoding: WMA, AIF/AIFF, APE, WavPack (WV), Musepack (MPC), TTA, TAK,
  Matroska audio (MKA), DSD (DSF/DFF), and tracker modules (MOD/XM/IT/S3M).
  ALAC in M4A/M4B/MP4 also uses FFmpeg. Tracker modules require a build with libopenmpt.
- MIDI (.mid/.midi): choose FluidSynth and an SF2/SF3 SoundFont in Settings > Audio tools.
  MIDI is rendered into the playback cache, so the normal seek, volume and audio-output controls work.
- Playlists: M3U/M3U8, PLS and XSPF, including all supported local audio extensions.
  Open or drop these files, or import them as saved playlists.
- CUE sheets: open or drop a CUE file to load its referenced local audio; its track indexes
  appear in chapter navigation and can be queued individually.
- Lyrics: matching LRC or TXT sidecars, plus Import Lyrics in the lyrics menu. Imported
  text opens in the editor for review before saving. Synced LRC takes priority over TXT.

Extended decoding requires an installed FFmpeg executable (Settings > Audio tools or PATH).
The source files are preserved. Tag writing remains restricted to formats the tag editor can safely write;
playback support does not imply writable tags. Video containers are played as audio.
