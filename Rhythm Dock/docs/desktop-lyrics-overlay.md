# Desktop lyrics overlay

Open **Lyrics → Desktop overlay** to show lyrics over other applications.

- The previous, current and next synchronized lines are displayed together. Before the first timestamp, the track title is shown with the upcoming line below it.
- Lyric timing and transport state continue updating while the player is minimized or hidden in the tray.
- Play/pause follows the actual playback state. A new track clears the previous track's lyrics immediately while new lyrics load.
- Drag the plate to move it. Drag the bottom-right handle to resize it; position and size are remembered.
- Lock makes the lyrics click-through. Hover the toolbar to use its controls and click Lock again to unlock. Escape also unlocks when the overlay has keyboard focus.
- In **Settings → Lyrics**, type or select an installed font. B Nazanin and IRANSansX are pinned shortcuts; they must be installed on the computer to render. Font choices and typography are saved in SQLite and shared with the main lyrics views.
- Font enumeration uses the operating system: Windows installed font families, macOS font information or Linux fontconfig. Manual font entry remains available if enumeration fails.

Untimed lyrics have no timestamp-based previous/next progression. The overlay initially shows the first lines; synchronized LRC is needed for timed progression.

Verification: `npm run test:lyrics-overlay` tests renderer state, hidden/minimized timing, native click-through recovery, saved geometry, OS fonts and SQLite preferences. `npm run test:db-migration` verifies schema migration and preference persistence across reopening. Real desktop pointer interaction and playback on other operating systems should also be checked before release.
