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
    const junkRegex = /\[.*?\]|\(.*?\)|official|lyric|video|audio|h[dq]/gi;
    const cleanArtist = artist.replace(junkRegex, '').trim();
    const cleanTitle = title.replace(junkRegex, '').trim();
    return {artist: cleanArtist, title: cleanTitle};
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
        console.error('Error fetching lyrics:', error);
        return null;
    }
}

async function searchAndDisplayOnlineLyrics(songData) {
    if (!lyricsContainer) return;
    const noLyricsEl = lyricsContainer.querySelector('.lyrics-line');
    if (noLyricsEl) noLyricsEl.textContent = 'Searching for lyrics...';

    try {
        const {artist: cleanArtist, title: cleanTitle} = sanitizeForApiSearch(songData.artist, songData.title);
        const cacheKey = `lyricsCache.${cleanArtist} - ${cleanTitle}`; // Use cleanTitle for cache consistency
        const cachedLyrics = await window.api.getStoreValue(cacheKey);

        if (cachedLyrics) {
            console.log(`Lyrics for "${cleanTitle}" found in cache.`);
            lyrics = processLyrics(cachedLyrics);
        } else {
            const onlineLyricsText = await fetchLyrics(cleanArtist, cleanTitle);
            if (onlineLyricsText) {
                window.api.setStoreValue(cacheKey, onlineLyricsText);
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
    albumArtEl.src = songData.cover || 'placeholder.png';
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
            if (currentSound) { currentSound.unload(); currentSound = null; }
            nextBtn.click();
        },
        onplayerror: (soundId, error) => {
            if (thisTicket !== loadTicket) return;
            console.error(`Howler failed to play sound: ${songData.filePath}`, error);
            titleEl.textContent = 'Error: Cannot play file';
            artistEl.textContent = songData.basename;
            if (currentSound) { currentSound.unload(); currentSound = null; }
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
    console.log("Restoring state after orientation change:", state);
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
        playTrack(trackIndex, { startPaused: !state.isPlaying, seekTime: state.seek });
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
        if (isPlaying) currentSound.pause();
        else currentSound.play();
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
    const actions = {'play-pause': () => playPauseBtn.click(), 'next': () => nextBtn.click(), 'prev': () => prevBtn.click()};
    actions[command]?.();
});
window.api.onFilePathReceived((filePath) => loadPlaylistAndPlay([filePath]));
window.addEventListener('keydown', (event) => {
    if (event.target.tagName === 'INPUT') return;
    switch (event.code) {
        case 'Space': event.preventDefault(); playPauseBtn.click(); break;
        case 'ArrowRight': event.preventDefault(); nextBtn.click(); break;
        case 'ArrowLeft': event.preventDefault(); prevBtn.click(); break;
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
        case 'KeyM': event.preventDefault(); volumeBtn.click(); break;
    }
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