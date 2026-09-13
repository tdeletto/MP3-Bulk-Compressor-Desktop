'use strict';
/**
 * Runs a batch of files on parallel workers and keeps a single state object the UI renders from.
 * Port of the Android app's BatchRunner.kt (minus the Android service / Trash-approval plumbing).
 */
const os = require('os');
const { EventEmitter } = require('events');
const { planSummary } = require('./settings');
const { formatBytes } = require('./files');

/**
 * @typedef {Object} RunState
 * @property {number} total
 * @property {boolean} replace
 * @property {{file:object, outcome:object}[]} results
 * @property {Object<string,{name:string, progress:number}>} active  in-flight files keyed by path
 * @property {boolean} finished
 * @property {boolean} cancelled
 * @property {{time:number, text:string, isError:boolean}[]} log
 * @property {number} startedAt
 * @property {number} endedAt
 */

/** How many files to encode at once: leave one core free, cap so disks aren't thrashed. */
function workerCount() {
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.min(Math.max(cpus - 1, 1), 6);
}

/** Totals derived from a run state (used by the UI and the final log line). */
function summarize(state) {
  const done = state.results.filter((r) => r.outcome.type === 'done');
  return {
    completed: state.results.length,
    compressed: done.length,
    skipped: state.results.filter((r) => r.outcome.type === 'skipped').length,
    failed: state.results.filter((r) => r.outcome.type === 'failed').length,
    bytesSaved: done.reduce((sum, r) => sum + (r.outcome.oldSize - r.outcome.newSize), 0),
    fraction: state.total === 0 ? 1
      : (state.results.length + Object.values(state.active).reduce((s, a) => s + a.progress, 0)) / state.total,
  };
}

class BatchRunner extends EventEmitter {
  /** @param {import('./transcoder').Transcoder} transcoder */
  constructor(transcoder, { workers = workerCount(), trashName = 'Trash' } = {}) {
    super();
    this.transcoder = transcoder;
    this.workers = workers;
    this.trashName = trashName;
    /** @type {RunState|null} */
    this.state = null;
    this.controller = null;
  }

  get isRunning() {
    return !!this.state && !this.state.finished;
  }

  /**
   * Starts a batch. Emits 'state' on every change and 'finished' once at the end.
   * @returns {Promise<RunState>} resolves when every worker has stopped
   */
  async start(files, settings, replace) {
    if (this.isRunning || files.length === 0) return this.state;
    this.controller = new AbortController();
    const { signal } = this.controller;
    this.state = {
      total: files.length, replace, results: [], active: {}, finished: false, cancelled: false,
      log: [], startedAt: Date.now(), endedAt: 0,
    };
    this.log(`Started ${files.length} file(s) · ${replace ? 'replace originals' : 'save “ - SHRUNK” copies'}`);

    const queue = [...files];
    const worker = async () => {
      while (queue.length && !signal.aborted) {
        const file = queue.shift();
        this.setActive(file, 0);
        const outcome = await this.transcoder.process(file, settings, replace, (p) => this.setActive(file, p), signal);
        delete this.state.active[file.path];
        if (outcome.type === 'cancelled') continue; // stopped mid-file: nothing was changed, so nothing to report
        this.record(file, outcome);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.workers, files.length) }, worker));
    this.finish(signal.aborted);
    return this.state;
  }

  /** Stops the batch: running encodes are killed and their partial output removed. */
  cancel() {
    this.controller?.abort();
  }

  setActive(file, progress) {
    this.state.active[file.path] = { name: file.name, progress };
    this.emit('state', this.state);
  }

  record(file, outcome) {
    this.state.results.push({ file, outcome });
    this.logResult(file, outcome);
    this.emit('state', this.state);
  }

  logResult(file, o) {
    const where = file.relativeDir ? `${file.relativeDir}/${file.name}` : file.name;
    if (o.type === 'done') {
      const what = {
        COPY: `saved as “${o.outputName}”`,
        REPLACED: `replaced; original in ${this.trashName}`,
        KEPT_BOTH: 'saved as copy',
      }[o.status];
      this.log(`✓ ${where}: ${formatBytes(o.oldSize)} → ${formatBytes(o.newSize)} (${planSummary(o.plan)}), ${what}` +
        (o.note ? `. ${o.note}` : ''));
    } else if (o.type === 'skipped') {
      this.log(`– ${where}: skipped, ${o.reason}`);
    } else {
      this.log(`✗ ${where}: ${o.message}. Original untouched.`, true);
    }
  }

  log(text, isError = false) {
    this.state.log.push({ time: Date.now(), text, isError });
    if (this.state.log.length > 5000) this.state.log.splice(0, this.state.log.length - 5000);
  }

  finish(cancelled) {
    const st = this.state;
    if (!st || st.finished) return;
    st.finished = true;
    st.cancelled = cancelled;
    st.active = {};
    st.endedAt = Date.now();
    const s = summarize(st);
    this.log(`${cancelled ? 'Stopped. ' : 'Batch complete. '}${s.compressed} compressed, ${s.skipped} skipped, ` +
      `${s.failed} failed, ${formatBytes(s.bytesSaved)} saved`);
    this.emit('state', st);
    this.emit('finished', st);
  }
}

module.exports = { BatchRunner, summarize, workerCount };
