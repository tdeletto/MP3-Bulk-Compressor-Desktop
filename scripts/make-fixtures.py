#!/usr/bin/env python3
"""
Regenerates the full-length MP3 fixtures in test/fixtures/full/ used by the integration tests.

Needs the `lame` command-line encoder (brew install lame / choco install lame). The fixtures are
committed, so you only need this if you want to change them. The trimmed 64 KB files in
test/fixtures/probe/ come from the Android project and are only used by the header-parsing tests.
"""
import math
import os
import random
import struct
import subprocess
import tempfile
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "test", "fixtures", "full")
RATE = 44100
SECONDS = 8


def make_wav(path):
    """8 s of music-like stereo audio: shifting chords, a bass line and noise bursts, so VBR has work to do."""
    rng = random.Random(42)
    chords = [(261.6, 329.6, 392.0), (220.0, 261.6, 329.6), (174.6, 220.0, 261.6), (196.0, 246.9, 293.7)]
    frames = bytearray()
    for i in range(RATE * SECONDS):
        t = i / RATE
        chord = chords[int(t * 2) % len(chords)]
        tone = sum(math.sin(2 * math.pi * f * t) for f in chord) / 3
        bass = math.sin(2 * math.pi * chord[0] / 2 * t)
        burst = rng.uniform(-1, 1) * (0.5 if (t * 4) % 1 < 0.05 else 0.02)
        left = 0.45 * tone + 0.25 * bass + burst
        right = 0.45 * math.sin(2 * math.pi * chord[1] * 1.003 * t) + 0.25 * bass + burst
        frames += struct.pack("<hh", int(max(-1, min(1, left)) * 32000), int(max(-1, min(1, right)) * 32000))
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(bytes(frames))


def make_rumble_wav(path):
    """4 s mono: a loud 40 Hz rumble under a quiet 1 kHz tone, for testing the 80 Hz high-pass filter."""
    frames = bytearray()
    for i in range(RATE * 4):
        t = i / RATE
        v = 0.5 * math.sin(2 * math.pi * 40 * t) + 0.05 * math.sin(2 * math.pi * 1000 * t)
        frames += struct.pack("<h", int(v * 32000))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(bytes(frames))


def lame(wav, name, *args):
    dest = os.path.join(OUT, name)
    subprocess.run(["lame", "--quiet", *args, wav, dest], check=True)
    print("wrote", os.path.relpath(dest, ROOT), os.path.getsize(dest), "bytes")
    return dest


def main():
    os.makedirs(OUT, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "source.wav")
        make_wav(wav)
        tags = ["--add-id3v2", "--tt", "Fixture Song", "--ta", "MP3 Bulk Compressor Desktop", "--tl", "Tests", "--ty", "2026"]
        lame(wav, "cbr320_joint_tags.mp3", "-b", "320", *tags)
        lame(wav, "vbr_v2_stereo.mp3", "-V", "2")
        lame(wav, "vbr_v2_untagged.mp3", "-V", "2", "-t")
        lame(wav, "cbr64_mono.mp3", "-b", "64", "-m", "m")
        lame(wav, "cbr32_mono_22k.mp3", "-b", "32", "-m", "m", "--resample", "22.05")

        rumble = os.path.join(tmp, "rumble.wav")
        make_rumble_wav(rumble)
        lame(rumble, "rumble40_mono.mp3", "-b", "128", "-m", "m")

        # A VBR file cut in half: its Xing header still promises 8 s, so it must be reported as damaged.
        with open(os.path.join(OUT, "vbr_v2_stereo.mp3"), "rb") as f:
            data = f.read()
        with open(os.path.join(OUT, "damaged_truncated_vbr.mp3"), "wb") as f:
            f.write(data[: len(data) // 2])
        print("wrote test/fixtures/full/damaged_truncated_vbr.mp3")


if __name__ == "__main__":
    main()
