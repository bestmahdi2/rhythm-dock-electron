#!/usr/bin/env node
'use strict';

/**
 * Generates every icon electron-builder needs, for every platform, from code.
 *
 * Why generate instead of committing binaries:
 *   - We need ~10 file-association icons x 3 formats (.ico/.icns/.png). That is 30
 *     binaries to hand-maintain and keep in sync.
 *   - macOS and Linux builds were failing partly because only a Windows `.ico` existed;
 *     electron-builder wants a 512px+ `.png` for Linux and an `.icns` for macOS.
 *   - Request #1 ("the mp3 icon must look different from the other supported types")
 *     is a per-extension artwork problem, which is trivial once artwork is a function.
 *
 * Output: Rhythm Dock/build/icons/
 *
 *   icon.png            1024x1024   -> Linux, and the source for the other two
 *   icon.ico                        -> Windows app icon
 *   icon.icns                       -> macOS app icon
 *   filetypes/mp3.ico | .icns | .png
 *   filetypes/<ext>....             -> one set per supported container
 *
 * Run manually with `npm run icons`; it also runs automatically from `prebuild`.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const png2icons = require('png2icons');

const OUTPUT_DIR = path.join(__dirname, '..', 'build', 'icons');
const FILETYPE_DIR = path.join(OUTPUT_DIR, 'filetypes');
const MEDIA_DIR = path.join(OUTPUT_DIR, 'media');
const TRAY_DIR = path.join(OUTPUT_DIR, 'tray');

const BRAND = {
    green: '#1db954',
    greenDark: '#0d7a36',
    ink: '#141414',
};

/**
 * One entry per container the app can open.
 *
 * `mp3` is deliberately the odd one out: it is the only entry with `hero: true`, which
 * gives it the brand-green gradient, the vinyl-record mark and a wider badge. Every
 * other format gets the neutral slate plate with a plain waveform. At 16px in Explorer
 * the silhouette, not just the colour, is different — which is the point.
 */
const FILE_TYPES = [
    {ext: 'mp3', label: 'MP3', from: '#1db954', to: '#0a5c28', hero: true, mime: 'audio/mpeg'},
    {ext: 'm4a', label: 'M4A', from: '#4a5568', to: '#2d3440', mime: 'audio/mp4'},
    {ext: 'm4b', label: 'M4B', from: '#4a5568', to: '#2d3440', mime: 'audio/mp4'},
    {ext: 'flac', label: 'FLAC', from: '#3f6f8f', to: '#24455a', mime: 'audio/flac'},
    {ext: 'wav', label: 'WAV', from: '#5a5470', to: '#332f45', mime: 'audio/wav'},
    {ext: 'ogg', label: 'OGG', from: '#4c6b52', to: '#2b3f2f', mime: 'audio/ogg'},
    {ext: 'opus', label: 'OPUS', from: '#6b5a48', to: '#3d3328', mime: 'audio/opus'},
    {ext: 'aac', label: 'AAC', from: '#6b4a5a', to: '#3d2a33', mime: 'audio/aac'},
    {ext: 'wma', label: 'WMA', from: '#4a5a6b', to: '#2a343d', mime: 'audio/x-ms-wma'},
    {ext: 'aiff', label: 'AIFF', from: '#5f5a4a', to: '#37342a', mime: 'audio/aiff'},
    {ext: 'mp4', label: 'MP4', from: '#6b5148', to: '#3d2e28', mime: 'video/mp4'},
];

// --- SVG artwork -----------------------------------------------------------------

/** The app icon: a vinyl record sitting in a rounded brand-green plate. */
function appIconSvg(size = 1024) {
    return `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${BRAND.green}"/>
      <stop offset="100%" stop-color="${BRAND.greenDark}"/>
    </linearGradient>
    <radialGradient id="disc" cx="50%" cy="42%" r="60%">
      <stop offset="0%" stop-color="#3a3a3a"/>
      <stop offset="100%" stop-color="#101010"/>
    </radialGradient>
  </defs>
  <rect x="48" y="48" width="928" height="928" rx="208" fill="url(#plate)"/>
  <circle cx="512" cy="512" r="322" fill="url(#disc)"/>
  <g fill="none" stroke="#ffffff" stroke-opacity="0.16" stroke-width="10">
    <circle cx="512" cy="512" r="268"/>
    <circle cx="512" cy="512" r="216"/>
    <circle cx="512" cy="512" r="164"/>
  </g>
  <circle cx="512" cy="512" r="86" fill="${BRAND.green}"/>
  <circle cx="512" cy="512" r="26" fill="${BRAND.ink}"/>
</svg>`;
}

/** A waveform, used as the neutral mark on non-mp3 formats. */
function waveformMark() {
    const bars = [
        [312, 150], [382, 250], [452, 360], [522, 250],
        [592, 400], [662, 210], [732, 120],
    ];
    return bars
        .map(([x, h]) => {
            const y = 520 - h / 2;
            return `<rect x="${x}" y="${y}" width="42" height="${h}" rx="21" fill="#ffffff" fill-opacity="0.92"/>`;
        })
        .join('\n    ');
}

/** The vinyl mark, reserved for mp3. */
function vinylMark() {
    return `
    <circle cx="512" cy="500" r="196" fill="#0f0f0f"/>
    <g fill="none" stroke="#ffffff" stroke-opacity="0.22" stroke-width="9">
      <circle cx="512" cy="500" r="158"/>
      <circle cx="512" cy="500" r="120"/>
      <circle cx="512" cy="500" r="82"/>
    </g>
    <circle cx="512" cy="500" r="44" fill="#ffffff" fill-opacity="0.95"/>
    <circle cx="512" cy="500" r="15" fill="#0f0f0f"/>`;
}

/**
 * A document-shaped file-association icon: folded-corner page, coloured plate,
 * a format mark and an extension badge along the bottom.
 */
function fileTypeSvg(type, size = 1024) {
    const badgeWidth = type.hero ? 470 : 380;
    const badgeX = (1024 - badgeWidth) / 2;
    const fontSize = type.label.length > 3 ? 104 : 124;

    return `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="page" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${type.from}"/>
      <stop offset="100%" stop-color="${type.to}"/>
    </linearGradient>
    <linearGradient id="fold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.25"/>
    </linearGradient>
  </defs>

  <!-- Page silhouette with a folded top-right corner. -->
  <path d="M168 96
           h430
           l258 258
           v574
           a56 56 0 0 1 -56 56
           H168
           a56 56 0 0 1 -56 -56
           V152
           a56 56 0 0 1 56 -56 z"
        fill="url(#page)"/>
  <path d="M598 96 l258 258 h-202 a56 56 0 0 1 -56 -56 z" fill="url(#fold)"/>

  <!-- Format mark. mp3 gets the vinyl; everything else gets the waveform. -->
  ${type.hero ? vinylMark() : waveformMark()}

  <!-- Extension badge. -->
  <rect x="${badgeX}" y="742" width="${badgeWidth}" height="164" rx="46"
        fill="#000000" fill-opacity="${type.hero ? 0.42 : 0.34}"/>
  <text x="512" y="852"
        font-family="DejaVu Sans, Verdana, Geneva, sans-serif"
        font-size="${fontSize}" font-weight="bold"
        fill="#ffffff" text-anchor="middle" letter-spacing="6">${type.label}</text>
</svg>`;
}

// --- Rasterisation ---------------------------------------------------------------

async function svgToPng(svg, size) {
    return sharp(Buffer.from(svg)).resize(size, size).png({compressionLevel: 9}).toBuffer();
}

/**
 * Writes the .png / .ico / .icns trio for one piece of artwork.
 *
 * png2icons builds multi-resolution containers from a single large PNG, which is why
 * we always rasterise at 1024 first. BILINEAR is used because the artwork is flat
 * vector shapes — the fancier resamplers add ringing on the hard edges.
 */
async function writeIconSet(svg, outputDir, basename) {
    fs.mkdirSync(outputDir, {recursive: true});

    const png1024 = await svgToPng(svg, 1024);
    const pngPath = path.join(outputDir, `${basename}.png`);
    fs.writeFileSync(pngPath, png1024);

    const ico = png2icons.createICO(png1024, png2icons.BILINEAR, 0, true, true);
    if (!ico) throw new Error(`Failed to build ICO for ${basename}`);
    fs.writeFileSync(path.join(outputDir, `${basename}.ico`), ico);

    const icns = png2icons.createICNS(png1024, png2icons.BILINEAR, 0);
    if (!icns) throw new Error(`Failed to build ICNS for ${basename}`);
    fs.writeFileSync(path.join(outputDir, `${basename}.icns`), icns);

    return pngPath;
}

/**
 * electron-builder's Linux target wants a directory of sized PNGs named `<size>x<size>.png`
 * to populate the hicolor icon theme. Without it, .deb/.rpm builds warn and ship no icon.
 */
async function writeLinuxIconDir(svg, outputDir) {
    fs.mkdirSync(outputDir, {recursive: true});
    for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
        fs.writeFileSync(path.join(outputDir, `${size}x${size}.png`), await svgToPng(svg, size));
    }
}

// --- Taskbar (thumbar) and tray icons ------------------------------------------
//
// Request #4: the Windows thumbar buttons were invisible against a dark taskbar,
// because a single set of dark glyphs was shipped for both themes. Windows does not
// tint these images, so the only fix is to ship both and swap at runtime on
// nativeTheme.updated. They were also loaded from src/assets/images/*.png, which is
// not generated by anything — a missing file there throws out of setThumbarButtons()
// and takes the window with it.

const MEDIA_GLYPHS = {
    play: 'M8 5v14l11-7z',
    pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
    next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
    prev: 'M18 6l-8.5 6 8.5 6V6zM8 6H6v12h2V6z',
    stop: 'M6 6h12v12H6z',
};

/**
 * A single media glyph on a transparent background.
 * `tone` is the fill: near-white for dark taskbars, near-black for light ones.
 */
function mediaGlyphSvg(name, tone) {
    return `
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24">
  <path d="${MEDIA_GLYPHS[name]}" fill="${tone}"/>
</svg>`;
}

/**
 * Tray icon. macOS wants a monochrome template image it can invert itself; Windows and
 * Linux want the full-colour mark.
 */
function trayIconSvg({monochrome = false} = {}) {
    const disc = monochrome ? '#000000' : '#1db954';
    const hole = monochrome ? 'none' : '#101010';
    return `
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <circle cx="32" cy="32" r="28" fill="${disc}"/>
  <circle cx="32" cy="32" r="18" fill="none" stroke="#ffffff" stroke-opacity="${monochrome ? 0.0 : 0.28}" stroke-width="3"/>
  <circle cx="32" cy="32" r="9" fill="${monochrome ? '#ffffff' : '#ffffff'}" fill-opacity="${monochrome ? 1 : 0.95}"/>
  <circle cx="32" cy="32" r="3.5" fill="${hole === 'none' ? '#000000' : hole}"/>
</svg>`;
}

/**
 * Windows thumbar buttons render at 16x16 (32x32 on hiDPI). Generating a large PNG and
 * letting Windows downscale produces a smudge, so each size is rasterised from vector.
 */
async function writeMediaIcons() {
    fs.mkdirSync(MEDIA_DIR, {recursive: true});

    const variants = {
        // Shown on a DARK taskbar, so the glyph must be light.
        dark: '#f2f2f2',
        // Shown on a LIGHT taskbar, so the glyph must be dark.
        light: '#1a1a1a',
    };

    for (const [variant, tone] of Object.entries(variants)) {
        const dir = path.join(MEDIA_DIR, variant);
        fs.mkdirSync(dir, {recursive: true});

        for (const name of Object.keys(MEDIA_GLYPHS)) {
            const svg = mediaGlyphSvg(name, tone);
            fs.writeFileSync(path.join(dir, `${name}.png`), await svgToPng(svg, 16));
            // Electron picks up the @2x sibling automatically on hiDPI displays.
            fs.writeFileSync(path.join(dir, `${name}@2x.png`), await svgToPng(svg, 32));
        }
    }
}

async function writeTrayIcons() {
    fs.mkdirSync(TRAY_DIR, {recursive: true});

    // Windows / Linux: full colour.
    fs.writeFileSync(path.join(TRAY_DIR, 'tray.png'), await svgToPng(trayIconSvg(), 32));
    fs.writeFileSync(path.join(TRAY_DIR, 'tray@2x.png'), await svgToPng(trayIconSvg(), 64));

    // Windows tray also accepts an .ico, which scales better in the overflow flyout.
    const trayPng = await svgToPng(trayIconSvg(), 256);
    const trayIco = png2icons.createICO(trayPng, png2icons.BILINEAR, 0, true, true);
    if (trayIco) fs.writeFileSync(path.join(TRAY_DIR, 'tray.ico'), trayIco);

    // macOS: the name MUST end in "Template" for the OS to treat it as a template
    // image and invert it for dark menu bars.
    const mono = trayIconSvg({monochrome: true});
    fs.writeFileSync(path.join(TRAY_DIR, 'trayTemplate.png'), await svgToPng(mono, 22));
    fs.writeFileSync(path.join(TRAY_DIR, 'trayTemplate@2x.png'), await svgToPng(mono, 44));
}

async function main() {
    fs.mkdirSync(FILETYPE_DIR, {recursive: true});

    console.log('[icons] Generating application icon...');
    await writeIconSet(appIconSvg(), OUTPUT_DIR, 'icon');
    await writeLinuxIconDir(appIconSvg(), path.join(OUTPUT_DIR, 'linux'));

    console.log('[icons] Generating file-association icons...');
    for (const type of FILE_TYPES) {
        await writeIconSet(fileTypeSvg(type), FILETYPE_DIR, type.ext);
        console.log(`[icons]   ${type.ext.padEnd(5)} ${type.hero ? '(distinct mp3 artwork)' : ''}`);
    }

    // Emit the manifest so package.json's fileAssociations and the renderer can both
    // read the same source of truth instead of duplicating the extension list.
    fs.writeFileSync(
        path.join(OUTPUT_DIR, 'filetypes.json'),
        JSON.stringify(FILE_TYPES, null, 2)
    );

    console.log('[icons] Generating taskbar media icons (light + dark)...');
    await writeMediaIcons();

    console.log('[icons] Generating tray icons...');
    await writeTrayIcons();

    console.log(`[icons] Done -> ${OUTPUT_DIR}`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error('[icons] Generation failed:', error);
        process.exit(1);
    });
}

module.exports = {FILE_TYPES, MEDIA_GLYPHS, appIconSvg, fileTypeSvg, mediaGlyphSvg, trayIconSvg};
