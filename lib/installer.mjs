/**
 * Applying an update: the DSH CLI performs the install, this module is the safety
 * net around it.
 *
 * Why the CLI and not pnpm directly: `dsh plugin add` is the harness's own
 * installer. It knows the registry fallbacks, the freshness gate, the
 * build-script allow-list and the version-compatibility rules this deployment
 * enforces. Re-implementing that here would drift from the harness the first time
 * any of it changes.
 *
 * Why a safety net at all: the CLI edits the profile's `package.json`, including
 * `dsh.profile.bundles` - the list that decides which installed packages are
 * actually MOUNTED. That list has already been damaged once on this machine by a
 * batch update, which silently unmounted a working plugin: the dependency stayed,
 * the mount vanished, and nothing said so. A page whose whole point is "your
 * plugins, and whether they are current" must not be the thing that removes one.
 *
 * So every update is bracketed:
 *
 *   1. snapshot the manifest's bundle list;
 *   2. run the CLI;
 *   3. re-read and compare;
 *   4. if anything that was mounted is no longer mounted, put it back - and say so
 *      in the result, because a silent repair is indistinguishable from a bug.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'

/** Upper bound on CLI output kept for the page, in characters. */
const MAX_OUTPUT = 6000

/**
 * Where the harness keeps its own CLI and command wrapper, derived from the
 * running executable rather than guessed.
 *
 * The Electron binary sits beside `resources/`, so this is exact for the desktop
 * application. `dsh.cmd` is returned as well because it is the documented entry
 * point and the first thing to try if the direct form ever changes shape.
 * @param execPath - `process.execPath`.
 * @returns both paths; the caller checks they exist.
 */
export function cliPaths(execPath) {
  const root = dirname(execPath)
  return {
    cli: join(root, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
    cmd: join(root, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
  }
}

/**
 * Read a profile manifest.
 * @param manifestPath - absolute path of the profile's `package.json`.
 * @returns `{ raw, manifest, bundles, dependencies }` or undefined.
 */
export function readProfileManifest(manifestPath) {
  try {
    const raw = readFileSync(manifestPath, 'utf8')
    const manifest = JSON.parse(raw)
    const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
    const dependencies = manifest !== null && typeof manifest.dependencies === 'object' && manifest.dependencies !== null
      ? manifest.dependencies
      : {}
    return { raw, manifest, bundles, dependencies }
  } catch {
    return undefined
  }
}

/**
 * Compare the bundle list before and after an install.
 *
 * `missing` is the one that matters: a name that was mounted and no longer is.
 * `duplicates` is cosmetic but worth cleaning while we are here.
 * @param before - bundle names before the CLI ran.
 * @param after - bundle names after the CLI ran.
 * @returns `{ ok, missing, duplicates }`.
 */
export function bundleAudit(before, after) {
  const beforeList = Array.isArray(before) ? before : []
  const afterList = Array.isArray(after) ? after : []
  const missing = beforeList.filter(name => !afterList.includes(name))
  const seen = new Set()
  const duplicates = []
  for (const name of afterList) {
    if (seen.has(name)) duplicates.push(name)
    seen.add(name)
  }
  return { ok: missing.length === 0 && duplicates.length === 0, missing, duplicates }
}

/**
 * Restore any mount the CLI dropped, and de-duplicate while we are in there.
 *
 * Only names that were present BEFORE the operation are restored: this is a
 * repair, not an opinion about what should be mounted. A package the harness
 * deliberately does not mount stays unmounted.
 * @param manifestPath - the profile manifest.
 * @param beforeBundles - the snapshot taken before the CLI ran.
 * @returns `{ changed, bundles, backup }`.
 */
export function repairManifest(manifestPath, beforeBundles) {
  const current = readProfileManifest(manifestPath)
  if (current === undefined) return { changed: false, bundles: [], backup: null, error: '清单读不出来' }

  const seen = new Set()
  const next = []
  for (const name of current.bundles) {
    if (seen.has(name)) continue
    seen.add(name)
    next.push(name)
  }
  const restored = []
  for (const name of Array.isArray(beforeBundles) ? beforeBundles : []) {
    if (seen.has(name)) continue
    seen.add(name)
    next.push(name)
    restored.push(name)
  }
  const changed = next.length !== current.bundles.length
    || next.some((name, index) => name !== current.bundles[index])
  if (!changed) return { changed: false, bundles: next, backup: null }

  // The manifest is the profile's own file: it gets a real backup before the
  // rewrite, next to itself, so a bad repair is one rename away from undone.
  const backup = `${manifestPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  let wrote = false
  try {
    copyFileSync(manifestPath, backup)
  } catch {
    // A failed backup is a reason not to touch the file at all.
    return { changed: false, bundles: current.bundles, backup: null, error: '备份失败，已放弃改写' }
  }
  const manifest = current.manifest
  manifest.dsh.profile.bundles = next
  try {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    wrote = true
  } catch {
    wrote = false
  }
  return { changed: wrote, bundles: wrote ? next : current.bundles, backup, restored, error: wrote ? null : '改写失败' }
}

/**
 * Run `dsh plugin add <spec>` through the harness's own CLI.
 *
 * @param options - `{ execPath, profile, spec, cwd, timeoutMs, spawnImpl }`.
 *   `spawnImpl` exists so the offline suite can drive every outcome - success,
 *   non-zero exit, silence, a hang - without running pnpm at all.
 * @returns `{ code, output, timedOut, error }`.
 */
export function runPluginAdd(options) {
  const {
    execPath,
    profile,
    spec,
    cwd,
    timeoutMs = 300000,
    spawnImpl = spawn,
  } = options

  const paths = cliPaths(execPath)
  if (!existsSync(paths.cli)) {
    return Promise.resolve({ code: -1, output: '', error: `找不到 DSH 的命令行入口：${paths.cli}` })
  }

  const args = ['--expose-internals', paths.cli, 'plugin', '--profile', profile, 'add', spec]
  return new Promise((resolve) => {
    let child
    try {
      child = spawnImpl(execPath, args, {
        cwd,
        // The same mode switch the harness's own wrapper uses: this executable
        // runs cli.js as a Node program, not as the application.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ code: -1, output: '', error: String(error?.message ?? error) })
      return
    }

    let output = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const collect = (chunk) => {
      output = (output + chunk.toString()).slice(-MAX_OUTPUT)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.once('error', error => finish({ code: -1, output, error: String(error?.message ?? error) }))

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // The timeout is reported either way.
      }
      finish({ code: -1, output, timedOut: true, error: `超过 ${Math.round(timeoutMs / 1000)} 秒未完成，已中止` })
    }, timeoutMs)

    child.once('close', code => finish({ code: typeof code === 'number' ? code : -1, output }))
  })
}

/** The last few non-empty lines of CLI output, for the page. */
export function outputTail(output, lines = 6) {
  const kept = String(output ?? '')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.length > 0)
    .slice(-lines)
  return kept.join('\n')
}
