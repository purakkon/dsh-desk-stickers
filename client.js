/**
 * Sticky note — Client half.
 *
 * One seat, one job: a button in the conversation header that puts a real
 * desktop sticky note on screen, and takes it away again.
 *
 * Why the note is not drawn here
 * ------------------------------
 * A note inside the Harness window can never leave it - it is painted inside one
 * OS window. Everything the user asked for (put it anywhere on the desktop, on
 * top of other windows, while the conversation keeps running) needs an OS window
 * of its own, so the note lives in `desktop.html`, served by the Host half, and
 * this half only owns the switch.
 *
 * The stored note stays here, per conversation, in localStorage: the button
 * sends this conversation's note to the desktop window, and a small poll brings
 * the window's content back into that same record. Closing the window with its X
 * saves the text too, so nothing is lost by closing instead of pressing 收回.
 */
window.__ModuleLoader__.load({
  id: 'dsh-desk-stickers',

  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const STORAGE_KEY = 'dsh-sticky-note.v3';
    const MODES = ['text', 'grid', 'list'];
    const FONT_MIN = 11;
    const FONT_MAX = 30;
    const POLL_MS = 1200;

    /** The Host half's HTTP surface: the only channel between the two halves. */
    const ROUTES = {
      state: '/plugins/dsh-desk-stickers/state',
      popout: '/plugins/dsh-desk-stickers/popout',
      retract: '/plugins/dsh-desk-stickers/retract',
      settings: '/plugins/dsh-desk-stickers/settings',
    };

    const COPY = {
      zh: {
        open: '把便签放到桌面',
        close: '把桌面便签收回',
        switchNote: '换成这个会话的便签',
        failed: '没能打开桌面便签（没找到 Edge 或 Chrome）',
        busy: '正在打开桌面便签…',
        perSession: '每个会话有自己的便签',
        pinOff: '窗口置顶',
        pinOn: '取消置顶',
        pinBusy: '正在切换窗口置顶…',
      },
      en: {
        open: 'Put the sticky note on the desktop',
        close: 'Put the desktop note away',
        switchNote: 'Show this conversation’s note on the desktop',
        failed: 'Could not open the desktop note (no Edge or Chrome found)',
        busy: 'Opening the desktop note…',
        perSession: 'Each conversation keeps its own note',
        pinOff: 'Keep this window on top',
        pinOn: 'Stop keeping this window on top',
        pinBusy: 'Changing window pin…',
      },
    };

    const CSS = `
.dsh-note-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: default;
  transition: background-color 120ms ease, color 120ms ease, transform 90ms ease;
}
.dsh-pin-top__button:active { transform: scale(0.88); }
.dsh-pin-top__button[data-pinned="true"] { box-shadow: inset 0 0 0 1px currentColor; }
@keyframes dsh-pin-pop {
  0% { transform: scale(0.82); }
  55% { transform: scale(1.14); }
  100% { transform: scale(1); }
}
.dsh-pin-top__button[data-pulse="true"] { animation: dsh-pin-pop 320ms ease; }
.dsh-note-trigger:hover {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.dsh-note-trigger[data-active="true"],
.dsh-note-trigger[data-active="true"]:hover {
  color: var(--dsw-alias-brand-primary);
}
.dsh-note-trigger[data-failed="true"] { color: var(--dsw-alias-state-error-primary); }
/* The note sticker switched off in the desktop settings page: keep the seat,
   paint nothing, so the header row does not jump when it comes back. */
.dsh-note-trigger[data-hidden="true"] { display: none !important; }
.dsh-note-trigger:disabled { opacity: 0.55; }
.dsh-note-trigger:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
`;

    // ---------------------------------------------------------------- helpers

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }

    function makeId() {
      return Math.random().toString(36).slice(2, 9);
    }

    function normalizeGrid(value) {
      const source = value !== null && typeof value === 'object' ? value : {};
      const rows = clamp(Math.round(Number(source.rows) || 5), 1, 60);
      const cols = clamp(Math.round(Number(source.cols) || 3), 1, 20);
      const cells = [];
      for (let r = 0; r < rows; r += 1) {
        const row = Array.isArray(source.cells) && Array.isArray(source.cells[r]) ? source.cells[r] : [];
        cells.push(Array.from({ length: cols }, (_, c) => (typeof row[c] === 'string' ? row[c] : '')));
      }
      // Column widths and row heights travel with the sheet, so a grid line the
      // user dragged stays where it was put.
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

    function normalizeList(value) {
      if (!Array.isArray(value)) return [];
      return value
        .filter((item) => item !== null && typeof item === 'object')
        .slice(0, 200)
        .map((item) => ({
          id: typeof item.id === 'string' && item.id !== '' ? item.id : makeId(),
          text: typeof item.text === 'string' ? item.text : '',
          done: item.done === true,
        }));
    }

    function normalizeRect(value) {
      if (value === null || typeof value !== 'object') return null;
      const x = Number(value.x);
      const y = Number(value.y);
      const w = Number(value.w);
      const hgt = Number(value.h);
      if (![x, y, w, hgt].every((n) => Number.isFinite(n))) return null;
      return { x, y, w, h: hgt };
    }

    /** One conversation's note. */
    function emptyNote() {
      return {
        mode: 'text',
        fontSize: 14,
        text: '',
        grid: normalizeGrid(null),
        list: [{ id: makeId(), text: '', done: false }],
      };
    }

    function normalizeNote(value) {
      const base = emptyNote();
      if (value === null || typeof value !== 'object') return base;
      return {
        mode: MODES.includes(value.mode) ? value.mode : base.mode,
        fontSize: clamp(Math.round(Number(value.fontSize) || base.fontSize), FONT_MIN, FONT_MAX),
        text: typeof value.text === 'string' ? value.text : '',
        grid: normalizeGrid(value.grid),
        list: normalizeList(value.list),
      };
    }

    /** Session ids are strings; the no-session surface uses one fixed key. */
    function noteKey(value) {
      return typeof value === 'string' && value !== '' ? value : '_';
    }

    function loadNotes() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw === null) return {};
        const saved = JSON.parse(raw);
        if (saved === null || typeof saved !== 'object' || saved.notes === null || typeof saved.notes !== 'object') return {};
        const notes = {};
        for (const [key, value] of Object.entries(saved.notes)) notes[key] = normalizeNote(value);
        return notes;
      } catch {
        return {};
      }
    }

    function createStore() {
      let state = { notes: loadNotes() };
      const listeners = new Set();
      let timer = null;

      function persistLater() {
        if (timer !== null) return;
        timer = window.setTimeout(() => {
          timer = null;
          try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ notes: state.notes }));
          } catch {
            /* private mode: the note simply is not remembered */
          }
        }, 300);
      }

      return {
        get() {
          return state;
        },
        writeNote(key, note) {
          state = { ...state, notes: { ...state.notes, [key]: note } };
          persistLater();
          for (const listener of Array.from(listeners)) listener(state);
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
    }

    function readLanguage(ctx) {
      let id = '';
      const service = ctx.get('locale');
      try {
        const snapshot =
          typeof service?.getLocale === 'function'
            ? service.getLocale()
            : typeof service?.getSnapshot === 'function'
              ? service.getSnapshot()
              : undefined;
        id = String(snapshot?.id ?? snapshot?.locale ?? '');
      } catch {
        id = '';
      }
      if (id === '') id = document.documentElement.lang || '';
      return id.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    }

    function useSnapshot(store) {
      const [snapshot, setSnapshot] = React.useState(store.get);
      React.useEffect(() => store.subscribe(setSnapshot), [store]);
      return snapshot;
    }

    /**
     * Resolve a theme token to a concrete color.
     *
     * The desktop window is a separate document with no theme service, so the
     * colors travel with the note. A probe element turns a token (possibly a
     * `var(...)` chain) into the `rgb()` value the other side can paint with.
     */
    function resolveColor(token, fallback) {
      const probe = document.createElement('span');
      probe.style.color = `var(${token})`;
      probe.style.position = 'absolute';
      probe.style.opacity = '0';
      probe.style.pointerEvents = 'none';
      document.body.appendChild(probe);
      let value = '';
      try {
        value = window.getComputedStyle(probe).color;
      } catch {
        value = '';
      }
      probe.remove();
      return typeof value === 'string' && value !== '' ? value : fallback;
    }

    function readTheme() {
      return {
        bg: resolveColor('--dsw-alias-bg-overlay', '#202124'),
        fg: resolveColor('--dsw-alias-label-primary', '#e8e8ea'),
        bar: resolveColor('--dsw-alias-bg-layer-2', '#2a2b2f'),
        line: resolveColor('--dsw-alias-border-l1', 'rgba(255, 255, 255, 0.14)'),
        muted: resolveColor('--dsw-alias-label-secondary', 'rgba(232, 232, 234, 0.62)'),
        layer1: resolveColor('--dsw-alias-bg-layer-1', 'rgba(255, 255, 255, 0.06)'),
        layer2: resolveColor('--dsw-alias-bg-layer-2', 'rgba(255, 255, 255, 0.1)'),
        brand: resolveColor('--dsw-alias-brand-primary', '#c2832a'),
      };
    }

    function getJson(url) {
      return fetch(url, { cache: 'no-store' }).then((response) => (response.ok ? response.json() : null));
    }

    function postJson(url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        cache: 'no-store',
      }).then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))));
    }

    // ------------------------------------------------------------------ glyph

    /** A page with a folded corner: the sticky note itself. */
    function NoteGlyph() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M2.6 3.2h10.8v6.4L9.8 13.2H2.6z' }),
        h('path', { d: 'M13.4 9.6H9.8v3.6' }),
        h('path', { d: 'M5 6.1h6M5 8.4h4' }),
      );
    }

    // ------------------------------------------------------- pin on top
    //
    // One button inside the Windows title strip. The pin itself is a Host
    // operation (SetWindowPos through PowerShell); this half only calls
    // `POST /plugins/dsh-desk-stickers/pin-top` and mirrors the answer.

    const PIN_ROUTE = '/plugins/dsh-desk-stickers/pin-top';

    const PIN_CSS = `
.dsh-pin-top {
  position: absolute;
  top: 0;
  right: var(--dsh-pin-top-right, 140px);
  height: var(--dsh-windows-titlebar-height, 40px);
  display: none;
  align-items: center;
  z-index: 4;
  pointer-events: none;
}
html[data-windows-titlebar] .dsh-pin-top { display: flex; }
html[data-windows-titlebar][data-fullscreen] .dsh-pin-top { right: 12px; }
.dsh-pin-top[data-hidden="true"] { display: none !important; }
.dsh-pin-top__button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: default;
  pointer-events: auto;
  -webkit-app-region: no-drag;
  position: relative;
  transition: background-color 120ms ease, color 120ms ease, transform 90ms ease;
}
.dsh-pin-top__button:active { transform: scale(0.88); }
/* Pinned is a shape, not only a colour: a bar under the glyph. */
.dsh-pin-top__button[data-pinned="true"]::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: 3px;
  width: 14px;
  height: 2px;
  border-radius: 1px;
  background: currentColor;
}
.dsh-pin-top__button[data-pinned="true"] { box-shadow: inset 0 0 0 1px currentColor; }
@keyframes dsh-pin-pop { 0% { transform: scale(0.82); } 55% { transform: scale(1.14); } 100% { transform: scale(1); } }
.dsh-pin-top__button[data-pulse="true"] { animation: dsh-pin-pop 320ms ease; }
.dsh-pin-top__button:hover:not(:disabled) {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.dsh-pin-top__button[data-pinned="true"],
.dsh-pin-top__button[data-pinned="true"]:hover:not(:disabled) {
  color: var(--dsw-alias-brand-primary);
}
.dsh-pin-top__button[data-custom="true"],
.dsh-pin-top__button[data-custom="true"][data-pinned="true"],
.dsh-pin-top__button[data-custom="true"]:hover:not(:disabled) { color: inherit; }
.dsh-pin-top__button:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
.dsh-pin-top__button:disabled { opacity: 0.55; }
.dsh-pin-top[data-failed="true"] .dsh-pin-top__button { color: var(--dsw-alias-state-error-primary); }
.dsh-pin-top__divider {
  flex: none;
  width: 1px;
  height: 14px;
  margin-left: 2px;
  background: var(--dsw-alias-border-l1);
  pointer-events: none;
}
`;

    /** Arrow rising into a bar: the "raise this window above the rest" glyph. */
    function PinGlyph() {
      return h('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', { d: 'M3.2 3.2h9.6' }),
        h('path', { d: 'M8 13.2V6.4' }),
        h('path', { d: 'M4.9 9.3 8 6.2l3.1 3.1' }),
      );
    }

    function pinRequest(action) {
      return fetch(PIN_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
        cache: 'no-store',
      }).then((response) => {
        if (!response.ok) throw new Error('pin-top: HTTP ' + response.status);
        return response.json();
      });
    }

    /** `rgb(170, 175, 180)` / `rgba(…)` → `#aaafb4`, or '' when unparseable. */
    function rgbToHex(value) {
      const match = /rgba?\(([^)]+)\)/i.exec(String(value || ''));
      if (match === null) return '';
      const parts = match[1].split(',').map((part) => Number.parseFloat(part.trim()));
      if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return '';
      return '#' + parts.slice(0, 3)
        .map((part) => Math.max(0, Math.min(255, Math.round(part))).toString(16).padStart(2, '0'))
        .join('');
    }

    /** Resolve one CSS colour token against the current skin. */
    function resolveToken(token) {
      if (typeof document === 'undefined') return '';
      const probe = document.createElement('span');
      probe.setAttribute('style', 'position:absolute;left:-9999px;top:0;visibility:hidden;color:' + token);
      (document.body || document.documentElement).appendChild(probe);
      const computed = window.getComputedStyle(probe).color;
      probe.remove();
      return rgbToHex(computed);
    }

    /** Mix a hex colour toward white (amount > 0) or toward black (amount < 0). */
    function shiftHex(hex, amount) {
      if (!/^#[0-9a-f]{6}$/i.test(String(hex || ''))) return '';
      const value = parseInt(hex.slice(1), 16);
      const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
      const target = amount >= 0 ? 255 : 0;
      const weight = Math.min(1, Math.abs(amount));
      const mixed = channels.map((channel) => Math.round(channel + (target - channel) * weight));
      return '#' + mixed.map((channel) => channel.toString(16).padStart(2, '0')).join('');
    }

    /**
     * The two colours a sticker takes while following the skin:
     *   off — the titlebar foreground the Windows caption buttons are drawn in
     *   on  — a second, visibly different colour from the same skin: the brand
     *         token when it resolves to something else, otherwise the idle
     *         colour pushed toward white (dark skins) or black (light skins).
     */
    /** Relative luminance, 0..1, good enough to compare two colours. */
    function luminance(hex) {
      if (!/^#[0-9a-f]{6}$/i.test(String(hex || ''))) return 0;
      const value = parseInt(hex.slice(1), 16);
      const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    }

    function resolveSkinPair() {
      // The window's minimise / maximise / close buttons are painted by Windows
      // itself, so no DOM element exposes their colour. The closest readable
      // pair is the titlebar text family: the title is drawn in the same ink as
      // those glyphs. Resting = the secondary label, pinned = the primary one,
      // which gives two tones that both belong to the titlebar.
      const dark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : false;
      const off = resolveToken('var(--dsw-alias-label-secondary, currentColor)') || (dark ? '#c9ccd2' : '#4a4d52');
      const on = resolveToken('var(--dsw-alias-label-primary, currentColor)') || (dark ? '#f2f4f8' : '#1d1f22');
      return { off, on: on === off ? shiftHex(off, 0.3) : on };
    }

    /**
     * The ink of the menu list: instead of guessing a class name, take the text
     * elements just below the fold bar and pick the colour most of them share
     * (menu rows are all painted in one colour, whatever skin is active).
     */
    function sampleMenuTextColor() {
      // The probe showed every menu row is a *panelTitle element; the hash prefix
      // changes per build, so match on the suffix only. Scope it to the sidebar
      // first: the same class also appears outside it, and the first match in
      // document order may belong to the shell instead of the menu.
      const scope = document.querySelector('[data-sidebar-scrollport]')
        || document.querySelector('[data-slot="sidebar.panellist"]');
      const titled = (scope !== null ? scope.querySelector('[class*="panelTitle"]') : null)
        || document.querySelector('[class*="panelTitle"]');
      if (titled !== null) {
        const color = window.getComputedStyle(titled).color;
        if (color && color !== 'rgba(0, 0, 0, 0)') return color;
      }
      const bar = document.querySelector('.dsh-sidebar-fold__bar');
      const rect = bar === null ? null : bar.getBoundingClientRect();
      const counts = new Map();
      for (const el of document.querySelectorAll('button, a, span, li, div, p')) {
        if (el.childElementCount !== 0) continue;
        if (bar !== null && bar.contains(el)) continue;
        const text = (el.textContent || '').trim();
        if (text === '' || text.length > 16) continue;
        const box = el.getBoundingClientRect();
        if (box.width < 6 || box.height < 8) continue;
        if (box.left > 330) continue;
        if (rect !== null && (box.top < rect.top - 6 || box.top > rect.top + 340)) continue;
        const color = window.getComputedStyle(el).color;
        if (!color || color === 'rgba(0, 0, 0, 0)') continue;
        counts.set(color, (counts.get(color) || 0) + 1);
      }
      let best = '';
      let bestCount = 0;
      for (const [color, count] of counts) {
        if (count > bestCount) { best = color; bestCount = count; }
      }
      return best;
    }

    /**
     * The ink of the window title strip: majority vote over the small text in
     * the top 60px. Same technique as the menu bar — read the place, do not
     * hard-code a token that may not exist in someone else's skin.
     */
    function sampleTitlebarInk() {
      const counts = new Map();
      for (const el of document.querySelectorAll('span, div, p, strong, h1, h2')) {
        if (el.childElementCount !== 0) continue;
        const text = (el.textContent || '').trim();
        if (text === '' || text.length > 24) continue;
        const box = el.getBoundingClientRect();
        if (box.width < 6 || box.height < 8) continue;
        if (box.top > 60) continue;
        const color = window.getComputedStyle(el).color;
        if (!color || color === 'rgba(0, 0, 0, 0)') continue;
        counts.set(color, (counts.get(color) || 0) + 1);
      }
      let best = '';
      let bestCount = 0;
      for (const [color, count] of counts) {
        if (count > bestCount) { best = color; bestCount = count; }
      }
      return best;
    }

    /** One explicit colour for a sticker, or '' when it follows the skin. */
    function singleColor(settings, key) {
      const block = settings && settings[key];
      const color = block && block.color;
      if (!color || color.mode !== 'custom') return '';
      const value = String(color.value || '').toLowerCase();
      return /^#[0-9a-f]{6}$/.test(value) ? value : '';
    }

    /** The two colours the fold controls actually take right now. */
    function sampleFoldPair() {
      const read = (selector) => {
        const el = document.querySelector(selector);
        if (el === null) return '';
        return rgbToHex(window.getComputedStyle(el).color);
      };
      const menu = rgbToHex(sampleMenuTextColor());
      let workspace = '';
      const flow = document.querySelector('[data-slot="sidebar.workspaces.directoryFlow"]');
      const header = flow !== null ? flow.parentElement : null;
      if (header !== null) {
        const label = header.querySelector('[class*="sectionLabel"]') || header.querySelector('span');
        if (label !== null) workspace = rgbToHex(window.getComputedStyle(label).color);
      }
      return { off: menu, on: workspace };
    }

    /** Re-render once a second while a live colour is on screen. */
    function useTick() {
      const [tick, setTick] = React.useState(0);
      React.useEffect(() => {
        const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
        return () => window.clearInterval(timer);
      }, []);
      return tick;
    }

    /** Resolved skin pair, re-read whenever the theme changes. */
    function useSkinPair() {
      const [value, setValue] = React.useState(() => resolveSkinPair());
      React.useEffect(() => {
        const refresh = () => setValue(resolveSkinPair());
        refresh();
        const observer = new MutationObserver(refresh);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'lang'] });
        return () => observer.disconnect();
      }, []);
      return value;
    }

    /**
     * Explicit colour for one sticker state ('off' or 'on'), or '' when the
     * sticker should follow the skin. Two states because a pin and a fold bar
     * both look different at rest and while active.
     */
    function stickerColor(settings, key, state) {
      const defaults = { off: '#9aa0a6', on: '#4b8bf5' };
      const block = settings && settings[key];
      const color = (block && block.color) || {};
      // `auto` means "follow the active skin": return '' so the stylesheet's
      // theme variables win instead of an inline colour.
      if (color.mode !== 'custom') return '';
      const wanted = String(color[state] || '').toLowerCase();
      return /^#[0-9a-f]{6}$/.test(wanted) ? wanted : defaults[state] || defaults.off;
    }

    // Components live at factory scope, but `ctx` only exists inside apply().
    // The overlay component reads the locale service through this reference.
    let activeCtx = null;

    // Constants that lived above the vendored stylesheet in the original file.
    const MENU_KEY = 'dsh-sidebar-fold.menu.v1';
    const LIST_KEY = 'dsh-sidebar-fold.list.v1';
    const HIDDEN_CLASS = 'dsh-sidebar-fold--hidden';

    const SIDEBAR_FOLD_CSS = `
.dsh-sidebar-fold__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  align-self: center;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  margin-right: 14px;
  margin-left: 1px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsh-fold-icon-color, var(--dsw-alias-label-secondary));
  cursor: default;
  transition: background-color 120ms ease, color 120ms ease;
}
.dsh-sidebar-fold__button:hover {
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-sidebar-fold__button:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
.dsh-sidebar-fold__button svg {
  transition: transform 160ms ease;
}
.dsh-sidebar-fold__button[aria-pressed="true"] svg {
  transform: rotate(-90deg);
}

.dsh-sidebar-fold__bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  flex: 0 0 auto;
  width: auto;
  min-width: 0;
  height: 18px;
  /* flex column -> stretch on the cross axis; grid (the newer sidebar) -> stretch
     on the inline axis. Both give the bar the column's width. */
  align-self: stretch;
  justify-self: stretch;
  margin: 2px 8px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsh-fold-bar-color, var(--dsw-alias-label-secondary));
  opacity: 0.55;
  cursor: default;
  transition: background-color 120ms ease, opacity 120ms ease;
}
.dsh-sidebar-fold__bar:hover,
.dsh-sidebar-fold__bar:focus-visible {
  background: var(--dsw-alias-bg-layer-2);
  opacity: 1;
}
.dsh-sidebar-fold__bar:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
.dsh-sidebar-fold__bar svg {
  transition: transform 160ms ease;
}
/* Same rule as the Workspace chevron: a visible panel points down, a folded one points right. */
.dsh-sidebar-fold__bar[aria-pressed="true"] svg {
  transform: rotate(-90deg);
}
.dsh-sidebar-fold__barLabel {
  font-size: 11px;
  line-height: 1;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.dsh-sidebar-fold--hidden {
  display: none !important;
}
/* Colours, in fallback order: our explicit setting → the colour this plugin
   borrowed from the surrounding header → the theme token. */
.dsh-sidebar-fold__bar { color: var(--dsh-fold-color-off, var(--dsh-fold-bar-color, var(--dsw-alias-label-secondary))); }
.dsh-sidebar-fold__button { color: var(--dsh-fold-color-off, var(--dsh-fold-icon-color, var(--dsw-alias-label-secondary))); }
.dsh-sidebar-fold__bar[aria-pressed="true"] { color: var(--dsh-fold-color-on, var(--dsh-fold-bar-color, var(--dsw-alias-brand-primary))); }
.dsh-sidebar-fold__button[aria-pressed="true"] { color: var(--dsh-fold-color-on, var(--dsh-fold-icon-color, var(--dsw-alias-brand-primary))); }
/* The vendored bar dims itself to 55% until hovered, which reads as "grey". */
.dsh-sidebar-fold__bar { opacity: 1 !important; }
html[data-dsh-fold-off="true"] .dsh-sidebar-fold__bar,
html[data-dsh-fold-off="true"] .dsh-sidebar-fold__button { display: none !important; }
`;

    const LABELS = {
      zh: { fold: '收起会话列表', unfold: '展开会话列表', foldMenu: '收起菜单', unfoldMenu: '展开菜单' },
      en: {
        fold: 'Fold the session list',
        unfold: 'Unfold the session list',
        foldMenu: 'Fold the menu',
        unfoldMenu: 'Unfold the menu',
      },
    };

    const SECTION_TITLES = new Set(['工作区', '工作區', 'workspace', 'workspaces', 'sessions']);

    const CHEVRON =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M3.4 6.1 8 10.7l4.6-4.6"/></svg>';
    const CHEVRON_SMALL =
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M3.4 6.1 8 10.7l4.6-4.6"/></svg>';

    function readFoldLanguage() {
      const lang = (document.documentElement.lang || '').toLowerCase();
      return lang.startsWith('zh') ? 'zh' : 'en';
    }

    function readFlag(key) {
      try {
        return window.localStorage.getItem(key) === '1';
      } catch {
        return false;
      }
    }

    function writeFlag(key, value) {
      try {
        window.localStorage.setItem(key, value ? '1' : '0');
      } catch {
        /* private mode: the state simply is not remembered */
      }
    }

    /** Last-resort anchor: a leaf whose text is exactly the section title. */
    function findTitleNode() {
      if (document.body === null) return null;
      const candidates = document.body.querySelectorAll('span, div, button, p, strong, h2, h3, a');
      for (const el of candidates) {
        if (el.childElementCount !== 0) continue;
        const text = (el.textContent || '').trim().toLowerCase();
        if (text === '' || !SECTION_TITLES.has(text)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 12 || rect.height < 8) continue;
        if (rect.left > 400 || rect.top > 520) continue;
        return el;
      }
      return null;
    }

    /** The Workspace section header row: the row that owns the flow hole. */
    function findWorkspaceHeader() {
      const flow = document.querySelector('[data-slot="sidebar.workspaces.directoryFlow"]');
      if (flow !== null && flow.parentElement !== null) return flow.parentElement;
      const title = findTitleNode();
      return title === null ? null : title.parentElement;
    }

    /** The foldable session list: the header's scrolling sibling. */
    function findListTarget(headerRow) {
      const direct = headerRow.nextElementSibling;
      if (direct !== null && direct.getBoundingClientRect().height > 0) {
        const style = window.getComputedStyle(direct);
        const overflowY = `${style.overflowY}`;
        if (overflowY !== 'visible' || direct.scrollHeight > direct.clientHeight + 8) return direct;
      }
      let node = headerRow;
      for (let depth = 0; depth < 5; depth += 1) {
        const parent = node.parentElement;
        if (parent === null) break;
        const siblings = Array.from(parent.children).filter((el) => el !== node);
        const scrollable = siblings.find((el) => {
          const style = window.getComputedStyle(el);
          const overflowY = `${style.overflowY}`;
          if (overflowY === 'auto' || overflowY === 'scroll') return true;
          return el.scrollHeight > el.clientHeight + 8;
        });
        if (scrollable !== undefined) return scrollable;
        node = parent;
      }
      const tree = document.querySelector('[data-slot="sidebar.workspaces"] [role="tree"]');
      if (tree !== null && tree.parentElement !== null) return tree.parentElement;
      return direct;
    }

    /** The panel menu: the NAV that owns the panel glyphs. */
    function findMenu() {
      let node = document.querySelector('[data-slot="sidebar.panellist"]');
      while (node !== null && node !== document.body && node.tagName !== 'NAV') node = node.parentElement;
      if (node !== null && node !== document.body && node.querySelectorAll('button').length >= 3) return node;
      const labelled = document.querySelector('nav[aria-label]');
      return labelled !== null && labelled.querySelectorAll('button').length >= 3 ? labelled : null;
    }

    /** Borrow the painted colour of a neighbouring native icon, for any skin. */
    function borrowColor(from, to, property) {
      if (from === null || to === null) return;
      const source = from.querySelector('svg') ?? from;
      const color = window.getComputedStyle(source).color;
      if (typeof color === 'string' && color !== '') to.style.setProperty(property, color);
    }

    function attach(labels) {
      const state = {
        menuFolded: readFlag(MENU_KEY),
        listFolded: readFlag(LIST_KEY),
        bar: null,
        barParent: null,
        menu: null,
        button: null,
        buttonParent: null,
        header: null,
        listTarget: null,
      };
      let observer = null;
      let scheduled = false;

      // ---- panel menu fold ------------------------------------------------

      function menuLabel() {
        return state.menuFolded ? labels.unfoldMenu : labels.foldMenu;
      }

      function syncBarLabel() {
        if (state.bar === null) return;
        const text = menuLabel();
        state.bar.setAttribute('aria-pressed', state.menuFolded ? 'true' : 'false');
        state.bar.setAttribute('aria-label', text);
        state.bar.setAttribute('title', text);
        const label = state.bar.querySelector('.dsh-sidebar-fold__barLabel');
        if (label !== null) label.textContent = text;
      }

      function applyMenuFold() {
        if (state.menu === null) return;
        if (state.menuFolded) state.menu.classList.add(HIDDEN_CLASS);
        else state.menu.classList.remove(HIDDEN_CLASS);
      }

      /** Where the bar belongs: above the menu, outside the shell's grid scroll port. */
      function barAnchor() {
        const menu = findMenu();
        if (menu === null || menu.parentElement === null) return null;
        const container = menu.parentElement;
        // In the newer shell the menu is wrapped in a grid scroll port whose rows
        // are reserved for the shell's own children; an extra child there is
        // auto-placed into a leftover row. One level up is the sidebar column.
        const outer = container.hasAttribute('data-sidebar-scrollport') ? container.parentElement : null;
        if (outer !== null && outer !== container) return { parent: outer, before: container, menu };
        return { parent: container, before: menu, menu };
      }

      function syncBar() {
        const anchor = barAnchor();
        if (anchor === null) return;
        const menu = anchor.menu;
        if (state.bar === null) {
          const bar = document.createElement('button');
          bar.type = 'button';
          bar.className = 'dsh-sidebar-fold__bar';
          // Inline geometry: a percentage width collapsed to 0 inside the shell's
          // grid, so the bar stretches instead of measuring its parent.
          Object.assign(bar.style, {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '5px',
            height: '18px',
            width: 'auto',
            minWidth: '0',
            margin: '2px 8px',
            alignSelf: 'stretch',
            justifySelf: 'stretch',
            padding: '0',
            border: '0',
            borderRadius: '6px',
            background: 'transparent',
            opacity: '0.55',
          });
          bar.innerHTML = `${CHEVRON_SMALL}<span class="dsh-sidebar-fold__barLabel"></span>`;
          bar.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            state.menuFolded = !state.menuFolded;
            writeFlag(MENU_KEY, state.menuFolded);
            syncBarLabel();
            applyMenuFold();
          });
          state.bar = bar;
        }
        if (state.menu !== menu) {
          state.menu = menu;
          borrowColor(menu.querySelector('button'), state.bar, '--dsh-fold-bar-color');
        }
        const parent = anchor.parent;
        // A module reload leaves the previous generation's node behind.
        for (const stale of Array.from(document.querySelectorAll('.dsh-sidebar-fold__bar'))) {
          if (stale !== state.bar) stale.remove();
        }
        if (state.bar.parentElement !== parent || state.bar.nextElementSibling !== anchor.before) {
          parent.insertBefore(state.bar, anchor.before);
          state.barParent = parent;
        }
        state.bar.style.gridColumn = window.getComputedStyle(parent).display === 'grid' ? '1 / -1' : '';
        syncBarLabel();
        applyMenuFold();
      }

      // ---- session list fold ---------------------------------------------

      function syncLabel() {
        if (state.button === null) return;
        const text = state.listFolded ? labels.unfold : labels.fold;
        state.button.setAttribute('aria-pressed', state.listFolded ? 'true' : 'false');
        state.button.setAttribute('aria-label', text);
        state.button.setAttribute('title', text);
      }

      function applyListFold() {
        if (state.listTarget === null) return;
        if (state.listFolded) state.listTarget.classList.add(HIDDEN_CLASS);
        else state.listTarget.classList.remove(HIDDEN_CLASS);
      }

      function syncButton(headerRow) {
        if (state.button === null) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'dsh-sidebar-fold__button';
          button.innerHTML = CHEVRON;
          button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            state.listFolded = !state.listFolded;
            writeFlag(LIST_KEY, state.listFolded);
            syncLabel();
            applyListFold();
          });
          state.button = button;
        }
        if (state.header !== headerRow) {
          state.header = headerRow;
          state.listTarget = findListTarget(headerRow);
        } else if (state.listTarget === null || state.listTarget.isConnected === false) {
          state.listTarget = findListTarget(headerRow);
        }
        if (state.buttonParent !== headerRow) {
          if (state.buttonParent !== null && state.button.parentElement === state.buttonParent) {
            state.buttonParent.removeChild(state.button);
          }
          for (const stale of Array.from(headerRow.querySelectorAll('.dsh-sidebar-fold__button'))) {
            if (stale !== state.button) stale.remove();
          }
          headerRow.appendChild(state.button);
          state.buttonParent = headerRow;
        }
        if (state.button.style.getPropertyValue('--dsh-fold-icon-color') === '') {
          borrowColor(
            Array.from(headerRow.querySelectorAll('button')).filter((el) => el !== state.button).pop() ?? null,
            state.button,
            '--dsh-fold-icon-color',
          );
        }
        syncLabel();
        applyListFold();
      }

      // ---- lifecycle ------------------------------------------------------

      function ensure() {
        scheduled = false;
        syncBar();
        const headerRow = findWorkspaceHeader();
        if (headerRow !== null) syncButton(headerRow);
      }

      function schedule() {
        if (scheduled) return;
        scheduled = true;
        window.setTimeout(() => {
          scheduled = false;
          ensure();
        }, 120);
      }

      ensure();

      observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true });
      window.addEventListener('resize', schedule);

      return () => {
        observer.disconnect();
        window.removeEventListener('resize', schedule);
        if (state.bar !== null && state.bar.parentElement !== null) state.bar.remove();
        if (state.button !== null && state.button.parentElement !== null) state.button.remove();
        if (state.menu !== null) state.menu.classList.remove(HIDDEN_CLASS);
        if (state.listTarget !== null) state.listTarget.classList.remove(HIDDEN_CLASS);
      };
    }

    function SidebarFold() {
      // The sidebar is rendered by other plugins, so this half can mount before
      // the DOM it anchors into exists. Wait for the anchor instead of attaching
      // once and silently giving up.
      React.useEffect(() => {
        let stopped = false;
        let cleanup = null;
        let tries = 0;
        const boot = () => {
          if (stopped) return;
          const anchor = document.querySelector('[data-sidebar-scrollport]');
          const header = document.querySelector('[data-slot="sidebar.workspaces.directoryFlow"]');
          if (anchor !== null || header !== null || tries >= 60) {
            try {
              cleanup = attach(LABELS[readFoldLanguage()] ?? LABELS.zh);
            } catch (error) {
              console.warn('dsh-desk-stickers: fold attach failed', error);
            }
            return;
          }
          tries += 1;
          window.setTimeout(boot, 250);
        };
        boot();
        return () => {
          stopped = true;
          if (typeof cleanup === 'function') {
            try { cleanup(); } catch { /* already torn down */ }
          }
        };
      }, []);
      return h('style', null, SIDEBAR_FOLD_CSS);
    }

    // ---------------------------------------------- sticker: window pin
    //
    // Mounted imperatively: the shell.overlay occupant never materialised for
    // this package, while直接插入 DOM 的做法每次都成功。Clicks are taken from a
    // document-level hit test as well, because the title strip is a window-drag
    // region and a plain button there can lose its events.

    function requestPinAction(action) {
      return fetch(PIN_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
        cache: 'no-store',
      }).then((response) => {
        if (!response.ok) throw new Error('pin-top: HTTP ' + response.status);
        return response.json();
      });
    }

    function installDeskPin(getSettings) {
      const STYLE_ID = 'dsh-desk-stickers-pin-style';
      if (document.getElementById(STYLE_ID) === null) {
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
.dsh-desk-pin { position: fixed; top: 4px; right: 150px; height: 32px; display: flex; align-items: center;
  z-index: 2147483000; pointer-events: auto; -webkit-app-region: no-drag; }
.dsh-desk-pin__button { position: relative; display: flex; align-items: center; justify-content: center;
  width: 30px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: transparent;
  -webkit-app-region: no-drag; pointer-events: auto; cursor: default;
  transition: background-color 120ms ease, color 120ms ease, transform 90ms ease; }
.dsh-desk-pin__button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.dsh-desk-pin__button:active { transform: scale(0.88); }
.dsh-desk-pin__button[data-pinned="true"] {
  box-shadow: inset 0 0 0 0.5px currentColor;
}
@keyframes dsh-desk-pin-pop { 0% { transform: scale(0.82); } 55% { transform: scale(1.14); } 100% { transform: scale(1); } }
.dsh-desk-pin__button[data-pulse="true"] { animation: dsh-desk-pin-pop 320ms ease; }
.dsh-desk-pin[data-hidden="true"] { display: none !important; }
`;
        document.head.appendChild(style);
      }

      const host = document.createElement('div');
      host.className = 'dsh-desk-pin';
      host.setAttribute('data-hidden', 'true');

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dsh-desk-pin__button';
      button.setAttribute('data-pinned', 'false');
      button.setAttribute('aria-label', '窗口置顶');
      button.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.2 3.2h9.6"/><path d="M8 13.2V6.4"/><path d="M4.9 9.3 8 6.2l3.1 3.1"/></svg>';
      host.appendChild(button);
      document.body.appendChild(host);

      let pinned = false;
      let pending = false;
      let pulseTimer = 0;

      let lastPaint = '';
      function paint() {
        const settings = getSettings();
        const block = settings && settings.pinTop;
        const custom = singleColor(settings, 'pinTop');
        const tint = custom === '' ? (rgbToHex(sampleMenuTextColor()) || rgbToHex(sampleTitlebarInk())) : custom;
        // Identical writes every tick were re-triggering style recalc; only
        // touch the DOM when the picture actually changes.
        const signature = tint + '|' + String(pinned) + '|' + String(block && block.enabled === false);
        if (signature !== lastPaint) {
          lastPaint = signature;
          if (/^#[0-9a-f]{6}$/i.test(tint)) button.style.color = tint;
          else button.style.removeProperty('color');
        }
        button.setAttribute('data-pinned', pinned ? 'true' : 'false');
        button.title = pinned ? '取消置顶' : '窗口置顶';
        button.setAttribute('aria-label', button.title);
        host.setAttribute('data-hidden', block && block.enabled === false ? 'true' : 'false');
      }

      function run(action) {
        if (pending) return;
        pending = true;
        host.setAttribute('data-pending', 'true');
        requestPinAction(action)
          .then((result) => {
            if (result && result.ok === true) {
              pinned = result.topmost === true;
              button.setAttribute('data-pulse', 'true');
              window.clearTimeout(pulseTimer);
              pulseTimer = window.setTimeout(() => button.setAttribute('data-pulse', 'false'), 340);
            }
          })
          .catch(() => undefined)
          .then(() => {
            return requestPinAction('status').then((result) => {
              if (result && result.ok === true) pinned = result.topmost === true;
            }).catch(() => undefined);
          })
          .then(() => {
            pending = false;
            host.removeAttribute('data-pending');
            paint();
          });
      }

      function hitTest(event) {
        if (host.getAttribute('data-hidden') === 'true') return;
        const box = button.getBoundingClientRect();
        const inside = event.clientX >= box.left && event.clientX <= box.right
          && event.clientY >= box.top && event.clientY <= box.bottom;
        if (inside) run(pinned ? 'off' : 'on');
      }

      const onButton = (event) => {
        event.preventDefault();
        event.stopPropagation();
        run(pinned ? 'off' : 'on');
      };

      button.addEventListener('pointerdown', onButton);
      // The drag region can swallow the click entirely; this catches it anyway.
      const onDocumentPointerUp = (event) => {
        const target = event.target;
        if (target === button || button.contains(target)) return;
        hitTest(event);
      };
      document.addEventListener('pointerup', onDocumentPointerUp, true);

      // Re-attach only when the node was actually removed. It must NOT touch
      // data-hidden: doing that every tick fought the settings paint and made
      // the pin flicker once the sticker was switched off.
      const mountTimer = window.setInterval(() => {
        if (button.isConnected) return;
        document.body.appendChild(host);
        paint();
      }, 800);

      const paintTimer = window.setInterval(paint, 1200);
      requestPinAction('status').then((result) => {
        if (result && result.ok === true) pinned = result.topmost === true;
        paint();
      }).catch(() => paint());

      return () => {
        window.clearInterval(mountTimer);
        window.clearInterval(paintTimer);
        window.clearTimeout(pulseTimer);
        button.removeEventListener('pointerdown', onButton);
        document.removeEventListener('pointerup', onDocumentPointerUp, true);
        if (host.parentElement !== null) host.parentElement.removeChild(host);
        const style = document.getElementById(STYLE_ID);
        if (style !== null && style.parentElement !== null) style.parentElement.removeChild(style);
      };
    }

    // ------------------------------------------------- sticker settings
    //
    // One fetch, many readers. The settings page writes, the header button
    // reads (to hide itself when the note sticker is switched off), and later
    // features read their own block from the same object.

    const FALLBACK_SETTINGS = {
      restart: { enabled: true },
      plugins: { enabled: true },
      pinTop: { enabled: true, color: { mode: 'auto', value: '' } },
      sidebarFold: { enabled: true, color: { mode: 'auto', off: '#9aa0a6', on: '#4b8bf5' } },
      stickyNote: { enabled: true },
    };

    const settingsStore = (function createSettingsStore() {
      let value = null;
      let pending = null;
      const listeners = new Set();

      function emit() {
        for (const listener of listeners) {
          try {
            listener(value);
          } catch {
            /* one bad subscriber must not break the others */
          }
        }
      }

      function load() {
        if (pending !== null) return pending;
        pending = fetch(ROUTES.settings, { cache: 'no-store' })
          .then((response) => response.json())
          .then((body) => {
            value = body && body.ok === true && body.settings ? body.settings : FALLBACK_SETTINGS;
            emit();
            return value;
          })
          .catch(() => {
            value = value === null ? FALLBACK_SETTINGS : value;
            emit();
            return value;
          })
          .then((result) => {
            pending = null;
            return result;
          });
        return pending;
      }

      function save(patch) {
        return fetch(ROUTES.settings, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ settings: patch }),
        })
          .then((response) => response.json())
          .then((body) => {
            if (body && body.ok === true && body.settings) {
              value = body.settings;
              emit();
            }
            return value;
          })
          .catch(() => value);
      }

      function subscribe(listener) {
        listeners.add(listener);
        if (value === null) void load();
        else listener(value);
        return () => listeners.delete(listener);
      }

      return { get: () => value, load, save, subscribe };
    })();

    function useStickerSettings() {
      const [state, setState] = React.useState(settingsStore.get());
      React.useEffect(() => settingsStore.subscribe(setState), []);
      return state;
    }

    const FEATURE_ROWS = [
      {
        key: 'stickyNote',
        title: '便利贴',
        desc: '对话右上角的便签按钮：便签浮在所有窗口之上，能拖能拉，每个会话各自一张。',
        ready: true,
      },
      {
        key: 'pinTop',
        title: '窗口置顶',
        desc: '标题栏右上角的置顶图标，方框即置顶状态。颜色默认跟随侧栏菜单文字，可手动覆盖。',
        ready: true,
        color: true,
      },
      {
        key: 'sidebarFold',
        title: '侧栏折叠',
        desc: '左侧栏的两处折叠条。默认各自跟随它所在位置的颜色（上方菜单 / 下方「工作区」），换皮肤会自动重取。',
        ready: true,
        color: true,
        colorLabels: { off: '上方菜单', on: '下方工作区' },
      },
    ];

    function Switch(props) {
      const on = props.on === true;
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on,
        'aria-label': props.label,
        disabled: props.disabled === true,
        onClick: props.onClick,
        style: {
          flex: '0 0 auto',
          width: '46px',
          height: '26px',
          padding: '0',
          borderRadius: '13px',
          border: '1px solid ' + (on ? 'var(--dsh-color-accent, #4b8bf5)' : 'rgba(128,128,140,.45)'),
          background: on ? 'var(--dsh-color-accent, #4b8bf5)' : 'rgba(128,128,140,.28)',
          cursor: props.disabled === true ? 'not-allowed' : 'pointer',
          opacity: props.disabled === true ? 0.55 : 1,
          position: 'relative',
          transition: 'background .15s ease, border-color .15s ease',
        },
      }, h('span', {
        style: {
          position: 'absolute',
          top: '2px',
          left: on ? '22px' : '2px',
          width: '20px',
          height: '20px',
          borderRadius: '50%',
          background: '#fff',
          transition: 'left .15s ease',
          boxShadow: '0 1px 2px rgba(0,0,0,.25)',
        },
      }));
    }

    /**
 * Colour control for one sticker: two state rows, always editable, plus one
 * plain 「跟随皮肤」 button.
 *
 *   click 跟随皮肤   → both states follow the skin, rows show the resolved hex
 *   touch any row    → that row becomes an explicit colour (mode custom)
 */
    /** One colour: swatch and hex field. */
    function SingleColorControl(props) {
      const settings = useStickerSettings();
      const block = (settings && settings[props.featureKey]) || FALLBACK_SETTINGS[props.featureKey] || {};
      const color = Object.assign({ mode: 'auto', value: '' }, block.color || {});
      const custom = color.mode === 'custom';
      const [note, setNote] = React.useState('');
      useTick();
      const sampled = rgbToHex(sampleMenuTextColor()) || rgbToHex(sampleTitlebarInk());
      const shown = custom && /^#[0-9a-f]{6}$/i.test(String(color.value || '')) ? color.value : sampled || '#e6e8ea';

      function save(next) {
        void settingsStore.save({ [props.featureKey]: { color: Object.assign({}, color, next) } });
      }

      function commit(raw) {
        const text = String(raw || '').trim();
        const withHash = text.startsWith('#') ? text : '#' + text;
        if (!/^#[0-9a-f]{6}$/i.test(withHash)) {
          setNote('要 6 位十六进制，例如 #e6e8ea');
          return;
        }
        setNote('');
        // Tabbing through the field must not turn follow-skin into custom.
        if (withHash.toLowerCase() === String(shown).toLowerCase()) return;
        save({ mode: 'custom', value: withHash.toLowerCase() });
      }

      return h('div', { style: { marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            onClick: () => save({ mode: 'auto', value: '' }),
            style: {
              padding: '5px 12px',
              fontSize: '12px',
              borderRadius: '999px',
              border: '1px solid ' + (custom ? 'rgba(128,128,140,.45)' : 'var(--dsw-alias-brand-primary)'),
              background: custom ? 'transparent' : 'rgba(75,139,245,.16)',
              color: 'inherit',
              cursor: 'pointer',
            },
          }, '跟随皮肤'),
          h('span', { style: { fontSize: '11.5px', opacity: 0.6 } },
            custom ? '点一下让它跟随当前皮肤的文字色' : '已跟随：下面是当前皮肤解析出的色号'),
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: { width: '52px', fontSize: '12px', opacity: 0.85 } }, '颜色'),
          h('input', {
            type: 'color',
            value: shown,
            onChange: (event) => {
              const picked = String(event.target.value || '').toLowerCase();
              if (picked === String(shown).toLowerCase()) return;
              save({ mode: 'custom', value: picked });
            },
            style: { width: '30px', height: '24px', padding: 0, border: 'none', background: 'none', cursor: 'pointer' },
          }),
          h('input', {
            type: 'text',
            key: shown,
            defaultValue: shown,
            spellCheck: false,
            onBlur: (event) => commit(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') commit(event.currentTarget.value); },
            style: {
              width: '104px', padding: '4px 7px', fontSize: '12px', fontFamily: 'monospace',
              borderRadius: '6px', border: '1px solid rgba(128,128,140,.4)', background: 'transparent', color: 'inherit',
            },
          }),
        ),
        note === '' ? null : h('div', { style: { fontSize: '11.5px', color: 'var(--dsw-alias-state-warn-primary)' } }, note),
      );
    }

    function ColorControl(props) {
  const settings = useStickerSettings();
  const block = (settings && settings[props.featureKey]) || FALLBACK_SETTINGS[props.featureKey] || {};
  const color = Object.assign({ mode: 'auto', off: '#9aa0a6', on: '#4b8bf5' }, block.color || {});
  const following = color.mode === 'auto';
  const skin = useSkinPair();
  useTick();
  const live = props.featureKey === 'sidebarFold' ? sampleFoldPair() : { off: skin.off, on: skin.on };
  const [note, setNote] = React.useState('');

  const effective = (state) => {
    if (following) return state === 'on' ? live.on || skin.on : live.off || skin.off;
    const stored = String(color[state] || '');
    if (/^#[0-9a-f]{6}$/i.test(stored)) return stored;
    return state === 'on' ? '#4b8bf5' : '#9aa0a6';
  };

  function save(next) {
    void settingsStore.save({ [props.featureKey]: { color: Object.assign({}, color, next) } });
  }

  /** Setting a colour by hand always leaves follow-skin mode. */
  function setState(state, value) {
    // Opening the swatch and confirming it, or tabbing through the hex field,
    // used to lock the row into custom mode even when nothing was changed. A
    // value equal to what is already showing means "still following".
    const wanted = String(value || '').toLowerCase();
    if (following && wanted === String(effective(state)).toLowerCase()) return;
    const next = { mode: 'custom' };
    next[state] = value;
    if (!following) {
      const other = state === 'on' ? 'off' : 'on';
      next[other] = effective(other);
    } else {
      next[state === 'on' ? 'off' : 'on'] = effective(state === 'on' ? 'off' : 'on');
    }
    save(next);
  }

  function commitHex(state, raw) {
    const text = String(raw || '').trim();
    const withHash = text.startsWith('#') ? text : '#' + text;
    if (!/^#[0-9a-f]{6}$/i.test(withHash)) {
      setNote('要 6 位十六进制，例如 #4b8bf5');
      return;
    }
    setNote('');
    setState(state, withHash.toLowerCase());
  }

  const labels = props.labels || { off: '关闭时', on: '开启时' };

  function stateRow(state, label) {
    const shown = effective(state);
    return h('div', {
      key: state,
      style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
    },
      h('span', { style: { width: '52px', fontSize: '12px', opacity: 0.85 } }, label),
      h('input', {
        type: 'color',
        value: shown,
        onChange: (event) => setState(state, event.target.value),
        style: { width: '30px', height: '24px', padding: 0, border: 'none', background: 'none', cursor: 'pointer' },
      }),
      h('input', {
        type: 'text',
        key: state + ':' + shown,
        defaultValue: shown,
        spellCheck: false,
        onBlur: (event) => commitHex(state, event.target.value),
        onKeyDown: (event) => { if (event.key === 'Enter') commitHex(state, event.currentTarget.value); },
        style: {
          width: '104px', padding: '4px 7px', fontSize: '12px', fontFamily: 'monospace',
          borderRadius: '6px', border: '1px solid rgba(128,128,140,.4)',
          background: 'transparent', color: 'inherit',
        },
      }),
    );
  }

  return h('div', { style: { marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' } },
    h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
      h('button', {
        type: 'button',
        onClick: () => save({ mode: 'auto' }),
        style: {
          padding: '5px 12px',
          fontSize: '12px',
          borderRadius: '999px',
          border: '1px solid ' + (following ? 'var(--dsw-alias-brand-primary)' : 'rgba(128,128,140,.45)'),
          background: following ? 'rgba(75,139,245,.16)' : 'transparent',
          color: 'inherit',
          cursor: 'pointer',
        },
      }, '跟随皮肤'),
      h('span', { style: { fontSize: '11.5px', opacity: 0.6 } },
        following ? '已跟随：下面显示的是当前皮肤解析出的色号，改任一行就会变成自定义' : '点一下让它跟随当前皮肤'),
    ),
    stateRow('off', labels.off),
    stateRow('on', labels.on),
    note === '' ? null : h('div', { style: { fontSize: '11.5px', color: 'var(--dsw-alias-state-warn-primary)' } }, note),
  );
}

    // ------------------------------------------------- installed plugins
    //
    // The page that used to live in dsh-installed-plugins. Its Host routes are
    // vendored into this package under /plugins/dsh-desk-stickers/plugins, so
    // this block only has to render and call them. Updates run one at a time:
    // two harness installs at once fight over the profile manifest.
    const PLUGIN_ROUTE = '/plugins/dsh-desk-stickers/plugins';
    const RESTART_ROUTE = '/plugins/dsh-desk-stickers/restart';

    function visit(url, init) {
      return fetch(url, Object.assign({ cache: 'no-store' }, init)).then((response) => response.json());
    }

    function PluginsSection() {
      const [list, setList] = React.useState(null);
      const [verdicts, setVerdicts] = React.useState({});
      const [busy, setBusy] = React.useState('');
      const [note, setNote] = React.useState('');
      const [updated, setUpdated] = React.useState(false);
      const [asking, setAsking] = React.useState(false);

      const plugins = (list && list.plugins) || [];
      const updatable = plugins.filter((plugin) => {
        const verdict = verdicts[plugin.name];
        return verdict && verdict.status === 'update';
      });

      function load() {
        void visit(PLUGIN_ROUTE + '/list').then((body) => {
          if (body && body.ok === false) setNote(String(body.error || '读不到插件清单'));
          setList(body);
        }).catch((error) => setNote('读不到插件清单：' + String(error && error.message ? error.message : error)));
      }

      React.useEffect(() => { load(); }, []);

      function checkOne(plugin) {
        return visit(PLUGIN_ROUTE + '/check?name=' + encodeURIComponent(plugin.name))
          .then((verdict) => {
            setVerdicts((current) => Object.assign({}, current, { [plugin.name]: verdict }));
            return verdict;
          })
          .catch(() => undefined);
      }

      function checkAll() {
        if (busy !== '') return;
        setBusy('check');
        setNote('');
        let index = 0;
        const step = () => {
          if (index >= plugins.length) {
            setBusy('');
            return;
          }
          const plugin = plugins[index++];
          checkOne(plugin).then(step);
        };
        step();
      }

      function updateOne(name) {
        return visit(PLUGIN_ROUTE + '/update?name=' + encodeURIComponent(name))
          .then((result) => result)
          .catch((error) => ({ ok: false, message: String(error && error.message ? error.message : error) }));
      }

      function updateAll() {
        if (busy !== '' || updatable.length === 0) return;
        setBusy('update');
        setNote('');
        setUpdated(false);
        const queue = updatable.map((plugin) => plugin.name);
        const failures = [];
        const step = () => {
          if (queue.length === 0) {
            setBusy('');
            setUpdated(failures.length === 0);
            setNote(failures.length === 0 ? '' : '这些没更新成功：' + failures.join('、'));
            load();
            return;
          }
          const name = queue.shift();
          updateOne(name).then((result) => {
            if (!result || result.ok !== true) failures.push(name);
            step();
          });
        };
        step();
      }

      function restart() {
        setAsking(false);
        setNote('正在重启…（这条会话会中断）');
        void visit(RESTART_ROUTE + '/restart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .catch(() => undefined);
      }

      const rows = plugins.map((plugin) => {
        const verdict = verdicts[plugin.name];
        const state = verdict === undefined ? '' : verdict.status === 'update' ? '可更新 v' + verdict.latest : verdict.status === 'current' ? '已是最新' : (verdict.message || '检查失败');
        return h('div', {
          key: plugin.name,
          style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 0', borderTop: '1px solid rgba(128,128,140,.14)' },
        },
          h('span', { style: { flex: '1 1 auto', minWidth: 0, fontSize: '12.5px', overflow: 'hidden', textOverflow: 'ellipsis' } }, plugin.name),
          h('span', { style: { flex: '0 0 auto', fontSize: '11.5px', opacity: 0.65 } }, plugin.version || ''),
          h('span', { style: { flex: '0 0 96px', fontSize: '11.5px', textAlign: 'right', color: verdict && verdict.status === 'update' ? 'var(--dsw-alias-brand-primary)' : 'inherit', opacity: verdict && verdict.status === 'update' ? 1 : 0.65 } }, state),
          h('button', {
            type: 'button',
            disabled: busy !== '',
            onClick: () => {
              setBusy('one:' + plugin.name);
              updateOne(plugin.name).then((result) => {
                setBusy('');
                setUpdated(result && result.ok === true);
                load();
              });
            },
            style: { flex: '0 0 auto', padding: '3px 9px', fontSize: '11.5px', borderRadius: '6px', border: '1px solid rgba(128,128,140,.4)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
          }, '更新'),
        );
      });

      return h('div', { style: { marginTop: '22px', paddingTop: '16px', borderTop: '1px solid rgba(128,128,140,.25)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
          h('div', { style: { fontSize: '14px', fontWeight: 600 } }, '已安装插件'),
          h('span', { style: { flex: '1 1 auto' } }),
          h('button', {
            type: 'button', disabled: busy !== '', onClick: checkAll,
            style: { padding: '4px 11px', fontSize: '12px', borderRadius: '999px', border: '1px solid rgba(128,128,140,.45)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
          }, busy === 'check' ? '检查中…' : '检查全部'),
          h('button', {
            type: 'button', disabled: busy !== '' || updatable.length === 0, onClick: updateAll,
            style: { padding: '4px 11px', fontSize: '12px', borderRadius: '999px', border: '1px solid rgba(128,128,140,.45)', background: 'transparent', color: 'inherit', cursor: updatable.length === 0 ? 'not-allowed' : 'pointer', opacity: updatable.length === 0 ? 0.5 : 1 },
          }, busy === 'update' ? '更新中…' : '全部更新'),
        ),
        updated
          ? h('div', { style: { marginTop: '10px', fontSize: '12.5px', fontWeight: 600, color: 'var(--dsw-alias-brand-primary)' } }, '更新已完成！建议重启！')
          : null,
        h('div', { style: { marginTop: '10px' } },
          asking
            ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '10px 12px', borderRadius: '9px', border: '1px solid rgba(128,128,140,.4)' } },
              h('span', { style: { fontSize: '12.5px' } },
                '会中断当前会话，请确保插件已',
                h('b', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, '更新完成'),
                '。',
              ),
              h('span', { style: { flex: '1 1 auto' } }),
              h('button', { type: 'button', onClick: restart, style: { padding: '4px 12px', fontSize: '12px', borderRadius: '6px', border: '1px solid rgba(128,128,140,.5)', background: 'transparent', color: 'inherit', cursor: 'pointer' } }, '确认重启'),
              h('button', { type: 'button', onClick: () => setAsking(false), style: { padding: '4px 12px', fontSize: '12px', borderRadius: '6px', border: '1px solid transparent', background: 'transparent', color: 'inherit', cursor: 'pointer', opacity: 0.7 } }, '取消'),
            )
            : h('button', {
              type: 'button', onClick: () => setAsking(true),
              style: { padding: '4px 12px', fontSize: '12px', borderRadius: '999px', border: '1px solid rgba(128,128,140,.45)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
            }, '重启 DSH'),
        ),
        note === '' ? null : h('div', { style: { marginTop: '8px', fontSize: '11.5px', color: 'var(--dsw-alias-state-warn-primary)' } }, note),
        h('div', { style: { marginTop: '10px' } }, rows),
      );
    }

const SLOT = 'settings.section'

/** Section key; a fresh id adds a page beside the shipped ones. */
const SECTION_ID = 'dsh-installed-plugins'

/** Host routes this page drives. */
const ROUTE = '/plugins/dsh-desk-stickers/plugins'

/** How long a first click stays armed as a confirmation, in milliseconds. */
const ARM_MS = 5000

/** React, delivered by the shell's module table in `apply`. */
/** Chinese copy for the three install sources the page can meet. */
const SOURCE_LABEL = {
  github: { text: 'GitHub', className: 'dip-chip-github' },
  npm: { text: 'npm', className: 'dip-chip-npm' },
  link: { text: '本地链接', className: 'dip-chip-local' },
  local: { text: '本地包', className: 'dip-chip-local' },
  unknown: { text: '未知来源', className: 'dip-chip-local' },
}

/** Style sheet, injected with the page. Every colour is a theme token. */
const PLUGINS_CSS = [
  '.dip-page{display:flex;flex-direction:column;gap:16px;max-width:860px;padding:24px 4px 40px}',
  '.dip-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap}',
  '.dip-eyebrow{font-size:11px;line-height:1;font-weight:600;letter-spacing:.14em;color:var(--dsw-alias-label-secondary);text-transform:uppercase}',
  '.dip-title{margin:10px 0 0;font-size:20px;line-height:1.35;font-weight:600;letter-spacing:.01em;color:var(--dsw-alias-label-primary)}',
  '.dip-sub{margin:8px 0 0;font-size:12px;line-height:1.8;color:var(--dsw-alias-label-secondary)}',
  '.dip-btn{appearance:none;font:inherit;font-size:12.5px;font-weight:600;line-height:1;padding:9px 14px;border-radius:8px;cursor:pointer;transition:background-color .15s ease,opacity .15s ease}',
  '.dip-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
  '.dip-btn[disabled]{opacity:.45;cursor:not-allowed}',
  '.dip-btn-primary{background:var(--dsw-alias-brand-primary);border:1px solid transparent;color:#fff}',
  '.dip-btn-primary:not([disabled]):hover{opacity:.88}',
  '.dip-btn-ghost{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
  '.dip-btn-ghost:not([disabled]):hover{background:var(--dsw-alias-bg-layer-2)}',
  '.dip-table{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
  '.dip-row{display:grid;grid-template-columns:56px minmax(0,1fr) 200px 132px;gap:14px;align-items:center;padding:12px 18px}',
  '.dip-head-row{background:var(--dsw-alias-bg-layer-2);padding-top:9px;padding-bottom:9px}',
  '.dip-head-row .dip-th{font-size:11px;font-weight:600;letter-spacing:.08em;color:var(--dsw-alias-label-secondary)}',
  '.dip-row + .dip-row{border-top:1px solid var(--dsw-alias-border-l1)}',
  '.dip-row:not(.dip-head-row):hover{background:var(--dsw-alias-bg-layer-2)}',
  '.dip-icon{position:relative;width:40px;height:40px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);display:flex;align-items:center;justify-content:center;overflow:hidden}',
  '.dip-icon img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:var(--dsw-alias-bg-layer-2)}',
  '.dip-icon span{font-size:15px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
  '.dip-name{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
  '.dip-name b{font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}',
  '.dip-desc{margin:4px 0 0;font-size:11.5px;line-height:1.7;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
  '.dip-desc-wrap{position:relative}',
  // The row keeps two lines so the list stays scannable; the full text arrives
  // in a floating card under the pointer (position:fixed, so no row reflows and
  // no ancestor overflow can clip it).
  '.dip-tip{position:fixed;z-index:70;padding:9px 11px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 10px 28px rgba(0,0,0,.3);font-size:12px;line-height:1.7;color:var(--dsw-alias-label-primary);pointer-events:none;white-space:pre-wrap;overflow-wrap:anywhere;max-height:60vh;overflow-y:auto}',
  '.dip-chip{font-size:10.5px;font-weight:600;line-height:1;padding:3px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap}',
  '.dip-chip-github{color:var(--dsw-alias-label-primary)}',
  '.dip-chip-npm{color:var(--dsw-alias-label-secondary)}',
  '.dip-chip-local{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
  '.dip-chip-off{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
  '.dip-version{display:flex;flex-direction:column;gap:4px}',
  '.dip-vnum{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;color:var(--dsw-alias-label-primary)}',
  '.dip-arrow{color:var(--dsw-alias-label-secondary);padding:0 4px}',
  '.dip-new{color:var(--dsw-alias-state-success-primary)}',
  '.dip-note{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
  '.dip-ok{color:var(--dsw-alias-state-success-primary)}',
  '.dip-bad{color:var(--dsw-alias-state-error-primary)}',
  '.dip-warn{color:var(--dsw-alias-state-warn-primary)}',
  '.dip-empty{padding:26px 18px;font-size:12.5px;line-height:1.9;color:var(--dsw-alias-label-secondary)}',
  '.dip-btn-update{background:var(--dsw-alias-brand-primary);border:1px solid transparent;color:#fff}',
  '.dip-btn-update:not([disabled]):hover{opacity:.88}',
  '.dip-btn-armed{background:var(--dsw-alias-state-warn-primary);border:1px solid transparent;color:#1a1a1a}',
  '.dip-upd{margin:8px 0 0;font-size:11.5px;line-height:1.75;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}',
  '.dip-upd-ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
  '.dip-upd-bad{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
  '.dip-actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;align-items:center}',
  '.dip-banner{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;padding:12px 16px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}',
  '.dip-banner b{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}',
  '.dip-banner span{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
  '.dip-banner-ok{border-color:var(--dsw-alias-state-success-primary)}',
  '.dip-banner-ok b{color:var(--dsw-alias-state-success-primary)}',
  '.dip-banner-warn{border-color:var(--dsw-alias-state-warn-primary)}',
  '.dip-banner-warn b{color:var(--dsw-alias-state-warn-primary)}',
  '.dip-banner-bad{border-color:var(--dsw-alias-state-error-primary)}',
  '.dip-banner-bad b{color:var(--dsw-alias-state-error-primary)}',
].join('\n')

/** Read one service from an injected owner without tripping over a miss. */
function serviceAt(owner, key) {
  try {
    if (owner !== null && owner !== undefined && typeof owner.get === 'function') {
      const value = owner.get(key)
      if (value !== undefined && value !== null) return value
    }
  } catch (error) {
    // A miss is the expected answer.
  }
  return undefined
}

/** The first character of a name, for the icon fallback. */
function initial(name) {
  const clean = String(name).replace(/^@[^/]+\//, '')
  return clean.length === 0 ? '?' : clean.slice(0, 1).toUpperCase()
}

/** One plugin's row. */
/**
 * A plugin description: two clamped lines in the row, and the whole text in a
 * floating card once the pointer rests on it.
 *
 * The card is `position:fixed`, so neither the table's layout nor a scroll
 * container can clip it, and the row itself never reflows while the pointer is
 * moving across the list.
 */
function PluginDesc(props) {
  const text = String(props.text === undefined || props.text === null ? '' : props.text);
  const [at, setAt] = React.useState(null);

  function place(event) {
    setAt({ x: event.clientX, y: event.clientY });
  }

  function clear() {
    setAt(null);
  }

  let style;
  if (at === null) {
    style = null;
  } else {
    const width = Math.max(240, Math.min(430, window.innerWidth - 24));
    const left = Math.max(12, Math.min(at.x, window.innerWidth - width - 12));
    const below = at.y + 18;
    const top = below + 200 > window.innerHeight ? Math.max(12, at.y - 210) : below;
    style = { left: left + 'px', top: top + 'px', width: width + 'px' };
  }

  return React.createElement(
    'div',
    { className: 'dip-desc-wrap', onMouseEnter: place, onMouseMove: place, onMouseLeave: clear },
    React.createElement('p', { className: 'dip-desc' }, text),
    style === null ? null : React.createElement('div', { className: 'dip-tip', style }, text),
  );
}

function PluginRow(props) {
  const plugin = props.plugin
  const state = props.state ?? { phase: 'idle' }
  const verdict = state.verdict ?? null
  const source = SOURCE_LABEL[plugin.source?.kind] ?? SOURCE_LABEL.unknown
  const checkable = plugin.source?.kind === 'github' || plugin.source?.kind === 'npm'
  // The check that just found a newer version is what turns the row's one button
  // from "look" into "act"; the button is never both at once.
  const canUpdate = verdict !== null && verdict.status === 'update'

  const versionCells = []
  const installed = plugin.version ?? '未知'
  if (verdict !== null && verdict.status === 'update') {
    versionCells.push(
      React.createElement('div', { className: 'dip-vnum', key: 'v' },
        installed,
        React.createElement('span', { className: 'dip-arrow' }, '→'),
        React.createElement('span', { className: 'dip-new' }, verdict.latest ?? '?')))
  } else {
    versionCells.push(React.createElement('div', { className: 'dip-vnum', key: 'v' }, installed))
  }
  if (state.phase === 'checking') {
    versionCells.push(React.createElement('div', { className: 'dip-note', key: 'n' }, '正在检查…'))
  } else if (verdict !== null) {
    const tone = verdict.status === 'update' ? 'dip-ok' : verdict.status === 'current' ? 'dip-note' : 'dip-bad'
    versionCells.push(React.createElement('div', { className: `dip-note ${tone}`, key: 'n' }, verdict.message ?? ''))
  } else if (!checkable) {
    versionCells.push(React.createElement('div', { className: 'dip-note', key: 'n' }, '本地来源，无远程版本'))
  } else if (plugin.installed === false) {
    versionCells.push(React.createElement('div', { className: 'dip-note dip-bad', key: 'n' }, '目录缺失，未安装成功'))
  }

  return React.createElement('div', { className: 'dip-row' },
    React.createElement('div', { className: 'dip-icon' },
      React.createElement('span', null, initial(plugin.name)),
      plugin.icon === null
        ? null
        : React.createElement('img', {
          src: `${ROUTE}/icon?name=${encodeURIComponent(plugin.name)}`,
          alt: '',
          onError: event => { event.target.style.display = 'none' },
        })),
    React.createElement('div', null,
      React.createElement('div', { className: 'dip-name' },
        React.createElement('b', null, plugin.name),
        React.createElement('span', { className: `dip-chip ${source.className}` }, source.text),
        plugin.mounted === false
          ? React.createElement('span', { className: 'dip-chip dip-chip-off' }, '未挂载')
          : null),
      plugin.description === ''
        ? null
        : React.createElement(PluginDesc, { text: plugin.description }),
      // The update outcome lives under the name rather than in its own column:
      // it can be several lines (a CLI failure tail), and this is the only cell
      // wide enough to read it without the table jumping.
      props.result === null || props.result === undefined
        ? null
        : React.createElement('p', {
          className: `dip-upd ${props.result.ok === true ? 'dip-upd-ok' : 'dip-upd-bad'}`,
        }, String(props.result.message ?? ''))),
    React.createElement('div', { className: 'dip-version' }, versionCells),
    React.createElement('div', null,
      React.createElement('button', {
        type: 'button',
        title: canUpdate ? `装到 ${String(verdict.latest)}` : '检查有没有新版本',
        className: canUpdate
          ? (props.armed === true ? 'dip-btn dip-btn-armed' : 'dip-btn dip-btn-update')
          : 'dip-btn dip-btn-ghost',
        disabled: !checkable || props.busy === true || (state.phase === 'checking' && canUpdate !== true),
        onClick: () => { canUpdate ? props.onUpdate(plugin.name) : props.onCheck(plugin.name) },
      }, props.busy === true
        ? '更新中…'
        : canUpdate
          ? (props.armed === true ? '确认更新' : '更新')
          : (state.phase === 'checking' ? '检查中…' : '检查更新'))))
}

/**
 * The settings page.
 */
function InstalledPluginsSection() {
  const [inventory, setInventory] = React.useState(null)
  const [error, setError] = React.useState('')
  const [states, setStates] = React.useState({})
  const [busyAll, setBusyAll] = React.useState(false)
  // Only one row can be awaiting confirmation, and only one install may run: the
  // Host refuses a second anyway, and the page should not offer one.
  const [armed, setArmed] = React.useState(null)
  const [busy, setBusy] = React.useState(null)
  /** The banner above the table: what the last bulk action found or did. */
  const [report, setReport] = React.useState(null)
  /** Names the last bulk check found updatable; drives the one-click button. */
  const [updatable, setUpdatable] = React.useState([])
  /** `{ phase: 'armed' | 'running', index, total }` for the one-click update. */
  const [batch, setBatch] = React.useState(null)
  // True once this visit has installed something, so the restart button can say
  // 「更新已完成！建议重启！」 — the batch state itself is cleared on completion.
  const [justUpdated, setJustUpdated] = React.useState(false)

  async function reload() {
    const response = await fetch(`${ROUTE}/list`, { headers: { accept: 'application/json' } })
    const value = await response.json()
    if (value.ok === false) setError(String(value.error ?? '读取失败'))
    setInventory(value)
  }

  React.useEffect(function () {
    let live = true
    if (typeof fetch !== 'function') return undefined
    fetch(`${ROUTE}/list`, { headers: { accept: 'application/json' } })
      .then(response => response.json())
      .then((value) => {
        if (!live) return
        if (value.ok === false) setError(String(value.error ?? '读取失败'))
        setInventory(value)
      })
      .catch((failure) => { if (live) setError(String(failure)) })
    return function () { live = false }
  }, [])

  // The confirmation expires on its own, so an armed button cannot sit there
  // waiting to be finished off by a stray second click minutes later.
  React.useEffect(function () {
    if (armed === null) return undefined
    const timer = setTimeout(function () { setArmed(null) }, ARM_MS)
    return function () { clearTimeout(timer) }
  }, [armed])

  React.useEffect(function () {
    if (batch === null || batch.phase !== 'armed') return undefined
    const timer = setTimeout(function () { setBatch(null) }, ARM_MS)
    return function () { clearTimeout(timer) }
  }, [batch])

  // Merge, never replace: re-checking a row must not wipe the update result the
  // reader is still looking at.
  function setOne(name, patch) {
    setStates(previous => ({ ...previous, [name]: { ...(previous[name] ?? {}), ...patch } }))
  }

  /**
   * Check one plugin and hand the verdict back.
   *
   * The return value is what makes the bulk check able to count: reading the
   * `states` map right after `setOne` would read the closure from before the
   * update and count nothing.
   */
  async function checkOne(name) {
    setOne(name, { phase: 'checking' })
    let verdict
    try {
      const response = await fetch(`${ROUTE}/check?name=${encodeURIComponent(name)}`, { headers: { accept: 'application/json' } })
      verdict = await response.json()
    } catch (failure) {
      verdict = { status: 'error', message: String(failure) }
    }
    setOne(name, { phase: 'done', verdict })
    return verdict
  }

  /**
   * The row button's second job.
   *
   * First click arms, second click installs - the same guard the restart page
   * uses, for the same reason: this rewrites the profile's dependency list, and a
   * mis-click in a table full of rows is easy.
   */
  async function updateOne(name) {
    if (armed !== name) {
      setArmed(name)
      return
    }
    setArmed(null)
    setBusy(name)
    try {
      const response = await fetch(`${ROUTE}/update?name=${encodeURIComponent(name)}`, { headers: { accept: 'application/json' } })
      const result = await response.json()
      // The verdict is dropped either way: after a success the row is current,
      // and after a failure the reader must see the error instead of a stale
      // "update available" invitation.
      setOne(name, { phase: 'idle', verdict: null, result })
      await reload()
    } catch (failure) {
      setOne(name, { phase: 'idle', verdict: null, result: { ok: false, message: String(failure) } })
    } finally {
      setBusy(null)
    }
  }

  /**
   * Check everything, and say how many can be updated.
   *
   * The count is the point: a table of fifteen rows where two are pink is easy to
   * read past, and the answer to "do I need to do anything?" should be one line.
   */
  /** Run `worker` over `items` with at most `limit` in flight. */
  async function runPool(items, limit, worker) {
    const results = new Array(items.length)
    let cursor = 0
    const lanes = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      while (cursor < items.length) {
        const index = cursor
        cursor += 1
        results[index] = await worker(items[index], index)
      }
    })
    await Promise.all(lanes)
    return results
  }

  async function checkAll() {
    setBusyAll(true)
    setBatch(null)
    const checkable = (inventory?.plugins ?? []).filter(
      plugin => plugin.source?.kind === 'github' || plugin.source?.kind === 'npm')
    const found = []
    let done = 0
    setReport({ tone: 'info', headline: `正在检查 0/${checkable.length}`, detail: '一次性全部检查' })
    // Every plugin at once: checking is read-only, and the user asked for one
    // shot rather than a queue. A rate-limited answer simply reports itself.
    await runPool(checkable, Math.max(1, checkable.length), async (plugin) => {
      const verdict = await checkOne(plugin.name)
      if (verdict !== null && verdict !== undefined && verdict.status === 'update') found.push(plugin.name)
      done += 1
      setReport({
        tone: 'info',
        headline: `正在检查 ${done}/${checkable.length}`,
        detail: `已发现 ${found.length} 个可更新`,
      })
      return verdict
    })
    setUpdatable(found)
    if (found.length === 0) {
      setReport({ tone: 'ok', headline: '都是最新版', detail: `共检查 ${checkable.length} 个插件，没有发现可更新的。` })
    } else {
      setReport({
        tone: 'warn',
        headline: `${found.length} 个可以更新`,
        detail: `共检查 ${checkable.length} 个插件：${found.join('、')}`,
      })
    }
    setBusyAll(false)
  }

  /**
   * Update every plugin the last bulk check found.
   *
   * One at a time and through the same single-plugin route, so each install keeps
   * its own bundle-list audit and repair. A batch is exactly the shape that
   * damaged a mount on this machine once, so this button also confirms first and
   * names the targets; it deliberately does NOT fan out in parallel.
   */
  async function updateAll() {
    const targets = updatable.slice()
    if (targets.length === 0) return
    if (batch === null || batch.phase !== 'armed') {
      setBatch({ phase: 'armed' })
      return
    }
    setBatch({ phase: 'running', index: 0, total: targets.length })
    let finished = 0
    // Strictly one install at a time. Every install rewrites the same profile
    // manifest, so two of them at once can drop each other's entries — that is
    // exactly how a plugin went missing on this machine before.
    const results = []
    for (const name of targets) {
      setReport({ tone: 'info', headline: `正在更新 ${finished}/${targets.length}`, detail: name })
      setBatch({ phase: 'running', index: finished, total: targets.length })
      setBusy(name)
      let result
      try {
        const response = await fetch(`${ROUTE}/update?name=${encodeURIComponent(name)}`, { headers: { accept: 'application/json' } })
        result = await response.json()
      } catch (failure) {
        result = { ok: false, message: String(failure) }
      }
      finished += 1
      setBatch({ phase: 'running', index: finished, total: targets.length })
      setOne(name, { phase: 'idle', verdict: null, result })
      setBusy(null)
      results.push({ name, ok: result !== null && result !== undefined && result.ok === true, message: String(result?.message ?? '') })
    }
    await reload()
    setUpdatable([])
    setBatch(null)
    if (results.some(entry => entry.ok)) setJustUpdated(true)
    const succeeded = results.filter(entry => entry.ok).map(entry => entry.name)
    const failed = results.filter(entry => !entry.ok)
    if (failed.length === 0) {
      setReport({
        tone: 'ok',
        headline: `已更新 ${succeeded.length} 个`,
        detail: `${succeeded.join('、')} —— 重启 DSH 后新版本才真正生效。`,
      })
    } else {
      setReport({
        tone: 'bad',
        headline: `${succeeded.length} 个成功，${failed.length} 个失败`,
        detail: failed.map(entry => `${entry.name}：${entry.message}`).join('；'),
      })
    }
  }

  const plugins = inventory?.plugins ?? []
  const summary = inventory?.summary ?? null
  const checkableCount = plugins.filter(
    plugin => plugin.source?.kind === 'github' || plugin.source?.kind === 'npm').length

  const header = React.createElement('div', { className: 'dip-row dip-head-row' },
    React.createElement('div', { className: 'dip-th' }, '图标'),
    React.createElement('div', { className: 'dip-th' }, '插件名称'),
    React.createElement('div', { className: 'dip-th' }, '版本号'),
    React.createElement('div', { className: 'dip-th' }, '检查更新'))

  const body = plugins.length === 0
    ? React.createElement('div', { className: 'dip-empty' },
      inventory === null && error === '' ? '正在读取已安装插件…' : (error === '' ? '这个 profile 里没有第三方插件。' : error))
    : plugins.map(plugin => React.createElement(PluginRow, {
      key: plugin.name,
      plugin,
      state: states[plugin.name],
      armed: armed === plugin.name,
      busy: busy === plugin.name,
      result: states[plugin.name]?.result ?? null,
      onCheck: checkOne,
      onUpdate: updateOne,
    }))

  const batchRunning = batch !== null && batch.phase === 'running'
  const batchArmed = batch !== null && batch.phase === 'armed'
  const anyBusy = busyAll || busy !== null || batchRunning

  return React.createElement('div', { className: 'dip-page' },
    React.createElement('style', null, PLUGINS_CSS),
    React.createElement('div', { className: 'dip-head' },
      React.createElement('div', null,
        React.createElement('div', { className: 'dip-eyebrow' }, '插件管理'),
        React.createElement('h2', { className: 'dip-title' }, '已安装插件'),
        React.createElement('p', { className: 'dip-sub' },
          summary === null
            ? '读取中…'
            : `共 ${String(summary.total)} 个 · GitHub ${String(summary.github)} 个 · npm ${String(summary.npm)} 个 · `
              + `本地 ${String(summary.other)} 个 · 来源目录 ${inventory.profileDir ?? '未找到'}`),
        React.createElement('p', { className: 'dip-sub' },
          '更新是排队执行的：一次只装一个，装完一个再下一个。',
          React.createElement('b', null, '更新期间请不要离开此页面'),
          '，更新完成后请重启 DSH，新版本才会生效。')),
      React.createElement('div', { className: 'dip-actions' },
        React.createElement('button', {
          type: 'button',
          className: 'dip-btn dip-btn-ghost',
          disabled: anyBusy || checkableCount === 0,
          onClick: checkAll,
        }, busyAll ? '正在检查…' : `一键检查更新（${String(checkableCount)}）`),
        React.createElement('button', {
          type: 'button',
          title: updatable.length === 0 ? '先点「一键检查更新」' : `将依次更新：${updatable.join('、')}`,
          className: batchArmed ? 'dip-btn dip-btn-armed' : 'dip-btn dip-btn-primary',
          disabled: updatable.length === 0 || anyBusy,
          onClick: updateAll,
        }, batchArmed
          ? `确认更新 ${String(updatable.length)} 个`
          : batchRunning
            ? `更新中 ${String((batch.index ?? 0) + 1)}/${String(batch.total)}`
            : `一键更新（${String(updatable.length)}）`),
        React.createElement(RestartButton, { updated: justUpdated }))),
    report === null
      ? null
      : React.createElement('div', { className: `dip-banner dip-banner-${report.tone}` },
        React.createElement('b', null, report.headline),
        report.detail === '' ? null : React.createElement('span', null, report.detail)),
    React.createElement('div', { className: 'dip-table' }, header, body),
    React.createElement('p', { className: 'dip-sub' },
      '「更新」走的是 DSH 自己的命令行安装（npm 的按 ^新版本 装，GitHub 的重新钉新提交），'
      + '装完会自动核对挂载列表、把被弄丢的挂载补回来。'
      + '「一键更新」是逐个执行、不是并发，每个包都单独做一次这道核对；点两下确认后才开始。'))
}

/**
 * Mount the browser half.
 * @param ctx - client context; `slots` arrives through the dynamic inject form.
 */
    /** Restart control shown on top of the installed-plugins page. */
    function RestartBar() {
      const [asking, setAsking] = React.useState(false);
      const [note, setNote] = React.useState('');

      function go() {
        setAsking(false);
        setNote('正在重启…（这条会话会中断）');
        void fetch('/plugins/dsh-desk-stickers/restart/restart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => undefined);
      }

      return React.createElement('div', { style: { marginBottom: '14px', paddingBottom: '12px', borderBottom: '1px solid rgba(128,128,140,.2)' } },
        asking
          ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
            React.createElement('span', { style: { fontSize: '12.5px' } },
              '会中断当前会话，请确保插件已',
              React.createElement('b', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, '更新完成'),
              '。',
            ),
            React.createElement('span', { style: { flex: '1 1 auto' } }),
            React.createElement('button', { type: 'button', onClick: go, style: { padding: '4px 12px', fontSize: '12px', borderRadius: '6px', border: '1px solid rgba(128,128,140,.5)', background: 'transparent', color: 'inherit', cursor: 'pointer' } }, '确认重启'),
            React.createElement('button', { type: 'button', onClick: () => setAsking(false), style: { padding: '4px 12px', fontSize: '12px', borderRadius: '6px', border: '1px solid transparent', background: 'transparent', color: 'inherit', cursor: 'pointer', opacity: 0.7 } }, '取消'),
          )
          : React.createElement('button', { type: 'button', onClick: () => setAsking(true), style: { padding: '4px 12px', fontSize: '12px', borderRadius: '999px', border: '1px solid rgba(128,128,140,.45)', background: 'transparent', color: 'inherit', cursor: 'pointer' } }, '重启 DSH'),
        note === '' ? null : React.createElement('div', { style: { marginTop: '8px', fontSize: '11.5px', opacity: 0.75 } }, note),
      );
    }

    /** Restart control that sits in the page's own button row, with a modal confirm. */
    function RestartButton(props) {
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const showHint = props.updated === true;

      function go() {
        setBusy(true);
        void fetch('/plugins/dsh-desk-stickers/restart/restart', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }).catch(() => setBusy(false));
      }

      const button = React.createElement('button', {
        type: 'button',
        className: 'dip-btn dip-btn-ghost',
        style: { marginLeft: 'auto' },
        title: '重启 DSH（会中断当前会话）',
        onClick: () => setOpen(true),
      }, '重启 DSH');

      const dialog = open
        ? React.createElement('div', {
          style: {
            position: 'fixed', inset: 0, zIndex: 2147483001, background: 'rgba(0,0,0,.45)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px',
          },
          onClick: (event) => { if (event.target === event.currentTarget && !busy) setOpen(false); },
        },
          React.createElement('style', null,
            '@keyframes dsh-restart-pop{0%{transform:scale(.86);opacity:0}'
            + '55%{transform:scale(1.04);opacity:1}'
            + '100%{transform:scale(1);opacity:1}}'
            + '.dsh-restart-card{animation:dsh-restart-pop 260ms cubic-bezier(.2,.9,.3,1.2)}'),
          React.createElement('div', {
            className: 'dsh-restart-card',
            style: {
              width: 'min(420px, 100%)', padding: '18px 20px', borderRadius: '12px',
              background: 'var(--dsw-alias-bg-layer-1, #1b1e27)',
              border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,140,.4))',
              boxShadow: '0 18px 48px rgba(0,0,0,.45)',
            },
          },
            React.createElement('div', { style: { fontSize: '14px', fontWeight: 600, marginBottom: '10px' } }, '重启 DSH'),
            React.createElement('div', { style: { fontSize: '12.5px', lineHeight: 1.8 } },
              '会中断当前会话，请确保插件已',
              React.createElement('b', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, '更新完成'),
              '。',
            ),
            React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '16px' } },
              React.createElement('button', {
                type: 'button',
                disabled: busy,
                onClick: () => setOpen(false),
                style: { padding: '5px 14px', fontSize: '12px', borderRadius: '6px', border: '1px solid rgba(128,128,140,.45)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
              }, '取消'),
              React.createElement('button', {
                type: 'button',
                disabled: busy,
                onClick: go,
                style: { padding: '5px 14px', fontSize: '12px', borderRadius: '6px', border: '1px solid var(--dsw-alias-state-error-primary)', background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', cursor: 'pointer' },
              }, busy ? '正在重启…' : '确认重启'),
            ),
          ),
        )
        : null;

      return React.createElement(React.Fragment, null,
        showHint
          ? React.createElement('span', {
            style: { alignSelf: 'center', fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-brand-primary)' },
          }, '更新已完成！建议重启！')
          : null,
        button,
        dialog,
      );
    }

    /** The installed-plugins page: the vendored page with the restart control on top. */
    /** A crash in the vendored page must show a message, not a blank panel. */
    class PluginPageBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      render() {
        if (this.state.error !== null) {
          const message = String((this.state.error && this.state.error.message) || this.state.error);
          return React.createElement('div', { style: { padding: '12px', fontSize: '12.5px', color: 'var(--dsw-alias-state-error-primary)' } },
            '插件页没能渲染：' + message);
        }
        return this.props.children;
      }
    }

    function PluginsPage() {
      return React.createElement(InstalledPluginsSection, null);
    }

    function SettingsSection() {
      const [tab, setTab] = React.useState('desk');
      const settings = useStickerSettings();
      const [busy, setBusy] = React.useState('');
      const [saved, setSaved] = React.useState('');

      const block = (key) => (settings && settings[key]) || FALLBACK_SETTINGS[key] || { enabled: true };

      function toggle(key) {
        const next = !(block(key).enabled !== false);
        setBusy(key);
        void settingsStore.save({ [key]: { enabled: next } }).then(() => {
          setBusy('');
          setSaved(key);
          window.setTimeout(() => setSaved(''), 1600);
        });
      }

      const rows = FEATURE_ROWS.map((row) => {
        const on = block(row.key).enabled !== false;
        return h('div', {
          key: row.key,
          style: {
            display: 'flex',
            alignItems: 'flex-start',
            gap: '14px',
            padding: '14px 0',
            borderTop: '1px solid rgba(128,128,140,.18)',
          },
        },
          h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
            h('div', { style: { fontWeight: 600, fontSize: '14px', marginBottom: '4px' } },
              row.title,
              row.ready === false
                ? h('span', { style: { marginLeft: '8px', fontSize: '12px', fontWeight: 400, opacity: 0.6 } }, '待迁入')
                : null,
              saved === row.key
                ? h('span', { style: { marginLeft: '8px', fontSize: '12px', color: '#2e9e5b' } }, '已保存')
                : null,
            ),
            h('div', { style: { fontSize: '12.5px', lineHeight: 1.6, opacity: 0.72 } }, row.desc),
            row.ready !== false && row.color === true
              ? (row.key === 'pinTop'
                ? h(SingleColorControl, { featureKey: row.key })
                : h(ColorControl, { featureKey: row.key, labels: row.colorLabels }))
              : null,
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', paddingTop: '2px' } },
            h(Switch, {
              on,
              label: row.title,
              disabled: row.ready === false || busy === row.key,
              onClick: () => toggle(row.key),
            }),
          ),
        );
      });

      const tabButton = (key, label) => h('button', {
        type: 'button',
        onClick: () => setTab(key),
        style: {
          padding: '5px 14px',
          fontSize: '12.5px',
          borderRadius: '999px',
          border: '1px solid ' + (tab === key ? 'var(--dsw-alias-brand-primary)' : 'rgba(128,128,140,.4)'),
          background: tab === key ? 'rgba(75,139,245,.14)' : 'transparent',
          color: 'inherit',
          cursor: 'pointer',
        },
      }, label);

      if (tab === 'plugins') {
        return h('div', { style: { padding: '4px 2px 24px', maxWidth: '860px' } },
          h('div', { style: { display: 'flex', gap: '8px', marginBottom: '14px' } },
            tabButton('desk', '桌面'),
            tabButton('plugins', '已安装插件'),
          ),
          h(PluginPageBoundary, null, h(PluginsPage, null)),
        );
      }

      return h('div', { style: { padding: '4px 2px 24px', maxWidth: '720px' } },
        h('div', { style: { display: 'flex', gap: '8px', marginBottom: '12px' } },
          tabButton('desk', '桌面'),
          tabButton('plugins', '已安装插件'),
        ),
        rows,
      );
    }

    // ------------------------------------------------------------------- app

    const FOLD_VENDORED_ENABLED = true;

    function apply(ctx) {
      const store = createStore();
      const copy = COPY[readLanguage(ctx)] ?? COPY.zh;
      activeCtx = ctx;

      ctx.effect(() => {
        const style = document.createElement('style');
        style.setAttribute('data-plugin', 'dsh-desk-stickers');
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      });

      /** Where a brand-new note window should appear on screen. */
      function defaultRect() {
        const width = 340;
        const height = 400;
        const left = Number.isFinite(window.screenX) ? window.screenX : 0;
        const top = Number.isFinite(window.screenY) ? window.screenY : 0;
        const outerW = window.outerWidth || window.innerWidth;
        return { x: left + outerW - width - 48, y: top + 120, w: width, h: height };
      }

      function Trigger(props) {
        // Read the sticker switches first: hooks must run in the same order on
        // every render, so the "hidden" decision is applied to the markup below
        // rather than by an early return.
        const stickerSettings = useStickerSettings();
        const snapshot = useSnapshot(store);
        const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
        const key = noteKey(sessionId);
        const note = snapshot.notes[key] ?? emptyNote();
        const [desk, setDesk] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [failed, setFailed] = React.useState(false);

        /** Write the window's record back into the conversation that owns it. */
        function mergeInto(targetKey, payload) {
          if (typeof targetKey !== 'string' || targetKey === '') return;
          const current = store.get();
          const target = current.notes[targetKey] ?? emptyNote();
          const next = { ...target };
          if (MODES.includes(payload.mode)) next.mode = payload.mode;
          const size = Math.round(Number(payload.fontSize));
          if (Number.isFinite(size)) next.fontSize = clamp(size, FONT_MIN, FONT_MAX);
          if (typeof payload.text === 'string') next.text = payload.text;
          if (payload.grid !== undefined) next.grid = normalizeGrid(payload.grid);
          if (payload.list !== undefined) next.list = normalizeList(payload.list);
          store.writeNote(targetKey, next);
        }

        // A page reload forgets the switch; the Host still knows whether a note
        // window is on screen, so the button starts in the right state.
        React.useEffect(() => {
          let alive = true;
          getJson(ROUTES.state)
            .then((payload) => {
              if (!alive || payload === null) return;
              if (payload.open !== true) return;
              if (typeof payload.sessionKey === 'string') mergeInto(payload.sessionKey, payload);
              setDesk({
                open: true,
                sessionKey: typeof payload.sessionKey === 'string' ? payload.sessionKey : null,
                rev: typeof payload.rev === 'number' ? payload.rev : 0,
              });
            })
            .catch(() => {
              /* an older Host half simply leaves the switch closed */
            });
          return () => {
            alive = false;
          };
        }, []);

        // While the window is on screen, keep this conversation's stored note in
        // step with whatever is typed there - including the X button's close.
        const deskOpen = desk !== null && desk.open === true;
        const deskSession = desk === null ? null : desk.sessionKey;
        const deskRev = desk === null ? -1 : desk.rev;

        React.useEffect(() => {
          if (!deskOpen) return undefined;
          let cancelled = false;
          const tick = () => {
            getJson(ROUTES.state)
              .then((payload) => {
                if (cancelled || payload === null) return;
                if (payload.open !== true) {
                  if (typeof payload.sessionKey === 'string') mergeInto(payload.sessionKey, payload);
                  setDesk({ open: false, sessionKey: null, rev: 0 });
                  return;
                }
                if (typeof payload.rev === 'number' && payload.rev !== deskRev) {
                  if (typeof payload.sessionKey === 'string') mergeInto(payload.sessionKey, payload);
                  setDesk({ open: true, sessionKey: payload.sessionKey ?? deskSession, rev: payload.rev });
                }
              })
              .catch(() => {
                /* the Host may be restarting; ask again next tick */
              });
          };
          const timer = window.setInterval(tick, POLL_MS);
          return () => {
            cancelled = true;
            window.clearInterval(timer);
          };
        }, [deskOpen, deskSession, deskRev]);

        /** Put the current conversation's note on the desktop. */
        async function putOnDesktop() {
          setBusy(true);
          setFailed(false);
          try {
            // Switching from another conversation's note: read its live content
            // first, so the text on screen is not thrown away.
            const live = await getJson(ROUTES.state).catch(() => null);
            if (live !== null && live.open === true && typeof live.sessionKey === 'string') {
              mergeInto(live.sessionKey, live);
            }
            const rect = live !== null ? normalizeRect(live.rect) : null;
            const answer = await postJson(ROUTES.popout, {
              sessionKey: key,
              note: { mode: note.mode, fontSize: note.fontSize, text: note.text, grid: note.grid, list: note.list },
              theme: readTheme(),
              rect: rect ?? defaultRect(),
            });
            if (answer !== null && answer.ok === true) {
              setDesk({ open: true, sessionKey: key, rev: typeof answer.rev === 'number' ? answer.rev : 0 });
            } else {
              setFailed(true);
            }
          } catch {
            setFailed(true);
          } finally {
            setBusy(false);
          }
        }

        /** Close the window and keep what was typed there. */
        async function takeBack() {
          setBusy(true);
          try {
            const answer = await postJson(ROUTES.retract, {});
            if (answer !== null && answer.state !== undefined && typeof answer.state.sessionKey === 'string') {
              mergeInto(answer.state.sessionKey, answer.state);
            }
            setDesk({ open: false, sessionKey: null, rev: 0 });
          } catch {
            setDesk({ open: false, sessionKey: null, rev: 0 });
          } finally {
            setBusy(false);
          }
        }

        const openHere = deskOpen && deskSession === key;
        const label = deskOpen
          ? openHere
            ? copy.close
            : copy.switchNote
          : copy.open;

        function onClick() {
          if (busy) return;
          if (openHere) {
            void takeBack();
            return;
          }
          void putOnDesktop();
        }

        return h(
          'button',
          {
            type: 'button',
            className: 'dsh-note-trigger',
            'data-active': deskOpen ? 'true' : 'false',
            'data-failed': failed ? 'true' : 'false',
            'data-hidden': stickerSettings !== null && stickerSettings.stickyNote && stickerSettings.stickyNote.enabled === false ? 'true' : 'false',
            'aria-pressed': deskOpen,
            'aria-busy': busy,
            'aria-label': label,
            title: failed ? copy.failed : `${label} · ${copy.perSession}`,
            disabled: busy,
            onClick,
          },
          h(NoteGlyph, null),
        );
      }

      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'desk-stickers-note', order: 5 }, Trigger),
      );

      // Sticker: sidebar fold (vendored component, two bars).
      // TEMP: the vendored fold broke the Workspace collapse, so the proven
      // @local/dsh-sidebar-fold package stays mounted until this is fixed.

      // Fold-bar colours follow the *place* each control sits in: the menu bar
      // takes the menu list's own text colour, the Workspace arrow takes the
      // 「工作区」 title's colour. Sampling the live DOM is what makes it survive a
      // skin switch — so the sample is re-read on a slow tick and whenever the
      // root element or the <head> changes, because a skin swap only rewrites
      // CSS variables and never tells us it happened.
      ctx.effect(() => {
        const readInk = (el) => {
          if (el === null) return '';
          const color = window.getComputedStyle(el).color;
          return color && color !== 'rgba(0, 0, 0, 0)' ? color : '';
        };
        const hex = (value) => (/^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : '');
        const menuSample = () => sampleMenuTextColor();
        const workspaceSample = () => {
          const flow = document.querySelector('[data-slot="sidebar.workspaces.directoryFlow"]');
          const header = flow !== null ? flow.parentElement : null;
          if (header === null) return '';
          const label = header.querySelector('[class*="sectionLabel"]') || header.querySelector('span');
          return readInk(label);
        };
        // One colour per place: the pressed state keeps the same ink, so both
        // custom properties carry the same value.
        const paint = (node, value) => {
          if (node === null) return;
          if (value === '') {
            node.style.removeProperty('--dsh-fold-color-off');
            node.style.removeProperty('--dsh-fold-color-on');
            return;
          }
          node.style.setProperty('--dsh-fold-color-off', value);
          node.style.setProperty('--dsh-fold-color-on', value);
        };
        let last = { bar: null, button: null, off: '', on: '', hidden: '' };
        const apply = () => {
          const settings = settingsStore.get();
          const fold = (settings && settings.sidebarFold) || {};
          const color = fold.color || {};
          const custom = color.mode === 'custom';
          const bar = document.querySelector('.dsh-sidebar-fold__bar');
          const button = document.querySelector('.dsh-sidebar-fold__button');
          const off = (custom && hex(color.off)) || menuSample();
          const on = (custom && hex(color.on)) || workspaceSample();
          const hidden = fold.enabled === false ? 'true' : 'false';
          if (bar === last.bar && button === last.button && off === last.off && on === last.on && hidden === last.hidden) return;
          last = { bar, button, off, on, hidden };
          paint(bar, off);
          paint(button, on);
          // Our own write re-triggers the root observer, so only touch it on change.
          if (document.documentElement.getAttribute('data-dsh-fold-off') !== hidden) {
            document.documentElement.setAttribute('data-dsh-fold-off', hidden);
          }
        };
        apply();
        // A skin swap rewrites :root attributes and swaps <style> nodes in head;
        // both are cheap to watch, and the tick covers skins that only restyle.
        const rootObserver = new MutationObserver(() => apply());
        rootObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-skin', 'data-color-mode', 'lang'],
        });
        const headObserver = new MutationObserver(() => apply());
        headObserver.observe(document.head, { childList: true });
        const unsubscribe = settingsStore.subscribe(() => apply());
        const timer = window.setInterval(apply, 1000);
        return () => {
          window.clearInterval(timer);
          unsubscribe();
          rootObserver.disconnect();
          headObserver.disconnect();
          document.documentElement.removeAttribute('data-dsh-fold-off');
        };
      });

      // Sticker: sidebar fold (its own occupant — this is the form that worked).
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'desk-stickers-sidebar-fold', order: 30 }, SidebarFold),
      );

      // Sticker: window pin (imperative mount — the slot never rendered here).
      ctx.effect(() => installDeskPin(() => settingsStore.get()));

      // One settings page for the whole package: 设置 → 桌面.
      try {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'dsh-desk-stickers', order: 96, label: '桌面' }, SettingsSection),
        );
      } catch (error) {
        console.warn('dsh-desk-stickers: settings section not registered', error);
      }
    }

    return { inject: ['slots'], apply };
  },
});
