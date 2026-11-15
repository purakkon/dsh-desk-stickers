/**
 * dsh-installed-plugins - Host half.
 *
 * Serves the three facts a Settings page about installed plugins needs, and
 * nothing else:
 *
 *   GET /list             what the profile installed, from the profile manifest
 *   GET /icon?name=       one plugin's icon bytes, resolved the way the kernel does
 *   GET /check?name=      is there a newer version / commit, asked over the network
 *   GET /update?name=     install that newer version through the harness's own CLI
 *
 * The update never trusts the page's target: it re-asks the network, decides the
 * spec from the fresh answer, and brackets the install with a bundle-list audit.
 * See `lib/installer.mjs` for why that audit is not optional.
 *
 * Where the answers come from matters:
 *
 *   - The profile's `package.json` is the only place the INSTALL METHOD survives.
 *     `node_modules` looks identical whether a package arrived from the npm
 *     registry, from a pinned GitHub commit, or from a local `link:` directory,
 *     and the install spec is what decides whether an update can even be asked
 *     about. See `lib/updates.mjs`.
 *
 *   - The network check goes through the Host's own `web` service, not through
 *     `fetch`. That service is the same path the harness's web tools use, so the
 *     machine's proxy and provider configuration apply to it already; a raw
 *     `fetch` in a plugin would be a second, differently-configured client.
 *
 * No kernel package is imported: the routes go through `ctx.webServer`, and the
 * `web` service is reached with the dynamic `ctx.inject` form so a deployment
 * without it still lists and renders, only refusing to check.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { readIcon, readInventory, readPackageManifest, resolveProfile } from './inventory.mjs'
import { bundleAudit, outputTail, readProfileManifest, repairManifest, runPluginAdd } from './installer.mjs'
import { interpretGithub, interpretNpm, planCheck, profileCandidates, updateSpec } from './updates.mjs'

/** Package name, and the patch row's `name:` in the profile layer. */
export const name = 'dsh-installed-plugins'

/** The web server is required: every fact travels over these routes. */
export const inject = ['webServer']

/** Route prefix for the endpoints. */
const ROUTE = '/plugins/dsh-desk-stickers/plugins'

/** How long one outbound check may take before it is abandoned. */
const CHECK_TIMEOUT_MS = 20000

/** How long one install may take. Installs run pnpm, and pnpm can be slow. */
const UPDATE_TIMEOUT_MS = 300000

/** The `web` service, once it exists. Read lazily; absent is a supported state. */
let webService

/** Name of the plugin currently being updated, or null. One install at a time. */
let updating = null

/** Every profile directory this process could plausibly be running from. */
function candidates() {
  return profileCandidates(process.cwd(), homedir())
}

/** Answer one JSON response. */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value, null, 2), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Answer a request that named no usable plugin. */
function missingName(res) {
  sendJson(res, 400, { ok: false, message: '缺少 name 参数。' })
}

/**
 * Find one plugin's inventory entry plus its icon file.
 * @param wanted - the package name from the query string.
 * @returns `{ profile, entry, icon }`, with `entry` undefined when unknown.
 */
function locate(wanted) {
  const inventory = readInventory({ candidates: candidates() })
  if (!inventory.ok) return { inventory, profile: undefined, entry: undefined, icon: undefined }
  const entry = inventory.plugins.find(plugin => plugin.name === wanted)
  if (entry === undefined) return { inventory, profile: undefined, entry: undefined, icon: undefined }
  const profile = resolveProfile(candidates())
  if (profile === undefined) return { inventory, profile: undefined, entry, icon: undefined }
  const found = readPackageManifest(profile.dir, wanted)
  const icon = found === undefined ? undefined : readIcon(found.manifestPath, found.manifest?.icon)
  return { inventory, profile, entry, icon }
}

/**
 * Ask the network about one plugin.
 *
 * @param entry - the inventory entry, whose `source` decides what is asked.
 * @param service - the `web` service; defaults to the injected one. Injectable so
 *   the offline suite can drive every branch without a socket.
 * @returns a verdict object shaped for the table's version column.
 */
export async function check(entry, service = webService) {
  const plan = planCheck(entry)
  if (plan.kind === 'none') {
    return { name: entry.name, status: 'skipped', latest: null, plan: plan.kind, message: `${plan.label}，没有可检查的远程版本` }
  }
  if (service === undefined || service === null || typeof service.fetch !== 'function') {
    return { name: entry.name, status: 'unavailable', latest: null, plan: plan.kind, message: '宿主没有可用的 web 抓取通道，无法联网检查' }
  }

  let result
  try {
    result = await service.fetch({ url: plan.url }, AbortSignal.timeout(CHECK_TIMEOUT_MS))
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    return {
      name: entry.name,
      status: 'error',
      latest: null,
      plan: plan.kind,
      url: plan.url,
      message: timedOut ? `请求超时（${Math.round(CHECK_TIMEOUT_MS / 1000)} 秒）` : String(error?.message ?? error),
    }
  }

  if (result.statusCode !== 200) {
    const hint = result.statusCode === 403 && plan.kind === 'github'
      ? '，可能是 GitHub 匿名调用配额用尽，稍后再试'
      : ''
    return {
      name: entry.name,
      status: 'error',
      latest: null,
      plan: plan.kind,
      url: plan.url,
      message: `HTTP ${String(result.statusCode)}${hint}`,
    }
  }

  let body
  try {
    body = JSON.parse(result.body.content)
  } catch {
    return { name: entry.name, status: 'error', latest: null, plan: plan.kind, url: plan.url, message: '返回内容不是 JSON' }
  }

  const verdict = plan.kind === 'github' ? interpretGithub(entry, body) : interpretNpm(entry, body)
  return { name: entry.name, plan: plan.kind, url: plan.url, checkedAt: new Date().toISOString(), ...verdict }
}

/**
 * Install the newest version of one plugin.
 *
 * The sequence is deliberately paranoid, in this order:
 *
 *   1. refuse if another install is already running (two pnpm runs against one
 *      profile is how a manifest gets corrupted);
 *   2. re-ask the network and derive the spec HERE - a page left open for an hour
 *      must not be able to install a target it picked when it was loaded;
 *   3. snapshot the bundle list;
 *   4. run `dsh plugin add`;
 *   5. re-read, and restore anything that stopped being mounted.
 *
 * @param entry - the inventory entry for the plugin.
 * @param options - `{ service, profile, execPath, timeoutMs, spawnImpl }`.
 * @returns a result shaped for the page: `{ ok, message, ... }`.
 */
export async function updatePlugin(entry, options = {}) {
  const {
    service = webService,
    profile,
    execPath = process.execPath,
    timeoutMs = UPDATE_TIMEOUT_MS,
    spawnImpl,
  } = options

  if (profile === undefined || profile === null || typeof profile.dir !== 'string') {
    return { ok: false, message: '没有定位到 profile 目录，无法更新。' }
  }
  if (updating !== null) {
    return { ok: false, message: `正在更新 ${updating}，等它结束再试这一个。` }
  }

  updating = entry.name
  try {
    const verdict = await check(entry, service)
    if (verdict.status !== 'update') {
      return { ok: false, status: verdict.status, message: `没有可更新的版本：${verdict.message}` }
    }
    const spec = updateSpec(entry, verdict)
    if (spec === null) {
      return { ok: false, status: verdict.status, message: '这个来源没有可用的更新方式。' }
    }

    const before = readProfileManifest(profile.manifestPath)
    if (before === undefined) {
      return { ok: false, message: 'profile 的 package.json 读不出来，为避免损坏已放弃更新。' }
    }

    const run = await runPluginAdd({
      execPath,
      profile: basename(profile.dir),
      spec,
      cwd: profile.dir,
      timeoutMs,
      ...spawnImpl === undefined ? {} : { spawnImpl },
    })

    // The audit runs even when the CLI failed: a failed install is exactly when
    // the manifest is most likely to have been left half-edited.
    const after = readProfileManifest(profile.manifestPath)
    const audit = bundleAudit(before.bundles, after === undefined ? [] : after.bundles)
    const repair = audit.ok ? { changed: false, restored: [] } : repairManifest(profile.manifestPath, before.bundles)

    const installed = readPackageManifest(profile.dir, entry.name)?.manifest?.version ?? null
    const parts = []
    if (run.code !== 0) {
      parts.push(run.timedOut === true ? run.error : `更新失败（命令行退出码 ${String(run.code)}）`)
    } else if (installed !== null && installed !== entry.version) {
      parts.push(`已更新：${String(entry.version ?? '?')} → ${installed}`)
    } else {
      parts.push(`命令执行完成，本地版本仍是 ${String(installed ?? entry.version ?? '未知')}`
        + '（GitHub 钉提交这类更新不会改版本号，属正常）')
    }
    if (Array.isArray(repair.restored) && repair.restored.length > 0) {
      parts.push(`并补回了被丢掉的挂载项：${repair.restored.join('、')}`)
    }
    if (repair.error !== undefined && repair.error !== null) {
      parts.push(`挂载列表核对异常：${repair.error}`)
    }
    if (run.code === 0) parts.push('重启 DSH 后新版本才真正生效。')

    return {
      ok: run.code === 0,
      name: entry.name,
      spec,
      exitCode: run.code,
      installed,
      audit,
      repairs: repair.restored ?? [],
      backup: repair.backup ?? null,
      output: outputTail(run.output),
      message: parts.join('；'),
    }
  } finally {
    updating = null
  }
}

/**
 * Mount the plugin.
 * @param ctx - Host context carrying the web server.
 */
export function apply(ctx) {
  // The `web` service is optional by design: without it the page still lists
  // every installed plugin and says why checking is off, instead of failing.
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['web'], (owner) => {
        const service = typeof owner?.get === 'function' ? owner.get('web') : undefined
        if (service !== undefined && service !== null) webService = service
      })
    } catch (error) {
      ctx.logger?.warn?.(`dsh-installed-plugins: web service unavailable: ${String(error)}`)
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/list`,
    handler: (req, res) => {
      sendJson(res, 200, readInventory({ candidates: candidates() }))
    },
  }), 'dsh-installed-plugins: list route')

  // Icons are their own route, not a field of the list: an `<img src>` pointing
  // here keeps megabytes of base64 out of the JSON the page has to parse.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/icon`,
    handler: (req, res) => {
      const wanted = new URL(req.url ?? '/', 'http://localhost').searchParams.get('name') ?? ''
      if (wanted.length === 0) {
        missingName(res)
        return
      }
      const { icon } = locate(wanted)
      if (icon === undefined) {
        sendJson(res, 404, { ok: false, message: '这个插件没有图标。' })
        return
      }
      let bytes
      try {
        bytes = readFileSync(icon.file)
      } catch {
        sendJson(res, 404, { ok: false, message: '图标文件读不到了。' })
        return
      }
      res.writeHead(200, {
        'content-type': icon.mediaType,
        'content-length': String(bytes.byteLength),
        // Icons change only when the plugin is reinstalled; a short cache keeps
        // the table from re-fetching fifteen files on every settings visit.
        'cache-control': 'private, max-age=300',
      })
      res.end(bytes)
    },
  }), 'dsh-installed-plugins: icon route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/check`,
    handler: (req, res) => {
      const wanted = new URL(req.url ?? '/', 'http://localhost').searchParams.get('name') ?? ''
      if (wanted.length === 0) {
        missingName(res)
        return
      }
      const { entry } = locate(wanted)
      if (entry === undefined) {
        sendJson(res, 404, { ok: false, message: '这个插件不在当前 profile 的依赖里。' })
        return
      }
      void check(entry).then(
        verdict => sendJson(res, 200, verdict),
        error => sendJson(res, 500, { name: wanted, status: 'error', message: String(error?.message ?? error) }),
      )
    },
  }), 'dsh-installed-plugins: check route')

  // The update route answers GET as well as POST. It is a state-changing call,
  // but the only client is the local settings page, and requiring POST there
  // would buy nothing while making the route impossible to exercise by hand.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/update`,
    handler: (req, res) => {
      const wanted = new URL(req.url ?? '/', 'http://localhost').searchParams.get('name') ?? ''
      if (wanted.length === 0) {
        missingName(res)
        return
      }
      const { entry, profile } = locate(wanted)
      if (entry === undefined) {
        sendJson(res, 404, { ok: false, message: '这个插件不在当前 profile 的依赖里。' })
        return
      }
      void updatePlugin(entry, { profile }).then(
        result => sendJson(res, result.ok === true ? 200 : 409, result),
        error => sendJson(res, 500, { ok: false, message: String(error?.message ?? error) }),
      )
    },
  }), 'dsh-installed-plugins: update route')

  ctx.logger?.info?.(`dsh-installed-plugins: routes mounted under ${ROUTE}`)
}
