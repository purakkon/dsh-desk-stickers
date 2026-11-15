/**
 * The environment a relaunched DSH application must start with.
 *
 * Why this is its own module: `relaunch.mjs` runs its sequence at import time, so
 * a suite cannot import it to reach a helper without starting one. Keeping the
 * one rule that decides the relaunch environment here makes it directly testable,
 * and this rule is worth testing on its own - getting it wrong is invisible.
 *
 * The rule
 * --------
 * The helper itself runs as `ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness.exe>"
 * relaunch.mjs`, which is how a Node script runs under the executable DSH ships.
 * That flag is a MODE SWITCH for the Electron binary: with it set, the same
 * executable is a plain Node runtime and never starts the application. Any child
 * that inherits it starts as Node, finds no script argument, reads EOF from the
 * ignored stdin, and exits within milliseconds.
 *
 * That is exactly what happened the first time this plugin restarted DSH. The log
 * read "relaunched ... (pid 75164)" - a real process, a real pid - and the window
 * stayed closed, because the thing that had been started was a Node runtime with
 * nothing to do. The pid is not evidence that an application is running.
 *
 * So the flag is deleted, and only the flag: everything else in the environment
 * (the user's PATH, the proxy settings, the credential variables, the runtime
 * paths) is what the application was itself started with and must be preserved.
 *
 * @param base - environment to derive from, normally `process.env`.
 * @returns a new object; the input is never mutated.
 */
export function appEnvironment(base) {
  const env = { ...base }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}
