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
        const anchor = {
            x: Math.round(bounds.x + coordinate(request.x) * zoom),
            y: Math.round(bounds.y + coordinate(request.y) * zoom)
        };
        const area = screen.getDisplayNearestPoint(anchor).workArea;
        anchor.x = Math.max(area.x, Math.min(anchor.x, area.x + area.width - 1));
        anchor.y = Math.max(area.y, Math.min(anchor.y, area.y + area.height - 1));
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
