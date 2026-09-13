# Building, testing and releasing

## Requirements

| Tool | Needed for | Install |
| --- | --- | --- |
| Node.js 22+ | everything | [nodejs.org](https://nodejs.org) or `brew install node` |
| Xcode command line tools | macOS engine | `xcode-select --install` |
| [zig](https://ziglang.org) 0.13+ | Windows engine (from any OS) | `brew install zig` / `winget install zig.zig` |
| `lame` CLI and Python 3 | only to regenerate test fixtures | `brew install lame` |

Windows builders need a Bash shell (Git Bash, which comes with Git for Windows) for `npm run build:engine`.

## 1. Native engine

The app runs a small native helper, `mp3bulk-engine`, for decoding and encoding. It's built from `engine/` and isn't committed.

```bash
npm run build:engine          # every target this machine can build
bash scripts/build-engine.sh mac   # macOS arm64 + x64 (on a Mac)
bash scripts/build-engine.sh win   # Windows x64 + arm64 (needs zig; works on macOS, Linux or Windows)
```

Binaries go to `resources/engine/<platform>-<arch>/`. Check one with:

```bash
resources/engine/darwin-arm64/mp3bulk-engine version
# mp3bulk-engine 1.0.0 (LAME 3.100, minimp3)
```

The engine's command-line protocol is documented at the top of [`engine/mp3bulk_engine.c`](../engine/mp3bulk_engine.c).

## 2. Run from source

```bash
npm install
npm start
```

## 3. Tests

```bash
npm test           # unit + integration tests (node:test), needs the engine for your machine
npm run test:e2e   # launches the real app and drives the UI with Playwright
```

| Suite | What it covers |
| --- | --- |
| `test/settings.test.js` | Planning rules (bitrate never raised, no upsampling, mono stays mono, CBR snapping), presets, input sanitising. Mirrors the Android `PlanTest`. |
| `test/probe.test.js` | Header parsing for CBR/VBR/ABR, MPEG-2, ID3v1/v2, VBRI/Xing, untagged VBR, garbage. Mirrors the Android `ProbeTest`. |
| `test/files.test.js` | Folder scanning, skipping outputs and hidden files, unique names, verified writes that never overwrite. |
| `test/transcoder.test.js` | Real encodes through the engine: every preset and mode, tags copied byte for byte, replace via Trash, Trash failure, damaged and non-MP3 sources, Unicode names, cancelling, parallel batches. |
| `test/e2e/app.e2e.js` | The UI: folder picking, subfolder switch, presets and chips, a "copy" batch and a "replace" batch, results and log. Dialogs and the Trash are stubbed so nothing outside a temp folder is touched. |

To test a packaged build instead of the source tree:

```bash
APP_PATH="dist/mac-arm64/MP3 Bulk Compressor Desktop.app/Contents/MacOS/MP3 Bulk Compressor Desktop" npm run test:e2e
```

`SCREENSHOTS=1 npm run test:e2e` also refreshes `docs/screenshot-*.png`.

To change the integration fixtures in `test/fixtures/full/`, run `npm run fixtures`. They're generated with the `lame` CLI and committed.

## 4. Installers

```bash
npm run dist:mac   # dist/MP3-Bulk-Compressor-Desktop-<v>-mac-arm64.dmg / -x64.dmg (+ .zip)
npm run dist:win   # dist/MP3-Bulk-Compressor-Desktop-Setup-<v>-win-x64.exe / -arm64.exe
                   #   + dist/MP3-Bulk-Compressor-Desktop-Portable-<v>-win-x64.exe / -arm64.exe
```

Both work on a Mac. Windows installers are built with NSIS and include the Windows engine built by zig. Each installer contains only the engine for its own CPU architecture (see `extraResources` in `package.json`).

The **portable** Windows build is a single `.exe` that runs without installing: it unpacks itself to a temporary folder on each launch (so it starts a little slower) and leaves no shortcuts or uninstaller. Preferences are still stored in the user's AppData.

The Windows installer offers a per-user install by default (no admin prompt) and lets the user change the install folder. It adds Start menu and desktop shortcuts and an uninstaller.

### Code signing (optional, recommended for public releases)

Builds are unsigned by default. macOS apps are ad-hoc signed so they run on Apple Silicon. Without real signatures, users see the Gatekeeper / SmartScreen prompts described in the README.

**macOS**: needs an Apple Developer ID Application certificate and notarization:

1. In `package.json`, remove `"identity": "-"` and set `"hardenedRuntime": true` under `build.mac`.
2. Export these environment variables before `npm run dist:mac`:
   ```bash
   export CSC_LINK=/path/to/DeveloperID.p12  CSC_KEY_PASSWORD=…
   export APPLE_ID=you@example.com APPLE_APP_SPECIFIC_PASSWORD=… APPLE_TEAM_ID=XXXXXXXXXX
   ```
3. Add `"notarize": true` under `build.mac`.

**Windows**: set `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` to a code-signing certificate (or configure Azure Trusted Signing), then run `npm run dist:win` on Windows or in CI.

## 5. Releasing with GitHub Actions

[`.github/workflows/build.yml`](../.github/workflows/build.yml) runs on every push and pull request, on real macOS and Windows machines. It:

1. builds the engine (clang on macOS, zig on Windows),
2. runs `npm test` and the UI test,
3. on a version tag, builds the installers and attaches them to a GitHub Release.

To publish a release:

```bash
npm version 1.0.1          # bumps package.json and creates the tag v1.0.1
git push --follow-tags
```

You can also run the workflow by hand (**Actions → Build → Run workflow**) to get installers as downloadable artifacts without creating a release.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `Engine not built (…)` when running tests | `npm run build:engine` |
| `Couldn't start the encoder` in the app | The engine for this platform/arch is missing from `resources/engine/`; rebuild it. |
| Tests pass but the UI test can't find Electron | `npm install` again (downloads the Electron binary). |
| Rosetta: x64 engine on Apple Silicon | Nothing to do; each build uses the engine matching its own architecture. |
