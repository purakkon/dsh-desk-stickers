/**
 * Settings store for dsh-desk-stickers.
 *
 * One JSON file per machine, under `~/.dsh/data/desk-stickers/settings.json`.
 * Every feature keeps its own block so a later feature can grow without
 * rewriting the others, and an unknown/corrupt file never breaks boot: the
 * normalizer always returns a complete, valid shape.
 *
 * Colour slots are declared now (mode `auto` follows the active skin, `custom`
 * is an explicit hex value) even though only the note switch is wired in 0.1.0.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DIR = join(homedir(), '.dsh', 'data', 'desk-stickers')
export const SETTINGS_FILE = join(DIR, 'settings.json')

/** Feature keys, in the order the settings page shows them. */
export const FEATURES = Object.freeze(['restart', 'plugins', 'pinTop', 'sidebarFold', 'stickyNote'])

const DEFAULT_COLOR = Object.freeze({ mode: 'custom', off: '#9aa0a6', on: '#4b8bf5' })

export const DEFAULT_SETTINGS = Object.freeze({
  restart: Object.freeze({ enabled: true }),
  plugins: Object.freeze({ enabled: true, checkAllOnOpen: false }),
  // The pin ships with two explicit colours; the fold bars ship following the
  // skin, because they sit inside the sidebar's own header row.
  // The pin has one colour only: the jelly pop already tells the two states apart.
  pinTop: Object.freeze({ enabled: true, color: Object.freeze({ mode: 'auto', value: '' }) }),
  sidebarFold: Object.freeze({ enabled: true, color: Object.freeze({ mode: 'auto', off: '#9aa0a6', on: '#4b8bf5' }) }),
  stickyNote: Object.freeze({ enabled: true, theme: 'auto' }),
})

const HEX = /^#[0-9a-fA-F]{6}$/

/** Bumped when the default colour posture changes. */
const COLOR_VERSION = 2

function normalizeColor(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  // Two states plus one switch:
  //   mode custom  → the two hexes below are used
  //   mode auto    → the sticker follows the active skin, hexes kept for later
  // `value` from 0.2.x is read once so an existing custom colour is not lost.
  const legacy = typeof value.value === 'string' && HEX.test(value.value.trim()) ? value.value.trim().toLowerCase() : ''
  // Anything that does not explicitly say "custom" follows the skin: the default
  // posture is sampling, so a dropped or half-written block must not fall back to
  // a hard-coded grey.
  const mode = value.mode === 'custom' ? 'custom' : 'auto'
  const read = (candidate, fallback) => {
    const text = typeof candidate === 'string' ? candidate.trim().toLowerCase() : ''
    if (HEX.test(text)) return text
    return legacy !== '' ? legacy : fallback
  }
  return {
    mode,
    off: read(value.off, DEFAULT_COLOR.off),
    on: read(value.on, DEFAULT_COLOR.on),
  }
}

/** One colour, for stickers whose pressed state is shown by motion instead. */
function normalizeSingleColor(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  const mode = value.mode === 'custom' ? 'custom' : 'auto'
  const candidates = [value.value, value.off, value.on]
  let hex = ''
  for (const candidate of candidates) {
    const text = typeof candidate === 'string' ? candidate.trim().toLowerCase() : ''
    if (HEX.test(text)) { hex = text; break }
  }
  return { mode: mode === 'custom' && hex === '' ? 'auto' : mode, value: hex };
}

function normalizeFeature(name, raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  const base = { ...DEFAULT_SETTINGS[name] }
  if (typeof value.enabled === 'boolean') base.enabled = value.enabled
  if ('color' in base) base.color = name === 'pinTop' ? normalizeSingleColor(value.color) : normalizeColor(value.color)
  if (name === 'plugins' && typeof value.checkAllOnOpen === 'boolean') base.checkAllOnOpen = value.checkAllOnOpen
  if (name === 'stickyNote' && typeof value.theme === 'string' && value.theme.trim() !== '') base.theme = value.theme.trim()
  return base
}

/** Coerce anything into a complete settings object. */
export function normalizeSettings(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const name of FEATURES) out[name] = normalizeFeature(name, value[name])
  // Fresh installs and anything saved before this version start out following
  // the theme: no click needed, and the explicit colours are kept on disk for
  // whoever turns custom mode back on.
  if (value.colorVersion !== COLOR_VERSION) {
    out.pinTop = Object.assign({}, out.pinTop, { color: Object.assign({}, DEFAULT_SETTINGS.pinTop.color) })
    out.sidebarFold = Object.assign({}, out.sidebarFold, { color: Object.assign({}, DEFAULT_SETTINGS.sidebarFold.color) })
  }
  out.colorVersion = COLOR_VERSION
  return out
}

/** Read the file, returning defaults when it is missing or unreadable. */
export async function loadSettings() {
  try {
    const text = await readFile(SETTINGS_FILE, 'utf8')
    return normalizeSettings(JSON.parse(text))
  } catch {
    return normalizeSettings(undefined)
  }
}

/**
 * Merge a partial patch into a settings object without dropping siblings.
 *
 * A shallow spread is not enough: the page sends `{ sidebarFold: { enabled } }`
 * when a switch is flipped and `{ sidebarFold: { color } }` when a colour row is
 * touched. Spreading those over the stored object replaces the whole feature
 * block, which used to reset the other half — flipping a switch silently threw
 * the colour back to custom and made the user click 「跟随皮肤」 again.
 *
 * @param {object} current previously stored settings.
 * @param {object} patch partial settings keyed by feature name.
 * @returns {object} a complete, normalized settings object.
 */
export function mergeSettings(current, patch) {
  const base = current !== null && typeof current === 'object' ? current : {}
  const incoming = patch !== null && typeof patch === 'object' ? patch : {}
  const out = {}
  for (const name of FEATURES) {
    const was = base[name] !== null && typeof base[name] === 'object' ? base[name] : {}
    const now = incoming[name] !== null && typeof incoming[name] === 'object' ? incoming[name] : {}
    const block = { ...was, ...now }
    if ('color' in was || 'color' in now) {
      const before = was.color !== null && typeof was.color === 'object' ? was.color : {}
      const after = now.color !== null && typeof now.color === 'object' ? now.color : {}
      block.color = { ...before, ...after }
    }
    out[name] = block
  }
  // The one-time colour migration keys off this marker, so it has to travel with
  // the merge: dropping it here would re-run "follow the skin" on every save and
  // silently undo a colour the user picked a second ago.
  out.colorVersion = base.colorVersion
  return normalizeSettings(out)
}

/**
 * Merge a partial patch into the stored settings and persist it.
 * @param {object} patch partial settings keyed by feature name.
 * @returns {Promise<object>} the complete settings after the write.
 */
export async function saveSettings(patch) {
  const current = await loadSettings()
  const merged = mergeSettings(current, patch)
  await mkdir(DIR, { recursive: true })
  await writeFile(SETTINGS_FILE, JSON.stringify(merged, null, 2) + '\n', 'utf8')
  return merged
}
