# dsh-desk-stickers

A few handy "stickers" for the **DeepSeek Harness** desktop app. Each sticker has
its own switch under **Settings → Desktop** and can be turned off without
touching the others.

No AI features by design — these are small objects stuck around the edges of the
windows you already look at.

| Sticker | What it does |
|---|---|
| 📌 Pin on top | A pin in the title bar keeps the window above everything; click again to release. Jelly pop on click, a thin frame while pinned |
| 📑 Sidebar fold | Two fold bars: collapse the whole menu list, and collapse the sessions under 「工作区」 |
| 🗒️ Sticky note | A real always-on-top desktop note, one per conversation, draggable and resizable |
| 🧾 Installed plugins | Plugin list with check-all updates, updates that run strictly one at a time, and a restart button |
| 🔄 One-click restart | The restart button above, plus the `/restart` command and the `restart_dsh` tool |

## Colours follow the skin by default

The pin and both fold bars start with **no fixed colour**: each one samples the
text colour of the place it sits in, so switching a skin recolours them
immediately, with nothing to click.

- pin → the sidebar menu text colour
- upper fold bar → the menu text colour
- lower fold bar (the Workspace chevron) → the 「工作区」 title colour

You can still override it per sticker: each one has a row of swatch + hex, and a
「跟随皮肤」 (follow the skin) button that goes back to sampling.

## Install

```bash
# from GitHub (DSH pins the install to a commit)
dsh plugin add github:purakkon/dsh-desk-stickers

# later, to update
dsh plugin update dsh-desk-stickers
```

Restart DSH once after installing so the bundle gets mounted.

> An npm release works too: `dsh plugin add dsh-desk-stickers`.

## Where it keeps data

- settings — `~/.dsh/data/desk-stickers/settings.json`
- notes — `~/.dsh/data/sticky-note/` (flipping the switch only hides the button;
  notes you already wrote stay put)

## Platform

Windows gets the full set (the pin and the desktop note window both rely on
Windows APIs). On other platforms the remaining stickers work, and those two
hide themselves.

## Development

```bash
node test/settings.test.mjs   # 15 assertions, no dependencies (repo only — the
                              # published package ships without test/)
```

- `index.js` — host half: settings, pin, restart and plugin-inventory routes
- `client.js` — browser half: the five stickers' UI and colour sampling
- `lib/*.mjs` — implementations; `lib/*.ps1` — Windows system calls
- `cordis.patch.yml` — bundle layer mounting the single `desk-stickers` entry

中文说明见 [README.zh-CN.md](README.zh-CN.md)。

## License

MIT.
