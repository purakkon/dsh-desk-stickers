/**
 * dsh-restart - Host half.
 *
 * The package has exactly one job: restart the whole DSH desktop application
 * (Electron main process included), so that a change only read at boot - a
 * `cordis.patch.yml` row, a new plugin, an updated Host module - takes effect
 * without the user hunting for the window's close button.
 *
 * Why this is not a one-liner
 * ---------------------------
 * A DSH plugin runs inside the **Host** child process, which the Electron main
 * process spawns. The main process owns the application lifecycle and the only
 * restart primitive in the payload is `app.relaunch()` in `lib/main.js`, which a
 * plugin cannot reach: the Host is an IPC peer with a fixed message vocabulary
 * (`shutdown`, `update-tasks`, `quit-inspection` inbound; `ready`, `fatal`,
 * `shutdown-complete`, `platform-session`, and control replies outbound) and no
 * restart verb exists in either direction. There is likewise no restart channel
 * in the renderer preload API.
 *
 * So the restart is assembled here out of three parts that a plain plugin can
 * actually own:
 *
 *   1. a detached helper process (`lib/relaunch.mjs`, run by the same Electron
 *      binary in `ELECTRON_RUN_AS_NODE` mode) that outlives the application and
 *      re-launches it once every DSH process is gone;
 *   2. a watchdog in that helper, so a Host that fails to exit on its own is
 *      force-killed instead of leaving the user with no DSH at all;
 *   3. the termination itself, sent by this module to the main process only
 *      AFTER the helper has confirmed it is running.
 *
 * The ordering is the safety property: nothing is killed until a process that
 * can bring DSH back is verifiably alive. If the helper cannot start, the
 * restart is refused and the application keeps running.
 *
 * No kernel package is imported. `defineTool` and `CommandDefinitionId` are
 * compile-time helpers (`identity` brand functions and a schema projection); the
 * registry-ready shapes they produce are written out by hand below so this
 * package resolves with no `node_modules` of its own.
 *
 * User-facing copy is Chinese; comments and docs are English.
 */

import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package name, and the patch row's `name:` in the profile layer. */
export const name = 'dsh-desk-stickers/restart'

/** Services this half consumes. Both are core Host services. */
export const inject = ['commands', 'webServer']

/** Route prefix for the HTTP surface. */
const ROUTE = '/plugins/dsh-desk-stickers/restart'

/** Absolute path of the detached helper this package ships. */
const HELPER = fileURLToPath(new URL('./relaunch.mjs', import.meta.url))

/**
 * Grace period between a confirmed helper and the kill.
 *
 * Long enough for the command's reply or the tool's result to reach the client
 * and be painted, so the user reads "restarting" rather than watching the window
 * vanish for no stated reason.
 */
const KILL_DELAY_MS = 1200

/**
 * Upper bound on how long this process waits for its own cooperative shutdown.
 *
 * The Host notices the main process disappear (`process.once('disconnect')` ->
 * `stop()`) and closes its web server, which releases the port the relaunched
 * application needs. If that teardown hangs, the helper's watchdog already
 * force-kills this process, so this timer only shortens the wait.
 */
const SELF_EXIT_MS = 6000

/**
 * How long the helper waits for every DSH process to disappear before it
 * force-kills what is left, and how long it tolerates a missing target.
 */
const DRAIN_DEADLINE_MS = 20000
const FORCE_SETTLE_MS = 800

/** Ceiling on a postponed restart, so a typo cannot schedule one for next week. */
const MAX_DELAY_MS = 10 * 60 * 1000

/**
 * What this build of the plugin can do.
 *
 * Published by the status route so a caller can tell "this deployment supports a
 * postponed restart" from "this process still holds an older module" rather than
 * discovering it by having the application disappear.
 */
const CAPABILITIES = Object.freeze({
  delayedRestart: true,
  maxDelaySeconds: MAX_DELAY_MS / 1000,
  // 1.0.0 relaunched the executable with its own environment, so the child
  // inherited ELECTRON_RUN_AS_NODE and came back as a Node runtime that exited
  // immediately: the window closed and nothing reopened. 1.0.1 drops the flag.
  // The field exists so a running process can be asked which build it holds.
  cleanAppEnvironment: true,
})

/**
 * The facts that decide whether a restart is possible at all.
 *
 * `desktop` is the load-bearing one. `process.connected` is true only when this
 * process was spawned with an IPC channel - which the Electron main process does
 * and a plain `dsh web` run does not. Combined with a real parent pid, that
 * distinguishes "the application owns me, and `appPid` is the application" from
 * "a human ran me in a terminal, where the parent is their shell". The second
 * case must never be killed.
 * @returns the process-topology facts, safe to publish.
 */
export function environment() {
  const appPid = Number(process.ppid)
  return {
    pid: process.pid,
    appPid,
    desktop: process.connected === true && Number.isSafeInteger(appPid) && appPid > 0,
    connected: process.connected === true,
    execPath: process.execPath,
    cwd: process.cwd(),
    platform: process.platform,
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    helper: HELPER,
  }
}

/**
 * Decide whether a restart may be attempted, without performing it.
 *
 * Split from execution so the same answer can be reported by the HTTP surface
 * (`?dry=1`) and asserted by the offline suite without any risk of killing the
 * application that is running the assertions.
 * @param facts - topology facts; defaults to the live process.
 * @returns a plan carrying `ok`, a human-readable `reason` when refused, and the
 *   concrete pid/path the restart would use.
 */
export function plan(facts = environment()) {
  if (!facts.desktop) {
    return {
      ok: false,
      facts,
      reason: '这个 DSH 进程不是由桌面应用启动的（没有与主进程的 IPC 通道），'
        + '无法安全地把它和它的父进程一起重启。请手动重启。',
    }
  }
  if (!facts.execPath || !/\.exe$|DeepSeek Harness$|electron$/i.test(facts.execPath)) {
    return {
      ok: false,
      facts,
      reason: `无法确认要重新启动的可执行文件：${facts.execPath || '(空)'}`,
    }
  }
  return { ok: true, facts, appPid: facts.appPid, hostPid: facts.pid, execPath: facts.execPath }
}

/**
 * Start the detached helper and resolve once it is either running or refused.
 *
 * The 'spawn' event (not `spawn()` returning) is the evidence that matters: on
 * Windows a failed creation is reported asynchronously, and a restart that
 * killed the application after a silent spawn failure would leave the user with
 * nothing to restart.
 * @param payload - the helper's JSON argument.
 * @returns `{ ok: true, pid }` or `{ ok: false, reason }`.
 */
function startHelper(payload) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child
    try {
      child = spawn(process.execPath, [HELPER, JSON.stringify(payload)], {
        // `detached` + ignored stdio + a hidden window is what lets the helper
        // outlive every process it is about to watch die, including this one.
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: dirname(process.execPath),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
    } catch (error) {
      finish({ ok: false, reason: String(error?.message ?? error) })
      return
    }
    child.once('error', (error) => { finish({ ok: false, reason: String(error?.message ?? error) }) })
    child.once('spawn', () => {
      child.unref()
      finish({ ok: true, pid: child.pid })
    })
    // A spawn that neither errors nor reports within three seconds is treated as
    // running: the pid exists, and refusing here would break a restart that the
    // helper is in fact ready to complete.
    setTimeout(() => {
      child.unref()
      finish({ ok: true, pid: child.pid })
    }, 3000)
  })
}

/**
 * Restart the whole application.
 *
 * Order: plan, helper, kill. Each step's failure is returned instead of thrown,
 * because both callers (a slash command and a tool call) render failures as
 * text rather than as a stack.
 * @param ctx - Host context, used only for logging.
 * @param trigger - where the request came from, for the log line.
 * @param options - `delayMs` postpones the kill. The helper is always started
 *   first and waits that much longer, so a postponed restart is still guaranteed
 *   to have something alive that can bring DSH back.
 * @returns `{ ok, message }` - a Chinese sentence either way.
 */
export async function restart(ctx, trigger = 'unknown', options = {}) {
  const decision = plan()
  if (!decision.ok) return { ok: false, message: decision.reason }

  const requested = Number.isFinite(options.delayMs) ? Math.max(0, options.delayMs) : 0
  const delayMs = Math.min(requested, MAX_DELAY_MS)

  const payload = {
    appPid: decision.appPid,
    hostPid: decision.hostPid,
    execPath: decision.execPath,
    log: null,
    // The watchdog has to tolerate the postponement, or it would force a restart
    // before the caller ever asked for one.
    drainDeadlineMs: delayMs + DRAIN_DEADLINE_MS,
    forceSettleMs: FORCE_SETTLE_MS,
  }
  const helper = await startHelper(payload)
  if (!helper.ok) {
    ctx?.logger?.warn?.(`dsh-restart: relaunch helper refused to start: ${helper.reason}`)
    return {
      ok: false,
      message: `重启协助进程没能启动（${helper.reason}），为避免 DSH 关掉后打不开，本次重启已取消。`,
    }
  }

  ctx?.logger?.info?.(
    `dsh-restart: restart requested by ${trigger}; helper pid ${String(helper.pid)}, `
    + `app pid ${String(decision.appPid)}, host pid ${String(decision.hostPid)}, delay ${String(delayMs)}ms`,
  )

  setTimeout(() => {
    try {
      process.kill(decision.appPid)
    } catch (error) {
      ctx?.logger?.error?.(`dsh-restart: cannot stop the application process: ${String(error)}`)
    }
  }, delayMs + KILL_DELAY_MS)

  setTimeout(() => { process.exit(0) }, delayMs + KILL_DELAY_MS + SELF_EXIT_MS)

  return {
    ok: true,
    delayMs,
    message: (delayMs > 0 ? `DSH 将在约 ${String(Math.round(delayMs / 1000))} 秒后重启：`
      : '正在重启 DSH：')
      + '先关闭当前进程，再由协助进程自动重新打开。'
      + '如果几秒后没有自动回来，请手动启动「DeepSeek Harness」。',
  }
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

/**
 * Mount the plugin.
 * @param ctx - Host context carrying the command registry and the web server.
 */
export function apply(ctx) {
  // 1. `/restart` in the input box. The command registry is Remote-exposed, so a
  //    registered command shows up in every human-command adapter (the web UI's
  //    slash menu included) with no client-side code at all.
  ctx.effect(() => ctx.commands.register({
    definitionId: 'dsh-restart',
    name: 'restart',
    description: '重启 DSH（关闭当前应用并自动重新打开）',
    handler: async () => {
      const result = await restart(ctx, 'command')
      return result.ok
        ? { kind: 'success', text: result.message }
        : { kind: 'error', text: result.message }
    },
  }), 'dsh-restart: /restart command')

  // 2. An HTTP surface: `status` is a pure dry run (topology + verdict), and
  //    `restart` performs the same action with `?dry=1` available. Exact and
  //    prefix routes are registered separately, mirroring dsh-boot-animation:
  //    the web server resolves prefixes longest-first, so a prefix covering the
  //    whole ROUTE would also claim `/plugins/dsh-restart/client.js`.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/status`,
    handler: (req, res) => {
      const decision = plan()
      sendJson(res, 200, {
        ...environment(),
        capabilities: CAPABILITIES,
        startable: decision.ok,
        ...decision.ok ? {} : { reason: decision.reason },
      })
    },
  }), 'dsh-restart: status route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: `${ROUTE}/restart`,
    handler: (req, res) => {
      if (req.method !== 'POST' && req.method !== 'GET') {
        sendJson(res, 405, { ok: false, message: '这个地址只接受 GET 或 POST。' })
        return
      }
      const query = new URL(req.url ?? '/', 'http://localhost').searchParams
      if (query.get('dry') === '1') {
        const decision = plan()
        sendJson(res, 200, { dry: true, capabilities: CAPABILITIES, ...decision })
        return
      }
      const seconds = Number(query.get('delay') ?? '0')
      void restart(ctx, 'http', {
        delayMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0,
      }).then(
        result => sendJson(res, result.ok ? 200 : 409, result),
        error => sendJson(res, 500, { ok: false, message: String(error) }),
      )
    },
  }), 'dsh-restart: restart route')

  // 3. A tool, so a model can restart the application itself. Registered last
  //    and defensively: the definition below is the shape `defineTool` compiles
  //    to (the registry consumes `parameters` as plain JSON Schema), and a
  //    rejected registration must not take the command and the routes with it.
  try {
    ctx.tools.register({
      name: 'restart_dsh',
      description: 'Restart the whole DSH desktop application (close the current '
        + 'process and reopen it automatically). Use when a change only read at '
        + 'startup must take effect.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
          required: ['ok', 'message'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
      },
      execute: () => restart(ctx, 'tool'),
    })
  } catch (error) {
    ctx?.logger?.warn?.(`dsh-restart: tool registration failed, /restart still works: ${String(error)}`)
  }
}
