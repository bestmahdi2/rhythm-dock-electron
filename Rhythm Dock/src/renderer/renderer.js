// --- State Variables ---
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
let lastActiveLyricIndex = -1;
let lyricsOffsets = {};
let loadTicket = 0;
let currentLyricsOffset = 0;
let playbackVolume = 1.0;
let areLyricsVisible = true;
let areLyricsControlsVisible = true;
let isManualScrollEnabled = false;

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
const volumeContainer = document.querySelector('.volume-container');
const lyricsControls = document.querySelector('.lyrics-controls');

const audioEngine = {
    sound: null,
    gainNode: null,

    // Initializes the audio components
    init: function () {
        // Access Howler's global AudioContext. Howler initializes this on the first play.
        if (Howler.ctx && !this.gainNode) {
            // Create a GainNode.
            this.gainNode = Howler.ctx.createGain();

            // --- THE FIX ---
            // Disconnect Howler's master gain from the final destination.
            // This prevents the original audio path from playing simultaneously.
            Howler.masterGain.disconnect();

            // Now, connect our new, single audio path.
            // Path: Howler's Output -> Our Gain Node -> Speakers
            Howler.masterGain.connect(this.gainNode);
            this.gainNode.connect(Howler.ctx.destination);
        }
    },

    // Creates a new Howl instance and connects it
    loadSound: function (filePath, options) {
        // Unload any existing sound
        if (this.sound) {
            this.sound.unload();
        }

        // Create the new sound
        this.sound = new Howl({
            src: [filePath],
            ...options // Spread any other options like onend, onload, etc.
        });

        // Ensure the audio engine is initialized AFTER a Howl instance exists
        this.init();

        return this.sound;
    },

    // Sets the volume using the GainNode
    setVolume: function (level) {
        if (this.gainNode) {
            // The gainNode's 'gain.value' is what we control for volume.
            // This value is not clamped at 1.0.
            this.gainNode.gain.value = level;
        }
    }
};

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

function formatTime(secs) {
    const minutes = Math.floor(secs / 60) || 0;
    const seconds = Math.floor(secs - minutes * 60) || 0;
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

function displayLyrics(data) {
    if (!lyricsContainer) return;
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
    window.api.sendPlaybackState({isPlaying});
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
    const seek = currentSound.seek() || 0;
    const duration = currentSound.duration() || 0;
    timeCurrentEl.textContent = formatTime(seek);
    timeRemainingEl.textContent = timeDisplayMode === 'remaining' ? `-${formatTime(duration - seek)}` : formatTime(duration);
}

function getSongIdentifier() {
    if (!currentSongData || !currentSound) return null;
    const duration = Math.round(currentSound.duration());
    return `${currentSongData.artist} - ${currentSongData.title} - ${duration}`;
}

function updateOffsetDisplay() {
    if (!lyricsOffsetDisplay) return;
    lyricsOffsetDisplay.textContent = `${currentLyricsOffset >= 0 ? '' : ''}${currentLyricsOffset.toFixed(1)}s`;
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
    if (currentSound && isPlaying) {
        const seek = currentSound.seek() || 0;
        const duration = currentSound.duration() || 0;
        progressBar.value = seek;
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
                        lineElements[currentLyricIndex].classList.add('active');
                        const activeLineEl = lineElements[currentLyricIndex];
                        const containerHeight = lyricsContainer.clientHeight;
                        lyricsContainer.scrollTop = activeLineEl.offsetTop - (containerHeight / 2) + (activeLineEl.offsetHeight / 2);
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
    const state = {
        playlist: originalPlaylist,
        lastPlayedPath: playlist[currentIndex],
        seek: currentSound.seek() || 0,
        isShuffled: isShuffled,
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

async function searchAndDisplayOnlineLyrics(songData, forceRefetch = false) {
    if (!lyricsContainer) return;
    const noLyricsEl = lyricsContainer.querySelector('.lyrics-line');
    if (noLyricsEl) noLyricsEl.textContent = 'Searching for lyrics...';

    try {
        const songId = getSongIdentifier();
        if (!songId) {
            throw new Error("Cannot generate a song identifier to use the database.");
        }

        const cachedLyrics = forceRefetch ? null : await window.api.getLyrics(songId);

        if (cachedLyrics) {
            lyrics = processLyrics(cachedLyrics);
        } else {
            const {artist: cleanArtist, title: cleanTitle} = sanitizeForApiSearch(songData.artist, songData.title);
            const onlineLyricsText = await fetchLyrics(cleanArtist, cleanTitle);
            if (onlineLyricsText) {
                window.api.saveLyrics(songId, onlineLyricsText); // Save to DB
                lyrics = processLyrics(onlineLyricsText);
            } else {
                lyrics = {isSynced: false, lines: []};
            }
        }
    } catch (error) {
        console.error('An error occurred during lyric search:', error);
        lyrics = {isSynced: false, lines: ['Error finding lyrics.']};
    } finally {
        displayLyrics(lyrics);
    }
}

// --- Core Music & Playlist Logic ---
async function playTrack(index, options = {}) {
    loadTicket++;
    const thisTicket = loadTicket;

    const {startPaused = false, seekTime = 0} = options;

    if (index < 0 || index >= playlist.length) {
        if (currentSound) currentSound.stop();
        isPlaying = false;
        updatePlayPauseIcon();
        reportPlaybackState();
        return;
    }

    // --- FIX: VALIDATE THE FILE PATH ---
    // Get the file path from the playlist.
    const filePath = playlist[index];

    // Check if the file path is a valid, non-empty string before proceeding.
    // This prevents errors if the saved playlist state contains null or undefined entries.
    if (typeof filePath !== 'string' || !filePath) {
        console.error(`Invalid playlist entry at index ${index}. Value:`, filePath, 'Skipping track.');
        // Attempt to recover by playing the next track automatically.
        const nextIndex = index + 1;
        if (nextIndex < playlist.length) {
            playTrack(nextIndex);
        }
        return; // Stop execution of this function call.
    }
    // --- END OF FIX ---

    currentIndex = index;
    // We now use the validated 'filePath' variable.
    const songData = await window.api.getMetadata(filePath);
    currentSongData = songData;

    if (filenameEl) filenameEl.textContent = songData.basename;
    titleEl.textContent = songData.title;
    artistEl.textContent = songData.artist;
    albumArtEl.src = songData.cover || '../assets/images/placeholder.png';
    progressBar.max = 0;
    progressBar.value = seekTime;

    let lyricsData = processLyrics(songData.lyrics);
    displayLyrics(lyricsData);
    lyrics = lyricsData;

    currentSound = audioEngine.loadSound(songData.filePath, {
        onload: () => {
            if (thisTicket !== loadTicket) return;
            progressBar.max = currentSound.duration();
            if (seekTime > 0) currentSound.seek(seekTime);

            const songId = getSongIdentifier();
            currentLyricsOffset = lyricsOffsets[songId] || 0;
            updateOffsetDisplay();

            audioEngine.setVolume(isMuted ? 0 : playbackVolume);
        },
        onloaderror: (soundId, error) => {
            if (thisTicket !== loadTicket) return;
            console.error(`Howler failed to load sound: ${songData.filePath}`, error);
            titleEl.textContent = 'Error: Unplayable file';
            artistEl.textContent = songData.basename;
            if (currentSound) {
                currentSound.unload();
                currentSound = null;
            }
            nextBtn.click();
        },
        onplay: () => {
            if (thisTicket !== loadTicket) return;
            isPlaying = true;
            updatePlayPauseIcon();
            reportPlaybackState();
        },
        onpause: () => {
            if (thisTicket !== loadTicket) return;
            isPlaying = false;
            updatePlayPauseIcon();
            reportPlaybackState();
        },
        onend: () => {
            if (thisTicket !== loadTicket) return;
            if (loopMode === 'one') {
                playTrack(currentIndex);
                return;
            }
            let nextIndex = currentIndex + 1;
            if (loopMode === 'all' && nextIndex >= playlist.length) {
                nextIndex = 0;
            }
            playTrack(nextIndex);
        }
    });

    if (!startPaused) {
        currentSound.play();
    } else {
        isPlaying = false;
        updatePlayPauseIcon();
        reportPlaybackState();
    }
    if (!lyricsData.isSynced) {
        searchAndDisplayOnlineLyrics(songData);
    }
}

function loadPlaylistAndPlay(files) {
    if (files && files.length > 0) {
        originalPlaylist = [...files];
        playlist = [...files];
        if (isShuffled) {
            playlist = shuffleArray(playlist);
        }
        playTrack(0);
    }
}

// --- App Entry Point & Event Listeners ---
document.addEventListener('DOMContentLoaded', () => {

    // --- Consolidated Initialization Function ---
    async function initialize() {
        // Load settings that affect UI appearance first
        const theme = await window.api.getStoreValue('theme');
        if (theme === 'light') {
            containerEl.classList.add('light-mode');
        }

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

        // We no longer set volume here; it's set when a track loads.

        const savedOffsets = await window.api.getStoreValue('lyricsOffsets');
        if (savedOffsets) {
            lyricsOffsets = savedOffsets;
        }

        const isPinned = await window.api.getStoreValue('isPinned');
        pinBtn.classList.toggle('pinned', isPinned !== false);

        updateVolumeUI();

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
            const lastTrackIndex = playlist.findIndex(path => path === lastState.lastPlayedPath);
            if (lastTrackIndex !== -1) {
                await playTrack(lastTrackIndex, {startPaused: true, seekTime: lastState.seek});
            }
        }

        // Finally, update menus to reflect all loaded states
        updateAppSettingsMenu();
        updateLyricsDropdownMenu();
    }

    // --- Attach All Event Listeners ---

    // Playback Controls
    playPauseBtn.addEventListener('click', () => {
        if (currentSound) {
            if (isPlaying) {
                currentSound.pause();
            } else {
                if (currentSound.seek() >= currentSound.duration() - 0.1) {
                    playTrack(currentIndex);
                } else {
                    currentSound.play();
                }
            }
        } else if (playlist.length > 0) {
            playTrack(0);
        }
    });

    prevBtn.addEventListener('click', () => {
        if (!currentSound) return;
        if (currentSound.seek() > 3) {
            currentSound.seek(0);
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
    progressBar.addEventListener('input', () => {
        if (currentSound) currentSound.seek(progressBar.value);
    });

    progressBar.addEventListener('wheel', (event) => {
        if (!currentSound) return;
        event.preventDefault();
        const seekTime = 5;
        let seek = currentSound.seek() + (event.deltaY < 0 ? seekTime : -seekTime);
        seek = Math.max(0, Math.min(currentSound.duration(), seek));
        currentSound.seek(seek);
        progressBar.value = seek;
    });

    volumeSlider.addEventListener('input', (e) => {
        const newVolume = parseFloat(e.target.value);
        playbackVolume = newVolume;
        isMuted = newVolume === 0;
        audioEngine.setVolume(playbackVolume);
        updateVolumeUI();
        window.api.setStoreValue('lastVolume', playbackVolume);
    });

    volumeBtn.addEventListener('click', () => {
        isMuted = !isMuted;
        audioEngine.setVolume(isMuted ? 0 : playbackVolume);
        updateVolumeUI();
    });

    // Window and System Controls
    pinBtn.addEventListener('click', async () => pinBtn.classList.toggle('pinned', await window.api.pinWindow()));
    minimizeBtn.addEventListener('click', () => window.api.minimizeWindow());
    closeBtn.addEventListener('click', () => window.api.closeWindow());

    // App Settings & Menus
    lightModeBtn.addEventListener('click', () => {
        const isLight = containerEl.classList.toggle('light-mode');
        window.api.setStoreValue('theme', isLight ? 'light' : 'dark');
        updateAppSettingsMenu();
    });

    orientationBtn.addEventListener('click', () => {
        const isCurrentlyVertical = containerEl.classList.contains('vertical-mode');
        window.api.toggleOrientation(!isCurrentlyVertical);
    });

    volumeBoostBtn.addEventListener('click', () => {
        const isBoosting = !(parseFloat(volumeSlider.max) > 1.0);

        if (!isBoosting && playbackVolume > 1.0) {
            playbackVolume = 1.0;
            audioEngine.setVolume(playbackVolume);
        }

        volumeSlider.max = isBoosting ? '2' : '1';
        updateVolumeUI();
        window.api.setStoreValue('volumeBoost', isBoosting);
        updateAppSettingsMenu();
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

    // Dropdown Menu Logic
    const dropdownMap = new Map([
        ['play-dropdown-btn', 'play-dropdown-menu'],
        ['file-dropdown-btn', 'file-dropdown-menu'],
        ['lyrics-dropdown-btn', 'lyrics-dropdown-menu'],
        ['app-dropdown-btn', 'app-dropdown-menu']
    ]);

    dropdownMap.forEach((menuId, btnId) => {
        const toggleBtn = document.getElementById(btnId);
        const menu = document.getElementById(menuId);
        if (!toggleBtn || !menu) return;

        toggleBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            const isAlreadyOpen = menu.classList.contains('show');

            // First, close all other open menus
            document.querySelectorAll('.dropdown-menu.show').forEach(openMenu => {
                openMenu.classList.remove('show');
                const openBtnId = Array.from(dropdownMap.keys()).find(key => dropdownMap.get(key) === openMenu.id);
                document.getElementById(openBtnId)?.parentElement.classList.remove('open');
            });

            if (!isAlreadyOpen) {
                const rect = toggleBtn.getBoundingClientRect();
                menu.style.top = `${rect.bottom + 5}px`;
                menu.style.right = `${window.innerWidth - rect.right}px`;
                menu.style.left = 'auto';
                menu.classList.add('show');
                toggleBtn.parentElement.classList.add('open');
            }
        });
    });

    // Settings Drawer Logic
    if (settingsDrawer && openTransparencyBtn && closeDrawerBtn) {
        openTransparencyBtn.addEventListener('click', () => settingsDrawer.classList.add('show'));
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

    volumeContainer.addEventListener('wheel', (event) => {
        // Prevent the default scroll behavior
        event.preventDefault();

        // Define how much the volume changes per scroll tick
        const volumeStep = 0.05;
        const scrollDirection = event.deltaY < 0 ? 1 : -1; // Up: 1, Down: -1

        // Calculate the new volume, ensuring it stays within the valid range (0 to max)
        let newVolume = playbackVolume + (scrollDirection * volumeStep);
        newVolume = Math.max(0, Math.min(parseFloat(volumeSlider.max), newVolume));

        // Apply the new volume
        playbackVolume = parseFloat(newVolume.toFixed(2));
        isMuted = playbackVolume === 0;
        audioEngine.setVolume(playbackVolume);

        // Update the UI and save the state
        updateVolumeUI();
        window.api.setStoreValue('lastVolume', playbackVolume);
    });

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

        loopOffIcon.style.display = loopMode === 'none' ? 'block' : 'none';
        loopAllIcon.style.display = loopMode === 'all' ? 'block' : 'none';
        loopOneIcon.style.display = loopMode === 'one' ? 'block' : 'none';

        loopBtn.classList.toggle('active', loopMode !== 'none');
        loopBtn.title = `Loop ${loopMode.charAt(0).toUpperCase() + loopMode.slice(1)}`;
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

    // --- Start the Application ---
    initialize().then(() => {
        // Start the continuous UI update loop only after initialization is complete
        requestAnimationFrame(updateUI);
    });
});


// --- Global Event Listeners ---

// Close dropdowns on outside click
window.addEventListener('click', () => {
    document.querySelectorAll('.dropdown-menu.show').forEach(openMenu => {
        openMenu.classList.remove('show');
        const dropdownMap = new Map([['play-dropdown-btn', 'play-dropdown-menu'], ['file-dropdown-btn', 'file-dropdown-menu'], ['lyrics-dropdown-btn', 'lyrics-dropdown-menu'], ['app-dropdown-btn', 'app-dropdown-menu']]);
        const btnId = Array.from(dropdownMap.keys()).find(key => dropdownMap.get(key) === openMenu.id);
        if (btnId) document.getElementById(btnId).parentElement.classList.remove('open');
    });
});

// Drag and Drop
containerEl.addEventListener('dragover', (event) => event.preventDefault());
containerEl.addEventListener('dragenter', () => containerEl.classList.add('drag-over'));
containerEl.addEventListener('dragleave', () => containerEl.classList.remove('drag-over'));
containerEl.addEventListener('drop', async (event) => {
    event.preventDefault();
    containerEl.classList.remove('drag-over');
    const droppedPaths = Array.from(event.dataTransfer.files).map(f => f.path).filter(p => p);
    if (droppedPaths.length > 0) {
        const processedFiles = await window.api.processDroppedPaths(droppedPaths);
        loadPlaylistAndPlay(processedFiles);
    }
});

// Keyboard Shortcuts
window.addEventListener('keydown', (event) => {
    if (event.target.tagName === 'INPUT') return;
    const actions = {
        'Space': () => playPauseBtn.click(),
        'ArrowRight': () => nextBtn.click(),
        'ArrowLeft': () => prevBtn.click(),
        'ArrowUp': () => {
            let newVol = Math.min(parseFloat(volumeSlider.max), playbackVolume + 0.05);
            playbackVolume = parseFloat(newVol.toFixed(2));
            audioEngine.setVolume(playbackVolume);
            updateVolumeUI();
            window.api.setStoreValue('lastVolume', playbackVolume);
        },
        'ArrowDown': () => {
            let newVol = Math.max(0, playbackVolume - 0.05);
            playbackVolume = parseFloat(newVol.toFixed(2));
            audioEngine.setVolume(playbackVolume);
            updateVolumeUI();
            window.api.setStoreValue('lastVolume', playbackVolume);
        },
        'KeyM': () => volumeBtn.click()
    };
    if (actions[event.code]) {
        event.preventDefault();
        actions[event.code]();
    }
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

window.api.onFilePathReceived((filePath) => loadPlaylistAndPlay([filePath]));

window.api.onSetOrientationClass((isVertical) => {
    containerEl.classList.toggle('vertical-mode', isVertical);
});