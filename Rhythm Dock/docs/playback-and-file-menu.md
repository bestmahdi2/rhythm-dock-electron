# Opening tracks and queue mode

Opening the loaded track again restarts it. Other tracks resume their saved position when their duration is at least five minutes, more than ten seconds have elapsed, and more than ten seconds remain. Positions are saved per file, including MP3s, podcasts and remixes.

Enable **Queue mode** in Settings to add files opened through the file manager, Open Files, folders or drag-and-drop to Play Next without starting playback. Multi-file selections retain their supplied order. Turn it off to play opened files immediately. The setting persists across launches.

# File-manager menu

In Settings, select **Install “Add to Rhythm Dock Queue” File Menu**. This installs a menu for the current user and the current application location. Use **Remove File Menu** to undo it. Reinstall after moving the application.

- Windows Explorer: right-click supported audio files. Windows 11 may put the command under **Show more options**.
- macOS Finder: right-click audio files and select the command in **Services** or **Quick Actions**. macOS may require enabling the service in Keyboard settings.
- Linux Dolphin: the command appears in the file context menu. Nautilus and Nemo expose it under **Scripts**. Restart the file manager if necessary. Other file managers are not currently integrated.

The menu adds files to Play Next even when queue mode is disabled. Linux scripts filter selected paths by supported extension; the app also filters launch arguments on every platform.

# Lyrics

The Lyrics menu includes **Export Lyrics**, **Enable/Disable Text Selection** and **Enable/Disable Auto Scroll**. Synced lyrics export as LRC with their original timestamps; plain lyrics export as UTF-8 text. Selection and scrolling preferences persist independently. Disabling auto-scroll keeps lyric highlighting active and lets you scroll manually.

Native Finder and Linux file-manager menu registration still needs validation on those operating systems. The generated shell commands are covered by automated execution tests.
