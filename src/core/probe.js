'use strict';
/**
 * Reads the byte layout and encoding of an MP3 file straight from its headers, without decoding.
 * Port of the Android app's encoder/Mp3Probe.kt, plus a frame-walk fallback for untagged VBR files
 * (Android got that duration from MediaExtractor instead).
 */
const fs = require('fs');

const SCAN_BYTES = 512 * 1024;
const RATES = [[44100, 48000, 32000], [22050, 24000, 16000], [11025, 12000, 8000]];
const KBPS_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/**
 * @typedef {Object} ProbeResult
 * @property {number} id3v2Size   bytes of ID3v2 tag at the start (0 if none)
 * @property {number} id3v1Size   bytes of ID3v1 tag at the end (0 or 128)
 * @property {number} fileSize
 * @property {'CBR'|'VBR'|'ABR'|null} mode  null when no valid MPEG Layer III frames were found
 * @property {number} headerKbps
 * @property {number} sampleRate
 * @property {'MONO'|'STEREO'|'JOINT'|null} channels
 * @property {number} frameCount  from a Xing/Info/VBRI header; 0 if the file has none
 * @property {number} samplesPerFrame
 * @property {number} audioBytes
 * @property {number} trustedDurationUs  exact duration when declared (or CBR), otherwise 0
 */

/** Parses a 4-byte MPEG audio frame header at offset i, or returns null. Layer III only. */
function header(b, i) {
  if (i < 0 || i + 4 > b.length) return null;
  const b1 = b[i + 1], b2 = b[i + 2], b3 = b[i + 3];
  if (b[i] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 3;
  if (version === 1) return null;
  if (((b1 >> 1) & 3) !== 1) return null; // Layer III only
  const bitrateIndex = b2 >> 4;
  if (bitrateIndex === 0 || bitrateIndex === 15) return null;
  const rateIndex = (b2 >> 2) & 3;
  if (rateIndex === 3) return null;
  const mpeg1 = version === 3;
  const rate = RATES[mpeg1 ? 0 : version === 2 ? 1 : 2][rateIndex];
  const kbps = mpeg1 ? KBPS_V1[bitrateIndex] : KBPS_V2[bitrateIndex];
  const samples = mpeg1 ? 1152 : 576;
  const length = Math.trunc((Math.trunc(samples / 8) * kbps * 1000) / rate) + ((b2 >> 1) & 1);
  return { mpeg1, kbps, rate, channelMode: b3 >> 6, length, samples };
}

/** First offset where two consecutive, consistent frame headers appear. */
function firstFrame(b) {
  for (let i = 0; i < b.length - 4; i++) {
    const h = header(b, i);
    if (!h) continue;
    const next = i + h.length;
    if (next + 4 > b.length) return i;
    const n = header(b, next);
    if (n && n.rate === h.rate && n.mpeg1 === h.mpeg1) return i;
  }
  return -1;
}

const ascii = (b, i, n) => (i < 0 || i + n > b.length ? '' : b.toString('latin1', i, i + n));
const int32 = (b, i) => (i < 0 || i + 4 > b.length ? 0 : b.readUInt32BE(i));

function readAt(fd, length, position) {
  const buf = Buffer.alloc(Math.max(0, length));
  let done = 0;
  while (done < buf.length) {
    const n = fs.readSync(fd, buf, done, buf.length - done, position + done);
    if (n <= 0) break;
    done += n;
  }
  return done === buf.length ? buf : buf.subarray(0, done);
}

function id3v2Size(fd, size) {
  if (size < 10) return 0;
  const h = readAt(fd, 10, 0);
  if (h.length < 10 || h.toString('latin1', 0, 3) !== 'ID3') return 0;
  const body = ((h[6] & 0x7f) << 21) | ((h[7] & 0x7f) << 14) | ((h[8] & 0x7f) << 7) | (h[9] & 0x7f);
  const footer = h[5] & 0x10 ? 10 : 0;
  const total = 10 + body + footer;
  return total > size || total > 64 * 1024 * 1024 ? 0 : total;
}

function id3v1Size(fd, size, v2Size) {
  if (size < 128 + v2Size) return 0;
  return readAt(fd, 3, size - 128).toString('latin1') === 'TAG' ? 128 : 0;
}

/** Parses the start of the audio region. Exported for tests. */
function parse(b, id3v2, id3v1, fileSize) {
  const audioBytes = Math.max(0, fileSize - id3v2 - id3v1);
  const result = (mode, headerKbps, sampleRate, channels, frameCount, samplesPerFrame) => {
    let trustedDurationUs = 0;
    if (frameCount > 0 && sampleRate > 0) trustedDurationUs = Math.floor((frameCount * samplesPerFrame * 1e6) / sampleRate);
    else if (mode === 'CBR' && headerKbps > 0) trustedDurationUs = Math.floor((audioBytes * 8000) / headerKbps);
    return {
      id3v2Size: id3v2, id3v1Size: id3v1, fileSize, mode, headerKbps, sampleRate, channels,
      frameCount, samplesPerFrame, audioBytes, trustedDurationUs,
    };
  };

  const first = firstFrame(b);
  if (first < 0) return result(null, 0, 0, null, 0, 0);
  const h = header(b, first);

  let mode = null;
  let frames = 0;
  let audioStart = first;

  const sideInfo = h.mpeg1 ? (h.channelMode === 3 ? 17 : 32) : (h.channelMode === 3 ? 9 : 17);
  const x = first + 4 + sideInfo;
  const tagId = ascii(b, x, 4);
  if (tagId === 'Xing' || tagId === 'Info') {
    mode = tagId === 'Xing' ? 'VBR' : 'CBR';
    const flags = int32(b, x + 4);
    let p = x + 8;
    if (flags & 1) { frames = int32(b, p); p += 4; }
    if (flags & 2) p += 4;
    if (flags & 4) p += 100;
    if (flags & 8) p += 4;
    const encoder = ascii(b, p, 4);
    if (encoder === 'LAME' || encoder === 'Lavc' || encoder === 'Lavf' || encoder.startsWith('L3.')) {
      // LAME tag "VBR method" nibble.
      switch ((b[p + 9] ?? 0) & 0x0f) {
        case 1: case 8: mode = 'CBR'; break;
        case 2: case 9: mode = 'ABR'; break;
        case 3: case 4: case 5: case 6: case 7: mode = 'VBR'; break;
        default: break;
      }
    }
    audioStart = first + h.length;
  } else if (ascii(b, first + 36, 4) === 'VBRI') {
    mode = 'VBR';
    frames = int32(b, first + 36 + 14);
    audioStart = first + h.length;
  }

  const audio = header(b, audioStart) || h;
  if (mode == null) {
    // No info tag: look at a run of frames to tell CBR from untagged VBR.
    const seen = new Set();
    let i = audioStart;
    for (let n = 0; n < 300; n++) {
      const f = header(b, i);
      if (!f) break;
      seen.add(f.kbps);
      i += f.length;
    }
    mode = seen.size > 1 ? 'VBR' : 'CBR';
  }

  const channels = audio.channelMode === 3 ? 'MONO' : audio.channelMode === 1 ? 'JOINT' : 'STEREO';
  return result(mode, audio.kbps, audio.rate, channels, frames, audio.samples);
}

/**
 * Reads an MP3's tags and first frames.
 * @param {string} path
 * @returns {ProbeResult}
 */
function probe(path) {
  const fd = fs.openSync(path, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const v2 = id3v2Size(fd, size);
    const v1 = id3v1Size(fd, size, v2);
    const len = Math.max(0, Math.min(SCAN_BYTES, size - v2 - v1));
    return parse(readAt(fd, len, v2), v2, v1, size);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Walks every frame header in the audio region to measure duration (for VBR files with no Xing/VBRI
 * header). Resyncs past junk. Returns 0 if nothing sensible was found.
 * @param {string} path
 * @param {ProbeResult} p
 */
function measureDurationUs(path, p) {
  const fd = fs.openSync(path, 'r');
  try {
    const b = readAt(fd, p.audioBytes, p.id3v2Size);
    let i = firstFrame(b);
    if (i < 0) return 0;
    let samples = 0;
    let rate = 0;
    while (i + 4 <= b.length) {
      const h = header(b, i);
      if (h && (rate === 0 || h.rate === rate)) {
        rate = h.rate;
        samples += h.samples;
        i += h.length;
      } else {
        i++;
      }
    }
    return rate ? Math.floor((samples * 1e6) / rate) : 0;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { probe, parse, measureDurationUs };
