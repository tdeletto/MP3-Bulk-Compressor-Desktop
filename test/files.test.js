'use strict';
// File naming, scanning and verified writes. Mirrors StorageRulesTest.kt plus desktop-only scanning.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  uniqueChild, isCandidate, shrunkName, scanPaths, writeVerifiedSibling, formatBytes,
} = require('../src/core/files');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mp3bulk-files-'));
const touch = (p, content = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };

test('uniqueChild never reuses a taken name', () => {
  const dir = tmpDir();
  assert.equal(path.basename(uniqueChild(dir, 'song - SHRUNK.mp3')), 'song - SHRUNK.mp3');
  touch(path.join(dir, 'song - SHRUNK.mp3'));
  assert.equal(path.basename(uniqueChild(dir, 'song - SHRUNK.mp3')), 'song - SHRUNK (1).mp3');
  touch(path.join(dir, 'song - SHRUNK (1).mp3'));
  assert.equal(path.basename(uniqueChild(dir, 'song - SHRUNK.mp3')), 'song - SHRUNK (2).mp3');
});

test('uniqueChild without an extension', () => {
  const dir = tmpDir();
  touch(path.join(dir, 'notes'));
  assert.equal(path.basename(uniqueChild(dir, 'notes')), 'notes (1)');
});

test('outputs and hidden files are not candidates', () => {
  assert.ok(isCandidate('song.mp3'));
  assert.ok(!isCandidate('song - SHRUNK.mp3'));
  assert.ok(!isCandidate('song - shrunk.MP3'));
  assert.ok(!isCandidate('.hidden.mp3'));
  assert.equal(shrunkName('My Song.mp3'), 'My Song - SHRUNK.mp3');
  assert.equal(shrunkName('odd.name.MP3'), 'odd.name - SHRUNK.mp3');
});

test('scan honours the subfolder switch and skips outputs', async () => {
  const dir = tmpDir();
  touch(path.join(dir, 'b.mp3'));
  touch(path.join(dir, 'A.MP3'));
  touch(path.join(dir, 'a - SHRUNK.mp3'));
  touch(path.join(dir, 'cover.jpg'));
  touch(path.join(dir, '.secret.mp3'));
  touch(path.join(dir, 'Sub', 'deep.mp3'));
  touch(path.join(dir, '.git', 'ignored.mp3'));

  const flat = await scanPaths([dir], false);
  assert.deepEqual(flat.map((f) => f.name), ['A.MP3', 'b.mp3']);

  const tree = await scanPaths([dir], true);
  assert.deepEqual(tree.map((f) => `${f.relativeDir}|${f.name}`), ['|A.MP3', '|b.mp3', 'Sub|deep.mp3']);
});

test('explicitly chosen files are included, duplicates removed, non-MP3s ignored', async () => {
  const dir = tmpDir();
  const shrunk = path.join(dir, 'x - SHRUNK.mp3');
  touch(shrunk);
  touch(path.join(dir, 'notes.txt'));
  const r = await scanPaths([shrunk, shrunk, path.join(dir, 'notes.txt'), path.join(dir, 'missing.mp3')], false);
  assert.equal(r.length, 1);
  assert.equal(r[0].path, shrunk);
});

test('verified write never overwrites and copies every byte', async () => {
  const dir = tmpDir();
  const src = path.join(tmpDir(), 'src.bin');
  const data = Buffer.alloc(300_000).map((_, i) => (i * 31) & 0xff);
  fs.writeFileSync(src, data);
  touch(path.join(dir, 'out.mp3'), 'existing');

  const written = await writeVerifiedSibling(dir, 'out.mp3', src);
  assert.equal(path.basename(written), 'out (1).mp3');
  assert.deepEqual(fs.readFileSync(written), data);
  assert.equal(fs.readFileSync(path.join(dir, 'out.mp3'), 'utf8'), 'existing');
});

test('formatBytes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(3 * 1024 ** 3), '3.00 GB');
});
