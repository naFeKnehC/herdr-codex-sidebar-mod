# Herdr Agent History Sidebar Mod

English | [简体中文](README.zh-CN.md)

A Herdr mod for browsing, previewing and resuming Claude Code, Codex and
Hermes history by agent and by real working directory. The sidebar shows one
agent at a time, chosen from the switcher in the top-right corner. Within an
agent, sessions are grouped by their exact `cwd`; Codex projects/assignments,
Claude encoded directory names and Hermes projects.db are not used.

## Usage

- Agent switcher: Claude / Codex / Hermes, one at a time. There is no All view.
- Single-click a chat: open its titled tab and print a read-only history preview
  without starting any agent.
- Double-click a chat: resume that exact session in the correct cwd.
- Already running chats are focused instead of launched again.
- After the agent exits, the preview/placeholder tab can still be resumed.
- Sessions are grouped by exact cwd. When the cwd is missing or inaccessible,
  history remains previewable but resume is disabled with a visible reason;
  nothing silently falls back to home.

## Installation

Requirements: Node.js 20+, Herdr App, and at least one installed agent
(Claude Code / Codex / Hermes).

```sh
git clone git@github.com:naFeKnehC/herdr-codex-sidebar-mod.git
cd herdr-codex-sidebar-mod
npm run sync:herdr
herdr-app check ~/.config/herdr-app/mods/herdr-codex-sidebar-mod
```

The source mod directory is self-contained: it contains its own helper and
command wrappers. `sync:herdr` copies that directory to
`~/.config/herdr-app/mods/herdr-codex-sidebar-mod`, so copying the directory
directly is also enough at runtime. The helper cache remains under
`~/.config/herdr-app/data/herdr-agent-history/history.json` and is not part of
the mod.

If Herdr uses a custom home, set the same variable for installation:

```sh
HERDR_APP_HOME=/path/to/herdr-app npm run sync:herdr
```

The installed mod locates everything through Herdr's `appHome()` value; it does
not contain a developer-specific absolute path. The wrappers locate Node,
`codex`, and `hc` from the user's environment with fallbacks for common macOS
and Linux install locations. The mod expects a POSIX system and a working
`codex` command in the user's terminal environment.

## Documentation

The product and test documents are currently in Chinese:

- [Product specification](docs/PRODUCT.zh-CN.md): target behavior, interaction
  rules, state model, and known implementation gaps.
- [Test plan](docs/TEST.zh-CN.md): acceptance matrix, current automation
  coverage, and release gates.

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

- `mods/herdr-codex-sidebar-mod/`: self-contained Herdr UI mod, helper, and
  wrappers.
- `scripts/`: installer.
- `test/`: unit tests for normalization and live-session matching.

## License

MIT. See `LICENSE`.
