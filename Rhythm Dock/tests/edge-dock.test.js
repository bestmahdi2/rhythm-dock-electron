'use strict';

const assert = require('node:assert/strict');
const {boundsFor, sideForPoint} = require('../src/main/windows/edge-dock');

const primary = {x: 0, y: 40, width: 1920, height: 1000};
assert.deepEqual(boundsFor('left', -100, primary), {x: 0, y: 40, width: 48, height: 420});
assert.deepEqual(boundsFor('right', 9000, primary, true),
    {x: 1815, y: 620, width: 105, height: 420});
assert.equal(sideForPoint(500, primary), 'left');
assert.equal(sideForPoint(1500, primary), 'right');

const secondary = {x: -1400, y: -180, width: 1400, height: 900};
assert.deepEqual(boundsFor('left', 10, secondary), {x: -1400, y: 10, width: 48, height: 420});
assert.deepEqual(boundsFor('right', -500, secondary, true),
    {x: -105, y: -180, width: 105, height: 420});
assert.equal(sideForPoint(-1000, secondary), 'left');
assert.equal(sideForPoint(-100, secondary), 'right');

console.log('PASS: edge dock stays on either wall and within both display work areas');
