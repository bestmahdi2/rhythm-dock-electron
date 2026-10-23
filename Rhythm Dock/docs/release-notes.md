# Rhythm Dock 1.7.3

- Redesigned Player, Playlist and Settings for horizontal, vertical, compact dock and screen-edge layouts while retaining existing controls and behavior.
- Added eight Settings categories with back navigation, expandable sections and access to existing advanced tools.
- Improved playlist browsing, queue metadata and durations, filtering, sorting and accessible queue reordering.
- Removed obsolete artwork, PNG controls, the unused Howler bundle and the superseded standalone vertical page.
- Added layout and control-preservation checks for the three main tabs.

## Previous changes — 1.7.2

- Expanded architecture coverage: Windows x64/x86/ARM64; macOS Intel/Apple Silicon; Linux x64/ARM64.
- Fixed Linux package verification to use electron-builder's per-format architecture names.
- ARM build tools: Windows ARM64 packages are cross-built on Windows x64; Linux ARM64 uses native Ruby/FPM rather than the builder's bundled x86 executable.

- Guided Windows setup with installation-folder selection and a short getting-started guide.
- Installer and portable packages for Windows; DMG and ZIP for macOS Intel/Apple Silicon; DEB/RPM and AppImage/tar.gz for Linux.
- Existing library databases and settings remain outside the installation folder. Schema upgrades stop if their safety backup fails. Uninstall preserves user data.
- Faster progressive playback for large supported audio files, per-track resume, queue mode, playlist search/filter/sort, All Songs, and visible unavailable-track warnings.
- Lyrics export, selectable text, independent auto-scroll, theme-colored A–B ranges, and current-playlist context.
- Improved volume/artwork popovers, readable hover opacity, close-to-tray, platform playback controls and available interruption signals.
- Distinct labeled file icons for all supported formats.
- Cached YouTube/YouTube Music links through yt-dlp, Spotify track matching through spotDL, and tagged MP3 saving. External downloader tools are required.

## Packages

Windows: use **Setup** for guided installation and file associations, or **Portable** to run without installation. macOS: use the DMG to drag the app into Applications or unpack the ZIP. Linux: install DEB/RPM for desktop integration or run AppImage/extract tar.gz.

Builds are unsigned. macOS packages are not notarized. Database protections apply to installer operations and tested migrations; keep personal backups as usual.

Each platform includes a SHA256SUMS file. Every push produces workflow artifacts. A new version pushed to master publishes a GitHub Release only after all builds and validation pass. Existing release tags are never moved to a different commit.

The workflow reserves a new version tag before building, while the source commit is still the head of master. Publishing uses that existing tag (`--verify-tag`) so a later push cannot cause GitHub's workflow-file permission check to reject tagging the older build. Failed builds can leave a reserved tag without a release; rerun the same commit to retry, or bump the version for corrected source. The workflow never retargets a tag or publishes packages built from a different commit.

| OS | CPU | Packages |
| --- | --- | --- |
| Windows | x64, x86 (ia32), ARM64 | Guided Setup EXE + Portable EXE |
| macOS | Intel x64, Apple Silicon ARM64 | DMG + ZIP |
| Linux | x64, ARM64 | DEB + RPM + AppImage + tar.gz |

Linux 32-bit x86 and macOS 32-bit builds are not available in this Electron version. ARM64 builds require a 64-bit OS; 32-bit ARM/ARMv7 is not included in this matrix. Package names follow native conventions: x64 Linux DEBs use amd64 and RPM/AppImage use x86_64; ARM64 RPMs use aarch64. Other ARM64 packages use arm64.
