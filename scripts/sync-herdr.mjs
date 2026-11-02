#!/usr/bin/env node
import { cp, mkdir, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const repo = join(fileURLToPath(new URL("..", import.meta.url)));
const appHome = process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
const modSource = join(repo, "mods", "herdr-codex-sidebar-mod");
const modTarget = join(appHome, "mods", "herdr-codex-sidebar-mod");

await mkdir(join(appHome, "mods"), { recursive: true });
await mkdir(join(appHome, "data", "herdr-codex-sidebar-mod"), { recursive: true });

await rm(modTarget, { recursive: true, force: true });
await cp(modSource, modTarget, { recursive: true, filter: (source) => !source.endsWith("gpui-kit.d.ts") });

const now = new Date();
await utimes(join(modTarget, "main.js"), now, now);
console.log(`Synced Herdr mod to ${modTarget}`);
console.log(`The installed mod is self-contained: ${modTarget}`);
