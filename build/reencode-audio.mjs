#!/usr/bin/env node
// Re-encodes the game's Ogg Vorbis assets at sane bitrates.
//
// The source audio is encoded far above what the game needs: voice clips sit at
// 500-568 kbps and sound effects at 192 kbps. Re-encoding at -q:a 3/4 cuts the
// audio tree by roughly half with no practical quality cost.
//
// Channel count and sample rate are left alone on purpose. The clips look like
// mono speech but measuring L-R shows genuinely decorrelated channels (the
// difference signal on se/menu/select.ogg peaks only 0.4 dB below the source),
// so downmixing would audibly change them.
//
// Anything the game loops has to keep its exact decoded length: libvorbis pads
// or trims to a block boundary, and on a looping track that shows up as a click
// or a stutter at the seam. Those files are re-encoded, checked frame by frame,
// and left at the original if the length moved at all.
//
// Every file written is tagged TL_REENCODE so a second run skips it rather than
// stacking a fresh generation of lossy encoding on top of the last one.
//
// Usage: node build/reencode-audio.mjs [--dry-run] [--jobs N] [dir ...]

import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { readdir, stat, rename, unlink } from "node:fs/promises"
import { cpus } from "node:os"
import path from "node:path"

const run = promisify(execFile)
const ROOT = path.resolve(import.meta.dirname, "..")
const TAG = "TL_REENCODE"

// Quality per tree. Music gets a little more headroom than speech and effects.
const PROFILES = [
  { dir: "bgm", quality: 4 },
  { dir: "se", quality: 3 },
  { dir: "vox", quality: 3 },
]

// Sound effects the game loops via sound.startSeLoop(); see piece.js and stack.js.
const LOOPED_SE = ["alarm.ogg", "topoutwarning.ogg"]

// Everything under bgm/ is looped by sound.loadBgm(), plus the two looping effects.
function mustKeepLength(file) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/")
  return rel.startsWith("bgm/") || LOOPED_SE.includes(path.basename(rel))
}

// Container duration is not reliable here, so count the frames the decoder emits.
function decodedFrames(file) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-v", "error", "-i", file, "-f", "s16le", "-ac", "2", "-ar", "44100", "-",
    ])
    let bytes = 0
    ff.stdout.on("data", (chunk) => (bytes += chunk.length))
    ff.stderr.resume()
    ff.on("close", (code) =>
      code === 0 ? resolve(bytes / 4) : reject(new Error(`could not decode ${file}`))
    )
  })
}

const argv = process.argv.slice(2)
const dryRun = argv.includes("--dry-run")
const jobsFlag = argv.indexOf("--jobs")
const jobs = jobsFlag === -1 ? cpus().length : Number(argv[jobsFlag + 1])
const only = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--jobs")

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
    else if (entry.name.endsWith(".ogg")) yield full
  }
}

async function alreadyDone(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", `stream_tags=${TAG}`,
    "-of", "default=nw=1:nk=1",
    file,
  ])
  return stdout.trim() !== ""
}

async function reencode(file, quality) {
  const before = (await stat(file)).size
  if (await alreadyDone(file)) return { file, before, after: before, skipped: "tagged" }
  if (dryRun) return { file, before, after: before, skipped: "dry-run" }

  const tmp = `${file}.tmp.ogg`
  try {
    await run("ffmpeg", [
      "-v", "error", "-y",
      "-i", file,
      "-c:a", "libvorbis",
      "-q:a", String(quality),
      "-metadata", `${TAG}=q${quality}`,
      tmp,
    ])
  } catch (error) {
    await unlink(tmp).catch(() => {})
    return { file, before, after: before, skipped: "failed", error }
  }

  const after = (await stat(tmp)).size
  // Re-encoding an already-lean file can come out larger; keep whichever is smaller.
  if (after >= before) {
    await unlink(tmp)
    return { file, before, after: before, skipped: "no-gain" }
  }
  // A looping track that changed length would click at the seam. libvorbis
  // quantises to a block boundary and no amount of padding lands on an arbitrary
  // target, so the only safe move is to leave the file alone.
  if (mustKeepLength(file)) {
    const [originalFrames, newFrames] = await Promise.all([
      decodedFrames(file),
      decodedFrames(tmp),
    ])
    if (originalFrames !== newFrames) {
      await unlink(tmp)
      return { file, before, after: before, skipped: "length-changed" }
    }
  }
  await rename(tmp, file)
  return { file, before, after }
}

async function pool(items, worker, limit) {
  const results = []
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        results[index] = await worker(items[index])
      }
    })
  )
  return results
}

const mb = (bytes) => (bytes / 1048576).toFixed(1)

const targets = PROFILES.filter((p) => only.length === 0 || only.includes(p.dir))
let grandBefore = 0
let grandAfter = 0

for (const { dir, quality } of targets) {
  const files = []
  for await (const file of walk(path.join(ROOT, dir))) files.push(file)
  if (files.length === 0) continue

  process.stdout.write(`${dir}/  ${files.length} files at -q:a ${quality} ... `)
  const results = await pool(files, (file) => reencode(file, quality), jobs)

  const before = results.reduce((sum, r) => sum + r.before, 0)
  const after = results.reduce((sum, r) => sum + r.after, 0)
  grandBefore += before
  grandAfter += after

  const counts = {}
  for (const r of results) if (r.skipped) counts[r.skipped] = (counts[r.skipped] ?? 0) + 1
  const notes = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ")
  console.log(
    `${mb(before)} MB -> ${mb(after)} MB ` +
    `(-${(100 - (100 * after) / before).toFixed(0)}%)${notes ? `  [${notes}]` : ""}`
  )

  for (const r of results) {
    if (r.skipped === "failed") console.error(`  failed: ${path.relative(ROOT, r.file)}`)
  }
}

if (grandBefore > 0) {
  console.log(
    `\ntotal  ${mb(grandBefore)} MB -> ${mb(grandAfter)} MB ` +
    `(saved ${mb(grandBefore - grandAfter)} MB, -${(100 - (100 * grandAfter) / grandBefore).toFixed(0)}%)`
  )
}
