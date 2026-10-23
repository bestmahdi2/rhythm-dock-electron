'use strict';

const COLLAPSED_WIDTH = 48;
const EXPANDED_WIDTH = 220;
const HEIGHT = 420;

function sideForPoint(x, workArea, y = Infinity) {
    if (Math.abs(y - workArea.y) < Math.min(Math.abs(x - workArea.x), Math.abs(workArea.x + workArea.width - x))) return 'top';
    return x < workArea.x + workArea.width / 2 ? 'left' : 'right';
}

function boundsFor(side, y, workArea, expanded = false, panelWidth = EXPANDED_WIDTH, x = workArea.x) {
    if (side === 'top') {
        const width = Math.min(expanded ? panelWidth : HEIGHT, workArea.width);
        return {x: Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, x)),
            y: workArea.y, width, height: Math.min(expanded ? HEIGHT : COLLAPSED_WIDTH, workArea.height)};
    }
    const width = Math.min(expanded ? panelWidth : COLLAPSED_WIDTH, workArea.width);
    const height = Math.min(HEIGHT, workArea.height);
    return {
        x: side === 'left' ? workArea.x : workArea.x + workArea.width - width,
        y: Math.max(workArea.y, Math.min(workArea.y + workArea.height - height, y)),
        width, height,
    };
}

module.exports = {COLLAPSED_WIDTH, EXPANDED_WIDTH, HEIGHT, sideForPoint, boundsFor};
