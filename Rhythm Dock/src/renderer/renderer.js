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

// --- Get references to UI elements ---
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
const toggleOrientationBtn = document.getElementById('orientation-btn');
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

// --- Helper Functions ---
function formatTime(secs) {
    const minutes = Math.floor(secs / 60) || 0;
    const seconds = Math.floor(secs - minutes * 60) || 0;
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

// --- FIX 1: Changed from 'const displayLyrics =' to 'function displayLyrics('
// This ensures the function is "hoisted" and available everywhere in the script.
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
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
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

// --- FIX 2: Consolidated the two duplicate getSongIdentifier functions into one.
// This function now reliably uses the current player state.
function getSongIdentifier() {
    if (!currentSongData || !currentSound) return null;
    const duration = Math.round(currentSound.duration());
    return `${currentSongData.artist} - ${currentSongData.title} - ${duration}`;
}


function updateOffsetDisplay() {
    if (!lyricsOffsetDisplay) return;
    lyricsOffsetDisplay.textContent = `${currentLyricsOffset >= 0 ? '+' : ''}${currentLyricsOffset.toFixed(1)}s`;
}

// --- UI Update Functions ---
function updatePlayPauseIcon() {
    playIcon.style.display = isPlaying ? 'none' : 'block';
    pauseIcon.style.display = isPlaying ? 'block' : 'none';
}

function updateVolumeUI() {
    const currentVolume = Howler.volume();
    volumeIcon.style.display = (isMuted || currentVolume === 0) ? 'none' : 'block';
    volumeMuteIcon.style.display = (isMuted || currentVolume === 0) ? 'block' : 'none';
    volumeSlider.value = isMuted ? 0 : currentVolume;
}

function updateUI() {
    if (currentSound && isPlaying) {
        const seek = currentSound.seek() || 0;
        const duration = currentSound.duration() || 0;
        progressBar.value = seek;
        updateTimeDisplay();
        timeCurrentEl.textContent = formatTime(seek);
        timeRemainingEl.textContent = timeDisplayMode === 'remaining' ? `-${formatTime(duration - seek)}` : formatTime(duration);

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

async function loadInitialState() {
    const lastVolume = await window.api.getStoreValue('lastVolume');
    if (lastVolume !== undefined) {
        Howler.volume(lastVolume);
    } else {
        Howler.volume(1.0);
    }

    const lastState = await window.api.getStoreValue('lastPlaybackState');
    if (lastState && lastState.playlist && lastState.lastPlayedPath) {
        originalPlaylist = lastState.playlist;
        playlist = [...originalPlaylist];
        isShuffled = lastState.isShuffled || false;

        if (isShuffled) {
            shuffleArray(playlist);
            shuffleBtn.classList.add('active');
        }

        const lastTrackIndex = playlist.findIndex(path => path === lastState.lastPlayedPath);

        if (lastTrackIndex !== -1) {
            await playTrack(lastTrackIndex, {startPaused: true, seekTime: lastState.seek});
        }
    }

    updateVolumeUI();
    const savedOffsets = await window.api.getStoreValue('lyricsOffsets');
    if (savedOffsets) {
        lyricsOffsets = savedOffsets;
    }
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
        // FIX: Provide better user feedback on network errors
        console.error('Error fetching lyrics:', error);
        // This check is useful because the lyrics object might not exist yet
        if (lyricsContainer.querySelector('.lyrics-line')) {
            lyricsContainer.querySelector('.lyrics-line').textContent = 'Lyrics search failed (Network Error)';
        }
        return null;
    }
}

async function searchAndDisplayOnlineLyrics(songData) {
    if (!lyricsContainer) return;
    const noLyricsEl = lyricsContainer.querySelector('.lyrics-line');
    if (noLyricsEl) noLyricsEl.textContent = 'Searching for lyrics...';

    try {
        // Use the unique song identifier for the database key
        const songId = getSongIdentifier();
        if (!songId) {
            // Cannot generate an ID, so we can't use the database.
            // You could optionally just fetch without saving.
            throw new Error("Cannot generate a song identifier to use the database.");
        }

        const cachedLyrics = await window.api.getLyrics(songId);

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

    Howler.stop();
    const {startPaused = false, seekTime = 0} = options;

    if (index < 0 || index >= playlist.length) {
        if (currentSound) currentSound.stop();
        isPlaying = false;
        updatePlayPauseIcon();
        reportPlaybackState();
        return;
    }
    currentIndex = index;

    if (currentSound) {
        currentSound.unload();
    }

    const songData = await window.api.getMetadata(playlist[currentIndex]);
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

    currentSound = new Howl({
        src: [songData.filePath],
        html5: true,
        onload: () => {
            if (thisTicket !== loadTicket) return;
            progressBar.max = currentSound.duration();
            if (seekTime > 0) currentSound.seek(seekTime);

            // --- FIX 2 (continued): Changed call to use the new single function
            const songId = getSongIdentifier();
            currentLyricsOffset = lyricsOffsets[songId] || 0;
            updateOffsetDisplay();
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
        onplayerror: (soundId, error) => {
            if (thisTicket !== loadTicket) return;
            console.error(`Howler failed to play sound: ${songData.filePath}`, error);
            titleEl.textContent = 'Error: Cannot play file';
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
        Howler.stop();
        originalPlaylist = [...files];
        playlist = [...files];
        if (isShuffled) {
            shuffleArray(playlist);
        }
        playTrack(0);
    }
}

window.getCurrentAppState = () => {
    return {
        originalPlaylist,
        isShuffled,
        currentTrackPath: playlist.length > 0 ? playlist[currentIndex] : null,
        seek: currentSound ? currentSound.seek() : 0,
        isPlaying,
        volume: Howler.volume(),
        isMuted,
        loopMode,
    };
};

window.api.onRestoreState((state) => {
    if (!state || !state.originalPlaylist) {
        loadInitialState();
        return;
    }
    originalPlaylist = state.originalPlaylist;
    playlist = [...state.originalPlaylist];
    isShuffled = state.isShuffled;
    if (isShuffled) {
        shuffleArray(playlist);
        shuffleBtn.classList.add('active');
    }
    Howler.volume(state.volume);
    isMuted = state.isMuted;
    Howler.mute(isMuted);
    updateVolumeUI();
    loopMode = 'none';
    const targetLoopIndex = ['none', 'all', 'one'].indexOf(state.loopMode);
    for (let i = 0; i < targetLoopIndex; i++) {
        loopBtn.click();
    }
    const trackIndex = playlist.findIndex(path => path === state.currentTrackPath);
    if (trackIndex !== -1) {
        playTrack(trackIndex, {startPaused: !state.isPlaying, seekTime: state.seek});
    }
});

if (lyricsOffsetMinusBtn) {
    lyricsOffsetMinusBtn.addEventListener('click', () => {
        currentLyricsOffset -= 0.1;
        updateOffsetDisplay();
        const songId = getSongIdentifier();
        if (songId) {
            lyricsOffsets[songId] = currentLyricsOffset;
            saveLyricsOffsets();
        }
    });
}
if (lyricsOffsetPlusBtn) {
    lyricsOffsetPlusBtn.addEventListener('click', () => {
        currentLyricsOffset += 0.1;
        updateOffsetDisplay();
        const songId = getSongIdentifier();
        if (songId) {
            lyricsOffsets[songId] = currentLyricsOffset;
            saveLyricsOffsets();
        }
    });
}

// --- Event Listeners ---
openFileBtn.addEventListener('click', async () => loadPlaylistAndPlay(await window.api.openFiles()));
if (openFolderBtn) openFolderBtn.addEventListener('click', async () => loadPlaylistAndPlay(await window.api.openFolder()));
albumArtEl.addEventListener('click', () => openFileBtn.click());

playPauseBtn.addEventListener('click', () => {
    if (currentSound) {
        if (isPlaying) {
            // This part is for pausing and works correctly.
            currentSound.pause();
        } else {
            // --- THIS IS THE FIX ---
            // Optimistically set the state to "playing" and update the UI immediately.
            // This avoids the race condition.
            isPlaying = true;
            updatePlayPauseIcon();
            reportPlaybackState();

            // Now, perform the actual playback action.
            const seek = currentSound.seek();
            const duration = currentSound.duration();

            if (seek >= duration - 0.1) {
                // If the song is over, restart it fully.
                playTrack(currentIndex);
            } else {
                // If paused, just resume.
                currentSound.play();
            }
        }
    } else if (playlist.length > 0) {
        // This is for when the app first opens and nothing is loaded.
        isPlaying = true;
        updatePlayPauseIcon();
        reportPlaybackState();
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
    }
});
progressBar.addEventListener('input', () => {
    if (currentSound) currentSound.seek(progressBar.value);
});
progressBar.addEventListener('wheel', (event) => {
    if (!currentSound) return;
    event.preventDefault();
    event.stopPropagation();
    const seekTime = 5;
    let seek = currentSound.seek();
    if (event.deltaY < 0) seek += seekTime;
    else seek -= seekTime;
    const duration = currentSound.duration();
    seek = Math.max(0, Math.min(duration, seek));
    currentSound.seek(seek);
    progressBar.value = seek;
});
volumeSlider.addEventListener('input', (e) => {
    const newVolume = parseFloat(e.target.value);
    Howler.volume(newVolume);
    isMuted = false;
    Howler.mute(false);
    updateVolumeUI();
    window.api.setStoreValue('lastVolume', newVolume);
});
volumeBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    Howler.mute(isMuted);
    updateVolumeUI();
});
if (copyPathBtn) {
    copyPathBtn.addEventListener('click', () => {
        if (!currentSound || currentIndex < 0) return;
        const filePath = playlist[currentIndex];
        window.api.copyToClipboard(filePath);
        copyPathBtn.classList.add('copy-success');
        setTimeout(() => copyPathBtn.classList.remove('copy-success'), 1000);
    });
}
if (showFileBtn) {
    showFileBtn.addEventListener('click', () => {
        if (!currentSound || currentIndex < 0) return;
        const filePath = playlist[currentIndex];
        window.api.showFileInFolder(filePath);
    });
}
timeRemainingEl.addEventListener('click', () => {
    timeDisplayMode = timeDisplayMode === 'remaining' ? 'total' : 'remaining';
    updateTimeDisplay();
});
toggleOrientationBtn.addEventListener('click', () => {
    const isCurrentlyVertical = !document.querySelector('.content-wrapper');
    window.api.toggleOrientation(!isCurrentlyVertical);
});
pinBtn.addEventListener('click', async () => pinBtn.classList.toggle('pinned', await window.api.pinWindow()));
minimizeBtn.addEventListener('click', () => window.api.minimizeWindow());
closeBtn.addEventListener('click', () => window.api.closeWindow());
shuffleBtn.addEventListener('click', () => {
    isShuffled = !isShuffled;
    shuffleBtn.classList.toggle('active', isShuffled);
    if (playlist.length === 0) return;
    const currentTrack = playlist[currentIndex];
    if (isShuffled) {
        shuffleArray(playlist);
    } else {
        playlist = [...originalPlaylist];
    }
    currentIndex = playlist.findIndex(track => track === currentTrack);
});
loopBtn.addEventListener('click', () => {
    loopOffIcon.style.display = 'none';
    loopAllIcon.style.display = 'none';
    loopOneIcon.style.display = 'none';
    loopBtn.classList.remove('active');
    if (loopMode === 'none') {
        loopMode = 'all';
        loopAllIcon.style.display = 'block';
        loopBtn.classList.add('active');
        loopBtn.title = 'Loop All';
    } else if (loopMode === 'all') {
        loopMode = 'one';
        loopOneIcon.style.display = 'block';
        loopBtn.classList.add('active');
        loopBtn.title = 'Loop One';
    } else {
        loopMode = 'none';
        loopOffIcon.style.display = 'block';
        loopBtn.title = 'Loop Off';
    }
});
containerEl.addEventListener('wheel', (event) => {
    event.preventDefault();
    const volumeStep = 0.05;
    let currentVolume = Howler.volume();
    if (event.deltaY < 0) currentVolume += volumeStep;
    else currentVolume -= volumeStep;
    currentVolume = Math.max(0, Math.min(1, currentVolume));
    Howler.volume(currentVolume);
    isMuted = false;
    Howler.mute(false);
    updateVolumeUI();
    window.api.setStoreValue('lastVolume', currentVolume);
});
containerEl.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.stopPropagation();
});
containerEl.addEventListener('dragenter', () => containerEl.classList.add('drag-over'));
containerEl.addEventListener('dragleave', () => containerEl.classList.remove('drag-over'));
containerEl.addEventListener('drop', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    containerEl.classList.remove('drag-over');
    const droppedPaths = Array.from(event.dataTransfer.files).map(f => f.path).filter(p => p);
    if (droppedPaths.length === 0) return;
    const processedFiles = await window.api.processDroppedPaths(droppedPaths);
    loadPlaylistAndPlay(processedFiles);
});
window.api.onMediaKey((command) => {
    const actions = {
        'play-pause': () => playPauseBtn.click(),
        'next': () => nextBtn.click(),
        'prev': () => prevBtn.click()
    };
    actions[command]?.();
});
window.api.onFilePathReceived((filePath) => loadPlaylistAndPlay([filePath]));
window.addEventListener('keydown', (event) => {
    if (event.target.tagName === 'INPUT') return;
    switch (event.code) {
        case 'Space':
            event.preventDefault();
            playPauseBtn.click();
            break;
        case 'ArrowRight':
            event.preventDefault();
            nextBtn.click();
            break;
        case 'ArrowLeft':
            event.preventDefault();
            prevBtn.click();
            break;
        case 'ArrowUp':
            event.preventDefault();
            let newVolUp = Math.min(1, Howler.volume() + 0.05);
            Howler.volume(newVolUp);
            updateVolumeUI();
            break;
        case 'ArrowDown':
            event.preventDefault();
            let newVolDown = Math.max(0, Howler.volume() - 0.05);
            Howler.volume(newVolDown);
            updateVolumeUI();
            break;
        case 'KeyM':
            event.preventDefault();
            volumeBtn.click();
            break;
    }
});

document.addEventListener('DOMContentLoaded', () => {
    // --- Element Selection ---
    const lyricsControls = document.querySelector('.lyrics-controls');
    const lyricsOffsetMinusBtn = document.getElementById('lyrics-offset-minus-btn');
    const lyricsOffsetPlusBtn = document.getElementById('lyrics-offset-plus-btn');

    // Make sure we found the elements before proceeding
    if (!lyricsControls || !lyricsOffsetMinusBtn || !lyricsOffsetPlusBtn) {
        console.log('Lyrics control elements not found, skipping enhancement.');
        return;
    }

    // --- Core Logic and State ---
    let holdDelayTimer = null;    // Timer for the 1-second delay
    let holdRepeatTimer = null;   // Timer for the rapid repeating action
    const HOLD_DELAY_MS = 500;   // 0.5 second delay
    const HOLD_INTERVAL_MS = 100; // Adjusts every 100ms when held

    // This assumes you have a function or variable that handles the offset.
    // We will simulate it here. You should integrate this with your actual offset logic.
    // For example, replace this with `window.api.adjustLyricsOffset(amount);`
    // IMPORTANT: This function is now the ONLY way we adjust the offset.
    const updateLyricsOffset = (amount) => {
        // Find the display element each time to ensure it's current
        const lyricsOffsetDisplay = document.getElementById('lyrics-offset-display');
        if (lyricsOffsetDisplay) {
            // This is example logic. Replace it with your app's actual offset handling.
            let currentOffset = parseFloat(lyricsOffsetDisplay.textContent) || 0;
            let newOffset = parseFloat((currentOffset + amount).toFixed(2));

            // Update your application's actual offset variable here!
            // Example: window.lyrics.offset = newOffset;

            // Update the display
            lyricsOffsetDisplay.textContent = newOffset.toFixed(1) + 's';
        }
    };

    // --- 1. SCROLL WHEEL SUPPORT FOR LYRICS OFFSET ---
    lyricsControls.addEventListener('wheel', (event) => {
        // Prevent the default scroll action (like scrolling the page)
        event.preventDefault();
        // CRITICAL: Stop the event from bubbling up to the volume control
        event.stopPropagation();

        // Check scroll direction and adjust offset
        const adjustment = event.deltaY < 0 ? 0.1 : -0.1;
        updateLyricsOffset(adjustment);
    }, {passive: false});


    // --- 2. REFINED PRESS-AND-HOLD LOGIC ---
    const setupHoldListener = (buttonElement, adjustment) => {
        const stopHold = () => {
            // Clear both timers to stop any pending or active hold action
            clearTimeout(holdDelayTimer);
            clearInterval(holdRepeatTimer);
        };

        const startHold = () => {
            // --- Step A: Immediate single-click action ---
            updateLyricsOffset(adjustment);

            // --- Step B: Set a timeout for the 1-second delay ---
            holdDelayTimer = setTimeout(() => {
                // --- Step C: After 1s, start the rapid adjustment interval ---
                holdRepeatTimer = setInterval(() => {
                    updateLyricsOffset(adjustment);
                }, HOLD_INTERVAL_MS);
            }, HOLD_DELAY_MS);
        };

        // Assign events to the button
        buttonElement.addEventListener('mousedown', startHold);
        buttonElement.addEventListener('mouseup', stopHold);
        buttonElement.addEventListener('mouseleave', stopHold);
    };

    // Initialize the listeners for both buttons
    setupHoldListener(lyricsOffsetMinusBtn, -0.1);
    setupHoldListener(lyricsOffsetPlusBtn, 0.1);

    // --- Dropdown Menu Logic ---
    // Link toggle buttons to their corresponding menu IDs
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
            event.stopPropagation(); // Prevent the window click listener from immediately closing it

            const isAlreadyOpen = menu.classList.contains('show');

            // First, close all menus
            document.querySelectorAll('.dropdown-menu.show').forEach(openMenu => {
                openMenu.classList.remove('show');
                // Also reset the toggle button state
                const openBtn = Array.from(dropdownMap.keys()).find(key => dropdownMap.get(key) === openMenu.id);
                document.getElementById(openBtn)?.parentElement.classList.remove('open');
            });

            // If the clicked menu was NOT already open, show it and position it
            if (!isAlreadyOpen) {
                // Get the position of the button that was clicked
                const rect = toggleBtn.getBoundingClientRect();

                // Position the menu below the button
                menu.style.top = `${rect.bottom + 5}px`; // 5px of space below the button
                menu.style.right = `${window.innerWidth - rect.right}px`; // Align the right edges
                menu.style.left = 'auto'; // Unset left

                menu.classList.add('show');
                toggleBtn.parentElement.classList.add('open');
            }
        });
    });

// Close dropdowns if user clicks outside of them
    window.addEventListener('click', (event) => {
        document.querySelectorAll('.dropdown-menu.show').forEach(openMenu => {
            // Find which button corresponds to this open menu
            const btnId = Array.from(dropdownMap.keys()).find(key => dropdownMap.get(key) === openMenu.id);
            const toggleBtn = document.getElementById(btnId);

            // If the click was not on the toggle button itself, close the menu
            if (toggleBtn && !toggleBtn.contains(event.target)) {
                openMenu.classList.remove('show');
                toggleBtn.parentElement.classList.remove('open');
            }
        });
    });

    // --- Settings Drawer Logic ---
    const settingsDrawer = document.getElementById('settings-drawer');
    const openTransparencyBtn = document.getElementById('settings-transparency-btn');
    const closeDrawerBtn = document.getElementById('close-settings-drawer-btn');

    if (settingsDrawer && openTransparencyBtn && closeDrawerBtn) {
        // Button in the dropdown to open the drawer
        openTransparencyBtn.addEventListener('click', () => {
            settingsDrawer.classList.add('show');
        });

        // Button inside the drawer to close it
        closeDrawerBtn.addEventListener('click', () => {
            settingsDrawer.classList.remove('show');
        });
    }

    // --- App Settings Dropdown Logic ---
    const lightModeBtn = document.getElementById('light-mode-btn');

    const goToGithubBtn = document.getElementById('go-to-github-btn');
    const transparencySlider = document.getElementById('transparency-slider');
    const transparencyValue = document.getElementById('transparency-value');
    const appVersionContainer = document.getElementById('app-version-container');
    const appVersionDisplay = document.getElementById('app-version-display');

    // 1. Light/Dark Mode
    lightModeBtn.addEventListener('click', () => {
        const isLight = containerEl.classList.toggle('light-mode');
        window.api.setStoreValue('theme', isLight ? 'light' : 'dark');
    });

    // 2. GitHub Link
    goToGithubBtn.addEventListener('click', () => {
        window.api.openGitHub();
    });

    // 3. Transparency
    transparencySlider.addEventListener('input', () => {
        const opacityValue = parseFloat(transparencySlider.value);
        // Send to main process to change window opacity
        window.api.setOpacity(opacityValue);
        // Update the text display
        transparencyValue.textContent = `${Math.round(opacityValue * 100)}%`;
    });

    // 4. Show Version
    const showVersionBtn = document.getElementById('show-version-btn');

    showVersionBtn.addEventListener('click', async () => {
        const version = await window.api.getAppVersion();
        appVersionDisplay.textContent = `v${version}`;
        appVersionContainer.style.display = 'flex';
        settingsDrawer.classList.add('show');
    });

    // 5. Load Initial Settings on Startup
    async function loadAppSettings() {
        // Theme
        const theme = await window.api.getStoreValue('theme');
        if (theme === 'light') {
            containerEl.classList.add('light-mode');
        }
        // Opacity
        const opacity = await window.api.getStoreValue('windowOpacity', 0.85);
        transparencySlider.value = opacity;
        transparencyValue.textContent = `${Math.round(opacity * 100)}%`;
    }

    // Call this function inside your existing DOMContentLoaded listener
    loadAppSettings();
});

// --- LISTENER FOR FILE OPEN FROM MAIN PROCESS ---

// Use the secure API exposed by the preload script
window.api.onPlayFile((filePath) => {
    loadPlaylistAndPlay([filePath]);
});

// --- Initial Setup ---
Howler.stop();
isMuted = false;
Howler.mute(isMuted);
window.api.getStoreValue('isPinned').then(isPinned => {
    pinBtn.classList.toggle('pinned', isPinned !== false);
});
loadInitialState();
updateUI();
setInterval(savePlaybackState, 5000);
window.addEventListener('beforeunload', savePlaybackState);