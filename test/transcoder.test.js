'use strict';
/**
 * End-to-end pipeline tests against the real native engine (build it first: npm run build:engine).
 * Every test works on copies of test/fixtures/full in a temp folder.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Transcoder, defaultEnginePath, runEngine } = require('../src/core/transcoder');
const { BatchRunner, summarize } = require('../src/core/batch');
const { probe } = require('../src/core/probe');
const { scanPaths } = require('../src/core/files');
const { PRESETS, defaultSettings } = require('../src/core/settings');

const FULL = path.join(__dirname, 'fixtures', 'full');
const preset = (id) => PRESETS.find((p) => p.id === id).settings;
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

if (!fs.existsSync(defaultEnginePath())) {
  throw new Error(`Engine not built (${defaultEnginePath()}). Run: npm run build:engine`);
}

/** Copies fixtures into a fresh folder and returns Mp3File entries for them. */
function workspace(...names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3bulk-e2e-'));
  return {
    dir,
    files: names.map((name) => {
      const [srcName, destName = srcName] = Array.isArray(name) ? name : [name];
      const dest = path.join(dir, destName);
      fs.copyFileSync(path.join(FULL, srcName), dest);
      return { path: dest, name: destName, size: fs.statSync(dest).size, relativeDir: '' };
    }),
  };
}

/** A stand-in for shell.trashItem that moves files into a folder we can inspect. */
function fakeTrash() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3bulk-trash-'));
  return { dir, trashItem: async (p) => fs.renameSync(p, path.join(dir, path.basename(p))) };
}

const tempLeftovers = (tempDir) => fs.readdirSync(tempDir).filter((n) => n.startsWith('mp3bulk-') && n.endsWith('.mp3'));

test('Podcast preset: smaller mono VBR copy, tags copied byte for byte, original untouched', async () => {
  const { dir, files: [file] } = workspace('cbr320_joint_tags.mp3');
  const before = sha(file.path);
  const progress = [];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3bulk-tmp-'));
  const t = new Transcoder({ tempDir });

  const o = await t.process(file, preset('PODCAST'), false, (f) => progress.push(f));

  assert.equal(o.type, 'done', o.message);
  assert.equal(o.status, 'COPY');
  assert.equal(o.outputName, 'cbr320_joint_tags - SHRUNK.mp3');
  assert.ok(o.newSize < o.oldSize / 3, `${o.newSize} should be far below ${o.oldSize}`);
  assert.equal(sha(file.path), before, 'original must be unchanged');
  assert.ok(progress.length > 3 && progress.at(-1) >= 0.95);
  assert.deepEqual(tempLeftovers(tempDir), []);

  const out = probe(o.outputPath);
  assert.equal(out.mode, 'VBR');
  assert.equal(out.channels, 'MONO');
  assert.equal(out.sampleRate, 44100);
  assert.ok(Math.abs(out.trustedDurationUs / 1e6 - 8) < 0.2, 'Xing header should declare the real length');

  const src = fs.readFileSync(file.path);
  const dst = fs.readFileSync(o.outputPath);
  const srcProbe = probe(file.path);
  assert.deepEqual(dst.subarray(0, out.id3v2Size), src.subarray(0, srcProbe.id3v2Size), 'ID3v2 identical');
  assert.deepEqual(dst.subarray(dst.length - 128), src.subarray(src.length - 128), 'ID3v1 identical');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['cbr320_joint_tags - SHRUNK.mp3', 'cbr320_joint_tags.mp3']);
});

test('replace: original goes to the Trash and the new file takes its name', async () => {
  const { dir, files: [file] } = workspace('vbr_v2_stereo.mp3');
  const originalBytes = fs.readFileSync(file.path);
  const trash = fakeTrash();
  const t = new Transcoder({ trashItem: trash.trashItem });

  const o = await t.process(file, preset('PODCAST'), true);

  assert.equal(o.type, 'done', o.message);
  assert.equal(o.status, 'REPLACED');
  assert.equal(o.outputPath, file.path);
  assert.deepEqual(fs.readdirSync(dir), ['vbr_v2_stereo.mp3']);
  assert.equal(probe(file.path).channels, 'MONO');
  assert.deepEqual(fs.readFileSync(path.join(trash.dir, 'vbr_v2_stereo.mp3')), originalBytes, 'original is recoverable');
});

test('replace: if the Trash refuses, both files are kept', async () => {
  const { dir, files: [file] } = workspace('vbr_v2_stereo.mp3');
  const t = new Transcoder({ trashItem: async () => { throw new Error('permission denied'); } });

  const o = await t.process(file, preset('PODCAST'), true);

  assert.equal(o.status, 'KEPT_BOTH');
  assert.match(o.note, /permission denied/);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['vbr_v2_stereo - SHRUNK.mp3', 'vbr_v2_stereo.mp3']);
});

test('CBR with resampling snaps to a legal MPEG-2 bitrate', async () => {
  const { files: [file] } = workspace('cbr320_joint_tags.mp3');
  const o = await new Transcoder().process(file, { ...defaultSettings(), mode: 'CBR', kbps: 320, sampleRate: 22050 }, false);
  assert.equal(o.type, 'done', o.message);
  const out = probe(o.outputPath);
  assert.equal(out.mode, 'CBR');
  assert.equal(out.sampleRate, 22050);
  assert.equal(out.headerKbps, 160);
  assert.equal(out.channels, 'JOINT');
});

test('ABR and full stereo are honoured', async () => {
  const { files: [file] } = workspace('cbr320_joint_tags.mp3');
  const o = await new Transcoder().process(file, { ...defaultSettings(), mode: 'ABR', kbps: 128, channels: 'STEREO' }, false);
  assert.equal(o.type, 'done', o.message);
  const out = probe(o.outputPath);
  assert.equal(out.mode, 'ABR');
  assert.equal(out.channels, 'STEREO');
});

test('high-pass filter really removes low rumble (LAME alone would ignore 80 Hz)', async () => {
  const { files: [file] } = workspace('rumble40_mono.mp3');
  const t = new Transcoder();
  const rms = async (p) => (await runEngine(defaultEnginePath(), ['inspect', p], () => {})).rms;
  const settings = { ...defaultSettings(), mode: 'CBR', kbps: 96 };

  const plain = await t.process(file, settings, false);
  const filtered = await t.process(file, { ...settings, highPass: true }, false);

  assert.equal(plain.type, 'done', plain.message);
  assert.equal(filtered.type, 'done', filtered.message);
  const [before, after] = [await rms(plain.outputPath), await rms(filtered.outputPath)];
  // 40 Hz through a 2nd-order 80 Hz high-pass keeps ~24% of its amplitude; the 1 kHz tone is untouched.
  assert.ok(before > 0.3, `unfiltered RMS ${before}`);
  assert.ok(after < before * 0.35, `filtered RMS ${after} should be far below ${before}`);
});

test('all-Keep settings skip without writing anything', async () => {
  const { dir, files: [file] } = workspace('cbr64_mono.mp3');
  const o = await new Transcoder().process(file, defaultSettings(), false);
  assert.deepEqual(o, { type: 'skipped', reason: 'All settings are “Keep”' });
  assert.deepEqual(fs.readdirSync(dir), ['cbr64_mono.mp3']);
});

test('a file already at or below the target is skipped', async () => {
  const { files: [file] } = workspace('cbr64_mono.mp3');
  const o = await new Transcoder().process(file, { ...defaultSettings(), kbps: 128 }, false);
  assert.deepEqual(o, { type: 'skipped', reason: 'Already matches settings' });
});

test('untagged VBR source is measured and compressed', async () => {
  const { files: [file] } = workspace('vbr_v2_untagged.mp3');
  const o = await new Transcoder().process(file, preset('PODCAST'), false);
  assert.equal(o.type, 'done', o.message);
  assert.equal(o.source.mode, 'VBR');
  assert.ok(o.source.kbps > 100 && o.source.kbps < 260, `measured ${o.source.kbps} kbps`);
});

test('a truncated source is reported as damaged and nothing is written', async () => {
  const { dir, files: [file] } = workspace('damaged_truncated_vbr.mp3');
  const o = await new Transcoder().process(file, preset('PODCAST'), false);
  assert.equal(o.type, 'failed');
  assert.match(o.message, /Source is damaged/);
  assert.deepEqual(fs.readdirSync(dir), ['damaged_truncated_vbr.mp3']);
});

test('a non-MP3 file fails cleanly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3bulk-e2e-'));
  const p = path.join(dir, 'garbage.mp3');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'probe', 'garbage.mp3'), p);
  const o = await new Transcoder().process({ path: p, name: 'garbage.mp3', size: 0, relativeDir: '' }, preset('PODCAST'), false);
  assert.equal(o.type, 'failed');
  assert.match(o.message, /Not a valid MP3/);
});

test('Unicode file names survive the round trip', async () => {
  const { dir, files: [file] } = workspace(['cbr64_mono.mp3', 'Café Ünïcødé 日本語.mp3']);
  const o = await new Transcoder().process(file, { ...defaultSettings(), kbps: 32 }, false);
  assert.equal(o.type, 'done', o.message);
  assert.ok(fs.readdirSync(dir).includes('Café Ünïcødé 日本語 - SHRUNK.mp3'));
});

test('an existing " - SHRUNK" file is never overwritten', async () => {
  const { dir, files: [file] } = workspace('cbr64_mono.mp3');
  fs.writeFileSync(path.join(dir, 'cbr64_mono - SHRUNK.mp3'), 'keep me');
  const o = await new Transcoder().process(file, { ...defaultSettings(), kbps: 32 }, false);
  assert.equal(o.outputName, 'cbr64_mono - SHRUNK (1).mp3');
  assert.equal(fs.readFileSync(path.join(dir, 'cbr64_mono - SHRUNK.mp3'), 'utf8'), 'keep me');
});

test('cancelling mid-encode leaves no output and no temp files', async () => {
  const { dir, files: [file] } = workspace('cbr320_joint_tags.mp3');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3bulk-tmp-'));
  const controller = new AbortController();
  const t = new Transcoder({ tempDir });
  const o = await t.process(file, preset('HQ_MUSIC'), false, (f) => { if (f > 0) controller.abort(); }, controller.signal);
  assert.deepEqual(o, { type: 'cancelled' });
  assert.deepEqual(fs.readdirSync(dir), ['cbr320_joint_tags.mp3']);
  assert.deepEqual(tempLeftovers(tempDir), []);
});

test('batch runner processes a folder on parallel workers and logs every file', async () => {
  const { dir } = workspace('cbr320_joint_tags.mp3', 'vbr_v2_stereo.mp3', 'cbr64_mono.mp3', 'damaged_truncated_vbr.mp3');
  const files = await scanPaths([dir], true);
  const runner = new BatchRunner(new Transcoder(), { workers: 3 });
  let updates = 0;
  runner.on('state', () => updates++);

  const st = await runner.start(files, preset('PODCAST'), false);

  const s = summarize(st);
  assert.equal(st.finished, true);
  assert.equal(s.completed, 4);
  assert.equal(s.compressed, 3);
  assert.equal(s.failed, 1);
  assert.ok(s.bytesSaved > 0);
  assert.ok(updates > 4);
  assert.match(st.log.at(-1).text, /^Batch complete\. 3 compressed, 0 skipped, 1 failed/);
  assert.equal(st.log.filter((l) => l.isError).length, 1);
});
