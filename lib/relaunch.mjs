/**
 * dsh-restart - the detached relaunch helper.
 *
 * Invoked by `entry.js` as
 *
 *   ELECTRON_RUN_AS_NODE=1 "<the DSH executable>" relaunch.mjs '<payload json>'
 *
 * with `detached: true` and ignored stdio, which is what lets it outlive every
 * process it is about to watch die. It is deliberately dependency-free and uses
 * nothing but `node:` builtins, so it runs under the same executable that ships
 * DSH without resolving any package.
 *
 * Its contract, in order:
 *
 *   1. wait until both the Electron main process and the DSH Host process are
 *      gone, so the port and the single-instance lock are free;
 *   2. if they are still alive when the deadline expires, force-kill them - a
 *      restart that leaves DSH down is worse than a hard kill;
 *   3. launch the application again, detached, and exit.
 *
 * Nothing about the sequence trusts the caller: pids are validated, a pid that
 * never existed is treated as already gone, and every step appends to a log file
 * so a silent failure is diagnosable after the fact.
 *
 * The helper never touches DSH's own files. Its only side effect besides the
 * relaunch is that log line.
 */

import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { appEnvironment } from './app-env.mjs'

/** Where the helper records what it did; readable after the application is gone. */
const DEFAULT_LOG = join(tmpdir(), 'dsh-restart.log')

/** Poll interval while waiting for processes to disappear. */
const POLL_MS = 200

/**
 * Read and validate the payload.
 *
 * A malformed payload exits non-zero *before* anything is killed, which is the
 * only safe direction: the caller treats a helper that never confirmed as a
 * refused restart.
 * @returns the validated payload.
 */
function readPayload() {
  const raw = process.argv[2]
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('missing payload argument')
  const parsed = JSON.parse(raw)
  if (typeof parsed?.execPath !== 'string' || parsed.execPath.length === 0) {
    throw new Error('payload.execPath is required')
  }
  const pid = (value) => (Number.isSafeInteger(value) && value > 0 ? value : undefined)
  return {
    execPath: parsed.execPath,
    appPid: pid(parsed.appPid),
    hostPid: pid(parsed.hostPid),
    launchArgs: Array.isArray(parsed.launchArgs) ? parsed.launchArgs.map(String) : [],
    launchCwd: typeof parsed.launchCwd === 'string' && parsed.launchCwd.length > 0
      ? parsed.launchCwd
      : dirname(parsed.execPath),
    log: typeof parsed.log === 'string' && parsed.log.length > 0 ? parsed.log : DEFAULT_LOG,
    drainDeadlineMs: Number.isFinite(parsed.drainDeadlineMs) ? parsed.drainDeadlineMs : 20000,
    forceSettleMs: Number.isFinite(parsed.forceSettleMs) ? parsed.forceSettleMs : 800,
  }
}

/**
 * Append one line to the helper's log.
 *
 * Failure to log is never fatal: an unwritable temp directory must not stop a
 * restart.
 * @param file - log path.
 * @param line - message.
 */
function log(file, line) {
  try {
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // Diagnostics only.
  }
}

/**
 * Whether a pid is alive.
 *
 * `EPERM` means the process exists but belongs to somebody else, which counts as
 * alive: waiting for it is correct, and killing it would be an error we could
 * not fix.
 * @param pid - target pid.
 * @returns true when the process still exists.
 */
function alive(pid) {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** Sleep without pulling in timers/promises. */
function sleep(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Wait for every target pid to disappear.
 * @param pids - target pids, already de-duplicated.
 * @param deadline - epoch milliseconds to stop waiting at.
 * @returns true when all targets were gone before the deadline.
 */
async function drain(pids, deadline) {
  for (;;) {
    if (pids.every(pid => !alive(pid))) return true
    if (Date.now() >= deadline) return pids.every(pid => !alive(pid))
    await sleep(POLL_MS)
  }
}

/** Terminate one process, ignoring every failure mode. */
function terminate(pid, file) {
  try {
    process.kill(pid)
    log(file, `sent SIGTERM to pid ${String(pid)}`)
  } catch (error) {
    log(file, `cannot signal pid ${String(pid)}: ${String(error?.message ?? error)}`)
  }
}

/**
 * The whole sequence.
 * @returns the process exit code.
 */
async function main() {
  const payload = readPayload()
  const file = payload.log
  log(file, `relaunch helper started (pid ${String(process.pid)}; app ${String(payload.appPid)}; host ${String(payload.hostPid)})`)

  const targets = [...new Set([payload.appPid, payload.hostPid].filter(pid => pid !== undefined))]
  const drained = await drain(targets, Date.now() + payload.drainDeadlineMs)
  if (!drained) {
    log(file, `deadline reached with ${targets.filter(alive).join(', ')} still alive; forcing`)
    for (const pid of targets.filter(alive)) terminate(pid, file)
    await sleep(payload.forceSettleMs)
  } else {
    log(file, 'every DSH process has exited')
  }

  const stillAlive = targets.filter(alive)
  if (stillAlive.length > 0) {
    // Launching into a held port would produce the address-in-use dialog, which
    // is a worse outcome than reporting the failure and leaving DSH closed.
    log(file, `refusing to relaunch: ${stillAlive.join(', ')} survived the forced stop`)
    return 3
  }

  const launched = await relaunch(payload, file)
  if (!launched.ok) {
    log(file, `relaunch failed: ${launched.reason}`)
    return 4
  }
  log(file, `relaunched ${payload.execPath} (pid ${String(launched.pid)}) in ${payload.launchCwd}`)
  return 0
}

/**
 * Start the application again.
 *
 * The 'spawn' event is the proof, not the absence of a throw: on Windows a
 * missing or unexecutable path is reported asynchronously, and reporting success
 * for a launch that never happened would hide the one failure the user can still
 * act on.
 *
 * The environment is the other thing that decides whether this worked. The child
 * must NOT inherit `ELECTRON_RUN_AS_NODE`, which this very process is running
 * under: with it set, the executable starts as Node, finds no script, and exits,
 * and the "successful" spawn above is a process that was already dead. See
 * `app-env.mjs`.
 * @param payload - validated helper payload.
 * @param file - log path, for the note about the dropped flag.
 * @returns `{ ok: true, pid }` or `{ ok: false, reason }`.
 */
function relaunch(payload, file) {
  const env = appEnvironment(process.env)
  if (process.env.ELECTRON_RUN_AS_NODE !== undefined) {
    log(file, 'dropped ELECTRON_RUN_AS_NODE from the relaunch environment')
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child
    try {
      child = spawn(payload.execPath, payload.launchArgs, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        cwd: payload.launchCwd,
        env,
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
    setTimeout(() => {
      child.unref()
      finish({ ok: true, pid: child.pid })
    }, 3000)
  })
}

main().then(
  (code) => { process.exitCode = code },
  (error) => {
    try {
      appendFileSync(DEFAULT_LOG, `${new Date().toISOString()} fatal: ${String(error?.stack ?? error)}\n`, 'utf8')
    } catch {
      // Diagnostics only.
    }
    process.exitCode = 1
  },
)
