// --- State Variables ---
// The engine instance. `currentSound` remains as an alias so the many existing call
// sites that do currentSound.seek()/.duration()/.play()/.pause() keep working — the
// engine deliberately exposes a Howler-compatible surface for those four methods.
const audio = window.RhythmAudio.engine;
const AUDIO_STATE = window.RhythmAudio.STATE;
window.addEventListener('error', () => window.api.diagnosticEvent('renderer:error', {reason: 'script-error'}));
window.addEventListener('unhandledrejection', () => window.api.diagnosticEvent('renderer:error', {reason: 'unhandled-promise'}));

let currentSound = null;
let currentSongData = null;
let activePlaybackFilePath = null;
let playlist = [];
let originalPlaylist = [];
let currentPlaylistName = 'Queue';
function updateCurrentPlaylistLabel(){
    const button=document.getElementById('current-playlist');
    document.getElementById('current-playlist-name').textContent=currentPlaylistName;
    button.title=`${currentPlaylistName} — open current queue`;
    button.setAttribute('aria-label',`Current playlist: ${currentPlaylistName}. Open queue.`);
}
function selectedPlaylistName(){
    const select=document.getElementById('named-playlist-select');
    return select?.selectedOptions[0]?.textContent.replace(/ \(\d+\)$/,'')||'Playlist';
}
let currentIndex = -1;
let isPlaying = false;
let timeDisplayMode = 'remaining';
let isMuted = false;
let loopMode = 'none';
let isShuffled = false;
let lyrics = {isSynced: false, hasWordTiming: false, lines: []};
let favoritesPlaylist = [];
let isMagnifierEnabled = true;
let lastActiveLyricIndex = -1;
let lastActiveWordIndex = -1;
let lyricsOffsets = {};
let lyricsConfig = null;
// The lyric exactly as the provider gave it. The editor and the .lrc exporter need the
// original text; our parsed form has already thrown away the stamps.
let rawLyricsText = null;
let lyricsSource = null;
let isLyricsFullscreen = false;
// Editor state. `editorLines` is the single source of truth for both modes:
// [{text, time}] where time is null until the line has been tapped.
let isLyricsOverlayOpen = false;
// The last line pushed to the overlay, so the per-frame loop can skip the IPC hop when
// nothing has changed. At 60fps an unconditional send would be 60 messages a second to
// render one unchanged line.
let lastOverlayLine = null;
let isLyricsEditorOpen = false;
let editorMode = 'text';
let editorLines = [];
let editorCursor = 0;
let editorClockTimer = null;
let editorReturnTab = 'player';
// Where the lyric strip lives when it is not in full screen, so it can be put back
// exactly where it came from rather than appended to a guess.
let lyricsHomeParent = null;
let lyricsHomeNextSibling = null;
let offsetSaveTimer = null;
let loadTicket = 0;
let currentLyricsOffset = 0;
let playbackVolume = 1.0;
let areLyricsVisible = true;
let volumeOverlayTimeout = null;
let areLyricsControlsVisible = true;
let isManualScrollEnabled = false;
let lyricsSelectable = false;
let queueMode = false;
let playbackRate = 1.0;
let isSeeking = false;
let isPlaylistVisible = false;
let currentExclusions = [];
let searchDebounce = null;
let minimizeToTray = false;
let activeTab = 'player';
let savedWindowOpacity=0.85;
let opacityHovered=false;
let opacityDragging=false;
function refreshWindowOpacity(){
    const visibleOpacity=!isLocked&&opacityHovered&&!opacityDragging&&savedWindowOpacity<0.8?0.85:savedWindowOpacity;
    window.api.previewOpacity(visibleOpacity);
}

// Feature modules built on the Phase 2 audio graph.
const equalizer = new window.RhythmEQ.Equalizer(audio);
const sleepTimer = new window.RhythmTimer.SleepTimer({
    engine: audio,
    onTick: (remaining) => renderTimer(remaining),
    onFinish: (reason) => onTimerFinished(reason),
});
const outputWatcher = new window.RhythmDevices.OutputDeviceWatcher({
    isPlaying: () => audio.isPlaying() || audio.isBusy(),
    activeOutputs: () => [audio.outputDeviceId || 'default', ...audio.listOutputs().map((item) => item.deviceId)],
    getContext: () => audio.ctx,
    onDisconnect: () => {
        pauseForInterruption('headphones');
    },
});
const interruptionWatcher=new window.RhythmDevices.AudioInterruptionWatcher({
    getContext:()=>audio.ctx,isPlaying:()=>audio.isPlaying()||audio.isBusy(),onInterrupt:pauseForInterruption,
});
function pauseForInterruption(reason){
    if(!audio.isPlaying()&&!audio.isBusy())return;
    audio.interrupt();
    const messages={headphones:'Paused — active headphones disconnected',communication:'Paused — a call started',
        sleep:'Paused — computer going to sleep','audio-focus':'Paused — system audio interruption','media-pause':'Paused by the system or headphones'};
    setPlaylistStatus(messages[reason]||'Paused by the system');
    savePlaybackState();
}
window.api.onAudioInterruption(({reason})=>pauseForInterruption(reason));
function renderInterruptionStatus(status){
    const element=document.getElementById('interruption-status');
    if(!element)return;
    element.textContent=status.native==='ready'?'Windows call detection active.':
        status.native==='starting'?'Starting Windows call detection…':
        status.native==='unavailable'?'Windows call detection unavailable. Media-pause and device-disconnect signals still work.':
        status.native==='disabled'?'Automatic audio-interruption detection is off.':'Listening for available system audio-interruption events.';
}
window.api.onAudioInterruptionStatus(renderInterruptionStatus);

// Translation state for the currently displayed lyrics.
let translationLanguage = 'en';
let showTranslation = false;
let translatedLines = null;

// Room / streaming state.
let room = {connected: false, isHost: false, code: null, serverUrl: null,
            members: [], role: 'listener', remoteLibrary: {tracks: [], queue: []}};
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
const lyricsFontSizeEl = document.getElementById('lyrics-font-size');
const lyricsFontSizeValueEl = document.getElementById('lyrics-font-size-value');
const lyricsLineHeightEl = document.getElementById('lyrics-line-height');
const lyricsLineHeightValueEl = document.getElementById('lyrics-line-height-value');
const lyricsFontWeightEl = document.getElementById('lyrics-font-weight');
const lyricsAlignEl = document.getElementById('lyrics-align');
const lyricsFontFamilyEl = document.getElementById('lyrics-font-family');
const lyricsGeniusTokenEl = document.getElementById('lyrics-genius-token');
const lyricsAutosaveEl = document.getElementById('lyrics-autosave-lrc');
const lyricsSourceValueEl = document.getElementById('lyrics-source-value');
const fullscreenLyricsBtn = document.getElementById('fullscreen-lyrics-btn');
const editLyricsBtn = document.getElementById('edit-lyrics-btn');
const lyricsOverlayBtn = document.getElementById('lyrics-overlay-btn');
const lyricsOverlayLabel = document.getElementById('lyrics-overlay-label');
const lyricsEditorEl = document.getElementById('lyrics-editor');
const lyricsEditorTitleEl = document.getElementById('lyrics-editor-title');
const lyricsEditorArtistEl = document.getElementById('lyrics-editor-artist');
const lyricsEditorCloseBtn = document.getElementById('lyrics-editor-close');
const lyricsEditorModeTextBtn = document.getElementById('lyrics-editor-mode-text');
const lyricsEditorModeSyncBtn = document.getElementById('lyrics-editor-mode-sync');
const lyricsEditorTextPane = document.getElementById('lyrics-editor-text-pane');
const lyricsEditorSyncPane = document.getElementById('lyrics-editor-sync-pane');
const lyricsEditorTextarea = document.getElementById('lyrics-editor-textarea');
const lyricsEditorLinesEl = document.getElementById('lyrics-editor-lines');
const lyricsEditorTapBtn = document.getElementById('lyrics-editor-tap');
const lyricsEditorPlayBtn = document.getElementById('lyrics-editor-play');
const lyricsEditorBackBtn = document.getElementById('lyrics-editor-back');
const lyricsEditorUndoBtn = document.getElementById('lyrics-editor-undo');
const lyricsEditorRestartBtn = document.getElementById('lyrics-editor-restart');
const lyricsEditorClockEl = document.getElementById('lyrics-editor-clock');
const lyricsEditorStatusEl = document.getElementById('lyrics-editor-status');
const lyricsEditorSaveBtn = document.getElementById('lyrics-editor-save');
const lyricsEditorWriteLrcEl = document.getElementById('lyrics-editor-write-lrc');
const lyricsEditorEmbedEl = document.getElementById('lyrics-editor-embed');
const lyricsFullscreenEl = document.getElementById('lyrics-fullscreen');
const lyricsFullscreenBodyEl = document.getElementById('lyrics-fullscreen-body');
const lyricsFullscreenBackdropEl = document.getElementById('lyrics-fullscreen-backdrop');
const lyricsFullscreenArtEl = document.getElementById('lyrics-fullscreen-art');
const lyricsFullscreenTitleEl = document.getElementById('lyrics-fullscreen-title');
const lyricsFullscreenArtistEl = document.getElementById('lyrics-fullscreen-artist');
const lyricsFullscreenCloseBtn = document.getElementById('lyrics-fullscreen-close');
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
    lightModeBtn.setAttribute('aria-checked', String(isLightMode));

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
    toggleMagnifierLabel.textContent = isMagnifierEnabled ? 'Hide Album Art Preview on Hover' : 'Show Album Art Preview on Hover';
    toggleMagnifierBtn.classList.toggle('active', isMagnifierEnabled);
    containerEl.classList.toggle('magnifier-disabled', !isMagnifierEnabled);
}

function positionAlbumArtPreview() {
    const wrapper = document.getElementById('album-art-wrapper');
    const popup = document.getElementById('magnifier-popup');
    if (!wrapper || !popup) return;
    const rect = wrapper.getBoundingClientRect();
    const margin = 16, gap = 12;
    const size = Math.max(24, Math.min(190, innerWidth - margin * 2, innerHeight - margin * 2));
    let left = rect.right + gap;
    let top = rect.top + (rect.height - size) / 2;
    if (left + size > innerWidth - margin) {
        left = rect.left + (rect.width - size) / 2;
        top = rect.bottom + gap;
    }
    left = Math.max(margin, Math.min(left, innerWidth - size - margin));
    top = Math.max(margin, Math.min(top, innerHeight - size - margin));
    Object.assign(popup.style, {width:`${size}px`, height:`${size}px`,
        left:`${left - rect.left}px`, top:`${top - rect.top}px`, transform:'none'});
}
document.getElementById('album-art-wrapper')?.addEventListener('mouseenter', positionAlbumArtPreview);
window.addEventListener('resize', positionAlbumArtPreview);

// --- Helper Functions ---
function updateLyricsDropdownMenu() {
    // 1. Show/Hide Lyrics Section
    toggleLyricsLabel.textContent = areLyricsVisible ? 'Hide Lyrics' : 'Show Lyrics';
    toggleLyricsBtn.classList.toggle('active', areLyricsVisible);

    // 2. Show/Hide Lyrics Controls
    toggleControlsLabel.textContent = areLyricsControlsVisible ? 'Hide Controls' : 'Show Controls';
    toggleControlsBtn.classList.toggle('active', areLyricsControlsVisible);

    // 3. Enable/Disable Manual Scroll
    manualScrollLabel.textContent = isManualScrollEnabled ? 'Enable Auto Scroll' : 'Disable Auto Scroll';
    toggleManualScrollBtn.setAttribute('aria-pressed', String(!isManualScrollEnabled));
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
 * Brief confirmation over the album art. Reuses the volume overlay rather than
 * adding a second floating surface -- in a 380px window there is only room for
 * one, and the user is already looking at that spot when they change something.
 */
function showToast(message, ms = 1400) {
    if (!volumeOverlay || !volumeOverlayText) return;
    volumeOverlayText.textContent = message;
    volumeOverlay.classList.add('show');
    clearTimeout(volumeOverlayTimeout);
    volumeOverlayTimeout = setTimeout(() => volumeOverlay.classList.remove('show'), ms);
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
    lastActiveWordIndex = -1;
    lyricsContainer.innerHTML = '';
    lyricsContainer.classList.toggle('scrolling', !data.isSynced);
    lyricsContainer.classList.toggle('karaoke', Boolean(data.hasWordTiming));
    if (data.lines.length > 0) {
        const wrapper = (data.isSynced) ? document.createDocumentFragment() : document.createElement('div');
        if (!data.isSynced) wrapper.className = 'lyrics-scroll-wrapper';
        data.lines.forEach(line => {
            const lineEl = document.createElement('p');
            lineEl.className = 'lyrics-line';

            if (line && Array.isArray(line.words) && line.words.length) {
                // One span per timed segment, so the tick loop can light them up
                // individually without re-rendering the line.
                line.words.forEach((word, index) => {
                    const wordEl = document.createElement('span');
                    wordEl.className = 'lyrics-word';
                    wordEl.dataset.index = String(index);
                    wordEl.textContent = word.text;
                    lineEl.appendChild(wordEl);
                });
            } else {
                // textContent, not innerHTML: lyric text is third-party data and has
                // no business being parsed as markup.
                lineEl.textContent = typeof line === 'string' ? line : line.text;
            }

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

/**
 * Word-level (karaoke) highlight within the active line.
 *
 * Runs on the same rAF tick as the line highlight but only touches the DOM when the
 * word actually changes, which on a typical line is a few times a second rather than
 * sixty. Line-level highlighting alone tells you *which* line; on a slow ballad with
 * an eight-second line that is not much help.
 */
function highlightWords(lineIndex, seek) {
    if (!lyrics.hasWordTiming || lineIndex < 0) return;

    const line = lyrics.lines[lineIndex];
    if (!line || !line.words) return;

    let wordIndex = -1;
    for (let i = line.words.length - 1; i >= 0; i--) {
        if (seek >= line.words[i].time + currentLyricsOffset) {
            wordIndex = i;
            break;
        }
    }
    if (wordIndex === lastActiveWordIndex) return;

    const lineEl = lyricsContainer.children[lineIndex];
    if (!lineEl) return;

    const wordElements = lineEl.querySelectorAll('.lyrics-word');
    wordElements.forEach((el, index) => {
        el.classList.toggle('sung', index <= wordIndex);
        el.classList.toggle('singing', index === wordIndex);
    });

    lastActiveWordIndex = wordIndex;
}

/**
 * Applies the user's lyric typography to the CSS custom properties the stylesheet
 * reads. Kept as variables rather than inline styles so the themes, the fit tiers and
 * the RTL rules all keep working on top of it.
 *
 * This matters far more than it sounds: the defaults are tuned for Latin text, and CJK
 * and Arabic scripts need noticeably more size and line spacing to stay legible.
 */
function applyLyricsTypography(typography) {
    if (!typography) return;
    const root = document.documentElement.style;

    // The overlay is a separate window with its own stylesheet, so it cannot inherit
    // these and has to be told.
    if (isLyricsOverlayOpen) window.api.overlayStyle(typography);

    root.setProperty('--lyric-font-family', typography.fontFamily || 'inherit');
    root.setProperty('--lyric-font-size', `${typography.fontSize || 15}px`);
    root.setProperty('--lyric-font-weight', String(typography.fontWeight || 600));
    root.setProperty('--lyric-line-height', String(typography.lineHeight || 1.4));
    root.setProperty('--lyric-align', typography.align || 'center');
}

/** Loads the persisted lyric settings once at startup. */
async function loadLyricsConfig() {
    try {
        lyricsConfig = await window.api.lyricsGetConfig();
        applyLyricsTypography(lyricsConfig.typography);
        renderLyricsSettings();
    } catch (error) {
        console.error('Could not load lyric settings:', error);
    }
    return lyricsConfig;
}

/** Mirrors the stored lyric settings into the settings panel controls. */
function renderLyricsSettings() {
    if (!lyricsConfig) return;
    const typography = lyricsConfig.typography || {};

    if (lyricsFontSizeEl) lyricsFontSizeEl.value = typography.fontSize ?? 15;
    if (lyricsFontSizeValueEl) lyricsFontSizeValueEl.textContent = `${typography.fontSize ?? 15}px`;
    if (lyricsLineHeightEl) lyricsLineHeightEl.value = typography.lineHeight ?? 1.4;
    if (lyricsLineHeightValueEl) lyricsLineHeightValueEl.textContent = String(typography.lineHeight ?? 1.4);
    if (lyricsFontWeightEl) lyricsFontWeightEl.value = String(typography.fontWeight ?? 600);
    if (lyricsAlignEl) lyricsAlignEl.value = typography.align || 'center';
    if (lyricsFontFamilyEl) lyricsFontFamilyEl.value = typography.fontFamily || '';
    if (lyricsGeniusTokenEl) lyricsGeniusTokenEl.value = lyricsConfig.geniusToken || '';
    if (lyricsAutosaveEl) lyricsAutosaveEl.checked = Boolean(lyricsConfig.autoSaveLrc);
}

/** Shows which source the displayed lyric actually came from. */
function renderLyricsSource() {
    if (!lyricsSourceValueEl) return;
    const labels = {
        sidecar: '.lrc file',
        embedded: 'File tags',
        lrclib: 'LRCLIB',
        netease: 'NetEase',
        genius: 'Genius',
        user: 'Edited',
        cache: 'Cached',
    };
    lyricsSourceValueEl.textContent = lyricsSource ? (labels[lyricsSource] || lyricsSource) : '-';
}

/**
 * Repaints a typography change immediately and persists it shortly after.
 *
 * The preview has to be instantaneous to be worth anything, but a slider emits an
 * event per pixel of travel, and each one would otherwise be a settings write.
 */
let typographySaveTimer = null;

function updateLyricsTypography(patch) {
    const typography = {...(lyricsConfig?.typography || {}), ...patch};
    if (lyricsConfig) lyricsConfig.typography = typography;
    applyLyricsTypography(typography);

    clearTimeout(typographySaveTimer);
    typographySaveTimer = setTimeout(async () => {
        try {
            lyricsConfig = await window.api.lyricsSetConfig({typography});
        } catch (error) {
            console.error('Could not save lyric typography:', error);
        }
    }, 300);
}

/* ==========================================================================
   Desktop lyrics overlay (Phase 9)

   The strip is a separate window, but the timing stays here: this renderer already
   runs a per-frame loop that knows which line is current, and a second clock in the
   overlay would drift against this one within a verse. So the overlay is told what to
   draw, and owns nothing.
   ========================================================================== */

/** The text of a line, whether it came from the parser or a translation. */
function lyricLineText(index) {
    if (index < 0 || index >= lyrics.lines.length) return '';
    if (showTranslation && translatedLines && translatedLines[index]) return translatedLines[index];
    const line = lyrics.lines[index];
    return typeof line === 'string' ? line : (line?.text || '');
}

/**
 * Pushes the current line to the overlay, if it is open and the line has changed.
 * `force` bypasses the equality check, for the case where the window has just opened
 * and has never been told anything.
 */
function pushOverlayLine(index, force = false) {
    if (!isLyricsOverlayOpen) return;

    const line = lyricLineText(index);
    if (!force && line === lastOverlayLine) return;
    lastOverlayLine = line;

    window.api.overlayUpdate({
        line,
        next: lyricLineText(index + 1),
        title: currentSongData?.title || '',
        artist: currentSongData?.artist || '',
        isPlaying,
        rtl: Boolean(showTranslation && lyricsContainer?.classList.contains('rtl')),
    });
}

/** Opens or closes the overlay and reflects the state in the Lyrics menu. */
async function toggleLyricsOverlay(enabled) {
    isLyricsOverlayOpen = await window.api.overlayToggle(enabled);
    renderOverlayMenuState();

    if (isLyricsOverlayOpen) {
        window.api.overlayStyle(lyricsConfig?.typography || {});
        pushOverlayLine(lastActiveLyricIndex, true);
    } else {
        lastOverlayLine = null;
    }
}

function renderOverlayMenuState() {
    if (lyricsOverlayLabel) {
        lyricsOverlayLabel.textContent = isLyricsOverlayOpen
            ? 'Hide Desktop Overlay'
            : 'Show Desktop Overlay';
    }
    lyricsOverlayBtn?.classList.toggle('active', isLyricsOverlayOpen);
}

/* ==========================================================================
   Lyrics editor with tap-to-sync (Phase 9)

   Every lyrics-capable player can show an LRC. Almost none can make one, which
   is why so many tracks have lyrics that are three seconds out and stay that
   way forever. The model here is deliberately small: a list of lines, each with
   an optional time, and one operation that stamps the current line with the
   playhead and advances.

   Timestamps live on the line objects rather than inside the textarea text, so
   switching to Text mode to fix a typo cannot destroy an hour of syncing.
   ========================================================================== */

// A tap lands *after* the singer starts the line: the user hears the words, then
// reacts. Subtracting a fixed reaction allowance puts the stamp where the line
// actually begins. 180ms is a conservative middle of the usual 150-250ms range.
const TAP_LATENCY_COMPENSATION = 0.18;

/** `[mm:ss.xx]` for an LRC file. Two-digit centiseconds is what every player reads. */
function formatLrcStamp(seconds) {
    const safe = Math.max(0, seconds || 0);
    const minutes = Math.floor(safe / 60);
    const secs = Math.floor(safe % 60);
    const centis = Math.floor((safe - Math.floor(safe)) * 100);
    return `[${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
        + `.${String(centis).padStart(2, '0')}]`;
}

/**
 * Builds the editor's line model from LRC text.
 *
 * Deliberately *not* processLyrics: that one is built for playback and, the moment it
 * sees a single timestamp, returns only the timed lines. In the editor that is data
 * loss - a half-synced lyric would come back with its untimed lines silently deleted,
 * which is exactly the file someone opens the editor to finish.
 *
 * So this walks line by line and keeps everything: timed lines carry their time,
 * untimed lines carry null, and ID tags are dropped since they are file metadata
 * rather than lyrics. Word-level stamps inside a line are left in the text - the
 * editor works a line at a time and has no business discarding a finer-grained sync
 * somebody else made.
 */
function buildEditorLines(text) {
    if (!text) return [];

    const lines = [];
    const offsets=[...String(text).matchAll(/^\[offset:([+-]?\d+)]\s*$/gmi)];
    const offset=offsets.length?-Number(offsets.at(-1)[1])/1000:0;

    for (const rawLine of String(text).split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || LRC_ID_TAG.test(line)) continue;

        LRC_LINE_STAMP.lastIndex = 0;
        const stamps = [];
        let match;
        while ((match = LRC_LINE_STAMP.exec(line)) !== null) {
            const start = match.index;
            const expected = stamps.length ? stamps[stamps.length - 1].end : 0;
            if (start !== expected) break;
            stamps.push({
                time: stampToSeconds(match[1], match[2], match[3]),
                end: start + match[0].length,
            });
        }

        const body = stamps.length ? line.slice(stamps[stamps.length - 1].end).trim() : line;
        if (!body) continue;

        if (!stamps.length) {
            lines.push({text: body, time: null});
            continue;
        }

        // A repeated-chorus line carries several stamps; each is its own occurrence,
        // and collapsing them would drop every repeat after the first.
        for (const stamp of stamps) {
            const shift=stamp.time-stamps[0].time+offset;
            const words=shift?body.replace(LRC_WORD_STAMP,(_match,m,s,f)=>formatLrcStamp(stampToSeconds(m,s,f)+shift)
                .replace('[','<').replace(']','>')):body;
            lines.push({text:words,time:Math.max(0,stamp.time+offset)});
        }
    }

    lines.sort((a, b) => {
        if (a.time == null || b.time == null) return 0;
        return a.time - b.time;
    });

    return lines;
}

/** Serialises the line model back to LRC. Unstamped lines are written bare. */
function editorLinesToLrc(lines) {
    return lines
        .map((line) => (
            line.time == null ? line.text : `${formatLrcStamp(line.time)}${line.text}`
        ))
        .join('\n');
}

function setEditorStatus(message, kind = '') {
    if (!lyricsEditorStatusEl) return;
    lyricsEditorStatusEl.textContent = message || '';
    lyricsEditorStatusEl.classList.toggle('error', kind === 'error');
    lyricsEditorStatusEl.classList.toggle('success', kind === 'success');
}

/** Repaints the sync-mode line list and scrolls the pending line into view. */
function renderEditorLines() {
    if (!lyricsEditorLinesEl) return;

    lyricsEditorLinesEl.innerHTML = '';

    if (!editorLines.length) {
        const empty = document.createElement('div');
        empty.className = 'lyrics-editor-row';
        empty.textContent = 'No lines yet - add them in Text mode first.';
        lyricsEditorLinesEl.appendChild(empty);
    }

    editorLines.forEach((line, index) => {
        const row = document.createElement('div');
        row.className = 'lyrics-editor-row';
        row.classList.toggle('stamped', line.time != null);
        row.classList.toggle('current', index === editorCursor);

        const stamp = document.createElement('span');
        stamp.className = 'lyrics-editor-stamp';
        stamp.textContent = line.time == null ? '--:--' : formatLrcStamp(line.time).slice(1, -1);

        const text = document.createElement('span');
        text.className = 'lyrics-editor-row-text';
        text.textContent = line.text;

        row.appendChild(stamp);
        row.appendChild(text);

        // Clicking a line moves the cursor there and seeks to its stamp, which is how
        // you fix one bad line without redoing the whole song.
        row.addEventListener('click', () => {
            editorCursor = index;
            if (line.time != null) audio.seek(Math.max(0, line.time));
            renderEditorLines();
        });

        lyricsEditorLinesEl.appendChild(row);
    });

    const currentRow = lyricsEditorLinesEl.children[editorCursor];
    currentRow?.scrollIntoView({block: 'center', behavior: 'smooth'});

    if (lyricsEditorTapBtn) {
        lyricsEditorTapBtn.disabled = editorCursor >= editorLines.length;
    }
    if (lyricsEditorUndoBtn) {
        lyricsEditorUndoBtn.disabled = editorCursor === 0;
    }
}

/** Stamps the current line with the playhead and advances. */
function tapSyncCurrentLine() {
    if (editorCursor >= editorLines.length) return;

    const time = Math.max(0, (audio.seek() || 0) - TAP_LATENCY_COMPENSATION);
    editorLines[editorCursor].time = time;
    editorCursor += 1;

    lyricsEditorTapBtn?.classList.add('tapping');
    setTimeout(() => lyricsEditorTapBtn?.classList.remove('tapping'), 110);

    renderEditorLines();
    setEditorStatus(
        editorCursor >= editorLines.length
            ? 'Every line is timed. Save when you are happy with it.'
            : `${editorCursor} of ${editorLines.length} lines timed.`
    );
}

/**
 * Undoes the last tap: steps back one line, clears its stamp, and rewinds the audio
 * to just before it. Rewinding is the part that makes this usable - without it you
 * undo a line and the song has already moved past the moment you needed.
 */
function undoLastTap() {
    if (editorCursor === 0) return;

    editorCursor -= 1;
    const line = editorLines[editorCursor];
    if (line.time != null) audio.seek(Math.max(0, line.time - 1));
    line.time = null;

    renderEditorLines();
    setEditorStatus(`${editorCursor} of ${editorLines.length} lines timed.`);
}

/** Text mode -> sync mode keeps stamps for lines whose text has not changed. */
function syncEditorModelFromTextarea() {
    if (!lyricsEditorTextarea) return;

    const previous = new Map();
    editorLines.forEach((line) => {
        if (line.time != null && !previous.has(line.text)) previous.set(line.text, line.time);
    });

    const rebuilt = buildEditorLines(lyricsEditorTextarea.value);
    for (const line of rebuilt) {
        if (line.time == null && previous.has(line.text)) line.time = previous.get(line.text);
    }
    editorLines = rebuilt;

    // Resume at the first line still missing a stamp rather than at the top.
    const firstUnstamped = editorLines.findIndex((line) => line.time == null);
    editorCursor = firstUnstamped === -1 ? editorLines.length : firstUnstamped;
}

function setEditorMode(mode) {
    if (mode === 'sync') syncEditorModelFromTextarea();
    else if (lyricsEditorTextarea) lyricsEditorTextarea.value = editorLinesToLrc(editorLines);

    editorMode = mode;
    lyricsEditorTextPane?.classList.toggle('hidden', mode !== 'text');
    lyricsEditorSyncPane?.classList.toggle('hidden', mode !== 'sync');
    lyricsEditorModeTextBtn?.classList.toggle('active', mode === 'text');
    lyricsEditorModeSyncBtn?.classList.toggle('active', mode === 'sync');

    if (mode === 'sync') {
        renderEditorLines();
        lyricsEditorLinesEl?.focus();
    }
}

function updateEditorClock() {
    if (lyricsEditorClockEl) lyricsEditorClockEl.textContent = formatTime(audio.seek() || 0);
    if (lyricsEditorPlayBtn) lyricsEditorPlayBtn.textContent = isPlaying ? 'Pause' : 'Play';
}

/** Opens the editor over the whole window, seeded with the current lyric. */
async function openLyricsEditor(importedText) {
    if (!lyricsEditorEl || !currentSongData) return;

    editorLines = buildEditorLines(typeof importedText === 'string' ? importedText : (rawLyricsText || ''));
    const firstUnstamped = editorLines.findIndex((line) => line.time == null);
    editorCursor = firstUnstamped === -1 ? 0 : firstUnstamped;

    if (lyricsEditorTextarea) lyricsEditorTextarea.value = editorLinesToLrc(editorLines);
    if (lyricsEditorTitleEl) lyricsEditorTitleEl.textContent = currentSongData.title || '';
    if (lyricsEditorArtistEl) lyricsEditorArtistEl.textContent = currentSongData.artist || '';
    if (lyricsEditorWriteLrcEl) lyricsEditorWriteLrcEl.checked = Boolean(lyricsConfig?.autoSaveLrc);

    setEditorStatus(editorLines.length
        ? `${editorLines.filter((l) => l.time != null).length} of ${editorLines.length} lines timed.`
        : 'Paste the lyrics to get started.');
    setEditorMode(editorLines.length ? 'sync' : 'text');

    lyricsEditorEl.classList.remove('hidden');
    isLyricsEditorOpen = true;

    // The dock is 180px tall; the editor needs the same room the settings tab gets.
    editorReturnTab = activeTab;
    await window.api.setActiveTab('settings');

    clearInterval(editorClockTimer);
    editorClockTimer = setInterval(updateEditorClock, 200);
    updateEditorClock();
}

async function closeLyricsEditor() {
    if (!isLyricsEditorOpen) return;

    lyricsEditorEl?.classList.add('hidden');
    isLyricsEditorOpen = false;
    clearInterval(editorClockTimer);
    editorClockTimer = null;

    await window.api.setActiveTab(editorReturnTab);
}

/**
 * Writes the edited lyric out: always to the database, plus an .lrc file and/or the
 * file's own tags when asked. The result is reported per destination, because
 * embedding can fail on an unsupported container while the .lrc succeeded, and
 * "Saved" would then be a lie about half of it.
 */
async function saveLyricsFromEditor() {
    if (editorMode === 'text') syncEditorModelFromTextarea();
    if (!editorLines.length) {
        setEditorStatus('There is nothing to save.', 'error');
        return;
    }

    const text = editorLinesToLrc(editorLines);
    setEditorStatus('Saving...');

    try {
        const result = await window.api.lyricsSave({
            songKey: getSongIdentifier(),
            filePath: currentSongData?.filePath,
            text,
            saveSidecar: Boolean(lyricsEditorWriteLrcEl?.checked),
            embed: Boolean(lyricsEditorEmbedEl?.checked),
            artist: currentSongData?.artist,
            title: currentSongData?.title,
        });

        if (!result || !result.ok) {
            setEditorStatus(result?.error || 'Could not save the lyrics.', 'error');
            return;
        }

        const failures = [];
        if (result.sidecar && !result.sidecar.ok) failures.push(`.lrc: ${result.sidecar.error}`);
        if (result.embedded && !result.embedded.ok) failures.push(`tags: ${result.embedded.error}`);

        // Repaint the live view from what was just saved, so the user can hear the
        // result immediately instead of reloading the track to check.
        rawLyricsText = text;
        lyricsSource = 'user';
        lyrics = processLyrics(text);
        displayLyrics(lyrics, audio.ticket);
        renderLyricsSource();
        publishRoomLyrics();

        setEditorStatus(
            failures.length ? `Saved, but ${failures.join('; ')}` : 'Saved.',
            failures.length ? 'error' : 'success'
        );
    } catch (error) {
        console.error('Saving lyrics failed:', error);
        setEditorStatus(error.message || 'Could not save the lyrics.', 'error');
    }
}

/**
 * Enters or leaves full-screen lyrics (Phase 9).
 *
 * The lyric element is *moved* between the dock and the overlay rather than being
 * duplicated. A second copy would need its own render call, its own scroll maths and
 * its own place in the tick loop, and the two would drift apart the first time either
 * changed. Moving a live node keeps `lyricsContainer` pointing at the same element, so
 * every existing code path carries on working untouched.
 *
 * Window full-screen is requested alongside, because the dock is 180px tall and an
 * overlay inside it would not be full-screen in any sense the user means.
 */
async function setLyricsFullscreen(enabled) {
    if (!lyricsFullscreenEl || !lyricsContainer || enabled === isLyricsFullscreen) return;

    if (enabled) {
        // Remember the exact position, not just the parent: the strip has siblings
        // (the offset chip, the controls) and order matters to the layout.
        lyricsHomeParent = lyricsContainer.parentElement;
        lyricsHomeNextSibling = lyricsContainer.nextSibling;

        lyricsFullscreenBodyEl.appendChild(lyricsContainer);
        lyricsFullscreenEl.classList.remove('hidden');
        document.body.classList.add('lyrics-fullscreen-open');
        renderFullscreenLyricsHeader();

        isLyricsFullscreen = true;
        await window.api.setFullscreen(true);
    } else {
        if (lyricsHomeParent) {
            lyricsHomeParent.insertBefore(lyricsContainer, lyricsHomeNextSibling);
        }
        lyricsFullscreenEl.classList.add('hidden');
        document.body.classList.remove('lyrics-fullscreen-open');

        isLyricsFullscreen = false;
        await window.api.setFullscreen(false);
    }

    // The container's height changed, so the cached fit tier and the scroll offset for
    // the active line are both stale. Forcing a re-evaluation on the next tick is
    // cheaper and more reliable than recomputing them here.
    lastActiveLyricIndex = -1;
    lastActiveWordIndex = -1;
}

/** Fills the full-screen header from the current track. */
function renderFullscreenLyricsHeader() {
    if (!lyricsFullscreenEl) return;

    const artSrc = albumArtEl?.src || '../assets/images/placeholder.png';
    if (lyricsFullscreenArtEl) lyricsFullscreenArtEl.src = artSrc;
    if (lyricsFullscreenBackdropEl) {
        // CSS.escape is not applicable to a url() value; quoting is what keeps a path
        // containing brackets or spaces from breaking the declaration.
        lyricsFullscreenBackdropEl.style.backgroundImage = `url("${artSrc}")`;
    }
    if (lyricsFullscreenTitleEl) {
        lyricsFullscreenTitleEl.textContent = currentSongData?.title || 'No song loaded';
    }
    if (lyricsFullscreenArtistEl) {
        lyricsFullscreenArtistEl.textContent = currentSongData?.artist || '';
    }
}

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
    updateSystemMediaSession();
    // Title/artist ride along so the tray tooltip can show what is playing.
    window.api.sendPlaybackState({
        isPlaying,
        title: currentSongData ? currentSongData.title : null,
        artist: currentSongData ? currentSongData.artist : null,
        trackId:currentSongData?.filePath,
        nextPath:playlist[currentIndex+1],
        cover:currentSongData?.cover,
    });
}

/**
 * LRC parser (Phase 9).
 *
 * Replaces a parser that handled exactly one shape: `[mm:ss.xx]text`, one stamp per
 * line, two-digit minutes only. Real .lrc files in the wild are messier, and the
 * enhanced format the karaoke highlight needs was not understood at all. This handles:
 *
 *   - Multiple stamps on one line: `[00:12.00][01:44.00]same chorus line`, which is how
 *     most databases store a repeated chorus. The old parser kept only the first, so
 *     the chorus highlighted once and then went dead for the rest of the song.
 *   - One, two or three digit minutes and two or three digit fractions.
 *   - The `[offset:±ms]` ID tag, which shifts every stamp. Honouring it is the whole
 *     point of the tag, and ignoring it is why some files felt uniformly early.
 *   - Enhanced (word-level) stamps: `[00:12.00]<00:12.00>Hello <00:12.40>world`.
 *   - Other ID tags (`[ar:]`, `[ti:]`, `[by:]`), which are metadata, not lyrics, and
 *     were previously rendered as if they were the first line of the song.
 *
 * Returns `{isSynced, hasWordTiming, lines}`. For a synced lyric each line is
 * `{time, text, words}`, where `words` is null unless the line carried word stamps.
 */
const {processLyrics, stampToSeconds, parseWordStamps,LRC_LINE_STAMP,LRC_WORD_STAMP,LRC_ID_TAG} = window.RhythmLyrics;

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
    const edgePlay = document.getElementById('edge-play');
    if (edgePlay) window.DockIcons.set(edgePlay, isPlaying ? 'pause' : 'play');
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

        if (lyricsContainer && lyrics.lines.length > 0) {
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
                        lastActiveWordIndex = -1;
                        // Fit before measuring, or the scroll position is computed from
                        // the pre-shrink height and lands slightly off centre.
                        fitActiveLyric(activeLineEl);
                        const containerHeight = lyricsContainer.clientHeight;
                        if (!isManualScrollEnabled) lyricsContainer.scrollTop =
                            activeLineEl.offsetTop - (containerHeight / 2) + (activeLineEl.offsetHeight / 2);
                    }
                    lastActiveLyricIndex = currentLyricIndex;
                    pushOverlayLine(currentLyricIndex);
                }

                highlightWords(currentLyricIndex, seek);
            } else {
                const scrollWrapper = lyricsContainer.firstChild;
                if (scrollWrapper && !isManualScrollEnabled) {
                    const progress = seek / duration;
                    const totalScrollHeight = scrollWrapper.scrollHeight - lyricsContainer.clientHeight;
                    if (totalScrollHeight > 0) {
                        scrollWrapper.style.transform = `translateY(-${progress * totalScrollHeight}px)`;
                    }
                }
            }
        }
    }

    // Accrues listened time for the play/skip decision in finishListen().
    tickListen(isPlaying);

    requestAnimationFrame(updateUI);
}

// --- State Persistence ---
function savePlaybackState() {
    if (room.connected && !room.isHost) return;
    // A finished track restarts from the top next launch rather than resuming at the
    // very end, which would immediately re-trigger the 'ended' path.
    const duration = audio.duration();
    const seek = audio.hasEnded() || (duration > 0 && audio.seek() >= duration - 2)
        ? 0 : (audio.seek() || 0);
    const state = {
        playlist: originalPlaylist,
        queue: [...playlist],
        lastPlayedPath: playlist[currentIndex] || null,
        seek,
        isShuffled: isShuffled,
        loopMode: loopMode,
        playbackRate,
        playlistName: currentPlaylistName,
    };
    window.api.setStoreValue('lastPlaybackState', state);
    persistTrackPosition();
}

function persistTrackPosition() {
    const filePath = currentSongData?.filePath;
    if (filePath && filePath === activePlaybackFilePath && currentSound && !audio.isBusy()) {
        const seek = audio.seek() || 0;
        const duration = audio.duration();
        window.api.bookPositionSet(filePath,
            audio.hasEnded() || duration < 300 || seek <= 10 || duration - seek <= 10 ? 0 : seek);
    }
}

function chapterIndexAt(seconds) {
    const chapters = currentSongData?.chapters || [];
    let index = 0;
    for (let i = 0; i < chapters.length; i++) {
        if (chapters[i].start > seconds + 0.2) break;
        index = i;
    }
    return index;
}

function renderChapterNavigation() {
    const host = document.getElementById('chapter-nav');
    const select = document.getElementById('chapter-select');
    if (!host || !select) return;
    const chapters = currentSongData?.chapters || [];
    host.hidden = chapters.length < 2;
    select.replaceChildren();
    chapters.forEach((chapter, index) => select.add(new Option(chapter.title, String(index))));
    if (chapters.length) select.value = String(chapterIndexAt(audio.seek()));
}

function goToChapter(index) {
    const chapters = currentSongData?.chapters || [];
    if (index < 0 || index >= chapters.length) return;
    audio.seek(chapters[index].start);
    document.getElementById('chapter-select').value = String(index);
    savePlaybackState();
}

/**
 * Persists the current track's lyric offset.
 *
 * The offset now lives in the database, keyed per track (Phase 9), rather than in a
 * single settings blob that grew without bound and was lost with the settings file.
 * Writes are debounced because the offset control repeats while held, and each repeat
 * would otherwise be its own round trip and its own row write.
 */
function saveLyricsOffsets() {
    const songId = getSongIdentifier();
    if (!songId) return;

    // Kept in memory too, so the value survives a track change and back within a
    // session even if the write has not landed yet.
    lyricsOffsets[songId] = currentLyricsOffset;

    clearTimeout(offsetSaveTimer);
    offsetSaveTimer = setTimeout(() => {
        window.api.lyricsSetOffset(songId, Math.round(currentLyricsOffset * 1000));
    }, 250);
}

/**
 * Resolves and paints lyrics for a track.
 *
 * The fetch() call to lrclib that used to live here is gone: resolution now happens in
 * the main process, behind a chain of sources (sidecar .lrc, embedded tags, lrclib,
 * NetEase, Genius). That removes the provider from the renderer's CSP, and means one
 * provider being down no longer reads to the user as "this song has no lyrics".
 *
 * `rawLyricsText` is kept alongside the parsed form because the editor and the LRC
 * exporter need the original text, not our reconstruction of it.
 */
async function searchAndDisplayOnlineLyrics(songData, forceRefetch = false, ticket = audio.ticket) {
    if (!lyricsContainer) return;
    if (ticket !== audio.ticket) return;

    const noLyricsEl = lyricsContainer.querySelector('.lyrics-line');
    if (noLyricsEl) noLyricsEl.textContent = 'Searching for lyrics...';

    let resolved = {isSynced: false, hasWordTiming: false, lines: []};

    try {
        const songId = getSongIdentifier();
        if (!songId) {
            throw new Error('Cannot generate a song identifier to use the database.');
        }

        const {artist: cleanArtist, title: cleanTitle} = sanitizeForApiSearch(songData.artist, songData.title);

        const result = await window.api.lyricsResolve({
            songKey: songId,
            filePath: songData.filePath,
            artist: cleanArtist || songData.artist,
            title: cleanTitle || songData.title,
            album: songData.album || '',
            durationSeconds: Math.round(audio.duration() || 0),
            // The file's own tags are a source in their own right, and only the
            // renderer has already paid to read them.
            embedded: songData.lyrics || null,
            forceRefetch,
        });

        // The round trip is the slow part, so re-check the ticket: by now the user may
        // well have skipped several tracks on.
        if (ticket !== audio.ticket) return;

        if (result && result.ok && result.text) {
            resolved = processLyrics(result.text);
            rawLyricsText = result.text;
            lyricsSource = result.source || null;

            if (Number.isFinite(result.offsetMs) && result.offsetMs !== 0) {
                currentLyricsOffset = result.offsetMs / 1000;
                lyricsOffsets[songId] = currentLyricsOffset;
                updateOffsetDisplay();
            }
        } else {
            rawLyricsText = null;
            lyricsSource = null;
        }

        renderLyricsSource();
    } catch (error) {
        console.error('An error occurred during lyric search:', error);
        resolved = {isSynced: false, hasWordTiming: false, lines: ['Error finding lyrics.']};
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
    document.querySelectorAll('.named-playlist-controls').forEach((element) =>
        element.classList.toggle('hidden', room.connected && !room.isHost));
    document.querySelectorAll('.remote-audio-controls').forEach((element) =>
        element.classList.toggle('hidden', room.connected && !room.isHost));
    document.getElementById('room-upload-controls')?.classList.toggle('hidden',
        !room.connected || room.isHost || room.role !== 'controller');
    document.getElementById('room-telegram-controls')?.classList.toggle('hidden', !room.connected || !room.isHost);
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
let roomLibraryRevision = 0;

function hashPath(filePath) {
    return trackIdCache.get(filePath) || null;
}

/** Publishes the queue, and refreshes the local id cache from what main assigned. */
async function publishRoomLibrary() {
    if (!room.connected || !room.isHost) return;

    const revision = ++roomLibraryRevision;
    const catalog = await window.api.libraryCatalog();
    const byPath = new Map(catalog.map((track) => [track.filePath, track]));

    const info = {};
    for (const filePath of playlist) {
        const track = byPath.get(filePath) || await window.api.libraryGetTrack(filePath);
        info[filePath] = {title: track?.title, artist: track?.artist, album: track?.album,
            playbackPath: preparedAudio.get(filePath) || filePath};
    }

    if (revision !== roomLibraryRevision || !room.connected || !room.isHost) return;
    window.api.roomPublishLibrary({queue: [...playlist], info, catalog});
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
            const query = room.password ? `?password=${encodeURIComponent(room.password)}` : '';
            const url = `${room.serverUrl}/api/rooms/${room.code}/stream/${encodeURIComponent(state.trackId)}${query}`;
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
    if (!room.connected || !room.isHost) return;
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
        case 'queue:add': {
            const trackId = typeof value === 'object' && value?.trackId;
            const filePath = [...trackIdCache.entries()].find(([, id]) => id === trackId)?.[0];
            if (!filePath) return; // Only tracks in the host-published catalog.
            const position = [QUEUE_POSITIONS.FIRST, QUEUE_POSITIONS.NEXT, QUEUE_POSITIONS.END]
                .includes(value.position) ? value.position : QUEUE_POSITIONS.END;
            enqueue(filePath, position);
            break;
        }
        case 'queue:remove': {
            const index = playlist.findIndex((filePath) => hashPath(filePath) === value?.trackId);
            if (index < 0) return;
            removeFromQueue(index);
            break;
        }
        case 'queue:move': {
            const from = playlist.findIndex((filePath) => hashPath(filePath) === value?.trackId);
            const direction = value?.direction;
            if (from < 0 || !['up', 'down'].includes(direction)) return;
            const to = from + (direction === 'up' ? -1 : 1);
            if (to < 0 || to >= playlist.length) return;
            moveQueueItem(from, to);
            break;
        }
        default: return;
    }
    // Answer immediately rather than waiting for the next throttled tick, so the
    // member who pressed the button sees it respond at once.
    publishRoomState();
}

// --- Audio engine settings (Phase 8) ---------------------------------------------
//
// These all map one-to-one onto AudioEngine setters. They live together here so
// that loading them at startup and persisting them on change is one loop rather
// than a dozen scattered listeners.

const AUDIO_SETTINGS = [
    {key: 'crossfadeMs',       fallback: 0,     apply: (v) => audio.setCrossfade(v)},
    {key: 'gapless',           fallback: true,  apply: (v) => audio.setGapless(v)},
    {key: 'preservePitch',     fallback: true,  apply: (v) => audio.setPreservePitch(v)},
    {key: 'limiterEnabled',    fallback: true,  apply: (v) => audio.setLimiter(v)},
    {key: 'replayGainEnabled', fallback: true,  apply: (v) => audio.setReplayGainEnabled(v)},
    {key: 'skipSilence',       fallback: false, apply: (v) => audio.setSkipSilence(v)},
    {key: 'monoMix',           fallback: false, apply: (v) => audio.setMonoMix(v)},
    {key: 'swapChannels',      fallback: false, apply: (v) => audio.setSwapChannels(v)},
    {key: 'audioBalance',      fallback: 0,     apply: (v) => audio.setBalance(v)},
    {key: 'outputDeviceId',    fallback: '',    apply: (v) => audio.setOutputDevice(v)},
    {key: 'primaryDelayMs', fallback: 0, apply: (v) => audio.setPrimaryDelay(v)},
];

/** Which ReplayGain value to prefer. Album is the better default -- see below. */
let replayGainMode = 'album';

async function loadAudioSettings() {
    for (const setting of AUDIO_SETTINGS) {
        const stored = await window.api.getStoreValue(setting.key);
        const value = stored === undefined || stored === null ? setting.fallback : stored;
        try {
            setting.apply(value);
        } catch (error) {
            console.warn(`[audio] Could not apply ${setting.key}:`, error);
        }
    }
    replayGainMode = (await window.api.getStoreValue('replayGainMode')) || 'album';
}

function saveAudioSetting(key, value) {
    window.api.setStoreValue(key, value);
}

/**
 * Applies the ReplayGain carried in the track's tags.
 *
 * Album gain is preferred over track gain because normalising every track of an
 * album independently flattens the dynamics between them -- the quiet interlude
 * before the loud finale is *meant* to be quiet. Track gain is the right choice
 * for shuffled playlists, so it is a setting rather than a constant.
 */
function applyReplayGainFor(songData) {
    const gain = songData?.replayGain;
    if (!gain) {
        audio.setReplayGain((replayGainMode === 'album' ? songData?.analysis?.albumGainDb : null) ?? songData?.analysis?.gainDb ?? 0);
        return;
    }
    const preferred = replayGainMode === 'track'
        ? (gain.track ?? gain.album)
        : (gain.album ?? gain.track);
    audio.setReplayGain(Number.isFinite(preferred) ? preferred :
        ((replayGainMode === 'album' ? songData?.analysis?.albumGainDb : null) ?? songData?.analysis?.gainDb ?? 0));
}

const NEEDS_DECODER = {test: file => window.RhythmFormats.needsPreparation(file)};
const preparedAudio = new Map();

function initMediaTools() {
    const status = document.getElementById('media-tools-status');
    const report = (text) => { if (status) status.textContent = text; showToast(text); };
    const bind = (id, handler) => document.getElementById(id)?.addEventListener('click', async () => {
        try { await handler(); } catch (error) { report(error.message); }
    });
    bind('ffmpeg-pick', async () => {
        const result = await window.api.mediaToolsPick();
        if (!result.cancelled) report(result.ok ? 'FFmpeg is ready.' : result.error);
    });
    bind('ffmpeg-check', async () => {
        const result = await window.api.mediaToolsCheck(); report(result.ok ? result.version : result.error);
    });
    bind('media-cancel', () => window.api.mediaToolsCancel());
    for (const [id,kind] of [['midi-synth-pick','synth'],['midi-font-pick','soundfont']]) bind(id,async()=>{
        const result=await window.api.midiToolsPick(kind);
        if(!result.cancelled)report(result.ok?'Selected '+result.name:result.error);
    });
    bind('midi-tools-check',async()=>{
        const result=await window.api.midiToolsCheck();report(result.ok?'MIDI is ready with '+result.name:result.error);
    });
    bind('import-lyrics-btn',async()=>{
        if(!currentSongData)return report('Open a song before importing its lyrics.');
        const source=currentSongData.filePath;
        const result=await window.api.lyricsImportFile();
        if(result.cancelled)return;
        if(!result.ok)return report(result.error);
        if(currentSongData?.filePath!==source)return report('The song changed. Import the lyrics again.');
        await openLyricsEditor(result.text);
    });
    bind('diagnostics-export', async () => {
        const result = await window.api.diagnosticsExport();
        if (!result.cancelled) report(result.ok ? 'Diagnostics exported without URLs or credentials.' : result.error);
    });
    bind('lyrics-controls-setting', () => {
        areLyricsControlsVisible = true;
        containerEl.classList.remove('lyrics-controls-hidden');
        updateLyricsDropdownMenu();
        showToast('Lyrics controls shown.');
    });
    const analyse = async (files) => {
        report('Analysing loudness…');
        const result = await window.api.mediaAnalyse(files);
        if (!result.ok) return report(result.error);
        const current = result.results.find((row) => row.filePath === playlist[currentIndex]);
        if (current && currentSongData?.filePath === current.filePath) {
            currentSongData.analysis = current; applyReplayGainFor(currentSongData);
        }
        report(`Loudness saved for ${result.results.length} song(s).`);
    };
    bind('analyse-current', () => analyse(playlist[currentIndex] ? [playlist[currentIndex]] : []));
    bind('analyse-album', async () => {
        const filePath = playlist[currentIndex];
        if (!filePath) return report('Open an album song first.');
        report('Analysing the album together…');
        const result = await window.api.mediaAnalyseAlbum(filePath);
        if (!result.ok) return report(result.error);
        if (currentSongData?.filePath === filePath) {
            currentSongData.analysis = result.analysis; applyReplayGainFor(currentSongData);
        }
        report('Album loudness saved.');
    });
    bind('analyse-queue', () => analyse(playlist));
    const exportAudio = async (selection) => {
        const filePath = playlist[currentIndex];
        if (!filePath) return report('Open a song first.');
        if (selection && (audio.loopStart === null || audio.loopEnd === null)) return report('Set both A and B first.');
        const result = await window.api.mediaExport({filePath,
            start: selection ? audio.loopStart : 0, end: selection ? audio.loopEnd : null,
            extension: document.getElementById('export-format').value});
        if (!result.cancelled) report(result.ok ? 'Audio exported to a new file.' : result.error);
    };
    bind('export-current', () => exportAudio(false));
    bind('export-ab', () => exportAudio(true));
    bind('chapter-queue', async () => {
        if (!playlist[currentIndex]) return;
        report('Preparing chapter tracks…');
        const result = await window.api.mediaChapterTracks(playlist[currentIndex]);
        if (!result.ok) return report(result.error);
        await loadPlaylistAndPlay(result.files);
        report(`${result.files.length} chapter tracks queued.`);
    });
    window.api.onMediaToolsProgress(({seconds, index, total}) => {
        if (status) status.textContent = index ? `Processing ${index} of ${total}…` : `Processed ${Math.floor(seconds || 0)} seconds…`;
    });
}

/**
 * Tells the engine what is coming next, so it can buffer it before the current
 * track ends. Without this, gapless and crossfade have nothing to fade into.
 */
function updateNextTrackHint() {
    if (!playlist.length) {
        audio.setNextTrack(null);
        return;
    }
    if (loopMode === 'one') {
        // Repeating one track needs no handoff, and preloading it would waste a
        // descriptor on a file that is already open.
        audio.setNextTrack(null);
        return;
    }

    const nextIndex = currentIndex + 1;
    const hint = (filePath) => NEEDS_DECODER.test(filePath) ? preparedAudio.get(filePath) || null : filePath;
    if (nextIndex < playlist.length) {
        audio.setNextTrack(hint(playlist[nextIndex]));
    } else if (loopMode === 'all' && playlist.length > 1) {
        audio.setNextTrack(hint(playlist[0]));
    } else {
        audio.setNextTrack(null);
    }
}

// --- A-B repeat ------------------------------------------------------------------

const abButton = document.getElementById('ab-repeat-btn');
const abLabel = document.getElementById('ab-repeat-label');

// null -> waiting for A -> waiting for B -> looping -> null
let pendingLoopStart = null;

function renderAbState() {
    if (!abButton) return;
    const {start, end} = audio.getLoop();
    const looping = start != null && end != null;

    const range = document.getElementById('ab-range');
    if (range) {
        const duration = audio.duration();
        const marked = looping || pendingLoopStart != null;
        range.classList.toggle('visible', marked && duration > 0);
        range.classList.toggle('pending', !looping);
        if (marked && duration > 0) {
            range.style.left = `${Math.max(0, Math.min(100, (looping ? start : pendingLoopStart) / duration * 100))}%`;
            range.style.width = looping ? `${Math.max(0, Math.min(100, (end - start) / duration * 100))}%` : '2px';
        }
    }

    abButton.classList.toggle('active', looping || pendingLoopStart != null);
    if (abLabel) {
        abLabel.textContent = looping ? 'A-B' : (pendingLoopStart != null ? 'A' : 'A-B');
    }
    abButton.title = looping
        ? `Looping ${formatTime(start)}-${formatTime(end)}. Click to clear.`
        : (pendingLoopStart != null
            ? `Loop starts at ${formatTime(pendingLoopStart)}. Click again to set the end.`
            : 'A-B repeat: click to set the loop start');
}

/** One button, three states. Cheaper to learn than two buttons and a clear. */
function cycleAbRepeat() {
    const {start} = audio.getLoop();

    if (start != null) {
        audio.clearLoop();
        pendingLoopStart = null;
    } else if (pendingLoopStart == null) {
        pendingLoopStart = audio.seek();
    } else {
        const end = audio.seek();
        // A backwards selection is a mis-click, not an instruction.
        if (end > pendingLoopStart + 0.5) {
            audio.setLoop(pendingLoopStart, end);
        }
        pendingLoopStart = null;
    }
    renderAbState();
}

// --- Output devices ----------------------------------------------------------------

/**
 * Populates the output picker.
 *
 * Device *labels* are only exposed once the page has been granted media
 * permission, which a music player never asks for. So unlabelled devices are
 * shown positionally rather than hidden -- an unhelpful name still beats an
 * empty list.
 */
async function populateOutputDevices() {
    const select = document.getElementById('output-device');
    if (!select || !navigator.mediaDevices?.enumerateDevices) return;

    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter((device) => device.kind === 'audiooutput');
        const current = await window.api.getStoreValue('outputDeviceId') || '';

        select.innerHTML = '';
        const systemOption = document.createElement('option');
        systemOption.value = '';
        systemOption.textContent = 'System default';
        select.appendChild(systemOption);

        outputs.forEach((device, index) => {
            if (!device.deviceId || device.deviceId === 'default') return;
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.textContent = device.label || `Output ${index + 1}`;
            select.appendChild(option);
        });

        select.value = current;
    } catch (error) {
        console.warn('[audio] Could not enumerate output devices:', error);
    }
}

// --- Simultaneous outputs ----------------------------------------------------------
//
// The list of extra devices to mirror onto, plus each one's delay. The engine
// keeps the audio itself aligned; these numbers exist purely to compensate for
// the different latencies of the devices themselves.

/** Renders the checkbox + delay row for every available output device. */
async function renderExtraOutputs() {
    const host = document.getElementById('extra-outputs');
    if (!host || !navigator.mediaDevices?.enumerateDevices) return;

    const devices = await navigator.mediaDevices.enumerateDevices();
    const allOutputs = devices.filter((device) => device.kind === 'audiooutput');
    const groups = new Set();
    const outputs = allOutputs.filter((device) => {
        if (!device.deviceId || ['default', 'communications'].includes(device.deviceId)) return false;
        if (device.groupId && groups.has(device.groupId)) return false;
        if (device.groupId) groups.add(device.groupId);
        return true;
    });
    const primary = document.getElementById('output-device')?.value || '';
    const primaryGroup = allOutputs.find((device) => device.deviceId === (primary || 'default'))?.groupId;
    const active = new Map(audio.listOutputs().map((o) => [o.deviceId, o.delayMs]));

    host.innerHTML = '';

    if (!outputs.length) {
        const empty = document.createElement('div');
        empty.className = 'library-root-empty';
        empty.textContent = 'No other output devices were found.';
        host.appendChild(empty);
        return;
    }

    outputs.forEach((device, index) => {
        // Mirroring the primary output onto itself would double it.
        if (device.deviceId === primary ||
            (primaryGroup && device.groupId && device.groupId === primaryGroup)) return;

        const row = document.createElement('div');
        row.className = 'output-row';

        const label = document.createElement('label');
        label.className = 'settings-check output-row-check';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = active.has(device.deviceId);

        const name = document.createElement('span');
        name.textContent = device.label || `Output ${index + 1}`;

        label.append(checkbox, name);

        const delay = document.createElement('input');
        delay.type = 'range';
        delay.min = '0';
        delay.max = '500';
        delay.step = '10';
        delay.value = String(active.get(device.deviceId) ?? 0);
        delay.className = 'output-delay';
        delay.title = 'Delay this output to line it up with your slowest device';
        delay.disabled = !checkbox.checked;

        const readout = document.createElement('span');
        readout.className = 'settings-value';
        readout.textContent = `${delay.value} ms`;

        checkbox.addEventListener('change', async () => {
            if (checkbox.checked) {
                const result = await audio.addOutput(device.deviceId, {
                    delayMs: Number(delay.value),
                });
                if (!result.ok) {
                    checkbox.checked = false;
                    showToast(result.error || 'Could not open that device.', 2500);
                }
            } else {
                audio.removeOutput(device.deviceId);
            }
            delay.disabled = !checkbox.checked;
            persistExtraOutputs();
        });

        delay.addEventListener('input', () => {
            readout.textContent = `${delay.value} ms`;
            audio.setOutputDelay(device.deviceId, Number(delay.value));
        });
        delay.addEventListener('change', persistExtraOutputs);

        row.append(label, delay, readout);
        host.appendChild(row);
    });
}

function persistExtraOutputs() {
    window.api.setStoreValue('extraOutputs', audio.listOutputs());
}

/**
 * Reconnects the extra outputs saved last session.
 *
 * Device ids are not stable across reboots on every platform, so a saved output
 * that no longer resolves is dropped quietly rather than reported -- an unplugged
 * speaker is not an error worth interrupting startup for.
 */
async function restoreExtraOutputs() {
    const saved = await window.api.getStoreValue('extraOutputs');
    if (!Array.isArray(saved) || !saved.length) return;

    for (const entry of saved) {
        if (!entry?.deviceId) continue;
        await audio.addOutput(entry.deviceId, {delayMs: entry.delayMs || 0});
    }
}

// --- Lock ---------------------------------------------------------------------------
//
// Blocks every control except the lock button itself, so the dock can sit under a
// cursor -- or on a screen edge -- without a stray click changing the track. The
// blocking is done in CSS with pointer-events, which is both simpler and more
// complete than trying to intercept every handler.

let isLocked = false;

function setLocked(locked) {
    isLocked = Boolean(locked);
    refreshWindowOpacity();
    containerEl.classList.toggle('locked', isLocked);

    const button = document.getElementById('lock-btn');
    button?.classList.toggle('active', isLocked);
    button?.setAttribute('title', isLocked ? 'Unlock the controls (Ctrl+L)' : 'Lock the controls (Ctrl+L)');

    const open = document.getElementById('lock-open-icon');
    const shut = document.getElementById('lock-closed-icon');
    if (open) open.style.display = isLocked ? 'none' : 'block';
    if (shut) shut.style.display = isLocked ? 'block' : 'none';
    const edgeLock = document.getElementById('edge-lock');
    if (edgeLock) {
        window.DockIcons.set(edgeLock, isLocked ? 'lock' : 'unlock');
        edgeLock.title = isLocked ? 'Unlock controls' : 'Lock controls';
    }

    window.api.setStoreValue('isLocked', isLocked);
    showToast(isLocked ? 'Controls locked' : 'Controls unlocked');
}

// CSS blocks pointers; capture handlers also block keyboard activation and
// synthetic clicks while keeping both unlock buttons usable.
document.addEventListener('click', (event) => {
    if (isLocked && !event.target.closest('#lock-btn, #edge-lock')) {
        event.preventDefault(); event.stopImmediatePropagation();
    }
}, true);
document.addEventListener('keydown', (event) => {
    if (!isLocked || (event.ctrlKey && event.key.toLowerCase() === 'l') ||
        event.target.closest('#lock-btn, #edge-lock')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    document.getElementById(containerEl.classList.contains('edge-docked') ? 'edge-lock' : 'lock-btn')?.focus();
}, true);

/** Wires the audio card. Called once from the DOM-ready block. */
function initAudioPanel() {
    const bind = (id, event, handler) =>
        document.getElementById(id)?.addEventListener(event, handler);
    bind('primary-delay', 'change', (event) => {
        event.target.value = audio.setPrimaryDelay(Number(event.target.value));
        window.api.setStoreValue('primaryDelayMs', audio.primaryDelayMs);
    });

    const crossfade = document.getElementById('crossfade-slider');
    const crossfadeValue = document.getElementById('crossfade-value');
    if (crossfade) {
        const render = () => {
            const ms = Number(crossfade.value);
            if (crossfadeValue) crossfadeValue.textContent = ms < 120 ? 'Off' : `${(ms / 1000).toFixed(1)}s`;
        };
        crossfade.addEventListener('input', () => {
            audio.setCrossfade(Number(crossfade.value));
            render();
        });
        crossfade.addEventListener('change', () => saveAudioSetting('crossfadeMs', Number(crossfade.value)));
        render();
    }

    const balance = document.getElementById('balance-slider');
    const balanceValue = document.getElementById('balance-value');
    if (balance) {
        const render = () => {
            const value = Number(balance.value);
            if (!balanceValue) return;
            balanceValue.textContent = Math.abs(value) < 0.02
                ? 'Centre'
                : `${value < 0 ? 'L' : 'R'} ${Math.round(Math.abs(value) * 100)}%`;
        };
        balance.addEventListener('input', () => {
            audio.setBalance(Number(balance.value));
            render();
        });
        balance.addEventListener('change', () => saveAudioSetting('audioBalance', Number(balance.value)));
        render();
    }

    const toggles = [
        ['gapless-toggle', 'gapless', (v) => audio.setGapless(v)],
        ['preserve-pitch-toggle', 'preservePitch', (v) => audio.setPreservePitch(v)],
        ['limiter-toggle', 'limiterEnabled', (v) => audio.setLimiter(v)],
        ['replaygain-toggle', 'replayGainEnabled', (v) => audio.setReplayGainEnabled(v)],
        ['skip-silence-toggle', 'skipSilence', (v) => audio.setSkipSilence(v)],
        ['mono-toggle', 'monoMix', (v) => audio.setMonoMix(v)],
        ['swap-toggle', 'swapChannels', (v) => audio.setSwapChannels(v)],
    ];

    for (const [id, key, apply] of toggles) {
        bind(id, 'change', (event) => {
            apply(event.target.checked);
            saveAudioSetting(key, event.target.checked);
        });
    }

    bind('replaygain-mode', 'change', (event) => {
        replayGainMode = event.target.value;
        saveAudioSetting('replayGainMode', replayGainMode);
        applyReplayGainFor(currentSongData);
    });

    bind('output-device', 'change', async (event) => {
        const ok = await audio.setOutputDevice(event.target.value);
        if (ok) {
            saveAudioSetting('outputDeviceId', event.target.value);
            persistExtraOutputs();
        } else {
            event.target.value = audio.outputDeviceId;
            showToast('Could not switch audio output.', 2500);
        }
        // The new primary must disappear from the mirror list, or it would be
        // played twice.
        renderExtraOutputs();
    });

    abButton?.addEventListener('click', cycleAbRepeat);
    audio.on('loopchange', renderAbState);
    renderAbState();

    document.getElementById('lock-btn')?.addEventListener('click', () => setLocked(!isLocked));

    const refreshDevices = () => {
        audio.removePrimaryAliases().then(persistExtraOutputs);
        populateOutputDevices();
        renderExtraOutputs();
    };
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    refreshDevices();
}

/** Reflects the loaded settings into the controls. */
async function syncAudioPanelControls() {
    document.getElementById('primary-delay').value = audio.primaryDelayMs;
    const set = (id, prop, value) => {
        const el = document.getElementById(id);
        if (el) el[prop] = value;
    };

    set('crossfade-slider', 'value', audio.crossfadeMs);
    set('balance-slider', 'value', audio.balance);
    set('gapless-toggle', 'checked', audio.gapless);
    set('preserve-pitch-toggle', 'checked', audio.preservePitch);
    set('limiter-toggle', 'checked', audio.limiterEnabled);
    set('replaygain-toggle', 'checked', audio.replayGainEnabled);
    set('skip-silence-toggle', 'checked', audio.skipSilence);
    set('mono-toggle', 'checked', audio.monoMix);
    set('swap-toggle', 'checked', audio.swapChannels);
    set('replaygain-mode', 'value', replayGainMode);

    document.getElementById('crossfade-slider')?.dispatchEvent(new Event('input'));
    document.getElementById('balance-slider')?.dispatchEvent(new Event('input'));
}

// --- Listening statistics (Phase 7) ----------------------------------------------
//
// A play count is only worth having if it means something. Letting twenty
// seconds run while hunting for another track is not a play, and neither is
// scrubbing to the end. So a listen is recorded as:
//
//   played   - reached the end, or heard >= 50% / >= 4 minutes of it
//   skipped  - left early, having heard at least 5 seconds
//   ignored  - anything shorter, which is almost always mis-clicking
//
// The thresholds mirror Last.fm's scrobbling rules, so the counters here will
// agree with a scrobbler if one is ever added (roadmap Phase 14).

const PLAY_THRESHOLD_RATIO = 0.5;
const PLAY_THRESHOLD_MS = 4 * 60 * 1000;
const SKIP_FLOOR_MS = 5000;

// The track currently being measured, and how much of it has actually elapsed.
let statsTrackPath = null;
let statsListenedMs = 0;
let statsLastTick = 0;
let statsRecorded = false;
let statsStartedAt = 0;

/** Starts measuring a new track, closing off the previous one as a skip. */
function beginListen(filePath) {
    finishListen({reason: 'switch'});
    statsTrackPath = filePath || null;
    statsListenedMs = 0;
    statsLastTick = Date.now();
    statsStartedAt = statsLastTick;
    statsRecorded = false;
}

/**
 * Accumulates elapsed wall-clock time while playing. Called from the UI loop.
 * Wall clock rather than `audio.seek()` because seeking backwards to replay a
 * chorus should add to the listened time, not subtract from it.
 */
function tickListen(isPlaying) {
    const now = Date.now();
    if (isPlaying && statsTrackPath && statsLastTick) {
        const delta = now - statsLastTick;
        // A delta larger than a couple of seconds means the machine slept or the
        // loop stalled; counting it would inflate the total.
        if (delta > 0 && delta < 2000) statsListenedMs += delta;
    }
    statsLastTick = now;
}

/** Closes off the current track and records it as a play, a skip, or nothing. */
function finishListen({reason = 'end', durationMs = 0} = {}) {
    if (!statsTrackPath || statsRecorded) return;

    const path = statsTrackPath;
    const listened = statsListenedMs;
    const total = durationMs || (audio.duration() * 1000) || 0;

    const qualifies = reason === 'end'
        || listened >= PLAY_THRESHOLD_MS
        || (total > 0 && listened >= total * PLAY_THRESHOLD_RATIO);

    if (qualifies) {
        window.api.libraryRecordPlay(path, listened, statsStartedAt);
    } else if (listened >= SKIP_FLOOR_MS) {
        window.api.libraryRecordSkip(path, listened, statsStartedAt);
    }

    statsRecorded = true;
    statsTrackPath = null;
    statsListenedMs = 0;
}

// --- Library management UI (Phase 7) ---------------------------------------------

const libraryRootsEl = document.getElementById('library-roots');
const libraryStatsEl = document.getElementById('library-stats');
const libraryStatusEl = document.getElementById('library-status');

function setLibraryStatus(message, kind = '') {
    if (!libraryStatusEl) return;
    libraryStatusEl.textContent = message || '';
    libraryStatusEl.className = `settings-hint ${kind}`.trim();
}

/** Renders the roots list and the counters. */
async function renderLibraryPanel() {
    if (!libraryRootsEl) return;

    const [roots, stats] = await Promise.all([
        window.api.libraryRoots(),
        window.api.libraryStats(),
    ]);

    libraryRootsEl.innerHTML = '';

    if (!roots.length) {
        const empty = document.createElement('div');
        empty.className = 'library-root-empty';
        empty.textContent = 'No folders yet. Add one to build your library.';
        libraryRootsEl.appendChild(empty);
    }

    for (const root of roots) {
        const row = document.createElement('div');
        row.className = 'library-root';

        const text = document.createElement('div');
        text.className = 'library-root-text';

        const name = document.createElement('span');
        name.className = 'library-root-path';
        name.textContent = root.path;
        name.title = root.path;

        const meta = document.createElement('span');
        meta.className = 'library-root-meta';
        meta.textContent = root.lastScanAt
            ? `${root.liveCount} tracks · scanned ${new Date(root.lastScanAt).toLocaleDateString()}`
            : `${root.liveCount} tracks · never scanned`;

        text.append(name, meta);

        const rescan = document.createElement('button');
        rescan.className = 'chip';
        rescan.textContent = 'Rescan';
        rescan.addEventListener('click', () => rescanLibrary(root.id));

        const remove = document.createElement('button');
        remove.className = 'chip danger';
        remove.textContent = 'Remove';
        remove.title = 'Forget this folder. Play counts and ratings are kept.';
        remove.addEventListener('click', async () => {
            await window.api.libraryRemoveRoot(root.id);
            renderLibraryPanel();
        });

        row.append(text, rescan, remove);
        libraryRootsEl.appendChild(row);
    }

    if (libraryStatsEl) {
        libraryStatsEl.textContent = stats.tracks
            ? `${stats.tracks.toLocaleString()} tracks · ${stats.artists.toLocaleString()} artists`
              + ` · ${stats.plays.toLocaleString()} plays`
              + (stats.missing ? ` · ${stats.missing} missing` : '')
            : 'Empty';
    }
}

async function rescanLibrary(rootId) {
    const cancelButton = document.getElementById('library-cancel-scan');
    if (cancelButton) cancelButton.disabled = false;
    setLibraryStatus('Scanning...');
    let result;
    try { result = await window.api.libraryRescan(rootId); }
    finally { if (cancelButton) cancelButton.disabled = true; }
    await renderLibraryPanel();
    setLibraryStatus(
        result?.cancelled ? 'Scan cancelled. Your existing library is unchanged.' : result?.restored
            ? `Scan finished. ${result.restored} missing track(s) came back.`
            : 'Scan finished.',
        'ok'
    );
}

/** Wires the library card. Called once from the DOM-ready block. */
function initLibraryPanel() {
    document.getElementById('library-cancel-scan')?.addEventListener('click', () => window.api.libraryCancelScan());
    document.getElementById('library-add-root')?.addEventListener('click', async () => {
        const cancelButton = document.getElementById('library-cancel-scan');
        if (cancelButton) cancelButton.disabled = false;
        setLibraryStatus('Scanning...');
        let result;
        try { result = await window.api.libraryAddRoot(); }
        finally { if (cancelButton) cancelButton.disabled = true; }
        await renderLibraryPanel();
        setLibraryStatus(result?.cancelled ? 'Scan cancelled. You can rescan this folder later.' : 'Folder added.', 'ok');
    });

    document.getElementById('library-rescan-all')?.addEventListener('click', () => rescanLibrary(null));

    document.getElementById('library-recheck')?.addEventListener('click', async () => {
        const restored = await window.api.libraryRecheckMissing();
        await renderLibraryPanel();
        setLibraryStatus(
            restored ? `${restored} track(s) found again.` : 'No missing tracks were found.',
            restored ? 'ok' : ''
        );
    });

    document.getElementById('library-export')?.addEventListener('click', async () => {
        const result = await window.api.libraryExport();
        if (!result) return;
        setLibraryStatus(
            result.ok ? `Exported ${result.tracks} tracks.` : (result.error || 'Export failed.'),
            result.ok ? 'ok' : 'error'
        );
    });

    document.getElementById('library-import')?.addEventListener('click', async () => {
        const result = await window.api.libraryImport();
        if (!result) return;
        await renderLibraryPanel();
        setLibraryStatus(
            result.ok ? `Merged ${result.imported} tracks.` : (result.error || 'Import failed.'),
            result.ok ? 'ok' : 'error'
        );
    });

    window.api.onScanComplete?.(({total, reparsed, missing}) => {
        renderLibraryPanel();
        setLibraryStatus(
            `${total} files · ${reparsed} re-read`
            + (missing ? ` · ${missing} now missing` : ''),
            'ok'
        );
    });

    renderLibraryPanel();
}

// --- Tag editor ------------------------------------------------------------------
//
// Everything here is explicit and uncommitted until Save: this is the one screen
// that rewrites the user's files. Fields mark themselves dirty as they diverge
// from what was read, Revert restores that snapshot, and the status line always
// names the outcome rather than silently succeeding.

const tagsTab = document.getElementById('tab-tags');
let tagsReturnTab = 'player';
let tagsTargetPath = null;
let tagsReadTicket = 0;
let tagsOriginalCover = null;
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
    const filePath = tagsTargetPath || currentSongData?.filePath || null;
    const ticket = ++tagsReadTicket;

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
    if (ticket !== tagsReadTicket) return;
    tagsOriginalCover = result.cover || (filePath === currentSongData?.filePath ? currentSongData.cover : null);

    tagsLoadedPath = filePath;
    pendingCover = undefined;
    tagsEmpty?.classList.add('hidden');
    tagsForm?.classList.remove('hidden');

    if (tagsFilename) tagsFilename.textContent = result.basename || '';
    if (tagsCover) {
        tagsCover.src = tagsOriginalCover
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
        tagsCover.src = tagsOriginalCover || '../assets/images/placeholder.png';
    }
    setTagsStatus('Reverted.', '');
}

/** Wires the editor. Called once from the DOM-ready block. */
function initTagEditor() {
    document.getElementById('tags-close')?.addEventListener('click', () => setActiveTab(tagsReturnTab));
    document.getElementById('edit-tags-btn')?.addEventListener('click', () => openTagsEditor());
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

// --- Dropdown menus ------------------------------------------------------------
// The desktop app uses native popup surfaces outside the window. The DOM menu
// definitions retain their actions and provide a fallback without the bridge.

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
    if (window.DockPopups) {
        void window.DockPopups.menu(menu, trigger);
        return;
    }
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
    containerEl.scrollLeft = 0;
    containerEl.scrollTop = 0;
    document.getElementById('tab-playlist-options')?.classList.toggle('show', tab === 'playlist-options');
    if (tab === 'playlist-options') updatePlaylistOptionsState();

    containerEl.classList.toggle('tab-settings-active', tab === 'settings');
    settingsTab?.classList.toggle('show', tab === 'settings');
    tagsTab?.classList.toggle('show', tab === 'tags');
    togglePlaylistPanel(tab === 'playlist');

    // Tags are read from disk, not from the in-memory metadata, because the
    // player's copy is a *resolved* guess (see library/metadata.js) rather than
    // what is actually stored in the file.
    if (tab === 'tags') loadTagsForCurrentTrack();

    tabPager?.querySelectorAll('.tab-dot').forEach((dot) => {
        dot.classList.toggle('active', dot.dataset.tab === (tab === 'playlist-options' ? 'playlist' : tab === 'tags' ? (tagsReturnTab === 'playlist-options' ? 'playlist' : tagsReturnTab) : tab));
        dot.setAttribute('aria-selected', String(dot.dataset.tab === (tab === 'playlist-options' ? 'playlist' : tab === 'tags' ? (tagsReturnTab === 'playlist-options' ? 'playlist' : tagsReturnTab) : tab)));
    });

    // The main process resizes the window: a settings panel does not fit in a 180px dock.
    window.api.setActiveTab(tab === 'playlist-options' ? 'playlist' : tab);
}

function openTagsEditor(filePath = currentSongData?.filePath) {
    if (typeof filePath !== 'string' || !filePath || /^https?:/i.test(filePath)) return;
    tagsTargetPath = filePath;
    tagsReturnTab = activeTab === 'tags' ? tagsReturnTab : activeTab;
    setActiveTab('tags');
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
    const detailStatus = document.getElementById('playlist-options-status');
    if (detailStatus) detailStatus.textContent = message || '';

    if (playlistStatus) playlistStatus.textContent = message || '';
}

function togglePlaylistPanel(force) {
    isPlaylistVisible = force === undefined ? !isPlaylistVisible : Boolean(force);
    playlistPanel.classList.toggle('show', isPlaylistVisible);
    if (togglePlaylistLabel) {
        togglePlaylistLabel.textContent = isPlaylistVisible ? 'Hide Playlist' : 'Show Playlist';
    }
    if (isPlaylistVisible) {
        renderLibraryViewChips();
        renderActiveLibraryView();
        // Deferred so the CSS transition has started before focus scrolls the panel.
        setTimeout(() => librarySearchInput?.focus(), 60);
    }
}

/**
 * Builds one row. Rows are plain buttons rather than a list + delegation because each
 * needs its own secondary actions, and the counts here are small.
 */
// --- Queue manipulation --------------------------------------------------------
//
// Three insert positions, because "add to queue" alone is not enough: you want a
// track next without losing what you queued, or you want it at the very front.
// Both lists are kept in step -- `playlist` is what plays, `originalPlaylist` is
// the pre-shuffle order that un-shuffling restores -- or the queue would silently
// revert the moment shuffle was toggled.

const QUEUE_POSITIONS = {
    NEXT: 'next',
    END: 'end',
    FIRST: 'first',
};

function enqueueFiles(files) {
    // Reverse insertion at "next" keeps a multi-file selection in its given order.
    for (const file of [...files].reverse()) enqueue(file, QUEUE_POSITIONS.NEXT);
}

function applyLyricsInteraction() {
    containerEl.classList.toggle('manual-scroll-enabled', isManualScrollEnabled);
    lyricsContainer.classList.toggle('lyrics-selectable', lyricsSelectable);
    const button = document.getElementById('toggle-lyrics-selection-btn');
    button.textContent = lyricsSelectable ? 'Disable Text Selection' : 'Enable Text Selection';
    button.setAttribute('aria-pressed', String(lyricsSelectable));
    if (isManualScrollEnabled && !lyrics.isSynced && lyricsContainer.firstChild) {
        lyricsContainer.firstChild.style.transform = '';
    }
    updateLyricsDropdownMenu();
}

function enqueue(filePath, position = QUEUE_POSITIONS.END) {
    if (!filePath) return;

    // A track already queued is moved rather than duplicated: two copies of the
    // same file in a queue is almost never what anyone meant.
    const existing = playlist.indexOf(filePath);
    if (existing !== -1 && existing === currentIndex) return;
    if (existing !== -1 && existing !== currentIndex) {
        playlist.splice(existing, 1);
        if (existing < currentIndex) currentIndex--;
    }

    let index;
    if (position === QUEUE_POSITIONS.FIRST) {
        index = 0;
    } else if (position === QUEUE_POSITIONS.NEXT) {
        index = playlist.length ? currentIndex + 1 : 0;
    } else {
        index = playlist.length;
    }

    playlist.splice(index, 0, filePath);
    if (index <= currentIndex && playlist.length > 1) currentIndex++;

    originalPlaylist = [...playlist];

    // What plays after this track may have changed, so what should be buffered has
    // changed with it.
    updateNextTrackHint();
    savePlaybackState();
    publishRoomLibrary();
    if (isPlaylistVisible) renderActiveLibraryView();

    showToast({
        [QUEUE_POSITIONS.FIRST]: 'Moved to the top of the queue',
        [QUEUE_POSITIONS.NEXT]: 'Playing next',
        [QUEUE_POSITIONS.END]: 'Added to the queue',
    }[position]);
}

/** The three queue actions, ready to hand to makeRow(). */
function queueActions(filePath) {
    return [
        {icon: 'up', title: 'Move to the top of the queue',
            onClick: () => enqueue(filePath, QUEUE_POSITIONS.FIRST)},
        {icon: 'next', title: 'Play next',
            onClick: () => enqueue(filePath, QUEUE_POSITIONS.NEXT)},
        {icon: 'plus', title: 'Add to the end of the queue',
            onClick: () => enqueue(filePath, QUEUE_POSITIONS.END)},
    ];
}

const failedPlaylistTracks=new Map();
let fileStatusTimer;
function paintTrackAvailability(row,reason){
    row.classList.toggle('unavailable',Boolean(reason));
    row.title=reason?`${reason} — skipped; remove this track or restore the file`:'';
    let label=row.querySelector('.playlist-unavailable-label');
    if(reason&&!label){label=document.createElement('span');label.className='playlist-unavailable-label';row.querySelector('.playlist-row-main').append(label);}
    if(label){if(reason)label.textContent=`${reason} · skipped`;else label.remove();}
}
function markPlaylistTrackFailed(filePath,reason='Cannot open file'){
    if(!filePath)return;
    failedPlaylistTracks.set(filePath,reason);
    playlistResults.querySelectorAll('[data-file-path]').forEach(row=>{
        if(row.dataset.filePath===filePath)paintTrackAvailability(row,reason);
    });
}
async function refreshPlaylistFileStatus(){
    const rows=[...playlistResults.querySelectorAll('[data-file-path]')];
    const files=[...new Set(rows.map(row=>row.dataset.filePath))];
    for(let index=0;index<files.length;index+=250){
        const statuses=await window.api.playlistFileStatus(files.slice(index,index+250));
        for(const status of statuses){
            for(const row of rows){
                if(!row.isConnected||row.dataset.filePath!==status.filePath)continue;
                const failed=failedPlaylistTracks.get(status.filePath);
                paintTrackAvailability(row,!status.available?'File missing or unreadable':failed);
            }
        }
    }
}
function makeRow({title, subtitle, badge, active, filePath, missing, onPlay, actions = []}) {
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
    if(filePath){
        row.dataset.filePath=filePath;
        paintTrackAvailability(row,failedPlaylistTracks.get(filePath)||(missing?'File missing or unreadable':null));
        clearTimeout(fileStatusTimer);
        fileStatusTimer=setTimeout(()=>refreshPlaylistFileStatus().catch(console.warn),80);
    }

    if (badge) {
        const badgeEl = document.createElement('span');
        badgeEl.className = 'playlist-row-badge';
        badgeEl.textContent = badge;
        row.appendChild(badgeEl);
    }

    const rowActions = filePath && !/^https?:/i.test(filePath)
        ? [{icon: 'edit', title: 'Edit tags', onClick: () => openTagsEditor(filePath)}] : [];
    if (actions.length) rowActions.push({icon: 'menu', title: 'More song actions', onClick: async trigger => {
        const rect = trigger.getBoundingClientRect();
        const index = await window.api.showNativePopup({x: rect.left, y: rect.bottom,
            items: actions.map(action => ({label: action.title}))});
        if (!isLocked && Number.isInteger(index) && actions[index]) actions[index].onClick();
    }});
    for (const action of rowActions) {
        const button = document.createElement('button');
        button.className = 'playlist-row-action';
        button.title = action.title;
        button.setAttribute('aria-label', action.title);
        if (action.icon) button.appendChild(window.DockIcons.create(action.icon));
        if (action.label) button.appendChild(document.createTextNode(action.label));
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            action.onClick(button);
        });
        row.appendChild(button);
    }

    return row;
}

/** Shows the current queue, with the playing track highlighted. */
let lastQueueWindowStart=-1;
function renderQueue() {
    if (!playlistResults) return;
    if (browseControlsActive()) { renderBrowseView('queue'); return; }
    const scroll=playlistResults.scrollTop;
    playlistResults.innerHTML = '';

    if (playlist.length === 0) {
        setPlaylistStatus('Queue is empty. Open a file or folder to begin.');
        return;
    }

    setPlaylistStatus(`${playlist.length} track${playlist.length === 1 ? '' : 's'} in queue`);

    const virtual=playlist.length>100;
    const start=virtual?Math.max(0,Math.floor(scroll/44)-5):0;
    lastQueueWindowStart=start;
    const end=virtual?Math.min(playlist.length,start+40):playlist.length;
    if(virtual){const top=document.createElement('div');top.style.height=start*44+'px';playlistResults.append(top);}
    playlist.slice(start,end).forEach((filePath, relativeIndex) => {
        const index=start+relativeIndex;
        const name = filePath.split(/[\\/]/).pop();
        const row = makeRow({
            filePath,
            title: name,
            active: index === currentIndex,
            onPlay: () => playTrack(index),
            actions: [{
                icon: 'close',
                title: 'Remove from queue',
                onClick: () => removeFromQueue(index),
            }],
        });
        row.draggable = true;
        if(virtual){row.style.height='44px';row.style.flexShrink='0';row.style.margin='0';}
        row.dataset.queueIndex = index;
        row.addEventListener('dragstart', event => {
            if(isLocked){event.preventDefault();return;}
            event.dataTransfer.setData('application/x-rhythm-queue',String(index));
            event.dataTransfer.effectAllowed='move';
        });
        row.addEventListener('dragover',event=>{
            if(event.dataTransfer.types.includes('application/x-rhythm-queue'))event.preventDefault();
        });
        row.addEventListener('drop',event=>{
            if(!event.dataTransfer.types.includes('application/x-rhythm-queue')||isLocked)return;
            event.preventDefault();event.stopPropagation();
            moveQueueItem(Number(event.dataTransfer.getData('application/x-rhythm-queue')),index);
        });
        playlistResults.appendChild(row);
    });
    if(virtual){const bottom=document.createElement('div');bottom.style.height=(playlist.length-end)*44+'px';playlistResults.append(bottom);}
    playlistResults.scrollTop=scroll;
}
playlistResults?.addEventListener('scroll',()=>{
    if(playlist.length>100&&activeLibraryView==='queue'&&!browseControlsActive()&&(!room.connected||room.isHost)&&
        Math.max(0,Math.floor(playlistResults.scrollTop/44)-5)!==lastQueueWindowStart)renderQueue();
});

/**
 * Removes one entry from the queue, keeping `currentIndex` pointing at the same track.
 * Getting this wrong silently shifts playback onto a neighbouring song.
 */
function removeFromQueue(index) {
    if (!Number.isInteger(index) || index < 0 || index >= playlist.length) return;
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
    updateNextTrackHint();
    publishRoomLibrary();
    publishRoomState();
}

/** Reorder while preserving the identity of the currently playing track. */
function moveQueueItem(from, to) {
    if (![from, to].every((index) => Number.isInteger(index) && index >= 0 && index < playlist.length)) return;
    if (from === to) return;
    const playingPath = playlist[currentIndex];
    const [item] = playlist.splice(from, 1);
    playlist.splice(to, 0, item);
    currentIndex = playingPath ? playlist.indexOf(playingPath) : -1;
    originalPlaylist = [...playlist];
    updateNextTrackHint();
    renderQueue();
    savePlaybackState();
    publishRoomLibrary();
    publishRoomState();
}

// --- Shortcuts guide -------------------------------------------------------------
//
// Nearly every control in the app has a keyboard equivalent and none of them were
// written down anywhere, which meant they effectively did not exist. Generated
// from a table rather than hand-written markup so a new shortcut is one line.

const SHORTCUT_GROUPS = [
    {
        title: 'Playback',
        items: [
            ['Space', 'Play or pause'],
            ['\u2190 / \u2192', 'Seek back / forward 5 seconds'],
            ['Ctrl + \u2190 / \u2192', 'Previous / next track'],
            ['\u2191 / \u2193', 'Volume up / down'],
            ['M', 'Mute'],
            ['S', 'Shuffle'],
            ['R', 'Repeat: off \u2192 all \u2192 one'],
            ['L', 'Like the current track'],
        ],
    },
    {
        title: 'Speed',
        items: [
            ['[', 'Slower'],
            [']', 'Faster'],
            ['\\', 'Back to normal speed'],
            ['Scroll on the speed pill', 'Nudge up or down'],
        ],
    },
    {
        title: 'Lyrics',
        items: [
            ['- / +', 'Shift lyrics earlier / later by 0.1s'],
            ['T', 'Toggle translation'],
        ],
    },
    {
        title: 'Mouse',
        items: [
            ['Scroll on album art', 'Volume'],
            ['Scroll on the volume button', 'Volume'],
            ['Shift + scroll', 'Fine volume steps'],
            ['Scroll on the progress bar', 'Seek'],
            ['Ctrl + click the volume button', 'Toggle the equalizer'],
            ['Click the remaining time', 'Switch to total duration'],
            ['Drag a file or folder in', 'Play it'],
        ],
    },
    {
        title: 'Window',
        items: [
            ['Ctrl + L', 'Lock / unlock all controls'],
            ['Esc', 'Close a menu, then return to the player'],
            ['O', 'Open a folder'],
            ['P', 'Pin on top'],
            ['V', 'Switch horizontal / vertical'],
            ['Ctrl + Alt + D', 'Stick to or leave the screen edge'],
        ],
    },
];

function initShortcutsPanel() {
    const host = document.getElementById('shortcuts-list');
    if (!host || host.childElementCount) return;

    for (const group of SHORTCUT_GROUPS) {
        const heading = document.createElement('div');
        heading.className = 'shortcut-group';
        heading.textContent = group.title;
        host.appendChild(heading);

        for (const [keys, description] of group.items) {
            const row = document.createElement('div');
            row.className = 'shortcut-row';

            const label = document.createElement('span');
            label.className = 'shortcut-desc';
            label.textContent = description;

            const key = document.createElement('kbd');
            key.className = 'shortcut-key';
            key.textContent = keys;

            row.append(label, key);
            host.appendChild(row);
        }
    }
}

// --- Library views ---------------------------------------------------------------
//
// The Library tab only ever showed the current queue, so everything the app knew
// about -- liked songs, what was played recently, what gets played most -- was
// unreachable. These are the lists Phase 7's database made possible; the chips
// switch between them, and search still overrides whichever is selected.

let activeLibraryView = 'queue';
let namedPlaylistId = null;
let browseRevision = 0;

function browseControlsActive() {
    return Boolean(librarySearchInput?.value.trim() || document.getElementById('playlist-filter')?.value !== 'all' ||
        document.getElementById('playlist-sort')?.value !== 'original');
}

function filterAndSortTracks(rows) {
    const query = librarySearchInput.value.trim().toLocaleLowerCase();
    const filter = document.getElementById('playlist-filter').value;
    const sort = document.getElementById('playlist-sort').value;
    const liked = new Set(favoritesPlaylist);
    const result = rows.filter(row => {
        const text = [row.title,row.artist,row.album,row.basename,row.filePath].filter(Boolean).join(' ').toLocaleLowerCase();
        return (!query || text.includes(query)) && (filter !== 'liked' || liked.has(row.filePath)) &&
            (filter !== 'long' || row.durationSeconds >= 300) &&
            (filter !== 'short' || (row.durationSeconds > 0 && row.durationSeconds < 300));
    });
    if (sort !== 'original') result.sort((a,b) => sort.startsWith('duration')
        ? ((a.durationSeconds || 0) - (b.durationSeconds || 0)) * (sort.endsWith('desc') ? -1 : 1)
        : String(a[sort] || a.basename || '').localeCompare(String(b[sort] || b.basename || ''), undefined, {numeric:true,sensitivity:'base'}));
    return result;
}

async function renderBrowseView(view) {
    const revision = ++browseRevision;
    let rows;
    if (view === 'all') {
        const filter = document.getElementById('playlist-filter').value;
        const sort = document.getElementById('playlist-sort').value;
        const options = {rootsOnly:true, query:librarySearchInput.value.trim(), limit:200,
            durationFilter:filter, sort:sort==='original'?'title':sort.replace('-desc',''), desc:sort.endsWith('-desc')};
        if (filter === 'liked') options.filePaths = favoritesPlaylist;
        const result = await window.api.roadmap('catalog', options);
        if (revision !== browseRevision || activeLibraryView !== view) return;
        if (!result.ok) { setPlaylistStatus(result.error || 'Could not load All Songs'); return; }
        rows = result.data.rows;
        playlistResults.replaceChildren();
        setPlaylistStatus(`${result.data.total} songs from music source folders`);
        if (!result.data.total) {
            setPlaylistStatus('No matching songs. Add music source folders in Settings, or clear your filters.');
            const button = document.createElement('button');button.className='settings-button';button.textContent='Music Source Folders';
            button.onclick=()=>setActiveTab('settings');playlistResults.append(button);return;
        }
        const playAll = async (filePath) => {
            const paths=[];
            for(let offset=0;offset<result.data.total;offset+=200){
                const page=await window.api.roadmap('catalog',{...options,offset});
                if(!page.ok)return showToast(page.error || 'Could not load songs');
                paths.push(...page.data.rows.map(row=>row.filePath));
            }
            loadPlaylistAndPlay(paths,Math.max(0,paths.indexOf(filePath)),{playlistName:'All Songs'});
        };
        const append = page => page.forEach(row=>playlistResults.append(makeRow({filePath:row.filePath,missing:row.missing,title:row.title||row.basename,
            subtitle:row.artist,onPlay:()=>playAll(row.filePath),actions:queueActions(row.filePath)})));
        append(rows);
        if(rows.length<result.data.total){
            let offset=rows.length;
            const more=document.createElement('button');more.className='settings-button';more.textContent='Load More Songs';
            more.onclick=async()=>{more.disabled=true;try{
                const page=await window.api.roadmap('catalog',{...options,offset});
                if(revision!==browseRevision||activeLibraryView!==view)return;
                if(!page.ok)return showToast(page.error||'Could not load songs');
                more.remove();append(page.data.rows);offset+=page.data.rows.length;
                if(offset<page.data.total)playlistResults.append(more);
            }finally{more.disabled=false;}};
            playlistResults.append(more);
        }
        return;
    }
    if (view === 'named') rows = namedPlaylistId ? await window.api.playlistTracks(namedPlaylistId) : [];
    else if (view === 'queue' || view === 'liked') {
        const paths = view === 'queue' ? [...playlist] : [...favoritesPlaylist];
        const details = new Map((await window.api.libraryTrackDetails(paths)).map(row=>[row.filePath,row]));
        rows=paths.map((filePath,index)=>({...details.get(filePath),filePath,queueIndex:index,
            basename:details.get(filePath)?.basename || filePath.split(/[\\/]/).pop()}));
    } else if (view === 'for-you') rows = await window.api.libraryRecommendations({filePath:currentSongData?.filePath,liked:favoritesPlaylist,limit:100});
    else rows = await window.api.libraryView(view,10000);
    if(revision!==browseRevision||activeLibraryView!==view)return;
    if(view==='named'&&rows?.length){
        const details=new Map((await window.api.libraryTrackDetails(rows.map(row=>row.filePath))).map(row=>[row.filePath,row]));
        rows=rows.map(row=>({...row,...details.get(row.filePath)}));
    }
    if(revision!==browseRevision||activeLibraryView!==view)return;
    rows=filterAndSortTracks(rows || []);
    playlistResults.replaceChildren();
    setPlaylistStatus(`${rows.length} matching tracks${view==='named'?' in this playlist':''}`);
    const playable=rows.filter(row=>!row.missing).map(row=>row.filePath);
    let shown=0;
    const more=document.createElement('button');more.className='settings-button';more.textContent='Load More Tracks';
    const append=()=>{
        more.remove();
        for(const row of rows.slice(shown,shown+200))playlistResults.append(makeRow({
            filePath:row.filePath,missing:row.missing,
            title:row.title||row.basename||row.filePath,subtitle:row.artist|| (row.missing?'File is missing':''),
            active:row.filePath===playlist[currentIndex],onPlay:()=>view==='queue'?playTrack(row.queueIndex):
                !row.missing&&loadPlaylistAndPlay(playable,playable.indexOf(row.filePath),{playlistName:view==='named'?selectedPlaylistName():view==='liked'?'Liked Songs':LIBRARY_VIEWS.find(item=>item.id===view)?.label||'Queue'}),
            actions:[...queueActions(row.filePath),...(view==='named'?[{icon: 'close',title:'Remove from this playlist',onClick:async()=>{
                await window.api.playlistRemove(namedPlaylistId,row.filePath);await refreshNamedPlaylists();renderActiveLibraryView();
            }}]:view==='queue'?[{icon: 'close',title:'Remove from queue',onClick:()=>removeFromQueue(row.queueIndex)}]:[])],
        }));
        shown+=200;if(shown<rows.length)playlistResults.append(more);
    };
    more.onclick=append;append();
}

const LIBRARY_VIEWS = [
    {id: 'queue',           label: 'Queue'},
    {id: 'all',             label: 'All Songs'},
    {id: 'liked',           label: 'Liked'},
    {id: 'recently-played', label: 'Recent'},
    {id: 'most-played',     label: 'Most Played'},
    {id: 'recently-added',  label: 'Added'},
    {id: 'for-you',         label: 'For You'},
];

function renderLibraryViewChips() {
    const bar = document.getElementById('library-view-chips');
    if (!bar) return;
    bar.classList.toggle('hidden', room.connected && !room.isHost);
    if (room.connected && !room.isHost) return;

    if (bar.childElementCount === 0) {
        for (const view of LIBRARY_VIEWS) {
            const chip = document.createElement('button');
            chip.className = 'chip';
            chip.dataset.view = view.id;
            chip.textContent = view.label;
            chip.addEventListener('click', () => setLibraryView(view.id));
            bar.appendChild(chip);
        }
    }

    bar.querySelectorAll('.chip').forEach((chip) => {
        chip.classList.toggle('active', chip.dataset.view === activeLibraryView);
    });
}

function setLibraryView(view) {
    activeLibraryView = view;
    updatePlaylistOptionsState();
    renderLibraryViewChips();

    // Switching view is an explicit choice; a stale search term would silently
    // override it and look like the chip did nothing.
    if (librarySearchInput) librarySearchInput.value = '';

    renderActiveLibraryView();
}

/** Draws whichever view is selected. */
async function renderActiveLibraryView() {
    if (!playlistResults) return;
    ++browseRevision;
    document.querySelector('.playlist-browse-controls').hidden = room.connected && !room.isHost;

    if (room.connected && !room.isHost) {
        renderRemoteQueue();
        return;
    }

    if (activeLibraryView === 'all' || browseControlsActive()) {
        await renderBrowseView(activeLibraryView);
        return;
    }

    if (activeLibraryView === 'named') {
        await renderNamedPlaylist();
        return;
    }

    if (activeLibraryView === 'queue') {
        renderQueue();
        return;
    }

    if (activeLibraryView === 'liked') {
        renderLikedSongs();
        return;
    }

    if (activeLibraryView === 'for-you') {
        await renderRecommendations();
        return;
    }

    const rows = await window.api.libraryView(activeLibraryView, 100);
    playlistResults.innerHTML = '';

    if (!rows || rows.length === 0) {
        setPlaylistStatus(
            activeLibraryView === 'recently-added'
                ? 'Nothing yet. Add a folder in Settings.'
                : 'Nothing here yet — play some music first.'
        );
        return;
    }

    setPlaylistStatus(`${rows.length} track${rows.length === 1 ? '' : 's'}`);

    rows.forEach((track, index) => {
        playlistResults.appendChild(makeRow({
            title: track.title || track.basename,
            filePath:track.filePath,missing:track.missing,
            subtitle: track.artist,
            badge: track.playCount > 0 ? `${track.playCount}` : undefined,
            // Playing from a list should queue the whole list, not just the one
            // row -- otherwise playback stops dead after a single track.
            onPlay: () => loadPlaylistAndPlay(rows.map((row) => row.filePath), index,{playlistName:LIBRARY_VIEWS.find(view=>view.id===activeLibraryView)?.label||'Queue'}),
            actions: [...queueActions(track.filePath), {
                icon: 'star', label: String(track.rating || 0), title: 'Increase rating (5 stars, then clear)',
                onClick: async () => {
                    await window.api.librarySetRating(track.filePath, ((track.rating || 0) + 1) % 6);
                    renderActiveLibraryView();
                },
            }],
        }));
    });
}

async function renderRecommendations() {
    const hidden = await window.api.getStoreValue('hiddenRecommendations') || [];
    const options = {
        filePath: currentSongData?.filePath,
        artist: currentSongData?.artist,
        album: currentSongData?.album,
        genre: currentSongData?.genre,
        mood: document.getElementById('discovery-mood')?.value || '',
        liked: favoritesPlaylist,
        hidden,
        limit: 25,
    };
    const [rows, albums] = await Promise.all([
        window.api.libraryRecommendations(options),
        window.api.libraryAlbumRecommendations({...options, limit: 5}),
    ]);
    playlistResults.replaceChildren();
    if (!rows.length && !albums.length) return setPlaylistStatus('No suggestions yet. Add a folder and play a few songs.');
    setPlaylistStatus('Suggestions learn from your feedback, moods, plays, skips, ratings and likes.');
    if (albums.length) {
        const heading = document.createElement('div');
        heading.className = 'playlist-section-heading';
        heading.textContent = 'Albums for you';
        playlistResults.appendChild(heading);
        for (const album of albums) {
            playlistResults.appendChild(makeRow({
                title: album.album,
                subtitle: [album.artist, `${album.tracks.length} songs`, album.reason].filter(Boolean).join(' · '),
                onPlay: () => loadPlaylistAndPlay(album.tracks, 0),
            }));
        }
    }
    if (rows.length) {
        const heading = document.createElement('div');
        heading.className = 'playlist-section-heading';
        heading.textContent = 'Songs for you';
        playlistResults.appendChild(heading);
    }
    const paths = rows.map((row) => row.filePath);
    rows.forEach((row, index) => playlistResults.appendChild(makeRow({
        filePath:row.filePath,missing:row.missing,
        title: row.title || row.basename,
        subtitle: [row.artist, row.reason].filter(Boolean).join(' · '),
        onPlay: () => loadPlaylistAndPlay(paths, index),
        actions: [...queueActions(row.filePath), {
            icon: 'star', label: String(row.rating || 0), title: 'Increase rating (5 stars, then clear)',
            onClick: async () => {
                await window.api.librarySetRating(row.filePath, ((row.rating || 0) + 1) % 6);
                renderRecommendations();
            },
        }, {
            icon: 'plus', title: 'More like this', onClick: async () => {
                await window.api.libraryPreferenceSet(row.filePath, {feedback: 1});
                renderRecommendations();
            },
        }, {
            icon: 'minus', title: 'Less like this', onClick: async () => {
                await window.api.libraryPreferenceSet(row.filePath, {feedback: -1});
                renderRecommendations();
            },
        }, {
            icon: 'close', title: 'Do not suggest this song', onClick: () => {
                const next = [...new Set([...hidden, row.filePath])];
                window.api.setStoreValue('hiddenRecommendations', next);
                renderRecommendations();
            },
        }],
    })));
}

function updatePlaylistOptionsState() {
    const named = activeLibraryView === 'named' && Boolean(namedPlaylistId);
    const selectedActions = document.getElementById('playlist-selected-actions');
    if (selectedActions) selectedActions.hidden = !named;
    for (const id of ['named-playlist-play','named-playlist-add-current','named-playlist-delete','named-playlist-export']) {
        const button = document.getElementById(id);
        if (button) button.disabled = !named;
    }
    const heading = document.getElementById('playlist-options-title');
    if (heading) heading.textContent = named ? selectedPlaylistName() : 'Playlist options';
}

async function refreshNamedPlaylists(selectedId = namedPlaylistId) {
    const select = document.getElementById('named-playlist-select');
    if (!select) return;
    const lists = await window.api.playlistList();
    select.replaceChildren(new Option('Choose a playlist', ''));
    for (const list of lists) select.add(new Option(`${list.name} (${list.trackCount})`, String(list.id)));
    if (selectedId && lists.some((list) => list.id === Number(selectedId))) {
        namedPlaylistId = Number(selectedId);
        select.value = String(selectedId);
    } else {
        namedPlaylistId = null;
    }
    updatePlaylistOptionsState();
}

async function renderNamedPlaylist() {
    if (browseControlsActive()) return renderBrowseView('named');
    if (!namedPlaylistId) {
        playlistResults.replaceChildren();
        setPlaylistStatus('Choose a playlist or create one.');
        return;
    }
    const rows = await window.api.playlistTracks(namedPlaylistId);
    playlistResults.replaceChildren();
    setPlaylistStatus(`${rows.length} song${rows.length === 1 ? '' : 's'} in this playlist`);
    const playable = rows.filter((row) => !row.missing).map((row) => row.filePath);
    for (const row of rows) {
        playlistResults.appendChild(makeRow({
            title: row.title || row.basename || row.filePath.split(/[\\/]/).pop(),
            filePath:row.filePath,missing:row.missing,
            subtitle: row.artist || (row.missing ? 'File is missing' : ''),
            onPlay: () => {
                const index = playable.indexOf(row.filePath);
                if (index >= 0) loadPlaylistAndPlay(playable, index,{playlistName:selectedPlaylistName()});
            },
            actions: [...queueActions(row.filePath), {
                icon: 'close', title: 'Remove from this playlist', onClick: async () => {
                    await window.api.playlistRemove(namedPlaylistId, row.filePath);
                    await refreshNamedPlaylists();
                    renderNamedPlaylist();
                },
            }],
        }));
    }
}

function initNamedPlaylists() {
    document.getElementById('playlist-options-open')?.addEventListener('click', () => {
        updatePlaylistOptionsState();
        setActiveTab('playlist-options');
    });
    document.getElementById('playlist-options-back')?.addEventListener('click', () => setActiveTab('playlist'));

    const select = document.getElementById('named-playlist-select');
    const name = document.getElementById('named-playlist-name');
    refreshNamedPlaylists();
    select?.addEventListener('change', () => {
        namedPlaylistId = Number(select.value) || null;
        updatePlaylistOptionsState();
        setLibraryView(namedPlaylistId ? 'named' : 'queue');
    });
    const create = async (paths) => {
        const result = await window.api.playlistCreate(name.value, paths);
        if (!result.ok) return setPlaylistStatus(result.error);
        name.value = '';
        await refreshNamedPlaylists(result.id);
        setLibraryView('named');
    };
    document.getElementById('named-playlist-create')?.addEventListener('click', () => create([]));
    document.getElementById('named-playlist-save-queue')?.addEventListener('click', () => create([...playlist]));
    document.getElementById('named-playlist-play')?.addEventListener('click', async () => {
        if (!namedPlaylistId) return setPlaylistStatus('Choose a playlist first.');
        const rows = filterAndSortTracks(await window.api.playlistTracks(namedPlaylistId));
        const paths = rows.filter((row) => !row.missing).map((row) => row.filePath);
        if (!paths.length) return setPlaylistStatus('This playlist has no available songs.');
        loadPlaylistAndPlay(paths,0,{playlistName:selectedPlaylistName()});
    });
    document.getElementById('named-playlist-add-current')?.addEventListener('click', async () => {
        if (!namedPlaylistId) return setPlaylistStatus('Choose a playlist first.');
        if (!currentSongData?.filePath) return setPlaylistStatus('Play a song to add it.');
        const added = await window.api.playlistAdd(namedPlaylistId, currentSongData.filePath);
        setPlaylistStatus(added ? 'Song added to playlist.' : 'Song is already in this playlist.');
        await refreshNamedPlaylists();
        if (activeLibraryView === 'named') renderNamedPlaylist();
    });
    document.getElementById('named-playlist-delete')?.addEventListener('click', async () => {
        if (!namedPlaylistId) return setPlaylistStatus('Choose a playlist first.');
        if (!await window.api.playlistDelete(namedPlaylistId)) return;
        await refreshNamedPlaylists(null);
        setLibraryView('queue');
        setPlaylistStatus('Playlist deleted. Songs remain on disk.');
    });
    document.getElementById('named-playlist-import')?.addEventListener('click', async () => {
        const result = await window.api.playlistImportFile();
        if (result.cancelled) return;
        if (!result.ok) return setPlaylistStatus(`Import failed: ${result.error}`);
        await refreshNamedPlaylists(result.id);
        setLibraryView('named');
        setPlaylistStatus(`Imported ${result.count} songs.`);
    });
    document.getElementById('named-playlist-export')?.addEventListener('click', async () => {
        if (!namedPlaylistId) return setPlaylistStatus('Choose a playlist first.');
        const result = await window.api.playlistExportFile(namedPlaylistId);
        if (!result.cancelled) setPlaylistStatus(result.ok
            ? `Exported ${result.count} songs.` : `Export failed: ${result.error}`);
    });
    document.getElementById('add-to-playlist-btn')?.addEventListener('click', async () => {
        setActiveTab('playlist');
        await refreshNamedPlaylists();
        select?.focus();
        setPlaylistStatus('Choose a playlist, then open Playlist options to add this song.');
    });
}

function initRemoteAudio() {
    const input = document.getElementById('remote-audio-url');
    const add = document.getElementById('remote-audio-add');
    const save = document.getElementById('remote-audio-save');
    const play = document.getElementById('remote-audio-play');
    let lastLinkFile = null;
    const importLink = async playNow => {
        const url = input.value.trim();
        if (!url) return setPlaylistStatus('Paste a YouTube, YouTube Music, Spotify track or HTTPS audio link.');
        add.disabled = true;
        play.disabled = true;
        setPlaylistStatus('Downloading audio to the temporary cache…');
        try {
            const result = await window.api.remoteAudioAdd(url);
            if (!result.ok) return setPlaylistStatus(`Could not add link: ${result.error}`);
            lastLinkFile = result.files[0];
            const position = document.getElementById('remote-audio-position').value;
            if (playNow && !queueMode) await loadPlaylistAndPlay(result.files);
            else {
                const files = position === 'end' ? result.files : [...result.files].reverse();
                for (const filePath of files) enqueue(filePath, position);
            }
            input.value = '';
            setPlaylistStatus(`${result.files.length} song(s) ${playNow&&!queueMode?'ready to play':'added to the queue'}.` +
                (result.provider==='spotify'?' Spotify metadata; audio matched on YouTube.':'')+
                (result.cached?' Loaded from cache.':'')+
                (result.errors.length ? ` ${result.errors.length} link(s) could not be added.` : ''));
        } catch(error) {setPlaylistStatus(error.message);}
        finally { add.disabled = false; play.disabled = false; }
    };
    add?.addEventListener('click', () => importLink(false));
    play?.addEventListener('click', () => importLink(true));
    input?.addEventListener('keydown', event => {if(event.key==='Enter'&&!add.disabled)importLink(true);});
    document.getElementById('remote-audio-cancel').addEventListener('click',()=>window.api.remoteAudioCancel());
    document.getElementById('remote-audio-download').addEventListener('click',async event=>{
        const button=event.currentTarget;
        const filePath=lastLinkFile||currentSongData?.filePath;
        if(!filePath)return setPlaylistStatus('Add or play a link first.');
        button.disabled=true;
        try {
            const result=await window.api.remoteAudioDownload(filePath);
            if(result.error)setPlaylistStatus(result.error);
            else if(result.ok)setPlaylistStatus('MP3 saved with embedded tags and available artwork.');
        }catch(error){setPlaylistStatus(error.message);}
        finally{button.disabled=false;}
    });
    for(const [id,tool] of [['link-tool-ytdlp','ytdlp'],['link-tool-spotdl','spotdl']]){
        document.getElementById(id).addEventListener('click',async()=>{
            const result=await window.api.linkToolPick(tool);
            document.getElementById('link-tools-status').textContent=result.error||(result.ok?'Executable selected. Use Check Link Tools to verify.':'');
        });
    }
    document.getElementById('link-tools-check').addEventListener('click',async event=>{
        const button=event.currentTarget;button.disabled=true;
        try{document.getElementById('link-tools-status').textContent=(await window.api.linkToolsCheck()).message;}
        finally{button.disabled=false;}
    });
    save?.addEventListener('click', async () => {
        const current = currentSongData?.filePath;
        if (!current) return setPlaylistStatus('Play a downloaded link first.');
        save.disabled = true;
        try {
            const result = await window.api.remoteAudioSave(current);
            if (!result.ok) return setPlaylistStatus(`Could not save song: ${result.error}`);
            playlist = playlist.map((filePath) => filePath === current ? result.filePath : filePath);
            originalPlaylist = originalPlaylist.map((filePath) => filePath === current ? result.filePath : filePath);
            currentSongData.filePath = result.filePath;
            activePlaybackFilePath = result.filePath;
            savePlaybackState();
            publishRoomLibrary();
            setPlaylistStatus('Saved to your library.');
        } finally { save.disabled = false; }
    });
    window.api.onRemoteAudioProgress(({received, total, stage}) => {
        if (add?.disabled) setPlaylistStatus(stage || (total
            ? `Downloading audio: ${Math.round(received / total * 100)}%`
            : `Downloading audio: ${(received / 1024 / 1024).toFixed(1)} MB`));
    });
}

function renderRemoteQueue() {
    const queue = room.remoteLibrary?.queue || [];
    playlistResults.replaceChildren();
    setPlaylistStatus(`${queue.length} shared track${queue.length === 1 ? '' : 's'}`);
    queue.forEach((track, index) => {
        const actions = room.role === 'controller' ? [
            {icon: 'up', title: 'Move up', onClick: () =>
                window.api.roomControl('queue:move', {trackId: track.id, direction: 'up'})},
            {icon: 'down', title: 'Move down', onClick: () =>
                window.api.roomControl('queue:move', {trackId: track.id, direction: 'down'})},
            {icon: 'close', title: 'Remove from shared queue', onClick: () =>
                window.api.roomControl('queue:remove', {trackId: track.id})},
        ] : [];
        if (index === 0) actions.shift();
        if (index === queue.length - 1) actions.splice(index === 0 ? 0 : 1, 1);
        playlistResults.appendChild(makeRow({
            title: track.title || track.id,
            subtitle: track.artist,
            active: index === remoteState?.queueIndex,
            onPlay: () => room.role === 'controller' && window.api.roomControl('select', index),
            actions,
        }));
    });
}

/** The liked-songs list, which lives in settings rather than the database. */
function renderLikedSongs() {
    playlistResults.innerHTML = '';

    if (!favoritesPlaylist.length) {
        setPlaylistStatus('No liked songs yet. Press the heart on a track you like.');
        return;
    }

    setPlaylistStatus(`${favoritesPlaylist.length} liked song${favoritesPlaylist.length === 1 ? '' : 's'}`);

    favoritesPlaylist.forEach((filePath, index) => {
        playlistResults.appendChild(makeRow({
            title: filePath.split(/[\\/]/).pop(),
            filePath,
            active: filePath === playlist[currentIndex],
            onPlay: () => loadPlaylistAndPlay([...favoritesPlaylist], index,{playlistName:'Liked Songs'}),
            actions: [...queueActions(filePath), {
                icon: 'close',
                title: 'Remove from liked songs',
                onClick: () => {
                    favoritesPlaylist.splice(index, 1);
                    window.api.setStoreValue('favoritesPlaylist', favoritesPlaylist);
                    updateLikeButtonUI();
                    renderLikedSongs();
                },
            }],
        }));
    });
}

/** Renders search results: artists first, then individual tracks. */
async function runLibrarySearch(query) {
    if (!playlistResults) return;
    if (!room.connected || room.isHost) return renderActiveLibraryView();

    if (room.connected && !room.isHost) {
        const needle = (query || '').trim().toLocaleLowerCase();
        if (!needle) return renderRemoteQueue();
        const tracks = (room.remoteLibrary?.tracks || []).filter((track) =>
            `${track.title || ''} ${track.artist || ''}`.toLocaleLowerCase().includes(needle)).slice(0, 50);
        playlistResults.replaceChildren();
        setPlaylistStatus(`${tracks.length} shared song${tracks.length === 1 ? '' : 's'} found`);
        for (const track of tracks) {
            playlistResults.appendChild(makeRow({
                title: track.title || track.id,
                subtitle: track.artist,
                onPlay: () => room.role === 'controller' &&
                    window.api.roomControl('queue:add', {trackId: track.id, position: 'end'}),
                actions: room.role === 'controller' ? [
                    {icon: 'up', title: 'Add at top', onClick: () => window.api.roomControl('queue:add', {trackId: track.id, position: 'first'})},
                    {icon: 'next', title: 'Play next', onClick: () => window.api.roomControl('queue:add', {trackId: track.id, position: 'next'})},
                    {icon: 'plus', title: 'Add at end', onClick: () => window.api.roomControl('queue:add', {trackId: track.id, position: 'end'})},
                ] : [],
            }));
        }
        return;
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
    loadPlaylistAndPlay([...favoritesPlaylist],0,{playlistName:'Liked Songs'});
    setPlaylistStatus(`Playing ${favoritesPlaylist.length} liked song(s)`);
}

// --- Core Music & Playlist Logic ---

/**
 * Advances to whatever should follow the track that just finished.
 * Split out of the old inline `onend` callback so the engine's 'ended' event and the
 * next button share one definition of "what comes next".
 */
async function advanceAfterEnd() {
    const endingIndex = currentIndex;
    if (loopMode === 'one') {
        playTrack(currentIndex, {startAtBeginning: true});
        return;
    }

    const nextIndex = currentIndex + 1;
    if (nextIndex < playlist.length) {
        playTrack(nextIndex);
    } else if (loopMode === 'all' && playlist.length > 0) {
        playTrack(0);
    } else if (await window.api.getStoreValue('autoRecommendNext')) {
        const current = playlist[currentIndex];
        const hidden = await window.api.getStoreValue('hiddenRecommendations') || [];
        const rows = await window.api.libraryRecommendations({
            filePath: current,
            artist: currentSongData?.artist,
            album: currentSongData?.album,
            genre: currentSongData?.genre,
            mood: document.getElementById('discovery-mood')?.value || '',
            liked: favoritesPlaylist,
            hidden: [...hidden, ...playlist],
            limit: 1,
        });
        // The user may have started another track while the database was queried.
        if (currentIndex !== endingIndex || playlist[currentIndex] !== current || isPlaying || !rows.length) return;
        playlist.push(rows[0].filePath);
        originalPlaylist.push(rows[0].filePath);
        savePlaybackState();
        publishRoomLibrary();
        playTrack(playlist.length - 1);
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
let playRequest = 0;
async function playTrack(index, options = {}) {
    window.api.setStoreValue('radioPlaying',false);
    const {startPaused = false, seekTime = 0, startAtBeginning = false} = options;
    const request = ++playRequest;

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
    let playbackPath = filePath;
    if (NEEDS_DECODER.test(filePath)) {
        audio.pause();
        showToast('Preparing audio…');
        const prepared = await window.api.mediaPrepare(filePath);
        if (request !== playRequest) return;
        if (!prepared.ok) {
            markPlaylistTrackFailed(filePath,'Cannot decode file');
            showToast(prepared.error);
            if(index+1<playlist.length)playTrack(index+1);
            return;
        }
        playbackPath = prepared.filePath;
        preparedAudio.set(filePath, playbackPath);
    }

    const reopeningCurrent = activePlaybackFilePath === filePath;
    persistTrackPosition();
    let initialSeek = seekTime;
    if (!reopeningCurrent && !startAtBeginning && !seekTime) {
        initialSeek = await window.api.bookPositionGet(filePath);
        if (request !== playRequest) return;
    }
    // Close off the outgoing track's listen before the new one starts.
    beginListen(filePath);

    currentIndex = index;
    currentSound = audio;
    const fallbackName = filePath.split(/[\\/]/).pop();
    // Make transport and progress usable before artwork, tags or lyrics finish.
    currentSongData = {filePath,basename:fallbackName,title:fallbackName,artist:'',cover:null,lyrics:null};
    audio.setReplayGain(0);

    // Kick off streaming immediately. Everything below races against this ticket.
    pendingLoopStart = null;
    const ticket = audio.load(playbackPath, {autoplay: !startPaused, seek: initialSeek,
        resumeFromHistory: true});
    activePlaybackFilePath = filePath;
    rawLyricsText = null;

    // Paint what we can know without parsing anything, so the UI never looks stalled.
    if (filenameEl) filenameEl.textContent = fallbackName;
    titleEl.textContent = fallbackName;
    artistEl.textContent = 'Loading...';
    progressBar.value = initialSeek;
    progressBar.max = 0;
    updateProgressFill(initialSeek, 0);
    document.getElementById('chapter-nav').hidden = true;
    lyricsContainer.innerHTML = '';
    lastActiveLyricIndex = -1;
    renderTransport();

    // Now the slow part, off the critical path.
    const songData = await window.api.getMetadata(filePath);

    // The user may have skipped on while we were parsing. Drop the stale result.
    if (ticket !== audio.ticket) return;

    currentSongData = songData;
    reportPlaybackState();
    window.api.libraryPreferences().then((rows) => {
        if (ticket === audio.ticket) document.getElementById('song-mood').value =
            rows.find((row) => row.filePath === filePath)?.mood || '';
    });
    renderChapterNavigation();
    currentSound = audio;
    savePlaybackState();
    publishRoomLibrary();

    // ReplayGain is per track, so it is applied as each one loads rather than once
    // at startup.
    applyReplayGainFor(songData);
    updateNextTrackHint();

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
    if (isLyricsFullscreen) renderFullscreenLyricsHeader();

    const embedded = processLyrics(songData.lyrics);
    rawLyricsText = songData.lyrics || null;
    lyrics = embedded;
    displayLyrics(embedded, ticket);

    updateLikeButtonUI();
    refreshExclusionState(filePath);
    publishRoomState();
    publishRoomLyrics();
    if (isPlaylistVisible) renderActiveLibraryView();

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

async function loadPlaylistAndPlay(files, startIndex = 0, options = {}) {
    if (!files || files.length === 0) return;
    if (queueMode && !options.forcePlay) {
        enqueueFiles(files);
        return;
    }
    persistTrackPosition();

    // Request #13: honour the per-directory exclusion list. Excluded tracks stay on
    // disk but are dropped from any queue built from that folder.
    const directories = [...new Set(files.map(f => f.replace(/[\\/][^\\/]*$/, '')))];
    const excluded = new Set();
    for (const list of await Promise.all(directories.map(directory=>window.api.getExclusions(directory)))) {
        for (const entry of list) excluded.add(entry);
    }

    let usable = files.filter(f => !excluded.has(f));
    // If the user has excluded literally everything, play the folder rather than
    // silently doing nothing.
    if (usable.length === 0) usable = files;

    originalPlaylist = [...usable];
    currentPlaylistName=options.playlistName||'Queue';
    updateCurrentPlaylistLabel();
    playlist = isShuffled ? shuffleArray(usable) : [...usable];
    publishRoomLibrary();

    if (isPlaylistVisible) renderActiveLibraryView();

    // Shuffling reorders the list, so the requested track has to be found again by
    // path rather than by its position in the original array.
    const wanted = files[startIndex] ?? usable[0];
    const index = Math.max(0, playlist.indexOf(wanted));
    return playTrack(index,options);
}

// --- App Entry Point & Event Listeners ---
document.addEventListener('DOMContentLoaded', () => {
    let uiLoopStarted = false;

    // ---- Engine events -------------------------------------------------------
    // Registered exactly once, rather than being rebuilt as callbacks on every Howl
    // instance. That was the structural reason transport state kept drifting.

    audio.on('statechange', () => { outputWatcher.bindContext(); interruptionWatcher.bindContext(); renderTransport(); });
    audio.on('statechange',()=>{
        if(audio.isPlaying()&&activePlaybackFilePath&&failedPlaylistTracks.has(activePlaybackFilePath)){
            failedPlaylistTracks.delete(activePlaybackFilePath);
            playlistResults.querySelectorAll('[data-file-path]').forEach(row=>{
                if(row.dataset.filePath===activePlaybackFilePath)paintTrackAvailability(row,null);
            });
        }
    });

    audio.on('metadata', ({duration}) => {
        // Duration is known well before the file has finished buffering, so the
        // progress bar becomes usable almost immediately.
        progressBar.max = duration || 0;
        updateProgressFill(audio.seek(), duration);
        renderAbState();
        updateTimeDisplay();

        const songId = getSongIdentifier();
        // Prefer the stored per-track offset; fall back to the legacy settings blob so
        // offsets saved before Phase 9 are not silently forgotten.
        currentLyricsOffset = (songId && lyricsOffsets[songId]) || 0;
        updateOffsetDisplay();
        if (songId) {
            window.api.lyricsGetOffset(songId).then((offsetMs) => {
                if (!offsetMs || songId !== getSongIdentifier()) return;
                currentLyricsOffset = offsetMs / 1000;
                lyricsOffsets[songId] = currentLyricsOffset;
                updateOffsetDisplay();
            }).catch(() => { /* the in-memory value stands */ });
        }
    });

    audio.on('buffered', () => updateProgressFill(audio.seek(), audio.duration()));
    audio.on('time', ({seek}) => {
        const select = document.getElementById('chapter-select');
        if (select && !document.getElementById('chapter-nav').hidden) {
            const index = String(chapterIndexAt(seek));
            if (select.value !== index) select.value = index;
        }
    });
    document.getElementById('chapter-select')?.addEventListener('change', (event) =>
        goToChapter(Number(event.target.value)));
    document.getElementById('chapter-prev')?.addEventListener('click', () => {
        const index = chapterIndexAt(audio.seek());
        goToChapter(audio.seek() > (currentSongData?.chapters?.[index]?.start || 0) + 3 ? index : index - 1);
    });
    document.getElementById('chapter-next')?.addEventListener('click', () =>
        goToChapter(chapterIndexAt(audio.seek()) + 1));

    audio.on('ended', () => {
        if (playlist[currentIndex]) {
            window.api.bookPositionSet(playlist[currentIndex], 0);
        }
        // Reset the lyric view so replay starts visibly from the beginning.
        lastActiveLyricIndex = -1;
        lastActiveWordIndex = -1;
        lyricsContainer.scrollTop = 0;
        lyricsContainer.querySelectorAll('.active, .word-active').forEach((element) => element.classList.remove('active', 'word-active'));
        if (!lyrics.isSynced && lyricsContainer.firstChild) lyricsContainer.firstChild.style.transform = '';
        finishListen({reason: 'end'});
        advanceAfterEnd();
    });

    audio.on('error', ({code, src}) => {
        markPlaylistTrackFailed(activePlaybackFilePath||playlist[currentIndex]);
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
        queueMode = await window.api.getStoreValue('queueMode', false);
        document.getElementById('queue-mode').checked = queueMode;
        lyricsSelectable = await window.api.getStoreValue('lyricsSelectable', false);
        isManualScrollEnabled = !(await window.api.getStoreValue('lyricsAutoScroll', true));
        applyLyricsInteraction();
        // Load settings that affect UI appearance first
        const savedTheme = await window.api.getStoreValue('colorTheme');
        const theme = await window.api.getStoreValue('theme');
        // colorTheme is authoritative; the old light/dark key is the fallback for
        // installs that predate the palettes.
        applyTheme(savedTheme || (theme === 'light' ? DEFAULT_LIGHT_THEME : DEFAULT_DARK_THEME), false);

        const opacity = await window.api.getStoreValue('windowOpacity', 0.85);
        savedWindowOpacity=opacity;
        refreshWindowOpacity();
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

        // Phase 8 output-stage settings must be applied before setRate(), which
        // reads engine.preservePitch. Wrapped for the same reason as the panel
        // initialisers above: audio preferences failing to load must not stop the
        // session, the volume and the last track from being restored.
        try {
            await loadAudioSettings();
            await syncAudioPanelControls();
            await restoreExtraOutputs();
            setLocked(Boolean(await window.api.getStoreValue('isLocked')));
        } catch (error) {
            console.error('[init] Audio settings failed to load:', error);
        }

        const savedRate = await window.api.getStoreValue('playbackRate');
        playbackRate = audio.setRate(typeof savedRate === 'number' ? savedRate : 1.0);
        updateSpeedUI();

        // We no longer set volume here; it's set when a track loads.

        const savedOffsets = await window.api.getStoreValue('lyricsOffsets');
        if (savedOffsets) {
            lyricsOffsets = savedOffsets;
        }

        // Lyric typography has to land before the first line is painted, or the user
        // sees the default size flash over to theirs.
        await loadLyricsConfig();

        // The overlay survives a restart if it was open when the app last closed.
        isLyricsOverlayOpen = await window.api.overlayIsOpen();
        renderOverlayMenuState();
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
        const pauseOnUnplug = await window.api.getStoreValue('pauseOnUnplug',true);
        document.getElementById('discovery-mood').value = await window.api.getStoreValue('discoveryMood') || '';
        if (pauseOnUnplugEl) pauseOnUnplugEl.checked = Boolean(pauseOnUnplug);
        if (pauseOnUnplug) await outputWatcher.start();
        const pauseOnInterruption=await window.api.getStoreValue('pauseOnInterruption',true);
        document.getElementById('pause-on-interruption').checked=Boolean(pauseOnInterruption);
        if(pauseOnInterruption)interruptionWatcher.start();else interruptionWatcher.stop();
        document.getElementById('pause-on-sleep').checked=Boolean(await window.api.getStoreValue('pauseOnSleep',true));
        renderInterruptionStatus(await window.api.audioInterruptionStatus());

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
        if (lastState && Array.isArray(lastState.playlist) && lastState.playlist.length) {
            currentPlaylistName=typeof lastState.playlistName==='string'?lastState.playlistName:'Queue';
            updateCurrentPlaylistLabel();
            originalPlaylist = lastState.playlist;
            playlist = Array.isArray(lastState.queue) ? lastState.queue.filter((entry) => typeof entry === 'string' && entry) : [...originalPlaylist];
            isShuffled = lastState.isShuffled || false;
            shuffleBtn.classList.toggle('active', isShuffled);
            if (isShuffled && !Array.isArray(lastState.queue)) {
                playlist = shuffleArray(playlist);
                shuffleBtn.classList.add('active');
            }

            loopMode = lastState.loopMode || 'none';
            updateLoopButtonUI();

            const lastTrackIndex = Math.max(0, playlist.findIndex(path => path === lastState.lastPlayedPath));
            if (lastTrackIndex !== -1) {
                await playTrack(lastTrackIndex, {startPaused: true, seekTime: lastState.seek});
            }
        }
    }

    // --- Attach All Event Listeners ---

    // Playback Controls
    document.getElementById('current-playlist').addEventListener('click',()=>{
        setLibraryView('queue');
        setActiveTab('playlist');
    });
    playPauseBtn.addEventListener('click', () => {
        if (room.connected && !room.isHost) {
            if (room.role === 'controller') window.api.roomControl('toggle');
            return;
        }
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
        if (room.connected && !room.isHost) {
            if (room.role === 'controller') window.api.roomControl('previous');
            return;
        }
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
        if (room.connected && !room.isHost) {
            if (room.role === 'controller') window.api.roomControl('next');
            return;
        }
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
        if (room.connected && !room.isHost) {
            if (room.role === 'controller') window.api.roomControl('seek', Math.round(value * 1000));
            return;
        }
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
        if (!currentSound && !(room.connected && !room.isHost)) return;
        event.preventDefault();
        event.stopPropagation();
        if (room.connected && !room.isHost && room.role !== 'controller') return;

        // Shift gives fine control, matching the volume scroll modifier.
        const step = event.shiftKey ? 1 : 5;
        const seek = audio.seek() + (event.deltaY < 0 ? step : -step);
        const clamped = Math.max(0, Math.min(audio.duration(), seek));
        if (room.connected && !room.isHost) {
            window.api.roomControl('seek', Math.round(clamped * 1000));
        } else {
            audio.seek(clamped);
        }
        progressBar.value = clamped;
        updateProgressFill(clamped, audio.duration());
        updateTimeDisplay();
    };

    (progressWrapper || progressBar).addEventListener('wheel', seekByWheel, {passive: false});

    // Middle-click anywhere in the padded strip jumps to that position.
    (progressWrapper || progressBar).addEventListener('auxclick', (event) => {
        if (event.button !== 1 || (!currentSound && !(room.connected && !room.isHost))) return;
        event.preventDefault();
        if (room.connected && !room.isHost && room.role !== 'controller') return;
        const rect = progressBar.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        const target = ratio * audio.duration();
        if (room.connected && !room.isHost) {
            window.api.roomControl('seek', Math.round(target * 1000));
        } else {
            audio.seek(target);
        }
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

    volumeBtn.addEventListener('click', (event) => {
        // Ctrl-click is a shortcut to the equalizer, which is otherwise three
        // clicks away in Settings. The volume button is the natural home for it:
        // it is the only always-visible control that is already about level.
        if (event.ctrlKey || event.metaKey) {
            if (eqEnabledEl) {
                eqEnabledEl.checked = !eqEnabledEl.checked;
                eqEnabledEl.dispatchEvent(new Event('change'));
                showToast(eqEnabledEl.checked ? 'Equalizer on' : 'Equalizer off');
            }
            return;
        }

        isMuted = !isMuted;
        audio.setMuted(isMuted);
        updateVolumeUI();
        showVolumeFeedback(isMuted ? 0 : playbackVolume);
    });

    // Keep diagonal travel toward either end of the slider inside an intent
    // triangle. A short grace period also covers jitter at the button boundary.
    if (volumeSlider) {
        const wrapper = volumeSlider.closest('.volume-control-wrapper');
        const popup = wrapper?.querySelector('.volume-slider-popup');
        let closeTimer = null;
        let corridorTimer = null;
        let origin = null;
        let travelling = false;
        const clearClose = () => { clearTimeout(closeTimer); closeTimer = null; };
        const close = () => {
            clearClose(); clearTimeout(corridorTimer);
            travelling = false; origin = null;
            wrapper?.classList.remove('pointer-open');
        };
        const deferClose = () => {
            if (!closeTimer) closeTimer = setTimeout(close, 220);
        };
        const enter = event => {
            clearClose(); clearTimeout(corridorTimer);
            travelling = false;
            origin = {x: event.clientX, y: event.clientY};
            wrapper?.classList.add('pointer-open');
        };
        const inTriangle = (point, a, b, c) => {
            const cross = (p, q, r) => (p.x-r.x)*(q.y-r.y)-(q.x-r.x)*(p.y-r.y);
            const d1 = cross(point,a,b), d2 = cross(point,b,c), d3 = cross(point,c,a);
            return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
        };
        wrapper?.addEventListener('pointerenter', enter);
        wrapper?.addEventListener('pointermove', event => {
            origin = {x: event.clientX, y: event.clientY};
        });
        wrapper?.addEventListener('pointerleave', () => {
            travelling = true;
            deferClose();
            // Bound the grace period even if the pointer stops in the gap.
            corridorTimer = setTimeout(close, 900);
        });
        document.addEventListener('pointermove', event => {
            if (!travelling || !origin || !popup) return;
            if (wrapper.contains(event.target)) { enter(event); return; }
            const rect = popup.getBoundingClientRect();
            const edgeY = rect.bottom <= origin.y ? rect.bottom - 2 : rect.top + 2;
            if (inTriangle({x:event.clientX,y:event.clientY}, origin,
                {x:rect.left-10,y:edgeY}, {x:rect.right+10,y:edgeY})) {
                clearClose();
            } else deferClose();
        });
        window.addEventListener('blur', close);
        volumeSlider.addEventListener('pointerdown', () => {
            clearClose(); clearTimeout(corridorTimer);
            travelling = false;
            wrapper?.classList.add('dragging');
        });
        const release = () => {
            wrapper?.classList.remove('dragging');
            if (!wrapper?.matches(':hover')) close();
        };
        window.addEventListener('pointerup', release);
        window.addEventListener('pointercancel', release);
    }

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
    document.getElementById('edge-dock-btn')?.addEventListener('click', () => window.api.edgeDockToggle());

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
        window.api.setStoreValue('lyricsAutoScroll', !isManualScrollEnabled);
        lastActiveLyricIndex = -1;
        applyLyricsInteraction();
    });
    document.getElementById('toggle-lyrics-selection-btn').addEventListener('click', () => {
        lyricsSelectable = !lyricsSelectable;
        window.api.setStoreValue('lyricsSelectable', lyricsSelectable);
        applyLyricsInteraction();
    });
    document.getElementById('export-lyrics-btn').addEventListener('click', async () => {
        if (!rawLyricsText || !currentSongData) return showToast('No lyrics available to export');
        const result = await window.api.exportLyrics({text: rawLyricsText,
            title: currentSongData.title || currentSongData.basename, synced: lyrics.isSynced});
        if (result.error) showToast(result.error);
        else if (result.ok) showToast('Lyrics exported');
    });
    document.getElementById('queue-mode').addEventListener('change', event => {
        queueMode = event.target.checked;
        window.api.setStoreValue('queueMode', queueMode);
    });
    for (const [id, enabled] of [['install-file-menu', true], ['remove-file-menu', false]]) {
        document.getElementById(id).addEventListener('click', async event => {
            event.currentTarget.disabled = true;
            try {
                const result = await window.api.configureFileMenu(enabled);
                showToast(result.error || (enabled ? 'File menu installed. Restart your file manager if needed.' : 'File menu removed'));
            } finally { document.getElementById(id).disabled = false; }
        });
    }

    lyricsOverlayBtn?.addEventListener('click', () => {
        closeAllMenus();
        toggleLyricsOverlay();
    });

    // The strip can be closed from its own button, and the menu label would otherwise
    // still offer to hide something that is already gone.
    window.api.onOverlayClosed?.(() => {
        isLyricsOverlayOpen = false;
        lastOverlayLine = null;
        renderOverlayMenuState();
    });

    // A window that has just opened has missed every push so far.
    window.api.onOverlayRequestState?.(() => {
        window.api.overlayStyle(lyricsConfig?.typography || {});
        pushOverlayLine(lastActiveLyricIndex, true);
    });

    editLyricsBtn?.addEventListener('click', () => {
        closeAllMenus();
        openLyricsEditor();
    });
    lyricsEditorCloseBtn?.addEventListener('click', () => closeLyricsEditor());
    lyricsEditorModeTextBtn?.addEventListener('click', () => setEditorMode('text'));
    lyricsEditorModeSyncBtn?.addEventListener('click', () => setEditorMode('sync'));
    lyricsEditorTapBtn?.addEventListener('click', () => tapSyncCurrentLine());
    lyricsEditorUndoBtn?.addEventListener('click', () => undoLastTap());
    lyricsEditorPlayBtn?.addEventListener('click', () => playPauseBtn.click());
    lyricsEditorBackBtn?.addEventListener('click', () => {
        audio.seek(Math.max(0, (audio.seek() || 0) - 3));
    });
    lyricsEditorRestartBtn?.addEventListener('click', () => {
        editorLines.forEach((line) => { line.time = null; });
        editorCursor = 0;
        renderEditorLines();
        setEditorStatus('Timestamps cleared.');
    });
    lyricsEditorSaveBtn?.addEventListener('click', () => saveLyricsFromEditor());

    fullscreenLyricsBtn?.addEventListener('click', () => {
        closeAllMenus();
        setLyricsFullscreen(true);
    });
    lyricsFullscreenCloseBtn?.addEventListener('click', () => setLyricsFullscreen(false));

    // Double-clicking the lyrics is the gesture people try first, in both directions.
    lyricsContainer?.addEventListener('dblclick', () => {
        if (!lyricsSelectable) setLyricsFullscreen(!isLyricsFullscreen);
    });

    // The OS can drop us out of full-screen on its own (the macOS green button, F11).
    // Trusting our own flag alone left the overlay covering a restored dock window.
    window.api.onFullscreenChanged?.((enabled) => {
        if (!enabled && isLyricsFullscreen) {
            if (lyricsHomeParent) {
                lyricsHomeParent.insertBefore(lyricsContainer, lyricsHomeNextSibling);
            }
            lyricsFullscreenEl?.classList.add('hidden');
            document.body.classList.remove('lyrics-fullscreen-open');
            isLyricsFullscreen = false;
            lastActiveLyricIndex = -1;
            lastActiveWordIndex = -1;
        }
    });

    refetchLyricsBtn.addEventListener('click', () => {
        if (!currentSongData) {
            // Can't refetch if no song is loaded
            return;
        }
        // Call with 'true' to force a refetch, skipping the local cache
        searchAndDisplayOnlineLyrics(currentSongData, true);
    });

    // Wire menu definitions to native desktop popups (DOM fallback without bridge).
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
        savedWindowOpacity=opacityValue;
        window.api.previewOpacity(opacityValue);
        transparencyValue.textContent = `${Math.round(opacityValue * 100)}%`;
        containerEl.classList.toggle('is-opaque', opacityValue >= 1.0);
    });
    document.documentElement.addEventListener('pointerenter',()=>{opacityHovered=true;refreshWindowOpacity();});
    document.documentElement.addEventListener('pointerleave',()=>{opacityHovered=false;refreshWindowOpacity();});
    transparencySlider.addEventListener('pointerdown',()=>{opacityDragging=true;refreshWindowOpacity();});
    const commitOpacity=()=>{
        opacityDragging=false;
        window.api.setOpacity(savedWindowOpacity);
        refreshWindowOpacity();
    };
    transparencySlider.addEventListener('change',commitOpacity);
    window.addEventListener('pointerup',()=>{if(opacityDragging)commitOpacity();});
    window.addEventListener('pointercancel',()=>{if(opacityDragging)commitOpacity();});
    window.addEventListener('blur',()=>{opacityHovered=false;if(opacityDragging)commitOpacity();else refreshWindowOpacity();});

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
        saveLyricsOffsets();
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
        // What comes next just changed, so what should be buffered has too.
        updateNextTrackHint();
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

    // Each panel is initialised independently.
    //
    // These used to be four bare calls in a row, so if any one of them threw --
    // a missing element, a renamed id, a half-applied update -- the rest of the
    // DOMContentLoaded body never ran. That is what turned one ReferenceError
    // into a dead progress bar, an artist stuck on "Loading...", lyrics that
    // never scrolled and no restored session: a single failure took the whole
    // startup path with it. A failure in one panel is now contained to that
    // panel, and says so in the console.
    for (const [name, init] of [
        ['equalizer', buildEqualizerUI],
        ['tag editor', initTagEditor],
        ['library', initLibraryPanel],
        ['named playlists', initNamedPlaylists],
        ['remote audio', initRemoteAudio],
        ['audio', initAudioPanel],
        ['audio tools', initMediaTools],
        ['shortcuts', initShortcutsPanel],
    ]) {
        try {
            init();
        } catch (error) {
            console.error(`[init] The ${name} panel failed to start:`, error);
        }
    }

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

    // --- Lyric typography & sources (Phase 9) ---
    // `input` rather than `change` on the sliders: the point of a live preview is that
    // it is live. The write behind it is debounced in updateLyricsTypography.
    lyricsFontSizeEl?.addEventListener('input', () => {
        const fontSize = Number(lyricsFontSizeEl.value);
        if (lyricsFontSizeValueEl) lyricsFontSizeValueEl.textContent = `${fontSize}px`;
        updateLyricsTypography({fontSize});
    });
    lyricsLineHeightEl?.addEventListener('input', () => {
        const lineHeight = Number(lyricsLineHeightEl.value);
        if (lyricsLineHeightValueEl) lyricsLineHeightValueEl.textContent = String(lineHeight);
        updateLyricsTypography({lineHeight});
    });
    lyricsFontWeightEl?.addEventListener('change', () => {
        updateLyricsTypography({fontWeight: Number(lyricsFontWeightEl.value)});
    });
    lyricsAlignEl?.addEventListener('change', () => {
        updateLyricsTypography({align: lyricsAlignEl.value});
    });
    lyricsFontFamilyEl?.addEventListener('change', () => {
        updateLyricsTypography({fontFamily: lyricsFontFamilyEl.value.trim()});
    });
    lyricsGeniusTokenEl?.addEventListener('change', async () => {
        lyricsConfig = await window.api.lyricsSetConfig({
            geniusToken: lyricsGeniusTokenEl.value.trim(),
        });
    });
    lyricsAutosaveEl?.addEventListener('change', async () => {
        lyricsConfig = await window.api.lyricsSetConfig({autoSaveLrc: lyricsAutosaveEl.checked});
    });

    // Pause on headphone removal (#3).
    if (pauseOnUnplugEl) {
        pauseOnUnplugEl.addEventListener('change', async () => {
            window.api.setStoreValue('pauseOnUnplug', pauseOnUnplugEl.checked);
            if (pauseOnUnplugEl.checked) await outputWatcher.start(); else outputWatcher.stop();
        });
    }
    for(const [id,key] of [['pause-on-interruption','pauseOnInterruption'],['pause-on-sleep','pauseOnSleep']]){
        document.getElementById(id).addEventListener('change',async event=>{
            const enabled=event.target.checked;
            window.api.setStoreValue(key,enabled);
            if(key==='pauseOnInterruption'){
                if(enabled)interruptionWatcher.start();else interruptionWatcher.stop();
            }
            renderInterruptionStatus(await window.api.audioInterruptionStatus());
        });
    }
    const autoRecommend = document.getElementById('auto-recommend-next');
    document.getElementById('song-mood')?.addEventListener('change', (event) => {
        if (playlist[currentIndex]) window.api.libraryPreferenceSet(playlist[currentIndex], {mood: event.target.value});
    });
    document.getElementById('discovery-mood')?.addEventListener('change', (event) => {
        window.api.setStoreValue('discoveryMood', event.target.value);
        if (isPlaylistVisible) renderActiveLibraryView();
    });
    document.getElementById('discovery-reset')?.addEventListener('click', async () => {
        await window.api.libraryPreferencesReset();
        document.getElementById('song-mood').value = '';
        if (isPlaylistVisible) renderActiveLibraryView();
        showToast('Discovery feedback reset.');
    });
    if (autoRecommend) {
        window.api.getStoreValue('autoRecommendNext').then((value) => {
            autoRecommend.checked = Boolean(value);
        });
        autoRecommend.addEventListener('change', () =>
            window.api.setStoreValue('autoRecommendNext', autoRecommend.checked));
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
                serverUrl: roomServerEl.value.trim(), members: [],
                password: roomPasswordEl.value, role: result.room.role,
                remoteLibrary: {tracks: [], queue: []}};
        renderRoomUI();
    });

    document.getElementById('room-upload-song')?.addEventListener('click', async () => {
        const button = document.getElementById('room-upload-song');
        button.disabled = true;
        try {
            const result = await window.api.roomUploadSong(document.getElementById('room-upload-position').value);
            if (!result.ok && !result.cancelled) setPlaylistStatus(`Upload failed: ${result.error}`);
            else if (result.ok) setPlaylistStatus('Song uploaded; host is adding it to the queue');
        } finally { button.disabled = false; }
    });

    document.getElementById('room-telegram-pair')?.addEventListener('click', async () => {
        const result = await window.api.roomTelegramPair();
        document.getElementById('room-telegram-code').textContent = result.ok
            ? `Send /pair ${result.code} to @${result.botUsername} within 10 minutes`
            : `Telegram unavailable: ${result.error}`;
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
        room.remoteLibrary = library;
        if (librarySearchInput?.value.trim()) runLibrarySearch(librarySearchInput.value);
        else renderRemoteQueue();
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
    window.api.onRoomEvent('room:incoming-track', ({filePath, position}) => {
        if (room.isHost) enqueue(filePath, position);
    });
    window.api.onRoomEvent('room:upload-accepted', () =>
        setPlaylistStatus('The host added your song to the queue'));

    window.api.onRoomEvent('room:welcome', (message) => {
        room.connected = true;
        room.code = message.room?.code || room.code;
        room.serverUrl = message.serverUrl || room.serverUrl;
        room.members = message.members || room.members;
        if (message.role) room.isHost = message.role === 'host';
        room.role = message.role || room.role;
        if (message.library) room.remoteLibrary = message.library;
        renderRoomUI();
        renderLibraryViewChips();
        renderActiveLibraryView();
        if (room.isHost) {
            publishRoomLibrary(); publishRoomState(); publishRoomSettings(); publishRoomLyrics();
        } else if (message.state) applyRemoteState(message.state);
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
            ? 'Disable Close to Tray'
            : 'Enable Close to Tray';
        minimizeTrayBtn?.classList.toggle('active', minimizeToTray);
        minimizeTrayBtn?.setAttribute('aria-pressed', String(minimizeToTray));
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
            saveLyricsOffsets();
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
            searchDebounce = setTimeout(() => room.connected && !room.isHost
                ? runLibrarySearch(librarySearchInput.value) : renderActiveLibraryView(), 180);
        });

        librarySearchInput.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                librarySearchInput.value = '';
                renderActiveLibraryView();
                togglePlaylistPanel(false);
            }
        });
    }

    for (const id of ['playlist-filter','playlist-sort']) {
        document.getElementById(id).addEventListener('change', () => {
            playlistResults.scrollTop = 0;
            renderActiveLibraryView();
        });
    }

    window.api.onScanProgress(({found}) => {
        if (isPlaylistVisible) setPlaylistStatus(`Scanning... ${found} files found`);
    });

    window.api.onScanTruncated(({count}) => {
        setPlaylistStatus(`Stopped at ${count} files — that folder is very large.`);
    });

    window.api.onLibraryUpdated(({trackCount}) => {
        if (isPlaylistVisible && activeLibraryView === 'all') { renderActiveLibraryView(); return; }
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
        document.documentElement.dataset.appReady = 'true';
    });

    // Fired when the app is launched by opening a file.
    let launchChain = Promise.resolve();
    window.api.onLaunchFiles(launch => {
        launchChain = launchChain.then(async () => {
        const ready=document.documentElement.dataset.appReady==='true';
        if(!ready) {
            await loadAppSettings();
            if (launch.enqueue || queueMode) await restoreLastPlaybackState();
        }
        if(launch.enqueue || queueMode) {
            enqueueFiles(launch.files);
        }else await loadPlaylistAndPlay(launch.files);
        startUiLoopOnce();document.documentElement.dataset.appReady='true';
        }).catch(error => { console.error(error); showToast('Could not open files'); });
    });
    window.api.onFilePathReceived(async (filePath) => {
        await loadAppSettings(); // Still need to load theme, volume, etc.
        loadPlaylistAndPlay([filePath]); // But play the new file.
        startUiLoopOnce();
        document.documentElement.dataset.appReady = 'true';
    });

    // --- Global Volume Scroll ---
    // Wheel-to-change-volume, scoped to two targets: the album art and the volume
    // button.
    //
    // This used to be an *exclusion* list on the whole window, which meant the
    // wheel changed the volume anywhere the list had not thought of -- including
    // the Library, Tags and Settings panels, where it made them impossible to
    // scroll. An allow-list cannot rot the same way: a new panel is scrollable by
    // default rather than by remembering to exempt it.
    const VOLUME_WHEEL_TARGETS = '#album-art-wrapper, .volume-control-wrapper';

    containerEl.addEventListener('wheel', (event) => {
        if (!event.target.closest(VOLUME_WHEEL_TARGETS)) return;

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

// Closes dropdowns on any click except the ones that should not dismiss.
//
// The previous version exempted the whole menu so that the version readout would
// not shut it -- but that also meant picking an item left the menu hanging open,
// which is wrong for every menu anywhere. Only the genuinely non-actionable rows
// are exempt now; choosing an item closes the menu, as it should.
window.addEventListener('click', (event) => {
    const insideMenu = event.target.closest?.('.dropdown-menu');
    if (insideMenu) {
        const inert = event.target.closest('.version-display, .menu-label');
        if (inert) return;
    }
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
    if (isLocked) { event.preventDefault(); return; }
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
    // The editor owns the keyboard while it is open: Space taps rather than
    // toggling playback, and the transport shortcuts would fight the sync flow.
    if (isLyricsEditorOpen) {
        if (event.key === 'Escape') {
            closeLyricsEditor();
            event.preventDefault();
            return;
        }
        if (event.target.tagName === 'TEXTAREA' || event.target.tagName === 'INPUT') return;
        if (editorMode !== 'sync') return;

        if (event.code === 'Space' || event.code === 'Enter' || event.code === 'NumpadEnter') {
            tapSyncCurrentLine();
            event.preventDefault();
        } else if (event.code === 'Backspace') {
            undoLastTap();
            event.preventDefault();
        } else if (event.code === 'KeyP') {
            playPauseBtn.click();
            event.preventDefault();
        } else if (event.code === 'ArrowLeft') {
            audio.seek(Math.max(0, (audio.seek() || 0) - 3));
            event.preventDefault();
        }
        return;
    }

    if (event.key === 'Escape') {
        // Full screen is the outermost layer, so it backs out first.
        if (isLyricsFullscreen) {
            setLyricsFullscreen(false);
            event.preventDefault();
            return;
        }
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

    // Ctrl+L locks and unlocks. Deliberately before the INPUT guard and before the
    // lock check itself, since it has to remain the one working control.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
        setLocked(!isLocked);
        event.preventDefault();
        return;
    }

    // While locked, every other shortcut is ignored too -- a lock that only
    // blocked the mouse would not be a lock.
    if (isLocked) return;

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
        } else if (event.code === 'KeyF') {
            setLyricsFullscreen(!isLyricsFullscreen);
            handled = true;
        } else if (event.code === 'KeyE') {
            openLyricsEditor();
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
window.addEventListener('beforeunload', () => {
    savePlaybackState();
    // Quitting mid-track still counts, if enough of it was heard.
    finishListen({reason: 'quit'});
});

// API Listeners from Main Process
function handleMediaCommand(command) {
    if(command==='pause'||command==='stop'){
        pauseForInterruption('media-pause');
        return;
    }
    if (isLocked) return;
    const actions = {
        'play-pause': () => playPauseBtn.click(),
        'next': () => nextBtn.click(),
        'prev': () => prevBtn.click()
    };
    actions[command]?.();
}
window.api.onMediaKey(handleMediaCommand);

// Chromium exposes these actions to the operating system's media controls,
// including MPRIS on Linux desktops that provide a media controller.
if ('mediaSession' in navigator) {
    const actions = {
        play: () => { if (!isPlaying) handleMediaCommand('play-pause'); },
        pause: () => handleMediaCommand('pause'),
        stop: () => handleMediaCommand('stop'),
        previoustrack: () => handleMediaCommand('prev'),
        nexttrack: () => handleMediaCommand('next'),
    };
    for (const [action, handler] of Object.entries(actions)) {
        try { navigator.mediaSession.setActionHandler(action, handler); }
        catch (error) { console.warn(`System media action ${action} unavailable:`, error); }
    }
}

function updateSystemMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
        navigator.mediaSession.playbackState = currentSongData ? (isPlaying ? 'playing' : 'paused') : 'none';
        navigator.mediaSession.metadata = currentSongData ? new MediaMetadata({
            title: currentSongData.title || 'Unknown Title',
            artist: currentSongData.artist || '',
            album: currentSongData.album || '',
            artwork: currentSongData.cover ? [{src: currentSongData.cover}] : [],
        }) : null;
    } catch (error) { console.warn('Could not update system media metadata:', error); }
}

window.api.onSetOrientationClass((isVertical) => {
    containerEl.classList.toggle('vertical-mode', isVertical);
});

// The narrow strip shares the player's transport; it has no second audio engine.
let edgeHoverTimer = null;
let edgeDragging = false;
let refreshEdgeTitle = () => {};
function applyEdgeDockState(state) {
    containerEl.classList.toggle('edge-docked', Boolean(state.active));
    containerEl.classList.toggle('collapsed', Boolean(state.active && !state.expanded));
    containerEl.classList.toggle('expanded', Boolean(state.active && state.expanded));
    if (state.active) containerEl.classList.add('vertical-mode');
    if (!state.active) clearTimeout(edgeHoverTimer);
}

window.api.onEdgeDockChanged((state) => {
    applyEdgeDockState(state);
    requestAnimationFrame(refreshEdgeTitle);
});
document.addEventListener('DOMContentLoaded', async () => {
    const strip = document.getElementById('edge-strip');
    const handle = document.getElementById('edge-handle');
    const edgeTitle = document.getElementById('edge-title');
    const viewport = document.getElementById('edge-title-viewport');
    const updateTitle = () => {
        edgeTitle.textContent = titleEl.textContent || 'No song loaded';
        const overflow = Math.max(0, edgeTitle.scrollHeight - viewport.clientHeight);
        edgeTitle.style.setProperty('--edge-scroll-distance', `${-overflow}px`);
        edgeTitle.classList.toggle('scrolling', overflow > 4);
    };
    refreshEdgeTitle = updateTitle;
    new MutationObserver(updateTitle).observe(titleEl, {childList: true, characterData: true, subtree: true});
    updateTitle();
    applyEdgeDockState(await window.api.edgeDockStatus());
    requestAnimationFrame(updateTitle);
    strip?.addEventListener('mouseenter', () => {
        if (edgeDragging) return;
        clearTimeout(edgeHoverTimer);
        edgeHoverTimer = setTimeout(() => window.api.edgeDockExpand(true), 300);
    });
    containerEl.addEventListener('mouseleave', () => {
        clearTimeout(edgeHoverTimer);
        if (containerEl.classList.contains('edge-docked')) window.api.edgeDockExpand(false);
    });
    handle?.addEventListener('pointerdown', () => {
        edgeDragging = true;
        clearTimeout(edgeHoverTimer);
    });
    window.addEventListener('pointerup', () => { edgeDragging = false; });
    document.getElementById('edge-exit')?.addEventListener('click', () => window.api.edgeDockToggle());
    document.getElementById('edge-prev')?.addEventListener('click', () => prevBtn.click());
    document.getElementById('edge-play')?.addEventListener('click', () => playPauseBtn.click());
    document.getElementById('edge-next')?.addEventListener('click', () => nextBtn.click());
    document.getElementById('edge-lock')?.addEventListener('click', () => setLocked(!isLocked));
});

// Feature modules share the established player state and room permissions.
document.addEventListener('DOMContentLoaded',()=>{
    window.roadmapTools = window.RhythmRoadmap.install({engine:audio,equalizer,
        track:()=>currentSongData,isLocked:()=>isLocked,canControl:()=>!room.connected||room.isHost,
        tab:setActiveTab,editTags:openTagsEditor,playPaths:loadPlaylistAndPlay,enqueue:path=>enqueue(path,QUEUE_POSITIONS.END),
        playStream:(url,title)=>{
            if(room.connected)throw new Error('Leave the shared room before starting a radio stream.');
            finishListen({reason:'switch'});playlist=[];originalPlaylist=[];currentIndex=-1;
            currentSongData={filePath:url,title,basename:title,artist:'Internet radio',isStream:true};currentSound=audio;
            window.api.setStoreValue('radioPlaying',true);
            lyrics={isSynced:false,lines:[]};displayLyrics(lyrics);titleEl.textContent=title;artistEl.textContent='Internet radio';filenameEl.textContent=title;
            document.getElementById('chapter-nav').hidden=true;
            audio.load(url,{autoplay:true});savePlaybackState();renderTransport();
        },
        lyric:()=>lyricLineText(lastActiveLyricIndex),exitLyricsFullscreen:()=>isLyricsFullscreen?setLyricsFullscreen(false):Promise.resolve(),
        transport:command=>document.getElementById({'prev':'prev-btn','next':'next-btn','play-pause':'play-pause-btn'}[command])?.click()});
});
window.api.onFileMoved(({oldPath,newPath})=>{
    playlist=playlist.map(p=>p===oldPath?newPath:p);originalPlaylist=originalPlaylist.map(p=>p===oldPath?newPath:p);
    favoritesPlaylist=favoritesPlaylist.map(p=>p===oldPath?newPath:p);
    window.api.setStoreValue('favoritesPlaylist',favoritesPlaylist);
    if(currentSongData?.filePath===oldPath)currentSongData.filePath=newPath;
    savePlaybackState();if(activeTab==='playlist')renderQueue();
});
