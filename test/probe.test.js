'use strict';
// MP3 header parsing. Mirrors ProbeTest.kt; fixtures were made with the lame CLI and trimmed to 64 KB.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { probe, measureDurationUs } = require('../src/core/probe');

const fixture = (name) => path.join(__dirname, 'fixtures', 'probe', name);
const full = (name) => path.join(__dirname, 'fixtures', 'full', name);

test('CBR 320 with ID3', () => {
  const r = probe(fixture('cbr320_stereo_id3.mp3'));
  assert.ok(r.id3v2Size > 0);
  assert.equal(r.mode, 'CBR');
  assert.equal(r.headerKbps, 320);
  assert.equal(r.sampleRate, 44100);
  assert.equal(r.channels, 'JOINT'); // lame's default mode
});

test('CBR 192 full stereo', () => {
  const r = probe(fixture('cbr192_full_stereo.mp3'));
  assert.equal(r.mode, 'CBR');
  assert.equal(r.headerKbps, 192);
  assert.equal(r.channels, 'STEREO');
});

test('CBR 128 joint stereo', () => {
  const r = probe(fixture('cbr128_joint.mp3'));
  assert.equal(r.mode, 'CBR');
  assert.equal(r.headerKbps, 128);
  assert.equal(r.channels, 'JOINT');
});

test('VBR has a frame count', () => {
  const r = probe(fixture('vbr_v2_stereo.mp3'));
  assert.equal(r.mode, 'VBR');
  assert.ok(r.frameCount > 0);
  assert.ok(Math.abs(r.trustedDurationUs / 1e6 - 30) < 0.2); // 30 s at 44.1 kHz ≈ 1149 frames
});

test('ABR detected from the LAME tag', () => {
  const r = probe(fixture('abr160_48k.mp3'));
  assert.equal(r.mode, 'ABR');
  assert.equal(r.sampleRate, 48000);
});

test('mono CBR', () => {
  const r = probe(fixture('cbr64_mono.mp3'));
  assert.equal(r.mode, 'CBR');
  assert.equal(r.headerKbps, 64);
  assert.equal(r.channels, 'MONO');
});

test('MPEG-2 low sample rate', () => {
  const r = probe(fixture('cbr32_mono_22k.mp3'));
  assert.equal(r.sampleRate, 22050);
  assert.equal(r.headerKbps, 32);
  assert.equal(r.samplesPerFrame, 576);
  assert.ok(Math.abs(r.trustedDurationUs / 1e6 - 20) < 0.2);
});

test('garbage is rejected', () => {
  assert.equal(probe(fixture('garbage.mp3')).mode, null);
});

test('ID3v1 and ID3v2 are both found', () => {
  const r = probe(full('cbr320_joint_tags.mp3'));
  assert.ok(r.id3v2Size > 10);
  assert.equal(r.id3v1Size, 128);
});

test('untagged VBR is detected and its duration measured by walking frames', () => {
  const r = probe(full('vbr_v2_untagged.mp3'));
  assert.equal(r.mode, 'VBR');
  assert.equal(r.frameCount, 0);
  assert.equal(r.trustedDurationUs, 0);
  assert.ok(Math.abs(measureDurationUs(full('vbr_v2_untagged.mp3'), r) / 1e6 - 8) < 0.2);
});
