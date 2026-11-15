/**
 * Sticky note — Host half.
 *
 * The Client half owns the note surface inside the Harness window. This half
 * exists for the one thing a page cannot do: put the note **outside** the
 * Harness window, on the desktop, where it can be dragged anywhere and stays
 * above other windows.
 *
 * How it is built
 * ---------------
 * A plugin cannot open a native Electron window: the Host child process is an
 * IPC peer of the main process with a fixed message vocabulary, and the renderer
 * has no window-creation API. What a plugin *can* own is an ordinary OS process
 * and an HTTP route, so the desktop note is assembled from those:
 *
 *   1. `desktop.html` (shipped next to this file) is the desktop surface: the
 *      same three modes as the in-app note, served from this Host's web server
 *      so both surfaces share one origin;
 *   2. Edge (or Chrome) opens that page in **app mode** - a frameless browser
 *      window without tab bar or address bar - with a private profile directory
 *      under `~/.dsh/data/sticky-note`, so the window belongs to the plugin and
 *      closing the app does not disturb her real browser;
 *   3. `lib/win32-note.ps1` keeps the window on top (`SetWindowPos` with
 *      `HWND_TOPMOST`) and closes it on request, because that flag is not
 *      reachable from a web page;
 *   4. both surfaces exchange one record - mode, font size, text, sheet,
 *      checklist, theme colors - through `/state` and `/sync`, so a note can be
 *      typed on the desktop and pulled back into the conversation.
 *
 * The record is persisted under `~/.dsh/data/sticky-note/state.json`; the Client
 * remains the source of truth and pushes the whole note on pop-out.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS_FILE, loadSettings, saveSettings } from './lib/settings.mjs';
import { apply as applyPinTop } from './lib/pin-top-host.mjs';
import { apply as applyRestartHost } from './lib/restart-host.mjs';
import { apply as applyPluginsHost } from './lib/plugins-host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_FILE = join(HERE, 'desktop.html');
const HELPER_FILE = join(HERE, 'lib', 'win32-note.ps1');
const ROUTE = '/plugins/dsh-desk-stickers';
const DATA_DIR = join(homedir(), '.dsh', 'data', 'sticky-note');
const STATE_FILE = join(DATA_DIR, 'state.json');
const PROFILE_DIR = join(DATA_DIR, 'browser-profile');
const WINDOW_TITLE = '便利贴';
const IS_WINDOWS = process.platform === 'win32';

const MODES = ['text', 'grid', 'list'];
const FONT_MIN = 11;
const FONT_MAX = 30;
const MAX_BODY_BYTES = 512 * 1024;
const HELPER_TIMEOUT_MS = 6000;
const DEFAULT_SIZE = { w: 340, h: 400 };

/** Coerce a number into a range. */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * A sheet: fixed rows and columns of plain strings, plus one width per column
 * and one height per row so a dragged grid line survives the round trip.
 */
function normalizeGrid(value) {
  const source = value !== null && typeof value === 'object' ? value : {};
  const rows = clamp(Math.round(Number(source.rows) || 5), 1, 60);
  const cols = clamp(Math.round(Number(source.cols) || 3), 1, 20);
  const cells = [];
  for (let r = 0; r < rows; r += 1) {
    const row = Array.isArray(source.cells) && Array.isArray(source.cells[r]) ? source.cells[r] : [];
    cells.push(Array.from({ length: cols }, (_, c) => (typeof row[c] === 'string' ? row[c] : '')));
  }
  const colWidths = Array.from({ length: cols }, (_, c) => {
    const width = Number(source.colWidths?.[c]);
    return clamp(Math.round(Number.isFinite(width) && width > 0 ? width : 96), 44, 480);
  });
  const rowHeights = Array.from({ length: rows }, (_, r) => {
    const height = Number(source.rowHeights?.[r]);
    return clamp(Math.round(Number.isFinite(height) && height > 0 ? height : 28), 18, 300);
  });
  return { rows, cols, cells, colWidths, rowHeights };
}

/** A checklist: id, text, done. */
function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item !== null && typeof item === 'object')
    .slice(0, 200)
    .map((item, index) => ({
      id: typeof item.id === 'string' && item.id !== '' ? item.id.slice(0, 40) : `i${String(index)}`,
      text: typeof item.text === 'string' ? item.text.slice(0, 2000) : '',
      done: item.done === true,
    }));
}

/** Screen geometry of the desktop window, in CSS pixels. */
function normalizeRect(value) {
  if (value === null || typeof value !== 'object') return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const w = Number(value.w);
  const h = Number(value.h);
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(clamp(w, 200, 2000)), h: Math.round(clamp(h, 160, 2000)) };
}

/**
 * Theme colors handed over from the app, so the desktop note matches the skin.
 *
 * Only the seven tokens the desktop page understands survive, each restricted to
 * the characters a CSS color can legally contain: the values are written into a
 * stylesheet on the other side.
 */
function normalizeTheme(value) {
  const allowed = ['bg', 'fg', 'bar', 'line', 'muted', 'layer1', 'layer2', 'brand'];
  const out = {};
  if (value === null || typeof value !== 'object') return out;
  for (const key of allowed) {
    const raw = value[key];
    if (typeof raw === 'string' && raw.length <= 64 && /^[#a-zA-Z0-9(),.% -]+$/.test(raw)) out[key] = raw;
  }
  return out;
}

/** The one record both surfaces share. */
function emptyState() {
  return {
    rev: 1,
    open: false,
    pinned: true,
    sessionKey: null,
    label: '',
    theme: {},
    mode: 'text',
    fontSize: 14,
    text: '',
    grid: normalizeGrid(null),
    list: [],
    rect: null,
    updatedAt: 0,
  };
}

/** Accept a record from disk or from a request body. */
function normalizeState(value) {
  const base = emptyState();
  const src = value !== null && typeof value === 'object' ? value : {};
  return {
    rev: Number.isFinite(src.rev) ? Math.max(1, Math.floor(src.rev)) : base.rev,
    open: src.open === true,
    pinned: src.pinned !== false,
    sessionKey: typeof src.sessionKey === 'string' ? src.sessionKey.slice(0, 200) : null,
    label: typeof src.label === 'string' ? src.label.slice(0, 120) : '',
    theme: normalizeTheme(src.theme),
    mode: MODES.includes(src.mode) ? src.mode : base.mode,
    fontSize: clamp(Math.round(Number(src.fontSize) || base.fontSize), FONT_MIN, FONT_MAX),
    text: typeof src.text === 'string' ? src.text.slice(0, 200000) : '',
    grid: normalizeGrid(src.grid),
    list: normalizeList(src.list),
    rect: normalizeRect(src.rect),
    updatedAt: Number.isFinite(src.updatedAt) ? src.updatedAt : 0,
  };
}

/** Read one JSON body from an IncomingMessage. */
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
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Answer one JSON response. */
function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  });
  response.end(body);
}

/** Windows PowerShell 5.1, present on every supported Windows build. */
function powershellPath() {
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** The first installed Chromium browser, in preference order. */
function pickBrowser() {
  const candidates = [
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  for (const path of candidates) {
    try {
      if (existsSync(path)) return path;
    } catch {
      /* a path we cannot probe is simply not a candidate */
    }
  }
  return null;
}

/**
 * The window helper: one PowerShell lifetime, one queued JSON exchange per call,
 * restarted after a crash or a timeout. Same shape as the pin-top helper, so the
 * two plugins never fight over the same window.
 */
function createHelper() {
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
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER_FILE],
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

  function exchange(request) {
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
      const timer = setTimeout(() => {
        teardown(new Error('helper timeout'));
      }, HELPER_TIMEOUT_MS);
      pending = { resolve, timer };
      try {
        child.stdin.write(`${JSON.stringify(request)}\n`);
      } catch (error) {
        pending = null;
        clearTimeout(timer);
        resolve({ ok: false, error: `helper write: ${error.message}` });
      }
    });
  }

  return {
    request(request) {
      const next = queue.then(() => exchange(request), () => exchange(request));
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

/** The desktop note, as one module-level record the routes mutate. */
export function apply(ctx) {
  // Stickers that work on every platform go first: the settings page must exist
  // even where the Windows-only note window does not.
  applyPinTop(ctx);

  // Plugin list / check / update routes (vendored from dsh-installed-plugins).
  ctx.inject(['webServer'], (scope) => {
    try {
      applyPluginsHost(scope);
    } catch (error) {
      ctx.logger('dsh-desk-stickers/plugins').warn('plugin page wiring failed: ' + String(error && error.message ? error.message : error));
    }
  });

  // Restart: /restart command, restart_dsh tool and the HTTP pair. Its apply
  // expects the commands service on the context it receives.
  ctx.inject(['commands', 'webServer'], (scope) => {
    try {
      applyRestartHost(scope);
    } catch (error) {
      ctx.logger('dsh-desk-stickers/restart').warn('restart wiring failed: ' + String(error && error.message ? error.message : error));
    }
  });

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/settings`,
        handler: (request, response) => {
          if (request.method === 'POST') {
            void readJsonBody(request)
              .then(async (body) => {
                const next = await saveSettings(body && body.settings !== undefined ? body.settings : body);
                sendJson(response, 200, { ok: true, settings: next, path: SETTINGS_FILE });
              })
              .catch((error) => sendJson(response, 500, { ok: false, error: String(error?.message ?? error) }));
            return;
          }
          void loadSettings().then((settings) => {
            sendJson(response, 200, { ok: true, settings, path: SETTINGS_FILE });
          });
        },
      }),
    );
  });

  if (!IS_WINDOWS) {
    ctx.logger('dsh-desk-stickers').info('the desktop note is a Windows feature; the in-app note still works');
    return;
  }

  const helper = createHelper();
  ctx.effect(() => () => helper.dispose());
  let state = emptyState();
  let saveTimer = null;
  let pageCache = { mtime: -1, html: '' };
  let windowProcess = null;
  let origin = '';

  // Chromium can drop the top layer on focus transitions, so a pinned note is
  // re-asserted on a slow beat while it is on screen. The pin button clears
  // `state.pinned`, which also stops this guard.
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (state.open !== true || state.pinned !== true) return;
      void helper.request({ action: 'topmost', title: WINDOW_TITLE, on: true });
    }, 5000);
    return () => clearInterval(timer);
  });

  function scheduleSave() {
    if (saveTimer !== null) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void mkdir(DATA_DIR, { recursive: true })
        .then(() => writeFile(STATE_FILE, JSON.stringify({ ...state, open: false }), 'utf8'))
        .catch(() => {
          /* a note that cannot be remembered still works for this session */
        });
    }, 250);
  }

  /** Write one patch into the shared record and bump its revision. */
  function bump(patch) {
    state = normalizeState({ ...state, ...patch, rev: state.rev + 1, updatedAt: Date.now() });
    scheduleSave();
    return state;
  }

  /** The note fields a surface may change, taken from a request body. */
  function noteFromBody(body) {
    const source = body !== null && typeof body.note === 'object' && body.note !== null ? body.note : body;
    const patch = {};
    for (const key of ['mode', 'fontSize', 'text', 'grid', 'list']) {
      if (source[key] !== undefined) patch[key] = source[key];
    }
    return patch;
  }

  /**
   * Wait for the window to exist, then place it and put it on top.
   *
   * Both steps go through the helper because neither is a browser API: app-mode
   * Chromium window geometry is restored by the browser itself (`--window-*` is
   * only a hint on a fresh profile), and the topmost flag never reaches a page.
   */
  async function placeWindow(box) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const probe = await helper.request({ action: 'status', title: WINDOW_TITLE });
      if (probe !== null && probe.ok === true && probe.found === true) {
        await helper.request({ action: 'activate', title: WINDOW_TITLE });
        let placed = false;
        let topmost = probe.topmost === true;
        // The browser re-applies its own restored placement right after a window
        // is shown, which can undo both the position and the top layer; a short
        // retry loop settles on the state the plugin wants.
        for (let round = 0; round < 3; round += 1) {
          const moved = await helper.request({
            action: 'move',
            title: WINDOW_TITLE,
            x: box.x,
            y: box.y,
            w: box.w,
            h: box.h,
          });
          const raised = await helper.request({ action: 'topmost', title: WINDOW_TITLE, on: state.pinned });
          placed = moved?.moved === true;
          topmost = raised?.topmost === true;
          if (topmost || state.pinned !== true) break;
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        return { placed, topmost };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { placed: false, topmost: false };
  }

  /** Close the desktop window (helper first, then the process tree as a fallback). */
  async function closeWindow() {
    await helper.request({ action: 'close', title: WINDOW_TITLE });
    const proc = windowProcess;
    if (proc !== null && Number.isInteger(proc.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const probe = await helper.request({ action: 'status', title: WINDOW_TITLE });
      if (probe === null || probe.found !== true) {
        try {
          spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(proc.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
            detached: true,
          }).unref();
        } catch {
          /* the process is going away on its own */
        }
      }
    }
    windowProcess = null;
  }

  /** Open the desktop window for the current record, or raise the existing one. */
  async function openWindow() {
    const existing = await helper.request({ action: 'status', title: WINDOW_TITLE });
    if (existing !== null && existing.ok === true && existing.found === true) {
      await helper.request({ action: 'activate', title: WINDOW_TITLE });
      const raised = await helper.request({ action: 'topmost', title: WINDOW_TITLE, on: true });
      return { ok: true, reused: true, topmost: raised?.topmost === true };
    }
    if (windowProcess !== null) {
      await closeWindow();
    }
    const bin = pickBrowser();
    if (bin === null) return { ok: false, error: 'no-browser' };
    if (origin === '') return { ok: false, error: 'no-origin' };

    await mkdir(PROFILE_DIR, { recursive: true }).catch(() => {});

    const screen = await helper.request({ action: 'screen' });
    const work = screen !== null && typeof screen === 'object' && screen.ok === true && screen.work !== undefined
      ? screen.work
      : { x: 0, y: 0, width: 1920, height: 1080 };
    const rect = state.rect !== null ? state.rect : { x: work.x + 120, y: work.y + 120, ...DEFAULT_SIZE };
    const width = clamp(rect.w, 220, Math.max(220, work.width - 16));
    const height = clamp(rect.h, 180, Math.max(180, work.height - 16));
    const x = clamp(rect.x, work.x + 4, work.x + work.width - width - 4);
    const y = clamp(rect.y, work.y + 4, work.y + work.height - height - 4);

    const args = [
      `--app=${origin}${ROUTE}/desktop`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-features=msEdgeFRE,msEdgeDefaultBrowserPrompt,Translate',
      '--window-size=' + String(width) + ',' + String(height),
      '--window-position=' + String(x) + ',' + String(y),
    ];

    let proc;
    try {
      proc = spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: false });
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
    windowProcess = proc;
    proc.unref();
    proc.once('exit', () => {
      if (windowProcess === proc) windowProcess = null;
      // A deliberately closed window ends the record; an instance hand-off to an
      // already-running browser does not, so the question is asked of the window.
      setTimeout(() => {
        void helper.request({ action: 'status', title: WINDOW_TITLE }).then((probe) => {
          if (state.open === true && (probe === null || probe.found !== true)) bump({ open: false });
        });
      }, 1400);
    });

    const placement = await placeWindow({ x, y, w: width, h: height });
    return { ok: true, ...placement, pid: Number.isInteger(proc.pid) ? proc.pid : null };
  }

  /** Serves `desktop.html`, refreshing the cache when the file changes. */
  async function servePage(response) {
    try {
      const info = await stat(PAGE_FILE);
      if (info.mtimeMs !== pageCache.mtime) {
        pageCache = { mtime: info.mtimeMs, html: await readFile(PAGE_FILE, 'utf8') };
      }
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(pageCache.html);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(String(error?.message ?? error));
    }
  }

  // A window left over from a previous run would show a stale note and poll a
  // dead port, so every start begins by putting the record to rest and closing it.
  void readFile(STATE_FILE, 'utf8')
    .then((raw) => {
      state = normalizeState(JSON.parse(raw));
      state = normalizeState({ ...state, open: false });
    })
    .catch(() => {
      /* first run: no record yet */
    })
    .then(() => helper.request({ action: 'close', title: WINDOW_TITLE }))
    .catch(() => undefined);

  ctx.inject(['webServer'], (webCtx) => {
    origin = webCtx.webServer.getOrigin();

    const disposers = [
      webCtx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/desktop`,
        handler: (request, response) => {
          if (request.method !== 'GET') {
            sendJson(response, 405, { ok: false, error: '只能 GET' });
            return;
          }
          void servePage(response);
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/state`,
        handler: (request, response) => {
          if (request.method === 'POST') {
            void readJsonBody(request).then((body) => {
              const patch = noteFromBody(body);
              if (body.rect !== undefined) patch.rect = body.rect;
              if (body.theme !== undefined) patch.theme = body.theme;
              if (patch.fontSize !== undefined) patch.fontSize = normalizeState({ fontSize: patch.fontSize }).fontSize;
              sendJson(response, 200, { ok: true, rev: bump(patch).rev });
            });
            return;
          }
          sendJson(response, 200, state);
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/sync`,
        handler: (request, response) => {
          if (request.method !== 'POST') {
            sendJson(response, 405, { ok: false, error: '只能 POST' });
            return;
          }
          void readJsonBody(request).then((body) => {
            const patch = noteFromBody(body);
            if (body.rect !== undefined) patch.rect = body.rect;
            const next = bump(patch);
            sendJson(response, 200, { ok: true, rev: next.rev });
          });
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/popout`,
        handler: (request, response) => {
          if (request.method !== 'POST') {
            sendJson(response, 405, { ok: false, error: '只能 POST' });
            return;
          }
          void (async () => {
            const body = await readJsonBody(request);
            const patch = noteFromBody(body);
            if (body.rect !== undefined) patch.rect = normalizeRect(body.rect);
            if (typeof body.sessionKey === 'string') patch.sessionKey = body.sessionKey;
            if (typeof body.label === 'string') patch.label = body.label;
            if (body.theme !== undefined) patch.theme = body.theme;
            patch.open = true;
            patch.pinned = true;
            const next = bump(patch);
            const result = await openWindow();
            sendJson(response, result.ok ? 200 : 409, { ...result, rev: next.rev, open: result.ok });
          })().catch((error) => sendJson(response, 500, { ok: false, error: String(error?.message ?? error) }));
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/retract`,
        handler: (request, response) => {
          if (request.method !== 'POST' && request.method !== 'GET') {
            sendJson(response, 405, { ok: false, error: '只能 POST' });
            return;
          }
          void (async () => {
            await readJsonBody(request).catch(() => ({}));
            const next = bump({ open: false });
            await closeWindow();
            sendJson(response, 200, { ok: true, rev: next.rev, state: next });
          })().catch((error) => sendJson(response, 500, { ok: false, error: String(error?.message ?? error) }));
        },
      }),
      webCtx.webServer.register({
        kind: 'exact',
        path: `${ROUTE}/topmost`,
        handler: (request, response) => {
          if (request.method !== 'POST') {
            sendJson(response, 405, { ok: false, error: '只能 POST' });
            return;
          }
          void readJsonBody(request).then(async (body) => {
            const on = body.on !== false;
            const result = await helper.request({ action: 'topmost', title: WINDOW_TITLE, on });
            bump({ pinned: on });
            sendJson(response, 200, { ok: result?.ok === true, topmost: result?.topmost === true, found: result?.found === true });
          });
        },
      }),
    ];

    webCtx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* one bad disposer must not keep the rest registered */
        }
      }
    });
  });

  ctx.effect(() => () => {
    if (saveTimer !== null) clearTimeout(saveTimer);
  });
}
