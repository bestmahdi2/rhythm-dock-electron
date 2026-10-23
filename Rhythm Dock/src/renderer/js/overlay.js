'use strict';

/**
 * Desktop lyrics overlay renderer (Phase 9).
 *
 * Intentionally dumb. It owns no timing, no parsing and no playback state: the main
 * window already runs a per-frame loop that knows exactly which line is current, and
 * duplicating that here would mean two clocks drifting apart. This window renders what
 * it is told and forwards button presses back.
 */

const lineEl = document.getElementById('overlay-line');
const nextEl = document.getElementById('overlay-next');
const overlayEl = document.getElementById('overlay');
const playIconEl = document.getElementById('overlay-play-icon');


let isClickThrough = false;

/** Paints a line, or the idle placeholder when there is nothing to show. */
function render(payload = {}) {
    const text = (payload.line || '').trim();

    if (lineEl) {
        lineEl.textContent = text || (payload.title || 'Rhythm Dock');
        lineEl.classList.toggle('idle', !text);
    }
    if (nextEl) {
        nextEl.textContent = (payload.next || '').trim();
    }
    if (playIconEl) {
        window.DockIcons.paint(playIconEl, payload.isPlaying ? 'pause' : 'play');
    }
    // The main window is authoritative for direction: an RTL translation has to flip
    // this strip too, and it is the only side that knows the target language.
    document.documentElement.dir = payload.rtl ? 'rtl' : 'ltr';
}

/** Mirrors the user's lyric typography, pushed from the main window's settings. */
function applyStyle(typography = {}) {
    const root = document.documentElement.style;
    if (typography.fontFamily !== undefined) {
        root.setProperty('--lyric-font-family', typography.fontFamily || 'inherit');
    }
    if (typography.fontSize) root.setProperty('--lyric-font-size', `${typography.fontSize}px`);
    if (typography.fontWeight) root.setProperty('--lyric-font-weight', String(typography.fontWeight));
    if (typography.lineHeight) root.setProperty('--lyric-line-height', String(typography.lineHeight));
    if (typography.align) root.setProperty('--lyric-align', typography.align);
}

window.overlay.onUpdate(render);
window.overlay.onStyle(applyStyle);

document.getElementById('overlay-prev')
    ?.addEventListener('click', () => window.overlay.command('prev'));
document.getElementById('overlay-play')
    ?.addEventListener('click', () => window.overlay.command('play-pause'));
document.getElementById('overlay-next-btn')
    ?.addEventListener('click', () => window.overlay.command('next'));
document.getElementById('overlay-close')
    ?.addEventListener('click', () => window.overlay.close());

/**
 * Click-through is a one-way door from this window's point of view: once the pointer
 * passes through, the button that would turn it off is no longer clickable. So the
 * only way back is from the main window's menu, and the button says so.
 */
const lockBtn = document.getElementById('overlay-lock');
lockBtn?.addEventListener('click', async () => {
    isClickThrough = await window.overlay.setClickThrough(!isClickThrough);
    overlayEl?.classList.toggle('click-through', isClickThrough);
    lockBtn.classList.toggle('active', isClickThrough);
    lockBtn.title = isClickThrough
        ? 'Click-through is on — turn it off from the player'
        : 'Click-through';
});
