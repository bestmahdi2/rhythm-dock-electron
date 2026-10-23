# File type icons

All 19 supported extensions have a distinct color, symbol and visible file-type label:
MP3, M4A, M4B, FLAC, WAV, OGG, OPUS, AAC, WMA, AIFF, MP4, APE, WV, DSF, DFF, MOD, XM, IT and S3M.

`npm run icons` regenerates the PNG, Windows ICO, macOS ICNS and Linux MIME icon assets. Windows ICO files contain separately rendered 16, 24, 32, 48, 64, 128 and 256 pixel frames. The smallest sizes use a simplified tile with a larger label.

Install the rebuilt app and choose Rhythm Dock as the default player for the desired extensions. Windows and macOS file associations point to the corresponding icon. The Windows portable executable does not install file associations; use the installer for this integration. Explorer/Finder may need to refresh their cached icons after an upgrade.

Linux DEB/RPM packages install per-format MIME definitions, icons and desktop associations, and refresh the MIME/icon databases. On Linux, document icons follow MIME types rather than the selected default application; a desktop theme or file-thumbnail preview can also affect the displayed icon. AppImage/tar archives do not automatically install system MIME definitions or file icons.

Generated assets are kept in `build/icons` and are recreated automatically by the packaging commands. Run `node tests/file-icons.test.js` to validate extension coverage, file associations, ICO frames and package configuration.
