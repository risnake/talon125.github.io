#!/usr/bin/env node
// Builds the game into a single classic script that runs without a web server.
//
// Two things stop the source tree from opening over file://:
//   - app.js is an ES module, and modules are fetched under CORS rules that a
//     file:// origin can never satisfy, so nothing loads at all;
//   - script/loaders.js fetches its JSON, and fetch() rejects file:// outright.
// esbuild solves the first by flattening the module graph into one IIFE, and
// embed-json.mjs solves the second by baking the JSON into the bundle.
//
// Asset folders are linked into the output by default so the build stays cheap
// to re-run; pass --copy-assets for a dist/ that can be moved or zipped.
//
// Usage: node build/build.mjs [--minify] [--copy-assets] [--outdir DIR]

import { build } from "esbuild"
import { readFile, writeFile, mkdir, copyFile, symlink, rm, cp } from "node:fs/promises"
import path from "node:path"
import { generate, GLOBAL_KEY } from "./embed-json.mjs"

const ROOT = path.resolve(import.meta.dirname, "..")
const argv = process.argv.slice(2)
const minify = argv.includes("--minify")
const copyAssets = argv.includes("--copy-assets")
const outdirFlag = argv.indexOf("--outdir")
const OUT = path.resolve(
  ROOT,
  outdirFlag === -1 ? "build/dist" : argv[outdirFlag + 1]
)

// Google Analytics is loaded from a <script> in index.html that cannot resolve
// offline, which would leave gtag() undefined -- and game.js calls it on every
// game start. Stub it before the bundle runs.
const GTAG_STUB = `globalThis.gtag ||= function () {};\n`

// Everything the page loads by relative path once it is running.
const ASSET_DIRS = ["bgm", "se", "vox", "img", "vid", "css", "fonts", "lib"]
const ROOT_FILES = [
  "favicon.ico",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "apple-touch-icon.png",
  "safari-pinned-tab.svg",
  "site.webmanifest",
  "browserconfig.xml",
]

await mkdir(OUT, { recursive: true })

const { source: embeddedJson, count, bytes } = await generate()

const result = await build({
  entryPoints: [path.join(ROOT, "app.js")],
  bundle: true,
  format: "iife",
  target: ["chrome98", "firefox94", "safari15"],
  outfile: path.join(OUT, "app.bundle.js"),
  banner: { js: GTAG_STUB + embeddedJson },
  minify,
  sourcemap: !minify,
  legalComments: "inline",
  logLevel: "warning",
  // Howler, Gamepad and seedrandom are classic scripts loaded from lib/ before
  // the bundle; they attach to window rather than being importable modules.
  external: [],
  metafile: true,
})

// The standalone page differs from index.html in three ways: no analytics
// (nothing can reach the network), a classic script instead of a module, and
// relative icon paths -- "/favicon-32x32.png" resolves to the filesystem root
// when the page is opened from disk.
let html = await readFile(path.join(ROOT, "index.html"), "utf8")
html = html
  .replace(
    /\s*<!-- Global site tag \(gtag\.js\) - Google Analytics -->[\s\S]*?<\/script>\s*<script>[\s\S]*?gtag\("config"[\s\S]*?<\/script>/,
    ""
  )
  .replace('<script type="module" src="app.js"></script>', '<script src="app.bundle.js"></script>')
  .replace(/(href|src)="\/(?!\/)/g, '$1="./')

await writeFile(path.join(OUT, "index.html"), html)

for (const name of ROOT_FILES) {
  await copyFile(path.join(ROOT, name), path.join(OUT, name)).catch(() => {})
}

for (const dir of ASSET_DIRS) {
  const dest = path.join(OUT, dir)
  await rm(dest, { recursive: true, force: true })
  if (copyAssets) await cp(path.join(ROOT, dir), dest, { recursive: true })
  else await symlink(path.relative(OUT, path.join(ROOT, dir)), dest, "dir")
}

const bundleBytes = Object.values(result.metafile.outputs).find((o) => o.entryPoint)?.bytes ?? 0
const kb = (n) => `${(n / 1024).toFixed(0)} KB`

console.log(`embedded JSON : ${count} files, ${kb(bytes)}`)
console.log(`bundle        : ${kb(bundleBytes)}${minify ? " (minified)" : ""} -> ${path.relative(ROOT, OUT)}/app.bundle.js`)
console.log(`page          : ${path.relative(ROOT, OUT)}/index.html`)
console.log(`assets        : ${ASSET_DIRS.length} folders ${copyAssets ? "copied" : "symlinked"}, ${ROOT_FILES.length} root files copied`)
console.log(`\nOpen ${path.relative(ROOT, OUT)}/index.html directly in a browser.`)
