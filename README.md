# Herdr Codex History

Herdr mod for browsing Codex projects and chats, resuming an existing thread,
and keeping history separate from Herdr's live Agents view.

## Development

Requirements: Node.js 20+, Codex CLI, and Herdr App.

```sh
npm test
npm run sync:herdr
```

`sync:herdr` installs the mod into `~/.config/herdr-app/mods/codex-history`
and the helper into `~/.config/herdr-app/data/codex-history`. It intentionally
does not copy cache files, Codex transcripts, or generated Herdr declarations.

After changing source files, run `npm run sync:herdr` and reload the Herdr mod
(or restart Herdr) to pick up the new code.

## Layout

- `mods/codex-history/`: Herdr UI mod.
- `scripts/`: Codex App Server history helper.
- `bin/`: portable wrappers for `node`, `codex`, and `hc`.
- `test/`: unit tests for normalization and live-session matching.

## License

MIT. See `LICENSE`.
