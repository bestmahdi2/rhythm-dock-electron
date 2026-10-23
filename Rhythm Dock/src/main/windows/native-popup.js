"use strict";

// Native menus have their own OS surface, outside the renderer/window bounds.
function registerNativePopup({ipcMain, Menu, screen, getWindow}) {
    let active = null;
    ipcMain.handle('native-popup', (event, request) => {
        const window = getWindow();
        if (!window || window.isDestroyed() || event.sender !== window.webContents ||
            event.senderFrame !== window.webContents.mainFrame) return null;
        if (!request || !Array.isArray(request.items) || !request.items.length ||
            request.items.length > 10000) return null;
        active?.closePopup(window);
        const bounds = window.getContentBounds();
        const zoom = window.webContents.getZoomFactor();
        const coordinate = value => Number.isFinite(value) ? value : 0;
        // Menu.popup uses content-relative DIP coordinates, not screen coordinates.
        // Electron adds the window origin itself. Adding it here detached menus
        // from their buttons whenever the window moved away from (0, 0).
        const menuWidth = Math.min(420, Math.max(220,
            ...request.items.map(item => String(item?.label || '').length * 7 + 48)));
        const menuHeight = request.items.reduce((height, item) =>
            height + (item?.type === 'separator' ? 10 : 30), 12);
        const inset = 8;
        const anchor = {
            x: Math.round(Math.max(inset, Math.min(coordinate(request.x) * zoom,
                bounds.width - menuWidth - inset))),
            y: Math.round(Math.max(inset, Math.min(coordinate(request.y) * zoom,
                Math.max(inset, bounds.height - menuHeight - inset))))
        };
        const area = screen.getDisplayNearestPoint({x: bounds.x + anchor.x, y: bounds.y + anchor.y}).workArea;
        anchor.x = Math.round(Math.max(area.x, Math.min(bounds.x + anchor.x, area.x + area.width - 1)) - bounds.x);
        anchor.y = Math.round(Math.max(area.y, Math.min(bounds.y + anchor.y, area.y + area.height - 1)) - bounds.y);
        return new Promise(resolve => {
            let settled = false;
            const finish = value => { if (!settled) { settled = true; resolve(value); } };
            const template = request.items.map((item, index) => {
                if (item?.type === 'separator') return {type: 'separator'};
                return {
                    label: String(item?.label || ' ').slice(0, 1000).replace(/&/g, '&&'),
                    enabled: item?.enabled !== false,
                    ...(typeof item?.checked === 'boolean' ? {type: 'checkbox', checked: item.checked} : {}),
                    click: () => finish(index)
                };
            });
            const menu = Menu.buildFromTemplate(template);
            active = menu;
            const cleanup = () => {
                if (active === menu) active = null;
                window.removeListener('closed', close);
                window.removeListener('move', close);
                window.removeListener('resize', close);
            };
            const close = () => {
                if (!window.isDestroyed()) menu.closePopup(window);
                cleanup();
                finish(null);
            };
            window.once('closed', close);
            // Moving/resizing invalidates the anchor; reopen from the new location.
            window.once('move', close);
            window.once('resize', close);
            try {
                menu.popup({window, ...anchor, callback: () => {
                    cleanup();
                    finish(null);
                }});
            } catch (error) {
                cleanup();
                finish(null);
            }
        });
    });
}

module.exports = {registerNativePopup};
