/**
 * Read the installed-plugin inventory out of a DSH profile.
 *
 * The profile's own `package.json` is the authoritative record of what the user
 * installed and how: `dependencies` names each package and its install spec, and
 * `dsh.profile.bundles` says which of them the loader actually mounts. The
 * package directories supply what the spec cannot - the resolved version, the
 * description, and the icon.
 *
 * Icons follow `dsh-app-boot`'s `iconOf` rules exactly (SVG/PNG/JPEG/WebP, a
 * relative path that resolves inside the manifest's own directory, at most 256
 * KiB). This module returns the FILE and its media type rather than a data URL:
 * the list is fetched as JSON, and inlining every icon would put megabytes of
 * base64 into a settings page that may not even scroll to them.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isUserInstalled, parseSpec } from './updates.mjs'

/** Maximum raw icon bytes admitted, matching the kernel's own limit. */
export const MAX_ICON_BYTES = 256 * 1024

/** Extensions the kernel accepts for a plugin icon. */
const ICON_MEDIA_TYPES = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
])

/** Parse one JSON file, or answer undefined. */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Pick the profile directory out of the candidate list.
 *
 * A candidate qualifies only when it really is a profile: a `package.json`
 * carrying `dsh.profile`. Guessing from the working directory alone would put
 * the page on whatever directory the process happened to start in.
 * @param candidates - directories to try, most specific first.
 * @returns `{ dir, manifest, manifestPath, source }` or undefined.
 */
export function resolveProfile(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    const manifestPath = join(candidate, 'package.json')
    const manifest = readJson(manifestPath)
    if (manifest === undefined) continue
    if (manifest.dsh === undefined || typeof manifest.dsh !== 'object') continue
    if (manifest.dsh.profile === undefined || manifest.dsh.profile === null) continue
    return { dir: candidate, manifest, manifestPath, source: candidate }
  }
  return undefined
}

/**
 * Resolve one icon path the way the kernel does.
 *
 * Containment is checked after `realpathSync`, so a symlink pointing outside the
 * package is refused rather than followed: the icon is read by the Host on
 * behalf of a page, and it must not become a file-read primitive.
 * @param manifestPath - absolute path of the owning `package.json`.
 * @param value - the manifest's `icon` field.
 * @returns `{ file, mediaType, bytes }`, or undefined when there is no usable icon.
 */
export function readIcon(manifestPath, value) {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const icon = value.trim()
  if (isAbsolute(icon) || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon)) return undefined
  const mediaType = ICON_MEDIA_TYPES.get(extname(icon).toLowerCase())
  if (mediaType === undefined) return undefined
  try {
    const directory = realpathSync(dirname(manifestPath))
    const file = realpathSync(resolve(directory, icon))
    const local = relative(directory, file)
    if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return undefined
    const stat = statSync(file)
    if (!stat.isFile() || stat.size > MAX_ICON_BYTES) return undefined
    return { file, mediaType, bytes: stat.size }
  } catch {
    return undefined
  }
}

/**
 * Read one installed package's manifest.
 * @param profileDir - the profile root.
 * @param name - package name, scoped names included.
 * @returns the parsed manifest, or undefined when it is not installed.
 */
export function readPackageManifest(profileDir, name) {
  const dir = join(profileDir, 'node_modules', ...name.split('/'))
  const manifestPath = join(dir, 'package.json')
  const manifest = readJson(manifestPath)
  if (manifest === undefined) return undefined
  return { manifest, manifestPath, dir }
}

/**
 * The commit a git-hosted install actually came from.
 *
 * A plain `dsh plugin add github:Owner/repo` records the spec without a ref, so
 * the only place the resolved commit survives is `pnpm-lock.yaml` — there the
 * importer entry resolves to `.../tar.gz/<sha>`. Without this the update check
 * cannot tell whether the default branch has moved.
 *
 * @param dir - the profile directory.
 * @param name - package name as it appears in the lockfile's importers block.
 * @returns the 40-character commit, or '' when there is nothing to read.
 */
export function readLockedCommit(dir, name) {
  try {
    // Normalise line endings first: Windows profiles write CRLF, and every
    // pattern below is anchored on a bare newline.
    const text = readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8').replace(/\r\n/g, '\n')
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Importer entries are indented; the resolved `version:` line follows within
    // a line or two and is the only place the commit appears.
    const anchor = new RegExp(`\\n {2,10}${escaped}:\\n`).exec(text)
    if (anchor === null) return ''
    const tail = text.slice(anchor.index, anchor.index + 400)
    const sha = /([0-9a-f]{40})/i.exec(tail)
    return sha === null ? '' : sha[1].toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Build the whole inventory.
 *
 * @param options - `{ candidates }`: profile directories to try in order.
 * @returns `{ ok, profileDir, plugins, summary, error }`. `ok` is false only
 *   when no profile could be found at all; an unreadable single package is
 *   reported as that plugin's `installed: false` instead of failing the page.
 */
export function readInventory({ candidates }) {
  const profile = resolveProfile(candidates)
  if (profile === undefined) {
    return {
      ok: false,
      error: '没有找到 DSH profile（候选目录里都没有带 dsh.profile 的 package.json）',
      candidates,
      profileDir: null,
      plugins: [],
      summary: { total: 0, github: 0, npm: 0, other: 0, installed: 0 },
    }
  }

  const dependencies = profile.manifest.dependencies !== null && typeof profile.manifest.dependencies === 'object'
    ? profile.manifest.dependencies
    : {}
  const bundles = Array.isArray(profile.manifest?.dsh?.profile?.bundles)
    ? profile.manifest.dsh.profile.bundles
    : []

  const plugins = []
  for (const [name, spec] of Object.entries(dependencies)) {
    if (!isUserInstalled(name, spec)) continue
    const source = parseSpec(spec)
    // A bare `github:Owner/repo` spec carries no ref; take the resolved commit
    // from the lockfile so "has the branch moved?" has something to compare to.
    if (source.kind === 'github' && (typeof source.ref !== 'string' || source.ref === '')) {
      const locked = readLockedCommit(profile.dir, name)
      if (locked !== '') source.ref = locked
    }
    const found = readPackageManifest(profile.dir, name)
    const manifest = found?.manifest
    const icon = found === undefined ? undefined : readIcon(found.manifestPath, manifest?.icon)
    plugins.push({
      name,
      version: typeof manifest?.version === 'string' ? manifest.version : null,
      description: typeof manifest?.description === 'string' ? manifest.description : '',
      installed: found !== undefined,
      mounted: bundles.includes(name),
      spec,
      source,
      icon: icon === undefined ? null : { mediaType: icon.mediaType, bytes: icon.bytes },
    })
  }

  plugins.sort((left, right) => left.name.localeCompare(right.name))

  return {
    ok: true,
    profileDir: profile.dir,
    candidates,
    plugins,
    summary: {
      total: plugins.length,
      github: plugins.filter(plugin => plugin.source.kind === 'github').length,
      npm: plugins.filter(plugin => plugin.source.kind === 'npm').length,
      other: plugins.filter(plugin => plugin.source.kind !== 'github' && plugin.source.kind !== 'npm').length,
      installed: plugins.filter(plugin => plugin.installed).length,
    },
  }
}
