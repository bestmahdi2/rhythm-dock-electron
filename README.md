# Rhythm Dock

> A lightweight, feature-rich music player built with Electron.

Rhythm Dock is a compact, minimal music player designed to stay out of your way while providing powerful features like synced lyrics, playlist management, and multiple layouts.

---

## Download & Installation

You can download the latest version for Windows from the GitHub Releases page.

[**➡️ Download Latest Release**](https://github.com/bestmahdi2/rhythm-dock-electron/releases/latest)

Simply download the `.exe` installer for your system (either `x64` for 64-bit or `ia32` for 32-bit) and run it.

---

## Features

- **Broad Format Support**: Plays a variety of audio formats including MP3, WAV, FLAC, and M4A.
- **Flexible Music Loading**:
    - Open individual files or entire folders.
    - Drag-and-drop files and folders directly onto the player.
- **Rich Lyric Support**:
    - Automatically fetches and displays synced (LRC) lyrics from lrclib.net.
    - Reads lyrics embedded in the audio file's metadata.
    - Caches lyrics in a local database for instant offline access.
    - Manually adjust lyrics timing with an offset control.
- **Advanced Playback Controls**:
    - Standard controls: Play, Pause, Next, Previous.
    - Shuffle playlist.
    - Loop modes: Off, Loop All, and Loop Single Track.
- **Dynamic User Interface**:
    - **Switchable Layouts**: Instantly toggle between a standard horizontal view and a compact vertical view.
    - **Always-on-Top**: Pin the window to keep it visible above all other applications.
- **Deep System Integration**:
    - **Taskbar Media Controls**: Control playback directly from the Windows taskbar.
    - **Global Media Keys**: Use your keyboard's media keys (Play/Pause, Next, Previous) to control the player even when it's in the background.
    - **File Association**: Set Rhythm Dock as the default player for `.mp3` files.

## Technology Stack

- **Framework**: [Electron](https://www.electronjs.org/)
- **Audio Engine**: [Howler.js](https://howlerjs.com/)
- **Metadata Parsing**: [music-metadata](https://github.com/Borewit/music-metadata)
- **Database**: [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) for lyrics caching
- **Settings Persistence**: [electron-store](https://github.com/sindresorhus/electron-store)
- **Packaging**: [electron-builder](https://www.electron.build/)

---

## Development Setup

To run the project locally, follow these steps:

1.  **Clone the repository:**
    ```bash
    git clone <your-repository-url>
    cd rhythm-dock-electron
    ```

2.  **Install dependencies:**
    This command will also trigger the `postinstall` script to correctly configure native dependencies for Electron.
    ```bash
    npm install
    ```

3.  **Run the application in development mode:**
    ```bash
    npm start
    ```

4.  **Build the application for distribution:**
    The following commands will create installers in the `dist/` directory.

    - **Build for both 32-bit and 64-bit Windows:**
      ```bash
      npm run dist:win
      ```

    - **Build for your current architecture only (e.g., just 64-bit):**
      ```bash
      npm run dist
      ```

## License

This project is licensed under the ISC License. See the [LICENSE](LICENSE) file for details.