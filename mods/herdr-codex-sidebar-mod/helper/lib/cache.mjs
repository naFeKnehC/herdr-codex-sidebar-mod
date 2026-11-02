import { mkdir, rename, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export function cachePath({ home = process.env.HOME, appHome = process.env.HERDR_APP_HOME } = {}) {
  const root = appHome || join(home || ".", ".config", "herdr-app");
  return process.env.CODEX_HISTORY_CACHE || join(root, "data", "herdr-codex-sidebar-mod", "threads.json");
}

export async function readCache(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value?.schemaVersion === 1 ? value : null;
  } catch { return null; }
}

export async function writeCacheAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
