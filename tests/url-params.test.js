// tests/url-params.test.js - File names of models loaded from direct links (item 10 of the 1.6.6 plan)
// A model loaded from a Zenodo or Figshare link keeps its real name: from
// the URL where it carries one, else from the link's annotation file.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileNameFromUrl, modelFileNameFor } from '../js/core/url-params.js';

test('fileNameFromUrl: Zenodo, plain URLs with an extension, and URLs without a name', () => {
    assert.equal(fileNameFromUrl('https://zenodo.org/api/records/23190439/files/skyphos.glb/content'), 'skyphos.glb');
    assert.equal(fileNameFromUrl('https://zenodo.org/api/records/1/files/Skyphos%20Lehrsammlung%20%C3%BC.glb/content'), 'Skyphos Lehrsammlung ü.glb');
    assert.equal(fileNameFromUrl('https://zenodo.org/api/records/1/files/annotations.jsonld/content'), 'annotations.jsonld');
    assert.equal(fileNameFromUrl('https://example.org/data/wall%201.ply?download=1#x'), 'wall 1.ply');
    assert.equal(fileNameFromUrl('https://ndownloader.figshare.com/files/48123456'), null);
    assert.equal(fileNameFromUrl('https://repository.de.dariah.eu/1.0/dhcrud/21.11113/0000-000B-C8EF-7/data'), null);
    assert.equal(fileNameFromUrl(''), null);
    assert.equal(fileNameFromUrl(undefined), null);
});

test('modelFileNameFor: URL first, then the annotation file, then model.<format>', () => {
    const zenodo = 'https://zenodo.org/api/records/1/files/skyphos.glb/content';
    const figshare = 'https://ndownloader.figshare.com/files/48123456';
    assert.equal(modelFileNameFor({ modelUrl: zenodo, format: 'glb', storedName: 'other.glb' }), 'skyphos.glb');
    assert.equal(modelFileNameFor({ modelUrl: figshare, format: 'glb', storedName: 'skyphos.glb' }), 'skyphos.glb');
    assert.equal(modelFileNameFor({ modelUrl: figshare, format: 'glb', storedName: 'scene.gltf' }), 'scene.gltf');
    assert.equal(modelFileNameFor({ modelUrl: figshare, format: 'ply', storedName: 'wall.PLY' }), 'wall.PLY');
    // A stored name of another format is not taken.
    assert.equal(modelFileNameFor({ modelUrl: figshare, format: 'ply', storedName: 'skyphos.glb' }), 'model.ply');
    assert.equal(modelFileNameFor({ modelUrl: figshare, format: 'glb', storedName: null }), 'model.glb');
    assert.equal(modelFileNameFor({ modelUrl: figshare, format: 'stl', storedName: '  ' }), 'model.stl');
});
