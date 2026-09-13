'use strict';
/**
 * One file, start to finish: probe → plan → encode → verify → save beside the original → (optionally)
 * move the original to the Trash / Recycle Bin and give the new file its name.
 *
 * Port of the Android app's encoder/Transcoder.kt. The original is never overwritten or permanently
 * deleted; if anything fails, a partly written output is removed and the original is left exactly as it was.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { probe, measureDurationUs } = require('./probe');
const { EncodeMode, ChannelOut, planFor, sourceSummary, sameSettings, defaultSettings } = require('./settings');
const { shrunkName, writeVerifiedSibling } = require('./files');

/**
 * @typedef {'COPY'|'REPLACED'|'KEPT_BOTH'} SaveStatus
 * @typedef {{type:'done', oldSize:number, newSize:number, source:object, plan:object, outputName:string,
 *            outputPath:string, status:SaveStatus, note?:string}} DoneOutcome
 * @typedef {DoneOutcome | {type:'skipped', reason:string} | {type:'failed', message:string} | {type:'cancelled'}} Outcome
 */

class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

/** Where the engine binary lives in a dev checkout (resources/engine/<platform>-<arch>/). */
function defaultEnginePath() {
  const exe = process.platform === 'win32' ? 'mp3bulk-engine.exe' : 'mp3bulk-engine';
  return path.join(__dirname, '..', '..', 'resources', 'engine', `${process.platform}-${process.arch}`, exe);
}

/**
 * Runs the native engine and resolves with its `result` JSON.
 * @param {string} enginePath
 * @param {string[]} args
 * @param {(fraction:number)=>void} onProgress
 * @param {AbortSignal} [signal]
 */
function runEngine(enginePath, args, onProgress, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const child = spawn(enginePath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let buffered = '';
    let result = null;
    let error = null;
    let stderr = '';

    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      let nl;
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (line.startsWith('progress ')) onProgress(Number(line.slice(9)) || 0);
        else if (line.startsWith('result ')) result = JSON.parse(line.slice(7));
        else if (line.startsWith('error ')) error = line.slice(6);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Couldn't start the encoder: ${e.message}`));
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(new CancelledError());
      else if (code === 0 && result) resolve(result);
      else reject(new Error(error || stderr.trim() || `Encoder exited with code ${code}`));
    });
  });
}

class Transcoder {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.enginePath]  path to mp3bulk-engine
   * @param {string} [opts.tempDir]     where temporary encodes go (default: OS temp folder)
   * @param {(path:string)=>Promise<void>} [opts.trashItem]  moves a file to the Trash; required for replace
   * @param {string} [opts.trashName]   "Trash" or "Recycle Bin", for messages
   */
  constructor(opts = {}) {
    this.enginePath = opts.enginePath || defaultEnginePath();
    this.tempDir = opts.tempDir || os.tmpdir();
    this.trashItem = opts.trashItem;
    this.trashName = opts.trashName || (process.platform === 'win32' ? 'Recycle Bin' : 'Trash');
  }

  /**
   * Encode to a private temp file, decode it back to prove it's complete, copy it beside the original
   * and re-read that copy. Only then is the original touched (moved to Trash, never overwritten).
   * @param {import('./files').Mp3File} file
   * @param {import('./settings').EncodeSettings} settings
   * @param {boolean} replace
   * @param {(fraction:number)=>void} onProgress
   * @param {AbortSignal} [signal]
   * @returns {Promise<Outcome>}
   */
  async process(file, settings, replace, onProgress = () => {}, signal) {
    const temp = path.join(this.tempDir, `mp3bulk-${crypto.randomUUID()}.mp3`);
    let unfinished = null;
    try {
      const p = probe(file.path);
      if (p.mode == null) return { type: 'failed', message: 'Not a valid MP3 (no audio frames found)' };

      const source = this.sourceInfo(file.path, p);
      const plan = planFor(settings, source);
      if (!plan) {
        return {
          type: 'skipped',
          reason: sameSettings(settings, defaultSettings()) ? 'All settings are “Keep”' : 'Already matches settings',
        };
      }

      const encoded = await runEngine(this.enginePath, [
        'encode', file.path, temp,
        String(EncodeMode[plan.mode].code), String(plan.kbps), String(plan.sampleRate),
        String(ChannelOut[plan.channels].code), plan.highPass ? '1' : '0', plan.lowPass ? '1' : '0',
        String(p.id3v2Size), String(p.fileSize - p.id3v1Size),
      ], (f) => onProgress(f * 0.8), signal);

      const decodedUs = (encoded.inFrames * 1e6) / encoded.inRate;
      const expectedUs = p.trustedDurationUs;
      if (expectedUs > 0 && decodedUs < expectedUs * 0.98 - 500000) {
        return {
          type: 'failed',
          message: `Source is damaged: only ${(decodedUs / 1e6).toFixed(1)}s of ${(expectedUs / 1e6).toFixed(1)}s could be decoded`,
        };
      }

      await this.verify(temp, encoded, (f) => onProgress(0.8 + f * 0.15), signal);

      const newSize = (await fsp.stat(temp)).size;
      if (newSize >= p.fileSize) {
        return { type: 'skipped', reason: `Wouldn't be smaller (source is ${sourceSummary(source)})` };
      }

      if (signal?.aborted) throw new CancelledError();
      const dir = path.dirname(file.path);
      const staged = await writeVerifiedSibling(dir, shrunkName(file.name), temp);
      unfinished = staged;
      onProgress(0.98);

      const done = {
        type: 'done',
        oldSize: p.fileSize,
        newSize,
        source,
        plan: { ...plan, sampleRate: encoded.outRate },
        outputName: path.basename(staged),
        outputPath: staged,
        status: 'COPY',
      };
      unfinished = null;
      return replace ? await this.replaceOriginal(file, done) : done;
    } catch (e) {
      if (e instanceof CancelledError) return { type: 'cancelled' };
      return { type: 'failed', message: e?.message || String(e) };
    } finally {
      await fsp.rm(temp, { force: true }).catch(() => {});
      // Only a partially written output of ours is removed; originals are never deleted here.
      if (unfinished) await fsp.rm(unfinished, { force: true }).catch(() => {});
    }
  }

  /** Once the original is in the Trash, the new file takes its name. */
  async replaceOriginal(file, done) {
    if (!this.trashItem) {
      return { ...done, status: 'KEPT_BOTH', note: `Original kept: moving to the ${this.trashName} isn't available` };
    }
    try {
      await this.trashItem(file.path);
    } catch (e) {
      return { ...done, status: 'KEPT_BOTH', note: `Original kept: couldn't move it to the ${this.trashName} (${e.message})` };
    }
    if (fs.existsSync(file.path)) {
      return { ...done, status: 'KEPT_BOTH', note: `Original wasn't moved to the ${this.trashName}, so both files were kept` };
    }
    try {
      await fsp.rename(done.outputPath, file.path);
    } catch {
      return { ...done, status: 'REPLACED', note: `Original is in the ${this.trashName}, but the new file couldn't be renamed` };
    }
    return { ...done, status: 'REPLACED', outputName: file.name, outputPath: file.path };
  }

  /** Describes the source using header data, measuring duration by walking frames when no header declares it. */
  sourceInfo(filePath, p) {
    const durationUs = p.trustedDurationUs > 0 ? p.trustedDurationUs : measureDurationUs(filePath, p);
    let kbps;
    if (p.mode === 'CBR' && p.headerKbps > 0) kbps = p.headerKbps;
    else if (durationUs > 1e6) kbps = Math.trunc((p.audioBytes * 8000) / durationUs);
    else kbps = p.headerKbps;
    return { mode: p.mode, kbps, sampleRate: p.sampleRate, channels: p.channels || 'STEREO', durationUs };
  }

  /** Decodes the finished file end to end and checks format and length against what went in. */
  async verify(file, encoded, onProgress, signal) {
    const r = await runEngine(this.enginePath, ['inspect', file], onProgress, signal);
    if (r.rate !== encoded.outRate) throw new Error(`Check failed: output is ${r.rate} Hz, expected ${encoded.outRate} Hz`);
    if (r.channels !== encoded.outChannels) {
      throw new Error(`Check failed: output has ${r.channels} channels, expected ${encoded.outChannels}`);
    }
    if (r.formatChanged) throw new Error('Check failed: output changes format part-way through');
    const inSec = encoded.inFrames / encoded.inRate;
    const outSec = r.frames / r.rate;
    if (!(inSec > 0 && Math.abs(outSec - inSec) <= 0.25 + inSec * 0.005)) {
      throw new Error(`Check failed: output is ${outSec.toFixed(2)}s long, source is ${inSec.toFixed(2)}s`);
    }
  }
}

module.exports = { Transcoder, runEngine, defaultEnginePath, CancelledError };
