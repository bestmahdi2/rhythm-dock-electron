'use strict';

const COLLAPSED_WIDTH = 48;
const EXPANDED_WIDTH = 220;
const HEIGHT = 420;

function sideForPoint(x, workArea) {
    return x < workArea.x + workArea.width / 2 ? 'left' : 'right';
}

function boundsFor(side, y, workArea, expanded = false, panelWidth = EXPANDED_WIDTH) {
    const width = Math.min(expanded ? panelWidth : COLLAPSED_WIDTH, workArea.width);
    const height = Math.min(HEIGHT, workArea.height);
    return {
        x: side === 'left' ? workArea.x : workArea.x + workArea.width - width,
        y: Math.max(workArea.y, Math.min(workArea.y + workArea.height - height, y)),
        width, height,
    };
}

module.exports = {COLLAPSED_WIDTH, EXPANDED_WIDTH, HEIGHT, sideForPoint, boundsFor};
