import {
  AGENT_NAMES,
  NO_CWD_KEY,
  normalizeCwdLiteral,
  unavailableReasonForCwd,
} from "./view-model.mjs";

const asArray = (value) => Array.isArray(value) ? value : [];

export function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, "'\\''")}'`;
}

function keyOf(value, home = "/") {
  return normalizeCwdLiteral(value, { home }).key;
}

function sortSpaceMatches(matches) {
  return [...matches].sort((left, right) => {
    const leftId = String(left?.space?.id ?? "");
    const rightId = String(right?.space?.id ?? "");
    if (leftId !== rightId) return leftId < rightId ? -1 : 1;
    return String(left?.space?.name ?? "").localeCompare(String(right?.space?.name ?? ""));
  });
}

// 只按精确 cwd 复用 space：folder 精确相等且该 folder 通过验证，
// 或 folder 为空但 space 内有 cwd 精确相等的 pane（且该 cwd 通过验证）。
// 不做父目录 / project root / 编码目录名匹配。多个候选按 space id 确定性排序。
export function findDirectorySpaceMatches(allSpaces, allPanes, _allTerminals = [], cwd, {
  folderExists = null,
} = {}) {
  const target = keyOf(cwd);
  if (!target || target === NO_CWD_KEY) return [];
  const exists = typeof folderExists === "function"
    ? (path) => Boolean(folderExists(path))
    : () => true;
  const spaces = asArray(allSpaces).filter((space) => space && space.machine == null);
  const matches = new Map();

  for (const space of spaces) {
    const folder = keyOf(space.folder);
    if (!folder || folder === NO_CWD_KEY || folder !== target) continue;
    if (!exists(space.folder)) continue;
    matches.set(String(space.id ?? space.name), { space, folder: space.folder });
  }

  const tabSpaces = new Map();
  for (const space of spaces) {
    for (const tab of asArray(space.tabs)) {
      if (tab?.id != null) tabSpaces.set(String(tab.id), space);
    }
  }
  for (const pane of asArray(allPanes)) {
    if (!pane?.tab) continue;
    const paneCwd = keyOf(pane.cwd);
    if (paneCwd !== target) continue;
    const space = tabSpaces.get(String(pane.tab));
    // space.folder 非空时以 folder 为准，只有空 folder 的 space 才用 pane cwd 判定。
    const spaceFolder = keyOf(space?.folder);
    if (!space || (spaceFolder && spaceFolder !== NO_CWD_KEY)) continue;
    if (!exists(pane.cwd)) continue;
    const id = String(space.id ?? space.name);
    if (!matches.has(id)) matches.set(id, { space, folder: pane.cwd });
  }

  return sortSpaceMatches([...matches.values()]);
}

export function findDirectorySpace(allSpaces, allPanes, allTerminals = [], cwd) {
  return findDirectorySpaceMatches(allSpaces, allPanes, allTerminals, cwd)[0]?.space ?? null;
}

// 旧名称保留，语义已改为精确 cwd；project/roots 不再参与匹配。
export function findProjectSpace(allSpaces, allPanes, _project, cwd, allTerminals = []) {
  return findDirectorySpace(allSpaces, allPanes, allTerminals, cwd);
}

// 计算本次恢复实际使用的目录。纯函数，UI 与命令层共用同一套判定。
export function resolveEffectiveCwd({
  session,
  fallback = null,
  override = null,
  strictResume = false,
} = {}) {
  if (override?.valid && override.cwd) {
    return { cwd: override.cwd, source: "override", mode: "override", needsUserInput: false, reason: null };
  }

  const info = session?.cwdInfo || {};
  const cwd = session?.cwd || info.cwd || null;
  const hasCwd = Boolean(cwd);
  // 兼容没有 cwdInfo 的调用方；Session 正常路径始终带 cwdInfo。
  const status = info.status ?? (hasCwd ? "ok" : "missing-cwd");
  const exists = info.exists ?? hasCwd;
  const accessible = info.accessible ?? hasCwd;
  const originalOk = hasCwd
    && session?.cwdKey !== NO_CWD_KEY
    && status === "ok"
    && exists !== false
    && accessible !== false;
  if (originalOk) {
    return { cwd, source: "original", mode: "original", needsUserInput: false, reason: null };
  }

  const reason = session?.unavailableReason
    || unavailableReasonForCwd(info)
    || "Working directory unavailable";

  if (strictResume) {
    return { cwd: null, source: "none", mode: "preview-only", needsUserInput: false, reason };
  }
  if (fallback?.valid && fallback.cwd) {
    return { cwd: fallback.cwd, source: "fallback", mode: "fallback", needsUserInput: false, reason };
  }
  return { cwd: null, source: "none", mode: "fallback-required", needsUserInput: true, reason };
}

export function resumeAvailability({
  kind,
  session,
  binary = null,
  fallback = null,
  override = null,
  strictResume = false,
  effective = null,
}) {
  const name = AGENT_NAMES[kind] || "Agent";
  const unavailable = (reason) => ({
    ok: false,
    mode: "unavailable",
    effectiveCwd: null,
    needsFallback: false,
    reason,
  });
  if (!session?.id) return unavailable("Unknown session");
  if (!kind) return unavailable("Unknown agent");
  if (!binary) return unavailable(`${name} executable not found`);
  if (session.capabilities?.resume === false) {
    return unavailable(session.unavailableReason || "Session cannot be resumed");
  }

  const resolved = effective
    || resolveEffectiveCwd({ session, fallback, override, strictResume });
  if (resolved.mode === "preview-only") {
    return {
      ok: false,
      mode: "preview-only",
      effectiveCwd: null,
      needsFallback: false,
      reason: "Strict mode: preview only",
    };
  }
  if (!resolved.cwd) {
    return {
      ok: false,
      mode: "fallback-required",
      effectiveCwd: null,
      needsFallback: true,
      reason: "Fallback directory required",
    };
  }
  return {
    ok: true,
    mode: resolved.mode,
    effectiveCwd: resolved.cwd,
    needsFallback: false,
    reason: null,
  };
}

export function previewAvailability(session) {
  if (!session?.id) return { ok: false, reason: "Unknown session" };
  if (session.capabilities?.preview === false) return { ok: false, reason: "Preview is unavailable" };
  return { ok: true, reason: null };
}

// 直接 tab 恢复：目录由 tab.new 的 folder 决定，命令本身不再 cd。
// Codex 只有在原目录恢复时才带 -C；fallback/override 依赖 tab 的 folder。
// Hermes 在 fallback/override 时禁用会话记录里的 cwd 恢复。
export function resumeCommand(kind, { bin, cwd, sessionId, mode = "original" } = {}) {
  if (!bin || !sessionId) throw new Error("resumeCommand needs bin and sessionId");
  if (kind === "codex") {
    if (mode === "original" && !cwd) throw new Error("resumeCommand needs cwd for Codex");
    const args = [shellQuote(bin), "--no-daemon"];
    if (mode === "original") args.push("-C", shellQuote(cwd));
    args.push("resume", shellQuote(sessionId));
    return args.join(" ");
  }
  if (kind === "claude") {
    return `${shellQuote(bin)} --resume ${shellQuote(sessionId)}`;
  }
  if (kind === "hermes") {
    const restore = mode === "original" ? [] : ["--no-restore-cwd"];
    return [shellQuote(bin), ...restore, "--resume", shellQuote(sessionId)].join(" ");
  }
  throw new Error(`Unknown agent: ${kind}`);
}

export function resumeArgv(kind, { bin, cwd, sessionId, mode = "original" } = {}) {
  if (!bin || !sessionId) throw new Error("resumeArgv needs bin and sessionId");
  if (kind === "codex") {
    if (mode === "original" && !cwd) throw new Error("resumeArgv needs cwd for Codex");
    const args = [bin, "--no-daemon"];
    if (mode === "original") args.push("-C", cwd);
    args.push("resume", sessionId);
    return args;
  }
  if (kind === "claude") return [bin, "--resume", sessionId];
  if (kind === "hermes") {
    const restore = mode === "original" ? [] : ["--no-restore-cwd"];
    return [bin, ...restore, "--resume", sessionId];
  }
  throw new Error(`Unknown agent: ${kind}`);
}

// placeholder 是已有 shell：必须显式 cd 到 effectiveCwd，尤其 Codex fallback 没有 -C。
export function resumeShellCommand(kind, bin, cwd, sessionId, {
  hcBin = null,
  terminal = null,
  mode = "original",
} = {}) {
  const command = resumeCommand(kind, { bin, cwd, sessionId, mode });
  const full = cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
  if (!hcBin || !terminal) return full;
  const script = `${full}; status=$?; ${shellQuote(hcBin)} label ${shellQuote(terminal)} agent.resume.exit=$status; exit $status`;
  return `sh -c ${shellQuote(script)}`;
}

export function previewShellCommand(helper, {
  agent = "codex",
  sessionId,
  cwd = null,
  path = null,
  title = null,
  hcBin = null,
  terminal = null,
} = {}) {
  if (!helper || !sessionId) throw new Error("previewShellCommand needs helper and sessionId");
  const args = [
    shellQuote(helper),
    "preview",
    "--agent", shellQuote(agent),
    "--session", shellQuote(sessionId),
  ];
  // 预览只读历史，不 cd；cwd 缺失/不存在时仍然可以渲染。
  if (cwd) args.push("--cwd", shellQuote(cwd));
  if (path) args.push("--path", shellQuote(path));
  if (title) args.push("--title", shellQuote(title));
  const command = args.join(" ");
  if (!hcBin || !terminal) return command;
  const reset = `${shellQuote(hcBin)} label ${shellQuote(terminal)} agent.preview.exit=`;
  const script = `${reset}; ${command}; status=$?; ${shellQuote(hcBin)} label ${shellQuote(terminal)} agent.preview.exit=$status; exit $status`;
  return `sh -c ${shellQuote(script)}`;
}
