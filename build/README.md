# Build tooling

Nothing here is part of the deployed site. `index.html` still loads `app.js` as an
ES module and the game still runs from a plain static server exactly as before.
These scripts exist to produce a build that runs from local files, and to keep the
audio at a sane size.

```sh
cd build && npm install
```

## `build.mjs` — standalone build

```sh
node build/build.mjs                 # dist/ with asset folders symlinked
node build/build.mjs --copy-assets   # dist/ that can be moved or zipped
node build/build.mjs --minify
```

Writes `build/dist/`. Open `build/dist/index.html` straight from disk — no server.

Two things stop the source tree from being opened as a file, and the build fixes
both:

- `app.js` is an ES module. Modules are fetched under CORS rules that a `file://`
  origin can never satisfy, so nothing loads at all. esbuild flattens the module
  graph into one classic IIFE.
- `script/loaders.js` fetches its JSON, and `fetch()` rejects `file://` outright.
  `embed-json.mjs` bakes those files into the bundle instead.

It also drops the Google Analytics tags, which cannot resolve offline, and stubs
`gtag()` because `game.js` calls it on every game start. Root-absolute icon paths
like `/favicon-32x32.png` are rewritten relative, since they otherwise resolve to
the filesystem root.

### What still differs from the served site

Howler requests audio over XHR, which `file://` refuses. Howler falls back to an
HTML5 `<audio>` element and playback does work, but the console fills with CORS
errors and the HTML5 pool caps how many sounds can be in flight at once, so
effects can drop during a busy game. Serving `dist/` over any static server
avoids this entirely. Removing the fallback means embedding the audio as blob
URLs, which this build does not do.

## `embed-json.mjs` — JSON manifest

```sh
node build/embed-json.mjs [outfile]
```

Collects every JSON file the game loads at runtime — `gametypes/`, `ui/`, `lang/`,
and the `info.json` of each sound bank — and assigns them to a global keyed by the
same `./path/to.json` strings the loaders pass to `fetch`. `build.mjs` calls this
directly; running it standalone is only useful for inspecting the output.

`script/loaders.js` reads that global when it is present and falls back to `fetch`
when it is not, so the same source works both bundled and served. The embedded
copy is cloned on the way out, because callers mutate what they get back and
`fetch` hands out a fresh object every time.

## `reencode-audio.mjs` — audio

```sh
node build/reencode-audio.mjs [--dry-run] [--jobs N] [bgm|se|vox ...]
```

Requires `ffmpeg` on `PATH`. Already run once against the tree; it is here so the
settings are documented and reproducible for audio added later.

The original assets were encoded far above what the game needs — voice clips at
500-568 kbps, effects at 192 kbps. Re-encoding with libvorbis at `-q:a 3` for
speech and effects and `-q:a 4` for music took the audio from 144 MB to 88 MB.

Channel count and sample rate are deliberately untouched. The clips look like mono
speech, but the L-R difference signal on `se/menu/select.ogg` peaks only 0.4 dB
below the source, so the channels carry real content and a downmix would change
how they sound.

Anything the game loops keeps its exact decoded length: everything under `bgm/`,
plus the `alarm` and `topoutwarning` effects that `sound.startSeLoop()` loops.
libvorbis quantises to a block boundary, and no amount of input padding lands on
an arbitrary target length, so a file whose length moves is left at its original.
Eleven files fell into that case; the other 102 loop-critical files re-encoded
frame-exact.

Output is tagged `TL_REENCODE` so a second run skips it instead of stacking
another generation of lossy encoding.
