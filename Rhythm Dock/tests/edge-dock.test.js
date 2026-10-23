'use strict';

const assert = require('node:assert/strict');
const {boundsFor, sideForPoint} = require('../src/main/windows/edge-dock');

const primary = {x: 0, y: 40, width: 1920, height: 1000};
assert.deepEqual(boundsFor('left', -100, primary), {x: 0, y: 40, width: 48, height: 420});
assert.deepEqual(boundsFor('right', 9000, primary, true),
    {x: 1700, y: 620, width: 220, height: 420});
assert.equal(sideForPoint(500, primary), 'left');
assert.equal(sideForPoint(1500, primary), 'right');

const secondary = {x: -1400, y: -180, width: 1400, height: 900};
assert.deepEqual(boundsFor('left', 10, secondary), {x: -1400, y: 10, width: 48, height: 420});
assert.deepEqual(boundsFor('right', -500, secondary, true),
    {x: -220, y: -180, width: 220, height: 420});
assert.deepEqual(boundsFor('right', 10, secondary, true, 340),
    {x: -340, y: 10, width: 340, height: 420});
assert.equal(sideForPoint(-1000, secondary), 'left');
assert.equal(sideForPoint(-100, secondary), 'right');
assert.equal(sideForPoint(900, primary, 55), 'top');
assert.equal(sideForPoint(-700, secondary, -170), 'top');
assert.deepEqual(boundsFor('top', 800, primary, false, 220, 1800),
    {x:1500,y:40,width:420,height:48});
assert.deepEqual(boundsFor('top', 0, secondary, true, 340, -100),
    {x:-340,y:-180,width:340,height:420});
assert.deepEqual(boundsFor('top', 0, {x:0,y:0,width:300,height:200}, false, 220, -50),
    {x:0,y:0,width:300,height:48});

console.log('PASS: edge dock stays on either wall and within both display work areas');
