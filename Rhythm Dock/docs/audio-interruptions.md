# Automatic pause

Settings → Playback has independent controls for active-headphone disconnection, system audio interruptions, and computer sleep. These default to enabled for new preferences; existing saved choices are respected. Interruption pauses retain the playback position and work while the player controls are locked. Recovery, reconnecting and waking the computer do not automatically resume playback.

## Removing earbuds from your ears

This is different from disconnecting Bluetooth. If the earbuds' wear detection sends a media-pause command to the computer, Rhythm Dock handles it through the system media session or the accessory's pause app command. Enable wear detection in the earbuds' companion app where available.

There is no universal Electron interface for directly reading every earbud brand's in-ear sensor. If the earbuds remain connected and emit no pause signal, their physical removal cannot be inferred from the output-device list. The app does not pretend that an ordinary device-disconnect event detects that case.

## Calls and alarms

- Windows: a bundled, hidden helper subscribes to Windows Core Audio communications-ducking notifications. When a call opens a communications audio stream and Windows sends the notification, the player pauses. The helper re-registers when the default output devices change and reports its status in Settings. It does not record audio or request microphone access.
- All platforms: explicit media pause/stop commands and exposed AudioContext/Audio Session interruption events pause playback. The optional Audio Session API is feature-detected; its presence is not assumed in Electron.
- Computer sleep uses Electron's system-suspend event, independently of the call setting.

An app playing an alarm or call sound does not necessarily emit a shared interruption event. Some calling applications manage their own audio mixing. Those cases cannot be detected reliably with these signals, particularly on macOS/Linux where this build has no native call watcher. Merely opening another app, adding an unused audio device or returning focus to the player does not pause/resume playback.

The Windows helper uses local source bundled with the app. Native sources are unpacked from ASAR so PowerShell can compile the Core Audio interop. A blocked/unavailable helper is reported in Settings while the other pause mechanisms remain available.
