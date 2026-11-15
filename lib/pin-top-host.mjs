/**
 * Window pin — Host half.
 *
 * The Window-chrome seat for this feature lives in the Client half. What a
 * pin must change is the Windows top-level window itself, which no browser
 * API reaches, so this half owns the one real operation:
 *
 *  - `pinTopWindow(action)` keeps a long-lived PowerShell helper that calls
 *    `SetWindowPos(HWND_TOPMOST / HWND_NOTOPMOST)` on the Electron window that
 *    owns the Host process (`process.ppid`), with a title fallback.
 *  - `POST /dsh-desk-stickers/pin-top` is the Client's call path (the desktop page
 *    reaches it through the `dsh-app://app` protocol forwarder, the browser
 *    page through its own origin).
 *  - the `window_pin_top` Tool exposes the very same operation to the agent,
 *    so the UI action and the tool never drift apart.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER_SCRIPT = join(HERE, 'win32-topmost.ps1');
const IS_WINDOWS = process.platform === 'win32';
const ROUTE_PATH = '/plugins/dsh-desk-stickers/pin-top';
const ACTIONS = new Set(['status', 'toggle', 'on', 'off']);
const MAX_BODY_BYTES = 4096;
const REQUEST_TIMEOUT_MS = 6000;

/** Resolve Windows PowerShell 5.1, present on every supported Windows build. */
function powershellPath() {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Coerce an untrusted action; anything unknown falls back to `status`. */
function normalizeAction(value) {
  return typeof value === 'string' && ACTIONS.has(value) ? value : 'status';
}

/** Read a small JSON body from an IncomingMessage. */
async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return {};
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The helper process: one PowerShell lifetime, one queued JSON line exchange
 * per call, restarted after a crash or timeout.
 */
function createWindowHelper() {
  let child = null;
  let pending = null;
  let buffer = '';
  let queue = Promise.resolve();
  let disposed = false;

  function settle(payload) {
    const active = pending;
    if (active === null) return;
    pending = null;
    clearTimeout(active.timer);
    active.resolve(payload);
  }

  function onLine(line) {
    const text = line.trim();
    if (text === '') return;
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return; // diagnostics on stdout are not part of the protocol
    }
    if (payload !== null && typeof payload === 'object' && payload.ready === true) return;
    settle(payload);
  }

  function teardown(error) {
    if (child !== null) {
      const current = child;
      child = null;
      try {
        current.kill();
      } catch {
        /* already gone */
      }
    }
    if (error !== undefined) settle({ ok: false, error: error.message });
  }

  function start() {
    if (disposed || child !== null) return;
    const proc = spawn(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER_SCRIPT],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
    );
    child = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        onLine(line);
      }
    });
    proc.on('error', (error) => {
      if (child === proc) child = null;
      settle({ ok: false, error: `helper: ${error.message}` });
    });
    proc.on('exit', () => {
      if (child === proc) child = null;
      settle({ ok: false, error: 'helper exited' });
    });
    proc.stdin.on('error', () => {});
  }

  function exchange(action) {
    return new Promise((resolve) => {
      if (disposed) {
        resolve({ ok: false, error: 'disposed' });
        return;
      }
      start();
      if (child === null) {
        resolve({ ok: false, error: 'helper unavailable' });
        return;
      }
      const target = Number.isInteger(process.ppid) && process.ppid > 0 ? process.ppid : 0;
      const timer = setTimeout(() => {
        teardown(new Error('helper timeout'));
      }, REQUEST_TIMEOUT_MS);
      pending = { resolve, timer };
      try {
        child.stdin.write(`${action} ${target}\n`);
      } catch (error) {
        pending = null;
        clearTimeout(timer);
        resolve({ ok: false, error: `helper write: ${error.message}` });
      }
    });
  }

  return {
    request(action) {
      const next = queue.then(() => exchange(action), () => exchange(action));
      queue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    dispose() {
      disposed = true;
      teardown(new Error('disposed'));
    },
  };
}

export function apply(ctx) {
  if (!IS_WINDOWS) {
    ctx.logger('dsh-desk-stickers/pin-top').info('window pin is a Windows desktop feature; nothing registered on this platform');
    return;
  }

  const helper = createWindowHelper();
  ctx.effect(() => () => helper.dispose());

  const run = (action) => helper.request(normalizeAction(action));

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: async (request, response) => {
          try {
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' });
              response.end('Use POST');
              return;
            }
            const body = await readJsonBody(request);
            const result = await run(body.action);
            response.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            });
            response.end(JSON.stringify(result));
          } catch (error) {
            response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
          }
        },
      }),
    );
  });

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() =>
      toolCtx.tools.register({
        name: 'window_pin_top',
        description:
          'Keep the DeepSeek Harness desktop window above every other window ("always on top"), or release it. Windows desktop only. Use action "status" to read the current state.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['status', 'toggle', 'on', 'off'],
              description:
                'status reads the current state; toggle flips it; on and off set it explicitly. Defaults to status.',
            },
          },
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean', description: 'Whether the request reached the window.' },
              topmost: { type: 'boolean', description: 'Whether the window is on top after the call.' },
              title: { type: 'string', description: 'The desktop window the action applied to.' },
              error: { type: 'string', description: 'Why the request failed, when ok is false.' },
            },
            additionalProperties: true,
          },
          render(_args, value) {
            return [{ type: 'text', text: JSON.stringify(value) }];
          },
        },
        async execute(args) {
          const action = typeof args === 'object' && args !== null ? args.action : undefined;
          return await run(action);
        },
      }),
    );
  });
}
