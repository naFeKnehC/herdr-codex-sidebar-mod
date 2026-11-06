import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export const CACHE_SCHEMA_VERSION = 2;

export function cachePath({ home = homedir(), appHome = process.env.HERDR_APP_HOME, env = process.env } = {}) {
  const root = env.HERDR_APP_HOME || appHome || join(home || ".", ".config", "herdr-app");
  return env.AGENT_HISTORY_CACHE
    || env.HERDR_AGENT_HISTORY_CACHE
    || join(root, "data", "herdr-agent-history", "history.json");
}

export function emptyHistory({ syncedAt = 0, warning = null } = {}) {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    syncedAt,
    agents: {
      claude: { available: false, stale: false, warnings: [], sessions: [] },
      codex: { available: false, stale: false, warnings: [], sessions: [] },
    },
    directories: [],
    sessions: [],
    agentStatus: {},
    warnings: warning ? [warning] : [],
    staleAgents: [],
    binaries: {},
  };
}

function validCache(value) {
  return value
    && typeof value === "object"
    && value.schemaVersion === CACHE_SCHEMA_VERSION
    && value.agents
    && typeof value.agents === "object";
}

export async function readCache(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return validCache(value) ? value : null;
  } catch {
    return null;
  }
}

export async function writeCacheAtomic(path, value, { mode = 0o600 } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
    // rename 覆盖旧文件；再 chmod 一次，确保旧文件的宽松权限不会残留。
    await rename(temporary, path);
    try { await chmod(path, mode); } catch {}
  } catch (error) {
    try { await rm(temporary, { force: true }); } catch {}
    throw error;
  }
}
