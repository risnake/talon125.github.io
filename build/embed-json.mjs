#!/usr/bin/env node
// Collects every JSON file the game loads at runtime into a single JS object.
//
// script/loaders.js normally fetches these one at a time, which is fine over
// HTTP but impossible from file:// — fetch() rejects opaque origins outright.
// The generated file assigns the whole set to a global that loaders.js reads
// before falling back to fetch.
//
// Usage: node build/embed-json.mjs [outfile]

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
export const GLOBAL_KEY = "__TL_EMBEDDED_JSON__"

// Mirrors the paths built by the loaders in script/loaders.js.
const SOURCES = ["gametypes", "ui", "lang", "se/game", "se/piece"]

async function* walk(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.name.endsWith(".json")) yield full
  }
}

export async function collect() {
  const assets = {}
  for (const source of SOURCES) {
    for await (const file of walk(path.join(ROOT, source))) {
      // Keys are the same "./path/to.json" strings the loaders pass to fetch.
      const key = `./${path.relative(ROOT, file).split(path.sep).join("/")}`
      assets[key] = JSON.parse(await readFile(file, "utf8"))
    }
  }
  return assets
}

export async function generate() {
  const assets = await collect()
  const body = JSON.stringify(assets)
  return {
    assets,
    count: Object.keys(assets).length,
    source: `globalThis.${GLOBAL_KEY} = ${body};\n`,
    bytes: Buffer.byteLength(body),
  }
}

if (process.argv[1] === import.meta.filename) {
  const out = process.argv[2] ?? path.join(ROOT, "build/dist/embedded-json.js")
  const { source, count, bytes } = await generate()
  await mkdir(path.dirname(out), { recursive: true })
  await writeFile(out, source)
  console.log(
    `embedded ${count} JSON files (${(bytes / 1024).toFixed(0)} KB) -> ${path.relative(ROOT, out)}`
  )
}
