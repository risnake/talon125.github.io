// Loads the game's JSON data.
//
// Served over HTTP these fetch normally. When the game is built as a standalone
// bundle the same files are baked into a global by build/embed-json.mjs, because
// fetch() cannot read file:// URLs — the loaders then resolve from memory and
// never touch the network.
const embedded = globalThis.__TL_EMBEDDED_JSON__

async function loadJson(url) {
  // Callers mutate what they get back, and fetch hands out a fresh object every
  // time, so the embedded copy has to be cloned to behave the same way.
  if (embedded && url in embedded) return structuredClone(embedded[url])
  const r = await fetch(url, { cache: "no-store" })
  return await r.json()
}

export async function loadGameType(name) {
  return await loadJson(`./gametypes/${name}.json`)
}
export async function loadMenu(name) {
  return await loadJson(`./ui/${name}.json`)
}
export async function loadSoundbank(name) {
  return await loadJson(`./se/game/${name}/info.json`)
}
export async function loadPiecebank(name) {
  return await loadJson(`./se/piece/${name}/info.json`)
}
export async function loadLanguage(name, file) {
  return await loadJson(`./lang/${name}/${file}.json`)
}
