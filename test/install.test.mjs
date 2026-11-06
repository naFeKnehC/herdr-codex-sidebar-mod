import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));

test("installs a self-contained Agent History mod without developer-specific paths", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "herdr-agent-install-"));
  const result = spawnSync(process.execPath, [join(repo, "scripts", "sync-herdr.mjs")], {
    env: { ...process.env, HERDR_APP_HOME: appHome },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const modDir = join(appHome, "mods", "herdr-codex-sidebar-mod");
  const required = [
    "mod.json",
    "main.js",
    "view-model.mjs",
    "live-state.mjs",
    "launch-target.mjs",
    "helper/agent-history.mjs",
    "helper/codex-history.mjs",
    "helper/lib/adapters/claude.mjs",
    "helper/lib/adapters/codex.mjs",
    "helper/lib/adapters/hermes.mjs",
    "helper/lib/cache.mjs",
    "helper/lib/normalize.mjs",
    "helper/lib/transcript.mjs",
    "bin/codex-history",
    "bin/codex",
    "bin/hc",
  ];
  for (const relative of required) {
    await stat(join(modDir, relative));
  }

  for (const name of ["codex-history", "codex", "hc"]) {
    const mode = (await stat(join(modDir, "bin", name))).mode;
    assert.notEqual(mode & 0o111, 0, `${name} must remain executable`);
  }

  const manifest = JSON.parse(await readFile(join(modDir, "mod.json"), "utf8"));
  assert.equal(manifest.title, "Agent History");
  assert.doesNotMatch(manifest.title, /codex desktop/i);

  for (const relative of ["main.js", "view-model.mjs", "helper/agent-history.mjs"]) {
    const source = await readFile(join(modDir, relative), "utf8");
    assert.doesNotMatch(source, /\/Users\/[^/"\s]+/, relative);
  }

  await assert.rejects(stat(join(appHome, "data", "herdr-codex-sidebar-mod", "threads.json")));
  await assert.rejects(stat(join(modDir, "gpui-kit.d.ts")));
  await assert.rejects(stat(join(modDir, "threads.json")));
});
