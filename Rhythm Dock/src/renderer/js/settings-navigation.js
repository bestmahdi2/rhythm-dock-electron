'use strict';

// Move the original controls, never clone them: listeners, values, timers and
// asynchronous device/library updates continue to target the same elements.
window.RhythmSettings = (() => {
    const groups = [
        ['appearance', 'Appearance & layout', 'palette', 'Themes, opacity, window presets'],
        ['audio', 'Audio & equalizer', 'settings', 'Outputs, processing, gain and EQ'],
        ['playback', 'Playback & timer', 'play', 'Interruptions, queue behavior and sleep'],
        ['library', 'Library & files', 'folder', 'Source folders, scans, backup and tags'],
        ['lyrics', 'Lyrics & translation', 'lyrics', 'Typography, sources and translation'],
        ['sharing', 'Listen together', 'users', 'Rooms, shared control and Telegram'],
        ['shortcuts', 'Keyboard & mouse', 'keyboard', 'Playback, speed, lyrics and window controls'],
        ['tools', 'Tools & support', 'wrench', 'Media tools, accounts, preferences and logs'],
    ];

    function install({isLocked, openTool}) {
        const panel = document.getElementById('tab-settings');
        const scroll = panel.querySelector(':scope > .settings-scroll');
        const heading = panel.querySelector(':scope > .panel-head .panel-title');
        const element = (tag, className, text) => {
            const node = document.createElement(tag);
            if (className) node.className = className;
            if (text) node.textContent = text;
            return node;
        };
        const originalControls = new Set(panel.querySelectorAll('input, select, button'));
        const home = element('nav', 'settings-home');
        home.setAttribute('aria-label', 'Settings categories');
        const pages = new Map();
        const entries = new Map();
        let active = 'home';
        const scrollPositions = new Map();
        const back = element('button', 'settings-button settings-category-back', 'Settings');
        back.type = 'button';
        back.prepend(window.DockIcons.create('chevron-left'));
        back.hidden = true;
        panel.querySelector(':scope > .panel-head').prepend(back);
        scroll.prepend(home);

        for (const [id, title, icon, subtitle] of groups) {
            const page = element('section', 'settings-category-page');
            page.dataset.settingsCategory = id;
            page.id = `settings-category-${id}`;
            page.setAttribute('aria-label', title);
            page.hidden = true;
            pages.set(id, page);
            scroll.append(page);
            const entry = element('button', 'settings-category-entry');
            entry.type = 'button';
            entry.dataset.settingsCategoryOpen = id;
            entry.setAttribute('aria-controls', page.id);
            const mark = element('span', 'settings-category-icon');
            mark.append(window.DockIcons.create(icon));
            const copy = element('span', 'settings-category-copy');
            copy.append(element('span', 'settings-category-name', title), element('small', null, subtitle));
            entry.append(mark, copy, window.DockIcons.create('chevron-right'));
            entry.addEventListener('click', () => show(id));
            home.append(entry);
            entries.set(id, entry);
        }

        function show(id, {focus = true} = {}) {
            if (isLocked() || (id !== 'home' && !pages.has(id))) return;
            scrollPositions.set(active, scroll.scrollTop);
            const previous = active;
            active = id;
            panel.dataset.settingsCategory = id;
            home.hidden = id !== 'home';
            for (const [key, page] of pages) page.hidden = key !== id;
            back.hidden = id === 'home';
            heading.textContent = id === 'home' ? 'Settings' : groups.find(group => group[0] === id)[1];
            scroll.scrollTop = scrollPositions.get(id) || 0;
            if (focus) {
                const target = id === 'home' ? entries.get(previous) || home.querySelector('button') : back;
                target?.focus({preventScroll: true});
            }
        }
        back.addEventListener('click', () => show('home'));

        function section(category, title, nodes, open = false) {
            const details = element('details', 'settings-category-section');
            details.open = open;
            details.append(element('summary', null, title));
            const content = element('div', 'settings-category-content');
            for (const node of nodes) if (node) content.append(node);
            details.append(content);
            pages.get(category).append(details);
            return content;
        }
        const claimed = new Set();
        function take(controlId) {
            const block = document.getElementById(controlId)?.closest('.settings-block');
            if (!block || claimed.has(block)) return null;
            claimed.add(block);
            return block;
        }
        section('appearance', 'Appearance', [take('theme-grid')], true);
        const appearanceTools = section('appearance', 'Layout & personalization', []);
        const audio = section('audio', 'Output & processing', [take('output-device')], true);
        section('audio', 'Equalizer', [take('eq-enabled')]);
        const audioAdvanced = section('audio', 'Advanced audio', []);
        section('playback', 'Playback behavior & discovery', [take('pause-on-unplug')], true);
        section('playback', 'Sleep timer', [take('timer-readout')]);
        section('library', 'Music source folders', [take('library-roots')], true);
        const integration = section('library', 'File integration', []);
        const libraryTools = section('library', 'Library tools', []);
        const lyrics = section('lyrics', 'Typography & sources', [take('lyrics-font-size')], true);
        section('lyrics', 'Translation', [take('translate-language')]);
        section('sharing', 'Host, join & manage rooms', [take('room-status')], true);
        section('shortcuts', 'Keyboard & mouse guide', [take('shortcuts-list')], true);
        section('tools', 'Media tools', [take('ffmpeg-pick')], true);
        const tools = section('tools', 'More tools', []);
        const support = section('tools', 'Preferences & diagnostics', []);

        // Separate these actions from the long Playback block without replacing
        // any input or handler. The relevant hints travel with their controls.
        audio.append(document.getElementById('volume-boost-btn'));
        lyrics.append(document.getElementById('lyrics-controls-setting'));
        const removeMenu = document.getElementById('remove-file-menu');
        const menuHint = removeMenu.nextElementSibling;
        integration.append(document.getElementById('install-file-menu'), removeMenu);
        if (menuHint?.classList.contains('settings-hint')) integration.append(menuHint);
        support.append(document.getElementById('diagnostics-export'));

        const destinations = {Library:libraryTools, Appearance:appearanceTools, Layouts:appearanceTools,
            Files:libraryTools, Practice:tools, Editor:tools, Broadcasts:tools, Accounts:tools, Settings:support};
        const card = document.getElementById('roadmap-tools-card');
        for (const button of Array.from(card.querySelectorAll('[data-settings-page]'))) {
            (destinations[button.dataset.settingsPage] || tools).append(button);
        }
        card.hidden = true;
        const advanced = element('button', 'settings-button', 'Parametric EQ & audio visualization');
        advanced.type = 'button';
        advanced.addEventListener('click', () => { if (!isLocked()) openTool('Appearance'); });
        audioAdvanced.append(advanced);
        const setup = element('button', 'settings-button', 'Getting started');
        setup.type = 'button';
        setup.addEventListener('click', () => { if (!isLocked()) openTool('Setup'); });
        tools.append(setup);

        // Future core sections stay reachable even if their category has not
        // been assigned yet; no new setting can silently disappear.
        for (const block of Array.from(scroll.querySelectorAll(':scope > .settings-block'))) {
            if (block !== card) section('tools', block.querySelector('.settings-title')?.textContent.trim() || 'More settings', [block]);
        }
        for (const control of originalControls) {
            if (!panel.contains(control)) throw new Error(`Settings control detached: ${control.id}`);
        }
        panel.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || active === 'home' || panel.classList.contains('settings-detail-open')) return;
            // The first Escape closes an open native/DOM popup through its own
            // handler; a subsequent Escape returns from the category.
            if (document.querySelector('.dropdown-menu.show')) return;
            event.preventDefault();
            event.stopPropagation();
            show('home');
        });
        panel.dataset.settingsCategory = 'home';
        return {home: options => show('home', options), show, get active() { return active; }};
    }
    return {install};
})();
