// --- State Variables ---
// The engine instance. `currentSound` remains as an alias so the many existing call
// sites that do currentSound.seek()/.duration()/.play()/.pause() keep working — the
// engine deliberately exposes a Howler-compatible surface for those four methods.
const audio = window.RhythmAudio.engine;
const AUDIO_STATE = window.RhythmAudio.STATE;

let currentSound = null;
let currentSongData = null;
let playlist = [];
let originalPlaylist = [];
let currentIndex = -1;
let isPlaying = false;
let timeDisplayMode = 'remaining';
let isMuted = false;
let loopMode = 'none';
let isShuffled = false;
let lyrics = {isSynced: false, lines: []};
let favoritesPlaylist = [];
let isMagnifierEnabled = true;
let lastActiveLyricIndex = -1;
let lyricsOffsets = {};
let loadTicket = 0;
let currentLyricsOffset = 0;
let playbackVolume = 1.0;
let areLyricsVisible = true;
let volumeOverlayTimeout = null;
let areLyricsControlsVisible = true;
let isManualScrollEnabled = false;
let playbackRate = 1.0;
let isSeeking = false;
let isPlaylistVisible = false;
let currentExclusions = [];
let searchDebounce = null;
let minimizeToTray = false;
let activeTab = 'player';

// Feature modules built on the Phase 2 audio graph.
const equalizer = new window.RhythmEQ.Equalizer(audio);
const sleepTimer = new window.RhythmTimer.SleepTimer({
    engine: audio,
    onTick: (remaining) => renderTimer(remaining),
    onFinish: (reason) => onTimerFinished(reason),
});
const outputWatcher = new window.RhythmDevices.OutputDeviceWatcher({
    isPlaying: () => audio.isPlaying(),
    onDisconnect: () => {
        audio.pause();
        setPlaylistStatus('Paused - headphones disconnected');
    },
});

// Translation state for the currently displayed lyrics.
let translationLanguage = 'en';
let showTranslation = false;
let translatedLines = null;

// Room / streaming state.
let room = {connected: false, isHost: false, code: null, serverUrl: null, members: []};
let roomPublishTimer = null;

// --- Get references to ALL UI elements (Single Source of Truth) ---
const containerEl = document.getElementById('container');
const albumArtEl = document.getElementById('album-art');
const filenameEl = document.getElementById('filename');
const titleEl = document.getElementById('title');
const artistEl = document.getElementById('artist');
const progressBar = document.getElementById('progress-bar');
const playPauseBtn = document.getElementById('play-pause-btn');
const playIcon = document.getElementById('play-icon');
const pauseIcon = document.getElementById('pause-icon');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const volumeBtn = document.getElementById('volume-btn');
const volumeIcon = document.getElementById('volume-icon');
const volumeMuteIcon = document.getElementById('volume-mute-icon');
const volumeSlider = document.getElementById('volume-slider');
const openFileBtn = document.getElementById('open-file-btn');
const openFolderBtn = document.getElementById('open-folder-btn');
const timeCurrentEl = document.getElementById('time-current');
const timeRemainingEl = document.getElementById('time-remaining');
const pinBtn = document.getElementById('pin-btn');
const minimizeBtn = document.getElementById('minimize-btn');
const closeBtn = document.getElementById('close-btn');
const shuffleBtn = document.getElementById('shuffle-btn');
const loopBtn = document.getElementById('loop-btn');
const loopOffIcon = document.getElementById('loop-off-icon');
const loopAllIcon = document.getElementById('loop-all-icon');
const loopOneIcon = document.getElementById('loop-one-icon');
const likeBtn = document.getElementById('like-btn');
const copyPathBtn = document.getElementById('copy-path-btn');
const showFileBtn = document.getElementById('show-file-btn');
const lyricsContainer = document.getElementById('lyrics-container');
const lyricsOffsetMinusBtn = document.getElementById('lyrics-offset-minus-btn');
const lyricsOffsetPlusBtn = document.getElementById('lyrics-offset-plus-btn');
const lyricsOffsetDisplay = document.getElementById('lyrics-offset-display');
const lightModeBtn = document.getElementById('light-mode-btn');
const lightModeLabel = document.getElementById('light-mode-label');
const orientationBtn = document.getElementById('orientation-btn');
const orientationLabel = document.getElementById('orientation-label');
const volumeBoostBtn = document.getElementById('volume-boost-btn');
const volumeBoostLabel = document.getElementById('volume-boost-label');
const settingsDrawer = document.getElementById('settings-drawer');
const openTransparencyBtn = document.getElementById('settings-transparency-btn');
const closeDrawerBtn = document.getElementById('close-settings-drawer-btn');
const goToGithubBtn = document.getElementById('go-to-github-btn');
const aboutMeBtn = document.getElementById('about-me-btn');
const transparencySlider = document.getElementById('transparency-slider');
const transparencyValue = document.getElementById('transparency-value');
const versionMenuDisplay = document.getElementById('version-menu-display');
const toggleLyricsBtn = document.getElementById('toggle-lyrics-section-btn');
const toggleLyricsLabel = document.getElementById('toggle-lyrics-label');
const toggleControlsBtn = document.getElementById('toggle-lyrics-controls-btn');
const toggleControlsLabel = document.getElementById('toggle-lyrics-controls-label');
const toggleManualScrollBtn = document.getElementById('toggle-manual-scroll-btn');
const manualScrollLabel = document.getElementById('manual-scroll-label');
const refetchLyricsBtn = document.getElementById('refetch-lyrics-btn');
const toggleMagnifierBtn = document.getElementById('toggle-magnifier-btn');
const toggleMagnifierLabel = document.getElementById('toggle-magnifier-label');
const magnifiedAlbumArtEl = document.getElementById('magnified-album-art');
const volumeOverlay = document.getElementById('volume-overlay');
const volumeOverlayText = document.getElementById('volume-overlay-text');
const lyricsControls = document.querySelector('.lyrics-controls');
const progressWrapper = document.getElementById('progress-wrapper');
const progressBuffered = document.getElementById('progress-buffered');
const speedBtn = document.getElementById('speed-btn');
const speedLabel = document.getElementById('speed-label');
const speedMenu = document.getElementById('speed-dropdown-menu');
const playlistPanel = document.getElementById('playlist-panel');
const playlistResults = document.getElementById('playlist-results');
const playlistStatus = document.getElementById('playlist-status');
const librarySearchInput = document.getElementById('library-search-input');
const closePlaylistBtn = document.getElementById('close-playlist-btn');
const togglePlaylistBtn = document.getElementById('toggle-playlist-btn');
const togglePlaylistLabel = document.getElementById('toggle-playlist-label');
const playFavoritesBtn = document.getElementById('play-favorites-btn');
const copyFilenameBtn = document.getElementById('copy-filename-btn');
const copyTagsBtn = document.getElementById('copy-tags-btn');
const copyFolderPathBtn = document.getElementById('copy-folder-path-btn');
const openFileExternalBtn = document.getElementById('open-file-external-btn');
const openFolderExternalBtn = document.getElementById('open-folder-external-btn');
const deleteFileBtn = document.getElementById('delete-file-btn');
const excludeTrackBtn = document.getElementById('exclude-track-btn');
const excludeTrackLabel = document.getElementById('exclude-track-label');
const minimizeTrayBtn = document.getElementById('minimize-tray-btn');
const minimizeTrayLabel = document.getElementById('minimize-tray-label');
const hideToTrayBtn = document.getElementById('hide-to-tray-btn');
const tabPager = document.getElementById('tab-pager');
const settingsTab = document.getElementById('tab-settings');
const eqEnabledEl = document.getElementById('eq-enabled');
const eqPresetEl = document.getElementById('eq-preset');
const eqBandsEl = document.getElementById('eq-bands');
const eqPreampEl = document.getElementById('eq-preamp');
const eqPreampValueEl = document.getElementById('eq-preamp-value');
const timerReadoutEl = document.getElementById('timer-readout');
const timerPresetsEl = document.getElementById('timer-presets');
const timerCustomEl = document.getElementById('timer-custom');
const timerStartBtn = document.getElementById('timer-start');
const timerCancelBtn = document.getElementById('timer-cancel');
const timerFinishTrackEl = document.getElementById('timer-finish-track');
const translateLanguageEl = document.getElementById('translate-language');
const translateProviderEl = document.getElementById('translate-provider');
const translateEndpointEl = document.getElementById('translate-endpoint');
const translateToggleBtn = document.getElementById('translate-toggle-btn');
const pauseOnUnplugEl = document.getElementById('pause-on-unplug');
const roomStatusEl = document.getElementById('room-status');
const roomSetupEl = document.getElementById('room-setup');
const roomActiveEl = document.getElementById('room-active');
const roomServerEl = document.getElementById('room-server');
const roomSecretEl = document.getElementById('room-secret');
const roomNameEl = document.getElementById('room-name');
const roomPasswordEl = document.getElementById('room-password');
const roomEveryoneControlsEl = document.getElementById('room-everyone-controls');
const roomHostBtn = document.getElementById('room-host-btn');
const roomJoinCodeEl = document.getElementById('room-join-code');
const roomJoinBtn = document.getElementById('room-join-btn');
const roomCodeValueEl = document.getElementById('room-code-value');
const roomCopyLinkBtn = document.getElementById('room-copy-link');
const roomMembersEl = document.getElementById('room-members');
const roomLeaveBtn = document.getElementById('room-leave-btn');

/**
 * Renders the transport state onto the UI. This is the ONLY place the play/pause icon
 * and the `isPlaying` flag are updated, which is what stops them desynchronising from
 * actual playback (#11).
 */
function renderTransport() {
    isPlaying = audio.isPlaying();
    updatePlayPauseIcon();
    reportPlaybackState();

    containerEl.classList.toggle('is-loading', audio.state === AUDIO_STATE.LOADING);
    containerEl.classList.toggle('is-ended', audio.state === AUDIO_STATE.ENDED);
}

/**
 * Updates the speed control label and the tick beside the active preset.
 */
function updateSpeedUI() {
    if (speedLabel) speedLabel.textContent = `${playbackRate.toFixed(2).replace(/0$/, '')}x`;
    if (speedBtn) speedBtn.classList.toggle('active', playbackRate !== 1.0);
    if (!speedMenu) return;
    speedMenu.querySelectorAll('[data-rate]').forEach((item) => {
        item.classList.toggle('active', parseFloat(item.dataset.rate) === playbackRate);
    });
}

function setPlaybackRate(rate) {
    playbackRate = audio.setRate(rate);
    updateSpeedUI();
    window.api.setStoreValue('playbackRate', playbackRate);
}

/**
 * Updates the text and active state of the app settings dropdown menu items.
 * This function should be called on startup and whenever a setting changes.
 */
function updateAppSettingsMenu() {
    // 1. Check for Light Mode
    const isLightMode = containerEl.classList.contains('light-mode');
    lightModeLabel.textContent = isLightMode ? 'Disable Light Mode' : 'Enable Light Mode';
    lightModeBtn.classList.toggle('active', isLightMode);

    // 2. Check for Vertical Orientation
    const isVertical = containerEl.classList.contains('vertical-mode');
    orientationLabel.textContent = isVertical ? 'Switch to Horizontal' : 'Switch to Vertical';
    orientationBtn.classList.toggle('active', isVertical);

    // 3. Check for Volume Boost
    const isVolumeBoosted = parseFloat(volumeSlider.max) > 1.0;
    volumeBoostLabel.textContent = isVolumeBoosted ? 'Disable Volume Boost' : 'Enable Volume Boost';
    volumeBoostBtn.classList.toggle('active', isVolumeBoosted);
}

function updateMagnifierUI() {
    toggleMagnifierLabel.textContent = isMagnifierEnabled ? 'Disable Magnifier' : 'Enable Magnifier';
    toggleMagnifierBtn.classList.toggle('active', isMagnifierEnabled);
    containerEl.classList.toggle('magnifier-disabled', !isMagnifierEnabled);
}

// --- Helper Functions ---
function updateLyricsDropdownMenu() {
    // 1. Show/Hide Lyrics Section
    toggleLyricsLabel.textContent = areLyricsVisible ? 'Hide Lyrics' : 'Show Lyrics';
    toggleLyricsBtn.classList.toggle('active', areLyricsVisible);

    // 2. Show/Hide Lyrics Controls
    toggleControlsLabel.textContent = areLyricsControlsVisible ? 'Hide Controls' : 'Show Controls';
    toggleControlsBtn.classList.toggle('active', areLyricsControlsVisible);

    // 3. Enable/Disable Manual Scroll
    manualScrollLabel.textContent = isManualScrollEnabled ? 'Disable Manual Scroll' : 'Enable Manual Scroll';
    toggleManualScrollBtn.classList.toggle('active', isManualScrollEnabled);
}

/**
 * Displays the volume percentage over the album art and hides it after a delay.
 * @param {number} volume The volume level (e.g., 0.0 to 2.0).
 */
function showVolumeFeedback(volume) {
    if (!volumeOverlay || !volumeOverlayText) return;

    // Convert volume to percentage and update the text
    const percentage = Math.round(volume * 100);
    volumeOverlayText.textContent = `${percentage}%`;

    volumeOverlay.classList.add('show');

    clearTimeout(volumeOverlayTimeout);
    volumeOverlayTimeout = setTimeout(() => volumeOverlay.classList.remove('show'), 3000);
}

/**
 * Updates the loop button's icon, tooltip, and active state based on the current loopMode.
 */
function updateLoopButtonUI() {
    if (!loopBtn || !loopOffIcon || !loopAllIcon || !loopOneIcon) return;

    loopOffIcon.style.display = loopMode === 'none' ? 'block' : 'none';
    loopAllIcon.style.display = loopMode === 'all' ? 'block' : 'none';
    loopOneIcon.style.display = loopMode === 'one' ? 'block' : 'none';

    loopBtn.classList.toggle('active', loopMode !== 'none');
    loopBtn.title = `Loop: ${loopMode.charAt(0).toUpperCase() + loopMode.slice(1)}`;
}

/**
 * Updates the like button's UI state based on whether the current song is in the favorites list.
 */
function updateLikeButtonUI() {
    if (!likeBtn || currentIndex < 0) {
        likeBtn.classList.remove('active');
        return;
    }
    const currentPath = playlist[currentIndex];
    const isFavorite = favoritesPlaylist.includes(currentPath);
    likeBtn.classList.toggle('active', isFavorite);
}

function saveFavorites() {
    window.api.setStoreValue('favoritesPlaylist', favoritesPlaylist);
}

function formatTime(secs) {
    const minutes = Math.floor(secs / 60) || 0;
    const seconds = Math.floor(secs - minutes * 60) || 0;
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

/**
 * Shrinks the active lyric line until it fits its container without clipping (#9).
 *
 * Long lines wrapped to two or three rows and overflowed the 60px lyrics strip, so the
 * bottom of the text was cut off. Rather than shrink every line (which makes short ones
 * look tiny), only the active line is measured, and only when it actually overflows.
 *
 * The tiers are applied as classes rather than inline font sizes so the CSS transition
 * still animates and the light/dark rules stay in one place.
 */
const FIT_TIERS = ['fit-sm', 'fit-xs', 'fit-xxs'];

function fitActiveLyric(lineEl) {
    if (!lineEl || !lyricsContainer) return;

    FIT_TIERS.forEach((tier) => lineEl.classList.remove(tier));

    // Compare against the container, not the line's own box: the line grows to fit its
    // wrapped text, so scrollHeight > clientHeight is never true on the line itself.
    const available = lyricsContainer.clientHeight;
    if (!available) return;

    for (const tier of FIT_TIERS) {
        if (lineEl.offsetHeight <= available) return;
        lineEl.classList.add(tier);
        // Reading offsetHeight forces a synchronous reflow, so the next iteration sees
        // the effect of the class we just added.
        void lineEl.offsetHeight;
        FIT_TIERS.filter((t) => t !== tier).forEach((t) => lineEl.classList.remove(t));
    }
}

/**
 * Paints a lyrics payload.
 *
 * `ticket` is the engine load ticket that was current when the caller began its work.
 * If a newer track has since started loading the payload is dropped. Without this, a
 * slow lyrics fetch for a track the user already skipped past would land a moment later
 * and paint itself over the current track — the "flash" in request #6.
 */
function displayLyrics(data, ticket) {
    if (!lyricsContainer) return;
    if (ticket !== undefined && ticket !== audio.ticket) return;

    lastActiveLyricIndex = -1;
    lyricsContainer.innerHTML = '';
    lyricsContainer.classList.toggle('scrolling', !data.isSynced);
    if (data.lines.length > 0) {
        const wrapper = (data.isSynced) ? document.createDocumentFragment() : document.createElement('div');
        if (!data.isSynced) wrapper.className = 'lyrics-scroll-wrapper';
        data.lines.forEach(line => {
            const lineEl = document.createElement('p');
            lineEl.className = 'lyrics-line';
            lineEl.innerHTML = typeof line === 'string' ? line : line.text;
            wrapper.appendChild(lineEl);
        });
        lyricsContainer.appendChild(wrapper);
    } else {
        const noLyricsEl = document.createElement('p');
        noLyricsEl.className = 'lyrics-line';
        noLyricsEl.textContent = 'No lyrics available.';
        lyricsContainer.appendChild(noLyricsEl);
    }
};

function shuffleArray(array) {
    // Make a copy to avoid modifying the original array reference
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
}

function reportPlaybackState() {
    // Title/artist ride along so the tray tooltip can show what is playing.
    window.api.sendPlaybackState({
        isPlaying,
        title: currentSongData ? currentSongData.title : null,
        artist: currentSongData ? currentSongData.artist : null,
    });
}

function processLyrics(lyricsText) {
    if (!lyricsText) return {isSynced: false, lines: []};

    const lines = lyricsText.split('\n');
    const syncedLyrics = [];
    const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/;
    let isSynced = false;

    for (const line of lines) {
        const match = line.match(timeRegex);
        if (match) {
            isSynced = true;
            const minutes = parseInt(match[1], 10);
            const seconds = parseInt(match[2], 10);
            const milliseconds = parseInt(match[3], 10);
            const text = match[4].trim();
            const time = minutes * 60 + seconds + milliseconds / 1000;
            if (text) {
                syncedLyrics.push({time, text});
            }
        }
    }

    if (isSynced) {
        return {isSynced: true, lines: syncedLyrics};
    }

    return {isSynced: false, lines: lines.filter(line => line.trim() !== '')};
}

function sanitizeForApiSearch(artist, title) {
    const junkRegex = /\[.*?\]|\(.*?\)|official|lyric|video|audio|h[dq]|\s*:.*|\s*-.*|ft\..*|feat\..*/gi;
    const cleanArtist = artist.replace(junkRegex, '').trim();
    const cleanTitle = title.replace(junkRegex, '').trim();
    return {artist: cleanArtist, title: cleanTitle};
}

function updateTimeDisplay() {
    if (!currentSound) return;
    const seek = audio.seek() || 0;
    const duration = audio.duration() || 0;
    timeCurrentEl.textContent = formatTime(seek);
    timeRemainingEl.textContent = timeDisplayMode === 'remaining' ? `-${formatTime(duration - seek)}` : formatTime(duration);
}

function getSongIdentifier() {
    if (!currentSongData) return null;
    const duration = Math.round(audio.duration());
    return `${currentSongData.artist} - ${currentSongData.title} - ${duration}`;
}

function updateOffsetDisplay() {
    if (!lyricsOffsetDisplay) return;
    lyricsOffsetDisplay.textContent = `${currentLyricsOffset >= 0 ? '' : ''}${currentLyricsOffset.toFixed(1)}s`;
}

/**
 * Paints the filled portion of the progress bar.
 *
 * A native range input renders its track in a single flat colour, which in dark mode
 * was near-invisible against the background (#24). We drive an explicit gradient stop
 * from JS so the elapsed portion is always brand green with real contrast.
 */
function updateProgressFill(seek, duration) {
    const percent = duration > 0 ? Math.min(100, (seek / duration) * 100) : 0;
    progressBar.style.setProperty('--progress-percent', `${percent}%`);

    if (progressBuffered) {
        const bufferedPercent = duration > 0 ? Math.min(100, (audio.buffered() / duration) * 100) : 0;
        progressBuffered.style.width = `${bufferedPercent}%`;
    }
}

// --- UI Update Functions ---
function updatePlayPauseIcon() {
    playIcon.style.display = isPlaying ? 'none' : 'block';
    pauseIcon.style.display = isPlaying ? 'block' : 'none';
}

function updateVolumeUI() {
    const currentVolume = isMuted ? 0 : playbackVolume;
    volumeIcon.style.display = currentVolume === 0 ? 'none' : 'block';
    volumeMuteIcon.style.display = currentVolume === 0 ? 'block' : 'none';
    volumeSlider.value = currentVolume;
}

function updateUI() {
    // `isSeeking` is set while the user drags the progress bar. Writing to
    // progressBar.value during a drag fights the pointer and makes the thumb stutter.
    if (currentSound && isPlaying && !isSeeking) {
        const seek = audio.seek() || 0;
        const duration = audio.duration() || 0;
        progressBar.value = seek;
        updateProgressFill(seek, duration);
        updateTimeDisplay();

        if (lyricsContainer && lyrics.lines.length > 0 && !isManualScrollEnabled) {
            if (lyrics.isSynced) {
                let currentLyricIndex = -1;
                for (let i = lyrics.lines.length - 1; i >= 0; i--) {
                    if (seek >= (lyrics.lines[i].time + currentLyricsOffset)) {
                        currentLyricIndex = i;
                        break;
                    }
                }

                if (currentLyricIndex !== lastActiveLyricIndex) {
                    const lineElements = lyricsContainer.children;
                    if (lastActiveLyricIndex > -1 && lineElements[lastActiveLyricIndex]) {
                        lineElements[lastActiveLyricIndex].classList.remove('active');
                    }
                    if (currentLyricIndex > -1 && lineElements[currentLyricIndex]) {
                        const activeLineEl = lineElements[currentLyricIndex];
                        activeLineEl.classList.add('active');
                        // Fit before measuring, or the scroll position is computed from
                        // the pre-shrink height and lands slightly off centre.
                        fitActiveLyric(activeLineEl);
                        const containerHeight = lyricsContainer.clientHeight;
                        lyricsContainer.scrollTop =
                            activeLineEl.offsetTop - (containerHeight / 2) + (activeLineEl.offsetHeight / 2);
                    }
                    lastActiveLyricIndex = currentLyricIndex;
                }
            } else {
                const scrollWrapper = lyricsContainer.firstChild;
                if (scrollWrapper) {
                    const progress = seek / duration;
                    const totalScrollHeight = scrollWrapper.scrollHeight - lyricsContainer.clientHeight;
                    if (totalScrollHeight > 0) {
                        scrollWrapper.style.transform = `translateY(-${progress * totalScrollHeight}px)`;
                    }
                }
            }
        }
    }
    requestAnimationFrame(updateUI);
}

// --- State Persistence ---
function savePlaybackState() {
    if (!currentSound || currentIndex < 0) return;
    // A finished track restarts from the top next launch rather than resuming at the
    // very end, which would immediately re-trigger the 'ended' path.
    const seek = audio.hasEnded() ? 0 : (audio.seek() || 0);
    const state = {
        playlist: originalPlaylist,
        lastPlayedPath: playlist[currentIndex],
        seek,
        isShuffled: isShuffled,
        loopMode: loopMode,
        playbackRate,
    };
    window.api.setStoreValue('lastPlaybackState', state);
}

function saveLyricsOffsets() {
    window.api.setStoreValue('lyricsOffsets', lyricsOffsets);
}

async function fetchLyrics(artist, title) {
    const url = `https://lrclib.net/api/search?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        const data = await response.json();
        if (data && data.length > 0 && data[0].syncedLyrics) {
            return data[0].syncedLyrics;
        }
        return null;
    } catch (error) {
        console.error('Error fetching lyrics:', error);
        const firstLine = lyricsContainer.querySelector('.lyrics-line');
        if (firstLine) {
            firstLine.textContent = 'Lyrics search failed (Network Error)';
        }
        return null;
    }
}

async function searchAndDisplayOnlineLyrics(songData, forceRefetch = false, ticket = audio.ticket) {
    if (!lyricsContainer) return;
    if (ticket !== audio.ticket) return;

    const noLyricsEl = lyricsContainer.querySelector('.lyrics-line');
    if (noLyricsEl) noLyricsEl.textContent = 'Searching for lyrics...';

    let resolved = {isSynced: false, lines: []};

    try {
        const songId = getSongIdentifier();
        if (!songId) {
            throw new Error("Cannot generate a song identifier to use the database.");
        }

        const cachedLyrics = forceRefetch ? null : await window.api.getLyrics(songId);

        if (cachedLyrics) {
            resolved = processLyrics(cachedLyrics);
        } else {
            const {artist: cleanArtist, title: cleanTitle} = sanitizeForApiSearch(songData.artist, songData.title);
            const onlineLyricsText = await fetchLyrics(cleanArtist, cleanTitle);

            // The network round trip is the slow part, so re-check the ticket here:
            // by now the user may well have skipped on several tracks.
            if (ticket !== audio.ticket) return;

            if (onlineLyricsText) {
                resolved = processLyrics(onlineLyricsText);
                window.api.saveLyrics(songId, onlineLyricsText, {
                    source: 'lrclib',
                    isSynced: resolved.isSynced,
                    artist: songData.artist,
                    title: songData.title,
                });
            }
        }
    } catch (error) {
        console.error('An error occurred during lyric search:', error);
        resolved = {isSynced: false, lines: ['Error finding lyrics.']};
    } finally {
        // Only commit to the shared `lyrics` state if this load is still the current one.
        if (ticket === audio.ticket) {
            lyrics = resolved;
            displayLyrics(resolved, ticket);
        }
    }
}

// --- Rooms / streaming ----------------------------------------------------------

function renderRoomUI() {
    if (!roomStatusEl) return;

    roomStatusEl.textContent = room.connected
        ? (room.isHost ? `Hosting ${room.code}` : `In ${room.code}`)
        : 'Offline';
    roomStatusEl.classList.toggle('running', room.connected);

    roomSetupEl?.classList.toggle('hidden', room.connected);
    roomActiveEl?.classList.toggle('hidden', !room.connected);
    if (roomCodeValueEl) roomCodeValueEl.textContent = room.code || '------';

    if (!roomMembersEl) return;
    roomMembersEl.innerHTML = '';

    for (const member of room.members) {
        const row = document.createElement('div');
        row.className = 'room-member';

        const label = document.createElement('span');
        label.className = 'room-member-name';
        label.textContent = member.name + (member.isHost ? ' (host)' : '');
        row.appendChild(label);

        // Only the host may change roles, and never its own.
        if (room.isHost && !member.isHost) {
            const toggle = document.createElement('button');
            toggle.className = 'chip';
            const isListener = member.role === 'listener';
            toggle.textContent = isListener ? 'Listen only' : 'Can control';
            toggle.title = 'Click to change';
            toggle.addEventListener('click', () => {
                window.api.roomSetRole(member.id, isListener ? 'controller' : 'listener');
            });
            row.appendChild(toggle);

            const kick = document.createElement('button');
            kick.className = 'chip danger';
            kick.textContent = 'Remove';
            kick.addEventListener('click', () => window.api.roomKick(member.id));
            row.appendChild(kick);
        } else {
            const badge = document.createElement('span');
            badge.className = 'room-member-role';
            badge.textContent = member.isHost ? 'host' : member.role;
            row.appendChild(badge);
        }

        roomMembersEl.appendChild(row);
    }
}

/**
 * Publishes playback state to the room.
 *
 * Throttled to about 2Hz: the state is self-describing (position + timestamp + rate),
 * so members extrapolate between updates rather than needing a high update rate. Sending
 * on every timeupdate would be ~4x the traffic for no added accuracy.
 */
function publishRoomState() {
    if (!room.connected || !room.isHost) return;

    window.api.roomPublishState({
        trackId: playlist[currentIndex] ? hashPath(playlist[currentIndex]) : null,
        title: currentSongData ? currentSongData.title : '',
        artist: currentSongData ? currentSongData.artist : '',
        album: currentSongData ? currentSongData.album : '',
        durationMs: Math.round(audio.duration() * 1000),
        positionMs: Math.round(audio.seek() * 1000),
        playing: audio.isPlaying(),
        rate: playbackRate,
        queueIndex: currentIndex,
        shuffle: isShuffled,
        loop: loopMode,
    });
}

/**
 * Must match trackIdFor() in src/main/room-client.js. Computed in main and echoed here
 * only for the state message; the authoritative mapping lives in main.
 */
let trackIdCache = new Map();

function hashPath(filePath) {
    return trackIdCache.get(filePath) || null;
}

/** Publishes the queue, and refreshes the local id cache from what main assigned. */
async function publishRoomLibrary() {
    if (!room.connected || !room.isHost) return;

    const info = {};
    for (const filePath of playlist) {
        const track = await window.api.libraryGetTrack(filePath);
        if (track) info[filePath] = {title: track.title, artist: track.artist, album: track.album};
    }

    window.api.roomPublishLibrary({queue: playlist, info});
}

/** Mirrors theme, lyric offset and playback shape so members match the host. */
function publishRoomSettings() {
    if (!room.connected || !room.isHost) return;

    window.api.roomPublishSettings({
        theme: containerEl.classList.contains('light-mode') ? 'light' : 'dark',
        colorTheme: currentThemeId,
        accent: '#1db954',
        lyricsOffsetMs: Math.round(currentLyricsOffset * 1000),
        lyricsVisible: areLyricsVisible,
        translationLanguage: showTranslation ? translationLanguage : null,
        rate: playbackRate,
        equalizer: equalizer.enabled ? equalizer.toJSON() : null,
    });
}

function publishRoomLyrics() {
    if (!room.connected || !room.isHost) return;

    const source = lyrics && lyrics.lines ? lyrics.lines : [];
    const lines = lyrics && lyrics.isSynced
        ? source.map((line) => ({timeMs: Math.round(line.time * 1000), text: line.text}))
        : source.map((line) => (typeof line === 'string' ? line : line.text));

    window.api.roomPublishLyrics({
        trackPath: playlist[currentIndex] || null,
        lines,
        isSynced: Boolean(lyrics && lyrics.isSynced),
        translation: translatedLines
            ? {lines: translatedLines, language: translationLanguage,
               rtl: ['fa', 'ar'].includes(translationLanguage)}
            : null,
    });
}

// --- Member mode: following someone else's room ---------------------------------
//
// The desktop app can join a room as a member, in which case it plays the HOST's audio
// over the relay instead of local files. The engine already accepts an http(s) URL, so
// this is mostly a matter of pointing it at the stream endpoint and correcting drift.

const SYNC_DEADBAND_MS = 60;
const SYNC_HARD_SEEK_MS = 1500;
const SYNC_MAX_TRIM = 0.04;

let remoteState = null;
let remoteTrackId = null;
let clockOffsetMs = 0;

const serverNow = () => Date.now() + clockOffsetMs;

function projectRemotePosition(state, now) {
    if (!state || !state.playing) return state ? state.positionMs : 0;
    const elapsed = Math.max(0, now - state.atServerTime);
    const projected = state.positionMs + elapsed * (state.rate || 1);
    return state.durationMs > 0 ? Math.min(projected, state.durationMs) : projected;
}

/** Applies a state snapshot received as a room member. */
function applyRemoteState(state) {
    if (!state || room.isHost) return;
    remoteState = state;

    if (state.trackId !== remoteTrackId) {
        remoteTrackId = state.trackId;
        if (state.trackId) {
            const url = `${room.serverUrl}/api/rooms/${room.code}/stream/${encodeURIComponent(state.trackId)}`;
            audio.load(url, {autoplay: state.playing});
        } else {
            audio.unload();
        }
    }

    titleEl.textContent = state.title || 'Nothing playing';
    artistEl.textContent = state.artist || '';
    progressBar.max = (state.durationMs || 0) / 1000;

    audio.setRate(state.rate || 1);
    if (state.playing && !audio.isPlaying()) audio.play();
    if (!state.playing && audio.isPlaying()) audio.pause();
}

/**
 * Drift correction. Nudges playback rate for small errors and only seeks for large
 * ones, because a seek is audible and a 4% rate change is not.
 */
function correctRemoteDrift() {
    if (!remoteState || room.isHost || !room.connected) return;
    if (!audio.duration()) return;

    const targetMs = projectRemotePosition(remoteState, serverNow());
    const drift = targetMs - audio.seek() * 1000;

    if (Math.abs(drift) > SYNC_HARD_SEEK_MS) {
        audio.seek(targetMs / 1000);
        audio.setRate(remoteState.rate || 1);
        return;
    }
    if (!remoteState.playing || Math.abs(drift) < SYNC_DEADBAND_MS) {
        audio.setRate(remoteState.rate || 1);
        return;
    }

    const trim = Math.max(-SYNC_MAX_TRIM, Math.min(SYNC_MAX_TRIM, drift / 8000));
    audio.setRate((remoteState.rate || 1) * (1 + trim));
}

/** Mirrors the host's theme and lyric settings onto this window. */
function applyRemoteSettings(settings) {
    if (!settings || room.isHost) return;

    if (settings.colorTheme) {
        applyTheme(settings.colorTheme, false);
    } else if (settings.theme) {
        containerEl.classList.toggle('light-mode', settings.theme === 'light');
    }
    if (typeof settings.lyricsOffsetMs === 'number') {
        currentLyricsOffset = settings.lyricsOffsetMs / 1000;
        updateOffsetDisplay();
    }
}

/** Renders lyrics pushed by the host, including its translation if one is active. */
function applyRemoteLyrics(payload) {
    if (!payload || room.isHost) return;

    const source = payload.translation && payload.translation.lines
        ? payload.translation.lines
        : payload.lines;

    if (payload.isSynced) {
        lyrics = {
            isSynced: true,
            lines: (payload.lines || []).map((line, index) => ({
                time: (line.timeMs || 0) / 1000,
                text: (source && source[index] && source[index].text) || source[index] || line.text,
            })),
        };
    } else {
        lyrics = {isSynced: false, lines: source || []};
    }

    lyricsContainer.classList.toggle('rtl', Boolean(payload.translation && payload.translation.rtl));
    displayLyrics(lyrics, audio.ticket);
}

/** Applies a control intent forwarded from a member. Host only. */
function applyRoomControl({action, value}) {
    switch (action) {
        case 'play':     audio.play(); break;
        case 'pause':    audio.pause(); break;
        case 'toggle':   audio.toggle(); break;
        case 'next':     nextBtn.click(); break;
        case 'previous': prevBtn.click(); break;
        case 'seek':     audio.seek((value || 0) / 1000); break;
        case 'rate':     setPlaybackRate(value); break;
        case 'select':   if (value >= 0 && value < playlist.length) playTrack(value); break;
        case 'shuffle':  shuffleBtn.click(); break;
    }
    // Answer immediately rather than waiting for the next throttled tick, so the
    // member who pressed the button sees it respond at once.
    publishRoomState();
}

// --- Tag editor ------------------------------------------------------------------
//
// Everything here is explicit and uncommitted until Save: this is the one screen
// that rewrites the user's files. Fields mark themselves dirty as they diverge
// from what was read, Revert restores that snapshot, and the status line always
// names the outcome rather than silently succeeding.

const tagsTab = document.getElementById('tab-tags');
const tagsForm = document.getElementById('tags-form');
const tagsEmpty = document.getElementById('tags-empty');
const tagsStatus = document.getElementById('tags-status');
const tagsFormat = document.getElementById('tags-format');
const tagsFilename = document.getElementById('tags-filename');
const tagsCover = document.getElementById('tags-cover');
const tagsSaveBtn = document.getElementById('tags-save');
const tagsRevertBtn = document.getElementById('tags-revert');
const tagsPickCoverBtn = document.getElementById('tags-pick-cover');
const tagsClearCoverBtn = document.getElementById('tags-clear-cover');

// Field id -> tag key. One map drives read, dirty-check, revert and write, so
// adding a field is a one-line change.
const TAG_FIELDS = new Map([
    ['tag-title', 'title'],
    ['tag-artist', 'artist'],
    ['tag-album-artist', 'albumArtist'],
    ['tag-album', 'album'],
    ['tag-track', 'track'],
    ['tag-track-count', 'trackCount'],
    ['tag-disc', 'disc'],
    ['tag-year', 'year'],
    ['tag-genre', 'genre'],
    ['tag-comment', 'comment'],
]);

// The snapshot as read from disk, and the pending cover change.
let tagsOriginal = null;
let tagsLoadedPath = null;
// undefined = untouched, null = remove, {data, mimeType} = replace.
let pendingCover;

function setTagsStatus(message, kind = '') {
    if (!tagsStatus) return;
    tagsStatus.textContent = message || '';
    tagsStatus.className = `tags-status ${kind}`.trim();
}

/** Repaints the dirty markers and enables Save only when there is work to do. */
function refreshTagsDirtyState() {
    if (!tagsOriginal) return;
    let dirty = pendingCover !== undefined;

    TAG_FIELDS.forEach((key, id) => {
        const input = document.getElementById(id);
        if (!input) return;
        const changed = input.value.trim() !== (tagsOriginal[key] || '');
        input.classList.toggle('dirty', changed);
        if (changed) dirty = true;
    });

    if (tagsSaveBtn) tagsSaveBtn.disabled = !dirty;
    if (tagsRevertBtn) tagsRevertBtn.disabled = !dirty;
}

/** Writes a snapshot into the form. */
function fillTagsForm(tags) {
    TAG_FIELDS.forEach((key, id) => {
        const input = document.getElementById(id);
        if (input) input.value = tags[key] || '';
    });
    refreshTagsDirtyState();
}

/** Reads the currently playing file's tags straight from disk. */
async function loadTagsForCurrentTrack() {
    const filePath = currentSongData?.filePath || null;

    if (!filePath) {
        tagsForm?.classList.add('hidden');
        tagsEmpty?.classList.remove('hidden');
        if (tagsFormat) tagsFormat.textContent = '';
        setTagsStatus('');
        tagsOriginal = null;
        tagsLoadedPath = null;
        return;
    }

    // Re-entering the tab on the same track keeps whatever was typed, so a tab
    // switch mid-edit is not destructive.
    if (tagsLoadedPath === filePath && tagsOriginal) {
        refreshTagsDirtyState();
        return;
    }

    setTagsStatus('Reading...');
    const result = await window.api.readTags(filePath);

    tagsLoadedPath = filePath;
    pendingCover = undefined;
    tagsEmpty?.classList.add('hidden');
    tagsForm?.classList.remove('hidden');

    if (tagsFilename) tagsFilename.textContent = result.basename || '';
    if (tagsCover) {
        tagsCover.src = result.cover || currentSongData?.cover
            || '../assets/images/placeholder.png';
    }

    if (tagsFormat) {
        const extension = (result.basename || '').split('.').pop().toUpperCase();
        const bits = [extension];
        if (result.bitrate) bits.push(`${Math.round(result.bitrate)} kbps`);
        tagsFormat.textContent = bits.filter(Boolean).join(' · ');
    }

    if (!result.ok) {
        tagsOriginal = null;
        fillTagsForm({});
        setTagsStatus(result.error || 'Could not read this file.', 'error');
        if (tagsSaveBtn) tagsSaveBtn.disabled = true;
        return;
    }

    tagsOriginal = result.tags;
    fillTagsForm(result.tags);

    if (result.writable) {
        setTagsStatus('');
    } else {
        // Read-only formats still display, so the user can see what is stored
        // rather than being told nothing at all.
        setTagsStatus('This format is read-only in Rhythm Dock.', 'error');
        if (tagsSaveBtn) tagsSaveBtn.disabled = true;
    }
}

/** Commits the form to disk. */
async function saveTags() {
    if (!tagsLoadedPath || !tagsOriginal) return;

    const values = {};
    TAG_FIELDS.forEach((key, id) => {
        const input = document.getElementById(id);
        if (input) values[key] = input.value.trim();
    });

    setTagsStatus('Saving...');
    const result = await window.api.writeTags({
        filePath: tagsLoadedPath,
        tags: values,
        cover: pendingCover,
    });

    if (!result.ok) {
        setTagsStatus(result.error || 'Save failed.', 'error');
        return;
    }

    tagsOriginal = {...values};
    pendingCover = undefined;
    refreshTagsDirtyState();
    setTagsStatus('Saved.', 'ok');

    // The header still shows the old title until the player re-reads the file.
    if (currentSongData && currentSongData.filePath === tagsLoadedPath) {
        if (values.title) {
            currentSongData.title = values.title;
            titleEl.textContent = values.title;
        }
        if (values.artist) {
            currentSongData.artist = values.artist;
            artistEl.textContent = values.artist;
        }
    }
}

/** Restores the snapshot that was read from disk. */
function revertTags() {
    if (!tagsOriginal) return;
    pendingCover = undefined;
    fillTagsForm(tagsOriginal);
    if (tagsCover) {
        tagsCover.src = currentSongData?.cover || '../assets/images/placeholder.png';
    }
    setTagsStatus('Reverted.', '');
}

/** Wires the editor. Called once from the DOM-ready block. */
function initTagEditor() {
    TAG_FIELDS.forEach((_key, id) => {
        document.getElementById(id)?.addEventListener('input', refreshTagsDirtyState);
    });

    tagsSaveBtn?.addEventListener('click', saveTags);
    tagsRevertBtn?.addEventListener('click', revertTags);

    tagsPickCoverBtn?.addEventListener('click', async () => {
        const picked = await window.api.pickCoverImage();
        if (!picked) return;
        pendingCover = {data: picked.data, mimeType: picked.mimeType};
        if (tagsCover) tagsCover.src = picked.dataUrl;
        refreshTagsDirtyState();
        setTagsStatus('Artwork replaced — press Save to write it.', '');
    });

    tagsClearCoverBtn?.addEventListener('click', () => {
        pendingCover = null;
        if (tagsCover) tagsCover.src = '../assets/images/placeholder.png';
        refreshTagsDirtyState();
        setTagsStatus('Artwork will be removed on Save.', '');
    });

    refreshTagsDirtyState();
}

// --- Themes ----------------------------------------------------------------------
//
// Ten palettes, five dark and five light. Each is a full token set in the
// stylesheet, selected with data-theme on <html>. The preview colours below are
// duplicated here on purpose: a swatch has to paint the palette it *applies*,
// not the palette currently active, so it cannot read the live tokens.
//
// .light-mode stays in sync on the container because the tray-icon logic in the
// main process and the room sync both still key off it.

const THEMES = [
    {id: 'midnight', name: 'Midnight', mode: 'dark',  bg: '#111214', accent: '#1ed760', text: '#f2f3f5'},
    {id: 'graphite', name: 'Graphite', mode: 'dark',  bg: '#18181a', accent: '#e8e8ea', text: '#f4f4f5'},
    {id: 'ocean',    name: 'Ocean',    mode: 'dark',  bg: '#0d1520', accent: '#38bdf8', text: '#eaf2fb'},
    {id: 'plum',     name: 'Plum',     mode: 'dark',  bg: '#18111e', accent: '#c084fc', text: '#f4ecfb'},
    {id: 'ember',    name: 'Ember',    mode: 'dark',  bg: '#1c130f', accent: '#fb923c', text: '#fbeee6'},
    {id: 'daylight', name: 'Daylight', mode: 'light', bg: '#fafafb', accent: '#12a54c', text: '#14161a'},
    {id: 'paper',    name: 'Paper',    mode: 'light', bg: '#f8f5ef', accent: '#b45309', text: '#221c14'},
    {id: 'sky',      name: 'Sky',      mode: 'light', bg: '#f4f8fd', accent: '#0284c7', text: '#0f1c2e'},
    {id: 'sand',     name: 'Sand',     mode: 'light', bg: '#f5f3ee', accent: '#4d7c0f', text: '#1e1d18'},
    {id: 'rose',     name: 'Rose',     mode: 'light', bg: '#fcf5f7', accent: '#be123c', text: '#2b1119'}
];

const DEFAULT_DARK_THEME = 'midnight';
const DEFAULT_LIGHT_THEME = 'daylight';

let currentThemeId = DEFAULT_DARK_THEME;

/** Looks a palette up by id, falling back to the dark default. */
function findTheme(id) {
    return THEMES.find((theme) => theme.id === id)
        || THEMES.find((theme) => theme.id === DEFAULT_DARK_THEME);
}

/**
 * Applies a palette. `persist` is false when the theme arrives from a room host,
 * so a guest's own saved preference is not overwritten by the session.
 */
function applyTheme(id, persist = true) {
    const theme = findTheme(id);
    currentThemeId = theme.id;

    document.documentElement.setAttribute('data-theme', theme.id);
    containerEl.classList.toggle('light-mode', theme.mode === 'light');

    if (persist) {
        window.api.setStoreValue('colorTheme', theme.id);
        // The legacy key still drives the tray icon and the room payload.
        window.api.setStoreValue('theme', theme.mode);
    }

    renderThemeGrid();
    updateAppSettingsMenu();
}

/** Builds the swatch grid once, then only refreshes the selected state. */
function renderThemeGrid() {
    const grid = document.getElementById('theme-grid');
    if (!grid) return;

    if (grid.childElementCount === 0) {
        THEMES.forEach((theme) => {
            const swatch = document.createElement('button');
            swatch.className = 'theme-swatch';
            swatch.dataset.theme = theme.id;
            swatch.title = `${theme.name} (${theme.mode})`;
            swatch.style.setProperty('--swatch-bg', theme.bg);
            swatch.style.setProperty('--swatch-accent', theme.accent);
            swatch.style.setProperty('--swatch-text', theme.text);

            const preview = document.createElement('span');
            preview.className = 'theme-swatch-preview';

            const name = document.createElement('span');
            name.className = 'theme-swatch-name';
            name.textContent = theme.name;

            swatch.append(preview, name);
            swatch.addEventListener('click', () => applyTheme(theme.id));
            grid.appendChild(swatch);
        });
    }

    grid.querySelectorAll('.theme-swatch').forEach((swatch) => {
        swatch.classList.toggle('active', swatch.dataset.theme === currentThemeId);
    });
}

// --- Popover placement -----------------------------------------------------------
//
// Menus are `position: fixed` children of <body>, so nothing in the layout can
// clip them -- but nothing constrains them either. Previously a menu was pinned
// to `top: trigger.bottom + 5` and simply ran off the bottom of a 180px dock,
// and a wide menu ran off the left edge in vertical mode. Both are now
// impossible: the menu is measured, capped to whatever room actually exists,
// flipped above its trigger when there is more space up than down, and pulled
// inward so it always sits fully inside the window rectangle. If the content
// still does not fit, the menu scrolls internally rather than growing.

/** The menu that is currently open, and the button that opened it. */
let openMenuTrigger = null;
let openMenuEl = null;

const DROPDOWNS = new Map([
    ['speed-btn', 'speed-dropdown-menu'],
    ['file-dropdown-btn', 'file-dropdown-menu'],
    ['lyrics-dropdown-btn', 'lyrics-dropdown-menu'],
    ['app-dropdown-btn', 'app-dropdown-menu']
]);

/** Window-edge inset and the gap between a trigger and its menu, in px. */
const MENU_MARGIN = 6;
const MENU_GAP = 4;

/** Focusable rows inside a menu, in visual order. */
function menuItems(menu) {
    return Array.from(menu.querySelectorAll('.dropdown-item:not(.version-display)'))
        .filter((item) => !item.disabled && item.offsetParent !== null);
}

/** Places `menu` against `trigger`, clamped to the window on all four sides. */
function positionMenu(menu, trigger) {
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    // Reset before measuring: a stale max-height from a previous open would
    // otherwise be mistaken for the natural height.
    menu.classList.remove('flip-up');
    menu.style.maxHeight = '';
    menu.style.maxWidth = `${Math.max(120, viewportW - MENU_MARGIN * 2)}px`;
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.style.right = 'auto';

    const triggerRect = trigger.getBoundingClientRect();
    let rect = menu.getBoundingClientRect();

    const roomBelow = viewportH - triggerRect.bottom - MENU_GAP - MENU_MARGIN;
    const roomAbove = triggerRect.top - MENU_GAP - MENU_MARGIN;

    // Flip up only when doing so genuinely buys more room, so menus stay in the
    // predictable place whenever they fit there.
    const flip = rect.height > roomBelow && roomAbove > roomBelow;
    const room = flip ? roomAbove : roomBelow;

    menu.style.maxHeight = `${Math.max(72, Math.floor(room))}px`;
    rect = menu.getBoundingClientRect();

    // Right-align to the trigger, then pull inside the window.
    let left = triggerRect.right - rect.width;
    left = Math.min(left, viewportW - MENU_MARGIN - rect.width);
    left = Math.max(MENU_MARGIN, left);

    let top = flip ? triggerRect.top - MENU_GAP - rect.height
                   : triggerRect.bottom + MENU_GAP;
    top = Math.min(top, viewportH - MENU_MARGIN - rect.height);
    top = Math.max(MENU_MARGIN, top);

    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.right = 'auto';
    menu.classList.toggle('flip-up', flip);
}

/** Opens a menu and marks its trigger. */
function openMenu(menu, trigger) {
    // Measured while hidden and unanimated: a rect read mid-transform reports
    // the scaled size and the menu lands a few pixels off.
    menu.style.visibility = 'hidden';
    menu.style.animation = 'none';
    menu.classList.add('show');

    positionMenu(menu, trigger);

    menu.style.animation = '';
    menu.style.visibility = '';

    trigger.parentElement?.classList.add('open');
    openMenuTrigger = trigger;
    openMenuEl = menu;
}

/** Closes every open menu. */
function closeAllMenus() {
    document.querySelectorAll('.dropdown-menu.show').forEach((menu) => {
        menu.classList.remove('show');
        menu.classList.remove('flip-up');
    });
    document.querySelectorAll('.dropdown.open').forEach((wrapper) => {
        wrapper.classList.remove('open');
    });
    openMenuTrigger = null;
    openMenuEl = null;
}

// Resizing or moving the window while a menu is open would leave it detached
// from its trigger, or hanging outside the new window rectangle.
window.addEventListener('resize', () => {
    if (openMenuEl && openMenuTrigger && openMenuEl.classList.contains('show')) {
        positionMenu(openMenuEl, openMenuTrigger);
    }
});

// --- Tabs (request #14) ---------------------------------------------------------

/**
 * Switches tabs. The playlist tab reuses the existing slide-over panel rather than
 * duplicating the queue UI, so there is one implementation of the list.
 */
function setActiveTab(tab) {
    activeTab = tab;

    containerEl.classList.toggle('tab-settings-active', tab === 'settings');
    settingsTab?.classList.toggle('show', tab === 'settings');
    tagsTab?.classList.toggle('show', tab === 'tags');
    togglePlaylistPanel(tab === 'playlist');

    // Tags are read from disk, not from the in-memory metadata, because the
    // player's copy is a *resolved* guess (see library/metadata.js) rather than
    // what is actually stored in the file.
    if (tab === 'tags') loadTagsForCurrentTrack();

    tabPager?.querySelectorAll('.tab-dot').forEach((dot) => {
        dot.classList.toggle('active', dot.dataset.tab === tab);
    });

    // The main process resizes the window: a settings panel does not fit in a 180px dock.
    window.api.setActiveTab(tab);
}

// --- Equalizer (request #25) ----------------------------------------------------

/** Builds the ten band sliders once. */
function buildEqualizerUI() {
    if (!eqBandsEl || eqBandsEl.childElementCount > 0) return;

    const {PRESETS, BANDS, MIN_GAIN, MAX_GAIN} = window.RhythmEQ;

    for (const [key, preset] of Object.entries(PRESETS)) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = preset.label;
        eqPresetEl.appendChild(option);
    }
    const custom = document.createElement('option');
    custom.value = 'custom';
    custom.textContent = 'Custom';
    eqPresetEl.appendChild(custom);

    BANDS.forEach((frequency, index) => {
        const band = document.createElement('div');
        band.className = 'eq-band';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'eq-slider';
        slider.min = String(MIN_GAIN);
        slider.max = String(MAX_GAIN);
        slider.step = '0.5';
        slider.value = '0';
        slider.dataset.band = String(index);
        // Vertical sliders via orient/appearance are inconsistent across engines;
        // a rotated horizontal input renders identically everywhere.
        slider.addEventListener('input', () => {
            equalizer.setBandGain(index, parseFloat(slider.value));
            eqPresetEl.value = 'custom';
            persistEqualizer();
        });

        const label = document.createElement('span');
        label.className = 'eq-band-label';
        label.textContent = frequency >= 1000 ? `${frequency / 1000}k` : String(frequency);

        band.appendChild(slider);
        band.appendChild(label);
        eqBandsEl.appendChild(band);
    });
}

/** Pushes engine state back onto the sliders. */
function renderEqualizer() {
    if (!eqBandsEl) return;
    equalizer.gains.forEach((gain, index) => {
        const slider = eqBandsEl.querySelector(`[data-band="${index}"]`);
        if (slider) slider.value = String(gain);
    });
    if (eqPreampEl) eqPreampEl.value = String(equalizer.preampDb);
    if (eqPreampValueEl) eqPreampValueEl.textContent = `${equalizer.preampDb.toFixed(1)} dB`;
    if (eqEnabledEl) eqEnabledEl.checked = equalizer.enabled;
    if (eqPresetEl) eqPresetEl.value = equalizer.presetName;
    eqBandsEl.classList.toggle('disabled', !equalizer.enabled);
}

function persistEqualizer() {
    window.api.setStoreValue('equalizer', equalizer.toJSON());
}

// --- Work timer (request #26) ---------------------------------------------------

function renderTimer(remainingMs) {
    if (!timerReadoutEl) return;
    if (!sleepTimer.active) {
        timerReadoutEl.textContent = 'Off';
        timerReadoutEl.classList.remove('running');
        return;
    }
    timerReadoutEl.textContent = sleepTimer.waitingForTrackEnd
        ? 'After this song'
        : window.RhythmTimer.formatRemaining(remainingMs);
    timerReadoutEl.classList.add('running');
}

function onTimerFinished() {
    renderTimer(0);
    window.api.notify({
        title: 'Time is up',
        body: 'Music stopped. Time to get back to work.',
    });
    setPlaylistStatus('Timer finished - music stopped.');
}

function startTimer(minutes) {
    if (!minutes || minutes <= 0) return;
    sleepTimer.start(minutes, {finishTrack: Boolean(timerFinishTrackEl?.checked)});
    renderTimer(sleepTimer.remainingMs);
}

// --- Translation (request #15) --------------------------------------------------

/**
 * Translates the current lyrics and repaints them.
 *
 * Only the text is sent; timestamps stay local, so the synced-scroll logic is untouched
 * and a translated lyric still highlights in time with the music.
 */
async function toggleTranslation() {
    if (!lyrics || !lyrics.lines || lyrics.lines.length === 0) return;

    showTranslation = !showTranslation;
    translateToggleBtn?.classList.toggle('active', showTranslation);

    if (!showTranslation) {
        translatedLines = null;
        displayLyrics(lyrics, audio.ticket);
        return;
    }

    const ticket = audio.ticket;
    const sourceLines = lyrics.isSynced
        ? lyrics.lines.map((line) => line.text)
        : lyrics.lines.slice();

    setPlaylistStatus('Translating...');
    const result = await window.api.translateLyrics({
        songKey: getSongIdentifier(),
        lines: sourceLines,
        targetLanguage: translationLanguage,
    });

    // The user may have skipped tracks during the round trip.
    if (ticket !== audio.ticket) return;

    if (!result.ok) {
        setPlaylistStatus(`Translation failed: ${result.reason}`);
        showTranslation = false;
        translateToggleBtn?.classList.remove('active');
        return;
    }

    translatedLines = result.lines;
    lyricsContainer.classList.toggle('rtl', Boolean(result.rtl));

    const merged = lyrics.isSynced
        ? {isSynced: true, lines: lyrics.lines.map((line, i) => ({...line, text: translatedLines[i] || line.text}))}
        : {isSynced: false, lines: translatedLines};

    displayLyrics(merged, ticket);
    setPlaylistStatus(result.cached ? 'Translated (cached)' : 'Translated');
}

// --- Playlist Panel & Library Search (requests #16, #17) ------------------------

/** Brief transient message under the results list. */
function setPlaylistStatus(message) {
    if (playlistStatus) playlistStatus.textContent = message || '';
}

function togglePlaylistPanel(force) {
    isPlaylistVisible = force === undefined ? !isPlaylistVisible : Boolean(force);
    playlistPanel.classList.toggle('show', isPlaylistVisible);
    if (togglePlaylistLabel) {
        togglePlaylistLabel.textContent = isPlaylistVisible ? 'Hide Playlist' : 'Show Playlist';
    }
    if (isPlaylistVisible) {
        renderQueue();
        // Deferred so the CSS transition has started before focus scrolls the panel.
        setTimeout(() => librarySearchInput?.focus(), 60);
    }
}

/**
 * Builds one row. Rows are plain buttons rather than a list + delegation because each
 * needs its own secondary actions, and the counts here are small.
 */
function makeRow({title, subtitle, badge, active, onPlay, actions = []}) {
    const row = document.createElement('div');
    row.className = 'playlist-row' + (active ? ' active' : '');

    const main = document.createElement('button');
    main.className = 'playlist-row-main';
    main.addEventListener('click', onPlay);

    const titleEl2 = document.createElement('span');
    titleEl2.className = 'playlist-row-title';
    titleEl2.textContent = title;
    main.appendChild(titleEl2);

    if (subtitle) {
        const sub = document.createElement('span');
        sub.className = 'playlist-row-subtitle';
        sub.textContent = subtitle;
        main.appendChild(sub);
    }
    row.appendChild(main);

    if (badge) {
        const badgeEl = document.createElement('span');
        badgeEl.className = 'playlist-row-badge';
        badgeEl.textContent = badge;
        row.appendChild(badgeEl);
    }

    for (const action of actions) {
        const button = document.createElement('button');
        button.className = 'playlist-row-action';
        button.title = action.title;
        button.textContent = action.label;
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            action.onClick();
        });
        row.appendChild(button);
    }

    return row;
}

/** Shows the current queue, with the playing track highlighted. */
function renderQueue() {
    if (!playlistResults) return;
    playlistResults.innerHTML = '';

    if (playlist.length === 0) {
        setPlaylistStatus('Queue is empty. Open a file or folder to begin.');
        return;
    }

    setPlaylistStatus(`${playlist.length} track${playlist.length === 1 ? '' : 's'} in queue`);

    playlist.forEach((filePath, index) => {
        const name = filePath.split(/[\\/]/).pop();
        playlistResults.appendChild(makeRow({
            title: name,
            active: index === currentIndex,
            onPlay: () => playTrack(index),
            actions: [{
                label: '\u00d7',
                title: 'Remove from queue',
                onClick: () => removeFromQueue(index),
            }],
        }));
    });
}

/**
 * Removes one entry from the queue, keeping `currentIndex` pointing at the same track.
 * Getting this wrong silently shifts playback onto a neighbouring song.
 */
function removeFromQueue(index) {
    const removedPath = playlist[index];
    playlist.splice(index, 1);

    const originalIndex = originalPlaylist.indexOf(removedPath);
    if (originalIndex > -1) originalPlaylist.splice(originalIndex, 1);

    if (index < currentIndex) {
        currentIndex--;
    } else if (index === currentIndex) {
        // The playing track was removed. Stay on the same slot, which is now the
        // following track, and start it.
        currentIndex = Math.min(currentIndex, playlist.length - 1);
        if (playlist.length > 0) playTrack(currentIndex); else audio.unload();
    }

    renderQueue();
    savePlaybackState();
}

/** Renders search results: artists first, then individual tracks. */
async function runLibrarySearch(query) {
    if (!playlistResults) return;

    if (!query || query.trim().length === 0) {
        renderQueue();
        return;
    }

    const {artists, tracks} = await window.api.librarySearch(query);
    playlistResults.innerHTML = '';

    if (artists.length === 0 && tracks.length === 0) {
        setPlaylistStatus('No matches. Open a folder to build the library.');
        return;
    }

    setPlaylistStatus(`${artists.length} artist(s), ${tracks.length} track(s)`);

    for (const artist of artists) {
        playlistResults.appendChild(makeRow({
            title: artist.name,
            subtitle: `Play all ${artist.count} song${artist.count === 1 ? '' : 's'}`,
            badge: String(artist.count),
            onPlay: () => playArtist(artist.key, artist.name),
        }));
    }

    for (const track of tracks) {
        playlistResults.appendChild(makeRow({
            title: track.title,
            subtitle: track.artist,
            onPlay: () => loadPlaylistAndPlay([track.filePath]),
        }));
    }
}

/** Request #16: queue up everything by one artist. */
async function playArtist(artistKey, artistName) {
    const files = await window.api.libraryTracksByArtist(artistKey);
    if (!files || files.length === 0) {
        setPlaylistStatus(`No tracks found for ${artistName}.`);
        return;
    }
    loadPlaylistAndPlay(files);
    setPlaylistStatus(`Playing ${files.length} song(s) by ${artistName}`);
    if (librarySearchInput) librarySearchInput.value = '';
}

/**
 * Syncs the "Exclude from This Folder" menu item with the current track's state, so it
 * reads "Include" when the track is already excluded.
 */
async function refreshExclusionState(filePath) {
    if (!excludeTrackLabel || !filePath) return;
    const directory = filePath.replace(/[\\/][^\\/]*$/, '');
    currentExclusions = await window.api.getExclusions(directory);
    const isExcluded = currentExclusions.includes(filePath);
    excludeTrackLabel.textContent = isExcluded ? 'Include in This Folder' : 'Exclude from This Folder';
    excludeTrackBtn?.classList.toggle('active', isExcluded);
}

/** Request #17: play the liked songs as a queue. */
function playFavorites() {
    if (favoritesPlaylist.length === 0) {
        togglePlaylistPanel(true);
        setPlaylistStatus('No liked songs yet. Use the heart button to add some.');
        return;
    }
    loadPlaylistAndPlay([...favoritesPlaylist]);
    setPlaylistStatus(`Playing ${favoritesPlaylist.length} liked song(s)`);
}

// --- Core Music & Playlist Logic ---

/**
 * Advances to whatever should follow the track that just finished.
 * Split out of the old inline `onend` callback so the engine's 'ended' event and the
 * next button share one definition of "what comes next".
 */
function advanceAfterEnd() {
    if (loopMode === 'one') {
        playTrack(currentIndex);
        return;
    }

    const nextIndex = currentIndex + 1;
    if (nextIndex < playlist.length) {
        playTrack(nextIndex);
    } else if (loopMode === 'all' && playlist.length > 0) {
        playTrack(0);
    }
    // Otherwise: stay parked in the ENDED state. renderTransport() has already flipped
    // the button back to a play triangle, and pressing it restarts the track (#11, #21).
}

/**
 * Loads and (optionally) starts a track.
 *
 * Ordering note, and the whole point of request #18: the audio element is pointed at
 * the file FIRST, before the metadata parse is awaited. The element streams, so it can
 * begin playing off the first few buffered blocks while music-metadata is still reading
 * tags and decoding embedded cover art in the main process. Previously the await came
 * first and the entire UI sat frozen until a large file had been parsed.
 */
async function playTrack(index, options = {}) {
    const {startPaused = false, seekTime = 0} = options;

    if (index < 0 || index >= playlist.length) {
        audio.stop();
        renderTransport();
        return;
    }

    const filePath = playlist[index];

    // Guard against null/undefined entries in a restored playlist.
    if (typeof filePath !== 'string' || !filePath) {
        console.error(`Invalid playlist entry at index ${index}:`, filePath, '- skipping.');
        if (index + 1 < playlist.length) playTrack(index + 1);
        return;
    }

    currentIndex = index;

    // Kick off streaming immediately. Everything below races against this ticket.
    const ticket = audio.load(filePath, {autoplay: !startPaused, seek: seekTime});

    // Paint what we can know without parsing anything, so the UI never looks stalled.
    const fallbackName = filePath.split(/[\\/]/).pop();
    if (filenameEl) filenameEl.textContent = fallbackName;
    titleEl.textContent = fallbackName;
    artistEl.textContent = 'Loading...';
    progressBar.value = seekTime;
    progressBar.max = 0;
    updateProgressFill(seekTime, 0);
    lyricsContainer.innerHTML = '';
    lastActiveLyricIndex = -1;
    renderTransport();

    // Now the slow part, off the critical path.
    const songData = await window.api.getMetadata(filePath);

    // The user may have skipped on while we were parsing. Drop the stale result.
    if (ticket !== audio.ticket) return;

    currentSongData = songData;
    currentSound = audio;

    // A track change while the editor is open must reload it, or Save would
    // write the previous track's form into the new file.
    if (activeTab === 'tags') loadTagsForCurrentTrack();

    if (filenameEl) filenameEl.textContent = songData.basename;
    titleEl.textContent = songData.title;
    artistEl.textContent = songData.artist;

    const isVideo = filePath.toLowerCase().endsWith('.mp4');
    const albumArtSrc = songData.cover
        || (isVideo ? '../assets/images/placeholder-video.png' : '../assets/images/placeholder.png');
    albumArtEl.src = albumArtSrc;
    magnifiedAlbumArtEl.src = albumArtSrc;

    const embedded = processLyrics(songData.lyrics);
    lyrics = embedded;
    displayLyrics(embedded, ticket);

    updateLikeButtonUI();
    refreshExclusionState(filePath);
    publishRoomState();
    publishRoomLyrics();
    if (isPlaylistVisible) renderQueue();

    // Upgrade the displayed artist/title using the full parser. getMetadata() returns
    // raw tags and falls back to the bare filename; this applies the sibling-name and
    // folder analysis that request #2 is about.
    window.api.libraryResolveTrack(filePath).then((resolved) => {
        if (ticket !== audio.ticket || !resolved) return;
        if (resolved.artist) artistEl.textContent = resolved.artist;
        if (resolved.title) titleEl.textContent = resolved.title;
        currentSongData = {...currentSongData, artist: resolved.artist, title: resolved.title};
    });

    if (!embedded.isSynced) {
        searchAndDisplayOnlineLyrics(songData, false, ticket);
    }
}

async function loadPlaylistAndPlay(files) {
    if (!files || files.length === 0) return;

    // Request #13: honour the per-directory exclusion list. Excluded tracks stay on
    // disk but are dropped from any queue built from that folder.
    const directories = [...new Set(files.map(f => f.replace(/[\\/][^\\/]*$/, '')))];
    const excluded = new Set();
    for (const directory of directories) {
        const list = await window.api.getExclusions(directory);
        for (const entry of list) excluded.add(entry);
    }

    let usable = files.filter(f => !excluded.has(f));
    // If the user has excluded literally everything, play the folder rather than
    // silently doing nothing.
    if (usable.length === 0) usable = files;

    originalPlaylist = [...usable];
    playlist = isShuffled ? shuffleArray(usable) : [...usable];
    publishRoomLibrary();

    if (isPlaylistVisible) renderQueue();
    playTrack(0);
}

// --- App Entry Point & Event Listeners ---
document.addEventListener('DOMContentLoaded', () => {
    let uiLoopStarted = false;

    // ---- Engine events -------------------------------------------------------
    // Registered exactly once, rather than being rebuilt as callbacks on every Howl
    // instance. That was the structural reason transport state kept drifting.

    audio.on('statechange', () => renderTransport());

    audio.on('metadata', ({duration}) => {
        // Duration is known well before the file has finished buffering, so the
        // progress bar becomes usable almost immediately.
        progressBar.max = duration || 0;
        updateProgressFill(audio.seek(), duration);
        updateTimeDisplay();

        const songId = getSongIdentifier();
        currentLyricsOffset = (songId && lyricsOffsets[songId]) || 0;
        updateOffsetDisplay();
    });

    audio.on('buffered', () => updateProgressFill(audio.seek(), audio.duration()));

    audio.on('ended', () => {
        // Park the lyrics on the last line instead of leaving them mid-scroll.
        lastActiveLyricIndex = -1;
        advanceAfterEnd();
    });

    audio.on('error', ({code, src}) => {
        console.error(`Failed to load audio (code ${code}):`, src);
        titleEl.textContent = 'Error: Unplayable file';
        artistEl.textContent = currentSongData ? currentSongData.basename : '';

        // Skip forward, but only if there is somewhere to skip to — otherwise a
        // playlist of broken files would recurse until the stack gave out.
        if (currentIndex + 1 < playlist.length) {
            playTrack(currentIndex + 1);
        }
    });

    function startUiLoopOnce() {
        if (!uiLoopStarted) {
            requestAnimationFrame(updateUI);
            uiLoopStarted = true;
        }
    }

    /**
     * Loads essential app settings like theme, volume, opacity, etc., from storage.
     * This should be called on any type of startup.
     */
    async function loadAppSettings() {
        // Load settings that affect UI appearance first
        const savedTheme = await window.api.getStoreValue('colorTheme');
        const theme = await window.api.getStoreValue('theme');
        // colorTheme is authoritative; the old light/dark key is the fallback for
        // installs that predate the palettes.
        applyTheme(savedTheme || (theme === 'light' ? DEFAULT_LIGHT_THEME : DEFAULT_DARK_THEME), false);

        const opacity = await window.api.getStoreValue('windowOpacity', 0.85);
        transparencySlider.value = opacity;
        transparencyValue.textContent = `${Math.round(opacity * 100)}%`;
        containerEl.classList.toggle('is-opaque', opacity >= 1.0);

        const isVolumeBoosted = await window.api.getStoreValue('volumeBoost', false);
        volumeSlider.max = isVolumeBoosted ? '2' : '1';

        const version = await window.api.getAppVersion();
        if (versionMenuDisplay) {
            versionMenuDisplay.textContent = `v${version}`;
        }

        // Load audio and playback state
        const lastVolume = await window.api.getStoreValue('lastVolume');
        playbackVolume = lastVolume !== undefined ? lastVolume : 1.0;
        // Seed the engine so the first play() ramps to the right level rather than
        // starting at full blast and being corrected a frame later (#22).
        audio.setVolume(playbackVolume, {immediate: true});
        audio.setMuted(isMuted);

        const savedRate = await window.api.getStoreValue('playbackRate');
        playbackRate = audio.setRate(typeof savedRate === 'number' ? savedRate : 1.0);
        updateSpeedUI();

        // We no longer set volume here; it's set when a track loads.

        const savedOffsets = await window.api.getStoreValue('lyricsOffsets');
        if (savedOffsets) {
            lyricsOffsets = savedOffsets;
        }
        const savedFavorites = await window.api.getStoreValue('favoritesPlaylist');
        if (savedFavorites && Array.isArray(savedFavorites)) {
            favoritesPlaylist = savedFavorites;
        }

        const savedMagnifierState = await window.api.getStoreValue('magnifierEnabled');
        isMagnifierEnabled = savedMagnifierState !== false; // Default to true

        minimizeToTray = await window.api.getMinimizeToTray();
        updateTrayMenuUI();

        // Equalizer (#25). fromJSON only builds the graph if it was left enabled.
        const savedEq = await window.api.getStoreValue('equalizer');
        if (savedEq) equalizer.fromJSON(savedEq);
        renderEqualizer();

        // Translation (#15).
        const languages = await window.api.getLanguages();
        const translationConfig = await window.api.getTranslationConfig();
        translationLanguage = translationConfig.targetLanguage || 'en';

        if (translateLanguageEl) {
            translateLanguageEl.innerHTML = '';
            for (const language of languages) {
                const option = document.createElement('option');
                option.value = language.code;
                option.textContent = language.label;
                translateLanguageEl.appendChild(option);
            }
            translateLanguageEl.value = translationLanguage;
        }
        if (translateProviderEl) translateProviderEl.value = translationConfig.provider || 'google';
        if (translateEndpointEl) {
            translateEndpointEl.value = translationConfig.endpoint || '';
            translateEndpointEl.style.display =
                (translationConfig.provider === 'libre') ? 'block' : 'none';
        }

        // Sharing: restore the server URL and display name, never the secrets.
        const savedServer = await window.api.getStoreValue('roomServerUrl');
        if (savedServer && roomServerEl) roomServerEl.value = savedServer;
        const savedRoomName = await window.api.getStoreValue('roomDisplayName');
        if (savedRoomName && roomNameEl) roomNameEl.value = savedRoomName;
        renderRoomUI();

        // Headphone watcher (#3).
        const pauseOnUnplug = await window.api.getStoreValue('pauseOnUnplug');
        if (pauseOnUnplugEl) pauseOnUnplugEl.checked = Boolean(pauseOnUnplug);
        if (pauseOnUnplug) await outputWatcher.start();

        const isPinned = await window.api.getStoreValue('isPinned');
        pinBtn.classList.toggle('pinned', isPinned !== false);

        updateVolumeUI();
        updateAppSettingsMenu();
        updateLyricsDropdownMenu();
        updateMagnifierUI();
        updateLoopButtonUI();
    }

    /**
     * Restores the playlist and last played track from the previous session.
     */
    async function restoreLastPlaybackState() {
        // Restore last playlist
        const lastState = await window.api.getStoreValue('lastPlaybackState');
        if (lastState && lastState.playlist && lastState.lastPlayedPath) {
            originalPlaylist = lastState.playlist;
            playlist = [...originalPlaylist];
            isShuffled = lastState.isShuffled || false;
            if (isShuffled) {
                playlist = shuffleArray(playlist);
                shuffleBtn.classList.add('active');
            }

            loopMode = lastState.loopMode || 'none';
            updateLoopButtonUI();

            const lastTrackIndex = playlist.findIndex(path => path === lastState.lastPlayedPath);
            if (lastTrackIndex !== -1) {
                await playTrack(lastTrackIndex, {startPaused: true, seekTime: lastState.seek});
            }
        }
    }

    // --- Attach All Event Listeners ---

    // Playback Controls
    playPauseBtn.addEventListener('click', () => {
        if (currentSound) {
            // The engine handles the finished-track case itself: play() notices the
            // ENDED state (or a position at the very end) and rewinds before starting,
            // instead of seeking past the end and silently doing nothing (#21).
            audio.toggle();
        } else if (playlist.length > 0) {
            playTrack(0);
        }
    });

    prevBtn.addEventListener('click', () => {
        if (!currentSound) return;
        if (audio.seek() > 3) {
            audio.seek(0);
        } else {
            const previousIndex = currentIndex - 1;
            if (previousIndex >= 0) {
                playTrack(previousIndex);
            }
        }
    });

    nextBtn.addEventListener('click', () => {
        const nextIndex = currentIndex + 1;
        if (nextIndex < playlist.length) {
            playTrack(nextIndex);
        } else if (loopMode === 'all') {
            playTrack(0);
        }
    });

    // File Handling
    openFileBtn.addEventListener('click', async () => loadPlaylistAndPlay(await window.api.openFiles()));
    if (openFolderBtn) openFolderBtn.addEventListener('click', async () => loadPlaylistAndPlay(await window.api.openFolder()));
    albumArtEl.addEventListener('click', () => openFileBtn.click());


    // Sliders & Progress
    // Track the drag so updateUI() stops writing to the input while the user holds it.
    ['pointerdown', 'mousedown'].forEach(evt =>
        progressBar.addEventListener(evt, () => { isSeeking = true; }));
    ['pointerup', 'mouseup', 'pointercancel'].forEach(evt =>
        window.addEventListener(evt, () => { isSeeking = false; }));

    progressBar.addEventListener('input', () => {
        const value = parseFloat(progressBar.value);
        updateProgressFill(value, audio.duration());
        if (currentSound) audio.seek(value);
        updateTimeDisplay();
    });

    /**
     * Scroll-to-seek.
     *
     * Request #24: this used to be bound to the 4px-tall range input itself, so the
     * user had to land the cursor exactly on the bar. It now lives on a wrapper with
     * 10px of padding, giving a ~24px tall target.
     */
    const seekByWheel = (event) => {
        if (!currentSound) return;
        event.preventDefault();
        event.stopPropagation();

        // Shift gives fine control, matching the volume scroll modifier.
        const step = event.shiftKey ? 1 : 5;
        const seek = audio.seek() + (event.deltaY < 0 ? step : -step);
        const clamped = audio.seek(seek);
        progressBar.value = clamped;
        updateProgressFill(clamped, audio.duration());
        updateTimeDisplay();
    };

    (progressWrapper || progressBar).addEventListener('wheel', seekByWheel, {passive: false});

    // Middle-click anywhere in the padded strip jumps to that position.
    (progressWrapper || progressBar).addEventListener('auxclick', (event) => {
        if (event.button !== 1 || !currentSound) return;
        event.preventDefault();
        const rect = progressBar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        const target = audio.seek(ratio * audio.duration());
        progressBar.value = target;
        updateProgressFill(target, audio.duration());
    });

    volumeSlider.addEventListener('input', (e) => {
        const newVolume = parseFloat(e.target.value);
        playbackVolume = newVolume;
        isMuted = newVolume === 0;
        audio.setVolume(playbackVolume);
        updateVolumeUI();
        showVolumeFeedback(newVolume);
        window.api.setStoreValue('lastVolume', playbackVolume);
    });

    volumeBtn.addEventListener('click', () => {
        isMuted = !isMuted;
        audio.setMuted(isMuted);
        updateVolumeUI();
        showVolumeFeedback(isMuted ? 0 : playbackVolume);
    });

    volumeBoostBtn.addEventListener('click', () => {
        const isBoosting = !(parseFloat(volumeSlider.max) > 1.0);

        if (!isBoosting && playbackVolume > 1.0) {
            playbackVolume = 1.0;
            audio.setVolume(playbackVolume);
        }

        volumeSlider.max = isBoosting ? '2' : '1';
        updateVolumeUI();
        window.api.setStoreValue('volumeBoost', isBoosting);
        updateAppSettingsMenu();
    });

    // Window and System Controls
    pinBtn.addEventListener('click', async () => pinBtn.classList.toggle('pinned', await window.api.pinWindow()));
    minimizeBtn.addEventListener('click', () => window.api.minimizeWindow());
    closeBtn.addEventListener('click', () => window.api.closeWindow());

    // App Settings & Menus
    lightModeBtn.addEventListener('click', () => {
        // Flip to the counterpart palette rather than to a generic light sheet,
        // so the toggle and the swatch grid can never disagree.
        const wasLight = findTheme(currentThemeId).mode === 'light';
        applyTheme(wasLight ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME);
    });

    orientationBtn.addEventListener('click', () => {
        const isCurrentlyVertical = containerEl.classList.contains('vertical-mode');
        window.api.toggleOrientation(!isCurrentlyVertical);
    });

    toggleLyricsBtn.addEventListener('click', () => {
        areLyricsVisible = !areLyricsVisible;
        containerEl.classList.toggle('lyrics-hidden', !areLyricsVisible);
        window.api.toggleLyricsVisibility(areLyricsVisible);
        updateLyricsDropdownMenu();
    });

    toggleControlsBtn.addEventListener('click', () => {
        areLyricsControlsVisible = !areLyricsControlsVisible;
        containerEl.classList.toggle('lyrics-controls-hidden', !areLyricsControlsVisible);
        updateLyricsDropdownMenu();
    });

    toggleManualScrollBtn.addEventListener('click', () => {
        isManualScrollEnabled = !isManualScrollEnabled;
        containerEl.classList.toggle('manual-scroll-enabled', isManualScrollEnabled);
        updateLyricsDropdownMenu();
    });

    refetchLyricsBtn.addEventListener('click', () => {
        if (!currentSongData) {
            // Can't refetch if no song is loaded
            return;
        }
        // Call with 'true' to force a refetch, skipping the local cache
        searchAndDisplayOnlineLyrics(currentSongData, true);
    });

    // Dropdown menu logic. See openMenu()/positionMenu() above for the clamping
    // rules; this block is only wiring.
    DROPDOWNS.forEach((menuId, btnId) => {
        const toggleBtn = document.getElementById(btnId);
        const menu = document.getElementById(menuId);
        if (!toggleBtn || !menu) return;

        toggleBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            const isAlreadyOpen = menu.classList.contains('show');
            closeAllMenus();
            if (!isAlreadyOpen) openMenu(menu, toggleBtn);
        });

        // Arrow keys walk the items; Escape closes and returns focus to the
        // trigger. A menu you can open with the keyboard but not traverse is
        // worse than no keyboard support at all.
        menu.addEventListener('keydown', (event) => {
            const items = menuItems(menu);
            if (!items.length) return;
            const index = items.indexOf(document.activeElement);

            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                const next = index < 0
                    ? (step > 0 ? 0 : items.length - 1)
                    : (index + step + items.length) % items.length;
                items[next].focus();
            } else if (event.key === 'Home') {
                event.preventDefault();
                items[0].focus();
            } else if (event.key === 'End') {
                event.preventDefault();
                items[items.length - 1].focus();
            } else if (event.key === 'Escape' || event.key === 'Tab') {
                closeAllMenus();
                toggleBtn.focus();
            }
        });
    });

    // The opacity drawer is gone; opacity now lives in the Settings tab, so the
    // menu item navigates there instead of opening a second surface for one
    // slider.
    if (openTransparencyBtn) {
        openTransparencyBtn.addEventListener('click', () => setActiveTab('settings'));
    }
    if (settingsDrawer && closeDrawerBtn) {
        closeDrawerBtn.addEventListener('click', () => settingsDrawer.classList.remove('show'));
    }

    transparencySlider.addEventListener('input', () => {
        const opacityValue = parseFloat(transparencySlider.value);
        window.api.setOpacity(opacityValue);
        transparencyValue.textContent = `${Math.round(opacityValue * 100)}%`;
        containerEl.classList.toggle('is-opaque', opacityValue >= 1.0);
    });

    goToGithubBtn.addEventListener('click', () => {
        window.api.openGitHub();
    });

    aboutMeBtn.addEventListener('click', () => {
        window.api.openAuthorUrl();
    });

    // volumeContainer.addEventListener('wheel', (event) => {
    //     // Prevent the default scroll behavior
    //     event.preventDefault();
    //
    //     // Check for Shift key for fine-grained control
    //     const isFineControl = event.shiftKey;
    //     const volumeStep = isFineControl ? 0.01 : 0.05;
    //     const scrollDirection = event.deltaY < 0 ? 1 : -1; // Up: 1, Down: -1
    //
    //     // Calculate the new volume, ensuring it stays within the valid range (0 to max)
    //     let newVolume = playbackVolume + (scrollDirection * volumeStep);
    //     newVolume = Math.max(0, Math.min(parseFloat(volumeSlider.max), newVolume));
    //
    //     // Apply the new volume
    //     playbackVolume = parseFloat(newVolume.toFixed(2));
    //     isMuted = playbackVolume === 0;
    //     audio.setVolume(playbackVolume);
    //
    //     // Update the UI and save the state
    //     updateVolumeUI();
    //     window.api.setStoreValue('lastVolume', playbackVolume);
    // });

    lyricsControls.addEventListener('wheel', (event) => {
        // Do nothing if no song is loaded
        if (!currentSound) return;

        // Prevent the default scroll behavior
        event.preventDefault();

        // Define the adjustment step
        const offsetStep = 0.1;
        // Note: Scrolling UP feels like lyrics should come SOONER, so we DECREASE the offset.
        const scrollDirection = event.deltaY < 0 ? -1 : 1;

        // Apply the change
        currentLyricsOffset = parseFloat((currentLyricsOffset + (scrollDirection * offsetStep)).toFixed(2));

        // Update the UI
        updateOffsetDisplay();

        // Save the new offset value
        const songId = getSongIdentifier();
        if (songId) {
            lyricsOffsets[songId] = currentLyricsOffset;
            saveLyricsOffsets();
        }
    });

    // Other UI Listeners
    shuffleBtn.addEventListener('click', () => {
        isShuffled = !isShuffled;
        shuffleBtn.classList.toggle('active', isShuffled);
        if (playlist.length === 0) return;
        const currentTrack = playlist[currentIndex];
        playlist = isShuffled ? shuffleArray(originalPlaylist) : [...originalPlaylist];
        currentIndex = playlist.findIndex(track => track === currentTrack);
        if (currentIndex === -1 && isShuffled && originalPlaylist.length > 0) {
            // If the current track was removed from a shuffled playlist, find its original index
            const originalIndex = originalPlaylist.findIndex(track => track === currentTrack);
            if (originalIndex !== -1) currentIndex = originalIndex;
        }
    });

    loopBtn.addEventListener('click', () => {
        const modes = ['none', 'all', 'one'];
        const currentModeIndex = modes.indexOf(loopMode);
        loopMode = modes[(currentModeIndex + 1) % modes.length];

        updateLoopButtonUI();
    });

    // Speed control (#19 / #23).
    if (speedMenu) {
        speedMenu.querySelectorAll('[data-rate]').forEach((item) => {
            item.addEventListener('click', () => setPlaybackRate(parseFloat(item.dataset.rate)));
        });
    }

    // Scrolling over the speed button nudges it in 0.05 steps.
    if (speedBtn) {
        speedBtn.addEventListener('wheel', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const delta = event.deltaY < 0 ? 0.05 : -0.05;
            setPlaybackRate(parseFloat((playbackRate + delta).toFixed(2)));
        }, {passive: false});
    }

    // --- Tabs, EQ, timer, translation (requests #14, #25, #26, #15, #3) ------

    buildEqualizerUI();
    initTagEditor();

    tabPager?.querySelectorAll('.tab-dot').forEach((dot) => {
        dot.addEventListener('click', () => setActiveTab(dot.dataset.tab));
    });

    if (eqEnabledEl) {
        eqEnabledEl.addEventListener('change', () => {
            equalizer.setEnabled(eqEnabledEl.checked);
            renderEqualizer();
            persistEqualizer();
        });
    }

    if (eqPresetEl) {
        eqPresetEl.addEventListener('change', () => {
            if (eqPresetEl.value === 'custom') return;
            equalizer.applyPreset(eqPresetEl.value);
            renderEqualizer();
            persistEqualizer();
        });
    }

    if (eqPreampEl) {
        eqPreampEl.addEventListener('input', () => {
            equalizer.setPreamp(parseFloat(eqPreampEl.value));
            if (eqPreampValueEl) {
                eqPreampValueEl.textContent = `${equalizer.preampDb.toFixed(1)} dB`;
            }
            persistEqualizer();
        });
    }

    // Timer presets.
    if (timerPresetsEl) {
        for (const preset of window.RhythmTimer.PRESETS) {
            const chip = document.createElement('button');
            chip.className = 'chip';
            chip.textContent = preset.label;
            chip.addEventListener('click', () => startTimer(preset.minutes));
            timerPresetsEl.appendChild(chip);
        }
    }

    timerStartBtn?.addEventListener('click', () => startTimer(parseInt(timerCustomEl.value, 10)));
    timerCancelBtn?.addEventListener('click', () => {
        sleepTimer.cancel();
        renderTimer(0);
    });

    // "Stop after this song" mode needs to hear about track ends.
    audio.on('ended', () => sleepTimer.trackEnded());

    translateToggleBtn?.addEventListener('click', () => toggleTranslation());

    if (translateLanguageEl) {
        translateLanguageEl.addEventListener('change', async () => {
            translationLanguage = translateLanguageEl.value;
            const config = await window.api.getTranslationConfig();
            await window.api.setTranslationConfig({...config, targetLanguage: translationLanguage});
            // Re-translate immediately if translated lyrics are on screen.
            if (showTranslation) {
                showTranslation = false;
                toggleTranslation();
            }
        });
    }

    const saveTranslationConfig = async () => {
        await window.api.setTranslationConfig({
            provider: translateProviderEl?.value || 'google',
            endpoint: translateEndpointEl?.value || '',
            targetLanguage: translationLanguage,
        });
    };
    translateProviderEl?.addEventListener('change', () => {
        // The endpoint field is only meaningful for a self-hosted provider.
        if (translateEndpointEl) {
            translateEndpointEl.style.display =
                translateProviderEl.value === 'libre' ? 'block' : 'none';
        }
        saveTranslationConfig();
    });
    translateEndpointEl?.addEventListener('change', saveTranslationConfig);

    // Pause on headphone removal (#3).
    if (pauseOnUnplugEl) {
        pauseOnUnplugEl.addEventListener('change', async () => {
            window.api.setStoreValue('pauseOnUnplug', pauseOnUnplugEl.checked);
            if (pauseOnUnplugEl.checked) await outputWatcher.start(); else outputWatcher.stop();
        });
    }

    // --- Rooms / streaming ----------------------------------------------------

    roomHostBtn?.addEventListener('click', async () => {
        roomHostBtn.disabled = true;
        const result = await window.api.roomCreate({
            serverUrl: roomServerEl.value.trim(),
            secret: roomSecretEl.value,
            name: roomNameEl.value.trim() || 'Host',
            password: roomPasswordEl.value,
            everyoneCanControl: roomEveryoneControlsEl.checked,
        });
        roomHostBtn.disabled = false;

        if (!result.ok) return setPlaylistStatus(`Could not start room: ${result.error}`);

        room = {connected: true, isHost: true, code: result.room.code,
                serverUrl: roomServerEl.value.trim(), members: []};
        renderRoomUI();

        // Remember the server so the next session does not need retyping. The secret
        // and the room password are deliberately NOT persisted.
        window.api.setStoreValue('roomServerUrl', roomServerEl.value.trim());
        window.api.setStoreValue('roomDisplayName', roomNameEl.value.trim());

        await publishRoomLibrary();
        publishRoomSettings();
        publishRoomState();
        publishRoomLyrics();
    });

    roomJoinBtn?.addEventListener('click', async () => {
        roomJoinBtn.disabled = true;
        const result = await window.api.roomJoin({
            serverUrl: roomServerEl.value.trim(),
            code: roomJoinCodeEl.value.trim().toUpperCase(),
            name: roomNameEl.value.trim() || 'Guest',
            password: roomPasswordEl.value,
        });
        roomJoinBtn.disabled = false;

        if (!result.ok) return setPlaylistStatus(`Could not join: ${result.error}`);

        room = {connected: true, isHost: false, code: result.room.code,
                serverUrl: roomServerEl.value.trim(), members: []};
        renderRoomUI();
    });

    roomLeaveBtn?.addEventListener('click', async () => {
        await window.api.roomLeave();
        room = {connected: false, isHost: false, code: null, serverUrl: null, members: []};
        renderRoomUI();
    });

    roomCopyLinkBtn?.addEventListener('click', () => {
        if (!room.code || !room.serverUrl) return;
        window.api.copyToClipboard(`${room.serverUrl}/r/${room.code}`);
        roomCopyLinkBtn.classList.add('copy-success');
        setTimeout(() => roomCopyLinkBtn.classList.remove('copy-success'), 1200);
    });

    // Server -> app events.
    // Member-side: follow the host.
    window.api.onRoomEvent('room:state', ({state}) => applyRemoteState(state));
    window.api.onRoomEvent('room:settings', ({settings}) => applyRemoteSettings(settings));
    window.api.onRoomEvent('room:lyrics', ({lyrics: payload}) => applyRemoteLyrics(payload));
    window.api.onRoomEvent('room:library', ({library}) => {
        if (room.isHost || !library) return;
        setPlaylistStatus(`Host shared ${(library.queue || []).length} tracks`);
    });
    window.api.onRoomEvent('room:host-gone', () => {
        audio.pause();
        setPlaylistStatus('Host disconnected - waiting for them to return');
    });
    window.api.onRoomEvent('room:host-back', () => setPlaylistStatus('Host is back'));

    // Drift correction runs once a second while following a room.
    setInterval(correctRemoteDrift, 1000);

    window.api.onRoomEvent('room:track-ids', (map) => {
        trackIdCache = new Map(Object.entries(map || {}));
        publishRoomState();
    });

    window.api.onRoomEvent('room:members', ({members}) => {
        room.members = members || [];
        renderRoomUI();
    });

    window.api.onRoomEvent('room:control', (message) => {
        if (room.isHost) applyRoomControl(message);
    });

    window.api.onRoomEvent('room:welcome', (message) => {
        room.members = message.members || room.members;
        if (message.role) room.isHost = message.role === 'host';
        renderRoomUI();
    });

    window.api.onRoomEvent('room:disconnected', () => {
        room.connected = false;
        renderRoomUI();
        setPlaylistStatus('Room disconnected');
    });

    window.api.onRoomEvent('room:reconnecting', () => setPlaylistStatus('Reconnecting to room...'));
    window.api.onRoomEvent('room:kicked', () => {
        room = {connected: false, isHost: false, code: null, serverUrl: null, members: []};
        renderRoomUI();
        setPlaylistStatus('You were removed from the room');
    });
    window.api.onRoomEvent('room:error', ({error}) => setPlaylistStatus(`Room: ${error}`));

    // Publish state on a timer rather than on every event: members extrapolate between
    // updates, so 2Hz is ample and keeps traffic low with many listeners.
    roomPublishTimer = setInterval(publishRoomState, 500);

    // Push a state update the moment anything meaningful changes, so a press feels instant.
    audio.on('statechange', () => publishRoomState());
    audio.on('ratechange', () => { publishRoomState(); publishRoomSettings(); });

    // --- Tray (request #5) ---------------------------------------------------

    const updateTrayMenuUI = () => {
        if (!minimizeTrayLabel) return;
        minimizeTrayLabel.textContent = minimizeToTray
            ? 'Disable Minimize to Tray'
            : 'Enable Minimize to Tray';
        minimizeTrayBtn?.classList.toggle('active', minimizeToTray);
    };

    if (minimizeTrayBtn) {
        minimizeTrayBtn.addEventListener('click', async () => {
            minimizeToTray = await window.api.setMinimizeToTray(!minimizeToTray);
            updateTrayMenuUI();
        });
    }

    if (hideToTrayBtn) {
        hideToTrayBtn.addEventListener('click', () => window.api.hideToTray());
    }

    // Surface shortcut collisions rather than leaving the user wondering why their
    // hotkey does nothing.
    window.api.onShortcutConflicts((conflicts) => {
        if (!conflicts || conflicts.length === 0) return;
        const names = conflicts.map(c => c.accelerator).join(', ');
        console.warn('Global shortcuts unavailable:', conflicts);
        setPlaylistStatus(`Shortcut(s) unavailable: ${names}`);
    });

    toggleMagnifierBtn.addEventListener('click', () => {
        isMagnifierEnabled = !isMagnifierEnabled;
        window.api.setStoreValue('magnifierEnabled', isMagnifierEnabled);
        updateMagnifierUI();
    });

    likeBtn.addEventListener('click', () => {
        if (currentIndex < 0) return; // No song loaded

        const currentPath = playlist[currentIndex];
        const favoriteIndex = favoritesPlaylist.indexOf(currentPath);

        if (favoriteIndex > -1) {
            favoritesPlaylist.splice(favoriteIndex, 1); // Unlike
        } else {
            favoritesPlaylist.push(currentPath); // Like
        }

        updateLikeButtonUI();
        saveFavorites();
    });

    // Lyrics Offset Press-and-Hold Logic
    const setupHoldListener = (buttonElement, adjustment) => {
        let holdDelayTimer = null;
        let holdRepeatTimer = null;
        const HOLD_DELAY_MS = 500;
        const HOLD_INTERVAL_MS = 100;

        const stopHold = () => {
            clearTimeout(holdDelayTimer);
            clearInterval(holdRepeatTimer);
            saveLyricsOffsets(); // Save the final value when the user lets go
        };

        const applyChange = () => {
            currentLyricsOffset = parseFloat((currentLyricsOffset + adjustment).toFixed(2));
            updateOffsetDisplay();
            const songId = getSongIdentifier();
            if (songId) {
                lyricsOffsets[songId] = currentLyricsOffset;
            }
        };

        const startHold = () => {
            applyChange(); // Immediate change on first click
            holdDelayTimer = setTimeout(() => {
                holdRepeatTimer = setInterval(applyChange, HOLD_INTERVAL_MS);
            }, HOLD_DELAY_MS);
        };

        buttonElement.addEventListener('mousedown', startHold);
        ['mouseup', 'mouseleave'].forEach(evt => buttonElement.addEventListener(evt, stopHold));
    };

    if (lyricsOffsetMinusBtn && lyricsOffsetPlusBtn) {
        setupHoldListener(lyricsOffsetMinusBtn, -0.1);
        setupHoldListener(lyricsOffsetPlusBtn, 0.1);
    }

    // --- File Context Menu (request #13) -------------------------------------

    /** The path of the track the file menu acts on, or null if nothing is loaded. */
    const activePath = () =>
        (currentIndex > -1 && playlist[currentIndex]) ? playlist[currentIndex] : null;

    /** Flashes the item green so the user knows a clipboard write happened. */
    const flash = (element) => {
        if (!element) return;
        element.classList.add('copy-success');
        setTimeout(() => element.classList.remove('copy-success'), 1200);
    };

    /** Wires a menu item that needs the current path. */
    const onFileAction = (button, handler) => {
        if (!button) return;
        button.addEventListener('click', async () => {
            const filePath = activePath();
            if (!filePath) return;
            await handler(filePath, button);
        });
    };

    onFileAction(showFileBtn, (filePath) => window.api.showFileInFolder(filePath));
    onFileAction(openFileExternalBtn, (filePath) => window.api.openPath(filePath));
    onFileAction(openFolderExternalBtn, (filePath) => window.api.openContainingFolder(filePath));

    onFileAction(copyPathBtn, (filePath, button) => {
        window.api.copyToClipboard(filePath);
        flash(button);
    });

    onFileAction(copyFilenameBtn, (filePath, button) => {
        window.api.copyToClipboard(filePath.split(/[\\/]/).pop());
        flash(button);
    });

    onFileAction(copyFolderPathBtn, (filePath, button) => {
        window.api.copyToClipboard(filePath.replace(/[\\/][^\\/]*$/, ''));
        flash(button);
    });

    onFileAction(copyTagsBtn, async (filePath, button) => {
        // Re-resolve rather than reading the on-screen labels: this runs the full
        // tag + filename + sibling analysis, so it is right even when the tags are blank.
        const resolved = await window.api.libraryResolveTrack(filePath);
        window.api.copyToClipboard(`${resolved.title} - ${resolved.artist}`);
        flash(button);
    });

    onFileAction(excludeTrackBtn, async (filePath) => {
        const {excluded} = await window.api.toggleExclusion(filePath);
        await refreshExclusionState(filePath);

        if (excluded) {
            // Drop it from the live queue immediately, otherwise the exclusion appears
            // to do nothing until the folder is reopened.
            const index = playlist.indexOf(filePath);
            if (index > -1) removeFromQueue(index);
        }
    });

    onFileAction(deleteFileBtn, async (filePath) => {
        const name = filePath.split(/[\\/]/).pop();
        // shell.trashItem is recoverable, but this is still destructive enough to confirm.
        if (!window.confirm(`Move to trash?\n\n${name}`)) return;

        const result = await window.api.deleteFile(filePath);
        if (!result.ok) {
            setPlaylistStatus(`Could not delete: ${result.reason}`);
            return;
        }
        const index = playlist.indexOf(filePath);
        if (index > -1) removeFromQueue(index);
    });

    // --- Playlist panel + search --------------------------------------------

    if (togglePlaylistBtn) togglePlaylistBtn.addEventListener('click', () => togglePlaylistPanel());
    if (closePlaylistBtn) closePlaylistBtn.addEventListener('click', () => togglePlaylistPanel(false));
    if (playFavoritesBtn) playFavoritesBtn.addEventListener('click', () => playFavorites());

    if (librarySearchInput) {
        // Debounced: the index is searched on every keystroke over IPC, and a fast
        // typist would otherwise queue a dozen round trips.
        librarySearchInput.addEventListener('input', () => {
            clearTimeout(searchDebounce);
            searchDebounce = setTimeout(() => runLibrarySearch(librarySearchInput.value), 180);
        });

        librarySearchInput.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                librarySearchInput.value = '';
                renderQueue();
                togglePlaylistPanel(false);
            }
        });
    }

    window.api.onScanProgress(({found}) => {
        if (isPlaylistVisible) setPlaylistStatus(`Scanning... ${found} files found`);
    });

    window.api.onScanTruncated(({count}) => {
        setPlaylistStatus(`Stopped at ${count} files — that folder is very large.`);
    });

    window.api.onLibraryUpdated(({trackCount}) => {
        if (isPlaylistVisible && !librarySearchInput?.value) {
            setPlaylistStatus(`Library: ${trackCount} tracks indexed`);
        }
    });

    // --- Application Startup Logic ---

    // Fired on a normal app launch.
    window.api.onRestoreState(async () => {
        await loadAppSettings();
        await restoreLastPlaybackState();
        startUiLoopOnce();
    });

    // Fired when the app is launched by opening a file.
    window.api.onFilePathReceived(async (filePath) => {
        await loadAppSettings(); // Still need to load theme, volume, etc.
        loadPlaylistAndPlay([filePath]); // But play the new file.
        startUiLoopOnce();
    });

    // --- Global Volume Scroll ---
    containerEl.addEventListener('wheel', (event) => {
        // Define selectors for areas that have their own scroll behavior and should be ignored.
        const ignoredSelectors = [
            '#progress-bar',
            '.volume-container',
            '.lyrics-controls',
            '.lyrics-container',
            '.settings-drawer',
            '.dropdown-menu',
            'input[type="range"]'
        ];

        // Check if the scroll event originated from within an ignored area.
        if (ignoredSelectors.some(selector => event.target.closest(selector))) {
            return; // If so, do nothing and let the element handle its own scroll.
        }

        // If the scroll is in a "safe" area, control the main volume.
        event.preventDefault();

        const isFineControl = event.shiftKey;
        const volumeStep = isFineControl ? 0.01 : 0.05;
        const scrollDirection = event.deltaY < 0 ? 1 : -1; // Up increases volume, Down decreases.

        let newVolume = playbackVolume + (scrollDirection * volumeStep);
        // Clamp the new volume within the allowed range (0 to max, which could be 2 for boost).
        newVolume = Math.max(0, Math.min(parseFloat(volumeSlider.max), newVolume));

        // Apply the new volume and update the UI/state directly.
        playbackVolume = parseFloat(newVolume.toFixed(2));
        showVolumeFeedback(playbackVolume);
        isMuted = playbackVolume === 0;
        audio.setVolume(playbackVolume);

        updateVolumeUI(); // This updates the slider's visual position and the mute icon.
        window.api.setStoreValue('lastVolume', playbackVolume);
    });

    // Signal to the main process that the renderer is ready for startup instructions.
    window.api.rendererReady();
});


// --- Global Event Listeners ---

// Close dropdowns on outside click. Clicks inside a menu are excluded so that a
// non-dismissing row (the version readout, a label) does not shut the menu.
window.addEventListener('click', (event) => {
    if (event.target.closest?.('.dropdown-menu')) return;
    closeAllMenus();
});

// --- Drag and Drop (whole window) ---
//
// Request #20: these were bound to #container, so drops over the lyrics pane, the
// dropdown menus or the settings drawer fell through to the default handler and
// Electron navigated the window to the dropped file. Binding to `document` catches
// every descendant regardless of which child is under the cursor.
//
// dragenter/dragleave fire once per element boundary crossed, so a naive
// add/remove flickers constantly as the cursor moves between children. A depth
// counter tracks how many nested elements we are currently inside.
let dragDepth = 0;

const isFileDrag = (event) =>
    Array.from(event.dataTransfer?.types || []).includes('Files');

document.addEventListener('dragenter', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth++;
    containerEl.classList.add('drag-over');
});

document.addEventListener('dragover', (event) => {
    if (!isFileDrag(event)) return;
    // Required, or the browser refuses the drop entirely.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
});

document.addEventListener('dragleave', (event) => {
    if (!isFileDrag(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) containerEl.classList.remove('drag-over');
});

document.addEventListener('drop', async (event) => {
    event.preventDefault();
    dragDepth = 0;
    containerEl.classList.remove('drag-over');

    const droppedPaths = Array.from(event.dataTransfer.files)
        .map(f => window.api.getPathForFile ? window.api.getPathForFile(f) : f.path)
        .filter(Boolean);

    if (droppedPaths.length === 0) return;

    const processedFiles = await window.api.processDroppedPaths(droppedPaths);
    if (processedFiles && processedFiles.length > 0) {
        loadPlaylistAndPlay(processedFiles);
    }
});

// Keyboard Shortcuts
window.addEventListener('keydown', (event) => {
    // Escape backs out one layer at a time: menu, then panel, then nothing.
    // It has to run before the INPUT guard so it still works from the search box.
    if (event.key === 'Escape') {
        if (document.querySelector('.dropdown-menu.show')) {
            closeAllMenus();
            openMenuTrigger?.focus();
            event.preventDefault();
            return;
        }
        if (activeTab !== 'player') {
            setActiveTab('player');
            event.preventDefault();
            return;
        }
    }

    if (event.target.tagName === 'INPUT') return; // Ignore inputs

    let handled = false;
    if (event.shiftKey) {
        // --- Shortcuts with Shift ---
        if (event.code === 'ArrowRight') {
            nextBtn.click();
            handled = true;
        } else if (event.code === 'ArrowLeft') {
            prevBtn.click();
            handled = true;
        }
    } else {
        // --- Shortcuts without Shift ---
        const seekTime = 5; // 5 seconds
        if (event.code === 'ArrowRight' && currentSound) {
            audio.seek(audio.seek() + seekTime);
            handled = true;
        } else if (event.code === 'ArrowLeft' && currentSound) {
            audio.seek(audio.seek() - seekTime);
            handled = true;
        } else if (event.code === 'Space') {
            playPauseBtn.click();
            handled = true;
        } else if (event.code === 'ArrowUp') {
            volumeSlider.dispatchEvent(new Event('input', {detail: {value: Math.min(parseFloat(volumeSlider.max), playbackVolume + 0.05)}}));
            handled = true;
        } else if (event.code === 'ArrowDown') {
            volumeSlider.dispatchEvent(new Event('input', {detail: {value: Math.max(0, playbackVolume - 0.05)}}));
            handled = true;
        } else if (event.code === 'KeyM') {
            volumeBtn.click();
            handled = true;
        } else if (event.code === 'BracketRight') {
            setPlaybackRate(parseFloat((playbackRate + 0.05).toFixed(2)));
            handled = true;
        } else if (event.code === 'BracketLeft') {
            setPlaybackRate(parseFloat((playbackRate - 0.05).toFixed(2)));
            handled = true;
        } else if (event.code === 'Backslash') {
            setPlaybackRate(1.0);
            handled = true;
        }
    }

    if (handled) event.preventDefault();
});

// Save state periodically and before closing
setInterval(savePlaybackState, 5000);
window.addEventListener('beforeunload', savePlaybackState);

// API Listeners from Main Process
window.api.onMediaKey((command) => {
    const actions = {
        'play-pause': () => playPauseBtn.click(),
        'next': () => nextBtn.click(),
        'prev': () => prevBtn.click()
    };
    actions[command]?.();
});

window.api.onSetOrientationClass((isVertical) => {
    containerEl.classList.toggle('vertical-mode', isVertical);
});