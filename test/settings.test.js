'use strict';
// Encode planning rules. Mirrors PlanTest.kt from the Android app so both apps behave the same.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  planFor, defaultSettings, PRESETS, V0_KBPS, matchingPreset, sanitizeSettings, kHz, planSummary, settingsSummary,
} = require('../src/core/settings');

const preset = (id) => PRESETS.find((p) => p.id === id).settings;
const src = (mode, kbps, sampleRate, channels) => ({ mode, kbps, sampleRate, channels, durationUs: 60e6 });
const settings = (overrides) => ({ ...defaultSettings(), ...overrides });

const stereo320 = src('CBR', 320, 44100, 'JOINT');
const mono64 = src('CBR', 64, 44100, 'MONO');
const lowMono = src('CBR', 32, 22050, 'MONO');
const vbr190 = src('VBR', 190, 44100, 'JOINT');

test('defaults leave every file unchanged', () => {
  for (const s of [stereo320, mono64, lowMono, vbr190]) assert.equal(planFor(defaultSettings(), s), null);
});

test('Podcast preset on stereo 320', () => {
  const p = planFor(preset('PODCAST'), stereo320);
  assert.equal(p.mode, 'VBR');
  assert.equal(p.kbps, 64);
  assert.equal(p.sampleRate, 44100);
  assert.equal(p.channels, 'MONO');
  assert.ok(p.highPass && p.lowPass);
  assert.equal(p.keptSourceBitrate, false);
});

test('HQ Music preset on stereo 320', () => {
  const p = planFor(preset('HQ_MUSIC'), stereo320);
  assert.equal(p.mode, 'VBR');
  assert.equal(p.kbps, V0_KBPS);
  assert.equal(p.channels, 'STEREO');
  assert.ok(!p.highPass && !p.lowPass);
});

test('lower-bitrate source keeps its bitrate', () => {
  const p = planFor(settings({ kbps: 128, channels: 'MONO' }), { ...vbr190, kbps: 96 });
  assert.equal(p.kbps, 96);
  assert.equal(p.keptSourceBitrate, true);
});

test('bitrate is never raised even when other settings change', () => {
  const p = planFor(preset('HQ_MUSIC'), vbr190);
  assert.equal(p.kbps, 190);
  assert.equal(p.keptSourceBitrate, true);
});

test('only a lower bitrate with nothing else to change is skipped', () => {
  assert.equal(planFor(settings({ kbps: 128 }), mono64), null);
});

test('mono never becomes stereo', () => {
  assert.equal(planFor(settings({ kbps: 32, channels: 'STEREO' }), mono64).channels, 'MONO');
});

test('never upsamples', () => {
  assert.equal(planFor(settings({ sampleRate: 44100 }), lowMono), null);
  assert.equal(planFor(settings({ sampleRate: 48000, kbps: 16 }), { ...lowMono, kbps: 64 }).sampleRate, 22050);
});

test('Keep mode uses the source mode', () => {
  const p = planFor(settings({ kbps: 128 }), vbr190);
  assert.equal(p.mode, 'VBR');
  assert.equal(p.kbps, 128);
});

test('CBR snaps to a legal bitrate for the sample rate', () => {
  const p = planFor(settings({ mode: 'CBR', kbps: 320, sampleRate: 22050 }), stereo320);
  assert.equal(p.sampleRate, 22050);
  assert.equal(p.kbps, 160); // MPEG-2 tops out at 160 kbps
  assert.equal(planFor(settings({ mode: 'CBR', kbps: 128, sampleRate: 8000 }), stereo320).kbps, 64); // MPEG-2.5: 64
});

test('filters alone count as a change', () => {
  const p = planFor(settings({ highPass: true }), mono64);
  assert.equal(p.kbps, 64);
  assert.equal(p.mode, 'CBR');
});

test('preset matching', () => {
  assert.equal(matchingPreset(defaultSettings()), 'ORIGINAL');
  assert.equal(matchingPreset(preset('PODCAST')), 'PODCAST');
  assert.equal(matchingPreset({ ...preset('PODCAST'), kbps: 96 }), 'CUSTOM');
});

test('untrusted settings are sanitised', () => {
  assert.deepEqual(sanitizeSettings(null), defaultSettings());
  assert.deepEqual(sanitizeSettings({ mode: 'LOUD', kbps: 999, sampleRate: 1, highPass: 'yes', channels: 'SURROUND' }), defaultSettings());
  assert.deepEqual(sanitizeSettings(preset('PODCAST')), preset('PODCAST'));
});

test('labels and summaries', () => {
  assert.equal(kHz(44100), '44.1 kHz');
  assert.equal(kHz(22050), '22.05 kHz');
  assert.equal(kHz(8000), '8 kHz');
  assert.equal(planSummary(planFor(preset('PODCAST'), stereo320)), 'VBR 64 kbps · 44.1 kHz · mono · HP · LP');
  assert.equal(settingsSummary(preset('PODCAST')), 'VBR • 64 kbps • 44,100 Hz • Mono • HP 80 Hz • LP 15 kHz');
});
