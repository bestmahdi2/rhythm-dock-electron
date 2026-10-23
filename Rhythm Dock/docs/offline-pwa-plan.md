# Offline PWA implementation plan

Status: planned; no PWA implementation is implied by this document.
Prepared: 2026-10-23.

## Objective

Create an installable, mobile-friendly web edition of Rhythm Dock that opens and plays previously imported/downloaded music without an internet connection. Preserve the Electron desktop edition and its existing abilities. Share browser-compatible code where practical, without forcing desktop functionality into browser restrictions.

The initial target is Android Chrome, both in a browser tab and installed as a standalone PWA. Other browsers and iOS require separate validation. Installation alone does not make the app offline: the shell, metadata and audio must each be stored deliberately.

## Product contract

The first release must support:

- Installing from an HTTPS website and launching from a home-screen icon.
- Cold-launching offline after the first successful setup and shell download.
- Selecting local audio files and importing durable copies into app-owned storage.
- Offline library browsing, search, playlists, liked tracks, queue and settings.
- Offline playback, seeking, shuffle, repeat, volume and supported playback speeds.
- Local artwork and imported lyrics, including synchronized lyrics when available.
- Playback position and queue restoration after reopening; playback resumes only after a permitted user action.
- Media Session metadata and available headset, notification and lock-screen controls.
- A visible storage manager and explicit availability states for every track.
- Metadata backup/export, with a clear explanation of whether audio is included.

The first release must not claim:

- Unrestricted scanning or editing of the phone's music folders or Android media database.
- Guaranteed playback after force-stop, browser termination, reboot or every battery-management intervention.
- Native Bluetooth pairing, arbitrary device control or independent audio routing.
- Desktop codec parity, Electron APIs, Node modules or external downloader tools in the browser.
- That installing the PWA guarantees permanent storage or automatically saves every song offline.

## Recommended architecture

```text
Shared UI and browser-compatible domain logic
                    |
              Platform interface
             /                  \
Electron adapter                 Web adapter
preload / IPC                    browser APIs
filesystem / SQLite              IndexedDB / OPFS
native services                  HTMLAudioElement / Media Session
                    |
Web shell served over HTTPS + versioned service worker
```

Keep the existing Electron entry point working throughout. Suggested new locations, to confirm during the audit:

- `src/shared/`: platform-neutral models, playlist/queue rules and parsers.
- `src/renderer/js/platform/`: interface, Electron adapter and web adapter.
- `pwa/`: web entry, manifest, service worker and deployment assets.
- `tests/pwa/`: storage, offline, migration and browser integration checks.

Avoid copying the entire renderer into a second application. Extract bounded modules incrementally. An initial PWA can reuse styles and selected components without first refactoring the whole desktop app.

## Phase 0 — Audit and scope decisions

- [ ] Inventory every `window.api` call and its preload/IPC implementation.
- [ ] Classify each capability as shared, web replacement, online-only, desktop-only or deferred.
- [ ] Inspect `src/preload/index.js`, `src/renderer/js/renderer.js`, the audio modules and `src/main/services/`.
- [ ] Identify browser-safe dependencies; exclude Node filesystem, Electron, `better-sqlite3`, native tagging and child-process tools from the web bundle.
- [ ] Audit `library-store.js`, `database.js`, `lyrics.js`, `media-metadata.js`, `remote-cache.js`, `remote-playlist.js`, `room-client.js` and `playlist-formats.js` for reusable logic.
- [ ] Record target phones, Android versions, browsers and representative library sizes.
- [ ] Define the supported format list through device tests; distinguish metadata parsing support from audio decoding support.
- [ ] Decide whether the initial release includes only imported music or also first-party downloadable remote files.
- [ ] Decide the deployment origin/base path before implementing caches. Changing origins does not carry browser storage across automatically.
- [ ] Record baseline desktop checks and preserve them after shared-code changes.

Deliverable: dependency/capability matrix and agreed first-release scope.
Exit criterion: every desktop capability has an explicit web disposition; no silent deletion of abilities.

## Phase 1 — Feasibility prototype and go/no-go gate

Build a disposable but measurable vertical slice before a large port:

- [ ] Play selected local MP3, AAC/M4A, WAV and FLAC examples using an HTML audio element; record actual support.
- [ ] Save one selected track into app-owned storage and play it after closing and reopening the app offline.
- [ ] Cache a minimal shell and cold-launch it in airplane mode.
- [ ] Add Media Session handlers for play, pause, previous, next and supported seek actions.
- [ ] Test a multi-track queue with the screen locked, including automatic transitions.
- [ ] Test wired/Bluetooth headset buttons, disconnects, incoming audio interruptions and switching audio apps.
- [ ] Test installed and browser-tab behavior separately on a real Android phone.
- [ ] Measure startup time, memory where tooling allows, battery behavior and imported-audio storage overhead.
- [ ] Run a long playback session with the phone's normal battery settings and document interruptions.

Exit criterion: offline cold launch and queue playback meet agreed expectations on the target phone. If screen-locked transitions fail consistently, evaluate Capacitor plus native Media3 playback before completing the port. A service worker cannot replace an always-running native playback service.

## Phase 2 — Platform boundary and independent web build

- [ ] Define explicit interfaces for settings, library, audio sources, metadata, lyrics, import/export and media controls.
- [ ] Use stable track IDs, not absolute desktop paths, as domain identifiers.
- [ ] Keep desktop paths inside the Electron adapter; web tracks reference app-owned storage keys.
- [ ] Replace direct `window.api` calls only within the modules being ported; keep existing Electron contracts compatible.
- [ ] Provide capability flags that drive meaningful UI states and explanations.
- [ ] Use web menus/dialogs and browser file inputs; remove web reliance on native menu popups.
- [ ] Ensure the web entry does not load Electron preload assumptions or Node-only modules.
- [ ] Add separate web build/dev scripts without changing desktop packaging outputs.
- [ ] Bundle runtime dependencies, fonts and icons locally; audit CDN and network dependencies.
- [ ] Run desktop regressions after each extraction.

Exit criterion: the web shell renders and core navigation works without Electron or an active backend.

## Phase 3 — Installable shell and offline lifecycle

- [ ] Add a web app manifest: name, short name, start URL, scope, standalone display, theme/background colors and appropriate regular/maskable icons.
- [ ] Serve production over HTTPS; use localhost for development.
- [ ] Register a service worker with a scope matching the deployed app path.
- [ ] Precache the minimum complete shell: HTML, scripts, styles, icons and essential fallback assets.
- [ ] Validate all shell entries before reporting offline readiness; never cache error pages as successful assets.
- [ ] Provide offline navigation fallback only for app routes, not arbitrary API/audio requests.
- [ ] Version shell caches and keep an app-version compatibility policy.
- [ ] Add visible states: preparing offline app, ready offline, update available and update failed.
- [ ] Offer installation instructions when a browser does not expose an install prompt.
- [ ] Handle first visit without network gracefully; explain that initial setup needs a connection.
- [ ] Test deployment under its real subpath, route reloads and stale/open tabs.

Exit criterion: a fully closed installed PWA can reopen in airplane mode and render all core screens.

## Phase 4 — Storage foundation and migrations

Recommended starting design: IndexedDB for structured records; OPFS for large audio when supported, with an IndexedDB Blob fallback selected through testing. Cache Storage holds the shell and selected HTTP resources. Do not use localStorage for audio or the main library.

- [ ] Define repositories for tracks, playlists, queue, lyrics, artwork, settings, import jobs and download jobs.
- [ ] Define track fields: ID, source type, original name, MIME/container, byte size, metadata, duration, storage key, availability, creation/update timestamps and optional content fingerprint.
- [ ] Model availability explicitly: importing, ready offline, online only, downloading, missing, failed and unsupported.
- [ ] Store no temporary Blob URLs as durable identifiers; regenerate them when opening tracks and revoke them after use.
- [ ] Implement schema versions, transactional metadata migrations and compatibility checks.
- [ ] Use staged writes: write bytes, validate completion, then mark the track ready. Recover interrupted jobs and orphaned data on startup.
- [ ] Define cross-tab ownership/locking for imports, downloads, migrations and playback where supported.
- [ ] Query storage estimates and request persistent storage when appropriate; display the actual granted state.
- [ ] Handle denied persistence, quota errors, low storage, private browsing and unavailable APIs.
- [ ] Add a storage manager showing audio/artwork/cache usage estimates and per-track deletion.
- [ ] Never automatically evict user-imported or explicitly saved audio to update the shell.
- [ ] Keep a safety margin and use bounded caches for regenerable artwork and optional resources.
- [ ] Detect metadata whose audio has disappeared and offer reimport/recovery.

Exit criterion: interruption, migration and quota tests leave a recoverable library with no false offline-ready tracks.

## Phase 5 — Local import and offline library

- [ ] Implement explicit multi-file selection; directory selection is an optional enhancement only after Android compatibility testing.
- [ ] Validate size/type, handle misleading extensions and report unsupported/corrupt files per item.
- [ ] Copy selected bytes into app-owned storage so reopening does not depend on the file picker session.
- [ ] Explain that importing normally creates an additional copy; estimate required space before large batches.
- [ ] Extract metadata/artwork using a browser-compatible parser, preferably in a worker for expensive work.
- [ ] Bound concurrency and memory; avoid loading the entire library or multiple large files into RAM.
- [ ] Add progress, cancellation, partial-success reporting and recovery after interruption.
- [ ] Detect duplicates using a defined fingerprint policy; never silently overwrite tracks.
- [ ] Add library search, sort, filtering, unavailable-file recovery and accessible virtualized lists where necessary.
- [ ] Import LRC/plain lyrics; retain manual matching and show ambiguous matches.
- [ ] Implement playlists, likes, queue edits, shuffle/repeat and persistent playback positions offline.
- [ ] Support playlist import with ID mapping; mark desktop paths that cannot resolve on the phone.
- [ ] Treat tag edits as app-library metadata initially; distinguish them from rewriting original audio files.

Exit criterion: users can import a representative batch, restart offline, find tracks and play them without selecting the originals again.

## Phase 6 — Playback and phone integration

- [ ] Centralize playback in one controller using an HTML audio element as the source of truth.
- [ ] Implement play/pause, seek, next/previous, repeat, shuffle, speed and clear decode-error handling.
- [ ] Handle user-gesture/autoplay restrictions and restore state without unexpected autoplay.
- [ ] Update Media Session metadata, artwork, position and supported action handlers.
- [ ] Validate track-to-track handoff with the screen off; avoid assumptions that UI timers keep running.
- [ ] Reconcile state after background suspension, page restoration, interrupted playback and source loss.
- [ ] Keep queue/position saves bounded and include lifecycle saves without assuming unload events always run.
- [ ] Test audio focus and headphone disconnection behavior; do not claim native interruption guarantees unavailable to the browser.
- [ ] Route audio through the OS-selected device. Direct Bluetooth pairing and arbitrary device selection are outside the initial scope.
- [ ] Port equalizer/visualization only after measuring Web Audio effects on background reliability, battery and audio latency.
- [ ] Document whether gapless playback/crossfade is supported; do not promise either without measurements.
- [ ] Keep CPU-heavy lyrics/artwork/visualizer work paused or reduced when hidden without interrupting audio.

Exit criterion: the target-phone playback matrix passes and any remaining browser limitations are described in the product.

## Phase 7 — Explicit remote downloads, if included

This phase is optional for the first local-file release. Offline local imports do not require a server.

- [ ] Accept only sources that can legally and technically be downloaded by the web app.
- [ ] Verify HTTPS, CORS, authentication, MIME types and byte-range behavior for every supported source.
- [ ] Separate remote streaming from saving a complete offline copy. Listening once does not establish offline availability.
- [ ] Implement progress, cancel, retries, integrity/length checks and safe partial-file cleanup.
- [ ] Offer resumable downloads only when server range support and validators make resumption safe.
- [ ] Do not depend on long-running background downloads on every browser; state when the app must remain open.
- [ ] Mark ready offline only after a complete file is validated and metadata committed.
- [ ] Ensure local-file playback and any service-worker audio responses handle seeking/range requests correctly.
- [ ] Make authentication failures and expired signed URLs recoverable without deleting valid offline copies.
- [ ] Keep provider secrets on a server; never embed credentials in the client bundle.
- [ ] Treat YouTube/Spotify integrations and desktop yt-dlp/spotDL/FFmpeg tooling as separate feasibility work. These tools cannot simply execute inside a PWA.

Exit criterion: saved tracks play and seek from cold launch in airplane mode, including after a failed/interrupted download.

## Phase 8 — Mobile UI and complete offline experience

- [ ] Design touch-first Player, Library/Playlist and Settings screens using existing branding and abilities where supported.
- [ ] Use central lyrics/artwork with bottom playback controls and comfortable touch targets.
- [ ] Support safe areas, dynamic viewport height, keyboard opening, portrait and landscape.
- [ ] Adapt desktop Dock/Stick/window controls into mobile layouts; do not promise floating over other Android apps.
- [ ] Explain unsupported capabilities and keep desktop-only settings out of misleading web flows.
- [ ] Show offline availability per track, import/download progress and storage status.
- [ ] Keep library/lyrics/playback available when online services fail; show contextual messages for online-only actions.
- [ ] Provide offline help, import instructions, storage warnings and supported-format information.
- [ ] Check contrast, reduced motion, screen readers, focus behavior, text scaling and long/RTL filenames.
- [ ] Provide light/dark themes and persist user choices offline.

Exit criterion: a user can install, import, disconnect, play and manage storage without developer instructions.

## Phase 9 — Backup, updates and data recovery

- [ ] Define a versioned portable export format for playlists, likes, settings, metadata and lyrics.
- [ ] State clearly that metadata-only backup does not include audio.
- [ ] Evaluate optional audio-inclusive export separately: large archives can exceed mobile memory/storage; prefer streaming or bounded batches where available.
- [ ] Validate imports and migrate supported older exports; preview conflicts before merging/replacing data.
- [ ] Keep the current working version during playback; offer an update when a new shell is ready.
- [ ] Avoid forced service-worker activation/reloads during playback, import or export.
- [ ] Make schema upgrades compatible with old open tabs, or require safe coordinated closure before upgrade.
- [ ] Clean obsolete shell caches only when safe; keep user media separate from shell cache cleanup.
- [ ] Provide repair actions for interrupted migrations, missing audio, failed updates and stale service workers.
- [ ] Test browser data deletion and origin changes; explain that clearing site data removes app-owned music and metadata.

Exit criterion: upgrading or recovering the app does not unexpectedly erase imported audio or strand the library.

## Phase 10 — Security, privacy and deployment

- [ ] Choose static HTTPS hosting with correct manifest MIME type and service-worker scope/headers.
- [ ] Use content-hashed assets; ensure update checks can discover a fresh service worker and entry document.
- [ ] Add an appropriate Content Security Policy and audit third-party scripts/dependencies.
- [ ] Render filenames, lyrics and metadata as untrusted text; sanitize any supported rich content.
- [ ] Keep user-selected audio local by default; require a deliberate action before any upload/sync.
- [ ] Do not put sensitive URLs, tokens, local filenames or lyrics into analytics/logs by default.
- [ ] Avoid indiscriminate caching of authenticated API responses and account data.
- [ ] Explain local data storage, removal and any network use in a concise privacy page.
- [ ] Build reproducibly and keep environment-specific server URLs out of shared domain logic.
- [ ] Document host rollback behavior and schema constraints; rolling back JavaScript must not break newer stored data.

Exit criterion: a staging deployment works at the intended URL with no secrets or unnecessary runtime network dependencies.

## Phase 11 — Verification and release gate

Automated checks should cover meaningful failure modes, not merely mirror implementation details.

- [ ] Unit/integration: queue rules, IDs, availability transitions, import cancellation, duplicate policy, migrations, interrupted writes and quota failures.
- [ ] Browser: offline navigation/cold start, shell updates, old tabs, imported media playback and recovery from missing storage.
- [ ] Audio: supported-format fixtures, corrupt files, seeking, long tracks and repeated queue transitions.
- [ ] Network: offline, slow/flaky connection, failed API requests, interrupted downloads and reconnect.
- [ ] Security: untrusted metadata/lyrics, invalid backup files, dependency audit and unintended uploads.
- [ ] Desktop: existing Player/Playlist/Settings layout checks and relevant playback regressions after shared changes.
- [ ] Real phone: installed PWA, screen lock, app switching, Bluetooth/wired controls, calls/interruptions, battery saver and low-storage conditions.
- [ ] Storage: persistence granted/denied, app reinstall behavior, site-data clearing and metadata backup restoration.
- [ ] Accessibility: keyboard where relevant, TalkBack, large text, contrast and RTL.
- [ ] Performance: document device/browser/build, startup timings, large-list responsiveness, peak import memory where measurable and long-session battery results.

Required scenario walkthrough:

1. Visit the HTTPS app and finish offline preparation.
2. Install it, import a representative music collection and create playlists.
3. Close the app completely, enable airplane mode and relaunch from its icon.
4. Search, play, seek, skip, view lyrics and change settings.
5. Lock the screen and verify automatic transitions and headset controls.
6. Reopen, confirm position/queue restoration and export a metadata backup.
7. Simulate a failed import/download and recover without damaging existing tracks.
8. Update the app and confirm all imported media and metadata remain available.

Release gate: all required scenarios pass on the agreed Android target matrix. Publish documented exceptions rather than general claims of native equivalence.

## Phase 12 — Rollout and future decisions

- [ ] Release to a private staging URL first; test on the user's phone before public rollout.
- [ ] Collect explicit feedback on installation, import friction, storage use and background reliability.
- [ ] Fix high-impact failures before expanding browser/device support.
- [ ] Publish a supported-browser/format matrix and offline limitations.
- [ ] Keep Electron releases independent and preserve their full desktop feature set.
- [ ] Consider Capacitor/native Media3 only if measured PWA limits block required behavior.
- [ ] Consider account sync, cloud libraries, share targets, Android store packaging and iOS as later projects with separate scope.

## Implementation order and checkpoints

| Checkpoint | Phases | Reviewable outcome |
| --- | --- | --- |
| A: feasibility | 0–1 | Installed prototype proves offline storage and background queue behavior |
| B: foundation | 2–4 | Independent web build, offline shell and recoverable storage |
| C: useful offline player | 5–6 | Local imports, library, queue, lyrics and media controls |
| D: polished mobile app | 8–10 | Mobile screens, backup/update safety and staging deployment |
| E: release | 11–12 | Real-phone acceptance results and controlled rollout |
| Optional remote media | 7 | Explicit verified offline downloads from supported sources |

Do not estimate the full port until Checkpoint A and the API inventory are complete. Record decisions and remaining limitations at each checkpoint. Review each major mobile screen before proceeding to the next, consistent with the desktop redesign workflow.

## Primary references and revalidation

Browser support and platform policies change. Recheck these sources when implementation begins rather than treating this plan as a permanent compatibility guarantee:

- [Offline caching and service workers](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Caching)
- [Offline and background operation](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation)
- [Web app manifests](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest)
- [Storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
- [Origin private file system](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
- [User-selected local files](https://developer.mozilla.org/en-US/docs/Web/API/File_API/Using_files_from_web_applications)
- [Media Session API](https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API)
- [Chrome media controls](https://developer.chrome.com/blog/media-session)
- [Web Bluetooth limitations](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API)
- [Native Android background playback fallback](https://developer.android.com/media/media3/session/background-playback)
