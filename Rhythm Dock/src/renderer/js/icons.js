'use strict';
// Shared local SVGs. Names and geometry are application-owned; no font or network required.
window.DockIcons = (() => {
    const paths = {
    "play": "M8 5 19 12 8 19Z",
    "pause": "M8 5v14M16 5v14",
    "previous": "M5 5v14M19 5 9 12l10 7Z",
    "next": "M19 5v14M5 5l10 7-10 7Z",
    "lock": "M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5ZM12 14v3",
    "unlock": "M7 10V7a5 5 0 0 1 9-3M5 10h14v11H5ZM12 14v3",
    "close": "m6 6 12 12M6 18 18 6",
    "minus": "M5 12h14",
    "plus": "M5 12h14M12 5v14",
    "up": "m5 12 7-7 7 7M12 5v14",
    "down": "m5 12 7 7 7-7M12 5v14",
    "chevron-left": "m15 5-7 7 7 7",
    "chevron-right": "m9 5 7 7-7 7",
    "external": "M14 3h7v7M21 3 10 14M10 3H3v18h18v-7",
    "queue": "M8 6h13M8 12h13M8 18h8M3 6h.01M3 12h.01M3 18h.01",
    "star": "m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z",
    "heart": "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z",
    "shuffle": "m17 3 4 4-4 4M3 17l5-5M14 7h7M3 7h4l10 10h4m-4-4 4 4-4 4",
    "repeat": "m17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4M21 13v3a2 2 0 0 1-2 2H3",
    "repeat-one": "m17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4M21 13v3a2 2 0 0 1-2 2H3M10 10l2-1v6",
    "volume": "M11 4 6 9H2v6h4l5 5ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14",
    "mute": "M11 4 6 9H2v6h4l5 5ZM17 9l6 6m0-6-6 6",
    "lyrics": "M4 3h16v18H4ZM8 7h8M8 11h8M8 15h5",
    "menu": "M12 5h.01M12 12h.01M12 19h.01",
    "file": "M14 2H4v20h16V8ZM14 2v6h6M8 13h8M8 17h5",
    "pin": "M9 3h6M9 3v6l-3 4v2h12v-2l-3-4V3M12 15v7",
    "folder": "M3 7V4h6l2 3h10v13H3Z",
    "copy": "M9 9h12v12H9ZM15 9V3H3v12h6",
    "clipboard": "M9 4H5v18h14V4h-4M9 2h6v5H9Z",
    "edit": "m16 3 5 5M3 21l5-1L21 7l-5-5L3 15Z",
    "delete": "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
    "eye": "M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
    "download": "M12 3v12m-5-5 5 5 5-5M3 16v5h18v-5",
    "refresh": "M20 7a9 9 0 0 0-15-2L2 8M2 2v6h6M4 17a9 9 0 0 0 15 2l3-3m0 6v-6h-6",
    "expand": "M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5",
    "layout": "M3 3h18v18H3ZM9 3v18",
    "info": "M12 11v6M12 7h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
    "settings": "M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6"
};
    function paint(svg, name) {
        if (!paths[name]) throw new Error(`Unknown icon: ${name}`);
        svg.classList.add('dock-icon');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', paths[name]);
        svg.replaceChildren(path);
        return svg;
    }
    function create(name) {
        return paint(document.createElementNS('http://www.w3.org/2000/svg', 'svg'), name);
    }
    function set(host, name) { if (host) host.replaceChildren(create(name)); }
    return {create, set, paint};
})();
