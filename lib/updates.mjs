/**
 * Where an installed plugin came from, and what a version check can do about it.
 *
 * Pure: no filesystem, no network. Everything here is a decision made from the
 * dependency spec the profile records, which is the only place the install
 * method survives - `node_modules` looks identical however a package got there.
 *
 * The four shapes seen in a real DSH profile:
 *
 *   "dsh-pet": "^0.3.7"                       npm range      -> registry /latest
 *   "dsh-grill-me": "github:Owner/repo#<sha>" GitHub, pinned -> commits?per_page=1
 *   "dsh-boot-animation": "link:C:/....".     local link     -> nothing to check
 *   "dsh-ops": "workspace:*"                  workspace      -> nothing to check
 */

import { join } from 'node:path'

/** Package scope whose packages ship with DSH and are not user-installed. */
const OFFICIAL_SCOPE = '@deepseek-ai/'

/**
 * Classify one dependency spec.
 *
 * @param spec - the value in the profile's `dependencies`.
 * @returns `{ kind }` plus the fields that kind needs. `kind` is one of
 *   `npm`, `github`, `link`, `local`, `unknown`.
 */
export function parseSpec(spec) {
  const value = typeof spec === 'string' ? spec.trim() : ''

  const link = /^link:(.*)$/i.exec(value)
  if (link !== null) return { kind: 'link', path: link[1] }

  if (/^(workspace|file|portal):/i.test(value)) return { kind: 'local', spec: value }

  // `github:Owner/repo#<ref>`, the form the DSH CLI writes for a pinned install.
  const github = /^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/)?([^/:\s]+)\/([^/#\s]+?)(?:\.git)?#([^\s]+)$/i.exec(value)
  if (github !== null && (value.startsWith('github:') || /github\.com/i.test(value) || /^[^/:\s]+\/[^/#\s]+#/i.test(value))) {
    return { kind: 'github', owner: github[1], repo: github[2], ref: github[3], spec: value }
  }

  // A bare `Owner/repo` (no ref) would need git to resolve a default branch,
  // which this machine cannot do; it stays npm-shaped only if it looks like one.
  if (value.length === 0) return { kind: 'unknown', spec: value }
  return { kind: 'npm', spec: value }
}

/**
 * Whether a dependency belongs on the "installed plugins" page at all.
 *
 * Official `@deepseek-ai/*` packages are the harness itself and are deliberately
 * excluded: the page is about what the user added.
 */
export function isUserInstalled(name, spec) {
  if (typeof name !== 'string' || name.length === 0) return false
  if (name.startsWith(OFFICIAL_SCOPE)) return false
  return parseSpec(spec).kind !== 'unknown'
}

/**
 * Compare two version strings.
 *
 * Deliberately small: split on the first `-`, compare the dotted numeric parts,
 * and treat a prerelease as lower than the same release. That covers every
 * version on this machine, and the suite pins the behaviour rather than
 * pretending to be a full semver implementation.
 *
 * @returns -1 when `a` is older, 0 when equal, 1 when `a` is newer.
 */
export function compareVersions(a, b) {
  const split = (value) => {
    const text = typeof value === 'string' ? value.trim() : ''
    const dash = text.indexOf('-')
    const core = dash === -1 ? text : text.slice(0, dash)
    const pre = dash === -1 ? '' : text.slice(dash + 1)
    return { parts: core.split('.').map(part => (/^\d+$/.test(part) ? Number(part) : 0)), pre }
  }
  const left = split(a)
  const right = split(b)
  const length = Math.max(left.parts.length, right.parts.length)
  for (let i = 0; i < length; i += 1) {
    const x = left.parts[i] ?? 0
    const y = right.parts[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  if (left.pre === right.pre) return 0
  if (left.pre === '') return 1
  if (right.pre === '') return -1
  return left.pre < right.pre ? -1 : 1
}

/**
 * What checking one plugin means, if anything.
 *
 * @param plugin - one entry from `readInventory`, or just `{ name, source }`.
 * @returns `{ kind, url, label }` where `kind` is `npm`, `github` or `none`.
 */
export function planCheck(plugin) {
  const source = plugin?.source ?? {}
  if (source.kind === 'npm') {
    return {
      kind: 'npm',
      url: `https://registry.npmjs.org/${encodeURIComponent(plugin.name)}/latest`,
      label: 'npm registry',
    }
  }
  if (source.kind === 'github') {
    return {
      kind: 'github',
      url: `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/commits?per_page=1`,
      label: `github.com/${source.owner}/${source.repo}`,
    }
  }
  return {
    kind: 'none',
    url: null,
    label: source.kind === 'link' ? '本地链接目录' : '本地/工作区包',
  }
}

/**
 * The install spec that would move this plugin to the version just found.
 *
 * The spec matters as much as the version: `dsh plugin add` records exactly what
 * it is given, and that string is what every later update compares against. Two
 * deliberate choices:
 *
 *   - npm gets `^<latest>`, not the exact version. Pointing an exact version
 *     pins it, and a pinned dependency stops being upgradable by any later
 *     range-based command - a trap this machine has already fallen into.
 *   - GitHub gets the new commit, because that is the only thing a pinned GitHub
 *     install can be moved to; there is no version to name.
 *
 * @param plugin - the inventory entry.
 * @param verdict - the result of `check`.
 * @returns the spec, or null when this plugin cannot be updated this way.
 */
export function updateSpec(plugin, verdict) {
  const source = plugin?.source ?? {}
  if (verdict === null || verdict === undefined || verdict.status !== 'update') return null
  const latest = verdict.latest
  if (source.kind === 'npm') {
    if (typeof latest !== 'string' || !/^\d/.test(latest)) return null
    return `${plugin.name}@^${latest}`
  }
  if (source.kind === 'github') {
    if (typeof latest !== 'string' || !/^[0-9a-f]{7,40}$/i.test(latest)) return null
    if (typeof source.owner !== 'string' || typeof source.repo !== 'string') return null
    return `github:${source.owner}/${source.repo}#${latest}`
  }
  return null
}

/**
 * Turn a registry answer into a verdict.
 * @param plugin - the inventory entry.
 * @param body - parsed registry JSON, or anything else.
 * @returns `{ status, latest, message }`.
 */
export function interpretNpm(plugin, body) {
  const latest = body !== null && typeof body === 'object' && typeof body.version === 'string' ? body.version : null
  if (latest === null) {
    return { status: 'unknown', latest: null, message: '注册表没有返回版本号' }
  }
  const installed = plugin.version
  if (typeof installed !== 'string' || installed.length === 0) {
    return { status: 'unknown', latest, message: `本地未读到版本，注册表最新 ${latest}` }
  }
  if (compareVersions(installed, latest) < 0) {
    return { status: 'update', latest, message: `可更新：${installed} → ${latest}` }
  }
  return { status: 'current', latest, message: `已是最新（${installed}）` }
}

/**
 * Turn a GitHub commits answer into a verdict.
 *
 * A pinned GitHub install cannot be "updated" by a version number: the profile
 * records a commit sha, so the only honest question is whether the default
 * branch has moved past it.
 * @param plugin - the inventory entry; `source.ref` is the pinned sha.
 * @param body - parsed commits array, or anything else.
 * @returns `{ status, latest, message }`.
 */
export function interpretGithub(plugin, body) {
  const head = Array.isArray(body) && body.length > 0 ? body[0] : null
  const latest = head !== null && typeof head.sha === 'string' ? head.sha : null
  if (latest === null) {
    return { status: 'unknown', latest: null, message: 'GitHub 没有返回提交信息' }
  }
  const date = head?.commit?.committer?.date
  const when = typeof date === 'string' ? `（${date.slice(0, 10)}）` : ''
  const pinned = plugin?.source?.ref
  if (typeof pinned !== 'string' || pinned.length === 0) {
    return { status: 'unknown', latest, message: `最新提交 ${latest.slice(0, 7)}${when}` }
  }
  if (latest !== pinned) {
    return { status: 'update', latest, message: `有新提交：${latest.slice(0, 7)}${when}，本地钉在 ${pinned.slice(0, 7)}` }
  }
  return { status: 'current', latest, message: `已是最新提交（${pinned.slice(0, 7)}）${when}` }
}

/**
 * Where the plugin page reads the profile from.
 *
 * The Host process's working directory is the profile directory in the desktop
 * application (`spawn(..., { cwd: this.projectDir })`), which is the most exact
 * answer available to a plugin and the one this deployment can verify. A home
 * path is kept as the fallback so the page still works under `dsh web`.
 * @param cwd - `process.cwd()`.
 * @param home - the user's home directory.
 * @returns the candidate directories, most specific first.
 */
export function profileCandidates(cwd, home) {
  const list = []
  if (typeof cwd === 'string' && cwd.length > 0) list.push(cwd)
  if (typeof home === 'string' && home.length > 0) {
    list.push(join(home, '.dsh', 'profiles', 'desktop'))
  }
  return list
}

/** How many checked plugins asked for an update. */
export function summarize(plugins) {
  return {
    total: plugins.length,
    github: plugins.filter(plugin => plugin.source.kind === 'github').length,
    npm: plugins.filter(plugin => plugin.source.kind === 'npm').length,
    other: plugins.filter(plugin => plugin.source.kind !== 'github' && plugin.source.kind !== 'npm').length,
  }
}
