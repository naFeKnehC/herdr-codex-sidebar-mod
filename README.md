# Herdr Codex Sidebar Mod

Herdr mod for browsing Codex projects and chats, resuming an existing thread,
and keeping history separate from Herdr's live Agents view.
Assigned threads resume from their project root, even if the thread was
originally created in another folder.

## Usage

- Single-click a chat: open its titled tab and print a read-only history preview
  without starting Codex.
- Double-click a chat: resume that exact Codex thread in the same tab.
- Pressing Ctrl+C after a resumed Codex session returns to the tab's shell;
  the tab stays open.
- Already running chats are focused instead of launched again.
- New-session tab names follow the inferred thread immediately. Herdr's live
  Agent title still comes from Codex's own terminal title update.

## Installation

Requirements: Node.js 20+, Codex CLI, and Herdr App.

```sh
git clone <repository-url>
cd herdr-codex-sidebar-mod
npm run sync:herdr
herdr-app check ~/.config/herdr-app/mods/herdr-codex-sidebar-mod
```

The source mod directory is self-contained: it contains its own helper and
command wrappers. `sync:herdr` copies that directory to
`~/.config/herdr-app/mods/herdr-codex-sidebar-mod`, so copying the directory directly is
also enough at runtime. The helper cache remains under
`~/.config/herdr-app/data/herdr-codex-sidebar-mod` and is not part of the mod.

If Herdr uses a custom home, set the same variable for installation:

```sh
HERDR_APP_HOME=/path/to/herdr-app npm run sync:herdr
```

The installed mod locates everything through Herdr's `appHome()` value; it does
not contain a developer-specific absolute path. The wrappers locate Node,
`codex`, and `hc` from the user's environment with fallbacks for common macOS
and Linux install locations. The mod expects a POSIX system and a working
`codex` command in the user's terminal environment.

## Development

```sh
npm test
npm run sync:herdr
```

`sync:herdr` does not copy cache files, Codex transcripts, or generated Herdr
declarations.

After changing source files, run `npm run sync:herdr` and reload the Herdr mod
(or restart Herdr) to pick up the new code.

## Layout

- `mods/herdr-codex-sidebar-mod/`: self-contained Herdr UI mod, helper, and wrappers.
- `scripts/`: installer.
- `test/`: unit tests for normalization and live-session matching.

## License

MIT. See `LICENSE`.
