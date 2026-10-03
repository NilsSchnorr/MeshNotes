// tests/coords.test.js - The pure coordinate helpers load in Node without Three.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wktNum, wktPointZ, parsePointZ, parseWKT, pointToZUp, pointFromZUp } from '../js/utils/coords.js';

test('Y-up and Z-up conversions are inverse', () => {
    const p = { x: 1.5, y: -2.25, z: 3 };
    assert.deepEqual(pointToZUp(p), { x: 1.5, y: -3, z: -2.25 });
    assert.deepEqual(pointFromZUp(pointToZUp(p)), p);
});

test('wktNum trims zeros and never uses exponents', () => {
    assert.equal(wktNum(1.5), '1.5');
    assert.equal(wktNum(2), '2');
    assert.equal(wktNum(-0.0000001), '0');
    assert.equal(wktNum(1e-7), '0');
    assert.equal(wktNum(NaN), '0');
    assert.equal(wktNum(1234567.1234567), '1234567.123457');
});

test('WKT point round-trips', () => {
    const wkt = wktPointZ({ x: -8.412, y: 3.115, z: -1.204 });
    assert.equal(wkt, 'POINT Z (-8.412 3.115 -1.204)');
    assert.deepEqual(parsePointZ(wkt), { x: -8.412, y: 3.115, z: -1.204 });
    assert.deepEqual(parsePointZ('<http://www.opengis.net/def/crs/EPSG/0/4978> POINT Z (1 2 3)'), { x: 1, y: 2, z: 3 });
    assert.equal(parsePointZ('POINT (1 2)'), null);
});

test('parseWKT reads lines and drops the closing polygon vertex', () => {
    assert.deepEqual(parseWKT('LINESTRING Z (0 0 0, 1 2 3)'), {
        type: 'line', points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 3 }]
    });
    const poly = parseWKT('POLYGON Z ((0 0 0, 1 0 0, 1 1 0, 0 0 0))');
    assert.equal(poly.type, 'polygon');
    assert.equal(poly.points.length, 3);
    assert.equal(parseWKT('CIRCLE (1 2 3)'), null);
});
