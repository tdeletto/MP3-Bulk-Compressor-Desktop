# Changelog

## 1.0.1 (2026-09-13)

- Release builds: installers are now attached to the GitHub Release. The 1.0.0 tag's automated build failed at packaging (electron-builder tried to publish on its own without a token), so 1.0.1 is the first release with downloadable installers. No changes to the app itself.

## 1.0.0 (2026-09-13)

First release of MP3 Bulk Compressor Desktop for macOS and Windows, ported from the Android app (v2.0).

- Compress a folder (optionally with all subfolders), a selection of files, or anything dragged onto the window, the Dock icon or Finder's "Open With".
- Same presets (Keep original, Podcast, HQ Music), settings and per-file rules as Android: bitrate never raised, no upsampling, mono stays mono, skip files that wouldn't shrink.
- LAME 3.100 encoder with the Android app's configuration; ID3v1/ID3v2 tags and cover art copied byte for byte; Xing/LAME header written for VBR/ABR.
- **High-pass filter now works.** LAME ignores an 80 Hz high-pass (it prints "highpass filter disabled"), which also affects the Android app. The desktop engine filters the audio itself before encoding.
- Safety pipeline: encode to temp → full decode check → exclusive write beside the original → CRC-32 read-back → (optional) original to Trash / Recycle Bin, then rename.
- Parallel workers, live per-file progress, Dock/taskbar progress, completion notification, keep-awake during batches, confirm before quitting mid-batch, Stop at any time.
- Results with Show in Finder / File Explorer, copyable log, remembered preferences, light and dark appearance.
- Installers: macOS `.dmg` for Apple Silicon and Intel; Windows NSIS installer and a portable no-install `.exe`, each for x64 and ARM64.
