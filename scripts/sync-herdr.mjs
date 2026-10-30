#!/usr/bin/env node
import { cp, mkdir, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const repo = join(fileURLToPath(new URL("..", import.meta.url)));
const appHome = process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
const modSource = join(repo, "mods", "codex-history");
const modTarget = join(appHome, "mods", "codex-history");
const dataSource = join(repo, "scripts");
const dataTarget = join(appHome, "data", "codex-history");

await mkdir(join(appHome, "mods"), { recursive: true });
await mkdir(dataTarget, { recursive: true });
await mkdir(join(dataTarget, "bin"), { recursive: true });

await rm(modTarget, { recursive: true, force: true });
await cp(modSource, modTarget, { recursive: true, filter: (source) => !source.endsWith("gpui-kit.d.ts") });

for (const name of ["codex-history.mjs"]) await cp(join(dataSource, name), join(dataTarget, name));
await rm(join(dataTarget, "lib"), { recursive: true, force: true });
await cp(join(dataSource, "lib"), join(dataTarget, "lib"), { recursive: true });
for (const name of ["codex-history", "codex", "hc"]) {
  await cp(join(repo, "bin", name), join(dataTarget, "bin", name));
}

const now = new Date();
await utimes(join(modTarget, "main.js"), now, now);
console.log(`Synced Herdr mod to ${modTarget}`);
console.log(`Synced helper to ${dataTarget}`);
