import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
  NO_CWD_KEY,
  buildAgentView,
  dedupeSessions,
  disambiguateDisplayNames,
  displayNameForCwd,
  groupDirectories,
  normalizeCwdLiteral,
  normalizeSession,
} from "../../view-model.mjs";

export {
  NO_CWD_KEY,
  buildAgentView,
  dedupeSessions,
  disambiguateDisplayNames,
  displayNameForCwd,
  groupDirectories,
  normalizeCwdLiteral,
  normalizeSession,
};

const R_OK_X_OK = constants.R_OK | constants.X_OK;

function statusFromError(error) {
  if (error?.code === "EACCES" || error?.code === "EPERM") return "inaccessible";
  return "missing-directory";
}

// cwdKey：存在时 realpath，失败时保留规范化后的字面路径；不转小写。
export function inspectCwd(raw, {
  home = homedir(),
  realpath = realpathSync,
  stat = statSync,
  access = (path, mode = R_OK_X_OK) => accessSync(path, mode),
} = {}) {
  const literal = normalizeCwdLiteral(raw, { home: home || "/" });
  if (!literal.cwd || literal.kind !== "ok") {
    return {
      ...literal,
      resolvedCwd: null,
      exists: false,
      accessible: false,
      status: literal.kind === "relative" ? "relative" : "missing-cwd",
    };
  }

  let resolved = literal.cwd;
  let exists = false;
  let accessible = false;
  let status = null;
  try {
    resolved = String(realpath(literal.cwd)).normalize("NFC");
  } catch (error) {
    status = statusFromError(error);
  }

  if (!status) {
    try {
      const info = stat(resolved);
      exists = typeof info?.isDirectory === "function" ? info.isDirectory() : true;
      if (!exists) status = "missing-directory";
    } catch (error) {
      status = statusFromError(error);
      exists = false;
    }
  }

  if (!status && exists) {
    try {
      access(resolved, R_OK_X_OK);
      accessible = true;
      status = "ok";
    } catch {
      status = "inaccessible";
      accessible = false;
    }
  }

  return {
    key: exists ? resolved : literal.cwd,
    cwd: literal.cwd,
    literal: literal.cwd,
    resolvedCwd: resolved,
    kind: exists ? "ok" : "missing",
    relative: false,
    exists,
    accessible,
    status: status || (exists ? "ok" : "missing-directory"),
  };
}

// 把适配器产出的 raw Session 统一补上 cwdInfo。同一个同步批次内按字面路径
// 缓存 realpath/stat，避免 1000 条会话重复打文件系统。
export function normalizeSessions(rawSessions, {
  agent,
  home = homedir(),
  cwdCache = new Map(),
  inspect = inspectCwd,
  ...inspectOptions
} = {}) {
  const sessions = [];
  for (const raw of Array.isArray(rawSessions) ? rawSessions : []) {
    if (!raw || typeof raw !== "object") continue;
    let info = raw.cwdInfo?.key ? raw.cwdInfo : null;
    if (!info && raw.cwdKey) {
      info = {
        key: raw.cwdKey,
        cwd: raw.cwd ?? null,
        exists: raw.exists !== false,
        accessible: raw.accessible !== false,
        status: raw.cwdStatus || (raw.exists === false ? "missing-directory" : "ok"),
      };
    }
    if (!info) {
      const literalKey = normalizeCwdLiteral(raw.cwd, { home }).key;
      info = cwdCache.get(literalKey);
      if (!info) {
        info = inspect(raw.cwd, { home, ...inspectOptions });
        cwdCache.set(literalKey, info);
      }
    }
    const session = normalizeSession(raw, { agent, cwdInfo: info, home });
    if (session) sessions.push(session);
  }
  return dedupeSessions(sessions);
}

export function agentViewFor(agent, rawSessions, {
  available = true,
  reason = null,
  warnings = [],
  stale = false,
  home = homedir(),
  cwdCache = new Map(),
  inspect = inspectCwd,
  ...inspectOptions
} = {}) {
  const sessions = normalizeSessions(rawSessions, {
    agent,
    home,
    cwdCache,
    inspect,
    ...inspectOptions,
  });
  return buildAgentView(agent, sessions, { available, reason, warnings, stale, home });
}
