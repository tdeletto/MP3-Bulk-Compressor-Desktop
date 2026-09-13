'use strict';
/**
 * Finding MP3s on disk and saving outputs safely.
 * Desktop counterpart of the Android app's files/Scanner.kt and files/Storage.kt.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');

/** Added to the name of every compressed copy: "song.mp3" -> "song - SHRUNK.mp3". */
const SHRUNK_SUFFIX = ' - SHRUNK';

const isMp3 = (name) => name.toLowerCase().endsWith('.mp3');

/** Our own outputs and hidden files are never picked up again by a folder scan. */
function isCandidate(name) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return !name.startsWith('.') && !base.toLowerCase().endsWith(SHRUNK_SUFFIX.toLowerCase());
}

/** "song.mp3" -> "song - SHRUNK.mp3" */
function shrunkName(name) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base}${SHRUNK_SUFFIX}.mp3`;
}

/** Splits a file name into [base, ".ext"] (ext is "" when there is none). */
function splitExt(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
}

/** `name` in `dir`, or "base (1).ext", "base (2).ext"… if taken. */
function uniqueChild(dir, name) {
  const [base, ext] = splitExt(name);
  let candidate = path.join(dir, name);
  for (let n = 1; fs.existsSync(candidate); n++) candidate = path.join(dir, `${base} (${n})${ext}`);
  return candidate;
}

/**
 * @typedef {Object} Mp3File
 * @property {string} path         absolute path
 * @property {string} name         file name
 * @property {number} size         bytes
 * @property {string} relativeDir  folder relative to the chosen root ("" for top level), for display
 */

/**
 * Collects MP3s from a mix of files and folders (as picked or dropped by the user).
 * Explicitly chosen files are always included; folder scans skip hidden entries and " - SHRUNK" outputs.
 * Symbolic links to folders are not followed, so a scan can never loop.
 * @param {string[]} inputs
 * @param {boolean} recursive  include every subfolder
 * @returns {Promise<Mp3File[]>} sorted by folder, then name
 */
async function scanPaths(inputs, recursive) {
  const found = new Map();
  const add = (p, size, relativeDir) => {
    if (!found.has(p)) found.set(p, { path: p, name: path.basename(p), size, relativeDir });
  };

  for (const input of inputs) {
    let st;
    try {
      st = await fsp.stat(input);
    } catch {
      continue;
    }
    if (st.isFile()) {
      if (isMp3(input)) add(path.resolve(input), st.size, '');
      continue;
    }
    if (!st.isDirectory()) continue;

    const root = path.resolve(input);
    const queue = [root];
    while (queue.length) {
      const dir = queue.shift();
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable folder: skip it rather than fail the whole scan
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (recursive) queue.push(full);
        } else if (e.isFile() && isMp3(e.name) && isCandidate(e.name)) {
          try {
            const rel = path.relative(root, dir).split(path.sep).join('/');
            add(full, (await fsp.stat(full)).size, rel);
          } catch {
            /* vanished during the scan */
          }
        }
      }
    }
  }

  return [...found.values()].sort((a, b) =>
    a.relativeDir.toLowerCase().localeCompare(b.relativeDir.toLowerCase()) ||
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

/** CRC-32 and length of a file, streamed. */
async function crcOfFile(file) {
  let crc = 0;
  let length = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 16 })) {
    crc = zlib.crc32(chunk, crc);
    length += chunk.length;
  }
  return { crc, length };
}

/**
 * Copies `src` into a new file named `name` (or "name (1)"…) inside `dir`, syncs it to disk,
 * then reads it back to confirm every byte landed. Never overwrites an existing file.
 * @returns {Promise<string>} the path written
 */
async function writeVerifiedSibling(dir, name, src) {
  const [base, ext] = splitExt(name);
  let handle;
  let dest;
  // 'wx' fails if the name exists, so two workers (or another app) can never clobber each other.
  for (let n = 0; !handle; n++) {
    dest = path.join(dir, n === 0 ? name : `${base} (${n})${ext}`);
    try {
      handle = await fsp.open(dest, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST' || n > 9999) throw e;
    }
  }

  try {
    let expected = 0;
    let written = 0;
    try {
      for await (const chunk of fs.createReadStream(src, { highWaterMark: 1 << 16 })) {
        expected = zlib.crc32(chunk, expected);
        let off = 0;
        while (off < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, off, chunk.length - off);
          off += bytesWritten;
        }
        written += chunk.length;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }

    const actual = await crcOfFile(dest);
    if (actual.length !== written || actual.crc !== expected) throw new Error("Saved file didn't match what was encoded");
    return dest;
  } catch (e) {
    await fsp.rm(dest, { force: true });
    throw e;
  }
}

/** 1536 -> "2 KB", 5_300_000 -> "5.1 MB". Binary units, like the Android app. */
function formatBytes(bytes) {
  const abs = Math.abs(bytes);
  if (abs >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(2)} GB`;
  if (abs >= 2 ** 20) return `${(bytes / 2 ** 20).toFixed(1)} MB`;
  if (abs >= 2 ** 10) return `${(bytes / 2 ** 10).toFixed(0)} KB`;
  return `${bytes} B`;
}

module.exports = {
  SHRUNK_SUFFIX, isMp3, isCandidate, shrunkName, uniqueChild, scanPaths, writeVerifiedSibling, crcOfFile, formatBytes,
};
