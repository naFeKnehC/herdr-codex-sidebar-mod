#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { readCodexHistory } from "./lib/codex-app-server.mjs";
import { cachePath, readCache, writeCacheAtomic } from "./lib/cache.mjs";
import { normalizeHistory } from "./lib/normalize.mjs";

const VERSION = 1;
const args = process.argv.slice(2);
const command = args[0] || "sync";
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const asJson = args.includes("--json") || !process.stdout.isTTY;
const codexHome = flag("--codex-home") || process.env.CODEX_HOME || join(homedir(), ".codex");
const cache = cachePath({ home: homedir(), appHome: process.env.HERDR_APP_HOME });
const now = () => Math.floor(Date.now() / 1000);
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
async function sync() {
  const previous = await readCache(cache);
  try {
    const { projects, threads, warnings = [] } = await readCodexHistory({ codexHome, codex: process.env.CODEX_BIN });
    const normalized = normalizeHistory(projects, threads, warnings);
    const value = { schemaVersion: VERSION, syncedAt: now(), codexHome, ...normalized };
    await writeCacheAtomic(cache, value);
    return value;
  } catch (error) {
    const warnings = [`Sync failed: ${error.message}`];
    if (previous) return { ...previous, warnings: [...(previous.warnings || []), ...warnings], stale: true };
    return { schemaVersion: VERSION, syncedAt: 0, codexHome, projects: [], unassigned: [], warnings };
  }
}

async function main() {
  let value;
  if (command === "sync") value = await sync();
  else if (command === "status") value = await readCache(cache) || { schemaVersion: VERSION, syncedAt: 0, codexHome, projects: [], unassigned: [], warnings: ["No successful sync yet"] };
  else if (command === "reconcile") value = await readCache(cache) || { schemaVersion: VERSION, syncedAt: 0, codexHome, projects: [], unassigned: [], warnings: [] };
  else if (command === "launch") value = { ok: false, error: "Launch is owned by the Herdr Mod so it can create a visible Pane." };
  else throw new Error(`Unknown command: ${command}`);
  if (asJson) output(value); else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
main().catch((error) => { output({ schemaVersion: VERSION, codexHome, projects: [], unassigned: [], warnings: [error.message] }); process.exitCode = 1; });
