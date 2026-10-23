#!/usr/bin/env node
'use strict';

/**
 * Generates every icon electron-builder needs, for every platform, from code.
 *
 * Why generate instead of committing binaries:
 *   - We need 19 file-association icons x 3 formats (.ico/.icns/.png). That is 57
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
 * Each extension has its own palette, symbol and readable extension badge.
 */
const FILE_TYPES = [
    {ext: 'mp3', label: 'MP3', from: '#1db954', to: '#0a5c28', hero: true, mime: 'audio/mpeg'},
    {ext: 'm4a', label: 'M4A', from: '#8b5cf6', to: '#5723a0', mime: 'audio/mp4'},
    {ext: 'm4b', label: 'M4B', from: '#f59e0b', to: '#a64b06', mime: 'audio/mp4'},
    {ext: 'flac', label: 'FLAC', from: '#06b6d4', to: '#086882', mime: 'audio/flac'},
    {ext: 'wav', label: 'WAV', from: '#3b82f6', to: '#1d409d', mime: 'audio/wav'},
    {ext: 'ogg', label: 'OGG', from: '#84b82a', to: '#466619', mime: 'audio/ogg'},
    {ext: 'opus', label: 'OPUS', from: '#ed649c', to: '#a32262', mime: 'audio/opus'},
    {ext: 'aac', label: 'AAC', from: '#fb713c', to: '#a93416', mime: 'audio/aac'},
    {ext: 'wma', label: 'WMA', from: '#6366f1', to: '#36369d', mime: 'audio/x-ms-wma'},
    {ext: 'aiff', label: 'AIFF', from: '#14b8a6', to: '#07665b', mime: 'audio/aiff'},
    {ext: 'mp4', label: 'MP4', from: '#ef4444', to: '#991b35', mime: 'video/mp4'},
    {ext: 'ape', label: 'APE', from: '#ba8a4d', to: '#735022', mime: 'audio/x-ape'},
    {ext: 'wv', label: 'WV', from: '#24a89a', to: '#19504e', mime: 'audio/x-wavpack'},
    {ext: 'dsf', label: 'DSF', from: '#c3a33b', to: '#786019', mime: 'audio/x-dsf'},
    {ext: 'dff', label: 'DFF', from: '#b967d2', to: '#713285', mime: 'audio/x-dff'},
    {ext: 'mod', label: 'MOD', from: '#87934a', to: '#4b5427', mime: 'audio/x-mod'},
    {ext: 'xm', label: 'XM', from: '#d75e84', to: '#822547', mime: 'audio/x-xm'},
    {ext: 'it', label: 'IT', from: '#7993b2', to: '#3c506c', mime: 'audio/x-it'},
    {ext: 's3m', label: 'S3M', from: '#c77b5b', to: '#783c29', mime: 'audio/x-s3m'},
];

const FORMAT_MARKS = {
    m4a:'<path d="M9 17V5l11-2v12M9 8l11-2"/><ellipse cx="6" cy="17" rx="3" ry="2"/><ellipse cx="17" cy="15" rx="3" ry="2"/>',
    m4b:'<path d="M12 6C8 3 4 4 2 5v15c3-2 6-2 10 0 4-2 7-2 10 0V5c-3-1-6-2-10 1v14M5 9h4M5 13h4M15 9h4M15 13h4"/>',
    flac:'<path d="M12 2l8 5v10l-8 5-8-5V7zM4 7l8 5 8-5M12 12v10M8 5l8 5"/>',
    wav:'<path d="M2 12h3l3-8 4 16 4-16 3 8h3"/>',
    ogg:'<path d="M3 12a9 9 0 0 1 18 0v7h-5v-8h5M3 11h5v8H3z"/>',
    opus:'<path d="M9 4l7 3v7M9 4v13"/><circle cx="6" cy="17" r="3"/><path d="M18 4l3 3-3 3M18 14l3 3-3 3"/>',
    aac:'<path d="M4 5l7 7-7 7V5zM13 5l7 7-7 7V5z"/>',
    wma:'<path d="M3 4h8v7H3zM14 4h7v7h-7zM3 14h8v7H3zM14 14h7v7h-7z"/>',
    aiff:'<path d="M5 19V5M12 19V5M19 19V5M2 8h6M9 15h6M16 10h6"/>',
    mp4:'<rect x="2" y="4" width="20" height="16" rx="3"/><path d="M10 8l6 4-6 4z"/>',
    ape:'<path d="M12 2l9 4v6c0 5-4 8-9 10-5-2-9-5-9-10V6zM7 12l3 3 7-7"/>',
    wv:'<path d="M2 9l4 7 4-10 4 10 4-10 4 7M2 21h20"/>',
    dsf:'<path d="M2 16h4V8h4v8h4V8h4v8h4"/><circle cx="4" cy="3" r="1"/><circle cx="12" cy="3" r="1"/><circle cx="20" cy="3" r="1"/>',
    dff:'<circle cx="12" cy="12" r="9"/><path d="M5 12h4V8h6v8h4M12 1v3M12 20v3"/>',
    mod:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18M15 3v18M3 15h18"/>',
    xm:'<path d="M4 3v18M10 3v18M16 3v18M22 3v18M2 7h6M8 12h6M14 17h6M20 6h4"/>',
    it:'<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 1v3M16 1v3M8 20v3M16 20v3M1 8h3M20 8h3M1 16h3M20 16h3M9 9h6v6H9z"/>',
    s3m:'<path d="M2 19V9h4v10M10 19V3h4v16M18 19v-7h4v7M1 22h22"/>',
};
function formatMark(type) {
    if(type.hero)return vinylMark();
    return `<g transform="translate(256 240) scale(21.3)" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">${FORMAT_MARKS[type.ext]}</g>`;
}

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
    if(size<=48)return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
        <rect x="2" y="2" width="60" height="60" rx="10" fill="${type.to}"/>
        <path d="M12 2h40a10 10 0 0 1 10 10v25H2V12A10 10 0 0 1 12 2" fill="${type.from}"/>
        <g transform="translate(0 -8) scale(.0625)">${formatMark(type)}</g>
        <text x="32" y="55" text-anchor="middle" font-family="DejaVu Sans, Verdana, sans-serif" font-weight="bold" font-size="${type.label.length>3?17:20}" fill="white">${type.label}</text></svg>`;
    const badgeWidth = 650;
    const badgeX = (1024 - badgeWidth) / 2;
    const fontSize = type.label.length > 3 ? 150 : 172;

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

  <!-- Each format has a distinct symbol as well as its color and label. -->
  ${formatMark(type)}

  <!-- Extension badge. -->
  <rect x="${badgeX}" y="714" width="${badgeWidth}" height="206" rx="32"
        fill="#000000" fill-opacity="${type.hero ? 0.42 : 0.34}"/>
  <text x="512" y="866"
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
async function writeIconSet(svg, outputDir, basename, type = null) {
    fs.mkdirSync(outputDir, {recursive: true});

    const png1024 = await svgToPng(svg, 1024);
    const pngPath = path.join(outputDir, `${basename}.png`);
    fs.writeFileSync(pngPath, png1024);

    const ico = type ? await fileTypeIco(type) : png2icons.createICO(png1024, png2icons.BILINEAR, 0, true, true);
    if (!ico) throw new Error(`Failed to build ICO for ${basename}`);
    fs.writeFileSync(path.join(outputDir, `${basename}.ico`), ico);

    const icns = png2icons.createICNS(png1024, png2icons.BILINEAR, 0);
    if (!icns) throw new Error(`Failed to build ICNS for ${basename}`);
    fs.writeFileSync(path.join(outputDir, `${basename}.icns`), icns);

    return pngPath;
}

async function fileTypeIco(type) {
    const sizes=[16,24,32,48,64,128,256];
    const frames=await Promise.all(sizes.map(size=>svgToPng(fileTypeSvg(type,size),size)));
    const header=Buffer.alloc(6+sizes.length*16);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);
    let offset=header.length;
    frames.forEach((frame,index)=>{
        const at=6+index*16,size=sizes[index];header[at]=size===256?0:size;header[at+1]=header[at];
        header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);
        header.writeUInt32LE(frame.length,at+8);header.writeUInt32LE(offset,at+12);offset+=frame.length;
    });
    return Buffer.concat([header,...frames]);
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
        await writeIconSet(fileTypeSvg(type), FILETYPE_DIR, type.ext, type);
        for(const size of [16,24,32,48,64,128,256]){
            const dir=path.join(OUTPUT_DIR,'mimetypes',`${size}x${size}`);fs.mkdirSync(dir,{recursive:true});
            fs.writeFileSync(path.join(dir,`audio-x-rhythmdock-${type.ext}.png`),await svgToPng(fileTypeSvg(type,size),size));
        }
        console.log(`[icons]   ${type.ext.padEnd(5)} ${type.hero ? '(distinct mp3 artwork)' : ''}`);
    }

    // Emit the manifest so package.json's fileAssociations and the renderer can both
    // read the same source of truth instead of duplicating the extension list.
    fs.writeFileSync(
        path.join(OUTPUT_DIR, 'filetypes.json'),
        JSON.stringify(FILE_TYPES, null, 2)
    );
    fs.writeFileSync(path.join(OUTPUT_DIR,'rhythmdock-mimetypes.xml'),`<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">${FILE_TYPES.map(type=>`
<mime-type type="audio/x-rhythmdock-${type.ext}"><comment>${type.label} — Rhythm Dock</comment><sub-class-of type="${type.mime}"/><glob pattern="*.${type.ext}" weight="60"/><icon name="audio-x-rhythmdock-${type.ext}"/></mime-type>`).join('')}
</mime-info>`);

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

module.exports = {FILE_TYPES, MEDIA_GLYPHS, appIconSvg, fileTypeSvg, fileTypeIco, mediaGlyphSvg, trayIconSvg};
