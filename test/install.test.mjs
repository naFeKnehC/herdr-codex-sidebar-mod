import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));

test("installs a self-contained mod without developer-specific paths", async () => {
  const appHome = await mkdtemp(join(tmpdir(), "herdr-codex-install-"));
  const result = spawnSync(process.execPath, [join(repo, "scripts", "sync-herdr.mjs")], {
    env: { ...process.env, HERDR_APP_HOME: appHome },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const modDir = join(appHome, "mods", "herdr-codex-sidebar-mod");
  const required = [
    "main.js",
    "helper/codex-history.mjs",
    "helper/lib/codex-app-server.mjs",
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

  const main = await readFile(join(modDir, "main.js"), "utf8");
  assert.doesNotMatch(main, /\/Users\/[^/"\s]+/);
});
