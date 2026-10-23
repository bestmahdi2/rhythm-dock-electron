# Rhythm Dock 1.7.0

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
