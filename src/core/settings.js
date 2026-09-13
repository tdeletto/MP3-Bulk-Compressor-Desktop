'use strict';
/**
 * Encode settings, presets and the per-file planning rules.
 *
 * A straight port of the Android app's encoder/Settings.kt, so both apps make identical decisions.
 * `null` / KEEP / false always means "leave that property as the file has it".
 */

/** Bitrate modes. `code` must match MODE_* in engine/mp3bulk_engine.c. */
const EncodeMode = Object.freeze({
  CBR: { id: 'CBR', code: 0, label: 'CBR', description: 'Constant bitrate: predictable size, most compatible' },
  VBR: { id: 'VBR', code: 1, label: 'VBR', description: 'Variable bitrate: best quality for the size' },
  ABR: { id: 'ABR', code: 2, label: 'ABR', description: 'Average bitrate: size close to target, adaptive' },
});

/** Output channel layouts. `code` must match CH_* in engine/mp3bulk_engine.c. */
const ChannelOut = Object.freeze({
  MONO: { id: 'MONO', code: 0, label: 'Mono' },
  STEREO: { id: 'STEREO', code: 1, label: 'Full stereo' },
  JOINT: { id: 'JOINT', code: 2, label: 'Joint stereo' },
});

/** "Keep original" for the numeric settings. */
const KEEP = 0;
/** LAME -V0 averages about 245 kbps; only offered in VBR mode. */
const V0_KBPS = 245;
const HIGH_PASS_HZ = 80;
const LOW_PASS_HZ = 15000;

const BITRATES = [32, 48, 64, 96, 128, 160, 192, 224, 256, 320];
const SAMPLE_RATES = [8000, 11025, 16000, 22050, 32000, 44100, 48000];

/**
 * @typedef {Object} EncodeSettings
 * @property {'CBR'|'VBR'|'ABR'|null} mode
 * @property {number} kbps        KEEP (0) or a bitrate in kbps
 * @property {number} sampleRate  KEEP (0) or a rate in Hz
 * @property {boolean} highPass
 * @property {boolean} lowPass
 * @property {'MONO'|'STEREO'|'JOINT'|null} channels
 */

/** @returns {EncodeSettings} settings that change nothing */
function defaultSettings() {
  return { mode: null, kbps: KEEP, sampleRate: KEEP, highPass: false, lowPass: false, channels: null };
}

/** Normalises untrusted input (e.g. from the renderer or saved preferences) into valid settings. */
function sanitizeSettings(s) {
  const d = defaultSettings();
  if (!s || typeof s !== 'object') return d;
  return {
    mode: s.mode in EncodeMode ? s.mode : null,
    kbps: [...BITRATES, V0_KBPS].includes(s.kbps) ? s.kbps : KEEP,
    sampleRate: SAMPLE_RATES.includes(s.sampleRate) ? s.sampleRate : KEEP,
    highPass: s.highPass === true,
    lowPass: s.lowPass === true,
    channels: s.channels in ChannelOut ? s.channels : null,
  };
}

const PRESETS = Object.freeze([
  { id: 'ORIGINAL', label: 'Keep original', detail: 'No changes', settings: defaultSettings() },
  {
    id: 'PODCAST', label: 'Podcast', detail: 'VBR 64 · mono',
    settings: { mode: 'VBR', kbps: 64, sampleRate: 44100, highPass: true, lowPass: true, channels: 'MONO' },
  },
  {
    id: 'HQ_MUSIC', label: 'HQ Music', detail: 'V0 · stereo',
    settings: { mode: 'VBR', kbps: V0_KBPS, sampleRate: 44100, highPass: false, lowPass: false, channels: 'STEREO' },
  },
]);

function sameSettings(a, b) {
  return a.mode === b.mode && a.kbps === b.kbps && a.sampleRate === b.sampleRate &&
    a.highPass === b.highPass && a.lowPass === b.lowPass && a.channels === b.channels;
}

/** The preset id these settings correspond to, or 'CUSTOM'. */
function matchingPreset(s) {
  const p = PRESETS.find((preset) => sameSettings(preset.settings, s));
  return p ? p.id : 'CUSTOM';
}

function bitrateLabel(kbps) {
  if (kbps === KEEP) return 'Keep';
  if (kbps === V0_KBPS) return 'V0 (~245)';
  return String(kbps);
}

function sampleRateLabel(hz) {
  return hz === KEEP ? 'Keep' : hz.toLocaleString('en-US');
}

/**
 * @typedef {Object} SourceInfo  What the source file currently is (from probe.js).
 * @property {'CBR'|'VBR'|'ABR'} mode
 * @property {number} kbps        average bitrate
 * @property {number} sampleRate
 * @property {'MONO'|'STEREO'|'JOINT'} channels
 * @property {number} durationUs
 */

/**
 * @typedef {Object} FilePlan  The concrete encode for one file.
 * @property {'CBR'|'VBR'|'ABR'} mode
 * @property {number} kbps
 * @property {number} sampleRate
 * @property {'MONO'|'STEREO'|'JOINT'} channels
 * @property {boolean} highPass
 * @property {boolean} lowPass
 * @property {boolean} keptSourceBitrate  true when the chosen bitrate was ignored to avoid raising it
 */

const MPEG1_CBR = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_CBR = [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/** Legal bitrate range [min, max] for an output sample rate (MPEG-1 / MPEG-2 / MPEG-2.5). */
function bitrateRange(rate) {
  if (rate >= 32000) return [32, 320];
  if (rate >= 16000) return [8, 160];
  return [8, 64];
}

/** Rounds down to the nearest bitrate a CBR frame header can express at this sample rate. */
function snapCbr(kbps, rate) {
  const [lo, hi] = bitrateRange(rate);
  const table = rate >= 32000 ? MPEG1_CBR : MPEG2_CBR.filter((k) => k >= lo && k <= hi);
  const fit = table.filter((k) => k <= kbps);
  return fit.length ? fit[fit.length - 1] : table[0];
}

/** True when a and b are the same bitrate for practical purposes (VBR averages wobble). */
function sameBitrate(a, b) {
  return Math.abs(a - b) <= Math.max(3, Math.trunc(b / 20));
}

/**
 * Resolves settings against one file. Rules:
 * - "Keep" takes the file's own value.
 * - The bitrate is never raised: a source at or below the chosen bitrate keeps its bitrate.
 * - Nothing is upsampled, and a mono file is never made stereo.
 * @param {EncodeSettings} settings
 * @param {SourceInfo} src
 * @returns {FilePlan|null} null when the result would be the same as the source
 */
function planFor(settings, src) {
  const rate = settings.sampleRate === KEEP || settings.sampleRate >= src.sampleRate ? src.sampleRate : settings.sampleRate;
  let channels;
  if (settings.channels == null) channels = src.channels;
  else if (src.channels === 'MONO') channels = 'MONO';
  else channels = settings.channels;
  const mode = settings.mode ?? src.mode;

  const sourceNotHigher = src.kbps > 0 && (src.kbps < settings.kbps || sameBitrate(src.kbps, settings.kbps));
  const keptSource = settings.kbps === KEEP || sourceNotHigher;
  let kbps = keptSource ? src.kbps : settings.kbps;
  if (kbps <= 0) kbps = 128;
  const [lo, hi] = bitrateRange(rate);
  kbps = Math.min(Math.max(kbps, lo), hi);
  if (mode === 'CBR') kbps = snapCbr(kbps + (keptSource ? 2 : 0), rate);

  const unchanged = rate === src.sampleRate &&
    channels === src.channels &&
    mode === src.mode &&
    !settings.highPass && !settings.lowPass &&
    (keptSource || sameBitrate(kbps, src.kbps));
  if (unchanged) return null;

  return {
    mode, kbps, sampleRate: rate, channels,
    highPass: settings.highPass, lowPass: settings.lowPass,
    keptSourceBitrate: keptSource && settings.kbps !== KEEP,
  };
}

/** 44100 -> "44.1 kHz", 22050 -> "22.05 kHz", 8000 -> "8 kHz". */
function kHz(hz) {
  return `${String(hz / 1000)} kHz`;
}

/** e.g. "VBR 64 kbps · 44.1 kHz · mono · HP · LP" */
function planSummary(plan) {
  let s = plan.mode === 'VBR' && plan.kbps >= V0_KBPS ? 'VBR V0' : `${plan.mode} ${plan.kbps} kbps`;
  if (plan.keptSourceBitrate) s += ' (kept)';
  s += ` · ${kHz(plan.sampleRate)} · ${ChannelOut[plan.channels].label.toLowerCase()}`;
  if (plan.highPass) s += ' · HP';
  if (plan.lowPass) s += ' · LP';
  return s;
}

/** e.g. "CBR 320 kbps · 44.1 kHz · joint stereo" */
function sourceSummary(src) {
  return `${src.mode} ${src.kbps} kbps · ${kHz(src.sampleRate)} · ${ChannelOut[src.channels].label.toLowerCase()}`;
}

/** One-line description of the chosen settings, shown under the app title. */
function settingsSummary(s) {
  if (sameSettings(s, defaultSettings())) return 'Keep original settings';
  const parts = [];
  if (s.mode) parts.push(s.mode);
  if (s.kbps !== KEEP) parts.push(s.kbps === V0_KBPS ? 'V0' : `${s.kbps} kbps`);
  if (s.sampleRate !== KEEP) parts.push(`${sampleRateLabel(s.sampleRate)} Hz`);
  if (s.channels) parts.push(ChannelOut[s.channels].label);
  if (s.highPass) parts.push(`HP ${HIGH_PASS_HZ} Hz`);
  if (s.lowPass) parts.push(`LP ${LOW_PASS_HZ / 1000} kHz`);
  return parts.join(' • ');
}

const settingsApi = {
  EncodeMode, ChannelOut, KEEP, V0_KBPS, HIGH_PASS_HZ, LOW_PASS_HZ, BITRATES, SAMPLE_RATES, PRESETS,
  defaultSettings, sanitizeSettings, sameSettings, matchingPreset, bitrateLabel, sampleRateLabel,
  planFor, kHz, planSummary, sourceSummary, settingsSummary,
};

// Shared by the main process (CommonJS) and the sandboxed UI (loaded as a plain <script>).
if (typeof module !== 'undefined' && module.exports) module.exports = settingsApi;
else globalThis.Mp3Settings = settingsApi;
