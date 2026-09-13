# Third-party notices

MP3 Bulk Compressor Desktop itself is licensed under the [MIT License](LICENSE). It includes the following open-source software, which keeps its own licenses. The license texts ship inside the installed app (**Help → Third-party Licenses**, or the `licenses` folder in the app's resources).

## LAME 3.100

- Source: `engine/third_party/lame/` (unmodified LAME 3.100 `libmp3lame` sources, plus a minimal `config.h`)
- Website: https://lame.sourceforge.io/
- License: GNU Library General Public License, version 2 ([`engine/third_party/lame/COPYING`](engine/third_party/lame/COPYING))

LAME is statically linked into the `mp3bulk-engine` helper program. As the LGPL requires, the complete source for LAME and for the program that links it (`engine/mp3bulk_engine.c`), with build scripts (`scripts/build-engine.sh`), is in this repository, so you can modify LAME and rebuild the helper. The helper is a separate executable from the rest of the app and can be replaced on its own.

## minimp3

- Source: `engine/third_party/minimp3/` (`minimp3.h`, `minimp3_ex.h`)
- Website: https://github.com/lieff/minimp3
- License: CC0 1.0 Universal (public domain dedication) ([`engine/third_party/minimp3/LICENSE`](engine/third_party/minimp3/LICENSE))

## Electron

- Website: https://www.electronjs.org/
- License: MIT. Electron also bundles Chromium and Node.js; their notices ship with the app as `LICENSES.chromium.html` and `LICENSE`.
