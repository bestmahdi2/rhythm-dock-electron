'use strict';

// Renders authoritative player state, with local lock and resize interactions.

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
    document.getElementById('overlay-previous').textContent = (payload.previous || '').trim();
    const playButton = document.getElementById('overlay-play');
    playButton.title = payload.isPlaying ? 'Pause' : 'Play';
    playButton.setAttribute('aria-label', playButton.title);
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

// Locked lyrics pass clicks through, while the toolbar remains recoverable.
const lockBtn = document.getElementById('overlay-lock');
lockBtn?.addEventListener('click', async () => {
    isClickThrough = await window.overlay.setClickThrough(!isClickThrough);
    overlayEl?.classList.toggle('click-through', isClickThrough);
    lockBtn.classList.toggle('active', isClickThrough);
    lockBtn.setAttribute('aria-pressed', String(isClickThrough));
    lockBtn.title = isClickThrough ? 'Unlock lyrics' : 'Lock lyrics (controls remain available)';
    lockBtn.setAttribute('aria-label', isClickThrough ? 'Unlock lyrics' : 'Lock lyrics');
    interactive = true;
    window.overlay.setInteractive(true);
});

// Forwarded mouse moves still arrive while the lyrics are click-through. Re-enable
// hit testing over controls so locking never removes the route back to unlock.
let interactive = true;
document.addEventListener('mousemove', event => {
    if (!isClickThrough) return;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const next = Boolean(target?.closest('.overlay-controls, #overlay-resize'));
    if (next !== interactive) { interactive = next; window.overlay.setInteractive(next); }
});
document.addEventListener('mouseleave', () => {
    if (isClickThrough) { interactive = false; window.overlay.setInteractive(false); }
});
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && isClickThrough) lockBtn.click();
});
const resizeGrip = document.getElementById('overlay-resize');
let resizing;
resizeGrip.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    resizing = {x:event.screenX, y:event.screenY, width:window.innerWidth, height:window.innerHeight};
    resizeGrip.setPointerCapture(event.pointerId);
    event.preventDefault();
});
resizeGrip.addEventListener('pointermove', event => {
    if (resizing) window.overlay.resize({width:resizing.width + event.screenX - resizing.x,
        height:resizing.height + event.screenY - resizing.y});
});
resizeGrip.addEventListener('pointerup', () => { resizing = null; });
resizeGrip.addEventListener('lostpointercapture', () => { resizing = null; });
window.overlay.ready();
