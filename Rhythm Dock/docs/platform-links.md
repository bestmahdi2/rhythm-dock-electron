# YouTube, YouTube Music and Spotify track links

Paste a link in Playlists. **Play Link** downloads a tagged MP3 to temporary storage and plays it; **Add Link** adds it at the selected queue position. Queue mode keeps Play Link from interrupting playback. Reopening the same YouTube/YouTube Music video reuses its cache entry.

Spotify accepts individual `open.spotify.com/track/…` links. spotDL reads the song metadata and finds audio on YouTube. It does not extract Spotify's audio, and a match may differ from the Spotify recording. No personal API credentials are requested. Private, unavailable or sign-in-only content may fail.

**Download MP3…** saves the last imported link (or current cached track after restarting) to a location you choose. Platform downloads embed provider-supplied title, artist, album and artwork when available. Saving an existing MP3 copies it without transcoding or stripping its tags. Converting direct audio links preserves their existing metadata. Missing provider metadata cannot be invented; encoding to MP3 cannot increase the original recording's audio quality.

**Save Current Link** keeps the current cached track in the app's permanent library. Temporary platform downloads are limited to 200 MB each and the platform cache to 512 MB, with two-day expiry during cleanup. Currently playing files are protected during cleanup. **Cancel Link** cancels the active link operation.

## Free tools

Install current versions of these tools on PATH, or use **Settings → YouTube & Spotify links** to choose installed yt-dlp and spotDL executables. FFmpeg can be selected in Audio tools. **Check Link Tools** checks all four dependencies.

- [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation): YouTube and YouTube Music extraction. Official standalone binaries include the EJS challenge solver.
- [spotDL](https://github.com/spotDL/spotify-downloader#installation): Spotify metadata and matching YouTube audio. Standalone binaries or `pip install --upgrade spotdl` are supported; select the actual executable, not a shell script.
- [FFmpeg](https://ffmpeg.org/download.html): MP3 conversion and artwork/metadata embedding.
- [Deno](https://docs.deno.com/runtime/getting_started/installation/): yt-dlp's recommended JavaScript runtime for YouTube challenges. It must be on PATH; restart Rhythm Dock after installing it.

Provider behavior changes over time. Update yt-dlp and spotDL when downloads fail. These external tools are invoked without a shell; the app does not silently install executable downloads, read browser cookies or request account credentials.

## A–B repeat

Click A–B once to mark A at the current position. Click again to set B and repeat that range. The progress bar shows A/B markers and a theme-derived highlighted range above the normal playback fill. Click a third time to clear the loop. Opening another track clears an unfinished A marker.
